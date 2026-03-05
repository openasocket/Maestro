/**
 * Embedding Provider Types and Interfaces
 *
 * Defines the abstraction layer for embedding providers (Transformers.js, Ollama,
 * OpenAI, Xenova ONNX). Providers produce 384-dim vectors for the memory system's
 * semantic search, persona matching, and skill matching.
 */

// Re-export config types from shared (used by both main and renderer)
export type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../shared/memory-types';
export { DEFAULT_EMBEDDING_CONFIG } from '../../shared/memory-types';

/** Dimensionality of the embedding vectors used throughout the system. */
export const VECTOR_DIM = 384;

// ─── Provider Interface ──────────────────────────────────────────────────

import type { EmbeddingProviderId, EmbeddingProviderConfig } from '../../shared/memory-types';

export interface EmbeddingProvider {
	readonly id: EmbeddingProviderId;
	readonly name: string;
	readonly isLocal: boolean;
	readonly nativeDimension: number;

	/** Initialize the provider (load model, verify connection, etc.) */
	initialize(config: EmbeddingProviderConfig): Promise<void>;

	/** Check if the provider is ready to serve embeddings */
	isReady(): boolean;

	/** Encode a single text into a VECTOR_DIM embedding */
	encode(text: string): Promise<number[]>;

	/** Encode multiple texts into VECTOR_DIM embeddings */
	encodeBatch(texts: string[]): Promise<number[][]>;

	/** Shut down the provider (unload model, close connections) */
	dispose(): Promise<void>;

	/** Get provider status for UI display */
	getStatus(): EmbeddingProviderStatus;
}

// ─── Status & Events ─────────────────────────────────────────────────────

export interface EmbeddingProviderStatus {
	ready: boolean;
	modelName: string;
	error?: string;
	/** For cloud providers: estimated cost per 1M tokens */
	costPerMillionTokens?: number;
}

/** Usage event emitted after each embedding operation */
export interface EmbeddingUsageEvent {
	providerId: EmbeddingProviderId;
	tokenCount: number;
	textCount: number;
	durationMs: number;
	costUsd?: number;
	timestamp: number;
}

// ─── Error ────────────────────────────────────────────────────────────────

export class EmbeddingModelNotAvailableError extends Error {
	constructor(message = 'Embedding model is not available') {
		super(message);
		this.name = 'EmbeddingModelNotAvailableError';
	}
}

// ─── Utilities ────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors.
 * Returns a value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
