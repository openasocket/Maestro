/**
 * Tests for the reEmbedAll migration utility.
 *
 * Verifies: clear → re-embed cycle across all scopes, per-scope filtering,
 * error handling per-entry, and result reporting.
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
	readdir: vi.fn(async (dirPath: string) => {
		// Scan fsState for subdirectories of the requested path
		const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
		const dirs = new Set<string>();
		for (const key of fsState.keys()) {
			if (key.startsWith(prefix)) {
				const rest = key.slice(prefix.length);
				const firstSlash = rest.indexOf('/');
				if (firstSlash > 0) {
					dirs.add(rest.slice(0, firstSlash));
				}
			}
		}
		return [...dirs];
	}),
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

const DIM = 384;
let embedCallCount = 0;

const mockEncode = vi.fn(async (_text: string) => {
	embedCallCount++;
	const v = new Array(DIM).fill(0);
	v[0] = 1; // simple unit vector
	return v;
});

const mockEncodeBatch = vi.fn(async (texts: string[]) => {
	embedCallCount += texts.length;
	return texts.map(() => {
		const v = new Array(DIM).fill(0);
		v[0] = 1;
		return v;
	});
});

vi.mock('../../../main/grpo/embedding-service', () => ({
	encode: (...args: unknown[]) => mockEncode(...(args as [string])),
	encodeBatch: (...args: unknown[]) => mockEncodeBatch(...(args as [string[]])),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

import { MemoryStore } from '../../memory/memory-store';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MemoryStore.reEmbedAll', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockClear();
		mockEncodeBatch.mockClear();
		embedCallCount = 0;
		store = new MemoryStore();
	});

	it('clears and re-embeds all memories across scopes', async () => {
		// Setup: create hierarchy and add memories
		const role = await store.createRole('Dev', 'Developer');
		const persona = await store.createPersona(role.id, 'FE Dev', 'Frontend');
		const skill = await store.createSkillArea(persona.id, 'React', 'React patterns');

		// Add memories to skill scope
		await store.addMemory({
			content: 'Use useMemo for expensive computations',
			type: 'experience',
			scope: 'skill',
			skillAreaId: skill.id,
			tags: ['react'],
		});
		await store.addMemory({
			content: 'Prefer composition over inheritance',
			type: 'rule',
			scope: 'skill',
			skillAreaId: skill.id,
			tags: ['react'],
		});

		// Add a global memory
		await store.addMemory({
			content: 'Always write tests',
			type: 'rule',
			scope: 'global',
			tags: ['testing'],
		});

		// Give initial embeddings
		await store.ensureAllEmbeddings('skill', skill.id);
		await store.ensureAllEmbeddings('global');
		await store.ensureHierarchyEmbeddings();

		// Verify memories have embeddings
		const beforeSkill = await store.listMemories('skill', skill.id);
		const beforeGlobal = await store.listMemories('global');
		expect(beforeSkill.every((m) => m.embedding !== null)).toBe(true);
		expect(beforeGlobal.every((m) => m.embedding !== null)).toBe(true);

		// Reset mock counts
		mockEncodeBatch.mockClear();
		embedCallCount = 0;

		// Run reEmbedAll
		const result = await store.reEmbedAll();

		expect(result.total).toBe(3); // 2 skill + 1 global
		expect(result.succeeded).toBe(3);
		expect(result.failed).toBe(0);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);

		// Verify embeddings were re-computed (encodeBatch was called)
		expect(mockEncodeBatch).toHaveBeenCalled();

		// Verify memories still have embeddings after re-embed
		const afterSkill = await store.listMemories('skill', skill.id);
		const afterGlobal = await store.listMemories('global');
		expect(afterSkill.every((m) => m.embedding !== null)).toBe(true);
		expect(afterGlobal.every((m) => m.embedding !== null)).toBe(true);
	});

	it('filters by scope when scope option is provided', async () => {
		const role = await store.createRole('Dev', 'Developer');
		const persona = await store.createPersona(role.id, 'BE Dev', 'Backend');
		const skill = await store.createSkillArea(persona.id, 'SQL', 'SQL patterns');

		await store.addMemory({
			content: 'Use prepared statements',
			type: 'rule',
			scope: 'skill',
			skillAreaId: skill.id,
			tags: ['sql'],
		});
		await store.addMemory({
			content: 'Global memory',
			type: 'rule',
			scope: 'global',
			tags: ['general'],
		});

		// Give initial embeddings
		await store.ensureAllEmbeddings('skill', skill.id);
		await store.ensureAllEmbeddings('global');

		mockEncodeBatch.mockClear();

		// Re-embed only global scope
		const result = await store.reEmbedAll({ scope: 'global' });
		expect(result.total).toBe(1);
		expect(result.succeeded).toBe(1);
	});

	it('handles encoding errors per-batch without failing entire operation', async () => {
		const role = await store.createRole('Dev', 'Developer');
		const persona = await store.createPersona(role.id, 'Dev', 'General');
		const skill = await store.createSkillArea(persona.id, 'General', 'General');

		// Add memory
		await store.addMemory({
			content: 'Test memory',
			type: 'experience',
			scope: 'skill',
			skillAreaId: skill.id,
			tags: [],
		});

		// Make encodeBatch fail
		mockEncodeBatch.mockRejectedValueOnce(new Error('Provider unavailable'));

		const result = await store.reEmbedAll();
		expect(result.total).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.succeeded).toBe(0);
	});

	it('returns zero counts when no memories exist', async () => {
		const result = await store.reEmbedAll();
		expect(result.total).toBe(0);
		expect(result.succeeded).toBe(0);
		expect(result.failed).toBe(0);
	});

	it('clears hierarchy embeddings and re-computes them', async () => {
		const role = await store.createRole('Dev', 'Developer');
		const persona = await store.createPersona(role.id, 'FE Dev', 'Frontend development');
		await store.createSkillArea(persona.id, 'React', 'React patterns');

		// Give hierarchy embeddings
		await store.ensureHierarchyEmbeddings();

		// Check they have embeddings
		const personasBefore = await store.listPersonas();
		const skillsBefore = await store.listSkillAreas();
		expect(personasBefore[0].embedding).not.toBeNull();
		expect(skillsBefore[0].embedding).not.toBeNull();

		mockEncodeBatch.mockClear();

		// Run reEmbedAll (no scope = includes hierarchy)
		await store.reEmbedAll();

		// encodeBatch should have been called for hierarchy re-embedding
		expect(mockEncodeBatch).toHaveBeenCalled();
	});
});
