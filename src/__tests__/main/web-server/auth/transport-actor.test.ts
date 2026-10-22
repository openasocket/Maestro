/**
 * Transport admission (MRC-08-01): which transport admitted a socket, read off
 * the client the upgrade built and kept apart from the acting user. A CLI
 * secret, a Lite pairing, a Web Login cookie and the bare path token are each
 * recognized as what they are; `runAsClient` establishes both the acting user
 * and the transport for one dispatch and leaves nothing behind.
 */

import { describe, expect, it } from 'vitest';
import { getActingUser } from '../../../../main/web-server/auth/acting-user';
import {
	DESKTOP_ADMISSION,
	PAIRED_DEVICE_USER_ID_PREFIX,
	PAIRED_DEVICE_USERNAME,
	claimDispatchTicket,
	createDispatchTicketRegistry,
	describeSpawnActor,
	describeTransportAdmission,
	getActingTransport,
	issueDispatchTicket,
	resolveTransportAdmission,
	runAsClient,
	runAsTransport,
	sameSpawnActor,
	transportSpawnActor,
	withdrawDispatchTicket,
	type TransportAdmission,
} from '../../../../main/web-server/auth/transport-actor';

const ada = { id: 'u1', username: 'ada', displayName: 'Ada' };
const device = {
	id: `${PAIRED_DEVICE_USER_ID_PREFIX}dev-7`,
	username: PAIRED_DEVICE_USERNAME,
	displayName: 'Pixel 9',
};

describe('resolveTransportAdmission', () => {
	it('reads a Web Login cookie as a login, with the account attached', () => {
		expect(resolveTransportAdmission({ user: ada })).toEqual({ kind: 'web-login', user: ada });
	});

	it('reads the CLI secret as the CLI, and lets it win over a cookie it may also carry', () => {
		expect(resolveTransportAdmission({ cli: true })).toEqual({ kind: 'cli' });
		expect(resolveTransportAdmission({ cli: true, user: ada })).toEqual({ kind: 'cli' });
	});

	it('reads a device pairing as a device, never as the account the route synthesized', () => {
		expect(resolveTransportAdmission({ admission: 'device-pairing', user: device })).toEqual({
			kind: 'lite',
			deviceId: 'dev-7',
			deviceName: 'Pixel 9',
		});
	});

	it('does not infer a device from the shape of an account; the admission method decides', () => {
		// A Web Login account that happens to look like a device is a login.
		expect(resolveTransportAdmission({ user: device })).toEqual({
			kind: 'web-login',
			user: device,
		});
	});

	it('reads a socket with neither cookie nor secret as the owner the path token admits', () => {
		expect(resolveTransportAdmission({})).toEqual({ kind: 'owner-token' });
		expect(resolveTransportAdmission({ cli: false, user: undefined })).toEqual({
			kind: 'owner-token',
		});
	});
});

