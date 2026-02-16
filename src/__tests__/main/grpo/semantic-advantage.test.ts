/**
 * Tests for SemanticAdvantageGenerator — LLM introspection engine for Training-Free GRPO.
 *
 * Tests cover: variance check, prompt construction, response parsing, operation validation,
 * operation limits, output truncation, retry logic, and reward signal breakdown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron
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

// Mock context-groomer
vi.mock('../../../main/utils/context-groomer', () => ({
	groomContext: vi.fn(),
}));

import {
	truncateRolloutOutput,
	buildIntrospectionPrompt,
	parseIntrospectionResponse,
	spawnIntrospectionAgent,
	generateAdvantage,
} from '../../../main/grpo/semantic-advantage';
import { groomContext } from '../../../main/utils/context-groomer';
import { captureException } from '../../../main/utils/sentry';
import type {
	RolloutGroup,
	RolloutOutput,
	ExperienceEntry,
	GRPOConfig,
	RewardSignal,
} from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';
import type { GroomingProcessManager } from '../../../main/utils/context-groomer';
import type { AgentDetector } from '../../../main/agents';

// ─── Test Helpers ────────────────────────────────────────────────────

function makeRewardSignal(type: RewardSignal['type'], score: number, description: string): RewardSignal {
	return { type, score, description, collectedAt: Date.now() };
}

function makeRolloutOutput(overrides: Partial<RolloutOutput> = {}): RolloutOutput {
	return {
		index: 0,
		agentType: 'claude-code',
		sessionId: 'session-1',
		prompt: 'Fix the failing tests',
		output: 'I fixed the tests by updating the assertions.',
		rewards: [
			makeRewardSignal('test-pass', 1.0, 'All 5 tests pass'),
			makeRewardSignal('build-success', 1.0, 'Build succeeded'),
		],
		aggregateReward: 0.8,
		durationMs: 30000,
		...overrides,
	};
}

function makeRolloutGroup(overrides: Partial<RolloutGroup> = {}): RolloutGroup {
	return {
		id: 'rg-test-001',
		taskPrompt: 'Fix the failing tests in the authentication module',
		projectPath: '/home/user/my-project',
		outputs: [
			makeRolloutOutput({ index: 0, aggregateReward: 0.9 }),
			makeRolloutOutput({ index: 1, aggregateReward: 0.3, output: 'I tried but the tests still fail.' }),
			makeRolloutOutput({ index: 2, aggregateReward: 0.6, output: 'Partially fixed the tests.' }),
		],
		groupSize: 3,
		meanReward: 0.6,
		rewardStdDev: 0.25,
		experienceVersion: 1,
		epoch: 2,
		createdAt: Date.now(),
		...overrides,
	};
}

function makeExperienceEntry(overrides: Partial<ExperienceEntry> = {}): ExperienceEntry {
	return {
		id: 'exp-001',
		content: 'Always run tests before committing changes',
		category: 'testing',
		scope: 'project',
		agentType: 'all',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		evidenceCount: 2,
		useCount: 5,
		lastRolloutGroupId: null,
		tokenEstimate: 10,
		...overrides,
	};
}

function makeConfig(overrides: Partial<GRPOConfig> = {}): GRPOConfig {
	return { ...GRPO_CONFIG_DEFAULTS, ...overrides };
}

function makeMockProcessManager(): GroomingProcessManager {
	return {
		spawn: vi.fn().mockReturnValue({ pid: 1234, success: true }),
		on: vi.fn(),
		off: vi.fn(),
		kill: vi.fn(),
	};
}

function makeMockAgentDetector(): AgentDetector {
	return {
		getAgent: vi.fn().mockResolvedValue({
			id: 'claude-code',
			name: 'Claude Code',
			binaryName: 'claude',
			command: 'claude',
			args: [],
			available: true,
			capabilities: {},
			readOnlyArgs: ['--permission-mode', 'plan'],
			batchModeArgs: ['--print'],
			promptArgs: (p: string) => ['-p', p],
		}),
		detectAgents: vi.fn().mockResolvedValue([
			{
				id: 'claude-code',
				name: 'Claude Code',
				binaryName: 'claude',
				command: 'claude',
				args: [],
				available: true,
				capabilities: {},
			},
		]),
		clearCache: vi.fn(),
		clearModelCache: vi.fn(),
		discoverModels: vi.fn(),
		setCustomPaths: vi.fn(),
		getCustomPaths: vi.fn(),
	} as unknown as AgentDetector;
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('SemanticAdvantageGenerator', () => {
	const mockGroomContext = vi.mocked(groomContext);
	let mockProcessManager: GroomingProcessManager;
	let mockAgentDetector: AgentDetector;

	beforeEach(() => {
		vi.clearAllMocks();
		mockProcessManager = makeMockProcessManager();
		mockAgentDetector = makeMockAgentDetector();
	});

	// ─── Test 1: Low variance → empty operations ──────────────────

	describe('variance threshold check', () => {
		it('should return empty operations when variance is below threshold', async () => {
			const group = makeRolloutGroup({ rewardStdDev: 0.05 });
			const config = makeConfig({ varianceThreshold: 0.1 });

			const result = await generateAdvantage(
				group,
				[],
				config,
				mockProcessManager,
				mockAgentDetector,
			);

			expect(result.operations).toHaveLength(0);
			expect(result.analysis).toContain('below threshold');
			expect(result.rolloutGroupId).toBe('rg-test-001');
			expect(mockGroomContext).not.toHaveBeenCalled();
		});
	});

	// ─── Test 2: Prompt built correctly with sorted rollouts ──────

	describe('buildIntrospectionPrompt', () => {
		it('should include rollouts sorted by score (best to worst)', () => {
			const group = makeRolloutGroup();
			const library = [makeExperienceEntry()];

			const prompt = buildIntrospectionPrompt(group, library);

			// Verify rollouts are sorted best-to-worst
			const rollout1Pos = prompt.indexOf('Rollout 1 (score: 0.90)');
			const rollout2Pos = prompt.indexOf('Rollout 2 (score: 0.60)');
			const rollout3Pos = prompt.indexOf('Rollout 3 (score: 0.30)');

			expect(rollout1Pos).toBeGreaterThan(-1);
			expect(rollout2Pos).toBeGreaterThan(-1);
			expect(rollout3Pos).toBeGreaterThan(-1);
			expect(rollout1Pos).toBeLessThan(rollout2Pos);
			expect(rollout2Pos).toBeLessThan(rollout3Pos);
		});

		it('should include the task prompt', () => {
			const group = makeRolloutGroup();
			const prompt = buildIntrospectionPrompt(group, []);

			expect(prompt).toContain('Fix the failing tests in the authentication module');
		});

		it('should include current experience library entries', () => {
			const group = makeRolloutGroup();
			const library = [
				makeExperienceEntry({ id: 'exp-001', content: 'Always run tests before committing' }),
				makeExperienceEntry({ id: 'exp-002', content: 'Use dependency injection for testing', category: 'architecture' }),
			];

			const prompt = buildIntrospectionPrompt(group, library);

			expect(prompt).toContain('[exp-001]');
			expect(prompt).toContain('Always run tests before committing');
			expect(prompt).toContain('[exp-002]');
			expect(prompt).toContain('Use dependency injection for testing');
		});

		it('should show empty library message when no experiences exist', () => {
			const group = makeRolloutGroup();
			const prompt = buildIntrospectionPrompt(group, []);

			expect(prompt).toContain('empty — no existing experiences');
		});

		it('should include reward signal breakdown (not just aggregate score)', () => {
			const group = makeRolloutGroup();
			const prompt = buildIntrospectionPrompt(group, []);

			expect(prompt).toContain('test-pass: 1.00');
			expect(prompt).toContain('build-success: 1.00');
			expect(prompt).toContain('All 5 tests pass');
		});
	});

	// ─── Test 3: Valid JSON operations extracted ──────────────────

	describe('parseIntrospectionResponse', () => {
		it('should extract valid operations from well-formed response', () => {
			const response = `
ANALYSIS: The first rollout succeeded because it correctly identified the broken assertion.

OPERATIONS:
[
  {"operation": "add", "content": "Check assertion messages match expected format", "category": "testing", "reasoning": "Rollout 1 fixed assertions while others missed them"},
  {"operation": "modify", "targetId": "exp-001", "content": "Updated testing practice", "reasoning": "Evidence supports modification"}
]`;

			const { analysis, operations } = parseIntrospectionResponse(response);

			expect(analysis).toContain('correctly identified the broken assertion');
			expect(operations).toHaveLength(2);
			expect(operations[0].operation).toBe('add');
			expect(operations[0].content).toBe('Check assertion messages match expected format');
			expect(operations[0].category).toBe('testing');
			expect(operations[1].operation).toBe('modify');
			expect(operations[1].targetId).toBe('exp-001');
		});

		// ─── Test 4: Malformed JSON falls back to empty ──────────

		it('should return empty operations when JSON is malformed', () => {
			const response = `
ANALYSIS: Something useful here.

OPERATIONS:
This is not JSON at all {broken}`;

			const { analysis, operations } = parseIntrospectionResponse(response);

			expect(analysis).toBe('Something useful here.');
			expect(operations).toHaveLength(0);
		});

		it('should return raw text as analysis when no markers present', () => {
			const response = 'Just some plain text without any markers';

			const { analysis, operations } = parseIntrospectionResponse(response);

			expect(analysis).toBe('Just some plain text without any markers');
			expect(operations).toHaveLength(0);
		});

		// ─── Test 5: Invalid operations filtered ─────────────────

		it('should filter out operations missing required fields', () => {
			const response = `
ANALYSIS: Test analysis.

OPERATIONS:
[
  {"operation": "add", "content": "Valid add", "category": "testing", "reasoning": "Good reason"},
  {"operation": "modify", "content": "Missing targetId", "reasoning": "Bad"},
  {"operation": "delete", "reasoning": "Missing targetId too"},
  {"operation": "add", "category": "testing", "reasoning": "Missing content"},
  {"operation": "delete", "targetId": "exp-001", "reasoning": "Valid delete"}
]`;

			const { operations } = parseIntrospectionResponse(response);

			expect(operations).toHaveLength(2);
			expect(operations[0].operation).toBe('add');
			expect(operations[0].content).toBe('Valid add');
			expect(operations[1].operation).toBe('delete');
			expect(operations[1].targetId).toBe('exp-001');
		});

		// ─── Test 6: Operation limit ─────────────────────────────

		it('should truncate operations exceeding the limit of 5', () => {
			const ops = Array.from({ length: 8 }, (_, i) => ({
				operation: 'add',
				content: `Experience ${i}`,
				category: 'testing',
				reasoning: `Reason ${i}`,
			}));

			const response = `
ANALYSIS: Many insights.

OPERATIONS:
${JSON.stringify(ops)}`;

			const { operations } = parseIntrospectionResponse(response);

			expect(operations).toHaveLength(5);
		});

		it('should handle operations inside code fences', () => {
			const response = `
ANALYSIS: Test.

OPERATIONS:
\`\`\`json
[{"operation": "add", "content": "Fenced op", "category": "patterns", "reasoning": "Test"}]
\`\`\``;

			const { operations } = parseIntrospectionResponse(response);

			expect(operations).toHaveLength(1);
			expect(operations[0].content).toBe('Fenced op');
		});

		it('should normalize invalid categories to patterns', () => {
			const response = `
ANALYSIS: Test.

OPERATIONS:
[{"operation": "add", "content": "Some insight", "category": "invalid-category", "reasoning": "Test"}]`;

			const { operations } = parseIntrospectionResponse(response);

			expect(operations).toHaveLength(1);
			expect(operations[0].category).toBe('patterns');
		});
	});

	// ─── Test 8: Analysis text extraction ─────────────────────────

	describe('analysis extraction', () => {
		it('should correctly extract analysis text between markers', () => {
			const response = `
ANALYSIS: The high-scoring rollout used a systematic approach to debugging by first running
the test suite, identifying the failing test, and then fixing the root cause. The low-scoring
rollout attempted to fix the issue without understanding the test failures.

OPERATIONS:
[{"operation": "add", "content": "Run tests first", "category": "testing", "reasoning": "Evidence supports"}]`;

			const { analysis } = parseIntrospectionResponse(response);

			expect(analysis).toContain('systematic approach to debugging');
			expect(analysis).toContain('without understanding the test failures');
			expect(analysis).not.toContain('OPERATIONS');
		});
	});

	// ─── Test 9: Output truncation ────────────────────────────────

	describe('truncateRolloutOutput', () => {
		it('should return short output unchanged', () => {
			const short = 'This is a short output';
			expect(truncateRolloutOutput(short, 20000)).toBe(short);
		});

		it('should truncate long output with marker', () => {
			const long = 'A'.repeat(30000);
			const truncated = truncateRolloutOutput(long, 20000);

			expect(truncated.length).toBeLessThan(long.length);
			expect(truncated).toContain('[...truncated 30000 total chars...]');

			// Should have head and tail
			const headSize = Math.floor(20000 / 2);
			expect(truncated.startsWith('A'.repeat(100))).toBe(true);
			expect(truncated.endsWith('A'.repeat(100))).toBe(true);
		});

		it('should use default maxChars of 20000', () => {
			const long = 'B'.repeat(25000);
			const truncated = truncateRolloutOutput(long);

			expect(truncated).toContain('[...truncated 25000 total chars...]');
		});

		it('should not truncate output at exactly maxChars', () => {
			const exact = 'C'.repeat(20000);
			expect(truncateRolloutOutput(exact, 20000)).toBe(exact);
		});
	});

	// ─── Test 10: Retry logic ─────────────────────────────────────

	describe('retry logic', () => {
		it('should retry once on first failure then succeed', async () => {
			const group = makeRolloutGroup();
			const config = makeConfig();

			// First call fails, second succeeds
			mockGroomContext
				.mockRejectedValueOnce(new Error('Agent timeout'))
				.mockResolvedValueOnce({
					response: 'ANALYSIS: Retry succeeded.\n\nOPERATIONS:\n[{"operation": "add", "content": "Learned from retry", "category": "debugging", "reasoning": "Retry test"}]',
					durationMs: 5000,
					completionReason: 'process exited with code 0',
				});

			const result = await generateAdvantage(
				group,
				[],
				config,
				mockProcessManager,
				mockAgentDetector,
			);

			expect(mockGroomContext).toHaveBeenCalledTimes(2);
			expect(result.operations).toHaveLength(1);
			expect(result.operations[0].content).toBe('Learned from retry');
		});

		it('should return empty operations after two consecutive failures', async () => {
			const group = makeRolloutGroup();
			const config = makeConfig();

			mockGroomContext
				.mockRejectedValueOnce(new Error('Agent timeout'))
				.mockRejectedValueOnce(new Error('Agent timeout again'));

			const result = await generateAdvantage(
				group,
				[],
				config,
				mockProcessManager,
				mockAgentDetector,
			);

			expect(mockGroomContext).toHaveBeenCalledTimes(2);
			expect(result.operations).toHaveLength(0);
			expect(result.analysis).toContain('failed after 2 attempts');
			expect(captureException).toHaveBeenCalled();
		});
	});

	// ─── Test 11: Reward signal breakdown in prompt ───────────────

	describe('reward signal breakdown in prompt', () => {
		it('should include individual reward signals, not just aggregate', () => {
			const group = makeRolloutGroup({
				outputs: [
					makeRolloutOutput({
						index: 0,
						aggregateReward: 0.7,
						rewards: [
							makeRewardSignal('test-pass', 1.0, 'All tests pass'),
							makeRewardSignal('build-success', 1.0, 'Build OK'),
							makeRewardSignal('lint-clean', 0.0, '12 lint errors'),
						],
					}),
					makeRolloutOutput({
						index: 1,
						aggregateReward: 0.2,
						rewards: [
							makeRewardSignal('test-fail', 0.0, '3 tests failed'),
							makeRewardSignal('build-fail', 0.0, 'Build error'),
							makeRewardSignal('lint-clean', 0.8, '1 lint warning'),
						],
					}),
				],
			});

			const prompt = buildIntrospectionPrompt(group, []);

			// Check that individual signals are present
			expect(prompt).toContain('test-pass: 1.00');
			expect(prompt).toContain('All tests pass');
			expect(prompt).toContain('build-success: 1.00');
			expect(prompt).toContain('test-fail: 0.00');
			expect(prompt).toContain('3 tests failed');
			expect(prompt).toContain('lint-clean: 0.00');
			expect(prompt).toContain('12 lint errors');
		});
	});

	// ─── Agent spawning ───────────────────────────────────────────

	describe('spawnIntrospectionAgent', () => {
		it('should fall back to available agent when configured agent is unavailable', async () => {
			const config = makeConfig({ introspectionAgent: 'codex' });

			const detector = {
				getAgent: vi.fn()
					.mockResolvedValueOnce(null) // codex not available
					.mockResolvedValueOnce({ id: 'claude-code', available: true, command: 'claude', args: [] }),
				detectAgents: vi.fn().mockResolvedValue([
					{ id: 'claude-code', name: 'Claude Code', available: true, command: 'claude', args: [] },
					{ id: 'terminal', name: 'Terminal', available: true },
				]),
				clearCache: vi.fn(),
				clearModelCache: vi.fn(),
				discoverModels: vi.fn(),
				setCustomPaths: vi.fn(),
				getCustomPaths: vi.fn(),
			} as unknown as AgentDetector;

			mockGroomContext.mockResolvedValueOnce({
				response: 'Fallback agent response',
				durationMs: 1000,
				completionReason: 'process exited with code 0',
			});

			const result = await spawnIntrospectionAgent(
				'test prompt',
				'/project',
				config,
				mockProcessManager,
				detector,
			);

			expect(result).toBe('Fallback agent response');
			// Should have called groomContext with claude-code (not terminal)
			expect(mockGroomContext).toHaveBeenCalledWith(
				expect.objectContaining({ agentType: 'claude-code' }),
				mockProcessManager,
				detector,
			);
		});
	});

	// ─── Full integration of generateAdvantage ────────────────────

	describe('generateAdvantage full flow', () => {
		it('should generate advantage with high variance group', async () => {
			const group = makeRolloutGroup();
			const library = [makeExperienceEntry()];
			const config = makeConfig();

			mockGroomContext.mockResolvedValueOnce({
				response: `ANALYSIS: Rollout 1 succeeded by running tests first and fixing root cause. Rollout 2 failed by guessing at fixes.

OPERATIONS:
[
  {"operation": "add", "content": "Always run the test suite before attempting fixes", "category": "testing", "reasoning": "Rollout 1 ran tests first and scored 0.9"},
  {"operation": "modify", "targetId": "exp-001", "content": "Run tests before AND after committing changes", "reasoning": "Existing experience is incomplete"}
]`,
				durationMs: 15000,
				completionReason: 'process exited with code 0',
			});

			const result = await generateAdvantage(
				group,
				library,
				config,
				mockProcessManager,
				mockAgentDetector,
			);

			expect(result.rolloutGroupId).toBe('rg-test-001');
			expect(result.analysis).toContain('running tests first');
			expect(result.operations).toHaveLength(2);
			expect(result.operations[0].operation).toBe('add');
			expect(result.operations[1].operation).toBe('modify');
			expect(result.operations[1].targetId).toBe('exp-001');
			expect(result.introspectionModel).toBe(GRPO_CONFIG_DEFAULTS.introspectionModel);
			expect(result.generatedAt).toBeGreaterThan(0);
		});
	});
});
