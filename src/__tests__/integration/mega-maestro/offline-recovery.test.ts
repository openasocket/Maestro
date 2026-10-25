/**
 * Offline recovery, restart, revoke and version over the REAL desktop
 * composition (`createEnterpriseService`: sealed identity store over the
 * injected seal and anchor, lifecycle, policy status, host adapter, dispatch
 * bridge and its ledger, event journal, telemetry and inbox clients, every file
 * in a temp data directory) reaching a LABELED DOUBLE of the endpoint daemon
 * through the real socket client. Every effect is observed independently of
 * what a receipt says: a real child under a real lease, the double's spool and
 * inbox, the ledgers on disk, the requests on the socket. Nothing here is the
 * pair (the harness script's job, judged in MRC-12-06); no case is skipped.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { createEnterpriseService, type EnterpriseService } from '../../../main/enterprise/service';
import { telemetryReportOf } from '../../../main/enterprise/telemetry';
import type { Anchor } from '../../../main/utils/keyring-anchor';
import {
	buildDispatchSnapshot,
	type AdmissionOutcome,
	type DispatchLease,
} from '../../../shared/maestro-lib/managed/authority';
import { LOCAL_ENDPOINT_PROTOCOL } from '../../../shared/maestro-lib/managed/endpoint-port';
import type { LifecycleFact } from '../../../shared/maestro-lib/managed/events';
import { fakeAnchor, fakeSeal } from '../../main/enterprise/fakeCustody';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../main/enterprise/fakeEndpoint';
import { brokerReceipt, SYNTHETIC_PROVIDER_ID } from './fixtures';

const T0 = Date.parse('2026-10-25T12:00:00Z');
const NOTICE = {
	campaignId: '7d2c3f0e-5a4b-4c6d-9e8f-0a1b2c3d4e5f',
	messageId: '0f1e2d3c-4b5a-4968-8776-655443322110',
	body: 'CANARY-NOTICE the policy revision moves next week',
	expiresAt: new Date(T0 + 86_400_000).toISOString(),
	kind: 'notice',
	agentInput: false,
};
const CHILD_ARGS = ['-e', 'setInterval(() => {}, 1000)'];
type Holder = { value: Anchor | null };
type Double = FakeEndpointOptions & {
	spool: Map<string, Record<string, unknown>>;
	inbox: Map<string, Record<string, unknown>>;
};

/** The double's durable side: a telemetry spool and an inbox, each deduplicated the way the daemon's are. */
function doubleOptions(now: () => number): Double {
	const spool = new Map<string, Record<string, unknown>>();
	const inbox = new Map<string, Record<string, unknown>>();
	let decisions = 0;
	return {
		spool,
		inbox,
		registrationRequired: true,
		capabilities: ['execution', 'telemetry', 'inbox', 'noticeList'],
		now,
		operations: {
			execution: (payload) =>
				brokerReceipt(payload as Record<string, unknown>, `decision-${++decisions}`),
			telemetry: (payload) => {
				const id = (payload as { eventId: string }).eventId;
				const duplicate = spool.has(id);
				if (!duplicate) spool.set(id, payload as Record<string, unknown>);
				const receivedAt = new Date(now()).toISOString();
				return { outcome: 'durably_accepted', eventId: id, receivedAt, duplicate };
			},
			noticeList: () => ({ outcome: 'notices', items: [NOTICE], nextOffset: null }),
			inbox: (payload) => {
				const { idempotencyKey, messageId } = payload as Record<string, string>;
				const receiptId = `rcpt-${inbox.size + 1}`;
				const receipt = { outcome: 'recorded', messageId, receiptId, state: 'delivered' };
				return inbox.get(idempotencyKey) ?? inbox.set(idempotencyKey, receipt).get(idempotencyKey);
			},
		},
	};
}

