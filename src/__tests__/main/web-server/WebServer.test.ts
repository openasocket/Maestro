import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { WebServer } from '../../../main/web-server/WebServer';
import { MEDIA_PATH_PARAM_MAX_LENGTH } from '../../../main/web-server/routes/mediaRoutes';
import {
	WebUserStore,
	setWebUserStoreForTests,
} from '../../../main/web-server/auth/web-user-store';
import { WEB_LOGIN_COOKIE, WEB_LOGIN_WS_CLOSE_CODE } from '../../../shared/webLogin';
import { PairingHost } from '../../../main/lite/pairing/host';
import { PairedDevices } from '../../../main/lite/pairing/paired-devices';
import { HostPairingWindow } from '../../../main/lite/pairing/host-window';
import { ADMISSION_HEADER, CONNECT_PATH } from '../../../main/lite/pairing/protocol';

const isolated = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({
	app: { getPath: () => isolated.directory, getVersion: () => '0.0.0-test' },
}));
beforeEach(() => {
	isolated.directory = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-server-'));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(isolated.directory, { recursive: true, force: true });
});

// Keep Sentry inert; constructing a WebServer should never reach it.
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// The LAN address probe touches the real network; pin it. The address watcher
// still needs the module's other exports.
vi.mock('../../../main/utils/networkUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/networkUtils')>()),
	getLocalIpAddress: vi.fn().mockResolvedValue('192.168.1.50'),
}));

// start() installs the IPC-bridge fanout, which needs Electron.
vi.mock('../../../main/web-server/handlers/bridgeHandlers', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/web-server/handlers/bridgeHandlers')>()),
	installWebContentsBridgeHook: vi.fn(),
}));

describe('WebServer PWA asset resolution', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-assets-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it('resolves PWA assets from the built web-desktop bundle', () => {
		// The web-desktop vite publicDir copies src/web/public/* (manifest.json,
		// service worker, icons/) into dist/web-desktop, so that directory is the
		// PWA asset root. manifest.json is the marker file we probe for.
		const bundleDir = path.join(tempRoot, 'dist', 'web-desktop');
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(path.join(bundleDir, 'manifest.json'), '{"name":"Maestro"}');

		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBe(bundleDir);
	});

	it('returns null when no built bundle provides PWA assets', () => {
		// Empty cwd, and the source web-desktop dir ships no manifest.json, so no
		// candidate path resolves.
		const server = new WebServer(0);

		expect((server as any).webAssetsPath).toBeNull();
	});
});

describe('WebServer desktop asset caching', () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-cache-'));
		vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
		const assets = path.join(tempRoot, 'dist', 'web-desktop', 'assets');
		mkdirSync(path.join(assets, 'fonts'), { recursive: true });
		writeFileSync(path.join(tempRoot, 'dist', 'web-desktop', 'index.html'), '<html></html>');
		writeFileSync(path.join(assets, 'main-BOEbwE3b.js'), 'export {};');
		writeFileSync(path.join(assets, 'fonts', 'inter-latin-400_700-1.woff2'), 'font');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	// Revalidating every module on every load is what overflowed a Cloudflare
	// quick tunnel's in-flight request cap when several phone tabs reloaded at
	// once, so the header has to actually reach the wire, on 304s included.
	it('serves hashed bundle files as immutable and leaves the fonts folder revalidating', async () => {
		const server = new WebServer(0);
		await (server as any).setupMiddleware();
		const fastify = server.getServer();
		const token = server.getSecurityToken();

		const hashed = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/main-BOEbwE3b.js`,
		});
		expect(hashed.statusCode).toBe(200);
		expect(hashed.headers['cache-control']).toBe('public, max-age=31536000, immutable');

		const revalidated = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/main-BOEbwE3b.js`,
			headers: { 'if-none-match': String(hashed.headers.etag) },
		});
		expect(revalidated.statusCode).toBe(304);
		expect(revalidated.headers['cache-control']).toBe('public, max-age=31536000, immutable');

		const font = await fastify.inject({
			method: 'GET',
			url: `/${token}/desktop/assets/fonts/inter-latin-400_700-1.woff2`,
		});
		expect(font.statusCode).toBe(200);
		expect(font.headers['cache-control']).not.toContain('immutable');

		await fastify.close();
	});
});

