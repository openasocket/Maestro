/**
 * The protected broker dispatch bridge: the one place a desktop (or a
 * headless host composing the same modules) turns the enterprise host
 * adapter's authority into the `ManagedTurnAuthority` a sink admits with,
 * and keeps the durable join between what the BROKER decided and what this
 * host actually ran.
 *
 * The bridge decides nothing. The host adapter asks the endpoint for every
 * admission and maps the broker's answer onto a lease (`host-adapter.ts`);
 * the sink (`runAgentTurn` / `startTurn`) re-checks that lease against the
 * final snapshot the instant before `spawn`, binds it to the pid and
 * releases it on exit (`authority.ts`). What those two do not keep is the
 * correlation across time and restarts: which broker decision (its
 * `decisionId`, the grant the broker journaled in its own receipt ledger;
 * its `requestDigest`; its `brokerId`) authorized which local lease, bound
 * to which process, under which actor registration, and how that process
 * ended. That is this ledger, `maestro-managed-dispatch-receipts.json`
 * beside the run journal, written through `writeStoreDocument` like every
 * other store.
 *
 * Three rules the bridge holds:
 *
 *   - A receipt is never a permit on its own. The lease is; the receipt is
 *     the broker's half of the record, and the sink's check at the spawn is
 *     what refuses a snapshot other than the admitted one.
 *   - Every effect state change is recorded as it happens (admitted, bound
 *     with the pid, released with the exit, revoked with the reason). After
 *     a restart a receipt that was still bound is `unknown`: this host cannot
 *     say what became of that process, and says so.
 *   - The registration the decision was taken under is part of the record,
 *     so a later reader can tell which actor's standing authorized the run.
 */

import {
	readStoreDocument,
	STORE_SCHEMA_KEY,
	writeStoreDocument,
} from '../../shared/maestro-lib/store/io';
import { INTERACTIVE_STOP_GRACE_MS } from '../../shared/maestro-lib/control/termination';
import {
	buildDispatchSnapshot,
	type AdmissionRequest,
	type DispatchAttribution,
	type DispatchLease,
	type DispatchSnapshot,
	type HostAuthority,
	type LeaseRelease,
	type ManagedDecisionReceipt,
} from '../../shared/maestro-lib/managed/authority';
import type { SupportStatus } from '../../shared/maestro-lib/managed/compatibility';
import type { ManagedHostAdapter } from '../../shared/maestro-lib/managed/host-adapter';
import {
	buildHarnessLaunchSpec,
	harnessRouteProblems,
	SYNTHETIC_HARNESS_MODEL,
	SYNTHETIC_HARNESS_PROVIDER,
	syntheticHarnessRouteSupport,
	type HarnessRouteRequest,
} from '../../shared/maestro-lib/managed/provider-route';
import type {
	ManagedAuthenticatedContext,
	ManagedDenialCode,
	ManagedPrincipalRef,
} from '../../shared/maestro-lib/managed/types';
import {
	DispatchRefusedError,
	leaseAdmission,
	startTurn,
	type DispatchAdmission,
	type TurnExit,
} from '../../shared/maestro-lib/run/start-turn';
import type { ManagedTurnAuthority } from '../../shared/maestro-lib/turns/run-agent-turn';
import {
	unavailableEffectAuthority,
	type ManagedEffect,
	type ManagedEffectBinding,
} from '../../shared/maestro-lib/managed/effects';
import type { RelayManagedGate } from '../permission-relay/PermissionRelayServer';
import type { ProcessSpawnAdmission, ProcessSpawnAuthorityPort } from '../process-manager/types';
import type { CueManagedAdmission } from '../cue/cue-executor';

export const DISPATCH_RECEIPTS_FILE_NAME = 'maestro-managed-dispatch-receipts.json';

export type DispatchEffectState =
	| 'admitted'
	| 'bound'
	| 'released'
	| 'revoked'
	| 'expired'
	| 'unknown';

/** The registration the decision was taken under, as identifiers only. */
export interface DispatchRegistrationRef {
	runtimeId: string;
	processEpoch: string;
	challengeId: string;
	registeredAt: string;
}

