/**
 * The v2 operation clients (noticeList, inbox, telemetry, budget, offline,
 * desktopPolicy, model) over the endpoint client's `/v2/invoke` path, behind a
 * negotiation gate.
 *
 * Two rules, both enforced here:
 *   - an operation is sent on v2 only when the v2 attachment on the CURRENT
 *     connection negotiated it (`v2OperationNegotiated`). Otherwise the call
 *     is `unavailable` / `not-negotiated` and nothing is sent;
 *   - an existing v1 caller moves to v2 only once Mega's parity matrix shows
 *     the operation served. That list is `V2_OPERATIONS_SELECTED`, and it is
 *     EMPTY: every caller stays on v1. These clients exist so a later change
 *     can select an operation; adding them changes no v1 behavior.
 *
 * The payloads are the contract's (contracts 0.2.0 protocol.js carries each
 * operation on v2 under its v1 name with the v1 schema), typed in
 * `src/shared/maestro-lib/managed/endpoint-port.ts`. The inbox request is the
 * v1 request field for field, `idempotencyKey` unchanged (`inboxRequestV2`).
 */

import {
	inboxRequestV2,
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
}

/**
 * The seven v2 operation clients over `endpoint`. Each one asks the gate
 * first; a port with no v2 side, or a connection whose v2 attachment did not
 * negotiate the operation, answers `unavailable` / `not-negotiated` and sends
 * nothing. The endpoint client decides unavailable vs unknown on the wire.
 */
export function createEndpointOperationsV2Client(
	endpoint: Pick<EndpointPort, 'v2' | 'state'>
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
		return { status: 'ok', payload: outcome.payload as Reply<O> };
	}

	return {
		noticeList: (request) => call('noticeList', request),
		inbox: (request) => call('inbox', inboxRequestV2(request)),
		telemetry: (request) => call('telemetry', request),
		budget: (request) => call('budget', request),
		offline: (request) => call('offline', request),
		desktopPolicy: (request) => call('desktopPolicy', request),
		model: (request) => call('model', request),
	};
}
