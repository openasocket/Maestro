/**
 * MemoryInjector — retrieves relevant memories via cascading search
 * and formats them as a system prompt prefix for agent injection.
 *
 * Cascading pipeline: prompt → persona match → skill match → memory search
 * Groups output by persona/skill for readable injection.
 */

import type {
	MemoryConfig,
	MemoryInjectionResult,
	MemorySearchResult,
	MemoryId,
	MemoryScope,
	SkillAreaId,
	InjectionScopeGroup,
} from '../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../shared/memory-types';
import { getMemoryStore } from './memory-store';

// ─── Settings Store ─────────────────────────────────────────────────────────

type MemorySettingsGetter = () => Partial<MemoryConfig> | undefined;

let _settingsGetter: MemorySettingsGetter | null = null;

/**
 * Set the settings store getter — called once during init.
 * The getter returns the user's memory config overrides from the settings store.
 */
export function setMemorySettingsStore(getter: MemorySettingsGetter): void {
	_settingsGetter = getter;
}

function getConfig(): MemoryConfig {
	const overrides = _settingsGetter?.() ?? {};
	return { ...MEMORY_CONFIG_DEFAULTS, ...overrides };
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Overhead tokens for the XML wrapper, section headers, etc. */
const WRAPPER_OVERHEAD_TOKENS = 150;

// ─── Budget-First Allocation ────────────────────────────────────────────────

/** Per-scope token budgets computed before retrieval. */
interface ScopeBudgets {
	skill: number;
	project: number;
	global: number;
	total: number;
}

/**
 * Compute per-scope token budgets based on injection strategy and total budget.
 *
 * Budget-first allocation (Agentic Engineering Book pattern):
 * Instead of retrieving everything and truncating, allocate budgets per tier
 * BEFORE searching. Each scope searches within its allocated budget.
 *
 * Allocation ratios:
 *   Skill memories:   50% (hierarchy-based, highest precision)
 *   Project memories:  30% (project-specific facts)
 *   Global memories:   20% (universal rules)
 */
function computeScopeBudgets(config: MemoryConfig): ScopeBudgets {
	let total: number;

	switch (config.injectionStrategy) {
		case 'lean':
			total = Math.min(config.maxTokenBudget, 600);
			break;
		case 'rich':
			total = Math.min(config.maxTokenBudget * 1.5, 3000);
			break;
		case 'balanced':
		default:
			total = config.maxTokenBudget;
			break;
	}

	// Reserve overhead from the usable total
	const usable = Math.max(total - WRAPPER_OVERHEAD_TOKENS, 0);

	return {
		skill: Math.floor(usable * 0.5),
		project: Math.floor(usable * 0.3),
		global: Math.floor(usable * 0.2),
		total,
	};
}

// ─── Formatting ─────────────────────────────────────────────────────────────

interface GroupedMemories {
	/** Key: "[PersonaName > SkillName]" or "[project]" or "[global]" */
	key: string;
	/** Sort priority: hierarchy first, then project, then global */
	priority: number;
	lines: string[];
	tokenCost: number;
	/** Role behavioral directive (set once per role, deduped by role name) */
	roleSystemPrompt?: string;
	/** Persona behavioral directive (set once per persona group, deduped by persona name) */
	personaSystemPrompt?: string;
}

/**
 * Build a display line for a single memory entry.
 * Rules render as plain bullets; experiences get an (experience) prefix.
 */
function formatMemoryLine(result: MemorySearchResult): string {
	const prefix = result.entry.type === 'experience' ? '(experience) ' : '';
	return `- ${prefix}${result.entry.content}`;
}

/**
 * Build an XML comment explaining why a memory was injected.
 * Helps power users understand injection reasoning in debug mode.
 */
function formatMatchComment(result: MemorySearchResult): string {
	const matchReason = result.personaName
		? `matched persona="${result.personaName}" skill="${result.skillAreaName ?? 'n/a'}" score=${result.combinedScore.toFixed(2)}`
		: `matched scope="${result.entry.scope}" score=${result.combinedScore.toFixed(2)}`;
	return `<!-- ${matchReason} -->`;
}

/**
 * Determine the grouping key and priority for a search result.
 */
function getGroupKey(result: MemorySearchResult): { key: string; priority: number } {
	if (result.personaName && result.skillAreaName) {
		return { key: `[${result.personaName} > ${result.skillAreaName}]`, priority: 0 };
	}
	if (result.personaName) {
		return { key: `[${result.personaName}]`, priority: 0 };
	}
	if (result.entry.scope === 'project') {
		// Render digest entries as [project-digest] group
		if (result.entry.tags.includes('system:project-digest')) {
			return { key: '[project-digest]', priority: 1 };
		}
		return { key: '[project]', priority: 1 };
	}
	return { key: '[global]', priority: 2 };
}

/**
 * Format selected memories into the XML injection block.
 * When includeComments is true, adds XML comments before each memory
 * explaining why it was injected (omitted in lean mode to save tokens).
 */
function formatXmlBlock(selected: MemorySearchResult[], includeComments: boolean): string {
	// Group by key
	const groupMap = new Map<string, GroupedMemories>();
	// Track which role/persona prompts we've already captured (dedup by name)
	const seenRolePrompts = new Set<string>();
	const seenPersonaPrompts = new Set<string>();

	for (const result of selected) {
		const { key, priority } = getGroupKey(result);
		let group = groupMap.get(key);
		if (!group) {
			group = { key, priority, lines: [], tokenCost: 0 };
			groupMap.set(key, group);
		}
		// Capture role system prompt once per role (first group that references this role gets it)
		if (
			result.roleName &&
			result.roleSystemPrompt &&
			!seenRolePrompts.has(result.roleName) &&
			!group.roleSystemPrompt
		) {
			group.roleSystemPrompt = result.roleSystemPrompt;
			seenRolePrompts.add(result.roleName);
		}
		// Capture persona system prompt once per persona (first group that references this persona gets it)
		if (
			result.personaName &&
			result.personaSystemPrompt &&
			!seenPersonaPrompts.has(result.personaName) &&
			!group.personaSystemPrompt
		) {
			group.personaSystemPrompt = result.personaSystemPrompt;
			seenPersonaPrompts.add(result.personaName);
		}
		if (includeComments) {
			group.lines.push(formatMatchComment(result));
		}
		group.lines.push(formatMemoryLine(result));
		group.tokenCost += result.entry.tokenEstimate;
	}

	// Sort groups: hierarchy (0) → project (1) → global (2), then alphabetically
	const groups = Array.from(groupMap.values()).sort((a, b) => {
		if (a.priority !== b.priority) return a.priority - b.priority;
		return a.key.localeCompare(b.key);
	});

	// Build XML — include role and persona directives before memory entries when present
	const sections = groups.map((g) => {
		const parts: string[] = [g.key];
		if (g.roleSystemPrompt) {
			parts.push(`<role-directive>\n${g.roleSystemPrompt}\n</role-directive>`);
		}
		if (g.personaSystemPrompt) {
			parts.push(`<persona-directive>\n${g.personaSystemPrompt}\n</persona-directive>`);
		}
		parts.push(g.lines.join('\n'));
		return parts.join('\n');
	});

	return `<agent-memories>\nRelevant knowledge for this task:\n\n${sections.join('\n\n')}\n</agent-memories>`;
}

/**
 * Render persona/role behavioral directives as an XML block without memory entries.
 * Used when personas match but have no memories in matching skill areas.
 */
function formatPersonaDirectivesOnly(
	matchedPersonas: Array<{
		persona: { systemPrompt?: string; id: string };
		personaName: string;
		roleName: string;
		roleSystemPrompt: string;
	}>
): string {
	const seenRoles = new Set<string>();
	const seenPersonas = new Set<string>();
	const parts: string[] = [];

	for (const mp of matchedPersonas) {
		if (mp.roleSystemPrompt && mp.roleName && !seenRoles.has(mp.roleName)) {
			parts.push(`<role-directive>\n${mp.roleSystemPrompt}\n</role-directive>`);
			seenRoles.add(mp.roleName);
		}
		if (mp.persona.systemPrompt && mp.personaName && !seenPersonas.has(mp.personaName)) {
			parts.push(`<persona-directive>\n${mp.persona.systemPrompt}\n</persona-directive>`);
			seenPersonas.add(mp.personaName);
		}
	}

	if (parts.length === 0) return '';
	return `<agent-persona>\n${parts.join('\n\n')}\n</agent-persona>`;
}

// ─── Core Injection ─────────────────────────────────────────────────────────

/**
 * Greedy token selection within a budget — picks results by combinedScore
 * until the budget is exhausted.
 */
function selectWithinBudget(
	results: MemorySearchResult[],
	tokenBudget: number
): MemorySearchResult[] {
	const selected: MemorySearchResult[] = [];
	let used = 0;
	for (const r of results) {
		const cost = r.entry.tokenEstimate;
		if (used + cost > tokenBudget) continue;
		selected.push(r);
		used += cost;
	}
	return selected;
}

/**
 * Retrieve relevant memories via budget-first allocation and format them
 * as an XML block prepended to the user's prompt.
 *
 * Budget-first flow:
 * 1. Compute per-scope budgets via computeScopeBudgets()
 * 2. Run searches per scope with scope-specific limits
 * 3. Each scope fills its budget independently — no scope can starve another
 * 4. Combine results preserving scope ordering (skill > project > global)
 * 5. Apply strategy-specific filters (lean/rich)
 */
export async function injectMemories(
	prompt: string,
	projectPath: string,
	agentType: string,
	searchQuery?: string,
	selectedPersonaIds?: string[]
): Promise<MemoryInjectionResult> {
	const config = getConfig();

	// If disabled, return unchanged prompt
	if (!config.enabled) {
		console.log('[memory-inject] Skipped: memory system is disabled (config.enabled = false)');
		return {
			injectedPrompt: prompt,
			injectedIds: [],
			tokenCount: 0,
			personaContributions: [],
			flatScopeCounts: { project: 0, global: 0 },
			scopeGroups: [],
		};
	}

	const store = getMemoryStore();
	const budgets = computeScopeBudgets(config);
	const effectiveQuery = query(searchQuery ?? prompt);

	// Optionally adjust config for rich mode (lower similarity threshold)
	const searchConfig: MemoryConfig =
		config.injectionStrategy === 'rich'
			? {
					...config,
					similarityThreshold: Math.max(config.similarityThreshold - 0.1, 0.1),
				}
			: config;

	// ── Per-scope searches ───────────────────────────────────────────────

	let selectedSkill: MemorySearchResult[];
	// Hoist skill-scope raw results so the `rich` strategy block can access them
	// regardless of whether we took the explicit or automatic persona path.
	let skillResults: MemorySearchResult[] = [];

	if (selectedPersonaIds && selectedPersonaIds.length > 0) {
		// Explicit persona path: load user-selected personas and their memories
		const explicitResults: MemorySearchResult[] = [];
		const resolvedPersonas: Array<{
			persona: { systemPrompt?: string; id: string };
			personaName: string;
			roleName: string;
			roleSystemPrompt: string;
		}> = [];

		for (const pid of selectedPersonaIds) {
			const persona = await store.getPersona(pid);
			if (!persona || !persona.active) continue;
			const role = await store.getRole(persona.roleId);
			resolvedPersonas.push({
				persona,
				personaName: persona.name,
				roleName: role?.name ?? '',
				roleSystemPrompt: role?.systemPrompt ?? '',
			});

			// Search memories in each skill area
			for (const skillId of persona.skillAreaIds) {
				const skill = await store.getSkillArea(skillId);
				if (!skill || !skill.active) continue;

				if (searchConfig.enableHybridSearch) {
					const skillMemResults = await store.hybridSearch(
						effectiveQuery,
						'skill',
						searchConfig,
						skill.id,
						undefined,
						50
					);
					for (const r of skillMemResults) {
						explicitResults.push({
							...r,
							roleName: role?.name ?? '',
							roleSystemPrompt: role?.systemPrompt ?? '',
							personaName: persona.name,
							personaSystemPrompt: persona.systemPrompt ?? '',
							personaId: persona.id,
							skillAreaName: skill.name,
						});
					}
				} else {
					const { encode, cosineSimilarity } = await import('../grpo/embedding-service');
					const qEmbed = await encode(effectiveQuery);
					const entries = await store.listMemories('skill', skill.id);
					for (const entry of entries) {
						if (!entry.embedding) continue;
						const similarity = cosineSimilarity(qEmbed, entry.embedding);
						if (similarity < searchConfig.similarityThreshold) continue;
						explicitResults.push({
							entry,
							similarity,
							combinedScore: similarity,
							roleName: role?.name ?? '',
							roleSystemPrompt: role?.systemPrompt ?? '',
							personaName: persona.name,
							personaSystemPrompt: persona.systemPrompt ?? '',
							personaId: persona.id,
							skillAreaName: skill.name,
						});
					}
				}
			}
		}

		// If personas resolved but no memories found, inject directives only
		if (resolvedPersonas.length > 0 && explicitResults.length === 0) {
			const directiveBlock = formatPersonaDirectivesOnly(resolvedPersonas);
			if (directiveBlock) {
				explicitResults.push({
					entry: {
						id: 'persona-directives-only',
						content: directiveBlock,
						type: 'rule',
						scope: 'skill',
						tags: ['system:persona-directives'],
						source: 'consolidation',
						confidence: 1.0,
						pinned: true,
						active: true,
						archived: false,
						embedding: null,
						effectivenessScore: 0.5,
						useCount: 0,
						tokenEstimate: Math.ceil(directiveBlock.length / 4),
						lastUsedAt: 0,
						createdAt: Date.now(),
						updatedAt: Date.now(),
					},
					similarity: 1.0,
					combinedScore: 1.0,
					personaName: resolvedPersonas[0].personaName,
					personaId: resolvedPersonas[0].persona.id,
					roleName: resolvedPersonas[0].roleName,
					roleSystemPrompt: resolvedPersonas[0].roleSystemPrompt,
				});
			}
		}

		skillResults = explicitResults;
		selectedSkill = selectWithinBudget(explicitResults, budgets.skill);
	} else {
		// Automatic persona path: cascading persona → skill → memory search
		skillResults = await store.cascadingSearch(
			effectiveQuery,
			searchConfig,
			agentType,
			projectPath
		);
		if (skillResults.length === 0) {
			console.log('[memory-inject] cascadingSearch returned 0 results for:', {
				agentType,
				projectPath,
				taskContextPreview: effectiveQuery.slice(0, 200),
			});
		}
		// Filter to skill-scope only (cascading search returns all scopes)
		const skillOnly = skillResults.filter((r) => r.personaName || r.entry.scope === 'skill');
		selectedSkill = selectWithinBudget(skillOnly, budgets.skill);
	}

	// Project search: flat search within project scope
	let projectSearchResults: MemorySearchResult[] = [];
	if (projectPath) {
		if (searchConfig.enableHybridSearch) {
			projectSearchResults = await store.hybridSearch(
				effectiveQuery,
				'project',
				searchConfig,
				undefined,
				projectPath
			);
		} else {
			const { encode } = await import('../grpo/embedding-service');
			const qEmbed = await encode(effectiveQuery);
			projectSearchResults = await store.searchFlatScope(
				qEmbed,
				'project',
				searchConfig,
				projectPath
			);
		}
	}
	const selectedProject = selectWithinBudget(projectSearchResults, budgets.project);

	// Global search: flat search within global scope
	let globalSearchResults: MemorySearchResult[];
	if (searchConfig.enableHybridSearch) {
		globalSearchResults = await store.hybridSearch(effectiveQuery, 'global', searchConfig);
	} else {
		const { encode } = await import('../grpo/embedding-service');
		const qEmbed = await encode(effectiveQuery);
		globalSearchResults = await store.searchFlatScope(qEmbed, 'global', searchConfig);
	}
	const selectedGlobal = selectWithinBudget(globalSearchResults, budgets.global);

	// ── Combine results preserving scope ordering (skill > project > global) ──
	const selected: MemorySearchResult[] = [...selectedSkill, ...selectedProject, ...selectedGlobal];

	// De-duplicate (skill search may include project/global results)
	const seen = new Set<string>();
	const deduped: MemorySearchResult[] = [];
	for (const r of selected) {
		if (seen.has(r.entry.id)) continue;
		seen.add(r.entry.id);
		deduped.push(r);
	}

	// ── Strategy-specific post-filters ───────────────────────────────────

	let finalSelected: MemorySearchResult[];
	if (config.injectionStrategy === 'lean') {
		// Lean: only high-effectiveness memories, max 5
		finalSelected = deduped.filter((r) => r.entry.effectivenessScore >= 0.5).slice(0, 5);
	} else if (config.injectionStrategy === 'rich' && projectPath) {
		// Rich: inject project digest as first project block if available
		finalSelected = [...deduped];
		const digest = await store.generateProjectDigest(projectPath, 10);
		if (digest) {
			const digestTokens = Math.ceil(digest.length / 4);
			const digestResult: MemorySearchResult = {
				entry: {
					id: 'project-digest',
					content: digest,
					type: 'rule',
					scope: 'project',
					tags: ['system:project-digest'],
					source: 'consolidation',
					confidence: 1.0,
					pinned: true,
					active: true,
					archived: false,
					embedding: null,
					effectivenessScore: 0.5,
					useCount: 0,
					tokenEstimate: digestTokens,
					lastUsedAt: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
				similarity: 1.0,
				combinedScore: 1.0,
			};
			// Insert digest before other project entries
			const firstProjectIdx = finalSelected.findIndex(
				(r) => r.entry.scope === 'project' && !r.personaName
			);
			if (firstProjectIdx >= 0) {
				finalSelected.splice(firstProjectIdx, 0, digestResult);
			} else {
				// No project entries — add after skill entries
				let lastSkillIdx = -1;
				for (let i = finalSelected.length - 1; i >= 0; i--) {
					if (finalSelected[i].personaName || finalSelected[i].entry.scope === 'skill') {
						lastSkillIdx = i;
						break;
					}
				}
				finalSelected.splice(lastSkillIdx + 1, 0, digestResult);
			}
		}

		// Rich: include recent experiences from last 3 sessions even if low similarity
		const now = Date.now();
		const threeSessions = 3 * 60 * 60 * 1000; // rough heuristic: 3 hours
		const recentExperiences = [
			...skillResults,
			...projectSearchResults,
			...globalSearchResults,
		].filter(
			(r) =>
				r.entry.type === 'experience' &&
				r.entry.createdAt > now - threeSessions &&
				!seen.has(r.entry.id)
		);
		for (const r of recentExperiences) {
			if (!seen.has(r.entry.id)) {
				seen.add(r.entry.id);
				finalSelected.push(r);
			}
		}
	} else {
		finalSelected = deduped;
	}

	let totalTokens = finalSelected.reduce((sum, r) => sum + r.entry.tokenEstimate, 0);

	// Nothing selected → inject persona directives if any match, else return unchanged
	if (finalSelected.length === 0) {
		// Record a "no match" event so the UI can surface it
		pushInjectionEvent({
			sessionId: '',
			memoryIds: [],
			tokenCount: 0,
			timestamp: Date.now(),
			scopeGroups: [],
			noMatch: true,
		});

		const matchedPersonas = await store.selectMatchingPersonas(
			effectiveQuery,
			searchConfig,
			agentType,
			projectPath
		);

		if (matchedPersonas.length > 0) {
			const directiveBlock = formatPersonaDirectivesOnly(matchedPersonas);
			if (directiveBlock) {
				const tokenCount = Math.ceil(directiveBlock.length / 4);
				return {
					injectedPrompt: directiveBlock + '\n\n' + prompt,
					injectedIds: [],
					tokenCount,
					personaContributions: matchedPersonas.map((mp) => ({
						personaId: mp.persona.id,
						personaName: mp.personaName,
						count: 0,
					})),
					flatScopeCounts: { project: 0, global: 0 },
					scopeGroups: [],
				};
			}
		}

		return {
			injectedPrompt: prompt,
			injectedIds: [],
			tokenCount: 0,
			personaContributions: [],
			flatScopeCounts: { project: 0, global: 0 },
			scopeGroups: [],
		};
	}

	// Project digest optimization for balanced mode: when many project memories
	// compete for budget, replace individual project entries with a single digest.
	let replacedProjectIds: MemoryId[] = [];
	if (config.injectionStrategy === 'balanced') {
		const projectResults = finalSelected.filter(
			(r) => r.entry.scope === 'project' && r.entry.id !== 'project-digest'
		);
		if (projectResults.length > 5 && projectPath) {
			const projectTokenCost = projectResults.reduce((sum, r) => sum + r.entry.tokenEstimate, 0);
			const projectTokenBudgetRatio = projectTokenCost / config.maxTokenBudget;

			if (projectTokenBudgetRatio > 0.4) {
				const digest = await store.generateProjectDigest(projectPath, 10);
				if (digest) {
					const digestTokens = Math.ceil(digest.length / 4);
					if (digestTokens < projectTokenCost) {
						replacedProjectIds = projectResults.map((r) => r.entry.id);
						const projectIdSet = new Set(replacedProjectIds);
						const nonProject = finalSelected.filter((r) => !projectIdSet.has(r.entry.id));

						const digestResult: MemorySearchResult = {
							entry: {
								id: 'project-digest',
								content: digest,
								type: 'rule',
								scope: 'project',
								tags: ['system:project-digest'],
								source: 'consolidation',
								confidence: 1.0,
								pinned: true,
								active: true,
								archived: false,
								embedding: null,
								effectivenessScore: 0.5,
								useCount: 0,
								tokenEstimate: digestTokens,
								lastUsedAt: 0,
								createdAt: Date.now(),
								updatedAt: Date.now(),
							},
							similarity: 1.0,
							combinedScore: 1.0,
						};

						finalSelected.length = 0;
						finalSelected.push(...nonProject, digestResult);
						totalTokens = finalSelected.reduce((sum, r) => sum + r.entry.tokenEstimate, 0);
					}
				}
			}
		}
	}

	// Format XML
	// Include injection transparency comments (omit in lean mode to save tokens)
	const includeComments = config.injectionStrategy !== 'lean';
	const xmlBlock = formatXmlBlock(finalSelected, includeComments);

	// Track persona contributions
	const personaMap = new Map<string, { personaName: string; personaId: string; count: number }>();
	let projectCount = 0;
	let globalCount = 0;

	for (const result of finalSelected) {
		if (result.personaName) {
			const existing = personaMap.get(result.personaName);
			if (existing) {
				existing.count++;
			} else {
				personaMap.set(result.personaName, {
					personaName: result.personaName,
					personaId: result.personaId ?? '',
					count: 1,
				});
			}
		} else if (result.entry.scope === 'project') {
			projectCount++;
		} else if (result.entry.scope === 'global') {
			globalCount++;
		}
	}

	const personaContributions = Array.from(personaMap.entries()).map(([, v]) => ({
		personaId: v.personaId,
		personaName: v.personaName,
		count: v.count,
	}));

	// Record injection — group by scope for batch recording.
	// Include replaced project IDs so effectiveness tracking covers all original memories.
	const injectedIds = [
		...finalSelected.map((r) => r.entry.id).filter((id) => id !== 'project-digest'),
		...replacedProjectIds,
	];
	const byScope = groupInjectedByScope(finalSelected);

	// Build scope groups with projectPath for effectiveness tracking
	const scopeGroups = byScope.map(({ scope, skillAreaId, ids }) => ({
		scope,
		skillAreaId,
		projectPath: scope === 'project' ? projectPath : undefined,
		ids,
	}));

	// Fire-and-forget — recording injection doesn't need to block agent start.
	// recordInjection() only updates useCount and lastUsedAt (analytics fields).
	// The injection record for effectiveness tracking is stored synchronously above.
	for (const { scope, skillAreaId, ids } of byScope) {
		store
			.recordInjection(ids, scope, skillAreaId, scope === 'project' ? projectPath : undefined)
			.catch((err) => {
				console.warn(`[MemoryInjector] recordInjection failed for scope=${scope}:`, err);
			});
	}

	// Prepend XML to prompt
	const injectedPrompt = `${xmlBlock}\n\n${prompt}`;
	const tokenCount = totalTokens + WRAPPER_OVERHEAD_TOKENS;

	// Extract persona/skill match data from skill-scope results for analytics
	const personaMatchMap = new Map<string, PersonaMatch>();
	const skillMatchMap = new Map<string, SkillMatch>();
	for (const r of skillResults) {
		if (r.personaId && r.personaName && !personaMatchMap.has(r.personaId)) {
			personaMatchMap.set(r.personaId, {
				personaId: r.personaId,
				personaName: r.personaName,
				score: r.combinedScore,
			});
		} else if (r.personaId && personaMatchMap.has(r.personaId)) {
			const existing = personaMatchMap.get(r.personaId)!;
			if (r.combinedScore > existing.score) existing.score = r.combinedScore;
		}
		const skillId = r.entry.skillAreaId;
		if (r.skillAreaName && skillId) {
			const key = skillId;
			if (!skillMatchMap.has(key)) {
				skillMatchMap.set(key, {
					skillAreaId: key,
					skillAreaName: r.skillAreaName,
					score: r.combinedScore,
				});
			} else {
				const existing = skillMatchMap.get(key)!;
				if (r.combinedScore > existing.score) existing.score = r.combinedScore;
			}
		}
	}

	// Record injection event for analytics ring buffer
	pushInjectionEvent({
		sessionId: '', // Populated later via recordSessionInjection
		memoryIds: injectedIds,
		tokenCount,
		timestamp: Date.now(),
		scopeGroups,
		matchedPersonas: personaMatchMap.size > 0 ? Array.from(personaMatchMap.values()) : undefined,
		matchedSkills: skillMatchMap.size > 0 ? Array.from(skillMatchMap.values()) : undefined,
	});

	// Report injection tokens to job queue tracker (fire-and-forget)
	try {
		const { getMemoryJobQueue } = await import('./memory-job-queue');
		getMemoryJobQueue().trackInjectionTokens(tokenCount);
	} catch {
		// Queue not available — skip tracking
	}

	return {
		injectedPrompt,
		injectedIds,
		tokenCount,
		personaContributions,
		flatScopeCounts: { project: projectCount, global: globalCount },
		scopeGroups,
	};
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a search query from the prompt — truncate to a reasonable length.
 */
function query(prompt: string): string {
	return prompt.slice(0, 2000);
}

/**
 * Group injected memory IDs by their scope for batch recordInjection calls.
 */
function groupInjectedByScope(
	selected: MemorySearchResult[]
): Array<{ scope: 'skill' | 'project' | 'global'; skillAreaId?: string; ids: MemoryId[] }> {
	const groups = new Map<
		string,
		{ scope: 'skill' | 'project' | 'global'; skillAreaId?: string; ids: MemoryId[] }
	>();

	for (const result of selected) {
		const scope = result.entry.scope;
		const skillAreaId = result.entry.skillAreaId;
		const key = scope === 'skill' ? `skill:${skillAreaId}` : scope;

		let group = groups.get(key);
		if (!group) {
			group = { scope, skillAreaId, ids: [] };
			groups.set(key, group);
		}
		group.ids.push(result.entry.id);
	}

	return Array.from(groups.values());
}

// ─── Defensive Wrapper ──────────────────────────────────────────────────────

/**
 * Safe wrapper around injectMemories — on any error, logs a warning
 * and returns the original prompt unchanged. This is what process.ts calls.
 */
export async function tryInjectMemories(
	prompt: string,
	projectPath: string,
	agentType: string,
	searchQuery?: string,
	selectedPersonaIds?: string[]
): Promise<MemoryInjectionResult> {
	try {
		return await injectMemories(prompt, projectPath, agentType, searchQuery, selectedPersonaIds);
	} catch (error) {
		console.warn('[MemoryInjector] Failed to inject memories, returning original prompt:', error);
		return {
			injectedPrompt: prompt,
			injectedIds: [],
			tokenCount: 0,
			personaContributions: [],
			flatScopeCounts: { project: 0, global: 0 },
			scopeGroups: [],
		};
	}
}

// ─── Injection Event Ring Buffer ─────────────────────────────────────────────

export interface PersonaMatch {
	personaId: string;
	personaName: string;
	score: number;
}

export interface SkillMatch {
	skillAreaId: string;
	skillAreaName: string;
	score: number;
}

export interface InjectionEvent {
	sessionId: string;
	memoryIds: MemoryId[];
	tokenCount: number;
	timestamp: number;
	scopeGroups: InjectionScopeGroup[];
	/** True when cascading search returned no matching memories for the task. */
	noMatch?: boolean;
	/** Personas matched during injection (with similarity scores). */
	matchedPersonas?: PersonaMatch[];
	/** Skill areas matched during injection (with similarity scores). */
	matchedSkills?: SkillMatch[];
}

const recentInjections: InjectionEvent[] = [];
const MAX_INJECTION_HISTORY = 200;

/**
 * Push an injection event to the ring buffer.
 * Automatically evicts oldest entries when exceeding MAX_INJECTION_HISTORY.
 */
function pushInjectionEvent(event: InjectionEvent): void {
	recentInjections.push(event);
	if (recentInjections.length > MAX_INJECTION_HISTORY) {
		recentInjections.shift();
	}
}

/**
 * Return the last N injection events (newest first).
 */
export function getRecentInjectionEvents(limit?: number): InjectionEvent[] {
	const n = limit ?? MAX_INJECTION_HISTORY;
	return recentInjections.slice(-n).reverse();
}

// ─── Session Injection Tracking ─────────────────────────────────────────────

/**
 * Scope metadata for a group of injected memories.
 * Used by effectiveness tracking to call updateEffectiveness per scope.
 */
export interface InjectionScopeRecord {
	scope: MemoryScope;
	skillAreaId?: SkillAreaId;
	projectPath?: string;
	ids: MemoryId[];
}

/**
 * Full injection record for a session.
 */
export interface InjectionRecord {
	ids: MemoryId[];
	scopeGroups: InjectionScopeRecord[];
}

/**
 * Module-level map of sessionId → injection record.
 * Used by effectiveness tracking (EXP-11) to correlate
 * session outcomes with which memories were injected.
 */
const _sessionInjections = new Map<string, InjectionRecord>();

/**
 * Record which memory IDs were injected for a given session,
 * along with scope grouping for per-scope effectiveness updates.
 * Called from process.ts after successful injection.
 */
export function recordSessionInjection(
	sessionId: string,
	memoryIds: MemoryId[],
	scopeGroups?: InjectionScopeRecord[]
): void {
	_sessionInjections.set(sessionId, {
		ids: memoryIds,
		scopeGroups: scopeGroups ?? [],
	});

	// Register spawn-time IDs with live context queue for dedup (EXP-LIVE-01).
	// Prevents re-injecting the same memories mid-session.
	import('./live-context-queue')
		.then(({ getLiveContextQueue }) => {
			getLiveContextQueue().markDelivered(sessionId, memoryIds);
		})
		.catch(() => {});
}

/**
 * Retrieve the memory IDs that were injected for a session.
 * Returns undefined if no injection was recorded.
 */
export function getSessionInjection(sessionId: string): MemoryId[] | undefined {
	const record = _sessionInjections.get(sessionId);
	return record?.ids;
}

/**
 * Retrieve the full injection record for a session (IDs + scope groups).
 * Returns undefined if no injection was recorded.
 */
export function getInjectionRecord(sessionId: string): InjectionRecord | undefined {
	return _sessionInjections.get(sessionId);
}

/**
 * Clear the injection record for a session (e.g., after session ends).
 */
export function clearSessionInjection(sessionId: string): void {
	_sessionInjections.delete(sessionId);
}

// ─── Injection Diagnostics ──────────────────────────────────────────────────

export interface InjectionDiagnostic {
	label: string;
	ok: boolean;
	detail?: string;
}

/**
 * Run a diagnostic check on the injection pipeline.
 * Returns a checklist of prerequisites with pass/fail status.
 */
export async function debugInjectionPipeline(): Promise<InjectionDiagnostic[]> {
	const results: InjectionDiagnostic[] = [];
	const config = getConfig();

	// 1. Config enabled
	results.push({
		label: 'Memory system enabled',
		ok: config.enabled,
		detail: config.enabled
			? undefined
			: 'Enable the memory system in settings to start injecting memories',
	});

	if (!config.enabled) return results;

	// 2. Hierarchy seeded
	try {
		const store = getMemoryStore();
		const stats = await store.getAnalytics();

		const hasPersonas = stats.totalPersonas > 0;
		const hasSkills = stats.totalSkillAreas > 0;
		results.push({
			label: 'Hierarchy seeded (personas exist)',
			ok: hasPersonas,
			detail: hasPersonas
				? `${stats.totalPersonas} persona(s)`
				: 'No personas found — seed the hierarchy first',
		});
		results.push({
			label: 'Hierarchy seeded (skill areas exist)',
			ok: hasSkills,
			detail: hasSkills ? `${stats.totalSkillAreas} skill area(s)` : 'No skill areas found',
		});

		// 3. Embeddings computed
		const hasPendingEmbeddings = stats.pendingEmbeddings > 0;
		results.push({
			label: 'Embeddings computed',
			ok: !hasPendingEmbeddings,
			detail: hasPendingEmbeddings
				? `${stats.pendingEmbeddings} item(s) missing embeddings — persona/skill matching requires embeddings`
				: 'All embeddings computed',
		});

		// 4. Memories exist
		const hasMemories = stats.totalMemories > 0;
		results.push({
			label: 'Memories exist',
			ok: hasMemories,
			detail: hasMemories
				? `${stats.totalMemories} memor${stats.totalMemories === 1 ? 'y' : 'ies'}`
				: 'No memories stored yet',
		});

		// 5. Recent injection events
		const events = getRecentInjectionEvents(200);
		const realEvents = events.filter((e) => !e.noMatch);
		results.push({
			label: 'Recent injection events recorded',
			ok: realEvents.length > 0,
			detail:
				realEvents.length > 0
					? `${realEvents.length} event(s) in ring buffer`
					: 'No injection events — try starting a new agent session with the memory system enabled',
		});

		// 6. Recent search queries (no-match events indicate searches happened)
		const noMatchEvents = events.filter((e) => e.noMatch);
		if (realEvents.length === 0 && noMatchEvents.length > 0) {
			results.push({
				label: 'Search attempted but no matches found',
				ok: false,
				detail: `${noMatchEvents.length} search(es) returned no matching memories — check persona descriptions and similarity thresholds`,
			});
		}
	} catch (err) {
		results.push({
			label: 'Memory store accessible',
			ok: false,
			detail: `Failed to access memory store: ${String(err)}`,
		});
	}

	return results;
}

// ─── Persona Shift Event Ring Buffer ─────────────────────────────────────────

export interface PersonaShiftEvent {
	timestamp: number;
	sessionId: string;
	fromPersona: { id: string; name: string; score: number };
	toPersona: { id: string; name: string; score: number };
	triggerContext: string;
}

const recentPersonaShifts: PersonaShiftEvent[] = [];
const MAX_PERSONA_SHIFT_EVENTS = 100;

/**
 * Push a persona shift event to the ring buffer.
 */
export function pushPersonaShiftEvent(event: PersonaShiftEvent): void {
	recentPersonaShifts.push(event);
	if (recentPersonaShifts.length > MAX_PERSONA_SHIFT_EVENTS) {
		recentPersonaShifts.shift();
	}
}

/**
 * Return the last N persona shift events (newest first).
 */
export function getRecentPersonaShifts(limit?: number): PersonaShiftEvent[] {
	const n = limit ?? MAX_PERSONA_SHIFT_EVENTS;
	return recentPersonaShifts.slice(-n).reverse();
}
