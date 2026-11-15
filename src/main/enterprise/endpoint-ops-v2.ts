/**
 * The v2 operation clients (noticeList, inbox, telemetry, budget, offline,
 * desktopPolicy, model, localControl, command) over the endpoint client's
 * `/v2/invoke` path, behind a negotiation gate.
 *
 * Rules, each enforced here:
 *   - an operation is sent on v2 only when the v2 attachment on the CURRENT
 *     connection negotiated it (`v2OperationNegotiated`). Otherwise the call
 *     is `unavailable` / `not-negotiated` and nothing is sent;
 *   - an existing caller moves to v2 only for an operation in
 *     `V2_OPERATIONS_SELECTED`, each a passing row of Mega's parity matrix;
 *   - `localControl` (decision D2) is the local GUI selector path:
 *     `cancel_run` and `report_status` need a `runtime_use` registration,
 *     `refresh_policy` a `fleet_management` one, and a selector this
 *     process's registration cannot carry is refused before anything is sent.
 *     It is never a signed body;
 *   - `command` carries a signed central delivery (`commandRequestV2`)
 *     unchanged; the receipt must name the command and echo the correlation
 *     exactly. The renderer never builds or alters a signed envelope.
 *
 * The payloads are the contract's (contracts 0.3.0 protocol.js), typed in
 * `src/shared/maestro-lib/managed/endpoint-port.ts`. The inbox request is the
 * v1 request field for field, `idempotencyKey` unchanged (`inboxRequestV2`).
 */

import { canonicalJson } from '../../shared/canonicalJson';

import {
	ENDPOINT_LOCAL_CONTROL_AUTHORITY,
	inboxRequestV2,
	isEndpointIdentifier,
	v2OperationNegotiated,
	type EndpointInvokeOutcome,
	type EndpointOperationV2Client,
	type EndpointOperationV2Exchange,
	type EndpointPort,
} from '../../shared/maestro-lib/managed/endpoint-port';

/**
 * The v2 operations an existing v1 caller is moved onto (EMPTY until Mega's
 * parity matrix shows an operation served), the negotiation gate, and the
 * selection the v1 callers go through. Their one home is the shared
 * endpoint-port module so the shared host-adapter callers read the same list.
 */
export {
	V2_OPERATIONS_SELECTED,
	invokeSelectedEndpointOperation,
	selectEndpointOperationPath,
	v2OperationNegotiated,
} from '../../shared/maestro-lib/managed/endpoint-port';

type Request<O extends EndpointOperationV2Client> = EndpointOperationV2Exchange[O]['request'];
type Reply<O extends EndpointOperationV2Client> = EndpointOperationV2Exchange[O]['reply'];
type Outcome<O extends EndpointOperationV2Client> = Promise<EndpointInvokeOutcome<Reply<O>>>;

export interface EndpointOperationsV2Client {
	noticeList(request: Request<'noticeList'>): Outcome<'noticeList'>;
	inbox(request: Request<'inbox'>): Outcome<'inbox'>;
	telemetry(request: Request<'telemetry'>): Outcome<'telemetry'>;
	budget(request: Request<'budget'>): Outcome<'budget'>;
	offline(request: Request<'offline'>): Outcome<'offline'>;
	desktopPolicy(request: Request<'desktopPolicy'>): Outcome<'desktopPolicy'>;
	model(request: Request<'model'>): Outcome<'model'>;
	/** A local GUI selector; refused before sending when this registration lacks the selector's purpose. */
	localControl(request: Request<'localControl'>): Outcome<'localControl'>;
	/** A signed central delivery, relayed unchanged. */
	command(request: Request<'command'>): Outcome<'command'>;
}

export interface EndpointOperationsV2Options {
	/**
	 * The purpose of the registration this process holds on the current
	 * connection (the `registration_use` reference's), or null when none is
	 * projected. Maestro registers `runtime_use` only.
	 */
	registrationPurpose?(): 'runtime_use' | 'fleet_management' | null;
}

/** Why a `localControl` request is not the contract's shape, or []. */
export function localControlRequestProblems(request: Request<'localControl'>): string[] {
	const problems: string[] = [];
	if (!isEndpointIdentifier(request.commandId)) problems.push('commandId is not an identifier');
	if (!isEndpointIdentifier(request.targetId)) problems.push('targetId is not an identifier');
	if (!Number.isFinite(Date.parse(request.expiresAt)))
		problems.push('expiresAt is not a timestamp');
	if (!Number.isSafeInteger(request.policyRevision) || request.policyRevision < 0)
		problems.push('policyRevision is not a revision');
	if (!isEndpointIdentifier(request.precondition?.processEpoch))
		problems.push('precondition.processEpoch is not an identifier');
	const action = request.action;
	if (!action || !(action.kind in ENDPOINT_LOCAL_CONTROL_AUTHORITY))
		problems.push('action is not a local control selector');
	else if (action.kind === 'cancel_run' && request.precondition.expectedRunId !== action.runId)
		problems.push('cancel_run must expect the run it names');
	return problems;
}

