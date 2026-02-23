/**
 * Agent Experiences Memory IPC Handlers
 *
 * Provides IPC handlers for the full memory hierarchy (roles, personas, skill areas,
 * memories) plus config, search, import/export, and utility operations.
 *
 * All channels are prefixed with `memory:` and subnamespaced by entity type.
 */

import { ipcMain } from 'electron';
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
		createIpcDataHandler(handlerOpts('role:create'), async (name: string, description: string) => {
			return memoryStore.createRole(name, description);
		})
	);

	ipcMain.handle(
		'memory:role:update',
		createIpcDataHandler(
			handlerOpts('role:update'),
			async (id: string, updates: { name?: string; description?: string }) => {
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
				assignedProjects?: string[]
			) => {
				return memoryStore.createPersona(
					roleId,
					name,
					description,
					assignedAgents,
					assignedProjects
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
				return memoryStore.addMemory(entry, projectPath);
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
			async (query: string, agentType: string, projectPath?: string) => {
				const config = await memoryStore.getConfig();
				return memoryStore.cascadingSearch(query, config, agentType, projectPath);
			}
		)
	);

	// ─── Utility ──────────────────────────────────────────────────────────

	ipcMain.handle(
		'memory:getStats',
		createIpcDataHandler(handlerOpts('getStats'), async (): Promise<MemoryStats> => {
			const roles = await memoryStore.listRoles();
			const personas = await memoryStore.listPersonas();
			const skillAreas = await memoryStore.listSkillAreas();

			const byScope: Record<MemoryScope, number> = { skill: 0, project: 0, global: 0 };
			const bySource: Record<MemorySource, number> = {
				user: 0,
				grpo: 0,
				'auto-run': 0,
				'session-analysis': 0,
				consolidation: 0,
				import: 0,
			};
			const byType: Record<MemoryType, number> = { rule: 0, experience: 0 };
			let totalMemories = 0;
			let totalInjections = 0;
			let effectivenessSum = 0;
			let effectivenessCount = 0;
			let pendingEmbeddings = 0;

			// Collect memories from all skill areas
			for (const skill of skillAreas) {
				const memories = await memoryStore.listMemories('skill', skill.id, undefined, true);
				for (const m of memories) {
					totalMemories++;
					byScope.skill++;
					bySource[m.source]++;
					byType[m.type]++;
					totalInjections += m.useCount;
					if (m.effectivenessScore > 0) {
						effectivenessSum += m.effectivenessScore;
						effectivenessCount++;
					}
					if (!m.embedding) pendingEmbeddings++;
				}
			}

			// Collect global memories
			const globalMemories = await memoryStore.listMemories('global', undefined, undefined, true);
			for (const m of globalMemories) {
				totalMemories++;
				byScope.global++;
				bySource[m.source]++;
				byType[m.type]++;
				totalInjections += m.useCount;
				if (m.effectivenessScore > 0) {
					effectivenessSum += m.effectivenessScore;
					effectivenessCount++;
				}
				if (!m.embedding) pendingEmbeddings++;
			}

			// Check persona/skill embeddings
			for (const p of personas) {
				if (!p.embedding) pendingEmbeddings++;
			}
			for (const s of skillAreas) {
				if (!s.embedding) pendingEmbeddings++;
			}

			return {
				totalRoles: roles.length,
				totalPersonas: personas.length,
				totalSkillAreas: skillAreas.length,
				totalMemories,
				byScope,
				bySource,
				byType,
				totalInjections,
				averageEffectiveness: effectivenessCount > 0 ? effectivenessSum / effectivenessCount : 0,
				pendingEmbeddings,
			};
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
}
