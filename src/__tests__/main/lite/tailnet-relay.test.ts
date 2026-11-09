import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
const provider = vi.hoisted(() => ({ port: 0, peerId: 'host-node', reads: 0 }));
vi.mock('../../../main/lite/tailnet', () => ({
	tailnetDestination: async () => ({
		...(provider.reads++, {}),
		hostname: '127.0.0.1',
		port: provider.port,
		localAddress: '127.0.0.1',
		device: 'client-node',
		tailnet: 'synthetic.ts.net',
		peerId: provider.peerId,
	}),
}));
vi.mock('../../../main/lite/lan', async (original) => ({
	...(await original<typeof import('../../../main/lite/lan')>()),
	lanDestination: async () => ({
		...(provider.reads++, {}),
		hostname: '127.0.0.1',
		port: provider.port,
		localAddress: '127.0.0.1',
	}),
}));
import { openTailnetRelay, openLanRelay } from '../../../main/lite/tailnet-relay';
import { ADMISSION_HEADER, CONNECT_PATH } from '../../../main/lite/pairing/protocol';
import {
	heldListeners,
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	listenerVerdict,
	type ListenerCeilingEntry,
	type ListenerRequest,
} from '../../../main/enterprise/listener-policy';
const credential = 'A'.repeat(43) + '.' + 'B'.repeat(43);
let endpoint: URL;
let server: Server,
	ws: WebSocketServer,
	relay: Awaited<ReturnType<typeof openTailnetRelay>>,
	abort: AbortController;
let requests = 0,
	commands = 0;
