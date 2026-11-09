/**
 * The desktop command service (MRC-11-01B): the typed runtime command
 * executor of `src/shared/maestro-lib/managed/commands.ts` composed over the
 * real desktop sinks, with the binding read fresh from the enrollment
 * standing for every command and the ledger file in the data directory.
 *
 * What each composed port does, and what it does not claim:
 *
 *   - `cancel_run` revokes every live dispatch lease of the named run through
 *     the broker dispatch bridge's authority. A revocation is the authority's
 *     own effect, durable in the receipts ledger, and the sink bound to each
 *     lease stops its process under it; the process exit is the receipt's to
 *     record, not this command's. The port answers `completed` when no lease
 *     of the run is live afterwards, `no-effect` when the receipts say the run
 *     had already ended, and `failed` when a lease stayed live.
 *   - `report_status` answers `completed` with the installation inventory and
 *     the policy standing as its facts: identifiers, versions, revisions,
 *     counts and named gaps. Never content, never a path, never a credential.
 *   - `refresh_policy` re-attaches through the policy status service (the one
 *     authenticated status update Maestro has) and compares the revision the
 *     endpoint applies with the one the command desired: `completed` when
 *     they agree, `failed` with both named when they do not or the re-attach
 *     did not complete.
 *   - `pause_run` and `resume_run` are the cooperative task-boundary pause
 *     (MCOMP-29-01, `COOPERATIVE_PAUSE_MODE`), composed only when the host
 *     hands `cooperativePause` in because a run owner checks in between its
 *     tasks through `runControl.track`. A pause answers `accepted` and
 *     settles when the run reaches its next boundary; the task in flight
 *     finishes first and no process is suspended. Uncomposed, both are refused
 *     `unsupported-capability` by name (`DESKTOP_UNCOMPOSED_COMMANDS`),
 *     never approximated by a stop.
 *   - `operator_prompt` is composed only when the host hands a `prompt` port
 *     in. Nothing here writes to a composer, a queue or a model.
 *
 * The binding is the lifecycle's standing at the moment of the check: the
 * registered actor id the sealed record carries (null in Maestro's record
 * today, so every actor-bound command answers `unauthenticated` until the
 * registration carries one: CP-01/CP-04, owner mega-maestro), the enrollment
 * and tenant of the record, the applied policy revision, and the run state
 * from the dispatch authority's live leases and its receipts ledger. A lost
 * standing, or a policy observation admission is not possible under, makes a
 * command `unavailable` rather than decided.
 *
 * `receive()` is the typed inbound entry; `receiveV2()` (MCOMP-29-01) reads a
 * pinned `commandRequestV2` delivery into it and answers the exact
 * `commandReceiptV2`, only when the host reports the v2 command correlation
 * negotiated (`commandWire`) and the delivery addresses the registration
 * challenge the sealed record holds now. Nothing negotiates v2 in production
 * yet (accepted endpoint protocols are [1]), so it answers
 * `unsupported_version` there. `createEnterpriseService` composes
 * this in MRC-11-05; nothing here reaches Electron or the IPC layer.
 *
 * `issueLocal()` (MRC2-07-02) is the local operator's path, `maestro-cli
 * managed command`: a typed command this host issues to itself under the
 * registered actor, through the same executor and ledger as an endpoint
 * command, so the receipt is the ledger's and a refusal is by the same name.
 * It is not an endpoint command and delivers none: its id carries
 * `LOCAL_COMMAND_ID_PREFIX`, its issuer is `LOCAL_COMMAND_ISSUER`, and it
 * binds the standing of the moment (tenant, enrollment, actor, applied
 * revision), so an unmanaged host answers `unavailable` with its standing and
 * a registration that names no actor answers `unauthenticated`, nothing run.
 */

