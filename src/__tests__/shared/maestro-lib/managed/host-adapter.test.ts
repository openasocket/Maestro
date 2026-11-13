/**
 * The managed host adapter: an endpoint-backed authority over injected custody
 * and the real socket client, and the runtime that admits with it.
 *
 * The endpoint is the fake daemon from the main-process tests and the custody
 * is an in-memory port, both declared doubles: what is proven is that the
 * adapter asks the endpoint for every decision, maps the endpoint's answers
 * through the prepared port without deciding anything itself, answers
 * `unavailable` for every standing short of registered-attached-managed, and
 * that a runtime given the adapter mirrors the enrollment into its own
 * binding under the lock and never runs standalone over it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../../../shared/canonicalJson';

import { createLocalEndpointClient } from '../../../../main/enterprise/endpoint-client';
import { DEFAULT_TAB_DEFAULTS } from '../../../../shared/maestro-lib/agents/rules';
import {
	buildDispatchSnapshot,
	createContextVerifier,
	createLocalHostAuthority,
	type AdmissionRequest,
} from '../../../../shared/maestro-lib/managed/authority';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
	ManagedIdentityView,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import type { LifecycleFact } from '../../../../shared/maestro-lib/managed/events';
import type {
	ManagedDelegationRef,
	ManagedWorkflowRef,
} from '../../../../shared/maestro-lib/managed/types';
import {
	admitProbeTurn,
	bindingEnrollment,
	createManagedHostAdapter,
	createProbeRefusalCache,
	installationIdentity,
	managedAuthorityId,
	ownRunIdentity,
	POLICY_FRESHNESS_MS,
	PROBE_REFUSAL_TTL_MS,
	probeRouteRefusal,
	probeTurnIdentity,
	projectPolicyStatus,
	type ManagedHostAdapterDeps,
	type ProbeRefusalKey,
} from '../../../../shared/maestro-lib/managed/host-adapter';
import { inProcessContext } from '../../../../shared/maestro-lib/managed/operations';
import { dispatchSnapshotDigest } from '../../../../shared/maestro-lib/managed/authority';
import { fakeSpawnPort } from '../../../helpers/managedSpawnPort';
import {
	createMaestroRuntime,
	type MaestroRuntime,
} from '../../../../shared/maestro-lib/runtime/index';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../../main/enterprise/fakeEndpoint';

import { managedRecord, NOW } from '../../../main/enterprise/fakeManaged';
import {
	effectGranted,
	type ManagedEffectProducer,
	type ManagedEffectBinding,
} from '../../../../shared/maestro-lib/managed/effects';
import { delegationOfGrant } from '../../../helpers/managedGrants';

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
	delegation: ManagedDelegationRef = { principals: [], delegation: null, grants: [] },
	workflow: ManagedWorkflowRef | null = null
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
			workflow,
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

	it.each([
		'live',
		'actor',
		'provider',
		'issued',
		'release',
		'revoke',
		'trust',
		'policy',
		'disconnect',
		'expiry',
		'disconnect-after-consume',
		'policy-after-consume',
		'actor-after-consume',
		'expiry-after-consume',
	] as const)('binds effects to owned prepared leases: %s', async (change) => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const r = managedRecord('ada');
		r.endpoint.socketPath = fake.socketPath;
		const view = okView(r);
		const prepared = createLocalHostAuthority({
			authorityId: managedAuthorityId(r),
			newId: () => 'fixture-lease',
			now: () => NOW,
			decide: () => ({ decision: 'allow', policyRevision: 3 }),
		});
		Object.defineProperty(port, 'preparedExecution', { value: { ...prepared, version: 1 } });
		const producer: ManagedEffectProducer = {
			version: 1,
			authorityId: prepared.authorityId,
			authorize: vi.fn(async (request) => ({
				decision: 'allow',
				receipt: {
					receiptId: 'fixture-effect',
					effectDigest: request.effectDigest,
					policyRevision: 3,
					expiresAt: new Date(NOW + 1000).toISOString(),
				},
			})),
			consume: vi.fn(async (_request, receipt) => ({ decision: 'allow', receipt })),
		};
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			effectProducer: () => producer,
			now: () => NOW,
		});
		const launch = await adapter.authority.admit(admission());
		if (launch.state !== 'admitted') throw new Error(launch.state);
		const { lease } = launch;
		if (change !== 'issued') lease.bind(321);
		const binding: ManagedEffectBinding = {
			leaseId: lease.leaseId,
			actor: lease.actor,
			provider: 'claude-code',
			threadId: null,
			turnId: null,
			requestId: 'effect-1',
		};
		if (change === 'actor') binding.actor = { kind: 'human', id: 'mallory' };
		if (change === 'provider') binding.provider = 'other';
		if (change === 'release') lease.release({ outcome: 'exited', exitCode: 0, signal: null });
		if (change === 'revoke') adapter.authority.revoke(lease.leaseId, 'fixture');
		if (change === 'trust') r.endpoint.trustRootDigest = 'e'.repeat(64);
		if (change === 'policy') r.policy.appliedRevision = 4;
		if (change === 'disconnect') port.redial();
		if (change === 'expiry') r.registration!.expiresAt = new Date(NOW).toISOString();
		const effect = {
			kind: 'tool-call' as const,
			tool: 'Write',
			input: { content: 'one' },
			request: { method: 'Write', input: { file_path: '/work/a', content: 'one' } },
		};
		const answer = await adapter.effects.decide(effect, binding, new AbortController().signal);
		const consumed = change === 'live' || change.endsWith('-after-consume');
		expect(effectGranted(answer)).toBe(consumed);
		expect(producer.consume).toHaveBeenCalledTimes(consumed ? 1 : 0);
		if (change.endsWith('-after-consume')) {
			if (change === 'disconnect-after-consume') port.redial();
			if (change === 'policy-after-consume') r.policy.appliedRevision++;
			if (change === 'actor-after-consume') r.registration!.actorId = 'other';
			if (change === 'expiry-after-consume')
				r.registration!.expiresAt = new Date(NOW).toISOString();
			expect(effectGranted(answer)).toBe(false);
			expect(
				await adapter.effects.decide(effect, binding, new AbortController().signal)
			).toMatchObject({ decision: 'deny' });
			expect(producer.consume).toHaveBeenCalledOnce();
		}
		if (change === 'live') {
			vi.mocked(producer.authorize).mockImplementation(() => new Promise(() => {}));
			const pending = adapter.effects.decide(
				effect,
				{ ...binding, requestId: 'effect-2' },
				new AbortController().signal
			);
			lease.release({ outcome: 'exited', exitCode: 0, signal: null });
			expect(await pending).toMatchObject({ decision: 'deny' });
			expect(effectGranted(answer)).toBe(false);
		}
		expect(
			fake.calls.filter((c) => (c.body as { operation: string }).operation === 'execution')
		).toHaveLength(0);
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
				principals: [
					{ kind: 'agent', id: 'owner-agent' },
					{ kind: 'agent', id: 'target-agent' },
				],
				delegation: null,
				grants: [],
			})
		);
		expect(chained).toMatchObject({ state: 'unavailable' });
		expect((chained as { message: string }).message).toContain('delegation authority');
		const granted = await adapter.authority.admit(
			admission(['--print'], {
				principals: [],
				delegation: delegationOfGrant('grant-1'),
				grants: [],
			})
		);
		expect(granted).toMatchObject({ state: 'unavailable' });
		expect((granted as { message: string }).message).toContain('delegation authority');
		expect(asked).toBe(0);

		// A direct action also requires prepared authority.
		expect((await adapter.authority.admit(admission())).state).toBe('unavailable');
		expect(asked).toBe(0);
	});

	it('never dispatches an endpoint effect to obtain permission for a local launch', async () => {
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
		expect(adapter.policy()).toEqual({
			sources: [{ id: adapter.authority.authorityId, kind: 'endpoint', revision: 3 }],
			policyRevision: 3,
		});
		for (const payload of [
			RECEIPT({}),
			{ outcome: 'denied', reason: 'policy_denied' },
			{ outcome: 'prepared', version: 1 },
		]) {
			fake.options.operations = { execution: () => payload };
			expect(await adapter.authority.admit(admission())).toMatchObject({
				state: 'unavailable',
				message: expect.stringContaining('PREPARED/1'),
			});
		}
		expect(
			fake.calls.filter((c) => (c.body as { operation: string }).operation === 'execution')
		).toHaveLength(0);
		expect(adapter.authority.live()).toHaveLength(0);
	});

	it.each([
		'live',
		'chain-only',
		'grant-only',
		'workflow-only',
		'no-source',
		'no-negotiation',
		'v1',
		'legacy-workflow',
		'execution',
		'registration_use',
		'delegation',
		'workflow_claim',
		'workflow_renew',
		'workflow_settle',
		'workflow_release',
		'duplicate',
		'malformed',
		'oversized',
		'withdraw-during-admit',
		'withdraw-before-sink',
		'grant-before-sink',
		'fence-before-sink',
		'revoked-grant',
		'fenced-owner',
	] as const)('requires authenticated workflow/delegation support: %s', async (change) => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const r = managedRecord('ada');
		r.endpoint.socketPath = fake.socketPath;
		const view = okView(r);
		let negotiated: ReturnType<NonNullable<ManagedHostAdapterDeps['workflowNegotiation']>> = {
			outcome: 'negotiated',
			protocol: 2,
			capabilities: [
				'execution',
				'registration_use',
				'delegation',
				'workflow_claim',
				'workflow_renew',
				'workflow_settle',
				'workflow_release',
			],
		};
		const decide = vi.fn(() => {
			if (change === 'withdraw-during-admit') negotiated = null;
			return change === 'revoked-grant' || change === 'fenced-owner'
				? { decision: 'deny' as const, reason: change, policyRevision: 3 }
				: { decision: 'allow' as const, policyRevision: 3 };
		});
		const producer = createLocalHostAuthority({
			authorityId: managedAuthorityId(r),
			now: () => NOW,
			newId: () => 'workflow-fixture-lease',
			decide,
		});
		Object.defineProperty(port, 'preparedExecution', { value: { ...producer, version: 1 } });
		const workflowNegotiation = vi.fn((binding) => {
			expect(binding.preparedExecution).toBe(port.preparedExecution);
			expect(binding.identity).toEqual(r);
			expect(binding.identity).not.toBe(r);
			expect(binding.connection).toBe(port.state().connection);
			return negotiated;
		});
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => NOW,
			workflowNegotiation: change === 'no-source' ? undefined : workflowNegotiation,
		});
		const workflow = {
			workflowId: 'workflow-1',
			workflowVersion: 'version-1',
			triggerId: 'trigger-1',
			owner: { ownerId: 'owner-1', ownerEpoch: 'opaque-epoch', fencingToken: 'opaque-fence' },
		};
		const request = admission(
			[],
			{
				principals:
					change === 'workflow-only' || change === 'grant-only'
						? []
						: [
								{ kind: 'human', id: 'initiator' },
								{ kind: 'agent', id: 'parent' },
							],
				delegation:
					change === 'workflow-only' || change === 'chain-only'
						? null
						: delegationOfGrant('opaque-grant'),
				grants: [],
			},
			change === 'chain-only' || change === 'grant-only' ? null : workflow
		);
		request.context.identity.rootRunId = 'root-run';
		request.context.identity.parentRunId = 'parent-run';
		if (change === 'v1') Object.assign(negotiated, { protocol: 1 });
		if (change === 'legacy-workflow')
			negotiated.capabilities = ['execution', 'registration_use', 'delegation', 'workflow'];
		if (change === 'duplicate')
			negotiated.capabilities = [...negotiated.capabilities, 'delegation'];
		if (change === 'malformed')
			negotiated.capabilities = [...negotiated.capabilities, 'invalid capability'];
		if (change === 'oversized')
			negotiated.capabilities = [
				...negotiated.capabilities,
				...Array.from({ length: 128 }, (_, i) => `extra-${i}`),
			];
		negotiated.capabilities = negotiated.capabilities.filter((capability) => capability !== change);
		if (change === 'no-negotiation') negotiated = null;
		const before = canonicalJson(request);
		const result = await adapter.authority.admit(request);
		expect(canonicalJson(request)).toBe(before);
		expect(
			fake.calls.filter((c) => (c.body as { operation: string }).operation === 'execution')
		).toHaveLength(0);
		if (change === 'revoked-grant' || change === 'fenced-owner') {
			expect(result).toMatchObject({ state: 'denied' });
			expect(producer.live()).toHaveLength(0);
		} else if (change === 'withdraw-during-admit') {
			expect(result).toMatchObject({ state: 'unknown' });
			expect(producer.live()).toHaveLength(0);
			expect(await adapter.authority.admit(request)).toMatchObject({ state: 'unknown' });
			expect(decide).toHaveBeenCalledTimes(1);
		} else if (
			[
				'live',
				'chain-only',
				'grant-only',
				'workflow-only',
				'withdraw-before-sink',
				'grant-before-sink',
				'fence-before-sink',
			].includes(change)
		) {
			expect(result.state).toBe('admitted');
			if (result.state !== 'admitted') throw new Error(result.state);
			expect(decide).toHaveBeenCalledWith(request);
			expect(result.lease).toBe(producer.live()[0]);
			if (change === 'withdraw-before-sink') negotiated = null;
			if (change === 'grant-before-sink')
				request.context.delegation.delegation = delegationOfGrant('replaced');
			if (change === 'fence-before-sink') request.context.workflow!.owner.fencingToken = 'replaced';
			const revoked = change.endsWith('before-sink');
			expect(
				adapter.authority.check(result.lease, dispatchSnapshotDigest(request.snapshot)).ok
			).toBe(!revoked);
			if (revoked) expect(producer.live()).toHaveLength(0);
			else result.lease.release({ outcome: 'stopped', by: 'caller' });
		} else {
			expect(result).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
			expect(decide).not.toHaveBeenCalled();
		}
	});

	it('forwards exact prepared inputs and preserves the producer lease and unknown outcomes', async () => {
		const fake = await endpoint();
		const port = await attachedPort(fake);
		const r = record(fake.socketPath);
		r.registration = {
			actorId: 'ada',
			runtimeId: INSTALLATION.runtimeId,
			processEpoch: INSTALLATION.processEpoch,
			challengeId: 'challenge-1',
			bindingDigest: 'b'.repeat(64),
			processBirthDigest: 'c'.repeat(64),
			challengeDigest: 'd'.repeat(64),
			registeredAt: new Date(T0).toISOString(),
			expiresAt: new Date(T0 + 60_000).toISOString(),
		};
		const view = okView(r);
		let asked = 0;
		let clock = T0;
		let decision: 'allow' | 'deny' | 'unavailable' | 'unknown' = 'allow';
		let mutate = () => {};
		let sent: AdmissionRequest | undefined;
		const producer = createLocalHostAuthority({
			authorityId: managedAuthorityId(r),
			now: () => clock,
			newId: () => `lease-${asked}`,
			leaseTtlMs: 10,
			decide: async (request) => {
				asked++;
				sent = request;
				mutate();
				return decision === 'allow'
					? { decision, policyRevision: 3 }
					: { decision, reason: 'fixture decision', policyRevision: 3 };
			},
		});
		Object.defineProperty(port, 'preparedExecution', {
			configurable: true,
			value: {
				...producer,
				version: 1,
				admit: (
					request: AdmissionRequest,
					binding: { identity: ManagedIdentityRecord; connection: number }
				) => {
					expect(binding.identity).toEqual(r);
					expect(binding.connection).toBe(port.state().connection);
					return producer.admit(request);
				},
			},
		});
		const adapter = createManagedHostAdapter({
			installation: INSTALLATION,
			identity: { read: () => view },
			endpoint: port,
			status: () => standing(port, view),
			now: () => clock,
			workflowNegotiation: () => ({
				outcome: 'negotiated',
				protocol: 2,
				capabilities: ['execution', 'registration_use', 'delegation'],
			}),
		});
		const preparedPort = port.preparedExecution!;
		Object.defineProperty(port, 'preparedExecution', { value: { ...preparedPort, version: 2 } });
		expect(await adapter.authority.admit(admission())).toMatchObject({ state: 'unavailable' });
		Object.defineProperty(port, 'preparedExecution', { value: preparedPort });
		const unasked = asked;
		const wrongActor = admission();
		wrongActor.context.actor.id = 'other';
		expect(await adapter.authority.admit(wrongActor)).toMatchObject({
			state: 'denied',
			code: 'unauthenticated',
		});
		expect(
			await adapter.authority.admit({ ...admission(), context: { ...admission().context } })
		).toMatchObject({ state: 'denied', code: 'unauthenticated' });
		expect(
			await adapter.authority.admit({ ...admission(), policy: { sources: [], policyRevision: 4 } })
		).toMatchObject({ state: 'unavailable' });
		expect(asked).toBe(unasked);
		const request = admission(['--print', 'exact'], {
			principals: [{ kind: 'agent', id: 'caller' }],
			delegation: delegationOfGrant('grant-1'),
			grants: [],
		});
		request.snapshot = buildDispatchSnapshot(
			{
				command: '/bin/claude',
				args: ['--print', 'exact'],
				cwd: '/work',
				env: { EXACT: 'value' },
				stdin: 'prompt',
			},
			{ provider: 'claude-code', model: 'sonnet', account: 'account-1', resourceIds: ['doc-1'] }
		);
		const admitted = await adapter.authority.admit(request);
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') throw new Error('expected prepared lease');
		expect(sent).toBe(request);
		expect(admitted.lease).toBe(producer.live()[0]);
		expect(
			adapter.authority.check(admitted.lease, dispatchSnapshotDigest(request.snapshot))
		).toEqual({ ok: true });
		expect(
			adapter.authority.check(
				admitted.lease,
				dispatchSnapshotDigest(admission(['changed']).snapshot)
			)
		).toEqual({ ok: false, reason: 'snapshot-mismatch' });
		expect(await adapter.authority.admit(request)).toMatchObject({
			state: 'denied',
			code: 'idempotency-conflict',
		});
		expect(asked).toBe(1);
		admitted.lease.bind(123);
		let revoked = false;
		admitted.lease.onRevoked(() => {
			revoked = true;
		});
		producer.revoke(admitted.lease.leaseId, 'cancelled');
		expect(revoked).toBe(true);
		expect(adapter.authority.live()).toHaveLength(0);
		for (const state of ['deny', 'unavailable', 'unknown'] as const) {
			decision = state;
			const next = admission();
			next.context.identity.attemptId = state;
			expect(await adapter.authority.admit(next)).toMatchObject({
				state: state === 'deny' ? 'denied' : state,
			});
			if (state === 'unknown') {
				const before = asked;
				expect(await adapter.authority.admit(next)).toMatchObject({ state: 'unknown' });
				expect(asked).toBe(before);
			}
		}
		decision = 'allow';
		for (const change of [
			() => {
				r.endpoint.trustRootDigest = 'e'.repeat(64);
			},
			() => {
				r.registration!.actorId = 'someone-else';
			},
			() => {
				request.snapshot.args = ['changed'];
			},
		]) {
			r.registration.actorId = 'ada';
			request.context.identity.attemptId = `changed-${asked}`;
			mutate = change;
			expect(await adapter.authority.admit(request)).toMatchObject({ state: 'unknown' });
			expect(producer.live()).toHaveLength(0);
		}
		r.registration.actorId = 'ada';
		mutate = () => {};
		const released = admission();
		released.context.identity.attemptId = 'release';
		const result = await adapter.authority.admit(released);
		if (result.state !== 'admitted') throw new Error('expected prepared lease');
		result.lease.bind(124);
		result.lease.release({ outcome: 'unknown', message: 'child settlement lost' });
		expect(result.lease.ended().release).toEqual({
			outcome: 'unknown',
			message: 'child settlement lost',
		});
		expect(producer.live()).toHaveLength(0);
		for (const change of [
			() => {
				clock += 11;
			},
			() => {
				r.endpoint.bindingDigest = 'f'.repeat(64);
			},
			() => {
				released.context.actor.id = 'changed';
			},
		]) {
			released.context.actor.id = 'ada';
			released.context.identity.attemptId = `sink-${asked}`;
			const result = await adapter.authority.admit(released);
			if (result.state !== 'admitted') throw new Error('expected prepared lease');
			change();
			expect(
				adapter.authority.check(result.lease, dispatchSnapshotDigest(released.snapshot)).ok
			).toBe(false);
		}
		released.context.actor.id = 'ada';
		released.context.identity.attemptId = 'cancel-during-prepare';
		mutate = () => {
			adapter.authority.revokeAll('cancelled while preparing');
		};
		expect(await adapter.authority.admit(released)).toMatchObject({ state: 'unknown' });
		expect(producer.live()).toHaveLength(0);
		mutate = () => {};
		released.context.identity.attemptId = 'concurrent';
		const pending = adapter.authority.admit(released);
		expect(await adapter.authority.admit(released)).toMatchObject({ state: 'unknown' });
		const concurrent = await pending;
		if (concurrent.state !== 'admitted') throw new Error('expected prepared lease');
		concurrent.lease.release({ outcome: 'stopped', by: 'caller' });
		let lostCalls = 0;
		Object.defineProperty(port, 'preparedExecution', {
			value: {
				...producer,
				version: 1,
				admit: async () => {
					lostCalls++;
					throw new Error('lost response');
				},
			},
		});
		released.context.identity.attemptId = 'lost-response';
		expect(await adapter.authority.admit(released)).toMatchObject({ state: 'unknown' });
		await port.close();
		expect(await adapter.authority.admit(released)).toMatchObject({ state: 'unknown' });
		expect(lostCalls).toBe(1);
		expect(
			fake.calls.filter((c) => (c.body as { operation: string }).operation === 'execution')
		).toHaveLength(0);
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
				delegation: { principals: [], delegation: null, grants: [] },
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
			).toEqual({
				ownerId: runtime.installation.installationId,
				ownerEpoch: '4',
				fencingToken: 'fence-4',
			});
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
			).toEqual({
				ownerId: runtime.installation.installationId,
				ownerEpoch: '4',
				fencingToken: 'fence-4',
			});
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
				delegation: { principals: [], delegation: null, grants: [] },
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

// ---------------------------------------------------------------------------
// Probe turns (MRC2-02-04, tested by MRC2-02-07A): a provider started for its
// metadata alone, admitted like a turn against the real local authority and
// the real verifier behind `fakeSpawnPort` (the policy answer is the table).
// ---------------------------------------------------------------------------

describe('probe turns', () => {
	const spec = { command: '/bin/codex', args: ['app-server'], cwd: '/work', env: { A: '1' } };

	/** The verified context a host binds a probing actor into. */
	function probeContext(
		port: ReturnType<typeof fakeSpawnPort>,
		traceId = 'codex-skill-probe:/work'
	) {
		const verified = port.verify({
			actor: { peer: 'host-secret' },
			identity: probeTurnIdentity(),
			traceId,
			policyRevision: 1,
			workflow: null,
		});
		if (!verified.ok) throw new Error(verified.problems.join('; '));
		return verified.context;
	}

	describe('probeRouteRefusal', () => {
		it('refuses the Codex app-server route by name on the real table: no enforcement producer in this build', () => {
			const refusal = probeRouteRefusal('codex', 'codex-app-server');
			expect(refusal).toMatchObject({ state: 'unavailable', code: 'capability-unsupported' });
			expect(refusal!.message).toContain('codex');
			expect(refusal!.message).toContain('codex-app-server');
			expect(refusal!.message).toContain('Codex app-server transport');
			expect(refusal!.message).toContain('no managed enforcement producer');
			expect(refusal!.message).toContain('Nothing was started');
		});

		it('qualifies the child-process route of a provider with a batch mode, and nothing else', () => {
			expect(probeRouteRefusal('codex', 'child-process')).toBeNull();
			expect(probeRouteRefusal('claude-code', 'child-process')).toBeNull();
			for (const route of ['pty', 'ssh', 'opencode-server'] as const) {
				expect(probeRouteRefusal('codex', route)).toMatchObject({
					state: 'unavailable',
					code: 'capability-unsupported',
					message: expect.stringContaining(route),
				});
			}
		});

		it('refuses a provider the table does not know, naming the route', () => {
			expect(probeRouteRefusal('no-such-provider', 'child-process')).toMatchObject({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: expect.stringContaining('no-such-provider'),
			});
		});
	});

	describe('probeTurnIdentity', () => {
		it('is its own request, one attempt, no run above it', () => {
			let n = 0;
			const identity = probeTurnIdentity(() => `id-${++n}`);
			expect(identity).toEqual({
				requestId: 'id-1',
				idempotencyKey: 'id-1',
				attemptId: 'id-2',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			});
			expect(ownRunIdentity(() => 'same')).toEqual({
				requestId: 'same',
				idempotencyKey: 'same',
				attemptId: 'same',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			});
		});

		it('mints distinct ids by default, so two probes are never one request', () => {
			const first = probeTurnIdentity();
			const second = probeTurnIdentity();
			expect(first.requestId).not.toBe(second.requestId);
			expect(first.attemptId).not.toBe(first.requestId);
			expect(first.runId).toBeNull();
		});
	});

	describe('admitProbeTurn', () => {
		it('asks the authority for a lease on the probe snapshot and returns the lease-backed admission startTurn takes', async () => {
			const port = fakeSpawnPort();
			const context = probeContext(port);
			const admitted = await admitProbeTurn({
				authority: port.authority,
				policy: port.policy(),
				context,
				spec,
				attribution: { provider: 'codex', origin: 'cli', target: { kind: 'local' } },
			});
			expect(admitted.ok).toBe(true);
			if (!admitted.ok) return;
			expect(port.asked).toHaveLength(1);
			expect(port.asked[0].context).toBe(context);
			expect(port.asked[0].policy).toEqual(port.policy());
			expect(port.asked[0].snapshot).toMatchObject({
				purpose: 'probe',
				operation: 'start',
				origin: 'cli',
				provider: 'codex',
				executable: '/bin/codex',
				args: ['app-server'],
				cwd: '/work',
				envKeys: ['A'],
				target: { kind: 'local' },
			});
			expect(admitted.admission.attribution).toEqual({
				provider: 'codex',
				origin: 'cli',
				target: { kind: 'local' },
				operation: 'start',
				purpose: 'probe',
			});
			const live = port.authority.live();
			expect(live.map((l) => l.leaseId)).toEqual([admitted.leaseId]);
			expect(live[0].snapshotDigest).toBe(dispatchSnapshotDigest(port.asked[0].snapshot));
			expect(live[0].state()).toBe('issued');

			// The gate is the real lease admission: the same spec checks out, a
			// changed one is refused lease-invalid, the pid binds, the exit releases.
			const { gate, attribution } = admitted.admission;
			expect(gate.admit(buildDispatchSnapshot(spec, attribution))).toEqual({ ok: true });
			expect(
				gate.admit(buildDispatchSnapshot({ ...spec, cwd: '/elsewhere' }, attribution))
			).toEqual({
				ok: false,
				state: 'denied',
				code: 'lease-invalid',
				message: expect.stringContaining('snapshot-mismatch'),
			});
			expect(
				gate.admit(buildDispatchSnapshot(spec, { ...attribution, purpose: 'conversation' }))
			).toMatchObject({ ok: false, code: 'lease-invalid' });
			gate.bound!(4242);
			expect(live[0].state()).toBe('bound');
			expect(live[0].pid()).toBe(4242);
			gate.released!({
				exitCode: 0,
				signal: null,
				interrupted: false,
				stderrText: '',
				stdoutText: '',
				droppedOutputBytes: 0,
			});
			expect(live[0].state()).toBe('released');
			expect(live[0].ended().release).toEqual({ outcome: 'exited', exitCode: 0, signal: null });
			expect(port.authority.live()).toHaveLength(0);
		});

		it('hears a revocation through the gate while bound', async () => {
			const port = fakeSpawnPort();
			const admitted = await admitProbeTurn({
				authority: port.authority,
				policy: port.policy(),
				context: probeContext(port),
				spec,
				attribution: { provider: 'codex' },
			});
			expect(admitted.ok).toBe(true);
			if (!admitted.ok) return;
			const heard: string[] = [];
			admitted.admission.gate.bound!(1);
			admitted.admission.gate.onRevoked!((reason) => heard.push(reason));
			expect(port.authority.revoke(admitted.leaseId, 'policy replaced')).toBe(true);
			expect(heard).toEqual(['policy replaced']);
			expect(
				admitted.admission.gate.admit(buildDispatchSnapshot(spec, admitted.admission.attribution))
			).toMatchObject({
				ok: false,
				code: 'lease-invalid',
				message: expect.stringContaining('revoked'),
			});
		});

		it('returns the authority refusal with its state, code and message, and mints no lease', async () => {
			const denied = fakeSpawnPort({
				decide: () => ({ decision: 'deny', reason: 'no probes', policyRevision: 1 }),
			});
			expect(
				await admitProbeTurn({
					authority: denied.authority,
					policy: denied.policy(),
					context: probeContext(denied),
					spec,
					attribution: { provider: 'codex' },
				})
			).toEqual({ ok: false, state: 'denied', code: 'policy-denied', message: 'no probes' });
			expect(denied.authority.live()).toHaveLength(0);

			const away = fakeSpawnPort({ decide: () => ({ decision: 'unavailable', reason: 'away' }) });
			expect(
				await admitProbeTurn({
					authority: away.authority,
					policy: away.policy(),
					context: probeContext(away),
					spec,
					attribution: { provider: 'codex' },
				})
			).toEqual({ ok: false, state: 'unavailable', code: 'runtime-unavailable', message: 'away' });

			const lost = fakeSpawnPort({ decide: () => ({ decision: 'unknown', reason: 'lost' }) });
			expect(
				await admitProbeTurn({
					authority: lost.authority,
					policy: lost.policy(),
					context: probeContext(lost),
					spec,
					attribution: { provider: 'codex' },
				})
			).toEqual({ ok: false, state: 'unknown', code: 'outcome-unknown', message: 'lost' });
		});
	});

	describe('createProbeRefusalCache', () => {
		const key: ProbeRefusalKey = {
			authorityId: 'a',
			policyRevision: 1,
			providerId: 'codex',
			route: 'codex-app-server',
			scope: 'host-secret|/work',
		};
		const refusal = { state: 'denied' as const, code: 'policy-denied' as const, message: 'no' };

		it('remembers a refusal for its key until the TTL passes, then forgets it', () => {
			let t = 0;
			const cache = createProbeRefusalCache({ now: () => t, ttlMs: 100 });
			expect(cache.recall(key)).toBeNull();
			expect(cache.remember(key, refusal)).toBe(refusal);
			expect(cache.recall(key)).toBe(refusal);
			expect(cache.size()).toBe(1);
			t = 99;
			expect(cache.recall(key)).toBe(refusal);
			t = 100;
			expect(cache.recall(key)).toBeNull();
			expect(cache.size()).toBe(0);
		});

		it('keys on the authority, the revision, the provider, the route and the scope', () => {
			const cache = createProbeRefusalCache({ now: () => 0, ttlMs: 100 });
			cache.remember(key, refusal);
			expect(cache.recall({ ...key, policyRevision: 2 })).toBeNull();
			expect(cache.recall({ ...key, policyRevision: null })).toBeNull();
			expect(cache.recall({ ...key, authorityId: 'b' })).toBeNull();
			expect(cache.recall({ ...key, providerId: 'claude-code' })).toBeNull();
			expect(cache.recall({ ...key, route: 'child-process' })).toBeNull();
			expect(cache.recall({ ...key, scope: 'host-secret|/other' })).toBeNull();
			expect(cache.recall({ ...key })).toBe(refusal);
			expect(
				cache.recall({
					scope: key.scope,
					route: key.route,
					providerId: key.providerId,
					policyRevision: key.policyRevision,
					authorityId: key.authorityId,
				})
			).toBe(refusal);
		});

		it('a later refusal for the same key replaces the earlier one; clear forgets all; expired entries are swept on remember', () => {
			let t = 0;
			const cache = createProbeRefusalCache({ now: () => t, ttlMs: 100 });
			cache.remember(key, refusal);
			const later = {
				state: 'unavailable' as const,
				code: 'runtime-unavailable' as const,
				message: 'away',
			};
			cache.remember(key, later);
			expect(cache.recall(key)).toBe(later);
			cache.remember({ ...key, scope: 'other' }, refusal);
			expect(cache.size()).toBe(2);
			t = 100;
			cache.remember({ ...key, scope: 'third' }, refusal);
			expect(cache.size()).toBe(1);
			cache.clear();
			expect(cache.size()).toBe(0);
			expect(cache.recall({ ...key, scope: 'third' })).toBeNull();
		});

		it('remembers for as long as a policy status is fresh by default', () => {
			expect(PROBE_REFUSAL_TTL_MS).toBe(POLICY_FRESHNESS_MS);
			expect(PROBE_REFUSAL_TTL_MS).toBe(5 * 60_000);
		});
	});
});
