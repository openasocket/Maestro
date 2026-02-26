/**
 * Integration tests for hierarchy isolation guarantees.
 *
 * Verifies that the cascading search correctly enforces boundaries:
 *   1. Agent-type isolation  — persona assigned to claude-code is invisible to codex
 *   2. Project-path isolation — persona assigned to project A is invisible in project B
 *   3. Global scope universality — global memories appear regardless of agent/project
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
	encode: (...args: any[]) => mockEncode(...args),
	encodeBatch: (...args: any[]) => mockEncodeBatch(...args),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

import { MemoryStore } from '../../memory/memory-store';
import type { MemoryConfig } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIM = 384;

/** Create a deterministic unit vector pointing in a specific "direction". */
function makeVector(angle: number): number[] {
	const v = new Array(DIM).fill(0);
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

/** Convenience: make a config with overrides. */
function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, enabled: true, enableHybridSearch: false, ...overrides };
}

/**
 * Set embedding on a memory entry in a skill library.
 * Reads the library, sets the embedding on all entries, and writes it back.
 */
async function setSkillMemoryEmbeddings(
	store: MemoryStore,
	skillId: string,
	embedding: number[]
): Promise<void> {
	const path = store.getMemoryPath('skill', skillId);
	const lib = await store.readLibrary(path);
	for (const entry of lib.entries) {
		entry.embedding = embedding;
	}
	await store.writeLibrary(path, lib);
}

/** Set embedding on all entries in a global library. */
async function setGlobalMemoryEmbeddings(store: MemoryStore, embedding: number[]): Promise<void> {
	const path = store.getMemoryPath('global');
	const lib = await store.readLibrary(path);
	for (const entry of lib.entries) {
		entry.embedding = embedding;
	}
	await store.writeLibrary(path, lib);
}

