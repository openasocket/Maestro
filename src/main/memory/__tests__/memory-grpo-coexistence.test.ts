/**
 * GRPO coexistence tests — verify that the Memory system and GRPO system
 * can inject independently into the same prompt without interference.
 *
 * Pipeline: original prompt → GRPO injects <project-experiences> → Memory injects <agent-memories>
 * Both systems prepend their XML blocks to the prompt with separate token budgets.
 *
 * Test scenarios:
 *   1. Both enabled → prompt has <project-experiences> AND <agent-memories>
 *   2. Memory disabled → only GRPO (prompt returned unchanged by memory injector)
 *   3. Both disabled → untouched prompt
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

/** Simulate GRPO injection — wraps prompt with <project-experiences> XML. */
function simulateGrpoInjection(prompt: string, experiences: string[]): string {
	const lines = experiences.map((e) => `- ${e}`).join('\n');
	return `<project-experiences>\n${lines}\n</project-experiences>\n\n${prompt}`;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GRPO Coexistence — Memory + GRPO injection independence', () => {
	beforeEach(() => {
		nextId = 0;
		mockCascadingSearch.mockReset();
		mockRecordInjection.mockReset();
		mockRecordInjection.mockResolvedValue(undefined);
	});

	afterEach(() => {
		setMemorySettingsStore(() => undefined);
	});

	// ─── Both Enabled ────────────────────────────────────────────────

	describe('Both enabled: prompt has <project-experiences> AND <agent-memories>', () => {
		it('memory injection preserves existing GRPO <project-experiences> block', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const originalPrompt = 'Write a Rust CLI tool';
			const grpoPrompt = simulateGrpoInjection(originalPrompt, [
				'Prefer clap for argument parsing',
				'Use anyhow for error handling',
			]);

			const memoryResults = [
				makeResult({
					entry: { content: 'Always use Result<T, E> in Rust' },
					personaName: 'Rust Dev',
					skillAreaName: 'Error Handling',
				}),
			];
			mockCascadingSearch.mockResolvedValue(memoryResults);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// Both XML blocks present
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).toContain('</project-experiences>');
			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('</agent-memories>');

			// Original prompt content preserved
			expect(result.injectedPrompt).toContain('Write a Rust CLI tool');

			// GRPO content preserved
			expect(result.injectedPrompt).toContain('Prefer clap for argument parsing');
			expect(result.injectedPrompt).toContain('Use anyhow for error handling');

			// Memory content injected
			expect(result.injectedPrompt).toContain('Always use Result<T, E> in Rust');
			expect(result.injectedPrompt).toContain('[Rust Dev > Error Handling]');
		});

		it('agent-memories block appears before project-experiences block (prepend order)', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const grpoPrompt = simulateGrpoInjection('Build a web server', ['Use axum framework']);

			mockCascadingSearch.mockResolvedValue([
				makeResult({
					entry: { content: 'Prefer async/await patterns' },
					personaName: 'Backend Dev',
					skillAreaName: 'Async',
				}),
			]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			const memoriesIdx = result.injectedPrompt.indexOf('<agent-memories>');
			const experiencesIdx = result.injectedPrompt.indexOf('<project-experiences>');

			// Memory injector prepends, so <agent-memories> comes first
			expect(memoriesIdx).toBeLessThan(experiencesIdx);
		});

		it('both systems contribute to a prompt with multiple persona groups', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const grpoPrompt = simulateGrpoInjection('Optimize database queries', [
				'Use prepared statements for repeated queries',
				'Consider connection pooling',
			]);

			mockCascadingSearch.mockResolvedValue([
				makeResult({
					entry: { content: 'Use indexes on frequently queried columns' },
					personaName: 'DB Admin',
					skillAreaName: 'Query Optimization',
				}),
				makeResult({
					entry: { content: 'Always EXPLAIN before optimizing', scope: 'global' },
					personaName: undefined,
				}),
			]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// Memory groups present
			expect(result.injectedPrompt).toContain('[DB Admin > Query Optimization]');
			expect(result.injectedPrompt).toContain('[global]');
			expect(result.injectedPrompt).toContain('Use indexes on frequently queried columns');
			expect(result.injectedPrompt).toContain('Always EXPLAIN before optimizing');

			// GRPO content intact
			expect(result.injectedPrompt).toContain('Use prepared statements for repeated queries');
			expect(result.injectedPrompt).toContain('Consider connection pooling');

			// Both tags present
			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('<project-experiences>');

			// Metadata correct
			expect(result.injectedIds).toHaveLength(2);
			expect(result.personaContributions).toHaveLength(1);
			expect(result.personaContributions[0].personaName).toBe('DB Admin');
			expect(result.flatScopeCounts.global).toBe(1);
		});

		it('token budgets are independent — memory respects its own budget regardless of GRPO size', async () => {
			setMemorySettingsStore(() => ({ enabled: true, maxTokenBudget: 500 }));
			// Available memory budget = 500 - 150 overhead = 350

			// Simulate a large GRPO block (this doesn't count against memory budget)
			const largeGrpoContent = Array.from({ length: 50 }, (_, i) => `Experience ${i}`);
			const grpoPrompt = simulateGrpoInjection('prompt', largeGrpoContent);

			mockCascadingSearch.mockResolvedValue([
				makeResult({
					entry: { content: 'Fits in budget', tokenEstimate: 200 },
					personaName: 'Dev',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { content: 'Also fits', tokenEstimate: 100 },
					personaName: 'Dev',
					skillAreaName: 'S',
				}),
				makeResult({
					entry: { content: 'Over budget', tokenEstimate: 200 },
					personaName: 'Dev',
					skillAreaName: 'S',
				}),
			]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// Memory injector should select based on its own budget (350 tokens)
			// 200 + 100 = 300 fits, adding 200 more = 500 > 350
			expect(result.injectedIds).toHaveLength(2);

			// GRPO content still present in full
			expect(result.injectedPrompt).toContain('Experience 0');
			expect(result.injectedPrompt).toContain('Experience 49');
		});

		it('tryInjectMemories preserves GRPO content on memory error', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const grpoPrompt = simulateGrpoInjection('fix bug', ['Check error logs first']);
			mockCascadingSearch.mockRejectedValue(new Error('Search failed'));

			const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await tryInjectMemories(grpoPrompt, '/project', 'claude-code');

			// GRPO content preserved unchanged
			expect(result.injectedPrompt).toBe(grpoPrompt);
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).toContain('Check error logs first');
			expect(result.injectedIds).toEqual([]);

			warnSpy.mockRestore();
		});
	});

	// ─── Memory Disabled ─────────────────────────────────────────────

	describe('Memory disabled: only GRPO content in prompt', () => {
		it('returns GRPO-enriched prompt unchanged when memory is disabled', async () => {
			setMemorySettingsStore(() => ({ enabled: false }));

			const grpoPrompt = simulateGrpoInjection('implement feature', [
				'Follow existing patterns',
				'Add tests',
			]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// Prompt returned exactly as-is
			expect(result.injectedPrompt).toBe(grpoPrompt);

			// GRPO content present
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).toContain('</project-experiences>');
			expect(result.injectedPrompt).toContain('Follow existing patterns');
			expect(result.injectedPrompt).toContain('Add tests');

			// No memory injection artifacts
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
			expect(result.injectedPrompt).not.toContain('</agent-memories>');

			// Empty metadata
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
			expect(result.personaContributions).toEqual([]);
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});

		it('returns GRPO-enriched prompt unchanged when settings getter returns undefined', async () => {
			// MEMORY_CONFIG_DEFAULTS has enabled: false
			setMemorySettingsStore(() => undefined);

			const grpoPrompt = simulateGrpoInjection('debug issue', ['Check stack traces']);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			expect(result.injectedPrompt).toBe(grpoPrompt);
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});

		it('returns GRPO-enriched prompt unchanged when memory has no results', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const grpoPrompt = simulateGrpoInjection('refactor code', ['Use small functions']);
			mockCascadingSearch.mockResolvedValue([]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// No memories found, so prompt returned as-is (with GRPO content)
			expect(result.injectedPrompt).toBe(grpoPrompt);
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
		});
	});

	// ─── Both Disabled ───────────────────────────────────────────────

	describe('Both disabled: prompt returned completely untouched', () => {
		it('plain prompt returned unchanged when memory is disabled and no GRPO present', async () => {
			setMemorySettingsStore(() => ({ enabled: false }));

			const originalPrompt = 'Write a hello world program';

			const result = await injectMemories(originalPrompt, '/project', 'claude-code');

			expect(result.injectedPrompt).toBe(originalPrompt);
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
			expect(result.injectedPrompt).not.toContain('<project-experiences>');
			expect(result.injectedIds).toEqual([]);
			expect(result.tokenCount).toBe(0);
			expect(mockCascadingSearch).not.toHaveBeenCalled();
		});

		it('plain prompt returned unchanged when settings undefined and no GRPO', async () => {
			setMemorySettingsStore(() => undefined);

			const originalPrompt = 'simple task';

			const result = await injectMemories(originalPrompt, '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('simple task');
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
			expect(result.injectedPrompt).not.toContain('<project-experiences>');
		});

		it('tryInjectMemories also returns untouched prompt when both disabled', async () => {
			setMemorySettingsStore(() => ({ enabled: false }));

			const result = await tryInjectMemories('raw prompt', '/project', 'claude-code');

			expect(result.injectedPrompt).toBe('raw prompt');
			expect(result.injectedPrompt).not.toContain('<agent-memories>');
			expect(result.injectedPrompt).not.toContain('<project-experiences>');
			expect(result.injectedIds).toEqual([]);
		});
	});

	// ─── Edge Cases ──────────────────────────────────────────────────

	describe('Edge cases: malformed GRPO, empty experiences, double injection', () => {
		it('handles GRPO block with empty experiences gracefully', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const emptyGrpoPrompt = '<project-experiences>\n</project-experiences>\n\nprompt text';

			mockCascadingSearch.mockResolvedValue([
				makeResult({
					entry: { content: 'Memory content' },
					personaName: 'Dev',
					skillAreaName: 'Skill',
				}),
			]);

			const result = await injectMemories(emptyGrpoPrompt, '/project', 'claude-code');

			expect(result.injectedPrompt).toContain('<agent-memories>');
			expect(result.injectedPrompt).toContain('<project-experiences>');
			expect(result.injectedPrompt).toContain('Memory content');
			expect(result.injectedPrompt).toContain('prompt text');
		});

		it('preserves multi-line GRPO content with special characters', async () => {
			setMemorySettingsStore(() => ({ enabled: true }));

			const grpoPrompt = simulateGrpoInjection('code review', [
				'Check for SQL injection via $1 placeholders',
				'Verify <script> tags are escaped',
				'Ensure Result<T, E> patterns used',
			]);

			mockCascadingSearch.mockResolvedValue([
				makeResult({
					entry: { content: 'Always sanitize inputs' },
					personaName: 'Security',
					skillAreaName: 'Input Validation',
				}),
			]);

			const result = await injectMemories(grpoPrompt, '/project', 'claude-code');

			// GRPO content with special chars preserved
			expect(result.injectedPrompt).toContain('SQL injection via $1 placeholders');
			expect(result.injectedPrompt).toContain('<script> tags are escaped');
			expect(result.injectedPrompt).toContain('Result<T, E> patterns used');

			// Memory also injected
			expect(result.injectedPrompt).toContain('Always sanitize inputs');
			expect(result.injectedPrompt).toContain('[Security > Input Validation]');
		});
	});
});
