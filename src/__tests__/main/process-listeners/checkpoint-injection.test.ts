/**
 * Tests for checkpoint-style injection triggers in memory-monitor-listener.
 * Verifies that checkpoint events fire correctly with proper cooldowns,
 * priority levels, and agent-type gating.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMemoryMonitorListener } from '../../../main/process-listeners/memory-monitor-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';
import type { MemoryModuleAccessors } from '../../../main/process-listeners/memory-monitor-listener';
import type { AgentError } from '../../../shared/types';

describe('Checkpoint Injection', () => {
	let mockProcessManager: ProcessManager;
	let mockLogger: ProcessListenerDependencies['logger'];
	let mockPatterns: ProcessListenerDependencies['patterns'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let mockEnqueue: ReturnType<typeof vi.fn>;
	let mockCascadingSearch: ReturnType<typeof vi.fn>;
	let mockAccessors: MemoryModuleAccessors;

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockPatterns = {
			REGEX_MODERATOR_SESSION: /^moderator-/,
			REGEX_MODERATOR_SESSION_TIMESTAMP: /^moderator-.*-\d+$/,
			REGEX_AI_SUFFIX: /-ai$/,
			REGEX_AI_TAB_ID: /-ai-tab-/,
			REGEX_BATCH_SESSION: /batch-\d+$/,
			REGEX_SYNOPSIS_SESSION: /synopsis-\d+$/,
		};

		mockEnqueue = vi.fn();
		mockCascadingSearch = vi.fn().mockResolvedValue([
			{
				entry: { id: 'mem-1', type: 'experience', content: 'test memory content' },
				similarity: 0.9,
				combinedScore: 0.9,
			},
			{
				entry: { id: 'mem-2', type: 'experience', content: 'another memory' },
				similarity: 0.8,
				combinedScore: 0.8,
			},
		]);

		mockAccessors = {
			getMemoryStore: () => ({
				getConfig: vi.fn().mockResolvedValue({
					enabled: true,
					enableLiveInjection: true,
					enableCheckpointInjection: true,
					checkpointMaxPerSession: 5,
					checkpointCooldownSeconds: 120,
					liveSearchCooldownSeconds: 60,
				}),
				cascadingSearch: mockCascadingSearch,
				selectMatchingPersonas: vi.fn().mockResolvedValue([]),
			}),
			getLiveContextQueue: () => ({
				enqueue: mockEnqueue,
				getWriteCount: vi.fn().mockReturnValue(0),
			}),
			getInjector: () => ({
				getInjectionRecord: vi.fn().mockReturnValue(undefined),
				generateDiffInjection: vi.fn(),
				recordSessionInjection: vi.fn(),
				hashContent: vi.fn().mockReturnValue('abc'),
			}),
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				eventHandlers.set(event, handler);
			}),
			get: vi.fn().mockReturnValue({
				toolType: 'claude-code',
				projectPath: '/test/project',
			}),
		} as unknown as ProcessManager;
	});

	function setup() {
		setupMemoryMonitorListener(
			mockProcessManager,
			{ logger: mockLogger, patterns: mockPatterns },
			mockAccessors
		);
	}

	it('should register checkpoint event handlers', () => {
		setup();

		const registeredEvents = Array.from(eventHandlers.keys());
		expect(registeredEvents).toContain('agent-error');
		expect(registeredEvents).toContain('usage');
		expect(registeredEvents).toContain('query-complete');
	});

	it('should trigger checkpoint on first error for claude-code agent', async () => {
		setup();

		const errorHandler = eventHandlers.get('agent-error');
		const testError: AgentError = {
			type: 'unknown',
			agentId: 'claude-code',
			message: 'Module not found: react-utils',
			recoverable: true,
			timestamp: Date.now(),
		};

		errorHandler?.('test-session', testError);

		// Wait for async checkpoint search
		await vi.waitFor(() => {
			expect(mockCascadingSearch).toHaveBeenCalled();
		});

		await vi.waitFor(() => {
			expect(mockEnqueue).toHaveBeenCalledWith(
				'test-session',
				expect.any(String),
				'checkpoint:first-error',
				expect.any(Number),
				expect.any(Array),
				false
			);
		});
	});

	it('should trigger context pressure checkpoint at 60% usage', async () => {
		setup();

		const usageHandler = eventHandlers.get('usage');

		// First call to initialize state
		usageHandler?.('test-session', {
			inputTokens: 50000,
			outputTokens: 10000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 100000,
		});

		// 60% usage
		usageHandler?.('test-session', {
			inputTokens: 55000,
			outputTokens: 5000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 100000,
		});

		await vi.waitFor(() => {
			expect(mockCascadingSearch).toHaveBeenCalled();
		});

		await vi.waitFor(() => {
			expect(mockEnqueue).toHaveBeenCalledWith(
				'test-session',
				expect.any(String),
				'checkpoint:context-pressure',
				expect.any(Number),
				expect.any(Array),
				false
			);
		});
	});

	it('should not trigger context pressure checkpoint twice', async () => {
		setup();

		const usageHandler = eventHandlers.get('usage');

		// 65% usage — triggers context pressure
		usageHandler?.('test-session', {
			inputTokens: 60000,
			outputTokens: 5000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 100000,
		});

		await vi.waitFor(() => {
			expect(mockEnqueue).toHaveBeenCalledTimes(1);
		});

		// 70% usage — should NOT trigger again
		usageHandler?.('test-session', {
			inputTokens: 65000,
			outputTokens: 5000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.02,
			contextWindow: 100000,
		});

		// Still only 1 enqueue call
		await new Promise((r) => setTimeout(r, 50));
		expect(mockEnqueue).toHaveBeenCalledTimes(1);
	});

	it('should not trigger checkpoint for non-capable agents', async () => {
		// Override to return terminal agent
		(mockProcessManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
			toolType: 'terminal',
			projectPath: '/test/project',
		});

		setup();

		const errorHandler = eventHandlers.get('agent-error');
		const testError: AgentError = {
			type: 'unknown',
			agentId: 'terminal',
			message: 'Some error',
			recoverable: true,
			timestamp: Date.now(),
		};

		errorHandler?.('test-terminal-session', testError);

		await new Promise((r) => setTimeout(r, 50));
		// Should not trigger checkpoint search for terminal
		expect(mockEnqueue).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.stringContaining('checkpoint:'),
			expect.anything(),
			expect.anything(),
			expect.anything()
		);
	});

	it('should respect per-session checkpoint cap', async () => {
		// Create accessor with cap of 1
		const mockGetConfig = vi.fn().mockResolvedValue({
			enabled: true,
			enableLiveInjection: true,
			enableCheckpointInjection: true,
			checkpointMaxPerSession: 1,
			checkpointCooldownSeconds: 0,
			liveSearchCooldownSeconds: 0,
		});
		mockAccessors = {
			...mockAccessors,
			getMemoryStore: () => ({
				getConfig: mockGetConfig,
				cascadingSearch: mockCascadingSearch,
				selectMatchingPersonas: vi.fn().mockResolvedValue([]),
			}),
		};

		setup();

		const errorHandler = eventHandlers.get('agent-error');

		// First error — should trigger
		errorHandler?.('test-session', {
			type: 'unknown',
			agentId: 'claude-code',
			message: 'Error 1',
			recoverable: true,
			timestamp: Date.now(),
		});

		await vi.waitFor(() => {
			expect(mockEnqueue).toHaveBeenCalledTimes(1);
		});

		// Reset search mock for clean tracking
		mockCascadingSearch.mockClear();
		mockEnqueue.mockClear();

		// Second error (different type) — should NOT trigger checkpoint (cap hit)
		errorHandler?.('test-session', {
			type: 'network_error',
			agentId: 'claude-code',
			message: 'Error 2',
			recoverable: true,
			timestamp: Date.now(),
		});

		await new Promise((r) => setTimeout(r, 100));

		// The checkpoint source should not fire, but the monitoring source may fire
		const checkpointCalls = mockEnqueue.mock.calls.filter(
			(call: unknown[]) =>
				typeof call[2] === 'string' && (call[2] as string).startsWith('checkpoint:')
		);
		expect(checkpointCalls).toHaveLength(0);
	});

	it('should skip checkpoint when enableCheckpointInjection is false', async () => {
		mockAccessors = {
			...mockAccessors,
			getMemoryStore: () => ({
				getConfig: vi.fn().mockResolvedValue({
					enabled: true,
					enableLiveInjection: true,
					enableCheckpointInjection: false,
					checkpointMaxPerSession: 5,
					checkpointCooldownSeconds: 120,
					liveSearchCooldownSeconds: 60,
				}),
				cascadingSearch: mockCascadingSearch,
				selectMatchingPersonas: vi.fn().mockResolvedValue([]),
			}),
		};

		setup();

		const errorHandler = eventHandlers.get('agent-error');
		errorHandler?.('test-session', {
			type: 'unknown',
			agentId: 'claude-code',
			message: 'Some error',
			recoverable: true,
			timestamp: Date.now(),
		});

		await new Promise((r) => setTimeout(r, 100));
		const checkpointCalls = mockEnqueue.mock.calls.filter(
			(call: unknown[]) =>
				typeof call[2] === 'string' && (call[2] as string).startsWith('checkpoint:')
		);
		expect(checkpointCalls).toHaveLength(0);
	});

	it('should log checkpoint availability per agent type', () => {
		setup();

		// Trigger state creation for a claude-code session
		const usageHandler = eventHandlers.get('usage');
		usageHandler?.('test-session', {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.001,
			contextWindow: 200000,
		});

		expect(mockLogger.debug).toHaveBeenCalledWith(
			expect.stringContaining('Checkpoint injection available for claude-code'),
			'MemoryMonitor',
			expect.any(Object)
		);
	});

	it('should log fallback for non-checkpoint agents', () => {
		(mockProcessManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
			toolType: 'terminal',
			projectPath: '/test/project',
		});

		setup();

		const usageHandler = eventHandlers.get('usage');
		usageHandler?.('test-terminal', {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.001,
			contextWindow: 200000,
		});

		expect(mockLogger.debug).toHaveBeenCalledWith(
			expect.stringContaining('falling back to periodic'),
			'MemoryMonitor',
			expect.any(Object)
		);
	});
});