describe('WebServer Fastify configuration', () => {
	it('raises maxParamLength so the media route can match a hex-encoded absolute path', () => {
		// mediaRoutes.test.ts proves the constant is large enough on a Fastify
		// instance of its own; this proves WebServer actually passes it. Without
		// it the router's default cap of 100 404s every real media file before
		// the handler ever runs, and no other test would notice.
		const server = new WebServer(0);

		expect(server.getServer().initialConfig.routerOptions.maxParamLength).toBe(
			MEDIA_PATH_PARAM_MAX_LENGTH
		);
		expect(MEDIA_PATH_PARAM_MAX_LENGTH).toBeGreaterThan(100);
	});
});
describe('independent browser-account and paired-device revocation', () => {
	it('proactively closes idle real sockets through the account watcher and remembered-device verifier', async () => {
		const users = new WebUserStore(path.join(isolated.directory, 'web-users.json'));
		const password = 'synthetic-revocation-test-password';
		await users.createUser({ username: 'operator', password });
		const login = await users.login('operator', password);
		if (!login.ok) throw new Error('Synthetic account did not authenticate');
		setWebUserStoreForTests(users);
		const credential = 'A'.repeat(43) + '.' + 'B'.repeat(43);
		const origin = 'https://host.example.test';
		const devices = new PairedDevices(isolated.directory);
		await devices.add(credential, 'Synthetic laptop', 'synthetic-host', origin);
		// Restore the remembered grant from disk, as a host restart would.
		const host = await PairingHost.create(
			'Synthetic host',
			'synthetic-host',
			[origin],
			Date.now,
			true,
			new PairedDevices(isolated.directory)
		);
		vi.spyOn(HostPairingWindow.prototype, 'host', 'get').mockReturnValue(host);
		const server = new WebServer(0);
		const sockets: WebSocket[] = [];
		try {
			const started = await server.start();
			const address = new URL(started.url).origin;
			const account = new WebSocket(`${address.replace('http:', 'ws:')}/${started.token}/ws`, {
				headers: { cookie: `${WEB_LOGIN_COOKIE}=${login.sessionId}`, origin: address },
			});
			sockets.push(account);
			expect(JSON.parse(String((await once(account, 'message'))[0])).type).toBe('connected');
			const paired = new WebSocket(`${address.replace('http:', 'ws:')}${CONNECT_PATH}/ws`, {
				headers: { host: new URL(origin).host, origin, [ADMISSION_HEADER]: credential },
			});
			sockets.push(paired);
			expect(JSON.parse(String((await once(paired, 'message'))[0])).type).toBe('connected');
			expect(server.getWebClientCount()).toBe(2);
			const accountSend = vi.spyOn(account, 'send');
			const pairedSend = vi.spyOn(paired, 'send');
			const accountClosed = once(account, 'close', { signal: AbortSignal.timeout(5000) });
			await users.logout(login.sessionId);
			expect((await accountClosed)[0]).toBe(WEB_LOGIN_WS_CLOSE_CODE);
			expect(paired.readyState).toBe(WebSocket.OPEN);
			await vi.waitFor(() => expect(server.getWebClientCount()).toBe(1));
			const pairedClosed = once(paired, 'close', { signal: AbortSignal.timeout(5000) });
			await host.devices.revoke(credential.split('.')[0]);
			expect((await pairedClosed)[0]).toBe(4403);
			await vi.waitFor(() => expect(server.getWebClientCount()).toBe(0));
			expect(accountSend).not.toHaveBeenCalled();
			expect(pairedSend).not.toHaveBeenCalled();
		} finally {
			for (const socket of sockets) socket.terminate();
			await server.stop();
			host.dispose();
			await users.flush();
			setWebUserStoreForTests(null);
		}
	});
	it('closes sockets whose session no longer resolves and leaves the rest alone', async () => {
		const listeners: Array<() => void> = [];
		const live = new Set(['sid-live']);
		const fakeStore = {
			onChange: (l: () => void) => {
				listeners.push(l);
				return () => {};
			},
			resolveSession: (sid?: string) =>
				sid && live.has(sid) ? { id: 'u1', username: 'ada', displayName: 'Ada' } : undefined,
		};
		// WebServer is already imported at the top of this file, so the mock has
		// to reach a FRESH module graph.
		vi.resetModules();
		vi.doMock('../../../main/web-server/auth/web-user-store', () => ({
			getWebUserStore: () => fakeStore,
		}));
		const { WebServer: IsolatedWebServer } = await import('../../../main/web-server/WebServer');
		const { WEB_LOGIN_WS_CLOSE_CODE } = await import('../../../shared/webLogin');
		const server = new IsolatedWebServer(0);

		const make = (id: string, sessionId?: string) => ({
			id,
			socket: { close: vi.fn(), readyState: 1, send: vi.fn() },
			connectedAt: Date.now(),
			...(sessionId ? { user: { id: 'u1', username: 'ada', displayName: 'Ada' }, sessionId } : {}),
		});
		const revoked = make('c-revoked', 'sid-reset');
		const kept = make('c-kept', 'sid-live');
		const cli = make('c-cli');
		const device = {
			...make('c-device'),
			user: { id: 'paired-device:abc', username: 'paired-device', displayName: 'Laptop' },
		};
		const clients = (server as any).webClients as Map<string, unknown>;
		clients.set(revoked.id, revoked);
		clients.set(kept.id, kept);
		clients.set(cli.id, cli);
		clients.set(device.id, device);

		(server as any).watchWebUserStore();
		expect(listeners).toHaveLength(1);
		listeners[0]();

		expect(revoked.socket.close).toHaveBeenCalledWith(WEB_LOGIN_WS_CLOSE_CODE, 'Login required');
		expect(kept.socket.close).not.toHaveBeenCalled();
		expect(cli.socket.close).not.toHaveBeenCalled();
		expect(device.socket.close).not.toHaveBeenCalled();

		vi.doUnmock('../../../main/web-server/auth/web-user-store');
		vi.resetModules();
	});
});

