/**
 * Tests for MemoryStore.generateProjectDigest() and updateProjectDigest()
 * — project digest generation, incremental delta-merge, and recompaction.
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

vi.mock('../../grpo/embedding-service', () => ({
	cosineSimilarity: vi.fn(() => 0.5),
	encode: vi.fn(async () => new Array(384).fill(0)),
	encodeBatch: vi.fn(async (texts: string[]) => texts.map(() => new Array(384).fill(0))),
}));

// ─── Import under test ──────────────────────────────────────────────────────

import { MemoryStore } from '../memory-store';
import type { MemoryEntry } from '../../../shared/memory-types';

describe('MemoryStore Project Digest', () => {
	let store: MemoryStore;
	const projectPath = '/test/project';

	beforeEach(() => {
		fsState.clear();
		vi.clearAllMocks();
		store = new MemoryStore();
	});

	// ─── generateProjectDigest ──────────────────────────────────────────

	describe('generateProjectDigest', () => {
		it('should return null when no project memories exist', async () => {
			const result = await store.generateProjectDigest(projectPath);
			expect(result).toBeNull();
		});

		it('should generate a digest from project memories', async () => {
			// Add some project memories
			await store.addMemory(
				{
					content: 'Always use prepared statements for SQL',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: ['category:pattern-established'],
				},
				projectPath
			);

			await store.addMemory(
				{
					content: 'Fixed race condition in worker pool',
					type: 'experience',
					scope: 'project',
					source: 'session-analysis',
					confidence: 0.7,
					pinned: false,
					tags: ['category:problem-solved'],
				},
				projectPath
			);

			const digest = await store.generateProjectDigest(projectPath, 10, true);

			expect(digest).not.toBeNull();
			expect(digest).toContain('Project: project');
			expect(digest).toContain('---');
			expect(digest).toContain('Patterns:');
			expect(digest).toContain('Problems:');
			expect(digest).toContain('Decisions:');
			expect(digest).toContain('Always use prepared statements');
			expect(digest).toContain('Fixed race condition');
			expect(digest).toContain('2 project memories');
		});

		it('should return cached digest when forceRegenerate is false', async () => {
			// Add a memory and generate initial digest
			await store.addMemory(
				{
					content: 'Test memory',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: ['category:pattern-established'],
				},
				projectPath
			);

			const firstDigest = await store.generateProjectDigest(projectPath, 10, true);
			expect(firstDigest).not.toBeNull();

			// Call again without forceRegenerate — should return the cached version
			const secondDigest = await store.generateProjectDigest(projectPath, 10, false);
			expect(secondDigest).toBe(firstDigest);
		});

		it('should regenerate digest when forceRegenerate is true', async () => {
			await store.addMemory(
				{
					content: 'Memory 1',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: [],
				},
				projectPath
			);

			await store.generateProjectDigest(projectPath, 10, true);

			// Add another memory
			await store.addMemory(
				{
					content: 'Memory 2',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: [],
				},
				projectPath
			);

			const regenDigest = await store.generateProjectDigest(projectPath, 10, true);
			expect(regenDigest).toContain('Memory 2');
		});

		it('should sort by combinedScore and limit to maxMemories', async () => {
			// Add more than maxMemories entries
			for (let i = 0; i < 15; i++) {
				await store.addMemory(
					{
						content: `Memory ${i}`,
						type: 'rule',
						scope: 'project',
						source: 'user',
						confidence: i / 15,
						pinned: false,
						tags: [],
					},
					projectPath
				);
			}

			const digest = await store.generateProjectDigest(projectPath, 5, true);
			expect(digest).not.toBeNull();
			expect(digest).toContain('showing top 5');
			expect(digest).toContain('15 project memories');
		});

		it('should exclude the digest entry itself from regeneration', async () => {
			await store.addMemory(
				{
					content: 'Real memory',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: [],
				},
				projectPath
			);

			// Generate first digest
			await store.generateProjectDigest(projectPath, 10, true);

			// Regenerate — the digest entry should not appear as a memory line in itself
			const regen = await store.generateProjectDigest(projectPath, 10, true);
			expect(regen).not.toBeNull();
			// Should reference just 1 project memory, not 2
			expect(regen).toContain('1 project memories');
		});
	});

	// ─── updateProjectDigest ────────────────────────────────────────────

	describe('updateProjectDigest', () => {
		it('should create a fresh digest when none exists', async () => {
			await store.addMemory(
				{
					content: 'Existing memory',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: [],
				},
				projectPath
			);

			const newMemory: MemoryEntry = {
				id: 'new-memory-id',
				content: 'New experience learned',
				type: 'experience',
				scope: 'project',
				tags: ['category:problem-solved'],
				source: 'session-analysis',
				confidence: 0.7,
				pinned: false,
				active: true,
				archived: false,
				embedding: null,
				effectivenessScore: 0.5,
				useCount: 0,
				tokenEstimate: 10,
				lastUsedAt: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			await store.updateProjectDigest(projectPath, newMemory);

			// Should have generated a digest
			const digest = await store.generateProjectDigest(projectPath);
			expect(digest).not.toBeNull();
		});

		it('should append delta line to existing digest', async () => {
			// Create initial memory and digest
			await store.addMemory(
				{
					content: 'Initial memory',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: ['category:pattern-established'],
				},
				projectPath
			);

			await store.generateProjectDigest(projectPath, 10, true);

			const newMemory: MemoryEntry = {
				id: 'delta-memory',
				content: 'Delta experience',
				type: 'experience',
				scope: 'project',
				tags: ['category:problem-solved'],
				source: 'session-analysis',
				confidence: 0.7,
				pinned: false,
				active: true,
				archived: false,
				embedding: null,
				effectivenessScore: 0.6,
				useCount: 0,
				tokenEstimate: 10,
				lastUsedAt: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			await store.updateProjectDigest(projectPath, newMemory);

			// The digest should now include the delta line
			const updatedDigest = await store.generateProjectDigest(projectPath);
			expect(updatedDigest).toContain('Delta experience');
			expect(updatedDigest).toContain('[problem-solved]');
		});

		it('should use memory type as fallback when no category tag', async () => {
			await store.addMemory(
				{
					content: 'Initial memory',
					type: 'rule',
					scope: 'project',
					source: 'user',
					confidence: 0.9,
					pinned: false,
					tags: [],
				},
				projectPath
			);

			await store.generateProjectDigest(projectPath, 10, true);

			const newMemory: MemoryEntry = {
				id: 'no-category-memory',
				content: 'Memory without category tag',
				type: 'experience',
				scope: 'project',
				tags: [],
				source: 'session-analysis',
				confidence: 0.7,
				pinned: false,
				active: true,
				archived: false,
				embedding: null,
				effectivenessScore: 0.5,
				useCount: 0,
				tokenEstimate: 10,
				lastUsedAt: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};

			await store.updateProjectDigest(projectPath, newMemory);

			const digest = await store.generateProjectDigest(projectPath);
			expect(digest).toContain('[experience]');
		});
	});
});
