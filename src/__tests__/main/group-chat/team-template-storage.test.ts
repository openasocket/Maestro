/**
 * @file team-template-storage.test.ts
 * @description Unit tests for the Team Template storage utilities.
 *
 * Tests cover:
 * - Listing templates (empty state, with templates)
 * - Getting a template by ID
 * - Saving templates
 * - Deleting templates (user vs builtin protection)
 * - Duplicating templates
 * - Built-in template seeding
 * - Write queue serialization
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { TeamTemplate } from '../../../shared/group-chat-types';

// Mock Electron's app module before importing the storage module
let mockUserDataPath: string;
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => {
			if (name === 'userData') {
				return mockUserDataPath;
			}
			throw new Error(`Unknown path name: ${name}`);
		}),
	},
}));

// Mock electron-store to return no custom path (use userData)
vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			get() {
				return undefined;
			}
			set() {}
		},
	};
});

// Mock the uuid module to return incrementing IDs
let mockUuidCounter = 0;
vi.mock('uuid', () => ({
	v4: vi.fn(() => `test-uuid-${++mockUuidCounter}`),
}));

import {
	listTemplates,
	getTemplate,
	saveTemplate,
	deleteTemplate,
	duplicateTemplate,
	getTeamTemplatesDir,
	getBuiltinTemplates,
	_resetSeededFlag,
} from '../../../main/group-chat/team-template-storage';

/**
 * Helper to create a valid TeamTemplate for testing.
 */
function makeTemplate(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
	const now = Date.now();
	return {
		id: overrides.id ?? `test-${now}-${Math.random().toString(36).slice(2)}`,
		name: overrides.name ?? 'Test Template',
		description: overrides.description ?? 'A test template',
		category: overrides.category ?? 'user',
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		moderatorAgentId: overrides.moderatorAgentId ?? 'claude-code',
		roles: overrides.roles ?? [
			{
				name: 'Developer',
				agentId: 'claude-code',
				description: 'Writes code',
			},
		],
		...(overrides.icon !== undefined ? { icon: overrides.icon } : {}),
		...(overrides.moderatorConfig !== undefined
			? { moderatorConfig: overrides.moderatorConfig }
			: {}),
		...(overrides.topology !== undefined ? { topology: overrides.topology } : {}),
	};
}

