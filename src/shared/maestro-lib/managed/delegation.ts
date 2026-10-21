/**
 * Delegated dispatch: the causal context one managed operation hands to a
 * child it starts, and the rules the child's host applies to it (MRC-07-04).
 *
 * A Cue run dispatching to another agent, an agent asking another from its
 * shell, a consult a turn fans out: each is a CHILD of the operation that
 * initiated it, started on a sink the initiator never sees. Without the
 * initiator's context the child arrives anonymous and is admitted as a fresh
 * action of the target: the workflow, the chain and the policy generation end
 * at the hand-off, the nested execution a managed restriction must survive.
 * So the initiator hands over one serializable record
 * ({@link ManagedDelegationContext}) and the child's host derives its own from
 * it ({@link childDelegationContext}). Nothing is stripped to fit: an unknown
 * field is refused, a chain or workflow the host cannot bind is refused by the
 * host, a managed initiator's child on an unenrolled host is refused there
 * ({@link intersectDelegationScope}), never run unmanaged. The record is
 * attribution, not authority: the receiving host verifies it against its own
 * peer and asks its own authority at effect time; carrying one grants nothing.
 */

import { canonicalJson } from '../../canonicalJson';
import {
	MANAGED_CONTRACT_VERSION,
	managedContextProblems,
	type ManagedContractVersion,
	type ManagedDelegationRef,
	type ManagedDenialCode,
	type ManagedOperationContext,
	type ManagedPrincipalRef,
	type ManagedRunIdentity,
	type ManagedWorkflowRef,
} from './types';

/**
 * Where a child process reads its initiator's context: stamped by the spawner
 * over anything inherited, so a grandchild never carries a record from two
 * hops up. A stable external contract, like `MAESTRO_QUERY_SOURCE`.
 */
export const MANAGED_DELEGATION_ENV_VAR = 'MAESTRO_DELEGATION_CONTEXT';

/** How many principals a delegation chain may hold. A dispatch loop grows the chain by one per hop. */
export const MAX_DELEGATION_DEPTH = 16;

/** The encoded record is refused past this length; a chain at the depth bound fits with room to spare. */
export const MAX_DELEGATION_ENV_LENGTH = 32_768;

/**
 * The causal context of one operation, as its initiator hands it to a child:
 * the attribution half of a `ManagedOperationContext`. The installation,
 * origin and actor are the CHILD host's own, bound there, never carried.
 */
export interface ManagedDelegationContext {
	contractVersion: ManagedContractVersion;
	/** The initiating run. A child is parented under `runId` and shares `rootRunId`. */
	identity: ManagedRunIdentity;
	traceId: string;
	/** The initiator's workflow with its owner fence, carried as is; null when it belongs to none. */
	workflow: ManagedWorkflowRef | null;
	/** The principals behind the initiator, outermost first, the initiator's own last. */
	delegation: ManagedDelegationRef;
	/** The policy generation the initiator was admitted under; null when it ran unmanaged. */
	policyRevision: number | null;
}

const DELEGATION_FIELDS = [
	'contractVersion',
	'identity',
	'traceId',
	'workflow',
	'delegation',
	'policyRevision',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** A valid stand-in for the uncarried fields, so `managedContextProblems` checks the carried half by the one set of rules. */
const PROBE_CONTEXT = Object.freeze({
	installation: { installationId: 'probe', runtimeId: 'probe', processEpoch: 'probe' },
	origin: 'cli',
	actor: { kind: 'service', id: 'probe' },
	requestedCapabilities: [],
} as const);

/**
 * The structural problems with a value offered as a delegation context: the
 * version ours, every field known, every id bounded, the chain within depth.
 * An unknown field is a problem, not something to drop: a producer that knows
 * more than this reader is refused, never flattened into what it understands.
 */
export function delegationContextProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['delegation context is not an object'];
	const problems: string[] = [];
	for (const key of Object.keys(value)) {
		if (!(DELEGATION_FIELDS as readonly string[]).includes(key)) {
			problems.push(`unknown field "${key}"`);
		}
	}
	const { contractVersion, identity, traceId, workflow, delegation, policyRevision } = value;
	problems.push(
		...managedContextProblems({
			...PROBE_CONTEXT,
			contractVersion,
			identity,
			traceId,
			workflow: workflow === undefined ? null : workflow,
			delegation,
			policyRevision: policyRevision === undefined ? null : policyRevision,
		})
	);
	if (workflow === undefined) problems.push('workflow is missing');
	if (policyRevision === undefined) problems.push('policyRevision is missing');
	if (isRecord(delegation) && Array.isArray(delegation.chain)) {
		if (delegation.chain.length > MAX_DELEGATION_DEPTH) {
			problems.push(`delegation.chain exceeds ${MAX_DELEGATION_DEPTH} links`);
		}
	}
	return problems;
}

