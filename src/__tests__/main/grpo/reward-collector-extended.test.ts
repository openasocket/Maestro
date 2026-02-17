/**
 * Extended tests for GRPO-15 reward collectors.
 *
 * Tests all 9 new reward signal collectors:
 * - test-coverage-delta
 * - type-safety
 * - complexity-delta
 * - security-scan
 * - dependency-hygiene
 * - api-contract
 * - documentation-coverage
 * - runtime-performance
 * - bundle-size-delta
 *
 * Plus integration tests for collectAllRewards and captureAllBaselines.
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

// Mock child_process.exec
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
	collectTypeSafetyReward,
	captureTypeCheckBaseline,
	collectComplexityReward,
	captureComplexityBaseline,
	collectSecurityReward,
	captureSecurityBaseline,
	collectDependencyReward,
	captureDependencyBaseline,
	collectApiContractReward,
	captureApiSchemaBaseline,
	collectDocumentationReward,
	collectPerformanceReward,
	capturePerformanceBaseline,
	collectBundleSizeReward,
	captureBundleSizeBaseline,
	collectAllRewards,
	captureAllBaselines,
	type ProjectCommands,
	type RewardBaselines,
} from '../../../main/grpo/reward-collector';
import type { GRPOConfig } from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

let tmpDir: string;

/** Default GRPO-15 fields for ProjectCommands test objects */
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
		return { on: vi.fn() };
	});
}

/** Helper to mock multiple sequential exec calls */
function mockExecSequence(results: Array<{ stdout?: string; stderr?: string; exitCode?: number; killed?: boolean }>) {
	let callIndex = 0;
	mockExec.mockImplementation((_cmd: string, _opts: any, callback: Function) => {
		const opts = results[Math.min(callIndex++, results.length - 1)];
		const { stdout = '', stderr = '', exitCode = 0, killed = false } = opts;
		if (exitCode === 0 && !killed) {
			callback(null, stdout, stderr);
		} else {
			const error: any = new Error('command failed');
			error.code = exitCode;
			error.killed = killed;
			callback(error, stdout, stderr);
		}
		return { on: vi.fn() };
	});
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpo-reward-ext-'));
	mockExec.mockReset();
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── collectTypeSafetyReward ─────────────────────────────────────────────────

describe('collectTypeSafetyReward', () => {
	const typeCheckCommands: ProjectCommands = {
		testCommand: null,
		buildCommand: 'npm run build',
		lintCommand: null,
		projectType: 'node',
		...GRPO15_DEFAULTS,
		typeCheckCommand: 'npx tsc --noEmit',
	};

	it('returns null when no type check command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectTypeSafetyReward(tmpDir, commands)).toBeNull();
	});

	it('skips when typeCheckCommand === buildCommand (avoid double-counting)', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npx tsc --noEmit',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			typeCheckCommand: 'npx tsc --noEmit',
		};
		expect(await collectTypeSafetyReward(tmpDir, commands)).toBeNull();
	});

	it('parses tsc error count ("Found X errors")', async () => {
		mockExecResult({
			stderr: 'src/app.ts(5,3): error TS2304: Cannot find name\nFound 5 errors.',
			exitCode: 1,
		});

		const signal = await collectTypeSafetyReward(tmpDir, typeCheckCommands);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('type-safety');
		// 5 errors, no baseline: score = max(0, 1 - 5/30) = 0.833...
		expect(signal!.score).toBeCloseTo(1 - 5 / 30, 3);
		expect(signal!.description).toContain('5 type errors');
	});

	it('parses mypy error count', async () => {
		const mypyOutput = [
			'module.py:10: error: Incompatible types',
			'module.py:20: error: Missing return type',
			'Found 2 errors in 1 file',
		].join('\n');
		mockExecResult({ stderr: mypyOutput, exitCode: 1 });

		const commands: ProjectCommands = {
			...typeCheckCommands,
			buildCommand: 'mypy .',
			typeCheckCommand: 'mypy . --no-error-summary',
			projectType: 'python',
		};

		const signal = await collectTypeSafetyReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		expect(signal!.description).toContain('2 type errors');
	});

	it('delta scoring matches lint pattern', async () => {
		mockExecResult({
			stderr: 'Found 15 errors in 3 files.',
			exitCode: 1,
		});

		// Baseline of 10 errors, current 15 → 5 new errors
		const signal = await collectTypeSafetyReward(tmpDir, typeCheckCommands, 10);
		expect(signal).not.toBeNull();
		// score = max(0, 1 - 5 / max(1, 10)) = max(0, 1 - 0.5) = 0.5
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('baseline: 10');
		expect(signal!.description).toContain('new: 5');
	});

	it('returns 1.0 for clean type check', async () => {
		mockExecResult({ stdout: '', exitCode: 0 });

		const signal = await collectTypeSafetyReward(tmpDir, typeCheckCommands);
		expect(signal!.score).toBe(1.0);
		expect(signal!.description).toBe('Type check clean');
	});

	it('returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectTypeSafetyReward(tmpDir, typeCheckCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});
});

