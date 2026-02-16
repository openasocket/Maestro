/**
 * Tests for the ExperienceStore — file-backed per-project experience library.
 *
 * Uses a real temp directory for filesystem operations rather than mocking fs,
 * since the store relies on atomic rename and JSONL append semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron before importing the store
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { ExperienceStore } from '../../../main/grpo/experience-store';
import type { ExperienceEntry, ExperienceScope, ExperienceUpdateOperation } from '../../../shared/grpo-types';

let tmpDir: string;
let store: ExperienceStore;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-test-'));
	store = new ExperienceStore(tmpDir);
	await store.initialize();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<Omit<ExperienceEntry, 'id' | 'createdAt' | 'updatedAt' | 'useCount' | 'tokenEstimate'>> = {}) {
	return {
		content: overrides.content ?? 'Always check for existing useMemo patterns',
		category: overrides.category ?? 'testing',
		scope: overrides.scope ?? ('project' as ExperienceScope),
		agentType: overrides.agentType ?? 'claude-code',
		evidenceCount: overrides.evidenceCount ?? 1,
		lastRolloutGroupId: overrides.lastRolloutGroupId ?? null,
	};
}

describe('ExperienceStore', () => {
	describe('addExperience + getLibrary', () => {
		it('should create a new experience and return it from the library', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());

			expect(entry.id).toBeTruthy();
			expect(entry.content).toBe('Always check for existing useMemo patterns');
			expect(entry.createdAt).toBeGreaterThan(0);
			expect(entry.updatedAt).toBe(entry.createdAt);
			expect(entry.useCount).toBe(0);
			expect(entry.tokenEstimate).toBeGreaterThan(0);

			const library = await store.getLibrary('/project/a');
			expect(library).toHaveLength(1);
			expect(library[0].id).toBe(entry.id);
		});
	});

	describe('modifyExperience', () => {
		it('should update content and bump updatedAt', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());
			const originalUpdatedAt = entry.updatedAt;

			// Small delay to ensure timestamp differs
			await new Promise(r => setTimeout(r, 5));

			const modified = await store.modifyExperience('/project/a', entry.id, {
				content: 'Updated content here',
			});

			expect(modified.content).toBe('Updated content here');
			expect(modified.updatedAt).toBeGreaterThan(originalUpdatedAt);
			expect(modified.tokenEstimate).toBe(Math.ceil('Updated content here'.length / 4));

			const library = await store.getLibrary('/project/a');
			expect(library[0].content).toBe('Updated content here');
		});

		it('should update category', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());
			const modified = await store.modifyExperience('/project/a', entry.id, {
				category: 'architecture',
			});
			expect(modified.category).toBe('architecture');
		});

		it('should throw for non-existent experience', async () => {
			await expect(
				store.modifyExperience('/project/a', 'nonexistent-id', { content: 'x' })
			).rejects.toThrow('not found');
		});
	});

	describe('deleteExperience', () => {
		it('should remove an experience from the library', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());
			await store.deleteExperience('/project/a', entry.id);

			const library = await store.getLibrary('/project/a');
			expect(library).toHaveLength(0);
		});

		it('should throw for non-existent experience', async () => {
			await expect(
				store.deleteExperience('/project/a', 'nonexistent-id')
			).rejects.toThrow('not found');
		});
	});

	describe('applyOperations', () => {
		it('should batch-apply add, modify, and delete operations', async () => {
			// First add an experience to modify/delete
			const existing = await store.addExperience('/project/a', makeEntry({
				content: 'Original content',
			}));

			const operations: ExperienceUpdateOperation[] = [
				{
					operation: 'add',
					content: 'New experience from batch',
					category: 'tooling',
					reasoning: 'Discovered during rollout',
				},
				{
					operation: 'modify',
					targetId: existing.id,
					content: 'Modified via batch',
					reasoning: 'Refined insight',
				},
			];

			await store.applyOperations('/project/a', operations, 'rg-001', 3);

			const library = await store.getLibrary('/project/a');
			expect(library).toHaveLength(2);

			const modified = library.find(e => e.id === existing.id);
			expect(modified?.content).toBe('Modified via batch');
			expect(modified?.evidenceCount).toBe(2); // incremented from 1
			expect(modified?.lastRolloutGroupId).toBe('rg-001');

			const added = library.find(e => e.id !== existing.id);
			expect(added?.content).toBe('New experience from batch');
			expect(added?.category).toBe('tooling');
		});

		it('should handle delete in batch operations', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());

			await store.applyOperations('/project/a', [
				{ operation: 'delete', targetId: entry.id, reasoning: 'No longer relevant' },
			], 'rg-002');

			const library = await store.getLibrary('/project/a');
			expect(library).toHaveLength(0);
		});

		it('should skip operations for non-existent targets', async () => {
			await store.applyOperations('/project/a', [
				{ operation: 'modify', targetId: 'ghost', content: 'x', reasoning: 'test' },
				{ operation: 'delete', targetId: 'ghost2', reasoning: 'test' },
			], 'rg-003');

			const library = await store.getLibrary('/project/a');
			expect(library).toHaveLength(0);
		});
	});

	describe('project isolation', () => {
		it('should maintain separate libraries for different projects', async () => {
			await store.addExperience('/project/a', makeEntry({ content: 'For project A' }));
			await store.addExperience('/project/b', makeEntry({ content: 'For project B' }));

			const libA = await store.getLibrary('/project/a', undefined, false);
			const libB = await store.getLibrary('/project/b', undefined, false);

			expect(libA).toHaveLength(1);
			expect(libA[0].content).toBe('For project A');
			expect(libB).toHaveLength(1);
			expect(libB[0].content).toBe('For project B');
		});
	});

	describe('global fallback', () => {
		it('should return global library when project library is empty and fallback is enabled', async () => {
			// Add to global
			await store.addExperience('global', makeEntry({ content: 'Global insight', scope: 'global' }));

			// Empty project should fall back to global
			const library = await store.getLibrary('/project/empty', undefined, true);
			expect(library).toHaveLength(1);
			expect(library[0].content).toBe('Global insight');
		});

		it('should NOT return global library when fallback is disabled', async () => {
			await store.addExperience('global', makeEntry({ content: 'Global insight', scope: 'global' }));

			const library = await store.getLibrary('/project/empty', undefined, false);
			expect(library).toHaveLength(0);
		});

		it('should return project library when it has entries (no fallback needed)', async () => {
			await store.addExperience('global', makeEntry({ content: 'Global insight', scope: 'global' }));
			await store.addExperience('/project/a', makeEntry({ content: 'Project insight' }));

			const library = await store.getLibrary('/project/a', undefined, true);
			expect(library).toHaveLength(1);
			expect(library[0].content).toBe('Project insight');
		});

		it('should return global entries when scope is global', async () => {
			await store.addExperience('global', makeEntry({ content: 'Global insight', scope: 'global' }));
			await store.addExperience('/project/a', makeEntry({ content: 'Project insight' }));

			const library = await store.getLibrary('/project/a', 'global');
			expect(library).toHaveLength(1);
			expect(library[0].content).toBe('Global insight');
		});
	});

	describe('pruneStaleExperiences', () => {
		it('should remove experiences not used in N epochs', async () => {
			// Add an experience and log it at epoch 1
			await store.applyOperations('/project/a', [
				{ operation: 'add', content: 'Stale insight', category: 'testing', reasoning: 'test' },
			], 'rg-001', 1);

			// Add another at epoch 5
			await store.applyOperations('/project/a', [
				{ operation: 'add', content: 'Fresh insight', category: 'testing', reasoning: 'test' },
			], 'rg-002', 5);

			// Prune at epoch 7, pruneAfterEpochs=3 → entry from epoch 1 is stale (7-1=6 > 3)
			const pruned = await store.pruneStaleExperiences('/project/a', 7, 3);

			expect(pruned).toHaveLength(1);
			const library = await store.getLibrary('/project/a', undefined, false);
			expect(library).toHaveLength(1);
			expect(library[0].content).toBe('Fresh insight');
		});

		it('should not prune experiences that have been used', async () => {
			await store.applyOperations('/project/a', [
				{ operation: 'add', content: 'Used insight', category: 'testing', reasoning: 'test' },
			], 'rg-001', 1);

			const library = await store.getLibrary('/project/a', undefined, false);
			// Increment use count
			await store.incrementUseCount('/project/a', [library[0].id]);

			const pruned = await store.pruneStaleExperiences('/project/a', 7, 3);
			expect(pruned).toHaveLength(0);

			const afterPrune = await store.getLibrary('/project/a', undefined, false);
			expect(afterPrune).toHaveLength(1);
		});
	});

	describe('atomic write consistency', () => {
		it('should maintain consistent library even during concurrent reads', async () => {
			// Add an entry
			const entry = await store.addExperience('/project/a', makeEntry({ content: 'Test entry' }));

			// Read during a concurrent write — should get either old or new state, never corrupt
			const [, library] = await Promise.all([
				store.modifyExperience('/project/a', entry.id, { content: 'Updated entry' }),
				store.getLibrary('/project/a', undefined, false),
			]);

			// Library should be valid (either old or new content)
			expect(library).toHaveLength(1);
			expect(['Test entry', 'Updated entry']).toContain(library[0].content);
		});
	});

	describe('getHistory', () => {
		it('should log all operations to JSONL history', async () => {
			const entry = await store.addExperience('/project/a', makeEntry());
			await store.modifyExperience('/project/a', entry.id, { content: 'Updated' });
			await store.deleteExperience('/project/a', entry.id);

			const history = await store.getHistory('/project/a');
			expect(history).toHaveLength(3);

			// Most recent first
			expect(history[0].operation).toBe('delete');
			expect(history[1].operation).toBe('modify');
			expect(history[2].operation).toBe('add');
		});

		it('should respect limit parameter', async () => {
			await store.addExperience('/project/a', makeEntry({ content: 'One' }));
			await store.addExperience('/project/a', makeEntry({ content: 'Two' }));
			await store.addExperience('/project/a', makeEntry({ content: 'Three' }));

			const history = await store.getHistory('/project/a', 2);
			expect(history).toHaveLength(2);
		});

		it('should include rolloutGroupId and epoch from applyOperations', async () => {
			await store.applyOperations('/project/a', [
				{ operation: 'add', content: 'Insight', category: 'testing', reasoning: 'test' },
			], 'rg-005', 4);

			const history = await store.getHistory('/project/a');
			expect(history[0].rolloutGroupId).toBe('rg-005');
			expect(history[0].epoch).toBe(4);
		});
	});

	describe('token estimation', () => {
		it('should estimate tokens on add', async () => {
			const content = 'This is a test content string';
			const entry = await store.addExperience('/project/a', makeEntry({ content }));
			expect(entry.tokenEstimate).toBe(Math.ceil(content.length / 4));
		});

		it('should recalculate tokens on modify', async () => {
			const entry = await store.addExperience('/project/a', makeEntry({ content: 'Short' }));
			const newContent = 'A much longer content string that should have more tokens estimated';
			const modified = await store.modifyExperience('/project/a', entry.id, { content: newContent });
			expect(modified.tokenEstimate).toBe(Math.ceil(newContent.length / 4));
		});
	});

	describe('incrementUseCount', () => {
		it('should increment use count for specified IDs', async () => {
			const e1 = await store.addExperience('/project/a', makeEntry({ content: 'One' }));
			const e2 = await store.addExperience('/project/a', makeEntry({ content: 'Two' }));

			await store.incrementUseCount('/project/a', [e1.id]);
			await store.incrementUseCount('/project/a', [e1.id, e2.id]);

			const library = await store.getLibrary('/project/a', undefined, false);
			const updated1 = library.find(e => e.id === e1.id);
			const updated2 = library.find(e => e.id === e2.id);

			expect(updated1?.useCount).toBe(2);
			expect(updated2?.useCount).toBe(1);
		});
	});

	describe('write serialization', () => {
		it('should serialize concurrent writes to the same project', async () => {
			// Fire off multiple concurrent adds
			const promises = Array.from({ length: 10 }, (_, i) =>
				store.addExperience('/project/a', makeEntry({ content: `Entry ${i}` }))
			);

			const results = await Promise.all(promises);
			expect(results).toHaveLength(10);

			// All should be in the library
			const library = await store.getLibrary('/project/a', undefined, false);
			expect(library).toHaveLength(10);

			// All should have unique IDs
			const ids = new Set(library.map(e => e.id));
			expect(ids.size).toBe(10);
		});
	});

	describe('projectPathToHash', () => {
		it('should produce a 12-character hex string', () => {
			const hash = store.projectPathToHash('/home/dr3/dev-shit/Maestro');
			expect(hash).toMatch(/^[0-9a-f]{12}$/);
		});

		it('should be deterministic', () => {
			const h1 = store.projectPathToHash('/project/a');
			const h2 = store.projectPathToHash('/project/a');
			expect(h1).toBe(h2);
		});

		it('should produce different hashes for different paths', () => {
			const h1 = store.projectPathToHash('/project/a');
			const h2 = store.projectPathToHash('/project/b');
			expect(h1).not.toBe(h2);
		});

		it('should return "global" for the global key', () => {
			expect(store.projectPathToHash('global')).toBe('global');
		});
	});

	describe('meta.json', () => {
		it('should write meta.json with the original project path', async () => {
			await store.addExperience('/home/user/project', makeEntry());

			const hash = store.projectPathToHash('/home/user/project');
			const metaPath = path.join(tmpDir, hash, 'meta.json');
			const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

			expect(meta.projectPath).toBe('/home/user/project');
			expect(meta.createdAt).toBeGreaterThan(0);
		});
	});
});
