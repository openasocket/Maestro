/**
 * MemoryStore — hierarchical file-backed memory library.
 *
 * Storage layout:
 *   <configDir>/memories/registry.json          (roles, personas, skill areas)
 *   <configDir>/memories/config.json             (MemoryConfig)
 *   <configDir>/memories/history.jsonl            (audit trail for hierarchy changes)
 *   <configDir>/memories/skills/<skillAreaId>/library.json    (memories in a skill area)
 *   <configDir>/memories/skills/<skillAreaId>/history.jsonl
 *   <configDir>/memories/project/<projectHash>/library.json   (project-scoped memories)
 *   <configDir>/memories/project/<projectHash>/history.jsonl
 *   <configDir>/memories/global/library.json      (global memories)
 *   <configDir>/memories/global/history.jsonl
 *
 * The registry.json contains all Role[], Persona[], SkillArea[] objects.
 * Memory entries are stored in separate library files per skill/project/global scope.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import Store from 'electron-store';
import type {
	Role,
	RoleId,
	Persona,
	PersonaId,
	SkillArea,
	SkillAreaId,
	MemoryEntry,
	MemoryId,
	MemoryType,
	MemoryScope,
	MemorySource,
	MemoryConfig,
	MemoryHistoryEntry,
	ExperienceContext,
	MemorySearchResult,
} from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS, SEED_ROLES } from '../../shared/memory-types';
import { cosineSimilarity } from '../grpo/embedding-service';

// ─── File Interfaces ──────────────────────────────────────────────────────────

interface RegistryFile {
	version: number;
	roles: Role[];
	personas: Persona[];
	skillAreas: SkillArea[];
}

interface LibraryFile {
	version: number;
	entries: MemoryEntry[];
}

// ─── Bootstrap Store ──────────────────────────────────────────────────────────

interface BootstrapSettings {
	customSyncPath?: string;
}

const bootstrapStore = new Store<BootstrapSettings>({
	name: 'maestro-bootstrap',
	defaults: {},
});

function getConfigDir(): string {
	const customPath = bootstrapStore.get('customSyncPath');
	return customPath || app.getPath('userData');
}

// ─── MemoryStore ──────────────────────────────────────────────────────────────

export class MemoryStore {
	private readonly memoriesDir: string;
	private readonly writeQueues = new Map<string, Promise<void>>();

	constructor() {
		this.memoriesDir = path.join(getConfigDir(), 'memories');
	}

	// ─── Path Helpers ───────────────────────────────────────────────────────

	/** Returns the directory path for a given memory scope. */
	getMemoryPath(scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string): string {
		switch (scope) {
			case 'skill': {
				if (!skillAreaId) throw new Error('skillAreaId required for skill scope');
				return path.join(this.memoriesDir, 'skills', skillAreaId);
			}
			case 'project': {
				if (!projectPath) throw new Error('projectPath required for project scope');
				const hash = crypto.createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
				return path.join(this.memoriesDir, 'project', hash);
			}
			case 'global':
				return path.join(this.memoriesDir, 'global');
			default:
				throw new Error(`Unknown scope: ${scope}`);
		}
	}

	private getRegistryPath(): string {
		return path.join(this.memoriesDir, 'registry.json');
	}

	private getConfigPath(): string {
		return path.join(this.memoriesDir, 'config.json');
	}

	// ─── Write Serialization ────────────────────────────────────────────────

	/**
	 * Serialize writes to a given file path so concurrent callers don't race.
	 * Returns the callback's result.
	 */
	private serializeWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const settled = next.then(
			() => {},
			() => {}
		);
		this.writeQueues.set(filePath, settled);
		settled.then(() => {
			if (this.writeQueues.get(filePath) === settled) {
				this.writeQueues.delete(filePath);
			}
		});
		return next;
	}

	// ─── Atomic File I/O ────────────────────────────────────────────────────

	/**
	 * Atomically write JSON to a file (write tmp → rename).
	 * rename() is atomic on POSIX and effectively atomic on NTFS.
	 */
	private async atomicWriteJson(filePath: string, data: unknown): Promise<void> {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const tmp = filePath + '.tmp';
		await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
		await fs.rename(tmp, filePath);
	}

	// ─── Registry Read/Write ────────────────────────────────────────────────

	private emptyRegistry(): RegistryFile {
		return { version: 1, roles: [], personas: [], skillAreas: [] };
	}

	async readRegistry(): Promise<RegistryFile> {
		try {
			const content = await fs.readFile(this.getRegistryPath(), 'utf-8');
			if (!content.trim()) return this.emptyRegistry();
			return JSON.parse(content) as RegistryFile;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return this.emptyRegistry();
			}
			if (error instanceof SyntaxError) {
				return this.emptyRegistry();
			}
			throw error;
		}
	}

	async writeRegistry(registry: RegistryFile): Promise<void> {
		return this.serializeWrite(this.getRegistryPath(), () =>
			this.atomicWriteJson(this.getRegistryPath(), registry)
		);
	}

	// ─── Library Read/Write ─────────────────────────────────────────────────

	private emptyLibrary(): LibraryFile {
		return { version: 1, entries: [] };
	}

	async readLibrary(dirPath: string): Promise<LibraryFile> {
		const filePath = path.join(dirPath, 'library.json');
		try {
			const content = await fs.readFile(filePath, 'utf-8');
			if (!content.trim()) return this.emptyLibrary();
			return JSON.parse(content) as LibraryFile;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return this.emptyLibrary();
			}
			if (error instanceof SyntaxError) {
				return this.emptyLibrary();
			}
			throw error;
		}
	}

	async writeLibrary(dirPath: string, lib: LibraryFile): Promise<void> {
		const filePath = path.join(dirPath, 'library.json');
		return this.serializeWrite(filePath, () => this.atomicWriteJson(filePath, lib));
	}

	// ─── History (JSONL Append) ─────────────────────────────────────────────

	async appendHistory(dirPath: string, entry: MemoryHistoryEntry): Promise<void> {
		const filePath = path.join(dirPath, 'history.jsonl');
		await fs.mkdir(dirPath, { recursive: true });
		const line = JSON.stringify(entry) + '\n';
		await fs.appendFile(filePath, line, 'utf-8');
	}

	// ─── Role CRUD ──────────────────────────────────────────────────────────

	async createRole(name: string, description: string): Promise<Role> {
		const registry = await this.readRegistry();
		const now = Date.now();
		const role: Role = {
			id: crypto.randomUUID(),
			name,
			description,
			personaIds: [],
			createdAt: now,
			updatedAt: now,
		};
		registry.roles.push(role);
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'create-role',
			entityType: 'role',
			entityId: role.id,
			content: name,
		});
		return role;
	}

	async updateRole(
		id: RoleId,
		updates: { name?: string; description?: string }
	): Promise<Role | null> {
		const registry = await this.readRegistry();
		const idx = registry.roles.findIndex((r) => r.id === id);
		if (idx === -1) return null;

		const now = Date.now();
		const oldRole = registry.roles[idx];
		registry.roles[idx] = { ...oldRole, ...updates, updatedAt: now };
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'update-role',
			entityType: 'role',
			entityId: id,
			oldContent: oldRole.name,
			newContent: updates.name ?? oldRole.name,
		});
		return registry.roles[idx];
	}

	async deleteRole(id: RoleId): Promise<boolean> {
		const registry = await this.readRegistry();
		const idx = registry.roles.findIndex((r) => r.id === id);
		if (idx === -1) return false;

		const role = registry.roles[idx];
		const now = Date.now();

		// Cascade: deactivate all child personas
		for (const personaId of role.personaIds) {
			const pIdx = registry.personas.findIndex((p) => p.id === personaId);
			if (pIdx !== -1) {
				registry.personas[pIdx] = { ...registry.personas[pIdx], active: false, updatedAt: now };
			}
		}

		registry.roles.splice(idx, 1);
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'delete-role',
			entityType: 'role',
			entityId: id,
			content: role.name,
		});
		return true;
	}

	async listRoles(): Promise<Role[]> {
		const registry = await this.readRegistry();
		return registry.roles;
	}

	async getRole(id: RoleId): Promise<Role | null> {
		const registry = await this.readRegistry();
		return registry.roles.find((r) => r.id === id) ?? null;
	}

	// ─── Persona CRUD ───────────────────────────────────────────────────────

	async createPersona(
		roleId: RoleId,
		name: string,
		description: string,
		assignedAgents?: string[],
		assignedProjects?: string[]
	): Promise<Persona> {
		const registry = await this.readRegistry();
		const roleIdx = registry.roles.findIndex((r) => r.id === roleId);
		if (roleIdx === -1) throw new Error(`Role not found: ${roleId}`);

		const now = Date.now();
		const persona: Persona = {
			id: crypto.randomUUID(),
			roleId,
			name,
			description,
			embedding: null,
			skillAreaIds: [],
			assignedAgents: assignedAgents ?? [],
			assignedProjects: assignedProjects ?? [],
			active: true,
			createdAt: now,
			updatedAt: now,
		};

		registry.personas.push(persona);
		registry.roles[roleIdx] = {
			...registry.roles[roleIdx],
			personaIds: [...registry.roles[roleIdx].personaIds, persona.id],
			updatedAt: now,
		};

		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'create-persona',
			entityType: 'persona',
			entityId: persona.id,
			content: name,
		});
		return persona;
	}

	async updatePersona(
		id: PersonaId,
		updates: {
			name?: string;
			description?: string;
			assignedAgents?: string[];
			assignedProjects?: string[];
			active?: boolean;
		}
	): Promise<Persona | null> {
		const registry = await this.readRegistry();
		const idx = registry.personas.findIndex((p) => p.id === id);
		if (idx === -1) return null;

		const now = Date.now();
		const oldPersona = registry.personas[idx];
		const updated = { ...oldPersona, ...updates, updatedAt: now };

		// Null out embedding if description changed
		if (updates.description !== undefined && updates.description !== oldPersona.description) {
			updated.embedding = null;
		}

		registry.personas[idx] = updated;
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'update-persona',
			entityType: 'persona',
			entityId: id,
			oldContent: oldPersona.name,
			newContent: updates.name ?? oldPersona.name,
		});
		return updated;
	}

	async deletePersona(id: PersonaId): Promise<boolean> {
		const registry = await this.readRegistry();
		const idx = registry.personas.findIndex((p) => p.id === id);
		if (idx === -1) return false;

		const persona = registry.personas[idx];
		const now = Date.now();

		// Cascade: deactivate child skill areas
		for (const skillId of persona.skillAreaIds) {
			const sIdx = registry.skillAreas.findIndex((s) => s.id === skillId);
			if (sIdx !== -1) {
				registry.skillAreas[sIdx] = {
					...registry.skillAreas[sIdx],
					active: false,
					updatedAt: now,
				};
			}
		}

		// Remove persona from parent role's personaIds
		const roleIdx = registry.roles.findIndex((r) => r.id === persona.roleId);
		if (roleIdx !== -1) {
			registry.roles[roleIdx] = {
				...registry.roles[roleIdx],
				personaIds: registry.roles[roleIdx].personaIds.filter((pid) => pid !== id),
				updatedAt: now,
			};
		}

		registry.personas.splice(idx, 1);
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'delete-persona',
			entityType: 'persona',
			entityId: id,
			content: persona.name,
		});
		return true;
	}

	async listPersonas(roleId?: RoleId): Promise<Persona[]> {
		const registry = await this.readRegistry();
		if (roleId) {
			return registry.personas.filter((p) => p.roleId === roleId);
		}
		return registry.personas;
	}

	async getPersona(id: PersonaId): Promise<Persona | null> {
		const registry = await this.readRegistry();
		return registry.personas.find((p) => p.id === id) ?? null;
	}

	// ─── Skill Area CRUD ────────────────────────────────────────────────────

	async createSkillArea(
		personaId: PersonaId,
		name: string,
		description: string
	): Promise<SkillArea> {
		const registry = await this.readRegistry();
		const personaIdx = registry.personas.findIndex((p) => p.id === personaId);
		if (personaIdx === -1) throw new Error(`Persona not found: ${personaId}`);

		const now = Date.now();
		const skillArea: SkillArea = {
			id: crypto.randomUUID(),
			personaId,
			name,
			description,
			embedding: null,
			active: true,
			createdAt: now,
			updatedAt: now,
		};

		registry.skillAreas.push(skillArea);
		registry.personas[personaIdx] = {
			...registry.personas[personaIdx],
			skillAreaIds: [...registry.personas[personaIdx].skillAreaIds, skillArea.id],
			updatedAt: now,
		};

		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'create-skill',
			entityType: 'skill',
			entityId: skillArea.id,
			content: name,
		});
		return skillArea;
	}

	async updateSkillArea(
		id: SkillAreaId,
		updates: { name?: string; description?: string; active?: boolean }
	): Promise<SkillArea | null> {
		const registry = await this.readRegistry();
		const idx = registry.skillAreas.findIndex((s) => s.id === id);
		if (idx === -1) return null;

		const now = Date.now();
		const oldSkill = registry.skillAreas[idx];
		const updated = { ...oldSkill, ...updates, updatedAt: now };

		// Null out embedding if description changed
		if (updates.description !== undefined && updates.description !== oldSkill.description) {
			updated.embedding = null;
		}

		registry.skillAreas[idx] = updated;
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'update-skill',
			entityType: 'skill',
			entityId: id,
			oldContent: oldSkill.name,
			newContent: updates.name ?? oldSkill.name,
		});
		return updated;
	}

	async deleteSkillArea(id: SkillAreaId): Promise<boolean> {
		const registry = await this.readRegistry();
		const idx = registry.skillAreas.findIndex((s) => s.id === id);
		if (idx === -1) return false;

		const skillArea = registry.skillAreas[idx];
		const now = Date.now();

		// Deactivate all memories in this skill area's library
		const dirPath = this.getMemoryPath('skill', id);
		try {
			const lib = await this.readLibrary(dirPath);
			const updated: LibraryFile = {
				...lib,
				entries: lib.entries.map((e) => ({ ...e, active: false, updatedAt: now })),
			};
			await this.writeLibrary(dirPath, updated);
		} catch {
			// Library may not exist yet — that's fine
		}

		// Remove skill area from parent persona's skillAreaIds
		const personaIdx = registry.personas.findIndex((p) => p.id === skillArea.personaId);
		if (personaIdx !== -1) {
			registry.personas[personaIdx] = {
				...registry.personas[personaIdx],
				skillAreaIds: registry.personas[personaIdx].skillAreaIds.filter((sid) => sid !== id),
				updatedAt: now,
			};
		}

		registry.skillAreas.splice(idx, 1);
		await this.writeRegistry(registry);
		await this.appendHistory(this.memoriesDir, {
			timestamp: now,
			operation: 'delete-skill',
			entityType: 'skill',
			entityId: id,
			content: skillArea.name,
		});
		return true;
	}

	async listSkillAreas(personaId?: PersonaId): Promise<SkillArea[]> {
		const registry = await this.readRegistry();
		if (personaId) {
			return registry.skillAreas.filter((s) => s.personaId === personaId);
		}
		return registry.skillAreas;
	}

	async getSkillArea(id: SkillAreaId): Promise<SkillArea | null> {
		const registry = await this.readRegistry();
		return registry.skillAreas.find((s) => s.id === id) ?? null;
	}

	// ─── Memory CRUD ────────────────────────────────────────────────────────

	async addMemory(
		entry: {
			content: string;
			type?: MemoryType;
			scope: MemoryScope;
			skillAreaId?: SkillAreaId;
			personaId?: PersonaId;
			roleId?: RoleId;
			tags?: string[];
			source?: MemorySource;
			confidence?: number;
			pinned?: boolean;
			experienceContext?: ExperienceContext;
		},
		projectPath?: string
	): Promise<MemoryEntry> {
		// Validate skill scope references
		if (entry.scope === 'skill') {
			if (!entry.skillAreaId) throw new Error('skillAreaId required for skill scope');
			const registry = await this.readRegistry();
			const skill = registry.skillAreas.find((s) => s.id === entry.skillAreaId);
			if (!skill) throw new Error(`Skill area not found: ${entry.skillAreaId}`);
		}

		const dirPath = this.getMemoryPath(entry.scope, entry.skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const now = Date.now();

		const memory: MemoryEntry = {
			id: crypto.randomUUID(),
			content: entry.content,
			type: entry.type ?? 'rule',
			scope: entry.scope,
			experienceContext: entry.experienceContext,
			skillAreaId: entry.skillAreaId,
			personaId: entry.personaId,
			roleId: entry.roleId,
			tags: entry.tags ?? [],
			source: entry.source ?? 'user',
			confidence: entry.confidence ?? 1.0,
			pinned: entry.pinned ?? false,
			active: true,
			archived: false,
			embedding: null,
			effectivenessScore: 0.5,
			useCount: 0,
			tokenEstimate: Math.ceil(entry.content.length / 4),
			lastUsedAt: 0,
			createdAt: now,
			updatedAt: now,
		};

		lib.entries.push(memory);
		await this.writeLibrary(dirPath, lib);
		await this.appendHistory(dirPath, {
			timestamp: now,
			operation: 'add',
			entityType: 'memory',
			entityId: memory.id,
			content: entry.content.slice(0, 200),
			source: entry.source ?? 'user',
		});

		// Auto-consolidation: fire-and-forget when active count is divisible by 10
		const activeCount = lib.entries.filter((e) => e.active).length;
		if (activeCount > 0 && activeCount % 10 === 0) {
			const config = await this.getConfig();
			if (config.enableAutoConsolidation) {
				this.consolidateMemories(entry.scope, config, entry.skillAreaId, projectPath).catch(() => {
					// Fire-and-forget — log nothing, degrade gracefully
				});
			}
		}

		return memory;
	}

	async updateMemory(
		id: MemoryId,
		updates: Partial<
			Pick<
				MemoryEntry,
				'content' | 'type' | 'tags' | 'confidence' | 'pinned' | 'active' | 'experienceContext'
			>
		>,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry | null> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const idx = lib.entries.findIndex((e) => e.id === id);
		if (idx === -1) return null;

		const now = Date.now();
		const oldEntry = lib.entries[idx];
		const updated = { ...oldEntry, ...updates, updatedAt: now };

		// Null out embedding if content changed
		if (updates.content !== undefined && updates.content !== oldEntry.content) {
			updated.embedding = null;
			updated.tokenEstimate = Math.ceil(updates.content.length / 4);
		}

		lib.entries[idx] = updated;
		await this.writeLibrary(dirPath, lib);
		await this.appendHistory(dirPath, {
			timestamp: now,
			operation: 'update',
			entityType: 'memory',
			entityId: id,
			oldContent: oldEntry.content.slice(0, 200),
			newContent: (updates.content ?? oldEntry.content).slice(0, 200),
		});
		return updated;
	}

	async deleteMemory(
		id: MemoryId,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<boolean> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const idx = lib.entries.findIndex((e) => e.id === id);
		if (idx === -1) return false;

		const entry = lib.entries[idx];
		const now = Date.now();
		lib.entries.splice(idx, 1);
		await this.writeLibrary(dirPath, lib);
		await this.appendHistory(dirPath, {
			timestamp: now,
			operation: 'delete',
			entityType: 'memory',
			entityId: id,
			content: entry.content.slice(0, 200),
		});
		return true;
	}

	async getMemory(
		id: MemoryId,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry | null> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		return lib.entries.find((e) => e.id === id) ?? null;
	}

	async listMemories(
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string,
		includeInactive?: boolean,
		includeArchived?: boolean
	): Promise<MemoryEntry[]> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		if (includeInactive) return lib.entries;
		return lib.entries.filter((e) => e.active && (includeArchived || !e.archived));
	}

	/**
	 * List archived memories for a given scope. Used by the UI archive browser.
	 */
	async listArchivedMemories(
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry[]> {
		const all = await this.listMemories(scope, skillAreaId, projectPath, false, true);
		return all.filter((e) => e.archived);
	}

	/**
	 * Restore an archived memory — set archived=false, boost confidence to 0.3.
	 * The confidence boost ensures it won't be immediately re-archived by the next decay cycle.
	 */
	async restoreMemory(
		id: MemoryId,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry | null> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const idx = lib.entries.findIndex((e) => e.id === id);
		if (idx === -1) return null;

		const entry = lib.entries[idx];
		if (!entry.archived) return entry; // Already not archived

		const now = Date.now();
		lib.entries[idx] = {
			...entry,
			archived: false,
			confidence: Math.max(entry.confidence, 0.3),
			updatedAt: now,
		};

		await this.writeLibrary(dirPath, lib);
		await this.appendHistory(dirPath, {
			timestamp: now,
			operation: 'restore',
			entityType: 'memory',
			entityId: id,
			content: entry.content.slice(0, 200),
		});

		return lib.entries[idx];
	}

	// ─── Keyword & Tag Search ───────────────────────────────────────────────

	/** Stop words excluded from keyword tokenization */
	private static readonly STOP_WORDS = new Set([
		'a',
		'the',
		'is',
		'are',
		'was',
		'were',
		'to',
		'of',
		'in',
		'for',
		'on',
		'with',
		'and',
		'or',
		'but',
		'not',
	]);

	/**
	 * Tokenize text into lowercase, deduplicated tokens with stop words removed.
	 */
	private tokenize(text: string): Set<string> {
		const tokens = text
			.toLowerCase()
			.split(/[\s\p{P}]+/u)
			.filter((t) => t.length > 0);
		const result = new Set<string>();
		for (const t of tokens) {
			if (!MemoryStore.STOP_WORDS.has(t)) result.add(t);
		}
		return result;
	}

	/**
	 * Search memories by keyword/token overlap (complementary to embedding search).
	 *
	 * Splits the query and each memory's content into lowercase tokens, computes
	 * Jaccard similarity: |intersection| / |union|. Also checks the memory's tags
	 * array for exact matches (especially `kw:` prefixed tags from extraction).
	 *
	 * @returns Scored results above minScore threshold, sorted descending
	 */
	async keywordSearch(
		query: string,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string,
		minScore: number = 0.1
	): Promise<{ entry: MemoryEntry; keywordScore: number }[]> {
		const memories = await this.listMemories(scope, skillAreaId, projectPath);
		const active = memories.filter((e) => e.active && !e.archived);
		const queryTokens = this.tokenize(query);
		if (queryTokens.size === 0) return [];

		const results: { entry: MemoryEntry; keywordScore: number }[] = [];

		for (const entry of active) {
			const contentTokens = this.tokenize(entry.content);

			// Jaccard similarity
			let intersectionSize = 0;
			for (const t of queryTokens) {
				if (contentTokens.has(t)) intersectionSize++;
			}
			const unionSize = new Set([...queryTokens, ...contentTokens]).size;
			const jaccardScore = unionSize > 0 ? intersectionSize / unionSize : 0;

			// Tag bonus
			let tagBonus = 0;
			for (const tag of entry.tags) {
				if (tag.startsWith('kw:')) {
					const keyword = tag.slice(3).toLowerCase();
					if (queryTokens.has(keyword)) tagBonus += 0.15;
				} else if (tag.startsWith('category:')) {
					const category = tag.slice(9).toLowerCase();
					if (queryTokens.has(category)) tagBonus += 0.1;
				}
			}

			const keywordScore = Math.min(1, jaccardScore + tagBonus);
			if (keywordScore >= minScore) {
				results.push({ entry, keywordScore });
			}
		}

		results.sort((a, b) => b.keywordScore - a.keywordScore);
		return results;
	}

	/**
	 * Search memories by exact tag matching.
	 * Supports `category:*` tags, `kw:*` keyword tags, and freeform tags.
	 */
	async tagSearch(
		tags: string[],
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<{ entry: MemoryEntry; tagScore: number }[]> {
		if (tags.length === 0) return [];
		const memories = await this.listMemories(scope, skillAreaId, projectPath);
		const active = memories.filter((e) => e.active && !e.archived);

		const results: { entry: MemoryEntry; tagScore: number }[] = [];

		for (const entry of active) {
			const entryTagSet = new Set(entry.tags.map((t) => t.toLowerCase()));
			let matchCount = 0;
			for (const queryTag of tags) {
				if (entryTagSet.has(queryTag.toLowerCase())) matchCount++;
			}
			const tagScore = matchCount / tags.length;
			if (tagScore > 0) {
				results.push({ entry, tagScore });
			}
		}

		results.sort((a, b) => b.tagScore - a.tagScore);
		return results;
	}

	/**
	 * Multi-signal memory search combining embedding similarity, keyword overlap,
	 * and tag matching. Score fusion formula:
	 *
	 *   combined = 0.5 * embeddingSimilarity + 0.3 * keywordScore + 0.2 * tagScore
	 *
	 * Falls back gracefully: if embeddings unavailable, uses keyword + tag only.
	 * If no keywords in query, uses embedding + tag only.
	 */
	async hybridSearch(
		query: string,
		scope: MemoryScope,
		config: MemoryConfig,
		skillAreaId?: SkillAreaId,
		projectPath?: string,
		limit: number = 20
	): Promise<MemorySearchResult[]> {
		// Parse tags from query (category: or kw: prefixes, plus all unique tokens)
		const queryTokens = this.tokenize(query);
		const queryTags: string[] = [];
		for (const token of queryTokens) {
			queryTags.push(token);
			queryTags.push(`kw:${token}`);
		}
		// Also parse explicit category:/kw: in raw query
		const tagPatterns = query.match(/(?:category|kw):\S+/gi) ?? [];
		for (const p of tagPatterns) queryTags.push(p.toLowerCase());
		const dedupedTags = [...new Set(queryTags)];

		// Run all three searches in parallel
		const [keywordResults, tagResults, embeddingResults] = await Promise.all([
			this.keywordSearch(query, scope, skillAreaId, projectPath, 0.05),
			this.tagSearch(dedupedTags, scope, skillAreaId, projectPath),
			this.embeddingSearchForScope(query, scope, config, skillAreaId, projectPath),
		]);

		// Build union map: memoryId → { embeddingScore, keywordScore, tagScore, entry }
		const scoreMap = new Map<
			string,
			{
				entry: MemoryEntry;
				embeddingScore: number;
				keywordScore: number;
				tagScore: number;
			}
		>();

		const getOrCreate = (entry: MemoryEntry) => {
			let record = scoreMap.get(entry.id);
			if (!record) {
				record = { entry, embeddingScore: 0, keywordScore: 0, tagScore: 0 };
				scoreMap.set(entry.id, record);
			}
			return record;
		};

		for (const r of embeddingResults) {
			getOrCreate(r.entry).embeddingScore = r.similarity;
		}
		for (const r of keywordResults) {
			getOrCreate(r.entry).keywordScore = r.keywordScore;
		}
		for (const r of tagResults) {
			getOrCreate(r.entry).tagScore = r.tagScore;
		}

		// Compute combined scores
		const results: MemorySearchResult[] = [];
		const now = Date.now();

		for (const [, record] of scoreMap) {
			const combined =
				0.5 * record.embeddingScore + 0.3 * record.keywordScore + 0.2 * record.tagScore;
			const recencyScore = Math.max(
				0,
				1 - (now - record.entry.updatedAt) / (config.decayHalfLifeDays * 86400000)
			);
			const finalScore =
				combined * 0.6 + record.entry.effectivenessScore * 0.2 + recencyScore * 0.2;

			results.push({
				entry: record.entry,
				similarity: record.embeddingScore,
				combinedScore: finalScore,
			});
		}

		results.sort((a, b) => b.combinedScore - a.combinedScore);
		return results.slice(0, limit);
	}

	/**
	 * Embedding-only search for a single scope. Used by hybridSearch as one signal.
	 * Wraps the embedding call in try-catch for graceful fallback.
	 */
	private async embeddingSearchForScope(
		query: string,
		scope: MemoryScope,
		config: MemoryConfig,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<{ entry: MemoryEntry; similarity: number }[]> {
		try {
			const { encode } = await import('../grpo/embedding-service');
			const queryEmbedding = await encode(query.slice(0, 2000));
			const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
			const lib = await this.readLibrary(dirPath);

			const results: { entry: MemoryEntry; similarity: number }[] = [];
			for (const entry of lib.entries) {
				if (!entry.active || entry.archived || !entry.embedding) continue;
				const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
				if (similarity < config.similarityThreshold) continue;
				results.push({ entry, similarity });
			}
			return results;
		} catch {
			// Embedding service unavailable — return empty, other signals will carry
			return [];
		}
	}

	// ─── Config Management ──────────────────────────────────────────────────

	async getConfig(): Promise<MemoryConfig> {
		try {
			const content = await fs.readFile(this.getConfigPath(), 'utf-8');
			if (!content.trim()) return { ...MEMORY_CONFIG_DEFAULTS };
			return { ...MEMORY_CONFIG_DEFAULTS, ...JSON.parse(content) };
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { ...MEMORY_CONFIG_DEFAULTS };
			}
			if (error instanceof SyntaxError) {
				return { ...MEMORY_CONFIG_DEFAULTS };
			}
			throw error;
		}
	}

	async setConfig(config: Partial<MemoryConfig>): Promise<MemoryConfig> {
		const current = await this.getConfig();
		const merged = { ...current, ...config };
		await this.atomicWriteJson(this.getConfigPath(), merged);
		return merged;
	}

	// ─── Embedding Helpers ──────────────────────────────────────────────────

	/**
	 * Lazily compute embedding for a single memory entry if missing.
	 * Returns the entry (potentially updated with embedding).
	 */
	async ensureEmbedding(
		entry: MemoryEntry,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry> {
		if (entry.embedding !== null) return entry;

		try {
			const { encode } = await import('../grpo/embedding-service');
			const embedding = await encode(entry.content);

			// Write embedding directly without triggering content-change logic
			const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
			const lib = await this.readLibrary(dirPath);
			const idx = lib.entries.findIndex((e) => e.id === entry.id);
			if (idx !== -1) {
				lib.entries[idx].embedding = embedding;
				await this.writeLibrary(dirPath, lib);
				return lib.entries[idx];
			}
			return entry;
		} catch {
			// EmbeddingModelNotAvailableError or other — degrade gracefully
			return entry;
		}
	}

	/**
	 * Compute embeddings for all entries in a scope that have null embeddings.
	 */
	async ensureAllEmbeddings(
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<number> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const missing = lib.entries.filter((e) => e.embedding === null && e.active);
		if (missing.length === 0) return 0;

		try {
			const { encodeBatch } = await import('../grpo/embedding-service');
			const texts = missing.map((e) => e.content);
			const embeddings = await encodeBatch(texts);

			for (let i = 0; i < missing.length; i++) {
				const idx = lib.entries.findIndex((e) => e.id === missing[i].id);
				if (idx !== -1) {
					lib.entries[idx].embedding = embeddings[i];
				}
			}

			await this.writeLibrary(dirPath, lib);
			return missing.length;
		} catch {
			// EmbeddingModelNotAvailableError — degrade gracefully
			return 0;
		}
	}

	/**
	 * Compute embeddings for personas and skill areas that have null embeddings.
	 */
	async ensureHierarchyEmbeddings(): Promise<number> {
		const registry = await this.readRegistry();

		// Collect all descriptions that need embeddings
		const textsToEmbed: string[] = [];
		const targets: Array<{ type: 'persona' | 'skill'; index: number }> = [];

		for (let i = 0; i < registry.personas.length; i++) {
			if (registry.personas[i].embedding === null && registry.personas[i].active) {
				textsToEmbed.push(registry.personas[i].description);
				targets.push({ type: 'persona', index: i });
			}
		}

		for (let i = 0; i < registry.skillAreas.length; i++) {
			if (registry.skillAreas[i].embedding === null && registry.skillAreas[i].active) {
				textsToEmbed.push(registry.skillAreas[i].description);
				targets.push({ type: 'skill', index: i });
			}
		}

		if (textsToEmbed.length === 0) return 0;

		try {
			const { encodeBatch } = await import('../grpo/embedding-service');
			const embeddings = await encodeBatch(textsToEmbed);

			for (let i = 0; i < targets.length; i++) {
				const target = targets[i];
				if (target.type === 'persona') {
					registry.personas[target.index].embedding = embeddings[i];
				} else {
					registry.skillAreas[target.index].embedding = embeddings[i];
				}
			}

			await this.writeRegistry(registry);
			return textsToEmbed.length;
		} catch {
			// EmbeddingModelNotAvailableError — degrade gracefully
			return 0;
		}
	}

	// ─── Semantic Search ─────────────────────────────────────────────────────

	/**
	 * Compute a combined ranking score for a memory search result.
	 *
	 * combinedScore = similarity * 0.6 + effectivenessScore * 0.2 + recencyScore * 0.2
	 * recency = max(0, 1 - (now - updatedAt) / (decayHalfLifeDays * 86400000))
	 */
	private computeCombinedScore(
		similarity: number,
		entry: MemoryEntry,
		decayHalfLifeDays: number
	): number {
		const now = Date.now();
		const recencyScore = Math.max(0, 1 - (now - entry.updatedAt) / (decayHalfLifeDays * 86400000));
		return similarity * 0.6 + entry.effectivenessScore * 0.2 + recencyScore * 0.2;
	}

	/**
	 * Search a flat scope (project or global) for memories matching the query.
	 * These scopes live outside the hierarchy and are searched independently.
	 */
	async searchFlatScope(
		queryEmbedding: number[],
		scope: 'project' | 'global',
		config: MemoryConfig,
		projectPath?: string,
		limit: number = 20
	): Promise<MemorySearchResult[]> {
		const dirPath = this.getMemoryPath(scope, undefined, projectPath);
		const lib = await this.readLibrary(dirPath);

		const results: MemorySearchResult[] = [];
		for (const entry of lib.entries) {
			if (!entry.active || entry.archived || !entry.embedding) continue;

			const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
			if (similarity < config.similarityThreshold) continue;

			results.push({
				entry,
				similarity,
				combinedScore: this.computeCombinedScore(similarity, entry, config.decayHalfLifeDays),
			});
		}

		results.sort((a, b) => b.combinedScore - a.combinedScore);
		return results.slice(0, limit);
	}

	/**
	 * Cascading semantic search through the hierarchy.
	 *
	 * 1. Embed the query
	 * 2. Find personas matching the query (cosine > personaMatchThreshold)
	 *    - Filter by assignedAgents (if agentType provided)
	 *    - Filter by assignedProjects (if projectPath provided)
	 * 3. Within matched personas, find skill areas matching (cosine > skillMatchThreshold)
	 * 4. Within matched skill areas, search memories (cosine > similarityThreshold)
	 * 5. Also search project-scoped and global memories in parallel
	 * 6. Merge all results, rank by combinedScore, return top N
	 */
	async cascadingSearch(
		query: string,
		config: MemoryConfig,
		agentType: string,
		projectPath?: string,
		limit: number = 30
	): Promise<MemorySearchResult[]> {
		const { encode } = await import('../grpo/embedding-service');
		const queryEmbedding = await encode(query.slice(0, 2000));

		const registry = await this.readRegistry();
		const hierarchyResults: MemorySearchResult[] = [];

		// ── Level 1: Persona matching ────────────────────────────────────
		const matchedPersonas: Array<{ persona: (typeof registry.personas)[0]; personaName: string }> =
			[];

		for (const persona of registry.personas) {
			if (!persona.active) continue;

			// Agent filter: empty assignedAgents = matches all agents
			if (persona.assignedAgents.length > 0 && !persona.assignedAgents.includes(agentType)) {
				continue;
			}

			// Project filter: empty assignedProjects = matches all projects
			if (
				projectPath &&
				persona.assignedProjects.length > 0 &&
				!persona.assignedProjects.includes(projectPath)
			) {
				continue;
			}

			// Embedding filter: if persona has embedding, check threshold; if not, include it
			if (persona.embedding) {
				const sim = cosineSimilarity(queryEmbedding, persona.embedding);
				if (sim < config.personaMatchThreshold) continue;
			}

			matchedPersonas.push({ persona, personaName: persona.name });
		}

		// ── Level 2: Skill area matching ─────────────────────────────────
		const matchedSkills: Array<{
			skill: (typeof registry.skillAreas)[0];
			personaName: string;
			skillAreaName: string;
		}> = [];

		for (const { persona, personaName } of matchedPersonas) {
			for (const skillId of persona.skillAreaIds) {
				const skill = registry.skillAreas.find((s) => s.id === skillId);
				if (!skill || !skill.active) continue;

				// Embedding filter: if skill has embedding, check threshold; if not, include it
				if (skill.embedding) {
					const sim = cosineSimilarity(queryEmbedding, skill.embedding);
					if (sim < config.skillMatchThreshold) continue;
				}

				matchedSkills.push({ skill, personaName, skillAreaName: skill.name });
			}
		}

		// ── Level 3: Memory search within matched skill areas ────────────
		if (config.enableHybridSearch) {
			// Hybrid: use multi-signal search (embedding + keyword + tag)
			for (const { skill, personaName, skillAreaName } of matchedSkills) {
				const skillResults = await this.hybridSearch(
					query,
					'skill',
					config,
					skill.id,
					undefined,
					50
				);
				for (const r of skillResults) {
					hierarchyResults.push({ ...r, personaName, skillAreaName });
				}
			}
		} else {
			// Embedding-only (legacy behavior)
			for (const { skill, personaName, skillAreaName } of matchedSkills) {
				const dirPath = this.getMemoryPath('skill', skill.id);
				const lib = await this.readLibrary(dirPath);

				for (const entry of lib.entries) {
					if (!entry.active || entry.archived || !entry.embedding) continue;

					const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
					if (similarity < config.similarityThreshold) continue;

					hierarchyResults.push({
						entry,
						similarity,
						combinedScore: this.computeCombinedScore(similarity, entry, config.decayHalfLifeDays),
						personaName,
						skillAreaName,
					});
				}
			}
		}

		// ── Parallel flat-scope search ───────────────────────────────────
		let flatResults: MemorySearchResult[];
		if (config.enableHybridSearch) {
			const flatSearches: Promise<MemorySearchResult[]>[] = [
				this.hybridSearch(query, 'global', config),
			];
			if (projectPath) {
				flatSearches.push(this.hybridSearch(query, 'project', config, undefined, projectPath));
			}
			flatResults = (await Promise.all(flatSearches)).flat();
		} else {
			const flatSearches: Promise<MemorySearchResult[]>[] = [
				this.searchFlatScope(queryEmbedding, 'global', config),
			];
			if (projectPath) {
				flatSearches.push(this.searchFlatScope(queryEmbedding, 'project', config, projectPath));
			}
			flatResults = (await Promise.all(flatSearches)).flat();
		}

		// ── Merge, de-duplicate, rank ────────────────────────────────────
		const allResults = [...hierarchyResults, ...flatResults];
		const seen = new Set<string>();
		const deduped: MemorySearchResult[] = [];
		for (const r of allResults) {
			if (seen.has(r.entry.id)) continue;
			seen.add(r.entry.id);
			deduped.push(r);
		}

		deduped.sort((a, b) => b.combinedScore - a.combinedScore);
		return deduped.slice(0, limit);
	}

	// ─── Injection Recording ─────────────────────────────────────────────────

	/**
	 * Record that memories were injected into an agent prompt.
	 * Increments useCount and updates lastUsedAt in batch.
	 * No history entry (high-frequency operation).
	 */
	async recordInjection(
		injectedIds: MemoryId[],
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<void> {
		if (injectedIds.length === 0) return;

		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const now = Date.now();
		const idSet = new Set(injectedIds);

		let modified = false;
		for (const entry of lib.entries) {
			if (idSet.has(entry.id)) {
				entry.useCount += 1;
				entry.lastUsedAt = now;
				modified = true;
			}
		}

		if (modified) {
			await this.writeLibrary(dirPath, lib);
		}
	}

	// ─── Effectiveness Tracking ─────────────────────────────────────────────

	/**
	 * Update effectiveness scores for injected memories using EMA.
	 *
	 * Formula: new_score = 0.3 * outcomeScore + 0.7 * old_score
	 * Clamped to [0, 1]. Batch write.
	 *
	 * @param injectedIds - Memory IDs that were injected into the agent prompt
	 * @param outcomeScore - Outcome signal (0.0 = bad, 1.0 = good)
	 * @param scope - Which scope the memories belong to
	 * @param skillAreaId - Required for skill scope
	 * @param projectPath - Required for project scope
	 */
	async updateEffectiveness(
		injectedIds: MemoryId[],
		outcomeScore: number,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<void> {
		if (injectedIds.length === 0) return;

		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const idSet = new Set(injectedIds);

		let modified = false;
		for (const entry of lib.entries) {
			if (idSet.has(entry.id)) {
				entry.effectivenessScore = Math.min(
					1,
					Math.max(0, 0.3 * outcomeScore + 0.7 * entry.effectivenessScore)
				);
				modified = true;
			}
		}

		if (modified) {
			await this.writeLibrary(dirPath, lib);
		}
	}

	/**
	 * Apply confidence decay to non-pinned memories using half-life formula.
	 *
	 * Formula: confidence *= 2^(-daysSinceLastUsed / halfLifeDays)
	 * Auto-archives entries where confidence drops below 0.05.
	 * Archived memories remain active but are hidden from default searches.
	 *
	 * Key distinction:
	 * - active: false = user explicitly deleted (permanent, not shown anywhere)
	 * - archived: true = system demoted (recoverable, shown in archive view)
	 *
	 * @returns Number of entries that were auto-archived
	 */
	async applyConfidenceDecay(
		scope: MemoryScope,
		halfLifeDays: number,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<number> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const now = Date.now();
		const msPerDay = 86400000;

		let archivedCount = 0;
		let modified = false;

		for (const entry of lib.entries) {
			if (!entry.active || entry.pinned || entry.archived) continue;

			const lastUsed = entry.lastUsedAt > 0 ? entry.lastUsedAt : entry.createdAt;
			const daysSinceLastUsed = (now - lastUsed) / msPerDay;
			const decayFactor = Math.pow(2, -daysSinceLastUsed / halfLifeDays);
			entry.confidence = entry.confidence * decayFactor;

			if (entry.confidence < 0.05 && !entry.pinned) {
				entry.archived = true;
				// Keep active: true — archived memories are still "alive" but hidden from default searches
				entry.updatedAt = now;
				archivedCount++;
			}

			modified = true;
		}

		if (modified) {
			await this.writeLibrary(dirPath, lib);
		}

		return archivedCount;
	}

	// ─── Memory Consolidation ───────────────────────────────────────────────

	/**
	 * Consolidate semantically similar memories within a single scope.
	 *
	 * Algorithm (greedy clustering):
	 * 1. Load active entries with embeddings, group by type
	 * 2. Sort each group by confidence descending (cluster centers)
	 * 3. For each unconsumed entry, find unconsumed entries of the same type
	 *    with cosine similarity > config.consolidationThreshold
	 * 4. Merge: keep higher-confidence content, union tags, weighted-average
	 *    confidence, max effectiveness, sum useCounts
	 * 5. Mark absorbed entries as inactive, null out embedding if content changed
	 * 6. Write library once, append history entries
	 *
	 * @returns Number of merges performed
	 */
	async consolidateMemories(
		scope: MemoryScope,
		config: MemoryConfig,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<number> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);

		// Ensure all active entries have embeddings
		const activeEntries = lib.entries.filter((e) => e.active);
		const missingEmbeddings = activeEntries.filter((e) => e.embedding === null);
		if (missingEmbeddings.length > 0) {
			try {
				const { encodeBatch } = await import('../grpo/embedding-service');
				const texts = missingEmbeddings.map((e) => e.content);
				const embeddings = await encodeBatch(texts);
				for (let i = 0; i < missingEmbeddings.length; i++) {
					const idx = lib.entries.findIndex((e) => e.id === missingEmbeddings[i].id);
					if (idx !== -1) {
						lib.entries[idx].embedding = embeddings[i];
					}
				}
			} catch {
				// Embedding service unavailable — can't consolidate without embeddings
				return 0;
			}
		}

		// Collect active entries that now have embeddings, grouped by type
		const embeddedEntries = lib.entries.filter((e) => e.active && e.embedding !== null);
		if (embeddedEntries.length < 2) return 0;

		const byType = new Map<string, MemoryEntry[]>();
		for (const entry of embeddedEntries) {
			const group = byType.get(entry.type) ?? [];
			group.push(entry);
			byType.set(entry.type, group);
		}

		const consumed = new Set<MemoryId>();
		const historyEntries: MemoryHistoryEntry[] = [];
		let mergeCount = 0;
		const now = Date.now();

		for (const [, entries] of byType) {
			// Sort by confidence descending — highest confidence becomes cluster center
			entries.sort((a, b) => b.confidence - a.confidence);

			for (let i = 0; i < entries.length; i++) {
				const center = entries[i];
				if (consumed.has(center.id)) continue;

				// Find all similar entries of the same type
				const cluster: MemoryEntry[] = [];
				for (let j = i + 1; j < entries.length; j++) {
					const candidate = entries[j];
					if (consumed.has(candidate.id)) continue;

					const sim = cosineSimilarity(center.embedding!, candidate.embedding!);
					if (sim >= config.consolidationThreshold) {
						cluster.push(candidate);
					}
				}

				if (cluster.length === 0) continue;

				// Merge cluster into center
				const centerIdx = lib.entries.findIndex((e) => e.id === center.id);
				if (centerIdx === -1) continue;

				// Union tags
				const allTags = new Set(center.tags);
				for (const member of cluster) {
					for (const tag of member.tags) allTags.add(tag);
				}

				// Weighted-average confidence by useCount
				let totalWeight = Math.max(center.useCount, 1);
				let weightedSum = center.confidence * totalWeight;
				for (const member of cluster) {
					const w = Math.max(member.useCount, 1);
					weightedSum += member.confidence * w;
					totalWeight += w;
				}
				const avgConfidence = weightedSum / totalWeight;

				// Max effectiveness
				let maxEffectiveness = center.effectivenessScore;
				for (const member of cluster) {
					if (member.effectivenessScore > maxEffectiveness) {
						maxEffectiveness = member.effectivenessScore;
					}
				}

				// Sum useCounts
				let totalUseCount = center.useCount;
				for (const member of cluster) {
					totalUseCount += member.useCount;
				}

				// Update center entry
				lib.entries[centerIdx] = {
					...lib.entries[centerIdx],
					tags: [...allTags],
					confidence: avgConfidence,
					effectivenessScore: maxEffectiveness,
					useCount: totalUseCount,
					updatedAt: now,
					// Content stays from center (highest confidence), no embedding change needed
				};

				// Mark absorbed entries as inactive
				const absorbedIds: string[] = [];
				for (const member of cluster) {
					consumed.add(member.id);
					const memberIdx = lib.entries.findIndex((e) => e.id === member.id);
					if (memberIdx !== -1) {
						lib.entries[memberIdx] = {
							...lib.entries[memberIdx],
							active: false,
							updatedAt: now,
						};
					}
					absorbedIds.push(member.id);
				}

				consumed.add(center.id); // Mark center as consumed so it's not re-clustered

				historyEntries.push({
					timestamp: now,
					operation: 'consolidate',
					entityType: 'memory',
					entityId: center.id,
					content: `Merged ${cluster.length} entries into ${center.id}`,
					reason: `Absorbed: ${absorbedIds.join(', ')}`,
					source: 'consolidation',
				});

				mergeCount++;
			}
		}

		if (mergeCount > 0) {
			await this.writeLibrary(dirPath, lib);
			for (const entry of historyEntries) {
				await this.appendHistory(dirPath, entry);
			}
		}

		return mergeCount;
	}

	// ─── Project Digest ─────────────────────────────────────────────────────

	/**
	 * Generate or update a project digest — a single composite memory summarizing
	 * the top project-scoped memories for a given project path.
	 *
	 * Uses incremental delta-merge (GAM pattern): instead of recomputing from all
	 * memories each time, maintains a persistent digest entry that's updated when
	 * new experiences are stored. Full regeneration only on explicit request or
	 * when digest exceeds 500 tokens (triggers compaction).
	 *
	 * @param projectPath - The project to generate a digest for
	 * @param maxMemories - Maximum memories to include in the digest (default 10)
	 * @param forceRegenerate - If true, recompute from scratch instead of delta-merge
	 * @returns A single formatted string, or null if no project memories exist
	 */
	async generateProjectDigest(
		projectPath: string,
		maxMemories: number = 10,
		forceRegenerate: boolean = false
	): Promise<string | null> {
		// Step 1: Check for existing digest
		const dirPath = this.getMemoryPath('project', undefined, projectPath);
		const lib = await this.readLibrary(dirPath);

		const existingDigest = lib.entries.find(
			(e) =>
				e.active &&
				e.scope === 'project' &&
				e.source === 'consolidation' &&
				e.tags.includes('system:project-digest')
		);

		if (existingDigest && !forceRegenerate) {
			return existingDigest.content;
		}

		// Step 2: Build from scratch
		const activeMemories = lib.entries.filter(
			(e) => e.active && !e.archived && !e.tags.includes('system:project-digest')
		);

		if (activeMemories.length === 0) return null;

		// Sort by combinedScore = effectivenessScore * 0.5 + confidence * 0.3 + (useCount > 0 ? 0.2 : 0)
		activeMemories.sort((a, b) => {
			const scoreA = a.effectivenessScore * 0.5 + a.confidence * 0.3 + (a.useCount > 0 ? 0.2 : 0);
			const scoreB = b.effectivenessScore * 0.5 + b.confidence * 0.3 + (b.useCount > 0 ? 0.2 : 0);
			return scoreB - scoreA;
		});

		const topN = activeMemories.slice(0, maxMemories);

		// Count by category
		const categoryCounts: Record<string, number> = {};
		for (const m of topN) {
			const categoryTag = m.tags.find((t) => t.startsWith('category:'));
			const category = categoryTag ? categoryTag.replace('category:', '') : m.type;
			categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
		}

		const patternCount = categoryCounts['pattern-established'] ?? 0;
		const problemCount = categoryCounts['problem-solved'] ?? 0;
		const decisionCount = categoryCounts['decision-made'] ?? 0;

		// Format digest lines
		const lines = topN.map((m) => {
			const categoryTag = m.tags.find((t) => t.startsWith('category:'));
			const category = categoryTag ? categoryTag.replace('category:', '') : m.type;
			const eff = m.effectivenessScore.toFixed(2);
			return `- [${category}] ${m.content} (eff: ${eff})`;
		});

		const projectName = path.basename(projectPath);
		const now = new Date().toISOString().split('T')[0];
		const digestContent = [
			`Project: ${projectName} | Updated: ${now}`,
			'---',
			`Patterns: ${patternCount} | Problems: ${problemCount} | Decisions: ${decisionCount}`,
			'',
			...lines,
			`(${activeMemories.length} project memories, showing top ${topN.length})`,
		].join('\n');

		// Step 3: Create or update the digest entry
		if (existingDigest) {
			// Update existing digest
			const idx = lib.entries.findIndex((e) => e.id === existingDigest.id);
			if (idx !== -1) {
				lib.entries[idx] = {
					...lib.entries[idx],
					content: digestContent,
					tokenEstimate: Math.ceil(digestContent.length / 4),
					updatedAt: Date.now(),
				};
				await this.writeLibrary(dirPath, lib);
			}
		} else {
			// Create new digest entry
			await this.addMemory(
				{
					content: digestContent,
					type: 'rule',
					scope: 'project',
					source: 'consolidation',
					confidence: 1.0,
					pinned: true,
					tags: ['system:project-digest'],
				},
				projectPath
			);
		}

		return digestContent;
	}

	/**
	 * Incrementally update an existing project digest with a new memory.
	 *
	 * Called from storeExperiences() when a new project-scoped memory is added.
	 * Appends a delta line to the existing digest. If total digest exceeds
	 * 500 tokens (estimated content.length / 4), triggers full recompaction.
	 *
	 * @param projectPath - The project path
	 * @param newMemory - The newly added memory entry
	 */
	async updateProjectDigest(projectPath: string, newMemory: MemoryEntry): Promise<void> {
		const dirPath = this.getMemoryPath('project', undefined, projectPath);
		const lib = await this.readLibrary(dirPath);

		const digestEntry = lib.entries.find(
			(e) =>
				e.active &&
				e.scope === 'project' &&
				e.source === 'consolidation' &&
				e.tags.includes('system:project-digest')
		);

		if (!digestEntry) {
			// No existing digest — generate a fresh one
			await this.generateProjectDigest(projectPath, 10, true);
			return;
		}

		// Append delta line
		const categoryTag = newMemory.tags.find((t) => t.startsWith('category:'));
		const category = categoryTag ? categoryTag.replace('category:', '') : newMemory.type;
		const eff = newMemory.effectivenessScore.toFixed(2);
		const deltaLine = `- [${category}] ${newMemory.content} (eff: ${eff})`;

		const updatedContent = digestEntry.content + '\n' + deltaLine;
		const estimatedTokens = Math.ceil(updatedContent.length / 4);

		if (estimatedTokens > 500) {
			// Exceeds budget — trigger full recompaction
			await this.generateProjectDigest(projectPath, 10, true);
			return;
		}

		// Update digest in place
		const idx = lib.entries.findIndex((e) => e.id === digestEntry.id);
		if (idx !== -1) {
			lib.entries[idx] = {
				...lib.entries[idx],
				content: updatedContent,
				tokenEstimate: estimatedTokens,
				updatedAt: Date.now(),
			};
			await this.writeLibrary(dirPath, lib);
		}
	}

	// ─── Seed Data ──────────────────────────────────────────────────────────

	/**
	 * Seed the hierarchy with default roles/personas/skills if registry is empty.
	 * Only runs if no roles exist yet.
	 */
	async seedFromDefaults(): Promise<{ roles: number; personas: number; skills: number }> {
		const registry = await this.readRegistry();
		if (registry.roles.length > 0) {
			return { roles: 0, personas: 0, skills: 0 };
		}

		let roleCount = 0;
		let personaCount = 0;
		let skillCount = 0;

		for (const seedRole of SEED_ROLES) {
			const role = await this.createRole(seedRole.name, seedRole.description);
			roleCount++;

			for (const seedPersona of seedRole.personas) {
				const persona = await this.createPersona(
					role.id,
					seedPersona.name,
					seedPersona.description
				);
				personaCount++;

				for (const skillName of seedPersona.skills) {
					await this.createSkillArea(persona.id, skillName, `${skillName} expertise`);
					skillCount++;
				}
			}
		}

		return { roles: roleCount, personas: personaCount, skills: skillCount };
	}
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let instance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
	if (!instance) {
		instance = new MemoryStore();
	}
	return instance;
}
