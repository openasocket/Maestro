/**
 * The managed host adapter: an endpoint-backed authority over injected custody
 * and the real socket client, and the runtime that admits with it.
 *
 * The endpoint is the fake daemon from the main-process tests and the custody
 * is an in-memory port, both declared doubles: what is proven is that the
 * adapter asks the endpoint for every decision, maps the endpoint's answers
 * onto the four admission states without deciding anything itself, answers
 * `unavailable` for every standing short of registered-attached-managed, and
 * that a runtime given the adapter mirrors the enrollment into its own
 * binding under the lock and never runs standalone over it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../../main/enterprise/endpoint-client';
import { DEFAULT_TAB_DEFAULTS } from '../../../../shared/maestro-lib/agents/rules';
import {
	buildDispatchSnapshot,
	createContextVerifier,
	type AdmissionRequest,
} from '../../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import type { LifecycleFact } from '../../../../shared/maestro-lib/managed/events';
import type { ManagedDelegationRef } from '../../../../shared/maestro-lib/managed/types';
import {
	bindingEnrollment,
	createManagedHostAdapter,
	installationIdentity,
	managedAuthorityId,
	projectPolicyStatus,
} from '../../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../../shared/maestro-lib/managed/operations';
import {
	createMaestroRuntime,
	type MaestroRuntime,
} from '../../../../shared/maestro-lib/runtime/index';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../../main/enterprise/fakeEndpoint';

const T0 = Date.parse('2026-10-21T12:00:00Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const RECEIPT = (payload: Record<string, unknown>) => ({
	outcome: 'broker_dispatched',
	requestId: payload.requestId,
	attemptId: payload.attemptId,
	runId: payload.runId,
	decisionId: 'decision-1',
	requestDigest: 'd'.repeat(64),
	brokerId: 'broker-1',
	policyRevision: payload.policyRevision,
});

function record(socketPath: string, installationId = 'inst-1'): ManagedIdentityRecord {
	return {
		version: 1,
		installationId,
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
		management: 'enrolled',
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: '2026-10-21T12:00:00.000Z' },
		enrolledAt: '2026-10-21T12:00:00.000Z',
		updatedAt: '2026-10-21T12:00:00.000Z',
	};
}
const okView = (r: ManagedIdentityRecord): ManagedIdentityView => ({
	status: 'ok',
	reason: null,
	message: null,
	record: r,
});

/** A standing the lifecycle would report: registered when the port is attached and the endpoint said managed. */
function standing(
	port: EndpointPort | null,
	identity: ManagedIdentityView
): ManagedEnrollmentStatus {
	const connection = port?.state() ?? null;
	const endpoint = connection?.status ?? null;
	const registered =
		identity.status === 'ok' &&
		identity.record?.management === 'enrolled' &&
		connection?.registration === 'registered' &&
		connection.attached &&
		endpoint?.management === 'managed';
	return {
		identity,
		connection,
		endpoint,
		authority: registered ? 'registered' : 'none',
		reason: registered ? null : 'not registered-attached-managed in this process',
		pendingApproval: null,
		lastDenial: null,
	};
}

function admission(
	snapshotArgs: string[] = ['--print'],
	delegation: ManagedDelegationRef = { chain: [], grantRef: null }
): AdmissionRequest {
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
			delegation,
			identity: {
				requestId: 'req-1',
				idempotencyKey: 'key-1',
				attemptId: 'att-1',
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
			{ command: '/bin/claude', args: snapshotArgs, cwd: '/work', env: {} },
			{ provider: 'claude-code', model: 'sonnet' }
		),
		policy: { sources: [], policyRevision: 3 },
	};
}

/** Register this process and attach on `fake` with the named capabilities, as the lifecycle does. */
async function attachPort(fake: FakeEndpoint, supported: string[]): Promise<EndpointPort> {
	const port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
	await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
	await port.registration.redeem();
	const attached = await port.attach({
		installationId: 'inst-1',
		runtimeId: 'desktop-100',
		processEpoch: 'epoch-1',
		components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
		supportedProtocols: [1],
		supportedCapabilities: supported,
		requiredCapabilities: ['execution'],
	});
	expect(attached.status).toBe('ok');
	return port;
}

