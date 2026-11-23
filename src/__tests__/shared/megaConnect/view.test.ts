import { describe, expect, it } from 'vitest';
import { MEGA_CONNECT_COPY, fillMegaConnectCopy } from '../../../shared/megaConnect/copy';
import {
	MEGA_CONNECT_STATUS_KINDS,
	formatPolicyRef,
	formatRequestRef,
	formatSyncedAgo,
	viewFor,
	type MegaConnectStatus,
	type MegaConnectView,
} from '../../../shared/megaConnect/view';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const UUID = '3f2b1c9e-8a4d-4e7f-9b21-0c5d6e7f8a9b';
const DIGEST = '7c8963448e52cbdae2043a1305ce4690667c4e9ae2697ad933278d0a1630f650';
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DIGEST_PATTERN = /[0-9a-f]{32,}/i;

/** Every string a view carries, however deep. */
function strings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
	return [];
}

function expectNoIds(view: MegaConnectView) {
	for (const text of strings(view)) {
		expect(text).not.toMatch(UUID_PATTERN);
		expect(text).not.toMatch(DIGEST_PATTERN);
	}
	expect(Object.keys(view).some((key) => /id$/i.test(key) && key !== 'kind')).toBe(false);
}

const FULL: Record<MegaConnectStatus['kind'], MegaConnectStatus> = {
	notConnected: { kind: 'notConnected' },
	linkOrCode: { kind: 'linkOrCode', mode: 'teamCode' },
	managed: { kind: 'managed' },
	browserOpened: {
		kind: 'browserOpened',
		matchNumber: 47,
		request: 1042,
		serverName: 'mega.acme.com',
	},
	waiting: { kind: 'waiting', request: 'REQ-1042' },
	connected: {
		kind: 'connected',
		orgName: 'Acme',
		teamPath: 'platform/web',
		policy: { name: 'platform-default', revision: 12 },
		syncedAt: NOW - 60_000,
	},
	denied: { kind: 'denied' },
	expired: { kind: 'expired' },
	revoked: { kind: 'revoked' },
	grantExpired: { kind: 'grantExpired' },
	unavailable: { kind: 'unavailable' },
};

