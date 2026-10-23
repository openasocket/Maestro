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
 * them (`createInboxClient`, MRC-11-02A): `act` records delivered, read,
 * acknowledged and reply as four distinct receipts, durable before the request
 * leaves and settled only from the endpoint's answer; `refresh` pages the
 * listing and holds the unexpired notices in memory, the endpoint being the
 * custodian; `notices()` is the one surface a body reaches.
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
	ManagedHostAdapter,
} from '../../shared/maestro-lib/managed/host-adapter';
import {
	readStoreDocument,
	STORE_SCHEMA_KEY,
	writeStoreDocument,
} from '../../shared/maestro-lib/store/io';

export const MANAGED_INBOX_RECEIPTS_FILE_NAME = 'maestro-managed-inbox-receipts.json';

/** The endpoint's bounds: offset 0..7, limit 1..8, a body of at most 8192, a reply of 1..8192. */
export const NOTICE_LIST_PAGE = 8;
export const NOTICE_LIST_MAX_OFFSET = 7;
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

// ---------------------------------------------------------------------------
// The client (MRC-11-02A)
// ---------------------------------------------------------------------------

/** The record an action opens under its binding, `pending` until the endpoint's answer settles it. */
export function openInboxReceipt(
	binding: InboxBinding,
	request: EndpointInboxRequest,
	requestedAt: string
): InboxReceiptRecord {
	return {
		idempotencyKey: request.idempotencyKey,
		campaignId: request.campaignId,
		messageId: request.messageId,
		action: request.action.kind,
		reply:
			request.action.kind === 'reply'
				? { textDigest: sha256Hex(request.action.text), length: request.action.text.length }
				: null,
		requestDigest: sha256Hex(canonicalJson(request)),
		tenantId: binding.tenantId,
		enrollmentId: binding.enrollmentId,
		registrationId: binding.registrationId,
		actorId: binding.actorId,
		policyRevision: binding.policyRevision,
		requestedAt,
		settledAt: null,
		state: 'pending',
		receipt: null,
		denial: null,
		detail: null,
	};
}

/** A held notice as the person's surface sees it: the body, and what this host has recorded about it. */
export interface NoticeView extends EndpointNotice {
	firstListedAt: string;
	/** The furthest state the endpoint recorded for it on this host, or null. */
	recorded: EndpointInboxState | null;
	/** The receipt states of this host's actions on it, one per action kind. */
	receipts: Partial<Record<EndpointInboxAction['kind'], InboxReceiptState>>;
}

export type InboxRefreshOutcome = 'listed' | 'no-standing' | 'denied' | 'unavailable' | 'malformed';

export interface InboxRefresh {
	at: string;
	outcome: InboxRefreshOutcome;
	reason: string | null;
	denial: LocalEndpointDenialReason | null;
	pages: number;
	listed: number;
	expired: number;
	newlyHeld: number;
	/** `delivered` receipts recorded in this refresh, by outcome. */
	delivered: { recorded: number; uncertain: number; denied: number; unavailable: number };
}

export type InboxActionOutcome =
	| { status: 'recorded'; record: InboxReceiptRecord; duplicate: boolean }
	| {
			status: 'denied';
			reason: LocalEndpointDenialReason | 'invalid-action' | 'unknown-message';
			detail: string;
			record: InboxReceiptRecord | null;
	  }
	| { status: 'uncertain'; record: InboxReceiptRecord; detail: string }
	| { status: 'unavailable'; detail: string };

export interface InboxClientStatus {
	file: string | null;
	loaded: boolean;
	load: InboxLedgerLoad | null;
	standing: { ok: true } | { ok: false; reason: string };
	capabilities: { noticeList: boolean; inbox: boolean };
	notices: { held: number; unread: number; unacknowledged: number };
	receipts: { total: number; byState: Readonly<Record<InboxReceiptState, number>> };
	lastRefresh: InboxRefresh | null;
}

