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
import type {
	AdmissionRequest,
	DispatchLease,
	HostAuthority,
	LeaseRelease,
	ManagedDecisionReceipt,
} from '../../shared/maestro-lib/managed/authority';
import type { ManagedHostAdapter } from '../../shared/maestro-lib/managed/host-adapter';
import type {
	ManagedAuthenticatedContext,
	ManagedPrincipalRef,
} from '../../shared/maestro-lib/managed/types';
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

	async function persist(): Promise<void> {
		trim();
		if (!deps.file) return;
		try {
			await writeStoreDocument(deps.file, doc);
		} catch (error) {
			failures += 1;
			deps.onPersistError?.(error);
		}
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
	};
}
