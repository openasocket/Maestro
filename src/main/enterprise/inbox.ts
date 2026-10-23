/**
 * The notice and private feedback client (MRC-11-02): the endpoint daemon's
 * `noticeList` and `inbox` operations over the registered, attached socket this
 * host already holds (`ManagedHostAdapter.inbox`), with a durable receipt for
 * every inbox action. Plain Node, no Electron: `createEnterpriseService`
 * composes it (MRC-11-05); nothing here reaches the IPC layer or a renderer.
 *
 * This module is the wire half and the receipt ledger: a notice and an inbox
 * receipt read off the endpoint's answers (structurally; the endpoint is the
 * authority on its schemas), what an action may look like before it is sent,
 * the idempotency key it is sent under (a digest of the binding and the
 * action: tenant, enrollment and actor, campaign and message, the kind and a
 * reply's text digest, so a resend after a lost answer is a dedup at the
 * endpoint) and the ledger holding one record per key: `pending` before the
 * request leaves, then `recorded` only from a receipt that matches the action
 * sent, `denied` with the endpoint's reason, or `uncertain` (a lost answer, a
 * replay, a mismatch, or a restart that found it pending). The client over
 * them (`act`: delivered, read, acknowledged and reply as four distinct
 * receipts; `refresh`: the paged listing, held in memory since the endpoint is
 * the custodian) is the bounded continuation MRC-11-02A.
 *
 * Privacy: the ledger holds digests, ids and states; never a notice body, never
 * a reply's text. No body enters a model's context from here (`agentInput: false`
 * is the contract's word); the one path is an approved `operator_prompt` command.
 * The record names no actor id today (CP-01/CP-04), so receipts key on the enrollment.
 */

