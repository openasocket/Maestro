/**
 * The local endpoint client: `EndpointPort` over the endpoint daemon's
 * private Unix socket, with `node:http`.
 *
 * One connection, one request at a time. The endpoint binds its session to
 * the socket (an `attachment` must come first, every later operation is
 * answered on that socket only, and a registration challenge is redeemed on
 * the connection that asked for it), so the client keeps one keep-alive
 * socket, serializes its calls, and forgets everything the endpoint knew
 * about the old socket the moment a new one is dialed: `attached` drops, the
 * last status drops, the negotiation drops, a challenge that was not redeemed
 * drops. A completed registration is the process's, not the socket's, and
 * survives a redial.
 *
 * What the client refuses to do:
 *   - speak TCP. The socket path is a path; a URL, a host or a port is not
 *     accepted at construction. Loopback TCP tells the endpoint nothing about
 *     the peer, so an endpoint reached that way could not authenticate it,
 *     and a client that could be pointed at one would be a client that could
 *     be pointed at an impostor.
 *   - send what it cannot describe. An attachment request is validated here
 *     before a byte leaves; a request over the size bound is not sent.
 *   - read an answer that is not to its question. The correlation id and the
 *     operation of every envelope are checked against the request; an answer
 *     larger than the bound is dropped unread.
 *   - call anything authority. `attach` returning `attached` means the socket
 *     is attached; whether this host is managed is decided by the enrollment
 *     lifecycle from the status, the registration and its own custody.
 *
 * On macOS and Windows (`createPlatformEndpointClient`) every new connection
 * is used only once a host-injected `EndpointNativePort` has named its server
 * as the same service principal as the first; with no port, no client. Linux
 * keeps the socket rule it always had.
 *
 * Nothing here is logged: the registration nonce passes through `challenge`
 * once, to the caller, and nowhere else. No Electron import, so the same
 * client serves `maestro-cli host`.
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import type { Socket } from 'node:net';
import * as path from 'node:path';

import {
	LOCAL_ENDPOINT_EFFECTFUL_OPERATIONS,
	LOCAL_ENDPOINT_INVOKE_PATH,
	LOCAL_ENDPOINT_MAX_REQUEST_BYTES,
	LOCAL_ENDPOINT_MAX_RESPONSE_BYTES,
	LOCAL_ENDPOINT_PROTOCOL,
	LOCAL_ENDPOINT_REGISTRATION_CHALLENGE_OPERATION,
	LOCAL_ENDPOINT_REGISTRATION_PURPOSE,
	LOCAL_ENDPOINT_REGISTRATION_REDEEM_OPERATION,
	LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION,
	LOCAL_ENDPOINT_REGISTRATION_VERSION,
	LOCAL_ENDPOINT_TIMEOUT_MS,
	endpointAddressProblem,
	endpointAttachmentRequestProblems,
	endpointCompatibilityResultProblems,
	endpointNativePortProblem,
	endpointRegistrationApprovalProblems,
	endpointRegistrationUseReplyProblems,
	endpointServerVerificationProblems,
	endpointStatusProblems,
	frameLocalEndpointRequest,
	isEndpointDenied,
	isEndpointIdentifier,
	parseLocalEndpointResponse,
	type EndpointAttachmentRequest,
	type EndpointCompatibilityRequest,
	type EndpointCompatibilityResult,
	type EndpointConnectionState,
	type EndpointInvokeOutcome,
	type EndpointNativePort,
	type EndpointNegotiation,
	type EndpointPort,
	type EndpointRegistrationApproval,
	type EndpointRegistrationPhase,
	type EndpointRegistrationReceipt,
	type EndpointRegistrationUseReply,
	type EndpointServerIdentity,
	type EndpointStatus,
	type LocalEndpointOperation,
} from './endpoint-port';

/**
 * The operations a connection may carry before its attachment: the attachment
 * itself, compatibility, the registration handshake and relayed enrollment. Any
 * other operation waits for the attachment, which the endpoint requires first.
 */
const PRE_ATTACHMENT_OPERATIONS: readonly LocalEndpointOperation[] = [
	'attachment',
	'compatibility',
	'registration_challenge',
	'registration_redeem',
	'enrollment',
];

/** The longest Unix socket path every supported kernel accepts (`sun_path` less the terminator). */
const MAX_SOCKET_PATH_BYTES = 103;
/** Slack past the endpoint's own deadline, so its 504 arrives before ours fires. */
const TIMEOUT_SLACK_MS = 1_000;

