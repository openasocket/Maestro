/**
 * The authenticated telemetry client (MRC-10-03): the projection of a journaled
 * lifecycle event onto the endpoint's runtime report, the receipt that alone
 * marks an entry received, and the pass that takes, reports and settles with
 * nothing dropped: a lost answer resent under the same id, a transport failure
 * released unchanged, a policy denial held until the standing changes, and an
 * event from another boot left in place by name. The journal is the real one
 * over a temp file; the host is an in-memory double of the adapter's two
 * telemetry members, declared so.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createTelemetryClient,
	readTelemetryReceipt,
	telemetryReportOf,
	TELEMETRY_HOLDING_DENIALS,
	type TelemetryClient,
	type TelemetryPass,
} from '../../../main/enterprise/telemetry';
import type {
	EndpointInvokeOutcome,
	LocalEndpointDenialReason,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createEventJournal,
	type EventJournal,
} from '../../../shared/maestro-lib/managed/event-journal';
import {
	createLifecycleProjector,
	type LifecycleFact,
	type LifecycleProjector,
	type ManagedLifecycleEvent,
} from '../../../shared/maestro-lib/managed/events';
import type {
	EndpointTelemetryEvent,
	ManagedHostAdapter,
	TelemetryBinding,
	TelemetryStanding,
} from '../../../shared/maestro-lib/managed/host-adapter';

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};
const BINDING: TelemetryBinding = {
	deviceId: 'enr-1',
	installation: INSTALLATION,
	policyRevision: 3,
};

const dirs: string[] = [];
const open: EventJournal[] = [];
afterEach(async () => {
	for (const j of open.splice(0)) await j.flush();
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projector(processEpoch = 'epoch-1'): LifecycleProjector {
	return createLifecycleProjector({
		installation: { ...INSTALLATION, processEpoch },
		origin: 'desktop',
		actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
		policyRevision: () => 3,
	});
}

let facts = 0;
const fact = (overrides: Partial<LifecycleFact> = {}): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at: T0 + ++facts,
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

async function journal(): Promise<EventJournal> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-telemetry-'));
	dirs.push(dir);
	let ids = 0;
	const made = createEventJournal({
		file: path.join(dir, 'maestro-managed-events.json'),
		now: () => T0,
		newId: () => `journal-${++ids}`,
	});
	open.push(made);
	const loaded = await made.load();
	if (!loaded.ok) throw new Error(loaded.message);
	return made;
}

type Answer =
	| EndpointInvokeOutcome<unknown>
	| ((report: EndpointTelemetryEvent) => EndpointInvokeOutcome<unknown>);

/** The adapter's two telemetry members, scripted: a standing to answer and a queue of answers to give. */
function hostDouble(initial: Partial<TelemetryStanding> = {}) {
	const reports: EndpointTelemetryEvent[] = [];
	const answers: Answer[] = [];
	const seen = new Set<string>();
	const receipt = (report: EndpointTelemetryEvent): EndpointInvokeOutcome<unknown> => {
		const duplicate = seen.has(report.eventId);
		seen.add(report.eventId);
		return {
			status: 'ok',
			payload: {
				outcome: 'durably_accepted',
				eventId: report.eventId,
				receivedAt: '2026-10-22T12:00:01.000Z',
				duplicate,
			},
		};
	};
	let standing: TelemetryStanding = {
		standingKey: 'c1:registered:attached:managed:3:telemetry',
		ok: true,
		binding: BINDING,
		...initial,
	} as TelemetryStanding;
	let port: ManagedHostAdapter['telemetry'] = {
		report: async (report) => {
			reports.push(report);
			const next = answers.shift() ?? receipt;
			return typeof next === 'function' ? next(report) : next;
		},
	};
	const host: Pick<ManagedHostAdapter, 'telemetry' | 'telemetryStanding'> = {
		get telemetry() {
			return port;
		},
		telemetryStanding: () => standing,
	};
	return {
		host,
		reports,
		answers,
		/** What the fake spool holds; an answer lost on the way back still left the event here. */
		seen,
		setStanding: (next: TelemetryStanding) => {
			standing = next;
		},
		detach: () => {
			port = null;
		},
	};
}

