/**
 * Tests for RewardCollector — verifiable reward signal collection.
 *
 * Uses a real temp directory for project detection tests and vi.mock
 * for child_process.exec to control verification command outputs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock child_process.exec — vi.mock hoists above imports
const mockExec = vi.fn();
vi.mock(import('child_process'), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		default: { ...actual, exec: (...args: any[]) => mockExec(...args) },
		exec: (...args: any[]) => mockExec(...args),
	};
});

import {
	collectExitCodeReward,
	collectTaskCompleteReward,
	computeAggregateReward,
	detectProjectCommands,
	collectAllRewards,
	collectTestReward,
	collectBuildReward,
	collectLintReward,
	collectGitDiffReward,
	captureLintBaseline,
	collectCoverageReward,
	captureCoverageBaseline,
	runVerificationCommand,
	type ProjectCommands,
} from '../../../main/grpo/reward-collector';
import type { GRPOConfig, RewardSignal, RewardSignalType } from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

let tmpDir: string;

/** Default new GRPO-15 fields for ProjectCommands test objects */
const GRPO15_DEFAULTS = {
	coverageCommand: null,
	typeCheckCommand: null,
	complexityCommand: null,
	securityScanCommand: null,
	benchmarkCommand: null,
	bundleBuildCommand: null,
	manifestPath: null,
	apiSchemaPath: null,
} as const;

/** Helper to configure mockExec to simulate a command result */
function mockExecResult(opts: { stdout?: string; stderr?: string; exitCode?: number; killed?: boolean }) {
	mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
		const { stdout = '', stderr = '', exitCode = 0, killed = false } = opts;
		if (exitCode === 0 && !killed) {
			callback(null, stdout, stderr);
		} else {
			const error: any = new Error('command failed');
			error.code = exitCode;
			error.killed = killed;
			callback(error, stdout, stderr);
		}
		// Return a mock ChildProcess with an on method
		return { on: vi.fn() };
	});
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-reward-test-'));
	mockExec.mockReset();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── collectExitCodeReward ───────────────────────────────────────────────────

describe('collectExitCodeReward', () => {
	it('returns score 1.0 for exit code 0', () => {
		const signal = collectExitCodeReward(0);
		expect(signal.type).toBe('process-exit-code');
		expect(signal.score).toBe(1.0);
		expect(signal.description).toBe('Exit code: 0');
		expect(signal.collectedAt).toBeGreaterThan(0);
	});

	it('returns score 0.3 for exit code 1', () => {
		const signal = collectExitCodeReward(1);
		expect(signal.score).toBe(0.3);
		expect(signal.description).toBe('Exit code: 1');
	});

	it('returns score 0.0 for exit code 2', () => {
		const signal = collectExitCodeReward(2);
		expect(signal.score).toBe(0.0);
		expect(signal.description).toBe('Exit code: 2');
	});

	it('returns score 0.0 for exit code 137 (SIGKILL)', () => {
		const signal = collectExitCodeReward(137);
		expect(signal.score).toBe(0.0);
		expect(signal.description).toBe('Exit code: 137');
	});
});

// ─── collectTaskCompleteReward ───────────────────────────────────────────────

describe('collectTaskCompleteReward', () => {
	it('returns 1.0 for clean output and exit code 0', () => {
		const signal = collectTaskCompleteReward('Task completed. All files updated.', 0);
		expect(signal.type).toBe('task-complete');
		expect(signal.score).toBe(1.0);
		expect(signal.description).toBe('Task completed successfully');
	});

	it('returns 0.5 for output with error indicators but exit code 0', () => {
		const signal = collectTaskCompleteReward('Error: could not find file, but I worked around it.', 0);
		expect(signal.score).toBe(0.5);
		expect(signal.description).toContain('error indicators');
	});

	it('returns 0.0 for exit code 1', () => {
		const signal = collectTaskCompleteReward('Something went wrong', 1);
		expect(signal.score).toBe(0.0);
		expect(signal.description).toContain('exit code 1');
	});

	it('returns 0.5 for exit code 0 with warnings', () => {
		const signal = collectTaskCompleteReward('Done. warning: unused import detected.', 0);
		expect(signal.score).toBe(0.5);
		expect(signal.description).toBe('Task completed with warnings');
	});

	it('detects "I was unable to" as failure indicator', () => {
		const signal = collectTaskCompleteReward('I was unable to complete the task.', 0);
		expect(signal.score).toBe(0.5); // exit code 0 but has error indicator
	});

	it('detects "FAILED" as failure indicator', () => {
		const signal = collectTaskCompleteReward('Build FAILED with 3 errors.', 0);
		expect(signal.score).toBe(0.5);
	});
});

