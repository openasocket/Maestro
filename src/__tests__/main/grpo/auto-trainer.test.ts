/**
 * Tests for AutoTrainer — automatic background training trigger.
 *
 * Mocks symphony-collector and experience-store to verify:
 * - Disabled/cooldown/in-progress guards
 * - Training readiness gating
 * - Experience generation from rollout groups
 * - safeSend status notifications
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────

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

const mockGetTrainingReadiness = vi.fn();
const mockFormNaturalRolloutGroups = vi.fn();
const mockOnTaskComplete = vi.fn();

vi.mock('../../../main/grpo/symphony-collector', () => ({
	getSymphonyCollector: vi.fn(() => ({
		getTrainingReadiness: mockGetTrainingReadiness,
		formNaturalRolloutGroups: mockFormNaturalRolloutGroups,
		onTaskComplete: mockOnTaskComplete,
	})),
}));

const mockAddExperience = vi.fn();

vi.mock('../../../main/grpo/experience-store', () => ({
	getExperienceStore: vi.fn(() => ({
		addExperience: mockAddExperience,
	})),
}));

import {
	maybeAutoTrain,
	isTrainingInProgress,
	getTrainingProjects,
	resetAutoTrainer,
} from '../../../main/grpo/auto-trainer';
import { captureException } from '../../../main/utils/sentry';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';
import type { GRPOConfig, RolloutGroup, RolloutOutput, RewardSignal } from '../../../shared/grpo-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROJECT_PATH = '/test/project';

function makeConfig(overrides: Partial<GRPOConfig> = {}): GRPOConfig {
	return { ...GRPO_CONFIG_DEFAULTS, enabled: true, ...overrides };
}

function makeRolloutOutput(overrides: Partial<RolloutOutput> = {}): RolloutOutput {
	return {
		index: 0,
		agentType: 'claude-code',
		sessionId: 'sess-001',
		prompt: 'test prompt',
		output: 'test output',
		rewards: [
			{ type: 'task-complete', score: 1.0, description: 'ok', collectedAt: Date.now() },
		] as RewardSignal[],
		aggregateReward: 0.8,
		durationMs: 5000,
		...overrides,
	};
}

function makeRolloutGroup(overrides: Partial<RolloutGroup> = {}): RolloutGroup {
	return {
		id: 'group-001',
		taskPrompt: 'Add a button to the login page',
		projectPath: PROJECT_PATH,
		outputs: [
			makeRolloutOutput({ index: 0, aggregateReward: 0.9, rewards: [{ type: 'task-complete', score: 0.9, description: 'good', collectedAt: Date.now() }] }),
			makeRolloutOutput({ index: 1, aggregateReward: 0.3, rewards: [{ type: 'task-complete', score: 0.3, description: 'poor', collectedAt: Date.now() }] }),
			makeRolloutOutput({ index: 2, aggregateReward: 0.6, rewards: [{ type: 'task-complete', score: 0.6, description: 'ok', collectedAt: Date.now() }] }),
		],
		groupSize: 3,
		meanReward: 0.6,
		rewardStdDev: 0.3,
		experienceVersion: 1,
		epoch: 1,
		createdAt: Date.now(),
		...overrides,
	};
}

/**
 * Flush microtasks + next macrotask to allow the void async IIFE inside
 * maybeAutoTrain to complete before assertions.
 */
async function flushTraining(): Promise<void> {
	// The void async IIFE runs after maybeAutoTrain resolves.
	// Multiple flushes ensure the entire async chain completes.
	await new Promise(resolve => setTimeout(resolve, 10));
	await new Promise(resolve => setTimeout(resolve, 10));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	resetAutoTrainer();
	mockGetTrainingReadiness.mockResolvedValue({ ready: false, matchedTaskCount: 0, minGroupSize: 3, suggestedTasks: [] });
	mockFormNaturalRolloutGroups.mockResolvedValue([]);
	mockAddExperience.mockResolvedValue({ id: 'exp-001' });
});

