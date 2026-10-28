/**
 * The web server under the listener ceiling (MRC2-05-06): the ceiling answers
 * before any route, hook or socket exists, a refusal is the named
 * `ListenerDeniedError` with nothing bound and the server not running, a
 * ceiling that lists `web` at loopback keeps the CLI server and refuses Live
 * Mode's every-interface bind, and standalone (no authority) both bind as
 * before. Its own file so the suite loads without the Lite pairing host's
 * native package: `@serenity-kit/opaque` is stubbed here and never reached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { WebServer } from '../../../main/web-server/WebServer';
import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

const isolated = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({
	app: { getPath: () => isolated.directory, getVersion: () => '0.0.0-test' },
}));
// The pairing host's OPAQUE library is native and only touched when a host is
// constructed; nothing here pairs, so a stub keeps the import graph loadable.
vi.mock('@serenity-kit/opaque', () => ({ ready: Promise.resolve(), server: {}, client: {} }));
// The mDNS advertiser's packet codec, reached through the pairing window's
// direct-LAN path; nothing here advertises.
vi.mock('dns-packet', () => ({ encode: vi.fn(), decode: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/networkUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/networkUtils')>()),
	getLocalIpAddress: vi.fn().mockResolvedValue('192.168.1.50'),
}));
vi.mock('../../../main/web-server/handlers/bridgeHandlers', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/web-server/handlers/bridgeHandlers')>()),
	installWebContentsBridgeHook: vi.fn(),
}));

beforeEach(() => {
	isolated.directory = mkdtempSync(path.join(os.tmpdir(), 'maestro-web-listener-'));
});
afterEach(() => {
	setListenerAuthority(null);
	vi.restoreAllMocks();
	rmSync(isolated.directory, { recursive: true, force: true });
});

/** The route, store and watcher wiring stubbed out, so only the bind decision is under test. */
function stubbed(server: WebServer, { spyListen = true } = {}) {
	const internals = server as any;
	internals.setupMiddleware = vi.fn();
	internals.setupRoutes = vi.fn();
	internals.setupMessageHandlerCallbacks = vi.fn();
	internals.watchWebUserStore = vi.fn();
	internals.startAddressWatcher = vi.fn();
	// With spyListen off the real fastify listen stays in place, so a test can
	// prove at the OS that a refused start bound nothing.
	const listen = spyListen
		? vi.spyOn(server.getServer(), 'listen').mockResolvedValue('' as never)
		: null;
	return { internals, listen };
}

