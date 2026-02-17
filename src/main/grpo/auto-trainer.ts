/**
 * AutoTrainer — watches for training readiness and triggers background
 * GRPO training runs automatically after batch completion.
 *
 * Rules:
 * - Training only triggers when GRPO is enabled
 * - Configurable cooldown per project (default: 2 minutes)
 * - Only one training run per project at a time
 * - getTrainingReadiness() must return ready: true
 *   (minReadyTasks unique tasks with rolloutGroupSize executions, sufficient reward variance)
 * - Training is fully non-blocking (runs in async IIFE)
 * - All errors caught — never crashes the app
 * - All gate failures logged at debug level for diagnostics
 */

import { getSymphonyCollector } from './symphony-collector';
import { getExperienceStore } from './experience-store';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';
import type { GRPOConfig } from '../../shared/grpo-types';

const LOG_CONTEXT = '[AutoTrainer]';
const lastTrainingAttempt = new Map<string, number>();
const trainingInProgress = new Set<string>();

export async function maybeAutoTrain(
	projectPath: string,
	config: GRPOConfig,
	safeSend?: (channel: string, ...args: unknown[]) => void,
): Promise<void> {
	if (!config.enabled) {
		logger.debug('Skipped: GRPO not enabled', LOG_CONTEXT);
		return;
	}

	// Cooldown check (configurable, default 2 minutes)
	const cooldownMs = config.autoTrainCooldownMs ?? 2 * 60 * 1000;
	const lastAttempt = lastTrainingAttempt.get(projectPath) ?? 0;
	if (Date.now() - lastAttempt < cooldownMs) {
		const remainingMs = cooldownMs - (Date.now() - lastAttempt);
		logger.debug(`Skipped: cooldown active (${Math.ceil(remainingMs / 1000)}s remaining)`, LOG_CONTEXT);
		return;
	}

	// Already training this project?
	if (trainingInProgress.has(projectPath)) {
		logger.debug('Skipped: training already in progress for this project', LOG_CONTEXT);
		return;
	}

	// Check readiness via SymphonyCollector
	const collector = getSymphonyCollector(config);
	const readiness = await collector.getTrainingReadiness(projectPath);
	if (!readiness.ready) {
		logger.debug(
			`Not ready: ${readiness.matchedTaskCount} qualifying tasks ` +
			`(need ${config.minReadyTasks ?? 1}), min group size: ${readiness.minGroupSize}`,
			LOG_CONTEXT,
		);

		// First-experience mode: bootstrap observations from low-variance data
		// when the experience library is empty
		if (config.firstExperienceMode) {
			const experienceStore = getExperienceStore();
			const library = await experienceStore.getLibrary(projectPath);

			// Only bootstrap when the library is empty — once we have entries, wait for proper variance
			if (library.length === 0 && readiness.suggestedTasks.length > 0) {
				logger.info(`First-experience mode: bootstrapping from ${readiness.suggestedTasks.length} tasks`, LOG_CONTEXT);

				lastTrainingAttempt.set(projectPath, Date.now());
				trainingInProgress.add(projectPath);

				safeSend?.('grpo:trainingStatus', { projectPath, status: 'running', groupCount: 0 });

				void (async () => {
					try {
						let addedCount = 0;

						// Create observation entries from the best-performing tasks
						for (const task of readiness.suggestedTasks.slice(0, 3)) {
							const signals = await collector.getSignalsForTask(projectPath, task.prompt);
							if (signals.length === 0) continue;

							// Find the best-scoring execution
							const best = signals.reduce((a, b) => a.aggregateReward > b.aggregateReward ? a : b);

							// Only create observations from reasonably successful tasks (reward > 0.7)
							if (best.aggregateReward < 0.7) continue;

							const signalSummary = best.rewards
								.map(r => `${r.type}: ${r.score.toFixed(1)}`)
								.join(', ');

							await experienceStore.addExperience(projectPath, {
								content: `Observation from "${task.prompt.slice(0, 80)}": ` +
									`execution scored ${best.aggregateReward.toFixed(2)} ` +
									`(${signalSummary}). ` +
									`Agent type: ${best.agentType}. ` +
									`This is a baseline observation — will be refined as more data arrives.`,
								category: 'patterns',
								scope: 'project',
								agentType: best.agentType,
								evidenceCount: signals.length,
								lastRolloutGroupId: null,
							});
							addedCount++;
						}

						logger.info(`First-experience bootstrap complete: ${addedCount} observations added`, LOG_CONTEXT);
						safeSend?.('grpo:trainingStatus', {
							projectPath,
							status: 'complete',
							experiencesAdded: addedCount,
						});
					} catch (err) {
						logger.warn(`First-experience bootstrap failed: ${err}`, LOG_CONTEXT);
						captureException(err, { operation: 'autoTrain:firstExperience', projectPath });
						safeSend?.('grpo:trainingStatus', { projectPath, status: 'error', error: String(err) });
					} finally {
						trainingInProgress.delete(projectPath);
					}
				})();

				return; // Exit early — we've handled this case
			}
		}

		return;
	}

	// Form natural rollout groups from accumulated signals
	const groups = await collector.formNaturalRolloutGroups(projectPath);
	if (groups.length === 0) {
		logger.debug('No rollout groups formed (insufficient variance in recent signals)', LOG_CONTEXT);
		return;
	}

	lastTrainingAttempt.set(projectPath, Date.now());
	trainingInProgress.add(projectPath);

	// Notify renderer
	safeSend?.('grpo:trainingStatus', { projectPath, status: 'running', groupCount: groups.length });

	// Run in background (non-blocking)
	void (async () => {
		try {
			const experienceStore = getExperienceStore();
			let addedCount = 0;

			for (const group of groups) {
				// Skip groups with insufficient variance
				if (group.rewardStdDev < config.varianceThreshold) {
					logger.debug(
						`Skipped group: stdDev ${group.rewardStdDev.toFixed(3)} < threshold ${config.varianceThreshold}`,
						LOG_CONTEXT,
					);
					continue;
				}

				// Find best and worst outputs in the group
				const best = group.outputs.reduce((a, b) => a.aggregateReward > b.aggregateReward ? a : b);
				const worst = group.outputs.reduce((a, b) => a.aggregateReward < b.aggregateReward ? a : b);

				if (best.aggregateReward - worst.aggregateReward > config.varianceThreshold) {
					const rewardSummary = best.rewards.map(r => `${r.type}:${r.score.toFixed(1)}`).join(', ');
					await experienceStore.addExperience(projectPath, {
						content: `For task "${group.taskPrompt.slice(0, 100)}": ` +
							`approaches scoring ${best.aggregateReward.toFixed(2)} outperformed those scoring ` +
							`${worst.aggregateReward.toFixed(2)}. Key signals: ${rewardSummary}`,
						category: 'performance',
						scope: 'project',
						agentType: 'all',
						evidenceCount: group.outputs.length,
						lastRolloutGroupId: group.id,
					});
					addedCount++;
				} else {
					logger.debug(
						`Skipped group: reward gap ${(best.aggregateReward - worst.aggregateReward).toFixed(3)} ≤ threshold ${config.varianceThreshold}`,
						LOG_CONTEXT,
					);
				}
			}

			logger.info(`Auto-training complete for ${projectPath}: ${addedCount} experiences added from ${groups.length} groups`, LOG_CONTEXT);
			safeSend?.('grpo:trainingStatus', { projectPath, status: 'complete', experiencesAdded: addedCount });
		} catch (err) {
			logger.warn(`Auto-training failed for ${projectPath}: ${err}`, LOG_CONTEXT);
			captureException(err, { operation: 'autoTrain', projectPath });
			safeSend?.('grpo:trainingStatus', { projectPath, status: 'error', error: String(err) });
		} finally {
			trainingInProgress.delete(projectPath);
		}
	})();
}

export function isTrainingInProgress(): boolean {
	return trainingInProgress.size > 0;
}

export function getTrainingProjects(): string[] {
	return [...trainingInProgress];
}

/**
 * Reset internal state (for testing).
 */
export function resetAutoTrainer(): void {
	lastTrainingAttempt.clear();
	trainingInProgress.clear();
}
