/**
 * Embedding Provider Registry
 *
 * Manages embedding provider lifecycle: registration, activation, switching,
 * and auto-detection. Maintains a single active provider at a time.
 */

import { logger } from '../utils/logger';
import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
	DownloadProgressEvent,
} from './embedding-types';
import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../shared/memory-types';

const LOG_CONTEXT = '[EmbeddingRegistry]';

export type ProgressListener = (event: DownloadProgressEvent) => void;

export class EmbeddingRegistry {
	private activeProvider: EmbeddingProvider | null = null;
	private providers: Map<EmbeddingProviderId, EmbeddingProvider> = new Map();
	private progressListeners: Set<ProgressListener> = new Set();

	/** Subscribe to download/loading progress events */
	onProgress(listener: ProgressListener): () => void {
		this.progressListeners.add(listener);
		return () => {
			this.progressListeners.delete(listener);
		};
	}

	/** Emit a progress event to all listeners */
	emitProgress(event: DownloadProgressEvent): void {
		for (const listener of this.progressListeners) {
			try {
				listener(event);
			} catch (err) {
				logger.warn(`Progress listener error: ${err}`, LOG_CONTEXT);
			}
		}
	}

	/** Register a provider implementation */
	register(provider: EmbeddingProvider): void {
		this.providers.set(provider.id, provider);
		logger.debug(`Registered embedding provider: ${provider.name}`, LOG_CONTEXT);
	}

	/** Initialize the configured provider */
	async activate(config: EmbeddingProviderConfig): Promise<void> {
		if (!config.enabled) {
			logger.debug('Embedding provider disabled, skipping activation', LOG_CONTEXT);
			return;
		}

		const provider = this.providers.get(config.providerId);
		if (!provider) {
			logger.warn(`Embedding provider "${config.providerId}" not registered`, LOG_CONTEXT);
			return;
		}

		// Wire up progress forwarding if the provider supports it
		if (
			'setProgressCallback' in provider &&
			typeof (provider as any).setProgressCallback === 'function'
		) {
			(provider as any).setProgressCallback((event: DownloadProgressEvent) => {
				this.emitProgress(event);
			});
		}

		try {
			await provider.initialize(config);
			this.activeProvider = provider;
			logger.info(`Activated embedding provider: ${provider.name}`, LOG_CONTEXT);
		} catch (err) {
			logger.error(
				`Failed to activate embedding provider "${config.providerId}": ${err}`,
				LOG_CONTEXT
			);
			throw err;
		}
	}

	/** Get the active provider (throws if none active) */
	getActive(): EmbeddingProvider {
		if (!this.activeProvider) {
			throw new Error('No embedding provider is active');
		}
		return this.activeProvider;
	}

	/** Check if any provider is active and ready */
	isReady(): boolean {
		return this.activeProvider?.isReady() ?? false;
	}

	/** Switch to a different provider */
	async switchProvider(
		providerId: EmbeddingProviderId,
		config: EmbeddingProviderConfig
	): Promise<void> {
		// Deactivate current provider
		if (this.activeProvider) {
			try {
				await this.activeProvider.dispose();
			} catch (err) {
				logger.warn(`Error disposing previous provider: ${err}`, LOG_CONTEXT);
			}
			this.activeProvider = null;
		}

		// Activate the new one
		const updated = { ...config, providerId };
		await this.activate(updated);
	}

	/** Shut down the active provider */
	async deactivate(): Promise<void> {
		if (this.activeProvider) {
			try {
				await this.activeProvider.dispose();
				logger.info(`Deactivated embedding provider: ${this.activeProvider.name}`, LOG_CONTEXT);
			} catch (err) {
				logger.warn(`Error disposing provider: ${err}`, LOG_CONTEXT);
			}
			this.activeProvider = null;
		}
	}

	/** Auto-detect available local providers */
	async detectAvailable(): Promise<EmbeddingProviderId[]> {
		const available: EmbeddingProviderId[] = [];

		// Check if Transformers.js can be imported (use variable to avoid static analysis)
		try {
			const moduleName = '@xenova/transformers';
			await import(/* @vite-ignore */ moduleName);
			available.push('transformers-js');
		} catch {
			// Not available
		}

		// Check if Ollama is running
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			const res = await fetch('http://localhost:11434/api/tags', {
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (res.ok) {
				available.push('ollama');
			}
		} catch {
			// Ollama not running
		}

		// Check if OpenAI key is configured (check registered provider config)
		// OpenAI availability is determined by config, not runtime detection
		// Callers should check config.openai?.apiKey separately

		return available;
	}

	/** Get status of all registered providers */
	getStatuses(): Record<string, EmbeddingProviderStatus> {
		const statuses: Record<string, EmbeddingProviderStatus> = {};
		for (const [id, provider] of this.providers) {
			statuses[id] = provider.getStatus();
		}
		return statuses;
	}

	/** Get the active provider ID, or null */
	getActiveProviderId(): EmbeddingProviderId | null {
		return this.activeProvider?.id ?? null;
	}
}

/** Singleton registry instance */
export const embeddingRegistry = new EmbeddingRegistry();
