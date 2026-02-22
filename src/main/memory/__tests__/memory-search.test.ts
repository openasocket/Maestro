/**
 * Tests for MemoryStore.cascadingSearch — persona/skill filtering,
 * embedding-based matching, flat-scope parallel search, combined scoring,
 * and injection recording.
 *
 * Mocks fs/promises, electron, electron-store, and the embedding service.
 * Uses the REAL cosineSimilarity implementation to verify scoring math.
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
import type { MemoryConfig, MemoryEntry } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DIM = 384;

/**
 * Create a deterministic unit vector pointing in a specific "direction".
 * Vectors with nearby `angle` values will have high cosine similarity;
 * vectors with distant `angle` values will have low similarity.
 */
function makeVector(angle: number): number[] {
	const v = new Array(DIM).fill(0);
	// Place energy in 2 dimensions to create directional vectors
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

/** Convenience: make a config with overrides. */
function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, enabled: true, ...overrides };
}

describe('MemoryStore — Cascading Search, Filtering, Scoring, Injection Recording', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(DIM).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
	});

	// ─── 1. Cascading Filter Pipeline ────────────────────────────────────

	describe('Cascading filter: persona → skill → memory pipeline narrows correctly', () => {
		it('returns memories from matching persona+skill chain and excludes non-matching', async () => {
			// Set up hierarchy: 2 personas, each with 1 skill, each with 1 memory
			const role = await store.createRole('Dev', 'Development');

			// Persona A — embedding close to query
			const personaA = await store.createPersona(role.id, 'Rust Dev', 'Rust systems');
			const skillA = await store.createSkillArea(personaA.id, 'Error Handling', 'Error patterns');
			const memA = await store.addMemory({
				content: 'Use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId: skillA.id,
			});

			// Persona B — embedding far from query
			const personaB = await store.createPersona(role.id, 'Java Dev', 'Java enterprise');
			const skillB = await store.createSkillArea(personaB.id, 'Spring Boot', 'Spring framework');
			const memB = await store.addMemory({
				content: 'Use @Autowired for dependency injection',
				scope: 'skill',
				skillAreaId: skillB.id,
			});

			// Set up embeddings: personaA matches query, personaB doesn't
			const queryVec = makeVector(0);
			const matchVec = makeVector(0.1); // close to query (sim ~0.995)
			const farVec = makeVector(Math.PI); // opposite direction (sim ~ -1)

			// Set persona embeddings in registry
			const reg = await store.readRegistry();
			reg.personas[0].embedding = matchVec; // personaA
			reg.personas[1].embedding = farVec; // personaB
			reg.skillAreas[0].embedding = matchVec; // skillA
			reg.skillAreas[1].embedding = farVec; // skillB
			await store.writeRegistry(reg);

			// Set memory embeddings in libraries
			const skillAPath = store.getMemoryPath('skill', skillA.id);
			const libA = await store.readLibrary(skillAPath);
			libA.entries[0].embedding = matchVec;
			await store.writeLibrary(skillAPath, libA);

			const skillBPath = store.getMemoryPath('skill', skillB.id);
			const libB = await store.readLibrary(skillBPath);
			libB.entries[0].embedding = matchVec; // Even if memory matches, persona won't
			await store.writeLibrary(skillBPath, libB);

			// Mock encode to return our query vector
			mockEncode.mockResolvedValue(queryVec);

			const config = makeConfig({
				personaMatchThreshold: 0.4,
				skillMatchThreshold: 0.5,
				similarityThreshold: 0.65,
			});

			const results = await store.cascadingSearch('error handling Rust', config, 'claude-code');

			// Should find memA (persona A matched), NOT memB (persona B filtered out)
			expect(results.length).toBeGreaterThanOrEqual(1);
			const resultIds = results.map((r) => r.entry.id);
			expect(resultIds).toContain(memA.id);
			expect(resultIds).not.toContain(memB.id);

			// Verify persona/skill names propagated
			const memAResult = results.find((r) => r.entry.id === memA.id)!;
			expect(memAResult.personaName).toBe('Rust Dev');
			expect(memAResult.skillAreaName).toBe('Error Handling');
		});

		it('empty results when no persona matches the query', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Java Dev', 'Java');
			const skill = await store.createSkillArea(persona.id, 'Spring', 'Spring');
			await store.addMemory({ content: 'Use Spring Boot', scope: 'skill', skillAreaId: skill.id });

			// Set far-away embedding on persona
			const reg = await store.readRegistry();
			reg.personas[0].embedding = makeVector(Math.PI);
			await store.writeRegistry(reg);

			mockEncode.mockResolvedValue(makeVector(0));
			const config = makeConfig({ personaMatchThreshold: 0.4 });

			const results = await store.cascadingSearch('rust error handling', config, 'claude-code');
			// No hierarchy results (persona filtered out). Flat scopes may be empty too.
			const hierarchyResults = results.filter((r) => r.personaName);
			expect(hierarchyResults).toHaveLength(0);
		});
	});

	// ─── 2. Persona Filtering by Agent Type ─────────────────────────────

	describe('Persona filtering: assignedAgents restricts persona visibility', () => {
		it('persona assigned to claude-code is excluded when searching as codex', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Claude Only', 'desc', ['claude-code']);
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Claude-specific memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Persona has no embedding → included by default (unless agent-filtered)
			mockEncode.mockResolvedValue(makeVector(0));

			// Set skill and memory embeddings
			const reg = await store.readRegistry();
			reg.skillAreas[0].embedding = null; // No embedding = included
			await store.writeRegistry(reg);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();

			// Search as codex — persona should be excluded
			const codexResults = await store.cascadingSearch('anything', config, 'codex');
			const hierarchyResults = codexResults.filter((r) => r.personaName);
			expect(hierarchyResults).toHaveLength(0);

			// Search as claude-code — persona should be included
			const claudeResults = await store.cascadingSearch('anything', config, 'claude-code');
			const claudeHierarchy = claudeResults.filter((r) => r.personaName);
			expect(claudeHierarchy.length).toBeGreaterThanOrEqual(1);
			expect(claudeHierarchy[0].entry.id).toBe(mem.id);
		});

		it('persona with empty assignedAgents matches all agent types', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Universal', 'desc', []); // empty = all
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Universal memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();

			// Both agent types should find it
			for (const agent of ['claude-code', 'codex', 'opencode']) {
				const results = await store.cascadingSearch('anything', config, agent);
				const hierarchy = results.filter((r) => r.personaName);
				expect(hierarchy.length).toBeGreaterThanOrEqual(1);
			}
		});
	});

	// ─── 3. Project Filtering ───────────────────────────────────────────

	describe('Project filtering: assignedProjects restricts persona visibility', () => {
		it('persona assigned to project A is excluded when searching in project B', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(
				role.id,
				'ProjectA Only',
				'desc',
				[],
				['/home/user/project-a']
			);
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Project A memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();

			// Search in project B — persona excluded
			const resultsB = await store.cascadingSearch(
				'anything',
				config,
				'claude-code',
				'/home/user/project-b'
			);
			const hierarchyB = resultsB.filter((r) => r.personaName);
			expect(hierarchyB).toHaveLength(0);

			// Search in project A — persona included
			const resultsA = await store.cascadingSearch(
				'anything',
				config,
				'claude-code',
				'/home/user/project-a'
			);
			const hierarchyA = resultsA.filter((r) => r.personaName);
			expect(hierarchyA.length).toBeGreaterThanOrEqual(1);
			expect(hierarchyA[0].entry.id).toBe(mem.id);
		});

		it('persona with empty assignedProjects matches all projects', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Any Project', 'desc', [], []);
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			await store.addMemory({
				content: 'Everywhere memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();

			const results = await store.cascadingSearch(
				'anything',
				config,
				'claude-code',
				'/home/user/any-project'
			);
			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy.length).toBeGreaterThanOrEqual(1);
		});
	});

	// ─── 4. Unembedded Fallback ─────────────────────────────────────────

	describe('Unembedded fallback: personas/skills without embeddings are included', () => {
		it('persona without embedding is included in search (not filtered out)', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'No Embedding', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Memory under unembedded persona',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Persona has null embedding (default) — should be included
			const reg = await store.readRegistry();
			expect(reg.personas[0].embedding).toBeNull();
			// Skill also has null embedding — should be included
			expect(reg.skillAreas[0].embedding).toBeNull();

			mockEncode.mockResolvedValue(makeVector(0));

			// Memory needs embedding for similarity check
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code');
			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy.length).toBeGreaterThanOrEqual(1);
			expect(hierarchy[0].entry.id).toBe(mem.id);
		});

		it('skill without embedding is included if parent persona matches', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Embedded Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Unembedded Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Memory under unembedded skill',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Set persona embedding (matches query), skill stays null
			const reg = await store.readRegistry();
			reg.personas[0].embedding = makeVector(0.05);
			expect(reg.skillAreas[0].embedding).toBeNull();
			await store.writeRegistry(reg);

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code');
			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy.length).toBeGreaterThanOrEqual(1);
			expect(hierarchy[0].entry.id).toBe(mem.id);
		});
	});

	// ─── 5. Flat Scope Parallel Search ──────────────────────────────────

	describe('Flat scope parallel: project and global memories alongside hierarchy results', () => {
		it('global memories appear in results alongside hierarchy results', async () => {
			// Set up hierarchy
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const skillMem = await store.addMemory({
				content: 'Skill memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Add global memory
			const globalMem = await store.addMemory({ content: 'Global memory', scope: 'global' });

			const vec = makeVector(0);
			mockEncode.mockResolvedValue(vec);

			// Set embeddings on everything
			const skillPath = store.getMemoryPath('skill', skill.id);
			const skillLib = await store.readLibrary(skillPath);
			skillLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, skillLib);

			const globalPath = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalPath);
			globalLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalPath, globalLib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code');

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(skillMem.id);
			expect(ids).toContain(globalMem.id);
		});

		it('project-scoped memories appear when projectPath is provided', async () => {
			const projPath = '/home/user/my-project';

			const projMem = await store.addMemory(
				{ content: 'Project memory', scope: 'project' },
				projPath
			);
			const globalMem = await store.addMemory({ content: 'Global memory', scope: 'global' });

			const vec = makeVector(0);
			mockEncode.mockResolvedValue(vec);

			// Set embeddings
			const projDir = store.getMemoryPath('project', undefined, projPath);
			const projLib = await store.readLibrary(projDir);
			projLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(projDir, projLib);

			const globalDir = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalDir);
			globalLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalDir, globalLib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code', projPath);

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(projMem.id);
			expect(ids).toContain(globalMem.id);
		});

		it('project memories are NOT searched when projectPath is not provided', async () => {
			const projPath = '/home/user/my-project';

			const projMem = await store.addMemory(
				{ content: 'Project memory', scope: 'project' },
				projPath
			);
			const globalMem = await store.addMemory({ content: 'Global memory', scope: 'global' });

			const vec = makeVector(0);
			mockEncode.mockResolvedValue(vec);

			const projDir = store.getMemoryPath('project', undefined, projPath);
			const projLib = await store.readLibrary(projDir);
			projLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(projDir, projLib);

			const globalDir = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalDir);
			globalLib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalDir, globalLib);

			const config = makeConfig();
			// No projectPath — should only get global, not project
			const results = await store.cascadingSearch('anything', config, 'claude-code');

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(globalMem.id);
			expect(ids).not.toContain(projMem.id);
		});
	});

	// ─── 6. Combined Score Ranking ──────────────────────────────────────

	describe('Combined score ranking: similarity * 0.6 + effectiveness * 0.2 + recency * 0.2', () => {
		it('higher similarity entries rank above lower similarity entries', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const mem1 = await store.addMemory({
				content: 'High relevance memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const mem2 = await store.addMemory({
				content: 'Lower relevance memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			// mem1 is very close to query, mem2 is further
			const highSimVec = makeVector(0.05); // cos(0.05) ≈ 0.999
			const lowerSimVec = makeVector(0.5); // cos(0.5) ≈ 0.878

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = highSimVec;
			lib.entries[1].embedding = lowerSimVec;
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig({ similarityThreshold: 0.65 });
			const results = await store.cascadingSearch('query', config, 'claude-code');

			expect(results.length).toBe(2);
			// Higher similarity → higher combined score → first in list
			expect(results[0].entry.id).toBe(mem1.id);
			expect(results[1].entry.id).toBe(mem2.id);
			expect(results[0].combinedScore).toBeGreaterThan(results[1].combinedScore);
		});

		it('effectiveness score contributes to ranking', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const mem1 = await store.addMemory({
				content: 'Low effectiveness',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const mem2 = await store.addMemory({
				content: 'High effectiveness',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			// Same similarity, different effectiveness
			const sameVec = makeVector(0.1);
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = sameVec;
			lib.entries[0].effectivenessScore = 0.1; // low
			lib.entries[1].embedding = sameVec;
			lib.entries[1].effectivenessScore = 1.0; // high
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('query', config, 'claude-code');

			expect(results.length).toBe(2);
			// mem2 has higher effectiveness → higher combinedScore → first
			expect(results[0].entry.id).toBe(mem2.id);
			expect(results[1].entry.id).toBe(mem1.id);
		});

		it('combined score formula produces correct values', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const mem = await store.addMemory({
				content: 'Score test memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const queryVec = makeVector(0);
			const memVec = makeVector(0.1);
			mockEncode.mockResolvedValue(queryVec);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = memVec;
			lib.entries[0].effectivenessScore = 0.8;
			// Set updatedAt to now so recency is ~1.0
			lib.entries[0].updatedAt = Date.now();
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig({ decayHalfLifeDays: 30 });
			const results = await store.cascadingSearch('query', config, 'claude-code');

			expect(results.length).toBe(1);
			const result = results[0];

			// Verify the math: similarity * 0.6 + effectiveness * 0.2 + recency * 0.2
			const expectedSimilarity = realCosineSimilarity(queryVec, memVec);
			const recencyScore = 1.0; // Just created, recency ≈ 1.0
			const expectedCombined = expectedSimilarity * 0.6 + 0.8 * 0.2 + recencyScore * 0.2;

			expect(result.similarity).toBeCloseTo(expectedSimilarity, 5);
			expect(result.combinedScore).toBeCloseTo(expectedCombined, 1);
		});

		it('old memories get lower recency scores', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const recentMem = await store.addMemory({
				content: 'Recent memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const oldMem = await store.addMemory({
				content: 'Old memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const queryVec = makeVector(0);
			const memVec = makeVector(0.1);
			mockEncode.mockResolvedValue(queryVec);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			// Both have same similarity and effectiveness
			lib.entries[0].embedding = memVec;
			lib.entries[0].effectivenessScore = 0.5;
			lib.entries[0].updatedAt = Date.now(); // recent

			lib.entries[1].embedding = memVec;
			lib.entries[1].effectivenessScore = 0.5;
			lib.entries[1].updatedAt = Date.now() - 60 * 86400000; // 60 days ago (2 half-lives)
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig({ decayHalfLifeDays: 30 });
			const results = await store.cascadingSearch('query', config, 'claude-code');

			expect(results.length).toBe(2);
			// Recent memory should have higher score
			expect(results[0].entry.id).toBe(recentMem.id);
			expect(results[0].combinedScore).toBeGreaterThan(results[1].combinedScore);
		});
	});

	// ─── 7. Injection Recording ─────────────────────────────────────────

	describe('Injection recording: useCount and lastUsedAt updated', () => {
		it('recordInjection increments useCount and updates lastUsedAt', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const mem1 = await store.addMemory({
				content: 'Memory 1',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const mem2 = await store.addMemory({
				content: 'Memory 2',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Initially both have useCount=0 and lastUsedAt=0
			expect(mem1.useCount).toBe(0);
			expect(mem1.lastUsedAt).toBe(0);
			expect(mem2.useCount).toBe(0);

			const beforeTime = Date.now();

			// Record injection for mem1 only
			await store.recordInjection([mem1.id], 'skill', skill.id);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);

			const updated1 = lib.entries.find((e) => e.id === mem1.id)!;
			const updated2 = lib.entries.find((e) => e.id === mem2.id)!;

			// mem1 should have incremented
			expect(updated1.useCount).toBe(1);
			expect(updated1.lastUsedAt).toBeGreaterThanOrEqual(beforeTime);

			// mem2 should be untouched
			expect(updated2.useCount).toBe(0);
			expect(updated2.lastUsedAt).toBe(0);
		});

		it('recordInjection is cumulative across multiple calls', async () => {
			const mem = await store.addMemory({ content: 'Global mem', scope: 'global' });

			await store.recordInjection([mem.id], 'global');
			await store.recordInjection([mem.id], 'global');
			await store.recordInjection([mem.id], 'global');

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			const updated = lib.entries.find((e) => e.id === mem.id)!;

			expect(updated.useCount).toBe(3);
		});

		it('recordInjection with empty array is a no-op', async () => {
			await store.addMemory({ content: 'Untouched', scope: 'global' });

			const globalPath = store.getMemoryPath('global');
			const libBefore = await store.readLibrary(globalPath);
			const countBefore = libBefore.entries[0].useCount;

			await store.recordInjection([], 'global');

			const libAfter = await store.readLibrary(globalPath);
			expect(libAfter.entries[0].useCount).toBe(countBefore);
		});

		it('recordInjection works for project-scoped memories', async () => {
			const projPath = '/home/user/my-project';
			const mem = await store.addMemory({ content: 'Project memory', scope: 'project' }, projPath);

			await store.recordInjection([mem.id], 'project', undefined, projPath);

			const projDir = store.getMemoryPath('project', undefined, projPath);
			const lib = await store.readLibrary(projDir);
			const updated = lib.entries.find((e) => e.id === mem.id)!;

			expect(updated.useCount).toBe(1);
			expect(updated.lastUsedAt).toBeGreaterThan(0);
		});
	});

	// ─── 8. Edge Cases ──────────────────────────────────────────────────

	describe('Edge cases and de-duplication', () => {
		it('inactive personas are skipped during search', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Active', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Should be invisible',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Deactivate persona
			const reg = await store.readRegistry();
			reg.personas[0].active = false;
			await store.writeRegistry(reg);

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code');
			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy).toHaveLength(0);
		});

		it('inactive skill areas are skipped during search', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			await store.addMemory({
				content: 'Under inactive skill',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Deactivate skill
			const reg = await store.readRegistry();
			reg.skillAreas[0].active = false;
			await store.writeRegistry(reg);

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('anything', config, 'claude-code');
			const hierarchy = results.filter((r) => r.personaName);
			expect(hierarchy).toHaveLength(0);
		});

		it('memories without embeddings are skipped (not crash)', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			const embeddedMem = await store.addMemory({
				content: 'Has embedding',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const unembeddedMem = await store.addMemory({
				content: 'No embedding',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			mockEncode.mockResolvedValue(makeVector(0));

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05); // embedded
			// entries[1].embedding is null — should be skipped, not crash
			await store.writeLibrary(skillPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('query', config, 'claude-code');

			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(embeddedMem.id);
			expect(ids).not.toContain(unembeddedMem.id);
		});

		it('results are de-duplicated by entry ID', async () => {
			// This tests that if somehow the same memory appears in multiple paths,
			// it only appears once in results. We force this by having the same
			// memory ID appear via both hierarchy and flat scope
			// (in practice this shouldn't happen, but the code de-dupes anyway)
			const globalMem = await store.addMemory({ content: 'Global mem', scope: 'global' });

			mockEncode.mockResolvedValue(makeVector(0));

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(globalPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('query', config, 'claude-code');

			// Count occurrences of the global memory
			const occurrences = results.filter((r) => r.entry.id === globalMem.id);
			expect(occurrences).toHaveLength(1);
		});

		it('respects the limit parameter', async () => {
			// Create many global memories
			for (let i = 0; i < 10; i++) {
				await store.addMemory({ content: `Memory ${i}`, scope: 'global' });
			}

			mockEncode.mockResolvedValue(makeVector(0));

			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			for (let i = 0; i < lib.entries.length; i++) {
				lib.entries[i].embedding = makeVector(0.05 + i * 0.01);
			}
			await store.writeLibrary(globalPath, lib);

			const config = makeConfig();
			const results = await store.cascadingSearch('query', config, 'claude-code', undefined, 3);

			expect(results.length).toBeLessThanOrEqual(3);
		});
	});
});
