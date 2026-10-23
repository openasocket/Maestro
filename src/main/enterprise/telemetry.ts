/**
 * The authenticated telemetry client (MRC-10-03): hands the lifecycle events
 * the durable journal holds (`managed/event-journal.ts`) to the endpoint
 * daemon's `telemetry` operation, one event per request over the registered,
 * attached socket this host already holds, and settles each entry with the
 * endpoint's own answer. Plain Node, no Electron: the desktop composes it in
 * `service.ts`; a `maestro-cli host` can compose the same.
 *
 * `telemetryReportOf()` projects a `ManagedLifecycleEvent` onto the endpoint's
 * runtime report (`EndpointTelemetryEvent`), bound to the enrollment, the
 * installation and the boot that produced it, under the applied policy
 * revision, with the digest event id the endpoint dedups on. The operation
 * admits no agent, session, run or trace identity, so the wire says so
 * (`completeness.lineage: 'filtered_by_policy'`) and the identities stay in
 * the journal, paged by that same id. Never a prompt, a path or content.
 *
 * Lossless: nothing here removes, rewrites or invents an entry. `received`
 * comes only from a durable receipt for the id sent; a lost answer leaves the
 * entry `uncertain` and a later pass resends the same id (the endpoint answers
 * `duplicate: true`); a request that never left is released unchanged. An
 * entry from an earlier boot is left in place and counted by name (the
 * endpoint takes a runtime report only from the boot that produced it). A
 * denial that is the policy's or the standing's word places a HOLD: sending
 * stops, the entries stay, and the hold lifts when the standing it was placed
 * under changes. Backpressure is a pause, not a drop.
 */

import {
	isEndpointIdentifier,
	type LocalEndpointDenialReason,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type {
	EventJournal,
	JournalEventEntry,
} from '../../shared/maestro-lib/managed/event-journal';
import type { ManagedLifecycleEvent } from '../../shared/maestro-lib/managed/events';
import type {
	EndpointTelemetryEvent,
	ManagedHostAdapter,
	TelemetryBinding,
} from '../../shared/maestro-lib/managed/host-adapter';

// ---------------------------------------------------------------------------
// The report, and the receipt
// ---------------------------------------------------------------------------

/** Why an event is left in the journal unsent: not a loss, a named reason the operation cannot carry it. */
export type TelemetryWithheldReason =
	| 'other-installation'
	| 'other-boot'
	| 'event-id'
	| 'sequence'
	| 'occurred-at';

export type TelemetryProjection =
	| { ok: true; report: EndpointTelemetryEvent }
	| { ok: false; reason: TelemetryWithheldReason; detail: string };

/** The endpoint's timestamp: ISO 8601, UTC, exactly millisecond precision. */
const TIMESTAMP_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The one projection of a journaled lifecycle event onto the endpoint's runtime report. An allowlist build, never a spread. */
export function telemetryReportOf(
	event: ManagedLifecycleEvent,
	binding: TelemetryBinding
): TelemetryProjection {
	const produced = event.installation;
	if (produced.installationId !== binding.installation.installationId) {
		return {
			ok: false,
			reason: 'other-installation',
			detail: `produced by installation ${produced.installationId}, not this one`,
		};
	}
	if (produced.processEpoch !== binding.installation.processEpoch) {
		return {
			ok: false,
			reason: 'other-boot',
			detail: `produced by process epoch ${produced.processEpoch}; the endpoint accepts a runtime report only from the boot that produced it`,
		};
	}
	if (!isEndpointIdentifier(event.eventId)) {
		return { ok: false, reason: 'event-id', detail: 'the event id is not an endpoint identifier' };
	}
	if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
		return { ok: false, reason: 'sequence', detail: 'the sequence is not a count' };
	}
	if (!TIMESTAMP_MS.test(event.occurredAt) || !Number.isFinite(Date.parse(event.occurredAt))) {
		return {
			ok: false,
			reason: 'occurred-at',
			detail: 'occurredAt is not a millisecond timestamp',
		};
	}
	return {
		ok: true,
		report: {
			schemaVersion: 1,
			eventId: event.eventId,
			deviceId: binding.deviceId,
			instanceId: binding.installation.installationId,
			bootId: produced.processEpoch,
			sequence: event.sequence,
			occurredAt: event.occurredAt,
			source: 'runtime',
			family: 'agent.lifecycle',
			policyRevision: binding.policyRevision,
			collectionProfile: 'metadata',
			// The state, provider and surface stay in the journal; the operation
			// refuses the run identities; nothing collects content.
			completeness: { metadata: 'partial', content: 'unavailable', lineage: 'filtered_by_policy' },
			usageProvenance: 'unavailable',
			redaction: { state: 'not_applicable', ruleIds: [] },
			contentReferences: [],
		},
	};
}

