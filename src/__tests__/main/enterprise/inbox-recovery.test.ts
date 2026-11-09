/**
 * MCOMP-29-02: the notice inbox across a restart and a lost answer
 * (`src/main/enterprise/inbox.ts`). The four receipts stay distinct and
 * durable: a `pending` record a crashed process left is `uncertain` after
 * `load()`, the next listing resends `delivered` under the same key, and
 * `recover()` asks the endpoint's receipt custody (RECOVERY-LOCAL/1, a
 * proposal: the fixtures here parse under the pinned
 * `deviceInboxRecoveryResult`, but no production host composes the port) about
 * every `uncertain` receipt. A recovered receipt settles `recorded` only when
 * its custody names the exact action sent; `receipt_missing_or_unbound` keeps
 * it `uncertain` and nothing is resent, least of all a private reply, whose
 * text is kept nowhere. No body or reply text reaches the ledger file or a
 * recovery request.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import {
	createInboxClient,
	createInboxReceiptLedger,
	inboxIdempotencyKey,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	readInboxRecoveryResult,
	type InboxReceiptRecord,
	type InboxRecoveryPort,
	type InboxRecoveryRequest,
} from '../../../main/enterprise/inbox';
import type { EndpointInvokeOutcome } from '../../../shared/maestro-lib/managed/endpoint-port';
import type {
	EndpointInboxRequest,
	InboxBinding,
	InboxPort,
	InboxStanding,
} from '../../../shared/maestro-lib/managed/host-adapter';
import { INSTALLATION, NOW, tempDirs } from './fakeManaged';

let endpoint: typeof import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
beforeAll(async () => {
	endpoint = await import('../../../../vendor/mega-maestro/contracts/dist/local-endpoint.js');
});

const tempDir = tempDirs('mcomp-29-02-inbox-');
const TENANT = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const ORG = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const ENROLLMENT = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c';
const ACTOR = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
const CHALLENGE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const BODY = 'Planned maintenance on Friday.';
const REPLY_TEXT = 'Noted, thank you.';

const BINDING: InboxBinding = {
	tenantId: TENANT,
	enrollmentId: ENROLLMENT,
	registrationId: CHALLENGE,
	actorId: ACTOR,
	installation: INSTALLATION,
	policyRevision: 4,
	capabilities: { noticeList: true, inbox: true },
};

const notice = {
	campaignId: CAMPAIGN,
	messageId: MESSAGE,
	body: BODY,
	expiresAt: new Date(NOW + 86_400_000).toISOString(),
	kind: 'notice',
	agentInput: false,
};

/** The pinned recovered result for `record`, with any custody field overridden. */
function recovered(record: InboxReceiptRecord, custody: Record<string, unknown> = {}) {
	return {
		version: 1,
		outcome: 'recovered',
		receipt: {
			outcome: 'recorded',
			messageId: record.messageId,
			receiptId: `rcpt-${record.action}`,
			state: record.action === 'reply' ? 'replied' : record.action,
			custody: {
				tenantId: TENANT,
				enrollmentId: ENROLLMENT,
				installationId: INSTALLATION.installationId,
				registration: {
					bindingDigest: 'b'.repeat(64),
					processBirthDigest: 'c'.repeat(64),
					runtimeId: INSTALLATION.runtimeId,
					processEpoch: INSTALLATION.processEpoch,
					version: 1,
					tenantId: TENANT,
					orgId: ORG,
					enrollmentId: ENROLLMENT,
					installationId: INSTALLATION.installationId,
					challengeId: CHALLENGE,
				},
				actorId: ACTOR,
				campaignId: record.campaignId,
				idempotencyKey: record.idempotencyKey,
				requestDigest: record.requestDigest,
				recordedAt: new Date(NOW).toISOString(),
				...custody,
			},
		},
	};
}
const MISSING = { version: 1, outcome: 'unavailable', reason: 'receipt_missing_or_unbound' };

interface Rig {
	standing: InboxStanding;
	acts: EndpointInboxRequest[];
	answer: (request: EndpointInboxRequest) => EndpointInvokeOutcome<unknown>;
	asked: InboxRecoveryRequest[];
	custody: (request: InboxRecoveryRequest) => EndpointInvokeOutcome<unknown>;
	recovery: InboxRecoveryPort | null;
	port: InboxPort;
}

