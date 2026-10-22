/**
 * The detached host's managed standing (MRC-08-04C) over injected custody. What is defended: a
 * plain Node process (no seal) composes nothing and names the missing primitive, with the anchor
 * never consulted; an unprotected or obscuring seal is refused by the identity store's own rule;
 * with protected custody the host composes the same parts the desktop does over the data
 * directory's sealed record, the adapter reads that record, `attach` re-attaches only an enrolled
 * record, and `close` drops the socket. Nothing here touches the developer's keyring.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	composeHostManaged,
	HOST_ANCHOR_UNAVAILABLE_REASON,
	HOST_SEAL_UNAVAILABLE_REASON,
	resolveHostCustody,
	type HostCustodyRead,
} from '../../../cli/services/host-managed';
import { createEnterpriseIdentityStore } from '../../../main/enterprise/identity-store';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import { installationIdentity } from '../../../shared/maestro-lib';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import { startFakeEndpoint, type FakeEndpoint } from '../../main/enterprise/fakeEndpoint';

const NOW = Date.parse('2026-10-22T12:00:00Z');

describe('resolveHostCustody', () => {
	it('is refused by name in a plain Node process, before the anchor is consulted', () => {
		const anchor = fakeAnchor({ value: null });
		const available = vi.spyOn(anchor, 'available');
		const read = resolveHostCustody({ userDataDir: '/tmp/x', anchor });
		expect(read).toEqual({ ok: false, reason: HOST_SEAL_UNAVAILABLE_REASON });
		expect(available).not.toHaveBeenCalled();
	});

	it('refuses a seal the identity store would refuse: no encryption, the obscuring key, basic_text', () => {
		const anchor = fakeAnchor({ value: null });
		const none = resolveHostCustody({
			userDataDir: '/tmp/x',
			seal: fakeSeal({ available: false }),
			anchor,
		});
		expect(none.ok).toBe(false);
		expect(!none.ok && none.reason).toContain('no encryption');
		const obscuring = resolveHostCustody({ userDataDir: '/tmp/x', seal: obscuringSeal(), anchor });
		expect(!obscuring.ok && obscuring.reason).toContain('not credential protection');
		const basic = resolveHostCustody({
			userDataDir: '/tmp/x',
			seal: fakeSeal({ custody: { kind: 'os-keystore', backend: 'basic_text' } }),
			anchor,
			platform: 'linux',
		});
		expect(!basic.ok && basic.reason).toContain('basic_text');
	});

	it('refuses when no credential store holds the anchor, and accepts protected custody', () => {
		const seal = fakeSeal();
		const missing = resolveHostCustody({
			userDataDir: '/tmp/x',
			seal,
			anchor: fakeAnchor({ value: null }, { available: false }),
		});
		expect(missing).toEqual({ ok: false, reason: HOST_ANCHOR_UNAVAILABLE_REASON });
		const anchor = fakeAnchor({ value: null });
		expect(resolveHostCustody({ userDataDir: '/tmp/x', seal, anchor })).toEqual({
			ok: true,
			seal,
			anchor,
		});
	});
});

describe('composeHostManaged', () => {
	let dir: string;
	let holder: { value: Anchor | null };
	let fake: FakeEndpoint | undefined;

	const installation = installationIdentity({
		hostname: 'testhost',
		productionDataDir: '/data/prod',
		mode: 'host',
		pid: 4242,
		startedAt: '2026-10-22T11:59:00.000Z',
	});
	const custody = (): HostCustodyRead => ({
		ok: true,
		seal: fakeSeal(),
		anchor: fakeAnchor(holder),
	});

	/** An enrollment record sealed on the data directory, the way the desktop would have left it. */
	async function enroll(socketPath: string): Promise<void> {
		const store = createEnterpriseIdentityStore({
			file: path.join(dir, 'enterprise-identity.bin'),
			seal: fakeSeal(),
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => NOW,
		});
		await store.write({
			installationId: installation.installationId,
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: { socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
			management: 'enrolled',
			registration: null,
			policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
			enrolledAt: new Date(NOW).toISOString(),
		});
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-managed-'));
		holder = { value: null };
	});
	afterEach(async () => {
		await fake?.close();
		fake = undefined;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('composes nothing in a plain Node process and says whether a record is present', async () => {
		const absent = composeHostManaged({ userDataDir: dir, version: '1.1.0' });
		expect(absent.composed).toBe(false);
		if (absent.composed) throw new Error('unreachable');
		expect(absent.reason).toContain(HOST_SEAL_UNAVAILABLE_REASON);
		expect(absent.reason).toContain('No enrollment record is present');

		await enroll('/tmp/endpoint.sock');
		const present = composeHostManaged({ userDataDir: dir, version: '1.1.0' });
		if (present.composed) throw new Error('unreachable');
		expect(present.reason).toContain(HOST_SEAL_UNAVAILABLE_REASON);
		expect(present.reason).toContain('cannot be opened here');
		expect(present.reason).toContain('enrolled-unavailable');
		// The record is left exactly where it was.
		expect(fs.existsSync(path.join(dir, 'enterprise-identity.bin'))).toBe(true);
	});

	it('passes a refused custody through by its own reason', () => {
		const refused = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: { ok: false, reason: 'the seal is not protected custody: basic_text' },
		});
		expect(refused).toMatchObject({
			composed: false,
			reason: expect.stringContaining('basic_text'),
		});
	});

	it('over protected custody builds the adapter on the sealed record for the installation the runtime names', async () => {
		await enroll('/tmp/endpoint.sock');
		const standing = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: custody(),
			platform: 'darwin',
			now: () => NOW,
		});
		expect(standing.composed).toBe(true);
		if (!standing.composed) throw new Error('unreachable');
		// Nothing has asked for the adapter yet: no lifecycle, no standing.
		expect(standing.status()).toBeNull();
		expect(standing.identity.read()).toMatchObject({
			status: 'ok',
			record: { tenantId: 'tenant-1' },
		});

		const adapter = standing.managed.host!(installation);
		expect(adapter.installation).toBe(installation);
		expect(adapter.identity.read()).toMatchObject({
			status: 'ok',
			record: { installationId: installation.installationId, orgId: 'org-1' },
		});
		expect(adapter.authority.authorityId).toMatch(/^endpoint-/);
		expect(adapter.policy()).toMatchObject({ policyRevision: 2 });
		expect(standing.status()).toMatchObject({ authority: 'none', connection: null });
	});

	it('does not dial for an unenrolled directory, re-attaches an enrolled record, and closes the socket', async () => {
		const openPort = vi.fn();
		const unenrolled = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: custody(),
			platform: 'darwin',
			openPort,
		});
		if (!unenrolled.composed) throw new Error('unreachable');
		// Attach before any adapter exists, and with no record: nothing is opened either way.
		await unenrolled.lifecycle.attach();
		unenrolled.managed.host!(installation);
		await unenrolled.lifecycle.attach();
		expect(openPort).not.toHaveBeenCalled();
		expect(unenrolled.status()).toMatchObject({ authority: 'none', identity: { status: 'none' } });
		await unenrolled.lifecycle.close();

		fake = await startFakeEndpoint({ capabilities: ['execution'], now: () => NOW });
		await enroll(fake.socketPath);
		const enrolled = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: custody(),
			platform: 'darwin',
			now: () => NOW,
		});
		if (!enrolled.composed) throw new Error('unreachable');
		const adapter = enrolled.managed.host!(installation);
		await enrolled.lifecycle.attach();
		const status = enrolled.status();
		expect(status?.connection).toMatchObject({ attached: true });
		expect(status?.endpoint).not.toBeNull();
		// The fake's registration gate is off, but authority is still this process's own registration.
		expect(status?.authority).toBe('none');
		expect(fake.calls.some((call) => call.path === '/v1/invoke')).toBe(true);
		// The adapter speaks over the socket the lifecycle opened.
		expect(adapter.workflows).not.toBeNull();

		await enrolled.lifecycle.close();
		expect(enrolled.status()).toMatchObject({ authority: 'none', connection: null });
		expect(enrolled.identity.read()).toMatchObject({ status: 'ok' });
	});
});