describe('managed host adapter', () => {
	const open: FakeEndpoint[] = [];
	const ports: EndpointPort[] = [];
	async function endpoint(options: FakeEndpointOptions = {}) {
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'telemetry'],
			operations: { execution: (payload) => RECEIPT(payload as Record<string, unknown>) },
			...options,
		});
		open.push(fake);
		return fake;
	}
	/** A registered, attached port on `fake`, as the lifecycle leaves it. */
	async function attachedPort(
		fake: FakeEndpoint,
		supported: string[] = ['attachment', 'compatibility', 'execution', 'telemetry']
	): Promise<EndpointPort> {
		const port = await attachPort(fake, supported);
		ports.push(port);
		return port;
	}
	afterEach(async () => {
		for (const port of ports.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	it('exposes the workflow owner producer over its endpoint, and none without one (MRC-07-06A)', async () => {
		const fake = await endpoint({
			capabilities: ['execution', 'workflow'],
			operations: {
				workflow: (payload) => ({
					outcome: 'owned',
					workflowId: (payload as { workflowId: string }).workflowId,
					ownerId: 'inst-1',
					ownerEpoch: 1,
					fencingToken: 'fence-1',
				}),
			},
		});
		const port = await attachedPort(fake, ['attachment', 'execution', 'workflow']);
		const view = okView(record(fake.socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
		});
		expect(adapter.workflows).not.toBeNull();
		// The port is the endpoint's `workflow` operation, answered as the registry sent it.
		expect(
			await adapter.workflows!.claim({
				workflowId: 'wf-1',
				triggerId: 'trig-1',
				runId: 'run-1',
				attemptId: 'att-1',
				ownerId: 'inst-1',
				ownerEpoch: 0,
				fencingToken: 'nonce-1',
				offlineEnabled: false,
				policyRevision: 3,
			})
		).toEqual({
			status: 'ok',
			payload: {
				outcome: 'owned',
				workflowId: 'wf-1',
				ownerId: 'inst-1',
				ownerEpoch: 1,
				fencingToken: 'fence-1',
			},
		});
		const detached = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: null,
			status: () => standing(null, view),
			now: () => T0,
		});
		expect(detached.workflows).toBeNull();
	});

	it('exposes the telemetry operation over its endpoint and a standing that names what a report is bound to (MRC-10-03)', async () => {
		const fake = await endpoint({
			operations: {
				telemetry: (payload) => ({
					outcome: 'durably_accepted',
					eventId: (payload as { eventId: string }).eventId,
					receivedAt: '2026-10-21T12:00:01.000Z',
					duplicate: false,
				}),
			},
		});
		const port = await attachedPort(fake);
		const view = okView(record(fake.socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
		});
		const telemetryStanding = adapter.telemetryStanding();
		expect(telemetryStanding).toMatchObject({
			ok: true,
			binding: { deviceId: 'enr-1', installation: INSTALLATION, policyRevision: 3 },
		});
		expect(telemetryStanding.standingKey).toContain(':registered:attached:managed:3:');
		expect(adapter.telemetry).not.toBeNull();
		const report = {
			schemaVersion: 1 as const,
			eventId: 'evt-1',
			deviceId: 'enr-1',
			instanceId: 'inst-1',
			bootId: 'epoch-1',
			sequence: 1,
			occurredAt: '2026-10-21T12:00:00.000Z',
			source: 'runtime' as const,
			family: 'agent.lifecycle' as const,
			policyRevision: 3,
			collectionProfile: 'metadata' as const,
			completeness: {
				metadata: 'partial' as const,
				content: 'unavailable' as const,
				lineage: 'filtered_by_policy' as const,
			},
			usageProvenance: 'unavailable' as const,
			redaction: { state: 'not_applicable' as const, ruleIds: [] },
			contentReferences: [],
		};
		// The port is the endpoint's `telemetry` operation, answered as the spool sent it.
		expect(await adapter.telemetry!.report(report)).toEqual({
			status: 'ok',
			payload: {
				outcome: 'durably_accepted',
				eventId: 'evt-1',
				receivedAt: '2026-10-21T12:00:01.000Z',
				duplicate: false,
			},
		});
		expect(fake.calls.at(-1)?.body).toMatchObject({ operation: 'telemetry', payload: report });

		// No socket: no port and no standing. A record with no enrollment id: no binding either.
		const detached = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: null,
			status: () => standing(null, view),
			now: () => T0,
		});
		expect(detached.telemetry).toBeNull();
		expect(detached.telemetryStanding()).toMatchObject({ ok: false });
		const unnumbered = okView({ ...record(fake.socketPath), enrollmentId: null });
		const noEnrollmentId = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => unnumbered },
			endpoint: port,
			status: () => standing(port, unnumbered),
			now: () => T0,
		});
		expect(noEnrollmentId.telemetryStanding()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('no enrollment id'),
		});
		// A connection that negotiated no telemetry capability is refused before a round trip.
		const narrow = await endpoint({ capabilities: ['execution'] });
		const narrowPort = await attachedPort(narrow, ['attachment', 'compatibility', 'execution']);
		const narrowView = okView(record(narrow.socketPath));
		const noCapability = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => narrowView },
			endpoint: narrowPort,
			status: () => standing(narrowPort, narrowView),
			now: () => T0,
		});
		expect(noCapability.telemetryStanding()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('no telemetry capability'),
		});
	});

	it('derives an identifier-safe installation identity and a stable authority id', () => {
		const identity = installationIdentity({
			hostname: 'host',
			productionDataDir: '/data',
			mode: 'desktop',
			pid: 42,
			startedAt: '2026-10-21T12:00:00.000Z',
		});
		for (const value of Object.values(identity))
			expect(value).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
		expect(identity.runtimeId).toBe('desktop-42');
		expect(identity.processEpoch).not.toBe('2026-10-21T12:00:00.000Z');
		expect(identity).toEqual(
			installationIdentity({
				hostname: 'host',
				productionDataDir: '/data',
				mode: 'desktop',
				pid: 42,
				startedAt: '2026-10-21T12:00:00.000Z',
			})
		);
		const r = record('/tmp/a.sock');
		expect(managedAuthorityId(r)).toMatch(/^endpoint-[a-f0-9]{16}$/);
		expect(managedAuthorityId(r)).toBe(managedAuthorityId({ ...r, management: 'suspended' }));
		expect(managedAuthorityId(r)).not.toBe(managedAuthorityId({ ...r, tenantId: 'tenant-2' }));
		expect(bindingEnrollment(r)).toMatchObject({
			installationId: 'inst-1',
			authorityId: managedAuthorityId(r),
			endpointRef: '/tmp/a.sock',
			policyRevision: 3,
			policySources: [{ kind: 'endpoint', revision: 3 }],
		});
	});

	it('is unavailable, unasked, for a context carrying a delegation chain or a grant reference (CP-03)', async () => {
		const fake = await endpoint();
		let asked = 0;
		fake.options.operations = {
			execution: (payload) => {
				asked += 1;
				return RECEIPT(payload as Record<string, unknown>);
			},
		};
		const port = await attachedPort(fake);
		const view = okView(record(fake.socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
			newId: () => 'lease-1',
		});

		// A dispatched turn's chain (the initiator, then the target) is not
		// described with the chain stripped off; neither is a grant reference.
		const chained = await adapter.authority.admit(
			admission(['--print'], {
				chain: [
					{ kind: 'agent', id: 'owner-agent' },
					{ kind: 'agent', id: 'target-agent' },
				],
				grantRef: null,
			})
		);
		expect(chained).toMatchObject({ state: 'unavailable' });
		expect((chained as { message: string }).message).toContain('a delegation chain of 2');
		const granted = await adapter.authority.admit(
			admission(['--print'], { chain: [], grantRef: 'grant-1' })
		);
		expect(granted).toMatchObject({ state: 'unavailable' });
		expect((granted as { message: string }).message).toContain('a grant reference');
		expect(asked).toBe(0);

		// A direct action still reaches the endpoint, as before.
		expect((await adapter.authority.admit(admission())).state).toBe('admitted');
		expect(asked).toBe(1);
	});

	it('asks the endpoint for every decision and admits on a matching dispatch receipt', async () => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const view = okView(record(fake.socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
			newId: () => 'lease-1',
		});
		expect(adapter.authority.authorityId).toBe(managedAuthorityId(view.record!));
		expect(adapter.policy()).toEqual({
			sources: [{ id: adapter.authority.authorityId, kind: 'endpoint', revision: 3 }],
			policyRevision: 3,
		});

		const outcome = await adapter.authority.admit(admission());
		expect(outcome.state).toBe('admitted');
		if (outcome.state === 'admitted') {
			expect(outcome.lease.leaseId).toBe('lease-1');
			expect(outcome.policyRevision).toBe(3);
		}
		const sent = fake.calls.find(
			(c) => (c.body as { operation: string }).operation === 'execution'
		);
		expect((sent?.body as { payload: unknown }).payload).toEqual({
			requestId: 'req-1',
			attemptId: 'att-1',
			runId: 'run-1',
			source: 'cli',
			operation: 'start',
			arguments: [],
			resources: [],
			provider: 'claude-code',
			model: 'sonnet',
			policyRevision: 3,
		});
		if (outcome.state === 'admitted') {
			expect(outcome.receipt).toEqual({
				decisionId: 'decision-1',
				requestDigest: 'd'.repeat(64),
				brokerId: 'broker-1',
				policyRevision: 3,
			});
			expect(outcome.lease.decision).toEqual(outcome.receipt);
		}
	});

	it('maps the endpoint refusals: a policy refusal denies, no decision is unavailable, a wrong receipt is unknown', async () => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const view = okView(record(fake.socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
		});

		fake.options.operations = { execution: () => ({ outcome: 'denied', reason: 'policy_denied' }) };
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
			policyRevision: 3,
		});

		fake.options.operations = { execution: () => ({ outcome: 'denied', reason: 'unavailable' }) };
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
		});

		// A replay is the broker saying it consumed this request already: a denial, not an outage.
		fake.options.operations = { execution: () => ({ outcome: 'denied', reason: 'replay' }) };
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'denied',
			code: 'idempotency-conflict',
		});

		// A receipt whose broker identifiers are not the contract's is not a decision this host knows.
		fake.options.operations = {
			execution: (payload) => ({
				...RECEIPT(payload as Record<string, unknown>),
				requestDigest: 'not a digest',
			}),
		};
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'unknown',
			code: 'outcome-unknown',
		});

		fake.options.operations = {
			execution: (payload) => ({
				...RECEIPT(payload as Record<string, unknown>),
				runId: 'another-run',
			}),
		};
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'unknown',
			code: 'outcome-unknown',
		});

		// An endpoint that never provisioned a broker advertises no execution: no decision, not a denial.
		fake.revokeRegistration();
		expect(await adapter.authority.admit(admission())).toMatchObject({ state: 'unavailable' });
		expect(adapter.authority.live()).toHaveLength(0);
	});

	it('is unavailable, without asking, for every standing short of registered-attached-managed', async () => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const before = fake.calls.length;
		const view = okView(record(fake.socketPath));

		const noStanding = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => ({
				...standing(port, view),
				authority: 'none',
				reason: 'the endpoint reports suspended',
			}),
		});
		expect(await noStanding.authority.admit(admission())).toMatchObject({
			state: 'unavailable',
			message: 'the endpoint reports suspended',
		});

		const untrusted: ManagedIdentityView = {
			status: 'untrusted',
			reason: 'rollback',
			message: 'older copy',
			record: null,
		};
		const noCustody = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => untrusted },
			endpoint: port,
			status: () => standing(port, untrusted),
			now: () => T0,
		});
		expect(noCustody.authority.authorityId).toBe('unavailable');
		expect(await noCustody.authority.admit(admission())).toMatchObject({
			state: 'unavailable',
			message: 'older copy',
		});
		expect(noCustody.policy()).toEqual({ sources: [], policyRevision: null });

		const noSocket = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: null,
			status: () => standing(null, view),
			now: () => T0,
		});
		expect(await noSocket.authority.admit(admission())).toMatchObject({ state: 'unavailable' });

		const tooWide = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => T0,
		});
		const wide = admission();
		expect(
			await tooWide.authority.admit({
				...wide,
				snapshot: {
					...wide.snapshot,
					resourceIds: Array.from({ length: 65 }, (_, i) => `resource-${i}`),
				},
			})
		).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('exceed the bound'),
		});
		expect(
			await tooWide.authority.admit({
				...admission(),
				policy: { sources: [], policyRevision: null },
			})
		).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('no policy revision'),
		});
		expect(fake.calls).toHaveLength(before);
	});
});

