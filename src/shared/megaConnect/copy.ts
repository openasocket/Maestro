/**
 * Every user-facing string of the Connect to your organization experience.
 *
 * Maestro has no i18n catalog, so this one file is what gets translated later:
 * components read their words from here and never hard-code copy. Strings with
 * a varying part are templates whose `{name}` placeholders are filled by
 * `fillMegaConnectCopy()`; the placeholders only ever receive display names
 * (an organization, a team path, a request reference), never an ID.
 *
 * Source: the state copy of the plan of record (mega-maestro
 * docs/design/simplified-experience/SIMPLIFIED-EXPERIENCE.md), verbatim.
 */

export const MEGA_CONNECT_COPY = {
	// Not connected
	notConnectedTitle: 'Connect to your organization',
	notConnectedBody:
		'Enter your work email. Maestro finds your organization and opens your browser to sign in.',
	workEmailField: 'Work email',
	connectButton: 'Connect',
	useLinkOrCodeLink: 'Use a link or code instead',

	// Link or code
	joinLinkField: 'Join link',
	teamCodeField: 'Team code',
	/** Shown only next to a team code: a join link already names its server. */
	serverField: 'Server',

	// Managed
	managedBody: 'Your organization manages this Maestro. Connecting...',

	// Browser opened
	browserOpenedBody: 'Finish in your browser. Pick this number:',
	requestLine: 'Request {request} · {server}',
	/** The server name is unknown: the line names the request alone. */
	requestLineNoServer: 'Request {request}',
	openBrowserAgainButton: 'Open the browser again',

	// Waiting
	waitingBody:
		'Waiting for an admin to approve request {request}. You can keep working; Maestro will connect by itself.',
	/** No request reference is known: the sentence names no request rather than an ID. */
	waitingBodyUnnamed:
		'Waiting for an admin to approve your request. You can keep working; Maestro will connect by itself.',

	// Connected
	connectedTitle: 'Connected to {org}',
	/** The organization name is unknown: the title drops it rather than show an ID. */
	connectedTitleUnnamed: 'Connected',
	connectedPolicy: 'Policy {policy} enforced',
	connectedSynced: 'synced {ago}',
	/** Joins the parts of the connected detail line and the request line. */
	detailSeparator: ' · ',
	reconnectButton: 'Reconnect',
	disconnectButton: 'Disconnect',

	// Denied and expired
	deniedBody: 'Your request was not approved.',
	expiredBody: 'Your request expired before it was approved.',
	tryAgainButton: 'Try again',

	// PROPOSED: the three states revision 2 adds. Mega reviews these in
	// SIMPLE-05 (copy); until then they are Maestro's proposal, not settled copy.
	revokedBody: 'Your administrator disconnected this Maestro. Connect again to continue.',
	grantExpiredBody: 'Your connection expired. Connect again to continue.',
	unavailableBody:
		'Maestro cannot reach the Mega-Maestro endpoint on this computer. Use Troubleshoot for details.',
	connectAgainButton: 'Connect again',

	// PROPOSED: OS notification titles for the transitions a person may miss
	// while working elsewhere (MSX-01-07). The connected notification reuses
	// connectedTitle; the other bodies reuse the state copy above. Mega reviews
	// these in SIMPLE-05 (copy).
	notifyConnectedBody: 'Maestro now follows your organization policy.',
	notifyDeniedTitle: 'Request not approved',
	notifyExpiredTitle: 'Request expired',
	notifyRevokedTitle: 'Disconnected by your administrator',
	notifyGrantExpiredTitle: 'Connection expired',

	// The one word the Left Bar indicator shows next to its dot (MSX-01-08).
	indicatorConnected: 'Connected',
	indicatorWaiting: 'Waiting for approval',
	indicatorNotConnected: 'Not connected',
	indicatorNeedsReconnect: 'Needs reconnect',
	indicatorUnavailable: 'Unavailable',

	// The tabs of the Mega-Maestro window (MSX-01-04). Troubleshoot holds every
	// technical field: the server host and port, the endpoint socket, the lookup
	// and the classic enrollment. The default view shows none of them.
	panelTabsLabel: 'Mega-Maestro view',
	panelTabOverview: 'Overview',
	panelTabTroubleshoot: 'Troubleshoot',
} as const;

export type MegaConnectCopyKey = keyof typeof MEGA_CONNECT_COPY;

/**
 * The text of `key` with each `{name}` placeholder replaced from `values`.
 * A placeholder with no value is left as written: callers drop the whole
 * template when a name is missing instead of filling it with something else.
 */
export function fillMegaConnectCopy(
	key: MegaConnectCopyKey,
	values: Record<string, string> = {}
): string {
	return MEGA_CONNECT_COPY[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
	);
}
