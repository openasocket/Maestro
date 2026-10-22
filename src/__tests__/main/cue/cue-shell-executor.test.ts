/**
 * Tests for cue-shell-executor.
 *
 * Verifies that subscriptions with `action: command` + `command.mode: 'shell'`
 * spawn through `shell: true` (PATH-aware), in the owning session's project
 * root, with template substitution, captured stdout/stderr/exitCode, and
 * timeout enforcement.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

const mockCaptureException = vi.fn();
const mockCaptureMessage = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
	captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

const mockGetShellPath = vi.fn(async () => '/login/shell/bin:/usr/bin:/bin');
vi.mock('../../../shared/maestro-lib/launch/getShellPath', () => ({
	getShellPath: () => mockGetShellPath(),
	peekShellPath: () => null,
}));

// Mock the ssh-spawn-wrapper's spawn builder. Mocking avoids pulling in the
// transitive ssh-command-builder → execFile chain, which would try to wrap
// the mocked `child_process` and break at module load. The failure message is
// a stand-in; its real wording is covered by the ssh-spawn-wrapper suite.
const { mockWrapSpawnWithSsh } = vi.hoisted(() => ({
	mockWrapSpawnWithSsh: vi.fn(),
}));
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: mockWrapSpawnWithSsh,
	sshUnresolvedRemoteMessage: (cfg: { remoteId: string | null }) =>
		`remote "${cfg.remoteId}" could not be resolved`,
}));

// Platform is mockable per-test; default is the POSIX kill path
// (child.kill('SIGTERM')) so signal-based assertions hold regardless of host
// OS - mirroring what CI exercises on Unix. The Windows test flips it to true
// to exercise the taskkill branch.
const { mockIsWindows, mockExecFile } = vi.hoisted(() => ({
	mockIsWindows: vi.fn(() => false),
	mockExecFile: vi.fn((_cmd: unknown, _args: unknown, cb?: unknown) => {
		if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
	}),
}));
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return {
		...actual,
		isWindows: () => mockIsWindows(),
	};
});

class MockChildProcess extends EventEmitter {
	pid = 54321;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(_signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;
const mockSpawn = vi.fn((..._args: unknown[]) => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		execFile: (...args: unknown[]) => mockExecFile(...(args as [unknown, unknown, unknown?])),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
			execFile: (...args: unknown[]) => mockExecFile(...(args as [unknown, unknown, unknown?])),
		},
	};
});

import { executeCueShell } from '../../../main/cue/cue-shell-executor';
import { getProcessList, stopProcess } from '../../../main/cue/cue-process-lifecycle';
import { wrapSpawnWithSsh } from '../../../shared/maestro-lib/launch/ssh-spawn-wrapper';
import {
	createContextVerifier,
	createLocalHostAuthority,
	type AdmissionRequest,
	type DispatchLease,
	type PolicyDecision,
} from '../../../shared/maestro-lib/managed/authority';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
import type { CueManagedAdmission } from '../../../main/cue/cue-executor';
import type { CueShellRoute, CueShellRouteSupport } from '../../../main/enterprise/dispatch';

function createSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
	};
}

function createEvent(): CueEvent {
	return {
		id: 'evt-1',
		type: 'time.heartbeat',
		timestamp: '2026-04-16T10:00:00.000Z',
		triggerName: 'shell-test',
		payload: {},
	};
}

function createSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'shell-test',
		event: 'time.heartbeat',
		enabled: true,
		prompt: 'echo hello',
		action: 'command',
		command: { mode: 'shell', shell: 'echo hello' },
		...overrides,
	};
}

function createConfig(overrides: Record<string, unknown> = {}) {
	const templateContext: TemplateContext = {
		session: {
			id: 'session-1',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		},
	};
	return {
		runId: 'run-1',
		session: createSession(),
		subscription: createSubscription(),
		event: createEvent(),
		shellCommand: 'echo hello',
		projectRoot: '/projects/test',
		templateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

describe('cue-shell-executor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default to the POSIX branch; the Windows test opts in via mockReturnValue(true).
		mockIsWindows.mockReturnValue(false);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('spawns nothing when stopped while the PATH probe is awaited', async () => {
		let finishProbe!: (value: string) => void;
		mockGetShellPath.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finishProbe = resolve;
				})
		);
		const controller = new AbortController();
		const promise = executeCueShell(createConfig({ signal: controller.signal }) as any);
		await vi.advanceTimersByTimeAsync(0);
		expect(mockGetShellPath).toHaveBeenCalledTimes(1);

		controller.abort();
		finishProbe('/usr/bin:/bin');
		const result = await promise;
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: 'stopped', exitCode: null, stderr: '' });
	});

	it('spawns nothing when stopped while the SSH wrap is awaited', async () => {
		let finishWrap!: (value: unknown) => void;
		mockWrapSpawnWithSsh.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishWrap = resolve;
				}) as ReturnType<typeof wrapSpawnWithSsh>
		);
		const controller = new AbortController();
		const promise = executeCueShell(
			createConfig({
				signal: controller.signal,
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: { getSshRemotes: () => [] },
			}) as any
		);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		finishWrap({
			command: 'ssh',
			args: ['host', 'bash -c echo'],
			cwd: '/projects/test',
			sshRemoteUsed: { id: 'remote-1', name: 'r', host: 'h' },
		});
		const result = await promise;
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('stopped');
	});

	it('spawns the command through the shell so PATH is honored', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const call = mockSpawn.mock.calls[0];
		expect(call[0]).toBe('echo hello');
		expect(call[1]).toEqual([]);
		const opts = call[2] as Record<string, unknown>;
		expect(opts.shell).toBe(true);
		expect(opts.cwd).toBe('/projects/test');
		const env = opts.env as Record<string, string>;
		// Local mode replaces PATH with the login-shell PATH so user-installed
		// binaries (msgvault, pnpm, etc.) resolve under macOS GUI launches.
		expect(env.PATH).toBe('/login/shell/bin:/usr/bin:/bin');
		expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);

		mockChild.emit('close', 0);
		await promise;
	});

	it('claims the Cue origin in the command env, over an inherited value', async () => {
		// What the command launches can start an agent turn (`maestro-cli send`),
		// which reads this to record the turn as Cue's.
		vi.stubEnv('MAESTRO_QUERY_SOURCE', 'user');
		const promise = executeCueShell(createConfig() as any);
		await vi.advanceTimersByTimeAsync(0);

		const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
		expect((opts.env as Record<string, string>).MAESTRO_QUERY_SOURCE).toBe('cue');

		mockChild.emit('close', 0);
		await promise;
		vi.unstubAllEnvs();
	});

	it('falls back to the expanded PATH, not the launchd PATH, when getShellPath fails (#1573)', async () => {
		const launchdPath = '/usr/bin:/bin:/usr/sbin:/sbin';
		const originalPath = process.env.PATH;
		process.env.PATH = launchdPath;
		try {
			mockGetShellPath.mockRejectedValueOnce(new Error('shell probe timed out'));
			const config = createConfig();
			const promise = executeCueShell(config as any);
			await vi.advanceTimersByTimeAsync(0);

			const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
			const env = opts.env as Record<string, string>;
			expect(env.PATH).not.toBe(launchdPath);
			expect(env.PATH).toContain('/usr/bin');
			if (process.platform !== 'win32') {
				const parts = env.PATH.split(':');
				expect(parts).toContain('/opt/homebrew/bin');
				expect(parts).toContain('/usr/local/bin');
			}
			expect(mockCaptureMessage).toHaveBeenCalledWith(
				expect.stringContaining('cue:shell falling back to expanded PATH'),
				'warning'
			);

			mockChild.emit('close', 0);
			await promise;
		} finally {
			process.env.PATH = originalPath;
		}
	});

	it('falls back to the expanded PATH when getShellPath returns nothing', async () => {
		mockGetShellPath.mockResolvedValueOnce('');
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
		const env = opts.env as Record<string, string>;
		expect(env.PATH).toBeTruthy();
		if (process.platform !== 'win32') {
			expect(env.PATH.split(':')).toContain('/opt/homebrew/bin');
		}

		mockChild.emit('close', 0);
		await promise;
	});

	it('captures stdout, stderr, and exit code on success', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		mockChild.stdout.emit('data', 'line one\n');
		mockChild.stdout.emit('data', 'line two\n');
		mockChild.stderr.emit('data', 'a warning\n');
		mockChild.emit('close', 0);

		const result = await promise;
		expect(result.status).toBe('completed');
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe('line one\nline two\n');
		expect(result.stderr).toBe('a warning\n');
		expect(result.subscriptionName).toBe('shell-test');
	});

	it('substitutes Cue template variables in the command before spawning', async () => {
		const config = createConfig({
			shellCommand: 'echo {{CUE_RUN_ID}} from {{CUE_TRIGGER_NAME}}',
		});
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const cmd = mockSpawn.mock.calls[0][0] as string;
		expect(cmd).toContain('echo run-1 from shell-test');

		mockChild.emit('close', 0);
		await promise;
	});

	it('returns a failed result without spawning when the command is empty', async () => {
		const config = createConfig({ shellCommand: '   ' });
		const result = await executeCueShell(config as any);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.stderr).toMatch(/no shell command/i);
	});

	it('kills the process and reports timeout when it exceeds timeoutMs', async () => {
		const config = createConfig({ timeoutMs: 1000 });
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(1000);
		expect(mockChild.killed).toBe(true);

		mockChild.emit('close', null);
		const result = await promise;
		expect(result.status).toBe('timeout');
	});

	it('lists a running shell command in the shared Cue registry until it settles', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		// The Process Monitor reads this list - a shell run missing from it is
		// invisible there and cannot be stopped from the UI.
		expect(getProcessList()).toContainEqual(
			expect.objectContaining({ runId: 'run-1', pid: 54321, toolType: 'terminal' })
		);

		mockChild.emit('close', 0);
		await promise;
		expect(getProcessList()).not.toContainEqual(expect.objectContaining({ runId: 'run-1' }));
	});

	it('stopProcess signals an active shell run and returns true', async () => {
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const stopped = stopProcess('run-1');
		expect(stopped).toBe(true);
		expect(mockChild.killed).toBe(true);

		mockChild.emit('close', null);
		await promise;
	});

	it('stopProcess uses taskkill /t /f on Windows instead of POSIX signals', async () => {
		mockIsWindows.mockReturnValue(true);
		const config = createConfig();
		const promise = executeCueShell(config as any);
		await vi.advanceTimersByTimeAsync(0);

		const stopped = stopProcess('run-1');
		expect(stopped).toBe(true);
		expect(mockExecFile).toHaveBeenCalledWith(
			'taskkill',
			['/pid', String(mockChild.pid), '/t', '/f'],
			expect.any(Function)
		);
		// POSIX signals are a no-op for shell-spawned trees on Windows.
		expect(mockChild.killed).toBe(false);

		mockChild.emit('close', null);
		await promise;
	});

	it('stopProcess returns false for unknown runId', () => {
		expect(stopProcess('does-not-exist')).toBe(false);
	});

	it('reports failed status when spawn throws synchronously', async () => {
		mockSpawn.mockImplementationOnce(() => {
			throw new Error('command not found');
		});
		const config = createConfig();
		const result = await executeCueShell(config as any);
		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('command not found');
		expect(mockCaptureException).toHaveBeenCalled();
	});

	describe('SSH remote execution', () => {
		const sshStore = { getSshRemotes: vi.fn(() => []) };
		const sshRemoteConfig = { enabled: true, remoteId: 'remote-1' };

		it('spawns ssh (no local shell) when the remote resolves', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host', 'bash -c "echo hello"'],
				cwd: '/Users/local',
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host' },
			});

			const promise = executeCueShell(createConfig({ sshRemoteConfig, sshStore }) as any);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
				{ command: 'bash', args: ['-c', 'echo hello'], cwd: '/projects/test' },
				sshRemoteConfig,
				sshStore
			);
			const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], any];
			expect(cmd).toBe('ssh');
			expect(args).toEqual(['user@host', 'bash -c "echo hello"']);
			expect(opts.shell).toBe(false);
			expect(opts.cwd).toBe('/Users/local');

			mockChild.emit('close', 0);
			expect((await promise).status).toBe('completed');
		});

		it('fails the run without spawning locally when the remote is missing or disabled', async () => {
			// The real wrapper returns the unmodified local config in this case.
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'bash',
				args: ['-c', 'echo hello'],
				cwd: '/projects/test',
				sshRemoteUsed: null,
			});
			const onLog = vi.fn();

			const result = await executeCueShell(
				createConfig({
					sshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
					sshStore,
					onLog,
				}) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(mockGetShellPath).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.exitCode).toBeNull();
			expect(result.stderr).toBe('remote "deleted-remote" could not be resolved');
			expect(onLog).toHaveBeenCalledWith(
				'error',
				expect.stringContaining('remote "deleted-remote" could not be resolved')
			);
		});

		it('fails the run and reports to Sentry when the wrapper throws', async () => {
			mockWrapSpawnWithSsh.mockRejectedValue(new Error('ssh binary missing'));

			const result = await executeCueShell(createConfig({ sshRemoteConfig, sshStore }) as any);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.stderr).toBe('SSH wrap error: ssh binary missing');
			expect(mockCaptureException).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'cue:shell:sshWrap' })
			);
		});
	});

	/**
	 * Managed admission at the shell sink (MRC-07-03). The authority is the
	 * REAL `createLocalHostAuthority` over a policy table double and the
	 * context is verified by the real verifier; only the route table is a
	 * declared double where the sink has to be reached past the refusal.
	 */
	describe('managed admission', () => {
		let leaseSeq = 0;

		function managedAdmission(
			decide: (request: AdmissionRequest) => PolicyDecision | Promise<PolicyDecision>,
			onLease?: (lease: DispatchLease) => void
		): CueManagedAdmission {
			const authority = createLocalHostAuthority({
				authorityId: 'authority-test',
				decide,
				now: () => Date.now(),
				newId: () => `lease-${++leaseSeq}`,
			});
			const verified = createContextVerifier({
				verifierId: 'test',
				peer: 'in-process',
				now: () => Date.now(),
				accept: () => [],
			}).verify(
				inProcessContext({
					origin: 'cue',
					installation: { installationId: 'inst-1', runtimeId: 'cue-1', processEpoch: 'e1' },
					actor: { kind: 'human', id: 'actor-registered' },
					delegation: {
						chain: [
							{ kind: 'service', id: 'cue-subscription:shell-test' },
							{ kind: 'agent', id: 'session-1' },
						],
						grantRef: null,
					},
					identity: {
						requestId: 'run-1',
						idempotencyKey: 'run-1',
						attemptId: 'att-1',
						runId: 'run-1',
						rootRunId: 'run-1',
						parentRunId: null,
					},
					policyRevision: 3,
					workflow: {
						workflowId: 'cue:shell-test',
						version: 'v1',
						triggerEventId: 'time.heartbeat:evt-1',
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
					},
					traceId: 'cue:run-1:run-1:att-1',
					requestedCapabilities: ['runs.submit'],
				})
			);
			if (!verified.ok) throw new Error(verified.problems.join('; '));
			return {
				authority,
				context: verified.context,
				policy: { sources: [], policyRevision: 3 },
				account: null,
				...(onLease ? { onLease } : {}),
			};
		}

		/** DECLARED TEST DOUBLE: no real confinement producer qualifies a shell route. */
		const qualified = (route: CueShellRoute): CueShellRouteSupport => ({
			route,
			standalone: 'implemented',
			managed: 'implemented',
			note: 'declared test double: a confinement producer this build does not have',
		});

		it('refuses the local shell route before spawning or asking for a lease', async () => {
			const decide = vi.fn(() => ({ decision: 'allow', policyRevision: 3 }) as PolicyDecision);
			const onLog = vi.fn();
			const result = await executeCueShell(
				createConfig({ admission: managedAdmission(decide), onLog }) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(decide).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.exitCode).toBeNull();
			expect(result.managed).toEqual({ state: 'unavailable', code: 'capability-unsupported' });
			expect(result.stderr).toContain(
				'[managed-unavailable] A Cue shell action over the local-shell route is unavailable under management'
			);
			expect(result.stderr).toContain('Nothing was started.');
			expect(onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('was not admitted (unavailable, capability-unsupported)')
			);
		});

		it('judges an SSH action as the remote route, after the wrap, and refuses it without running anywhere', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host', 'bash -c "echo hello"'],
				cwd: '/Users/local',
				sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host' },
			});
			const decide = vi.fn(() => ({ decision: 'allow', policyRevision: 3 }) as PolicyDecision);
			const result = await executeCueShell(
				createConfig({
					admission: managedAdmission(decide),
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: { getSshRemotes: () => [] },
				}) as any
			);

			expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(decide).not.toHaveBeenCalled();
			expect(result.managed).toEqual({ state: 'unavailable', code: 'capability-unsupported' });
			expect(result.stderr).toContain('over the ssh-shell route is unavailable');
			expect(result.stderr).toContain('remote login shell over SSH');
		});

		it('on a qualified route (declared double) admits the final spawn, binds the pid and releases it with the exit', async () => {
			const requests: AdmissionRequest[] = [];
			const leases: DispatchLease[] = [];
			const admission = managedAdmission(
				(request) => {
					requests.push(request);
					return { decision: 'allow', policyRevision: 3 };
				},
				(lease) => leases.push(lease)
			);
			const onLog = vi.fn();
			const promise = executeCueShell(
				createConfig({ admission, routeSupport: qualified, onLog }) as any
			);
			await vi.advanceTimersByTimeAsync(0);

			expect(requests).toHaveLength(1);
			const snapshot = requests[0].snapshot;
			expect(snapshot).toMatchObject({
				executable: 'echo hello',
				args: [],
				cwd: '/projects/test',
				shell: true,
				provider: 'cue-shell',
				model: null,
				operation: 'start',
				target: { kind: 'local' },
				resourceIds: ['dir:/projects/test'],
				stdinDigest: null,
			});
			expect(snapshot.envKeys).toContain('PATH');
			expect(snapshot.envKeys).toContain('MAESTRO_QUERY_SOURCE');
			expect(requests[0].context.origin).toBe('cue');

			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(leases).toHaveLength(1);
			const lease = leases[0];
			expect(lease.state()).toBe('bound');
			expect(lease.pid()).toBe(54321);
			expect(onLog).toHaveBeenCalledWith(
				'cue',
				expect.stringContaining(`admitted under lease ${lease.leaseId}`)
			);

			mockChild.stdout.emit('data', 'hello\n');
			mockChild.emit('close', 0, null);
			const result = await promise;
			expect(result.status).toBe('completed');
			expect(result.managed).toBeUndefined();
			expect(lease.state()).toBe('released');
			expect(lease.ended().release).toEqual({ outcome: 'exited', exitCode: 0, signal: null });
		});

		it('a policy denial on a qualified route starts nothing and is the run result', async () => {
			const admission = managedAdmission(() => ({
				decision: 'deny',
				reason: 'shell actions are not allowed on this host',
				policyRevision: 3,
				code: 'policy-denied',
			}));
			const result = await executeCueShell(
				createConfig({ admission, routeSupport: qualified }) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.managed).toEqual({ state: 'denied', code: 'policy-denied' });
			expect(result.stderr).toContain('[managed-denied] shell actions are not allowed');
		});

		it('a revocation while the command runs stops it; the authority owns that stop', async () => {
			const leases: DispatchLease[] = [];
			const admission = managedAdmission(
				() => ({ decision: 'allow', policyRevision: 3 }),
				(lease) => leases.push(lease)
			);
			const promise = executeCueShell(createConfig({ admission, routeSupport: qualified }) as any);
			await vi.advanceTimersByTimeAsync(0);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			const lease = leases[0];

			expect(admission.authority.revoke(lease.leaseId, 'policy generation 4 forbids shells')).toBe(
				true
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(mockChild.killed).toBe(true);

			mockChild.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.status).toBe('stopped');
			expect(result.stderr).toContain('[managed-revoked] policy generation 4 forbids shells');
			expect(result.managed).toBeUndefined();
			expect(lease.state()).toBe('revoked');
		});

		/**
		 * Zero effect (MRC-07-07): a lease the owner withdrew before the spawn, a context this
		 * host's verifier never bound, an answer that was lost, and a policy that changed between
		 * two firings. Nothing spawns in any of them, and each is told apart by state and code.
		 */
		it('a lease withdrawn between the admission and the spawn (the owner revoked) is refused at the gate, and nothing spawns', async () => {
			const leases: DispatchLease[] = [];
			const admission: CueManagedAdmission = managedAdmission(
				() => ({ decision: 'allow', policyRevision: 3 }),
				(lease) => {
					leases.push(lease);
					// Withdrawn the instant it is issued: what the gate sees at `spawn()` is a dead lease.
					admission.authority.revoke(lease.leaseId, 'the owner withdrew the workflow');
				}
			);
			const result = await executeCueShell(
				createConfig({ admission, routeSupport: qualified }) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.exitCode).toBeNull();
			expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
			expect(result.stderr).toContain('[managed-denied] The lease for this launch is revoked.');
			expect(leases).toHaveLength(1);
			expect(leases[0].state()).toBe('revoked');
			expect(leases[0].pid()).toBeUndefined();
		});

		it('a context this host’s verifier did not bind (a fabricated one) is refused unauthenticated before any lease or spawn', async () => {
			const decide = vi.fn(() => ({ decision: 'allow', policyRevision: 3 }) as PolicyDecision);
			const bound = managedAdmission(decide);
			// The same fields, copied: the verifier's brand does not copy with them.
			const forged: CueManagedAdmission = { ...bound, context: { ...bound.context } };

			const result = await executeCueShell(
				createConfig({ admission: forged, routeSupport: qualified }) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(decide).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.managed).toEqual({ state: 'denied', code: 'unauthenticated' });
			expect(result.stderr).toContain(
				'[managed-denied] The context was not bound by a verifier on this host.'
			);
			expect(bound.authority.live()).toEqual([]);
		});

		it('an answer lost after asking is unknown: nothing spawns, and the run is not reported completed', async () => {
			const admission = managedAdmission(() => ({
				decision: 'unknown',
				reason: 'the endpoint answered with a receipt that does not match the request',
			}));

			const result = await executeCueShell(
				createConfig({ admission, routeSupport: qualified }) as any
			);

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(result.status).toBe('failed');
			expect(result.exitCode).toBeNull();
			expect(result.managed).toEqual({ state: 'unknown', code: 'outcome-unknown' });
			expect(result.stderr).toContain(
				'[managed-unknown] the endpoint answered with a receipt that does not match the request'
			);
			expect(admission.authority.live()).toEqual([]);
		});

		it('decides every firing afresh: a policy that flips to deny after one admitted run refuses the next run before it spawns', async () => {
			const answers: PolicyDecision[] = [
				{ decision: 'allow', policyRevision: 3 },
				{
					decision: 'deny',
					reason: 'policy revision 4 forbids shell actions on this host',
					policyRevision: 4,
					code: 'policy-denied',
				},
			];
			const admission = managedAdmission(() => {
				const answer = answers.shift();
				if (!answer) throw new Error('asked more than twice');
				return answer;
			});

			const first = executeCueShell(createConfig({ admission, routeSupport: qualified }) as any);
			await vi.advanceTimersByTimeAsync(0);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			mockChild.emit('close', 0, null);
			expect((await first).status).toBe('completed');

			const second = await executeCueShell(
				createConfig({ runId: 'run-2', admission, routeSupport: qualified }) as any
			);

			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(answers).toEqual([]);
			expect(second.status).toBe('failed');
			expect(second.managed).toEqual({ state: 'denied', code: 'policy-denied' });
			expect(second.stderr).toContain(
				'[managed-denied] policy revision 4 forbids shell actions on this host'
			);
			expect(admission.authority.live()).toEqual([]);
		});

		it('stopped while the authority decides releases the lease unused and spawns nothing', async () => {
			let answer!: (decision: PolicyDecision) => void;
			const leases: DispatchLease[] = [];
			const admission = managedAdmission(
				() =>
					new Promise<PolicyDecision>((resolve) => {
						answer = resolve;
					}),
				(lease) => leases.push(lease)
			);
			const controller = new AbortController();
			const promise = executeCueShell(
				createConfig({ admission, routeSupport: qualified, signal: controller.signal }) as any
			);
			await vi.advanceTimersByTimeAsync(0);
			controller.abort();
			answer({ decision: 'allow', policyRevision: 3 });
			const result = await promise;

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(result.status).toBe('stopped');
			expect(leases).toHaveLength(1);
			expect(leases[0].state()).toBe('released');
			expect(leases[0].ended().release).toEqual({ outcome: 'stopped', by: 'caller' });
		});
	});
});
