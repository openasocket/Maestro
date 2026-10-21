/**
 * Host authority over a managed dispatch.
 *
 * Three things live here, in the order a dispatch meets them:
 *
 *   1. A **verified context**. `createContextVerifier()` is the only way to
 *      turn a serializable `ManagedOperationContext` into the branded
 *      `ManagedAuthenticatedContext` a sink accepts. The brand is a type-level
 *      mark AND a module-private set of the objects a verifier produced, so a
 *      caller that casts a plain object to the branded type is still refused
 *      (`isVerifiedContext`).
 *   2. A **dispatch snapshot**: the final, immutable shape of what is about to
 *      run (executable, arguments, environment references, cwd, prompt and
 *      resource digests, provider, model, account, target). It is built from
 *      the resolved process spec, never from the request that led to it, and
 *      it is compared by digest. Environment VALUES are never in it, only the
 *      names and one digest over them.
 *   3. A **lease**: the protected lifetime the authority grants for exactly one
 *      snapshot. A lease is admitted, bound to the process the instant it is
 *      spawned, and released when that process ends. The sink re-checks the
 *      lease against the snapshot it is about to spawn, so "authorize, then
 *      spawn something else" fails at the spawn, not after it.
 *
 * Denial, unavailability and an unknown answer stay distinct all the way
 * through (`AdmissionOutcome`): a policy that said no, an authority that could
 * not be asked, and an answer that was lost after asking are three different
 * facts, and a caller must not retry the last one as if it were the second.
 *
 * `createLocalHostAuthority()` is the in-process authority: it mints and
 * tracks leases and asks an injected policy reader for the decision. It is
 * not a policy engine. A fleet's real decision comes through `decide`, which a
 * host wires to its verified peer; a test wires it to a table.
 *
 * A launch lease covers the launch. It says nothing about the tools, files or
 * network the provider reaches for once it runs; those routes report their
 * own support (`providerRouteSupport`) and stay unqualified here.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../../canonicalJson';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedAuthenticatedContext,
	type ManagedContractVersion,
	type ManagedDenialCode,
	type ManagedDispatchTarget,
	type ManagedOperationContext,
	type ManagedPeerAuthentication,
	type ManagedPolicySource,
	type ManagedPrincipalRef,
	type ManagedVerification,
	managedContextProblems,
} from './types';

// ---------------------------------------------------------------------------
// Verified contexts
// ---------------------------------------------------------------------------

/** The contexts a verifier in this module has bound. Private: nothing else can add to it. */
const VERIFIED = new WeakSet<object>();

export interface ContextVerifierDeps {
	verifierId: string;
	/** The transport the peer was authenticated over. */
	peer: ManagedPeerAuthentication;
	now(): number;
	/**
	 * Whether the attribution is true for the peer it arrived from: the
	 * installation is this one, the actor is who the transport says. Returns
	 * the problems, empty when it is. Structural problems are checked first and
	 * never reach it.
	 */
	accept(context: ManagedOperationContext): readonly string[];
}

export type ContextVerification =
	| { ok: true; context: ManagedAuthenticatedContext }
	| { ok: false; code: 'invalid-input' | 'unauthenticated'; problems: readonly string[] };

export interface ContextVerifier {
	readonly verifierId: string;
	verify(context: unknown): ContextVerification;
}

/**
 * The one producer of `ManagedAuthenticatedContext`. The returned object is a
 * fresh copy: a caller that keeps mutating the context it sent does not
 * mutate what was verified.
 */
export function createContextVerifier(deps: ContextVerifierDeps): ContextVerifier {
	return {
		verifierId: deps.verifierId,
		verify(value) {
			const problems = managedContextProblems(value);
			if (problems.length > 0) return { ok: false, code: 'invalid-input', problems };
			const context = structuredClone(value as ManagedOperationContext);
			const refused = deps.accept(context);
			if (refused.length > 0) return { ok: false, code: 'unauthenticated', problems: refused };
			const verification: ManagedVerification = {
				peer: deps.peer,
				verifierId: deps.verifierId,
				verifiedAt: new Date(deps.now()).toISOString(),
			};
			const verified = Object.freeze({ ...context, verification }) as ManagedAuthenticatedContext;
			VERIFIED.add(verified);
			return { ok: true, context: verified };
		},
	};
}

/** True only for an object a verifier from this module produced. A cast does not pass. */
export function isVerifiedContext(value: unknown): value is ManagedAuthenticatedContext {
	return typeof value === 'object' && value !== null && VERIFIED.has(value);
}

