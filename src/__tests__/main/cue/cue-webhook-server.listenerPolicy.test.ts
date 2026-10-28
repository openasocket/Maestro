/**
 * The shared Cue webhook listener under the listener ceiling (MRC2-05-06B):
 * the ceiling answers before `http.createServer` is called, a refusal is
 * logged once as the named `[managed-<code>]` line, read back with
 * `getCueWebhookListenerHold()` and carried by the ledger, and is as sticky
 * as a failed bind (a second registration asks nothing and logs nothing). A
 * ceiling that lists `cue-webhook` at loopback binds the default host and
 * takes a delivery; the same ceiling refuses a `0.0.0.0` bind `reach-denied`;
 * standalone (no authority) binds as before. Its own file so the routing
 * suite stays socket-free.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';

const spied = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('http', async (importOriginal) => {
	const actual = await importOriginal<typeof import('http')>();
	spied.createServer.mockImplementation(actual.createServer);
	return { ...actual, createServer: spied.createServer };
});
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/cue/cue-db', () => ({
	claimWebhookDelivery: () => true,
	isWebhookDeliveryClaimed: () => false,
}));

import {
	buildCueWebhookUrl,
	getCueWebhookListenerHold,
	registerCueWebhook,
	resetCueWebhookServerForTests,
	type CueWebhookDelivery,
} from '../../../main/cue/cue-webhook-server';
import { heldListeners, setListenerAuthority } from '../../../main/enterprise/listener-gate';
import {
	denyingListenerAuthority,
	managedListenerAuthority,
} from '../../helpers/listenerAuthority';

const originalPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;
const originalHost = process.env.MAESTRO_CUE_WEBHOOK_HOST;
let registrationCount = 0;

function restore(name: 'MAESTRO_CUE_WEBHOOK_PORT' | 'MAESTRO_CUE_WEBHOOK_HOST', value?: string) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
	delete process.env.MAESTRO_CUE_WEBHOOK_HOST;
	resetCueWebhookServerForTests();
	spied.createServer.mockClear();
});

afterEach(() => {
	resetCueWebhookServerForTests();
	setListenerAuthority(null);
	restore('MAESTRO_CUE_WEBHOOK_PORT', originalPort);
	restore('MAESTRO_CUE_WEBHOOK_HOST', originalHost);
});

function register() {
	const deliveries: CueWebhookDelivery[] = [];
	const onLog = vi.fn();
	const unregister = registerCueWebhook({
		id: `session-1:hook-${++registrationCount}`,
		path: 'my-hook',
		secret: 's3cret',
		onDelivery: (delivery) => deliveries.push(delivery),
		onLog,
	});
	return { deliveries, onLog, unregister };
}

async function waitForBoundPort(ms = 2000): Promise<string> {
	const deadline = Date.now() + ms;
	while (/:0\/cue\//.test(buildCueWebhookUrl('my-hook'))) {
		if (Date.now() > deadline) throw new Error('the webhook listener never reported a bound port');
		await new Promise((r) => setTimeout(r, 5));
	}
	return buildCueWebhookUrl('my-hook');
}

function post(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method: 'POST',
				agent: false,
				headers: {
					'content-type': 'application/json',
					'x-maestro-cue-secret': 's3cret',
					'x-github-delivery': `delivery-${Date.now()}`,
				},
			},
			(res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode ?? 0));
			}
		);
		req.on('error', reject);
		req.end('{"hello":"world"}');
	});
}

describe('the Cue webhook listener under the listener ceiling', () => {
	it('never calls createServer when the ceiling refuses the kind, logs the line once, and stays held', () => {
		const denied = denyingListenerAuthority('kind-denied');
		setListenerAuthority(denied.authority);

		const first = register();
		expect(spied.createServer).not.toHaveBeenCalled();
		expect(first.onLog).toHaveBeenCalledTimes(1);
		expect(first.onLog.mock.calls[0][0]).toBe('warn');
		expect(first.onLog.mock.calls[0][1]).toMatch(
			/^\[CUE\] webhook listener is not opened: \[managed-kind-denied\] /
		);
		expect(denied.requests).toEqual([{ kind: 'cue-webhook', bind: '127.0.0.1', port: 0 }]);
		expect(getCueWebhookListenerHold()).toMatchObject({
			kind: 'cue-webhook',
			bind: '127.0.0.1',
			port: 0,
			reach: 'loopback',
			code: 'kind-denied',
		});
		expect(heldListeners()).toMatchObject([{ kind: 'cue-webhook', code: 'kind-denied', count: 1 }]);

		// Sticky like a failed bind: a second registration asks nothing and logs nothing.
		const second = register();
		expect(denied.requests).toHaveLength(1);
		expect(second.onLog).not.toHaveBeenCalled();
		expect(spied.createServer).not.toHaveBeenCalled();

		first.unregister();
		second.unregister();
		expect(spied.createServer).not.toHaveBeenCalled();
		expect(getCueWebhookListenerHold()).not.toBeNull();
	});

	it('a ceiling that lists cue-webhook at loopback binds the default host and takes a delivery', async () => {
		const managed = managedListenerAuthority([{ kind: 'cue-webhook', reach: 'loopback' }]);
		setListenerAuthority(managed.authority);

		const { deliveries, onLog } = register();
		expect(spied.createServer).toHaveBeenCalledTimes(1);
		expect(managed.requests).toEqual([{ kind: 'cue-webhook', bind: '127.0.0.1', port: 0 }]);
		expect(getCueWebhookListenerHold()).toBeNull();
		expect(heldListeners()).toEqual([]);

		const url = await waitForBoundPort();
		expect(await post(url)).toBe(202);
		expect(deliveries).toHaveLength(1);
		expect(onLog.mock.calls.some(([level]) => level === 'warn')).toBe(false);
	});

	it('the same ceiling refuses an every-interface bind reach-denied, with no socket', () => {
		const managed = managedListenerAuthority([{ kind: 'cue-webhook', reach: 'loopback' }]);
		setListenerAuthority(managed.authority);
		process.env.MAESTRO_CUE_WEBHOOK_HOST = '0.0.0.0';

		const { onLog } = register();
		expect(spied.createServer).not.toHaveBeenCalled();
		expect(managed.requests).toEqual([{ kind: 'cue-webhook', bind: '0.0.0.0', port: 0 }]);
		expect(getCueWebhookListenerHold()).toMatchObject({
			bind: '0.0.0.0',
			reach: 'any',
			code: 'reach-denied',
		});
		expect(onLog.mock.calls[0][1]).toMatch(/\[managed-reach-denied\] /);
	});

	it('an enrolled host with nothing listed refuses the kind by name', () => {
		const source = managedListenerAuthority([]);
		setListenerAuthority(source.authority);
		register();
		expect(spied.createServer).not.toHaveBeenCalled();
		expect(getCueWebhookListenerHold()).toMatchObject({ code: 'kind-denied' });
	});

	it('standalone, with no authority installed, binds and takes a delivery as before', async () => {
		const { deliveries } = register();
		expect(spied.createServer).toHaveBeenCalledTimes(1);
		expect(getCueWebhookListenerHold()).toBeNull();
		const url = await waitForBoundPort();
		expect(await post(url)).toBe(202);
		expect(deliveries).toHaveLength(1);
		expect(heldListeners()).toEqual([]);
	});

	it('a reset clears the hold with the rest of the listener state', () => {
		setListenerAuthority(denyingListenerAuthority('unavailable').authority);
		register();
		expect(getCueWebhookListenerHold()).not.toBeNull();
		resetCueWebhookServerForTests();
		expect(getCueWebhookListenerHold()).toBeNull();
	});
});