/** The real desktop composition over the injected custody, one process of it. */
function compose(dir: string, holder: Holder, pid: number, startedAt: string, now: () => number) {
	const seal = fakeSeal();
	return createEnterpriseService({
		userDataDir: dir,
		productionDataDir: dir,
		hostname: 'offline-recovery-host',
		pid,
		startedAt,
		appVersion: '1.1.0-RC',
		safeStorage: {
			isEncryptionAvailable: () => true,
			encryptString: (text) => seal.seal(text),
			decryptString: (blob) => seal.unseal(blob),
			getSelectedStorageBackend: () => 'keychain',
		},
		anchor: fakeAnchor(holder),
		platform: 'darwin',
		now,
		openPort: (socketPath) => createLocalEndpointClient({ socketPath, timeoutMs: 1_000 }),
	});
}

/** A data directory, the double and the desktop over the enrollment left to it (no registration, no policy observed), started; `daemonGone` closes the double first. */
async function boot(prefix: string, options: Double, holder: Holder, daemonGone = false) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const fake = await startFakeEndpoint(options);
	const service = compose(dir, holder, 4242, '2026-10-25T11:59:00.000Z', options.now!);
	await service.identity.write({
		installationId: service.installation.installationId,
		tenantId: 'tenant-pair',
		orgId: 'org-pair',
		enrollmentId: 'enr-pair',
		endpoint: { socketPath: fake.socketPath, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
		management: 'enrolled',
		registration: null,
		policy: { desiredRevision: null, appliedRevision: null, observedAt: null },
		enrolledAt: new Date(T0).toISOString(),
	});
	if (daemonGone) await fake.close();
	await service.start();
	return { dir, fake, service };
}

/** The actor's approval, played by the test and labeled: the double has no approval producer. */
async function register(service: EnterpriseService): Promise<void> {
	expect((await service.policy.recover()).status).toBe('approval-required');
	expect((await service.lifecycle.completeRegistration()).status).toBe('ok');
	expect(service.lifecycle.status().authority).toBe('registered');
}

let runs = 0;
/** One launch asked of the real process-manager port: verified context, a real command line's snapshot, the bridge. */
async function admitLaunch(service: EnterpriseService, cwd: string): Promise<AdmissionOutcome> {
	const runId = `run-${++runs}`;
	const verified = service.spawnAuthority.verify({
		actor: { peer: 'in-process' },
		identity: {
			requestId: `req-${runId}`,
			idempotencyKey: `key-${runId}`,
			attemptId: `att-${runId}`,
			runId,
			rootRunId: runId,
			parentRunId: null,
		},
		traceId: `trace-${runId}`,
		policyRevision: service.host.policy().policyRevision,
		workflow: null,
	});
	if (!verified.ok) throw new Error(verified.problems.join('; '));
	return service.spawnAuthority.authority.admit({
		context: verified.context,
		snapshot: buildDispatchSnapshot(
			{ command: process.execPath, args: CHILD_ARGS, cwd, env: {} },
			{ provider: SYNTHETIC_PROVIDER_ID, model: 'synthetic', resourceIds: [] }
		),
		policy: service.spawnAuthority.policy(),
	});
}

type Exit = { code: number | null; signal: string | null };
interface LiveChild {
	child: ChildProcess;
	lease: DispatchLease;
	exited: Promise<Exit>;
	revocations: string[];
}

/** A REAL child under the admitted lease; the test plays the sink: bind on spawn, SIGTERM on revocation. */
async function startChild(admitted: AdmissionOutcome, cwd: string): Promise<LiveChild> {
	if (admitted.state !== 'admitted') throw new Error(`${admitted.state}: ${admitted.message}`);
	const child = spawn(process.execPath, CHILD_ARGS, { cwd, stdio: 'ignore' });
	await once(child, 'spawn');
	const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }) as Exit);
	const revocations: string[] = [];
	admitted.lease.bind(child.pid);
	admitted.lease.onRevoked((reason) => {
		revocations.push(reason);
		child.kill('SIGTERM');
	});
	return { child, lease: admitted.lease, exited, revocations };
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const fact = (at: number, runId: string): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at,
	sessionId: `agent-pair-ai-${runId}`,
	agentId: 'agent-pair',
	tabId: 'tab-1',
	provider: 'claude-code',
	model: 'opus',
	providerSessionId: null,
	runId,
	record: 'ledger',
	ledgerStatus: 'running',
	exitCode: null,
	durationMs: null,
	detail: null,
});

