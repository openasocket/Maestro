/**
 * Lifecycle metadata projection (MRC-10-01): the bounded, metadata-only view
 * of what the real lifecycle producers already observe, in the managed event
 * shape (`ManagedEvent`), with the identities a fleet joins on and nothing a
 * fleet must not see.
 *
 * Two producers feed it: the desktop's agent-run capture
 * (`src/main/agent-run/capture-service.ts`, every `ProcessManager` spawn and
 * exit; its ledger omits terminal and group-chat sessions by design, and this
 * projection says `record: 'omitted'` instead of staying silent) and the
 * headless runtime's turn recorder (`turns/record-turn.ts`, every turn end).
 * An event carries identities (installation, surface, process session, agent,
 * tab, run, attempt, the managed lineage when there is one, the decision an
 * admitted launch ran under), the provider and model, the state, exit code and
 * duration. It never carries a prompt, an answer, a tool body, a working
 * directory, an environment value or an argument list: the fact type has no
 * field for them and `record()` refuses a fact that smuggles one in.
 *
 * A projection, not delivery: `recent()` is a bounded window with its loss
 * counted, `subscribe()` is what the durable journal (MRC-10-02) and the
 * telemetry client (MRC-10-03) read, nothing here acknowledges anything to a
 * peer, and the desktop's private per-agent recording is not a producer. An
 * event id is a digest of the fact, so a replayed fact is the same event.
 */

import { canonicalJson } from '../../canonicalJson';
import {
	sha256Hex,
	type DispatchLease,
	type DispatchOperation,
	type ManagedDecisionReceipt,
} from './authority';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedDelegationRef,
	type ManagedDispatchTarget,
	type ManagedEvent,
	type ManagedInstallationIdentity,
	type ManagedOperationContext,
	type ManagedOrigin,
	type ManagedPrincipalRef,
	type ManagedRunIdentity,
	type ManagedRunRecord,
	type ManagedRunState,
	type ManagedWorkflowRef,
} from './types';

/** The surface that ran the work: an AI tab's process, a terminal tab's PTY, a room's turn, a headless turn. */
export const LIFECYCLE_SURFACES = ['agent', 'terminal', 'group-chat', 'headless-turn'] as const;
export type LifecycleSurface = (typeof LIFECYCLE_SURFACES)[number];

/** Where the producer wrote the run: the AgentRun store, the run journal, nowhere by design (the ledger skips that surface), nowhere at all. */
export const LIFECYCLE_RECORDS = ['ledger', 'journal', 'omitted', 'none'] as const;
export type LifecycleRecord = (typeof LIFECYCLE_RECORDS)[number];

/** The managed lineage the work ran under: the attribution half of a `ManagedOperationContext`, as the producer knows it. */
export interface LifecycleLineage {
	identity: ManagedRunIdentity;
	traceId: string;
	workflow: ManagedWorkflowRef | null;
	delegation: ManagedDelegationRef;
	/** The principal the work was bound to. Absent: the projector's own (the installation's operator). */
	actor?: ManagedPrincipalRef;
	/** The policy generation it was admitted under. Absent: the projector's own. */
	policyRevision?: number | null;
	/** The surface that raised it, when the lineage says. Absent: the projector's own. */
	origin?: ManagedOrigin;
}

/** The decision a launch ran under, as the sink holds it: lease, authority, request digest, broker receipt. Joins an event to the dispatch receipt ledger; never a secret or authority. */
export interface LifecycleAdmissionRef {
	leaseId: string;
	authorityId: string;
	requestDigest: string;
	policyRevision: number | null;
	decision?: ManagedDecisionReceipt | null;
	operation?: DispatchOperation;
	target?: ManagedDispatchTarget;
}

