/**
 * Policy status for the desktop and the CLI: what policy this installation is
 * under, how fresh that knowledge is, and the two authenticated ways to make
 * it fresher.
 *
 * The projection itself (`projectPolicyStatus`) is the library's, so a
 * headless host reads the same answer; this module binds it to the
 * enrollment lifecycle and names the only update and recovery paths Maestro
 * has:
 *
 *   - `refresh()` re-attaches over the registered socket. The attachment
 *     answer is where the endpoint states its desired and applied revisions,
 *     so a successful attach is an authenticated status update, and the
 *     lifecycle writes what it heard into the sealed record.
 *   - `recover()` is for a standing the refresh cannot repair: no actor
 *     registration in this process (a restart), or an endpoint that refused
 *     the attachment as unauthenticated (a revoked or expired registration).
 *     It opens a new registration challenge, which the actor must approve in
 *     the browser; the handoff goes back to the caller. Nothing here approves
 *     anything on the actor's behalf, and nothing here provisions, installs
 *     or recovers policy on the endpoint: those are the endpoint
 *     administrator's verbs on the endpoint's own tooling.
 *
 * Offline, the record's last applied revision stays the installed policy and
 * the projection says so (`installed-policy-only`); it never bootstraps a
 * standalone answer. A stale observation, a lapsed registration or a lapsed
 * approval is projected as a reason admission is not possible, which is also
 * exactly what the host adapter refuses on.
 */

import type { EndpointStatus } from '../../shared/maestro-lib/managed/endpoint-port';
import {
	POLICY_FRESHNESS_MS,
	projectPolicyStatus,
	type ManagedPolicyStatus,
} from '../../shared/maestro-lib/managed/host-adapter';
import type {
	EnrollmentLifecycle,
	LifecycleOutcome,
	RegistrationApprovalHandoff,
} from './enrollment';

export interface PolicyStatusServiceDeps {
	lifecycle: EnrollmentLifecycle;
	now?: () => number;
	/** How long an attachment answer counts as fresh. Default `POLICY_FRESHNESS_MS`. */
	freshnessMs?: number;
}

export type PolicyRecovery =
	| { status: 'refreshed'; value: EndpointStatus }
	| { status: 'approval-required'; handoff: RegistrationApprovalHandoff }
	| { status: 'not-needed' }
	| Exclude<LifecycleOutcome<never>, { status: 'ok' }>;

export interface PolicyStatusService {
	status(): ManagedPolicyStatus;
	/** An authenticated status update: re-attach over the registered socket. */
	refresh(): Promise<LifecycleOutcome<EndpointStatus>>;
	/**
	 * Repair a standing a refresh cannot: open a new actor registration when
	 * this process holds none or the endpoint refused the last one; otherwise
	 * refresh. The approval handoff, when one is returned, is the actor's to
	 * complete through `completeRegistration` on the lifecycle.
	 */
	recover(): Promise<PolicyRecovery>;
}

export function createPolicyStatusService(deps: PolicyStatusServiceDeps): PolicyStatusService {
	const now = deps.now ?? (() => Date.now());
	const freshnessMs = deps.freshnessMs ?? POLICY_FRESHNESS_MS;

	return {
		status: () =>
			projectPolicyStatus({ standing: deps.lifecycle.status(), now: now(), freshnessMs }),

		refresh: () => deps.lifecycle.connect(),

		async recover() {
			const before = deps.lifecycle.status();
			if (before.identity.status !== 'ok') {
				return {
					status: 'refused',
					reason: before.identity.status === 'none' ? 'not-enrolled' : 'custody-untrusted',
					message: before.identity.message ?? 'This installation holds no enrollment.',
				};
			}
			const registrationMissing =
				!before.connection ||
				before.connection.registration !== 'registered' ||
				before.lastDenial?.reason === 'unauthenticated';
			if (!registrationMissing) {
				const refreshed = await deps.lifecycle.connect();
				return refreshed.status === 'ok'
					? { status: 'refreshed', value: refreshed.value }
					: refreshed;
			}
			const begun = await deps.lifecycle.beginRegistration();
			if (begun.status !== 'ok') return begun;
			return { status: 'approval-required', handoff: begun.value };
		},
	};
}
