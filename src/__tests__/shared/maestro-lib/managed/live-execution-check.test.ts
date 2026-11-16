/**
 * The live execution check (`runLiveExecutionCheck`) over a real Unix socket
 * against the fake daemon in `fakeEndpoint.ts`: the order of the handshake,
 * the delegated claim, the execution and the settlement, every request one
 * the pinned 0.3.0 contract parses, and an observation that carries only what
 * was sent or answered. A failing step stops the check and is reported, never
 * papered over.
 *
 * The daemon here is a double, so these observations prove the check's
 * behavior only. A receipt's live fields come from the run against the
 * installed Linux service, never from this suite.
 */

import { createHash } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { canonicalJson } from '../../../../shared/canonicalJson';
import { createLocalEndpointClient } from '../../../../shared/maestro-lib/managed/endpoint-client';
import {
	LIVE_EXECUTION_OBSERVATION_SCHEMA,
	runLiveExecutionCheck,
	type LiveExecutionCheckInput,
} from '../../../../shared/maestro-lib/managed/live-execution-check';
import type {
	EndpointAttachmentRequest,
	EndpointPort,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../../main/enterprise/fakeEndpoint';
import {
	ISSUED,
	projectedRegistrationUse,
	workflowProducer,
} from '../../../main/enterprise/workflowProducer';

const OFFER = [
	'registration_use',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
	'execution',
	'delegation',
];
const ATTACH: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'live-check-1',
	processEpoch: 'epoch-1',
	components: [{ id: 'maestro', kind: 'runtime', version: '0.41.0' }],
	supportedProtocols: [2],
	supportedCapabilities: ['attachment', 'compatibility', ...OFFER],
	requiredCapabilities: [],
};
const ROOT = { grantId: '6f1c2c1e-0000-4000-8000-0000000000c1', digest: '1'.repeat(64) };
const PRESENTED = { grantId: '6f1c2c1e-0000-4000-8000-0000000000c3', digest: '3'.repeat(64) };

type Payload = Record<string, any>;

const receiptFor = (request: Payload): Payload => ({
	outcome: 'broker_dispatched',
	requestId: request.requestId,
	attemptId: request.attemptId,
	runId: request.runId,
	decisionId: 'decision-1',
	requestDigest: 'a'.repeat(64),
	brokerId: 'broker-1',
	policyRevision: request.policyRevision,
	protocol: 2,
	grantId: request.delegation.grant.grantId,
	idempotencyKey: request.idempotencyKey,
	authorityDigest: 'f'.repeat(64),
	ownerGeneration: 1,
	state: 'dispatched',
});

