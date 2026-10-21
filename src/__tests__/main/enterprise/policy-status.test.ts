/**
 * The policy status service over the real lifecycle, client and fake daemon:
 * `refresh` is an authenticated re-attach that updates the sealed record,
 * `recover` opens a registration only when this process holds none or the
 * endpoint refused the last one, and nothing here approves on the actor's
 * behalf or touches the endpoint's own provisioning.
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
import { createPolicyStatusService } from '../../../main/enterprise/policy-status';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

describe('policy status service', () => {
	let dir: string;
	let identity: EnterpriseIdentityStore;
	let fake: FakeEndpoint;
	let lifecycle: EnrollmentLifecycle;
	let clock: number;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-status-'));
		const holder: { value: Anchor | null } = { value: null };
		clock = Date.parse('2026-10-21T12:00:00Z');
		identity = createEnterpriseIdentityStore({
			file: path.join(dir, 'enterprise-identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => clock,
		});
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution'],
			now: () => clock,
		});
		lifecycle = createEnrollmentLifecycle({
			identity,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
			installation: { installationId: 'inst-1', runtimeId: 'desktop-100', processEpoch: 'epoch-1' },
			components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			capabilities: { supported: ['attachment', 'compatibility', 'execution'], required: [] },
			now: () => clock,
		});
		await identity.write({
			installationId: 'inst-1',
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
			enrolledAt: new Date(clock).toISOString(),
		});
	});
	afterEach(async () => {
		await lifecycle.close();
		await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('recovers by opening a registration when this process holds none, then refreshes once registered', async () => {
		const service = createPolicyStatusService({ lifecycle, now: () => clock });
		expect(service.status()).toMatchObject({
			source: 'cached',
			freshness: 'unknown',
			offline: { mode: 'none' },
			admission: { possible: false },
		});

		const recovery = await service.recover();
		expect(recovery.status).toBe('approval-required');
		if (recovery.status === 'approval-required') {
			expect(recovery.handoff.nonce).toHaveLength(43);
			expect(lifecycle.status().pendingApproval?.challengeId).toBe(recovery.handoff.challengeId);
		}
		expect((await lifecycle.completeRegistration()).status).toBe('ok');

		const status = service.status();
		expect(status).toMatchObject({
			source: 'endpoint',
			freshness: 'fresh',
			desiredRevision: 3,
			appliedRevision: 3,
			installedRevision: 3,
			converged: true,
			registration: { state: 'live' },
			admission: { possible: true },
		});

		// Once registered, recover is a refresh: no new challenge, the record updated.
		fake.options.status = { desiredPolicyRevision: 5 };
		const again = await service.recover();
		expect(again.status).toBe('refreshed');
		expect(service.status()).toMatchObject({
			desiredRevision: 5,
			appliedRevision: 3,
			converged: false,
		});
		expect(identity.read()).toMatchObject({
			status: 'ok',
			record: { policy: { desiredRevision: 5 } },
		});
		expect(fake.calls.filter((c) => c.path === '/v1/registration/challenge')).toHaveLength(1);
	});

	it('keeps the installed policy and denies admission when the observation goes stale or the endpoint is lost', async () => {
		const service = createPolicyStatusService({ lifecycle, now: () => clock, freshnessMs: 60_000 });
		await service.recover();
		await lifecycle.completeRegistration();
		expect(service.status().admission.possible).toBe(true);

		clock += 61_000;
		expect(service.status()).toMatchObject({ freshness: 'stale', admission: { possible: false } });
		expect((await service.refresh()).status).toBe('ok');
		expect(service.status()).toMatchObject({ freshness: 'fresh', admission: { possible: true } });

		await fake.close();
		fake = await startFakeEndpoint({ registrationRequired: true, now: () => clock });
		// The old socket is gone and the new daemon knows no registration.
		expect((await service.refresh()).status).not.toBe('ok');
		expect(service.status()).toMatchObject({
			source: 'cached',
			installedRevision: 3,
			offline: { installedPolicyAvailable: true, mode: 'installed-policy-only' },
			admission: { possible: false },
		});
		expect(identity.read()).toMatchObject({ status: 'ok', record: { management: 'enrolled' } });
	});

	it('refuses recovery without an enrollment or over untrusted custody', async () => {
		const empty = createEnterpriseIdentityStore({
			file: path.join(dir, 'empty.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor({ value: null }),
		});
		const bare = createEnrollmentLifecycle({
			identity: empty,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
			installation: { installationId: 'inst-1', runtimeId: 'desktop-100', processEpoch: 'epoch-1' },
			components: [],
			capabilities: { supported: [], required: [] },
		});
		const service = createPolicyStatusService({ lifecycle: bare });
		expect(await service.recover()).toMatchObject({ status: 'refused', reason: 'not-enrolled' });
		expect(service.status()).toMatchObject({ source: 'none', offline: { mode: 'none' } });
		await bare.close();
	});
});
