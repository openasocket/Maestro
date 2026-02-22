/**
 * Tests for MemoryInjector — disabled system bypass, token budgeting,
 * XML formatting with persona/skill grouping, tryInjectMemories error
 * handling, and session injection tracking.
 *
 * Mocks the memory store's cascadingSearch and recordInjection methods
 * so we test only the injector logic, not the search pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MemorySearchResult, MemoryConfig, MemoryEntry } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Mock store ──────────────────────────────────────────────────────────────

const mockCascadingSearch = vi.fn<
	[string, MemoryConfig, string, string?, number?],
	Promise<MemorySearchResult[]>
>();
const mockRecordInjection = vi.fn<[string[], string, string?, string?], Promise<void>>();

vi.mock('../../memory/memory-store', () => ({
	getMemoryStore: () => ({
		cascadingSearch: (...args: unknown[]) =>
			mockCascadingSearch(...(args as Parameters<typeof mockCascadingSearch>)),
		recordInjection: (...args: unknown[]) =>
			mockRecordInjection(...(args as Parameters<typeof mockRecordInjection>)),
	}),
}));

import {
	injectMemories,
	tryInjectMemories,
	setMemorySettingsStore,
	recordSessionInjection,
	getSessionInjection,
	getInjectionRecord,
	clearSessionInjection,
} from '../../memory/memory-injector';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let nextId = 0;

/** Create a fake MemoryEntry with sensible defaults. */
function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
	const id = overrides.id ?? `mem-${++nextId}`;
	const content = overrides.content ?? 'Test memory content';
	return {
		id,
		content,
		scope: 'skill',
		skillAreaId: undefined,
		type: 'rule',
		source: 'user',
		tags: [],
		embedding: null,
		tokenEstimate: overrides.tokenEstimate ?? Math.ceil(content.length / 4),
		effectivenessScore: 0.5,
		useCount: 0,
		lastUsedAt: 0,
		active: true,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as MemoryEntry;
}

/** Create a fake MemorySearchResult. */
function makeResult(
	overrides: Partial<MemorySearchResult> & { entry?: Partial<MemoryEntry> } = {}
): MemorySearchResult {
	const entry = makeEntry(overrides.entry ?? {});
	return {
		entry,
		similarity: overrides.similarity ?? 0.9,
		combinedScore: overrides.combinedScore ?? 0.85,
		personaName: overrides.personaName,
		skillAreaName: overrides.skillAreaName,
	};
}

