/**
 * Tests for the GRPO Training Loop — end-to-end optimization cycle.
 *
 * Uses a real temp directory for filesystem operations (training state, locks).
 * All async dependencies are mocked for deterministic behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock electron
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	runTrainingLoop,
	computeEpochStats,
	shouldEarlyStop,
	shuffleTasks,
	type GRPODependencies,
	type TrainingLoopCallbacks,
	type ProcessManagerLike,
	type RewardCollectorLike,
	type SemanticAdvantageGeneratorLike,
	type RolloutCoordinatorLike,
	type AgentDetectorLike,
} from '../../../main/grpo/training-loop';
import { acquireTrainingLock, releaseTrainingLock, isTrainingLockHeld } from '../../../main/grpo/training-lock';
import { saveTrainingState, loadTrainingState, clearTrainingState } from '../../../main/grpo/training-state';
import type {
	GRPOConfig,
	RolloutGroup,
	SemanticAdvantage,
	ExperienceEntry,
	EpochStats,
	TrainingTask,
	TrainingResult,
	ExperienceUpdateOperation,
} from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

// ─── Test Helpers ────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-training-test-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<GRPOConfig> = {}): GRPOConfig {
	return {
		...GRPO_CONFIG_DEFAULTS,
		enabled: true,
		...overrides,
	};
}

function makeRolloutGroup(overrides: Partial<RolloutGroup> = {}): RolloutGroup {
	return {
		id: overrides.id ?? `group-${Math.random().toString(36).slice(2, 8)}`,
		taskPrompt: overrides.taskPrompt ?? 'Write a test',
		projectPath: overrides.projectPath ?? '/test/project',
		outputs: overrides.outputs ?? [
			{
				index: 0,
				agentType: 'claude-code',
				sessionId: 'session-0',
				prompt: 'Write a test',
				output: 'Good output',
				rewards: [],
				aggregateReward: 0.8,
				durationMs: 1000,
				tokenUsage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0 },
			},
			{
				index: 1,
				agentType: 'claude-code',
				sessionId: 'session-1',
				prompt: 'Write a test',
				output: 'Bad output',
				rewards: [],
				aggregateReward: 0.3,
				durationMs: 1000,
				tokenUsage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0 },
			},
		],
		groupSize: overrides.groupSize ?? 2,
		meanReward: overrides.meanReward ?? 0.55,
		rewardStdDev: overrides.rewardStdDev ?? 0.25,
		experienceVersion: overrides.experienceVersion ?? 0,
		epoch: overrides.epoch ?? 0,
		createdAt: overrides.createdAt ?? Date.now(),
	};
}

function makeAdvantage(groupId: string, ops: ExperienceUpdateOperation[] = []): SemanticAdvantage {
	return {
		rolloutGroupId: groupId,
		analysis: 'Good output used proper testing patterns',
		operations: ops.length > 0 ? ops : [{
			operation: 'add',
			content: 'Use proper testing patterns',
			category: 'testing',
			reasoning: 'The higher-reward output followed testing patterns',
		}],
		introspectionModel: 'claude-sonnet-4-5-20250929',
		generatedAt: Date.now(),
	};
}

function makeCallbacks(overrides: Partial<TrainingLoopCallbacks> = {}): TrainingLoopCallbacks {
	return {
		onEpochStart: overrides.onEpochStart ?? vi.fn(),
		onRolloutGroupComplete: overrides.onRolloutGroupComplete ?? vi.fn(),
		onAdvantageGenerated: overrides.onAdvantageGenerated ?? vi.fn(),
		onAdvantageSkipped: overrides.onAdvantageSkipped ?? vi.fn(),
		onLibraryUpdated: overrides.onLibraryUpdated ?? vi.fn(),
		onEpochComplete: overrides.onEpochComplete ?? vi.fn(),
		onComplete: overrides.onComplete ?? vi.fn(),
		onError: overrides.onError ?? vi.fn(),
		shouldStop: overrides.shouldStop ?? vi.fn().mockReturnValue(false),
	};
}

function makeMockExperienceStore() {
	const library: ExperienceEntry[] = [];

	return {
		getLibrary: vi.fn().mockImplementation(async () => library),
		applyOperations: vi.fn().mockImplementation(async (_path: string, ops: ExperienceUpdateOperation[]) => {
			for (const op of ops) {
				if (op.operation === 'add') {
					library.push({
						id: `exp-${Math.random().toString(36).slice(2, 8)}`,
						content: op.content ?? '',
						category: op.category ?? 'patterns',
						scope: 'project',
						agentType: 'claude-code',
						createdAt: Date.now(),
						updatedAt: Date.now(),
						evidenceCount: 1,
						useCount: 0,
						lastRolloutGroupId: null,
						tokenEstimate: 50,
					});
				}
			}
		}),
		pruneStaleExperiences: vi.fn().mockResolvedValue([]),
	};
}

function makeMockDependencies(overrides: Partial<GRPODependencies> = {}): GRPODependencies {
	const experienceStore = overrides.experienceStore ?? makeMockExperienceStore() as unknown as GRPODependencies['experienceStore'];

	const rolloutCoordinator: RolloutCoordinatorLike = overrides.rolloutCoordinator ?? {
		executeRolloutGroup: vi.fn().mockImplementation(async (_prompt: string) => {
			return makeRolloutGroup();
		}),
	};

	const semanticAdvantageGenerator: SemanticAdvantageGeneratorLike = overrides.semanticAdvantageGenerator ?? {
		generateAdvantage: vi.fn().mockImplementation(async (group: RolloutGroup) => {
			return makeAdvantage(group.id);
		}),
	};

	const processManager: ProcessManagerLike = overrides.processManager ?? {
		on: vi.fn(),
		off: vi.fn(),
		spawn: vi.fn().mockReturnValue({ pid: 12345 }),
		kill: vi.fn(),
	};

	const rewardCollector: RewardCollectorLike = overrides.rewardCollector ?? {
		detectProjectCommands: vi.fn().mockResolvedValue({ testCommand: 'npm test', buildCommand: null, lintCommand: null, projectType: 'node' }),
		captureLintBaseline: vi.fn().mockResolvedValue(null),
		collectAllRewards: vi.fn().mockResolvedValue([]),
		computeAggregateReward: vi.fn().mockReturnValue(0.5),
	};

	const agentDetector: AgentDetectorLike = overrides.agentDetector ?? {
		getAgent: vi.fn().mockResolvedValue({ available: true, id: 'claude-code' }),
		detectAgents: vi.fn().mockResolvedValue([{ available: true, id: 'claude-code' }]),
	};

	return {
		processManager,
		experienceStore,
		rewardCollector,
		semanticAdvantageGenerator,
		rolloutCoordinator,
		agentDetector,
		configDir: overrides.configDir ?? tmpDir,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('GRPOTrainingLoop', () => {
	// ─── Test 1: Full training loop ──────────────────────────────────

	describe('full training loop', () => {
		it('processes 2 epochs × 3 tasks → 6 rollout groups', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false, earlyStoppingEpochs: 3 });
			const tasks: TrainingTask[] = [
				{ prompt: 'Task A' },
				{ prompt: 'Task B' },
				{ prompt: 'Task C' },
			];

			let rolloutGroupCount = 0;
			const deps = makeMockDependencies();
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				rolloutGroupCount++;
				return makeRolloutGroup({ rewardStdDev: 0.25, meanReward: 0.5 + rolloutGroupCount * 0.05 });
			});

			const callbacks = makeCallbacks();
			// Allow exactly 2 epochs by stopping on the 3rd
			let epochCount = 0;
			(callbacks.onEpochComplete as ReturnType<typeof vi.fn>).mockImplementation(() => {
				epochCount++;
			});
			(callbacks.shouldStop as ReturnType<typeof vi.fn>).mockImplementation(() => epochCount >= 2);

			const result = await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// Should have processed 6 rollout groups (2 epochs × 3 tasks)
			expect(rolloutGroupCount).toBe(6);
			expect(result.epochs).toHaveLength(2);
			expect(result.totalRollouts).toBe(12); // 6 groups × 2 outputs each
			expect(callbacks.onEpochStart).toHaveBeenCalledTimes(2);
			expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
		});
	});

	// ─── Test 2: Variance threshold ─────────────────────────────────

	describe('variance threshold', () => {
		it('skips advantage generation for low-variance groups', async () => {
			const config = makeConfig({
				varianceThreshold: 0.1,
				earlyStoppingEnabled: false,
			});
			const tasks: TrainingTask[] = [{ prompt: 'Low variance task' }];

			const deps = makeMockDependencies();
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeRolloutGroup({ rewardStdDev: 0.05 }), // Below threshold
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)  // epoch 0 start
				.mockReturnValueOnce(false)  // task 0 of epoch 0
				.mockReturnValue(true);      // stop after

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			expect(callbacks.onAdvantageSkipped).toHaveBeenCalledWith(
				expect.objectContaining({ rewardStdDev: 0.05 }),
				'low variance',
			);
			expect(deps.semanticAdvantageGenerator.generateAdvantage).not.toHaveBeenCalled();
		});
	});

	// ─── Test 3: Early stopping ─────────────────────────────────────

	describe('early stopping', () => {
		it('stops after 3 consecutive no-improvement epochs (not 2)', async () => {
			const config = makeConfig({
				earlyStoppingEnabled: true,
				earlyStoppingEpochs: 3,
			});
			const tasks: TrainingTask[] = [{ prompt: 'Task' }];

			const deps = makeMockDependencies();

			// All groups produce operations but same reward → low improvement
			// Need high variance so advantage is generated (not skipped via variance threshold)
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				return makeRolloutGroup({
					meanReward: 0.5,
					rewardStdDev: 0.25, // Above threshold so advantage generation runs
				});
			});

			// Generate advantages with operations, so we don't trigger zero-variance early stop
			(deps.semanticAdvantageGenerator.generateAdvantage as ReturnType<typeof vi.fn>).mockImplementation(
				async (group: RolloutGroup) => makeAdvantage(group.id, [{
					operation: 'add', content: 'Insight', category: 'testing', reasoning: 'Because',
				}]),
			);

			const callbacks = makeCallbacks();
			const epochsCompleted: number[] = [];
			(callbacks.onEpochComplete as ReturnType<typeof vi.fn>).mockImplementation((epoch: number) => {
				epochsCompleted.push(epoch);
			});

			const result = await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// Should run exactly 3 epochs (improvement is ~0% each time since meanReward is constant)
			// Epoch 0: no previous → improvement=0 (< 1%)
			// Epoch 1: same reward → improvement=0 (< 1%)
			// Epoch 2: same reward → improvement=0 (< 1%) → 3 consecutive → early stop
			expect(result.epochs.length).toBe(3);
			expect(epochsCompleted).toEqual([0, 1, 2]);
		});

		it('does NOT early stop after only 2 low-improvement epochs', () => {
			const stats1: EpochStats = {
				epoch: 0, rolloutGroupsProcessed: 1, meanReward: 0.5,
				rewardImprovement: 0.005, experienceOperations: { add: 1, modify: 0, delete: 0 },
				librarySize: 1, durationMs: 1000, tokenCost: 0,
			};
			const stats2: EpochStats = {
				epoch: 1, rolloutGroupsProcessed: 1, meanReward: 0.505,
				rewardImprovement: 0.005, experienceOperations: { add: 1, modify: 0, delete: 0 },
				librarySize: 2, durationMs: 1000, tokenCost: 0,
			};

			// Only 2 low-improvement epochs — should NOT stop
			expect(shouldEarlyStop(stats2, [stats1], 3)).toBe(false);
		});
	});

	// ─── Test 4: Cancellation ───────────────────────────────────────

	describe('cancellation', () => {
		it('shouldStop() returning true halts execution', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [
				{ prompt: 'Task A' },
				{ prompt: 'Task B' },
				{ prompt: 'Task C' },
			];

			const deps = makeMockDependencies();
			let groupsProcessed = 0;
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				groupsProcessed++;
				return makeRolloutGroup();
			});

			const callbacks = makeCallbacks();
			// Stop after processing 1 task
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)  // epoch start
				.mockReturnValueOnce(false)  // task 0
				.mockReturnValue(true);      // stop before task 1

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			expect(groupsProcessed).toBe(1);
		});
	});

	// ─── Test 5: Callbacks fire in correct order ────────────────────

	describe('callback ordering', () => {
		it('fires all callbacks in correct order', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task A' }];

			const deps = makeMockDependencies();
			const callOrder: string[] = [];

			const callbacks = makeCallbacks({
				onEpochStart: vi.fn().mockImplementation(() => callOrder.push('epochStart')),
				onRolloutGroupComplete: vi.fn().mockImplementation(() => callOrder.push('rolloutComplete')),
				onAdvantageGenerated: vi.fn().mockImplementation(() => callOrder.push('advantageGenerated')),
				onAdvantageSkipped: vi.fn().mockImplementation(() => callOrder.push('advantageSkipped')),
				onLibraryUpdated: vi.fn().mockImplementation(() => callOrder.push('libraryUpdated')),
				onEpochComplete: vi.fn().mockImplementation(() => callOrder.push('epochComplete')),
				onComplete: vi.fn().mockImplementation(() => callOrder.push('complete')),
				shouldStop: vi.fn()
					.mockReturnValueOnce(false)  // epoch start
					.mockReturnValueOnce(false)  // task
					.mockReturnValue(true),       // stop
			});

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			expect(callOrder).toEqual([
				'epochStart',
				'rolloutComplete',
				'advantageGenerated',
				'libraryUpdated',
				'epochComplete',
				'complete',
			]);
		});

		it('fires onAdvantageSkipped for low-variance groups', async () => {
			const config = makeConfig({ varianceThreshold: 0.1, earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task' }];

			const deps = makeMockDependencies();
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeRolloutGroup({ rewardStdDev: 0.05 }),
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(false)
				.mockReturnValue(true);

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			expect(callbacks.onAdvantageSkipped).toHaveBeenCalledWith(
				expect.objectContaining({ rewardStdDev: 0.05 }),
				'low variance',
			);
		});
	});

	// ─── Test 6: Epoch stats ────────────────────────────────────────

	describe('epoch statistics', () => {
		it('calculates mean reward and improvement correctly', () => {
			const groups: RolloutGroup[] = [
				makeRolloutGroup({ meanReward: 0.6 }),
				makeRolloutGroup({ meanReward: 0.8 }),
				makeRolloutGroup({ meanReward: 0.4 }),
			];

			const stats = computeEpochStats(1, groups, 0.5, Date.now() - 1000);

			// Mean: (0.6 + 0.8 + 0.4) / 3 = 0.6
			expect(stats.meanReward).toBeCloseTo(0.6, 5);
			// Improvement: (0.6 - 0.5) / 0.5 = 0.2 (20%)
			expect(stats.rewardImprovement).toBeCloseTo(0.2, 5);
			expect(stats.rolloutGroupsProcessed).toBe(3);
			expect(stats.epoch).toBe(1);
		});

		it('handles zero previous reward (no division by zero)', () => {
			const groups = [makeRolloutGroup({ meanReward: 0.5 })];
			const stats = computeEpochStats(0, groups, 0, Date.now());

			expect(stats.rewardImprovement).toBe(0);
			expect(stats.meanReward).toBeCloseTo(0.5, 5);
		});

		it('handles empty group list', () => {
			const stats = computeEpochStats(0, [], 0, Date.now());

			expect(stats.meanReward).toBe(0);
			expect(stats.rolloutGroupsProcessed).toBe(0);
		});
	});

	// ─── Test 7: State persistence / resumability ───────────────────

	describe('state persistence', () => {
		it('saves and loads training state', async () => {
			const state = {
				projectPath: '/test/project',
				config: makeConfig(),
				currentEpoch: 2,
				completedTasks: 1,
				epochStats: [],
				startedAt: Date.now() - 5000,
				lastCheckpointAt: Date.now(),
			};

			await saveTrainingState(state, tmpDir);
			const loaded = await loadTrainingState('/test/project', tmpDir);

			expect(loaded).not.toBeNull();
			expect(loaded!.currentEpoch).toBe(2);
			expect(loaded!.completedTasks).toBe(1);
			expect(loaded!.projectPath).toBe('/test/project');
		});

		it('returns null for missing state', async () => {
			const loaded = await loadTrainingState('/nonexistent/project', tmpDir);
			expect(loaded).toBeNull();
		});

		it('clears training state', async () => {
			const state = {
				projectPath: '/test/project',
				config: makeConfig(),
				currentEpoch: 0,
				completedTasks: 0,
				epochStats: [],
				startedAt: Date.now(),
				lastCheckpointAt: Date.now(),
			};

			await saveTrainingState(state, tmpDir);
			await clearTrainingState('/test/project', tmpDir);
			const loaded = await loadTrainingState('/test/project', tmpDir);

			expect(loaded).toBeNull();
		});

		it('resumed loop skips already-completed tasks', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [
				{ prompt: 'Task A' },
				{ prompt: 'Task B' },
				{ prompt: 'Task C' },
			];

			// Save state indicating task 0 and 1 are done in epoch 0
			const state = {
				projectPath: '/test/resume-project',
				config,
				currentEpoch: 0,
				completedTasks: 2,  // Skip first 2 tasks
				epochStats: [],
				startedAt: Date.now(),
				lastCheckpointAt: Date.now(),
			};
			await saveTrainingState(state, tmpDir);

			const deps = makeMockDependencies({ configDir: tmpDir });
			let rolloutCalls = 0;
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				rolloutCalls++;
				return makeRolloutGroup();
			});

			const callbacks = makeCallbacks();
			// Stop after first epoch
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)  // epoch start
				.mockReturnValueOnce(false)  // task (only task C since A and B skipped)
				.mockReturnValue(true);

			await runTrainingLoop(tasks, '/test/resume-project', config, deps, callbacks);

			// Only 1 task should be processed (task C — the only remaining one in epoch 0)
			expect(rolloutCalls).toBe(1);
		});
	});

	// ─── Test 8: Task shuffling ─────────────────────────────────────

	describe('task shuffling', () => {
		it('returns a new array with different order', () => {
			const original = Array.from({ length: 100 }, (_, i) => ({ prompt: `Task ${i}` }));
			const shuffled = shuffleTasks(original);

			// Should be same length
			expect(shuffled).toHaveLength(original.length);
			// Should contain same elements
			expect(new Set(shuffled.map(t => t.prompt))).toEqual(new Set(original.map(t => t.prompt)));
			// Should not be the same reference
			expect(shuffled).not.toBe(original);
			// With 100 elements, probability of identical order is ~1/100!
			const isSameOrder = shuffled.every((t, i) => t.prompt === original[i].prompt);
			expect(isSameOrder).toBe(false);
		});

		it('does not modify the original array', () => {
			const original = [{ prompt: 'A' }, { prompt: 'B' }, { prompt: 'C' }];
			const originalCopy = [...original];
			shuffleTasks(original);

			expect(original).toEqual(originalCopy);
		});
	});

	// ─── Test 9: Library pruning ────────────────────────────────────

	describe('library pruning', () => {
		it('calls pruneStaleExperiences after each epoch', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false, pruneAfterEpochs: 5 });
			const tasks: TrainingTask[] = [{ prompt: 'Task' }];

			const deps = makeMockDependencies();
			const callbacks = makeCallbacks();

			let epochCount = 0;
			(callbacks.onEpochComplete as ReturnType<typeof vi.fn>).mockImplementation(() => {
				epochCount++;
			});
			(callbacks.shouldStop as ReturnType<typeof vi.fn>).mockImplementation(() => epochCount >= 2);

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// pruneStaleExperiences should be called once per epoch
			expect(deps.experienceStore.pruneStaleExperiences).toHaveBeenCalledTimes(2);
			expect(deps.experienceStore.pruneStaleExperiences).toHaveBeenCalledWith(
				'/test/project',
				0, // epoch 0
				5, // pruneAfterEpochs
			);
			expect(deps.experienceStore.pruneStaleExperiences).toHaveBeenCalledWith(
				'/test/project',
				1, // epoch 1
				5,
			);
		});
	});

	// ─── Test 10: Token cost tracking ───────────────────────────────

	describe('token cost tracking', () => {
		it('accumulates token cost across all rollouts', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task A' }, { prompt: 'Task B' }];

			const deps = makeMockDependencies();
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeRolloutGroup({
					outputs: [
						{
							index: 0, agentType: 'claude-code', sessionId: 's0', prompt: 'p',
							output: 'o', rewards: [], aggregateReward: 0.8, durationMs: 1000,
							tokenUsage: { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0 },
						},
						{
							index: 1, agentType: 'claude-code', sessionId: 's1', prompt: 'p',
							output: 'o', rewards: [], aggregateReward: 0.3, durationMs: 1000,
							tokenUsage: { inputTokens: 150, outputTokens: 250, cacheReadTokens: 0 },
						},
					],
				}),
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)  // epoch 0 start
				.mockReturnValueOnce(false)  // task 0
				.mockReturnValueOnce(false)  // task 1
				.mockReturnValue(true);

			const result = await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// 2 tasks × 2 outputs × (100+200 + 150+250) tokens = 2 × 700 = 1400
			expect(result.totalTokenCost).toBe(1400);
		});
	});

	// ─── Test 11: Training lock — concurrent runs ───────────────────

	describe('training lock', () => {
		it('second concurrent run throws clear error', async () => {
			// Acquire lock for project
			await acquireTrainingLock('/test/project', tmpDir);

			// Second acquisition should throw
			await expect(
				acquireTrainingLock('/test/project', tmpDir),
			).rejects.toThrow('GRPO training loop already running');

			// Cleanup
			await releaseTrainingLock('/test/project', tmpDir);
		});

		it('lock is checked correctly', async () => {
			expect(await isTrainingLockHeld('/test/project', tmpDir)).toBe(false);

			await acquireTrainingLock('/test/project', tmpDir);
			expect(await isTrainingLockHeld('/test/project', tmpDir)).toBe(true);

			await releaseTrainingLock('/test/project', tmpDir);
			expect(await isTrainingLockHeld('/test/project', tmpDir)).toBe(false);
		});
	});

	// ─── Test 12: Stale lock ────────────────────────────────────────

	describe('stale lock detection', () => {
		it('overwrites lock from dead process', async () => {
			const lockDir = path.join(tmpDir, 'grpo', 'training.lock');
			await fs.mkdir(lockDir, { recursive: true });

			// Write a lock file with a PID that definitely doesn't exist
			const { createHash } = await import('crypto');
			const hash = createHash('sha256').update('/test/project').digest('hex').slice(0, 12);
			const lockPath = path.join(lockDir, hash);

			await fs.writeFile(lockPath, JSON.stringify({
				pid: 9999999, // Non-existent PID
				startedAt: Date.now() - 60000,
				projectPath: '/test/project',
			}));

			// Should succeed — stale lock is overwritten
			await expect(
				acquireTrainingLock('/test/project', tmpDir),
			).resolves.toBeUndefined();

			// Verify new lock has our PID
			const lockContent = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
			expect(lockContent.pid).toBe(process.pid);

			await releaseTrainingLock('/test/project', tmpDir);
		});
	});

	// ─── Test 13: Introspection failure ─────────────────────────────

	describe('introspection failure', () => {
		it('logs and skips, does not abort loop', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task A' }, { prompt: 'Task B' }];

			const deps = makeMockDependencies();

			// First task: introspection fails
			// Second task: introspection succeeds
			let callIdx = 0;
			(deps.semanticAdvantageGenerator.generateAdvantage as ReturnType<typeof vi.fn>).mockImplementation(
				async (group: RolloutGroup) => {
					callIdx++;
					if (callIdx === 1) {
						throw new Error('LLM timeout');
					}
					return makeAdvantage(group.id);
				},
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)  // epoch 0
				.mockReturnValueOnce(false)  // task 0
				.mockReturnValueOnce(false)  // task 1
				.mockReturnValue(true);

			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// First task's advantage was skipped with error
			expect(callbacks.onAdvantageSkipped).toHaveBeenCalledWith(
				expect.any(Object),
				expect.stringContaining('introspection error'),
			);
			// Second task's advantage was generated
			expect(callbacks.onAdvantageGenerated).toHaveBeenCalledTimes(1);
			// Loop completed (not aborted)
			expect(callbacks.onComplete).toHaveBeenCalled();
		});
	});

	// ─── Test 14: Lock released even on error ───────────────────────

	describe('lock released on error', () => {
		it('releases lock even when training loop throws', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task' }];

			const deps = makeMockDependencies();
			// Make rollout coordinator throw
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Fatal error'),
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>)
				.mockReturnValueOnce(false)
				.mockReturnValueOnce(false)
				.mockReturnValue(true);

			// The loop should complete (errors are caught per-task)
			await runTrainingLoop(tasks, '/test/project', config, deps, callbacks);

			// Lock should be released
			expect(await isTrainingLockHeld('/test/project', tmpDir)).toBe(false);
		});

		it('releases lock when an unexpected error is thrown', async () => {
			const config = makeConfig({ earlyStoppingEnabled: false });
			const tasks: TrainingTask[] = [{ prompt: 'Task' }];

			const deps = makeMockDependencies();

			// Make getLibrary (used after lock acquisition) throw an unexpected error
			(deps.experienceStore.getLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(
				new Error('Filesystem crash'),
			);

			// Make rollout succeed so we get past the rollout phase into the getLibrary call
			(deps.rolloutCoordinator.executeRolloutGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
				makeRolloutGroup({ rewardStdDev: 0.25 }),
			);

			const callbacks = makeCallbacks();
			(callbacks.shouldStop as ReturnType<typeof vi.fn>).mockReturnValue(false);

			// Should throw the error up to the caller
			await expect(
				runTrainingLoop(tasks, '/test/project', config, deps, callbacks),
			).rejects.toThrow('Filesystem crash');

			// Lock should still be released (finally block)
			expect(await isTrainingLockHeld('/test/project', tmpDir)).toBe(false);
		});
	});
});

// ─── shouldEarlyStop unit tests ──────────────────────────────────────

describe('shouldEarlyStop', () => {
	it('returns false when fewer than consecutiveNoImproveLimit epochs', () => {
		const current: EpochStats = {
			epoch: 1, rolloutGroupsProcessed: 3, meanReward: 0.5,
			rewardImprovement: 0.005, experienceOperations: { add: 1, modify: 0, delete: 0 },
			librarySize: 3, durationMs: 1000, tokenCost: 100,
		};

		expect(shouldEarlyStop(current, [], 3)).toBe(false);
	});

	it('returns true after 3 consecutive low-improvement epochs', () => {
		const makeStats = (epoch: number): EpochStats => ({
			epoch, rolloutGroupsProcessed: 3, meanReward: 0.5,
			rewardImprovement: 0.005, // < 1%
			experienceOperations: { add: 1, modify: 0, delete: 0 },
			librarySize: 3, durationMs: 1000, tokenCost: 100,
		});

		const previous = [makeStats(0), makeStats(1)];
		const current = makeStats(2);

		expect(shouldEarlyStop(current, previous, 3)).toBe(true);
	});

	it('returns false when improvement exceeds 1% in any of the recent epochs', () => {
		const makeStats = (epoch: number, improvement: number): EpochStats => ({
			epoch, rolloutGroupsProcessed: 3, meanReward: 0.5,
			rewardImprovement: improvement,
			experienceOperations: { add: 1, modify: 0, delete: 0 },
			librarySize: 3, durationMs: 1000, tokenCost: 100,
		});

		const previous = [makeStats(0, 0.005), makeStats(1, 0.02)]; // epoch 1 has >1% improvement
		const current = makeStats(2, 0.005);

		expect(shouldEarlyStop(current, previous, 3)).toBe(false);
	});

	it('returns true for zero-variance epoch (all groups had no operations)', () => {
		const current: EpochStats = {
			epoch: 3, rolloutGroupsProcessed: 5, meanReward: 0.5,
			rewardImprovement: 0.0, // No improvement
			experienceOperations: { add: 0, modify: 0, delete: 0 }, // No operations
			librarySize: 10, durationMs: 1000, tokenCost: 100,
		};

		// Even with only 1 previous epoch, zero-variance triggers immediately
		expect(shouldEarlyStop(current, [], 3)).toBe(true);
	});
});
