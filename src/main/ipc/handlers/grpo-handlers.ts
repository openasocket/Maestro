/**
 * IPC handlers for Training-Free GRPO system.
 * Registered via registerAllHandlers() in ipc/handlers/index.ts.
 *
 * Pattern: follows src/main/ipc/handlers/stats.ts — dependency injection via
 * interface, withIpcErrorLogging wrapper, consistent { success, data, error } responses.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { ExperienceStore } from '../../grpo/experience-store';
import { SymphonyCollector, initializeSymphonyCollector, getSymphonyCollector } from '../../grpo/symphony-collector';
import {
	collectAllRewards,
	detectProjectCommands,
} from '../../grpo/reward-collector';
import { getModelStatus, getCacheDir, preloadModel, setDownloadProgressCallback, dispose as disposeEmbedding, isModelCached } from '../../grpo/embedding-service';
import type { EmbeddingModelStatus } from '../../grpo/embedding-service';
import type {
	ExperienceEntry,
	ExperienceScope,
	GRPOConfig,
	GRPOStats,
	BatchCollectionResult,
} from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

const LOG_CONTEXT = '[GRPO]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface GRPOHandlerDependencies {
	experienceStore: ExperienceStore;
	symphonyCollector?: SymphonyCollector;
	settingsStore: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
}

const GRPO_CONFIG_KEY = 'grpoConfig';

/**
 * Read the GRPO config from settings, applying defaults for missing fields.
 */
function readConfig(settingsStore: GRPOHandlerDependencies['settingsStore']): GRPOConfig {
	const stored = settingsStore.get(GRPO_CONFIG_KEY) as Partial<GRPOConfig> | undefined;
	return { ...GRPO_CONFIG_DEFAULTS, ...stored };
}