describe('team-template-storage', () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = path.join(
			os.tmpdir(),
			`team-template-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		await fs.mkdir(testDir, { recursive: true });

		mockUserDataPath = testDir;
		mockUuidCounter = 0;
		_resetSeededFlag();
	});

	afterEach(async () => {
		try {
			await fs.rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		vi.clearAllMocks();
	});

	// ===========================================================================
	// listTemplates
	// ===========================================================================
	describe('listTemplates', () => {
		it('returns seeded builtins when no user templates exist', async () => {
			const result = await listTemplates();
			// Only builtins should be present (4 built-in templates)
			expect(result).toHaveLength(4);
			expect(result.every((t) => t.category === 'builtin')).toBe(true);
		});

		it('returns saved templates alongside builtins', async () => {
			const template = makeTemplate({ id: 'tmpl-1', name: 'Alpha' });
			await saveTemplate(template);

			const result = await listTemplates();
			// 4 builtins + 1 user template
			expect(result).toHaveLength(5);
			const userTemplates = result.filter((t) => t.category === 'user');
			expect(userTemplates).toHaveLength(1);
			expect(userTemplates[0].id).toBe('tmpl-1');
			expect(userTemplates[0].name).toBe('Alpha');
		});

		it('sorts templates by category then name', async () => {
			const builtin = makeTemplate({ id: 'b1', name: 'Zeta', category: 'builtin' });
			const user1 = makeTemplate({ id: 'u1', name: 'Beta', category: 'user' });
			const user2 = makeTemplate({ id: 'u2', name: 'Alpha', category: 'user' });

			await saveTemplate(user1);
			await saveTemplate(builtin);
			await saveTemplate(user2);

			const result = await listTemplates();
			// 4 seeded builtins + 1 custom builtin + 2 user = 7
			expect(result).toHaveLength(7);
			// All builtins come first (sorted alphabetically)
			const builtins = result.filter((t) => t.category === 'builtin');
			const users = result.filter((t) => t.category === 'user');
			expect(builtins).toHaveLength(5); // 4 seeded + b1
			expect(users).toHaveLength(2);
			// Verify user templates are sorted alphabetically
			expect(users[0].id).toBe('u2'); // Alpha
			expect(users[1].id).toBe('u1'); // Beta
			// Verify builtins come before users in the full list
			const firstUserIdx = result.findIndex((t) => t.category === 'user');
			const lastBuiltinIdx =
				result.length - 1 - [...result].reverse().findIndex((t) => t.category === 'builtin');
			expect(lastBuiltinIdx).toBeLessThan(firstUserIdx);
		});

		it('skips .tmp files', async () => {
			const template = makeTemplate({ id: 'tmpl-1' });
			await saveTemplate(template);

			// Create a .tmp file that should be ignored
			const dir = getTeamTemplatesDir();
			await fs.writeFile(path.join(dir, 'orphaned.json.tmp'), '{}', 'utf-8');

			const result = await listTemplates();
			// 4 builtins + 1 user template (tmp file should be skipped)
			expect(result).toHaveLength(5);
		});

		it('skips corrupted JSON files', async () => {
			const template = makeTemplate({ id: 'good' });
			await saveTemplate(template);

			// Create a corrupted file
			const dir = getTeamTemplatesDir();
			await fs.writeFile(path.join(dir, 'bad.json'), '{not valid json', 'utf-8');

			const result = await listTemplates();
			// 4 builtins + 1 user template (corrupted file should be skipped)
			expect(result).toHaveLength(5);
			const userTemplates = result.filter((t) => t.category === 'user');
			expect(userTemplates).toHaveLength(1);
			expect(userTemplates[0].id).toBe('good');
		});
	});

	// ===========================================================================
	// getTemplate
	// ===========================================================================
	describe('getTemplate', () => {
		it('returns template by ID', async () => {
			const template = makeTemplate({ id: 'my-template' });
			await saveTemplate(template);

			const loaded = await getTemplate('my-template');
			expect(loaded).not.toBeNull();
			expect(loaded!.id).toBe('my-template');
			expect(loaded!.name).toBe(template.name);
		});

		it('returns null for non-existent template', async () => {
			const result = await getTemplate('does-not-exist');
			expect(result).toBeNull();
		});

		it('returns null for empty file', async () => {
			const dir = getTeamTemplatesDir();
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, 'empty.json'), '', 'utf-8');

			const result = await getTemplate('empty');
			expect(result).toBeNull();
		});

		it('returns null for malformed JSON', async () => {
			const dir = getTeamTemplatesDir();
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(path.join(dir, 'broken.json'), '{invalid', 'utf-8');

			const result = await getTemplate('broken');
			expect(result).toBeNull();
		});
	});

	// ===========================================================================
	// saveTemplate
	// ===========================================================================
	describe('saveTemplate', () => {
		it('saves template to disk', async () => {
			const template = makeTemplate({ id: 'save-test' });
			await saveTemplate(template);

			const filePath = path.join(getTeamTemplatesDir(), 'save-test.json');
			const content = await fs.readFile(filePath, 'utf-8');
			const parsed = JSON.parse(content);

			expect(parsed.id).toBe('save-test');
			expect(parsed.name).toBe(template.name);
		});

		it('sets updatedAt on save', async () => {
			const template = makeTemplate({ id: 'ts-test', updatedAt: 1000 });
			const beforeSave = Date.now();
			await saveTemplate(template);
			const afterSave = Date.now();

			const loaded = await getTemplate('ts-test');
			expect(loaded!.updatedAt).toBeGreaterThanOrEqual(beforeSave);
			expect(loaded!.updatedAt).toBeLessThanOrEqual(afterSave);
		});

		it('creates directory if it does not exist', async () => {
			const template = makeTemplate({ id: 'mkdir-test' });
			await saveTemplate(template);

			const dirExists = await fs
				.access(getTeamTemplatesDir())
				.then(() => true)
				.catch(() => false);
			expect(dirExists).toBe(true);
		});

		it('overwrites existing template', async () => {
			const template = makeTemplate({ id: 'overwrite-test', name: 'Version 1' });
			await saveTemplate(template);

			const updated = { ...template, name: 'Version 2' };
			await saveTemplate(updated);

			const loaded = await getTemplate('overwrite-test');
			expect(loaded!.name).toBe('Version 2');
		});
	});

	// ===========================================================================
	// deleteTemplate
	// ===========================================================================
	describe('deleteTemplate', () => {
		it('deletes user template', async () => {
			const template = makeTemplate({ id: 'del-test', category: 'user' });
			await saveTemplate(template);

			await deleteTemplate('del-test');

			const loaded = await getTemplate('del-test');
			expect(loaded).toBeNull();
		});

		it('throws when deleting builtin template', async () => {
			const template = makeTemplate({ id: 'builtin-test', category: 'builtin' });
			await saveTemplate(template);

			await expect(deleteTemplate('builtin-test')).rejects.toThrow(
				/Cannot delete builtin template/
			);

			// Template should still exist
			const loaded = await getTemplate('builtin-test');
			expect(loaded).not.toBeNull();
		});

		it('throws when deleting exchange template', async () => {
			const template = makeTemplate({ id: 'exchange-test', category: 'exchange' });
			await saveTemplate(template);

			await expect(deleteTemplate('exchange-test')).rejects.toThrow(
				/Cannot delete exchange template/
			);
		});

		it('throws when deleting non-existent template', async () => {
			await expect(deleteTemplate('ghost')).rejects.toThrow(/Template not found/);
		});
	});

	// ===========================================================================
	// duplicateTemplate
	// ===========================================================================
	describe('duplicateTemplate', () => {
		it('creates a copy with new ID and name', async () => {
			const original = makeTemplate({
				id: 'orig',
				name: 'Original',
				category: 'builtin',
				roles: [
					{ name: 'Dev', agentId: 'claude-code', description: 'Develops' },
					{ name: 'QA', agentId: 'claude-code', description: 'Tests' },
				],
			});
			await saveTemplate(original);

			const duplicate = await duplicateTemplate('orig', 'My Copy');

			expect(duplicate.id).not.toBe('orig');
			expect(duplicate.name).toBe('My Copy');
			expect(duplicate.category).toBe('user');
			expect(duplicate.roles).toHaveLength(2);
			expect(duplicate.roles[0].name).toBe('Dev');
			expect(duplicate.roles[1].name).toBe('QA');
		});

		it('duplicate is persisted to disk', async () => {
			const original = makeTemplate({ id: 'orig2' });
			await saveTemplate(original);

			const duplicate = await duplicateTemplate('orig2', 'Dup');
			const loaded = await getTemplate(duplicate.id);

			expect(loaded).not.toBeNull();
			expect(loaded!.name).toBe('Dup');
		});

		it('throws when source template does not exist', async () => {
			await expect(duplicateTemplate('ghost', 'Copy')).rejects.toThrow(/Template not found/);
		});

		it('sets fresh timestamps on duplicate', async () => {
			const original = makeTemplate({
				id: 'old-tmpl',
				createdAt: 1000,
				updatedAt: 1000,
			});
			await saveTemplate(original);

			const beforeDup = Date.now();
			const duplicate = await duplicateTemplate('old-tmpl', 'New');
			const afterDup = Date.now();

			expect(duplicate.createdAt).toBeGreaterThanOrEqual(beforeDup);
			expect(duplicate.createdAt).toBeLessThanOrEqual(afterDup);
			expect(duplicate.updatedAt).toBeGreaterThanOrEqual(beforeDup);
		});
	});

	// ===========================================================================
	// getBuiltinTemplates
	// ===========================================================================
	describe('getBuiltinTemplates', () => {
		it('returns an array of 4 built-in templates', () => {
			const builtins = getBuiltinTemplates();
			expect(builtins).toHaveLength(4);
		});

		it('all builtins have category "builtin"', () => {
			const builtins = getBuiltinTemplates();
			for (const t of builtins) {
				expect(t.category).toBe('builtin');
			}
		});

		it('all builtins have deterministic IDs starting with "builtin-"', () => {
			const builtins = getBuiltinTemplates();
			for (const t of builtins) {
				expect(t.id).toMatch(/^builtin-/);
			}
		});

		it('all builtins have at least one role', () => {
			const builtins = getBuiltinTemplates();
			for (const t of builtins) {
				expect(t.roles.length).toBeGreaterThanOrEqual(1);
			}
		});

		it('includes Code Review Team', () => {
			const builtins = getBuiltinTemplates();
			const cr = builtins.find((t) => t.id === 'builtin-code-review');
			expect(cr).toBeDefined();
			expect(cr!.name).toBe('Code Review Team');
			expect(cr!.roles).toHaveLength(3);
			expect(cr!.roles.map((r) => r.name)).toEqual(['Implementer', 'Code Reviewer', 'Test Writer']);
		});

		it('includes Research & Synthesis Team', () => {
			const builtins = getBuiltinTemplates();
			const rs = builtins.find((t) => t.id === 'builtin-research-synthesis');
			expect(rs).toBeDefined();
			expect(rs!.name).toBe('Research & Synthesis Team');
			expect(rs!.roles).toHaveLength(3);
			expect(rs!.roles.map((r) => r.name)).toEqual(['Researcher', 'Analyst', 'Synthesizer']);
		});

		it('includes Full Stack Development', () => {
			const builtins = getBuiltinTemplates();
			const fs = builtins.find((t) => t.id === 'builtin-full-stack');
			expect(fs).toBeDefined();
			expect(fs!.name).toBe('Full Stack Development');
			expect(fs!.roles).toHaveLength(3);
			expect(fs!.roles.map((r) => r.name)).toEqual([
				'Frontend Developer',
				'Backend Developer',
				'DevOps Engineer',
			]);
		});

		it('includes Architecture Review', () => {
			const builtins = getBuiltinTemplates();
			const ar = builtins.find((t) => t.id === 'builtin-architecture-review');
			expect(ar).toBeDefined();
			expect(ar!.name).toBe('Architecture Review');
			expect(ar!.roles).toHaveLength(3);
			expect(ar!.roles.map((r) => r.name)).toEqual([
				'Architect',
				'Security Reviewer',
				'Performance Analyst',
			]);
		});
	});

	// ===========================================================================
	// Builtin seeding
	// ===========================================================================
	describe('builtin seeding', () => {
		it('creates team-templates directory on first list', async () => {
			await listTemplates();

			const dirExists = await fs
				.access(getTeamTemplatesDir())
				.then(() => true)
				.catch(() => false);
			expect(dirExists).toBe(true);
		});

		it('seeds builtin templates to disk on first list', async () => {
			const result = await listTemplates();
			const builtinIds = result.filter((t) => t.category === 'builtin').map((t) => t.id);
			expect(builtinIds).toContain('builtin-code-review');
			expect(builtinIds).toContain('builtin-research-synthesis');
			expect(builtinIds).toContain('builtin-full-stack');
			expect(builtinIds).toContain('builtin-architecture-review');
		});

		it('does not overwrite existing builtin templates on re-seed', async () => {
			// Seed once
			await listTemplates();

			// Manually modify a seeded template on disk
			const dir = getTeamTemplatesDir();
			const filePath = path.join(dir, 'builtin-code-review.json');
			const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
			content.description = 'User-modified description';
			await fs.writeFile(filePath, JSON.stringify(content), 'utf-8');

			// Reset and re-seed
			_resetSeededFlag();
			await listTemplates();

			// Should not have overwritten
			const loaded = await getTemplate('builtin-code-review');
			expect(loaded!.description).toBe('User-modified description');
		});
	});

	// ===========================================================================
	// Write queue serialization
	// ===========================================================================
	describe('write queue', () => {
		it('handles concurrent saves to the same template', async () => {
			const template = makeTemplate({ id: 'concurrent' });

			// Fire multiple saves concurrently
			const saves = Array.from({ length: 5 }, (_, i) =>
				saveTemplate({ ...template, name: `Version ${i}` })
			);
			await Promise.all(saves);

			// Template should exist and have one of the versions
			const loaded = await getTemplate('concurrent');
			expect(loaded).not.toBeNull();
			expect(loaded!.name).toMatch(/^Version \d$/);
		});

		it('handles concurrent saves to different templates', async () => {
			const saves = Array.from({ length: 5 }, (_, i) =>
				saveTemplate(makeTemplate({ id: `tmpl-${i}`, name: `Template ${i}` }))
			);
			await Promise.all(saves);

			const all = await listTemplates();
			// 4 builtins + 5 user templates
			expect(all).toHaveLength(9);
			const userTemplates = all.filter((t) => t.category === 'user');
			expect(userTemplates).toHaveLength(5);
		});
	});
});