describe('live execution check', () => {
	const open: FakeEndpoint[] = [];
	const ports: EndpointPort[] = [];
	let protocol: typeof import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');

	beforeAll(async () => {
		protocol = await import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');
	});
	afterEach(async () => {
		for (const port of ports.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	async function run(
		options: FakeEndpointOptions = {},
		over: Partial<LiveExecutionCheckInput> = {}
	) {
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: OFFER,
			status: { appliedPolicyRevision: 7, desiredPolicyRevision: 7 },
			...options,
			operations: {
				registration_use: () => projectedRegistrationUse(ATTACH),
				...workflowProducer(),
				execution: (payload) => receiptFor(payload as Payload),
				...options.operations,
			},
		});
		open.push(fake);
		const port = createLocalEndpointClient({ socketPath: fake.socketPath, timeoutMs: 2_000 });
		ports.push(port);
		let n = 0;
		const approvals: unknown[] = [];
		const observation = await runLiveExecutionCheck({
			port,
			attachment: ATTACH,
			authority: { delegation: { grant: PRESENTED, chain: [ROOT, PRESENTED] }, grants: [ROOT] },
			approve: async (approval) => {
				approvals.push(approval);
				return true;
			},
			workflow: {
				workflowId: 'wf-live',
				workflowVersion: 'v1',
				triggerId: 'trigger-live',
				runId: 'run-live',
				attemptId: 'attempt-live',
				rootRunId: 'run-live',
				parentRunId: null,
				requestedLeaseMs: 60_000,
			},
			execution: {
				requestId: '6f1c2c1e-0000-4000-8000-0000000000d1',
				source: 'headless',
				provider: 'claude-code',
				model: 'claude-opus-5-5',
				agentId: 'agent-1',
				contentRef: 'content-1',
				contentSha256: 'e'.repeat(64),
				resourceIds: [],
				idempotencyKey: 'exec-live-1',
			},
			effect: { state: 'uncertain', reason: 'recovery_required' },
			newId: () => `id-${++n}`,
			...over,
		});
		const sent = fake
			.callsTo('/v2/invoke')
			.map((call) => call.body as { schemaVersion: number; operation: string; payload: Payload });
		return { fake, observation, sent, approvals };
	}

	it('registers, negotiates, claims under the delegation, executes and settles, on protocol 2 only', async () => {
		const { observation, sent, approvals } = await run();
		expect(observation.failure).toBeUndefined();
		expect(observation.outcome).toBe('passed');
		expect(observation.schema).toBe(LIVE_EXECUTION_OBSERVATION_SCHEMA);
		expect(approvals).toHaveLength(1);
		expect(sent.map((envelope) => envelope.operation)).toEqual([
			'attachment',
			'registration_challenge',
			'registration_redeem',
			'compatibility',
			'attachment',
			'registration_use',
			'workflow_claim',
			'execution',
			'workflow_settle',
		]);
		for (const envelope of sent) {
			protocol.localRequestEnvelopeV2.parse(envelope);
			const contract =
				protocol.localEndpointContractsV2[
					envelope.operation as keyof typeof protocol.localEndpointContractsV2
				];
			const checked = contract.request.safeParse(envelope.payload);
			expect(
				checked.success ? null : { op: envelope.operation, issues: checked.error.issues }
			).toBeNull();
		}
		expect(observation.liveNegotiationPerformed).toBe(true);
		expect(observation.liveEndpointProtocols).toEqual([2]);
		expect(observation.negotiatedWorkflowExecution).toBe(true);
		expect(observation.workflowOwner).toEqual({
			ownerId: ISSUED.ownerId,
			ownerEpoch: ISSUED.ownerEpoch,
			fencingTokenSha256: createHash('sha256').update(ISSUED.fencingToken).digest('hex'),
		});
		expect(observation.grantDigest).toBe(PRESENTED.digest);
		expect(observation.chain).toEqual([ROOT, PRESENTED]);
		expect(observation.chainDigest?.value).toBe(
			createHash('sha256')
				.update(canonicalJson([ROOT, PRESENTED]))
				.digest('hex')
		);
		const execution = sent.find((envelope) => envelope.operation === 'execution')!;
		expect(protocol.executionRequestV2.safeParse(execution.payload).success).toBe(true);
		expect(execution.payload.delegation).toEqual({ grant: PRESENTED, chain: [ROOT, PRESENTED] });
		expect(execution.payload.policyRevision).toBe(7);
		expect(observation.execution).toMatchObject({
			dispatch: 'dispatched',
			idempotencyKey: 'exec-live-1',
		});
		// An uncertain effect keeps the owner held: nothing is released.
		expect(observation.settlement).toEqual({ effect: 'uncertain', outcome: 'recorded' });
		expect(observation.release).toBeNull();
		// Neither the nonce nor the fencing token is written.
		const text = JSON.stringify(observation);
		expect(text).not.toContain(ISSUED.fencingToken);
	});

	it('releases an effect that settled with evidence', async () => {
		const { observation, sent } = await run(
			{},
			{ effect: { state: 'settled', outcome: 'completed', evidenceDigest: '9'.repeat(64) } }
		);
		expect(observation.outcome).toBe('passed');
		expect(sent.map((envelope) => envelope.operation).slice(-2)).toEqual([
			'workflow_settle',
			'workflow_release',
		]);
		expect(observation.release).toEqual({ outcome: 'released' });
	});

	it('stops when execution is not offered, sending nothing past the negotiation', async () => {
		const { observation, sent } = await run({
			capabilities: OFFER.filter((o) => o !== 'execution'),
		});
		expect(observation.outcome).toBe('failed');
		expect(observation.failure?.step).toBe('negotiation');
		expect(observation.negotiated.execution).toBe(false);
		expect(sent.map((envelope) => envelope.operation)).not.toContain('workflow_claim');
	});

	it('reports a refused execution and settles nothing', async () => {
		const { observation, sent } = await run({
			operations: { execution: () => ({ outcome: 'denied', reason: 'policy_denied' }) },
		});
		expect(observation).toMatchObject({
			outcome: 'failed',
			failure: { step: 'execution', detail: 'denied policy_denied' },
			execution: null,
		});
		expect(sent.map((envelope) => envelope.operation)).not.toContain('workflow_settle');
	});

	it('refuses an unapproved registration and a chain that does not end in its grant', async () => {
		const unapproved = await run({}, { approve: async () => false });
		expect(unapproved.observation.failure?.step).toBe('registration_approval');
		expect(unapproved.sent.map((envelope) => envelope.operation)).not.toContain(
			'registration_redeem'
		);

		const broken = await run(
			{},
			{ authority: { delegation: { grant: PRESENTED, chain: [ROOT] }, grants: [ROOT] } }
		);
		expect(broken.observation.failure).toEqual({
			step: 'input',
			detail: 'the delegation chain does not end in its grant',
		});
		expect(broken.sent).toHaveLength(0);
		expect(broken.observation.liveNegotiationPerformed).toBe(false);
	});
});
