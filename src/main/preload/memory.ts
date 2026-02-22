/**
 * Preload API for Agent Experiences Memory operations
 *
 * Provides the window.maestro.memory namespace for:
 * - Config management
 * - Role, Persona, Skill Area CRUD
 * - Memory CRUD and search
 * - Stats, import/export, embedding management
 */

import { ipcRenderer } from 'electron';
import type { IpcResponse } from '../../main/utils/ipcHandler';
import type {
	Role,
	Persona,
	SkillArea,
	MemoryEntry,
	MemoryConfig,
	MemoryScope,
	SkillAreaId,
	MemoryType,
	MemorySource,
	MemoryStats,
	MemorySearchResult,
	ExperienceContext,
} from '../../shared/memory-types';

/**
 * Creates the Memory API object for preload exposure
 */
export function createMemoryApi() {
	return {
		// ─── Config ───────────────────────────────────────────────────────
		getConfig: (): Promise<IpcResponse<MemoryConfig>> => ipcRenderer.invoke('memory:getConfig'),

		setConfig: (config: Partial<MemoryConfig>): Promise<IpcResponse<MemoryConfig>> =>
			ipcRenderer.invoke('memory:setConfig', config),

		// ─── Roles ────────────────────────────────────────────────────────
		role: {
			list: (): Promise<IpcResponse<Role[]>> => ipcRenderer.invoke('memory:role:list'),

			get: (id: string): Promise<IpcResponse<Role | null>> =>
				ipcRenderer.invoke('memory:role:get', id),

			create: (name: string, description: string): Promise<IpcResponse<Role>> =>
				ipcRenderer.invoke('memory:role:create', name, description),

			update: (
				id: string,
				updates: { name?: string; description?: string }
			): Promise<IpcResponse<Role | null>> => ipcRenderer.invoke('memory:role:update', id, updates),

			delete: (id: string): Promise<IpcResponse<boolean>> =>
				ipcRenderer.invoke('memory:role:delete', id),
		},

		// ─── Personas ─────────────────────────────────────────────────────
		persona: {
			list: (roleId?: string): Promise<IpcResponse<Persona[]>> =>
				ipcRenderer.invoke('memory:persona:list', roleId),

			get: (id: string): Promise<IpcResponse<Persona | null>> =>
				ipcRenderer.invoke('memory:persona:get', id),

			create: (
				roleId: string,
				name: string,
				description: string,
				assignedAgents?: string[],
				assignedProjects?: string[]
			): Promise<IpcResponse<Persona>> =>
				ipcRenderer.invoke(
					'memory:persona:create',
					roleId,
					name,
					description,
					assignedAgents,
					assignedProjects
				),

			update: (
				id: string,
				updates: {
					name?: string;
					description?: string;
					assignedAgents?: string[];
					assignedProjects?: string[];
					active?: boolean;
				}
			): Promise<IpcResponse<Persona | null>> =>
				ipcRenderer.invoke('memory:persona:update', id, updates),

			delete: (id: string): Promise<IpcResponse<boolean>> =>
				ipcRenderer.invoke('memory:persona:delete', id),
		},

		// ─── Skill Areas ──────────────────────────────────────────────────
		skill: {
			list: (personaId?: string): Promise<IpcResponse<SkillArea[]>> =>
				ipcRenderer.invoke('memory:skill:list', personaId),

			get: (id: string): Promise<IpcResponse<SkillArea | null>> =>
				ipcRenderer.invoke('memory:skill:get', id),

			create: (
				personaId: string,
				name: string,
				description: string
			): Promise<IpcResponse<SkillArea>> =>
				ipcRenderer.invoke('memory:skill:create', personaId, name, description),

			update: (
				id: string,
				updates: { name?: string; description?: string; active?: boolean }
			): Promise<IpcResponse<SkillArea | null>> =>
				ipcRenderer.invoke('memory:skill:update', id, updates),

			delete: (id: string): Promise<IpcResponse<boolean>> =>
				ipcRenderer.invoke('memory:skill:delete', id),
		},

		// ─── Memories ─────────────────────────────────────────────────────
		list: (
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string,
			includeInactive?: boolean
		): Promise<IpcResponse<MemoryEntry[]>> =>
			ipcRenderer.invoke('memory:list', scope, skillAreaId, projectPath, includeInactive),

		add: (
			entry: {
				content: string;
				type?: MemoryType;
				scope: MemoryScope;
				skillAreaId?: SkillAreaId;
				personaId?: string;
				roleId?: string;
				tags?: string[];
				source?: MemorySource;
				confidence?: number;
				pinned?: boolean;
				experienceContext?: ExperienceContext;
			},
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry>> => ipcRenderer.invoke('memory:add', entry, projectPath),

		update: (
			id: string,
			updates: Partial<
				Pick<
					MemoryEntry,
					'content' | 'type' | 'tags' | 'confidence' | 'pinned' | 'active' | 'experienceContext'
				>
			>,
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry | null>> =>
			ipcRenderer.invoke('memory:update', id, updates, scope, skillAreaId, projectPath),

		delete: (
			id: string,
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<boolean>> =>
			ipcRenderer.invoke('memory:delete', id, scope, skillAreaId, projectPath),

		// ─── Search ───────────────────────────────────────────────────────
		search: (
			query: string,
			agentType: string,
			projectPath?: string
		): Promise<IpcResponse<MemorySearchResult[]>> =>
			ipcRenderer.invoke('memory:search', query, agentType, projectPath),

		// ─── Utility ──────────────────────────────────────────────────────
		getStats: (): Promise<IpcResponse<MemoryStats>> => ipcRenderer.invoke('memory:getStats'),

		export: (
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<
			IpcResponse<{
				memories: MemoryEntry[];
				exportedAt: number;
				scope: MemoryScope;
				skillAreaId?: SkillAreaId;
				projectPath?: string;
			}>
		> => ipcRenderer.invoke('memory:export', scope, skillAreaId, projectPath),

		import: (
			json: {
				memories: Array<{
					content: string;
					type?: MemoryType;
					tags?: string[];
					confidence?: number;
					pinned?: boolean;
					experienceContext?: ExperienceContext;
				}>;
			},
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<{ imported: number }>> =>
			ipcRenderer.invoke('memory:import', json, scope, skillAreaId, projectPath),

		consolidate: (
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<{ consolidated: number; message: string }>> =>
			ipcRenderer.invoke('memory:consolidate', scope, skillAreaId, projectPath),

		ensureEmbeddings: (
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<{ memoriesUpdated: number; hierarchyUpdated: number }>> =>
			ipcRenderer.invoke('memory:ensureEmbeddings', scope, skillAreaId, projectPath),

		seedDefaults: (): Promise<IpcResponse<{ roles: number; personas: number; skills: number }>> =>
			ipcRenderer.invoke('memory:seedDefaults'),
	};
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