/** `delegationContextProblems(value).length === 0`, as a type guard. */
export function isManagedDelegationContext(value: unknown): value is ManagedDelegationContext {
	return delegationContextProblems(value).length === 0;
}

/**
 * The context an operation hands its children, read off the context it runs
 * under: a verified managed context, or the lineage a standalone host built
 * (workflow null, no policy generation). One shape either way.
 */
export function delegationContextOf(
	context: Pick<
		ManagedOperationContext,
		'identity' | 'traceId' | 'workflow' | 'delegation' | 'policyRevision'
	>
): ManagedDelegationContext {
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		identity: { ...context.identity },
		traceId: context.traceId,
		workflow: context.workflow ? { ...context.workflow } : null,
		delegation: {
			chain: context.delegation.chain.map((link) => ({ ...link })),
			grantRef: context.delegation.grantRef,
		},
		policyRevision: context.policyRevision,
	};
}

/** What a child needs of its own: the principal it is handed to, and its request and attempt ids. */
export interface ChildDispatchInput {
	/** The principal the work is handed to (the target agent, a consult service); appended to the chain. */
	link: ManagedPrincipalRef;
	requestId: string;
	attemptId: string;
	/** Default `requestId`: one logical submission per child request. */
	idempotencyKey?: string;
}

/** The run the child is parented under: the initiator's run, or its request when it names no run. */
const parentRunOf = (parent: ManagedDelegationContext): string =>
	parent.identity.runId ?? parent.identity.requestId;

/** The root the child shares: the initiator's root, else the initiator's own run. */
const rootRunOf = (parent: ManagedDelegationContext): string =>
	parent.identity.rootRunId ?? parentRunOf(parent);

/**
 * The child's context, derived from its initiator's: the chain one link deeper,
 * the run parented under the initiator's and sharing its root, the workflow,
 * grant reference and claimed policy generation carried as they are. The child
 * host intersects that claim with its own standing ({@link intersectDelegationScope}).
 */
export function childDelegationContext(
	parent: ManagedDelegationContext,
	input: ChildDispatchInput
): ManagedDelegationContext {
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		identity: {
			requestId: input.requestId,
			idempotencyKey: input.idempotencyKey ?? input.requestId,
			attemptId: input.attemptId,
			runId: input.requestId,
			rootRunId: rootRunOf(parent),
			parentRunId: parentRunOf(parent),
		},
		// Root, own request and attempt, as a Cue trace is formed: the parent is
		// named by `parentRunId`, not embedded, so the trace stays bounded at any depth.
		traceId: `delegated:${rootRunOf(parent)}:${input.requestId}:${input.attemptId}`,
		workflow: parent.workflow ? { ...parent.workflow } : null,
		delegation: {
			chain: [...parent.delegation.chain.map((link) => ({ ...link })), { ...input.link }],
			grantRef: parent.delegation.grantRef,
		},
		policyRevision: parent.policyRevision,
	};
}