/** One admitted dispatch: the broker's decision joined to the local lease and its effect. */
export interface DispatchReceiptRecord {
	leaseId: string;
	authorityId: string;
	snapshotDigest: string;
	/** The broker's receipt; null when the authority decided with no broker receipt. */
	decision: ManagedDecisionReceipt | null;
	requestId: string;
	attemptId: string;
	runId: string | null;
	actor: ManagedPrincipalRef;
	policyRevision: number | null;
	provider: string;
	operation: string;
	registration: DispatchRegistrationRef | null;
	admittedAt: string;
	effect: {
		state: DispatchEffectState;
		pid: number | null;
		boundAt: string | null;
		endedAt: string | null;
		release: LeaseRelease | null;
		reason: string | null;
	};
}

export interface DispatchReceiptsDocument {
	[STORE_SCHEMA_KEY]: number;
	receipts: DispatchReceiptRecord[];
}

export interface BrokerDispatchDeps {
	host: ManagedHostAdapter;
	/** The ledger file. Absent: the ledger lives in memory only (a test, a one-shot host). */
	file?: string;
	now?: () => number;
	/** How many receipts to keep; the oldest ended ones go first. Default 2000. */
	maxReceipts?: number;
	/** Hears a ledger write that failed. The admission stands; the gap is reported, not hidden. */
	onPersistError?(error: unknown): void;
}

export interface TurnAuthorityInput {
	context: ManagedAuthenticatedContext;
	/** An opaque account reference, never a credential. */
	account?: string | null;
	resourceIds?: readonly string[];
	/**
	 * The route ceiling and approved credential references the launch plan applies
	 * (`ManagedTurnAuthority.launch`). Required for a provider turn; the synthetic harness
	 * route, which builds its own complete spec, is the one caller that passes none.
	 */
	launch?: ManagedTurnAuthority['launch'];
	onLease?(lease: DispatchLease): void;
}

export type DispatchLedgerLoad =
	| { ok: true; receipts: number; recoveredUnknown: number }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

export interface BrokerDispatch {
	/** The authority a sink admits with. Every admission goes through the host adapter and is recorded here. */
	readonly authority: HostAuthority;
	/** Read the ledger file and mark every receipt still bound at the last exit as unknown. */
	load(): Promise<DispatchLedgerLoad>;
	receipts(): readonly DispatchReceiptRecord[];
	receipt(leaseId: string): DispatchReceiptRecord | null;
	/** The local record for a broker decision id, so the two ledgers join. */
	byDecision(decisionId: string): DispatchReceiptRecord | null;
	/** The `ManagedTurnAuthority` for `runAgentTurn`, over this bridge's authority and the adapter's policy. */
	turnAuthority(input: TurnAuthorityInput): ManagedTurnAuthority;
	/** Ledger writes that failed since load, for a status pane. */
	persistFailures(): number;
	/** Resolves once every ledger write issued so far has landed (or failed and been counted). */
	flush(): Promise<void>;
}

const DEFAULT_MAX_RECEIPTS = 2_000;
const ENDED: readonly DispatchEffectState[] = ['released', 'revoked', 'expired', 'unknown'];

function emptyDocument(): DispatchReceiptsDocument {
	return { [STORE_SCHEMA_KEY]: 1, receipts: [] };
}

