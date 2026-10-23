/**
 * useManagedInbox - the notices the endpoint addressed to this desktop's
 * actor, and the receipts this host records on them (MRC-11-04).
 *
 * Reads `window.maestro.enterprise.inboxState()` through the cached-resource
 * store, so the surface that shows it draws the last answer at once and
 * refreshes it in place. Three answers are kept apart: `supported: false` is a
 * browser (the web-desktop bridge has no `enterprise` namespace), `view ===
 * null` is a desktop whose service composes no inbox client yet, and a `view`
 * is the client's status with the held notices, bodies included.
 *
 * `list()` asks the client to list the endpoint's notices again (which records
 * `delivered` for every notice newly held); `act()` records one receipt on one
 * notice. Both re-read the view afterward and describe the outcome in one
 * sentence. A notice body reaches the person's surface through this hook and
 * nothing else: nothing here hands it to a composer, a queue or a model, and
 * a reply's text is sent once and kept nowhere.
 */

import { useCallback, useEffect } from 'react';
import type { EndpointInboxAction } from '../../../shared/maestro-lib/managed/host-adapter';
import type {
	InboxActionOutcome,
	InboxRefresh,
	ManagedInboxView,
} from '../../../main/enterprise/inbox';
import { useCachedResource } from '../utils/useCachedResource';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export const MANAGED_INBOX_RESOURCE_KEY = 'enterprise:inboxState';
/** Notices change rarely; the Refresh control is the fast path. */
export const MANAGED_INBOX_POLL_MS = 60_000;

export interface InboxActResult {
	status: 'recorded' | 'duplicate' | 'denied' | 'uncertain' | 'refused' | 'unavailable';
	message: string;
}

export interface InboxListResult {
	status: 'ok' | 'failed';
	message: string;
}

const RECORDED_MESSAGE: Record<EndpointInboxAction['kind'], string> = {
	delivered: 'Delivery recorded.',
	read: 'Marked read.',
	acknowledged: 'Acknowledged.',
	reply: 'Your reply was recorded by the endpoint.',
};

/** One sentence per act outcome; a failed one names the endpoint's reason, never a main diagnostic. */
export function describeInboxAct(
	kind: EndpointInboxAction['kind'],
	outcome: InboxActionOutcome
): InboxActResult {
	switch (outcome.status) {
		case 'recorded':
			return outcome.duplicate
				? { status: 'duplicate', message: 'Already recorded; nothing was sent again.' }
				: { status: 'recorded', message: RECORDED_MESSAGE[kind] };
		case 'denied':
			return {
				status: 'denied',
				message: `The endpoint refused to record ${kind}: ${outcome.reason}.`,
			};
		case 'uncertain':
			return {
				status: 'uncertain',
				message:
					"Recorded here, but the endpoint's answer was not seen. Try again to send it under the same receipt.",
			};
		case 'unavailable':
			return { status: 'unavailable', message: outcome.detail };
	}
}

export function describeInboxList(outcome: InboxRefresh | null): InboxListResult {
	if (!outcome) {
		return { status: 'failed', message: 'No notice inbox is composed in this desktop.' };
	}
	switch (outcome.outcome) {
		case 'listed':
			return {
				status: 'ok',
				message: `Listed ${outcome.listed} notice${outcome.listed === 1 ? '' : 's'}, ${outcome.newlyHeld} new.`,
			};
		case 'no-standing':
			return {
				status: 'failed',
				message:
					`Notices are listed only while this desktop is registered and attached. ${outcome.reason ?? ''}`.trim(),
			};
		case 'denied':
			return {
				status: 'failed',
				message: `The endpoint denied the listing: ${outcome.denial ?? outcome.reason ?? 'no reason given'}.`,
			};
		case 'unavailable':
		case 'malformed':
			return { status: 'failed', message: outcome.reason ?? 'The listing could not be read.' };
	}
}

export interface UseManagedInboxResult {
	/** False in a browser: the bridge has no `enterprise` namespace. */
	supported: boolean;
	/** undefined while reading, null when the desktop composes no inbox client. */
	view: ManagedInboxView | null | undefined;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	/** Re-read the view from main. */
	refresh: () => Promise<void>;
	/** Ask the client to list the endpoint's notices again, then re-read. */
	list: () => Promise<InboxListResult>;
	/** Record one receipt on one held notice, then re-read. */
	act: (
		notice: { campaignId: string; messageId: string },
		action: EndpointInboxAction
	) => Promise<InboxActResult>;
}

const DESKTOP_ONLY = 'Notices are available in the desktop app.';

export function useManagedInbox(options: { pollMs?: number } = {}): UseManagedInboxResult {
	const api = window.maestro?.enterprise;
	const supported = typeof api?.inboxState === 'function';
	const pollMs = options.pollMs ?? MANAGED_INBOX_POLL_MS;
	const resource = useCachedResource<ManagedInboxView | null>(
		supported ? MANAGED_INBOX_RESOURCE_KEY : null,
		() => api.inboxState()
	);
	const { refresh } = resource;

	useEffect(() => {
		if (!supported || pollMs <= 0) return;
		const timer = setInterval(() => void refresh(), pollMs);
		return () => clearInterval(timer);
	}, [supported, pollMs, refresh]);

	const list = useCallback(async (): Promise<InboxListResult> => {
		if (!supported) return { status: 'failed', message: DESKTOP_ONLY };
		const outcome = await api.inboxRefresh();
		await refresh();
		return describeInboxList(outcome);
	}, [api, supported, refresh]);

	const act = useCallback(
		async (
			notice: { campaignId: string; messageId: string },
			action: EndpointInboxAction
		): Promise<InboxActResult> => {
			if (!supported) return { status: 'unavailable', message: DESKTOP_ONLY };
			let outcome: InboxActionOutcome;
			try {
				outcome = await api.inboxAct({ ...notice, action });
			} catch (error) {
				// The handler refused the input by name (an empty or overlong reply);
				// nothing left this desktop.
				return { status: 'refused', message: ipcErrorMessage(error) };
			}
			await refresh();
			return describeInboxAct(action.kind, outcome);
		},
		[api, supported, refresh]
	);

	return {
		supported,
		view: resource.data,
		loading: resource.loading,
		refreshing: resource.refreshing,
		error: resource.error,
		refresh,
		list,
		act,
	};
}
