/**
 * Tests for EffectivenessEvaluator (MEM-EVOLVE-04).
 *
 * Pure unit tests — no mocking needed since the evaluator has no
 * external dependencies (scoring is entirely signal-based).
 */

import { describe, it, expect } from 'vitest';
import { EffectivenessEvaluator } from '../effectiveness-evaluator';
import type { SessionOutcomeSignals } from '../../../shared/memory-types';
import type { InjectionRecord } from '../memory-injector';

function makeSignals(overrides: Partial<SessionOutcomeSignals> = {}): SessionOutcomeSignals {
	return {
		completed: true,
		cancelled: false,
		errorCount: 0,
		resolvedErrorCount: 0,
		gitDiffProduced: false,
		contextUtilization: 0.5,
		turnCount: 5,
		durationMs: 60000,
		...overrides,
	};
}

function makeRecord(overrides: Partial<InjectionRecord> = {}): InjectionRecord {
	return {
		ids: ['mem-1', 'mem-2'],
		scopeGroups: [
			{ scope: 'global', ids: ['mem-1'] },
			{ scope: 'project', skillAreaId: undefined, projectPath: '/proj', ids: ['mem-2'] },
		],
		contentHashes: new Map(),
		lastInjectedAt: Date.now(),
		totalTokensSaved: 0,
		injectionEvents: [],
		...overrides,
	};
}