import { randomUUID } from 'crypto';
import { canonicalJson } from '../../shared/canonicalJson';
import { sha256Hex } from '../../shared/maestro-lib/managed/authority';
import {
	commandCapability,
	commandReceiptV2Of,
	COOPERATIVE_PAUSE_MODE,
	createCommandExecutor,
	createCommandLedger,
	createCooperativePauseGate,
	readCommandRequestV2,
	type CommandReceiptV2,
	type CooperativePauseGate,
	type CommandBinding,
	type CommandExecution,
	type CommandExecutor,
	type CommandLedger,
	type CommandLedgerLoad,
	type CommandLedgerState,
	type CommandPortAnswer,
	type CommandPorts,
	type ManagedCommandAction,
	type ManagedCommandKind,
	type ManagedRuntimeCommand,
} from '../../shared/maestro-lib/managed/commands';
import type { HostAuthority } from '../../shared/maestro-lib/managed/authority';
import type { ManagedHostAdapter } from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedInstallationIdentity } from '../../shared/maestro-lib/managed/types';
import type { DispatchReceiptRecord } from './dispatch';
import type { EnrollmentLifecycle, LifecycleOutcome } from './enrollment';
import type { ContractsPinStatus, InstallationInventory } from './inventory';
import type { PolicyStatusService } from './policy-status';

/** The actions this desktop does not compose, each with why; a command naming one is refused by name. */
export const DESKTOP_UNCOMPOSED_COMMANDS: Readonly<
	Record<Extract<ManagedCommandKind, 'pause-run' | 'resume-run'>, string>
> = {
	'pause-run':
		'the desktop has no main-process pause of a running turn: a turn runs to its exit or is stopped, and nothing here approximates a pause with a stop',
	'resume-run':
		'the desktop has no main-process resume of a paused turn, since nothing pauses one; a finished turn is resumed by the operator through the composer',
};

/** What a run lookup and a cancel read of one receipt. */
export type CommandRunReceipt = Pick<DispatchReceiptRecord, 'leaseId' | 'runId'> & {
	effect: Pick<DispatchReceiptRecord['effect'], 'state'>;
};

/**
 * The leases a cancel revokes and the receipts that say a run ended: the desktop's broker dispatch
 * bridge, or a detached host's own authority (MCOMP-21-03B), which keeps no receipts ledger.
 */
export interface CommandDispatchPort {
	authority: Pick<HostAuthority, 'live' | 'revoke'>;
	/** Absent: no receipts ledger is kept here, so an ended run reads unknown and a report says null, never zero. */
	receipts?(): readonly CommandRunReceipt[];
}

/** What a status report is made of: the inventory facts it names, and the gaps beside them. */
export interface CommandStatusInventory extends Pick<
	InstallationInventory,
	'at' | 'installation' | 'identity' | 'policy' | 'completeness' | 'gaps'
> {
	versions: Pick<
		InstallationInventory['versions'],
		'app' | 'library' | 'contract' | 'endpointProtocol'
	> & {
		/** `not-read`: this host does not read the contracts pin, and its gaps say so. */
		contracts: { status: ContractsPinStatus['status'] | 'not-read' };
	};
	endpoint: Pick<InstallationInventory['endpoint'], 'authority' | 'reason' | 'lastDenial'> & {
		status: Pick<
			NonNullable<InstallationInventory['endpoint']['status']>,
			'management' | 'connectivity'
		> | null;
	};
}

export interface CommandServiceDeps {
	installation: ManagedInstallationIdentity;
	/** This process's standing, read fresh for every check. */
	lifecycle: Pick<EnrollmentLifecycle, 'status'>;
	/** The applied policy revision and whether admission is possible right now. */
	host: Pick<ManagedHostAdapter, 'policyStatus'>;
	/** The one authenticated status update: a re-attach over the registered socket. */
	policy: Pick<PolicyStatusService, 'refresh'>;
	/** The live leases a cancel revokes and the receipts that say a run ended. */
	dispatch: CommandDispatchPort;
	/** What a status report is made of. */
	inventory: { snapshot(): CommandStatusInventory };
	/** The ledger file (`MANAGED_COMMAND_LEDGER_FILE_NAME` in the data directory). Absent: in memory only (a test). */
	file?: string;
	now?: () => number;
	/** The one path an operator prompt reaches a run by. Absent: `command-operator_prompt` is not advertised. */
	prompt?: CommandPorts['prompt'];
	dispatchWindowMs?: number;
	/** Compose pause/resume over the cooperative task-boundary gate (a run owner will track runs). */
	cooperativePause?: boolean;
	/** What the attachment negotiated for commands; absent or not v2 refuses every v2 delivery. */
	commandWire?: () => { protocol: number; features: readonly string[] } | null;
}