// ─── captureTypeCheckBaseline ────────────────────────────────────────────────

describe('captureTypeCheckBaseline', () => {
	it('returns null when no type check command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureTypeCheckBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns null when typeCheckCommand === buildCommand', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'cargo check',
			lintCommand: null,
			projectType: 'rust',
			...GRPO15_DEFAULTS,
			typeCheckCommand: 'cargo check',
		};
		expect(await captureTypeCheckBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns 0 for clean type check', async () => {
		mockExecResult({ stdout: '', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npm run build',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			typeCheckCommand: 'npx tsc --noEmit',
		};
		expect(await captureTypeCheckBaseline(tmpDir, commands)).toBe(0);
	});

	it('returns error count for type check with errors', async () => {
		mockExecResult({ stderr: 'Found 8 errors.', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npm run build',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			typeCheckCommand: 'npx tsc --noEmit',
		};
		expect(await captureTypeCheckBaseline(tmpDir, commands)).toBe(8);
	});
});

// ─── collectComplexityReward ─────────────────────────────────────────────────

describe('collectComplexityReward', () => {
	const complexityCommands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'python',
		...GRPO15_DEFAULTS,
		complexityCommand: 'radon cc . -s -j',
	};

	it('returns null when no complexity command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectComplexityReward(tmpDir, commands)).toBeNull();
	});

	it('parses radon JSON output', async () => {
		const radonJson = JSON.stringify({
			'module.py': [
				{ name: 'func_a', complexity: 3 },
				{ name: 'func_b', complexity: 7 },
			],
			'utils.py': [
				{ name: 'helper', complexity: 2 },
			],
		});
		mockExecResult({ stdout: radonJson, exitCode: 0 });

		const signal = await collectComplexityReward(tmpDir, complexityCommands);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('complexity-delta');
		// Average: (3 + 7 + 2) / 3 = 4.0
		// No baseline: score = min(1.0, max(0.0, 1 - (4.0 - 5) / 15)) = min(1.0, max(0.0, 1 + 1/15))
		// = min(1.0, 1.0667) = 1.0
		expect(signal!.score).toBe(1.0);
		expect(signal!.description).toContain('4.0');
	});

	it('scores below 0.5 when complexity increased', async () => {
		const radonJson = JSON.stringify({
			'module.py': [{ name: 'func', complexity: 15 }],
		});
		mockExecResult({ stdout: radonJson, exitCode: 0 });

		// Baseline complexity 5, current 15 → delta +10
		const signal = await collectComplexityReward(tmpDir, complexityCommands, 5);
		expect(signal).not.toBeNull();
		// delta = 10, score = max(0.0, 0.5 - 10 * 0.025) = max(0, 0.5 - 0.25) = 0.25
		expect(signal!.score).toBeCloseTo(0.25, 3);
	});

	it('scores above 0.5 when complexity decreased', async () => {
		const radonJson = JSON.stringify({
			'module.py': [{ name: 'func', complexity: 3 }],
		});
		mockExecResult({ stdout: radonJson, exitCode: 0 });

		// Baseline complexity 8, current 3 → delta -5
		const signal = await collectComplexityReward(tmpDir, complexityCommands, 8);
		expect(signal).not.toBeNull();
		// delta = -5, score = min(1.0, 0.5 + 5 * 0.05) = min(1.0, 0.75) = 0.75
		expect(signal!.score).toBeCloseTo(0.75, 3);
	});

	it('returns null when output cannot be parsed', async () => {
		mockExecResult({ stdout: 'unparseable garbage', exitCode: 0 });

		const signal = await collectComplexityReward(tmpDir, complexityCommands);
		expect(signal).toBeNull();
	});

	it('returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectComplexityReward(tmpDir, complexityCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});
});

// ─── captureComplexityBaseline ───────────────────────────────────────────────