// ─── computeAggregateReward ──────────────────────────────────────────────────

describe('computeAggregateReward', () => {
	const defaultWeights = GRPO_CONFIG_DEFAULTS.rewardWeights;

	it('returns 0.5 for empty signals array', () => {
		expect(computeAggregateReward([], defaultWeights)).toBe(0.5);
	});

	it('computes weighted mean for single signal', () => {
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: Date.now() },
		];
		expect(computeAggregateReward(signals, defaultWeights)).toBe(1.0);
	});

	it('computes weighted mean for multiple signals', () => {
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: Date.now() },       // weight 1.0
			{ type: 'build-success', score: 1.0, description: 'ok', collectedAt: Date.now() },   // weight 1.0
			{ type: 'lint-clean', score: 0.5, description: 'ok', collectedAt: Date.now() },       // weight 0.8
			{ type: 'process-exit-code', score: 1.0, description: 'ok', collectedAt: Date.now() }, // weight 0.5
		];
		// (1.0*1.0 + 1.0*1.0 + 0.5*0.8 + 1.0*0.5) / (1.0 + 1.0 + 0.8 + 0.5) = 2.9 / 3.3
		const result = computeAggregateReward(signals, defaultWeights);
		expect(result).toBeCloseTo(2.9 / 3.3, 4);
	});

	it('handles signals with zero weight', () => {
		const signals: RewardSignal[] = [
			{ type: 'test-fail', score: 0.0, description: 'fail', collectedAt: Date.now() }, // weight 0.0
			{ type: 'task-complete', score: 1.0, description: 'ok', collectedAt: Date.now() }, // weight 1.0
		];
		// test-fail weight is 0.0, ignored: (1.0*1.0) / (1.0) = 1.0
		expect(computeAggregateReward(signals, defaultWeights)).toBe(1.0);
	});

	it('returns 0.5 when all signals have zero weight', () => {
		const signals: RewardSignal[] = [
			{ type: 'test-fail', score: 0.0, description: 'fail', collectedAt: Date.now() },
			{ type: 'build-fail', score: 0.0, description: 'fail', collectedAt: Date.now() },
			{ type: 'task-timeout', score: 0.0, description: 'timeout', collectedAt: Date.now() },
		];
		expect(computeAggregateReward(signals, defaultWeights)).toBe(0.5);
	});

	// ─── Human Feedback Decay Tests (GRPO-16 Task 7) ────────────────────────

	it('includes human-feedback in weighted mean at full weight when fresh', () => {
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now },
		];
		// test-pass weight=1.0, human-feedback weight=0.3
		// (1.0*1.0 + 1.0*0.3) / (1.0 + 0.3) = 1.3 / 1.3 = 1.0
		const result = computeAggregateReward(signals, defaultWeights, 7 * 24 * 60 * 60 * 1000);
		expect(result).toBeCloseTo(1.0, 4);
	});

	it('applies temporal decay to human-feedback at half-life', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000; // 7 days
		const halfLife = decayMs / 2; // 3.5 days
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now - halfLife },
		];
		// weight = 0.3 * max(0, 1 - 0.5) = 0.3 * 0.5 = 0.15
		// result = (1.0 * 0.15) / 0.15 = 1.0 (single signal, score doesn't change)
		// But the effective weight IS halved — test with a mixed signal set
		const mixedSignals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.0, description: 'fail', collectedAt: now },      // weight 1.0
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now - halfLife }, // effective weight 0.15
		];
		// (0.0*1.0 + 1.0*0.15) / (1.0 + 0.15) = 0.15 / 1.15
		const result = computeAggregateReward(mixedSignals, defaultWeights, decayMs);
		expect(result).toBeCloseTo(0.15 / 1.15, 4);
	});

	it('fully decays human-feedback at or beyond decayMs', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000; // 7 days
		const now = Date.now();
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.0, description: 'fail', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: now - decayMs },
		];
		// human-feedback effective weight = 0.3 * max(0, 1 - 1) = 0.0
		// Only test-pass contributes: (0.0*1.0) / (1.0) = 0.0
		const result = computeAggregateReward(signals, defaultWeights, decayMs);
		expect(result).toBeCloseTo(0.0, 4);
	});

	it('does not decay non-human-feedback signals', () => {
		const decayMs = 7 * 24 * 60 * 60 * 1000;
		const now = Date.now();
		const oldTime = now - decayMs; // 7 days old
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 1.0, description: 'ok', collectedAt: oldTime },
		];
		// test-pass should NOT be decayed regardless of age
		const result = computeAggregateReward(signals, defaultWeights, decayMs);
		expect(result).toBe(1.0);
	});

	it('handles missing decayMs (no decay applied to human feedback)', () => {
		const now = Date.now();
		const oldTime = now - 30 * 24 * 60 * 60 * 1000; // 30 days old
		const signals: RewardSignal[] = [
			{ type: 'test-pass', score: 0.0, description: 'fail', collectedAt: now },
			{ type: 'human-feedback', score: 1.0, description: 'thumbs up', collectedAt: oldTime },
		];
		// No decay applied — human-feedback gets full weight 0.3
		// (0.0*1.0 + 1.0*0.3) / (1.0 + 0.3) = 0.3 / 1.3
		const result = computeAggregateReward(signals, defaultWeights);
		expect(result).toBeCloseTo(0.3 / 1.3, 4);
	});
});