describe('EffectivenessEvaluator', () => {
	const evaluator = new EffectivenessEvaluator();

	// ─── computeOutcomeScore ──────────────────────────────────────────────

	describe('computeOutcomeScore', () => {
		it('returns max positive score for ideal session', () => {
			const score = evaluator.computeOutcomeScore(
				makeSignals({
					completed: true,
					errorCount: 0,
					gitDiffProduced: true,
					contextUtilization: 0.5,
				})
			);
			// +0.3 +0.2 +0.1 +0.2 = 0.8
			expect(score).toBe(0.8);
		});

		it('returns 0.0 for worst-case session', () => {
			const score = evaluator.computeOutcomeScore(
				makeSignals({
					completed: false,
					cancelled: true,
					errorCount: 5,
					resolvedErrorCount: 0,
					contextUtilization: 0.95,
				})
			);
			expect(score).toBe(0.0);
		});

		it('gives +0.3 for completed session without errors', () => {
			const withErrors = evaluator.computeOutcomeScore(makeSignals({ errorCount: 1 }));
			const clean = evaluator.computeOutcomeScore(makeSignals({ errorCount: 0 }));
			// clean gets +0.3 (no errors), withErrors gets -0.3 (unresolved)
			expect(clean - withErrors).toBeCloseTo(0.6);
		});

		it('gives +0.2 for completed task (not cancelled)', () => {
			const completed = evaluator.computeOutcomeScore(makeSignals({ completed: true }));
			const incomplete = evaluator.computeOutcomeScore(makeSignals({ completed: false }));
			expect(completed).toBeGreaterThan(incomplete);
		});

		it('gives +0.1 for low context utilization', () => {
			const low = evaluator.computeOutcomeScore(makeSignals({ contextUtilization: 0.5 }));
			const high = evaluator.computeOutcomeScore(makeSignals({ contextUtilization: 0.8 }));
			expect(low - high).toBeCloseTo(0.1);
		});

		it('gives +0.2 for git diff produced', () => {
			const withDiff = evaluator.computeOutcomeScore(makeSignals({ gitDiffProduced: true }));
			const noDiff = evaluator.computeOutcomeScore(makeSignals({ gitDiffProduced: false }));
			expect(withDiff - noDiff).toBeCloseTo(0.2);
		});

		it('gives -0.3 for unresolved errors', () => {
			const score = evaluator.computeOutcomeScore(
				makeSignals({ errorCount: 3, resolvedErrorCount: 1 })
			);
			// No +0.3 (has errors), +0.2 (completed), +0.1 (low ctx) = 0.3, then -0.3 = 0.0
			expect(score).toBeCloseTo(0.0);
		});

		it('does not penalize when all errors resolved', () => {
			const score = evaluator.computeOutcomeScore(
				makeSignals({ errorCount: 3, resolvedErrorCount: 3 })
			);
			// No +0.3 (has errors), +0.2 (completed), +0.1 (low ctx) = 0.3
			expect(score).toBeCloseTo(0.3);
		});

		it('gives -0.1 for cancelled session', () => {
			const normal = evaluator.computeOutcomeScore(makeSignals());
			const cancelled = evaluator.computeOutcomeScore(makeSignals({ cancelled: true }));
			// cancelled loses +0.2 (completed but cancelled doesn't negate completed flag)
			// Actually: completed=true, cancelled=true → +0.3 +0.1 -0.1 = 0.3
			// completed=true, cancelled=false → +0.3 +0.2 +0.1 = 0.6
			expect(normal - cancelled).toBeCloseTo(0.3);
		});

		it('gives -0.1 for very high context usage (>90%)', () => {
			const normal = evaluator.computeOutcomeScore(makeSignals({ contextUtilization: 0.8 }));
			const high = evaluator.computeOutcomeScore(makeSignals({ contextUtilization: 0.95 }));
			expect(normal - high).toBeCloseTo(0.1);
		});

		it('clamps to [0.0, 1.0]', () => {
			// All negative
			const low = evaluator.computeOutcomeScore(
				makeSignals({
					completed: false,
					cancelled: true,
					errorCount: 10,
					contextUtilization: 0.99,
				})
			);
			expect(low).toBe(0.0);

			// Maximum positive
			const high = evaluator.computeOutcomeScore(
				makeSignals({
					completed: true,
					errorCount: 0,
					gitDiffProduced: true,
					contextUtilization: 0.3,
				})
			);
			expect(high).toBeLessThanOrEqual(1.0);
			expect(high).toBeGreaterThanOrEqual(0.0);
		});
	});

	// ─── evaluateSession ──────────────────────────────────────────────────

	describe('evaluateSession', () => {
		it('returns empty array for empty injection record', () => {
			const record = makeRecord({ ids: [], scopeGroups: [] });
			const updates = evaluator.evaluateSession('sess-1', record, makeSignals());
			expect(updates).toEqual([]);
		});

		it('returns one update per injected memory', () => {
			const record = makeRecord();
			const updates = evaluator.evaluateSession('sess-1', record, makeSignals());
			expect(updates).toHaveLength(2);
			expect(updates.map((u) => u.memoryId)).toEqual(['mem-1', 'mem-2']);
		});

		it('assigns correct scope to each memory from scope groups', () => {
			const record = makeRecord();
			const updates = evaluator.evaluateSession('sess-1', record, makeSignals());

			const mem1 = updates.find((u) => u.memoryId === 'mem-1')!;
			const mem2 = updates.find((u) => u.memoryId === 'mem-2')!;

			expect(mem1.scope).toBe('global');
			expect(mem2.scope).toBe('project');
		});

		it('assigns skill scope and skillAreaId correctly', () => {
			const record = makeRecord({
				ids: ['mem-skill'],
				scopeGroups: [{ scope: 'skill', skillAreaId: 'typescript', ids: ['mem-skill'] }],
			});
			const updates = evaluator.evaluateSession('sess-1', record, makeSignals());

			expect(updates).toHaveLength(1);
			expect(updates[0].scope).toBe('skill');
			expect(updates[0].skillAreaId).toBe('typescript');
		});

		it('defaults to global scope for memories not in any scope group', () => {
			const record = makeRecord({
				ids: ['orphan-mem'],
				scopeGroups: [], // No scope groups
			});
			const updates = evaluator.evaluateSession('sess-1', record, makeSignals());

			expect(updates).toHaveLength(1);
			expect(updates[0].scope).toBe('global');
		});

		it('applies same outcome score to all memories when no injection events', () => {
			const record = makeRecord({
				ids: ['a', 'b', 'c'],
				scopeGroups: [{ scope: 'global', ids: ['a', 'b', 'c'] }],
				injectionEvents: [],
			});
			const signals = makeSignals({
				completed: true,
				errorCount: 0,
				gitDiffProduced: true,
				contextUtilization: 0.5,
			});
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			const scores = updates.map((u) => u.outcomeScore);
			expect(new Set(scores).size).toBe(1);
			expect(scores[0]).toBe(0.8); // +0.3 +0.2 +0.1 +0.2
		});

		it('computes correct score for a failed session', () => {
			const record = makeRecord({
				ids: ['mem-1'],
				scopeGroups: [{ scope: 'global', ids: ['mem-1'] }],
			});
			const signals = makeSignals({
				completed: false,
				cancelled: true,
				errorCount: 3,
				resolvedErrorCount: 0,
				contextUtilization: 0.95,
			});
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			expect(updates).toHaveLength(1);
			expect(updates[0].outcomeScore).toBe(0.0);
		});
	});

	// ─── Per-injection tracking (MEM-EVOLVE-04) ──────────────────────────

	describe('per-injection granular scoring', () => {
		it('gives spawn-time memories full score and late memories discounted score', () => {
			const record = makeRecord({
				ids: ['early', 'late'],
				scopeGroups: [{ scope: 'global', ids: ['early', 'late'] }],
				injectionEvents: [
					{ memoryIds: ['early'], injectedAt: 1000, turnIndex: 0, trigger: 'spawn' },
					{ memoryIds: ['late'], injectedAt: 5000, turnIndex: 8, trigger: 'checkpoint' },
				],
			});
			const signals = makeSignals({
				completed: true,
				errorCount: 0,
				gitDiffProduced: true,
				contextUtilization: 0.5,
				turnCount: 10,
			});
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			const earlyUpdate = updates.find((u) => u.memoryId === 'early')!;
			const lateUpdate = updates.find((u) => u.memoryId === 'late')!;

			// Early (turn 0): multiplier=1.0, score=0.8
			expect(earlyUpdate.outcomeScore).toBe(0.8);
			// Late (turn 8/10): multiplier=1.0 - 0.8*0.5 = 0.6, score=0.8*0.6=0.48
			expect(lateUpdate.outcomeScore).toBeCloseTo(0.48, 2);
			expect(earlyUpdate.outcomeScore).toBeGreaterThan(lateUpdate.outcomeScore);
		});

		it('uses highest score when a memory appears in multiple events', () => {
			const record = makeRecord({
				ids: ['reinjected'],
				scopeGroups: [{ scope: 'global', ids: ['reinjected'] }],
				injectionEvents: [
					{ memoryIds: ['reinjected'], injectedAt: 1000, turnIndex: 0, trigger: 'spawn' },
					{ memoryIds: ['reinjected'], injectedAt: 5000, turnIndex: 5, trigger: 'live' },
				],
			});
			const signals = makeSignals({
				completed: true,
				errorCount: 0,
				contextUtilization: 0.5,
				turnCount: 10,
			});
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			expect(updates).toHaveLength(1);
			// Should use the spawn-time score (turn 0 → multiplier 1.0)
			// Base: +0.3 +0.2 +0.1 = 0.6
			expect(updates[0].outcomeScore).toBe(0.6);
		});

		it('handles single-turn sessions (no recency decay)', () => {
			const record = makeRecord({
				ids: ['only'],
				scopeGroups: [{ scope: 'global', ids: ['only'] }],
				injectionEvents: [
					{ memoryIds: ['only'], injectedAt: 1000, turnIndex: 0, trigger: 'spawn' },
				],
			});
			const signals = makeSignals({ turnCount: 1 });
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			// Multiplier should be 1.0 for single-turn
			const baseScore = evaluator.computeOutcomeScore(signals);
			expect(updates[0].outcomeScore).toBe(baseScore);
		});

		it('assigns correct scopes from scope groups in per-injection mode', () => {
			const record = makeRecord({
				ids: ['mem-g', 'mem-s'],
				scopeGroups: [
					{ scope: 'global', ids: ['mem-g'] },
					{ scope: 'skill', skillAreaId: 'rust', ids: ['mem-s'] },
				],
				injectionEvents: [
					{ memoryIds: ['mem-g', 'mem-s'], injectedAt: 1000, turnIndex: 0, trigger: 'spawn' },
				],
			});
			const signals = makeSignals({ turnCount: 5 });
			const updates = evaluator.evaluateSession('sess-1', record, signals);

			const globalMem = updates.find((u) => u.memoryId === 'mem-g')!;
			const skillMem = updates.find((u) => u.memoryId === 'mem-s')!;

			expect(globalMem.scope).toBe('global');
			expect(skillMem.scope).toBe('skill');
			expect(skillMem.skillAreaId).toBe('rust');
		});

		it('mid-session injection at turn 5 of 10 gets 0.75x multiplier', () => {
			const multiplier = evaluator.computeRecencyMultiplier(5, 10);
			expect(multiplier).toBeCloseTo(0.75, 2);
		});

		it('last-turn injection gets 0.5x multiplier', () => {
			const multiplier = evaluator.computeRecencyMultiplier(10, 10);
			expect(multiplier).toBeCloseTo(0.5, 2);
		});

		it('zero-turn sessions return 1.0 multiplier', () => {
			expect(evaluator.computeRecencyMultiplier(0, 0)).toBe(1.0);
		});
	});

	// ─── computeRecencyMultiplier ────────────────────────────────────────

	describe('computeRecencyMultiplier', () => {
		it('returns 1.0 for turn 0', () => {
			expect(evaluator.computeRecencyMultiplier(0, 10)).toBe(1.0);
		});

		it('returns 0.5 for injection at the last turn', () => {
			expect(evaluator.computeRecencyMultiplier(10, 10)).toBeCloseTo(0.5);
		});

		it('decays linearly between 1.0 and 0.5', () => {
			expect(evaluator.computeRecencyMultiplier(5, 10)).toBeCloseTo(0.75);
			expect(evaluator.computeRecencyMultiplier(2, 10)).toBeCloseTo(0.9);
		});

		it('returns 1.0 when totalTurns is 0', () => {
			expect(evaluator.computeRecencyMultiplier(0, 0)).toBe(1.0);
		});

		it('returns 1.0 when totalTurns is 1', () => {
			expect(evaluator.computeRecencyMultiplier(0, 1)).toBe(1.0);
		});

		it('clamps injectionTurn to totalTurns', () => {
			// If somehow injection turn exceeds total, multiplier should be 0.5 (minimum)
			expect(evaluator.computeRecencyMultiplier(20, 10)).toBeCloseTo(0.5);
		});
	});
});