describe('WebServer network exposure', () => {
	// start() with the route and store wiring stubbed out, so only the bind
	// decision is under test.
	async function startStubbed(server: WebServer) {
		const internals = server as any;
		internals.setupMiddleware = vi.fn();
		internals.setupRoutes = vi.fn();
		internals.setupMessageHandlerCallbacks = vi.fn();
		internals.watchWebUserStore = vi.fn();
		internals.startAddressWatcher = vi.fn();
		const listen = vi.spyOn(server.getServer(), 'listen').mockResolvedValue('' as never);
		const result = await server.start();
		return { listen, result, internals };
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('listens on loopback only and advertises 127.0.0.1 by default', async () => {
		const server = new WebServer(0);
		const { listen, result, internals } = await startStubbed(server);

		expect(server.isLanAccessible()).toBe(false);
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '127.0.0.1' });
		expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(internals.startAddressWatcher).not.toHaveBeenCalled();
	});

	it('listens on every interface and advertises the LAN address when asked for LAN access', async () => {
		const server = new WebServer(0, undefined, { lanAccess: true });
		const { listen, result, internals } = await startStubbed(server);

		expect(server.isLanAccessible()).toBe(true);
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '0.0.0.0' });
		expect(result.url).toMatch(/^http:\/\/192\.168\.1\.50:/);
		expect(internals.startAddressWatcher).toHaveBeenCalled();
	});
	it('keeps the live core HTTP server available when optional pairing initialization fails', async () => {
		const server = new WebServer(0);
		server.setRemoteHostStatusProvider(async () => {
			throw new Error('Pairing status unavailable');
		});
		try {
			const started = await server.start();
			const health = await fetch(new URL('/health', started.url));
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: 'ok' });
			expect((await server.start()).port).toBe(started.port);
		} finally {
			await server.stop();
		}
	});
});

