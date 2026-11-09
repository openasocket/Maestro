/**
 * The fetch chokepoint under management (MRC2-05-01): with no authority
 * installed a request leaves exactly as before; with one installed, the
 * request is held by class and origin BEFORE a timer starts or a socket
 * opens, a refusal is a typed `EgressDeniedError` and never reaches `fetch`,
 * a caller that names no class is held as `content`, and a standalone
 * authority answers allowed with nothing consulted. The chokepoint also keeps
 * the ledger of what it refused (MRC2-05-03): once per class, code and
 * origin with a count, as copies, bounded, and started over with the
 * authority.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	EGRESS_CLASSES,
	createEgressPolicySource,
	type EgressAuthority,
	type EgressRequest,
} from '../../../main/enterprise/egress-policy';
import {
	EgressDeniedError,
	fetchWithTimeout,
	heldEgress,
	holdEgress,
	isEgressDeniedError,
	isFetchTimeoutError,
	MAX_EGRESS_HOLDS,
	MAX_EGRESS_REDIRECTS,
	setEgressAuthority,
} from '../../../main/utils/fetchWithTimeout';

const URL_UNDER_TEST = 'https://api.runmaestro.ai/checkin';

/** A fetch that fails the test if it is ever reached. */
function forbiddenFetch(): ReturnType<typeof vi.fn> {
	return vi.fn(async (url: string) => {
		throw new Error(`fetch must not be called for ${url}`);
	});
}

function enrolled(revision: number): IdentityRead {
	return {
		status: 'ok',
		epoch: 1,
		record: {
			registration: { actorId: 'actor', registeredAt: 1 },
			policy: { appliedRevision: revision, appliedAt: 1 },
		},
	} as never;
}

