/**
 * The mDNS browser and advertiser under the listener ceiling (MRC2-05-06B):
 * the ceiling answers before any socket exists, a refusal is the named
 * `[managed-<code>]` line on the start failure channel (and the browser's
 * rejection) with nothing created, bound, built or sent, a ceiling that lists
 * `mdns` as far as `lan` admits both on a LAN interface and one that stops at
 * `loopback` refuses them `reach-denied`, and standalone (no authority) both
 * bind as before. The standalone interface check still runs first, so an
 * ineligible interface never reaches the ceiling. `dns-packet` is not
 * installed here, so its codec is a stub; no case reads the bytes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';

const codec = vi.hoisted(() => ({
	encode: vi.fn(() => Buffer.from('packet')),
	decode: vi.fn(() => ({ type: 'response', answers: [] })),
}));
vi.mock('dns-packet', () => codec);

import { MdnsAdvertiser } from '../../../main/lite/discovery/advertiser';
import { MdnsBrowser } from '../../../main/lite/discovery/mdns';
import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

class MockSocket extends EventEmitter {
	bound: Array<{ port: number; address: string }> = [];
	sent = 0;
	closed = false;
	bind(port: number, address: string, ready?: () => void): void {
		this.bound.push({ port, address });
		ready?.();
	}
	send(_bytes: Buffer, _port: number, _group: string, done?: (error?: Error) => void): void {
		this.sent += 1;
		done?.();
	}
	addMembership(): void {}
	dropMembership(): void {}
	setMulticastInterface(): void {}
	setMulticastTTL(): void {}
	close(): void {
		this.closed = true;
	}
}

const LAN = '192.0.2.10';
const ENDPOINT = 'https://host.example.test:8443';
const MDNS_PORT = 5353;

function sockets() {
	const created: MockSocket[] = [];
	const factory = vi.fn(() => {
		const socket = new MockSocket();
		created.push(socket);
		return socket as unknown as Socket;
	});
	return { created, factory };
}

const started: Array<{ stop(): void }> = [];

afterEach(() => {
	for (const item of started.splice(0)) item.stop();
	setListenerAuthority(null);
	vi.clearAllMocks();
});

describe('the mDNS advertiser under the listener ceiling', () => {
	it('opens no socket and builds no packet when the ceiling refuses the mdns kind, and names the refusal', () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		const { created, factory } = sockets();
		const advertiser = new MdnsAdvertiser(factory);
		started.push(advertiser);
		const failed = vi.fn();

		advertiser.start(LAN, 'host-id', 'Synthetic host', ENDPOINT, failed);

		expect(factory).not.toHaveBeenCalled();
		expect(created).toHaveLength(0);
		expect(codec.encode).not.toHaveBeenCalled();
		expect(failed).toHaveBeenCalledTimes(1);
		expect(failed.mock.calls[0][0]).toMatch(/^\[managed-kind-denied\] /);
		expect(denied.requests).toEqual([{ kind: 'mdns', bind: LAN, port: MDNS_PORT }]);
		expect(heldListeners()).toMatchObject([
			{ kind: 'mdns', bind: LAN, port: MDNS_PORT, reach: 'lan', code: 'kind-denied', count: 1 },
		]);
		// Stopping a refused advertiser is harmless: there is nothing to withdraw.
		expect(() => advertiser.stop()).not.toThrow();
	});

	it('refuses an ineligible interface before the ceiling is asked', () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		const { factory } = sockets();
		const advertiser = new MdnsAdvertiser(factory);
		const failed = vi.fn();

		expect(() =>
			advertiser.start('0.0.0.0', 'host-id', 'Synthetic host', ENDPOINT, failed)
		).toThrow('Choose an explicit IPv4 multicast interface');
		expect(denied.requests).toEqual([]);
		expect(failed).not.toHaveBeenCalled();
	});
});

describe('the mDNS browser under the listener ceiling', () => {
	it('rejects by name with nothing bound when the ceiling refuses', async () => {
		const denied = denyingListenerAuthority('unavailable');
		setListenerAuthority(denied.authority);
		const { factory } = sockets();
		const browser = new MdnsBrowser(LAN, factory);
		started.push(browser);
		const failed = vi.fn();

		await expect(browser.start(() => undefined, failed)).rejects.toMatchObject({
			name: 'ListenerDeniedError',
			code: 'unavailable',
			kind: 'mdns',
		});
		expect(factory).not.toHaveBeenCalled();
		expect(failed).toHaveBeenCalledTimes(1);
		expect(failed.mock.calls[0][0]).toMatch(/^\[managed-unavailable\] /);
		expect(denied.requests).toEqual([{ kind: 'mdns', bind: LAN, port: MDNS_PORT }]);
		expect(heldListeners()).toMatchObject([{ kind: 'mdns', code: 'unavailable', bind: LAN }]);
	});

	it('refuses an ineligible interface before the ceiling is asked', () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);
		expect(() => new MdnsBrowser('0.0.0.0', sockets().factory)).toThrow(
			'Choose an explicit IPv4 multicast interface'
		);
		expect(denied.requests).toEqual([]);
	});
});

describe('the real ceiling, by reach', () => {
	it('a ceiling that lists mdns as far as lan admits the advertiser and the browser on a LAN interface', async () => {
		const managed = managedListenerAuthority([{ kind: 'mdns', reach: 'lan' }]);
		setListenerAuthority(managed.authority);
		const advertiserSockets = sockets();
		const advertiser = new MdnsAdvertiser(advertiserSockets.factory);
		started.push(advertiser);
		const advertiseFailed = vi.fn();
		advertiser.start(LAN, 'host-id', 'Synthetic host', ENDPOINT, advertiseFailed);

		const browserSockets = sockets();
		const browser = new MdnsBrowser(LAN, browserSockets.factory);
		started.push(browser);
		const browseFailed = vi.fn();
		await browser.start(() => undefined, browseFailed);

		expect(advertiserSockets.created[0].bound).toEqual([{ port: MDNS_PORT, address: '0.0.0.0' }]);
		expect(browserSockets.created[0].bound).toEqual([{ port: MDNS_PORT, address: '0.0.0.0' }]);
		expect(browserSockets.created[0].sent).toBe(1);
		expect(advertiseFailed).not.toHaveBeenCalled();
		expect(browseFailed).not.toHaveBeenCalled();
		expect(managed.requests).toEqual([
			{ kind: 'mdns', bind: LAN, port: MDNS_PORT },
			{ kind: 'mdns', bind: LAN, port: MDNS_PORT },
		]);
		expect(heldListeners()).toEqual([]);
	});

	it('a ceiling that lists mdns only at loopback refuses a LAN interface reach-denied, with nothing bound', async () => {
		const managed = managedListenerAuthority([{ kind: 'mdns', reach: 'loopback' }]);
		setListenerAuthority(managed.authority);
		const advertiserSockets = sockets();
		const advertiser = new MdnsAdvertiser(advertiserSockets.factory);
		started.push(advertiser);
		const advertiseFailed = vi.fn();
		advertiser.start(LAN, 'host-id', 'Synthetic host', ENDPOINT, advertiseFailed);

		const browserSockets = sockets();
		const browser = new MdnsBrowser(LAN, browserSockets.factory);
		started.push(browser);
		const browseFailed = vi.fn();
		await expect(browser.start(() => undefined, browseFailed)).rejects.toMatchObject({
			name: 'ListenerDeniedError',
			code: 'reach-denied',
		});

		expect(advertiserSockets.factory).not.toHaveBeenCalled();
		expect(browserSockets.factory).not.toHaveBeenCalled();
		expect(advertiseFailed.mock.calls[0][0]).toMatch(/^\[managed-reach-denied\] /);
		expect(browseFailed.mock.calls[0][0]).toMatch(/^\[managed-reach-denied\] /);
		expect(heldListeners()).toMatchObject([
			{ kind: 'mdns', bind: LAN, port: MDNS_PORT, reach: 'lan', code: 'reach-denied', count: 2 },
		]);
	});

	it('a ceiling that lists nothing refuses the advertiser kind-denied', () => {
		const source = managedListenerAuthority([]);
		setListenerAuthority(source.authority);
		const { factory } = sockets();
		const advertiser = new MdnsAdvertiser(factory);
		const failed = vi.fn();
		advertiser.start(LAN, 'host-id', 'Synthetic host', ENDPOINT, failed);
		expect(factory).not.toHaveBeenCalled();
		expect(failed.mock.calls[0][0]).toMatch(/^\[managed-kind-denied\] /);
		expect(source.requests).toEqual([{ kind: 'mdns', bind: LAN, port: MDNS_PORT }]);
	});
});

describe('standalone', () => {
	it('with no authority installed, the advertiser and the browser bind as they always have', async () => {
		const advertiserSockets = sockets();
		const advertiser = new MdnsAdvertiser(advertiserSockets.factory);
		started.push(advertiser);
		const advertiseFailed = vi.fn();
		advertiser.start(LAN, 'host-id', 'Synthetic host', ENDPOINT, advertiseFailed);

		const browserSockets = sockets();
		const browser = new MdnsBrowser(LAN, browserSockets.factory);
		started.push(browser);
		const browseFailed = vi.fn();
		await browser.start(() => undefined, browseFailed);

		expect(advertiserSockets.created[0].bound).toEqual([{ port: MDNS_PORT, address: '0.0.0.0' }]);
		expect(browserSockets.created[0].bound).toEqual([{ port: MDNS_PORT, address: '0.0.0.0' }]);
		expect(advertiseFailed).not.toHaveBeenCalled();
		expect(browseFailed).not.toHaveBeenCalled();
		expect(heldListeners()).toEqual([]);
	});
});