export interface InboxClient {
	/** Read the ledger before the first act; a `pending` record from an earlier process becomes `uncertain`. */
	load(): Promise<InboxLedgerLoad>;
	/** List the endpoint's notices for this actor, hold the unexpired ones, record `delivered` for the new ones. */
	refresh(): Promise<InboxRefresh>;
	/** The notices held right now, bodies included: the person's surface, and nothing else's. */
	notices(): readonly NoticeView[];
	/** Record one action on a held notice; durable before the request leaves. */
	act(input: {
		campaignId: string;
		messageId: string;
		action: EndpointInboxAction;
	}): Promise<InboxActionOutcome>;
	/** Every receipt this host holds (digests and states; never a body or a reply's text). */
	receipts(): readonly InboxReceiptRecord[];
	status(): InboxClientStatus;
}

export interface InboxClientDeps {
	host: Pick<ManagedHostAdapter, 'inbox' | 'inboxStanding'>;
	/** The receipt ledger (`createInboxReceiptLedger`); the composer names its file in the data directory. */
	ledger: InboxReceiptLedger;
	now?: () => number;
}

interface HeldNotice {
	notice: EndpointNotice;
	firstListedAt: string;
}

const RECEIPT_STATES: readonly InboxReceiptState[] = ['pending', 'recorded', 'denied', 'uncertain'];
const STATE_RANK: Readonly<Record<EndpointInboxState, number>> = {
	delivered: 1,
	read: 2,
	acknowledged: 3,
	replied: 4,
};

/**
 * The client over the port and the ledger. `act` is serialized: one action at
 * a time runs its check, its durable `pending` record, its request and its
 * settlement, so two actions under the same key cannot both pass the history
 * check. `refresh` coalesces: a refresh asked while one is in flight joins it.
 *
 * A receipt is this host's statement that the person was shown the notice
 * (`delivered`) or acted on it (`read`, `acknowledged`, `reply`). A message this
 * host has never listed is one nobody here has seen, so an action on it is not
 * the person's act: `act` refuses it by name (`unknown-message`) before a
 * record is opened and before the endpoint is reached. That gate is honesty of
 * the receipt, not enforcement: the endpoint authorizes every inbox effect it
 * receives against the actor it resolves from the OS peer. It follows that a
 * host must `refresh()` before it can act after a restart (`held` is memory).
 */