describe('WebServer origin policy', () => {
	let server: WebServer;

	beforeEach(async () => {
		server = new WebServer(0);
		await (server as any).setupMiddleware();
		server.getServer().get('/probe', async () => 'ok');
		server.getServer().post('/probe', async () => 'ok');
	});

	afterEach(async () => {
		await server.getServer().close();
	});

	function request(method: 'GET' | 'POST', headers: Record<string, string>) {
		return server.getServer().inject({
			method,
			url: '/probe',
			headers,
			...(method === 'POST' ? { payload: '{"command":"echo pwned"}' } : {}),
		});
	}

	it('serves requests with no Origin header (maestro-cli, same-origin GETs)', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('serves requests whose Origin is the host they were sent to', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' });
		expect(res.statusCode).toBe(200);
	});

	it('refuses a foreign Origin and sends no CORS grant', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'https://evil.example' });
		expect(res.statusCode).toBe(403);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('refuses the opaque "null" Origin a sandboxed iframe sends', async () => {
		const res = await request('GET', { host: '127.0.0.1:1234', origin: 'null' });
		expect(res.statusCode).toBe(403);
	});

	it('refuses a cross-origin POST outright instead of only hiding the response', async () => {
		const res = await request('POST', {
			host: '127.0.0.1:1234',
			origin: 'https://evil.example',
			'content-type': 'text/plain',
		});
		expect(res.statusCode).toBe(403);
	});

	it('serves the trusted tunnel origin even when the Host header differs', async () => {
		server.setTrustedOriginsProvider(() => ['https://abc-def.trycloudflare.com']);
		const res = await request('GET', {
			host: '127.0.0.1:1234',
			origin: 'https://abc-def.trycloudflare.com',
		});
		expect(res.statusCode).toBe(200);
	});
});

describe('caller credential resolver composition (MCOMP-17-03AQ)', () => {
	const LIVE = 'mcc_live-turn-credential';

	function compose(resolver?: (credential: string) => { agentId: string; tabId: string } | null) {
		const server = new WebServer(0);
		const consultAgent = vi.fn().mockResolvedValue({ success: true, response: 'answer' });
		server.setConsultAgentCallback(consultAgent);
		server.setGetSessionDetailCallback(vi.fn().mockReturnValue({ state: 'idle' }) as never);
		// Composed before start() wires the remaining callbacks, as the factory does.
		if (resolver) server.setCallerSourceResolver(resolver);
		(server as any).setupMessageHandlerCallbacks();
		const sent: Array<Record<string, unknown>> = [];
		const client = {
			id: 'cli-socket',
			connectedAt: Date.now(),
			cli: true,
			socket: {
				readyState: WebSocket.OPEN,
				send: vi.fn((frame: string) => sent.push(JSON.parse(frame))),
				once: vi.fn(),
				off: vi.fn(),
			},
		};
		const ask = (fields: Record<string, unknown>) =>
			(server as any).messageHandler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'target-agent',
				question: 'q',
				requestId: 'r-1',
				...fields,
			});
		const lastReply = () => sent[sent.length - 1];
		return { consultAgent, ask, lastReply };
	}

	it('authenticates a forwarded credential through the composed resolver', async () => {
		const resolver = vi.fn((credential: string) =>
			credential === LIVE ? { agentId: 'caller-1', tabId: 'caller-tab' } : null
		);
		const { consultAgent, ask, lastReply } = compose(resolver);
		ask({ fromSessionId: 'caller-1', fromTabId: 'caller-tab', callerCredential: LIVE });
		await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(1));
		expect(resolver).toHaveBeenCalledWith(LIVE);
		const params = consultAgent.mock.calls[0][0];
		expect(params).toMatchObject({
			targetSessionId: 'target-agent',
			fromSessionId: 'caller-1',
			fromTabId: 'caller-tab',
		});
		expect(JSON.stringify(params)).not.toContain(LIVE);
		await vi.waitFor(() => expect(lastReply()).toMatchObject({ success: true, requestId: 'r-1' }));
		expect(JSON.stringify(lastReply())).not.toContain(LIVE);
	});

	it('refuses a credential the composed resolver authenticates nobody with', () => {
		const { consultAgent, ask, lastReply } = compose(() => null);
		ask({ fromSessionId: 'caller-1', fromTabId: 'caller-tab', callerCredential: LIVE });
		expect(consultAgent).not.toHaveBeenCalled();
		expect(lastReply()).toMatchObject({ success: false, requestId: 'r-1' });
		expect(lastReply().error).toContain('authenticates no live chat turn');
	});

	it('refuses as unauthenticatable when no resolver was composed', () => {
		const { consultAgent, ask, lastReply } = compose();
		ask({ fromSessionId: 'caller-1', fromTabId: 'caller-tab', callerCredential: LIVE });
		expect(consultAgent).not.toHaveBeenCalled();
		expect(lastReply().error).toContain('cannot authenticate a caller credential');
	});

	it('keeps the uncredentialed consult path unchanged', async () => {
		const resolver = vi.fn(() => null);
		const { consultAgent, ask } = compose(resolver);
		ask({ fromSessionId: 'caller-1' });
		await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(1));
		expect(resolver).not.toHaveBeenCalled();
		expect(consultAgent.mock.calls[0][0]).toMatchObject({ fromSessionId: 'caller-1' });
	});
});

