/**
 * Tests for effectiveness evaluation wiring in memory-monitor-listener exit handler.
 * Verifies that session outcome signals are gathered and effectiveness is updated
 * for injected memories when a session exits (MEM-EVOLVE-04).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMemoryMonitorListener } from '../../../main/process-listeners/memory-monitor-listener';
import type { ProcessManager } from '../../../main/process-manager';
import type { ProcessListenerDependencies } from '../../../main/process-listeners/types';
import type { MemoryModuleAccessors } from '../../../main/process-listeners/memory-monitor-listener';

// Mock memory modules
const mockUpdateEffectiveness = vi.fn().mockResolvedValue(undefined);
const mockClearSessionInjection = vi.fn();
const mockGetInjectionRecord = vi.fn();

vi.mock('../../../main/memory/memory-injector', () => ({
	getInjectionRecord: (...args: unknown[]) => mockGetInjectionRecord(...args),
	clearSessionInjection: (...args: unknown[]) => mockClearSessionInjection(...args),
	recordSessionInjection: vi.fn(),
	generateDiffInjection: vi.fn(),
	hashContent: vi.fn().mockReturnValue('abc'),
	pushInjectionEvent: vi.fn(),
}));

vi.mock('../../../main/memory/effectiveness-evaluator', () => ({
	EffectivenessEvaluator: class {
		evaluateSession(_sessionId: string, record: { ids: string[] }, _signals: unknown) {
			// Return one update per memory ID with a fixed score
			return record.ids.map((id: string) => ({
				memoryId: id,
				outcomeScore: 0.6,
				scope: 'global' as const,
			}));
		}
	},
}));

vi.mock('../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		updateEffectiveness: mockUpdateEffectiveness,
	}),
}));

// Mock child_process for git diff check
vi.mock('child_process', () => ({
	execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
		cb(null, { stdout: '', stderr: '' });
	}),
}));

vi.mock('util', async () => {
	const actual = await vi.importActual('util');
	return {
		...actual,
		promisify: () => vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
	};
});

describe('Effectiveness Evaluation on Exit', () => {
	let mockProcessManager: ProcessManager;
	let mockLogger: ProcessListenerDependencies['logger'];
	let mockPatterns: ProcessListenerDependencies['patterns'];
	let eventHandlers: Map<string, (...args: unknown[]) => void>;
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

		mockAccessors = {
			getMemoryStore: () => ({
				getConfig: vi.fn().mockResolvedValue({
					enabled: true,
					enableLiveInjection: true,
					enableCheckpointInjection: true,
					liveSearchCooldownSeconds: 60,
				}),
				cascadingSearch: vi.fn().mockResolvedValue([]),
				selectMatchingPersonas: vi.fn().mockResolvedValue([]),
			}),
			getLiveContextQueue: () => ({
				enqueue: vi.fn(),
				getWriteCount: vi.fn().mockReturnValue(0),
			}),
			getInjector: () => ({
				getInjectionRecord: mockGetInjectionRecord,
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

	function initSession(sessionId: string) {
		// Trigger a usage event to initialize session state
		const usageHandler = eventHandlers.get('usage');
		if (usageHandler) {
			usageHandler(sessionId, {
				inputTokens: 50000,
				outputTokens: 10000,
				contextWindow: 200000,
			});
		}
	}

	it('should evaluate effectiveness on exit when injection record exists', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: ['mem-1', 'mem-2'],
			scopeGroups: [{ scope: 'global', ids: ['mem-1', 'mem-2'] }],
			contentHashes: new Map(),
			lastInjectedAt: Date.now(),
			totalTokensSaved: 0,
		});

		setup();
		initSession('test-session');

		// Trigger exit
		const exitHandler = eventHandlers.get('exit');
		expect(exitHandler).toBeDefined();
		exitHandler!('test-session', 0);

		// Wait for async evaluation
		await vi.waitFor(() => {
			expect(mockUpdateEffectiveness).toHaveBeenCalled();
		});

		// Should have called updateEffectiveness with the memory IDs
		expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
			['mem-1', 'mem-2'],
			0.6,
			'global',
			undefined,
			'/test/project'
		);

		// Should have cleared injection record
		expect(mockClearSessionInjection).toHaveBeenCalledWith('test-session');
	});

	it('should skip effectiveness evaluation when no injection record exists', async () => {
		mockGetInjectionRecord.mockReturnValue(undefined);

		setup();
		initSession('test-session-2');

		const exitHandler = eventHandlers.get('exit');
		exitHandler!('test-session-2', 0);

		// Give async code time to run
		await new Promise((r) => setTimeout(r, 100));

		expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
	});

	it('should skip effectiveness evaluation when injection record has no IDs', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: [],
			scopeGroups: [],
			contentHashes: new Map(),
			lastInjectedAt: Date.now(),
			totalTokensSaved: 0,
		});

		setup();
		initSession('test-session-3');

		const exitHandler = eventHandlers.get('exit');
		exitHandler!('test-session-3', 0);

		await new Promise((r) => setTimeout(r, 100));

		expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
	});

	it('should clean up session state on exit', async () => {
		mockGetInjectionRecord.mockReturnValue(undefined);

		setup();
		initSession('test-session-4');

		const exitHandler = eventHandlers.get('exit');
		exitHandler!('test-session-4', 0);

		// Verify usage handler no longer finds state (session was deleted)
		// Re-init should create fresh state
		const usageHandler = eventHandlers.get('usage');
		usageHandler!('test-session-4', {
			inputTokens: 50000,
			outputTokens: 10000,
			contextWindow: 200000,
		});
		// No error means cleanup worked and re-creation succeeded
	});

	it('should log effectiveness update details', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: ['mem-1'],
			scopeGroups: [{ scope: 'global', ids: ['mem-1'] }],
			contentHashes: new Map(),
			lastInjectedAt: Date.now(),
			totalTokensSaved: 0,
		});

		setup();
		initSession('test-session-5');

		const exitHandler = eventHandlers.get('exit');
		exitHandler!('test-session-5', 0);

		await vi.waitFor(() => {
			expect(mockLogger.debug).toHaveBeenCalledWith(
				expect.stringContaining('[memory-effectiveness]'),
				'MemoryEffectiveness',
				expect.objectContaining({
					sessionId: 'test-session-5',
					memoryCount: 1,
				})
			);
		});
	});
});
