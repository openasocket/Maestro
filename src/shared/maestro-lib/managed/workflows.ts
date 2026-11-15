/**
 * Durable workflow ownership: how a Maestro host holds the owner fence of a
 * workflow (an Auto Run, a Cue pipeline) that a workflow owner producer issued,
 * and keeps holding it across retries, a restart and a stretch offline
 * (MRC-07-06, CP-03).
 *
 * The contract is the endpoint's workflow lifecycle (`workflow_claim`,
 * `workflow_renew`, `workflow_settle`, `workflow_release`, see
 * `./workflow-lifecycle`): a claim names the workflow, trigger, run and attempt
 * and the policy generation; the answer is `owned` with the owner, epoch and
 * token the registry holds, or a denial (`owner_unfenced`: another owner, a moved
 * epoch, a stale token). The registry is the one owner of epochs and tokens:
 * nothing here mints a fence. A first claim offers epoch 0 and a nonce the
 * registry may adopt or replace; what is held afterwards is the RECEIPT's
 * epoch and token, persisted (`<userData>/maestro-managed-workflows.json`) so
 * a retry, a resume and a restarted host re-claim with the same values and are
 * confirmed or fenced, never met as a second owner. An offline-enabled holder
 * keeps the fence it was issued while the producer is unreachable; a fenced
 * holder, a lost answer and a record under another authority answer no fence.
 * A missing producer is refused by name (no standing, no policy generation, no
 * port, or an endpoint serving no such operation: `capability-unsupported`,
 * which is what the reviewed daemon answers, CP-03, owner mega-maestro), and
 * nothing strips the workflow to fit a launch-only path. Cue and the Auto Run
 * engines stay the schedulers: they decide WHEN a run fires, this only whether
 * the installation owns it right now.
 */
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import type { AutoRunOwnerFence } from '../autorun/attribution';
import { readStoreDocument, writeStoreDocument, STORE_SCHEMA_KEY } from '../store/io';
import { sha256Hex } from './authority';
import {
	isEndpointIdentifier,
	type EndpointInvokeOutcome,
	type LocalEndpointDenialReason,
} from './endpoint-port';
import type { ManagedDenialCode } from './types';

export const MANAGED_WORKFLOWS_FILE_NAME = 'maestro-managed-workflows.json';

/** What every workflow producer names: an Auto Run identity and a Cue identity both satisfy it. */
export interface WorkflowIdentityLike {
	workflowId: string;
	version: string;
	triggerEventId: string;
}

/** Supplied only after authenticated negotiation of the workflow lifecycle.
 * This is a local port, not a wire DTO. The producer binds registration/delegation,
 * preserves the full input, reconciles prior pending operations on restart, and
 * confirms settlement before returning released. Expiry never transfers ownership.
 */
export interface WorkflowOwnerLifecyclePort {
	signal: AbortSignal;
	current(): boolean;
	invoke(
		action: 'claim' | 'renew' | 'release',
		input: WorkflowClaimInput,
		prior: HeldWorkflowOwnership | null,
		owner: WorkflowOwnerStanding,
		effect?: 'applied' | 'no_effect' | 'uncertain'
	): Promise<EndpointInvokeOutcome<unknown>>;
}

export interface WorkflowFenceLifetime {
	signal: AbortSignal;
	current(): boolean;
	finish(effect: 'applied' | 'no_effect' | 'uncertain'): Promise<void>;
}

/**
 * The producer as a host composes it: the lifecycle over an attached,
 * negotiated endpoint, or `unserved` when the attachment negotiated no owner
 * operation (the endpoint serves none to this peer, CP-03). Neither: no
 * producer is reachable right now.
 */
export interface WorkflowOwnerPort {
	lifecycle: WorkflowOwnerLifecyclePort | null;
	unserved?: true;
}

/**
 * A Maestro id as an endpoint identifier: itself when it already is one, else
 * a digest of it. Deterministic, so the registry sees one key per workflow
 * (`cue-pipeline:Nightly QA` and `operator:1760…` are not identifiers).
 */
