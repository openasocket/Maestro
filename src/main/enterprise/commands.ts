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
 *   - `pause_run` and `resume_run` are not composed: the desktop has no
 *     main-process pause of a running turn, so the capability is not
 *     advertised and a command naming it is refused `unsupported-capability`
 *     by name (`DESKTOP_UNCOMPOSED_COMMANDS`), never approximated by a stop.
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
 * `receive()` is the one inbound entry. No producer delivers a command to a
 * Maestro runtime yet: the sibling's local socket serves no `command`
 * operation (CP-02, owner mega-maestro). `createEnterpriseService` composes
 * this in MRC-11-05; nothing here reaches Electron or the IPC layer.
 */

import {
	commandCapability,
	createCommandExecutor,
	createCommandLedger,
	type CommandBinding,
	type CommandExecution,
	type CommandExecutor,
	type CommandLedger,
	type CommandLedgerLoad,
	type CommandLedgerState,
	type CommandPortAnswer,
	type CommandPorts,
	type ManagedCommandKind,
	type ManagedRuntimeCommand,
} from '../../shared/maestro-lib/managed/commands';
import type { ManagedHostAdapter } from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedInstallationIdentity } from '../../shared/maestro-lib/managed/types';
import type { BrokerDispatch } from './dispatch';
import type { EnrollmentLifecycle, LifecycleOutcome } from './enrollment';
import type { InstallationInventoryService } from './inventory';
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

export interface CommandServiceDeps {
	installation: ManagedInstallationIdentity;
	/** This process's standing, read fresh for every check. */
	lifecycle: Pick<EnrollmentLifecycle, 'status'>;
	/** The applied policy revision and whether admission is possible right now. */
	host: Pick<ManagedHostAdapter, 'policyStatus'>;
	/** The one authenticated status update: a re-attach over the registered socket. */
	policy: Pick<PolicyStatusService, 'refresh'>;
	/** The live leases a cancel revokes and the receipts that say a run ended. */
	dispatch: Pick<BrokerDispatch, 'authority' | 'receipts'>;
	/** What a status report is made of. */
	inventory: Pick<InstallationInventoryService, 'snapshot'>;
	/** The ledger file (`MANAGED_COMMAND_LEDGER_FILE_NAME` in the data directory). Absent: in memory only (a test). */
	file?: string;
	now?: () => number;
	/** The one path an operator prompt reaches a run by. Absent: `command-operator_prompt` is not advertised. */
	prompt?: CommandPorts['prompt'];
	dispatchWindowMs?: number;
}

export interface UncomposedCommand {
	kind: ManagedCommandKind;
	capability: string;
	reason: string;
}

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

	function runState(runId: string): 'live' | 'ended' | 'unknown' {
		if (deps.dispatch.authority.live().some((lease) => lease.runId === runId)) return 'live';
		if (deps.dispatch.receipts().some((receipt) => receipt.runId === runId)) return 'ended';
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
		if (live.length === 0) {
			const ended = deps.dispatch
				.receipts()
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
		const facts = { runId, revoked, stillLive, ended: [] };
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
					receipts: deps.dispatch.receipts().length,
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
		const named = (Object.keys(DESKTOP_UNCOMPOSED_COMMANDS) as ManagedCommandKind[]).map(
			(kind) => ({
				kind,
				capability: commandCapability(kind),
				reason: DESKTOP_UNCOMPOSED_COMMANDS[kind as keyof typeof DESKTOP_UNCOMPOSED_COMMANDS],
			})
		);
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

	return {
		ledger,
		async load() {
			load = await ledger.load();
			return load;
		},
		capabilities: () => executor.capabilities(),
		unsupported,
		receive: (raw) => executor.execute(raw),
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
