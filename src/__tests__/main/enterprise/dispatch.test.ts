/**
 * The broker dispatch bridge: the ledger that joins a broker decision to the
 * local lease and the effect it covered. The endpoint is the fake daemon
 * (a declared double) plus an explicit test-only prepared producer; the authority
 * is the real host adapter over the real socket client; the lease lifetime
 * is driven the way a sink drives it (`bind`, `release`, a revocation).
 * What is defended: every admitted dispatch is recorded with the broker's
 * decision and the registration it ran under, refusals leave no record,
 * the effect states are written as they happen, a decision id joins back to
 * its lease, and a restart turns a still-bound receipt into `unknown`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createBrokerDispatch,
	DISPATCH_RECEIPTS_FILE_NAME,
	managedRunViewOf,
	managedRunViewOfReceipt,
	admitCueShell,
	cueShellAttribution,
	cueShellRouteProblems,
	cueShellRouteSupport,
	type CueShellRouteQualification,
	type CueShellSpawnPlan,
} from '../../../main/enterprise/dispatch';
import {
	PROVIDER_ROUTE_ALLOW_CASES,
	PROVIDER_ROUTE_DENY_CASES,
	type ProviderRouteCandidate,
	type SignedProviderRouteQualification,
} from '../../../shared/maestro-lib/managed/provider-route';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	buildDispatchSnapshot,
	createLocalHostAuthority,
	createContextVerifier,
	type AdmissionRequest,
} from '../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createManagedHostAdapter,
	managedAuthorityId,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';
import { fakeAdmission } from '../../helpers/managedSpawnPort';
import { createManagedOperations } from '../../../main/enterprise/service';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};

function record(socketPath: string): ManagedIdentityRecord {
	return {
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
		management: 'enrolled',
		registration: {
			challengeId: 'challenge-7',
			actorId: 'ada',
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: null,
			challengeDigest: 'c'.repeat(64),
			expiresAt: new Date(T0 + 3_600_000).toISOString(),
			registeredAt: new Date(T0 - 60_000).toISOString(),
		},
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: new Date(T0).toISOString() },
		enrolledAt: new Date(T0).toISOString(),
		updatedAt: new Date(T0).toISOString(),
	};
}

function standing(port: EndpointPort, identity: ManagedIdentityView): ManagedEnrollmentStatus {
	const connection = port.state();
	const registered =
		connection.registration === 'registered' &&
		connection.attached &&
		connection.status?.management === 'managed';
	return {
		identity,
		connection,
		endpoint: connection.status,
		authority: registered ? 'registered' : 'none',
		reason: registered ? null : 'not registered-attached-managed in this process',
		pendingApproval: null,
		lastDenial: null,
	};
}

function admission(requestId = 'req-1', attemptId = 'att-1'): AdmissionRequest {
	const verifier = createContextVerifier({
		verifierId: 'test',
		peer: 'in-process',
		now: () => T0,
		accept: () => [],
	});
	const verified = verifier.verify(
		inProcessContext({
			installation: INSTALLATION,
			actor: { kind: 'human', id: 'ada' },
			delegation: { principals: [], delegation: null, grants: [] },
			identity: {
				requestId,
				idempotencyKey: `key-${requestId}`,
				attemptId,
				runId: 'run-1',
				rootRunId: 'run-1',
				parentRunId: null,
			},
			policyRevision: 3,
			workflow: null,
			traceId: 'trace-1',
			requestedCapabilities: ['runs.submit'],
		})
	);
	if (!verified.ok) throw new Error(verified.problems.join('; '));
	return {
		context: verified.context,
		snapshot: buildDispatchSnapshot(
			{ command: '/bin/claude', args: ['--print'], cwd: '/work', env: {} },
			{ provider: 'claude-code', model: 'sonnet', resourceIds: ['doc-1'] }
		),
		policy: { sources: [], policyRevision: 3 },
	};
}

describe('broker dispatch bridge', () => {
	let dir: string;
	let fake: FakeEndpoint;
	let port: EndpointPort;
	let decisions = 0;
	let deny = false;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-dispatch-'));
		decisions = 0;
		deny = false;
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution'],
			now: () => T0,
			operations: {
				execution: (payload) => {
					const p = payload as Record<string, unknown>;
					decisions += 1;
					return {
						outcome: 'broker_dispatched',
						requestId: p.requestId,
						attemptId: p.attemptId,
						runId: p.runId,
						decisionId: `decision-${decisions}`,
						requestDigest: 'd'.repeat(64),
						brokerId: 'broker-1',
						policyRevision: p.policyRevision,
					};
				},
			},
		});
		port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
		await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
		await port.registration.redeem();
		const attached = await port.attach({
			...INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			supportedProtocols: [1],
			supportedCapabilities: ['attachment', 'compatibility', 'execution'],
			requiredCapabilities: ['execution'],
		});
		expect(attached.status).toBe('ok');
	});
	afterEach(async () => {
		await port.close();
		await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function bridge(file = path.join(dir, DISPATCH_RECEIPTS_FILE_NAME)) {
		const view: ManagedIdentityView = {
			status: 'ok',
			reason: null,
			message: null,
			record: record(fake.socketPath),
		};
		let clock = T0;
		let leases = 0;
		const prepared = createLocalHostAuthority({
			authorityId: managedAuthorityId(view.record!),
			now: () => clock,
			newId: () => `lease-${++leases}`,
			decide: () =>
				deny
					? { decision: 'deny', reason: 'fixture policy', policyRevision: 3 }
					: {
							decision: 'allow',
							policyRevision: 3,
							receipt: {
								decisionId: `decision-${++decisions}`,
								requestDigest: 'd'.repeat(64),
								brokerId: 'broker-1',
								policyRevision: 3,
							},
						},
		});
		// Test-only prepared producer. The real v1 client has no such port.
		Object.defineProperty(port, 'preparedExecution', {
			configurable: true,
			value: { ...prepared, version: 1 },
		});
		const host = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => clock,
			newId: () => `lease-${++leases}`,
		});
		const dispatch = createBrokerDispatch({ host, file, now: () => clock });
		return { dispatch, host, file, tick: (ms: number) => (clock += ms) };
	}

	it('projects the run a composer send started from the admission and its own ledger receipt, the effect as it stands (MCOMP-25-01)', async () => {
		const { dispatch } = bridge();
		await dispatch.load();
		const outcome = await dispatch.authority.admit(admission('req-9', 'att-9'));
		expect(outcome.state).toBe('admitted');
		if (outcome.state !== 'admitted') return;
		const lease = outcome.lease;
		const spawnAdmission = fakeAdmission({
			leaseId: lease.leaseId,
			authorityId: lease.authorityId,
			requestId: 'req-9',
			attemptId: 'att-9',
			policyRevision: 3,
			provider: 'claude-code',
		});
		lease.bind(4242);
		const bound = managedRunViewOf(spawnAdmission, dispatch.receipt(lease.leaseId));
		expect(bound).toMatchObject({
			leaseId: lease.leaseId,
			requestId: 'req-9',
			attemptId: 'att-9',
			runId: 'run-1',
			policyRevision: 3,
			decision: { decisionId: expect.stringMatching(/^decision-/), brokerId: 'broker-1' },
			effect: { state: 'bound', release: null },
		});
		// Identifiers only: the projection carries no snapshot, env or prompt.
		expect(Object.keys(bound).sort()).toEqual(
			[
				'actor',
				'attemptId',
				'authorityId',
				'decision',
				'effect',
				'leaseId',
				'operation',
				'policyRevision',
				'provider',
				'requestDigest',
				'requestId',
				'runId',
			].sort()
		);

		// A stop releases the lease as stopped by the caller; the view reads it back.
		lease.release({ outcome: 'stopped', by: 'caller' });
		expect(managedRunViewOf(spawnAdmission, dispatch.receipt(lease.leaseId)).effect).toEqual({
			state: 'released',
			release: { outcome: 'stopped', by: 'caller' },
			reason: null,
		});
	});

	it('reads a managed run back from the ledger by lease id: released after a stop, unknown after a restart, null for a lease never admitted (MCOMP-25-01B)', async () => {
		const first = bridge();
		await first.dispatch.load();
		const facade = (dispatch: typeof first.dispatch) =>
			createManagedOperations({
				lifecycle: {} as never,
				policy: {} as never,
				identity: {} as never,
				inventory: {} as never,
				dispatch,
			});
		const stopped = await first.dispatch.authority.admit(admission('req-s', 'att-s'));
		const running = await first.dispatch.authority.admit(admission('req-r', 'att-r'));
		expect(stopped.state).toBe('admitted');
		expect(running.state).toBe('admitted');
		if (stopped.state !== 'admitted' || running.state !== 'admitted') return;
		stopped.lease.bind(101);
		stopped.lease.release({ outcome: 'stopped', by: 'caller' });
		running.lease.bind(202);

		const live = facade(first.dispatch);
		const read = live.run(stopped.lease.leaseId);
		expect(read).toMatchObject({
			leaseId: stopped.lease.leaseId,
			authorityId: stopped.lease.authorityId,
			requestId: 'req-s',
			attemptId: 'att-s',
			runId: 'run-1',
			// The ledger's snapshot digest is the digest of the request the lease covers.
			requestDigest: stopped.lease.snapshotDigest,
			decision: { decisionId: expect.stringMatching(/^decision-/), brokerId: 'broker-1' },
			effect: { state: 'released', release: { outcome: 'stopped', by: 'caller' } },
		});
		// The same shape the live view has: identifiers only.
		expect(Object.keys(read!).sort()).toEqual(
			Object.keys(managedRunViewOfReceipt(first.dispatch.receipt(stopped.lease.leaseId)!)).sort()
		);
		expect(live.run(running.lease.leaseId)?.effect.state).toBe('bound');
		expect(live.run('lease-never-admitted')).toBeNull();
		// No ledger composed: nothing to read, never a fabricated run.
		expect(facade(undefined as never).run(stopped.lease.leaseId)).toBeNull();

		// A restart: the run still bound at exit reads back unknown, never resent or shown live.
		await first.dispatch.flush();
		const second = bridge();
		const loaded = await second.dispatch.load();
		expect(loaded).toMatchObject({ ok: true, recoveredUnknown: 1 });
		const after = facade(second.dispatch);
		expect(after.run(running.lease.leaseId)?.effect.state).toBe('unknown');
		expect(after.run(stopped.lease.leaseId)?.effect).toMatchObject({
			state: 'released',
			release: { outcome: 'stopped', by: 'caller' },
		});
	});

	it('never joins a receipt for another lease into the run view, and says only what the admission says without one', async () => {
		const { dispatch } = bridge();
		await dispatch.load();
		const first = await dispatch.authority.admit(admission('req-a', 'att-a'));
		expect(first.state).toBe('admitted');
		if (first.state !== 'admitted') return;
		const other = fakeAdmission({ leaseId: 'lease-other', authorityId: first.lease.authorityId });
		const mismatched = managedRunViewOf(other, dispatch.receipt(first.lease.leaseId));
		expect(mismatched.decision).toBeNull();
		expect(mismatched.runId).toBeNull();
		expect(mismatched.effect).toEqual({ state: 'bound', release: null, reason: null });
		expect(mismatched.leaseId).toBe('lease-other');

		const foreignAuthority = fakeAdmission({
			leaseId: first.lease.leaseId,
			authorityId: 'another-authority',
		});
		expect(
			managedRunViewOf(foreignAuthority, dispatch.receipt(first.lease.leaseId)).decision
		).toBeNull();
		expect(managedRunViewOf(other).decision).toBeNull();
	});

	it('records an admitted dispatch with the broker decision, the registration and the effect as it unfolds', async () => {
		const { dispatch, file, tick } = bridge();
		await dispatch.load();
		const outcome = await dispatch.authority.admit(admission());
		expect(outcome.state).toBe('admitted');
		if (outcome.state !== 'admitted') return;

		const receipt = dispatch.receipt(outcome.lease.leaseId);
		expect(receipt).toMatchObject({
			leaseId: 'lease-1',
			decision: {
				decisionId: 'decision-1',
				requestDigest: 'd'.repeat(64),
				brokerId: 'broker-1',
				policyRevision: 3,
			},
			requestId: 'req-1',
			attemptId: 'att-1',
			runId: 'run-1',
			actor: { kind: 'human', id: 'ada' },
			provider: 'claude-code',
			operation: 'start',
			registration: { challengeId: 'challenge-7', runtimeId: 'desktop-100' },
			effect: { state: 'admitted', pid: null },
		});
		expect(dispatch.byDecision('decision-1')).toBe(receipt);
		expect(dispatch.byDecision('decision-9')).toBeNull();

		// The sink binds and releases the lease; the ledger follows without being told.
		tick(10);
		outcome.lease.bind(4242);
		expect(receipt?.effect).toMatchObject({ state: 'bound', pid: 4242 });
		expect(outcome.lease.state()).toBe('bound');
		tick(10);
		outcome.lease.release({ outcome: 'exited', exitCode: 0, signal: null });
		expect(receipt?.effect).toMatchObject({
			state: 'released',
			release: { outcome: 'exited', exitCode: 0 },
		});
		expect(receipt?.effect.endedAt).not.toBeNull();
		// Written through the store writer: the file carries the same record.
		await dispatch.flush();
		expect(dispatch.persistFailures()).toBe(0);
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { receipts: unknown[] };
		expect(written.receipts).toHaveLength(1);
		expect(written.receipts[0]).toMatchObject({
			leaseId: 'lease-1',
			effect: { state: 'released' },
		});
	});

	it('holds admission until recovery and never reloads a live lease as an unknown restart', async () => {
		const { dispatch, host, file } = bridge();
		const admit = vi.spyOn(host.authority, 'admit');
		expect(await dispatch.authority.admit(admission())).toMatchObject({ state: 'unavailable' });
		expect(admit).not.toHaveBeenCalled();
		expect(fs.existsSync(file)).toBe(false);
		const loading = dispatch.load();
		expect(dispatch.load()).toBe(loading);
		await loading;
		const admitted = await dispatch.authority.admit(admission());
		if (admitted.state !== 'admitted') throw new Error(admitted.message);
		admitted.lease.bind(42);
		await dispatch.flush();
		await dispatch.load();
		expect(dispatch.receipt(admitted.lease.leaseId)?.effect.state).toBe('bound');
		expect(admit).toHaveBeenCalledTimes(1);
	});

	it('does not call authority or overwrite a ledger that recovery cannot read', async () => {
		const { dispatch, host, file } = bridge();
		fs.writeFileSync(file, '{broken');
		const admit = vi.spyOn(host.authority, 'admit');
		expect(await dispatch.load()).toMatchObject({ ok: false, reason: 'corrupt' });
		expect(await dispatch.authority.admit(admission())).toMatchObject({ state: 'unavailable' });
		expect(admit).not.toHaveBeenCalled();
		expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
	});

	it('leaves no record for a refusal and writes a revocation as the authority’s stop', async () => {
		const { dispatch } = bridge();
		await dispatch.load();
		deny = true;
		expect(await dispatch.authority.admit(admission('req-d'))).toMatchObject({ state: 'denied' });
		expect(dispatch.receipts()).toHaveLength(0);

		deny = false;
		const admitted = await dispatch.authority.admit(admission('req-r', 'att-r'));
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		admitted.lease.bind(77);
		const heard: string[] = [];
		admitted.lease.onRevoked((reason) => heard.push(reason));
		expect(dispatch.authority.revoke(admitted.lease.leaseId, 'policy changed')).toBe(true);
		expect(heard).toEqual(['policy changed']);
		expect(dispatch.receipt(admitted.lease.leaseId)?.effect).toMatchObject({
			state: 'revoked',
			reason: 'policy changed',
			pid: 77,
		});
		// A release after the revocation does not rewrite the ending.
		admitted.lease.release({ outcome: 'stopped', by: 'authority' });
		expect(dispatch.receipt(admitted.lease.leaseId)?.effect.state).toBe('revoked');
		expect(dispatch.authority.check(admitted.lease, admitted.lease.snapshotDigest)).toEqual({
			ok: false,
			reason: 'revoked',
		});
	});

	it('shapes the turn authority over the adapter policy and turns a still-bound receipt unknown after a restart', async () => {
		const { dispatch, file } = bridge();
		await dispatch.load();
		const request = admission('req-t', 'att-t');
		const turn = dispatch.turnAuthority({
			context: request.context,
			resourceIds: ['doc-1'],
			account: 'profile-1',
		});
		expect(turn.policy).toEqual({
			sources: [{ id: dispatch.authority.authorityId, kind: 'endpoint', revision: 3 }],
			policyRevision: 3,
		});
		expect(turn).toMatchObject({ account: 'profile-1', resourceIds: ['doc-1'] });
		const admitted = await turn.authority.admit(request);
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		admitted.lease.bind(99);
		await dispatch.flush();
		expect(dispatch.persistFailures()).toBe(0);

		// A second process over the same ledger: the bound lease is nobody's any more.
		const again = bridge(file);
		const loaded = await again.dispatch.load();
		expect(loaded).toEqual({ ok: true, receipts: 1, recoveredUnknown: 1 });
		expect(again.dispatch.receipt(admitted.lease.leaseId)).toMatchObject({
			decision: { decisionId: 'decision-1' },
			effect: { state: 'unknown', pid: 99 },
		});
		expect(again.dispatch.receipt(admitted.lease.leaseId)?.effect.reason).toMatch(/restarted/);
	});
});

/**
 * The Cue shell boundary (MRC-07-03): the route table, the refusal of an
 * unqualified route before any lease is asked, and the admission of a
 * qualified route (a declared double) on the exact final spawn, with a gate
 * that holds the sink to that snapshot. The authority is the real local host
 * authority over a policy table double.
 */