describe('captureComplexityBaseline', () => {
	it('returns null when no complexity command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureComplexityBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns parsed average complexity', async () => {
		const radonJson = JSON.stringify({
			'module.py': [
				{ name: 'func_a', complexity: 4 },
				{ name: 'func_b', complexity: 6 },
			],
		});
		mockExecResult({ stdout: radonJson, exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'python',
			...GRPO15_DEFAULTS,
			complexityCommand: 'radon cc . -s -j',
		};
		expect(await captureComplexityBaseline(tmpDir, commands)).toBe(5);
	});
});

// ─── collectSecurityReward ───────────────────────────────────────────────────

describe('collectSecurityReward', () => {
	const securityCommands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'node',
		...GRPO15_DEFAULTS,
		securityScanCommand: 'npm audit --json',
	};

	it('returns null when no security scan command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectSecurityReward(tmpDir, commands)).toBeNull();
	});

	it('parses npm audit JSON output', async () => {
		const npmAudit = JSON.stringify({
			metadata: {
				vulnerabilities: { total: 3, low: 1, moderate: 1, high: 1 },
			},
		});
		mockExecResult({ stdout: npmAudit, exitCode: 1 });

		const signal = await collectSecurityReward(tmpDir, securityCommands);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('security-scan');
		// 3 findings, no baseline: score = max(0, 1 - 3/10) = 0.7
		expect(signal!.score).toBeCloseTo(0.7, 3);
		expect(signal!.description).toContain('3 security findings');
	});

	it('parses bandit JSON output', async () => {
		const banditOutput = JSON.stringify({
			results: [
				{ issue_text: 'SQL injection', severity: 'HIGH' },
				{ issue_text: 'Weak hash', severity: 'MEDIUM' },
			],
		});
		mockExecResult({ stdout: banditOutput, exitCode: 1 });

		const commands: ProjectCommands = {
			...securityCommands,
			projectType: 'python',
			securityScanCommand: 'bandit -r . -f json',
		};

		const signal = await collectSecurityReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		// 2 findings, no baseline: score = max(0, 1 - 2/10) = 0.8
		expect(signal!.score).toBeCloseTo(0.8, 3);
	});

	it('scores 1.0 when no findings', async () => {
		mockExecResult({ stdout: '{}', exitCode: 0 });

		const signal = await collectSecurityReward(tmpDir, securityCommands);
		expect(signal!.score).toBe(1.0);
		expect(signal!.description).toContain('No security issues');
	});

	it('delta scoring works correctly', async () => {
		const npmAudit = JSON.stringify({
			metadata: {
				vulnerabilities: { total: 7 },
			},
		});
		mockExecResult({ stdout: npmAudit, exitCode: 1 });

		// Baseline 5 findings, current 7 → 2 new
		const signal = await collectSecurityReward(tmpDir, securityCommands, 5);
		expect(signal).not.toBeNull();
		// score = max(0, 1 - 2 / max(1, 5)) = max(0, 1 - 0.4) = 0.6
		expect(signal!.score).toBeCloseTo(0.6, 3);
		expect(signal!.description).toContain('baseline: 5');
		expect(signal!.description).toContain('new: 2');
	});

	it('returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectSecurityReward(tmpDir, securityCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});
});

// ─── captureSecurityBaseline ─────────────────────────────────────────────────

describe('captureSecurityBaseline', () => {
	it('returns null when no security scan command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureSecurityBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns 0 for clean scan', async () => {
		mockExecResult({ stdout: '', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			securityScanCommand: 'npm audit --json',
		};
		expect(await captureSecurityBaseline(tmpDir, commands)).toBe(0);
	});

	it('returns finding count', async () => {
		const npmAudit = JSON.stringify({
			metadata: { vulnerabilities: { total: 4 } },
		});
		mockExecResult({ stdout: npmAudit, exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			securityScanCommand: 'npm audit --json',
		};
		expect(await captureSecurityBaseline(tmpDir, commands)).toBe(4);
	});
});

// ─── collectDependencyReward ─────────────────────────────────────────────────

describe('collectDependencyReward', () => {
	it('returns null when no manifest path', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectDependencyReward(tmpDir, commands)).toBeNull();
	});

	it('extracts deps from package.json', async () => {
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
			devDependencies: { vitest: '^1.0.0' },
		}));

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		// Baseline: react, react-dom. Current adds vitest.
		const signal = await collectDependencyReward(tmpDir, commands, ['react', 'react-dom']);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('dependency-hygiene');
		// 1 new dep: score = max(0, 1 - 1 * 0.25) = 0.75
		expect(signal!.score).toBe(0.75);
		expect(signal!.description).toContain('+1 new');
	});

	it('extracts deps from requirements.txt', async () => {
		const manifestPath = path.join(tmpDir, 'requirements.txt');
		await fs.writeFile(manifestPath, 'flask>=2.0\nrequests==2.28.0\nnumpy\n');

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'python',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		// Baseline had flask and requests, numpy is new
		const signal = await collectDependencyReward(tmpDir, commands, ['flask', 'requests']);
		expect(signal).not.toBeNull();
		expect(signal!.score).toBe(0.75); // 1 new dep
	});

	it('scores 1.0 for no new deps', async () => {
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18.0.0' },
		}));

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		const signal = await collectDependencyReward(tmpDir, commands, ['react']);
		expect(signal!.score).toBe(1.0);
		expect(signal!.description).toContain('No dependency changes');
	});

	it('scores 0.0 for 4+ new deps', async () => {
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18', lodash: '^4', axios: '^1', dayjs: '^1', zod: '^3' },
		}));

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		// Baseline had only react — 4 new deps
		const signal = await collectDependencyReward(tmpDir, commands, ['react']);
		expect(signal!.score).toBe(0.0);
	});

	it('returns neutral score when no baseline', async () => {
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18.0.0' },
		}));

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		const signal = await collectDependencyReward(tmpDir, commands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('no baseline');
	});
});

