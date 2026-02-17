/**
 * Tests for realm-conditional reward collection in SymphonyCollector.
 * Verifies that 'process' realm skips heavy commands and only collects
 * synchronous signals, while 'autorun' realm runs the full pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock reward collector
const mockDetectProjectCommands = vi.fn();
const mockCollectAllRewards = vi.fn();
const mockCollectExitCodeReward = vi.fn();
const mockCollectTaskCompleteReward = vi.fn();
const mockComputeAggregateReward = vi.fn();

vi.mock('../../../main/grpo/reward-collector', () => ({
	detectProjectCommands: (...args: unknown[]) => mockDetectProjectCommands(...args),
	collectAllRewards: (...args: unknown[]) => mockCollectAllRewards(...args),
	collectExitCodeReward: (...args: unknown[]) => mockCollectExitCodeReward(...args),
	collectTaskCompleteReward: (...args: unknown[]) => mockCollectTaskCompleteReward(...args),
	computeAggregateReward: (...args: unknown[]) => mockComputeAggregateReward(...args),
}));

// Mock electron app
vi.mock('electron', () => ({
	app: { getPath: () => '/tmp/test-maestro' },
}));

// Mock logger and sentry
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { SymphonyCollector } from '../../../main/grpo/symphony-collector';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

describe('SymphonyCollector realm-conditional reward collection', () => {
	let collector: SymphonyCollector;
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'symphony-realm-'));
		collector = new SymphonyCollector(GRPO_CONFIG_DEFAULTS, tmpDir);
		await collector.initialize();

		// Reset mocks
		vi.clearAllMocks();
		mockComputeAggregateReward.mockReturnValue(0.8);
		mockCollectExitCodeReward.mockReturnValue({
			type: 'process-exit-code', score: 1.0, description: 'Exit code: 0', collectedAt: Date.now(),
		});
		mockCollectTaskCompleteReward.mockReturnValue({
			type: 'task-complete', score: 1.0, description: 'Task completed successfully', collectedAt: Date.now(),
		});
		mockDetectProjectCommands.mockResolvedValue({
			testCommand: 'npm test', buildCommand: 'npm run build',
			lintCommand: 'npm run lint', projectType: 'node',
		});
		mockCollectAllRewards.mockResolvedValue([
			{ type: 'test-pass', score: 1.0, description: 'Tests passed', collectedAt: Date.now() },
			{ type: 'build-success', score: 1.0, description: 'Build ok', collectedAt: Date.now() },
		]);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	it('should skip detectProjectCommands and collectAllRewards for process realm', async () => {
		await collector.onTaskComplete(
			'test task',
			'/test/project',
			'claude-code',
			'session-1',
			0,
			'',
			1000,
			'',
			'process',
		);

		// Heavy functions should NOT be called
		expect(mockDetectProjectCommands).not.toHaveBeenCalled();
		expect(mockCollectAllRewards).not.toHaveBeenCalled();

		// Lightweight functions SHOULD be called
		expect(mockCollectExitCodeReward).toHaveBeenCalledWith(0);
		expect(mockCollectTaskCompleteReward).toHaveBeenCalledWith('', 0);
	});

	it('should run full reward pipeline for autorun realm', async () => {
		await collector.onTaskComplete(
			'test task',
			'/test/project',
			'claude-code',
			'session-1',
			0,
			'some output',
			1000,
			'doc.md',
			'autorun',
		);

		// Heavy functions SHOULD be called
		expect(mockDetectProjectCommands).toHaveBeenCalledWith('/test/project');
		expect(mockCollectAllRewards).toHaveBeenCalled();

		// Lightweight functions should NOT be called directly (they run inside collectAllRewards)
		expect(mockCollectExitCodeReward).not.toHaveBeenCalled();
		expect(mockCollectTaskCompleteReward).not.toHaveBeenCalled();
	});

	it('should run full reward pipeline for manual realm', async () => {
		await collector.onTaskComplete(
			'test task',
			'/test/project',
			'claude-code',
			'session-1',
			1,
			'error output',
			500,
			'',
			'manual',
		);

		expect(mockDetectProjectCommands).toHaveBeenCalled();
		expect(mockCollectAllRewards).toHaveBeenCalled();
	});

	it('should run full reward pipeline for default realm (autorun)', async () => {
		// realm defaults to 'autorun' when not specified
		await collector.onTaskComplete(
			'test task',
			'/test/project',
			'claude-code',
			'session-1',
			0,
			'output',
			1000,
			'doc.md',
		);

		expect(mockDetectProjectCommands).toHaveBeenCalled();
		expect(mockCollectAllRewards).toHaveBeenCalled();
	});

	it('should still produce valid CollectedSignal for process realm', async () => {
		const signal = await collector.onTaskComplete(
			'process task',
			'/test/project',
			'claude-code',
			'session-1',
			0,
			'',
			1500,
			'',
			'process',
		);

		expect(signal).toBeDefined();
		expect(signal.taskContent).toBe('process task');
		expect(signal.realm).toBe('process');
		expect(signal.rewards).toHaveLength(2); // exit-code + task-complete
		expect(signal.aggregateReward).toBe(0.8); // from mock
		expect(signal.taskContentHash).toBeDefined();
	});

	it('should respect weight=0 for process realm signals', async () => {
		// Create collector with zero weights for the two signals
		const customConfig = {
			...GRPO_CONFIG_DEFAULTS,
			rewardWeights: {
				...GRPO_CONFIG_DEFAULTS.rewardWeights,
				'process-exit-code': 0,
				'task-complete': 0,
			},
		};
		const customCollector = new SymphonyCollector(customConfig, tmpDir);
		await customCollector.initialize();

		const signal = await customCollector.onTaskComplete(
			'test',
			'/test/project',
			'claude-code',
			'session-1',
			0,
			'',
			100,
			'',
			'process',
		);

		// Neither lightweight collector should be called when weight is 0
		expect(mockCollectExitCodeReward).not.toHaveBeenCalled();
		expect(mockCollectTaskCompleteReward).not.toHaveBeenCalled();
		expect(signal.rewards).toHaveLength(0);
	});
});
