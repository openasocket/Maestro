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
import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../../shared/memory-types';

const LOG_CONTEXT = '[Embedding]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export function registerEmbeddingHandlers(): void {
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

	logger.debug('Embedding IPC handlers registered', LOG_CONTEXT);
}
