/**
 * MCOMP-29-01: v2 `command` deliveries consumed by the desktop command service, and the
 * cooperative task-boundary pause. The request fixtures parse under the pinned
 * `@mega-maestro/contracts` `commandRequestV2`, and every receipt parses under
 * `commandReceiptV2` (or the local `denied`) with the request's correlation echoed exactly.
 * Local evidence only: the endpoint is not running, nothing verifies a signature here, and no
 * paired or native claim is made.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
	COMMAND_CORRELATION_FEATURE,
	createCommandService,
	LOCAL_COMMAND_ID_PREFIX,
	type CommandServiceDeps,
} from '../../../main/enterprise/commands';
import { createLocalHostAuthority } from '../../../shared/maestro-lib/managed/authority';
import {
	COOPERATIVE_PAUSE_MODE,
	readCommandRequestV2,
	type CommandReceiptV2,
} from '../../../shared/maestro-lib/managed/commands';
import { projectPolicyStatus } from '../../../shared/maestro-lib/managed/host-adapter';
import { INSTALLATION, NOW, registeredStatus } from './fakeManaged';

let protocol: typeof import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');
let endpoint: typeof import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
beforeAll(async () => {
	protocol = await import('../../../../vendor/mega-maestro/contracts/dist/protocol.js');
	endpoint = await import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const ISSUER = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';
const CHALLENGE = '66666666-6666-4666-8666-666666666666';
const BINDING = 'b'.repeat(64);
const hex = (c: string) => c.repeat(64);
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

/** The registered standing, with the record's ids in the contract's UUID form. */
function standing() {
	const status = registeredStatus();
	const record = status.identity.record!;
	record.tenantId = TENANT;
	record.enrollmentId = ENROLLMENT;
	record.registration!.actorId = ACTOR;
	record.registration!.challengeId = CHALLENGE;
	return status;
}

type Action = 'pause_run' | 'resume_run' | 'cancel_run';
let seq = 0;
/** A `commandRequestV2` for run-1 of this process, as the pinned contract shapes it. */
function request(
	action: Action,
	over: { envelope?: string; challengeId?: string; n?: number } = {}
) {
	const n = over.n ?? ++seq;
	return {
		command: {
			payload: {
				schemaVersion: 1,
				commandId: uuid(n),
				tenantId: TENANT,
				issuerId: ISSUER,
				recipient: {
					actorId: ACTOR,
					enrollmentId: ENROLLMENT,
					installationId: INSTALLATION.installationId,
					runtimeId: INSTALLATION.runtimeId,
					processEpoch: INSTALLATION.processEpoch,
					runId: 'run-1',
					scope: { kind: 'tenant' },
				},
				action: { kind: action },
				preconditions: {
					policyRevision: 3,
					policyDigest: hex('d'),
					bindingDigest: BINDING,
					requiredCapability: `command-${action}`,
				},
				issuedAt: new Date(NOW - 1_000).toISOString(),
				expiresAt: new Date(NOW + 60_000).toISOString(),
				nonce: String(n % 10).repeat(63) + 'a',
				idempotencyKey: `idem-${n}`,
			},
			payloadDigest: hex(String(n % 10)),
			approval: { kind: 'policy_not_required', policyRevision: 3 },
			keyId: 'key-1',
			algorithm: 'Ed25519',
			signature: 'A'.repeat(86) + '==',
		},
		correlation: {
			registration: {
				version: 2,
				purpose: 'runtime_use',
				tenantId: TENANT,
				orgId: ORG,
				enrollmentId: ENROLLMENT,
				installationId: INSTALLATION.installationId,
				runtimeId: INSTALLATION.runtimeId,
				processEpoch: INSTALLATION.processEpoch,
				bindingDigest: BINDING,
				processBirthDigest: hex('e'),
				challengeId: over.challengeId ?? CHALLENGE,
				challengeDigest: hex('c'),
			},
			delegation: null,
			grants: [],
			requestId: `req-${n}`,
			attemptId: `att-${n}`,
			envelopeDigest: over.envelope ?? hex('f'),
		},
	};
}

function harness(over: Partial<CommandServiceDeps> = {}) {
	const authority = createLocalHostAuthority({
		authorityId: 'auth-1',
		decide: () => ({ decision: 'allow', policyRevision: 3 }),
		now: () => NOW,
		newId: () => 'lease-x',
	});
	let clock = NOW;
	const service = createCommandService({
		installation: INSTALLATION,
		lifecycle: { status: standing },
		host: { policyStatus: () => projectPolicyStatus({ standing: standing(), now: NOW }) },
		policy: { refresh: async () => ({ status: 'ok', value: standing().endpoint! }) },
		dispatch: { authority, receipts: () => [] },
		inventory: { snapshot: () => ({}) as never },
		now: () => clock,
		cooperativePause: true,
		commandWire: () => ({ protocol: 2, features: [COMMAND_CORRELATION_FEATURE] }),
		...over,
	});
	return { service, tick: (ms: number) => (clock += ms) };
}

