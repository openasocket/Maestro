import { describe, expect, it } from 'vitest';
import { MEGA_CONNECT_COPY } from '../../../shared/megaConnect/copy';
import {
	createMegaConnectNotifier,
	notificationFor,
	type MegaConnectNotification,
} from '../../../shared/megaConnect/notify';
import type { MegaConnectStatus } from '../../../shared/megaConnect/view';

const GRANT_ID = '3f2b1c9e-8a4d-4e7f-9b21-0c5d6e7f8a9b';
const SOCKET = '/var/lib/mega-maestro-endpoint/run/ipc.sock';
const MATCH_NUMBER = '4721';

const waiting: MegaConnectStatus = { kind: 'waiting', request: 1042 };
const connected: MegaConnectStatus = {
	kind: 'connected',
	orgName: 'Acme',
	teamPath: 'platform/web',
	policy: { name: 'platform-default', revision: 12 },
	syncedAt: Date.UTC(2026, 10, 20, 12, 0, 0),
};

function expectClean(notification: MegaConnectNotification | null) {
	expect(notification).not.toBeNull();
	for (const text of Object.values(notification!)) {
		expect(text).not.toContain(MATCH_NUMBER);
		expect(text).not.toContain(GRANT_ID);
		expect(text).not.toContain(SOCKET);
		expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
	}
}

describe('notificationFor', () => {
	it('announces waiting to connected with the organization name and team detail', () => {
		const n = notificationFor(waiting, connected);
		expect(n).toEqual({
			transition: 'waitingToConnected',
			title: 'Connected to Acme',
			body: 'platform/web · Policy platform-default@12 enforced',
			dedupeKey: 'waitingToConnected:REQ-1042',
		});
		expectClean(n);
	});

	it('falls back to unnamed copy, never an ID, when the connected names are absent or ID-shaped', () => {
		const n = notificationFor(waiting, { kind: 'connected', orgName: GRANT_ID });
		expect(n?.title).toBe(MEGA_CONNECT_COPY.connectedTitleUnnamed);
		expect(n?.body).toBe(MEGA_CONNECT_COPY.notifyConnectedBody);
		expectClean(n);
	});

	it.each([
		[waiting, { kind: 'denied' }, 'waitingToDenied', 'notifyDeniedTitle', 'deniedBody'],
		[waiting, { kind: 'expired' }, 'waitingToExpired', 'notifyExpiredTitle', 'expiredBody'],
		[connected, { kind: 'revoked' }, 'connectedToRevoked', 'notifyRevokedTitle', 'revokedBody'],
		[
			connected,
			{ kind: 'grantExpired' },
			'connectedToGrantExpired',
			'notifyGrantExpiredTitle',
			'grantExpiredBody',
		],
	] as const)(
		'announces %s.kind to %s.kind from copy',
		(prev, next, transition, titleKey, bodyKey) => {
			const n = notificationFor(prev, next as MegaConnectStatus);
			expect(n?.transition).toBe(transition);
			expect(n?.title).toBe(MEGA_CONNECT_COPY[titleKey]);
			expect(n?.body).toBe(MEGA_CONNECT_COPY[bodyKey]);
			expectClean(n);
		}
	);

	it('keys a decision by the request reference and a lost connection by the transition alone', () => {
		expect(notificationFor(waiting, { kind: 'denied' })?.dedupeKey).toBe(
			'waitingToDenied:REQ-1042'
		);
		expect(notificationFor({ kind: 'waiting' }, { kind: 'expired' })?.dedupeKey).toBe(
			'waitingToExpired:none'
		);
		expect(notificationFor(connected, { kind: 'revoked' })?.dedupeKey).toBe(
			'connectedToRevoked:none'
		);
	});

	it('announces nothing for unchanged or unlisted transitions', () => {
		expect(notificationFor(null, connected)).toBeNull();
		expect(notificationFor(waiting, waiting)).toBeNull();
		expect(notificationFor(connected, connected)).toBeNull();
		expect(notificationFor({ kind: 'notConnected' }, waiting)).toBeNull();
		expect(
			notificationFor(
				{ kind: 'browserOpened', matchNumber: MATCH_NUMBER, request: 1042 },
				{ kind: 'waiting', request: 1042 }
			)
		).toBeNull();
		expect(notificationFor({ kind: 'notConnected' }, { kind: 'revoked' })).toBeNull();
		expect(notificationFor(connected, { kind: 'unavailable' })).toBeNull();
	});
});

describe('createMegaConnectNotifier', () => {
	it('announces a transition once across repeated polls', () => {
		const notifier = createMegaConnectNotifier();
		expect(
			notifier.observe({ kind: 'browserOpened', matchNumber: MATCH_NUMBER, request: 1042 })
		).toBeNull();
		expect(notifier.observe(waiting)).toBeNull();
		expect(notifier.observe(waiting)).toBeNull();
		const first = notifier.observe(connected);
		expect(first?.transition).toBe('waitingToConnected');
		expectClean(first);
		expect(notifier.observe(connected)).toBeNull();
		expect(notifier.observe(connected)).toBeNull();
	});

	it('does not re-announce when a poll flaps back to the same request', () => {
		const notifier = createMegaConnectNotifier();
		notifier.observe(waiting);
		expect(notifier.observe({ kind: 'denied' })?.transition).toBe('waitingToDenied');
		// A stale poll reports the request as waiting again, then denied again.
		expect(notifier.observe(waiting)).toBeNull();
		expect(notifier.observe({ kind: 'denied' })).toBeNull();
	});

	it('announces a revocation again after a new request connects', () => {
		const notifier = createMegaConnectNotifier();
		notifier.observe(waiting);
		notifier.observe(connected);
		expect(notifier.observe({ kind: 'revoked' })?.transition).toBe('connectedToRevoked');
		notifier.observe({ kind: 'notConnected' });
		notifier.observe({ kind: 'waiting', request: 1043 });
		expect(notifier.observe(connected)?.dedupeKey).toBe('waitingToConnected:REQ-1043');
		expect(notifier.observe({ kind: 'revoked' })?.transition).toBe('connectedToRevoked');
	});
});
