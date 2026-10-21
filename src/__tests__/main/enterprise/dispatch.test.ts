/**
 * The broker dispatch bridge: the ledger that joins a broker decision to the
 * local lease and the effect it covered. The endpoint is the fake daemon
 * (a declared double) answering `broker_dispatched` receipts; the authority
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	createBrokerDispatch,
	DISPATCH_RECEIPTS_FILE_NAME,
	admitCueShell,
	cueShellAttribution,
	cueShellRouteSupport,
	type CueShellSpawnPlan,
} from '../../../main/enterprise/dispatch';
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
import { createManagedHostAdapter } from '../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

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
			actorId: null,
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
			delegation: { chain: [], grantRef: null },
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

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-dispatch-'));
		decisions = 0;
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
		await new Promise((resolve) => setTimeout(resolve, 20));
		const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { receipts: unknown[] };
		expect(written.receipts).toHaveLength(1);
		expect(written.receipts[0]).toMatchObject({
			leaseId: 'lease-1',
			effect: { state: 'released' },
		});
	});

	it('leaves no record for a refusal and writes a revocation as the authority’s stop', async () => {
		const { dispatch } = bridge();
		await dispatch.load();
		fake.options.operations = { execution: () => ({ outcome: 'denied', reason: 'policy_denied' }) };
		expect(await dispatch.authority.admit(admission('req-d'))).toMatchObject({ state: 'denied' });
		expect(dispatch.receipts()).toHaveLength(0);

		fake.options.operations = {
			execution: (payload) => {
				const p = payload as Record<string, unknown>;
				decisions += 1;
				return {
					outcome: 'broker_dispatched',
					requestId: p.requestId,
					attemptId: p.attemptId,
					runId: p.runId,
					decisionId: `decision-${decisions}`,
					requestDigest: 'e'.repeat(64),
					brokerId: 'broker-1',
					policyRevision: p.policyRevision,
				};
			},
		};
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
		await new Promise((resolve) => setTimeout(resolve, 20));

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
});