/** Every receipt must parse under the pinned schemas and echo the request's correlation. */
function expectWire(receipt: CommandReceiptV2, sent: ReturnType<typeof request>) {
	if (receipt.outcome === 'denied') {
		expect(endpoint.denied.safeParse(receipt).success).toBe(true);
		return;
	}
	expect(protocol.commandReceiptV2.safeParse(receipt).success).toBe(true);
	expect(receipt.correlation).toEqual(sent.correlation);
	expect(receipt.commandId).toBe(sent.command.payload.commandId);
}

describe('v2 command deliveries (MCOMP-29-01)', () => {
	it('the request fixtures are valid under the pinned commandRequestV2', () => {
		for (const action of ['pause_run', 'resume_run', 'cancel_run'] as const) {
			expect(protocol.commandRequestV2.safeParse(request(action)).error).toBeUndefined();
		}
	});

	it('refuses a delivery the attachment did not negotiate as v2, recording nothing', async () => {
		for (const commandWire of [
			() => null,
			() => ({ protocol: 1, features: [COMMAND_CORRELATION_FEATURE] }),
			() => ({ protocol: 2, features: [] }),
		]) {
			const { service } = harness({ commandWire });
			const receipt = await service.receiveV2(request('cancel_run'));
			expect(receipt).toEqual({ outcome: 'denied', reason: 'unsupported_version' });
			expect(service.ledger.list()).toHaveLength(0);
		}
		const { service } = harness({ commandWire: undefined });
		expect(await service.receiveV2(request('cancel_run'))).toMatchObject({
			reason: 'unsupported_version',
		});
	});

	it('refuses a delivery for another registration challenge or a malformed one', async () => {
		const { service } = harness();
		const other = request('pause_run', { challengeId: uuid(999) });
		expect(await service.receiveV2(other)).toEqual({
			outcome: 'denied',
			reason: 'unauthenticated',
		});
		const broken = request('pause_run');
		broken.correlation.registration.processEpoch = 'epoch-2';
		expect(await service.receiveV2(broken)).toEqual({
			outcome: 'denied',
			reason: 'invalid_request',
		});
		expect(await service.receiveV2({ command: {} })).toMatchObject({ reason: 'invalid_request' });
		expect(service.ledger.list()).toHaveLength(0);
	});

	it('answers stale-run as the local policy_denied, keeping the exact refusal off the wire only', async () => {
		const { service } = harness();
		const sent = request('cancel_run');
		const receipt = await service.receiveV2(sent);
		expect(receipt).toEqual({ outcome: 'denied', reason: 'policy_denied' });
		expectWire(receipt, sent);
	});

	it('pauses cooperatively at the next task boundary, then resumes, with exact receipts', async () => {
		const { service, tick } = harness();
		expect(service.capabilities()).toEqual(
			expect.arrayContaining(['command-pause_run', 'command-resume_run'])
		);
		const run = service.runControl!.track('run-1');
		const pause = request('pause_run');
		const accepted = await service.receiveV2(pause);
		expect(accepted.outcome).toBe('accepted');
		expectWire(accepted, pause);
		const pauseId = pause.command.payload.commandId;
		expect(service.ledger.get(pauseId)?.state).toBe('accepted');
		expect(service.ledger.get(pauseId)?.delivery).toEqual({
			requestId: pause.correlation.requestId,
			attemptId: pause.correlation.attemptId,
			envelopeDigest: pause.correlation.envelopeDigest,
			challengeId: CHALLENGE,
		});
		expect(service.runControl!.state('run-1')).toBe('pause-requested');

		let verdict: string | null = null;
		const parked = run.atBoundary().then((v) => (verdict = v));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(verdict).toBeNull();
		expect(service.runControl!.state('run-1')).toBe('paused');
		expect(service.ledger.get(pauseId)).toMatchObject({ state: 'completed' });

		// The same delivery again answers what the ledger holds now, echoing its own correlation.
		const again = { ...pause, correlation: { ...pause.correlation, attemptId: 'att-retry' } };
		const duplicate = await service.receiveV2(again);
		expect(duplicate.outcome).toBe('completed');
		expectWire(duplicate, again);
		// A re-signed envelope under the same id is a replay.
		const resigned = { ...pause, correlation: { ...pause.correlation, envelopeDigest: hex('9') } };
		expect(await service.receiveV2(resigned)).toEqual({ outcome: 'denied', reason: 'replay' });

		tick(500);
		const resume = request('resume_run');
		const resumed = await service.receiveV2(resume);
		expect(resumed.outcome).toBe('completed');
		expectWire(resumed, resume);
		await parked;
		expect(verdict).toBe('continue');
		expect(service.runControl!.state('run-1')).toBe('running');
		expect(await run.atBoundary()).toBe('continue');
	});

	it('a resume before the boundary withdraws the pause, which settles no-effect', async () => {
		const { service } = harness();
		const run = service.runControl!.track('run-1');
		const pause = request('pause_run');
		await service.receiveV2(pause);
		expect((await service.receiveV2(request('resume_run'))).outcome).toBe('completed');
		expect(service.ledger.get(pause.command.payload.commandId)?.state).toBe('no-effect');
		expect(await run.atBoundary()).toBe('continue');
	});

	it('a run that ends before its boundary settles the pending pause no-effect', async () => {
		const { service } = harness();
		const run = service.runControl!.track('run-1');
		const pause = request('pause_run');
		await service.receiveV2(pause);
		await run.end();
		expect(service.ledger.get(pause.command.payload.commandId)?.state).toBe('no-effect');
		expect(service.runControl!.state('run-1')).toBeNull();
	});

	it('cancel releases a parked run with stop, holding no lease', async () => {
		const { service } = harness();
		const run = service.runControl!.track('run-1');
		await service.receiveV2(request('pause_run'));
		const parked = run.atBoundary();
		const cancel = request('cancel_run');
		const receipt = await service.receiveV2(cancel);
		expect(receipt.outcome).toBe('completed');
		expectWire(receipt, cancel);
		expect(await parked).toBe('stop');
		expect(await run.atBoundary()).toBe('stop');
		const id = cancel.command.payload.commandId;
		expect(service.ledger.get(id)?.state).toBe('completed');
	});

	it('never claims an OS suspension: every pause answer carries the cooperative label', async () => {
		const { service } = harness();
		service.runControl!.track('run-1');
		const pause = request('pause_run');
		const reading = readCommandRequestV2(pause);
		if (!reading.ok) throw new Error(reading.problems.join('; '));
		// The typed path runs the same port; its facts are what the ledger digest covers.
		const execution = await service.receive(reading.command);
		expect(execution).toMatchObject({
			status: 'accepted',
			facts: { mode: COOPERATIVE_PAUSE_MODE, osSuspension: false },
		});
	});

	it('uncomposed, pause and resume stay unsupported by name', async () => {
		const { service } = harness({ cooperativePause: false });
		expect(service.runControl).toBeNull();
		expect(service.capabilities()).not.toContain('command-pause_run');
		expect(service.unsupported().map((u) => u.kind)).toEqual(
			expect.arrayContaining(['pause-run', 'resume-run'])
		);
		const receipt = await service.receiveV2(request('pause_run'));
		expect(receipt).toEqual({ outcome: 'denied', reason: 'unsupported_capability' });
	});
});

