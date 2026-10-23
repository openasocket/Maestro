/**
 * The durable event journal (MRC-10-02): the projected lifecycle events kept
 * under one sequence that survives a restart, deduplicated by id, handed to a
 * transport in batches and confirmed only by an endpoint receipt, paged by
 * opaque cursors with honest completeness, every gap recorded. Real files in
 * a temp directory; no socket, no process.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createEventJournal,
	decodeEventCursor,
	encodeEventCursor,
	type EventJournal,
} from '../../../../shared/maestro-lib/managed/event-journal';
import {
	createLifecycleProjector,
	type LifecycleFact,
	type LifecycleProjector,
	type ManagedLifecycleEvent,
} from '../../../../shared/maestro-lib/managed/events';

const dirs: string[] = [];
const open: EventJournal[] = [];
afterEach(async () => {
	for (const j of open.splice(0)) await j.flush();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-event-journal-'));
	dirs.push(dir);
	return path.join(dir, 'maestro-managed-events.json');
}

function projector(processEpoch = 'epoch-1'): LifecycleProjector {
	return createLifecycleProjector({
		installation: { installationId: 'inst-1', runtimeId: 'rt-1', processEpoch },
		origin: 'desktop',
		actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
		policyRevision: () => 7,
	});
}

let facts = 0;
const fact = (overrides: Partial<LifecycleFact> = {}): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at: 1_700_000_000_000 + ++facts,
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'claude-code',
	model: 'opus',
	providerSessionId: null,
	runId: `run-${facts}`,
	record: 'ledger',
	ledgerStatus: 'running',
	exitCode: null,
	durationMs: null,
	detail: null,
	...overrides,
});

async function journal(file: string, options: { maxEntries?: number; maxGaps?: number } = {}) {
	let ids = 0;
	let now = 1_000;
	const made = createEventJournal({
		file,
		now: () => now,
		newId: () => `journal-${++ids}`,
		...options,
	});
	open.push(made);
	const loaded = await made.load();
	if (!loaded.ok) throw new Error(loaded.message);
	return { journal: made, tick: (ms: number) => (now += ms) };
}

function feed(p: LifecycleProjector, count: number): ManagedLifecycleEvent[] {
	const events: ManagedLifecycleEvent[] = [];
	for (let i = 0; i < count; i += 1) events.push(...p.record(fact()));
	return events;
}

function readDocument(file: string): { entries: { sequence: number; eventId: string }[] } {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('event journal: recording', () => {
	it('refuses to act before it is loaded', () => {
		const j = createEventJournal({ file: tempFile(), now: () => 0, newId: () => 'x' });
		expect(() => j.record({} as ManagedLifecycleEvent)).toThrow(/not loaded/);
		expect(() => j.page({ cursor: null, limit: 10 })).toThrow(/not loaded/);
	});

	it('keeps every projected event under its own monotonic sequence and dedups a replayed fact', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		const replayed = fact();
		const first = p.record(replayed);
		const second = p.record(replayed);
		feed(p, 2);
		expect(second.map((e) => e.eventId)).toEqual(first.map((e) => e.eventId));
		const status = j.status();
		expect(status.entries).toBe(3);
		expect(status.counters).toMatchObject({ recorded: 3, duplicates: 1, refused: 0 });
		await j.flush();
		expect(readDocument(file).entries.map((e) => e.sequence)).toEqual([1, 2, 3]);
	});

	it('refuses an event that is not one and counts it, never writing it', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		expect(j.record({ eventId: 'evt-x' } as ManagedLifecycleEvent)).toBe('refused');
		await j.flush();
		expect(j.status().counters.refused).toBe(1);
		expect(fs.readFileSync(file, 'utf8')).not.toContain('evt-x');
	});

	it('records a projector refusal as a gap and a refused fact never reaches the file', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		feed(p, 1);
		p.record({ ...fact(), prompt: 'SECRET-CANARY' } as unknown as LifecycleFact);
		feed(p, 1);
		await j.flush();
		const gaps = j.status().gaps;
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ kind: 'projector-refused', count: 1, afterSequence: 1 });
		expect(fs.readFileSync(file, 'utf8')).not.toContain('SECRET-CANARY');
		expect(j.page({ cursor: null, limit: 10 }).completeness).toBe('gap');
	});

	it('records a hole in the projector sequence as a counted gap', async () => {
		const { journal: j } = await journal(tempFile());
		const p = projector();
		const events = feed(p, 3);
		j.record(events[0]);
		j.record(events[2]);
		expect(j.status().gaps).toEqual([
			expect.objectContaining({ kind: 'sequence-hole', count: 1, afterSequence: 1 }),
		]);
	});
});

describe('event journal: restart and durability', () => {
	it('continues the sequence across a reload and records the unobserved restart as a gap', async () => {
		const file = tempFile();
		const { journal: a } = await journal(file);
		const p1 = projector('epoch-1');
		a.attach(p1);
		feed(p1, 2);
		await a.flush();

		const { journal: b } = await journal(file);
		expect(b.status()).toMatchObject({ entries: 2, nextSequence: 3, journalId: 'journal-1' });
		const p2 = projector('epoch-2');
		b.attach(p2);
		feed(p2, 1);
		const gaps = b.status().gaps;
		expect(gaps).toHaveLength(1);
		expect(gaps[0]).toMatchObject({ kind: 'restart', afterSequence: 2, count: null });
		expect(gaps[0].detail).toContain('epoch-1');
		await b.flush();
		expect(readDocument(file).entries.map((e) => e.sequence)).toEqual([1, 2, 3]);

		const page = b.page({ cursor: encodeEventCursor('journal-1', 2), limit: 10 });
		expect(page.items).toHaveLength(1);
		expect(page.completeness).toBe('gap');
		const before = b.page({ cursor: null, limit: 2 });
		expect(before.completeness).toBe('complete');
	});

	it('answers not ok for a corrupt file instead of starting over on top of it', async () => {
		const file = tempFile();
		fs.writeFileSync(file, '{ not json');
		const j = createEventJournal({ file, now: () => 0, newId: () => 'j' });
		const loaded = await j.load();
		expect(loaded).toMatchObject({ ok: false, reason: 'corrupt', file });
		expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
	});

	it('coalesces a burst into one write and flush waits for it', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		feed(p, 5);
		await j.flush();
		expect(readDocument(file).entries).toHaveLength(5);
		expect(j.status().writeFailure).toBeNull();
	});

	it('keeps a failed write as a fact for status and the next flush, never an unhandled rejection', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		open.pop();
		const p = projector();
		j.attach(p);
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
		feed(p, 1);
		await expect(j.flush()).rejects.toThrow(/ENOENT/);
		expect(j.status().writeFailure?.message).toMatch(/ENOENT/);
		expect(j.status().entries).toBe(1);
	});
});

describe('event journal: hand-over and receipts', () => {
	it('hands the oldest unconfirmed entries over once, and marks received only from a receipt', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		const events = feed(p, 4);
		const batch = j.take(2);
		expect(batch.map((e) => e.eventId)).toEqual(events.slice(0, 2).map((e) => e.eventId));
		expect(batch.every((e) => e.attempts === 1)).toBe(true);
		expect(j.take(10).map((e) => e.eventId)).toEqual(events.slice(2).map((e) => e.eventId));
		expect(j.take(10)).toEqual([]);
		expect(j.status().held).toBe(4);

		expect(
			await j.acknowledge([events[0].eventId, events[1].eventId], { correlationId: 'c-1' })
		).toBe(2);
		const status = j.status();
		expect(status.delivery).toEqual({ pending: 2, uncertain: 0, received: 2 });
		expect(status.held).toBe(2);
		expect(status.counters.received).toBe(2);
		await j.flush();
		const { journal: again } = await journal(file);
		expect(again.status().delivery.received).toBe(2);
		expect(again.take(10).map((e) => e.eventId)).toEqual(events.slice(2).map((e) => e.eventId));
		expect(await again.acknowledge([events[0].eventId], { correlationId: 'c-2' })).toBe(0);
	});

	it('keeps an answer that was lost as uncertain, durable and eligible for a resend', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		const [event] = feed(p, 1);
		j.take(1);
		expect(await j.settle([event.eventId], 'uncertain', 'the answer did not come back')).toBe(1);
		await j.flush();
		const { journal: again } = await journal(file);
		expect(again.status().delivery).toEqual({ pending: 0, uncertain: 1, received: 0 });
		const resend = again.take(5);
		expect(resend).toHaveLength(1);
		expect(resend[0]).toMatchObject({ eventId: event.eventId, attempts: 2, delivery: 'uncertain' });
		expect(await again.acknowledge([event.eventId], { correlationId: 'c-9' })).toBe(1);
		expect(again.status().delivery.received).toBe(1);
	});

	it('leaves an entry the transport skips in place: not held, not an attempt, taken later when the skip lifts', async () => {
		const file = tempFile();
		const { journal: j } = await journal(file);
		const p = projector();
		j.attach(p);
		const [old, next] = feed(p, 2);
		const skipped = j.take(10, { skip: (entry) => entry.eventId === old.eventId });
		expect(skipped.map((e) => e.eventId)).toEqual([next.eventId]);
		expect(j.status().held).toBe(1);
		await j.acknowledge([next.eventId], { correlationId: null });
		await j.flush();
		const written = readDocument(file).entries as { eventId: string; attempts: number }[];
		expect(written.find((e) => e.eventId === old.eventId)?.attempts).toBe(0);
		// Without the skip the entry is the oldest unconfirmed one again.
		expect(j.take(10).map((e) => e.eventId)).toEqual([old.eventId]);
	});

	it('leaves a request that never left as pending and releases the hold', async () => {
		const { journal: j } = await journal(tempFile());
		const p = projector();
		j.attach(p);
		const [event] = feed(p, 1);
		j.take(1);
		expect(j.take(1)).toEqual([]);
		expect(await j.settle([event.eventId], 'unavailable', 'socket not attached')).toBe(0);
		expect(j.status()).toMatchObject({
			held: 0,
			delivery: { pending: 1, uncertain: 0, received: 0 },
		});
		expect(j.take(1).map((e) => e.eventId)).toEqual([event.eventId]);
	});
});

describe('event journal: cursors, pages and bounds', () => {
	it('pages oldest first with an opaque cursor that resumes exactly after the last item', async () => {
		const { journal: j } = await journal(tempFile());
		const p = projector();
		j.attach(p);
		const events = feed(p, 5);
		const one = j.page({ cursor: null, limit: 2 });
		expect(one.items.map((e) => e.eventId)).toEqual(events.slice(0, 2).map((e) => e.eventId));
		expect(one.completeness).toBe('complete');
		expect(decodeEventCursor(one.nextCursor as string)).toEqual({
			journalId: 'journal-1',
			sequence: 2,
		});
		const two = j.page({ cursor: one.nextCursor, limit: 2 });
		expect(two.items.map((e) => e.eventId)).toEqual(events.slice(2, 4).map((e) => e.eventId));
		const three = j.page({ cursor: two.nextCursor, limit: 2 });
		expect(three.items).toHaveLength(1);
		const idle = j.page({ cursor: three.nextCursor, limit: 2 });
		expect(idle.items).toEqual([]);
		expect(idle.nextCursor).toBe(three.nextCursor);
		expect(idle.completeness).toBe('complete');
		feed(p, 1);
		expect(j.page({ cursor: idle.nextCursor, limit: 2 }).items).toHaveLength(1);
	});

	it('answers unknown for a cursor it did not issue, and null while empty', async () => {
		const { journal: j } = await journal(tempFile());
		expect(j.page({ cursor: null, limit: 5 })).toEqual({
			items: [],
			nextCursor: null,
			completeness: 'complete',
		});
		const p = projector();
		j.attach(p);
		feed(p, 2);
		const foreign = j.page({ cursor: encodeEventCursor('another', 1), limit: 5 });
		expect(foreign.completeness).toBe('unknown');
		expect(foreign.items).toHaveLength(2);
		expect(j.page({ cursor: 'garbage', limit: 5 }).completeness).toBe('unknown');
		expect(decodeEventCursor('evc:journal-1:x')).toBeNull();
		expect(decodeEventCursor('evc::1')).toBeNull();
	});

	it('trims oldest first within its bound, counting an unconfirmed loss as a placed gap', async () => {
		const { journal: j } = await journal(tempFile(), { maxEntries: 3 });
		const p = projector();
		j.attach(p);
		const events = feed(p, 2);
		await j.acknowledge([events[0].eventId], { correlationId: 'c' });
		events.push(...feed(p, 4));
		const status = j.status();
		expect(status.entries).toBe(3);
		expect(status.counters).toMatchObject({ trimmed: 3, trimmedUnreceived: 2 });
		expect(status.gaps).toEqual([
			expect.objectContaining({ kind: 'trimmed-unreceived', afterSequence: 1, count: 2 }),
		]);
		const fromStart = j.page({ cursor: null, limit: 10 });
		expect(fromStart.completeness).toBe('gap');
		expect(fromStart.items.map((e) => e.eventId)).toEqual(events.slice(3).map((e) => e.eventId));
		const inside = j.page({ cursor: encodeEventCursor('journal-1', 4), limit: 10 });
		expect(inside.completeness).toBe('complete');
		expect(inside.items).toHaveLength(2);
		const trimmedCursor = j.page({ cursor: encodeEventCursor('journal-1', 1), limit: 10 });
		expect(trimmedCursor.completeness).toBe('gap');
		expect(trimmedCursor.items).toHaveLength(3);
	});

	it('forgets the oldest gap records past their bound and counts that too', async () => {
		const { journal: j } = await journal(tempFile(), { maxEntries: 2, maxGaps: 1 });
		const p = projector();
		j.attach(p);
		const events = feed(p, 2);
		await j.acknowledge([events[1].eventId], { correlationId: 'c' });
		feed(p, 3);
		const status = j.status();
		expect(status.gaps).toHaveLength(1);
		expect(status.counters.gapsForgotten).toBe(1);
	});

	it('clamps the page and batch sizes', async () => {
		const { journal: j } = await journal(tempFile());
		const p = projector();
		j.attach(p);
		feed(p, 2);
		expect(j.page({ cursor: null, limit: 0 }).items).toHaveLength(1);
		expect(j.take(0)).toHaveLength(1);
	});
});
