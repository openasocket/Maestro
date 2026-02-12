/**
 * VIBES IPC Handlers
 *
 * Provides IPC handlers for VIBES integration:
 * - isInitialized: Check if VIBES is initialized in a project
 * - init: Initialize a VIBES audit directory
 * - build: Rebuild audit manifest from annotations
 * - getStats: Get project statistics
 * - getBlame: Get per-line provenance data
 * - getLog: Get annotation log with filters
 * - getCoverage: Get VIBES coverage statistics
 * - getReport: Generate a VIBES report
 * - getSessions: List all sessions
 * - getModels: List all models used
 * - findBinary: Find the vibescheck binary and return path + version
 * - clearBinaryCache: Clear cached binary path (on settings change)
 */

import { ipcMain } from 'electron';
import type Store from 'electron-store';
import { logger } from '../../utils/logger';
import {
	findVibesCheckBinary,
	getVibesCheckVersion,
	clearBinaryPathCache,
	isVibesInitialized,
	vibesInit,
	vibesBuild,
	vibesStats,
	vibesBlame,
	vibesLog,
	vibesCoverage,
	vibesReport,
	vibesSessions,
	vibesModels,
	vibesBackfillCommit,
} from '../../vibes/vibes-bridge';
import type { VibesAssuranceLevel } from '../../../shared/vibes-types';
import {
	computeStatsFromAnnotations,
	extractSessionsFromAnnotations,
	extractModelsFromManifest,
	computeBlameFromAnnotations,
	computeCoverageFromAnnotations,
	readAnnotations,
	readVibesManifest,
} from '../../vibes/vibes-io';

const LOG_CONTEXT = '[VIBES]';

/**
 * Dependencies required for VIBES handler registration.
 */
export interface VibesHandlerDependencies {
	settingsStore: Store<{ [key: string]: unknown }>;
}

/**
 * Get the custom binary path from the settings store.
 */
function getCustomBinaryPath(settingsStore: Store<{ [key: string]: unknown }>): string | undefined {
	const path = settingsStore.get('vibesCheckBinaryPath', '') as string;
	return path || undefined;
}

/**
 * Register all VIBES IPC handlers.
 */
