/**
 * The desktop's usage producer (MRC-10-04): one `UsageFact` per settled process
 * session, projected through the enterprise service's lifecycle projector as a
 * `usage` event beside the run's lifecycle events, with the identities a fleet
 * joins cost on and the provenance of every figure.
 *
 * Two inputs meet here. `observe()` takes each usage report as the parser
 * extracted it (`ParsedEvent['usage']`, before `buildUsageStats` fills an
 * absent field with 0), so what the stream never carried is known to be
 * absent; `settle()` takes the total the host summed for the turn (the drained
 * per-turn ledger, a capture's usage) and the run's identities, and builds the
 * fact: `describeUsageProvenance()` for the figures, the agent's account
 * reference as the host resolves it from the real layers (a digest, never a
 * directory name), and the tenant and org the enrollment record names NOW,
 * kept on the fact as the attribution of record. A process that reported no
 * usage settles as `unavailable` with no counts; nothing invents a zero.
 *
 * Plain Node, no Electron: the service composes it over `events` and its
 * identity view. The desktop wiring (MCOMP-27-01) feeds `observeStats()` from
 * the process manager's `usage` stream and settles from the lifecycle facts
 * the agent-run capture already projects (`usageSettlingSink()`), so each
 * spawn's terminal fact (exit, supersede) settles one usage fact for that run,
 * under the provider and account the run itself had. Nothing here is billing
 * authority or a spool.
 */

import type { ManagedIdentityView } from '../../shared/maestro-lib/managed/endpoint-port';
import type {
	LifecycleAdmissionRef,
	LifecycleEventSink,
	LifecycleFact,
	LifecycleLineage,
	LifecycleRecord,
	LifecycleSurface,
	ManagedUsageEvent,
	UsageAttribution,
	UsageEventSink,
	UsageFact,
} from '../../shared/maestro-lib/managed/events';
import type { ManagedRunState } from '../../shared/maestro-lib/managed/types';
import { isTerminalRunState } from '../../shared/maestro-lib/managed/run-journal';
import { usageReportingFor } from '../../shared/maestro-lib/run/turn-capture';
import {
	describeUsageProvenance,
	UsageProvenanceTracker,
	type UsageObservation,
	type UsageReport,
} from '../../shared/maestro-lib/streaming/usage-accumulator';
import { addUsageStats } from '../../shared/maestro-lib/streaming/usage-totals';
import type { UsageStats } from '../../shared/types';

const presentAmount = (value: number | undefined): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * One emitted `UsageStats` (the process manager's `usage` event, already
 * delta-normalized) as a provenance report. The stats fill every field the
 * stream did not carry with 0, so the presence it lost is read back
 * conservatively: an optional count or a cost is reported only when it is
 * above zero. A reported zero thereby becomes null on the fact, never the
 * reverse: nothing absent is ever counted as reported. A context-window
 * replay is a correction, not a report.
 */
export function usageReportFromStats(stats: UsageStats): UsageReport {
	if (stats.contextWindowCorrectionOnly) {
		return { inputTokens: 0, outputTokens: 0, correctionOnly: true };
	}
	const cacheReadTokens = presentAmount(stats.cacheReadInputTokens);
	const cacheCreationTokens = presentAmount(stats.cacheCreationInputTokens);
	const reasoningTokens = presentAmount(stats.reasoningTokens);
	const costUsd = presentAmount(stats.totalCostUsd);
	return {
		inputTokens: Math.max(0, stats.inputTokens || 0),
		outputTokens: Math.max(0, stats.outputTokens || 0),
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(stats.contextWindowModel ? { model: stats.contextWindowModel } : {}),
		...(stats.contextWindowResolved === true ? { contextWindowReported: true } : {}),
	};
}

/** The tenant and org the record names now: a fact settled now is attributed to them, and stays so. Null with no readable record. */
export function usageAttributionOf(
	identity: Pick<ManagedIdentityView, 'status' | 'record'> | null
): UsageAttribution | null {
	const record = identity?.status === 'ok' ? identity.record : null;
	return record ? { tenantId: record.tenantId, orgId: record.orgId } : null;
}

/** The run a settle names. The same identities a lifecycle exit fact carries, plus the host's total. */
export interface UsageSettleInput {
	surface: LifecycleSurface;
	state: ManagedRunState;
	/** When the run settled, epoch milliseconds. Default now. */
	at?: number;
	sessionId: string;
	agentId: string;
	tabId: string | null;
	provider: string;
	model: string | null;
	providerSessionId: string | null;
	runId: string;
	record: LifecycleRecord;
	/** The turn's summed total as the host holds it; undefined when it summed nothing. */
	total: UsageStats | undefined;
	lineage?: LifecycleLineage;
	admission?: LifecycleAdmissionRef | null;
}

/** The fact one settle amounts to, pure: identities copied, figures described, account and attribution as given. */
export function buildUsageFact(
	input: UsageSettleInput,
	observed: UsageObservation,
	binding: { at: number; accountRef: string | null; attribution: UsageAttribution | null }
): UsageFact {
	return {
		surface: input.surface,
		state: input.state,
		at: binding.at,
		sessionId: input.sessionId,
		agentId: input.agentId,
		tabId: input.tabId,
		provider: input.provider,
		model: input.model,
		providerSessionId: input.providerSessionId,
		runId: input.runId,
		record: input.record,
		accountRef: binding.accountRef,
		attribution: binding.attribution,
		usage: describeUsageProvenance(observed, input.total, input.model),
		...(input.lineage ? { lineage: input.lineage } : {}),
		admission: input.admission ?? null,
	};
}