describe('the Cue shell boundary', () => {
	const localPlan: CueShellSpawnPlan = {
		route: 'local-shell',
		command: 'echo hello',
		args: [],
		cwd: '/work/project',
		env: { PATH: '/usr/bin', MAESTRO_QUERY_SOURCE: 'cue' },
		shell: true,
		projectRoot: '/work/project',
		remoteId: null,
	};
	const sshPlan: CueShellSpawnPlan = {
		route: 'ssh-shell',
		command: 'ssh',
		args: ['user@host', 'bash -c "echo hello"'],
		cwd: '/Users/local',
		env: { PATH: '/usr/bin' },
		shell: false,
		projectRoot: '/remote/project',
		remoteId: 'remote-1',
	};

	function shellAdmission(
		decide: Parameters<typeof createLocalHostAuthority>[0]['decide']
	): Parameters<typeof admitCueShell>[0] & { decisions: AdmissionRequest[] } {
		const decisions: AdmissionRequest[] = [];
		let seq = 0;
		const authority = createLocalHostAuthority({
			authorityId: 'authority-test',
			decide: (request) => {
				decisions.push(request);
				return decide(request);
			},
			now: () => T0,
			newId: () => `lease-${++seq}`,
		});
		return {
			authority,
			context: admission('req-shell', 'att-shell').context,
			policy: { sources: [], policyRevision: 3 },
			account: 'acct-ref',
			decisions,
		};
	}

	it('qualifies neither shell route under management, both run standalone', () => {
		for (const route of ['local-shell', 'ssh-shell'] as const) {
			const support = cueShellRouteSupport(route);
			expect(support.route).toBe(route);
			expect(support.standalone).toBe('implemented');
			expect(support.managed).toBe('unsupported');
			expect(support.note).toContain('no confinement producer qualifies the route');
		}
		expect(cueShellRouteSupport('local-shell').note).toContain("user's shell on this machine");
		expect(cueShellRouteSupport('ssh-shell').note).toContain('remote login shell over SSH');
	});

	it('refuses an unqualified route unavailable before asking the authority for a lease', async () => {
		for (const plan of [localPlan, sshPlan]) {
			const shell = shellAdmission(() => ({ decision: 'allow', policyRevision: 3 }));
			const outcome = await admitCueShell(shell, plan);
			expect(outcome).toMatchObject({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: expect.stringContaining(`over the ${plan.route} route is unavailable`),
			});
			expect(shell.decisions).toHaveLength(0);
			expect(shell.authority.live()).toHaveLength(0);
		}
	});

	it('attributes a shell action to cue-shell with its target and the project root as its resource', () => {
		expect(cueShellAttribution(localPlan, null)).toEqual({
			provider: 'cue-shell',
			model: null,
			operation: 'start',
			account: null,
			target: { kind: 'local' },
			resourceIds: ['dir:/work/project'],
		});
		expect(cueShellAttribution(sshPlan, 'acct-ref')).toMatchObject({
			account: 'acct-ref',
			target: { kind: 'ssh', remoteId: 'remote-1' },
			resourceIds: ['dir:/remote/project'],
		});
	});

	it('on a qualified route (declared double) admits the exact final spawn and gates the sink to it', async () => {
		// DECLARED TEST DOUBLE: no real confinement producer qualifies a shell route.
		const routeSupport = (route: CueShellSpawnPlan['route']) => ({
			route,
			standalone: 'implemented' as const,
			managed: 'implemented' as const,
			note: 'declared test double',
		});
		const shell = shellAdmission(() => ({ decision: 'allow', policyRevision: 3 }));
		const outcome = await admitCueShell(shell, sshPlan, { routeSupport });
		if (outcome.state !== 'admitted') throw new Error(outcome.message);

		expect(shell.decisions).toHaveLength(1);
		expect(shell.decisions[0].snapshot).toBe(outcome.snapshot);
		expect(outcome.snapshot).toMatchObject({
			executable: 'ssh',
			args: ['user@host', 'bash -c "echo hello"'],
			cwd: '/Users/local',
			shell: false,
			envKeys: ['PATH'],
			provider: 'cue-shell',
			account: 'acct-ref',
			target: { kind: 'ssh', remoteId: 'remote-1' },
			resourceIds: ['dir:/remote/project'],
		});
		expect(outcome.attribution).toEqual(cueShellAttribution(sshPlan, 'acct-ref'));
		expect(outcome.lease.state()).toBe('issued');

		// The gate holds the sink to the admitted snapshot: the same spawn passes,
		// a command that changed in between does not.
		expect(outcome.gate.admit(outcome.snapshot)).toEqual({ ok: true });
		const changed = buildDispatchSnapshot(
			{ ...sshPlan, args: ['user@host', 'bash -c "rm -rf /"'] },
			outcome.attribution
		);
		expect(outcome.gate.admit(changed)).toMatchObject({
			ok: false,
			state: 'denied',
			code: 'lease-invalid',
		});

		const denied = shellAdmission(() => ({
			decision: 'deny',
			reason: 'no',
			policyRevision: 3,
			code: 'policy-denied',
		}));
		expect(await admitCueShell(denied, sshPlan, { routeSupport })).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
		});
	});
	describe('signed route evidence (MCOMP-31-03)', () => {
		// Contract-shaped fixtures and a declared verifier double: nothing here
		// qualifies a real shell route. Actual shell/PTY/SSH confinement is MCOMP-32.
		const d = (c: string) => c.repeat(64);
		const DAY = 24 * 60 * 60 * 1000;
		const ENDPOINT = {
			installationId: 'remote-inst',
			runtimeId: 'remote-rt',
			processEpoch: 'remote-epoch',
			authorityId: 'remote-authority',
			policyRevision: 3,
		};
		const candidate = (transport: 'cli-process' | 'ssh'): ProviderRouteCandidate => ({
			provider: 'cue-shell',
			adapterId: 'cue-shell-v1',
			transport,
			binary: { digest: d('a'), version: '5.2', identity: 'bash' },
			os: { platform: 'linux', release: '6.8.0', arch: 'x64' },
			backend: { id: 'bwrap-v1', evidenceDigest: d('b') },
			inputDigest: d('c'),
		});
		const evidence = (
			c: ProviderRouteCandidate,
			tweak: (p: SignedProviderRouteQualification['payload']) => void = () => {}
		): SignedProviderRouteQualification => {
			const payload: SignedProviderRouteQualification['payload'] = {
				version: 1,
				receiptId: 'shell-receipt-1',
				producer: {
					owner: 'mega-maestro',
					implementationRevision: 'e'.repeat(40),
					observedRevision: 'e'.repeat(40),
				},
				tier: 'real-cli-fixture-model',
				modelTransport: 'deterministic-fixture',
				route: { provider: c.provider, adapterId: c.adapterId, transport: c.transport },
				binary: { ...c.binary },
				os: { platform: 'linux', release: c.os.release, arch: 'x64' },
				backend: { ...c.backend },
				inputSnapshot: { inputDigest: c.inputDigest, inputs: [['a/bin', d('1')]] },
				observations: [
					...PROVIDER_ROUTE_ALLOW_CASES.map((name) => ({
						case: name,
						expected: 'allowed' as const,
						observed: 'allowed' as const,
						observer: 'receipt' as const,
						evidenceDigest: d('3'),
					})),
					...PROVIDER_ROUTE_DENY_CASES.map((name) => ({
						case: name,
						expected: 'denied' as const,
						observed: 'denied' as const,
						observer: 'process' as const,
						evidenceDigest: d('4'),
					})),
				],
				observedAt: new Date(T0 - DAY).toISOString(),
			};
			tweak(payload);
			return {
				payload,
				payloadDigest: d('5'),
				keyId: 'route-key-1',
				algorithm: 'Ed25519',
				signature: `${'A'.repeat(86)}==`,
			};
		};
		const verifier = (verdict: 'verified' | 'invalid' | 'unavailable' = 'verified') => {
			const v = {
				version: 1 as const,
				calls: 0,
				async verify() {
					v.calls += 1;
					return verdict;
				},
			};
			return v;
		};
		const qualification = (
			plan: CueShellSpawnPlan,
			overrides: Partial<CueShellRouteQualification> = {}
		): CueShellRouteQualification & { verifier: ReturnType<typeof verifier> } => {
			const c = candidate(plan.route === 'ssh-shell' ? 'ssh' : 'cli-process');
			return {
				evidence: evidence(c),
				candidate: c,
				verifier: verifier(),
				maxAgeMs: 30 * DAY,
				now: () => T0,
				remote: plan.remoteId ? { remoteId: plan.remoteId, endpoint: ENDPOINT } : null,
				...overrides,
			} as CueShellRouteQualification & { verifier: ReturnType<typeof verifier> };
		};
		const allow = () => ({ decision: 'allow' as const, policyRevision: 3 });

		it('admits a local action on verified evidence and reports the route it ran on', async () => {
			const shell = shellAdmission(allow);
			const routeQualification = qualification(localPlan);
			const outcome = await admitCueShell(shell, localPlan, { routeQualification });
			if (outcome.state !== 'admitted') throw new Error(outcome.message);
			expect(routeQualification.verifier.calls).toBe(1);
			expect(shell.decisions).toHaveLength(1);
			expect(outcome.snapshot.target).toEqual({ kind: 'local' });
			expect(outcome.route).toEqual({
				receiptId: 'shell-receipt-1',
				payloadDigest: d('5'),
				tier: 'real-cli-fixture-model',
				transport: 'cli-process',
				sandboxBackendId: 'bwrap-v1',
				endpoint: null,
			});
		});

		it('binds an SSH action to the enrolled endpoint of the very remote it runs on', async () => {
			const shell = shellAdmission(allow);
			const outcome = await admitCueShell(shell, sshPlan, {
				routeQualification: qualification(sshPlan),
			});
			if (outcome.state !== 'admitted') throw new Error(outcome.message);
			expect(outcome.route).toMatchObject({ transport: 'ssh', endpoint: ENDPOINT });
			expect(outcome.attribution.target).toEqual({
				kind: 'ssh',
				remoteId: 'remote-1',
				endpoint: ENDPOINT,
			});
			expect(outcome.snapshot.target).toEqual(outcome.attribution.target);
			// The sink rebuilds the snapshot under the admitted attribution; the gate holds it there.
			expect(outcome.gate.admit(buildDispatchSnapshot(sshPlan, outcome.attribution))).toEqual({
				ok: true,
			});
			expect(
				outcome.gate.admit(buildDispatchSnapshot(sshPlan, cueShellAttribution(sshPlan, 'acct-ref')))
			).toMatchObject({ ok: false, code: 'lease-invalid' });
		});

		it('refuses evidence that does not describe the plan by name, before verifying or leasing', async () => {
			const cases: Array<[CueShellSpawnPlan, Partial<CueShellRouteQualification>, RegExp]> = [
				[sshPlan, { remote: null }, /attested no enrolled endpoint/],
				[sshPlan, { remote: { remoteId: 'remote-2', endpoint: ENDPOINT } }, /another remote/],
				[sshPlan, { candidate: candidate('cli-process') }, /transport is not ssh/],
				[localPlan, { candidate: candidate('ssh') }, /transport is not cli-process/],
				[localPlan, { remote: { remoteId: 'remote-1', endpoint: ENDPOINT } }, /names a remote/],
				[
					localPlan,
					{ candidate: { ...candidate('cli-process'), provider: 'claude-code' } },
					/not the cue-shell provider/,
				],
				[
					localPlan,
					{
						candidate: { ...candidate('cli-process'), backend: { id: '', evidenceDigest: d('b') } },
					},
					/no sandbox backend/,
				],
			];
			for (const [plan, overrides, reason] of cases) {
				const shell = shellAdmission(allow);
				const routeQualification = qualification(plan, overrides);
				const outcome = await admitCueShell(shell, plan, { routeQualification });
				expect(outcome).toMatchObject({ state: 'denied', code: 'context-mismatch' });
				if (outcome.state === 'admitted') throw new Error('admitted');
				expect(outcome.message).toMatch(reason);
				expect(routeQualification.verifier.calls).toBe(0);
				expect(shell.decisions).toHaveLength(0);
			}
			expect(
				cueShellRouteProblems(qualification(sshPlan), { route: 'ssh-shell', remoteId: null })
			).toContain('the SSH action names no resolved remote');
		});

		it('stays unavailable without qualified evidence: no verifier, a refused signature, stale, harness tier, cancelled', async () => {
			const stale = candidate('cli-process');
			const harness = { ...candidate('cli-process'), provider: 'cue-shell' };
			const aborted = new AbortController();
			aborted.abort();
			const cases: Array<[Partial<CueShellRouteQualification>, AbortSignal | undefined, RegExp]> = [
				[{ verifier: undefined }, undefined, /no trusted route evidence verifier/],
				[{ verifier: verifier('invalid') }, undefined, /signature invalid/],
				[{ verifier: verifier('unavailable') }, undefined, /signature unavailable/],
				[
					{
						evidence: evidence(
							stale,
							(p) => (p.observedAt = new Date(T0 - 60 * DAY).toISOString())
						),
					},
					undefined,
					/stale/,
				],
				[
					{
						evidence: evidence(harness, (p) => {
							p.tier = 'node-harness';
							p.modelTransport = 'none';
						}),
					},
					undefined,
					/tier does not match provider/,
				],
				[{}, aborted.signal, /cancelled/],
			];
			for (const [overrides, signal, reason] of cases) {
				const shell = shellAdmission(allow);
				const outcome = await admitCueShell(shell, localPlan, {
					routeQualification: qualification(localPlan, overrides),
					...(signal ? { signal } : {}),
				});
				expect(outcome).toMatchObject({ state: 'unavailable', code: 'capability-unsupported' });
				if (outcome.state === 'admitted') throw new Error('admitted');
				expect(outcome.message).toMatch(reason);
				expect(shell.decisions).toHaveLength(0);
				expect(shell.authority.live()).toHaveLength(0);
			}
		});

		it('still asks the authority on qualified evidence: a policy denial runs nothing', async () => {
			const shell = shellAdmission(() => ({
				decision: 'deny',
				reason: 'no shell',
				policyRevision: 3,
				code: 'policy-denied',
			}));
			const outcome = await admitCueShell(shell, sshPlan, {
				routeQualification: qualification(sshPlan),
			});
			expect(outcome).toMatchObject({ state: 'denied', code: 'policy-denied' });
			expect(shell.decisions).toHaveLength(1);
			expect(shell.authority.live()).toHaveLength(0);
		});
	});
});