describe('local pause and resume (MCOMP-29-03B)', () => {
	it('a local pause binds its run, answers accepted with the cooperative label, and parks the run at its boundary', async () => {
		const { service } = harness();
		const run = service.runControl!.track('run-1');
		const pause = await service.issueLocal({ kind: 'pause-run', runId: 'run-1' });
		expect(pause).toMatchObject({
			status: 'accepted',
			facts: { runId: 'run-1', mode: COOPERATIVE_PAUSE_MODE, osSuspension: false },
		});
		const record = service.ledger.get(pause.commandId!);
		expect(record).toMatchObject({ runId: 'run-1', kind: 'pause-run', delivery: null });
		expect(record?.commandId.startsWith(LOCAL_COMMAND_ID_PREFIX)).toBe(true);

		let verdict: string | null = null;
		const parked = run.atBoundary().then((v) => (verdict = v));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(verdict).toBeNull();
		expect(service.ledger.get(pause.commandId!)?.state).toBe('completed');

		const resume = await service.issueLocal({ kind: 'resume-run', runId: 'run-1' });
		expect(resume.status).toBe('completed');
		await parked;
		expect(verdict).toBe('continue');
	});

	it('a run this host does not track is refused stale-run, not approximated', async () => {
		const { service } = harness();
		const pause = await service.issueLocal({ kind: 'pause-run', runId: 'run-unknown' });
		expect(pause).toMatchObject({ status: 'denied', reason: 'stale-run' });
	});

	it('a host without cooperativePause refuses both unsupported-capability by name, recording nothing', async () => {
		const { service } = harness({ cooperativePause: false });
		for (const kind of ['pause-run', 'resume-run'] as const) {
			const execution = await service.issueLocal({ kind, runId: 'run-1' });
			expect(execution).toMatchObject({
				status: 'denied',
				commandId: null,
				reason: 'unsupported-capability',
				detail: expect.stringContaining(
					`command-${kind === 'pause-run' ? 'pause_run' : 'resume_run'}`
				),
			});
		}
		expect(service.ledger.list()).toEqual([]);
	});
});
