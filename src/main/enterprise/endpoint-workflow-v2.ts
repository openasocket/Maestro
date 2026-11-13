/**
 * The v2 workflow lifecycle client: `workflow_claim`, `workflow_renew`,
 * `workflow_settle` and `workflow_release` over the endpoint client's
 * `/v2/invoke` path (contracts 0.2.0 protocol.js, field for field).
 *
 * The envelope checks are the v2 path's own: `parseLocalEndpointResponseV2`
 * refuses an answer whose correlationId or operation is not the request's,
 * and the client turns that into `unavailable` / `malformed`. On top of it
 * this file reads the payload against the request, as the contract's
 * `workflowLifecycleReceiptMatches` does:
 *   - claim and renew answer a lease whose workflow context is the request's
 *     and whose `acquiredAt` / `expiresAt` parse as dates with a bounded
 *     positive lifetime; renew's lease also echoes the request's owner;
 *   - settle and release answer the request echoed, every field, with the
 *     owner unchanged and a timestamp that parses.
 * Anything else is `unavailable` / `malformed`. A denial passes through with
 * its reason (the v2 path answers a denial body as `denied`). An endpoint
 * with no v2 path, or an operation the current v2 attachment did not negotiate, is
 * `unavailable` / `not-negotiated` and nothing is sent.
 *
 * This client holds no workflow state. What is held lives in the workflow
 * owner port (`src/shared/maestro-lib/managed/workflows.ts`); a refused
 * answer here is returned before anything reaches it, so it changes nothing
 * there. `endpointWorkflowV2LifecyclePort` presents the client as that
 * store's `WorkflowOwnerLifecyclePort`, so a claim result reaches held state
 * only through it. Nothing here wires the lifecycle into execution.
 */

import {
	ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS,
	isEndpointIdentifier,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type EndpointWorkflowClaimReplyV2,
	type EndpointWorkflowClaimRequestV2,
	type EndpointWorkflowContextV2,
	type EndpointWorkflowOwnerV2,
	type EndpointWorkflowReleaseReplyV2,
	type EndpointWorkflowReleaseRequestV2,
	type EndpointWorkflowRenewReplyV2,
	type EndpointWorkflowRenewRequestV2,
	type EndpointWorkflowSettleReplyV2,
	type EndpointWorkflowSettleRequestV2,
	type EndpointWorkflowV2Exchange,
	type EndpointWorkflowV2Operation,
} from '../../shared/maestro-lib/managed/endpoint-port';
import {
	UNISSUED_OWNER_EPOCH,
	workflowEndpointId,
	type WorkflowClaimInput,
	type WorkflowOwnerLifecyclePort,
	type WorkflowOwnerStanding,
} from '../../shared/maestro-lib/managed/workflows';

export interface EndpointWorkflowV2Client {
	claim(
		request: EndpointWorkflowClaimRequestV2
	): Promise<EndpointInvokeOutcome<EndpointWorkflowClaimReplyV2>>;
	renew(
		request: EndpointWorkflowRenewRequestV2
	): Promise<EndpointInvokeOutcome<EndpointWorkflowRenewReplyV2>>;
	settle(
		request: EndpointWorkflowSettleRequestV2
	): Promise<EndpointInvokeOutcome<EndpointWorkflowSettleReplyV2>>;
	release(
		request: EndpointWorkflowReleaseRequestV2
	): Promise<EndpointInvokeOutcome<EndpointWorkflowReleaseReplyV2>>;
}

/** The keys of `workflowContextV2`, in the contract's order. */
const WORKFLOW_CONTEXT_KEYS: readonly (keyof EndpointWorkflowContextV2)[] = [
	'registration',
	'delegation',
	'grants',
	'workflowId',
	'workflowVersion',
	'triggerId',
	'runId',
	'attemptId',
	'idempotencyKey',
	'policyRevision',
	'rootRunId',
	'parentRunId',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The contract's `sameFields`: each key compared by its JSON text. */
function sameFields(a: object, b: Record<string, unknown>, keys: readonly string[]): boolean {
	const left = a as Record<string, unknown>;
	return keys.every((key) => JSON.stringify(left[key]) === JSON.stringify(b[key]));
}

const parsesAsDate = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));

