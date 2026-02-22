/**
 * Integration tests for consolidation within hierarchy boundaries.
 *
 * Verifies that consolidateMemories() respects skill-area scope:
 *   1. Three similar memories in one skill → consolidated to 1-2
 *   2. Memories in different skills are never merged across boundaries
 *   3. Consolidation in one scope (global/project) doesn't affect another
 *   4. Consolidation preserves hierarchy metadata (tag union, confidence, useCount)
 *   5. History records are scoped to the consolidated skill area only
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

const mockEncode = vi.fn(async () => new Array(384).fill(0));
const mockEncodeBatch = vi.fn(async (texts: string[]) => texts.map(() => new Array(384).fill(0)));

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

/** Create a unit vector with a dominant component at `idx`. */
function makeEmbedding(idx: number): number[] {
	const v = new Array(DIM).fill(0);
	v[idx] = 1;
	return v;
}

/**
 * Create an embedding with cosine similarity ≈ `targetSim` to the unit vector at `idx`.
 */
function makeEmbeddingWithSimilarity(
	idx: number,
	targetSim: number,
	perturbIdx?: number
): number[] {
	const v = new Array(DIM).fill(0);
	v[idx] = targetSim;
	const ortho = perturbIdx ?? (idx + 1) % DIM;
	v[ortho] = Math.sqrt(1 - targetSim * targetSim);
	return v;
}

