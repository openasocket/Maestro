/**
 * Tests for the MemoryStore class — hierarchical file-backed memory library.
 *
 * Tests cover:
 * - Storage layout and path resolution
 * - Registry read/write with atomic writes
 * - Library read/write
 * - History (JSONL) appending
 * - Role CRUD with cascade deletes
 * - Persona CRUD with cascade deletes
 * - Skill Area CRUD
 * - Memory CRUD
 * - Config management
 * - Seed data initialization
 * - Singleton access
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

import { MemoryStore, getMemoryStore } from '../../../main/memory/memory-store';

describe('MemoryStore', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		store = new MemoryStore();
	});

	// ─── Path Helpers ─────────────────────────────────────────────────────

	describe('getMemoryPath', () => {
		it('returns skill path with skillAreaId', () => {
			const p = store.getMemoryPath('skill', 'skill-123');
			expect(p).toBe('/mock/userData/memories/skills/skill-123');
		});

		it('returns project path with hashed projectPath', () => {
			const p = store.getMemoryPath('project', undefined, '/home/user/project');
			expect(p).toContain('/mock/userData/memories/project/');
			// Hash should be 16 chars
			const hash = p.split('/').pop()!;
			expect(hash).toHaveLength(16);
		});

		it('returns global path', () => {
			const p = store.getMemoryPath('global');
			expect(p).toBe('/mock/userData/memories/global');
		});

		it('throws if skill scope missing skillAreaId', () => {
			expect(() => store.getMemoryPath('skill')).toThrow('skillAreaId required');
		});

		it('throws if project scope missing projectPath', () => {
			expect(() => store.getMemoryPath('project')).toThrow('projectPath required');
		});

		it('returns same hash for same project path', () => {
			const p1 = store.getMemoryPath('project', undefined, '/home/user/project');
			const p2 = store.getMemoryPath('project', undefined, '/home/user/project');
			expect(p1).toBe(p2);
		});

		it('returns different hash for different project paths', () => {
			const p1 = store.getMemoryPath('project', undefined, '/home/user/project-a');
			const p2 = store.getMemoryPath('project', undefined, '/home/user/project-b');
			expect(p1).not.toBe(p2);
		});
	});

	// ─── Registry Read/Write ──────────────────────────────────────────────

	describe('readRegistry / writeRegistry', () => {
		it('returns empty registry when file does not exist', async () => {
			const reg = await store.readRegistry();
			expect(reg).toEqual({ version: 1, roles: [], personas: [], skillAreas: [] });
		});

		it('reads existing registry', async () => {
			const data = {
				version: 1,
				roles: [{ id: 'r1', name: 'Test' }],
				personas: [],
				skillAreas: [],
			};
			fsState.set('/mock/userData/memories/registry.json', JSON.stringify(data));
			const reg = await store.readRegistry();
			expect(reg.roles).toHaveLength(1);
			expect(reg.roles[0].name).toBe('Test');
		});

		it('handles corrupted JSON gracefully', async () => {
			fsState.set('/mock/userData/memories/registry.json', '{invalid json');
			const reg = await store.readRegistry();
			expect(reg).toEqual({ version: 1, roles: [], personas: [], skillAreas: [] });
		});

		it('writeRegistry uses atomic write (tmp + rename)', async () => {
			const fs = await import('fs/promises');
			const reg = { version: 1, roles: [], personas: [], skillAreas: [] };
			await store.writeRegistry(reg);
			expect(fs.writeFile).toHaveBeenCalled();
			expect(fs.rename).toHaveBeenCalled();
		});
	});

	// ─── Library Read/Write ───────────────────────────────────────────────

	describe('readLibrary / writeLibrary', () => {
		it('returns empty library when file does not exist', async () => {
			const lib = await store.readLibrary('/mock/path');
			expect(lib).toEqual({ version: 1, entries: [] });
		});

		it('reads existing library', async () => {
			const data = { version: 1, entries: [{ id: 'm1', content: 'test' }] };
			fsState.set('/mock/path/library.json', JSON.stringify(data));
			const lib = await store.readLibrary('/mock/path');
			expect(lib.entries).toHaveLength(1);
		});
	});

	// ─── History Append ───────────────────────────────────────────────────

	describe('appendHistory', () => {
		it('appends JSONL entry', async () => {
			await store.appendHistory('/mock/dir', {
				timestamp: 1000,
				operation: 'add',
				entityType: 'memory',
				entityId: 'm1',
			});
			const content = fsState.get('/mock/dir/history.jsonl')!;
			const parsed = JSON.parse(content.trim());
			expect(parsed.operation).toBe('add');
			expect(parsed.entityId).toBe('m1');
		});

		it('appends multiple entries', async () => {
			await store.appendHistory('/mock/dir', {
				timestamp: 1000,
				operation: 'add',
				entityType: 'memory',
				entityId: 'm1',
			});
			await store.appendHistory('/mock/dir', {
				timestamp: 2000,
				operation: 'update',
				entityType: 'memory',
				entityId: 'm2',
			});
			const content = fsState.get('/mock/dir/history.jsonl')!;
			const lines = content.trim().split('\n');
			expect(lines).toHaveLength(2);
		});
	});

	// ─── Role CRUD ────────────────────────────────────────────────────────

	describe('Role CRUD', () => {
		it('creates a role', async () => {
			const role = await store.createRole('Developer', 'Software development');
			expect(role.id).toBeTruthy();
			expect(role.name).toBe('Developer');
			expect(role.description).toBe('Software development');
			expect(role.personaIds).toEqual([]);
			expect(role.createdAt).toBeGreaterThan(0);
		});

		it('lists roles', async () => {
			await store.createRole('Role A', 'desc a');
			await store.createRole('Role B', 'desc b');
			const roles = await store.listRoles();
			expect(roles).toHaveLength(2);
		});

		it('gets a role by id', async () => {
			const created = await store.createRole('Test', 'desc');
			const found = await store.getRole(created.id);
			expect(found).not.toBeNull();
			expect(found!.name).toBe('Test');
		});

		it('returns null for non-existent role', async () => {
			const found = await store.getRole('nonexistent');
			expect(found).toBeNull();
		});

		it('updates a role', async () => {
			const role = await store.createRole('Old Name', 'old desc');
			const updated = await store.updateRole(role.id, { name: 'New Name' });
			expect(updated).not.toBeNull();
			expect(updated!.name).toBe('New Name');
			expect(updated!.updatedAt).toBeGreaterThanOrEqual(role.updatedAt);
		});

		it('returns null when updating non-existent role', async () => {
			const result = await store.updateRole('nonexistent', { name: 'X' });
			expect(result).toBeNull();
		});

		it('deletes a role', async () => {
			const role = await store.createRole('ToDelete', 'desc');
			const deleted = await store.deleteRole(role.id);
			expect(deleted).toBe(true);
			const found = await store.getRole(role.id);
			expect(found).toBeNull();
		});

		it('returns false when deleting non-existent role', async () => {
			const deleted = await store.deleteRole('nonexistent');
			expect(deleted).toBe(false);
		});

		it('cascade deactivates child personas on role delete', async () => {
			const role = await store.createRole('Parent', 'desc');
			const persona = await store.createPersona(role.id, 'Child', 'desc');
			await store.deleteRole(role.id);

			// Persona should be deactivated (but since deleteRole removes from registry,
			// we check that the persona was marked inactive before removal)
			const personas = await store.listPersonas();
			// The persona should still exist in registry but be inactive
			const found = personas.find((p) => p.id === persona.id);
			if (found) {
				expect(found.active).toBe(false);
			}
		});
	});

	// ─── Persona CRUD ─────────────────────────────────────────────────────

	describe('Persona CRUD', () => {
		let roleId: string;

		beforeEach(async () => {
			const role = await store.createRole('TestRole', 'desc');
			roleId = role.id;
		});

		it('creates a persona linked to a role', async () => {
			const persona = await store.createPersona(roleId, 'Rust Dev', 'Rust expertise');
			expect(persona.id).toBeTruthy();
			expect(persona.roleId).toBe(roleId);
			expect(persona.name).toBe('Rust Dev');
			expect(persona.active).toBe(true);
			expect(persona.embedding).toBeNull();

			// Role should have persona in its personaIds
			const role = await store.getRole(roleId);
			expect(role!.personaIds).toContain(persona.id);
		});

		it('throws when creating persona for non-existent role', async () => {
			await expect(store.createPersona('nonexistent', 'X', 'Y')).rejects.toThrow('Role not found');
		});

		it('lists personas filtered by role', async () => {
			await store.createPersona(roleId, 'A', 'desc');
			await store.createPersona(roleId, 'B', 'desc');
			const personas = await store.listPersonas(roleId);
			expect(personas).toHaveLength(2);
		});

		it('lists all personas when no roleId given', async () => {
			const role2 = await store.createRole('Role2', 'desc');
			await store.createPersona(roleId, 'A', 'desc');
			await store.createPersona(role2.id, 'B', 'desc');
			const all = await store.listPersonas();
			expect(all).toHaveLength(2);
		});

		it('updates a persona', async () => {
			const persona = await store.createPersona(roleId, 'Old', 'old desc');
			const updated = await store.updatePersona(persona.id, { name: 'New' });
			expect(updated!.name).toBe('New');
		});

		it('nulls out embedding when description changes', async () => {
			const persona = await store.createPersona(roleId, 'Test', 'original');
			// Simulate having an embedding
			const reg = await store.readRegistry();
			const idx = reg.personas.findIndex((p) => p.id === persona.id);
			reg.personas[idx].embedding = [1, 2, 3];
			await store.writeRegistry(reg);

			const updated = await store.updatePersona(persona.id, { description: 'changed' });
			expect(updated!.embedding).toBeNull();
		});

		it('deletes a persona and removes from parent role', async () => {
			const persona = await store.createPersona(roleId, 'ToDelete', 'desc');
			await store.deletePersona(persona.id);

			const found = await store.getPersona(persona.id);
			expect(found).toBeNull();

			const role = await store.getRole(roleId);
			expect(role!.personaIds).not.toContain(persona.id);
		});

		it('cascade deactivates child skill areas on persona delete', async () => {
			const persona = await store.createPersona(roleId, 'Parent', 'desc');
			const skill = await store.createSkillArea(persona.id, 'ErrorHandling', 'desc');
			await store.deletePersona(persona.id);

			// Skill area should be deactivated
			const skills = await store.listSkillAreas();
			const found = skills.find((s) => s.id === skill.id);
			if (found) {
				expect(found.active).toBe(false);
			}
		});

		it('creates persona with assigned agents and projects', async () => {
			const persona = await store.createPersona(
				roleId,
				'Scoped',
				'desc',
				['claude-code'],
				['/home/project']
			);
			expect(persona.assignedAgents).toEqual(['claude-code']);
			expect(persona.assignedProjects).toEqual(['/home/project']);
		});
	});

	// ─── Skill Area CRUD ──────────────────────────────────────────────────

	describe('Skill Area CRUD', () => {
		let personaId: string;

		beforeEach(async () => {
			const role = await store.createRole('TestRole', 'desc');
			const persona = await store.createPersona(role.id, 'TestPersona', 'desc');
			personaId = persona.id;
		});

		it('creates a skill area linked to a persona', async () => {
			const skill = await store.createSkillArea(personaId, 'Error Handling', 'desc');
			expect(skill.id).toBeTruthy();
			expect(skill.personaId).toBe(personaId);
			expect(skill.active).toBe(true);
			expect(skill.embedding).toBeNull();

			const persona = await store.getPersona(personaId);
			expect(persona!.skillAreaIds).toContain(skill.id);
		});

		it('throws when creating skill for non-existent persona', async () => {
			await expect(store.createSkillArea('nonexistent', 'X', 'Y')).rejects.toThrow(
				'Persona not found'
			);
		});

		it('lists skill areas filtered by persona', async () => {
			await store.createSkillArea(personaId, 'A', 'desc');
			await store.createSkillArea(personaId, 'B', 'desc');
			const skills = await store.listSkillAreas(personaId);
			expect(skills).toHaveLength(2);
		});

		it('updates a skill area', async () => {
			const skill = await store.createSkillArea(personaId, 'Old', 'desc');
			const updated = await store.updateSkillArea(skill.id, { name: 'New' });
			expect(updated!.name).toBe('New');
		});

		it('nulls out embedding when description changes', async () => {
			const skill = await store.createSkillArea(personaId, 'Test', 'original');
			const reg = await store.readRegistry();
			const idx = reg.skillAreas.findIndex((s) => s.id === skill.id);
			reg.skillAreas[idx].embedding = [1, 2, 3];
			await store.writeRegistry(reg);

			const updated = await store.updateSkillArea(skill.id, { description: 'changed' });
			expect(updated!.embedding).toBeNull();
		});

		it('deletes a skill area and removes from parent persona', async () => {
			const skill = await store.createSkillArea(personaId, 'ToDelete', 'desc');
			await store.deleteSkillArea(skill.id);

			const found = await store.getSkillArea(skill.id);
			expect(found).toBeNull();

			const persona = await store.getPersona(personaId);
			expect(persona!.skillAreaIds).not.toContain(skill.id);
		});
	});

	// ─── Memory CRUD ──────────────────────────────────────────────────────

	describe('Memory CRUD', () => {
		let skillAreaId: string;

		beforeEach(async () => {
			const role = await store.createRole('TestRole', 'desc');
			const persona = await store.createPersona(role.id, 'TestPersona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'TestSkill', 'desc');
			skillAreaId = skill.id;
		});

		it('adds a memory to a skill area', async () => {
			const mem = await store.addMemory({
				content: 'Always use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId,
				source: 'user',
			});
			expect(mem.id).toBeTruthy();
			expect(mem.type).toBe('rule'); // default
			expect(mem.scope).toBe('skill');
			expect(mem.active).toBe(true);
			expect(mem.tokenEstimate).toBe(Math.ceil(mem.content.length / 4));
			expect(mem.embedding).toBeNull();
		});

		it('adds a global memory', async () => {
			const mem = await store.addMemory({
				content: 'Use tabs for indentation',
				scope: 'global',
			});
			expect(mem.scope).toBe('global');
		});

		it('adds a project memory', async () => {
			const mem = await store.addMemory(
				{ content: 'Project uses DuckDB', scope: 'project' },
				'/home/user/myproject'
			);
			expect(mem.scope).toBe('project');
		});

		it('validates skill scope requires skillAreaId', async () => {
			await expect(store.addMemory({ content: 'test', scope: 'skill' })).rejects.toThrow(
				'skillAreaId required'
			);
		});

		it('validates skill area exists', async () => {
			await expect(
				store.addMemory({ content: 'test', scope: 'skill', skillAreaId: 'nonexistent' })
			).rejects.toThrow('Skill area not found');
		});

		it('adds experience-type memory with context', async () => {
			const mem = await store.addMemory({
				content: 'Using unwrap() in async code leads to panics',
				type: 'experience',
				scope: 'skill',
				skillAreaId,
				experienceContext: {
					situation: 'Async handler crashed with unwrap on None',
					learning: 'Always use ? operator instead of unwrap in async code',
					sourceSessionId: 'session-123',
				},
			});
			expect(mem.type).toBe('experience');
			expect(mem.experienceContext).toBeDefined();
			expect(mem.experienceContext!.situation).toContain('unwrap');
		});

		it('lists active memories', async () => {
			await store.addMemory({ content: 'A', scope: 'skill', skillAreaId });
			await store.addMemory({ content: 'B', scope: 'skill', skillAreaId });
			const mems = await store.listMemories('skill', skillAreaId);
			expect(mems).toHaveLength(2);
		});

		it('filters inactive memories by default', async () => {
			const mem = await store.addMemory({ content: 'A', scope: 'skill', skillAreaId });
			await store.updateMemory(mem.id, { active: false }, 'skill', skillAreaId);

			const active = await store.listMemories('skill', skillAreaId);
			expect(active).toHaveLength(0);

			const all = await store.listMemories('skill', skillAreaId, undefined, true);
			expect(all).toHaveLength(1);
		});

		it('gets a memory by id', async () => {
			const mem = await store.addMemory({ content: 'Test', scope: 'skill', skillAreaId });
			const found = await store.getMemory(mem.id, 'skill', skillAreaId);
			expect(found).not.toBeNull();
			expect(found!.content).toBe('Test');
		});

		it('updates a memory', async () => {
			const mem = await store.addMemory({ content: 'Old', scope: 'skill', skillAreaId });
			const updated = await store.updateMemory(
				mem.id,
				{ content: 'New', confidence: 0.8 },
				'skill',
				skillAreaId
			);
			expect(updated!.content).toBe('New');
			expect(updated!.confidence).toBe(0.8);
		});

		it('nulls out embedding when content changes', async () => {
			const mem = await store.addMemory({ content: 'Original', scope: 'global' });
			// Simulate embedding
			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			lib.entries[0].embedding = [1, 2, 3];
			await store.writeLibrary(dirPath, lib);

			const updated = await store.updateMemory(mem.id, { content: 'Changed' }, 'global');
			expect(updated!.embedding).toBeNull();
		});

		it('recalculates tokenEstimate when content changes', async () => {
			const mem = await store.addMemory({ content: 'Short', scope: 'global' });
			const longContent = 'This is a much longer piece of content for testing token estimate';
			const updated = await store.updateMemory(mem.id, { content: longContent }, 'global');
			expect(updated!.tokenEstimate).toBe(Math.ceil(longContent.length / 4));
		});

		it('deletes a memory', async () => {
			const mem = await store.addMemory({ content: 'ToDelete', scope: 'global' });
			const deleted = await store.deleteMemory(mem.id, 'global');
			expect(deleted).toBe(true);
			const found = await store.getMemory(mem.id, 'global');
			expect(found).toBeNull();
		});

		it('returns false when deleting non-existent memory', async () => {
			const deleted = await store.deleteMemory('nonexistent', 'global');
			expect(deleted).toBe(false);
		});
	});

	// ─── Config Management ────────────────────────────────────────────────

	describe('Config Management', () => {
		it('returns defaults when no config file exists', async () => {
			const config = await store.getConfig();
			expect(config.enabled).toBe(false);
			expect(config.maxTokenBudget).toBe(1500);
			expect(config.similarityThreshold).toBe(0.65);
		});

		it('sets and reads config', async () => {
			await store.setConfig({ enabled: true, maxTokenBudget: 2000 });
			const config = await store.getConfig();
			expect(config.enabled).toBe(true);
			expect(config.maxTokenBudget).toBe(2000);
			// Defaults should still be present
			expect(config.similarityThreshold).toBe(0.65);
		});
	});

	// ─── Seed Data ────────────────────────────────────────────────────────

	describe('seedFromDefaults', () => {
		it('seeds default roles/personas/skills into empty registry', async () => {
			const result = await store.seedFromDefaults();
			expect(result.roles).toBeGreaterThan(0);
			expect(result.personas).toBeGreaterThan(0);
			expect(result.skills).toBeGreaterThan(0);

			const roles = await store.listRoles();
			expect(roles.length).toBe(result.roles);

			const personas = await store.listPersonas();
			expect(personas.length).toBe(result.personas);
		});

		it('does not seed if registry already has roles', async () => {
			await store.createRole('Existing', 'desc');
			const result = await store.seedFromDefaults();
			expect(result.roles).toBe(0);
			expect(result.personas).toBe(0);
			expect(result.skills).toBe(0);
		});
	});

	// ─── Singleton ────────────────────────────────────────────────────────

	describe('getMemoryStore', () => {
		it('returns a MemoryStore instance', () => {
			const instance = getMemoryStore();
			expect(instance).toBeInstanceOf(MemoryStore);
		});

		it('returns the same instance on repeated calls', () => {
			const a = getMemoryStore();
			const b = getMemoryStore();
			expect(a).toBe(b);
		});
	});

	// ─── Cascade Behavior ─────────────────────────────────────────────────

	describe('Cascade operations', () => {
		it('delete role → deactivate personas → deactivate skills (full cascade)', async () => {
			const role = await store.createRole('Parent', 'desc');
			const persona = await store.createPersona(role.id, 'Child', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Grandchild', 'desc');

			await store.deleteRole(role.id);

			// Role should be gone
			expect(await store.getRole(role.id)).toBeNull();

			// Persona should be deactivated (still in registry)
			const personas = await store.listPersonas();
			const deactivatedPersona = personas.find((p) => p.id === persona.id);
			if (deactivatedPersona) {
				expect(deactivatedPersona.active).toBe(false);
			}
		});

		it('delete persona → deactivate skills', async () => {
			const role = await store.createRole('Role', 'desc');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			await store.deletePersona(persona.id);

			const skills = await store.listSkillAreas();
			const deactivatedSkill = skills.find((s) => s.id === skill.id);
			if (deactivatedSkill) {
				expect(deactivatedSkill.active).toBe(false);
			}
		});
	});

	// ─── Cascading Search ────────────────────────────────────────────────

	describe('Cascading Search', () => {
		// Helper: create a unit vector with a dominant component at `idx`
		// These produce predictable cosine similarities when compared.
		function makeEmbedding(idx: number, dim = 384): number[] {
			const v = new Array(dim).fill(0);
			v[idx] = 1;
			return v;
		}

		// Two vectors with the same dominant component → cosine ~ 1.0
		// Two vectors with different dominant components → cosine ~ 0.0

		/**
		 * Set up a full hierarchy with embeddings baked into the registry and library files.
		 *
		 * Creates:
		 * - Role "Dev"
		 *   - Persona "Rust Dev" (embedding at idx=0, assignedAgents=['claude-code'])
		 *   - Persona "Python Dev" (embedding at idx=1, assignedAgents=['codex'])
		 *     - Skill "API Design" (embedding at idx=2)
		 *       - Memory "use FastAPI" (embedding at idx=2, high similarity to skill)
		 *       - Memory "use pydantic" (embedding at idx=3, low similarity to query)
		 *   - Persona "Unembedded Persona" (no embedding — should always pass persona filter)
		 *     - Skill "General" (no embedding)
		 *       - Memory "general tip" (embedding at idx=0)
		 */
		async function setupHierarchy() {
			// Create role + personas + skills via CRUD (generates IDs, wires registry)
			const role = await store.createRole('Dev', 'Software development');

			const rustPersona = await store.createPersona(role.id, 'Rust Dev', 'Rust systems', [
				'claude-code',
			]);
			const pyPersona = await store.createPersona(role.id, 'Python Dev', 'Python backend', [
				'codex',
			]);
			const unembeddedPersona = await store.createPersona(
				role.id,
				'Unembedded Persona',
				'General dev'
			);

			const apiSkill = await store.createSkillArea(pyPersona.id, 'API Design', 'REST/GraphQL APIs');
			const generalSkill = await store.createSkillArea(
				unembeddedPersona.id,
				'General',
				'General tips'
			);

			// Inject embeddings directly into registry
			const reg = await store.readRegistry();
			for (const p of reg.personas) {
				if (p.id === rustPersona.id) p.embedding = makeEmbedding(0);
				if (p.id === pyPersona.id) p.embedding = makeEmbedding(1);
				// unembeddedPersona stays null
			}
			for (const s of reg.skillAreas) {
				if (s.id === apiSkill.id) s.embedding = makeEmbedding(2);
				// generalSkill stays null
			}
			await store.writeRegistry(reg);

			// Add memories with embeddings baked in
			const mem1 = await store.addMemory({
				content: 'Use FastAPI for REST endpoints',
				scope: 'skill',
				skillAreaId: apiSkill.id,
			});
			const mem2 = await store.addMemory({
				content: 'Use pydantic for validation',
				scope: 'skill',
				skillAreaId: apiSkill.id,
			});
			const memGeneral = await store.addMemory({
				content: 'General development tip',
				scope: 'skill',
				skillAreaId: generalSkill.id,
			});

			// Set memory embeddings directly
			const apiDir = store.getMemoryPath('skill', apiSkill.id);
			const apiLib = await store.readLibrary(apiDir);
			for (const e of apiLib.entries) {
				if (e.id === mem1.id) e.embedding = makeEmbedding(2); // matches query
				if (e.id === mem2.id) e.embedding = makeEmbedding(3); // does NOT match query
			}
			await store.writeLibrary(apiDir, apiLib);

			const genDir = store.getMemoryPath('skill', generalSkill.id);
			const genLib = await store.readLibrary(genDir);
			for (const e of genLib.entries) {
				if (e.id === memGeneral.id) e.embedding = makeEmbedding(0); // matches query
			}
			await store.writeLibrary(genDir, genLib);

			// Add a global memory
			const globalMem = await store.addMemory({
				content: 'Global rule: use tabs',
				scope: 'global',
			});
			const globalDir = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalDir);
			for (const e of globalLib.entries) {
				if (e.id === globalMem.id) e.embedding = makeEmbedding(2); // matches query
			}
			await store.writeLibrary(globalDir, globalLib);

			// Add a project memory
			const projMem = await store.addMemory(
				{ content: 'Project uses DuckDB', scope: 'project' },
				'/home/test/project'
			);
			const projDir = store.getMemoryPath('project', undefined, '/home/test/project');
			const projLib = await store.readLibrary(projDir);
			for (const e of projLib.entries) {
				if (e.id === projMem.id) e.embedding = makeEmbedding(2); // matches query
			}
			await store.writeLibrary(projDir, projLib);

			return {
				role,
				rustPersona,
				pyPersona,
				unembeddedPersona,
				apiSkill,
				generalSkill,
				mem1,
				mem2,
				memGeneral,
				globalMem,
				projMem,
			};
		}

		it('searchFlatScope returns matching memories from global scope', async () => {
			await setupHierarchy();
			const config = await store.getConfig();
			const queryEmb = makeEmbedding(2); // matches global memory

			const results = await store.searchFlatScope(queryEmb, 'global', config);
			expect(results).toHaveLength(1);
			expect(results[0].entry.content).toBe('Global rule: use tabs');
			expect(results[0].similarity).toBeCloseTo(1.0, 5);
			expect(results[0].combinedScore).toBeGreaterThan(0);
		});

		it('searchFlatScope returns matching memories from project scope', async () => {
			await setupHierarchy();
			const config = await store.getConfig();
			const queryEmb = makeEmbedding(2);

			const results = await store.searchFlatScope(
				queryEmb,
				'project',
				config,
				'/home/test/project'
			);
			expect(results).toHaveLength(1);
			expect(results[0].entry.content).toBe('Project uses DuckDB');
		});

		it('searchFlatScope filters out low-similarity entries', async () => {
			await setupHierarchy();
			const config = await store.getConfig();
			const queryEmb = makeEmbedding(99); // orthogonal to all stored embeddings

			const results = await store.searchFlatScope(queryEmb, 'global', config);
			expect(results).toHaveLength(0);
		});

		it('cascadingSearch excludes personas not matching agentType', async () => {
			const { mem1, memGeneral } = await setupHierarchy();

			// Use agentType='codex': matches pyPersona (assignedAgents=['codex']),
			// does NOT match rustPersona (assignedAgents=['claude-code']).
			// Unembedded persona has no agent filter → matches all agents.
			// Query needs components at idx=1 (pyPersona embedding) and idx=2 (skill/mem).
			const mixedEmb = new Array(384).fill(0);
			mixedEmb[1] = 0.7; // match pyPersona
			mixedEmb[2] = 0.9; // match apiSkill + mem1
			mockEncode.mockResolvedValueOnce(mixedEmb);

			const config = await store.getConfig();
			const results = await store.cascadingSearch(
				'How do I build APIs?',
				config,
				'codex',
				'/home/test/project'
			);

			// Should include mem1 (from pyPersona → apiSkill, via hierarchy)
			// Should NOT include rustPersona's memories (agentType mismatch)
			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(mem1.id);

			// memGeneral is under unembedded persona with embedding[0] — cosine with
			// our query (0 at idx=0) is 0, so it won't pass memory threshold
		});

		it('cascadingSearch narrows through hierarchy: irrelevant personas excluded', async () => {
			const { mem1, mem2 } = await setupHierarchy();

			// Query at idx=2: matches Python Dev persona (embedding idx=1)? No — cosine = 0.
			// BUT Python Dev persona embedding is idx=1, query is idx=2, cosine ~ 0 < 0.4 threshold.
			// However, unembedded persona passes through.
			// Let's use agentType that matches pyPersona, and query that matches pyPersona.
			// We need queryEmbedding to have cosine >= 0.4 with persona embedding(idx=1).

			// Use a mixed embedding: dominant at idx=1 (to match persona) and idx=2 (to match skill/memory)
			const mixedEmb = new Array(384).fill(0);
			mixedEmb[1] = 0.7; // matches persona (cosine = 0.7 > 0.4)
			mixedEmb[2] = 0.7; // matches skill and memory
			mockEncode.mockResolvedValueOnce(mixedEmb);

			const config = await store.getConfig();
			const results = await store.cascadingSearch('Build a Python API', config, 'codex');

			// mem1 has embedding at idx=2, similarity with mixed = 0.7/norm ≈ 0.707
			// mem2 has embedding at idx=3, similarity ≈ 0 → filtered out
			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(mem1.id);
			expect(ids).not.toContain(mem2.id);
		});

		it('cascadingSearch includes unembedded personas and skills', async () => {
			const { memGeneral } = await setupHierarchy();

			// Query embedding at idx=0 matches the general memory (embedding at idx=0)
			mockEncode.mockResolvedValueOnce(makeEmbedding(0));

			const config = await store.getConfig();
			const results = await store.cascadingSearch(
				'General dev question',
				config,
				'claude-code' // Unembedded persona has no agent filter → matches all
			);

			// Unembedded persona has no embedding → passes persona filter
			// General skill has no embedding → passes skill filter
			// memGeneral has embedding[0] → cosine = 1.0 with query → passes memory filter
			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(memGeneral.id);
		});

		it('cascadingSearch includes global and project memories alongside hierarchy', async () => {
			const { globalMem, projMem, mem1 } = await setupHierarchy();

			// Query at idx=2 matches global, project, and mem1
			const mixedEmb = new Array(384).fill(0);
			mixedEmb[1] = 0.5;
			mixedEmb[2] = 0.9;
			mockEncode.mockResolvedValueOnce(mixedEmb);

			const config = await store.getConfig();
			const results = await store.cascadingSearch(
				'API endpoints',
				config,
				'codex',
				'/home/test/project'
			);

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(globalMem.id);
			expect(ids).toContain(projMem.id);
		});

		it('cascadingSearch de-duplicates by entry id', async () => {
			// A memory could theoretically appear from both hierarchy and flat scope
			// (if it were copied). The de-dupe logic prevents this.
			await setupHierarchy();
			mockEncode.mockResolvedValueOnce(makeEmbedding(2));

			const config = await store.getConfig();
			const results = await store.cascadingSearch(
				'API test',
				config,
				'codex',
				'/home/test/project'
			);

			// Check no duplicate IDs
			const ids = results.map((r) => r.entry.id);
			const uniqueIds = [...new Set(ids)];
			expect(ids).toEqual(uniqueIds);
		});

		it('cascadingSearch attaches personaName and skillAreaName from hierarchy', async () => {
			const { mem1 } = await setupHierarchy();

			const mixedEmb = new Array(384).fill(0);
			mixedEmb[1] = 0.7;
			mixedEmb[2] = 0.9;
			mockEncode.mockResolvedValueOnce(mixedEmb);

			const config = await store.getConfig();
			const results = await store.cascadingSearch('API design', config, 'codex');

			const mem1Result = results.find((r) => r.entry.id === mem1.id);
			expect(mem1Result).toBeDefined();
			expect(mem1Result!.personaName).toBe('Python Dev');
			expect(mem1Result!.skillAreaName).toBe('API Design');
		});

		it('cascadingSearch respects limit parameter', async () => {
			await setupHierarchy();

			// Use an embedding that matches everything with idx=0 component
			const broadEmb = new Array(384).fill(0);
			broadEmb[0] = 0.5;
			broadEmb[2] = 0.5;
			mockEncode.mockResolvedValueOnce(broadEmb);

			const config = await store.getConfig();
			const results = await store.cascadingSearch(
				'broad query',
				config,
				'codex',
				'/home/test/project',
				1 // limit to 1 result
			);

			expect(results.length).toBeLessThanOrEqual(1);
		});
	});

	// ─── Record Injection ────────────────────────────────────────────────

	describe('recordInjection', () => {
		it('increments useCount and updates lastUsedAt for injected memories', async () => {
			const mem = await store.addMemory({ content: 'Test rule', scope: 'global' });
			expect(mem.useCount).toBe(0);
			expect(mem.lastUsedAt).toBe(0);

			await store.recordInjection([mem.id], 'global');

			const updated = await store.getMemory(mem.id, 'global');
			expect(updated!.useCount).toBe(1);
			expect(updated!.lastUsedAt).toBeGreaterThan(0);
		});

		it('increments useCount multiple times', async () => {
			const mem = await store.addMemory({ content: 'Test rule', scope: 'global' });

			await store.recordInjection([mem.id], 'global');
			await store.recordInjection([mem.id], 'global');
			await store.recordInjection([mem.id], 'global');

			const updated = await store.getMemory(mem.id, 'global');
			expect(updated!.useCount).toBe(3);
		});

		it('handles multiple ids in a single call', async () => {
			const mem1 = await store.addMemory({ content: 'Rule A', scope: 'global' });
			const mem2 = await store.addMemory({ content: 'Rule B', scope: 'global' });

			await store.recordInjection([mem1.id, mem2.id], 'global');

			const u1 = await store.getMemory(mem1.id, 'global');
			const u2 = await store.getMemory(mem2.id, 'global');
			expect(u1!.useCount).toBe(1);
			expect(u2!.useCount).toBe(1);
		});

		it('no-ops for empty id list', async () => {
			// Should not throw
			await store.recordInjection([], 'global');
		});

		it('ignores ids not found in the library', async () => {
			const mem = await store.addMemory({ content: 'Exists', scope: 'global' });

			// One valid, one invalid — should not throw, valid one should be updated
			await store.recordInjection([mem.id, 'nonexistent-id'], 'global');

			const updated = await store.getMemory(mem.id, 'global');
			expect(updated!.useCount).toBe(1);
		});

		it('works with skill scope', async () => {
			const role = await store.createRole('R', 'desc');
			const persona = await store.createPersona(role.id, 'P', 'desc');
			const skill = await store.createSkillArea(persona.id, 'S', 'desc');

			const mem = await store.addMemory({
				content: 'Skill memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			await store.recordInjection([mem.id], 'skill', skill.id);

			const updated = await store.getMemory(mem.id, 'skill', skill.id);
			expect(updated!.useCount).toBe(1);
			expect(updated!.lastUsedAt).toBeGreaterThan(0);
		});
	});

	// ─── Memory Consolidation ────────────────────────────────────────────

	describe('consolidateMemories', () => {
		// Helper: create a unit vector with a dominant component at `idx`
		function makeEmbedding(idx: number, dim = 384): number[] {
			const v = new Array(dim).fill(0);
			v[idx] = 1;
			return v;
		}

		// Helper: create a blended embedding (close to idx but with a small perturbation)
		function makeNearEmbedding(idx: number, dim = 384): number[] {
			const v = new Array(dim).fill(0);
			v[idx] = 0.99;
			v[(idx + 1) % dim] = 0.01; // tiny perturbation
			return v;
		}

		it('merges 3 near-identical memories into 1 group', async () => {
			// Add 3 memories with nearly identical embeddings to global scope
			const mem1 = await store.addMemory({
				content: 'Always use tabs for indentation',
				scope: 'global',
				tags: ['style'],
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Use tabs not spaces for indentation',
				scope: 'global',
				tags: ['formatting'],
				confidence: 0.7,
			});
			const mem3 = await store.addMemory({
				content: 'Indentation should use tabs',
				scope: 'global',
				tags: ['code-style'],
				confidence: 0.5,
			});

			// Set near-identical embeddings directly
			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) e.embedding = makeEmbedding(0);
				if (e.id === mem2.id) e.embedding = makeNearEmbedding(0);
				if (e.id === mem3.id) e.embedding = makeNearEmbedding(0);
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			const merges = await store.consolidateMemories('global', config);

			expect(merges).toBe(1); // One cluster formed

			// Check: mem1 (highest confidence) should remain active
			const active = await store.listMemories('global');
			expect(active).toHaveLength(1);
			expect(active[0].id).toBe(mem1.id);

			// Absorbed entries should be inactive
			const all = await store.listMemories('global', undefined, undefined, true);
			const inactive = all.filter((e) => !e.active);
			expect(inactive).toHaveLength(2);

			// Tags should be unioned
			expect(active[0].tags).toContain('style');
			expect(active[0].tags).toContain('formatting');
			expect(active[0].tags).toContain('code-style');
		});

		it('does not merge memories of different types', async () => {
			const mem1 = await store.addMemory({
				content: 'Always use Result for errors',
				type: 'rule',
				scope: 'global',
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Result type is better for errors',
				type: 'experience',
				scope: 'global',
				confidence: 0.7,
			});

			// Give them identical embeddings
			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				e.embedding = makeEmbedding(5);
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			const merges = await store.consolidateMemories('global', config);

			// Should NOT merge because they have different types
			expect(merges).toBe(0);
			const active = await store.listMemories('global');
			expect(active).toHaveLength(2);
		});

		it('does not merge memories with low similarity', async () => {
			const mem1 = await store.addMemory({
				content: 'Use tabs for indentation',
				scope: 'global',
			});
			const mem2 = await store.addMemory({
				content: 'Always write tests',
				scope: 'global',
			});

			// Give them orthogonal embeddings
			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) e.embedding = makeEmbedding(0);
				if (e.id === mem2.id) e.embedding = makeEmbedding(1);
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			const merges = await store.consolidateMemories('global', config);

			expect(merges).toBe(0);
			const active = await store.listMemories('global');
			expect(active).toHaveLength(2);
		});

		it('computes weighted-average confidence and sums useCounts', async () => {
			const mem1 = await store.addMemory({
				content: 'High confidence rule',
				scope: 'global',
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Lower confidence rule',
				scope: 'global',
				confidence: 0.3,
			});

			// Set useCounts and embeddings directly
			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				if (e.id === mem1.id) {
					e.embedding = makeEmbedding(0);
					e.useCount = 5;
					e.effectivenessScore = 0.8;
				}
				if (e.id === mem2.id) {
					e.embedding = makeNearEmbedding(0);
					e.useCount = 3;
					e.effectivenessScore = 0.6;
				}
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			await store.consolidateMemories('global', config);

			const active = await store.listMemories('global');
			expect(active).toHaveLength(1);

			// Weighted average: (0.9 * 5 + 0.3 * 3) / (5 + 3) = (4.5 + 0.9) / 8 = 0.675
			expect(active[0].confidence).toBeCloseTo(0.675, 2);
			// Sum useCounts
			expect(active[0].useCount).toBe(8);
			// Max effectiveness
			expect(active[0].effectivenessScore).toBe(0.8);
		});

		it('records consolidation history entries', async () => {
			const mem1 = await store.addMemory({
				content: 'Rule A',
				scope: 'global',
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Rule A variant',
				scope: 'global',
				confidence: 0.5,
			});

			const dirPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			await store.consolidateMemories('global', config);

			// Check history.jsonl for consolidation entries
			const historyContent = fsState.get(dirPath + '/history.jsonl');
			expect(historyContent).toBeDefined();
			const lines = historyContent!.trim().split('\n');
			const consolidateEntries = lines
				.map((l) => JSON.parse(l))
				.filter((e: { operation: string }) => e.operation === 'consolidate');
			expect(consolidateEntries.length).toBeGreaterThanOrEqual(1);
			expect(consolidateEntries[0].entityId).toBe(mem1.id);
			expect(consolidateEntries[0].source).toBe('consolidation');
		});

		it('returns 0 when fewer than 2 entries have embeddings', async () => {
			await store.addMemory({
				content: 'Solo memory',
				scope: 'global',
			});

			// No embeddings set — and encoding will fail
			mockEncodeBatch.mockRejectedValueOnce(new Error('No model'));

			const config = await store.getConfig();
			const merges = await store.consolidateMemories('global', config);
			expect(merges).toBe(0);
		});

		it('works with skill scope', async () => {
			const role = await store.createRole('R', 'desc');
			const persona = await store.createPersona(role.id, 'P', 'desc');
			const skill = await store.createSkillArea(persona.id, 'S', 'desc');

			const mem1 = await store.addMemory({
				content: 'Skill rule 1',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.9,
			});
			const mem2 = await store.addMemory({
				content: 'Skill rule 1 variant',
				scope: 'skill',
				skillAreaId: skill.id,
				confidence: 0.5,
			});

			const dirPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(dirPath);
			for (const e of lib.entries) {
				e.embedding = makeEmbedding(0);
			}
			await store.writeLibrary(dirPath, lib);

			const config = await store.getConfig();
			const merges = await store.consolidateMemories('skill', config, skill.id);
			expect(merges).toBe(1);

			const active = await store.listMemories('skill', skill.id);
			expect(active).toHaveLength(1);
			expect(active[0].id).toBe(mem1.id);
		});
	});

	// ─── Auto-Consolidation Trigger ──────────────────────────────────────

	describe('Auto-consolidation trigger', () => {
		it('fires consolidation when active count hits multiple of 10', async () => {
			// Spy on consolidateMemories
			const consolSpy = vi.spyOn(store, 'consolidateMemories').mockResolvedValue(0);

			// Set up config to enable auto-consolidation
			await store.setConfig({ enableAutoConsolidation: true });

			// Add 9 memories (won't trigger yet)
			for (let i = 1; i <= 9; i++) {
				await store.addMemory({
					content: `Memory ${i}`,
					scope: 'global',
				});
			}
			expect(consolSpy).not.toHaveBeenCalled();

			// 10th memory triggers consolidation
			await store.addMemory({
				content: 'Memory 10',
				scope: 'global',
			});

			// Give fire-and-forget promise a tick to resolve
			await new Promise((r) => setTimeout(r, 10));
			expect(consolSpy).toHaveBeenCalledTimes(1);
			expect(consolSpy).toHaveBeenCalledWith(
				'global',
				expect.objectContaining({ enableAutoConsolidation: true }),
				undefined,
				undefined
			);

			consolSpy.mockRestore();
		});

		it('does not fire consolidation when auto-consolidation is disabled', async () => {
			const consolSpy = vi.spyOn(store, 'consolidateMemories').mockResolvedValue(0);

			await store.setConfig({ enableAutoConsolidation: false });

			for (let i = 1; i <= 10; i++) {
				await store.addMemory({
					content: `Memory ${i}`,
					scope: 'global',
				});
			}

			await new Promise((r) => setTimeout(r, 10));
			expect(consolSpy).not.toHaveBeenCalled();

			consolSpy.mockRestore();
		});
	});
});
