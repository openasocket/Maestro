/**
 * MRC-11-06A and MRC-11-06B: the notice inbox seam (`src/main/enterprise/inbox.ts`). The wire is read structurally (a notice that admits agent input, an
 * untyped kind, an oversize body or a bad expiry is not one; a receipt whose
 * message or state does not match the action sent is null), the idempotency
 * key is deterministic per binding, action and reply text, the receipt
 * ledger over a real file holds no body and no reply text, the adapter's
 * inbox standing follows the registration and the negotiated capabilities,
 * and noticeList + inbox go over the real lifecycle, client and fake daemon
 * with the payloads pinned. Then the client (MRC-11-06B) over a doubled host
 * (standing + port table) and the real ledger on a temp file: the listing is
 * custody, delivered is recorded once per newly held notice, the four receipts
 * are distinct acts, every endpoint answer settles the record by name, a
 * not-sent is resent under the same key, refreshes coalesce, and neither a body
 * nor a reply text reaches the ledger file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	createInboxClient,
	createInboxReceiptLedger,
	inboxActionProblem,
	inboxIdempotencyKey,
	inboxView,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	openInboxReceipt,
	readInboxReceipt,
	readNotice,
	readNoticeListResult,
	type InboxClient,
	type InboxReceiptRecord,
} from '../../../main/enterprise/inbox';
import type {
	EndpointInvokeOutcome,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createManagedHostAdapter,
	type EndpointInboxAction,
	type EndpointInboxRequest,
	type EndpointNoticeListRequest,
	type InboxBinding,
	type InboxPort,
	type InboxStanding,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { startFakeEndpoint } from './fakeEndpoint';
import {
	INSTALLATION,
	NOW,
	registeredStatus,
	startRegisteredLifecycle,
	tempDirs,
} from './fakeManaged';

const tempDir = tempDirs('mrc-11-06a-inbox-');
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const BODY = 'Planned maintenance on Friday.';

const notice = (over: Record<string, unknown> = {}) => ({
	campaignId: CAMPAIGN,
	messageId: MESSAGE,
	body: BODY,
	expiresAt: new Date(NOW + 86_400_000).toISOString(),
	kind: 'notice',
	agentInput: false,
	...over,
});

const BINDING: InboxBinding = {
	tenantId: 'tenant-1',
	enrollmentId: 'enr-1',
	registrationId: 'ch-1',
	actorId: 'actor-1',
	installation: INSTALLATION,
	policyRevision: 3,
	capabilities: { noticeList: true, inbox: true },
};

function pending(key: string, action: InboxReceiptRecord['action'] = 'read'): InboxReceiptRecord {
	return {
		idempotencyKey: key,
		campaignId: CAMPAIGN,
		messageId: MESSAGE,
		action,
		reply: null,
		requestDigest: 'd'.repeat(64),
		tenantId: 'tenant-1',
		enrollmentId: 'enr-1',
		registrationId: 'ch-1',
		actorId: 'actor-1',
		policyRevision: 3,
		requestedAt: new Date(NOW).toISOString(),
		settledAt: null,
		state: 'pending',
		receipt: null,
		denial: null,
		detail: null,
	};
}

/** The host adapter over a doubled standing; `attached: false` is a detached socket. */
function adapter(status: ManagedEnrollmentStatus, attached = true) {
	return createManagedHostAdapter({
		installation: INSTALLATION,
		identity: { read: () => status.identity },
		endpoint: attached
			? ({ invoke: async () => ({ status: 'ok', payload: null }) } as never)
			: null,
		status: () => status,
		now: () => NOW,
	});
}

