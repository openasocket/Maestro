/**
 * Tests for the Memory Effectiveness Tracker.
 *
 * Tests cover:
 * - onProcessComplete: exit code 0 increases effectiveness
 * - onProcessComplete: non-zero exit code decreases effectiveness
 * - onProcessComplete: no-op when no injection record exists
 * - onProcessComplete: clears injection record after processing
 * - runGlobalConfidenceDecay: decays global and skill memories
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

vi.mock('electron-store', () => {
	return {
		default: class MockStore {
			private data: Record<string, unknown> = {};
			constructor(_opts?: unknown) {}
			get(key: string) {
				return this.data[key];
			}
			set(key: string, value: unknown) {
				this.data[key] = value;
			}
		},
	};
});

// Mock memory store
const mockUpdateEffectiveness = vi.fn<[], Promise<void>>();
const mockApplyConfidenceDecay = vi.fn<[], Promise<number>>();
const mockReadRegistry = vi.fn();

vi.mock('../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		updateEffectiveness: mockUpdateEffectiveness,
		applyConfidenceDecay: mockApplyConfidenceDecay,
		readRegistry: mockReadRegistry,
	}),
}));

// Mock injection tracker
const mockGetInjectionRecord = vi.fn();
const mockClearSessionInjection = vi.fn();

vi.mock('../../../main/memory/memory-injector', () => ({
	getInjectionRecord: (...args: unknown[]) => mockGetInjectionRecord(...args),
	clearSessionInjection: (...args: unknown[]) => mockClearSessionInjection(...args),
}));

import {
	onProcessComplete,
	runGlobalConfidenceDecay,
} from '../../../main/memory/memory-effectiveness';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Memory Effectiveness Tracker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUpdateEffectiveness.mockResolvedValue(undefined);
		mockApplyConfidenceDecay.mockResolvedValue(0);
	});

	// ─── onProcessComplete ─────────────────────────────────────────────

	describe('onProcessComplete', () => {
		it('updates effectiveness with base score 0.6 on exit code 0 (multi-signal scoring)', async () => {
			mockGetInjectionRecord.mockReturnValue({
				ids: ['mem-1', 'mem-2'],
				scopeGroups: [{ scope: 'global', ids: ['mem-1', 'mem-2'] }],
			});

			await onProcessComplete('session-1', 0);

			// Multi-signal scoring: base 0.6 for exit code 0
			// Bonuses for commits (+0.2) and duration (+0.2) require git/stats unavailable in test
			expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
				['mem-1', 'mem-2'],
				0.6,
				'global',
				undefined,
				undefined
			);
		});

		it('updates effectiveness with score 0.0 on non-zero exit code', async () => {
			mockGetInjectionRecord.mockReturnValue({
				ids: ['mem-1'],
				scopeGroups: [{ scope: 'global', ids: ['mem-1'] }],
			});

			await onProcessComplete('session-1', 1);

			expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
				['mem-1'],
				0.0,
				'global',
				undefined,
				undefined
			);
		});

		it('handles multiple scope groups', async () => {
			mockGetInjectionRecord.mockReturnValue({
				ids: ['mem-1', 'mem-2', 'mem-3'],
				scopeGroups: [
					{ scope: 'skill', skillAreaId: 'sk-1', ids: ['mem-1'] },
					{ scope: 'global', ids: ['mem-2'] },
					{ scope: 'project', projectPath: '/my/project', ids: ['mem-3'] },
				],
			});

			await onProcessComplete('session-1', 0);

			expect(mockUpdateEffectiveness).toHaveBeenCalledTimes(3);
			expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
				['mem-1'],
				0.6,
				'skill',
				'sk-1',
				undefined
			);
			expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
				['mem-2'],
				0.6,
				'global',
				undefined,
				undefined
			);
			expect(mockUpdateEffectiveness).toHaveBeenCalledWith(
				['mem-3'],
				0.6,
				'project',
				undefined,
				'/my/project'
			);
		});

		it('clears injection record after processing', async () => {
			mockGetInjectionRecord.mockReturnValue({
				ids: ['mem-1'],
				scopeGroups: [{ scope: 'global', ids: ['mem-1'] }],
			});

			await onProcessComplete('session-1', 0);

			expect(mockClearSessionInjection).toHaveBeenCalledWith('session-1');
		});

		it('is a no-op when no injection record exists', async () => {
			mockGetInjectionRecord.mockReturnValue(undefined);

			await onProcessComplete('session-1', 0);

			expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
			expect(mockClearSessionInjection).not.toHaveBeenCalled();
		});

		it('is a no-op when injection record has empty IDs', async () => {
			mockGetInjectionRecord.mockReturnValue({
				ids: [],
				scopeGroups: [],
			});

			await onProcessComplete('session-1', 0);

			expect(mockUpdateEffectiveness).not.toHaveBeenCalled();
		});
	});

	// ─── runGlobalConfidenceDecay ───────────────────────────────────────

	describe('runGlobalConfidenceDecay', () => {
		it('decays global scope', async () => {
			mockReadRegistry.mockResolvedValue({
				roles: [],
				personas: [],
				skillAreas: [],
			});

			await runGlobalConfidenceDecay(30);

			expect(mockApplyConfidenceDecay).toHaveBeenCalledWith('global', 30);
		});

		it('decays active skill area scopes', async () => {
			mockReadRegistry.mockResolvedValue({
				roles: [],
				personas: [],
				skillAreas: [
					{ id: 'sk-1', active: true },
					{ id: 'sk-2', active: false },
					{ id: 'sk-3', active: true },
				],
			});

			await runGlobalConfidenceDecay(30);

			// Global + 2 active skills = 3 calls
			expect(mockApplyConfidenceDecay).toHaveBeenCalledTimes(3);
			expect(mockApplyConfidenceDecay).toHaveBeenCalledWith('global', 30);
			expect(mockApplyConfidenceDecay).toHaveBeenCalledWith('skill', 30, 'sk-1');
			expect(mockApplyConfidenceDecay).toHaveBeenCalledWith('skill', 30, 'sk-3');
			// Should NOT have been called with sk-2 (inactive)
			expect(mockApplyConfidenceDecay).not.toHaveBeenCalledWith('skill', 30, 'sk-2');
		});

		it('returns total deactivated count', async () => {
			mockReadRegistry.mockResolvedValue({
				roles: [],
				personas: [],
				skillAreas: [{ id: 'sk-1', active: true }],
			});
			// Global decay deactivates 2, skill decay deactivates 1
			mockApplyConfidenceDecay.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

			const total = await runGlobalConfidenceDecay(30);
			expect(total).toBe(3);
		});
	});
});
