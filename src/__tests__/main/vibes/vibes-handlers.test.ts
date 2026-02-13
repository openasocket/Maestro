/**
 * Tests for src/main/ipc/handlers/vibes-handlers.ts
 * Validates IPC handler registration and correct delegation to vibes-bridge functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mocks for vibes-bridge functions and electron
const {
	mockFindBinary,
	mockGetVersion,
	mockClearCache,
	mockIsInitialized,
	mockVibesInit,
	mockVibesBuild,
	mockVibesStats,
	mockVibesBlame,
	mockVibesLog,
	mockVibesCoverage,
	mockVibesReport,
	mockVibesSessions,
	mockVibesModels,
	mockVibesBackfillCommit,
	mockIpcMainHandle,
	mockComputeStats,
	mockExtractSessions,
	mockExtractModels,
	mockComputeBlame,
	mockComputeCoverage,
	mockReadAnnotations,
} = vi.hoisted(() => ({
	mockFindBinary: vi.fn(),
	mockGetVersion: vi.fn(),
	mockClearCache: vi.fn(),
	mockIsInitialized: vi.fn(),
	mockVibesInit: vi.fn(),
	mockVibesBuild: vi.fn(),
	mockVibesStats: vi.fn(),
	mockVibesBlame: vi.fn(),
	mockVibesLog: vi.fn(),
	mockVibesCoverage: vi.fn(),
	mockVibesReport: vi.fn(),
	mockVibesSessions: vi.fn(),
	mockVibesModels: vi.fn(),
	mockVibesBackfillCommit: vi.fn(),
	mockIpcMainHandle: vi.fn(),
	mockComputeStats: vi.fn(),
	mockExtractSessions: vi.fn(),
	mockExtractModels: vi.fn(),
	mockComputeBlame: vi.fn(),
	mockComputeCoverage: vi.fn(),
	mockReadAnnotations: vi.fn(),
}));

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: mockIpcMainHandle,
	},
}));

// Mock vibes-bridge
vi.mock('../../../main/vibes/vibes-bridge', () => ({
	findVibesCheckBinary: mockFindBinary,
	getVibesCheckVersion: mockGetVersion,
	clearBinaryPathCache: mockClearCache,
	isVibesInitialized: mockIsInitialized,
	vibesInit: mockVibesInit,
	vibesBuild: mockVibesBuild,
	vibesStats: mockVibesStats,
	vibesBlame: mockVibesBlame,
	vibesLog: mockVibesLog,
	vibesCoverage: mockVibesCoverage,
	vibesReport: mockVibesReport,
	vibesSessions: mockVibesSessions,
	vibesModels: mockVibesModels,
	vibesBackfillCommit: mockVibesBackfillCommit,
}));

// Mock vibes-io fallback functions
vi.mock('../../../main/vibes/vibes-io', () => ({
	computeStatsFromAnnotations: mockComputeStats,
	extractSessionsFromAnnotations: mockExtractSessions,
	extractModelsFromManifest: mockExtractModels,
	computeBlameFromAnnotations: mockComputeBlame,
	computeCoverageFromAnnotations: mockComputeCoverage,
	readAnnotations: mockReadAnnotations,
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
	},
}));

import { registerVibesHandlers } from '../../../main/ipc/handlers/vibes-handlers';

describe('vibes-handlers', () => {
	let handlers: Record<string, (...args: unknown[]) => Promise<unknown>>;
	let mockSettingsStore: { get: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = {};

		// Capture registered handlers
		mockIpcMainHandle.mockImplementation((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
			handlers[channel] = handler;
		});

		mockSettingsStore = {
			get: vi.fn().mockReturnValue(''),
		};

		// By default, simulate that vibecheck binary IS available
		// so existing tests that expect bridge calls still pass.
		mockFindBinary.mockResolvedValue('/usr/local/bin/vibecheck');

		registerVibesHandlers({ settingsStore: mockSettingsStore as any });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('handler registration', () => {
		it('should register all 14 VIBES IPC handlers', () => {
			expect(mockIpcMainHandle).toHaveBeenCalledTimes(14);
		});

		it('should register handlers with correct channel names', () => {
			const expectedChannels = [
				'vibes:isInitialized',
				'vibes:init',
				'vibes:getStats',
				'vibes:getBlame',
				'vibes:getLog',
				'vibes:getCoverage',
				'vibes:getReport',
				'vibes:getSessions',
				'vibes:getModels',
				'vibes:build',
				'vibes:findBinary',
				'vibes:clearBinaryCache',
				'vibes:getManifest',
				'vibes:backfillCommit',
			];
			for (const channel of expectedChannels) {
				expect(handlers[channel]).toBeDefined();
			}
		});
	});

	describe('vibes:isInitialized', () => {
		it('should call isVibesInitialized with the project path', async () => {
			mockIsInitialized.mockResolvedValue(true);
			const result = await handlers['vibes:isInitialized']({}, '/project');
			expect(mockIsInitialized).toHaveBeenCalledWith('/project');
			expect(result).toBe(true);
		});

		it('should return false when project is not initialized', async () => {
			mockIsInitialized.mockResolvedValue(false);
			const result = await handlers['vibes:isInitialized']({}, '/project');
			expect(result).toBe(false);
		});

		it('should return false on error', async () => {
			mockIsInitialized.mockRejectedValue(new Error('access denied'));
			const result = await handlers['vibes:isInitialized']({}, '/project');
			expect(result).toBe(false);
		});
	});

	describe('vibes:init', () => {
		const config = {
			projectName: 'test-project',
			assuranceLevel: 'medium' as const,
			extensions: ['.ts', '.js'],
		};

		it('should call vibesInit with config and custom binary path', async () => {
			mockSettingsStore.get.mockReturnValue('/custom/vibecheck');
			mockVibesInit.mockResolvedValue({ success: true });

			const result = await handlers['vibes:init']({}, '/project', config);

			expect(mockVibesInit).toHaveBeenCalledWith('/project', config, '/custom/vibecheck');
			expect(result).toEqual({ success: true });
		});

		it('should pass undefined when binary path is empty', async () => {
			mockSettingsStore.get.mockReturnValue('');
			mockVibesInit.mockResolvedValue({ success: true });

			await handlers['vibes:init']({}, '/project', config);

			expect(mockVibesInit).toHaveBeenCalledWith('/project', config, undefined);
		});

		it('should return error result on exception', async () => {
			mockVibesInit.mockRejectedValue(new Error('binary not found'));

			const result = await handlers['vibes:init']({}, '/project', config);

			expect(result).toEqual({ success: false, error: 'Error: binary not found' });
		});
	});

	describe('vibes:getStats', () => {
		it('should call vibesStats when binary is available', async () => {
			mockVibesStats.mockResolvedValue({ success: true, data: '{}' });

			const result = await handlers['vibes:getStats']({}, '/project');

			expect(mockFindBinary).toHaveBeenCalled();
			expect(mockVibesStats).toHaveBeenCalledWith('/project', undefined, undefined);
			expect(result).toEqual({ success: true, data: '{}' });
		});

		it('should pass optional file argument', async () => {
			mockVibesStats.mockResolvedValue({ success: true, data: '{}' });

			await handlers['vibes:getStats']({}, '/project', 'src/index.ts');

			expect(mockVibesStats).toHaveBeenCalledWith('/project', 'src/index.ts', undefined);
		});

		it('should return error on failure', async () => {
			mockVibesStats.mockRejectedValue(new Error('stats failed'));

			const result = await handlers['vibes:getStats']({}, '/project');

			expect(result).toEqual({ success: false, error: 'Error: stats failed' });
		});

		it('should fall back to direct reading when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockComputeStats.mockResolvedValue({
				totalAnnotations: 10,
				filesCovered: 3,
				totalTrackedFiles: 3,
				coveragePercent: 100,
				activeSessions: 1,
				contributingModels: 2,
				assuranceLevel: 'high',
			});

			const result = await handlers['vibes:getStats']({}, '/project');

			expect(mockVibesStats).not.toHaveBeenCalled();
			expect(mockComputeStats).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"totalAnnotations":10'),
			});
		});
	});

	describe('vibes:getBlame', () => {
		it('should call vibesBlame when binary is available', async () => {
			mockVibesBlame.mockResolvedValue({ success: true, data: '[]' });

			const result = await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockVibesBlame).toHaveBeenCalledWith('/project', 'src/index.ts', undefined);
			expect(result).toEqual({ success: true, data: '[]' });
		});

		it('should return error on failure', async () => {
			mockVibesBlame.mockRejectedValue(new Error('blame failed'));

			const result = await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(result).toEqual({ success: false, error: 'Error: blame failed' });
		});

		it('should fall back to direct blame computation when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockComputeBlame.mockResolvedValue([
				{ lineStart: 1, lineEnd: 10, action: 'create', modelName: 'claude-4', modelVersion: 'opus', toolName: 'claude-code', timestamp: '2026-02-10T12:00:00Z' },
			]);

			const result = await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockVibesBlame).not.toHaveBeenCalled();
			expect(mockComputeBlame).toHaveBeenCalledWith('/project', 'src/index.ts');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"lineStart":1'),
			});
		});
	});

	describe('vibes:getLog', () => {
		it('should call vibesLog when binary is available', async () => {
			const options = { file: 'src/index.ts', limit: 10, json: true };
			mockVibesLog.mockResolvedValue({ success: true, data: '[]' });

			const result = await handlers['vibes:getLog']({}, '/project', options);

			expect(mockVibesLog).toHaveBeenCalledWith('/project', options, undefined);
			expect(result).toEqual({ success: true, data: '[]' });
		});

		it('should work without options', async () => {
			mockVibesLog.mockResolvedValue({ success: true, data: '[]' });

			await handlers['vibes:getLog']({}, '/project');

			expect(mockVibesLog).toHaveBeenCalledWith('/project', undefined, undefined);
		});

		it('should fall back to direct annotation reading when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockReadAnnotations.mockResolvedValue([
				{ type: 'line', file_path: 'src/a.ts', line_start: 1, line_end: 5 },
			]);

			const result = await handlers['vibes:getLog']({}, '/project');

			expect(mockVibesLog).not.toHaveBeenCalled();
			expect(mockReadAnnotations).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"file_path":"src/a.ts"'),
			});
		});
	});

	describe('vibes:getCoverage', () => {
		it('should call vibesCoverage when binary is available', async () => {
			mockVibesCoverage.mockResolvedValue({ success: true, data: '{}' });

			const result = await handlers['vibes:getCoverage']({}, '/project');

			expect(mockVibesCoverage).toHaveBeenCalledWith('/project', true, undefined);
			expect(result).toEqual({ success: true, data: '{}' });
		});

		it('should fall back to direct coverage computation when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockComputeCoverage.mockResolvedValue([
				{ filePath: 'src/a.ts', status: 'covered', annotationCount: 10 },
			]);

			const result = await handlers['vibes:getCoverage']({}, '/project');

			expect(mockVibesCoverage).not.toHaveBeenCalled();
			expect(mockComputeCoverage).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"status":"covered"'),
			});
		});
	});

	describe('vibes:getReport', () => {
		it('should call vibesReport with format', async () => {
			mockVibesReport.mockResolvedValue({ success: true, data: '# Report' });

			const result = await handlers['vibes:getReport']({}, '/project', 'markdown');

			expect(mockVibesReport).toHaveBeenCalledWith('/project', 'markdown', undefined);
			expect(result).toEqual({ success: true, data: '# Report' });
		});

		it('should work without format', async () => {
			mockVibesReport.mockResolvedValue({ success: true, data: '{}' });

			await handlers['vibes:getReport']({}, '/project');

			expect(mockVibesReport).toHaveBeenCalledWith('/project', undefined, undefined);
		});
	});

	describe('vibes:getSessions', () => {
		it('should call vibesSessions when binary is available', async () => {
			mockVibesSessions.mockResolvedValue({ success: true, data: '[]' });

			const result = await handlers['vibes:getSessions']({}, '/project');

			expect(mockVibesSessions).toHaveBeenCalledWith('/project', undefined);
			expect(result).toEqual({ success: true, data: '[]' });
		});

		it('should fall back to direct session extraction when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockExtractSessions.mockResolvedValue([
				{ sessionId: 'sess-1', event: 'start', timestamp: '2026-02-10T12:00:00Z', annotationCount: 5 },
			]);

			const result = await handlers['vibes:getSessions']({}, '/project');

			expect(mockVibesSessions).not.toHaveBeenCalled();
			expect(mockExtractSessions).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"sessionId":"sess-1"'),
			});
		});
	});

	describe('vibes:getModels', () => {
		it('should call vibesModels when binary is available', async () => {
			mockVibesModels.mockResolvedValue({ success: true, data: '[]' });

			const result = await handlers['vibes:getModels']({}, '/project');

			expect(mockVibesModels).toHaveBeenCalledWith('/project', undefined);
			expect(result).toEqual({ success: true, data: '[]' });
		});

		it('should fall back to direct model extraction when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);
			mockExtractModels.mockResolvedValue([
				{ modelName: 'claude-4', modelVersion: 'opus', toolName: 'claude-code', annotationCount: 10, percentage: 100 },
			]);

			const result = await handlers['vibes:getModels']({}, '/project');

			expect(mockVibesModels).not.toHaveBeenCalled();
			expect(mockExtractModels).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"modelName":"claude-4"'),
			});
		});
	});

	describe('vibes:build', () => {
		it('should call vibesBuild with project path', async () => {
			mockVibesBuild.mockResolvedValue({ success: true });

			const result = await handlers['vibes:build']({}, '/project');

			expect(mockVibesBuild).toHaveBeenCalledWith('/project', undefined);
			expect(result).toEqual({ success: true });
		});

		it('should return error on failure', async () => {
			mockVibesBuild.mockRejectedValue(new Error('build failed'));

			const result = await handlers['vibes:build']({}, '/project');

			expect(result).toEqual({ success: false, error: 'Error: build failed' });
		});
	});

	describe('vibes:findBinary', () => {
		it('should return path and version when binary is found', async () => {
			mockFindBinary.mockResolvedValue('/usr/local/bin/vibecheck');
			mockGetVersion.mockResolvedValue('vibecheck 0.3.2');

			const result = await handlers['vibes:findBinary']({}, '/custom/vibecheck');

			expect(mockFindBinary).toHaveBeenCalledWith('/custom/vibecheck');
			expect(mockGetVersion).toHaveBeenCalledWith('/usr/local/bin/vibecheck');
			expect(result).toEqual({ path: '/usr/local/bin/vibecheck', version: 'vibecheck 0.3.2' });
		});

		it('should return path with null version when --version fails', async () => {
			mockFindBinary.mockResolvedValue('/usr/local/bin/vibecheck');
			mockGetVersion.mockResolvedValue(null);

			const result = await handlers['vibes:findBinary']({});

			expect(result).toEqual({ path: '/usr/local/bin/vibecheck', version: null });
		});

		it('should return null path and version when binary not found', async () => {
			mockFindBinary.mockResolvedValue(null);

			const result = await handlers['vibes:findBinary']({});

			expect(result).toEqual({ path: null, version: null });
			expect(mockGetVersion).not.toHaveBeenCalled();
		});

		it('should return null path and version on error', async () => {
			mockFindBinary.mockRejectedValue(new Error('search failed'));

			const result = await handlers['vibes:findBinary']({});

			expect(result).toEqual({ path: null, version: null });
		});
	});

	describe('vibes:clearBinaryCache', () => {
		it('should call clearBinaryPathCache', async () => {
			await handlers['vibes:clearBinaryCache']({});
			expect(mockClearCache).toHaveBeenCalled();
		});
	});

	describe('vibes:backfillCommit', () => {
		it('should call vibesBackfillCommit with project path, commit hash, and session id', async () => {
			mockVibesBackfillCommit.mockResolvedValue({ success: true, updatedCount: 5 });

			const result = await handlers['vibes:backfillCommit']({}, '/project', 'abc123', 'sess-1');

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith('/project', 'abc123', 'sess-1', undefined);
			expect(result).toEqual({ success: true, updatedCount: 5 });
		});

		it('should work without session id', async () => {
			mockVibesBackfillCommit.mockResolvedValue({ success: true, updatedCount: 3 });

			const result = await handlers['vibes:backfillCommit']({}, '/project', 'def456');

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith('/project', 'def456', undefined, undefined);
			expect(result).toEqual({ success: true, updatedCount: 3 });
		});

		it('should return error on failure', async () => {
			mockVibesBackfillCommit.mockRejectedValue(new Error('backfill failed'));

			const result = await handlers['vibes:backfillCommit']({}, '/project', 'abc123');

			expect(result).toEqual({ success: false, updatedCount: 0, error: 'Error: backfill failed' });
		});

		it('should use custom binary path from settings', async () => {
			mockSettingsStore.get.mockReturnValue('/custom/vibecheck');
			mockVibesBackfillCommit.mockResolvedValue({ success: true, updatedCount: 1 });

			await handlers['vibes:backfillCommit']({}, '/project', 'abc123', 'sess-1');

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith('/project', 'abc123', 'sess-1', '/custom/vibecheck');
		});
	});

	describe('custom binary path from settings', () => {
		it('should use custom binary path from settings store', async () => {
			mockSettingsStore.get.mockReturnValue('/opt/vibecheck');
			mockFindBinary.mockResolvedValue('/opt/vibecheck');
			mockVibesStats.mockResolvedValue({ success: true, data: '{}' });

			await handlers['vibes:getStats']({}, '/project');

			expect(mockFindBinary).toHaveBeenCalledWith('/opt/vibecheck');
			expect(mockVibesStats).toHaveBeenCalledWith('/project', undefined, '/opt/vibecheck');
		});

		it('should pass undefined when settings store returns empty string', async () => {
			mockSettingsStore.get.mockReturnValue('');
			mockVibesStats.mockResolvedValue({ success: true, data: '{}' });

			await handlers['vibes:getStats']({}, '/project');

			expect(mockFindBinary).toHaveBeenCalledWith(undefined);
			expect(mockVibesStats).toHaveBeenCalledWith('/project', undefined, undefined);
		});

		it('should prefer vibecheck when binary is available', async () => {
			mockFindBinary.mockResolvedValue('/usr/local/bin/vibecheck');
			mockVibesStats.mockResolvedValue({ success: true, data: '{}' });

			await handlers['vibes:getStats']({}, '/project');

			expect(mockVibesStats).toHaveBeenCalled();
			expect(mockComputeStats).not.toHaveBeenCalled();
		});
	});
});
