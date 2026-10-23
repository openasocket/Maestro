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
import { readStoreDocument, STORE_SCHEMA_KEY, writeStoreDocument } from '../store/io';
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

// ---------------------------------------------------------------------------
// The ledger: durable idempotency, one record per command id
// ---------------------------------------------------------------------------

export type CommandLedgerState =
	| 'accepted'
	| 'completed'
	| 'failed'
	| 'no-effect'
	| 'denied'
	| 'unknown';

export interface CommandLedgerRecord {
	commandId: string;
	idempotencyKey: string;
	nonce: string;
	payloadDigest: string;
	releaseId: string | null;
	kind: ManagedCommandKind;
	runId: string | null;
	actorId: string;
	policyRevision: number;
	acceptedAt: string;
	dispatchedAt: string | null;
	settledAt: string | null;
	state: CommandLedgerState;
	/** The refusal a burned id settled on; null unless denied. */
	refusal: CommandRefusal | null;
	evidenceDigest: string | null;
	/** Why it is uncertain, or a port's safe detail. Never command text. */
	detail: string | null;
}

export interface CommandLedgerDocument {
	[STORE_SCHEMA_KEY]: number;
	commands: CommandLedgerRecord[];
}

export type CommandAcceptance =
	| { disposition: 'accepted'; record: CommandLedgerRecord }
	| { disposition: 'duplicate'; record: CommandLedgerRecord }
	| { disposition: 'replay'; record: CommandLedgerRecord };

export type CommandLedgerLoad =
	| { ok: true; commands: number; recoveredUnknown: number }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

export interface CommandLedger {
	readonly file: string | null;
	/** Read the file; an `accepted` record from an earlier process becomes `unknown`. Once, first. */
	load(): Promise<CommandLedgerLoad>;
	accept(command: ManagedRuntimeCommand): Promise<CommandAcceptance>;
	markDispatched(commandId: string): Promise<CommandLedgerRecord | null>;
	settle(
		commandId: string,
		effect: CommandSettlement,
		detail?: string | null
	): Promise<CommandLedgerRecord | null>;
	get(commandId: string): CommandLedgerRecord | null;
	list(): readonly CommandLedgerRecord[];
	/** Accepted, not yet settled. */
	open(): readonly CommandLedgerRecord[];
}

export interface CommandLedgerDeps {
	/** Absent: in memory only (a test, a one-shot host). */
	file?: string;
	now(): number;
	/** Oldest settled records go first; an open one is never dropped. Default 2000. */
	maxCommands?: number;
}

const DEFAULT_MAX_COMMANDS = 2_000;
const SETTLED: readonly CommandLedgerState[] = [
	'completed',
	'failed',
	'no-effect',
	'denied',
	'unknown',
];

export function createCommandLedger(deps: CommandLedgerDeps): CommandLedger {
	const maxCommands = deps.maxCommands ?? DEFAULT_MAX_COMMANDS;
	let doc: CommandLedgerDocument = { [STORE_SCHEMA_KEY]: 1, commands: [] };
	let loaded = deps.file === undefined;
	const byId = new Map<string, CommandLedgerRecord>();
	const iso = (): string => new Date(deps.now()).toISOString();

	function index(): void {
		byId.clear();
		for (const record of doc.commands) byId.set(record.commandId, record);
	}

	async function persist(): Promise<void> {
		if (!loaded) throw new Error('The command ledger was not loaded.');
		if (doc.commands.length > maxCommands) {
			let excess = doc.commands.length - maxCommands;
			doc.commands = doc.commands.filter((record) => {
				if (excess > 0 && SETTLED.includes(record.state)) {
					excess -= 1;
					return false;
				}
				return true;
			});
			index();
		}
		if (deps.file) await writeStoreDocument(deps.file, doc);
	}

	return {
		file: deps.file ?? null,

		async load() {
			if (!deps.file) return { ok: true, commands: 0, recoveredUnknown: 0 };
			const read = await readStoreDocument<CommandLedgerDocument>(deps.file, (value) =>
				Array.isArray(value.commands) ? null : 'commands is not an array'
			);
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return { ok: false, reason: read.status, file: deps.file, message: read.reason };
			}
			doc = read.status === 'ok' ? read.data : { [STORE_SCHEMA_KEY]: 1, commands: [] };
			index();
			loaded = true;
			let recoveredUnknown = 0;
			for (const record of doc.commands) {
				if (record.state !== 'accepted') continue;
				record.state = 'unknown';
				record.settledAt = iso();
				record.detail = 'The host restarted while this command was accepted.';
				recoveredUnknown += 1;
			}
			if (recoveredUnknown > 0 || read.status === 'missing') await persist();
			return { ok: true, commands: doc.commands.length, recoveredUnknown };
		},

		async accept(command) {
			if (!loaded) throw new Error('The command ledger was not loaded.');
			const prior = byId.get(command.commandId);
			if (prior) {
				return {
					disposition: prior.payloadDigest === command.payloadDigest ? 'duplicate' : 'replay',
					record: prior,
				};
			}
			// Nonce and idempotency key are enrollment-wide: another id reusing one is a replay.
			const reused = doc.commands.find(
				(record) =>
					record.idempotencyKey === command.idempotencyKey || record.nonce === command.nonce
			);
			if (reused) return { disposition: 'replay', record: reused };
			const record: CommandLedgerRecord = {
				commandId: command.commandId,
				idempotencyKey: command.idempotencyKey,
				nonce: command.nonce,
				payloadDigest: command.payloadDigest,
				releaseId: command.releaseId,
				kind: command.action.kind,
				runId: command.recipient.runId,
				actorId: command.recipient.actorId,
				policyRevision: command.preconditions.policyRevision,
				acceptedAt: iso(),
				dispatchedAt: null,
				settledAt: null,
				state: 'accepted',
				refusal: null,
				evidenceDigest: null,
				detail: null,
			};
			doc.commands.push(record);
			byId.set(record.commandId, record);
			await persist();
			return { disposition: 'accepted', record };
		},

		async markDispatched(commandId) {
			const record = byId.get(commandId);
			if (!record) return null;
			if (record.state === 'accepted' && record.dispatchedAt === null) {
				record.dispatchedAt = iso();
				await persist();
			}
			return record;
		},

		async settle(commandId, effect, detail = null) {
			const record = byId.get(commandId);
			if (!record) return null;
			if (record.state !== 'accepted') return record;
			if (effect.state === 'settled') {
				record.state = effect.outcome;
				record.evidenceDigest = effect.evidenceDigest;
				record.detail = detail;
			} else if (effect.state === 'denied') {
				record.state = 'denied';
				record.refusal = effect.reason;
				record.evidenceDigest = effect.evidenceDigest;
				record.detail = detail;
			} else {
				record.state = 'unknown';
				record.detail = detail ?? effect.reason;
			}
			record.settledAt = iso();
			await persist();
			return record;
		},

		get: (commandId) => byId.get(commandId) ?? null,
		list: () => doc.commands,
		open: () => doc.commands.filter((record) => record.state === 'accepted'),
	};
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

