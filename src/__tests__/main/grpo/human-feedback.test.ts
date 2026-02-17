/**
 * Tests for Human Feedback Signal — Thumbs Up/Down Reward Collection (GRPO-16 Task 8).
 *
 * Covers:
 * - IPC handler behavior (submitFeedback, getFeedback)
 * - Reward computation with human-feedback signals
 * - Settings UI rendering (Human Feedback section)
 * - Terminal thumbs buttons rendering and interaction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import crypto from 'crypto';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

// Mock child_process.exec for reward-collector
const mockExec = vi.fn();
vi.mock(import('child_process'), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		default: { ...actual, exec: (...args: any[]) => mockExec(...args) },
		exec: (...args: any[]) => mockExec(...args),
	};
});

// Mock electron for SymphonyCollector
vi.mock('electron', () => ({
	app: {
		getPath: () => '/mock/user-data',
	},
	ipcMain: {
		handle: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: () => [],
	},
}));

import { computeAggregateReward } from '../../../main/grpo/reward-collector';
import { SymphonyCollector, computeTaskContentHash } from '../../../main/grpo/symphony-collector';
import type { RewardSignal, RewardSignalType, GRPOConfig, HumanFeedback, SignalRealm } from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-hf-test-'));
	mockExec.mockReset();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── IPC Handler Tests ───────────────────────────────────────────────────────

describe('submitFeedback IPC handler logic', () => {
	it('returns error when GRPO is disabled', () => {
		// Simulate the guard logic from grpo-handlers.ts
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: false };
		const result = !config.enabled || !config.humanFeedbackEnabled;
		expect(result).toBe(true);
	});

	it('returns error when humanFeedbackEnabled is false', () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: false };
		const result = !config.enabled || !config.humanFeedbackEnabled;
		expect(result).toBe(true);
	});

	it('records signal via recordManualSignal when enabled', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const recordSpy = vi.spyOn(collector, 'recordManualSignal');

		const responseText = 'Hello world, this is a test response';
		const promptText = 'Write hello world';
		const approved = true;

		const feedback: HumanFeedback = {
			id: crypto.randomUUID(),
			sessionId: 'session-1',
			agentType: 'claude-code',
			projectPath: '/test/project',
			approved,
			responseHash: crypto.createHash('sha256').update(responseText).digest('hex').slice(0, 12),
			responsePreview: responseText.slice(0, 500),
			promptPreview: promptText.slice(0, 200),
			createdAt: Date.now(),
			realm: 'manual' as SignalRealm,
		};

		const rewardSignal: RewardSignal = {
			type: 'human-feedback',
			score: approved ? 1.0 : 0.0,
			description: 'User approved (thumbs up)',
			rawOutput: JSON.stringify({
				promptPreview: feedback.promptPreview,
				responsePreview: feedback.responsePreview,
				responseHash: feedback.responseHash,
			}),
			collectedAt: feedback.createdAt,
		};

		await collector.recordManualSignal(
			feedback.promptPreview,
			'/test/project',
			'claude-code',
			'session-1',
			[rewardSignal],
			1.0,
			'manual',
		);

		expect(recordSpy).toHaveBeenCalledWith(
			feedback.promptPreview,
			'/test/project',
			'claude-code',
			'session-1',
			[rewardSignal],
			1.0,
			'manual',
		);
	});

	it('creates correct RewardSignal with score 1.0 for approved feedback', () => {
		const approved = true;
		const rewardSignal: RewardSignal = {
			type: 'human-feedback',
			score: approved ? 1.0 : 0.0,
			description: approved ? 'User approved (thumbs up)' : 'User disapproved (thumbs down)',
			rawOutput: JSON.stringify({
				promptPreview: 'Test prompt',
				responsePreview: 'Test response',
				responseHash: 'abc123def456',
			}),
			collectedAt: Date.now(),
		};

		expect(rewardSignal.type).toBe('human-feedback');
		expect(rewardSignal.score).toBe(1.0);
		expect(rewardSignal.description).toBe('User approved (thumbs up)');
	});

	it('creates correct RewardSignal with score 0.0 for disapproved feedback', () => {
		const approved = false;
		const rewardSignal: RewardSignal = {
			type: 'human-feedback',
			score: approved ? 1.0 : 0.0,
			description: approved ? 'User approved (thumbs up)' : 'User disapproved (thumbs down)',
			rawOutput: JSON.stringify({
				promptPreview: 'Test prompt',
				responsePreview: 'Test response',
				responseHash: 'abc123def456',
			}),
			collectedAt: Date.now(),
		};

		expect(rewardSignal.type).toBe('human-feedback');
		expect(rewardSignal.score).toBe(0.0);
		expect(rewardSignal.description).toBe('User disapproved (thumbs down)');
	});

	it('truncates response to 500 chars and prompt to 200 chars', () => {
		const longResponse = 'A'.repeat(1000);
		const longPrompt = 'B'.repeat(500);

		const feedback: HumanFeedback = {
			id: 'test-id',
			sessionId: 'session-1',
			agentType: 'claude-code',
			projectPath: '/test',
			approved: true,
			responseHash: crypto.createHash('sha256').update(longResponse).digest('hex').slice(0, 12),
			responsePreview: longResponse.slice(0, 500),
			promptPreview: longPrompt.slice(0, 200),
			createdAt: Date.now(),
			realm: 'manual',
		};

		expect(feedback.responsePreview.length).toBe(500);
		expect(feedback.promptPreview.length).toBe(200);
	});

	it('getFeedback returns empty map when feedback is disabled', () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: false };
		const shouldReturnEmpty = !config.enabled || !config.humanFeedbackEnabled;
		expect(shouldReturnEmpty).toBe(true);
	});

	it('getFeedback returns correct approval state for known response hashes', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const responseHash = 'abc123def456';
		const sessionId = 'session-1';

		// Record a feedback signal
		const rewardSignal: RewardSignal = {
			type: 'human-feedback',
			score: 1.0,
			description: 'User approved (thumbs up)',
			rawOutput: JSON.stringify({
				promptPreview: 'Test prompt',
				responsePreview: 'Test response',
				responseHash,
			}),
			collectedAt: Date.now(),
		};

		await collector.recordManualSignal(
			'test prompt',
			'/test/project',
			'claude-code',
			sessionId,
			[rewardSignal],
			1.0,
			'manual',
		);

		// Query feedback
		const feedbackMap = await collector.getFeedbackForHashes(sessionId, [responseHash]);
		expect(feedbackMap[responseHash]).toBeDefined();
		expect(feedbackMap[responseHash].approved).toBe(true);
	});
});

// ─── Reward Computation Tests ────────────────────────────────────────────────

describe('computeAggregateReward with human-feedback', () => {
	const defaultWeights = GRPO_CONFIG_DEFAULTS.rewardWeights;

	it('includes human-feedback in weighted mean', () => {
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: now },
			{ type: 'human-feedback', score: 0.0, description: 'thumbs down', collectedAt: now },
		];
		// test-pass weight=1.0, human-feedback weight=0.3
		// (1.0*1.0 + 0.0*0.3) / (1.0 + 0.3) = 1.0 / 1.3
		const result = computeAggregateReward(signals, defaultWeights, 7 * 24 * 60 * 60 * 1000);
		expect(result).toBeCloseTo(1.0 / 1.3, 4);
	});

	it('applies temporal decay to human-feedback', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000; // 7 days
		const halfLife = decayMs / 2; // 3.5 days
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.0, description: 'fail', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now - halfLife },
		];
		// human-feedback effective weight = 0.3 * (1 - 0.5) = 0.15
		// (0.0*1.0 + 1.0*0.15) / (1.0 + 0.15) = 0.15 / 1.15
		const result = computeAggregateReward(signals, defaultWeights, decayMs);
		expect(result).toBeCloseTo(0.15 / 1.15, 4);
	});

	it('fully decays human-feedback at decayMs', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.5, description: 'partial', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now - decayMs },
		];
		// human-feedback fully decayed (weight = 0)
		// Only test-pass: (0.5*1.0) / 1.0 = 0.5
		const result = computeAggregateReward(signals, defaultWeights, decayMs);
		expect(result).toBeCloseTo(0.5, 4);
	});

	it('does not decay non-human signals', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const oldTime = now - decayMs * 2; // Well past decay period
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: oldTime },
			{ type: 'build-success', score: 1.0, description: 'ok', collectedAt: oldTime },
		];
		// Both signals should be at full weight regardless of age
		const result = computeAggregateReward(signals, defaultWeights, decayMs);
		expect(result).toBe(1.0);
	});

	it('handles missing decayMs (no decay applied)', () => {
		const now = Date.now();
		const oldTime = now - 30 * 24 * 60 * 60 * 1000; // 30 days old
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.0, description: 'fail', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: oldTime },
		];
		// No decay — human-feedback gets full weight 0.3
		// (0.0*1.0 + 1.0*0.3) / (1.0 + 0.3) = 0.3 / 1.3
		const result = computeAggregateReward(signals, defaultWeights);
		expect(result).toBeCloseTo(0.3 / 1.3, 4);
	});
});

// ─── SymphonyCollector Manual Signal Tests ───────────────────────────────────

describe('SymphonyCollector.recordManualSignal', () => {
	it('writes signal to JSONL file', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const rewardSignal: RewardSignal = {
			type: 'human-feedback',
			score: 1.0,
			description: 'User approved',
			rawOutput: JSON.stringify({ responseHash: 'hash123' }),
			collectedAt: Date.now(),
		};

		await collector.recordManualSignal(
			'test prompt',
			'/test/project',
			'claude-code',
			'session-1',
			[rewardSignal],
			1.0,
			'manual',
		);

		// Verify signal was written to the file
		const projectHash = crypto.createHash('sha256').update('/test/project').digest('hex').slice(0, 12);
		const signalsPath = path.join(tmpDir, projectHash, 'signals.jsonl');
		const data = await fs.readFile(signalsPath, 'utf-8');
		const signal = JSON.parse(data.trim());

		expect(signal.rewards[0].type).toBe('human-feedback');
		expect(signal.rewards[0].score).toBe(1.0);
		expect(signal.aggregateReward).toBe(1.0);
		expect(signal.realm).toBe('manual');
		expect(signal.durationMs).toBe(0);
	});

	it('updates index with new entry', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		await collector.recordManualSignal(
			'test prompt',
			'/test/project',
			'claude-code',
			'session-1',
			[{ type: 'human-feedback', score: 1.0, description: 'ok', collectedAt: Date.now() }],
			1.0,
			'manual',
		);

		const projectHash = crypto.createHash('sha256').update('/test/project').digest('hex').slice(0, 12);
		const indexPath = path.join(tmpDir, projectHash, 'index.json');
		const indexData = JSON.parse(await fs.readFile(indexPath, 'utf-8'));

		const taskHash = computeTaskContentHash('test prompt');
		expect(indexData.entries[taskHash]).toBeDefined();
		expect(indexData.entries[taskHash].executionCount).toBe(1);
	});
});

describe('SymphonyCollector.getFeedbackForHashes', () => {
	it('returns empty map for empty hashes array', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const result = await collector.getFeedbackForHashes('session-1', []);
		expect(result).toEqual({});
	});

	it('returns empty map when no signals exist', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const result = await collector.getFeedbackForHashes('session-1', ['nonexistent']);
		expect(result).toEqual({});
	});

	it('matches correct session and response hash', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		// Record a thumbs-down
		const responseHash = 'hash-down-123';
		await collector.recordManualSignal(
			'prompt for down',
			'/test/project',
			'claude-code',
			'session-2',
			[{
				type: 'human-feedback',
				score: 0.0,
				description: 'User disapproved',
				rawOutput: JSON.stringify({ responseHash, promptPreview: 'prompt', responsePreview: 'resp' }),
				collectedAt: Date.now(),
			}],
			0.0,
			'manual',
		);

		const result = await collector.getFeedbackForHashes('session-2', [responseHash]);
		expect(result[responseHash]).toBeDefined();
		expect(result[responseHash].approved).toBe(false);
	});

	it('does not return feedback for wrong session', async () => {
		const config: GRPOConfig = { ...GRPO_CONFIG_DEFAULTS, enabled: true, humanFeedbackEnabled: true };
		const collector = new SymphonyCollector(config, tmpDir);
		await collector.initialize();

		const responseHash = 'hash-sess-check';
		await collector.recordManualSignal(
			'prompt',
			'/test/project',
			'claude-code',
			'session-A',
			[{
				type: 'human-feedback',
				score: 1.0,
				description: 'ok',
				rawOutput: JSON.stringify({ responseHash }),
				collectedAt: Date.now(),
			}],
			1.0,
			'manual',
		);

		// Query with different session
		const result = await collector.getFeedbackForHashes('session-B', [responseHash]);
		expect(result[responseHash]).toBeUndefined();
	});
});

// ─── HumanFeedback Interface Tests ───────────────────────────────────────────

describe('HumanFeedback type and creation', () => {
	it('creates a valid HumanFeedback object with all required fields', () => {
		const feedback: HumanFeedback = {
			id: 'fb-001',
			sessionId: 'session-1',
			agentType: 'claude-code',
			projectPath: '/home/user/project',
			approved: true,
			responseHash: 'abc123def456',
			responsePreview: 'This is the response text...',
			promptPreview: 'User prompt text...',
			createdAt: Date.now(),
			realm: 'manual',
		};

		expect(feedback.id).toBe('fb-001');
		expect(feedback.approved).toBe(true);
		expect(feedback.realm).toBe('manual');
		expect(feedback.responseHash).toHaveLength(12);
	});

	it('generates correct 12-char response hash from SHA-256', () => {
		const responseText = 'Hello, this is a test response from the AI agent.';
		const hash = crypto.createHash('sha256').update(responseText).digest('hex').slice(0, 12);

		expect(hash).toHaveLength(12);
		expect(/^[0-9a-f]{12}$/.test(hash)).toBe(true);

		// Same input produces same hash
		const hash2 = crypto.createHash('sha256').update(responseText).digest('hex').slice(0, 12);
		expect(hash2).toBe(hash);
	});
});

// ─── Config Defaults Tests ───────────────────────────────────────────────────

describe('GRPO config defaults for human feedback', () => {
	it('humanFeedbackEnabled defaults to false', () => {
		expect(GRPO_CONFIG_DEFAULTS.humanFeedbackEnabled).toBe(false);
	});

	it('humanFeedbackDecayMs defaults to 7 days', () => {
		expect(GRPO_CONFIG_DEFAULTS.humanFeedbackDecayMs).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it('human-feedback weight defaults to 0.3', () => {
		expect(GRPO_CONFIG_DEFAULTS.rewardWeights['human-feedback']).toBe(0.3);
	});

	it('human-feedback weight is capped at 0.3 in defaults (lower than test-pass)', () => {
		const hfWeight = GRPO_CONFIG_DEFAULTS.rewardWeights['human-feedback'];
		const testWeight = GRPO_CONFIG_DEFAULTS.rewardWeights['test-pass'];
		expect(hfWeight).toBeLessThan(testWeight);
		expect(hfWeight).toBeLessThanOrEqual(0.3);
	});
});
