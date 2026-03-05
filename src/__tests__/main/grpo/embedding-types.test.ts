/**
 * Type-level tests for embedding types.
 * Verifies that all interfaces compile correctly and defaults are valid.
 */

import { describe, it, expect } from 'vitest';
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
import { DEFAULT_EMBEDDING_CONFIG } from '../../../shared/memory-types';
import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../../shared/memory-types';

describe('Embedding types', () => {
	it('should export VECTOR_DIM as 384', () => {
		expect(VECTOR_DIM).toBe(384);
	});

	it('should have valid DEFAULT_EMBEDDING_CONFIG', () => {
		expect(DEFAULT_EMBEDDING_CONFIG.providerId).toBe('transformers-js');
		expect(DEFAULT_EMBEDDING_CONFIG.enabled).toBe(false);
		expect(DEFAULT_EMBEDDING_CONFIG.ollama?.baseUrl).toBe('http://localhost:11434');
		expect(DEFAULT_EMBEDDING_CONFIG.ollama?.model).toBe('nomic-embed-text');
		expect(DEFAULT_EMBEDDING_CONFIG.openai?.model).toBe('text-embedding-3-small');
		expect(DEFAULT_EMBEDDING_CONFIG.openai?.dimensions).toBe(384);
		expect(DEFAULT_EMBEDDING_CONFIG.transformersJs?.modelId).toBe('Xenova/gte-small');
		expect(DEFAULT_EMBEDDING_CONFIG.xenovaOnnx?.modelId).toBe('Xenova/gte-small');
	});

	it('should compute cosineSimilarity correctly', () => {
		const a = [1, 0, 0];
		const b = [1, 0, 0];
		expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);

		const c = [1, 0, 0];
		const d = [0, 1, 0];
		expect(cosineSimilarity(c, d)).toBeCloseTo(0.0);

		const e = [1, 0, 0];
		const f = [-1, 0, 0];
		expect(cosineSimilarity(e, f)).toBeCloseTo(-1.0);
	});

	it('should handle zero vectors in cosineSimilarity', () => {
		expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
		expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
	});

	it('should throw EmbeddingModelNotAvailableError with correct name', () => {
		const err = new EmbeddingModelNotAvailableError();
		expect(err.name).toBe('EmbeddingModelNotAvailableError');
		expect(err.message).toBe('Embedding model is not available');
		expect(err).toBeInstanceOf(Error);
	});

	it('should accept custom message for EmbeddingModelNotAvailableError', () => {
		const err = new EmbeddingModelNotAvailableError('custom msg');
		expect(err.message).toBe('custom msg');
	});

	// Type-level checks (these are compile-time tests — if they compile, they pass)
	it('should accept valid provider IDs', () => {
		const ids: EmbeddingProviderId[] = ['transformers-js', 'ollama', 'openai', 'xenova-onnx'];
		expect(ids).toHaveLength(4);
	});

	it('should allow partial config for EmbeddingProviderConfig', () => {
		const config: EmbeddingProviderConfig = {
			providerId: 'ollama',
			enabled: true,
			ollama: { baseUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
		};
		expect(config.providerId).toBe('ollama');
	});
});
