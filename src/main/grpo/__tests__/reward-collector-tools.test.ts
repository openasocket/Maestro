/**
 * Tests for reward-collector tool dependency hardening (GRPO-19).
 * Validates availability checks for external tools and parser updates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../utils/logger', () => ({
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

// Mock fs/promises
const mockAccess = vi.fn();
const mockReadFile = vi.fn();
vi.mock(import('fs/promises'), async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		default: { ...actual, access: (...args: any[]) => mockAccess(...args), readFile: (...args: any[]) => mockReadFile(...args) },
		access: (...args: any[]) => mockAccess(...args),
		readFile: (...args: any[]) => mockReadFile(...args),
	};
});

import { detectProjectCommands, parseAverageComplexity } from '../reward-collector';

// Helper to set up file existence
function mockFileExists(existingFiles: string[]): void {
	mockAccess.mockImplementation(async (filePath: string) => {
		if (existingFiles.some(f => filePath.endsWith(f))) {
			return undefined;
		}
		throw new Error('ENOENT');
	});
}

// Helper to set up file contents
function mockFileContents(contents: Record<string, string>): void {
	mockReadFile.mockImplementation(async (filePath: string) => {
		for (const [key, value] of Object.entries(contents)) {
			if (filePath.endsWith(key)) return value;
		}
		throw new Error('ENOENT');
	});
}

// Helper to set up verification command results.
// exec() runs through a shell, so missing commands exit with code 127
// (not ENOENT). We simulate this realistically.
function mockVerificationCommands(availableTools: Record<string, boolean>): void {
	mockExec.mockImplementation((command: string, _options: any, callback?: Function) => {
		if (!callback) return { on: vi.fn() };

		// Check if any tool in our map matches the command
		for (const [tool, isAvailable] of Object.entries(availableTools)) {
			if (command.includes(tool)) {
				if (isAvailable) {
					callback(null, `${tool} version 1.0.0`, '');
				} else {
					// Shell returns exit code 127 for command not found
					const err: any = new Error(`/bin/sh: ${tool}: not found`);
					err.code = 127;
					err.killed = false;
					callback(err, '', `/bin/sh: ${tool}: not found`);
				}
				return { on: vi.fn() };
			}
		}

		// Default: command not found (exit code 127)
		const err: any = new Error('command not found');
		err.code = 127;
		err.killed = false;
		callback(err, '', 'command not found');
		return { on: vi.fn() };
	});
}

const PROJECT_PATH = '/test/project';

describe('Tool Dependency Hardening — Detection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('Node.js complexity detection', () => {
		it('should NOT contain cr anywhere in complexity command', async () => {
			mockFileExists(['package.json', 'eslint.config.js']);
			mockFileContents({
				'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
			});
			mockVerificationCommands({});

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).not.toContain('cr');
		});

		it('should set ESLint complexity when lint script exists', async () => {
			mockFileExists(['package.json']);
			mockFileContents({
				'package.json': JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }),
			});
			mockVerificationCommands({});

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).toContain('eslint');
			expect(commands.complexityCommand).toContain('complexity');
		});

		it('should set ESLint complexity when eslint config file exists (no lint script)', async () => {
			mockFileExists(['package.json', 'eslint.config.js']);
			mockFileContents({
				'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
			});
			mockVerificationCommands({});

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).toContain('eslint');
		});

		it('should set complexityCommand to null without ESLint', async () => {
			mockFileExists(['package.json']);
			mockFileContents({
				'package.json': JSON.stringify({ scripts: { test: 'vitest' } }),
			});
			mockVerificationCommands({});

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).toBeNull();
		});
	});

	describe('Python tool availability', () => {
		it('should set radon complexity when radon is installed', async () => {
			mockFileExists(['pyproject.toml']);
			mockFileContents({
				'pyproject.toml': '[tool.pytest]\n',
			});
			mockVerificationCommands({ radon: true });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).toBe('radon cc . -s -j');
		});

		it('should set complexityCommand to null when radon is not installed', async () => {
			mockFileExists(['pyproject.toml']);
			mockFileContents({
				'pyproject.toml': '[tool.pytest]\n',
			});
			mockVerificationCommands({ radon: false });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.complexityCommand).toBeNull();
		});

		it('should set bandit when config AND binary both exist', async () => {
			mockFileExists(['pyproject.toml', '.bandit']);
			mockFileContents({
				'pyproject.toml': 'bandit\n[tool.pytest]\n',
			});
			mockVerificationCommands({ radon: false, bandit: true });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.securityScanCommand).toBe('bandit -r . -f json');
		});

		it('should set securityScanCommand to null when bandit config exists but binary missing', async () => {
			mockFileExists(['pyproject.toml', '.bandit']);
			mockFileContents({
				'pyproject.toml': 'bandit\n[tool.pytest]\n',
			});
			mockVerificationCommands({ radon: false, bandit: false });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.securityScanCommand).toBeNull();
		});
	});

	describe('Rust cargo-audit availability', () => {
		it('should set cargo audit when cargo-audit is installed', async () => {
			mockFileExists(['Cargo.toml']);
			mockFileContents({});
			mockVerificationCommands({ 'cargo audit': true });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.projectType).toBe('rust');
			expect(commands.securityScanCommand).toBe('cargo audit --json');
		});

		it('should set securityScanCommand to null when cargo-audit is not installed', async () => {
			mockFileExists(['Cargo.toml']);
			mockFileContents({});
			mockVerificationCommands({ 'cargo audit': false });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.projectType).toBe('rust');
			expect(commands.securityScanCommand).toBeNull();
		});
	});

	describe('Go gocyclo availability', () => {
		it('should set gocyclo complexity when gocyclo is installed', async () => {
			mockFileExists(['go.mod']);
			mockFileContents({});
			mockVerificationCommands({ gocyclo: true, 'golangci-lint': false, govulncheck: false });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.projectType).toBe('go');
			expect(commands.complexityCommand).toBe('gocyclo -avg .');
		});

		it('should set complexityCommand to null when gocyclo is not installed', async () => {
			mockFileExists(['go.mod']);
			mockFileContents({});
			mockVerificationCommands({ gocyclo: false, 'golangci-lint': false, govulncheck: false });

			const commands = await detectProjectCommands(PROJECT_PATH);
			expect(commands.projectType).toBe('go');
			expect(commands.complexityCommand).toBeNull();
		});
	});
});

describe('Tool Dependency Hardening — Parser', () => {
	describe('ESLint JSON complexity parsing', () => {
		it('should parse ESLint JSON complexity output correctly', () => {
			const eslintOutput = JSON.stringify([{
				filePath: '/test.ts',
				messages: [
					{ ruleId: 'complexity', severity: 1, message: "Function 'a' has a complexity of 5. Maximum allowed is 1." },
					{ ruleId: 'complexity', severity: 1, message: "Function 'b' has a complexity of 15. Maximum allowed is 1." },
				],
			}]);

			const result = parseAverageComplexity(eslintOutput, 'node');
			expect(result).toBe(10.0);
		});

		it('should handle ESLint output with mixed rule messages', () => {
			const eslintOutput = JSON.stringify([{
				filePath: '/test.ts',
				messages: [
					{ ruleId: 'complexity', severity: 1, message: "Function 'a' has a complexity of 8. Maximum allowed is 1." },
					{ ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used." },
					{ ruleId: 'complexity', severity: 1, message: "Function 'b' has a complexity of 4. Maximum allowed is 1." },
				],
			}]);

			const result = parseAverageComplexity(eslintOutput, 'node');
			expect(result).toBe(6.0);
		});

		it('should return null for empty ESLint array', () => {
			const result = parseAverageComplexity('[]', 'node');
			expect(result).toBeNull();
		});

		it('should handle ESLint output with no complexity messages', () => {
			const eslintOutput = JSON.stringify([{
				filePath: '/test.ts',
				messages: [
					{ ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used." },
				],
			}]);

			const result = parseAverageComplexity(eslintOutput, 'node');
			expect(result).toBeNull();
		});
	});

	describe('gocyclo output parsing', () => {
		it('should parse gocyclo -avg output', () => {
			const gocycloOutput = '1 pkg.FuncA file.go:1:1\n5 pkg.FuncB file.go:10:1\nAverage: 3.0';
			const result = parseAverageComplexity(gocycloOutput, 'go');
			expect(result).toBe(3.0);
		});

		it('should parse gocyclo with integer average', () => {
			const gocycloOutput = 'Average: 7';
			const result = parseAverageComplexity(gocycloOutput, 'go');
			expect(result).toBe(7);
		});
	});

	describe('radon JSON parsing (existing behavior)', () => {
		it('should still parse radon JSON correctly', () => {
			const radonOutput = JSON.stringify({
				'file.py': [{ complexity: 4 }, { complexity: 8 }],
			});
			const result = parseAverageComplexity(radonOutput, 'python');
			expect(result).toBe(6.0);
		});

		it('should handle radon JSON with multiple files', () => {
			const radonOutput = JSON.stringify({
				'a.py': [{ complexity: 2 }],
				'b.py': [{ complexity: 10 }],
			});
			const result = parseAverageComplexity(radonOutput, 'python');
			expect(result).toBe(6.0);
		});
	});

	describe('radon text parsing (existing behavior)', () => {
		it('should parse radon text output', () => {
			const radonText = '    F 12:0 function_name - B (6)\n    F 20:0 other_func - A (3)';
			const result = parseAverageComplexity(radonText, 'python');
			expect(result).toBe(4.5);
		});
	});

	describe('negative tests', () => {
		it('should return null for unparseable output', () => {
			const result = parseAverageComplexity('some random text without any patterns', 'node');
			expect(result).toBeNull();
		});

		it('should return null for empty output', () => {
			const result = parseAverageComplexity('', 'node');
			expect(result).toBeNull();
		});

		it('should return null for cr package output (carriage return utility)', () => {
			// cr@0.1.0 outputs carriage return characters, not complexity data
			const crOutput = '\r\n\r\n';
			const result = parseAverageComplexity(crOutput, 'node');
			expect(result).toBeNull();
		});
	});
});
