/**
 * EffectivenessEvaluator — evaluates session outcomes against injected memories
 * to produce per-memory effectiveness scores (MEM-EVOLVE-04).
 *
 * Takes a session's injection record and outcome signals, then computes
 * an EffectivenessUpdate[] that can be fed to store.updateEffectiveness().
 *
 * When per-injection events are available (injectionEvents[]), memories
 * injected early in a successful session get higher scores than memories
 * injected late (recency bias adjustment). Without events, falls back to
 * uniform scoring for backward compatibility.
 */

import type { MemoryId, MemoryScope, SkillAreaId, InjectionEvent } from '../../shared/memory-types';
import type { SessionOutcomeSignals, EffectivenessUpdate } from '../../shared/memory-types';
import type { InjectionRecord } from './memory-injector';

/**
 * Evaluate session outcomes against injected memories to produce
 * per-memory effectiveness updates.
 */
export class EffectivenessEvaluator {
	/**
	 * Evaluate a session's outcome and produce effectiveness updates for each
	 * injected memory, grouped by scope.
	 *
	 * When injectionEvents are present, applies per-injection scoring:
	 * - Memories injected at spawn (turn 0) get the full outcome score
	 * - Memories injected later get a recency-discounted score
	 * - The discount is proportional to how late in the session the injection occurred
	 *
	 * Without injectionEvents, all memories get the uniform session score.
	 */
	evaluateSession(
		sessionId: string,
		injectionRecord: InjectionRecord,
		sessionSignals: SessionOutcomeSignals
	): EffectivenessUpdate[] {
		if (injectionRecord.ids.length === 0) return [];

		const baseScore = this.computeOutcomeScore(sessionSignals);
		const memoryScopes = this.buildMemoryScopeMap(injectionRecord);

		// If we have per-injection events, use granular scoring
		if (injectionRecord.injectionEvents && injectionRecord.injectionEvents.length > 0) {
			return this.evaluateWithEvents(
				injectionRecord.injectionEvents,
				baseScore,
				sessionSignals.turnCount,
				memoryScopes
			);
		}

		// Fallback: uniform scoring for all memories
		const updates: EffectivenessUpdate[] = [];
		for (const memoryId of injectionRecord.ids) {
			const scopeInfo = memoryScopes.get(memoryId);
			updates.push({
				memoryId,
				outcomeScore: baseScore,
				scope: scopeInfo?.scope ?? 'global',
				skillAreaId: scopeInfo?.skillAreaId,
			});
		}
		return updates;
	}

	/**
	 * Per-injection granular scoring. Each injection event gets a score based on:
	 * - The base session outcome score
	 * - A recency multiplier: spawn-time injections get full credit, later ones less
	 *
	 * Recency multiplier: 1.0 at turn 0, linearly decreasing to 0.5 at the last turn.
	 * This means late injections can still score well (50% of base) but early ones
	 * that "set the stage" for success are rewarded more.
	 *
	 * Deduplication: if a memory appears in multiple injection events, the highest
	 * score wins (it was injected at the most favorable time).
	 */
	private evaluateWithEvents(
		events: InjectionEvent[],
		baseScore: number,
		totalTurns: number,
		memoryScopes: Map<MemoryId, { scope: MemoryScope; skillAreaId?: SkillAreaId }>
	): EffectivenessUpdate[] {
		// Map memoryId → best (highest) score across all injection events
		const bestScores = new Map<MemoryId, number>();

		for (const event of events) {
			const multiplier = this.computeRecencyMultiplier(event.turnIndex, totalTurns);
			const eventScore = Math.max(0, Math.min(1, baseScore * multiplier));

			for (const memoryId of event.memoryIds) {
				const existing = bestScores.get(memoryId) ?? -1;
				if (eventScore > existing) {
					bestScores.set(memoryId, eventScore);
				}
			}
		}

		const updates: EffectivenessUpdate[] = [];
		for (const [memoryId, outcomeScore] of bestScores) {
			const scopeInfo = memoryScopes.get(memoryId);
			updates.push({
				memoryId,
				outcomeScore,
				scope: scopeInfo?.scope ?? 'global',
				skillAreaId: scopeInfo?.skillAreaId,
			});
		}

		return updates;
	}

	/**
	 * Compute the recency multiplier for an injection at a given turn.
	 * Linear decay from 1.0 (turn 0) to 0.5 (last turn).
	 * If totalTurns is 0 or 1, returns 1.0 (no decay).
	 */
	computeRecencyMultiplier(injectionTurn: number, totalTurns: number): number {
		if (totalTurns <= 1) return 1.0;
		const progress = Math.min(injectionTurn / totalTurns, 1.0);
		// Linear: 1.0 → 0.5
		return 1.0 - progress * 0.5;
	}

	/**
	 * Compute a session outcome score (0.0-1.0) from structured signals.
	 * Pure function — no side effects or external dependencies.
	 */
	computeOutcomeScore(signals: SessionOutcomeSignals): number {
		let score = 0;

		// ── Positive signals ──

		// Session completed without errors
		if (signals.completed && signals.errorCount === 0) {
			score += 0.3;
		}

		// Agent completed task (user didn't cancel)
		if (signals.completed && !signals.cancelled) {
			score += 0.2;
		}

		// Low context utilization at end (<70%) — efficient session
		if (signals.contextUtilization < 0.7) {
			score += 0.1;
		}

		// Git diff produced (actual code changes)
		if (signals.gitDiffProduced) {
			score += 0.2;
		}

		// ── Negative signals ──

		// Repeated errors that weren't resolved
		if (signals.errorCount > signals.resolvedErrorCount) {
			score -= 0.3;
		}

		// Session abandoned/cancelled
		if (signals.cancelled) {
			score -= 0.1;
		}

		// Very high context usage (>90%) — injected memories may have consumed too much budget
		if (signals.contextUtilization > 0.9) {
			score -= 0.1;
		}

		return Math.max(0, Math.min(1, score));
	}

	/**
	 * Build a map from memoryId → { scope, skillAreaId } using the injection
	 * record's scope groups. This lets us assign the correct scope to each
	 * individual memory in the update.
	 */
	private buildMemoryScopeMap(
		record: InjectionRecord
	): Map<MemoryId, { scope: MemoryScope; skillAreaId?: SkillAreaId }> {
		const map = new Map<MemoryId, { scope: MemoryScope; skillAreaId?: SkillAreaId }>();
		for (const group of record.scopeGroups) {
			for (const id of group.ids) {
				map.set(id, { scope: group.scope, skillAreaId: group.skillAreaId });
			}
		}
		return map;
	}
}