export function createBrokerDispatch(deps: BrokerDispatchDeps): BrokerDispatch {
	const now = deps.now ?? (() => Date.now());
	const iso = () => new Date(now()).toISOString();
	const maxReceipts = deps.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
	let doc: DispatchReceiptsDocument = emptyDocument();
	let failures = 0;
	let pending: Promise<void> = Promise.resolve();
	const byLease = new Map<string, DispatchReceiptRecord>();

	function index(): void {
		byLease.clear();
		for (const record of doc.receipts) byLease.set(record.leaseId, record);
	}

	function trim(): void {
		if (doc.receipts.length <= maxReceipts) return;
		let excess = doc.receipts.length - maxReceipts;
		doc.receipts = doc.receipts.filter((record) => {
			if (excess > 0 && ENDED.includes(record.effect.state)) {
				excess -= 1;
				return false;
			}
			return true;
		});
		index();
	}

	async function writeLedger(): Promise<void> {
		trim();
		if (!deps.file) return;
		try {
			await writeStoreDocument(deps.file, doc);
		} catch (error) {
			failures += 1;
			deps.onPersistError?.(error);
		}
	}

	/** One write at a time, in order; `flush()` resolves once the last one has landed. */
	function persist(): Promise<void> {
		pending = pending.then(writeLedger, writeLedger);
		return pending;
	}

	/** The registration the standing holds right now, as identifiers. */
	function registrationRef(): DispatchRegistrationRef | null {
		const standing = deps.host.status();
		const registration =
			standing.identity.status === 'ok' ? standing.identity.record?.registration : null;
		if (!registration) return null;
		return {
			runtimeId: registration.runtimeId,
			processEpoch: registration.processEpoch,
			challengeId: registration.challengeId,
			registeredAt: registration.registeredAt,
		};
	}

	/** Watch the lease's lifetime from the outside: the sink drives it, the ledger writes it down. */
	function follow(record: DispatchReceiptRecord, lease: DispatchLease): void {
		const bind = lease.bind.bind(lease);
		const release = lease.release.bind(lease);
		lease.bind = (pid) => {
			bind(pid);
			record.effect = { ...record.effect, state: 'bound', pid: pid ?? null, boundAt: iso() };
			void persist();
		};
		lease.release = (outcome) => {
			const before = lease.state();
			release(outcome);
			if (before === 'released' || before === 'revoked') return;
			record.effect = { ...record.effect, state: 'released', endedAt: iso(), release: outcome };
			void persist();
		};
		lease.onRevoked((reason) => {
			record.effect = { ...record.effect, state: 'revoked', endedAt: iso(), reason };
			void persist();
		});
	}

	const authority: HostAuthority = {
		get authorityId() {
			return deps.host.authority.authorityId;
		},
		async admit(request: AdmissionRequest) {
			const outcome = await deps.host.authority.admit(request);
			if (outcome.state !== 'admitted') return outcome;
			const { lease } = outcome;
			const record: DispatchReceiptRecord = {
				leaseId: lease.leaseId,
				authorityId: lease.authorityId,
				snapshotDigest: lease.snapshotDigest,
				decision: outcome.receipt,
				requestId: request.context.identity.requestId,
				attemptId: lease.attemptId,
				runId: lease.runId,
				actor: lease.actor,
				policyRevision: lease.policyRevision,
				provider: request.snapshot.provider,
				operation: request.snapshot.operation,
				registration: registrationRef(),
				admittedAt: lease.issuedAt,
				effect: {
					state: 'admitted',
					pid: null,
					boundAt: null,
					endedAt: null,
					release: null,
					reason: null,
				},
			};
			doc.receipts.push(record);
			byLease.set(record.leaseId, record);
			follow(record, lease);
			await persist();
			return outcome;
		},
		check: (lease, digest) => deps.host.authority.check(lease, digest),
		revoke: (leaseId, reason) => deps.host.authority.revoke(leaseId, reason),
		revokeAll: (reason) => deps.host.authority.revokeAll(reason),
		live: () => deps.host.authority.live(),
	};

	return {
		authority,

		async load() {
			if (!deps.file) return { ok: true, receipts: 0, recoveredUnknown: 0 };
			const read = await readStoreDocument<DispatchReceiptsDocument>(deps.file, (value) =>
				Array.isArray(value.receipts) ? null : 'receipts is not an array'
			);
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return { ok: false, reason: read.status, file: deps.file, message: read.reason };
			}
			doc = read.status === 'ok' ? read.data : emptyDocument();
			index();
			let recoveredUnknown = 0;
			const at = iso();
			for (const record of doc.receipts) {
				if (record.effect.state === 'bound' || record.effect.state === 'admitted') {
					record.effect = {
						...record.effect,
						state: 'unknown',
						endedAt: at,
						reason: 'The host restarted while this lease was live.',
					};
					recoveredUnknown += 1;
				}
			}
			if (recoveredUnknown > 0 || read.status === 'missing') await persist();
			return { ok: true, receipts: doc.receipts.length, recoveredUnknown };
		},

		receipts: () => doc.receipts,
		receipt: (leaseId) => byLease.get(leaseId) ?? null,
		byDecision: (decisionId) =>
			doc.receipts.find((record) => record.decision?.decisionId === decisionId) ?? null,

		turnAuthority(input) {
			return {
				authority,
				context: input.context,
				policy: deps.host.policy(),
				account: input.account ?? null,
				resourceIds: input.resourceIds ?? [],
				...(input.launch ? { launch: input.launch } : {}),
				onLease: (lease) => input.onLease?.(lease),
			};
		},

		persistFailures: () => failures,
		flush: () => pending,
	};
}

