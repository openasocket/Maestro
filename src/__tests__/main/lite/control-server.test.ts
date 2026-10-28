import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { createConnection, createServer } from 'net';
import { randomBytes } from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { startLiteControlServer } from '../../../main/lite/control-server';
import { sendLiteCommand } from '../../../cli/services/lite-client';
import {
	LITE_CONTROL_DISABLED_BY_POLICY,
	LITE_CONTROL_DISCOVERY_FILE,
	LITE_CONTROL_MAX_BYTES,
	resolveLiteDataDirectory,
	isLiteControlEndpoint,
	isLiteControlHeld,
} from '../../../shared/lite-control';
import type { LiteControlDiscovery } from '../../../shared/lite-control';
import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	setListenerAuthority(null);
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-control-test-'));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
async function discovery(dir: string): Promise<LiteControlDiscovery> {
	return JSON.parse(await readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), 'utf8'));
}
async function raw(endpoint: string, request: string): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const socket = createConnection(endpoint);
	let input = '';
	socket.setEncoding('utf8');
	socket.on('connect', () => socket.end(request));
	socket.on('data', (chunk) => {
		input += chunk;
	});
	socket.on('error', reject);
	socket.on('end', () => {
		try {
			resolve(JSON.parse(input));
		} catch (error) {
			reject(error);
		}
	});
	return promise;
}

