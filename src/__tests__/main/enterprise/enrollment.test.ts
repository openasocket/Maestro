/**
 * The enrollment lifecycle over the real client, the fake daemon and an
 * identity store with injected custody. What is defended: nothing is written
 * unless the endpoint answered; an endpoint that does not serve enrollment
 * is reported `unsupported` with its owner; the actor registration is a
 * challenge handed to the caller and a redeem on the same connection;
 * `authority` is `registered` only when every fact agrees; and losing the
 * endpoint, or hearing `unenrolled` from it, never removes the record.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * no device key exists, so nothing here is paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import {
	createEnrollmentLifecycle,
	managementFromEndpoint,
	type EnrollmentLifecycle,
} from '../../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	type EnterpriseIdentityStore,
} from '../../../main/enterprise/identity-store';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import { startFakeEndpoint, type FakeEndpoint, type FakeEndpointOptions } from './fakeEndpoint';

const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
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
const SERVES_ENROLLMENT: FakeEndpointOptions = {
	capabilities: ['enrollment', 'telemetry', 'execution'],
	operations: { enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-1' }) },
};

describe('enrollment lifecycle', () => {
	let dir: string;
	let holder: { value: Anchor | null };
	let identity: EnterpriseIdentityStore;
	const open: FakeEndpoint[] = [];
	const lifecycles: EnrollmentLifecycle[] = [];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrollment-'));
		holder = { value: null };
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

	async function endpoint(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint(options);
		open.push(fake);
		return fake;
	}
	function lifecycle(store: EnterpriseIdentityStore = identity): EnrollmentLifecycle {
		const created = createEnrollmentLifecycle({
			identity: store,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
			installation: INSTALLATION,
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: {
				supported: ['attachment', 'compatibility', 'enrollment', 'telemetry', 'execution'],
				required: [],
			},
		});
		lifecycles.push(created);
		return created;
	}
	/** Challenge, "approve in the browser", redeem. */
	async function register(life: EnrollmentLifecycle) {
		const begun = await life.beginRegistration();
		expect(begun.status).toBe('ok');
		if (begun.status === 'ok') expect(begun.value.nonce).toHaveLength(43);
		expect(life.status().pendingApproval?.challengeId).toBeTruthy();
		const done = await life.completeRegistration();
		expect(done.status).toBe('ok');
		return done;
	}

	it('answers unsupported, with the owner, when the endpoint does not serve enrollment, and writes nothing', async () => {
		const fake = await endpoint();
		const life = lifecycle();
		const outcome = await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath });
		expect(outcome).toMatchObject({ status: 'unsupported', owner: 'mega-maestro' });
		if (outcome.status === 'unsupported') expect(outcome.message).toMatch(/CP-04/);
		expect(identity.read()).toEqual({ status: 'none' });
		expect(fake.calls.map((c) => (c.body as { operation: string }).operation)).toEqual([
			'compatibility',
		]);
	});

	it('records an enrolling identity when the endpoint accepts the enrollment request', async () => {
		const fake = await endpoint(SERVES_ENROLLMENT);
		const life = lifecycle();
		const outcome = await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath });
		expect(outcome).toEqual({
			status: 'ok',
			value: { outcome: 'enrollment_pending', enrollmentId: 'enr-1' },
		});
		const read = identity.read();
		expect(read.status).toBe('ok');
		if (read.status === 'ok') {
			expect(read.record).toMatchObject({
				installationId: 'inst-1',
				tenantId: 'tenant-1',
				enrollmentId: 'enr-1',
				management: 'enrolling',
				endpoint: { socketPath: fake.socketPath },
				registration: null,
			});
		}
		expect(life.status().authority).toBe('none');
		const sent = fake.calls.find(
			(c) => (c.body as { operation: string }).operation === 'enrollment'
		);
		expect((sent?.body as { payload: unknown }).payload).toEqual({
			mode: 'attended',
			invitation: 'invite-token',
			collectionProfile: 'metadata',
			trustRootDigest: 'a'.repeat(64),
			keyPossessionProof: 'proof-from-endpoint-tooling',
		});
	});

	it('refuses to enroll twice, and refuses while custody is unprotected or untrusted, writing nothing', async () => {
		const fake = await endpoint(SERVES_ENROLLMENT);
		const life = lifecycle();
		expect(
			(await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath })).status
		).toBe('ok');
		expect(
			await life.requestEnrollment({ ...ENROLL_INPUT, socketPath: fake.socketPath })
		).toMatchObject({
			status: 'refused',
			reason: 'already-enrolled',
		});

		const unprotected = createEnterpriseIdentityStore({
			file: path.join(dir, 'other.bin'),
			seal: fakeSeal({ custody: { kind: 'obscuring' } }),
			anchor: fakeAnchor({ value: null }),
		});
		const calls = fake.calls.length;
		expect(
			await lifecycle(unprotected).requestEnrollment({
				...ENROLL_INPUT,
				socketPath: fake.socketPath,
			})
		).toMatchObject({ status: 'refused', reason: 'custody-unprotected' });
		expect(fake.calls).toHaveLength(calls);
		expect(fs.existsSync(path.join(dir, 'other.bin'))).toBe(false);

		// A rolled-back file: the anchor moved on, the file did not.
		const anchorHolder = { value: null as Anchor | null };
		const rolled = createEnterpriseIdentityStore({
			file: path.join(dir, 'rolled.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor(anchorHolder),
		});
		await rolled.write({ ...ENROLL_INPUT_RECORD(fake.socketPath) });
		const older = fs.readFileSync(path.join(dir, 'rolled.bin'));
		await rolled.write({ ...ENROLL_INPUT_RECORD(fake.socketPath), management: 'enrolled' });
		fs.writeFileSync(path.join(dir, 'rolled.bin'), older);
		expect(rolled.read()).toMatchObject({ status: 'untrusted', reason: 'rollback' });
		expect(await lifecycle(rolled).connect()).toMatchObject({
			status: 'refused',
			reason: 'custody-untrusted',
		});
		expect(rolled.read()).toMatchObject({ status: 'untrusted', reason: 'rollback' });
	});

	it('registers the actor on one connection and reaches registered authority only once the endpoint says managed', async () => {
		const fake = await endpoint({ ...SERVES_ENROLLMENT, registrationRequired: true });
		const life = lifecycle();
		await identity.write(ENROLL_INPUT_RECORD(fake.socketPath, 'enrolled'));

		// Before a registration the endpoint refuses the attachment; the record stays.
		expect(await life.connect()).toEqual({
			status: 'denied',
			reason: 'unauthenticated',
			operation: 'attachment',
		});
		expect(life.status()).toMatchObject({
			authority: 'none',
			lastDenial: { operation: 'attachment' },
		});
		expect(identity.read().status).toBe('ok');

		expect(await life.completeRegistration()).toMatchObject({
			status: 'refused',
			reason: 'no-challenge',
		});
		await register(life);
		const status = life.status();
		expect(status.authority).toBe('registered');
		expect(status.reason).toBeNull();
		expect(status.pendingApproval).toBeNull();
		expect(status.endpoint?.management).toBe('managed');
		const read = identity.read();
		if (read.status === 'ok') {
			expect(read.record.registration).toMatchObject({
				runtimeId: 'desktop-100',
				processEpoch: 'epoch-1',
				actorId: null,
			});
			expect(read.record.policy).toMatchObject({ desiredRevision: 3, appliedRevision: 3 });
			expect(JSON.stringify(read.record)).not.toContain('n'.repeat(43));
		}
		expect(fs.readFileSync(path.join(dir, 'enterprise-identity.bin'), 'utf8')).not.toContain(
			'n'.repeat(43)
		);
	});

	it('an endpoint that answers suspended or unenrolled never removes the record; losing it drops authority only', async () => {
		const fake = await endpoint({ ...SERVES_ENROLLMENT, registrationRequired: true });
		const life = lifecycle();
		await identity.write(ENROLL_INPUT_RECORD(fake.socketPath, 'enrolled'));
		await register(life);
		expect(life.status().authority).toBe('registered');

		fake.options.status = { management: 'suspended' };
		expect((await life.connect()).status).toBe('ok');
		expect(life.status()).toMatchObject({
			authority: 'none',
			reason: expect.stringContaining('suspended'),
		});
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'suspended' } });

		fake.options.status = { management: 'managed' };
		expect((await life.connect()).status).toBe('ok');
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'enrolled' } });

		fake.options.status = { management: 'unenrolled' };
		expect((await life.connect()).status).toBe('ok');
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'enrolled' } });
		expect(life.status()).toMatchObject({
			authority: 'none',
			reason: expect.stringContaining('unenrolled'),
		});

		fake.options.status = {};
		fake.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(life.status()).toMatchObject({
			authority: 'none',
			reason: expect.stringContaining('not attached'),
		});
		expect(identity.read().status).toBe('ok');

		await fake.close();
		open.splice(open.indexOf(fake), 1);
		expect((await life.connect()).status).toBe('unavailable');
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'enrolled' } });
	});

	it('rotation, revocation and retirement are requests the protocol cannot carry; the local transitions are explicit', async () => {
		const fake = await endpoint(SERVES_ENROLLMENT);
		const life = lifecycle();
		for (const outcome of [
			await life.requestRotation(),
			await life.requestRevocation(),
			await life.requestRetirement(),
		]) {
			expect(outcome).toMatchObject({ status: 'unsupported', owner: 'mega-maestro' });
		}
		expect(await life.retire({ installationId: 'inst-1' })).toMatchObject({
			status: 'refused',
			reason: 'not-enrolled',
		});
		await identity.write(ENROLL_INPUT_RECORD(fake.socketPath, 'enrolled'));
		expect(await life.acknowledgeRevocation({ installationId: 'someone-else' })).toMatchObject({
			status: 'refused',
			reason: 'installation-mismatch',
		});
		expect(await life.acknowledgeRevocation({ installationId: 'inst-1' })).toEqual({
			status: 'ok',
			value: 'revoked',
		});
		expect(identity.read()).toMatchObject({
			status: 'ok',
			record: { management: 'revoked', registration: null },
		});
		// A revoked record is final for the endpoint's answers.
		expect((await life.connect()).status).toBe('ok');
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'revoked' } });
		expect(life.status().authority).toBe('none');
	});

	it('managementFromEndpoint keeps a completed record through unenrolled and enrolling answers', () => {
		expect(managementFromEndpoint('managed', 'enrolling')).toBe('enrolled');
		expect(managementFromEndpoint('managed', 'suspended')).toBe('enrolled');
		expect(managementFromEndpoint('suspended', 'enrolled')).toBe('suspended');
		expect(managementFromEndpoint('unenrolled', 'enrolled')).toBe('enrolled');
		expect(managementFromEndpoint('enrolling', 'enrolled')).toBe('enrolled');
		expect(managementFromEndpoint('enrolling', 'enrolling')).toBe('enrolling');
		expect(managementFromEndpoint('managed', 'revoked')).toBe('revoked');
		expect(managementFromEndpoint('managed', 'retired')).toBe('retired');
	});
});

function ENROLL_INPUT_RECORD(
	socketPath: string,
	management: 'enrolling' | 'enrolled' = 'enrolling'
) {
	return {
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: 'enr-1',
		endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: 'a'.repeat(64) },
		management,
		registration: null,
		policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
		enrolledAt: '2026-10-21T12:00:00.000Z',
	};
}
