/**
 * The Lite SSH forward under the listener ceiling (MRC2-05-06A): `openTunnel()`
 * holds `{ kind: "ssh-tunnel", bind: "127.0.0.1", port }` BEFORE the free-port
 * probe, the `ssh -G` resolution and the spawn, so a refusal leaves no
 * listener, no child and no probe behind; an admitted or a standalone open
 * reaches the probe as it always has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
	spawn: vi.fn(),
	execFile: vi.fn(),
	createServer: vi.fn(),
	connect: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: fixture.spawn, execFile: fixture.execFile }));
vi.mock('net', () => ({
	default: { createServer: fixture.createServer, connect: fixture.connect },
}));

import { openTunnel } from '../../../main/lite/tunnel';
import {
	heldListeners,
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import type { SshRemoteConfig } from '../../../shared/types';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

const config: SshRemoteConfig = {
	id: 'host-a',
	name: 'Host A',
	host: 'my-alias',
	port: 22,
	username: '',
	privateKeyPath: '',
	useSshConfig: true,
	enabled: true,
};
const endpoint = new URL('http://127.0.0.1:8080/token-a');

/** A probe listener whose bind fails with a sentinel: proof the gate was passed and nothing else ran. */
function probeThatFails(): void {
	fixture.createServer.mockImplementation(() => {
		let onError: ((error: Error) => void) | undefined;
		return {
			once: (event: string, handler: (error: Error) => void) => {
				if (event === 'error') onError = handler;
			},
			listen: () => onError?.(new Error('probe sentinel')),
		};
	});
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => setListenerAuthority(null));

describe('openTunnel under the listener ceiling', () => {
	it('refuses before the free-port probe, ssh -G and the spawn, naming the forward it would have bound', async () => {
		const denying = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denying.authority);
		const onExit = vi.fn();
		const attempt = openTunnel(config, endpoint, new AbortController().signal, onExit, 4321);
		await expect(attempt).rejects.toSatisfy((error: unknown) => isListenerDeniedError(error));
		await expect(attempt).rejects.toThrow(/\[managed-kind-denied\]/);
		expect(denying.requests).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 4321 }]);
		expect(fixture.createServer).not.toHaveBeenCalled();
		expect(fixture.execFile).not.toHaveBeenCalled();
		expect(fixture.spawn).not.toHaveBeenCalled();
		expect(fixture.connect).not.toHaveBeenCalled();
		expect(onExit).not.toHaveBeenCalled();
		expect(heldListeners()).toMatchObject([
			{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 4321, code: 'kind-denied', count: 1 },
		]);
	});

	it('names port 0 when the OS is to pick the forward port', async () => {
		const denying = denyingListenerAuthority('unavailable');
		setListenerAuthority(denying.authority);
		await expect(
			openTunnel(config, endpoint, new AbortController().signal, vi.fn())
		).rejects.toThrow(/\[managed-unavailable\]/);
		expect(denying.requests).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 0 }]);
		expect(fixture.createServer).not.toHaveBeenCalled();
	});

	it('reaches the free-port probe under the real ceiling that lists ssh-tunnel at loopback', async () => {
		const managed = managedListenerAuthority([{ kind: 'ssh-tunnel', reach: 'loopback' }]);
		setListenerAuthority(managed.authority);
		probeThatFails();
		await expect(
			openTunnel(config, endpoint, new AbortController().signal, vi.fn(), 4321)
		).rejects.toThrow(/probe sentinel/);
		expect(managed.requests).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 4321 }]);
		expect(fixture.createServer).toHaveBeenCalledOnce();
		expect(fixture.spawn).not.toHaveBeenCalled();
		expect(heldListeners()).toEqual([]);
	});

	it('is refused by the real ceiling when the kind is absent, even with the cloudflared tunnel admitted', async () => {
		const managed = managedListenerAuthority([{ kind: 'tunnel', reach: 'public' }]);
		setListenerAuthority(managed.authority);
		await expect(
			openTunnel(config, endpoint, new AbortController().signal, vi.fn(), 4321)
		).rejects.toThrow(/\[managed-kind-denied\]/);
		expect(fixture.createServer).not.toHaveBeenCalled();
	});

	it('standalone reaches the probe with nothing consulted', async () => {
		probeThatFails();
		await expect(
			openTunnel(config, endpoint, new AbortController().signal, vi.fn(), 4321)
		).rejects.toThrow(/probe sentinel/);
		expect(fixture.createServer).toHaveBeenCalledOnce();
		expect(heldListeners()).toEqual([]);
	});
});
