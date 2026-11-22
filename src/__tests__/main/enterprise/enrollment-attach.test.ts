/**
 * The production attachment is ONE protocol 2 connection (handoff item 1,
 * contracts 0.4.0): the registration handshake (challenge, redeem), the v2
 * attachment and every operation after it share a socket, and nothing is sent
 * on any other path. The endpoint holds one protocol per socket session.
 *
 * What is defended: the attachment offers `registration_use`, the four
 * workflow custody verbs and the selected operations, with nothing required;
 * it asks for the `registration_use` reference itself when that was
 * negotiated; a subset offer still attaches, and an operation the attachment
 * did not negotiate is never sent.
 *
 * Under a grant (SIMPLE-04-03, MSX-04-01) the endpoint renews the process inside
 * the attachment: no challenge and no approval handoff run, the projected
 * reference becomes the record's registration in this OS account's own data
 * directory, a refused renewal is the attachment's denial and is never followed
 * by a challenge of our own, and a CLI host with no desktop objects attaches the
 * same way.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * nothing here is paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../shared/maestro-lib/managed/endpoint-client';
import { composeHostManaged } from '../../../cli/services/host-managed';
import { installationIdentity } from '../../../shared/maestro-lib/managed/host-adapter';
import {
	createEnrollmentLifecycle,
	type EnrollmentLifecycle,
} from '../../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	type EnterpriseIdentityStore,
} from '../../../main/enterprise/identity-store';
import { ENTERPRISE_SUPPORTED_CAPABILITIES } from '../../../main/enterprise/service';
import {
	ENDPOINT_OPERATIONS_OFFERED,
	invokeNegotiated,
	LOCAL_ENDPOINT_INVOKE_PATH,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointCall,
	type FakeEndpointOptions,
} from './fakeEndpoint';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const SERVES_ENROLLMENT: FakeEndpointOptions = {
	capabilities: ['enrollment', 'telemetry'],
	operations: { enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-1' }) },
	now: () => NOW,
};
const WORKFLOW_VERBS = ['workflow_claim', 'workflow_renew', 'workflow_settle', 'workflow_release'];
const PROJECTED = {
	outcome: 'projected',
	reference: {
		version: 2,
		purpose: 'runtime_use',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: '7f1c2a4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b',
		installationId: INSTALLATION.installationId,
		runtimeId: INSTALLATION.runtimeId,
		processEpoch: INSTALLATION.processEpoch,
		bindingDigest: 'a'.repeat(64),
		processBirthDigest: 'b'.repeat(64),
		challengeId: 'chal-1',
		challengeDigest: 'c'.repeat(64),
	},
	expiresAt: '2026-11-13T12:05:00.000Z',
};

type Envelope = { operation: string; payload: Record<string, unknown> };
const envelope = (call: FakeEndpointCall) => call.body as Envelope;
const operationsOn = (fake: FakeEndpoint, target: string) =>
	fake.callsTo(target).map((call) => envelope(call).operation);

describe('production attachment: one protocol 2 connection', () => {
	let dir: string;
	let identity: EnterpriseIdentityStore;
	const open: FakeEndpoint[] = [];
	const lifecycles: EnrollmentLifecycle[] = [];
	let ports: EndpointPort[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-attach-'));
		ports = [];
	});
	afterEach(async () => {
		for (const lifecycle of lifecycles.splice(0)) await lifecycle.close();
		for (const fake of open.splice(0)) await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function endpoint(options: FakeEndpointOptions): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint({ ...SERVES_ENROLLMENT, ...options });
		open.push(fake);
		return fake;
	}

	async function lifecycle(socketPath: string): Promise<EnrollmentLifecycle> {
		identity = createEnterpriseIdentityStore({
			file: path.join(dir, 'identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor({ value: null as Anchor | null }),
			platform: 'darwin',
			now: () => NOW,
		});
		await identity.write({
			installationId: INSTALLATION.installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: 'a'.repeat(64) },
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
			enrolledAt: '2026-10-21T12:00:00.000Z',
		});
		const created = createEnrollmentLifecycle({
			identity,
			openPort: (target) => {
				const port = createLocalEndpointClient({ socketPath: target, timeoutMs: 1_000 });
				ports.push(port);
				return port;
			},
			installation: INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: { supported: ENTERPRISE_SUPPORTED_CAPABILITIES, required: [] },
			now: () => NOW,
		});
		lifecycles.push(created);
		return created;
	}

	/** Register (challenge, redeem, attach), then reconnect. */
	async function run(fake: FakeEndpoint) {
		const life = await lifecycle(fake.socketPath);
		expect((await life.beginRegistration()).status).toBe('ok');
		expect((await life.completeRegistration()).status).toBe('ok');
		expect((await life.connect()).status).toBe('ok');
		expect(ports).toHaveLength(1);
		return { life, port: ports[0] };
	}

	it('offers registration_use, the workflow verbs, delegation and the selected operations, nothing required', () => {
		expect(ENTERPRISE_SUPPORTED_CAPABILITIES).toEqual([
			'attachment',
			'compatibility',
			'registration_use',
			...WORKFLOW_VERBS,
			'delegation',
			...ENDPOINT_OPERATIONS_OFFERED,
		]);
	});

	it('runs the handshake, the attachment and registration_use on one socket, and nothing else before them', async () => {
		const fake = await endpoint({
			capabilities: ['registration_use', ...WORKFLOW_VERBS],
			operations: { ...SERVES_ENROLLMENT.operations, registration_use: () => PROJECTED },
		});
		const { life, port } = await run(fake);

		const attach = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).map(envelope)[2];
		expect(attach.operation).toBe('attachment');
		expect(attach.payload).toMatchObject({
			installationId: INSTALLATION.installationId,
			runtimeId: INSTALLATION.runtimeId,
			processEpoch: INSTALLATION.processEpoch,
			supportedProtocols: [2],
			supportedCapabilities: ENTERPRISE_SUPPORTED_CAPABILITIES,
			requiredCapabilities: [],
		});
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual([
			'registration_challenge',
			'registration_redeem',
			'attachment',
			'registration_use',
			'attachment',
			'registration_use',
		]);
		// The handshake and the first attachment shared one socket.
		const firstThree = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).slice(0, 3);
		expect(new Set(firstThree.map((call) => call.socket)).size).toBe(1);

		for (const operation of ['registration_use', ...WORKFLOW_VERBS]) {
			expect(port.negotiated(operation)).toBe(true);
		}
		expect(port.state()).toMatchObject({ attached: true, registration: 'registered' });
		expect(life.status()).toMatchObject({
			authority: 'registered',
			registrationUse: { reference: { processBirthDigest: 'b'.repeat(64) } },
		});
		// An operation the attachment did not negotiate is refused by the shared gate, never sent.
		expect(await invokeNegotiated(port, 'telemetry', { probe: 1 })).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});

		await life.close();
		expect(port.state().closed).toBe(true);
	});

	it.each([
		['serves no /v2/invoke path', { v2: false }],
		['offers no protocol 2 (unsupported_version)', { offered: false }],
	])(
		'an endpoint that %s is reported, and nothing is retried',
		async (_label, options: FakeEndpointOptions) => {
			const fake = await endpoint(options);
			const life = await lifecycle(fake.socketPath);
			expect((await life.connect()).status).not.toBe('ok');
			expect(life.status().authority).toBe('none');
			expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'enrolled' } });
		}
	);

	it('a subset offer still attaches; an operation it did not select is never sent', async () => {
		const fake = await endpoint({ capabilities: ['workflow_claim'] });
		const { life, port } = await run(fake);

		expect(port.state().closed).toBe(false);
		expect(port.negotiated('workflow_claim')).toBe(true);
		expect(port.negotiated('registration_use')).toBe(false);
		expect(port.negotiated('workflow_renew')).toBe(false);
		expect(life.status().registrationUse).toBeNull();

		const used = await life.useRegistration();
		expect(used).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
		expect(new Set(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH))).toEqual(
			new Set(['registration_challenge', 'registration_redeem', 'attachment'])
		);
	});
});

