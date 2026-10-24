/**
 * MRC-11-06: the desktop command service (`src/main/enterprise/commands.ts`)
 * over a real local authority and a doubled, mutable standing. Typed commands
 * only: cancel revokes the run's live leases and report reads metadata. A
 * replay, a stale epoch, a lapsed window, another actor and an untyped action
 * are refused by name and leave no record; history is answered before
 * authority, so a known id answers under a revoked standing while a new
 * command finds none. The refresh and prompt ports, the ledger across
 * processes and the real lifecycle, client and fake daemon are the bounded
 * continuation MRC-11-06A.
 */

import { describe, expect, it } from 'vitest';

import { createCommandService } from '../../../main/enterprise/commands';
import type { InstallationInventory } from '../../../main/enterprise/inventory';
import {
	createLocalHostAuthority,
	type DispatchLease,
} from '../../../shared/maestro-lib/managed/authority';
import type {
	CommandRefusal,
	ManagedRuntimeCommand,
} from '../../../shared/maestro-lib/managed/commands';
import { projectPolicyStatus } from '../../../shared/maestro-lib/managed/host-adapter';
import {
	anotherCommand as another,
	COMMAND_PRECONDITIONS as PRECONDITIONS,
	COMMAND_RECIPIENT as RECIPIENT,
	INSTALLATION,
	type ManagedStandingInput,
	NOW,
	operatorPromptCommand,
	REGISTERED_STANDING,
	registeredStatus,
	runAdmission,
	runtimeCommand as command,
	runtimeOnlyCommand as onRuntime,
} from './fakeManaged';

const REVOKED = 'The endpoint revoked this registration.';

/** Only the fields `report` reads; the rest of the inventory is not the command service's. */
const inventory = () =>
	({
		at: new Date(NOW).toISOString(),
		installation: INSTALLATION,
		versions: {
			app: '1.1.0',
			library: '0.24.0',
			contract: '1',
			endpointProtocol: 1,
			contracts: { status: 'absent' },
		},
		endpoint: { authority: 'registered', reason: null, status: null, lastDenial: null },
		identity: {
			custody: 'ok',
			management: 'enrolled',
			tenantId: 'tenant-1',
			enrollmentId: 'enr-1',
			registeredActor: true,
		},
		policy: projectPolicyStatus({ standing: registeredStatus(), now: NOW }),
		completeness: 'partial',
		gaps: ['g1'],
	}) as unknown as InstallationInventory;

/** The service over a real local authority and a doubled, mutable standing; the ledger in memory. */
function harness(over: Partial<ManagedStandingInput> = {}) {
	const state: ManagedStandingInput = { ...REGISTERED_STANDING, ...over };
	const standing = () => registeredStatus(state);
	let leases = 0;
	const authority = createLocalHostAuthority({
		authorityId: 'auth-1',
		decide: () => ({ decision: 'allow', policyRevision: 3 }),
		now: () => NOW,
		newId: () => `lease-${++leases}`,
	});
	const receipts: { leaseId: string; runId: string | null; effect: { state: string } }[] = [];
	const service = createCommandService({
		installation: INSTALLATION,
		lifecycle: { status: standing },
		host: { policyStatus: () => projectPolicyStatus({ standing: standing(), now: NOW }) },
		policy: { refresh: async () => ({ status: 'ok', value: standing().endpoint! }) },
		dispatch: { authority, receipts: () => receipts as never },
		inventory: { snapshot: inventory },
		now: () => NOW,
	});
	async function lease(runId: string, requestId: string): Promise<DispatchLease> {
		const out = await authority.admit(runAdmission(runId, requestId));
		if (out.state !== 'admitted') throw new Error(out.state);
		const receipt = { leaseId: out.lease.leaseId, runId, effect: { state: 'bound' } };
		receipts.push(receipt);
		out.lease.bind(4242);
		out.lease.onRevoked(() => {
			receipt.effect.state = 'revoked';
		});
		return out.lease;
	}
	return { service, authority, lease, state };
}
type Harness = ReturnType<typeof harness>;
const receive = (h: Harness, raw: unknown) => h.service.receive(raw);
const liveRuns = (h: Harness) => h.authority.live().map((lease) => lease.runId);
async function expectDenied(h: Harness, raw: unknown, reason: CommandRefusal, detail?: string) {
	expect(await receive(h, raw)).toMatchObject({
		status: 'denied',
		reason,
		...(detail ? { detail: expect.stringContaining(detail) } : {}),
	});
}