function managedSource(ceiling: Record<string, unknown> | null) {
	const source = createEgressPolicySource({
		identity: { read: () => enrolled(3) },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (ceiling) {
		const outcome = source.install(ceiling);
		if (!outcome.installed) throw new Error(outcome.problems.join('; '));
	}
	return source;
}

describe('fetchWithTimeout under an egress authority', () => {
	const realFetch = global.fetch;

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		setEgressAuthority(null);
		global.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it('consults nothing and leaves unchanged when no authority is installed', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = mockFetch as unknown as typeof fetch;

		const response = await fetchWithTimeout(URL_UNDER_TEST, {}, 1000, 'vendor-telemetry');

		expect(response.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledWith(
			URL_UNDER_TEST,
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		);
	});

	it('passes through a standalone authority with nothing recorded', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = mockFetch as unknown as typeof fetch;
		const standalone = createEgressPolicySource({
			identity: { read: () => ({ status: 'none' }) },
			policy: () => null,
		});
		const evaluate = vi.spyOn(standalone, 'evaluateEgress');
		setEgressAuthority(standalone);

		await fetchWithTimeout(URL_UNDER_TEST, {}, 1000, 'vendor-telemetry');

		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluate.mock.results[0].value).toEqual({ allowed: true });
	});

	it('refuses before any connection: no fetch, no timer, a typed error', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		const timers = vi.spyOn(global, 'setTimeout');
		setEgressAuthority(managedSource(null));

		const pending = fetchWithTimeout(URL_UNDER_TEST, {}, 1000, 'vendor-telemetry');

		await expect(pending).rejects.toBeInstanceOf(EgressDeniedError);
		await expect(pending).rejects.toSatisfy(isEgressDeniedError);
		await expect(pending).rejects.not.toSatisfy(isFetchTimeoutError);
		await expect(pending).rejects.toMatchObject({
			code: 'unavailable',
			class: 'vendor-telemetry',
			url: URL_UNDER_TEST,
			message:
				'[managed-unavailable] the managed egress ceiling is unavailable (no egress ceiling is installed for policy revision 3)',
		});
		expect(global.fetch).not.toHaveBeenCalled();
		expect(timers).not.toHaveBeenCalled();
	});

	it('holds a request for another HTTP stack the same way, without sending it (MRC2-05-04)', () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		// No authority: nothing consulted, nothing recorded.
		expect(() =>
			holdEgress('https://github.com/RunMaestro/Maestro/releases.atom', 'updates')
		).not.toThrow();
		expect(heldEgress()).toEqual([]);
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'content', destinations: ['*'] }],
			})
		);
		expect(() => holdEgress('https://github.com/RunMaestro/Maestro/releases.atom')).not.toThrow();
		expect(() =>
			holdEgress('https://github.com/RunMaestro/Maestro/releases.atom', 'updates')
		).toThrow(EgressDeniedError);
		expect(heldEgress()).toEqual([
			expect.objectContaining({
				class: 'updates',
				code: 'class-denied',
				origin: 'https://github.com',
			}),
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('denies vendor telemetry by default on a managed host whose ceiling omits the class', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'content', destinations: ['*'] }],
			})
		);

		await expect(
			fetchWithTimeout(URL_UNDER_TEST, { method: 'POST' }, 1000, 'vendor-telemetry')
		).rejects.toMatchObject({ code: 'class-denied', class: 'vendor-telemetry' });
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('lets nothing of any class leave an enrolled host whose ceiling lists no class (MRC2-05-08)', async () => {
		// The strictest installed ceiling: a valid document with an empty class
		// list. Every class, content included, is refused `class-denied` before
		// a timer starts or a socket opens, and the ledger holds one row per class.
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		const timers = vi.spyOn(global, 'setTimeout');
		setEgressAuthority(managedSource({ policyRevision: 3, classes: [] }));

		for (const egressClass of EGRESS_CLASSES) {
			await expect(
				fetchWithTimeout(`https://${egressClass}.example/path?token=secret`, {}, 1000, egressClass)
			).rejects.toMatchObject({
				code: 'class-denied',
				class: egressClass,
				receipt: expect.objectContaining({
					policyRevision: 3,
					origin: `https://${egressClass}.example`,
				}),
			});
		}

		expect(global.fetch).not.toHaveBeenCalled();
		expect(timers).not.toHaveBeenCalled();
		expect(heldEgress().map((hold) => [hold.class, hold.code, hold.count])).toEqual(
			EGRESS_CLASSES.map((egressClass) => [egressClass, 'class-denied', 1])
		);
		expect(JSON.stringify(heldEgress())).not.toContain('secret');
	});

	it('holds a caller that names no class as content', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		const seen: EgressRequest[] = [];
		const authority: EgressAuthority = {
			evaluateEgress(request) {
				seen.push(request);
				return {
					allowed: false,
					code: 'class-denied',
					message: 'held',
					managed: {
						policyRevision: 3,
						class: request.class,
						actor: 'the operator',
						origin: 'https://api.runmaestro.ai',
						outcome: 'class-denied',
					},
				};
			},
		};
		setEgressAuthority(authority);

		await expect(fetchWithTimeout(URL_UNDER_TEST)).rejects.toMatchObject({ class: 'content' });
		await expect(fetchWithTimeout(URL_UNDER_TEST, {}, 50)).rejects.toMatchObject({
			class: 'content',
		});

		expect(seen).toEqual([
			{ url: URL_UNDER_TEST, class: 'content' },
			{ url: URL_UNDER_TEST, class: 'content' },
		]);
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('forwards the class and the actor a caller names', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		const seen: EgressRequest[] = [];
		setEgressAuthority({
			evaluateEgress(request) {
				seen.push(request);
				return { allowed: true };
			},
		});

		await fetchWithTimeout(URL_UNDER_TEST, {}, 1000, {
			class: 'plugin',
			actor: { kind: 'agent', sessionId: 's1', agentType: null },
		});
		await fetchWithTimeout(URL_UNDER_TEST, {}, 1000, {
			class: 'provider-account',
			account: { providerId: 'codex', accountRef: 'ref-1' },
		});

		expect(seen).toEqual([
			{
				url: URL_UNDER_TEST,
				class: 'plugin',
				actor: { kind: 'agent', sessionId: 's1', agentType: null },
			},
			{
				url: URL_UNDER_TEST,
				class: 'provider-account',
				account: { providerId: 'codex', accountRef: 'ref-1' },
			},
		]);
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	it('holds a provider-account request by the account the caller names (MRC2-05-05)', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = mockFetch as unknown as typeof fetch;
		const approved = { providerId: 'codex', accountRef: 'a'.repeat(64) };
		const personal = { providerId: 'codex', accountRef: 'b'.repeat(64) };
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [
					{
						class: 'provider-account',
						destinations: ['chatgpt.com'],
						accounts: [approved.accountRef],
					},
				],
			})
		);
		const usage = 'https://chatgpt.com/backend-api/wham/usage';

		await fetchWithTimeout(usage, {}, 1000, { class: 'provider-account', account: approved });
		expect(mockFetch).toHaveBeenCalledTimes(1);

		await expect(
			fetchWithTimeout(usage, {}, 1000, { class: 'provider-account', account: personal })
		).rejects.toMatchObject({
			code: 'account-denied',
			class: 'provider-account',
			receipt: expect.objectContaining({
				origin: 'https://chatgpt.com',
				account: personal.accountRef,
			}),
		});
		await expect(fetchWithTimeout(usage, {}, 1000, 'provider-account')).rejects.toMatchObject({
			code: 'account-denied',
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(heldEgress()).toEqual([
			expect.objectContaining({
				class: 'provider-account',
				code: 'account-denied',
				origin: 'https://chatgpt.com',
				count: 2,
			}),
		]);
	});

	it('lets a listed request leave with the timeout and the caller options intact', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = mockFetch as unknown as typeof fetch;
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'vendor-telemetry', destinations: ['api.runmaestro.ai'] }],
			})
		);

		const response = await fetchWithTimeout(
			URL_UNDER_TEST,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' } },
			1000,
			'vendor-telemetry'
		);

		expect(response.ok).toBe(true);
		expect(mockFetch).toHaveBeenCalledWith(
			URL_UNDER_TEST,
			expect.objectContaining({
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: expect.any(AbortSignal),
			})
		);
	});

	it('refuses a listed class for an unlisted destination, naming the origin only', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'updates', destinations: ['github.com'] }],
			})
		);

		await expect(
			fetchWithTimeout('https://evil.example/latest?token=secret', {}, 1000, 'updates')
		).rejects.toMatchObject({
			code: 'destination-denied',
			receipt: expect.objectContaining({ origin: 'https://evil.example' }),
		});
		expect(global.fetch).not.toHaveBeenCalled();
	});

	it('reads the authority per call, so removing it restores the standalone path', async () => {
		const mockFetch = vi.fn().mockResolvedValue({ ok: true });
		global.fetch = mockFetch as unknown as typeof fetch;
		setEgressAuthority(managedSource(null));
		await expect(fetchWithTimeout(URL_UNDER_TEST)).rejects.toBeInstanceOf(EgressDeniedError);

		setEgressAuthority(null);
		await fetchWithTimeout(URL_UNDER_TEST);

		expect(mockFetch).toHaveBeenCalledTimes(1);
	});
});

