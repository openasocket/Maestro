/**
 * A fake Mega-Maestro endpoint daemon for the client tests: the runtime
 * socket's protocol (`POST /v2/invoke` envelopes, per-socket attachment
 * sessions, per-socket correlation replay, the size and version refusals) and
 * the registration handshake (`registration_challenge` then `registration_redeem`
 * on the same connection), transcribed from `apps/endpoint/src/ipc/server.ts`
 * and `apps/endpoint/src/main.ts` in the sibling checkout.
 *
 * It is a test double and says so: there is no OS peer inspection, no device
 * key, no policy. `peerAuthenticated` and `registrationRequired` are knobs that
 * stand in for what the real daemon derives from the kernel and its
 * registration directory. Nothing proven here is paired enforcement.
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
	/** What the daemon offers beyond attachment and compatibility. Default: none (no live producer). */
	capabilities?: readonly string[];
	/** When true, every invoke on an unregistered process answers `unauthenticated`. */
	registrationRequired?: boolean;
	/**
	 * Mega's silent renewal (SIMPLE-04-03): an attachment from a process the daemon
	 * holds no live registration for is registered right there when this answers
	 * true (a live grant for the account), else refused `unauthenticated`. No
	 * challenge runs and the runtime never sees a grant id.
	 */
	renewal?: (attachment: Record<string, unknown>) => boolean;
	/** Stands in for the kernel's answer about the peer. */
	peerAuthenticated?: boolean;
	/** Milliseconds to hold every answer. */
	delayMs?: number;
	/** The answer to any operation other than attachment, compatibility and the handshake. */
	operations?: Partial<Record<string, (payload: unknown) => unknown>>;
	maxResponseBytes?: number;
	/** The daemon clock, for the approval expiry. Default: the real one. */
	now?: () => number;
	/** When false, `/v2/invoke` is not served (a daemon that predates protocol 2): every request answers 400. */
	v2?: boolean;
	/** The envelope schema version `/v2/invoke` accepts (default 2); another answers `unsupported_version`. */
	schemaVersion?: number;
	/**
	 * When false, the daemon's offer holds no protocol 2, so every negotiation
	 * answers `unsupported_version` (the daemon's `negotiation.protocol !== 2`
	 * branch). Default: offered.
	 */
	offered?: boolean;
	/** Rewrites every answer envelope before it is sent (a daemon that answers someone else's correlationId, say). */
	envelope?: (envelope: {
		schemaVersion: 2;
		correlationId: unknown;
		operation: unknown;
		payload: unknown;
	}) => unknown;
}

export interface FakeEndpoint {
	socketPath: string;
	calls: FakeEndpointCall[];
	/** The recorded calls that reached one path, e.g. `/v2/invoke`. */
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
/** Every operation the daemon knows by its wire name (contracts 0.4.0 `localEndpointContractsV2`). */
const OPERATIONS = [
	'attachment',
	'compatibility',
	'registration_challenge',
	'registration_redeem',
	'registration_use',
	'enrollment',
	'desktopPolicy',
	'noticeList',
	'inbox',
	'telemetry',
	'budget',
	'offline',
	'model',
	'localControl',
	'command',
	'execution',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
	'connect',
	'connection_status',
	'disconnect',
];

export async function startFakeEndpoint(options: FakeEndpointOptions = {}): Promise<FakeEndpoint> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-endpoint-'));
	const socketPath = path.join(dir, 'runtime.sock');
	const calls: FakeEndpointCall[] = [];
	const sockets = new Map<Socket, number>();
	const sessions = new WeakMap<Socket, { capabilities: string[] }>();
	const seen = new WeakMap<Socket, Set<string>>();
	const handshakes = new WeakMap<
		Socket,
		{ challengeId: string; runtimeId: string; processEpoch: string }
	>();
	let socketCount = 0;
	let registered: { runtimeId: string; processEpoch: string } | null = null;
	let revoked = false;
	const live = options;

