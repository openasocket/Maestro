/**
 * The managed hold of a Federation forward on the desktop (MCOMP-33-00L1): every attempt of the
 * shared SSH forward manager is held as an `ssh-tunnel` listener and as a remote `probe` under the
 * managed remote identity BEFORE the discovery's ssh, the free-port probe and the `ssh -L` spawn.
 * A refusal is named, and nothing is dialed. Standalone nothing is consulted.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	createFederationSupervisorHooks,
	holdFederationForward,
	setPeerMirrorServiceForTests,
} from '../../../main/federation';
import {
	isListenerDeniedError,
	setListenerAuthority,
} from '../../../main/enterprise/listener-gate';
import {
	listenerVerdict,
	type ListenerCeilingEntry,
	type ListenerRequest,
} from '../../../main/enterprise/listener-policy';
import type { RemoteAccessDecision, RemoteAccessRequest } from '../../../main/enterprise/remote';
import { heldRemoteAccess, setRemoteAccessAuthority } from '../../../main/ssh-remote-manager';
import {
	SshForwardManager,
	setSshForwardAdmission,
	type SshForwardLease,
} from '../../../shared/maestro-lib/client/ssh-forward';
import type { SshRemoteConfig } from '../../../shared/types';

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'Build box',
	host: 'build.example.com',
	port: 22,
	username: 'pedram',
	privateKeyPath: '',
	enabled: true,
	federation: true,
};

/** Install a managed listener ceiling over the real verdict; returns every request it was asked. */
function installListenerCeiling(listeners: ListenerCeilingEntry[]): ListenerRequest[] {
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

/** Install a remote identity that refuses (or admits) every remote; returns every request it was asked. */
function installRemoteIdentity(admit: boolean): RemoteAccessRequest[] {
	const asked: RemoteAccessRequest[] = [];
	setRemoteAccessAuthority({
		async hold(request): Promise<RemoteAccessDecision> {
			asked.push(request);
			if (admit) return { allowed: true };
			return {
				allowed: false,
				code: 'remote-unqualified',
				message: `the remote ${request.remote.name} attests no managed standing this host accepts`,
				managed: {
					policyRevision: 3,
					class: request.class,
					operation: request.operation,
					remoteId: request.remote.id,
					target: null,
					count: 1,
					endpoint: null,
					effect: null,
					outcome: 'remote-unqualified',
				},
			};
		},
	});
	return asked;
}

afterEach(() => {
	setListenerAuthority(null);
	setRemoteAccessAuthority(null);
	setSshForwardAdmission(null);
	setPeerMirrorServiceForTests(null);
});

describe('holdFederationForward', () => {
	it('standalone: no gate has an authority and the attempt proceeds', async () => {
		await expect(holdFederationForward(remote)).resolves.toBeUndefined();
	});

	it('refused listener: throws the named hold before the remote is asked', async () => {
		const asked = installListenerCeiling([{ kind: 'web', reach: 'loopback' }]);
		const remoteAsked = installRemoteIdentity(true);
		const error = await holdFederationForward(remote).catch((e: unknown) => e);
		expect(isListenerDeniedError(error)).toBe(true);
		expect((error as Error).message).toMatch(/^\[managed-kind-denied\] /);
		expect(asked).toEqual([{ kind: 'ssh-tunnel', bind: '127.0.0.1', port: 0 }]);
		expect(remoteAsked).toEqual([]);
	});

	it('admitted listener, unqualified peer: throws the remote identity hold by name', async () => {
		installListenerCeiling([{ kind: 'ssh-tunnel', reach: 'loopback' }]);
		const remoteAsked = installRemoteIdentity(false);
		await expect(holdFederationForward(remote)).rejects.toThrow(/^\[managed-remote-unqualified\] /);
		expect(remoteAsked).toEqual([
			{ class: 'probe', remote, operation: 'federation-forward', target: null },
		]);
		expect(heldRemoteAccess()).toMatchObject([
			{ remoteId: 'r1', class: 'probe', code: 'remote-unqualified', count: 1 },
		]);
	});

	it('admitted listener and qualified peer: the attempt proceeds', async () => {
		installListenerCeiling([{ kind: 'ssh-tunnel', reach: 'loopback' }]);
		installRemoteIdentity(true);
		await expect(holdFederationForward(remote)).resolves.toBeUndefined();
	});
});

describe('the Federation lifecycle installs the hold on the shared forward manager', () => {
	it('after reconcile, a refused forward runs no discovery and spawns no ssh', async () => {
		const hooks = createFederationSupervisorHooks({
			readRemotes: () => [],
			watchRemotes: () => () => undefined,
			safeSend: vi.fn(),
			overrides: {
				acquireForward: vi.fn(() => ({}) as unknown as SshForwardLease),
				createClient: vi.fn(),
			},
		});
		hooks.reconcile();
		installListenerCeiling([{ kind: 'web', reach: 'loopback' }]);

		const discover = vi.fn();
		const spawn = vi.fn();
		const allocatePort = vi.fn(async () => 50000);
		const manager = new SshForwardManager({
			discover,
			spawn,
			allocatePort,
			sshPath: '/usr/bin/ssh',
			backoffInitialMs: 60_000,
		});
		const lease = manager.acquire(remote);
		await expect(lease.ready()).rejects.toThrow(/^\[managed-kind-denied\] /);
		expect(discover).not.toHaveBeenCalled();
		expect(allocatePort).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		await lease.release();
		hooks.stopAll();
	});
});
