/**
 * Embedding service — shared infrastructure for computing text embeddings.
 *
 * Provides encode() and encodeBatch() for computing 384-dim embeddings
 * using a local model. Used by both GRPO and Memory systems.
 *
 * Stub implementation — will be fully implemented in a future task.
 */

export class EmbeddingModelNotAvailableError extends Error {
	constructor(message = 'Embedding model is not available') {
		super(message);
		this.name = 'EmbeddingModelNotAvailableError';
	}
}

/**
 * Encode a single text into a 384-dim embedding vector.
 * Throws EmbeddingModelNotAvailableError if no model is loaded.
 */
export async function encode(_text: string): Promise<number[]> {
	throw new EmbeddingModelNotAvailableError();
}

/**
 * Encode multiple texts into 384-dim embedding vectors.
 * Throws EmbeddingModelNotAvailableError if no model is loaded.
 */
export async function encodeBatch(_texts: string[]): Promise<number[][]> {
	throw new EmbeddingModelNotAvailableError();
}

/** Dimensionality of the embedding vectors. */
export const VECTOR_DIM = 384;

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
