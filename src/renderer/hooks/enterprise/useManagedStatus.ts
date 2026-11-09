/**
 * useManagedStatus - the managed standing of this desktop, for a settings pane
 * or a status pill (MRC-11-03).
 *
 * Reads `window.maestro.enterprise.managedState()` through the cached-resource
 * store, so a pane that unmounts and remounts draws the last answer at once and
 * refreshes it in place, and polls while mounted so an endpoint that comes
 * back, suspends or denies is seen without a click. Three answers are kept
 * apart: `supported: false` is a surface with no `enterprise` API at all,
 * `state === null` is a desktop running no enrollment service, and a `state`
 * is the projection itself (`src/main/enterprise/managed-state.ts`). A browser
 * reads the state over the bridge (MRC2-07-03); the lifecycle verbs are
 * desktop-only there, so `run` answers the bridge's refusal as `unavailable`.
 *
 * `run(verb)` is the pane's one way to act: it invokes one of the narrow
 * lifecycle verbs and refreshes the standing afterward. The approval handoff a
 * recovery returns is handed back once and never kept here. Nothing here can
 * switch management off: the verbs refresh, recover and complete; leaving a
 * managed record is refused by the main process by name.
 *
 * `update` is the roll-forward word beside the standing (MCOMP-19-04):
 * `held` when the update ceiling holds a check, download or install (the
 * projection's hold first, the updater's own report second), `restart-needed`
 * when an admitted download waits for a restart to install, `none` otherwise.
 * It follows the updater's status events, so a hold that lands at quit or at
 * install is seen without a poll.
 */

import { useCallback, useEffect } from 'react';
import type {
	LifecycleOutcome,
	RegistrationApprovalHandoff,
} from '../../../main/enterprise/enrollment';
import type { ManagedStanding, ManagedStateView } from '../../../main/enterprise/managed-state';
import type { UpdateStatus } from '../../../shared/types';
import { formatManagedHold } from '../../../shared/formatters';
import type { PolicyRecovery } from '../../../main/enterprise/policy-status';
import type { ManagedRunView } from '../../../main/enterprise/dispatch';
import type { LeaseRelease } from '../../../shared/maestro-lib/managed/authority';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { useCachedResource } from '../utils/useCachedResource';

export const MANAGED_STATE_RESOURCE_KEY = 'enterprise:managedState';
export const UPDATER_STATUS_RESOURCE_KEY = 'updates:status';
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

export type ManagedUpdateWord = 'held' | 'restart-needed' | 'none';

export interface ManagedUpdateState {
	word: ManagedUpdateWord;
	/** The version held or waiting for the restart; null for a held check or nothing. */
	version: string | null;
	/** One sentence for the pane; empty for `none`. */
	message: string;
}

/** The labels for the roll-forward words; `none` draws nothing. */
export const MANAGED_UPDATE_COPY: Record<Exclude<ManagedUpdateWord, 'none'>, string> = {
	held: 'Update held by policy',
	'restart-needed': 'Restart needed to install',
};

/**
 * The roll-forward word from the managed projection and the updater's status.
 * A hold wins over a waiting download: a held version is never offered as a
 * restart. Pure, so a pane and a test read the same answer.
 */
export function managedUpdateState(
	state: ManagedStateView | null | undefined,
	updater: UpdateStatus | null | undefined
): ManagedUpdateState {
	const held =
		// An older host projects no `update` section; it then reads as nothing held.
		state?.update?.held ?? (updater?.status === 'held-by-policy' ? updater.held : undefined);
	if (held) {
		const version = held.candidate ?? updater?.info?.version ?? null;
		return {
			word: 'held',
			version,
			message: `${version ? `Update ${version}` : 'The update check'} is held: ${formatManagedHold(held)}`,
		};
	}
	if (updater?.status === 'downloaded') {
		const version = updater.info?.version ?? null;
		return {
			word: 'restart-needed',
			version,
			message: `${version ? `Update ${version}` : 'An update'} is downloaded and admitted; restart Maestro to install it.`,
		};
	}
	return { word: 'none', version: null, message: '' };
}

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
	/** False on a surface with no `enterprise` API; a browser reads the state over the bridge. */
	supported: boolean;
	/** Undefined before the first read, null when no service runs in this desktop. */
	state: ManagedStateView | null | undefined;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	fetchedAt: number;
	refresh: () => Promise<void>;
	run: (verb: ManagedActionVerb) => Promise<ManagedActionResult>;
	/** The roll-forward word: held, restart-needed, or none. */
	update: ManagedUpdateState;
}

