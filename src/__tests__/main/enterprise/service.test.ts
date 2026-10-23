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
import type { LifecycleFact } from '../../../shared/maestro-lib/managed/events';
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
		// Content collection is a managed feature (MRC-10-05): standalone keeps nothing,
		// and the recorded VIBES graph of an empty window names only its own gap.
		expect(service.content.standing()).toEqual({ mode: 'standalone' });
		expect(service.contentCapture.status()).toMatchObject({
			records: 0,
			delivery: { available: false },
		});
		expect(service.vibes()).toMatchObject({
			profile: 'mega-maestro.vibes-recorded.v1',
			sessions: [],
			gaps: [{ kind: 'caller_reported_gap', reference: 'decisions:not-recorded-by-this-host' }],
		});
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

	/** Enroll, attach and register the service against the running fake (the approval flow of the test above). */
	async function register(service: EnterpriseService): Promise<void> {
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
		expect((await service.policy.recover()).status).toBe('approval-required');
		expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
		expect(service.lifecycle.status().authority).toBe('registered');
	}

	const WORKFLOW = {
		workflowId: 'cue-pipeline:Nightly QA',
		version: 'v1',
		triggerEventId: 'time.scheduled:evt-1',
	};

	it('claims a workflow owner fence through the endpoint workflow operation and holds it across a restart (MRC-07-06)', async () => {
		await fake.close();
		fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'workflow'],
			now: () => NOW,
			operations: {
				workflow: (payload) => {
					const p = payload as { workflowId: string; ownerId: string };
					return {
						outcome: 'owned',
						workflowId: p.workflowId,
						ownerId: p.ownerId,
						ownerEpoch: 2,
						fencingToken: 'fence-2',
					};
				},
			},
		});
		const service = compose();
		await register(service);

		const fence = await service.claimWorkflowFence(WORKFLOW, {
			runId: 'run-1',
			attemptId: 'att-1',
		});
		expect(fence).toEqual({ ownerEpoch: '2', fencingToken: 'fence-2' });
		const claim = fake.calls.find(
			(c) => (c.body as { operation?: string }).operation === 'workflow'
		)?.body as { payload: Record<string, unknown> };
		expect(claim.payload).toMatchObject({
			ownerId: service.installation.installationId,
			ownerEpoch: 0,
			policyRevision: 3,
			offlineEnabled: true,
			runId: 'run-1',
			attemptId: 'att-1',
		});
		expect(service.workflows.fence(WORKFLOW)).toEqual({ ownerEpoch: '2', fencingToken: 'fence-2' });
		expect(fs.existsSync(path.join(dir, 'maestro-managed-workflows.json'))).toBe(true);

		// The process sink claims through the same held ownership (MRC-07-06B):
		// a re-claim for another attempt confirms the held fence, one record.
		expect(
			await service.spawnAuthority.workflowFence?.(WORKFLOW, { runId: 'run-1', attemptId: 'att-2' })
		).toEqual({ ownerEpoch: '2', fencingToken: 'fence-2' });
		expect(service.workflows.held()).toHaveLength(1);

		// A restarted desktop holds the same fence before it asks the endpoint anything.
		await service.close();
		services.splice(0);
		const restarted = compose();
		await restarted.workflows.load();
		expect(restarted.workflows.fence(WORKFLOW)).toEqual({
			ownerEpoch: '2',
			fencingToken: 'fence-2',
		});
	});

	it('an endpoint that serves no workflow operation answers capability-unsupported and nothing is held', async () => {
		const service = compose();
		await register(service);
		const answer = await service.claimWorkflowFence(WORKFLOW, {
			runId: 'run-1',
			attemptId: 'att-1',
		});
		expect(answer).toMatchObject({
			fence: null,
			state: 'unavailable',
			code: 'capability-unsupported',
			message: expect.stringContaining('CP-03'),
		});
		expect(service.workflows.held()).toHaveLength(0);
	});

	// MRC-10-02A: the desktop's event journal is attached to the lifecycle projection at start,
	// keeps what the agent-run capture reports under the data directory, is flushed at close, and a
	// file that will not load is reported by name and never overwritten.
	const SPAWN: LifecycleFact = {
		surface: 'agent',
		state: 'running',
		at: NOW,
		sessionId: 'agent-1-ai-tab-1',
		agentId: 'agent-1',
		tabId: 'tab-1',
		provider: 'claude-code',
		model: 'opus',
		providerSessionId: null,
		runId: 'run-1',
		record: 'ledger',
		ledgerStatus: 'running',
		exitCode: null,
		durationMs: null,
		detail: null,
	};

	it('attaches the event journal at start, keeps what the projection raises and flushes it at close', async () => {
		const service = compose();
		expect(service.eventJournalAttached()).toBe(false);
		await service.start();
		expect(service.eventJournalAttached()).toBe(true);
		const [event] = service.events.record(SPAWN);
		expect(event.context.origin).toBe('desktop');
		expect(service.eventJournal.status()).toMatchObject({
			entries: 1,
			delivery: { pending: 1, uncertain: 0, received: 0 },
		});
		await service.close();
		services.splice(0);
		const written = JSON.parse(
			fs.readFileSync(path.join(dir, 'maestro-managed-events.json'), 'utf8')
		);
		expect(written.entries.map((e: { eventId: string }) => e.eventId)).toEqual([event.eventId]);
		expect(fake.calls).toHaveLength(0);
	});

	it('hands a journaled event to the endpoint telemetry operation under a registered standing and marks it received from the receipt (MRC-10-03B)', async () => {
		const reports: Record<string, unknown>[] = [];
		const telemetryFake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'telemetry'],
			now: () => NOW,
			operations: {
				telemetry: (payload) => {
					reports.push(payload as Record<string, unknown>);
					return {
						outcome: 'durably_accepted',
						eventId: (payload as { eventId: string }).eventId,
						receivedAt: new Date(NOW).toISOString(),
						duplicate: false,
					};
				},
			},
		});
		try {
			const service = compose();
			await service.identity.write({
				installationId: service.installation.installationId,
				tenantId: 'tenant-1',
				orgId: 'org-1',
				enrollmentId: 'enr-1',
				endpoint: {
					socketPath: telemetryFake.socketPath,
					bindingDigest: 'a'.repeat(64),
					trustRootDigest: null,
				},
				management: 'enrolled',
				registration: null,
				policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
				enrolledAt: new Date(NOW).toISOString(),
			});
			await service.start();
			expect(service.telemetry.status().running).toBe(true);
			// Before the actor approves there is no standing: an event is journaled, nothing is sent.
			const [early] = service.events.record(SPAWN);
			expect(await service.telemetry.pump()).toMatchObject({ outcome: 'no-standing', taken: 0 });
			expect(reports).toHaveLength(0);
			expect((await service.policy.recover()).status).toBe('approval-required');
			expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
			expect(service.host.telemetryStanding()).toMatchObject({
				ok: true,
				binding: { deviceId: 'enr-1', policyRevision: 3 },
			});
			const pass = await service.telemetry.pump();
			expect(pass).toMatchObject({ outcome: 'sent', taken: 1, received: 1 });
			expect(reports).toHaveLength(1);
			expect(reports[0]).toMatchObject({
				eventId: early.eventId,
				deviceId: 'enr-1',
				instanceId: service.installation.installationId,
				bootId: service.installation.processEpoch,
				source: 'runtime',
				family: 'agent.lifecycle',
				policyRevision: 3,
				collectionProfile: 'metadata',
			});
			// The run identities stay in the journal; the wire carries none of them.
			const wire = JSON.stringify(reports[0]);
			for (const canary of [SPAWN.agentId, SPAWN.sessionId, SPAWN.runId, SPAWN.provider]) {
				expect(wire).not.toContain(canary);
			}
			expect(service.eventJournal.status()).toMatchObject({
				delivery: { pending: 0, uncertain: 0, received: 1 },
				held: 0,
			});
			await service.close();
			services.splice(0);
			expect(service.telemetry.status().running).toBe(false);
			const written = JSON.parse(
				fs.readFileSync(path.join(dir, 'maestro-managed-events.json'), 'utf8')
			);
			expect(written.entries[0]).toMatchObject({ eventId: early.eventId, delivery: 'received' });
		} finally {
			await telemetryFake.close();
		}
	});

	it('reports a journal file that will not load by name, keeps the projection detached and leaves the file alone', async () => {
		const file = path.join(dir, 'maestro-managed-events.json');
		fs.writeFileSync(file, '{ not json');
		const unavailable: unknown[] = [];
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
			anchor: fakeAnchor(holder),
			platform: 'darwin',
			now: () => NOW,
			openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
			onEventJournalUnavailable: (load) => unavailable.push(load),
		});
		services.push(service);
		await service.start();
		expect(service.eventJournalAttached()).toBe(false);
		expect(unavailable).toEqual([expect.objectContaining({ ok: false, reason: 'corrupt', file })]);
		service.events.record(SPAWN);
		expect(() => service.eventJournal.status()).toThrow(/not loaded/);
		await service.close();
		services.splice(0);
		expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
	});

	it('an unenrolled desktop has no standing to claim a workflow under', async () => {
		const service = compose();
		await service.start();
		expect(
			await service.claimWorkflowFence(WORKFLOW, { runId: 'run-1', attemptId: 'att-1' })
		).toMatchObject({
			fence: null,
			state: 'unavailable',
			message: expect.stringContaining('no managed standing'),
		});
		expect(fake.calls).toHaveLength(0);
	});
});