describe('projectPolicyStatus', () => {
	const socketPath = '/tmp/endpoint.sock';
	const live = (port: EndpointPort | null, r = record(socketPath)) => standing(port, okView(r));
	const attachedState = {
		connection: 1,
		attached: true,
		registration: 'registered' as const,
		closed: false,
		status: {
			outcome: 'attached' as const,
			protocol: 1 as const,
			capabilities: ['execution'],
			management: 'managed' as const,
			desiredPolicyRevision: 4,
			appliedPolicyRevision: 3,
			connectivity: 'online' as const,
			collectionProfile: 'metadata' as const,
		},
	};
	const attachedPort = { state: () => attachedState } as unknown as EndpointPort;

	it('reads the live attachment when attached and the record when not, and keeps the installed revision offline', () => {
		const online = projectPolicyStatus({ standing: live(attachedPort), now: T0 });
		expect(online).toMatchObject({
			source: 'endpoint',
			desiredRevision: 4,
			appliedRevision: 3,
			installedRevision: 3,
			converged: false,
			freshness: 'fresh',
			connectivity: 'online',
			management: 'managed',
			capabilities: ['execution'],
			offline: { installedPolicyAvailable: true, mode: 'endpoint' },
			admission: { possible: true, reasons: [] },
		});
		const offline = projectPolicyStatus({ standing: live(null), now: T0 });
		expect(offline).toMatchObject({
			source: 'cached',
			desiredRevision: 3,
			appliedRevision: 3,
			installedRevision: 3,
			connectivity: 'detached',
			offline: { installedPolicyAvailable: true, mode: 'installed-policy-only' },
			admission: { possible: false },
		});
		expect(offline.admission.reasons.join(' ')).toMatch(/not registered/);
		const nothing = projectPolicyStatus({
			standing: standing(null, { status: 'none', reason: null, message: null, record: null }),
			now: T0,
		});
		expect(nothing).toMatchObject({
			source: 'none',
			installedRevision: null,
			offline: { mode: 'none' },
		});
	});

	it('denies a fresh decision on a stale, future or missing observation, a lapsed registration or a lapsed approval', () => {
		const stale = projectPolicyStatus({ standing: live(attachedPort), now: T0 + 6 * 60_000 });
		expect(stale).toMatchObject({ freshness: 'stale', admission: { possible: false } });
		expect(stale.admission.reasons).toEqual(['The policy observation is stale.']);
		const future = projectPolicyStatus({ standing: live(attachedPort), now: T0 - 1 });
		expect(future.freshness).toBe('unknown');
		const unknown = projectPolicyStatus({
			standing: live(attachedPort, {
				...record(socketPath),
				policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
			}),
			now: T0,
		});
		expect(unknown.freshness).toBe('unknown');

		const registration = {
			challengeId: 'c1',
			actorId: null,
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: null,
			challengeDigest: 'c'.repeat(64),
			expiresAt: new Date(T0 - 1).toISOString(),
			registeredAt: new Date(T0 - 60_000).toISOString(),
		};
		const lapsed = projectPolicyStatus({
			standing: live(attachedPort, { ...record(socketPath), registration }),
			now: T0,
		});
		expect(lapsed.registration.state).toBe('expired');
		expect(lapsed.admission.reasons).toEqual(['The actor registration has lapsed.']);

		const approval = projectPolicyStatus({
			standing: {
				...live(attachedPort),
				pendingApproval: { challengeId: 'c2', expiresAt: new Date(T0 - 1).toISOString() },
			},
			now: T0,
		});
		expect(approval.approval.state).toBe('expired');
		expect(approval.admission.reasons).toEqual([
			'The pending approval has lapsed without a redeem.',
		]);

		const outstanding = projectPolicyStatus({
			standing: live({
				state: () => ({
					...attachedState,
					status: { ...attachedState.status, connectivity: 'offline' },
				}),
			} as unknown as EndpointPort),
			now: T0,
		});
		expect(outstanding.admission.reasons).toEqual([
			'The endpoint is offline with a policy update outstanding.',
		]);
	});

	it('the adapter refuses to ask under a stale observation and reports the same projection', async () => {
		const view = okView(record(socketPath));
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: attachedPort,
			status: () => standing(attachedPort, view),
			now: () => T0 + 6 * 60_000,
		});
		expect(adapter.policyStatus().freshness).toBe('stale');
		expect(await adapter.authority.admit(admission())).toMatchObject({
			state: 'unavailable',
			message: 'The policy observation is stale.',
		});
	});
});

