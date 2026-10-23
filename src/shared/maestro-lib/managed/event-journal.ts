/**
 * The event journal (MRC-10-02): the durable boundary record of the lifecycle
 * events this host projected, what left it for the endpoint, and what the
 * endpoint confirmed it received, under one sequence that survives a restart,
 * ids that dedup a replay, bounded cursors and counted gaps.
 *
 * `<userData>/maestro-managed-events.json`, written through `writeStoreDocument`
 * like the run journal. `attach(projector)` keeps every event the lifecycle
 * projector (`events.ts`) raises, so a restart, a reconnect or a late reader
 * resumes from a cursor instead of from the projector's per-process window.
 *
 * What it is not: the upload spool, delivery, or authority. The endpoint
 * daemon's `telemetry` operation owns the one durable spool toward the fleet;
 * this journal is the Maestro side of that boundary, the record of what was
 * handed over and what came back, so nothing is resent blind and nothing is
 * forgotten silently. Nothing here sends anything: the telemetry client
 * (MRC-10-03) calls `take()` and settles each batch with the endpoint's own
 * answer. `received` is written only from an endpoint receipt (`acknowledge`);
 * an answer that was lost leaves the entry `uncertain` and eligible for a
 * resend (safe: the event id is a digest of the fact and the endpoint dedups
 * on it); a request that never left stays `pending`.
 *
 * Gaps are facts of their own: a projector refusal, a hole in the projector's
 * sequence, a restart (whatever happened while no process was observing) and
 * a trim of an entry the endpoint never confirmed (the journal is bounded; the
 * loss is counted and placed, never swallowed). A page answers `gap` when any
 * of those lies between its cursor and its last item, `unknown` for a cursor
 * this journal did not issue.
 */
import * as path from 'node:path';

import type { MaestroPaths } from '../paths/resolve';
import { readStoreDocument, writeStoreDocument, STORE_SCHEMA_KEY } from '../store/io';
import type { LifecycleProjector, ManagedLifecycleEvent } from './events';
import type { ManagedEventPage } from './types';

export const MANAGED_EVENT_JOURNAL_FILE_NAME = 'maestro-managed-events.json';

export function managedEventJournalPath(paths: Pick<MaestroPaths, 'userDataDir'>): string {
	return path.join(paths.userDataDir, MANAGED_EVENT_JOURNAL_FILE_NAME);
}

/** `pending`: unconfirmed and nothing in flight is known; `uncertain`: left, answer lost; `received`: the endpoint confirmed it. */
export type EventDelivery = 'pending' | 'uncertain' | 'received';

export interface JournalEventEntry {
	/** The journal's own sequence: monotonic across restarts, what a cursor names. */
	sequence: number;
	eventId: string;
	event: ManagedLifecycleEvent;
	recordedAt: string;
	delivery: EventDelivery;
	/** Batches this entry was handed to; a resend after `uncertain` counts. */
	attempts: number;
	/** What the endpoint answered; the only thing that marks an entry `received`. */
	receipt: { at: string; correlationId: string | null } | null;
	detail: string | null;
}

export type JournalGapKind =
	| 'projector-refused'
	| 'sequence-hole'
	| 'restart'
	| 'trimmed-unreceived';

/** Loss placed after a journal sequence, with how many were lost when the journal can count them. */
export interface JournalGap {
	kind: JournalGapKind;
	at: string;
	afterSequence: number;
	count: number | null;
	detail: string | null;
}

export interface EventJournalCounters {
	recorded: number;
	duplicates: number;
	refused: number;
	received: number;
	trimmed: number;
	trimmedUnreceived: number;
	gapsForgotten: number;
}

export interface EventJournalDocument {
	[STORE_SCHEMA_KEY]: number;
	/** Minted once per file; a cursor names it, so a cursor from another file is `unknown`. */
	journalId: string;
	nextSequence: number;
	entries: JournalEventEntry[];
	gaps: JournalGap[];
	counters: EventJournalCounters;
}

export interface EventJournalPage extends ManagedEventPage {
	items: readonly ManagedLifecycleEvent[];
}

