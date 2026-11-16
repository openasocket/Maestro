/**
 * The v2 workflow lifecycle client (`workflow_claim`, `workflow_renew`,
 * `workflow_settle`, `workflow_release`) over a real Unix socket against the
 * fake daemon in `fakeEndpoint.ts`, and the same client presented to the one
 * workflow owner store through `endpointWorkflowLifecyclePort`.
 *
 * What is defended: each operation round trips on `/v2/invoke` and answers
 * the outcome the contract names; an answer whose owner is not the one the
 * request holds, or whose correlationId is not the request's, is refused as
 * malformed and the foreign owner never reaches held state; a denial passes
 * through with its reason and claims nothing.
 *
 * The daemon is a double that mints leases from the request, so nothing here
 * is paired enforcement and no OS peer is authenticated.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalEndpointClient } from '../../../../shared/maestro-lib/managed/endpoint-client';
import {
	createEndpointWorkflowClient,
	createEndpointWorkflowOwnerPort,
	endpointWorkflowLifecyclePort,
	type EndpointWorkflowAuthority,
} from '../../../../shared/maestro-lib/managed/workflow-lifecycle';
import {
	LOCAL_ENDPOINT_INVOKE_PATH,
	type EndpointAttachmentRequest,
	type EndpointPort,
	type EndpointWorkflowClaimRequest,
	type EndpointWorkflowContext,
	type EndpointWorkflowOwner,
} from '../../../../shared/maestro-lib/managed/endpoint-port';
import {
	MANAGED_WORKFLOWS_FILE_NAME,
	createWorkflowOwnership,
	workflowEndpointId,
	type WorkflowOwnerStanding,
} from '../../../../shared/maestro-lib/managed/workflows';
import {
	startFakeEndpoint,
	type FakeEndpoint,
	type FakeEndpointOptions,
} from '../../../main/enterprise/fakeEndpoint';
import {
	ISSUED,
	leaseOf,
	workflowProducer as producer,
} from '../../../main/enterprise/workflowProducer';

const WORKFLOW_OPERATIONS = [
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
] as const;

const ATTACH: EndpointAttachmentRequest = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
	components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
	supportedProtocols: [2],
	supportedCapabilities: ['attachment', 'compatibility', ...WORKFLOW_OPERATIONS],
	requiredCapabilities: [],
};

const AUTHORITY: EndpointWorkflowAuthority = {
	registration: {
		version: 2,
		purpose: 'runtime_use',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		enrollmentId: '6f1c2c1e-0000-4000-8000-0000000000aa',
		installationId: 'inst-1',
		runtimeId: 'desktop-100',
		processEpoch: 'epoch-1',
		bindingDigest: 'b'.repeat(64),
		processBirthDigest: 'd'.repeat(64),
		challengeId: '6f1c2c1e-0000-4000-8000-0000000000bb',
		challengeDigest: 'c'.repeat(64),
	},
	delegation: null,
	grants: [],
};

const CONTEXT: EndpointWorkflowContext = {
	...AUTHORITY,
	workflowId: 'wf-nightly',
	workflowVersion: 'v1',
	triggerId: 'trigger-1',
	runId: 'run-1',
	attemptId: 'attempt-1',
	idempotencyKey: 'idem-1',
	policyRevision: 7,
	rootRunId: 'run-1',
	parentRunId: null,
};
const CLAIM: EndpointWorkflowClaimRequest = { ...CONTEXT, requestedLeaseMs: 60_000 };

const FOREIGN: EndpointWorkflowOwner = {
	ownerId: 'inst-1',
	ownerEpoch: 'opaque-epoch-other',
	fencingToken: 'server-fence-other',
};

type Payload = Record<string, unknown>;

describe('v2 workflow lifecycle client', () => {
	const open: FakeEndpoint[] = [];
	const ports: EndpointPort[] = [];
	const signals: AbortController[] = [];
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-v2-'));
	});
	afterEach(async () => {
		signals.splice(0).forEach((signal) => signal.abort());
		for (const port of ports.splice(0)) await port.close();
		for (const fake of open.splice(0)) await fake.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	async function attached(options: FakeEndpointOptions = {}) {
		const fake = await startFakeEndpoint({
			capabilities: [...WORKFLOW_OPERATIONS],
			operations: producer(),
			...options,
		});
		open.push(fake);
		const port = createLocalEndpointClient({ socketPath: fake.socketPath });
		ports.push(port);
		expect((await port.attach(ATTACH)).status).toBe('ok');
		return { fake, port, client: createEndpointWorkflowClient(port) };
	}

	/** The one workflow owner store, with the v2 client as its lifecycle port. */
	function ownership(port: EndpointPort) {
		const signal = new AbortController();
		signals.push(signal);
		const client = createEndpointWorkflowClient(port);
		const ownerPort = {
			lifecycle: endpointWorkflowLifecyclePort(client, {
				signal: signal.signal,
				current: () => true,
				authority: () => AUTHORITY,
				evidenceDigest: () => 'e'.repeat(64),
				requestedLeaseMs: 60_000,
			}),
		};
		const standing: WorkflowOwnerStanding = {
			ownerId: 'inst-1',
			authorityId: 'endpoint-a',
			policyRevision: 7,
		};
		const store = createWorkflowOwnership({
			file: path.join(dir, MANAGED_WORKFLOWS_FILE_NAME),
			port: () => ownerPort,
			owner: () => standing,
			now: () => Date.now(),
		});
		return { store };
	}

	const WORKFLOW = {
		workflowId: 'cue-pipeline:Nightly QA',
		version: 'v1',
		triggerEventId: 'time.scheduled:evt-1',
	};
	const RUN = { runId: '6f1c2c1e-0000-4000-8000-000000000001', attemptId: 'attempt-1' };
	const RETRY = { runId: RUN.runId, attemptId: 'attempt-2' };

	it('claim returns owned with a lease the producer issued', async () => {
		const { fake, client } = await attached();
		const outcome = await client.claim(CLAIM);
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok' || outcome.payload.outcome !== 'owned')
			throw new Error('not owned');
		expect(outcome.payload.lease.owner).toEqual(ISSUED);
		expect(outcome.payload.lease.workflowId).toBe(CONTEXT.workflowId);
		expect(Date.parse(outcome.payload.lease.expiresAt)).toBeGreaterThan(
			Date.parse(outcome.payload.lease.acquiredAt)
		);

		const sent = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).at(-1)!.body as {
			operation: string;
			payload: Payload;
		};
		expect(sent.operation).toBe('workflow_claim');
		expect(sent.payload).toEqual(CLAIM);
		expect(sent.payload).not.toHaveProperty('owner');
	});

	it('renew returns renewed with the held owner echoed', async () => {
		const { fake, client } = await attached();
		const outcome = await client.renew({ ...CLAIM, owner: ISSUED });
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok' || outcome.payload.outcome !== 'renewed')
			throw new Error('not renewed');
		expect(outcome.payload.lease.owner).toEqual(ISSUED);
		const sent = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).at(-1)!.body as {
			operation: string;
		};
		expect(sent.operation).toBe('workflow_renew');
	});

	it('settle returns recorded with the request echoed', async () => {
		const { client } = await attached();
		const request = {
			...CONTEXT,
			owner: ISSUED,
			effect: {
				state: 'settled' as const,
				outcome: 'completed' as const,
				evidenceDigest: 'e'.repeat(64),
			},
		};
		const outcome = await client.settle(request);
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok' || outcome.payload.outcome !== 'recorded')
			throw new Error('not recorded');
		expect(outcome.payload).toMatchObject(request);
		expect(Number.isFinite(Date.parse(outcome.payload.recordedAt))).toBe(true);
	});

	it('release returns released with the request echoed', async () => {
		const { client } = await attached();
		const request = { ...CONTEXT, owner: ISSUED, disposition: 'effects_settled' as const };
		const outcome = await client.release(request);
		expect(outcome.status).toBe('ok');
		if (outcome.status !== 'ok' || outcome.payload.outcome !== 'released')
			throw new Error('not released');
		expect(outcome.payload).toMatchObject(request);
		expect(Number.isFinite(Date.parse(outcome.payload.releasedAt))).toBe(true);
	});

	it('a returned owner that does not match the request is refused as malformed', async () => {
		const { fake, client } = await attached();
		const operations = fake.options.operations!;
		operations.workflow_renew = (payload) => ({
			outcome: 'renewed',
			lease: leaseOf(payload as Payload, FOREIGN),
		});
		operations.workflow_settle = (payload) => ({
			...(payload as Payload),
			owner: FOREIGN,
			outcome: 'recorded',
			recordedAt: new Date().toISOString(),
		});
		operations.workflow_release = (payload) => ({
			...(payload as Payload),
			owner: FOREIGN,
			outcome: 'released',
			releasedAt: new Date().toISOString(),
		});

		const renew = await client.renew({ ...CLAIM, owner: ISSUED });
		expect(renew).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (renew.status === 'unavailable') expect(renew.message).toMatch(/owner/);

		const settle = await client.settle({
			...CONTEXT,
			owner: ISSUED,
			effect: { state: 'uncertain', reason: 'recovery_required' },
		});
		expect(settle).toMatchObject({ status: 'unavailable', reason: 'malformed' });

		const release = await client.release({
			...CONTEXT,
			owner: ISSUED,
			disposition: 'no_effect_started',
		});
		expect(release).toMatchObject({ status: 'unavailable', reason: 'malformed' });
	});

	it('a foreign owner on renew never replaces the owner the store holds', async () => {
		const { fake, port } = await attached();
		const { store } = ownership(port);

		const first = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(first.state).toBe('owned');
		const issued = store.held()[0];
		expect(issued).toMatchObject({
			endpointWorkflowId: workflowEndpointId(WORKFLOW.workflowId),
			ownerEpoch: ISSUED.ownerEpoch,
			fencingToken: ISSUED.fencingToken,
			state: 'held',
		});

		fake.options.operations!.workflow_renew = (payload) => ({
			outcome: 'renewed',
			lease: leaseOf(payload as Payload, FOREIGN),
		});
		// A retry over an issued owner is a renew that echoes it.
		const retried = await store.claim({ workflow: WORKFLOW, ...RETRY });
		expect(retried.state).not.toBe('owned');
		const sent = fake.callsTo(LOCAL_ENDPOINT_INVOKE_PATH).at(-1)!.body as {
			operation: string;
			payload: { owner: EndpointWorkflowOwner };
		};
		expect(sent.operation).toBe('workflow_renew');
		expect(sent.payload.owner).toEqual(ISSUED);

		// The owner the producer issued is what is still held; the foreign one never landed.
		expect(store.held()).toHaveLength(1);
		expect(store.held()[0]).toMatchObject({
			ownerId: issued.ownerId,
			ownerEpoch: issued.ownerEpoch,
			fencingToken: issued.fencingToken,
			claimedAt: issued.claimedAt,
			confirmedAt: issued.confirmedAt,
			expiresAt: issued.expiresAt,
		});
		expect(JSON.stringify(store.held())).not.toContain(FOREIGN.ownerEpoch);
		expect(JSON.stringify(store.held())).not.toContain(FOREIGN.fencingToken);
		expect(store.fence(WORKFLOW)).toBeNull();
	});

	it('an answer whose correlationId does not match the request is refused', async () => {
		const { fake, client, port } = await attached();
		fake.options.envelope = (envelope) => ({ ...envelope, correlationId: 'not-the-request' });

		const outcome = await client.claim(CLAIM);
		expect(outcome).toMatchObject({ status: 'unavailable', reason: 'malformed' });
		if (outcome.status === 'unavailable') expect(outcome.message).toMatch(/correlationId/);

		const { store } = ownership(port);
		const claimed = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(claimed.state).not.toBe('owned');
		expect(store.fence(WORKFLOW)).toBeNull();
		expect(store.held().every((held) => held.state !== 'held')).toBe(true);
		expect(JSON.stringify(store.held())).not.toContain(ISSUED.fencingToken);
	});

	it('a denied reply is passed through with its reason and claims nothing', async () => {
		const { fake, client, port } = await attached();
		fake.options.operations!.workflow_claim = () => ({
			outcome: 'denied',
			reason: 'policy_denied',
		});

		expect(await client.claim(CLAIM)).toEqual({ status: 'denied', reason: 'policy_denied' });

		const { store } = ownership(port);
		const claimed = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(claimed).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
			fenced: false,
			reason: 'policy_denied',
		});
		expect(store.held()).toHaveLength(0);
		expect(store.fence(WORKFLOW)).toBeNull();
	});

	it('the owner port offers the lifecycle only with all four verbs negotiated and a reference, and never sends the legacy fence', async () => {
		const { fake, port } = await attached();
		let reference: EndpointWorkflowAuthority['registration'] | null = null;
		const ownerPort = createEndpointWorkflowOwnerPort({
			endpoint: () => port,
			registration: () => reference,
		});
		// Negotiated, but no reference projected yet: not reachable, nothing sent.
		const before = fake.calls.length;
		expect(ownerPort()).toBeNull();
		reference = AUTHORITY.registration;
		const offered = ownerPort();
		expect(offered?.lifecycle?.current()).toBe(true);
		// The same port while the connection and reference hold.
		expect(ownerPort()).toBe(offered);
		expect(fake.calls).toHaveLength(before);
		// Another reference retires the port it handed out.
		reference = { ...AUTHORITY.registration, challengeId: '6f1c2c1e-0000-4000-8000-0000000000cc' };
		expect(offered!.lifecycle!.signal.aborted).toBe(false);
		const next = ownerPort();
		expect(next).not.toBe(offered);
		expect(offered!.lifecycle!.signal.aborted).toBe(true);
		expect(offered!.lifecycle!.current()).toBe(false);
		expect(
			createEndpointWorkflowOwnerPort({ endpoint: () => null, registration: () => reference })()
		).toBeNull();
	});

	it('the owner port answers unsupported_capability when the attachment negotiated without the lifecycle', async () => {
		const { fake, port } = await attached({ capabilities: ['workflow_claim'] });
		const ownerPort = createEndpointWorkflowOwnerPort({
			endpoint: () => port,
			registration: () => AUTHORITY.registration,
		});
		const before = fake.calls.length;
		expect(ownerPort()).toEqual({ lifecycle: null, unserved: true });
		expect(fake.calls).toHaveLength(before);
	});
});