function client(
	j: EventJournal,
	host: Pick<ManagedHostAdapter, 'telemetry' | 'telemetryStanding'>,
	options: { batchSize?: number } = {}
): TelemetryClient {
	return createTelemetryClient({ journal: j, host, now: () => T0, ...options });
}

describe('telemetryReportOf', () => {
	it('builds the runtime report by allowlist: bound to the enrollment, installation and producing boot, identities withheld by name', () => {
		const [event] = projector().record(fact());
		const projected = telemetryReportOf(event, BINDING);
		expect(projected.ok).toBe(true);
		if (!projected.ok) return;
		expect(projected.report).toEqual({
			schemaVersion: 1,
			eventId: event.eventId,
			deviceId: 'enr-1',
			instanceId: 'inst-1',
			bootId: 'epoch-1',
			sequence: event.sequence,
			occurredAt: event.occurredAt,
			source: 'runtime',
			family: 'agent.lifecycle',
			policyRevision: 3,
			collectionProfile: 'metadata',
			completeness: { metadata: 'partial', content: 'unavailable', lineage: 'filtered_by_policy' },
			usageProvenance: 'unavailable',
			redaction: { state: 'not_applicable', ruleIds: [] },
			contentReferences: [],
		});
		// The run identities the endpoint refuses stay off the wire, under any key.
		const wire = JSON.stringify(projected.report);
		for (const canary of ['agent-1', 'run-1', 'agent-1-ai-tab-1', 'claude-code', 'opus']) {
			expect(wire).not.toContain(canary);
		}
		expect(Object.keys(projected.report)).not.toContain('agentId');
		expect(Object.keys(projected.report)).not.toContain('runId');
	});

	it('refuses an event from another boot or another installation by name, and never re-stamps it', () => {
		const [other] = projector('epoch-0').record(fact());
		expect(telemetryReportOf(other, BINDING)).toMatchObject({ ok: false, reason: 'other-boot' });
		const foreign: ManagedLifecycleEvent = {
			...other,
			installation: { ...INSTALLATION, installationId: 'inst-2' },
		};
		expect(telemetryReportOf(foreign, BINDING)).toMatchObject({
			ok: false,
			reason: 'other-installation',
		});
	});

	it('refuses an id, a sequence or a time the endpoint would not read', () => {
		const [event] = projector().record(fact());
		expect(telemetryReportOf({ ...event, eventId: 'evt with space' }, BINDING)).toMatchObject({
			ok: false,
			reason: 'event-id',
		});
		expect(telemetryReportOf({ ...event, sequence: -1 }, BINDING)).toMatchObject({
			ok: false,
			reason: 'sequence',
		});
		expect(
			telemetryReportOf({ ...event, occurredAt: '2026-10-22T12:00:00Z' }, BINDING)
		).toMatchObject({ ok: false, reason: 'occurred-at' });
	});
});

describe('readTelemetryReceipt', () => {
	it('reads a durable receipt for the event sent and nothing else', () => {
		const good = {
			outcome: 'durably_accepted',
			eventId: 'evt-1',
			receivedAt: '2026-10-22T12:00:01.000Z',
			duplicate: false,
		};
		expect(readTelemetryReceipt(good, 'evt-1')).toEqual({
			eventId: 'evt-1',
			receivedAt: good.receivedAt,
			duplicate: false,
		});
		expect(readTelemetryReceipt(good, 'evt-2')).toBeNull();
		expect(readTelemetryReceipt({ ...good, outcome: 'accepted' }, 'evt-1')).toBeNull();
		expect(readTelemetryReceipt({ ...good, duplicate: 'no' }, 'evt-1')).toBeNull();
		expect(readTelemetryReceipt({ ...good, receivedAt: 'yesterday' }, 'evt-1')).toBeNull();
		expect(readTelemetryReceipt(null, 'evt-1')).toBeNull();
	});
});

