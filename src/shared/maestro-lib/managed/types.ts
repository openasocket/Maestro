/**
 * Generic managed-operation contracts: the shapes a management peer (an
 * enterprise endpoint, a fleet controller, a test harness) and a Maestro host
 * exchange when an operation runs under management.
 *
 * These are Maestro's own, generic types. They name no enterprise product and
 * import nothing from one: Mega-Maestro's wire schemas stay in the package
 * `scripts/import-mega-maestro.mjs` brings in, and an adapter maps between the
 * two. Serializable records only (JSON in, JSON out), so they cross an IPC
 * bridge, a WebSocket and a process boundary unchanged.
 *
 * What the types deliberately do NOT carry:
 *   - Authority. A context is attribution: it says who asks, for which run,
 *     under which delegation reference. It does not say the host should
 *     comply. Authority is bound by the host at the authoritative sink (phase
 *     2), from a verified peer and policy state, never from prompt text, a
 *     caller-supplied boolean, a label or an environment variable.
 *   - Secrets. Grants, leases and credentials travel as opaque references.
 *
 * Identity is layered on purpose: an installation outlives a runtime process,
 * a process epoch changes on every start, and a request has a stable
 * `runId`/`attemptId`/`idempotencyKey` so a replay after a lost connection
 * is recognized instead of run twice.
 */

/** The version of these contracts. Independent of the library, app, plugin and endpoint versions. */
export const MANAGED_CONTRACT_VERSION = 'maestro-managed/1' as const;
export type ManagedContractVersion = typeof MANAGED_CONTRACT_VERSION;

/** Which Maestro surface raised the operation. Attribution, not a permission level. */
export type ManagedOrigin = 'desktop' | 'cli' | 'cue' | 'headless' | 'enterprise' | 'embedded';
export const MANAGED_ORIGINS: readonly ManagedOrigin[] = [
	'desktop',
	'cli',
	'cue',
	'headless',
	'enterprise',
	'embedded',
];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Where an operation runs. `installationId` names one Maestro install for its
 * lifetime; `runtimeId` names one runtime (a desktop, a `maestro-cli host`)
 * within it; `processEpoch` changes every time that runtime starts. A fleet
 * must never mint a new device from a new epoch.
 */
export interface ManagedInstallationIdentity {
	installationId: string;
	runtimeId: string;
	processEpoch: string;
}

export type ManagedPrincipalKind = 'human' | 'service' | 'agent';

/** A reference to a principal. Resolving it to an authenticated identity is the host's job. */
export interface ManagedPrincipalRef {
	kind: ManagedPrincipalKind;
	id: string;
}

/**
 * How the actor came to act: the chain of principals that delegated to it,
 * outermost first, and an opaque reference to the grant that authorizes the
 * chain. An empty chain is a direct action. The reference is looked up by the
 * host; its presence proves nothing.
 */
export interface ManagedDelegationRef {
	chain: readonly ManagedPrincipalRef[];
	grantRef: string | null;
}

/**
 * The stable identity of one unit of work, fixed when it is first submitted
 * and repeated on every retry and replay. `requestId` is per message,
 * `attemptId` per try, `idempotencyKey` per logical submission, and the run
 * ids tie the work into a tree (a consult spawned by a turn, a Cue fan-out).
 */
export interface ManagedRunIdentity {
	requestId: string;
	idempotencyKey: string;
	attemptId: string;
	runId: string | null;
	rootRunId: string | null;
	parentRunId: string | null;
}

