/**
 * The live execution check: one delegated workflow run against a LIVE
 * endpoint, end to end on protocol 2, reported as an observation a consumer
 * BUILD receipt can carry (`scripts/write-consumer-build-receipt.mjs
 * --live-observation`). It drives the production clients of this library and
 * nothing else:
 *
 *   1. `compatibility` with `supportedProtocols [2]` (availability only,
 *      answered before registration);
 *   2. `attachment` (refused before registration on a fresh process);
 *   3. `registration_challenge` (purpose `runtime_use`), the operator's
 *      approval, `registration_redeem` on the same connection;
 *   4. `attachment` again, then `registration_use`: the projected reference;
 *   5. `workflow_claim` carrying the delegation the central API issued,
 *      through `createEndpointWorkflowClient`;
 *   6. `execution` (`runs.submit`, `executionRequestV2`) through
 *      `createEndpointExecutionClient`, credited only as the correlated
 *      `dispatchReceiptV2`;
 *   7. custody: for a `dispatched` receipt the endpoint has already settled
 *      the effect centrally (it records the settlement, with its own
 *      evidence, before it answers `execution`, and the central record
 *      refuses any settlement after a settled one), so the check sends no
 *      `workflow_settle` and only `workflow_release` with `effects_settled`.
 *      For an `unknown` receipt the endpoint has settled nothing and keeps the
 *      effect for its own reconciliation: the check settles it `uncertain`
 *      (`recovery_required`) and does not release, so the owner stays held.
 *
 * Every value in the observation is one the endpoint answered or one this
 * check sent; nothing is fabricated. The delegation and grants are inputs,
 * issued by the central API to the peer's own actor: a reference alone
 * confers nothing, and this check never mints one. The registration nonce and
 * the fencing token are never written: the observation carries their digests.
 *
 * The check stops at the first step that does not answer as the contract
 * requires and reports `outcome: 'failed'` with that step; a failed
 * observation is not evidence of anything and the receipt writer refuses it.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../../canonicalJson';
import {
	LOCAL_ENDPOINT_PROTOCOL,
	type EndpointAttachmentRequest,
	type EndpointDelegationReference,
	type EndpointDispatchReceipt,
	type EndpointGrantReference,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type EndpointRegistrationApproval,
	type EndpointRuntimeUseReference,
	type EndpointWorkflowEffect,
	type EndpointWorkflowLease,
} from './endpoint-port';
import { createEndpointExecutionClient, type EndpointExecutionSubmission } from './execution';
import { createEndpointWorkflowClient } from './workflow-lifecycle';

export const LIVE_EXECUTION_OBSERVATION_SCHEMA = 'maestro-live-execution-observation/1';

/** The operations the check needs the attachment to negotiate, in the order it uses them. */
export const LIVE_EXECUTION_CAPABILITIES = [
	'registration_use',
	'workflow_claim',
	'workflow_settle',
	'workflow_release',
	'execution',
	'delegation',
] as const;

/** Where the authority references come from: the central API's delegation issuer, never this check. */
export interface LiveExecutionAuthority {
	delegation: EndpointDelegationReference;
	grants: readonly EndpointGrantReference[];
}

export interface LiveExecutionCheckInput {
	port: EndpointPort;
	/** Who attaches: `supportedProtocols` must be `[2]`. */
	attachment: EndpointAttachmentRequest;
	authority: LiveExecutionAuthority;
	/**
	 * The operator's approval of a registration challenge (browser approval on
	 * the central API). Resolves true once approved; false or absent redeems
	 * without waiting, which a live endpoint refuses unless it is approved.
	 */
	approve?(approval: EndpointRegistrationApproval): Promise<boolean>;
	workflow: {
		workflowId: string;
		workflowVersion: string;
		triggerId: string;
		runId: string;
		attemptId: string;
		rootRunId: string;
		parentRunId: string | null;
		/** Default: the attached status's applied policy revision. */
		policyRevision?: number;
		requestedLeaseMs: number;
	};
	/** What runs. None of it is authority. */
	execution: Omit<EndpointExecutionSubmission, 'lease' | 'run'>;
	/** Ids for the claim, settle and release requests. */
	newId(): string;
}

