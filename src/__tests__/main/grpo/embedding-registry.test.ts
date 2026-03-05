/**
 * Tests for the EmbeddingRegistry — provider lifecycle management.
 *
 * Tests cover:
 * - Register and activate a mock provider
 * - getActive throws when no provider active
 * - switchProvider deactivates old provider
 * - detectAvailable returns correct list based on mocked conditions
 * - deactivate shuts down provider
 * - isReady reflects provider state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingRegistry } from '../../../main/grpo/embedding-registry';
import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
} from '../../../main/grpo/embedding-types';
import type { EmbeddingProviderConfig } from '../../../shared/memory-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../shared/memory-types';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

function createMockProvider(
	id: 'transformers-js' | 'ollama' | 'openai' | 'xenova-onnx' = 'transformers-js',
	opts: { ready?: boolean; failInit?: boolean } = {}
): EmbeddingProvider {
	const ready = opts.ready ?? true;
	return {
		id,
		name: `Mock ${id}`,
		isLocal: id !== 'openai',
		nativeDimension: 384,
		initialize: vi.fn(async () => {
			if (opts.failInit) throw new Error('Init failed');
		}),
		isReady: vi.fn(() => ready),
		encode: vi.fn(async () => new Array(384).fill(0)),
		encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(384).fill(0))),
		dispose: vi.fn(async () => {}),
		getStatus: vi.fn(
			(): EmbeddingProviderStatus => ({
				ready,
				modelName: `mock-model-${id}`,
			})
		),
	};
}

describe('EmbeddingRegistry', () => {
	let registry: EmbeddingRegistry;

	beforeEach(() => {
		registry = new EmbeddingRegistry();
	});

	it('should register and activate a mock provider', async () => {
		const provider = createMockProvider('transformers-js');
		registry.register(provider);

		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await registry.activate(config);

		expect(provider.initialize).toHaveBeenCalledWith(config);
		expect(registry.isReady()).toBe(true);
		expect(registry.getActive()).toBe(provider);
		expect(registry.getActiveProviderId()).toBe('transformers-js');
	});

	it('should throw when getActive called with no active provider', () => {
		expect(() => registry.getActive()).toThrow('No embedding provider is active');
	});

	it('should return false for isReady when no provider active', () => {
		expect(registry.isReady()).toBe(false);
	});

	it('should skip activation when enabled is false', async () => {
		const provider = createMockProvider('transformers-js');
		registry.register(provider);

		await registry.activate({ ...DEFAULT_EMBEDDING_CONFIG, enabled: false });

		expect(provider.initialize).not.toHaveBeenCalled();
		expect(registry.isReady()).toBe(false);
	});

	it('should warn when activating unregistered provider', async () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'ollama',
			enabled: true,
		};
		await registry.activate(config);

		expect(registry.isReady()).toBe(false);
	});

	it('should throw on initialization failure', async () => {
		const provider = createMockProvider('transformers-js', { failInit: true });
		registry.register(provider);

		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await expect(registry.activate(config)).rejects.toThrow('Init failed');
	});

	it('should switch providers and deactivate old one', async () => {
		const providerA = createMockProvider('transformers-js');
		const providerB = createMockProvider('ollama');
		registry.register(providerA);
		registry.register(providerB);

		// Activate first
		await registry.activate({ ...DEFAULT_EMBEDDING_CONFIG, enabled: true });
		expect(registry.getActiveProviderId()).toBe('transformers-js');

		// Switch to second
		await registry.switchProvider('ollama', {
			...DEFAULT_EMBEDDING_CONFIG,
			providerId: 'ollama',
			enabled: true,
		});

		expect(providerA.dispose).toHaveBeenCalled();
		expect(providerB.initialize).toHaveBeenCalled();
		expect(registry.getActiveProviderId()).toBe('ollama');
	});

	it('should deactivate the active provider', async () => {
		const provider = createMockProvider('transformers-js');
		registry.register(provider);

		await registry.activate({ ...DEFAULT_EMBEDDING_CONFIG, enabled: true });
		await registry.deactivate();

		expect(provider.dispose).toHaveBeenCalled();
		expect(registry.isReady()).toBe(false);
		expect(registry.getActiveProviderId()).toBeNull();
	});

	it('should return statuses for all registered providers', () => {
		const providerA = createMockProvider('transformers-js');
		const providerB = createMockProvider('ollama', { ready: false });
		registry.register(providerA);
		registry.register(providerB);

		const statuses = registry.getStatuses();
		expect(statuses['transformers-js']).toEqual({
			ready: true,
			modelName: 'mock-model-transformers-js',
		});
		expect(statuses['ollama']).toEqual({
			ready: false,
			modelName: 'mock-model-ollama',
		});
	});

	it('should detect available providers', async () => {
		// Mock fetch for Ollama detection
		const originalFetch = global.fetch;
		global.fetch = vi.fn(async () => ({ ok: true }) as Response);

		const available = await registry.detectAvailable();

		// Ollama should be detected (fetch returns ok)
		expect(available).toContain('ollama');
		// transformers-js may or may not be available depending on environment

		global.fetch = originalFetch;
	});

	it('should handle deactivate when no provider is active', async () => {
		// Should not throw
		await registry.deactivate();
		expect(registry.isReady()).toBe(false);
	});

	describe('progress events', () => {
		it('should forward progress events to listeners', () => {
			const events: any[] = [];
			registry.onProgress((event) => events.push(event));

			registry.emitProgress({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0.5,
				status: 'downloading',
				message: 'test',
			});

			expect(events).toHaveLength(1);
			expect(events[0].progress).toBe(0.5);
			expect(events[0].status).toBe('downloading');
		});

		it('should allow unsubscribing from progress events', () => {
			const events: any[] = [];
			const unsub = registry.onProgress((event) => events.push(event));

			registry.emitProgress({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 0.5,
				status: 'downloading',
			});
			unsub();
			registry.emitProgress({
				providerId: 'transformers-js',
				modelId: 'Xenova/gte-small',
				progress: 1.0,
				status: 'ready',
			});

			expect(events).toHaveLength(1);
		});

		it('should wire progress callback on providers that support it during activate', async () => {
			const provider = createMockProvider('transformers-js');
			const setProgressCallback = vi.fn();
			(provider as any).setProgressCallback = setProgressCallback;
			registry.register(provider);

			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await registry.activate(config);

			expect(setProgressCallback).toHaveBeenCalledWith(expect.any(Function));
		});
	});
});