export interface LocalEndpointClientDeps {
	socketPath: string;
	/** The endpoint's own deadline is 5 s; the client allows it plus one second. */
	timeoutMs?: number;
	newCorrelationId?: () => string;
	/** Test seam: the function that opens a request. Defaults to `http.request`. */
	request?: typeof http.request;
	/**
	 * The platform whose endpoint transport this client speaks. Absent (and no
	 * `native`), the Unix socket rule this client always applied; present, the
	 * platform's own address rule and native-port requirement.
	 */
	platform?: string;
	/** Names the process behind each new connection; required on macOS and Windows. */
	native?: EndpointNativePort;
}

type Unavailable = Extract<EndpointInvokeOutcome<never>, { status: 'unavailable' }>;
const unavailable = (reason: Unavailable['reason'], message: string): Unavailable => ({
	status: 'unavailable',
	reason,
	message,
});

/** Why `socketPath` is not a private Unix socket this client will dial, or null. */
export function endpointSocketPathProblem(socketPath: string): string | null {
	if (typeof socketPath !== 'string' || socketPath.length === 0) return 'The socket path is empty.';
	if (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(socketPath) ||
		/^(localhost|127\.|\[::1\])/i.test(socketPath)
	) {
		return 'The endpoint is reached over a Unix socket only; a URL, host or port is not accepted.';
	}
	if (!path.isAbsolute(socketPath)) return 'The socket path must be absolute.';
	if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
		return `The socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes.`;
	}
	return null;
}

class PeerUnverified extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PeerUnverified';
	}
}

class RequestTimeout extends Error {
	constructor() {
		super('The endpoint did not answer in time.');
		this.name = 'RequestTimeout';
	}
}

/** Problems with a compatibility request: identifier lists, unique, required within supported. */
function compatibilityRequestProblems(req: {
	supportedCapabilities: readonly string[];
	requiredCapabilities: readonly string[];
}): string[] {
	const problems: string[] = [];
	const list = (value: unknown): value is string[] =>
		Array.isArray(value) && value.length <= 128 && value.every(isEndpointIdentifier);
	if (!list(req.supportedCapabilities)) problems.push('supportedCapabilities is not a list');
	if (!list(req.requiredCapabilities)) problems.push('requiredCapabilities is not a list');
	if (problems.length > 0) return problems;
	if (new Set(req.supportedCapabilities).size !== req.supportedCapabilities.length)
		problems.push('supportedCapabilities repeats an entry');
	if (!req.requiredCapabilities.every((item) => req.supportedCapabilities.includes(item)))
		problems.push('requiredCapabilities names a capability that is not supported');
	return problems;
}

