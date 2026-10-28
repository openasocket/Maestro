/**
 * Tailscale discovery under the listener ceiling (MRC2-05-07A). The Lite
 * client asks the local Tailscale daemon for peers and advertised Services
 * (`tailscale status --json`, `tailscale service list --json`) to find hosts
 * over the tailnet; here both reads are held as the `tailnet` listener kind
 * BEFORE the executable runs, so a ceiling that omits the kind, or keeps it to
 * loopback, finds no host over Tailscale either and names the policy as the
 * source's state. The direct tailnet reader that authorizes a destination is
 * held by the same read. Standalone, nothing is consulted and the daemon is
 * read as before. Nothing here runs the tailscale executable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile }));

import {
	readTailscaleServices,
	readTailscaleStatus,
	TAILNET_DISCOVERY_LISTENER,
} from '../../../main/lite/discovery/tailscale';
import { readTailnet } from '../../../main/lite/tailnet';
import { TAILNET_PORT } from '../../../main/lite/tailnet-origin';
import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import { listenerReach } from '../../../main/enterprise/listener-policy';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

const running = JSON.stringify({
	BackendState: 'Running',
	CurrentTailnet: { MagicDNSSuffix: 'synthetic.ts.net' },
	Self: { ID: 'self', Online: true, TailscaleIPs: ['100.64.0.2'], DNSName: 'me.synthetic.ts.net.' },
	Peer: {},
});

beforeEach(() => {
	execFile.mockReset();
	execFile.mockImplementation((_file, _args, _options, callback) => callback(null, running, ''));
});
afterEach(() => {
	setListenerAuthority(null);
});

describe('the listener Tailscale discovery is held as', () => {
	it('is the tailnet kind at the direct Maestro port, reaching the tailnet and no further', () => {
		expect(TAILNET_DISCOVERY_LISTENER).toEqual({
			kind: 'tailnet',
			bind: '100.64.0.0',
			port: TAILNET_PORT,
		});
		expect(listenerReach(TAILNET_DISCOVERY_LISTENER.kind, TAILNET_DISCOVERY_LISTENER.bind)).toBe(
			'tailnet'
		);
	});
});

describe('standalone', () => {
	it('reads the daemon as before and records nothing', async () => {
		await expect(readTailscaleStatus(new AbortController().signal)).resolves.toBe(running);
		expect(execFile).toHaveBeenCalledTimes(1);
		expect(execFile.mock.calls[0][1]).toEqual(['status', '--json']);
		expect(heldListeners()).toEqual([]);
	});
});

describe('a ceiling that omits the tailnet kind', () => {
	it('refuses the status read by name before the executable runs', async () => {
		const { authority, requests } = denyingListenerAuthority('kind-denied');
		setListenerAuthority(authority);

		const failure = await readTailscaleStatus(new AbortController().signal).catch(
			(error: unknown) => error
		);

		expect(failure).toMatchObject({
			name: 'TailscaleDiscoveryError',
			status: 'unavailable',
			code: 'kind-denied',
		});
		expect((failure as Error).message).toBe(
			'[managed-kind-denied] the listener ceiling admits no tailnet listener'
		);
		expect(execFile).not.toHaveBeenCalled();
		expect(requests).toEqual([{ kind: 'tailnet', bind: '100.64.0.0', port: TAILNET_PORT }]);
	});

	it('refuses the Services read the same way and keeps one ledger row with a count', async () => {
		setListenerAuthority(denyingListenerAuthority('kind-denied').authority);

		await expect(readTailscaleStatus(new AbortController().signal)).rejects.toMatchObject({
			code: 'kind-denied',
		});
		await expect(readTailscaleServices(new AbortController().signal)).rejects.toMatchObject({
			code: 'kind-denied',
		});

		expect(execFile).not.toHaveBeenCalled();
		expect(heldListeners()).toEqual([
			expect.objectContaining({
				kind: 'tailnet',
				bind: '100.64.0.0',
				port: TAILNET_PORT,
				reach: 'tailnet',
				code: 'kind-denied',
				count: 2,
			}),
		]);
	});

	it('holds the direct tailnet destination reader, so no destination is authorized over a refused tailnet', async () => {
		setListenerAuthority(denyingListenerAuthority('unavailable').authority);

		await expect(readTailnet(new AbortController().signal)).rejects.toMatchObject({
			status: 'unavailable',
			code: 'unavailable',
			message: '[managed-unavailable] the listener ceiling admits no tailnet listener',
		});
		expect(execFile).not.toHaveBeenCalled();
	});
});

describe('the real ceiling', () => {
	it('admits the read when the tailnet kind reaches the tailnet', async () => {
		const { authority, requests } = managedListenerAuthority([
			{ kind: 'tailnet', reach: 'tailnet' },
		]);
		setListenerAuthority(authority);

		await expect(readTailscaleStatus(new AbortController().signal)).resolves.toBe(running);

		expect(execFile).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(heldListeners()).toEqual([]);
	});

	it('refuses the read reach-denied when the kind is kept to loopback', async () => {
		setListenerAuthority(
			managedListenerAuthority([{ kind: 'tailnet', reach: 'loopback' }]).authority
		);

		const failure = await readTailscaleServices(new AbortController().signal).catch(
			(error: unknown) => error
		);

		expect(failure).toMatchObject({ status: 'unavailable', code: 'reach-denied' });
		expect((failure as Error).message).toMatch(/^\[managed-reach-denied\] /);
		expect(execFile).not.toHaveBeenCalled();
	});

	it('refuses the read kind-denied when the ceiling lists other kinds only', async () => {
		setListenerAuthority(
			managedListenerAuthority([
				{ kind: 'web', reach: 'loopback' },
				{ kind: 'mdns', reach: 'lan' },
			]).authority
		);

		await expect(readTailscaleStatus(new AbortController().signal)).rejects.toMatchObject({
			code: 'kind-denied',
		});
		expect(execFile).not.toHaveBeenCalled();
	});
});
