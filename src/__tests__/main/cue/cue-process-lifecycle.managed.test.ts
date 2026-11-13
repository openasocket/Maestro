/**
 * Managed admission at the Cue spawn sink (MRC-07-02): `runProcess` asks the
 * host authority with the snapshot of the FINAL spec the instant before the
 * spawn, spawns only on a lease, and reports a refusal as the run's result.
 *
 * The lease authority is the REAL `createLocalHostAuthority` over a policy
 * table and the context verifier the real `createContextVerifier`, so what
 * these prove is the sink's behavior against the real lease lifetime; only
 * the policy answer and the child process are doubles. Declared doubles,
 * labeled as such.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { SpawnSpec } from '../../../main/cue/cue-spawn-builder';
import {
	createContextVerifier,
	createLocalHostAuthority,
	unavailableAuthority,
	type AdmissionRequest,
	type DispatchLease,
	type HostAuthority,
	type PolicyDecision,
} from '../../../shared/maestro-lib/managed/authority';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedAuthenticatedContext,
} from '../../../shared/maestro-lib/managed/types';
import { installTurnSinkStanding } from '../../../shared/maestro-lib/run/start-turn';
import {
	TUI_HANDSHAKE_ENV_VAR,
	readTuiHandshakeKey,
	tuiHandshakeKeyPath,
	verifyTuiHandshake,
} from '../../../shared/maestro-lib/managed/tui-handshake';
import { STEERING_TOKEN_ENV_VAR } from '../../../shared/chatSteering';

vi.mock('../../../main/parsers', () => ({
	getOutputParser: () => null,
	createOutputParser: () => null,
}));
const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

class MockChildProcess extends EventEmitter {
	pid = 4242;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
	stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	killed = false;
	kill() {
		this.killed = true;
		return true;
	}
}
let mockChild: MockChildProcess;
const mockSpawn = vi.fn(() => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...(args as [])),
		default: { ...actual, spawn: (...args: unknown[]) => mockSpawn(...(args as [])) },
	};
});

import {
	getActiveProcessMap,
	runProcess,
	type CueManagedSpawn,
} from '../../../main/cue/cue-process-lifecycle';

// ─── Doubles ─────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function verifiedContext(
	identity: Partial<ManagedAuthenticatedContext['identity']> = {}
): ManagedAuthenticatedContext {
	const verified = createContextVerifier({
		verifierId: 'cue-test',
		peer: 'in-process',
		now: () => NOW,
		accept: () => [],
	}).verify({
		contractVersion: MANAGED_CONTRACT_VERSION,
		installation: { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' },
		origin: 'cue',
		actor: { kind: 'human', id: 'operator:inst-1' },
		delegation: {
			principals: [
				{ kind: 'service', id: 'cue-subscription:nightly' },
				{ kind: 'agent', id: 'agent-1' },
			],
			delegation: null,
			grants: [],
		},
		identity: {
			requestId: 'run-1',
			idempotencyKey: 'run-1',
			attemptId: 'attempt-1',
			runId: 'run-1',
			rootRunId: 'run-1',
			parentRunId: null,
			...identity,
		},
		policyRevision: 3,
		workflow: {
			workflowId: 'cue:nightly',
			workflowVersion: 'v1',
			triggerId: 'time.scheduled:evt-1',
			owner: { ownerId: 'owner-1', ownerEpoch: 'epoch-1', fencingToken: 'fence-1' },
		},
		traceId: 'cue:run-1:run-1:attempt-1',
		requestedCapabilities: ['runs.submit'],
	});
	if (!verified.ok) throw new Error(verified.problems.join('; '));
	return verified.context;
}

function tableAuthority(
	decide: (request: AdmissionRequest) => PolicyDecision | Promise<PolicyDecision>
): { authority: HostAuthority; asked: AdmissionRequest[] } {
	const asked: AdmissionRequest[] = [];
	let leases = 0;
	const authority = createLocalHostAuthority({
		authorityId: 'test-authority',
		decide: (request) => {
			asked.push(request);
			return decide(request);
		},
		now: () => NOW,
		newId: () => `lease-${++leases}`,
	});
	return { authority, asked };
}

function managedSpawn(authority: HostAuthority, extra: Partial<CueManagedSpawn> = {}) {
	return {
		authority,
		context: verifiedContext(),
		policy: { sources: [], policyRevision: 3 },
		attribution: {
			provider: 'claude-code',
			model: 'opus',
			operation: 'start' as const,
			account: null,
			target: { kind: 'local' as const },
		},
		...extra,
	} satisfies CueManagedSpawn;
}

function spec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
	return {
		command: '/bin/claude',
		args: ['--print', '--dangerously-skip-permissions', '--', 'do the thing'],
		cwd: '/projects/test',
		env: { PATH: '/usr/bin', MAESTRO_QUERY_SOURCE: 'cue' },
		...overrides,
	};
}

function options(overrides: Record<string, unknown> = {}) {
	return { toolType: 'claude-code', timeoutMs: 30_000, onLog: vi.fn(), ...overrides };
}

async function spawned(): Promise<MockChildProcess> {
	await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
	return mockChild;
}

beforeEach(() => {
	mockSpawn.mockClear();
	mockCaptureException.mockClear();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runProcess managed admission', () => {
	it('asks the authority with the final snapshot and spawns on the lease', async () => {
		const { authority, asked } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const leases: DispatchLease[] = [];
		const run = runProcess(
			'run-1',
			spec({ stdinPrompt: undefined }),
			options({
				stdinPrompt: 'the prompt on stdin',
				managed: managedSpawn(authority, { onLease: (lease) => leases.push(lease) }),
			})
		);
		const child = await spawned();

		// The snapshot is of exactly what spawn received: the provider's own
		// permission flag is part of what the policy decided on, not a grant.
		expect(asked).toHaveLength(1);
		const snapshot = asked[0].snapshot;
		expect(snapshot.executable).toBe('/bin/claude');
		expect(snapshot.args).toContain('--dangerously-skip-permissions');
		expect(snapshot.cwd).toBe('/projects/test');
		expect(snapshot.envKeys).toEqual(['MAESTRO_QUERY_SOURCE', 'PATH']);
		expect(snapshot.stdinDigest).not.toBeNull();
		expect(snapshot.operation).toBe('start');
		expect(snapshot.provider).toBe('claude-code');
		expect(snapshot.model).toBe('opus');
		expect(asked[0].context.origin).toBe('cue');
		expect(asked[0].context.workflow?.owner.fencingToken).toBe('fence-1');
		expect(asked[0].policy.policyRevision).toBe(3);

		// The lease was handed out, bound to the child, and is released on exit.
		expect(leases).toHaveLength(1);
		expect(leases[0].state()).toBe('bound');
		expect(leases[0].pid()).toBe(4242);
		expect(authority.live().map((lease) => lease.leaseId)).toEqual(['lease-1']);

		child.stdout.emit('data', 'hello');
		child.emit('close', 0);
		const result = await run;
		expect(result.status).toBe('completed');
		expect(result.managed).toBeUndefined();
		expect(leases[0].state()).toBe('released');
		expect(leases[0].ended().release).toEqual({ outcome: 'exited', exitCode: 0, signal: null });
		expect(authority.live()).toEqual([]);
	});

	it('a denied policy starts nothing and is the run result', async () => {
		const { authority } = tableAuthority(() => ({
			decision: 'deny',
			reason: 'Cue prompts are not allowed for this agent.',
			policyRevision: 3,
		}));
		const onLog = vi.fn();
		const result = await runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(authority), onLog })
		);

		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.exitCode).toBeNull();
		expect(result.managed).toEqual({ state: 'denied', code: 'policy-denied' });
		// A refusal is a host-proven nonstart: the run manager may retry it.
		expect(result.executionStarted).toBe(false);
		expect(result.stderr).toBe('[managed-denied] Cue prompts are not allowed for this agent.');
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('(denied, policy-denied)'));
		// A decision, not a crash: nothing for Sentry.
		expect(mockCaptureException).not.toHaveBeenCalled();
	});

	it('an authority that cannot decide is unavailable, never a local fallback', async () => {
		const result = await runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(unavailableAuthority('The endpoint is away.')) })
		);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.managed).toEqual({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(result.executionStarted).toBe(false);
		expect(result.stderr).toContain('The endpoint is away.');
	});

	it('a lease the gate cannot verify at the spawn is refused there', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		// The sink-facing authority says the lease is revoked by the time spawn runs.
		const revokedAtTheGate: HostAuthority = {
			...authority,
			admit: (request) => authority.admit(request),
			check: () => ({ ok: false, reason: 'revoked' }),
			live: () => authority.live(),
		};
		const result = await runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(revokedAtTheGate) })
		);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
		expect(result.stderr).toContain('revoked');
		expect(authority.live()).toEqual([]);
	});

	it.each(['deny', 'unavailable', 'unknown'] as const)(
		'a stop during a pending %s answer preserves the decision without starting work',
		async (decision) => {
			const controller = new AbortController();
			let answer!: (decision: PolicyDecision) => void;
			const { authority, asked } = tableAuthority(
				() => new Promise((resolve) => (answer = resolve))
			);
			const onLease = vi.fn();
			const run = runProcess(
				'run-1',
				spec(),
				options({ signal: controller.signal, managed: managedSpawn(authority, { onLease }) })
			);
			expect(asked).toHaveLength(1);
			controller.abort();
			answer({ decision, reason: 'late producer answer', policyRevision: 3 });
			const result = await run;
			expect(result).toMatchObject({
				status: 'stopped',
				executionStarted: false,
				exitCode: null,
				managed: {
					state: decision === 'deny' ? 'denied' : decision,
					code:
						decision === 'deny'
							? 'policy-denied'
							: decision === 'unknown'
								? 'outcome-unknown'
								: 'runtime-unavailable',
				},
			});
			expect(result.stderr).toContain('late producer answer');
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(onLease).not.toHaveBeenCalled();
			expect(getActiveProcessMap().has('run-1')).toBe(false);
			expect(authority.live()).toEqual([]);
		}
	);

	it('keeps a pending admission until a late lease can be released, then admits a fresh retry', async () => {
		const controller = new AbortController();
		let answer!: (decision: PolicyDecision) => void;
		const { authority, asked } = tableAuthority(() => new Promise((resolve) => (answer = resolve)));
		const leases: DispatchLease[] = [];
		const observed: DispatchLease[] = [];
		const delayed: HostAuthority = {
			...authority,
			async admit(request) {
				const outcome = await authority.admit(request);
				if (outcome.state === 'admitted') leases.push(outcome.lease);
				return outcome;
			},
		};
		const run = runProcess(
			'run-1',
			spec(),
			options({
				signal: controller.signal,
				managed: managedSpawn(delayed, { onLease: (lease) => observed.push(lease) }),
			})
		);
		const settled = vi.fn();
		void run.then(settled);
		controller.abort();
		await Promise.resolve();
		expect(settled).not.toHaveBeenCalled();
		answer({ decision: 'allow', policyRevision: 3 });
		expect(await run).toMatchObject({ status: 'stopped', executionStarted: false });
		expect(leases[0].pid()).toBeUndefined();
		expect(leases[0].ended().release).toEqual({ outcome: 'stopped', by: 'caller' });
		expect(observed).toEqual([]);
		expect(authority.live()).toEqual([]);
		expect(mockSpawn).not.toHaveBeenCalled();
		const retry = runProcess(
			'run-2',
			spec(),
			options({
				managed: managedSpawn(delayed, {
					context: verifiedContext({
						requestId: 'run-2',
						idempotencyKey: 'run-2',
						runId: 'run-2',
						attemptId: 'attempt-2',
					}),
				}),
			})
		);
		answer({ decision: 'allow', policyRevision: 3 });
		const child = await spawned();
		expect(asked.map(({ context }) => context.identity.attemptId)).toEqual([
			'attempt-1',
			'attempt-2',
		]);
		expect(leases[1].state()).toBe('bound');
		child.emit('close', 0);
		expect(await retry).toMatchObject({ status: 'completed', executionStarted: true });
		expect(authority.live()).toEqual([]);
	});

	it.each(['stop', 'throw', 'stop-and-throw'] as const)(
		'an admission observer that requests %s leaves no process or live lease',
		async (action) => {
			const controller = new AbortController();
			const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
			const leases: DispatchLease[] = [];
			const result = await runProcess(
				'run-1',
				spec(),
				options({
					signal: controller.signal,
					managed: managedSpawn(authority, {
						onLease: (lease) => {
							leases.push(lease);
							if (action !== 'throw') controller.abort();
							if (action !== 'stop') throw new Error('admission observer failed');
						},
					}),
				})
			);
			expect(result).toMatchObject({
				status: action === 'throw' ? 'failed' : 'stopped',
				executionStarted: false,
			});
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(leases).toHaveLength(1);
			expect(leases[0].pid()).toBeUndefined();
			expect(leases[0].ended().release).toEqual(
				action === 'throw'
					? { outcome: 'spawn-failed', message: 'admission observer failed' }
					: { outcome: 'stopped', by: 'caller' }
			);
			expect(authority.live()).toEqual([]);
			expect(getActiveProcessMap().has('run-1')).toBe(false);
			if (action !== 'stop') {
				expect(mockCaptureException).toHaveBeenCalledWith(
					expect.objectContaining({ message: 'admission observer failed' }),
					expect.objectContaining({ operation: 'cue:spawn', runId: 'run-1' })
				);
			}
		}
	);

	it.each(['standing', 'snapshot', 'revocation'] as const)(
		'releases an unused lease when %s changes inside the observer before the final gate',
		async (change) => {
			const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
			const spawnSpec = spec();
			const leases: DispatchLease[] = [];
			let releaseStanding: (() => void) | undefined;
			try {
				const result = await runProcess(
					'run-1',
					spawnSpec,
					options({
						managed: managedSpawn(authority, {
							onLease: (lease) => {
								leases.push(lease);
								if (change === 'standing') {
									releaseStanding = installTurnSinkStanding({
										standing: () => 'managed',
										authorityId: () => null,
									});
								} else if (change === 'snapshot') spawnSpec.args.push('changed');
								else authority.revoke(lease.leaseId, 'owner fenced');
							},
						}),
					})
				);
				expect(result).toMatchObject({ status: 'failed', executionStarted: false });
				expect(result.managed?.code).toBe(
					change === 'standing' ? 'runtime-unavailable' : 'lease-invalid'
				);
				expect(mockSpawn).not.toHaveBeenCalled();
				expect(authority.live()).toEqual([]);
				expect(leases[0].pid()).toBeUndefined();
				expect(getActiveProcessMap().has('run-1')).toBe(false);
			} finally {
				releaseStanding?.();
			}
		}
	);

	it('a stop while the authority is deciding releases the lease unused', async () => {
		const controller = new AbortController();
		const { authority } = tableAuthority(() => {
			controller.abort();
			return { decision: 'allow', policyRevision: 3 };
		});
		const leases: DispatchLease[] = [];
		const result = await runProcess(
			'run-1',
			spec(),
			options({
				signal: controller.signal,
				managed: managedSpawn(authority, { onLease: (lease) => leases.push(lease) }),
			})
		);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('stopped');
		expect(result.executionStarted).toBe(false);
		expect(leases).toEqual([]);
		expect(authority.live()).toEqual([]);
	});

	it('a spawn that throws after the admission releases the lease as spawn-failed', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const leases: DispatchLease[] = [];
		mockSpawn.mockImplementationOnce(() => {
			throw new Error('spawn EINVAL');
		});
		const result = await runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(authority, { onLease: (lease) => leases.push(lease) }) })
		);

		// The native spawn threw, so nothing ran: a host-proven nonstart.
		expect(result.status).toBe('failed');
		expect(result.executionStarted).toBe(false);
		expect(result.stderr).toBe('Spawn error: spawn EINVAL');
		expect(result.managed).toBeUndefined();
		// The lease ends here instead of staying live until it expires.
		expect(leases).toHaveLength(1);
		expect(leases[0].state()).toBe('released');
		expect(leases[0].ended().release).toEqual({
			outcome: 'spawn-failed',
			message: 'spawn EINVAL',
		});
		expect(authority.live()).toEqual([]);
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'TurnNotStartedError', message: 'spawn EINVAL' }),
			expect.objectContaining({ operation: 'cue:spawn', runId: 'run-1' })
		);
	});

	it('without an admission the spawn is unchanged', async () => {
		const run = runProcess('run-1', spec(), options());
		const child = await spawned();
		child.emit('close', 0);
		const result = await run;
		expect(result.status).toBe('completed');
		expect(result.managed).toBeUndefined();
	});

	it('retains a bound lease when setup throws after spawn instead of claiming a nonstart', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const leases: DispatchLease[] = [];
		mockSpawn.mockImplementationOnce(() => {
			mockChild = new MockChildProcess();
			mockChild.stdin.end.mockImplementationOnce(() => {
				throw new Error('post-spawn setup failed');
			});
			return mockChild as unknown as ChildProcess;
		});
		const result = await runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(authority, { onLease: (lease) => leases.push(lease) }) })
		);
		expect(result).toMatchObject({ status: 'failed', executionStarted: true });
		expect(leases[0].state()).toBe('bound');
		expect(authority.live()).toEqual(leases);
		mockChild.emit('close', 1);
		expect(leases[0].ended().release).toEqual({ outcome: 'exited', exitCode: 1, signal: null });
		expect(authority.live()).toEqual([]);
	});

	it('still stops a running child when the producer revokes its lease', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const leases: DispatchLease[] = [];
		const run = runProcess(
			'run-1',
			spec(),
			options({ managed: managedSpawn(authority, { onLease: (lease) => leases.push(lease) }) })
		);
		const child = await spawned();
		expect(authority.revoke(leases[0].leaseId, 'owner fenced')).toBe(true);
		expect(child.killed).toBe(true);
		child.emit('close', null, 'SIGTERM');
		expect(await run).toMatchObject({ status: 'failed', executionStarted: true });
		expect(leases[0].ended().reason).toBe('owner fenced');
		expect(authority.live()).toEqual([]);
		expect(getActiveProcessMap().has('run-1')).toBe(false);
	});
});

// ─── maestro-p admission stamp at the Cue sink (MCOMP-21-14A) ───────────────

describe('runProcess maestro-p admission stamp (MCOMP-21-14A)', () => {
	const MAESTRO_P_SCRIPT = '/opt/maestro/resources/maestro-p.js';
	let dataDir: string;
	let claudeBin: string;
	let savedUserData: string | undefined;

	beforeEach(() => {
		savedUserData = process.env.MAESTRO_USER_DATA;
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-tui-stamp-'));
		claudeBin = path.join(dataDir, 'claude-bin');
		fs.writeFileSync(claudeBin, '#!/bin/sh\necho claude\n');
		process.env.MAESTRO_USER_DATA = dataDir;
	});
	afterEach(() => {
		if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedUserData;
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	/** A local maestro-p spec carrying a handshake and a steering token the engine inherited. */
	function tuiSpec(env: Record<string, string> = {}, overrides: Partial<SpawnSpec> = {}) {
		return spec({
			command: process.execPath,
			args: [MAESTRO_P_SCRIPT, '--dangerously-skip-permissions', '--', 'do the thing'],
			env: {
				PATH: '/usr/bin',
				MAESTRO_CLAUDE_BIN: claudeBin,
				[TUI_HANDSHAKE_ENV_VAR]: 'inherited-handshake',
				[STEERING_TOKEN_ENV_VAR]: 'inherited-token',
				...env,
			},
			...overrides,
		});
	}

	function spawnedEnv(): Record<string, string | undefined> {
		const call = mockSpawn.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		];
		return call[2].env;
	}

	it('strips the inherited admission, stamps after the gate and the stamp verifies', async () => {
		const { authority, asked } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const leases: DispatchLease[] = [];
		const run = runProcess(
			'run-1',
			// A standard ceiling: the bypass flag would not be signable under it.
			tuiSpec(
				{},
				{
					args: [MAESTRO_P_SCRIPT, '--model', 'opus', '--', 'do the thing'],
					permissionCeiling: 'standard',
				}
			),
			options({
				managed: managedSpawn(authority, {
					context: verifiedContext({ requestId: 'req-cue-7' }),
					onLease: (lease) => leases.push(lease),
				}),
			})
		);
		const child = await spawned();

		// The authority saw the spec without the inherited names and without the
		// stamp: the stamp names the lease, so it is never part of what it digests.
		expect(asked).toHaveLength(1);
		expect(asked[0].snapshot.envKeys).toEqual(['MAESTRO_CLAUDE_BIN', 'PATH']);

		const env = spawnedEnv();
		expect(env.MAESTRO_USER_DATA).toBe(path.resolve(dataDir));
		expect(env[STEERING_TOKEN_ENV_VAR]).toMatch(/^[0-9a-f]{32,}$/);
		expect(env[STEERING_TOKEN_ENV_VAR]).not.toBe('inherited-token');
		const encoded = env[TUI_HANDSHAKE_ENV_VAR];
		expect(encoded).toBeTruthy();
		expect(encoded).not.toBe('inherited-handshake');
		expect(env.MAESTRO_CLAUDE_BIN).toBe(claudeBin);

		const key = readTuiHandshakeKey(dataDir);
		expect(key).not.toBeNull();
		const verified = verifyTuiHandshake(encoded!, key!);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(leases).toHaveLength(1);
		expect(verified.payload.run).toMatchObject({
			leaseId: leases[0].leaseId,
			authorityId: 'test-authority',
			requestId: 'req-cue-7',
		});
		expect(verified.payload.owner).toEqual({
			surface: 'cue',
			actor: { kind: leases[0].actor.kind, id: leases[0].actor.id },
		});
		expect(verified.payload.permissionMode).toBe('standard');
		expect(verified.payload.binary).toEqual({
			path: claudeBin,
			digest: createHash('sha256').update(fs.readFileSync(claudeBin)).digest('hex'),
		});
		// Another data directory's key does not verify it.
		const otherKey = 'a'.repeat(64);
		expect(verifyTuiHandshake(encoded!, otherKey).ok).toBe(false);

		child.emit('close', 0);
		expect((await run).status).toBe('completed');
		expect(authority.live()).toEqual([]);
	});

	it('every admitted run mints its own steering token', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const tokens: (string | undefined)[] = [];
		for (const runId of ['run-a', 'run-b']) {
			mockSpawn.mockClear();
			const run = runProcess(runId, tuiSpec(), options({ managed: managedSpawn(authority) }));
			const child = await spawned();
			tokens.push(spawnedEnv()[STEERING_TOKEN_ENV_VAR]);
			child.emit('close', 0);
			await run;
		}
		expect(tokens[0]).toBeTruthy();
		expect(tokens[1]).toBeTruthy();
		expect(tokens[0]).not.toBe(tokens[1]);
	});

	it('a launch that names no MAESTRO_CLAUDE_BIN is denied, spawns nothing and releases the lease', async () => {
		const { authority, asked } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const onLease = vi.fn();
		const { MAESTRO_CLAUDE_BIN: _bin, ...noBin } = tuiSpec().env;
		const result = await runProcess(
			'run-1',
			tuiSpec({}, { env: noBin }),
			options({ managed: managedSpawn(authority, { onLease }) })
		);

		expect(asked).toHaveLength(1);
		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: 'failed',
			executionStarted: false,
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(result.stderr).toContain('MAESTRO_CLAUDE_BIN');
		expect(result.stderr).toContain('Nothing was started');
		// Released, never handed out, and no key minted for a launch it refused.
		expect(onLease).not.toHaveBeenCalled();
		expect(authority.live()).toEqual([]);
		expect(fs.existsSync(tuiHandshakeKeyPath(dataDir))).toBe(false);
		expect(mockCaptureException).not.toHaveBeenCalled();
	});

	it('an unreadable key is denied, spawns nothing, releases the lease and leaves the file alone', async () => {
		fs.writeFileSync(tuiHandshakeKeyPath(dataDir), 'not a key\n');
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const result = await runProcess(
			'run-1',
			tuiSpec(),
			options({ managed: managedSpawn(authority) })
		);

		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.managed).toEqual({ state: 'denied', code: 'policy-denied' });
		expect(result.stderr).toContain('the handshake key could not be loaded');
		expect(authority.live()).toEqual([]);
		expect(fs.readFileSync(tuiHandshakeKeyPath(dataDir), 'utf8')).toBe('not a key\n');
	});

	it('without an admission only the inherited admission is stripped', async () => {
		const run = runProcess('run-1', tuiSpec(), options());
		const child = await spawned();
		const env = spawnedEnv();
		expect(env[TUI_HANDSHAKE_ENV_VAR]).toBeUndefined();
		expect(env[STEERING_TOKEN_ENV_VAR]).toBeUndefined();
		expect(env.MAESTRO_USER_DATA).toBeUndefined();
		expect(env).toMatchObject({ PATH: '/usr/bin', MAESTRO_CLAUDE_BIN: claudeBin });
		expect(fs.existsSync(tuiHandshakeKeyPath(dataDir))).toBe(false);
		child.emit('close', 0);
		expect((await run).status).toBe('completed');
	});

	it('a launch that is not maestro-p is neither stripped nor stamped', async () => {
		const { authority } = tableAuthority(() => ({ decision: 'allow', policyRevision: 3 }));
		const run = runProcess(
			'run-1',
			tuiSpec({}, { command: '/bin/claude', args: ['--print', '--', 'do the thing'] }),
			options({ managed: managedSpawn(authority) })
		);
		const child = await spawned();
		const env = spawnedEnv();
		expect(env[TUI_HANDSHAKE_ENV_VAR]).toBe('inherited-handshake');
		expect(env[STEERING_TOKEN_ENV_VAR]).toBe('inherited-token');
		expect(env.MAESTRO_USER_DATA).toBeUndefined();
		expect(fs.existsSync(tuiHandshakeKeyPath(dataDir))).toBe(false);
		child.emit('close', 0);
		await run;
	});
});