export function useManagedStatus(options: { pollMs?: number } = {}): UseManagedStatusResult {
	const api = window.maestro?.enterprise;
	const supported = typeof api?.managedState === 'function';
	const pollMs = options.pollMs ?? MANAGED_STATE_POLL_MS;
	const resource = useCachedResource<ManagedStateView | null>(
		supported ? MANAGED_STATE_RESOURCE_KEY : null,
		() => api.managedState()
	);
	const { refresh: refreshState } = resource;
	const updates = window.maestro?.updates;
	const updaterSupported = supported && typeof updates?.getStatus === 'function';
	const updater = useCachedResource<UpdateStatus>(
		updaterSupported ? UPDATER_STATUS_RESOURCE_KEY : null,
		() => updates.getStatus()
	);
	const { refresh: refreshUpdater } = updater;
	const refresh = useCallback(async () => {
		await Promise.all([refreshState(), refreshUpdater()]);
	}, [refreshState, refreshUpdater]);

	useEffect(() => {
		if (!supported || pollMs <= 0) return;
		const timer = setInterval(() => void refresh(), pollMs);
		return () => clearInterval(timer);
	}, [supported, pollMs, refresh]);

	// The updater reports a hold or a finished download as it happens.
	useEffect(() => {
		if (!updaterSupported || typeof updates?.onStatus !== 'function') return;
		return updates.onStatus(() => void refreshUpdater());
	}, [updaterSupported, updates, refreshUpdater]);

	const run = useCallback(
		async (verb: ManagedActionVerb): Promise<ManagedActionResult> => {
			if (!supported) {
				return {
					status: 'unavailable',
					message: 'Mega-Maestro management is available in the desktop app.',
					handoff: null,
				};
			}
			let outcome: Awaited<ReturnType<(typeof api)[typeof verb]>>;
			try {
				outcome = await api[verb]();
			} catch (error) {
				// The bridge refused the verb (a browser never runs the lifecycle): say so, by name.
				return { status: 'unavailable', message: ipcErrorMessage(error), handoff: null };
			}
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
		update: managedUpdateState(resource.data, updater.data),
	};
}

// ---------------------------------------------------------------------------
// The managed run a composer turn started (MCOMP-25-02)
// ---------------------------------------------------------------------------

/** The seven words a managed run is shown as. */
export type ManagedRunWord =
	| 'admitted'
	| 'running'
	| 'completed'
	| 'denied'
	| 'unknown'
	| 'offline'
	| 'revoked';

/**
 * What a person may do about a run from where it is shown. Each one asks the
 * host again rather than trusting the view: `stop` goes to the process the
 * lease is bound to, `retry` is a new send admitted under the policy current
 * then, `refresh` re-reads the run from the dispatch ledger, `refreshPolicy`
 * asks the endpoint for the current policy.
 */
export type ManagedRunAction = 'stop' | 'retry' | 'refresh' | 'refreshPolicy';

/** The one place the run words are spelled out. */
export const MANAGED_RUN_COPY: Record<ManagedRunWord, { label: string; detail: string }> = {
	admitted: {
		label: 'Admitted',
		detail: 'The host admitted this turn; the process has not been bound to its lease yet.',
	},
	running: {
		label: 'Running',
		detail: 'Running under its lease; the host can stop it if the lease is revoked.',
	},
	completed: {
		label: 'Completed',
		detail: 'The turn ended and its lease was released.',
	},
	denied: {
		label: 'Denied',
		detail: 'The host refused this turn; nothing ran.',
	},
	unknown: {
		label: 'Unknown',
		detail: 'The host cannot say how this turn ended; nothing is resent on its own.',
	},
	offline: {
		label: 'Offline',
		detail: 'The managed runtime is not reachable from here.',
	},
	revoked: {
		label: 'Revoked',
		detail: 'The host withdrew this turn’s lease; its process was stopped.',
	},
};

/** A spawn the host refused, as the process manager reports it (`SpawnResult.managed`). */
export interface ManagedRunRefusal {
	state: 'denied' | 'unavailable' | 'unknown';
	code: string;
	message: string;
}

export interface ManagedRunStateInput {
	/** The run the tab's last send started (the ledger's read when one is newer). */
	run: ManagedRunView | null | undefined;
	/** Whether the tab's turn is live right now. */
	busy: boolean;
	/** The host's standing (`useManagedStatus().state`): undefined reading, null no service. */
	standing: ManagedStateView | null | undefined;
	/** The last send's refusal, when the host refused it and so no run exists. */
	refusal?: ManagedRunRefusal | null;
}

export interface ManagedRunStateView {
	word: ManagedRunWord;
	label: string;
	detail: string;
	/** The host's own sentence for this run (release, revocation, refusal); null when it said none. */
	reason: string | null;
	/** The policy revision the run was admitted under; null when none is recorded. */
	revision: number | null;
	/** The revision the host applies now, when it differs from the run's. */
	currentRevision: number | null;
	tint: 'success' | 'warning' | 'error' | 'textDim' | 'accent';
	actions: ManagedRunAction[];
	leaseId: string | null;
}

/** Standings under which the host refuses managed execution: no retry is offered. */
const EXECUTION_REFUSED: ReadonlySet<ManagedStanding> = new Set([
	'denied',
	'suspended',
	'revoked',
	'retired',
	'custody-refused',
]);

function releaseReason(release: LeaseRelease | null): string | null {
	if (!release) return null;
	switch (release.outcome) {
		case 'exited':
			return release.signal
				? `The process ended on ${release.signal}.`
				: `The process exited with code ${release.exitCode ?? 'unknown'}.`;
		case 'stopped':
			return release.by === 'caller' ? 'Stopped from Maestro.' : 'Stopped by the host.';
		case 'spawn-failed':
			return `The process failed to start: ${release.message}`;
		case 'unknown':
			return release.message;
	}
}

/**
 * The word, sentence and safe actions for one managed run. Pure, so the pane
 * and a test read the same answer. Returns null when there is nothing managed
 * to show (a standalone host binds no lease and refuses nothing), so an
 * unmanaged Maestro draws nothing. Never a success tint unless the ledger or
 * the live process says so: with no service or an unread standing the run
 * reads `offline`, and a bound lease whose turn ended reads `unknown` until
 * the ledger is read back.
 */
export function describeManagedRun(input: ManagedRunStateInput): ManagedRunStateView | null {
	const { run, busy, standing, refusal } = input;
	const refused = !!standing && EXECUTION_REFUSED.has(standing.standing);
	const currentOf = (revision: number | null) => {
		const now = standing?.policy?.appliedRevision ?? null;
		return now !== null && now !== revision ? now : null;
	};
	const build = (
		word: ManagedRunWord,
		reason: string | null,
		tint: ManagedRunStateView['tint'],
		actions: ManagedRunAction[],
		revision: number | null,
		leaseId: string | null
	): ManagedRunStateView => ({
		word,
		label: MANAGED_RUN_COPY[word].label,
		detail: MANAGED_RUN_COPY[word].detail,
		reason,
		revision,
		currentRevision: currentOf(revision),
		tint,
		// A host that refuses managed execution is never offered a resend.
		actions: refused ? actions.filter((a) => a !== 'retry') : actions,
		leaseId,
	});

	if (!run) {
		if (!refusal) return null;
		const reason = formatManagedHold(refusal);
		if (refusal.state === 'unavailable') {
			return build('offline', reason, 'warning', ['refreshPolicy', 'retry'], null, null);
		}
		if (refusal.state === 'unknown') {
			return build('unknown', reason, 'warning', ['refreshPolicy'], null, null);
		}
		return build('denied', reason, 'error', ['refreshPolicy', 'retry'], null, null);
	}

	const revision = run.decision?.policyRevision ?? run.policyRevision;
	const lease = run.leaseId;
	const effect = run.effect;
	const live = effect.state === 'admitted' || effect.state === 'bound';

	if (live && busy) {
		// Policy loss mid-run: the host's standing now refuses managed execution.
		if (refused) {
			return build('revoked', standing?.reason ?? null, 'error', ['stop'], revision, lease);
		}
		// No service, an unread or unreachable standing: never a success word.
		if (!standing || standing.standing === 'offline') {
			return build('offline', standing?.reason ?? null, 'warning', ['stop'], revision, lease);
		}
		if (effect.state === 'admitted') {
			return build('admitted', null, 'accent', ['stop'], revision, lease);
		}
		return build('running', null, 'accent', ['stop'], revision, lease);
	}
	if (live) {
		// The turn ended, but this is still the spawn-time view: read the ledger back.
		return build('unknown', effect.reason, 'warning', ['refresh'], revision, lease);
	}
	switch (effect.state) {
		case 'released': {
			const release = effect.release;
			const clean =
				release?.outcome === 'stopped' ||
				(release?.outcome === 'exited' && release.exitCode === 0 && !release.signal);
			if (release?.outcome === 'unknown') {
				return build(
					'unknown',
					releaseReason(release),
					'warning',
					['refresh', 'retry'],
					revision,
					lease
				);
			}
			return build(
				'completed',
				effect.reason ?? releaseReason(release),
				clean ? 'success' : 'warning',
				['retry'],
				revision,
				lease
			);
		}
		case 'revoked':
			return build(
				'revoked',
				effect.reason ?? 'The host revoked the lease while the turn ran.',
				'error',
				['refreshPolicy', 'retry'],
				revision,
				lease
			);
		case 'expired':
			return build(
				'revoked',
				effect.reason ?? 'The lease expired before the turn ended.',
				'error',
				['refreshPolicy', 'retry'],
				revision,
				lease
			);
		default:
			return build('unknown', effect.reason, 'warning', ['refresh', 'retry'], revision, lease);
	}
}

export const MANAGED_RUN_RESOURCE_PREFIX = 'enterprise:managedRun:';

/**
 * Read one run back from the dispatch ledger by its lease id, once its turn is
 * no longer live (`enabled: false` while it runs: the live view is newer).
 * `run` is undefined before the read, null for a lease the ledger never
 * admitted or a host with no ledger.
 */
export function useManagedRun(
	leaseId: string | null | undefined,
	options: { enabled?: boolean } = {}
): { run: ManagedRunView | null | undefined; refresh: () => Promise<void> } {
	const api = window.maestro?.enterprise;
	const supported = typeof api?.managedRun === 'function';
	const enabled = options.enabled ?? true;
	const key = supported && leaseId && enabled ? `${MANAGED_RUN_RESOURCE_PREFIX}${leaseId}` : null;
	const resource = useCachedResource<ManagedRunView | null>(key, () =>
		api.managedRun(leaseId as string)
	);
	return { run: key ? resource.data : undefined, refresh: resource.refresh };
}
