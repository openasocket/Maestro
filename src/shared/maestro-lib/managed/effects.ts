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
import type { DispatchLease } from './authority';
import type { ManagedPrincipalRef } from './types';

export type ManagedEffect = (
	| { kind: 'command'; command: string; cwd: string | null; argv: readonly string[] | null }
	| { kind: 'file-change'; paths: readonly string[]; cwd: string | null }
	| { kind: 'permissions'; permissions: Readonly<Record<string, unknown>> }
	| { kind: 'tool-call'; tool: string; input: unknown }
	| { kind: 'user-input'; prompt: string | null }
	| { kind: 'elicitation'; server: string | null }
	| { kind: 'other'; method: string }
) & {
	/** Full provider request, including edits, network inputs and execution options. */
	request?: { method: string; input: unknown };
};

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
	| { decision: 'allow'; current?: () => boolean }
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

/** Local EFFECT/1 proposal. No published endpoint operation implements this port yet. */
export interface ManagedEffectRequest {
	version: 1;
	effect: ManagedEffect;
	binding: ManagedEffectBinding;
	effectDigest: string;
	policyRevision: number;
	generation: string;
}

export interface ManagedEffectReceipt {
	receiptId: string;
	effectDigest: string;
	policyRevision: number;
	expiresAt: string;
}

export type ManagedEffectAuthorization =
	| Exclude<ManagedEffectDecision, { decision: 'allow' }>
	| { decision: 'allow'; receipt: ManagedEffectReceipt };

/**
 * Install only after authenticated negotiation. Authorize pins exact native
 * resources; consume durably spends that authorization ONCE, without executing
 * the effect. The producer owns confinement, revocation and durable settlement/
 * reconciliation. A broker execution receipt cannot implement either method.
 */
export interface ManagedEffectProducer {
	readonly version: 1;
	readonly authorityId: string;
	authorize(
		request: ManagedEffectRequest,
		signal: AbortSignal
	): Promise<ManagedEffectAuthorization>;
	consume(
		request: ManagedEffectRequest,
		receipt: ManagedEffectReceipt,
		signal: AbortSignal
	): Promise<ManagedEffectAuthorization>;
}

/** A host-owned lease and its current actor/policy/trust/connection standing. */
export interface ManagedEffectScope {
	lease: DispatchLease;
	generation: string;
	signal: AbortSignal;
	current(): boolean;
}

