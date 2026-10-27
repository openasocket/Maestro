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
 */

import type {
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

/** What a call names about itself for the egress ceiling: its class, and who asked when it is not the operator. */
export interface FetchEgressOptions {
	class: EgressClass;
	actor?: EgressActor;
}

/** The class a caller that names none is held as; the policy's `DEFAULT_EGRESS_CLASS`, spelled here to keep this module a leaf. */
const DEFAULT_CLASS: EgressClass = 'content';

let egressAuthority: EgressAuthority | null = null;

/** Install (or, with null, remove) the authority every request through here is held with. */
export function setEgressAuthority(authority: EgressAuthority | null): void {
	egressAuthority = authority;
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
	if (egressAuthority) {
		const named = typeof egress === 'string' ? { class: egress } : egress;
		const decision = egressAuthority.evaluateEgress({ url, ...named });
		if (!decision.allowed) throw new EgressDeniedError(decision, url);
	}

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
		return await fetch(url, { ...options, signal });
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