	const offered = () => live.capabilities ?? [];
	const capabilities = () => ['attachment', 'compatibility', ...offered()];
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
		if (
			req.method !== 'POST' ||
			req.url !== '/v2/invoke' ||
			live.v2 === false ||
			live.v2 === false ||
			req.headers['content-type'] !== 'application/json' ||
			req.headers['transfer-encoding'] ||
			!/^[1-9][0-9]{0,6}$/.test(req.headers['content-length'] ?? '') ||
			Number(req.headers['content-length']) > 1024 * 1024
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
				// The daemon answers an envelope with the denial inside it.
				const env = raw as { correlationId?: string; operation?: string };
				reply(200, {
					schemaVersion: 2,
					correlationId: env.correlationId,
					operation: env.operation,
					payload: deny('unauthenticated'),
				});
				return;
			}
			invoke(raw);
		});

		// `dispatch` in the daemon: the path accepts only schemaVersion 2. Replay ids
		// are per socket, as in the daemon.
		function invoke(raw: unknown) {
			const env = raw as Record<string, unknown>;
			if (typeof env !== 'object' || env === null) {
				reply(400, deny('invalid_request'), true);
				return;
			}
			if ('schemaVersion' in env && env.schemaVersion !== (live.schemaVersion ?? 2)) {
				reply(400, deny('unsupported_version'), true);
				return;
			}
			if (
				env.schemaVersion !== 2 ||
				typeof env.correlationId !== 'string' ||
				!OPERATIONS.includes(env.operation as string) ||
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
				reply(200, live.envelope ? live.envelope(envelope) : envelope);
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
			const operation = env.operation as string;
			const payload = (env.payload ?? {}) as Record<string, unknown>;
			// The pre-registration handshake (contracts 0.4.0): challenge and redeem are
			// envelopes on one connection, reachable before any attachment.
			if (operation === 'registration_challenge') {
				const keys = Object.keys(payload).sort().join(',');
				if (
					handshakes.has(socket) ||
					keys !== 'processEpoch,purpose,runtimeId,version' ||
					payload.version !== 2 ||
					payload.purpose !== 'runtime_use' ||
					typeof payload.runtimeId !== 'string'
				) {
					answer(deny('unavailable'));
					return;
				}
				const handshake = {
					challengeId: randomUUID(),
					runtimeId: payload.runtimeId,
					processEpoch: String(payload.processEpoch),
				};
				handshakes.set(socket, handshake);
				answer({
					challengeId: handshake.challengeId,
					nonce: 'n'.repeat(43),
					challengeDigest: 'c'.repeat(64),
					version: 2,
					purpose: 'runtime_use',
					expiresAt: new Date((live.now?.() ?? Date.now()) + 120_000).toISOString(),
				});
				return;
			}
			if (operation === 'registration_redeem') {
				const handshake = handshakes.get(socket);
				handshakes.delete(socket);
				if (!handshake || JSON.stringify(payload) !== '{}') {
					answer(deny('unavailable'));
					return;
				}
				registered = { runtimeId: handshake.runtimeId, processEpoch: handshake.processEpoch };
				revoked = false;
				const handler = live.operations?.registration_redeem;
				answer(handler ? handler(payload) : { outcome: 'registered' });
				return;
			}
			// Relayed enrollment reaches an unenrolled installation before any attachment.
			if (operation === 'enrollment' && capabilities().includes('enrollment')) {
				const handler = live.operations?.enrollment;
				answer(handler ? handler(payload) : deny('unavailable'));
				return;
			}
			// Connect is routed before any session or registration state, as Mega's dispatchV2.
			if (['connect', 'connection_status', 'disconnect'].includes(operation)) {
				const handler = live.operations?.[operation];
				answer(
					capabilities().includes(operation) && handler ? handler(payload) : deny('unauthenticated')
				);
				return;
			}
			if (
				operation === 'attachment' &&
				live.renewal &&
				(!registered ||
					revoked ||
					payload.runtimeId !== registered.runtimeId ||
					payload.processEpoch !== registered.processEpoch)
			) {
				if (!live.renewal(payload)) {
					answer(deny('unauthenticated'));
					return;
				}
				registered = {
					runtimeId: String(payload.runtimeId),
					processEpoch: String(payload.processEpoch),
				};
				revoked = false;
			}
			// `compatibility` is pre-registration, as the daemon's preRegistrationOperations.
			if (live.registrationRequired && (!registered || revoked) && operation !== 'compatibility') {
				answer(deny('unauthenticated'));
				return;
			}
			const list = (value: unknown) =>
				Array.isArray(value) && value.every((item) => typeof item === 'string')
					? (value as string[])
					: null;
			// `negotiateLocalProtocol` against the one offer, protocol 2 only (contracts 0.4.0).
			const negotiate = () => {
				const protocols = payload.supportedProtocols;
				const supported = list(payload.supportedCapabilities);
				const required = list(payload.requiredCapabilities);
				// As the contract's `protocolOffer`: anything but exactly [2] is not an offer at all.
				if (
					!Array.isArray(protocols) ||
					protocols.length !== 1 ||
					protocols[0] !== 2 ||
					!supported ||
					!required
				)
					return deny('invalid_request');
				if (live.offered === false) return deny('unsupported_version');
				const selected = capabilities().filter((c) => supported.includes(c));
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
				sessions.set(socket, { capabilities: negotiation.capabilities! });
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
			if (!session) {
				answer(deny('unauthenticated'));
				return;
			}
			if (!session.capabilities.includes(operation)) {
				answer(deny('unsupported_capability'));
				return;
			}
			const handler = live.operations?.[operation];
			answer(handler ? handler(payload) : { outcome: 'echo', operation, payload });
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
