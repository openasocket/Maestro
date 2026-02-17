/**
 * RewardCollector — gathers verifiable reward signals from project state.
 *
 * After an agent completes a task, the collector runs a series of
 * verification commands and converts their outputs to RewardSignal objects.
 *
 * All signals are deterministic and verifiable — no subjective scoring.
 * Supports multiple project types (Node.js, Python, Rust, Go, etc.)
 */

import { exec, type ExecException } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { GRPOConfig, RewardSignal, RewardSignalType } from '../../shared/grpo-types';

const LOG_CONTEXT = '[RewardCollector]';

/** Maximum output size stored in rawOutput (10KB) */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Default timeout for verification commands (30s) */
const DEFAULT_TIMEOUT_MS = 30_000;

// ─── Project Command Detection ───────────────────────────────────────────────

export interface ProjectCommands {
	testCommand: string | null;
	buildCommand: string | null;
	lintCommand: string | null;
	projectType: 'node' | 'python' | 'rust' | 'go' | 'unknown';
	// New (GRPO-15)
	coverageCommand: string | null;
	typeCheckCommand: string | null;
	complexityCommand: string | null;
	securityScanCommand: string | null;
	benchmarkCommand: string | null;
	bundleBuildCommand: string | null;
	/** Path to the package manifest file (package.json, Cargo.toml, etc.) */
	manifestPath: string | null;
	/** Path to API schema file (openapi.json/yaml, schema.graphql) */
	apiSchemaPath: string | null;
}

/**
 * Detects project type and available test/build/lint commands.
 * Checks in order: Node.js, Python, Rust, Go.
 */
export async function detectProjectCommands(projectPath: string): Promise<ProjectCommands> {
	// Node.js
	if (await fileExists(path.join(projectPath, 'package.json'))) {
		return detectNodeCommands(projectPath);
	}

	// Python
	if (
		(await fileExists(path.join(projectPath, 'pyproject.toml'))) ||
		(await fileExists(path.join(projectPath, 'setup.py'))) ||
		(await fileExists(path.join(projectPath, 'requirements.txt')))
	) {
		return detectPythonCommands(projectPath);
	}

	// Rust
	if (await fileExists(path.join(projectPath, 'Cargo.toml'))) {
		return {
			testCommand: 'cargo test',
			buildCommand: 'cargo check',
			lintCommand: 'cargo clippy -- -D warnings',
			projectType: 'rust',
			coverageCommand: null,
			typeCheckCommand: 'cargo check',
			complexityCommand: null,
			securityScanCommand: 'cargo audit --json',
			benchmarkCommand: null,
			bundleBuildCommand: null,
			manifestPath: path.join(projectPath, 'Cargo.toml'),
			apiSchemaPath: null,
		};
	}

	// Go
	if (await fileExists(path.join(projectPath, 'go.mod'))) {
		return detectGoCommands(projectPath);
	}

	return {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'unknown',
		coverageCommand: null,
		typeCheckCommand: null,
		complexityCommand: null,
		securityScanCommand: null,
		benchmarkCommand: null,
		bundleBuildCommand: null,
		manifestPath: null,
		apiSchemaPath: null,
	};
}

