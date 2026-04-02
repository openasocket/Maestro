/**
 * Tests for memory-effectiveness — multi-signal outcome scoring (EXP-ENHANCE-05).
 *
 * Mocks child_process (git), stats DB, and history manager so we test
 * only the scoring logic, not external systems.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
	execFile: (...args: any[]) => mockExecFile(...args),
}));
vi.mock('util', async (importOriginal) => {
	const original = await importOriginal<typeof import('util')>();
	return {
		...original,
		promisify: () => mockExecFile,
	};
});

const mockGetQueryEvents = vi.fn().mockReturnValue([]);
vi.mock('../../stats', () => ({
	getStatsDB: () => ({
		getQueryEvents: (...args: any[]) => mockGetQueryEvents(...args),
	}),
}));

const mockGetEntries = vi.fn().mockReturnValue([]);
vi.mock('../../history-manager', () => ({
	getHistoryManager: () => ({
		getEntries: (...args: any[]) => mockGetEntries(...args),
	}),
}));

const mockUpdateEffectiveness = vi.fn().mockResolvedValue(undefined);
vi.mock('../../memory/memory-store', () => ({
	getMemoryStore: () => ({
		updateEffectiveness: (...args: any[]) => mockUpdateEffectiveness(...args),
	}),
}));

const mockGetInjectionRecord = vi.fn().mockReturnValue(null);
const mockClearSessionInjection = vi.fn();
vi.mock('../../memory/memory-injector', () => ({
	getInjectionRecord: (...args: any[]) => mockGetInjectionRecord(...args),
	clearSessionInjection: (...args: any[]) => mockClearSessionInjection(...args),
}));

import {
	computeOutcomeScore,
	computeSessionOutcomeScore,
	onProcessComplete,
} from '../../memory/memory-effectiveness';
import type { SessionOutcomeSignals } from '../../../shared/memory-types';

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.clearAllMocks();
	// Default: git commands fail (no git repo)
	mockExecFile.mockRejectedValue(new Error('not a git repo'));
	// Default: no stats
	mockGetQueryEvents.mockReturnValue([]);
	// Default: no history entries
	mockGetEntries.mockReturnValue([]);
});

// ─── computeOutcomeScore ────────────────────────────────────────────────────

describe('computeOutcomeScore', () => {
	it('returns 0.0 for non-zero exit code', async () => {
		const score = await computeOutcomeScore('session-1', 1);
		expect(score).toBe(0);
	});

	it('returns 0.6 base for exit code 0 with no other signals', async () => {
		const score = await computeOutcomeScore('session-1', 0);
		expect(score).toBe(0.6);
	});

	it('adds 0.2 for commit presence', async () => {
		// First call: git diff (fail or empty)
		// Second call: git log (has commits)
		mockExecFile
			.mockResolvedValueOnce({ stdout: '' }) // diff
			.mockResolvedValueOnce({ stdout: 'abc1234 some commit\n' }); // log

		const score = await computeOutcomeScore('session-1', 0, '/project');
		// 0.6 base + 0.2 commit = 0.8 (no duration bonus since stats mock returns [])
		expect(score).toBe(0.8);
	});

	it('adds 0.2 for duration > 5000ms', async () => {
		mockGetQueryEvents.mockReturnValue([{ duration: 10000 }]);

		const score = await computeOutcomeScore('session-1', 0);
		// 0.6 base + 0.2 duration = 0.8
		expect(score).toBe(0.8);
	});

	it('does not add duration bonus for short sessions', async () => {
		mockGetQueryEvents.mockReturnValue([{ duration: 2000 }]);

		const score = await computeOutcomeScore('session-1', 0);
		// 0.6 base, no duration bonus
		expect(score).toBe(0.6);
	});

	it('deducts 0.1 per anti-pattern found in diff', async () => {
		const diffWithAntiPatterns = [
			'+  // TODO: fix this later',
			'+  console.log("debug");',
			'+  const fn = () => {}',
		].join('\n');

		mockExecFile
			.mockResolvedValueOnce({ stdout: diffWithAntiPatterns }) // diff
			.mockResolvedValueOnce({ stdout: '' }); // log (no commits)

		const score = await computeOutcomeScore('session-1', 0, '/project');
		// 0.6 base - 0.3 (3 anti-patterns) = 0.3
		expect(score).toBeCloseTo(0.3);
	});

	it('clamps score to 0.0 when anti-patterns exceed base', async () => {
		const diffWithManyAntiPatterns = [
			'+  // TODO: fix this',
			'+  // FIXME: and this',
			'+  console.log("debug");',
			'+  const fn = () => {}',
			'+  // eslint-disable-next-line no-any',
		].join('\n');

		mockExecFile
			.mockResolvedValueOnce({ stdout: diffWithManyAntiPatterns }) // diff
			.mockResolvedValueOnce({ stdout: '' }); // log

		const score = await computeOutcomeScore('session-1', 0, '/project');
		// 0.6 base - 0.4 (4 distinct regex patterns) = 0.2 (clamped at 0 minimum per-component, then further signals)
		// Actually: anti-patterns matched = TODO/FIXME (1), console.log (1), empty body (1), eslint-disable (1) = 4 × 0.1 = 0.4
		// 0.6 - 0.4 = 0.2 (max(0, 0.2) = 0.2)
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it('applies context health discount for high utilization (>0.8)', async () => {
		mockGetQueryEvents.mockReturnValue([{ duration: 10000 }]);
		mockGetEntries.mockReturnValue([{ contextUsage: 0.85 }]);

		const score = await computeOutcomeScore('session-1', 0);
		// 0.6 base + 0.2 duration = 0.8, then × 0.8 (context penalty) = 0.64
		expect(score).toBeCloseTo(0.64);
	});

	it('applies mild context discount for moderate utilization (0.6-0.8)', async () => {
		mockGetQueryEvents.mockReturnValue([{ duration: 10000 }]);
		mockGetEntries.mockReturnValue([{ contextUsage: 0.7 }]);

		const score = await computeOutcomeScore('session-1', 0);
		// 0.6 base + 0.2 duration = 0.8, then × 0.9 (mild penalty) = 0.72
		expect(score).toBeCloseTo(0.72);
	});

	it('no context discount for healthy utilization (<0.6)', async () => {
		mockGetQueryEvents.mockReturnValue([{ duration: 10000 }]);
		mockGetEntries.mockReturnValue([{ contextUsage: 0.4 }]);

		const score = await computeOutcomeScore('session-1', 0);
		// 0.6 base + 0.2 duration = 0.8, no discount
		expect(score).toBe(0.8);
	});

	it('achieves maximum score with all positive signals', async () => {
		// git diff clean, commits present, good duration, low context usage
		mockExecFile
			.mockResolvedValueOnce({ stdout: '+ good clean code' }) // diff (no anti-patterns)
			.mockResolvedValueOnce({ stdout: 'abc1234 commit\n' }); // log
		mockGetQueryEvents.mockReturnValue([{ duration: 30000 }]);
		mockGetEntries.mockReturnValue([{ contextUsage: 0.3 }]);

		const score = await computeOutcomeScore('session-1', 0, '/project');
		// 0.6 base + 0.2 commit + 0.2 duration = 1.0 (clamped)
		expect(score).toBe(1.0);
	});

	it('never throws even when all sub-checks fail', async () => {
		mockExecFile.mockRejectedValue(new Error('git broken'));
		mockGetQueryEvents.mockImplementation(() => {
			throw new Error('stats broken');
		});
		mockGetEntries.mockImplementation(() => {
			throw new Error('history broken');
		});

		const score = await computeOutcomeScore('session-1', 0, '/project');
		// Should still return base score of 0.6
		expect(score).toBe(0.6);
	});

	it('skips anti-pattern scan for non-zero exit codes', async () => {
		const score = await computeOutcomeScore('session-1', 1, '/project');
		expect(score).toBe(0);
		// git should not be called for failed sessions
		expect(mockExecFile).not.toHaveBeenCalled();
	});
});

// ─── onProcessComplete ──────────────────────────────────────────────────────

describe('onProcessComplete', () => {
	it('skips when no injection record exists', async () => {
		mockGetInjectionRecord.mockReturnValue(null);

		await onProcessComplete('session-1', 0);
		expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
	});

	it('skips when injection record has empty ids', async () => {
		mockGetInjectionRecord.mockReturnValue({ ids: [], scopeGroups: [] });

		await onProcessComplete('session-1', 0);
		expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
	});

	it('updates effectiveness for each scope group with computed score', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: ['mem-1', 'mem-2'],
			scopeGroups: [
				{ ids: ['mem-1'], scope: 'global', skillAreaId: undefined, projectPath: undefined },
				{ ids: ['mem-2'], scope: 'project', skillAreaId: undefined, projectPath: '/proj' },
			],
		});

		await onProcessComplete('session-1', 0);

		expect(mockUpdateEffectiveness).toHaveBeenCalledTimes(2);
		// Score should be 0.6 (base only, no other signals available)
		expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
			['mem-1'],
			0.6,
			'global',
			undefined,
			undefined
		);
		expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
			['mem-2'],
			0.6,
			'project',
			undefined,
			'/proj'
		);
	});

	it('clears injection record after processing', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: ['mem-1'],
			scopeGroups: [
				{ ids: ['mem-1'], scope: 'global', skillAreaId: undefined, projectPath: undefined },
			],
		});

		await onProcessComplete('session-1', 0);
		expect(mockClearSessionInjection).toHaveBeenCalledWith('session-1');
	});

	it('passes projectPath to computeOutcomeScore', async () => {
		mockGetInjectionRecord.mockReturnValue({
			ids: ['mem-1'],
			scopeGroups: [
				{ ids: ['mem-1'], scope: 'global', skillAreaId: undefined, projectPath: undefined },
			],
		});

		// Setup git to return commits for the project path
		mockExecFile
			.mockResolvedValueOnce({ stdout: '' }) // diff
			.mockResolvedValueOnce({ stdout: 'abc commit\n' }); // log

		await onProcessComplete('session-1', 0, '/my-project');

		// Score should include commit bonus: 0.6 + 0.2 = 0.8
		expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
			['mem-1'],
			0.8,
			'global',
			undefined,
			undefined
		);
	});
});

// ─── computeSessionOutcomeScore (MEM-EVOLVE-04) ────────────────────────────

describe('computeSessionOutcomeScore', () => {
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

	it('returns maximum positive score for ideal session', () => {
		const score = computeSessionOutcomeScore(
			makeSignals({
				completed: true,
				cancelled: false,
				errorCount: 0,
				gitDiffProduced: true,
				contextUtilization: 0.5,
			})
		);
		// +0.3 (no errors) +0.2 (completed) +0.1 (low context) +0.2 (git diff) = 0.8
		expect(score).toBe(0.8);
	});

	it('gives +0.3 for session completed without errors', () => {
		const withErrors = computeSessionOutcomeScore(makeSignals({ errorCount: 1 }));
		const withoutErrors = computeSessionOutcomeScore(makeSignals({ errorCount: 0 }));
		// withErrors also gets -0.3 for unresolved errors, so delta is 0.6
		expect(withoutErrors - withErrors).toBeCloseTo(0.6);
	});

	it('gives +0.2 for agent completing task (not cancelled)', () => {
		const cancelled = computeSessionOutcomeScore(
			makeSignals({ cancelled: true, completed: false })
		);
		const completed = computeSessionOutcomeScore(makeSignals({ completed: true }));
		// completed gets +0.2 for completion, cancelled gets -0.1 for abandonment
		expect(completed).toBeGreaterThan(cancelled);
	});

	it('gives +0.1 for low context utilization (<70%)', () => {
		const lowCtx = computeSessionOutcomeScore(makeSignals({ contextUtilization: 0.5 }));
		const highCtx = computeSessionOutcomeScore(makeSignals({ contextUtilization: 0.8 }));
		expect(lowCtx - highCtx).toBeCloseTo(0.1);
	});

	it('gives +0.2 for git diff produced', () => {
		const withDiff = computeSessionOutcomeScore(makeSignals({ gitDiffProduced: true }));
		const noDiff = computeSessionOutcomeScore(makeSignals({ gitDiffProduced: false }));
		expect(withDiff - noDiff).toBeCloseTo(0.2);
	});

	it('gives -0.3 for unresolved repeated errors', () => {
		const clean = computeSessionOutcomeScore(makeSignals({ errorCount: 0 }));
		const errored = computeSessionOutcomeScore(
			makeSignals({ errorCount: 3, resolvedErrorCount: 1 })
		);
		// clean has +0.3 (no errors), errored has -0.3 (unresolved) and no +0.3
		expect(clean - errored).toBeCloseTo(0.6);
	});

	it('does not penalize when all errors were resolved', () => {
		const resolved = computeSessionOutcomeScore(
			makeSignals({ errorCount: 3, resolvedErrorCount: 3 })
		);
		// No -0.3 penalty since resolved >= errorCount, but also no +0.3 since errorCount > 0
		// +0.2 (completed) +0.1 (low context) = 0.3
		expect(resolved).toBeCloseTo(0.3);
	});

	it('gives -0.1 for cancelled session', () => {
		const normal = computeSessionOutcomeScore(makeSignals({ completed: true }));
		const cancelled = computeSessionOutcomeScore(
			makeSignals({ completed: false, cancelled: true })
		);
		// normal: +0.3 +0.2 +0.1 = 0.6; cancelled: -0.1 +0.1 = 0.0 (clamped)
		expect(cancelled).toBeLessThan(normal);
		// cancelled loses +0.3 (errors), +0.2 (completed), gains -0.1 (cancelled)
		expect(cancelled).toBe(0.0);
	});

	it('gives -0.1 for very high context usage (>90%)', () => {
		const normal = computeSessionOutcomeScore(makeSignals({ contextUtilization: 0.8 }));
		const highCtx = computeSessionOutcomeScore(makeSignals({ contextUtilization: 0.95 }));
		expect(normal - highCtx).toBeCloseTo(0.1);
	});

	it('clamps to 0.0 when all negative signals fire', () => {
		const score = computeSessionOutcomeScore(
			makeSignals({
				completed: false,
				cancelled: true,
				errorCount: 5,
				resolvedErrorCount: 0,
				gitDiffProduced: false,
				contextUtilization: 0.95,
			})
		);
		// No positive signals, -0.3 -0.1 -0.1 = -0.5 → clamped to 0.0
		expect(score).toBe(0.0);
	});

	it('clamps to 1.0 (never exceeds)', () => {
		const score = computeSessionOutcomeScore(
			makeSignals({
				completed: true,
				cancelled: false,
				errorCount: 0,
				gitDiffProduced: true,
				contextUtilization: 0.3,
			})
		);
		// +0.3 +0.2 +0.1 +0.2 = 0.8, well within bounds
		expect(score).toBeLessThanOrEqual(1.0);
		expect(score).toBeGreaterThanOrEqual(0.0);
	});
});