export function registerVibesHandlers(deps: VibesHandlerDependencies): void {
	const { settingsStore } = deps;

	// Check if VIBES is initialized in a project
	ipcMain.handle('vibes:isInitialized', async (_event, projectPath: string) => {
		try {
			return await isVibesInitialized(projectPath);
		} catch (error) {
			logger.error('isInitialized error', LOG_CONTEXT, { error: String(error) });
			return false;
		}
	});

	// Initialize a VIBES audit directory
	ipcMain.handle(
		'vibes:init',
		async (
			_event,
			projectPath: string,
			config: {
				projectName: string;
				assuranceLevel: VibesAssuranceLevel;
				extensions?: string[];
			},
		) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesInit(projectPath, config, customPath);
			} catch (error) {
				logger.error('init error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		},
	);

	// Get project statistics (falls back to direct file reading when binary unavailable)
	ipcMain.handle('vibes:getStats', async (_event, projectPath: string, file?: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesStats(projectPath, file, customPath);
			}
			// Fallback: compute from raw .ai-audit/ files
			const stats = await computeStatsFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(stats) };
		} catch (error) {
			logger.error('getStats error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get per-line provenance data (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getBlame', async (_event, projectPath: string, file: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesBlame(projectPath, file, customPath);
			}
			// Fallback: compute blame from raw annotations
			const blame = await computeBlameFromAnnotations(projectPath, file);
			return { success: true, data: JSON.stringify(blame) };
		} catch (error) {
			logger.error('getBlame error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Get annotation log with filters (falls back to direct file reading)
	ipcMain.handle(
		'vibes:getLog',
		async (
			_event,
			projectPath: string,
			options?: {
				file?: string;
				model?: string;
				session?: string;
				limit?: number;
				json?: boolean;
			},
		) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				const binaryPath = await findVibesCheckBinary(customPath);
				if (binaryPath) {
					return await vibesLog(projectPath, options, customPath);
				}
				// Fallback: read annotations directly and apply filters
				let annotations = await readAnnotations(projectPath);
				if (options?.file) {
					annotations = annotations.filter((a) => 'file_path' in a && a.file_path === options.file);
				}
				if (options?.session) {
					annotations = annotations.filter((a) => 'session_id' in a && a.session_id === options.session);
				}
				if (options?.limit && options.limit > 0) {
					annotations = annotations.slice(-options.limit);
				}
				return { success: true, data: JSON.stringify(annotations) };
			} catch (error) {
				logger.error('getLog error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		},
	);

	// Get VIBES coverage statistics (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getCoverage', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesCoverage(projectPath, true, customPath);
			}
			// Fallback: compute coverage from raw annotations
			const coverage = await computeCoverageFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(coverage) };
		} catch (error) {
			logger.error('getCoverage error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Generate a VIBES report
	ipcMain.handle(
		'vibes:getReport',
		async (_event, projectPath: string, format?: 'markdown' | 'html' | 'json') => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesReport(projectPath, format, customPath);
			} catch (error) {
				logger.error('getReport error', LOG_CONTEXT, { error: String(error) });
				return { success: false, error: String(error) };
			}
		},
	);

	// List all sessions (falls back to direct annotation parsing)
	ipcMain.handle('vibes:getSessions', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesSessions(projectPath, customPath);
			}
			// Fallback: extract sessions from raw annotations
			const sessions = await extractSessionsFromAnnotations(projectPath);
			return { success: true, data: JSON.stringify(sessions) };
		} catch (error) {
			logger.error('getSessions error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// List all models used (falls back to direct manifest reading)
	ipcMain.handle('vibes:getModels', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			const binaryPath = await findVibesCheckBinary(customPath);
			if (binaryPath) {
				return await vibesModels(projectPath, customPath);
			}
			// Fallback: extract models from raw manifest
			const models = await extractModelsFromManifest(projectPath);
			return { success: true, data: JSON.stringify(models) };
		} catch (error) {
			logger.error('getModels error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Rebuild audit manifest from annotations
	ipcMain.handle('vibes:build', async (_event, projectPath: string) => {
		try {
			const customPath = getCustomBinaryPath(settingsStore);
			return await vibesBuild(projectPath, customPath);
		} catch (error) {
			logger.error('build error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Find the vibescheck binary — returns { path, version } or { path: null, version: null }
	ipcMain.handle('vibes:findBinary', async (_event, customPath?: string) => {
		try {
			const binaryPath = await findVibesCheckBinary(customPath);
			if (!binaryPath) {
				return { path: null, version: null };
			}
			const version = await getVibesCheckVersion(binaryPath);
			return { path: binaryPath, version };
		} catch (error) {
			logger.error('findBinary error', LOG_CONTEXT, { error: String(error) });
			return { path: null, version: null };
		}
	});

	// Clear the binary path cache (called when settings change)
	ipcMain.handle('vibes:clearBinaryCache', async () => {
		clearBinaryPathCache();
	});

	// Get the manifest (resolved provenance entries keyed by content hash)
	ipcMain.handle('vibes:getManifest', async (_event, projectPath: string) => {
		try {
			const manifest = await readVibesManifest(projectPath);
			return { success: true, data: JSON.stringify(manifest) };
		} catch (error) {
			logger.error('getManifest error', LOG_CONTEXT, { error: String(error) });
			return { success: false, error: String(error) };
		}
	});

	// Backfill commit_hash on annotations missing it
	ipcMain.handle(
		'vibes:backfillCommit',
		async (
			_event,
			projectPath: string,
			commitHash: string,
			sessionId?: string,
		) => {
			try {
				const customPath = getCustomBinaryPath(settingsStore);
				return await vibesBackfillCommit(projectPath, commitHash, sessionId, customPath);
			} catch (error) {
				logger.error('backfillCommit error', LOG_CONTEXT, { error: String(error) });
				return { success: false, updatedCount: 0, error: String(error) };
			}
		},
	);
}