describe('silent attach under a grant', () => {
	let root: string;
	const open: FakeEndpoint[] = [];
	const closers: Array<() => Promise<void>> = [];

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-attach-'));
	});
	afterEach(async () => {
		for (const close of closers.splice(0)) await close();
		for (const fake of open.splice(0)) await fake.close();
		fs.rmSync(root, { recursive: true, force: true });
	});

	/** A daemon that renews under a grant for the runtimes `covered` names, and projects their reference. */
	async function grantEndpoint(covered: (runtimeId: unknown) => boolean): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			renewal: (attachment) => covered(attachment.runtimeId),
			capabilities: ['registration_use'],
			operations: { registration_use: () => PROJECTED },
			now: () => NOW,
		});
		open.push(fake);
		return fake;
	}

	/** One OS account: its own data directory, its own sealed record, its own lifecycle. */
	async function account(
		name: string,
		socketPath: string,
		installation = INSTALLATION,
		registration: Record<string, unknown> | null = null
	) {
		const dataDir = path.join(root, name);
		fs.mkdirSync(dataDir);
		const store = createEnterpriseIdentityStore({
			file: path.join(dataDir, 'enterprise-identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor({ value: null as Anchor | null }),
			platform: 'darwin',
			now: () => NOW,
		});
		await store.write({
			installationId: installation.installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: 'a'.repeat(64) },
			management: 'enrolled',
			registration: registration as never,
			policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
			enrolledAt: '2026-10-21T12:00:00.000Z',
		});
		const life = createEnrollmentLifecycle({
			identity: store,
			openPort: (target) => createLocalEndpointClient({ socketPath: target, timeoutMs: 1_000 }),
			installation,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: { supported: ENTERPRISE_SUPPORTED_CAPABILITIES, required: [] },
			now: () => NOW,
		});
		closers.push(() => life.close());
		const record = () => {
			const read = store.read();
			if (read.status !== 'ok') throw new Error('no record');
			return read.record;
		};
		return { life, record };
	}

	it('attaches with no challenge and records the projected registration', async () => {
		const fake = await grantEndpoint(() => true);
		const { life, record } = await account('alice', fake.socketPath);

		expect(await life.connect()).toMatchObject({ status: 'ok' });
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual([
			'attachment',
			'registration_use',
		]);
		const status = life.status();
		expect(status).toMatchObject({
			authority: 'registered',
			reason: null,
			pendingApproval: null,
			connection: { attached: true, registration: 'registered' },
		});
		expect(record().registration).toEqual({
			challengeId: 'chal-1',
			actorId: null,
			runtimeId: INSTALLATION.runtimeId,
			processEpoch: INSTALLATION.processEpoch,
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: 'b'.repeat(64),
			challengeDigest: 'c'.repeat(64),
			expiresAt: PROJECTED.expiresAt,
			registeredAt: new Date(NOW).toISOString(),
		});
		expect(record().enrollmentId).toBe(PROJECTED.reference.enrollmentId);
	});

	it('with no grant, the attachment is refused and the challenge runs only when asked', async () => {
		const fake = await grantEndpoint(() => false);
		const { life, record } = await account('alice', fake.socketPath);

		expect(await life.connect()).toEqual({
			status: 'denied',
			reason: 'unauthenticated',
			operation: 'attachment',
		});
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual(['attachment']);
		expect((await life.beginRegistration()).status).toBe('ok');
		expect((await life.completeRegistration()).status).toBe('ok');
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual([
			'attachment',
			'registration_challenge',
			'registration_redeem',
			'attachment',
			'registration_use',
		]);
		expect(life.status().authority).toBe('registered');
		expect(record().registration?.challengeDigest).toBe('c'.repeat(64));
	});

	it('a refused renewal is the denied outcome, recorded, and never followed by a challenge', async () => {
		const fake = await grantEndpoint(() => false);
		const previous = {
			challengeId: 'chal-0',
			actorId: null,
			runtimeId: 'desktop-99',
			processEpoch: 'epoch-0',
			bindingDigest: 'a'.repeat(64),
			processBirthDigest: 'd'.repeat(64),
			challengeDigest: 'e'.repeat(64),
			expiresAt: '2026-11-13T11:00:00.000Z',
			registeredAt: '2026-11-13T10:55:00.000Z',
		};
		const { life, record } = await account('alice', fake.socketPath, INSTALLATION, previous);

		for (let i = 0; i < 3; i++) {
			expect(await life.connect()).toEqual({
				status: 'denied',
				reason: 'unauthenticated',
				operation: 'attachment',
			});
		}
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).toEqual([
			'attachment',
			'attachment',
			'attachment',
		]);
		expect(life.status()).toMatchObject({
			authority: 'none',
			pendingApproval: null,
			lastDenial: { operation: 'attachment', reason: 'unauthenticated' },
		});
		expect(record().registration).toEqual(previous);
	});

	it("a second OS account never uses the first account's grant", async () => {
		const bob = {
			installationId: INSTALLATION.installationId,
			runtimeId: 'desktop-200',
			processEpoch: 'epoch-9',
		};
		const fake = await grantEndpoint((runtimeId) => runtimeId === INSTALLATION.runtimeId);
		const alice = await account('alice', fake.socketPath);
		const second = await account('bob', fake.socketPath, bob);

		expect(await alice.life.connect()).toMatchObject({ status: 'ok' });
		expect(await second.life.connect()).toMatchObject({
			status: 'denied',
			reason: 'unauthenticated',
		});
		expect(alice.record().registration?.challengeId).toBe('chal-1');
		expect(second.record().registration).toBeNull();
		expect(second.life.status()).toMatchObject({ authority: 'none', registrationUse: null });
		// Each account's custody is its own file in its own data directory.
		expect(fs.readdirSync(path.join(root, 'bob'))).toEqual(
			fs.readdirSync(path.join(root, 'alice'))
		);
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).not.toContain('registration_challenge');
	});

	it('a CLI host with no desktop objects attaches silently under a grant', async () => {
		const installation = installationIdentity({
			hostname: 'testhost',
			productionDataDir: '/data/prod',
			mode: 'host',
			pid: 4242,
			startedAt: '2026-11-13T11:59:00.000Z',
		});
		const reference = { ...PROJECTED.reference, ...installation };
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			renewal: () => true,
			capabilities: ['registration_use'],
			operations: { registration_use: () => ({ ...PROJECTED, reference }) },
			now: () => NOW,
		});
		open.push(fake);
		const holder = { value: null as Anchor | null };
		const dataDir = path.join(root, 'host');
		fs.mkdirSync(dataDir);
		await createEnterpriseIdentityStore({
			file: path.join(dataDir, 'enterprise-identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => NOW,
		}).write({
			installationId: installation.installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: {
				socketPath: fake.socketPath,
				bindingDigest: 'a'.repeat(64),
				trustRootDigest: null,
			},
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
			enrolledAt: new Date(NOW).toISOString(),
		});
		const composed = composeHostManaged({
			openPort: (socketPath) => createLocalEndpointClient({ socketPath }),
			userDataDir: dataDir,
			version: '1.1.0',
			custody: { ok: true, seal: fakeSeal(), anchor: fakeAnchor(holder) },
			platform: 'darwin',
			now: () => NOW,
		});
		if (!composed.composed) throw new Error(composed.reason);
		closers.push(() => composed.lifecycle.close());
		composed.managed.host!(installation);

		await composed.lifecycle.attach();
		expect(composed.status()).toMatchObject({
			authority: 'registered',
			connection: { registration: 'registered' },
			identity: {
				record: { registration: { challengeId: 'chal-1', runtimeId: installation.runtimeId } },
			},
		});
		expect(operationsOn(fake, LOCAL_ENDPOINT_INVOKE_PATH)).not.toContain('registration_challenge');
	});
});