// ─── captureDependencyBaseline ───────────────────────────────────────────────

describe('captureDependencyBaseline', () => {
	it('returns null when no manifest path', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureDependencyBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns dependency list from package.json', async () => {
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18.0.0' },
			devDependencies: { vitest: '^1.0.0' },
		}));

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			manifestPath,
		};

		const deps = await captureDependencyBaseline(tmpDir, commands);
		expect(deps).toEqual(['react', 'vitest']);
	});
});

// ─── collectApiContractReward ────────────────────────────────────────────────

describe('collectApiContractReward', () => {
	it('returns null when no schema path', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};
		expect(await collectApiContractReward(tmpDir, commands)).toBeNull();
	});

	it('scores 1.0 for unchanged schema', async () => {
		const schemaPath = path.join(tmpDir, 'openapi.json');
		const schema = JSON.stringify({
			openapi: '3.0.0',
			paths: { '/users': { get: {} } },
		});
		await fs.writeFile(schemaPath, schema);

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};

		const signal = await collectApiContractReward(tmpDir, commands, schema);
		expect(signal!.score).toBe(1.0);
		expect(signal!.description).toContain('unchanged');
	});

	it('scores 0.8 for additive-only changes', async () => {
		const schemaPath = path.join(tmpDir, 'openapi.json');
		const currentSchema = JSON.stringify({
			openapi: '3.0.0',
			paths: { '/users': { get: {} }, '/posts': { get: {} } },
		});
		await fs.writeFile(schemaPath, currentSchema);

		const baselineSchema = JSON.stringify({
			openapi: '3.0.0',
			paths: { '/users': { get: {} } },
		});

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};

		const signal = await collectApiContractReward(tmpDir, commands, baselineSchema);
		expect(signal!.score).toBe(0.8);
		expect(signal!.description).toContain('Additive');
	});

	it('scores 0.0 for removed endpoints', async () => {
		const schemaPath = path.join(tmpDir, 'openapi.json');
		const currentSchema = JSON.stringify({
			openapi: '3.0.0',
			paths: {},
		});
		await fs.writeFile(schemaPath, currentSchema);

		const baselineSchema = JSON.stringify({
			openapi: '3.0.0',
			paths: { '/users': { get: {} }, '/posts': { get: {} } },
		});

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};

		const signal = await collectApiContractReward(tmpDir, commands, baselineSchema);
		expect(signal!.score).toBe(0.0);
		expect(signal!.description).toContain('Breaking');
		expect(signal!.description).toContain('endpoints removed');
	});

	it('detects removed GraphQL types as breaking', async () => {
		const schemaPath = path.join(tmpDir, 'schema.graphql');
		const currentSchema = 'type Query {\n  users: [User]\n}\n';
		await fs.writeFile(schemaPath, currentSchema);

		const baselineSchema = 'type Query {\n  users: [User]\n}\n\ntype Post {\n  id: ID!\n}\n';

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};

		const signal = await collectApiContractReward(tmpDir, commands, baselineSchema);
		expect(signal!.score).toBe(0.0);
		expect(signal!.description).toContain('Breaking');
		expect(signal!.description).toContain('GraphQL types removed');
	});

	it('returns neutral score when no baseline', async () => {
		const schemaPath = path.join(tmpDir, 'openapi.json');
		await fs.writeFile(schemaPath, '{}');

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};

		const signal = await collectApiContractReward(tmpDir, commands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('no baseline');
	});
});

// ─── captureApiSchemaBaseline ────────────────────────────────────────────────

