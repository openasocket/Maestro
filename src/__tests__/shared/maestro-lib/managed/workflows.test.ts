/**
 * Durable workflow ownership (MRC-07-06): the CP-03 owner/epoch/fence contract
 * consumed from the Maestro side. The producer is a declared double (a table of
 * answers in the endpoint's own shapes); the store is the real one on disk.
 * What is defended: nothing here mints a fence, what the registry answers is
 * what is held, a retry and a restart re-claim with it, a fenced or unknown
 * holder answers no fence, an offline-enabled holder keeps the fence it was
 * issued, and a missing producer is refused by name.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EndpointInvokeOutcome } from '../../../../shared/maestro-lib/managed/endpoint-port';
import {
	MANAGED_WORKFLOWS_FILE_NAME,
	createWorkflowOwnership,
	endpointWorkflowOwnerPort,
	isWorkflowFenceRefusal,
	workflowEndpointId,
	workflowFenceOf,
	workflowOwnerReceiptProblems,
	type WorkflowOwnerPort,
	type WorkflowOwnerRequest,
	type WorkflowOwnerStanding,
} from '../../../../shared/maestro-lib/managed/workflows';

const WORKFLOW = {
	workflowId: 'cue-pipeline:Nightly QA',
	version: 'v1',
	triggerEventId: 'time.scheduled:evt-1',
};
const OTHER = {
	workflowId: 'playbook:/work/docs',
	version: 'docs-2-abc',
	triggerEventId: 'operator:1',
};
const RUN = { runId: '6f1c2c1e-0000-4000-8000-000000000001', attemptId: 'attempt-1' };
const RETRY = { runId: RUN.runId, attemptId: 'attempt-2' };
const STANDING: WorkflowOwnerStanding = {
	ownerId: 'inst-1',
	authorityId: 'endpoint-a',
	policyRevision: 7,
};

type Answer =
	| EndpointInvokeOutcome<unknown>
	| ((request: WorkflowOwnerRequest) => EndpointInvokeOutcome<unknown>);

/** The registry as a table: `owned` echoes the claim's workflow id with the epoch and token the table holds. */
function fakePort(initial: Answer): WorkflowOwnerPort & {
	requests: WorkflowOwnerRequest[];
	answer: Answer;
} {
	const port = {
		requests: [] as WorkflowOwnerRequest[],
		answer: initial,
		async claim(request: WorkflowOwnerRequest) {
			port.requests.push(request);
			return typeof port.answer === 'function' ? port.answer(request) : port.answer;
		},
	};
	return port;
}

const owned =
	(ownerEpoch: number, fencingToken: string, ownerId = 'inst-1'): Answer =>
	(request) => ({
		status: 'ok',
		payload: {
			outcome: 'owned',
			workflowId: request.workflowId,
			ownerId,
			ownerEpoch,
			fencingToken,
		},
	});
const denied = (reason: string): Answer => ({ status: 'denied', reason: reason as never });