export const COMMAND_CORRELATION_FEATURE = 'command-correlation-v2';

export interface UncomposedCommand {
	kind: ManagedCommandKind;
	capability: string;
	reason: string;
}

/**
 * The actions a local operator may issue (MRC2-07-02). Pause and resume (MCOMP-29-03B) are the
 * cooperative task-boundary pause, bound to their run like a cancel; a host that composed no
 * `cooperativePause` refuses them `unsupported-capability` by name, nothing recorded.
 */
export type LocalCommandAction =
	| { kind: 'cancel-run'; runId: string }
	| { kind: 'pause-run'; runId: string }
	| { kind: 'resume-run'; runId: string }
	| { kind: 'report-status' }
	| { kind: 'refresh-policy'; desiredRevision?: number };

export const LOCAL_COMMAND_ISSUER = 'maestro-cli';
export const LOCAL_COMMAND_ID_PREFIX = 'local-';
/** A local command is decided at once; the window only has to outlast the dispatch. */
export const LOCAL_COMMAND_WINDOW_MS = 60_000;

export interface CommandServiceStatus {
	file: string | null;
	/** Whether the ledger file loaded; `receive` answers `unavailable` until it has. */
	loaded: boolean;
	load: CommandLedgerLoad | null;
	capabilities: readonly string[];
	unsupported: readonly UncomposedCommand[];
	commands: { total: number; open: number; byState: Readonly<Record<CommandLedgerState, number>> };
	/** Whether a command could be decided right now, and why not. */
	standing: CommandBinding['standing'];
}

export interface CommandService {
	readonly ledger: CommandLedger;
	/** Read the ledger file before the first command; an accepted record from an earlier process becomes unknown. */
	load(): Promise<CommandLedgerLoad>;
	/** The `command-<action>` set this desktop executes. */
	capabilities(): readonly string[];
	/** The actions this desktop does not compose, by name. */
	unsupported(): readonly UncomposedCommand[];
	/** The one inbound entry: a value a verified endpoint port delivered, answered with the published disposition. */
	receive(raw: unknown): Promise<CommandExecution>;
	/** A v2 `command` delivery in, its exact receipt (or the local `denied`) out. */
	receiveV2(raw: unknown): Promise<CommandReceiptV2>;
	/** The cooperative pause gate a run owner tracks its runs in; null when not composed. */
	readonly runControl: CooperativePauseGate | null;
	/** A local operator's command (`maestro-cli managed command`), through the same executor and ledger. */
	issueLocal(action: LocalCommandAction): Promise<CommandExecution>;
	/** A port's requested effect ended (a `prompt` port that answered `accepted`): settle the record. */
	settle: CommandExecutor['settle'];
	status(): CommandServiceStatus;
}

const LEDGER_STATES: readonly CommandLedgerState[] = [
	'accepted',
	'completed',
	'failed',
	'no-effect',
	'denied',
	'unknown',
];

function describeOutcome(outcome: LifecycleOutcome<unknown>): string {
	switch (outcome.status) {
		case 'ok':
			return 'ok';
		case 'refused':
			return `refused (${outcome.reason}): ${outcome.message}`;
		case 'unsupported':
			return `unsupported: ${outcome.message}`;
		case 'denied':
			return `denied ${outcome.reason} on ${outcome.operation}`;
		case 'unavailable':
		case 'unknown':
			return `${outcome.status}: ${outcome.message}`;
	}
}