describe('captureApiSchemaBaseline', () => {
	it('returns null when no schema path', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await captureApiSchemaBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns schema content', async () => {
		const schemaPath = path.join(tmpDir, 'openapi.json');
		const content = '{"openapi":"3.0.0"}';
		await fs.writeFile(schemaPath, content);

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			apiSchemaPath: schemaPath,
		};
		expect(await captureApiSchemaBaseline(tmpDir, commands)).toBe(content);
	});
});

// ─── collectDocumentationReward ──────────────────────────────────────────────

describe('collectDocumentationReward', () => {
	it('detects exported TypeScript functions', async () => {
		// Mock git diff to return a single file
		const tsFile = path.join(tmpDir, 'src', 'utils.ts');
		await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
		await fs.writeFile(tsFile, [
			'/** Documented function */',
			'export function documented(): void {}',
			'',
			'export function undocumented(): void {}',
		].join('\n'));

		mockExecResult({ stdout: 'src/utils.ts\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		expect(signal!.type).toBe('documentation-coverage');
		// 2 public symbols, 1 documented → score = 0.5
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('1/2');
	});

	it('detects Python public functions', async () => {
		const pyFile = path.join(tmpDir, 'module.py');
		await fs.writeFile(pyFile, [
			'import os',
			'',
			'def public_func():',
			'    """This is documented."""',
			'    pass',
			'',
			'def another_func():',
			'    pass',
			'',
			'def _private_func():',
			'    pass',
		].join('\n'));

		mockExecResult({ stdout: 'module.py\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'python',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		// 2 public functions (public_func, another_func), 1 documented → score = 0.5
		expect(signal!.score).toBe(0.5);
	});

	it('recognizes JSDoc comments', async () => {
		const tsFile = path.join(tmpDir, 'src', 'api.ts');
		await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
		await fs.writeFile(tsFile, [
			'/**',
			' * Creates a new user.',
			' */',
			'export function createUser(): void {}',
			'',
			'// Simple line comment',
			'export function deleteUser(): void {}',
		].join('\n'));

		mockExecResult({ stdout: 'src/api.ts\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		// Both documented (JSDoc and // comment)
		expect(signal!.score).toBe(1.0);
	});

	it('recognizes Python docstrings', async () => {
		const pyFile = path.join(tmpDir, 'module.py');
		await fs.writeFile(pyFile, [
			'import os',
			'',
			'class MyClass:',
			'    """A documented class."""',
			'    pass',
		].join('\n'));

		mockExecResult({ stdout: 'module.py\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'python',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		expect(signal!.score).toBe(1.0);
	});

	it('scores correctly based on documented ratio', async () => {
		const tsFile = path.join(tmpDir, 'src', 'functions.ts');
		await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
		await fs.writeFile(tsFile, [
			'/** Doc */',
			'export function a(): void {}',
			'/** Doc */',
			'export function b(): void {}',
			'/** Doc */',
			'export function c(): void {}',
			'export function d(): void {}',
		].join('\n'));

		mockExecResult({ stdout: 'src/functions.ts\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal).not.toBeNull();
		// 4 public symbols, 3 documented → score = 0.75
		expect(signal!.score).toBe(0.75);
		expect(signal!.description).toContain('3/4');
	});

	it('returns null when git diff fails', async () => {
		mockExecResult({ stdout: '', exitCode: 1 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		expect(await collectDocumentationReward(tmpDir, commands)).toBeNull();
	});

	it('returns neutral when no public symbols in changed files', async () => {
		const tsFile = path.join(tmpDir, 'src', 'internal.ts');
		await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
		await fs.writeFile(tsFile, [
			'const x = 1;',
			'function internalHelper() {}',
		].join('\n'));

		mockExecResult({ stdout: 'src/internal.ts\n', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};

		const signal = await collectDocumentationReward(tmpDir, commands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('No new public symbols');
	});
});

// ─── collectPerformanceReward ────────────────────────────────────────────────

describe('collectPerformanceReward', () => {
	const benchCommands: ProjectCommands = {
		testCommand: null,
		buildCommand: null,
		lintCommand: null,
		projectType: 'node',
		...GRPO15_DEFAULTS,
		benchmarkCommand: 'npm run bench',
	};

	it('returns null when no benchmark command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await collectPerformanceReward(tmpDir, commands)).toBeNull();
	});

	it('scores 0.5 when no baseline', async () => {
		mockExecResult({ stdout: 'Total time: 500ms\nAll benchmarks passed', exitCode: 0 });

		const signal = await collectPerformanceReward(tmpDir, benchCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('no baseline');
	});

	it('penalizes regression correctly', async () => {
		// Parse "Total time: 1200ms" — regression from 1000ms baseline
		mockExecResult({ stdout: 'Total time: 1200ms', exitCode: 0 });

		// Baseline: 1000ms, current: 1200ms → regression ratio = (1200-1000)/1000 = 0.2
		const signal = await collectPerformanceReward(tmpDir, benchCommands, 1000);
		expect(signal).not.toBeNull();
		// score = max(0.0, 0.5 - 0.2 * 2) = max(0, 0.5 - 0.4) = 0.1
		expect(signal!.score).toBeCloseTo(0.1, 3);
		expect(signal!.description).toContain('slower');
	});

	it('rewards improvement correctly', async () => {
		// Parse "Total time: 800ms" — improvement from 1000ms baseline
		mockExecResult({ stdout: 'Total time: 800ms', exitCode: 0 });

		// Baseline: 1000ms, current: 800ms → regression ratio = -0.2 (improvement)
		const signal = await collectPerformanceReward(tmpDir, benchCommands, 1000);
		expect(signal).not.toBeNull();
		// score = min(1.0, 0.5 + 0.2 * 2) = min(1.0, 0.9) = 0.9
		expect(signal!.score).toBeCloseTo(0.9, 3);
		expect(signal!.description).toContain('faster');
	});

	it('returns 0.0 for failed benchmark', async () => {
		mockExecResult({ stderr: 'Benchmark error', exitCode: 1 });

		const signal = await collectPerformanceReward(tmpDir, benchCommands);
		expect(signal!.score).toBe(0.0);
		expect(signal!.description).toContain('failed');
	});

	it('returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectPerformanceReward(tmpDir, benchCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});
});

// ─── capturePerformanceBaseline ──────────────────────────────────────────────

describe('capturePerformanceBaseline', () => {
	it('returns null when no benchmark command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'unknown',
			...GRPO15_DEFAULTS,
		};
		expect(await capturePerformanceBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns parsed duration', async () => {
		mockExecResult({ stdout: 'Total time: 750ms', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			benchmarkCommand: 'npm run bench',
		};

		expect(await capturePerformanceBaseline(tmpDir, commands)).toBe(750);
	});
});

// ─── collectBundleSizeReward ─────────────────────────────────────────────────

describe('collectBundleSizeReward', () => {
	const bundleCommands: ProjectCommands = {
		testCommand: null,
		buildCommand: 'npm run build',
		lintCommand: null,
		projectType: 'node',
		...GRPO15_DEFAULTS,
		bundleBuildCommand: 'npm run build',
	};

	it('returns null for non-Node projects', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'cargo build',
			lintCommand: null,
			projectType: 'rust',
			...GRPO15_DEFAULTS,
			bundleBuildCommand: null,
		};
		expect(await collectBundleSizeReward(tmpDir, commands)).toBeNull();
	});

	it('returns null when no bundle build command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};
		expect(await collectBundleSizeReward(tmpDir, commands)).toBeNull();
	});

	it('scores 0.5 for unchanged size (±1KB tolerance)', async () => {
		// Create dist dir with known size
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'bundle.js'), 'x'.repeat(50_000));

		mockExecResult({ stdout: 'Build complete', exitCode: 0 });

		// Baseline 50_000 bytes, current 50_000 bytes → delta < 1KB
		const signal = await collectBundleSizeReward(tmpDir, bundleCommands, 50_000);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('unchanged');
	});

	it('penalizes 50KB+ increase to 0.0', async () => {
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'bundle.js'), 'x'.repeat(100_000));

		mockExecResult({ stdout: 'Build complete', exitCode: 0 });

		// Baseline 50_000 bytes, current 100_000 → +50KB → deltaKB = ~48.8
		// score = max(0.0, 0.5 - 48.8/100) ≈ 0.012 (close to 0)
		const signal = await collectBundleSizeReward(tmpDir, bundleCommands, 50_000);
		expect(signal).not.toBeNull();
		expect(signal!.score).toBeLessThan(0.1);
	});

	it('rewards size decrease', async () => {
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'bundle.js'), 'x'.repeat(30_000));

		mockExecResult({ stdout: 'Build complete', exitCode: 0 });

		// Baseline 50_000, current 30_000 → -20KB
		// score = min(1.0, 0.5 + 19.5/100) ≈ 0.695
		const signal = await collectBundleSizeReward(tmpDir, bundleCommands, 50_000);
		expect(signal).not.toBeNull();
		expect(signal!.score).toBeGreaterThan(0.5);
	});

	it('returns null when build fails', async () => {
		mockExecResult({ stderr: 'Build error', exitCode: 1 });

		const signal = await collectBundleSizeReward(tmpDir, bundleCommands);
		expect(signal).toBeNull();
	});

	it('returns timeout signal', async () => {
		mockExecResult({ killed: true, exitCode: 1 });

		const signal = await collectBundleSizeReward(tmpDir, bundleCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('timed out');
	});

	it('returns neutral score when no baseline', async () => {
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'bundle.js'), 'x'.repeat(50_000));

		mockExecResult({ stdout: 'Build complete', exitCode: 0 });

		const signal = await collectBundleSizeReward(tmpDir, bundleCommands);
		expect(signal!.score).toBe(0.5);
		expect(signal!.description).toContain('no baseline');
	});
});

// ─── captureBundleSizeBaseline ───────────────────────────────────────────────

describe('captureBundleSizeBaseline', () => {
	it('returns null for non-Node projects', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'python',
			...GRPO15_DEFAULTS,
		};
		expect(await captureBundleSizeBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns null when no bundle build command', async () => {
		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
		};
		expect(await captureBundleSizeBaseline(tmpDir, commands)).toBeNull();
	});

	it('returns bundle size after build', async () => {
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'main.js'), 'x'.repeat(10_000));
		await fs.writeFile(path.join(distDir, 'style.css'), 'y'.repeat(5_000));

		mockExecResult({ stdout: 'Build complete', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: 'npm run build',
			lintCommand: null,
			projectType: 'node',
			...GRPO15_DEFAULTS,
			bundleBuildCommand: 'npm run build',
		};

		const size = await captureBundleSizeBaseline(tmpDir, commands);
		expect(size).toBe(15_000);
	});
});

// ─── Integration: collectAllRewards includes new signals ─────────────────────

describe('collectAllRewards integration', () => {
	it('includes new signals when weights > 0', async () => {
		// Set up a project with a manifest and schema for dependency + api-contract
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18' },
		}));

		const schemaPath = path.join(tmpDir, 'openapi.json');
		const schema = JSON.stringify({ openapi: '3.0.0', paths: { '/api': {} } });
		await fs.writeFile(schemaPath, schema);

		// Create dist for bundle size
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'app.js'), 'x'.repeat(1000));

		// Create a source file for documentation analysis
		await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
		await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), '/** Doc */\nexport function main() {}\n');

		// Mock exec to always succeed
		mockExecResult({ stdout: '', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: 'npm run build',
			lintCommand: 'npm run lint',
			projectType: 'node',
			coverageCommand: null, // skip coverage to keep test focused
			typeCheckCommand: 'npx tsc --noEmit',
			complexityCommand: null, // skip complexity
			securityScanCommand: 'npm audit --json',
			benchmarkCommand: null, // skip benchmark
			bundleBuildCommand: 'npm run build',
			manifestPath,
			apiSchemaPath: schemaPath,
		};

		const baselines: RewardBaselines = {
			lintErrors: 0,
			dependencies: ['react'],
			apiSchema: schema,
			bundleSizeBytes: 1000,
		};

		const signals = await collectAllRewards(tmpDir, 0, 'done', GRPO_CONFIG_DEFAULTS, commands, baselines);
		const types = signals.map(s => s.type);

		// Should include both sync signals and at least the new signals that have commands
		expect(types).toContain('process-exit-code');
		expect(types).toContain('task-complete');
		expect(types).toContain('type-safety');
		expect(types).toContain('security-scan');
		expect(types).toContain('dependency-hygiene');
		expect(types).toContain('api-contract');
		expect(types).toContain('bundle-size-delta');
	});

	it('skips new signals when weights are 0', async () => {
		const config: GRPOConfig = {
			...GRPO_CONFIG_DEFAULTS,
			rewardWeights: {
				...GRPO_CONFIG_DEFAULTS.rewardWeights,
				// Zero out all async collectors
				'test-pass': 0,
				'test-fail': 0,
				'build-success': 0,
				'build-fail': 0,
				'lint-clean': 0,
				'lint-errors': 0,
				'git-diff-quality': 0,
				'test-coverage-delta': 0,
				'type-safety': 0,
				'complexity-delta': 0,
				'security-scan': 0,
				'dependency-hygiene': 0,
				'api-contract': 0,
				'documentation-coverage': 0,
				'runtime-performance': 0,
				'bundle-size-delta': 0,
			},
		};

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: 'npm run build',
			lintCommand: 'npm run lint',
			projectType: 'node',
			coverageCommand: 'npx vitest run --coverage',
			typeCheckCommand: 'npx tsc --noEmit',
			complexityCommand: 'npx cr --format json',
			securityScanCommand: 'npm audit --json',
			benchmarkCommand: 'npm run bench',
			bundleBuildCommand: 'npm run build',
			manifestPath: '/fake/package.json',
			apiSchemaPath: '/fake/openapi.json',
		};

		const signals = await collectAllRewards(tmpDir, 0, 'done', config, commands);
		const types = signals.map(s => s.type);

		// Only sync signals with non-zero weight
		expect(types).toContain('process-exit-code');
		expect(types).toContain('task-complete');
		// None of the new signals
		expect(types).not.toContain('test-coverage-delta');
		expect(types).not.toContain('type-safety');
		expect(types).not.toContain('complexity-delta');
		expect(types).not.toContain('security-scan');
		expect(types).not.toContain('dependency-hygiene');
		expect(types).not.toContain('api-contract');
		expect(types).not.toContain('documentation-coverage');
		expect(types).not.toContain('runtime-performance');
		expect(types).not.toContain('bundle-size-delta');
	});
});

