/**
 * The renderer side of the one host create/edit operation (`sessions:commitAgent`,
 * MCOMP-23-02A).
 *
 * A new, cloned, imported or edited agent is never inserted into (or changed in)
 * the renderer store first and persisted afterwards: the record goes to the
 * desktop host, which checks it exactly as it will be stored, and the caller
 * applies the CANONICAL record the host answers with. A refusal changes nothing,
 * so the form that asked keeps its draft and can show the reasons by field.
 *
 * Standalone (unmanaged) hosts admit every well-formed record, so the only
 * difference there is that the record is durable before it appears.
 */

import type { Session } from '../types';
import type { DesktopAuthoringOperation } from '../../shared/maestro-lib/managed/desktop-contract';
import type { ManagedAgentFieldRefusal } from '../../shared/maestro-lib/managed/agent-policy';
import { applyAgentConfigEdit } from '../../shared/sessionPersistenceMerge';
import {
	prepareSessionForPersistence,
	SESSION_PERSISTENCE_BASELINE_EVENT,
} from '../hooks/utils/useDebouncedPersistence';

/** Mirrors `AgentCommitRequest` in src/main/ipc/handlers/persistence.ts. */
export interface AgentCommitRequest {
	operation: DesktopAuthoringOperation;
	record: Record<string, unknown>;
	expectedPolicyRevision?: number | null;
	execution?: { credentials?: readonly string[]; permission?: string; transport?: string };
}

export type AgentCommitRefusalCode =
	| 'invalid'
	| 'conflict'
	| 'locked'
	| 'unavailable'
	| 'stale'
	| 'operation'
	| 'field';

export interface AgentCommitRefusal {
	ok: false;
	code: AgentCommitRefusalCode;
	reason: string;
	policyRevision: number | null;
	fields: ManagedAgentFieldRefusal[];
	locked?: string[];
}

/** Mirrors `AgentCommitOutcome` in src/main/ipc/handlers/persistence.ts. */
export type AgentCommitOutcome =
	| { ok: true; record: Record<string, unknown>; managed: boolean; policyRevision: number | null }
	| AgentCommitRefusal;

export interface AgentCommitOptions {
	expectedPolicyRevision?: number | null;
	execution?: AgentCommitRequest['execution'];
}

/** A refused commit, thrown by callers whose contract is "throw on failure" (the edit dialog). */
export class AgentCommitRefusedError extends Error {
	readonly refusal: AgentCommitRefusal;
	constructor(refusal: AgentCommitRefusal) {
		super(describeAgentCommitRefusal(refusal));
		this.name = 'AgentCommitRefusedError';
		this.refusal = refusal;
	}
}

/** One line naming the refusal and every refused field. */
export function describeAgentCommitRefusal(refusal: AgentCommitRefusal): string {
	const fields = refusal.fields.map((field) => `${field.field}: ${field.reason}`);
	return fields.length > 0 ? `${refusal.reason} (${fields.join('; ')})` : refusal.reason;
}

/**
 * Fields persistence strips (see `prepareSessionForPersistence`). The host never
 * sees them, so the record it returns cannot carry them; a new agent keeps the
 * draft's empty runtime values for exactly these and nothing else.
 */
const RUNTIME_ONLY_FIELDS = [
	'closedTabHistory',
	'unifiedClosedTabHistory',
	'orphanedThinkingTabs',
	'filePreviewHistory',
] as const;

/** Ask the host to commit one record. Never throws for a refusal; returns it. */
export async function commitAgentRecord(
	operation: DesktopAuthoringOperation,
	session: Session,
	options: AgentCommitOptions = {}
): Promise<AgentCommitOutcome> {
	const api = window.maestro?.sessions;
	if (!api?.commitAgent) {
		return {
			ok: false,
			code: 'unavailable',
			reason: 'This Maestro host cannot commit agent records.',
			policyRevision: null,
			fields: [],
		};
	}
	const request: AgentCommitRequest = {
		operation,
		record: prepareSessionForPersistence(session) as unknown as Record<string, unknown>,
		...(options.expectedPolicyRevision !== undefined && {
			expectedPolicyRevision: options.expectedPolicyRevision,
		}),
		...(options.execution && { execution: options.execution }),
	};
	return api.commitAgent(request);
}

/**
 * The session a newly committed agent enters the store as: the host's record,
 * plus only the runtime-only fields persistence strips. Registers the record as
 * the persistence baseline, so the next flush is an update the host can merge
 * (a web-desktop save without one is refused).
 */
export function sessionFromCommittedRecord(
	draft: Session,
	record: Record<string, unknown>
): Session {
	const session: Record<string, unknown> = { ...record };
	for (const field of RUNTIME_ONLY_FIELDS) {
		if (session[field] === undefined && draft[field] !== undefined) session[field] = draft[field];
	}
	window.dispatchEvent(
		new CustomEvent(SESSION_PERSISTENCE_BASELINE_EVENT, { detail: [structuredClone(record)] })
	);
	return session as unknown as Session;
}

/**
 * Apply an admitted edit to the live session: configuration only (rows, live
 * and per-client fields are kept), with the CANONICAL value for every field the
 * edit or the host record names; a field the host record no longer holds is
 * cleared.
 */
export function applyCommittedEdit(
	live: Session,
	sent: Session,
	record: Record<string, unknown>
): Session {
	const prepared = prepareSessionForPersistence(sent) as unknown as Record<string, unknown>;
	const edit: Record<string, unknown> = {};
	for (const field of new Set([...Object.keys(prepared), ...Object.keys(record)])) {
		edit[field] = record[field];
	}
	return applyAgentConfigEdit(
		live as unknown as Record<string, unknown>,
		edit
	) as unknown as Session;
}
