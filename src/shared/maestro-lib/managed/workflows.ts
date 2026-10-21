/**
 * Durable workflow ownership: how a Maestro host holds the owner fence of a
 * workflow (an Auto Run, a Cue pipeline) that a workflow owner producer issued,
 * and keeps holding it across retries, a restart and a stretch offline
 * (MRC-07-06, CP-03).
 *
 * The contract is the endpoint's `workflow` operation (local-endpoint protocol
 * 1): a claim names the workflow, trigger, run and attempt, the owner with the
 * epoch and fencing token it holds, whether it may keep running offline, and
 * the policy generation; the answer is `owned` with the owner, epoch and token
 * the registry holds, or a denial (`owner_unfenced`: another owner, a moved
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
	type EndpointPort,
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

/** The endpoint's `workflow` request, transcribed. Every id is an endpoint identifier. */
export interface WorkflowOwnerRequest {
	workflowId: string;
	triggerId: string;
	runId: string;
	attemptId: string;
	ownerId: string;
	ownerEpoch: number;
	fencingToken: string;
	offlineEnabled: boolean;
	policyRevision: number;
}

/** The registry's answer: who owns the workflow, at which epoch, under which token. */
export interface WorkflowOwnerReceipt {
	outcome: 'owned';
	workflowId: string;
	ownerId: string;
	ownerEpoch: number;
	fencingToken: string;
}

/** The producer port. A host builds it over its endpoint socket; a test injects a table. */
export interface WorkflowOwnerPort {
	claim(request: WorkflowOwnerRequest): Promise<EndpointInvokeOutcome<unknown>>;
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
const isEpoch = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The problems with a value offered as a receipt for `request`; empty when it is one. */
export function workflowOwnerReceiptProblems(
	value: unknown,
	request: Pick<WorkflowOwnerRequest, 'workflowId'>
): string[] {
	if (!isRecord(value)) return ['receipt is not an object'];
	const problems: string[] = [];
	if (value.outcome !== 'owned') problems.push('outcome is not owned');
	if (value.workflowId !== request.workflowId) problems.push('workflowId is not the one claimed');
	if (!isEndpointIdentifier(value.ownerId)) problems.push('ownerId is not an identifier');
	if (!isEpoch(value.ownerEpoch)) problems.push('ownerEpoch is not a count');
	if (!isEndpointIdentifier(value.fencingToken)) problems.push('fencingToken is not an identifier');
	return problems;
}

/** The port over an attached endpoint socket. The client decides unavailable vs unknown. */
export function endpointWorkflowOwnerPort(
	endpoint: Pick<EndpointPort, 'invoke'>
): WorkflowOwnerPort {
	return { claim: (request) => endpoint.invoke('workflow', request) };
}

// ---------------------------------------------------------------------------
// What is held
// ---------------------------------------------------------------------------

/** `held`: the registry confirmed it. `fenced`: the registry named another owner. `unknown`: an answer was lost. */
export type HeldWorkflowState = 'held' | 'fenced' | 'unknown';

export interface HeldWorkflowOwnership {
	workflowId: string;
	/** The identifier the registry knows the workflow by (`workflowEndpointId`). */
	endpointWorkflowId: string;
	version: string;
	triggerEventId: string;
	ownerId: string;
	ownerEpoch: number;
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
			fence: AutoRunOwnerFence;
			held: HeldWorkflowOwnership;
			/** `claimed`: newly issued; `confirmed`: the held values stand; `offline`: kept while the producer is unreachable. */
			disposition: 'claimed' | 'confirmed' | 'offline';
	  }
	| { state: 'denied'; code: ManagedDenialCode; message: string; fenced: boolean }
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

export type WorkflowFenceAnswer = AutoRunOwnerFence | WorkflowFenceRefusal | null;

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
	if (!isEpoch(value.ownerEpoch)) return 'ownerEpoch is not a count';
	if (!['held', 'fenced', 'unknown'].includes(value.state as string)) return 'state is unknown';
	return null;
}

