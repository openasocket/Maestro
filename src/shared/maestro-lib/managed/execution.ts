/**
 * The execution client (handoff item 10): one `execution` envelope on the
 * endpoint client's `/v2/invoke` path carrying `runs.submit`, the contract's
 * `executionRequestV2` (contracts 0.4.0 protocol.js, unchanged since 0.2.0),
 * answered by a `dispatchReceiptV2` or a denial.
 *
 * Rules, each enforced here:
 *   - nothing is sent unless the attachment on the CURRENT connection
 *     negotiated `execution`, and `delegation` too when the lease carries a
 *     delegation chain. Otherwise `unavailable` / `not-negotiated`;
 *   - authority is never built from local fields. `registration`,
 *     `delegation`, `grants`, the workflow owner and the run lineage
 *     (`runId`, `attemptId`, `rootRunId`, `parentRunId`, `policyRevision`)
 *     are copied from the lease the workflow lifecycle answered (`workflow_claim` or
 *     `workflow_renew`), whole. The caller supplies only what runs (agent,
 *     content, resources, provider, model) and the request's own ids;
 *   - before sending, the lease must still be what is held: the owner store's
 *     fence for the workflow names the lease's owner, epoch and token, the
 *     lease has not expired, the registration projected for the connection is
 *     the lease's, and the run the caller is executing is the lease's run and
 *     attempt. Anything else is `unavailable` / `stale-authority`, unsent;
 *   - a receipt is credited only when it is a `dispatchReceiptV2` that
 *     answers this request exactly: request, attempt, run, idempotency key and
 *     policy revision the ones sent, the grant the presented one, and no field
 *     the contract does not name. Anything else is `unavailable` /
 *     `malformed`. The envelope's own correlationId is checked by the client;
 *   - dispatch is not completion. A credited receipt says the broker
 *     dispatched (`dispatched`) or could not tell (`unknown`, which needs
 *     reconciliation); this client never settles or releases. The workflow
 *     lifecycle settles once the run's effect is known;
 *   - an idempotency key leaves this client once. A second submission with it
 *     is `unavailable` / `duplicate` and is reconciled, never resent.
 *
 * Nothing composed in the desktop calls this yet. Its one caller is the live
 * execution check (`./live-execution-check.ts`), run against a peer that
 * offers `execution`.
 */

import { canonicalJson } from '../../canonicalJson';
import {
	ENDPOINT_EXECUTION_PAYLOAD_OPERATION,
	LOCAL_ENDPOINT_EXECUTION_OPERATION,
	LOCAL_ENDPOINT_PROTOCOL,
	isEndpointDigest,
	isEndpointIdentifier,
	type EndpointDispatchReceipt,
	type EndpointExecutionRequest,
	type EndpointGrantReference,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type EndpointRuntimeUseReference,
	type EndpointWorkflowLease,
} from './endpoint-port';
import type { AutoRunOwnerFence } from '../autorun/attribution';

/** What the caller says runs. None of it is authority. */
export interface EndpointExecutionSubmission {
	/** The lease the workflow lifecycle answered for this run, as it answered it. */
	lease: EndpointWorkflowLease;
	/** The run and attempt the caller is executing; they must be the lease's. */
	run: { runId: string; attemptId: string };
	requestId: string;
	source: EndpointExecutionRequest['source'];
	provider: string;
	model: string;
	agentId: string;
	contentRef: string;
	contentSha256: string;
	resourceIds: readonly string[];
	idempotencyKey: string;
}

/** A credited dispatch: the request as sent and the receipt that answers it. Not a completion. */
export interface EndpointExecutionDispatch {
	/** `unknown` needs durable reconciliation before the effect is settled. */
	dispatch: EndpointDispatchReceipt['state'];
	request: EndpointExecutionRequest;
	receipt: EndpointDispatchReceipt;
}

export interface EndpointExecutionDeps {
	/** The fence the workflow owner store holds right now for the lease's workflow, or null. */
	fence(lease: EndpointWorkflowLease): AutoRunOwnerFence | null;
	/** The `registration_use` reference projected for the CURRENT connection, or null. */
	registration(): EndpointRuntimeUseReference | null;
	now?(): number;
}

export interface EndpointExecutionClient {
	submit(
		submission: EndpointExecutionSubmission
	): Promise<EndpointInvokeOutcome<EndpointExecutionDispatch>>;
}