describe('Lite OS-local control security and lifecycle', () => {
	it('never dispatches unauthenticated, incompatible, malformed, or oversized commands', async () => {
		const dir = await directory();
		let mutations = 0;
		const server = await startLiteControlServer(dir, async (action) => {
			if (action === 'status') return { state: { status: 'Disconnected' } };
			mutations++;
			return {};
		});
		cleanups.push(server.close);
		const info = await discovery(dir);
		const rejected = await raw(
			info.endpoint,
			JSON.stringify({ protocolVersion: 1, action: 'save', secret: '0'.repeat(64) }) + '\n'
		);
		expect(rejected).toEqual({ success: false, error: 'Lite control authentication failed.' });
		const incompatible = await raw(
			info.endpoint,
			JSON.stringify({ protocolVersion: 2, action: 'save', secret: info.secret }) + '\n'
		);
		expect(incompatible.success).toBe(false);
		expect(incompatible.error).toMatch(/Unsupported Lite control protocol/);
		const malformed = await raw(info.endpoint, '{bad json}\n');
		expect(malformed.success).toBe(false);
		expect(malformed.state).toBeUndefined();
		const oversized = await raw(info.endpoint, 'x'.repeat(LITE_CONTROL_MAX_BYTES + 1) + '\n');
		expect(oversized).toEqual({ success: false, error: 'Lite control request is too large.' });
		expect(mutations).toBe(0);
	});

	it('recovers stale discovery despite its PID belonging to an unrelated live process', async () => {
		const dir = await directory();
		const suffix = randomBytes(16).toString('hex');
		const stale: LiteControlDiscovery = {
			protocolVersion: 1,
			secret: randomBytes(32).toString('hex'),
			pid: process.pid,
			endpoint:
				process.platform === 'win32'
					? `\\\\.\\pipe\\maestro-lite-${suffix}`
					: path.join(os.tmpdir(), `maestro-lite-${suffix}.sock`),
		};
		await writeFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), JSON.stringify(stale));
		const server = await startLiteControlServer(dir, async () => ({
			state: { status: 'Disconnected', picker: true, profiles: [], aliases: [] },
		}));
		cleanups.push(server.close);
		expect((await discovery(dir)).endpoint).not.toBe(stale.endpoint);
		expect(await sendLiteCommand('status', undefined, { userData: dir })).toMatchObject({
			success: true,
			state: { status: 'Disconnected' },
		});
	});

	it.each([
		null,
		{},
		{ endpoint: '' },
		{ endpoint: null },
		{ endpoint: 42 },
		{ endpoint: 'https://host.example/control' },
		{
			endpoint:
				String.fromCharCode(92).repeat(2) +
				'remote-host' +
				String.fromCharCode(92) +
				'pipe' +
				String.fromCharCode(92) +
				'maestro-lite-' +
				'0'.repeat(32),
		},
	])(
		'replaces malformed or nonlocal discovery %j without probing an unsafe endpoint',
		async (stale) => {
			const dir = await directory();
			expect(isLiteControlEndpoint(stale?.endpoint)).toBe(false);
			await writeFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), JSON.stringify(stale));
			const server = await startLiteControlServer(dir, async () => ({
				state: { status: 'Disconnected', picker: true, profiles: [], aliases: [] },
			}));
			cleanups.push(server.close);
			expect(isLiteControlEndpoint((await discovery(dir)).endpoint)).toBe(true);
			expect(await sendLiteCommand('status', undefined, { userData: dir })).toMatchObject({
				success: true,
			});
		}
	);

	it('rejects competing live instances and removes only its own discovery on shutdown', async () => {
		const dir = await directory();
		const server = await startLiteControlServer(dir, async () => ({}));
		cleanups.push(server.close);
		const original = await discovery(dir);
		const live = { ...original, pid: Number.MAX_SAFE_INTEGER };
		await writeFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), JSON.stringify(live));
		await expect(startLiteControlServer(dir, async () => ({}))).rejects.toThrow(/already owns/);
		expect(await discovery(dir)).toEqual(live);
		const replacement = { ...original, secret: 'f'.repeat(64) };
		await writeFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), JSON.stringify(replacement));
		await server.close();
		await server.close();
		expect(await discovery(dir)).toEqual(replacement);
		await expect(raw(original.endpoint, '{}\n')).rejects.toThrow();
	});

	it('acknowledges a close before executing shutdown and removes discovery', async () => {
		const dir = await directory();
		const shutdown = Promise.withResolvers<void>();
		const server = await startLiteControlServer(dir, async (action, _payload, options) => {
			if (action !== 'close') throw new Error('Unknown action');
			options?.afterResponse?.(() => shutdown.resolve(server.close()));
			return { state: { status: 'Disconnected', closing: true } };
		});
		cleanups.push(server.close);
		const result = await sendLiteCommand('close', undefined, { userData: dir, confirmed: true });
		expect(result.success).toBe(true);
		expect(result.state?.closing).toBe(true);
		await shutdown.promise;
		await expect(readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		await expect(
			sendLiteCommand('close', undefined, { userData: dir, confirmed: true })
		).rejects.toThrow(/Cannot discover/);
	});

	it('reports uncertainty without replay when the endpoint drops a mutating command before acknowledgement', async () => {
		const dir = await directory();
		const suffix = randomBytes(16).toString('hex');
		const endpoint =
			process.platform === 'win32'
				? `\\\\.\\pipe\\maestro-lite-${suffix}`
				: path.join(os.tmpdir(), `maestro-lite-${suffix}.sock`);
		let received = 0;
		const server = createServer((socket) => {
			socket.once('data', () => {
				received++;
				socket.destroy();
			});
		});
		const listening = Promise.withResolvers<void>();
		server.once('error', listening.reject);
		server.listen(endpoint, listening.resolve);
		await listening.promise;
		cleanups.push(() => {
			const stopped = Promise.withResolvers<void>();
			server.close((error) => (error ? stopped.reject(error) : stopped.resolve()));
			return stopped.promise;
		});
		await writeFile(
			path.join(dir, LITE_CONTROL_DISCOVERY_FILE),
			JSON.stringify({
				protocolVersion: 1,
				endpoint,
				secret: randomBytes(32).toString('hex'),
				pid: process.pid,
			})
		);
		await expect(
			sendLiteCommand('remove', 'host', { userData: dir, confirmed: true })
		).rejects.toThrow(/before acknowledging.*uncertain/);
		expect(received).toBe(1);
	});

	it('keeps explicit Lite paths final and environment overrides scoped under Lite', () => {
		const prior = process.env.MAESTRO_USER_DATA;
		try {
			process.env.MAESTRO_USER_DATA = path.join(os.tmpdir(), 'maestro-host-data');
			expect(resolveLiteDataDirectory()).toBe(path.join(process.env.MAESTRO_USER_DATA, 'Lite'));
			const explicit = path.join(os.tmpdir(), 'separate-lite');
			expect(resolveLiteDataDirectory(explicit)).toBe(explicit);
			expect(() => resolveLiteDataDirectory(' ')).toThrow(/empty/);
		} finally {
			if (prior === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = prior;
		}
	});
});

