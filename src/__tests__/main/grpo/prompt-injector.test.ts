/**
 * Tests for the PromptInjector — experience library injection into agent prompts.
 *
 * Uses a real temp directory for the ExperienceStore (same pattern as experience-store.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock electron before importing modules
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock sentry
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { ExperienceStore } from '../../../main/grpo/experience-store';
import {
	injectExperiences,
	formatExperiencePrefix,
	computePriorityScore,
} from '../../../main/grpo/prompt-injector';
import type { ExperienceEntry, GRPOConfig } from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

let tmpDir: string;
let store: ExperienceStore;

const enabledConfig: GRPOConfig = {
	...GRPO_CONFIG_DEFAULTS,
	enabled: true,
};

const disabledConfig: GRPOConfig = {
	...GRPO_CONFIG_DEFAULTS,
	enabled: false,
};

function makeEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
	return {
		id: overrides.id ?? 'test-id-' + Math.random().toString(36).slice(2),
		content: overrides.content ?? 'Test experience content',
		category: overrides.category ?? 'testing',
		scope: overrides.scope ?? 'project',
		agentType: overrides.agentType ?? 'claude-code',
		createdAt: overrides.createdAt ?? Date.now(),
		updatedAt: overrides.updatedAt ?? Date.now(),
		evidenceCount: overrides.evidenceCount ?? 1,
		useCount: overrides.useCount ?? 0,
		lastRolloutGroupId: overrides.lastRolloutGroupId ?? null,
		tokenEstimate: overrides.tokenEstimate ?? 10,
	};
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-injector-test-'));
	store = new ExperienceStore(tmpDir);
	await store.initialize();
});

afterEach(async () => {
	// Allow fire-and-forget writes (incrementUseCount) to settle
	await new Promise(resolve => setTimeout(resolve, 50));
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('injectExperiences', () => {
	it('should return prompt unchanged when GRPO is disabled', async () => {
		const prompt = 'Hello, world!';
		const result = await injectExperiences(prompt, '/project/a', 'claude-code', store, disabledConfig);

		expect(result.injectedPrompt).toBe(prompt);
		expect(result.injectedIds).toHaveLength(0);
		expect(result.tokenCount).toBe(0);
	});

	it('should return prompt unchanged when library is empty', async () => {
		const prompt = 'Hello, world!';
		const result = await injectExperiences(prompt, '/project/a', 'claude-code', store, enabledConfig);

		expect(result.injectedPrompt).toBe(prompt);
		expect(result.injectedIds).toHaveLength(0);
		expect(result.tokenCount).toBe(0);
	});

	it('should inject a single experience with correct formatting', async () => {
		await store.addExperience('/project/a', {
			content: 'Always run vitest before committing',
			category: 'testing',
			scope: 'project',
			agentType: 'claude-code',
			evidenceCount: 1,
			lastRolloutGroupId: null,
		});

		const prompt = 'Fix the broken test';
		const result = await injectExperiences(prompt, '/project/a', 'claude-code', store, enabledConfig);

		expect(result.injectedPrompt).toContain('<project-experiences>');
		expect(result.injectedPrompt).toContain('</project-experiences>');
		expect(result.injectedPrompt).toContain('[testing] Always run vitest before committing');
		expect(result.injectedPrompt).toContain('The following insights have been learned');
		expect(result.injectedPrompt.endsWith(prompt)).toBe(true);
		expect(result.injectedIds).toHaveLength(1);
		expect(result.tokenCount).toBeGreaterThan(0);
	});

	it('should respect token budget — only fit entries within limit', async () => {
		// Each entry has tokenEstimate ~10 via the store's estimateTokens (content.length / 4)
		// We'll set a very low injection budget
		const tightConfig: GRPOConfig = {
			...enabledConfig,
			// 200 for wrapper + only ~30 for content = only 1-2 short entries
			maxInjectionTokens: 230,
		};

		// Add 10 entries with varying content lengths
		for (let i = 0; i < 10; i++) {
			await store.addExperience('/project/a', {
				content: `Experience entry number ${i} with some padding to increase token count a bit more`,
				category: 'testing',
				scope: 'project',
				agentType: 'claude-code',
				evidenceCount: 10, // high evidence to ensure they'd all be selected if no budget
				lastRolloutGroupId: null,
			});
		}

		const result = await injectExperiences('Do the task', '/project/a', 'claude-code', store, tightConfig);

		// Should have injected some but not all 10
		expect(result.injectedIds.length).toBeGreaterThan(0);
		expect(result.injectedIds.length).toBeLessThan(10);
	});

	it('should filter by agent type — entries for codex not injected into claude-code', async () => {
		await store.addExperience('/project/a', {
			content: 'This is for Codex only',
			category: 'tooling',
			scope: 'project',
			agentType: 'codex',
			evidenceCount: 5,
			lastRolloutGroupId: null,
		});

		const result = await injectExperiences('Do the task', '/project/a', 'claude-code', store, enabledConfig);

		expect(result.injectedPrompt).toBe('Do the task');
		expect(result.injectedIds).toHaveLength(0);
	});

	it('should include universal entries (agentType: all)', async () => {
		await store.addExperience('/project/a', {
			content: 'Universal insight for all agents',
			category: 'architecture',
			scope: 'project',
			agentType: 'all',
			evidenceCount: 3,
			lastRolloutGroupId: null,
		});

		const result = await injectExperiences('Do the task', '/project/a', 'claude-code', store, enabledConfig);

		expect(result.injectedIds).toHaveLength(1);
		expect(result.injectedPrompt).toContain('Universal insight for all agents');
	});

	it('should prioritize high-evidence entries over low-evidence', async () => {
		const tightConfig: GRPOConfig = {
			...enabledConfig,
			maxInjectionTokens: 260, // only room for ~1 entry after wrapper overhead
		};

		await store.addExperience('/project/a', {
			content: 'Low evidence entry',
			category: 'testing',
			scope: 'project',
			agentType: 'claude-code',
			evidenceCount: 1,
			lastRolloutGroupId: null,
		});

		await store.addExperience('/project/a', {
			content: 'High evidence entry',
			category: 'testing',
			scope: 'project',
			agentType: 'claude-code',
			evidenceCount: 20,
			lastRolloutGroupId: null,
		});

		const result = await injectExperiences('Do the task', '/project/a', 'claude-code', store, tightConfig);

		// Should pick the high-evidence one
		expect(result.injectedPrompt).toContain('High evidence entry');
		// If budget only allows one, the low-evidence should be excluded
		if (result.injectedIds.length === 1) {
			expect(result.injectedPrompt).not.toContain('Low evidence entry');
		}
	});

	it('should increment use counts for injected entries', async () => {
		const entry = await store.addExperience('/project/a', {
			content: 'Track this usage',
			category: 'testing',
			scope: 'project',
			agentType: 'claude-code',
			evidenceCount: 1,
			lastRolloutGroupId: null,
		});
		expect(entry.useCount).toBe(0);

		await injectExperiences('Do something', '/project/a', 'claude-code', store, enabledConfig);

		// Wait a tick for the fire-and-forget incrementUseCount to complete
		await new Promise(resolve => setTimeout(resolve, 50));

		const library = await store.getLibrary('/project/a');
		expect(library[0].useCount).toBe(1);
	});
});

describe('formatExperiencePrefix', () => {
	it('should return empty string for empty entries', () => {
		expect(formatExperiencePrefix([])).toBe('');
	});

	it('should wrap entries in <project-experiences> tags', () => {
		const entries = [makeEntry({ content: 'Test insight', category: 'testing' })];
		const result = formatExperiencePrefix(entries);

		expect(result).toContain('<project-experiences>');
		expect(result).toContain('</project-experiences>');
	});

	it('should include preamble text', () => {
		const entries = [makeEntry({ content: 'Test insight', category: 'testing' })];
		const result = formatExperiencePrefix(entries);

		expect(result).toContain('The following insights have been learned from previous work on this project.');
	});

	it('should prefix each entry with [category]', () => {
		const entries = [
			makeEntry({ content: 'Use vitest', category: 'testing' }),
			makeEntry({ content: 'Check tsconfig', category: 'debugging' }),
		];
		const result = formatExperiencePrefix(entries);

		expect(result).toContain('[testing] Use vitest');
		expect(result).toContain('[debugging] Check tsconfig');
	});

	it('should sort entries by category', () => {
		const entries = [
			makeEntry({ content: 'Z entry', category: 'testing' }),
			makeEntry({ content: 'A entry', category: 'architecture' }),
			makeEntry({ content: 'M entry', category: 'debugging' }),
		];
		const result = formatExperiencePrefix(entries);

		const archIdx = result.indexOf('[architecture]');
		const debugIdx = result.indexOf('[debugging]');
		const testIdx = result.indexOf('[testing]');

		expect(archIdx).toBeLessThan(debugIdx);
		expect(debugIdx).toBeLessThan(testIdx);
	});

	it('should end with blank line before the prompt', () => {
		const entries = [makeEntry({ content: 'Test insight', category: 'testing' })];
		const result = formatExperiencePrefix(entries);

		// Should end with </project-experiences>\n\n
		expect(result).toMatch(/\n\n$/);
	});
});

describe('computePriorityScore', () => {
	it('should return a value in [0, 1] range', () => {
		const entry = makeEntry({ evidenceCount: 5, useCount: 10, updatedAt: Date.now() });
		const score = computePriorityScore(entry, Date.now());

		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it('should return 0 for entry with zero evidence, zero use, and max age', () => {
		const maxAge = 7 * 24 * 60 * 60 * 1000;
		const entry = makeEntry({
			evidenceCount: 0,
			useCount: 0,
			updatedAt: Date.now() - maxAge * 2, // well past max age
		});
		const score = computePriorityScore(entry, Date.now());

		expect(score).toBe(0);
	});

	it('should return 1 for entry with max evidence, max use, and just updated', () => {
		const now = Date.now();
		const entry = makeEntry({
			evidenceCount: 20,
			useCount: 50,
			updatedAt: now,
		});
		const score = computePriorityScore(entry, now);

		expect(score).toBeCloseTo(1.0, 2);
	});

	it('should cap evidence and use at normalization limits', () => {
		const now = Date.now();
		const entry = makeEntry({
			evidenceCount: 100, // way over cap of 20
			useCount: 200, // way over cap of 50
			updatedAt: now,
		});
		const score = computePriorityScore(entry, now);

		// Should not exceed 1.0 even with values over caps
		expect(score).toBeLessThanOrEqual(1.0);
		expect(score).toBeCloseTo(1.0, 2);
	});

	it('should produce reasonable difference between recent and old entries (not 1000x)', () => {
		const now = Date.now();

		const recentEntry = makeEntry({
			evidenceCount: 5,
			useCount: 5,
			updatedAt: now - 1000, // 1 second ago
		});

		const oldEntry = makeEntry({
			evidenceCount: 5,
			useCount: 5,
			updatedAt: now - 24 * 60 * 60 * 1000, // 1 day ago
		});

		const recentScore = computePriorityScore(recentEntry, now);
		const oldScore = computePriorityScore(oldEntry, now);

		// Both should be positive
		expect(recentScore).toBeGreaterThan(0);
		expect(oldScore).toBeGreaterThan(0);

		// Recent should be higher than old
		expect(recentScore).toBeGreaterThan(oldScore);

		// But the ratio should be reasonable (not 1000x as the old un-normalized formula would produce)
		const ratio = recentScore / oldScore;
		expect(ratio).toBeLessThan(5); // reasonable difference, not orders of magnitude
	});

	it('should weight evidence at 40%, use at 30%, recency at 30%', () => {
		const now = Date.now();

		// Entry with only evidence (max), no use, old
		const maxAge = 7 * 24 * 60 * 60 * 1000;
		const evidenceOnly = makeEntry({
			evidenceCount: 20,
			useCount: 0,
			updatedAt: now - maxAge * 2,
		});

		const evidenceScore = computePriorityScore(evidenceOnly, now);
		// Should be ~0.4 (40% * 1.0 + 30% * 0.0 + 30% * 0.0)
		expect(evidenceScore).toBeCloseTo(0.4, 2);

		// Entry with only use count (max), no evidence, old
		const useOnly = makeEntry({
			evidenceCount: 0,
			useCount: 50,
			updatedAt: now - maxAge * 2,
		});

		const useScore = computePriorityScore(useOnly, now);
		// Should be ~0.3 (40% * 0.0 + 30% * 1.0 + 30% * 0.0)
		expect(useScore).toBeCloseTo(0.3, 2);

		// Entry with only recency (just now), no evidence or use
		const recencyOnly = makeEntry({
			evidenceCount: 0,
			useCount: 0,
			updatedAt: now,
		});

		const recencyScore = computePriorityScore(recencyOnly, now);
		// Should be ~0.3 (40% * 0.0 + 30% * 0.0 + 30% * 1.0)
		expect(recencyScore).toBeCloseTo(0.3, 2);
	});

	it('should normalize recency to [0, 1] — never negative', () => {
		const now = Date.now();
		const veryOldEntry = makeEntry({
			evidenceCount: 0,
			useCount: 0,
			updatedAt: now - 365 * 24 * 60 * 60 * 1000, // 1 year ago
		});

		const score = computePriorityScore(veryOldEntry, now);
		expect(score).toBeGreaterThanOrEqual(0);
	});
});
