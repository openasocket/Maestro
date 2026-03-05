/**
 * Preload API for Embedding Provider operations
 *
 * Provides the window.maestro.embedding namespace for:
 * - Provider status queries
 * - Provider switching
 * - Available provider detection
 */

import { ipcRenderer } from 'electron';
import type { IpcResponse } from '../../main/utils/ipcHandler';
import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../shared/memory-types';
import type {
	EmbeddingProviderStatus,
	DownloadProgressEvent,
} from '../../main/grpo/embedding-types';

export interface EmbeddingStatusResult {
	activeProviderId: EmbeddingProviderId | null;
	statuses: Record<string, EmbeddingProviderStatus>;
}

export interface EmbeddingApi {
	getStatus: () => Promise<IpcResponse<EmbeddingStatusResult>>;
	switchProvider: (
		providerId: EmbeddingProviderId,
		config: EmbeddingProviderConfig
	) => Promise<IpcResponse<{ activeProviderId: EmbeddingProviderId | null }>>;
	detectAvailable: () => Promise<IpcResponse<{ available: EmbeddingProviderId[] }>>;
	/** Fetch embedding-capable models from a running Ollama instance */
	getOllamaModels: (baseUrl?: string) => Promise<IpcResponse<{ models: string[] }>>;
	/** Subscribe to model download/loading progress events. Returns unsubscribe function. */
	onProgress: (callback: (event: DownloadProgressEvent) => void) => () => void;
}

export function createEmbeddingApi(): EmbeddingApi {
	return {
		getStatus: () => ipcRenderer.invoke('embedding:getStatus'),
		switchProvider: (providerId, config) =>
			ipcRenderer.invoke('embedding:switchProvider', providerId, config),
		detectAvailable: () => ipcRenderer.invoke('embedding:detectAvailable'),
		getOllamaModels: (baseUrl?) => ipcRenderer.invoke('embedding:getOllamaModels', baseUrl),
		onProgress: (callback) => {
			const handler = (_event: unknown, progressEvent: DownloadProgressEvent) =>
				callback(progressEvent);
			ipcRenderer.on('embedding:progress', handler);
			return () => {
				ipcRenderer.removeListener('embedding:progress', handler);
			};
		},
	};
}