export function registerGRPOHandlers(deps: GRPOHandlerDependencies): void {
	const { experienceStore, settingsStore } = deps;

	// Get GRPO config from settings store
	ipcMain.handle(
		'grpo:getConfig',
		withIpcErrorLogging(handlerOpts('getConfig'), async () => {
			const config = readConfig(settingsStore);
			return { success: true, data: config };
		})
	);

	// Update GRPO config (partial merge) — detects toggle transitions and triggers initialization/disposal
	ipcMain.handle(
		'grpo:setConfig',
		withIpcErrorLogging(handlerOpts('setConfig'), async (config: Partial<GRPOConfig>) => {
			const previous = readConfig(settingsStore);
			const merged = { ...previous, ...config };
			settingsStore.set(GRPO_CONFIG_KEY, merged);

			const wasEnabled = previous.enabled;
			const isEnabled = merged.enabled;
			const modelChanged = previous.embeddingModel !== merged.embeddingModel;

			// GRPO just toggled ON (or embedding model changed while enabled) — initialize subsystems
			if (isEnabled && (!wasEnabled || modelChanged)) {
				// Initialize SymphonyCollector (idempotent via singleton)
				initializeSymphonyCollector(merged).catch(err => {
					logger.warn(`[GRPO] Failed to initialize symphony collector on toggle: ${err}`, LOG_CONTEXT);
				});

				// Update symphonyCollector reference in handler deps
				// (it was undefined when registered at startup because GRPO was disabled)
				deps.symphonyCollector = getSymphonyCollector(merged);

				// Check if the model is already cached and valid before downloading
				const modelId = merged.embeddingModel ?? 'multilingual';
				const cached = isModelCached(modelId);

				if (cached) {
					logger.info(`[GRPO] Embedding model '${modelId}' already cached, loading from disk`, LOG_CONTEXT);
				} else {
					logger.info(`[GRPO] Embedding model '${modelId}' not cached or invalid, downloading`, LOG_CONTEXT);
					// Only wire download progress if we're actually downloading
					setDownloadProgressCallback((info) => {
						try {
							const win = BrowserWindow.getAllWindows()[0];
							if (win && !win.isDestroyed()) {
								win.webContents.send('grpo:model-download-progress', info);
							}
						} catch { /* ignore if no window */ }
					});
				}

				// Load from cache or download+load (fire-and-forget)
				preloadModel(modelId).then(() => {
					logger.info(`[GRPO] Embedding model '${modelId}' ready`, LOG_CONTEXT);
					setDownloadProgressCallback(null);
					// Notify renderer that load is complete
					try {
						const win = BrowserWindow.getAllWindows()[0];
						if (win && !win.isDestroyed()) {
							win.webContents.send('grpo:model-download-progress', { progress: 100, done: true });
						}
					} catch { /* ignore */ }
				}).catch(err => {
					logger.warn(`[GRPO] Failed to preload embedding model on toggle: ${err}`, LOG_CONTEXT);
					setDownloadProgressCallback(null);
				});
			}

			// GRPO just toggled OFF — dispose embedding model to free resources
			if (!isEnabled && wasEnabled) {
				disposeEmbedding().catch(err => {
					logger.warn(`[GRPO] Failed to dispose embedding on toggle off: ${err}`, LOG_CONTEXT);
				});
			}

			// Update collector config if it exists
			if (deps.symphonyCollector) {
				deps.symphonyCollector.setConfig(merged);
			}

			return { success: true };
		})
	);

	// Get experience library for a project
	ipcMain.handle(
		'grpo:getLibrary',
		withIpcErrorLogging(handlerOpts('getLibrary'), async (projectPath: string, scope?: ExperienceScope) => {
			const entries = await experienceStore.getLibrary(projectPath, scope);
			return { success: true, data: entries };
		})
	);

	// Manually add an experience entry
	ipcMain.handle(
		'grpo:addExperience',
		withIpcErrorLogging(
			handlerOpts('addExperience'),
			async (projectPath: string, entry: Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt' | 'useCount' | 'tokenEstimate'>) => {
				const created = await experienceStore.addExperience(projectPath, entry);
				return { success: true, data: created };
			}
		)
	);

	// Edit an existing experience
	ipcMain.handle(
		'grpo:modifyExperience',
		withIpcErrorLogging(
			handlerOpts('modifyExperience'),
			async (projectPath: string, id: string, updates: Partial<Pick<ExperienceEntry, 'content' | 'category'>>) => {
				const modified = await experienceStore.modifyExperience(projectPath, id, updates);
				return { success: true, data: modified };
			}
		)
	);

	// Delete an experience entry
	ipcMain.handle(
		'grpo:deleteExperience',
		withIpcErrorLogging(handlerOpts('deleteExperience'), async (projectPath: string, id: string) => {
			await experienceStore.deleteExperience(projectPath, id);
			return { success: true };
		})
	);

	// Get mutation history for a project
	ipcMain.handle(
		'grpo:getHistory',
		withIpcErrorLogging(handlerOpts('getHistory'), async (projectPath: string, limit?: number) => {
			const history = await experienceStore.getHistory(projectPath, limit);
			return { success: true, data: history };
		})
	);

	// Trigger reward collection for a completed agent run
	ipcMain.handle(
		'grpo:collectRewards',
		withIpcErrorLogging(
			handlerOpts('collectRewards'),
			async (projectPath: string, exitCode: number, agentOutput: string) => {
				const config = readConfig(settingsStore);
				const commands = await detectProjectCommands(projectPath);
				const signals = await collectAllRewards(
					projectPath,
					exitCode,
					agentOutput,
					config,
					commands,
				);
				return { success: true, data: signals };
			}
		)
	);

	// Get GRPO stats for dashboard display
	ipcMain.handle(
		'grpo:getStats',
		withIpcErrorLogging(handlerOpts('getStats'), async (projectPath: string) => {
			const entries = await experienceStore.getLibrary(projectPath);
			const history = await experienceStore.getHistory(projectPath);

			// Compute stats from library and history
			let addCount = 0;
			let modifyCount = 0;
			let deleteCount = 0;
			for (const h of history) {
				if (h.operation === 'add') addCount++;
				else if (h.operation === 'modify') modifyCount++;
				else if (h.operation === 'delete') deleteCount++;
			}

			const stats: GRPOStats = {
				totalRolloutGroups: 0,
				totalRollouts: 0,
				librarySize: entries.length,
				currentEpoch: 0,
				overallMeanReward: 0,
				latestEpochMeanReward: 0,
				rewardTrend: 0,
				totalOperations: { add: addCount, modify: modifyCount, delete: deleteCount },
				totalGRPOTokens: 0,
				epochs: [],
				recentRolloutGroups: [],
			};

			return { success: true, data: stats };
		})
	);

	// Manually trigger library pruning
	ipcMain.handle(
		'grpo:pruneLibrary',
		withIpcErrorLogging(handlerOpts('pruneLibrary'), async (projectPath: string) => {
			const config = readConfig(settingsStore);
			// Use epoch 0 as default — actual epoch tracking lives in the training loop
			const pruned = await experienceStore.pruneStaleExperiences(
				projectPath,
				0,
				config.pruneAfterEpochs,
			);
			return { success: true, data: pruned };
		})
	);

	// Export library as JSON string
	ipcMain.handle(
		'grpo:exportLibrary',
		withIpcErrorLogging(handlerOpts('exportLibrary'), async (projectPath: string) => {
			const entries = await experienceStore.getLibrary(projectPath);
			const json = JSON.stringify(entries, null, 2);
			return { success: true, data: json };
		})
	);

	// Import library from JSON string, returns count of imported entries
	ipcMain.handle(
		'grpo:importLibrary',
		withIpcErrorLogging(handlerOpts('importLibrary'), async (projectPath: string, json: string) => {
			const entries: ExperienceEntry[] = JSON.parse(json);
			let count = 0;
			for (const entry of entries) {
				await experienceStore.addExperience(projectPath, {
					content: entry.content,
					category: entry.category,
					scope: entry.scope,
					agentType: entry.agentType,
					evidenceCount: entry.evidenceCount,
					lastRolloutGroupId: entry.lastRolloutGroupId,
				});
				count++;
			}
			return { success: true, data: count };
		})
	);

	// ─── Symphony Collector (Auto Run Signal Collection) ─────────────────

	// Collect reward signals from a completed Auto Run task
	ipcMain.handle(
		'grpo:onAutoRunTaskComplete',
		withIpcErrorLogging(
			handlerOpts('onAutoRunTaskComplete'),
			async (
				taskContent: string,
				projectPath: string,
				agentType: string,
				sessionId: string,
				exitCode: number,
				output: string,
				durationMs: number,
				documentPath: string,
			) => {
				const config = readConfig(settingsStore);
				if (!config.enabled) {
					return { success: true, data: null };
				}
				if (!deps.symphonyCollector) {
					return { success: false, error: 'Symphony collector not initialized' };
				}
				deps.symphonyCollector.setConfig(config);
				const signal = await deps.symphonyCollector.onTaskComplete(
					taskContent, projectPath, agentType, sessionId,
					exitCode, output, durationMs, documentPath,
					'autorun',
				);
				return { success: true, data: signal };
			}
		)
	);

	// Collect summary after an entire Auto Run batch completes
	ipcMain.handle(
		'grpo:onAutoRunBatchComplete',
		withIpcErrorLogging(
			handlerOpts('onAutoRunBatchComplete'),
			async (projectPath: string, batchResults: BatchCollectionResult[]) => {
				const config = readConfig(settingsStore);
				if (!config.enabled) {
					return { success: true, data: null };
				}
				if (!deps.symphonyCollector) {
					return { success: false, error: 'Symphony collector not initialized' };
				}
				deps.symphonyCollector.setConfig(config);
				const summary = await deps.symphonyCollector.onBatchComplete(projectPath, batchResults);
				return { success: true, data: summary };
			}
		)
	);

	// Check training readiness
	ipcMain.handle(
		'grpo:getTrainingReadiness',
		withIpcErrorLogging(
			handlerOpts('getTrainingReadiness'),
			async (projectPath: string) => {
				const config = readConfig(settingsStore);
				if (!deps.symphonyCollector) {
					return { success: false, error: 'Symphony collector not initialized' };
				}
				deps.symphonyCollector.setConfig(config);
				const readiness = await deps.symphonyCollector.getTrainingReadiness(projectPath);
				return { success: true, data: readiness };
			}
		)
	);

	// Form natural rollout groups from accumulated signals
	ipcMain.handle(
		'grpo:formNaturalRolloutGroups',
		withIpcErrorLogging(
			handlerOpts('formNaturalRolloutGroups'),
			async (projectPath: string) => {
				const config = readConfig(settingsStore);
				if (!deps.symphonyCollector) {
					return { success: false, error: 'Symphony collector not initialized' };
				}
				deps.symphonyCollector.setConfig(config);
				const groups = await deps.symphonyCollector.formNaturalRolloutGroups(projectPath);
				return { success: true, data: groups };
			}
		)
	);

	// ─── Embedding Model Status & Cache ───────────────────────────────────

	// Get embedding model status for settings panel display
	ipcMain.handle(
		'grpo:getModelStatus',
		withIpcErrorLogging(handlerOpts('getModelStatus'), async () => {
			const config = readConfig(settingsStore);
			const status: EmbeddingModelStatus = getModelStatus(config.semanticRetrievalEnabled);
			return { success: true, data: status };
		})
	);

	// Clear the HuggingFace model cache
	ipcMain.handle(
		'grpo:clearModelCache',
		withIpcErrorLogging(handlerOpts('clearModelCache'), async () => {
			const fs = await import('fs/promises');
			const cacheDir = getCacheDir();
			try {
				await fs.rm(cacheDir, { recursive: true, force: true });
				return { success: true };
			} catch (err) {
				return { success: false, error: `Failed to clear cache: ${err}` };
			}
		})
	);
}
