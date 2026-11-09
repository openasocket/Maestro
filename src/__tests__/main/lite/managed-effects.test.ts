/**
 * The Lite pairing transport under the managed egress ceiling (MCOMP-21-15).
 *
 * A pairing request to a Lite host on the LAN or the tailnet is held as the
 * `lite-peer` egress class before its destination is resolved and again
 * after that await, right before the socket (MCOMP-21-12A). These cases
 * revoke the ceiling between the two holds and prove no request is ever
 * sent; a refusal up front proves the destination is never even resolved
 * (no interface bind, no Tailscale status read); and the allowed and
 * standalone equivalents prove the same request still goes out.
 *
 * The real chokepoint (`holdEgress`) and the real verdict (`egressVerdict`)
 * run here; only the destination resolvers and the socket are doubles, so a
 * refusal is proven by the absence of a send.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
	lanDestination: vi.fn(),
	tailnetDestination: vi.fn(),
}));

vi.mock('../../../main/lite/lan', async (original) => ({
	...(await original<typeof import('../../../main/lite/lan')>()),
	lanDestination: fixture.lanDestination,
}));

vi.mock('../../../main/lite/tailnet', async (original) => ({
	...(await original<typeof import('../../../main/lite/tailnet')>()),
	tailnetDestination: fixture.tailnetDestination,
}));

import { LITE_PEER_EGRESS_CLASS, pairingTransport } from '../../../main/lite/pairing/transport';
import { PAIR_PATH, type Route } from '../../../main/lite/pairing/protocol';
import { isEgressDeniedError, setEgressAuthority } from '../../../main/utils/fetchWithTimeout';
import {
	egressVerdict,
	managedEgressStanding,
	parseEgressPolicyCeiling,
	type EgressPolicyCeiling,
	type EgressRequest,
} from '../../../main/enterprise/egress-policy';

const LAN_ENDPOINT = 'http://192.168.20.10:56036';
const TAILNET_ENDPOINT = 'http://100.100.1.2:56036';

function ceilingOf(classes: unknown[]): EgressPolicyCeiling {
	const parsed = parseEgressPolicyCeiling({ policyRevision: 3, classes });
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

/** A ceiling admitting Lite peers anywhere, and one that names no Lite peer at all. */
const ADMITS_PEERS = ceilingOf([{ class: LITE_PEER_EGRESS_CLASS, destinations: ['*'] }]);
const NO_PEERS = ceilingOf([{ class: 'content', destinations: ['*'] }]);

/** Every egress request the chokepoint evaluated, and the ceiling it is evaluated against now. */
const evaluated: EgressRequest[] = [];
let installed: EgressPolicyCeiling | null = ADMITS_PEERS;

function manage(): void {
	setEgressAuthority({
		evaluateEgress: (request) => {
			evaluated.push(request);
			const standing = managedEgressStanding({
				enrolled: true,
				policy: { appliedRevision: 3 },
				ceiling: installed,
			});
			return egressVerdict(standing, request);
		},
	});
}

/** A socket double: answers 200 with `body`, and records every request it was asked to open. */
function socket(body: unknown = { ok: true }) {
	const sent: Array<{ url: string; options: Record<string, unknown>; data: unknown }> = [];
	const send = vi.fn((url: string, options: Record<string, unknown>, onResponse: any) => {
		const req = new EventEmitter() as EventEmitter & {
			end(data: string): void;
			destroy(error?: Error): void;
		};
		req.destroy = (error?: Error) => {
			if (error) req.emit('error', error);
			req.emit('close');
		};
		req.end = (data: string) => {
			sent.push({ url, options, data: JSON.parse(data) });
			const res = new EventEmitter() as EventEmitter & { statusCode: number };
			res.statusCode = 200;
			onResponse(res);
			res.emit('data', Buffer.from(JSON.stringify(body)));
			res.emit('end');
			req.emit('close');
		};
		return req;
	});
	return { send, sent };
}

