/**
 * PromptInjector — reads project experience library and formats it as
 * a system prompt prefix for agent injection.
 *
 * Called on every agent spawn when GRPO is enabled.
 * Respects the token budget from GRPOConfig.maxInjectionTokens.
 */

import { logger } from '../utils/logger';
import { getExperienceStore } from './experience-store';
import type { ExperienceStore } from './experience-store';
import type {
	ExperienceEntry,
	ExperienceId,
	GRPOConfig,
} from '../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../shared/grpo-types';
import { encode, cosineSimilarity } from './embedding-service';

const LOG_CONTEXT = '[PromptInjector]';

// Module-level settings store getter — set once at init, used by tryInjectExperiences
let settingsStoreGetter: (() => { get: (key: string) => unknown }) | null = null;

/**
 * Wire up the settings store for GRPO config reads.
 * Called once during app initialization (from index.ts or handler registration).
 */
export function setGRPOSettingsStore(getter: () => { get: (key: string) => unknown }): void {
	settingsStoreGetter = getter;
}

/** Approximate token overhead for the <project-experiences> wrapper and preamble */
const WRAPPER_OVERHEAD_TOKENS = 200;

/** Semantic retrieval constants */
const DEFAULT_SIMILARITY_FLOOR = 0.15; // minimum cosine similarity to consider an entry relevant
const SEMANTIC_WEIGHT = 0.5;           // weight for semantic score in final ranking
const PRIORITY_WEIGHT = 0.5;           // weight for evidence/use/recency priority score
const MAX_PROMPT_CHARS_FOR_ENCODING = 2000; // truncate long prompts before embedding

/** Normalization caps for priority scoring */
const MAX_EVIDENCE = 20;
const MAX_USE_COUNT = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Computes a normalized [0, 1] priority score for entry selection.
 *
 * Components:
 * - Evidence weight (40%): higher evidenceCount = more validated
 * - Use frequency (30%): higher useCount = more generally applicable
 * - Recency (30%): recently updated entries are prioritized
 *
 * All components are normalized to [0, 1] before combining.
 */
export function computePriorityScore(
	entry: ExperienceEntry,
	now: number,
	maxAgeMs: number = MAX_AGE_MS
): number {
	const evidenceNorm = Math.min(entry.evidenceCount / MAX_EVIDENCE, 1.0);
	const useNorm = Math.min(entry.useCount / MAX_USE_COUNT, 1.0);
	const ageMs = now - entry.updatedAt;
	const recencyNorm = Math.max(0, 1 - Math.min(ageMs / maxAgeMs, 1.0));

	return evidenceNorm * 0.4 + useNorm * 0.3 + recencyNorm * 0.3;
}

/**
 * Formats selected experience entries as a system prompt prefix.
 *
 * Format rules:
 * - Wrapped in <project-experiences> tags for clear delineation
 * - Brief preamble explaining these are learned insights
 * - Each entry on its own line prefixed with [category]
 * - Sorted by category for readability
 * - Ends with blank line before the actual user prompt
 */
export function formatExperiencePrefix(entries: ExperienceEntry[]): string {
	if (entries.length === 0) return '';

	// Sort by category for readability
	const sorted = [...entries].sort((a, b) => a.category.localeCompare(b.category));

	const lines = sorted.map(e => `[${e.category}] ${e.content}`);

	return `<project-experiences>
The following insights have been learned from previous work on this project.
Apply these when relevant to the current task:

${lines.join('\n\n')}
</project-experiences>

`;
}

/**
 * Reads the active experience library for a project and injects it as a prefix
 * into the agent's prompt. This is the "policy conditioned on experiential
 * knowledge π(a|q, E)" from the paper.
 *
 * Three-level selection pipeline:
 *   Level 1: Agent-type hard filter (unchanged from GRPO-06)
 *   Level 2: Semantic relevance scoring (GRPO-13) — optional, configurable
 *   Level 3: Combined ranking (semantic * 0.5 + priority * 0.5)
 *
 * @param prompt - The original prompt to inject experiences into
 * @param projectPath - The project path for looking up the experience library
 * @param agentType - The agent type for filtering relevant experiences
 * @param experienceStore - The experience store to read from
 * @param config - GRPO configuration
 * @returns The modified prompt with metadata about what was injected
 */