export interface EventJournalStatus {
	journalId: string;
	nextSequence: number;
	entries: number;
	delivery: Record<EventDelivery, number>;
	/** Handed to a transport and not yet settled; in memory only. */
	held: number;
	gaps: readonly JournalGap[];
	counters: EventJournalCounters;
	/** The last write that failed, until one succeeds; `flush()` rejects with it. */
	writeFailure: { at: string; message: string } | null;
}

export type EventJournalLoad =
	| { ok: true; entries: number; pending: number; gaps: number }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

/** How a handed-over batch ended, in the transport's words: `unavailable` means nothing left this process. */
export type EventSettlement = 'uncertain' | 'unavailable';

export interface EventJournal {
	readonly file: string;
	/** Read the file. Once, before anything else. */
	load(): Promise<EventJournalLoad>;
	/** Keep every event the projector raises from now on, and its refusals as gaps. */
	attach(projector: Pick<LifecycleProjector, 'subscribe' | 'gaps'>): () => void;
	record(event: ManagedLifecycleEvent): 'recorded' | 'duplicate' | 'refused';
	/** The oldest unconfirmed entries not already held, marked held until settled. */
	take(limit: number): JournalEventEntry[];
	/** Written only from an endpoint receipt. Answers how many entries it confirmed. */
	acknowledge(ids: readonly string[], receipt: { correlationId: string | null }): Promise<number>;
	/** Release a held batch the endpoint did not confirm. `uncertain` is durable; `unavailable` says nothing about the entry. */
	settle(ids: readonly string[], outcome: EventSettlement, detail: string): Promise<number>;
	/** Events after `cursor`, oldest first; `gap` when anything between the cursor and the last item was lost; `nextCursor` is the position after the last item (null only while empty). */
	page(query: { cursor: string | null; limit: number }): EventJournalPage;
	status(): EventJournalStatus;
	/** Resolve once every recorded change has reached the file. */
	flush(): Promise<void>;
}

export interface EventJournalDeps {
	file: string;
	now(): number;
	newId(): string;
	/** How many entries to keep. Oldest first; a trimmed unconfirmed entry is a counted gap. */
	maxEntries?: number;
	maxGaps?: number;
}

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_MAX_GAPS = 256;
const MAX_PAGE = 500;

export function encodeEventCursor(journalId: string, sequence: number): string {
	return `evc:${journalId}:${sequence}`;
}