// ─── Integration: captureAllBaselines ────────────────────────────────────────

describe('captureAllBaselines', () => {
	it('captures all baseline types in parallel', async () => {
		// Set up manifest and schema files
		const manifestPath = path.join(tmpDir, 'package.json');
		await fs.writeFile(manifestPath, JSON.stringify({
			dependencies: { react: '^18' },
			devDependencies: { vitest: '^1' },
		}));

		const schemaPath = path.join(tmpDir, 'openapi.json');
		await fs.writeFile(schemaPath, '{"openapi":"3.0.0"}');

		// Create dist for bundle size
		const distDir = path.join(tmpDir, 'dist');
		await fs.mkdir(distDir, { recursive: true });
		await fs.writeFile(path.join(distDir, 'bundle.js'), 'x'.repeat(5000));

		// Mock exec to succeed for all commands
		mockExecResult({ stdout: '', exitCode: 0 });

		const commands: ProjectCommands = {
			testCommand: 'npm test',
			buildCommand: 'npm run build',
			lintCommand: 'npm run lint',
			projectType: 'node',
			coverageCommand: null,
			typeCheckCommand: 'npx tsc --noEmit',
			complexityCommand: null,
			securityScanCommand: 'npm audit --json',
			benchmarkCommand: null,
			bundleBuildCommand: 'npm run build',
			manifestPath,
			apiSchemaPath: schemaPath,
		};

		const baselines = await captureAllBaselines(tmpDir, commands, GRPO_CONFIG_DEFAULTS);

		// Lint baseline should be captured (exit code 0 = 0 errors)
		expect(baselines.lintErrors).toBe(0);
		// Type check baseline (exit code 0 = 0 errors)
		expect(baselines.typeErrors).toBe(0);
		// Security baseline (exit code 0 = 0 findings)
		expect(baselines.securityFindings).toBe(0);
		// Dependency baseline
		expect(baselines.dependencies).toEqual(['react', 'vitest']);
		// API schema baseline
		expect(baselines.apiSchema).toBe('{"openapi":"3.0.0"}');
		// Bundle size baseline
		expect(baselines.bundleSizeBytes).toBe(5000);
	});

	it('skips baselines for collectors with weight 0', async () => {
		const config: GRPOConfig = {
			...GRPO_CONFIG_DEFAULTS,
			rewardWeights: {
				...GRPO_CONFIG_DEFAULTS.rewardWeights,
				'lint-clean': 0,
				'lint-errors': 0,
				'test-coverage-delta': 0,
				'type-safety': 0,
				'complexity-delta': 0,
				'security-scan': 0,
				'dependency-hygiene': 0,
				'api-contract': 0,
				'runtime-performance': 0,
				'bundle-size-delta': 0,
			},
		};

		const commands: ProjectCommands = {
			testCommand: null,
			buildCommand: null,
			lintCommand: 'npm run lint',
			projectType: 'node',
			coverageCommand: 'npx vitest run --coverage',
			typeCheckCommand: 'npx tsc --noEmit',
			complexityCommand: 'npx cr --format json',
			securityScanCommand: 'npm audit --json',
			benchmarkCommand: 'npm run bench',
			bundleBuildCommand: 'npm run build',
			manifestPath: '/fake/package.json',
			apiSchemaPath: '/fake/openapi.json',
		};

		const baselines = await captureAllBaselines(tmpDir, commands, config);

		// All should be undefined since weights are 0
		expect(baselines.lintErrors).toBeUndefined();
		expect(baselines.coverage).toBeUndefined();
		expect(baselines.typeErrors).toBeUndefined();
		expect(baselines.complexity).toBeUndefined();
		expect(baselines.securityFindings).toBeUndefined();
		expect(baselines.dependencies).toBeUndefined();
		expect(baselines.apiSchema).toBeUndefined();
		expect(baselines.benchmarkDurationMs).toBeUndefined();
		expect(baselines.bundleSizeBytes).toBeUndefined();
	});
});
