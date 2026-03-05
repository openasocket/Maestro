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
	SkillAreaSuggestion,
	PersonaSuggestion,
	PersonaRelevance,
	PromotionCandidate,
	MemoryStats,
} from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS, SEED_ROLES } from '../../shared/memory-types';
import { cosineSimilarity } from '../grpo/embedding-service';
import { MemoryChangeLog } from './memory-changelog';
import type { MemoryChangeEvent, MemoryChangeEventType } from './memory-changelog';

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
	readonly changelog: MemoryChangeLog;

	// ─── Registry Cache ────────────────────────────────────────────────────
	private registryCache: RegistryFile | null = null;
	private registryCacheTime = 0;
	private static readonly REGISTRY_CACHE_TTL = 30000; // 30 seconds

	// ─── Library Cache ─────────────────────────────────────────────────────
	private libraryCache = new Map<string, { entries: MemoryEntry[]; loadedAt: number }>();
	private static readonly LIBRARY_CACHE_TTL = 10000; // 10 seconds

	constructor() {
		this.memoriesDir = path.join(getConfigDir(), 'memories');
		this.changelog = new MemoryChangeLog(this.memoriesDir);
		this.changelog.load().catch(() => {});
	}

	/**
	 * Fire-and-forget emit a structured change event to the changelog.
	 */
	private emitChangeEvent(
		type: MemoryChangeEventType,
		memoryId: MemoryId,
		memoryContent: string,
		memoryType: MemoryType,
		scope: MemoryScope,
		triggeredBy: 'user' | 'system',
		source?: MemorySource,
		details?: string
	): void {
		this.changelog.emit({
			timestamp: Date.now(),
			type,
			memoryId,
			memoryContent: memoryContent.slice(0, 200),
			memoryType,
			scope,
			source,
			details,
			triggeredBy,
		});
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

	// ─── Cache Management ──────────────────────────────────────────────────

	/**
	 * Return the registry from cache if fresh, otherwise read from disk and cache.
	 * Used on the hot path (cascadingSearch) to avoid repeated file reads.
	 */
	async getCachedRegistry(): Promise<RegistryFile> {
		if (
			this.registryCache &&
			Date.now() - this.registryCacheTime < MemoryStore.REGISTRY_CACHE_TTL
		) {
			return this.registryCache;
		}
		const registry = await this.readRegistry();
		this.registryCache = registry;
		this.registryCacheTime = Date.now();
		return registry;
	}

	/** Invalidate the registry cache — called after any registry mutation. */
	private invalidateRegistryCache(): void {
		this.registryCache = null;
		this.registryCacheTime = 0;
	}

	/**
	 * Return library entries from cache if fresh, otherwise read from disk and cache.
	 * Used on the hot path (cascadingSearch) to avoid repeated library file reads.
	 */
	private async getCachedLibrary(dirPath: string): Promise<MemoryEntry[]> {
		const cached = this.libraryCache.get(dirPath);
		if (cached && Date.now() - cached.loadedAt < MemoryStore.LIBRARY_CACHE_TTL) {
			return cached.entries;
		}
		const lib = await this.readLibrary(dirPath);
		this.libraryCache.set(dirPath, { entries: lib.entries, loadedAt: Date.now() });
		return lib.entries;
	}

	/** Invalidate the library cache for a specific directory — called after writes. */
	private invalidateLibraryCache(dirPath: string): void {
		this.libraryCache.delete(dirPath);
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
		this.invalidateAnalyticsCache();
		this.invalidateRegistryCache();
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
		this.invalidateAnalyticsCache();
		this.invalidateLibraryCache(dirPath);
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

	async createRole(name: string, description: string, systemPrompt?: string): Promise<Role> {
		const registry = await this.readRegistry();
		const now = Date.now();
		const role: Role = {
			id: crypto.randomUUID(),
			name,
			description,
			systemPrompt: systemPrompt ?? '',
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
		updates: { name?: string; description?: string; systemPrompt?: string }
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
		assignedProjects?: string[],
		systemPrompt?: string
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
			systemPrompt: systemPrompt ?? '',
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
			systemPrompt?: string;
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
			effectivenessDelta: 0,
			effectivenessUpdatedAt: 0,
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
		const changeType: MemoryChangeEventType = entry.source === 'import' ? 'imported' : 'created';
		this.emitChangeEvent(
			changeType,
			memory.id,
			memory.content,
			memory.type,
			memory.scope,
			entry.source === 'extraction' || entry.source === 'consolidation' || entry.source === 'import'
				? 'system'
				: 'user',
			entry.source ?? 'user'
		);

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

		// Auto-eviction: when a skill area exceeds maxMemoriesPerSkillArea
		if (entry.scope === 'skill' && entry.skillAreaId) {
			const nonArchivedCount = lib.entries.filter((e) => e.active && !e.archived).length;
			const config = await this.getConfig();
			if (nonArchivedCount > config.maxMemoriesPerSkillArea) {
				this.evictMemories(entry.skillAreaId, config.maxMemoriesPerSkillArea).catch(() => {
					// Fire-and-forget — degrade gracefully
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
		const changedFields = Object.keys(updates).join(', ');
		this.emitChangeEvent(
			'updated',
			id,
			updated.content,
			updated.type,
			scope,
			'user',
			undefined,
			`Changed fields: ${changedFields}`
		);
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
		this.emitChangeEvent('deleted', id, entry.content, entry.type, scope, 'user');
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

	// ─── Multi-Dimensional Eviction ─────────────────────────────────────────

	/**
	 * Evict memories from a skill area when maxMemoriesPerSkillArea is exceeded.
	 *
	 * Uses a multi-dimensional eviction score based on the Agentic Engineering
	 * Book's compaction priority (correctness > completeness > signal > trajectory):
	 *
	 * evictionScore =
	 *   (1 - effectivenessScore) * 0.4   // Low effectiveness = evict first (correctness proxy)
	 *   + (1 - confidence) * 0.3          // Low confidence = evict first (completeness proxy)
	 *   + (useCount === 0 ? 0.2 : 0)     // Never injected = evict first (signal proxy)
	 *   + recencyPenalty * 0.1            // Older = slightly more evictable (trajectory proxy)
	 *
	 * Pinned memories always score 0 (never evicted).
	 * Memories from the last 3 sessions get a -0.3 bonus (trajectory protection).
	 * Evicted memories are archived, not deleted.
	 */
	async evictMemories(skillAreaId: SkillAreaId, maxCount: number): Promise<number> {
		const dirPath = this.getMemoryPath('skill', skillAreaId);
		const lib = await this.readLibrary(dirPath);
		const now = Date.now();
		const msPerDay = 86400000;
		const thirtyDaysMs = 30 * msPerDay;
		const twentyFourHoursMs = 24 * 60 * 60 * 1000;

		// Only consider active, non-archived memories
		const candidates = lib.entries.filter((e) => e.active && !e.archived);
		if (candidates.length <= maxCount) return 0;

		// Compute eviction score for each candidate
		const scored = candidates.map((entry) => {
			if (entry.pinned) return { entry, score: 0 };

			const effectivenessComponent = (1 - entry.effectivenessScore) * 0.4;
			const confidenceComponent = (1 - entry.confidence) * 0.3;
			const signalComponent = entry.useCount === 0 ? 0.2 : 0;
			const isOlderThan30Days = now - entry.createdAt > thirtyDaysMs;
			const recencyComponent = isOlderThan30Days ? 0.1 : 0;

			let score = effectivenessComponent + confidenceComponent + signalComponent + recencyComponent;

			// Trajectory protection: recent memories (last 24h) get a -0.3 bonus
			const isRecent = now - entry.createdAt < twentyFourHoursMs;
			if (isRecent) {
				score -= 0.3;
			}

			return { entry, score };
		});

		// Sort by eviction score descending (highest = most evictable)
		scored.sort((a, b) => b.score - a.score);

		// Archive the top N to get back to maxCount
		const toEvict = candidates.length - maxCount;
		let evictedCount = 0;
		const historyEntries: MemoryHistoryEntry[] = [];

		for (let i = 0; i < scored.length && evictedCount < toEvict; i++) {
			const { entry, score } = scored[i];
			// Never evict pinned memories
			if (entry.pinned) continue;

			const idx = lib.entries.findIndex((e) => e.id === entry.id);
			if (idx !== -1) {
				lib.entries[idx] = {
					...lib.entries[idx],
					archived: true,
					updatedAt: now,
				};
				evictedCount++;

				historyEntries.push({
					timestamp: now,
					operation: 'evict',
					entityType: 'memory',
					entityId: entry.id,
					content: entry.content.slice(0, 200),
					reason: `evictionScore=${score.toFixed(3)}, eff=${entry.effectivenessScore.toFixed(2)}, conf=${entry.confidence.toFixed(2)}, uses=${entry.useCount}`,
				});
				this.emitChangeEvent(
					'pruned',
					entry.id,
					entry.content,
					entry.type,
					'skill',
					'system',
					undefined,
					`Evicted: score=${score.toFixed(3)}, confidence=${entry.confidence.toFixed(2)}`
				);
			}
		}

		if (evictedCount > 0) {
			await this.writeLibrary(dirPath, lib);
			for (const h of historyEntries) {
				await this.appendHistory(dirPath, h);
			}
		}

		return evictedCount;
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
		let results: MemorySearchResult[] = [];
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

		// 1-hop graph expansion: add linked memories from top results
		const topResults = results.slice(0, 3);
		const linkedMemoryIds = new Set<MemoryId>();
		const existingIds = new Set(results.map((r) => r.entry.id));

		for (const result of topResults) {
			const linked = result.entry.relatedMemoryIds ?? [];
			for (const linkedId of linked) {
				if (!existingIds.has(linkedId)) {
					linkedMemoryIds.add(linkedId);
				}
			}
		}

		if (linkedMemoryIds.size > 0 && topResults.length > 0) {
			const topScore = topResults[0].combinedScore;
			const topSimilarity = topResults[0].similarity;
			for (const linkedId of linkedMemoryIds) {
				const linked = await this.findMemoryById(linkedId);
				if (linked && linked.active && !linked.archived) {
					results.push({
						entry: linked,
						similarity: topSimilarity * 0.8,
						combinedScore: topScore * 0.8,
					});
					existingIds.add(linkedId);
				}
			}

			// Re-sort and deduplicate
			results.sort((a, b) => b.combinedScore - a.combinedScore);
			const seen = new Set<MemoryId>();
			results = results.filter((r) => {
				if (seen.has(r.entry.id)) return false;
				seen.add(r.entry.id);
				return true;
			});
		}

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
			const stored = JSON.parse(content);
			if (stored._configVersion == null) {
				// Pre-migration config: old defaults had enabled=false, so no user
				// deliberately disabled memory. Apply new defaults and stamp version.
				const migrated = { ...MEMORY_CONFIG_DEFAULTS };
				console.log(
					'[memory] Migrating pre-v1 config to new defaults (enabled=true, strategy=lean)'
				);
				await this.atomicWriteJson(this.getConfigPath(), migrated);
				return migrated;
			}
			return { ...MEMORY_CONFIG_DEFAULTS, ...stored };
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

	/**
	 * Clear all existing embeddings and re-embed everything using the current active provider.
	 * Used when switching embedding providers (different vector spaces are incompatible).
	 */
	async reEmbedAll(options?: {
		scope?: MemoryScope;
		batchSize?: number;
	}): Promise<{ total: number; succeeded: number; failed: number; durationMs: number }> {
		const start = Date.now();
		const batchSize = options?.batchSize ?? 50;
		let total = 0;
		let succeeded = 0;
		let failed = 0;

		const { encodeBatch } = await import('../grpo/embedding-service');

		// Helper: clear + re-embed a single library file
		const processLibrary = async (dirPath: string): Promise<void> => {
			const lib = await this.readLibrary(dirPath);
			const active = lib.entries.filter((e) => e.active && !e.archived);
			if (active.length === 0) return;

			// Clear all embeddings first
			for (const entry of lib.entries) {
				entry.embedding = null;
			}

			total += active.length;

			// Re-embed in batches
			for (let i = 0; i < active.length; i += batchSize) {
				const batch = active.slice(i, i + batchSize);
				const texts = batch.map((e) => e.content);
				try {
					const embeddings = await encodeBatch(texts);
					for (let j = 0; j < batch.length; j++) {
						const idx = lib.entries.findIndex((e) => e.id === batch[j].id);
						if (idx !== -1) {
							lib.entries[idx].embedding = embeddings[j];
							succeeded++;
						}
					}
				} catch {
					failed += batch.length;
				}
			}

			await this.writeLibrary(dirPath, lib);
		};

		const registry = await this.readRegistry();

		// Process based on scope filter or all scopes
		const processSkill = !options?.scope || options.scope === 'skill';
		const processGlobal = !options?.scope || options.scope === 'global';
		const processProject = !options?.scope || options.scope === 'project';

		if (processSkill) {
			for (const skill of registry.skillAreas) {
				try {
					await processLibrary(this.getMemoryPath('skill', skill.id));
				} catch {
					// Library may not exist
				}
			}
		}

		if (processGlobal) {
			try {
				await processLibrary(this.getMemoryPath('global'));
			} catch {
				// Library may not exist
			}
		}

		if (processProject) {
			try {
				const projectsDir = path.join(this.memoriesDir, 'project');
				const dirEntries = await fs.readdir(projectsDir).catch(() => [] as string[]);
				for (const dirName of dirEntries) {
					try {
						await processLibrary(path.join(projectsDir, dirName));
					} catch {
						// Skip
					}
				}
			} catch {
				// No projects dir
			}
		}

		// Re-embed hierarchy (personas + skill areas)
		if (!options?.scope) {
			// Clear hierarchy embeddings
			for (const persona of registry.personas) {
				persona.embedding = null;
			}
			for (const skill of registry.skillAreas) {
				skill.embedding = null;
			}
			await this.writeRegistry(registry);

			// Re-compute
			await this.ensureHierarchyEmbeddings();
		}

		return { total, succeeded, failed, durationMs: Date.now() - start };
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
	 * Select personas matching a query — standalone entry point for persona selection
	 * without running a full cascading memory search.
	 *
	 * Encodes the query internally. For callers that already have an embedding,
	 * use `selectMatchingPersonasWithEmbedding()` instead (private).
	 */
	async selectMatchingPersonas(
		query: string,
		config: MemoryConfig,
		agentType: string,
		projectPath?: string
	): Promise<
		Array<{
			persona: Persona;
			personaName: string;
			roleName: string;
			roleSystemPrompt: string;
			similarity: number;
		}>
	> {
		const { encode } = await import('../grpo/embedding-service');
		const queryEmbedding = await encode(query.slice(0, 2000));
		return this.selectMatchingPersonasWithEmbedding(queryEmbedding, config, agentType, projectPath);
	}

	/**
	 * Internal persona matcher that accepts a pre-computed embedding.
	 * Used by both `selectMatchingPersonas()` and `cascadingSearch()` to avoid
	 * double-encoding the query.
	 */
	private async selectMatchingPersonasWithEmbedding(
		queryEmbedding: number[],
		config: MemoryConfig,
		agentType: string,
		projectPath?: string
	): Promise<
		Array<{
			persona: Persona;
			personaName: string;
			roleName: string;
			roleSystemPrompt: string;
			similarity: number;
		}>
	> {
		const registry = await this.getCachedRegistry();
		const roleById = new Map(registry.roles.map((r) => [r.id, r]));

		const matches: Array<{
			persona: Persona;
			personaName: string;
			roleName: string;
			roleSystemPrompt: string;
			similarity: number;
		}> = [];

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
			let similarity = 1.0;
			if (persona.embedding) {
				similarity = cosineSimilarity(queryEmbedding, persona.embedding);
				if (similarity < config.personaMatchThreshold) continue;
			}

			const role = roleById.get(persona.roleId);
			matches.push({
				persona,
				personaName: persona.name,
				roleName: role?.name ?? '',
				roleSystemPrompt: role?.systemPrompt ?? '',
				similarity,
			});
		}

		matches.sort((a, b) => b.similarity - a.similarity);
		return matches;
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
		// Auto-seed hierarchy on first search if empty
		await this.ensureHierarchyInitialized();

		// Try to encode the query; if embedding model isn't ready, fall back to
		// keyword+tag search on project+global scopes (no persona matching).
		let queryEmbedding: number[] | null = null;
		try {
			const { encode } = await import('../grpo/embedding-service');
			queryEmbedding = await encode(query.slice(0, 2000));
		} catch {
			// Embedding service unavailable — use fallback path
		}

		if (!queryEmbedding) {
			console.log(
				'[memory] Persona matching unavailable (embeddings not computed). Falling back to project+global search.'
			);
			return this.fallbackFlatSearch(query, config, projectPath, limit);
		}

		const registry = await this.getCachedRegistry();
		const hierarchyResults: MemorySearchResult[] = [];

		// ── Level 1: Persona matching (delegated to shared helper) ───────
		const matchedPersonas = await this.selectMatchingPersonasWithEmbedding(
			queryEmbedding,
			config,
			agentType,
			projectPath
		);

		// ── Level 2: Skill area matching ─────────────────────────────────
		const matchedSkills: Array<{
			skill: (typeof registry.skillAreas)[0];
			personaName: string;
			personaSystemPrompt: string;
			personaId: string;
			roleName: string;
			roleSystemPrompt: string;
			skillAreaName: string;
		}> = [];

		for (const { persona, personaName, roleName, roleSystemPrompt } of matchedPersonas) {
			for (const skillId of persona.skillAreaIds) {
				const skill = registry.skillAreas.find((s) => s.id === skillId);
				if (!skill || !skill.active) continue;

				// Embedding filter: if skill has embedding, check threshold; if not, include it
				if (skill.embedding) {
					const sim = cosineSimilarity(queryEmbedding, skill.embedding);
					if (sim < config.skillMatchThreshold) continue;
				}

				matchedSkills.push({
					skill,
					personaName,
					personaSystemPrompt: persona.systemPrompt ?? '',
					personaId: persona.id,
					roleName,
					roleSystemPrompt,
					skillAreaName: skill.name,
				});
			}
		}

		// ── Level 3: Memory search within matched skill areas ────────────
		if (config.enableHybridSearch) {
			// Hybrid: use multi-signal search (embedding + keyword + tag)
			for (const {
				skill,
				personaName,
				personaSystemPrompt,
				personaId,
				roleName,
				roleSystemPrompt,
				skillAreaName,
			} of matchedSkills) {
				const skillResults = await this.hybridSearch(
					query,
					'skill',
					config,
					skill.id,
					undefined,
					50
				);
				for (const r of skillResults) {
					hierarchyResults.push({
						...r,
						roleName,
						roleSystemPrompt,
						personaName,
						personaSystemPrompt,
						personaId,
						skillAreaName,
					});
				}
			}
		} else {
			// Embedding-only (legacy behavior)
			for (const {
				skill,
				personaName,
				personaSystemPrompt,
				personaId,
				roleName,
				roleSystemPrompt,
				skillAreaName,
			} of matchedSkills) {
				const dirPath = this.getMemoryPath('skill', skill.id);
				const entries = await this.getCachedLibrary(dirPath);

				for (const entry of entries) {
					if (!entry.active || entry.archived || !entry.embedding) continue;

					const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
					if (similarity < config.similarityThreshold) continue;

					hierarchyResults.push({
						entry,
						similarity,
						combinedScore: this.computeCombinedScore(similarity, entry, config.decayHalfLifeDays),
						roleName,
						roleSystemPrompt,
						personaName,
						personaSystemPrompt,
						personaId,
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

	/**
	 * Fallback search when embedding model is unavailable or persona embeddings
	 * haven't been computed yet. Searches project-scoped and global memories
	 * using hybrid search (keyword + tag signals only; embedding component
	 * gracefully returns empty inside hybridSearch).
	 */
	private async fallbackFlatSearch(
		query: string,
		config: MemoryConfig,
		projectPath?: string,
		limit: number = 30
	): Promise<MemorySearchResult[]> {
		const searches: Promise<MemorySearchResult[]>[] = [this.hybridSearch(query, 'global', config)];
		if (projectPath) {
			searches.push(this.hybridSearch(query, 'project', config, undefined, projectPath));
		}

		const allResults = (await Promise.all(searches)).flat();

		// De-duplicate and rank
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
		const now = Date.now();
		for (const entry of lib.entries) {
			if (idSet.has(entry.id)) {
				const oldScore = entry.effectivenessScore;
				const newScore = Math.min(1, Math.max(0, 0.3 * outcomeScore + 0.7 * oldScore));
				entry.effectivenessDelta = newScore - oldScore;
				entry.effectivenessUpdatedAt = now;
				entry.effectivenessScore = newScore;
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

			// Effectiveness decay: extra 0.05/day penalty for consistently unhelpful memories
			// (effectivenessScore < 0.2 after 10+ injections — outcome-based, not time-based)
			if (entry.useCount >= 10 && entry.effectivenessScore < 0.2) {
				entry.confidence = Math.max(0, entry.confidence - 0.05);
			}

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

				// Inherit relatedMemoryIds from all cluster members
				const allRelated = new Set<MemoryId>(center.relatedMemoryIds ?? []);
				const absorbedIdSet = new Set<MemoryId>(cluster.map((m) => m.id));
				for (const member of cluster) {
					for (const relId of member.relatedMemoryIds ?? []) {
						allRelated.add(relId);
					}
				}
				// Remove self-references and absorbed IDs from merged links
				allRelated.delete(center.id);
				for (const absId of absorbedIdSet) {
					allRelated.delete(absId);
				}

				// Update center entry
				lib.entries[centerIdx] = {
					...lib.entries[centerIdx],
					tags: [...allTags],
					confidence: avgConfidence,
					effectivenessScore: maxEffectiveness,
					useCount: totalUseCount,
					relatedMemoryIds: allRelated.size > 0 ? [...allRelated] : undefined,
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

				// Update links in other memories: replace absorbed IDs → center ID
				for (const entry of lib.entries) {
					if (!entry.relatedMemoryIds || entry.id === center.id) continue;
					let changed = false;
					const newLinks: MemoryId[] = [];
					for (const relId of entry.relatedMemoryIds) {
						if (absorbedIdSet.has(relId)) {
							if (!newLinks.includes(center.id) && entry.id !== center.id) {
								newLinks.push(center.id);
							}
							changed = true;
						} else {
							newLinks.push(relId);
						}
					}
					if (changed) {
						entry.relatedMemoryIds = newLinks.length > 0 ? [...new Set(newLinks)] : undefined;
						entry.updatedAt = now;
					}
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
				this.emitChangeEvent(
					'consolidated',
					center.id,
					center.content,
					center.type,
					scope,
					'system',
					'consolidation',
					`Merged ${cluster.length} memories`
				);

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

	// ─── Inter-Memory Linking (Zettelkasten) ─────────────────────────────────

	/**
	 * Create a bidirectional link between two memories.
	 * Both memories are updated to reference each other.
	 * No-op if the link already exists.
	 */
	async linkMemories(
		idA: MemoryId,
		scopeA: MemoryScope,
		idB: MemoryId,
		scopeB: MemoryScope,
		skillAreaIdA?: string,
		projectPathA?: string,
		skillAreaIdB?: string,
		projectPathB?: string
	): Promise<void> {
		if (idA === idB) return; // No self-links

		// Load and update memory A
		const dirA = this.getMemoryPath(scopeA, skillAreaIdA as SkillAreaId, projectPathA);
		const libA = await this.readLibrary(dirA);
		const entryA = libA.entries.find((e) => e.id === idA);
		if (!entryA) throw new Error(`Memory not found: ${idA}`);

		const linksA = entryA.relatedMemoryIds ?? [];
		if (!linksA.includes(idB)) {
			entryA.relatedMemoryIds = [...new Set([...linksA, idB])];
			entryA.updatedAt = Date.now();
			await this.writeLibrary(dirA, libA);
		}

		// Load and update memory B
		const dirB = this.getMemoryPath(scopeB, skillAreaIdB as SkillAreaId, projectPathB);
		const libB = dirA === dirB ? await this.readLibrary(dirB) : await this.readLibrary(dirB);
		const entryB = libB.entries.find((e) => e.id === idB);
		if (!entryB) throw new Error(`Memory not found: ${idB}`);

		const linksB = entryB.relatedMemoryIds ?? [];
		if (!linksB.includes(idA)) {
			entryB.relatedMemoryIds = [...new Set([...linksB, idA])];
			entryB.updatedAt = Date.now();
			await this.writeLibrary(dirB, libB);
		}
	}

	/**
	 * Remove a bidirectional link between two memories.
	 */
	async unlinkMemories(
		idA: MemoryId,
		scopeA: MemoryScope,
		idB: MemoryId,
		scopeB: MemoryScope,
		skillAreaIdA?: string,
		projectPathA?: string,
		skillAreaIdB?: string,
		projectPathB?: string
	): Promise<void> {
		// Update memory A
		const dirA = this.getMemoryPath(scopeA, skillAreaIdA as SkillAreaId, projectPathA);
		const libA = await this.readLibrary(dirA);
		const entryA = libA.entries.find((e) => e.id === idA);
		if (entryA && entryA.relatedMemoryIds) {
			entryA.relatedMemoryIds = entryA.relatedMemoryIds.filter((id) => id !== idB);
			if (entryA.relatedMemoryIds.length === 0) {
				delete entryA.relatedMemoryIds;
			}
			entryA.updatedAt = Date.now();
			await this.writeLibrary(dirA, libA);
		}

		// Update memory B
		const dirB = this.getMemoryPath(scopeB, skillAreaIdB as SkillAreaId, projectPathB);
		const libB = await this.readLibrary(dirB);
		const entryB = libB.entries.find((e) => e.id === idB);
		if (entryB && entryB.relatedMemoryIds) {
			entryB.relatedMemoryIds = entryB.relatedMemoryIds.filter((id) => id !== idA);
			if (entryB.relatedMemoryIds.length === 0) {
				delete entryB.relatedMemoryIds;
			}
			entryB.updatedAt = Date.now();
			await this.writeLibrary(dirB, libB);
		}
	}

	/**
	 * Get all memories linked to a given memory (1-hop traversal).
	 * Loads the linked memories by scanning all scopes (bare ID approach).
	 */
	async getLinkedMemories(
		id: MemoryId,
		scope: MemoryScope,
		skillAreaId?: string,
		projectPath?: string
	): Promise<MemoryEntry[]> {
		const dirPath = this.getMemoryPath(scope, skillAreaId as SkillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const entry = lib.entries.find((e) => e.id === id);
		if (!entry || !entry.relatedMemoryIds || entry.relatedMemoryIds.length === 0) {
			return [];
		}

		const linkedIds = new Set(entry.relatedMemoryIds);
		const results: MemoryEntry[] = [];

		// Scan all scopes to find linked memories by ID
		for (const linkedId of linkedIds) {
			const found = await this.findMemoryById(linkedId);
			if (found) {
				results.push(found);
			}
		}

		return results;
	}

	/**
	 * Find a memory by ID across all scopes (linear scan).
	 * With typical memory counts (<500), this is fast enough.
	 */
	async findMemoryById(id: MemoryId): Promise<MemoryEntry | null> {
		// Check global
		try {
			const globalDir = this.getMemoryPath('global');
			const globalLib = await this.readLibrary(globalDir);
			const found = globalLib.entries.find((e) => e.id === id);
			if (found) return found;
		} catch {
			// Scope dir missing — skip
		}

		// Check all skill areas
		try {
			const registry = await this.readRegistry();
			for (const skill of registry.skillAreas) {
				try {
					const skillDir = this.getMemoryPath('skill', skill.id);
					const skillLib = await this.readLibrary(skillDir);
					const found = skillLib.entries.find((e) => e.id === id);
					if (found) return found;
				} catch {
					// Skill dir missing — skip
				}
			}
		} catch {
			// Registry missing — skip
		}

		// Check project scopes — scan project directory for hashed subdirs
		try {
			const projectsDir = path.join(this.memoriesDir, 'project');
			const entries = await fs.readdir(projectsDir).catch(() => [] as string[]);
			for (const dirName of entries) {
				try {
					const projectDir = path.join(projectsDir, dirName);
					const lib = await this.readLibrary(projectDir);
					const found = lib.entries.find((e) => e.id === id);
					if (found) return found;
				} catch {
					// Skip
				}
			}
		} catch {
			// No projects dir — skip
		}

		return null;
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

	// ─── Hierarchy Suggestions ──────────────────────────────────────────────

	/**
	 * Analyze project-scoped memories that aren't in any skill area and suggest
	 * new skill areas based on tag clustering.
	 *
	 * Triggered when 3+ project-scoped memories share >50% tag overlap, indicating
	 * a coherent domain that deserves its own skill area.
	 *
	 * @returns Array of suggestions (not auto-applied — requires user approval or auto-mode)
	 */
	async suggestSkillAreas(projectPath: string): Promise<SkillAreaSuggestion[]> {
		// Load all project-scoped memories
		const dirPath = this.getMemoryPath('project', undefined, projectPath);
		const lib = await this.readLibrary(dirPath);
		const activeMemories = lib.entries.filter((e) => e.active && !e.archived && e.tags.length > 0);

		if (activeMemories.length < 3) return [];

		const totalProjectMemories = activeMemories.length;

		// Compute Jaccard tag overlap between all pairs
		type MemWithTags = { entry: MemoryEntry; tagSet: Set<string> };
		const memTags: MemWithTags[] = activeMemories.map((e) => ({
			entry: e,
			tagSet: new Set(e.tags.map((t) => t.toLowerCase())),
		}));

		// Greedy clustering: start with highest-overlap pairs, expand
		const clustered = new Set<string>(); // memory IDs already in a cluster
		const clusters: MemWithTags[][] = [];

		// Build pair overlaps sorted descending
		const pairs: { i: number; j: number; overlap: number }[] = [];
		for (let i = 0; i < memTags.length; i++) {
			for (let j = i + 1; j < memTags.length; j++) {
				const a = memTags[i].tagSet;
				const b = memTags[j].tagSet;
				let intersection = 0;
				for (const t of a) {
					if (b.has(t)) intersection++;
				}
				const union = new Set([...a, ...b]).size;
				const overlap = union > 0 ? intersection / union : 0;
				if (overlap > 0.5) {
					pairs.push({ i, j, overlap });
				}
			}
		}
		pairs.sort((a, b) => b.overlap - a.overlap);

		for (const { i, j } of pairs) {
			if (clustered.has(memTags[i].entry.id) && clustered.has(memTags[j].entry.id)) continue;

			// Find or create cluster
			let cluster: MemWithTags[] | undefined;
			if (clustered.has(memTags[i].entry.id)) {
				cluster = clusters.find((c) => c.some((m) => m.entry.id === memTags[i].entry.id));
			} else if (clustered.has(memTags[j].entry.id)) {
				cluster = clusters.find((c) => c.some((m) => m.entry.id === memTags[j].entry.id));
			}

			if (cluster) {
				// Add the non-clustered member if it has >50% overlap with any cluster member
				const newMem = clustered.has(memTags[i].entry.id) ? memTags[j] : memTags[i];
				if (clustered.has(newMem.entry.id)) continue;
				const hasOverlap = cluster.some((m) => {
					let inter = 0;
					for (const t of m.tagSet) {
						if (newMem.tagSet.has(t)) inter++;
					}
					const unionSize = new Set([...m.tagSet, ...newMem.tagSet]).size;
					return unionSize > 0 && inter / unionSize > 0.5;
				});
				if (hasOverlap) {
					cluster.push(newMem);
					clustered.add(newMem.entry.id);
				}
			} else {
				// Start a new cluster
				const newCluster = [memTags[i], memTags[j]];
				clustered.add(memTags[i].entry.id);
				clustered.add(memTags[j].entry.id);
				clusters.push(newCluster);
			}
		}

		// Expand clusters: try to add unclustered memories with >50% overlap
		for (const cluster of clusters) {
			for (const mt of memTags) {
				if (clustered.has(mt.entry.id)) continue;
				const hasOverlap = cluster.some((m) => {
					let inter = 0;
					for (const t of m.tagSet) {
						if (mt.tagSet.has(t)) inter++;
					}
					const unionSize = new Set([...m.tagSet, ...mt.tagSet]).size;
					return unionSize > 0 && inter / unionSize > 0.5;
				});
				if (hasOverlap) {
					cluster.push(mt);
					clustered.add(mt.entry.id);
				}
			}
		}

		// Filter clusters with < 3 members
		const validClusters = clusters.filter((c) => c.length >= 3);
		if (validClusters.length === 0) return [];

		// Load registry for persona matching
		const registry = await this.readRegistry();
		const activePersonas = registry.personas.filter((p) => p.active);

		const suggestions: SkillAreaSuggestion[] = [];

		for (const cluster of validClusters) {
			// Compute shared tags (appear in >50% of cluster members)
			const tagCounts = new Map<string, number>();
			for (const m of cluster) {
				for (const t of m.tagSet) {
					tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
				}
			}
			const threshold = cluster.length / 2;
			const sharedTags = [...tagCounts.entries()]
				.filter(([, count]) => count >= threshold)
				.sort((a, b) => b[1] - a[1])
				.map(([tag]) => tag);

			// Derive skill area name from most common non-prefix tags
			const nameTags = sharedTags
				.filter((t) => !t.startsWith('kw:') && !t.startsWith('category:'))
				.slice(0, 3);
			const suggestedName =
				nameTags.length > 0
					? nameTags
							.map((t) =>
								t
									.split('-')
									.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
									.join(' ')
							)
							.join(' & ')
					: sharedTags
							.slice(0, 2)
							.map((t) => {
								const clean = t.replace(/^(kw:|category:)/, '');
								return clean
									.split('-')
									.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
									.join(' ');
							})
							.join(' & ');

			// Find best-matching persona by embedding similarity
			let bestPersonaId = activePersonas[0]?.id ?? '';
			let bestPersonaName = activePersonas[0]?.name ?? 'Unknown';

			if (activePersonas.length > 0) {
				// Try embedding similarity if available
				const memoriesWithEmbeddings = cluster.filter((m) => m.entry.embedding !== null);
				if (memoriesWithEmbeddings.length > 0) {
					// Average the cluster embeddings
					const dim = memoriesWithEmbeddings[0].entry.embedding!.length;
					const avgEmbed = new Array(dim).fill(0);
					for (const m of memoriesWithEmbeddings) {
						for (let i = 0; i < dim; i++) {
							avgEmbed[i] += m.entry.embedding![i];
						}
					}
					for (let i = 0; i < dim; i++) {
						avgEmbed[i] /= memoriesWithEmbeddings.length;
					}

					let bestSim = -1;
					for (const persona of activePersonas) {
						if (!persona.embedding) continue;
						const sim = cosineSimilarity(avgEmbed, persona.embedding);
						if (sim > bestSim) {
							bestSim = sim;
							bestPersonaId = persona.id;
							bestPersonaName = persona.name;
						}
					}
				}
			}

			// Compute average tag overlap for this cluster
			let totalOverlap = 0;
			let overlapPairs = 0;
			for (let i = 0; i < cluster.length; i++) {
				for (let j = i + 1; j < cluster.length; j++) {
					let inter = 0;
					for (const t of cluster[i].tagSet) {
						if (cluster[j].tagSet.has(t)) inter++;
					}
					const unionSize = new Set([...cluster[i].tagSet, ...cluster[j].tagSet]).size;
					totalOverlap += unionSize > 0 ? inter / unionSize : 0;
					overlapPairs++;
				}
			}
			const avgOverlap = overlapPairs > 0 ? totalOverlap / overlapPairs : 0;
			const confidence = Math.min(1, (cluster.length / totalProjectMemories) * avgOverlap);

			suggestions.push({
				suggestedName,
				suggestedDescription: `${suggestedName} patterns derived from ${cluster.length} project memories`,
				suggestedPersonaId: bestPersonaId,
				suggestedPersonaName: bestPersonaName,
				memoryIds: cluster.map((m) => m.entry.id),
				sharedTags,
				confidence,
			});
		}

		// Sort by confidence descending
		suggestions.sort((a, b) => b.confidence - a.confidence);
		return suggestions;
	}

	/**
	 * Analyze a project's file structure and suggest personas that match
	 * the technologies and patterns detected.
	 *
	 * Uses file extension mapping + package file analysis to recommend
	 * personas from SEED_ROLES or suggest new ones.
	 *
	 * This method only does file I/O (readdir + readFile for package files).
	 * It does NOT spawn an LLM. Keep it fast (<2 seconds).
	 */
	async suggestPersonas(projectPath: string): Promise<PersonaSuggestion[]> {
		const suggestions: PersonaSuggestion[] = [];

		// Read top level + 1 level deep
		const extensionCounts = new Map<string, number>();
		const detectedTechs: Set<string> = new Set();
		const evidence: Map<string, string[]> = new Map();

		const addEvidence = (tech: string, ev: string) => {
			if (!evidence.has(tech)) evidence.set(tech, []);
			evidence.get(tech)!.push(ev);
		};

		try {
			const topEntries = await fs.readdir(projectPath, { withFileTypes: true });

			for (const entry of topEntries) {
				if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

				if (entry.isFile()) {
					const ext = path.extname(entry.name).toLowerCase();
					if (ext) {
						extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
					}
				} else if (entry.isDirectory()) {
					try {
						const subEntries = await fs.readdir(path.join(projectPath, entry.name), {
							withFileTypes: true,
						});
						for (const subEntry of subEntries) {
							if (subEntry.isFile()) {
								const ext = path.extname(subEntry.name).toLowerCase();
								if (ext) {
									extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
								}
							}
						}
					} catch {
						// Skip unreadable directories
					}
				}
			}

			// Check for package/project files
			const topFileNames = new Set(topEntries.filter((e) => e.isFile()).map((e) => e.name));

			// package.json → check deps
			if (topFileNames.has('package.json')) {
				try {
					const pkgContent = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
					const pkg = JSON.parse(pkgContent);
					const allDeps = {
						...(pkg.dependencies ?? {}),
						...(pkg.devDependencies ?? {}),
					};

					if (allDeps.react || allDeps['react-dom']) {
						detectedTechs.add('react');
						addEvidence('react', 'react dependency in package.json');
					}
					if (allDeps.next) {
						detectedTechs.add('nextjs');
						addEvidence('nextjs', 'next dependency in package.json');
					}
					if (allDeps.express) {
						detectedTechs.add('express');
						addEvidence('express', 'express dependency in package.json');
					}
					if (allDeps.vue) {
						detectedTechs.add('vue');
						addEvidence('vue', 'vue dependency in package.json');
					}
					if (allDeps.angular || allDeps['@angular/core']) {
						detectedTechs.add('angular');
						addEvidence('angular', 'angular dependency in package.json');
					}
					if (allDeps.electron) {
						detectedTechs.add('electron');
						addEvidence('electron', 'electron dependency in package.json');
					}
				} catch {
					// Invalid package.json
				}
			}

			if (topFileNames.has('Cargo.toml')) {
				detectedTechs.add('rust');
				addEvidence('rust', 'Cargo.toml present');
			}
			if (topFileNames.has('go.mod')) {
				detectedTechs.add('go');
				addEvidence('go', 'go.mod present');
			}
			if (topFileNames.has('pyproject.toml') || topFileNames.has('requirements.txt')) {
				detectedTechs.add('python');
				const file = topFileNames.has('pyproject.toml') ? 'pyproject.toml' : 'requirements.txt';
				addEvidence('python', `${file} present`);

				// Check for Python frameworks
				try {
					const content = await fs.readFile(path.join(projectPath, file), 'utf-8');
					if (content.includes('fastapi') || content.includes('FastAPI')) {
						detectedTechs.add('fastapi');
						addEvidence('fastapi', `fastapi reference in ${file}`);
					}
					if (content.includes('django') || content.includes('Django')) {
						detectedTechs.add('django');
						addEvidence('django', `django reference in ${file}`);
					}
					if (content.includes('flask') || content.includes('Flask')) {
						detectedTechs.add('flask');
						addEvidence('flask', `flask reference in ${file}`);
					}
				} catch {
					// Skip
				}
			}
			if (topFileNames.has('tsconfig.json')) {
				detectedTechs.add('typescript');
				addEvidence('typescript', 'tsconfig.json present');
			}
			if (
				topFileNames.has('Dockerfile') ||
				topFileNames.has('docker-compose.yml') ||
				topFileNames.has('docker-compose.yaml')
			) {
				detectedTechs.add('docker');
				const dockerFile = topFileNames.has('Dockerfile') ? 'Dockerfile' : 'docker-compose.yml';
				addEvidence('docker', `${dockerFile} present`);
			}
		} catch {
			// Can't read project path — return empty
			return [];
		}

		// Add extension-based evidence
		const tsxCount = extensionCounts.get('.tsx') ?? 0;
		const tsCount = extensionCounts.get('.ts') ?? 0;
		const rsCount = extensionCounts.get('.rs') ?? 0;
		const pyCount = extensionCounts.get('.py') ?? 0;
		const goCount = extensionCounts.get('.go') ?? 0;

		if (tsxCount > 0) addEvidence('react', `${tsxCount} .tsx files`);
		if (tsCount > 0) addEvidence('typescript', `${tsCount} .ts files`);
		if (rsCount > 0) addEvidence('rust', `${rsCount} .rs files`);
		if (pyCount > 0) addEvidence('python', `${pyCount} .py files`);
		if (goCount > 0) addEvidence('go', `${goCount} .go files`);

		// Load existing personas to skip duplicates
		const registry = await this.readRegistry();
		const existingPersonaNames = new Set(registry.personas.map((p) => p.name.toLowerCase()));

		// Map technologies to persona suggestions
		const techToPersona: Array<{
			techs: string[];
			name: string;
			description: string;
			role: string;
			skills: string[];
		}> = [
			{
				techs: ['react'],
				name: 'React Frontend Engineer',
				description: 'React/TypeScript frontend development with modern patterns and tooling',
				role: 'Software Developer',
				skills: ['State Management', 'Component Design', 'Performance', 'Testing', 'Accessibility'],
			},
			{
				techs: ['rust'],
				name: 'Rust Systems Developer',
				description:
					'Systems programming in Rust with focus on safety, performance, and correctness',
				role: 'Software Developer',
				skills: ['Error Handling', 'Performance', 'Testing', 'Memory Safety', 'Async/Concurrency'],
			},
			{
				techs: ['python', 'fastapi', 'django', 'flask'],
				name: 'Python Backend Developer',
				description:
					'Python backend services, APIs, and scripting with emphasis on clean architecture',
				role: 'Software Developer',
				skills: ['API Design', 'Testing', 'Database', 'Error Handling', 'Packaging'],
			},
			{
				techs: ['go'],
				name: 'Go Backend Developer',
				description: 'Go backend services, APIs, and systems programming',
				role: 'Software Developer',
				skills: ['API Design', 'Concurrency', 'Testing', 'Performance'],
			},
			{
				techs: ['docker'],
				name: 'CI/CD Specialist',
				description: 'Build pipeline design, test automation, and deployment workflows',
				role: 'DevOps Engineer',
				skills: ['Pipeline Design', 'Docker/Containers', 'Monitoring', 'IaC'],
			},
		];

		for (const mapping of techToPersona) {
			const hasTech = mapping.techs.some(
				(t) => detectedTechs.has(t) || (evidence.get(t)?.length ?? 0) > 0
			);
			if (!hasTech) continue;
			if (existingPersonaNames.has(mapping.name.toLowerCase())) continue;

			// Gather evidence for this suggestion
			const suggestionEvidence: string[] = [];
			for (const t of mapping.techs) {
				const evList = evidence.get(t);
				if (evList) suggestionEvidence.push(...evList);
			}
			if (suggestionEvidence.length === 0) continue;

			// Check against SEED_ROLES
			let matchesSeed = false;
			let suggestedRoleId: string | undefined;
			const suggestedRoleName = mapping.role;

			for (const seed of SEED_ROLES) {
				const seedPersona = seed.personas.find(
					(p) => p.name.toLowerCase() === mapping.name.toLowerCase()
				);
				if (seedPersona) {
					matchesSeed = true;
					break;
				}
			}

			// Find existing role by name
			const existingRole = registry.roles.find(
				(r) => r.name.toLowerCase() === mapping.role.toLowerCase()
			);
			if (existingRole) {
				suggestedRoleId = existingRole.id;
			}

			suggestions.push({
				suggestedName: mapping.name,
				suggestedDescription: mapping.description,
				suggestedRoleId,
				suggestedRoleName,
				suggestedSkills: mapping.skills,
				evidence: suggestionEvidence,
				matchesSeed,
			});
		}

		return suggestions;
	}

	/**
	 * Compute how relevant each persona is to a given project based on actual
	 * memory injection data. After 20+ sessions, personas that have never
	 * contributed a memory to this project are candidates for deactivation.
	 *
	 * This prevents searching irrelevant personas (e.g., "Rust Systems Developer"
	 * for a Python-only project) which wastes embedding computation budget.
	 */
	async computePersonaRelevance(projectPath: string): Promise<PersonaRelevance[]> {
		const registry = await this.readRegistry();
		const results: PersonaRelevance[] = [];
		let totalInjections = 0;

		// For each active persona, count memories with matching sourceProjectPath and useCount > 0
		const personaCounts = new Map<string, number>();

		for (const persona of registry.personas) {
			if (!persona.active) continue;
			let count = 0;

			for (const skillId of persona.skillAreaIds) {
				const dirPath = this.getMemoryPath('skill', skillId);
				try {
					const lib = await this.readLibrary(dirPath);
					for (const entry of lib.entries) {
						if (
							entry.active &&
							entry.useCount > 0 &&
							entry.experienceContext?.sourceProjectPath === projectPath
						) {
							count += entry.useCount;
						}
					}
				} catch {
					// Library may not exist yet
				}
			}

			personaCounts.set(persona.id, count);
			totalInjections += count;
		}

		for (const persona of registry.personas) {
			if (!persona.active) continue;
			const count = personaCounts.get(persona.id) ?? 0;
			const relevanceScore = totalInjections > 0 ? count / totalInjections : 0;
			results.push({
				personaId: persona.id,
				relevanceScore,
				injectionCount: count,
			});
		}

		return results;
	}

	// ─── Experience → Rule Promotion ─────────────────────────────────────────

	/**
	 * Find experiences that qualify for promotion to rules.
	 *
	 * Promotion criteria (ALL must be met):
	 * - type === 'experience'
	 * - effectivenessScore >= 0.7
	 * - useCount >= 5
	 * - confidence >= 0.6
	 * - active === true, archived === false
	 * - Not tagged with 'promotion:dismissed'
	 * - Not pinned (pinned experiences are intentionally preserved as-is)
	 */
	async getPromotionCandidates(): Promise<PromotionCandidate[]> {
		const registry = await this.readRegistry();
		const candidates: PromotionCandidate[] = [];

		// Helper: collect candidates from a library
		const scanLibrary = async (dirPath: string) => {
			const lib = await this.readLibrary(dirPath);
			for (const entry of lib.entries) {
				if (
					entry.type !== 'experience' ||
					!entry.active ||
					entry.archived ||
					entry.pinned ||
					entry.effectivenessScore < 0.7 ||
					entry.useCount < 5 ||
					entry.confidence < 0.6 ||
					entry.tags.includes('promotion:dismissed')
				) {
					continue;
				}

				const suggestedRuleText = this.generateRuleText(entry);
				const qualificationReason =
					`Effectiveness: ${(entry.effectivenessScore * 100).toFixed(0)}%, ` +
					`used ${entry.useCount}x, confidence: ${(entry.confidence * 100).toFixed(0)}%`;

				// promotionScore = effectivenessScore * 0.5 + (useCount / 20) * 0.3 + confidence * 0.2
				const promotionScore = Math.min(
					1,
					Math.max(
						0,
						entry.effectivenessScore * 0.5 +
							Math.min(1, entry.useCount / 20) * 0.3 +
							entry.confidence * 0.2
					)
				);

				candidates.push({ memory: entry, suggestedRuleText, qualificationReason, promotionScore });
			}
		};

		// Scan all skill area libraries
		for (const skill of registry.skillAreas) {
			if (!skill.active) continue;
			try {
				await scanLibrary(this.getMemoryPath('skill', skill.id));
			} catch {
				// Library may not exist yet
			}
		}

		// Scan global library
		try {
			await scanLibrary(this.getMemoryPath('global'));
		} catch {
			// Library may not exist yet
		}

		// Cross-project candidates (from project-scoped libraries)
		const config = await this.getConfig();
		if (config.enableCrossProjectPromotion) {
			const projectsDir = path.join(this.memoriesDir, 'project');
			const projEntries = await fs.readdir(projectsDir).catch(() => [] as string[]);
			for (const dirHash of projEntries) {
				try {
					const dirPath = path.join(projectsDir, dirHash);
					const lib = await this.readLibrary(dirPath);
					for (const entry of lib.entries) {
						const evidence = entry.experienceContext?.crossProjectEvidence ?? [];
						// Count distinct projects (source + evidence targets)
						const projectCount = 1 + new Set(evidence.map((e) => e.projectPath)).size;
						if (
							entry.type !== 'experience' ||
							!entry.active ||
							entry.archived ||
							projectCount < config.crossProjectMinProjects ||
							entry.effectivenessScore < 0.5 ||
							entry.useCount < 2 ||
							entry.confidence < 0.4 ||
							entry.tags.includes('promotion:dismissed') ||
							entry.tags.includes('promotion:promoted-to-global')
						) {
							continue;
						}

						const suggestedRuleText = this.generateRuleText(entry);
						const qualificationReason =
							`Cross-project: seen in ${projectCount} projects, ` +
							`effectiveness: ${(entry.effectivenessScore * 100).toFixed(0)}%, ` +
							`used ${entry.useCount}x`;

						// Heavy weight on project spread
						const promotionScore = Math.min(
							1,
							Math.max(
								0,
								entry.effectivenessScore * 0.3 +
									Math.min(1, entry.useCount / 10) * 0.2 +
									entry.confidence * 0.1 +
									Math.min(1, projectCount / 4) * 0.4
							)
						);

						candidates.push({
							memory: entry,
							suggestedRuleText,
							qualificationReason,
							promotionScore,
							isCrossProjectCandidate: true,
							crossProjectCount: projectCount,
							crossProjectPaths: [dirHash, ...evidence.map((e) => e.projectPath)],
						});
					}
				} catch {
					// Library may not exist
				}
			}
		}

		// Sort by promotion score descending
		candidates.sort((a, b) => b.promotionScore - a.promotionScore);
		return candidates;
	}

	/**
	 * Generate a heuristic rule text from an experience entry.
	 * Converts experiential framing to imperative/prescriptive framing.
	 */
	private generateRuleText(entry: MemoryEntry): string {
		// Use the learning field from experienceContext as the base text if available
		const baseText = entry.experienceContext?.learning ?? entry.content;

		// If content starts with "When" → keep as conditional rule
		if (baseText.startsWith('When') || baseText.startsWith('when')) {
			return baseText;
		}

		// Check category tags for framing
		const hasTag = (tag: string) => entry.tags.includes(tag);

		if (hasTag('category:anti-pattern-identified')) {
			return `Avoid: ${baseText}`;
		}
		if (hasTag('category:pattern-established')) {
			return `Prefer: ${baseText}`;
		}
		if (hasTag('category:dependency-discovered')) {
			return `Ensure: ${baseText}`;
		}

		return `Rule: ${baseText}`;
	}

	/**
	 * Promote an experience to a rule.
	 *
	 * Changes the memory type from 'experience' to 'rule', updates the content
	 * to the approved rule text, boosts confidence, and preserves the original
	 * experienceContext as provenance.
	 */
	async promoteExperience(
		id: MemoryId,
		approvedRuleText: string,
		scope: MemoryScope,
		skillAreaId?: SkillAreaId,
		projectPath?: string
	): Promise<MemoryEntry | null> {
		const dirPath = this.getMemoryPath(scope, skillAreaId, projectPath);
		const lib = await this.readLibrary(dirPath);
		const idx = lib.entries.findIndex((e) => e.id === id);
		if (idx === -1) return null;

		const entry = lib.entries[idx];
		if (entry.type !== 'experience') return null;

		const now = Date.now();
		lib.entries[idx] = {
			...entry,
			type: 'rule',
			content: approvedRuleText,
			source: 'consolidation',
			confidence: Math.max(entry.confidence, 0.8),
			embedding: null, // Content changed, needs re-computation
			tokenEstimate: Math.ceil(approvedRuleText.length / 4),
			tags: entry.tags.includes('promoted:experience')
				? entry.tags
				: [...entry.tags, 'promoted:experience'],
			updatedAt: now,
		};

		await this.writeLibrary(dirPath, lib);
		await this.appendHistory(dirPath, {
			timestamp: now,
			operation: 'consolidate',
			entityType: 'memory',
			entityId: id,
			content: `Promoted experience to rule: ${approvedRuleText.slice(0, 200)}`,
			source: 'consolidation',
		});
		this.emitChangeEvent(
			'promoted',
			id,
			approvedRuleText,
			'rule',
			scope,
			'user',
			'consolidation',
			'Promoted from experience'
		);

		return lib.entries[idx];
	}

	/**
	 * Dismiss a promotion candidate — adds 'promotion:dismissed' tag so it won't
	 * be suggested again. Does not delete or archive the memory.
	 */
	async dismissPromotion(
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
		if (entry.tags.includes('promotion:dismissed')) return entry; // Already dismissed

		const now = Date.now();
		lib.entries[idx] = {
			...entry,
			tags: [...entry.tags, 'promotion:dismissed'],
			updatedAt: now,
		};

		await this.writeLibrary(dirPath, lib);
		return lib.entries[idx];
	}

	// ─── Cross-Project Promotion ────────────────────────────────────────────

	/**
	 * Scan all project libraries for recurring experiences across multiple projects.
	 * Annotates matching entries with `crossProjectEvidence` in their `experienceContext`.
	 *
	 * Budget-capped at 500 comparisons per invocation to avoid CPU spikes.
	 * Returns the number of entries annotated.
	 */
	async scanCrossProjectPatterns(): Promise<number> {
		const config = await this.getConfig();
		if (!config.enableCrossProjectPromotion) return 0;

		const threshold = config.crossProjectSimilarityThreshold;
		const projectsDir = path.join(this.memoriesDir, 'project');
		const dirEntries = await fs.readdir(projectsDir).catch(() => [] as string[]);
		if (dirEntries.length < 2) return 0; // Need at least 2 projects

		// Load all project libraries with their directory hashes
		const projectLibs: { dirHash: string; dirPath: string; entries: MemoryEntry[] }[] = [];
		for (const dirHash of dirEntries) {
			try {
				const dirPath = path.join(projectsDir, dirHash);
				const lib = await this.readLibrary(dirPath);
				const active = lib.entries.filter(
					(e) => e.active && !e.archived && e.type === 'experience' && e.embedding
				);
				if (active.length > 0) {
					projectLibs.push({ dirHash, dirPath, entries: active });
				}
			} catch {
				// Skip unreadable libraries
			}
		}

		if (projectLibs.length < 2) return 0;

		let comparisons = 0;
		let annotated = 0;
		const MAX_COMPARISONS = 500;
		const modifiedDirs = new Set<string>();

		// Compare entries across different projects
		for (let i = 0; i < projectLibs.length && comparisons < MAX_COMPARISONS; i++) {
			for (const entry of projectLibs[i].entries) {
				if (comparisons >= MAX_COMPARISONS) break;
				if (!entry.embedding) continue;

				// Skip if already has sufficient evidence
				const existingEvidence = entry.experienceContext?.crossProjectEvidence ?? [];
				const existingProjectHashes = new Set(existingEvidence.map((e) => e.projectPath));

				for (let j = 0; j < projectLibs.length && comparisons < MAX_COMPARISONS; j++) {
					if (i === j) continue;
					if (existingProjectHashes.has(projectLibs[j].dirHash)) continue;

					for (const other of projectLibs[j].entries) {
						if (comparisons >= MAX_COMPARISONS) break;
						if (!other.embedding) continue;
						comparisons++;

						const sim = cosineSimilarity(entry.embedding, other.embedding);
						if (sim >= threshold) {
							// Annotate entry with cross-project evidence
							if (!entry.experienceContext) continue;
							if (!entry.experienceContext.crossProjectEvidence) {
								entry.experienceContext.crossProjectEvidence = [];
							}
							entry.experienceContext.crossProjectEvidence.push({
								projectPath: projectLibs[j].dirHash,
								memoryId: other.id,
								similarity: sim,
							});
							modifiedDirs.add(projectLibs[i].dirPath);
							annotated++;
							break; // One match per target project is enough
						}
					}
				}
			}
		}

		// Write back modified libraries
		for (const dirPath of modifiedDirs) {
			const projLib = projectLibs.find((p) => p.dirPath === dirPath);
			if (!projLib) continue;
			try {
				// Re-read and merge to avoid clobbering concurrent writes
				const lib = await this.readLibrary(dirPath);
				for (const updated of projLib.entries) {
					const idx = lib.entries.findIndex((e) => e.id === updated.id);
					if (idx !== -1 && updated.experienceContext?.crossProjectEvidence) {
						lib.entries[idx] = {
							...lib.entries[idx],
							experienceContext: {
								...lib.entries[idx].experienceContext!,
								crossProjectEvidence: updated.experienceContext.crossProjectEvidence,
							},
							updatedAt: Date.now(),
						};
					}
				}
				await this.writeLibrary(dirPath, lib);
			} catch {
				// Non-fatal — will retry next scan
			}
		}

		return annotated;
	}

	/**
	 * Promote a cross-project experience to a global rule.
	 *
	 * Creates a new global rule from the experience, archives the source entry
	 * and contributing entries in other projects with superseded tags.
	 */
	async promoteCrossProjectExperience(
		id: MemoryId,
		approvedRuleText: string,
		sourceProjectDirHash: string
	): Promise<MemoryEntry | null> {
		const projectsDir = path.join(this.memoriesDir, 'project');
		const sourceDirPath = path.join(projectsDir, sourceProjectDirHash);
		const sourceLib = await this.readLibrary(sourceDirPath);
		const sourceEntry = sourceLib.entries.find((e) => e.id === id);
		if (!sourceEntry || sourceEntry.type !== 'experience') return null;

		const evidence = sourceEntry.experienceContext?.crossProjectEvidence ?? [];

		// Create global rule
		const globalRule = await this.addMemory({
			content: approvedRuleText,
			type: 'rule',
			scope: 'global',
			source: 'consolidation',
			tags: [
				'promoted:cross-project',
				...sourceEntry.tags.filter((t) => t.startsWith('category:')),
			],
			confidence: Math.max(sourceEntry.confidence, 0.8),
			experienceContext: {
				...(sourceEntry.experienceContext ?? { situation: '', learning: '' }),
				crossProjectEvidence: evidence,
			},
		});

		// Archive the source entry
		const sourceIdx = sourceLib.entries.findIndex((e) => e.id === id);
		if (sourceIdx !== -1) {
			sourceLib.entries[sourceIdx] = {
				...sourceLib.entries[sourceIdx],
				archived: true,
				tags: [...sourceLib.entries[sourceIdx].tags, 'promotion:promoted-to-global'],
				updatedAt: Date.now(),
			};
			await this.writeLibrary(sourceDirPath, sourceLib);
		}

		// Archive contributing entries in other projects
		for (const ev of evidence) {
			try {
				const evDirPath = path.join(projectsDir, ev.projectPath);
				const evLib = await this.readLibrary(evDirPath);
				const evIdx = evLib.entries.findIndex((e) => e.id === ev.memoryId);
				if (evIdx !== -1) {
					evLib.entries[evIdx] = {
						...evLib.entries[evIdx],
						archived: true,
						tags: [...evLib.entries[evIdx].tags, `promotion:superseded-by:${globalRule.id}`],
						updatedAt: Date.now(),
					};
					await this.writeLibrary(evDirPath, evLib);
				}
			} catch {
				// Non-fatal — contributing entry may have been deleted
			}
		}

		// Record history
		const globalDirPath = this.getMemoryPath('global');
		await this.appendHistory(globalDirPath, {
			timestamp: Date.now(),
			operation: 'cross-project-promote',
			entityType: 'memory',
			entityId: globalRule.id,
			content: approvedRuleText,
			reason: `Promoted from project ${sourceProjectDirHash}, seen in ${evidence.length + 1} projects`,
			source: 'consolidation',
		});
		this.emitChangeEvent(
			'promoted',
			globalRule.id,
			approvedRuleText,
			'rule',
			'global',
			'system',
			'consolidation',
			`Cross-project promotion from ${sourceProjectDirHash}, seen in ${evidence.length + 1} projects`
		);

		return globalRule;
	}

	// ─── Auto-Initialization ────────────────────────────────────────────────

	private _hierarchyInitialized = false;

	/**
	 * Ensure the hierarchy has at least one role. If empty (first run),
	 * automatically seed defaults so the memory system works out of the box.
	 * Safe to call repeatedly — only seeds once.
	 */
	async ensureHierarchyInitialized(): Promise<boolean> {
		if (this._hierarchyInitialized) return false;

		const registry = await this.readRegistry();
		if (registry.roles.length > 0) {
			this._hierarchyInitialized = true;
			return false;
		}

		console.log('[memory] Auto-seeding default hierarchy (first run)');
		const result = await this.seedFromDefaults();
		console.log(
			`[memory] Seeded ${result.roles} roles, ${result.personas} personas, ${result.skills} skills`
		);

		// Attempt to compute embeddings for the seeded hierarchy and any existing memories.
		// If no embedding provider is active yet, this gracefully returns 0
		// and embeddings will be computed when a provider activates
		// (see handleEmbeddingConfigChange in memory-handlers.ts).
		try {
			const hierarchyEmbedded = await this.ensureHierarchyEmbeddings();

			// Also embed any memories in skill areas and global scope
			let memoriesEmbedded = 0;
			const skillAreas = await this.listSkillAreas();
			for (const skill of skillAreas) {
				memoriesEmbedded += await this.ensureAllEmbeddings('skill', skill.id);
			}
			memoriesEmbedded += await this.ensureAllEmbeddings('global');

			if (hierarchyEmbedded > 0 || memoriesEmbedded > 0) {
				// Count personas vs skills for detailed logging
				const postRegistry = await this.readRegistry();
				const embeddedPersonas = postRegistry.personas.filter((p) => p.embedding !== null).length;
				const embeddedSkills = postRegistry.skillAreas.filter((s) => s.embedding !== null).length;
				console.log(
					`[memory] Computed embeddings for ${embeddedPersonas} personas and ${embeddedSkills} skills` +
						(memoriesEmbedded > 0 ? `, plus ${memoriesEmbedded} memories` : '')
				);
			}
		} catch {
			// Embedding provider not ready — embeddings will be computed on provider activation
		}

		this._hierarchyInitialized = true;
		return true;
	}

	// ─── Seed Data ──────────────────────────────────────────────────────────

	/**
	 * Seed the hierarchy with default roles/personas/skills if registry is empty.
	 * Only runs if no roles exist yet.
	 */
	async seedFromDefaults(): Promise<{ roles: number; personas: number; skills: number }> {
		const registry = await this.readRegistry();

		let roleCount = 0;
		let personaCount = 0;
		let skillCount = 0;

		for (const seedRole of SEED_ROLES) {
			// Check if role already exists (by name, case-insensitive)
			let existingRole = registry.roles.find(
				(r) => r.name.toLowerCase() === seedRole.name.toLowerCase()
			);

			if (!existingRole) {
				// Create new role
				existingRole = await this.createRole(
					seedRole.name,
					seedRole.description,
					seedRole.systemPrompt
				);
				roleCount++;
				// Re-read registry after createRole (it writes)
				const updated = await this.readRegistry();
				Object.assign(registry, updated);
			}

			// Seed missing personas under this role
			for (const seedPersona of seedRole.personas) {
				// Re-read for fresh state
				const freshRegistry = await this.readRegistry();
				let existingPersona = freshRegistry.personas.find(
					(p) =>
						p.roleId === existingRole!.id && p.name.toLowerCase() === seedPersona.name.toLowerCase()
				);

				if (!existingPersona) {
					existingPersona = await this.createPersona(
						existingRole.id,
						seedPersona.name,
						seedPersona.description,
						undefined,
						undefined,
						seedPersona.systemPrompt
					);
					personaCount++;
				}

				// Seed missing skills under this persona
				const currentRegistry = await this.readRegistry();
				const existingSkillNames = new Set(
					currentRegistry.skillAreas
						.filter((s) => s.personaId === existingPersona!.id)
						.map((s) => s.name.toLowerCase())
				);

				for (const skillName of seedPersona.skills) {
					if (!existingSkillNames.has(skillName.toLowerCase())) {
						await this.createSkillArea(existingPersona.id, skillName, `${skillName} expertise`);
						skillCount++;
					}
				}
			}
		}

		return { roles: roleCount, personas: personaCount, skills: skillCount };
	}

	/**
	 * Reset all seed-derived roles and personas to their original SEED_ROLES values.
	 * Custom (non-seed) roles and personas are left untouched.
	 */
	async resetToSeedDefaults(): Promise<{
		rolesReset: number;
		personasReset: number;
		personasCreated: number;
		skillsCreated: number;
	}> {
		const registry = await this.readRegistry();
		let rolesReset = 0;
		let personasReset = 0;
		let personasCreated = 0;
		let skillsCreated = 0;

		for (const seedRole of SEED_ROLES) {
			const existingRole = registry.roles.find(
				(r) => r.name.toLowerCase() === seedRole.name.toLowerCase()
			);
			if (!existingRole) continue;

			// Reset role fields
			existingRole.description = seedRole.description;
			existingRole.systemPrompt = seedRole.systemPrompt;
			existingRole.updatedAt = Date.now();
			rolesReset++;

			for (const seedPersona of seedRole.personas) {
				let existingPersona = registry.personas.find(
					(p) =>
						p.roleId === existingRole.id && p.name.toLowerCase() === seedPersona.name.toLowerCase()
				);

				if (existingPersona) {
					// Reset existing persona fields
					existingPersona.description = seedPersona.description;
					existingPersona.systemPrompt = seedPersona.systemPrompt;
					existingPersona.updatedAt = Date.now();
					personasReset++;
				} else {
					// Create missing persona (write registry first to save role changes)
					await this.writeRegistry(registry);
					existingPersona = await this.createPersona(
						existingRole.id,
						seedPersona.name,
						seedPersona.description,
						undefined,
						undefined,
						seedPersona.systemPrompt
					);
					personasCreated++;
					// Re-read registry after createPersona writes
					Object.assign(registry, await this.readRegistry());
				}

				// Seed missing skills under this persona
				const existingSkillNames = new Set(
					registry.skillAreas
						.filter((s) => s.personaId === existingPersona!.id)
						.map((s) => s.name.toLowerCase())
				);

				for (const skillName of seedPersona.skills) {
					if (!existingSkillNames.has(skillName.toLowerCase())) {
						await this.writeRegistry(registry);
						await this.createSkillArea(existingPersona.id, skillName, `${skillName} expertise`);
						skillsCreated++;
						// Re-read after createSkillArea writes
						Object.assign(registry, await this.readRegistry());
					}
				}
			}
		}

		await this.writeRegistry(registry);
		return { rolesReset, personasReset, personasCreated, skillsCreated };
	}

	// ─── Analytics ──────────────────────────────────────────────────────────

	private _analyticsCache: { data: MemoryStats; timestamp: number } | null = null;

	/** Invalidate the analytics cache (called after writes). */
	invalidateAnalyticsCache(): void {
		this._analyticsCache = null;
	}

	/**
	 * Compute extended analytics for the memory system.
	 * Includes effectiveness distribution, promotion candidates, archive stats,
	 * category breakdown, and injection patterns.
	 *
	 * Results are cached for 30 seconds to avoid repeated computation on
	 * rapid Settings UI re-renders.
	 */
	async getAnalytics(): Promise<MemoryStats> {
		const now = Date.now();
		if (this._analyticsCache && now - this._analyticsCache.timestamp < 30000) {
			return this._analyticsCache.data;
		}

		const registry = await this.readRegistry();
		const roles = registry.roles;
		const personas = registry.personas;
		const skillAreas = registry.skillAreas;

		// Gather ALL memories across all scopes (including archived)
		const allMemories: MemoryEntry[] = [];

		// Skill-scoped memories
		for (const skill of skillAreas) {
			try {
				const dirPath = this.getMemoryPath('skill', skill.id);
				const lib = await this.readLibrary(dirPath);
				allMemories.push(...lib.entries);
			} catch {
				// Library may not exist yet
			}
		}

		// Global memories
		try {
			const globalDir = this.getMemoryPath('global');
			const lib = await this.readLibrary(globalDir);
			allMemories.push(...lib.entries);
		} catch {
			// Library may not exist yet
		}

		// Project-scoped memories (scan project directory for hashed subdirs)
		try {
			const projectsDir = path.join(this.memoriesDir, 'project');
			const entries = await fs.readdir(projectsDir).catch(() => [] as string[]);
			for (const dirName of entries) {
				try {
					const projectDir = path.join(projectsDir, dirName);
					const lib = await this.readLibrary(projectDir);
					allMemories.push(...lib.entries);
				} catch {
					// Skip
				}
			}
		} catch {
			// No projects dir
		}

		// Base stats
		const byScope: Record<MemoryScope, number> = { skill: 0, project: 0, global: 0 };
		const bySource: Record<MemorySource, number> = {
			user: 0,
			grpo: 0,
			'auto-run': 0,
			'session-analysis': 0,
			consolidation: 0,
			import: 0,
			repository: 0,
		};
		const byType: Record<MemoryType, number> = { rule: 0, experience: 0 };
		let totalInjections = 0;
		let effectivenessSum = 0;
		let effectivenessCount = 0;
		let pendingEmbeddings = 0;

		// Analytics fields
		const effectivenessDistribution = { high: 0, medium: 0, low: 0, unscored: 0 };
		const sevenDaysAgo = now - 7 * 86400000;
		let recentInjections = 0;
		let archivedCount = 0;
		const byCategory: Record<string, number> = {};
		let neverInjectedCount = 0;
		let recentTokenSum = 0;
		let recentTokenCount = 0;
		const linkPairs = new Set<string>();

		for (const m of allMemories) {
			// Base stats (only count active, non-archived for totals — mirror getStats behavior)
			if (m.active) {
				byScope[m.scope]++;
				bySource[m.source]++;
				byType[m.type]++;
				totalInjections += m.useCount;
				if (m.effectivenessScore > 0) {
					effectivenessSum += m.effectivenessScore;
					effectivenessCount++;
				}
				if (!m.embedding) pendingEmbeddings++;
			}

			// Archived count (active but archived)
			if (m.archived) {
				archivedCount++;
			}

			// Effectiveness distribution (all active memories, including archived)
			if (m.active) {
				if (m.effectivenessScore >= 0.7) {
					effectivenessDistribution.high++;
				} else if (m.effectivenessScore >= 0.3) {
					effectivenessDistribution.medium++;
				} else if (m.effectivenessScore > 0) {
					effectivenessDistribution.low++;
				} else {
					effectivenessDistribution.unscored++;
				}
			}

			// Recent injections (last 7 days)
			if (m.lastUsedAt > sevenDaysAgo && m.useCount > 0) {
				recentInjections++;
			}

			// Category breakdown from category:* tags
			for (const tag of m.tags) {
				if (tag.startsWith('category:')) {
					const cat = tag.slice('category:'.length);
					byCategory[cat] = (byCategory[cat] ?? 0) + 1;
				}
			}

			// Never injected
			if (m.active && !m.archived && m.useCount === 0) {
				neverInjectedCount++;
			}

			// Token cost for recently injected
			if (m.lastUsedAt > sevenDaysAgo && m.useCount > 0) {
				recentTokenSum += m.tokenEstimate;
				recentTokenCount++;
			}

			// Links — count unique pairs
			if (m.relatedMemoryIds) {
				for (const relId of m.relatedMemoryIds) {
					const pair = m.id < relId ? `${m.id}:${relId}` : `${relId}:${m.id}`;
					linkPairs.add(pair);
				}
			}
		}

		// Persona/skill embedding pending count
		for (const p of personas) {
			if (!p.embedding) pendingEmbeddings++;
		}
		for (const s of skillAreas) {
			if (!s.embedding) pendingEmbeddings++;
		}

		// Promotion candidates count
		let promotionCandidatesCount = 0;
		let crossProjectCandidatesCount = 0;
		try {
			const candidates = await this.getPromotionCandidates();
			promotionCandidatesCount = candidates.length;
			crossProjectCandidatesCount = candidates.filter((c) => c.isCrossProjectCandidate).length;
		} catch {
			// Skip on error
		}

		const totalActiveMemories = byScope.skill + byScope.project + byScope.global;

		const stats: MemoryStats = {
			totalRoles: roles.length,
			totalPersonas: personas.length,
			totalSkillAreas: skillAreas.length,
			totalMemories: totalActiveMemories,
			byScope,
			bySource,
			byType,
			totalInjections,
			averageEffectiveness: effectivenessCount > 0 ? effectivenessSum / effectivenessCount : 0,
			pendingEmbeddings,
			effectivenessDistribution,
			recentInjections,
			promotionCandidates: promotionCandidatesCount,
			archivedCount,
			byCategory,
			neverInjectedCount,
			avgTokensPerInjection:
				recentTokenCount > 0 ? Math.round(recentTokenSum / recentTokenCount) : 0,
			totalLinks: linkPairs.size,
			crossProjectCandidates: crossProjectCandidatesCount,
		};

		this._analyticsCache = { data: stats, timestamp: now };
		return stats;
	}

	/**
	 * Calculate approximate disk usage of the memories directory.
	 * Walks the tree recursively, summing file sizes.
	 */
	async getStoreSize(): Promise<{ totalBytes: number; fileCount: number }> {
		let totalBytes = 0;
		let fileCount = 0;

		const walk = async (dir: string): Promise<void> => {
			let entries: import('fs').Dirent[];
			try {
				entries = await fs.readdir(dir, { withFileTypes: true });
			} catch {
				return; // directory doesn't exist or unreadable
			}
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(fullPath);
				} else if (entry.isFile()) {
					try {
						const stat = await fs.stat(fullPath);
						totalBytes += stat.size;
						fileCount++;
					} catch {
						// skip unreadable files
					}
				}
			}
		};

		await walk(this.memoriesDir);
		return { totalBytes, fileCount };
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
