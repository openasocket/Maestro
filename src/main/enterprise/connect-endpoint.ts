/**
 * The Mega adapter for Connect to your organization (MSX-02-08): Maestro's own
 * ConnectPort (`megaConnect/port.ts`) over the endpoint client's Connect
 * operations (`connect`, `connection_status`, `disconnect`, MSX-02-07).
 *
 * The endpoint identifies the caller by its native admission of this process
 * (the OS account that runs Maestro), not by anything in the payload, so the
 * adapter sends only what the person typed and opens only the socket this
 * account's settings resolve to. Every answer the client passes on has already
 * been checked against the connect schemas; the adapter maps it to Maestro's
 * status union and passes display names through, never an ID.
 *
 * A denied or unavailable answer, or a refused connect, is thrown: the connect
 * service turns a throw into `endpoint_failed` (or `unavailable` on a poll)
 * without passing the message on.
 */

import type {
	EndpointConnectAnswer,
	EndpointConnectionStatus,
	EndpointConnectRequest,
	EndpointInvokeOutcome,
	EndpointPort,
} from '../../shared/maestro-lib/managed/endpoint-port';
import { LOCAL_ENDPOINT_CONNECT_OPERATIONS } from '../../shared/maestro-lib/managed/endpoint-port';
import type { ResolvedEndpointSocket } from '../../shared/megaServer';
import type {
	ConnectPort,
	ConnectStartInput,
	ConnectStatusResult,
} from '../../shared/megaConnect/port';
import type { MegaConnectStatus } from '../../shared/megaConnect/view';

/**
 * The operations an endpoint must advertise for the adapter to bind. `disconnect`
 * is not among them: Mega serves it later (SIMPLE-04-03), and until then its
 * denial passes through to the person as a failed disconnect.
 */
export const CONNECT_REQUIRED_OPERATIONS = ['connect', 'connection_status'] as const;

function payloadOf<T>(operation: string, outcome: EndpointInvokeOutcome<unknown>): T {
	if (outcome.status === 'ok') return outcome.payload as T;
	// The reason is a wire code, never a value the person typed.
	throw new Error(
		`The endpoint did not answer ${operation}: ${outcome.status === 'denied' ? outcome.reason : outcome.status}.`
	);
}

function requestOf(input: ConnectStartInput): EndpointConnectRequest {
	switch (input.kind) {
		case 'email':
			return { email: input.email };
		case 'joinLink':
			return { joinLink: input.joinLink.url };
		case 'teamCode':
			return { teamCode: input.teamCode, server: input.server };
		case 'managed':
			return { managed: true };
	}
}

/** The endpoint's connection state as Maestro's status union. Names only. */
export function connectStatusOf(answer: EndpointConnectionStatus): MegaConnectStatus {
	switch (answer.state) {
		case 'not_connected':
		case 'disconnected':
			return { kind: 'notConnected' };
		// Approved but not yet connected: still waiting on the endpoint, not on the person.
		case 'waiting':
		case 'approved':
			return answer.request
				? { kind: 'waiting', request: answer.request.number }
				: { kind: 'waiting' };
		case 'connected': {
			const { tenant, teamPath, policy } = answer.names;
			return {
				kind: 'connected',
				...(tenant ? { orgName: tenant.displayName } : {}),
				...(teamPath ? { teamPath } : {}),
				...(policy ? { policy: { name: policy.name, revision: policy.revision } } : {}),
			};
		}
		case 'denied':
			return { kind: 'denied' };
		case 'expired':
			return { kind: 'expired' };
		case 'revoked':
			return { kind: 'revoked' };
		case 'grant_expired':
			return { kind: 'grantExpired' };
	}
}

/** ConnectPort over an endpoint connection. The connection needs no attachment. */
export function createEndpointConnectPort(endpoint: Pick<EndpointPort, 'invoke'>): ConnectPort {
	return {
		async start(input) {
			const answer = payloadOf<EndpointConnectAnswer>(
				'connect',
				await endpoint.invoke('connect', requestOf(input))
			);
			if (answer.outcome === 'refused') {
				throw new Error(`The endpoint refused the connect request: ${answer.code}.`);
			}
			return {
				requestNumber: answer.requestNumber,
				approvalUrl: answer.approvalUrl,
				number: answer.number,
				server: answer.server,
				tenantDisplayName: answer.tenantDisplayName,
			};
		},
		async status(): Promise<ConnectStatusResult> {
			const answer = payloadOf<EndpointConnectionStatus>(
				'connection_status',
				await endpoint.invoke('connection_status', {})
			);
			const status = connectStatusOf(answer);
			return answer.names.device ? { status, names: { device: answer.names.device } } : { status };
		},
		async disconnect() {
			payloadOf('disconnect', await endpoint.invoke('disconnect', {}));
		},
	};
}

export interface BoundConnectPort {
	readonly port: ConnectPort;
	close(): Promise<void>;
}

/**
 * Opens the resolved socket and binds the adapter when the endpoint advertises
 * the connect operations; otherwise closes the connection and answers null, so
 * the connect service keeps answering `endpoint_connect_unavailable`. Never throws.
 */
export async function bindEndpointConnectPort(deps: {
	socket: ResolvedEndpointSocket;
	openPort: (socketPath: string) => EndpointPort;
}): Promise<BoundConnectPort | null> {
	if (deps.socket.socketPath === null) return null;
	let endpoint: EndpointPort;
	try {
		endpoint = deps.openPort(deps.socket.socketPath);
	} catch {
		return null;
	}
	const close = () => endpoint.close().catch(() => undefined);
	try {
		const offer = await endpoint.compatibility({
			supportedProtocols: [2],
			supportedCapabilities: [...LOCAL_ENDPOINT_CONNECT_OPERATIONS],
			requiredCapabilities: [],
		});
		const advertised =
			offer.status === 'ok' &&
			CONNECT_REQUIRED_OPERATIONS.every((op) => offer.payload.capabilities.includes(op));
		if (advertised) return { port: createEndpointConnectPort(endpoint), close };
	} catch {
		// An endpoint that cannot be asked is not bound.
	}
	await close();
	return null;
}
