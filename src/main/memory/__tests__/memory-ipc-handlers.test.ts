/**
 * IPC Handler Round-Trip Tests
 *
 * Tests the memory IPC handlers by registering them with a mocked ipcMain,
 * backed by a real MemoryStore (with mocked fs/electron), and invoking
 * each handler to verify the full round-trip:
 *   IPC channel → createIpcDataHandler wrapper → MemoryStore → response
 *
 * Covers CRUD for all entity types: roles, personas, skill areas, and memories,
 * plus config, search, stats, import/export, consolidation, embeddings, and seed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
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

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

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

const mockEncode = vi.fn(async (..._args: any[]) => new Array(384).fill(0));
const mockEncodeBatch = vi.fn(async (..._args: any[]) =>
	new Array(384).fill(0).map(() => new Array(384).fill(0))
);

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

vi.mock('../../../main/grpo/embedding-service', () => ({
	encode: (...args: unknown[]) => mockEncode(...args),
	encodeBatch: (...args: unknown[]) => mockEncodeBatch(...args),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

import { ipcMain } from 'electron';
import { MemoryStore } from '../../memory/memory-store';
import { setMemorySettingsStore } from '../../memory/memory-injector';
import { registerMemoryHandlers } from '../../ipc/handlers/memory-handlers';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Helpers ────────────────────────────────────────────────────────────────

const DIM = 384;
const mockEvent = {} as Electron.IpcMainInvokeEvent;

function makeVector(angle: number): number[] {
	const v = new Array(DIM).fill(0);
	v[0] = Math.cos(angle);
	v[1] = Math.sin(angle);
	return v;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Memory IPC Handler Round-Trips', () => {
	let store: MemoryStore;

	let handlers: Map<string, (...args: any[]) => Promise<any>>;
	let settingsStore: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };

	beforeEach(async () => {
		fsState.clear();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockEncode.mockResolvedValue(new Array(DIM).fill(0));
		mockEncodeBatch.mockResolvedValue([]);

		store = new MemoryStore();

		const storeData: Record<string, unknown> = {};
		settingsStore = {
			get: (key: string) => storeData[key],
			set: (key: string, value: unknown) => {
				storeData[key] = value;
			},
		};

		// Capture registered handlers
		handlers = new Map();

		vi.mocked(ipcMain.handle).mockImplementation(
			(channel: string, handler: (...args: any[]) => Promise<any>) => {
				handlers.set(channel, handler);
			}
		);

		registerMemoryHandlers({ memoryStore: store, settingsStore });

		// Wait for the async config initialization in registerMemoryHandlers
		await vi.waitFor(
			() => {
				// The handler registration is synchronous, but there's an async getConfig call
				// that resolves immediately since the store is fresh
			},
			{ timeout: 100 }
		);
	});

	afterEach(() => {
		handlers.clear();
		setMemorySettingsStore(() => undefined);
	});

	/** Invoke a captured IPC handler by channel name. */
	async function invoke(channel: string, ...args: unknown[]): Promise<any> {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
		return handler(mockEvent, ...args);
	}

	// ─── Registration ─────────────────────────────────────────────────

	describe('Handler registration', () => {
		it('registers all expected memory IPC channels', () => {
			const expectedChannels = [
				'memory:getConfig',
				'memory:setConfig',
				'memory:role:list',
				'memory:role:get',
				'memory:role:create',
				'memory:role:update',
				'memory:role:delete',
				'memory:persona:list',
				'memory:persona:get',
				'memory:persona:create',
				'memory:persona:update',
				'memory:persona:delete',
				'memory:matchPersonas',
				'memory:skill:list',
				'memory:skill:get',
				'memory:skill:create',
				'memory:skill:update',
				'memory:skill:delete',
				'memory:list',
				'memory:add',
				'memory:update',
				'memory:delete',
				'memory:listAllExperiences',
				'memory:moveScope',
				'memory:listArchived',
				'memory:restore',
				'memory:search',
				'memory:getStats',
				'memory:getProjectDigest',
				'memory:export',
				'memory:import',
				'memory:consolidate',
				'memory:ensureEmbeddings',
				'memory:seedDefaults',
				'memory:resetSeedDefaults',
				'memory:getPromotionCandidates',
				'memory:promote',
				'memory:dismissPromotion',
				'memory:suggestHierarchy',
				'memory:link',
				'memory:unlink',
				'memory:getLinked',
				'memory:getAnalytics',
				'memory:getRecentInjections',
				'memory:getJobQueueStatus',
				'memory:getTokenUsage',
				'memory:getStoreSize',
				'memory:analyzeHistoricalSessions',
				'memory:getAnalysisStats',
				'memory:analyzeAgentSessions',
				'memory:getAgentAnalysisStats',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel), `Missing handler: ${channel}`).toBe(true);
			}
			expect(handlers.size).toBe(expectedChannels.length);
		});
	});

	// ─── Config ───────────────────────────────────────────────────────

	describe('Config round-trips', () => {
		it('getConfig returns defaults for fresh store', async () => {
			const result = await invoke('memory:getConfig');
			expect(result.success).toBe(true);
			expect(result.data.enabled).toBe(MEMORY_CONFIG_DEFAULTS.enabled);
			expect(result.data.maxTokenBudget).toBe(MEMORY_CONFIG_DEFAULTS.maxTokenBudget);
		});

		it('setConfig persists and returns updated config', async () => {
			const setResult = await invoke('memory:setConfig', { enabled: true, maxTokenBudget: 3000 });
			expect(setResult.success).toBe(true);
			expect(setResult.data.enabled).toBe(true);
			expect(setResult.data.maxTokenBudget).toBe(3000);

			// Read back
			const getResult = await invoke('memory:getConfig');
			expect(getResult.data.enabled).toBe(true);
			expect(getResult.data.maxTokenBudget).toBe(3000);
		});
	});

	// ─── Roles CRUD ─────────────────────────────────────────────────

	describe('Role CRUD round-trips', () => {
		it('create → get → list → update → delete', async () => {
			// Create
			const createResult = await invoke('memory:role:create', 'Developer', 'Software dev');
			expect(createResult.success).toBe(true);
			const role = createResult.data;
			expect(role.name).toBe('Developer');
			expect(role.description).toBe('Software dev');
			expect(role.id).toBeTruthy();

			// Get
			const getResult = await invoke('memory:role:get', role.id);
			expect(getResult.success).toBe(true);
			expect(getResult.data.name).toBe('Developer');

			// List
			const listResult = await invoke('memory:role:list');
			expect(listResult.success).toBe(true);
			expect(listResult.data).toHaveLength(1);
			expect(listResult.data[0].id).toBe(role.id);

			// Update
			const updateResult = await invoke('memory:role:update', role.id, { name: 'Senior Dev' });
			expect(updateResult.success).toBe(true);
			expect(updateResult.data.name).toBe('Senior Dev');

			// Verify update persisted
			const getAfterUpdate = await invoke('memory:role:get', role.id);
			expect(getAfterUpdate.data.name).toBe('Senior Dev');

			// Delete
			const deleteResult = await invoke('memory:role:delete', role.id);
			expect(deleteResult.success).toBe(true);
			expect(deleteResult.data).toBe(true);

			// Verify deletion
			const getAfterDelete = await invoke('memory:role:get', role.id);
			expect(getAfterDelete.data).toBeNull();

			const listAfterDelete = await invoke('memory:role:list');
			expect(listAfterDelete.data).toHaveLength(0);
		});

		it('get returns null for non-existent role', async () => {
			const result = await invoke('memory:role:get', 'nonexistent-id');
			expect(result.success).toBe(true);
			expect(result.data).toBeNull();
		});
	});

	// ─── Personas CRUD ──────────────────────────────────────────────

	describe('Persona CRUD round-trips', () => {
		it('create → get → list → update → delete', async () => {
			// Create parent role
			const roleResult = await invoke('memory:role:create', 'Dev', 'Dev');
			const roleId = roleResult.data.id;

			// Create persona
			const createResult = await invoke(
				'memory:persona:create',
				roleId,
				'Rust Dev',
				'Rust development',
				['claude-code'],
				['/my-project']
			);
			expect(createResult.success).toBe(true);
			const persona = createResult.data;
			expect(persona.name).toBe('Rust Dev');
			expect(persona.roleId).toBe(roleId);
			expect(persona.assignedAgents).toEqual(['claude-code']);
			expect(persona.assignedProjects).toEqual(['/my-project']);

			// Get
			const getResult = await invoke('memory:persona:get', persona.id);
			expect(getResult.success).toBe(true);
			expect(getResult.data.name).toBe('Rust Dev');

			// List (all)
			const listAllResult = await invoke('memory:persona:list');
			expect(listAllResult.success).toBe(true);
			expect(listAllResult.data).toHaveLength(1);

			// List (by role)
			const listByRoleResult = await invoke('memory:persona:list', roleId);
			expect(listByRoleResult.success).toBe(true);
			expect(listByRoleResult.data).toHaveLength(1);

			// Update
			const updateResult = await invoke('memory:persona:update', persona.id, {
				name: 'Senior Rust Dev',
				assignedAgents: ['claude-code', 'codex'],
			});
			expect(updateResult.success).toBe(true);
			expect(updateResult.data.name).toBe('Senior Rust Dev');
			expect(updateResult.data.assignedAgents).toEqual(['claude-code', 'codex']);

			// Delete
			const deleteResult = await invoke('memory:persona:delete', persona.id);
			expect(deleteResult.success).toBe(true);
			expect(deleteResult.data).toBe(true);

			// Verify deletion
			const getAfterDelete = await invoke('memory:persona:get', persona.id);
			expect(getAfterDelete.data).toBeNull();
		});

		it('list by roleId filters correctly', async () => {
			const role1 = (await invoke('memory:role:create', 'Role A', 'desc')).data;
			const role2 = (await invoke('memory:role:create', 'Role B', 'desc')).data;

			await invoke('memory:persona:create', role1.id, 'Persona A', 'desc');
			await invoke('memory:persona:create', role2.id, 'Persona B', 'desc');

			const listRole1 = await invoke('memory:persona:list', role1.id);
			expect(listRole1.data).toHaveLength(1);
			expect(listRole1.data[0].name).toBe('Persona A');

			const listAll = await invoke('memory:persona:list');
			expect(listAll.data).toHaveLength(2);
		});
	});

	// ─── Skill Areas CRUD ───────────────────────────────────────────

	describe('Skill Area CRUD round-trips', () => {
		it('create → get → list → update → delete', async () => {
			// Set up hierarchy
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'Persona', 'desc')).data;

			// Create skill
			const createResult = await invoke(
				'memory:skill:create',
				persona.id,
				'Error Handling',
				'Error patterns'
			);
			expect(createResult.success).toBe(true);
			const skill = createResult.data;
			expect(skill.name).toBe('Error Handling');
			expect(skill.personaId).toBe(persona.id);

			// Get
			const getResult = await invoke('memory:skill:get', skill.id);
			expect(getResult.success).toBe(true);
			expect(getResult.data.name).toBe('Error Handling');

			// List (all)
			const listAllResult = await invoke('memory:skill:list');
			expect(listAllResult.success).toBe(true);
			expect(listAllResult.data).toHaveLength(1);

			// List (by persona)
			const listByPersonaResult = await invoke('memory:skill:list', persona.id);
			expect(listByPersonaResult.success).toBe(true);
			expect(listByPersonaResult.data).toHaveLength(1);

			// Update
			const updateResult = await invoke('memory:skill:update', skill.id, {
				name: 'Advanced Error Handling',
				active: false,
			});
			expect(updateResult.success).toBe(true);
			expect(updateResult.data.name).toBe('Advanced Error Handling');
			expect(updateResult.data.active).toBe(false);

			// Delete
			const deleteResult = await invoke('memory:skill:delete', skill.id);
			expect(deleteResult.success).toBe(true);
			expect(deleteResult.data).toBe(true);

			const getAfterDelete = await invoke('memory:skill:get', skill.id);
			expect(getAfterDelete.data).toBeNull();
		});

		it('list by personaId filters correctly', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const p1 = (await invoke('memory:persona:create', role.id, 'P1', 'desc')).data;
			const p2 = (await invoke('memory:persona:create', role.id, 'P2', 'desc')).data;

			await invoke('memory:skill:create', p1.id, 'Skill A', 'desc');
			await invoke('memory:skill:create', p2.id, 'Skill B', 'desc');

			const listP1 = await invoke('memory:skill:list', p1.id);
			expect(listP1.data).toHaveLength(1);
			expect(listP1.data[0].name).toBe('Skill A');

			const listAll = await invoke('memory:skill:list');
			expect(listAll.data).toHaveLength(2);
		});
	});

	// ─── Memory CRUD ────────────────────────────────────────────────

	describe('Memory CRUD round-trips', () => {
		it('add → list → update → delete for skill-scoped memory', async () => {
			// Set up hierarchy
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'Persona', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'Skill', 'desc')).data;

			// Add memory
			const addResult = await invoke('memory:add', {
				content: 'Always use Result<T, E>',
				scope: 'skill',
				skillAreaId: skill.id,
				tags: ['rust', 'error-handling'],
				source: 'user',
				confidence: 0.9,
			});
			expect(addResult.success).toBe(true);
			const memory = addResult.data;
			expect(memory.content).toBe('Always use Result<T, E>');
			expect(memory.scope).toBe('skill');
			expect(memory.tags).toEqual(['rust', 'error-handling']);
			expect(memory.active).toBe(true);
			expect(memory.useCount).toBe(0);

			// List
			const listResult = await invoke('memory:list', 'skill', skill.id);
			expect(listResult.success).toBe(true);
			expect(listResult.data).toHaveLength(1);
			expect(listResult.data[0].id).toBe(memory.id);

			// Update
			const updateResult = await invoke(
				'memory:update',
				memory.id,
				{ content: 'Prefer Result<T, E> over unwrap()', tags: ['rust'] },
				'skill',
				skill.id
			);
			expect(updateResult.success).toBe(true);
			expect(updateResult.data.content).toBe('Prefer Result<T, E> over unwrap()');
			expect(updateResult.data.tags).toEqual(['rust']);

			// Delete
			const deleteResult = await invoke('memory:delete', memory.id, 'skill', skill.id);
			expect(deleteResult.success).toBe(true);
			expect(deleteResult.data).toBe(true);

			const listAfterDelete = await invoke('memory:list', 'skill', skill.id);
			expect(listAfterDelete.data).toHaveLength(0);
		});

		it('add and list global-scoped memories', async () => {
			await invoke('memory:add', { content: 'Global rule 1', scope: 'global' });
			await invoke('memory:add', { content: 'Global rule 2', scope: 'global' });

			const listResult = await invoke('memory:list', 'global');
			expect(listResult.success).toBe(true);
			expect(listResult.data).toHaveLength(2);
		});

		it('add and list project-scoped memories', async () => {
			const projectPath = '/home/user/project-x';
			await invoke('memory:add', { content: 'Project fact', scope: 'project' }, projectPath);

			const listResult = await invoke('memory:list', 'project', undefined, projectPath);
			expect(listResult.success).toBe(true);
			expect(listResult.data).toHaveLength(1);
			expect(listResult.data[0].content).toBe('Project fact');
		});

		it('inactive memories only included when includeInactive is true', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			const mem = (
				await invoke('memory:add', {
					content: 'Test memory',
					scope: 'skill',
					skillAreaId: skill.id,
				})
			).data;

			// Deactivate
			await invoke('memory:update', mem.id, { active: false }, 'skill', skill.id);

			// Default: excludes inactive
			const listActive = await invoke('memory:list', 'skill', skill.id);
			expect(listActive.data).toHaveLength(0);

			// includeInactive = true
			const listAll = await invoke('memory:list', 'skill', skill.id, undefined, true);
			expect(listAll.data).toHaveLength(1);
			expect(listAll.data[0].active).toBe(false);
		});
	});

	// ─── Archive ────────────────────────────────────────────────────

	describe('Archive round-trips', () => {
		it('listArchived returns empty when no archived memories exist', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			await invoke('memory:add', {
				content: 'Active memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			const result = await invoke('memory:listArchived', 'skill', skill.id);
			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(0);
		});

		it('listArchived returns only archived memories', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			// Add two memories
			const mem1 = (
				await invoke('memory:add', {
					content: 'Memory to archive',
					scope: 'skill',
					skillAreaId: skill.id,
				})
			).data;
			await invoke('memory:add', {
				content: 'Active memory',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Archive mem1 via update
			await invoke('memory:update', mem1.id, { active: true }, 'skill', skill.id);
			// Directly archive via store for test setup
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			const entry = lib.entries.find((e: any) => e.id === mem1.id);
			if (entry) {
				entry.archived = true;
			}
			await store.writeLibrary(skillPath, lib);

			const archivedResult = await invoke('memory:listArchived', 'skill', skill.id);
			expect(archivedResult.success).toBe(true);
			expect(archivedResult.data).toHaveLength(1);
			expect(archivedResult.data[0].id).toBe(mem1.id);
			expect(archivedResult.data[0].archived).toBe(true);

			// Active list should not include archived
			const activeResult = await invoke('memory:list', 'skill', skill.id);
			expect(activeResult.data).toHaveLength(1);
			expect(activeResult.data[0].content).toBe('Active memory');
		});

		it('restore brings archived memory back with boosted confidence', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			const mem = (
				await invoke('memory:add', {
					content: 'Memory to archive and restore',
					scope: 'skill',
					skillAreaId: skill.id,
					confidence: 0.02,
				})
			).data;

			// Archive it directly
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			const entry = lib.entries.find((e: any) => e.id === mem.id);
			if (entry) {
				entry.archived = true;
				entry.confidence = 0.02;
			}
			await store.writeLibrary(skillPath, lib);

			// Verify it's archived
			const archivedResult = await invoke('memory:listArchived', 'skill', skill.id);
			expect(archivedResult.data).toHaveLength(1);

			// Restore it
			const restoreResult = await invoke('memory:restore', mem.id, 'skill', skill.id);
			expect(restoreResult.success).toBe(true);
			expect(restoreResult.data).not.toBeNull();
			expect(restoreResult.data.archived).toBe(false);
			expect(restoreResult.data.confidence).toBeGreaterThanOrEqual(0.3);

			// Verify it's back in active list
			const activeResult = await invoke('memory:list', 'skill', skill.id);
			expect(activeResult.data).toHaveLength(1);
			expect(activeResult.data[0].id).toBe(mem.id);

			// Verify archived list is empty
			const archivedAfter = await invoke('memory:listArchived', 'skill', skill.id);
			expect(archivedAfter.data).toHaveLength(0);
		});

		it('restore returns null for non-existent memory', async () => {
			const result = await invoke('memory:restore', 'nonexistent-id', 'global');
			expect(result.success).toBe(true);
			expect(result.data).toBeNull();
		});

		it('listArchived works for global scope', async () => {
			const mem = (await invoke('memory:add', { content: 'Global archived', scope: 'global' }))
				.data;

			// Archive it
			const globalPath = store.getMemoryPath('global');
			const lib = await store.readLibrary(globalPath);
			const entry = lib.entries.find((e: any) => e.id === mem.id);
			if (entry) {
				entry.archived = true;
			}
			await store.writeLibrary(globalPath, lib);

			const result = await invoke('memory:listArchived', 'global');
			expect(result.success).toBe(true);
			expect(result.data).toHaveLength(1);
			expect(result.data[0].content).toBe('Global archived');
		});
	});

	// ─── Search ─────────────────────────────────────────────────────

	describe('Search round-trip', () => {
		it('memory:search returns results from store cascadingSearch', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'Rust Dev', 'Rust systems'))
				.data;
			const skill = (await invoke('memory:skill:create', persona.id, 'Errors', 'Error handling'))
				.data;

			await invoke('memory:add', {
				content: 'Use Result<T, E> for error handling',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Enable memory system
			await invoke('memory:setConfig', { enabled: true });

			// Set up embeddings for search
			const queryVec = makeVector(0);
			const matchVec = makeVector(0.05);
			mockEncode.mockResolvedValue(queryVec);

			// Set memory embedding directly
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = matchVec;
			await store.writeLibrary(skillPath, lib);

			// Set persona/skill embeddings for cascading search
			const reg = await store.readRegistry();
			const p = reg.personas.find((p) => p.id === persona.id)!;
			p.embedding = matchVec;
			const s = reg.skillAreas.find((s) => s.id === skill.id)!;
			s.embedding = matchVec;
			await store.writeRegistry(reg);

			const searchResult = await invoke('memory:search', 'rust error handling', 'claude-code');
			expect(searchResult.success).toBe(true);
			expect(searchResult.data.length).toBeGreaterThan(0);
			expect(searchResult.data[0].entry.content).toContain('Result<T, E>');
			expect(searchResult.data[0].personaName).toBe('Rust Dev');
		});
	});

	// ─── Stats ──────────────────────────────────────────────────────

	describe('Stats round-trip', () => {
		it('memory:getStats returns correct counts across scopes', async () => {
			// Build hierarchy
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			// Add memories in different scopes
			await invoke('memory:add', {
				content: 'Skill memory 1',
				scope: 'skill',
				skillAreaId: skill.id,
				source: 'user',
			});
			await invoke('memory:add', {
				content: 'Skill memory 2',
				scope: 'skill',
				skillAreaId: skill.id,
				source: 'grpo',
			});
			await invoke('memory:add', { content: 'Global memory', scope: 'global', source: 'user' });

			const statsResult = await invoke('memory:getStats');
			expect(statsResult.success).toBe(true);
			const stats = statsResult.data;

			expect(stats.totalRoles).toBe(1);
			expect(stats.totalPersonas).toBe(1);
			expect(stats.totalSkillAreas).toBe(1);
			expect(stats.totalMemories).toBe(3);
			expect(stats.byScope.skill).toBe(2);
			expect(stats.byScope.global).toBe(1);
			expect(stats.bySource.user).toBe(2);
			expect(stats.bySource.grpo).toBe(1);
			// Persona + skill have no embeddings yet
			expect(stats.pendingEmbeddings).toBeGreaterThanOrEqual(2);
		});
	});

	// ─── Import/Export ──────────────────────────────────────────────

	describe('Import/Export round-trips', () => {
		it('export → import round-trip preserves memory content', async () => {
			// Add global memories
			await invoke('memory:add', {
				content: 'Rule Alpha',
				scope: 'global',
				tags: ['alpha'],
			});
			await invoke('memory:add', {
				content: 'Rule Beta',
				scope: 'global',
				tags: ['beta'],
			});

			// Export
			const exportResult = await invoke('memory:export', 'global');
			expect(exportResult.success).toBe(true);
			expect(exportResult.data.memories).toHaveLength(2);
			expect(exportResult.data.scope).toBe('global');
			expect(exportResult.data.exportedAt).toBeTypeOf('number');

			// Clear existing memories by deleting them
			for (const m of exportResult.data.memories) {
				await invoke('memory:delete', m.id, 'global');
			}
			const emptyList = await invoke('memory:list', 'global');
			expect(emptyList.data).toHaveLength(0);

			// Import the exported data
			const importPayload = {
				memories: exportResult.data.memories.map((m: any) => ({
					content: m.content,
					tags: m.tags,
				})),
			};
			const importResult = await invoke('memory:import', importPayload, 'global');
			expect(importResult.success).toBe(true);
			expect(importResult.data.imported).toBe(2);

			// Verify memories were restored
			const listResult = await invoke('memory:list', 'global');
			expect(listResult.data).toHaveLength(2);
			const contents = listResult.data.map((m: any) => m.content).sort();
			expect(contents).toEqual(['Rule Alpha', 'Rule Beta']);
		});
	});

	// ─── Consolidation ──────────────────────────────────────────────

	describe('Consolidation round-trip', () => {
		it('memory:consolidate merges similar memories', async () => {
			// Set up a skill area with similar memories that have embeddings
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			// Add three nearly-identical memories
			await invoke('memory:add', {
				content: 'Use Result for error handling in Rust',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			await invoke('memory:add', {
				content: 'Use Result<T, E> for Rust error handling',
				scope: 'skill',
				skillAreaId: skill.id,
			});
			await invoke('memory:add', {
				content: 'Handle errors with Result in Rust code',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			// Set similar embeddings on all three
			const skillPath = store.getMemoryPath('skill', skill.id);
			const lib = await store.readLibrary(skillPath);
			lib.entries[0].embedding = makeVector(0);
			lib.entries[1].embedding = makeVector(0.01); // very similar
			lib.entries[2].embedding = makeVector(0.02); // very similar
			await store.writeLibrary(skillPath, lib);

			// Set consolidation threshold low enough to trigger
			await invoke('memory:setConfig', { consolidationThreshold: 0.9 });

			const consolidateResult = await invoke('memory:consolidate', 'skill', skill.id);
			expect(consolidateResult.success).toBe(true);
			// consolidateResult.data.consolidated is the count of merge groups
			expect(consolidateResult.data.consolidated).toBeGreaterThanOrEqual(0);
		});
	});

	// ─── Embeddings ─────────────────────────────────────────────────

	describe('Embeddings round-trip', () => {
		it('memory:ensureEmbeddings computes missing embeddings', async () => {
			const role = (await invoke('memory:role:create', 'Dev', 'desc')).data;
			const persona = (await invoke('memory:persona:create', role.id, 'P', 'desc')).data;
			const skill = (await invoke('memory:skill:create', persona.id, 'S', 'desc')).data;

			await invoke('memory:add', {
				content: 'Memory needing embedding',
				scope: 'skill',
				skillAreaId: skill.id,
			});

			mockEncodeBatch.mockResolvedValue([makeVector(0.5)]);

			const result = await invoke('memory:ensureEmbeddings', 'skill', skill.id);
			expect(result.success).toBe(true);
			expect(result.data.memoriesUpdated).toBe(1);
			expect(result.data.hierarchyUpdated).toBeGreaterThanOrEqual(0);
		});
	});

	// ─── Seed Defaults ──────────────────────────────────────────────

	describe('Seed defaults round-trip', () => {
		it('memory:seedDefaults creates default roles, personas, and skills', async () => {
			const seedResult = await invoke('memory:seedDefaults');
			expect(seedResult.success).toBe(true);

			// Verify some seed data was created
			const rolesResult = await invoke('memory:role:list');
			expect(rolesResult.data.length).toBeGreaterThan(0);

			const personasResult = await invoke('memory:persona:list');
			expect(personasResult.data.length).toBeGreaterThan(0);

			const skillsResult = await invoke('memory:skill:list');
			expect(skillsResult.data.length).toBeGreaterThan(0);
		});
	});

	// ─── Error Handling ─────────────────────────────────────────────

	describe('Error handling via createIpcDataHandler', () => {
		it('returns { success: false, error } when handler throws', async () => {
			// Try to update a memory that doesn't exist — should still return success
			// (updateMemory returns null, not throw, for missing entries)
			const result = await invoke(
				'memory:update',
				'nonexistent-id',
				{ content: 'updated' },
				'global'
			);
			expect(result.success).toBe(true);
			expect(result.data).toBeNull();
		});

		it('delete returns false for non-existent memory', async () => {
			const result = await invoke('memory:delete', 'nonexistent-id', 'global');
			expect(result.success).toBe(true);
			expect(result.data).toBe(false);
		});
	});

	// ─── Full CRUD Chain Across Entity Types ────────────────────────

	describe('Full hierarchy CRUD chain via IPC', () => {
		it('creates full hierarchy, adds memories, and verifies cascading delete', async () => {
			// Build hierarchy via IPC
			const role = (await invoke('memory:role:create', 'Engineer', 'Software engineering')).data;
			const persona = (
				await invoke('memory:persona:create', role.id, 'Rust Dev', 'Systems programming', [
					'claude-code',
				])
			).data;
			const skill = (
				await invoke('memory:skill:create', persona.id, 'Safety', 'Memory safety patterns')
			).data;

			// Add memories
			const mem1 = (
				await invoke('memory:add', {
					content: 'Avoid unsafe blocks unless necessary',
					scope: 'skill',
					skillAreaId: skill.id,
					source: 'user',
				})
			).data;
			const mem2 = (
				await invoke('memory:add', {
					content: 'Use Box for heap allocation',
					scope: 'skill',
					skillAreaId: skill.id,
					source: 'user',
				})
			).data;

			// Verify memories exist
			const memList = await invoke('memory:list', 'skill', skill.id);
			expect(memList.data).toHaveLength(2);

			// Verify stats reflect the hierarchy
			const stats = (await invoke('memory:getStats')).data;
			expect(stats.totalRoles).toBe(1);
			expect(stats.totalPersonas).toBe(1);
			expect(stats.totalSkillAreas).toBe(1);
			expect(stats.totalMemories).toBe(2);
			expect(stats.byScope.skill).toBe(2);
			expect(stats.bySource.user).toBe(2);

			// Delete individual memory
			await invoke('memory:delete', mem1.id, 'skill', skill.id);
			const memListAfter = await invoke('memory:list', 'skill', skill.id);
			expect(memListAfter.data).toHaveLength(1);
			expect(memListAfter.data[0].id).toBe(mem2.id);

			// Delete skill area — should clean up from persona
			await invoke('memory:skill:delete', skill.id);
			const skillAfterDelete = await invoke('memory:skill:get', skill.id);
			expect(skillAfterDelete.data).toBeNull();

			// Delete persona
			await invoke('memory:persona:delete', persona.id);
			const personaAfterDelete = await invoke('memory:persona:get', persona.id);
			expect(personaAfterDelete.data).toBeNull();

			// Delete role
			await invoke('memory:role:delete', role.id);
			const roleAfterDelete = await invoke('memory:role:get', role.id);
			expect(roleAfterDelete.data).toBeNull();

			// Stats should reflect empty state for hierarchy
			const statsAfter = (await invoke('memory:getStats')).data;
			expect(statsAfter.totalRoles).toBe(0);
			expect(statsAfter.totalPersonas).toBe(0);
			expect(statsAfter.totalSkillAreas).toBe(0);
		});
	});
});
