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
} from '../../../main/enterprise/dispatch';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	buildDispatchSnapshot,
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
