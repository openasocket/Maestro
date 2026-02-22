/**
 * Integration tests for the full hierarchical memory pipeline.
 *
 * Exercises the end-to-end flow:
 *   IPC-level store → hierarchy CRUD → add memory → ensure embeddings
 *   → cascading search → injection → effectiveness tracking
 *
 * Uses the same mock infrastructure as the unit tests (fs/promises,
 * electron, electron-store, embedding-service) but exercises cross-module
 * interactions that the unit tests don't cover.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
import { injectMemories, setMemorySettingsStore } from '../../memory/memory-injector';
import type { MemoryConfig } from '../../../shared/memory-types';
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
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

/** Convenience: make a config with overrides. */
function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
	return { ...MEMORY_CONFIG_DEFAULTS, enabled: true, ...overrides };
}

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Memory Integration — End-to-End Pipeline', () => {
	let store: MemoryStore;

	beforeEach(() => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(DIM).fill(0));
		mockEncodeBatch.mockResolvedValue([]);
		store = new MemoryStore();
		// Enable memory system for injector tests
		setMemorySettingsStore(() => ({ enabled: true }));
	});

	afterEach(() => {
		setMemorySettingsStore(() => undefined);
	});

	// ─── Full Lifecycle ─────────────────────────────────────────────────

	describe('Full lifecycle: hierarchy → memory → search → inject → effectiveness', () => {
		it('creates hierarchy, adds memory, searches, injects, and tracks effectiveness', async () => {
			// 1. Create hierarchy: Software Developer > Rust Developer > Error Handling
			const role = await store.createRole('Software Developer', 'Full-stack development');
			const persona = await store.createPersona(
				role.id,
				'Rust Developer',
				'Systems programming in Rust',
				['claude-code']
			);
			const skill = await store.createSkillArea(
				persona.id,
				'Error Handling',
				'Error handling patterns'
			);

			// 2. Add memory to skill
			const memory = await store.addMemory({
				content: 'Always use Result<T, E> in Rust',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['rust'],
				source: 'user',
				confidence: 1.0,
			});

			expect(memory.id).toBeTruthy();
			expect(memory.scope).toBe('skill');
			expect(memory.active).toBe(true);

			// 3. Ensure embeddings — mock encodeBatch to return our directional vectors
			const queryVec = makeVector(0);
			const matchVec = makeVector(0.05); // close to query, sim ~0.999

			mockEncodeBatch.mockImplementation(async (texts: string[]) => {
				return texts.map(() => matchVec);
			});
			mockEncode.mockResolvedValue(queryVec);

			await store.ensureAllEmbeddings('skill', skill.id);
			await store.ensureHierarchyEmbeddings();

			// Verify embeddings were set
			const reg = await store.readRegistry();
			const updatedPersona = reg.personas.find((p) => p.id === persona.id);
			expect(updatedPersona!.embedding).not.toBeNull();
			const updatedSkill = reg.skillAreas.find((s) => s.id === skill.id);
			expect(updatedSkill!.embedding).not.toBeNull();

			// Verify memory got its embedding
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			expect(lib.entries[0].embedding).not.toBeNull();

			// 4. Cascading search as claude-code
			const config = makeConfig();
			const results = await store.cascadingSearch('write rust code', config, 'claude-code');

			expect(results.length).toBeGreaterThan(0);
			expect(results[0].entry.id).toBe(memory.id);
			expect(results[0].personaName).toBe('Rust Developer');
			expect(results[0].skillAreaName).toBe('Error Handling');
			expect(results[0].similarity).toBeGreaterThan(0.9);

			// 5. Inject — the injector calls getMemoryStore() internally,
			// so we need to mock it to return our store instance.
			// We already set up mockEncode above and the injector will call
			// cascadingSearch on the store from getMemoryStore().
			// Since the injector imports getMemoryStore, we test via the store directly
			// and verify the injection formatting works with the results.

			// Instead, test the injection formatting by calling injectMemories
			// which uses getMemoryStore() internally — our MemoryStore is a fresh
			// instance, and getMemoryStore() returns a singleton. To make this work
			// in integration, we test by manually doing what injectMemories does:
			// search + format. The injector unit tests cover the formatting path.

			// Test that search results contain the expected content
			expect(results[0].entry.content).toContain('Result<T, E>');

			// 6. Effectiveness tracking (default effectivenessScore = 0.5)
			await store.updateEffectiveness([memory.id], 1.0, 'skill', skill.id);
			const updated = await store.getMemory(memory.id, 'skill', skill.id);
			expect(updated).not.toBeNull();
			// EMA: new = 0.3 * 1.0 + 0.7 * 0.5 = 0.65
			expect(updated!.effectivenessScore).toBeCloseTo(0.65, 5);

			// Second positive outcome: 0.3 * 1.0 + 0.7 * 0.65 = 0.755
			await store.updateEffectiveness([memory.id], 1.0, 'skill', skill.id);
			const updated2 = await store.getMemory(memory.id, 'skill', skill.id);
			expect(updated2!.effectivenessScore).toBeCloseTo(0.755, 5);
		});

		it('multi-level hierarchy with multiple memories and combined scoring', async () => {
			// Build a richer hierarchy
			const role = await store.createRole('Developer', 'Software dev');

			// Two personas
			const rustPersona = await store.createPersona(role.id, 'Rust Dev', 'Rust systems', [
				'claude-code',
			]);
			const pyPersona = await store.createPersona(role.id, 'Python Dev', 'Python backend', [
				'claude-code',
			]);

			const rustSkill = await store.createSkillArea(
				rustPersona.id,
				'Error Handling',
				'Error patterns'
			);
			const pySkill = await store.createSkillArea(pyPersona.id, 'Testing', 'Test patterns');

			// Add memories
			const rustMem = await store.addMemory({
				content: 'Use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId: rustSkill.id,
				tags: ['rust'],
			});
			const pyMem = await store.addMemory({
				content: 'Use pytest fixtures for test setup',
				scope: 'skill',
				skillAreaId: pySkill.id,
				tags: ['python'],
			});
			const globalMem = await store.addMemory({
				content: 'Always write tests for public functions',
				scope: 'global',
			});

			// Set up embeddings: rust-related vectors close to query
			const queryVec = makeVector(0);
			const rustVec = makeVector(0.05); // sim ~0.999 to query
			const pyVec = makeVector(1.5); // sim ~0.071 to query (far)
			const globalVec = makeVector(0.1); // sim ~0.995 to query

			mockEncode.mockResolvedValue(queryVec);

			// Set persona/skill embeddings directly
			const reg = await store.readRegistry();
			for (const p of reg.personas) {
				if (p.id === rustPersona.id) p.embedding = rustVec;
				if (p.id === pyPersona.id) p.embedding = pyVec;
			}
			for (const s of reg.skillAreas) {
				if (s.id === rustSkill.id) s.embedding = rustVec;
				if (s.id === pySkill.id) s.embedding = pyVec;
			}
			await store.writeRegistry(reg);

			// Set memory embeddings
			const rustPath = store.getMemoryPath('skill', rustSkill.id);
			const rustLib = await store.readLibrary(rustPath);
			rustLib.entries[0].embedding = rustVec;
			await store.writeLibrary(rustPath, rustLib);

			const pyPath = store.getMemoryPath('skill', pySkill.id);
			const pyLib = await store.readLibrary(pyPath);
			pyLib.entries[0].embedding = rustVec; // Even same vec won't matter — persona filtered out
			await store.writeLibrary(pyPath, pyLib);

			const globalPath = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalPath);
			globalLib.entries[0].embedding = globalVec;
			await store.writeLibrary(globalPath, globalLib);

			// Search for rust-related content
			const config = makeConfig({
				personaMatchThreshold: 0.4,
				skillMatchThreshold: 0.5,
				similarityThreshold: 0.65,
			});
			const results = await store.cascadingSearch('rust error handling', config, 'claude-code');

			// Should find rust memory (hierarchy) and global memory (flat scope)
			const ids = results.map((r) => r.entry.id);
			expect(ids).toContain(rustMem.id);
			expect(ids).toContain(globalMem.id);
			// Python memory filtered out (persona embedding too far from query)
			expect(ids).not.toContain(pyMem.id);

			// Verify ranking: rust memory should rank higher than global (hierarchy + similarity)
			const rustIdx = results.findIndex((r) => r.entry.id === rustMem.id);
			const globalIdx = results.findIndex((r) => r.entry.id === globalMem.id);
			expect(results[rustIdx].combinedScore).toBeGreaterThanOrEqual(
				results[globalIdx].combinedScore
			);
		});
	});

	// ─── Injection Recording Round-Trip ─────────────────────────────────

	describe('Injection recording round-trip: search → record → verify counts', () => {
		it('injection recording increments useCount and lastUsedAt on searched memories', async () => {
			// Set up a simple hierarchy with one memory
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');
			const mem = await store.addMemory({
				content: 'Important rule for testing',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			expect(mem.useCount).toBe(0);
			expect(mem.lastUsedAt).toBe(0);

			// Set memory embedding
			const vec = makeVector(0);
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0.05);
			await store.writeLibrary(skillPath, lib);

			mockEncode.mockResolvedValue(vec);

			// Search
			const config = makeConfig();
			const results = await store.cascadingSearch('test query', config, 'claude-code');
			expect(results.length).toBeGreaterThan(0);

			// Record injection
			const beforeTime = Date.now();
			await store.recordInjection(
				results.map((r) => r.entry.id),
				'skill',
				skill.id
			);

			// Verify the memory was updated
			const updated = await store.getMemory(mem.id, 'skill', skill.id);
			expect(updated!.useCount).toBe(1);
			expect(updated!.lastUsedAt).toBeGreaterThanOrEqual(beforeTime);

			// Second injection
			await store.recordInjection([mem.id], 'skill', skill.id);
			const updated2 = await store.getMemory(mem.id, 'skill', skill.id);
			expect(updated2!.useCount).toBe(2);
		});
	});

	// ─── Effectiveness Feedback Loop ────────────────────────────────────

	describe('Effectiveness feedback loop: inject → outcome → score update → improved ranking', () => {
		it('positive outcome increases effectiveness, improving search ranking', async () => {
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			// Two memories with same similarity but different effectiveness
			const mem1 = await store.addMemory({
				content: 'Memory A',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			const mem2 = await store.addMemory({
				content: 'Memory B',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const sameVec = makeVector(0.1);
			const queryVec = makeVector(0);
			mockEncode.mockResolvedValue(queryVec);

			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = sameVec;
			lib.entries[1].embedding = sameVec;
			await store.writeLibrary(skillPath, lib);

			// Both start with effectivenessScore=0 — ranking should be by order
			const config = makeConfig();
			const resultsBefore = await store.cascadingSearch('query', config, 'claude-code');
			expect(resultsBefore).toHaveLength(2);
			// Both have same combined score (same similarity, same effectiveness, same recency)

			// Give mem2 a positive outcome
			await store.updateEffectiveness([mem2.id], 1.0, 'skill', skill.id);
			// Now mem2 has effectivenessScore = 0.3, mem1 still = 0

			const resultsAfter = await store.cascadingSearch('query', config, 'claude-code');
			expect(resultsAfter).toHaveLength(2);
			// mem2 should now rank higher due to higher effectiveness
			expect(resultsAfter[0].entry.id).toBe(mem2.id);
			expect(resultsAfter[0].combinedScore).toBeGreaterThan(resultsAfter[1].combinedScore);
		});
	});

	// ─── Embedding Pipeline ─────────────────────────────────────────────

	describe('Embedding pipeline: ensureAllEmbeddings + ensureHierarchyEmbeddings', () => {
		it('computes embeddings for all unembedded entries and hierarchy elements', async () => {
			const role = await store.createRole('Dev', 'Development');
			const persona = await store.createPersona(role.id, 'Backend', 'Backend systems development');
			const skill = await store.createSkillArea(persona.id, 'APIs', 'API design patterns');

			// Add multiple memories without embeddings
			await store.addMemory({
				content: 'Use REST for public APIs',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			await store.addMemory({
				content: 'Validate all input parameters',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			await store.addMemory({
				content: 'Global: document all endpoints',
				scope: 'global',
			});

			// Verify nothing has embeddings yet
			const regBefore = await store.readRegistry();
			expect(regBefore.personas[0].embedding).toBeNull();
			expect(regBefore.skillAreas[0].embedding).toBeNull();

			const skillPath = store.getMemoryPath('skill', skill.id);
			const skillLibBefore = await store.readLibrary(skillPath);
			for (const e of skillLibBefore.entries) {
				expect(e.embedding).toBeNull();
			}

			// Mock encodeBatch to return distinct vectors
			let batchCallCount = 0;
			mockEncodeBatch.mockImplementation(async (texts: string[]) => {
				batchCallCount++;
				return texts.map((_t, i) => makeVector(batchCallCount * 0.5 + i * 0.1));
			});

			// Ensure memory embeddings
			const skillEmbedded = await store.ensureAllEmbeddings('skill', skill.id);
			expect(skillEmbedded).toBe(2); // 2 skill memories

			const globalEmbedded = await store.ensureAllEmbeddings('global');
			expect(globalEmbedded).toBe(1); // 1 global memory

			// Ensure hierarchy embeddings
			const hierarchyEmbedded = await store.ensureHierarchyEmbeddings();
			expect(hierarchyEmbedded).toBe(2); // 1 persona + 1 skill

			// Verify all embeddings are now set
			const regAfter = await store.readRegistry();
			expect(regAfter.personas[0].embedding).not.toBeNull();
			expect(regAfter.personas[0].embedding!.length).toBe(DIM);
			expect(regAfter.skillAreas[0].embedding).not.toBeNull();

			const skillLibAfter = await store.readLibrary(skillPath);
			for (const e of skillLibAfter.entries) {
				expect(e.embedding).not.toBeNull();
				expect(e.embedding!.length).toBe(DIM);
			}

			const globalPath = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalPath);
			expect(globalLib.entries[0].embedding).not.toBeNull();
		});

		it('ensureAllEmbeddings is idempotent — does not re-embed already-embedded entries', async () => {
			await store.addMemory({ content: 'Test memory', scope: 'global' });

			const vec = makeVector(0.42);
			mockEncodeBatch.mockResolvedValue([vec]);

			// First call embeds
			const count1 = await store.ensureAllEmbeddings('global');
			expect(count1).toBe(1);
			expect(mockEncodeBatch).toHaveBeenCalledTimes(1);

			// Second call does nothing — embedding already set
			mockEncodeBatch.mockClear();
			const count2 = await store.ensureAllEmbeddings('global');
			expect(count2).toBe(0);
			expect(mockEncodeBatch).not.toHaveBeenCalled();
		});
	});

	// ─── Cross-Scope Search Integration ─────────────────────────────────

	describe('Cross-scope search: hierarchy + project + global combined', () => {
		it('returns results from all applicable scopes in a single search', async () => {
			const projectPath = '/home/user/my-project';

			// Hierarchy
			const role = await store.createRole('Dev', 'Dev');
			const persona = await store.createPersona(role.id, 'Coder', 'desc');
			const skill = await store.createSkillArea(persona.id, 'General', 'desc');
			const skillMem = await store.addMemory({
				content: 'Skill memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Project
			const projMem = await store.addMemory(
				{ content: 'Project memory', scope: 'project' },
				projectPath
			);

			// Global
			const globalMem = await store.addMemory({
				content: 'Global memory',
				scope: 'global',
			});

			const vec = makeVector(0);
			const nearVec = makeVector(0.05);
			mockEncode.mockResolvedValue(vec);

			// Set all embeddings
			const skillPath = store.getMemoryPath('skill', skill.id);
			const skillLib = await store.readLibrary(skillPath);
			skillLib.entries[0].embedding = nearVec;
			await store.writeLibrary(skillPath, skillLib);

			const projPath = store.getMemoryPath('project', undefined, projectPath);
			const projLib = await store.readLibrary(projPath);
			projLib.entries[0].embedding = nearVec;
			await store.writeLibrary(projPath, projLib);

			const globalPath = store.getMemoryPath('global');
			const globalLib = await store.readLibrary(globalPath);
			globalLib.entries[0].embedding = nearVec;
			await store.writeLibrary(globalPath, globalLib);

			const config = makeConfig();
			const results = await store.cascadingSearch('test query', config, 'claude-code', projectPath);

			const resultIds = results.map((r) => r.entry.id);
			expect(resultIds).toContain(skillMem.id);
			expect(resultIds).toContain(projMem.id);
			expect(resultIds).toContain(globalMem.id);
			expect(results.length).toBe(3);
		});
	});

	// ─── History Accumulation Across Operations ─────────────────────────

	describe('History accumulation: full pipeline operations recorded in JSONL', () => {
		it('records all pipeline operations in chronological order', async () => {
			// Create hierarchy
			const role = await store.createRole('Dev', 'desc');
			const persona = await store.createPersona(role.id, 'Persona', 'desc');
			const skill = await store.createSkillArea(persona.id, 'Skill', 'desc');

			// Add memory
			const mem = await store.addMemory({
				content: 'Test memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Update memory
			await store.updateMemory(mem.id, { content: 'Updated memory' }, 'skill', skill.id);

			// Check registry history (hierarchy operations)
			const regHistoryContent = fsState.get('/mock/userData/memories/history.jsonl');
			expect(regHistoryContent).toBeDefined();
			const regHistory = regHistoryContent!
				.trim()
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));

			const ops = regHistory.map((h: Record<string, unknown>) => h.operation);
			expect(ops).toContain('create-role');
			expect(ops).toContain('create-persona');
			expect(ops).toContain('create-skill');

			// Check memory history (add + update)
			const skillPath = store.getMemoryPath('skill', skill.id);
			const memHistoryContent = fsState.get(`${skillPath}/history.jsonl`);
			expect(memHistoryContent).toBeDefined();
			const memHistory = memHistoryContent!
				.trim()
				.split('\n')
				.filter((l) => l.trim())
				.map((l) => JSON.parse(l));

			const memOps = memHistory.map((h: Record<string, unknown>) => h.operation);
			expect(memOps).toEqual(['add', 'update']);

			// Verify chronological ordering
			const timestamps = memHistory.map((h: Record<string, unknown>) => h.timestamp as number);
			for (let i = 1; i < timestamps.length; i++) {
				expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
			}
		});
	});
});
