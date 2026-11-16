/**
 * The v2 execution client (`createEndpointExecutionClient`) over a real
 * Unix socket against the fake daemon in `fakeEndpoint.ts`, after a real
 * `workflow_claim` round trip through the v2 lifecycle client.
 *
 * What is defended: an allowed run sends the contract's `executionRequestV2`
 * (parsed here with the vendored 0.3.0 schema) carrying the lease's
 * registration, full delegation chain, grants, workflow owner and lineage
 * unchanged, and credits only the `dispatchReceiptV2` that answers it, as a
 * dispatch and never a completion; a refusal passes through and credits
 * nothing; a stale fence, an expired lease, a moved registration or a changed
 * lineage sends nothing; a replayed key is not resent and the endpoint's own
 * replay refusal passes through; an uncorrelated receipt is refused.
 *
 * The daemon is a double that mints leases and receipts from the request, so
 * nothing here is paired enforcement and no OS peer is authenticated.
 */

import * as path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../../shared/maestro-lib/managed/endpoint-client';
import {
	createEndpointExecutionClient,
	type EndpointExecutionDeps,
	type EndpointExecutionSubmission,
} from '../../../../shared/maestro-lib/managed/execution';
import { createEndpointWorkflowClient } from '../../../../shared/maestro-lib/managed/workflow-lifecycle';
import {
	LOCAL_ENDPOINT_INVOKE_PATH,
	type EndpointAttachmentRequest,
	type EndpointPort,
	type EndpointRuntimeUseReference,
	type EndpointWorkflowClaimRequest,
	type EndpointWorkflowLease,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import { inspectContractsDir } from '../../../../../scripts/check-mega-contract-vectors.mjs';
import { readPin } from '../../../../../scripts/import-mega-maestro.mjs';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../../main/enterprise/fakeEndpoint';
import { ISSUED, workflowProducer as producer } from '../../../main/enterprise/workflowProducer';

const WORKFLOW_OPERATIONS = [
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
];
const OFFER = [...WORKFLOW_OPERATIONS, 'execution', 'delegation'];

const ATTACH: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	supportedProtocols: [2],
	supportedCapabilities: ['attachment', 'compatibility', ...OFFER],
	requiredCapabilities: [],
};

const REGISTRATION: EndpointRuntimeUseReference = {
	version: 2,
	purpose: 'runtime_use',
	tenantId: '6f1c2c1e-0000-4000-8000-0000000000a1',
	orgId: '6f1c2c1e-0000-4000-8000-0000000000a2',
	enrollmentId: '6f1c2c1e-0000-4000-8000-0000000000aa',
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	bindingDigest: 'b'.repeat(64),
	processBirthDigest: 'd'.repeat(64),
	challengeId: '6f1c2c1e-0000-4000-8000-0000000000bb',
	challengeDigest: 'c'.repeat(64),
};

const ROOT = { grantId: '6f1c2c1e-0000-4000-8000-0000000000c1', digest: '1'.repeat(64) };
const PARENT = { grantId: '6f1c2c1e-0000-4000-8000-0000000000c2', digest: '2'.repeat(64) };
const PRESENTED = { grantId: '6f1c2c1e-0000-4000-8000-0000000000c3', digest: '3'.repeat(64) };

const CLAIM: EndpointWorkflowClaimRequest = {
	registration: REGISTRATION,
	delegation: { grant: PRESENTED, chain: [ROOT, PARENT, PRESENTED] },
	grants: [ROOT],
	workflowId: 'wf-nightly',
	workflowVersion: 'v1',
	triggerId: 'trigger-1',
	runId: 'run-child-1',
	attemptId: 'attempt-1',
	idempotencyKey: 'claim-idem-1',
	policyRevision: 7,
	rootRunId: 'run-root-1',
	parentRunId: 'run-parent-1',
	requestedLeaseMs: 60_000,
};

type Payload = Record<string, any>;

/** The broker double: a receipt minted from the request, durable replay refused by idempotency key. */
function broker(state: 'dispatched' | 'unknown' = 'dispatched') {
	const seen = new Set<string>();
	return (payload: unknown) => {
		const request = payload as Payload;
		if (seen.has(request.idempotencyKey)) return { outcome: 'denied', reason: 'replay' };
		seen.add(request.idempotencyKey);
		return receiptFor(request, { state });
	};
}

function receiptFor(request: Payload, over: Payload = {}): Payload {
	return {
		outcome: 'broker_dispatched',
		requestId: request.requestId,
		attemptId: request.attemptId,
		runId: request.runId,
		decisionId: 'decision-1',
		requestDigest: 'a'.repeat(64),
		brokerId: 'broker-1',
		policyRevision: request.policyRevision,
		protocol: 2,
		grantId: request.delegation?.grant.grantId ?? request.grants[0].grantId,
		idempotencyKey: request.idempotencyKey,
		authorityDigest: 'f'.repeat(64),
		ownerGeneration: 1,
		state: 'dispatched',
		...over,
	};
}