// ---------------------------------------------------------------------------
// The synthetic harness route through the protected dispatch
// ---------------------------------------------------------------------------

export type HarnessDispatchOutcome =
	| { status: 'refused'; reason: 'route-unsupported' | 'invalid-request'; problems: string[] }
	| { status: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode; message: string }
	| {
			status: 'ran';
			leaseId: string;
			decision: ManagedDecisionReceipt | null;
			receipt: DispatchReceiptRecord | null;
			exit: TurnExit;
	  };

export interface HarnessDispatchOptions {
	/** Aborting stops the program from the terminate stage. */
	signal?: AbortSignal;
	stopGraceMs?: number;
	onStdout?(text: string): void;
}

/**
 * Run one synthetic harness program through the protected dispatch: the
 * route's own validation, the launch spec under the permission model, the
 * admission of its snapshot by `bridge.authority` (which asks the endpoint
 * through the adapter), the lease checked again at the spawn inside
 * `startTurn`, the pid bound, the exit released and recorded, a revocation
 * terminating it. A route this Node cannot enforce, an invalid request, or
 * any admission short of `admitted` returns before anything runs; nothing
 * is written to the work directory until the lease passed at the spawn.
 */
export async function dispatchHarness(
	bridge: BrokerDispatch,
	request: HarnessRouteRequest,
	managed: { context: ManagedAuthenticatedContext; policy?: ManagedTurnAuthority['policy'] },
	options: HarnessDispatchOptions = {}
): Promise<HarnessDispatchOutcome> {
	const support = syntheticHarnessRouteSupport();
	if (support.managed === 'unsupported') {
		return { status: 'refused', reason: 'route-unsupported', problems: [support.note] };
	}
	const problems = harnessRouteProblems(request);
	if (problems.length > 0) return { status: 'refused', reason: 'invalid-request', problems };

	const spec = buildHarnessLaunchSpec(request);
	const attribution = {
		provider: SYNTHETIC_HARNESS_PROVIDER,
		model: SYNTHETIC_HARNESS_MODEL,
		operation: 'start' as const,
		target: { kind: 'local' } as const,
		resourceIds: [...request.inputs],
	};
	const turn = bridge.turnAuthority({ context: managed.context, resourceIds: request.inputs });
	const admitted = await turn.authority.admit({
		context: managed.context,
		snapshot: buildDispatchSnapshot(spec, attribution),
		policy: managed.policy ?? turn.policy,
	});
	if (admitted.state !== 'admitted') {
		return { status: admitted.state, code: admitted.code, message: admitted.message };
	}
	const { lease } = admitted;
	const gate = leaseAdmission(turn.authority, lease);

	let handle: ReturnType<typeof startTurn>;
	try {
		handle = startTurn(
			spec,
			{ onStdout: options.onStdout },
			{
				admission: { gate, attribution },
				stopGraceMs: options.stopGraceMs ?? INTERACTIVE_STOP_GRACE_MS,
				...(options.signal ? { signal: options.signal } : {}),
				stdoutTailLimit: 64 * 1024,
				stderrTailLimit: 64 * 1024,
				label: `harness ${lease.leaseId}`,
			}
		);
	} catch (error) {
		if (error instanceof DispatchRefusedError) {
			lease.release({ outcome: 'unknown', message: error.message });
			return { status: error.state, code: error.code, message: error.message };
		}
		throw error;
	}
	const timer = setTimeout(() => handle.terminate(), request.timeoutMs);
	try {
		const exit = await handle.done;
		// The outcome is returned only once the ledger holds how it ended.
		await bridge.flush();
		return {
			status: 'ran',
			leaseId: lease.leaseId,
			decision: lease.decision,
			receipt: bridge.receipt(lease.leaseId),
			exit,
		};
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// The permission relay intersection (MRC-06-07)
// ---------------------------------------------------------------------------

/**
 * The exact effect a relayed Claude Code tool request asks for, from the
 * tool name and the input the bridge forwarded verbatim: `Bash` is a command
 * (`command`, with no cwd of its own), the editing tools are a file change
 * over the path they name, everything else is that tool with its input. The
 * model's `description` is prose and never an input to a decision.
 */
export function claudeToolEffect(toolName: string, input: Record<string, unknown>): ManagedEffect {
	const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
	switch (toolName) {
		case 'Bash':
			return { kind: 'command', command: text(input.command) ?? '', cwd: null, argv: null };
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
		case 'NotebookEdit': {
			const path = text(input.file_path) ?? text(input.notebook_path);
			return { kind: 'file-change', paths: path ? [path] : [], cwd: null };
		}
		case 'AskUserQuestion':
			return { kind: 'user-input', prompt: null };
		default:
			return { kind: 'tool-call', tool: toolName, input };
	}
}

export interface RelayGateDeps {
	/** The host's spawn authority port, read live; null or standalone means every request is the user's. */
	port(): ProcessSpawnAuthorityPort | null;
	/** The admission bound to a session's live process, if any. */
	admissionOf(sessionId: string): ProcessSpawnAdmission | null;
	/** Whether that admission's lease is still bound to the process. */
	admissionLive(sessionId: string): { ok: true } | { ok: false; reason: string };
}

/**
 * The managed gate the permission relay intersects local consent with: the
 * host's effect authority decides the exact tool request, bound to the lease
 * of the spawn the relay token names (its actor, the tab as the turn, the
 * request id), and the admission is re-checked after the user answers. A
 * spawn with no live admission (a process that predates the enrollment, a
 * lease that ended) is refused outright; the user is never asked.
 */
export function createRelayManagedGate(deps: RelayGateDeps): RelayManagedGate {
	return {
		async decide(binding, request) {
			const port = deps.port();
			if (!port || port.standing() === 'standalone') return { managed: false };
			const admission = deps.admissionOf(binding.sessionId);
			if (!admission) {
				return {
					managed: true,
					decision: {
						decision: 'deny',
						reason: 'the spawn this request came from holds no live admission on this host.',
					},
				};
			}
			const live = deps.admissionLive(binding.sessionId);
			if (!live.ok) return { managed: true, decision: { decision: 'deny', reason: live.reason } };
			const effect = claudeToolEffect(request.toolName, request.input);
			const effectBinding: ManagedEffectBinding = {
				leaseId: admission.leaseId,
				actor: admission.actor,
				provider: admission.provider,
				threadId: null,
				turnId: binding.tabId ?? null,
				requestId: request.requestId,
			};
			const authority =
				port.effects ??
				unavailableEffectAuthority('This host has no effect authority for managed turns.');
			const decision = await authority.decide(effect, effectBinding, new AbortController().signal);
			return { managed: true, decision };
		},
		recheck: (binding) => deps.admissionLive(binding.sessionId),
	};
}

// ---------------------------------------------------------------------------
// The Cue shell boundary (MRC-07-03)
// ---------------------------------------------------------------------------

/**
 * The two ways a Cue `action: command` / `mode: shell` subscription runs its
 * command: through the user's shell on this machine (`spawn` with
 * `shell: true`), or as `bash -c` inside a remote login shell over SSH.
 * Neither is a provider route: nothing parses a tool call, nothing asks
 * before acting, and the command does whatever the shell lets it.
 */
export type CueShellRoute = 'local-shell' | 'ssh-shell';

/** The provider a Cue shell action is attributed to in its dispatch snapshot. */
export const CUE_SHELL_PROVIDER = 'cue-shell';

export interface CueShellRouteSupport {
	route: CueShellRoute;
	/** Whether this build runs the action over the route at all. */
	standalone: SupportStatus;
	/** Whether a managed restriction is enforced on the route. */
	managed: SupportStatus;
	note: string;
}

const CUE_SHELL_NO_CONFINEMENT =
	'no confinement producer qualifies the route, so a managed host refuses the action before anything starts, and never runs it unmanaged in its place';

/**
 * The one table for the Cue shell routes. Both run standalone as they always
 * have; neither is qualified under management: a shell child inherits the
 * engine environment and the login-shell PATH and does whatever the shell
 * lets it, and a remote login shell proves no containment at all. The table
 * reads `unsupported` until a real confinement producer is exercised at this
 * sink; it is never flipped from a test or a host flag.
 */
export function cueShellRouteSupport(route: CueShellRoute): CueShellRouteSupport {
	return route === 'local-shell'
		? {
				route,
				standalone: 'implemented',
				managed: 'unsupported',
				note: `the substituted command runs through the user's shell on this machine with the engine's environment; ${CUE_SHELL_NO_CONFINEMENT}`,
			}
		: {
				route,
				standalone: 'implemented',
				managed: 'unsupported',
				note: `the substituted command runs as bash -c inside a remote login shell over SSH; the remote proves no containment and ${CUE_SHELL_NO_CONFINEMENT}`,
			};
}

/**
 * The final spawn of a Cue shell action, as the executor is about to issue
 * it: the substituted command (the shell parses it locally; the SSH wrapper
 * already folded it into the `ssh` invocation remotely), the cwd, the exact
 * environment and which route it takes. Built after template substitution,
 * the SSH wrap and the PATH probe, so nothing about it can still change.
 */
export interface CueShellSpawnPlan {
	route: CueShellRoute;
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
	shell: boolean;
	/** The directory the command acts on: the owning agent's project root, local or remote. */
	projectRoot: string;
	/** The SSH remote the command runs on, as the wrapper resolved it; null on this machine. */
	remoteId: string | null;
}

/** What the plan does not say for itself: a shell action has no provider, model or session. */
export function cueShellAttribution(
	plan: Pick<CueShellSpawnPlan, 'projectRoot' | 'remoteId'>,
	account: string | null
): DispatchAttribution {
	return {
		provider: CUE_SHELL_PROVIDER,
		model: null,
		operation: 'start',
		account,
		target: plan.remoteId ? { kind: 'ssh', remoteId: plan.remoteId } : { kind: 'local' },
		resourceIds: [`dir:${plan.projectRoot}`],
	};
}

export type CueShellAdmissionOutcome =
	| {
			state: 'admitted';
			lease: DispatchLease;
			/** The sink's gate: re-check at `spawn()`, hear a revocation. */
			gate: DispatchAdmission;
			attribution: DispatchAttribution;
			snapshot: DispatchSnapshot;
	  }
	| { state: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode; message: string };

export interface CueShellAdmissionDeps {
	/** The route table. Default {@link cueShellRouteSupport}; a test injects a declared double to reach the sink past the refusal. */
	routeSupport?: (route: CueShellRoute) => CueShellRouteSupport;
}

/**
 * Admit one Cue shell action on a managed host, or say why not. The route is
 * read FIRST, on the final plan (so an SSH action is judged as the remote
 * launch it is, not as the local `bash` it was before the wrap): a route the
 * table does not qualify is `unavailable` with `capability-unsupported`, and
 * no lease is asked for a launch this host could not confine. A qualified
 * route is admitted by the host authority on the snapshot of exactly this
 * spawn (command, arguments, cwd, every environment variable by name and
 * digest, the shell, the target, the project root as its resource); the
 * lease comes back with the gate the executor re-checks the instant before
 * `spawn()`. Nothing short of `admitted` runs the command, anywhere.
 */
export async function admitCueShell(
	admission: CueManagedAdmission,
	plan: CueShellSpawnPlan,
	deps: CueShellAdmissionDeps = {}
): Promise<CueShellAdmissionOutcome> {
	const support = (deps.routeSupport ?? cueShellRouteSupport)(plan.route);
	if (support.managed !== 'implemented') {
		return {
			state: 'unavailable',
			code: 'capability-unsupported',
			message: `A Cue shell action over the ${plan.route} route is unavailable under management on this host: ${support.note}. Nothing was started.`,
		};
	}
	const attribution = cueShellAttribution(plan, admission.account ?? null);
	const snapshot = buildDispatchSnapshot(
		{ command: plan.command, args: plan.args, cwd: plan.cwd, env: plan.env, shell: plan.shell },
		attribution
	);
	const admitted = await admission.authority.admit({
		context: admission.context,
		snapshot,
		policy: admission.policy,
	});
	if (admitted.state !== 'admitted') {
		return { state: admitted.state, code: admitted.code, message: admitted.message };
	}
	admission.onLease?.(admitted.lease);
	return {
		state: 'admitted',
		lease: admitted.lease,
		gate: leaseAdmission(admission.authority, admitted.lease),
		attribution,
		snapshot,
	};
}
