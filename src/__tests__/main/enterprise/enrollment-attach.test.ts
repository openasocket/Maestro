/**
 * The production attachment is ONE protocol 2 connection (handoff item 1,
 * contracts 0.3.0): the registration handshake (challenge, redeem), the v2
 * attachment and every operation after it share a socket, and no v1 envelope
 * is sent on any other path. The endpoint holds one protocol per socket session.
 *
 * What is defended: the attachment offers `registration_use`, the four
 * workflow custody verbs and the selected operations, with nothing required;
 * it asks for the `registration_use` reference itself when that was
 * negotiated; a subset offer still attaches, and an operation the attachment
 * did not negotiate is never sent.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * nothing here is paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
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
		'an endpoint that %s is reported, and nothing is retried on v1',
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