const operations = (fake: FakeEndpoint): string[] =>
	fake.calls.map((c) => (c.body as { operation?: string }).operation ?? c.path);
const enrolledRecord = { status: 'ok', record: { management: 'enrolled' } };

describe('offline recovery: the daemon is gone when the desktop starts', () => {
	let booted: Awaited<ReturnType<typeof boot>>;
	const now = () => T0;

	beforeAll(async () => {
		booted = await boot('offline-start-', doubleOptions(now), { value: null }, true);
	});
	afterAll(async () => {
		await booted.service.close();
		fs.rmSync(booted.dir, { recursive: true, force: true });
	});

	it('keeps the record, stays managed, and answers every managed port unavailable by name; nothing is admitted, nothing is journaled as sent', async () => {
		const { service, fake, dir } = booted;
		expect(fs.existsSync(fake.socketPath)).toBe(false);
		expect(service.identity.read()).toMatchObject(enrolledRecord);
		expect(service.spawnAuthority.standing()).toBe('managed');
		const standing = service.lifecycle.status();
		expect(standing).toMatchObject({
			authority: 'none',
			connection: { attached: false, registration: 'none' },
			endpoint: null,
			reason: expect.any(String),
		});
		expect(service.policy.status()).toMatchObject({
			source: 'cached',
			connectivity: 'detached',
			offline: { installedPolicyAvailable: false, mode: 'none' },
			admission: { possible: false },
		});

		// A spawn: the process-manager port verifies the context and the bridge answers by the standing's reason.
		const admitted = await admitLaunch(service, dir);
		expect(admitted).toMatchObject({ state: 'unavailable', message: standing.reason });
		expect(service.dispatch.receipts()).toEqual([]);
		expect(service.dispatch.authority.live()).toEqual([]);

		// Telemetry, inbox, workflow owner and commands: each refuses with a reason, none fabricates a standing.
		const reasoned = { ok: false, reason: expect.any(String) };
		expect(service.host.telemetryStanding()).toMatchObject(reasoned);
		expect(await service.telemetry.pump()).toMatchObject({ outcome: 'no-standing', taken: 0 });
		expect(service.host.inboxStanding()).toMatchObject(reasoned);
		expect(service.inbox.status()).toMatchObject({ standing: { ok: false }, notices: { held: 0 } });
		const fence = await service.claimWorkflowFence(
			{ workflowId: 'wf-offline', version: '1', triggerEventId: 'evt-offline' },
			{ runId: 'run-wf', attemptId: 'att-wf' }
		);
		expect(fence).toMatchObject({ fence: null, state: 'unavailable' });
		expect(service.commands.status()).toMatchObject({ loaded: true, standing: reasoned });

		// The journal holds this boot's inventory; nothing was taken, sent or received.
		expect(service.eventJournal.status()).toMatchObject({
			entries: 1,
			delivery: { pending: 1, uncertain: 0, received: 0 },
		});
		expect(service.telemetry.status().counters).toMatchObject({ received: 0, taken: 0 });
	});
});