describe('the notice inbox seam', () => {
	it('reads a notice, a listing and a receipt structurally, and refuses what is not one', () => {
		expect(readNotice(notice())).toEqual(notice());
		expect(readNotice(notice({ agentInput: true }))).toBeNull();
		expect(readNotice(notice({ kind: 'alert' }))).toBeNull();
		expect(readNotice(notice({ body: 'x'.repeat(8193) }))).toBeNull();
		expect(readNotice(notice({ expiresAt: 'soon' }))).toBeNull();
		expect(readNotice(notice({ campaignId: '' }))).toBeNull();

		const page = (items: unknown[], nextOffset: unknown) => ({
			outcome: 'notices',
			items,
			nextOffset,
		});
		expect(readNoticeListResult(page([notice()], null))).toEqual(page([notice()], null));
		expect(readNoticeListResult(page([notice()], 3))?.nextOffset).toBe(3);
		expect(readNoticeListResult(page([notice()], 8))).toBeNull();
		expect(readNoticeListResult(page([notice(), { bad: true }], null))).toBeNull();
		expect(readNoticeListResult(page(Array(9).fill(notice()), null))).toBeNull();
		expect(readNoticeListResult({ outcome: 'denied', reason: 'unauthenticated' })).toBeNull();

		const request = { messageId: MESSAGE, action: { kind: 'reply', text: 'thanks' } as const };
		const receipt = (over: Record<string, unknown> = {}) => ({
			outcome: 'recorded',
			messageId: MESSAGE,
			receiptId: 'rcpt-1',
			state: 'replied',
			...over,
		});
		expect(readInboxReceipt(receipt(), request)).toEqual(receipt());
		expect(readInboxReceipt(receipt({ state: 'read' }), request)).toBeNull();
		expect(readInboxReceipt(receipt({ messageId: 'other' }), request)).toBeNull();
		expect(readInboxReceipt(receipt({ outcome: 'denied' }), request)).toBeNull();
		expect(
			readInboxReceipt(receipt({ state: 'read' }), { ...request, action: { kind: 'read' } })
		).toEqual(receipt({ state: 'read' }));

		expect(inboxActionProblem({ kind: 'read' })).toBeNull();
		expect(inboxActionProblem({ kind: 'reply', text: 'ok' })).toBeNull();
		expect(inboxActionProblem({ kind: 'reply', text: '' })).toMatch(/needs text/);
		expect(inboxActionProblem({ kind: 'reply', text: 'x'.repeat(8193) })).toMatch(/exceeds 8192/);
		expect(inboxActionProblem({ kind: 'read', extra: 1 })).toMatch(/more than its kind/);
		expect(inboxActionProblem({ kind: 'delete' })).toMatch(
			/not delivered, read, acknowledged or reply/
		);
		expect(inboxActionProblem('read')).toMatch(/not an object/);
	});

	it('keys an action on the binding and the action, deterministically, with a reply by its text digest', () => {
		const key = (binding: InboxBinding, action: Parameters<typeof inboxIdempotencyKey>[3]) =>
			inboxIdempotencyKey(binding, CAMPAIGN, MESSAGE, action);
		const read = key(BINDING, { kind: 'read' });
		expect(read).toMatch(/^[a-f0-9]{64}$/);
		expect(key(BINDING, { kind: 'read' })).toBe(read);
		expect(key(BINDING, { kind: 'acknowledged' })).not.toBe(read);
		expect(key({ ...BINDING, actorId: 'actor-2' }, { kind: 'read' })).not.toBe(read);
		expect(key({ ...BINDING, enrollmentId: 'enr-2' }, { kind: 'read' })).not.toBe(read);
		expect(
			inboxIdempotencyKey(BINDING, CAMPAIGN, '33333333-3333-4333-8333-333333333333', {
				kind: 'read',
			})
		).not.toBe(read);
		const reply = key(BINDING, { kind: 'reply', text: 'a' });
		expect(key(BINDING, { kind: 'reply', text: 'a' })).toBe(reply);
		expect(key(BINDING, { kind: 'reply', text: 'b' })).not.toBe(reply);
	});

	it('keeps receipts durably: not loaded refuses, restart turns pending uncertain, the cap spares pending, corrupt is named, no body on disk', async () => {
		const file = path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME);
		const ledger = createInboxReceiptLedger({ file, now: () => NOW, maxReceipts: 3 });
		await expect(ledger.put(pending('k1'))).rejects.toThrow(/not loaded/);
		expect(await ledger.load()).toEqual({ ok: true, receipts: 0, recoveredUncertain: 0 });
		await ledger.put(pending('k1'));
		await ledger.settle('k1', 'recorded', null, { receipt: { receiptId: 'r1', state: 'read' } });
		await ledger.put(pending('k2', 'acknowledged'));
		expect(
			ledger
				.list()
				.filter((r) => r.state === 'pending')
				.map((r) => r.idempotencyKey)
		).toEqual(['k2']);
		expect(ledger.byMessage(CAMPAIGN, MESSAGE)).toHaveLength(2);
		expect(ledger.get('k1')).toMatchObject({
			state: 'recorded',
			settledAt: new Date(NOW).toISOString(),
		});
		expect(await ledger.settle('nope', 'denied', 'x')).toBeNull();
		const onDisk = fs.readFileSync(file, 'utf8');
		expect(onDisk).toContain('k1');
		expect(onDisk).not.toContain(BODY);

		const again = createInboxReceiptLedger({ file, now: () => NOW + 1000, maxReceipts: 3 });
		expect(await again.load()).toEqual({ ok: true, receipts: 2, recoveredUncertain: 1 });
		expect(again.get('k2')).toMatchObject({ state: 'uncertain', detail: /restarted/ });
		expect(again.get('k1')).toMatchObject({ state: 'recorded', receipt: { receiptId: 'r1' } });

		await again.put(pending('k3'));
		await again.put(pending('k4', 'delivered'));
		expect(again.list().map((r) => r.idempotencyKey)).toEqual(['k2', 'k3', 'k4']);

		fs.writeFileSync(file, '{not json');
		const corrupt = createInboxReceiptLedger({ file, now: () => NOW });
		expect(await corrupt.load()).toMatchObject({ ok: false, reason: 'corrupt', file });
		await expect(corrupt.put(pending('k5'))).rejects.toThrow(/not loaded/);
		expect(fs.readFileSync(file, 'utf8')).toBe('{not json');
	});

	it('answers the inbox standing from the registration this process holds and the negotiated capabilities', () => {
		const ok = adapter(registeredStatus());
		expect(ok.inbox).not.toBeNull();
		expect(ok.inboxStanding()).toMatchObject({
			ok: true,
			binding: { ...BINDING, capabilities: { noticeList: true, inbox: true } },
		});
		expect(ok.inboxStanding().standingKey).toBe(ok.telemetryStanding().standingKey);
		expect(
			adapter(registeredStatus({ capabilities: ['telemetry'] })).inboxStanding()
		).toMatchObject({
			ok: false,
			reason: /neither noticeList nor inbox/,
		});
		expect(adapter(registeredStatus({ capabilities: ['inbox'] })).inboxStanding()).toMatchObject({
			ok: true,
			binding: { capabilities: { noticeList: false, inbox: true } },
		});
		const lapsed = registeredStatus();
		const record = (lapsed.identity as { record: ManagedIdentityRecord }).record;
		record.registration!.expiresAt = new Date(NOW - 1).toISOString();
		expect(adapter(lapsed).inboxStanding()).toMatchObject({
			ok: false,
			reason: /no live actor registration/,
		});
		const detached = adapter(registeredStatus(), false);
		expect(detached.inbox).toBeNull();
		expect(detached.inboxStanding()).toMatchObject({
			ok: false,
			reason: 'No endpoint is attached.',
		});
		const lost = adapter(registeredStatus({ actorId: null, authority: 'none', reason: 'lost' }));
		expect(lost.inboxStanding()).toMatchObject({ ok: false, reason: 'lost' });
	});

	it('over the real lifecycle, client and fake daemon: noticeList and inbox go over the socket with the payloads pinned', async () => {
		const calls: { operation: string; payload: unknown }[] = [];
		const fake = await startFakeEndpoint({
			registrationRequired: true,
			capabilities: ['execution', 'inbox', 'noticeList'],
			now: () => NOW,
			operations: {
				noticeList: (payload) => {
					calls.push({ operation: 'noticeList', payload });
					return { outcome: 'notices', items: [notice()], nextOffset: null };
				},
				inbox: (payload) => {
					calls.push({ operation: 'inbox', payload });
					const p = payload as { messageId: string; action: { kind: string } };
					return {
						outcome: 'recorded',
						messageId: p.messageId,
						receiptId: 'rcpt-1',
						state: p.action.kind,
					};
				},
			},
		});
		const { lifecycle, host } = await startRegisteredLifecycle({
			dir: tempDir(),
			socketPath: fake.socketPath,
			supported: ['inbox', 'noticeList'],
		});
		try {
			expect(lifecycle.status().authority).toBe('registered');
			const standing = host.inboxStanding();
			expect(standing).toMatchObject({
				ok: true,
				// Maestro's record names no actor id today (CP-01/CP-04).
				binding: {
					tenantId: 'tenant-1',
					enrollmentId: 'enr-1',
					actorId: null,
					installation: INSTALLATION,
					capabilities: { noticeList: true, inbox: true },
				},
			});
			if (!standing.ok) throw new Error(standing.reason);
			const inbox = host.inbox!;
			const listed = await inbox.list({ offset: 0, limit: 8 });
			expect(listed.status).toBe('ok');
			expect(readNoticeListResult(listed.status === 'ok' ? listed.payload : null)).toEqual({
				outcome: 'notices',
				items: [notice()],
				nextOffset: null,
			});
			const action = { kind: 'delivered' as const };
			const request = {
				campaignId: CAMPAIGN,
				messageId: MESSAGE,
				idempotencyKey: inboxIdempotencyKey(standing.binding, CAMPAIGN, MESSAGE, action),
				action,
			};
			const acted = await inbox.act(request);
			expect(acted.status).toBe('ok');
			expect(readInboxReceipt(acted.status === 'ok' ? acted.payload : null, request)).toEqual({
				outcome: 'recorded',
				messageId: MESSAGE,
				receiptId: 'rcpt-1',
				state: 'delivered',
			});
			expect(calls).toEqual([
				{ operation: 'noticeList', payload: { offset: 0, limit: 8 } },
				{ operation: 'inbox', payload: request },
			]);
			await lifecycle.close();
			expect(host.inboxStanding()).toMatchObject({ ok: false });
		} finally {
			await lifecycle.close();
			await fake.close();
		}
	});
});

