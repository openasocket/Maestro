/**
 * Tests for memory monitor listener.
 * Tracks per-session state and triggers mid-session memory injection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupMemoryMonitorListener } from '../memory-monitor-listener';
import type { MemoryModuleAccessors } from '../memory-monitor-listener';
import type { ProcessManager } from '../../process-manager';
import type { ProcessListenerDependencies } from '../types';
import type { AgentError } from '../../../shared/types';
import type { UsageStats, ToolExecution } from '../../process-manager/types';

// Mock memory-injector for diff injection (MEM-EVOLVE-02)
const mockGetInjectionRecord = vi.fn().mockReturnValue(undefined);
const mockGenerateDiffInjection = vi.fn();
const mockRecordSessionInjection = vi.fn();
const mockHashContent = vi.fn((s: string) => s);

/**
 * Flush microtask queue multiple times to resolve chained async operations.
 * triggerMemorySearch has ~5 await points, so we need multiple flushes.
 */
async function flushPromises(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => process.nextTick(resolve));
	}
}

describe('Memory Monitor Listener', () => {
	let mockProcessManager: ProcessManager;
	let mockLogger: ProcessListenerDependencies['logger'];
	let mockPatterns: ProcessListenerDependencies['patterns'];
	let mockAccessors: MemoryModuleAccessors;
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
	let mockGetConfig: ReturnType<typeof vi.fn>;
	let mockCascadingSearch: ReturnType<typeof vi.fn>;
	let mockEnqueue: ReturnType<typeof vi.fn>;
	let mockGetWriteCount: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		eventHandlers = new Map();

		mockLogger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};

		mockPatterns = {
			REGEX_MODERATOR_SESSION: /^group-chat-.+-moderator$/,
			REGEX_MODERATOR_SESSION_TIMESTAMP: /^group-chat-.+-moderator-\d+$/,
			REGEX_AI_SUFFIX: /-ai$/,
			REGEX_AI_TAB_ID: /-ai-tab-\w+$/,
			REGEX_BATCH_SESSION: /-batch-\d+$/,
			REGEX_SYNOPSIS_SESSION: /-synopsis-\d+$/,
		};

		mockProcessManager = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				const existing = eventHandlers.get(event);
				if (existing) {
					const combined = (...args: unknown[]) => {
						existing(...args);
						handler(...args);
					};
					eventHandlers.set(event, combined);
				} else {
					eventHandlers.set(event, handler);
				}
			}),
			get: vi.fn().mockReturnValue({
				sessionId: 'test-session',
				toolType: 'claude-code',
				projectPath: '/home/user/project',
				cwd: '/home/user/project',
				pid: 1234,
				isTerminal: false,
				startTime: Date.now(),
			}),
		} as unknown as ProcessManager;

		// Injected memory module mocks
		mockGetConfig = vi.fn().mockResolvedValue({
			enabled: true,
			enableLiveInjection: true,
			liveSearchCooldownSeconds: 60,
		});

		mockCascadingSearch = vi.fn().mockResolvedValue([
			{
				entry: {
					id: 'mem-1',
					type: 'experience',
					content: 'Fix: use --force flag for Docker cleanup',
				},
				similarity: 0.8,
				combinedScore: 0.85,
			},
			{
				entry: { id: 'mem-2', type: 'rule', content: 'Always check container logs first' },
				similarity: 0.75,
				combinedScore: 0.78,
			},
		]);

		mockEnqueue = vi.fn();
		mockGetWriteCount = vi.fn().mockReturnValue(0);

		mockAccessors = {
			getMemoryStore: () => ({
				getConfig: mockGetConfig,
				cascadingSearch: mockCascadingSearch,
				selectMatchingPersonas: vi.fn().mockResolvedValue([]),
			}),
			getLiveContextQueue: () => ({
				enqueue: mockEnqueue,
				getWriteCount: mockGetWriteCount,
			}),
			getInjector: () => ({
				getInjectionRecord: mockGetInjectionRecord,
				generateDiffInjection: mockGenerateDiffInjection,
				recordSessionInjection: mockRecordSessionInjection,
				hashContent: mockHashContent,
			}),
		} as unknown as MemoryModuleAccessors;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup() {
		setupMemoryMonitorListener(
			mockProcessManager,
			{ logger: mockLogger, patterns: mockPatterns },
			mockAccessors
		);
	}

	function emitEvent(event: string, ...args: unknown[]) {
		const handler = eventHandlers.get(event);
		handler?.(...args);
	}

	// ── Test 1: Session state initialization ──

	it('should create session state from ManagedProcess on first event', () => {
		setup();

		const usageStats: UsageStats = {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		};

		emitEvent('usage', 'test-session', usageStats);

		expect(mockProcessManager.get).toHaveBeenCalledWith('test-session');
	});

	// ── Test 2: Group chat exclusion ──

	it('should not create state for group chat sessions', () => {
		setup();

		const usageStats: UsageStats = {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		};

		emitEvent('usage', 'group-chat-xxx', usageStats);

		expect(mockProcessManager.get).not.toHaveBeenCalled();
	});

	// ── Test 3: Batch session exclusion ──

	it('should not create state for batch sessions', () => {
		setup();

		const usageStats: UsageStats = {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		};

		emitEvent('usage', 'session-123-batch-1708000000', usageStats);

		expect(mockProcessManager.get).not.toHaveBeenCalled();
	});

	// ── Test 4: No-projectPath exclusion ──

	it('should not create state for sessions without projectPath', async () => {
		(mockProcessManager.get as ReturnType<typeof vi.fn>).mockReturnValue({
			sessionId: 'no-project',
			toolType: 'claude-code',
			projectPath: undefined,
			cwd: '/tmp',
			pid: 1234,
			isTerminal: false,
			startTime: Date.now(),
		});

		setup();

		const error: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Auth expired',
			recoverable: true,
			timestamp: Date.now(),
		};

		emitEvent('agent-error', 'no-project', error);
		emitEvent('agent-error', 'no-project', error);
		await flushPromises();

		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test 5: Context budget adjustment ──

	it('should reduce budget when context usage > 70% and stop at > 90%', async () => {
		setup();

		// At 75%: budget should be 300 — searches still allowed
		const usageAt75: UsageStats = {
			inputTokens: 135000,
			outputTokens: 15000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.5,
			contextWindow: 200000,
		};

		emitEvent('usage', 'test-session', usageAt75);

		// At 95%: budget should be 0
		const usageAt95: UsageStats = {
			inputTokens: 175000,
			outputTokens: 15000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 1.0,
			contextWindow: 200000,
		};

		emitEvent('usage', 'test-session', usageAt95);

		// Errors should NOT trigger search when budget is 0
		const error: AgentError = {
			type: 'rate_limited',
			agentId: 'claude-code',
			message: 'Rate limited',
			recoverable: true,
			timestamp: Date.now(),
		};
		emitEvent('agent-error', 'test-session', error);
		emitEvent('agent-error', 'test-session', error);
		await flushPromises();

		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test 6: Repeated error trigger ──

	it('should trigger memory search on 2nd occurrence of same error type', async () => {
		setup();

		const error: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Authentication token has expired',
			recoverable: true,
			timestamp: Date.now(),
		};

		emitEvent('agent-error', 'test-session', error);
		await flushPromises();
		expect(mockCascadingSearch).not.toHaveBeenCalled();

		emitEvent('agent-error', 'test-session', error);
		await flushPromises();

		expect(mockCascadingSearch).toHaveBeenCalledWith(
			'Authentication token has expired',
			expect.any(Object),
			'claude-code',
			'/home/user/project'
		);
	});

	// ── Test 7: Error cooldown enforcement ──

	it('should respect cooldown between memory searches', async () => {
		setup();

		const error: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Auth error',
			recoverable: true,
			timestamp: Date.now(),
		};

		// First trigger (2nd occurrence of error)
		emitEvent('agent-error', 'test-session', error);
		emitEvent('agent-error', 'test-session', error);
		await flushPromises();
		expect(mockCascadingSearch).toHaveBeenCalledTimes(1);

		// Emit a different error within cooldown — should not search again
		mockCascadingSearch.mockClear();
		const error2: AgentError = {
			type: 'rate_limited',
			agentId: 'claude-code',
			message: 'Rate limited',
			recoverable: true,
			timestamp: Date.now(),
		};

		emitEvent('agent-error', 'test-session', error2);
		emitEvent('agent-error', 'test-session', error2);
		await flushPromises();

		// getConfig is called, but cooldown prevents cascadingSearch
		expect(mockGetConfig).toHaveBeenCalled();
		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test 8: Tool domain tracking ──

	it('should trigger search for novel tool domains', async () => {
		setup();

		const toolExec: ToolExecution = {
			toolName: 'Docker',
			state: {},
			timestamp: Date.now(),
		};

		emitEvent('tool-execution', 'test-session', toolExec);
		await flushPromises();
		expect(mockCascadingSearch).toHaveBeenCalledWith(
			'Docker',
			expect.any(Object),
			'claude-code',
			'/home/user/project'
		);

		// Same tool again — no duplicate search
		mockCascadingSearch.mockClear();
		emitEvent('tool-execution', 'test-session', toolExec);
		await flushPromises();
		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test 9: Common tool filtering ──

	it('should not trigger search for common tools', async () => {
		setup();

		const commonTools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'];
		for (const toolName of commonTools) {
			emitEvent('tool-execution', 'test-session', {
				toolName,
				state: {},
				timestamp: Date.now(),
			});
		}

		await flushPromises();
		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test 10: Domain shift detection ──

	it('should trigger search on domain-shift signal in agent output', async () => {
		setup();

		// Create state first via a usage event
		emitEvent('usage', 'test-session', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		});

		emitEvent('data', 'test-session', 'Some output [domain-shift: Kubernetes] more text');
		await flushPromises();

		expect(mockLogger.debug).toHaveBeenCalledWith(
			'[MemoryMonitor] Domain shift detected',
			'MemoryMonitor',
			expect.objectContaining({ domain: 'Kubernetes' })
		);
		expect(mockCascadingSearch).toHaveBeenCalledWith(
			'Kubernetes',
			expect.any(Object),
			'claude-code',
			'/home/user/project'
		);
	});

	// ── Test 11: Session cleanup on exit ──

	it('should remove session state on exit event', () => {
		setup();

		// Create state
		emitEvent('usage', 'test-session', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		});

		// Exit the session
		emitEvent('exit', 'test-session', 0);

		// State should be cleaned — next event should call get() again
		(mockProcessManager.get as ReturnType<typeof vi.fn>).mockClear();
		emitEvent('usage', 'test-session', {
			inputTokens: 2000,
			outputTokens: 1000,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.02,
			contextWindow: 200000,
		});

		// get() should be called again because state was removed
		expect(mockProcessManager.get).toHaveBeenCalledWith('test-session');
	});

	// ── Test 12: Config check — enableLiveInjection false ──

	it('should not trigger searches when enableLiveInjection is false', async () => {
		mockGetConfig.mockResolvedValue({
			enabled: true,
			enableLiveInjection: false,
			liveSearchCooldownSeconds: 60,
		});

		setup();

		const error: AgentError = {
			type: 'auth_expired',
			agentId: 'claude-code',
			message: 'Auth error',
			recoverable: true,
			timestamp: Date.now(),
		};

		emitEvent('agent-error', 'test-session', error);
		emitEvent('agent-error', 'test-session', error);
		await flushPromises();

		// getConfig is called, but enableLiveInjection=false prevents cascadingSearch
		expect(mockGetConfig).toHaveBeenCalled();
		expect(mockCascadingSearch).not.toHaveBeenCalled();
	});

	// ── Test: registers all expected event listeners ──

	it('should register usage, agent-error, tool-execution, data, and exit listeners', () => {
		setup();

		const registeredEvents = (mockProcessManager.on as ReturnType<typeof vi.fn>).mock.calls.map(
			(call: unknown[]) => call[0]
		);

		expect(registeredEvents).toContain('usage');
		expect(registeredEvents).toContain('agent-error');
		expect(registeredEvents).toContain('tool-execution');
		expect(registeredEvents).toContain('data');
		expect(registeredEvents).toContain('exit');
	});

	// ── Test: synopsis session exclusion ──

	it('should not create state for synopsis sessions', () => {
		setup();

		emitEvent('usage', 'session-123-synopsis-1708000000', {
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			totalCostUsd: 0.01,
			contextWindow: 200000,
		});

		expect(mockProcessManager.get).not.toHaveBeenCalled();
	});

	// ── Test: enqueue results into LiveContextQueue ──

	it('should enqueue search results into LiveContextQueue', async () => {
		setup();

		const toolExec: ToolExecution = {
			toolName: 'DockerCompose',
			state: {},
			timestamp: Date.now(),
		};

		emitEvent('tool-execution', 'test-session', toolExec);
		await flushPromises();

		expect(mockEnqueue).toHaveBeenCalledWith(
			'test-session',
			expect.stringContaining('Fix: use --force flag'),
			'monitoring',
			expect.any(Number),
			['mem-1', 'mem-2'],
			false
		);
	});

	// ── Test: no search when no results ──

	it('should not enqueue when cascadingSearch returns empty results', async () => {
		mockCascadingSearch.mockResolvedValue([]);

		setup();

		const toolExec: ToolExecution = {
			toolName: 'Terraform',
			state: {},
			timestamp: Date.now(),
		};

		emitEvent('tool-execution', 'test-session', toolExec);
		await flushPromises();

		expect(mockEnqueue).not.toHaveBeenCalled();
	});
});
