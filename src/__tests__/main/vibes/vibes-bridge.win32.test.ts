/**
 * Windows-specific tests for src/main/vibes/vibes-bridge.ts.
 *
 * On Windows a cargo install produces `vibecheck.exe` and npm shims are
 * `vibecheck.cmd`, so binary detection must probe platform extensions, the
 * POSIX-only /usr/local/bin candidate must be skipped, and `.cmd`/`.bat`
 * shims must be spawned through a shell (execFile throws EINVAL on them on
 * modern Node).
 *
 * `process.platform` is mocked to 'win32' (platformDetection reads it at
 * call time). The `path` module stays host-bound, so candidate paths use
 * host separators; assertions match on suffixes rather than full separators.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';

// Hoist mock functions so they're available during vi.mock factory execution
const { mockExecFile, mockAccess } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	mockAccess: vi.fn(),
}));

// path-prober returns the machine's real expanded PATH, which would override
// the deterministic process.env.PATH these tests set. Make it unavailable.
vi.mock('../../../main/agents/path-prober', () => ({
	getExpandedEnv: () => {
		throw new Error('path-prober unavailable in test');
	},
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: { ...actual, execFile: mockExecFile },
		execFile: mockExecFile,
	};
});

// Mock util.promisify to wrap our mockExecFile
vi.mock('util', async (importOriginal) => {
	const actual = await importOriginal<typeof import('util')>();
	const promisifyMock = (fn: any) => {
		if (fn === mockExecFile) {
			return async (...args: any[]) => {
				return new Promise((resolve, reject) => {
					mockExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
						if (error) reject(error);
						else resolve({ stdout, stderr });
					});
				});
			};
		}
		return actual.promisify(fn);
	};
	return {
		...actual,
		default: { ...actual, promisify: promisifyMock },
		promisify: promisifyMock,
	};
});

// Mock fs/promises with constants from the real fs module
vi.mock('fs/promises', async () => {
	const fsConstants = await import('fs').then((m) => m.constants);
	return {
		access: mockAccess,
		constants: fsConstants,
		default: { access: mockAccess, constants: fsConstants },
	};
});

// Pin the resolved Windows shell so shell-routing assertions are deterministic
vi.mock('../../../main/process-manager/utils/shellEscape', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../main/process-manager/utils/shellEscape')>();
	return {
		...actual,
		getWindowsShellForAgentExecution: vi.fn(() => ({
			shell: 'powershell.exe',
			useShell: true,
			source: 'powershell-default' as const,
		})),
	};
});

const realPlatform = process.platform;
const realPath = process.env.PATH;

function enoent(): Error {
	return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

describe('vibes-bridge (win32)', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		process.env.PATH = '';
		const mod = await import('../../../main/vibes/vibes-bridge');
		mod.clearBinaryPathCache();
	});

	afterEach(() => {
		Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
		process.env.PATH = realPath;
		vi.restoreAllMocks();
	});

	function mockExecSuccess(stdout: string, stderr = '') {
		mockExecFile.mockImplementation(
			(_cmd: string, _args: readonly string[], _options: any, callback?: any) => {
				if (callback) {
					callback(null, stdout, stderr);
				}
				return {} as any;
			}
		);
	}

	describe('findVibesCheckBinary', () => {
		it('discovers a .exe candidate in ~/.cargo/bin', async () => {
			mockAccess.mockImplementation((p: string) =>
				p.endsWith('vibecheck.exe') ? Promise.resolve() : Promise.reject(enoent())
			);

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBe(path.join(os.homedir(), '.cargo', 'bin', 'vibecheck.exe'));
		});

		it('discovers a .cmd npm shim in node_modules/.bin', async () => {
			mockAccess.mockImplementation((p: string) =>
				p.includes('node_modules') && p.endsWith('vibecheck.cmd')
					? Promise.resolve()
					: Promise.reject(enoent())
			);

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary(undefined, path.join('C:', 'proj'));
			expect(result).toBe(path.join('C:', 'proj', 'node_modules', '.bin', 'vibecheck.cmd'));
		});

		it('does not probe the POSIX /usr/local/bin candidate on Windows', async () => {
			mockAccess.mockRejectedValue(enoent());

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBeNull();

			const probed = mockAccess.mock.calls.map((c) => String(c[0]));
			expect(probed.length).toBeGreaterThan(0);
			expect(probed.some((p) => p.includes(path.join('/usr', 'local', 'bin')))).toBe(false);
			// Windows extensions were probed
			expect(probed.some((p) => p.endsWith('vibecheck.exe'))).toBe(true);
			expect(probed.some((p) => p.endsWith('vibecheck.cmd'))).toBe(true);
			expect(probed.some((p) => p.endsWith('vibecheck.bat'))).toBe(true);
		});

		it('probes only the bare name on POSIX platforms', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			mockAccess.mockRejectedValue(enoent());

			const { findVibesCheckBinary } = await import('../../../main/vibes/vibes-bridge');
			const result = await findVibesCheckBinary();
			expect(result).toBeNull();

			const probed = mockAccess.mock.calls.map((c) => String(c[0]));
			expect(probed.every((p) => p.endsWith('vibecheck'))).toBe(true);
			expect(probed.some((p) => p.includes(path.join('/usr', 'local', 'bin')))).toBe(true);
		});
	});

	describe('shell routing for Windows shims', () => {
		it('spawns a .cmd binary through a shell with the PowerShell call operator', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockExecSuccess('Build complete');

			const cmdPath = 'vibecheck-shims/vibecheck.cmd';
			const { vibesBuild } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesBuild('/my/project', cmdPath);
			expect(result).toEqual({ success: true });

			expect(mockExecFile).toHaveBeenCalledTimes(1);
			const [file, args, options] = mockExecFile.mock.calls[0];
			expect(options.shell).toBe('powershell.exe');
			expect(String(file).startsWith('& ')).toBe(true);
			expect(String(file)).toContain('vibecheck.cmd');
			expect(args).toEqual(['build']);
		});

		it('spawns a .bat binary through a shell', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockExecSuccess('{}');

			const { vibesReport } = await import('../../../main/vibes/vibes-bridge');
			await vibesReport('/my/project', 'json', 'vibecheck-shims/vibecheck.bat');

			const [, , options] = mockExecFile.mock.calls[0];
			expect(options.shell).toBe('powershell.exe');
		});

		it('spawns a .exe binary directly without a shell', async () => {
			mockAccess.mockResolvedValue(undefined);
			mockExecSuccess('Build complete');

			const exePath = 'vibecheck-bins/vibecheck.exe';
			const { vibesBuild } = await import('../../../main/vibes/vibes-bridge');
			const result = await vibesBuild('/my/project', exePath);
			expect(result).toEqual({ success: true });

			const [file, args, options] = mockExecFile.mock.calls[0];
			expect(options.shell).toBeUndefined();
			expect(String(file)).toBe(path.resolve(exePath));
			expect(args).toEqual(['build']);
		});

		it('does not shell-route .cmd paths on POSIX platforms', async () => {
			Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
			mockAccess.mockResolvedValue(undefined);
			mockExecSuccess('Build complete');

			const { vibesBuild } = await import('../../../main/vibes/vibes-bridge');
			await vibesBuild('/my/project', 'vibecheck-shims/vibecheck.cmd');

			const [, , options] = mockExecFile.mock.calls[0];
			expect(options.shell).toBeUndefined();
		});
	});
});