describe('telemetry client', () => {
	it('reports every pending entry once, marks received only from the receipt, and sends nothing while the journal is empty', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		const events = [...p.record(fact()), ...p.record(fact())];
		const h = hostDouble();
		const c = client(j, h.host);
		const pass = await c.pump();
		expect(pass).toMatchObject({ outcome: 'sent', taken: 2, received: 2, duplicates: 0 });
		expect(h.reports.map((r) => r.eventId)).toEqual(events.map((e) => e.eventId));
		expect(j.status()).toMatchObject({
			delivery: { pending: 0, uncertain: 0, received: 2 },
			held: 0,
		});
		expect(await c.pump()).toMatchObject({ outcome: 'idle', taken: 0 });
		expect(h.reports).toHaveLength(2);
		expect(c.status().counters).toMatchObject({ passes: 2, taken: 2, received: 2 });
	});

	it('keeps a lost answer uncertain and resends it under the same id, which the endpoint answers as a duplicate', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		const [a] = p.record(fact());
		const [b] = p.record(fact());
		const h = hostDouble();
		// The first report leaves and its answer is lost: the endpoint took it, the client does not know.
		h.answers.push((report) => {
			h.seen.add(report.eventId);
			return { status: 'unknown', message: `lost ${report.eventId}` };
		});
		const c = client(j, h.host);
		const first = await c.pump();
		expect(first).toMatchObject({
			outcome: 'interrupted',
			taken: 2,
			uncertain: 1,
			unavailable: 1,
			received: 0,
		});
		expect(j.status()).toMatchObject({
			delivery: { pending: 1, uncertain: 1, received: 0 },
			held: 0,
		});
		expect(c.status().consecutiveFailures).toBe(1);
		// The resend carries the same id; the fake's spool had it, so the receipt says duplicate.
		const second = await c.pump();
		expect(second).toMatchObject({ outcome: 'sent', taken: 2, received: 2, duplicates: 1 });
		expect(h.reports.map((r) => r.eventId)).toEqual([a.eventId, a.eventId, b.eventId]);
		expect(j.status()).toMatchObject({ delivery: { pending: 0, uncertain: 0, received: 2 } });
		expect(c.status().consecutiveFailures).toBe(0);
	});

	it('releases an entry the transport could not carry unchanged and backs off, with nothing held', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		p.record(fact());
		p.record(fact());
		const h = hostDouble();
		h.answers.push({ status: 'unavailable', reason: 'transport', message: 'ECONNREFUSED' });
		const c = client(j, h.host);
		expect(await c.pump()).toMatchObject({
			outcome: 'interrupted',
			reason: 'ECONNREFUSED',
			taken: 2,
			unavailable: 2,
		});
		expect(j.status()).toMatchObject({
			delivery: { pending: 2, uncertain: 0, received: 0 },
			held: 0,
		});
		// Only the first was reported; the second was released as not sent.
		expect(h.reports).toHaveLength(1);
		expect(await c.pump()).toMatchObject({ outcome: 'sent', received: 2 });
	});

	it.each(TELEMETRY_HOLDING_DENIALS)(
		'a %s denial holds sending under the standing it was answered on, drops nothing, and lifts when the standing changes',
		async (reason) => {
			const j = await journal();
			const p = projector();
			j.attach(p);
			p.record(fact());
			p.record(fact());
			const h = hostDouble();
			h.answers.push({ status: 'denied', reason });
			const c = client(j, h.host);
			const denied = await c.pump();
			expect(denied).toMatchObject({ outcome: 'held', denial: reason, taken: 2, unavailable: 2 });
			expect(c.status().hold).toMatchObject({ reason, standingKey: expect.any(String) });
			expect(j.status()).toMatchObject({ delivery: { pending: 2, received: 0 }, held: 0 });
			// Held: nothing is taken, nothing is sent, the entries stay.
			expect(await c.pump()).toMatchObject({ outcome: 'held', taken: 0 });
			expect(h.reports).toHaveLength(1);
			// The standing changes (a new policy revision, a re-registration): the hold lifts.
			h.setStanding({
				standingKey: 'c2:registered:attached:managed:4:telemetry',
				ok: true,
				binding: { ...BINDING, policyRevision: 4 },
			});
			const resumed = await c.pump();
			expect(resumed).toMatchObject({ outcome: 'sent', received: 2 });
			expect(c.status().hold).toBeNull();
			expect(h.reports.at(-1)?.policyRevision).toBe(4);
		}
	);

	it('treats a transient denial as an interruption, not a hold, and a replay as a lost answer', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		p.record(fact());
		const h = hostDouble();
		h.answers.push({ status: 'denied', reason: 'budget_exhausted' });
		const c = client(j, h.host);
		expect(await c.pump()).toMatchObject({
			outcome: 'interrupted',
			denial: 'budget_exhausted',
			unavailable: 1,
		});
		expect(c.status().hold).toBeNull();
		h.answers.push({ status: 'denied', reason: 'replay' });
		expect(await c.pump()).toMatchObject({
			outcome: 'interrupted',
			denial: 'replay',
			uncertain: 1,
		});
		expect(j.status()).toMatchObject({ delivery: { uncertain: 1 } });
		expect(c.status().counters.denied).toEqual({ budget_exhausted: 1, replay: 1 });
	});

	it('sends nothing without a standing or a socket, and takes nothing from the journal', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		p.record(fact());
		const h = hostDouble({
			ok: false,
			reason: 'This process has not redeemed an actor registration.',
		});
		const c = client(j, h.host);
		expect(await c.pump()).toMatchObject({
			outcome: 'no-standing',
			reason: 'This process has not redeemed an actor registration.',
			taken: 0,
		});
		const detached = hostDouble();
		detached.detach();
		expect(await client(j, detached.host).pump()).toMatchObject({
			outcome: 'no-standing',
			reason: 'No endpoint socket is open.',
		});
		expect(j.status()).toMatchObject({ delivery: { pending: 1 }, held: 0 });
		expect(h.reports).toHaveLength(0);
	});

	it('leaves an entry from an earlier boot in place, counted by name, and sends the ones this boot produced', async () => {
		const j = await journal();
		const earlier = projector('epoch-0');
		j.attach(earlier);
		earlier.record(fact());
		earlier.record(fact());
		const current = projector();
		j.attach(current);
		const [mine] = current.record(fact());
		const h = hostDouble();
		const c = client(j, h.host);
		const pass = await c.pump();
		expect(pass).toMatchObject({ outcome: 'sent', taken: 1, received: 1 });
		expect(pass.withheld).toMatchObject({ 'other-boot': 2 });
		expect(h.reports.map((r) => r.eventId)).toEqual([mine.eventId]);
		expect(h.reports[0]?.bootId).toBe('epoch-1');
		// Still pending, never attempted, never re-stamped with this boot.
		const written = JSON.parse(fs.readFileSync(j.file, 'utf8')) as {
			entries: { delivery: string; attempts: number }[];
		};
		expect(written.entries.map((e) => [e.delivery, e.attempts])).toEqual([
			['pending', 0],
			['pending', 0],
			['received', 1],
		]);
	});

	it('an answer that is not a receipt leaves the entry uncertain, never received', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		p.record(fact());
		const h = hostDouble();
		h.answers.push({
			status: 'ok',
			payload: { outcome: 'durably_accepted', eventId: 'evt-other' },
		});
		const c = client(j, h.host);
		expect(await c.pump()).toMatchObject({ outcome: 'interrupted', uncertain: 1, received: 0 });
		expect(j.status()).toMatchObject({ delivery: { uncertain: 1, received: 0 } });
	});

	it('runs on its timer: at once on start, a full batch again at once, the idle poll when nothing is left, and nothing after stop', async () => {
		const j = await journal();
		const p = projector();
		j.attach(p);
		for (let i = 0; i < 3; i += 1) p.record(fact());
		const h = hostDouble();
		const scheduled: { ms: number; fire: () => void }[] = [];
		const passes: TelemetryPass[] = [];
		const c = createTelemetryClient({
			journal: j,
			host: h.host,
			now: () => T0,
			batchSize: 2,
			intervalMs: 5_000,
			timers: {
				set: (fire, ms) => {
					const handle = { ms, fire };
					scheduled.push(handle);
					return handle;
				},
				clear: (handle) => {
					const at = scheduled.indexOf(handle as { ms: number; fire: () => void });
					if (at >= 0) scheduled.splice(at, 1);
				},
			},
			onPass: (pass) => passes.push(pass),
		});
		c.start();
		expect(scheduled.map((s) => s.ms)).toEqual([0]);
		const fire = async () => {
			const next = scheduled.shift();
			next?.fire();
			// The pass is asynchronous; let it settle and reschedule.
			await new Promise((resolve) => setTimeout(resolve, 20));
		};
		await fire();
		expect(passes.at(-1)).toMatchObject({ outcome: 'sent', taken: 2 });
		// A full batch went through: the next pass is immediate.
		expect(scheduled.map((s) => s.ms)).toEqual([0]);
		await fire();
		expect(passes.at(-1)).toMatchObject({ outcome: 'sent', taken: 1 });
		expect(scheduled.map((s) => s.ms)).toEqual([5_000]);
		// A new event: wake brings the pass forward.
		c.wake();
		expect(scheduled.map((s) => s.ms)).toEqual([250]);
		c.stop();
		expect(scheduled).toHaveLength(0);
		expect(c.status()).toMatchObject({ running: false, nextPassAt: null });
	});
});

