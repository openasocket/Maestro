/**
 * Tests for embedding usage CRUD operations and aggregation.
 *
 * Uses mocked better-sqlite3 to verify insertion, summary aggregation,
 * and timeline bucketing without requiring the native module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(() => ({ totalTokens: 0, totalCostUsd: 0, totalTexts: 0, avgDurationMs: 0 })),
	all: vi.fn(() => []),
};

const mockDb = {
	pragma: vi.fn(() => [{ user_version: 0 }]),
	prepare: vi.fn(() => mockStatement),
	close: vi.fn(),
	transaction: vi.fn((fn: () => void) => {
		return () => fn();
	}),
};

vi.mock('better-sqlite3', () => {
	return {
		default: class MockDatabase {
			constructor(_dbPath: string) {}
			pragma = mockDb.pragma;
			prepare = mockDb.prepare;
			close = mockDb.close;
			transaction = mockDb.transaction;
		},
	};
});

const mockUserDataPath = path.join(os.tmpdir(), 'maestro-test-embedding-usage');
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') return mockUserDataPath;
			return os.tmpdir();
		}),
	},
}));

vi.mock('fs', () => ({
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	copyFileSync: vi.fn(),
	unlinkSync: vi.fn(),
	renameSync: vi.fn(),
	statSync: vi.fn(() => ({ size: 1024 })),
	readFileSync: vi.fn(() => '0'),
	writeFileSync: vi.fn(),
	readdirSync: vi.fn(() => []),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('Embedding usage tracking', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.pragma.mockReturnValue([{ user_version: 0 }]);
		mockDb.prepare.mockReturnValue(mockStatement);
		mockStatement.run.mockReturnValue({ changes: 1 });
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe('insertEmbeddingUsage', () => {
		it('should insert an embedding usage event with all fields', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			mockStatement.run.mockClear();

			db.insertEmbeddingUsage({
				providerId: 'openai',
				tokenCount: 1500,
				textCount: 3,
				durationMs: 250,
				costUsd: 0.00003,
				timestamp: 1700000000000,
			});

			// Find the INSERT call for embedding_usage
			const insertCalls = mockDb.prepare.mock.calls.filter((call) =>
				(call[0] as string).includes('INSERT INTO embedding_usage')
			);
			expect(insertCalls.length).toBeGreaterThan(0);

			// Verify the run call parameters
			const lastRun = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(lastRun[0]).toBe('openai'); // provider_id
			expect(lastRun[1]).toBe(1500); // token_count
			expect(lastRun[2]).toBe(3); // text_count
			expect(lastRun[3]).toBe(250); // duration_ms
			expect(lastRun[4]).toBe(0.00003); // cost_usd
			expect(lastRun[5]).toBe(1700000000000); // timestamp
		});

		it('should handle null costUsd for local providers', async () => {
			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			mockStatement.run.mockClear();

			db.insertEmbeddingUsage({
				providerId: 'transformers-js',
				tokenCount: 500,
				textCount: 1,
				durationMs: 100,
				timestamp: 1700000000000,
			});

			const lastRun = mockStatement.run.mock.calls[mockStatement.run.mock.calls.length - 1];
			expect(lastRun[4]).toBeNull(); // cost_usd should be null
		});
	});

	describe('getEmbeddingUsageSummary', () => {
		it('should return aggregated totals and per-provider breakdown', async () => {
			// First call for totals, second for per-provider
			let callIndex = 0;
			mockDb.prepare.mockImplementation((sql: string) => {
				if ((sql as string).includes('SUM(token_count)') && !(sql as string).includes('GROUP BY')) {
					return {
						...mockStatement,
						get: vi.fn(() => ({
							totalTokens: 5000,
							totalCostUsd: 0.0001,
							totalTexts: 10,
							avgDurationMs: 125,
						})),
					};
				}
				if ((sql as string).includes('GROUP BY provider_id')) {
					return {
						...mockStatement,
						all: vi.fn(() => [
							{ provider_id: 'openai', tokens: 3000, cost: 0.00006, texts: 6 },
							{ provider_id: 'transformers-js', tokens: 2000, cost: 0, texts: 4 },
						]),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const summary = db.getEmbeddingUsageSummary(0);

			expect(summary.totalTokens).toBe(5000);
			expect(summary.totalCostUsd).toBe(0.0001);
			expect(summary.totalTexts).toBe(10);
			expect(summary.avgDurationMs).toBe(125);
			expect(summary.byProvider['openai']).toEqual({
				tokens: 3000,
				cost: 0.00006,
				texts: 6,
			});
			expect(summary.byProvider['transformers-js']).toEqual({
				tokens: 2000,
				cost: 0,
				texts: 4,
			});
		});

		it('should return zeros when no usage data exists', async () => {
			mockDb.prepare.mockImplementation((sql: string) => {
				if ((sql as string).includes('SUM(token_count)') && !(sql as string).includes('GROUP BY')) {
					return {
						...mockStatement,
						get: vi.fn(() => ({
							totalTokens: 0,
							totalCostUsd: 0,
							totalTexts: 0,
							avgDurationMs: 0,
						})),
					};
				}
				if ((sql as string).includes('GROUP BY provider_id')) {
					return {
						...mockStatement,
						all: vi.fn(() => []),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const summary = db.getEmbeddingUsageSummary(0);

			expect(summary.totalTokens).toBe(0);
			expect(summary.totalCostUsd).toBe(0);
			expect(summary.totalTexts).toBe(0);
			expect(summary.byProvider).toEqual({});
		});
	});

	describe('getEmbeddingUsageTimeline', () => {
		it('should return usage grouped into time buckets', async () => {
			const HOUR = 3600000;
			mockDb.prepare.mockImplementation((sql: string) => {
				if ((sql as string).includes('bucket')) {
					return {
						...mockStatement,
						all: vi.fn(() => [
							{ bucket: 1700000000000, tokens: 1000, cost: 0.00002 },
							{ bucket: 1700000000000 + HOUR, tokens: 2000, cost: 0.00004 },
							{ bucket: 1700000000000 + 2 * HOUR, tokens: 500, cost: 0.00001 },
						]),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const timeline = db.getEmbeddingUsageTimeline(0, HOUR);

			expect(timeline).toHaveLength(3);
			expect(timeline[0].bucket).toBe(1700000000000);
			expect(timeline[0].tokens).toBe(1000);
			expect(timeline[0].cost).toBe(0.00002);
			expect(timeline[1].tokens).toBe(2000);
			expect(timeline[2].tokens).toBe(500);
		});

		it('should return empty array when no data exists', async () => {
			mockDb.prepare.mockImplementation((sql: string) => {
				if ((sql as string).includes('bucket')) {
					return {
						...mockStatement,
						all: vi.fn(() => []),
					};
				}
				return mockStatement;
			});

			const { StatsDB } = await import('../../../main/stats');
			const db = new StatsDB();
			db.initialize();

			const timeline = db.getEmbeddingUsageTimeline(0, 3600000);

			expect(timeline).toEqual([]);
		});
	});
});