describe('megaConnect copy', () => {
	it('holds the plan of record strings verbatim', () => {
		expect(MEGA_CONNECT_COPY.notConnectedTitle).toBe('Connect to your organization');
		expect(MEGA_CONNECT_COPY.notConnectedBody).toBe(
			'Enter your work email. Maestro finds your organization and opens your browser to sign in.'
		);
		expect(MEGA_CONNECT_COPY.workEmailField).toBe('Work email');
		expect(MEGA_CONNECT_COPY.connectButton).toBe('Connect');
		expect(MEGA_CONNECT_COPY.useLinkOrCodeLink).toBe('Use a link or code instead');
		expect(MEGA_CONNECT_COPY.joinLinkField).toBe('Join link');
		expect(MEGA_CONNECT_COPY.teamCodeField).toBe('Team code');
		expect(MEGA_CONNECT_COPY.serverField).toBe('Server');
		expect(MEGA_CONNECT_COPY.managedBody).toBe(
			'Your organization manages this Maestro. Connecting...'
		);
		expect(MEGA_CONNECT_COPY.browserOpenedBody).toBe('Finish in your browser. Pick this number:');
		expect(
			fillMegaConnectCopy('requestLine', { request: 'REQ-1042', server: 'mega.acme.com' })
		).toBe('Request REQ-1042 · mega.acme.com');
		expect(MEGA_CONNECT_COPY.openBrowserAgainButton).toBe('Open the browser again');
		expect(fillMegaConnectCopy('waitingBody', { request: 'REQ-1042' })).toBe(
			'Waiting for an admin to approve request REQ-1042. You can keep working; Maestro will connect by itself.'
		);
		expect(fillMegaConnectCopy('connectedTitle', { org: 'Acme' })).toBe('Connected to Acme');
		expect(MEGA_CONNECT_COPY.reconnectButton).toBe('Reconnect');
		expect(MEGA_CONNECT_COPY.disconnectButton).toBe('Disconnect');
		expect(MEGA_CONNECT_COPY.deniedBody).toBe('Your request was not approved.');
		expect(MEGA_CONNECT_COPY.expiredBody).toBe('Your request expired before it was approved.');
		expect(MEGA_CONNECT_COPY.tryAgainButton).toBe('Try again');
		expect(MEGA_CONNECT_COPY.revokedBody).toBe(
			'Your administrator disconnected this Maestro. Connect again to continue.'
		);
		expect(MEGA_CONNECT_COPY.grantExpiredBody).toBe(
			'Your connection expired. Connect again to continue.'
		);
		expect(MEGA_CONNECT_COPY.unavailableBody).toBe(
			'Maestro cannot reach the Mega-Maestro endpoint on this computer, or it cannot answer right now. Use Troubleshoot for details.'
		);
		expect(MEGA_CONNECT_COPY.connectAgainButton).toBe('Connect again');
	});

	it('uses no em dash or en dash', () => {
		for (const text of Object.values(MEGA_CONNECT_COPY)) {
			expect(text).not.toMatch(
				new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`)
			);
		}
	});
});

describe('formatters', () => {
	it('formats a request reference', () => {
		expect(formatRequestRef(1042)).toBe('REQ-1042');
		expect(formatRequestRef('req-1042')).toBe('REQ-1042');
		expect(formatRequestRef('1042')).toBe('REQ-1042');
		expect(formatRequestRef(UUID)).toBeNull();
		expect(formatRequestRef(0)).toBeNull();
		expect(formatRequestRef(undefined)).toBeNull();
	});

	it('formats a policy reference', () => {
		expect(formatPolicyRef('platform-default', 12)).toBe('platform-default@12');
		expect(formatPolicyRef('platform-default')).toBe('platform-default');
		expect(formatPolicyRef(undefined, 12)).toBeNull();
		expect(formatPolicyRef(DIGEST, 3)).toBeNull();
	});

	it('formats the synced age from the given clock', () => {
		expect(formatSyncedAgo(NOW - 60_000, NOW)).toBe('synced 1m ago');
		expect(formatSyncedAgo(new Date(NOW - 3 * 3_600_000), new Date(NOW))).toBe('synced 3h ago');
		expect(formatSyncedAgo(NOW, NOW)).toBe('synced just now');
	});
});

describe('viewFor', () => {
	it('covers every status kind with no ID in the output', () => {
		expect(Object.keys(FULL).sort()).toEqual([...MEGA_CONNECT_STATUS_KINDS].sort());
		for (const kind of MEGA_CONNECT_STATUS_KINDS) {
			const view = viewFor(FULL[kind], NOW);
			expect(view.kind).toBe(kind);
			expect(view.indicatorWord.length).toBeGreaterThan(0);
			expectNoIds(view);
		}
	});

	it('not connected: one email field, Connect, and the link or code path', () => {
		const view = viewFor(FULL.notConnected, NOW);
		expect(view.title).toBe('Connect to your organization');
		expect(view.fields.map((f) => f.id)).toEqual(['workEmail']);
		expect(view.primaryAction?.id).toBe('connect');
		expect(view.secondaryActions.map((a) => a.label)).toEqual(['Use a link or code instead']);
		expect(view.showLargeNumber).toBe(false);
		expect(view.indicatorWord).toBe('Not connected');
	});

	it('link or code: the server field appears only for a team code', () => {
		expect(viewFor({ kind: 'linkOrCode', mode: 'joinLink' }, NOW).fields.map((f) => f.id)).toEqual([
			'joinLink',
		]);
		expect(viewFor(FULL.linkOrCode, NOW).fields.map((f) => f.label)).toEqual([
			'Team code',
			'Server',
		]);
		expect(viewFor(FULL.linkOrCode, NOW).primaryAction?.label).toBe('Connect');
	});

	it('managed: the connecting sentence and no action', () => {
		const view = viewFor(FULL.managed, NOW);
		expect(view.body).toBe('Your organization manages this Maestro. Connecting...');
		expect(view.primaryAction).toBeNull();
		expect(view.fields).toEqual([]);
	});

	it('browser opened: the large number and the request line', () => {
		const view = viewFor(FULL.browserOpened, NOW);
		expect(view.showLargeNumber).toBe(true);
		expect(view.largeNumber).toBe('47');
		expect(view.detail).toBe('Request REQ-1042 · mega.acme.com');
		expect(view.primaryAction?.label).toBe('Open the browser again');
		expect(view.indicatorWord).toBe('Waiting for approval');
	});

	it('browser opened: drops a missing or ID-shaped part instead of showing it', () => {
		const noServer = viewFor({ kind: 'browserOpened', matchNumber: '12', request: 7 }, NOW);
		expect(noServer.detail).toBe('Request REQ-7');
		const hostPort = viewFor(
			{ kind: 'browserOpened', request: 7, serverName: 'mega.acme.com:8443' },
			NOW
		);
		expect(hostPort.detail).toBe('Request REQ-7');
		expect(hostPort.showLargeNumber).toBe(false);
		const idRequest = viewFor({ kind: 'browserOpened', request: UUID, serverName: UUID }, NOW);
		expect(idRequest.detail).toBeNull();
		expectNoIds(idRequest);
	});

	it('waiting: names the request, or no request when the reference is unknown', () => {
		expect(viewFor(FULL.waiting, NOW).body).toBe(
			'Waiting for an admin to approve request REQ-1042. You can keep working; Maestro will connect by itself.'
		);
		const unnamed = viewFor({ kind: 'waiting', request: UUID }, NOW);
		expect(unnamed.body).not.toContain('{request}');
		expectNoIds(unnamed);
		expect(unnamed.primaryAction).toBeNull();
	});

	it('connected: title, detail line, Reconnect and Disconnect', () => {
		const view = viewFor(FULL.connected, NOW);
		expect(view.title).toBe('Connected to Acme');
		expect(view.detail).toBe('platform/web · Policy platform-default@12 enforced · synced 1m ago');
		expect(view.primaryAction?.label).toBe('Reconnect');
		expect(view.secondaryActions.map((a) => a.label)).toEqual(['Disconnect']);
		expect(view.indicatorWord).toBe('Connected');
	});

	it('connected: absent names drop their part and never fall back to an ID', () => {
		const bare = viewFor({ kind: 'connected' }, NOW);
		expect(bare.title).toBe('Connected');
		expect(bare.detail).toBeNull();
		const ids = viewFor(
			{
				kind: 'connected',
				orgName: UUID,
				teamPath: DIGEST,
				policy: { name: UUID, revision: 3 },
				syncedAt: NOW,
			},
			NOW
		);
		expect(ids.title).toBe('Connected');
		expect(ids.detail).toBe('synced just now');
		expectNoIds(ids);
	});

	it('denied and expired offer Try again', () => {
		expect(viewFor(FULL.denied, NOW).body).toBe('Your request was not approved.');
		expect(viewFor(FULL.denied, NOW).primaryAction?.label).toBe('Try again');
		expect(viewFor(FULL.expired, NOW).body).toBe('Your request expired before it was approved.');
		expect(viewFor(FULL.expired, NOW).primaryAction?.id).toBe('tryAgain');
	});

	it('revoked and grant expired offer Connect again and read as Needs reconnect', () => {
		for (const kind of ['revoked', 'grantExpired'] as const) {
			const view = viewFor(FULL[kind], NOW);
			expect(view.primaryAction?.label).toBe('Connect again');
			expect(view.indicatorWord).toBe('Needs reconnect');
		}
	});

	it('unavailable points at Troubleshoot and has no button', () => {
		const view = viewFor(FULL.unavailable, NOW);
		expect(view.body).toContain('Troubleshoot');
		expect(view.primaryAction).toBeNull();
		expect(view.indicatorWord).toBe('Unavailable');
	});

	it('shows the large number only while the browser is open', () => {
		for (const kind of MEGA_CONNECT_STATUS_KINDS) {
			expect(viewFor(FULL[kind], NOW).showLargeNumber).toBe(kind === 'browserOpened');
		}
	});
});