// ---------------------------------------------------------------------------
// Dispatch snapshots
// ---------------------------------------------------------------------------

/** The effects a lease can cover. Only the launch, in this build. */
export type DispatchEffect = 'launch';

/**
 * What the launch is to the provider session: a fresh session, more input
 * to a live one, or a resumed one. The broker protocol's own vocabulary for
 * an execution (`start`, `input`, `resume`); a launch with no session is a
 * `start`.
 */
export type DispatchOperation = 'start' | 'input' | 'resume';

/**
 * What is about to run, resolved and final. Serializable, so it can be sent
 * to a remote authority and journaled; compared by `dispatchSnapshotDigest`.
 */
export interface DispatchSnapshot {
	contractVersion: ManagedContractVersion;
	operation: DispatchOperation;
	executable: string;
	args: readonly string[];
	cwd: string;
	/** Run through a shell: the platform default (`true`) or the shell's path. */
	shell: boolean | string;
	/** Names of every variable the child receives, sorted. Never the values. */
	envKeys: readonly string[];
	/** One digest over the whole environment, names and values. */
	envDigest: string;
	/** Digest of what is written to stdin (a prompt, an SSH script), or null for nothing. */
	stdinDigest: string | null;
	provider: string;
	model: string | null;
	/** An opaque account reference (a profile or account key), never a credential. */
	account: string | null;
	target: ManagedDispatchTarget;
	resourceIds: readonly string[];
	effects: readonly DispatchEffect[];
}

/** The parts of a snapshot the process spec does not know. */
export interface DispatchAttribution {
	provider: string;
	model?: string | null;
	account?: string | null;
	target?: ManagedDispatchTarget;
	resourceIds?: readonly string[];
	/** Default `start`. */
	operation?: DispatchOperation;
}

export interface DispatchSpecLike {
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string | undefined>>;
	stdin?: string;
	shell?: boolean | string;
}

export function sha256Hex(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Build the snapshot of a resolved spec. Pure; the same spec gives the same digest. */
export function buildDispatchSnapshot(
	spec: DispatchSpecLike,
	attribution: DispatchAttribution
): DispatchSnapshot {
	const env: Record<string, string> = {};
	for (const key of Object.keys(spec.env).sort()) {
		const value = spec.env[key];
		if (value !== undefined) env[key] = value;
	}
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		operation: attribution.operation ?? 'start',
		executable: spec.command,
		args: [...spec.args],
		cwd: spec.cwd,
		shell: spec.shell ?? false,
		envKeys: Object.keys(env),
		envDigest: sha256Hex(canonicalJson(env)),
		stdinDigest: spec.stdin ? sha256Hex(spec.stdin) : null,
		provider: attribution.provider,
		model: attribution.model ?? null,
		account: attribution.account ?? null,
		target: attribution.target ?? { kind: 'local' },
		resourceIds: [...(attribution.resourceIds ?? [])].sort(),
		effects: ['launch'],
	};
}

