/**
 * Embedding Usage CRUD Operations
 *
 * Handles insertion and aggregation of embedding API usage records
 * for cost tracking.
 */

import type Database from 'better-sqlite3';
import type { EmbeddingUsageEvent } from '../grpo/embedding-types';
import {
	CREATE_EMBEDDING_USAGE_SQL,
	CREATE_EMBEDDING_USAGE_INDEXES_SQL,
	runStatements,
} from './schema';
import { StatementCache, LOG_CONTEXT } from './utils';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();
let tableEnsured = false;

const INSERT_SQL = `
  INSERT INTO embedding_usage (provider_id, token_count, text_count, duration_ms, cost_usd, timestamp)
  VALUES (?, ?, ?, ?, ?, ?)
`;

export interface EmbeddingUsageSummary {
	totalTokens: number;
	totalCostUsd: number;
	totalTexts: number;
	avgDurationMs: number;
	byProvider: Record<string, { tokens: number; cost: number; texts: number }>;
}

export interface EmbeddingUsageBucket {
	bucket: number;
	tokens: number;
	cost: number;
}

/**
 * Ensure the embedding_usage table exists (idempotent, runs once per session).
 */
function ensureTable(db: Database.Database): void {
	if (tableEnsured) return;
	db.prepare(CREATE_EMBEDDING_USAGE_SQL).run();
	runStatements(db, CREATE_EMBEDDING_USAGE_INDEXES_SQL);
	tableEnsured = true;
}

/**
 * Insert a new embedding usage record
 */
export function insertEmbeddingUsage(db: Database.Database, event: EmbeddingUsageEvent): void {
	ensureTable(db);
	const stmt = stmtCache.get(db, INSERT_SQL);
	stmt.run(
		event.providerId,
		event.tokenCount,
		event.textCount,
		event.durationMs,
		event.costUsd ?? null,
		event.timestamp
	);
	logger.debug(
		`Recorded embedding usage: ${event.tokenCount} tokens from ${event.providerId}`,
		LOG_CONTEXT
	);
}

/**
 * Get aggregated embedding usage since a given timestamp
 */
export function getEmbeddingUsageSummary(
	db: Database.Database,
	since: number
): EmbeddingUsageSummary {
	const totalRow = db
		.prepare(
			`SELECT
				COALESCE(SUM(token_count), 0) AS totalTokens,
				COALESCE(SUM(cost_usd), 0) AS totalCostUsd,
				COALESCE(SUM(text_count), 0) AS totalTexts,
				COALESCE(AVG(duration_ms), 0) AS avgDurationMs
			FROM embedding_usage
			WHERE timestamp >= ?`
		)
		.get(since) as {
		totalTokens: number;
		totalCostUsd: number;
		totalTexts: number;
		avgDurationMs: number;
	};

	const providerRows = db
		.prepare(
			`SELECT
				provider_id,
				COALESCE(SUM(token_count), 0) AS tokens,
				COALESCE(SUM(cost_usd), 0) AS cost,
				COALESCE(SUM(text_count), 0) AS texts
			FROM embedding_usage
			WHERE timestamp >= ?
			GROUP BY provider_id`
		)
		.all(since) as Array<{ provider_id: string; tokens: number; cost: number; texts: number }>;

	const byProvider: Record<string, { tokens: number; cost: number; texts: number }> = {};
	for (const row of providerRows) {
		byProvider[row.provider_id] = {
			tokens: row.tokens,
			cost: row.cost,
			texts: row.texts,
		};
	}

	return {
		totalTokens: totalRow.totalTokens,
		totalCostUsd: totalRow.totalCostUsd,
		totalTexts: totalRow.totalTexts,
		avgDurationMs: totalRow.avgDurationMs,
		byProvider,
	};
}

/**
 * Get embedding usage grouped into time buckets
 */
export function getEmbeddingUsageTimeline(
	db: Database.Database,
	since: number,
	bucketMs: number
): EmbeddingUsageBucket[] {
	const rows = db
		.prepare(
			`SELECT
				(timestamp / ? * ?) AS bucket,
				COALESCE(SUM(token_count), 0) AS tokens,
				COALESCE(SUM(cost_usd), 0) AS cost
			FROM embedding_usage
			WHERE timestamp >= ?
			GROUP BY bucket
			ORDER BY bucket ASC`
		)
		.all(bucketMs, bucketMs, since) as Array<{ bucket: number; tokens: number; cost: number }>;

	return rows;
}

/**
 * Clear the statement cache (call when database connection is closed)
 */
export function clearEmbeddingUsageCache(): void {
	stmtCache.clear();
	tableEnsured = false;
}
