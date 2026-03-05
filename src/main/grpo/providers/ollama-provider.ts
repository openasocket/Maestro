/**
 * Ollama Embedding Provider
 *
 * Connects to Ollama's HTTP API for local embedding generation.
 * Default model: nomic-embed-text (768-dim, projected to 384-dim via truncation).
 * Supports batch embedding and automatic model pulling.
 */

import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
	DownloadProgressEvent,
} from '../embedding-types';
import type { EmbeddingProviderConfig } from '../../../shared/memory-types';
import { VECTOR_DIM } from '../embedding-types';

export type ProgressCallback = (event: DownloadProgressEvent) => void;

export class OllamaEmbeddingProvider implements EmbeddingProvider {
	readonly id = 'ollama' as const;
	readonly name = 'Ollama (Local)';
	readonly isLocal = true;
	readonly nativeDimension = 768;

	private baseUrl = 'http://localhost:11434';
	private model = 'nomic-embed-text';
	private ready = false;
	private error: string | null = null;
	private onProgress: ProgressCallback | null = null;

	/** Set a callback to receive download/loading progress events */
	setProgressCallback(callback: ProgressCallback | null): void {
		this.onProgress = callback;
	}

	private emitProgress(
		status: DownloadProgressEvent['status'],
		progress: number,
		message?: string
	): void {
		this.onProgress?.({
			providerId: this.id,
			modelId: this.model,
			progress,
			status,
			message,
		});
	}

	async initialize(config: EmbeddingProviderConfig): Promise<void> {
		this.baseUrl = config.ollama?.baseUrl ?? 'http://localhost:11434';
		this.model = config.ollama?.model ?? 'nomic-embed-text';

		try {
			this.emitProgress('downloading', 0, `Connecting to Ollama at ${this.baseUrl}...`);

			// 1. Check Ollama is running
			const tagsResponse = await fetch(`${this.baseUrl}/api/tags`);
			if (!tagsResponse.ok) throw new Error(`Ollama not reachable at ${this.baseUrl}`);

			// 2. Check if the model is available
			const tags = (await tagsResponse.json()) as { models?: { name: string }[] };
			const models: string[] = tags.models?.map((m) => m.name) ?? [];
			const modelAvailable = models.some(
				(name: string) => name === this.model || name.startsWith(this.model + ':')
			);

			if (!modelAvailable) {
				this.emitProgress('downloading', 0.1, `Pulling model ${this.model}...`);
				const pullResponse = await fetch(`${this.baseUrl}/api/pull`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: this.model }),
				});
				if (!pullResponse.ok) {
					throw new Error(`Failed to pull model ${this.model}: ${pullResponse.statusText}`);
				}
				await this.waitForPull(pullResponse);
			}

			this.emitProgress('loading', 0.9, 'Verifying embedding output...');

			// 3. Verify embedding works with a test string
			const testResult = await this.callEmbed('test');
			if (testResult.length === 0) throw new Error('Embedding returned empty vector');

			this.ready = true;
			this.error = null;
			this.emitProgress('ready', 1.0, 'Model ready');
		} catch (err: any) {
			this.ready = false;
			this.error = err.message;
			this.emitProgress('error', 0, err.message);
			throw err;
		}
	}

	isReady(): boolean {
		return this.ready;
	}

	async encode(text: string): Promise<number[]> {
		if (!this.ready) throw new Error('Ollama provider not initialized');
		return this.callEmbed(text);
	}

	async encodeBatch(texts: string[]): Promise<number[][]> {
		if (!this.ready) throw new Error('Ollama provider not initialized');
		const BATCH_SIZE = 64;
		const results: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const response = await fetch(`${this.baseUrl}/api/embed`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model: this.model, input: batch }),
			});
			if (!response.ok) throw new Error(`Ollama batch embed failed: ${response.statusText}`);
			const data = (await response.json()) as { embeddings?: number[][] };
			for (const emb of data.embeddings ?? []) {
				results.push(this.projectToTargetDim(emb));
			}
		}
		return results;
	}

	async dispose(): Promise<void> {
		this.ready = false;
	}

	getStatus(): EmbeddingProviderStatus {
		return {
			ready: this.ready,
			modelName: this.model,
			error: this.error ?? undefined,
		};
	}

	private async callEmbed(text: string): Promise<number[]> {
		const response = await fetch(`${this.baseUrl}/api/embed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: this.model, input: text }),
		});
		if (!response.ok) throw new Error(`Ollama embed failed: ${response.statusText}`);
		const data = (await response.json()) as { embeddings?: number[][] };
		const rawEmbedding: number[] = data.embeddings?.[0] ?? [];
		return this.projectToTargetDim(rawEmbedding);
	}

	private projectToTargetDim(embedding: number[]): number[] {
		if (embedding.length === VECTOR_DIM) return embedding;
		if (embedding.length > VECTOR_DIM) {
			// Truncate to VECTOR_DIM (Matryoshka-style dimension reduction)
			return embedding.slice(0, VECTOR_DIM);
		}
		// Pad with zeros if somehow shorter
		return [...embedding, ...new Array(VECTOR_DIM - embedding.length).fill(0)];
	}

	private async waitForPull(response: Response): Promise<void> {
		const reader = response.body?.getReader();
		if (!reader) return;
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			// Parse streaming JSON lines for progress
			for (const line of text.split('\n').filter(Boolean)) {
				try {
					const progress = JSON.parse(line);
					if (
						typeof progress.completed === 'number' &&
						typeof progress.total === 'number' &&
						progress.total > 0
					) {
						const pct = 0.1 + (progress.completed / progress.total) * 0.8;
						this.emitProgress('downloading', pct, progress.status ?? undefined);
					}
				} catch {
					// Ignore malformed JSON lines
				}
			}
		}
	}
}