/** The standing of the host a child lands on, as its spawn port reports it. */
export interface DelegationHostScope {
	standing: 'standalone' | 'managed';
	/** The policy generation the host holds now; null when it holds none. */
	policyRevision: number | null;
}

/** The scope a child runs in, or why it runs nowhere. */
export type DelegationScope =
	| {
			ok: true;
			/** The generation the child is admitted under: the host's own, never the initiator's claim. */
			policyRevision: number | null;
			/** The initiator was admitted under another generation; the child is decided afresh under this one. */
			reauthorized: boolean;
	  }
	| { ok: false; state: 'unavailable'; code: ManagedDenialCode; message: string };

/**
 * Intersect the initiator's scope with the host the child lands on; the
 * narrower wins and nothing widens. A managed initiator's child on a host with
 * no enrollment is refused (a hand-off is not a way out of management); a
 * managed host admits under ITS current generation, whatever the initiator
 * claimed (reauthorized at effect time); unmanaged on standalone is ordinary.
 * The workflow and the chain are carried as they are; a host that cannot bind
 * them refuses them.
 */
export function intersectDelegationScope(
	initiator: Pick<ManagedDelegationContext, 'policyRevision' | 'identity'>,
	host: DelegationHostScope
): DelegationScope {
	if (host.standing === 'standalone') {
		if (initiator.policyRevision !== null) {
			return {
				ok: false,
				state: 'unavailable',
				code: 'runtime-unavailable',
				message: `The initiating run ${initiator.identity.requestId} was admitted under policy revision ${initiator.policyRevision}; this host holds no enrollment, so its child cannot be admitted under one and does not run unmanaged in its place.`,
			};
		}
		return { ok: true, policyRevision: null, reauthorized: false };
	}
	return {
		ok: true,
		policyRevision: host.policyRevision,
		reauthorized: initiator.policyRevision !== host.policyRevision,
	};
}

/**
 * Whether a child may write, given what its initiator may. A child never
 * gains an effect its initiator lacked: a read-only initiator's consult or
 * dispatch is read-only whatever the target's own setting says. An initiator
 * whose access is unknown (`null`) does not narrow the request.
 */
export function delegatedWritable(initiatorWritable: boolean | null, requested: boolean): boolean {
	return requested && initiatorWritable !== false;
}

/** The record as it travels: canonical JSON, so two encodings of one context compare equal. */
export function encodeDelegationContext(context: ManagedDelegationContext): string {
	return canonicalJson(context);
}

/** The env entry a spawner stamps on a child. Spread over the inherited environment, after it. */
export function delegationContextEnv(context: ManagedDelegationContext): Record<string, string> {
	return { [MANAGED_DELEGATION_ENV_VAR]: encodeDelegationContext(context) };
}

export type DelegationContextRead =
	| { status: 'absent' }
	| { status: 'ok'; context: ManagedDelegationContext }
	/** Something was offered and it is not a context. The reader refuses the child, it does not run it anonymous. */
	| { status: 'invalid'; problems: string[] };

/**
 * Read the initiator's context out of an environment. A blank entry is absent
 * (a blank env value means "unset" everywhere in Maestro); anything else is a
 * context or a refusal with the problems named, never a child run as a fresh action.
 */
export function readDelegationContextEnv(
	env: Readonly<Record<string, string | undefined>>
): DelegationContextRead {
	const raw = env[MANAGED_DELEGATION_ENV_VAR]?.trim();
	if (!raw) return { status: 'absent' };
	if (raw.length > MAX_DELEGATION_ENV_LENGTH) {
		return {
			status: 'invalid',
			problems: [`the encoded context exceeds ${MAX_DELEGATION_ENV_LENGTH} characters`],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			status: 'invalid',
			problems: [`the encoded context is not JSON: ${(error as Error).message}`],
		};
	}
	const problems = delegationContextProblems(parsed);
	if (problems.length > 0) return { status: 'invalid', problems };
	return { status: 'ok', context: parsed as ManagedDelegationContext };
}