/** Problems with a value offered as the owner reference; empty when it is one. */
function ownerProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['owner is not an object'];
	const problems: string[] = [];
	for (const key of ['ownerId', 'ownerEpoch', 'fencingToken'] as const) {
		if (!isEndpointIdentifier(value[key])) problems.push(`owner.${key} is not an identifier`);
	}
	return problems;
}

/** Problems with a lease answered for `request`; `owner`, when given, is the owner it must echo. */
function leaseProblems(
	lease: unknown,
	request: EndpointWorkflowContextV2,
	owner: EndpointWorkflowOwnerV2 | null
): string[] {
	if (!isRecord(lease)) return ['lease is not an object'];
	const problems = ownerProblems(lease.owner);
	if (!sameFields(request, lease, WORKFLOW_CONTEXT_KEYS)) {
		problems.push('lease workflow context is not the one requested');
	}
	if (owner && !sameFields({ owner }, lease, ['owner'])) {
		problems.push('lease owner is not the owner the request holds');
	}
	if (!parsesAsDate(lease.acquiredAt)) problems.push('lease acquiredAt is not a date');
	if (!parsesAsDate(lease.expiresAt)) problems.push('lease expiresAt is not a date');
	if (parsesAsDate(lease.acquiredAt) && parsesAsDate(lease.expiresAt)) {
		const lifetime = Date.parse(lease.expiresAt) - Date.parse(lease.acquiredAt);
		if (!(lifetime > 0 && lifetime <= ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS)) {
			problems.push('lease lifetime is not bounded and positive');
		}
	}
	return problems;
}

/** Problems with the reply to `operation` for `request`; empty when it answers it. */
export function endpointWorkflowV2ReplyProblems<O extends EndpointWorkflowV2Operation>(
	operation: O,
	request: EndpointWorkflowV2Exchange[O]['request'],
	reply: unknown
): string[] {
	if (!isRecord(reply)) return ['reply is not an object'];
	switch (operation) {
		case 'workflow_claim':
		case 'workflow_renew': {
			const expected = operation === 'workflow_claim' ? 'owned' : 'renewed';
			if (reply.outcome !== expected) return [`outcome is not ${expected}`];
			const owner =
				operation === 'workflow_renew' ? (request as EndpointWorkflowRenewRequestV2).owner : null;
			return leaseProblems(reply.lease, request, owner);
		}
		case 'workflow_settle':
		case 'workflow_release': {
			const [expected, at] =
				operation === 'workflow_settle' ? ['recorded', 'recordedAt'] : ['released', 'releasedAt'];
			const problems: string[] = [];
			if (reply.outcome !== expected) problems.push(`outcome is not ${expected}`);
			const held = (request as EndpointWorkflowSettleRequestV2 | EndpointWorkflowReleaseRequestV2)
				.owner;
			if (!sameFields({ owner: held }, reply, ['owner'])) {
				problems.push('owner is not the owner the request holds');
			}
			if (!sameFields(request, reply, Object.keys(request))) {
				problems.push('receipt does not echo the request');
			}
			if (!parsesAsDate(reply[at])) problems.push(`${at} is not a date`);
			return problems;
		}
		default:
			return [`${String(operation)} is not a workflow lifecycle operation`];
	}
}

/** The lifecycle over a v2 endpoint client. The client decides unavailable vs unknown on the wire. */
export function createEndpointWorkflowV2Client(
	endpoint: Pick<EndpointPort, 'v2'>
): EndpointWorkflowV2Client {
	async function call<O extends EndpointWorkflowV2Operation>(
		operation: O,
		request: EndpointWorkflowV2Exchange[O]['request']
	): Promise<EndpointInvokeOutcome<EndpointWorkflowV2Exchange[O]['reply']>> {
		const v2 = endpoint.v2;
		if (!v2?.negotiated(operation)) {
			return {
				status: 'unavailable',
				reason: 'not-negotiated',
				message: `The v2 attachment on this connection did not negotiate ${operation}; nothing was sent.`,
			};
		}
		const outcome = await v2.invoke(operation, request);
		if (outcome.status !== 'ok') return outcome;
		const problems = endpointWorkflowV2ReplyProblems(operation, request, outcome.payload);
		if (problems.length > 0) {
			return {
				status: 'unavailable',
				reason: 'malformed',
				message: `The ${operation} answer is not one for this request: ${problems.join('; ')}`,
			};
		}
		return {
			status: 'ok',
			payload: outcome.payload as EndpointWorkflowV2Exchange[O]['reply'],
		};
	}

	return {
		claim: (request) => call('workflow_claim', request),
		renew: (request) => call('workflow_renew', request),
		settle: (request) => call('workflow_settle', request),
		release: (request) => call('workflow_release', request),
	};
}

