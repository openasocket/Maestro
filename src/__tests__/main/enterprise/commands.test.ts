/**
 * The desktop command service (`src/main/enterprise/commands.ts`) over a real
 * local authority and a doubled, mutable standing, with the ledger in memory
 * unless a file is named.
 *
 * Endpoint commands arrive as v2 `commandRequestV2` deliveries through
 * `receive()`, and every answer is the exact `commandReceiptV2` (or the local
 * `denied`), checked against the pinned `@mega-maestro/contracts` schemas. The
 * wire carries cancel, pause, resume and operator_prompt only; report_status and
 * refresh_policy are local operator actions (`issueLocal`). The local receipt
 * names the published reason, so a refusal the wire cannot name (`stale-run`,
 * `approval-required`) answers `policy_denied`; the exact refusal is kept by the
 * ledger only once a command was accepted.
 *
 * The schemas require UUID ids, so this file derives its ids from labels
 * (`uuidOf`) and builds every typed command and standing from them; the
 * installation, runtime and process epoch keep the `fakeManaged` values. Local
 * evidence only: nothing here verifies a signature, and no paired or native
 * claim is made.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	COMMAND_CORRELATION_FEATURE,
	createCommandService,
	LOCAL_COMMAND_ID_PREFIX,
	type CommandServiceDeps,
} from '../../../main/enterprise/commands';
import { createBrokerDispatch } from '../../../main/enterprise/dispatch';
import type { InstallationInventory } from '../../../main/enterprise/inventory';
import {
	createLocalHostAuthority,
	type DispatchLease,
} from '../../../shared/maestro-lib/managed/authority';
import {
	COOPERATIVE_PAUSE_MODE,
	MANAGED_COMMAND_LEDGER_FILE_NAME,
	type CommandReceiptV2,
	type LocalCommandDenial,
	type ManagedRuntimeCommand,
} from '../../../shared/maestro-lib/managed/commands';
import { projectPolicyStatus } from '../../../shared/maestro-lib/managed/host-adapter';
import { startFakeEndpoint } from './fakeEndpoint';
import {
	CONTRACT_IDS,
	DEFAULT_RECIPIENT,
	ENVELOPE_DIGEST,
	NEGOTIATED_V2,
	operatorPromptOf,
	runCommand,
	typedCommand,
	uuidOf,
	type WireRequest,
	wireOf,
} from './commandWire';
import {
	DIGEST_A,
	INSTALLATION,
	type ManagedStandingInput,
	NOW,
	REGISTERED_STANDING,
	registeredStatus,
	runAdmission,
	startRegisteredLifecycle,
	tempDirs,
} from './fakeManaged';

let protocol: typeof import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');
let endpoint: typeof import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
beforeAll(async () => {
	protocol = await import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');
	endpoint = await import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
});

const tempDir = tempDirs('mrc-11-06a-');

const REVOKED = 'The endpoint revoked this registration.';
const ENVELOPE = ENVELOPE_DIGEST;
const WIRE_V2 = NEGOTIATED_V2;
const TENANT = CONTRACT_IDS.tenantId;
const ISSUER = CONTRACT_IDS.issuerId;
const ENROLLMENT = CONTRACT_IDS.enrollmentId;
const ACTOR = CONTRACT_IDS.actorId;
const CHALLENGE = CONTRACT_IDS.challengeId;
const RUN1 = CONTRACT_IDS.runId;
const RUN2 = uuidOf('run-2');
const REGISTERED = { ...REGISTERED_STANDING, actorId: ACTOR };
const BASE_RECIPIENT = DEFAULT_RECIPIENT;
const BASE_PRE = { policyRevision: 3, policyDigest: null, bindingDigest: null };
const cmd = typedCommand;
const onRun1 = runCommand;
const operatorPrompt = () => operatorPromptOf();
type Wire = WireRequest;

/** Only the fields `report` reads; the rest of the inventory is not the command service's. */
const inventory = () =>
	({
		at: new Date(NOW).toISOString(),
		installation: INSTALLATION,
		versions: {
			app: '1.1.0',
			library: '0.24.0',
			contract: '1',
			endpointProtocol: 2,
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

type RefreshAnswer = Awaited<ReturnType<CommandServiceDeps['policy']['refresh']>>;

/**
 * A doubled, mutable standing over a real local authority; the ledger in memory
 * unless a file is named. The standing's record carries this file's contract ids.
 */
function harness(
	over: Partial<ManagedStandingInput> = {},
	opts: Partial<
		Pick<CommandServiceDeps, 'file' | 'prompt' | 'cooperativePause' | 'commandWire'>
	> = {}
) {
	const state: ManagedStandingInput = { ...REGISTERED, ...over };
	const standing = () => {
		const status = registeredStatus(state);
		const record = status.identity.record!;
		record.tenantId = TENANT;
		record.enrollmentId = ENROLLMENT;
		record.registration!.challengeId = CHALLENGE;
		return status;
	};
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
		commandWire: WIRE_V2,
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

const send = (h: Harness, raw: unknown) => h.service.receive(raw);
const liveRuns = (h: Harness) => h.authority.live().map((lease) => lease.runId);

/** The receipt a delivery earns, exactly: its ids, its outcome, its correlation echoed, and the pinned schema. */
function expectAnswer(
	receipt: CommandReceiptV2,
	sent: Wire,
	outcome: 'accepted' | 'completed' | 'unknown'
) {
	const p = sent.command.payload;
	expect(receipt).toEqual({
		outcome,
		commandId: p.commandId,
		runId: p.recipient.runId,
		processEpoch: p.recipient.processEpoch,
		correlation: sent.correlation,
	});
	expect(protocol.commandReceiptV2.safeParse(receipt).success).toBe(true);
}

/** A local `denied` with the published reason, and the pinned denied schema. */
async function expectDenied(h: Harness, raw: unknown, reason: LocalCommandDenial) {
	const receipt = await send(h, raw);
	expect(receipt).toEqual({ outcome: 'denied', reason });
	expect(endpoint.denied.safeParse(receipt).success).toBe(true);
}

describe('the desktop command service over v2 deliveries', () => {
	it('cancels a run by revoking its live lease: completed with the revoked lease, the duplicate answers from history, an ended run is no-effect, an unknown run is stale and recorded nothing', async () => {
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
		const lease = await h.lease(RUN1, 'req-1');
		const stopped: string[] = [];
		lease.onRevoked((reason) => stopped.push(reason));
		const cancel = wireOf(cmd('cmd-1'));
		expectAnswer(await send(h, cancel), cancel, 'completed');
		expect(lease.state()).toBe('revoked');
		expect(stopped).toEqual([`cancel_run ${uuidOf('cmd-1')} issued by ${ISSUER}`]);
		expect(liveRuns(h)).toEqual([]);
		expect(h.service.ledger.get(uuidOf('cmd-1'))).toMatchObject({
			state: 'completed',
			runId: RUN1,
		});
		// The same delivery again is answered from history; nothing is revoked twice.
		expectAnswer(await send(h, cancel), cancel, 'completed');
		expect(stopped).toHaveLength(1);
		// A new command on the ended run: the receipts know it, no lease is live, so no-effect settles.
		const ended = wireOf(cmd('cmd-2'));
		expectAnswer(await send(h, ended), ended, 'completed');
		expect(h.service.ledger.get(uuidOf('cmd-2'))).toMatchObject({ state: 'no-effect' });
		// A run this host never saw is stale: refused on the wire, no record.
		await expectDenied(
			h,
			wireOf(cmd('cmd-3', { recipient: { ...BASE_RECIPIENT, runId: uuidOf('run-9') } })),
			'policy_denied'
		);
		expect(h.service.ledger.get(uuidOf('cmd-3'))).toBeNull();
		expect(h.service.status().commands).toMatchObject({ total: 2, open: 0 });
	});

	it('reports status through the local path as metadata: never a path, a model or a prompt', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const answer = await h.service.issueLocal({ kind: 'report-status' });
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
		expect(liveRuns(h)).toEqual([RUN1]);
	});

	it('the v2 wire carries only cancel, pause, resume and operator_prompt: report_status and refresh_policy are refused invalid_request and recorded nothing', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const onRuntime = (label: string, action: ManagedRuntimeCommand['action']) =>
			cmd(label, {
				action,
				recipient: { ...BASE_RECIPIENT, runId: null },
				preconditions: {
					...BASE_PRE,
					requiredCapability: `command-${action.kind.replace('-', '_')}`,
				},
			});
		await expectDenied(h, wireOf(onRuntime('cmd-r', { kind: 'report-status' })), 'invalid_request');
		await expectDenied(
			h,
			wireOf(onRuntime('cmd-f', { kind: 'refresh-policy', desiredRevision: 3 })),
			'invalid_request'
		);
		expect(h.service.ledger.list()).toEqual([]);
		expect(liveRuns(h)).toEqual([RUN1]);
	});

	it('refuses a replay (the id under another payload or envelope, a nonce or a key another command consumed) and revokes nothing for one', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const first = cmd('cmd-1');
		const firstWire = wireOf(first);
		expectAnswer(await send(h, firstWire), firstWire, 'completed');
		await expectDenied(h, wireOf(cmd('cmd-1', { payloadDigest: 'b'.repeat(64) })), 'replay');
		await expectDenied(h, wireOf(first, { envelope: '9'.repeat(64) }), 'replay');
		await h.lease(RUN2, 'req-2');
		const onRun2 = (over: Partial<ManagedRuntimeCommand> = {}) =>
			cmd('cmd-2', { recipient: { ...BASE_RECIPIENT, runId: RUN2 }, ...over });
		await expectDenied(h, wireOf(onRun2({ nonce: first.nonce })), 'replay');
		await expectDenied(h, wireOf(onRun2({ idempotencyKey: first.idempotencyKey })), 'replay');
		expect(h.service.ledger.get(uuidOf('cmd-2'))).toBeNull();
		expect(liveRuns(h)).toEqual([RUN2]);
		const second = wireOf(onRun2());
		expectAnswer(await send(h, second), second, 'completed');
		expect(liveRuns(h)).toEqual([]);
		expect(h.service.status().commands).toMatchObject({ total: 2, byState: { completed: 2 } });
	});

	it('refuses a stale epoch, tenant, enrollment or runtime, a lapsed window, another actor, an uncomposed action and an untyped one, recording nothing', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const to = (recipient: Partial<ManagedRuntimeCommand['recipient']>) =>
			wireOf(cmd('cmd-1', { recipient: { ...BASE_RECIPIENT, ...recipient } }));
		await expectDenied(h, to({ processEpoch: 'epoch-0' }), 'policy_denied');
		await expectDenied(h, wireOf(cmd('cmd-1', { tenantId: uuidOf('tenant-2') })), 'policy_denied');
		await expectDenied(h, to({ enrollmentId: uuidOf('enr-0') }), 'policy_denied');
		await expectDenied(h, to({ runtimeId: 'desktop-7' }), 'policy_denied');
		await expectDenied(
			h,
			wireOf(cmd('cmd-1', { expiresAt: new Date(NOW - 1).toISOString() })),
			'expired'
		);
		await expectDenied(h, to({ actorId: uuidOf('actor-2') }), 'unauthenticated');
		const pause = cmd('cmd-1', {
			action: { kind: 'pause-run' },
			preconditions: { ...BASE_PRE, requiredCapability: 'command-pause_run' },
		});
		await expectDenied(h, wireOf(pause), 'unsupported_capability');
		// No prompt port is composed, so an operator prompt never binds here, approved or not.
		await expectDenied(h, wireOf(operatorPrompt()), 'unsupported_capability');
		// An untyped action is not a command at all.
		await expectDenied(
			h,
			wireOf(cmd('cmd-1'), { action: { kind: 'shell', script: 'rm -rf /' } }),
			'invalid_request'
		);
		expect(await send(h, 'cancel run-1')).toEqual({ outcome: 'denied', reason: 'invalid_request' });
		expect(liveRuns(h)).toEqual([RUN1]);
		expect(h.service.ledger.list()).toEqual([]);
	});

	it('answers history before authority: a known id answers under a revoked standing, a new command is unavailable; no actor and a policy behind are refused', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const cancel = wireOf(cmd('cmd-1'));
		expectAnswer(await send(h, cancel), cancel, 'completed');
		Object.assign(h.state, { authority: 'none', reason: REVOKED });
		expect(h.service.status().standing).toEqual({ ok: false, reason: REVOKED });
		expectAnswer(await send(h, cancel), cancel, 'completed');
		await expectDenied(h, wireOf(cmd('cmd-2')), 'unavailable');
		expect(h.service.ledger.get(uuidOf('cmd-2'))).toBeNull();
		Object.assign(h.state, { ...REGISTERED, actorId: null });
		await h.lease(RUN2, 'req-2');
		const onRun2 = wireOf(cmd('cmd-2', { recipient: { ...BASE_RECIPIENT, runId: RUN2 } }));
		await expectDenied(h, onRun2, 'unauthenticated');
		Object.assign(h.state, { actorId: ACTOR, applied: 7 });
		await expectDenied(h, onRun2, 'policy_denied');
		expect(liveRuns(h)).toEqual([RUN2]);
		expect(h.service.ledger.get(uuidOf('cmd-2'))).toBeNull();
	});

	it('refreshes policy through the status service on the local path: completed when the endpoint applies the desired revision, failed with both named otherwise or when the re-attach did not complete', async () => {
		const h = harness();
		const refresh = (desiredRevision: number) =>
			h.service.issueLocal({ kind: 'refresh-policy', desiredRevision });
		expect(await refresh(3)).toMatchObject({
			status: 'completed',
			detail: 'the endpoint applies revision 3',
			facts: { desiredRevision: 3, before: { desired: 3, applied: 3 }, after: { applied: 3 } },
		});
		expect(await refresh(5)).toMatchObject({
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
		expect(await refresh(5)).toMatchObject({
			status: 'completed',
			facts: { before: { applied: 3 }, after: { desired: 5, applied: 5 } },
		});
		h.setRefresh({ status: 'unavailable', message: 'socket gone' });
		expect(await refresh(3)).toMatchObject({
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
		await h.lease(RUN1, 'req-1');
		const approved = operatorPrompt();
		await expectDenied(
			h,
			wireOf({ ...approved, approval: { kind: 'policy-not-required', policyRevision: 3 } }),
			'policy_denied'
		);
		await expectDenied(
			h,
			wireOf({ ...approved, approval: { ...approved.approval, payloadDigest: 'b'.repeat(64) } }),
			'policy_denied'
		);
		expect(prompts).toEqual([]);
		expect(h.service.ledger.list()).toEqual([]);

		const sent = wireOf(approved);
		expectAnswer(await send(h, sent), sent, 'accepted');
		expect(prompts).toEqual([{ text: 'say hi', runId: RUN1 }]);
		expect(h.service.ledger.get(uuidOf('cmd-p'))).toMatchObject({
			state: 'accepted',
			kind: 'operator-prompt',
			runId: RUN1,
		});
		expect(JSON.stringify(h.service.ledger.list())).not.toContain('say hi');
		expectAnswer(await send(h, sent), sent, 'accepted');
		expect(prompts).toHaveLength(1);
		await h.service.settle(uuidOf('cmd-p'), {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(h.service.ledger.get(uuidOf('cmd-p'))).toMatchObject({
			state: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(h.service.status().commands).toMatchObject({ total: 1, open: 0 });
		expect(liveRuns(h)).toEqual([RUN1]);
	});

	it('keeps the ledger across processes: unavailable until loaded, an accepted prompt turns unknown on restart and a late settle never rewrites it, a deleted file forgets, a corrupt one is named', async () => {
		const prompt: CommandServiceDeps['prompt'] = async () => ({ outcome: 'accepted' });
		const file = path.join(tempDir(), MANAGED_COMMAND_LEDGER_FILE_NAME);
		const first = harness({}, { file, prompt });
		await first.lease(RUN1, 'req-1');
		expect(first.service.status()).toMatchObject({ loaded: false, file, standing: { ok: true } });
		expect(await send(first, wireOf(cmd('cmd-1')))).toEqual({
			outcome: 'denied',
			reason: 'unavailable',
		});
		expect(liveRuns(first)).toEqual([RUN1]);
		expect(await first.service.load()).toEqual({ ok: true, commands: 0, recoveredUnknown: 0 });
		const prompted = wireOf(operatorPrompt());
		expectAnswer(await send(first, prompted), prompted, 'accepted');
		expect(first.service.status().commands).toMatchObject({ total: 1, open: 1 });

		const second = harness({}, { file, prompt });
		expect(await second.service.load()).toEqual({ ok: true, commands: 1, recoveredUnknown: 1 });
		expect(second.service.ledger.get(uuidOf('cmd-p'))).toMatchObject({
			state: 'unknown',
			detail: 'The host restarted while this command was accepted.',
		});
		await second.service.settle(uuidOf('cmd-p'), {
			state: 'settled',
			outcome: 'completed',
			evidenceDigest: DIGEST_A,
		});
		expect(second.service.ledger.get(uuidOf('cmd-p'))).toMatchObject({ state: 'unknown' });
		expectAnswer(await send(second, prompted), prompted, 'unknown');
		expect(JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')))).not.toContain('say hi');

		fs.rmSync(file);
		const third = harness({}, { file, prompt });
		expect(await third.service.load()).toEqual({ ok: true, commands: 0, recoveredUnknown: 0 });
		expect(third.service.ledger.get(uuidOf('cmd-p'))).toBeNull();
		await expectDenied(third, wireOf(cmd('cmd-1')), 'policy_denied');

		fs.writeFileSync(file, '{not json');
		const fourth = harness({}, { file });
		expect(await fourth.service.load()).toMatchObject({ ok: false, reason: 'corrupt', file });
		await fourth.lease(RUN1, 'req-1');
		expect(fourth.service.status()).toMatchObject({
			loaded: false,
			load: { ok: false, reason: 'corrupt' },
		});
		expect(await send(fourth, wireOf(cmd('cmd-1')))).toEqual({
			outcome: 'denied',
			reason: 'unavailable',
		});
		expect(liveRuns(fourth)).toEqual([RUN1]);
		expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
	});

	it('over the real lifecycle, client and fake daemon: a registered standing whose record names no actor refuses a cancel unauthenticated and records nothing, and both paths are unavailable after close (CP-01/CP-04)', async () => {
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
			commandWire: WIRE_V2,
		});
		try {
			expect(lifecycle.status()).toMatchObject({
				authority: 'registered',
				identity: { record: { registration: { actorId: null } } },
			});
			expect(service.status()).toMatchObject({ file: null, loaded: true, standing: { ok: true } });
			// The record's own tenant, enrollment and challenge: only the actor is missing (CP-01/CP-04).
			const record = lifecycle.status().identity.record!;
			const cancel = wireOf(
				cmd('cmd-1', {
					tenantId: record.tenantId,
					recipient: { ...BASE_RECIPIENT, enrollmentId: record.enrollmentId },
				}),
				{ challengeId: record.registration!.challengeId }
			);
			expect(await service.receive(cancel)).toEqual({
				outcome: 'denied',
				reason: 'unauthenticated',
			});
			expect(await service.issueLocal({ kind: 'report-status' })).toMatchObject({
				status: 'denied',
				commandId: null,
				reason: 'unauthenticated',
				detail: expect.stringContaining('names no actor'),
			});
			expect(service.ledger.list()).toEqual([]);
			await lifecycle.close();
			expect(service.status().standing).toMatchObject({ ok: false });
			expect(await service.receive(cancel)).toEqual({ outcome: 'denied', reason: 'unavailable' });
			expect(service.ledger.list()).toEqual([]);
		} finally {
			await lifecycle.close();
			await fake.close();
		}
	});

	it('the request fixtures are valid under the pinned commandRequestV2 for every wire action', () => {
		for (const typed of [
			cmd('cmd-1'),
			onRun1('p1', 'pause-run'),
			onRun1('r1', 'resume-run'),
			operatorPrompt(),
		]) {
			expect(protocol.commandRequestV2.safeParse(wireOf(typed)).error).toBeUndefined();
		}
	});

	it('refuses a delivery the attachment did not negotiate as v2, recording nothing', async () => {
		for (const commandWire of [
			() => null,
			() => ({ protocol: 1, features: [COMMAND_CORRELATION_FEATURE] }),
			() => ({ protocol: 2, features: [] }),
			undefined,
		]) {
			const h = harness({}, { commandWire });
			await expectDenied(h, wireOf(cmd('cmd-1')), 'unsupported_version');
			expect(h.service.ledger.list()).toHaveLength(0);
		}
	});

	it('refuses a delivery for another registration challenge or a malformed one, recording nothing', async () => {
		const h = harness();
		await expectDenied(
			h,
			wireOf(cmd('cmd-1'), { challengeId: uuidOf('challenge-other') }),
			'unauthenticated'
		);
		const broken = wireOf(cmd('cmd-1'));
		broken.correlation.registration.processEpoch = 'epoch-2';
		await expectDenied(h, broken, 'invalid_request');
		await expectDenied(h, { command: {} }, 'invalid_request');
		expect(h.service.ledger.list()).toHaveLength(0);
	});
});

describe('cooperative task-boundary pause over v2 deliveries (MCOMP-29-01)', () => {
	it('pauses at the next task boundary, then resumes, with exact receipts', async () => {
		const h = harness({}, { cooperativePause: true });
		expect(h.service.capabilities()).toEqual(
			expect.arrayContaining(['command-pause_run', 'command-resume_run'])
		);
		const run = h.service.runControl!.track(RUN1);
		const pause = wireOf(onRun1('p1', 'pause-run'));
		expectAnswer(await send(h, pause), pause, 'accepted');
		expect(h.service.ledger.get(uuidOf('p1'))).toMatchObject({
			state: 'accepted',
			delivery: {
				requestId: `req-${uuidOf('p1')}`,
				attemptId: `att-${uuidOf('p1')}`,
				envelopeDigest: ENVELOPE,
				challengeId: CHALLENGE,
			},
		});
		expect(h.service.runControl!.state(RUN1)).toBe('pause-requested');

		let verdict: string | null = null;
		const parked = run.atBoundary().then((v) => (verdict = v));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(verdict).toBeNull();
		expect(h.service.runControl!.state(RUN1)).toBe('paused');
		expect(h.service.ledger.get(uuidOf('p1'))).toMatchObject({ state: 'completed' });

		// The same envelope again answers what the ledger holds now, echoing its own correlation.
		const again = { ...pause, correlation: { ...pause.correlation, attemptId: 'att-retry' } };
		expectAnswer(await send(h, again), again, 'completed');
		// A re-signed envelope under the same id is a replay.
		await expectDenied(
			h,
			wireOf(onRun1('p1', 'pause-run'), { envelope: '9'.repeat(64) }),
			'replay'
		);

		const resume = wireOf(onRun1('r1', 'resume-run'));
		expectAnswer(await send(h, resume), resume, 'completed');
		await parked;
		expect(verdict).toBe('continue');
		expect(h.service.runControl!.state(RUN1)).toBe('running');
		expect(await run.atBoundary()).toBe('continue');
	});

	it('a resume before the boundary withdraws the pause, which settles no-effect', async () => {
		const h = harness({}, { cooperativePause: true });
		const run = h.service.runControl!.track(RUN1);
		await send(h, wireOf(onRun1('p1', 'pause-run')));
		const resume = wireOf(onRun1('r1', 'resume-run'));
		expectAnswer(await send(h, resume), resume, 'completed');
		expect(h.service.ledger.get(uuidOf('p1'))?.state).toBe('no-effect');
		expect(await run.atBoundary()).toBe('continue');
	});

	it('a run that ends before its boundary settles the pending pause no-effect', async () => {
		const h = harness({}, { cooperativePause: true });
		const run = h.service.runControl!.track(RUN1);
		await send(h, wireOf(onRun1('p1', 'pause-run')));
		await run.end();
		expect(h.service.ledger.get(uuidOf('p1'))?.state).toBe('no-effect');
		expect(h.service.runControl!.state(RUN1)).toBeNull();
	});

	it('cancel releases a parked run with stop, holding no lease', async () => {
		const h = harness({}, { cooperativePause: true });
		const run = h.service.runControl!.track(RUN1);
		await send(h, wireOf(onRun1('p1', 'pause-run')));
		const parked = run.atBoundary();
		const cancel = wireOf(cmd('cmd-1'));
		expectAnswer(await send(h, cancel), cancel, 'completed');
		expect(await parked).toBe('stop');
		expect(await run.atBoundary()).toBe('stop');
		expect(h.service.ledger.get(uuidOf('cmd-1'))?.state).toBe('completed');
	});

	it('uncomposed, pause and resume stay unsupported by name, recording nothing', async () => {
		const h = harness();
		expect(h.service.runControl).toBeNull();
		expect(h.service.capabilities()).not.toContain('command-pause_run');
		expect(h.service.unsupported().map((u) => u.kind)).toEqual(
			expect.arrayContaining(['pause-run', 'resume-run'])
		);
		await expectDenied(h, wireOf(onRun1('p1', 'pause-run')), 'unsupported_capability');
		expect(h.service.ledger.list()).toEqual([]);
	});
});

describe('local operator path (MRC2-07-02, MCOMP-29-03B)', () => {
	it('issues a local cancel through the same executor and ledger: completed under a local- id, the revoked lease gone, the run unknown afterwards', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const cancel = await h.service.issueLocal({ kind: 'cancel-run', runId: RUN1 });
		expect(cancel).toMatchObject({
			status: 'completed',
			commandId: expect.stringMatching(/^local-/),
			duplicate: false,
			evidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(liveRuns(h)).toEqual([]);
		expect(h.service.ledger.get(cancel.commandId!)).toMatchObject({
			kind: 'cancel-run',
			runId: RUN1,
			actorId: ACTOR,
			policyRevision: 3,
			state: 'completed',
		});
		expect(
			await h.service.issueLocal({ kind: 'cancel-run', runId: uuidOf('run-9') })
		).toMatchObject({
			status: 'denied',
			reason: 'stale-run',
			detail: expect.stringContaining(uuidOf('run-9')),
		});
		expect(await h.service.issueLocal({ kind: 'report-status' })).toMatchObject({
			status: 'completed',
			facts: expect.objectContaining({ runs: { live: 0, liveLeases: 0, receipts: 1 } }),
		});
	});

	it('refuses a local command with no actor as unauthenticated and with no standing as unavailable, recording nothing', async () => {
		const h = harness();
		await h.lease(RUN1, 'req-1');
		const recorded = h.service.ledger.list().length;
		h.state.actorId = null;
		expect(await h.service.issueLocal({ kind: 'report-status' })).toMatchObject({
			status: 'denied',
			commandId: null,
			reason: 'unauthenticated',
			detail: expect.stringContaining('names no actor'),
		});
		h.state.actorId = ACTOR;
		h.state.authority = 'revoked';
		h.state.reason = REVOKED;
		expect(await h.service.issueLocal({ kind: 'report-status' })).toMatchObject({
			status: 'unavailable',
			commandId: null,
			detail: expect.stringContaining(REVOKED),
		});
		expect(h.service.ledger.list()).toHaveLength(recorded);
	});

	it('a local pause binds its run, answers accepted with the cooperative label, and parks the run at its boundary', async () => {
		const h = harness({}, { cooperativePause: true });
		const run = h.service.runControl!.track(RUN1);
		const pause = await h.service.issueLocal({ kind: 'pause-run', runId: RUN1 });
		expect(pause).toMatchObject({
			status: 'accepted',
			facts: { runId: RUN1, mode: COOPERATIVE_PAUSE_MODE, osSuspension: false },
		});
		const record = h.service.ledger.get(pause.commandId!);
		expect(record).toMatchObject({ runId: RUN1, kind: 'pause-run', delivery: null });
		expect(record?.commandId.startsWith(LOCAL_COMMAND_ID_PREFIX)).toBe(true);

		let verdict: string | null = null;
		const parked = run.atBoundary().then((v) => (verdict = v));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(verdict).toBeNull();
		expect(h.service.ledger.get(pause.commandId!)?.state).toBe('completed');

		const resume = await h.service.issueLocal({ kind: 'resume-run', runId: RUN1 });
		expect(resume.status).toBe('completed');
		await parked;
		expect(verdict).toBe('continue');
	});

	it('a run this host does not track is refused stale-run, not approximated', async () => {
		const h = harness({}, { cooperativePause: true });
		const pause = await h.service.issueLocal({ kind: 'pause-run', runId: uuidOf('run-unknown') });
		expect(pause).toMatchObject({ status: 'denied', reason: 'stale-run' });
	});

	it('a host without cooperativePause refuses both unsupported-capability by name, recording nothing', async () => {
		const h = harness();
		for (const kind of ['pause-run', 'resume-run'] as const) {
			const execution = await h.service.issueLocal({ kind, runId: RUN1 });
			expect(execution).toMatchObject({
				status: 'denied',
				commandId: null,
				reason: 'unsupported-capability',
				detail: expect.stringContaining(
					`command-${kind === 'pause-run' ? 'pause_run' : 'resume_run'}`
				),
			});
		}
		expect(h.service.ledger.list()).toEqual([]);
	});
});

describe('command journeys over the durable ledger (MCOMP-29-04)', () => {
	it('offline, pause, duplicate, foreign actor, boundary, resume, refresh, then a restart with a pause in flight', async () => {
		const file = path.join(tempDir(), MANAGED_COMMAND_LEDGER_FILE_NAME);
		const first = harness({}, { file, cooperativePause: true });
		expect(await first.service.load()).toMatchObject({ ok: true, commands: 0 });
		const control = first.service.runControl!;
		const run = control.track(RUN1);

		// Offline: a new command finds no authority and is not recorded; the endpoint redelivers it.
		const OFFLINE = 'The endpoint socket is unreachable.';
		Object.assign(first.state, { authority: 'none', reason: OFFLINE });
		const p1 = wireOf(onRun1('p1', 'pause-run'));
		expect(await send(first, p1)).toEqual({ outcome: 'denied', reason: 'unavailable' });
		expect(first.service.ledger.get(uuidOf('p1'))).toBeNull();
		expect(control.state(RUN1)).toBe('running');

		// Back online, the same delivery executes once.
		Object.assign(first.state, REGISTERED);
		expectAnswer(await send(first, p1), p1, 'accepted');
		expectAnswer(await send(first, p1), p1, 'accepted');

		// The run belongs to this actor and process: another actor or epoch cannot resume it.
		const foreign = onRun1('r0', 'resume-run');
		await expectDenied(
			first,
			wireOf({ ...foreign, recipient: { ...foreign.recipient, actorId: uuidOf('actor-2') } }),
			'unauthenticated'
		);
		await expectDenied(
			first,
			wireOf({ ...foreign, recipient: { ...foreign.recipient, processEpoch: 'epoch-0' } }),
			'policy_denied'
		);
		expect(first.service.ledger.get(uuidOf('r0'))).toBeNull();

		// The task in flight finishes; the run parks at its next boundary and the pause completes.
		let verdict: string | null = null;
		const parked = run.atBoundary().then((v) => (verdict = v));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(verdict).toBeNull();
		expect(first.service.ledger.get(uuidOf('p1'))).toMatchObject({ state: 'completed' });
		const r1 = wireOf(onRun1('r1', 'resume-run'));
		expectAnswer(await send(first, r1), r1, 'completed');
		await parked;
		expect(verdict).toBe('continue');

		const refreshed = await first.service.issueLocal({
			kind: 'refresh-policy',
			desiredRevision: 3,
		});
		expect(refreshed).toMatchObject({ status: 'completed' });

		// A second pause is still waiting for its boundary when the process goes away.
		const p2 = wireOf(onRun1('p2', 'pause-run'));
		expectAnswer(await send(first, p2), p2, 'accepted');
		const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
		expect(JSON.stringify(onDisk)).toContain(uuidOf('p2'));

		const second = harness({}, { file, cooperativePause: true });
		expect(await second.service.load()).toEqual({ ok: true, commands: 4, recoveredUnknown: 1 });
		expect(second.service.ledger.get(uuidOf('p2'))).toMatchObject({
			state: 'unknown',
			detail: 'The host restarted while this command was accepted.',
		});
		// The redelivered pause is answered from history, never executed again.
		expectAnswer(await send(second, p2), p2, 'unknown');
		// The new process owns no run-1: a fresh pause or cancel is stale by name on the wire.
		expect(second.service.runControl!.state(RUN1)).toBeNull();
		await expectDenied(second, wireOf(onRun1('p3', 'pause-run')), 'policy_denied');
		await expectDenied(second, wireOf(onRun1('c1', 'cancel-run')), 'policy_denied');
		expect(second.service.ledger.list().map((r) => [r.commandId, r.state])).toEqual([
			[uuidOf('p1'), 'completed'],
			[uuidOf('r1'), 'completed'],
			[refreshed.commandId!, 'completed'],
			[uuidOf('p2'), 'unknown'],
		]);
	});
});
