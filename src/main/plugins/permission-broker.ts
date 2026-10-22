/**
 * Permission broker (main process).
 *
 * The single authorization gate between a sandboxed plugin's RPC calls and the
 * host. For every HostRequest it resolves the required capability and the call's
 * target, then checks the plugin's granted permissions with the pure
 * default-deny matcher. It does NOT execute the call - the sandbox host does
 * that only after `authorize` returns allowed. Keeping authorization separate
 * from execution means this gate can be unit-tested exhaustively without any
 * Electron or fs.
 *
 * Under management (MRC-09-01) the broker also intersects local consent with
 * the signed plugin ceiling the host is under. The order is structural: the
 * live grant (the user's consent, read from the sealed ledger each call) and
 * the protected-location exclusion decide first, and only an allowed call is
 * then held against the ceiling. A ceiling therefore narrows consent and never
 * manufactures it, never rewrites the ledger and never replaces the sandbox,
 * protected-target, trust or unattended gates the handlers keep. The ceiling
 * names the exact plugin it admits (content digest, publisher key, signature
 * status) and the capabilities and scopes it is confined to; a plugin whose
 * consented identity differs, a revoked plugin or publisher, a capability or
 * target outside the ceiling, and a host with no usable ceiling are all denied
 * by name. Release and cancellation methods stay exempt, as they are locally,
 * so a revocation never blocks letting go of a resource.
 *
 * A resource a plugin KEEPS (a retained service call, a delegated media lease,
 * an open socket, a watched path) is re-checked while it lives, and that
 * check has no RPC method in flight: the service host asks about a capability
 * and the resource's own target (a provider/service pair, a media profile) for
 * both principals of a call and on every sweep while the call is retained.
 * `holds()` (MRC-09-03) is that check: the same grant matcher, the same
 * protected-location exclusion and the same ceiling, in the same order, so a
 * ceiling narrowed or a plugin revoked centrally mid-call ends the lease the
 * way a local revoke does, and a standalone host answers from consent alone.
 * The desktop's ceiling comes from `src/main/enterprise/plugin-policy.ts`.
 */