/** A recording fetch that answers each URL from a table; an unlisted URL fails the test. */
function scriptedFetch(routes: Record<string, () => Response>) {
	const seen: { url: string; init: RequestInit }[] = [];
	const fn = vi.fn(async (url: string, init: RequestInit = {}) => {
		seen.push({ url, init });
		const route = routes[url];
		if (!route) throw new Error(`fetch must not be called for ${url}`);
		return route();
	});
	return { fn, seen };
}

function redirect(status: number, location: string): Response {
	return new Response(null, { status, headers: { location } });
}

describe('redirects under an egress authority (MCOMP-19-01)', () => {
	const realFetch = global.fetch;

	afterEach(() => {
		setEgressAuthority(null);
		global.fetch = realFetch;
		vi.restoreAllMocks();
	});

	const githubOnly = () =>
		managedSource({
			policyRevision: 3,
			classes: [{ class: 'updates', destinations: ['github.com', '*.githubusercontent.com'] }],
		});

	it('leaves the standalone path on native redirect handling', async () => {
		const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
		global.fetch = mockFetch as unknown as typeof fetch;

		await fetchWithTimeout('https://github.com/a', {}, 1000, 'updates');

		expect(mockFetch.mock.calls[0][1]).not.toHaveProperty('redirect');
	});

	it('holds every hop, resolved to an absolute URL, before its socket opens', async () => {
		const { fn, seen } = scriptedFetch({
			'https://github.com/releases/latest': () => redirect(302, '/releases/tag/v2'),
			'https://github.com/releases/tag/v2': () =>
				redirect(301, '//objects.githubusercontent.com/asset?sig=secret'),
			'https://objects.githubusercontent.com/asset?sig=secret': () =>
				new Response('bytes', { status: 200 }),
		});
		global.fetch = fn as unknown as typeof fetch;
		const source = githubOnly();
		const evaluate = vi.spyOn(source, 'evaluateEgress');
		setEgressAuthority(source);

		const response = await fetchWithTimeout(
			'https://github.com/releases/latest',
			{},
			1000,
			'updates'
		);

		expect(await response.text()).toBe('bytes');
		expect(seen.map((call) => call.url)).toEqual([
			'https://github.com/releases/latest',
			'https://github.com/releases/tag/v2',
			'https://objects.githubusercontent.com/asset?sig=secret',
		]);
		expect(seen.every((call) => call.init.redirect === 'manual')).toBe(true);
		expect(evaluate.mock.calls.map(([request]) => request.url)).toEqual(
			seen.map((call) => call.url)
		);
		expect(heldEgress()).toEqual([]);
	});

	it('refuses a redirect to an unlisted destination without contacting it', async () => {
		const { fn, seen } = scriptedFetch({
			'https://github.com/releases/latest': () =>
				redirect(307, 'https://evil.example/payload?token=secret'),
		});
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(githubOnly());

		await expect(
			fetchWithTimeout('https://github.com/releases/latest', {}, 1000, 'updates')
		).rejects.toMatchObject({
			name: 'EgressDeniedError',
			code: 'destination-denied',
			class: 'updates',
			url: 'https://evil.example/payload?token=secret',
		});
		expect(seen.map((call) => call.url)).toEqual(['https://github.com/releases/latest']);
		expect(heldEgress()).toEqual([
			expect.objectContaining({ code: 'destination-denied', origin: 'https://evil.example' }),
		]);
		expect(JSON.stringify(heldEgress())).not.toContain('secret');
	});

	it('gives the enterprise-endpoint class no redirect exception', async () => {
		const { fn, seen } = scriptedFetch({
			'https://mega.example/control': () => redirect(302, 'https://elsewhere.example/'),
		});
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'enterprise-endpoint', destinations: ['mega.example'] }],
			})
		);

		await expect(
			fetchWithTimeout('https://mega.example/control', {}, 1000, 'enterprise-endpoint')
		).rejects.toMatchObject({ code: 'destination-denied', class: 'enterprise-endpoint' });
		expect(seen).toHaveLength(1);
	});

	it('re-reads the authority per hop, so a revocation mid-chain stops the next hop', async () => {
		const source = githubOnly();
		const { fn, seen } = scriptedFetch({
			'https://github.com/a': () => {
				source.clear();
				return redirect(302, 'https://github.com/b');
			},
		});
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(source);

		await expect(
			fetchWithTimeout('https://github.com/a', {}, 1000, 'updates')
		).rejects.toMatchObject({ code: 'unavailable' });
		expect(seen.map((call) => call.url)).toEqual(['https://github.com/a']);
	});

	it('turns a 303 into a bodiless GET and drops credentials across origins', async () => {
		const { fn, seen } = scriptedFetch({
			'https://github.com/upload': () =>
				redirect(303, 'https://objects.githubusercontent.com/done'),
			'https://objects.githubusercontent.com/done': () => new Response('ok', { status: 200 }),
		});
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(githubOnly());

		await fetchWithTimeout(
			'https://github.com/upload',
			{
				method: 'POST',
				body: '{"a":1}',
				headers: {
					Authorization: 'Bearer secret',
					'Content-Type': 'application/json',
					'X-Keep': '1',
				},
			},
			1000,
			'updates'
		);

		const hop = seen[1].init;
		expect(hop.method).toBe('GET');
		expect(hop.body).toBeUndefined();
		const headers = new Headers(hop.headers);
		expect(headers.get('authorization')).toBeNull();
		expect(headers.get('content-type')).toBeNull();
		expect(headers.get('x-keep')).toBe('1');
	});

	it('replays method, body and same-origin credentials on a 307', async () => {
		const { fn, seen } = scriptedFetch({
			'https://github.com/a': () => redirect(307, '/b'),
			'https://github.com/b': () => new Response('ok', { status: 200 }),
		});
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(githubOnly());

		await fetchWithTimeout(
			'https://github.com/a',
			{ method: 'PUT', body: 'payload', headers: { Authorization: 'Bearer t' } },
			1000,
			'updates'
		);

		expect(seen[1].init).toMatchObject({ method: 'PUT', body: 'payload' });
		expect(new Headers(seen[1].init.headers).get('authorization')).toBe('Bearer t');
	});

	it('bounds the chain at MAX_EGRESS_REDIRECTS', async () => {
		const fn = vi.fn(async () => redirect(302, 'https://github.com/loop'));
		global.fetch = fn as unknown as typeof fetch;
		setEgressAuthority(githubOnly());

		await expect(fetchWithTimeout('https://github.com/loop', {}, 1000, 'updates')).rejects.toThrow(
			`exceeded ${MAX_EGRESS_REDIRECTS} redirects`
		);
		expect(fn).toHaveBeenCalledTimes(MAX_EGRESS_REDIRECTS + 1);
	});

	it('leaves a caller that handles redirects itself to one fetch', async () => {
		const mockFetch = vi.fn().mockResolvedValue(redirect(302, 'https://evil.example/'));
		global.fetch = mockFetch as unknown as typeof fetch;
		setEgressAuthority(githubOnly());

		const response = await fetchWithTimeout(
			'https://github.com/a',
			{ redirect: 'manual' },
			1000,
			'updates'
		);

		expect(response.status).toBe(302);
		expect(mockFetch).toHaveBeenCalledTimes(1);
		expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
	});
});

