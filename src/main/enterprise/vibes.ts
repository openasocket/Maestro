/**
 * VIBES evidence from what this host actually observed (MRC-10-05): the
 * sibling's recorded provenance profile (`mega-maestro.vibes-recorded.v1`,
 * `packages/contracts/src/assurance.ts` at d5143a6) built from the lifecycle
 * events the managed projector raised, and nothing else.
 *
 * A recorded VIBES graph is sessions, delegations, decisions, annotations and
 * the gaps between them. Maestro's real producers give it two of those: a
 * run's `run-state` events are a session's start and end (the VIBES
 * `session_id` is the recorded run; the agent name and provider are claims,
 * not identities), and the run tree the lineage carries (`parentRunId`) is
 * the delegation. Everything the profile asks for that this host never
 * observed is a named gap, never a filled-in value: no environment hash (the
 * launch environment is not hashed here), no assurance level, no decision
 * records (a managed `decision` event is an admission, not a VIBES decision),
 * a child whose parent start this window never saw, an end whose start was in
 * an earlier process. Annotation ids are the VIBES rule (SHA-256 of the
 * canonical JSON of the record without `annotation_id`), so the sibling's
 * `ingestRecordedProvenance` recomputes and matches them.
 *
 * What this is not: it holds no reasoning (the providers surface none and
 * nothing here promises it), it reads nothing from the private per-agent
 * recording, it signs nothing (`VIBES_ATTESTATION` says this host holds no
 * VIBES key; attestation is the endpoint capture's), and it claims no
 * conformance (`VIBES_CAPABILITY` reports the standard `unsupported` for this
 * host, with what the recorded profile does provide named beside it). The
 * graph leaves this host only as `vibes.annotations` content through
 * `content.ts`, which the `full_vibes` profile alone admits.
 */

import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import type { ManagedLifecycleEvent } from '../../shared/maestro-lib/managed/events';
import type { ManagedRunState } from '../../shared/maestro-lib/managed/types';

export const VIBES_RECORDED_PROFILE = 'mega-maestro.vibes-recorded.v1';
const TERMINAL: readonly ManagedRunState[] = ['completed', 'failed', 'cancelled'];
/** The profile's bound on each list; past it the graph stops and says so. */
export const VIBES_MAX_RECORDS = 10_000;

/** The VIBES annotation id: SHA-256 of the canonical JSON of the record without `annotation_id` (nulls retained). */
export function vibesAnnotationId(record: Record<string, unknown>): string {
	const { annotation_id: _omitted, ...hashable } = record;
	return createHash('sha256').update(canonicalJson(hashable), 'utf8').digest('hex');
}

export interface VibesSessionAnnotation {
	type: 'session';
	annotation_id: string;
	event: 'start' | 'end';
	session_id: string;
	parent_session_id: string | null;
	/** Claims the recording made, never IAM identities. */
	agent_name: string | null;
	agent_type: string | null;
	timestamp: string;
	/** Never computed here; its absence is a named gap. */
	environment_hash: null;
}

export interface VibesDelegationAnnotation {
	type: 'delegation';
	annotation_id: string;
	parent_session_id: string;
	child_session_id: string;
	timestamp: string;
	delegation_type: 'task';
}

export type VibesGapKind =
	| 'missing_reference'
	| 'missing_delegation'
	| 'missing_field'
	| 'missing_blob'
	| 'caller_reported_gap';

export interface VibesRecordedGraph {
	profile: typeof VIBES_RECORDED_PROFILE;
	executionAuthority: false;
	evolve: 'unsupported';
	sessions: readonly VibesSessionAnnotation[];
	delegations: readonly VibesDelegationAnnotation[];
	/** Always empty: this host records no VIBES decisions, and says so in `gaps`. */
	decisions: readonly never[];
	annotations: readonly (VibesSessionAnnotation | VibesDelegationAnnotation)[];
	gaps: readonly { kind: VibesGapKind; reference: string }[];
}

export interface VibesBuildOptions {
	/** What the projector's window no longer holds: reported as the caller's gap, never guessed around. */
	projectorGaps?: { dropped: number; refused: number };
}

const withId = <T extends { annotation_id: string }>(record: Omit<T, 'annotation_id'>): T =>
	({
		...record,
		annotation_id: vibesAnnotationId(record as Record<string, unknown>),
	}) as unknown as T;

