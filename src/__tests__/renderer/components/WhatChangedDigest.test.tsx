/**
 * Tests for WhatChangedDigest summary logic.
 *
 * The WhatChangedDigest component computes a summary from MemoryChangeEvents
 * and formats it for display. This test validates the summary computation
 * and formatting logic without rendering the full StatusTab (which has
 * extensive side-effects and dependencies).
 */

import { describe, it, expect } from 'vitest';
import type { MemoryChangeEvent, MemoryChangeEventType } from '../../../shared/memory-types';

function makeEvent(overrides: Partial<MemoryChangeEvent> = {}): MemoryChangeEvent {
	return {
		timestamp: Date.now(),
		type: 'created',
		memoryId: 'mem-1',
		memoryContent: 'Test memory content',
		memoryType: 'rule',
		scope: 'global',
		triggeredBy: 'system',
		...overrides,
	};
}

/**
 * Replicates the summary computation from WhatChangedDigest.
 * Extracted here for testability.
 */
function computeDigestSummary(events: MemoryChangeEvent[]): string[] {
	const counts: Partial<Record<MemoryChangeEventType, number>> = {};
	for (const e of events) {
		counts[e.type] = (counts[e.type] ?? 0) + 1;
	}

	const parts: string[] = [];
	if (counts.created)
		parts.push(`${counts.created} new experience${counts.created > 1 ? 's' : ''} extracted`);
	if (counts.promoted)
		parts.push(`${counts.promoted} memor${counts.promoted > 1 ? 'ies' : 'y'} promoted to rule`);
	if (counts.decayed)
		parts.push(`${counts.decayed} memor${counts.decayed > 1 ? 'ies' : 'y'} had confidence decay`);
	if (counts.pruned) parts.push(`${counts.pruned} memor${counts.pruned > 1 ? 'ies' : 'y'} pruned`);
	if (counts.updated)
		parts.push(`${counts.updated} memor${counts.updated > 1 ? 'ies' : 'y'} updated`);
	if (counts.deleted)
		parts.push(`${counts.deleted} memor${counts.deleted > 1 ? 'ies' : 'y'} deleted`);
	if (counts.consolidated)
		parts.push(`${counts.consolidated} consolidation${counts.consolidated > 1 ? 's' : ''}`);
	if (counts.archived)
		parts.push(`${counts.archived} memor${counts.archived > 1 ? 'ies' : 'y'} archived`);
	if (counts.imported)
		parts.push(`${counts.imported} memor${counts.imported > 1 ? 'ies' : 'y'} imported`);

	return parts;
}

describe('WhatChangedDigest summary logic', () => {
	it('returns empty parts for no events', () => {
		const parts = computeDigestSummary([]);
		expect(parts).toEqual([]);
	});

	it('counts single created event correctly (singular)', () => {
		const parts = computeDigestSummary([makeEvent({ type: 'created' })]);
		expect(parts).toEqual(['1 new experience extracted']);
	});

	it('counts multiple created events correctly (plural)', () => {
		const parts = computeDigestSummary([
			makeEvent({ type: 'created' }),
			makeEvent({ type: 'created' }),
			makeEvent({ type: 'created' }),
		]);
		expect(parts).toEqual(['3 new experiences extracted']);
	});

	it('counts mixed event types', () => {
		const parts = computeDigestSummary([
			makeEvent({ type: 'created' }),
			makeEvent({ type: 'created' }),
			makeEvent({ type: 'promoted' }),
			makeEvent({ type: 'decayed' }),
			makeEvent({ type: 'decayed' }),
			makeEvent({ type: 'decayed' }),
			makeEvent({ type: 'pruned' }),
		]);
		expect(parts).toEqual([
			'2 new experiences extracted',
			'1 memory promoted to rule',
			'3 memories had confidence decay',
			'1 memory pruned',
		]);
	});

	it('handles all event types', () => {
		const parts = computeDigestSummary([
			makeEvent({ type: 'created' }),
			makeEvent({ type: 'promoted' }),
			makeEvent({ type: 'decayed' }),
			makeEvent({ type: 'pruned' }),
			makeEvent({ type: 'updated' }),
			makeEvent({ type: 'deleted' }),
			makeEvent({ type: 'consolidated' }),
			makeEvent({ type: 'archived' }),
			makeEvent({ type: 'imported' }),
		]);
		expect(parts).toHaveLength(9);
		expect(parts[0]).toContain('extracted');
		expect(parts[1]).toContain('promoted');
		expect(parts[2]).toContain('decay');
		expect(parts[3]).toContain('pruned');
		expect(parts[4]).toContain('updated');
		expect(parts[5]).toContain('deleted');
		expect(parts[6]).toContain('consolidation');
		expect(parts[7]).toContain('archived');
		expect(parts[8]).toContain('imported');
	});

	it('uses plural forms for counts > 1', () => {
		const parts = computeDigestSummary([
			makeEvent({ type: 'promoted' }),
			makeEvent({ type: 'promoted' }),
			makeEvent({ type: 'consolidated' }),
			makeEvent({ type: 'consolidated' }),
		]);
		expect(parts).toEqual(['2 memories promoted to rule', '2 consolidations']);
	});

	it('uses singular forms for count === 1', () => {
		const parts = computeDigestSummary([
			makeEvent({ type: 'promoted' }),
			makeEvent({ type: 'consolidated' }),
		]);
		expect(parts).toEqual(['1 memory promoted to rule', '1 consolidation']);
	});
});