/** Why a reply is not a receipt for `request`, or []. A denial is not a problem. */
function receiptProblems(
	operation: 'localControl' | 'command',
	request: Request<'localControl'> | Request<'command'>,
	payload: unknown
): string[] {
	if (typeof payload !== 'object' || payload === null) return ['the answer is not an object'];
	const answer = payload as Record<string, unknown>;
	if (answer.outcome === 'denied') return [];
	const problems: string[] = [];
	if (!['accepted', 'completed', 'unknown'].includes(answer.outcome as string))
		problems.push('outcome is not accepted, completed or unknown');
	const commandId =
		operation === 'localControl'
			? (request as Request<'localControl'>).commandId
			: (request as Request<'command'>).command.payload.commandId;
	if (answer.commandId !== commandId) problems.push('commandId is not the one sent');
	if (operation === 'command') {
		if (!isEndpointIdentifier(answer.processEpoch))
			problems.push('processEpoch is not an identifier');
		if (typeof answer.runId !== 'string' || answer.runId.length === 0)
			problems.push('runId is not a run');
		if (
			canonicalJson(answer.correlation) !==
			canonicalJson((request as Request<'command'>).correlation)
		)
			problems.push('correlation is not the one sent');
	} else if (Object.keys(answer).sort().join(',') !== 'commandId,outcome') {
		problems.push('the receipt carries fields commandReceipt does not');
	}
	return problems;
}

/**
 * The nine v2 operation clients over `endpoint`. Each one asks the gate
 * first; a port with no v2 side, or a connection whose v2 attachment did not
 * negotiate the operation, answers `unavailable` / `not-negotiated` and sends
 * nothing. The endpoint client decides unavailable vs unknown on the wire.
 */
export function createEndpointOperationsV2Client(
	endpoint: Pick<EndpointPort, 'v2' | 'state'>,
	options: EndpointOperationsV2Options = {}
): EndpointOperationsV2Client {
	async function call<O extends EndpointOperationV2Client>(
		operation: O,
		request: Request<O>
	): Outcome<O> {
		const v2 = endpoint.v2;
		if (!v2 || !v2OperationNegotiated(endpoint.state(), operation)) {
			return {
				status: 'unavailable',
				reason: 'not-negotiated',
				message: `The v2 attachment on this connection did not negotiate ${operation}; nothing was sent.`,
			};
		}
		const outcome = await v2.invoke(operation, request);
		if (outcome.status !== 'ok') return outcome;
		if (operation === 'localControl' || operation === 'command') {
			const problems = receiptProblems(
				operation,
				request as Request<'localControl'> | Request<'command'>,
				outcome.payload
			);
			if (problems.length > 0) {
				return {
					status: 'unavailable',
					reason: 'malformed',
					message: `The ${operation} answer is not a receipt for this request: ${problems.join('; ')}`,
				};
			}
		}
		return { status: 'ok', payload: outcome.payload as Reply<O> };
	}

	async function localControl(request: Request<'localControl'>): Outcome<'localControl'> {
		const problems = localControlRequestProblems(request);
		if (problems.length > 0) {
			return {
				status: 'unavailable',
				reason: 'malformed',
				message: `The localControl request was not sent: ${problems.join('; ')}`,
			};
		}
		const needed = ENDPOINT_LOCAL_CONTROL_AUTHORITY[request.action.kind];
		const held = options.registrationPurpose?.() ?? null;
		if (held !== needed) {
			// Nothing is sent: the endpoint would refuse it, and this process must not ask.
			return {
				status: 'unavailable',
				reason: 'not-authorized',
				message: `localControl ${request.action.kind} needs a ${needed} registration; this process holds ${held ?? 'none'}. Nothing was sent.`,
			};
		}
		return call('localControl', request);
	}

	return {
		noticeList: (request) => call('noticeList', request),
		inbox: (request) => call('inbox', inboxRequestV2(request)),
		telemetry: (request) => call('telemetry', request),
		budget: (request) => call('budget', request),
		offline: (request) => call('offline', request),
		desktopPolicy: (request) => call('desktopPolicy', request),
		model: (request) => call('model', request),
		localControl,
		command: (request) => call('command', request),
	};
}
