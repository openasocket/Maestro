/**
 * The Mega adapter for Connect (MSX-02-08), over a fake endpoint port that
 * lives in this file only. No Mega code is loaded.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	bindEndpointConnectPort,
	connectStatusOf,
	createEndpointConnectPort,
} from '../../../main/enterprise/connect-endpoint';
import type {
	EndpointInvokeOutcome,
	EndpointPort,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { resolveEndpointSocket } from '../../../shared/megaServer';

const ok = (payload: unknown): EndpointInvokeOutcome<unknown> => ({ status: 'ok', payload });

function fakeEndpoint(
	answers: Partial<Record<string, EndpointInvokeOutcome<unknown>>>,
	capabilities: readonly string[] = ['connect', 'connection_status', 'disconnect']
) {
	const invoke = vi.fn(async (operation: string, _payload: unknown) => {
		return answers[operation] ?? { status: 'denied' as const, reason: 'unauthenticated' as const };
	});
	const compatibility = vi.fn(async () =>
		ok({ outcome: 'negotiated', protocol: 2, capabilities: [...capabilities] })
	);
	const close = vi.fn(async () => undefined);
	const port = { invoke, compatibility, close } as unknown as EndpointPort;
	return { port, invoke, compatibility, close };
}

const WAITING = {
	outcome: 'waiting',
	requestNumber: 'REQ-1042',
	approvalUrl: 'https://mega.acme.com/approve/REQ-1042',
	number: '47',
	server: 'mega.acme.com',
	tenantDisplayName: 'Acme',
};

const STATUS = (state: string, extra: Record<string, unknown> = {}) => ({
	state,
	stateSeq: 3,
	stateChangedAt: '2026-11-21T10:00:00.000Z',
	names: {},
	...extra,
});

describe('createEndpointConnectPort', () => {
	it('sends only what the person typed, for each input kind', async () => {
		const fake = fakeEndpoint({ connect: ok(WAITING) });
		const port = createEndpointConnectPort(fake.port);
		await port.start({ kind: 'email', email: 'alice@acme.com' });
		await port.start({
			kind: 'joinLink',
			joinLink: { url: 'https://mega.acme.com/join/abc', host: 'mega.acme.com', code: 'abc' },
		});
		await port.start({ kind: 'teamCode', teamCode: 'TEAMCODE1', server: 'mega.acme.com' });
		await port.start({ kind: 'managed' });
		expect(fake.invoke.mock.calls).toEqual([
			['connect', { email: 'alice@acme.com' }],
			['connect', { joinLink: 'https://mega.acme.com/join/abc' }],
			['connect', { teamCode: 'TEAMCODE1', server: 'mega.acme.com' }],
			['connect', { managed: true }],
		]);
	});

	it('passes a waiting answer through as a start result', async () => {
		const port = createEndpointConnectPort(fakeEndpoint({ connect: ok(WAITING) }).port);
		await expect(port.start({ kind: 'managed' })).resolves.toEqual({
			requestNumber: 'REQ-1042',
			approvalUrl: 'https://mega.acme.com/approve/REQ-1042',
			number: '47',
			server: 'mega.acme.com',
			tenantDisplayName: 'Acme',
		});
	});

	it('throws on a refused connect, a denial and an unavailable answer', async () => {
		const refused = fakeEndpoint({ connect: ok({ outcome: 'refused', code: 'pin_mismatch' }) });
		await expect(
			createEndpointConnectPort(refused.port).start({ kind: 'managed' })
		).rejects.toThrow(/pin_mismatch/);
		const denied = fakeEndpoint({});
		await expect(createEndpointConnectPort(denied.port).disconnect()).rejects.toThrow(
			/unauthenticated/
		);
		const down = fakeEndpoint({
			connection_status: { status: 'unavailable', reason: 'malformed', message: 'x' },
		});
		await expect(createEndpointConnectPort(down.port).status()).rejects.toThrow();
	});

	it('maps connection_status to the status union with names, never IDs', async () => {
		const fake = fakeEndpoint({
			connection_status: ok(
				STATUS('connected', {
					names: {
						tenant: { handle: 'acme', displayName: 'Acme' },
						teamPath: 'platform/web',
						policy: { name: 'platform-default', revision: 12 },
						device: 'alice-mbp',
					},
				})
			),
		});
		const answer = await createEndpointConnectPort(fake.port).status();
		expect(answer).toEqual({
			status: {
				kind: 'connected',
				orgName: 'Acme',
				teamPath: 'platform/web',
				policy: { name: 'platform-default', revision: 12 },
			},
			names: { device: 'alice-mbp' },
		});
		expect(fake.invoke).toHaveBeenCalledWith('connection_status', {});
		expect(JSON.stringify(answer)).not.toMatch(/stateSeq|stateChangedAt|acme"/);
	});

	it('maps every endpoint state', () => {
		const kinds = [
			['not_connected', 'notConnected'],
			['disconnected', 'notConnected'],
			['waiting', 'waiting'],
			['approved', 'waiting'],
			['denied', 'denied'],
			['expired', 'expired'],
			['revoked', 'revoked'],
			['grant_expired', 'grantExpired'],
		] as const;
		for (const [state, kind] of kinds) {
			expect(connectStatusOf(STATUS(state) as never).kind).toBe(kind);
		}
		expect(connectStatusOf(STATUS('waiting', { request: { number: 'REQ-7' } }) as never)).toEqual({
			kind: 'waiting',
			request: 'REQ-7',
		});
	});
});

describe('bindEndpointConnectPort', () => {
	it('binds when the endpoint advertises connect and connection_status', async () => {
		const fake = fakeEndpoint({ connection_status: ok(STATUS('not_connected')) });
		const openPort = vi.fn(() => fake.port);
		const bound = await bindEndpointConnectPort({
			socket: { socketPath: '/run/me/ipc.sock', source: 'saved' },
			openPort,
		});
		expect(bound).not.toBeNull();
		expect(fake.compatibility).toHaveBeenCalledWith({
			supportedProtocols: [2],
			supportedCapabilities: ['connect', 'connection_status', 'disconnect'],
			requiredCapabilities: [],
		});
		await expect(bound!.port.status()).resolves.toEqual({ status: { kind: 'notConnected' } });
		await bound!.close();
		expect(fake.close).toHaveBeenCalled();
	});

	it('stays unbound and closes when the operations are not advertised', async () => {
		const fake = fakeEndpoint({}, ['noticeList']);
		const bound = await bindEndpointConnectPort({
			socket: { socketPath: '/run/me/ipc.sock', source: 'saved' },
			openPort: () => fake.port,
		});
		expect(bound).toBeNull();
		expect(fake.close).toHaveBeenCalled();
	});

	it('stays unbound when the endpoint cannot be asked, or no socket resolves', async () => {
		const fake = fakeEndpoint({});
		fake.compatibility.mockRejectedValueOnce(new Error('ENOENT'));
		await expect(
			bindEndpointConnectPort({
				socket: { socketPath: '/run/me/ipc.sock', source: 'saved' },
				openPort: () => fake.port,
			})
		).resolves.toBeNull();
		const openPort = vi.fn(() => fake.port);
		await expect(
			bindEndpointConnectPort({ socket: resolveEndpointSocket('', 'win32'), openPort })
		).resolves.toBeNull();
		expect(openPort).not.toHaveBeenCalled();
	});

	it('multi-account: opens only the socket this account resolved and sends no identity', async () => {
		const fake = fakeEndpoint({ connect: ok(WAITING) });
		const openPort = vi.fn(() => fake.port);
		const socket = resolveEndpointSocket('/Users/alice/endpoint.sock', 'darwin');
		const bound = await bindEndpointConnectPort({ socket, openPort });
		await bound!.port.start({ kind: 'email', email: 'alice@acme.com' });
		expect(openPort.mock.calls).toEqual([['/Users/alice/endpoint.sock']]);
		// The endpoint names the caller by native admission of this process; the payload carries none.
		const payloads = JSON.stringify(fake.invoke.mock.calls);
		expect(payloads).not.toMatch(/uid|account|user|runtimeId|installation/i);
	});
});