/** The workflow (an Auto Run, a Cue pipeline) that owns the run, with the fencing that keeps one owner. */
export interface ManagedWorkflowRef {
	workflowId: string;
	version: string;
	triggerEventId: string;
	ownerEpoch: string;
	fencingToken: string;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** What a managed host can be asked to do. A host advertises the subset it implements. */
export type ManagedCapability =
	| 'capabilities.negotiate'
	| 'agents.list'
	| 'runs.list'
	| 'runs.submit'
	| 'runs.inspect'
	| 'runs.cancel'
	| 'runs.interrupt'
	| 'events.resume'
	| 'policy.status';

export const MANAGED_CAPABILITIES: readonly ManagedCapability[] = [
	'capabilities.negotiate',
	'agents.list',
	'runs.list',
	'runs.submit',
	'runs.inspect',
	'runs.cancel',
	'runs.interrupt',
	'events.resume',
	'policy.status',
];

/** What a peer offers and needs. Negotiation is all-or-nothing on `required`. */
export interface ManagedCapabilityOffer {
	/** Contract versions the peer speaks, best first. */
	supportedVersions: readonly string[];
	/** Capabilities the peer cannot work without. One missing denies activation. */
	required: readonly ManagedCapability[];
	/** Capabilities the peer uses when present. */
	optional?: readonly ManagedCapability[];
}

export type ManagedNegotiationDenial =
	| 'unsupported-version'
	| 'missing-required-capability'
	| 'unknown-capability';

/**
 * The answer to an offer. Activation names the one version and the exact set
 * of capabilities both sides have; a denial names what was missing. There is
 * no partial activation: a host does not quietly downgrade what a peer asked
 * for, it refuses, and the peer decides.
 */
export type ManagedNegotiationOutcome =
	| {
			outcome: 'activated';
			contractVersion: ManagedContractVersion;
			capabilities: readonly ManagedCapability[];
	  }
	| { outcome: 'denied'; reason: ManagedNegotiationDenial; missing: readonly string[] };

// ---------------------------------------------------------------------------
// Operation context and authentication
// ---------------------------------------------------------------------------

/**
 * The attribution every managed operation carries. Serializable, and
 * untrusted until a host verifier has checked it against the peer it arrived
 * from (see `ManagedAuthenticatedContext`).
 */
export interface ManagedOperationContext {
	contractVersion: ManagedContractVersion;
	installation: ManagedInstallationIdentity;
	origin: ManagedOrigin;
	actor: ManagedPrincipalRef;
	delegation: ManagedDelegationRef;
	identity: ManagedRunIdentity;
	/** The policy generation the caller believes applies. `null` when unmanaged. */
	policyRevision: number | null;
	workflow: ManagedWorkflowRef | null;
	traceId: string;
	requestedCapabilities: readonly ManagedCapability[];
}

/** The transport a verifier authenticated the peer over. */
export type ManagedPeerAuthentication = 'in-process' | 'os-peer' | 'host-secret' | 'web-login';

/** The record of one verification: which verifier, over what, when. */
export interface ManagedVerification {
	peer: ManagedPeerAuthentication;
	verifierId: string;
	/** ISO 8601. */
	verifiedAt: string;
}

declare const managedVerified: unique symbol;

/**
 * A context a host verifier has bound to an authenticated peer. The brand is
 * a type-level mark only a verifier can apply (phase 2 supplies it); nothing
 * serializable carries it, so a caller cannot assert it by sending a field.
 * Sinks that need authority take this type, never `ManagedOperationContext`.
 */
export type ManagedAuthenticatedContext = ManagedOperationContext & {
	readonly verification: ManagedVerification;
	readonly [managedVerified]: true;
};

/** One operation as it travels: the attribution and the closed input. */
export interface ManagedOperationEnvelope<TInput> {
	context: ManagedOperationContext;
	input: TInput;
}

// ---------------------------------------------------------------------------
// Results, runs and events
// ---------------------------------------------------------------------------

export type ManagedDenialCode =
	| 'policy-denied'
	| 'unauthenticated'
	| 'context-mismatch'
	| 'version-unsupported'
	| 'capability-unsupported'
	| 'invalid-input'
	| 'idempotency-conflict'
	| 'not-found'
	| 'runtime-unavailable'
	| 'outcome-unknown';

/**
 * How an operation ended. `unknown` is a real answer: the host cannot say
 * whether the effect happened (a connection dropped after dispatch), and the
 * caller must not retry as if it had not.
 */
export type ManagedOperationResult<T> =
	| { status: 'ok'; requestId: string; value: T }
	| {
			status: 'denied' | 'unsupported' | 'unavailable' | 'unknown';
			requestId: string;
			code: ManagedDenialCode;
			/** Safe to show. Never a secret. */
			message?: string;
	  };

export type ManagedRunState =
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'
	| 'unknown';

export interface ManagedRunRecord {
	runId: string;
	rootRunId: string;
	parentRunId: string | null;
	attemptId: string;
	agentId: string;
	providerSessionId: string | null;
	state: ManagedRunState;
}

/**
 * A submission. Content travels by digest and reference so a receipt can be
 * checked against what was actually run; the text itself goes through the
 * ordinary turn input. No shell escape hatch, no executable object.
 */
export interface ManagedSubmitInput {
	agentId: string;
	tabId: string | null;
	providerId: string;
	modelId: string | null;
	content: { text: string; sha256: string };
	resourceIds: readonly string[];
}

/** `replayed` means the idempotency key was seen before and nothing ran again. */
export type ManagedSubmitDisposition = 'accepted' | 'replayed';

export interface ManagedSubmitReceipt {
	run: ManagedRunRecord;
	disposition: ManagedSubmitDisposition;
}

export type ManagedControlOutcome = 'requested' | 'already-terminal' | 'unknown';

export interface ManagedControlReceipt {
	runId: string;
	outcome: ManagedControlOutcome;
}

export type ManagedEventKind = 'run-state' | 'decision' | 'capabilities-changed';

/** Metadata only. Provider output and content never ride on these. */
export interface ManagedEvent {
	contractVersion: ManagedContractVersion;
	eventId: string;
	installation: ManagedInstallationIdentity;
	sequence: number;
	/** ISO 8601. */
	occurredAt: string;
	kind: ManagedEventKind;
	context: ManagedOperationContext;
	run?: ManagedRunRecord;
}

/** A page of events after a cursor. `completeness` says whether anything was lost before `items`. */
export interface ManagedEventPage {
	items: readonly ManagedEvent[];
	nextCursor: string | null;
	completeness: 'complete' | 'gap' | 'unknown';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const MAX_ID_LENGTH = 256;
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function principalProblems(value: unknown, at: string): string[] {
	if (!isRecord(value)) return [`${at} is not an object`];
	const problems: string[] = [];
	if (value.kind !== 'human' && value.kind !== 'service' && value.kind !== 'agent') {
		problems.push(`${at}.kind is not a principal kind`);
	}
	if (!isId(value.id)) problems.push(`${at}.id is not an id`);
	return problems;
}

/**
 * The structural problems with a value offered as a context. Empty means the
 * shape is right: every id present and bounded, every enum member known, the
 * version ours. It says nothing about whether the attribution is true; that
 * is verification, and a separate type.
 */
export function managedContextProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['context is not an object'];
	const problems: string[] = [];
	if (value.contractVersion !== MANAGED_CONTRACT_VERSION) {
		problems.push(`contractVersion is not ${MANAGED_CONTRACT_VERSION}`);
	}
	const installation = value.installation;
	if (!isRecord(installation)) problems.push('installation is not an object');
	else {
		for (const key of ['installationId', 'runtimeId', 'processEpoch'] as const) {
			if (!isId(installation[key])) problems.push(`installation.${key} is not an id`);
		}
	}
	if (!MANAGED_ORIGINS.includes(value.origin as ManagedOrigin)) problems.push('origin is unknown');
	problems.push(...principalProblems(value.actor, 'actor'));
	const delegation = value.delegation;
	if (!isRecord(delegation) || !Array.isArray(delegation.chain)) {
		problems.push('delegation.chain is not an array');
	} else {
		delegation.chain.forEach((link, i) =>
			problems.push(...principalProblems(link, `delegation.chain[${i}]`))
		);
		if (delegation.grantRef !== null && !isId(delegation.grantRef)) {
			problems.push('delegation.grantRef is not an id or null');
		}
	}
	const identity = value.identity;
	if (!isRecord(identity)) problems.push('identity is not an object');
	else {
		for (const key of ['requestId', 'idempotencyKey', 'attemptId'] as const) {
			if (!isId(identity[key])) problems.push(`identity.${key} is not an id`);
		}
		for (const key of ['runId', 'rootRunId', 'parentRunId'] as const) {
			if (identity[key] !== null && !isId(identity[key])) {
				problems.push(`identity.${key} is not an id or null`);
			}
		}
		if (identity.runId === null && (identity.rootRunId !== null || identity.parentRunId !== null)) {
			problems.push('identity names a root or parent run but no run');
		}
	}
	if (
		value.policyRevision !== null &&
		(typeof value.policyRevision !== 'number' || !Number.isInteger(value.policyRevision))
	) {
		problems.push('policyRevision is not an integer or null');
	}
	const workflow = value.workflow;
	if (workflow !== null) {
		if (!isRecord(workflow)) problems.push('workflow is not an object or null');
		else {
			const keys = [
				'workflowId',
				'version',
				'triggerEventId',
				'ownerEpoch',
				'fencingToken',
			] as const;
			for (const key of keys) {
				if (!isId(workflow[key])) problems.push(`workflow.${key} is not an id`);
			}
		}
	}
	if (!isId(value.traceId)) problems.push('traceId is not an id');
	if (!Array.isArray(value.requestedCapabilities)) {
		problems.push('requestedCapabilities is not an array');
	} else {
		for (const capability of value.requestedCapabilities) {
			if (!MANAGED_CAPABILITIES.includes(capability as ManagedCapability)) {
				problems.push(`requestedCapabilities names unknown "${String(capability)}"`);
			}
		}
	}
	return problems;
}

/** `managedContextProblems(value).length === 0`, as a type guard. */
export function isManagedOperationContext(value: unknown): value is ManagedOperationContext {
	return managedContextProblems(value).length === 0;
}