import {
	isPermitted,
	type PluginCapability,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import {
	HOST_METHOD_CAPABILITY,
	HANDLER_REAUTHORIZED_METHODS,
	extractTarget,
	type HostMethod,
} from '../../shared/plugins/rpc-protocol';
import type { SignatureStatus } from '../../shared/plugins/signing';
import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import type { AuthIdentity, PluginConsentView } from './authorization-ledger';

/** One capability a ceiling admits for a plugin, confined to the scopes it names. */
export interface PluginCeilingCapability {
	capability: PluginCapability;
	/** Scope ceilings in the capability's own scope form (path prefixes, host
	 * suffixes, allowlist members). Absent on a path/host capability means the
	 * broadest form; an allowlist capability with no scopes admits nothing. */
	scopes?: readonly string[];
}

/** The exact plugin a signed ceiling admits, and what it admits for it. */
export interface PluginCeilingEntry {
	pluginId: string;
	/** The content digest the ceiling was issued for (`AuthIdentity.contentHash`). */
	contentHash: string;
	/** The publisher key the ceiling was issued for; null for an unsigned plugin. */
	signerKey: string | null;
	/** When named, the signature status the ceiling requires. */
	signatureStatus?: SignatureStatus;
	capabilities: readonly PluginCeilingCapability[];
	/** A central revoke of this plugin: denied regardless of consent. */
	revoked?: boolean;
}

/** The signed plugin ceiling of one policy revision. */
export interface PluginPolicyCeiling {
	policyRevision: number;
	plugins: readonly PluginCeilingEntry[];
	/** Publisher keys revoked outright: every plugin they signed is denied. */
	revokedPublishers?: readonly string[];
}

/** What the broker is told about the host's managed standing, read live on every call. */
export type ManagedPluginStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: PluginPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

export type PluginCeilingOutcome =
	| 'within-ceiling'
	| 'outside-ceiling'
	| 'identity-mismatch'
	| 'revoked'
	| 'unavailable';

/** The managed half of a decision: which ceiling it was held against and how it fared. */
export interface PluginCeilingReceipt {
	policyRevision: number | null;
	outcome: PluginCeilingOutcome;
	/** The consented identity the ceiling was bound to (null when none was readable). */
	contentHash: string | null;
	signerKey: string | null;
	/** The ledger epoch the consent was minted at, when the ledger recorded one. */
	consentEpoch: number | null;
}

export interface BrokerDecision {
	allowed: boolean;
	capability: PluginCapability;
	/** The resolved scope target (path/host), when the capability is scoped. */
	target?: string;
	/** Why the call was denied (empty when allowed). */
	reason?: string;
	/** Present on a managed host for every call the ceiling was consulted on. */
	managed?: PluginCeilingReceipt;
}

/** What a decision is audited under: the RPC method, or the capability a live hold re-checked. */
export type BrokerAuditKey = HostMethod | PluginCapability;

export interface PermissionBrokerDeps {
	/** Returns the live grants for a plugin (re-read each call so a revoked grant
	 * takes effect immediately, mirroring the Encore-flag re-read pattern). */
	getGrants: (pluginId: string) => PermissionGrant[];
	/** Optional audit sink for RPC decisions and live holds (allow and deny);
	 * host-only polling can opt out. A hold is keyed by its capability. */
	onDecision?: (pluginId: string, method: BrokerAuditKey, decision: BrokerDecision) => void;
	/** Absolute directory prefixes that fs:read AND fs:write must NEVER touch -
	 * the userData/config tree (grants, enable-state, encoreFeatures settings,
	 * agent-configs, cli-server.json, the plugins dir, plugin KV, supervisor
	 * targets, transcripts). Re-read each call. The integrator passes the real,
	 * resolved userData path(s). Enforced AFTER the grant check, so a broad fs
	 * grant can never reach into the data dir; because the fs handlers re-call
	 * authorize() with the symlink-resolved REAL path, the exclusion also holds
	 * post-resolution (a symlink inside a granted scope cannot escape into it). */
	protectedPaths?: () => readonly string[];
	/** The host's managed standing, re-read each call. Absent or standalone:
	 * local consent alone decides, as before. */
	managed?: () => ManagedPluginStanding;
	/** The consented authorization (grants plus the identity bound at consent),
	 * read from the sealed ledger. The ceiling is bound to this identity, never
	 * to the folder on disk. Required on a managed host: without it no identity
	 * can be bound and every ceiling check denies. */
	getConsent?: (pluginId: string) => PluginConsentView | null;
}

/**
 * Normalize a path for protected-prefix comparison: forward slashes, no trailing
 * separator, and case-folded on Windows (its filesystem is case-insensitive).
 */
function normalizeForPrefix(p: string): string {
	let out = p.replace(/\\/g, '/').replace(/\/+$/, '');
	if (out === '') out = '/';
	return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** Is `target` equal to or inside any protected prefix? Separator-boundary
 * match so `/data/userdata-plugins` does not match prefix `/data/userdata`. */
function isUnderProtectedPath(target: string, prefixes: readonly string[]): boolean {
	const t = normalizeForPrefix(target);
	for (const prefix of prefixes) {
		const p = normalizeForPrefix(prefix);
		if (t === p || t.startsWith(p === '/' ? '/' : `${p}/`)) return true;
	}
	return false;
}

/** Release ownership and status of an own declared requirement are checked in
 * the handlers. Revocation (local or central) must not block cancellation. */
const RELEASE_METHODS: ReadonlySet<HostMethod> = new Set<HostMethod>([
	'media.close',
	'services.cancel',
	'services.status',
]);

/**
 * Project the host's policy status and the installed ceiling onto the standing
 * the broker reads. `enrolled` is the same rule the spawn authority uses (an
 * identity record exists); from then on there is no way back to standalone.
 * The ceiling is only usable for the policy revision the host is under: an
 * unknown applied revision, no installed ceiling, or a ceiling issued for
 * another revision each name why the host refuses.
 */
export function managedPluginStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: PluginPolicyCeiling | null;
}): ManagedPluginStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	if (revision === null) {
		return {
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		};
	}
	if (!input.ceiling) {
		return {
			standing: 'managed',
			ceiling: null,
			policyRevision: revision,
			reason: `no plugin ceiling is installed for policy revision ${revision}`,
		};
	}
	if (input.ceiling.policyRevision !== revision) {
		return {
			standing: 'managed',
			ceiling: null,
			policyRevision: revision,
			reason: `the installed plugin ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`,
		};
	}
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

