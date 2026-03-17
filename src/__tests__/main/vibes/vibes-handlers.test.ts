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
	mockReadVibesConfig,
	mockWriteVibesConfig,
	mockRehashManifest,
	mockGenerateKeyPair,
	mockSaveUserKeyPair,
	mockGetUserKeyInfo,
	mockCheckKeyPermissions,
	mockExportPublicKey,
	mockLoadUserKeyPair,
	mockBuildInTotoStatement,
	mockBuildDSSEEnvelope,
	mockComputeAttestationId,
	mockComputePAE,
	mockVerifyPAESignature,
	mockFetchProviderKeys,
	mockRequestCosignature,
	mockComputePAEHash,
	mockVerifyProviderSignature,
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
	mockReadVibesConfig: vi.fn(),
	mockWriteVibesConfig: vi.fn(),
	mockRehashManifest: vi.fn(),
	mockGenerateKeyPair: vi.fn(),
	mockSaveUserKeyPair: vi.fn(),
	mockGetUserKeyInfo: vi.fn(),
	mockCheckKeyPermissions: vi.fn(),
	mockExportPublicKey: vi.fn(),
	mockLoadUserKeyPair: vi.fn(),
	mockBuildInTotoStatement: vi.fn(),
	mockBuildDSSEEnvelope: vi.fn(),
	mockComputeAttestationId: vi.fn(),
	mockComputePAE: vi.fn(),
	mockVerifyPAESignature: vi.fn(),
	mockFetchProviderKeys: vi.fn(),
	mockRequestCosignature: vi.fn(),
	mockComputePAEHash: vi.fn(),
	mockVerifyProviderSignature: vi.fn(),
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

// Mock vibes-key-manager
vi.mock('../../../main/vibes/vibes-key-manager', () => ({
	generateKeyPair: mockGenerateKeyPair,
	saveUserKeyPair: mockSaveUserKeyPair,
	getUserKeyInfo: mockGetUserKeyInfo,
	checkKeyPermissions: mockCheckKeyPermissions,
	exportPublicKey: mockExportPublicKey,
	loadUserKeyPair: mockLoadUserKeyPair,
	buildInTotoStatement: mockBuildInTotoStatement,
	buildDSSEEnvelope: mockBuildDSSEEnvelope,
	computeAttestationId: mockComputeAttestationId,
	computePAE: mockComputePAE,
	verifyPAESignature: mockVerifyPAESignature,
}));

// Mock vibes-cosign-service
vi.mock('../../../main/vibes/vibes-cosign-service', () => ({
	fetchProviderKeys: mockFetchProviderKeys,
	requestCosignature: mockRequestCosignature,
	computePAEHash: mockComputePAEHash,
	verifyProviderSignature: mockVerifyProviderSignature,
}));

