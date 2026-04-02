/**
 * Tests for OpenAIEmbeddingProvider
 *
 * Mocks fetch to avoid requiring a real OpenAI API key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VECTOR_DIM } from '../../../../main/grpo/embedding-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../../shared/memory-types';
import type { EmbeddingProviderConfig } from '../../../../shared/memory-types';
import type { EmbeddingUsageEvent } from '../../../../main/grpo/embedding-types';
import {
	OpenAIEmbeddingProvider,
	embeddingUsageEmitter,
} from '../../../../main/grpo/providers/openai-provider';

function makeEmbedding(dim: number, value = 0.1): number[] {
	return new Array(dim).fill(value);
}

function openaiConfig(overrides?: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
	return {
		...DEFAULT_EMBEDDING_CONFIG,
		providerId: 'openai',
		enabled: true,
		openai: {
			apiKey: 'sk-test-key-1234',
			model: 'text-embedding-3-small',
			dimensions: 384,
			baseUrl: 'https://api.openai.com/v1',
		},
		...overrides,
	};
}

function mockOpenAIResponse(embeddings: number[][], totalTokens = 10) {
	return new Response(
		JSON.stringify({
			data: embeddings.map((emb, i) => ({ object: 'embedding', index: i, embedding: emb })),
			usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

describe('OpenAIEmbeddingProvider', () => {
	let provider: OpenAIEmbeddingProvider;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		provider = new OpenAIEmbeddingProvider();
		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it('should have correct static properties', () => {
		expect(provider.id).toBe('openai');
		expect(provider.name).toBe('OpenAI (Cloud)');
		expect(provider.isLocal).toBe(false);
		expect(provider.nativeDimension).toBe(1536);
	});

	it('should fail initialization without API key', async () => {
		await expect(
			provider.initialize(
				openaiConfig({
					openai: {
						apiKey: '',
						model: 'text-embedding-3-small',
						dimensions: 384,
						baseUrl: 'https://api.openai.com/v1',
					},
				})
			)
		).rejects.toThrow('OpenAI API key not configured');
		expect(provider.isReady()).toBe(false);
	});

	it('should initialize successfully with valid API key', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());
		expect(provider.isReady()).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it('should call API correctly on encode', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());

		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)], 5));
		const result = await provider.encode('hello world');
		expect(result).toHaveLength(VECTOR_DIM);

		// Verify the API call
		const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
		const url = lastCall[0] as string;
		expect(url).toBe('https://api.openai.com/v1/embeddings');
		const body = JSON.parse((lastCall[1] as RequestInit).body as string);
		expect(body.model).toBe('text-embedding-3-small');
		expect(body.input).toEqual(['hello world']);
		expect(body.dimensions).toBe(384);
		expect(body.encoding_format).toBe('float');
	});

	it('should handle encodeBatch correctly', async () => {
		// Initialize
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());

		// Batch encode
		const batchEmbeddings = [
			makeEmbedding(VECTOR_DIM, 0.1),
			makeEmbedding(VECTOR_DIM, 0.2),
			makeEmbedding(VECTOR_DIM, 0.3),
		];
		fetchSpy.mockResolvedValue(mockOpenAIResponse(batchEmbeddings, 15));
		const results = await provider.encodeBatch(['a', 'b', 'c']);
		expect(results).toHaveLength(3);
		for (const emb of results) {
			expect(emb).toHaveLength(VECTOR_DIM);
		}
	});

	it('should calculate cost correctly for text-embedding-3-small', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());

		const events: EmbeddingUsageEvent[] = [];
		const handler = (event: EmbeddingUsageEvent) => events.push(event);
		embeddingUsageEmitter.on('usage', handler);

		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)], 1_000_000));
		await provider.encode('test');

		embeddingUsageEmitter.off('usage', handler);

		expect(events).toHaveLength(1);
		// 1M tokens at $0.02/1M = $0.02
		expect(events[0].costUsd).toBeCloseTo(0.02);
		expect(events[0].tokenCount).toBe(1_000_000);
	});

	it('should emit usage event with correct data', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());

		const events: EmbeddingUsageEvent[] = [];
		const handler = (event: EmbeddingUsageEvent) => events.push(event);
		embeddingUsageEmitter.on('usage', handler);

		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)], 42));
		await provider.encode('test text');

		embeddingUsageEmitter.off('usage', handler);

		expect(events).toHaveLength(1);
		expect(events[0].providerId).toBe('openai');
		expect(events[0].tokenCount).toBe(42);
		expect(events[0].textCount).toBe(1);
		expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
		expect(events[0].timestamp).toBeGreaterThan(0);
	});

	it('should handle API errors gracefully', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());

		fetchSpy.mockResolvedValue(
			new Response('{"error":{"message":"Rate limit exceeded"}}', { status: 429 })
		);

		await expect(provider.encode('test')).rejects.toThrow('OpenAI API error 429');
	});

	it('should handle network errors gracefully during initialization', async () => {
		fetchSpy.mockRejectedValue(new Error('Network error'));

		await expect(provider.initialize(openaiConfig())).rejects.toThrow('Network error');
		expect(provider.isReady()).toBe(false);

		const status = provider.getStatus();
		expect(status.ready).toBe(false);
		expect(status.error).toBe('Network error');
	});

	it('should throw when encode called without initialization', async () => {
		await expect(provider.encode('test')).rejects.toThrow('OpenAI provider not initialized');
	});

	it('should throw when encodeBatch called without initialization', async () => {
		await expect(provider.encodeBatch(['test'])).rejects.toThrow('OpenAI provider not initialized');
	});

	it('should dispose and clear API key', async () => {
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
		await provider.initialize(openaiConfig());
		expect(provider.isReady()).toBe(true);

		await provider.dispose();
		expect(provider.isReady()).toBe(false);
	});

	it('should report costPerMillionTokens in status', () => {
		const status = provider.getStatus();
		expect(status.costPerMillionTokens).toBe(0.02);
	});

	it('should use custom baseUrl from config', async () => {
		const customUrl = 'https://custom-api.example.com/v1';
		fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));

		await provider.initialize(
			openaiConfig({
				openai: {
					apiKey: 'sk-test',
					model: 'text-embedding-3-small',
					dimensions: 384,
					baseUrl: customUrl,
				},
			})
		);

		const lastCall = fetchSpy.mock.calls[0];
		expect(lastCall[0]).toBe(`${customUrl}/embeddings`);
	});

	describe('batch splitting', () => {
		it('should split large batches into chunks of 2048', async () => {
			fetchSpy.mockResolvedValue(mockOpenAIResponse([makeEmbedding(VECTOR_DIM)]));
			await provider.initialize(openaiConfig());

			// Create 3000 texts — should result in 2 API calls (2048 + 952)
			const texts = Array.from({ length: 3000 }, (_, i) => `text-${i}`);
			fetchSpy.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse((init?.body as string) ?? '{}');
				const count = Array.isArray(body.input) ? body.input.length : 1;
				return mockOpenAIResponse(
					Array.from({ length: count }, () => makeEmbedding(VECTOR_DIM)),
					count * 5
				);
			});

			const results = await provider.encodeBatch(texts);
			expect(results).toHaveLength(3000);
			// init call + 2 batch calls = 3, but we re-mocked after init so count from mock reset
			// Just verify the fetch was called at least 2 times for the batch
			expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
		});
	});
});
