/**
 * useManagedStatus - the managed standing of this desktop, for a settings pane
 * or a status pill (MRC-11-03).
 *
 * Reads `window.maestro.enterprise.managedState()` through the cached-resource
 * store, so a pane that unmounts and remounts draws the last answer at once and
 * refreshes it in place, and polls while mounted so an endpoint that comes
 * back, suspends or denies is seen without a click. Three answers are kept
 * apart: `supported: false` is a browser (the web-desktop bridge has no
 * `enterprise` namespace), `state === null` is a desktop running no enrollment
 * service, and a `state` is the projection itself (`src/main/enterprise/managed-state.ts`).
 *
 * `run(verb)` is the pane's one way to act: it invokes one of the narrow
 * lifecycle verbs and refreshes the standing afterward. The approval handoff a
 * recovery returns is handed back once and never kept here. Nothing here can
 * switch management off: the verbs refresh, recover and complete; leaving a
 * managed record is refused by the main process by name.
 */

import { useCallback, useEffect } from 'react';
import type {
	LifecycleOutcome,
	RegistrationApprovalHandoff,
} from '../../../main/enterprise/enrollment';
import type { ManagedStanding, ManagedStateView } from '../../../main/enterprise/managed-state';
import type { PolicyRecovery } from '../../../main/enterprise/policy-status';
import { useCachedResource } from '../utils/useCachedResource';

export const MANAGED_STATE_RESOURCE_KEY = 'enterprise:managedState';
/** How often a mounted pane re-reads the standing. */
export const MANAGED_STATE_POLL_MS = 30_000;

/** The one place the standing words are spelled out; every surface reads them from here. */
export const MANAGED_STANDING_COPY: Record<ManagedStanding, { label: string; detail: string }> = {
	managed: {
		label: 'Managed',
		detail: 'Enrolled, registered and attached; the endpoint applies its policy to this desktop.',
	},
	stale: {
		label: 'Stale',
		detail: 'Registered, but the policy observation is older than the freshness window.',
	},
	unregistered: {
		label: 'Registration needed',
		detail: 'Attached, but this process holds no actor registration the endpoint approved.',
	},
	offline: {
		label: 'Offline',
		detail: 'Enrolled with no endpoint connection; the installed policy stays in force.',
	},
	denied: {
		label: 'Denied',
		detail: 'The endpoint refused the last request; see the denial below.',
	},
	suspended: {
		label: 'Suspended',
		detail: 'The endpoint has suspended this installation; managed execution is refused.',
	},
	enrolling: {
		label: 'Enrolling',
		detail: 'An enrollment is pending the endpoint administrator.',
	},
	revoked: {
		label: 'Revoked',
		detail: 'The enrollment was revoked; the record is kept as evidence.',
	},
	retired: {
		label: 'Retired',
		detail: 'The installation was retired; the record is kept as evidence.',
	},
	'custody-refused': {
		label: 'Custody refused',
		detail: 'The sealed identity cannot be trusted on this device; nothing managed runs.',
	},
	unenrolled: {
		label: 'Not enrolled',
		detail: 'This desktop holds no enrollment and runs unmanaged.',
	},
};

export type ManagedActionVerb = 'refreshPolicy' | 'recoverPolicy' | 'completeRegistration';

export interface ManagedActionResult {
	status:
		| 'ok'
		| 'approval-required'
		| 'not-needed'
		| 'refused'
		| 'denied'
		| 'unsupported'
		| 'unavailable'
		| 'unknown';
	message: string;
	/** Shown once by the caller; never stored. */
	handoff: RegistrationApprovalHandoff | null;
}

const OK_MESSAGE: Record<ManagedActionVerb, string> = {
	refreshPolicy: 'Policy refreshed from the endpoint.',
	recoverPolicy: 'Standing recovered: the endpoint re-attached.',
	completeRegistration: 'Registration completed; the endpoint re-attached.',
};

/** One sentence and one status word for whatever a lifecycle verb answered. */
export function describeManagedOutcome(
	verb: ManagedActionVerb,
	outcome: LifecycleOutcome<unknown> | PolicyRecovery
): ManagedActionResult {
	switch (outcome.status) {
		case 'ok':
		case 'refreshed':
			return { status: 'ok', message: OK_MESSAGE[verb], handoff: null };
		case 'approval-required':
			return {
				status: 'approval-required',
				message: 'Approve this registration in the Mega-Maestro console with the code below.',
				handoff: outcome.handoff,
			};
		case 'not-needed':
			return {
				status: 'not-needed',
				message: 'Nothing to recover: the standing is registered.',
				handoff: null,
			};
		case 'denied':
			return {
				status: 'denied',
				message: `The endpoint denied ${outcome.operation}: ${outcome.reason}.`,
				handoff: null,
			};
		case 'refused':
		case 'unsupported':
		case 'unavailable':
		case 'unknown':
			return { status: outcome.status, message: outcome.message, handoff: null };
	}
}

export interface UseManagedStatusResult {
	/** False in a browser: the web-desktop bridge has no `enterprise` namespace. */
	supported: boolean;
	/** Undefined before the first read, null when no service runs in this desktop. */
	state: ManagedStateView | null | undefined;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	fetchedAt: number;
	refresh: () => Promise<void>;
	run: (verb: ManagedActionVerb) => Promise<ManagedActionResult>;
}

export function useManagedStatus(options: { pollMs?: number } = {}): UseManagedStatusResult {
	const api = window.maestro?.enterprise;
	const supported = typeof api?.managedState === 'function';
	const pollMs = options.pollMs ?? MANAGED_STATE_POLL_MS;
	const resource = useCachedResource<ManagedStateView | null>(
		supported ? MANAGED_STATE_RESOURCE_KEY : null,
		() => api.managedState()
	);
	const { refresh } = resource;

	useEffect(() => {
		if (!supported || pollMs <= 0) return;
		const timer = setInterval(() => void refresh(), pollMs);
		return () => clearInterval(timer);
	}, [supported, pollMs, refresh]);

	const run = useCallback(
		async (verb: ManagedActionVerb): Promise<ManagedActionResult> => {
			if (!supported) {
				return {
					status: 'unavailable',
					message: 'Mega-Maestro management is available in the desktop app.',
					handoff: null,
				};
			}
			const outcome = await api[verb]();
			await refresh();
			return describeManagedOutcome(verb, outcome);
		},
		[api, supported, refresh]
	);

	return {
		supported,
		state: resource.data,
		loading: resource.loading,
		refreshing: resource.refreshing,
		error: resource.error,
		fetchedAt: resource.fetchedAt,
		refresh,
		run,
	};
}
