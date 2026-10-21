/**
 * The desktop's enterprise service composition, with Electron's `safeStorage`
 * and the keyring anchor replaced by injected fakes. What is defended: an
 * unenrolled desktop never touches the credential store at start, an
 * enrolled one re-attaches at start and keeps its record when the endpoint
 * is away, the host adapter's authority is the lifecycle's standing, and
 * close drops the socket and nothing else.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { createEnterpriseService, type EnterpriseService } from '../../../main/enterprise/service';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { fakeAnchor, fakeSeal } from './fakeCustody';
import { startFakeEndpoint, type FakeEndpoint } from './fakeEndpoint';

const NOW = Date.parse('2026-10-21T12:00:00Z');

describe('enterprise service', () => {
	let dir: string;
	let holder: { value: Anchor | null };
	let fake: FakeEndpoint;
	const services: EnterpriseService[] = [];

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enterprise-service-'));
		holder = { value: null };
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution'],
			now: () => NOW,
		});
	});
	afterEach(async () => {
		for (const service of services.splice(0)) await service.close();
		await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function compose(anchor = fakeAnchor(holder)) {
		const seal = fakeSeal();
		const service = createEnterpriseService({
			userDataDir: dir,
			productionDataDir: dir,
			hostname: 'testhost',
			pid: 4242,
			startedAt: '2026-10-21T11:59:00.000Z',
			appVersion: '1.1.0-RC',
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (text) => seal.seal(text),
				decryptString: (blob) => seal.unseal(blob),
				getSelectedStorageBackend: () => 'keychain',
			},
			anchor,
			platform: 'darwin',
			now: () => NOW,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
		});
		services.push(service);
		return service;
	}

	it('derives the installation identity and composes every part without touching the keyring when unenrolled', async () => {
		const anchor = fakeAnchor(holder);
		const available = vi.spyOn(anchor, 'available');
		const read = vi.spyOn(anchor, 'read');
		const service = compose(anchor);
		expect(service.installation.runtimeId).toBe('desktop-4242');
		expect(service.installation.processEpoch).toMatch(/^[a-f0-9]{32}$/);
		await service.start();
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			identity: { status: 'none' },
		});
		expect(service.policy.status()).toMatchObject({ source: 'none' });
		expect(service.host.authority.authorityId).toBe('unavailable');
		// The Cue port is the same enrollment seen from the Cue run router (MRC-07-02A).
		expect(service.cueSpawnAuthority.standing()).toBe('standalone');
		expect(service.cueSpawnAuthority.authority).toBe(service.spawnAuthority.authority);
		expect(fake.calls).toHaveLength(0);
		// `identity.read()` ran once for the start check and once per status; the file
		// does not exist, so custody was consulted but the anchor was never read.
		expect(available).toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});

	it('re-attaches an enrolled installation at start and reaches registered authority after the actor approves', async () => {
		const service = compose();
		await service.identity.write({
			installationId: service.installation.installationId,
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
		await service.start();
		// The endpoint wants a registration first: the attachment was refused, the record kept.
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			lastDenial: { operation: 'attachment', reason: 'unauthenticated' },
		});
		expect(service.identity.read()).toMatchObject({
			status: 'ok',
			record: { management: 'enrolled' },
		});
		expect(service.host.authority.authorityId).toMatch(/^endpoint-/);

		const recovery = await service.policy.recover();
		expect(recovery.status).toBe('approval-required');
		expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
		const standing = service.lifecycle.status();
		expect(standing.authority).toBe('registered');
		expect(standing.connection).toMatchObject({ registration: 'registered', attached: true });
		expect(service.policy.status()).toMatchObject({
			source: 'endpoint',
			admission: { possible: true },
		});
		expect(service.host.policy()).toMatchObject({ policyRevision: 3 });

		await service.close();
		services.splice(0);
		expect(service.lifecycle.status()).toMatchObject({ authority: 'none', connection: null });
		expect(service.identity.read()).toMatchObject({
			status: 'ok',
			record: { management: 'enrolled' },
		});
	});

	it('a second desktop start on the same data directory finds the record and a new process epoch', async () => {
		const first = compose();
		await first.identity.write({
			installationId: first.installation.installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: null,
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
		await first.close();
		services.splice(0);
		const second = createEnterpriseService({
			userDataDir: dir,
			productionDataDir: dir,
			hostname: 'testhost',
			pid: 4343,
			startedAt: '2026-10-21T12:30:00.000Z',
			appVersion: '1.1.0-RC',
			safeStorage: {
				isEncryptionAvailable: () => true,
				encryptString: (text) => fakeSeal().seal(text),
				decryptString: (blob) => fakeSeal().unseal(blob),
			},
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => NOW + 60_000,
		});
		services.push(second);
		expect(second.installation.installationId).toBe(first.installation.installationId);
		expect(second.installation.processEpoch).not.toBe(first.installation.processEpoch);
		expect(second.identity.read()).toMatchObject({
			status: 'ok',
			record: { management: 'enrolled' },
		});
		expect(second.host.authority.authorityId).toBe(first.host.authority.authorityId);
	});
});
