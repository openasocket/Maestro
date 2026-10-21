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

function admission(snapshotArgs: string[] = ['--print']): AdmissionRequest {
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
	async function attachedPort(fake: FakeEndpoint): Promise<EndpointPort> {
		const port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
		ports.push(port);
		await port.registration.challenge({ runtimeId: 'desktop-100', processEpoch: 'epoch-1' });
		await port.registration.redeem();
		const attached = await port.attach({
			installationId: 'inst-1',
			runtimeId: 'desktop-100',
			processEpoch: 'epoch-1',
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			supportedProtocols: [1],
			supportedCapabilities: ['attachment', 'compatibility', 'execution', 'telemetry'],
			requiredCapabilities: ['execution'],
		});
		expect(attached.status).toBe('ok');
		return port;
	}
	afterEach(async () => {
		for (const port of ports.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
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
			operation: 'launch',
			arguments: ['--print'],
			resources: [],
			provider: 'claude-code',
			model: 'sonnet',
			policyRevision: 3,
		});
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
		expect(
			await tooWide.authority.admit(admission(Array.from({ length: 129 }, () => 'x')))
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

	async function start(view: (installationId: string) => ManagedIdentityView) {
		let id = 0;
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			managed: {
				host: (installation) =>
					createManagedHostAdapter({
						installation,
						identity: { read: () => view(installation.installationId) },
						endpoint: null,
						status: () => standing(null, view(installation.installationId)),
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