/** One lifecycle fact, as a producer reports it. Metadata only: see the module header. */
export interface LifecycleFact {
	surface: LifecycleSurface;
	state: ManagedRunState;
	/** When it happened, epoch milliseconds. */
	at: number;
	/** The process session the surface ran the work under (`<agent>-ai-<tab>`, a terminal id, a room id). */
	sessionId: string;
	agentId: string;
	tabId: string | null;
	provider: string;
	model: string | null;
	providerSessionId: string | null;
	/** The producer's own id for the run: the ledger run id, the journal run id, or a key it holds for an unrecorded run. */
	runId: string;
	record: LifecycleRecord;
	/** The producer's own state word (`needs_review`, `interrupted`), when richer than `state`. */
	ledgerStatus: string | null;
	exitCode: number | null;
	durationMs: number | null;
	/** A safe word about the state (`superseded by <run>`, an error classification). Never output. */
	detail: string | null;
	lineage?: LifecycleLineage;
	admission?: LifecycleAdmissionRef | null;
}

/** Every field a fact may carry. A key outside this list is refused, whatever it holds. */
export const LIFECYCLE_FACT_FIELDS: readonly (keyof LifecycleFact)[] = [
	'surface',
	'state',
	'at',
	'sessionId',
	'agentId',
	'tabId',
	'provider',
	'model',
	'providerSessionId',
	'runId',
	'record',
	'ledgerStatus',
	'exitCode',
	'durationMs',
	'detail',
	'lineage',
	'admission',
];

/** The producers' status words folded onto the contract's run states. Anything else is `unknown`. */
const STATE_OF: Readonly<Record<string, ManagedRunState>> = {
	queued: 'queued',
	running: 'running',
	waiting: 'running',
	needs_review: 'running',
	fixing: 'running',
	completed: 'completed',
	'completed-with-warning': 'completed',
	merged: 'completed',
	failed: 'failed',
	crashed: 'failed',
	cancelled: 'cancelled',
	discarded: 'cancelled',
	interrupted: 'cancelled',
	unknown: 'unknown',
};
const RUN_STATES: readonly string[] = Object.values(STATE_OF);
const MAX_ID_LENGTH = 256;
const MAX_DETAIL_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isIdOrNull = (value: unknown): boolean => value === null || isId(value);
const oneOf = (list: readonly unknown[], value: unknown): boolean => list.includes(value);

/** The structural problems with a value offered as a fact: every field known, the enums ours, every id bounded. A prompt or a path under any key is "unknown field", and the fact is refused whole. */
export function lifecycleFactProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['fact is not an object'];
	const problems: string[] = [];
	for (const key of Object.keys(value)) {
		if (!oneOf(LIFECYCLE_FACT_FIELDS, key)) problems.push(`unknown field "${key}"`);
	}
	if (!oneOf(LIFECYCLE_SURFACES, value.surface)) problems.push('surface is unknown');
	if (!oneOf(RUN_STATES, value.state)) problems.push('state is unknown');
	if (!oneOf(LIFECYCLE_RECORDS, value.record)) problems.push('record is unknown');
	if (typeof value.at !== 'number' || !Number.isFinite(value.at)) problems.push('at is not a time');
	for (const key of ['sessionId', 'agentId', 'provider', 'runId'] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	for (const key of ['tabId', 'model', 'providerSessionId', 'ledgerStatus'] as const) {
		if (!isIdOrNull(value[key])) problems.push(`${key} is not an id or null`);
	}
	for (const key of ['exitCode', 'durationMs'] as const) {
		const v = value[key];
		if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
			problems.push(`${key} is not a number or null`);
		}
	}
	if (
		value.detail !== null &&
		(typeof value.detail !== 'string' || value.detail.length > MAX_DETAIL_LENGTH)
	) {
		problems.push(`detail is not a string within ${MAX_DETAIL_LENGTH} characters or null`);
	}
	if (value.lineage !== undefined) {
		const lineage = value.lineage;
		if (!isRecord(lineage) || !isRecord(lineage.identity) || !isId(lineage.traceId)) {
			problems.push('lineage is not a lineage');
		}
	}
	if (value.admission !== undefined && value.admission !== null) {
		const admission = value.admission;
		if (
			!isRecord(admission) ||
			!isId(admission.leaseId) ||
			!isId(admission.authorityId) ||
			!isId(admission.requestDigest)
		) {
			problems.push('admission is not an admission reference');
		}
	}
	return problems;
}

/** The contract's run state for a producer's status word; never a guess at success. */
export function lifecycleStateOf(status: string): ManagedRunState {
	return STATE_OF[status] ?? 'unknown';
}