// ─── detectProjectCommands ───────────────────────────────────────────────────

describe('detectProjectCommands', () => {
	it('detects Node.js project with package.json', async () => {
		await fs.writeFile(
			path.join(tmpDir, 'package.json'),
			JSON.stringify({
				scripts: { test: 'jest', build: 'tsc', lint: 'eslint .' },
			}),
		);

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('node');
		expect(commands.testCommand).toBe('npm test');
		expect(commands.buildCommand).toBe('npm run build');
		expect(commands.lintCommand).toBe('npm run lint');
	});

	it('prefers vitest when vitest.config.ts exists', async () => {
		await fs.writeFile(
			path.join(tmpDir, 'package.json'),
			JSON.stringify({ scripts: { test: 'jest' } }),
		);
		await fs.writeFile(path.join(tmpDir, 'vitest.config.ts'), '');

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.testCommand).toBe('npx vitest run --reporter=verbose');
	});

	it('falls back to tsc for build when tsconfig.json exists but no build script', async () => {
		await fs.writeFile(
			path.join(tmpDir, 'package.json'),
			JSON.stringify({ scripts: {} }),
		);
		await fs.writeFile(path.join(tmpDir, 'tsconfig.json'), '{}');

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.buildCommand).toBe('npx tsc --noEmit');
	});

	it('detects Rust project with Cargo.toml', async () => {
		await fs.writeFile(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('rust');
		expect(commands.testCommand).toBe('cargo test');
		expect(commands.buildCommand).toBe('cargo check');
		expect(commands.lintCommand).toBe('cargo clippy -- -D warnings');
	});

	it('detects Python project with pyproject.toml and pytest', async () => {
		await fs.writeFile(
			path.join(tmpDir, 'pyproject.toml'),
			'[tool.pytest.ini_options]\ntestpaths = ["tests"]',
		);

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('python');
		expect(commands.testCommand).toBe('python -m pytest -v');
	});

	it('detects Python ruff lint config', async () => {
		await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
		await fs.writeFile(path.join(tmpDir, 'ruff.toml'), 'line-length = 100');

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('python');
		expect(commands.lintCommand).toBe('ruff check .');
	});

	it('detects Go project with go.mod', async () => {
		await fs.writeFile(path.join(tmpDir, 'go.mod'), 'module example.com/test\ngo 1.21');

		// Mock exec for golangci-lint --version to fail via spawn error (not installed)
		mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
			const child = {
				on: vi.fn((event: string, handler: Function) => {
					if (event === 'error') {
						// Simulate ENOENT — command not found
						process.nextTick(() => handler(new Error('spawn golangci-lint ENOENT')));
					}
				}),
			};
			return child;
		});

		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('go');
		expect(commands.testCommand).toBe('go test ./...');
		expect(commands.buildCommand).toBe('go build ./...');
		expect(commands.lintCommand).toBeNull();
	});

	it('returns unknown for empty directory', async () => {
		const commands = await detectProjectCommands(tmpDir);
		expect(commands.projectType).toBe('unknown');
		expect(commands.testCommand).toBeNull();
		expect(commands.buildCommand).toBeNull();
		expect(commands.lintCommand).toBeNull();
	});
});

