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
	HierarchySuggestionResult,
	PromotionCandidate,
	JobQueueStatus,
	TokenUsage,
} from '../../shared/memory-types';
import type {
	ExperienceBundle,
	BundleImportResult,
	ImportedBundleRecord,
	TrustedKeyEntry,
	RepositoryCatalogResponse,
	SubmissionResponse,
} from '../../shared/experience-bundle-types';

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

			create: (
				name: string,
				description: string,
				systemPrompt?: string
			): Promise<IpcResponse<Role>> =>
				ipcRenderer.invoke('memory:role:create', name, description, systemPrompt),

			update: (
				id: string,
				updates: { name?: string; description?: string; systemPrompt?: string }
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
				assignedProjects?: string[],
				systemPrompt?: string
			): Promise<IpcResponse<Persona>> =>
				ipcRenderer.invoke(
					'memory:persona:create',
					roleId,
					name,
					description,
					assignedAgents,
					assignedProjects,
					systemPrompt
				),

			update: (
				id: string,
				updates: {
					name?: string;
					description?: string;
					systemPrompt?: string;
					assignedAgents?: string[];
					assignedProjects?: string[];
					active?: boolean;
				}
			): Promise<IpcResponse<Persona | null>> =>
				ipcRenderer.invoke('memory:persona:update', id, updates),

			delete: (id: string): Promise<IpcResponse<boolean>> =>
				ipcRenderer.invoke('memory:persona:delete', id),
		},

		// ─── Persona Matching ─────────────────────────────────────────────
		matchPersonas: (
			query: string,
			agentType: string,
			projectPath?: string
		): Promise<
			IpcResponse<
				Array<{
					personaId: string;
					personaName: string;
					roleName: string;
					description: string;
					systemPrompt: string;
					similarity: number;
				}>
			>
		> => ipcRenderer.invoke('memory:matchPersonas', query, agentType, projectPath),

		// ─── Reset Seed Defaults ──────────────────────────────────────────
		resetSeedDefaults: (): Promise<
			IpcResponse<{
				rolesReset: number;
				personasReset: number;
				personasCreated?: number;
				skillsCreated?: number;
			}>
		> => ipcRenderer.invoke('memory:resetSeedDefaults'),

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

		// ─── All Experiences ──────────────────────────────────────────────
		listAllExperiences: (
			projectPath?: string
		): Promise<
			IpcResponse<
				Array<
					MemoryEntry & {
						scopeLabel: string;
						skillAreaName?: string;
						personaName?: string;
					}
				>
			>
		> => ipcRenderer.invoke('memory:listAllExperiences', projectPath),

		// ─── Move Scope ──────────────────────────────────────────────────
		moveScope: (
			memoryId: string,
			fromScope: MemoryScope,
			fromSkillAreaId: string | undefined,
			fromProjectPath: string | undefined,
			toScope: MemoryScope,
			toSkillAreaId: string | undefined,
			toProjectPath: string | undefined
		): Promise<IpcResponse<MemoryEntry>> =>
			ipcRenderer.invoke(
				'memory:moveScope',
				memoryId,
				fromScope,
				fromSkillAreaId,
				fromProjectPath,
				toScope,
				toSkillAreaId,
				toProjectPath
			),

		// ─── Archive ──────────────────────────────────────────────────────
		listArchived: (
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry[]>> =>
			ipcRenderer.invoke('memory:listArchived', scope, skillAreaId, projectPath),

		restore: (
			id: string,
			scope: MemoryScope,
			skillAreaId?: SkillAreaId,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry | null>> =>
			ipcRenderer.invoke('memory:restore', id, scope, skillAreaId, projectPath),

		// ─── Search ───────────────────────────────────────────────────────
		search: (
			query: string,
			agentType: string,
			projectPath?: string,
			strategy?: 'cascading' | 'keyword' | 'tag'
		): Promise<IpcResponse<MemorySearchResult[]>> =>
			ipcRenderer.invoke('memory:search', query, agentType, projectPath, strategy),

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

		getProjectDigest: (projectPath: string): Promise<IpcResponse<string | null>> =>
			ipcRenderer.invoke('memory:getProjectDigest', projectPath),

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

		// ─── Promotion ───────────────────────────────────────────────────
		getPromotionCandidates: (): Promise<IpcResponse<PromotionCandidate[]>> =>
			ipcRenderer.invoke('memory:getPromotionCandidates'),

		promote: (
			id: string,
			ruleText: string,
			scope: string,
			skillAreaId?: string,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry | null>> =>
			ipcRenderer.invoke('memory:promote', id, ruleText, scope, skillAreaId, projectPath),

		dismissPromotion: (
			id: string,
			scope: string,
			skillAreaId?: string,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry | null>> =>
			ipcRenderer.invoke('memory:dismissPromotion', id, scope, skillAreaId, projectPath),

		promoteCrossProject: (
			id: string,
			ruleText: string,
			sourceProjectDirHash: string
		): Promise<IpcResponse<MemoryEntry | null>> =>
			ipcRenderer.invoke('memory:promoteCrossProject', id, ruleText, sourceProjectDirHash),

		// ─── Hierarchy Suggestions ────────────────────────────────────────
		suggestHierarchy: (projectPath: string): Promise<IpcResponse<HierarchySuggestionResult>> =>
			ipcRenderer.invoke('memory:suggestHierarchy', projectPath),

		// ─── Inter-Memory Linking ─────────────────────────────────────────
		link: (
			idA: string,
			scopeA: MemoryScope,
			idB: string,
			scopeB: MemoryScope,
			skillAreaIdA?: string,
			projectPathA?: string,
			skillAreaIdB?: string,
			projectPathB?: string
		): Promise<IpcResponse<{ linked: boolean }>> =>
			ipcRenderer.invoke(
				'memory:link',
				idA,
				scopeA,
				idB,
				scopeB,
				skillAreaIdA,
				projectPathA,
				skillAreaIdB,
				projectPathB
			),

		unlink: (
			idA: string,
			scopeA: MemoryScope,
			idB: string,
			scopeB: MemoryScope,
			skillAreaIdA?: string,
			projectPathA?: string,
			skillAreaIdB?: string,
			projectPathB?: string
		): Promise<IpcResponse<{ unlinked: boolean }>> =>
			ipcRenderer.invoke(
				'memory:unlink',
				idA,
				scopeA,
				idB,
				scopeB,
				skillAreaIdA,
				projectPathA,
				skillAreaIdB,
				projectPathB
			),

		getLinked: (
			id: string,
			scope: MemoryScope,
			skillAreaId?: string,
			projectPath?: string
		): Promise<IpcResponse<MemoryEntry[]>> =>
			ipcRenderer.invoke('memory:getLinked', id, scope, skillAreaId, projectPath),

		// ─── Analytics ────────────────────────────────────────────────────
		getAnalytics: (): Promise<IpcResponse<MemoryStats>> =>
			ipcRenderer.invoke('memory:getAnalytics'),

		getRecentInjections: (limit?: number): Promise<IpcResponse<unknown[]>> =>
			ipcRenderer.invoke('memory:getRecentInjections', limit),

		debugInjection: (): Promise<
			IpcResponse<Array<{ label: string; ok: boolean; detail?: string }>>
		> => ipcRenderer.invoke('memory:debugInjection'),

		// ─── Job Queue Status & Token Tracking ────────────────────────────
		getJobQueueStatus: (): Promise<IpcResponse<JobQueueStatus>> =>
			ipcRenderer.invoke('memory:getJobQueueStatus'),

		getTokenUsage: (): Promise<IpcResponse<TokenUsage>> =>
			ipcRenderer.invoke('memory:getTokenUsage'),

		getStoreSize: (): Promise<IpcResponse<{ totalBytes: number; fileCount: number }>> =>
			ipcRenderer.invoke('memory:getStoreSize'),

		analyzeHistoricalSessions: (): Promise<
			IpcResponse<{ total: number; queued: number; skipped: number }>
		> => ipcRenderer.invoke('memory:analyzeHistoricalSessions'),

		getAnalysisStats: (): Promise<
			IpcResponse<{
				totalSessions: number;
				analyzedSessions: number;
				unanalyzedSessions: number;
			}>
		> => ipcRenderer.invoke('memory:getAnalysisStats'),

		analyzeAgentSessions: (
			agentId: string,
			agentType: string,
			projectPath?: string
		): Promise<
			IpcResponse<{ total: number; queued: number; skipped: number; alreadyAnalyzed: number }>
		> => ipcRenderer.invoke('memory:analyzeAgentSessions', agentId, agentType, projectPath),

		getAgentAnalysisStats: (
			agentId: string
		): Promise<
			IpcResponse<{
				totalSessions: number;
				analyzedSessions: number;
				unanalyzedSessions: number;
			}>
		> => ipcRenderer.invoke('memory:getAgentAnalysisStats', agentId),

		onJobQueueUpdate: (callback: (status: JobQueueStatus) => void) => {
			const handler = (_event: unknown, status: JobQueueStatus) => callback(status);
			ipcRenderer.on('memory:jobQueueUpdate', handler);
			return () => {
				ipcRenderer.removeListener('memory:jobQueueUpdate', handler);
			};
		},

		// ─── Experience Repository ───────────────────────────────────────
		repository: {
			importFromFile: (
				filePath: string
			): Promise<
				IpcResponse<{
					success: boolean;
					signatureStatus?: string;
					result?: BundleImportResult;
					errors?: string[];
				}>
			> => ipcRenderer.invoke('memory:repository:importFromFile', filePath),

			export: (
				name: string,
				description: string,
				author: string,
				memoryIds: string[],
				version?: string
			): Promise<IpcResponse<ExperienceBundle>> =>
				ipcRenderer.invoke(
					'memory:repository:export',
					name,
					description,
					author,
					memoryIds,
					version
				),

			verifySignature: (
				filePath: string
			): Promise<
				IpcResponse<{ signed: boolean; valid?: boolean; trusted?: boolean; signerKey?: string }>
			> => ipcRenderer.invoke('memory:repository:verifySignature', filePath),

			getImportedBundles: (): Promise<IpcResponse<ImportedBundleRecord[]>> =>
				ipcRenderer.invoke('memory:repository:getImportedBundles'),

			uninstall: (bundleId: string): Promise<IpcResponse<{ removed: number }>> =>
				ipcRenderer.invoke('memory:repository:uninstall', bundleId),

			getTrustedKeys: (): Promise<IpcResponse<TrustedKeyEntry[]>> =>
				ipcRenderer.invoke('memory:repository:getTrustedKeys'),

			addTrustedKey: (publicKey: string, label: string): Promise<IpcResponse<{ added: boolean }>> =>
				ipcRenderer.invoke('memory:repository:addTrustedKey', publicKey, label),

			removeTrustedKey: (publicKey: string): Promise<IpcResponse<{ removed: boolean }>> =>
				ipcRenderer.invoke('memory:repository:removeTrustedKey', publicKey),

			browseCatalog: (
				query?: string,
				page?: number,
				pageSize?: number
			): Promise<IpcResponse<RepositoryCatalogResponse>> =>
				ipcRenderer.invoke('memory:repository:browseCatalog', query, page, pageSize),

			download: (bundleId: string): Promise<IpcResponse<{ success: boolean; error?: string }>> =>
				ipcRenderer.invoke('memory:repository:download', bundleId),

			submit: (
				name: string,
				description: string,
				author: string,
				memoryIds: string[],
				submitterName?: string,
				submitterEmail?: string,
				reviewNotes?: string
			): Promise<IpcResponse<SubmissionResponse>> =>
				ipcRenderer.invoke(
					'memory:repository:submit',
					name,
					description,
					author,
					memoryIds,
					submitterName,
					submitterEmail,
					reviewNotes
				),
		},
	};
}

export type MemoryApi = ReturnType<typeof createMemoryApi>;
