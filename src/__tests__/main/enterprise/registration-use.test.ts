/**
 * The registration bootstrap over the real client, the fake daemon and an
 * identity store with injected custody. What is defended: the registration
 * record carries the approval's challenge digest, not the challenge id; the
 * v2 `registration_use` lookup sends nothing unless the v2 attachment
 * negotiated it; a projected reference writes `enrollmentId` and
 * `processBirthDigest` and keeps the rest of the registration; a denied or
 * malformed reply writes nothing; and a `processBirthDigest` that is not 64
 * lowercase hex is refused.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * nothing here is paired enforcement. Mega serves `registration_use` in its
 * phase 01; the 0.2.0 pinned contract does not list it.
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
import {
	LOCAL_ENDPOINT_INVOKE_V2_PATH,
	endpointRegistrationUseReplyProblems,
	type EndpointAttachmentRequestV2,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import { startFakeEndpoint, type FakeEndpoint, type FakeEndpointOptions } from './fakeEndpoint';

const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const SERVES_ENROLLMENT: FakeEndpointOptions = {
	capabilities: ['enrollment', 'telemetry'],
};
const ENROLL_INPUT = {
	tenantId: 'tenant-1',
	orgId: 'org-1',
	mode: 'attended' as const,
	invitation: 'invite-token',
	collectionProfile: 'metadata' as const,
	trustRootDigest: 'a'.repeat(64),
	keyPossessionProof: 'proof-from-endpoint-tooling',
};
const ATTACH_V2: EndpointAttachmentRequestV2 = {
	installationId: INSTALLATION.installationId,
	runtimeId: INSTALLATION.runtimeId,
	processEpoch: INSTALLATION.processEpoch,
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	supportedProtocols: [2],
	supportedCapabilities: ['attachment', 'compatibility', 'registration_use'],
	requiredCapabilities: [],
};
const ENROLLMENT_ID = '7f1c2a4e-5b6d-4e8f-9a0b-1c2d3e4f5a6b';
const BIRTH_DIGEST = 'b'.repeat(64);

function reference(overrides: Record<string, unknown> = {}) {
	return {
		version: 2,
		purpose: 'runtime_use',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: ENROLLMENT_ID,
		installationId: INSTALLATION.installationId,
		runtimeId: INSTALLATION.runtimeId,
		processEpoch: INSTALLATION.processEpoch,
		bindingDigest: 'a'.repeat(64),
		processBirthDigest: BIRTH_DIGEST,
		challengeId: 'chal-1',
		challengeDigest: 'c'.repeat(64),
		...overrides,
	};
}
const projected = (overrides: Record<string, unknown> = {}) => ({
	outcome: 'projected',
	reference: reference(overrides),
	expiresAt: '2026-11-13T12:00:00.000Z',
});

describe('registration bootstrap', () => {
	let dir: string;
	let holder: { value: Anchor | null };
	let identity: EnterpriseIdentityStore;
	const open: FakeEndpoint[] = [];
	const lifecycles: EnrollmentLifecycle[] = [];
	let ports: EndpointPort[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-use-'));
		holder = { value: null };
		ports = [];
		identity = createEnterpriseIdentityStore({
			file: path.join(dir, 'enterprise-identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
		});
	});
	afterEach(async () => {
		for (const lifecycle of lifecycles.splice(0)) await lifecycle.close();
		for (const fake of open.splice(0)) await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function endpoint(options: FakeEndpointOptions): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint(options);
		open.push(fake);
		return fake;
	}
	function lifecycle(): EnrollmentLifecycle {
		const created = createEnrollmentLifecycle({
			identity,
			openPort: (socketPath) => {
				const port = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
				ports.push(port);
				return port;
			},
			installation: INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: { supported: ['attachment', 'compatibility', 'enrollment'], required: [] },
		});
		lifecycles.push(created);
		return created;
	}

	/** Enroll, then challenge and redeem, so the record holds a registration. */
	async function enrolledAndRegistered(fake: FakeEndpoint) {
		const life = lifecycle();
		fake.options.operations = {
			...fake.options.operations,
			enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-1' }),
		};
		const enrolled = await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath });
		expect(enrolled.status).toBe('ok');
		const begun = await life.beginRegistration();
		expect(begun.status).toBe('ok');
		expect((await life.completeRegistration()).status).toBe('ok');
		expect(ports).toHaveLength(1);
		return { life, port: ports[0] };
	}

	function record() {
		const read = identity.read();
		expect(read.status).toBe('ok');
		if (read.status !== 'ok') throw new Error('no record');
		return read.record;
	}

	const v2Calls = (fake: FakeEndpoint) =>
		fake
			.callsTo(LOCAL_ENDPOINT_INVOKE_V2_PATH)
			.map((call) => (call.body as { operation: string }).operation);

	it('stores the approval challenge digest, not the challenge id, on the registration record', async () => {
		const fake = await endpoint(SERVES_ENROLLMENT);
		const life = lifecycle();
		fake.options.operations = {
			enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-1' }),
		};
		expect(
			(await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath })).status
		).toBe('ok');
		const begun = await life.beginRegistration();
		expect(begun.status).toBe('ok');
		if (begun.status !== 'ok') return;
		// The status pane sees the id and expiry, never the digest.
		expect(life.status().pendingApproval).toEqual({
			challengeId: begun.value.challengeId,
			expiresAt: begun.value.expiresAt,
		});
		expect((await life.completeRegistration()).status).toBe('ok');

		const registration = record().registration;
		expect(registration?.challengeDigest).toBe(begun.value.challengeDigest);
		expect(registration?.challengeDigest).toBe('c'.repeat(64));
		expect(registration?.challengeDigest).not.toBe(begun.value.challengeId);
		expect(registration?.challengeId).toBe(begun.value.challengeId);
		expect(registration?.processBirthDigest).toBeNull();
	});

	it('returns not-negotiated and sends nothing when the v2 attachment did not negotiate registration_use', async () => {
		const fake = await endpoint({ ...SERVES_ENROLLMENT, v2Capabilities: [] });
		const { life, port } = await enrolledAndRegistered(fake);
		const before = record();

		// No v2 attachment at all on this connection.
		const direct = await port.v2!.registration.use();
		expect(direct).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
		expect(v2Calls(fake)).toEqual([]);

		// A v2 attachment that did not select it.
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');
		expect(port.v2!.negotiated('registration_use')).toBe(false);
		const outcome = await life.useRegistration();
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'not-negotiated' });
		expect(v2Calls(fake)).toEqual(['attachment']);
		expect(record()).toEqual(before);
	});

	it('writes enrollmentId and processBirthDigest from a projected reply and keeps the other registration fields', async () => {
		let received: unknown = 'none';
		const fake = await endpoint({
			...SERVES_ENROLLMENT,
			v2Capabilities: ['registration_use'],
			operations: {
				registration_use: (payload) => {
					received = payload;
					return projected();
				},
			},
		});
		const { life, port } = await enrolledAndRegistered(fake);
		const before = record();
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');

		const outcome = await life.useRegistration();
		expect(outcome).toEqual({
			status: 'ok',
			value: {
				outcome: 'projected',
				enrollmentId: ENROLLMENT_ID,
				processBirthDigest: BIRTH_DIGEST,
				expiresAt: '2026-11-13T12:00:00.000Z',
			},
		});
		expect(received).toEqual({});
		expect(v2Calls(fake)).toEqual(['attachment', 'registration_use']);

		const after = record();
		expect(after.enrollmentId).toBe(ENROLLMENT_ID);
		expect(after.registration).toEqual({
			...before.registration,
			processBirthDigest: BIRTH_DIGEST,
		});
		expect(after.management).toBe(before.management);
		expect(after.endpoint).toEqual(before.endpoint);
	});

	it('writes nothing and returns the reason on a denied reply', async () => {
		const fake = await endpoint({
			...SERVES_ENROLLMENT,
			v2Capabilities: ['registration_use'],
			operations: {
				registration_use: () => ({ outcome: 'denied', reason: 'registration_not_found' }),
			},
		});
		const { life, port } = await enrolledAndRegistered(fake);
		const before = record();
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');

		const outcome = await life.useRegistration();
		expect(outcome).toEqual({
			status: 'ok',
			value: { outcome: 'denied', reason: 'registration_not_found' },
		});
		expect(record()).toEqual(before);
	});

	it('writes nothing and returns malformed on a reply that is not a registration_use answer', async () => {
		const fake = await endpoint({
			...SERVES_ENROLLMENT,
			v2Capabilities: ['registration_use'],
			operations: { registration_use: () => ({ outcome: 'projected', reference: null }) },
		});
		const { life, port } = await enrolledAndRegistered(fake);
		const before = record();
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');

		const outcome = await life.useRegistration();
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		expect(record()).toEqual(before);
	});

	it('refuses a processBirthDigest that is not 64 lowercase hex and writes nothing', async () => {
		const fake = await endpoint({
			...SERVES_ENROLLMENT,
			v2Capabilities: ['registration_use'],
			operations: {
				registration_use: () => projected({ processBirthDigest: 'B'.repeat(64) }),
			},
		});
		const { life, port } = await enrolledAndRegistered(fake);
		const before = record();
		expect((await port.v2!.attach(ATTACH_V2)).status).toBe('ok');

		const outcome = await life.useRegistration();
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (outcome.status === 'unavailable') expect(outcome.message).toMatch(/processBirthDigest/);
		expect(record()).toEqual(before);
	});

	describe('endpointRegistrationUseReplyProblems', () => {
		it('accepts a projected reference and a denial', () => {
			expect(endpointRegistrationUseReplyProblems(projected())).toEqual([]);
			expect(
				endpointRegistrationUseReplyProblems({ outcome: 'denied', reason: 'expired' })
			).toEqual([]);
		});

		it.each([
			['uppercase hex', 'B'.repeat(64)],
			['63 characters', 'b'.repeat(63)],
			['65 characters', 'b'.repeat(65)],
			['not hex', 'z'.repeat(64)],
			['a number', 42],
		])('refuses a processBirthDigest that is %s', (_label, value) => {
			expect(
				endpointRegistrationUseReplyProblems(projected({ processBirthDigest: value }))
			).toContain('processBirthDigest is not a digest');
		});

		it('refuses an empty or missing enrollmentId', () => {
			expect(endpointRegistrationUseReplyProblems(projected({ enrollmentId: '' }))).toContain(
				'enrollmentId is not an id'
			);
			expect(
				endpointRegistrationUseReplyProblems(projected({ enrollmentId: undefined }))
			).toContain('enrollmentId is not an id');
		});

		it('refuses a denial without a reason and an unknown outcome', () => {
			expect(endpointRegistrationUseReplyProblems({ outcome: 'denied' })).not.toEqual([]);
			expect(endpointRegistrationUseReplyProblems({ outcome: 'other' })).not.toEqual([]);
			expect(endpointRegistrationUseReplyProblems(null)).not.toEqual([]);
		});
	});
});