describe('WebServer under the listener ceiling', () => {
	it('never binds when the ceiling refuses the web kind, and names the refusal', async () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		const server = new WebServer(0, undefined, { lanAccess: true });
		const { internals, listen } = stubbed(server);
		await expect(server.start()).rejects.toMatchObject({
			name: 'ListenerDeniedError',
			code: 'kind-denied',
			message: '[managed-kind-denied] the listener ceiling admits no web listener',
		});
		expect(listen).not.toHaveBeenCalled();
		expect(internals.setupMiddleware).not.toHaveBeenCalled();
		expect(internals.setupRoutes).not.toHaveBeenCalled();
		expect(internals.watchWebUserStore).not.toHaveBeenCalled();
		expect(server.isActive()).toBe(false);
		expect(denied.requests).toEqual([{ kind: 'web', bind: '0.0.0.0', port: 0 }]);
		expect(heldListeners()).toMatchObject([
			{ kind: 'web', bind: '0.0.0.0', port: 0, code: 'kind-denied', count: 1 },
		]);
		// A stop on a server that never bound is a no-op, as the CLI server's retry path relies on.
		await server.stop();
		expect(server.isActive()).toBe(false);
	});

	it('refuses unavailable, by name, on an enrolled host with no ceiling for its revision', async () => {
		setListenerAuthority(denyingListenerAuthority('unavailable').authority);
		const server = new WebServer(0);
		const { listen } = stubbed(server);
		await expect(server.start()).rejects.toMatchObject({ code: 'unavailable' });
		expect(listen).not.toHaveBeenCalled();
	});

	it('binds loopback and refuses every interface under a ceiling that lists web at loopback', async () => {
		const real = managedListenerAuthority([{ kind: 'web', reach: 'loopback' }]);
		setListenerAuthority(real.authority);
		const loopback = new WebServer(0);
		const { listen } = stubbed(loopback);
		const started = await loopback.start();
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '127.0.0.1' });
		expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
		const lan = new WebServer(0, undefined, { lanAccess: true });
		const lanBind = stubbed(lan);
		await expect(lan.start()).rejects.toMatchObject({ code: 'reach-denied' });
		expect(lanBind.listen).not.toHaveBeenCalled();
		expect(lan.isActive()).toBe(false);
		expect(real.requests).toEqual([
			{ kind: 'web', bind: '127.0.0.1', port: 0 },
			{ kind: 'web', bind: '0.0.0.0', port: 0 },
		]);
		expect(heldListeners()).toMatchObject([{ kind: 'web', bind: '0.0.0.0', code: 'reach-denied' }]);
	});

	it('a ceiling that admits web as far as lan still refuses the every-interface bind; one at any admits it', async () => {
		// Live Mode binds 0.0.0.0, which reaches `any`, not the one LAN
		// interface a `lan` entry admits: the entry must say so by name.
		const lanOnly = managedListenerAuthority([{ kind: 'web', reach: 'lan' }]);
		setListenerAuthority(lanOnly.authority);
		const lan = new WebServer(0, undefined, { lanAccess: true });
		const lanBind = stubbed(lan);
		await expect(lan.start()).rejects.toMatchObject({
			name: 'ListenerDeniedError',
			code: 'reach-denied',
			receipt: { kind: 'web', bind: '0.0.0.0', port: 0, reach: 'any', outcome: 'reach-denied' },
		});
		expect(lanBind.listen).not.toHaveBeenCalled();
		expect(lan.isActive()).toBe(false);
		expect(heldListeners()).toMatchObject([
			{ kind: 'web', bind: '0.0.0.0', reach: 'any', code: 'reach-denied', policyRevision: 3 },
		]);

		const anyReach = managedListenerAuthority([{ kind: 'web', reach: 'any' }]);
		setListenerAuthority(anyReach.authority);
		const wide = new WebServer(0, undefined, { lanAccess: true });
		const wideBind = stubbed(wide);
		const started = await wide.start();
		expect(wideBind.listen).toHaveBeenCalledWith({ port: 0, host: '0.0.0.0' });
		expect(started.url).toMatch(/^http:\/\/192\.168\.1\.50:/);
		expect(anyReach.requests).toEqual([{ kind: 'web', bind: '0.0.0.0', port: 0 }]);
		expect(heldListeners()).toEqual([]);
	});

	it('binds nothing at the OS on a refusal: the http server under fastify never listens', async () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		const server = new WebServer(0);
		const { internals } = stubbed(server, { spyListen: false });
		const fastify = server.getServer();
		await expect(server.start()).rejects.toMatchObject({ name: 'ListenerDeniedError' });
		expect(fastify.addresses()).toEqual([]);
		expect(fastify.server.listening).toBe(false);
		expect(internals.setupRoutes).not.toHaveBeenCalled();
		expect(server.isActive()).toBe(false);
		expect(denied.requests).toEqual([{ kind: 'web', bind: '127.0.0.1', port: 0 }]);
		// A second start asks again (the policy may have changed) and is refused
		// again; the ledger counts the one row rather than growing.
		await expect(server.start()).rejects.toMatchObject({ code: 'kind-denied' });
		expect(fastify.addresses()).toEqual([]);
		expect(heldListeners()).toMatchObject([{ kind: 'web', bind: '127.0.0.1', count: 2 }]);
	});

	it('consults nothing standalone and binds as before', async () => {
		const server = new WebServer(0, undefined, { lanAccess: true });
		const { listen } = stubbed(server);
		await server.start();
		expect(listen).toHaveBeenCalledWith({ port: 0, host: '0.0.0.0' });
		expect(heldListeners()).toEqual([]);
	});
});