describe('describeTransportAdmission', () => {
	it('names the transport, and for a login or a device, which one', () => {
		expect(describeTransportAdmission({ kind: 'desktop' })).toBe('desktop');
		expect(describeTransportAdmission({ kind: 'owner-token' })).toBe('owner-token');
		expect(describeTransportAdmission({ kind: 'cli' })).toBe('cli');
		expect(describeTransportAdmission({ kind: 'web-login', user: ada })).toBe('web-login:ada');
		expect(
			describeTransportAdmission({ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' })
		).toBe('lite-device:dev-7');
	});
});

/**
 * The actor a host sink binds for a transport (MRC-08-01A): the renderer and
 * the bare path token are the owner-operator, a login is the account, the CLI
 * secret is the host secret and a pairing is the device. None of them is a
 * principal; this is what `admitSpawn()` records as attribution.
 */
describe('transportSpawnActor', () => {
	it('binds the desktop renderer and the bare path token as the owner-operator', () => {
		expect(transportSpawnActor({ kind: 'desktop' })).toEqual({ peer: 'in-process' });
		expect(transportSpawnActor({ kind: 'owner-token' })).toEqual({ peer: 'in-process' });
	});

	it('binds a Web Login as the account the cookie named', () => {
		expect(transportSpawnActor({ kind: 'web-login', user: ada })).toEqual({
			peer: 'web-login',
			username: 'ada',
		});
	});

	it('binds the CLI secret as the host secret, never as the operator at the keyboard', () => {
		expect(transportSpawnActor({ kind: 'cli' })).toEqual({ peer: 'host-secret' });
	});

	it('binds a Lite pairing as the device, never as the synthesized paired-device account', () => {
		expect(transportSpawnActor({ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' })).toEqual(
			{ peer: 'device-pairing', deviceId: 'dev-7' }
		);
		// The whole way from the client the upgrade built to the actor the sink binds.
		expect(
			transportSpawnActor(resolveTransportAdmission({ admission: 'device-pairing', user: device }))
		).toEqual({ peer: 'device-pairing', deviceId: 'dev-7' });
	});

	it('is the owner-operator outside any context, and follows the context inside one', () => {
		expect(transportSpawnActor(getActingTransport())).toEqual({ peer: 'in-process' });
		expect(runAsClient({ cli: true }, () => transportSpawnActor(getActingTransport()))).toEqual({
			peer: 'host-secret',
		});
	});
});

describe('acting transport context', () => {
	it('is the desktop outside any context', () => {
		expect(getActingTransport()).toEqual(DESKTOP_ADMISSION);
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('is visible across awaits inside the context and gone after it', async () => {
		const seen = await runAsTransport({ kind: 'cli' }, async () => {
			await Promise.resolve();
			const inner = getActingTransport();
			await new Promise((r) => setTimeout(r, 1));
			return [inner, getActingTransport()];
		});
		expect(seen).toEqual([{ kind: 'cli' }, { kind: 'cli' }]);
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('does not leak between two concurrent contexts', async () => {
		const [a, b] = await Promise.all([
			runAsTransport({ kind: 'cli' }, async () => {
				await new Promise((r) => setTimeout(r, 2));
				return getActingTransport().kind;
			}),
			runAsTransport({ kind: 'web-login', user: ada }, async () => {
				await new Promise((r) => setTimeout(r, 1));
				return getActingTransport().kind;
			}),
		]);
		expect(a).toBe('cli');
		expect(b).toBe('web-login');
	});
});

describe('runAsClient', () => {
	it('establishes the acting user and the transport together for a login', async () => {
		const seen = await runAsClient({ user: ada }, async () => {
			await Promise.resolve();
			return { user: getActingUser(), transport: getActingTransport() };
		});
		expect(seen).toEqual({ user: ada, transport: { kind: 'web-login', user: ada } });
		expect(getActingUser()).toBeUndefined();
		expect(getActingTransport().kind).toBe('desktop');
	});

	it('keeps the synthesized device account for attribution while the transport says device', () => {
		const seen = runAsClient({ admission: 'device-pairing', user: device }, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		// History and stats still name the device; a sink sees a pairing, not a login.
		expect(seen.user).toEqual(device);
		expect(seen.transport).toEqual({ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' });
	});

	it('gives the CLI no acting user and the CLI transport', () => {
		const seen = runAsClient({ cli: true }, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		expect(seen).toEqual({ user: undefined, transport: { kind: 'cli' } });
	});

	it('gives a bare socket no acting user and the owner-token transport', () => {
		const seen = runAsClient({}, () => ({
			user: getActingUser(),
			transport: getActingTransport(),
		}));
		expect(seen).toEqual({ user: undefined, transport: { kind: 'owner-token' } });
	});
});

/**
 * Dispatch tickets (MRC-08-01B): the host-minted, single-use, bounded key a
 * WebSocket dispatch carries across the renderer round trip so the spawn sink
 * can bind the transport that sent it. The ticket names no actor; the registry
 * does. Anything but a fresh, unexpired ticket claimed for the agent and tab it
 * was issued for is worth nothing.
 */
describe('dispatch tickets', () => {
	const cli: TransportAdmission = { kind: 'cli' };
	const lite: TransportAdmission = { kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' };

	function registry(opts: { ttlMs?: number; maxOutstanding?: number } = {}) {
		let at = 1_000;
		const reg = createDispatchTicketRegistry({ now: () => at, ...opts });
		return { reg, advance: (ms: number) => void (at += ms) };
	}

	it('issues an opaque ticket that claims back the admission it was issued for, once', () => {
		const { reg } = registry();
		const ticket = reg.issue(cli, { agentId: 'agent-1', tabId: 'tab-1' });
		expect(typeof ticket).toBe('string');
		expect(ticket).not.toContain('cli');
		expect(reg.size).toBe(1);

		expect(reg.claim(ticket, { agentId: 'agent-1', tabId: 'tab-1' })).toEqual(cli);
		// Spent: a second claim, however well-formed, gets nothing.
		expect(reg.claim(ticket, { agentId: 'agent-1', tabId: 'tab-1' })).toBeUndefined();
		expect(reg.size).toBe(0);
	});

	it('two tickets for the same dispatch are distinct and each stands only for itself', () => {
		const { reg } = registry();
		const a = reg.issue(cli, { agentId: 'agent-1' });
		const b = reg.issue(lite, { agentId: 'agent-1' });
		expect(a).not.toBe(b);
		expect(reg.claim(b, { agentId: 'agent-1' })).toEqual(lite);
		expect(reg.claim(a, { agentId: 'agent-1' })).toEqual(cli);
	});

	it('claims nothing for another agent, and burns the ticket', () => {
		const { reg } = registry();
		const ticket = reg.issue(cli, { agentId: 'agent-1', tabId: 'tab-1' });
		expect(reg.claim(ticket, { agentId: 'agent-2', tabId: 'tab-1' })).toBeUndefined();
		// The mismatch spent it: the right claimant is too late now.
		expect(reg.claim(ticket, { agentId: 'agent-1', tabId: 'tab-1' })).toBeUndefined();
	});

	it('claims nothing for another tab of the right agent when a tab was named', () => {
		const { reg } = registry();
		const ticket = reg.issue(cli, { agentId: 'agent-1', tabId: 'tab-1' });
		expect(reg.claim(ticket, { agentId: 'agent-1', tabId: 'tab-2' })).toBeUndefined();
		const tabless = reg.issue(cli, { agentId: 'agent-1', tabId: 'tab-1' });
		expect(reg.claim(tabless, { agentId: 'agent-1' })).toBeUndefined();
	});

	it('a ticket issued with no tab (the active tab) claims for whichever tab the renderer picked', () => {
		const { reg } = registry();
		const ticket = reg.issue(lite, { agentId: 'agent-1' });
		expect(reg.claim(ticket, { agentId: 'agent-1', tabId: 'tab-9' })).toEqual(lite);
	});

	it('expires: a ticket older than the TTL claims nothing and is swept', () => {
		const { reg, advance } = registry({ ttlMs: 1_000 });
		const ticket = reg.issue(cli, { agentId: 'agent-1' });
		advance(999);
		expect(reg.size).toBe(1);
		advance(1);
		expect(reg.size).toBe(0);
		expect(reg.claim(ticket, { agentId: 'agent-1' })).toBeUndefined();
	});

	it('is bounded: past the cap the oldest unclaimed ticket is dropped, never the newest', () => {
		const { reg } = registry({ maxOutstanding: 2 });
		const first = reg.issue(cli, { agentId: 'agent-1' });
		const second = reg.issue(cli, { agentId: 'agent-2' });
		const third = reg.issue(lite, { agentId: 'agent-3' });
		expect(reg.size).toBe(2);
		expect(reg.claim(first, { agentId: 'agent-1' })).toBeUndefined();
		expect(reg.claim(second, { agentId: 'agent-2' })).toEqual(cli);
		expect(reg.claim(third, { agentId: 'agent-3' })).toEqual(lite);
	});

	it('withdraws a ticket whose dispatch the renderer refused', () => {
		const { reg } = registry();
		const ticket = reg.issue(cli, { agentId: 'agent-1' });
		expect(reg.withdraw(ticket)).toBe(true);
		expect(reg.withdraw(ticket)).toBe(false);
		expect(reg.claim(ticket, { agentId: 'agent-1' })).toBeUndefined();
	});

	it('an invented ticket claims nothing from the host registry', () => {
		expect(claimDispatchTicket('not-a-ticket', { agentId: 'agent-1' })).toBeUndefined();
		expect(claimDispatchTicket('', { agentId: 'agent-1' })).toBeUndefined();
	});

	it('the host registry: issued inside a client context, claimed outside any (the IPC hop)', async () => {
		const ticket = runAsClient({ cli: true }, () =>
			issueDispatchTicket(getActingTransport(), { agentId: 'agent-1', tabId: 'tab-1' })
		);
		await Promise.resolve();
		expect(getActingTransport()).toEqual(DESKTOP_ADMISSION);
		const admission = claimDispatchTicket(ticket, { agentId: 'agent-1', tabId: 'tab-1' });
		expect(admission).toEqual({ kind: 'cli' });
		expect(transportSpawnActor(admission!)).toEqual({ peer: 'host-secret' });
		expect(withdrawDispatchTicket(ticket)).toBe(false);
	});
});

describe('sameSpawnActor / describeSpawnActor (MRC-08-02)', () => {
	it('matches the same caller and tells callers apart by peer, account and device', () => {
		expect(sameSpawnActor({ peer: 'in-process' }, { peer: 'in-process' })).toBe(true);
		expect(sameSpawnActor({ peer: 'host-secret' }, { peer: 'host-secret' })).toBe(true);
		expect(
			sameSpawnActor({ peer: 'web-login', username: 'ada' }, { peer: 'web-login', username: 'ada' })
		).toBe(true);
		expect(
			sameSpawnActor(
				{ peer: 'device-pairing', deviceId: 'dev-7' },
				{ peer: 'device-pairing', deviceId: 'dev-7' }
			)
		).toBe(true);

		expect(
			sameSpawnActor({ peer: 'web-login', username: 'ada' }, { peer: 'web-login', username: 'bob' })
		).toBe(false);
		expect(
			sameSpawnActor(
				{ peer: 'device-pairing', deviceId: 'dev-7' },
				{ peer: 'device-pairing', deviceId: 'dev-8' }
			)
		).toBe(false);
		expect(sameSpawnActor({ peer: 'in-process' }, { peer: 'host-secret' })).toBe(false);
		expect(sameSpawnActor({ peer: 'host-secret' }, { peer: 'web-login', username: 'ada' })).toBe(
			false
		);
		expect(
			sameSpawnActor(
				{ peer: 'web-login', username: 'ada' },
				{ peer: 'device-pairing', deviceId: 'ada' }
			)
		).toBe(false);
	});

	it('names a caller in one word', () => {
		expect(describeSpawnActor({ peer: 'in-process' })).toBe('the operator');
		expect(describeSpawnActor({ peer: 'host-secret' })).toBe('maestro-cli');
		expect(describeSpawnActor({ peer: 'web-login', username: 'ada' })).toBe('web-login:ada');
		expect(describeSpawnActor({ peer: 'device-pairing', deviceId: 'dev-7' })).toBe(
			'lite-device:dev-7'
		);
	});
});