describe('the ledger of holds (MRC2-05-03)', () => {
	const realFetch = global.fetch;

	afterEach(() => {
		setEgressAuthority(null);
		global.fetch = realFetch;
	});

	it('records a refusal once per class, code and origin with a count, and nothing for a request that left', async () => {
		global.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
		setEgressAuthority(
			managedSource({
				policyRevision: 3,
				classes: [{ class: 'updates', destinations: ['github.com'] }],
			})
		);

		await fetchWithTimeout('https://github.com/releases/latest', {}, 1000, 'updates');
		await expect(
			fetchWithTimeout(URL_UNDER_TEST, {}, 1000, 'vendor-telemetry')
		).rejects.toBeInstanceOf(EgressDeniedError);
		await expect(
			fetchWithTimeout(`${URL_UNDER_TEST}?run=2`, {}, 1000, 'vendor-telemetry')
		).rejects.toBeInstanceOf(EgressDeniedError);
		await expect(
			fetchWithTimeout('https://evil.example/latest?token=secret', {}, 1000, 'updates')
		).rejects.toBeInstanceOf(EgressDeniedError);

		const held = heldEgress();
		expect(held).toEqual([
			expect.objectContaining({
				class: 'vendor-telemetry',
				code: 'class-denied',
				origin: 'https://api.runmaestro.ai',
				count: 2,
			}),
			expect.objectContaining({
				class: 'updates',
				code: 'destination-denied',
				origin: 'https://evil.example',
				count: 1,
			}),
		]);
		expect(Date.parse(held[0].lastAt)).toBeGreaterThanOrEqual(Date.parse(held[0].firstAt));
		const text = JSON.stringify(held);
		expect(text).not.toContain('run=2');
		expect(text).not.toContain('secret');
		expect(global.fetch).toHaveBeenCalledTimes(1);
	});

	it('hands out copies and starts over when an authority is installed or removed', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		setEgressAuthority(managedSource(null));
		await expect(fetchWithTimeout(URL_UNDER_TEST)).rejects.toBeInstanceOf(EgressDeniedError);

		const first = heldEgress();
		expect(first).toEqual([
			expect.objectContaining({ class: 'content', code: 'unavailable', count: 1 }),
		]);
		(first[0] as { count: number }).count = 99;
		expect(heldEgress()[0].count).toBe(1);

		setEgressAuthority(managedSource(null));
		expect(heldEgress()).toEqual([]);
		await expect(fetchWithTimeout(URL_UNDER_TEST)).rejects.toBeInstanceOf(EgressDeniedError);
		setEgressAuthority(null);
		expect(heldEgress()).toEqual([]);
	});

	it('keeps at most MAX_EGRESS_HOLDS distinct holds and still refuses past the bound', async () => {
		global.fetch = forbiddenFetch() as unknown as typeof fetch;
		setEgressAuthority(managedSource(null));
		for (let i = 0; i < MAX_EGRESS_HOLDS + 3; i++) {
			await expect(fetchWithTimeout(`https://host-${i}.example/`)).rejects.toBeInstanceOf(
				EgressDeniedError
			);
		}
		expect(heldEgress()).toHaveLength(MAX_EGRESS_HOLDS);
		expect(global.fetch).not.toHaveBeenCalled();
	});
});
