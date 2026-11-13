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
import {
	createEnterpriseService,
	type EnterpriseService,
	type EnterpriseServiceDeps,
} from '../../../main/enterprise/service';
import {
	buildDispatchSnapshot,
	createLocalHostAuthority,
} from '../../../shared/maestro-lib/managed/authority';
import {
	effectGranted,
	type ManagedEffectProducer,
} from '../../../shared/maestro-lib/managed/effects';
import {
	ENDPOINT_NATIVE_PORT_VERSION,
	type EndpointNativePort,
	type EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
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

	function compose(
		anchor = fakeAnchor(holder),
		extra: Pick<
			EnterpriseServiceDeps,
			'openPort' | 'effectProducer' | 'liveRunCheckMs' | 'platform' | 'endpointNative'
		> = {}
	) {
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
			...extra,
		});
		services.push(service);
		return service;
	}

	it('includes host approved options in the shared status surface without exposing native policy', () => {
		const service = compose();
		expect(service.managed.status().agentOptions).toMatchObject({
			outcome: 'unavailable',
			authority: 'none',
		});
		const options = {
			outcome: 'unavailable' as const,
			authority: 'none' as const,
			policyRevision: 9,
			freshness: 'stale' as const,
			reason: 'Refresh required',
		};
		const read = vi.spyOn(service.policy, 'agentOptions').mockReturnValue(options);
		const state = service.managed.status();
		expect(read).toHaveBeenCalledOnce();
		expect(state.agentOptions).toEqual(options);
		expect(state.agentOptions).not.toBe(options);
		expect(state).not.toHaveProperty('routes');
	});

	it.each([false, true])(
		'holds prepared and effect inputs until desktop recovery: recovered=%s',
		async (recovered) => {
			let service: EnterpriseService;
			let currentPort: EndpointPort | undefined;
			let leaseNumber = 0;
			// Declared local producer only. No wire negotiation or native confinement is claimed.
			const producer: ManagedEffectProducer = {
				version: 1,
				get authorityId() {
					return service.host.authority.authorityId;
				},
				authorize: vi.fn(async (request) => ({
					decision: 'allow',
					receipt: {
						receiptId: 'local-effect',
						effectDigest: request.effectDigest,
						policyRevision: request.policyRevision,
						expiresAt: new Date(NOW + 1000).toISOString(),
					},
				})),
				consume: vi.fn(async (_request, receipt) => ({ decision: 'allow', receipt })),
			};
			const effectProducer = vi.fn((port: EndpointPort) =>
				port === currentPort ? producer : null
			);
			service = compose(undefined, {
				effectProducer,
				openPort: (socketPath) => {
					// The first port is the v1 one the host reads; the v2 attachment opens its
					// own connection after it, which is never the host's port.
					const opened = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
					currentPort ??= opened;
					if (opened !== currentPort) return opened;
					const prepared = createLocalHostAuthority({
						authorityId: service.host.authority.authorityId,
						now: () => NOW,
						newId: () => `local-lease-${++leaseNumber}`,
						decide: () => ({ decision: 'allow', policyRevision: 3 }),
					});
					Object.defineProperty(currentPort, 'preparedExecution', {
						value: { ...prepared, version: 1 },
					});
					return currentPort;
				},
			});
			await register(service, recovered);
			// V1 registration has no actor binding. Supply one only in this declared
			// local custody fixture; the production service must never manufacture it.
			const enrolled = service.identity.read();
			if (enrolled.status !== 'ok' || !enrolled.record.registration)
				throw new Error('expected the local registration fixture');
			await service.identity.write({
				...enrolled.record,
				registration: { ...enrolled.record.registration, actorId: 'fixture-actor' },
			});
			const spawn = service.spawnAuthority;
			expect(spawn.effects).toBe(service.host.effects);
			const verified = spawn.verify({
				actor: { peer: 'in-process' },
				identity: {
					requestId: 'local-request',
					idempotencyKey: 'local-key',
					attemptId: 'local-attempt',
					runId: null,
					rootRunId: null,
					parentRunId: null,
				},
				traceId: 'local-trace',
				policyRevision: 3,
				workflow: null,
			});
			if (!verified.ok) throw new Error(verified.problems.join('; '));
			expect(verified.context.installation).toEqual(service.installation);
			expect(verified.context.actor.id).toBe(
				service.lifecycle.status().identity.record?.registration?.actorId
			);
			const request = {
				context: verified.context,
				policy: spawn.policy(),
				snapshot: buildDispatchSnapshot(
					{ command: '/local/fixture', args: [], cwd: dir, env: {} },
					{ provider: 'claude-code', model: null }
				),
			};
			const admitted = await spawn.authority.admit(request);
			if (!recovered) {
				expect(admitted).toMatchObject({ state: 'unavailable' });
				expect(await service.host.authority.admit(request)).toMatchObject({ state: 'unavailable' });
				expect(effectProducer).not.toHaveBeenCalled();
				expect(leaseNumber).toBe(0);
				return;
			}
			if (admitted.state !== 'admitted') throw new Error(admitted.message);
			admitted.lease.bind(42);
			const binding = {
				leaseId: admitted.lease.leaseId,
				actor: verified.context.actor,
				provider: 'claude-code',
				threadId: null,
				turnId: 'tab-1',
				requestId: 'effect-1',
			};
			const effect = {
				kind: 'tool-call' as const,
				tool: 'Write',
				input: { file_path: '/work/file', content: 'exact contents' },
				request: { method: 'Write', input: { file_path: '/work/file', content: 'exact contents' } },
			};
			const allowed = await spawn.effects!.decide(effect, binding, new AbortController().signal);
			expect(effectGranted(allowed)).toBe(true);
			expect(producer.consume).toHaveBeenCalledWith(
				expect.objectContaining({ effect, binding, policyRevision: 3 }),
				expect.objectContaining({ receiptId: 'local-effect' }),
				expect.any(AbortSignal)
			);
			expect(effectProducer).toHaveBeenCalledWith(currentPort!);
			vi.mocked(producer.authorize).mockImplementation(() => new Promise(() => {}));
			const pending = spawn.effects!.decide(
				effect,
				{ ...binding, requestId: 'effect-2' },
				new AbortController().signal
			);
			const closing = service.close();
			expect(admitted.lease.state()).toBe('revoked');
			expect(effectGranted(allowed)).toBe(false);
			expect(await pending).toMatchObject({ decision: 'deny' });
			await closing;
			await service.start(); // Terminal close cannot re-open authority.
			expect(service.host.policyStatus().admission.possible).toBe(false);
			expect(service.dispatch.receipt(admitted.lease.leaseId)?.effect.state).toBe('revoked');
			expect(
				fake.calls.filter((call) => (call.body as { operation: string }).operation === 'execution')
			).toHaveLength(0);
		}
	);

	it('holds admission during recovery and recovers once across concurrent starts', async () => {
		const service = compose();
		let finish!: () => void;
		const waiting = new Promise<void>((resolve) => (finish = resolve));
		const load = service.dispatch.load;
		const recovery = vi.spyOn(service.dispatch, 'load').mockImplementation(async () => {
			await waiting;
			return load();
		});
		const first = service.start();
		expect(service.start()).toBe(first);
		expect(service.host.status().reason).toContain('has not recovered');
		expect(service.host.policyStatus().admission.possible).toBe(false);
		finish();
		await first;
		await service.start();
		expect(recovery).toHaveBeenCalledTimes(1);
	});

	it('stays closed when shutdown races with startup recovery', async () => {
		const service = compose();
		let finish!: () => void;
		vi.spyOn(service.dispatch, 'load').mockImplementation(
			() =>
				new Promise(
					(resolve) => (finish = () => resolve({ ok: true, receipts: 0, recoveredUnknown: 0 }))
				)
		);
		const starting = service.start();
		const closing = service.close();
		finish();
		await Promise.all([starting, closing]);
		await service.start();
		expect(service.host.status().reason).toContain('closing');
		expect(service.telemetry.status().running).toBe(false);
		expect(fake.calls).toHaveLength(0);
	});

	it('preserves a corrupt dispatch ledger and keeps authority unavailable', async () => {
		const file = path.join(dir, 'maestro-managed-dispatch-receipts.json');
		fs.writeFileSync(file, '{broken');
		const service = compose();
		await expect(service.start()).rejects.toThrow('Managed dispatch recovery failed');
		expect(service.host.policyStatus().admission.possible).toBe(false);
		expect(fs.readFileSync(file, 'utf8')).toBe('{broken');
		expect(fake.calls).toHaveLength(0);
	});

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
		expect(service.spawnAuthority.effects).toBe(service.host.effects);
		expect(
			await service.spawnAuthority.effects!.decide(
				{ kind: 'command', command: 'fixture', cwd: null, argv: null },
				{
					leaseId: 'absent',
					actor: { kind: 'human', id: 'fixture' },
					provider: 'claude-code',
					threadId: null,
					turnId: null,
					requestId: 'absent',
				},
				new AbortController().signal
			)
		).toMatchObject({ decision: 'unavailable' });
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
		// The inventory (MRC-10-06B): read off the standing, recorded once at start, kept by the
		// journal; a second record of the same inventory is the same event, which the journal dedups.
		expect(service.inventory.snapshot()).toMatchObject({
			device: { deviceId: null, hostname: 'testhost' },
			versions: { app: '1.1.0-RC', contracts: { status: 'absent' } },
			endpoint: { authority: 'none', status: null },
			identity: { custody: 'none' },
			collection: {
				journal: { attached: true },
				telemetry: { running: true },
				usage: { tracked: 0 },
			},
			completeness: 'partial',
		});
		expect(service.events.recent().map((event) => event.kind)).toEqual(['inventory']);
		expect(service.eventJournal.status()).toMatchObject({ entries: 1, delivery: { pending: 1 } });
		expect(service.inventory.record()[0].eventId).toBe(service.events.recent()[0].eventId);
		expect(service.eventJournal.status()).toMatchObject({
			entries: 1,
			counters: { duplicates: 1 },
		});
		expect(fake.calls).toHaveLength(0);
		// The command service and the inbox (MRC-11-05): both ledgers read at start, each in the
		// data directory; with no standing nothing can be decided or listed, and that is said by name.
		expect(service.commands.status()).toMatchObject({
			file: `${dir}/maestro-managed-commands.json`,
			loaded: true,
			commands: { total: 0, open: 0 },
			standing: { ok: false, reason: 'This installation holds no enrollment.' },
		});
		expect([...service.commands.capabilities()].sort()).toEqual([
			'command-cancel_run',
			'command-refresh_policy',
			'command-report_status',
		]);
		expect(service.commands.unsupported().map((entry) => entry.kind)).toEqual([
			'pause-run',
			'resume-run',
			'operator-prompt',
		]);
		expect(service.inbox.status()).toMatchObject({
			file: `${dir}/maestro-managed-inbox-receipts.json`,
			loaded: true,
			standing: { ok: false },
			notices: { held: 0 },
			receipts: { total: 0 },
		});
		expect(await service.inbox.refresh()).toMatchObject({ outcome: 'no-standing', listed: 0 });
		// `identity.read()` ran once for the start check and once per status; the file
		// does not exist, so the anchor was read ONCE (an anchor whose record is gone is
		// managed, MCOMP-09-04C) and that answer held for every later read.
		expect(available).toHaveBeenCalled();
		expect(read).toHaveBeenCalledTimes(1);
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
		// The registered standing reaches the inventory: the enrollment id is the device, the
		// record's tenant and actor are named, and the socket path is nowhere in the fleet fact.
		expect(service.inventory.snapshot()).toMatchObject({
			device: { deviceId: 'enr-1' },
			identity: { custody: 'ok', tenantId: 'tenant-1', enrollmentId: 'enr-1' },
			endpoint: { authority: 'registered', connection: { attached: true } },
			policy: { appliedRevision: 3 },
		});
		expect(JSON.stringify(service.inventory.fact())).not.toContain(fake.socketPath);

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
	async function register(service: EnterpriseService, recover = true): Promise<void> {
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
		if (recover) await service.start();
		else await service.lifecycle.connect();
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
		const claim = fake.calls.find(
			(c) => (c.body as { operation?: string }).operation === 'workflow'
		)?.body as { payload: Record<string, unknown> };
		// The fence names the owner the registry holds it under, the same one the claim was made for.
		expect(fence).toEqual({
			ownerId: claim.payload.ownerId,
			ownerEpoch: '2',
			fencingToken: 'fence-2',
		});
		expect(claim.payload).toMatchObject({
			ownerId: service.installation.installationId,
			ownerEpoch: 0,
			policyRevision: 3,
			offlineEnabled: true,
			runId: 'run-1',
			attemptId: 'att-1',
		});
		expect(service.workflows.fence(WORKFLOW)).toEqual({
			ownerId: fence.ownerId,
			ownerEpoch: '2',
			fencingToken: 'fence-2',
		});
		expect(fs.existsSync(path.join(dir, 'maestro-managed-workflows.json'))).toBe(true);

		// The process sink claims through the same held ownership (MRC-07-06B):
		// a re-claim for another attempt confirms the held fence, one record.
		expect(
			await service.spawnAuthority.workflowFence?.(WORKFLOW, { runId: 'run-1', attemptId: 'att-2' })
		).toEqual({ ownerId: fence.ownerId, ownerEpoch: '2', fencingToken: 'fence-2' });
		expect(service.workflows.held()).toHaveLength(1);

		// A restarted desktop holds the same fence before it asks the endpoint anything.
		await service.close();
		services.splice(0);
		const restarted = compose();
		await restarted.workflows.load();
		expect(restarted.workflows.fence(WORKFLOW)).toEqual({
			ownerId: fence.ownerId,
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
		// Start recorded this boot's inventory (MRC-10-06B) before the spawn arrived.
		const [inventory] = service.events.recent();
		expect(inventory.kind).toBe('inventory');
		const [event] = service.events.record(SPAWN);
		expect(event.context.origin).toBe('desktop');
		expect(service.eventJournal.status()).toMatchObject({
			entries: 2,
			delivery: { pending: 2, uncertain: 0, received: 0 },
		});
		await service.close();
		services.splice(0);
		const written = JSON.parse(
			fs.readFileSync(path.join(dir, 'maestro-managed-events.json'), 'utf8')
		);
		expect(written.entries.map((e: { eventId: string }) => e.eventId)).toEqual([
			inventory.eventId,
			event.eventId,
		]);
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
			// The boot's inventory entry is walked past by name (no runtime family carries it) and stays pending.
			expect(pass).toMatchObject({
				outcome: 'sent',
				taken: 1,
				received: 1,
				withheld: { family: 1 },
			});
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
				delivery: { pending: 1, uncertain: 0, received: 1 },
				held: 0,
			});
			await service.close();
			services.splice(0);
			expect(service.telemetry.status().running).toBe(false);
			const written = JSON.parse(
				fs.readFileSync(path.join(dir, 'maestro-managed-events.json'), 'utf8')
			);
			expect(written.entries[0]).toMatchObject({ delivery: 'pending', attempts: 0 });
			expect(written.entries[0].event.kind).toBe('inventory');
			expect(written.entries[1]).toMatchObject({ eventId: early.eventId, delivery: 'received' });
		} finally {
			await telemetryFake.close();
		}
	});

	it('composes the command service and the inbox: ledgers before the attach, notices listed on every attach, a command decided by name, one drain (MRC-11-05)', async () => {
		const calls: { operation: string; payload: Record<string, unknown> }[] = [];
		const notice = {
			campaignId: 'c-1',
			messageId: 'm-1',
			body: 'Planned maintenance on Friday.',
			expiresAt: new Date(NOW + 86_400_000).toISOString(),
			kind: 'notice',
			agentInput: false,
		};
		const inboxFake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'inbox', 'noticeList'],
			now: () => NOW,
			operations: {
				noticeList: (payload) => {
					calls.push({ operation: 'noticeList', payload: payload as Record<string, unknown> });
					return { outcome: 'notices', items: [notice], nextOffset: null };
				},
				inbox: (payload) => {
					const request = payload as { messageId: string; action: { kind: string } };
					calls.push({ operation: 'inbox', payload: request });
					return {
						outcome: 'recorded',
						messageId: request.messageId,
						receiptId: `rcpt-${calls.length}`,
						state: request.action.kind,
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
					socketPath: inboxFake.socketPath,
					bindingDigest: 'a'.repeat(64),
					trustRootDigest: null,
				},
				management: 'enrolled',
				registration: null,
				policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
				enrolledAt: new Date(NOW).toISOString(),
			});
			await service.start();
			// Both ledgers were read before the attach; the endpoint wanted a registration first,
			// so nothing was listed and no command could be decided, each said by name.
			expect(service.commands.status()).toMatchObject({ loaded: true, standing: { ok: false } });
			expect(service.inbox.status()).toMatchObject({ loaded: true, notices: { held: 0 } });
			expect(calls).toHaveLength(0);

			expect((await service.policy.recover()).status).toBe('approval-required');
			expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
			// The accepted attachment listed the notices without a click, held the one addressed
			// here and recorded `delivered` for it; the body is on the person's surface and nowhere else.
			await vi.waitFor(() =>
				expect(calls.map((call) => call.operation)).toEqual(['noticeList', 'inbox'])
			);
			expect(service.inbox.notices()).toMatchObject([
				{ messageId: 'm-1', body: notice.body, agentInput: false, recorded: 'delivered' },
			]);
			expect(service.inbox.status()).toMatchObject({
				standing: { ok: true },
				notices: { held: 1, unread: 1 },
			});
			expect(
				await service.inbox.act({ campaignId: 'c-1', messageId: 'm-1', action: { kind: 'read' } })
			).toMatchObject({ status: 'recorded', duplicate: false });
			expect(service.inbox.status().notices).toMatchObject({ held: 1, unread: 0 });
			// A policy refresh is another accepted attachment: the notices are listed again.
			expect((await service.policy.refresh()).status).toBe('ok');
			await vi.waitFor(() =>
				expect(calls.filter((call) => call.operation === 'noticeList')).toHaveLength(2)
			);
			expect(service.inbox.status().notices).toMatchObject({ held: 1 });

			// A command is decided against the standing this process holds: the registration
			// Maestro redeems names no actor (CP-01/CP-04), so it is refused by that name, and
			// the refusal is the ledger's, durable in the data directory.
			expect(service.commands.status().standing).toEqual({ ok: true });
			const decided = await service.commands.receive({
				commandId: 'cmd-1',
				tenantId: 'tenant-1',
				issuerId: 'issuer-1',
				recipient: {
					actorId: 'actor-1',
					enrollmentId: 'enr-1',
					installationId: service.installation.installationId,
					runtimeId: service.installation.runtimeId,
					processEpoch: service.installation.processEpoch,
					runId: 'run-1',
				},
				action: { kind: 'report-status' },
				preconditions: {
					policyRevision: 3,
					requiredCapability: 'command-report_status',
					policyDigest: null,
					bindingDigest: null,
				},
				approval: { kind: 'policy-not-required', policyRevision: 3 },
				issuedAt: new Date(NOW - 1_000).toISOString(),
				expiresAt: new Date(NOW + 60_000).toISOString(),
				nonce: 'n'.repeat(64),
				idempotencyKey: 'idem-1',
				payloadDigest: 'a'.repeat(64),
				releaseId: null,
			});
			expect(decided).toMatchObject({ status: 'denied', reason: 'unauthenticated' });
			// A command that does not bind to this host's actor is nobody's to record here.
			expect(service.commands.status().commands).toMatchObject({ total: 0, open: 0 });

			// Close is one drain: a second caller waits on the first instead of starting another.
			const first = service.close();
			expect(service.close()).toBe(first);
			await first;
			services.splice(0);
			expect(service.lifecycle.status()).toMatchObject({ authority: 'none', connection: null });
			// What the ledgers kept: ids and states, never the notice body.
			const receipts = fs.readFileSync(
				path.join(dir, 'maestro-managed-inbox-receipts.json'),
				'utf8'
			);
			expect(receipts).toContain('"m-1"');
			expect(receipts).not.toContain(notice.body);
		} finally {
			await inboxFake.close();
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

	describe('live managed runs under a standing that changes mid-run (MCOMP-25-03)', () => {
		/** A registered service over a declared local prepared-execution fixture, and one bound run. */
		async function boundRun(liveRunCheckMs = 0) {
			let service!: EnterpriseService;
			let leaseNumber = 0;
			service = compose(undefined, {
				liveRunCheckMs,
				openPort: (socketPath) => {
					const port = createLocalEndpointClient({ socketPath, timeoutMs: 1_000 });
					const prepared = createLocalHostAuthority({
						authorityId: service.host.authority.authorityId,
						now: () => NOW,
						newId: () => `run-lease-${++leaseNumber}`,
						decide: () => ({ decision: 'allow', policyRevision: 3 }),
					});
					Object.defineProperty(port, 'preparedExecution', { value: { ...prepared, version: 1 } });
					return port;
				},
			});
			await register(service);
			// Local custody fixture only: v1 registration carries no actor binding.
			const enrolled = service.identity.read();
			if (enrolled.status !== 'ok' || !enrolled.record.registration)
				throw new Error('expected the local registration fixture');
			await service.identity.write({
				...enrolled.record,
				registration: { ...enrolled.record.registration, actorId: 'fixture-actor' },
			});
			const verified = service.spawnAuthority.verify({
				actor: { peer: 'in-process' },
				identity: {
					requestId: 'run-request',
					idempotencyKey: 'run-key',
					attemptId: 'run-attempt',
					runId: null,
					rootRunId: null,
					parentRunId: null,
				},
				traceId: 'run-trace',
				policyRevision: 3,
				workflow: null,
			});
			if (!verified.ok) throw new Error(verified.problems.join('; '));
			const admitted = await service.spawnAuthority.authority.admit({
				context: verified.context,
				policy: service.spawnAuthority.policy(),
				snapshot: buildDispatchSnapshot(
					{ command: '/local/fixture', args: [], cwd: dir, env: {} },
					{ provider: 'claude-code', model: null }
				),
			});
			if (admitted.state !== 'admitted') throw new Error(admitted.message);
			admitted.lease.bind(42);
			// The process manager's subscription: a revoked lease stops its process.
			const stopped = vi.fn();
			admitted.lease.onRevoked(stopped);
			return { service, lease: admitted.lease, stopped };
		}

		async function setManagement(service: EnterpriseService, management: 'revoked' | 'suspended') {
			const read = service.identity.read();
			if (read.status !== 'ok') throw new Error('expected an enrolled record');
			await service.identity.write({ ...read.record, management });
		}

		it('leaves a run admitted under a standing that still allows it alone', async () => {
			const { service, lease, stopped } = await boundRun();
			const pass = service.constrainLiveRuns();
			expect(pass).toMatchObject({ live: 1, revoked: [], reason: null });
			expect(pass.standing).not.toBe('revoked');
			expect(lease.state()).toBe('bound');
			expect(stopped).not.toHaveBeenCalled();
		});

		it('revokes the running lease when the record is revoked, so its process stops and the ledger says why', async () => {
			const { service, lease, stopped } = await boundRun();
			await setManagement(service, 'revoked');
			const pass = service.constrainLiveRuns();
			expect(pass).toMatchObject({ standing: 'revoked', live: 1, revoked: [lease.leaseId] });
			expect(lease.state()).toBe('revoked');
			expect(stopped).toHaveBeenCalledWith(expect.stringContaining('host standing is revoked'));
			expect(service.dispatch.receipt(lease.leaseId)?.effect).toMatchObject({
				state: 'revoked',
				reason: expect.stringContaining('Managed execution is refused'),
			});
			// Nothing is live any more, so a second pass revokes nothing.
			expect(service.constrainLiveRuns()).toMatchObject({ live: 0, revoked: [] });
		});

		it('a policy refresh that learns of a suspension stops the run it refuses', async () => {
			const { service, lease, stopped } = await boundRun();
			// The refresh is where the endpoint's suspension lands on the record.
			const refresh = service.policy.refresh;
			vi.spyOn(service.policy, 'refresh').mockImplementation(async () => {
				const outcome = await refresh();
				await setManagement(service, 'suspended');
				return outcome;
			});
			expect(service.constrainLiveRuns().revoked).toEqual([]);
			await service.managed.refreshPolicy();
			expect(lease.state()).toBe('revoked');
			expect(stopped).toHaveBeenCalledWith(expect.stringContaining('suspended'));
		});

		it('holds live runs to the standing on a timer between start and close, with no send', async () => {
			const { service, lease, stopped } = await boundRun(10);
			await setManagement(service, 'revoked');
			await vi.waitFor(() => expect(lease.state()).toBe('revoked'), { timeout: 2_000 });
			expect(stopped).toHaveBeenCalledOnce();
		});

		it('reads a run that was bound when the desktop went away back as unknown after a restart, never as running', async () => {
			const { service, lease } = await boundRun();
			// The ledger as a process that died without closing left it: the lease bound, no release.
			await service.dispatch.flush();
			const reopened = compose();
			await reopened.start();
			expect(reopened.managed.run(lease.leaseId)).toMatchObject({
				leaseId: lease.leaseId,
				effect: { state: 'unknown' },
			});
			expect(reopened.host.authority.live()).toHaveLength(0);
		});
	});

	it('opens the endpoint through the platform client by default: macOS and Windows with no native port refuse by name, a declared port is accepted, Linux is unchanged (MCOMP-31-04A)', async () => {
		const enrollIn = (service: EnterpriseService) =>
			service.identity.write({
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
		// Windows, unenrolled: a valid local pipe name, but no port names the server behind it.
		const windows = compose(undefined, { openPort: undefined, platform: 'win32' });
		const enrollment = await windows.lifecycle.requestEnrollment({
			socketPath: '\\\\.\\pipe\\mega-maestro-endpoint-a1',
			tenantId: 'tenant-1',
			orgId: 'org-1',
			mode: 'attended',
			invitation: 'fixture-invitation',
			collectionProfile: 'metadata',
			trustRootDigest: 'a'.repeat(64),
			keyPossessionProof: 'fixture-proof',
		});
		expect(enrollment).toMatchObject({ status: 'refused', reason: 'no-endpoint' });
		expect(enrollment.status === 'refused' && enrollment.message).toMatch(
			/No native endpoint port is installed for win32/
		);
		expect(windows.identity.read()).toMatchObject({ status: 'none' });
		await windows.close();

		const mac = compose(undefined, { openPort: undefined, platform: 'darwin' });
		await enrollIn(mac);
		const refused = await mac.lifecycle.connect();
		expect(refused).toMatchObject({ status: 'refused', reason: 'no-endpoint' });
		expect(refused.status === 'refused' && refused.message).toMatch(
			/No native endpoint port is installed for darwin/
		);
		expect(fake.calls).toHaveLength(0);
		await mac.close();

		// A declared fixture port (it names a fixed server and reads no OS peer) is accepted.
		const verified: string[] = [];
		const native: EndpointNativePort = {
			version: ENDPOINT_NATIVE_PORT_VERSION,
			platform: 'darwin',
			transport: 'unix-socket',
			verifyServer: async ({ address }) => {
				verified.push(address);
				return {
					status: 'verified',
					server: {
						pid: 4242,
						processBirthDigest: 'a'.repeat(64),
						executableDigest: 'b'.repeat(64),
						principal: '_megamaestro',
					},
				};
			},
		};
		const verifiedMac = compose(undefined, {
			openPort: undefined,
			platform: 'darwin',
			endpointNative: native,
		});
		await verifiedMac.lifecycle.connect();
		// Each connection verifies the server: the v2 attachment's own, then the v1 one.
		expect(verified).toEqual([fake.socketPath, fake.socketPath]);
		expect(fake.calls.length).toBeGreaterThan(0);
		await verifiedMac.close();

		const before = fake.calls.length;
		const linux = compose(undefined, { openPort: undefined, platform: 'linux' });
		await linux.lifecycle.connect();
		expect(fake.calls.length).toBeGreaterThan(before);
		await linux.close();
	});
});