// ---------------------------------------------------------------------------
// The inbox client (MRC-11-06B), over a doubled host and the real ledger
// ---------------------------------------------------------------------------

const M2 = '33333333-3333-4333-8333-333333333333';
const M3 = '44444444-4444-4444-8444-444444444444';
const REPLY_TEXT = 'Thanks, noted the maintenance window.';

interface Double {
	standing: InboxStanding;
	/** The listing the port answers for each offset; a missing page is an empty last page. */
	pages: Array<EndpointInvokeOutcome<unknown>>;
	acts: EndpointInboxRequest[];
	lists: EndpointNoticeListRequest[];
	answer: (request: EndpointInboxRequest) => EndpointInvokeOutcome<unknown>;
	port: InboxPort | null;
}

const recordedAnswer = (request: EndpointInboxRequest): EndpointInvokeOutcome<unknown> => ({
	status: 'ok',
	payload: {
		outcome: 'recorded',
		messageId: request.messageId,
		receiptId: `rcpt-${request.action.kind}-${request.messageId.slice(0, 2)}`,
		state: request.action.kind === 'reply' ? 'replied' : request.action.kind,
	},
});

function double(): Double {
	const d: Double = {
		standing: { standingKey: 'k1', ok: true, binding: BINDING },
		pages: [],
		acts: [],
		lists: [],
		answer: recordedAnswer,
		port: null,
	};
	d.port = {
		list: async (request) => {
			d.lists.push(request);
			return (
				d.pages[request.offset] ?? {
					status: 'ok',
					payload: { outcome: 'notices', items: [], nextOffset: null },
				}
			);
		},
		act: async (request) => {
			d.acts.push(request);
			return d.answer(request);
		},
	};
	return d;
}

