import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	createActorApprovalBridge,
	inspectProducers,
	watchForChallenge,
} from '../../../../scripts/mega-maestro-pair.mjs';

const origin = 'https://approval.invalid';
const csrf = 'isolated-csrf-canary';
const challenge = () => ({
	challengeId: '11111111-1111-4111-8111-111111111111',
	nonce: 'N'.repeat(43),
	challengeDigest: 'a'.repeat(64),
	expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

// Declared browser/service unit port. No real browser, cookie, tenant or paired
// authentication is exercised. The real pinned HTTP client constructs requests.
function browserPort() {
	const state = { kind: 'user', expiresAt: Date.now() + 60_000, status: 200, replyId: '' };
	const browser = {
		origin: () => origin,
		csrf: () => csrf,
		fetch: vi.fn(async (url: URL, init: RequestInit) => {
			expect(init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
			expect(new Headers(init.headers).has('authorization')).toBe(false);
			expect(new Headers(init.headers).has('cookie')).toBe(false);
			if (url.pathname === '/api/identity/session') {
				return Response.json({ principal: { kind: state.kind }, expiresAt: state.expiresAt });
			}
			expect(url.pathname).toBe('/api/enrollment/runtime-registrations/approve');
			expect(new Headers(init.headers).get('x-csrf-token')).toBe(csrf);
			const body = JSON.parse(String(init.body));
			expect(Object.keys(body).sort()).toEqual(['challengeDigest', 'challengeId', 'nonce']);
			return Response.json(
				state.status === 200
					? { challengeId: state.replyId || body.challengeId }
					: { error: { code: `secret-${csrf}-${body.nonce}` } },
				{ status: state.status }
			);
		}),
	};
	return { browser, state };
}

afterEach(() => vi.useRealTimers());
describe('owned actor approval bridge (local contract evidence only)', () => {
	it('uses the pinned browser/CSRF API once and emits no execution authority', async () => {
		const { browser } = browserPort();
		const bridge = await createActorApprovalBridge({ browser, origin });
		expect(bridge.input).toMatchObject({ protocol: 1, authority: 'none', paired: false });
		const input = challenge();
		expect(await bridge.approve(input)).toEqual({ outcome: 'approved' });
		expect(await bridge.approve(input)).toEqual({ outcome: 'denied' });
		expect(browser.fetch).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(bridge.input)).not.toContain(input.nonce);
	});

	it.each([
		{ actorId: 'forged' },
		{ version: 2, purpose: 'runtime_use' },
		{ purpose: 'fleet_management' },
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