describe('offline recovery: drop mid-session, host restart, revoked registration', () => {
	let dir: string;
	let fake: FakeEndpoint;
	let double: Double;
	let service: EnterpriseService;
	let clock = T0;
	const now = () => clock;
	const holder: Holder = { value: null };
	let first: LiveChild;

	beforeAll(async () => {
		double = doubleOptions(now);
		({ dir, fake, service } = await boot('offline-drop-', double, holder));
		await register(service);
		// The passes below are driven by hand so each outcome is observed; the idle poll is the service's own.
		service.telemetry.stop();
		await vi.waitFor(() => expect(service.inbox.notices()).toHaveLength(1), { timeout: 5_000 });
		await vi.waitFor(() => expect(double.inbox.size).toBe(1), { timeout: 5_000 });
	}, 30_000);
	afterAll(async () => {
		await service.close();
		await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const executions = () => operations(fake).filter((op) => op === 'execution').length;
	const pump = () => service.telemetry.pump();

	it('a dropped daemon leaves the bound lease and its real child alone, refuses a new admission, and keeps telemetry pending until the re-attach resumes it with each id answered once', async () => {
		const [a] = service.events.record(fact(now(), 'run-a'));
		expect(await pump()).toMatchObject({ outcome: 'sent', received: 1, withheld: { family: 1 } });
		expect([...double.spool.keys()]).toEqual([a.eventId]);
		const admitted = await admitLaunch(service, dir);
		expect(admitted).toMatchObject({ state: 'admitted', receipt: { decisionId: 'decision-1' } });
		first = await startChild(admitted, dir);
		expect(service.dispatch.receipt(first.lease.leaseId)?.effect.state).toBe('bound');

		// The daemon drops every connection: the process's registration outlives the socket, the session does not.
		fake.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));
		clock += 1_000;
		expect(first.lease.state()).toBe('bound');
		expect(alive(first.child.pid!)).toBe(true);
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			connection: { attached: false, registration: 'registered' },
		});
		const sent = executions();
		const refused = await admitLaunch(service, dir);
		expect(refused).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(executions()).toBe(sent);
		const [b] = service.events.record(fact(now(), 'run-b'));
		expect(['no-standing', 'interrupted']).toContain((await pump()).outcome);
		expect(service.eventJournal.status().delivery).toMatchObject({ received: 1, uncertain: 0 });
		expect(double.spool.has(b.eventId)).toBe(false);

		// The authenticated refresh re-attaches over the registered socket and the pump resumes.
		expect((await service.policy.refresh()).status).toBe('ok');
		expect(service.lifecycle.status().authority).toBe('registered');
		expect(first.lease.state()).toBe('bound');
		expect(await pump()).toMatchObject({ outcome: 'sent', received: 1, duplicates: 0 });
		expect([...double.spool.keys()]).toEqual([a.eventId, b.eventId]);
		expect(service.eventJournal.status().delivery).toMatchObject({ received: 2, uncertain: 0 });
		// The same id again through the real port: the double answers duplicate and spools nothing new.
		const standing = service.host.telemetryStanding();
		if (!standing.ok) throw new Error(standing.reason);
		const projected = telemetryReportOf(a, standing.binding);
		if (!projected.ok) throw new Error(projected.detail);
		const again = await service.host.telemetry!.report(projected.report);
		expect(again).toMatchObject({ status: 'ok', payload: { duplicate: true } });
		expect(double.spool.size).toBe(2);
		expect(JSON.stringify([...double.spool.values()])).not.toContain('agent-pair');
	}, 20_000);

	it('a host restart over the same data directory reads the receipts, the journal split and the inbox receipts as they were, and must register again before anything is admitted', async () => {
		await service.dispatch.flush();
		const firstKey = service.inbox.receipts()[0]?.idempotencyKey;
		expect(firstKey).toEqual(expect.any(String));
		await service.close();
		// The host is gone; the child it ran is the test's to end, and the lease it held is released by nobody.
		first.child.kill('SIGTERM');
		await first.exited;
		clock += 5_000;
		service = compose(dir, holder, 4343, new Date(now()).toISOString(), now);
		await service.start();
		service.telemetry.stop();

		// The dispatch ledger: the lease bound at the last exit is unknown, by name, and not live.
		expect(service.dispatch.receipts().map((r) => r.effect.state)).toEqual(['unknown']);
		expect(service.dispatch.receipt(first.lease.leaseId)?.effect.reason).toContain('restarted');
		expect(service.dispatch.authority.live()).toEqual([]);
		// The journal: the two received entries stay received; each boot's inventory stays pending.
		expect(service.eventJournal.status()).toMatchObject({
			entries: 4,
			delivery: { pending: 2, uncertain: 0, received: 2 },
		});
		// The inbox ledger: the delivered receipt is on disk; the held notices were memory.
		expect(service.inbox.status()).toMatchObject({
			loaded: true,
			notices: { held: 0 },
			receipts: { total: 1, byState: { recorded: 1 } },
		});
		expect(service.commands.status()).toMatchObject({ loaded: true, commands: { total: 0 } });

		// A new process epoch: the endpoint refuses the attachment until this process registers.
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			lastDenial: { operation: 'attachment', reason: 'unauthenticated' },
		});
		const before = executions();
		expect(await admitLaunch(service, dir)).toMatchObject({ state: 'unavailable' });
		expect(executions()).toBe(before);
		await register(service);
		await vi.waitFor(() => expect(service.inbox.notices()).toHaveLength(1), { timeout: 5_000 });
		expect(service.inbox.receipts().some((r) => r.idempotencyKey === firstKey)).toBe(true);
		// Nothing of the earlier boot is resent: both inventories are withheld by family, the rest is received.
		expect(await pump()).toMatchObject({ outcome: 'idle', taken: 0, withheld: { family: 2 } });
		expect(double.spool.size).toBe(2);
	}, 20_000);

	it('a revoked registration turns admission and refresh unauthenticated, revokeAll ends the live child, and a completed registration restores admission', async () => {
		const admitted = await admitLaunch(service, dir);
		expect(admitted).toMatchObject({ state: 'admitted', receipt: { decisionId: 'decision-2' } });
		const second = await startChild(admitted, dir);
		expect(alive(second.child.pid!)).toBe(true);

		fake.revokeRegistration();
		expect(await admitLaunch(service, dir)).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: expect.stringContaining('unauthenticated'),
		});
		expect((await service.policy.refresh()).status).toBe('denied');
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			lastDenial: { operation: 'attachment', reason: 'unauthenticated' },
		});
		service.events.record(fact(now(), 'run-c'));
		expect((await pump()).outcome).toBe('no-standing');
		expect(double.spool.size).toBe(2);

		// The host withdraws every live lease: the sink hears it and the real process ends.
		expect(service.dispatch.authority.revokeAll('the endpoint revoked this registration')).toBe(1);
		expect((await second.exited).signal).toBe('SIGTERM');
		expect(alive(second.child.pid!)).toBe(false);
		expect(second.lease.state()).toBe('revoked');
		expect(second.revocations).toHaveLength(1);
		expect(service.dispatch.receipt(second.lease.leaseId)?.effect).toMatchObject({
			state: 'revoked',
			reason: 'the endpoint revoked this registration',
		});
		expect(service.dispatch.authority.live()).toEqual([]);

		// The actor registers again: admission comes back, and the held event goes out.
		await register(service);
		expect((await admitLaunch(service, dir)).state).toBe('admitted');
		expect(await pump()).toMatchObject({ outcome: 'sent', received: 1 });
		expect(double.spool.size).toBe(3);
		expect(service.dispatch.authority.revokeAll('test over')).toBe(1);
	}, 20_000);
});

