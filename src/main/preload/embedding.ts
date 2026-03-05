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
import type { EmbeddingUsageSummary, EmbeddingUsageBucket } from '../../main/stats/embedding-usage';

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
	/** Check if Ollama is reachable at the given URL */
	checkOllamaConnection: (
		baseUrl?: string
	) => Promise<IpcResponse<{ connected: boolean; modelCount: number }>>;
	/** Pull (download) an Ollama model */
	pullOllamaModel: (model: string, baseUrl?: string) => Promise<IpcResponse<{ success: boolean }>>;
	/** Subscribe to model download/loading progress events. Returns unsubscribe function. */
	onProgress: (callback: (event: DownloadProgressEvent) => void) => () => void;
	/** Get aggregated embedding usage since a timestamp */
	getUsageSummary: (since: number) => Promise<IpcResponse<EmbeddingUsageSummary>>;
	/** Get embedding usage grouped into time buckets */
	getUsageTimeline: (
		since: number,
		bucketMs: number
	) => Promise<IpcResponse<EmbeddingUsageBucket[]>>;
	/** Check if an OpenAI API key is configured */
	hasOpenAIKey: () => Promise<IpcResponse<boolean>>;
	/** Set the OpenAI API key */
	setOpenAIKey: (key: string) => Promise<IpcResponse<void>>;
	/** Clear the stored OpenAI API key */
	clearOpenAIKey: () => Promise<IpcResponse<void>>;
}

export function createEmbeddingApi(): EmbeddingApi {
	return {
		getStatus: () => ipcRenderer.invoke('embedding:getStatus'),
		switchProvider: (providerId, config) =>
			ipcRenderer.invoke('embedding:switchProvider', providerId, config),
		detectAvailable: () => ipcRenderer.invoke('embedding:detectAvailable'),
		getOllamaModels: (baseUrl?) => ipcRenderer.invoke('embedding:getOllamaModels', baseUrl),
		checkOllamaConnection: (baseUrl?) =>
			ipcRenderer.invoke('embedding:checkOllamaConnection', baseUrl),
		pullOllamaModel: (model, baseUrl?) =>
			ipcRenderer.invoke('embedding:pullOllamaModel', model, baseUrl),
		onProgress: (callback) => {
			const handler = (_event: unknown, progressEvent: DownloadProgressEvent) =>
				callback(progressEvent);
			ipcRenderer.on('embedding:progress', handler);
			return () => {
				ipcRenderer.removeListener('embedding:progress', handler);
			};
		},
		getUsageSummary: (since) => ipcRenderer.invoke('embedding:getUsageSummary', since),
		getUsageTimeline: (since, bucketMs) =>
			ipcRenderer.invoke('embedding:getUsageTimeline', since, bucketMs),
		hasOpenAIKey: () => ipcRenderer.invoke('embedding:hasOpenAIKey'),
		setOpenAIKey: (key) => ipcRenderer.invoke('embedding:setOpenAIKey', key),
		clearOpenAIKey: () => ipcRenderer.invoke('embedding:clearOpenAIKey'),
	};
}
