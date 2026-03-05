/**
 * Embedding Provider IPC Handlers
 *
 * Provides IPC handlers for embedding provider management:
 * - Status queries
 * - Provider switching
 * - Available provider detection
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import { createIpcDataHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { embeddingRegistry } from '../../grpo/embedding-registry';
import { embeddingUsageEmitter } from '../../grpo/providers/openai-provider';
import { getStatsDB } from '../../stats';
import type { EmbeddingUsageEvent } from '../../grpo/embedding-types';
import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../../shared/memory-types';

const LOG_CONTEXT = '[Embedding]';

/**
 * Sanitize an embedding config for logging — replaces apiKey with '***'.
 * Use this before any logging to prevent leaking the OpenAI API key.
 */
export function sanitizeConfig(config: EmbeddingProviderConfig): EmbeddingProviderConfig {
	if (!config.openai?.apiKey) return config;
	return {
		...config,
		openai: {
			...config.openai,
			apiKey: '***',
		},
	};
}

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

interface SettingsStore {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
}

export function registerEmbeddingHandlers(settingsStore?: SettingsStore): void {
	ipcMain.handle(
		'embedding:getStatus',
		createIpcDataHandler(handlerOpts('getStatus'), async () => {
			return {
				activeProviderId: embeddingRegistry.getActiveProviderId(),
				statuses: embeddingRegistry.getStatuses(),
			};
		})
	);

	ipcMain.handle(
		'embedding:switchProvider',
		createIpcDataHandler(
			handlerOpts('switchProvider'),
			async (providerId: EmbeddingProviderId, config: EmbeddingProviderConfig) => {
				logger.debug(
					`Switching to provider "${providerId}" with config: ${JSON.stringify(sanitizeConfig(config))}`,
					LOG_CONTEXT
				);
				await embeddingRegistry.switchProvider(providerId, config);
				return { activeProviderId: embeddingRegistry.getActiveProviderId() };
			}
		)
	);

	ipcMain.handle(
		'embedding:detectAvailable',
		createIpcDataHandler(handlerOpts('detectAvailable'), async () => {
			const available = await embeddingRegistry.detectAvailable();
			return { available };
		})
	);

	ipcMain.handle(
		'embedding:getOllamaModels',
		createIpcDataHandler(handlerOpts('getOllamaModels'), async (baseUrl?: string) => {
			const models = await embeddingRegistry.getOllamaModels(baseUrl);
			return { models };
		})
	);

	ipcMain.handle(
		'embedding:checkOllamaConnection',
		createIpcDataHandler(handlerOpts('checkOllamaConnection'), async (baseUrl?: string) => {
			return embeddingRegistry.checkOllamaConnection(baseUrl);
		})
	);

	ipcMain.handle(
		'embedding:pullOllamaModel',
		createIpcDataHandler(
			handlerOpts('pullOllamaModel'),
			async (model: string, baseUrl?: string) => {
				await embeddingRegistry.pullOllamaModel(model, baseUrl);
				return { success: true };
			}
		)
	);

	// Forward download/loading progress events to all renderer windows
	embeddingRegistry.onProgress((event) => {
		try {
			for (const win of BrowserWindow.getAllWindows()) {
				win.webContents.send('embedding:progress', event);
			}
		} catch {
			// Electron not available (testing) — skip
		}
	});

	// ─── Embedding Usage Cost Tracking ──────────────────────────────────────

	// Record usage events from cloud providers to the stats database
	embeddingUsageEmitter.on('usage', (event: EmbeddingUsageEvent) => {
		try {
			const statsDb = getStatsDB();
			if (statsDb.isReady()) {
				statsDb.insertEmbeddingUsage(event);
			}
		} catch (err) {
			logger.warn(`Failed to record embedding usage: ${err}`, LOG_CONTEXT);
		}
	});

	ipcMain.handle(
		'embedding:getUsageSummary',
		createIpcDataHandler(handlerOpts('getUsageSummary'), async (since: number) => {
			const statsDb = getStatsDB();
			return statsDb.getEmbeddingUsageSummary(since);
		})
	);

	ipcMain.handle(
		'embedding:getUsageTimeline',
		createIpcDataHandler(
			handlerOpts('getUsageTimeline'),
			async (since: number, bucketMs: number) => {
				const statsDb = getStatsDB();
				return statsDb.getEmbeddingUsageTimeline(since, bucketMs);
			}
		)
	);

	// ─── API Key Security ───────────────────────────────────────────────────

	ipcMain.handle(
		'embedding:hasOpenAIKey',
		createIpcDataHandler(handlerOpts('hasOpenAIKey'), async () => {
			if (!settingsStore) return false;
			const memoryConfig = settingsStore.get('memoryConfig') as
				| { embeddingProvider?: EmbeddingProviderConfig }
				| undefined;
			const key = memoryConfig?.embeddingProvider?.openai?.apiKey;
			return Boolean(key && key.length > 0);
		})
	);

	ipcMain.handle(
		'embedding:setOpenAIKey',
		createIpcDataHandler(handlerOpts('setOpenAIKey'), async (key: string) => {
			if (!settingsStore) throw new Error('Settings store not available');
			const memoryConfig = (settingsStore.get('memoryConfig') ?? {}) as Record<string, unknown>;
			const embeddingProvider = (memoryConfig.embeddingProvider ?? {}) as Record<string, unknown>;
			const openai = (embeddingProvider.openai ?? {}) as Record<string, unknown>;
			settingsStore.set('memoryConfig', {
				...memoryConfig,
				embeddingProvider: {
					...embeddingProvider,
					openai: {
						...openai,
						// Secret value — never expose back to renderer
						apiKey: key,
					},
				},
			});
		})
	);

	ipcMain.handle(
		'embedding:clearOpenAIKey',
		createIpcDataHandler(handlerOpts('clearOpenAIKey'), async () => {
			if (!settingsStore) throw new Error('Settings store not available');
			const memoryConfig = (settingsStore.get('memoryConfig') ?? {}) as Record<string, unknown>;
			const embeddingProvider = (memoryConfig.embeddingProvider ?? {}) as Record<string, unknown>;
			const openai = (embeddingProvider.openai ?? {}) as Record<string, unknown>;
			settingsStore.set('memoryConfig', {
				...memoryConfig,
				embeddingProvider: {
					...embeddingProvider,
					openai: {
						...openai,
						apiKey: '',
					},
				},
			});
		})
	);

	logger.debug('Embedding IPC handlers registered', LOG_CONTEXT);
}