export async function injectExperiences(
	prompt: string,
	projectPath: string,
	agentType: string,
	experienceStore: ExperienceStore,
	config: GRPOConfig,
): Promise<{ injectedPrompt: string; injectedIds: ExperienceId[]; tokenCount: number }> {
	// If GRPO is not enabled, return unchanged
	if (!config.enabled) {
		return { injectedPrompt: prompt, injectedIds: [], tokenCount: 0 };
	}

	// Load the library
	const library = await experienceStore.getLibrary(projectPath);
	if (library.length === 0) {
		return { injectedPrompt: prompt, injectedIds: [], tokenCount: 0 };
	}

	// Level 1: Agent-type hard filter
	const agentFiltered = library.filter(
		e => e.agentType === agentType || e.agentType === 'all'
	);
	if (agentFiltered.length === 0) {
		return { injectedPrompt: prompt, injectedIds: [], tokenCount: 0 };
	}

	const now = Date.now();
	const useSemanticRetrieval = config.semanticRetrievalEnabled !== false;
	const similarityFloor = config.semanticSimilarityFloor ?? DEFAULT_SIMILARITY_FLOOR;

	let scored: { entry: ExperienceEntry; combined: number }[];

	if (useSemanticRetrieval) {
		// Level 2: Semantic relevance scoring
		const queryText = prompt.length > MAX_PROMPT_CHARS_FOR_ENCODING
			? prompt.slice(0, MAX_PROMPT_CHARS_FOR_ENCODING)
			: prompt;

		let queryVec: Float32Array;
		try {
			queryVec = await encode(queryText, config.embeddingModel ?? 'multilingual');
		} catch (err) {
			// Fallback to priority-only if embedding fails
			logger.warn(`Semantic encoding failed, falling back to priority-only: ${err}`, LOG_CONTEXT);
			scored = agentFiltered.map(e => ({
				entry: e,
				combined: computePriorityScore(e, now),
			}));
			scored.sort((a, b) => b.combined - a.combined);
			return selectAndInject(scored, config, prompt, projectPath, experienceStore);
		}

		scored = agentFiltered
			.filter(e => e.embedding) // skip entries without embeddings
			.map(e => {
				const entryVec = new Float32Array(e.embedding!);
				const semantic = cosineSimilarity(queryVec, entryVec);
				const priority = computePriorityScore(e, now);
				return {
					entry: e,
					semantic,
					priority,
					combined: semantic * SEMANTIC_WEIGHT + priority * PRIORITY_WEIGHT,
				};
			})
			.filter(s => s.semantic >= similarityFloor)
			.sort((a, b) => b.combined - a.combined);

		// If semantic filtering removed everything, include entries without embeddings
		// using priority-only (graceful degradation for pre-migration entries)
		if (scored.length === 0) {
			const noEmbedding = agentFiltered.filter(e => !e.embedding);
			if (noEmbedding.length > 0) {
				scored = noEmbedding.map(e => ({
					entry: e,
					combined: computePriorityScore(e, now),
				}));
				scored.sort((a, b) => b.combined - a.combined);
			}
		}
	} else {
		// Semantic retrieval disabled — fall back to priority-only (GRPO-06 behavior)
		scored = agentFiltered.map(e => ({
			entry: e,
			combined: computePriorityScore(e, now),
		}));
		scored.sort((a, b) => b.combined - a.combined);
	}

	return selectAndInject(scored, config, prompt, projectPath, experienceStore);
}

/**
 * Shared token-budget selection and injection logic.
 * Takes a pre-sorted scored array and fills the token budget top-down.
 */
function selectAndInject(
	scored: { entry: ExperienceEntry; combined: number }[],
	config: GRPOConfig,
	prompt: string,
	projectPath: string,
	experienceStore: ExperienceStore,
): { injectedPrompt: string; injectedIds: ExperienceId[]; tokenCount: number } {
	if (scored.length === 0) {
		return { injectedPrompt: prompt, injectedIds: [], tokenCount: 0 };
	}

	// Fill token budget
	const tokenBudget = config.maxInjectionTokens - WRAPPER_OVERHEAD_TOKENS;
	const selected: ExperienceEntry[] = [];
	let totalTokens = 0;

	for (const s of scored) {
		if (totalTokens + s.entry.tokenEstimate > tokenBudget) continue;
		selected.push(s.entry);
		totalTokens += s.entry.tokenEstimate;
	}

	if (selected.length === 0) {
		return { injectedPrompt: prompt, injectedIds: [], tokenCount: 0 };
	}

	// Format as prefix
	const prefix = formatExperiencePrefix(selected);
	const injectedIds = selected.map(e => e.id);

	// Increment use counts for selected entries (fire-and-forget)
	experienceStore.incrementUseCount(projectPath, injectedIds).catch(err => {
		logger.warn(`Failed to increment use counts: ${err}`, LOG_CONTEXT);
	});

	logger.debug(
		`Injected ${injectedIds.length} experiences (${totalTokens + WRAPPER_OVERHEAD_TOKENS} tokens)`,
		LOG_CONTEXT
	);

	return {
		injectedPrompt: prefix + prompt,
		injectedIds,
		tokenCount: totalTokens + WRAPPER_OVERHEAD_TOKENS,
	};
}

/**
 * Convenience wrapper that reads GRPO config from a settings store and
 * uses the singleton ExperienceStore. Suitable for call sites that don't
 * already have the ExperienceStore or GRPOConfig in scope.
 *
 * Returns the original prompt unchanged if GRPO is disabled or on error.
 */
export async function tryInjectExperiences(
	prompt: string,
	projectPath: string,
	agentType: string,
	settingsStore?: { get: (key: string) => unknown },
): Promise<string> {
	try {
		const store = settingsStore ?? settingsStoreGetter?.();
		const stored = store?.get('grpoConfig') as Partial<GRPOConfig> | undefined;
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, ...stored };
		if (!config.enabled) return prompt;

		const experienceStore = getExperienceStore();
		const { injectedPrompt } = await injectExperiences(
			prompt,
			projectPath,
			agentType,
			experienceStore,
			config,
		);
		return injectedPrompt;
	} catch (err) {
		logger.warn(`Experience injection failed, proceeding without: ${err}`, LOG_CONTEXT);
		return prompt;
	}
}
