/**
 * GRPOTrainingLoop — multi-epoch optimization via context-space learning.
 *
 * Each epoch: process a batch of tasks through rollout groups,
 * collect rewards, generate semantic advantages, and update the
 * experience library. The library (context) improves over epochs
 * while the model (parameters) stays frozen.
 *
 * IMPORTANT: Only one training loop per project at a time.
 * Enforced via file lock at <configDir>/grpo/training.lock
 */

import { logger } from '../utils/logger';
import { acquireTrainingLock, releaseTrainingLock } from './training-lock';
import { saveTrainingState, loadTrainingState, clearTrainingState } from './training-state';
import type { ExperienceStore } from './experience-store';
import type {
	GRPOConfig,
	RolloutGroup,
	SemanticAdvantage,
	ExperienceEntry,
	EpochStats,
	TrainingResult,
	TrainingTask,
} from '../../shared/grpo-types';

// Re-export for convenience
export type { EpochStats, TrainingResult, TrainingTask };

const LOG_CONTEXT = '[GRPOTrainingLoop]';

// ─── Dependency Interfaces ───────────────────────────────────────────

export interface GRPODependencies {
	processManager: ProcessManagerLike;
	experienceStore: ExperienceStore;
	rewardCollector: RewardCollectorLike;
	semanticAdvantageGenerator: SemanticAdvantageGeneratorLike;
	rolloutCoordinator: RolloutCoordinatorLike;
	agentDetector: AgentDetectorLike;
	configDir: string;
}

export interface TrainingLoopCallbacks {
	onEpochStart: (epoch: number, taskCount: number) => void;
	onRolloutGroupComplete: (group: RolloutGroup) => void;
	onAdvantageGenerated: (advantage: SemanticAdvantage) => void;
	onAdvantageSkipped: (group: RolloutGroup, reason: string) => void;
	onLibraryUpdated: (newSize: number) => void;
	onEpochComplete: (epoch: number, stats: EpochStats) => void;
	onComplete: (result: TrainingResult) => void;
	onError: (error: Error) => void;
	shouldStop: () => boolean;
}

/** Minimal interface for the process manager dependency */
export interface ProcessManagerLike {
	on: (event: string, listener: (...args: unknown[]) => void) => void;
	off: (event: string, listener: (...args: unknown[]) => void) => void;
	spawn: (config: unknown) => { pid: number } | null;
	kill: (sessionId: string) => void;
}

/** Minimal interface for the reward collector dependency */
export interface RewardCollectorLike {
	detectProjectCommands: (projectPath: string) => Promise<unknown>;
	captureAllBaselines: (projectPath: string, commands: unknown, config: unknown) => Promise<unknown>;
	collectAllRewards: (...args: unknown[]) => Promise<unknown[]>;
	computeAggregateReward: (signals: unknown[], weights: Record<string, number>) => number;
}

/** Minimal interface for the semantic advantage generator dependency */
export interface SemanticAdvantageGeneratorLike {
	generateAdvantage: (
		rolloutGroup: RolloutGroup,
		currentLibrary: ExperienceEntry[],
		config: GRPOConfig,
		processManager: ProcessManagerLike,
		agentDetector: AgentDetectorLike,
		retryCount?: number,
	) => Promise<SemanticAdvantage>;
}

/** Minimal interface for the rollout coordinator dependency */
export interface RolloutCoordinatorLike {
	executeRolloutGroup: (
		taskPrompt: string,
		projectPath: string,
		config: GRPOConfig,
		epoch: number,
		processManager: ProcessManagerLike,
		experienceStore: { getLibrary: (projectPath: string) => Promise<unknown[]> },
		rewardCollector: RewardCollectorLike,
		agentDetector: AgentDetectorLike,
	) => Promise<RolloutGroup>;
}

/** Minimal interface for the agent detector dependency */
export interface AgentDetectorLike {
	getAgent: (agentType: string) => Promise<{ available: boolean; id: string } | null>;
	detectAgents: () => Promise<{ available: boolean; id: string }[]>;
}

// ─── Epoch Statistics ────────────────────────────────────────────────

/**
 * Compute statistics for a completed epoch.
 */
export function computeEpochStats(
	epoch: number,
	groups: RolloutGroup[],
	previousEpochMeanReward: number,
	startTime: number,
): EpochStats {
	const rewards = groups.map(g => g.meanReward);
	const meanReward = rewards.length > 0
		? rewards.reduce((sum, r) => sum + r, 0) / rewards.length
		: 0;

	const rewardImprovement = previousEpochMeanReward > 0
		? (meanReward - previousEpochMeanReward) / previousEpochMeanReward
		: 0;

	// Sum token costs across all rollout outputs
	let tokenCost = 0;
	for (const group of groups) {
		for (const output of group.outputs) {
			if (output.tokenUsage) {
				tokenCost += output.tokenUsage.inputTokens + output.tokenUsage.outputTokens;
			}
		}
	}

	return {
		epoch,
		rolloutGroupsProcessed: groups.length,
		meanReward,
		rewardImprovement,
		experienceOperations: { add: 0, modify: 0, delete: 0 },
		librarySize: 0,
		durationMs: Date.now() - startTime,
		tokenCost,
	};
}

