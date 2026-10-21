/**
 * A fake Mega-Maestro endpoint daemon for the client tests: the runtime
 * socket's protocol (`POST /v1/invoke` envelopes, per-socket attachment
 * sessions, per-socket correlation replay, the size and version refusals) and
 * the registration handshake (`/v1/registration/challenge` then `redeem` on
 * the same connection), transcribed from `apps/endpoint/src/ipc/server.ts`
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
}

export interface FakeEndpoint {
	socketPath: string;
	calls: FakeEndpointCall[];
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

	const capabilities = () => [
		'attachment',
		'compatibility',
		...(live.capabilities ?? ['telemetry', 'execution', 'inbox', 'noticeList']),
	];
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
		const maxBytes = isRegistration ? 4096 : 1024 * 1024;
		if (
			req.method !== 'POST' ||
			(req.url !== '/v1/invoke' && !isRegistration) ||
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
					schemaVersion: 1,
					correlationId: env.correlationId,
					operation: env.operation,
					payload: deny('unauthenticated'),
				});
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
			if ('schemaVersion' in env && env.schemaVersion !== 1) {
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
				sessions.set(socket, { capabilities: negotiated });
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
		});
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
