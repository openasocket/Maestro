import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	createActorApprovalBridge,
	inspectProducers,
	watchForChallenge,
} from '../../../../scripts/mega-maestro-pair.mjs';

const origin = 'https://approval.invalid';
const csrf = 'isolated-csrf-canary';
let wire: typeof import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
const challenge = () => ({
	challengeId: '11111111-1111-4111-8111-111111111111',
	nonce: 'N'.repeat(43),
	challengeDigest: 'a'.repeat(64),
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

// Declared browser/service unit port. No real browser, cookie, tenant or paired
// authentication is exercised. The real pinned HTTP client constructs requests.
// Session/CSRF/replay decisions below are declared service responses, not a
// replacement implementation or evidence of the remote service's enforcement.
function browserPort() {
	const state = {
		kind: 'user',
		expiresAt: Date.now() + 60_000,
		status: 200,
		replyId: '',
		authenticated: true,
		sessionCsrf: csrf,
		consumed: new Set<string>(),
	};
	const browser = {
		origin: () => origin,
		csrf: () => csrf,
		fetch: vi.fn(async (url: URL, init: RequestInit) => {
			expect(init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
			expect(new Headers(init.headers).has('authorization')).toBe(false);
			expect(new Headers(init.headers).has('cookie')).toBe(false);
			if (url.pathname === '/api/identity/session') {
				expect(init.method).toBe('GET');
				return Response.json({ principal: { kind: state.kind }, expiresAt: state.expiresAt });
			}
			expect(url.pathname).toBe('/api/enrollment/runtime-registrations/approve');
			expect(init.method).toBe('POST');
			const body = JSON.parse(String(init.body));
			expect(
				(body.version === 2 ? wire.runtimeApprovalInputV2 : wire.runtimeApprovalInput).safeParse(
					body
				).success
			).toBe(true);
			const status =
				!state.authenticated || state.expiresAt <= Date.now()
					? 401
					: state.kind !== 'user' ||
						  new Headers(init.headers).get('x-csrf-token') !== state.sessionCsrf ||
						  state.consumed.has(body.challengeId)
						? 403
						: state.status;
			if (status === 200) state.consumed.add(body.challengeId);
			return Response.json(
				status === 200
					? { challengeId: state.replyId || body.challengeId }
					: { error: { code: `secret-${csrf}-${body.nonce}` } },
				{ status }
			);
		}),
	};
	return { browser, state };
}

beforeAll(async () => {
	// The production bridge verifies the archive pin/payload before loading code.
	await createActorApprovalBridge({ browser: browserPort().browser, origin });
	wire = await import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});
describe('owned actor approval bridge (local contract evidence only)', () => {
	it('uses the pinned browser/CSRF API once and emits no execution authority', async () => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(bridge.input).toMatchObject({ protocol: 1, authority: 'none', paired: false });
		const input = challenge();
		expect(await bridge.approve(input)).toEqual({ outcome: 'approved' });
		expect(await bridge.approve(input)).toEqual({ outcome: 'denied' });
		expect(browser.fetch).toHaveBeenCalledTimes(2);
		const [url, init] = browser.fetch.mock.calls[1];
		expect(url.href).toBe(`${origin}/api/enrollment/runtime-registrations/approve`);
		expect(new Headers(init.headers).get('x-csrf-token')).toBe(csrf);
		expect(JSON.parse(String(init.body))).toEqual({
			challengeId: input.challengeId,
			nonce: input.nonce,
			challengeDigest: input.challengeDigest,
		});
		expect(JSON.stringify(bridge.input)).not.toContain(input.nonce);
	});

	it.each(['session', 'csrf', 'expiry', 'principal'])(
		'honors service refusal when %s changes after the session read',
		async (fault) => {
			const { browser, state } = browserPort();
			const fetch = browser.fetch.getMockImplementation()!;
			browser.fetch.mockImplementation(async (url, init) => {
				const response = await fetch(url, init);
				if (init.method === 'GET') {
					if (fault === 'session') state.authenticated = false;
					if (fault === 'csrf') state.sessionCsrf = 'different-session-csrf';
					if (fault === 'expiry') state.expiresAt = 0;
					if (fault === 'principal') state.kind = 'service';
				}
				return response;
			});
			const bridge = await createActorApprovalBridge({ browser, origin });
			const input = challenge();
			expect(await bridge.approve(input)).toEqual({ outcome: 'denied' });
			expect(await bridge.approve(input)).toEqual({ outcome: 'denied' });
			expect(browser.fetch.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'POST']);
			expect(state.consumed.size).toBe(0);
		}
	);

	it('fences concurrent bridge use and preserves a service replay refusal on a new bridge', async () => {
		const { browser, state } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		const input = challenge();
		expect(await Promise.all([bridge.approve(input), bridge.approve(input)])).toEqual([
			{ outcome: 'approved' },
			{ outcome: 'denied' },
		]);
		expect(browser.fetch).toHaveBeenCalledTimes(2);
		const second = await createActorApprovalBridge({ browser, origin });
		expect(await second.approve(input)).toEqual({ outcome: 'denied' });
		expect(state.consumed).toEqual(new Set([input.challengeId]));
		expect(browser.fetch).toHaveBeenCalledTimes(4);
	});

	it.each(['runtime_use', 'fleet_management'] as const)(
		'approves a valid public v2 %s challenge and keeps its purpose and version in the body',
		async (purpose) => {
			const { browser } = browserPort();
			const bridge = await createActorApprovalBridge({ browser, origin });
			const { expiresAt, ...body } = challenge();
			const v2 = { ...body, version: 2, purpose };
			expect(wire.runtimeApprovalInputV2.safeParse(v2).success).toBe(true);
			expect(wire.runtimeApprovalInput.safeParse(v2).success).toBe(false);
			expect(await bridge.approve({ ...v2, expiresAt })).toEqual({ outcome: 'approved' });
			const [, init] = browser.fetch.mock.calls[browser.fetch.mock.calls.length - 1];
			expect(JSON.parse(String(init.body))).toEqual({ ...body, version: 2, purpose });
		}
	);

	it.each([false, true])('fences a late response after cancellation (POST=%s)', async (post) => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		const fetch = browser.fetch.getMockImplementation()!;
		const controller = new AbortController();
		let release!: () => void;
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		browser.fetch.mockImplementation(async (url, init) => {
			if ((init.method === 'POST') === post) {
				await new Promise<void>((resolve) => {
					release = resolve;
					entered();
				});
			}
			return fetch(url, init);
		});
		const input = challenge();
		const pending = bridge.approve(input, { signal: controller.signal });
		await waiting;
		controller.abort('abort-secret-canary');
		expect(await pending).toEqual({ outcome: post ? 'unknown' : 'unavailable' });
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await bridge.approve(input)).toEqual({ outcome: 'denied' });
		expect(browser.fetch).toHaveBeenCalledTimes(post ? 2 : 1);
		expect(browser.fetch.mock.calls.at(-1)![1].signal?.aborted).toBe(true);
	});

	it.each(['http', 'transport', 'json'])(
		'keeps %s failure canaries out of diagnostics and output',
		async (failure) => {
			const { browser } = browserPort();
			const bridge = await createActorApprovalBridge({ browser, origin });
			const input = challenge();
			const canary = `cookie-secret bearer-secret ${csrf} ${input.nonce}`;
			const logs = ['log', 'warn', 'error', 'info', 'debug'].map((method) =>
				vi.spyOn(console, method as 'log').mockImplementation(() => {})
			);
			const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
			const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
			const fetch = browser.fetch.getMockImplementation()!;
			browser.fetch.mockImplementation(async (url, init) => {
				if (init.method === 'GET') return fetch(url, init);
				if (failure === 'transport') throw new Error(canary);
				if (failure === 'json') return new Response(`invalid-json ${canary}`);
				return Response.json({ error: { code: canary, requestId: canary } }, { status: 403 });
			});
			const result = await bridge.approve(input);
			expect(result).toEqual({ outcome: failure === 'http' ? 'denied' : 'unknown' });
			const output = JSON.stringify([
				result,
				bridge.input,
				...logs.map((log) => log.mock.calls),
				stdout.mock.calls,
				stderr.mock.calls,
			]);
			for (const secret of ['cookie-secret', 'bearer-secret', csrf, input.nonce]) {
				expect(output).not.toContain(secret);
			}
			expect(browser.fetch).toHaveBeenCalledTimes(2);
		}
	);

	it.each([
		{ actorId: 'forged' },
		{ purpose: 'fleet_management' },
		{ version: 2 },
		{ version: 2, purpose: 'bogus' },
		{ nonce: 'bad' },
		{ expiresAt: '2000-01-01T00:00:00Z' },
	])('rejects incompatible or forged challenge fields %j', async (patch) => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(await bridge.approve({ ...challenge(), ...patch })).toEqual({ outcome: 'denied' });
		expect(browser.fetch).not.toHaveBeenCalled();
	});

	it.each(['service', 'expired', 'csrf', 'origin'])(
		'refuses absent human session authority: %s',
		async (fault) => {
			const { browser, state } = browserPort();
			if (fault === 'service') state.kind = 'service';
			if (fault === 'expired') state.expiresAt = 0;
			if (fault === 'csrf') browser.csrf = () => '';
			if (fault === 'origin') browser.origin = () => 'https://other.invalid';
			const bridge = await createActorApprovalBridge({ browser, origin });
			expect((await bridge.approve(challenge())).outcome).not.toBe('approved');
			expect(browser.fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
		}
	);

	it.each([401, 403, 500])('keeps HTTP %i secret canaries out of results', async (status) => {
		const { browser, state } = browserPort();
		state.status = status; // wrong session/CSRF or lost server outcome
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(await bridge.approve(challenge())).toEqual({
			outcome: status === 500 ? 'unknown' : 'denied',
		});
	});

	it('keeps a response for another challenge unknown', async () => {
		const { browser, state } = browserPort();
		state.replyId = 'another-challenge';
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(await bridge.approve(challenge())).toEqual({ outcome: 'unknown' });
	});

	it('rejects oversized responses and never sends a subsequent approval', async () => {
		const { browser } = browserPort();
		browser.fetch.mockResolvedValue(Response.json({ canary: csrf.repeat(8192) }));
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(await bridge.approve(challenge())).toEqual({ outcome: 'unavailable' });
		expect(browser.fetch).toHaveBeenCalledTimes(1);
	});

	it('honors cancellation before any browser request', async () => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		const controller = new AbortController();
		controller.abort();
		expect(await bridge.approve(challenge(), { signal: controller.signal })).toEqual({
			outcome: 'unavailable',
		});
		expect(browser.fetch).not.toHaveBeenCalled();
	});

	it.each([false, true])('bounds a hanging transport without retry (POST=%s)', async (post) => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin, timeoutMs: 100 });
		const fetch = browser.fetch.getMockImplementation()!;
		browser.fetch.mockImplementation((url, init) =>
			post && init.method === 'GET' ? fetch(url, init) : new Promise(() => {})
		);
		vi.useFakeTimers();
		const pending = bridge.approve(challenge());
		await vi.advanceTimersByTimeAsync(101);
		expect(await pending).toEqual({ outcome: post ? 'unknown' : 'unavailable' });
		expect(await bridge.approve(challenge())).toEqual({ outcome: 'denied' });
	});

	it('does not mistake missing bridge configuration for an absent API', () => {
		const result = inspectProducers({ pin: {}, pinDir: process.cwd(), approvalProducer: false });
		expect(result['registration-approval']).toEqual({
			fresh: false,
			detail: 'approval bridge not configured; this does not probe API availability',
		});
	});

	it.each([200, 403, 500])(
		'persists only a correlated acknowledgement after HTTP %i',
		async (status) => {
			const { browser, state } = browserPort();
			state.status = status;
			const bridge = await createActorApprovalBridge({ browser, origin });
			const dir = fs.mkdtempSync(path.join(process.cwd(), '.approval-test-'));
			vi.useFakeTimers();
			const stop = watchForChallenge(dir, bridge.approve, 1000);
			try {
				const input = challenge();
				fs.writeFileSync(path.join(dir, 'challenge.json'), JSON.stringify(input), { mode: 0o600 });
				await vi.advanceTimersByTimeAsync(251);
				expect(browser.fetch).toHaveBeenCalledTimes(2);
				expect(fs.readdirSync(dir)).toEqual(status === 200 ? ['approval.json'] : []);
				if (status === 200) {
					const text = fs.readFileSync(path.join(dir, 'approval.json'), 'utf8');
					expect(JSON.parse(text)).toEqual({ challengeId: input.challengeId });
					for (const secret of [input.nonce, input.challengeDigest, csrf]) {
						expect(text).not.toContain(secret);
					}
				}
				// This file acknowledges approval only; no endpoint redemption was exercised.
				expect(bridge.input).toMatchObject({ paired: false, authority: 'none' });
			} finally {
				stop();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);

	it.each([false, true])(
		'cleans the challenge and fences late approval (cancel=%s)',
		async (cancel) => {
			const dir = fs.mkdtempSync(path.join(process.cwd(), '.approval-test-'));
			vi.useFakeTimers();
			let finish!: (value: { outcome: string }) => void;
			const stop = watchForChallenge(
				dir,
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
				1000
			);
			try {
				const input = challenge();
				fs.writeFileSync(path.join(dir, 'challenge.json'), JSON.stringify(input), { mode: 0o600 });
				await vi.advanceTimersByTimeAsync(250);
				if (cancel) stop();
				finish({ outcome: 'approved' });
				await vi.advanceTimersByTimeAsync(1);
				expect(fs.existsSync(path.join(dir, 'challenge.json'))).toBe(false);
				expect(fs.existsSync(path.join(dir, 'approval.json'))).toBe(!cancel);
				if (!cancel)
					expect(JSON.parse(fs.readFileSync(path.join(dir, 'approval.json'), 'utf8'))).toEqual({
						challengeId: input.challengeId,
					});
			} finally {
				stop();
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}
	);
});