beforeEach(async () => {
	requests = 0;
	commands = 0;
	provider.peerId = 'host-node';
	provider.reads = 0;
	abort = new AbortController();
	server = createServer((req, res) => {
		requests++;
		if (req.url?.endsWith('/redirect')) {
			res.writeHead(302, { location: 'http://192.0.2.1/private' }).end();
			return;
		}
		res
			.writeHead(200, { 'content-type': 'application/json' })
			.end(JSON.stringify({ authenticated: req.headers[ADMISSION_HEADER] === credential }));
	});
	ws = new WebSocketServer({ noServer: true });
	server.on('upgrade', (req, socket, head) => {
		assertHost(req.headers.host);
		ws.handleUpgrade(req, socket, head, (client) => {
			client.on('message', () => {
				commands++;
				client.send('accepted');
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	provider.port = (server.address() as { port: number }).port;
});
/** Reject WebSocket upgrades if the relay rewrites the selected upstream host authority incorrectly. */
function assertHost(host: string | undefined) {
	if (host !== endpoint.host) throw new Error('Wrong selected host authority');
}
afterEach(async () => {
	vi.restoreAllMocks();
	setListenerAuthority(null);
	await relay?.tunnel.stop();
	for (const socket of ws.clients) socket.terminate();
	ws.close();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe.each(['tailscale', 'lan'] as const)(
	'private paired browser relay over %s',
	(transport) => {
		beforeEach(async () => {
			endpoint = new URL(
				(transport === 'lan' ? 'http://192.168.1.10:56036' : 'http://100.64.0.10:56036') +
					CONNECT_PATH
			);
			relay =
				transport === 'lan'
					? await openLanRelay(endpoint, credential, abort.signal)
					: await openTailnetRelay(endpoint, credential, abort.signal, 'host-node');
		});
		it('rejects non-ASCII credentials without throwing or contacting the host', async () => {
			const response = await fetch(relay.url + '/api/sessions', {
				headers: { [ADMISSION_HEADER]: '\u00e9'.repeat(credential.length) },
				signal: AbortSignal.timeout(1000),
			});
			expect(response.status).toBe(403);
			expect(requests).toBe(0);
		});
		it('rejects missing credentials, cross-origin requests and sibling paths before contacting the host', async () => {
			expect((await fetch(relay.url + '/api/sessions')).status).toBe(403);
			expect(
				(
					await fetch(relay.url + '/api/sessions', {
						headers: { [ADMISSION_HEADER]: credential, origin: 'http://evil.test' },
					})
				).status
			).toBe(403);
			expect(
				(
					await fetch(new URL('/health', relay.url), {
						headers: { [ADMISSION_HEADER]: credential },
					})
				).status
			).toBe(403);
			expect(requests).toBe(0);
			expect(
				(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
					.status
			).toBe(200);
		});
		it('does not follow redirects or send a credential after the network binding changes', async () => {
			expect(
				(await fetch(relay.url + '/redirect', { headers: { [ADMISSION_HEADER]: credential } }))
					.status
			).toBe(502);
			expect(requests).toBe(1);
			provider.peerId = 'replacement-node';
			if (transport === 'lan') provider.port++;
			const now = Date.now();
			vi.spyOn(Date, 'now').mockReturnValue(now + 3000);
			expect(
				(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
					.status
			).toBe(502);
			expect(requests).toBe(1);
		});
		it('uses real WebSocket upgrade, sends a command only once and closes its sockets on cancellation', async () => {
			const url = new URL(relay.url);
			url.protocol = 'ws:';
			url.pathname = CONNECT_PATH + '/ws';
			const socket = new WebSocket(url, {
				origin: relay.url.origin,
				headers: { [ADMISSION_HEADER]: credential },
			});
			await once(socket, 'open');
			const reply = once(socket, 'message');
			socket.send('one command');
			await reply;
			expect(commands).toBe(1);
			const closed = once(socket, 'close');
			abort.abort();
			await closed;
			expect(socket.readyState).toBe(WebSocket.CLOSED);
			expect(commands).toBe(1);
		});
	}
);

/** Install a managed ceiling listing `listeners` over the real verdict; returns every request it was asked. */
function installCeiling(listeners: ListenerCeilingEntry[]): ListenerRequest[] {
	const asked: ListenerRequest[] = [];
	setListenerAuthority({
		evaluateListener(request) {
			asked.push(request);
			return listenerVerdict(
				{ standing: 'managed', ceiling: { policyRevision: 3, listeners }, policyRevision: 3 },
				request
			);
		},
	});
	return asked;
}
describe.each(['tailscale', 'lan'] as const)(
	'private paired browser relay listener hold over %s',
	(transport) => {
		const open = () =>
			transport === 'lan'
				? openLanRelay(endpoint, credential, abort.signal)
				: openTailnetRelay(endpoint, credential, abort.signal, 'host-node');
		beforeEach(() => {
			endpoint = new URL(
				(transport === 'lan' ? 'http://192.168.1.10:56036' : 'http://100.64.0.10:56036') +
					CONNECT_PATH
			);
		});
		it('refused: throws the managed hold before the destination read and binds nothing', async () => {
			const asked = installCeiling([{ kind: 'web', reach: 'loopback' }]);
			const error = await open().catch((e: unknown) => e);
			expect(isListenerDeniedError(error)).toBe(true);
			expect((error as Error).message).toMatch(/^\[managed-kind-denied\] /);
			expect(asked).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 0 }]);
			expect(provider.reads).toBe(0);
			expect(requests).toBe(0);
			expect(heldListeners()).toMatchObject([
				{ kind: 'ssh-tunnel', reach: 'loopback', code: 'kind-denied', port: 0 },
			]);
		});
		it('refused: an invalid connection is still reported as invalid, before the ceiling is asked', async () => {
			const asked = installCeiling([]);
			const error = await openLanRelay(
				new URL('http://192.168.1.10:56036/elsewhere'),
				credential,
				abort.signal
			).catch((e: unknown) => e);
			expect(isListenerDeniedError(error)).toBe(false);
			expect((error as Error).message).toBe('Invalid paired private connection.');
			expect(asked).toHaveLength(0);
		});
		it('admitted: asks once with the exact request, then relays as before', async () => {
			const asked = installCeiling([{ kind: 'ssh-tunnel', reach: 'loopback' }]);
			relay = await open();
			expect(asked).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 0 }]);
			expect(provider.reads).toBe(1);
			expect(
				(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
					.status
			).toBe(200);
			expect(heldListeners()).toEqual([]);
		});
		it('standalone: with no authority nothing is asked and the relay listens', async () => {
			relay = await open();
			expect(
				(await fetch(relay.url + '/api/sessions', { headers: { [ADMISSION_HEADER]: credential } }))
					.status
			).toBe(200);
			expect(heldListeners()).toEqual([]);
		});
	}
);