// ─── collectAllRewards ───────────────────────────────────────────────────────

describe('collectAllRewards', () => {
	const commands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'unknown',
		...GRPO15_DEFAULTS,
	};

	it('skips collectors with weight 0', async () => {
		const config: GRPOConfig = {
			...GRPO_CONFIG_DEFAULTS,
			rewardWeights: {
				...GRPO_CONFIG_DEFAULTS.rewardWeights,
				'process-exit-code': 0,
				'task-complete': 0,
				'test-pass': 0,
				'test-fail': 0,
				'build-success': 0,
				'build-fail': 0,
				'lint-clean': 0,
				'lint-errors': 0,
				'git-diff-quality': 0,
				'task-timeout': 0,
			},
		};

		const signals = await collectAllRewards(tmpDir, 0, 'done', config, commands);
		expect(signals).toHaveLength(0);
	});

	it('skips collectors where no command was detected (returns null)', async () => {
		// Mock git diff to return something
		mockExecResult({ stdout: ' src/app.ts | 5 +++++\n 1 file changed, 5 insertions(+)' });

		const signals = await collectAllRewards(tmpDir, 0, 'done', GRPO_CONFIG_DEFAULTS, commands);

		const types = signals.map((s) => s.type);
		expect(types).toContain('process-exit-code');
		expect(types).toContain('task-complete');
		expect(types).toContain('git-diff-quality');
		expect(types).not.toContain('test-pass');
		expect(types).not.toContain('test-fail');
		expect(types).not.toContain('build-success');
		expect(types).not.toContain('build-fail');
	});

	it('includes synchronous signals for exit code 0', async () => {
		const config: GRPOConfig = {
			...GRPO_CONFIG_DEFAULTS,
			rewardWeights: {
				...GRPO_CONFIG_DEFAULTS.rewardWeights,
				'test-pass': 0,
				'test-fail': 0,
				'build-success': 0,
				'build-fail': 0,
				'lint-clean': 0,
				'lint-errors': 0,
				'git-diff-quality': 0,
			},
		};

		const signals = await collectAllRewards(tmpDir, 0, 'Task done.', config, commands);
		expect(signals).toHaveLength(2);

		const exitSignal = signals.find((s) => s.type === 'process-exit-code');
		expect(exitSignal?.score).toBe(1.0);

		const taskSignal = signals.find((s) => s.type === 'task-complete');
		expect(taskSignal?.score).toBe(1.0);
	});
});

// ─── Timeout handling ────────────────────────────────────────────────────────

describe('timeout handling', () => {
	it('returns default signal on timeout (killed process)', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const result = await runVerificationCommand('sleep 60', tmpDir, 100);
		expect(result.exitCode).toBe(-1);
	});

	it('test collector returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectTestReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});
});

// ─── Output truncation ──────────────────────────────────────────────────────

describe('output truncation', () => {
	it('caps very long stdout at 10KB', async () => {
		const longOutput = 'x'.repeat(20_000);
		mockExecResult({ stdout: longOutput });

		const result = await runVerificationCommand('echo long', tmpDir);
		// 10KB = 10240 chars + '\n... [truncated]' suffix
		expect(result.stdout.length).toBeLessThanOrEqual(10240 + 20);
		expect(result.stdout).toContain('... [truncated]');
	});
});

