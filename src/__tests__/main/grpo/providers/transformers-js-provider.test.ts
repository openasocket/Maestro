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

	describe('progress callbacks', () => {
		it('should emit progress events during initialization', async () => {
			const progressEvents: any[] = [];
			provider.setProgressCallback((event) => progressEvents.push(event));

			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await provider.initialize(config);

			// Should have at least: downloading(0), downloading(0.1), ready(1.0)
			expect(progressEvents.length).toBeGreaterThanOrEqual(3);
			expect(progressEvents[0].status).toBe('downloading');
			expect(progressEvents[0].progress).toBe(0);
			expect(progressEvents[progressEvents.length - 1].status).toBe('ready');
			expect(progressEvents[progressEvents.length - 1].progress).toBe(1.0);
		});

		it('should pass progress_callback in pipeline options when callback is set', async () => {
			provider.setProgressCallback(() => {});

			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await provider.initialize(config);

			const pipelineCallArgs = mockPipelineFn.mock.calls[0];
			expect(pipelineCallArgs[2]).toHaveProperty('progress_callback');
			expect(typeof pipelineCallArgs[2].progress_callback).toBe('function');
		});

		it('should not pass progress_callback when no callback is set', async () => {
			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await provider.initialize(config);

			const pipelineCallArgs = mockPipelineFn.mock.calls[0];
			expect(pipelineCallArgs[2]).toEqual({ quantized: true });
		});

		it('should emit error progress on initialization failure', async () => {
			const progressEvents: any[] = [];
			provider.setProgressCallback((event) => progressEvents.push(event));
			mockPipelineFn.mockRejectedValueOnce(new Error('WASM load failed'));

			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await expect(provider.initialize(config)).rejects.toThrow('WASM load failed');

			const lastEvent = progressEvents[progressEvents.length - 1];
			expect(lastEvent.status).toBe('error');
			expect(lastEvent.message).toBe('WASM load failed');
		});

		it('should map download progress to 0.1–0.9 range', async () => {
			const progressEvents: any[] = [];
			provider.setProgressCallback((event) => progressEvents.push(event));

			// Make pipeline call the progress_callback during creation
			mockPipelineFn.mockImplementation(async (_task: string, _model: string, opts: any) => {
				if (opts.progress_callback) {
					opts.progress_callback({ status: 'progress', progress: 50, file: 'model.onnx' });
					opts.progress_callback({ status: 'done' });
				}
				return mockPipeline;
			});

			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await provider.initialize(config);

			const downloadEvent = progressEvents.find(
				(e) => e.status === 'downloading' && e.message === 'model.onnx'
			);
			expect(downloadEvent).toBeDefined();
			// 50% progress mapped to 0.1 + (50/100)*0.8 = 0.5
			expect(downloadEvent.progress).toBeCloseTo(0.5, 2);

			const loadingEvent = progressEvents.find((e) => e.status === 'loading');
			expect(loadingEvent).toBeDefined();
			expect(loadingEvent.progress).toBe(0.95);
		});
	});

	describe('cache directory', () => {
		it('should set cacheDir from config.transformersJs.cacheDir', async () => {
			mockEnv.cacheDir = '';
			const config: EmbeddingProviderConfig = {
				...DEFAULT_EMBEDDING_CONFIG,
				enabled: true,
				transformersJs: {
					modelId: 'Xenova/gte-small',
					cacheDir: '/app/data/models/transformers-js/',
				},
			};
			await provider.initialize(config);
			expect(mockEnv.cacheDir).toBe('/app/data/models/transformers-js/');
		});

		it('should not set cacheDir when not provided', async () => {
			mockEnv.cacheDir = '';
			const config: EmbeddingProviderConfig = { ...DEFAULT_EMBEDDING_CONFIG, enabled: true };
			await provider.initialize(config);
			expect(mockEnv.cacheDir).toBe('');
		});
	});
});
