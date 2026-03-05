/**
 * Tests for TransformersJsProvider
 *
 * Mocks @xenova/transformers to avoid downloading actual models.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { VECTOR_DIM } from '../../../../main/grpo/embedding-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../../shared/memory-types';
import type { EmbeddingProviderConfig } from '../../../../shared/memory-types';

// Mock the dynamic import of @xenova/transformers
const mockPipelineFn = vi.fn();
const mockEnv = { cacheDir: '' };

vi.mock('@xenova/transformers', () => ({
	pipeline: (...args: any[]) => mockPipelineFn(...args),
	env: mockEnv,
}));

// Import after mock is set up
import { TransformersJsProvider } from '../../../../main/grpo/providers/transformers-js-provider';

function makeFloat32(dim: number, value = 0.1): Float32Array {
	return new Float32Array(dim).fill(value);
}

describe('TransformersJsProvider', () => {
	let provider: TransformersJsProvider;
	let mockPipeline: Mock;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new TransformersJsProvider();

		// Mock pipeline callable — returns output with .data as Float32Array
		mockPipeline = vi.fn(async (input: string | string[]) => {
			const count = Array.isArray(input) ? input.length : 1;
			return { data: makeFloat32(384 * count) };
		});
		mockPipelineFn.mockResolvedValue(mockPipeline);
	});

	it('should have correct static properties', () => {
		expect(provider.id).toBe('transformers-js');
		expect(provider.name).toBe('Transformers.js (Local)');
		expect(provider.isLocal).toBe(true);
		expect(provider.nativeDimension).toBe(384);
	});

	it('should initialize and load the pipeline', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);

		expect(mockPipelineFn).toHaveBeenCalledWith('feature-extraction', 'Xenova/gte-small', {
			quantized: true,
		});
		expect(provider.isReady()).toBe(true);
	});

	it('should use custom modelId from config', async () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			enabled: true,
			transformersJs: { modelId: 'Xenova/all-MiniLM-L6-v2' },
		};
		await provider.initialize(config);

		expect(mockPipelineFn).toHaveBeenCalledWith('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
			quantized: true,
		});
		const status = provider.getStatus();
		expect(status.modelName).toBe('Xenova/all-MiniLM-L6-v2');
	});

	it('should set cacheDir when provided', async () => {
		const config: EmbeddingProviderConfig = {
			...DEFAULT_EMBEDDING_CONFIG,
			enabled: true,
			transformersJs: { modelId: 'Xenova/gte-small', cacheDir: '/tmp/test-cache' },
		};
		await provider.initialize(config);

		expect(mockEnv.cacheDir).toBe('/tmp/test-cache');
	});

	it('should encode a single text and return a 384-dim array', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);

		const result = await provider.encode('hello world');
		expect(result).toHaveLength(VECTOR_DIM);
		expect(mockPipeline).toHaveBeenCalledWith('hello world', {
			pooling: 'mean',
			normalize: true,
		});
	});

	it('should encodeBatch and return correct number of 384-dim arrays', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);

		const texts = ['hello', 'world', 'test'];
		const results = await provider.encodeBatch(texts);

		expect(results).toHaveLength(3);
		for (const embedding of results) {
			expect(embedding).toHaveLength(VECTOR_DIM);
		}
	});

	it('should handle large batches by chunking', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);

		// 50 texts should be split into 2 batches (32 + 18)
		const texts = Array.from({ length: 50 }, (_, i) => `text ${i}`);
		const results = await provider.encodeBatch(texts);

		expect(results).toHaveLength(50);
		expect(mockPipeline).toHaveBeenCalledTimes(2);
	});

	it('should throw when encode called without initialization', async () => {
		await expect(provider.encode('test')).rejects.toThrow('TransformersJs not initialized');
	});

	it('should throw when encodeBatch called without initialization', async () => {
		await expect(provider.encodeBatch(['test'])).rejects.toThrow('TransformersJs not initialized');
	});

	it('should dispose and set ready to false', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);
		expect(provider.isReady()).toBe(true);

		await provider.dispose();
		expect(provider.isReady()).toBe(false);
	});

	it('should report error in status on initialization failure', async () => {
		mockPipelineFn.mockRejectedValueOnce(new Error('WASM load failed'));

		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await expect(provider.initialize(config)).rejects.toThrow('WASM load failed');

		const status = provider.getStatus();
		expect(status.ready).toBe(false);
		expect(status.error).toBe('WASM load failed');
	});

	it('should return correct status when ready', async () => {
		const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
		await provider.initialize(config);

		const status = provider.getStatus();
		expect(status.ready).toBe(true);
		expect(status.modelName).toBe('Xenova/gte-small');
		expect(status.error).toBeUndefined();
	});
});
