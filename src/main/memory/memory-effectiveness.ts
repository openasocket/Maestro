/**
 * Memory Effectiveness Tracker — correlates process outcomes with injected memories.
 *
 * On process completion, looks up which memories were injected for the session,
 * computes a multi-signal outcome score, and updates each memory's
 * effectiveness score using EMA.
 *
 * Scoring signals (EXP-ENHANCE-05):
 * - Base: exit code (0 → 0.6, non-zero → 0.0)
 * - Anti-pattern penalty: -0.1 per detected anti-pattern in git diff
 * - Commit presence bonus: +0.2 if session produced commits
 * - Duration reasonableness: +0.2 if session > 5s (not a crash/no-op)
 * - Context health modifier: discount if context utilization was high
 *
 * Also provides confidence decay for stale memories (half-life formula).
 */

import { getInjectionRecord, clearSessionInjection } from './memory-injector';
import { getMemoryStore } from './memory-store';

/** Anti-patterns detected in git diffs that indicate lower quality output */
const ANTI_PATTERN_REGEXES = [
	/^\+.*\b(?:TODO|FIXME)\b/im, // TODO/FIXME comments added
	/^\+.*\{\s*\}/m, // Empty function/block bodies
	/^\+.*console\.log/im, // console.log left in
	/^\+.*\/\/\s*eslint-disable/im, // eslint-disable added
];

/**
 * Compute a nuanced outcome score (0.0–1.0) from multiple session signals.
 *
 * Score components:
 * - Base score: exit code (0 → 0.6 base, non-zero → 0.0 base)
 * - Anti-pattern penalty: -0.1 per detected anti-pattern (min 0.0)
 * - Commit presence bonus: +0.2 if session produced at least one commit
 * - Duration reasonableness: +0.2 if session wasn't abnormally short (<5s = likely crash)
 * - Context health modifier: discount if context utilization was high (degraded reasoning)
 *
 * Total is clamped to [0.0, 1.0].
 * All sub-checks are wrapped in try-catch — never throws.
 */
export async function computeOutcomeScore(
	sessionId: string,
	exitCode: number,
	projectPath?: string
): Promise<number> {
	// Base score from exit code
	let score = exitCode === 0 ? 0.6 : 0.0;

	// Anti-pattern scan (only if projectPath available and exit code was 0)
	if (projectPath && exitCode === 0) {
		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);

			const diffResult = await execFileAsync('git', ['diff', 'HEAD~1..HEAD'], {
				cwd: projectPath,
				timeout: 5000,
			});
			const diff = diffResult.stdout ?? '';

			if (diff) {
				let antiPatternCount = 0;
				for (const regex of ANTI_PATTERN_REGEXES) {
					if (regex.test(diff)) {
						antiPatternCount++;
					}
				}
				score = Math.max(0, score - antiPatternCount * 0.1);
			}
		} catch {
			// Git unavailable or no previous commit — skip anti-pattern check
		}
	}

	// Commit presence bonus
	if (projectPath && exitCode === 0) {
		try {
			const { execFile } = await import('child_process');
			const { promisify } = await import('util');
			const execFileAsync = promisify(execFile);

			const logResult = await execFileAsync('git', ['log', '--oneline', '--since=5 minutes ago'], {
				cwd: projectPath,
				timeout: 5000,
			});
			const logOutput = (logResult.stdout ?? '').trim();
			if (logOutput.length > 0) {
				score += 0.2;
			}
		} catch {
			// Git unavailable — skip commit bonus
		}
	}

	// Duration reasonableness check
	try {
		const { getStatsDB } = await import('../stats');
		const statsDb = getStatsDB();
		const queryEvents = statsDb.getQueryEvents('all', { sessionId });
		if (queryEvents.length > 0) {
			const totalDuration = queryEvents.reduce((sum, q) => sum + q.duration, 0);
			if (totalDuration > 5000) {
				score += 0.2;
			}
			// ≤5000ms and exit 0: no bonus (suspiciously fast, possible no-op)
		}
	} catch {
		// Stats DB unavailable — skip duration check
	}

	// Context health modifier: sessions ending at high context utilization had degraded reasoning
	try {
		const { getHistoryManager } = await import('../history-manager');
		const historyManager = getHistoryManager();
		const entries = historyManager.getEntries(sessionId);
		if (entries.length > 0) {
			const lastEntry = entries[entries.length - 1];
			const contextUtilization = lastEntry.contextUsage;
			if (contextUtilization !== undefined) {
				if (contextUtilization > 0.8) {
					score *= 0.8; // Degraded session — discount outcome
				} else if (contextUtilization > 0.6) {
					score *= 0.9; // Caution zone — mild discount
				}
			}
		}
	} catch {
		// History unavailable — skip context modifier
	}

	// Clamp to [0.0, 1.0]
	return Math.max(0, Math.min(1, score));
}

/**
 * Handle process completion: look up injection record, compute outcome,
 * and update effectiveness scores for each injected memory.
 *
 * Called from the exit listener after a regular (non-group-chat) process exits.
 * Fire-and-forget — errors are logged but don't propagate.
 */
export async function onProcessComplete(
	sessionId: string,
	exitCode: number,
	projectPath?: string
): Promise<void> {
	const record = getInjectionRecord(sessionId);
	if (!record || record.ids.length === 0) return;

	const outcomeScore = await computeOutcomeScore(sessionId, exitCode, projectPath);
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
