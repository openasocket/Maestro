/**
 * Tests for GRPO process listener.
 * Handles query-complete events for GRPO passive signal collection.
 * Follows stats-listener.test.ts patterns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupGRPOListener } from '../../../main/process-listeners/grpo-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { QueryCompleteData } from '../../../main/process-manager/types';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';
import type { GRPOConfig } from '../../../shared/grpo-types';

// Mock symphony-collector
const mockOnTaskComplete = vi.fn();

vi.mock('../../../main/grpo/symphony-collector', () => ({
	getSymphonyCollector: vi.fn(() => ({
		onTaskComplete: mockOnTaskComplete,
	})),
}));

describe('GRPO Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockLogger: ProcessListenerDependencies['logger'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let grpoConfig: GRPOConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
		} as unknown as ProcessManager;

		grpoConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true };

		mockOnTaskComplete.mockResolvedValue({
			taskContent: 'test',
			taskContentHash: 'abc123',
			rewards: [],
			aggregateReward: 0.5,
			agentType: 'claude-code',
			sessionId: 'sess-001',
			durationMs: 5000,
			collectedAt: Date.now(),
			documentPath: '',
			projectPath: '/test/project',
			realm: 'process',
		});
	});

	function makeQueryData(overrides: Partial<QueryCompleteData> = {}): QueryCompleteData {
		return {
			sessionId: 'test-session-123',
			agentType: 'claude-code',
			source: 'user',
			startTime: Date.now() - 5000,
			duration: 5000,
			projectPath: '/test/project',
			tabId: 'tab-123',
			...overrides,
		};
	}

	it('should register the query-complete event listener', () => {
		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		expect(mockProcessManager.on).toHaveBeenCalledWith('query-complete', expect.any(Function));
	});

	it('should do nothing when GRPO is disabled', async () => {
		grpoConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: false };

		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		const handler = eventHandlers.get('query-complete');
		handler?.('test-session-123', makeQueryData());

		// Wait for any async processing
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(mockOnTaskComplete).not.toHaveBeenCalled();
	});

	it('should skip events without projectPath', async () => {
		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		const handler = eventHandlers.get('query-complete');
		handler?.('test-session-456', makeQueryData({ projectPath: undefined }));

		// Wait for any async processing
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(mockOnTaskComplete).not.toHaveBeenCalled();
	});

	it('should skip grpo-rollout-* session IDs to prevent self-referential collection', async () => {
		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		const handler = eventHandlers.get('query-complete');
		handler?.('grpo-rollout-abc', makeQueryData({ sessionId: 'grpo-rollout-abc' }));

		// Wait for any async processing
		await new Promise(resolve => setTimeout(resolve, 20));

		expect(mockOnTaskComplete).not.toHaveBeenCalled();
	});

	it('should collect signal for valid query-complete events', async () => {
		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		const handler = eventHandlers.get('query-complete');
		const queryData = makeQueryData();
		handler?.('test-session-123', queryData);

		// Wait for async processing
		await vi.waitFor(() => {
			expect(mockOnTaskComplete).toHaveBeenCalledWith(
				expect.stringContaining('[process] claude-code query in /test/project'),
				'/test/project',
				'claude-code',
				'test-session-123',
				0,     // exit code
				'',    // no output
				5000,  // duration
				'',    // no document path
				'process', // realm
			);
		});

		expect(mockLogger.debug).toHaveBeenCalledWith(
			expect.stringContaining('Collected process signal'),
			'[GRPOListener]',
		);
	});

	it('should handle collector errors gracefully without crashing', async () => {
		mockOnTaskComplete.mockRejectedValue(new Error('Collector failed'));

		setupGRPOListener(mockProcessManager, {
			logger: mockLogger,
			getGRPOConfig: () => grpoConfig,
		});

		const handler = eventHandlers.get('query-complete');
		handler?.('test-session-789', makeQueryData());

		// Wait for async processing
		await vi.waitFor(() => {
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining('Failed to collect process signal'),
				'[GRPOListener]',
			);
		});
	});
});
