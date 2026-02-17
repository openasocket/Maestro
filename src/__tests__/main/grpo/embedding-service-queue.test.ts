/**
 * Tests for the inference serialization queue in embedding-service.ts.
 * Verifies that concurrent encode() calls are serialized, not parallel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @huggingface/transformers before import
const mockPipeline = vi.fn();
vi.mock('@huggingface/transformers', () => ({
	pipeline: mockPipeline,
	env: { cacheDir: '/tmp/test-cache' },
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

/**
 * Helper: creates a mock embedder function with a dispose() method,
 * so the embedding-service module can call instance.dispose() in cleanup.
 */
function createMockEmbedder(impl: (...args: any[]) => any) {
	const fn = vi.fn().mockImplementation(impl);
	return Object.assign(fn, { dispose: vi.fn() });
}

describe('EmbeddingService inference serialization', () => {
	let embeddingService: typeof import('../../../main/grpo/embedding-service');

	beforeEach(async () => {
		mockPipeline.mockClear();
		vi.resetModules();
		// Re-import to get fresh module-level state
		embeddingService = await import('../../../main/grpo/embedding-service');
	});

	afterEach(async () => {
		await embeddingService.dispose();
	});

	it('should serialize concurrent encode() calls', async () => {
		const callOrder: number[] = [];
		let callCount = 0;

		const mockEmbedder = createMockEmbedder(async () => {
			const myIndex = callCount++;
			callOrder.push(myIndex);
			// Simulate ONNX inference delay
			await new Promise(resolve => setTimeout(resolve, 50));
			callOrder.push(myIndex + 100); // 100+ marks completion
			return { data: new Float32Array(384) };
		});

		mockPipeline.mockResolvedValue(mockEmbedder);

		// Fire 3 concurrent encode calls
		const results = await Promise.all([
			embeddingService.encode('text1'),
			embeddingService.encode('text2'),
			embeddingService.encode('text3'),
		]);

		// All should resolve
		expect(results).toHaveLength(3);
		results.forEach(r => expect(r).toBeInstanceOf(Float32Array));

		// Verify serialization: each call should complete before next starts
		// callOrder should be [0, 100, 1, 101, 2, 102] not [0, 1, 2, 100, 101, 102]
		for (let i = 0; i < callOrder.length - 1; i += 2) {
			const startIdx = callOrder[i];
			const endIdx = callOrder[i + 1];
			expect(endIdx).toBe(startIdx + 100);
		}
	});

	it('should propagate errors without breaking the queue', async () => {
		let callIndex = 0;
		const mockEmbedder = createMockEmbedder(async () => {
			const idx = callIndex++;
			if (idx === 1) throw new Error('ONNX inference failed');
			return { data: new Float32Array(384) };
		});

		mockPipeline.mockResolvedValue(mockEmbedder);

		const p1 = embeddingService.encode('text1');
		const p2 = embeddingService.encode('text2'); // will fail
		const p3 = embeddingService.encode('text3'); // should still work

		const r1 = await p1;
		expect(r1).toBeInstanceOf(Float32Array);

		await expect(p2).rejects.toThrow('ONNX inference failed');

		const r3 = await p3;
		expect(r3).toBeInstanceOf(Float32Array);
	});

	it('should reset the queue on dispose()', async () => {
		const mockEmbedder = createMockEmbedder(async () => {
			return { data: new Float32Array(384) };
		});
		mockPipeline.mockResolvedValue(mockEmbedder);

		// Load model
		await embeddingService.encode('test');

		// Dispose
		await embeddingService.dispose();

		// Subsequent encode should work (re-initializes model)
		const mockEmbedder2 = createMockEmbedder(async () => {
			return { data: new Float32Array(384) };
		});
		mockPipeline.mockResolvedValue(mockEmbedder2);

		const result = await embeddingService.encode('test2');
		expect(result).toBeInstanceOf(Float32Array);
	});

	it('should serialize encodeBatch() with encode()', async () => {
		const callOrder: string[] = [];

		const mockEmbedder = createMockEmbedder(async (input: string | string[]) => {
			const label = Array.isArray(input) ? 'batch' : 'single';
			callOrder.push(`${label}-start`);
			await new Promise(resolve => setTimeout(resolve, 30));
			callOrder.push(`${label}-end`);
			const count = Array.isArray(input) ? input.length : 1;
			return { data: new Float32Array(384 * count) };
		});

		mockPipeline.mockResolvedValue(mockEmbedder);

		await Promise.all([
			embeddingService.encode('single'),
			embeddingService.encodeBatch(['batch1', 'batch2']),
		]);

		// Should be serialized: single completes before batch starts
		expect(callOrder).toEqual([
			'single-start', 'single-end',
			'batch-start', 'batch-end',
		]);
	});

	it('encodeBatch with empty array should skip the queue', async () => {
		const result = await embeddingService.encodeBatch([]);
		expect(result).toEqual([]);
		// Pipeline should never have been called (no model loading needed)
		expect(mockPipeline).not.toHaveBeenCalled();
	});
});
