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

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import {
	ExperienceAnalyzer,
	getExperienceAnalyzer,
	type ExperienceAnalyzerInput,
	type ExtractedExperience,
} from '../../../main/memory/experience-analyzer';

// ─── Tests ───────────────────────────────────────────────────────────────────

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
				tags: ['imports', 'typescript'],
				noveltyScore: 0.8,
			};
			expect(exp.content).toBe('Always check imports');
			expect(exp.noveltyScore).toBe(0.8);
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
					tags: ['typescript'],
					noveltyScore: 0.8,
				},
			]);

			const results = analyzer.parseExperiences(output);

			expect(results).toHaveLength(1);
			expect(results[0].content).toBe('Break circular imports');
			expect(results[0].noveltyScore).toBe(0.8);
			expect(results[0].tags).toEqual(['typescript']);
		});

		it('extracts JSON from noisy output', () => {
			const output = `Here are my findings:\n\`\`\`json\n[{"content":"test","situation":"test","learning":"test","tags":[],"noveltyScore":0.5}]\n\`\`\`\nEnd.`;

			const results = analyzer.parseExperiences(output);
			expect(results).toHaveLength(1);
			expect(results[0].content).toBe('test');
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
	});

	// ─── Rate Limiting ───────────────────────────────────────────────────

	describe('rate limiting', () => {
		it('is not on cooldown initially', () => {
			expect(analyzer.isOnCooldown('/project')).toBe(false);
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

			expect(analyzer.isOnCooldown('/project')).toBe(true);
		});

		it('separate projects have independent cooldowns', async () => {
			mockGetEntries.mockReturnValue([
				{ id: '1', summary: 'step 1', type: 'prompt' },
				{ id: '2', summary: 'step 2', type: 'prompt' },
				{ id: '3', summary: 'step 3', type: 'prompt' },
			]);
			mockExecFile.mockRejectedValue(new Error('not available'));

			await analyzer.analyzeCompletedSession('sess-1', '/project-a', 'claude-code');

			expect(analyzer.isOnCooldown('/project-a')).toBe(true);
			expect(analyzer.isOnCooldown('/project-b')).toBe(false);
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
					tags: [],
					noveltyScore: 0.6,
				},
				{
					content: 'Exp 2',
					situation: 'Sit 2',
					learning: 'Learn 2',
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
	});

	// ─── Singleton ───────────────────────────────────────────────────────

	describe('singleton', () => {
		it('returns same instance across calls', () => {
			const a = getExperienceAnalyzer();
			const b = getExperienceAnalyzer();
			expect(a).toBe(b);
		});

		it('returns an ExperienceAnalyzer instance', () => {
			const instance = getExperienceAnalyzer();
			expect(instance).toBeInstanceOf(ExperienceAnalyzer);
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
	});
});
