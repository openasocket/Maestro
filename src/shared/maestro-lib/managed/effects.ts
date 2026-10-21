/**
 * Effect authorization under management: the decision a host asks for when
 * a RUNNING managed turn reaches for an effect the launch lease did not
 * cover (a command, a file change, a permission profile, a tool call), as
 * opposed to the launch itself (`authority.ts`).
 *
 * A launch lease says one snapshot may start. It says nothing about what
 * the provider does once it runs, and a provider that asks before acting
 * (Codex app-server's approval requests, OpenCode's permission events, the
 * permission relay's tool requests) hands the host exactly one chance to
 * decide each effect before it happens. This module is the vocabulary for
 * that chance:
 *
 *   - `ManagedEffect`: the effect, exact. The command line and cwd, the
 *     paths, the permission profile, the tool and its input. Never a label,
 *     never a summary the provider wrote for a human.
 *   - `ManagedEffectBinding`: whose effect it is. The lease it runs under,
 *     the actor the lease was admitted for, the provider, the provider's
 *     own thread and turn ids and the request id, so a decision can be
 *     joined to the one request it answered and nothing else.
 *   - `ManagedEffectDecision`: `allow`, `deny` (a decision), `unavailable`
 *     (no producer could be asked), `unknown` (asked, answer lost). Only
 *     `allow` grants; every other answer is a refusal at the sink, and the
 *     three refusals stay distinct so a caller never retries a denial as
 *     an outage.
 *
 * `ManagedEffectAuthority.decide` may be asynchronous: a real decision comes
 * from the endpoint. While it is pending the effect is pending; a host that
 * stops the turn, loses the lease or sees it revoked aborts the signal and
 * answers the provider with a refusal at once (`revoked`).
 *
 * `unavailableEffectAuthority()` is the honest authority of a host with no
 * effect producer: it never grants. The endpoint in the sibling checkout
 * exposes no per-effect operation (CP-01, CP-03, owner mega-maestro), so
 * the desktop composes this one today and the evidence says so.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../../canonicalJson';
import type { ManagedPrincipalRef } from './types';

export type ManagedEffect =
	| { kind: 'command'; command: string; cwd: string | null; argv: readonly string[] | null }
	| { kind: 'file-change'; paths: readonly string[]; cwd: string | null }
	| { kind: 'permissions'; permissions: Readonly<Record<string, unknown>> }
	| { kind: 'tool-call'; tool: string; input: unknown }
	| { kind: 'user-input'; prompt: string | null }
	| { kind: 'elicitation'; server: string | null }
	| { kind: 'other'; method: string };

export interface ManagedEffectBinding {
	leaseId: string;
	actor: ManagedPrincipalRef;
	provider: string;
	/** The provider's own conversation and turn identifiers, when it has them. */
	threadId: string | null;
	turnId: string | null;
	/** The provider's id for this one request, so the answer joins to it. */
	requestId: string;
}

export type ManagedEffectDecision =
	| { decision: 'allow' }
	| { decision: 'deny'; reason: string }
	| { decision: 'unavailable'; reason: string }
	| { decision: 'unknown'; reason: string };

export interface ManagedEffectAuthority {
	readonly authorityId: string;
	decide(
		effect: ManagedEffect,
		binding: ManagedEffectBinding,
		signal: AbortSignal
	): ManagedEffectDecision | Promise<ManagedEffectDecision>;
}

/** Whether a decision grants the effect. Nothing but `allow` does. */
export function effectGranted(decision: ManagedEffectDecision | null | undefined): boolean {
	return decision?.decision === 'allow';
}

/** A stable digest of one effect under one binding, for a journal line. */
export function effectDigest(effect: ManagedEffect, binding: ManagedEffectBinding): string {
	return createHash('sha256').update(canonicalJson({ effect, binding }), 'utf8').digest('hex');
}

/** The refusal a pending effect gets when the turn or its lease ends first. */
export const EFFECT_REVOKED: ManagedEffectDecision = Object.freeze({
	decision: 'deny',
	reason: 'The turn or its lease ended before the effect was decided.',
});

/**
 * The authority of a host that can ask nobody: every effect is
 * `unavailable`, which the sink treats as a refusal, and never `deny` (no
 * policy decided) and never `allow`.
 */
export function unavailableEffectAuthority(reason: string): ManagedEffectAuthority {
	return {
		authorityId: 'unavailable',
		decide: () => ({ decision: 'unavailable', reason }),
	};
}