/** Request-bound consumer, shared by the existing provider and native effect sinks. */
export function createManagedEffectAuthority(deps: {
	authorityId(): string;
	producer(): ManagedEffectProducer | null;
	scope(binding: ManagedEffectBinding): ManagedEffectScope | null;
	now?: () => number;
}): ManagedEffectAuthority {
	const now = deps.now ?? Date.now;
	// No decision, even allow, is reusable. The producer also fences across restart.
	const attempts = new Map<string, ManagedEffectDecision>();
	const receipts = new Set<string>();
	const unknown: ManagedEffectDecision = {
		decision: 'unknown',
		reason: 'Effect authorization may have been consumed; reconcile before retrying.',
	};
	return {
		get authorityId() {
			return deps.authorityId();
		},
		async decide(effect, binding, signal) {
			const key = canonicalJson([
				binding.leaseId,
				binding.threadId,
				binding.turnId,
				binding.requestId,
			]);
			const previous = attempts.get(key);
			if (previous)
				return previous.decision === 'allow'
					? { decision: 'deny', reason: 'This effect request was already consumed.' }
					: previous;
			const producer = deps.producer();
			if (!producer || producer.version !== 1 || producer.authorityId !== deps.authorityId())
				return { decision: 'unavailable', reason: 'No negotiated EFFECT/1 producer is available.' };
			const scope = deps.scope(binding);
			if (!scope || signal.aborted || scope.signal.aborted || !scope.current())
				return EFFECT_REVOKED;
			// Lossy provider projections cannot authorize file contents or network inputs.
			if (!effect.request || !effect.request.method || effect.kind === 'other')
				return { decision: 'unavailable', reason: 'The complete effect request is unavailable.' };
			if (scope.lease.policyRevision === null || !binding.requestId)
				return { decision: 'deny', reason: 'The effect has no policy or request binding.' };
			if (attempts.size >= 10_000)
				return { decision: 'unavailable', reason: 'The effect replay journal is full.' };
			const request: ManagedEffectRequest = structuredClone({
				version: 1,
				effect,
				binding,
				effectDigest: effectDigest(effect, binding),
				policyRevision: scope.lease.policyRevision,
				generation: scope.generation,
			});
			const input = canonicalJson(request);
			const controller = new AbortController();
			const abort = () => controller.abort();
			signal.addEventListener('abort', abort, { once: true });
			scope.signal.addEventListener('abort', abort, { once: true });
			const revoked = new Promise<ManagedEffectAuthorization>((resolve) => {
				controller.signal.addEventListener('abort', () => resolve(EFFECT_REVOKED), { once: true });
			});
			const current = () =>
				!signal.aborted &&
				!scope.signal.aborted &&
				scope.current() &&
				deps.producer() === producer &&
				producer.authorityId === deps.authorityId() &&
				input === canonicalJson(request) &&
				request.effectDigest === effectDigest(effect, binding);
			const valid = (receipt: ManagedEffectReceipt) =>
				receipt &&
				!!receipt.receiptId &&
				receipt.effectDigest === request.effectDigest &&
				receipt.policyRevision === request.policyRevision &&
				Number.isFinite(Date.parse(receipt.expiresAt)) &&
				Date.parse(receipt.expiresAt) > now();
			attempts.set(key, unknown);
			try {
				if (!current()) return EFFECT_REVOKED;
				const authorization = await Promise.race([
					producer.authorize(request, controller.signal),
					revoked,
				]);
				if (!current()) return EFFECT_REVOKED;
				if (authorization.decision !== 'allow') {
					attempts.set(key, authorization);
					return authorization;
				}
				const receipt = structuredClone(authorization.receipt);
				if (!valid(receipt) || receipts.has(receipt.receiptId)) return unknown;
				receipts.add(receipt.receiptId);
				const receiptInput = canonicalJson(receipt);
				const consumed = await Promise.race([
					producer.consume(request, receipt, controller.signal),
					revoked,
				]);
				if (!current()) return EFFECT_REVOKED;
				if (
					consumed.decision === 'allow' &&
					(!valid(consumed.receipt) ||
						canonicalJson(consumed.receipt) !== receiptInput ||
						canonicalJson(receipt) !== receiptInput)
				)
					return unknown;
				const decision: ManagedEffectDecision =
					consumed.decision === 'allow'
						? {
								decision: 'allow',
								current: () =>
									current() && canonicalJson(receipt) === receiptInput && valid(receipt),
							}
						: consumed;
				attempts.set(key, decision.decision === 'allow' ? { decision: 'allow' } : decision);
				return decision;
			} catch {
				return unknown; // A thrown/lost producer response never grants or permits blind replay.
			} finally {
				controller.abort();
				signal.removeEventListener('abort', abort);
				scope.signal.removeEventListener('abort', abort);
			}
		},
	};
}

/** Whether a decision grants the effect. Nothing but `allow` does. */
export function effectGranted(decision: ManagedEffectDecision | null | undefined): boolean {
	try {
		return decision?.decision === 'allow' && (decision.current?.() ?? true);
	} catch {
		return false; // An unreadable standing cannot grant at the effect sink.
	}
}

/** A stable digest of one effect under one binding, for a journal line. */
export function effectDigest(effect: ManagedEffect, binding: ManagedEffectBinding): string {
	return createHash('sha256').update(canonicalJson({ effect, binding }), 'utf8').digest('hex');
}

/** The refusal a pending effect gets when the turn or its lease ends first. */
export const EFFECT_REVOKED = Object.freeze({
	decision: 'deny',
	reason: 'The turn or its lease ended before the effect was decided.',
} as const);

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
