/**
 * A fake Mega-Maestro endpoint daemon for the client tests: the runtime
 * socket's protocol (`POST /v1/invoke` envelopes, per-socket attachment
 * sessions, per-socket correlation replay, the size and version refusals) and
 * the registration handshake (`/v1/registration/challenge` then `redeem` on
 * the same connection), and the protocol 2 path (`POST /v2/invoke` with
 * schemaVersion 2 envelopes, one negotiated protocol per socket session),
 * transcribed from `apps/endpoint/src/ipc/server.ts`
 * and `apps/endpoint/src/main.ts` in the sibling checkout.
 *
 * It is a test double and says so: there is no OS peer inspection, no
 * device key, no policy. `peerAuthenticated` and `registrationRequired` are
 * knobs that stand in for what the real daemon derives from the kernel and
 * its registration directory. Nothing proven here is paired enforcement.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EndpointStatus } from '../../../shared/maestro-lib/managed/endpoint-port';

export interface FakeEndpointCall {
	path: string;
	socket: number;
	body: unknown;
}

export interface FakeEndpointOptions {
	status?: Partial<EndpointStatus>;
	/** What the daemon can do; the negotiated set is the intersection with the peer's. */
	capabilities?: readonly string[];
	/** When true, every invoke on an unregistered process answers `unauthenticated`. */
	registrationRequired?: boolean;
	/** Stands in for the kernel's answer about the peer. */
	peerAuthenticated?: boolean;
	/** Milliseconds to hold every answer. */
	delayMs?: number;
	/** The answer to any operation other than attachment/compatibility. */
	operations?: Partial<Record<string, (payload: unknown) => unknown>>;
	maxResponseBytes?: number;
	/** The daemon clock, for the approval expiry. Default: the real one. */
	now?: () => number;
	/** A daemon that speaks only another schema version refuses every v1 envelope. */
	schemaVersion?: number;
	/** When false, `/v2/invoke` is an unknown path, as on a daemon that predates protocol 2. Default: served. */
	v2?: boolean;
	/** The v2 offer beyond attachment and compatibility. Default: none (no live v2 producer). */
	v2Capabilities?: readonly string[];
	/**
	 * When false, `/v2/invoke` is served but its offer holds no protocol 2, so
	 * every v2 negotiation answers `unsupported_version` (the daemon's
	 * `negotiation.protocol !== 2` branch). Default: offered.
	 */
	v2Offered?: boolean;
	/**
	 * Rewrites every v2 answer envelope before it is sent (a daemon that answers
	 * someone else's correlationId, say). Never applied on `/v1/invoke`.
	 */
	v2Envelope?: (envelope: {
		schemaVersion: 2;
		correlationId: unknown;
		operation: unknown;
		payload: unknown;
	}) => unknown;
}

export interface FakeEndpoint {
	socketPath: string;
	calls: FakeEndpointCall[];
	/** The recorded calls that reached one path, e.g. `/v1/invoke` or `/v2/invoke`. */
	callsTo(path: string): FakeEndpointCall[];
	options: FakeEndpointOptions;
	/** Pretend the daemon restarted: every connection and session is dropped. */
	dropConnections(): void;
	/** Whether the registration handshake reached redeem for this process. */
	registered(): boolean;
	revokeRegistration(): void;
	close(): Promise<void>;
}

const REASONS = [
	'unsupported_version',
	'unsupported_capability',
	'unauthenticated',
	'policy_denied',
	'expired',
	'replay',
	'unavailable',
	'invalid_request',
];
const deny = (reason: string) => ({ outcome: 'denied', reason });
const OPERATIONS = [
	'attachment',
	'enrollment',
	'execution',
	'offline',
	'telemetry',
	'command',
	'inbox',
	'noticeList',
	'workflow',
	'budget',
	'compatibility',
	'model',
];
/** The v2 operation names: the v1 set without `workflow`, plus desktopPolicy, the workflow custody verbs and registration_use. */
const OPERATIONS_V2 = [
	...OPERATIONS.filter((operation) => operation !== 'workflow'),
	'desktopPolicy',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
	'registration_use',
];

