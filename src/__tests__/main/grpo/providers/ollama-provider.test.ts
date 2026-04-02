/**
 * Tests for OllamaEmbeddingProvider
 *
 * Mocks fetch to avoid requiring a real Ollama instance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VECTOR_DIM } from '../../../../main/grpo/embedding-types';
import { DEFAULT_EMBEDDING_CONFIG } from '../../../../shared/memory-types';
import type { EmbeddingProviderConfig } from '../../../../shared/memory-types';
import { OllamaEmbeddingProvider } from '../../../../main/grpo/providers/ollama-provider';

function makeEmbedding(dim: number, value = 0.1): number[] {
	return new Array(dim).fill(value);
}

/** Helper to build a config with Ollama settings */
function ollamaConfig(overrides?: Partial<EmbeddingProviderConfig>): EmbeddingProviderConfig {
	return {
		...DEFAULT_EMBEDDING_CONFIG,
		providerId: 'ollama',
		enabled: true,
		...overrides,
	};
}

describe('OllamaEmbeddingProvider', () => {
	let provider: OllamaEmbeddingProvider;
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		provider = new OllamaEmbeddingProvider();
		fetchSpy = vi.spyOn(globalThis, 'fetch');
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	/** Mock a successful Ollama flow: /api/tags (model present) + /api/embed (test) */
	function mockOllamaReady(model = 'nomic-embed-text-v2-moe', embedDim = 768) {
		fetchSpy.mockImplementation(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/api/tags')) {
				return new Response(JSON.stringify({ models: [{ name: `${model}:latest` }] }), {
					status: 200,
				});
			}
			if (url.endsWith('/api/embed')) {
				return new Response(JSON.stringify({ embeddings: [makeEmbedding(embedDim)] }), {
					status: 200,
				});
			}
			return new Response('Not Found', { status: 404 });
		});
	}

	it('should have correct static properties', () => {
		expect(provider.id).toBe('ollama');
		expect(provider.name).toBe('Ollama (Local)');
		expect(provider.isLocal).toBe(true);
		expect(provider.nativeDimension).toBe(768);
	});

	it('should initialize successfully when Ollama responds', async () => {
		mockOllamaReady();
		await provider.initialize(ollamaConfig());

		expect(provider.isReady()).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(2); // tags + embed test
	});

	it('should detect missing model and attempt to pull', async () => {
		let pullCalled = false;
		fetchSpy.mockImplementation(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/api/tags')) {
				return new Response(JSON.stringify({ models: [] }), { status: 200 });
			}
			if (url.endsWith('/api/pull')) {
				pullCalled = true;
				// Simulate streaming response with no body reader
				return new Response(JSON.stringify({ status: 'success' }), { status: 200 });
			}
			if (url.endsWith('/api/embed')) {
				return new Response(JSON.stringify({ embeddings: [makeEmbedding(768)] }), { status: 200 });
			}
			return new Response('Not Found', { status: 404 });
		});

		await provider.initialize(ollamaConfig());
		expect(pullCalled).toBe(true);
		expect(provider.isReady()).toBe(true);
	});

	it('should encode and return 384-dim array from 768-dim input (truncation)', async () => {
		mockOllamaReady('nomic-embed-text-v2-moe', 768);
		await provider.initialize(ollamaConfig());

		const result = await provider.encode('hello world');
		expect(result).toHaveLength(VECTOR_DIM);
	});

	it('should encode and return 384-dim array from 384-dim input (pass-through)', async () => {
		mockOllamaReady('gte-small', 384);
		await provider.initialize(
			ollamaConfig({ ollama: { baseUrl: 'http://localhost:11434', model: 'gte-small' } })
		);

		const result = await provider.encode('hello world');
		expect(result).toHaveLength(VECTOR_DIM);
	});

	it('should handle encodeBatch with multiple texts', async () => {
		fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/api/tags')) {
				return new Response(
					JSON.stringify({ models: [{ name: 'nomic-embed-text-v2-moe:latest' }] }),
					{ status: 200 }
				);
			}
			if (url.endsWith('/api/embed')) {
				const body = JSON.parse((init?.body as string) ?? '{}');
				const count = Array.isArray(body.input) ? body.input.length : 1;
				const embeddings = Array.from({ length: count }, () => makeEmbedding(768));
				return new Response(JSON.stringify({ embeddings }), { status: 200 });
			}
			return new Response('Not Found', { status: 404 });
		});

		await provider.initialize(ollamaConfig());

		const texts = ['hello', 'world', 'foo', 'bar'];
		const results = await provider.encodeBatch(texts);

		expect(results).toHaveLength(4);
		for (const emb of results) {
			expect(emb).toHaveLength(VECTOR_DIM);
		}
	});

	it('should fail gracefully when Ollama is not running', async () => {
		fetchSpy.mockRejectedValue(new Error('fetch failed'));

		await expect(provider.initialize(ollamaConfig())).rejects.toThrow('fetch failed');
		expect(provider.isReady()).toBe(false);
	});

	it('should report error correctly in getStatus', async () => {
		fetchSpy.mockRejectedValue(new Error('Connection refused'));

		await expect(provider.initialize(ollamaConfig())).rejects.toThrow();

		const status = provider.getStatus();
		expect(status.ready).toBe(false);
		expect(status.error).toBe('Connection refused');
		expect(status.modelName).toBe('nomic-embed-text-v2-moe');
	});

	it('should throw when encode called without initialization', async () => {
		await expect(provider.encode('test')).rejects.toThrow('Ollama provider not initialized');
	});

	it('should throw when encodeBatch called without initialization', async () => {
		await expect(provider.encodeBatch(['test'])).rejects.toThrow('Ollama provider not initialized');
	});

	it('should dispose and set ready to false', async () => {
		mockOllamaReady();
		await provider.initialize(ollamaConfig());
		expect(provider.isReady()).toBe(true);

		await provider.dispose();
		expect(provider.isReady()).toBe(false);
	});

	it('should use custom baseUrl and model from config', async () => {
		const customUrl = 'http://remote-ollama:11434';
		fetchSpy.mockImplementation(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url === `${customUrl}/api/tags`) {
				return new Response(JSON.stringify({ models: [{ name: 'mxbai-embed-large:latest' }] }), {
					status: 200,
				});
			}
			if (url === `${customUrl}/api/embed`) {
				return new Response(JSON.stringify({ embeddings: [makeEmbedding(1024)] }), { status: 200 });
			}
			return new Response('Not Found', { status: 404 });
		});

		await provider.initialize(
			ollamaConfig({
				ollama: { baseUrl: customUrl, model: 'mxbai-embed-large' },
			})
		);

		expect(provider.isReady()).toBe(true);
		const status = provider.getStatus();
		expect(status.modelName).toBe('mxbai-embed-large');
	});

	describe('progress callbacks', () => {
		it('should emit progress events during initialization', async () => {
			mockOllamaReady();
			const events: any[] = [];
			provider.setProgressCallback((event) => events.push(event));

			await provider.initialize(ollamaConfig());

			expect(events.length).toBeGreaterThanOrEqual(3);
			expect(events[0].status).toBe('downloading');
			expect(events[events.length - 1].status).toBe('ready');
			expect(events[events.length - 1].progress).toBe(1.0);
		});

		it('should emit error progress on initialization failure', async () => {
			fetchSpy.mockRejectedValue(new Error('Network error'));
			const events: any[] = [];
			provider.setProgressCallback((event) => events.push(event));

			await expect(provider.initialize(ollamaConfig())).rejects.toThrow();

			const lastEvent = events[events.length - 1];
			expect(lastEvent.status).toBe('error');
			expect(lastEvent.message).toBe('Network error');
		});
	});

	describe('dimension projection', () => {
		it('should truncate embeddings longer than VECTOR_DIM', async () => {
			mockOllamaReady('nomic-embed-text-v2-moe', 1024);
			await provider.initialize(ollamaConfig());

			const result = await provider.encode('test');
			expect(result).toHaveLength(VECTOR_DIM);
		});

		it('should pad embeddings shorter than VECTOR_DIM with zeros', async () => {
			mockOllamaReady('tiny-model', 128);
			await provider.initialize(
				ollamaConfig({ ollama: { baseUrl: 'http://localhost:11434', model: 'tiny-model' } })
			);

			const result = await provider.encode('test');
			expect(result).toHaveLength(VECTOR_DIM);
			// Last element should be 0 (padded)
			expect(result[VECTOR_DIM - 1]).toBe(0);
		});
	});
});
