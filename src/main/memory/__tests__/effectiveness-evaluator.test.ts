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

		it('applies same outcome score to all memories in a session', () => {
			const record = makeRecord({
				ids: ['a', 'b', 'c'],
				scopeGroups: [{ scope: 'global', ids: ['a', 'b', 'c'] }],
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
});