const RECEIPT_KEYS = [
	'outcome',
	'requestId',
	'attemptId',
	'runId',
	'decisionId',
	'requestDigest',
	'brokerId',
	'policyRevision',
	'protocol',
	'grantId',
	'idempotencyKey',
	'authorityDigest',
	'ownerGeneration',
	'state',
].sort();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES: readonly string[] = ['ux', 'cli', 'cue', 'headless'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function grantProblems(value: unknown, at: string): string[] {
	if (!isRecord(value)) return [`${at} is not a grant reference`];
	const problems: string[] = [];
	if (typeof value.grantId !== 'string' || !UUID.test(value.grantId))
		problems.push(`${at}.grantId is not a UUID`);
	if (!isEndpointDigest(value.digest)) problems.push(`${at}.digest is not a digest`);
	return problems;
}

function grantListProblems(value: unknown, at: string, min: number): string[] {
	if (!Array.isArray(value) || value.length < min || value.length > 32)
		return [`${at} is not ${min} to 32 grant references`];
	const problems = value.flatMap((grant, i) => grantProblems(grant, `${at}[${i}]`));
	const ids = value.map((grant) => (isRecord(grant) ? grant.grantId : undefined));
	if (new Set(ids).size !== ids.length) problems.push(`${at} repeats a grant`);
	return problems;
}

/** Why `lease` cannot be executed under as the contract's references, or []. */
export function executionLeaseProblems(lease: EndpointWorkflowLease): string[] {
	if (!isRecord(lease)) return ['the lease is not an object'];
	const problems: string[] = [];
	for (const key of [
		'workflowId',
		'workflowVersion',
		'triggerId',
		'runId',
		'attemptId',
		'rootRunId',
	] as const) {
		if (!isEndpointIdentifier(lease[key])) problems.push(`lease.${key} is not an identifier`);
	}
	if (lease.parentRunId !== null && !isEndpointIdentifier(lease.parentRunId))
		problems.push('lease.parentRunId is not an identifier or null');
	if (!isCount(lease.policyRevision)) problems.push('lease.policyRevision is not a revision');
	const owner = lease.owner as unknown;
	if (!isRecord(owner)) problems.push('lease.owner is not an owner');
	else
		for (const key of ['ownerId', 'ownerEpoch', 'fencingToken'] as const)
			if (!isEndpointIdentifier(owner[key]))
				problems.push(`lease.owner.${key} is not an identifier`);
	if (!isRecord(lease.registration)) problems.push('lease.registration is not a reference');
	problems.push(...grantListProblems(lease.grants, 'lease.grants', 0));
	if (lease.delegation !== null) {
		const delegation = lease.delegation as unknown;
		if (!isRecord(delegation)) problems.push('lease.delegation is not a reference');
		else {
			problems.push(...grantProblems(delegation.grant, 'lease.delegation.grant'));
			problems.push(...grantListProblems(delegation.chain, 'lease.delegation.chain', 1));
			const chain = Array.isArray(delegation.chain) ? delegation.chain : [];
			if (canonicalJson(chain.at(-1)) !== canonicalJson(delegation.grant))
				problems.push('lease.delegation.chain does not end in its grant');
		}
	}
	if (lease.delegation === null && Array.isArray(lease.grants) && lease.grants.length === 0)
		problems.push('the lease names no grant to execute under');
	return problems;
}

/** Why the caller's side of `submission` is not the contract's, or []. */
function submissionProblems(submission: EndpointExecutionSubmission): string[] {
	const problems: string[] = [];
	for (const key of [
		'requestId',
		'provider',
		'model',
		'agentId',
		'contentRef',
		'idempotencyKey',
	] as const) {
		if (!isEndpointIdentifier(submission[key])) problems.push(`${key} is not an identifier`);
	}
	if (!SOURCES.includes(submission.source)) problems.push('source is not ux, cli, cue or headless');
	if (!isEndpointDigest(submission.contentSha256)) problems.push('contentSha256 is not a digest');
	if (
		!Array.isArray(submission.resourceIds) ||
		submission.resourceIds.length > 64 ||
		!submission.resourceIds.every(isEndpointIdentifier)
	)
		problems.push('resourceIds is not at most 64 identifiers');
	return problems;
}

/** The `runs.submit` body: the lease's references and lineage whole, the caller's content beside them. */
export function buildExecutionRequest(
	submission: EndpointExecutionSubmission
): EndpointExecutionRequest {
	const lease = structuredClone(submission.lease);
	return {
		requestId: submission.requestId,
		attemptId: lease.attemptId,
		runId: lease.runId,
		source: submission.source,
		provider: submission.provider,
		model: submission.model,
		policyRevision: lease.policyRevision,
		operation: ENDPOINT_EXECUTION_PAYLOAD_OPERATION,
		agentId: submission.agentId,
		contentRef: submission.contentRef,
		contentSha256: submission.contentSha256,
		resourceIds: [...submission.resourceIds],
		idempotencyKey: submission.idempotencyKey,
		workflow: {
			workflowId: lease.workflowId,
			workflowVersion: lease.workflowVersion,
			triggerId: lease.triggerId,
			owner: {
				ownerId: lease.owner.ownerId,
				ownerEpoch: lease.owner.ownerEpoch,
				fencingToken: lease.owner.fencingToken,
			},
		},
		registration: lease.registration,
		delegation: lease.delegation,
		grants: lease.grants,
		rootRunId: lease.rootRunId,
		parentRunId: lease.parentRunId,
	};
}

/** The grant ids a receipt may name for `request`: the presented delegation grant, else a listed grant. */
function presentedGrantIds(request: EndpointExecutionRequest): string[] {
	return request.delegation
		? [request.delegation.grant.grantId]
		: request.grants.map((grant: EndpointGrantReference) => grant.grantId);
}

/** Why `reply` is not the `dispatchReceiptV2` for `request`, or []. A denial never reaches here. */
export function dispatchReceiptProblems(
	request: EndpointExecutionRequest,
	reply: unknown
): string[] {
	if (!isRecord(reply)) return ['the answer is not an object'];
	const problems: string[] = [];
	if (reply.outcome !== 'broker_dispatched') problems.push('outcome is not broker_dispatched');
	if (reply.protocol !== LOCAL_ENDPOINT_PROTOCOL) problems.push('protocol is not 2');
	for (const key of [
		'requestId',
		'attemptId',
		'runId',
		'idempotencyKey',
		'policyRevision',
	] as const)
		if (reply[key] !== request[key]) problems.push(`${key} is not the one sent`);
	if (!presentedGrantIds(request).includes(reply.grantId as string))
		problems.push('grantId is not the grant presented');
	for (const key of ['decisionId', 'brokerId'] as const)
		if (!isEndpointIdentifier(reply[key])) problems.push(`${key} is not an identifier`);
	for (const key of ['requestDigest', 'authorityDigest'] as const)
		if (!isEndpointDigest(reply[key])) problems.push(`${key} is not a digest`);
	if (!isCount(reply.ownerGeneration)) problems.push('ownerGeneration is not a count');
	if (reply.state !== 'dispatched' && reply.state !== 'unknown')
		problems.push('state is not dispatched or unknown');
	if (Object.keys(reply).sort().join(',') !== RECEIPT_KEYS.join(','))
		problems.push('the receipt does not carry exactly the dispatchReceiptV2 fields');
	return problems;
}

/** The execution client over `endpoint`. One client per connection's owner; it remembers the keys it sent. */
export function createEndpointExecutionClient(
	endpoint: Pick<EndpointPort, 'invoke' | 'negotiated'>,
	deps: EndpointExecutionDeps
): EndpointExecutionClient {
	const sent = new Set<string>();
	const now = deps.now ?? Date.now;
	const unavailable = (
		reason: 'not-negotiated' | 'malformed' | 'not-authorized' | 'stale-authority' | 'duplicate',
		message: string
	): EndpointInvokeOutcome<never> => ({ status: 'unavailable', reason, message });

	async function submit(
		submission: EndpointExecutionSubmission
	): Promise<EndpointInvokeOutcome<EndpointExecutionDispatch>> {
		const operation = LOCAL_ENDPOINT_EXECUTION_OPERATION;
		if (!endpoint.negotiated(operation)) {
			return unavailable(
				'not-negotiated',
				`The attachment on this connection did not negotiate ${operation}; nothing was sent.`
			);
		}
		const { lease } = submission;
		if (isRecord(lease) && lease.delegation !== null && !endpoint.negotiated('delegation')) {
			return unavailable(
				'not-negotiated',
				'The lease carries a delegation chain and the attachment did not negotiate delegation; nothing was sent.'
			);
		}
		const malformed = [...submissionProblems(submission), ...executionLeaseProblems(lease)];
		if (malformed.length > 0) {
			const noGrant = malformed.includes('the lease names no grant to execute under');
			return unavailable(
				noGrant && malformed.length === 1 ? 'not-authorized' : 'malformed',
				`The execution request was not sent: ${malformed.join('; ')}`
			);
		}

		const stale: string[] = [];
		const fence = deps.fence(lease);
		if (
			!fence ||
			fence.ownerId !== lease.owner.ownerId ||
			fence.ownerEpoch !== lease.owner.ownerEpoch ||
			fence.fencingToken !== lease.owner.fencingToken
		)
			stale.push('the workflow fence held now is not the lease owner');
		if (!(Date.parse(lease.expiresAt) > now())) stale.push('the lease has expired');
		const registration = deps.registration();
		if (!registration || canonicalJson(registration) !== canonicalJson(lease.registration))
			stale.push('the registration projected for this connection is not the lease registration');
		if (submission.run.runId !== lease.runId || submission.run.attemptId !== lease.attemptId)
			stale.push('the run being executed is not the lease run and attempt');
		if (stale.length > 0) {
			return unavailable(
				'stale-authority',
				`The execution request was not sent: ${stale.join('; ')}`
			);
		}

		if (sent.has(submission.idempotencyKey)) {
			return unavailable(
				'duplicate',
				'An execution with this idempotency key was already sent; it is reconciled, not resent.'
			);
		}
		const request = buildExecutionRequest(submission);
		sent.add(request.idempotencyKey);
		const outcome = await endpoint.invoke(operation, request);
		if (outcome.status !== 'ok') return outcome;
		const problems = dispatchReceiptProblems(request, outcome.payload);
		if (problems.length > 0) {
			return unavailable(
				'malformed',
				`The execution answer is not the dispatch receipt for this request: ${problems.join('; ')}`
			);
		}
		const receipt = outcome.payload as EndpointDispatchReceipt;
		return { status: 'ok', payload: { dispatch: receipt.state, request, receipt } };
	}

	return { submit };
}