/**
 * What a port answers. `accepted` means the effect was requested and its end
 * will be reported through `CommandExecutor.settle` (a stop whose exit comes
 * later); the three settled outcomes mean the port saw the effect through.
 * `facts` is metadata the evidence digest covers; never content.
 */
export interface CommandPortAnswer {
	outcome: CommandSettledOutcome | 'accepted';
	detail?: string;
	facts?: unknown;
}

/** The sinks a host composes. A port that is absent makes its command `unsupported-capability`, by name. */
export interface CommandPorts {
	pause?(runId: string, command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
	resume?(runId: string, command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
	cancel?(runId: string, command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
	report?(command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
	refresh?(desiredRevision: number, command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
	/** The one path an operator prompt reaches a run by; composed only where the host admits agent input. */
	prompt?(text: string, runId: string, command: ManagedRuntimeCommand): Promise<CommandPortAnswer>;
}

export type CommandExecution =
	| {
			status: 'accepted' | CommandSettledOutcome | 'unknown';
			commandId: string;
			/** The ledger already held this command; nothing ran again. */
			duplicate: boolean;
			evidenceDigest: string | null;
			detail: string | null;
			facts: unknown;
	  }
	| { status: 'denied'; commandId: string | null; reason: CommandRefusal; detail: string }
	| { status: 'unavailable'; commandId: string | null; detail: string };

export interface CommandExecutor {
	/** The `command-<action>` capabilities the composed ports execute. */
	capabilities(): readonly string[];
	execute(raw: unknown): Promise<CommandExecution>;
	/** A port's requested effect ended: settle the accepted record. */
	settle(
		commandId: string,
		effect: CommandEffect,
		detail?: string
	): Promise<CommandLedgerRecord | null>;
}

export interface CommandExecutorDeps {
	ledger: CommandLedger;
	binding(): CommandBinding;
	ports: CommandPorts;
	now(): number;
	dispatchWindowMs?: number;
}

const PORT_OF: Readonly<Record<ManagedCommandKind, keyof CommandPorts>> = {
	'pause-run': 'pause',
	'resume-run': 'resume',
	'cancel-run': 'cancel',
	'report-status': 'report',
	'refresh-policy': 'refresh',
	'operator-prompt': 'prompt',
};

export function createCommandExecutor(deps: CommandExecutorDeps): CommandExecutor {
	const windowMs = deps.dispatchWindowMs ?? COMMAND_DISPATCH_WINDOW_MS;
	const capabilities = (): string[] =>
		MANAGED_COMMAND_KINDS.filter((kind) => typeof deps.ports[PORT_OF[kind]] === 'function').map(
			commandCapability
		);

	const stateOf = (record: CommandLedgerRecord, duplicate: boolean): CommandExecution =>
		record.state === 'denied'
			? {
					status: 'denied',
					commandId: record.commandId,
					reason: record.refusal ?? 'policy-denied',
					detail: record.detail ?? '',
				}
			: {
					status: record.state,
					commandId: record.commandId,
					duplicate,
					evidenceDigest: record.evidenceDigest,
					detail: record.detail,
					facts: null,
				};

	async function run(
		command: ManagedRuntimeCommand,
		record: CommandLedgerRecord
	): Promise<CommandExecution> {
		const { commandId } = command;
		const kind = command.action.kind;
		const denyBurned = async (
			reason: CommandRefusal,
			detail: string
		): Promise<CommandExecution> => {
			// A failed recheck burns the id: the record settles as denied, never retried.
			const evidenceDigest = commandEvidenceDigest({
				commandId,
				kind,
				outcome: 'no-effect',
				facts: { reason },
			});
			await deps.ledger.settle(commandId, { state: 'denied', reason, evidenceDigest }, detail);
			return { status: 'denied', commandId, reason, detail };
		};
		const recheck = commandBindingProblem(command, deps.binding(), capabilities());
		if (recheck) return denyBurned(recheck.reason, recheck.detail);
		if (deps.now() - Date.parse(record.acceptedAt) > windowMs) {
			await deps.ledger.settle(commandId, { state: 'uncertain', reason: 'deadline-elapsed' });
			return {
				status: 'unknown',
				commandId,
				duplicate: false,
				evidenceDigest: null,
				detail: 'the dispatch window elapsed after acceptance',
				facts: null,
			};
		}
		const port = deps.ports[PORT_OF[kind]] as
			| ((...args: unknown[]) => Promise<CommandPortAnswer>)
			| undefined;
		if (!port)
			return denyBurned('unsupported-capability', `no port executes ${commandCapability(kind)}`);
		await deps.ledger.markDispatched(commandId);
		let answer: CommandPortAnswer;
		try {
			const { action, recipient } = command;
			answer =
				action.kind === 'refresh-policy'
					? await port(action.desiredRevision, command)
					: action.kind === 'report-status'
						? await port(command)
						: action.kind === 'operator-prompt'
							? await port(action.text, recipient.runId, command)
							: await port(recipient.runId, command);
		} catch (error) {
			const detail = `the port failed after dispatch: ${error instanceof Error ? error.message : String(error)}`;
			await deps.ledger.settle(
				commandId,
				{ state: 'uncertain', reason: 'recovery-required' },
				detail
			);
			return {
				status: 'unknown',
				commandId,
				duplicate: false,
				evidenceDigest: null,
				detail,
				facts: null,
			};
		}
		if (answer.outcome === 'accepted') {
			return {
				status: 'accepted',
				commandId,
				duplicate: false,
				evidenceDigest: null,
				detail: answer.detail ?? null,
				facts: answer.facts ?? null,
			};
		}
		const evidenceDigest = commandEvidenceDigest({
			commandId,
			kind,
			outcome: answer.outcome,
			facts: answer.facts,
		});
		await deps.ledger.settle(
			commandId,
			{ state: 'settled', outcome: answer.outcome, evidenceDigest },
			answer.detail ?? null
		);
		return {
			status: answer.outcome,
			commandId,
			duplicate: false,
			evidenceDigest,
			detail: answer.detail ?? null,
			facts: answer.facts ?? null,
		};
	}

	return {
		capabilities,

		async execute(raw) {
			const problems = managedCommandProblems(raw);
			const commandId = isRecord(raw) && isId(raw.commandId) ? raw.commandId : null;
			if (problems.length > 0) {
				return {
					status: 'denied',
					commandId,
					reason: 'invalid-input',
					detail: problems.join('; '),
				};
			}
			const command = structuredClone(raw as ManagedRuntimeCommand);
			// History before authority: a known id answers what it already answered, and grants
			// nothing new, whatever the standing is now.
			const prior = deps.ledger.get(command.commandId);
			if (prior) {
				if (prior.payloadDigest !== command.payloadDigest) {
					return {
						status: 'denied',
						commandId: command.commandId,
						reason: 'replay',
						detail: 'the command id was consumed by another payload',
					};
				}
				return stateOf(prior, true);
			}
			const binding = deps.binding();
			if (!binding.standing.ok) {
				return {
					status: 'unavailable',
					commandId: command.commandId,
					detail: binding.standing.reason,
				};
			}
			const refused = commandBindingProblem(command, binding, capabilities());
			if (refused) return { status: 'denied', commandId: command.commandId, ...refused };
			let accepted: CommandAcceptance;
			try {
				accepted = await deps.ledger.accept(command);
			} catch (error) {
				return {
					status: 'unavailable',
					commandId: command.commandId,
					detail: `the command ledger could not be written, so nothing ran: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (accepted.disposition === 'replay') {
				return {
					status: 'denied',
					commandId: command.commandId,
					reason: 'replay',
					detail: 'the nonce or idempotency key was consumed by another command',
				};
			}
			if (accepted.disposition === 'duplicate') return stateOf(accepted.record, true);
			return run(command, accepted.record);
		},

		settle: (commandId, effect, detail) => deps.ledger.settle(commandId, effect, detail ?? null),
	};
}
