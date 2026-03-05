/**
 * Tests for MemoryInjector — disabled system bypass, token budgeting,
 * XML formatting with persona/skill grouping, tryInjectMemories error
 * handling, and session injection tracking.
 *
 * Mocks the memory store's cascadingSearch and recordInjection methods
 * so we test only the injector logic, not the search pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MemorySearchResult, MemoryEntry } from '../../../shared/memory-types';

// ─── Mock store ──────────────────────────────────────────────────────────────

const mockCascadingSearch = vi.fn<(...args: any[]) => Promise<MemorySearchResult[]>>();
const mockRecordInjection = vi.fn<(...args: any[]) => Promise<void>>();
const mockHybridSearch = vi.fn<(...args: any[]) => Promise<MemorySearchResult[]>>();
const mockSearchFlatScope = vi.fn<(...args: any[]) => Promise<MemorySearchResult[]>>();
const mockGenerateProjectDigest = vi.fn<(...args: any[]) => Promise<string | null>>();
const mockSelectMatchingPersonas = vi.fn<(...args: any[]) => Promise<any[]>>();

vi.mock('../../memory/memory-store', () => ({
	getMemoryStore: () => ({
		cascadingSearch: (...args: any[]) => mockCascadingSearch(...args),
		recordInjection: (...args: any[]) => mockRecordInjection(...args),
		hybridSearch: (...args: any[]) => mockHybridSearch(...args),
		searchFlatScope: (...args: any[]) => mockSearchFlatScope(...args),
		generateProjectDigest: (...args: any[]) => mockGenerateProjectDigest(...args),
		selectMatchingPersonas: (...args: any[]) => mockSelectMatchingPersonas(...args),
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
	pushPersonaShiftEvent,
	getRecentPersonaShifts,
	hashContent,
	generateDiffInjection,
	getLastSessionInjection,
	applyPreviousSessionBoost,
} from '../../memory/memory-injector';
import type { PersonaShiftEvent, InjectionRecord } from '../../memory/memory-injector';

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
		effectivenessDelta: 0,
		effectivenessUpdatedAt: 0,
		useCount: 0,
		lastUsedAt: 0,
		active: true,
		archived: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as MemoryEntry;
}

/** Create a fake MemorySearchResult. */
function makeResult(
	overrides: Omit<Partial<MemorySearchResult>, 'entry'> & { entry?: Partial<MemoryEntry> } = {}
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

/**
 * Helper: set up mock stores for the budget-first flow.
 * cascadingSearch returns all results (skill scope filtered in injector).
 * hybridSearch returns scope-filtered results for project/global.
 */
function setupMockResults(results: MemorySearchResult[]): void {
	// cascadingSearch returns all results — injector filters to skill/persona
	mockCascadingSearch.mockResolvedValue(results);
	// hybridSearch called for project and global scopes individually
	mockHybridSearch.mockImplementation(async (_query: string, scope: string) => {
		return results.filter((r) => r.entry.scope === scope && !r.personaName);
	});
}

describe('MemoryInjector', () => {
	beforeEach(() => {
		nextId = 0;
		mockCascadingSearch.mockReset();
		mockRecordInjection.mockReset();
		mockHybridSearch.mockReset();
		mockSearchFlatScope.mockReset();
		mockGenerateProjectDigest.mockReset();
		mockSelectMatchingPersonas.mockReset();
		mockRecordInjection.mockResolvedValue(undefined);
		// Default: searches return empty (tests that need results set these)
		mockCascadingSearch.mockResolvedValue([]);
		mockHybridSearch.mockResolvedValue([]);
		mockSearchFlatScope.mockResolvedValue([]);
		mockGenerateProjectDigest.mockResolvedValue(null);
		mockSelectMatchingPersonas.mockResolvedValue([]);
		// Set settings getter to return enabled config with balanced strategy for budget tests
		setMemorySettingsStore(() => ({ enabled: true, injectionStrategy: 'balanced' }));
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

		it('uses defaults when settings getter returns undefined', async () => {
			// MEMORY_CONFIG_DEFAULTS has enabled: true — cascadingSearch will be called
			setMemorySettingsStore(() => undefined);

			await injectMemories('Prompt text', '/project', 'claude-code');

			expect(mockCascadingSearch).toHaveBeenCalled();
		});

		it('returns original prompt when no memories found', async () => {
			setupMockResults([]);

			const result = await injectMemories('My prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('My prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
		});
	});

	// ─── 2. Token Budget ────────────────────────────────────────────────

	describe('Token budget: per-scope budget-first allocation', () => {
		it('selects skill memories within the skill scope budget', async () => {
			// Budget: 1500 total, 1350 usable, skill = 675
			const results = [
				makeResult({
					entry: { content: 'A'.repeat(2000), tokenEstimate: 300 },
					combinedScore: 0.9,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'B'.repeat(2000), tokenEstimate: 300 },
					combinedScore: 0.8,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
				makeResult({
					entry: { content: 'C'.repeat(2000), tokenEstimate: 300 },
					combinedScore: 0.7,
					personaName: 'P1',
					skillAreaName: 'S1',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// Skill budget = 675: first two fit (300+300=600), third would be 900 → skipped
			expect(result.injectedIds).toHaveLength(2);
			expect(result.injectedIds).toContain(results[0].entry.id);
			expect(result.injectedIds).toContain(results[1].entry.id);
			expect(result.injectedIds).not.toContain(results[2].entry.id);
		});

		it('skips large entries but includes smaller ones after', async () => {
			// Greedy: skip items that don't fit, continue to next
			// Skill budget = 675
			const results = [
				makeResult({
					entry: { tokenEstimate: 200 },
					combinedScore: 0.95,
					personaName: 'P',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { tokenEstimate: 600 },
					combinedScore: 0.9,
					personaName: 'P',
					skillAreaName: 'S',
				}), // too big after first (200+600=800 > 675)
				makeResult({
					entry: { tokenEstimate: 300 },
					combinedScore: 0.85,
					personaName: 'P',
					skillAreaName: 'S',
				}), // fits after first (200+300=500 ≤ 675)
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedIds).toHaveLength(2);
			expect(result.injectedIds).toContain(results[0].entry.id);
			expect(result.injectedIds).not.toContain(results[1].entry.id);
			expect(result.injectedIds).toContain(results[2].entry.id);
		});

		it('respects custom maxTokenBudget from settings', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 500 }));
			// Usable = 500 - 150 = 350, skill budget = 175

			const results = [
				makeResult({
					entry: { tokenEstimate: 100 },
					combinedScore: 0.9,
					personaName: 'P',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { tokenEstimate: 100 },
					combinedScore: 0.8,
					personaName: 'P',
					skillAreaName: 'S',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// skill budget = 175: 100 fits, second 100 would be 200 > 175 → skipped
			expect(result.injectedIds).toHaveLength(1);
		});

		it('tokenCount includes overhead', async () => {
			const results = [
				makeResult({ entry: { tokenEstimate: 100 }, personaName: 'P', skillAreaName: 'S' }),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// tokenCount = totalTokens (100) + WRAPPER_OVERHEAD_TOKENS (150)
			expect(result.tokenCount).toBe(250);
		});

		it('scopes cannot starve each other — each fills independently', async () => {
			// Skill budget = 675, project budget = 405, global budget = 270
			const skillMem = makeResult({
				entry: { tokenEstimate: 600 },
				personaName: 'P',
				skillAreaName: 'S',
			});
			const projectMem = makeResult({
				entry: { content: 'Project mem', scope: 'project', tokenEstimate: 300 },
				personaName: undefined,
			});
			const globalMem = makeResult({
				entry: { content: 'Global mem', scope: 'global', tokenEstimate: 200 },
				personaName: undefined,
			});

			setupMockResults([skillMem, projectMem, globalMem]);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// All three should be selected since each fits within its scope budget
			expect(result.injectedIds).toContain(skillMem.entry.id);
			expect(result.injectedIds).toContain(projectMem.entry.id);
			expect(result.injectedIds).toContain(globalMem.entry.id);
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
			setupMockResults(results);

			const result = await injectMemories('my prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('</agent-memories>');
			expect(result.injectedPrompt).toContain('The following knowledge is relevant to this task.');
			expect(result.injectedPrompt).toContain('- RULE: Use Result<T,E> for errors');
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
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[Rust Dev > Error Handling]');
			expect(result.injectedPrompt).toContain('- RULE: Memory 1');
			expect(result.injectedPrompt).toContain('- RULE: Memory 2');
		});

		it('uses [PersonaName] header when no skill area name', async () => {
			const results = [
				makeResult({
					entry: { content: 'Persona-level memory' },
					personaName: 'Rust Dev',
					skillAreaName: undefined,
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[Rust Dev]');
			expect(result.injectedPrompt).toContain('- RULE: Persona-level memory');
		});

		it('uses [project] header for project-scoped memories', async () => {
			const results = [
				makeResult({
					entry: { content: 'Project memory', scope: 'project' },
					personaName: undefined,
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[project]');
			expect(result.injectedPrompt).toContain('- RULE: Project memory');
		});

		it('uses [global] header for global-scoped memories', async () => {
			const results = [
				makeResult({
					entry: { content: 'Global memory', scope: 'global' },
					personaName: undefined,
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('[global]');
			expect(result.injectedPrompt).toContain('- RULE: Global memory');
		});

		it('formats experiences as observations and rules as directives in adaptive mode', async () => {
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
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('- OBSERVATION: In past work, Learned from session');
			expect(result.injectedPrompt).toContain('- RULE: Standard rule');
			// Rule should NOT have OBSERVATION prefix
			expect(result.injectedPrompt).not.toContain('OBSERVATION: In past work, Standard rule');
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
			setupMockResults(results);

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
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// Should have two groups: [Dev > Errors] and [Dev > Testing]
			expect(result.injectedPrompt).toContain('[Dev > Testing]');
			expect(result.injectedPrompt).toContain('[Dev > Errors]');

			const errorsIdx = result.injectedPrompt.indexOf('[Dev > Errors]');
			const testingIdx = result.injectedPrompt.indexOf('[Dev > Testing]');
			const memAIdx = result.injectedPrompt.indexOf('- RULE: Mem A');
			const memBIdx = result.injectedPrompt.indexOf('- RULE: Mem B');
			const memCIdx = result.injectedPrompt.indexOf('- RULE: Mem C');

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
			setupMockResults(results);

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
			setupMockResults(results);

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
			setupMockResults(results);

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
			setupMockResults(results);

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

		it('succeeds even when recordInjection throws (fire-and-forget)', async () => {
			const results = [
				makeResult({ entry: { content: 'A' }, personaName: 'P', skillAreaName: 'S' }),
			];
			setupMockResults(results);
			mockRecordInjection.mockRejectedValue(new Error('Write failed'));

			const result = await tryInjectMemories('safe prompt', '/project', 'claude-code');

			// recordInjection is fire-and-forget, so injection should succeed
			expect(result.injectedPrompt).toContain('safe prompt');
			expect(result.injectedPrompt).toContain('<agent-memories>');
		});

		it('succeeds when no error occurs (delegates to injectMemories)', async () => {
			const results = [
				makeResult({ entry: { content: 'Memory' }, personaName: 'P', skillAreaName: 'S' }),
			];
			setupMockResults(results);

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
			setupMockResults([]);

			await injectMemories(longPrompt, '/project', 'claude-code');

			expect(mockCascadingSearch).toHaveBeenCalledTimes(1);
			const queryArg = mockCascadingSearch.mock.calls[0][0];
			expect(queryArg).toHaveLength(2000);
		});

		it('passes full prompt if shorter than 2000 chars', async () => {
			const shortPrompt = 'short query';
			setupMockResults([]);

			await injectMemories(shortPrompt, '/project', 'claude-code');

			const queryArg = mockCascadingSearch.mock.calls[0][0];
			expect(queryArg).toBe('short query');
		});
	});

	// ─── Persona Shift Ring Buffer ──────────────────────────────────────────

	describe('Persona Shift Ring Buffer', () => {
		function makeShiftEvent(overrides?: Partial<PersonaShiftEvent>): PersonaShiftEvent {
			return {
				timestamp: Date.now(),
				sessionId: 'test-session',
				fromPersona: { id: 'p1', name: 'React Frontend', score: 0.7 },
				toPersona: { id: 'p2', name: 'API Design', score: 0.85 },
				triggerContext: 'discussing endpoint structure',
				...overrides,
			};
		}

		it('stores and retrieves persona shift events', () => {
			const event = makeShiftEvent();
			pushPersonaShiftEvent(event);

			const shifts = getRecentPersonaShifts();
			expect(shifts.length).toBeGreaterThanOrEqual(1);
			const last = shifts[0];
			expect(last.sessionId).toBe('test-session');
			expect(last.fromPersona.name).toBe('React Frontend');
			expect(last.toPersona.name).toBe('API Design');
		});

		it('returns events newest first', () => {
			const event1 = makeShiftEvent({ timestamp: 1000, sessionId: 'sess-1' });
			const event2 = makeShiftEvent({ timestamp: 2000, sessionId: 'sess-2' });
			pushPersonaShiftEvent(event1);
			pushPersonaShiftEvent(event2);

			const shifts = getRecentPersonaShifts();
			// Find our two events (there may be others from prior tests)
			const sess1Idx = shifts.findIndex((s) => s.sessionId === 'sess-1');
			const sess2Idx = shifts.findIndex((s) => s.sessionId === 'sess-2');
			expect(sess2Idx).toBeLessThan(sess1Idx); // newer first
		});

		it('respects limit parameter', () => {
			for (let i = 0; i < 5; i++) {
				pushPersonaShiftEvent(makeShiftEvent({ timestamp: 3000 + i }));
			}
			const shifts = getRecentPersonaShifts(2);
			expect(shifts.length).toBe(2);
		});
	});

	// ─── 7. Diff-Based Injection (MEM-EVOLVE-02) ─────────────────────

	describe('Diff-based injection', () => {
		describe('hashContent', () => {
			it('produces consistent hashes for same content', () => {
				expect(hashContent('hello world')).toBe(hashContent('hello world'));
			});

			it('produces different hashes for different content', () => {
				expect(hashContent('hello')).not.toBe(hashContent('world'));
			});

			it('returns a base-36 string', () => {
				const hash = hashContent('test');
				expect(hash).toMatch(/^[0-9a-z]+$/);
			});
		});

		describe('recordSessionInjection with content hashes', () => {
			it('stores content hashes from search results', () => {
				const results = [
					makeResult({ entry: { id: 'mem-100', content: 'Alpha' } }),
					makeResult({ entry: { id: 'mem-101', content: 'Beta' } }),
				];
				recordSessionInjection('sess-hash-1', ['mem-100', 'mem-101'], [], results);

				const record = getInjectionRecord('sess-hash-1');
				expect(record).toBeDefined();
				expect(record!.contentHashes.size).toBe(2);
				expect(record!.contentHashes.get('mem-100')).toBe(hashContent('Alpha'));
				expect(record!.contentHashes.get('mem-101')).toBe(hashContent('Beta'));
				expect(record!.lastInjectedAt).toBeGreaterThan(0);
				expect(record!.totalTokensSaved).toBe(0);

				clearSessionInjection('sess-hash-1');
			});

			it('accepts precomputed hashes', () => {
				const precomputed = new Map([
					['mem-200', 'abc'],
					['mem-201', 'def'],
				]);
				recordSessionInjection('sess-hash-2', ['mem-200', 'mem-201'], [], undefined, precomputed);

				const record = getInjectionRecord('sess-hash-2');
				expect(record!.contentHashes.get('mem-200')).toBe('abc');
				expect(record!.contentHashes.get('mem-201')).toBe('def');

				clearSessionInjection('sess-hash-2');
			});
		});

		describe('recordSessionInjection with injection events (MEM-EVOLVE-04)', () => {
			it('stores trigger and turnIndex as injection event', () => {
				recordSessionInjection(
					'sess-evt-1',
					['mem-1', 'mem-2'],
					[],
					undefined,
					undefined,
					'spawn',
					0
				);
				const record = getInjectionRecord('sess-evt-1');
				expect(record!.injectionEvents).toHaveLength(1);
				expect(record!.injectionEvents[0].trigger).toBe('spawn');
				expect(record!.injectionEvents[0].turnIndex).toBe(0);
				expect(record!.injectionEvents[0].memoryIds).toEqual(['mem-1', 'mem-2']);
				expect(record!.injectionEvents[0].injectedAt).toBeGreaterThan(0);
				clearSessionInjection('sess-evt-1');
			});

			it('defaults trigger to spawn and turnIndex to 0', () => {
				recordSessionInjection('sess-evt-2', ['mem-1']);
				const record = getInjectionRecord('sess-evt-2');
				expect(record!.injectionEvents).toHaveLength(1);
				expect(record!.injectionEvents[0].trigger).toBe('spawn');
				expect(record!.injectionEvents[0].turnIndex).toBe(0);
				clearSessionInjection('sess-evt-2');
			});

			it('accumulates injection events across multiple calls', () => {
				recordSessionInjection('sess-evt-3', ['mem-1'], [], undefined, undefined, 'spawn', 0);
				recordSessionInjection(
					'sess-evt-3',
					['mem-1', 'mem-2'],
					[],
					undefined,
					undefined,
					'checkpoint',
					5
				);
				recordSessionInjection(
					'sess-evt-3',
					['mem-1', 'mem-3'],
					[],
					undefined,
					undefined,
					'live',
					8
				);

				const record = getInjectionRecord('sess-evt-3');
				expect(record!.injectionEvents).toHaveLength(3);
				expect(record!.injectionEvents[0].trigger).toBe('spawn');
				expect(record!.injectionEvents[0].turnIndex).toBe(0);
				expect(record!.injectionEvents[1].trigger).toBe('checkpoint');
				expect(record!.injectionEvents[1].turnIndex).toBe(5);
				expect(record!.injectionEvents[2].trigger).toBe('live');
				expect(record!.injectionEvents[2].turnIndex).toBe(8);
				clearSessionInjection('sess-evt-3');
			});

			it('preserves previous events when overwriting IDs', () => {
				recordSessionInjection('sess-evt-4', ['old-mem'], [], undefined, undefined, 'spawn', 0);
				recordSessionInjection(
					'sess-evt-4',
					['new-mem'],
					[],
					undefined,
					undefined,
					'checkpoint',
					3
				);

				const record = getInjectionRecord('sess-evt-4');
				// IDs are overwritten
				expect(record!.ids).toEqual(['new-mem']);
				// But events accumulate
				expect(record!.injectionEvents).toHaveLength(2);
				expect(record!.injectionEvents[0].memoryIds).toEqual(['old-mem']);
				expect(record!.injectionEvents[1].memoryIds).toEqual(['new-mem']);
				clearSessionInjection('sess-evt-4');
			});
		});

		describe('generateDiffInjection', () => {
			function makePrevRecord(ids: string[], contents: string[]): InjectionRecord {
				const contentHashes = new Map<string, string>();
				for (let i = 0; i < ids.length; i++) {
					contentHashes.set(ids[i], hashContent(contents[i]));
				}
				return {
					ids,
					scopeGroups: [],
					contentHashes,
					lastInjectedAt: Date.now(),
					totalTokensSaved: 0,
					injectionEvents: [],
				};
			}

			it('detects added memories', () => {
				const prev = makePrevRecord(['mem-1'], ['content A']);
				const newResults = [
					makeResult({ entry: { id: 'mem-1', content: 'content A' } }),
					makeResult({
						entry: { id: 'mem-2', content: 'content B' },
						personaName: 'P1',
						skillAreaName: 'S1',
					}),
				];

				const diff = generateDiffInjection(newResults, prev);

				expect(diff.addedIds).toEqual(['mem-2']);
				expect(diff.removedIds).toEqual([]);
				expect(diff.modifiedIds).toEqual([]);
				expect(diff.unchangedCount).toBe(1);
				expect(diff.injectedPrompt).toContain('<added>');
				expect(diff.injectedPrompt).toContain('<agent-memory-update>');
				expect(diff.tokenCount).toBeGreaterThan(0);
			});

			it('detects removed memories', () => {
				const prev = makePrevRecord(['mem-1', 'mem-2'], ['content A', 'content B']);
				const newResults = [makeResult({ entry: { id: 'mem-1', content: 'content A' } })];

				const diff = generateDiffInjection(newResults, prev);

				expect(diff.addedIds).toEqual([]);
				expect(diff.removedIds).toEqual(['mem-2']);
				expect(diff.modifiedIds).toEqual([]);
				expect(diff.unchangedCount).toBe(1);
				expect(diff.injectedPrompt).toContain('<removed>');
			});

			it('detects modified memories', () => {
				const prev = makePrevRecord(['mem-1'], ['original content']);
				const newResults = [
					makeResult({
						entry: { id: 'mem-1', content: 'updated content' },
						personaName: 'P1',
						skillAreaName: 'S1',
					}),
				];

				const diff = generateDiffInjection(newResults, prev);

				expect(diff.addedIds).toEqual([]);
				expect(diff.removedIds).toEqual([]);
				expect(diff.modifiedIds).toEqual(['mem-1']);
				expect(diff.unchangedCount).toBe(0);
				expect(diff.injectedPrompt).toContain('<modified>');
			});

			it('returns empty prompt when nothing changed', () => {
				const prev = makePrevRecord(['mem-1', 'mem-2'], ['content A', 'content B']);
				const newResults = [
					makeResult({ entry: { id: 'mem-1', content: 'content A' } }),
					makeResult({ entry: { id: 'mem-2', content: 'content B' } }),
				];

				const diff = generateDiffInjection(newResults, prev);

				expect(diff.injectedPrompt).toBe('');
				expect(diff.addedIds).toEqual([]);
				expect(diff.removedIds).toEqual([]);
				expect(diff.modifiedIds).toEqual([]);
				expect(diff.unchangedCount).toBe(2);
				expect(diff.tokenCount).toBe(0);
			});

			it('handles mixed add/remove/modify', () => {
				const prev = makePrevRecord(
					['mem-1', 'mem-2', 'mem-3'],
					['keep', 'old-modify', 'to-remove']
				);
				const newResults = [
					makeResult({ entry: { id: 'mem-1', content: 'keep' } }),
					makeResult({
						entry: { id: 'mem-2', content: 'new-modify' },
						personaName: 'P1',
						skillAreaName: 'S1',
					}),
					makeResult({
						entry: { id: 'mem-4', content: 'brand new' },
						personaName: 'P2',
						skillAreaName: 'S2',
					}),
				];

				const diff = generateDiffInjection(newResults, prev);

				expect(diff.addedIds).toEqual(['mem-4']);
				expect(diff.removedIds).toEqual(['mem-3']);
				expect(diff.modifiedIds).toEqual(['mem-2']);
				expect(diff.unchangedCount).toBe(1);
				expect(diff.injectedPrompt).toContain('<added>');
				expect(diff.injectedPrompt).toContain('<removed>');
				expect(diff.injectedPrompt).toContain('<modified>');
				expect(diff.injectedPrompt).toContain('1 memories unchanged');
			});
		});
	});

	// ─── 9. Injection Tone ──────────────────────────────────────────────

	describe('Injection Tone', () => {
		it('prescriptive mode: all memories formatted as RULE directives', async () => {
			setMemorySettingsStore(() => ({
				enabled: true,
				injectionStrategy: 'balanced',
				injectionTone: 'prescriptive',
			}));

			const results = [
				makeResult({
					entry: { content: 'Use error boundaries', type: 'rule' },
					personaName: 'Dev',
					skillAreaName: 'React',
				}),
				makeResult({
					entry: { content: 'Hooks prevent cascade failures', type: 'experience' },
					personaName: 'Dev',
					skillAreaName: 'React',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('- RULE: Use error boundaries');
			expect(result.injectedPrompt).toContain('- RULE: Hooks prevent cascade failures');
			expect(result.injectedPrompt).toContain('Follow these directives:');
			expect(result.injectedPrompt).not.toContain('OBSERVATION');
		});

		it('observational mode: all memories formatted as OBSERVATION', async () => {
			setMemorySettingsStore(() => ({
				enabled: true,
				injectionStrategy: 'balanced',
				injectionTone: 'observational',
			}));

			const results = [
				makeResult({
					entry: { content: 'Use error boundaries', type: 'rule' },
					personaName: 'Dev',
					skillAreaName: 'React',
				}),
				makeResult({
					entry: { content: 'Hooks prevent failures', type: 'experience' },
					personaName: 'Dev',
					skillAreaName: 'React',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('- OBSERVATION: In past work, Use error boundaries');
			expect(result.injectedPrompt).toContain(
				'- OBSERVATION: In past work, Hooks prevent failures'
			);
			expect(result.injectedPrompt).toContain('Consider these patterns:');
			expect(result.injectedPrompt).not.toContain('- RULE:');
		});

		it('adaptive mode: rules are prescriptive, experiences are observational', async () => {
			setMemorySettingsStore(() => ({
				enabled: true,
				injectionStrategy: 'balanced',
				injectionTone: 'adaptive',
			}));

			const results = [
				makeResult({
					entry: { content: 'Always use TypeScript', type: 'rule' },
					personaName: 'Dev',
					skillAreaName: 'JS',
				}),
				makeResult({
					entry: { content: 'Found that strict mode helps', type: 'experience' },
					personaName: 'Dev',
					skillAreaName: 'JS',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('- RULE: Always use TypeScript');
			expect(result.injectedPrompt).toContain(
				'- OBSERVATION: In past work, Found that strict mode helps'
			);
			expect(result.injectedPrompt).toContain('RULES are directives to follow');
		});

		it('experience with structured context uses situation/learning in observational format', async () => {
			setMemorySettingsStore(() => ({
				enabled: true,
				injectionStrategy: 'balanced',
				injectionTone: 'adaptive',
			}));

			const results = [
				makeResult({
					entry: {
						content: 'Error boundaries matter',
						type: 'experience',
						experienceContext: {
							situation: 'refactoring the auth module',
							learning: 'error boundaries prevented cascade failures',
						},
					},
					personaName: 'Dev',
					skillAreaName: 'React',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain(
				'- OBSERVATION: In a previous session (refactoring the auth module), it was found that: error boundaries prevented cascade failures'
			);
		});

		it('per-entry toneOverride takes precedence over global tone', async () => {
			setMemorySettingsStore(() => ({
				enabled: true,
				injectionStrategy: 'balanced',
				injectionTone: 'adaptive',
			}));

			const results = [
				makeResult({
					entry: {
						content: 'Security rule: always sanitize inputs',
						type: 'experience',
						toneOverride: 'prescriptive',
					},
					personaName: 'Dev',
					skillAreaName: 'Security',
				}),
			];
			setupMockResults(results);

			const result = await injectMemories('prompt', '/project', 'claude-code');

			// Even though type is experience and mode is adaptive,
			// toneOverride forces prescriptive
			expect(result.injectedPrompt).toContain('- RULE: Security rule: always sanitize inputs');
			// Should not contain any OBSERVATION-formatted memory lines
			expect(result.injectedPrompt).not.toContain('- OBSERVATION:');
		});
	});

	// ─── Cross-Session Continuity (MEM-EVOLVE-07) ────────────────────────

	describe('getLastSessionInjection', () => {
		afterEach(() => {
			clearSessionInjection('prev-session-1');
			clearSessionInjection('prev-session-2');
			clearSessionInjection('current-session');
		});

		it('returns undefined when no previous sessions exist', () => {
			expect(getLastSessionInjection('/project')).toBeUndefined();
		});

		it('returns the most recent record for the same project', () => {
			// Record first session, then advance time for the second
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now - 10000);
			recordSessionInjection(
				'prev-session-1',
				['mem-a'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/project',
				'claude-code'
			);
			vi.spyOn(Date, 'now').mockReturnValue(now);
			recordSessionInjection(
				'prev-session-2',
				['mem-b', 'mem-c'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/project',
				'claude-code'
			);
			vi.restoreAllMocks();

			const result = getLastSessionInjection('/project');
			expect(result).toBeDefined();
			// prev-session-2 is more recent
			expect(result!.ids).toEqual(['mem-b', 'mem-c']);
		});

		it('excludes the current session', () => {
			recordSessionInjection(
				'current-session',
				['mem-current'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/project',
				'claude-code'
			);

			const result = getLastSessionInjection('/project', 'current-session');
			expect(result).toBeUndefined();
		});

		it('does not return records from a different project', () => {
			recordSessionInjection(
				'prev-session-1',
				['mem-a'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/other-project',
				'claude-code'
			);

			const result = getLastSessionInjection('/project');
			expect(result).toBeUndefined();
		});
	});

	describe('applyPreviousSessionBoost', () => {
		it('boosts combinedScore of memories that were in the previous session', () => {
			const results = [
				makeResult({ entry: { id: 'mem-a' }, combinedScore: 0.7 }),
				makeResult({ entry: { id: 'mem-b' }, combinedScore: 0.8 }),
				makeResult({ entry: { id: 'mem-c' }, combinedScore: 0.6 }),
			];

			const previousRecord: InjectionRecord = {
				ids: ['mem-a', 'mem-c'],
				scopeGroups: [],
				contentHashes: new Map(),
				lastInjectedAt: Date.now() - 60000,
				totalTokensSaved: 0,
				injectionEvents: [],
			};

			const boosted = applyPreviousSessionBoost(results, previousRecord);

			// mem-a: 0.7 + 0.15 = 0.85
			// mem-b: 0.8 (unchanged)
			// mem-c: 0.6 + 0.15 = 0.75
			const memA = boosted.find((r) => r.entry.id === 'mem-a')!;
			const memB = boosted.find((r) => r.entry.id === 'mem-b')!;
			const memC = boosted.find((r) => r.entry.id === 'mem-c')!;

			expect(memA.combinedScore).toBeCloseTo(0.85);
			expect(memB.combinedScore).toBeCloseTo(0.8);
			expect(memC.combinedScore).toBeCloseTo(0.75);
		});

		it('re-sorts results by boosted combinedScore', () => {
			const results = [
				makeResult({ entry: { id: 'mem-high' }, combinedScore: 0.9 }),
				makeResult({ entry: { id: 'mem-boosted' }, combinedScore: 0.8 }),
			];

			const previousRecord: InjectionRecord = {
				ids: ['mem-boosted'],
				scopeGroups: [],
				contentHashes: new Map(),
				lastInjectedAt: Date.now() - 60000,
				totalTokensSaved: 0,
				injectionEvents: [],
			};

			const boosted = applyPreviousSessionBoost(results, previousRecord);

			// mem-boosted: 0.8 + 0.15 = 0.95 > mem-high: 0.9
			expect(boosted[0].entry.id).toBe('mem-boosted');
			expect(boosted[1].entry.id).toBe('mem-high');
		});

		it('does not mutate original results', () => {
			const results = [makeResult({ entry: { id: 'mem-a' }, combinedScore: 0.7 })];

			const previousRecord: InjectionRecord = {
				ids: ['mem-a'],
				scopeGroups: [],
				contentHashes: new Map(),
				lastInjectedAt: Date.now() - 60000,
				totalTokensSaved: 0,
				injectionEvents: [],
			};

			applyPreviousSessionBoost(results, previousRecord);
			expect(results[0].combinedScore).toBe(0.7);
		});
	});

	describe('recordSessionInjection with project/agent metadata', () => {
		afterEach(() => {
			clearSessionInjection('sess-meta-1');
			clearSessionInjection('sess-meta-2');
		});

		it('stores projectPath and agentType', () => {
			recordSessionInjection(
				'sess-meta-1',
				['mem-1'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/my/project',
				'claude-code'
			);

			const record = getInjectionRecord('sess-meta-1');
			expect(record!.projectPath).toBe('/my/project');
			expect(record!.agentType).toBe('claude-code');
		});

		it('preserves projectPath from first call on subsequent calls', () => {
			recordSessionInjection(
				'sess-meta-2',
				['mem-1'],
				[],
				undefined,
				undefined,
				'spawn',
				0,
				'/my/project',
				'claude-code'
			);
			// Second call without projectPath (e.g., checkpoint injection)
			recordSessionInjection('sess-meta-2', ['mem-2']);

			const record = getInjectionRecord('sess-meta-2');
			expect(record!.projectPath).toBe('/my/project');
			expect(record!.agentType).toBe('claude-code');
		});
	});
});
