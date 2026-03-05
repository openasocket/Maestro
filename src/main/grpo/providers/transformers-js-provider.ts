/**
 * Transformers.js Embedding Provider
 *
 * Uses @xenova/transformers to run ONNX models in-process via WASM.
 * Default model: Xenova/gte-small (384-dim, ~67MB quantized).
 * Zero external dependencies — works on all platforms.
 */

import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
	DownloadProgressEvent,
} from '../embedding-types';
import type { EmbeddingProviderConfig } from '../../../shared/memory-types';
import { VECTOR_DIM } from '../embedding-types';

export type ProgressCallback = (event: DownloadProgressEvent) => void;

export class TransformersJsProvider implements EmbeddingProvider {
	readonly id = 'transformers-js' as const;
	readonly name = 'Transformers.js (Local)';
	readonly isLocal = true;
	readonly nativeDimension = 384;

	private pipeline: any = null;
	private ready = false;
	private error: string | null = null;
	private modelId = 'Xenova/gte-small';
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
			modelId: this.modelId,
			progress,
			status,
			message,
		});
	}

	async initialize(config: EmbeddingProviderConfig): Promise<void> {
		const modelId = config.transformersJs?.modelId ?? 'Xenova/gte-small';
		this.modelId = modelId;

		try {
			this.emitProgress('downloading', 0, `Preparing ${modelId}...`);

			// Dynamic import to avoid loading the heavy module unless needed
			const { pipeline, env } = await import('@xenova/transformers');

			// Configure cache directory for Electron
			if (config.transformersJs?.cacheDir) {
				env.cacheDir = config.transformersJs.cacheDir;
			}

			this.emitProgress('downloading', 0.1, `Loading model ${modelId}...`);

			// Build pipeline options with progress callback if available
			const pipelineOpts: Record<string, unknown> = { quantized: true };
			if (this.onProgress) {
				pipelineOpts.progress_callback = (progressData: {
					status?: string;
					progress?: number;
					file?: string;
				}) => {
					if (progressData.status === 'progress' && typeof progressData.progress === 'number') {
						// Map download progress to 0.1–0.9 range
						const mapped = 0.1 + (progressData.progress / 100) * 0.8;
						this.emitProgress('downloading', mapped, progressData.file ?? undefined);
					} else if (progressData.status === 'done') {
						this.emitProgress('loading', 0.95, 'Finalizing model...');
					}
				};
			}

			// Load the feature-extraction pipeline
			this.pipeline = await pipeline('feature-extraction', modelId, pipelineOpts);

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
		if (!this.pipeline) throw new Error('TransformersJs not initialized');
		const output = await this.pipeline(text, { pooling: 'mean', normalize: true });
		// output.data is a Float32Array; convert to number[] and truncate to VECTOR_DIM
		const embedding = Array.from(output.data as Float32Array).slice(0, VECTOR_DIM);
		return embedding;
	}

	async encodeBatch(texts: string[]): Promise<number[][]> {
		if (!this.pipeline) throw new Error('TransformersJs not initialized');
		const BATCH_SIZE = 32;
		const results: number[][] = [];
		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const output = await this.pipeline(batch, { pooling: 'mean', normalize: true });
			// output shape: [batch_size, dim] — data is a flat Float32Array
			for (let j = 0; j < batch.length; j++) {
				const start = j * this.nativeDimension;
				const embedding = Array.from(
					(output.data as Float32Array).slice(start, start + VECTOR_DIM)
				);
				results.push(embedding);
			}
		}
		return results;
	}

	async dispose(): Promise<void> {
		this.pipeline = null;
		this.ready = false;
	}

	getStatus(): EmbeddingProviderStatus {
		return {
			ready: this.ready,
			modelName: this.modelId,
			error: this.error ?? undefined,
		};
	}
}