async function detectNodeCommands(projectPath: string): Promise<ProjectCommands> {
	const commands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'node',
		coverageCommand: null,
		typeCheckCommand: null,
		complexityCommand: null,
		securityScanCommand: null,
		benchmarkCommand: null,
		bundleBuildCommand: null,
		manifestPath: null,
		apiSchemaPath: null,
	};

	let scripts: Record<string, string> = {};
	try {
		const raw = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
		const pkg = JSON.parse(raw);
		scripts = pkg.scripts ?? {};
	} catch {
		return commands;
	}

	// Test command
	if (await fileExists(path.join(projectPath, 'vitest.config.ts'))) {
		commands.testCommand = 'npx vitest run --reporter=verbose';
	} else if (scripts.test) {
		commands.testCommand = 'npm test';
	}

	// Build command
	if (scripts.build) {
		commands.buildCommand = 'npm run build';
	} else if (await fileExists(path.join(projectPath, 'tsconfig.json'))) {
		commands.buildCommand = 'npx tsc --noEmit';
	}

	// Lint command
	if (scripts.lint) {
		commands.lintCommand = 'npm run lint';
	} else if (await hasEslintConfig(projectPath)) {
		commands.lintCommand = 'npx eslint .';
	}

	// Coverage command (vitest has built-in coverage)
	if (commands.testCommand?.includes('vitest')) {
		commands.coverageCommand = 'npx vitest run --coverage --reporter=json';
	} else if (scripts['test:coverage']) {
		commands.coverageCommand = 'npm run test:coverage';
	}

	// Type check command (separate from build — strict mode)
	if (await fileExists(path.join(projectPath, 'tsconfig.json'))) {
		commands.typeCheckCommand = 'npx tsc --noEmit';
	}

	// Complexity (cr — code-complexity package)
	commands.complexityCommand = 'npx cr --format json';

	// Security scan
	commands.securityScanCommand = 'npm audit --json';

	// Benchmark
	if (scripts.bench || scripts.benchmark) {
		commands.benchmarkCommand = scripts.bench ? 'npm run bench' : 'npm run benchmark';
	}

	// Bundle build (only if there's a build command)
	if (scripts.build) {
		commands.bundleBuildCommand = 'npm run build';
	}

	// Manifest path
	commands.manifestPath = path.join(projectPath, 'package.json');

	// API schema detection
	for (const schemaFile of ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'schema.graphql']) {
		if (await fileExists(path.join(projectPath, schemaFile))) {
			commands.apiSchemaPath = path.join(projectPath, schemaFile);
			break;
		}
	}

	return commands;
}

async function detectPythonCommands(projectPath: string): Promise<ProjectCommands> {
	const commands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'python',
		coverageCommand: null,
		typeCheckCommand: null,
		complexityCommand: null,
		securityScanCommand: null,
		benchmarkCommand: null,
		bundleBuildCommand: null,
		manifestPath: null,
		apiSchemaPath: null,
	};

	// Test detection
	const hasPytest =
		(await fileExists(path.join(projectPath, 'pytest.ini'))) ||
		(await fileExists(path.join(projectPath, 'conftest.py'))) ||
		(await fileContains(path.join(projectPath, 'pyproject.toml'), '[tool.pytest'));
	if (hasPytest) {
		commands.testCommand = 'python -m pytest -v';
	}

	// Lint detection
	const hasRuff =
		(await fileExists(path.join(projectPath, 'ruff.toml'))) ||
		(await fileContains(path.join(projectPath, 'pyproject.toml'), '[tool.ruff'));
	if (hasRuff) {
		commands.lintCommand = 'ruff check .';
	}

	// Build/type-check detection
	const hasMypy =
		(await fileExists(path.join(projectPath, 'mypy.ini'))) ||
		(await fileContains(path.join(projectPath, 'pyproject.toml'), '[tool.mypy'));
	if (hasMypy) {
		commands.buildCommand = 'mypy .';
	}

	// Coverage
	if (hasPytest) {
		commands.coverageCommand = 'python -m pytest --cov --cov-report=json -q';
	}

	// Type check
	if (hasMypy) {
		commands.typeCheckCommand = 'mypy . --no-error-summary';
	}

	// Complexity
	commands.complexityCommand = 'radon cc . -s -j';

	// Security scan
	const hasBandit = await fileContains(path.join(projectPath, 'pyproject.toml'), 'bandit')
		|| await fileExists(path.join(projectPath, '.bandit'));
	if (hasBandit) {
		commands.securityScanCommand = 'bandit -r . -f json';
	}

	// Manifest path
	if (await fileExists(path.join(projectPath, 'pyproject.toml'))) {
		commands.manifestPath = path.join(projectPath, 'pyproject.toml');
	} else if (await fileExists(path.join(projectPath, 'requirements.txt'))) {
		commands.manifestPath = path.join(projectPath, 'requirements.txt');
	}

	// Benchmark
	if (await fileContains(path.join(projectPath, 'pyproject.toml'), 'pytest-benchmark')) {
		commands.benchmarkCommand = 'python -m pytest --benchmark-only --benchmark-json=benchmark.json';
	}

	return commands;
}