describe('offline recovery: a daemon speaking another schema version', () => {
	let booted: Awaited<ReturnType<typeof boot>>;
	const now = () => T0;

	beforeAll(async () => {
		const options = { ...doubleOptions(now), schemaVersion: 2 };
		booted = await boot('offline-version-', options, { value: null });
	});
	afterAll(async () => {
		await booted.service.close();
		await booted.fake.close();
		fs.rmSync(booted.dir, { recursive: true, force: true });
	});

	it('is refused unsupported_version at compatibility and at attach; nothing is admitted and nothing is sent', async () => {
		const { service, fake, dir } = booted;
		expect(service.lifecycle.status()).toMatchObject({
			authority: 'none',
			lastDenial: { operation: 'attachment', reason: 'unsupported_version' },
		});
		const probe = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 1_000 });
		try {
			expect(
				await probe.compatibility({
					protocol: LOCAL_ENDPOINT_PROTOCOL,
					components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
					requiredCapabilities: ['attachment'],
				})
			).toEqual({ status: 'denied', reason: 'unsupported_version' });
		} finally {
			await probe.close();
		}
		expect((await admitLaunch(service, dir)).state).toBe('unavailable');
		expect(await service.telemetry.pump()).toMatchObject({ outcome: 'no-standing', taken: 0 });
		expect(service.dispatch.receipts()).toEqual([]);
		expect(service.eventJournal.status().delivery.received).toBe(0);
		expect(new Set(operations(fake))).toEqual(new Set(['attachment', 'compatibility']));
		expect(service.identity.read()).toMatchObject(enrolledRecord);
	});
});
