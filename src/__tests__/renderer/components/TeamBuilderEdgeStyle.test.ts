/**
 * @fileoverview Tests for tier-aware edge styling in TeamBuilderEdge.
 *
 * Tests the getEdgeStyleConfig() function which determines edge label,
 * line dash pattern, and whether a gradient should be used based on
 * source and target role tiers.
 *
 * Valid tier connections (per validation rules):
 *   Worker → Manager      : Solid, gradient, "Reports to"
 *   Worker → Executive    : Solid, gradient, "Reports to"
 *   Manager → Manager     : Dotted, no gradient, "Coordinates with"
 *   Manager → Executive   : Solid, gradient, "Escalates to"
 *   Executive → Executive : Dashed, no gradient, "Reports to"
 */

import { describe, it, expect } from 'vitest';
import type { RoleTier } from '../../../shared/group-chat-types';
import { getEdgeStyleConfig } from '../../../renderer/components/CueModal/edges/TeamBuilderEdge';

describe('getEdgeStyleConfig', () => {
	describe('Worker → Manager', () => {
		const config = getEdgeStyleConfig('worker', 'manager');

		it('labels "Reports to"', () => {
			expect(config.label).toBe('Reports to');
		});

		it('uses solid line (no dash)', () => {
			expect(config.strokeDasharray).toBeUndefined();
		});

		it('uses gradient', () => {
			expect(config.useGradient).toBe(true);
		});
	});

	describe('Worker → Executive', () => {
		const config = getEdgeStyleConfig('worker', 'executive');

		it('labels "Reports to"', () => {
			expect(config.label).toBe('Reports to');
		});

		it('uses solid line (no dash)', () => {
			expect(config.strokeDasharray).toBeUndefined();
		});

		it('uses gradient', () => {
			expect(config.useGradient).toBe(true);
		});
	});

	describe('Manager → Executive', () => {
		const config = getEdgeStyleConfig('manager', 'executive');

		it('labels "Escalates to"', () => {
			expect(config.label).toBe('Escalates to');
		});

		it('uses solid line (no dash)', () => {
			expect(config.strokeDasharray).toBeUndefined();
		});

		it('uses gradient', () => {
			expect(config.useGradient).toBe(true);
		});
	});

	describe('Executive → Executive', () => {
		const config = getEdgeStyleConfig('executive', 'executive');

		it('labels "Reports to"', () => {
			expect(config.label).toBe('Reports to');
		});

		it('uses dashed line', () => {
			expect(config.strokeDasharray).toBe('6 3');
		});

		it('does not use gradient', () => {
			expect(config.useGradient).toBe(false);
		});
	});

	describe('Manager → Manager', () => {
		const config = getEdgeStyleConfig('manager', 'manager');

		it('labels "Coordinates with"', () => {
			expect(config.label).toBe('Coordinates with');
		});

		it('uses dotted line', () => {
			expect(config.strokeDasharray).toBe('3 3');
		});

		it('does not use gradient', () => {
			expect(config.useGradient).toBe(false);
		});
	});

	describe('exhaustive valid-connection matrix', () => {
		const cases: [RoleTier, RoleTier, string, boolean][] = [
			['worker', 'manager', 'Reports to', true],
			['worker', 'executive', 'Reports to', true],
			['manager', 'manager', 'Coordinates with', false],
			['manager', 'executive', 'Escalates to', true],
			['executive', 'executive', 'Reports to', false],
		];

		it.each(cases)(
			'%s → %s: label="%s", useGradient=%s',
			(source, target, expectedLabel, expectedGradient) => {
				const config = getEdgeStyleConfig(source, target);
				expect(config.label).toBe(expectedLabel);
				expect(config.useGradient).toBe(expectedGradient);
			}
		);
	});
});