/** The ceiling entry's admitted capability as grants the pure matcher understands. */
function ceilingGrants(entry: PluginCeilingEntry, capability: PluginCapability): PermissionGrant[] {
	const out: PermissionGrant[] = [];
	for (const admitted of entry.capabilities) {
		if (admitted.capability !== capability) continue;
		if (!admitted.scopes || admitted.scopes.length === 0) {
			out.push({ capability, grantedAt: 0 });
			continue;
		}
		for (const scope of admitted.scopes) out.push({ capability, scope, grantedAt: 0 });
	}
	return out;
}

function consentMatches(entry: PluginCeilingEntry, identity: AuthIdentity): boolean {
	if (entry.contentHash !== identity.contentHash) return false;
	if (entry.signerKey !== identity.signerKey) return false;
	if (entry.signatureStatus !== undefined && entry.signatureStatus !== identity.signatureStatus)
		return false;
	return true;
}

interface CeilingVerdict {
	allowed: boolean;
	reason?: string;
	receipt: PluginCeilingReceipt;
}

/**
 * Hold one locally allowed call against the ceiling. Pure: the standing and
 * the consent view are what the caller read for this call. `method` is
 * undefined for a live hold on a kept resource: no method is in flight, so
 * the admitted scopes are matched against the resource's own target.
 */
export function ceilingVerdict(input: {
	pluginId: string;
	method: HostMethod | undefined;
	capability: PluginCapability;
	target: string | undefined;
	standing: Exclude<ManagedPluginStanding, { standing: 'standalone' }>;
	consent: PluginConsentView | null;
}): CeilingVerdict {
	const { pluginId, method, capability, target, standing, consent } = input;
	const receipt = (outcome: PluginCeilingOutcome): PluginCeilingReceipt => ({
		policyRevision: standing.policyRevision,
		outcome,
		contentHash: consent?.identity.contentHash ?? null,
		signerKey: consent?.identity.signerKey ?? null,
		consentEpoch: consent?.epoch ?? null,
	});
	const deny = (outcome: PluginCeilingOutcome, why: string): CeilingVerdict => ({
		allowed: false,
		reason: `permission denied: ${capability}${target ? ` (${target})` : ''}: ${why}`,
		receipt: receipt(outcome),
	});
	if (!standing.ceiling) {
		return deny('unavailable', `the managed plugin ceiling is unavailable (${standing.reason})`);
	}
	const { ceiling, policyRevision } = standing;
	const entry = ceiling.plugins.find((p) => p.pluginId === pluginId);
	if (!entry) {
		return deny(
			'outside-ceiling',
			`"${pluginId}" is not within the managed plugin ceiling of policy revision ${policyRevision}`
		);
	}
	if (!consent) {
		return deny(
			'identity-mismatch',
			'no consented plugin identity is readable to bind the ceiling to'
		);
	}
	const revokedPublishers = ceiling.revokedPublishers ?? [];
	const publisherRevoked = (key: string | null) => key !== null && revokedPublishers.includes(key);
	if (
		entry.revoked ||
		publisherRevoked(entry.signerKey) ||
		publisherRevoked(consent.identity.signerKey)
	) {
		return deny(
			'revoked',
			`"${pluginId}" is revoked by the managed plugin ceiling of policy revision ${policyRevision}`
		);
	}
	if (!consentMatches(entry, consent.identity)) {
		return deny(
			'identity-mismatch',
			`the managed plugin ceiling names a different content digest, publisher or signature status for "${pluginId}" than the one consented to`
		);
	}
	const admitted = ceilingGrants(entry, capability);
	const within =
		method !== undefined && HANDLER_REAUTHORIZED_METHODS.has(method)
			? admitted.length > 0
			: isPermitted(admitted, capability, target);
	if (!within) {
		return deny(
			'outside-ceiling',
			`${capability} is outside the managed plugin ceiling for "${pluginId}" (policy revision ${policyRevision})`
		);
	}
	return { allowed: true, receipt: receipt('within-ceiling') };
}

export class PermissionBroker {
	constructor(private readonly deps: PermissionBrokerDeps) {}

