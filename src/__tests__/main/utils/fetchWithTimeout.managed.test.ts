/**
 * The fetch chokepoint under management (MRC2-05-01): with no authority
 * installed a request leaves exactly as before; with one installed, the
 * request is held by class and origin BEFORE a timer starts or a socket
 * opens, a refusal is a typed `EgressDeniedError` and never reaches `fetch`,
 * a caller that names no class is held as `content`, and a standalone
 * authority answers allowed with nothing consulted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	createEgressPolicySource,
	type EgressAuthority,
	type EgressRequest,
} from '../../../main/enterprise/egress-policy';
import {
	EgressDeniedError,
	fetchWithTimeout,
	isEgressDeniedError,
	isFetchTimeoutError,
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

		expect(seen).toEqual([
			{
				url: URL_UNDER_TEST,
				class: 'plugin',
				actor: { kind: 'agent', sessionId: 's1', agentType: null },
			},
		]);
		expect(global.fetch).toHaveBeenCalledTimes(1);
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