/**
 * Check whether early stopping should trigger.
 *
 * Early stopping conditions (either triggers stop):
 * 1. Reward improvement < 1% for N consecutive epochs (default N=3)
 * 2. All rollout groups in the last epoch had zero variance (nothing to learn)
 */
export function shouldEarlyStop(
	currentStats: EpochStats,
	allPreviousStats: EpochStats[],
	consecutiveNoImproveLimit: number,
): boolean {
	// Condition 2: Zero variance across entire epoch — nothing left to learn
	if (
		currentStats.rolloutGroupsProcessed > 0 &&
		currentStats.experienceOperations.add === 0 &&
		currentStats.experienceOperations.modify === 0 &&
		currentStats.experienceOperations.delete === 0 &&
		Math.abs(currentStats.rewardImprovement) < 0.001
	) {
		logger.info(
			'Early stopping: all rollout groups had zero variance (nothing to learn)',
			LOG_CONTEXT,
		);
		return true;
	}

	// Condition 1: Consecutive low improvement epochs
	const allStats = [...allPreviousStats, currentStats];
	if (allStats.length < consecutiveNoImproveLimit) {
		return false;
	}

	const recentStats = allStats.slice(-consecutiveNoImproveLimit);
	const allLowImprovement = recentStats.every(s => Math.abs(s.rewardImprovement) < 0.01);

	if (allLowImprovement) {
		logger.info(
			`Early stopping: ${consecutiveNoImproveLimit} consecutive epochs with <1% improvement`,
			LOG_CONTEXT,
		);
		return true;
	}

	return false;
}

// ─── Task Shuffling ──────────────────────────────────────────────────

/**
 * Fisher-Yates shuffle — returns a new array with elements in random order.
 * Paper: "different ordering per epoch for robustness"
 */
