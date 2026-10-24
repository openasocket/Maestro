/**
 * MRC-11-06: the desktop command service (`src/main/enterprise/commands.ts`)
 * over a real local authority and a doubled, mutable standing. Typed commands
 * only: cancel revokes the run's live leases and report reads metadata. A
 * replay, a stale epoch, a lapsed window, another actor and an untyped action
 * are refused by name and leave no record; history is answered before
 * authority, so a known id answers under a revoked standing while a new
 * command finds none. MRC-11-06A adds the refresh port (the status service's
 * answer compared with the desired revision), the prompt port (composed only
 * when handed in; the text reaches it and nowhere else), the ledger across
 * processes (unavailable until loaded, accepted turns unknown on a restart,
 * a deleted file forgets, a corrupt one is named) and the real lifecycle,
 * client and fake daemon, where the record names no actor (CP-01/CP-04).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createCommandService, type CommandServiceDeps } from '../../../main/enterprise/commands';
import { createBrokerDispatch } from '../../../main/enterprise/dispatch';
import type { InstallationInventory } from '../../../main/enterprise/inventory';
import {
	createLocalHostAuthority,
	type DispatchLease,
} from '../../../shared/maestro-lib/managed/authority';
import {
	MANAGED_COMMAND_LEDGER_FILE_NAME,
	type CommandRefusal,
	type ManagedRuntimeCommand,
} from '../../../shared/maestro-lib/managed/commands';
import { projectPolicyStatus } from '../../../shared/maestro-lib/managed/host-adapter';
import { startFakeEndpoint } from './fakeEndpoint';
import {
	anotherCommand as another,
	COMMAND_PRECONDITIONS as PRECONDITIONS,
	COMMAND_RECIPIENT as RECIPIENT,
	DIGEST_A,
	INSTALLATION,
	type ManagedStandingInput,
	NOW,
	operatorPromptCommand,
	REGISTERED_STANDING,
	registeredStatus,
	runAdmission,
	runtimeCommand as command,
	runtimeOnlyCommand as onRuntime,
	startRegisteredLifecycle,
	tempDirs,
} from './fakeManaged';

const tempDir = tempDirs('mrc-11-06a-');

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
type RefreshAnswer = Awaited<ReturnType<CommandServiceDeps['policy']['refresh']>>;
/** A doubled, mutable standing over a real local authority; the ledger in memory unless a file is named. */
function harness(
	over: Partial<ManagedStandingInput> = {},
	opts: { file?: string; prompt?: CommandServiceDeps['prompt'] } = {}
) {
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
	let refreshAnswer: RefreshAnswer = { status: 'ok', value: standing().endpoint! };
	let refreshes = 0;
	const service = createCommandService({
		installation: INSTALLATION,
		lifecycle: { status: standing },
		host: { policyStatus: () => projectPolicyStatus({ standing: standing(), now: NOW }) },
		policy: {
			refresh: async () => {
				refreshes += 1;
				return refreshAnswer;
			},
		},
		dispatch: { authority, receipts: () => receipts as never },
		inventory: { snapshot: inventory },
		now: () => NOW,
		...opts,
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
	return {
		service,
		authority,
		lease,
		state,
		setRefresh: (answer: RefreshAnswer) => {
			refreshAnswer = answer;
		},
		refreshes: () => refreshes,
	};
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

	it('refreshes policy through the status service: completed when the endpoint applies the desired revision, failed with both named otherwise or when the re-attach did not complete', async () => {
		const h = harness();
		const refresh = (id: string, desiredRevision: number) =>
			onRuntime(id, { kind: 'refresh-policy', desiredRevision });
		expect(await receive(h, refresh('r1', 3))).toMatchObject({
			status: 'completed',
			detail: 'the endpoint applies revision 3',
			facts: { desiredRevision: 3, before: { desired: 3, applied: 3 }, after: { applied: 3 } },
		});
		expect(await receive(h, refresh('r2', 5))).toMatchObject({
			status: 'failed',
			detail: 'the endpoint applies revision 3 and desires 3, not 5',
		});
		h.setRefresh({
			status: 'ok',
			value: {
				...registeredStatus().endpoint!,
				desiredPolicyRevision: 5,
				appliedPolicyRevision: 5,
			},
		});
		expect(await receive(h, refresh('r3', 5))).toMatchObject({
			status: 'completed',
			facts: { before: { applied: 3 }, after: { desired: 5, applied: 5 } },
		});
		h.setRefresh({ status: 'unavailable', message: 'socket gone' });
		expect(await receive(h, refresh('r4', 3))).toMatchObject({
			status: 'failed',
			detail: 'the re-attach did not complete: unavailable: socket gone',
			facts: { refresh: 'unavailable' },
		});
		expect(h.refreshes()).toBe(4);
		expect(h.service.status().commands).toMatchObject({
			total: 4,
			open: 0,
			byState: { completed: 2, failed: 2 },
		});
	});

	it('composes operator_prompt only with a prompt port: approval-required without its own approval, the text reaches the port and never the ledger', async () => {
		const prompts: { text: string; runId: string }[] = [];
		const h = harness(
			{},
			{
				prompt: async (text, runId) => {
					prompts.push({ text, runId });
					return { outcome: 'accepted' };
				},
			}
		);
		expect(h.service.capabilities()).toContain('command-operator_prompt');
		expect(h.service.unsupported().map((u) => u.kind)).toEqual(['pause-run', 'resume-run']);
		await h.lease('run-1', 'req-1');
		const approved = operatorPromptCommand();
		const unapproved = {
			...approved,
			approval: { kind: 'policy-not-required', policyRevision: 3 },
		};
		await expectDenied(h, unapproved, 'approval-required', 'separate approval');
		const otherPayload = {
			...approved,
			approval: { ...approved.approval, payloadDigest: 'b'.repeat(64) },
		};
		await expectDenied(h, otherPayload, 'approval-required', 'does not bind this payload');
		expect(prompts).toEqual([]);
		expect(h.service.ledger.list()).toEqual([]);

		expect(await receive(h, approved)).toMatchObject({
			status: 'accepted',
			commandId: 'cmd-p',
			duplicate: false,
		});
		expect(prompts).toEqual([{ text: 'say hi', runId: 'run-1' }]);
		expect(h.service.ledger.get('cmd-p')).toMatchObject({
			state: 'accepted',
			kind: 'operator-prompt',
			runId: 'run-1',
		});
		expect(JSON.stringify(h.service.ledger.list())).not.toContain('say hi');
		expect(await receive(h, approved)).toMatchObject({ status: 'accepted', duplicate: true });
		expect(prompts).toHaveLength(1);
		await h.service.settle('cmd-p', {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(h.service.ledger.get('cmd-p')).toMatchObject({
			state: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(h.service.status().commands).toMatchObject({ total: 1, open: 0 });
		expect(liveRuns(h)).toEqual(['run-1']);
	});

	it('keeps the ledger across processes: unavailable until loaded, an accepted prompt turns unknown on restart and a late settle never rewrites it, a deleted file forgets, a corrupt one is named', async () => {
		const prompt: CommandServiceDeps['prompt'] = async () => ({ outcome: 'accepted' });
		const file = path.join(tempDir(), MANAGED_COMMAND_LEDGER_FILE_NAME);
		const first = harness({}, { file, prompt });
		await first.lease('run-1', 'req-1');
		expect(first.service.status()).toMatchObject({ loaded: false, file, standing: { ok: true } });
		expect(await receive(first, command())).toMatchObject({
			status: 'unavailable',
			detail: expect.stringContaining('not loaded'),
		});
		expect(liveRuns(first)).toEqual(['run-1']);
		expect(await first.service.load()).toEqual({ ok: true, commands: 0, recoveredUnknown: 0 });
		expect(await receive(first, operatorPromptCommand())).toMatchObject({ status: 'accepted' });
		expect(first.service.status().commands).toMatchObject({ total: 1, open: 1 });

		const second = harness({}, { file, prompt });
		expect(await second.service.load()).toEqual({ ok: true, commands: 1, recoveredUnknown: 1 });
		expect(second.service.ledger.get('cmd-p')).toMatchObject({
			state: 'unknown',
			detail: 'The host restarted while this command was accepted.',
		});
		await second.service.settle('cmd-p', {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(second.service.ledger.get('cmd-p')).toMatchObject({ state: 'unknown' });
		expect(await receive(second, operatorPromptCommand())).toMatchObject({
			status: 'unknown',
			duplicate: true,
		});
		expect(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toContain('say hi');

		fs.rmSync(file);
		const third = harness({}, { file, prompt });
		expect(await third.service.load()).toEqual({ ok: true, commands: 0, recoveredUnknown: 0 });
		expect(third.service.ledger.get('cmd-p')).toBeNull();
		await expectDenied(third, command(), 'stale-run', 'this host knows no run run-1');

		fs.writeFileSync(file, '{not json');
		const fourth = harness({}, { file });
		expect(await fourth.service.load()).toMatchObject({ ok: false, reason: 'corrupt', file });
		await fourth.lease('run-1', 'req-1');
		expect(fourth.service.status()).toMatchObject({
			loaded: false,
			load: { ok: false, reason: 'corrupt' },
		});
		expect(await receive(fourth, command())).toMatchObject({ status: 'unavailable' });
		expect(liveRuns(fourth)).toEqual(['run-1']);
		expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
	});

	it('over the real lifecycle, client and fake daemon: a registered standing whose record names no actor refuses report_status unauthenticated and records nothing; unavailable after close (CP-01/CP-04)', async () => {
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution'],
			now: () => NOW,
		});
		const { lifecycle, policy, host } = await startRegisteredLifecycle({
			dir: tempDir(),
			socketPath: fake.socketPath,
			supported: ['execution'],
		});
		const dispatch = createBrokerDispatch({ host, now: () => NOW });
		const service = createCommandService({
			installation: INSTALLATION,
			lifecycle,
			host,
			policy,
			dispatch,
			inventory: { snapshot: inventory },
			now: () => NOW,
		});
		try {
			expect(lifecycle.status()).toMatchObject({
				authority: 'registered',
				identity: { record: { registration: { actorId: null } } },
			});
			expect(service.status()).toMatchObject({ file: null, loaded: true, standing: { ok: true } });
			expect(await service.receive(onRuntime('cmd-r', { kind: 'report-status' }))).toMatchObject({
				status: 'denied',
				reason: 'unauthenticated',
				detail: expect.stringContaining('names no actor'),
			});
			expect(service.ledger.list()).toEqual([]);
			await lifecycle.close();
			expect(service.status().standing).toMatchObject({ ok: false });
			expect(await service.receive(command())).toMatchObject({ status: 'unavailable' });
			expect(service.ledger.list()).toEqual([]);
		} finally {
			await lifecycle.close();
			await fake.close();
		}
	});
});
