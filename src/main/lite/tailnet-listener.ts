import { createServer, type IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Socket } from 'node:net';
import { TAILNET_PORT, tailnetIPv4 } from './tailnet-origin';
import { LAN_PORT, lanInterface } from './lan';
import { holdListener } from '../enterprise/listener-gate';
/**
 * Reuses production Fastify routes on a private interface when the normal server uses another port.
 * The managed listener ceiling (MRC2-05-06A) holds it as the `tailnet` kind at the reach of the
 * address BEFORE any socket exists; a refusal is a thrown `ListenerDeniedError` the direct host
 * shows as its state message, and the listener is not opened.
 */
export async function listenTailnet(
	server: FastifyInstance,
	address: string
): Promise<() => Promise<void>> {
	if (!tailnetIPv4(address)) throw new Error('A current Tailscale interface is required.');
	holdListener({ kind: 'tailnet', bind: address, port: TAILNET_PORT });
	return listenDirect(server, address);
}
/**
 * Reuse an existing LAN-port server without owning its shutdown, or open a listener on the selected interface.
 * Held as the `tailnet` kind at `lan` reach before the reuse decision: offering Lite direct access over an
 * already bound server is still opening the kind at that reach.
 */
export async function listenLan(
	server: FastifyInstance,
	address: string
): Promise<() => Promise<void>> {
	if (!lanInterface(address)) throw new Error('Choose an eligible private LAN interface.');
	holdListener({ kind: 'tailnet', bind: address, port: LAN_PORT });
	const bound = server.server.address();
	if (
		bound &&
		typeof bound === 'object' &&
		bound.port === LAN_PORT &&
		['0.0.0.0', '::', address].includes(bound.address)
	)
		return async () => {};
	return listenDirect(server, address);
}
/** Route only Maestro's well-known subtree; the returned idempotent stop closes this listener and its sockets. */
async function listenDirect(
	server: FastifyInstance,
	address: string
): Promise<() => Promise<void>> {
	const scoped = (req: IncomingMessage) => !!req.url && req.url.startsWith('/.well-known/maestro/');
	const listener = createServer((req, res) => {
		if (!scoped(req)) {
			res.writeHead(404).end();
			return;
		}
		server.routing(req, res);
	});
	listener.on('upgrade', (req, socket, head) => {
		if (!scoped(req)) {
			socket.destroy();
			return;
		}
		server.server.emit('upgrade', req, socket, head);
	});
	const sockets = new Set<Socket>();
	listener.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve, reject) => {
		listener.once('error', reject);
		listener.listen(TAILNET_PORT, address, () => {
			listener.removeListener('error', reject);
			resolve();
		});
	});
	let stopped: Promise<void> | undefined;
	return () =>
		(stopped ??= new Promise((resolve) => {
			for (const socket of sockets) socket.destroy();
			listener.close(() => resolve());
		}));
}
