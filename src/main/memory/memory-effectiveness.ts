/**
 * Memory Effectiveness Tracker — correlates process outcomes with injected memories.
 *
 * On process completion, looks up which memories were injected for the session,
 * computes an outcome score from the exit code, and updates each memory's
 * effectiveness score using EMA.
 *
 * Also provides confidence decay for stale memories (half-life formula).
 */

import { getInjectionRecord, clearSessionInjection } from './memory-injector';
import { getMemoryStore } from './memory-store';

/**
 * Convert a process exit code to an outcome score.
 * 0 → 1.0 (success), non-zero → 0.0 (failure).
 * This is a simple binary signal that can be enriched later
 * (e.g., by analyzing session output quality).
 */
function exitCodeToOutcomeScore(exitCode: number): number {
	return exitCode === 0 ? 1.0 : 0.0;
}

/**
 * Handle process completion: look up injection record, compute outcome,
 * and update effectiveness scores for each injected memory.
 *
 * Called from the exit listener after a regular (non-group-chat) process exits.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function onProcessComplete(sessionId: string, exitCode: number): Promise<void> {
	const record = getInjectionRecord(sessionId);
	if (!record || record.ids.length === 0) return;

	const outcomeScore = exitCodeToOutcomeScore(exitCode);
	const store = getMemoryStore();

	// Update effectiveness for each scope group
	for (const group of record.scopeGroups) {
		await store.updateEffectiveness(
			group.ids,
			outcomeScore,
			group.scope,
			group.skillAreaId,
			group.projectPath
		);
	}

	// Clean up the injection record
	clearSessionInjection(sessionId);
}

/**
 * Run confidence decay across all active scopes.
 * Intended to be called periodically (e.g., daily or on app start).
 *
 * @param halfLifeDays - Half-life for confidence decay (from MemoryConfig)
 * @returns Total number of entries deactivated across all scopes
 */
export async function runGlobalConfidenceDecay(halfLifeDays: number): Promise<number> {
	const store = getMemoryStore();
	let totalDeactivated = 0;

	// Decay global memories
	totalDeactivated += await store.applyConfidenceDecay('global', halfLifeDays);

	// Decay all skill area memories
	const registry = await store.readRegistry();
	for (const skill of registry.skillAreas) {
		if (!skill.active) continue;
		totalDeactivated += await store.applyConfidenceDecay('skill', halfLifeDays, skill.id);
	}

	// Note: project-scoped decay requires knowing project paths,
	// which are hashed in storage. This can be added later if needed.

	return totalDeactivated;
}
