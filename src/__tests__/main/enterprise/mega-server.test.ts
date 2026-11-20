/**
 * The Mega-Maestro server settings file and the lookup. A fake health route and
 * a fake endpoint probe stand in for the network and the socket. What is
 * defended: a bad address is refused before any contact; an unreachable server
 * is a finding, not a throw; the server's build version is never invented; the
 * local endpoint is asked only when a socket is set.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMegaServerService,
	createMegaServerStore,
	lookupMegaServer,
} from '../../../main/enterprise/mega-server';
import { MEGA_SERVER_VERSION_NOTE, type MegaServerSettings } from '../../../shared/megaServer';

const SERVER: MegaServerSettings = { host: 'mega.example.com', port: 443, endpointSocket: '' };
const VERSIONS = { maestro: '1.1.1-RC', library: '0.44.0', contracts: '0.4.0' };

describe('the settings file', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-server-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('starts empty when no file exists, and never guesses a server', () => {
		const store = createMegaServerStore(dir);
		expect(store.read()).toEqual({ host: '', port: 443, endpointSocket: '' });
	});

	it('saves a valid choice and reads it back', () => {
		const store = createMegaServerStore(dir);
		expect(store.save({ ...SERVER, endpointSocket: '/var/lib/mega/ipc.sock' })).toBeNull();
		expect(store.read()).toEqual({ ...SERVER, endpointSocket: '/var/lib/mega/ipc.sock' });
	});

	it('refuses to save an invalid choice, and writes nothing', () => {
		const store = createMegaServerStore(dir);
		expect(store.save({ host: 'https://mega.example.com', port: 443, endpointSocket: '' })).toMatch(
			/without a scheme/
		);
		expect(fs.existsSync(store.file)).toBe(false);
	});

	it('treats a file that is not JSON as no choice', () => {
		fs.writeFileSync(path.join(dir, 'maestro-mega-server.json'), 'not json');
		expect(createMegaServerStore(dir).read().host).toBe('');
	});
});

describe('lookupMegaServer', () => {
	const healthOk = vi.fn(async () => ({ status: 200, body: '{"status":"alive"}' }));

	it('refuses an invalid address before any contact', async () => {
		const fetchHealth = vi.fn();
		const result = await lookupMegaServer(
			{ host: '', port: 443, endpointSocket: '' },
			{
				fetchHealth,
				supportedCapabilities: [],
				versions: VERSIONS,
			}
		);
		expect(fetchHealth).not.toHaveBeenCalled();
		expect(result.reachable).toBe(false);
		expect(result.message).toMatch(/Enter the host/);
	});

	it('reports a reachable server and its health, and asks the endpoint only when a socket is set', async () => {
		const probeEndpoint = vi.fn(async () => ({
			status: 'negotiated' as const,
			protocol: 2,
			capabilities: ['attachment', 'compatibility'],
		}));
		const result = await lookupMegaServer(
			{ ...SERVER, endpointSocket: '/var/lib/mega/ipc.sock' },
			{
				fetchHealth: healthOk,
				probeEndpoint,
				supportedCapabilities: ['attachment'],
				versions: VERSIONS,
			}
		);
		expect(healthOk).toHaveBeenCalledWith('https://mega.example.com/healthz');
		expect(probeEndpoint).toHaveBeenCalledWith('/var/lib/mega/ipc.sock');
		expect(result).toMatchObject({
			reachable: true,
			health: 'alive',
			httpStatus: 200,
			endpoint: { status: 'negotiated', protocol: 2 },
		});
	});

	it('never invents a server build version, and says why', async () => {
		const result = await lookupMegaServer(SERVER, {
			fetchHealth: healthOk,
			supportedCapabilities: [],
			versions: VERSIONS,
		});
		expect(result.serverVersion).toBeNull();
		expect(result.serverVersionNote).toBe(MEGA_SERVER_VERSION_NOTE);
	});

	it('reports an unreachable server as a finding, with the reason', async () => {
		const result = await lookupMegaServer(SERVER, {
			fetchHealth: async () => {
				throw new Error('getaddrinfo ENOTFOUND mega.example.com');
			},
			supportedCapabilities: [],
			versions: VERSIONS,
		});
		expect(result.reachable).toBe(false);
		expect(result.httpStatus).toBeNull();
		expect(result.message).toMatch(/could not be reached: getaddrinfo ENOTFOUND/);
	});

	it('reports a server that answers, but not 200, without a health status', async () => {
		const result = await lookupMegaServer(SERVER, {
			fetchHealth: async () => ({ status: 503, body: 'down' }),
			supportedCapabilities: [],
			versions: VERSIONS,
		});
		expect(result).toMatchObject({ reachable: true, httpStatus: 503, health: null });
		expect(result.message).toMatch(/HTTP 503/);
	});

	it('says the endpoint was not asked when no socket is set', async () => {
		const probeEndpoint = vi.fn();
		const result = await lookupMegaServer(SERVER, {
			fetchHealth: healthOk,
			probeEndpoint,
			supportedCapabilities: [],
			versions: VERSIONS,
		});
		expect(probeEndpoint).not.toHaveBeenCalled();
		expect(result.endpoint).toEqual({
			status: 'unavailable',
			message: 'No local endpoint socket is set, so none was asked.',
		});
	});

	it('turns a failed endpoint probe into a finding, not a throw', async () => {
		const result = await lookupMegaServer(
			{ ...SERVER, endpointSocket: '/missing.sock' },
			{
				fetchHealth: healthOk,
				probeEndpoint: async () => {
					throw new Error('connect ENOENT /missing.sock');
				},
				supportedCapabilities: [],
				versions: VERSIONS,
			}
		);
		expect(result.endpoint).toMatchObject({ status: 'unavailable' });
		expect(result.endpoint).toMatchObject({ message: expect.stringContaining('ENOENT') });
	});

	it('carries the versions this build runs, with contracts null when none is named', async () => {
		const result = await lookupMegaServer(SERVER, {
			fetchHealth: healthOk,
			supportedCapabilities: [],
			versions: { ...VERSIONS, contracts: null },
		});
		expect(result.versions).toEqual({ ...VERSIONS, contracts: null });
	});
});

describe('createMegaServerService', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mega-service-'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('looks up the saved server with this build versions, and the pinned contracts version when one is named', async () => {
		const service = createMegaServerService({
			userDataDir: dir,
			appVersion: '1.1.1-RC',
			supportedCapabilities: ['attachment'],
			contractsVersion: () => '0.4.0',
			fetchHealth: async () => ({ status: 200, body: '{"status":"alive"}' }),
		});
		expect(service.save(SERVER)).toBeNull();
		const result = await service.lookup();
		expect(result.versions).toEqual({
			maestro: '1.1.1-RC',
			library: expect.any(String),
			contracts: '0.4.0',
		});
		expect(result.reachable).toBe(true);
	});
});
