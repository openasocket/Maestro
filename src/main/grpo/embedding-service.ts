/**
 * EmbeddingService — manages the sentence embedding model lifecycle.
 *
 * Supports two models (configurable via GRPOConfig.embeddingModel):
 * - 'multilingual' (default): paraphrase-multilingual-MiniLM-L12-v2 — 50+ languages, ~60 MB
 * - 'english': all-MiniLM-L6-v2 — English only, ~23 MB, faster
 *
 * Both produce 384-dim normalized vectors. Switching models invalidates
 * cached embeddings (different embedding spaces) — the ensureEmbeddings
 * migration in the experience store handles recomputation automatically.
 *
 * This is a production engineering extension (not from the paper).
 * The paper injects all experiences unconditionally. We add semantic
 * retrieval because production libraries outgrow the token budget.
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { logger } from '../utils/logger';

export type EmbeddingModelId = 'multilingual' | 'english';

const MODEL_REGISTRY: Record<EmbeddingModelId, { hfId: string; description: string }> = {
	'multilingual': {
		hfId: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
		description: '50+ languages, 118M params, ~60 MB int8, ~30-60ms CPU',
	},
	'english': {
		hfId: 'Xenova/all-MiniLM-L6-v2',
		description: 'English only, 22M params, ~23 MB int8, ~12-25ms CPU',
	},
};

const LOG_CONTEXT = '[EmbeddingService]';

export const VECTOR_DIM = 384; // Both models produce 384-dim vectors

let instance: FeatureExtractionPipeline | null = null;
let loadingPromise: Promise<FeatureExtractionPipeline> | null = null;
let activeModelId: EmbeddingModelId | null = null;

/**
 * Get or initialize the embedding pipeline (lazy singleton).
 * First call downloads the model and loads it into memory.
 * Subsequent calls return the cached instance immediately.
 *
 * If the requested model differs from the loaded one, the old
 * model is disposed and the new one is loaded.
 */
async function getEmbedder(modelId: EmbeddingModelId = 'multilingual'): Promise<FeatureExtractionPipeline> {
	// If model changed, dispose the old one
	if (instance && activeModelId !== modelId) {
		logger.debug(`Switching embedding model from ${activeModelId} to ${modelId}`, LOG_CONTEXT);
		await instance.dispose();
		instance = null;
		loadingPromise = null;
		activeModelId = null;
	}

	if (instance) return instance;
	if (loadingPromise) return loadingPromise;

	const model = MODEL_REGISTRY[modelId];
	logger.debug(`Loading embedding model: ${model.hfId}`, LOG_CONTEXT);

	loadingPromise = pipeline('feature-extraction', model.hfId, {
		dtype: 'q8',       // Use int8 ONNX variant
		revision: 'main',
	})
		.then((pipe) => {
			instance = pipe;
			activeModelId = modelId;
			loadingPromise = null;
			logger.debug(`Embedding model loaded: ${modelId}`, LOG_CONTEXT);
			return pipe;
		})
		.catch((err) => {
			loadingPromise = null;
			throw err;
		});

	return loadingPromise;
}

/**
 * Encode a single text string into a normalized 384-dim Float32Array.
 * Latency: ~30-60 ms multilingual, ~12-25 ms English-only (CPU, int8 quantized).
 */
export async function encode(text: string, modelId: EmbeddingModelId = 'multilingual'): Promise<Float32Array> {
	const embedder = await getEmbedder(modelId);
	const result = await embedder(text, { pooling: 'mean', normalize: true });
	return new Float32Array(result.data as Float32Array);
}

/**
 * Encode multiple texts in a single batch call.
 * More efficient than calling encode() in a loop.
 */
export async function encodeBatch(texts: string[], modelId: EmbeddingModelId = 'multilingual'): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	const embedder = await getEmbedder(modelId);
	const results = await embedder(texts, { pooling: 'mean', normalize: true });
	// Split the flat result into individual vectors
	const data = results.data as Float32Array;
	return texts.map((_, i) => new Float32Array(data.slice(i * VECTOR_DIM, (i + 1) * VECTOR_DIM)));
}

/**
 * Compute cosine similarity between two normalized vectors.
 * For pre-normalized vectors, cosine similarity = dot product.
 * ~30-50 ns per call for 384-dim vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

/**
 * Get the currently active model ID, or null if no model is loaded.
 * Used by the experience store to detect model changes and
 * invalidate cached embeddings.
 */
export function getActiveModelId(): EmbeddingModelId | null {
	return activeModelId;
}

/**
 * Preload the model during app startup (optional).
 * Call this from the main process initialization to avoid
 * the cold-start latency on the first agent spawn.
 */
export async function preloadModel(modelId: EmbeddingModelId = 'multilingual'): Promise<void> {
	await getEmbedder(modelId);
}

/**
 * Release model resources (for graceful shutdown).
 */
export async function dispose(): Promise<void> {
	if (instance) {
		await instance.dispose();
		instance = null;
		loadingPromise = null;
		activeModelId = null;
	}
}
