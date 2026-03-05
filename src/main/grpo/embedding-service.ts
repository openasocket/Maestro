/**
 * Embedding service — shared infrastructure for computing text embeddings.
 *
 * Routes encode() and encodeBatch() calls through the embedding registry.
 * Falls back to throwing EmbeddingModelNotAvailableError when no provider is active,
 * preserving the existing graceful degradation behavior.
 */

import { embeddingRegistry } from './embedding-registry';
import { EmbeddingModelNotAvailableError, VECTOR_DIM, cosineSimilarity } from './embedding-types';

// Re-export for backward compatibility — all existing callers import from this module
export { EmbeddingModelNotAvailableError, VECTOR_DIM, cosineSimilarity };

/**
 * Encode a single text into a 384-dim embedding vector.
 * Throws EmbeddingModelNotAvailableError if no provider is active.
 */
export async function encode(text: string): Promise<number[]> {
	if (!embeddingRegistry.isReady()) {
		throw new EmbeddingModelNotAvailableError();
	}
	return embeddingRegistry.getActive().encode(text);
}

/**
 * Encode multiple texts into 384-dim embedding vectors.
 * Throws EmbeddingModelNotAvailableError if no provider is active.
 */
export async function encodeBatch(texts: string[]): Promise<number[][]> {
	if (!embeddingRegistry.isReady()) {
		throw new EmbeddingModelNotAvailableError();
	}
	return embeddingRegistry.getActive().encodeBatch(texts);
}