export function createCommandService(deps: CommandServiceDeps): CommandService {
	const now = deps.now ?? (() => Date.now());
	const ledger = createCommandLedger({ ...(deps.file ? { file: deps.file } : {}), now });
	let load: CommandLedgerLoad | null = deps.file
		? null
		: { ok: true, commands: 0, recoveredUnknown: 0 };

	const gate = deps.cooperativePause
		? createCooperativePauseGate({
				settle: (id, effect, detail) => ledger.settle(id, effect, detail),
				now,
			})
		: null;

	function runState(runId: string): 'live' | 'ended' | 'unknown' {
		if (deps.dispatch.authority.live().some((lease) => lease.runId === runId)) return 'live';
		// A run parked at a task boundary holds no lease between tasks, and is still live.
		if (gate?.state(runId)) return 'live';
		if (deps.dispatch.receipts?.().some((receipt) => receipt.runId === runId)) return 'ended';
		return 'unknown';
	}

	/** What this host is right now; read for every check, never cached across a standing change. */
	function binding(): CommandBinding {
		const standing = deps.lifecycle.status();
		const record = standing.identity.status === 'ok' ? standing.identity.record : null;
		const policy = deps.host.policyStatus();
		let reason: string | null = null;
		if (standing.authority !== 'registered') {
			reason = standing.reason ?? 'This process holds no registered standing.';
		} else if (!policy.admission.possible) {
			reason = policy.admission.reasons.join(' ') || 'No admission is possible right now.';
		}
		return {
			installation: deps.installation,
			standing: reason === null ? { ok: true } : { ok: false, reason },
			actorId: record?.registration?.actorId ?? null,
			enrollmentId: record?.enrollmentId ?? null,
			tenantId: record?.tenantId ?? null,
			policyRevision: policy.appliedRevision,
			runState,
			now: now(),
		};
	}

	async function cancel(runId: string, command: ManagedRuntimeCommand): Promise<CommandPortAnswer> {
		const live = deps.dispatch.authority.live().filter((lease) => lease.runId === runId);
		// A tracked run answers `stop` at its next (or current, if parked) task boundary.
		const boundaryStop = gate?.stop(runId) ?? false;
		if (live.length === 0 && boundaryStop) {
			return {
				outcome: 'completed',
				detail: `run ${runId} holds no live lease; it stops at its task boundary`,
				facts: {
					runId,
					revoked: [],
					stillLive: [],
					ended: [],
					boundaryStop,
					mode: COOPERATIVE_PAUSE_MODE,
				},
			};
		}
		if (live.length === 0) {
			const ended = (deps.dispatch.receipts?.() ?? [])
				.filter((receipt) => receipt.runId === runId)
				.map((receipt) => ({ leaseId: receipt.leaseId, state: receipt.effect.state }));
			return {
				outcome: 'no-effect',
				detail: `run ${runId} holds no live lease on this host; its ${ended.length} receipt(s) had already ended`,
				facts: { runId, revoked: [], stillLive: [], ended },
			};
		}
		const reason = `cancel_run ${command.commandId} issued by ${command.issuerId}`;
		const revoked = live
			.filter((lease) => deps.dispatch.authority.revoke(lease.leaseId, reason))
			.map((lease) => lease.leaseId);
		const stillLive = deps.dispatch.authority
			.live()
			.filter((lease) => lease.runId === runId)
			.map((lease) => lease.leaseId);
		const facts = { runId, revoked, stillLive, ended: [], boundaryStop };
		if (stillLive.length > 0) {
			return {
				outcome: 'failed',
				detail: `revoked ${revoked.length} lease(s) of run ${runId}; ${stillLive.length} stayed live`,
				facts,
			};
		}
		return {
			outcome: 'completed',
			detail: `revoked ${revoked.length} lease(s) of run ${runId}; each sink stops its process under the revoked lease, and the exit is the receipt's to record`,
			facts,
		};
	}

	async function report(): Promise<CommandPortAnswer> {
		const inventory = deps.inventory.snapshot();
		const policy = inventory.policy;
		const liveRuns = new Set(
			deps.dispatch.authority
				.live()
				.map((lease) => lease.runId)
				.filter((runId): runId is string => runId !== null)
		);
		return {
			outcome: 'completed',
			detail: 'status reported from the installation inventory and the policy standing',
			facts: {
				at: inventory.at,
				installation: inventory.installation,
				versions: {
					app: inventory.versions.app,
					library: inventory.versions.library,
					contract: inventory.versions.contract,
					endpointProtocol: inventory.versions.endpointProtocol,
					contracts: inventory.versions.contracts.status,
				},
				endpoint: {
					authority: inventory.endpoint.authority,
					reason: inventory.endpoint.reason,
					management: inventory.endpoint.status?.management ?? null,
					connectivity: inventory.endpoint.status?.connectivity ?? null,
					lastDenial: inventory.endpoint.lastDenial,
				},
				identity: inventory.identity,
				policy: {
					desiredRevision: policy.desiredRevision,
					appliedRevision: policy.appliedRevision,
					installedRevision: policy.installedRevision,
					source: policy.source,
					freshness: policy.freshness,
					converged: policy.converged,
					admissionPossible: policy.admission.possible,
				},
				runs: {
					live: liveRuns.size,
					liveLeases: deps.dispatch.authority.live().length,
					receipts: deps.dispatch.receipts?.().length ?? null,
				},
				commands: { total: ledger.list().length, open: ledger.open().length },
				completeness: inventory.completeness,
				gaps: inventory.gaps,
			},
		};
	}

	async function refresh(desiredRevision: number): Promise<CommandPortAnswer> {
		const before = deps.host.policyStatus();
		const facts: Record<string, unknown> = {
			desiredRevision,
			before: { desired: before.desiredRevision, applied: before.appliedRevision },
		};
		const outcome = await deps.policy.refresh();
		if (outcome.status !== 'ok') {
			return {
				outcome: 'failed',
				detail: `the re-attach did not complete: ${describeOutcome(outcome)}`,
				facts: { ...facts, refresh: outcome.status },
			};
		}
		const after = outcome.value;
		facts.after = {
			desired: after.desiredPolicyRevision,
			applied: after.appliedPolicyRevision,
			connectivity: after.connectivity,
			management: after.management,
		};
		if (after.appliedPolicyRevision === desiredRevision) {
			return {
				outcome: 'completed',
				detail: `the endpoint applies revision ${desiredRevision}`,
				facts,
			};
		}
		return {
			outcome: 'failed',
			detail: `the endpoint applies revision ${after.appliedPolicyRevision ?? 'none'} and desires ${after.desiredPolicyRevision ?? 'none'}, not ${desiredRevision}`,
			facts,
		};
	}

	const ports: CommandPorts = {
		cancel,
		report,
		refresh,
		...(gate ? { pause: gate.pause, resume: gate.resume } : {}),
		...(deps.prompt ? { prompt: deps.prompt } : {}),
	};
	const executor = createCommandExecutor({
		ledger,
		binding,
		ports,
		now,
		...(deps.dispatchWindowMs !== undefined ? { dispatchWindowMs: deps.dispatchWindowMs } : {}),
	});

	const unsupported = (): UncomposedCommand[] => {
		const composed = executor.capabilities();
		const named = (Object.keys(DESKTOP_UNCOMPOSED_COMMANDS) as ManagedCommandKind[])
			.filter((kind) => !composed.includes(commandCapability(kind)))
			.map((kind) => ({
				kind,
				capability: commandCapability(kind),
				reason: DESKTOP_UNCOMPOSED_COMMANDS[kind as keyof typeof DESKTOP_UNCOMPOSED_COMMANDS],
			}));
		if (!composed.includes(commandCapability('operator-prompt'))) {
			named.push({
				kind: 'operator-prompt',
				capability: commandCapability('operator-prompt'),
				reason:
					'no prompt port was composed on this host, so no operator prompt reaches a run here',
			});
		}
		return named;
	};

	/**
	 * The command a local operator's action becomes: bound to this host's standing
	 * right now, so the executor's own checks decide it (an unknown run is
	 * `stale-run`, an uncomposed action `unsupported-capability`), and recorded
	 * under a `local-` id the ledger keeps beside the endpoint's.
	 */
	async function issueLocal(action: LocalCommandAction): Promise<CommandExecution> {
		const b = binding();
		if (!b.standing.ok) {
			return {
				status: 'unavailable',
				commandId: null,
				detail: `No command runs on this host: ${b.standing.reason}`,
			};
		}
		if (b.actorId === null) {
			return {
				status: 'denied',
				commandId: null,
				reason: 'unauthenticated',
				detail: 'the registration this process holds names no actor',
			};
		}
		if (b.tenantId === null || b.enrollmentId === null || b.policyRevision === null) {
			return {
				status: 'unavailable',
				commandId: null,
				detail: 'the standing names no tenant, enrollment or applied policy revision',
			};
		}
		if ((action.kind === 'pause-run' || action.kind === 'resume-run') && gate === null) {
			return {
				status: 'denied',
				commandId: null,
				reason: 'unsupported-capability',
				detail: `this host does not execute ${commandCapability(action.kind)}: ${DESKTOP_UNCOMPOSED_COMMANDS[action.kind]}`,
			};
		}
		let typed: ManagedCommandAction;
		if (action.kind === 'refresh-policy') {
			const desiredRevision = action.desiredRevision ?? deps.host.policyStatus().desiredRevision;
			if (desiredRevision === null) {
				return {
					status: 'unavailable',
					commandId: null,
					detail: 'no desired policy revision is known on this host; name one',
				};
			}
			typed = { kind: 'refresh-policy', desiredRevision };
		} else typed = { kind: action.kind };
		const issuedAt = now();
		const command: ManagedRuntimeCommand = {
			commandId: `${LOCAL_COMMAND_ID_PREFIX}${randomUUID()}`,
			tenantId: b.tenantId,
			issuerId: LOCAL_COMMAND_ISSUER,
			recipient: {
				actorId: b.actorId,
				enrollmentId: b.enrollmentId,
				installationId: deps.installation.installationId,
				runtimeId: deps.installation.runtimeId,
				processEpoch: deps.installation.processEpoch,
				runId: 'runId' in action ? action.runId : null,
			},
			action: typed,
			preconditions: {
				policyRevision: b.policyRevision,
				requiredCapability: commandCapability(typed.kind),
				policyDigest: null,
				bindingDigest: null,
			},
			approval: { kind: 'policy-not-required', policyRevision: b.policyRevision },
			issuedAt: new Date(issuedAt).toISOString(),
			expiresAt: new Date(issuedAt + LOCAL_COMMAND_WINDOW_MS).toISOString(),
			nonce: randomUUID(),
			idempotencyKey: randomUUID(),
			payloadDigest: '',
			releaseId: null,
		};
		command.payloadDigest = sha256Hex(canonicalJson({ ...command, payloadDigest: null }));
		return executor.execute(command);
	}

	/**
	 * A v2 delivery: negotiated first, then read against the pinned shape, then bound to the
	 * registration challenge the sealed record holds now (a delivery for an earlier or another
	 * registration is `unauthenticated`, nothing recorded), then the same executor and ledger as
	 * `receive`, with the envelope kept so a re-signed duplicate is a replay.
	 */
	async function receiveV2(raw: unknown): Promise<CommandReceiptV2> {
		const wire = deps.commandWire?.() ?? null;
		if (
			wire === null ||
			wire.protocol !== 2 ||
			!wire.features.includes(COMMAND_CORRELATION_FEATURE)
		) {
			return { outcome: 'denied', reason: 'unsupported_version' };
		}
		const reading = readCommandRequestV2(raw);
		if (!reading.ok) return { outcome: 'denied', reason: 'invalid_request' };
		const standing = deps.lifecycle.status();
		const registration =
			standing.identity.status === 'ok' ? standing.identity.record?.registration : null;
		if (!registration || registration.challengeId !== reading.delivery.challengeId) {
			return { outcome: 'denied', reason: 'unauthenticated' };
		}
		const execution = await executor.execute(reading.command, reading.delivery);
		return commandReceiptV2Of(execution, reading);
	}

	return {
		ledger,
		runControl: gate,
		receiveV2,
		async load() {
			load = await ledger.load();
			return load;
		},
		capabilities: () => executor.capabilities(),
		unsupported,
		receive: (raw) => executor.execute(raw),
		issueLocal,
		settle: (commandId, effect, detail) => executor.settle(commandId, effect, detail),
		status() {
			const records = ledger.list();
			const byState = Object.fromEntries(LEDGER_STATES.map((state) => [state, 0])) as Record<
				CommandLedgerState,
				number
			>;
			for (const record of records) byState[record.state] += 1;
			return {
				file: ledger.file,
				loaded: load?.ok === true,
				load,
				capabilities: executor.capabilities(),
				unsupported: unsupported(),
				commands: { total: records.length, open: ledger.open().length, byState },
				standing: binding().standing,
			};
		},
	};
}
