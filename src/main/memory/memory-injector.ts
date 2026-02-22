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
		return { key: '[project]', priority: 1 };
	}
	return { key: '[global]', priority: 2 };
}

/**
 * Format selected memories into the XML injection block.
 */
function formatXmlBlock(selected: MemorySearchResult[]): string {
	// Group by key
	const groupMap = new Map<string, GroupedMemories>();

	for (const result of selected) {
		const { key, priority } = getGroupKey(result);
		let group = groupMap.get(key);
		if (!group) {
			group = { key, priority, lines: [], tokenCost: 0 };
			groupMap.set(key, group);
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
 * Retrieve relevant memories via cascading search and format them
 * as an XML block prepended to the user's prompt.
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

	// Cascading search
	const results = await store.cascadingSearch(query(prompt), config, agentType, projectPath);

	// Greedy token selection — iterate by combinedScore (already sorted), accumulate
	const tokenBudget = config.maxTokenBudget - WRAPPER_OVERHEAD_TOKENS;
	const selected: MemorySearchResult[] = [];
	let totalTokens = 0;

	for (const result of results) {
		const cost = result.entry.tokenEstimate;
		if (totalTokens + cost > tokenBudget) continue;
		selected.push(result);
		totalTokens += cost;
	}

	// Nothing selected → return unchanged
	if (selected.length === 0) {
		return {
			injectedPrompt: prompt,
			injectedIds: [],
			tokenCount: 0,
			personaContributions: [],
			flatScopeCounts: { project: 0, global: 0 },
			scopeGroups: [],
		};
	}

	// Format XML
	const xmlBlock = formatXmlBlock(selected);

	// Track persona contributions
	const personaMap = new Map<string, { personaName: string; count: number }>();
	let projectCount = 0;
	let globalCount = 0;

	for (const result of selected) {
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

	// Record injection — group by scope for batch recording
	const injectedIds = selected.map((r) => r.entry.id);
	const byScope = groupInjectedByScope(selected);

	// Build scope groups with projectPath for effectiveness tracking
	const scopeGroups = byScope.map(({ scope, skillAreaId, ids }) => ({
		scope,
		skillAreaId,
		projectPath: scope === 'project' ? projectPath : undefined,
		ids,
	}));

	for (const { scope, skillAreaId, ids } of byScope) {
		await store.recordInjection(
			ids,
			scope,
			skillAreaId,
			scope === 'project' ? projectPath : undefined
		);
	}

	// Prepend XML to prompt
	const injectedPrompt = `${xmlBlock}\n\n${prompt}`;
	const tokenCount = totalTokens + WRAPPER_OVERHEAD_TOKENS;

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