/** The endpoint's `durableReceipt`: the spool took the event under this id. `duplicate` says it already had it. */
export interface TelemetryReceipt {
	eventId: string;
	receivedAt: string;
	duplicate: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** The receipt for the event `eventId`, read structurally; null when the answer is not one. */
export function readTelemetryReceipt(payload: unknown, eventId: string): TelemetryReceipt | null {
	if (
		!isRecord(payload) ||
		payload.outcome !== 'durably_accepted' ||
		payload.eventId !== eventId ||
		typeof payload.receivedAt !== 'string' ||
		!Number.isFinite(Date.parse(payload.receivedAt)) ||
		typeof payload.duplicate !== 'boolean'
	) {
		return null;
	}
	return { eventId, receivedAt: payload.receivedAt, duplicate: payload.duplicate };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** Denials that are the policy's or the standing's word about collection itself: a hold, until the standing changes. */
export const TELEMETRY_HOLDING_DENIALS: readonly LocalEndpointDenialReason[] = [
	'policy_denied',
	'unsupported_capability',
	'unsupported_version',
	'unauthenticated',
	'invalid_request',
];

export type TelemetryPassOutcome = 'sent' | 'idle' | 'no-standing' | 'held' | 'interrupted';

export interface TelemetryPass {
	at: string;
	outcome: TelemetryPassOutcome;
	/** Why the pass sent nothing, or stopped early; null when it ran to the end of its batch. */
	reason: string | null;
	taken: number;
	received: number;
	duplicates: number;
	uncertain: number;
	unavailable: number;
	/** What the pass walked past and left in the journal, by reason. */
	withheld: Record<TelemetryWithheldReason, number>;
	denial: LocalEndpointDenialReason | null;
}

export interface TelemetryHold {
	reason: LocalEndpointDenialReason;
	since: string;
	detail: string;
	/** The standing the hold was placed under; a different key lifts it. */
	standingKey: string;
}

export interface TelemetryCounters {
	passes: number;
	taken: number;
	received: number;
	duplicates: number;
	uncertain: number;
	unavailable: number;
	denied: Partial<Record<LocalEndpointDenialReason, number>>;
}

export interface TelemetryClientStatus {
	running: boolean;
	passInFlight: boolean;
	hold: TelemetryHold | null;
	nextPassAt: string | null;
	consecutiveFailures: number;
	lastPass: TelemetryPass | null;
	counters: TelemetryCounters;
}

export interface TelemetryClient {
	/** Run the idle poll until `stop()`. A second start is a no-op. */
	start(): void;
	stop(): void;
	/** Something new is in the journal: pass soon, unless a backoff is in force. */
	wake(): void;
	/** One pass, now: take, report, settle. Serialized; a pass in flight is awaited instead. */
	pump(): Promise<TelemetryPass>;
	/** Settles once no pass is in flight; starts none. What a host awaits after `stop()`, before it flushes the journal. */
	drain(): Promise<void>;
	status(): TelemetryClientStatus;
}

/**
 * The idle poll a long-lived host runs the client at: a standing read costs a sealed-record read
 * (the keyring anchor with it), so the hosts pass on `wake()` and poll this rarely for retries.
 */
export const TELEMETRY_HOST_IDLE_POLL_MS = 60_000;

export interface TelemetryClientDeps {
	journal: Pick<EventJournal, 'take' | 'acknowledge' | 'settle'>;
	host: Pick<ManagedHostAdapter, 'telemetry' | 'telemetryStanding'>;
	now?: () => number;
	/** Events handed over per pass, each one request. Default 32. */
	batchSize?: number;
	/** The idle poll. Default 5 s. */
	intervalMs?: number;
	/** How soon `wake()` passes. Default 250 ms. */
	wakeDelayMs?: number;
	/** The longest wait after consecutive interruptions. Default 60 s. */
	maxBackoffMs?: number;
	/** Test seam: the timer. Default `setTimeout` / `clearTimeout`. */
	timers?: {
		set(callback: () => void, ms: number): unknown;
		clear(handle: unknown): void;
	};
	/** Hears every pass. Default: nothing. */
	onPass?(pass: TelemetryPass): void;
}

const DEFAULT_BATCH = 32;
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_WAKE_DELAY_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

const emptyWithheld = (): Record<TelemetryWithheldReason, number> => ({
	'other-installation': 0,
	'other-boot': 0,
	'event-id': 0,
	sequence: 0,
	'occurred-at': 0,
});

export function createTelemetryClient(deps: TelemetryClientDeps): TelemetryClient {
	const now = deps.now ?? (() => Date.now());
	const batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH);
	const intervalMs = Math.max(1, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
	const wakeDelayMs = Math.max(0, deps.wakeDelayMs ?? DEFAULT_WAKE_DELAY_MS);
	const maxBackoffMs = Math.max(intervalMs, deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
	const timers = deps.timers ?? {
		// Auxiliary to the host: the timer never keeps a process alive on its own.
		set: (callback, ms) => setTimeout(callback, ms).unref(),
		clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
	};
	const iso = (): string => new Date(now()).toISOString();

	let running = false;
	let timer: unknown = null;
	let nextPassAt: number | null = null;
	let inFlight: Promise<TelemetryPass> | null = null;
	let hold: TelemetryHold | null = null;
	let failures = 0;
	let lastPass: TelemetryPass | null = null;
	const counters: TelemetryCounters = {
		passes: 0,
		taken: 0,
		received: 0,
		duplicates: 0,
		uncertain: 0,
		unavailable: 0,
		denied: {},
	};

	function schedule(ms: number): void {
		if (!running) return;
		if (timer !== null) timers.clear(timer);
		nextPassAt = now() + ms;
		timer = timers.set(() => {
			timer = null;
			nextPassAt = null;
			void pump().then(afterPass, afterPass);
		}, ms);
	}

	/** The next pass: at once while a full batch went through, backed off after an interruption, else the idle poll. */
	function afterPass(): void {
		if (!running || timer !== null) return;
		const pass = lastPass;
		if (pass?.outcome === 'sent' && pass.taken >= batchSize) schedule(0);
		else if (failures > 0) schedule(Math.min(intervalMs * 2 ** failures, maxBackoffMs));
		else schedule(intervalMs);
	}

	async function pass(): Promise<TelemetryPass> {
		const at = iso();
		const summary: TelemetryPass = {
			at,
			outcome: 'idle',
			reason: null,
			taken: 0,
			received: 0,
			duplicates: 0,
			uncertain: 0,
			unavailable: 0,
			withheld: emptyWithheld(),
			denial: null,
		};
		const standing = deps.host.telemetryStanding();
		if (hold) {
			if (hold.standingKey === standing.standingKey) {
				return { ...summary, outcome: 'held', reason: hold.detail };
			}
			hold = null;
		}
		const port = deps.host.telemetry;
		if (!standing.ok || !port) {
			return {
				...summary,
				outcome: 'no-standing',
				reason: standing.ok ? 'No endpoint socket is open.' : standing.reason,
			};
		}
		const { binding } = standing;
		const batch = deps.journal.take(batchSize, {
			skip: (entry: JournalEventEntry) => {
				const projected = telemetryReportOf(entry.event, binding);
				if (projected.ok) return false;
				summary.withheld[projected.reason] += 1;
				return true;
			},
		});
		summary.taken = batch.length;
		if (batch.length === 0) return summary;

		// Every taken entry is settled or acknowledged before the pass ends; the
		// ones a stop leaves unsent are released unchanged, with the reason.
		const unsettled = new Map(batch.map((entry) => [entry.eventId, entry]));
		let stop: { outcome: TelemetryPassOutcome; reason: string } | null = null;
		const settle = async (
			entry: JournalEventEntry,
			outcome: 'uncertain' | 'unavailable',
			detail: string
		): Promise<void> => {
			unsettled.delete(entry.eventId);
			await deps.journal.settle([entry.eventId], outcome, detail);
			summary[outcome] += 1;
		};
		try {
			for (const entry of batch) {
				const projected = telemetryReportOf(entry.event, binding);
				if (!projected.ok) {
					// The binding did not change within the pass; this is defensive.
					await settle(entry, 'unavailable', `not sent: ${projected.detail}`);
					continue;
				}
				const answer = await port.report(projected.report);
				if (answer.status === 'ok') {
					const receipt = readTelemetryReceipt(answer.payload, entry.eventId);
					if (!receipt) {
						await settle(
							entry,
							'uncertain',
							'the endpoint answered without a durable receipt for this event'
						);
						stop = { outcome: 'interrupted', reason: 'The telemetry answer was not a receipt.' };
						break;
					}
					unsettled.delete(entry.eventId);
					await deps.journal.acknowledge([entry.eventId], { correlationId: null });
					summary.received += 1;
					if (receipt.duplicate) summary.duplicates += 1;
					continue;
				}
				if (answer.status === 'unknown') {
					await settle(entry, 'uncertain', answer.message);
					stop = { outcome: 'interrupted', reason: answer.message };
					break;
				}
				if (answer.status === 'unavailable') {
					await settle(entry, 'unavailable', answer.message);
					stop = { outcome: 'interrupted', reason: answer.message };
					break;
				}
				const { reason } = answer;
				summary.denial = reason;
				counters.denied[reason] = (counters.denied[reason] ?? 0) + 1;
				if (reason === 'replay') {
					// The endpoint consumed this correlation already: the first answer was lost.
					await settle(entry, 'uncertain', 'the endpoint answered replay');
					stop = { outcome: 'interrupted', reason: 'The endpoint answered replay.' };
					break;
				}
				const detail = `the endpoint refused the report: ${reason}`;
				await settle(entry, 'unavailable', detail);
				if (TELEMETRY_HOLDING_DENIALS.includes(reason)) {
					hold = { reason, since: at, detail, standingKey: standing.standingKey };
					stop = { outcome: 'held', reason: `${detail}; held until the standing changes` };
				} else {
					stop = { outcome: 'interrupted', reason: detail };
				}
				break;
			}
		} finally {
			const left = [...unsettled.keys()];
			if (left.length > 0) {
				await deps.journal.settle(
					left,
					'unavailable',
					`not sent: ${stop?.reason ?? 'the pass ended'}`
				);
				summary.unavailable += left.length;
			}
		}
		if (stop) return { ...summary, outcome: stop.outcome, reason: stop.reason };
		return { ...summary, outcome: 'sent' };
	}

	function pump(): Promise<TelemetryPass> {
		if (inFlight) return inFlight;
		inFlight = pass()
			.then((result) => {
				counters.passes += 1;
				counters.taken += result.taken;
				counters.received += result.received;
				counters.duplicates += result.duplicates;
				counters.uncertain += result.uncertain;
				counters.unavailable += result.unavailable;
				failures = result.outcome === 'interrupted' ? failures + 1 : 0;
				lastPass = result;
				deps.onPass?.(result);
				return result;
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	}

	return {
		start() {
			if (running) return;
			running = true;
			schedule(0);
		},
		stop() {
			running = false;
			if (timer !== null) timers.clear(timer);
			timer = null;
			nextPassAt = null;
		},
		wake() {
			if (!running || inFlight || failures > 0) return;
			if (nextPassAt !== null && nextPassAt <= now() + wakeDelayMs) return;
			schedule(wakeDelayMs);
		},
		pump,
		drain: async () => {
			if (inFlight)
				await inFlight.then(
					() => undefined,
					() => undefined
				);
		},
		status: () => ({
			running,
			passInFlight: inFlight !== null,
			hold,
			nextPassAt: nextPassAt === null ? null : new Date(nextPassAt).toISOString(),
			consecutiveFailures: failures,
			lastPass,
			counters: { ...counters, denied: { ...counters.denied } },
		}),
	};
}