// ─── Lint delta scoring ─────────────────────────────────────────────────────

describe('lint delta scoring', () => {
	it('scores new errors relative to baseline', async () => {
		mockExecResult({ stdout: '15 problems (10 errors, 5 warnings)', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		// Baseline of 10 errors — 15 current means 5 new errors
		const signal = await collectLintReward(tmpDir, commands, 10);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('lint-errors');
		// score = max(0, 1 - 5/max(1,10)) = max(0, 1 - 0.5) = 0.5
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('baseline: 10');
		expect(signal!.description).toContain('new: 5');
	});

	it('scores 1.0 when errors decrease below baseline', async () => {
		mockExecResult({ stdout: '5 problems (5 errors, 0 warnings)', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		// Baseline of 10, current is 5 → newErrors = max(0, 5-10) = 0
		const signal = await collectLintReward(tmpDir, commands, 10);
		expect(signal!.score).toBe(1.0);
	});

	it('uses absolute scoring when no baseline provided', async () => {
		mockExecResult({ stdout: '25 problems (25 errors)', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectLintReward(tmpDir, commands);
		expect(signal!.type).toBe('lint-errors');
		// Absolute: max(0, 1 - 25/50) = 0.5
		expect(signal!.score).toBe(0.5);
	});
});

// ─── captureLintBaseline ─────────────────────────────────────────────────────

describe('captureLintBaseline', () => {
	it('returns null when no lint command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureLintBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns 0 for clean lint', async () => {
		mockExecResult({ stdout: '', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		expect(await captureLintBaseline(tmpDir, commands)).toBe(0);
	});

	it('returns error count for lint with errors', async () => {
		mockExecResult({ stdout: '12 problems (8 errors, 4 warnings)', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		expect(await captureLintBaseline(tmpDir, commands)).toBe(12);
	});
});

// ─── collectGitDiffReward ────────────────────────────────────────────────────

describe('collectGitDiffReward', () => {
	it('scores based on diff quality heuristics', async () => {
		const diffOutput = [
			' src/components/App.tsx      | 15 +++++++++------',
			' src/__tests__/app.test.ts   |  8 ++++++++',
			' 2 files changed, 17 insertions(+), 6 deletions(-)',
		].join('\n');

		mockExecResult({ stdout: diffOutput });

		const signal = await collectGitDiffReward(tmpDir);
		expect(signal.type).toBe('git-diff-quality');
		// 2 files ≤ 10: +0.2, 17 additions ≤ 200: +0.2, no binaries: +0.2, has tests: +0.2, no unwanted: +0.2
		expect(signal.score).toBe(1.0);
	});

	it('penalizes changes in node_modules', async () => {
		const diffOutput = [
			' node_modules/lodash/index.js | 1 +',
			' src/app.ts                   | 5 +++++',
			' 2 files changed, 6 insertions(+)',
		].join('\n');

		mockExecResult({ stdout: diffOutput });

		const signal = await collectGitDiffReward(tmpDir);
		// ≤10 files: +0.2, ≤200 additions: +0.2, no binaries: +0.2, no tests: 0, unwanted dirs: 0
		expect(signal.score).toBeCloseTo(0.6, 5);
	});
});

// ─── collectTestReward ───────────────────────────────────────────────────────

describe('collectTestReward', () => {
	it('returns null when no test command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectTestReward(tmpDir, commands)).toBeNull();
	});

	it('returns score 1.0 for passing tests', async () => {
		mockExecResult({ stdout: 'Tests  10 passed | 0 failed | 10 total', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectTestReward(tmpDir, commands);
		expect(signal!.type).toBe('test-pass');
		expect(signal!.score).toBe(1.0);
	});

	it('returns partial score for partially passing tests', async () => {
		mockExecResult({ stdout: 'Tests  7 passed | 3 failed | 10 total', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectTestReward(tmpDir, commands);
		expect(signal!.type).toBe('test-fail');
		expect(signal!.score).toBe(0.7);
		expect(signal!.description).toContain('7/10');
	});
});

// ─── collectBuildReward ──────────────────────────────────────────────────────

describe('collectBuildReward', () => {
	it('returns null when no build command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectBuildReward(tmpDir, commands)).toBeNull();
	});

	it('returns score 1.0 for successful build', async () => {
		mockExecResult({ stdout: 'Build successful', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npm run build',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectBuildReward(tmpDir, commands);
		expect(signal!.type).toBe('build-success');
		expect(signal!.score).toBe(1.0);
	});

	it('returns score 0.0 for failed build', async () => {
		mockExecResult({ stderr: 'error TS2304: Cannot find name', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npm run build',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectBuildReward(tmpDir, commands);
		expect(signal!.type).toBe('build-fail');
		expect(signal!.score).toBe(0.0);
	});
});

// ─── collectCoverageReward (GRPO-15 Task 2) ─────────────────────────────────

describe('collectCoverageReward', () => {
	const coverageCommands: ProjectCommands = {
		testCommand: 'npm test',
		buildCommand: null,
		lintCommand: null,
		projectType: 'node',
		...GRPO15_DEFAULTS,
		coverageCommand: 'npx vitest run --coverage --reporter=json',
	};

	it('returns null when no coverage command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectCoverageReward(tmpDir, commands)).toBeNull();
	});

	it('parses vitest/istanbul JSON coverage output correctly', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 85.5 }, statements: { pct: 82.0 }, branches: { pct: 70.0 }, functions: { pct: 90.0 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands, 80.0);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('test-coverage-delta');
		// delta = 85.5 - 80.0 = 5.5, score = 0.5 + 5.5 * 5 / 100 = 0.5 + 0.275 = 0.775
		expect(signal!.score).toBeCloseTo(0.775, 3);
		expect(signal!.description).toContain('85.5%');
		expect(signal!.description).toContain('baseline: 80.0%');
	});

	it('parses pytest-cov text output correctly', async () => {
		const pytestOutput = [
			'Name              Stmts   Miss   Cover',
			'---------------------------------------',
			'module.py            50     15     70%',
			'TOTAL               200     60     70%',
		].join('\n');
		mockExecResult({ stdout: pytestOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, { ...coverageCommands, projectType: 'python' });
		expect(signal).not.toBeNull();
		expect(signal!.description).toContain('70.0%');
	});

	it('scores 1.0 when coverage increased by +10%', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 90.0 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands, 80.0);
		// delta = +10, score = 0.5 + 10*5/100 = 0.5 + 0.5 = 1.0
		expect(signal!.score).toBe(1.0);
	});

	it('scores 0.5 when coverage unchanged', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 80.0 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands, 80.0);
		expect(signal!.score).toBe(0.5);
	});

	it('scores 0.0 when coverage decreased by -10%', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 70.0 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands, 80.0);
		// delta = -10, score = 0.5 + (-10)*5/100 = 0.5 - 0.5 = 0.0
		expect(signal!.score).toBe(0.0);
	});

	it('returns neutral absolute score when no baseline', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 75.0 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands);
		// No baseline: score = 75/100 = 0.75
		expect(signal!.score).toBe(0.75);
		expect(signal!.description).toContain('no baseline');
	});

	it('returns timeout signal when command times out', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});

	it('returns null when coverage output cannot be parsed', async () => {
		mockExecResult({ stdout: 'some random output with no coverage data', exitCode: 0 });

		const signal = await collectCoverageReward(tmpDir, coverageCommands);
		expect(signal).toBeNull();
	});
});

// ─── captureCoverageBaseline (GRPO-15 Task 2) ───────────────────────────────

describe('captureCoverageBaseline', () => {
	it('returns null when no coverage command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureCoverageBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns parsed coverage percentage', async () => {
		const jsonOutput = JSON.stringify({
			total: { lines: { pct: 85.5 } },
		});
		mockExecResult({ stdout: jsonOutput, exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			coverageCommand: 'npx vitest run --coverage --reporter=json',
		};

		expect(await captureCoverageBaseline(tmpDir, commands)).toBe(85.5);
	});

	it('returns null on timeout', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			coverageCommand: 'npx vitest run --coverage --reporter=json',
		};

		expect(await captureCoverageBaseline(tmpDir, commands)).toBeNull();
	});
});
