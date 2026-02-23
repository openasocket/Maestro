/**
 * Tests for ExperienceAnalyzer — LLM-powered session experience extraction.
 *
 * Tests cover:
 * - Interface contracts (ExperienceAnalyzerInput, ExtractedExperience)
 * - Session data gathering with graceful degradation
 * - Prompt compilation from input data
 * - LLM output parsing (valid JSON, malformed, empty)
 * - Rate limiting (per-project cooldown)
 * - Experience storage with deduplication
 * - Singleton pattern
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Track file system state
const fsState = new Map<string, string>();

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async (filePath: string) => {
		const content = fsState.get(filePath);
		if (content === undefined) {
			const err = new Error(
				`ENOENT: no such file or directory, open '${filePath}'`
			) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		return content;
	}),
	writeFile: vi.fn(async (filePath: string, content: string) => {
		fsState.set(filePath, content);
	}),
	rename: vi.fn(async (from: string, to: string) => {
		const content = fsState.get(from);
		if (content !== undefined) {
			fsState.set(to, content);
			fsState.delete(from);
		}
	}),
	mkdir: vi.fn(async () => {}),
	appendFile: vi.fn(async (filePath: string, content: string) => {
		const existing = fsState.get(filePath) ?? '';
		fsState.set(filePath, existing + content);
	}),
}));

// Mock embedding service — default: throw (unavailable)
const mockEncode = vi.fn(async () => {
	throw new Error('Embedding model is not available');
});
const mockEncodeBatch = vi.fn(async () => {
	throw new Error('Embedding model is not available');
});

function realCosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

vi.mock('../../../main/grpo/embedding-service', () => ({
	encode: (...args: unknown[]) => mockEncode(...args),
	encodeBatch: (...args: unknown[]) => mockEncodeBatch(...args),
	cosineSimilarity: realCosineSimilarity,
	VECTOR_DIM: 384,
}));

// Mock child_process (used by analyzeSession and gatherSessionData for git)
const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
	execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock util.promisify to return our mockExecFile
vi.mock('util', () => ({
	promisify: () => mockExecFile,
}));

// Mock HistoryManager
const mockGetEntries = vi.fn(() => []);
vi.mock('../../../main/history-manager', () => ({
	getHistoryManager: () => ({
		getEntries: mockGetEntries,
	}),
}));

// Mock Stats DB
const mockGetQueryEvents = vi.fn(() => []);
vi.mock('../../../main/stats', () => ({
	getStatsDB: () => ({
		getQueryEvents: mockGetQueryEvents,
	}),
}));

// Mock logger (used by logDebug in analyzeSession error path)
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import {
	ExperienceAnalyzer,
	getExperienceAnalyzer,
	initializeExperienceAnalyzer,
	resetExperienceAnalyzer,
	EXPERIENCE_CATEGORIES,
	type ExperienceAnalyzerInput,
	type ExtractedExperience,
	type ExperienceCategory,
} from '../../../main/memory/experience-analyzer';

// ─── Tests ───────────────────────────────────────────────────────────────────

// Config path used by memory-store (mocked app.getPath returns /mock/userData)
const configPath = '/mock/userData/memories/config.json';

describe('ExperienceAnalyzer', () => {
	let analyzer: ExperienceAnalyzer;

	beforeEach(() => {
		fsState.clear();
		analyzer = new ExperienceAnalyzer();
		mockEncode.mockReset();
		mockEncodeBatch.mockReset();
		mockExecFile.mockReset();
		mockGetEntries.mockReset();
		mockGetQueryEvents.mockReset();
		mockEncode.mockRejectedValue(new Error('Embedding model is not available'));
		mockEncodeBatch.mockRejectedValue(new Error('Embedding model is not available'));
		mockGetEntries.mockReturnValue([]);
		mockGetQueryEvents.mockReturnValue([]);
		// Production default is enableExperienceExtraction: false — enable for tests
		fsState.set(configPath, JSON.stringify({ enableExperienceExtraction: true }));
	});

	// ─── Interface Contracts ─────────────────────────────────────────────

	describe('interface contracts', () => {
		it('ExperienceAnalyzerInput has all required fields', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [{ summary: 'did something' }],
			};
			expect(input.sessionId).toBe('sess-1');
			expect(input.agentType).toBe('claude-code');
			expect(input.projectPath).toBe('/test/project');
			expect(input.historyEntries).toHaveLength(1);
		});

		it('ExperienceAnalyzerInput supports optional fields', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-2',
				agentType: 'codex',
				projectPath: '/test',
				historyEntries: [],
				gitDiff: 'diff --git a/foo',
				vibesManifest: [{ type: 'command', content: 'npm test' }],
				vibesAnnotations: [{ filePath: 'src/foo.ts', action: 'modified' }],
				sessionCostUsd: 0.05,
				sessionDurationMs: 30000,
			};
			expect(input.gitDiff).toBeDefined();
			expect(input.vibesManifest).toHaveLength(1);
			expect(input.vibesAnnotations).toHaveLength(1);
			expect(input.sessionCostUsd).toBe(0.05);
			expect(input.sessionDurationMs).toBe(30000);
		});

		it('ExtractedExperience has all required fields', () => {
			const exp: ExtractedExperience = {
				content: 'Always check imports',
				situation: 'Circular import broke build',
				learning: 'Extract shared types to separate file',
				category: 'problem-solved',
				tags: ['imports', 'typescript'],
				noveltyScore: 0.8,
			};
			expect(exp.content).toBe('Always check imports');
			expect(exp.category).toBe('problem-solved');
			expect(exp.noveltyScore).toBe(0.8);
		});

		it('ExperienceCategory covers all valid values', () => {
			expect(EXPERIENCE_CATEGORIES).toEqual([
				'pattern-established',
				'problem-solved',
				'dependency-discovered',
				'anti-pattern-identified',
				'decision-made',
			]);
		});

		it('ExperienceContext supports decision provenance fields', async () => {
			const { ExperienceContext } = (await import('../../../shared/memory-types')) as {
				ExperienceContext: never;
			};
			// Type-level test: verify provenance fields are accepted on ExperienceContext
			const ctx: import('../../../shared/memory-types').ExperienceContext = {
				situation: 'Chose REST over GraphQL for API',
				learning: 'REST is simpler when clients are known',
				alternativesConsidered: 'GraphQL, gRPC',
				rationale: 'All clients are internal, schema is simple',
				provenanceSource: 'vibes',
			};
			expect(ctx.alternativesConsidered).toBe('GraphQL, gRPC');
			expect(ctx.rationale).toBe('All clients are internal, schema is simple');
			expect(ctx.provenanceSource).toBe('vibes');
		});

		it('ExperienceContext provenanceSource accepts all valid values', () => {
			const sources: import('../../../shared/memory-types').ExperienceContext['provenanceSource'][] =
				['vibes', 'history', 'inferred', undefined];
			expect(sources).toHaveLength(4);
		});

		it('ExperienceContext provenance fields are optional', () => {
			// Verify that ExperienceContext without provenance fields compiles
			const ctx: import('../../../shared/memory-types').ExperienceContext = {
				situation: 'Basic context without provenance',
				learning: 'Works without provenance fields',
			};
			expect(ctx.alternativesConsidered).toBeUndefined();
			expect(ctx.rationale).toBeUndefined();
			expect(ctx.provenanceSource).toBeUndefined();
		});

		it('ExperienceContext supports deviation tracking fields', () => {
			const ctx: import('../../../shared/memory-types').ExperienceContext = {
				situation: 'Build failed, retried with different approach',
				learning: 'Check compiler flags before switching toolchains',
				isDeviation: true,
				deviationType: 'error-fix',
				attemptCount: 3,
			};
			expect(ctx.isDeviation).toBe(true);
			expect(ctx.deviationType).toBe('error-fix');
			expect(ctx.attemptCount).toBe(3);
		});

		it('ExperienceContext deviationType accepts all valid values', () => {
			const types: import('../../../shared/memory-types').ExperienceContext['deviationType'][] = [
				'error-fix',
				'backtrack',
				'retry',
				'approach-change',
				undefined,
			];
			expect(types).toHaveLength(5);
		});

		it('ExperienceContext deviation fields are optional', () => {
			const ctx: import('../../../shared/memory-types').ExperienceContext = {
				situation: 'Normal context without deviation',
				learning: 'Works without deviation fields',
			};
			expect(ctx.isDeviation).toBeUndefined();
			expect(ctx.deviationType).toBeUndefined();
			expect(ctx.attemptCount).toBeUndefined();
		});

		it('MemoryConfig supports extractionModel field', async () => {
			const { MEMORY_CONFIG_DEFAULTS } = await import('../../../shared/memory-types');
			const config: import('../../../shared/memory-types').MemoryConfig = {
				...MEMORY_CONFIG_DEFAULTS,
				extractionModel: 'claude-sonnet-4-5-20250514',
			};
			expect(config.extractionModel).toBe('claude-sonnet-4-5-20250514');
		});

		it('MemoryConfig extractionModel defaults to undefined', async () => {
			const { MEMORY_CONFIG_DEFAULTS } = await import('../../../shared/memory-types');
			expect(MEMORY_CONFIG_DEFAULTS.extractionModel).toBeUndefined();
		});

		it('MemoryConfig enableExperienceExtraction defaults to false', async () => {
			const { MEMORY_CONFIG_DEFAULTS } = await import('../../../shared/memory-types');
			expect(MEMORY_CONFIG_DEFAULTS.enableExperienceExtraction).toBe(false);
		});
	});

	// ─── Prompt Compilation ──────────────────────────────────────────────

	describe('compilePrompt', () => {
		it('compiles prompt with all fields populated', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
				historyEntries: [
					{ summary: 'Fixed bug in auth', success: true, elapsedTimeMs: 5000 },
					{ summary: 'Tests failed', success: false, elapsedTimeMs: 2000 },
				],
				gitDiff: 'src/auth.ts | 5 +-',
				vibesManifest: [{ type: 'command', content: 'npm test' }],
				vibesAnnotations: [{ filePath: 'src/auth.ts', action: 'modified', lineRange: '10-20' }],
				sessionCostUsd: 0.05,
				sessionDurationMs: 60000,
			};

			const prompt = analyzer.compilePrompt(input);

			expect(prompt).toContain('claude-code');
			expect(prompt).toContain('/home/user/project');
			expect(prompt).toContain('60s');
			expect(prompt).toContain('$0.0500');
			expect(prompt).toContain('Fixed bug in auth');
			expect(prompt).toContain('[FAILED]');
			expect(prompt).toContain('src/auth.ts | 5 +-');
			expect(prompt).toContain('[command] npm test');
			expect(prompt).toContain('modified: src/auth.ts (10-20)');
		});

		it('handles missing optional fields gracefully', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-2',
				agentType: 'codex',
				projectPath: '/test',
				historyEntries: [],
			};

			const prompt = analyzer.compilePrompt(input);

			expect(prompt).toContain('codex');
			expect(prompt).toContain('unknown'); // duration and cost
			expect(prompt).toContain('N/A'); // git diff, VIBES
		});

		it('uses the experience-extraction prompt template (no leftover placeholders)', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-3',
				agentType: 'claude-code',
				projectPath: '/home/user/project',
				historyEntries: [{ summary: 'Step 1' }],
				sessionDurationMs: 10000,
				sessionCostUsd: 0.01,
			};

			const prompt = analyzer.compilePrompt(input);

			// No template variables should remain
			expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
		});

		it('template contains structural sections from the .md file', () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-4',
				agentType: 'claude-code',
				projectPath: '/test',
				historyEntries: [],
			};

			const prompt = analyzer.compilePrompt(input);

			// Validate key structural sections from the template
			expect(prompt).toContain('## Session Context');
			expect(prompt).toContain('## Session History');
			expect(prompt).toContain('## Code Changes (Git Diff)');
			expect(prompt).toContain('## VIBES Audit Trail');
			expect(prompt).toContain('## Instructions');
			expect(prompt).toContain('experience extraction agent');
			expect(prompt).toContain('noveltyScore');
		});
	});

	// ─── Output Parsing ──────────────────────────────────────────────────

	describe('parseExperiences', () => {
		it('parses valid JSON array', () => {
			const output = JSON.stringify([
				{
					content: 'Break circular imports',
					situation: 'Build failed',
					learning: 'Extract shared types',
					category: 'problem-solved',
					tags: ['typescript'],
					noveltyScore: 0.8,
				},
			]);

			const results = analyzer.parseExperiences(output);

			expect(results).toHaveLength(1);
			expect(results[0].content).toBe('Break circular imports');
			expect(results[0].category).toBe('problem-solved');
			expect(results[0].noveltyScore).toBe(0.8);
			expect(results[0].tags).toEqual(['typescript']);
		});

		it('extracts JSON from noisy output', () => {
			const output = `Here are my findings:\n\`\`\`json\n[{"content":"test","situation":"test","learning":"test","category":"decision-made","tags":[],"noveltyScore":0.5}]\n\`\`\`\nEnd.`;

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].content).toBe('test');
			expect(results[0].category).toBe('decision-made');
		});

		it('returns empty array for empty JSON array', () => {
			const results = analyzer.parseExperiences('[]');
			expect(results).toEqual([]);
		});

		it('returns empty array for non-JSON output', () => {
			const results = analyzer.parseExperiences('This is not JSON at all.');
			expect(results).toEqual([]);
		});

		it('returns empty array for malformed JSON', () => {
			const results = analyzer.parseExperiences('[{broken}]');
			expect(results).toEqual([]);
		});

		it('filters out entries missing required fields', () => {
			const output = JSON.stringify([
				{
					content: 'Good entry',
					situation: 'Test',
					learning: 'Test',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					// Missing content
					situation: 'Test',
					learning: 'Test',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					content: 'Missing novelty',
					situation: 'Test',
					learning: 'Test',
					tags: [],
					// Missing noveltyScore
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].content).toBe('Good entry');
		});

		it('handles non-string tags gracefully', () => {
			const output = JSON.stringify([
				{
					content: 'Entry',
					situation: 'Test',
					learning: 'Test',
					tags: ['valid', 123, null, 'also-valid'],
					noveltyScore: 0.6,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].tags).toEqual(['valid', 'also-valid']);
		});

		it('handles missing tags array', () => {
			const output = JSON.stringify([
				{
					content: 'No tags',
					situation: 'Test',
					learning: 'Test',
					noveltyScore: 0.7,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].tags).toEqual([]);
		});

		it('defaults to pattern-established when category is missing', () => {
			const output = JSON.stringify([
				{
					content: 'No category',
					situation: 'Test',
					learning: 'Test',
					tags: [],
					noveltyScore: 0.6,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].category).toBe('pattern-established');
		});

		it('defaults to pattern-established when category is invalid', () => {
			const output = JSON.stringify([
				{
					content: 'Invalid category',
					situation: 'Test',
					learning: 'Test',
					category: 'not-a-valid-category',
					tags: [],
					noveltyScore: 0.5,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].category).toBe('pattern-established');
		});

		it('defaults to pattern-established when category is non-string', () => {
			const output = JSON.stringify([
				{
					content: 'Numeric category',
					situation: 'Test',
					learning: 'Test',
					category: 42,
					tags: [],
					noveltyScore: 0.5,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].category).toBe('pattern-established');
		});

		it('preserves valid category values', () => {
			const output = JSON.stringify([
				{
					content: 'A',
					situation: 'S',
					learning: 'L',
					category: 'pattern-established',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					content: 'B',
					situation: 'S',
					learning: 'L',
					category: 'problem-solved',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					content: 'C',
					situation: 'S',
					learning: 'L',
					category: 'dependency-discovered',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					content: 'D',
					situation: 'S',
					learning: 'L',
					category: 'anti-pattern-identified',
					tags: [],
					noveltyScore: 0.5,
				},
				{
					content: 'E',
					situation: 'S',
					learning: 'L',
					category: 'decision-made',
					tags: [],
					noveltyScore: 0.5,
				},
			]);

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(5);
			expect(results[0].category).toBe('pattern-established');
			expect(results[1].category).toBe('problem-solved');
			expect(results[2].category).toBe('dependency-discovered');
			expect(results[3].category).toBe('anti-pattern-identified');
			expect(results[4].category).toBe('decision-made');
		});
	});

	// ─── Rate Limiting ───────────────────────────────────────────────────

	describe('rate limiting', () => {
		it('is not on cooldown initially', async () => {
			expect(await analyzer.isOnCooldown('/project')).toBe(false);
		});

		it('reports cooldown after analysis', async () => {
			// Set up enough history entries for analysis (mock getEntries)
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);

			// Mock LLM call to return empty (no experiences)
			mockExecFile.mockRejectedValue(new Error('not available'));

			await analyzer.analyzeCompletedSession('sess-1', '/project', 'claude-code');

			expect(await analyzer.isOnCooldown('/project')).toBe(true);
		});

		it('separate projects have independent cooldowns', async () => {
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			await analyzer.analyzeCompletedSession('sess-1', '/project-a', 'claude-code');

			expect(await analyzer.isOnCooldown('/project-a')).toBe(true);
			expect(await analyzer.isOnCooldown('/project-b')).toBe(false);
		});
	});

	// ─── Session Data Gathering ──────────────────────────────────────────

	describe('gatherSessionData', () => {
		it('populates historyEntries from HistoryManager', async () => {
			mockGetEntries.mockReturnValue([
				{
					id: '1',
					summary: 'Step 1',
					fullResponse: 'Full response text that could be very long',
					success: true,
					elapsedTimeMs: 1000,
					type: 'prompt',
				},
				{
					id: '2',
					summary: 'Step 2',
					success: false,
					type: 'prompt',
				},
			]);
			// Mock git to fail (no git repo)
			mockExecFile.mockRejectedValue(new Error('not a git repo'));

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.historyEntries).toHaveLength(2);
			expect(input.historyEntries[0].summary).toBe('Step 1');
			expect(input.historyEntries[0].success).toBe(true);
			expect(input.historyEntries[1].success).toBe(false);
		});

		it('truncates fullResponse to 500 chars', async () => {
			const longResponse = 'x'.repeat(1000);
			mockGetEntries.mockReturnValue([
				{
					id: '1',
					summary: 'S1',
					fullResponse: longResponse,
					type: 'prompt',
				},
			]);
			mockExecFile.mockRejectedValue(new Error('not a git repo'));

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.historyEntries[0].fullResponse).toHaveLength(500);
		});

		it('limits to last 20 history entries', async () => {
			const entries = Array.from({ length: 30 }, (_, i) => ({
				id: `${i}`,
				summary: `Step ${i}`,
				type: 'prompt',
			}));
			mockGetEntries.mockReturnValue(entries);
			mockExecFile.mockRejectedValue(new Error('not a git repo'));

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.historyEntries).toHaveLength(20);
			// Should be the last 20 entries
			expect(input.historyEntries[0].summary).toBe('Step 10');
		});

		it('degrades gracefully when all data sources fail', async () => {
			mockGetEntries.mockImplementation(() => {
				throw new Error('History unavailable');
			});
			mockExecFile.mockRejectedValue(new Error('not a git repo'));
			mockGetQueryEvents.mockImplementation(() => {
				throw new Error('Stats DB unavailable');
			});

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.sessionId).toBe('sess-1');
			expect(input.historyEntries).toEqual([]);
			expect(input.gitDiff).toBeUndefined();
			expect(input.vibesManifest).toBeUndefined();
			expect(input.vibesAnnotations).toBeUndefined();
			expect(input.sessionDurationMs).toBeUndefined();
		});

		it('populates sessionDurationMs from stats DB query events', async () => {
			mockExecFile.mockRejectedValue(new Error('not a git repo'));
			mockGetQueryEvents.mockReturnValue([
				{
					id: 'q1',
					sessionId: 'sess-1',
					duration: 5000,
					agentType: 'claude-code',
					source: 'user',
					startTime: 1000,
				},
				{
					id: 'q2',
					sessionId: 'sess-1',
					duration: 3000,
					agentType: 'claude-code',
					source: 'user',
					startTime: 6000,
				},
				{
					id: 'q3',
					sessionId: 'sess-1',
					duration: 2000,
					agentType: 'claude-code',
					source: 'auto',
					startTime: 9000,
				},
			]);

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.sessionDurationMs).toBe(10000); // 5000 + 3000 + 2000
		});

		it('queries stats DB with correct sessionId filter', async () => {
			mockExecFile.mockRejectedValue(new Error('not a git repo'));
			mockGetQueryEvents.mockReturnValue([]);

			await analyzer.gatherSessionData('my-session-123', '/project', 'claude-code');

			expect(mockGetQueryEvents).toHaveBeenCalledWith('all', { sessionId: 'my-session-123' });
		});

		it('does not set sessionDurationMs when stats DB returns empty events', async () => {
			mockExecFile.mockRejectedValue(new Error('not a git repo'));
			mockGetQueryEvents.mockReturnValue([]);

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			expect(input.sessionDurationMs).toBeUndefined();
		});

		it('degrades gracefully when stats DB throws', async () => {
			mockExecFile.mockRejectedValue(new Error('not a git repo'));
			mockGetQueryEvents.mockImplementation(() => {
				throw new Error('Database not initialized');
			});

			const input = await analyzer.gatherSessionData('sess-1', '/project', 'claude-code');

			// Should not throw, sessionDurationMs remains undefined
			expect(input.sessionId).toBe('sess-1');
			expect(input.sessionDurationMs).toBeUndefined();
		});
	});

	// ─── Experience Storage ──────────────────────────────────────────────

	describe('storeExperiences', () => {
		it('stores experiences with correct type and source', async () => {
			const experiences: ExtractedExperience[] = [
				{
					content: 'Always run lint before committing',
					situation: 'CI failed due to lint errors',
					learning: 'Pre-commit lint catches errors early',
					category: 'pattern-established',
					tags: ['ci', 'lint'],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
				sessionCostUsd: 0.05,
				sessionDurationMs: 30000,
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			// Find the created memory in project scope
			let foundMemory = false;
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					const entry = (lib.entries ?? []).find(
						(e: { content: string }) => e.content === 'Always run lint before committing'
					);
					if (entry) {
						expect(entry.type).toBe('experience');
						expect(entry.source).toBe('session-analysis');
						expect(entry.confidence).toBe(0.5);
						expect(entry.pinned).toBe(false);
						expect(entry.tags).toContain('ci');
						expect(entry.tags).toContain('lint');
						expect(entry.experienceContext).toBeDefined();
						expect(entry.experienceContext.situation).toBe('CI failed due to lint errors');
						expect(entry.experienceContext.learning).toBe('Pre-commit lint catches errors early');
						expect(entry.experienceContext.sourceSessionId).toBe('sess-1');
						expect(entry.experienceContext.sourceAgentType).toBe('claude-code');
						expect(entry.experienceContext.sessionCostUsd).toBe(0.05);
						foundMemory = true;
					}
				}
			}
			expect(foundMemory).toBe(true);
		});

		it('returns 0 for empty experiences array', async () => {
			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/test',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences([], input);
			expect(stored).toBe(0);
		});

		it('stores multiple experiences', async () => {
			const experiences: ExtractedExperience[] = [
				{
					content: 'Exp 1',
					situation: 'Sit 1',
					learning: 'Learn 1',
					category: 'pattern-established',
					tags: [],
					noveltyScore: 0.6,
				},
				{
					content: 'Exp 2',
					situation: 'Sit 2',
					learning: 'Learn 2',
					category: 'problem-solved',
					tags: [],
					noveltyScore: 0.8,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(2);
		});

		it('skips experience when existing memory has similarity > 0.80', async () => {
			// Make embeddings work
			const baseVector = new Array(384).fill(0);
			baseVector[0] = 1.0;
			mockEncode.mockResolvedValue(baseVector);

			// Pre-populate a library with a similar existing memory
			const { MemoryStore } = await import('../../../main/memory/memory-store');
			const store = new MemoryStore();

			const similarVector = [...baseVector];
			similarVector[1] = 0.1; // Very close — cosine > 0.80

			const projDir = store.getMemoryPath('project', undefined, '/test/project');
			const libPath = `${projDir}/library.json`;
			fsState.set(
				libPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							id: 'existing-1',
							content: 'Always lint before committing',
							type: 'rule',
							scope: 'project',
							tags: [],
							source: 'user',
							confidence: 1.0,
							pinned: false,
							active: true,
							embedding: similarVector,
							effectivenessScore: 0.5,
							useCount: 0,
							tokenEstimate: 10,
							lastUsedAt: 0,
							createdAt: Date.now(),
							updatedAt: Date.now(),
						},
					],
				})
			);

			const experiences: ExtractedExperience[] = [
				{
					content: 'Run lint before every commit',
					situation: 'Test',
					learning: 'Test',
					category: 'pattern-established',
					tags: [],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(0);
		});

		it('places experience in skill scope when cascading search finds matching skill area', async () => {
			// Set up embedding mock — query vector [1, 0, 0, ...0]
			const queryVector = new Array(384).fill(0);
			queryVector[0] = 1.0;
			mockEncode.mockResolvedValue(queryVector);

			// Set up registry with persona and skill area (no embeddings → always match)
			const registryPath = '/mock/userData/memories/registry.json';
			fsState.set(
				registryPath,
				JSON.stringify({
					version: 1,
					roles: [],
					personas: [
						{
							id: 'persona-1',
							roleId: 'role-1',
							name: 'Test Persona',
							description: 'Test persona',
							embedding: null,
							skillAreaIds: ['skill-1'],
							assignedAgents: [],
							assignedProjects: [],
							active: true,
							createdAt: 1000,
							updatedAt: 1000,
						},
					],
					skillAreas: [
						{
							id: 'skill-1',
							personaId: 'persona-1',
							name: 'Test Skill',
							description: 'Test skill area',
							embedding: null,
							active: true,
							createdAt: 1000,
							updatedAt: 1000,
						},
					],
				})
			);

			// Existing memory in skill area with cosine ~0.75 (above threshold but below dedup)
			const existingVector = new Array(384).fill(0);
			existingVector[0] = 0.75;
			existingVector[1] = Math.sqrt(1 - 0.75 * 0.75); // Normalize to unit length

			const skillLibPath = '/mock/userData/memories/skills/skill-1/library.json';
			fsState.set(
				skillLibPath,
				JSON.stringify({
					version: 1,
					entries: [
						{
							id: 'existing-skill-memory',
							content: 'Related skill memory',
							type: 'rule',
							scope: 'skill',
							skillAreaId: 'skill-1',
							tags: [],
							source: 'user',
							confidence: 1.0,
							pinned: false,
							active: true,
							embedding: existingVector,
							effectivenessScore: 0.5,
							useCount: 0,
							tokenEstimate: 10,
							lastUsedAt: 0,
							createdAt: 1000,
							updatedAt: 1000,
						},
					],
				})
			);

			const experiences: ExtractedExperience[] = [
				{
					content: 'New skill-related learning',
					situation: 'Working on related task',
					learning: 'New insight for skill area',
					category: 'dependency-discovered',
					tags: ['skill-test'],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-skill',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			// Verify the memory was stored in the skill area library
			const updatedLib = JSON.parse(fsState.get(skillLibPath)!);
			const newEntry = updatedLib.entries.find(
				(e: { content: string }) => e.content === 'New skill-related learning'
			);
			expect(newEntry).toBeDefined();
			expect(newEntry.scope).toBe('skill');
			expect(newEntry.skillAreaId).toBe('skill-1');
			expect(newEntry.type).toBe('experience');
			expect(newEntry.source).toBe('session-analysis');
		});

		it('truncates diffSummary to 500 chars in experienceContext', async () => {
			const longDiff = 'x'.repeat(1000);
			const experiences: ExtractedExperience[] = [
				{
					content: 'Learning with long diff',
					situation: 'Test situation',
					learning: 'Test learning',
					category: 'pattern-established',
					tags: [],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-diff',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
				gitDiff: longDiff,
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			// Find the stored memory and check diffSummary length
			let diffSummary: string | undefined;
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					const entry = (lib.entries ?? []).find(
						(e: { content: string }) => e.content === 'Learning with long diff'
					);
					if (entry?.experienceContext?.diffSummary) {
						diffSummary = entry.experienceContext.diffSummary;
					}
				}
			}
			expect(diffSummary).toBeDefined();
			expect(diffSummary!.length).toBe(500);
		});

		it('populates complete experienceContext with all session metadata', async () => {
			const experiences: ExtractedExperience[] = [
				{
					content: 'Metadata test learning',
					situation: 'Full metadata situation',
					learning: 'Full metadata learning',
					category: 'decision-made',
					tags: ['meta'],
					noveltyScore: 0.9,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-meta',
				agentType: 'codex',
				projectPath: '/meta/project',
				historyEntries: [],
				gitDiff: 'diff --git a/foo.ts',
				sessionCostUsd: 0.123,
				sessionDurationMs: 45000,
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			// Find and verify experienceContext
			let ctx: Record<string, unknown> | undefined;
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					const entry = (lib.entries ?? []).find(
						(e: { content: string }) => e.content === 'Metadata test learning'
					);
					if (entry?.experienceContext) {
						ctx = entry.experienceContext;
					}
				}
			}
			expect(ctx).toBeDefined();
			expect(ctx!.situation).toBe('Full metadata situation');
			expect(ctx!.learning).toBe('Full metadata learning');
			expect(ctx!.sourceSessionId).toBe('sess-meta');
			expect(ctx!.sourceProjectPath).toBe('/meta/project');
			expect(ctx!.sourceAgentType).toBe('codex');
			expect(ctx!.diffSummary).toBe('diff --git a/foo.ts');
			expect(ctx!.sessionCostUsd).toBe(0.123);
			expect(ctx!.sessionDurationMs).toBe(45000);
		});

		it('degrades gracefully when embedding service is unavailable for dedup', async () => {
			// mockEncode defaults to throwing — embedding unavailable
			const experiences: ExtractedExperience[] = [
				{
					content: 'Should still store without dedup',
					situation: 'No embeddings available',
					learning: 'Graceful degradation works',
					category: 'anti-pattern-identified',
					tags: [],
					noveltyScore: 0.6,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-no-embed',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			// Should store despite no embedding service (skips dedup)
			expect(stored).toBe(1);
		});

		it('prepends category tag to stored experience tags', async () => {
			const experiences: ExtractedExperience[] = [
				{
					content: 'Category tag test',
					situation: 'Testing category tags',
					learning: 'Category tags are prepended',
					category: 'problem-solved',
					tags: ['typescript', 'bug'],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-cat-tag',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			// Find the stored memory and verify category tag is prepended
			let foundTags: string[] | undefined;
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					const entry = (lib.entries ?? []).find(
						(e: { content: string }) => e.content === 'Category tag test'
					);
					if (entry) {
						foundTags = entry.tags;
					}
				}
			}
			expect(foundTags).toBeDefined();
			expect(foundTags![0]).toBe('category:problem-solved');
			expect(foundTags).toContain('typescript');
			expect(foundTags).toContain('bug');
			expect(foundTags).toHaveLength(3);
		});

		it('does not duplicate category tag if already present', async () => {
			const experiences: ExtractedExperience[] = [
				{
					content: 'No duplicate category tag',
					situation: 'Testing dedup',
					learning: 'No duplication',
					category: 'decision-made',
					tags: ['category:decision-made', 'architecture'],
					noveltyScore: 0.7,
				},
			];

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-cat-dedup',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(1);

			let foundTags: string[] | undefined;
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					const entry = (lib.entries ?? []).find(
						(e: { content: string }) => e.content === 'No duplicate category tag'
					);
					if (entry) {
						foundTags = entry.tags;
					}
				}
			}
			expect(foundTags).toBeDefined();
			// Should still have exactly one category:decision-made tag, not two
			const categoryTags = foundTags!.filter((t: string) => t === 'category:decision-made');
			expect(categoryTags).toHaveLength(1);
			expect(foundTags).toContain('architecture');
		});

		it('prepends category tag for all category values', async () => {
			const categories: ExperienceCategory[] = [
				'pattern-established',
				'problem-solved',
				'dependency-discovered',
				'anti-pattern-identified',
				'decision-made',
			];

			const experiences: ExtractedExperience[] = categories.map((cat, i) => ({
				content: `Cat test ${i}`,
				situation: `Sit ${i}`,
				learning: `Learn ${i}`,
				category: cat,
				tags: ['test'],
				noveltyScore: 0.7,
			}));

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-all-cats',
				agentType: 'claude-code',
				projectPath: '/test/project',
				historyEntries: [],
			};

			const stored = await analyzer.storeExperiences(experiences, input);
			expect(stored).toBe(5);

			// Verify each stored memory has the correct category tag
			for (const [filePath, content] of fsState) {
				if (filePath.endsWith('library.json')) {
					const lib = JSON.parse(content);
					for (let i = 0; i < categories.length; i++) {
						const entry = (lib.entries ?? []).find(
							(e: { content: string }) => e.content === `Cat test ${i}`
						);
						if (entry) {
							expect(entry.tags[0]).toBe(`category:${categories[i]}`);
						}
					}
				}
			}
		});
	});

	// ─── Singleton ───────────────────────────────────────────────────────

	describe('singleton', () => {
		afterEach(() => {
			resetExperienceAnalyzer();
		});

		it('returns same instance across calls', () => {
			const a = getExperienceAnalyzer();
			const b = getExperienceAnalyzer();
			expect(a).toBe(b);
		});

		it('returns an ExperienceAnalyzer instance', () => {
			const instance = getExperienceAnalyzer();
			expect(instance).toBeInstanceOf(ExperienceAnalyzer);
		});

		it('reset creates a fresh instance on next call', () => {
			const first = getExperienceAnalyzer();
			resetExperienceAnalyzer();
			const second = getExperienceAnalyzer();
			expect(first).not.toBe(second);
		});

		it('initializeExperienceAnalyzer returns the singleton', async () => {
			const instance = await initializeExperienceAnalyzer();
			expect(instance).toBeInstanceOf(ExperienceAnalyzer);
			expect(instance).toBe(getExperienceAnalyzer());
		});

		it('initializeExperienceAnalyzer returns same instance on repeated calls', async () => {
			const a = await initializeExperienceAnalyzer();
			const b = await initializeExperienceAnalyzer();
			expect(a).toBe(b);
		});
	});

	// ─── Stream-JSON Parsing ────────────────────────────────────────────

	describe('extractResultText', () => {
		it('extracts text from result event', () => {
			const jsonl = [
				JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
				}),
				JSON.stringify({
					type: 'result',
					result: '[{"content":"final answer"}]',
					session_id: 'abc',
				}),
			].join('\n');

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('[{"content":"final answer"}]');
		});

		it('falls back to assistant text blocks when no result event', () => {
			const jsonl = [
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
				}),
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: ' world' }] },
				}),
			].join('\n');

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('hello\n world');
		});

		it('handles string content in assistant messages', () => {
			const jsonl = JSON.stringify({
				type: 'assistant',
				message: { role: 'assistant', content: 'direct string content' },
			});

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('direct string content');
		});

		it('returns raw output when no parseable events', () => {
			const text = analyzer.extractResultText('not json at all');
			expect(text).toBe('not json at all');
		});

		it('returns raw output for empty input', () => {
			const text = analyzer.extractResultText('');
			expect(text).toBe('');
		});

		it('skips non-text content blocks', () => {
			const jsonl = JSON.stringify({
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'internal reasoning' },
						{ type: 'text', text: 'visible output' },
						{ type: 'tool_use', name: 'some_tool' },
					],
				},
			});

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('visible output');
		});

		it('prefers result event over earlier assistant text', () => {
			const jsonl = [
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: 'streaming chunk' },
				}),
				JSON.stringify({ type: 'result', result: 'final result' }),
			].join('\n');

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('final result');
		});

		it('ignores malformed JSON lines mixed with valid ones', () => {
			const jsonl = ['{broken json', JSON.stringify({ type: 'result', result: '[]' })].join('\n');

			const text = analyzer.extractResultText(jsonl);
			expect(text).toBe('[]');
		});
	});

	// ─── analyzeSession (LLM call) ──────────────────────────────────────

	describe('analyzeSession', () => {
		it('spawns claude with --print --output-format stream-json', async () => {
			const resultLine = JSON.stringify({
				type: 'result',
				result: JSON.stringify([
					{
						content: 'Use --skip-git-repo-check for monorepos',
						situation: 'Codex stalled on monorepo',
						learning: 'Monorepo flag needed',
						category: 'problem-solved',
						tags: ['codex'],
						noveltyScore: 0.8,
					},
				]),
			});
			mockExecFile.mockResolvedValue({ stdout: resultLine, stderr: '' });

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'Fixed monorepo issue' }],
			};

			const experiences = await analyzer.analyzeSession(input);

			// Verify execFile was called with stream-json format
			expect(mockExecFile).toHaveBeenCalledWith(
				'claude',
				expect.arrayContaining([
					'--print',
					'--output-format',
					'stream-json',
					'-p',
					expect.any(String),
				]),
				expect.objectContaining({ timeout: 120000, maxBuffer: 1024 * 1024 })
			);
			expect(experiences).toHaveLength(1);
			expect(experiences[0].content).toBe('Use --skip-git-repo-check for monorepos');
			expect(experiences[0].category).toBe('problem-solved');
		});

		it('returns empty array when LLM call fails', async () => {
			mockExecFile.mockRejectedValue(new Error('Command not found: claude'));

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'test' }],
			};

			const experiences = await analyzer.analyzeSession(input);
			expect(experiences).toEqual([]);
		});

		it('returns empty array when LLM returns empty result', async () => {
			const resultLine = JSON.stringify({ type: 'result', result: '[]' });
			mockExecFile.mockResolvedValue({ stdout: resultLine, stderr: '' });

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'routine task' }],
			};

			const experiences = await analyzer.analyzeSession(input);
			expect(experiences).toEqual([]);
		});

		it('returns empty array when prompt compilation returns empty', async () => {
			// Create analyzer with a mock that returns empty prompt
			const testAnalyzer = new ExperienceAnalyzer();
			vi.spyOn(testAnalyzer, 'compilePrompt').mockReturnValue('');

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'test' }],
			};

			const experiences = await testAnalyzer.analyzeSession(input);
			expect(experiences).toEqual([]);
			expect(mockExecFile).not.toHaveBeenCalled();
		});

		it('handles stream-json with multiple assistant chunks before result', async () => {
			const jsonl = [
				JSON.stringify({
					type: 'assistant',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Analyzing...' }],
					},
				}),
				JSON.stringify({
					type: 'result',
					result: JSON.stringify([
						{
							content: 'Learning from multi-chunk response',
							situation: 'Multi-chunk test',
							learning: 'Parsing works',
							tags: [],
							noveltyScore: 0.6,
						},
					]),
				}),
			].join('\n');
			mockExecFile.mockResolvedValue({ stdout: jsonl, stderr: '' });

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'test' }],
			};

			const experiences = await analyzer.analyzeSession(input);
			expect(experiences).toHaveLength(1);
			expect(experiences[0].content).toBe('Learning from multi-chunk response');
		});

		it('parses experiences from non-result JSONL (fallback path)', async () => {
			// Simulate output without a result event — only assistant text
			const jsonl = JSON.stringify({
				type: 'assistant',
				message: {
					role: 'assistant',
					content: JSON.stringify([
						{
							content: 'Fallback learning',
							situation: 'No result event',
							learning: 'Fallback parsing',
							tags: [],
							noveltyScore: 0.5,
						},
					]),
				},
			});
			mockExecFile.mockResolvedValue({ stdout: jsonl, stderr: '' });

			const input: ExperienceAnalyzerInput = {
				sessionId: 'sess-1',
				agentType: 'claude-code',
				projectPath: '/project',
				historyEntries: [{ summary: 'test' }],
			};

			const experiences = await analyzer.analyzeSession(input);
			expect(experiences).toHaveLength(1);
			expect(experiences[0].content).toBe('Fallback learning');
		});
	});

	// ─── analyzeCompletedSession ─────────────────────────────────────────

	describe('analyzeCompletedSession', () => {
		it('returns 0 when below minimum history entries', async () => {
			mockGetEntries.mockReturnValue([{ id: '1', summary: 'step 1', type: 'prompt' }]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			const result = await analyzer.analyzeCompletedSession('sess-1', '/project', 'claude-code');
			expect(result).toBe(0);
		});

		it('returns 0 when on cooldown', async () => {
			// First run
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			await analyzer.analyzeCompletedSession('sess-1', '/project', 'claude-code');

			// Second run (on cooldown)
			const result = await analyzer.analyzeCompletedSession('sess-2', '/project', 'claude-code');
			expect(result).toBe(0);
		});

		it('does not throw on LLM failure', async () => {
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('LLM unavailable'));

			// Should not throw
			const result = await analyzer.analyzeCompletedSession('sess-1', '/project', 'claude-code');
			expect(result).toBe(0);
		});

		it('filters out experiences with noveltyScore below default 0.4', async () => {
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);

			// LLM returns mix of high and low novelty experiences
			const resultLine = JSON.stringify({
				type: 'result',
				result: JSON.stringify([
					{
						content: 'High novelty learning',
						situation: 'Interesting situation',
						learning: 'Novel insight',
						tags: [],
						noveltyScore: 0.8,
					},
					{
						content: 'Low novelty obvious thing',
						situation: 'Boring situation',
						learning: 'Obvious insight',
						tags: [],
						noveltyScore: 0.2,
					},
					{
						content: 'Borderline novelty at threshold',
						situation: 'Edge case',
						learning: 'Threshold insight',
						tags: [],
						noveltyScore: 0.4,
					},
				]),
			});
			mockExecFile.mockResolvedValue({ stdout: resultLine, stderr: '' });

			const result = await analyzer.analyzeCompletedSession('sess-1', '/project', 'claude-code');

			// Only 2 experiences should pass (0.8 and 0.4 >= 0.4 threshold)
			expect(result).toBe(2);
		});
	});

	// ─── Config Controls ────────────────────────────────────────────────

	describe('config controls', () => {
		afterEach(() => {
			fsState.delete(configPath);
		});

		it('returns 0 when enableExperienceExtraction is false', async () => {
			fsState.set(configPath, JSON.stringify({ enableExperienceExtraction: false }));
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
				{ id: '4', summary: 'step 4', type: 'prompt' },
			]);

			const result = await analyzer.analyzeCompletedSession(
				'sess-cfg-1',
				'/project-cfg',
				'claude-code'
			);
			expect(result).toBe(0);
			// LLM (claude) should never be called — only git calls are allowed
			const claudeCalls = mockExecFile.mock.calls.filter((call: unknown[]) => call[0] === 'claude');
			expect(claudeCalls).toHaveLength(0);
		});

		it('respects custom minHistoryEntriesForAnalysis', async () => {
			fsState.set(
				configPath,
				JSON.stringify({ enableExperienceExtraction: true, minHistoryEntriesForAnalysis: 5 })
			);
			// 4 entries — below the custom threshold of 5
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
				{ id: '4', summary: 'step 4', type: 'prompt' },
			]);

			const result = await analyzer.analyzeCompletedSession(
				'sess-cfg-2',
				'/project-cfg-2',
				'claude-code'
			);
			expect(result).toBe(0);
		});

		it('respects custom minNoveltyScore', async () => {
			fsState.set(
				configPath,
				JSON.stringify({ enableExperienceExtraction: true, minNoveltyScore: 0.7 })
			);
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);

			const resultLine = JSON.stringify({
				type: 'result',
				result: JSON.stringify([
					{
						content: 'High novelty',
						situation: 'Good',
						learning: 'Yes',
						tags: [],
						noveltyScore: 0.8,
					},
					{
						content: 'Below custom threshold',
						situation: 'Meh',
						learning: 'Maybe',
						tags: [],
						noveltyScore: 0.5,
					},
				]),
			});
			mockExecFile.mockResolvedValue({ stdout: resultLine, stderr: '' });

			const result = await analyzer.analyzeCompletedSession(
				'sess-cfg-3',
				'/project-cfg-3',
				'claude-code'
			);
			// Only 0.8 passes the custom 0.7 threshold
			expect(result).toBe(1);
		});

		it('respects custom analysisCooldownMs via isOnCooldown', async () => {
			// Set a very long cooldown
			fsState.set(
				configPath,
				JSON.stringify({ enableExperienceExtraction: true, analysisCooldownMs: 999999999 })
			);
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			await analyzer.analyzeCompletedSession('sess-cfg-4', '/project-cfg-4', 'claude-code');

			// Should still be on cooldown due to the long cooldown setting
			expect(await analyzer.isOnCooldown('/project-cfg-4')).toBe(true);
		});

		it('defaults are used when config file is missing', async () => {
			// Delete the config set in beforeEach — exercise the defaults path
			fsState.delete(configPath);
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			// Default enableExperienceExtraction is false — bails early, returns 0
			const result = await analyzer.analyzeCompletedSession(
				'sess-cfg-5',
				'/project-cfg-5',
				'claude-code'
			);
			expect(result).toBe(0);
			// LLM (claude) should NOT be called — extraction is disabled by default
			const claudeCalls = mockExecFile.mock.calls.filter((call: unknown[]) => call[0] === 'claude');
			expect(claudeCalls).toHaveLength(0);
		});
	});
});
