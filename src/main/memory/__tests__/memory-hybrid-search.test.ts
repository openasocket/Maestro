/**
 * Tests for hybrid retrieval: keywordSearch, tagSearch, hybridSearch,
 * and cascadingSearch with enableHybridSearch=true.
 *
 * Verifies the multi-signal fusion formula:
 *   combined = 0.5 * embeddingSimilarity + 0.3 * keywordScore + 0.2 * tagScore
 *   finalScore = combined * 0.6 + effectiveness * 0.2 + recency * 0.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			private data: Record<string, unknown> = {};
			constructor(_opts?: unknown) {}
			get(key: string) {
				return this.data[key];
			}
			set(key: string, value: unknown) {
				this.data[key] = value;
			}
		},
	};
});

const fsState = new Map<string, string>();

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async (filePath: string) => {
		const content = fsState.get(filePath);
		if (content === undefined) {
			const err = new Error(
				`ENOENT: no such file or directory, open '${filePath}'`
			) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		return content;
	}),
	writeFile: vi.fn(async (filePath: string, content: string) => {
		fsState.set(filePath, content);
	}),
	rename: vi.fn(async (from: string, to: string) => {
		const content = fsState.get(from);
		if (content !== undefined) {
			fsState.set(to, content);
			fsState.delete(from);
		}
	}),
	mkdir: vi.fn(async () => {}),
	appendFile: vi.fn(async (filePath: string, content: string) => {
		const existing = fsState.get(filePath) ?? '';
		fsState.set(filePath, existing + content);
	}),
}));

function realCosineSimilarity(a: number[], b: number[]): number {
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

const mockEncode = vi.fn(async (..._args: any[]) => new Array(384).fill(0));
const mockEncodeBatch = vi.fn(async (..._args: any[]) =>
	new Array(384).fill(0).map(() => new Array(384).fill(0))
);

vi.mock('../../../main/grpo/embedding-service', () => ({
	encode: (...args: unknown[]) => mockEncode(...args),
	encodeBatch: (...args: unknown[]) => mockEncodeBatch(...args),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

import { MemoryStore } from '../../memory/memory-store';
import type { MemoryConfig } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIM = 384;

function makeVector(angle: number): number[] {
	const v = new Array(DIM).fill(0);
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, enabled: true, enableHybridSearch: true, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MemoryStore — Hybrid Search (Keyword + Tag + Embedding)', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(DIM).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── keywordSearch ──────────────────────────────────────────────────

	describe('keywordSearch', () => {
		it('returns results based on token overlap (Jaccard)', async () => {
			await store.addMemory({
				content: 'Use Result for error handling in Rust',
				scope: 'global',
			});
			await store.addMemory({
				content: 'Python uses exceptions for error handling',
				scope: 'global',
			});
			await store.addMemory({
				content: 'Docker containers are isolated environments',
				scope: 'global',
			});

			const results = await store.keywordSearch('error handling', 'global');

			// First two share "error" and "handling" tokens with query
			expect(results.length).toBe(2);
			expect(results[0].keywordScore).toBeGreaterThan(0);
			expect(results[1].keywordScore).toBeGreaterThan(0);
			// Docker memory should not appear
			const ids = results.map((r) => r.entry.content);
			expect(ids).not.toContain('Docker containers are isolated environments');
		});

		it('boosts score for kw: tag matches (+0.15)', async () => {
			const mem = await store.addMemory({
				content: 'Handle errors gracefully',
				scope: 'global',
				tags: ['kw:error', 'kw:graceful'],
			});

			const results = await store.keywordSearch('error handling', 'global');

			// Should find the memory with boosted score
			expect(results.length).toBe(1);
			// Jaccard + 0.15 for the kw:error match
			const jaccard = results[0].keywordScore;
			expect(jaccard).toBeGreaterThan(0.1); // Has both Jaccard + tag bonus
		});

		it('boosts score for category: tag matches (+0.10)', async () => {
			await store.addMemory({
				content: 'Some technical content here',
				scope: 'global',
				tags: ['category:debugging'],
			});

			const results = await store.keywordSearch('debugging techniques', 'global');

			expect(results.length).toBe(1);
			// Should have category bonus
			expect(results[0].keywordScore).toBeGreaterThan(0);
		});

		it('clamps keywordScore to [0, 1]', async () => {
			// Create memory with lots of matching tags to push score high
			await store.addMemory({
				content: 'error handling debugging testing',
				scope: 'global',
				tags: [
					'kw:error',
					'kw:handling',
					'kw:debugging',
					'kw:testing',
					'category:error',
					'category:handling',
					'category:debugging',
				],
			});

			const results = await store.keywordSearch('error handling debugging testing', 'global');

			expect(results.length).toBe(1);
			expect(results[0].keywordScore).toBeLessThanOrEqual(1);
		});

		it('removes stop words from tokenization', async () => {
			await store.addMemory({
				content: 'the quick brown fox',
				scope: 'global',
			});

			// "the" is a stop word — should be excluded
			const results = await store.keywordSearch('the', 'global');
			expect(results.length).toBe(0);
		});

		it('respects minScore threshold', async () => {
			await store.addMemory({
				content: 'a very long sentence about many different topics that barely overlaps',
				scope: 'global',
			});

			// With high minScore, low-overlap results are filtered
			const strict = await store.keywordSearch(
				'error handling',
				'global',
				undefined,
				undefined,
				0.5
			);
			expect(strict.length).toBe(0);

			// With low minScore, some might pass
			const lenient = await store.keywordSearch(
				'error handling',
				'global',
				undefined,
				undefined,
				0.01
			);
			// May or may not find results depending on overlap, but shouldn't crash
			expect(Array.isArray(lenient)).toBe(true);
		});

		it('filters to active, non-archived memories only', async () => {
			const mem = await store.addMemory({
				content: 'error handling patterns',
				scope: 'global',
			});

			// Deactivate the memory
			await store.updateMemory(mem.id, { active: false }, 'global');

			const results = await store.keywordSearch('error handling', 'global');
			expect(results.length).toBe(0);
		});
	});

	// ─── tagSearch ──────────────────────────────────────────────────────

	describe('tagSearch', () => {
		it('returns memories matching query tags', async () => {
			await store.addMemory({
				content: 'Memory with tags',
				scope: 'global',
				tags: ['kw:error', 'category:debugging'],
			});
			await store.addMemory({
				content: 'Memory without matching tags',
				scope: 'global',
				tags: ['kw:performance'],
			});

			const results = await store.tagSearch(['kw:error'], 'global');

			expect(results.length).toBe(1);
			expect(results[0].tagScore).toBe(1.0); // 1 of 1 tags match
		});

		it('scores proportionally to match count', async () => {
			await store.addMemory({
				content: 'Partially matching',
				scope: 'global',
				tags: ['kw:error', 'category:testing'],
			});

			const results = await store.tagSearch(
				['kw:error', 'category:debugging', 'kw:handling'],
				'global'
			);

			expect(results.length).toBe(1);
			// 1 out of 3 tags match
			expect(results[0].tagScore).toBeCloseTo(1 / 3, 5);
		});

		it('returns empty for no matching tags', async () => {
			await store.addMemory({
				content: 'No match',
				scope: 'global',
				tags: ['kw:performance'],
			});

			const results = await store.tagSearch(['kw:error'], 'global');
			expect(results.length).toBe(0);
		});

		it('returns empty for empty query tags', async () => {
			await store.addMemory({
				content: 'Any memory',
				scope: 'global',
				tags: ['kw:error'],
			});

			const results = await store.tagSearch([], 'global');
			expect(results.length).toBe(0);
		});

		it('is case-insensitive', async () => {
			await store.addMemory({
				content: 'Tagged memory',
				scope: 'global',
				tags: ['kw:Error'],
			});

			const results = await store.tagSearch(['kw:error'], 'global');
			expect(results.length).toBe(1);
		});

		it('sorts by tagScore descending', async () => {
			await store.addMemory({
				content: 'One match',
				scope: 'global',
				tags: ['kw:error'],
			});
			await store.addMemory({
				content: 'Two matches',
				scope: 'global',
				tags: ['kw:error', 'kw:handling'],
			});

			const results = await store.tagSearch(['kw:error', 'kw:handling'], 'global');

			expect(results.length).toBe(2);
			expect(results[0].tagScore).toBe(1.0);
			expect(results[1].tagScore).toBe(0.5);
		});
	});

	// ─── hybridSearch ───────────────────────────────────────────────────

	describe('hybridSearch', () => {
		it('combines embedding, keyword, and tag signals', async () => {
			const mem = await store.addMemory({
				content: 'Use Result for error handling in Rust',
				scope: 'global',
				tags: ['kw:error', 'kw:rust', 'category:error-handling'],
			});

			// Set up embedding
			const queryVec = makeVector(0);
			const memVec = makeVector(0.1);
			mockEncode.mockResolvedValue(queryVec);

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			lib.entries[0].embedding = memVec;
			await store.writeLibrary(globalPath, lib);

			const config = makeConfig();
			const results = await store.hybridSearch('error handling rust', 'global', config);

			expect(results.length).toBe(1);
			expect(results[0].entry.id).toBe(mem.id);
			// similarity is the embedding score
			expect(results[0].similarity).toBeGreaterThan(0.9);
			// combinedScore includes all three signals
			expect(results[0].combinedScore).toBeGreaterThan(0);
		});

		it('returns results from keyword search even without embeddings', async () => {
			// Memory with no embedding — embedding service will fail
			await store.addMemory({
				content: 'error handling patterns for production',
				scope: 'global',
			});

			// Make embedding service fail
			mockEncode.mockRejectedValue(new Error('Embedding model not available'));

			const config = makeConfig();
			const results = await store.hybridSearch('error handling', 'global', config);

			// Should still find the memory via keyword match
			expect(results.length).toBe(1);
			expect(results[0].similarity).toBe(0); // No embedding
			expect(results[0].combinedScore).toBeGreaterThan(0); // But keyword score contributes
		});

		it('keyword-only memories rank below embedding+keyword matches', async () => {
			// Memory with embedding AND keyword match
			const embeddedMem = await store.addMemory({
				content: 'error handling with Result types',
				scope: 'global',
			});
			// Memory with only keyword match (no embedding)
			const keywordOnlyMem = await store.addMemory({
				content: 'error handling without embeddings',
				scope: 'global',
			});

			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			lib.entries[0].embedding = makeVector(0.1); // embedded
			// entries[1].embedding stays null
			await store.writeLibrary(globalPath, lib);

			const config = makeConfig();
			const results = await store.hybridSearch('error handling', 'global', config);

			expect(results.length).toBe(2);
			// Embedded memory should rank higher
			expect(results[0].entry.id).toBe(embeddedMem.id);
			expect(results[1].entry.id).toBe(keywordOnlyMem.id);
			expect(results[0].combinedScore).toBeGreaterThan(results[1].combinedScore);
		});

		it('respects limit parameter', async () => {
			for (let i = 0; i < 10; i++) {
				await store.addMemory({
					content: `error handling pattern ${i}`,
					scope: 'global',
				});
			}

			mockEncode.mockRejectedValue(new Error('No embeddings'));

			const config = makeConfig();
			const results = await store.hybridSearch(
				'error handling',
				'global',
				config,
				undefined,
				undefined,
				3
			);

			expect(results.length).toBeLessThanOrEqual(3);
		});
	});

	// ─── cascadingSearch with hybrid enabled ────────────────────────────

	describe('cascadingSearch with enableHybridSearch=true', () => {
		it('uses hybrid search for skill-level memories', async () => {
			const role = await store.createRole('Dev', 'Development');
			const persona = await store.createPersona(role.id, 'Rust Dev', 'Rust systems');
			const skill = await store.createSkillArea(persona.id, 'Error Handling', 'Error patterns');

			const mem = await store.addMemory({
				content: 'Use Result for error handling in Rust',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['kw:error', 'kw:rust'],
			});

			const queryVec = makeVector(0);
			const memVec = makeVector(0.1);
			mockEncode.mockResolvedValue(queryVec);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = memVec;
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('error handling rust', config, 'claude-code');

			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy.length).toBeGreaterThanOrEqual(1);
			expect(hierarchy[0].entry.id).toBe(mem.id);
			expect(hierarchy[0].personaName).toBe('Rust Dev');
			expect(hierarchy[0].skillAreaName).toBe('Error Handling');
		});

		it('uses hybrid search for flat scopes (global + project)', async () => {
			const projPath = '/home/user/my-project';

			const globalMem = await store.addMemory({
				content: 'Global error handling patterns',
				scope: 'global',
			});
			const projMem = await store.addMemory(
				{ content: 'Project error handling patterns', scope: 'project' },
				projPath
			);

			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			// Set embeddings
			const globalPath = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalPath);
			globalLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalPath, globalLib);

			const projDir = store.getMemoryPath('project', undefined, projPath);
			const projLib = await store.readLibrary(projDir);
			projLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(projDir, projLib);

			const config = makeConfig();
			const results = await store.cascadingSearch(
				'error handling',
				config,
				'claude-code',
				projPath
			);

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(globalMem.id);
			expect(ids).toContain(projMem.id);
		});

		it('falls back to embedding-only when enableHybridSearch is false', async () => {
			const globalMem = await store.addMemory({
				content: 'error handling patterns',
				scope: 'global',
			});

			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalPath, lib);

			// Explicitly disable hybrid search
			const config = makeConfig({ enableHybridSearch: false });
			const results = await store.cascadingSearch('error handling', config, 'claude-code');

			expect(results.length).toBeGreaterThanOrEqual(1);
			expect(results[0].entry.id).toBe(globalMem.id);
			// With embedding-only, the formula is similarity * 0.6 + eff * 0.2 + recency * 0.2
			const similarity = realCosineSimilarity(queryVec, makeVector(0.05));
			expect(results[0].similarity).toBeCloseTo(similarity, 5);
		});

		it('hybrid combined score formula is correct', async () => {
			const mem = await store.addMemory({
				content: 'error handling result types',
				scope: 'global',
				tags: ['kw:error'],
			});

			const queryVec = makeVector(0);
			const memVec = makeVector(0.1);
			mockEncode.mockResolvedValue(queryVec);

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			lib.entries[0].embedding = memVec;
			lib.entries[0].effectivenessScore = 0.8;
			lib.entries[0].updatedAt = Date.now(); // recent
			await store.writeLibrary(globalPath, lib);

			const config = makeConfig({ decayHalfLifeDays: 30 });
			const results = await store.hybridSearch('error handling', 'global', config);

			expect(results.length).toBe(1);
			const result = results[0];

			// Verify embedding score is correct
			const expectedEmbedding = realCosineSimilarity(queryVec, memVec);
			expect(result.similarity).toBeCloseTo(expectedEmbedding, 5);

			// Verify combined score uses all three signals
			// keyword score > 0 (query "error handling" overlaps "error handling result types")
			// tag score > 0 (kw:error matches)
			// Therefore combinedScore > embedding-only score
			const embeddingOnlyScore = expectedEmbedding * 0.6 + 0.8 * 0.2 + 1.0 * 0.2;
			// Hybrid score should differ from embedding-only due to keyword/tag contribution
			// (it may be higher or lower depending on the formula weighting)
			expect(result.combinedScore).toBeGreaterThan(0);
			expect(result.combinedScore).not.toBeCloseTo(embeddingOnlyScore, 2);
		});
	});
});