export function workflowEndpointId(id: string): string {
	return isEndpointIdentifier(id) ? id : `wf-${sha256Hex(id).slice(0, 40)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
/**
 * What a record holds before the registry has issued an epoch (a first claim
 * that was fenced, or a lifecycle claim awaiting its answer). Not an epoch: it
 * never reaches a fence.
 */
export const UNISSUED_OWNER_EPOCH = 'unissued';

// ---------------------------------------------------------------------------
// What is held
// ---------------------------------------------------------------------------

/** `held`: the registry confirmed it. `fenced`: the registry named another owner. `unknown`: an answer was lost. */
export type HeldWorkflowState = 'held' | 'fenced' | 'unknown' | 'released';

export interface HeldWorkflowOwnership {
	workflowId: string;
	/** The identifier the registry knows the workflow by (`workflowEndpointId`). */
	endpointWorkflowId: string;
	version: string;
	triggerEventId: string;
	ownerId: string;
	/**
	 * The epoch the registry issued, as the opaque string the contract defines.
	 * Never counted or derived here; `UNISSUED_OWNER_EPOCH` until the registry
	 * has answered.
	 */
	ownerEpoch: string;
	expiresAt?: string;
	pending?: 'claim' | 'renew' | 'release';
	fencingToken: string;
	/** The authority the fence is good under; a record for another one is not a fence here. */
	authorityId: string;
	policyRevision: number;
	offlineEnabled: boolean;
	state: HeldWorkflowState;
	claimedAt: string;
	/** The last time the registry confirmed this owner, epoch and token. */
	confirmedAt: string;
	lastRunId: string;
	lastAttemptId: string;
	detail: string | null;
}

export interface WorkflowOwnershipDocument {
	[STORE_SCHEMA_KEY]: number;
	workflows: HeldWorkflowOwnership[];
}

export type WorkflowClaimOutcome =
	| {
			state: 'owned';
			fence: AutoRunOwnerFence & { lifetime?: WorkflowFenceLifetime };
			held: HeldWorkflowOwnership;
			/** `claimed`: newly issued; `confirmed`: the held values stand; `offline`: kept while the producer is unreachable. */
			disposition: 'claimed' | 'confirmed' | 'offline';
	  }
	| {
			state: 'denied';
			code: ManagedDenialCode;
			message: string;
			fenced: boolean;
			/** The producer's own denial reason, passed through unchanged when it answered one. */
			reason?: LocalEndpointDenialReason;
	  }
	| {
			state: 'unavailable';
			code: 'runtime-unavailable' | 'capability-unsupported';
			message: string;
	  }
	| { state: 'unknown'; code: 'outcome-unknown'; message: string };

/** What a sink's `workflowFence` seam gets back when there is no fence: the reason, never a bare null. */
export interface WorkflowFenceRefusal {
	fence: null;
	state: 'denied' | 'unavailable' | 'unknown';
	code: ManagedDenialCode;
	message: string;
}

export type WorkflowFenceAnswer =
	| (AutoRunOwnerFence & { lifetime?: WorkflowFenceLifetime })
	| WorkflowFenceRefusal
	| null;

export function isWorkflowFenceRefusal(
	answer: WorkflowFenceAnswer
): answer is WorkflowFenceRefusal {
	return answer !== null && 'fence' in answer && answer.fence === null;
}

/** The fence a claim produced, or why there is none, in the shape the seams read. */
export function workflowFenceOf(outcome: WorkflowClaimOutcome): WorkflowFenceAnswer {
	if (outcome.state === 'owned') return outcome.fence;
	return { fence: null, state: outcome.state, code: outcome.code, message: outcome.message };
}

/** The owner a claim is made as: this installation, under the authority it is enrolled with. */
export interface WorkflowOwnerStanding {
	ownerId: string;
	authorityId: string;
	policyRevision: number | null;
}

export interface WorkflowOwnershipDeps {
	file: string;
	/** The producer, read per claim; null while the host has none to offer (not attached, standalone). */
	port(): WorkflowOwnerPort | null;
	/** The standing a claim is made under, read per claim; null when this installation is not enrolled. */
	owner(): WorkflowOwnerStanding | null;
	now(): number;
	/** The nonce a first claim proposes as its token; the registry's answer replaces it. */
	newId?(): string;
	/** How many records to keep. Fenced and unknown ones go first, then the oldest held. */
	maxWorkflows?: number;
}

export interface WorkflowClaimInput {
	workflow: WorkflowIdentityLike;
	runId: string;
	attemptId: string;
	/** Whether this owner may keep the fence while the producer is unreachable. Default false. */
	offlineEnabled?: boolean;
}

export type WorkflowOwnershipLoad =
	| { ok: true; held: number }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

export interface WorkflowOwnership {
	readonly file: string;
	/** Read the file. Idempotent; `claim` and `fence` load on first use. */
	load(): Promise<WorkflowOwnershipLoad>;
	/**
	 * The fence this installation holds for a workflow right now, without asking
	 * the producer: the persisted record, when the registry confirmed it under
	 * the current authority. What a synchronous seam reads between claims.
	 */
	fence(workflow: WorkflowIdentityLike): AutoRunOwnerFence | null;
	/** Ask the producer to own, or re-confirm, the workflow for this run and attempt. */
	claim(input: WorkflowClaimInput): Promise<WorkflowClaimOutcome>;
	held(): readonly HeldWorkflowOwnership[];
}

const DEFAULT_MAX_WORKFLOWS = 500;

/** The endpoint's refusals that decide the claim, and the code each maps to; anything else is no decision. */
const DECIDED: Readonly<Partial<Record<LocalEndpointDenialReason, ManagedDenialCode>>> = {
	owner_unfenced: 'policy-denied',
	policy_denied: 'policy-denied',
	expired: 'policy-denied',
	budget_exhausted: 'policy-denied',
	unknown_price: 'policy-denied',
	untrusted_clock: 'policy-denied',
	replay: 'idempotency-conflict',
};

const HELD_IDS = ['workflowId', 'endpointWorkflowId', 'ownerId', 'fencingToken', 'authorityId'];

function heldProblem(value: unknown): string | null {
	if (!isRecord(value)) return 'a record is not an object';
	for (const key of HELD_IDS) {
		if (typeof value[key] !== 'string' || value[key] === '') return `${key} is not an id`;
	}
	if (typeof value.ownerEpoch !== 'string' || value.ownerEpoch === '')
		return 'ownerEpoch is not an opaque epoch';
	if (!['held', 'fenced', 'unknown', 'released'].includes(value.state as string))
		return 'state is unknown';
	return null;
}

export function createWorkflowOwnership(deps: WorkflowOwnershipDeps): WorkflowOwnership {
	const maxWorkflows = deps.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS;
	const newId =
		deps.newId ?? (() => `fence-${sha256Hex(`${deps.now()}-${Math.random()}`).slice(0, 32)}`);
	const claims = createKeyedWriteQueue();
	const live = new Map<
		string,
		{ lifetime: WorkflowFenceLifetime; controller: AbortController; clear(): void; stop(): void }
	>();
	let doc: WorkflowOwnershipDocument = { [STORE_SCHEMA_KEY]: 1, workflows: [] };
	let loading: Promise<WorkflowOwnershipLoad> | null = null;
	let loaded = false;
	const iso = (): string => new Date(deps.now()).toISOString();
	const find = (workflowId: string): HeldWorkflowOwnership | undefined =>
		doc.workflows.find((w) => w.workflowId === workflowId);

	function load(): Promise<WorkflowOwnershipLoad> {
		loading ??= (async () => {
			const read = await readStoreDocument<WorkflowOwnershipDocument>(deps.file, (value) => {
				if (!Array.isArray(value.workflows)) return 'workflows is not an array';
				for (const entry of value.workflows) {
					const problem = heldProblem(entry);
					if (problem) return problem;
				}
				return null;
			});
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return { ok: false, reason: read.status, file: deps.file, message: read.reason };
			}
			if (read.status === 'ok') {
				doc = read.data;
			}
			loaded = true;
			return { ok: true, held: doc.workflows.filter((w) => w.state === 'held').length };
		})();
		return loading;
	}

	async function persist(): Promise<void> {
		if (doc.workflows.length > maxWorkflows) {
			const rank = (w: HeldWorkflowOwnership) => (w.state === 'held' ? 1 : 0);
			const ordered = doc.workflows.sort(
				(a, b) => rank(a) - rank(b) || a.confirmedAt.localeCompare(b.confirmedAt)
			);
			const dropped = new Set(ordered.slice(0, doc.workflows.length - maxWorkflows));
			doc.workflows = doc.workflows.filter((w) => !dropped.has(w));
		}
		await writeStoreDocument(deps.file, doc);
	}

	async function upsert(
		existing: HeldWorkflowOwnership | undefined,
		next: HeldWorkflowOwnership
	): Promise<HeldWorkflowOwnership> {
		if (existing) Object.assign(existing, next);
		else doc.workflows.push(next);
		await persist();
		return existing ?? next;
	}

	async function lifecycleClaim(
		input: WorkflowClaimInput,
		port: WorkflowOwnerLifecyclePort,
		action: 'claim' | 'renew' | 'release' = 'claim',
		effect?: 'applied' | 'no_effect' | 'uncertain'
	): Promise<WorkflowClaimOutcome> {
		const key = input.workflow.workflowId;
		const existing = find(key);
		const owner = deps.owner();
		const unavailable = (message: string): WorkflowClaimOutcome => ({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message,
		});
		const stop = () => {
			live.get(key)?.stop();
			live.delete(key);
		};
		if (!owner || owner.policyRevision === null || !port.current() || port.signal.aborted) {
			stop();
			return unavailable('No current authenticated workflow lifecycle authority.');
		}
		if (
			existing &&
			(existing.ownerId !== owner.ownerId || existing.authorityId !== owner.authorityId)
		) {
			stop();
			return unavailable('Existing workflow custody belongs to another owner or authority.');
		}
		if (!existing && doc.workflows.length >= maxWorkflows)
			return unavailable(
				'Workflow custody storage is full; unresolved ownership cannot be discarded.'
			);
		const standing = { ...owner };
		const prior = existing ? { ...existing } : null;
		const active = live.get(key);
		const pending: HeldWorkflowOwnership = {
			workflowId: key,
			endpointWorkflowId: workflowEndpointId(key),
			version: input.workflow.version,
			triggerEventId: input.workflow.triggerEventId,
			ownerId: owner.ownerId,
			ownerEpoch: prior?.ownerEpoch ?? UNISSUED_OWNER_EPOCH,
			fencingToken: prior?.fencingToken ?? workflowEndpointId(newId()),
			authorityId: owner.authorityId,
			policyRevision: owner.policyRevision,
			offlineEnabled: false,
			state: 'unknown',
			claimedAt: prior?.claimedAt ?? iso(),
			confirmedAt: prior?.confirmedAt ?? iso(),
			lastRunId: input.runId,
			lastAttemptId: input.attemptId,
			pending: action,
			expiresAt: prior?.expiresAt,
			detail: 'Workflow operation awaiting producer reconciliation.',
		};
		if (action === 'release') stop();
		const valid = () => {
			const current = deps.owner();
			return (
				port.current() &&
				!port.signal.aborted &&
				deps.port()?.lifecycle === port &&
				current?.ownerId === standing.ownerId &&
				current.authorityId === standing.authorityId &&
				current.policyRevision === standing.policyRevision &&
				(action !== 'renew' || (!!active && !active.lifetime.signal.aborted))
			);
		};
		try {
			await upsert(existing, pending);
			if (!valid()) {
				stop();
				return unavailable('Workflow authority changed before dispatch.');
			}
			const outcome = await port.invoke(
				action,
				structuredClone(input),
				structuredClone(prior),
				{ ...standing },
				effect
			);

			const receipt =
				outcome.status === 'ok' && isRecord(outcome.payload)
					? structuredClone(outcome.payload)
					: null;
			const expires =
				receipt && typeof receipt.expiresAt === 'string' ? Date.parse(receipt.expiresAt) : NaN;
			const sameFence =
				receipt &&
				prior &&
				prior.version === input.workflow.version &&
				prior.triggerEventId === input.workflow.triggerEventId &&
				receipt.ownerEpoch === prior.ownerEpoch &&
				receipt.fencingToken === prior.fencingToken;
			if (
				!valid() ||
				!receipt ||
				receipt.workflowId !== pending.endpointWorkflowId ||
				receipt.ownerId !== standing.ownerId ||
				!isEndpointIdentifier(receipt.ownerEpoch) ||
				!isEndpointIdentifier(receipt.fencingToken) ||
				receipt.outcome !== { claim: 'owned', renew: 'renewed', release: 'released' }[action] ||
				(action !== 'claim' && !sameFence) ||
				(action !== 'release' && !(expires > deps.now() && expires - deps.now() <= 300_000))
			) {
				stop();
				if (outcome.status === 'denied' && outcome.reason === 'owner_unfenced') {
					await upsert(find(key), {
						...pending,
						state: 'fenced',
						detail: 'The producer fenced this owner.',
					});
					return {
						state: 'denied',
						code: 'policy-denied',
						message: 'The producer fenced this workflow owner.',
						fenced: true,
						reason: outcome.reason,
					};
				}
				if (outcome.status === 'denied') {
					// A decided refusal: nothing was claimed, renewed or released, so what
					// was held before this operation is what stays held.
					doc.workflows = prior
						? doc.workflows.map((w) => (w.workflowId === key ? { ...prior } : w))
						: doc.workflows.filter((w) => w.workflowId !== key);
					await persist();
					return {
						state: 'denied',
						code: DECIDED[outcome.reason] ?? 'policy-denied',
						message: `The producer refused to ${action} workflow "${key}": ${outcome.reason}.`,
						fenced: false,
						reason: outcome.reason,
					};
				}
				return {
					state: 'unknown',
					code: 'outcome-unknown',
					message: 'Workflow custody is uncertain; producer reconciliation is required.',
				};
			}
			const kept = await upsert(find(key), {
				...pending,
				ownerEpoch: receipt.ownerEpoch,
				fencingToken: receipt.fencingToken,
				state: action === 'release' ? 'released' : 'held',
				pending: undefined,
				expiresAt: action === 'release' ? undefined : (receipt.expiresAt as string),
				confirmedAt: iso(),
				detail: null,
			});
			if (!valid() || (action !== 'release' && expires <= deps.now())) {
				stop();
				return unavailable('Workflow authority changed during persistence.');
			}
			if (action === 'release')
				return unavailable('Workflow ownership was released by the producer.');
			const previous = live.get(key);
			if (!sameFence) stop();
			const controller = previous && sameFence ? previous.controller : new AbortController();
			const signal = controller.signal;
			const expire = setTimeout(() => {
				stop();
			}, expires - deps.now());
			expire.unref?.();
			const revoke = () => stop();
			port.signal.addEventListener('abort', revoke, { once: true });
			const lifetime: WorkflowFenceLifetime = {
				signal,
				current: () =>
					!signal.aborted &&
					port.current() &&
					!port.signal.aborted &&
					deps.port()?.lifecycle === port &&
					deps.owner()?.ownerId === standing.ownerId &&
					deps.owner()?.authorityId === standing.authorityId &&
					deps.owner()?.policyRevision === standing.policyRevision &&
					Date.parse(find(key)?.expiresAt ?? '') > deps.now(),
				finish: async (result) => {
					if (signal.aborted) return;
					if (find(key)?.pending === 'renew' && find(key)?.lastAttemptId === input.attemptId) {
						stop();
						return;
					}
					await claims.enqueue(key, async () => {
						const latest = find(key);
						if (
							!latest ||
							latest.ownerEpoch !== receipt.ownerEpoch ||
							latest.fencingToken !== receipt.fencingToken ||
							latest.lastRunId !== input.runId ||
							latest.lastAttemptId !== input.attemptId ||
							latest.state === 'released'
						)
							return;
						await lifecycleClaim(input, port, 'release', result);
					});
				},
			};
			previous?.clear();
			const clear = () => {
				clearTimeout(expire);
				clearTimeout(renewal);
				port.signal.removeEventListener('abort', revoke);
			};
			live.set(key, {
				lifetime,
				controller,
				clear,
				stop: () => {
					clear();
					controller.abort();
				},
			});
			const renewal = setTimeout(
				() => {
					void claims.enqueue(key, () => lifecycleClaim(input, port, 'renew'));
				},
				Math.max(1, (expires - deps.now()) / 2)
			);
			renewal.unref?.();
			return {
				state: 'owned',
				fence: { ...fenceOf(kept), lifetime },
				held: { ...kept },
				disposition: sameFence ? 'confirmed' : 'claimed',
			};
		} catch {
			stop();
			return {
				state: 'unknown',
				code: 'outcome-unknown',
				message: 'Workflow operation or custody persistence failed; reconciliation is required.',
			};
		}
	}

	async function claim(input: WorkflowClaimInput): Promise<WorkflowClaimOutcome> {
		const { workflow } = input;
		const port = deps.port();
		if (port?.lifecycle) return lifecycleClaim(input, port.lifecycle);
		if (port?.unserved) {
			live.get(workflow.workflowId)?.stop();
			live.delete(workflow.workflowId);
			return {
				state: 'unavailable',
				code: 'capability-unsupported',
				message: `The endpoint serves no workflow owner operation, so workflow "${workflow.workflowId}" has no owner producer (CP-03, owner mega-maestro).`,
			};
		}
		const owner = deps.owner();
		if (!owner) {
			return {
				state: 'unavailable',
				code: 'runtime-unavailable',
				message: `This installation holds no managed standing to own workflow "${workflow.workflowId}" under.`,
			};
		}
		return {
			state: 'unavailable',
			code: 'runtime-unavailable',
			message: `No workflow owner producer is attached, so workflow "${workflow.workflowId}" cannot be claimed (CP-03, owner mega-maestro).`,
		};
	}

	return {
		file: deps.file,
		load,
		fence(workflow) {
			if (!loaded) return null;
			const owner = deps.owner();
			const record = find(workflow.workflowId);
			if (!record || !owner || record.state !== 'held' || record.authorityId !== owner.authorityId)
				return null;
			// A held fence is good only while its lease is live: custody is never kept
			// past the producer that issued it.
			return live.get(workflow.workflowId)?.lifetime.current() ? fenceOf(record) : null;
		},
		async claim(input) {
			input = structuredClone(input);
			const read = await load();
			if (!read.ok) {
				return {
					state: 'unavailable',
					code: 'runtime-unavailable',
					message: `The workflow ownership store cannot be read (${read.reason}): ${read.message}`,
				};
			}
			return claims.enqueue(input.workflow.workflowId, () => claim(input));
		},
		held: () => doc.workflows.map((record) => ({ ...record })),
	};
}

/** The contract's fence of a held record: the registry's opaque epoch, unchanged. */
function fenceOf(
	record: Pick<HeldWorkflowOwnership, 'ownerId' | 'ownerEpoch' | 'fencingToken'>
): AutoRunOwnerFence {
	return {
		ownerId: record.ownerId,
		ownerEpoch: record.ownerEpoch,
		fencingToken: record.fencingToken,
	};
}