export function createWorkflowOwnership(deps: WorkflowOwnershipDeps): WorkflowOwnership {
	const maxWorkflows = deps.maxWorkflows ?? DEFAULT_MAX_WORKFLOWS;
	const newId =
		deps.newId ?? (() => `fence-${sha256Hex(`${deps.now()}-${Math.random()}`).slice(0, 32)}`);
	const claims = createKeyedWriteQueue();
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
			if (read.status === 'ok') doc = read.data;
			loaded = true;
			return { ok: true, held: doc.workflows.filter((w) => w.state === 'held').length };
		})();
		return loading;
	}

	async function persist(): Promise<void> {
		if (doc.workflows.length > maxWorkflows) {
			const rank = (w: HeldWorkflowOwnership) => (w.state === 'held' ? 1 : 0);
			const ordered = [...doc.workflows].sort(
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

	async function claim(input: WorkflowClaimInput): Promise<WorkflowClaimOutcome> {
		const { workflow } = input;
		const at = iso();
		const unavailable = (
			message: string,
			code: 'runtime-unavailable' | 'capability-unsupported' = 'runtime-unavailable'
		): WorkflowClaimOutcome => ({ state: 'unavailable', code, message });
		const fencedBy = (message: string): WorkflowClaimOutcome => ({
			state: 'denied',
			code: 'policy-denied',
			message,
			fenced: true,
		});
		const owner = deps.owner();
		if (!owner) {
			return unavailable(
				`This installation holds no managed standing to own workflow "${workflow.workflowId}" under.`
			);
		}
		if (owner.policyRevision === null) {
			return unavailable(
				`No policy revision is known for this host, so workflow "${workflow.workflowId}" cannot be claimed under one.`
			);
		}
		const existing = find(workflow.workflowId);
		// A record under the current authority is what this host holds; one from
		// another enrollment is evidence of nothing and is replaced by the answer.
		const prior = existing && existing.authorityId === owner.authorityId ? existing : undefined;
		const request: WorkflowOwnerRequest = {
			workflowId: workflowEndpointId(workflow.workflowId),
			triggerId: workflowEndpointId(workflow.triggerEventId),
			runId: workflowEndpointId(input.runId),
			attemptId: workflowEndpointId(input.attemptId),
			ownerId: owner.ownerId,
			ownerEpoch: prior?.ownerEpoch ?? 0,
			fencingToken: prior?.fencingToken ?? workflowEndpointId(newId()),
			offlineEnabled: input.offlineEnabled ?? false,
			policyRevision: owner.policyRevision,
		};
		const held = (
			receipt: Pick<WorkflowOwnerReceipt, 'ownerEpoch' | 'fencingToken'>,
			state: HeldWorkflowState,
			detail: string | null
		): HeldWorkflowOwnership => ({
			workflowId: workflow.workflowId,
			endpointWorkflowId: request.workflowId,
			version: workflow.version,
			triggerEventId: workflow.triggerEventId,
			ownerId: owner.ownerId,
			ownerEpoch: receipt.ownerEpoch,
			fencingToken: receipt.fencingToken,
			authorityId: owner.authorityId,
			policyRevision: owner.policyRevision as number,
			offlineEnabled: request.offlineEnabled,
			state,
			claimedAt: prior?.claimedAt ?? at,
			confirmedAt: state === 'held' ? at : (prior?.confirmedAt ?? at),
			lastRunId: input.runId,
			lastAttemptId: input.attemptId,
			detail,
		});
		const offline = async (message: string): Promise<WorkflowClaimOutcome> => {
			if (prior?.state === 'held' && prior.offlineEnabled) {
				const kept = await upsert(existing, {
					...prior,
					lastRunId: input.runId,
					lastAttemptId: input.attemptId,
					detail: message,
				});
				return { state: 'owned', fence: fenceOf(kept), held: kept, disposition: 'offline' };
			}
			return unavailable(message);
		};

		const port = deps.port();
		if (!port) {
			return offline(
				`No workflow owner producer is attached, so workflow "${workflow.workflowId}" cannot be claimed (CP-03, owner mega-maestro).`
			);
		}
		const outcome = await port.claim(request);
		switch (outcome.status) {
			case 'unavailable':
				return offline(`The workflow owner producer could not be reached: ${outcome.message}`);
			case 'unknown': {
				if (prior) await upsert(existing, { ...prior, state: 'unknown', detail: outcome.message });
				return {
					state: 'unknown',
					code: 'outcome-unknown',
					message: `The answer to the claim on workflow "${workflow.workflowId}" was lost: ${outcome.message}`,
				};
			}
			case 'denied': {
				const code = DECIDED[outcome.reason];
				if (outcome.reason === 'owner_unfenced') {
					await upsert(
						existing,
						held(request, 'fenced', 'The registry holds another owner, epoch or token.')
					);
					return fencedBy(
						`Workflow "${workflow.workflowId}" is fenced: the registry holds another owner, epoch or token, and this host is not its owner.`
					);
				}
				if (code) {
					return {
						state: 'denied',
						code,
						message: `The registry refused the claim on workflow "${workflow.workflowId}": ${outcome.reason}.`,
						fenced: false,
					};
				}
				if (outcome.reason === 'unsupported_capability') {
					return unavailable(
						`The endpoint serves no workflow owner operation, so workflow "${workflow.workflowId}" has no owner producer (CP-03, owner mega-maestro).`,
						'capability-unsupported'
					);
				}
				return unavailable(
					`The endpoint did not decide the claim on workflow "${workflow.workflowId}": ${outcome.reason}.`
				);
			}
			case 'ok':
				break;
		}
		const problems = workflowOwnerReceiptProblems(outcome.payload, request);
		if (problems.length > 0) {
			if (prior)
				await upsert(existing, { ...prior, state: 'unknown', detail: problems.join('; ') });
			return {
				state: 'unknown',
				code: 'outcome-unknown',
				message: `The registry answered the claim on workflow "${workflow.workflowId}" with a receipt that is not one: ${problems.join('; ')}.`,
			};
		}
		const receipt = outcome.payload as WorkflowOwnerReceipt;
		if (receipt.ownerId !== owner.ownerId) {
			await upsert(
				existing,
				held(receipt, 'fenced', `The registry holds owner ${receipt.ownerId}.`)
			);
			return fencedBy(
				`Workflow "${workflow.workflowId}" is owned by ${receipt.ownerId}, not this installation.`
			);
		}
		const confirmed =
			prior?.state === 'held' &&
			prior.ownerEpoch === receipt.ownerEpoch &&
			prior.fencingToken === receipt.fencingToken;
		const kept = await upsert(existing, held(receipt, 'held', null));
		return {
			state: 'owned',
			fence: fenceOf(kept),
			held: kept,
			disposition: confirmed ? 'confirmed' : 'claimed',
		};
	}

	return {
		file: deps.file,
		load,
		fence(workflow) {
			if (!loaded) return null;
			const owner = deps.owner();
			const record = find(workflow.workflowId);
			return record && owner && record.state === 'held' && record.authorityId === owner.authorityId
				? fenceOf(record)
				: null;
		},
		async claim(input) {
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
		held: () => doc.workflows,
	};
}

/** The contract's fence of a held record: the registry's epoch, as the string the workflow reference carries. */
function fenceOf(
	record: Pick<HeldWorkflowOwnership, 'ownerEpoch' | 'fencingToken'>
): AutoRunOwnerFence {
	return { ownerEpoch: String(record.ownerEpoch), fencingToken: record.fencingToken };
}