const routes: Array<{
	name: string;
	route: Route;
	destination: () => ReturnType<typeof vi.fn>;
	bound: Record<string, unknown>;
}> = [
	{
		name: 'LAN',
		route: { endpoint: LAN_ENDPOINT, source: 'lan' },
		destination: () => fixture.lanDestination,
		bound: { hostname: '192.168.20.10', port: 56036, localAddress: '192.168.20.5' },
	},
	{
		name: 'tailnet',
		route: { endpoint: TAILNET_ENDPOINT, source: 'tailscale', peerId: 'node-1' },
		destination: () => fixture.tailnetDestination,
		bound: { hostname: '100.100.1.2', port: 56036, localAddress: '100.100.1.1', peerId: 'node-1' },
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	evaluated.length = 0;
	installed = ADMITS_PEERS;
	setEgressAuthority(null);
});

afterEach(() => {
	setEgressAuthority(null);
});

describe.each(routes)('the $name pairing transport under the egress ceiling', (entry) => {
	const origin = entry.route.endpoint;

	beforeEach(() => {
		entry.destination().mockResolvedValue(entry.bound);
	});

	it('standalone: resolves the destination and sends, with nothing evaluated', async () => {
		const { send, sent } = socket({ challenge: 'c1' });
		const transport = pairingTransport(entry.route, send as never);

		await expect(transport.call('challenge', { n: 1 })).resolves.toEqual({ challenge: 'c1' });

		expect(evaluated).toEqual([]);
		expect(entry.destination()).toHaveBeenCalledTimes(1);
		expect(sent).toHaveLength(1);
		expect(sent[0].url).toBe(`${origin}${PAIR_PATH}/challenge`);
	});

	it('allowed: held as lite-peer before and after the destination await, then sent on the bound interface', async () => {
		manage();
		const { send, sent } = socket({ challenge: 'c1' });
		const transport = pairingTransport(entry.route, send as never);

		await expect(transport.call('challenge', { n: 1 })).resolves.toEqual({ challenge: 'c1' });

		expect(evaluated).toEqual([
			{ url: origin, class: LITE_PEER_EGRESS_CLASS },
			{ url: origin, class: LITE_PEER_EGRESS_CLASS },
		]);
		expect(sent).toHaveLength(1);
		expect(sent[0].options).toMatchObject({
			localAddress: entry.bound.localAddress,
			method: 'POST',
		});
		expect(sent[0].data).toEqual({ route: entry.route, payload: { n: 1 } });
	});

	it('refused up front: the destination is never resolved and nothing is sent', async () => {
		installed = NO_PEERS;
		manage();
		const { send } = socket();
		const transport = pairingTransport(entry.route, send as never);

		const error = await transport.call('challenge', {}).catch((e: unknown) => e);

		expect(isEgressDeniedError(error)).toBe(true);
		expect((error as Error).message).toMatch(
			/^\[managed-class-denied\] the egress ceiling admits no lite-peer request/
		);
		expect(evaluated).toHaveLength(1);
		expect(entry.destination()).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it('revoked while the destination resolved: refused at the second hold, nothing is sent', async () => {
		manage();
		entry.destination().mockImplementation(async () => {
			installed = null;
			return entry.bound;
		});
		const { send } = socket();
		const transport = pairingTransport(entry.route, send as never);

		const error = await transport.call('challenge', {}).catch((e: unknown) => e);

		// A managed refusal, never reported as a transport failure the user could retry.
		expect(isEgressDeniedError(error)).toBe(true);
		expect((error as Error).message).toMatch(/^\[managed-unavailable\]/);
		expect(evaluated).toHaveLength(2);
		expect(entry.destination()).toHaveBeenCalledTimes(1);
		expect(send).not.toHaveBeenCalled();
	});

	it('a ceiling narrowed between two calls refuses the second call by itself', async () => {
		manage();
		const { send, sent } = socket();
		const transport = pairingTransport(entry.route, send as never);

		await transport.call('challenge', {});
		installed = NO_PEERS;
		const error = await transport.call('confirm', {}).catch((e: unknown) => e);

		expect(isEgressDeniedError(error)).toBe(true);
		expect(sent).toHaveLength(1);
		expect(entry.destination()).toHaveBeenCalledTimes(1);
	});
});