/** The lineage a verified or carried operation context amounts to: its attribution, copied. */
export function lifecycleLineageOf(context: ManagedOperationContext): LifecycleLineage {
	return {
		identity: { ...context.identity },
		traceId: context.traceId,
		workflow: context.workflow ? { ...context.workflow } : null,
		delegation: {
			chain: context.delegation.chain.map((link) => ({ ...link })),
			grantRef: context.delegation.grantRef,
		},
		actor: { ...context.actor },
		policyRevision: context.policyRevision,
		origin: context.origin,
	};
}

type LeaseView = Pick<
	DispatchLease,
	'leaseId' | 'authorityId' | 'snapshotDigest' | 'policyRevision' | 'decision'
>;

/** The decision identities a lease carries, for a producer that holds the lease itself. */
export function lifecycleAdmissionOfLease(lease: LeaseView): LifecycleAdmissionRef {
	return {
		leaseId: lease.leaseId,
		authorityId: lease.authorityId,
		requestDigest: lease.snapshotDigest,
		policyRevision: lease.policyRevision,
		decision: lease.decision ? { ...lease.decision } : null,
	};
}

/** The producer's view, as the event keeps it beside the contract fields. */
export type LifecycleSource = Omit<
	LifecycleFact,
	'state' | 'at' | 'agentId' | 'providerSessionId' | 'lineage' | 'admission'
>;

/** A `ManagedEvent` with the producer's view and, on a `decision`, the identities of the decision. */
export interface ManagedLifecycleEvent extends ManagedEvent {
	source: LifecycleSource;
	decision?: LifecycleAdmissionRef;
}

export interface LifecycleProjectionDeps {
	installation: ManagedInstallationIdentity;
	/** The surface this host is, for a fact whose lineage names none. */
	origin: ManagedOrigin;
	/** The principal a fact with no bound actor is attributed to: the installation's operator. */
	actor: () => ManagedPrincipalRef;
	/** The policy generation this host applies now, for a fact with no admitted one. Default null. */
	policyRevision?: () => number | null;
	/** How many events the projector's `recent()` keeps. Default 256. Older ones are dropped and counted. */
	capacity?: number;
}

function contextOf(fact: LifecycleFact, deps: LifecycleProjectionDeps): ManagedOperationContext {
	const lineage = fact.lineage;
	// With no managed lineage the producer's run id is the one request and the one attempt there is.
	const own = fact.runId;
	const policyRevision =
		fact.admission?.policyRevision ??
		lineage?.policyRevision ??
		(deps.policyRevision ? deps.policyRevision() : null);
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installation: { ...deps.installation },
		origin: lineage?.origin ?? deps.origin,
		actor: lineage?.actor ? { ...lineage.actor } : deps.actor(),
		delegation: lineage
			? {
					chain: lineage.delegation.chain.map((link) => ({ ...link })),
					grantRef: lineage.delegation.grantRef,
				}
			: { chain: [], grantRef: null },
		identity: lineage
			? { ...lineage.identity }
			: {
					requestId: own,
					idempotencyKey: own,
					attemptId: own,
					runId: own,
					rootRunId: own,
					parentRunId: null,
				},
		policyRevision,
		workflow: lineage?.workflow ? { ...lineage.workflow } : null,
		traceId: lineage?.traceId ?? own,
		requestedCapabilities: [],
	};
}

function runOf(fact: LifecycleFact, context: ManagedOperationContext): ManagedRunRecord {
	const runId = context.identity.runId ?? fact.runId;
	return {
		runId,
		rootRunId: context.identity.rootRunId ?? runId,
		parentRunId: context.identity.parentRunId,
		attemptId: context.identity.attemptId,
		agentId: fact.agentId,
		providerSessionId: fact.providerSessionId,
		state: fact.state,
	};
}

/** An allowlist copy, never a rest spread: a key the fact type does not name never reaches an event. */
function sourceOf(fact: LifecycleFact): LifecycleSource {
	return {
		surface: fact.surface,
		sessionId: fact.sessionId,
		tabId: fact.tabId,
		provider: fact.provider,
		model: fact.model,
		runId: fact.runId,
		record: fact.record,
		ledgerStatus: fact.ledgerStatus,
		exitCode: fact.exitCode,
		durationMs: fact.durationMs,
		detail: fact.detail,
	};
}

