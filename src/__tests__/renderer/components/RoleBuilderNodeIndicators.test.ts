/**
 * @fileoverview Tests for RoleBuilderNode hierarchy indicator helpers.
 *
 * Tests pure functions exported from RoleBuilderNode:
 *   - getIncomingBadgeLabel: badge text for incoming connection counts
 *   - computeNodeConnectionInfo: connection info computation from edge list
 */

import { describe, it, expect } from 'vitest';
import type { RoleTier } from '../../../shared/group-chat-types';
import {
	getIncomingBadgeLabel,
	computeNodeConnectionInfo,
} from '../../../renderer/components/CueModal/nodes/RoleBuilderNode';

// ============================================================================
// getIncomingBadgeLabel
// ============================================================================

describe('getIncomingBadgeLabel', () => {
	it('returns null for count 0', () => {
		expect(getIncomingBadgeLabel(0)).toBeNull();
	});

	it('returns null for negative count', () => {
		expect(getIncomingBadgeLabel(-1)).toBeNull();
	});

	it('returns singular "1 report" for count 1', () => {
		expect(getIncomingBadgeLabel(1)).toBe('1 report');
	});

	it('returns plural "2 reports" for count 2', () => {
		expect(getIncomingBadgeLabel(2)).toBe('2 reports');
	});

	it('returns plural "5 reports" for count 5', () => {
		expect(getIncomingBadgeLabel(5)).toBe('5 reports');
	});

	it('handles large counts', () => {
		expect(getIncomingBadgeLabel(99)).toBe('99 reports');
	});
});

// ============================================================================
// computeNodeConnectionInfo
// ============================================================================

