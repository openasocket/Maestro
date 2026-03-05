/**
 * EffectivenessEvaluator — evaluates session outcomes against injected memories
 * to produce per-memory effectiveness scores (MEM-EVOLVE-04).
 *
 * Takes a session's injection record and outcome signals, then computes
 * an EffectivenessUpdate[] that can be fed to store.updateEffectiveness().
 *
 * This class encapsulates the scoring logic separately from the wiring
 * (which lives in memory-monitor-listener.ts and memory-effectiveness.ts).
 */

import type { MemoryId, MemoryScope, SkillAreaId } from '../../shared/memory-types';
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
	 * The outcome score is computed from SessionOutcomeSignals using additive
	 * positive/negative signals, clamped to [0.0, 1.0]:
	 *
	 * Positive:
	 *   +0.3 session completed without errors
	 *   +0.2 agent completed task (not cancelled)
	 *   +0.1 low context utilization at end (<70%)
	 *   +0.2 git diff produced (actual code changes)
	 *
	 * Negative:
	 *   -0.3 repeated errors (errorCount > resolvedErrorCount)
	 *   -0.1 session abandoned/cancelled
	 *   -0.1 very high context usage (>90%)
	 */
	evaluateSession(
		sessionId: string,
		injectionRecord: InjectionRecord,
		sessionSignals: SessionOutcomeSignals
	): EffectivenessUpdate[] {
		if (injectionRecord.ids.length === 0) return [];

		const outcomeScore = this.computeOutcomeScore(sessionSignals);
		const updates: EffectivenessUpdate[] = [];

		// Produce one update per memory, using the scope from its group
		const memoryScopes = this.buildMemoryScopeMap(injectionRecord);

		for (const memoryId of injectionRecord.ids) {
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