describe('MemoryInjector', () => {
	beforeEach(() => {
		nextId = 0;
		mockCascadingSearch.mockReset();
		mockRecordInjection.mockReset();
		mockRecordInjection.mockResolvedValue(undefined);
		// Set settings getter to return enabled config
		setMemorySettingsStore(() => ({ enabled: true }));
	});

	afterEach(() => {
		// Reset settings getter
		setMemorySettingsStore(() => undefined);
	});

	// ─── 1. Disabled System ─────────────────────────────────────────────

	describe('Disabled system: returns original prompt unchanged', () => {
		it('returns original prompt when config.enabled is false', async () => {
			setMemorySettingsStore(() => ({ enabled: false }));

			const result = await injectMemories('Hello world', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('Hello world');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
			expect(result.personaContributions).toEqual([]);
			expect(result.flatScopeCounts).toEqual({ project: 0, global: 0 });
			expect(result.scopeGroups).toEqual([]);

			// Should not call cascadingSearch at all
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});

		it('returns original prompt when settings getter returns undefined', async () => {
			// MEMORY_CONFIG_DEFAULTS has enabled: false
			setMemorySettingsStore(() => undefined);

			const result = await injectMemories('Prompt text', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('Prompt text');
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});

		it('returns original prompt when no memories found', async () => {
			mockCascadingSearch.mockResolvedValue([]);

			const result = await injectMemories('My prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('My prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
		});
	});

	// ─── 2. Token Budget ────────────────────────────────────────────────

	describe('Token budget: stops at maxTokenBudget minus overhead', () => {
		it('selects memories that fit within the budget', async () => {
			// Budget is 1500 by default, minus 150 overhead = 1350 available
			const results = [
				makeResult({
					entry: { content: 'A'.repeat(2000), tokenEstimate: 500 },
					combinedScore: 0.9,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'B'.repeat(2000), tokenEstimate: 500 },
					combinedScore: 0.8,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'C'.repeat(2000), tokenEstimate: 500 },
					combinedScore: 0.7,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// Budget = 1350: first two fit (500+500=1000), third would be 1500 → skipped
			expect(result.injectedIds).toHaveLength(2);
			expect(result.injectedIds).toContain(results[0].entry.id);
			expect(result.injectedIds).toContain(results[1].entry.id);
			expect(result.injectedIds).not.toContain(results[2].entry.id);
		});

		it('skips large entries but includes smaller ones after', async () => {
			// Greedy: skip items that don't fit, continue to next
			const results = [
				makeResult({
					entry: { tokenEstimate: 200 },
					combinedScore: 0.95,
					personaName: 'P',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { tokenEstimate: 1200 },
					combinedScore: 0.9,
					personaName: 'P',
					skillAreaName: 'S',
				}), // too big after first
				makeResult({
					entry: { tokenEstimate: 300 },
					combinedScore: 0.85,
					personaName: 'P',
					skillAreaName: 'S',
				}), // fits after first
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// 200 fits, 1200 doesn't (200+1200=1400 > 1350), 300 fits (200+300=500)
			expect(result.injectedIds).toHaveLength(2);
			expect(result.injectedIds).toContain(results[0].entry.id);
			expect(result.injectedIds).not.toContain(results[1].entry.id);
			expect(result.injectedIds).toContain(results[2].entry.id);
		});

		it('respects custom maxTokenBudget from settings', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 500 }));
			// Available = 500 - 150 = 350

			const results = [
				makeResult({
					entry: { tokenEstimate: 200 },
					combinedScore: 0.9,
					personaName: 'P',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { tokenEstimate: 200 },
					combinedScore: 0.8,
					personaName: 'P',
					skillAreaName: 'S',
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// 200 fits, second 200 would be 400 > 350 → skipped
			expect(result.injectedIds).toHaveLength(1);
		});

		it('tokenCount includes overhead', async () => {
			const results = [
				makeResult({ entry: { tokenEstimate: 100 }, personaName: 'P', skillAreaName: 'S' }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// tokenCount = totalTokens (100) + WRAPPER_OVERHEAD_TOKENS (150)
			expect(result.tokenCount).toBe(250);
		});
	});

	// ─── 3. XML Format ──────────────────────────────────────────────────

	describe('XML format: <agent-memories> with correct structure', () => {
		it('produces valid XML wrapper with agent-memories tags', async () => {
			const results = [
				makeResult({
					entry: { content: 'Use Result<T,E> for errors' },
					personaName: 'Rust Dev',
					skillAreaName: 'Error Handling',
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('my prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('</agent-memories>');
			expect(result.injectedPrompt).toContain('Relevant knowledge for this task:');
			expect(result.injectedPrompt).toContain('- Use Result<T,E> for errors');
			// Prompt should appear after the XML block
			expect(result.injectedPrompt).toContain('my prompt');
			expect(result.injectedPrompt.indexOf('</agent-memories>')).toBeLessThan(
				result.injectedPrompt.indexOf('my prompt')
			);
		});

		it('groups memories under [PersonaName > SkillName] header', async () => {
			const results = [
				makeResult({
					entry: { content: 'Memory 1' },
					personaName: 'Rust Dev',
					skillAreaName: 'Error Handling',
				}),
				makeResult({
					entry: { content: 'Memory 2' },
					personaName: 'Rust Dev',
					skillAreaName: 'Error Handling',
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[Rust Dev > Error Handling]');
			expect(result.injectedPrompt).toContain('- Memory 1');
			expect(result.injectedPrompt).toContain('- Memory 2');
		});

		it('uses [PersonaName] header when no skill area name', async () => {
			const results = [
				makeResult({
					entry: { content: 'Persona-level memory' },
					personaName: 'Rust Dev',
					skillAreaName: undefined,
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[Rust Dev]');
			expect(result.injectedPrompt).toContain('- Persona-level memory');
		});

		it('uses [project] header for project-scoped memories', async () => {
			const results = [
				makeResult({
					entry: { content: 'Project memory', scope: 'project' },
					personaName: undefined,
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[project]');
			expect(result.injectedPrompt).toContain('- Project memory');
		});

		it('uses [global] header for global-scoped memories', async () => {
			const results = [
				makeResult({
					entry: { content: 'Global memory', scope: 'global' },
					personaName: undefined,
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[global]');
			expect(result.injectedPrompt).toContain('- Global memory');
		});

		it('prefixes experience type memories with (experience)', async () => {
			const results = [
				makeResult({
					entry: { content: 'Learned from session', type: 'experience' },
					personaName: 'Rust Dev',
					skillAreaName: 'Testing',
				}),
				makeResult({
					entry: { content: 'Standard rule', type: 'rule' },
					personaName: 'Rust Dev',
					skillAreaName: 'Testing',
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('- (experience) Learned from session');
			expect(result.injectedPrompt).toContain('- Standard rule');
			// Rule should NOT have the (experience) prefix
			expect(result.injectedPrompt).not.toContain('(experience) Standard rule');
		});

		it('sorts groups: hierarchy (0) → project (1) → global (2)', async () => {
			const results = [
				makeResult({
					entry: { content: 'Global mem', scope: 'global' },
					personaName: undefined,
				}),
				makeResult({
					entry: { content: 'Hierarchy mem' },
					personaName: 'Dev',
					skillAreaName: 'Skill',
				}),
				makeResult({
					entry: { content: 'Project mem', scope: 'project' },
					personaName: undefined,
				}),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			const hierarchyIdx = result.injectedPrompt.indexOf('[Dev > Skill]');
			const projectIdx = result.injectedPrompt.indexOf('[project]');
			const globalIdx = result.injectedPrompt.indexOf('[global]');

			// Hierarchy first, then project, then global
			expect(hierarchyIdx).toBeLessThan(projectIdx);
			expect(projectIdx).toBeLessThan(globalIdx);
		});
	});

	// ─── 4. Grouping ────────────────────────────────────────────────────

	describe('Grouping: memories from same persona grouped together', () => {
		it('groups multiple memories under same persona+skill', async () => {
			// Note: groups at same priority are sorted alphabetically by key.
			// [Dev > Errors] < [Dev > Testing], so Errors group appears first.
			const results = [
				makeResult({ entry: { content: 'Mem A' }, personaName: 'Dev', skillAreaName: 'Testing' }),
				makeResult({ entry: { content: 'Mem B' }, personaName: 'Dev', skillAreaName: 'Testing' }),
				makeResult({ entry: { content: 'Mem C' }, personaName: 'Dev', skillAreaName: 'Errors' }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// Should have two groups: [Dev > Errors] and [Dev > Testing]
			expect(result.injectedPrompt).toContain('[Dev > Testing]');
			expect(result.injectedPrompt).toContain('[Dev > Errors]');

			const errorsIdx = result.injectedPrompt.indexOf('[Dev > Errors]');
			const testingIdx = result.injectedPrompt.indexOf('[Dev > Testing]');
			const memAIdx = result.injectedPrompt.indexOf('- Mem A');
			const memBIdx = result.injectedPrompt.indexOf('- Mem B');
			const memCIdx = result.injectedPrompt.indexOf('- Mem C');

			// Alphabetical: Errors before Testing
			expect(errorsIdx).toBeLessThan(testingIdx);
			// C under Errors header, before Testing header
			expect(memCIdx).toBeGreaterThan(errorsIdx);
			expect(memCIdx).toBeLessThan(testingIdx);
			// A and B under Testing header
			expect(memAIdx).toBeGreaterThan(testingIdx);
			expect(memBIdx).toBeGreaterThan(testingIdx);
		});

		it('tracks persona contributions correctly', async () => {
			const results = [
				makeResult({ entry: { content: 'A' }, personaName: 'Rust Dev', skillAreaName: 'S' }),
				makeResult({ entry: { content: 'B' }, personaName: 'Rust Dev', skillAreaName: 'S' }),
				makeResult({ entry: { content: 'C' }, personaName: 'Python Dev', skillAreaName: 'S' }),
				makeResult({ entry: { content: 'D', scope: 'global' }, personaName: undefined }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.personaContributions).toHaveLength(2);
			const rustContrib = result.personaContributions.find((p) => p.personaName === 'Rust Dev');
			const pythonContrib = result.personaContributions.find((p) => p.personaName === 'Python Dev');
			expect(rustContrib!.count).toBe(2);
			expect(pythonContrib!.count).toBe(1);
		});

		it('tracks flatScopeCounts for project and global', async () => {
			const results = [
				makeResult({ entry: { content: 'P1', scope: 'project' }, personaName: undefined }),
				makeResult({ entry: { content: 'P2', scope: 'project' }, personaName: undefined }),
				makeResult({ entry: { content: 'G1', scope: 'global' }, personaName: undefined }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.flatScopeCounts.project).toBe(2);
			expect(result.flatScopeCounts.global).toBe(1);
		});

		it('records injection per scope group via store.recordInjection', async () => {
			const skillId1 = 'skill-aaa';
			const skillId2 = 'skill-bbb';
			const results = [
				makeResult({
					entry: { content: 'S1', scope: 'skill', skillAreaId: skillId1 },
					personaName: 'P',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'S2', scope: 'skill', skillAreaId: skillId1 },
					personaName: 'P',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'S3', scope: 'skill', skillAreaId: skillId2 },
					personaName: 'P',
					skillAreaName: 'S2',
				}),
				makeResult({ entry: { content: 'G1', scope: 'global' }, personaName: undefined }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			await injectMemories('prompt', '/project', 'claude-code');

			// Should call recordInjection for each scope group:
			// skill:skill-aaa, skill:skill-bbb, global
			expect(mockRecordInjection).toHaveBeenCalledTimes(3);

			// Verify scope groupings in scopeGroups result
			// (checked indirectly via recordInjection calls)
			const calls = mockRecordInjection.mock.calls;

			// One call for skill-aaa with 2 IDs
			const skillACall = calls.find((c) => c[2] === skillId1);
			expect(skillACall).toBeDefined();
			expect(skillACall![0]).toHaveLength(2); // 2 memories
			expect(skillACall![1]).toBe('skill');

			// One call for skill-bbb with 1 ID
			const skillBCall = calls.find((c) => c[2] === skillId2);
			expect(skillBCall).toBeDefined();
			expect(skillBCall![0]).toHaveLength(1);

			// One call for global
			const globalCall = calls.find((c) => c[1] === 'global');
			expect(globalCall).toBeDefined();
			expect(globalCall![0]).toHaveLength(1);
		});

		it('scopeGroups includes projectPath for project-scoped groups', async () => {
			const results = [
				makeResult({ entry: { content: 'proj mem', scope: 'project' }, personaName: undefined }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await injectMemories('prompt', '/my/project', 'claude-code');

			const projGroup = result.scopeGroups.find((g) => g.scope === 'project');
			expect(projGroup).toBeDefined();
			expect(projGroup!.projectPath).toBe('/my/project');
		});
	});

	// ─── 5. tryInjectMemories ───────────────────────────────────────────

	describe('tryInjectMemories: catches errors, returns safe default', () => {
		it('returns original prompt when injectMemories throws', async () => {
			mockCascadingSearch.mockRejectedValue(new Error('Search failed'));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await tryInjectMemories('safe prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('safe prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
			expect(result.personaContributions).toEqual([]);
			expect(result.flatScopeCounts).toEqual({ project: 0, global: 0 });
			expect(result.scopeGroups).toEqual([]);

			// Should log warning
			expect(warnSpy).toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it('returns original prompt when recordInjection throws', async () => {
			const results = [
				makeResult({ entry: { content: 'A' }, personaName: 'P', skillAreaName: 'S' }),
			];
			mockCascadingSearch.mockResolvedValue(results);
			mockRecordInjection.mockRejectedValue(new Error('Write failed'));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await tryInjectMemories('safe prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('safe prompt');
			expect(result.injectedIds).toEqual([]);

			warnSpy.mockRestore();
		});

		it('succeeds when no error occurs (delegates to injectMemories)', async () => {
			const results = [
				makeResult({ entry: { content: 'Memory' }, personaName: 'P', skillAreaName: 'S' }),
			];
			mockCascadingSearch.mockResolvedValue(results);

			const result = await tryInjectMemories('prompt', '/project', 'claude-code');

			// Should have injected successfully
			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('prompt');
			expect(result.injectedIds).toHaveLength(1);
		});
	});

	// ─── 6. Session Injection Tracking ──────────────────────────────────

	describe('Session injection tracking: record, get, clear', () => {
		it('recordSessionInjection stores and getSessionInjection retrieves ids', () => {
			const ids = ['mem-1', 'mem-2', 'mem-3'];
			recordSessionInjection('session-abc', ids);

			const retrieved = getSessionInjection('session-abc');
			expect(retrieved).toEqual(ids);
		});

		it('getSessionInjection returns undefined for unknown session', () => {
			expect(getSessionInjection('unknown-session')).toBeUndefined();
		});

		it('getInjectionRecord returns full record with scopeGroups', () => {
			const ids = ['mem-1', 'mem-2'];
			const scopeGroups = [
				{ scope: 'skill' as const, skillAreaId: 'skill-1', ids: ['mem-1'] },
				{ scope: 'global' as const, ids: ['mem-2'] },
			];
			recordSessionInjection('session-xyz', ids, scopeGroups);

			const record = getInjectionRecord('session-xyz');
			expect(record).toBeDefined();
			expect(record!.ids).toEqual(ids);
			expect(record!.scopeGroups).toEqual(scopeGroups);
		});

		it('getInjectionRecord returns undefined for unknown session', () => {
			expect(getInjectionRecord('nonexistent')).toBeUndefined();
		});

		it('recordSessionInjection with no scopeGroups defaults to empty array', () => {
			recordSessionInjection('session-no-groups', ['mem-1']);

			const record = getInjectionRecord('session-no-groups');
			expect(record!.scopeGroups).toEqual([]);
		});

		it('clearSessionInjection removes the record', () => {
			recordSessionInjection('session-clear', ['mem-1']);
			expect(getSessionInjection('session-clear')).toBeDefined();

			clearSessionInjection('session-clear');
			expect(getSessionInjection('session-clear')).toBeUndefined();
			expect(getInjectionRecord('session-clear')).toBeUndefined();
		});

		it('clearSessionInjection is no-op for unknown session', () => {
			// Should not throw
			expect(() => clearSessionInjection('nonexistent')).not.toThrow();
		});

		it('multiple sessions tracked independently', () => {
			recordSessionInjection('s1', ['mem-a']);
			recordSessionInjection('s2', ['mem-b', 'mem-c']);

			expect(getSessionInjection('s1')).toEqual(['mem-a']);
			expect(getSessionInjection('s2')).toEqual(['mem-b', 'mem-c']);

			clearSessionInjection('s1');
			expect(getSessionInjection('s1')).toBeUndefined();
			expect(getSessionInjection('s2')).toEqual(['mem-b', 'mem-c']);
		});

		it('overwriting a session replaces the previous record', () => {
			recordSessionInjection('session-ow', ['old-mem']);
			recordSessionInjection('session-ow', ['new-mem-1', 'new-mem-2']);

			expect(getSessionInjection('session-ow')).toEqual(['new-mem-1', 'new-mem-2']);
		});
	});

	// ─── 7. Query Truncation ────────────────────────────────────────────

	describe('Query truncation: prompt sliced to 2000 chars for search', () => {
		it('passes truncated prompt to cascadingSearch', async () => {
			const longPrompt = 'A'.repeat(5000);
			mockCascadingSearch.mockResolvedValue([]);

			await injectMemories(longPrompt, '/project', 'claude-code');

			expect(mockCascadingSearch).toHaveBeenCalledTimes(1);
			const queryArg = mockCascadingSearch.mock.calls[0][0];
			expect(queryArg).toHaveLength(2000);
		});

		it('passes full prompt if shorter than 2000 chars', async () => {
			const shortPrompt = 'short query';
			mockCascadingSearch.mockResolvedValue([]);

			await injectMemories(shortPrompt, '/project', 'claude-code');

			const queryArg = mockCascadingSearch.mock.calls[0][0];
			expect(queryArg).toBe('short query');
		});
	});
});