/** Set embedding on all entries in a project library. */
async function setProjectMemoryEmbeddings(
	store: MemoryStore,
	projectPath: string,
	embedding: number[]
): Promise<void> {
	const path = store.getMemoryPath('project', undefined, projectPath);
	const lib = await store.readLibrary(path);
	for (const entry of lib.entries) {
		entry.embedding = embedding;
	}
	await store.writeLibrary(path, lib);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Memory Integration — Hierarchy Isolation', () => {
	let store: MemoryStore;
	const queryVec = makeVector(0);
	const nearVec = makeVector(0.05); // cosine sim ~0.999 to queryVec

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(queryVec);
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── 1. Agent-Type Isolation ─────────────────────────────────────────

	describe('Agent-type isolation: persona assignedAgents enforces boundaries', () => {
		it('persona assigned to claude-code is invisible when searching as codex', async () => {
			const role = await store.createRole('Developer', 'Software development');
			const persona = await store.createPersona(
				role.id,
				'Claude Specialist',
				'Exclusively for Claude Code',
				['claude-code']
			);
			const skill = await store.createSkillArea(persona.id, 'Debugging', 'Debug patterns');
			const mem = await store.addMemory({
				content: 'Use Claude-specific thinking blocks for debugging',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['debugging', 'claude'],
			});

			await setSkillMemoryEmbeddings(store, skill.id, nearVec);

			const config = makeConfig();

			// Search as codex — should NOT find the claude-code persona's memories
			const codexResults = await store.cascadingSearch('debugging techniques', config, 'codex');
			const codexHierarchy = codexResults.filter((r) => r.personaName);
			expect(codexHierarchy).toHaveLength(0);

			// Search as claude-code — should find them
			const claudeResults = await store.cascadingSearch(
				'debugging techniques',
				config,
				'claude-code'
			);
			const claudeHierarchy = claudeResults.filter((r) => r.personaName);
			expect(claudeHierarchy.length).toBeGreaterThanOrEqual(1);
			expect(claudeHierarchy[0].entry.id).toBe(mem.id);
			expect(claudeHierarchy[0].personaName).toBe('Claude Specialist');
		});

		it('multi-agent scenario: each agent only sees its own personas', async () => {
			const role = await store.createRole('Developer', 'Dev');

			// Persona for claude-code only
			const claudePersona = await store.createPersona(
				role.id,
				'Claude Dev',
				'Claude-specific patterns',
				['claude-code']
			);
			const claudeSkill = await store.createSkillArea(
				claudePersona.id,
				'Prompting',
				'Prompt engineering'
			);
			const claudeMem = await store.addMemory({
				content: 'Use extended thinking for complex reasoning',
				scope: 'skill',
				skillAreaId: claudeSkill.id,
			});

			// Persona for codex only
			const codexPersona = await store.createPersona(
				role.id,
				'Codex Dev',
				'Codex-specific patterns',
				['codex']
			);
			const codexSkill = await store.createSkillArea(
				codexPersona.id,
				'Code Gen',
				'Code generation'
			);
			const codexMem = await store.addMemory({
				content: 'Use codex completion endpoint for code generation',
				scope: 'skill',
				skillAreaId: codexSkill.id,
			});

			await setSkillMemoryEmbeddings(store, claudeSkill.id, nearVec);
			await setSkillMemoryEmbeddings(store, codexSkill.id, nearVec);

			const config = makeConfig();

			// claude-code sees only its persona
			const claudeResults = await store.cascadingSearch('code generation', config, 'claude-code');
			const claudeIds = claudeResults.filter((r) => r.personaName).map((r) => r.entry.id);
			expect(claudeIds).toContain(claudeMem.id);
			expect(claudeIds).not.toContain(codexMem.id);

			// codex sees only its persona
			const codexResults = await store.cascadingSearch('code generation', config, 'codex');
			const codexIds = codexResults.filter((r) => r.personaName).map((r) => r.entry.id);
			expect(codexIds).toContain(codexMem.id);
			expect(codexIds).not.toContain(claudeMem.id);
		});

		it('persona assigned to multiple agents is visible to all listed agents', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(
				role.id,
				'Shared Dev',
				'Shared between Claude and Codex',
				['claude-code', 'codex']
			);
			const skill = await store.createSkillArea(persona.id, 'Testing', 'Test patterns');
			const mem = await store.addMemory({
				content: 'Always write integration tests',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			await setSkillMemoryEmbeddings(store, skill.id, nearVec);

			const config = makeConfig();

			// Both claude-code and codex see it
			for (const agent of ['claude-code', 'codex']) {
				const results = await store.cascadingSearch('testing', config, agent);
				const hierarchy = results.filter((r) => r.personaName);
				expect(hierarchy.length).toBeGreaterThanOrEqual(1);
				expect(hierarchy[0].entry.id).toBe(mem.id);
			}

			// opencode does NOT see it (not in the assignedAgents list)
			const opencodeResults = await store.cascadingSearch('testing', config, 'opencode');
			const opencodeHierarchy = opencodeResults.filter((r) => r.personaName);
			expect(opencodeHierarchy).toHaveLength(0);
		});
	});

	// ─── 2. Project-Path Isolation ───────────────────────────────────────

	describe('Project-path isolation: persona assignedProjects enforces boundaries', () => {
		it('persona assigned to project A is invisible when searching in project B', async () => {
			const projectA = '/home/user/project-alpha';
			const projectB = '/home/user/project-beta';

			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(
				role.id,
				'Alpha Specialist',
				'Only for project alpha',
				[], // all agents
				[projectA]
			);
			const skill = await store.createSkillArea(persona.id, 'Architecture', 'Alpha architecture');
			const mem = await store.addMemory({
				content: 'Project Alpha uses microservices architecture',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			await setSkillMemoryEmbeddings(store, skill.id, nearVec);

			const config = makeConfig();

			// Search in project B — should NOT find project A's persona memories
			const resultB = await store.cascadingSearch(
				'architecture patterns',
				config,
				'claude-code',
				projectB
			);
			const hierarchyB = resultB.filter((r) => r.personaName);
			expect(hierarchyB).toHaveLength(0);

			// Search in project A — should find them
			const resultA = await store.cascadingSearch(
				'architecture patterns',
				config,
				'claude-code',
				projectA
			);
			const hierarchyA = resultA.filter((r) => r.personaName);
			expect(hierarchyA.length).toBeGreaterThanOrEqual(1);
			expect(hierarchyA[0].entry.id).toBe(mem.id);
			expect(hierarchyA[0].personaName).toBe('Alpha Specialist');
		});

		it('multi-project scenario: each project only sees its own personas', async () => {
			const projectA = '/home/user/frontend-app';
			const projectB = '/home/user/backend-api';

			const role = await store.createRole('Developer', 'Dev');

			// Persona for frontend project
			const frontendPersona = await store.createPersona(
				role.id,
				'Frontend Dev',
				'React and UI patterns',
				[],
				[projectA]
			);
			const frontendSkill = await store.createSkillArea(
				frontendPersona.id,
				'React',
				'React patterns'
			);
			const frontendMem = await store.addMemory({
				content: 'Use React hooks for state management',
				scope: 'skill',
				skillAreaId: frontendSkill.id,
			});

			// Persona for backend project
			const backendPersona = await store.createPersona(
				role.id,
				'Backend Dev',
				'API and database patterns',
				[],
				[projectB]
			);
			const backendSkill = await store.createSkillArea(backendPersona.id, 'APIs', 'API design');
			const backendMem = await store.addMemory({
				content: 'Use REST endpoints with proper error codes',
				scope: 'skill',
				skillAreaId: backendSkill.id,
			});

			await setSkillMemoryEmbeddings(store, frontendSkill.id, nearVec);
			await setSkillMemoryEmbeddings(store, backendSkill.id, nearVec);

			const config = makeConfig();

			// Frontend project sees only frontend persona
			const frontResults = await store.cascadingSearch(
				'development patterns',
				config,
				'claude-code',
				projectA
			);
			const frontIds = frontResults.filter((r) => r.personaName).map((r) => r.entry.id);
			expect(frontIds).toContain(frontendMem.id);
			expect(frontIds).not.toContain(backendMem.id);

			// Backend project sees only backend persona
			const backResults = await store.cascadingSearch(
				'development patterns',
				config,
				'claude-code',
				projectB
			);
			const backIds = backResults.filter((r) => r.personaName).map((r) => r.entry.id);
			expect(backIds).toContain(backendMem.id);
			expect(backIds).not.toContain(frontendMem.id);
		});
	});

	// ─── 3. Global Memories — Found Everywhere ───────────────────────────

	describe('Global memory universality: global memories visible regardless of agent or project', () => {
		it('global memories appear in results for every agent type', async () => {
			const globalMem = await store.addMemory({
				content: 'Always follow the DRY principle',
				scope: 'global',
				tags: ['best-practice'],
			});

			await setGlobalMemoryEmbeddings(store, nearVec);

			const config = makeConfig();

			for (const agent of ['claude-code', 'codex', 'opencode', 'factory-droid']) {
				const results = await store.cascadingSearch('coding principles', config, agent);
				const ids = results.map((r) => r.entry.id);
				expect(ids).toContain(globalMem.id);
			}
		});

		it('global memories appear in results for every project path', async () => {
			const globalMem = await store.addMemory({
				content: 'Write comprehensive error messages',
				scope: 'global',
			});

			await setGlobalMemoryEmbeddings(store, nearVec);

			const config = makeConfig();

			const projects = [
				'/home/user/project-one',
				'/home/user/project-two',
				'/home/user/project-three',
			];

			for (const proj of projects) {
				const results = await store.cascadingSearch('error handling', config, 'claude-code', proj);
				const ids = results.map((r) => r.entry.id);
				expect(ids).toContain(globalMem.id);
			}

			// Also works without any project path
			const noProjectResults = await store.cascadingSearch('error handling', config, 'claude-code');
			const noProjectIds = noProjectResults.map((r) => r.entry.id);
			expect(noProjectIds).toContain(globalMem.id);
		});

		it('global memories coexist with agent-scoped hierarchy results', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const persona = await store.createPersona(role.id, 'Claude Expert', 'Claude patterns', [
				'claude-code',
			]);
			const skill = await store.createSkillArea(persona.id, 'Prompting', 'Prompt eng');
			const hierarchyMem = await store.addMemory({
				content: 'Use system prompts for persona definition',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const globalMem = await store.addMemory({
				content: 'Keep prompts concise and clear',
				scope: 'global',
			});

			await setSkillMemoryEmbeddings(store, skill.id, nearVec);
			await setGlobalMemoryEmbeddings(store, nearVec);

			const config = makeConfig();

			// claude-code sees both hierarchy AND global
			const claudeResults = await store.cascadingSearch(
				'prompt engineering',
				config,
				'claude-code'
			);
			const claudeIds = claudeResults.map((r) => r.entry.id);
			expect(claudeIds).toContain(hierarchyMem.id);
			expect(claudeIds).toContain(globalMem.id);

			// codex sees only global (hierarchy persona is claude-code only)
			const codexResults = await store.cascadingSearch('prompt engineering', config, 'codex');
			const codexIds = codexResults.map((r) => r.entry.id);
			expect(codexIds).not.toContain(hierarchyMem.id);
			expect(codexIds).toContain(globalMem.id);
		});
	});

	// ─── 4. Combined Isolation (Agent + Project + Global) ────────────────

	describe('Combined isolation: agent, project, and global boundaries enforced simultaneously', () => {
		it('full isolation matrix: correct visibility across agent × project combinations', async () => {
			const projectA = '/home/user/repo-alpha';
			const projectB = '/home/user/repo-beta';

			const role = await store.createRole('Developer', 'Dev');

			// Persona: claude-code + project A only
			const claudeAlphaPersona = await store.createPersona(
				role.id,
				'Claude Alpha',
				'Claude in project A',
				['claude-code'],
				[projectA]
			);
			const claudeAlphaSkill = await store.createSkillArea(
				claudeAlphaPersona.id,
				'Alpha Patterns',
				'Patterns for alpha'
			);
			const claudeAlphaMem = await store.addMemory({
				content: 'Alpha uses event sourcing with Claude',
				scope: 'skill',
				skillAreaId: claudeAlphaSkill.id,
			});

			// Global memory — visible everywhere
			const globalMem = await store.addMemory({
				content: 'Always validate inputs at boundaries',
				scope: 'global',
			});

			// Project-scoped memory for project A
			const projectMem = await store.addMemory(
				{ content: 'Alpha project uses PostgreSQL', scope: 'project' },
				projectA
			);

			await setSkillMemoryEmbeddings(store, claudeAlphaSkill.id, nearVec);
			await setGlobalMemoryEmbeddings(store, nearVec);
			await setProjectMemoryEmbeddings(store, projectA, nearVec);

			const config = makeConfig();

			// claude-code + project A → sees all three
			const claudeAlphaResults = await store.cascadingSearch(
				'architecture',
				config,
				'claude-code',
				projectA
			);
			const claudeAlphaIds = claudeAlphaResults.map((r) => r.entry.id);
			expect(claudeAlphaIds).toContain(claudeAlphaMem.id);
			expect(claudeAlphaIds).toContain(globalMem.id);
			expect(claudeAlphaIds).toContain(projectMem.id);

			// claude-code + project B → only global (persona is project-A-only, project mem is A-only)
			const claudeBetaResults = await store.cascadingSearch(
				'architecture',
				config,
				'claude-code',
				projectB
			);
			const claudeBetaIds = claudeBetaResults.map((r) => r.entry.id);
			expect(claudeBetaIds).not.toContain(claudeAlphaMem.id);
			expect(claudeBetaIds).toContain(globalMem.id);
			expect(claudeBetaIds).not.toContain(projectMem.id);

			// codex + project A → global + project mem (persona is claude-code-only)
			const codexAlphaResults = await store.cascadingSearch(
				'architecture',
				config,
				'codex',
				projectA
			);
			const codexAlphaIds = codexAlphaResults.map((r) => r.entry.id);
			expect(codexAlphaIds).not.toContain(claudeAlphaMem.id);
			expect(codexAlphaIds).toContain(globalMem.id);
			expect(codexAlphaIds).toContain(projectMem.id);

			// codex + project B → only global
			const codexBetaResults = await store.cascadingSearch(
				'architecture',
				config,
				'codex',
				projectB
			);
			const codexBetaIds = codexBetaResults.map((r) => r.entry.id);
			expect(codexBetaIds).not.toContain(claudeAlphaMem.id);
			expect(codexBetaIds).toContain(globalMem.id);
			expect(codexBetaIds).not.toContain(projectMem.id);
		});

		it('universal persona (empty agents + empty projects) is visible to all combinations', async () => {
			const role = await store.createRole('Developer', 'Dev');
			const universalPersona = await store.createPersona(
				role.id,
				'Universal Dev',
				'No restrictions',
				[], // all agents
				[] // all projects
			);
			const skill = await store.createSkillArea(universalPersona.id, 'General', 'General patterns');
			const mem = await store.addMemory({
				content: 'Write clean, readable code',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			await setSkillMemoryEmbeddings(store, skill.id, nearVec);

			const config = makeConfig();

			// Every agent × project combination should find this memory
			const agents = ['claude-code', 'codex', 'opencode'];
			const projects = ['/home/user/proj-a', '/home/user/proj-b', undefined];

			for (const agent of agents) {
				for (const project of projects) {
					const results = await store.cascadingSearch('code quality', config, agent, project);
					const hierarchy = results.filter((r) => r.personaName);
					expect(hierarchy.length).toBeGreaterThanOrEqual(1);
					expect(hierarchy[0].entry.id).toBe(mem.id);
				}
			}
		});
	});
});
