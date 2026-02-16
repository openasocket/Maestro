/**
 * Tests for the EmbeddingService — sentence embedding model lifecycle management.
 *
 * Mocks @huggingface/transformers to avoid downloading models in CI.
 * Tests focus on: singleton behavior, model switching, vector operations,
 * encode/encodeBatch correctness, and lifecycle management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Track pipeline calls for singleton and model-switch verification
let pipelineCallCount = 0;
let lastModelId: string | null = null;
const mockDispose = vi.fn();

/**
 * Creates a mock pipeline that returns normalized 384-dim vectors.
 * Vectors are deterministic based on input text for reproducible similarity tests.
 */
function createMockPipeline() {
	return async (inputs: string | string[], options: { pooling: string; normalize: boolean }) => {
		const texts = Array.isArray(inputs) ? inputs : [inputs];
		const dim = 384;
		const allData = new Float32Array(texts.length * dim);

		for (let t = 0; t < texts.length; t++) {
			const text = texts[t];
			// Generate a deterministic vector based on text content
			// Use a simple hash-based seed for reproducibility
			let seed = 0;
			for (let i = 0; i < text.length; i++) {
				seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
			}

			const vec = new Float32Array(dim);
			for (let i = 0; i < dim; i++) {
				seed = (seed * 1103515245 + 12345) & 0x7fffffff;
				vec[i] = (seed / 0x7fffffff) * 2 - 1;
			}

			// Normalize if requested (mock the model's normalize behavior)
			if (options.normalize) {
				let mag = 0;
				for (let i = 0; i < dim; i++) mag += vec[i] * vec[i];
				mag = Math.sqrt(mag);
				for (let i = 0; i < dim; i++) vec[i] /= mag;
			}

			allData.set(vec, t * dim);
		}

		return { data: allData };
	};
}

// Mock @huggingface/transformers
vi.mock('@huggingface/transformers', () => ({
	pipeline: vi.fn(async (_task: string, modelId: string, _options: unknown) => {
		pipelineCallCount++;
		lastModelId = modelId;
		const fn = createMockPipeline();
		(fn as unknown as { dispose: typeof mockDispose }).dispose = mockDispose;
		return fn;
	}),
}));

// Import after mocks
import {
	encode,
	encodeBatch,
	cosineSimilarity,
	getActiveModelId,
	preloadModel,
	dispose,
	VECTOR_DIM,
} from '../../../main/grpo/embedding-service';

beforeEach(async () => {
	pipelineCallCount = 0;
	lastModelId = null;
	mockDispose.mockReset();
	// Ensure clean state before each test
	await dispose();
});

afterEach(async () => {
	await dispose();
});

describe('encode', () => {
	it('should return a Float32Array of length 384', async () => {
		const result = await encode('Hello world');
		expect(result).toBeInstanceOf(Float32Array);
		expect(result.length).toBe(VECTOR_DIM);
	});

	it('should return normalized vectors (magnitude ≈ 1.0)', async () => {
		const result = await encode('React component testing');
		let magnitude = 0;
		for (let i = 0; i < result.length; i++) {
			magnitude += result[i] * result[i];
		}
		magnitude = Math.sqrt(magnitude);
		expect(magnitude).toBeCloseTo(1.0, 3);
	});

	it('should return same vector for same input (deterministic)', async () => {
		const result1 = await encode('test input');
		const result2 = await encode('test input');
		for (let i = 0; i < result1.length; i++) {
			expect(result1[i]).toBe(result2[i]);
		}
	});

	it('should return different vectors for different inputs', async () => {
		const result1 = await encode('React component testing');
		const result2 = await encode('database migration scripts');
		let same = true;
		for (let i = 0; i < result1.length; i++) {
			if (result1[i] !== result2[i]) {
				same = false;
				break;
			}
		}
		expect(same).toBe(false);
	});
});

describe('encodeBatch', () => {
	it('should return empty array for empty input', async () => {
		const result = await encodeBatch([]);
		expect(result).toHaveLength(0);
	});

	it('should return same results as individual encode calls', async () => {
		const texts = ['first text', 'second text', 'third text'];
		const batchResults = await encodeBatch(texts);
		expect(batchResults).toHaveLength(3);

		for (let t = 0; t < texts.length; t++) {
			const individual = await encode(texts[t]);
			expect(batchResults[t].length).toBe(individual.length);
			for (let i = 0; i < individual.length; i++) {
				expect(batchResults[t][i]).toBeCloseTo(individual[i], 5);
			}
		}
	});

	it('should return Float32Arrays of length 384 for each text', async () => {
		const results = await encodeBatch(['a', 'b']);
		for (const r of results) {
			expect(r).toBeInstanceOf(Float32Array);
			expect(r.length).toBe(VECTOR_DIM);
		}
	});
});