function rig(): Rig {
	const r = {
		standing: { standingKey: 'k1', ok: true, binding: BINDING },
		acts: [],
		asked: [],
		answer: (request: EndpointInboxRequest) => ({
			status: 'ok',
			payload: {
				outcome: 'recorded',
				messageId: request.messageId,
				receiptId: `rcpt-${request.action.kind}`,
				state: request.action.kind === 'reply' ? 'replied' : request.action.kind,
			},
		}),
		custody: () => ({ status: 'ok', payload: MISSING }),
	} as unknown as Rig;
	r.port = {
		list: async () => ({
			status: 'ok',
			payload: { outcome: 'notices', items: [notice], nextOffset: null },
		}),
		act: async (request) => {
			r.acts.push(request);
			return r.answer(request);
		},
	};
	r.recovery = {
		recover: async (request) => {
			r.asked.push(request);
			return r.custody(request);
		},
	};
	return r;
}

/** A client over the rig and the ledger file: one per "process". */
function processOn(r: Rig, file: string, withRecovery = true) {
	return createInboxClient({
		host: { inboxStanding: () => r.standing, inbox: r.port },
		ledger: createInboxReceiptLedger({ file, now: () => NOW }),
		recovery: withRecovery ? () => r.recovery : undefined,
		now: () => NOW,
	});
}

const lost: EndpointInvokeOutcome<unknown> = { status: 'unknown', message: 'socket closed' };

