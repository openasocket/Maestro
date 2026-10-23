/**
 * Typed runtime commands (MRC-11-01): what a management peer may tell this
 * runtime to do, how a command is bound to the run, process epoch, actor and
 * policy generation it names, and the durable ledger that keeps one command
 * from acting twice.
 *
 * The vocabulary is the endpoint's own, transcribed: the signed fleet command
 * actions (`pause_run`, `resume_run`, `cancel_run`, `operator_prompt`) and the
 * local socket's control actions (`cancel_run`, `refresh_policy`,
 * `report_status`), each requiring the capability `command-<action>`. There
 * is no executable, shell, URL or arbitrary method name on purpose: a command
 * is one of six typed actions on a pinned run, or it is invalid input.
 *
 * The lifecycle is the published one: verify, look the id up in history
 * (a replay is refused, a duplicate answers what it already answered), bind,
 * ACCEPT durably before any effect, re-bind (a failed recheck burns the id),
 * dispatch inside the five-second window, settle. `accepted`, `completed`
 * and `unknown` stay distinct all the way out: a port that requested an
 * effect and did not see it end answers `accepted`; a port that threw leaves
 * the record `unknown`, and nothing retries it.
 *
 * An operator prompt is separately approved: the command must carry an
 * `approved` approval bound to its payload digest, a `prompt` port must be
 * composed, and the text goes to that port and nowhere else. The ledger keeps
 * digests, never the text. Nothing here injects anything into a model.
 *
 * Plain Node: no Electron, no `src/main`, no endpoint package. The desktop
 * composes the ports over its real sinks in `src/main/enterprise/commands.ts`.
 */

import { canonicalJson } from '../../canonicalJson';
import { sha256Hex } from './authority';
import type { ManagedInstallationIdentity } from './types';

export const MANAGED_COMMAND_LEDGER_FILE_NAME = 'maestro-managed-commands.json';
/** The endpoint's `commandExecutionMaximumWindowMs`: an accepted command dispatches within it or not at all. */
export const COMMAND_DISPATCH_WINDOW_MS = 5_000;
export const MAX_OPERATOR_PROMPT_LENGTH = 8_192;

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

export type ManagedCommandKind =
	| 'pause-run'
	| 'resume-run'
	| 'cancel-run'
	| 'report-status'
	| 'refresh-policy'
	| 'operator-prompt';

export const MANAGED_COMMAND_KINDS: readonly ManagedCommandKind[] = [
	'pause-run',
	'resume-run',
	'cancel-run',
	'report-status',
	'refresh-policy',
	'operator-prompt',
];

/** The endpoint's name for each action; its preconditions require the capability `command-<action>`. */
export const ENDPOINT_COMMAND_ACTIONS: Readonly<Record<ManagedCommandKind, string>> = {
	'pause-run': 'pause_run',
	'resume-run': 'resume_run',
	'cancel-run': 'cancel_run',
	'report-status': 'report_status',
	'refresh-policy': 'refresh_policy',
	'operator-prompt': 'operator_prompt',
};

export function commandCapability(kind: ManagedCommandKind): string {
	return `command-${ENDPOINT_COMMAND_ACTIONS[kind]}`;
}

export function commandKindOfAction(action: unknown): ManagedCommandKind | null {
	return MANAGED_COMMAND_KINDS.find((kind) => ENDPOINT_COMMAND_ACTIONS[kind] === action) ?? null;
}

export type ManagedCommandAction =
	| { kind: 'pause-run' }
	| { kind: 'resume-run' }
	| { kind: 'cancel-run' }
	| { kind: 'report-status' }
	| { kind: 'refresh-policy'; desiredRevision: number }
	| { kind: 'operator-prompt'; text: string; agentInput: true };

/** Who the command is for: this installation, this process, this actor's registration, this run. */
export interface ManagedCommandRecipient {
	actorId: string;
	enrollmentId: string;
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	/** Null for a command on the runtime itself (a status report, a policy refresh). */
	runId: string | null;
}

export interface ManagedCommandPreconditions {
	policyRevision: number;
	requiredCapability: string;
	policyDigest: string | null;
	bindingDigest: string | null;
}

export type ManagedCommandApproval =
	| { kind: 'policy-not-required'; policyRevision: number }
	| {
			kind: 'approved';
			approvalId: string;
			approverId: string;
			payloadDigest: string;
			expiresAt: string;
	  };

/**
 * A command as this runtime receives it from its verified endpoint port: the
 * signed payload's fields without the signature (the endpoint verifies the
 * key; a runtime never learns command trust from an envelope) and the release
 * id the delivery carried. Serializable; nothing in it is authority.
 */
