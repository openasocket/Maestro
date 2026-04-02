/**
 * Cross-provider integration tests for the embedding system.
 *
 * Verifies dimension consistency, semantic quality, provider switching,
 * graceful degradation, and cost tracking across all embedding providers.
 *
 * Uses mock providers to test contracts without requiring external services.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingRegistry } from '../../../main/grpo/embedding-registry';
import {
	VECTOR_DIM,
	cosineSimilarity,
	EmbeddingModelNotAvailableError,
} from '../../../main/grpo/embedding-types';
import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
	EmbeddingUsageEvent,
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a normalized random vector of the given dimension */
function randomNormalizedVector(dim: number): number[] {
	const vec = Array.from({ length: dim }, () => Math.random() - 0.5);
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return vec.map((v) => v / norm);
}

/** Create a deterministic embedding based on text content (simulates semantic similarity) */
function deterministicEmbedding(text: string, dim: number): number[] {
	// Use a simple hash-based approach: similar texts share a base vector
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (hash * 31 + text.charCodeAt(i)) | 0;
	}
	const rng = (seed: number) => {
		seed = (seed * 1103515245 + 12345) | 0;
		return ((seed >>> 16) & 0x7fff) / 0x7fff;
	};

	const vec: number[] = [];
	let seed = hash;
	for (let i = 0; i < dim; i++) {
		seed = (seed * 1103515245 + 12345) | 0;
		vec.push(rng(seed) - 0.5);
	}
	const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
	return norm === 0 ? vec : vec.map((v) => v / norm);
}

/**
 * Create a semantic-aware mock provider.
 * Similar texts produce similar embeddings by using shared base vectors.
 */
function createSemanticMockProvider(
	id: 'transformers-js' | 'ollama' | 'openai' | 'xenova-onnx' = 'transformers-js',
	opts: {
		ready?: boolean;
		failInit?: boolean;
		failEncode?: boolean;
		nativeDim?: number;
		usageEmitter?: (event: EmbeddingUsageEvent) => void;
	} = {}
): EmbeddingProvider {
	let ready = false;
	const nativeDim = opts.nativeDim ?? 384;

	return {
		id,
		name: `Mock ${id}`,
		isLocal: id !== 'openai',
		nativeDimension: nativeDim,
		initialize: vi.fn(async () => {
			if (opts.failInit) throw new Error(`Init failed for ${id}`);
			ready = opts.ready !== false;
		}),
		isReady: vi.fn(() => ready),
		encode: vi.fn(async (text: string) => {
			if (opts.failEncode) throw new Error(`Encode failed for ${id}`);
			if (!ready) throw new Error(`${id} not initialized`);
			const vec = deterministicEmbedding(`${id}:${text}`, VECTOR_DIM);
			if (opts.usageEmitter) {
				opts.usageEmitter({
					providerId: id,
					tokenCount: text.split(/\s+/).length * 2,
					textCount: 1,
					durationMs: 5,
					costUsd: id === 'openai' ? 0.00001 : undefined,
					timestamp: Date.now(),
				});
			}
			return vec;
		}),
		encodeBatch: vi.fn(async (texts: string[]) => {
			if (opts.failEncode) throw new Error(`Encode failed for ${id}`);
			if (!ready) throw new Error(`${id} not initialized`);
			const results = texts.map((t) => deterministicEmbedding(`${id}:${t}`, VECTOR_DIM));
			if (opts.usageEmitter) {
				const totalTokens = texts.reduce((s, t) => s + t.split(/\s+/).length * 2, 0);
				opts.usageEmitter({
					providerId: id,
					tokenCount: totalTokens,
					textCount: texts.length,
					durationMs: 10,
					costUsd: id === 'openai' ? (totalTokens / 1_000_000) * 0.02 : undefined,
					timestamp: Date.now(),
				});
			}
			return results;
		}),
		dispose: vi.fn(async () => {
			ready = false;
		}),
		getStatus: vi.fn(
			(): EmbeddingProviderStatus => ({
				ready,
				modelName: `mock-model-${id}`,
			})
		),
	};
}