	/**
	 * Authorize one host call. Default deny: returns allowed only when a matching
	 * grant covers the capability and (for scoped capabilities) the target, and,
	 * on a managed host, the call is within the ceiling bound to the consented
	 * plugin identity. Host-owned liveness checks may suppress the RPC audit
	 * without changing authorization.
	 */
	authorize(
		pluginId: string,
		method: HostMethod,
		params: unknown,
		options?: { audit?: boolean }
	): BrokerDecision {
		const capability = HOST_METHOD_CAPABILITY[method];
		const target = extractTarget(method, params);
		const grants = this.deps.getGrants(pluginId);
		let allowed: boolean;
		let reason: string | undefined;
		if (RELEASE_METHODS.has(method)) {
			allowed = true;
		} else if (HANDLER_REAUTHORIZED_METHODS.has(method)) {
			// Scope lives in an already-open resource the params reference by opaque
			// id, not here. Confirm only that the capability is held; the host handler
			// re-authorizes the resource's real origin against the live grant. Without
			// this, a scoped grant (the recommended form) would be denied for a
			// missing target even though the operation is in-scope.
			allowed = grants.some((g) => g.capability === capability);
			reason = allowed ? undefined : `permission denied: ${capability}`;
		} else {
			allowed = isPermitted(grants, capability, target);
			reason = allowed ? undefined : deniedReason(capability, target);
		}
		const decision = this.narrow(pluginId, {
			method,
			capability,
			target,
			allowed,
			reason,
			exempt: RELEASE_METHODS.has(method),
		});
		if (options?.audit !== false) this.deps.onDecision?.(pluginId, method, decision);
		return decision;
	}

	/**
	 * Hold a capability a plugin is EXERCISING against the live grant and, on a
	 * managed host, the ceiling. No RPC method is in flight: the service host
	 * asks this for both principals of a service call (`services:call` on the
	 * caller's provider/service pair, `services:provide` and the fixed media
	 * profiles on the provider) when a call is bound and on every sweep while
	 * it is retained, so a grant revoked locally, a plugin or publisher revoked
	 * centrally or a ceiling narrowed to exclude the pair ends the call the
	 * same way. Same order as `authorize`: grant, protected location, ceiling.
	 * A standalone host answers exactly what the pure matcher answers. Audited
	 * under the capability; a host-owned sweep passes `audit: false`.
	 */
	holds(
		pluginId: string,
		capability: PluginCapability,
		target?: string,
		options?: { audit?: boolean }
	): BrokerDecision {
		const allowed = isPermitted(this.deps.getGrants(pluginId), capability, target);
		const decision = this.narrow(pluginId, {
			method: undefined,
			capability,
			target,
			allowed,
			reason: allowed ? undefined : deniedReason(capability, target),
			exempt: false,
		});
		if (options?.audit !== false) this.deps.onDecision?.(pluginId, capability, decision);
		return decision;
	}

	/**
	 * The two gates every locally allowed call and hold then pass, in order:
	 * the protected-location exclusion, then the managed ceiling. Neither can
	 * allow; each can only narrow.
	 */
	private narrow(
		pluginId: string,
		input: {
			method: HostMethod | undefined;
			capability: PluginCapability;
			target: string | undefined;
			allowed: boolean;
			reason: string | undefined;
			/** A release or cancellation: never held against the ceiling. */
			exempt: boolean;
		}
	): BrokerDecision {
		const { capability, target } = input;
		let { allowed, reason } = input;

		// Structural data-dir exclusion: fs:read AND fs:write can never touch the
		// userData/config tree, regardless of how broad the grant is. Applied to
		// whatever path the caller passed - including the symlink-resolved REAL
		// path the fs handlers re-authorize with - so it holds post-resolution.
		if (allowed && (capability === 'fs:read' || capability === 'fs:write') && target) {
			const protectedPaths = this.deps.protectedPaths?.() ?? [];
			if (isUnderProtectedPath(target, protectedPaths)) {
				allowed = false;
				reason = `permission denied: ${capability} into a protected location (${target})`;
			}
		}

		// The managed ceiling narrows an allowed call and nothing else: a call
		// consent or the protected-location rule denied is denied already, and a
		// release method is never held against it.
		let managed: PluginCeilingReceipt | undefined;
		if (allowed && !input.exempt) {
			const standing = this.deps.managed?.();
			if (standing && standing.standing === 'managed') {
				const verdict = ceilingVerdict({
					pluginId,
					method: input.method,
					capability,
					target,
					standing,
					consent: this.deps.getConsent?.(pluginId) ?? null,
				});
				managed = verdict.receipt;
				if (!verdict.allowed) {
					allowed = false;
					reason = verdict.reason;
				}
			}
		}

		return {
			allowed,
			capability,
			...(target !== undefined ? { target } : {}),
			...(reason !== undefined ? { reason } : {}),
			...(managed !== undefined ? { managed } : {}),
		};
	}
}

function deniedReason(capability: PluginCapability, target: string | undefined): string {
	return `permission denied: ${capability}${target ? ` (${target})` : ''}`;
}