describe('telemetryReportOf for a usage event (MRC-10-04)', () => {
	it('goes as the usage family with the provenance the fact settled; the figures, account and org stay in the journal', () => {
		const p = projector();
		const [priced] = p.recordUsage({
			surface: 'agent',
			state: 'completed',
			at: T0 + 500,
			sessionId: 'agent-1-ai-tab-1',
			agentId: 'agent-1',
			tabId: 'tab-1',
			provider: 'codex',
			model: 'gpt-5-codex',
			providerSessionId: 'thread-1',
			runId: 'run-9',
			record: 'ledger',
			accountRef: 'c'.repeat(64),
			attribution: { tenantId: 'tenant-1', orgId: 'org-eng' },
			usage: {
				provenance: 'estimated',
				tokens: 'provider-stream',
				cost: 'priced',
				costUsd: 0.0021,
				priceRevision: 'price-0123456789abcdef',
				reporting: 'running-total',
				events: 2,
				corrections: 0,
				cacheReadCounting: 'inside-input',
				counts: {
					inputTokens: 1_600,
					outputTokens: 80,
					cacheReadInputTokens: 1_300,
					cacheCreationInputTokens: null,
					reasoningTokens: null,
				},
				contextWindow: null,
			},
		});
		const projected = telemetryReportOf(priced, BINDING);
		expect(projected.ok).toBe(true);
		if (!projected.ok) return;
		expect(projected.report).toMatchObject({
			eventId: priced.eventId,
			family: 'usage',
			usageProvenance: 'estimated',
			collectionProfile: 'metadata',
		});
		const wire = JSON.stringify(projected.report);
		for (const canary of [
			'1600',
			'0.0021',
			'price-',
			'c'.repeat(64),
			'org-eng',
			'tenant-1',
			'run-9',
			'thread-1',
		]) {
			expect(wire).not.toContain(canary);
		}
		const [silent] = p.recordUsage({
			surface: 'agent',
			state: 'failed',
			at: T0 + 600,
			sessionId: 'agent-1-ai-tab-1',
			agentId: 'agent-1',
			tabId: 'tab-1',
			provider: 'codex',
			model: null,
			providerSessionId: null,
			runId: 'run-10',
			record: 'ledger',
			accountRef: null,
			attribution: null,
			usage: {
				provenance: 'unavailable',
				tokens: 'none',
				cost: 'none',
				costUsd: null,
				priceRevision: null,
				reporting: 'none',
				events: 0,
				corrections: 0,
				cacheReadCounting: 'unknown',
				counts: null,
				contextWindow: null,
			},
		});
		const unavailable = telemetryReportOf(silent, BINDING);
		expect(unavailable.ok && unavailable.report).toMatchObject({
			family: 'usage',
			usageProvenance: 'unavailable',
		});
	});
});
