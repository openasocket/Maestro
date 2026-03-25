/**
 * @fileoverview Tests for tier-aware connection validation in TeamBuilderCanvas.
 *
 * Validates the rules:
 *   1. Workers can connect to Managers or Executives (not other Workers)
 *   2. Managers can connect to Executives or other Managers (not Workers)
 *   3. Executives can connect to other Executives
 *   4. Higher tier cannot report to lower tier
 */

import { describe, it, expect } from 'vitest';
import { ROLE_TIER_ORDER, type RoleTier } from '../../../shared/group-chat-types';
import { validateTierConnection } from '../../../renderer/components/CueModal/TeamBuilderCanvas';

describe('ROLE_TIER_ORDER', () => {
	it('should have executive as highest authority', () => {
		expect(ROLE_TIER_ORDER.executive).toBeGreaterThan(ROLE_TIER_ORDER.manager);
		expect(ROLE_TIER_ORDER.manager).toBeGreaterThan(ROLE_TIER_ORDER.worker);
	});
});

describe('validateTierConnection', () => {
	// ─── Valid connections ────────────────────────────────────────────
	describe('valid connections', () => {
		it('allows Worker → Manager (reports-to)', () => {
			const result = validateTierConnection('worker', 'manager');
			expect(result.valid).toBe(true);
		});

		it('allows Worker → Executive (direct reporting)', () => {
			const result = validateTierConnection('worker', 'executive');
			expect(result.valid).toBe(true);
		});

		it('allows Manager → Executive (escalates-to)', () => {
			const result = validateTierConnection('manager', 'executive');
			expect(result.valid).toBe(true);
		});

		it('allows Manager → Manager (peer coordination)', () => {
			const result = validateTierConnection('manager', 'manager');
			expect(result.valid).toBe(true);
		});

		it('allows Executive → Executive (multi-level hierarchy)', () => {
			const result = validateTierConnection('executive', 'executive');
			expect(result.valid).toBe(true);
		});
	});

	// ─── Invalid connections ─────────────────────────────────────────
	describe('invalid connections', () => {
		it('rejects Worker → Worker', () => {
			const result = validateTierConnection('worker', 'worker');
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('Workers');
		});

		it('rejects Manager → Worker (higher cannot report to lower)', () => {
			const result = validateTierConnection('manager', 'worker');
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('Managers');
		});

		it('rejects Executive → Manager (higher cannot report to lower)', () => {
			const result = validateTierConnection('executive', 'manager');
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('Executives');
		});

		it('rejects Executive → Worker (higher cannot report to lower)', () => {
			const result = validateTierConnection('executive', 'worker');
			expect(result.valid).toBe(false);
			expect(result.reason).toContain('Executives');
		});
	});

	// ─── Exhaustive matrix ───────────────────────────────────────────
	describe('exhaustive tier matrix', () => {
		const tiers: RoleTier[] = ['worker', 'manager', 'executive'];
		const expected: Record<string, boolean> = {
			'worker→worker': false,
			'worker→manager': true,
			'worker→executive': true,
			'manager→worker': false,
			'manager→manager': true,
			'manager→executive': true,
			'executive→worker': false,
			'executive→manager': false,
			'executive→executive': true,
		};

		for (const source of tiers) {
			for (const target of tiers) {
				const key = `${source}→${target}`;
				it(`${key} should be ${expected[key] ? 'valid' : 'invalid'}`, () => {
					const result = validateTierConnection(source, target);
					expect(result.valid).toBe(expected[key]);
				});
			}
		}
	});
});