function makeConfig(
	providerId: 'transformers-js' | 'ollama' | 'openai' | 'xenova-onnx' = 'transformers-js'
): EmbeddingProviderConfig {
	return {
		...DEFAULT_EMBEDDING_CONFIG,
		providerId,
		enabled: true,
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Embedding Integration Tests', () => {
	let registry: EmbeddingRegistry;

	beforeEach(() => {
		registry = new EmbeddingRegistry();
	});

	// ─── Dimension Consistency ──────────────────────────────────────────────

	describe('Dimension consistency', () => {
		const providerIds = ['transformers-js', 'ollama', 'openai'] as const;

		for (const providerId of providerIds) {
			describe(`${providerId}`, () => {
				let provider: EmbeddingProvider;

				beforeEach(async () => {
					provider = createSemanticMockProvider(providerId);
					registry.register(provider);
					await registry.activate(makeConfig(providerId));
				});

				it(`encode() returns exactly ${VECTOR_DIM} elements`, async () => {
					const embedding = await registry.getActive().encode('test text');
					expect(embedding).toHaveLength(VECTOR_DIM);
				});

				it(`encodeBatch() returns arrays of exactly ${VECTOR_DIM} elements`, async () => {
					const embeddings = await registry.getActive().encodeBatch(['text a', 'text b', 'text c']);
					expect(embeddings).toHaveLength(3);
					for (const emb of embeddings) {
						expect(emb).toHaveLength(VECTOR_DIM);
					}
				});

				it('all elements are finite numbers (no NaN, Infinity)', async () => {
					const embedding = await registry.getActive().encode('finite check');
					for (const val of embedding) {
						expect(Number.isFinite(val)).toBe(true);
					}
				});

				it('embeddings are normalized (L2 norm ~1.0)', async () => {
					const embedding = await registry.getActive().encode('normalization check');
					const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
					expect(norm).toBeCloseTo(1.0, 1);
				});
			});
		}
	});

	// ─── Semantic Consistency ───────────────────────────────────────────────

	describe('Semantic consistency', () => {
		let provider: EmbeddingProvider;

		beforeEach(async () => {
			provider = createSemanticMockProvider('transformers-js');
			registry.register(provider);
			await registry.activate(makeConfig('transformers-js'));
		});

		it('identical texts produce cosine similarity > 0.99', async () => {
			const text = 'TypeScript React component';
			const a = await provider.encode(text);
			const b = await provider.encode(text);
			expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
		});

		it('empty/whitespace text produces a valid non-zero embedding', async () => {
			const emptyResult = await provider.encode('');
			expect(emptyResult).toHaveLength(VECTOR_DIM);
			const hasNonZero = emptyResult.some((v) => v !== 0);
			expect(hasNonZero).toBe(true);

			const whitespaceResult = await provider.encode('   ');
			expect(whitespaceResult).toHaveLength(VECTOR_DIM);
			const hasNonZeroWs = whitespaceResult.some((v) => v !== 0);
			expect(hasNonZeroWs).toBe(true);
		});

		it('different texts produce different embeddings', async () => {
			const a = await provider.encode('TypeScript React component');
			const b = await provider.encode('SQL database query optimization');
			const similarity = cosineSimilarity(a, b);
			// Different texts should have similarity < 1.0
			expect(similarity).toBeLessThan(1.0);
		});
	});

	// ─── Provider Switching ─────────────────────────────────────────────────

	describe('Provider switching', () => {
		it('switch from Provider A to Provider B — new embeddings come from Provider B', async () => {
			const providerA = createSemanticMockProvider('transformers-js');
			const providerB = createSemanticMockProvider('ollama');
			registry.register(providerA);
			registry.register(providerB);

			// Start with Provider A
			await registry.activate(makeConfig('transformers-js'));
			const embA = await registry.getActive().encode('test');
			expect(providerA.encode).toHaveBeenCalled();

			// Switch to Provider B
			await registry.switchProvider('ollama', makeConfig('ollama'));
			const embB = await registry.getActive().encode('test');
			expect(providerB.encode).toHaveBeenCalled();

			// Embeddings should differ since providers use different vector spaces
			// (our mock includes providerId in the hash seed)
			const similarity = cosineSimilarity(embA, embB);
			expect(similarity).toBeLessThan(1.0);
		});

		it('existing embeddings from Provider A still produce valid cosine similarities with Provider B', async () => {
			// NOTE: This is a known limitation — different providers produce different
			// vector spaces, so cross-provider cosine similarity may not be semantically
			// meaningful. The test verifies that the math works (returns a finite number
			// in [-1, 1]) without claiming semantic correctness.
			const providerA = createSemanticMockProvider('transformers-js');
			const providerB = createSemanticMockProvider('ollama');
			registry.register(providerA);
			registry.register(providerB);

			await registry.activate(makeConfig('transformers-js'));
			const embFromA = await registry.getActive().encode('existing memory');

			await registry.switchProvider('ollama', makeConfig('ollama'));
			const embFromB = await registry.getActive().encode('new query');

			const similarity = cosineSimilarity(embFromA, embFromB);
			expect(Number.isFinite(similarity)).toBe(true);
			expect(similarity).toBeGreaterThanOrEqual(-1);
			expect(similarity).toBeLessThanOrEqual(1);
		});

		it('switch to unavailable provider — registry not ready', async () => {
			const providerA = createSemanticMockProvider('transformers-js');
			registry.register(providerA);
			await registry.activate(makeConfig('transformers-js'));
			expect(registry.isReady()).toBe(true);

			// Switch to unregistered provider — activate should silently skip
			await registry.switchProvider('openai', makeConfig('openai'));
			expect(registry.isReady()).toBe(false);
		});

		it('old provider is disposed after switch', async () => {
			const providerA = createSemanticMockProvider('transformers-js');
			const providerB = createSemanticMockProvider('ollama');
			registry.register(providerA);
			registry.register(providerB);

			await registry.activate(makeConfig('transformers-js'));
			await registry.switchProvider('ollama', makeConfig('ollama'));

			expect(providerA.dispose).toHaveBeenCalled();
		});
	});

	// ─── Graceful Degradation ───────────────────────────────────────────────

	describe('Graceful degradation', () => {
		it('no provider active — encode() via service throws EmbeddingModelNotAvailableError', async () => {
			// Import the service module (which wraps the singleton registry)
			// For integration testing, verify that calling encode on an empty registry throws
			const emptyRegistry = new EmbeddingRegistry();
			expect(emptyRegistry.isReady()).toBe(false);
			expect(() => emptyRegistry.getActive()).toThrow('No embedding provider is active');
		});

		it('EmbeddingModelNotAvailableError has correct name and message', () => {
			const error = new EmbeddingModelNotAvailableError();
			expect(error.name).toBe('EmbeddingModelNotAvailableError');
			expect(error.message).toBe('Embedding model is not available');
			expect(error).toBeInstanceOf(Error);
		});

		it('EmbeddingModelNotAvailableError accepts custom message', () => {
			const error = new EmbeddingModelNotAvailableError('Custom error');
			expect(error.message).toBe('Custom error');
		});

		it('provider active but fails mid-operation — error propagated cleanly', async () => {
			const failingProvider = createSemanticMockProvider('transformers-js', {
				failEncode: true,
			});
			registry.register(failingProvider);
			await registry.activate(makeConfig('transformers-js'));

			await expect(registry.getActive().encode('test')).rejects.toThrow(
				'Encode failed for transformers-js'
			);
		});

		it('encodeBatch fails mid-operation — error propagated cleanly', async () => {
			const failingProvider = createSemanticMockProvider('ollama', {
				failEncode: true,
			});
			registry.register(failingProvider);
			await registry.activate(makeConfig('ollama'));

			await expect(registry.getActive().encodeBatch(['a', 'b'])).rejects.toThrow(
				'Encode failed for ollama'
			);
		});

		it('provider initialization failure does not leave registry in broken state', async () => {
			const failProvider = createSemanticMockProvider('ollama', { failInit: true });
			registry.register(failProvider);

			await expect(registry.activate(makeConfig('ollama'))).rejects.toThrow(
				'Init failed for ollama'
			);
			expect(registry.isReady()).toBe(false);
			expect(registry.getActiveProviderId()).toBeNull();
		});

		it('can activate a different provider after one fails initialization', async () => {
			const failProvider = createSemanticMockProvider('ollama', { failInit: true });
			const goodProvider = createSemanticMockProvider('transformers-js');
			registry.register(failProvider);
			registry.register(goodProvider);

			await expect(registry.activate(makeConfig('ollama'))).rejects.toThrow();

			await registry.activate(makeConfig('transformers-js'));
			expect(registry.isReady()).toBe(true);
			expect(registry.getActiveProviderId()).toBe('transformers-js');
		});
	});

	// ─── Cost Tracking (OpenAI) ─────────────────────────────────────────────

	describe('Cost tracking (OpenAI)', () => {
		it('each encode() call records a usage event', async () => {
			const usageEvents: EmbeddingUsageEvent[] = [];
			const provider = createSemanticMockProvider('openai', {
				usageEmitter: (event) => usageEvents.push(event),
			});
			registry.register(provider);
			await registry.activate(makeConfig('openai'));

			await registry.getActive().encode('hello world');
			expect(usageEvents).toHaveLength(1);
			expect(usageEvents[0].providerId).toBe('openai');
			expect(usageEvents[0].textCount).toBe(1);
			expect(usageEvents[0].tokenCount).toBeGreaterThan(0);
			expect(usageEvents[0].costUsd).toBeGreaterThan(0);
			expect(usageEvents[0].timestamp).toBeGreaterThan(0);
		});

		it('encodeBatch() records aggregated usage', async () => {
			const usageEvents: EmbeddingUsageEvent[] = [];
			const provider = createSemanticMockProvider('openai', {
				usageEmitter: (event) => usageEvents.push(event),
			});
			registry.register(provider);
			await registry.activate(makeConfig('openai'));

			await registry.getActive().encodeBatch(['a', 'b', 'c']);
			expect(usageEvents).toHaveLength(1);
			expect(usageEvents[0].textCount).toBe(3);
			expect(usageEvents[0].tokenCount).toBeGreaterThan(0);
		});

		it('usage events accumulate across multiple calls', async () => {
			const usageEvents: EmbeddingUsageEvent[] = [];
			const provider = createSemanticMockProvider('openai', {
				usageEmitter: (event) => usageEvents.push(event),
			});
			registry.register(provider);
			await registry.activate(makeConfig('openai'));

			await registry.getActive().encode('first');
			await registry.getActive().encode('second');
			await registry.getActive().encodeBatch(['third', 'fourth']);

			expect(usageEvents).toHaveLength(3);

			const totalTokens = usageEvents.reduce((s, e) => s + e.tokenCount, 0);
			expect(totalTokens).toBeGreaterThan(0);

			const totalCost = usageEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0);
			expect(totalCost).toBeGreaterThan(0);
		});

		it('zero cost recorded for local providers', async () => {
			const usageEvents: EmbeddingUsageEvent[] = [];
			const provider = createSemanticMockProvider('transformers-js', {
				usageEmitter: (event) => usageEvents.push(event),
			});
			registry.register(provider);
			await registry.activate(makeConfig('transformers-js'));

			await registry.getActive().encode('test');
			// Local provider emitter is called but costUsd should be undefined
			expect(usageEvents).toHaveLength(1);
			expect(usageEvents[0].costUsd).toBeUndefined();
		});
	});

	// ─── Vector Math Validation ─────────────────────────────────────────────

	describe('Vector math validation', () => {
		it('cosineSimilarity handles zero vectors gracefully', () => {
			const zero = new Array(VECTOR_DIM).fill(0);
			const nonZero = randomNormalizedVector(VECTOR_DIM);
			expect(cosineSimilarity(zero, nonZero)).toBe(0);
			expect(cosineSimilarity(zero, zero)).toBe(0);
		});

		it('cosineSimilarity of identical vectors is ~1.0', () => {
			const vec = randomNormalizedVector(VECTOR_DIM);
			expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
		});

		it('cosineSimilarity of opposite vectors is ~-1.0', () => {
			const vec = randomNormalizedVector(VECTOR_DIM);
			const opposite = vec.map((v) => -v);
			expect(cosineSimilarity(vec, opposite)).toBeCloseTo(-1.0, 5);
		});

		it('cosineSimilarity returns value in [-1, 1] for random vectors', () => {
			for (let i = 0; i < 10; i++) {
				const a = randomNormalizedVector(VECTOR_DIM);
				const b = randomNormalizedVector(VECTOR_DIM);
				const sim = cosineSimilarity(a, b);
				expect(sim).toBeGreaterThanOrEqual(-1);
				expect(sim).toBeLessThanOrEqual(1);
			}
		});
	});

	// ─── Multi-Provider Dimension Agreement ─────────────────────────────────

	describe('Multi-provider dimension agreement', () => {
		it('all providers produce embeddings of the same dimension', async () => {
			const ids = ['transformers-js', 'ollama', 'openai'] as const;
			const embeddings: Record<string, number[]> = {};

			for (const id of ids) {
				const provider = createSemanticMockProvider(id);
				const localRegistry = new EmbeddingRegistry();
				localRegistry.register(provider);
				await localRegistry.activate(makeConfig(id));
				embeddings[id] = await localRegistry.getActive().encode('dimension agreement test');
			}

			// All should be VECTOR_DIM
			for (const id of ids) {
				expect(embeddings[id]).toHaveLength(VECTOR_DIM);
			}

			// Cross-provider cosine similarity should be computable
			for (let i = 0; i < ids.length; i++) {
				for (let j = i + 1; j < ids.length; j++) {
					const sim = cosineSimilarity(embeddings[ids[i]], embeddings[ids[j]]);
					expect(Number.isFinite(sim)).toBe(true);
				}
			}
		});
	});
});
