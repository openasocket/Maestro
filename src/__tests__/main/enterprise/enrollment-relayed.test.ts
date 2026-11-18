/**
 * The relayed enrollment phases (decision D1) over the real client and the
 * fake daemon, with the identity store under injected custody. Each phase is
 * one `enrollment` operation on `/v2/invoke`; what is defended here is what
 * the four phases write and when:
 *
 * - a successful request, prove and activate end with the record enrolled;
 * - a denied reply writes nothing;
 * - a malformed reply writes nothing;
 * - activation before a prove is refused, and nothing is sent.
 *
 * `enrollment.test.ts` covers the same lifecycle with the wider authority
 * checks. This file pins the relay's write discipline on its own, so a change
 * to either one shows up here by name.
 *
 * The daemon is a double (`fakeEndpoint.ts`); no OS peer is authenticated and
 * no device key exists, so nothing here is paired enforcement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../shared/maestro-lib/managed/endpoint-client';
import {
	createEnrollmentLifecycle,
	type EnrollmentLifecycle,
} from '../../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	type EnterpriseIdentityStore,
} from '../../../main/enterprise/identity-store';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import {
	activatePhase,
	ENROLLMENT_ID,
	MANAGEMENT,
	provePhase,
	requestPhase,
	REQUEST_ID,
	SERVES_RELAYED_ENROLLMENT,
	TENANT_ID,
} from './enrollmentPhases';
import { startFakeEndpoint, type FakeEndpoint, type FakeEndpointOptions } from './fakeEndpoint';

const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};

describe('relayed enrollment phases', () => {
	let dir: string;
	let holder: { value: Anchor | null };
	let identity: EnterpriseIdentityStore;
	const open: FakeEndpoint[] = [];
	const lifecycles: EnrollmentLifecycle[] = [];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrollment-relayed-'));
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

	/** A fresh daemon with its own copy of the options, so one test's changes never reach another. */
	async function endpoint(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
		const fake = await startFakeEndpoint({ ...options });
		open.push(fake);
		return fake;
	}

	function lifecycle(): EnrollmentLifecycle {
		const created = createEnrollmentLifecycle({
			identity,
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

	it('a successful request, prove and activate end with the record enrolled', async () => {
		const fake = await endpoint(SERVES_RELAYED_ENROLLMENT);
		const life = lifecycle();

		expect(await life.requestEnrollment(requestPhase(fake.socketPath))).toMatchObject({
			status: 'ok',
			value: { outcome: 'enrollment_requested', requestId: REQUEST_ID },
		});
		expect(await life.requestEnrollment(provePhase(fake.socketPath))).toMatchObject({
			status: 'ok',
			value: { outcome: 'possession_signed', enrollmentId: ENROLLMENT_ID },
		});
		expect(await life.requestEnrollment(activatePhase(fake.socketPath))).toMatchObject({
			status: 'ok',
			value: { outcome: 'enrolled', enrollmentId: ENROLLMENT_ID },
		});
		expect(identity.read()).toMatchObject({
			status: 'ok',
			record: {
				tenantId: TENANT_ID,
				enrollmentId: ENROLLMENT_ID,
				management: 'enrolled',
			},
		});
	});

	it('a denied reply writes nothing', async () => {
		const fake = await endpoint({
			...SERVES_RELAYED_ENROLLMENT,
			operations: { enrollment: () => ({ outcome: 'denied', reason: 'invalid_request' }) },
		});
		const life = lifecycle();

		expect((await life.requestEnrollment(requestPhase(fake.socketPath))).status).toBe('denied');
		expect(identity.read()).toEqual({ status: 'none' });
	});

	it('a malformed reply writes nothing, whether it names another tenant or another outcome', async () => {
		const fake = await endpoint(SERVES_RELAYED_ENROLLMENT);
		const life = lifecycle();

		// Right phase, wrong management: the tenant is not the one asked for.
		fake.options.operations = {
			enrollment: (payload) => ({
				outcome: 'enrollment_requested',
				management: { ...(payload as { management: object }).management, tenantId: 'other' },
				requestId: REQUEST_ID,
				identity: {
					publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
					keyStorage: 'software',
				},
			}),
		};
		expect(await life.requestEnrollment(requestPhase(fake.socketPath))).toMatchObject({
			status: 'unavailable',
			reason: 'malformed',
		});

		// The outcome of a later phase, answered to the request.
		fake.options.operations = {
			enrollment: (payload) => ({
				outcome: 'enrolled',
				management: (payload as { management: unknown }).management,
				enrollmentId: ENROLLMENT_ID,
				keyStorage: 'software',
			}),
		};
		expect(await life.requestEnrollment(requestPhase(fake.socketPath))).toMatchObject({
			status: 'unavailable',
			reason: 'malformed',
		});

		expect(identity.read()).toEqual({ status: 'none' });
	});

	it('activation without a prior prove is refused, and nothing is sent', async () => {
		const fake = await endpoint({ ...SERVES_RELAYED_ENROLLMENT });
		const life = lifecycle();
		expect((await life.requestEnrollment(requestPhase(fake.socketPath))).status).toBe('ok');

		const before = fake.calls.length;
		expect(await life.requestEnrollment(activatePhase(fake.socketPath))).toMatchObject({
			status: 'refused',
			reason: 'not-enrolled',
		});
		expect(fake.calls).toHaveLength(before);
		expect(identity.read()).toMatchObject({
			status: 'ok',
			record: { enrollmentId: null, management: 'enrolling' },
		});
	});
});
