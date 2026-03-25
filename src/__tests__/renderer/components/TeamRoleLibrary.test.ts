/**
 * @fileoverview Tests for the built-in role prompt library (teamRoleLibrary.ts).
 *
 * Validates:
 *   1. Library structure and completeness (15 roles)
 *   2. Required fields on every entry
 *   3. Tier distribution (3 executives, 5 managers, 7 workers)
 *   4. Category coverage and label mapping
 *   5. Unique IDs across all entries
 */

import { describe, it, expect } from 'vitest';
import {
	ROLE_LIBRARY,
	ROLE_CATEGORIES,
	CATEGORY_LABELS,
	type RoleTemplate,
} from '../../../renderer/components/CueModal/teamRoleLibrary';

describe('ROLE_LIBRARY', () => {
	it('contains exactly 15 role templates', () => {
		expect(ROLE_LIBRARY).toHaveLength(15);
	});

	it('has unique IDs for every role', () => {
		const ids = ROLE_LIBRARY.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('has unique names for every role', () => {
		const names = ROLE_LIBRARY.map((r) => r.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('every role has all required fields populated', () => {
		for (const role of ROLE_LIBRARY) {
			expect(role.id).toBeTruthy();
			expect(role.name).toBeTruthy();
			expect(['executive', 'manager', 'worker']).toContain(role.tier);
			expect(role.description.length).toBeGreaterThan(10);
			expect(role.prompt.length).toBeGreaterThan(30);
			expect(role.defaultAgentId).toBe('claude-code');
			expect(role.tags.length).toBeGreaterThan(0);
			expect(role.category).toBeTruthy();
		}
	});

	it('has correct tier distribution: 3 exec, 5 manager, 7 worker', () => {
		const byTier = (tier: RoleTemplate['tier']) => ROLE_LIBRARY.filter((r) => r.tier === tier);
		expect(byTier('executive')).toHaveLength(3);
		expect(byTier('manager')).toHaveLength(5);
		expect(byTier('worker')).toHaveLength(7);
	});

	it('every role belongs to a recognized category', () => {
		for (const role of ROLE_LIBRARY) {
			expect(ROLE_CATEGORIES).toContain(role.category);
		}
	});

	it('all four categories are represented', () => {
		const used = new Set(ROLE_LIBRARY.map((r) => r.category));
		for (const cat of ROLE_CATEGORIES) {
			expect(used.has(cat)).toBe(true);
		}
	});
});

describe('ROLE_CATEGORIES / CATEGORY_LABELS', () => {
	it('lists 4 categories in order', () => {
		expect(ROLE_CATEGORIES).toEqual(['leadership', 'engineering', 'quality', 'operations']);
	});

	it('has a human-readable label for every category', () => {
		for (const cat of ROLE_CATEGORIES) {
			expect(typeof CATEGORY_LABELS[cat]).toBe('string');
			expect(CATEGORY_LABELS[cat].length).toBeGreaterThan(0);
		}
	});
});