describe('the desktop command service', () => {
	it('cancels a run by revoking its live lease; the duplicate answers from history, the ended run is no-effect, an unknown run stale-run', async () => {
		const h = harness();
		expect(h.service.capabilities()).toEqual([
			'command-cancel_run',
			'command-report_status',
			'command-refresh_policy',
		]);
		expect(h.service.unsupported().map((u) => u.kind)).toEqual([
			'pause-run',
			'resume-run',
			'operator-prompt',
		]);
		const lease = await h.lease('run-1', 'req-1');
		const stopped: string[] = [];
		lease.onRevoked((reason) => stopped.push(reason));
		expect(await receive(h, command())).toMatchObject({
			status: 'completed',
			commandId: 'cmd-1',
			duplicate: false,
			facts: { runId: 'run-1', revoked: ['lease-1'], stillLive: [] },
			evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(lease.state()).toBe('revoked');
		expect(stopped).toEqual(['cancel_run cmd-1 issued by issuer-1']);
		expect(liveRuns(h)).toEqual([]);
		expect(h.service.ledger.get('cmd-1')).toMatchObject({ state: 'completed', runId: 'run-1' });
		// The same command again: answered from history, nothing revoked twice.
		expect(await receive(h, command())).toMatchObject({ status: 'completed', duplicate: true });
		// A new command on the ended run: the receipts know it, no lease is live.
		expect(await receive(h, another('cmd-2'))).toMatchObject({
			status: 'no-effect',
			facts: { ended: [{ leaseId: 'lease-1', state: 'revoked' }] },
		});
		// A run this host never saw is stale by name and leaves no record.
		const unknownRun = another('cmd-3', { recipient: { ...RECIPIENT, runId: 'run-9' } });
		await expectDenied(h, unknownRun, 'stale-run', 'this host knows no run run-9');
		expect(h.service.ledger.get('cmd-3')).toBeNull();
		expect(h.service.status().commands).toMatchObject({ total: 2, open: 0 });
	});

	it('reports status from the inventory and the policy standing as metadata: never a path, a model or a prompt', async () => {
		const h = harness();
		await h.lease('run-1', 'req-1');
		const answer = await receive(h, onRuntime('cmd-r', { kind: 'report-status' }));
		expect(answer).toMatchObject({
			status: 'completed',
			duplicate: false,
			facts: {
				installation: INSTALLATION,
				versions: { app: '1.1.0', library: '0.24.0', contracts: 'absent' },
				endpoint: { authority: 'registered', management: null, connectivity: null },
				identity: { tenantId: 'tenant-1', enrollmentId: 'enr-1', registeredActor: true },
				policy: { appliedRevision: 3, converged: true, admissionPossible: true },
				runs: { live: 1, liveLeases: 1, receipts: 1 },
				commands: { total: 1, open: 1 },
				completeness: 'partial',
				gaps: ['g1'],
			},
		});
		const text = JSON.stringify(answer);
		for (const secret of ['/work', '/bin/claude', 'sonnet', 'say hi']) {
			expect(text).not.toContain(secret);
		}
		expect(liveRuns(h)).toEqual(['run-1']);
	});

	it('refuses a replay by name (the id under another payload, a nonce or a key another command consumed) and revokes nothing for one', async () => {
		const h = harness();
		await h.lease('run-1', 'req-1');
		expect(await receive(h, command())).toMatchObject({ status: 'completed' });
		await expectDenied(h, command({ payloadDigest: 'b'.repeat(64) }), 'replay', 'another payload');
		await h.lease('run-2', 'req-2');
		const onRun2 = (over: Partial<ManagedRuntimeCommand> = {}) =>
			another('cmd-2', { recipient: { ...RECIPIENT, runId: 'run-2' }, ...over });
		await expectDenied(h, onRun2({ nonce: 'n'.repeat(64) }), 'replay', 'nonce or idempotency key');
		await expectDenied(h, onRun2({ idempotencyKey: 'idem-1' }), 'replay');
		expect(h.service.ledger.get('cmd-2')).toBeNull();
		expect(liveRuns(h)).toEqual(['run-2']);
		expect(await receive(h, onRun2())).toMatchObject({ status: 'completed', duplicate: false });
		expect(liveRuns(h)).toEqual([]);
		expect(h.service.status().commands).toMatchObject({ total: 2, byState: { completed: 2 } });
	});

	it('refuses a stale epoch, tenant, enrollment or runtime, a lapsed window, another actor, an uncomposed action and an untyped one, recording nothing', async () => {
		const h = harness();
		await h.lease('run-1', 'req-1');
		const to = (recipient: Partial<ManagedRuntimeCommand['recipient']>) =>
			command({ recipient: { ...RECIPIENT, ...recipient } });
		await expectDenied(h, to({ processEpoch: 'epoch-0' }), 'stale-run', 'another process epoch');
		await expectDenied(h, command({ tenantId: 'tenant-2' }), 'stale-run', 'another tenant');
		await expectDenied(h, to({ enrollmentId: 'enr-0' }), 'stale-run', 'another enrollment');
		await expectDenied(h, to({ runtimeId: 'desktop-7' }), 'stale-run', 'installation or runtime');
		await expectDenied(h, command({ expiresAt: new Date(NOW - 1).toISOString() }), 'expired');
		await expectDenied(
			h,
			to({ actorId: 'actor-2' }),
			'unauthenticated',
			'other than the registered'
		);
		const pause = command({
			action: { kind: 'pause-run' },
			preconditions: { ...PRECONDITIONS, requiredCapability: 'command-pause_run' },
		});
		await expectDenied(h, pause, 'unsupported-capability', 'command-pause_run');
		// No prompt port is composed, so an operator prompt never binds here, approved or not.
		await expectDenied(h, operatorPromptCommand(), 'unsupported-capability', 'operator_prompt');
		// An untyped action is not a command at all.
		const shell = { ...command(), action: { kind: 'shell', script: 'rm -rf /' } };
		await expectDenied(h, shell, 'invalid-input', 'not a typed command');
		expect(await receive(h, 'cancel run-1')).toMatchObject({ status: 'denied', commandId: null });
		expect(liveRuns(h)).toEqual(['run-1']);
		expect(h.service.ledger.list()).toEqual([]);
	});

	it('answers history before authority: a known id answers under a revoked standing, a new command finds none; no actor and a policy behind are refused', async () => {
		const h = harness();
		await h.lease('run-1', 'req-1');
		expect(await receive(h, command())).toMatchObject({ status: 'completed' });
		Object.assign(h.state, { authority: 'none', reason: REVOKED });
		expect(h.service.status().standing).toEqual({ ok: false, reason: REVOKED });
		expect(await receive(h, command())).toMatchObject({ status: 'completed', duplicate: true });
		expect(await receive(h, another('cmd-2'))).toEqual({
			status: 'unavailable',
			commandId: 'cmd-2',
			detail: REVOKED,
		});
		Object.assign(h.state, { ...REGISTERED_STANDING, actorId: null });
		await h.lease('run-2', 'req-2');
		const onRun2 = another('cmd-2', { recipient: { ...RECIPIENT, runId: 'run-2' } });
		await expectDenied(h, onRun2, 'unauthenticated', 'names no actor');
		Object.assign(h.state, { actorId: 'actor-1', applied: 7 });
		await expectDenied(h, onRun2, 'policy-denied', 'binds policy revision 3; this host applies 7');
		expect(liveRuns(h)).toEqual(['run-2']);
		expect(h.service.ledger.get('cmd-2')).toBeNull();
	});
});
