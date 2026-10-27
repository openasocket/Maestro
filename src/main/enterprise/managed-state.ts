/**
 * The managed standing of this installation as one narrow answer for a
 * settings pane, a diagnostics line or a CLI verb (MRC-11-03).
 *
 * `enterprise:status`, `enterprise:policyStatus` and `enterprise:inventory`
 * already cross the bridge, but a pane that wants to say "managed", "offline"
 * or "denied" had to derive that word from three answers, and every surface
 * would derive it differently. This module names the vocabulary once
 * (`ManagedStanding`) and projects the facts a person reads beside it: who
 * manages this installation, what the endpoint answered last, whether this
 * process holds an actor registration, which policy is applied and how fresh
 * that is, which capabilities were negotiated, whether management can be
 * left locally, and what the egress ceiling has refused (once per class, code
 * and origin, from the chokepoint's own ledger; MRC2-05-03). A projection,
 * never authority: a sink admits on the host adapter's standing, not on the
 * word shown here. No path, digest or secret of the sealed record is in it.
 *
 * Local release (`localReleaseOf`) is the one rule the IPC applies before an
 * explicit local transition (`retire`, `acknowledgeRevocation`) or an identity
 * clear. A record the endpoint still manages (`enrolling`, `enrolled`,
 * `suspended`) is released by the endpoint administrator with the endpoint's
 * own tooling (CP-04), which this host learns of from an attached answer that
 * reports the installation `unenrolled`; until then, offline, stale or denied
 * included, leaving management locally is refused by name. A `revoked` or
 * `retired` record is final and may be forgotten; a custody refusal keeps the
 * store's own gate (`acknowledgeUntrusted`).
 */

