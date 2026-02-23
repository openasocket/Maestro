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

	for (const result of selected) {
		const { key, priority } = getGroupKey(result);
		let group = groupMap.get(key);
		if (!group) {
			group = { key, priority, lines: [], tokenCost: 0 };
			groupMap.set(key, group);
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

	// Build XML
	const sections = groups.map((g) => `${g.key}\n${g.lines.join('\n')}`);

	return `<agent-memories>\nRelevant knowledge for this task:\n\n${sections.join('\n\n')}\n</agent-memories>`;
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
	agentType: string
): Promise<MemoryInjectionResult> {
	const config = getConfig();

	// If disabled, return unchanged prompt
	if (!config.enabled) {
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

	// Optionally adjust config for rich mode (lower similarity threshold)
	const searchConfig: MemoryConfig =
		config.injectionStrategy === 'rich'
			? {
					...config,
					similarityThreshold: Math.max(config.similarityThreshold - 0.1, 0.1),
				}
			: config;

	// ── Per-scope searches ───────────────────────────────────────────────

	// Skill search: cascading persona → skill → memory
	const skillResults = await store.cascadingSearch(
		query(prompt),
		searchConfig,
		agentType,
		projectPath
	);
	// Filter to skill-scope only (cascading search returns all scopes)
	const skillOnly = skillResults.filter((r) => r.personaName || r.entry.scope === 'skill');
	const selectedSkill = selectWithinBudget(skillOnly, budgets.skill);

	// Project search: flat search within project scope
	let projectSearchResults: MemorySearchResult[] = [];
	if (projectPath) {
		if (searchConfig.enableHybridSearch) {
			projectSearchResults = await store.hybridSearch(
				query(prompt),
				'project',
				searchConfig,
				undefined,
				projectPath
			);
		} else {
			const { encode } = await import('../grpo/embedding-service');
			const qEmbed = await encode(query(prompt));
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
		globalSearchResults = await store.hybridSearch(query(prompt), 'global', searchConfig);
	} else {
		const { encode } = await import('../grpo/embedding-service');
		const qEmbed = await encode(query(prompt));
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

	// Nothing selected → return unchanged
	if (finalSelected.length === 0) {
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
	const personaMap = new Map<string, { personaName: string; count: number }>();
	let projectCount = 0;
	let globalCount = 0;

	for (const result of finalSelected) {
		if (result.personaName) {
			const existing = personaMap.get(result.personaName);
			if (existing) {
				existing.count++;
			} else {
				personaMap.set(result.personaName, { personaName: result.personaName, count: 1 });
			}
		} else if (result.entry.scope === 'project') {
			projectCount++;
		} else if (result.entry.scope === 'global') {
			globalCount++;
		}
	}

	const personaContributions = Array.from(personaMap.entries()).map(([, v]) => ({
		personaId: '', // Persona ID not tracked on search results — use name
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
			.catch(() => {});
	}

	// Prepend XML to prompt
	const injectedPrompt = `${xmlBlock}\n\n${prompt}`;
	const tokenCount = totalTokens + WRAPPER_OVERHEAD_TOKENS;

	// Record injection event for analytics ring buffer
	pushInjectionEvent({
		sessionId: '', // Populated later via recordSessionInjection
		memoryIds: injectedIds,
		tokenCount,
		timestamp: Date.now(),
		scopeGroups,
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
	agentType: string
): Promise<MemoryInjectionResult> {
	try {
		return await injectMemories(prompt, projectPath, agentType);
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

export interface InjectionEvent {
	sessionId: string;
	memoryIds: MemoryId[];
	tokenCount: number;
	timestamp: number;
	scopeGroups: InjectionScopeGroup[];
}

const recentInjections: InjectionEvent[] = [];
const MAX_INJECTION_HISTORY = 50;

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