export function dispatchSnapshotDigest(snapshot: DispatchSnapshot): string {
	return sha256Hex(canonicalJson(snapshot));
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

/** Module-private: no other module can name this key, so no other module can build a lease. */
const leaseBrand: unique symbol = Symbol('maestro.dispatchLease');

export type LeaseState = 'issued' | 'bound' | 'released' | 'revoked' | 'expired';

/** How a bound lease ended, as the sink reports it. */
export type LeaseRelease =
	| { outcome: 'exited'; exitCode: number | null; signal: string | null }
	| { outcome: 'spawn-failed'; message: string }
	| { outcome: 'stopped'; by: 'caller' | 'authority' }
	| { outcome: 'unknown'; message: string };

/**
 * The durable decision a remote authority answered with: the broker's own
 * identifiers for the grant it consumed. `decisionId` is the grant the broker
 * journaled, `requestDigest` its digest over the binding it decided on,
 * `brokerId` which broker. A lease that carries one can be joined to the
 * broker's receipt ledger; a lease decided in process carries none.
 */
export interface ManagedDecisionReceipt {
	decisionId: string;
	requestDigest: string;
	brokerId: string;
	policyRevision: number;
}

/**
 * The protected lifetime for one snapshot. Only an authority mints one; the
 * brand keeps a caller from constructing it, and `HostAuthority.check` keeps
 * a forged object from passing at the sink.
 */
export interface DispatchLease {
	readonly [leaseBrand]: true;
	readonly leaseId: string;
	readonly authorityId: string;
	readonly snapshotDigest: string;
	/** The remote decision this lease was minted on, or null for an in-process one. */
	readonly decision: ManagedDecisionReceipt | null;
	readonly actor: ManagedPrincipalRef;
	readonly policyRevision: number | null;
	readonly runId: string | null;
	readonly attemptId: string;
	readonly issuedAt: string;
	/** An issued lease that is not bound by then is dead. A bound lease lives with its process. */
	readonly expiresAt: string;
	readonly effects: readonly DispatchEffect[];
	state(): LeaseState;
	/** The pid the lease is bound to, once `bind` has run. */
	pid(): number | undefined;
	/** The process exists: the protected lifetime begins. Once only. */
	bind(pid: number | undefined): void;
	/** The process is gone. Once only; a second call is ignored. */
	release(release: LeaseRelease): void;
	/** Hear a revocation while bound, so the sink stops the process. Returns the unsubscribe. */
	onRevoked(listener: (reason: string) => void): () => void;
	/** Why it is revoked or released, for the journal. */
	ended(): { state: LeaseState; reason: string | null; release: LeaseRelease | null };
}

export type LeaseVerdict =
	| { ok: true }
	| {
			ok: false;
			reason: 'forged' | 'expired' | 'revoked' | 'released' | 'snapshot-mismatch' | 'already-bound';
	  };

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface PolicySourceSet {
	sources: readonly ManagedPolicySource[];
	/** The revision the decision is made on; null when no source has one. */
	policyRevision: number | null;
}

export interface AdmissionRequest {
	context: ManagedAuthenticatedContext;
	snapshot: DispatchSnapshot;
	policy: PolicySourceSet;
}

/**
 * The host's answer. `denied` is a decision; `unavailable` means no decision
 * could be obtained (no authority, no policy, a fenced runtime); `unknown`
 * means a decision was requested and the answer was lost. Nothing but
 * `admitted` carries a lease, and nothing but a lease starts a process.
 */
export type AdmissionOutcome =
	| {
			state: 'admitted';
			lease: DispatchLease;
			policyRevision: number | null;
			receipt: ManagedDecisionReceipt | null;
	  }
	| { state: 'denied'; code: ManagedDenialCode; message: string; policyRevision: number | null }
	| { state: 'unavailable'; code: 'runtime-unavailable'; message: string }
	| { state: 'unknown'; code: 'outcome-unknown'; message: string };

export type PolicyDecision =
	| { decision: 'allow'; policyRevision: number | null; receipt?: ManagedDecisionReceipt }
	| { decision: 'deny'; reason: string; policyRevision: number | null; code?: ManagedDenialCode }
	| { decision: 'unavailable'; reason: string }
	| { decision: 'unknown'; reason: string };

export interface HostAuthority {
	readonly authorityId: string;
	/** Ask for a lease on exactly this snapshot. Never throws; a failure is an outcome. */
	admit(request: AdmissionRequest): Promise<AdmissionOutcome>;
	/**
	 * Synchronous, for the sink to call right before it spawns: is this a
	 * lease this authority minted, still live, for this exact snapshot?
	 */
	check(lease: DispatchLease, snapshotDigest: string): LeaseVerdict;
	/** Withdraw a live lease. A bound lease's sink stops its process. */
	revoke(leaseId: string, reason: string): boolean;
	revokeAll(reason: string): number;
	/** The leases this authority still holds live (issued or bound). */
	live(): readonly DispatchLease[];
}

export interface LocalHostAuthorityDeps {
	authorityId: string;
	/** The policy reader. Injected: a host wires its verified peer, a test wires a table. */
	decide(request: AdmissionRequest): PolicyDecision | Promise<PolicyDecision>;
	now(): number;
	newId(): string;
	/** How long an issued lease waits to be bound. Default one minute. */
	leaseTtlMs?: number;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * An in-process authority with injected policy. It owns the leases it mints
 * and nothing else: the decision is `decide`'s, the process is the sink's.
 */
export function createLocalHostAuthority(deps: LocalHostAuthorityDeps): HostAuthority {
	const ttl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
	const minted = new WeakSet<object>();
	const byId = new Map<string, DispatchLease>();
	const revokers = new Map<string, (reason: string) => boolean>();

	function mint(
		request: AdmissionRequest,
		policyRevision: number | null,
		decision: ManagedDecisionReceipt | null
	): DispatchLease {
		const issued = deps.now();
		let state: LeaseState = 'issued';
		let boundPid: number | undefined;
		let reason: string | null = null;
		let released: LeaseRelease | null = null;
		const listeners = new Set<(reason: string) => void>();
		const id = deps.newId();

		const lease: DispatchLease = {
			[leaseBrand]: true as const,
			leaseId: id,
			authorityId: deps.authorityId,
			snapshotDigest: dispatchSnapshotDigest(request.snapshot),
			decision,
			actor: request.context.actor,
			policyRevision,
			runId: request.context.identity.runId,
			attemptId: request.context.identity.attemptId,
			issuedAt: new Date(issued).toISOString(),
			expiresAt: new Date(issued + ttl).toISOString(),
			effects: request.snapshot.effects,
			state: () => {
				if (state === 'issued' && deps.now() > issued + ttl) return 'expired';
				return state;
			},
			pid: () => boundPid,
			bind(pid) {
				if (lease.state() !== 'issued') {
					throw new Error(`Lease ${id} cannot be bound while ${lease.state()}.`);
				}
				state = 'bound';
				boundPid = pid;
			},
			release(outcome) {
				if (state === 'released' || state === 'revoked') return;
				state = 'released';
				released = outcome;
				byId.delete(id);
			},
			onRevoked(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			ended: () => ({ state: lease.state(), reason, release: released }),
		};
		minted.add(lease);
		byId.set(id, lease);

		const revoke = (why: string): boolean => {
			const current = lease.state();
			if (current === 'released' || current === 'revoked') return false;
			state = 'revoked';
			reason = why;
			byId.delete(id);
			for (const listener of [...listeners]) listener(why);
			return true;
		};
		revokers.set(id, revoke);
		return lease;
	}

	return {
		authorityId: deps.authorityId,
		async admit(request) {
			if (!isVerifiedContext(request.context)) {
				return {
					state: 'denied',
					code: 'unauthenticated',
					message: 'The context was not bound by a verifier on this host.',
					policyRevision: null,
				};
			}
			if (request.snapshot.contractVersion !== MANAGED_CONTRACT_VERSION) {
				return {
					state: 'denied',
					code: 'version-unsupported',
					message: `The snapshot speaks ${request.snapshot.contractVersion}, this host ${MANAGED_CONTRACT_VERSION}.`,
					policyRevision: null,
				};
			}
			let decision: PolicyDecision;
			try {
				decision = await deps.decide(request);
			} catch (error) {
				return {
					state: 'unavailable',
					code: 'runtime-unavailable',
					message: `The policy reader failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			switch (decision.decision) {
				case 'allow': {
					const receipt = decision.receipt ?? null;
					return {
						state: 'admitted',
						lease: mint(request, decision.policyRevision, receipt),
						policyRevision: decision.policyRevision,
						receipt,
					};
				}
				case 'deny':
					return {
						state: 'denied',
						code: decision.code ?? 'policy-denied',
						message: decision.reason,
						policyRevision: decision.policyRevision,
					};
				case 'unavailable':
					return { state: 'unavailable', code: 'runtime-unavailable', message: decision.reason };
				case 'unknown':
					return { state: 'unknown', code: 'outcome-unknown', message: decision.reason };
			}
		},
		check(lease, snapshotDigest) {
			if (!minted.has(lease)) return { ok: false, reason: 'forged' };
			switch (lease.state()) {
				case 'expired':
					return { ok: false, reason: 'expired' };
				case 'revoked':
					return { ok: false, reason: 'revoked' };
				case 'released':
					return { ok: false, reason: 'released' };
				case 'bound':
					return { ok: false, reason: 'already-bound' };
				case 'issued':
					break;
			}
			if (lease.snapshotDigest !== snapshotDigest)
				return { ok: false, reason: 'snapshot-mismatch' };
			return { ok: true };
		},
		revoke: (leaseId, reason) => revokers.get(leaseId)?.(reason) ?? false,
		revokeAll(reason) {
			let count = 0;
			for (const id of [...byId.keys()]) if (revokers.get(id)?.(reason)) count += 1;
			return count;
		},
		live: () => [...byId.values()].filter((lease) => lease.state() !== 'expired'),
	};
}

/**
 * The authority of a host that has none it can reach: enrolled with no
 * endpoint, fenced off its data directory, or not yet given one. Every
 * admission is `unavailable`, never `denied` (no policy said no) and never
 * `admitted`. Every lease check fails as forged, since it minted none.
 */
export function unavailableAuthority(reason: string): HostAuthority {
	return {
		authorityId: 'unavailable',
		admit: async () => ({ state: 'unavailable', code: 'runtime-unavailable', message: reason }),
		check: () => ({ ok: false, reason: 'forged' }),
		revoke: () => false,
		revokeAll: () => 0,
		live: () => [],
	};
}