// Mock vibes-io fallback functions
vi.mock('../../../main/vibes/vibes-io', () => ({
	computeStatsFromAnnotations: mockComputeStats,
	extractSessionsFromAnnotations: mockExtractSessions,
	extractModelsFromManifest: mockExtractModels,
	computeBlameFromAnnotations: mockComputeBlame,
	computeCoverageFromAnnotations: mockComputeCoverage,
	readAnnotations: mockReadAnnotations,
	readVibesConfig: mockReadVibesConfig,
	writeVibesConfig: mockWriteVibesConfig,
	rehashManifest: mockRehashManifest,
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
		mockIpcMainHandle.mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				handlers[channel] = handler;
			}
		);

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
		it('should register all 26 VIBES IPC handlers', () => {
			expect(mockIpcMainHandle).toHaveBeenCalledTimes(26);
		});

		it('should register handlers with correct channel names', () => {
			const expectedChannels = [
				'vibes:isInitialized',
				'vibes:init',
				'vibes:getStats',
				'vibes:getBlame',
				'vibes:getLog',
				'vibes:getCoverage',
				'vibes:getLocCoverage',
				'vibes:getReport',
				'vibes:getSessions',
				'vibes:getModels',
				'vibes:build',
				'vibes:rehash',
				'vibes:validateDelegationChain',
				'vibes:updateConfig',
				'vibes:findBinary',
				'vibes:clearBinaryCache',
				'vibes:getManifest',
				'vibes:backfillCommit',
				'vibes:decompress-reasoning',
				// VERIFY spec: Key Management & Attestation
				'vibes:keygen',
				'vibes:getKeyInfo',
				'vibes:checkKeyPermissions',
				'vibes:exportPublicKey',
				'vibes:attest',
				'vibes:verifyAttestation',
				'vibes:getProviderKeys',
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
		it('should compute stats from annotations directly', async () => {
			mockComputeStats.mockResolvedValue({
				total_annotations: 10,
				files_covered: 3,
				total_tracked_files: 3,
				coverage_percent: 100,
				active_sessions: 1,
				contributing_models: 2,
				assurance_level: 'high',
			});

			const result = await handlers['vibes:getStats']({}, '/project');

			expect(mockComputeStats).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"total_annotations":10'),
			});
		});

		it('should return error on failure', async () => {
			mockComputeStats.mockRejectedValue(new Error('stats failed'));

			const result = await handlers['vibes:getStats']({}, '/project');

			expect(result).toEqual({ success: false, error: 'Error: stats failed' });
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
				{
					line_start: 1,
					line_end: 10,
					action: 'create',
					model_name: 'claude-4',
					model_version: 'opus',
					tool_name: 'claude-code',
					timestamp: '2026-02-10T12:00:00Z',
				},
			]);

			const result = await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockVibesBlame).not.toHaveBeenCalled();
			expect(mockComputeBlame).toHaveBeenCalledWith('/project', 'src/index.ts');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"line_start":1'),
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
				{ file_path: 'src/a.ts', coverage_status: 'full', annotation_count: 10 },
			]);

			const result = await handlers['vibes:getCoverage']({}, '/project');

			expect(mockVibesCoverage).not.toHaveBeenCalled();
			expect(mockComputeCoverage).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"coverage_status":"full"'),
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
				{
					session_id: 'sess-1',
					event: 'start',
					timestamp: '2026-02-10T12:00:00Z',
					annotation_count: 5,
				},
			]);

			const result = await handlers['vibes:getSessions']({}, '/project');

			expect(mockVibesSessions).not.toHaveBeenCalled();
			expect(mockExtractSessions).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"session_id":"sess-1"'),
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
				{
					model_name: 'claude-4',
					model_version: 'opus',
					tool_name: 'claude-code',
					annotation_count: 10,
					percentage: 100,
				},
			]);

			const result = await handlers['vibes:getModels']({}, '/project');

			expect(mockVibesModels).not.toHaveBeenCalled();
			expect(mockExtractModels).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: expect.stringContaining('"model_name":"claude-4"'),
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

	describe('vibes:rehash', () => {
		it('should call rehashManifest and return success with data', async () => {
			mockRehashManifest.mockResolvedValue({ rehashedEntries: 3, updatedAnnotations: 5 });

			const result = await handlers['vibes:rehash']({}, '/project');

			expect(mockRehashManifest).toHaveBeenCalledWith('/project');
			expect(result).toEqual({
				success: true,
				data: JSON.stringify({ rehashedEntries: 3, updatedAnnotations: 5 }),
			});
		});

		it('should return success with zero counts when nothing to rehash', async () => {
			mockRehashManifest.mockResolvedValue({ rehashedEntries: 0, updatedAnnotations: 0 });

			const result = await handlers['vibes:rehash']({}, '/project');

			expect(result).toEqual({
				success: true,
				data: JSON.stringify({ rehashedEntries: 0, updatedAnnotations: 0 }),
			});
		});

		it('should return error on failure', async () => {
			mockRehashManifest.mockRejectedValue(new Error('rehash failed'));

			const result = await handlers['vibes:rehash']({}, '/project');

			expect(result).toEqual({ success: false, error: 'Error: rehash failed' });
		});
	});

	describe('vibes:updateConfig', () => {
		const existingConfig = {
			standard: 'VIBES' as const,
			standard_version: '1.0' as const,
			assurance_level: 'medium' as const,
			project_name: 'test-project',
			tracked_extensions: ['.ts', '.js'],
			exclude_patterns: ['node_modules'],
			compress_reasoning_threshold_bytes: 1024,
			external_blob_threshold_bytes: 4096,
		};

		it('should merge updates into existing config and write it', async () => {
			mockReadVibesConfig.mockResolvedValue({ ...existingConfig });
			mockWriteVibesConfig.mockResolvedValue(undefined);

			const result = await handlers['vibes:updateConfig']({}, '/project', {
				assurance_level: 'high',
			});

			expect(mockReadVibesConfig).toHaveBeenCalledWith('/project');
			expect(mockWriteVibesConfig).toHaveBeenCalledWith('/project', {
				...existingConfig,
				assurance_level: 'high',
			});
			expect(result).toEqual({ success: true });
		});

		it('should return error when no config exists', async () => {
			mockReadVibesConfig.mockResolvedValue(null);

			const result = await handlers['vibes:updateConfig']({}, '/project', {
				assurance_level: 'high',
			});

			expect(result).toEqual({
				success: false,
				error: 'No VIBES config found. Initialize VIBES first.',
			});
			expect(mockWriteVibesConfig).not.toHaveBeenCalled();
		});

		it('should return error on exception', async () => {
			mockReadVibesConfig.mockRejectedValue(new Error('disk error'));

			const result = await handlers['vibes:updateConfig']({}, '/project', {
				assurance_level: 'high',
			});

			expect(result).toEqual({ success: false, error: 'Error: disk error' });
		});

		it('should support updating tracked_extensions', async () => {
			mockReadVibesConfig.mockResolvedValue({ ...existingConfig });
			mockWriteVibesConfig.mockResolvedValue(undefined);

			const result = await handlers['vibes:updateConfig']({}, '/project', {
				tracked_extensions: ['.ts', '.tsx', '.js', '.jsx'],
			});

			expect(mockWriteVibesConfig).toHaveBeenCalledWith('/project', {
				...existingConfig,
				tracked_extensions: ['.ts', '.tsx', '.js', '.jsx'],
			});
			expect(result).toEqual({ success: true });
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

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith(
				'/project',
				'abc123',
				'sess-1',
				undefined
			);
			expect(result).toEqual({ success: true, updatedCount: 5 });
		});

		it('should work without session id', async () => {
			mockVibesBackfillCommit.mockResolvedValue({ success: true, updatedCount: 3 });

			const result = await handlers['vibes:backfillCommit']({}, '/project', 'def456');

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith(
				'/project',
				'def456',
				undefined,
				undefined
			);
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

			expect(mockVibesBackfillCommit).toHaveBeenCalledWith(
				'/project',
				'abc123',
				'sess-1',
				'/custom/vibecheck'
			);
		});
	});

	describe('custom binary path from settings', () => {
		it('should use custom binary path from settings store for blame', async () => {
			mockSettingsStore.get.mockReturnValue('/opt/vibecheck');
			mockFindBinary.mockResolvedValue('/opt/vibecheck');
			mockVibesBlame.mockResolvedValue({ success: true, data: '[]' });

			await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockFindBinary).toHaveBeenCalledWith('/opt/vibecheck');
			expect(mockVibesBlame).toHaveBeenCalledWith('/project', 'src/index.ts', '/opt/vibecheck');
		});

		it('should pass undefined when settings store returns empty string for blame', async () => {
			mockSettingsStore.get.mockReturnValue('');
			mockFindBinary.mockResolvedValue(null);
			mockComputeBlame.mockResolvedValue([]);

			await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockFindBinary).toHaveBeenCalledWith(undefined);
		});

		it('should prefer vibecheck when binary is available for blame', async () => {
			mockFindBinary.mockResolvedValue('/usr/local/bin/vibecheck');
			mockVibesBlame.mockResolvedValue({ success: true, data: '[]' });

			await handlers['vibes:getBlame']({}, '/project', 'src/index.ts');

			expect(mockVibesBlame).toHaveBeenCalled();
			expect(mockComputeBlame).not.toHaveBeenCalled();
		});
	});

	// ========================================================================
	// VERIFY Spec: Key Management & Attestation Handlers
	// ========================================================================

	describe('vibes:keygen', () => {
		it('should generate a keypair, save it, and return key info', async () => {
			const mockKeyPair = {
				publicKey: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
				privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
				keyId: 'abcdef0123456789',
			};
			mockGenerateKeyPair.mockReturnValue(mockKeyPair);
			mockSaveUserKeyPair.mockResolvedValue(undefined);

			const result = await handlers['vibes:keygen']({});

			expect(mockGenerateKeyPair).toHaveBeenCalled();
			expect(mockSaveUserKeyPair).toHaveBeenCalledWith(mockKeyPair);
			expect(result).toEqual({
				success: true,
				data: {
					publicKey: mockKeyPair.publicKey,
					keyId: mockKeyPair.keyId,
					exists: true,
				},
			});
		});

		it('should return error on failure', async () => {
			mockGenerateKeyPair.mockImplementation(() => {
				throw new Error('crypto failed');
			});

			const result = await handlers['vibes:keygen']({});

			expect(result).toEqual({ success: false, error: 'Error: crypto failed' });
		});
	});

	describe('vibes:getKeyInfo', () => {
		it('should return user key info', async () => {
			const keyInfo = {
				publicKey: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
				keyId: 'abcdef0123456789',
				exists: true,
			};
			mockGetUserKeyInfo.mockResolvedValue(keyInfo);

			const result = await handlers['vibes:getKeyInfo']({});

			expect(mockGetUserKeyInfo).toHaveBeenCalled();
			expect(result).toEqual({ success: true, data: keyInfo });
		});

		it('should return key info with exists=false when no keys', async () => {
			mockGetUserKeyInfo.mockResolvedValue({ publicKey: '', keyId: '', exists: false });

			const result = await handlers['vibes:getKeyInfo']({});

			expect(result).toEqual({
				success: true,
				data: { publicKey: '', keyId: '', exists: false },
			});
		});

		it('should return error on failure', async () => {
			mockGetUserKeyInfo.mockRejectedValue(new Error('fs error'));

			const result = await handlers['vibes:getKeyInfo']({});

			expect(result).toEqual({ success: false, error: 'Error: fs error' });
		});
	});

	describe('vibes:checkKeyPermissions', () => {
		it('should return permission check result', async () => {
			mockCheckKeyPermissions.mockResolvedValue({ valid: true });

			const result = await handlers['vibes:checkKeyPermissions']({});

			expect(mockCheckKeyPermissions).toHaveBeenCalled();
			expect(result).toEqual({ success: true, data: { valid: true } });
		});

		it('should return invalid with message', async () => {
			mockCheckKeyPermissions.mockResolvedValue({
				valid: false,
				message: 'Permissions are 644, expected 600',
			});

			const result = await handlers['vibes:checkKeyPermissions']({});

			expect(result).toEqual({
				success: true,
				data: { valid: false, message: 'Permissions are 644, expected 600' },
			});
		});

		it('should return error on failure', async () => {
			mockCheckKeyPermissions.mockRejectedValue(new Error('stat failed'));

			const result = await handlers['vibes:checkKeyPermissions']({});

			expect(result).toEqual({ success: false, error: 'Error: stat failed' });
		});
	});

	describe('vibes:exportPublicKey', () => {
		it('should export public key in PEM format', async () => {
			const pemKey = '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
			mockGetUserKeyInfo.mockResolvedValue({ publicKey: pemKey, keyId: 'abc123', exists: true });
			mockExportPublicKey.mockReturnValue(pemKey);

			const result = await handlers['vibes:exportPublicKey']({}, 'pem');

			expect(mockExportPublicKey).toHaveBeenCalledWith(pemKey, 'pem');
			expect(result).toEqual({ success: true, data: pemKey });
		});

		it('should export public key in SSH format', async () => {
			const pemKey = '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----';
			const sshKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAtest';
			mockGetUserKeyInfo.mockResolvedValue({ publicKey: pemKey, keyId: 'abc123', exists: true });
			mockExportPublicKey.mockReturnValue(sshKey);

			const result = await handlers['vibes:exportPublicKey']({}, 'ssh');

			expect(mockExportPublicKey).toHaveBeenCalledWith(pemKey, 'ssh');
			expect(result).toEqual({ success: true, data: sshKey });
		});

		it('should return error when no keypair exists', async () => {
			mockGetUserKeyInfo.mockResolvedValue({ publicKey: '', keyId: '', exists: false });

			const result = await handlers['vibes:exportPublicKey']({}, 'pem');

			expect(result).toEqual({ success: false, error: 'No keypair found. Run keygen first.' });
			expect(mockExportPublicKey).not.toHaveBeenCalled();
		});

		it('should return error on failure', async () => {
			mockGetUserKeyInfo.mockRejectedValue(new Error('read failed'));

			const result = await handlers['vibes:exportPublicKey']({}, 'pem');

			expect(result).toEqual({ success: false, error: 'Error: read failed' });
		});
	});

	describe('vibes:attest', () => {
		const mockKeyPair = {
			publicKey: 'pub-key',
			privateKey: 'priv-key',
			keyId: 'abcdef0123456789',
		};

		const mockStatement = {
			_type: 'https://in-toto.io/Statement/v1',
			subject: [],
			predicateType: 'https://itsavibe.ai/vibes/attestation/v1',
			predicate: {
				validation: { result: 'PASS', version: '1.0.0' },
				project: { name: 'test', assurance_level: 'high' },
				stats: { total_annotations: 5, unique_models: 2 },
			},
		};

		const mockEnvelope = {
			payloadType: 'application/vnd.in-toto+json',
			payload: 'base64url-payload',
			signatures: [{ keyid: 'abcdef0123456789', sig: 'sig-data', keytype: 'user' }],
		};

		it('should build an attestation envelope without cosigning', async () => {
			mockLoadUserKeyPair.mockResolvedValue(mockKeyPair);
			mockBuildInTotoStatement.mockResolvedValue(mockStatement);
			mockBuildDSSEEnvelope.mockResolvedValue(mockEnvelope);
			mockComputeAttestationId.mockReturnValue('attestation-id-hash');

			const result = await handlers['vibes:attest']({}, '/project');

			expect(mockLoadUserKeyPair).toHaveBeenCalled();
			expect(mockBuildInTotoStatement).toHaveBeenCalledWith('/project', 'PASS', '1.0.0');
			expect(mockBuildDSSEEnvelope).toHaveBeenCalledWith(mockStatement, mockKeyPair, undefined);
			expect(result).toEqual({
				success: true,
				data: {
					envelope: mockEnvelope,
					attestationId: 'attestation-id-hash',
					statement: mockStatement,
					trustTier: 'self-attested',
				},
			});
		});

		it('should build an attestation envelope with cosigning', async () => {
			const cosignResponse = {
				keyid: 'provider-key-id',
				sig: 'provider-sig',
				keytype: 'tool_provider' as const,
			};
			mockLoadUserKeyPair.mockResolvedValue(mockKeyPair);
			mockBuildInTotoStatement.mockResolvedValue(mockStatement);
			mockComputePAE.mockReturnValue(Buffer.from('pae-bytes'));
			mockComputePAEHash.mockReturnValue('pae-hash');
			mockRequestCosignature.mockResolvedValue(cosignResponse);
			mockBuildDSSEEnvelope.mockResolvedValue({
				...mockEnvelope,
				signatures: [...mockEnvelope.signatures, cosignResponse],
			});
			mockComputeAttestationId.mockReturnValue('attestation-id-cosigned');

			const result = await handlers['vibes:attest']({}, '/project', { cosign: true });

			expect(mockComputePAEHash).toHaveBeenCalled();
			expect(mockRequestCosignature).toHaveBeenCalledWith('pae-hash');
			expect(mockBuildDSSEEnvelope).toHaveBeenCalledWith(
				mockStatement,
				mockKeyPair,
				cosignResponse
			);
			expect(result).toEqual({
				success: true,
				data: expect.objectContaining({ trustTier: 'tool-corroborated' }),
			});
		});

		it('should return error when no keypair exists', async () => {
			mockLoadUserKeyPair.mockResolvedValue(null);

			const result = await handlers['vibes:attest']({}, '/project');

			expect(result).toEqual({
				success: false,
				error: 'No keypair found. Run keygen first.',
			});
		});

		it('should pass custom validation result and version', async () => {
			mockLoadUserKeyPair.mockResolvedValue(mockKeyPair);
			mockBuildInTotoStatement.mockResolvedValue(mockStatement);
			mockBuildDSSEEnvelope.mockResolvedValue(mockEnvelope);
			mockComputeAttestationId.mockReturnValue('id');

			await handlers['vibes:attest']({}, '/project', {
				validationResult: 'FAIL',
				vibesVersion: '2.0.0',
			});

			expect(mockBuildInTotoStatement).toHaveBeenCalledWith('/project', 'FAIL', '2.0.0');
		});

		it('should return error on failure', async () => {
			mockLoadUserKeyPair.mockRejectedValue(new Error('key read failed'));

			const result = await handlers['vibes:attest']({}, '/project');

			expect(result).toEqual({ success: false, error: 'Error: key read failed' });
		});
	});

	describe('vibes:verifyAttestation', () => {
		const mockEnvelope = {
			payloadType: 'application/vnd.in-toto+json',
			payload: Buffer.from(
				JSON.stringify({
					_type: 'https://in-toto.io/Statement/v1',
					subject: [],
					predicateType: 'https://itsavibe.ai/vibes/attestation/v1',
					predicate: {
						validation: { result: 'PASS', version: '1.0.0' },
						project: { name: 'test', assurance_level: 'high' },
						stats: { total_annotations: 0, unique_models: 0 },
					},
				})
			).toString('base64url'),
			signatures: [{ keyid: 'user-key-id', sig: 'user-sig', keytype: 'user' }],
		};

		it('should verify user signature successfully', async () => {
			mockComputePAE.mockReturnValue(Buffer.from('pae-bytes'));
			mockGetUserKeyInfo.mockResolvedValue({
				publicKey: 'pub-key',
				keyId: 'user-key-id',
				exists: true,
			});
			mockVerifyPAESignature.mockReturnValue(true);

			const result = await handlers['vibes:verifyAttestation']({}, '/project', mockEnvelope);

			expect(result.success).toBe(true);
			expect(result.data.signatures[0].valid).toBe(true);
			expect(result.data.allSignaturesValid).toBe(true);
		});

		it('should detect invalid user signature', async () => {
			mockComputePAE.mockReturnValue(Buffer.from('pae-bytes'));
			mockGetUserKeyInfo.mockResolvedValue({
				publicKey: 'pub-key',
				keyId: 'user-key-id',
				exists: true,
			});
			mockVerifyPAESignature.mockReturnValue(false);

			const result = await handlers['vibes:verifyAttestation']({}, '/project', mockEnvelope);

			expect(result.success).toBe(true);
			expect(result.data.signatures[0].valid).toBe(false);
			expect(result.data.allSignaturesValid).toBe(false);
		});

		it('should verify tool provider signature', async () => {
			const envelopeWithToolSig = {
				...mockEnvelope,
				signatures: [{ keyid: 'provider-key-id', sig: 'tool-sig', keytype: 'tool_provider' }],
			};

			mockComputePAE.mockReturnValue(Buffer.from('pae-bytes'));
			mockVerifyProviderSignature.mockResolvedValue(true);

			const result = await handlers['vibes:verifyAttestation']({}, '/project', envelopeWithToolSig);

			expect(result.success).toBe(true);
			expect(result.data.signatures[0].keytype).toBe('tool_provider');
			expect(result.data.signatures[0].valid).toBe(true);
		});

		it('should report key ID mismatch for user signature', async () => {
			mockComputePAE.mockReturnValue(Buffer.from('pae-bytes'));
			mockGetUserKeyInfo.mockResolvedValue({
				publicKey: 'pub-key',
				keyId: 'different-key-id',
				exists: true,
			});

			const result = await handlers['vibes:verifyAttestation']({}, '/project', mockEnvelope);

			expect(result.success).toBe(true);
			expect(result.data.signatures[0].valid).toBe(false);
			expect(result.data.signatures[0].error).toContain('key ID mismatch');
		});

		it('should return error on failure', async () => {
			mockComputePAE.mockImplementation(() => {
				throw new Error('PAE computation failed');
			});

			const result = await handlers['vibes:verifyAttestation']({}, '/project', mockEnvelope);

			expect(result).toEqual({ success: false, error: 'Error: PAE computation failed' });
		});
	});

	describe('vibes:getProviderKeys', () => {
		it('should return provider keys', async () => {
			const bundle = {
				provider: 'Maestro',
				tool_name: 'Maestro',
				keys: [{ keyid: 'abc', algorithm: 'Ed25519', status: 'active' }],
				rotation_policy: '90 days',
			};
			mockFetchProviderKeys.mockResolvedValue(bundle);

			const result = await handlers['vibes:getProviderKeys']({});

			expect(mockFetchProviderKeys).toHaveBeenCalled();
			expect(result).toEqual({ success: true, data: bundle });
		});

		it('should return null data when offline', async () => {
			mockFetchProviderKeys.mockResolvedValue(null);

			const result = await handlers['vibes:getProviderKeys']({});

			expect(result).toEqual({ success: true, data: null });
		});

		it('should return error on failure', async () => {
			mockFetchProviderKeys.mockRejectedValue(new Error('network error'));

			const result = await handlers['vibes:getProviderKeys']({});

			expect(result).toEqual({ success: false, error: 'Error: network error' });
		});
	});
});
