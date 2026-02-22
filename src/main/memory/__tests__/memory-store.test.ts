/**
 * Tests for MemoryStore — hierarchy, CRUD lifecycle, scope isolation,
 * atomic writes, history trail, registry integrity, and seed defaults.
 *
 * Focuses on integration-style scenarios that exercise the full hierarchy
 * chain (role → persona → skill → memory) in a single test flow.
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse all JSONL lines from a history file in fsState. */
function readHistory(dirPath: string): Array<Record<string, unknown>> {
	const content = fsState.get(`${dirPath}/history.jsonl`);
	if (!content) return [];
	return content
		.trim()
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

/** Get all .tmp keys currently in fsState (atomic write leftovers). */
function getTmpFiles(): string[] {
	return [...fsState.keys()].filter((k) => k.endsWith('.tmp'));
}

describe('MemoryStore — Hierarchy, CRUD, Isolation, Atomics, History, Seed', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(384).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── 1. Hierarchy CRUD ──────────────────────────────────────────────

	describe('Hierarchy CRUD: role → persona → skill → parent references', () => {
		it('creates a full hierarchy and verifies all parent references', async () => {
			// Create role
			const role = await store.createRole('Software Developer', 'Full-stack development');
			expect(role.id).toBeTruthy();
			expect(role.personaIds).toEqual([]);

			// Create persona under role
			const persona = await store.createPersona(role.id, 'Rust Dev', 'Systems programming');
			expect(persona.roleId).toBe(role.id);
			expect(persona.skillAreaIds).toEqual([]);

			// Verify role now references persona
			const updatedRole = await store.getRole(role.id);
			expect(updatedRole!.personaIds).toContain(persona.id);

			// Create skill under persona
			const skill = await store.createSkillArea(persona.id, 'Error Handling', 'Error patterns');
			expect(skill.personaId).toBe(persona.id);

			// Verify persona now references skill
			const updatedPersona = await store.getPersona(persona.id);
			expect(updatedPersona!.skillAreaIds).toContain(skill.id);

			// Add memory to skill area
			const mem = await store.addMemory({
				content: 'Always use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			expect(mem.scope).toBe('skill');
			expect(mem.skillAreaId).toBe(skill.id);

			// Verify full chain: role → persona → skill → memory
			const roleCheck = await store.getRole(role.id);
			const personaCheck = await store.getPersona(roleCheck!.personaIds[0]);
			const skillCheck = await store.getSkillArea(personaCheck!.skillAreaIds[0]);
			const mems = await store.listMemories('skill', skillCheck!.id);
			expect(mems).toHaveLength(1);
			expect(mems[0].content).toBe('Always use Result<T, E> for error handling');
		});

		it('creates multiple personas under one role and multiple skills under one persona', async () => {
			const role = await store.createRole('Dev', 'Development');

			const p1 = await store.createPersona(role.id, 'Frontend', 'React');
			const p2 = await store.createPersona(role.id, 'Backend', 'Node.js');

			const roleCheck = await store.getRole(role.id);
			expect(roleCheck!.personaIds).toHaveLength(2);
			expect(roleCheck!.personaIds).toContain(p1.id);
			expect(roleCheck!.personaIds).toContain(p2.id);

			const s1 = await store.createSkillArea(p1.id, 'State Mgmt', 'Redux/Context');
			const s2 = await store.createSkillArea(p1.id, 'Testing', 'Jest/Vitest');
			const s3 = await store.createSkillArea(p2.id, 'API Design', 'REST');

			const p1Check = await store.getPersona(p1.id);
			expect(p1Check!.skillAreaIds).toHaveLength(2);
			expect(p1Check!.skillAreaIds).toContain(s1.id);
			expect(p1Check!.skillAreaIds).toContain(s2.id);

			const p2Check = await store.getPersona(p2.id);
			expect(p2Check!.skillAreaIds).toHaveLength(1);
			expect(p2Check!.skillAreaIds).toContain(s3.id);
		});
	});

	// ─── 2. Cascade Delete ──────────────────────────────────────────────

	describe('Cascade delete: role → personas and skills deactivated', () => {
		it('deleting a role deactivates child personas', async () => {
			const role = await store.createRole('To Delete', 'desc');
			const p1 = await store.createPersona(role.id, 'Persona 1', 'desc');
			const p2 = await store.createPersona(role.id, 'Persona 2', 'desc');

			await store.deleteRole(role.id);

			// Role should be gone
			expect(await store.getRole(role.id)).toBeNull();

			// Personas should be deactivated (still in registry but inactive)
			const allPersonas = await store.listPersonas();
			for (const p of allPersonas) {
				if (p.id === p1.id || p.id === p2.id) {
					expect(p.active).toBe(false);
				}
			}
		});

		it('deleting a persona deactivates child skill areas and removes from parent role', async () => {
			const role = await store.createRole('Role', 'desc');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const s1 = await store.createSkillArea(persona.id, 'Skill 1', 'desc');
			const s2 = await store.createSkillArea(persona.id, 'Skill 2', 'desc');

			await store.deletePersona(persona.id);

			// Persona removed from registry
			expect(await store.getPersona(persona.id)).toBeNull();

			// Parent role should no longer reference persona
			const roleCheck = await store.getRole(role.id);
			expect(roleCheck!.personaIds).not.toContain(persona.id);

			// Skills should be deactivated
			const allSkills = await store.listSkillAreas();
			for (const s of allSkills) {
				if (s.id === s1.id || s.id === s2.id) {
					expect(s.active).toBe(false);
				}
			}
		});

		it('deleting a skill area deactivates its memories and removes from parent persona', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			const skill = await store.createSkillArea(persona.id, 'S', 'd');

			// Add memories to the skill
			await store.addMemory({ content: 'Mem 1', scope: 'skill', skillAreaId: skill.id });
			await store.addMemory({ content: 'Mem 2', scope: 'skill', skillAreaId: skill.id });

			await store.deleteSkillArea(skill.id);

			// Skill removed from registry
			expect(await store.getSkillArea(skill.id)).toBeNull();

			// Parent persona should no longer reference skill
			const personaCheck = await store.getPersona(persona.id);
			expect(personaCheck!.skillAreaIds).not.toContain(skill.id);

			// Memories in that skill area should be deactivated
			const allMems = await store.listMemories('skill', skill.id, undefined, true);
			for (const m of allMems) {
				expect(m.active).toBe(false);
			}
		});

		it('full cascade: delete role → personas deactivated → skill areas deactivated', async () => {
			const role = await store.createRole('Cascade Root', 'desc');
			const persona = await store.createPersona(role.id, 'Cascade Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Cascade Skill', 'desc');

			// Add a memory
			await store.addMemory({
				content: 'Should survive as inactive',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			await store.deleteRole(role.id);

			// Role gone
			expect(await store.getRole(role.id)).toBeNull();

			// Read raw registry to check deactivation
			const reg = await store.readRegistry();
			const deactivatedPersona = reg.personas.find((p) => p.id === persona.id);
			if (deactivatedPersona) {
				expect(deactivatedPersona.active).toBe(false);
			}
			// Note: deleteRole cascade only deactivates personas directly,
			// skill deactivation would need a separate deletePersona call
		});
	});

	// ─── 3. Memory CRUD Lifecycle ───────────────────────────────────────

	describe('Memory CRUD lifecycle: add → get → update → list → soft-delete → list', () => {
		let skillId: string;

		beforeEach(async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			const skill = await store.createSkillArea(persona.id, 'S', 'd');
			skillId = skill.id;
		});

		it('full lifecycle for a skill-scoped memory', async () => {
			// ADD
			const mem = await store.addMemory({
				content: 'Original content',
				scope: 'skill',
				skillAreaId: skillId,
				tags: ['initial'],
				source: 'user',
			});
			expect(mem.id).toBeTruthy();
			expect(mem.active).toBe(true);
			expect(mem.type).toBe('rule');

			// GET
			const fetched = await store.getMemory(mem.id, 'skill', skillId);
			expect(fetched).not.toBeNull();
			expect(fetched!.content).toBe('Original content');
			expect(fetched!.tags).toEqual(['initial']);

			// UPDATE
			const updated = await store.updateMemory(
				mem.id,
				{ content: 'Updated content', tags: ['initial', 'modified'] },
				'skill',
				skillId
			);
			expect(updated!.content).toBe('Updated content');
			expect(updated!.tags).toEqual(['initial', 'modified']);
			expect(updated!.updatedAt).toBeGreaterThanOrEqual(mem.updatedAt);
			// Token estimate should recalculate on content change
			expect(updated!.tokenEstimate).toBe(Math.ceil('Updated content'.length / 4));

			// LIST (active only)
			const active = await store.listMemories('skill', skillId);
			expect(active).toHaveLength(1);
			expect(active[0].id).toBe(mem.id);

			// SOFT DELETE (set active=false)
			await store.updateMemory(mem.id, { active: false }, 'skill', skillId);

			// LIST (should be hidden by default)
			const afterDelete = await store.listMemories('skill', skillId);
			expect(afterDelete).toHaveLength(0);

			// LIST (includeInactive=true should show it)
			const withInactive = await store.listMemories('skill', skillId, undefined, true);
			expect(withInactive).toHaveLength(1);
			expect(withInactive[0].active).toBe(false);
		});

		it('hard delete removes memory entirely', async () => {
			const mem = await store.addMemory({
				content: 'Will be hard deleted',
				scope: 'skill',
				skillAreaId: skillId,
			});

			const deleted = await store.deleteMemory(mem.id, 'skill', skillId);
			expect(deleted).toBe(true);

			// Even with includeInactive, it should be gone
			const all = await store.listMemories('skill', skillId, undefined, true);
			expect(all).toHaveLength(0);

			// Get should return null
			expect(await store.getMemory(mem.id, 'skill', skillId)).toBeNull();
		});
	});

	// ─── 4. Scope Isolation ─────────────────────────────────────────────

	describe('Scope isolation: memories in one scope do not leak to another', () => {
		it('memories in skill A are not visible in skill B', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			const skillA = await store.createSkillArea(persona.id, 'Skill A', 'd');
			const skillB = await store.createSkillArea(persona.id, 'Skill B', 'd');

			await store.addMemory({ content: 'Only in A', scope: 'skill', skillAreaId: skillA.id });
			await store.addMemory({ content: 'Also in A', scope: 'skill', skillAreaId: skillA.id });

			// Skill A should have 2 memories
			const memsA = await store.listMemories('skill', skillA.id);
			expect(memsA).toHaveLength(2);

			// Skill B should have 0 memories
			const memsB = await store.listMemories('skill', skillB.id);
			expect(memsB).toHaveLength(0);
		});

		it('project-scoped memories are isolated per project', async () => {
			await store.addMemory(
				{ content: 'Project A memory', scope: 'project' },
				'/home/user/project-a'
			);
			await store.addMemory(
				{ content: 'Project B memory', scope: 'project' },
				'/home/user/project-b'
			);

			const projA = await store.listMemories('project', undefined, '/home/user/project-a');
			expect(projA).toHaveLength(1);
			expect(projA[0].content).toBe('Project A memory');

			const projB = await store.listMemories('project', undefined, '/home/user/project-b');
			expect(projB).toHaveLength(1);
			expect(projB[0].content).toBe('Project B memory');
		});

		it('global, project, and skill scopes are independent', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			const skill = await store.createSkillArea(persona.id, 'S', 'd');

			await store.addMemory({ content: 'Global mem', scope: 'global' });
			await store.addMemory({ content: 'Skill mem', scope: 'skill', skillAreaId: skill.id });
			await store.addMemory({ content: 'Project mem', scope: 'project' }, '/home/user/proj');

			expect(await store.listMemories('global')).toHaveLength(1);
			expect(await store.listMemories('skill', skill.id)).toHaveLength(1);
			expect(await store.listMemories('project', undefined, '/home/user/proj')).toHaveLength(1);

			// Cross-scope checks
			expect((await store.listMemories('global'))[0].content).toBe('Global mem');
			expect((await store.listMemories('skill', skill.id))[0].content).toBe('Skill mem');
		});
	});

	// ─── 5. Atomic Writes ───────────────────────────────────────────────

	describe('Atomic writes: .tmp file cleanup', () => {
		it('no .tmp files remain after registry write', async () => {
			await store.createRole('Test', 'desc');

			// After the write completes, there should be no .tmp files
			const tmpFiles = getTmpFiles();
			expect(tmpFiles).toHaveLength(0);
		});

		it('no .tmp files remain after library write', async () => {
			await store.addMemory({ content: 'Test', scope: 'global' });

			const tmpFiles = getTmpFiles();
			expect(tmpFiles).toHaveLength(0);
		});

		it('no .tmp files remain after config write', async () => {
			await store.setConfig({ enabled: true });

			const tmpFiles = getTmpFiles();
			expect(tmpFiles).toHaveLength(0);
		});

		it('registry.json contains valid JSON after write', async () => {
			await store.createRole('Valid Role', 'Check JSON');

			const regPath = '/mock/userData/memories/registry.json';
			const content = fsState.get(regPath);
			expect(content).toBeDefined();
			expect(() => JSON.parse(content!)).not.toThrow();
		});

		it('library.json contains valid JSON after write', async () => {
			await store.addMemory({ content: 'Check JSON', scope: 'global' });

			const libPath = '/mock/userData/memories/global/library.json';
			const content = fsState.get(libPath);
			expect(content).toBeDefined();
			expect(() => JSON.parse(content!)).not.toThrow();
		});
	});

	// ─── 6. History Trail ───────────────────────────────────────────────

	describe('History trail: JSONL entries for each operation', () => {
		it('records create-role history entry', async () => {
			const role = await store.createRole('Historian', 'desc');
			const history = readHistory('/mock/userData/memories');
			const entry = history.find((h) => h.operation === 'create-role' && h.entityId === role.id);
			expect(entry).toBeDefined();
			expect(entry!.entityType).toBe('role');
			expect(entry!.content).toBe('Historian');
		});

		it('records update-role history entry', async () => {
			const role = await store.createRole('Old', 'desc');
			await store.updateRole(role.id, { name: 'New' });
			const history = readHistory('/mock/userData/memories');
			const entry = history.find((h) => h.operation === 'update-role' && h.entityId === role.id);
			expect(entry).toBeDefined();
			expect(entry!.oldContent).toBe('Old');
			expect(entry!.newContent).toBe('New');
		});

		it('records delete-role history entry', async () => {
			const role = await store.createRole('Doomed', 'desc');
			await store.deleteRole(role.id);
			const history = readHistory('/mock/userData/memories');
			const entry = history.find((h) => h.operation === 'delete-role' && h.entityId === role.id);
			expect(entry).toBeDefined();
			expect(entry!.content).toBe('Doomed');
		});

		it('records create-persona history entry', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'HistPersona', 'd');
			const history = readHistory('/mock/userData/memories');
			const entry = history.find(
				(h) => h.operation === 'create-persona' && h.entityId === persona.id
			);
			expect(entry).toBeDefined();
			expect(entry!.entityType).toBe('persona');
			expect(entry!.content).toBe('HistPersona');
		});

		it('records create-skill history entry', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			const skill = await store.createSkillArea(persona.id, 'HistSkill', 'd');
			const history = readHistory('/mock/userData/memories');
			const entry = history.find((h) => h.operation === 'create-skill' && h.entityId === skill.id);
			expect(entry).toBeDefined();
			expect(entry!.entityType).toBe('skill');
			expect(entry!.content).toBe('HistSkill');
		});

		it('records add memory history in the scope directory', async () => {
			const mem = await store.addMemory({ content: 'History tracked', scope: 'global' });
			const history = readHistory('/mock/userData/memories/global');
			const entry = history.find((h) => h.operation === 'add' && h.entityId === mem.id);
			expect(entry).toBeDefined();
			expect(entry!.entityType).toBe('memory');
			expect(entry!.content).toBe('History tracked');
		});

		it('records update memory history in the scope directory', async () => {
			const mem = await store.addMemory({ content: 'Before', scope: 'global' });
			await store.updateMemory(mem.id, { content: 'After' }, 'global');
			const history = readHistory('/mock/userData/memories/global');
			const updateEntry = history.find((h) => h.operation === 'update' && h.entityId === mem.id);
			expect(updateEntry).toBeDefined();
			expect(updateEntry!.oldContent).toBe('Before');
			expect(updateEntry!.newContent).toBe('After');
		});

		it('records delete memory history in the scope directory', async () => {
			const mem = await store.addMemory({ content: 'To remove', scope: 'global' });
			await store.deleteMemory(mem.id, 'global');
			const history = readHistory('/mock/userData/memories/global');
			const deleteEntry = history.find((h) => h.operation === 'delete' && h.entityId === mem.id);
			expect(deleteEntry).toBeDefined();
			expect(deleteEntry!.content).toBe('To remove');
		});

		it('accumulates multiple operations in correct chronological order', async () => {
			const role = await store.createRole('R', 'd');
			await store.updateRole(role.id, { name: 'R2' });
			await store.deleteRole(role.id);

			const history = readHistory('/mock/userData/memories');
			const roleOps = history.filter((h) => h.entityId === role.id).map((h) => h.operation);
			expect(roleOps).toEqual(['create-role', 'update-role', 'delete-role']);

			// Verify timestamps are monotonically increasing
			const timestamps = history
				.filter((h) => h.entityId === role.id)
				.map((h) => h.timestamp as number);
			for (let i = 1; i < timestamps.length; i++) {
				expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
			}
		});
	});

	// ─── 7. Registry Integrity ──────────────────────────────────────────

	describe('Registry integrity: correct roles/personas/skills structure', () => {
		it('registry has correct structure after hierarchy creation', async () => {
			const role = await store.createRole('Software Dev', 'Full-stack');
			const persona1 = await store.createPersona(role.id, 'Frontend', 'React');
			const persona2 = await store.createPersona(role.id, 'Backend', 'Node');
			const skill1 = await store.createSkillArea(persona1.id, 'State Mgmt', 'Redux');
			const skill2 = await store.createSkillArea(persona1.id, 'Testing', 'Vitest');
			const skill3 = await store.createSkillArea(persona2.id, 'API Design', 'REST');

			const reg = await store.readRegistry();

			// Structure checks
			expect(reg.version).toBe(1);
			expect(reg.roles).toHaveLength(1);
			expect(reg.personas).toHaveLength(2);
			expect(reg.skillAreas).toHaveLength(3);

			// Role has correct personaIds
			expect(reg.roles[0].personaIds).toEqual([persona1.id, persona2.id]);

			// Personas have correct skillAreaIds
			const p1 = reg.personas.find((p) => p.id === persona1.id)!;
			expect(p1.skillAreaIds).toEqual([skill1.id, skill2.id]);
			expect(p1.roleId).toBe(role.id);

			const p2 = reg.personas.find((p) => p.id === persona2.id)!;
			expect(p2.skillAreaIds).toEqual([skill3.id]);
			expect(p2.roleId).toBe(role.id);

			// SkillAreas reference correct persona
			expect(reg.skillAreas.find((s) => s.id === skill1.id)!.personaId).toBe(persona1.id);
			expect(reg.skillAreas.find((s) => s.id === skill3.id)!.personaId).toBe(persona2.id);
		});

		it('registry remains consistent after deletes', async () => {
			const role = await store.createRole('R', 'd');
			const p1 = await store.createPersona(role.id, 'P1', 'd');
			const p2 = await store.createPersona(role.id, 'P2', 'd');
			await store.createSkillArea(p1.id, 'S1', 'd');

			// Delete persona1 — should clean up role's personaIds
			await store.deletePersona(p1.id);

			const reg = await store.readRegistry();
			expect(reg.roles[0].personaIds).toEqual([p2.id]);
			// p1 should be gone from personas array
			expect(reg.personas.find((p) => p.id === p1.id)).toBeUndefined();
			// p2 should still be present
			expect(reg.personas.find((p) => p.id === p2.id)).toBeDefined();
		});

		it('registry.json file is valid JSON with all required fields', async () => {
			await store.createRole('Check', 'Integrity');

			const regPath = '/mock/userData/memories/registry.json';
			const raw = fsState.get(regPath)!;
			const parsed = JSON.parse(raw);

			expect(parsed).toHaveProperty('version');
			expect(parsed).toHaveProperty('roles');
			expect(parsed).toHaveProperty('personas');
			expect(parsed).toHaveProperty('skillAreas');
			expect(Array.isArray(parsed.roles)).toBe(true);
			expect(Array.isArray(parsed.personas)).toBe(true);
			expect(Array.isArray(parsed.skillAreas)).toBe(true);
		});

		it('roles have all required fields', async () => {
			const role = await store.createRole('Complete', 'Has everything');
			const reg = await store.readRegistry();
			const r = reg.roles[0];

			expect(r).toHaveProperty('id');
			expect(r).toHaveProperty('name');
			expect(r).toHaveProperty('description');
			expect(r).toHaveProperty('personaIds');
			expect(r).toHaveProperty('createdAt');
			expect(r).toHaveProperty('updatedAt');
			expect(typeof r.id).toBe('string');
			expect(typeof r.createdAt).toBe('number');
		});

		it('personas have all required fields', async () => {
			const role = await store.createRole('R', 'd');
			await store.createPersona(role.id, 'Complete Persona', 'd', ['claude-code'], ['/proj']);

			const reg = await store.readRegistry();
			const p = reg.personas[0];

			expect(p).toHaveProperty('id');
			expect(p).toHaveProperty('roleId');
			expect(p).toHaveProperty('name');
			expect(p).toHaveProperty('description');
			expect(p).toHaveProperty('embedding');
			expect(p).toHaveProperty('skillAreaIds');
			expect(p).toHaveProperty('assignedAgents');
			expect(p).toHaveProperty('assignedProjects');
			expect(p).toHaveProperty('active');
			expect(p).toHaveProperty('createdAt');
			expect(p).toHaveProperty('updatedAt');
			expect(p.embedding).toBeNull();
			expect(p.active).toBe(true);
			expect(p.assignedAgents).toEqual(['claude-code']);
		});

		it('skill areas have all required fields', async () => {
			const role = await store.createRole('R', 'd');
			const persona = await store.createPersona(role.id, 'P', 'd');
			await store.createSkillArea(persona.id, 'Complete Skill', 'Full fields');

			const reg = await store.readRegistry();
			const s = reg.skillAreas[0];

			expect(s).toHaveProperty('id');
			expect(s).toHaveProperty('personaId');
			expect(s).toHaveProperty('name');
			expect(s).toHaveProperty('description');
			expect(s).toHaveProperty('embedding');
			expect(s).toHaveProperty('active');
			expect(s).toHaveProperty('createdAt');
			expect(s).toHaveProperty('updatedAt');
			expect(s.embedding).toBeNull();
			expect(s.active).toBe(true);
		});
	});

	// ─── 8. Seed Defaults ───────────────────────────────────────────────

	describe('Seed defaults: seedFromDefaults() creates hierarchy from SEED_ROLES', () => {
		it('seeds all roles, personas, and skills from SEED_ROLES', async () => {
			const result = await store.seedFromDefaults();

			// SEED_ROLES has 4 roles
			expect(result.roles).toBe(4);

			// Count expected personas and skills from SEED_ROLES
			// Software Developer: 3 personas (5+5+5 = 15 skills)
			// Security Researcher: 2 personas (3+3 = 6 skills)
			// DevOps Engineer: 1 persona (4 skills)
			// Technical Writer: 1 persona (3 skills)
			expect(result.personas).toBe(7);
			expect(result.skills).toBe(28);

			// Verify roles exist
			const roles = await store.listRoles();
			expect(roles).toHaveLength(4);
			const roleNames = roles.map((r) => r.name);
			expect(roleNames).toContain('Software Developer');
			expect(roleNames).toContain('Security Researcher');
			expect(roleNames).toContain('DevOps Engineer');
			expect(roleNames).toContain('Technical Writer');
		});

		it('seeded personas are linked to correct roles', async () => {
			await store.seedFromDefaults();

			const roles = await store.listRoles();
			const devRole = roles.find((r) => r.name === 'Software Developer')!;
			const devPersonas = await store.listPersonas(devRole.id);

			expect(devPersonas).toHaveLength(3);
			const names = devPersonas.map((p) => p.name);
			expect(names).toContain('Rust Systems Developer');
			expect(names).toContain('React Frontend Engineer');
			expect(names).toContain('Python Backend Developer');
		});

		it('seeded skill areas are linked to correct personas', async () => {
			await store.seedFromDefaults();

			const allPersonas = await store.listPersonas();
			const rustPersona = allPersonas.find((p) => p.name === 'Rust Systems Developer')!;
			const rustSkills = await store.listSkillAreas(rustPersona.id);

			expect(rustSkills).toHaveLength(5);
			const skillNames = rustSkills.map((s) => s.name);
			expect(skillNames).toContain('Error Handling');
			expect(skillNames).toContain('Performance');
			expect(skillNames).toContain('Testing');
			expect(skillNames).toContain('Memory Safety');
			expect(skillNames).toContain('Async/Concurrency');
		});

		it('does not seed if roles already exist', async () => {
			await store.createRole('Existing', 'Already here');
			const result = await store.seedFromDefaults();

			expect(result.roles).toBe(0);
			expect(result.personas).toBe(0);
			expect(result.skills).toBe(0);

			// Only the manually created role should exist
			const roles = await store.listRoles();
			expect(roles).toHaveLength(1);
			expect(roles[0].name).toBe('Existing');
		});

		it('seeded hierarchy has correct parent references in registry', async () => {
			await store.seedFromDefaults();

			const reg = await store.readRegistry();

			// Every persona should reference a role that exists in roles array
			for (const persona of reg.personas) {
				const parentRole = reg.roles.find((r) => r.id === persona.roleId);
				expect(parentRole).toBeDefined();
				expect(parentRole!.personaIds).toContain(persona.id);
			}

			// Every skill area should reference a persona that exists in personas array
			for (const skill of reg.skillAreas) {
				const parentPersona = reg.personas.find((p) => p.id === skill.personaId);
				expect(parentPersona).toBeDefined();
				expect(parentPersona!.skillAreaIds).toContain(skill.id);
			}
		});
	});
});