describe('workflow ownership', () => {
	let dir: string;
	let file: string;
	let now = Date.parse('2026-10-21T12:00:00Z');
	let standing: WorkflowOwnerStanding | null = STANDING;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-workflows-'));
		file = path.join(dir, MANAGED_WORKFLOWS_FILE_NAME);
		now = Date.parse('2026-10-21T12:00:00Z');
		standing = STANDING;
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function ownership(port: WorkflowOwnerPort | null, newId = () => 'proposed-nonce') {
		return createWorkflowOwnership({
			file,
			port: () => port,
			owner: () => standing,
			now: () => now,
			newId,
		});
	}

	it('a first claim proposes epoch 0 and a nonce, holds what the registry answered, and persists it', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		expect(store.fence(WORKFLOW)).toBeNull();

		const outcome = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(outcome).toMatchObject({
			state: 'owned',
			disposition: 'claimed',
			fence: { ownerEpoch: '4', fencingToken: 'token-A' },
		});
		expect(port.requests).toHaveLength(1);
		expect(port.requests[0]).toMatchObject({
			ownerId: 'inst-1',
			ownerEpoch: 0,
			fencingToken: 'proposed-nonce',
			offlineEnabled: false,
			policyRevision: 7,
			runId: RUN.runId,
			attemptId: 'attempt-1',
		});
		// The proposal is not what is held; the receipt is.
		expect(store.fence(WORKFLOW)).toEqual({ ownerEpoch: '4', fencingToken: 'token-A' });
		expect(store.held()[0]).toMatchObject({
			workflowId: WORKFLOW.workflowId,
			state: 'held',
			authorityId: 'endpoint-a',
			lastRunId: RUN.runId,
			lastAttemptId: 'attempt-1',
		});
		expect(JSON.parse(fs.readFileSync(file, 'utf8')).workflows).toHaveLength(1);

		// A restarted host reads the same fence back before it asks anything.
		const restarted = ownership(fakePort(denied('unavailable')));
		expect(restarted.fence(WORKFLOW)).toBeNull();
		await restarted.load();
		expect(restarted.fence(WORKFLOW)).toEqual({ ownerEpoch: '4', fencingToken: 'token-A' });
	});

	it('a retry re-claims with the held epoch and token, and the registry confirms it', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		await store.claim({ workflow: WORKFLOW, ...RUN });
		const outcome = await store.claim({ workflow: WORKFLOW, ...RETRY });
		expect(outcome).toMatchObject({ state: 'owned', disposition: 'confirmed' });
		expect(port.requests[1]).toMatchObject({
			ownerEpoch: 4,
			fencingToken: 'token-A',
			attemptId: 'attempt-2',
		});
		expect(store.held()[0]).toMatchObject({ lastAttemptId: 'attempt-2', state: 'held' });
	});

	it('names the workflow, trigger, run and attempt to the registry as endpoint identifiers, deterministically', async () => {
		const port = fakePort(owned(1, 'token-A'));
		await ownership(port).claim({ workflow: WORKFLOW, ...RUN });
		const request = port.requests[0];
		expect(request.workflowId).toMatch(/^wf-[a-f0-9]{40}$/);
		expect(request.triggerId).toMatch(/^wf-[a-f0-9]{40}$/);
		expect(request.runId).toBe(RUN.runId);
		expect(request.attemptId).toBe('attempt-1');
		expect(workflowEndpointId(WORKFLOW.workflowId)).toBe(request.workflowId);
		expect(workflowEndpointId('plain-id_1')).toBe('plain-id_1');
	});

	it('a registry that holds another owner, epoch or token fences the record: no fence until it says otherwise', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		await store.claim({ workflow: WORKFLOW, ...RUN });

		port.answer = denied('owner_unfenced');
		const fenced = await store.claim({ workflow: WORKFLOW, ...RETRY });
		expect(fenced).toMatchObject({ state: 'denied', code: 'policy-denied', fenced: true });
		expect(store.fence(WORKFLOW)).toBeNull();
		expect(store.held()[0]).toMatchObject({
			state: 'fenced',
			ownerEpoch: 4,
			fencingToken: 'token-A',
		});
		expect(workflowFenceOf(fenced)).toMatchObject({
			fence: null,
			state: 'denied',
			code: 'policy-denied',
		});

		// The next claim offers what was held, never a fresh proposal; the registry decides again.
		port.answer = owned(5, 'token-B');
		const again = await store.claim({ workflow: WORKFLOW, runId: 'run-2', attemptId: 'attempt-1' });
		expect(port.requests[2]).toMatchObject({ ownerEpoch: 4, fencingToken: 'token-A' });
		expect(again).toMatchObject({
			state: 'owned',
			disposition: 'claimed',
			fence: { ownerEpoch: '5' },
		});
		expect(store.fence(WORKFLOW)).toEqual({ ownerEpoch: '5', fencingToken: 'token-B' });
	});

	it('a receipt naming another owner is a fence, not ours', async () => {
		const store = ownership(fakePort(owned(2, 'token-X', 'inst-other')));
		const outcome = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(outcome).toMatchObject({ state: 'denied', code: 'policy-denied', fenced: true });
		expect((outcome as { message: string }).message).toContain('inst-other');
		expect(store.fence(WORKFLOW)).toBeNull();
		expect(store.held()[0]).toMatchObject({
			state: 'fenced',
			detail: expect.stringContaining('inst-other'),
		});
	});

	it('an offline-enabled holder keeps the fence it was issued while the producer is unreachable; a plain holder does not', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		await store.claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
		await store.claim({ workflow: OTHER, ...RUN });

		port.answer = { status: 'unavailable', reason: 'transport', message: 'ECONNREFUSED' };
		const kept = await store.claim({ workflow: WORKFLOW, ...RETRY });
		expect(kept).toMatchObject({
			state: 'owned',
			disposition: 'offline',
			fence: { ownerEpoch: '4', fencingToken: 'token-A' },
		});
		expect(store.held()[0]).toMatchObject({
			lastAttemptId: 'attempt-2',
			detail: expect.stringContaining('ECONNREFUSED'),
		});
		const lost = await store.claim({ workflow: OTHER, ...RETRY });
		expect(lost).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(store.fence(OTHER)).toEqual({ ownerEpoch: '4', fencingToken: 'token-A' });
	});

	it('with no producer attached, an offline-enabled holder keeps its fence and a first claim names CP-03', async () => {
		const port = fakePort(owned(4, 'token-A'));
		await ownership(port).claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
		const detached = ownership(null);
		expect(await detached.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
			state: 'owned',
			disposition: 'offline',
		});
		expect(await detached.claim({ workflow: OTHER, ...RUN })).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: expect.stringContaining('CP-03'),
		});
	});

	it('a lost answer leaves no fence and marks the record unknown; the next claim offers what was held', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		await store.claim({ workflow: WORKFLOW, ...RUN, offlineEnabled: true });
		port.answer = { status: 'unknown', message: 'the socket closed after the request was sent' };
		expect(await store.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
			state: 'unknown',
			code: 'outcome-unknown',
		});
		expect(store.fence(WORKFLOW)).toBeNull();
		expect(store.held()[0].state).toBe('unknown');
		// Unknown is not offline: nothing is kept on a lost answer, offline-enabled or not.
		port.answer = owned(4, 'token-A');
		const next = await store.claim({ workflow: WORKFLOW, runId: 'run-3', attemptId: 'attempt-1' });
		expect(port.requests[2]).toMatchObject({ ownerEpoch: 4, fencingToken: 'token-A' });
		expect(next).toMatchObject({ state: 'owned', disposition: 'claimed' });
	});

	it('an endpoint that serves no workflow operation is capability-unsupported, and nothing is held', async () => {
		const store = ownership(fakePort(denied('unsupported_capability')));
		const outcome = await store.claim({ workflow: WORKFLOW, ...RUN });
		expect(outcome).toMatchObject({
			state: 'unavailable',
			code: 'capability-unsupported',
			message: expect.stringContaining('CP-03'),
		});
		expect(store.held()).toHaveLength(0);
		expect(fs.existsSync(file)).toBe(false);
		const answer = workflowFenceOf(outcome);
		expect(isWorkflowFenceRefusal(answer)).toBe(true);
	});

	it('a plain policy denial decides this claim and leaves what is held untouched', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		await store.claim({ workflow: WORKFLOW, ...RUN });
		port.answer = denied('policy_denied');
		expect(await store.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
			state: 'denied',
			code: 'policy-denied',
			fenced: false,
		});
		expect(store.held()[0].state).toBe('held');
		port.answer = denied('replay');
		expect(await store.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
			state: 'denied',
			code: 'idempotency-conflict',
		});
		port.answer = denied('unauthenticated');
		expect(await store.claim({ workflow: WORKFLOW, ...RETRY })).toMatchObject({
			state: 'unavailable',
			code: 'runtime-unavailable',
		});
	});

	it('no standing or no policy generation is refused before the producer is asked', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		standing = null;
		expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('no managed standing'),
		});
		standing = { ...STANDING, policyRevision: null };
		expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('policy revision'),
		});
		expect(port.requests).toHaveLength(0);
	});

	it('a receipt that is not one is unknown', async () => {
		const port = fakePort({ status: 'ok', payload: { outcome: 'echo' } });
		const store = ownership(port);
		expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({ state: 'unknown' });
		expect(store.held()).toHaveLength(0);
		expect(
			workflowOwnerReceiptProblems(
				{ outcome: 'owned', workflowId: 'other', ownerId: 'x', ownerEpoch: -1, fencingToken: '' },
				{ workflowId: 'w' }
			)
		).toEqual([
			'workflowId is not the one claimed',
			'ownerEpoch is not a count',
			'fencingToken is not an identifier',
		]);
	});

	it('a record held under another authority is not a fence here and is replaced by the next answer', async () => {
		const port = fakePort(owned(4, 'token-A'));
		await ownership(port).claim({ workflow: WORKFLOW, ...RUN });
		standing = { ...STANDING, authorityId: 'endpoint-b' };
		const moved = ownership(port);
		await moved.load();
		expect(moved.fence(WORKFLOW)).toBeNull();
		port.answer = owned(9, 'token-Z');
		await moved.claim({ workflow: WORKFLOW, ...RUN });
		// A fresh proposal, not the other authority's values.
		expect(port.requests[1]).toMatchObject({ ownerEpoch: 0, fencingToken: 'proposed-nonce' });
		expect(moved.held()).toHaveLength(1);
		expect(moved.held()[0]).toMatchObject({ authorityId: 'endpoint-b', ownerEpoch: 9 });
	});

	it('concurrent claims on one workflow are serialized: the second confirms what the first was issued', async () => {
		const port = fakePort(owned(4, 'token-A'));
		const store = ownership(port);
		const [first, second] = await Promise.all([
			store.claim({ workflow: WORKFLOW, ...RUN }),
			store.claim({ workflow: WORKFLOW, ...RETRY }),
		]);
		expect(first).toMatchObject({ state: 'owned', disposition: 'claimed' });
		expect(second).toMatchObject({ state: 'owned', disposition: 'confirmed' });
		expect(port.requests[1]).toMatchObject({ ownerEpoch: 4, fencingToken: 'token-A' });
	});

	it('a store that cannot be read refuses every claim rather than starting over', async () => {
		fs.writeFileSync(file, '{ not json');
		const store = ownership(fakePort(owned(4, 'token-A')));
		expect(await store.load()).toMatchObject({ ok: false, reason: 'corrupt' });
		expect(await store.claim({ workflow: WORKFLOW, ...RUN })).toMatchObject({
			state: 'unavailable',
			message: expect.stringContaining('corrupt'),
		});
	});

	it('the endpoint port sends the claim as the workflow operation', async () => {
		const sent: unknown[] = [];
		const port = endpointWorkflowOwnerPort({
			invoke: async (operation, payload) => {
				sent.push([operation, payload]);
				return { status: 'denied', reason: 'unsupported_capability' };
			},
		});
		const request: WorkflowOwnerRequest = {
			workflowId: 'w',
			triggerId: 't',
			runId: 'r',
			attemptId: 'a',
			ownerId: 'o',
			ownerEpoch: 0,
			fencingToken: 'f',
			offlineEnabled: false,
			policyRevision: 1,
		};
		expect(await port.claim(request)).toMatchObject({ status: 'denied' });
		expect(sent).toEqual([['workflow', request]]);
	});
});