export interface ManagedRuntimeCommand {
	commandId: string;
	tenantId: string;
	issuerId: string;
	recipient: ManagedCommandRecipient;
	action: ManagedCommandAction;
	preconditions: ManagedCommandPreconditions;
	approval: ManagedCommandApproval;
	issuedAt: string;
	expiresAt: string;
	nonce: string;
	idempotencyKey: string;
	/** The digest the issuer signed over the payload; the ledger and the approval bind to it. */
	payloadDigest: string;
	releaseId: string | null;
}

const MAX_ID = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;
const isDigest = (value: unknown): value is string =>
	typeof value === 'string' && DIGEST.test(value);
const isTimestamp = (value: unknown): value is string =>
	typeof value === 'string' && Number.isFinite(Date.parse(value));
const isRevision = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

function actionProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['action is not an object'];
	const problems: string[] = [];
	const kind = value.kind;
	if (!MANAGED_COMMAND_KINDS.includes(kind as ManagedCommandKind)) {
		return [`action.kind "${String(kind)}" is not a typed command`];
	}
	const keys = Object.keys(value).filter((key) => key !== 'kind');
	if (kind === 'refresh-policy') {
		if (!isRevision(value.desiredRevision))
			problems.push('action.desiredRevision is not a revision');
		if (keys.some((key) => key !== 'desiredRevision')) problems.push('action carries unknown keys');
	} else if (kind === 'operator-prompt') {
		const text = value.text;
		if (typeof text !== 'string' || text.length === 0 || text.length > MAX_OPERATOR_PROMPT_LENGTH) {
			problems.push(`action.text is not 1 to ${MAX_OPERATOR_PROMPT_LENGTH} characters`);
		}
		if (value.agentInput !== true) problems.push('action.agentInput is not true');
		if (keys.some((key) => key !== 'text' && key !== 'agentInput')) {
			problems.push('action carries unknown keys');
		}
	} else if (keys.length > 0) problems.push('action carries unknown keys');
	return problems;
}

/** Structural problems with a value offered as a command. Empty means the shape is right; it says nothing about authority. */
export function managedCommandProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['command is not an object'];
	const problems: string[] = [];
	for (const key of ['commandId', 'tenantId', 'issuerId', 'nonce', 'idempotencyKey'] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	if (!isDigest(value.payloadDigest)) problems.push('payloadDigest is not a digest');
	if (value.releaseId !== null && !isId(value.releaseId))
		problems.push('releaseId is not an id or null');
	const recipient = value.recipient;
	if (!isRecord(recipient)) problems.push('recipient is not an object');
	else {
		for (const key of [
			'actorId',
			'enrollmentId',
			'installationId',
			'runtimeId',
			'processEpoch',
		] as const) {
			if (!isId(recipient[key])) problems.push(`recipient.${key} is not an id`);
		}
		if (recipient.runId !== null && !isId(recipient.runId)) {
			problems.push('recipient.runId is not an id or null');
		}
	}
	problems.push(...actionProblems(value.action));
	const pre = value.preconditions;
	if (!isRecord(pre)) problems.push('preconditions is not an object');
	else {
		if (!isRevision(pre.policyRevision))
			problems.push('preconditions.policyRevision is not a revision');
		if (!isId(pre.requiredCapability))
			problems.push('preconditions.requiredCapability is not an id');
		for (const key of ['policyDigest', 'bindingDigest'] as const) {
			if (pre[key] !== null && !isDigest(pre[key]))
				problems.push(`preconditions.${key} is not a digest or null`);
		}
	}
	const approval = value.approval;
	if (!isRecord(approval)) problems.push('approval is not an object');
	else if (approval.kind === 'policy-not-required') {
		if (!isRevision(approval.policyRevision))
			problems.push('approval.policyRevision is not a revision');
	} else if (approval.kind === 'approved') {
		if (!isId(approval.approvalId)) problems.push('approval.approvalId is not an id');
		if (!isId(approval.approverId)) problems.push('approval.approverId is not an id');
		if (!isDigest(approval.payloadDigest)) problems.push('approval.payloadDigest is not a digest');
		if (!isTimestamp(approval.expiresAt)) problems.push('approval.expiresAt is not a timestamp');
	} else problems.push('approval.kind is unknown');
	if (!isTimestamp(value.issuedAt)) problems.push('issuedAt is not a timestamp');
	if (!isTimestamp(value.expiresAt)) problems.push('expiresAt is not a timestamp');
	else if (
		isTimestamp(value.issuedAt) &&
		Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
	) {
		problems.push('expiresAt does not follow issuedAt');
	}
	return problems;
}

// ---------------------------------------------------------------------------
// Binding: the command names THIS run, process, actor and policy, now
// ---------------------------------------------------------------------------

