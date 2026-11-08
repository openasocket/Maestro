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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPin } from '../../../../scripts/import-mega-maestro.mjs';
import { inspectContractsDir } from '../../../../scripts/check-mega-contract-vectors.mjs';

import {
	composeHostManaged,
	createHeldHostAdapter,
	createHostInstallationStanding,
	HOST_ANCHOR_UNAVAILABLE_REASON,
	HOST_SEAL_UNAVAILABLE_REASON,
	resolveHostCustody,
	type HostCustodyRead,
} from '../../../cli/services/host-managed';
import { createEnterpriseIdentityStore } from '../../../main/enterprise/identity-store';
import { obscuringSeal } from '../../../main/utils/safe-storage-seal';
import type { Anchor, AnchorStore } from '../../../main/utils/keyring-anchor';
import {
	bindingEnrollment,
	createLocalHostAuthority,
	createManagedBinding,
	installationIdentity,
	managedAuthorityId,
	type ManagedIdentityRecord,
	type InstallationStanding,
	type InstallationStandingSource,
} from '../../../shared/maestro-lib';
import {
	buildDispatchSnapshot,
	createContextVerifier,
} from '../../../shared/maestro-lib/managed/authority';
import { inProcessContext } from '../../../shared/maestro-lib/managed/operations';
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

	let endpointSchemas: typeof import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
	beforeAll(async () => {
		const pin = readPin(path.resolve('vendor/mega-maestro/contracts.pin.json'));
		const checked = inspectContractsDir({
			contractsDir: path.resolve('vendor/mega-maestro/contracts'),
			expectedSha256: pin.payloadDigest,
		});
		expect(checked.sourceRevision).toBe(pin.sourceRevision);
		endpointSchemas =
			await import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
	});

	it('registers, refreshes policy, reconnects and closes through the composed controls (local contract fixture)', async () => {
		fake = await startFakeEndpoint({ registrationRequired: true, now: () => NOW });
		await enroll(fake.socketPath);
		const composed = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: custody(),
			now: () => NOW,
		});
		if (!composed.composed) throw new Error(composed.reason);
		expect(await composed.control.connect()).toMatchObject({ status: 'unavailable' });
		expect(fake.calls).toHaveLength(0);
		const adapter = composed.managed.host!(installation);
		expect(composed.managed.host!(installation)).toBe(adapter);
		expect(() => composed.managed.host!({ ...installation, processEpoch: 'another' })).toThrow(
			'one runtime'
		);
		await composed.lifecycle.attach();
		expect(composed.status()?.authority).toBe('none');
		const approval = await composed.control.beginRegistration();
		expect(approval.status).toBe('ok');
		if (approval.status !== 'ok') throw new Error('No approval');
		expect(JSON.stringify(composed.status())).not.toContain(approval.value.nonce);
		expect(await composed.control.completeRegistration()).toMatchObject({ status: 'ok' });
		expect(composed.status()?.authority).toBe('registered');
		expect(fs.readFileSync(path.join(dir, 'enterprise-identity.bin'), 'utf8')).not.toContain(
			approval.value.nonce
		);

		fake.options.status = { desiredPolicyRevision: 9, appliedPolicyRevision: 9 };
		expect(await composed.control.connect()).toMatchObject({ status: 'ok' });
		expect(adapter.policy().policyRevision).toBe(9);
		fake.dropConnections();
		fake.revokeRegistration();
		expect(await composed.control.connect()).toMatchObject({
			status: 'denied',
			reason: 'unauthenticated',
		});
		expect(composed.status()?.authority).toBe('none');
		fake.options.peerAuthenticated = false;
		expect(await composed.control.beginRegistration()).toMatchObject({ status: 'denied' });
		fake.options.peerAuthenticated = true;
		expect(await composed.control.beginRegistration()).toMatchObject({ status: 'ok' });
		expect(await composed.control.completeRegistration()).toMatchObject({ status: 'ok' });
		expect(composed.status()?.authority).toBe('registered');
		for (const call of fake.calls.filter((c) => c.path === '/v1/invoke')) {
			const envelope = endpointSchemas.localRequestEnvelope.parse(call.body);
			if (envelope.operation === 'attachment')
				endpointSchemas.attachmentRequest.parse(envelope.payload);
		}
		endpointSchemas.endpointStatus.parse(composed.status()!.endpoint);
		const calls = fake.calls.length;
		const closing = composed.lifecycle.close();
		expect(adapter.status().authority).toBe('none');
		expect(adapter.telemetry).toBeNull();
		expect(await composed.control.connect()).toMatchObject({ status: 'unavailable' });
		await closing;
		await composed.lifecycle.attach();
		await composed.lifecycle.close();
		expect(composed.status()?.authority).toBe('none');
		expect(adapter.telemetry).toBeNull();
		expect(fake.calls).toHaveLength(calls);
		expect(() => composed.managed.host!(installation)).toThrow('closed');
		expect(composed.standing.read().standing).toBe('managed');
	});

	it('relays supported enrollment without promoting the pending record to authority', async () => {
		fake = await startFakeEndpoint({
			capabilities: ['enrollment'],
			now: () => NOW,
			operations: {
				enrollment: () => ({ outcome: 'enrollment_pending', enrollmentId: 'enr-local' }),
			},
		});
		const composed = composeHostManaged({
			userDataDir: dir,
			version: '1.1.0',
			custody: custody(),
			now: () => NOW,
		});
		if (!composed.composed) throw new Error(composed.reason);
		composed.managed.host!(installation);
		try {
			const result = await composed.control.requestEnrollment({
				socketPath: fake.socketPath,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				mode: 'attended',
				invitation: 'fixture-invitation',
				collectionProfile: 'metadata',
				trustRootDigest: 'a'.repeat(64),
				keyPossessionProof: 'fixture-proof',
			});
			expect(result).toMatchObject({ status: 'ok', value: { enrollmentId: 'enr-local' } });
			expect(composed.identity.read()).toMatchObject({
				status: 'ok',
				record: { management: 'enrolling' },
			});
			expect(composed.status()?.authority).toBe('none');
			const request = fake.calls.find(
				(c) => (c.body as { operation?: string }).operation === 'enrollment'
			)?.body;
			const envelope = endpointSchemas.localRequestEnvelope.parse(request);
			endpointSchemas.enrollmentRequest.parse(envelope.payload);
		} finally {
			await composed.lifecycle.close();
		}
	});

	it('refuses foreign installation and lost custody before opening a transport or changing the record', async () => {
		await enroll('/tmp/unused.sock');
		const openPort = vi.fn();
		const composed = composeHostManaged({
			userDataDir: dir,
			version: '1',
			custody: custody(),
			openPort,
		});
		if (!composed.composed) throw new Error(composed.reason);
		const bytes = fs.readFileSync(path.join(dir, 'enterprise-identity.bin'));
		composed.managed.host!({ ...installation, installationId: 'foreign' });
		expect(await composed.control.beginRegistration()).toMatchObject({
			status: 'refused',
			reason: 'installation-mismatch',
		});
		await composed.lifecycle.attach();
		expect(openPort).not.toHaveBeenCalled();
		expect(fs.readFileSync(path.join(dir, 'enterprise-identity.bin'))).toEqual(bytes);
		await composed.lifecycle.close();

		const current = composeHostManaged({
			userDataDir: dir,
			version: '1',
			custody: custody(),
			openPort,
		});
		if (!current.composed) throw new Error(current.reason);
		current.managed.host!(installation);
		holder.value = null;
		expect(await current.control.connect()).toMatchObject({
			status: 'refused',
			reason: 'custody-untrusted',
		});
		expect(current.standing.read().standing).toBe('managed');
		expect(openPort).not.toHaveBeenCalled();
		await current.lifecycle.close();
	});

	it('rechecks a supplied custody probe instead of trusting its ok flag', () => {
		const composed = composeHostManaged({
			userDataDir: dir,
			version: '1',
			custody: { ok: true, seal: obscuringSeal(), anchor: fakeAnchor(holder) },
		});
		expect(composed).toMatchObject({
			composed: false,
			reason: expect.stringContaining('not credential protection'),
		});
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

	it('hands the runtime the held adapter, never no adapter, when a sealed record cannot be opened (MCOMP-09-03)', async () => {
		// No record: no adapter, and composing never reads the keyring.
		const anchorFor = vi.fn(() => fakeAnchor({ value: null }));
		const absent = composeHostManaged({ userDataDir: dir, version: '1.1.0', anchorFor });
		if (absent.composed) throw new Error('unreachable');
		expect(absent.managed.host).toBeUndefined();
		// The standing is handed over all the same (MCOMP-09-04B), unread until the runtime asks.
		expect(absent.managed.standing).toBe(absent.standing);
		expect(anchorFor).not.toHaveBeenCalled();

		await enroll('/tmp/endpoint.sock');
		const present = composeHostManaged({ userDataDir: dir, version: '1.1.0', anchorFor });
		if (present.composed) throw new Error('unreachable');
		expect(present.managed.host).toBeTypeOf('function');
		expect(present.managed.standing).toBe(present.standing);
		const adapter = present.managed.host!(installation);
		expect(adapter.installation).toBe(installation);
		// Never `ok`, never a record: the seal stays the desktop's, nothing is unsealed here.
		const view = adapter.identity.read();
		expect(view).toMatchObject({ status: 'unprotected', record: null });
		expect(view.message).toContain('cannot be opened in this process');
		expect(view.message).toContain(HOST_SEAL_UNAVAILABLE_REASON);
		expect(adapter.authority.authorityId).toBe('unavailable');
		expect(adapter.policy()).toEqual({ sources: [], policyRevision: null });
		expect(adapter.status()).toMatchObject({ authority: 'none', connection: null, endpoint: null });
		expect(adapter.workflows).toBeNull();
		expect(adapter.telemetry).toBeNull();
		expect(adapter.inbox).toBeNull();
		expect(adapter.telemetryStanding()).toMatchObject({
			ok: false,
			reason: expect.stringContaining(HOST_SEAL_UNAVAILABLE_REASON),
		});
		expect(adapter.inboxStanding()).toMatchObject({ ok: false });
		expect(adapter.policyStatus().admission.possible).toBe(false);
		// Every admission is refused by name, before any lease is minted.
		const verified = createContextVerifier({
			verifierId: 'test',
			peer: 'in-process',
			now: () => NOW,
			accept: () => [],
		}).verify(
			inProcessContext({
				installation,
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
				policyRevision: 2,
				workflow: null,
				traceId: 'trace-1',
				requestedCapabilities: ['runs.submit'],
			})
		);
		if (!verified.ok) throw new Error(verified.problems.join('; '));
		const outcome = await adapter.authority.admit({
			context: verified.context,
			snapshot: buildDispatchSnapshot(
				{ command: '/bin/claude', args: ['--print'], cwd: '/work', env: {} },
				{ provider: 'claude-code', model: 'sonnet' }
			),
			policy: { sources: [], policyRevision: 2 },
		});
		expect(outcome).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('no protected custody'),
		});
		expect(adapter.authority.live()).toEqual([]);
	});

	it('hands over the held adapter for a sealed record in the production directory the caller named', async () => {
		const prod = fs.mkdtempSync(path.join(os.tmpdir(), 'host-managed-prod-'));
		try {
			const store = createEnterpriseIdentityStore({
				file: path.join(prod, 'enterprise-identity.bin'),
				seal: fakeSeal(),
				anchor: fakeAnchor({ value: null }),
				platform: 'darwin',
				now: () => NOW,
			});
			await store.write({
				installationId: installation.installationId,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				enrollmentId: 'enr-1',
				endpoint: {
					socketPath: '/tmp/e.sock',
					bindingDigest: 'a'.repeat(64),
					trustRootDigest: null,
				},
				management: 'enrolled',
				registration: null,
				policy: { desiredRevision: 1, appliedRevision: 1, observedAt: null },
				enrolledAt: new Date(NOW).toISOString(),
			});
			const composed = composeHostManaged({
				userDataDir: dir,
				productionDataDir: prod,
				version: '1.1.0',
				anchorFor: () => fakeAnchor({ value: null }),
			});
			if (composed.composed) throw new Error('unreachable');
			expect(composed.managed?.host).toBeTypeOf('function');
			expect(composed.managed!.host!(installation).identity.read().status).toBe('unprotected');
		} finally {
			fs.rmSync(prod, { recursive: true, force: true });
		}
	});

	it('hands the runtime binding the standing in both branches: a deleted binding file or an unopenable record stays managed (MCOMP-09-04B)', async () => {
		const anchorFor = () => fakeAnchor({ value: null });
		const bindingOver = (standing: InstallationStandingSource) =>
			createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true as const }),
				standing,
				now: () => NOW,
			});
		// Never enrolled: the standing reads standalone and the runtime runs as before.
		const plain = composeHostManaged({ userDataDir: dir, version: '1.1.0', anchorFor });
		if (plain.composed) throw new Error('unreachable');
		expect(bindingOver(plain.managed.standing!).state().state).toBe('standalone');

		// A sealed record this process cannot open, no binding file: managed, no authority.
		await enroll('/tmp/endpoint.sock');
		const held = composeHostManaged({ userDataDir: dir, version: '1.1.0', anchorFor });
		if (held.composed) throw new Error('unreachable');
		const unopened = bindingOver(held.managed.standing!);
		expect(unopened.state().state).toBe('unreadable');
		expect(unopened.authority().authorityId).toBe('unavailable');

		// Over protected custody the composed branch carries the same standing beside the adapter,
		// and the binding reads the custody's own record with no binding file at all (unavailable
		// here only because no authority is attached to this bare binding).
		const composed = composeHostManaged({ userDataDir: dir, version: '1.1.0', custody: custody() });
		if (!composed.composed) throw new Error('unreachable');
		expect(composed.managed.standing).toBe(composed.standing);
		const enrolled = bindingOver(composed.managed.standing!).state();
		expect(enrolled.state).toBe('enrolled-unavailable');
		if (enrolled.state !== 'enrolled-unavailable') throw new Error('unreachable');
		expect(enrolled.record.installationId).toBe(installation.installationId);
		expect(fs.existsSync(path.join(dir, 'maestro-managed-binding.json'))).toBe(false);
	});

	it('the held adapter follows the standing per call: a released installation reads none', () => {
		let current: InstallationStanding = {
			standing: 'managed',
			enrollment: null,
			management: null,
			detail: 'An enrollment record is present.',
		};
		const adapter = createHeldHostAdapter({
			installation,
			custodyReason: HOST_SEAL_UNAVAILABLE_REASON,
			standing: { read: () => current },
		});
		expect(adapter.identity.read().status).toBe('unprotected');
		current = { standing: 'standalone', detail: 'released by the endpoint' };
		expect(adapter.identity.read()).toEqual({
			status: 'none',
			reason: null,
			message: 'released by the endpoint',
			record: null,
		});
		expect(adapter.authority.authorityId).toBe('unavailable');
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

describe('createHostInstallationStanding: custody failure keeps the standing managed (MCOMP-09-06)', () => {
	let dir: string;
	let alt: string;
	let holders: Map<string, { value: Anchor | null }>;
	/** One fake anchor per resolved directory: never the developer's keyring. */
	const anchorFor = (d: string): AnchorStore => {
		const key = path.resolve(d);
		let held = holders.get(key);
		if (!held) {
			held = { value: null };
			holders.set(key, held);
		}
		return fakeAnchor(held);
	};
	const custodyFor = (d: string): HostCustodyRead => ({
		ok: true,
		seal: fakeSeal(),
		anchor: anchorFor(d),
	});
	const REFUSED: HostCustodyRead = { ok: false, reason: HOST_SEAL_UNAVAILABLE_REASON };
	const identityFile = (d: string) => path.join(d, 'enterprise-identity.bin');

	async function seal(d: string, management: ManagedIdentityRecord['management'] = 'enrolled') {
		const store = createEnterpriseIdentityStore({
			file: identityFile(d),
			seal: fakeSeal(),
			anchor: anchorFor(d),
			platform: 'darwin',
			now: () => NOW,
		});
		return store.write({
			installationId: 'inst-1',
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			endpoint: {
				socketPath: '/tmp/endpoint.sock',
				bindingDigest: 'a'.repeat(64),
				trustRootDigest: null,
			},
			management,
			registration: null,
			policy: { desiredRevision: 2, appliedRevision: 2, observedAt: null },
			enrolledAt: new Date(NOW).toISOString(),
		});
	}
	const authorityWithId = (authorityId: string) =>
		createLocalHostAuthority({
			authorityId,
			decide: () => ({ decision: 'allow', policyRevision: 2 }),
			now: () => NOW,
			newId: () => 'lease',
		});
	const bindingOver = (standing: InstallationStandingSource, authorityId?: string) =>
		createManagedBinding({
			paths: { userDataDir: dir, productionDataDir: dir },
			fence: () => ({ ok: true as const }),
			...(authorityId ? { authority: authorityWithId(authorityId) } : {}),
			standing,
			now: () => NOW,
		});

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-standing-'));
		alt = fs.mkdtempSync(path.join(os.tmpdir(), 'host-standing-alt-'));
		holders = new Map();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(alt, { recursive: true, force: true });
	});

	it('with no default seal: standalone with nothing held, managed for a sealed record with no binding file, managed for an anchor whose record is gone', async () => {
		const standing = createHostInstallationStanding({
			userDataDir: dir,
			custody: REFUSED,
			anchorFor,
		});
		// The explicit standalone positive regression: nothing held, the runtime runs as before.
		expect(standing.read()).toMatchObject({ standing: 'standalone' });
		expect(bindingOver(standing).state().state).toBe('standalone');

		await seal(dir);
		expect(fs.existsSync(path.join(dir, 'maestro-managed-binding.json'))).toBe(false);
		expect(standing.read()).toMatchObject({
			standing: 'managed',
			enrollment: null,
			detail: expect.stringContaining('cannot be opened in this process'),
		});
		const held = bindingOver(standing, 'fleet');
		expect(held.state().state).toBe('unreadable');
		expect(held.authority().authorityId).toBe('unavailable');

		// The record deleted by hand while its anchor is still held.
		fs.unlinkSync(identityFile(dir));
		expect(standing.read()).toMatchObject({
			standing: 'managed',
			enrollment: null,
			detail: expect.stringContaining('removed without the authenticated release'),
		});
		expect(held.reload().state).toBe('unreadable');
	});

	it('with protected custody: a forged host, revoke, rollback and anchor loss all stay managed with no authority; only retire releases', async () => {
		const standing = createHostInstallationStanding({
			userDataDir: dir,
			custody: custodyFor(dir),
			anchorFor,
			platform: 'darwin',
			now: () => NOW,
		});
		const written = await seal(dir);
		expect(standing.read()).toMatchObject({
			standing: 'managed',
			management: 'enrolled',
			enrollment: { ...bindingEnrollment(written), enrolledAt: written.enrolledAt },
		});
		const authorityId = managedAuthorityId(written);
		const binding = bindingOver(standing, authorityId);
		expect(binding.state()).toMatchObject({
			state: 'enrolled',
			record: { installationId: 'inst-1', authorityId },
		});

		// A forged host: an authority attached under another id is not the one the custody enrolls.
		const forged = bindingOver(standing, 'forged-authority');
		expect(forged.state()).toMatchObject({ state: 'enrolled-unavailable' });
		expect(forged.authority().authorityId).toBe('unavailable');

		// Revoke: still managed, and nothing answers.
		const older = fs.readFileSync(identityFile(dir));
		await seal(dir, 'revoked');
		expect(standing.read()).toMatchObject({ standing: 'managed', management: 'revoked' });
		expect(binding.reload()).toMatchObject({
			state: 'enrolled-unavailable',
			reason: expect.stringContaining('revoked'),
		});
		expect(binding.authority().authorityId).toBe('unavailable');

		// The enrolled copy rolled back under the newer anchor: untrusted, managed.
		fs.writeFileSync(identityFile(dir), older);
		expect(standing.read()).toMatchObject({
			standing: 'managed',
			enrollment: null,
			detail: expect.stringContaining('rollback'),
		});
		expect(binding.reload().state).toBe('unreadable');

		// Anchor loss with the file present: untrusted, managed.
		anchorFor(dir).clear();
		expect(standing.read()).toMatchObject({
			standing: 'managed',
			enrollment: null,
			detail: expect.stringContaining('anchor-missing'),
		});
		expect(binding.reload().state).toBe('unreadable');

		// The authenticated release: a retired record reads standalone.
		fs.unlinkSync(identityFile(dir));
		await seal(dir, 'retired');
		expect(standing.read()).toMatchObject({
			standing: 'standalone',
			detail: expect.stringContaining('retired'),
		});
		expect(binding.reload().state).toBe('standalone');
	});

	it('an alternate data directory under an enrolled installation stays managed, named or derived', async () => {
		await seal(dir);
		const named = createHostInstallationStanding({
			userDataDir: alt,
			productionDataDir: dir,
			custody: custodyFor(alt),
			anchorFor,
			platform: 'darwin',
		});
		expect(named.read()).toMatchObject({ standing: 'managed', management: 'enrolled' });
		// A `maestro-dev` directory maps to its `maestro` sibling whatever production dir is named.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-standing-root-'));
		try {
			const dev = path.join(root, 'maestro-dev');
			const prod = path.join(root, 'maestro');
			fs.mkdirSync(dev);
			fs.mkdirSync(prod);
			await seal(prod);
			const derived = createHostInstallationStanding({
				userDataDir: dev,
				productionDataDir: alt,
				custody: REFUSED,
				anchorFor,
			});
			expect(derived.read()).toMatchObject({
				standing: 'managed',
				detail: expect.stringContaining(prod),
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
