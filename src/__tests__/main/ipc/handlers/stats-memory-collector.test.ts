/**
 * Tests for Memory Collector integration in Stats IPC handlers (EXP-12 Strategy 1).
 *
 * Verifies that the stats:record-task handler correctly feeds Auto Run task
 * completions into the MemoryCollector for pattern detection.
 *
 * This is a separate test file to avoid module cache contamination with other
 * stats handler tests that also trigger the stats:record-task handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import type { StatsDB } from '../../../../main/stats';

// ─── Module-level mocks ─────────────────────────────────────────────────────

const mockMemoryCollector = {
	onAutoRunTaskComplete: vi.fn(),
	detectPatterns: vi.fn().mockResolvedValue(0),
};
const mockMemoryConfig = { enabled: true };
let mockStoredSessions: Array<{ id: string; projectRoot: string; toolType: string }> = [];

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
	BrowserWindow: vi.fn(),
}));

vi.mock('../../../../main/stats', () => ({
	getStatsDB: vi.fn(),
	getInitializationResult: vi.fn(),
	clearInitializationResult: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../../main/stores', () => ({
	getSessionsStore: () => ({
		get: (_key: string, _default: unknown[]) => mockStoredSessions,
	}),
}));

vi.mock('../../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		getConfig: () => Promise.resolve(mockMemoryConfig),
	}),
}));

vi.mock('../../../../main/memory/memory-collector', () => ({
	getMemoryCollector: () => mockMemoryCollector,
}));

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('stats:record-task memory collector integration', () => {
	let handlers: Map<string, Function>;
	let mockStatsDB: Partial<StatsDB>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mockMemoryCollector.onAutoRunTaskComplete.mockClear();
		mockMemoryCollector.detectPatterns.mockClear().mockResolvedValue(0);
		mockMemoryConfig.enabled = true;
		mockStoredSessions = [
			{ id: 'session-1', projectRoot: '/test/project', toolType: 'claude-code' },
		];

		mockStatsDB = {
			insertAutoRunTask: vi.fn().mockReturnValue('autorun-task-id'),
			insertQueryEvent: vi.fn().mockReturnValue('query-event-id'),
			insertAutoRunSession: vi.fn().mockReturnValue('autorun-session-id'),
			updateAutoRunSession: vi.fn().mockReturnValue(true),
			getQueryEvents: vi.fn().mockReturnValue([]),
			getAutoRunSessions: vi.fn().mockReturnValue([]),
			getAutoRunTasks: vi.fn().mockReturnValue([]),
			getAggregatedStats: vi.fn().mockReturnValue({
				totalQueries: 0,
				totalDuration: 0,
				avgDuration: 0,
				byAgent: {},
				bySource: { user: 0, auto: 0 },
				byLocation: { local: 0, remote: 0 },
				byDay: [],
				byHour: [],
				totalSessions: 0,
				sessionsByAgent: {},
				sessionsByDay: [],
				avgSessionDuration: 0,
				byAgentByDay: {},
				bySessionByDay: {},
			}),
			exportToCsv: vi.fn().mockReturnValue(''),
			clearOldData: vi.fn().mockReturnValue({ success: true, deletedCount: 0 }),
			getDatabaseSize: vi.fn().mockReturnValue({ sizeBytes: 1024, sizeFormatted: '1 KB' }),
			recordSessionCreated: vi.fn().mockReturnValue('session-lifecycle-id'),
			recordSessionClosed: vi.fn().mockReturnValue(true),
			getSessionLifecycleEvents: vi.fn().mockReturnValue([]),
		};

		const { getStatsDB } = await import('../../../../main/stats');
		vi.mocked(getStatsDB).mockReturnValue(mockStatsDB as unknown as StatsDB);

		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		const mockMainWindow = {
			webContents: { send: vi.fn(), isDestroyed: vi.fn().mockReturnValue(false) },
			isDestroyed: vi.fn().mockReturnValue(false),
		};

		const { registerStatsHandlers } = await import('../../../../main/ipc/handlers/stats');
		registerStatsHandlers({ getMainWindow: () => mockMainWindow as any });
	});

	afterEach(() => {
		handlers.clear();
	});

	it('should call memory collector for Auto Run tasks with taskContent', async () => {
		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Fix the login bug',
			startTime: Date.now(),
			duration: 15000,
			success: true,
		});

		await vi.waitFor(() => {
			expect(mockMemoryCollector.onAutoRunTaskComplete).toHaveBeenCalledWith(
				'Fix the login bug',
				'/test/project',
				'claude-code',
				0,
				'Fix the login bug',
				15000
			);
		});
		await vi.waitFor(() => {
			expect(mockMemoryCollector.detectPatterns).toHaveBeenCalledWith(
				'/test/project',
				'claude-code'
			);
		});
	});

	it('should pass exitCode=1 for failed tasks', async () => {
		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Broken task',
			startTime: Date.now(),
			duration: 5000,
			success: false,
		});

		await vi.waitFor(() => {
			expect(mockMemoryCollector.onAutoRunTaskComplete).toHaveBeenCalledWith(
				'Broken task',
				'/test/project',
				'claude-code',
				1,
				'Broken task',
				5000
			);
		});
	});

	it('should skip memory collection when taskContent is empty', async () => {
		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			startTime: Date.now(),
			duration: 5000,
			success: true,
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mockMemoryCollector.onAutoRunTaskComplete).not.toHaveBeenCalled();
	});

	it('should skip memory collection when session not found', async () => {
		mockStoredSessions = [];

		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'unknown-session',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Some task',
			startTime: Date.now(),
			duration: 5000,
			success: true,
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mockMemoryCollector.onAutoRunTaskComplete).not.toHaveBeenCalled();
	});

	it('should skip memory collection when memory system is disabled', async () => {
		mockMemoryConfig.enabled = false;

		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Some task',
			startTime: Date.now(),
			duration: 5000,
			success: true,
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mockMemoryCollector.onAutoRunTaskComplete).not.toHaveBeenCalled();
	});

	it('should strip AI tab suffix when looking up session', async () => {
		mockStoredSessions = [
			{ id: 'session-abc', projectRoot: '/test/project', toolType: 'claude-code' },
		];

		const handler = handlers.get('stats:record-task');
		await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-abc-ai-tab1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Task with AI tab session ID',
			startTime: Date.now(),
			duration: 5000,
			success: true,
		});

		await vi.waitFor(() => {
			expect(mockMemoryCollector.onAutoRunTaskComplete).toHaveBeenCalledWith(
				'Task with AI tab session ID',
				'/test/project',
				'claude-code',
				0,
				'Task with AI tab session ID',
				5000
			);
		});
	});

	it('should still return stats ID even if memory collection errors', async () => {
		mockMemoryCollector.detectPatterns.mockRejectedValue(new Error('detect failed'));

		const handler = handlers.get('stats:record-task');
		const result = await handler!({} as any, {
			autoRunSessionId: 'autorun-1',
			sessionId: 'session-1',
			agentType: 'claude-code',
			taskIndex: 0,
			taskContent: 'Some task',
			startTime: Date.now(),
			duration: 5000,
			success: true,
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(result).toBe('autorun-task-id');
	});
});
