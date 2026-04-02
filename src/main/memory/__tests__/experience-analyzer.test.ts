/**
 * Tests for ExperienceAnalyzer — extraction model config, prompt compilation,
 * parsing, and deviation detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

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

vi.mock('fs/promises', () => ({
	readFile: vi.fn(async () => {
		const err = new Error('ENOENT') as NodeJS.ErrnoException;
		err.code = 'ENOENT';
		throw err;
	}),
	writeFile: vi.fn(async () => {}),
	rename: vi.fn(async () => {}),
	mkdir: vi.fn(async () => {}),
	appendFile: vi.fn(async () => {}),
}));

const mockExecFile = vi.fn();
vi.mock('child_process', () => ({
	execFile: mockExecFile,
}));

vi.mock('util', () => ({
	promisify: vi.fn((fn: any) => fn),
}));

vi.mock('../../utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../../prompts', () => ({
	experienceExtractionPrompt:
		'Analyze session for {{AGENT_TYPE}} at {{PROJECT_PATH}}. Duration: {{DURATION}}, Cost: {{COST}}. History: {{HISTORY_ENTRIES}}. Deviations: {{DEVIATION_SIGNALS}}. Decisions: {{DECISION_SIGNALS}}. Git diff: {{GIT_DIFF}}. VIBES: {{VIBES_DATA}}.',
}));

// ─── Import under test ──────────────────────────────────────────────────────

import {
	ExperienceAnalyzer,
	resetExperienceAnalyzer,
	type ExperienceAnalyzerInput,
} from '../experience-analyzer';

describe('ExperienceAnalyzer', () => {
	let analyzer: ExperienceAnalyzer;

	beforeEach(() => {
		vi.clearAllMocks();
		resetExperienceAnalyzer();
		analyzer = new ExperienceAnalyzer();
	});

	// ─── analyzeSession — extractionModel config ────────────────────────

	describe('analyzeSession with extractionModel', () => {
		const baseInput: ExperienceAnalyzerInput = {
			sessionId: 'test-session',
			agentType: 'claude-code',
			projectPath: '/test/project',
			historyEntries: [
				{ summary: 'Step 1', success: true },
				{ summary: 'Step 2', success: true },
			],
		};

		it('should pass --model flag when extractionModel is configured', async () => {
			// Mock getMemoryConfig to return an extractionModel
			const mockConfig = {
				enabled: true,
				extractionModel: 'claude-haiku-4-5-20251001',
				enableExperienceExtraction: true,
				minHistoryEntriesForAnalysis: 1,
				minNoveltyScore: 0.4,
				analysisCooldownMs: 300000,
				maxTokenBudget: 1500,
				similarityThreshold: 0.65,
				personaMatchThreshold: 0.4,
				skillMatchThreshold: 0.5,
				maxMemoriesPerSkillArea: 50,
				consolidationThreshold: 0.85,
				decayHalfLifeDays: 30,
				enableAutoConsolidation: true,
				enableEffectivenessTracking: true,
				injectionStrategy: 'balanced' as const,
			};

			// Override getMemoryConfig by mocking the store
			vi.spyOn(analyzer as any, 'getMemoryConfig').mockResolvedValue(mockConfig);

			// Mock execFileAsync to return valid JSON
			mockExecFile.mockResolvedValue({
				stdout: JSON.stringify({
					type: 'result',
					result: JSON.stringify([
						{
							content: 'Test experience',
							situation: 'Test situation',
							learning: 'Test learning',
							category: 'pattern-established',
							tags: [],
							noveltyScore: 0.8,
						},
					]),
				}),
			});

			await analyzer.analyzeSession(baseInput);

			// Verify execFile was called with --model flag
			expect(mockExecFile).toHaveBeenCalledTimes(1);
			const callArgs = mockExecFile.mock.calls[0];
			const args = callArgs[1] as string[];
			expect(args).toContain('--model');
			expect(args).toContain('claude-haiku-4-5-20251001');

			// Verify the order: --print --output-format stream-json --model <model> -p <prompt>
			const modelIdx = args.indexOf('--model');
			const printIdx = args.indexOf('--print');
			expect(printIdx).toBeLessThan(modelIdx);
		});

		it('should not pass --model flag when extractionModel is undefined', async () => {
			const mockConfig = {
				enabled: true,
				extractionModel: undefined,
				enableExperienceExtraction: true,
				minHistoryEntriesForAnalysis: 1,
				minNoveltyScore: 0.4,
				analysisCooldownMs: 300000,
				maxTokenBudget: 1500,
				similarityThreshold: 0.65,
				personaMatchThreshold: 0.4,
				skillMatchThreshold: 0.5,
				maxMemoriesPerSkillArea: 50,
				consolidationThreshold: 0.85,
				decayHalfLifeDays: 30,
				enableAutoConsolidation: true,
				enableEffectivenessTracking: true,
				injectionStrategy: 'balanced' as const,
			};

			vi.spyOn(analyzer as any, 'getMemoryConfig').mockResolvedValue(mockConfig);

			mockExecFile.mockResolvedValue({
				stdout: JSON.stringify({ type: 'result', result: '[]' }),
			});

			await analyzer.analyzeSession(baseInput);

			expect(mockExecFile).toHaveBeenCalledTimes(1);
			const args = mockExecFile.mock.calls[0][1] as string[];
			expect(args).not.toContain('--model');
		});

		it('should not pass --model flag when extractionModel is empty string', async () => {
			const mockConfig = {
				enabled: true,
				extractionModel: '',
				enableExperienceExtraction: true,
				minHistoryEntriesForAnalysis: 1,
				minNoveltyScore: 0.4,
				analysisCooldownMs: 300000,
				maxTokenBudget: 1500,
				similarityThreshold: 0.65,
				personaMatchThreshold: 0.4,
				skillMatchThreshold: 0.5,
				maxMemoriesPerSkillArea: 50,
				consolidationThreshold: 0.85,
				decayHalfLifeDays: 30,
				enableAutoConsolidation: true,
				enableEffectivenessTracking: true,
				injectionStrategy: 'balanced' as const,
			};

			vi.spyOn(analyzer as any, 'getMemoryConfig').mockResolvedValue(mockConfig);

			mockExecFile.mockResolvedValue({
				stdout: JSON.stringify({ type: 'result', result: '[]' }),
			});

			await analyzer.analyzeSession(baseInput);

			expect(mockExecFile).toHaveBeenCalledTimes(1);
			const args = mockExecFile.mock.calls[0][1] as string[];
			expect(args).not.toContain('--model');
		});
	});

	// ─── extractResultText ──────────────────────────────────────────────

	describe('extractResultText', () => {
		it('should extract from result event', () => {
			const output = '{"type":"result","result":"hello world"}\n';
			expect(analyzer.extractResultText(output)).toBe('hello world');
		});

		it('should fallback to assistant text blocks', () => {
			const output = [
				'{"type":"assistant","message":{"content":[{"type":"text","text":"part1"}]}}',
				'{"type":"assistant","message":{"content":[{"type":"text","text":"part2"}]}}',
			].join('\n');
			expect(analyzer.extractResultText(output)).toBe('part1\npart2');
		});

		it('should handle raw non-JSON output', () => {
			expect(analyzer.extractResultText('raw text')).toBe('raw text');
		});
	});

	// ─── parseExperiences ───────────────────────────────────────────────

	describe('parseExperiences', () => {
		it('should parse valid experience array', () => {
			const json = JSON.stringify([
				{
					content: 'Test',
					situation: 'Situation',
					learning: 'Learning',
					category: 'problem-solved',
					tags: ['test'],
					noveltyScore: 0.9,
					keywords: ['keyword1'],
				},
			]);
			const result = analyzer.parseExperiences(json);
			expect(result).toHaveLength(1);
			expect(result[0].category).toBe('problem-solved');
			expect(result[0].keywords).toEqual(['keyword1']);
		});

		it('should default invalid categories to pattern-established', () => {
			const json = JSON.stringify([
				{
					content: 'Test',
					situation: 'Sit',
					learning: 'Learn',
					category: 'invalid-category',
					tags: [],
					noveltyScore: 0.5,
				},
			]);
			const result = analyzer.parseExperiences(json);
			expect(result[0].category).toBe('pattern-established');
		});

		it('should handle noise around JSON array', () => {
			const output =
				'Here are the experiences:\n[{"content":"T","situation":"S","learning":"L","noveltyScore":0.7,"tags":[]}]\nDone.';
			const result = analyzer.parseExperiences(output);
			expect(result).toHaveLength(1);
		});

		it('should return empty for no JSON', () => {
			expect(analyzer.parseExperiences('no json here')).toEqual([]);
		});
	});

	// ─── detectDeviations ───────────────────────────────────────────────

	describe('detectDeviations', () => {
		it('should detect error-fix sequences', () => {
			const entries = [
				{ summary: 'Try compilation', success: false },
				{ summary: 'Fix syntax error', success: true },
			];
			const deviations = analyzer.detectDeviations(entries);
			expect(deviations.some((d) => d.type === 'error-fix')).toBe(true);
		});

		it('should detect backtrack keywords', () => {
			const entries = [{ summary: 'Revert to previous approach', success: true }];
			const deviations = analyzer.detectDeviations(entries);
			expect(deviations.some((d) => d.type === 'backtrack')).toBe(true);
		});

		it('should detect approach-change keywords', () => {
			const entries = [{ summary: 'Try a different approach to solve this', success: true }];
			const deviations = analyzer.detectDeviations(entries);
			expect(deviations.some((d) => d.type === 'approach-change')).toBe(true);
		});

		it('should return empty for clean history', () => {
			const entries = [
				{ summary: 'Step 1 done', success: true },
				{ summary: 'Step 2 done', success: true },
			];
			expect(analyzer.detectDeviations(entries)).toEqual([]);
		});
	});
});