async function detectGoCommands(projectPath: string): Promise<ProjectCommands> {
	const commands: ProjectCommands = {
		testCommand: 'go test ./...',
		buildCommand: 'go build ./...',
		lintCommand: null,
		projectType: 'go',
		coverageCommand: 'go test ./... -coverprofile=coverage.out -covermode=atomic',
		typeCheckCommand: 'go vet ./...',
		complexityCommand: null,
		securityScanCommand: null,
		benchmarkCommand: null,
		bundleBuildCommand: null,
		manifestPath: path.join(projectPath, 'go.mod'),
		apiSchemaPath: null,
	};

	// Check if golangci-lint is available
	try {
		await runVerificationCommand('golangci-lint --version', projectPath, 5_000);
		commands.lintCommand = 'golangci-lint run';
	} catch {
		// Not installed — skip
	}

	// Check for govulncheck
	try {
		await runVerificationCommand('govulncheck --version', projectPath, 5_000);
		commands.securityScanCommand = 'govulncheck ./...';
	} catch { /* not installed */ }

	return commands;
}

// ─── Verification Process Spawning ───────────────────────────────────────────

export interface VerificationResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawns an ephemeral verification command and captures output.
 * Does NOT emit events to ProcessManager or stats DB.
 */
export function runVerificationCommand(
	command: string,
	projectPath: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<VerificationResult> {
	return new Promise((resolve, reject) => {
		const child = exec(command, {
			cwd: projectPath,
			timeout: timeoutMs,
			maxBuffer: MAX_OUTPUT_BYTES * 2,
			env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' },
		}, (error, stdout, stderr) => {
			const truncatedStdout = truncateOutput(stdout);
			const truncatedStderr = truncateOutput(stderr);

			if (error && (error as ExecException).killed) {
				// Timeout — process was killed
				resolve({ exitCode: -1, stdout: truncatedStdout, stderr: truncatedStderr });
				return;
			}

			resolve({
				exitCode: error ? (error.code ?? 1) : 0,
				stdout: truncatedStdout,
				stderr: truncatedStderr,
			});
		});

		child.on('error', (err) => {
			reject(err);
		});
	});
}

// ─── Reward Collectors ───────────────────────────────────────────────────────

/**
 * Collects test reward signal. Returns null if no test command detected.
 */
export async function collectTestReward(
	projectPath: string,
	commands: ProjectCommands,
): Promise<RewardSignal | null> {
	if (!commands.testCommand) return null;

	const result = await safeRunCommand(commands.testCommand, projectPath);
	if (result.exitCode === -1) {
		return timeoutSignal('test-pass', 'Test command timed out');
	}

	const rawOutput = combineOutput(result);

	if (result.exitCode === 0) {
		return makeSignal('test-pass', 1.0, 'All tests passed', rawOutput);
	}

	// Try to extract partial pass/fail counts
	const partial = parseTestCounts(rawOutput);
	if (partial && partial.total > 0) {
		const score = partial.passed / partial.total;
		return makeSignal(
			'test-fail',
			score,
			`${partial.passed}/${partial.total} tests passed`,
			rawOutput,
		);
	}

	return makeSignal('test-fail', 0.0, 'Tests failed', rawOutput);
}

/**
 * Collects build reward signal. Returns null if no build command detected.
 */
export async function collectBuildReward(
	projectPath: string,
	commands: ProjectCommands,
): Promise<RewardSignal | null> {
	if (!commands.buildCommand) return null;

	const result = await safeRunCommand(commands.buildCommand, projectPath);
	if (result.exitCode === -1) {
		return timeoutSignal('build-success', 'Build command timed out');
	}

	const rawOutput = combineOutput(result);

	if (result.exitCode === 0) {
		return makeSignal('build-success', 1.0, 'Build succeeded', rawOutput);
	}

	return makeSignal('build-fail', 0.0, 'Build failed', rawOutput);
}

/**
 * Collects lint reward signal with delta-based scoring.
 * Returns null if no lint command detected.
 */
export async function collectLintReward(
	projectPath: string,
	commands: ProjectCommands,
	baselineErrors?: number,
): Promise<RewardSignal | null> {
	if (!commands.lintCommand) return null;

	const result = await safeRunCommand(commands.lintCommand, projectPath);
	if (result.exitCode === -1) {
		return timeoutSignal('lint-clean', 'Lint command timed out');
	}

	const rawOutput = combineOutput(result);

	if (result.exitCode === 0) {
		return makeSignal('lint-clean', 1.0, 'Lint clean', rawOutput);
	}

	const currentErrors = parseLintErrorCount(rawOutput, commands.projectType);

	let score: number;
	let description: string;

	if (baselineErrors !== undefined) {
		// Delta-based scoring
		const newErrors = Math.max(0, currentErrors - baselineErrors);
		score = Math.max(0, 1 - newErrors / Math.max(1, baselineErrors));
		description = `${currentErrors} lint errors (baseline: ${baselineErrors}, new: ${newErrors})`;
	} else {
		// Absolute scoring with generous denominator
		score = Math.max(0, 1 - currentErrors / 50);
		description = `${currentErrors} lint errors`;
	}

	return makeSignal('lint-errors', score, description, rawOutput);
}

/**
 * Collects git diff quality reward signal.
 */
export async function collectGitDiffReward(
	projectPath: string,
	baseRef: string = 'HEAD~1',
): Promise<RewardSignal> {
	const result = await safeRunCommand(`git diff --stat ${baseRef}`, projectPath);
	if (result.exitCode === -1) {
		return timeoutSignal('git-diff-quality', 'Git diff timed out');
	}

	const rawOutput = combineOutput(result);

	// No changes at all
	if (!rawOutput.trim()) {
		return makeSignal('git-diff-quality', 0.5, 'No changes detected', rawOutput);
	}

	let score = 0;
	const lines = rawOutput.split('\n').filter((l) => l.trim());

	// Count changed files (lines with | in them are file entries)
	const fileLines = lines.filter((l) => l.includes('|'));
	const filesChanged = fileLines.length;
	if (filesChanged <= 10) score += 0.2;

	// Parse summary line for insertions/deletions
	const summaryLine = lines[lines.length - 1] ?? '';
	const insertionsMatch = summaryLine.match(/(\d+)\s+insertion/);
	const additions = insertionsMatch ? parseInt(insertionsMatch[1], 10) : 0;
	if (additions <= 200) score += 0.2;

	// Check for binary files
	const hasBinaryFiles = lines.some((l) => l.includes('Bin '));
	if (!hasBinaryFiles) score += 0.2;

	// Check for test files in changes
	const hasTestFiles = fileLines.some(
		(l) => l.includes('test') || l.includes('spec') || l.includes('__tests__'),
	);
	if (hasTestFiles) score += 0.2;

	// Check changes are in expected directories (not node_modules, dist, build, etc.)
	const unwantedDirs = ['node_modules', 'dist/', 'build/', '.next/', 'target/', '__pycache__/'];
	const hasUnwantedChanges = fileLines.some((l) =>
		unwantedDirs.some((dir) => l.includes(dir)),
	);
	if (!hasUnwantedChanges) score += 0.2;

	const parts: string[] = [];
	parts.push(`${filesChanged} files`);
	parts.push(`${additions} additions`);
	if (hasBinaryFiles) parts.push('has binaries');
	if (hasTestFiles) parts.push('includes tests');
	if (hasUnwantedChanges) parts.push('changes in unwanted dirs');

	return makeSignal('git-diff-quality', score, parts.join(', '), rawOutput);
}

/**
 * Collects exit code reward signal. Synchronous.
 */
export function collectExitCodeReward(exitCode: number): RewardSignal {
	let score: number;
	if (exitCode === 0) {
		score = 1.0;
	} else if (exitCode === 1) {
		score = 0.3;
	} else {
		score = 0.0;
	}

	return makeSignal('process-exit-code', score, `Exit code: ${exitCode}`);
}

/**
 * Collects task completion reward signal based on exit code and agent output.
 */
export function collectTaskCompleteReward(agentOutput: string, exitCode: number): RewardSignal {
	const failureIndicators = [
		'I was unable to',
		'I couldn\'t',
		'Error:',
		'FAILED',
		'fatal error',
		'panic:',
		'Traceback (most recent call last)',
		'Unhandled exception',
	];

	const warningIndicators = [
		'warning:',
		'Warning:',
		'WARN',
		'deprecated',
		'TODO:',
	];

	const lowerOutput = agentOutput.toLowerCase();
	const hasErrors = failureIndicators.some((indicator) =>
		lowerOutput.includes(indicator.toLowerCase()),
	);
	const hasWarnings = warningIndicators.some((indicator) =>
		lowerOutput.includes(indicator.toLowerCase()),
	);

	if (exitCode === 0 && !hasErrors) {
		if (hasWarnings) {
			return makeSignal('task-complete', 0.5, 'Task completed with warnings');
		}
		return makeSignal('task-complete', 1.0, 'Task completed successfully');
	}

	if (exitCode === 0 && hasErrors) {
		return makeSignal('task-complete', 0.5, 'Exit code 0 but output contains error indicators');
	}

	return makeSignal('task-complete', 0.0, `Task failed (exit code ${exitCode})`);
}

/**
 * Runs all applicable reward collectors and returns array of signals.
 * Skips collectors for signals with weight 0 in config.
 * Skips collectors where no command was detected.
 */
export async function collectAllRewards(
	projectPath: string,
	exitCode: number,
	agentOutput: string,
	config: GRPOConfig,
	commands: ProjectCommands,
	baselineLintErrors?: number,
): Promise<RewardSignal[]> {
	const signals: RewardSignal[] = [];
	const weights = config.rewardWeights;

	// Always collect synchronous signals (unless weight is 0)
	if (weights['process-exit-code'] > 0) {
		signals.push(collectExitCodeReward(exitCode));
	}

	if (weights['task-complete'] > 0) {
		signals.push(collectTaskCompleteReward(agentOutput, exitCode));
	}

	// Collect async signals in parallel
	const asyncCollectors: Promise<RewardSignal | null>[] = [];

	if (weights['test-pass'] > 0 || weights['test-fail'] > 0) {
		asyncCollectors.push(collectTestReward(projectPath, commands));
	}

	if (weights['build-success'] > 0 || weights['build-fail'] > 0) {
		asyncCollectors.push(collectBuildReward(projectPath, commands));
	}

	if (weights['lint-clean'] > 0 || weights['lint-errors'] > 0) {
		asyncCollectors.push(collectLintReward(projectPath, commands, baselineLintErrors));
	}

	if (weights['git-diff-quality'] > 0) {
		asyncCollectors.push(collectGitDiffReward(projectPath));
	}

	const asyncResults = await Promise.all(asyncCollectors);
	for (const result of asyncResults) {
		if (result !== null) {
			signals.push(result);
		}
	}

	logger.debug(`Collected ${signals.length} reward signals`, LOG_CONTEXT);
	return signals;
}

// ─── GRPO-15 Extended Collectors ─────────────────────────────────────────────

/**
 * Collects test coverage delta reward signal.
 * Measures coverage change by running coverage before and after (or just after if no baseline).
 * Returns null if no coverage command detected.
 *
 * Scoring:
 * - Coverage increased: score = min(1.0, 0.5 + delta * 5)  (e.g., +10% → 1.0)
 * - Coverage unchanged: score = 0.5 (neutral)
 * - Coverage decreased: score = max(0.0, 0.5 + delta * 5)  (e.g., -10% → 0.0)
 */
export async function collectCoverageReward(
	projectPath: string,
	commands: ProjectCommands,
	baselineCoverage?: number,
): Promise<RewardSignal | null> {
	if (!commands.coverageCommand) return null;

	const result = await safeRunCommand(commands.coverageCommand, projectPath);
	if (result.exitCode === -1) {
		return timeoutSignal('test-coverage-delta', 'Coverage command timed out');
	}

	const rawOutput = combineOutput(result);
	const currentCoverage = parseCoveragePercentage(rawOutput, commands.projectType);

	if (currentCoverage === null) {
		logger.debug('Could not parse coverage output', LOG_CONTEXT);
		return null;
	}

	if (baselineCoverage === undefined || baselineCoverage === null) {
		// No baseline — score based on absolute coverage
		// 80%+ is great, 50% is neutral, <20% is poor
		const score = Math.min(1.0, Math.max(0.0, currentCoverage / 100));
		return makeSignal(
			'test-coverage-delta',
			score,
			`Coverage: ${currentCoverage.toFixed(1)}% (no baseline)`,
			rawOutput,
		);
	}

	const delta = currentCoverage - baselineCoverage;
	// Scale: +10% = 1.0, 0% = 0.5, -10% = 0.0
	const score = Math.min(1.0, Math.max(0.0, 0.5 + delta * 5 / 100));

	return makeSignal(
		'test-coverage-delta',
		score,
		`Coverage: ${currentCoverage.toFixed(1)}% (baseline: ${baselineCoverage.toFixed(1)}%, delta: ${delta > 0 ? '+' : ''}${delta.toFixed(1)}%)`,
		rawOutput,
	);
}

/**
 * Parses coverage percentage from various tool outputs.
 * Supports: vitest/istanbul JSON, pytest-cov, cargo-tarpaulin, go cover.
 */
function parseCoveragePercentage(output: string, _projectType: string): number | null {
	// Try JSON format first (vitest/istanbul, pytest-cov --json)
	try {
		const jsonMatch = output.match(/\{[\s\S]*"total"[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			// Istanbul format: { total: { lines: { pct: 85.5 } } }
			if (parsed.total?.lines?.pct !== undefined) {
				return parsed.total.lines.pct;
			}
			// pytest-cov JSON: { totals: { percent_covered: 85.5 } }
			if (parsed.totals?.percent_covered !== undefined) {
				return parsed.totals.percent_covered;
			}
		}
	} catch { /* not JSON */ }

	// Vitest/Jest text: "All files  |   85.5 |  ..."
	const istanbulMatch = output.match(/All files\s*\|\s*([\d.]+)/);
	if (istanbulMatch) return parseFloat(istanbulMatch[1]);

	// pytest-cov text: "TOTAL    1234   567    54%"
	const pytestMatch = output.match(/TOTAL\s+\d+\s+\d+\s+([\d.]+)%/);
	if (pytestMatch) return parseFloat(pytestMatch[1]);

	// Go cover: "total:  (statements)  85.5%"
	const goMatch = output.match(/total:\s+\(statements\)\s+([\d.]+)%/);
	if (goMatch) return parseFloat(goMatch[1]);

	// cargo-tarpaulin: "85.50% coverage, 171/200 lines covered"
	const tarpMatch = output.match(/([\d.]+)%\s+coverage/);
	if (tarpMatch) return parseFloat(tarpMatch[1]);

	return null;
}

/**
 * Captures baseline coverage percentage before a rollout starts.
 * Returns the percentage (0-100), or null if unavailable.
 */
export async function captureCoverageBaseline(
	projectPath: string,
	commands: ProjectCommands,
): Promise<number | null> {
	if (!commands.coverageCommand) return null;

	const result = await safeRunCommand(commands.coverageCommand, projectPath);
	if (result.exitCode === -1) return null; // timeout

	const output = combineOutput(result);
	return parseCoveragePercentage(output, commands.projectType);
}

// ─── Aggregate Reward Calculation ────────────────────────────────────────────

/**
 * Computes the weighted mean reward for a rollout output.
 * Uses the weights from GRPOConfig.rewardWeights.
 *
 * Formula: sum(signal.score * weights[signal.type]) / sum(weights[signal.type])
 * Returns 0.5 (neutral) if no signals present.
 */
export function computeAggregateReward(
	signals: RewardSignal[],
	weights: Record<RewardSignalType, number>,
): number {
	if (signals.length === 0) return 0.5;

	let weightedSum = 0;
	let totalWeight = 0;

	for (const signal of signals) {
		const weight = weights[signal.type] ?? 0;
		weightedSum += signal.score * weight;
		totalWeight += weight;
	}

	if (totalWeight === 0) return 0.5;
	return weightedSum / totalWeight;
}

// ─── Lint Baseline Capture ───────────────────────────────────────────────────

/**
 * Captures the baseline lint error count before a rollout starts.
 * Returns the error count (0 if clean), or null if no lint command.
 */
export async function captureLintBaseline(
	projectPath: string,
	commands: ProjectCommands,
): Promise<number | null> {
	if (!commands.lintCommand) return null;

	const result = await safeRunCommand(commands.lintCommand, projectPath);
	if (result.exitCode === 0) return 0;

	const output = combineOutput(result);
	return parseLintErrorCount(output, commands.projectType);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function fileContains(filePath: string, search: string): Promise<boolean> {
	try {
		const content = await fs.readFile(filePath, 'utf-8');
		return content.includes(search);
	} catch {
		return false;
	}
}

async function hasEslintConfig(projectPath: string): Promise<boolean> {
	const patterns = [
		'.eslintrc',
		'.eslintrc.js',
		'.eslintrc.cjs',
		'.eslintrc.json',
		'.eslintrc.yml',
		'.eslintrc.yaml',
		'eslint.config.js',
		'eslint.config.mjs',
		'eslint.config.cjs',
		'eslint.config.ts',
	];
	for (const pattern of patterns) {
		if (await fileExists(path.join(projectPath, pattern))) return true;
	}
	return false;
}

function truncateOutput(output: string): string {
	if (output.length <= MAX_OUTPUT_BYTES) return output;
	return output.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
}

function combineOutput(result: VerificationResult): string {
	const parts: string[] = [];
	if (result.stdout) parts.push(result.stdout);
	if (result.stderr) parts.push(result.stderr);
	return truncateOutput(parts.join('\n'));
}

function makeSignal(
	type: RewardSignalType,
	score: number,
	description: string,
	rawOutput?: string,
): RewardSignal {
	return {
		type,
		score,
		description,
		rawOutput,
		collectedAt: Date.now(),
	};
}

function timeoutSignal(type: RewardSignalType, description: string): RewardSignal {
	return makeSignal(type, 0.5, description);
}

/**
 * Runs a verification command, catching spawn errors to return a default result.
 */
async function safeRunCommand(
	command: string,
	projectPath: string,
): Promise<VerificationResult> {
	try {
		return await runVerificationCommand(command, projectPath);
	} catch (err) {
		logger.warn(`Verification command failed to spawn: ${command}`, LOG_CONTEXT);
		return { exitCode: -1, stdout: '', stderr: String(err) };
	}
}

/**
 * Parses test runner output to extract pass/fail counts.
 * Supports common test frameworks: vitest, jest, pytest, cargo test, go test.
 */
function parseTestCounts(output: string): { passed: number; failed: number; total: number } | null {
	// Vitest / Jest: "Tests  X passed | Y failed | Z total"
	const vitestMatch = output.match(/Tests\s+(\d+)\s+passed.*?(\d+)\s+failed.*?(\d+)\s+total/i);
	if (vitestMatch) {
		return {
			passed: parseInt(vitestMatch[1], 10),
			failed: parseInt(vitestMatch[2], 10),
			total: parseInt(vitestMatch[3], 10),
		};
	}

	// Vitest / Jest compact: "X passed, Y failed"
	const compactMatch = output.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i);
	if (compactMatch) {
		const passed = parseInt(compactMatch[1], 10);
		const failed = parseInt(compactMatch[2], 10);
		return { passed, failed, total: passed + failed };
	}

	// pytest: "X passed, Y failed"  or  "X passed"
	const pytestMatch = output.match(/(\d+)\s+passed(?:[,\s]+(\d+)\s+failed)?/i);
	if (pytestMatch) {
		const passed = parseInt(pytestMatch[1], 10);
		const failed = pytestMatch[2] ? parseInt(pytestMatch[2], 10) : 0;
		return { passed, failed, total: passed + failed };
	}

	// cargo test: "test result: ok. X passed; Y failed;"
	const cargoMatch = output.match(/test result:.*?(\d+)\s+passed;\s*(\d+)\s+failed/i);
	if (cargoMatch) {
		const passed = parseInt(cargoMatch[1], 10);
		const failed = parseInt(cargoMatch[2], 10);
		return { passed, failed, total: passed + failed };
	}

	// go test: "ok" / "FAIL" lines per package — count them
	const goOk = (output.match(/^ok\s+/gm) ?? []).length;
	const goFail = (output.match(/^FAIL\s+/gm) ?? []).length;
	if (goOk + goFail > 0) {
		return { passed: goOk, failed: goFail, total: goOk + goFail };
	}

	return null;
}

/**
 * Parses lint output to count errors. Project-type aware.
 */
function parseLintErrorCount(output: string, projectType: string): number {
	// ESLint: "X problems" or "X errors"
	const eslintMatch = output.match(/(\d+)\s+(?:problems?|errors?)/i);
	if (eslintMatch) return parseInt(eslintMatch[1], 10);

	// Ruff: count lines that look like errors (file:line:col: CODE msg)
	if (projectType === 'python') {
		const ruffLines = output.split('\n').filter((l) => /^\S+:\d+:\d+:/.test(l));
		if (ruffLines.length > 0) return ruffLines.length;
	}

	// Clippy: "error[EXXXX]" or "warning:" counts
	if (projectType === 'rust') {
		const errors = (output.match(/error\[E\d+\]/g) ?? []).length;
		const warnings = (output.match(/warning:/g) ?? []).length;
		return errors + warnings;
	}

	// Fallback: count lines with "error" (case insensitive)
	return output.split('\n').filter((l) => /\berror\b/i.test(l)).length;
}
