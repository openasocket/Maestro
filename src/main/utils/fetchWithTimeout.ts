/**
 * Fetch With Timeout
 *
 * A bare `fetch()` has no timeout. A stalled socket hangs the caller forever,
 * which in the main process means an IPC handler that never settles and a
 * renderer spinner that never stops.
 *
 * This is the single canonical wrapper. Before it existed there were three
 * separate functions named `fetchWithTimeout` with three different signatures
 * (`leaderboard.ts`, `cue-telemetry.ts`, `bmad-manager.ts`), two more inline
 * `AbortController` + `setTimeout` blocks (`checkin.ts`, `detector.ts`,
 * `codex-usage-sampler.ts`), and a dozen call sites with no timeout at all.
 *
 * Do NOT add another copy. If a caller needs different behaviour, give it a
 * different `timeoutMs` or wrap this function locally, as `bmad-manager.ts`
 * does to attach its own Sentry reporting.
 *
 * It is also the egress chokepoint of a managed desktop (MRC2-05-01): every
 * request names a destination class, and when an egress authority is
 * installed (`setEgressAuthority()`, called once at app-ready with the
 * source from `src/main/enterprise/egress-policy.ts`) the request is held
 * against the managed ceiling BEFORE a timer starts or a socket opens. A
 * refusal is a thrown `EgressDeniedError`, named by code, never a network
 * failure. With no authority installed (a standalone host, the CLI, a test)
 * nothing is consulted and a request leaves exactly as it always has.
 *
 * A refusal is also RECORDED here, once per class, code and origin with a
 * count (`heldEgress()`, MRC2-05-03): the managed status projection reads
 * that ledger, so a caller whose request is off under the policy (a check-in,
 * a stats flush) can be a quiet no-op instead of a toast on every start.
 *
 * A redirect is a new destination, so under an authority it is held too
 * (MCOMP-19-01): the chokepoint follows the chain itself, resolves each
 * `Location` against the URL that answered it, and holds that absolute URL
 * before the next socket opens. A first request the ceiling admits can
 * therefore never be bounced to a destination it does not list. One request
 * budget covers the whole chain.
 */

import type {
	EgressAccount,
	EgressActor,
	EgressAuthority,
	EgressClass,
	EgressDecision,
} from '../enterprise/egress-policy';

/**
 * Default request budget. Deliberately generous: it is the backstop for
 * callers that have no opinion, not a target. Latency-sensitive callers pass
 * a shorter value (the models.dev catalog probe uses 3s, telemetry 10s).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * What a call names about itself for the egress ceiling: its class, who asked
 * when it is not the operator, and for a `provider-account` request the
 * account whose token it carries (MRC2-05-05), which the ceiling holds by
 * its opaque reference.
 */
export interface FetchEgressOptions {
	class: EgressClass;
	actor?: EgressActor;
	account?: EgressAccount;
}

/** The class a caller that names none is held as; the policy's `DEFAULT_EGRESS_CLASS`, spelled here to keep this module a leaf. */
const DEFAULT_CLASS: EgressClass = 'content';

let egressAuthority: EgressAuthority | null = null;

/** Install (or, with null, remove) the authority every request through here is held with; the ledger of holds starts over with it. */
export function setEgressAuthority(authority: EgressAuthority | null): void {
	egressAuthority = authority;
	holds.clear();
}

/** The refusal a managed host answers an outbound request with: the socket never opened. */
export class EgressDeniedError extends Error {
	readonly code: Extract<EgressDecision, { allowed: false }>['code'];
	readonly receipt: Extract<EgressDecision, { allowed: false }>['managed'];
	readonly class: EgressClass;
	readonly url: string;
	constructor(decision: Extract<EgressDecision, { allowed: false }>, url: string) {
		super(`[managed-${decision.code}] ${decision.message}`);
		this.name = 'EgressDeniedError';
		this.code = decision.code;
		this.receipt = decision.managed;
		this.class = decision.managed.class;
		this.url = url;
	}
}

/** True when a rejection is a managed refusal rather than a timeout, an abort or a transport failure. */
export function isEgressDeniedError(error: unknown): error is EgressDeniedError {
	return error instanceof EgressDeniedError;
}

