/**
 * Tests for the MemoryInjector — hierarchical retrieval and prompt formatting.
 *
 * Tests cover:
 * - Settings store pattern (setMemorySettingsStore / getConfig)
 * - Disabled system returns unchanged prompt with zero overhead
 * - XML output groups correctly by persona and skill
 * - Token budget is respected (greedy selection)
 * - Experience entries get (experience) prefix
 * - Project and global scope grouping
 * - tryInjectMemories defensive wrapper catches errors
 * - recordInjection is called with correct scope groupings
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MemorySearchResult, MemoryEntry } from '../../../shared/memory-types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock electron (required by memory-store)
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock electron-store (required by memory-store)
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

// Mock the memory store — we test the injector's formatting/budgeting logic,
// not the store's search implementation (that's tested in memory-store.test.ts).
const mockCascadingSearch = vi.fn<[], Promise<MemorySearchResult[]>>();
const mockRecordInjection = vi.fn<[], Promise<void>>();
const mockHybridSearch = vi.fn<[], Promise<MemorySearchResult[]>>();
const mockGenerateProjectDigest = vi.fn<[], Promise<string | null>>();

vi.mock('../../../main/memory/memory-store', () => ({
	getMemoryStore: () => ({
		cascadingSearch: mockCascadingSearch,
		recordInjection: mockRecordInjection,
		hybridSearch: mockHybridSearch,
		searchFlatScope: vi.fn().mockResolvedValue([]),
		generateProjectDigest: mockGenerateProjectDigest,
	}),
}));

import {
	setMemorySettingsStore,
	injectMemories,
	tryInjectMemories,
	recordSessionInjection,
	getSessionInjection,
	clearSessionInjection,
} from '../../../main/memory/memory-injector';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<MemoryEntry> & { content: string }): MemoryEntry {
	return {
		id: `mem-${Math.random().toString(36).slice(2, 8)}`,
		content: overrides.content,
		type: 'rule',
		scope: 'skill',
		tags: [],
		source: 'user',
		confidence: 1.0,
		pinned: false,
		active: true,
		embedding: null,
		effectivenessScore: 0.5,
		useCount: 0,
		tokenEstimate: Math.ceil(overrides.content.length / 4),
		lastUsedAt: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeSearchResult(
	entry: MemoryEntry,
	opts?: { personaName?: string; skillAreaName?: string; combinedScore?: number }
): MemorySearchResult {
	return {
		entry,
		similarity: 0.9,
		combinedScore: opts?.combinedScore ?? 0.8,
		personaName: opts?.personaName,
		skillAreaName: opts?.skillAreaName,
	};
}

/**
 * Helper: set up mock stores for the budget-first flow.
 * cascadingSearch returns all results; hybridSearch returns scope-filtered results.
 */
