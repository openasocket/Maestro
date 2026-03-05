/**
 * OpenAI Embedding Provider
 *
 * Connects to OpenAI's REST API for cloud-based embedding generation.
 * Default model: text-embedding-3-small (1536-dim native, truncated to 384-dim
 * server-side via the `dimensions` parameter using Matryoshka representation learning).
 *
 * Emits usage events for cost tracking after each API call.
 */

import { EventEmitter } from 'events';
import type {
	EmbeddingProvider,
	EmbeddingProviderStatus,
	EmbeddingUsageEvent,
} from '../embedding-types';
import type { EmbeddingProviderConfig } from '../../../shared/memory-types';

/** Shared emitter for embedding usage events (cost tracking) */
export const embeddingUsageEmitter = new EventEmitter();

/** Cost per 1M tokens by model */
const COST_PER_MILLION: Record<string, number> = {
	'text-embedding-3-small': 0.02,
	'text-embedding-3-large': 0.13,
	'text-embedding-ada-002': 0.1,
};

interface OpenAIEmbeddingResponse {
	data: Array<{ embedding: number[] }>;
	usage: { prompt_tokens: number; total_tokens: number };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
	readonly id = 'openai' as const;
	readonly name = 'OpenAI (Cloud)';
	readonly isLocal = false;
	readonly nativeDimension = 1536;

	private apiKey = '';
	private model = 'text-embedding-3-small';
	private dimensions = 384;
	private baseUrl = 'https://api.openai.com/v1';
	private ready = false;
	private error: string | null = null;

	async initialize(config: EmbeddingProviderConfig): Promise<void> {
		this.apiKey = config.openai?.apiKey ?? '';
		this.model = config.openai?.model ?? 'text-embedding-3-small';
		this.dimensions = config.openai?.dimensions ?? 384;
		this.baseUrl = config.openai?.baseUrl ?? 'https://api.openai.com/v1';

		if (!this.apiKey) {
			this.error = 'OpenAI API key not configured';
			throw new Error(this.error);
		}

		try {
			const result = await this.callAPI(['test']);
			if (!result.embeddings.length) throw new Error('Empty response');
			this.ready = true;
			this.error = null;
		} catch (err: any) {
			this.ready = false;
			this.error = err.message;
			throw err;
		}
	}

	isReady(): boolean {
		return this.ready;
	}

	async encode(text: string): Promise<number[]> {
		if (!this.ready) throw new Error('OpenAI provider not initialized');
		const start = Date.now();
		const result = await this.callAPI([text]);
		this.emitUsage(result.usage, 1, Date.now() - start);
		return result.embeddings[0];
	}

	async encodeBatch(texts: string[]): Promise<number[][]> {
		if (!this.ready) throw new Error('OpenAI provider not initialized');
		const BATCH_SIZE = 2048;
		const allEmbeddings: number[][] = [];
		let totalTokens = 0;
		const start = Date.now();

		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batch = texts.slice(i, i + BATCH_SIZE);
			const result = await this.callAPI(batch);
			allEmbeddings.push(...result.embeddings);
			totalTokens += result.usage.total_tokens;
		}

		this.emitUsage(
			{ prompt_tokens: totalTokens, total_tokens: totalTokens },
			texts.length,
			Date.now() - start
		);
		return allEmbeddings;
	}

	getStatus(): EmbeddingProviderStatus {
		return {
			ready: this.ready,
			modelName: this.model,
			error: this.error ?? undefined,
			costPerMillionTokens: COST_PER_MILLION[this.model] ?? 0.02,
		};
	}

	async dispose(): Promise<void> {
		this.ready = false;
		this.apiKey = '';
	}

	private async callAPI(texts: string[]): Promise<{
		embeddings: number[][];
		usage: { prompt_tokens: number; total_tokens: number };
	}> {
		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				input: texts,
				dimensions: this.dimensions,
				encoding_format: 'float',
			}),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(`OpenAI API error ${response.status}: ${errorBody}`);
		}

		const data = (await response.json()) as OpenAIEmbeddingResponse;
		return {
			embeddings: data.data.map((d) => d.embedding),
			usage: data.usage,
		};
	}

	private emitUsage(
		usage: { prompt_tokens: number; total_tokens: number },
		textCount: number,
		durationMs: number
	): void {
		const costUsd = this.calculateCost(usage.total_tokens);
		embeddingUsageEmitter.emit('usage', {
			providerId: this.id,
			tokenCount: usage.total_tokens,
			textCount,
			durationMs,
			costUsd,
			timestamp: Date.now(),
		} satisfies EmbeddingUsageEvent);
	}

	private calculateCost(totalTokens: number): number {
		const costPerMillion = COST_PER_MILLION[this.model] ?? 0.02;
		return (totalTokens / 1_000_000) * costPerMillion;
	}
}