export function decodeEventCursor(cursor: string): { journalId: string; sequence: number } | null {
	const parts = cursor.split(':');
	if (parts.length !== 3 || parts[0] !== 'evc' || !parts[1] || !/^\d+$/.test(parts[2])) {
		return null;
	}
	const sequence = Number(parts[2]);
	return Number.isSafeInteger(sequence) ? { journalId: parts[1], sequence } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isSequence = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 1;

function emptyDocument(journalId: string): EventJournalDocument {
	return {
		[STORE_SCHEMA_KEY]: 1,
		journalId,
		nextSequence: 1,
		entries: [],
		gaps: [],
		counters: {
			recorded: 0,
			duplicates: 0,
			refused: 0,
			received: 0,
			trimmed: 0,
			trimmedUnreceived: 0,
			gapsForgotten: 0,
		},
	};
}

function documentProblem(value: Record<string, unknown>): string | null {
	if (typeof value.journalId !== 'string' || !value.journalId) return 'journalId is not an id';
	if (!isSequence(value.nextSequence)) return 'nextSequence is not a sequence';
	if (!Array.isArray(value.entries) || !Array.isArray(value.gaps)) return 'entries or gaps missing';
	return null;
}

/** The shape a recorded event must have; the projector's own validation covers the fact. */
function eventProblem(event: unknown): string | null {
	if (!isRecord(event)) return 'event is not an object';
	if (typeof event.eventId !== 'string' || !event.eventId) return 'eventId is not an id';
	if (!isSequence(event.sequence)) return 'sequence is not a sequence';
	if (!isRecord(event.installation) || typeof event.installation.processEpoch !== 'string') {
		return 'installation has no process epoch';
	}
	return typeof event.occurredAt === 'string' && typeof event.kind === 'string'
		? null
		: 'event has no time or kind';
}

export function createEventJournal(deps: EventJournalDeps): EventJournal {
	const maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
	const maxGaps = Math.max(1, deps.maxGaps ?? DEFAULT_MAX_GAPS);
	let doc = emptyDocument('unloaded');
	let loaded = false;
	const byId = new Map<string, JournalEventEntry>();
	const held = new Set<string>();
	/** The projector's own numbering as last seen; a jump is a hole, a new epoch a restart. */
	let source: { processEpoch: string; sequence: number } | null = null;
	let projectorRefused = 0;
	let dirty = false;
	let writing: Promise<void> | null = null;
	let writeFailure: EventJournalStatus['writeFailure'] = null;

	const iso = (): string => new Date(deps.now()).toISOString();

	function requireLoaded(): void {
		if (!loaded) throw new Error('The event journal was not loaded.');
	}

	/** Coalesces a burst (a decision and its run-state, a batch receipt) into one write. */
	function persist(): Promise<void> {
		dirty = true;
		if (writing) return writing;
		writing = Promise.resolve().then(async () => {
			try {
				while (dirty) {
					dirty = false;
					await writeStoreDocument(deps.file, doc);
					writeFailure = null;
				}
			} finally {
				writing = null;
			}
		});
		// A listener cannot await; the failure is kept for `status()` and the next `flush()`.
		writing.catch((error: unknown) => {
			writeFailure = { at: iso(), message: error instanceof Error ? error.message : String(error) };
		});
		return writing;
	}

	function forgetOldGaps(): void {
		while (doc.gaps.length > maxGaps) {
			doc.gaps.shift();
			doc.counters.gapsForgotten += 1;
		}
	}

	function addGap(kind: JournalGapKind, count: number | null, detail: string): void {
		doc.gaps.push({ kind, at: iso(), afterSequence: doc.nextSequence - 1, count, detail });
		forgetOldGaps();
	}

	function trim(): void {
		while (doc.entries.length > maxEntries) {
			const oldest = doc.entries.shift() as JournalEventEntry;
			byId.delete(oldest.eventId);
			held.delete(oldest.eventId);
			doc.counters.trimmed += 1;
			if (oldest.delivery === 'received') continue;
			doc.counters.trimmedUnreceived += 1;
			const last = doc.gaps[doc.gaps.length - 1];
			if (
				last?.kind === 'trimmed-unreceived' &&
				last.count !== null &&
				last.afterSequence + last.count === oldest.sequence - 1
			) {
				last.count += 1;
				last.at = iso();
			} else {
				doc.gaps.push({
					kind: 'trimmed-unreceived',
					at: iso(),
					afterSequence: oldest.sequence - 1,
					count: 1,
					detail: 'trimmed before the endpoint confirmed it',
				});
			}
		}
		forgetOldGaps();
	}

	function noteSource(event: ManagedLifecycleEvent): void {
		const epoch = event.installation.processEpoch;
		const previous = source?.processEpoch ?? doc.entries.at(-1)?.event.installation.processEpoch;
		if (previous !== undefined && previous !== epoch) {
			addGap('restart', null, `process epoch ${previous} ended unobserved before ${epoch} began`);
		} else if (source && event.sequence > source.sequence + 1) {
			const missing = event.sequence - source.sequence - 1;
			addGap('sequence-hole', missing, `projector sequence skipped ${missing}`);
		}
		source = { processEpoch: epoch, sequence: event.sequence };
	}

	function record(event: ManagedLifecycleEvent): 'recorded' | 'duplicate' | 'refused' {
		requireLoaded();
		if (eventProblem(event) !== null) {
			doc.counters.refused += 1;
			void persist();
			return 'refused';
		}
		if (byId.has(event.eventId)) {
			doc.counters.duplicates += 1;
			return 'duplicate';
		}
		noteSource(event);
		const entry: JournalEventEntry = {
			sequence: doc.nextSequence,
			eventId: event.eventId,
			event,
			recordedAt: iso(),
			delivery: 'pending',
			attempts: 0,
			receipt: null,
			detail: null,
		};
		doc.nextSequence += 1;
		doc.entries.push(entry);
		byId.set(entry.eventId, entry);
		doc.counters.recorded += 1;
		trim();
		void persist();
		return 'recorded';
	}

	function release(ids: readonly string[]): JournalEventEntry[] {
		const entries: JournalEventEntry[] = [];
		for (const id of ids) {
			held.delete(id);
			const entry = byId.get(id);
			if (entry && entry.delivery !== 'received') entries.push(entry);
		}
		return entries;
	}

	return {
		file: deps.file,

		async load() {
			const read = await readStoreDocument<EventJournalDocument>(deps.file, documentProblem);
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return { ok: false, reason: read.status, file: deps.file, message: read.reason };
			}
			doc = read.status === 'ok' ? read.data : emptyDocument(deps.newId());
			doc.counters = { ...emptyDocument('').counters, ...doc.counters };
			byId.clear();
			for (const entry of doc.entries) byId.set(entry.eventId, entry);
			loaded = true;
			if (read.status === 'missing') await persist();
			return {
				ok: true,
				entries: doc.entries.length,
				pending: doc.entries.filter((e) => e.delivery !== 'received').length,
				gaps: doc.gaps.length,
			};
		},

		attach(projector) {
			requireLoaded();
			projectorRefused = projector.gaps().refused;
			return projector.subscribe((event) => {
				const refused = projector.gaps().refused;
				if (refused > projectorRefused) {
					addGap('projector-refused', refused - projectorRefused, 'facts the projector refused');
					projectorRefused = refused;
				}
				record(event);
			});
		},

		record,

		take(limit) {
			requireLoaded();
			const size = Math.max(1, Math.min(limit, MAX_PAGE));
			const batch: JournalEventEntry[] = [];
			for (const entry of doc.entries) {
				if (batch.length >= size) break;
				if (entry.delivery === 'received' || held.has(entry.eventId)) continue;
				held.add(entry.eventId);
				entry.attempts += 1;
				batch.push(entry);
			}
			return batch;
		},

		async acknowledge(ids, receipt) {
			requireLoaded();
			const at = iso();
			const confirmed = release(ids);
			for (const entry of confirmed) {
				entry.delivery = 'received';
				entry.receipt = { at, correlationId: receipt.correlationId };
				entry.detail = null;
				doc.counters.received += 1;
			}
			if (confirmed.length > 0) await persist();
			return confirmed.length;
		},

		async settle(ids, outcome, detail) {
			requireLoaded();
			let changed = 0;
			for (const entry of release(ids)) {
				if (outcome === 'uncertain') {
					entry.delivery = 'uncertain';
					changed += 1;
				}
				entry.detail = detail;
			}
			if (changed > 0) await persist();
			return changed;
		},

		page({ cursor, limit }) {
			requireLoaded();
			const size = Math.max(1, Math.min(limit, MAX_PAGE));
			const decoded = cursor === null ? null : decodeEventCursor(cursor);
			const known = cursor === null || decoded?.journalId === doc.journalId;
			const after = known && decoded ? decoded.sequence : 0;
			const items = doc.entries.filter((e) => e.sequence > after).slice(0, size);
			const last = items.at(-1);
			const end = last?.sequence ?? doc.nextSequence;
			const oldest = doc.entries[0]?.sequence ?? doc.nextSequence;
			const lost =
				after + 1 < oldest ||
				doc.gaps.some((gap) => gap.afterSequence >= after && gap.afterSequence < end);
			let nextCursor: string | null = known ? cursor : null;
			if (last) nextCursor = encodeEventCursor(doc.journalId, last.sequence);
			else if (nextCursor === null && doc.entries.length > 0) {
				nextCursor = encodeEventCursor(doc.journalId, after);
			}
			return {
				items: items.map((e) => e.event),
				nextCursor,
				completeness: !known ? 'unknown' : lost ? 'gap' : 'complete',
			};
		},

		status() {
			requireLoaded();
			const delivery: Record<EventDelivery, number> = { pending: 0, uncertain: 0, received: 0 };
			for (const entry of doc.entries) delivery[entry.delivery] += 1;
			return {
				journalId: doc.journalId,
				nextSequence: doc.nextSequence,
				entries: doc.entries.length,
				delivery,
				held: held.size,
				gaps: [...doc.gaps],
				counters: { ...doc.counters },
				writeFailure,
			};
		},

		async flush() {
			if (writing) await writing;
			if (dirty) await persist();
		},
	};
}