describe('inbox receipt recovery (RECOVERY-LOCAL/1)', () => {
	it('reads a pinned recovery result only when its custody names the exact action sent', async () => {
		const r = rig();
		r.answer = () => lost;
		const client = processOn(r, path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME));
		await client.load();
		await client.refresh();
		const record = client.receipts()[0];
		expect(record).toMatchObject({ action: 'delivered', state: 'uncertain' });

		const good = recovered(record);
		expect(endpoint.deviceInboxRecoveryResult.safeParse(good).success).toBe(true);
		expect(endpoint.deviceInboxRecoveryResult.safeParse(MISSING).success).toBe(true);
		expect(readInboxRecoveryResult(good, record)).toEqual({
			outcome: 'recovered',
			receipt: { receiptId: 'rcpt-delivered', state: 'delivered' },
		});
		expect(readInboxRecoveryResult(MISSING, record)).toEqual({ outcome: 'unavailable' });

		// Every one of these is a real receipt, but not of this action.
		const other = '9'.repeat(64);
		for (const custody of [
			{ idempotencyKey: 'another-key' },
			{ requestDigest: other },
			{ campaignId: '33333333-3333-4333-8333-333333333333' },
			{ tenantId: ORG },
			{ enrollmentId: ORG },
			{ actorId: ORG },
			{ registration: { ...good.receipt.custody.registration, challengeId: ORG } },
		]) {
			const answer = recovered(record, custody);
			expect(endpoint.deviceInboxRecoveryResult.safeParse(answer).success).toBe(true);
			expect(readInboxRecoveryResult(answer, record)).toBeNull();
		}
		const wrongState = { ...good, receipt: { ...good.receipt, state: 'read' } };
		expect(endpoint.deviceInboxRecoveryResult.safeParse(wrongState).success).toBe(true);
		expect(readInboxRecoveryResult(wrongState, record)).toBeNull();
		expect(readInboxRecoveryResult({ ...MISSING, version: 2 }, record)).toBeNull();
		expect(readInboxRecoveryResult({ ...MISSING, reason: 'other' }, record)).toBeNull();
	});

	it('keeps the four receipts distinct across a restart and recovers lost answers from custody', async () => {
		const file = path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME);
		const r = rig();
		const first = processOn(r, file);
		await first.load();
		await first.refresh();
		expect(
			await first.act({ campaignId: CAMPAIGN, messageId: MESSAGE, action: { kind: 'read' } })
		).toMatchObject({ status: 'recorded' });
		// The acknowledgement's and the reply's answers are lost.
		r.answer = () => lost;
		await first.act({ campaignId: CAMPAIGN, messageId: MESSAGE, action: { kind: 'acknowledged' } });
		await first.act({
			campaignId: CAMPAIGN,
			messageId: MESSAGE,
			action: { kind: 'reply', text: REPLY_TEXT },
		});
		// A crash with a fifth action in flight leaves a pending record on disk.
		const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
		const ackKey = inboxIdempotencyKey(BINDING, CAMPAIGN, MESSAGE, { kind: 'acknowledged' });
		doc.receipts.find((x: InboxReceiptRecord) => x.idempotencyKey === ackKey).state = 'pending';
		fs.writeFileSync(file, JSON.stringify(doc));

		// The second process: the ledger is the memory, the listing restores what is held.
		r.answer = rig().answer;
		const second = processOn(r, file);
		expect(await second.load()).toMatchObject({ ok: true, receipts: 4, recoveredUncertain: 1 });
		expect(second.notices()).toEqual([]);
		const actsBefore = r.acts.length;
		await second.refresh();
		// delivered was recorded before: the listing sends nothing again.
		expect(r.acts.length).toBe(actsBefore);
		expect(second.notices()[0]).toMatchObject({
			recorded: 'read',
			receipts: {
				delivered: 'recorded',
				read: 'recorded',
				acknowledged: 'uncertain',
				reply: 'uncertain',
			},
		});

		// Custody holds the acknowledgement; the reply never reached the endpoint.
		r.custody = (request) => {
			const record = second
				.receipts()
				.find((x) => x.idempotencyKey === request.operation.idempotencyKey);
			return {
				status: 'ok',
				payload: record?.action === 'acknowledged' ? recovered(record) : MISSING,
			};
		};
		expect(await second.recover()).toMatchObject({
			outcome: 'checked',
			uncertain: 2,
			recovered: 1,
			missing: 1,
			mismatched: 0,
			unbound: 0,
			unavailable: 0,
		});
		expect(r.asked).toHaveLength(2);
		for (const request of r.asked) {
			expect(Object.keys(request).sort()).toEqual(['operation', 'requestDigest', 'version']);
			expect(JSON.stringify(request)).not.toContain(REPLY_TEXT);
			expect(JSON.stringify(request)).not.toContain(BODY);
		}
		// Nothing was resent by recovery, least of all the reply.
		expect(r.acts.length).toBe(actsBefore);
		expect(second.notices()[0]).toMatchObject({
			recorded: 'acknowledged',
			receipts: { acknowledged: 'recorded', reply: 'uncertain' },
		});
		const ack = second.receipts().find((x) => x.idempotencyKey === ackKey);
		expect(ack).toMatchObject({
			state: 'recorded',
			receipt: { receiptId: 'rcpt-acknowledged', state: 'acknowledged' },
			detail: 'recovered from the endpoint receipt custody',
		});

		// The person sends the same reply again: same key, one receipt.
		expect(
			await second.act({
				campaignId: CAMPAIGN,
				messageId: MESSAGE,
				action: { kind: 'reply', text: REPLY_TEXT },
			})
		).toMatchObject({ status: 'recorded', record: { action: 'reply', state: 'recorded' } });
		const replies = second.receipts().filter((x) => x.action === 'reply');
		expect(replies).toHaveLength(1);
		expect(r.acts.filter((a) => a.action.kind === 'reply').map((a) => a.idempotencyKey)).toEqual([
			replies[0].idempotencyKey,
			replies[0].idempotencyKey,
		]);
		// A recorded receipt is never asked about again.
		r.asked.length = 0;
		expect(await second.recover()).toMatchObject({ uncertain: 0, recovered: 0 });
		expect(r.asked).toEqual([]);

		const onDisk = fs.readFileSync(file, 'utf8');
		expect(onDisk).not.toContain(REPLY_TEXT);
		expect(onDisk).not.toContain(BODY);
	});

	it('asks nothing without a negotiated recovery port, without standing, or for another tenant', async () => {
		const file = path.join(tempDir(), MANAGED_INBOX_RECEIPTS_FILE_NAME);
		const r = rig();
		r.answer = () => lost;
		const seed = processOn(r, file);
		await seed.load();
		await seed.refresh();

		const none = processOn(r, file, false);
		expect(await none.recover()).toMatchObject({ outcome: 'not-loaded' });
		await none.load();
		expect(await none.recover()).toMatchObject({ outcome: 'unsupported', uncertain: 1 });

		const c = processOn(r, file);
		await c.load();
		r.standing = { standingKey: 'k2', ok: false, reason: 'not registered' };
		expect(await c.recover()).toMatchObject({ outcome: 'no-standing', reason: 'not registered' });

		r.standing = {
			standingKey: 'k3',
			ok: true,
			binding: { ...BINDING, tenantId: ORG },
		};
		expect(await c.recover()).toMatchObject({ outcome: 'checked', unbound: 1, recovered: 0 });
		expect(r.asked).toEqual([]);

		// A mismatched or unreachable answer leaves the record uncertain.
		r.standing = { standingKey: 'k4', ok: true, binding: BINDING };
		r.custody = (request) => {
			const record = c
				.receipts()
				.find((x) => x.idempotencyKey === request.operation.idempotencyKey)!;
			return { status: 'ok', payload: recovered(record, { requestDigest: '9'.repeat(64) }) };
		};
		expect(await c.recover()).toMatchObject({ mismatched: 1 });
		r.custody = () => ({ status: 'unavailable', reason: 'closed', message: 'closed' }) as never;
		expect(await c.recover()).toMatchObject({ unavailable: 1 });
		expect(c.receipts()[0].state).toBe('uncertain');
	});
});