import type {
	EndpointCollectionProfile,
	EndpointConnectivity,
	EndpointManagementState,
	EndpointRegistrationPhase,
	LocalEndpointDenialReason,
	ManagedEnrollmentStatus,
	ManagedIdentityManagement,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import type { EgressHold } from '../utils/fetchWithTimeout';
import type { IdentityCustodyState } from './identity-store';

/** One word for the standing, in the order a pane sorts them from best to worst. */
export type ManagedStanding =
	| 'managed'
	| 'stale'
	| 'unregistered'
	| 'offline'
	| 'denied'
	| 'suspended'
	| 'enrolling'
	| 'revoked'
	| 'retired'
	| 'custody-refused'
	| 'unenrolled';

export interface ManagedStateView {
	at: string;
	standing: ManagedStanding;
	/** Why authority is none, in the lifecycle's own sentence; null when it is registered. */
	reason: string | null;
	custody: {
		state: IdentityCustodyState['state'];
		record: ManagedEnrollmentStatus['identity']['status'];
		message: string | null;
	};
	enrollment: {
		installationId: string;
		tenantId: string;
		orgId: string;
		enrollmentId: string | null;
		management: ManagedIdentityManagement;
		enrolledAt: string;
		updatedAt: string;
	} | null;
	endpoint: {
		attached: boolean;
		management: EndpointManagementState | null;
		connectivity: EndpointConnectivity | 'detached';
		collectionProfile: EndpointCollectionProfile | null;
		lastDenial: { at: string; operation: string; reason: LocalEndpointDenialReason } | null;
	};
	actor: {
		/** The registration this process redeemed, as the connection observed it. */
		phase: EndpointRegistrationPhase;
		/** The actor the endpoint named on the record's registration; null until it does (CP-01, CP-04). */
		actorId: string | null;
		registration: ManagedPolicyStatus['registration'];
		approval: ManagedPolicyStatus['approval'];
	};
	policy: Pick<
		ManagedPolicyStatus,
		| 'desiredRevision'
		| 'appliedRevision'
		| 'installedRevision'
		| 'source'
		| 'freshness'
		| 'observedAt'
		| 'converged'
		| 'offline'
		| 'admission'
	>;
	capabilities: {
		/** What this host offers the endpoint. */
		supported: readonly string[];
		/** What the endpoint negotiated on the last attached answer. */
		negotiated: readonly string[];
		/** Supported here, not negotiated there. */
		missing: readonly string[];
	};
	/** What the egress ceiling refused since it was installed, once per class, code and origin: a quiet record, never a toast. */
	egress: { held: readonly EgressHold[] };
	localRelease: LocalRelease;
}

export type LocalRelease =
	| { allowed: true; reason: 'no-record' | 'final' | 'released' }
	| { allowed: false; reason: 'required'; message: string };

/**
 * Whether this host may leave management on its own: forget the record, or
 * record a local `retired` / `revoked` transition. The endpoint's release is
 * the only thing that opens it for a managed record.
 */
export function localReleaseOf(status: ManagedEnrollmentStatus): LocalRelease {
	const record = status.identity.status === 'ok' ? status.identity.record : null;
	if (!record) return { allowed: true, reason: 'no-record' };
	if (record.management === 'revoked' || record.management === 'retired') {
		return { allowed: true, reason: 'final' };
	}
	const live = status.connection?.attached ? status.endpoint : null;
	if (live?.management === 'unenrolled') return { allowed: true, reason: 'released' };
	return {
		allowed: false,
		reason: 'required',
		message:
			`Management of this installation by ${record.orgId} (${record.tenantId}) is required: ` +
			'the record is ' +
			record.management +
			' and the endpoint has not released it. Release is performed by the endpoint administrator ' +
			'with the endpoint tooling; it cannot be switched off here, offline or otherwise.',
	};
}

/** The one word for the standing, from the lifecycle's status and the policy projection. */
export function managedStandingOf(
	status: ManagedEnrollmentStatus,
	policy: Pick<ManagedPolicyStatus, 'freshness'>
): ManagedStanding {
	const identity = status.identity;
	if (identity.status === 'unprotected' || identity.status === 'untrusted')
		return 'custody-refused';
	const record = identity.status === 'ok' ? identity.record : null;
	if (!record) return 'unenrolled';
	switch (record.management) {
		case 'revoked':
			return 'revoked';
		case 'retired':
			return 'retired';
		case 'suspended':
			return 'suspended';
		case 'enrolling':
			return 'enrolling';
		case 'enrolled':
			break;
	}
	if (status.authority === 'registered') return policy.freshness === 'fresh' ? 'managed' : 'stale';
	const attached = status.connection?.attached === true && !status.connection.closed;
	const live = attached ? status.endpoint : null;
	if (live?.management === 'suspended') return 'suspended';
	// A denial after the last accepted attachment is the current word; an older one is history.
	const observed = record.policy.observedAt ? Date.parse(record.policy.observedAt) : -Infinity;
	if (status.lastDenial && Date.parse(status.lastDenial.at) > observed) return 'denied';
	if (!attached) return 'offline';
	return 'unregistered';
}

export interface ManagedStateInput {
	status: ManagedEnrollmentStatus;
	policy: ManagedPolicyStatus;
	custody: IdentityCustodyState;
	/** What this host offers the endpoint (`ENTERPRISE_SUPPORTED_CAPABILITIES`). */
	supported: readonly string[];
	/** The chokepoint's ledger (`heldEgress()`); absent reads as nothing refused. */
	egress?: readonly EgressHold[];
	now?: number;
}

export function projectManagedState(input: ManagedStateInput): ManagedStateView {
	const { status, policy, custody } = input;
	const record = status.identity.status === 'ok' ? status.identity.record : null;
	const attached = status.connection?.attached === true && !status.connection.closed;
	const live = attached ? status.endpoint : null;
	const negotiated = live?.capabilities ?? [];
	return {
		at: new Date(input.now ?? Date.now()).toISOString(),
		standing: managedStandingOf(status, policy),
		reason: status.reason,
		custody: {
			state: custody.state,
			record: status.identity.status,
			message: custody.state === 'unprotected' ? custody.message : status.identity.message,
		},
		enrollment: record
			? {
					installationId: record.installationId,
					tenantId: record.tenantId,
					orgId: record.orgId,
					enrollmentId: record.enrollmentId,
					management: record.management,
					enrolledAt: record.enrolledAt,
					updatedAt: record.updatedAt,
				}
			: null,
		endpoint: {
			attached,
			management: live?.management ?? null,
			connectivity: live?.connectivity ?? 'detached',
			collectionProfile: live?.collectionProfile ?? null,
			lastDenial: status.lastDenial,
		},
		actor: {
			phase: status.connection?.registration ?? 'none',
			actorId: record?.registration?.actorId ?? null,
			registration: policy.registration,
			approval: policy.approval,
		},
		policy: {
			desiredRevision: policy.desiredRevision,
			appliedRevision: policy.appliedRevision,
			installedRevision: policy.installedRevision,
			source: policy.source,
			freshness: policy.freshness,
			observedAt: policy.observedAt,
			converged: policy.converged,
			offline: policy.offline,
			admission: policy.admission,
		},
		capabilities: {
			supported: [...input.supported],
			negotiated: [...negotiated],
			missing: input.supported.filter((name) => !negotiated.includes(name)),
		},
		egress: { held: (input.egress ?? []).map((hold) => ({ ...hold })) },
		localRelease: localReleaseOf(status),
	};
}