// ---------------------------------------------------------------------------
// The workflow owner port over the v2 client
//
// Held state has one home: `createWorkflowOwnership` in
// `src/shared/maestro-lib/managed/workflows.ts`. This adapter is the
// `WorkflowOwnerLifecyclePort` that store asks; it builds the v2 request from
// the store's input, the record it holds and the trusted authority references,
// and hands the checked reply back in the flat receipt shape the store reads
// (workflowId, owner, expiry). It keeps nothing itself, and a refused reply is
// returned as the client refused it, so the store decides what is held.
// ---------------------------------------------------------------------------

/** The authority references a v2 workflow request carries; supplied only after authenticated v2 negotiation. */
export type EndpointWorkflowV2Authority = Pick<
	EndpointWorkflowContextV2,
	'registration' | 'delegation' | 'grants'
>;

export interface EndpointWorkflowV2LifecycleDeps {
	/** Aborted when the authenticated v2 connection behind `client` is gone. */
	signal: AbortSignal;
	/** Whether `client` is still the current authenticated v2 path. */
	current(): boolean;
	/** The references for a request made as `owner`; null when there are none to carry (nothing is sent). */
	authority(owner: WorkflowOwnerStanding): EndpointWorkflowV2Authority | null;
	/**
	 * The digest of the evidence that a finished run's effect settled with
	 * `outcome`; null when there is none, and then nothing is settled or
	 * released. Never fabricated here.
	 */
	evidenceDigest?(input: WorkflowClaimInput, outcome: 'completed' | 'no_effect'): string | null;
	/** The lease a claim or renew asks for. Default 120000 ms; at most `ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS`. */
	requestedLeaseMs?: number;
}

const DEFAULT_REQUESTED_LEASE_MS = 120_000;

/** A Maestro value as a deterministic endpoint identifier, keyed by its role. */
const keyOf = (...parts: string[]): string => workflowEndpointId(JSON.stringify(parts));