export type CommandRefusal =
	| 'invalid-input'
	| 'unauthenticated'
	| 'stale-run'
	| 'policy-denied'
	| 'expired'
	| 'unsupported-capability'
	| 'approval-required'
	| 'replay';

/** What this host is right now, read fresh for every check; never cached across a standing change. */
export interface CommandBinding {
	installation: ManagedInstallationIdentity;
	/** `ok` when the host holds a registered, attached, managed standing; else why not. */
	standing: { ok: true } | { ok: false; reason: string };
	/** The actor the endpoint registered this process for; null when the registration names none. */
	actorId: string | null;
	enrollmentId: string | null;
	tenantId: string | null;
	policyRevision: number | null;
	/** What this host knows of a run: a live one, one that ended, or nothing. */
	runState(runId: string): 'live' | 'ended' | 'unknown';
	now: number;
}

export function commandBindingProblem(
	command: ManagedRuntimeCommand,
	binding: CommandBinding,
	capabilities: readonly string[]
): { reason: CommandRefusal; detail: string } | null {
	const r = command.recipient;
	const i = binding.installation;
	const refuse = (reason: CommandRefusal, detail: string) => ({ reason, detail });
	if (binding.tenantId === null || command.tenantId !== binding.tenantId) {
		return refuse('stale-run', 'the command names another tenant');
	}
	if (binding.enrollmentId === null || r.enrollmentId !== binding.enrollmentId) {
		return refuse('stale-run', 'the command names another enrollment');
	}
	if (r.installationId !== i.installationId || r.runtimeId !== i.runtimeId) {
		return refuse('stale-run', 'the command names another installation or runtime');
	}
	if (r.processEpoch !== i.processEpoch) {
		return refuse('stale-run', 'the command names another process epoch');
	}
	if (binding.actorId === null) {
		return refuse('unauthenticated', 'the registration this process holds names no actor');
	}
	if (r.actorId !== binding.actorId) {
		return refuse('unauthenticated', 'the command names an actor other than the registered one');
	}
	const required = commandCapability(command.action.kind);
	if (command.preconditions.requiredCapability !== required || !capabilities.includes(required)) {
		return refuse('unsupported-capability', `this host does not execute ${required}`);
	}
	if (
		binding.policyRevision === null ||
		command.preconditions.policyRevision !== binding.policyRevision
	) {
		return refuse(
			'policy-denied',
			`the command binds policy revision ${command.preconditions.policyRevision}; this host applies ${binding.policyRevision ?? 'none'}`
		);
	}
	if (
		command.approval.kind === 'policy-not-required' &&
		command.approval.policyRevision !== command.preconditions.policyRevision
	) {
		return refuse('policy-denied', 'the approval exemption binds another policy revision');
	}
	if (command.action.kind === 'operator-prompt') {
		if (command.approval.kind !== 'approved') {
			return refuse('approval-required', 'an operator prompt runs only under a separate approval');
		}
		if (command.approval.payloadDigest !== command.payloadDigest) {
			return refuse('approval-required', 'the approval does not bind this payload');
		}
	}
	const now = binding.now;
	if (
		Date.parse(command.issuedAt) > now ||
		Date.parse(command.expiresAt) <= now ||
		(command.approval.kind === 'approved' && Date.parse(command.approval.expiresAt) <= now)
	) {
		return refuse('expired', 'the command or its approval is outside its validity window');
	}
	const onRun = command.action.kind !== 'report-status' && command.action.kind !== 'refresh-policy';
	if (onRun && r.runId === null) return refuse('invalid-input', 'the action names no run');
	if (r.runId !== null && binding.runState(r.runId) === 'unknown') {
		return refuse('stale-run', `this host knows no run ${r.runId}`);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Effects and evidence (the published settlement vocabulary)
// ---------------------------------------------------------------------------

export type CommandSettledOutcome = 'completed' | 'failed' | 'no-effect';
export type CommandUncertainReason =
	| 'owner-lost'
	| 'transport-lost'
	| 'deadline-elapsed'
	| 'recovery-required';

export type CommandEffect =
	| { state: 'settled'; outcome: CommandSettledOutcome; evidenceDigest: string }
	| { state: 'uncertain'; reason: CommandUncertainReason };

/** What the ledger settles on: a published effect, or the refusal a failed recheck burned the id on. */
export type CommandSettlement =
	| CommandEffect
	| { state: 'denied'; reason: CommandRefusal; evidenceDigest: string };

/** The digest a settlement carries: over the command id, the kind, the outcome and the facts the port reported. */
export function commandEvidenceDigest(input: {
	commandId: string;
	kind: ManagedCommandKind;
	outcome: CommandSettledOutcome;
	facts?: unknown;
}): string {
	return sha256Hex(canonicalJson({ ...input, facts: input.facts ?? null }));
}