describe('v2 execution client', () => {
	const open: FakeEndpoint[] = [];
	const ports: EndpointPort[] = [];
	let protocol: typeof import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');
	let wire: typeof import('../../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');

	beforeAll(async () => {
		const pin = readPin(path.resolve('vendor/mega-maestro/contracts.pin.json'));
		expect(pin.version).toBe('0.4.0');
		inspectContractsDir({
			contractsDir: path.resolve('vendor/mega-maestro/contracts'),
			expectedSha256: pin.payloadDigest,
		});
		protocol = await import('../../../../../vendor/mega-maestro/contracts/dist/protocol.js');
		wire = await import('../../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
	});

	afterEach(async () => {
		for (const port of ports.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
	});

	/** A v2 attachment that negotiated `offer`, a claimed lease, and an execution client over the fence. */
	async function claimed(
		options: FakeEndpointOptions = {},
		deps: Partial<EndpointExecutionDeps> = {}
	) {
		const fake = await startFakeEndpoint({
			capabilities: OFFER,
			operations: { ...producer(), execution: broker() },
			...options,
		});
		open.push(fake);
		const port = createLocalEndpointClient({ socketPath: fake.socketPath });
		ports.push(port);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		const claim = await createEndpointWorkflowClient(port).claim(CLAIM);
		if (claim.status !== 'ok' || claim.payload.outcome !== 'owned') throw new Error('not owned');
		const lease = claim.payload.lease;
		const held = { fence: { ...lease.owner } as typeof lease.owner | null };
		const client = createEndpointExecutionClient(port, {
			fence: () => held.fence,
			registration: () => REGISTRATION,
			...deps,
		});
		return { fake, port, lease, held, client };
	}

	const submission = (
		lease: EndpointWorkflowLease,
		over: Partial<EndpointExecutionSubmission> = {}
	): EndpointExecutionSubmission => ({
		lease,
		run: { runId: lease.runId, attemptId: lease.attemptId },
		requestId: '6f1c2c1e-0000-4000-8000-0000000000d1',
		source: 'cue',
		provider: 'claude-code',
		model: 'claude-opus-5-5',
		agentId: 'agent-1',
		contentRef: 'content-1',
		contentSha256: 'e'.repeat(64),
		resourceIds: ['resource-1'],
		idempotencyKey: 'exec-idem-1',
		...over,
	});

	const executions = (fake: FakeEndpoint) =>
		fake
			.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)
			.map((call) => call.body as { operation: string; payload: Payload })
			.filter((body) => body.operation === 'execution');

	it('an allowed run sends executionRequestV2 with the lease authority whole and credits the correlated receipt as a dispatch', async () => {
		const { fake, lease, client } = await claimed();
		const outcome = await client.submit(submission(lease));
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok') throw new Error('not dispatched');
		expect(outcome.payload.dispatch).toBe('dispatched');

		const [sent] = executions(fake);
		expect(executions(fake)).toHaveLength(1);
		expect(protocol.executionRequestV2.safeParse(sent.payload).success).toBe(true);
		expect(sent.payload).toEqual(outcome.payload.request);
		expect(sent.payload).toMatchObject({
			operation: 'runs.submit',
			registration: lease.registration,
			delegation: { grant: PRESENTED, chain: [ROOT, PARENT, PRESENTED] },
			grants: [ROOT],
			workflow: {
				workflowId: lease.workflowId,
				workflowVersion: lease.workflowVersion,
				triggerId: lease.triggerId,
				owner: ISSUED,
			},
			runId: CLAIM.runId,
			attemptId: CLAIM.attemptId,
			rootRunId: CLAIM.rootRunId,
			parentRunId: CLAIM.parentRunId,
			policyRevision: CLAIM.policyRevision,
		});
		expect(wire.dispatchReceiptV2.safeParse(outcome.payload.receipt).success).toBe(true);
		expect(outcome.payload.receipt.grantId).toBe(PRESENTED.grantId);
		// Dispatch is not completion: nothing settled or released.
		const operations = fake
			.callsTo(LOCAL_ENDPOINT_INVOKE_PATH)
			.map((call) => (call.body as { operation: string }).operation);
		expect(operations).not.toContain('workflow_settle');
		expect(operations).not.toContain('workflow_release');
	});

	it('an uncertain dispatch is credited as unknown, never as done', async () => {
		const { lease, client } = await claimed({
			operations: { ...producer(), execution: broker('unknown') },
		});
		const outcome = await client.submit(submission(lease));
		expect(outcome).toMatchObject({ status: 'ok', payload: { dispatch: 'unknown' } });
	});

	it('a refused run passes the refusal through and credits nothing', async () => {
		const { fake, lease, client } = await claimed();
		fake.options.operations!.execution = () => ({ outcome: 'denied', reason: 'policy_denied' });
		expect(await client.submit(submission(lease))).toEqual({
			status: 'denied',
			reason: 'policy_denied',
		});
	});

	it('a stale fence or an expired lease sends nothing, and the endpoint owner_unfenced refusal passes through', async () => {
		const { fake, lease, held, client } = await claimed();
		held.fence = { ...ISSUED, fencingToken: 'server-fence-2' };
		expect(await client.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'stale-authority',
		});
		held.fence = null;
		expect(await client.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'stale-authority',
		});
		held.fence = { ...lease.owner };
		const late = createEndpointExecutionClient((await claimed()).port, {
			fence: () => held.fence,
			registration: () => REGISTRATION,
			now: () => Date.parse(lease.expiresAt) + 1,
		});
		expect(await late.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'stale-authority',
		});
		expect(executions(fake)).toHaveLength(0);

		fake.options.operations!.execution = () => ({ outcome: 'denied', reason: 'owner_unfenced' });
		expect(await client.submit(submission(lease))).toEqual({
			status: 'denied',
			reason: 'owner_unfenced',
		});
		expect(executions(fake)).toHaveLength(1);
	});

	it('a changed lineage sends nothing, and a receipt for another run is refused', async () => {
		const moved = { registration: REGISTRATION as EndpointRuntimeUseReference };
		const { fake, lease, client } = await claimed({}, { registration: () => moved.registration });
		expect(
			await client.submit(
				submission(lease, { run: { runId: lease.runId, attemptId: 'attempt-2' } })
			)
		).toMatchObject({ status: 'unavailable', reason: 'stale-authority' });
		expect(
			await client.submit(
				submission(lease, { run: { runId: 'run-other', attemptId: lease.attemptId } })
			)
		).toMatchObject({ status: 'unavailable', reason: 'stale-authority' });
		moved.registration = { ...REGISTRATION, processEpoch: 'epoch-2' };
		expect(await client.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'stale-authority',
		});
		expect(executions(fake)).toHaveLength(0);

		moved.registration = REGISTRATION;
		fake.options.operations!.execution = (payload) =>
			receiptFor(payload as Payload, { runId: 'run-other' });
		expect(await client.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'malformed',
		});
	});

	it('a replayed key is not resent, and the endpoint replay refusal passes through for another client', async () => {
		const { fake, port, lease, client } = await claimed();
		expect((await client.submit(submission(lease))).status).toBe('ok');
		expect(await client.submit(submission(lease))).toMatchObject({
			status: 'unavailable',
			reason: 'duplicate',
		});
		expect(executions(fake)).toHaveLength(1);

		const restarted = createEndpointExecutionClient(port, {
			fence: () => lease.owner,
			registration: () => REGISTRATION,
		});
		expect(await restarted.submit(submission(lease))).toEqual({
			status: 'denied',
			reason: 'replay',
		});
		expect(executions(fake)).toHaveLength(2);
	});

	it('an uncorrelated receipt is refused, whatever field moved', async () => {
		const { fake, lease, client } = await claimed();
		const cases: Payload[] = [
			{ requestId: '6f1c2c1e-0000-4000-8000-0000000000d9' },
			{ attemptId: 'attempt-9' },
			{ idempotencyKey: 'exec-idem-other' },
			{ policyRevision: 8 },
			{ grantId: ROOT.grantId },
			{ protocol: 1 },
			{ state: 'completed' },
			{ requestDigest: 'not-a-digest' },
			{ extra: true },
		];
		for (const [i, over] of cases.entries()) {
			fake.options.operations!.execution = (payload) => receiptFor(payload as Payload, over);
			expect(
				await client.submit(submission(lease, { idempotencyKey: `exec-idem-u${i}` })),
				JSON.stringify(over)
			).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		}
		fake.options.operations!.execution = broker();
		fake.options.envelope = (envelope) => ({ ...envelope, correlationId: 'someone-else' });
		const foreign = await client.submit(submission(lease, { idempotencyKey: 'exec-idem-env' }));
		expect(foreign).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (foreign.status === 'unavailable') expect(foreign.message).toMatch(/correlationId/);
	});

	it('sends nothing until execution (and delegation, for a delegated lease) is negotiated, or with no grant', async () => {
		const bare = await claimed({ capabilities: WORKFLOW_OPERATIONS });
		expect(await bare.client.submit(submission(bare.lease))).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});
		const undelegated = await claimed({ capabilities: [...WORKFLOW_OPERATIONS, 'execution'] });
		expect(await undelegated.client.submit(submission(undelegated.lease))).toMatchObject({
			status: 'unavailable',
			reason: 'not-negotiated',
		});
		const { fake, lease, client } = await claimed();
		const ungranted = { ...lease, delegation: null, grants: [] };
		expect(await client.submit(submission(ungranted))).toMatchObject({
			status: 'unavailable',
			reason: 'not-authorized',
		});
		for (const target of [bare.fake, undelegated.fake, fake])
			expect(executions(target)).toHaveLength(0);
	});
});