describe('cosineSimilarity', () => {
	it('should return ~1.0 for identical vectors', () => {
		const vec = new Float32Array(384);
		// Create a normalized vector
		for (let i = 0; i < 384; i++) vec[i] = 1 / Math.sqrt(384);
		const sim = cosineSimilarity(vec, vec);
		expect(sim).toBeCloseTo(1.0, 3);
	});

	it('should return ~0.0 for orthogonal vectors', () => {
		const a = new Float32Array(384).fill(0);
		const b = new Float32Array(384).fill(0);
		// Two unit vectors along different axes
		a[0] = 1.0;
		b[1] = 1.0;
		const sim = cosineSimilarity(a, b);
		expect(sim).toBeCloseTo(0.0, 5);
	});

	it('should return ~-1.0 for opposite vectors', () => {
		const a = new Float32Array(384).fill(0);
		const b = new Float32Array(384).fill(0);
		a[0] = 1.0;
		b[0] = -1.0;
		const sim = cosineSimilarity(a, b);
		expect(sim).toBeCloseTo(-1.0, 5);
	});

	it('should handle arbitrary normalized vectors', () => {
		const a = new Float32Array(384);
		const b = new Float32Array(384);
		for (let i = 0; i < 384; i++) {
			a[i] = 1 / Math.sqrt(384);
			b[i] = 1 / Math.sqrt(384);
		}
		const sim = cosineSimilarity(a, b);
		expect(sim).toBeCloseTo(1.0, 3);
	});
});

describe('singleton behavior', () => {
	it('should load model only once for multiple encode calls', async () => {
		expect(pipelineCallCount).toBe(0);
		await encode('first call');
		expect(pipelineCallCount).toBe(1);
		await encode('second call');
		expect(pipelineCallCount).toBe(1); // still 1
		await encode('third call');
		expect(pipelineCallCount).toBe(1); // still 1
	});

	it('should handle concurrent encode calls with single model load', async () => {
		expect(pipelineCallCount).toBe(0);
		const [r1, r2] = await Promise.all([
			encode('concurrent one'),
			encode('concurrent two'),
		]);
		expect(pipelineCallCount).toBe(1); // only one pipeline loaded
		expect(r1.length).toBe(VECTOR_DIM);
		expect(r2.length).toBe(VECTOR_DIM);
	});
});

describe('model switching', () => {
	it('should dispose old model and load new one when switching', async () => {
		await encode('text', 'english');
		expect(pipelineCallCount).toBe(1);
		expect(getActiveModelId()).toBe('english');
		expect(lastModelId).toContain('all-MiniLM-L6-v2');

		await encode('text', 'multilingual');
		expect(pipelineCallCount).toBe(2); // new model loaded
		expect(getActiveModelId()).toBe('multilingual');
		expect(lastModelId).toContain('paraphrase-multilingual-MiniLM-L12-v2');
		expect(mockDispose).toHaveBeenCalledTimes(1); // old model disposed
	});

	it('should not reload when using same model', async () => {
		await encode('text', 'multilingual');
		expect(pipelineCallCount).toBe(1);
		await encode('text', 'multilingual');
		expect(pipelineCallCount).toBe(1); // no reload
		expect(mockDispose).not.toHaveBeenCalled();
	});
});

describe('getActiveModelId', () => {
	it('should return null before first encode', () => {
		expect(getActiveModelId()).toBeNull();
	});

	it('should return correct ID after encode with multilingual', async () => {
		await encode('test', 'multilingual');
		expect(getActiveModelId()).toBe('multilingual');
	});

	it('should return correct ID after encode with english', async () => {
		await encode('test', 'english');
		expect(getActiveModelId()).toBe('english');
	});

	it('should return null after dispose', async () => {
		await encode('test');
		expect(getActiveModelId()).not.toBeNull();
		await dispose();
		expect(getActiveModelId()).toBeNull();
	});
});

describe('preloadModel', () => {
	it('should load model without encoding anything', async () => {
		expect(pipelineCallCount).toBe(0);
		await preloadModel('english');
		expect(pipelineCallCount).toBe(1);
		expect(getActiveModelId()).toBe('english');
	});
});

describe('dispose', () => {
	it('should release resources', async () => {
		await encode('test');
		expect(getActiveModelId()).not.toBeNull();

		await dispose();
		expect(getActiveModelId()).toBeNull();
		expect(mockDispose).toHaveBeenCalledTimes(1);
	});

	it('should allow reloading after dispose', async () => {
		await encode('test');
		expect(pipelineCallCount).toBe(1);

		await dispose();
		expect(getActiveModelId()).toBeNull();

		await encode('test again');
		expect(pipelineCallCount).toBe(2); // reloaded
		expect(getActiveModelId()).toBe('multilingual');
	});

	it('should be safe to call multiple times', async () => {
		await encode('test');
		await dispose();
		await dispose(); // should not throw
		expect(getActiveModelId()).toBeNull();
	});
});