describe('AutoTrainer', () => {
	describe('maybeAutoTrain', () => {
		it('should do nothing when GRPO is disabled', async () => {
			const config = makeConfig({ enabled: false });
			const safeSend = vi.fn();

			await maybeAutoTrain(PROJECT_PATH, config, safeSend);

			expect(mockGetTrainingReadiness).not.toHaveBeenCalled();
			expect(safeSend).not.toHaveBeenCalled();
		});

		it('should do nothing during cooldown period', async () => {
			const config = makeConfig();
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			mockFormNaturalRolloutGroups.mockResolvedValue([makeRolloutGroup()]);

			// First call triggers training
			await maybeAutoTrain(PROJECT_PATH, config);
			await flushTraining();

			// Second call should be blocked by cooldown
			mockGetTrainingReadiness.mockClear();
			await maybeAutoTrain(PROJECT_PATH, config);

			expect(mockGetTrainingReadiness).not.toHaveBeenCalled();
		});

		it('should do nothing when already training same project', async () => {
			const config = makeConfig();
			const safeSend = vi.fn();

			// Set up so training starts but takes time
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			// Make formNaturalRolloutGroups return groups that will trigger the async IIFE
			mockFormNaturalRolloutGroups.mockResolvedValue([makeRolloutGroup()]);
			// Make addExperience hang to simulate in-progress training
			let resolveAddExperience!: () => void;
			mockAddExperience.mockImplementation(() => new Promise(resolve => {
				resolveAddExperience = () => resolve({ id: 'exp-001' });
			}));

			// First call — starts training (enters the void async IIFE)
			await maybeAutoTrain(PROJECT_PATH, config, safeSend);
			// At this point the void async IIFE has started but not finished
			expect(isTrainingInProgress()).toBe(true);

			// Second call — should be blocked because project is already training
			const safeSend2 = vi.fn();
			await maybeAutoTrain(PROJECT_PATH, config, safeSend2);
			expect(safeSend2).not.toHaveBeenCalled();

			// Unblock the training
			resolveAddExperience();
			await flushTraining();
		});

		it('should do nothing when getTrainingReadiness returns ready: false', async () => {
			const config = makeConfig();
			const safeSend = vi.fn();
			mockGetTrainingReadiness.mockResolvedValue({ ready: false, matchedTaskCount: 1, minGroupSize: 3, suggestedTasks: [] });

			await maybeAutoTrain(PROJECT_PATH, config, safeSend);

			expect(mockGetTrainingReadiness).toHaveBeenCalledWith(PROJECT_PATH);
			expect(mockFormNaturalRolloutGroups).not.toHaveBeenCalled();
			expect(safeSend).not.toHaveBeenCalled();
		});

		it('should trigger training when all conditions are met', async () => {
			const config = makeConfig();
			const group = makeRolloutGroup();
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			mockFormNaturalRolloutGroups.mockResolvedValue([group]);

			await maybeAutoTrain(PROJECT_PATH, config);
			await flushTraining();

			expect(mockGetTrainingReadiness).toHaveBeenCalledWith(PROJECT_PATH);
			expect(mockFormNaturalRolloutGroups).toHaveBeenCalledWith(PROJECT_PATH);
			// Group has rewardStdDev 0.3 > varianceThreshold 0.1 and best-worst gap > 0.1
			expect(mockAddExperience).toHaveBeenCalledWith(
				PROJECT_PATH,
				expect.objectContaining({
					category: 'performance',
					scope: 'project',
					agentType: 'all',
				}),
			);
		});

		it('should call safeSend with running then complete statuses', async () => {
			const config = makeConfig();
			const safeSend = vi.fn();
			const group = makeRolloutGroup();
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			mockFormNaturalRolloutGroups.mockResolvedValue([group]);

			await maybeAutoTrain(PROJECT_PATH, config, safeSend);
			await flushTraining();

			// First safeSend: 'running' status
			expect(safeSend).toHaveBeenCalledWith(
				'grpo:trainingStatus',
				expect.objectContaining({ projectPath: PROJECT_PATH, status: 'running', groupCount: 1 }),
			);
			// Second safeSend: 'complete' status
			expect(safeSend).toHaveBeenCalledWith(
				'grpo:trainingStatus',
				expect.objectContaining({ projectPath: PROJECT_PATH, status: 'complete' }),
			);
		});

		it('should call safeSend with error status when training fails', async () => {
			const config = makeConfig();
			const safeSend = vi.fn();
			const group = makeRolloutGroup();
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			mockFormNaturalRolloutGroups.mockResolvedValue([group]);
			mockAddExperience.mockRejectedValue(new Error('Disk full'));

			await maybeAutoTrain(PROJECT_PATH, config, safeSend);
			await flushTraining();

			// Should report 'running' then 'error'
			expect(safeSend).toHaveBeenCalledWith(
				'grpo:trainingStatus',
				expect.objectContaining({ projectPath: PROJECT_PATH, status: 'running' }),
			);
			expect(safeSend).toHaveBeenCalledWith(
				'grpo:trainingStatus',
				expect.objectContaining({ projectPath: PROJECT_PATH, status: 'error', error: expect.stringContaining('Disk full') }),
			);
			// Sentry should be called
			expect(captureException).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'autoTrain', projectPath: PROJECT_PATH }),
			);
		});
	});

	describe('isTrainingInProgress', () => {
		it('should return correct state during active training', async () => {
			expect(isTrainingInProgress()).toBe(false);
			expect(getTrainingProjects()).toEqual([]);

			const config = makeConfig();
			mockGetTrainingReadiness.mockResolvedValue({ ready: true, matchedTaskCount: 5, minGroupSize: 3, suggestedTasks: [] });
			mockFormNaturalRolloutGroups.mockResolvedValue([makeRolloutGroup()]);

			// Hold training in progress by making addExperience hang
			let resolveAddExperience!: () => void;
			mockAddExperience.mockImplementation(() => new Promise(resolve => {
				resolveAddExperience = () => resolve({ id: 'exp-001' });
			}));

			await maybeAutoTrain(PROJECT_PATH, config);

			// Training should now be in progress
			expect(isTrainingInProgress()).toBe(true);
			expect(getTrainingProjects()).toContain(PROJECT_PATH);

			// Complete the training
			resolveAddExperience();
			await flushTraining();

			expect(isTrainingInProgress()).toBe(false);
			expect(getTrainingProjects()).toEqual([]);
		});
	});
});
