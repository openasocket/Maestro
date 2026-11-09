/**
 * The managed listener ceiling at the two OS-local sockets the desktop opens
 * for agent subprocesses (MCOMP-19-01B): the permission relay (`relay`) and
 * the coworking bridge (`coworking`). Each asks the gate BEFORE the stale-file
 * unlink and the bind, with its socket path as `bind` (reach `loopback`).
 * Refused: nothing listens and the hold carries its `[managed-<code>]` name.
 * Admitted and standalone: the socket listens as before.
 *
 * The decisions come from the real `listenerVerdict()` over a managed
 * standing, so the codes and messages are the ones a sink meets in practice.
 * Real sockets (named pipes on Windows) at per-run paths.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const RUN_ID = `${process.pid}-${Date.now()}`;
const coworkingSocketPath =
	process.platform === 'win32'
		? `\\\\.\\pipe\\maestro-cw-hold-${RUN_ID}`
		: path.join(os.tmpdir(), `maestro-cw-hold-${RUN_ID}.sock`);

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => coworkingSocketPath,
}));

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
import { PermissionRelayServer } from '../../../main/permission-relay/PermissionRelayServer';
import {
	startCoworkingBridge,
	stopCoworkingBridge,
} from '../../../main/coworking/coworking-bridge';

/** Install a managed ceiling listing `listeners`; returns every request it was asked. */
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

function canConnect(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const client = net.createConnection(socketPath);
		client.once('connect', () => {
			client.destroy();
			resolve(true);
		});
		client.once('error', () => resolve(false));
	});
}

function tempUserDataDir(): string {
	// Short, so the relay keeps its userData-based socket path under the 100-byte cap.
	return fs.mkdtempSync(path.join(os.tmpdir(), 'mrh-'));
}

afterEach(async () => {
	setListenerAuthority(null);
	await stopCoworkingBridge();
	warn.mockClear();
});

describe('permission relay listener hold', () => {
	it('refused: throws the managed hold before any socket exists, and records it', async () => {
		const asked = installCeiling([{ kind: 'web', reach: 'loopback' }]);
		const relay = new PermissionRelayServer();
		const dir = tempUserDataDir();

		const error = await relay.ensureStarted(dir).catch((e: unknown) => e);

		expect(isListenerDeniedError(error)).toBe(true);
		expect((error as Error).message).toMatch(/^\[managed-kind-denied\] /);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ kind: 'relay', port: 0 });
		expect(relay.isRunning()).toBe(false);
		if (process.platform !== 'win32') {
			expect(fs.existsSync(asked[0].bind)).toBe(false);
		}
		expect(await canConnect(asked[0].bind)).toBe(false);
		expect(heldListeners()).toMatchObject([
			{ kind: 'relay', reach: 'loopback', code: 'kind-denied', port: 0 },
		]);
		relay.stop();
	});

	it('refused: a stale socket file from a prior run is left untouched', async () => {
		if (process.platform === 'win32') return;
		const dir = tempUserDataDir();
		const stale = path.join(dir, 'permission-relay.sock');
		fs.writeFileSync(stale, '');
		installCeiling([]);

		await expect(new PermissionRelayServer().ensureStarted(dir)).rejects.toThrow(
			/^\[managed-kind-denied\] /
		);
		expect(fs.existsSync(stale)).toBe(true);
	});

	it('admitted: listens on its OS-local socket as loopback', async () => {
		const asked = installCeiling([{ kind: 'relay', reach: 'loopback' }]);
		const relay = new PermissionRelayServer();
		const socketPath = await relay.ensureStarted(tempUserDataDir());
		try {
			expect(asked).toEqual([{ kind: 'relay', bind: socketPath, port: 0 }]);
			expect(relay.isRunning()).toBe(true);
			expect(await canConnect(socketPath)).toBe(true);
			expect(heldListeners()).toEqual([]);
		} finally {
			relay.stop();
		}
	});

	it('standalone: asks nothing and listens as before', async () => {
		const relay = new PermissionRelayServer();
		const socketPath = await relay.ensureStarted(tempUserDataDir());
		try {
			expect(await canConnect(socketPath)).toBe(true);
			expect(heldListeners()).toEqual([]);
		} finally {
			relay.stop();
		}
	});
});

describe('coworking bridge listener hold', () => {
	it('refused: does not listen, logs the managed hold and does not throw', async () => {
		const asked = installCeiling([{ kind: 'relay', reach: 'loopback' }]);

		await expect(startCoworkingBridge()).resolves.toBeUndefined();

		expect(asked).toEqual([{ kind: 'coworking', bind: coworkingSocketPath, port: 0 }]);
		expect(await canConnect(coworkingSocketPath)).toBe(false);
		expect(heldListeners()).toMatchObject([
			{ kind: 'coworking', reach: 'loopback', code: 'kind-denied' },
		]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/not started: \[managed-kind-denied\] /),
			'Coworking'
		);
	});

	it('refused: a later start the ceiling admits listens', async () => {
		installCeiling([]);
		await startCoworkingBridge();
		expect(await canConnect(coworkingSocketPath)).toBe(false);

		installCeiling([{ kind: 'coworking', reach: 'loopback' }]);
		await startCoworkingBridge();
		expect(await canConnect(coworkingSocketPath)).toBe(true);
	});

	it('admitted: listens on its OS-local socket as loopback', async () => {
		const asked = installCeiling([{ kind: 'coworking', reach: 'loopback' }]);
		await startCoworkingBridge();
		expect(asked).toEqual([{ kind: 'coworking', bind: coworkingSocketPath, port: 0 }]);
		expect(await canConnect(coworkingSocketPath)).toBe(true);
		expect(heldListeners()).toEqual([]);
	});

	it('standalone: asks nothing and listens as before', async () => {
		await startCoworkingBridge();
		expect(await canConnect(coworkingSocketPath)).toBe(true);
		expect(heldListeners()).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
	});
});
