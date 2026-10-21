/**
 * The logical identity of an Auto Run turn, as attribution.
 *
 * An Auto Run is a workflow: a playbook (or a goal) run once, under one run id, as a sequence
 * of turns. Each turn is one task request. A request can be tried more than once (the effort
 * retry, a resume after an error pause), and a synopsis or a goal handoff resumes the session a
 * task turn left. A managed host admits each of those on exactly this lineage, so a broker's
 * receipt and the run journal join back to the workflow, the document, the request and the
 * attempt, instead of to an anonymous launch minted at the sink.
 *
 * Everything here is attribution, in the contract's own words (`ManagedRunIdentity`,
 * `ManagedWorkflowRef`): it says what the turn is, never that it may run. The owner fence
 * (`ownerEpoch`, `fencingToken`) is issued by a workflow owner producer and never here. A
 * workflow with no fence is carried as "no owner", and a managed sink refuses it rather than
 * inventing one or dropping the workflow to fit the launch-only path. The Auto Run's own
 * scheduling (its stall guard, its auto-resume, its watchdog) stays the Auto Run's: a re-dispatch
 * is a new attempt that is admitted again, never a decision carried over.
 *
 * Pure and serializable, so the desktop renderer, the library runner and the CLI share it.
 */

import { generateUUID } from '../../uuid';
import type { ManagedRunIdentity, ManagedWorkflowRef } from '../managed/types';
import type { AutoRunTurnPurpose } from './engine-types';

/** The Auto Run as a workflow: stable across loops, retries, resumes and a restart of the host. */
export interface AutoRunWorkflowIdentity {
	/** A playbook id or a goal run id. */
	workflowId: string;
	/** The version the run started from: the document set digest (`autoRunWorkflowVersion`) or a label. */
	version: string;
	/** What started the run (`autoRunTriggerEventId`): an operator action, a Cue event, a CLI invocation. */
	triggerEventId: string;
	/** One id for the whole Auto Run: the root of every turn's lineage. */
	runId: string;
}

/**
 * The owner fence of a workflow, as a workflow owner producer issued it (the CP-03 contract:
 * one owner per workflow, fenced across retries, restarts and offline holders). Never minted by
 * a turn runner or a renderer.
 */
export interface AutoRunOwnerFence {
	ownerEpoch: string;
	fencingToken: string;
}

export type AutoRunTriggerKind = 'operator' | 'cue' | 'cli' | 'api';

export interface AutoRunTurnAttribution {
	workflow: AutoRunWorkflowIdentity;
	purpose: AutoRunTurnPurpose;
	/** The playbook document the turn works on, or null for a goal turn. */
	document: string | null;
	/** 1-indexed loop number, when the engine knows it. */
	loopNumber: number | null;
	/** Per logical request: the task the turn is for. Fixed across its attempts. */
	requestId: string;
	idempotencyKey: string;
	/** Per try. The effort retry and a resume after a pause each get a fresh one. */
	attemptId: string;
	/** 1 for the first try. */
	attempt: number;
	/** This turn's own run id in the lineage tree. */
	turnRunId: string;
	/** The run this turn hangs under: the Auto Run, or for a synopsis and a handoff the task turn it resumes. */
	parentRunId: string;
}

export interface AutoRunTurnRequestInput {
	purpose: AutoRunTurnPurpose;
	document?: string | null;
	loopNumber?: number | null;
	/** For a synopsis or a handoff: the task turn whose session it resumes. */
	resumes?: Pick<AutoRunTurnAttribution, 'turnRunId'> | null;
	/** Id minting, injected by a test. Default `generateUUID`. */
	newId?: () => string;
}

/** A new logical request under the workflow: fresh request, idempotency key, attempt and turn run ids. */
export function newAutoRunTurnRequest(
	workflow: AutoRunWorkflowIdentity,
	input: AutoRunTurnRequestInput
): AutoRunTurnAttribution {
	const newId = input.newId ?? generateUUID;
	const requestId = newId();
	return {
		workflow,
		purpose: input.purpose,
		document: input.document ?? null,
		loopNumber: input.loopNumber ?? null,
		requestId,
		idempotencyKey: requestId,
		attemptId: newId(),
		attempt: 1,
		turnRunId: newId(),
		parentRunId: input.resumes?.turnRunId ?? workflow.runId,
	};
}

/** The same request tried again: a fresh attempt id, everything else kept. */
export function nextAutoRunAttempt(
	attribution: AutoRunTurnAttribution,
	newId: () => string = generateUUID
): AutoRunTurnAttribution {
	return { ...attribution, attemptId: newId(), attempt: attribution.attempt + 1 };
}

/** The contract's run identity for one attempt: the turn is a run under the Auto Run's root. */
export function autoRunRunIdentity(attribution: AutoRunTurnAttribution): ManagedRunIdentity {
	return {
		requestId: attribution.requestId,
		idempotencyKey: attribution.idempotencyKey,
		attemptId: attribution.attemptId,
		runId: attribution.turnRunId,
		rootRunId: attribution.workflow.runId,
		parentRunId: attribution.parentRunId,
	};
}

/**
 * The workflow reference a context carries, or null when the workflow has no owner fence. Null
 * is "unowned", which a managed sink refuses; it is never "no workflow".
 */
export function autoRunWorkflowRef(
	workflow: AutoRunWorkflowIdentity,
	fence: AutoRunOwnerFence | null
): ManagedWorkflowRef | null {
	if (!fence) return null;
	return {
		workflowId: workflow.workflowId,
		version: workflow.version,
		triggerEventId: workflow.triggerEventId,
		ownerEpoch: fence.ownerEpoch,
		fencingToken: fence.fencingToken,
	};
}

/** The trace id of one attempt, joining the host's log lines to the run and the request. */
export function autoRunTraceId(attribution: AutoRunTurnAttribution): string {
	return `autorun:${attribution.workflow.runId}:${attribution.requestId}:${attribution.attempt}`;
}

/** `operator:<when>`, `cue:<event id>`, `cli:<invocation>`: what started the run, as one id. */
export function autoRunTriggerEventId(kind: AutoRunTriggerKind, id: string | number): string {
	return `${kind}:${String(id)}`;
}

/**
 * A version label for the document set a run started from: FNV-1a over the ordered names, so
 * the same playbook gives the same version on every surface and nothing here needs `crypto`.
 */
export function autoRunWorkflowVersion(documents: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const char of documents.join('\n')) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `docs-${documents.length}-${hash.toString(16).padStart(8, '0')}`;
}
