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

// ─── Provider Comparison ────────────────────────────────────────────────
//
// Provider         │ Trans.js          │ Ollama             │ OpenAI                │ Xenova/ONNX (deferred)
// ─────────────────┼───────────────────┼────────────────────┼───────────────────────┼───────────────────────
// Setup            │ Auto (WASM)       │ Requires Ollama    │ API key required      │ Auto (native addon)
// External Dep     │ None              │ Ollama daemon      │ None                  │ onnxruntime-node
// Platform         │ All               │ All                │ All                   │ All (needs rebuild)
// Offline          │ Yes (after DL)    │ Yes                │ No                    │ Yes (after DL)
// Cost             │ Free              │ Free               │ ~$0.02/1M tokens      │ Free
// Quality          │ Good              │ Good+              │ Best                  │ Good
// Model            │ Xenova/gte-small  │ nomic-embed-text   │ text-embedding-3-small│ Xenova/gte-small
// Native Dim       │ 384               │ 768                │ 1536                  │ 384
// Default          │ YES               │ No                 │ No                    │ No
//
// Recommendations:
// - Default/offline use: Transformers.js — zero config, runs in-process via WASM
// - Already using Ollama: Ollama provider — higher-quality nomic-embed-text (768-dim)
// - Quality-critical / large-scale: OpenAI — best embeddings, pay-per-use
// - Xenova/ONNX: Deferred — see note below
//
// 'xenova-onnx' provider evaluated but deferred — Transformers.js (@xenova/transformers v2)
// already uses ONNX Runtime under the hood (onnxruntime-web for WASM, with onnxruntime-node
// as an optional dependency for native performance). A separate onnxruntime-node provider
// would require independent tokenization (Transformers.js handles this automatically),
// adding significant implementation complexity. Additionally, native addons like
// onnxruntime-node require electron-rebuild and per-platform packaging steps that
// increase build fragility. Since Transformers.js provides equivalent functionality
// via WASM without these issues, the raw ONNX provider is deferred.
// Revisit if Transformers.js performance is insufficient for batch operations.

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

/** Progress event emitted during model download/loading */
export interface DownloadProgressEvent {
	providerId: EmbeddingProviderId;
	modelId: string;
	/** 0.0 to 1.0 */
	progress: number;
	status: 'downloading' | 'loading' | 'ready' | 'error';
	message?: string;
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