export function createInboxClient(deps: InboxClientDeps): InboxClient {
	const { host, ledger } = deps;
	const now = deps.now ?? (() => Date.now());
	const iso = (): string => new Date(now()).toISOString();
	let load: InboxLedgerLoad | null = ledger.file
		? null
		: { ok: true, receipts: 0, recoveredUncertain: 0 };
	const held = new Map<string, HeldNotice>();
	let lastRefresh: InboxRefresh | null = null;
	let refreshing: Promise<InboxRefresh> | null = null;
	let chain: Promise<unknown> = Promise.resolve();

	const key = (campaignId: string, messageId: string): string => `${campaignId}/${messageId}`;

	/** One action after another: the history check and the request it guards never interleave. */
	function serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = chain.then(work, work);
		chain = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	async function record(input: {
		campaignId: string;
		messageId: string;
		action: EndpointInboxAction;
	}): Promise<InboxActionOutcome> {
		if (load?.ok !== true)
			return { status: 'unavailable', detail: 'The inbox receipt ledger is not loaded.' };
		const problem = inboxActionProblem(input.action);
		if (problem)
			return { status: 'denied', reason: 'invalid-action', detail: problem, record: null };
		const standing = host.inboxStanding();
		const port = host.inbox;
		if (!standing.ok || !port) {
			return {
				status: 'unavailable',
				detail: standing.ok ? 'No endpoint socket is open.' : standing.reason,
			};
		}
		const { binding } = standing;
		if (!binding.capabilities.inbox) {
			return {
				status: 'unavailable',
				detail: 'The endpoint negotiated no inbox capability on this connection.',
			};
		}
		if (!held.has(key(input.campaignId, input.messageId))) {
			return {
				status: 'denied',
				reason: 'unknown-message',
				detail: `message ${input.messageId} of campaign ${input.campaignId} is not held on this host`,
				record: null,
			};
		}
		const idempotencyKey = inboxIdempotencyKey(
			binding,
			input.campaignId,
			input.messageId,
			input.action
		);
		const prior = ledger.get(idempotencyKey);
		if (prior?.state === 'recorded') return { status: 'recorded', record: prior, duplicate: true };
		if (prior?.state === 'pending') {
			return { status: 'unavailable', detail: 'The same action is in flight on this host.' };
		}
		const request: EndpointInboxRequest = {
			campaignId: input.campaignId,
			messageId: input.messageId,
			idempotencyKey,
			action: input.action,
		};
		// Durable before the request leaves: a crash from here on is an uncertain receipt, not a lost one.
		const entry = await ledger.put({
			...openInboxReceipt(binding, request, iso()),
			detail: prior ? `resent under the same key; the earlier attempt was ${prior.state}` : null,
		});
		const settle = async (
			state: Exclude<InboxReceiptState, 'pending'>,
			detail: string | null,
			extra: Partial<Pick<InboxReceiptRecord, 'receipt' | 'denial'>> = {}
		): Promise<InboxReceiptRecord> =>
			(await ledger.settle(idempotencyKey, state, detail, extra)) ?? {
				...entry,
				...extra,
				state,
				detail,
				settledAt: iso(),
			};
		const answer = await port.act(request);
		switch (answer.status) {
			case 'ok': {
				const receipt = readInboxReceipt(answer.payload, request);
				if (!receipt) {
					const detail = 'the endpoint answered with a receipt that does not match the action sent';
					return { status: 'uncertain', record: await settle('uncertain', detail), detail };
				}
				return {
					status: 'recorded',
					record: await settle('recorded', null, {
						receipt: { receiptId: receipt.receiptId, state: receipt.state },
					}),
					duplicate: false,
				};
			}
			case 'unknown':
				return {
					status: 'uncertain',
					record: await settle('uncertain', answer.message),
					detail: answer.message,
				};
			case 'unavailable': {
				// Nothing left this process: the record says so and the next act resends under the same key.
				await settle('uncertain', `not sent: ${answer.message}`);
				return { status: 'unavailable', detail: answer.message };
			}
			case 'denied': {
				if (answer.reason === 'replay') {
					const detail = 'the endpoint answered replay: the first answer was lost';
					return {
						status: 'uncertain',
						record: await settle('uncertain', detail, { denial: 'replay' }),
						detail,
					};
				}
				const detail = `the endpoint refused the action: ${answer.reason}`;
				return {
					status: 'denied',
					reason: answer.reason,
					detail,
					record: await settle('denied', detail, { denial: answer.reason }),
				};
			}
		}
	}

	async function refresh(): Promise<InboxRefresh> {
		const summary: InboxRefresh = {
			at: iso(),
			outcome: 'listed',
			reason: null,
			denial: null,
			pages: 0,
			listed: 0,
			expired: 0,
			newlyHeld: 0,
			delivered: { recorded: 0, uncertain: 0, denied: 0, unavailable: 0 },
		};
		const standing = host.inboxStanding();
		const port = host.inbox;
		if (!standing.ok || !port) {
			return {
				...summary,
				outcome: 'no-standing',
				reason: standing.ok ? 'No endpoint socket is open.' : standing.reason,
			};
		}
		if (!standing.binding.capabilities.noticeList) {
			return {
				...summary,
				outcome: 'no-standing',
				reason: 'The endpoint negotiated no noticeList capability on this connection.',
			};
		}
		const listed: EndpointNotice[] = [];
		let offset: number | null = 0;
		while (offset !== null && offset <= NOTICE_LIST_MAX_OFFSET) {
			const answer = await port.list({ offset, limit: NOTICE_LIST_PAGE });
			summary.pages += 1;
			if (answer.status === 'denied') {
				return {
					...summary,
					outcome: 'denied',
					denial: answer.reason,
					reason: `the endpoint refused the listing: ${answer.reason}`,
				};
			}
			if (answer.status !== 'ok')
				return { ...summary, outcome: 'unavailable', reason: answer.message };
			const page = readNoticeListResult(answer.payload);
			if (!page) {
				return {
					...summary,
					outcome: 'malformed',
					reason: 'the endpoint answered with no notice list',
				};
			}
			listed.push(...page.items);
			// Only forward: a page that points back or at itself ends the walk.
			offset = page.nextOffset !== null && page.nextOffset > offset ? page.nextOffset : null;
		}
		// The endpoint's listing is the custody: what it no longer lists is no longer held.
		const at = iso();
		const next = new Map<string, HeldNotice>();
		const fresh: EndpointNotice[] = [];
		for (const notice of listed) {
			summary.listed += 1;
			if (Date.parse(notice.expiresAt) <= now()) {
				summary.expired += 1;
				continue;
			}
			const id = key(notice.campaignId, notice.messageId);
			const prior = held.get(id);
			if (!prior && !next.has(id)) fresh.push(notice);
			next.set(id, { notice, firstListedAt: prior?.firstListedAt ?? at });
		}
		held.clear();
		for (const [id, entry] of next) held.set(id, entry);
		summary.newlyHeld = fresh.length;
		for (const notice of fresh) {
			const outcome = await serialized(() =>
				record({
					campaignId: notice.campaignId,
					messageId: notice.messageId,
					action: { kind: 'delivered' },
				})
			);
			summary.delivered[outcome.status] += 1;
		}
		return summary;
	}

	function view(entry: HeldNotice): NoticeView {
		const receipts: NoticeView['receipts'] = {};
		let recorded: EndpointInboxState | null = null;
		for (const record of ledger.byMessage(entry.notice.campaignId, entry.notice.messageId)) {
			receipts[record.action] = record.state;
			const state = record.receipt?.state ?? null;
			if (state && (recorded === null || STATE_RANK[state] > STATE_RANK[recorded]))
				recorded = state;
		}
		return { ...entry.notice, firstListedAt: entry.firstListedAt, recorded, receipts };
	}

	return {
		async load() {
			load = await ledger.load();
			return load;
		},
		refresh() {
			if (refreshing) return refreshing;
			const run = refresh();
			refreshing = run;
			// Cleared in the reactions themselves: they run before a caller awaiting `run` resumes.
			const done = (): void => {
				if (refreshing === run) refreshing = null;
			};
			run.then((result) => {
				lastRefresh = result;
				done();
			}, done);
			return run;
		},
		notices: () => [...held.values()].map(view),
		act: (input) => serialized(() => record(input)),
		receipts: () => ledger.list().map((record) => ({ ...record })),
		status() {
			const standing = host.inboxStanding();
			const views = [...held.values()].map(view);
			const byState = Object.fromEntries(RECEIPT_STATES.map((state) => [state, 0])) as Record<
				InboxReceiptState,
				number
			>;
			for (const record of ledger.list()) byState[record.state] += 1;
			return {
				file: ledger.file,
				loaded: load?.ok === true,
				load,
				standing: standing.ok ? { ok: true } : { ok: false, reason: standing.reason },
				capabilities: standing.ok
					? standing.binding.capabilities
					: { noticeList: false, inbox: false },
				notices: {
					held: views.length,
					unread: views.filter((v) =>
						v.recorded ? STATE_RANK[v.recorded] < STATE_RANK.read : true
					).length,
					unacknowledged: views.filter((v) =>
						v.recorded ? STATE_RANK[v.recorded] < STATE_RANK.acknowledged : true
					).length,
				},
				receipts: { total: ledger.list().length, byState },
				lastRefresh,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// The view a person's surface reads (MRC-11-04)
// ---------------------------------------------------------------------------

/**
 * What one read of the inbox hands a renderer or a CLI verb: the client's
 * status and the held notices, bodies included. The body reaches the person
 * and nothing else: no handler and no surface hands it to a model, a queue or
 * a prompt (`agentInput: false` is the contract's word on every notice).
 */
export interface ManagedInboxView {
	status: InboxClientStatus;
	notices: readonly NoticeView[];
}

export function inboxView(client: InboxClient): ManagedInboxView {
	return { status: client.status(), notices: client.notices() };
}
