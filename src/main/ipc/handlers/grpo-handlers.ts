/**
 * IPC handlers for Training-Free GRPO system.
 * Registered via registerAllHandlers() in ipc/handlers/index.ts.
 *
 * Pattern: follows src/main/ipc/handlers/stats.ts — dependency injection via
 * interface, withIpcErrorLogging wrapper, consistent { success, data, error } responses.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, CreateHandlerOptions } from '../../utils/ipcHandler';
import { ExperienceStore } from '../../grpo/experience-store';
import {
	collectAllRewards,
	detectProjectCommands,
} from '../../grpo/reward-collector';
import type {
	ExperienceEntry,
	ExperienceScope,
	GRPOConfig,
	GRPOStats,
} from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

const LOG_CONTEXT = '[GRPO]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface GRPOHandlerDependencies {
	experienceStore: ExperienceStore;
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

	// Update GRPO config (partial merge)
	ipcMain.handle(
		'grpo:setConfig',
		withIpcErrorLogging(handlerOpts('setConfig'), async (config: Partial<GRPOConfig>) => {
			const current = readConfig(settingsStore);
			const merged = { ...current, ...config };
			settingsStore.set(GRPO_CONFIG_KEY, merged);
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
}