/** One refusal the chokepoint recorded: a class, a code and an origin, when it was first and last met, and how often. */
export interface EgressHold {
	class: EgressClass;
	code: EgressDeniedError['code'];
	/** The origin held (`scheme://host[:port]`), never a path or query. */
	origin: string | null;
	firstAt: string;
	lastAt: string;
	count: number;
}

/** Distinct holds the ledger keeps; a refusal past the bound is still thrown, only its record is dropped. */
export const MAX_EGRESS_HOLDS = 64;

const holds = new Map<string, EgressHold>();

function recordHold(refused: EgressDeniedError): void {
	const key = `${refused.class}\n${refused.code}\n${refused.receipt.origin ?? ''}`;
	const at = new Date().toISOString();
	const seen = holds.get(key);
	if (seen) {
		seen.lastAt = at;
		seen.count += 1;
		return;
	}
	if (holds.size >= MAX_EGRESS_HOLDS) return;
	holds.set(key, {
		class: refused.class,
		code: refused.code,
		origin: refused.receipt.origin,
		firstAt: at,
		lastAt: at,
		count: 1,
	});
}

/**
 * What the ceiling has refused since the authority was installed, once per
 * class, code and origin with a count: the quiet record a status projection
 * shows in place of a toast per start. Copies, so a reader cannot alter it.
 */
export function heldEgress(): readonly EgressHold[] {
	return [...holds.values()].map((hold) => ({ ...hold }));
}

/**
 * Hold one outbound request against the installed authority without sending
 * it: the chokepoint's own first step, on its own for a sink whose bytes
 * leave through another HTTP stack (electron-updater's release feed and
 * installer download, MRC2-05-04). With no authority installed nothing is
 * consulted. A refusal is recorded in the ledger and thrown, exactly as
 * `fetchWithTimeout()` throws it; a sink that gets no error may proceed.
 */
export function holdEgress(
	url: string,
	egress: EgressClass | FetchEgressOptions = DEFAULT_CLASS
): void {
	if (!egressAuthority) return;
	const named = typeof egress === 'string' ? { class: egress } : egress;
	const decision = egressAuthority.evaluateEgress({ url, ...named });
	if (decision.allowed) return;
	const refused = new EgressDeniedError(decision, url);
	recordHold(refused);
	throw refused;
}

/** The redirect limit `fetch()` itself applies; a held chain keeps the same bound. */
export const MAX_EGRESS_REDIRECTS = 20;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Request headers the Fetch standard strips when a redirect crosses origins. */
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

/** Headers that describe a body, dropped with it when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language'];

function originOf(url: string): string {
	return new URL(url).origin;
}

/**
 * The request a redirect hop sends, by the Fetch standard's rules: a 303 (or
 * a 301/302 answering a POST) becomes a bodiless GET; a 307/308 replays the
 * method and the body, which a one-shot stream cannot do; a hop to another
 * origin loses the credentials the first origin was sent.
 */
function redirectedInit(
	init: RequestInit,
	status: number,
	crossOrigin: boolean,
	url: string
): RequestInit {
	const method = (init.method ?? 'GET').toUpperCase();
	const toGet =
		(status === 303 && method !== 'GET' && method !== 'HEAD') ||
		((status === 301 || status === 302) && method === 'POST');
	if (!toGet && init.body instanceof ReadableStream)
		throw new TypeError(
			`Request to ${url} was redirected with a ${status}, which replays a streamed body that cannot be sent twice`
		);
	const headers = new Headers(init.headers);
	if (crossOrigin) for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
	if (toGet) for (const name of BODY_HEADERS) headers.delete(name);
	return {
		...init,
		headers,
		...(toGet ? { method: 'GET', body: undefined } : {}),
	};
}