export interface LiveExecutionStep {
	step: string;
	status: EndpointInvokeOutcome<unknown>['status'] | 'refused';
	detail?: string;
}

export interface LiveExecutionObservation {
	schema: typeof LIVE_EXECUTION_OBSERVATION_SCHEMA;
	outcome: 'passed' | 'failed';
	/** The step that failed and why; absent when passed. */
	failure?: { step: string; detail: string };
	/** True only when the endpoint answered a negotiation on this connection. */
	liveNegotiationPerformed: boolean;
	endpoint: { socketPath: string };
	/** The protocols the live endpoint answered with (compatibility and every attachment). */
	liveEndpointProtocols: number[];
	compatibility: { protocol: number; capabilities: string[] } | null;
	attachment: {
		protocol: number;
		capabilities: string[];
		management: string;
		appliedPolicyRevision: number | null;
	} | null;
	/** Which of `LIVE_EXECUTION_CAPABILITIES` the attachment negotiated. */
	negotiated: Record<string, boolean>;
	/** True when the attachment negotiated `execution`, the workflow operations and `delegation`. */
	negotiatedWorkflowExecution: boolean;
	registration: {
		purpose: string;
		version: number;
		enrollmentId: string | null;
		processBirthDigest: string;
		referenceDigest: string;
		expiresAt: string;
	} | null;
	workflowOwner: { ownerId: string; ownerEpoch: string; fencingTokenSha256: string } | null;
	lease: { workflowId: string; runId: string; attemptId: string; expiresAt: string } | null;
	/** The presented grant (`delegation.grant`) as the claim and the execution carried it. */
	grant: EndpointGrantReference | null;
	grantDigest: string | null;
	/** The ordered chain as sent, root first; the wire has no aggregate chain digest. */
	chain: EndpointGrantReference[] | null;
	chainDigest: { encoding: 'sha256(canonicalJson(delegation.chain))'; value: string } | null;
	execution: {
		requestId: string;
		idempotencyKey: string;
		requestSha256: string;
		dispatch: EndpointDispatchReceipt['state'];
		receipt: EndpointDispatchReceipt;
	} | null;
	/**
	 * Who settled the dispatched effect. `endpoint`: a `dispatched` receipt,
	 * settled centrally by the endpoint itself; this check sent no settlement
	 * and does not observe its outcome. `consumer`: an `unknown` receipt, which
	 * this check settled `uncertain` (`outcome` is the `workflow_settle`
	 * answer).
	 */
	settlement:
		| { by: 'endpoint'; effect: 'settled' }
		| { by: 'consumer'; effect: 'uncertain'; outcome: string }
		| null;
	release: { outcome: string } | null;
	steps: LiveExecutionStep[];
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const digestOf = (value: unknown): string => sha256(canonicalJson(value));

class StepFailed extends Error {
	constructor(
		readonly step: string,
		readonly detail: string
	) {
		super(`${step}: ${detail}`);
	}
}

function describe(outcome: EndpointInvokeOutcome<unknown>): string {
	if (outcome.status === 'denied') return `denied ${outcome.reason}`;
	if (outcome.status === 'unavailable') return `unavailable ${outcome.reason}: ${outcome.message}`;
	if (outcome.status === 'unknown') return `unknown: ${outcome.message}`;
	return 'ok';
}

/** Run the check once over `input.port`. Never throws for an endpoint answer; the observation says what happened. */
export async function runLiveExecutionCheck(
	input: LiveExecutionCheckInput
): Promise<LiveExecutionObservation> {
	const { port } = input;
	const observation: LiveExecutionObservation = {
		schema: LIVE_EXECUTION_OBSERVATION_SCHEMA,
		outcome: 'failed',
		liveNegotiationPerformed: false,
		endpoint: { socketPath: port.socketPath },
		liveEndpointProtocols: [],
		compatibility: null,
		attachment: null,
		negotiated: {},
		negotiatedWorkflowExecution: false,
		registration: null,
		workflowOwner: null,
		lease: null,
		grant: null,
		grantDigest: null,
		chain: null,
		chainDigest: null,
		execution: null,
		settlement: null,
		release: null,
		steps: [],
	};
	const record = <T>(step: string, outcome: EndpointInvokeOutcome<T>): T => {
		observation.steps.push({
			step,
			status: outcome.status,
			...(outcome.status === 'ok' ? {} : { detail: describe(outcome) }),
		});
		if (outcome.status !== 'ok') throw new StepFailed(step, describe(outcome));
		return outcome.payload;
	};
	const refuse = (step: string, detail: string): never => {
		observation.steps.push({ step, status: 'refused', detail });
		throw new StepFailed(step, detail);
	};
	const noteProtocol = (protocol: number) => {
		if (!observation.liveEndpointProtocols.includes(protocol))
			observation.liveEndpointProtocols.push(protocol);
	};

	try {
		const attachment = input.attachment;
		if (
			attachment.supportedProtocols.length !== 1 ||
			attachment.supportedProtocols[0] !== LOCAL_ENDPOINT_PROTOCOL
		)
			refuse('input', 'the attachment must offer supportedProtocols [2] only');
		const { delegation, grants } = input.authority;
		if (!delegation || !Array.isArray(delegation.chain) || delegation.chain.length === 0)
			refuse('input', 'a delegated claim needs a delegation reference with its chain');
		if (canonicalJson(delegation.chain.at(-1)) !== canonicalJson(delegation.grant))
			refuse('input', 'the delegation chain does not end in its grant');

		// 1. Availability, before any registration or attachment; records nothing on the connection.
		const compat = record(
			'compatibility',
			await port.compatibility({
				supportedProtocols: [LOCAL_ENDPOINT_PROTOCOL],
				supportedCapabilities: attachment.supportedCapabilities,
				requiredCapabilities: [],
			})
		);
		observation.liveNegotiationPerformed = true;
		observation.compatibility = {
			protocol: compat.protocol,
			capabilities: [...compat.capabilities],
		};
		noteProtocol(compat.protocol);

		// 2-4. Attach; on a fresh process the endpoint refuses until the actor registers.
		let status = await port.attach(attachment);
		observation.steps.push({
			step: 'attachment',
			status: status.status,
			...(status.status === 'ok' ? {} : { detail: describe(status) }),
		});
		if (status.status !== 'ok') {
			const approval = record(
				'registration_challenge',
				await port.registration.challenge({
					runtimeId: attachment.runtimeId,
					processEpoch: attachment.processEpoch,
				})
			);
			if (input.approve && !(await input.approve(approval)))
				refuse('registration_approval', 'the registration challenge was not approved in time');
			record('registration_redeem', await port.registration.redeem());
			status = await port.attach(attachment);
			record('attachment', status);
		}
		if (status.status !== 'ok') return refuse('attachment', describe(status));
		const attached = status.payload;
		noteProtocol(attached.protocol);
		observation.attachment = {
			protocol: attached.protocol,
			capabilities: [...attached.capabilities],
			management: attached.management,
			appliedPolicyRevision: attached.appliedPolicyRevision,
		};
		observation.negotiated = Object.fromEntries(
			LIVE_EXECUTION_CAPABILITIES.map((operation) => [operation, port.negotiated(operation)])
		);
		observation.negotiatedWorkflowExecution = LIVE_EXECUTION_CAPABILITIES.every((operation) =>
			port.negotiated(operation)
		);
		if (!observation.negotiatedWorkflowExecution) {
			refuse(
				'negotiation',
				`the attachment did not negotiate ${LIVE_EXECUTION_CAPABILITIES.filter((o) => !port.negotiated(o)).join(', ')}`
			);
		}

		const use = record('registration_use', await port.registration.use());
		if (use.outcome !== 'projected') return refuse('registration_use', `denied ${use.reason}`);
		const reference: EndpointRuntimeUseReference = use.reference;
		observation.registration = {
			purpose: reference.purpose,
			version: reference.version,
			enrollmentId: reference.enrollmentId ?? null,
			processBirthDigest: reference.processBirthDigest,
			referenceDigest: digestOf(reference),
			expiresAt: use.expiresAt,
		};

		// 5. The delegated claim.
		const policyRevision = input.workflow.policyRevision ?? attached.appliedPolicyRevision;
		if (policyRevision === null || policyRevision === undefined)
			return refuse('workflow_claim', 'no policy revision is applied on the endpoint');
		const workflows = createEndpointWorkflowClient(port);
		const context = {
			registration: reference,
			delegation,
			grants: [...grants],
			workflowId: input.workflow.workflowId,
			workflowVersion: input.workflow.workflowVersion,
			triggerId: input.workflow.triggerId,
			runId: input.workflow.runId,
			attemptId: input.workflow.attemptId,
			policyRevision,
			rootRunId: input.workflow.rootRunId,
			parentRunId: input.workflow.parentRunId,
		};
		const claim = record(
			'workflow_claim',
			await workflows.claim({
				...context,
				idempotencyKey: input.newId(),
				requestedLeaseMs: input.workflow.requestedLeaseMs,
			})
		);
		if (claim.outcome !== 'owned') return refuse('workflow_claim', `denied ${claim.reason}`);
		const lease: EndpointWorkflowLease = claim.lease;
		observation.workflowOwner = {
			ownerId: lease.owner.ownerId,
			ownerEpoch: lease.owner.ownerEpoch,
			fencingTokenSha256: sha256(lease.owner.fencingToken),
		};
		observation.lease = {
			workflowId: lease.workflowId,
			runId: lease.runId,
			attemptId: lease.attemptId,
			expiresAt: lease.expiresAt,
		};
		if (!lease.delegation) return refuse('workflow_claim', 'the lease carries no delegation');
		observation.grant = { ...lease.delegation.grant };
		observation.grantDigest = lease.delegation.grant.digest;
		observation.chain = lease.delegation.chain.map((hop) => ({ ...hop }));
		observation.chainDigest = {
			encoding: 'sha256(canonicalJson(delegation.chain))',
			value: digestOf(lease.delegation.chain),
		};

		// 6. Execution under the lease, fenced by the owner the claim answered.
		const executions = createEndpointExecutionClient(port, {
			fence: () => ({ ...lease.owner }),
			registration: () => reference,
		});
		const dispatched = record(
			'execution',
			await executions.submit({
				...input.execution,
				lease,
				run: { runId: lease.runId, attemptId: lease.attemptId },
			})
		);
		observation.execution = {
			requestId: dispatched.request.requestId,
			idempotencyKey: dispatched.request.idempotencyKey,
			requestSha256: digestOf(dispatched.request),
			dispatch: dispatched.dispatch,
			receipt: dispatched.receipt,
		};

		// 7. A dispatched effect is the endpoint's to settle (it already has); an unknown one stays held.
		const owner = { ...lease.owner };
		if (dispatched.dispatch === 'unknown') {
			const effect: EndpointWorkflowEffect = { state: 'uncertain', reason: 'recovery_required' };
			const settled = record(
				'workflow_settle',
				await workflows.settle({ ...context, idempotencyKey: input.newId(), owner, effect })
			);
			if (settled.outcome !== 'recorded')
				return refuse('workflow_settle', `denied ${(settled as { reason: string }).reason}`);
			observation.settlement = { by: 'consumer', effect: 'uncertain', outcome: settled.outcome };
		} else {
			observation.settlement = { by: 'endpoint', effect: 'settled' };
			const released = record(
				'workflow_release',
				await workflows.release({
					...context,
					idempotencyKey: input.newId(),
					owner,
					disposition: 'effects_settled',
				})
			);
			if (released.outcome !== 'released')
				return refuse('workflow_release', `denied ${(released as { reason: string }).reason}`);
			observation.release = { outcome: released.outcome };
		}
		observation.outcome = 'passed';
		return observation;
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		observation.outcome = 'failed';
		observation.failure = { step: error.step, detail: error.detail };
		return observation;
	}
}