describe('caller consult withdrawer composition (MCOMP-17-03AV)', () => {
	const LIVE = 'mcc_live-turn-credential';
	const RECHECK_MS = 1_000;

	function compose(opts: { withdrawer?: (ticket: string) => void; resolverFirst?: boolean } = {}) {
		const server = new WebServer(0);
		let finish: (result: Record<string, unknown>) => void = () => {};
		const consultAgent = vi.fn(
			() =>
				new Promise((resolve) => {
					finish = resolve as typeof finish;
				})
		);
		server.setConsultAgentCallback(consultAgent as never);
		server.setGetSessionDetailCallback(vi.fn().mockReturnValue({ state: 'idle' }) as never);
		let live = true;
		const resolver = vi.fn((credential: string) =>
			live && credential === LIVE ? { agentId: 'caller-1', tabId: 'caller-tab' } : null
		);
		// Composed before start() wires the remaining callbacks, as the factory does, in
		// either order: neither setter may drop the other's hook.
		if (opts.resolverFirst !== false) server.setCallerSourceResolver(resolver);
		if (opts.withdrawer) server.setCallerConsultWithdrawer(opts.withdrawer);
		if (opts.resolverFirst === false) server.setCallerSourceResolver(resolver);
		(server as any).setupMessageHandlerCallbacks();
		const sent: Array<Record<string, unknown>> = [];
		const client = {
			id: 'cli-socket',
			connectedAt: Date.now(),
			cli: true,
			socket: {
				readyState: WebSocket.OPEN,
				send: vi.fn((frame: string) => sent.push(JSON.parse(frame))),
				once: vi.fn(),
				off: vi.fn(),
			},
		};
		const ask = (fields: Record<string, unknown>) =>
			(server as any).messageHandler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'target-agent',
				question: 'q',
				requestId: 'r-1',
				...fields,
			});
		const results = () => sent.filter((r) => r.type === 'cross_agent_ask_result');
		const ticket = () => (consultAgent.mock.calls[0] as unknown[])[0] as { dispatchTicket: string };
		const loseCustody = () => {
			live = false;
		};
		return {
			consultAgent,
			ask,
			results,
			ticket,
			loseCustody,
			finish: (r: Record<string, unknown>) => finish(r),
		};
	}

	const credentialed = {
		fromSessionId: 'caller-1',
		fromTabId: 'caller-tab',
		callerCredential: LIVE,
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('hands the composed withdrawer the ticket of an ask whose caller lost custody', () => {
		const withdrawer = vi.fn();
		const { consultAgent, ask, results, ticket, loseCustody } = compose({ withdrawer });
		ask(credentialed);
		expect(consultAgent).toHaveBeenCalledTimes(1);
		const issued = ticket().dispatchTicket;
		expect(typeof issued).toBe('string');
		expect(issued.length).toBeGreaterThan(0);
		vi.advanceTimersByTime(RECHECK_MS);
		expect(withdrawer).not.toHaveBeenCalled();
		loseCustody();
		vi.advanceTimersByTime(RECHECK_MS);
		expect(withdrawer).toHaveBeenCalledTimes(1);
		expect(withdrawer).toHaveBeenCalledWith(issued);
		expect(results()).toHaveLength(1);
		expect(results()[0]).toMatchObject({ success: false, requestId: 'r-1' });
		vi.advanceTimersByTime(RECHECK_MS * 3);
		expect(withdrawer).toHaveBeenCalledTimes(1);
	});

	it('keeps the resolver when the withdrawer is composed first', () => {
		const withdrawer = vi.fn();
		const { ask, results, loseCustody } = compose({ withdrawer, resolverFirst: false });
		ask(credentialed);
		// Authenticated through the resolver: no refusal yet.
		expect(results()).toHaveLength(0);
		loseCustody();
		vi.advanceTimersByTime(RECHECK_MS);
		expect(withdrawer).toHaveBeenCalledTimes(1);
	});

	it('never withdraws a consult whose caller kept custody', async () => {
		const withdrawer = vi.fn();
		const { ask, results, finish } = compose({ withdrawer });
		ask(credentialed);
		vi.advanceTimersByTime(RECHECK_MS * 2);
		finish({ success: true, response: 'answer' });
		await vi.waitFor(() => expect(results()).toHaveLength(1));
		expect(results()[0]).toMatchObject({ success: true, requestId: 'r-1' });
		expect(withdrawer).not.toHaveBeenCalled();
	});

	it('never withdraws an uncredentialed ask', async () => {
		const withdrawer = vi.fn();
		const { ask, results, finish } = compose({ withdrawer });
		ask({ fromSessionId: 'caller-1' });
		vi.advanceTimersByTime(RECHECK_MS * 3);
		finish({ success: true, response: 'answer' });
		await vi.waitFor(() => expect(results()).toHaveLength(1));
		expect(withdrawer).not.toHaveBeenCalled();
	});

	it('still refuses a withdrawn ask to its caller when no withdrawer was composed', () => {
		const { ask, results, loseCustody } = compose();
		ask(credentialed);
		loseCustody();
		vi.advanceTimersByTime(RECHECK_MS);
		expect(results()).toHaveLength(1);
		expect(results()[0]).toMatchObject({ success: false, requestId: 'r-1' });
		expect(String(results()[0].error)).toContain('no longer holds its admission');
	});
});

