/**
 * The connect service (MSX-02-01). A fake ConnectPort, defined in this file
 * only, stands in for the Mega adapter. What is defended: input is checked
 * before the port sees it; with no port the service refuses
 * endpoint_connect_unavailable; the approval page opens only over https, only
 * on the server the request went to, and only when the local-effects hold
 * allows it; the poll runs every 3 seconds while a request is open and every
 * 60 seconds otherwise; waiting to connected notifies once; and the log never
 * receives the matching number, the request reference or the approval URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpy } = vi.hoisted(() => ({ logSpy: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: (...args: unknown[]) => logSpy('info', ...args),
		warn: (...args: unknown[]) => logSpy('warn', ...args),
		error: (...args: unknown[]) => logSpy('error', ...args),
		debug: (...args: unknown[]) => logSpy('debug', ...args),
	},
}));

import {
	CONNECT_POLL_IDLE_MS,
	CONNECT_POLL_WAITING_MS,
	approvalUrlMatchesServer,
	createConnectService,
	parseConnectStartInput,
	type ConnectServiceDeps,
} from '../../../main/enterprise/connect';
import type {
	LocalEffectActor,
	LocalEffectAuthority,
	LocalEffectRequest,
} from '../../../main/enterprise/local-effects-policy';
import type {
	ConnectPort,
	ConnectStartInput,
	ConnectStartResult,
	ConnectStatusResult,
} from '../../../shared/megaConnect/port';
import type { MegaConnectStatus } from '../../../shared/megaConnect/view';

const ACTOR: LocalEffectActor = { kind: 'plugin', pluginId: 'test' };
const APPROVAL_URL = 'https://mega.acme.com/connect/approve?n=8c1f2e';
const MATCH_NUMBER = '47';
const REQUEST = 1042;

interface FakePort extends ConnectPort {
	starts: ConnectStartInput[];
	disconnects: number;
	statusCalls: number;
	setStatus(status: MegaConnectStatus): void;
}

function fakePort(start: Partial<ConnectStartResult> = {}): FakePort {
	let current: ConnectStatusResult = { status: { kind: 'notConnected' } };
	const port: FakePort = {
		starts: [],
		disconnects: 0,
		statusCalls: 0,
		async start(input) {
			port.starts.push(input);
			current = { status: { kind: 'waiting', request: REQUEST } };
			return {
				requestNumber: REQUEST,
				approvalUrl: APPROVAL_URL,
				number: MATCH_NUMBER,
				server: 'mega.acme.com',
				tenantDisplayName: 'Acme',
				...start,
			};
		},
		async status() {
			port.statusCalls += 1;
			return current;
		},
		async disconnect() {
			port.disconnects += 1;
			current = { status: { kind: 'notConnected' } };
		},
		setStatus(status) {
			current = { status };
		},
	};
	return port;
}

function allowAll(): LocalEffectAuthority & { requests: LocalEffectRequest[] } {
	const requests: LocalEffectRequest[] = [];
	return {
		requests,
		async authorize(request) {
			requests.push(request);
			return { allowed: true };
		},
	};
}

function denyAll(): LocalEffectAuthority {
	return {
		async authorize(request) {
			return {
				allowed: false,
				code: 'denied',
				message: 'denied in test',
				managed: {
					policyRevision: 1,
					class: 'data-transfer',
					effect: request.effect,
					actor: 'test',
					target: null,
					count: 1,
					outcome: 'denied',
				},
			};
		},
	};
}

function setup(overrides: Partial<ConnectServiceDeps> = {}) {
	const notify = vi.fn();
	const openExternal = vi.fn(async () => {});
	const port = fakePort();
	const localEffects = allowAll();
	const service = createConnectService({
		port,
		localEffects,
		notify,
		openExternal,
		...overrides,
	});
	return { service, port, notify, openExternal, localEffects };
}

/** Flush the microtasks a resolved poll chains on. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	logSpy.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('parseConnectStartInput', () => {
	it('accepts each kind with its validated values', () => {
		expect(parseConnectStartInput({ kind: 'email', email: ' Alice@Acme.COM ' })).toEqual({
			ok: true,
			value: { kind: 'email', email: 'alice@acme.com' },
		});
		expect(
			parseConnectStartInput({
				kind: 'teamCode',
				teamCode: 'acme-web-7k3m0',
				server: 'Mega.Acme.com',
			})
		).toEqual({
			ok: true,
			value: { kind: 'teamCode', teamCode: 'ACME-WEB-7K3M0', server: 'mega.acme.com' },
		});
		const link = parseConnectStartInput({
			kind: 'joinLink',
			joinLink:
				'https://mega.acme.com/join/0123456789ABCDEFGHJKMNPQRS#pin=abababababababababababababababababababababababababababababababab',
		});
		expect(link.ok && link.value.kind === 'joinLink' && link.value.joinLink.host).toBe(
			'mega.acme.com'
		);
		expect(parseConnectStartInput({ kind: 'managed' })).toEqual({
			ok: true,
			value: { kind: 'managed' },
		});
	});

	it('refuses a malformed input by reason, never by value', () => {
		const bad = parseConnectStartInput({ kind: 'email', email: 'not-an-email' });
		expect(bad).toEqual({ ok: false, reason: 'badEmail' });
		expect(JSON.stringify(bad)).not.toContain('not-an-email');
		expect(parseConnectStartInput(null)).toEqual({ ok: false, reason: 'empty' });
		expect(parseConnectStartInput({ kind: 'other' })).toEqual({ ok: false, reason: 'empty' });
		expect(parseConnectStartInput({ kind: 'teamCode', teamCode: 'ACME-WEB-7K3M0' })).toEqual({
			ok: false,
			reason: 'empty',
		});
	});
});

describe('approvalUrlMatchesServer', () => {
	it('allows only https on the request server', () => {
		expect(approvalUrlMatchesServer(APPROVAL_URL, 'mega.acme.com', null)).toBe(true);
		expect(approvalUrlMatchesServer(APPROVAL_URL, 'MEGA.acme.com', 'mega.acme.com')).toBe(true);
		expect(approvalUrlMatchesServer('http://mega.acme.com/x', 'mega.acme.com', null)).toBe(false);
		expect(approvalUrlMatchesServer('https://evil.example/x', 'mega.acme.com', null)).toBe(false);
		expect(approvalUrlMatchesServer('https://u:p@mega.acme.com/x', 'mega.acme.com', null)).toBe(
			false
		);
		expect(approvalUrlMatchesServer('not a url', 'mega.acme.com', null)).toBe(false);
		// The endpoint answered for a different server than the one the person named.
		expect(approvalUrlMatchesServer(APPROVAL_URL, 'mega.acme.com', 'mega.other.com')).toBe(false);
	});
});

describe('createConnectService', () => {
	it('starts a request, opens the approval page through the hold, and shows the number', async () => {
		const { service, port, openExternal, localEffects } = setup();
		const result = await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		expect(result.ok).toBe(true);
		expect(port.starts).toEqual([{ kind: 'email', email: 'alice@acme.com' }]);
		expect(localEffects.requests).toEqual([
			{ effect: 'open-external', actor: ACTOR, target: APPROVAL_URL },
		]);
		expect(openExternal).toHaveBeenCalledWith(APPROVAL_URL);
		expect(result.ok && result.value.status).toEqual({
			kind: 'browserOpened',
			matchNumber: MATCH_NUMBER,
			request: REQUEST,
			serverName: 'mega.acme.com',
		});
		service.dispose();
	});

	it('refuses an approval page off the request server and opens nothing', async () => {
		const notify = vi.fn();
		const openExternal = vi.fn(async () => {});
		const localEffects = allowAll();
		const service = createConnectService({
			port: fakePort({ approvalUrl: 'https://evil.example/approve' }),
			localEffects,
			notify,
			openExternal,
		});
		const result = await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		expect(result).toEqual({ ok: false, refusal: 'pin_mismatch' });
		expect(localEffects.requests).toEqual([]);
		expect(openExternal).not.toHaveBeenCalled();

		const http = createConnectService({
			port: fakePort({ approvalUrl: 'http://mega.acme.com/approve' }),
			localEffects,
			notify,
			openExternal,
		});
		expect(await http.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR)).toEqual({
			ok: false,
			refusal: 'pin_mismatch',
		});

		// A join link names its server: an endpoint that answers for another refuses.
		const elsewhere = createConnectService({
			port: fakePort(),
			localEffects,
			notify,
			openExternal,
		});
		expect(
			await elsewhere.start(
				{
					kind: 'joinLink',
					joinLink:
						'https://mega.other.com/join/0123456789ABCDEFGHJKMNPQRS#pin=abababababababababababababababababababababababababababababababab',
				},
				ACTOR
			)
		).toEqual({ ok: false, refusal: 'pin_mismatch' });
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('opens nothing when the local-effects hold denies it', async () => {
		const { service, openExternal } = setup({ localEffects: denyAll() });
		const result = await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		expect(result).toEqual({ ok: false, refusal: 'open_refused' });
		expect(openExternal).not.toHaveBeenCalled();
	});

	it('refuses a malformed input before the port sees it', async () => {
		const { service, port } = setup();
		const result = await service.start({ kind: 'email', email: 'nope' }, ACTOR);
		expect(result).toEqual({ ok: false, refusal: 'invalid_input', reason: 'badEmail' });
		expect(port.starts).toEqual([]);
	});

	it('polls every 3 seconds while waiting and notifies waiting to connected once', async () => {
		const { service, port, notify } = setup();
		const changes: string[] = [];
		service.onChange((view) => changes.push(view.status.kind));
		await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		port.statusCalls = 0;

		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		await flush();
		expect(port.statusCalls).toBe(1);
		expect(service.current().status.kind).toBe('waiting');

		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		expect(port.statusCalls).toBe(2);

		port.setStatus({ kind: 'connected', orgName: 'Acme', teamPath: 'platform/web' });
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		await flush();
		expect(service.current().status.kind).toBe('connected');
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatchObject({
			transition: 'waitingToConnected',
			title: 'Connected to Acme',
		});

		// Connected: the poll slows to once a minute, and the same status notifies nothing more.
		port.statusCalls = 0;
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS * 3);
		expect(port.statusCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_IDLE_MS);
		await flush();
		expect(port.statusCalls).toBe(1);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(changes).toEqual(['browserOpened', 'waiting', 'connected']);
		service.dispose();
	});

	it('notifies a denial', async () => {
		const { service, port, notify } = setup();
		await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		port.setStatus({ kind: 'denied' });
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		await flush();
		expect(service.current().status.kind).toBe('denied');
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0][0]).toMatchObject({ transition: 'waitingToDenied' });
		service.dispose();
	});

	it('disconnects through the port', async () => {
		const { service, port } = setup();
		port.setStatus({ kind: 'connected', orgName: 'Acme' });
		await service.status();
		const result = await service.disconnect();
		expect(port.disconnects).toBe(1);
		expect(result).toEqual({ ok: true, value: { status: { kind: 'notConnected' } } });
		service.dispose();
	});

	it('refuses endpoint_connect_unavailable with no port', async () => {
		const { service } = setup({ port: null });
		expect(service.current().status.kind).toBe('unavailable');
		expect(await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR)).toEqual({
			ok: false,
			refusal: 'endpoint_connect_unavailable',
		});
		expect(await service.disconnect()).toEqual({
			ok: false,
			refusal: 'endpoint_connect_unavailable',
		});
		expect((await service.status()).status.kind).toBe('unavailable');

		// A port bound later through the getter is used from then on.
		let bound: ConnectPort | null = null;
		const late = createConnectService({
			port: () => bound,
			localEffects: allowAll(),
			notify: vi.fn(),
			openExternal: vi.fn(async () => {}),
		});
		bound = fakePort();
		expect((await late.start({ kind: 'managed' }, ACTOR)).ok).toBe(true);
		late.dispose();
	});

	it('answers unavailable when a poll fails', async () => {
		const port = fakePort();
		port.status = async () => {
			throw new Error(`socket /tmp/mega.sock request ${REQUEST}`);
		};
		const { service } = setup({ port });
		expect((await service.status()).status.kind).toBe('unavailable');
	});

	it('never logs the number, the request reference or the approval URL', async () => {
		const { service, port } = setup();
		await service.start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		port.setStatus({ kind: 'connected', orgName: 'Acme' });
		await vi.advanceTimersByTimeAsync(CONNECT_POLL_WAITING_MS);
		await flush();
		await service.disconnect();
		await createConnectService({
			port: fakePort({ approvalUrl: 'https://evil.example/approve' }),
			localEffects: allowAll(),
			notify: vi.fn(),
			openExternal: vi.fn(async () => {}),
		}).start({ kind: 'email', email: 'alice@acme.com' }, ACTOR);
		service.dispose();

		expect(logSpy).toHaveBeenCalled();
		const logged = JSON.stringify(logSpy.mock.calls);
		expect(logged).not.toContain(APPROVAL_URL);
		expect(logged).not.toContain('mega.acme.com/connect');
		expect(logged).not.toContain('evil.example');
		expect(logged).not.toContain(String(REQUEST));
		expect(logged).not.toContain(`"${MATCH_NUMBER}"`);
		expect(logged).not.toContain('alice@acme.com');
	});
});