/** The flat receipt `createWorkflowOwnership` reads, from a checked lease or echoed owner. */
function flatReceipt(
	outcome: 'owned' | 'renewed' | 'released',
	workflowId: string,
	owner: EndpointWorkflowOwnerV2,
	expiresAt?: string
): Record<string, unknown> {
	return {
		outcome,
		workflowId,
		ownerId: owner.ownerId,
		ownerEpoch: owner.ownerEpoch,
		fencingToken: owner.fencingToken,
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

/**
 * The `WorkflowOwnerLifecyclePort` over the v2 lifecycle client. `claim` with
 * no issued owner is `workflow_claim`; `claim` over a record the producer
 * issued (a retry, a restarted host) and `renew` are `workflow_renew` with the
 * held owner echoed; `release` settles the finished effect first and releases
 * only once it is settled (an uncertain effect is settled as uncertain and the
 * owner stays held, as the contract requires). A claim over a release whose
 * answer was lost is not re-sent: it needs the producer's reconciliation.
 */
export function endpointWorkflowV2LifecyclePort(
	client: EndpointWorkflowV2Client,
	deps: EndpointWorkflowV2LifecycleDeps
): WorkflowOwnerLifecyclePort {
	const requestedLeaseMs = Math.min(
		deps.requestedLeaseMs ?? DEFAULT_REQUESTED_LEASE_MS,
		ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS
	);
	const unknown = (message: string): EndpointInvokeOutcome<unknown> => ({
		status: 'unknown',
		message,
	});

	return {
		version: 1,
		signal: deps.signal,
		current: () => deps.current() && !deps.signal.aborted,
		async invoke(action, input, prior, owner, effect) {
			const authority = deps.authority(owner);
			if (!authority || owner.policyRevision === null) {
				return {
					status: 'unavailable',
					reason: 'not-negotiated',
					message: 'No authenticated v2 workflow authority references; nothing was sent.',
				};
			}
			const workflowId = workflowEndpointId(input.workflow.workflowId);
			const runId = workflowEndpointId(input.runId);
			const context = (role: string, ...salt: string[]): EndpointWorkflowContextV2 => ({
				...authority,
				workflowId,
				workflowVersion: workflowEndpointId(input.workflow.version),
				triggerId: workflowEndpointId(input.workflow.triggerEventId),
				runId,
				attemptId: workflowEndpointId(input.attemptId),
				idempotencyKey: keyOf('workflow', role, input.workflow.workflowId, input.runId, ...salt),
				policyRevision: owner.policyRevision as number,
				rootRunId: runId,
				parentRunId: null,
			});
			const held: EndpointWorkflowOwnerV2 | null =
				prior && prior.ownerEpoch !== UNISSUED_OWNER_EPOCH
					? {
							ownerId: prior.ownerId,
							ownerEpoch: prior.ownerEpoch,
							fencingToken: prior.fencingToken,
						}
					: null;

			if (action === 'claim' && prior?.pending === 'release') {
				return unknown('A release is awaiting producer reconciliation; it is not re-sent.');
			}
			if (action === 'claim' && !held) {
				const answer = await client.claim({ ...context('claim'), requestedLeaseMs });
				if (answer.status !== 'ok') return answer;
				if (answer.payload.outcome !== 'owned')
					return { status: 'denied', reason: answer.payload.reason };
				const { lease } = answer.payload;
				return {
					status: 'ok',
					payload: flatReceipt('owned', lease.workflowId, lease.owner, lease.expiresAt),
				};
			}
			if (!held) return unknown(`No issued owner is held to ${action}.`);
			if (action === 'claim' || action === 'renew') {
				const answer = await client.renew({
					...context('renew', held.ownerEpoch, input.attemptId, prior?.expiresAt ?? ''),
					requestedLeaseMs,
					owner: held,
				});
				if (answer.status !== 'ok') return answer;
				if (answer.payload.outcome !== 'renewed')
					return { status: 'denied', reason: answer.payload.reason };
				const { lease } = answer.payload;
				// The store reads a claim's receipt as `owned` and a renew's as `renewed`.
				return {
					status: 'ok',
					payload: flatReceipt(
						action === 'claim' ? 'owned' : 'renewed',
						lease.workflowId,
						lease.owner,
						lease.expiresAt
					),
				};
			}

			// release: settle what ran, then surrender custody.
			let disposition: EndpointWorkflowReleaseRequestV2['disposition'] = 'no_effect_started';
			if (effect !== undefined) {
				const settlement: EndpointWorkflowSettleRequestV2['effect'] | null =
					effect === 'uncertain'
						? { state: 'uncertain', reason: 'recovery_required' }
						: (() => {
								const outcome = effect === 'applied' ? 'completed' : 'no_effect';
								const evidenceDigest = deps.evidenceDigest?.(input, outcome) ?? null;
								return evidenceDigest === null
									? null
									: { state: 'settled', outcome, evidenceDigest };
							})();
				if (!settlement) {
					return unknown('No settlement evidence for the finished effect; custody stays held.');
				}
				const settled = await client.settle({
					...context('settle', held.ownerEpoch, input.attemptId),
					owner: held,
					effect: settlement,
				});
				if (settled.status !== 'ok') return settled;
				if (settled.payload.outcome !== 'recorded')
					return { status: 'denied', reason: settled.payload.reason };
				if (settlement.state === 'uncertain') {
					return unknown('The effect was settled as uncertain; the producer must reconcile it.');
				}
				disposition = 'effects_settled';
			}
			const released = await client.release({
				...context('release', held.ownerEpoch, input.attemptId),
				owner: held,
				disposition,
			});
			if (released.status !== 'ok') return released;
			if (released.payload.outcome !== 'released')
				return { status: 'denied', reason: released.payload.reason };
			return {
				status: 'ok',
				payload: flatReceipt('released', released.payload.workflowId, released.payload.owner),
			};
		},
	};
}
