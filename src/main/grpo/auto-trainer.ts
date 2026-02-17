/**
 * AutoTrainer — watches for training readiness and triggers background
 * GRPO training runs automatically after batch completion.
 *
 * Rules:
 * - Training only triggers when GRPO is enabled
 * - 5-minute cooldown per project after last training attempt
 * - Only one training run per project at a time
 * - getTrainingReadiness() must return ready: true
 *   (3+ unique tasks with 2+ executions, sufficient reward variance)
 * - Training is fully non-blocking (runs in async IIFE)
 * - All errors caught — never crashes the app
 */

import { getSymphonyCollector } from './symphony-collector';
import { getExperienceStore } from './experience-store';
import { captureException } from '../utils/sentry';
import { logger } from '../utils/logger';
import type { GRPOConfig } from '../../shared/grpo-types';

const LOG_CONTEXT = '[AutoTrainer]';
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const lastTrainingAttempt = new Map<string, number>();
const trainingInProgress = new Set<string>();

export async function maybeAutoTrain(
	projectPath: string,
	config: GRPOConfig,
	safeSend?: (channel: string, ...args: unknown[]) => void,
): Promise<void> {
	if (!config.enabled) return;

	// Cooldown check
	const lastAttempt = lastTrainingAttempt.get(projectPath) ?? 0;
	if (Date.now() - lastAttempt < COOLDOWN_MS) return;

	// Already training this project?
	if (trainingInProgress.has(projectPath)) return;

	// Check readiness via SymphonyCollector
	const collector = getSymphonyCollector(config);
	const readiness = await collector.getTrainingReadiness(projectPath);
	if (!readiness.ready) return;

	// Form natural rollout groups from accumulated signals
	const groups = await collector.formNaturalRolloutGroups(projectPath);
	if (groups.length === 0) return;

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
				if (group.rewardStdDev < config.varianceThreshold) continue;

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