describe('Lite control endpoint under the listener ceiling (MRC2-05-06A)', () => {
	it('listens on nothing under a denying ceiling and reports disabled-by-policy to maestro-cli', async () => {
		const dir = await directory();
		const denying = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denying.authority);
		let dispatched = 0;
		const server = await startLiteControlServer(dir, async () => {
			dispatched++;
			return {};
		});
		cleanups.push(server.close);
		expect(server.held).toMatchObject({ kind: 'lite-control', port: 0, code: 'kind-denied' });
		expect(denying.requests).toHaveLength(1);
		expect(denying.requests[0]).toMatchObject({ kind: 'lite-control', port: 0 });
		expect(isLiteControlEndpoint(denying.requests[0].bind)).toBe(true);
		await expect(raw(denying.requests[0].bind, '{}\n')).rejects.toThrow();
		const record = JSON.parse(
			await readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), 'utf8')
		) as unknown;
		expect(isLiteControlHeld(record)).toBe(true);
		expect(record).toEqual({
			protocolVersion: 1,
			pid: process.pid,
			status: LITE_CONTROL_DISABLED_BY_POLICY,
			code: 'kind-denied',
			message: expect.stringMatching(/^\[managed-kind-denied\] /),
		});
		await expect(sendLiteCommand('status', undefined, { userData: dir })).rejects.toThrow(
			/Maestro Lite local control is disabled-by-policy\. \[managed-kind-denied\]/
		);
		expect(dispatched).toBe(0);
		expect(heldListeners()).toMatchObject([{ kind: 'lite-control', reach: 'loopback', count: 1 }]);
		await server.close();
		await server.close();
		await expect(readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('still honors a live owner on a hold and never replaces its discovery with a record', async () => {
		const dir = await directory();
		const live = await startLiteControlServer(dir, async () => ({}));
		cleanups.push(live.close);
		const original = await discovery(dir);
		setListenerAuthority(denyingListenerAuthority('unavailable').authority);
		await expect(startLiteControlServer(dir, async () => ({}))).rejects.toThrow(/already owns/);
		expect(await discovery(dir)).toEqual(original);
	});

	it('leaves a record it does not own alone on close, and a later standalone start replaces a held record', async () => {
		const dir = await directory();
		setListenerAuthority(denyingListenerAuthority('kind-denied').authority);
		const held = await startLiteControlServer(dir, async () => ({}));
		cleanups.push(held.close);
		const foreign = {
			...JSON.parse(await readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), 'utf8')),
			pid: Number.MAX_SAFE_INTEGER,
		};
		await writeFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), JSON.stringify(foreign));
		await held.close();
		expect(JSON.parse(await readFile(path.join(dir, LITE_CONTROL_DISCOVERY_FILE), 'utf8'))).toEqual(
			foreign
		);
		setListenerAuthority(null);
		const server = await startLiteControlServer(dir, async () => ({
			state: { status: 'Disconnected', picker: true, profiles: [], aliases: [] },
		}));
		cleanups.push(server.close);
		expect(server.held).toBeNull();
		expect(isLiteControlEndpoint((await discovery(dir)).endpoint)).toBe(true);
		expect(await sendLiteCommand('status', undefined, { userData: dir })).toMatchObject({
			success: true,
		});
	});

	it('binds under the real ceiling that lists lite-control at loopback, the reach an OS-local endpoint has', async () => {
		const dir = await directory();
		const managed = managedListenerAuthority([{ kind: 'lite-control', reach: 'loopback' }]);
		setListenerAuthority(managed.authority);
		const server = await startLiteControlServer(dir, async () => ({
			state: { status: 'Disconnected', picker: true, profiles: [], aliases: [] },
		}));
		cleanups.push(server.close);
		expect(server.held).toBeNull();
		expect(managed.requests[0]).toMatchObject({ kind: 'lite-control', port: 0 });
		expect(await sendLiteCommand('status', undefined, { userData: dir })).toMatchObject({
			success: true,
			state: { status: 'Disconnected' },
		});
		expect(heldListeners()).toEqual([]);
	});
});