describe('runtime with a host adapter', () => {
	let dir: string;
	let work: string;
	const open: MaestroRuntime[] = [];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-runtime-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'host-adapter-work-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [], activeSessionId: null })
		);
	});
	afterEach(async () => {
		for (const runtime of open.splice(0)) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	async function start(
		view: (installationId: string) => ManagedIdentityView,
		port: EndpointPort | null = null
	) {
		let id = 0;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			managed: {
				host: (installation) =>
					createManagedHostAdapter({
						installation,
						identity: { read: () => view(installation.installationId) },
						endpoint: port,
						status: () => standing(port, view(installation.installationId)),
					}),
			},
			deps: {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => T0 + id, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory: () => ({ close: () => undefined }),
				probeBinary: async () => ({ exists: false }),
			},
		});
		if (!started.ok) throw new Error(started.refusal.message);
		open.push(started.runtime);
		return started.runtime;
	}

	it('mirrors an enrolled record into the binding under the lock and admits with the adapter', async () => {
		const runtime = await start((installationId) =>
			okView(record('/tmp/endpoint.sock', installationId))
		);
		for (const value of Object.values(runtime.installation))
			expect(value).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
		expect(runtime.managedHost).not.toBeNull();
		const state = runtime.managedBinding.state();
		expect(state.state).toBe('enrolled');
		if (state.state === 'enrolled') {
			expect(state.record.authorityId).toBe(runtime.managedHost!.authority.authorityId);
			expect(state.record.endpointRef).toBe('/tmp/endpoint.sock');
			expect(state.record.policyRevision).toBe(3);
		}
		expect(runtime.managedBinding.authority().authorityId).toBe(
			runtime.managedHost!.authority.authorityId
		);
		// No socket in this process: enrolled, and every admission unavailable, never standalone.
		expect(await runtime.managedBinding.authority().admit(admission())).toMatchObject({
			state: 'unavailable',
		});
		expect(fs.existsSync(path.join(dir, 'maestro-managed-binding.json'))).toBe(true);

		// A second start finds the binding and the same authority id.
		await runtime.connection.close();
		open.splice(0);
		const again = await start((installationId) =>
			okView(record('/tmp/endpoint.sock', installationId))
		);
		expect(again.managedBinding.state().state).toBe('enrolled');
	});

	it('answers policy.status in process from the adapter projection', async () => {
		const runtime = await start((installationId) =>
			okView(record('/tmp/endpoint.sock', installationId))
		);
		const envelope = {
			context: inProcessContext({
				installation: runtime.installation,
				actor: { kind: 'human' as const, id: 'ada' },
				delegation: { chain: [], grantRef: null },
				identity: {
					requestId: 'req-p',
					idempotencyKey: 'key-p',
					attemptId: 'att-p',
					runId: null,
					rootRunId: null,
					parentRunId: null,
				},
				policyRevision: 3,
				workflow: null,
				traceId: 'trace-p',
				requestedCapabilities: ['policy.status' as const],
			}),
			input: {},
		};
		const answered = await runtime.managed!.policy(envelope);
		expect(answered.ok).toBe(true);
		if (answered.ok) {
			expect(answered.value).toMatchObject({
				status: 'ok',
				requestId: 'req-p',
				value: {
					source: 'cached',
					installedRevision: 3,
					offline: { mode: 'installed-policy-only' },
					admission: { possible: false },
				},
			});
		}
		const notAsked = await runtime.managed!.policy({
			...envelope,
			context: { ...envelope.context, requestedCapabilities: [] },
		});
		expect(notAsked.ok && notAsked.value).toMatchObject({
			status: 'denied',
			code: 'capability-unsupported',
		});
	});

	// MRC-07-06A: the runtime's own ownership claims through the adapter's
	// producer port as this installation, holds what the registry answered in
	// its data directory, and refuses by name when no socket carries a producer.
	it("claims a workflow owner fence per attempt through the adapter's endpoint, and refuses by name with no socket", async () => {
		const WORKFLOW = {
			workflowId: 'runtime-a1-1',
			version: 'v1',
			triggerEventId: 'cli:autoRun.launch:a1:1',
		};
		const view = (installationId: string) => okView(record('/tmp/endpoint.sock', installationId));
		const detached = await start(view);
		expect(detached.managedHost!.workflows).toBeNull();
		expect(
			await detached.claimWorkflowFence(WORKFLOW, { runId: 'req-1', attemptId: 'att-1' })
		).toMatchObject({
			fence: null,
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: expect.stringContaining('No workflow owner producer is attached'),
		});
		await detached.connection.close();
		open.splice(0);

		const requests: Array<Record<string, unknown>> = [];
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'workflow'],
			operations: {
				workflow: (payload) => {
					const p = payload as Record<string, unknown>;
					requests.push(p);
					return {
						outcome: 'owned',
						workflowId: p.workflowId,
						ownerId: p.ownerId,
						ownerEpoch: 4,
						fencingToken: 'fence-4',
					};
				},
			},
		});
		const port = await attachPort(fake, ['attachment', 'execution', 'workflow']);
		try {
			const runtime = await start(view, port);
			expect(runtime.managedHost!.workflows).not.toBeNull();
			expect(
				await runtime.claimWorkflowFence(WORKFLOW, { runId: 'req-1', attemptId: 'att-1' })
			).toEqual({ ownerEpoch: '4', fencingToken: 'fence-4' });
			// A first claim: epoch 0 and a nonce, as the installation, under the record's policy
			// generation; the held fence is kept offline because an installed policy is on record.
			expect(requests).toHaveLength(1);
			expect(requests[0]).toMatchObject({
				workflowId: 'runtime-a1-1',
				runId: 'req-1',
				attemptId: 'att-1',
				ownerId: runtime.installation.installationId,
				ownerEpoch: 0,
				policyRevision: 3,
				offlineEnabled: true,
			});
			// The next attempt re-claims with what the registry issued.
			expect(
				await runtime.claimWorkflowFence(WORKFLOW, { runId: 'req-1', attemptId: 'att-2' })
			).toEqual({ ownerEpoch: '4', fencingToken: 'fence-4' });
			expect(requests[1]).toMatchObject({
				attemptId: 'att-2',
				ownerEpoch: 4,
				fencingToken: 'fence-4',
			});
			expect(fs.existsSync(path.join(dir, 'maestro-managed-workflows.json'))).toBe(true);
		} finally {
			await port.close();
			await fake.close();
		}
	});

	// MRC-10-02A: the runtime composes the lifecycle projection and the durable journal under its
	// data directory, hands the projection to its turn recorder, and answers managed.events from the
	// journal with the cursor contract; a journal file that will not load leaves events unsupported.
	describe('lifecycle events journal (MRC-10-02A)', () => {
		const FACT: LifecycleFact = {
			surface: 'headless-turn',
			state: 'completed',
			at: T0,
			sessionId: 'a1-ai-t1',
			agentId: 'a1',
			tabId: 't1',
			provider: 'claude-code',
			model: null,
			providerSessionId: null,
			runId: 'a1-ai-t1@1',
			record: 'journal',
			ledgerStatus: null,
			exitCode: 0,
			durationMs: 1200,
			detail: null,
		};
		const eventsEnvelope = (runtime: MaestroRuntime, cursor: string | null, limit = 10) => ({
			context: inProcessContext({
				installation: runtime.installation,
				actor: { kind: 'human' as const, id: 'ada' },
				delegation: { chain: [], grantRef: null },
				identity: {
					requestId: 'req-e',
					idempotencyKey: 'key-e',
					attemptId: 'att-e',
					runId: null,
					rootRunId: null,
					parentRunId: null,
				},
				policyRevision: 3,
				workflow: null,
				traceId: 'trace-e',
				requestedCapabilities: ['events.resume' as const],
			}),
			input: { cursor, limit },
		});

		it('keeps what the projection raises in its data directory and pages it through managed.events', async () => {
			const runtime = await start((installationId) =>
				okView(record('/tmp/endpoint.sock', installationId))
			);
			expect(runtime.managedEvents).not.toBeNull();
			const [event] = runtime.lifecycle.record(FACT);
			// The projection names this installation and the enrollment's registered actor.
			expect(event.installation).toEqual(runtime.installation);
			expect(event.context.origin).toBe('headless');
			expect(event.context.actor).toEqual({
				kind: 'human',
				id: 'operator:' + runtime.installation.installationId,
			});
			expect(event.context.policyRevision).toBe(3);
			expect(runtime.managedEvents!.status().entries).toBe(1);

			const page = await runtime.managed!.events(eventsEnvelope(runtime, null));
			expect(page.ok).toBe(true);
			if (page.ok) {
				expect(page.value).toMatchObject({
					status: 'ok',
					requestId: 'req-e',
					value: { completeness: 'complete' },
				});
				if (page.value.status === 'ok') {
					expect(page.value.value.items.map((e) => e.eventId)).toEqual([event.eventId]);
					expect(page.value.value.nextCursor).toMatch(/^evc:/);
					const after = await runtime.managed!.events(
						eventsEnvelope(runtime, page.value.value.nextCursor)
					);
					expect(after.ok && after.value.status === 'ok' && after.value.value.items).toEqual([]);
				}
			}
			// The host now reports events.resume as implemented (this build's bare table says unsupported).
			const identity = await runtime.managed!.identity({
				context: {
					...eventsEnvelope(runtime, null).context,
					requestedCapabilities: ['capabilities.negotiate' as const],
				},
				input: {},
			});
			expect(
				identity.ok && identity.value.status === 'ok' && identity.value.value.capabilities
			).toContainEqual({ key: 'events.resume', status: 'implemented' });
			// Bad input is refused by name, and a context that did not ask is denied.
			const badLimit = await runtime.managed!.events(eventsEnvelope(runtime, null, 0));
			expect(badLimit.ok && badLimit.value).toMatchObject({
				status: 'denied',
				code: 'invalid-input',
			});
			const notAsked = await runtime.managed!.events({
				...eventsEnvelope(runtime, null),
				context: { ...eventsEnvelope(runtime, null).context, requestedCapabilities: [] },
			});
			expect(notAsked.ok && notAsked.value).toMatchObject({
				status: 'denied',
				code: 'capability-unsupported',
			});
			// The journal is on disk under the data directory, and flushed by shutdown.
			await runtime.connection.close();
			open.splice(0);
			const file = path.join(dir, 'maestro-managed-events.json');
			const written = JSON.parse(fs.readFileSync(file, 'utf8'));
			expect(written.entries.map((e: { eventId: string }) => e.eventId)).toEqual([event.eventId]);
			expect(JSON.stringify(written)).not.toContain('prompt');
		});

		it('leaves events unsupported over a journal file that will not load, and never overwrites it', async () => {
			const file = path.join(dir, 'maestro-managed-events.json');
			fs.writeFileSync(file, '{ not json');
			const runtime = await start((installationId) =>
				okView(record('/tmp/endpoint.sock', installationId))
			);
			expect(runtime.managedEvents).toBeNull();
			runtime.lifecycle.record(FACT);
			const page = await runtime.managed!.events(eventsEnvelope(runtime, null));
			expect(page.ok && page.value).toMatchObject({
				status: 'unsupported',
				code: 'capability-unsupported',
			});
			const identity = await runtime.managed!.identity({
				context: {
					...eventsEnvelope(runtime, null).context,
					requestedCapabilities: ['capabilities.negotiate' as const],
				},
				input: {},
			});
			expect(
				identity.ok && identity.value.status === 'ok' && identity.value.value.capabilities
			).toContainEqual({ key: 'events.resume', status: 'unsupported' });
			await runtime.connection.close();
			open.splice(0);
			expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
		});
	});

	it('leaves the binding standalone for a record that names another installation, and unavailable for untrusted custody', async () => {
		const other = await start(() => okView(record('/tmp/endpoint.sock', 'some-other-install')));
		expect(other.managedBinding.state().state).toBe('standalone');
		expect(fs.existsSync(path.join(dir, 'maestro-managed-binding.json'))).toBe(false);
		expect(await other.managedBinding.authority().admit(admission())).toMatchObject({
			state: 'unavailable',
		});
		await other.connection.close();
		open.splice(0);

		const untrusted = await start(() => ({
			status: 'untrusted',
			reason: 'rollback',
			message: 'older copy',
			record: null,
		}));
		expect(untrusted.managedBinding.state().state).toBe('standalone');
		expect(untrusted.managedHost!.authority.authorityId).toBe('unavailable');
		expect(await untrusted.managedBinding.authority().admit(admission())).toMatchObject({
			state: 'unavailable',
			message: 'older copy',
		});
	});
});