/** The client over the double; with no file the ledger is in memory and loaded at once. */
function client(d: Double, file?: string): InboxClient {
	return createInboxClient({
		host: {
			inboxStanding: () => d.standing,
			get inbox() {
				return d.port;
			},
		},
		ledger: createInboxReceiptLedger({ file, now: () => NOW }),
		now: () => NOW,
	});
}

const page = (items: unknown[], nextOffset: number | null): EndpointInvokeOutcome<unknown> => ({
	status: 'ok',
	payload: { outcome: 'notices', items, nextOffset },
});

const held = (c: InboxClient, messageId: string, action: EndpointInboxAction) =>
	c.act({ campaignId: CAMPAIGN, messageId, action });

describe('the inbox client', () => {
	it('refreshes over two pages, drops the expired, records delivered once per newly held notice, and follows the listing as custody', async () => {
		const d = double();
		d.pages[0] = page(
			[notice(), notice({ messageId: M2, expiresAt: new Date(NOW - 1).toISOString() })],
			1
		);
		d.pages[1] = page([notice({ messageId: M3, body: 'Body of M3' })], null);
		const c = client(d, path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME));
		expect((await c.load()).ok).toBe(true);
		expect(await c.refresh()).toMatchObject({
			outcome: 'listed',
			at: new Date(NOW).toISOString(),
			pages: 2,
			listed: 3,
			expired: 1,
			newlyHeld: 2,
			delivered: { recorded: 2, uncertain: 0, denied: 0, unavailable: 0 },
		});
		expect(d.lists).toEqual([
			{ offset: 0, limit: 8 },
			{ offset: 1, limit: 8 },
		]);
		expect(d.acts.map((a) => [a.messageId, a.action.kind])).toEqual([
			[MESSAGE, 'delivered'],
			[M3, 'delivered'],
		]);
		const views = c.notices();
		expect(views.map((v) => v.messageId)).toEqual([MESSAGE, M3]);
		expect(views[0]).toMatchObject({
			body: BODY,
			agentInput: false,
			recorded: 'delivered',
			receipts: { delivered: 'recorded' },
			firstListedAt: new Date(NOW).toISOString(),
		});

		// The second listing names M3 no longer: nothing new is delivered and M3 is no longer held.
		d.pages = [page([notice()], null)];
		expect(await c.refresh()).toMatchObject({
			outcome: 'listed',
			pages: 1,
			listed: 1,
			newlyHeld: 0,
		});
		expect(d.acts).toHaveLength(2);
		expect(c.notices().map((v) => v.messageId)).toEqual([MESSAGE]);
		expect(c.status().notices).toEqual({ held: 1, unread: 1, unacknowledged: 1 });
		// A page that points at itself ends the walk.
		d.pages = [page([notice()], 1), page([], 1)];
		expect(await c.refresh()).toMatchObject({ outcome: 'listed', pages: 2, listed: 1 });
	});

	it('acts: unknown message and invalid action are refused, the four receipts are distinct, the duplicate is answered from the ledger, no text reaches the disk', async () => {
		const d = double();
		d.pages[0] = page([notice()], null);
		const file = path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME);
		const c = client(d, file);
		await c.load();

		// Loaded, but nothing is held yet: nobody here has seen the message.
		expect(await held(c, MESSAGE, { kind: 'read' })).toMatchObject({
			status: 'denied',
			reason: 'unknown-message',
			detail: `message ${MESSAGE} of campaign ${CAMPAIGN} is not held on this host`,
			record: null,
		});
		await c.refresh();
		expect(await held(c, MESSAGE, { kind: 'reply', text: '' })).toMatchObject({
			status: 'denied',
			reason: 'invalid-action',
			detail: expect.stringMatching(/needs text/),
			record: null,
		});
		expect(d.acts.map((a) => a.action.kind)).toEqual(['delivered']);

		const read = await held(c, MESSAGE, { kind: 'read' });
		expect(read).toMatchObject({
			status: 'recorded',
			duplicate: false,
			record: { state: 'recorded', action: 'read', receipt: { state: 'read' } },
		});
		expect(await held(c, MESSAGE, { kind: 'read' })).toMatchObject({
			status: 'recorded',
			duplicate: true,
			record: { receipt: { receiptId: 'rcpt-read-22' } },
		});
		expect(d.acts.filter((a) => a.action.kind === 'read')).toHaveLength(1);

		expect(await held(c, MESSAGE, { kind: 'acknowledged' })).toMatchObject({
			status: 'recorded',
			record: { action: 'acknowledged', receipt: { state: 'acknowledged' } },
		});
		expect(await held(c, MESSAGE, { kind: 'reply', text: REPLY_TEXT })).toMatchObject({
			status: 'recorded',
			record: {
				action: 'reply',
				reply: { length: REPLY_TEXT.length },
				receipt: { state: 'replied' },
			},
		});
		expect(d.acts.map((a) => a.action.kind)).toEqual([
			'delivered',
			'read',
			'acknowledged',
			'reply',
		]);
		const view = inboxView(c);
		expect(view.notices).toHaveLength(1);
		expect(view.notices.every((n) => n.agentInput === false)).toBe(true);
		expect(view.notices[0]).toMatchObject({
			recorded: 'replied',
			receipts: {
				delivered: 'recorded',
				read: 'recorded',
				acknowledged: 'recorded',
				reply: 'recorded',
			},
		});
		expect(view.status.notices).toEqual({ held: 1, unread: 0, unacknowledged: 0 });
		expect(view.status.receipts).toEqual({
			total: 4,
			byState: { pending: 0, recorded: 4, denied: 0, uncertain: 0 },
		});
		expect(view.status).toMatchObject({ file, loaded: true, standing: { ok: true } });

		const onDisk = fs.readFileSync(file, 'utf8');
		expect(onDisk).not.toContain(REPLY_TEXT);
		expect(onDisk).not.toContain('maintenance');
		expect(onDisk).not.toContain(BODY);
		const key = inboxIdempotencyKey(BINDING, CAMPAIGN, MESSAGE, { kind: 'read' });
		const receipt = c.receipts().find((r) => r.idempotencyKey === key);
		expect(receipt).toMatchObject({ actorId: 'actor-1', policyRevision: 3, reply: null });
		expect(receipt?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(openInboxReceipt(BINDING, d.acts[1], 'x')).toMatchObject({
			idempotencyKey: d.acts[1].idempotencyKey,
			requestDigest: receipt?.requestDigest,
			state: 'pending',
		});
	});

	it('settles denied, replay, unknown, a mismatched receipt and not-sent distinctly, and resends after not-sent under the same key', async () => {
		const d = double();
		d.pages[0] = page([notice()], null);
		const c = client(d);
		expect(c.status()).toMatchObject({ file: null, loaded: true });
		await c.refresh();
		const act = (kind: 'read' | 'acknowledged') => held(c, MESSAGE, { kind });

		d.answer = () => ({ status: 'denied', reason: 'unauthenticated' });
		expect(await act('read')).toMatchObject({
			status: 'denied',
			reason: 'unauthenticated',
			detail: 'the endpoint refused the action: unauthenticated',
			record: { state: 'denied', denial: 'unauthenticated' },
		});
		d.answer = () => ({ status: 'denied', reason: 'replay' });
		expect(await act('read')).toMatchObject({
			status: 'uncertain',
			record: {
				state: 'uncertain',
				denial: 'replay',
				detail: expect.stringContaining('replay'),
			},
		});
		d.answer = () => ({ status: 'unknown', message: 'socket closed mid-answer' });
		expect(await act('acknowledged')).toMatchObject({
			status: 'uncertain',
			detail: 'socket closed mid-answer',
			record: { state: 'uncertain', denial: null, detail: 'socket closed mid-answer' },
		});
		d.answer = (request) => ({
			status: 'ok',
			payload: { outcome: 'recorded', messageId: request.messageId, receiptId: 'r', state: 'read' },
		});
		expect(await act('acknowledged')).toMatchObject({
			status: 'uncertain',
			detail: expect.stringContaining('does not match'),
			record: { receipt: null },
		});
		d.answer = () => ({ status: 'unavailable', reason: 'not-attached', message: 'no socket' });
		expect(await act('acknowledged')).toEqual({ status: 'unavailable', detail: 'no socket' });
		const key = inboxIdempotencyKey(BINDING, CAMPAIGN, MESSAGE, { kind: 'acknowledged' });
		expect(c.receipts().find((r) => r.idempotencyKey === key)).toMatchObject({
			state: 'uncertain',
			detail: 'not sent: no socket',
		});
		d.answer = recordedAnswer;
		expect(await act('acknowledged')).toMatchObject({
			status: 'recorded',
			duplicate: false,
			// The settlement names its own detail; the resent note lived on the pending record alone.
			record: { detail: null, receipt: { state: 'acknowledged' } },
		});
		expect(
			d.acts.filter((a) => a.action.kind === 'acknowledged').map((a) => a.idempotencyKey)
		).toEqual(Array(4).fill(key));
		expect(c.notices()[0]).toMatchObject({
			recorded: 'acknowledged',
			receipts: { delivered: 'recorded', read: 'uncertain', acknowledged: 'recorded' },
		});
		expect(c.status().receipts).toEqual({
			total: 3,
			byState: { pending: 0, recorded: 2, denied: 0, uncertain: 1 },
		});
	});

	it('refuses by name when not loaded, without standing, without the capability or the socket, and coalesces refreshes', async () => {
		const d = double();
		d.pages[0] = page([notice()], null);
		const c = client(d, path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME));
		expect(await held(c, MESSAGE, { kind: 'read' })).toEqual({
			status: 'unavailable',
			detail: 'The inbox receipt ledger is not loaded.',
		});
		expect(c.status()).toMatchObject({ loaded: false, load: null, lastRefresh: null });
		await c.load();

		d.standing = { standingKey: 'k0', ok: false, reason: 'not registered' };
		expect(await c.refresh()).toMatchObject({
			outcome: 'no-standing',
			reason: 'not registered',
			pages: 0,
		});
		expect(await held(c, MESSAGE, { kind: 'read' })).toEqual({
			status: 'unavailable',
			detail: 'not registered',
		});
		expect(c.status()).toMatchObject({
			standing: { ok: false, reason: 'not registered' },
			capabilities: { noticeList: false, inbox: false },
		});
		d.standing = {
			standingKey: 'k2',
			ok: true,
			binding: { ...BINDING, capabilities: { noticeList: false, inbox: true } },
		};
		expect(await c.refresh()).toMatchObject({
			outcome: 'no-standing',
			reason: expect.stringContaining('noticeList'),
		});
		d.standing = {
			standingKey: 'k3',
			ok: true,
			binding: { ...BINDING, capabilities: { noticeList: true, inbox: false } },
		};
		expect(await c.refresh()).toMatchObject({
			outcome: 'listed',
			newlyHeld: 1,
			delivered: { recorded: 0, uncertain: 0, denied: 0, unavailable: 1 },
		});
		expect(d.acts).toHaveLength(0);
		expect(c.notices()[0]).toMatchObject({ recorded: null, receipts: {} });
		expect(await held(c, MESSAGE, { kind: 'read' })).toEqual({
			status: 'unavailable',
			detail: 'The endpoint negotiated no inbox capability on this connection.',
		});

		d.standing = { standingKey: 'k1', ok: true, binding: BINDING };
		const p1 = c.refresh();
		const p2 = c.refresh();
		expect(p1).toBe(p2);
		await p1;
		expect(d.lists.filter((l) => l.offset === 0)).toHaveLength(2);
		expect(c.status().lastRefresh?.outcome).toBe('listed');
		// Once it has settled, the next refresh is a new one.
		const p3 = c.refresh();
		expect(p3).not.toBe(p1);
		await p3;

		d.port = null;
		expect(await c.refresh()).toMatchObject({
			outcome: 'no-standing',
			reason: 'No endpoint socket is open.',
		});
		expect(await held(c, MESSAGE, { kind: 'read' })).toEqual({
			status: 'unavailable',
			detail: 'No endpoint socket is open.',
		});
		expect(c.receipts()).toHaveLength(0);
	});

	it('answers a denied listing, a malformed page and an unavailable one by name', async () => {
		const d = double();
		d.pages[0] = { status: 'denied', reason: 'unauthenticated' };
		const c = client(d);
		expect(await c.refresh()).toMatchObject({
			outcome: 'denied',
			denial: 'unauthenticated',
			reason: 'the endpoint refused the listing: unauthenticated',
			pages: 1,
			listed: 0,
		});
		d.pages[0] = page([{ bad: true }], null);
		expect(await c.refresh()).toMatchObject({
			outcome: 'malformed',
			reason: 'the endpoint answered with no notice list',
		});
		d.pages[0] = { status: 'unavailable', reason: 'timeout', message: 'timed out' };
		expect(await c.refresh()).toMatchObject({ outcome: 'unavailable', reason: 'timed out' });
		expect(c.notices()).toEqual([]);
		expect(d.acts).toHaveLength(0);
		expect(c.status().lastRefresh).toMatchObject({ outcome: 'unavailable' });
	});
});