/**
 * Follow a redirect chain one hop at a time, holding each destination against
 * the installed authority BEFORE the next socket opens. A `Location` is
 * resolved against the URL that answered it, so a relative, a scheme-relative
 * or a cross-host redirect is held as the absolute URL it actually names; a
 * hop the ceiling refuses throws the same `EgressDeniedError` (and records the
 * same hold) as a refused first request, and nothing is sent to it. The
 * returned response is the last hop's, so `response.url` is the final URL;
 * `response.redirected` reads false because each hop was its own request.
 */
async function fetchHoldingRedirects(
	url: string,
	init: RequestInit,
	egress: EgressClass | FetchEgressOptions
): Promise<Response> {
	let current = url;
	let request = init;
	for (let hop = 0; ; hop++) {
		const response = await fetch(current, { ...request, redirect: 'manual' });
		const location = REDIRECT_STATUSES.has(response.status)
			? response.headers?.get('location')
			: null;
		if (!location) return response;
		// The redirect's own body is never read; release its socket first.
		void response.body?.cancel().catch(() => {});
		if (hop >= MAX_EGRESS_REDIRECTS)
			throw new TypeError(`Request to ${url} exceeded ${MAX_EGRESS_REDIRECTS} redirects`);
		let next: string;
		try {
			next = new URL(location, current).href;
		} catch {
			throw new TypeError(`Request to ${url} was redirected to an invalid location`);
		}
		holdEgress(next, egress);
		request = redirectedInit(
			request,
			response.status,
			originOf(next) !== originOf(current),
			current
		);
		current = next;
	}
}

/**
 * `fetch()` with a request budget.
 *
 * The returned promise rejects when `timeoutMs` elapses before the response
 * headers arrive. The rejection is a `TimeoutError` rather than the plain
 * `AbortError` a caller-initiated cancel produces, so the two are
 * distinguishable at the catch site.
 *
 * A `signal` passed in `options` is honoured rather than overwritten: the
 * request aborts when either that signal or the timeout fires. Clobbering it
 * would silently disable a caller's own cancellation, which is exactly the
 * kind of bug this helper exists to prevent.
 *
 * The timeout covers the response headers, not the body. A caller that reads
 * a large body with `.json()` or `.text()` can still block after this
 * resolves.
 *
 * @param url - The URL to request
 * @param options - Standard `RequestInit`. Any `signal` here is composed with
 *   the timeout rather than replaced.
 * @param timeoutMs - Request budget in milliseconds
 * @param egress - The destination class the request is held as on a managed
 *   host (a bare class, or a class with the actor who asked). Absent, the
 *   request is `content`. Ignored when no authority is installed.
 * @returns The `Response`, exactly as `fetch()` would return it. Non-2xx
 *   responses resolve normally; callers still check `response.ok`.
 * @throws EgressDeniedError when the managed ceiling refuses the request;
 *   nothing was sent.
 */
export async function fetchWithTimeout(
	url: string,
	options: RequestInit = {},
	timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
	egress: EgressClass | FetchEgressOptions = DEFAULT_CLASS
): Promise<Response> {
	// The hold comes first: a refused request starts no timer and opens no
	// socket, and the authority is read per call so a late install applies.
	holdEgress(url, egress);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(
			new DOMException(`Request to ${url} timed out after ${timeoutMs}ms`, 'TimeoutError')
		);
	}, timeoutMs);

	// AbortSignal.any settles on whichever fires first and forwards its reason,
	// so a caller cancel stays an AbortError and a timeout stays a TimeoutError.
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		// Standalone, or a caller that handles redirects itself (`manual`
		// returns the 3xx, `error` rejects on one), leaves through one fetch.
		// Under an authority every other redirect is followed HERE so each hop
		// is held before its socket opens (MCOMP-19-01).
		if (!egressAuthority || options.redirect === 'manual' || options.redirect === 'error')
			return await fetch(url, { ...options, signal });
		return await fetchHoldingRedirects(url, { ...options, signal }, egress);
	} finally {
		// Release the timer as soon as the response lands. Letting it run to
		// completion would pin the closure for the full budget on every call.
		clearTimeout(timeoutId);
	}
}

/**
 * True when a rejection came from this helper's timeout rather than from a
 * caller-initiated abort or a transport failure.
 */
export function isFetchTimeoutError(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'TimeoutError';
}