describe('computeNodeConnectionInfo', () => {
	const makeLookup = (...entries: [string, RoleTier][]): Map<string, RoleTier> => new Map(entries);

	// ── Incoming count ──────────────────────────────────────────────────

	describe('incomingCount', () => {
		it('returns 0 when node has no incoming edges', () => {
			const edges = [{ source: 'a', target: 'b' }];
			const lookup = makeLookup(['a', 'worker'], ['b', 'manager']);
			expect(computeNodeConnectionInfo('a', 'worker', edges, lookup).incomingCount).toBe(0);
		});

		it('counts all incoming edges', () => {
			const edges = [
				{ source: 'w1', target: 'mgr' },
				{ source: 'w2', target: 'mgr' },
				{ source: 'w3', target: 'mgr' },
			];
			const lookup = makeLookup(
				['w1', 'worker'],
				['w2', 'worker'],
				['w3', 'worker'],
				['mgr', 'manager']
			);
			expect(computeNodeConnectionInfo('mgr', 'manager', edges, lookup).incomingCount).toBe(3);
		});

		it('does not count outgoing edges as incoming', () => {
			const edges = [
				{ source: 'mgr', target: 'exec' },
				{ source: 'w1', target: 'mgr' },
			];
			const lookup = makeLookup(['w1', 'worker'], ['mgr', 'manager'], ['exec', 'executive']);
			expect(computeNodeConnectionInfo('mgr', 'manager', edges, lookup).incomingCount).toBe(1);
		});

		it('returns 0 for empty edge list', () => {
			expect(computeNodeConnectionInfo('a', 'worker', [], new Map()).incomingCount).toBe(0);
		});
	});

	// ── hasOutgoingToHigherTier ─────────────────────────────────────────

	describe('hasOutgoingToHigherTier', () => {
		it('is true when worker connects to manager', () => {
			const edges = [{ source: 'w', target: 'm' }];
			const lookup = makeLookup(['w', 'worker'], ['m', 'manager']);
			expect(computeNodeConnectionInfo('w', 'worker', edges, lookup).hasOutgoingToHigherTier).toBe(
				true
			);
		});

		it('is true when worker connects to executive', () => {
			const edges = [{ source: 'w', target: 'e' }];
			const lookup = makeLookup(['w', 'worker'], ['e', 'executive']);
			expect(computeNodeConnectionInfo('w', 'worker', edges, lookup).hasOutgoingToHigherTier).toBe(
				true
			);
		});

		it('is true when manager connects to executive', () => {
			const edges = [{ source: 'm', target: 'e' }];
			const lookup = makeLookup(['m', 'manager'], ['e', 'executive']);
			expect(computeNodeConnectionInfo('m', 'manager', edges, lookup).hasOutgoingToHigherTier).toBe(
				true
			);
		});

		it('is false for same-tier manager-manager connections', () => {
			const edges = [{ source: 'm1', target: 'm2' }];
			const lookup = makeLookup(['m1', 'manager'], ['m2', 'manager']);
			expect(
				computeNodeConnectionInfo('m1', 'manager', edges, lookup).hasOutgoingToHigherTier
			).toBe(false);
		});

		it('is false for same-tier executive-executive connections', () => {
			const edges = [{ source: 'e1', target: 'e2' }];
			const lookup = makeLookup(['e1', 'executive'], ['e2', 'executive']);
			expect(
				computeNodeConnectionInfo('e1', 'executive', edges, lookup).hasOutgoingToHigherTier
			).toBe(false);
		});

		it('is false when node has no outgoing edges', () => {
			const edges = [{ source: 'w', target: 'exec' }];
			const lookup = makeLookup(['w', 'worker'], ['exec', 'executive']);
			expect(
				computeNodeConnectionInfo('exec', 'executive', edges, lookup).hasOutgoingToHigherTier
			).toBe(false);
		});

		it('is false when node has no edges at all', () => {
			expect(
				computeNodeConnectionInfo('isolated', 'worker', [], new Map()).hasOutgoingToHigherTier
			).toBe(false);
		});

		it('defaults unknown targets to worker tier', () => {
			// Target not in lookup → defaults to worker, so worker→unknown(worker) is same-tier
			const edges = [{ source: 'w', target: 'unknown' }];
			const lookup = makeLookup(['w', 'worker']);
			expect(computeNodeConnectionInfo('w', 'worker', edges, lookup).hasOutgoingToHigherTier).toBe(
				false
			);
		});
	});

	// ── Combined scenarios ──────────────────────────────────────────────

	describe('combined scenarios', () => {
		it('executive with multiple reports and no outgoing', () => {
			const edges = [
				{ source: 'm1', target: 'ceo' },
				{ source: 'm2', target: 'ceo' },
			];
			const lookup = makeLookup(['m1', 'manager'], ['m2', 'manager'], ['ceo', 'executive']);
			const info = computeNodeConnectionInfo('ceo', 'executive', edges, lookup);
			expect(info.incomingCount).toBe(2);
			expect(info.hasOutgoingToHigherTier).toBe(false);
		});

		it('manager with incoming workers and outgoing to exec', () => {
			const edges = [
				{ source: 'w1', target: 'mgr' },
				{ source: 'w2', target: 'mgr' },
				{ source: 'mgr', target: 'exec' },
			];
			const lookup = makeLookup(
				['w1', 'worker'],
				['w2', 'worker'],
				['mgr', 'manager'],
				['exec', 'executive']
			);
			const info = computeNodeConnectionInfo('mgr', 'manager', edges, lookup);
			expect(info.incomingCount).toBe(2);
			expect(info.hasOutgoingToHigherTier).toBe(true);
		});

		it('worker with only outgoing to manager', () => {
			const edges = [{ source: 'w', target: 'm' }];
			const lookup = makeLookup(['w', 'worker'], ['m', 'manager']);
			const info = computeNodeConnectionInfo('w', 'worker', edges, lookup);
			expect(info.incomingCount).toBe(0);
			expect(info.hasOutgoingToHigherTier).toBe(true);
		});

		it('isolated node in busy graph returns defaults', () => {
			const edges = [{ source: 'other1', target: 'other2' }];
			const lookup = makeLookup(['other1', 'worker'], ['other2', 'manager'], ['alone', 'worker']);
			const info = computeNodeConnectionInfo('alone', 'worker', edges, lookup);
			expect(info.incomingCount).toBe(0);
			expect(info.hasOutgoingToHigherTier).toBe(false);
		});

		it('full org chain: workers → manager → executive', () => {
			const edges = [
				{ source: 'w1', target: 'mgr' },
				{ source: 'w2', target: 'mgr' },
				{ source: 'w3', target: 'mgr' },
				{ source: 'mgr', target: 'cto' },
			];
			const lookup = makeLookup(
				['w1', 'worker'],
				['w2', 'worker'],
				['w3', 'worker'],
				['mgr', 'manager'],
				['cto', 'executive']
			);

			// Workers: 0 incoming, outgoing to higher
			const w1 = computeNodeConnectionInfo('w1', 'worker', edges, lookup);
			expect(w1.incomingCount).toBe(0);
			expect(w1.hasOutgoingToHigherTier).toBe(true);

			// Manager: 3 incoming, outgoing to higher
			const mgr = computeNodeConnectionInfo('mgr', 'manager', edges, lookup);
			expect(mgr.incomingCount).toBe(3);
			expect(mgr.hasOutgoingToHigherTier).toBe(true);

			// Executive: 1 incoming, no outgoing
			const cto = computeNodeConnectionInfo('cto', 'executive', edges, lookup);
			expect(cto.incomingCount).toBe(1);
			expect(cto.hasOutgoingToHigherTier).toBe(false);
		});
	});
});
