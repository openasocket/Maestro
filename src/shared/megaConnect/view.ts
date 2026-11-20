/**
 * The Connect to your organization view model: which words, fields and action
 * a connect status shows. Pure, so the panel, the Left Bar indicator and the
 * notification rules read one answer.
 *
 * Names rule: the view shows names (REQ-1042, platform/web,
 * platform-default@12) and never an ID, digest, socket path or host and port.
 * A name that is absent drops its part of the line; nothing falls back to an
 * ID, and a value that looks like an ID is refused as a name.
 */

import { formatRelativeTime } from '../formatters';
import { MEGA_CONNECT_COPY, fillMegaConnectCopy, type MegaConnectCopyKey } from './copy';

/** A policy as the endpoint names it: its label and its revision. */
export interface MegaPolicyName {
	name: string;
	revision?: number;
}

/** Maestro's own connect status. Every field is a display name, never an ID. */
export type MegaConnectStatus =
	| { kind: 'notConnected' }
	| { kind: 'linkOrCode'; mode: 'joinLink' | 'teamCode' }
	| { kind: 'managed' }
	| {
			kind: 'browserOpened';
			/** The number the user picks in the browser. Shown, never logged. */
			matchNumber?: string | number;
			request?: string | number;
			/** The server's DNS name (mega.acme.com), never a host and port. */
			serverName?: string;
	  }
	| { kind: 'waiting'; request?: string | number }
	| {
			kind: 'connected';
			orgName?: string;
			teamPath?: string;
			policy?: MegaPolicyName;
			/** Epoch milliseconds of the last successful sync. */
			syncedAt?: number;
	  }
	| { kind: 'denied' }
	| { kind: 'expired' }
	| { kind: 'revoked' }
	| { kind: 'grantExpired' }
	| { kind: 'unavailable' };

export type MegaConnectStatusKind = MegaConnectStatus['kind'];

export const MEGA_CONNECT_STATUS_KINDS: readonly MegaConnectStatusKind[] = [
	'notConnected',
	'linkOrCode',
	'managed',
	'browserOpened',
	'waiting',
	'connected',
	'denied',
	'expired',
	'revoked',
	'grantExpired',
	'unavailable',
];

export type MegaConnectActionId =
	| 'connect'
	| 'useLinkOrCode'
	| 'openBrowserAgain'
	| 'reconnect'
	| 'disconnect'
	| 'tryAgain'
	| 'connectAgain';

export type MegaConnectFieldId = 'workEmail' | 'joinLink' | 'teamCode' | 'server';

export interface MegaConnectAction {
	id: MegaConnectActionId;
	labelKey: MegaConnectCopyKey;
	label: string;
}

export interface MegaConnectField {
	id: MegaConnectFieldId;
	labelKey: MegaConnectCopyKey;
	label: string;
}

/** What one status shows. Carries copy keys and the filled text; no ID field. */
export interface MegaConnectView {
	kind: MegaConnectStatusKind;
	titleKey: MegaConnectCopyKey | null;
	title: string | null;
	bodyKey: MegaConnectCopyKey | null;
	body: string | null;
	/** The connected detail line or the browser request line. */
	detail: string | null;
	fields: MegaConnectField[];
	primaryAction: MegaConnectAction | null;
	secondaryActions: MegaConnectAction[];
	showLargeNumber: boolean;
	largeNumber: string | null;
	indicatorKey: MegaConnectCopyKey;
	indicatorWord: string;
}

const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGEST_LIKE = /(sha\d+[:-])?[0-9a-f]{32,}/i;
const HOST_PORT_LIKE = /:\d+$|\//;

/** The trimmed name, or null when it is absent or shaped like an ID, a digest or a path. */
function displayName(value: string | undefined): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 128) return null;
	if (UUID_LIKE.test(trimmed) || DIGEST_LIKE.test(trimmed)) return null;
	return trimmed;
}

/** "REQ-1042" from a request sequence or reference, or null when it is neither. */
export function formatRequestRef(request: string | number | undefined): string | null {
	if (typeof request === 'number') {
		return Number.isSafeInteger(request) && request > 0 ? `REQ-${request}` : null;
	}
	if (typeof request !== 'string') return null;
	const match = /^(?:req-)?(\d{1,12})$/i.exec(request.trim());
	return match ? `REQ-${Number(match[1])}` : null;
}

/** "platform-default@12", the bare label when no revision is known, or null without a label. */
export function formatPolicyRef(name: string | undefined, revision?: number): string | null {
	const label = displayName(name);
	if (!label) return null;
	if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0) {
		return `${label}@${revision}`;
	}
	return label;
}

/** "synced 3m ago" for a sync at `date`, measured from `now`. */
export function formatSyncedAgo(date: Date | number, now: Date | number = Date.now()): string {
	const at = typeof date === 'number' ? date : date.getTime();
	const nowMs = typeof now === 'number' ? now : now.getTime();
	// formatRelativeTime measures from the clock; shift the instant so the gap is now - at.
	const ago = formatRelativeTime(Date.now() - Math.max(0, nowMs - at));
	return fillMegaConnectCopy('connectedSynced', { ago });
}