/** `evt-` plus a digest of what identifies the event: the same fact twice is the same event. */
export function lifecycleEventId(
	installation: ManagedInstallationIdentity,
	kind: ManagedEvent['kind'],
	fact: LifecycleFact
): string {
	return `evt-${sha256Hex(
		canonicalJson({
			installation,
			kind,
			surface: fact.surface,
			sessionId: fact.sessionId,
			runId: fact.runId,
			state: fact.state,
			at: fact.at,
			leaseId: fact.admission?.leaseId ?? null,
			requestId: fact.lineage?.identity.requestId ?? null,
			attemptId: fact.lineage?.identity.attemptId ?? null,
		})
	)}`;
}

/** The events one fact amounts to, pure: a `decision` first when a start carries an admission (the decision preceded the process), then the `run-state`, numbered from `nextSequence`. */
export function projectLifecycleEvents(
	fact: LifecycleFact,
	deps: LifecycleProjectionDeps,
	nextSequence: number
): ManagedLifecycleEvent[] {
	const context = contextOf(fact, deps);
	const run = runOf(fact, context);
	const source = sourceOf(fact);
	const occurredAt = new Date(fact.at).toISOString();
	const events: ManagedLifecycleEvent[] = [];
	let sequence = nextSequence;
	if (fact.admission && (fact.state === 'running' || fact.state === 'queued')) {
		events.push({
			contractVersion: MANAGED_CONTRACT_VERSION,
			eventId: lifecycleEventId(deps.installation, 'decision', fact),
			installation: { ...deps.installation },
			sequence: sequence++,
			occurredAt,
			kind: 'decision',
			context,
			run,
			source,
			decision: { ...fact.admission },
		});
	}
	events.push({
		contractVersion: MANAGED_CONTRACT_VERSION,
		eventId: lifecycleEventId(deps.installation, 'run-state', fact),
		installation: { ...deps.installation },
		sequence,
		occurredAt,
		kind: 'run-state',
		context,
		run,
		source,
	});
	return events;
}

/** What a producer holds: the one method it calls. Never throws. */
export interface LifecycleEventSink {
	record(fact: LifecycleFact): readonly ManagedLifecycleEvent[];
}

export interface LifecycleProjector extends LifecycleEventSink {
	/** Hear every event as it is projected. A listener that throws is dropped from that event only. */
	subscribe(listener: (event: ManagedLifecycleEvent) => void): () => void;
	/** The newest events, oldest first, at most `capacity`. */
	recent(): readonly ManagedLifecycleEvent[];
	/** The sequence the next event will take; one more than the last projected. */
	nextSequence(): number;
	/** What this window no longer holds and what it never took: a reader's gap, counted. */
	gaps(): { dropped: number; refused: number };
}

const DEFAULT_CAPACITY = 256;

/** The in-process projector a host composes once and hands its producers: events numbered from 1 in this process (a restart begins again under a new process epoch), a bounded window, and a refusal instead of a throw for a fact that is not one. */
export function createLifecycleProjector(deps: LifecycleProjectionDeps): LifecycleProjector {
	const capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY);
	const window: ManagedLifecycleEvent[] = [];
	const listeners = new Set<(event: ManagedLifecycleEvent) => void>();
	let sequence = 1;
	let dropped = 0;
	let refused = 0;

	return {
		record(fact) {
			if (lifecycleFactProblems(fact).length > 0) {
				refused += 1;
				return [];
			}
			const events = projectLifecycleEvents(fact, deps, sequence);
			sequence += events.length;
			for (const event of events) {
				window.push(event);
				while (window.length > capacity) {
					window.shift();
					dropped += 1;
				}
				for (const listener of [...listeners]) {
					try {
						listener(event);
					} catch {
						// A consumer's failure is its own; the producer's lifecycle path goes on.
					}
				}
			}
			return events;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		recent: () => [...window],
		nextSequence: () => sequence,
		gaps: () => ({ dropped, refused }),
	};
}