export async function startFakeEndpoint(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-endpoint-'));
	const socketPath = path.join(dir, 'runtime.sock');
	const calls: FakeEndpointCall[] = [];
	const sockets = new Map<Socket, number>();
	const sessions = new WeakMap<Socket, { protocol: 1 | 2; capabilities: string[] }>();
	const seen = new WeakMap<Socket, Set<string>>();
	const handshakes = new WeakMap<
		Socket,
		{ challengeId: string; runtimeId: string; processEpoch: string }
	>();
	let socketCount = 0;
	let registered: { runtimeId: string; processEpoch: string } | null = null;
	let revoked = false;
	const live = options;

	const capabilities = () => [
		'attachment',
		'compatibility',
		...(live.capabilities ?? ['telemetry', 'execution', 'inbox', 'noticeList']),
	];
	const capabilitiesV2 = () => ['attachment', 'compatibility', ...(live.v2Capabilities ?? [])];
	const maxResponse = () => live.maxResponseBytes ?? 64 * 1024;

	const server = http.createServer((req, res) => {
		const socket = req.socket;
		if (!sockets.has(socket)) {
			sockets.set(socket, ++socketCount);
			socket.once('close', () => sockets.delete(socket));
		}
		const socketId = sockets.get(socket)!;
		const reply = (code: number, body: unknown, close = false) => {
			const send = () => {
				if (res.destroyed || res.writableEnded) return;
				let bytes = JSON.stringify(body);
				if (Buffer.byteLength(bytes) > maxResponse()) {
					code = 503;
					bytes = JSON.stringify(deny('unavailable'));
					close = true;
				}
				res.setHeader('content-type', 'application/json');
				if (close) res.setHeader('connection', 'close');
				res.writeHead(code);
				res.end(bytes);
			};
			if (live.delayMs) setTimeout(send, live.delayMs);
			else send();
		};
		const isRegistration =
			req.url === '/v1/registration/challenge' || req.url === '/v1/registration/redeem';
		const isV2 = req.url === '/v2/invoke' && live.v2 !== false;
		const maxBytes = isRegistration ? 4096 : 1024 * 1024;
		if (
			req.method !== 'POST' ||
			(req.url !== '/v1/invoke' && !isRegistration && !isV2) ||
			req.headers['content-type'] !== 'application/json' ||
			req.headers['transfer-encoding'] ||
			!/^[1-9][0-9]{0,6}$/.test(req.headers['content-length'] ?? '') ||
			Number(req.headers['content-length']) > maxBytes
		) {
			reply(400, deny('invalid_request'), true);
			return;
		}
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			let raw: unknown;
			try {
				raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			} catch {
				reply(400, deny('invalid_request'), true);
				return;
			}
			calls.push({ path: req.url ?? '', socket: socketId, body: raw });
			if (live.peerAuthenticated === false) {
				if (isRegistration) {
					reply(503, deny('unavailable'), true);
					return;
				}
				// The daemon answers an envelope with the denial inside it.
				const env = raw as { correlationId?: string; operation?: string };
				reply(200, {
					schemaVersion: isV2 ? 2 : 1,
					correlationId: env.correlationId,
					operation: env.operation,
					payload: deny('unauthenticated'),
				});
				return;
			}
			if (isV2) {
				invokeV2(raw);
				return;
			}
			if (req.url === '/v1/registration/challenge') {
				const input = raw as { runtimeId?: unknown; processEpoch?: unknown };
				if (handshakes.has(socket) || typeof input.runtimeId !== 'string') {
					reply(503, deny('unavailable'), true);
					return;
				}
				const handshake = {
					challengeId: randomUUID(),
					runtimeId: input.runtimeId,
					processEpoch: String(input.processEpoch),
				};
				handshakes.set(socket, handshake);
				reply(200, {
					challengeId: handshake.challengeId,
					nonce: 'n'.repeat(43),
					challengeDigest: 'c'.repeat(64),
					expiresAt: new Date((live.now?.() ?? Date.now()) + 120_000).toISOString(),
				});
				return;
			}
			if (req.url === '/v1/registration/redeem') {
				const handshake = handshakes.get(socket);
				handshakes.delete(socket);
				if (!handshake || JSON.stringify(raw) !== '{}') {
					reply(503, deny('unavailable'), true);
					return;
				}
				registered = { runtimeId: handshake.runtimeId, processEpoch: handshake.processEpoch };
				revoked = false;
				reply(200, { protocol: 1, outcome: 'registered' });
				return;
			}
			const env = raw as Record<string, unknown>;
			if ('schemaVersion' in env && env.schemaVersion !== (live.schemaVersion ?? 1)) {
				reply(400, deny('unsupported_version'), true);
				return;
			}
			if (
				env.schemaVersion !== 1 ||
				typeof env.correlationId !== 'string' ||
				!OPERATIONS.includes(env.operation as string) ||
				!('payload' in env)
			) {
				reply(400, deny('invalid_request'), true);
				return;
			}
			const answer = (payload: unknown) =>
				reply(200, {
					schemaVersion: 1,
					correlationId: env.correlationId,
					operation: env.operation,
					payload,
				});
			let ids = seen.get(socket);
			if (!ids) {
				ids = new Set();
				seen.set(socket, ids);
			}
			if (ids.has(env.correlationId as string)) {
				answer(deny('replay'));
				return;
			}
			ids.add(env.correlationId as string);
			if (live.registrationRequired && (!registered || revoked)) {
				answer(deny('unauthenticated'));
				return;
			}
			const operation = env.operation as string;
			const payload = env.payload as Record<string, unknown>;
			if (operation === 'attachment') {
				sessions.delete(socket);
				if (
					registered &&
					(payload.runtimeId !== registered.runtimeId ||
						payload.processEpoch !== registered.processEpoch)
				) {
					answer(deny('unauthenticated'));
					return;
				}
				const supported = payload.supportedCapabilities as string[];
				const negotiated = capabilities().filter((c) => supported.includes(c));
				const required = payload.requiredCapabilities as string[];
				if (required.some((c) => !negotiated.includes(c))) {
					answer(deny('unsupported_capability'));
					return;
				}
				sessions.set(socket, { protocol: 1, capabilities: negotiated });
				answer({
					outcome: 'attached',
					protocol: 1,
					capabilities: negotiated,
					management: 'managed',
					desiredPolicyRevision: 3,
					appliedPolicyRevision: 3,
					connectivity: 'online',
					collectionProfile: 'metadata',
					...live.status,
				});
				return;
			}
			if (operation === 'compatibility') {
				const required = payload.requiredCapabilities as string[];
				answer(
					required.some((c) => !capabilities().includes(c))
						? deny('unsupported_capability')
						: { outcome: 'compatible', protocol: 1, capabilities: capabilities() }
				);
				return;
			}
			const session = sessions.get(socket);
			if (!session || session.protocol !== 1) {
				answer(deny('unauthenticated'));
				return;
			}
			if (!session.capabilities.includes(operation)) {
				answer(deny('unsupported_capability'));
				return;
			}
			const handler = live.operations?.[operation];
			answer(handler ? handler(payload) : { outcome: 'echo', operation, payload });
		});

		// `dispatchV2` in the daemon: the path accepts only schemaVersion 2 and a
		// rejected v2 payload is never retried as v1. Replay ids are per socket
		// across both paths, as in the daemon.
		function invokeV2(raw: unknown) {
			const env = raw as Record<string, unknown>;
			if (typeof env !== 'object' || env === null) {
				reply(400, deny('invalid_request'), true);
				return;
			}
			if ('schemaVersion' in env && env.schemaVersion !== 2) {
				reply(400, deny('unsupported_version'), true);
				return;
			}
			if (
				env.schemaVersion !== 2 ||
				typeof env.correlationId !== 'string' ||
				!OPERATIONS_V2.includes(env.operation as string) ||
				!('payload' in env) ||
				Object.keys(env).length !== 4
			) {
				reply(400, deny('invalid_request'), true);
				return;
			}
			const answer = (payload: unknown) => {
				const envelope = {
					schemaVersion: 2 as const,
					correlationId: env.correlationId,
					operation: env.operation,
					payload,
				};
				reply(200, live.v2Envelope ? live.v2Envelope(envelope) : envelope);
			};
			let ids = seen.get(socket);
			if (!ids) {
				ids = new Set();
				seen.set(socket, ids);
			}
			if (ids.has(env.correlationId as string)) {
				answer(deny('replay'));
				return;
			}
			ids.add(env.correlationId as string);
			if (live.registrationRequired && (!registered || revoked)) {
				answer(deny('unauthenticated'));
				return;
			}
			const operation = env.operation as string;
			const payload = (env.payload ?? {}) as Record<string, unknown>;
			const list = (value: unknown) =>
				Array.isArray(value) && value.every((item) => typeof item === 'string')
					? (value as string[])
					: null;
			// `negotiateLocalProtocol` against the one v2 offer.
			const negotiate = () => {
				const protocols = payload.supportedProtocols;
				const supported = list(payload.supportedCapabilities);
				const required = list(payload.requiredCapabilities);
				if (!Array.isArray(protocols) || !supported || !required) return deny('invalid_request');
				if (!protocols.includes(2) || live.v2Offered === false) return deny('unsupported_version');
				const selected = capabilitiesV2().filter((c) => supported.includes(c));
				if (required.some((c) => !selected.includes(c))) return deny('unsupported_capability');
				return { outcome: 'negotiated', protocol: 2, capabilities: selected };
			};
			if (operation === 'attachment') {
				if (
					registered &&
					(payload.runtimeId !== registered.runtimeId ||
						payload.processEpoch !== registered.processEpoch)
				) {
					answer(deny('unauthenticated'));
					return;
				}
				sessions.delete(socket);
				const negotiation = negotiate() as { outcome: string; capabilities?: string[] };
				if (negotiation.outcome !== 'negotiated') {
					answer(negotiation);
					return;
				}
				sessions.set(socket, { protocol: 2, capabilities: negotiation.capabilities! });
				answer({
					outcome: 'attached',
					management: 'managed',
					desiredPolicyRevision: 3,
					appliedPolicyRevision: 3,
					connectivity: 'online',
					collectionProfile: 'metadata',
					...live.status,
					protocol: 2,
					capabilities: negotiation.capabilities,
				});
				return;
			}
			if (operation === 'compatibility') {
				answer(negotiate());
				return;
			}
			const session = sessions.get(socket);
			if (!session || session.protocol !== 2) {
				answer(deny('unauthenticated'));
				return;
			}
			if (!session.capabilities.includes(operation)) {
				answer(deny('unsupported_capability'));
				return;
			}
			const handler = live.operations?.[operation];
			answer(handler ? handler(payload) : deny('unsupported_capability'));
		}
	});
	server.keepAliveTimeout = 120_000;
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	fs.chmodSync(socketPath, 0o600);

	return {
		socketPath,
		calls,
		callsTo: (target) => calls.filter((call) => call.path === target),
		options: live,
		dropConnections: () => {
			for (const socket of [...sockets.keys()]) socket.destroy();
		},
		registered: () => registered !== null && !revoked,
		revokeRegistration: () => {
			revoked = true;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** `REASONS` is exported so a test can assert a reason is one the contract names. */
export const FAKE_ENDPOINT_REASONS = REASONS;
