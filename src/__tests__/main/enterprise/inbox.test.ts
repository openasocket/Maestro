/**
 * MRC-11-06A: the notice inbox seam (`src/main/enterprise/inbox.ts`), part
 * one. The wire is read structurally (a notice that admits agent input, an
 * untyped kind, an oversize body or a bad expiry is not one; a receipt whose
 * message or state does not match the action sent is null), the idempotency
 * key is deterministic per binding, action and reply text, the receipt
 * ledger over a real file holds no body and no reply text, the adapter's
 * inbox standing follows the registration and the negotiated capabilities,
 * and noticeList + inbox go over the real lifecycle, client and fake daemon
 * with the payloads pinned. The inbox client is MRC-11-06B.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
	createInboxReceiptLedger,
	inboxActionProblem,
	inboxIdempotencyKey,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	readInboxReceipt,
	readNotice,
	readNoticeListResult,
	type InboxReceiptRecord,
} from '../../../main/enterprise/inbox';
import type {
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createManagedHostAdapter,
	type InboxBinding,
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
