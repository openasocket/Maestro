/**
 * Tests for memory consolidation — focused on the MemoryStore.consolidateMemories() method.
 *
 * Tests cover:
 * - Merge above threshold: two memories with ≥ 0.90 similarity → merged
 * - Skip below threshold: two memories with 0.70 similarity → both remain
 * - Tag union: merged entry contains the union of all tags
 * - Scope boundary: consolidation in one skill area doesn't affect another
 * - History: verify 'consolidate' operations are recorded in JSONL
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock electron-store
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

// Track all file system operations
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

// Mock the embedding service — real cosineSimilarity, controllable encode/encodeBatch
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

import { MemoryStore } from '../../../main/memory/memory-store';

// ─── Embedding Helpers ──────────────────────────────────────────────────────

const DIM = 384;

/**
 * Create a unit vector with a dominant component at `idx`.
 * Cosine similarity between makeEmbedding(x) and makeEmbedding(y) where x !== y is 0.
 */
function makeEmbedding(idx: number): number[] {
	const v = new Array(DIM).fill(0);
	v[idx] = 1;
	return v;
}

/**
 * Create an embedding with cosine similarity ≈ `targetSim` to the unit vector at `idx`.
 *
 * Constructs v = [0,..., targetSim, ..., sqrt(1 - targetSim²), ...0]
 * where targetSim is placed at `idx` and the orthogonal perturbation at `perturbIdx`.
 * The resulting vector is unit-length, and cos(v, e_idx) = targetSim.
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Memory Consolidation', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockClear();
		mockEncodeBatch.mockClear();
		store = new MemoryStore();
	});

	// ─── Merge Above Threshold ─────────────────────────────────────────────

	it('merges two memories with 0.90 similarity', async () => {
		// Default consolidationThreshold is 0.85, so 0.90 should trigger a merge
		const mem1 = await store.addMemory({
			content: 'Use structured error types for all public APIs',
			scope: 'global',
			tags: ['errors'],
			confidence: 0.9,
		});
		const mem2 = await store.addMemory({
			content: 'Public APIs should return structured error types',
			scope: 'global',
			tags: ['api'],
			confidence: 0.7,
		});

		// Set embeddings with cosine similarity = 0.90
		const dirPath = store.getMemoryPath('global');
		const lib = await store.readLibrary(dirPath);
		for (const e of lib.entries) {
			if (e.id === mem1.id) e.embedding = makeEmbedding(0);
			if (e.id === mem2.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.9);
		}
		await store.writeLibrary(dirPath, lib);

		const config = await store.getConfig();
		const merges = await store.consolidateMemories('global', config);

		expect(merges).toBe(1);

		// mem1 (higher confidence) should survive
		const active = await store.listMemories('global');
		expect(active).toHaveLength(1);
		expect(active[0].id).toBe(mem1.id);

		// mem2 should be inactive
		const all = await store.listMemories('global', undefined, undefined, true);
		const inactive = all.filter((e) => !e.active);
		expect(inactive).toHaveLength(1);
		expect(inactive[0].id).toBe(mem2.id);
	});

	// ─── Skip Below Threshold ──────────────────────────────────────────────

	it('does not merge two memories with 0.70 similarity (below 0.85 threshold)', async () => {
		const mem1 = await store.addMemory({
			content: 'Always validate user input at API boundaries',
			scope: 'global',
			confidence: 0.8,
		});
		const mem2 = await store.addMemory({
			content: 'Use input sanitization for security',
			scope: 'global',
			confidence: 0.6,
		});

		// Set embeddings with cosine similarity = 0.70 — below the default 0.85 threshold
		const dirPath = store.getMemoryPath('global');
		const lib = await store.readLibrary(dirPath);
		for (const e of lib.entries) {
			if (e.id === mem1.id) e.embedding = makeEmbedding(0);
			if (e.id === mem2.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.7);
		}
		await store.writeLibrary(dirPath, lib);

		const config = await store.getConfig();
		const merges = await store.consolidateMemories('global', config);

		expect(merges).toBe(0);

		const active = await store.listMemories('global');
		expect(active).toHaveLength(2);
	});

	// ─── Tag Union ─────────────────────────────────────────────────────────

	it('produces a union of tags from all merged memories', async () => {
		const mem1 = await store.addMemory({
			content: 'Handle timeouts with exponential backoff',
			scope: 'global',
			tags: ['networking', 'resilience'],
			confidence: 0.95,
		});
		const mem2 = await store.addMemory({
			content: 'Exponential backoff for network timeout handling',
			scope: 'global',
			tags: ['http', 'retry'],
			confidence: 0.6,
		});
		const mem3 = await store.addMemory({
			content: 'Use backoff strategy for timeouts',
			scope: 'global',
			tags: ['resilience', 'ops'],
			confidence: 0.4,
		});

		// Give all three nearly-identical embeddings (cosine sim ≈ 0.95)
		const dirPath = store.getMemoryPath('global');
		const lib = await store.readLibrary(dirPath);
		for (const e of lib.entries) {
			if (e.id === mem1.id) e.embedding = makeEmbedding(0);
			if (e.id === mem2.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 2);
			if (e.id === mem3.id) e.embedding = makeEmbeddingWithSimilarity(0, 0.95, 3);
		}
		await store.writeLibrary(dirPath, lib);

		const config = await store.getConfig();
		const merges = await store.consolidateMemories('global', config);

		expect(merges).toBe(1);

		const active = await store.listMemories('global');
		expect(active).toHaveLength(1);

		// All tags from all three memories should be present (union)
		const tags = active[0].tags;
		expect(tags).toContain('networking');
		expect(tags).toContain('resilience');
		expect(tags).toContain('http');
		expect(tags).toContain('retry');
		expect(tags).toContain('ops');
		// No duplicates
		expect(new Set(tags).size).toBe(tags.length);
	});

	// ─── Scope Boundary ────────────────────────────────────────────────────

	it('consolidation within one skill area does not affect another', async () => {
		// Create hierarchy: role → persona → two skill areas
		const role = await store.createRole('Developer', 'Software development');
		const persona = await store.createPersona(role.id, 'Backend', 'Backend dev');
		const skillA = await store.createSkillArea(
			persona.id,
			'Error Handling',
			'Error handling patterns'
		);
		const skillB = await store.createSkillArea(persona.id, 'Testing', 'Testing patterns');

		// Add similar memories to skill A
		const memA1 = await store.addMemory({
			content: 'Always wrap IO in Result',
			scope: 'skill',
			skillAreaId: skillA.id,
			confidence: 0.9,
		});
		const memA2 = await store.addMemory({
			content: 'IO operations should be wrapped in Result',
			scope: 'skill',
			skillAreaId: skillA.id,
			confidence: 0.5,
		});

		// Add similar memories to skill B (identical content, should NOT be affected)
		const memB1 = await store.addMemory({
			content: 'Write unit tests for all public functions',
			scope: 'skill',
			skillAreaId: skillB.id,
			confidence: 0.9,
		});
		const memB2 = await store.addMemory({
			content: 'All public functions need unit tests',
			scope: 'skill',
			skillAreaId: skillB.id,
			confidence: 0.5,
		});

		// Set embeddings for skill A memories — identical → will be consolidated
		const dirA = store.getMemoryPath('skill', skillA.id);
		const libA = await store.readLibrary(dirA);
		for (const e of libA.entries) {
			e.embedding = makeEmbedding(0);
		}
		await store.writeLibrary(dirA, libA);

		// Set embeddings for skill B memories — also identical
		const dirB = store.getMemoryPath('skill', skillB.id);
		const libB = await store.readLibrary(dirB);
		for (const e of libB.entries) {
			e.embedding = makeEmbedding(5);
		}
		await store.writeLibrary(dirB, libB);

		// Consolidate only skill A
		const config = await store.getConfig();
		const mergesA = await store.consolidateMemories('skill', config, skillA.id);
		expect(mergesA).toBe(1);

		// Skill A: only 1 active memory remains
		const activeA = await store.listMemories('skill', skillA.id);
		expect(activeA).toHaveLength(1);
		expect(activeA[0].id).toBe(memA1.id);

		// Skill B: both memories should still be active (untouched)
		const activeB = await store.listMemories('skill', skillB.id);
		expect(activeB).toHaveLength(2);
		expect(activeB.map((m) => m.id).sort()).toEqual([memB1.id, memB2.id].sort());
	});

	// ─── History Recording ─────────────────────────────────────────────────

	it('records consolidate operations in history.jsonl', async () => {
		const mem1 = await store.addMemory({
			content: 'Prefer composition over inheritance',
			scope: 'global',
			confidence: 0.95,
		});
		const mem2 = await store.addMemory({
			content: 'Composition is better than inheritance',
			scope: 'global',
			confidence: 0.5,
		});

		// Set identical embeddings so they merge
		const dirPath = store.getMemoryPath('global');
		const lib = await store.readLibrary(dirPath);
		for (const e of lib.entries) {
			e.embedding = makeEmbedding(0);
		}
		await store.writeLibrary(dirPath, lib);

		const config = await store.getConfig();
		await store.consolidateMemories('global', config);

		// Read history.jsonl and find consolidation entries
		const historyContent = fsState.get(dirPath + '/history.jsonl');
		expect(historyContent).toBeDefined();

		const lines = historyContent!.trim().split('\n');
		const consolidateEntries = lines
			.map((l) => JSON.parse(l))
			.filter((e: { operation: string }) => e.operation === 'consolidate');

		expect(consolidateEntries).toHaveLength(1);

		const entry = consolidateEntries[0];
		expect(entry.operation).toBe('consolidate');
		expect(entry.entityType).toBe('memory');
		expect(entry.entityId).toBe(mem1.id); // Center (highest confidence)
		expect(entry.source).toBe('consolidation');
		expect(entry.content).toContain('Merged');
		expect(entry.content).toContain(mem1.id);
		expect(entry.reason).toContain(mem2.id); // Absorbed ID listed in reason
	});
});
