/**
 * Agent Experiences Memory IPC Handlers
 *
 * Provides IPC handlers for the full memory hierarchy (roles, personas, skill areas,
 * memories) plus config, search, import/export, and utility operations.
 *
 * All channels are prefixed with `memory:` and subnamespaced by entity type.
 */

import { ipcMain } from 'electron';
import { promises as fs } from 'fs';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger';
import { createIpcDataHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import type { MemoryStore } from '../../memory/memory-store';
import { setMemorySettingsStore } from '../../memory/memory-injector';
import type {
	MemoryScope,
	SkillAreaId,
	MemoryId,
	MemoryConfig,
	MemoryEntry,
	MemoryType,
	MemorySource,
	ExperienceContext,
	MemoryStats,
	MemorySearchResult,
} from '../../../shared/memory-types';

const LOG_CONTEXT = '[Memory]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies required for memory handler registration
 */
export interface MemoryHandlerDependencies {
	memoryStore: MemoryStore;
	settingsStore: { get: (key: string) => unknown; set: (key: string, value: unknown) => void };
}

/**
 * Register all memory IPC handlers.
 */
export function registerMemoryHandlers(deps: MemoryHandlerDependencies): void {
	const { memoryStore } = deps;

	// ─── Initialize Memory Injector Settings ─────────────────────────────
	// Cache the file-based config for synchronous access in the injector.
	// Loaded once at startup; updated whenever the user changes config via IPC.
	let cachedConfig: Partial<MemoryConfig> | undefined;
	memoryStore
		.getConfig()
		.then((config) => {
			cachedConfig = config;
			logger.debug('Memory injector settings initialized', LOG_CONTEXT);
		})
		.catch((err) => {
			logger.warn(`Failed to load initial memory config: ${err}`, LOG_CONTEXT);
		});
	setMemorySettingsStore(() => cachedConfig);

	// Pre-warm registry cache so first agent spawn doesn't pay file I/O cost
	memoryStore
		.getCachedRegistry()
		.then(() => {
			logger.debug('Memory registry cache pre-warmed', LOG_CONTEXT);
		})
		.catch(() => {
			// Non-critical — cache will populate on first search
		});

	// ─── Config ───────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:getConfig',
		createIpcDataHandler(handlerOpts('getConfig'), async () => {
			return memoryStore.getConfig();
		})
	);

	ipcMain.handle(
		'memory:setConfig',
		createIpcDataHandler(handlerOpts('setConfig'), async (config: Partial<MemoryConfig>) => {
			const result = await memoryStore.setConfig(config);
			// Update the cached config for the memory injector
			cachedConfig = result;
			return result;
		})
	);

	// ─── Roles ────────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:role:list',
		createIpcDataHandler(handlerOpts('role:list'), async () => {
			return memoryStore.listRoles();
		})
	);

	ipcMain.handle(
		'memory:role:get',
		createIpcDataHandler(handlerOpts('role:get'), async (id: string) => {
			return memoryStore.getRole(id);
		})
	);

	ipcMain.handle(
		'memory:role:create',
		createIpcDataHandler(
			handlerOpts('role:create'),
			async (name: string, description: string, systemPrompt?: string) => {
				return memoryStore.createRole(name, description, systemPrompt);
			}
		)
	);

	ipcMain.handle(
		'memory:role:update',
		createIpcDataHandler(
			handlerOpts('role:update'),
			async (
				id: string,
				updates: { name?: string; description?: string; systemPrompt?: string }
			) => {
				return memoryStore.updateRole(id, updates);
			}
		)
	);

	ipcMain.handle(
		'memory:role:delete',
		createIpcDataHandler(handlerOpts('role:delete'), async (id: string) => {
			return memoryStore.deleteRole(id);
		})
	);

	// ─── Personas ─────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:persona:list',
		createIpcDataHandler(handlerOpts('persona:list'), async (roleId?: string) => {
			return memoryStore.listPersonas(roleId);
		})
	);

	ipcMain.handle(
		'memory:persona:get',
		createIpcDataHandler(handlerOpts('persona:get'), async (id: string) => {
			return memoryStore.getPersona(id);
		})
	);

	ipcMain.handle(
		'memory:persona:create',
		createIpcDataHandler(
			handlerOpts('persona:create'),
			async (
				roleId: string,
				name: string,
				description: string,
				assignedAgents?: string[],
				assignedProjects?: string[],
				systemPrompt?: string
			) => {
				return memoryStore.createPersona(
					roleId,
					name,
					description,
					assignedAgents,
					assignedProjects,
					systemPrompt
				);
			}
		)
	);

	ipcMain.handle(
		'memory:persona:update',
		createIpcDataHandler(
			handlerOpts('persona:update'),
			async (
				id: string,
				updates: {
					name?: string;
					description?: string;
					systemPrompt?: string;
					assignedAgents?: string[];
					assignedProjects?: string[];
					active?: boolean;
				}
			) => {
				return memoryStore.updatePersona(id, updates);
			}
		)
	);

	ipcMain.handle(
		'memory:persona:delete',
		createIpcDataHandler(handlerOpts('persona:delete'), async (id: string) => {
			return memoryStore.deletePersona(id);
		})
	);

	// ─── Persona Matching ─────────────────────────────────────────────────

	ipcMain.handle(
		'memory:matchPersonas',
		createIpcDataHandler(
			handlerOpts('matchPersonas'),
			async (query: string, agentType: string, projectPath?: string) => {
				const config = await memoryStore.getConfig();
				if (!config.enabled) return [];

				// Auto-seed if no personas exist
				const personas = await memoryStore.listPersonas();
				if (personas.length === 0) {
					await memoryStore.seedFromDefaults();
				}

				const matches = await memoryStore.selectMatchingPersonas(
					query,
					config,
					agentType,
					projectPath
				);

				return matches.map((m) => ({
					personaId: m.persona.id,
					personaName: m.personaName,
					roleName: m.roleName,
					description: m.persona.description,
					systemPrompt: m.persona.systemPrompt ?? '',
					similarity: m.similarity,
				}));
			}
		)
	);

	// ─── Skill Areas ──────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:skill:list',
		createIpcDataHandler(handlerOpts('skill:list'), async (personaId?: string) => {
			return memoryStore.listSkillAreas(personaId);
		})
	);

	ipcMain.handle(
		'memory:skill:get',
		createIpcDataHandler(handlerOpts('skill:get'), async (id: string) => {
			return memoryStore.getSkillArea(id);
		})
	);

	ipcMain.handle(
		'memory:skill:create',
		createIpcDataHandler(
			handlerOpts('skill:create'),
			async (personaId: string, name: string, description: string) => {
				return memoryStore.createSkillArea(personaId, name, description);
			}
		)
	);

	ipcMain.handle(
		'memory:skill:update',
		createIpcDataHandler(
			handlerOpts('skill:update'),
			async (id: string, updates: { name?: string; description?: string; active?: boolean }) => {
				return memoryStore.updateSkillArea(id, updates);
			}
		)
	);

	ipcMain.handle(
		'memory:skill:delete',
		createIpcDataHandler(handlerOpts('skill:delete'), async (id: string) => {
			return memoryStore.deleteSkillArea(id);
		})
	);

	// ─── Memories ─────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:list',
		createIpcDataHandler(
			handlerOpts('memory:list'),
			async (
				scope: MemoryScope,
				skillAreaId?: SkillAreaId,
				projectPath?: string,
				includeInactive?: boolean
			) => {
				return memoryStore.listMemories(scope, skillAreaId, projectPath, includeInactive);
			}
		)
	);

	ipcMain.handle(
		'memory:add',
		createIpcDataHandler(
			handlerOpts('memory:add'),
			async (
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
			) => {
				const result = await memoryStore.addMemory(entry, projectPath);

				// Notify cross-agent broadcaster for user-created memories (EXP-LIVE-04)
				import('../../memory/live-context-broadcaster')
					.then(({ getLiveBroadcaster }) => {
						getLiveBroadcaster().onMemoryCreated(result, projectPath);
					})
					.catch(() => {});

				return result;
			}
		)
	);

	ipcMain.handle(
		'memory:update',
		createIpcDataHandler(
			handlerOpts('memory:update'),
			async (
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
			) => {
				return memoryStore.updateMemory(id, updates, scope, skillAreaId, projectPath);
			}
		)
	);

	ipcMain.handle(
		'memory:delete',
		createIpcDataHandler(
			handlerOpts('memory:delete'),
			async (id: string, scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				return memoryStore.deleteMemory(id, scope, skillAreaId, projectPath);
			}
		)
	);

	// ─── All Experiences ──────────────────────────────────────────────────

	ipcMain.handle(
		'memory:listAllExperiences',
		createIpcDataHandler(handlerOpts('listAllExperiences'), async (projectPath?: string) => {
			const registry = await memoryStore.getCachedRegistry();
			const results: Array<
				MemoryEntry & { scopeLabel: string; skillAreaName?: string; personaName?: string }
			> = [];

			// 1. Skill-scoped experiences
			for (const skill of registry.skillAreas) {
				if (!skill.active) continue;
				const entries = await memoryStore.listMemories('skill', skill.id);
				const persona = registry.personas.find((p) => p.id === skill.personaId);
				for (const entry of entries) {
					if (entry.type === 'experience') {
						results.push({
							...entry,
							scopeLabel: `${persona?.name ?? 'Unknown'} → ${skill.name}`,
							skillAreaName: skill.name,
							personaName: persona?.name,
						});
					}
				}
			}

			// 2. Project-scoped experiences
			if (projectPath) {
				const projectEntries = await memoryStore.listMemories('project', undefined, projectPath);
				for (const entry of projectEntries) {
					if (entry.type === 'experience') {
						results.push({ ...entry, scopeLabel: 'Project' });
					}
				}
			}

			// 3. Global experiences
			const globalEntries = await memoryStore.listMemories('global');
			for (const entry of globalEntries) {
				if (entry.type === 'experience') {
					results.push({ ...entry, scopeLabel: 'Global' });
				}
			}

			// Sort by createdAt descending (most recent first)
			results.sort((a, b) => b.createdAt - a.createdAt);
			return results;
		})
	);

	// ─── Move Scope ───────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:moveScope',
		createIpcDataHandler(
			handlerOpts('moveScope'),
			async (
				memoryId: string,
				fromScope: MemoryScope,
				fromSkillAreaId: string | undefined,
				fromProjectPath: string | undefined,
				toScope: MemoryScope,
				toSkillAreaId: string | undefined,
				toProjectPath: string | undefined
			) => {
				// 1. Read the existing entries from the source scope to find target
				const entries = await memoryStore.listMemories(
					fromScope,
					fromSkillAreaId,
					fromProjectPath,
					true
				);
				const source = entries.find((e) => e.id === memoryId);
				if (!source) {
					throw new Error(`Memory ${memoryId} not found in scope=${fromScope}`);
				}

				// 2. Delete from source scope
				await memoryStore.deleteMemory(memoryId, fromScope, fromSkillAreaId, fromProjectPath);

				// 3. Derive personaId/roleId for skill-scoped destination
				let personaId: string | undefined;
				let roleId: string | undefined;
				if (toScope === 'skill' && toSkillAreaId) {
					const registry = await memoryStore.getCachedRegistry();
					const skill = registry.skillAreas.find((s) => s.id === toSkillAreaId);
					if (skill) {
						personaId = skill.personaId;
						const persona = registry.personas.find((p) => p.id === skill.personaId);
						if (persona) roleId = persona.roleId;
					}
				}

				// 4. Add to destination scope with same content
				const newEntry = await memoryStore.addMemory(
					{
						content: source.content,
						type: source.type,
						scope: toScope,
						skillAreaId: toSkillAreaId,
						personaId,
						roleId,
						tags: source.tags,
						source: source.source,
						confidence: source.confidence,
						pinned: source.pinned,
						experienceContext: source.experienceContext,
					},
					toProjectPath
				);

				logger.info(`Moved memory ${memoryId} from ${fromScope} to ${toScope}`, LOG_CONTEXT);
				return newEntry;
			}
		)
	);

	// ─── Archive ──────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:listArchived',
		createIpcDataHandler(
			handlerOpts('memory:listArchived'),
			async (scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				return memoryStore.listArchivedMemories(scope, skillAreaId, projectPath);
			}
		)
	);

	ipcMain.handle(
		'memory:restore',
		createIpcDataHandler(
			handlerOpts('memory:restore'),
			async (id: MemoryId, scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				return memoryStore.restoreMemory(id, scope, skillAreaId, projectPath);
			}
		)
	);

	// ─── Search ───────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:search',
		createIpcDataHandler(
			handlerOpts('memory:search'),
			async (
				query: string,
				agentType: string,
				projectPath?: string,
				strategy?: 'cascading' | 'keyword' | 'tag'
			) => {
				const config = await memoryStore.getConfig();
				if (strategy === 'keyword') {
					// Keyword-only search across all scopes
					const scopes: Array<{ scope: MemoryScope; projectPath?: string }> = [{ scope: 'global' }];
					if (projectPath) scopes.push({ scope: 'project', projectPath });
					const allResults: MemorySearchResult[] = [];
					for (const s of scopes) {
						const results = await memoryStore.keywordSearch(
							query,
							s.scope,
							undefined,
							s.projectPath,
							0.05
						);
						for (const r of results) {
							allResults.push({
								entry: r.entry,
								similarity: r.keywordScore,
								combinedScore: r.keywordScore,
							});
						}
					}
					allResults.sort((a, b) => b.combinedScore - a.combinedScore);
					return allResults.slice(0, 30);
				}
				if (strategy === 'tag') {
					// Tag-based search: split query by commas
					const tags = query
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean);
					if (tags.length === 0) return [];
					const scopes: Array<{ scope: MemoryScope; projectPath?: string }> = [{ scope: 'global' }];
					if (projectPath) scopes.push({ scope: 'project', projectPath });
					const allResults: MemorySearchResult[] = [];
					for (const s of scopes) {
						const results = await memoryStore.tagSearch(tags, s.scope, undefined, s.projectPath);
						for (const r of results) {
							allResults.push({
								entry: r.entry,
								similarity: r.tagScore,
								combinedScore: r.tagScore,
							});
						}
					}
					allResults.sort((a, b) => b.combinedScore - a.combinedScore);
					return allResults.slice(0, 30);
				}
				// Default: cascading search
				return memoryStore.cascadingSearch(query, config, agentType, projectPath);
			}
		)
	);

	// ─── Utility ──────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:getStats',
		createIpcDataHandler(handlerOpts('getStats'), async (): Promise<MemoryStats> => {
			// Delegate to getAnalytics which computes the full MemoryStats including analytics fields
			return memoryStore.getAnalytics();
		})
	);

	ipcMain.handle(
		'memory:export',
		createIpcDataHandler(
			handlerOpts('export'),
			async (scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				const memories = await memoryStore.listMemories(scope, skillAreaId, projectPath, true);
				return { memories, exportedAt: Date.now(), scope, skillAreaId, projectPath };
			}
		)
	);

	ipcMain.handle(
		'memory:import',
		createIpcDataHandler(
			handlerOpts('import'),
			async (
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
			) => {
				let imported = 0;
				for (const m of json.memories) {
					await memoryStore.addMemory(
						{
							content: m.content,
							type: m.type,
							scope,
							skillAreaId,
							tags: m.tags,
							source: 'import',
							confidence: m.confidence,
							pinned: m.pinned,
							experienceContext: m.experienceContext,
						},
						projectPath
					);
					imported++;
				}
				logger.info(`Imported ${imported} memories into scope=${scope}`, LOG_CONTEXT);
				return { imported };
			}
		)
	);

	ipcMain.handle(
		'memory:getProjectDigest',
		createIpcDataHandler(handlerOpts('getProjectDigest'), async (projectPath: string) => {
			return memoryStore.generateProjectDigest(projectPath);
		})
	);

	ipcMain.handle(
		'memory:consolidate',
		createIpcDataHandler(
			handlerOpts('consolidate'),
			async (scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				const config = await memoryStore.getConfig();
				const mergeCount = await memoryStore.consolidateMemories(
					scope,
					config,
					skillAreaId,
					projectPath
				);
				logger.info(`Consolidated ${mergeCount} memory groups in scope=${scope}`, LOG_CONTEXT);
				return { consolidated: mergeCount };
			}
		)
	);

	ipcMain.handle(
		'memory:ensureEmbeddings',
		createIpcDataHandler(
			handlerOpts('ensureEmbeddings'),
			async (scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				const memoriesUpdated = await memoryStore.ensureAllEmbeddings(
					scope,
					skillAreaId,
					projectPath
				);
				const hierarchyUpdated = await memoryStore.ensureHierarchyEmbeddings();
				return { memoriesUpdated, hierarchyUpdated };
			}
		)
	);

	ipcMain.handle(
		'memory:seedDefaults',
		createIpcDataHandler(handlerOpts('seedDefaults'), async () => {
			return memoryStore.seedFromDefaults();
		})
	);

	ipcMain.handle(
		'memory:resetSeedDefaults',
		createIpcDataHandler(handlerOpts('resetSeedDefaults'), async () => {
			return memoryStore.resetToSeedDefaults();
		})
	);

	// ─── Promotion ───────────────────────────────────────────────────

	ipcMain.handle(
		'memory:getPromotionCandidates',
		createIpcDataHandler(handlerOpts('getPromotionCandidates'), async () => {
			return memoryStore.getPromotionCandidates();
		})
	);

	ipcMain.handle(
		'memory:promote',
		createIpcDataHandler(
			handlerOpts('promote'),
			async (
				id: string,
				ruleText: string,
				scope: MemoryScope,
				skillAreaId?: SkillAreaId,
				projectPath?: string
			) => {
				return memoryStore.promoteExperience(id, ruleText, scope, skillAreaId, projectPath);
			}
		)
	);

	ipcMain.handle(
		'memory:dismissPromotion',
		createIpcDataHandler(
			handlerOpts('dismissPromotion'),
			async (id: string, scope: MemoryScope, skillAreaId?: SkillAreaId, projectPath?: string) => {
				return memoryStore.dismissPromotion(id, scope, skillAreaId, projectPath);
			}
		)
	);

	ipcMain.handle(
		'memory:promoteCrossProject',
		createIpcDataHandler(
			handlerOpts('promoteCrossProject'),
			async (id: string, ruleText: string, sourceProjectDirHash: string) => {
				return memoryStore.promoteCrossProjectExperience(id, ruleText, sourceProjectDirHash);
			}
		)
	);

	// ─── Hierarchy Suggestions ────────────────────────────────────────

	ipcMain.handle(
		'memory:suggestHierarchy',
		createIpcDataHandler(handlerOpts('suggestHierarchy'), async (projectPath: string) => {
			const [skillSuggestions, personaSuggestions, relevance] = await Promise.all([
				memoryStore.suggestSkillAreas(projectPath),
				memoryStore.suggestPersonas(projectPath),
				memoryStore.computePersonaRelevance(projectPath),
			]);
			return { skillSuggestions, personaSuggestions, relevance };
		})
	);

	// ─── Inter-Memory Linking ─────────────────────────────────────────

	ipcMain.handle(
		'memory:link',
		createIpcDataHandler(
			handlerOpts('link'),
			async (
				idA: string,
				scopeA: MemoryScope,
				idB: string,
				scopeB: MemoryScope,
				skillAreaIdA?: string,
				projectPathA?: string,
				skillAreaIdB?: string,
				projectPathB?: string
			) => {
				await memoryStore.linkMemories(
					idA,
					scopeA,
					idB,
					scopeB,
					skillAreaIdA,
					projectPathA,
					skillAreaIdB,
					projectPathB
				);
				return { linked: true };
			}
		)
	);

	ipcMain.handle(
		'memory:unlink',
		createIpcDataHandler(
			handlerOpts('unlink'),
			async (
				idA: string,
				scopeA: MemoryScope,
				idB: string,
				scopeB: MemoryScope,
				skillAreaIdA?: string,
				projectPathA?: string,
				skillAreaIdB?: string,
				projectPathB?: string
			) => {
				await memoryStore.unlinkMemories(
					idA,
					scopeA,
					idB,
					scopeB,
					skillAreaIdA,
					projectPathA,
					skillAreaIdB,
					projectPathB
				);
				return { unlinked: true };
			}
		)
	);

	ipcMain.handle(
		'memory:getLinked',
		createIpcDataHandler(
			handlerOpts('getLinked'),
			async (id: string, scope: MemoryScope, skillAreaId?: string, projectPath?: string) => {
				return memoryStore.getLinkedMemories(id, scope, skillAreaId, projectPath);
			}
		)
	);

	// ─── Analytics ────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:getAnalytics',
		createIpcDataHandler(handlerOpts('getAnalytics'), async () => {
			return memoryStore.getAnalytics();
		})
	);

	// ─── Recent Injections ───────────────────────────────────────────────

	ipcMain.handle(
		'memory:getRecentInjections',
		createIpcDataHandler(handlerOpts('getRecentInjections'), async (limit?: number) => {
			const { getRecentInjectionEvents } = await import('../../memory/memory-injector');
			return getRecentInjectionEvents(limit);
		})
	);

	// ─── Injection Diagnostics ──────────────────────────────────────────

	ipcMain.handle(
		'memory:debugInjection',
		createIpcDataHandler(handlerOpts('debugInjection'), async () => {
			const { debugInjectionPipeline } = await import('../../memory/memory-injector');
			return debugInjectionPipeline();
		})
	);

	// ─── Job Queue Status & Token Tracking ───────────────────────────────

	ipcMain.handle(
		'memory:getJobQueueStatus',
		createIpcDataHandler(handlerOpts('getJobQueueStatus'), async () => {
			const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
			return getMemoryJobQueue().getStatus();
		})
	);

	ipcMain.handle(
		'memory:getTokenUsage',
		createIpcDataHandler(handlerOpts('getTokenUsage'), async () => {
			const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
			return getMemoryJobQueue().getTokenUsage();
		})
	);

	ipcMain.handle(
		'memory:getStoreSize',
		createIpcDataHandler(handlerOpts('getStoreSize'), async () => {
			return store.getStoreSize();
		})
	);

	// ─── Retroactive Analysis ────────────────────────────────────────────

	ipcMain.handle(
		'memory:analyzeHistoricalSessions',
		createIpcDataHandler(handlerOpts('analyzeHistoricalSessions'), async () => {
			const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
			return getMemoryJobQueue().enqueueRetroactiveAnalysis();
		})
	);

	ipcMain.handle(
		'memory:getAnalysisStats',
		createIpcDataHandler(handlerOpts('getAnalysisStats'), async () => {
			const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
			return getMemoryJobQueue().getAnalysisStats();
		})
	);

	ipcMain.handle(
		'memory:analyzeAgentSessions',
		createIpcDataHandler(
			handlerOpts('analyzeAgentSessions'),
			async (agentId: string, agentType: string, projectPath?: string) => {
				const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
				return getMemoryJobQueue().enqueueAgentAnalysis(agentId, agentType, projectPath);
			}
		)
	);

	ipcMain.handle(
		'memory:getAgentAnalysisStats',
		createIpcDataHandler(handlerOpts('getAgentAnalysisStats'), async (agentId: string) => {
			const { getMemoryJobQueue } = await import('../../memory/memory-job-queue');
			return getMemoryJobQueue().getAgentAnalysisStats(agentId);
		})
	);

	// ─── Experience Repository (Bundle Operations) ─────────────────────

	ipcMain.handle(
		'memory:repository:importFromFile',
		createIpcDataHandler(handlerOpts('repository:importFromFile'), async (filePath: string) => {
			const { importBundle, validateBundleIntegrity, verifyBundleSignature } =
				await import('../../memory/experience-bundle');
			const content = await fs.readFile(filePath, 'utf-8');
			const parsed = JSON.parse(content);

			// Determine if signed or unsigned
			const isSigned = 'signature' in parsed && 'signingKey' in parsed && 'algorithm' in parsed;
			const bundle = isSigned ? parsed.bundle : parsed;

			// Validate
			const validation = validateBundleIntegrity(bundle);
			if (!validation.valid) {
				return { success: false, errors: validation.errors };
			}

			// Verify signature if signed
			let signatureVerified = false;
			let signerTrusted = false;
			let signatureStatus: 'unsigned' | 'verified' | 'untrusted' | 'invalid' = 'unsigned';

			if (isSigned) {
				const sigResult = await verifyBundleSignature(parsed);
				if (!sigResult.valid) {
					signatureStatus = 'invalid';
					return { success: false, signatureStatus, errors: ['Invalid signature'] };
				}
				signatureVerified = true;
				signerTrusted = sigResult.trusted;
				signatureStatus = signerTrusted ? 'verified' : 'untrusted';
			}

			const result = await importBundle(bundle, signatureVerified, signerTrusted);
			return { success: true, signatureStatus, result };
		})
	);

	ipcMain.handle(
		'memory:repository:export',
		createIpcDataHandler(
			handlerOpts('repository:export'),
			async (
				name: string,
				description: string,
				author: string,
				memoryIds: string[],
				version?: string
			) => {
				const { exportAsBundle } = await import('../../memory/experience-bundle');
				return exportAsBundle(memoryIds, 'global', {
					name,
					description,
					author,
					...(version ? { minMaestroVersion: version } : {}),
				});
			}
		)
	);

	ipcMain.handle(
		'memory:repository:verifySignature',
		createIpcDataHandler(handlerOpts('repository:verifySignature'), async (filePath: string) => {
			const { verifyBundleSignature } = await import('../../memory/experience-bundle');
			const content = await fs.readFile(filePath, 'utf-8');
			const signed = JSON.parse(content);
			if (!('signature' in signed)) return { signed: false };
			const { valid, trusted } = await verifyBundleSignature(signed);
			return { signed: true, valid, trusted, signerKey: signed.signingKey };
		})
	);

	ipcMain.handle(
		'memory:repository:getImportedBundles',
		createIpcDataHandler(handlerOpts('repository:getImportedBundles'), async () => {
			const { getImportedBundles } = await import('../../memory/experience-bundle');
			return getImportedBundles();
		})
	);

	ipcMain.handle(
		'memory:repository:uninstall',
		createIpcDataHandler(handlerOpts('repository:uninstall'), async (bundleId: string) => {
			const { uninstallBundle } = await import('../../memory/experience-bundle');
			return uninstallBundle(bundleId);
		})
	);

	// ─── Trusted Key Management ─────────────────────────────────────────

	ipcMain.handle(
		'memory:repository:getTrustedKeys',
		createIpcDataHandler(handlerOpts('repository:getTrustedKeys'), async () => {
			const { getTrustedKeys } = await import('../../memory/experience-bundle');
			return getTrustedKeys();
		})
	);

	ipcMain.handle(
		'memory:repository:addTrustedKey',
		createIpcDataHandler(
			handlerOpts('repository:addTrustedKey'),
			async (publicKey: string, label: string) => {
				const { addTrustedKey } = await import('../../memory/experience-bundle');
				await addTrustedKey({
					publicKey,
					name: label,
					addedAt: Date.now(),
					expiresAt: 0,
					fingerprint: crypto
						.createHash('sha256')
						.update(Buffer.from(publicKey, 'hex'))
						.digest('hex')
						.slice(0, 16),
				});
				return { added: true };
			}
		)
	);

	ipcMain.handle(
		'memory:repository:removeTrustedKey',
		createIpcDataHandler(handlerOpts('repository:removeTrustedKey'), async (publicKey: string) => {
			const { removeTrustedKey } = await import('../../memory/experience-bundle');
			await removeTrustedKey(publicKey);
			return { removed: true };
		})
	);

	// ─── API Stubs (not yet available) ───────────────────────────────────

	ipcMain.handle(
		'memory:repository:browseCatalog',
		createIpcDataHandler(
			handlerOpts('repository:browseCatalog'),
			async (_query?: string, _page?: number, _pageSize?: number) => {
				// TODO: Implement when Global Experience Repository API is available
				return {
					entries: [],
					totalCount: 0,
					page: 1,
					pageSize: 20,
					_stub: true,
					_message: 'Global Experience Repository API not yet available',
				};
			}
		)
	);

	ipcMain.handle(
		'memory:repository:download',
		createIpcDataHandler(handlerOpts('repository:download'), async (_bundleId: string) => {
			// TODO: Implement when Global Experience Repository API is available
			return {
				success: false,
				error: 'Global Experience Repository API not yet available',
				_stub: true,
			};
		})
	);

	ipcMain.handle(
		'memory:repository:submit',
		createIpcDataHandler(
			handlerOpts('repository:submit'),
			async (
				_name: string,
				_description: string,
				_author: string,
				_memoryIds: string[],
				_submitterName?: string,
				_submitterEmail?: string,
				_reviewNotes?: string
			) => {
				// TODO: Implement when Global Experience Repository API is available
				return {
					accepted: false,
					message:
						'Global Experience Repository API not yet available. Export your bundle locally and share it manually.',
					_stub: true,
				};
			}
		)
	);
}
