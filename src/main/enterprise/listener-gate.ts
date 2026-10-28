/**
 * The gate every inbound listener of this process is held at (MRC2-05-06),
 * and the quiet record of what it refused. A LEAF on purpose: the sinks that
 * bind sockets (the web server, the tunnel manager, the Lite listeners, the
 * Cue webhook server that also runs in the headless engine) import this and
 * nothing of the policy's dependency chain; the one value this module holds
 * is the `ListenerAuthority` that `src/main/index.ts` installs at app-ready
 * with `setListenerAuthority()`. With none installed nothing is consulted and
 * a standalone host never pays for the question.
 *
 * A sink asks one of two ways: `holdListener(request)` throws a
 * `ListenerDeniedError` (message `[managed-<code>] ...`) for a caller whose
 * start already propagates errors, and `listenerHoldFor(request)` answers a
 * `ListenerHold` or null for a caller that reports a result object. Both
 * record a refusal once per kind, code, bind and port with a count
 * (`heldListeners()`), which the managed status projection lists in place of
 * a toast per start; `setListenerAuthority()` clears the record, so a reader
 * takes it before resetting the authority.
 */

import { formatManagedHold } from '../../shared/formatters';
import type {
	ListenerAuthority,
	ListenerDecision,
	ListenerDenial,
	ListenerKind,
	ListenerReach,
	ListenerReceipt,
	ListenerRequest,
} from './listener-policy';

/** One refusal a sink carries, and one row of the ledger: the kind, where it would have bound, the code and the sentence. */
export interface ListenerHold {
	kind: ListenerKind;
	bind: string;
	port: number;
	reach: ListenerReach;
	code: ListenerDenial;
	message: string;
	policyRevision: number | null;
	firstAt: string;
	lastAt: string;
	count: number;
}

/** Distinct holds the ledger keeps; a refusal past the bound is still answered, only its record is dropped. */
export const MAX_LISTENER_HOLDS = 64;

let listenerAuthority: ListenerAuthority | null = null;
const holds = new Map<string, ListenerHold>();

/** Install (or, with null, remove) the authority every listener of this process is held with. Clears the ledger. */
export function setListenerAuthority(authority: ListenerAuthority | null): void {
	listenerAuthority = authority;
	holds.clear();
}

/** A listener the ceiling refused: the code and receipt, with the message spelled as every managed hold is. */
export class ListenerDeniedError extends Error {
	readonly code: ListenerDenial;
	readonly receipt: ListenerReceipt;
	readonly kind: ListenerKind;
	constructor(decision: Extract<ListenerDecision, { allowed: false }>) {
		super(formatManagedHold(decision));
		this.name = 'ListenerDeniedError';
		this.code = decision.code;
		this.receipt = decision.managed;
		this.kind = decision.managed.kind;
	}
}

/** True when an error is a managed refusal rather than a port collision or a transport failure. */
export function isListenerDeniedError(error: unknown): error is ListenerDeniedError {
	return error instanceof ListenerDeniedError;
}

function recordHold(decision: Extract<ListenerDecision, { allowed: false }>): ListenerHold {
	const { managed } = decision;
	const key = `${managed.kind}\n${decision.code}\n${managed.bind}\n${managed.port}`;
	const at = new Date().toISOString();
	const seen = holds.get(key);
	if (seen) {
		seen.lastAt = at;
		seen.count += 1;
		return { ...seen };
	}
	const hold: ListenerHold = {
		kind: managed.kind,
		bind: managed.bind,
		port: managed.port,
		reach: managed.reach,
		code: decision.code,
		message: formatManagedHold(decision),
		policyRevision: managed.policyRevision,
		firstAt: at,
		lastAt: at,
		count: 1,
	};
	if (holds.size < MAX_LISTENER_HOLDS) holds.set(key, hold);
	return { ...hold };
}

/**
 * The hold a listener meets, or null when it may bind. With no authority
 * installed nothing is consulted and the answer is null. A refusal is
 * recorded before it is answered.
 */
export function listenerHoldFor(request: ListenerRequest): ListenerHold | null {
	if (!listenerAuthority) return null;
	const decision = listenerAuthority.evaluateListener(request);
	if (decision.allowed) return null;
	return recordHold(decision);
}

/** Hold one listener before its bind: throws `ListenerDeniedError` on a refusal, returns on an admission. */
export function holdListener(request: ListenerRequest): void {
	if (!listenerAuthority) return;
	const decision = listenerAuthority.evaluateListener(request);
	if (decision.allowed) return;
	recordHold(decision);
	throw new ListenerDeniedError(decision);
}

/**
 * What the ceiling has refused since the authority was installed, once per
 * kind, code, bind and port with a count. Copies, so a reader cannot alter it.
 */
export function heldListeners(): readonly ListenerHold[] {
	return [...holds.values()].map((hold) => ({ ...hold }));
}