export interface UsageCaptureDeps {
	events: UsageEventSink;
	/** The host's identity custody as it stands when a run settles. */
	identity: () => Pick<ManagedIdentityView, 'status' | 'record'> | null;
	/** The opaque account reference of the agent a process runs as, from the agent's real layers (`resolveAgentAccountRef`); null when none. Never throws into a settle: a thrown resolver is `null`. */
	accountRef: (agent: { agentId: string; provider: string }) => string | null;
	now?: () => number;
	/** How many unsettled process sessions are tracked at once. Default 2000; the oldest is forgotten first. */
	capacity?: number;
}

export interface UsageCapture {
	/** One usage report from a process, as the parser extracted it, before normalization. */
	observe(sessionId: string, provider: string, report: UsageReport): void;
	/**
	 * One emitted `UsageStats` step (the process manager's `usage` event): its
	 * provenance report (`usageReportFromStats`) and its counts summed into the
	 * session's total, which `settle()` uses when its input names none. A
	 * correction-only replay is observed as a correction and never summed.
	 */
	observeStats(sessionId: string, provider: string, stats: UsageStats): void;
	/** The process ended: project its usage fact from what was observed and the host's total, and forget the session. */
	settle(input: UsageSettleInput): readonly ManagedUsageEvent[];
	/** Forget a session with no fact to settle (a supersede). */
	forget(sessionId: string): void;
	/** Unsettled sessions tracked right now. */
	size(): number;
}

const DEFAULT_CAPACITY = 2000;

/** No report ever arrived: what a settle describes for a process that stayed silent. */
const silence = (): UsageObservation => new UsageProvenanceTracker().summary();

export function createUsageCapture(deps: UsageCaptureDeps): UsageCapture {
	const now = deps.now ?? (() => Date.now());
	const capacity = Math.max(1, deps.capacity ?? DEFAULT_CAPACITY);
	// Keyed by the RAW process session id, as the per-turn ledger is: a forced
	// parallel turn and a normal one on the same tab are different processes.
	const trackers = new Map<string, UsageProvenanceTracker>();
	// The host-summed total per session, from `observeStats()` only.
	const totals = new Map<string, UsageStats>();

	function trackerFor(sessionId: string, provider: string): UsageProvenanceTracker {
		const existing = trackers.get(sessionId);
		if (existing) return existing;
		if (trackers.size >= capacity) {
			const oldest = trackers.keys().next();
			if (!oldest.done) {
				trackers.delete(oldest.value);
				totals.delete(oldest.value);
			}
		}
		const made = new UsageProvenanceTracker({ reporting: usageReportingFor(provider) });
		trackers.set(sessionId, made);
		return made;
	}

	return {
		observe(sessionId, provider, report) {
			trackerFor(sessionId, provider).observe(report);
		},
		observeStats(sessionId, provider, stats) {
			const report = usageReportFromStats(stats);
			trackerFor(sessionId, provider).observe(report);
			if (!report.correctionOnly)
				totals.set(sessionId, addUsageStats(totals.get(sessionId), stats));
		},
		settle(input) {
			const observed = trackers.get(input.sessionId)?.summary() ?? silence();
			const summed = totals.get(input.sessionId);
			trackers.delete(input.sessionId);
			totals.delete(input.sessionId);
			const settling = input.total === undefined && summed ? { ...input, total: summed } : input;
			let accountRef: string | null = null;
			try {
				accountRef = deps.accountRef({ agentId: settling.agentId, provider: settling.provider });
			} catch {
				// An account the host could not resolve is no account on the fact, not a failed settle.
			}
			const fact = buildUsageFact(settling, observed, {
				at: settling.at ?? now(),
				accountRef,
				attribution: usageAttributionOf(deps.identity()),
			});
			return deps.events.recordUsage(fact);
		},
		forget(sessionId) {
			trackers.delete(sessionId);
			totals.delete(sessionId);
		},
		size: () => trackers.size,
	};
}

/**
 * The lifecycle sink the agent-run capture is handed on a composed desktop:
 * every fact reaches `lifecycle` unchanged, and each terminal fact (an exit,
 * a supersede) of a surface that runs a model settles that run's usage with
 * the run's own provider, model, lineage and admission, so a retry, a swap
 * or a later account change is a separate fact under its own run. A shell
 * terminal has no model usage and settles nothing. A settle that fails never
 * disturbs the lifecycle path.
 */
export function usageSettlingSink(
	lifecycle: LifecycleEventSink,
	capture: Pick<UsageCapture, 'settle'>
): LifecycleEventSink {
	return {
		record(fact: LifecycleFact) {
			const events = lifecycle.record(fact);
			if (fact.surface !== 'terminal' && isTerminalRunState(fact.state)) {
				try {
					capture.settle({
						surface: fact.surface,
						state: fact.state,
						at: fact.at,
						sessionId: fact.sessionId,
						agentId: fact.agentId,
						tabId: fact.tabId,
						provider: fact.provider,
						model: fact.model,
						providerSessionId: fact.providerSessionId,
						runId: fact.runId,
						record: fact.record,
						total: undefined,
						...(fact.lineage ? { lineage: fact.lineage } : {}),
						admission: fact.admission ?? null,
					});
				} catch {
					// The usage fact is lost by name in the projector's refusal count, never the exit.
				}
			}
			return events;
		},
	};
}
