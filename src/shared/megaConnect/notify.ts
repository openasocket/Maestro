/**
 * Which connect status changes deserve an OS notification, and what it says.
 *
 * Pure: main (MSX-02-01) feeds each polled status through
 * `createMegaConnectNotifier()` or `notificationFor()` and delivers the result
 * with the OS notification helper `src/main/ipc/handlers/notifications.ts`
 * already uses. Only the transitions a person may miss while working
 * elsewhere are announced: an approval decision on a waiting request, and the
 * loss of a connection.
 *
 * Names rule and Logging rule: the title and body come from copy.ts and carry
 * display names only (an organization, a team path, a policy label). The
 * matching number, a grant ID and the socket path never reach the output; the
 * dedupe key names the transition and the request reference (REQ-1042) alone.
 */

import { MEGA_CONNECT_COPY, type MegaConnectCopyKey } from './copy';
import { formatRequestRef, viewFor, type MegaConnectStatus } from './view';

export type MegaConnectTransition =
	| 'waitingToConnected'
	| 'waitingToDenied'
	| 'waitingToExpired'
	| 'connectedToRevoked'
	| 'connectedToGrantExpired';

export interface MegaConnectNotification {
	transition: MegaConnectTransition;
	title: string;
	body: string;
	/** The transition name plus the request reference: the same change is announced once. */
	dedupeKey: string;
}

const TRANSITIONS: Record<string, MegaConnectTransition> = {
	'waiting>connected': 'waitingToConnected',
	'waiting>denied': 'waitingToDenied',
	'waiting>expired': 'waitingToExpired',
	'connected>revoked': 'connectedToRevoked',
	'connected>grantExpired': 'connectedToGrantExpired',
};

const BODY_ONLY: Partial<
	Record<MegaConnectTransition, { titleKey: MegaConnectCopyKey; bodyKey: MegaConnectCopyKey }>
> = {
	waitingToDenied: { titleKey: 'notifyDeniedTitle', bodyKey: 'deniedBody' },
	waitingToExpired: { titleKey: 'notifyExpiredTitle', bodyKey: 'expiredBody' },
	connectedToRevoked: { titleKey: 'notifyRevokedTitle', bodyKey: 'revokedBody' },
	connectedToGrantExpired: { titleKey: 'notifyGrantExpiredTitle', bodyKey: 'grantExpiredBody' },
};

/** The request reference either status carries, as REQ-1042, or null. */
function requestRefOf(...statuses: Array<MegaConnectStatus | null | undefined>): string | null {
	for (const status of statuses) {
		if (status && 'request' in status) {
			const ref = formatRequestRef(status.request);
			if (ref) return ref;
		}
	}
	return null;
}

/** The notification for moving from `previous` to `next`, or null when nothing is announced. */
export function notificationFor(
	previous: MegaConnectStatus | null | undefined,
	next: MegaConnectStatus
): MegaConnectNotification | null {
	if (!previous) return null;
	const transition = TRANSITIONS[`${previous.kind}>${next.kind}`];
	if (!transition) return null;
	const dedupeKey = `${transition}:${requestRefOf(previous, next) ?? 'none'}`;

	if (transition === 'waitingToConnected' && next.kind === 'connected') {
		// viewFor already refuses an ID passed as a name; the synced age is left out
		// because a notification is read later than it is raised.
		const view = viewFor({ ...next, syncedAt: undefined });
		return {
			transition,
			title: view.title ?? MEGA_CONNECT_COPY.connectedTitleUnnamed,
			body: view.detail ?? MEGA_CONNECT_COPY.notifyConnectedBody,
			dedupeKey,
		};
	}

	const keys = BODY_ONLY[transition];
	if (!keys) return null;
	return {
		transition,
		title: MEGA_CONNECT_COPY[keys.titleKey],
		body: MEGA_CONNECT_COPY[keys.bodyKey],
		dedupeKey,
	};
}

/** Statuses a new request is started from by the person, not by a stale poll. */
const STARTING_OVER = new Set<MegaConnectStatus['kind']>([
	'notConnected',
	'linkOrCode',
	'managed',
	'unavailable',
]);

export interface MegaConnectNotifier {
	/** Feed the latest polled status; returns a notification to deliver, or null. */
	observe(status: MegaConnectStatus): MegaConnectNotification | null;
}

/**
 * A notifier that remembers the previous status and the keys it has announced,
 * so repeated polls of the same status, or a stale poll that flaps back to the
 * same request, announce each transition once. A new request starts a fresh
 * set, so a later revocation is announced again even though it carries no
 * request reference: a request is new when its reference differs from the last
 * one seen, or, without a reference, when the person starts over from a
 * not-connected state.
 */
export function createMegaConnectNotifier(): MegaConnectNotifier {
	let previous: MegaConnectStatus | null = null;
	let lastRequest: string | null = null;
	let announced = new Set<string>();
	return {
		observe(status) {
			const prior = previous;
			previous = status;
			if (status.kind === 'browserOpened' || status.kind === 'waiting') {
				const request = requestRefOf(status);
				const startedOver =
					!prior || STARTING_OVER.has(prior.kind) || (request !== null && request !== lastRequest);
				if (startedOver) announced = new Set();
				if (request !== null) lastRequest = request;
			}
			const notification = notificationFor(prior, status);
			if (!notification || announced.has(notification.dedupeKey)) return null;
			announced.add(notification.dedupeKey);
			return notification;
		},
	};
}