function action(id: MegaConnectActionId, labelKey: MegaConnectCopyKey): MegaConnectAction {
	return { id, labelKey, label: MEGA_CONNECT_COPY[labelKey] };
}

function field(id: MegaConnectFieldId, labelKey: MegaConnectCopyKey): MegaConnectField {
	return { id, labelKey, label: MEGA_CONNECT_COPY[labelKey] };
}

function indicatorKeyFor(kind: MegaConnectStatusKind): MegaConnectCopyKey {
	switch (kind) {
		case 'connected':
			return 'indicatorConnected';
		case 'managed':
		case 'browserOpened':
		case 'waiting':
			return 'indicatorWaiting';
		case 'revoked':
		case 'grantExpired':
			return 'indicatorNeedsReconnect';
		case 'unavailable':
			return 'indicatorUnavailable';
		default:
			return 'indicatorNotConnected';
	}
}

function joinParts(parts: Array<string | null>): string | null {
	const present = parts.filter((part): part is string => !!part);
	return present.length > 0 ? present.join(MEGA_CONNECT_COPY.detailSeparator) : null;
}

/** What the connect panel shows for `status`, measured at `now` for the synced age. */
export function viewFor(
	status: MegaConnectStatus,
	now: Date | number = Date.now()
): MegaConnectView {
	const indicatorKey = indicatorKeyFor(status.kind);
	const view: MegaConnectView = {
		kind: status.kind,
		titleKey: null,
		title: null,
		bodyKey: null,
		body: null,
		detail: null,
		fields: [],
		primaryAction: null,
		secondaryActions: [],
		showLargeNumber: false,
		largeNumber: null,
		indicatorKey,
		indicatorWord: MEGA_CONNECT_COPY[indicatorKey],
	};
	const withBody = (key: MegaConnectCopyKey, values?: Record<string, string>) => {
		view.bodyKey = key;
		view.body = fillMegaConnectCopy(key, values);
	};

	switch (status.kind) {
		case 'notConnected':
			view.titleKey = 'notConnectedTitle';
			view.title = MEGA_CONNECT_COPY.notConnectedTitle;
			withBody('notConnectedBody');
			view.fields = [field('workEmail', 'workEmailField')];
			view.primaryAction = action('connect', 'connectButton');
			view.secondaryActions = [action('useLinkOrCode', 'useLinkOrCodeLink')];
			break;
		case 'linkOrCode':
			view.titleKey = 'notConnectedTitle';
			view.title = MEGA_CONNECT_COPY.notConnectedTitle;
			view.fields =
				status.mode === 'joinLink'
					? [field('joinLink', 'joinLinkField')]
					: [field('teamCode', 'teamCodeField'), field('server', 'serverField')];
			view.primaryAction = action('connect', 'connectButton');
			break;
		case 'managed':
			withBody('managedBody');
			break;
		case 'browserOpened': {
			withBody('browserOpenedBody');
			const number = String(status.matchNumber ?? '').trim();
			if (/^\d{1,4}$/.test(number)) {
				view.showLargeNumber = true;
				view.largeNumber = number;
			}
			const request = formatRequestRef(status.request);
			const server = displayName(status.serverName);
			const serverLabel = server && !HOST_PORT_LIKE.test(server) ? server : null;
			view.detail = !request
				? null
				: serverLabel
					? fillMegaConnectCopy('requestLine', { request, server: serverLabel })
					: fillMegaConnectCopy('requestLineNoServer', { request });
			view.primaryAction = action('openBrowserAgain', 'openBrowserAgainButton');
			break;
		}
		case 'waiting': {
			const request = formatRequestRef(status.request);
			if (request) withBody('waitingBody', { request });
			else withBody('waitingBodyUnnamed');
			break;
		}
		case 'connected': {
			const org = displayName(status.orgName);
			if (org) {
				view.titleKey = 'connectedTitle';
				view.title = fillMegaConnectCopy('connectedTitle', { org });
			} else {
				view.titleKey = 'connectedTitleUnnamed';
				view.title = MEGA_CONNECT_COPY.connectedTitleUnnamed;
			}
			const policy = status.policy
				? formatPolicyRef(status.policy.name, status.policy.revision)
				: null;
			view.detail = joinParts([
				displayName(status.teamPath),
				policy ? fillMegaConnectCopy('connectedPolicy', { policy }) : null,
				typeof status.syncedAt === 'number' ? formatSyncedAgo(status.syncedAt, now) : null,
			]);
			view.primaryAction = action('reconnect', 'reconnectButton');
			view.secondaryActions = [action('disconnect', 'disconnectButton')];
			break;
		}
		case 'denied':
			withBody('deniedBody');
			view.primaryAction = action('tryAgain', 'tryAgainButton');
			break;
		case 'expired':
			withBody('expiredBody');
			view.primaryAction = action('tryAgain', 'tryAgainButton');
			break;
		case 'revoked':
			withBody('revokedBody');
			view.primaryAction = action('connectAgain', 'connectAgainButton');
			break;
		case 'grantExpired':
			withBody('grantExpiredBody');
			view.primaryAction = action('connectAgain', 'connectAgainButton');
			break;
		case 'unavailable':
			withBody('unavailableBody');
			break;
	}
	return view;
}