/** The recorded graph of a window of lifecycle events: real starts, ends and the run tree, with every missing piece named. Pure. */
export function buildVibesRecordedGraph(
	events: readonly ManagedLifecycleEvent[],
	options: VibesBuildOptions = {}
): VibesRecordedGraph {
	const gaps: { kind: VibesGapKind; reference: string }[] = [];
	const gap = (kind: VibesGapKind, reference: string): void => {
		gaps.push({ kind, reference });
	};
	const starts = new Map<string, VibesSessionAnnotation>();
	const ends = new Map<string, VibesSessionAnnotation>();
	const parents = new Map<string, string>();
	let truncated = false;

	for (const event of events) {
		if (event.kind !== 'run-state' || !event.run) continue;
		const run = event.run;
		if (starts.size >= VIBES_MAX_RECORDS || ends.size >= VIBES_MAX_RECORDS) {
			truncated = true;
			break;
		}
		if (run.parentRunId && run.parentRunId !== run.runId) parents.set(run.runId, run.parentRunId);
		const base = {
			type: 'session' as const,
			session_id: run.runId,
			parent_session_id: run.parentRunId ?? null,
			agent_name: run.agentId || null,
			agent_type: event.source.provider || null,
			timestamp: event.occurredAt,
			environment_hash: null,
		};
		if (TERMINAL.includes(run.state)) {
			if (!ends.has(run.runId))
				ends.set(run.runId, withId<VibesSessionAnnotation>({ ...base, event: 'end' }));
		} else if (!starts.has(run.runId)) {
			starts.set(run.runId, withId<VibesSessionAnnotation>({ ...base, event: 'start' }));
		}
	}

	const sessions: VibesSessionAnnotation[] = [];
	for (const [runId, start] of starts) {
		sessions.push(start);
		// The profile asks for these on a start; this host never observed them.
		for (const field of ['environment_hash', 'assurance_level'])
			gap('missing_field', `${start.annotation_id}:${field}`);
		const end = ends.get(runId);
		if (end) sessions.push(end);
	}
	for (const [runId, end] of ends) {
		if (starts.has(runId)) continue;
		// An end whose start an earlier process saw: kept, and the start named missing.
		sessions.push(end);
		gap('missing_reference', `${runId}:start`);
	}

	const delegations: VibesDelegationAnnotation[] = [];
	for (const [child, parent] of parents) {
		const childStart = starts.get(child);
		if (!childStart) {
			gap('missing_delegation', child);
			continue;
		}
		if (!starts.has(parent)) gap('missing_reference', parent);
		delegations.push(
			withId<VibesDelegationAnnotation>({
				type: 'delegation',
				parent_session_id: parent,
				child_session_id: child,
				timestamp: childStart.timestamp,
				delegation_type: 'task',
			})
		);
	}

	gap('caller_reported_gap', 'decisions:not-recorded-by-this-host');
	if (truncated) gap('caller_reported_gap', `events:truncated-at-${VIBES_MAX_RECORDS}`);
	const projector = options.projectorGaps;
	if (projector && projector.dropped > 0)
		gap('caller_reported_gap', `projector-window:dropped-${projector.dropped}`);
	if (projector && projector.refused > 0)
		gap('caller_reported_gap', `projector-window:refused-${projector.refused}`);

	return {
		profile: VIBES_RECORDED_PROFILE,
		executionAuthority: false,
		evolve: 'unsupported',
		sessions,
		delegations,
		decisions: [],
		annotations: [...sessions, ...delegations],
		gaps,
	};
}

/** The graph's annotations as the recorded `annotations.jsonl`: one canonical JSON record per line, in graph order. */
export function vibesAnnotationsJsonl(graph: VibesRecordedGraph): string {
	return graph.annotations.map((record) => canonicalJson(record)).join('\n') + '\n';
}

/** The evidence the content capture takes under the `full_vibes` profile: the role, the bytes and their exact digest. */
export function vibesEvidenceOf(graph: VibesRecordedGraph): {
	role: 'vibes.annotations';
	text: string;
	sha256: string;
	byteLength: number;
} {
	const text = vibesAnnotationsJsonl(graph);
	const bytes = Buffer.from(text, 'utf8');
	return {
		role: 'vibes.annotations',
		text,
		sha256: createHash('sha256').update(bytes).digest('hex'),
		byteLength: bytes.byteLength,
	};
}

/** This host signs nothing: it holds no VIBES key and never will claim one; attestation belongs to the endpoint capture. */
export const VIBES_ATTESTATION = Object.freeze({
	state: 'unavailable' as const,
	reason: 'This host holds no VIBES signing key; attestation belongs to the endpoint capture.',
});

/**
 * The sibling `assuranceCapability` shape for THIS host: `unsupported` for the
 * standard (no normative pins, no manifest entries, no attestation, no
 * reasoning), with the recorded profile's actual production named beside it.
 */
export const VIBES_CAPABILITY = Object.freeze({
	standard: 'VIBES' as const,
	status: 'unsupported' as const,
	specificationVersion: null,
	wireVersions: [] as readonly string[],
	pins: [] as readonly never[],
	supported: [] as readonly string[],
	unsupported: [
		'normative_conformance',
		'manifest_entry_hashes',
		'attestation',
		'hidden_reasoning',
		'decision_records',
		'private_recording_reuse',
	] as readonly string[],
	fullConformance: false as const,
	recordedProfile: Object.freeze({
		profile: VIBES_RECORDED_PROFILE,
		produces: ['session', 'delegation'] as readonly string[],
		executionAuthority: false as const,
		evolve: 'unsupported' as const,
		admittedBy: 'full_vibes' as const,
	}),
});