export function shuffleTasks<T>(tasks: T[]): T[] {
	const shuffled = [...tasks];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

// ─── Main Training Loop ─────────────────────────────────────────────

/**
 * Run the complete GRPO training loop: multi-epoch optimization.
 *
 * For each epoch, process each task through:
 *   rollout → reward → semantic advantage → experience update
 *
 * The loop is resumable: if interrupted, it picks up from the last checkpoint.
 * Only one training loop per project at a time (file-based lock).
 */
export async function runTrainingLoop(
	tasks: TrainingTask[],
	projectPath: string,
	config: GRPOConfig,
	dependencies: GRPODependencies,
	callbacks: TrainingLoopCallbacks,
): Promise<TrainingResult> {
	const loopStartTime = Date.now();
	const maxEpochs = config.earlyStoppingEpochs * 3; // generous upper bound
	const allEpochStats: EpochStats[] = [];
	let totalRollouts = 0;
	let totalTokenCost = 0;

	// 1. Acquire training lock
	await acquireTrainingLock(projectPath, dependencies.configDir);

	try {
		// 2. Load or create training state
		let state = await loadTrainingState(projectPath, dependencies.configDir);
		let startEpoch = 0;
		let startTaskIndex = 0;

		if (state) {
			startEpoch = state.currentEpoch;
			startTaskIndex = state.completedTasks;
			allEpochStats.push(...state.epochStats);
			logger.info(
				`Resuming training from epoch ${startEpoch}, task ${startTaskIndex}`,
				LOG_CONTEXT,
			);
		} else {
			state = {
				projectPath,
				config,
				currentEpoch: 0,
				completedTasks: 0,
				epochStats: [],
				startedAt: loopStartTime,
				lastCheckpointAt: loopStartTime,
			};
		}

		// 3. Run epochs
		for (let epoch = startEpoch; epoch < maxEpochs; epoch++) {
			if (callbacks.shouldStop()) break;

			const epochStartTime = Date.now();
			callbacks.onEpochStart(epoch, tasks.length);

			// Shuffle tasks each epoch for robustness
			const shuffledTasks = shuffleTasks(tasks);
			const epochGroups: RolloutGroup[] = [];
			const epochOps = { add: 0, modify: 0, delete: 0 };

			// Determine where to start within this epoch (for resume)
			const taskStartIndex = epoch === startEpoch ? startTaskIndex : 0;

			for (let taskIdx = taskStartIndex; taskIdx < shuffledTasks.length; taskIdx++) {
				if (callbacks.shouldStop()) break;

				const task = shuffledTasks[taskIdx];

				// 3a. Execute rollout group
				let group: RolloutGroup;
				try {
					group = await dependencies.rolloutCoordinator.executeRolloutGroup(
						task.prompt,
						projectPath,
						config,
						epoch,
						dependencies.processManager,
						dependencies.experienceStore,
						dependencies.rewardCollector,
						dependencies.agentDetector,
					);
				} catch (err) {
					logger.warn(
						`Rollout group failed for task "${task.prompt.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
						LOG_CONTEXT,
					);
					callbacks.onError(err instanceof Error ? err : new Error(String(err)));
					continue;
				}

				callbacks.onRolloutGroupComplete(group);
				epochGroups.push(group);
				totalRollouts += group.outputs.length;

				// Track token cost
				for (const output of group.outputs) {
					if (output.tokenUsage) {
						totalTokenCost += output.tokenUsage.inputTokens + output.tokenUsage.outputTokens;
					}
				}

				// 3b. Skip if no variance
				if (group.rewardStdDev < config.varianceThreshold) {
					callbacks.onAdvantageSkipped(group, 'low variance');

					// Save checkpoint
					state.currentEpoch = epoch;
					state.completedTasks = taskIdx + 1;
					state.epochStats = allEpochStats;
					await saveTrainingState(state, dependencies.configDir);
					continue;
				}

				// 3c. Generate semantic advantage
				let advantage: SemanticAdvantage;
				try {
					const currentLibrary = await dependencies.experienceStore.getLibrary(projectPath);
					advantage = await dependencies.semanticAdvantageGenerator.generateAdvantage(
						group,
						currentLibrary,
						config,
						dependencies.processManager,
						dependencies.agentDetector,
					);
					callbacks.onAdvantageGenerated(advantage);
				} catch (err) {
					logger.warn(
						`[GRPO] Introspection failed for group ${group.id}: ${err instanceof Error ? err.message : String(err)}`,
						LOG_CONTEXT,
					);
					callbacks.onAdvantageSkipped(group, `introspection error: ${err instanceof Error ? err.message : String(err)}`);

					// Save checkpoint
					state.currentEpoch = epoch;
					state.completedTasks = taskIdx + 1;
					state.epochStats = allEpochStats;
					await saveTrainingState(state, dependencies.configDir);
					continue;
				}

				// 3d. Apply experience updates
				if (advantage.operations.length > 0) {
					await dependencies.experienceStore.applyOperations(
						projectPath,
						advantage.operations,
						group.id,
						epoch,
					);

					// Track operation counts
					for (const op of advantage.operations) {
						if (op.operation === 'add') epochOps.add++;
						else if (op.operation === 'modify') epochOps.modify++;
						else if (op.operation === 'delete') epochOps.delete++;
					}
				}

				// Report updated library size
				const updatedLibrary = await dependencies.experienceStore.getLibrary(projectPath);
				callbacks.onLibraryUpdated(updatedLibrary.length);

				// 3e. Save checkpoint after each rollout group
				state.currentEpoch = epoch;
				state.completedTasks = taskIdx + 1;
				state.epochStats = allEpochStats;
				await saveTrainingState(state, dependencies.configDir);
			}

			// 4. Prune stale experiences after each epoch
			await dependencies.experienceStore.pruneStaleExperiences(
				projectPath,
				epoch,
				config.pruneAfterEpochs,
			);

			// 5. Compute epoch stats
			const previousMeanReward = allEpochStats.length > 0
				? allEpochStats[allEpochStats.length - 1].meanReward
				: 0;

			const stats = computeEpochStats(epoch, epochGroups, previousMeanReward, epochStartTime);

			// Enrich stats with operation counts and library size
			stats.experienceOperations = epochOps;
			const finalLibrary = await dependencies.experienceStore.getLibrary(projectPath);
			stats.librarySize = finalLibrary.length;

			allEpochStats.push(stats);
			callbacks.onEpochComplete(epoch, stats);

			// Reset task index for next epoch
			state.completedTasks = 0;
			state.currentEpoch = epoch + 1;
			state.epochStats = allEpochStats;
			await saveTrainingState(state, dependencies.configDir);

			// 6. Early stopping check
			if (config.earlyStoppingEnabled) {
				const previousStats = allEpochStats.slice(0, -1);
				if (shouldEarlyStop(stats, previousStats, config.earlyStoppingEpochs)) {
					logger.info(`Early stopping triggered at epoch ${epoch}`, LOG_CONTEXT);
					break;
				}
			}
		}

		// Build final result
		const finalLibrary = await dependencies.experienceStore.getLibrary(projectPath);
		const firstMeanReward = allEpochStats.length > 0 ? allEpochStats[0].meanReward : 0;
		const lastMeanReward = allEpochStats.length > 0
			? allEpochStats[allEpochStats.length - 1].meanReward
			: 0;

		const result: TrainingResult = {
			epochs: allEpochStats,
			finalLibrarySize: finalLibrary.length,
			totalRollouts,
			totalTokenCost,
			rewardImprovement: firstMeanReward > 0
				? (lastMeanReward - firstMeanReward) / firstMeanReward
				: 0,
			durationMs: Date.now() - loopStartTime,
		};

		callbacks.onComplete(result);

		// Clear training state on successful completion
		await clearTrainingState(projectPath, dependencies.configDir);

		return result;
	} finally {
		// 4. Always release lock, even on error
		await releaseTrainingLock(projectPath, dependencies.configDir);
	}
}
