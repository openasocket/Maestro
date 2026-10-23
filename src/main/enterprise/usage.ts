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
 * identity view; the wiring from the process manager's stream and exit is the
 * bounded continuation. Nothing here is billing authority or a spool.
 */

import type { ManagedIdentityView } from '../../shared/maestro-lib/managed/endpoint-port';
import type {
	LifecycleAdmissionRef,
	LifecycleLineage,
	LifecycleRecord,
	LifecycleSurface,
	ManagedUsageEvent,
	UsageAttribution,
	UsageEventSink,
	UsageFact,
} from '../../shared/maestro-lib/managed/events';
import type { ManagedRunState } from '../../shared/maestro-lib/managed/types';
import { usageReportingFor } from '../../shared/maestro-lib/run/turn-capture';
import {
	describeUsageProvenance,
	UsageProvenanceTracker,
	type UsageObservation,
	type UsageReport,
} from '../../shared/maestro-lib/streaming/usage-accumulator';
import type { UsageStats } from '../../shared/types';

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

	function trackerFor(sessionId: string, provider: string): UsageProvenanceTracker {
		const existing = trackers.get(sessionId);
		if (existing) return existing;
		if (trackers.size >= capacity) {
			const oldest = trackers.keys().next();
			if (!oldest.done) trackers.delete(oldest.value);
		}
		const made = new UsageProvenanceTracker({ reporting: usageReportingFor(provider) });
		trackers.set(sessionId, made);
		return made;
	}

	return {
		observe(sessionId, provider, report) {
			trackerFor(sessionId, provider).observe(report);
		},
		settle(input) {
			const observed = trackers.get(input.sessionId)?.summary() ?? silence();
			trackers.delete(input.sessionId);
			let accountRef: string | null = null;
			try {
				accountRef = deps.accountRef({ agentId: input.agentId, provider: input.provider });
			} catch {
				// An account the host could not resolve is no account on the fact, not a failed settle.
			}
			const fact = buildUsageFact(input, observed, {
				at: input.at ?? now(),
				accountRef,
				attribution: usageAttributionOf(deps.identity()),
			});
			return deps.events.recordUsage(fact);
		},
		forget(sessionId) {
			trackers.delete(sessionId);
		},
		size: () => trackers.size,
	};
}