export function createLocalEndpointClient(deps: LocalEndpointClientDeps): EndpointPort {
	const native = deps.native;
	const platform = deps.platform ?? (native ? process.platform : undefined);
	const problem =
		platform === undefined
			? endpointSocketPathProblem(deps.socketPath)
			: (endpointAddressProblem(platform, deps.socketPath) ??
				endpointNativePortProblem(platform, native));
	if (problem) throw new Error(`Endpoint socket refused: ${problem}`);
	const timeoutMs = deps.timeoutMs ?? LOCAL_ENDPOINT_TIMEOUT_MS + TIMEOUT_SLACK_MS;
	const newCorrelationId = deps.newCorrelationId ?? randomUUID;
	const request = deps.request ?? http.request;
	const agent = new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });

	let connection = 0;
	let socket: Socket | null = null;
	let attached = false;
	let status: EndpointStatus | null = null;
	/** What the current connection's attachment negotiated; one protocol per socket session. */
	let negotiated: EndpointNegotiation | null = null;
	let registration: EndpointRegistrationPhase = 'none';
	let closed = false;
	let chain: Promise<unknown> = Promise.resolve();
	/** The server the native port named for the current connection, and the principal every connection must share. */
	let server: EndpointServerIdentity | null = null;
	let boundPrincipal: string | null = null;
	const verified = new WeakMap<Socket, EndpointServerIdentity>();

	if (native) {
		// Every new connection is verified once connected and before the agent
		// hands it to a request, so nothing is written to an unnamed server.
		const verifiedConnection = (
			_options: unknown,
			oncreate: (error: Error | null, socket?: Socket) => void
		): undefined => {
			const candidate = net.createConnection({ path: deps.socketPath });
			const controller = new AbortController();
			let settled = false;
			const settle = (error: Error | null): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) {
					controller.abort();
					candidate.destroy();
					oncreate(error);
					return;
				}
				oncreate(null, candidate);
			};
			const timer = setTimeout(() => settle(new RequestTimeout()), timeoutMs);
			candidate.once('error', (error) => settle(error));
			/** Why the verified server may not serve this client, or null. */
			const refusalOf = (verification: unknown): string | null => {
				if (candidate.destroyed) return 'The connection closed while its server was being named.';
				const problems = endpointServerVerificationProblems(verification);
				if (problems.length > 0)
					return `The endpoint server is not verified: ${problems.join('; ')}`;
				const { principal } = (verification as { server: EndpointServerIdentity }).server;
				return boundPrincipal === null || principal === boundPrincipal
					? null
					: `The endpoint server runs as ${principal}, not ${boundPrincipal} as before.`;
			};
			candidate.once('connect', () => {
				new Promise<unknown>((resolve) =>
					resolve(
						native.verifyServer({
							address: deps.socketPath,
							handle: candidate,
							signal: controller.signal,
						})
					)
				).then(
					(verification) => {
						if (settled) return;
						const refusal = refusalOf(verification);
						if (refusal) return settle(new PeerUnverified(refusal));
						const identity = (verification as { server: EndpointServerIdentity }).server;
						boundPrincipal ??= identity.principal;
						verified.set(candidate, { ...identity });
						settle(null);
					},
					(error: unknown) =>
						settle(new PeerUnverified(`The native endpoint port failed: ${String(error)}`))
				);
			});
			return undefined;
		};
		(agent as unknown as { createConnection: typeof verifiedConnection }).createConnection =
			verifiedConnection;
	}

	const serialized = <T>(work: () => Promise<T>): Promise<T> => {
		const next = chain.then(work, work);
		chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	};

	/** The endpoint's session died with the socket; so does everything the client believed about it. */
	function connectionLost(lost: Socket): void {
		if (socket !== lost) return;
		socket = null;
		server = null;
		attached = false;
		status = null;
		negotiated = null;
		if (registration === 'challenged') registration = 'none';
	}

	function adopt(next: Socket): void {
		if (socket === next) return;
		if (socket) connectionLost(socket);
		socket = next;
		server = verified.get(next) ?? null;
		connection += 1;
		attached = false;
		status = null;
		negotiated = null;
		if (registration === 'challenged') registration = 'none';
		next.once('close', () => connectionLost(next));
	}

	interface Exchange {
		statusCode: number;
		body: unknown;
	}

	/**
	 * One request, one answer, both bounded. Rejects with `RequestTimeout` or
	 * the socket's error; `sent` says whether the whole request left this
	 * process, which is what decides between `unavailable` and `unknown`.
	 */
	function exchange(urlPath: string, body: string): Promise<Exchange> & { sent: () => boolean } {
		let sent = false;
		const promise = new Promise<Exchange>((resolve, reject) => {
			const req = request(
				{
					socketPath: deps.socketPath,
					path: urlPath,
					method: 'POST',
					agent,
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(body),
						accept: 'application/json',
					},
				},
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on('data', (chunk: Buffer) => {
						size += chunk.length;
						if (size > LOCAL_ENDPOINT_MAX_RESPONSE_BYTES) {
							res.destroy(new Error('oversized'));
							return;
						}
						chunks.push(chunk);
					});
					res.on('error', reject);
					res.on('end', () => {
						let parsed: unknown;
						try {
							parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
						} catch {
							reject(new Error('malformed'));
							return;
						}
						resolve({ statusCode: res.statusCode ?? 0, body: parsed });
					});
				}
			);
			req.on('socket', (s: Socket) => adopt(s));
			req.on('finish', () => {
				sent = true;
			});
			req.on('error', reject);
			req.setTimeout(timeoutMs, () => req.destroy(new RequestTimeout()));
			req.end(body);
		});
		return Object.assign(promise, { sent: () => sent });
	}

	function failure(
		error: unknown,
		effectful: boolean,
		sent: boolean
	): EndpointInvokeOutcome<never> {
		const message = error instanceof Error ? error.message : String(error);
		if (effectful && sent) return { status: 'unknown', message };
		if (error instanceof RequestTimeout) return unavailable('timeout', message);
		if (error instanceof PeerUnverified) return unavailable('peer-unverified', message);
		if (message === 'oversized') {
			return unavailable('oversized', 'The endpoint answered with more than the response bound.');
		}
		if (message === 'malformed')
			return unavailable('malformed', 'The endpoint answered with text that is not JSON.');
		return unavailable('transport', message);
	}

	/** A non-200 is the endpoint refusing the request itself (a denial body) or not serving at all. */
	function refused(statusCode: number, body: unknown): EndpointInvokeOutcome<never> {
		if (isEndpointDenied(body)) return { status: 'denied', reason: body.reason };
		return unavailable('http-status', `The endpoint answered HTTP ${statusCode}.`);
	}

	/**
	 * One envelope on `/v2/invoke`, the answer read against it. The correlation
	 * id and operation are checked; a denial body passes through as `denied`.
	 * An effectful request whose answer is lost is `unknown`, never resent.
	 */
	async function invokeEnvelope(
		operation: LocalEndpointOperation,
		payload: unknown
	): Promise<EndpointInvokeOutcome<unknown>> {
		if (closed) return unavailable('closed', 'The endpoint client is closed.');
		const correlationId = newCorrelationId();
		let body: string;
		try {
			body = JSON.stringify(frameLocalEndpointRequest(operation, payload, correlationId));
		} catch (error) {
			return unavailable(
				'malformed',
				`The ${operation} request was not sent: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (Buffer.byteLength(body) > LOCAL_ENDPOINT_MAX_REQUEST_BYTES) {
			return unavailable(
				'oversized',
				`The ${operation} request is larger than the request bound; it was not sent.`
			);
		}
		const pending = exchange(LOCAL_ENDPOINT_INVOKE_PATH, body);
		let answer: Exchange;
		try {
			answer = await pending;
		} catch (error) {
			return failure(
				error,
				LOCAL_ENDPOINT_EFFECTFUL_OPERATIONS.includes(operation),
				pending.sent()
			);
		}
		if (answer.statusCode !== 200) return refused(answer.statusCode, answer.body);
		const parsed = parseLocalEndpointResponse(answer.body, { correlationId, operation });
		if (!parsed.ok) return unavailable('malformed', parsed.problem);
		if (isEndpointDenied(parsed.payload))
			return { status: 'denied', reason: parsed.payload.reason };
		return { status: 'ok', payload: parsed.payload };
	}

	const port: EndpointPort = {
		socketPath: deps.socketPath,
		state: (): EndpointConnectionState => ({
			connection,
			attached,
			status,
			registration,
			closed,
			...(native ? { server: server ? { ...server } : null } : {}),
			...(negotiated
				? { negotiated: { ...negotiated, capabilities: [...negotiated.capabilities] } }
				: {}),
		}),

		compatibility: (req: EndpointCompatibilityRequest) =>
			serialized(async (): Promise<EndpointInvokeOutcome<EndpointCompatibilityResult>> => {
				const problems = compatibilityRequestProblems(req);
				if (problems.length > 0) {
					return unavailable(
						'malformed',
						`The compatibility request was not sent: ${problems.join('; ')}`
					);
				}
				const outcome = await invokeEnvelope('compatibility', {
					supportedProtocols: [LOCAL_ENDPOINT_PROTOCOL],
					supportedCapabilities: [...req.supportedCapabilities],
					requiredCapabilities: [...req.requiredCapabilities],
				});
				if (outcome.status !== 'ok') return outcome;
				const problemsAnswered = endpointCompatibilityResultProblems(outcome.payload);
				if (problemsAnswered.length > 0)
					return unavailable('malformed', problemsAnswered.join('; '));
				return { status: 'ok', payload: outcome.payload as EndpointCompatibilityResult };
			}),

		attach: (req: EndpointAttachmentRequest) =>
			serialized(async (): Promise<EndpointInvokeOutcome<EndpointStatus>> => {
				const problems = endpointAttachmentRequestProblems(req);
				if (problems.length > 0) {
					return unavailable(
						'malformed',
						`The attachment request was not sent: ${problems.join('; ')}`
					);
				}
				// The endpoint drops the socket's session before it answers any attachment.
				attached = false;
				status = null;
				negotiated = null;
				const outcome = await invokeEnvelope('attachment', req);
				if (outcome.status !== 'ok') return outcome;
				const bad = endpointStatusProblems(outcome.payload);
				if (bad.length > 0) return unavailable('malformed', bad.join('; '));
				const answer = outcome.payload as EndpointStatus;
				negotiated = {
					protocol: LOCAL_ENDPOINT_PROTOCOL,
					capabilities: [...answer.capabilities],
					status: answer,
				};
				// The connection is attached: operations the attachment negotiated may be sent.
				status = { ...answer, capabilities: [...answer.capabilities] };
				attached = true;
				return { status: 'ok', payload: answer };
			}),

		invoke: (operation, payload) =>
			serialized(async (): Promise<EndpointInvokeOutcome<unknown>> => {
				if (operation === 'attachment' || operation === 'compatibility') {
					return unavailable('malformed', `Use attach() or compatibility() for ${operation}.`);
				}
				if (!attached && !PRE_ATTACHMENT_OPERATIONS.includes(operation)) {
					return unavailable(
						'not-attached',
						`This connection is not attached; ${operation} was not sent. attach() first.`
					);
				}
				return invokeEnvelope(operation, payload);
			}),

		negotiated: (operation) => negotiated?.capabilities.includes(operation) ?? false,

		registration: {
			challenge: (input) =>
				serialized(async (): Promise<EndpointInvokeOutcome<EndpointRegistrationApproval>> => {
					if (!isEndpointIdentifier(input.runtimeId) || !isEndpointIdentifier(input.processEpoch)) {
						return unavailable(
							'malformed',
							'runtimeId and processEpoch must be endpoint identifiers.'
						);
					}
					// `registrationChallengeRequest`: exactly these four fields, purpose runtime_use.
					const outcome = await invokeEnvelope(LOCAL_ENDPOINT_REGISTRATION_CHALLENGE_OPERATION, {
						version: LOCAL_ENDPOINT_REGISTRATION_VERSION,
						purpose: LOCAL_ENDPOINT_REGISTRATION_PURPOSE,
						runtimeId: input.runtimeId,
						processEpoch: input.processEpoch,
					});
					if (outcome.status !== 'ok') {
						// The daemon drops any handshake on this socket when a challenge fails.
						registration = registration === 'challenged' ? 'none' : registration;
						return outcome;
					}
					const problems = endpointRegistrationApprovalProblems(outcome.payload);
					const approval = outcome.payload as { version?: unknown; purpose?: unknown };
					if (approval?.version !== LOCAL_ENDPOINT_REGISTRATION_VERSION)
						problems.push('version is not 2');
					if (approval?.purpose !== LOCAL_ENDPOINT_REGISTRATION_PURPOSE)
						problems.push('purpose is not runtime_use');
					if (problems.length > 0) return unavailable('malformed', problems.join('; '));
					registration = 'challenged';
					return { status: 'ok', payload: outcome.payload as EndpointRegistrationApproval };
				}),
			redeem: () =>
				serialized(async (): Promise<EndpointInvokeOutcome<EndpointRegistrationReceipt>> => {
					if (registration !== 'challenged') {
						return unavailable('no-challenge', 'No challenge is open on this connection.');
					}
					const outcome = await invokeEnvelope(LOCAL_ENDPOINT_REGISTRATION_REDEEM_OPERATION, {});
					if (outcome.status !== 'ok') {
						// The endpoint forgets the handshake on any failure. A lost answer is
						// `unknown`: the redeem may have published the registration, so the
						// caller reattaches with the existing claim instead of registering again.
						registration = 'none';
						return outcome;
					}
					// `{ outcome: "registered" }` exactly: the envelope carries the protocol.
					const receipt = outcome.payload as Record<string, unknown> | null;
					if (
						receipt === null ||
						typeof receipt !== 'object' ||
						receipt.outcome !== 'registered' ||
						Object.keys(receipt).length !== 1
					) {
						registration = 'none';
						return unavailable('malformed', 'The redeem answer is not a registration receipt.');
					}
					registration = 'registered';
					return { status: 'ok', payload: { outcome: 'registered' } };
				}),
			use: () =>
				serialized(async (): Promise<EndpointInvokeOutcome<EndpointRegistrationUseReply>> => {
					if (!negotiated?.capabilities.includes(LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION)) {
						return unavailable(
							'not-negotiated',
							`The attachment on this connection did not negotiate ${LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION}; nothing was sent.`
						);
					}
					const outcome = await invokeEnvelope(LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION, {});
					if (outcome.status !== 'ok') return outcome;
					const problems = endpointRegistrationUseReplyProblems(outcome.payload);
					if (problems.length > 0) return unavailable('malformed', problems.join('; '));
					return { status: 'ok', payload: outcome.payload as EndpointRegistrationUseReply };
				}),
		},

		redial: () => {
			const current = socket;
			if (current) {
				connectionLost(current);
				current.destroy();
			}
		},

		close: () =>
			serialized(async () => {
				closed = true;
				agent.destroy();
				if (socket) connectionLost(socket);
			}),
	};
	return port;
}

/**
 * The client for this host's platform: the platform's address rule, and on
 * macOS and Windows the native port the host injected, or no client at all.
 * Throws `Endpoint socket refused: ...` like `createLocalEndpointClient`.
 */
export function createPlatformEndpointClient(
	deps: LocalEndpointClientDeps & { platform?: string }
): EndpointPort {
	return createLocalEndpointClient({ ...deps, platform: deps.platform ?? process.platform });
}
