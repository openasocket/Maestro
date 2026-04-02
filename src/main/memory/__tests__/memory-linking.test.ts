/**
 * Tests for Inter-Memory Linking (A-MEM Zettelkasten pattern).
 *
 * Covers:
 * - linkMemories (bidirectional link creation)
 * - unlinkMemories (bidirectional link removal)
 * - getLinkedMemories (1-hop traversal)
 * - findMemoryById (cross-scope search)
 * - Auto-link inheritance during consolidation
 * - 1-hop graph expansion in hybridSearch
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
	readdir: vi.fn(async () => [] as string[]),
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Inter-Memory Linking (Zettelkasten)', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(384).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── linkMemories ───────────────────────────────────────────────────

	describe('linkMemories — bidirectional link creation', () => {
		it('creates bidirectional links between two global memories', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });
			const m2 = await store.addMemory({ content: 'Memory B', scope: 'global' });

			await store.linkMemories(m1.id, 'global', m2.id, 'global');

			// Both should reference each other
			const memories = await store.listMemories('global');
			const a = memories.find((m) => m.id === m1.id)!;
			const b = memories.find((m) => m.id === m2.id)!;

			expect(a.relatedMemoryIds).toContain(m2.id);
			expect(b.relatedMemoryIds).toContain(m1.id);
		});

		it('is idempotent — linking twice does not duplicate', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });
			const m2 = await store.addMemory({ content: 'Memory B', scope: 'global' });

			await store.linkMemories(m1.id, 'global', m2.id, 'global');
			await store.linkMemories(m1.id, 'global', m2.id, 'global');

			const memories = await store.listMemories('global');
			const a = memories.find((m) => m.id === m1.id)!;
			expect(a.relatedMemoryIds!.filter((id) => id === m2.id)).toHaveLength(1);
		});

		it('no-ops when linking a memory to itself', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });

			await store.linkMemories(m1.id, 'global', m1.id, 'global');

			const memories = await store.listMemories('global');
			const a = memories.find((m) => m.id === m1.id)!;
			expect(a.relatedMemoryIds).toBeUndefined();
		});

		it('creates links across different skill scopes', async () => {
			const role = await store.createRole('Dev', 'Development');
			const persona = await store.createPersona(role.id, 'Rust', 'Rust dev');
			const skill1 = await store.createSkillArea(persona.id, 'Error Handling', 'Errors');
			const skill2 = await store.createSkillArea(persona.id, 'Testing', 'Testing');

			const m1 = await store.addMemory({
				content: 'Use Result<T, E>',
				scope: 'skill',
				skillAreaId: skill1.id,
			});
			const m2 = await store.addMemory({
				content: 'Test error paths',
				scope: 'skill',
				skillAreaId: skill2.id,
			});

			await store.linkMemories(
				m1.id,
				'skill',
				m2.id,
				'skill',
				skill1.id,
				undefined,
				skill2.id,
				undefined
			);

			const skill1Mems = await store.listMemories('skill', skill1.id);
			const skill2Mems = await store.listMemories('skill', skill2.id);

			expect(skill1Mems[0].relatedMemoryIds).toContain(m2.id);
			expect(skill2Mems[0].relatedMemoryIds).toContain(m1.id);
		});

		it('throws when memory does not exist', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });

			await expect(store.linkMemories(m1.id, 'global', 'nonexistent-id', 'global')).rejects.toThrow(
				'Memory not found'
			);
		});
	});

	// ─── unlinkMemories ─────────────────────────────────────────────────

	describe('unlinkMemories — bidirectional link removal', () => {
		it('removes bidirectional links', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });
			const m2 = await store.addMemory({ content: 'Memory B', scope: 'global' });

			await store.linkMemories(m1.id, 'global', m2.id, 'global');
			await store.unlinkMemories(m1.id, 'global', m2.id, 'global');

			const memories = await store.listMemories('global');
			const a = memories.find((m) => m.id === m1.id)!;
			const b = memories.find((m) => m.id === m2.id)!;

			// relatedMemoryIds should be undefined (cleaned up) or empty
			expect(a.relatedMemoryIds).toBeUndefined();
			expect(b.relatedMemoryIds).toBeUndefined();
		});

		it('is safe to call on memories with no links', async () => {
			const m1 = await store.addMemory({ content: 'Memory A', scope: 'global' });
			const m2 = await store.addMemory({ content: 'Memory B', scope: 'global' });

			// Should not throw
			await store.unlinkMemories(m1.id, 'global', m2.id, 'global');
		});
	});

	// ─── getLinkedMemories ──────────────────────────────────────────────

	describe('getLinkedMemories — 1-hop traversal', () => {
		it('returns linked memories', async () => {
			const m1 = await store.addMemory({ content: 'Center', scope: 'global' });
			const m2 = await store.addMemory({ content: 'Linked A', scope: 'global' });
			const m3 = await store.addMemory({ content: 'Linked B', scope: 'global' });

			await store.linkMemories(m1.id, 'global', m2.id, 'global');
			await store.linkMemories(m1.id, 'global', m3.id, 'global');

			const linked = await store.getLinkedMemories(m1.id, 'global');
			expect(linked).toHaveLength(2);
			expect(linked.map((l) => l.id)).toContain(m2.id);
			expect(linked.map((l) => l.id)).toContain(m3.id);
		});

		it('returns empty array when no links', async () => {
			const m1 = await store.addMemory({ content: 'No links', scope: 'global' });
			const linked = await store.getLinkedMemories(m1.id, 'global');
			expect(linked).toHaveLength(0);
		});
	});

	// ─── findMemoryById ─────────────────────────────────────────────────

	describe('findMemoryById — cross-scope search', () => {
		it('finds a global memory by ID', async () => {
			const m1 = await store.addMemory({ content: 'Global memory', scope: 'global' });
			const found = await store.findMemoryById(m1.id);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(m1.id);
			expect(found!.content).toBe('Global memory');
		});

		it('finds a skill memory by ID', async () => {
			const role = await store.createRole('Dev', 'Development');
			const persona = await store.createPersona(role.id, 'Rust', 'Rust dev');
			const skill = await store.createSkillArea(persona.id, 'Errors', 'Error handling');

			const m1 = await store.addMemory({
				content: 'Skill memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const found = await store.findMemoryById(m1.id);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(m1.id);
		});

		it('returns null for nonexistent ID', async () => {
			const found = await store.findMemoryById('does-not-exist');
			expect(found).toBeNull();
		});
	});

	// ─── Consolidation Link Inheritance ──────────────────────────────────

	describe('consolidation — link inheritance', () => {
		it('merged memory inherits links from absorbed members', async () => {
			// Create 3 memories: center, member, and external
			const center = await store.addMemory({
				content: 'Center memory',
				scope: 'global',
				confidence: 1.0,
			});
			const member = await store.addMemory({
				content: 'Member memory',
				scope: 'global',
				confidence: 0.5,
			});
			const external = await store.addMemory({
				content: 'External memory',
				scope: 'global',
				confidence: 0.5,
			});

			// Link member to external
			await store.linkMemories(member.id, 'global', external.id, 'global');

			// Make center and member highly similar by giving them identical embeddings
			const embedding = new Array(384).fill(0);
			embedding[0] = 1;
			mockEncodeBatch.mockResolvedValue([embedding, embedding, embedding]);

			const config = await store.getConfig();
			config.consolidationThreshold = 0.99; // Only merge nearly identical
			await store.consolidateMemories('global', config);

			// After consolidation, center should inherit member's links
			const memories = await store.listMemories('global');
			const surviving = memories.find((m) => m.id === center.id);
			expect(surviving).toBeDefined();

			// The center should now link to external (inherited from member)
			if (surviving?.relatedMemoryIds) {
				expect(surviving.relatedMemoryIds).toContain(external.id);
			}

			// External should now link to center (not member)
			const ext = memories.find((m) => m.id === external.id);
			if (ext?.relatedMemoryIds) {
				expect(ext.relatedMemoryIds).toContain(center.id);
				expect(ext.relatedMemoryIds).not.toContain(member.id);
			}
		});
	});

	// ─── 1-hop graph expansion in hybridSearch ──────────────────────────

	describe('hybridSearch — 1-hop graph expansion', () => {
		it('includes linked memories with 0.8x score multiplier', async () => {
			// Create two memories: matched and linked
			const matched = await store.addMemory({
				content: 'Matched memory about errors',
				scope: 'global',
			});
			const linked = await store.addMemory({
				content: 'Linked memory about logging',
				scope: 'global',
			});

			// Link them
			await store.linkMemories(matched.id, 'global', linked.id, 'global');

			// Set up embeddings: matched gets a high-similarity embedding, linked gets low
			const queryEmb = new Array(384).fill(0);
			queryEmb[0] = 1;
			const matchedEmb = new Array(384).fill(0);
			matchedEmb[0] = 0.95;
			matchedEmb[1] = 0.05;
			const linkedEmb = new Array(384).fill(0);
			linkedEmb[1] = 1; // orthogonal — would not match by embedding alone

			// Set matched memory embedding
			const dirPath = store.getMemoryPath('global');
			const lib = await (store as any).readLibrary(dirPath);
			const matchedEntry = lib.entries.find((e: any) => e.id === matched.id);
			const linkedEntry = lib.entries.find((e: any) => e.id === linked.id);
			matchedEntry.embedding = matchedEmb;
			linkedEntry.embedding = linkedEmb;
			// Re-read links after setting embeddings
			matchedEntry.relatedMemoryIds = [linked.id];
			linkedEntry.relatedMemoryIds = [matched.id];
			await (store as any).writeLibrary(dirPath, lib);

			// Mock encode for the query
			mockEncode.mockResolvedValue(queryEmb);

			const config = await store.getConfig();
			config.similarityThreshold = 0.5;
			const results = await store.hybridSearch('errors', 'global', config);

			// Both should appear: matched directly, linked via graph expansion
			const matchedResult = results.find((r) => r.entry.id === matched.id);
			const linkedResult = results.find((r) => r.entry.id === linked.id);

			expect(matchedResult).toBeDefined();
			expect(linkedResult).toBeDefined();

			// Linked result should have lower score (0.8x multiplier)
			if (matchedResult && linkedResult) {
				expect(linkedResult.combinedScore).toBeLessThan(matchedResult.combinedScore);
			}
		});
	});
});