function setupMockResults(results: MemorySearchResult[]): void {
	mockCascadingSearch.mockResolvedValue(results);
	mockHybridSearch.mockImplementation(async (_query: string, scope: string) => {
		return results.filter((r) => r.entry.scope === scope && !r.personaName);
	});
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MemoryInjector', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordInjection.mockResolvedValue(undefined);
		mockGenerateProjectDigest.mockResolvedValue(null);
		setupMockResults([]);
	});

	// ─── Settings Store ─────────────────────────────────────────────────

	describe('setMemorySettingsStore', () => {
		it('uses overrides from settings getter', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 500 }));

			setupMockResults([]);

			const result = await injectMemories('test prompt', '/project', 'claude-code');
			// Even though no results, cascadingSearch should have been called
			// (because enabled=true)
			expect(mockCascadingSearch).toHaveBeenCalledTimes(1);

			// Reset
			setMemorySettingsStore(() => undefined);
		});

		it('falls back to defaults when getter returns undefined', async () => {
			setMemorySettingsStore(() => undefined);

			// Defaults have enabled=false
			const result = await injectMemories('test prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toBe('test prompt');
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});
	});

	// ─── Disabled System ────────────────────────────────────────────────

	describe('disabled system', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: false }));
		});

		it('returns unchanged prompt', async () => {
			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toBe('my prompt');
		});

		it('returns zero token count', async () => {
			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.tokenCount).toBe(0);
		});

		it('returns empty injected ids', async () => {
			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.injectedIds).toEqual([]);
		});

		it('returns empty persona contributions', async () => {
			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.personaContributions).toEqual([]);
		});

		it('returns zero flat scope counts', async () => {
			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.flatScopeCounts).toEqual({ project: 0, global: 0 });
		});

		it('does not call cascadingSearch', async () => {
			await injectMemories('my prompt', '/project', 'claude-code');
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});
	});

	// ─── XML Output Formatting ──────────────────────────────────────────

	describe('XML output formatting', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 5000 }));
		});

		it('groups memories by persona > skill', async () => {
			const entry1 = makeEntry({
				content: 'Use Result<T, E> for errors',
				scope: 'skill',
				skillAreaId: 'sk1',
			});
			const entry2 = makeEntry({
				content: 'Prefer iterators over loops',
				scope: 'skill',
				skillAreaId: 'sk2',
			});

			setupMockResults([
				makeSearchResult(entry1, { personaName: 'Rust Dev', skillAreaName: 'Error Handling' }),
				makeSearchResult(entry2, { personaName: 'Rust Dev', skillAreaName: 'Performance' }),
			]);

			const result = await injectMemories('How do I handle errors?', '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('</agent-memories>');
			expect(result.injectedPrompt).toContain('[Rust Dev > Error Handling]');
			expect(result.injectedPrompt).toContain('[Rust Dev > Performance]');
			expect(result.injectedPrompt).toContain('- Use Result<T, E> for errors');
			expect(result.injectedPrompt).toContain('- Prefer iterators over loops');
		});

		it('formats experience entries with (experience) prefix', async () => {
			const entry = makeEntry({
				content: 'Codex stalls without --skip-git-repo-check',
				type: 'experience',
				scope: 'skill',
				skillAreaId: 'sk1',
			});

			setupMockResults([
				makeSearchResult(entry, { personaName: 'DevOps', skillAreaName: 'CI/CD' }),
			]);

			const result = await injectMemories('batch mode', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('- (experience) Codex stalls without');
		});

		it('formats rule entries without prefix', async () => {
			const entry = makeEntry({
				content: 'Always write tests',
				type: 'rule',
				scope: 'global',
			});

			setupMockResults([makeSearchResult(entry)]);

			const result = await injectMemories('testing', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('- Always write tests');
			expect(result.injectedPrompt).not.toContain('(experience)');
		});

		it('groups project memories under [project]', async () => {
			const entry = makeEntry({ content: 'This repo uses tabs', scope: 'project' });

			setupMockResults([makeSearchResult(entry)]);

			const result = await injectMemories('format code', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('[project]');
			expect(result.injectedPrompt).toContain('- This repo uses tabs');
		});

		it('groups global memories under [global]', async () => {
			const entry = makeEntry({ content: 'Always write tests', scope: 'global' });

			setupMockResults([makeSearchResult(entry)]);

			const result = await injectMemories('testing', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('[global]');
		});

		it('orders groups: hierarchy first, then project, then global', async () => {
			const hierarchyEntry = makeEntry({
				content: 'hierarchy mem',
				scope: 'skill',
				skillAreaId: 'sk1',
			});
			const projectEntry = makeEntry({ content: 'project mem', scope: 'project' });
			const globalEntry = makeEntry({ content: 'global mem', scope: 'global' });

			setupMockResults([
				makeSearchResult(globalEntry, { combinedScore: 0.9 }),
				makeSearchResult(projectEntry, { combinedScore: 0.85 }),
				makeSearchResult(hierarchyEntry, {
					personaName: 'Dev',
					skillAreaName: 'Testing',
					combinedScore: 0.8,
				}),
			]);

			const result = await injectMemories('test', '/project', 'claude-code');

			const prompt = result.injectedPrompt;
			const hierarchyIdx = prompt.indexOf('[Dev > Testing]');
			const projectIdx = prompt.indexOf('[project]');
			const globalIdx = prompt.indexOf('[global]');

			expect(hierarchyIdx).toBeLessThan(projectIdx);
			expect(projectIdx).toBeLessThan(globalIdx);
		});

		it('prepends XML block to the original prompt', async () => {
			const entry = makeEntry({ content: 'A rule', scope: 'global' });
			setupMockResults([makeSearchResult(entry)]);

			const result = await injectMemories('my actual prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toMatch(/^<agent-memories>/);
			expect(result.injectedPrompt).toMatch(/my actual prompt$/);
		});

		it('includes header text in XML block', async () => {
			const entry = makeEntry({ content: 'A rule', scope: 'global' });
			setupMockResults([makeSearchResult(entry)]);

			const result = await injectMemories('prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('Relevant knowledge for this task:');
		});
	});

	// ─── Token Budget ───────────────────────────────────────────────────

	describe('token budget', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 1500 }));
		});

		it('respects per-scope token budget by skipping entries that exceed it', async () => {
			// Budget = 1500, usable = 1350, skill budget = 675
			const small = makeEntry({ content: 'Short rule', tokenEstimate: 300 });
			const large = makeEntry({ content: 'x'.repeat(600), tokenEstimate: 500 });
			const small2 = makeEntry({ content: 'Another rule', tokenEstimate: 300 });

			setupMockResults([
				makeSearchResult(small, { combinedScore: 0.9 }),
				makeSearchResult(large, { combinedScore: 0.85 }),
				makeSearchResult(small2, { combinedScore: 0.8 }),
			]);

			const result = await injectMemories('test', '/project', 'claude-code');

			// Skill budget = 675: small (300) fits, large (500) doesn't (300+500=800 > 675),
			// small2 (300) fits (300+300=600 ≤ 675)
			expect(result.injectedIds).toContain(small.id);
			expect(result.injectedIds).toContain(small2.id);
			expect(result.injectedIds).not.toContain(large.id);
		});

		it('returns unchanged prompt when no memories fit the budget', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 300 }));
			// Budget = 300, usable = 150, skill budget = 75
			const huge = makeEntry({ content: 'x'.repeat(800), tokenEstimate: 200 });

			setupMockResults([makeSearchResult(huge, { combinedScore: 0.9 })]);

			const result = await injectMemories('original prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toBe('original prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
		});
	});

	// ─── Persona Contributions ──────────────────────────────────────────

	describe('persona contributions', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 5000 }));
		});

		it('tracks persona contributions correctly', async () => {
			const e1 = makeEntry({ content: 'Rule 1', scope: 'skill' });
			const e2 = makeEntry({ content: 'Rule 2', scope: 'skill' });
			const e3 = makeEntry({ content: 'Rule 3', scope: 'skill' });

			setupMockResults([
				makeSearchResult(e1, { personaName: 'Rust Dev', skillAreaName: 'Errors' }),
				makeSearchResult(e2, { personaName: 'Rust Dev', skillAreaName: 'Testing' }),
				makeSearchResult(e3, { personaName: 'Python Dev', skillAreaName: 'API' }),
			]);

			const result = await injectMemories('test', '/project', 'claude-code');

			const rustContrib = result.personaContributions.find((c) => c.personaName === 'Rust Dev');
			const pyContrib = result.personaContributions.find((c) => c.personaName === 'Python Dev');

			expect(rustContrib).toBeDefined();
			expect(rustContrib!.count).toBe(2);
			expect(pyContrib).toBeDefined();
			expect(pyContrib!.count).toBe(1);
		});

		it('tracks flat scope counts', async () => {
			const proj1 = makeEntry({ content: 'Project A', scope: 'project' });
			const proj2 = makeEntry({ content: 'Project B', scope: 'project' });
			const glob = makeEntry({ content: 'Global', scope: 'global' });

			setupMockResults([makeSearchResult(proj1), makeSearchResult(proj2), makeSearchResult(glob)]);

			const result = await injectMemories('test', '/project', 'claude-code');
			expect(result.flatScopeCounts.project).toBe(2);
			expect(result.flatScopeCounts.global).toBe(1);
		});
	});

	// ─── Record Injection ───────────────────────────────────────────────

	describe('recordInjection', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 5000 }));
		});

		it('calls recordInjection grouped by scope', async () => {
			const skillEntry = makeEntry({
				content: 'Skill rule',
				scope: 'skill',
				skillAreaId: 'sk-1',
			});
			const globalEntry = makeEntry({ content: 'Global rule', scope: 'global' });

			setupMockResults([
				makeSearchResult(skillEntry, { personaName: 'Dev', skillAreaName: 'Errors' }),
				makeSearchResult(globalEntry),
			]);

			await injectMemories('test', '/project', 'claude-code');

			expect(mockRecordInjection).toHaveBeenCalledTimes(2);

			// Find the calls
			const calls = mockRecordInjection.mock.calls;

			// One call for skill scope
			const skillCall = calls.find((c) => c[1] === 'skill');
			expect(skillCall).toBeDefined();
			expect(skillCall![0]).toContain(skillEntry.id);
			expect(skillCall![2]).toBe('sk-1');

			// One call for global scope
			const globalCall = calls.find((c) => c[1] === 'global');
			expect(globalCall).toBeDefined();
			expect(globalCall![0]).toContain(globalEntry.id);
		});

		it('passes projectPath for project-scope recordInjection', async () => {
			const projEntry = makeEntry({ content: 'Proj rule', scope: 'project' });

			setupMockResults([makeSearchResult(projEntry)]);

			await injectMemories('test', '/my/project', 'claude-code');

			const projCall = mockRecordInjection.mock.calls.find((c) => c[1] === 'project');
			expect(projCall).toBeDefined();
			expect(projCall![3]).toBe('/my/project');
		});
	});

	// ─── tryInjectMemories Wrapper ──────────────────────────────────────

	describe('tryInjectMemories', () => {
		it('returns result from injectMemories on success', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 5000 }));

			const entry = makeEntry({ content: 'A rule', scope: 'global' });
			setupMockResults([makeSearchResult(entry)]);

			const result = await tryInjectMemories('my prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedIds).toHaveLength(1);
		});

		it('returns original prompt on error', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));
			mockCascadingSearch.mockRejectedValue(new Error('Embedding service unavailable'));

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await tryInjectMemories('original prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toBe('original prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
			expect(result.personaContributions).toEqual([]);
			expect(result.flatScopeCounts).toEqual({ project: 0, global: 0 });

			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('[MemoryInjector]'),
				expect.any(Error)
			);

			consoleSpy.mockRestore();
		});

		it('logs warning but does not throw on error', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));
			mockCascadingSearch.mockRejectedValue(new Error('Something broke'));

			const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			// Should not throw
			await expect(tryInjectMemories('prompt', '/project', 'claude-code')).resolves.toBeDefined();

			consoleSpy.mockRestore();
		});
	});

	// ─── No Results ─────────────────────────────────────────────────────

	describe('no results', () => {
		beforeEach(() => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 5000 }));
		});

		it('returns unchanged prompt when cascadingSearch returns empty', async () => {
			setupMockResults([]);

			const result = await injectMemories('my prompt', '/project', 'claude-code');
			expect(result.injectedPrompt).toBe('my prompt');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
		});

		it('does not call recordInjection when no memories selected', async () => {
			setupMockResults([]);

			await injectMemories('my prompt', '/project', 'claude-code');
			expect(mockRecordInjection).not.toHaveBeenCalled();
		});
	});

	// ─── Session Injection Tracking ─────────────────────────────────────

	describe('session injection tracking', () => {
		it('records and retrieves injected IDs for a session', () => {
			const ids = ['mem-1', 'mem-2', 'mem-3'];
			recordSessionInjection('session-abc', ids);
			expect(getSessionInjection('session-abc')).toEqual(ids);
		});

		it('returns undefined for unknown session', () => {
			expect(getSessionInjection('session-unknown')).toBeUndefined();
		});

		it('clears injection record for a session', () => {
			recordSessionInjection('session-xyz', ['mem-1']);
			clearSessionInjection('session-xyz');
			expect(getSessionInjection('session-xyz')).toBeUndefined();
		});

		it('overwrites previous record on re-injection', () => {
			recordSessionInjection('session-abc', ['mem-1']);
			recordSessionInjection('session-abc', ['mem-4', 'mem-5']);
			expect(getSessionInjection('session-abc')).toEqual(['mem-4', 'mem-5']);
		});
	});
});