import { canonicalJson } from '../../shared/canonicalJson';
import { sha256Hex } from '../../shared/maestro-lib/managed/authority';
import {
	isEndpointIdentifier,
	type LocalEndpointDenialReason,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type {
	EndpointInboxAction,
	EndpointInboxReceipt,
	EndpointInboxRequest,
	EndpointInboxState,
	EndpointNotice,
	EndpointNoticeListResult,
	InboxBinding,
} from '../../shared/maestro-lib/managed/host-adapter';
import {
	readStoreDocument,
	STORE_SCHEMA_KEY,
	writeStoreDocument,
} from '../../shared/maestro-lib/store/io';

export const MANAGED_INBOX_RECEIPTS_FILE_NAME = 'maestro-managed-inbox-receipts.json';

/** The endpoint's bounds: offset 0..7, limit 1..8, a body of at most 8192, a reply of 1..8192. */
export const NOTICE_LIST_PAGE = 8;
export const NOTICE_BODY_MAX_LENGTH = 8192;
export const INBOX_REPLY_MAX_LENGTH = 8192;

// ---------------------------------------------------------------------------
// The wire, read structurally
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isTimestamp = (value: unknown): value is string =>
	typeof value === 'string' && Number.isFinite(Date.parse(value));

/** One notice, or null when the item is not one. The ids are the endpoint's organization ids (uuids), which are identifiers too. */
export function readNotice(value: unknown): EndpointNotice | null {
	if (
		!isRecord(value) ||
		!isEndpointIdentifier(value.campaignId) ||
		!isEndpointIdentifier(value.messageId) ||
		typeof value.body !== 'string' ||
		value.body.length > NOTICE_BODY_MAX_LENGTH ||
		!isTimestamp(value.expiresAt) ||
		value.kind !== 'notice' ||
		value.agentInput !== false
	) {
		return null;
	}
	return {
		campaignId: value.campaignId,
		messageId: value.messageId,
		body: value.body,
		expiresAt: value.expiresAt,
		kind: 'notice',
		agentInput: false,
	};
}

/** The endpoint's `noticeListResult`, or null when the answer is not one (one bad item spoils the page). */
export function readNoticeListResult(payload: unknown): EndpointNoticeListResult | null {
	if (
		!isRecord(payload) ||
		payload.outcome !== 'notices' ||
		!Array.isArray(payload.items) ||
		payload.items.length > NOTICE_LIST_PAGE
	) {
		return null;
	}
	const next = payload.nextOffset;
	const nextOffset =
		next === null
			? null
			: typeof next === 'number' && Number.isInteger(next) && next >= 1 && next <= 7
				? next
				: undefined;
	if (nextOffset === undefined) return null;
	const items: EndpointNotice[] = [];
	for (const item of payload.items) {
		const notice = readNotice(item);
		if (!notice) return null;
		items.push(notice);
	}
	return { outcome: 'notices', items, nextOffset };
}

/** The state an action's receipt must say. */
export const INBOX_STATE_OF_ACTION: Readonly<
	Record<EndpointInboxAction['kind'], EndpointInboxState>
> = { delivered: 'delivered', read: 'read', acknowledged: 'acknowledged', reply: 'replied' };

/** The receipt for the request sent, or null when the answer does not match it. */
export function readInboxReceipt(
	payload: unknown,
	request: Pick<EndpointInboxRequest, 'messageId' | 'action'>
): EndpointInboxReceipt | null {
	if (
		!isRecord(payload) ||
		payload.outcome !== 'recorded' ||
		payload.messageId !== request.messageId ||
		!isEndpointIdentifier(payload.receiptId) ||
		payload.state !== INBOX_STATE_OF_ACTION[request.action.kind]
	) {
		return null;
	}
	return {
		outcome: 'recorded',
		messageId: request.messageId,
		receiptId: payload.receiptId,
		state: payload.state as EndpointInboxState,
	};
}

/** Why an action cannot be described to the endpoint, or null. */
export function inboxActionProblem(action: unknown): string | null {
	if (!isRecord(action)) return 'the action is not an object';
	switch (action.kind) {
		case 'delivered':
		case 'read':
		case 'acknowledged':
			return Object.keys(action).length === 1 ? null : 'the action carries more than its kind';
		case 'reply':
			if (typeof action.text !== 'string' || action.text.length === 0) return 'a reply needs text';
			if (action.text.length > INBOX_REPLY_MAX_LENGTH)
				return `a reply exceeds ${INBOX_REPLY_MAX_LENGTH} characters`;
			return Object.keys(action).length === 2 ? null : 'the reply carries more than its text';
		default:
			return 'the action kind is not delivered, read, acknowledged or reply';
	}
}

// ---------------------------------------------------------------------------
// The receipt ledger (durable; never a body, never a reply's text)
// ---------------------------------------------------------------------------

export type InboxReceiptState = 'pending' | 'recorded' | 'denied' | 'uncertain';

export interface InboxReceiptRecord {
	/** The digest of the binding and the action; the endpoint dedups on it. */
	idempotencyKey: string;
	campaignId: string;
	messageId: string;
	action: EndpointInboxAction['kind'];
	/** A reply's text, by digest and length only. */
	reply: { textDigest: string; length: number } | null;
	requestDigest: string;
	tenantId: string;
	enrollmentId: string | null;
	registrationId: string;
	actorId: string | null;
	policyRevision: number | null;
	requestedAt: string;
	settledAt: string | null;
	state: InboxReceiptState;
	/** The endpoint's receipt, once recorded. */
	receipt: { receiptId: string; state: EndpointInboxState } | null;
	denial: LocalEndpointDenialReason | null;
	detail: string | null;
}

interface InboxLedgerDocument {
	[STORE_SCHEMA_KEY]: number;
	receipts: InboxReceiptRecord[];
}

export type InboxLedgerLoad =
	| { ok: true; receipts: number; recoveredUncertain: number }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

/** The idempotency key of an action under a binding: the same act by the same actor on the same message is one receipt. */
export function inboxIdempotencyKey(
	binding: Pick<InboxBinding, 'tenantId' | 'enrollmentId' | 'actorId'>,
	campaignId: string,
	messageId: string,
	action: EndpointInboxAction
): string {
	return sha256Hex(
		canonicalJson({
			tenantId: binding.tenantId,
			enrollmentId: binding.enrollmentId,
			actorId: binding.actorId,
			campaignId,
			messageId,
			kind: action.kind,
			textDigest: action.kind === 'reply' ? sha256Hex(action.text) : null,
		})
	);
}

export interface InboxReceiptLedger {
	readonly file: string | null;
	/** Read the file; a `pending` record from an earlier process becomes `uncertain`. Once, first. */
	load(): Promise<InboxLedgerLoad>;
	/** Insert or replace the record under its key, durably. */
	put(record: InboxReceiptRecord): Promise<InboxReceiptRecord>;
	/** Settle the record under `idempotencyKey`; null when there is none. */
	settle(
		idempotencyKey: string,
		state: Exclude<InboxReceiptState, 'pending'>,
		detail: string | null,
		extra?: Partial<Pick<InboxReceiptRecord, 'receipt' | 'denial'>>
	): Promise<InboxReceiptRecord | null>;
	get(idempotencyKey: string): InboxReceiptRecord | null;
	/** Every record of one message, oldest first. */
	byMessage(campaignId: string, messageId: string): readonly InboxReceiptRecord[];
	list(): readonly InboxReceiptRecord[];
}

export interface InboxReceiptLedgerDeps {
	/** Absent: in memory only (a test, a one-shot host). */
	file?: string;
	now(): number;
	/** Oldest settled records go first; a pending one is never dropped. Default 2000. */
	maxReceipts?: number;
}

const DEFAULT_MAX_RECEIPTS = 2_000;

export function createInboxReceiptLedger(deps: InboxReceiptLedgerDeps): InboxReceiptLedger {
	const maxReceipts = deps.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
	let doc: InboxLedgerDocument = { [STORE_SCHEMA_KEY]: 1, receipts: [] };
	let loaded = deps.file === undefined;
	const byKey = new Map<string, InboxReceiptRecord>();
	const iso = (): string => new Date(deps.now()).toISOString();
	let chain: Promise<unknown> = Promise.resolve();

	function index(): void {
		byKey.clear();
		for (const record of doc.receipts) byKey.set(record.idempotencyKey, record);
	}

	/** Writes are serialized so two acts cannot interleave a read-modify-write on the file. */
	function serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = chain.then(work, work);
		chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	async function persist(): Promise<void> {
		if (!loaded) throw new Error('The inbox receipt ledger was not loaded.');
		if (doc.receipts.length > maxReceipts) {
			let excess = doc.receipts.length - maxReceipts;
			doc.receipts = doc.receipts.filter((record) => {
				if (excess > 0 && record.state !== 'pending') {
					excess -= 1;
					return false;
				}
				return true;
			});
			index();
		}
		if (deps.file) await writeStoreDocument(deps.file, doc);
	}

	return {
		file: deps.file ?? null,

		load: () =>
			serialized(async () => {
				if (!deps.file) return { ok: true, receipts: 0, recoveredUncertain: 0 };
				const read = await readStoreDocument<InboxLedgerDocument>(deps.file, (value) =>
					Array.isArray(value.receipts) ? null : 'receipts is not an array'
				);
				if (read.status === 'corrupt' || read.status === 'unreadable') {
					return { ok: false, reason: read.status, file: deps.file, message: read.reason };
				}
				doc = read.status === 'ok' ? read.data : { [STORE_SCHEMA_KEY]: 1, receipts: [] };
				index();
				loaded = true;
				let recoveredUncertain = 0;
				for (const record of doc.receipts) {
					if (record.state !== 'pending') continue;
					record.state = 'uncertain';
					record.settledAt = iso();
					record.detail = 'The host restarted while this action was in flight.';
					recoveredUncertain += 1;
				}
				if (recoveredUncertain > 0 || read.status === 'missing') await persist();
				return { ok: true, receipts: doc.receipts.length, recoveredUncertain };
			}),

		put: (record) =>
			serialized(async () => {
				if (!loaded) throw new Error('The inbox receipt ledger was not loaded.');
				const stored = { ...record };
				doc.receipts = [
					...doc.receipts.filter((r) => r.idempotencyKey !== record.idempotencyKey),
					stored,
				];
				index();
				await persist();
				return stored;
			}),

		settle: (idempotencyKey, state, detail, extra = {}) =>
			serialized(async () => {
				const record = byKey.get(idempotencyKey);
				if (!record) return null;
				Object.assign(record, { state, detail, settledAt: iso() }, extra);
				await persist();
				return record;
			}),

		get: (idempotencyKey) => byKey.get(idempotencyKey) ?? null,
		byMessage: (campaignId, messageId) =>
			doc.receipts.filter((r) => r.campaignId === campaignId && r.messageId === messageId),
		list: () => doc.receipts,
	};
}
