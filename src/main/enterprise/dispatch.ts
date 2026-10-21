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
	dispatchSnapshotDigest,
	type AdmissionRequest,
	type DispatchLease,
	type HostAuthority,
	type LeaseRelease,
	type ManagedDecisionReceipt,
} from '../../shared/maestro-lib/managed/authority';
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
	startTurn,
	type DispatchAdmission,
	type TurnExit,
} from '../../shared/maestro-lib/run/start-turn';
import type { ManagedTurnAuthority } from '../../shared/maestro-lib/turns/run-agent-turn';

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
	const gate: DispatchAdmission = {
		admit(final) {
			const verdict = turn.authority.check(lease, dispatchSnapshotDigest(final));
			return verdict.ok
				? { ok: true }
				: {
						ok: false,
						state: 'denied',
						code: 'lease-invalid',
						message: `The lease for this launch is ${verdict.reason}.`,
					};
		},
		bound: (pid) => lease.bind(pid),
		released: (exit) =>
			lease.release(
				exit.spawnError
					? { outcome: 'spawn-failed', message: exit.spawnError.message }
					: exit.stoppedBy
						? { outcome: 'stopped', by: exit.stoppedBy }
						: { outcome: 'exited', exitCode: exit.exitCode, signal: exit.signal }
			),
		onRevoked: (listener) => lease.onRevoked(listener),
	};

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