describe('Auto Run caller credential resolver composition (MCOMP-17-03BC)', () => {
	const ATTEMPT = 'mcc_auto-run-attempt-credential';
	const CHAT = 'mcc_live-turn-credential';
	const RECHECK_MS = 1_000;

	type ChatResolver = (credential: string) => { agentId: string; tabId: string } | null;
	type AutoRunResolver = (credential: string) => { agentId: string; processId: string } | null;

	function compose(
		opts: {
			chat?: ChatResolver;
			autoRun?: AutoRunResolver;
			withdrawer?: (ticket: string) => void;
			autoRunFirst?: boolean;
			pending?: boolean;
		} = {}
	) {
		const server = new WebServer(0);
		const consultAgent = opts.pending
			? vi.fn(() => new Promise(() => {}))
			: vi.fn().mockResolvedValue({ success: true, response: 'answer' });
		server.setConsultAgentCallback(consultAgent as never);
		server.setGetSessionDetailCallback(vi.fn().mockReturnValue({ state: 'idle' }) as never);
		// Composed before start() wires the remaining callbacks, as the factory does, in either
		// order: no setter may drop another's hook.
		if (opts.autoRunFirst && opts.autoRun) server.setAutoRunCallerSourceResolver(opts.autoRun);
		if (opts.chat) server.setCallerSourceResolver(opts.chat);
		if (opts.withdrawer) server.setCallerConsultWithdrawer(opts.withdrawer);
		if (!opts.autoRunFirst && opts.autoRun) server.setAutoRunCallerSourceResolver(opts.autoRun);
		(server as any).setupMessageHandlerCallbacks();
		const sent: Array<Record<string, unknown>> = [];
		const client = {
			id: 'cli-socket',
			connectedAt: Date.now(),
			cli: true,
			socket: {
				readyState: WebSocket.OPEN,
				send: vi.fn((frame: string) => sent.push(JSON.parse(frame))),
				once: vi.fn(),
				off: vi.fn(),
			},
		};
		const ask = (fields: Record<string, unknown>) =>
			(server as any).messageHandler.handleMessage(client, {
				type: 'cross_agent_ask',
				sessionId: 'target-agent',
				question: 'q',
				requestId: 'r-1',
				...fields,
			});
		const results = () => sent.filter((r) => r.type === 'cross_agent_ask_result');
		return { consultAgent, ask, results };
	}

	const attemptAsk = {
		fromSessionId: 'runner-agent',
		fromTabId: 'shown-tab',
		callerCredential: ATTEMPT,
	};

	it('authenticates an Auto Run attempt credential through the composed resolver', async () => {
		const autoRun = vi.fn((credential: string) =>
			credential === ATTEMPT ? { agentId: 'runner-agent', processId: 'runner-agent-batch-1' } : null
		);
		const chat = vi.fn(() => null);
		const { consultAgent, ask, results } = compose({ chat, autoRun });
		ask(attemptAsk);
		await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(1));
		expect(chat).toHaveBeenCalledWith(ATTEMPT);
		expect(autoRun).toHaveBeenCalledWith(ATTEMPT);
		const params = consultAgent.mock.calls[0][0];
		expect(params).toMatchObject({
			targetSessionId: 'target-agent',
			fromSessionId: 'runner-agent',
			fromTabId: 'shown-tab',
		});
		expect(JSON.stringify(params)).not.toContain(ATTEMPT);
		await vi.waitFor(() => expect(results()[0]).toMatchObject({ success: true }));
		expect(JSON.stringify(results())).not.toContain(ATTEMPT);
	});

	it('keeps both resolvers whichever is composed first', async () => {
		const chat = vi.fn((c: string) =>
			c === CHAT ? { agentId: 'caller-1', tabId: 'tab-1' } : null
		);
		const autoRun = vi.fn((c: string) =>
			c === ATTEMPT ? { agentId: 'runner-agent', processId: 'runner-agent-batch-1' } : null
		);
		const { consultAgent, ask } = compose({ chat, autoRun, autoRunFirst: true });
		ask(attemptAsk);
		ask({
			fromSessionId: 'caller-1',
			fromTabId: 'tab-1',
			callerCredential: CHAT,
			requestId: 'r-2',
		});
		await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(2));
		expect(consultAgent.mock.calls[0][0]).toMatchObject({ fromSessionId: 'runner-agent' });
		expect(consultAgent.mock.calls[1][0]).toMatchObject({ fromSessionId: 'caller-1' });
	});

	it('authenticates an attempt credential with no chat resolver composed', async () => {
		const { consultAgent, ask } = compose({
			autoRun: () => ({ agentId: 'runner-agent', processId: 'runner-agent-batch-1' }),
		});
		ask(attemptAsk);
		await vi.waitFor(() => expect(consultAgent).toHaveBeenCalledTimes(1));
	});

	it('refuses an attempt credential when only the chat resolver was composed', () => {
		const { consultAgent, ask, results } = compose({ chat: () => null });
		ask(attemptAsk);
		expect(consultAgent).not.toHaveBeenCalled();
		expect(results()[0]).toMatchObject({ success: false, requestId: 'r-1' });
		expect(String(results()[0].error)).toContain(
			'authenticates no live chat turn or Auto Run attempt'
		);
	});

	it('refuses an attempt credential stated for another agent', () => {
		const { consultAgent, ask, results } = compose({
			autoRun: () => ({ agentId: 'runner-agent', processId: 'runner-agent-batch-1' }),
		});
		ask({ ...attemptAsk, fromSessionId: 'someone-else' });
		expect(consultAgent).not.toHaveBeenCalled();
		expect(String(results()[0].error)).toContain('not the Auto Run attempt');
	});

	describe('custody', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		it('withdraws the ask through the composed withdrawer when the attempt moves process', () => {
			let processId = 'runner-agent-batch-1';
			const withdrawer = vi.fn();
			const { consultAgent, ask, results } = compose({
				autoRun: () => ({ agentId: 'runner-agent', processId }),
				withdrawer,
				pending: true,
			});
			ask(attemptAsk);
			expect(consultAgent).toHaveBeenCalledTimes(1);
			const { dispatchTicket } = (consultAgent.mock.calls[0] as unknown[])[0] as {
				dispatchTicket: string;
			};
			vi.advanceTimersByTime(RECHECK_MS);
			expect(withdrawer).not.toHaveBeenCalled();
			processId = 'runner-agent-batch-2';
			vi.advanceTimersByTime(RECHECK_MS);
			expect(withdrawer).toHaveBeenCalledWith(dispatchTicket);
			expect(results()).toHaveLength(1);
			expect(results()[0]).toMatchObject({ success: false, requestId: 'r-1' });
		});
	});
});