/** Convenience: make a config with overrides. */
function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, enabled: true, ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Memory Integration — Consolidation Within Hierarchy Boundaries', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockClear();
		mockEncodeBatch.mockClear();
		store = new MemoryStore();
	});

	// ─── 1. Three similar memories → consolidated to 1-2 ────────────────

	describe('Same-skill consolidation: 3 similar memories merge down', () => {
		it('consolidates 3 similar memories in same skill to 1 (all above threshold)', async () => {
			const role = await store.createRole('Developer', 'Software development');
			const persona = await store.createPersona(role.id, 'Rust Dev', 'Rust systems');
			const skill = await store.createSkillArea(persona.id, 'Error Handling', 'Error patterns');

			const mem1 = await store.addMemory({
				content: 'Always use Result<T, E> for error handling in Rust',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['rust', 'errors'],
				confidence: 0.95,
			});
			const mem2 = await store.addMemory({
				content: 'Rust error handling should use Result<T, E> types',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['rust', 'types'],
				confidence: 0.7,
			});
			const mem3 = await store.addMemory({
				content: 'Use Result types for all error handling in Rust code',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['error-handling', 'best-practice'],
				confidence: 0.5,
			});

			// Set embeddings: all three highly similar (sim ≈ 0.95 to center)
			const dirPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) e.embedding = makeEmbedding(0);
				if (e.id === mem2.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 2);
				if (e.id === mem3.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 3);
			}
			await store.writeLibrary(dirPath, lib);

			const config = makeConfig();
			const merges = await store.consolidateMemories('skill', config, skill.id);

			expect(merges).toBe(1); // One merge operation (all 3 clustered together)

			// Only 1 active memory remains — the highest confidence (mem1)
			const active = await store.listMemories('skill', skill.id);
			expect(active).toHaveLength(1);
			expect(active[0].id).toBe(mem1.id);

			// Verify merged entry has union of all tags
			const tags = active[0].tags;
			expect(tags).toContain('rust');
			expect(tags).toContain('errors');
			expect(tags).toContain('types');
			expect(tags).toContain('error-handling');
			expect(tags).toContain('best-practice');
			expect(new Set(tags).size).toBe(tags.length); // No duplicates

			// Verify absorbed entries are inactive
			const all = await store.listMemories('skill', skill.id, undefined, true);
			const inactive = all.filter((e) => !e.active);
			expect(inactive).toHaveLength(2);
			const inactiveIds = inactive.map((e) => e.id).sort();
			expect(inactiveIds).toEqual([mem2.id, mem3.id].sort());
		});

		it('consolidates 3 memories where only 2 are similar, leaving 2 active', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Backend Dev', 'Backend');
			const skill = await store.createSkillArea(persona.id, 'APIs', 'API design');

			const mem1 = await store.addMemory({
				content: 'Use REST for all public API endpoints',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['rest', 'api'],
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Public API endpoints should follow REST conventions',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['conventions'],
				confidence: 0.6,
			});
			const mem3 = await store.addMemory({
				content: 'Always validate input parameters at API boundaries',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['validation', 'security'],
				confidence: 0.8,
			});

			// mem1 and mem2 are similar (0.92), mem3 is dissimilar (orthogonal)
			const dirPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) e.embedding = makeEmbedding(0);
				if (e.id === mem2.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.92);
				if (e.id === mem3.id) e.embedding = makeEmbedding(10); // Orthogonal to mem1/mem2
			}
			await store.writeLibrary(dirPath, lib);

			const config = makeConfig();
			const merges = await store.consolidateMemories('skill', config, skill.id);

			expect(merges).toBe(1); // mem1 absorbs mem2

			const active = await store.listMemories('skill', skill.id);
			expect(active).toHaveLength(2); // mem1 (merged) + mem3 (untouched)
			const activeIds = active.map((e) => e.id).sort();
			expect(activeIds).toEqual([mem1.id, mem3.id].sort());

			// mem1 should have absorbed mem2's tags
			const merged = active.find((e) => e.id === mem1.id)!;
			expect(merged.tags).toContain('rest');
			expect(merged.tags).toContain('api');
			expect(merged.tags).toContain('conventions');

			// mem3 should be unchanged
			const untouched = active.find((e) => e.id === mem3.id)!;
			expect(untouched.tags).toEqual(['validation', 'security']);
		});
	});

	// ─── 2. Cross-skill boundary enforcement ────────────────────────────

	describe('Cross-skill isolation: consolidation never crosses skill boundaries', () => {
		it('similar memories in different skills under same persona are not merged', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Rust Dev', 'Rust systems');

			const skillA = await store.createSkillArea(persona.id, 'Error Handling', 'Errors');
			const skillB = await store.createSkillArea(persona.id, 'Testing', 'Test patterns');

			// Add nearly identical content to both skills
			const memA1 = await store.addMemory({
				content: 'Always use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.95,
			});
			const memA2 = await store.addMemory({
				content: 'Error handling should use Result<T, E> types',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.7,
			});

			const memB1 = await store.addMemory({
				content: 'Use Result<T, E> in test assertions too',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.9,
			});
			const memB2 = await store.addMemory({
				content: 'Test assertions should handle Result<T, E>',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.6,
			});

			// Set identical embeddings for all — maximum similarity
			const dirA = store.getMemoryPath('skill', skillA.id);
			const libA = await store.readLibrary(dirA);
			for (const e of libA.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(dirA, libA);

			const dirB = store.getMemoryPath('skill', skillB.id);
			const libB = await store.readLibrary(dirB);
			for (const e of libB.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(dirB, libB);

			const config = makeConfig();

			// Consolidate skill A only
			const mergesA = await store.consolidateMemories('skill', config, skillA.id);
			expect(mergesA).toBe(1);

			// Skill A: 1 active memory
			const activeA = await store.listMemories('skill', skillA.id);
			expect(activeA).toHaveLength(1);
			expect(activeA[0].id).toBe(memA1.id);

			// Skill B: both memories still active (untouched by skill A consolidation)
			const activeB = await store.listMemories('skill', skillB.id);
			expect(activeB).toHaveLength(2);
			expect(activeB.map((m) => m.id).sort()).toEqual([memB1.id, memB2.id].sort());
		});

		it('consolidating skill B after skill A still respects boundaries', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Backend Dev', 'Backend');

			const skillA = await store.createSkillArea(persona.id, 'Databases', 'DB patterns');
			const skillB = await store.createSkillArea(persona.id, 'Caching', 'Cache patterns');

			// Skill A: 3 similar memories
			const memA1 = await store.addMemory({
				content: 'Index all foreign keys in PostgreSQL',
				scope: 'skill',
				skillAreaId: skillA.id,
				tags: ['postgres', 'indexing'],
				confidence: 0.9,
			});
			const memA2 = await store.addMemory({
				content: 'Always create indexes on foreign key columns',
				scope: 'skill',
				skillAreaId: skillA.id,
				tags: ['performance'],
				confidence: 0.6,
			});
			const memA3 = await store.addMemory({
				content: 'Foreign key columns need indexes for join performance',
				scope: 'skill',
				skillAreaId: skillA.id,
				tags: ['joins'],
				confidence: 0.4,
			});

			// Skill B: 2 similar memories
			const memB1 = await store.addMemory({
				content: 'Set TTL on all cache entries to prevent staleness',
				scope: 'skill',
				skillAreaId: skillB.id,
				tags: ['ttl', 'cache'],
				confidence: 0.85,
			});
			const memB2 = await store.addMemory({
				content: 'Cache entries must have TTL to avoid stale data',
				scope: 'skill',
				skillAreaId: skillB.id,
				tags: ['staleness'],
				confidence: 0.5,
			});

			// Set embeddings
			const dirA = store.getMemoryPath('skill', skillA.id);
			const libA = await store.readLibrary(dirA);
			for (const e of libA.entries) {
				e.embedding = makeEmbedding(0); // All identical → all merge
			}
			await store.writeLibrary(dirA, libA);

			const dirB = store.getMemoryPath('skill', skillB.id);
			const libB = await store.readLibrary(dirB);
			for (const e of libB.entries) {
				e.embedding = makeEmbedding(5); // All identical → will merge
			}
			await store.writeLibrary(dirB, libB);

			const config = makeConfig();

			// Consolidate A first
			const mergesA = await store.consolidateMemories('skill', config, skillA.id);
			expect(mergesA).toBe(1);

			const activeA = await store.listMemories('skill', skillA.id);
			expect(activeA).toHaveLength(1);
			expect(activeA[0].id).toBe(memA1.id);
			// Verify tag union from 3 memories
			expect(activeA[0].tags).toContain('postgres');
			expect(activeA[0].tags).toContain('indexing');
			expect(activeA[0].tags).toContain('performance');
			expect(activeA[0].tags).toContain('joins');

			// Consolidate B — should still work independently
			const mergesB = await store.consolidateMemories('skill', config, skillB.id);
			expect(mergesB).toBe(1);

			const activeB = await store.listMemories('skill', skillB.id);
			expect(activeB).toHaveLength(1);
			expect(activeB[0].id).toBe(memB1.id);
			expect(activeB[0].tags).toContain('ttl');
			expect(activeB[0].tags).toContain('cache');
			expect(activeB[0].tags).toContain('staleness');

			// Verify A is still unchanged after B consolidation
			const activeAAfter = await store.listMemories('skill', skillA.id);
			expect(activeAAfter).toHaveLength(1);
			expect(activeAAfter[0].id).toBe(memA1.id);
		});

		it('memories in different personas under same role are not merged', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const personaA = await store.createPersona(role.id, 'Frontend Dev', 'Frontend');
			const personaB = await store.createPersona(role.id, 'Backend Dev', 'Backend');

			const skillA = await store.createSkillArea(personaA.id, 'React', 'React patterns');
			const skillB = await store.createSkillArea(personaB.id, 'APIs', 'API patterns');

			// Same content in both skills (different personas)
			const memA1 = await store.addMemory({
				content: 'Use TypeScript strict mode for type safety',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.9,
			});
			const memA2 = await store.addMemory({
				content: 'TypeScript strict mode ensures type safety',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.5,
			});

			const memB1 = await store.addMemory({
				content: 'Enable strict TypeScript for type safety',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.9,
			});
			const memB2 = await store.addMemory({
				content: 'Strict TypeScript mode for type safety',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.5,
			});

			// Identical embeddings across all
			for (const [skillId, mems] of [
				[skillA.id, [memA1, memA2]],
				[skillB.id, [memB1, memB2]],
			] as const) {
				const dir = store.getMemoryPath('skill', skillId);
				const lib = await store.readLibrary(dir);
				for (const e of lib.entries) {
					e.embedding = makeEmbedding(0);
				}
				await store.writeLibrary(dir, lib);
			}

			const config = makeConfig();

			// Consolidate skill A
			const mergesA = await store.consolidateMemories('skill', config, skillA.id);
			expect(mergesA).toBe(1);

			// Skill B is untouched
			const activeB = await store.listMemories('skill', skillB.id);
			expect(activeB).toHaveLength(2);

			// Now consolidate skill B
			const mergesB = await store.consolidateMemories('skill', config, skillB.id);
			expect(mergesB).toBe(1);

			// Each skill has exactly 1 active memory
			const finalA = await store.listMemories('skill', skillA.id);
			const finalB = await store.listMemories('skill', skillB.id);
			expect(finalA).toHaveLength(1);
			expect(finalB).toHaveLength(1);
			expect(finalA[0].id).toBe(memA1.id);
			expect(finalB[0].id).toBe(memB1.id);
		});
	});

	// ─── 3. Cross-scope isolation ───────────────────────────────────────

	describe('Cross-scope isolation: skill, global, and project consolidations are independent', () => {
		it('consolidating global scope does not affect skill memories', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Dev', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Coding', 'desc');

			// Similar skill memories
			const skillMem1 = await store.addMemory({
				content: 'Always handle errors explicitly',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.9,
			});
			const skillMem2 = await store.addMemory({
				content: 'Handle errors explicitly in all functions',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.5,
			});

			// Similar global memories
			const globalMem1 = await store.addMemory({
				content: 'Write tests for all public functions',
				scope: 'global',
				confidence: 0.9,
			});
			const globalMem2 = await store.addMemory({
				content: 'All public functions need tests',
				scope: 'global',
				confidence: 0.5,
			});

			// Set embeddings
			const skillDir = store.getMemoryPath('skill', skill.id);
			const skillLib = await store.readLibrary(skillDir);
			for (const e of skillLib.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(skillDir, skillLib);

			const globalDir = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalDir);
			for (const e of globalLib.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(globalDir, globalLib);

			const config = makeConfig();

			// Consolidate global only
			const globalMerges = await store.consolidateMemories('global', config);
			expect(globalMerges).toBe(1);

			// Global: 1 active
			const activeGlobal = await store.listMemories('global');
			expect(activeGlobal).toHaveLength(1);
			expect(activeGlobal[0].id).toBe(globalMem1.id);

			// Skill: both still active
			const activeSkill = await store.listMemories('skill', skill.id);
			expect(activeSkill).toHaveLength(2);
		});
	});

	// ─── 4. Consolidation metadata preservation ─────────────────────────

	describe('Metadata preservation: confidence, useCount, and effectiveness after merge', () => {
		it('merged entry has weighted confidence, summed useCount, and max effectiveness', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Dev', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const mem1 = await store.addMemory({
				content: 'Use dependency injection for testability',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Dependency injection improves testability',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.6,
			});
			const mem3 = await store.addMemory({
				content: 'Inject dependencies for better test isolation',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.3,
			});

			// Manually set useCount and effectiveness on the raw entries
			const dirPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) {
					e.embedding = makeEmbedding(0);
					e.useCount = 5;
					e.effectivenessScore = 0.4;
				}
				if (e.id === mem2.id) {
					e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 2);
					e.useCount = 3;
					e.effectivenessScore = 0.8; // highest
				}
				if (e.id === mem3.id) {
					e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 3);
					e.useCount = 2;
					e.effectivenessScore = 0.2;
				}
			}
			await store.writeLibrary(dirPath, lib);

			const config = makeConfig();
			const merges = await store.consolidateMemories('skill', config, skill.id);
			expect(merges).toBe(1);

			const active = await store.listMemories('skill', skill.id);
			expect(active).toHaveLength(1);

			const merged = active[0];
			expect(merged.id).toBe(mem1.id);

			// useCount: sum of all = 5 + 3 + 2 = 10
			expect(merged.useCount).toBe(10);

			// effectiveness: max = 0.8
			expect(merged.effectivenessScore).toBe(0.8);

			// confidence: weighted average by useCount
			// (0.9*5 + 0.6*3 + 0.3*2) / (5+3+2) = (4.5 + 1.8 + 0.6) / 10 = 0.69
			expect(merged.confidence).toBeCloseTo(0.69, 5);
		});
	});

	// ─── 5. History scoped to consolidated skill ────────────────────────

	describe('History recording: consolidation history is scoped per skill area', () => {
		it('consolidation history is written only to the consolidated skill directory', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Dev', 'desc');
			const skillA = await store.createSkillArea(persona.id, 'Skill A', 'desc');
			const skillB = await store.createSkillArea(persona.id, 'Skill B', 'desc');

			// Add similar memories to both skills
			const memA1 = await store.addMemory({
				content: 'Pattern A first version',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.9,
			});
			await store.addMemory({
				content: 'Pattern A second version',
				scope: 'skill',
				skillAreaId: skillA.id,
				confidence: 0.5,
			});

			await store.addMemory({
				content: 'Pattern B first version',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.9,
			});
			await store.addMemory({
				content: 'Pattern B second version',
				scope: 'skill',
				skillAreaId: skillB.id,
				confidence: 0.5,
			});

			// Set identical embeddings for both skills
			for (const skillId of [skillA.id, skillB.id]) {
				const dir = store.getMemoryPath('skill', skillId);
				const lib = await store.readLibrary(dir);
				for (const e of lib.entries) {
					e.embedding = makeEmbedding(0);
				}
				await store.writeLibrary(dir, lib);
			}

			const config = makeConfig();

			// Consolidate skill A only
			await store.consolidateMemories('skill', config, skillA.id);

			// Skill A history should have a consolidate entry
			const dirA = store.getMemoryPath('skill', skillA.id);
			const historyA = fsState.get(`${dirA}/history.jsonl`);
			expect(historyA).toBeDefined();
			const linesA = historyA!
				.trim()
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));
			const consolidateA = linesA.filter(
				(e: { operation: string }) => e.operation === 'consolidate'
			);
			expect(consolidateA).toHaveLength(1);
			expect(consolidateA[0].entityId).toBe(memA1.id);

			// Skill B history should NOT have any consolidate entries
			const dirB = store.getMemoryPath('skill', skillB.id);
			const historyB = fsState.get(`${dirB}/history.jsonl`);
			if (historyB) {
				const linesB = historyB
					.trim()
					.split('\n')
					.filter((l) => l.trim())
					.map((l) => JSON.parse(l));
				const consolidateB = linesB.filter(
					(e: { operation: string }) => e.operation === 'consolidate'
				);
				expect(consolidateB).toHaveLength(0);
			}
		});
	});
});
