import { createServer, createConnection } from 'net';
import type { Socket } from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
	LITE_CONTROL_DISABLED_BY_POLICY,
	LITE_CONTROL_DISCOVERY_FILE,
	LITE_CONTROL_PROTOCOL_VERSION,
	LITE_CONTROL_MAX_BYTES,
	isLiteControlEndpoint,
	isLiteControlHeld,
} from '../../shared/lite-control';
import type {
	LiteControlDiscovery,
	LiteControlHeldDiscovery,
	LiteControlOptions,
	LiteControlReply,
	LiteControlRequest,
} from '../../shared/lite-control';
import { listenerHoldFor, type ListenerHold } from '../enterprise/listener-gate';

export interface LiteControlServer {
	close(): Promise<void>;
	/** The managed hold the endpoint met, when nothing listens and the discovery file names the refusal. */
	held: ListenerHold | null;
}

async function writeDiscovery(file: string, record: unknown): Promise<void> {
	await writeFile(file + '.tmp', JSON.stringify(record, null, 2), { mode: 0o600 });
	await rename(file + '.tmp', file);
}

/** Refuse to replace the discovery of a Lite that still answers on its OS-local endpoint. */
async function refuseLiveOwner(file: string): Promise<void> {
	try {
		const existing = JSON.parse(await readFile(file, 'utf8')) as Partial<LiteControlDiscovery>;
		if (isLiteControlEndpoint(existing?.endpoint)) {
			// PID reuse is not ownership: only the discovered OS-local endpoint is authoritative.
			const ownership = Promise.withResolvers<boolean>();
			const probe = createConnection(existing.endpoint);
			probe.once('connect', () => {
				probe.destroy();
				ownership.resolve(true);
			});
			probe.once('error', (error: NodeJS.ErrnoException) => {
				probe.destroy();
				if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') ownership.resolve(false);
				else ownership.reject(error);
			});
			probe.setTimeout(2000, () => {
				probe.destroy();
				ownership.reject(
					new Error('Cannot determine Lite control endpoint ownership: local probe timed out.')
				);
			});
			if (await ownership.promise)
				throw new Error('A Lite control endpoint already owns this user-data directory.');
		}
	} catch (error) {
		if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
			// Missing or interrupted discovery is replaced after listening succeeds.
		} else throw error;
	}
}

/**
 * The managed listener ceiling refused the endpoint (MRC2-05-06A): nothing
 * listens, and the discovery file names the hold so `maestro-cli lite`
 * reports `disabled-by-policy` instead of a Lite that is not running. The
 * handle removes the record on close only while it is still this process's.
 */
async function recordHeldControl(file: string, held: ListenerHold): Promise<LiteControlServer> {
	const record: LiteControlHeldDiscovery = {
		protocolVersion: LITE_CONTROL_PROTOCOL_VERSION,
		pid: process.pid,
		status: LITE_CONTROL_DISABLED_BY_POLICY,
		code: held.code,
		message: held.message,
	};
	await writeDiscovery(file, record);
	let closed: Promise<void> | undefined;
	const close = (): Promise<void> =>
		(closed ??= (async () => {
			try {
				const current = JSON.parse(await readFile(file, 'utf8')) as unknown;
				if (isLiteControlHeld(current) && current.pid === process.pid) await unlink(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		})());
	return { close, held };
}

/** OS-local IPC only: host web content cannot reach a named pipe or Unix socket. */
export async function startLiteControlServer(
	directory: string,
	control: (name: string, payload?: unknown, options?: LiteControlOptions) => Promise<unknown>
): Promise<LiteControlServer> {
	const file = path.join(directory, LITE_CONTROL_DISCOVERY_FILE);
	const secret = randomBytes(32).toString('hex');
	const suffix = randomBytes(16).toString('hex');
	const endpoint =
		process.platform === 'win32'
			? `\\\\.\\pipe\\maestro-lite-${suffix}`
			: path.join(os.tmpdir(), `maestro-lite-${suffix}.sock`);
	// The listener ceiling answers before any side effect; a live owner is
	// still honored on a hold, so its discovery is never replaced by a record.
	const held = listenerHoldFor({ kind: 'lite-control', bind: endpoint, port: 0 });
	await mkdir(directory, { recursive: true });
	await refuseLiveOwner(file);
	if (held) return recordHeldControl(file, held);
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		socket.setTimeout(120_000, () => socket.destroy());
		let input = '';
		let bytes = 0;
		let handled = false;
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			if (handled) return;
			bytes += Buffer.byteLength(chunk);
			if (bytes > LITE_CONTROL_MAX_BYTES) {
				handled = true;
				socket.end(
					JSON.stringify({ success: false, error: 'Lite control request is too large.' }) + '\n'
				);
				return;
			}
			input += chunk;
			if (!input.includes('\n')) return;
			handled = true;
			void (async () => {
				let afterResponse: (() => void) | undefined;
				let reply: LiteControlReply;
				let authenticated = false;
				try {
					const request = JSON.parse(input) as LiteControlRequest;
					if (
						!request ||
						typeof request.secret !== 'string' ||
						request.secret.length !== secret.length ||
						!timingSafeEqual(Buffer.from(request.secret), Buffer.from(secret))
					) {
						throw new Error('Lite control authentication failed.');
					}
					authenticated = true;
					if (request.protocolVersion !== LITE_CONTROL_PROTOCOL_VERSION)
						throw new Error(
							'Unsupported Lite control protocol. Rebuild/restart Lite and maestro-cli together.'
						);
					if (typeof request.action !== 'string')
						throw new Error('Lite control action is required.');
					const result = await control(request.action, request.payload, {
						source: 'cli',
						confirmed: request.confirmed === true,
						afterResponse: (callback) => {
							afterResponse = callback;
						},
					});
					reply = { ...(result as Omit<LiteControlReply, 'success'>), success: true };
				} catch (error) {
					reply = { success: false, error: error instanceof Error ? error.message : String(error) };
					if (authenticated) {
						try {
							Object.assign(reply, await control('status'));
						} catch {
							/* The window may already be closing. */
						}
					}
				}
				socket.end(JSON.stringify(reply) + '\n', () => afterResponse?.());
			})();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once('error', listening.reject);
	server.listen(endpoint, () => {
		server.removeListener('error', listening.reject);
		listening.resolve();
	});
	await listening.promise;
	let closed: Promise<void> | undefined;
	const close = (): Promise<void> =>
		(closed ??= (async () => {
			for (const socket of sockets) socket.destroy();
			const stopped = Promise.withResolvers<void>();
			server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
			await stopped.promise;
			try {
				const current = JSON.parse(await readFile(file, 'utf8')) as Partial<LiteControlDiscovery>;
				if (current?.secret === secret) await unlink(file);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		})());
	try {
		if (process.platform !== 'win32') await chmod(endpoint, 0o600);
		const discovery: LiteControlDiscovery = {
			protocolVersion: LITE_CONTROL_PROTOCOL_VERSION,
			endpoint,
			secret,
			pid: process.pid,
		};
		await writeDiscovery(file, discovery);
	} catch (error) {
		await close();
		throw error;
	}
	return { close, held: null };
}
