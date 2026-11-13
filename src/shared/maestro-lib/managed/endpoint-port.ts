/**
 * The local endpoint port: what a Maestro host speaks to the Mega-Maestro
 * endpoint daemon over its private Unix socket, and the two ports a host
 * injects so that a desktop, a `maestro-cli host` and a TUI drive the same
 * code with their own custody and transport.
 *
 * The wire is the endpoint's `local-endpoint` contract, protocol 1: one
 * `POST /v1/invoke` per operation, a JSON envelope `{ schemaVersion: 1,
 * correlationId, operation, payload }` both ways, a request of at most 1 MiB,
 * an answer of at most 64 KiB, and a per-socket session that begins with an
 * `attachment` and ends with the connection. The endpoint authenticates the
 * OS peer (uid, pid, process birth) on every request and resolves it through
 * the actor registration it consumed for that process; the client sends no
 * actor, no token and no registration, and nothing it sends is authority.
 *
 * What is deliberately NOT in this module: `node:http` (the transport is the
 * client's, `src/main/enterprise/endpoint-client.ts`), Electron, and any
 * Mega-Maestro package import. The shapes here are Maestro's own transcription
 * of the contract fields it uses, validated structurally; the endpoint
 * re-validates everything with its own schemas and is the authority on them.
 */

import type { AdmissionOutcome, AdmissionRequest, HostAuthority } from './authority';
import type {
	DesktopAuthoringOperation,
	DesktopChoiceKind,
	DesktopPolicyBinding,
	DesktopPolicyResult,
} from './desktop-contract';
import type {
	EndpointInboxReceipt,
	EndpointInboxRequest,
	EndpointNoticeListRequest,
	EndpointNoticeListResult,
	EndpointTelemetryEvent,
} from './host-adapter';

export const LOCAL_ENDPOINT_PROTOCOL = 1 as const;
export const LOCAL_ENDPOINT_SCHEMA_VERSION = 1 as const;
export const LOCAL_ENDPOINT_INVOKE_PATH = '/v1/invoke';
/**
 * Protocol 2 (contracts 0.2.0): a separately negotiated connection on its own
 * path. A request refused on /v2/invoke is never retried on /v1/invoke, and v1
 * stays the default path until a v2 attachment negotiates protocol 2.
 */
export const LOCAL_ENDPOINT_PROTOCOL_V2 = 2 as const;
export const LOCAL_ENDPOINT_INVOKE_V2_PATH = '/v2/invoke';
export const LOCAL_ENDPOINT_REGISTRATION_CHALLENGE_PATH = '/v1/registration/challenge';
export const LOCAL_ENDPOINT_REGISTRATION_REDEEM_PATH = '/v1/registration/redeem';
/** Pre-release contract: registration is purpose-bound v2 only, with no v1 fallback. */
export const LOCAL_ENDPOINT_REGISTRATION_VERSION = 2 as const;
export const LOCAL_ENDPOINT_REGISTRATION_PURPOSE = 'runtime_use' as const;
export const LOCAL_ENDPOINT_MAX_REQUEST_BYTES = 1024 * 1024;
export const LOCAL_ENDPOINT_MAX_RESPONSE_BYTES = 64 * 1024;
export const LOCAL_ENDPOINT_MAX_REGISTRATION_BYTES = 4096;
/** The endpoint's own request deadline; a client waits no longer than this plus slack. */
export const LOCAL_ENDPOINT_TIMEOUT_MS = 5_000;

export const LOCAL_ENDPOINT_OPERATIONS = [
	'attachment',
	'enrollment',
	'execution',
	'offline',
	'telemetry',
	'command',
	'inbox',
	'noticeList',
	'workflow',
	'budget',
	'compatibility',
	'model',
	// Contracts 0.2.0 local-endpoint.js lists it (the actor-bound desktop settings
	// projection). No v1 caller sends it and it is not effectful; it is known here so
	// an envelope that names it is read against the pinned contract.
	'desktopPolicy',
] as const;
export type LocalEndpointOperation = (typeof LOCAL_ENDPOINT_OPERATIONS)[number];

/** Operations whose request, once sent, may have had an effect; a lost answer is `unknown`, not a retry. */
export const LOCAL_ENDPOINT_EFFECTFUL_OPERATIONS: readonly LocalEndpointOperation[] = [
	'enrollment',
	'execution',
	'offline',
	'telemetry',
	'command',
	'inbox',
	'workflow',
	'budget',
	'model',
];

export const LOCAL_ENDPOINT_DENIAL_REASONS = [
	'unsupported_version',
	'unsupported_capability',
	'unauthenticated',
	'policy_denied',
	'expired',
	'replay',
	'unavailable',
	'invalid_request',
	'untrusted_clock',
	'budget_exhausted',
	'unknown_price',
	'owner_unfenced',
] as const;
export type LocalEndpointDenialReason = (typeof LOCAL_ENDPOINT_DENIAL_REASONS)[number];

export interface EndpointDenied {
	outcome: 'denied';
	reason: LocalEndpointDenialReason;
}

export type EndpointComponentKind =
	| 'endpoint'
	| 'maestro'
	| 'runtime'
	| 'ux'
	| 'cli'
	| 'cue'
	| 'vibes';

export interface EndpointComponent {
	id: string;
	kind: EndpointComponentKind;
	version: string;
}

export interface EndpointAttachmentRequest {
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	components: readonly EndpointComponent[];
	supportedProtocols: readonly (typeof LOCAL_ENDPOINT_PROTOCOL)[];
	supportedCapabilities: readonly string[];
	requiredCapabilities: readonly string[];
}

export type EndpointManagementState = 'unenrolled' | 'enrolling' | 'managed' | 'suspended';
export type EndpointConnectivity = 'online' | 'offline' | 'unavailable';
export type EndpointCollectionProfile = 'metadata' | 'redacted' | 'full' | 'full_vibes';

/** The endpoint's answer to an attachment: what it is to this peer, right now. */
export interface EndpointStatus {
	outcome: 'attached';
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	capabilities: readonly string[];
	management: EndpointManagementState;
	desiredPolicyRevision: number | null;
	appliedPolicyRevision: number | null;
	connectivity: EndpointConnectivity;
	collectionProfile: EndpointCollectionProfile;
}

/**
 * The protocol 2 attachment (contracts 0.2.0 `attachmentRequestV2`): the v1
 * request with `supportedProtocols` fixed at [2]. Every required capability
 * must also be supported, and neither list may repeat an entry.
 */
export interface EndpointAttachmentRequestV2 extends Omit<
	EndpointAttachmentRequest,
	'supportedProtocols'
> {
	supportedProtocols: readonly [typeof LOCAL_ENDPOINT_PROTOCOL_V2];
}

/** The endpoint's answer to a v2 attachment: the v1 status at protocol 2, with the negotiated capabilities. */
export interface EndpointStatusV2 extends Omit<EndpointStatus, 'protocol'> {
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL_V2;
}

/** What a v2 attachment negotiated on the current connection. */
export interface EndpointNegotiation {
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL_V2;
	/** The capabilities the endpoint selected; an operation is negotiated only when it is listed here. */
	capabilities: readonly string[];
	status: EndpointStatusV2;
}

export interface EndpointCompatibilityRequest {
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	components: readonly EndpointComponent[];
	requiredCapabilities: readonly string[];
}

export interface EndpointCompatibilityResult {
	outcome: 'compatible';
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	capabilities: readonly string[];
}

/**
 * What a registration challenge hands back. The nonce and digest are what the
 * actor types into the browser approval; they are one short-lived pairing
 * code, shown to the person once and never persisted or logged.
 */
export interface EndpointRegistrationApproval {
	challengeId: string;
	nonce: string;
	challengeDigest: string;
	expiresAt: string;
}

/** The `enrollment` operation: a request to the endpoint, which owns the device key and the proof. */
export interface EndpointEnrollmentRequest {
	mode: 'attended' | 'managed';
	invitation: string;
	collectionProfile: EndpointCollectionProfile;
	trustRootDigest: string;
	/** Produced by the endpoint own tooling; Maestro relays it and never computes it. */
	keyPossessionProof: string;
}

export interface EndpointEnrollmentResult {
	outcome: 'enrollment_pending';
	enrollmentId: string;
}

export interface EndpointRegistrationReceipt {
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	outcome: 'registered';
}

/**
 * The v2 `registration_use` operation: the enrollment reference this process's
 * runtime_use registration resolves to. Sent only when the v2 attachment
 * negotiated it; the 0.2.0 pinned contract does not list it, so until Mega
 * serves it the client treats it as not negotiated and sends nothing.
 */
export const LOCAL_ENDPOINT_REGISTRATION_USE_OPERATION = 'registration_use' as const;

/** The `registration_use` request: an empty object, no extra keys (the endpoint parses it strictly). */
export type EndpointRegistrationUseRequest = Record<string, never>;

/**
 * The contract's `runtimeUseReferenceV2` (vendored contracts 0.2.0,
 * local-primitives.js): `runtimeChallengeScopeV2` plus `challengeId` and
 * `challengeDigest`, field for field. An actor-free lookup reference, not an
 * assertion that the registration was consumed.
 */
export interface EndpointRuntimeUseReference {
	version: typeof LOCAL_ENDPOINT_REGISTRATION_VERSION;
	purpose: typeof LOCAL_ENDPOINT_REGISTRATION_PURPOSE;
	tenantId: string;
	orgId: string;
	/** A UUID string. */
	enrollmentId: string;
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	bindingDigest: string;
	/** Lowercase SHA-256 hex. */
	processBirthDigest: string;
	challengeId: string;
	challengeDigest: string;
}

export type EndpointRegistrationUseReply =
	| { outcome: 'projected'; reference: EndpointRuntimeUseReference; expiresAt: string }
	| { outcome: 'denied'; reason: string };

// ---------------------------------------------------------------------------
// The v2 workflow lifecycle (contracts 0.2.0 protocol.js), field for field
// ---------------------------------------------------------------------------

/** The four lifecycle operations `/v2/invoke` serves, by their wire names. */
export const LOCAL_ENDPOINT_WORKFLOW_V2_OPERATIONS = [
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
] as const;
export type EndpointWorkflowV2Operation = (typeof LOCAL_ENDPOINT_WORKFLOW_V2_OPERATIONS)[number];

/**
 * The contract's `workflowOwnerReference`. `ownerEpoch` is an opaque
 * identifier string in v2, never v1's numeric epoch. A claim never sends one;
 * the producer returns it, and renew, settle and release echo it.
 */
export interface EndpointWorkflowOwnerV2 {
	ownerId: string;
	ownerEpoch: string;
	fencingToken: string;
}

/** The contract's `grantReference`: a grant UUID and the digest of its record. */
export interface EndpointGrantReferenceV2 {
	grantId: string;
	digest: string;
}

/** The contract's `delegationReference`: the presented grant and its root-first chain ending in it. */
export interface EndpointDelegationReferenceV2 {
	grant: EndpointGrantReferenceV2;
	chain: readonly EndpointGrantReferenceV2[];
}

/**
 * The contract's `workflowContextV2` (`operationAuthorityReferences` plus the
 * workflow lineage). References only: nothing here is an actor or authority.
 */
export interface EndpointWorkflowContextV2 {
	registration: EndpointRuntimeUseReference;
	delegation: EndpointDelegationReferenceV2 | null;
	/** At most 32, unique by `grantId`. */
	grants: readonly EndpointGrantReferenceV2[];
	workflowId: string;
	workflowVersion: string;
	triggerId: string;
	runId: string;
	attemptId: string;
	idempotencyKey: string;
	policyRevision: number;
	rootRunId: string;
	parentRunId: string | null;
}

/** The contract's `workflowMaximumLeaseMs`: a lease lasts 1 ms to 5 minutes. */
export const ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS = 300_000;

/** `workflowClaimRequest`: the context and a requested lease. No owner: the producer returns one. */
export interface EndpointWorkflowClaimRequestV2 extends EndpointWorkflowContextV2 {
	/** An integer from 1 to `ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS`. */
	requestedLeaseMs: number;
}

/** `workflowRenewRequest`: a claim that echoes the owner it holds. */
export interface EndpointWorkflowRenewRequestV2 extends EndpointWorkflowClaimRequestV2 {
	owner: EndpointWorkflowOwnerV2;
}

/** The contract's `commandExecutionEffect`: settled with evidence, or uncertain with a reason. */
export type EndpointWorkflowEffectV2 =
	| {
			state: 'settled';
			outcome: 'completed' | 'failed' | 'no_effect';
			/** Lowercase SHA-256 hex. */
			evidenceDigest: string;
	  }
	| {
			state: 'uncertain';
			reason: 'owner_lost' | 'transport_lost' | 'deadline_elapsed' | 'recovery_required';
	  };

/** `workflowSettleRequest`: the context, the echoed owner and the effect being settled. */
export interface EndpointWorkflowSettleRequestV2 extends EndpointWorkflowContextV2 {
	owner: EndpointWorkflowOwnerV2;
	effect: EndpointWorkflowEffectV2;
}

/** `workflowReleaseRequest`: custody surrendered only once every effect settled or none began. */
export interface EndpointWorkflowReleaseRequestV2 extends EndpointWorkflowContextV2 {
	owner: EndpointWorkflowOwnerV2;
	disposition: 'effects_settled' | 'no_effect_started';
}

/** `workflowLease`: the context echoed with the owner and a bounded positive lifetime. */
export interface EndpointWorkflowLeaseV2 extends EndpointWorkflowContextV2 {
	owner: EndpointWorkflowOwnerV2;
	/** A timestamp; `expiresAt` follows it by at most `ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS`. */
	acquiredAt: string;
	expiresAt: string;
}

/** `workflowSettlementReceipt`: the settle request echoed, recorded. */
export interface EndpointWorkflowSettlementReceiptV2 extends EndpointWorkflowSettleRequestV2 {
	outcome: 'recorded';
	recordedAt: string;
}

/** `workflowReleaseReceipt`: the release request echoed, released. */
export interface EndpointWorkflowReleaseReceiptV2 extends EndpointWorkflowReleaseRequestV2 {
	outcome: 'released';
	releasedAt: string;
}

export type EndpointWorkflowClaimReplyV2 =
	| { outcome: 'owned'; lease: EndpointWorkflowLeaseV2 }
	| EndpointDenied;
export type EndpointWorkflowRenewReplyV2 =
	| { outcome: 'renewed'; lease: EndpointWorkflowLeaseV2 }
	| EndpointDenied;
export type EndpointWorkflowSettleReplyV2 = EndpointWorkflowSettlementReceiptV2 | EndpointDenied;
export type EndpointWorkflowReleaseReplyV2 = EndpointWorkflowReleaseReceiptV2 | EndpointDenied;

/** Each lifecycle operation's request and reply, keyed by its wire name. */
export interface EndpointWorkflowV2Exchange {
	workflow_claim: { request: EndpointWorkflowClaimRequestV2; reply: EndpointWorkflowClaimReplyV2 };
	workflow_renew: { request: EndpointWorkflowRenewRequestV2; reply: EndpointWorkflowRenewReplyV2 };
	workflow_settle: {
		request: EndpointWorkflowSettleRequestV2;
		reply: EndpointWorkflowSettleReplyV2;
	};
	workflow_release: {
		request: EndpointWorkflowReleaseRequestV2;
		reply: EndpointWorkflowReleaseReplyV2;
	};
}

// ---------------------------------------------------------------------------
// The v2 operation clients (contracts 0.2.0 protocol.js), field for field
// ---------------------------------------------------------------------------
//
// `localEndpointContractsV2` spreads the v1 `localEndpointContracts` and
// replaces only `attachment`, `compatibility`, `execution`, `command` and the
// workflow rows. Every operation below is therefore carried on `/v2/invoke`
// under its v1 name with the v1 domain schema unchanged (local-endpoint.js and
// desktop-policy.js); no shape here is pending a later Mega batch. Schema
// presence is not support: an operation is sent only when the v2 attachment on
// the current connection negotiated it.

/** The v2 operations Maestro has a client for, by their wire names. */
export const LOCAL_ENDPOINT_OPERATION_V2_CLIENTS = [
	'noticeList',
	'inbox',
	'telemetry',
	'budget',
	'offline',
	'desktopPolicy',
	'model',
] as const;
export type EndpointOperationV2Client = (typeof LOCAL_ENDPOINT_OPERATION_V2_CLIENTS)[number];

/** `noticeListRequest`: offset 0..7, limit 1..8; each page is freshly authorized. */
export type EndpointNoticeListRequestV2 = EndpointNoticeListRequest;
/** `noticeListResult` or `denied`. */
export type EndpointNoticeListReplyV2 = EndpointNoticeListResult | EndpointDenied;

/**
 * `inboxRequest`. The v2 request is the v1 request field for field; the
 * `idempotencyKey` a receipt ledger minted for the v1 path is the one the v2
 * path sends, so a resend across the two paths stays one receipt.
 */
export type EndpointInboxRequestV2 = EndpointInboxRequest;
/** `inboxReceipt` or `denied`. */
export type EndpointInboxReplyV2 = EndpointInboxReceipt | EndpointDenied;

/** The v1 inbox request as the v2 path sends it: every field copied, `idempotencyKey` unchanged. */
export function inboxRequestV2(request: EndpointInboxRequest): EndpointInboxRequestV2 {
	return {
		campaignId: request.campaignId,
		messageId: request.messageId,
		idempotencyKey: request.idempotencyKey,
		action: request.action,
	};
}

/** `incomingMetadataEvent`, as this host sends it (the runtime-report subset). */
export type EndpointTelemetryRequestV2 = EndpointTelemetryEvent;
/** The contract's `durableReceipt`. */
export interface EndpointDurableReceiptV2 {
	outcome: 'durably_accepted';
	eventId: string;
	receivedAt: string;
	duplicate: boolean;
}
export type EndpointTelemetryReplyV2 = EndpointDurableReceiptV2 | EndpointDenied;

/** The contract's `budgetRequest`. */
export interface EndpointBudgetRequestV2 {
	reservationId: string;
	requestId: string;
	runId: string;
	destinationId: string;
	policyRevision: number;
	/** 1 to 8192 characters, or null. */
	signedOfflineAllowance: string | null;
	estimatedUnits: number;
	actualUnits: number | null;
	usageProvenance: 'gateway_metered' | 'provider_reported' | 'estimated' | 'unavailable';
	priceRevision: string | null;
}
/** The contract's `budgetReceipt`. */
export interface EndpointBudgetReceiptV2 {
	outcome: 'reserved';
	reservationId: string;
	destinationId: string;
	attributedOrgId: string;
	maximumUnits: number;
	expiresAt: string;
}
export type EndpointBudgetReplyV2 = EndpointBudgetReceiptV2 | EndpointDenied;

/** The contract's `offlineRequest`. */
export interface EndpointOfflineRequestV2 {
	policyRevision: number;
	verifiedPolicyDigest: string;
	exceptionExpiresAt: string | null;
	allowanceId: string;
	allowanceExpiresAt: string;
	signedAllowance: string;
	clockState: 'trusted' | 'uncertain' | 'rollback_detected';
}
/** The contract's `offlineResult`. */
export interface EndpointOfflineResultV2 {
	outcome: 'offline_active';
	policyRevision: number;
	allowanceId: string;
	validUntil: string;
	remainingUnits: number;
}
export type EndpointOfflineReplyV2 = EndpointOfflineResultV2 | EndpointDenied;

/** The contract's `desktopAuthoringRequest` (desktop-policy.js). */
export interface EndpointDesktopAuthoringRequestV2 {
	subject: 'agent' | 'tab';
	operation: DesktopAuthoringOperation;
	items: number;
	resultingCount: number;
	selections: Record<string, readonly string[]>;
	managedSettingKeys: readonly string[];
	personalSettingKeys: readonly string[];
}
/** The contract's `desktopSettingsRequest`: a projection, or a decision on one exact authoring request. */
export type EndpointDesktopPolicyRequestV2 =
	| { kind: 'projection' }
	| { kind: 'authorize'; projectionDigest: string; request: EndpointDesktopAuthoringRequestV2 };
/** The contract's `desktopDecisionReceipt`: metadata only, never a grant. */
export interface EndpointDesktopDecisionReceiptV2 {
	receiptId: string;
	decidedAt: string;
	binding: DesktopPolicyBinding;
	expectedProjectionDigest: string;
	projectionDigest: string;
	requestDigest: string;
	outcome: 'allow' | 'deny';
	reasons: readonly {
		code:
			| 'not_allowed'
			| 'unknown_field'
			| 'unsupported_capability'
			| 'constraint_failed'
			| 'invalid_policy';
		field: string | null;
		message: string;
	}[];
	selections: Partial<Record<DesktopChoiceKind, readonly string[]>>;
	personalSettingKeys: readonly string[];
	receiptDigest: string;
}
/** The contract's `desktopSettingsResult` (it already includes `denied`). */
export type EndpointDesktopPolicyReplyV2 =
	| { outcome: 'projection'; result: DesktopPolicyResult; projectionDigest: string | null }
	| { outcome: 'decision'; receipt: EndpointDesktopDecisionReceiptV2 }
	| EndpointDenied;

/** The contract's `modelInvocationRequest`. */
export interface EndpointModelRequestV2 {
	runId: string;
	sessionId: string;
	model: string;
	policyRevision: number;
	routeId: string;
	allowFallback: boolean;
	/** 1 to 65536 characters. */
	prompt: string;
}
/** The contract's `modelInvocationResult`. */
export interface EndpointModelResultV2 {
	outcome: 'model_completed';
	requestId: string;
	source: 'development-mock' | 'development-loopback';
	text: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		source: 'observed';
	} | null;
}
export type EndpointModelReplyV2 = EndpointModelResultV2 | EndpointDenied;

/** Each v2 operation client's request and reply, keyed by its wire name. */
export interface EndpointOperationV2Exchange {
	noticeList: { request: EndpointNoticeListRequestV2; reply: EndpointNoticeListReplyV2 };
	inbox: { request: EndpointInboxRequestV2; reply: EndpointInboxReplyV2 };
	telemetry: { request: EndpointTelemetryRequestV2; reply: EndpointTelemetryReplyV2 };
	budget: { request: EndpointBudgetRequestV2; reply: EndpointBudgetReplyV2 };
	offline: { request: EndpointOfflineRequestV2; reply: EndpointOfflineReplyV2 };
	desktopPolicy: { request: EndpointDesktopPolicyRequestV2; reply: EndpointDesktopPolicyReplyV2 };
	model: { request: EndpointModelRequestV2; reply: EndpointModelReplyV2 };
}

/**
 * The v2 operations an existing v1 caller is moved onto. EMPTY until Mega's
 * parity matrix shows an operation served on `/v2/invoke`; an operation is
 * added here only with that evidence. `src/main/enterprise/endpoint-ops-v2.ts`
 * re-exports it; this is its one home so the shared callers can read it.
 */
export const V2_OPERATIONS_SELECTED: readonly string[] = [];

/** Whether the v2 attachment behind `clientState` negotiated `operation`. False with no v2 attachment. */
export function v2OperationNegotiated(
	clientState: Pick<EndpointConnectionState, 'negotiated'>,
	operation: string
): boolean {
	return clientState.negotiated?.capabilities.includes(operation) ?? false;
}

/** The ports a v1 caller selects a path over: `invoke` always, the v2 side when the port has one. */
export type EndpointOperationSelectable = Pick<EndpointPort, 'invoke'> &
	Partial<Pick<EndpointPort, 'v2' | 'state'>>;

/**
 * Which path an existing v1 caller sends `operation` on. `v2` only when the
 * operation is in `selected` (default `V2_OPERATIONS_SELECTED`) AND the v2
 * attachment on the current connection negotiated it; `v1` otherwise. With
 * the selection empty the connection state is not even read.
 */
export function selectEndpointOperationPath(
	endpoint: EndpointOperationSelectable,
	operation: EndpointOperationV2Client,
	selected: readonly string[] = V2_OPERATIONS_SELECTED
): 'v1' | 'v2' {
	if (!selected.includes(operation)) return 'v1';
	if (!endpoint.v2 || !endpoint.state) return 'v1';
	return v2OperationNegotiated(endpoint.state(), operation) ? 'v2' : 'v1';
}

/**
 * Send one operation for an existing v1 caller on the path
 * `selectEndpointOperationPath` picks, decided per call. The v1 path sends
 * `payload` through `invoke` exactly as before; the v2 path sends
 * `v2Payload(payload)` through `v2.invoke` under the same operation name.
 * Only operations that have a v1 caller qualify (`desktopPolicy` has none).
 */
export function invokeSelectedEndpointOperation<
	O extends EndpointOperationV2Client & LocalEndpointOperation,
>(
	endpoint: EndpointOperationSelectable,
	operation: O,
	payload: EndpointOperationV2Exchange[O]['request'],
	options: {
		selected?: readonly string[];
		v2Payload?: (
			payload: EndpointOperationV2Exchange[O]['request']
		) => EndpointOperationV2Exchange[O]['request'];
	} = {}
): Promise<EndpointInvokeOutcome<unknown>> {
	if (selectEndpointOperationPath(endpoint, operation, options.selected) === 'v2' && endpoint.v2) {
		return endpoint.v2.invoke(operation, options.v2Payload ? options.v2Payload(payload) : payload);
	}
	return endpoint.invoke(operation, payload);
}

export interface LocalEndpointEnvelope {
	schemaVersion: typeof LOCAL_ENDPOINT_SCHEMA_VERSION;
	correlationId: string;
	operation: LocalEndpointOperation;
	payload: unknown;
}

/**
 * The protocol 2 envelope, both ways on `POST /v2/invoke`: the contract's
 * `localRequestEnvelopeV2` / `localResponseEnvelopeV2`. `operation` is a
 * plain string because the v2 operation set is the endpoint's, negotiated per
 * connection; the client checks it against what the attachment returned.
 */
export interface LocalEndpointEnvelopeV2 {
	schemaVersion: typeof LOCAL_ENDPOINT_PROTOCOL_V2;
	correlationId: string;
	operation: string;
	payload: unknown;
}

// ---------------------------------------------------------------------------
// Validation (structural; the endpoint is the authority on its own schemas)
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** The endpoint's `identifier`: 1 to 128 of `[A-Za-z0-9_-]`, starting alphanumeric. */
export function isEndpointIdentifier(value: unknown): value is string {
	return typeof value === 'string' && IDENTIFIER.test(value);
}

export function isEndpointDigest(value: unknown): value is string {
	return typeof value === 'string' && DIGEST.test(value);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isRevision = (value: unknown): value is number | null =>
	value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
const isStringList = (value: unknown, max: number): value is string[] =>
	Array.isArray(value) && value.length <= max && value.every(isEndpointIdentifier);

export function isEndpointDenied(value: unknown): value is EndpointDenied {
	return (
		isRecord(value) &&
		value.outcome === 'denied' &&
		LOCAL_ENDPOINT_DENIAL_REASONS.includes(value.reason as LocalEndpointDenialReason)
	);
}

export function endpointComponentProblems(value: unknown, at: string): string[] {
	if (!isRecord(value)) return [`${at} is not an object`];
	const problems: string[] = [];
	if (!isEndpointIdentifier(value.id)) problems.push(`${at}.id is not an identifier`);
	if (
		!['endpoint', 'maestro', 'runtime', 'ux', 'cli', 'cue', 'vibes'].includes(value.kind as string)
	) {
		problems.push(`${at}.kind is unknown`);
	}
	if (
		typeof value.version !== 'string' ||
		value.version.length === 0 ||
		value.version.length > 64
	) {
		problems.push(`${at}.version is not 1 to 64 characters`);
	}
	return problems;
}

/** Problems with a request this host is about to send; a client refuses to send one it cannot describe. */
export function endpointAttachmentRequestProblems(value: unknown): string[] {
	return attachmentRequestProblems(value, LOCAL_ENDPOINT_PROTOCOL);
}

/** `endpointAttachmentRequestProblems` for protocol 2: [2], unique lists, required within supported. */
export function endpointAttachmentRequestV2Problems(value: unknown): string[] {
	const problems = attachmentRequestProblems(value, LOCAL_ENDPOINT_PROTOCOL_V2);
	if (!isRecord(value)) return problems;
	const supported = value.supportedCapabilities;
	const required = value.requiredCapabilities;
	if (isStringList(supported, 128) && !isUniqueList(supported))
		problems.push('supportedCapabilities repeats an entry');
	if (isStringList(required, 128) && !isUniqueList(required))
		problems.push('requiredCapabilities repeats an entry');
	if (
		isStringList(supported, 128) &&
		isStringList(required, 128) &&
		!required.every((item) => supported.includes(item))
	) {
		problems.push('requiredCapabilities names a capability that is not supported');
	}
	return problems;
}

const isUniqueList = (values: readonly string[]): boolean => new Set(values).size === values.length;

function attachmentRequestProblems(value: unknown, protocol: 1 | 2): string[] {
	if (!isRecord(value)) return ['request is not an object'];
	const problems: string[] = [];
	for (const key of ['installationId', 'runtimeId', 'processEpoch'] as const) {
		if (!isEndpointIdentifier(value[key])) problems.push(`${key} is not an endpoint identifier`);
	}
	if (
		!Array.isArray(value.components) ||
		value.components.length < 1 ||
		value.components.length > 32
	) {
		problems.push('components is not 1 to 32 entries');
	} else {
		value.components.forEach((c, i) =>
			problems.push(...endpointComponentProblems(c, `components[${i}]`))
		);
	}
	if (
		!Array.isArray(value.supportedProtocols) ||
		value.supportedProtocols.length !== 1 ||
		value.supportedProtocols[0] !== protocol
	) {
		problems.push(`supportedProtocols is not [${protocol}]`);
	}
	if (!isStringList(value.supportedCapabilities, 128))
		problems.push('supportedCapabilities is not a capability list');
	if (!isStringList(value.requiredCapabilities, 128))
		problems.push('requiredCapabilities is not a capability list');
	return problems;
}

export function endpointStatusProblems(value: unknown): string[] {
	return statusProblems(value, LOCAL_ENDPOINT_PROTOCOL);
}

/** `endpointStatusProblems` for a v2 attachment answer: protocol 2, unique negotiated capabilities. */
export function endpointStatusV2Problems(value: unknown): string[] {
	const problems = statusProblems(value, LOCAL_ENDPOINT_PROTOCOL_V2);
	if (isRecord(value) && isStringList(value.capabilities, 128) && !isUniqueList(value.capabilities))
		problems.push('capabilities repeats an entry');
	return problems;
}

function statusProblems(value: unknown, protocol: 1 | 2): string[] {
	if (!isRecord(value)) return ['status is not an object'];
	const problems: string[] = [];
	if (value.outcome !== 'attached') problems.push('outcome is not attached');
	if (value.protocol !== protocol) problems.push(`protocol is not ${protocol}`);
	if (!isStringList(value.capabilities, 128))
		problems.push('capabilities is not a capability list');
	if (!['unenrolled', 'enrolling', 'managed', 'suspended'].includes(value.management as string)) {
		problems.push('management is unknown');
	}
	if (!isRevision(value.desiredPolicyRevision))
		problems.push('desiredPolicyRevision is not a revision');
	if (!isRevision(value.appliedPolicyRevision))
		problems.push('appliedPolicyRevision is not a revision');
	if (!['online', 'offline', 'unavailable'].includes(value.connectivity as string)) {
		problems.push('connectivity is unknown');
	}
	if (!['metadata', 'redacted', 'full', 'full_vibes'].includes(value.collectionProfile as string)) {
		problems.push('collectionProfile is unknown');
	}
	return problems;
}

export function endpointCompatibilityResultProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['result is not an object'];
	const problems: string[] = [];
	if (value.outcome !== 'compatible') problems.push('outcome is not compatible');
	if (value.protocol !== LOCAL_ENDPOINT_PROTOCOL) problems.push('protocol is not 1');
	if (!isStringList(value.capabilities, 128))
		problems.push('capabilities is not a capability list');
	return problems;
}

export function endpointRegistrationApprovalProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['approval is not an object'];
	const problems: string[] = [];
	if (typeof value.challengeId !== 'string' || value.challengeId.length === 0) {
		problems.push('challengeId is not an id');
	}
	if (typeof value.nonce !== 'string' || !NONCE.test(value.nonce))
		problems.push('nonce is not a nonce');
	if (!isEndpointDigest(value.challengeDigest)) problems.push('challengeDigest is not a digest');
	if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) {
		problems.push('expiresAt is not a timestamp');
	}
	return problems;
}

/**
 * Why a `registration_use` answer is not one this client will act on, or [].
 * The `processBirthDigest` must be 64 lowercase hex and the `enrollmentId` a
 * non-empty string; every other field is checked against the contract's shape.
 */
export function endpointRegistrationUseReplyProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['reply is not an object'];
	if (value.outcome === 'denied') {
		return typeof value.reason === 'string' && value.reason.length > 0
			? []
			: ['reason is not a reason'];
	}
	if (value.outcome !== 'projected') return ['outcome is not projected or denied'];
	const problems: string[] = [];
	if (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) {
		problems.push('expiresAt is not a timestamp');
	}
	const ref = value.reference;
	if (!isRecord(ref)) return [...problems, 'reference is not an object'];
	if (typeof ref.enrollmentId !== 'string' || ref.enrollmentId.length === 0) {
		problems.push('enrollmentId is not an id');
	}
	if (!isEndpointDigest(ref.processBirthDigest))
		problems.push('processBirthDigest is not a digest');
	if (!isEndpointDigest(ref.bindingDigest)) problems.push('bindingDigest is not a digest');
	if (!isEndpointDigest(ref.challengeDigest)) problems.push('challengeDigest is not a digest');
	if (ref.version !== LOCAL_ENDPOINT_REGISTRATION_VERSION) problems.push('version is not 2');
	if (ref.purpose !== LOCAL_ENDPOINT_REGISTRATION_PURPOSE)
		problems.push('purpose is not runtime_use');
	for (const key of ['tenantId', 'orgId', 'challengeId'] as const) {
		if (typeof ref[key] !== 'string' || (ref[key] as string).length === 0) {
			problems.push(`${key} is not an id`);
		}
	}
	for (const key of ['installationId', 'runtimeId', 'processEpoch'] as const) {
		if (!isEndpointIdentifier(ref[key])) problems.push(`${key} is not an identifier`);
	}
	return problems;
}

export function frameLocalEndpointRequest(
	operation: LocalEndpointOperation,
	payload: unknown,
	correlationId: string
): LocalEndpointEnvelope {
	if (!isEndpointIdentifier(correlationId))
		throw new Error('correlationId is not an endpoint identifier');
	return { schemaVersion: LOCAL_ENDPOINT_SCHEMA_VERSION, correlationId, operation, payload };
}

/**
 * Read an answer envelope against the request it must answer. A version,
 * correlation or operation mismatch is a malformed answer: the payload is not
 * looked at, since it could be the answer to another request.
 */
export function parseLocalEndpointResponse(
	raw: unknown,
	expected: { correlationId: string; operation: LocalEndpointOperation }
): { ok: true; payload: unknown } | { ok: false; problem: string } {
	return parseEnvelopeAnswer(raw, LOCAL_ENDPOINT_SCHEMA_VERSION, expected);
}

/** Frame a protocol 2 request for `POST /v2/invoke`; never a v1 envelope. */
export function frameLocalEndpointRequestV2(
	operation: string,
	payload: unknown,
	correlationId: string
): LocalEndpointEnvelopeV2 {
	if (!isEndpointIdentifier(correlationId))
		throw new Error('correlationId is not an endpoint identifier');
	if (!isEndpointIdentifier(operation)) throw new Error('operation is not an endpoint identifier');
	return { schemaVersion: LOCAL_ENDPOINT_PROTOCOL_V2, correlationId, operation, payload };
}

/** `parseLocalEndpointResponse` for protocol 2: schemaVersion 2, same correlation and operation rule. */
export function parseLocalEndpointResponseV2(
	raw: unknown,
	expected: { correlationId: string; operation: string }
): { ok: true; payload: unknown } | { ok: false; problem: string } {
	return parseEnvelopeAnswer(raw, LOCAL_ENDPOINT_PROTOCOL_V2, expected);
}

function parseEnvelopeAnswer(
	raw: unknown,
	schemaVersion: number,
	expected: { correlationId: string; operation: string }
): { ok: true; payload: unknown } | { ok: false; problem: string } {
	if (!isRecord(raw)) return { ok: false, problem: 'response is not an object' };
	if (raw.schemaVersion !== schemaVersion) {
		return { ok: false, problem: `response schemaVersion is ${String(raw.schemaVersion)}` };
	}
	if (raw.correlationId !== expected.correlationId) {
		return { ok: false, problem: 'response correlationId does not match the request' };
	}
	if (raw.operation !== expected.operation) {
		return { ok: false, problem: 'response operation does not match the request' };
	}
	if (!('payload' in raw)) return { ok: false, problem: 'response has no payload' };
	return { ok: true, payload: raw.payload };
}

// ---------------------------------------------------------------------------
// The ports a host injects
// ---------------------------------------------------------------------------

export type EndpointUnavailableReason =
	| 'not-attached'
	| 'no-challenge'
	| 'transport'
	| 'timeout'
	| 'oversized'
	| 'malformed'
	| 'closed'
	| 'http-status'
	/** The native port could not name, or refused, the process serving a new connection. */
	| 'peer-unverified'
	/** The v2 attachment on the current connection did not negotiate the operation; nothing was sent. */
	| 'not-negotiated';

/**
 * How one call ended. `denied` is the endpoint's own refusal (its reason),
 * `unavailable` means no answer could be obtained and nothing was sent or the
 * request is read-only, `unknown` means an effectful request left this process
 * and its answer did not come back.
 */
export type EndpointInvokeOutcome<T> =
	| { status: 'ok'; payload: T }
	| { status: 'denied'; reason: LocalEndpointDenialReason }
	| { status: 'unavailable'; reason: EndpointUnavailableReason; message: string }
	| { status: 'unknown'; message: string };

export type EndpointRegistrationPhase = 'none' | 'challenged' | 'registered';

export interface EndpointConnectionState {
	/** Counts connections; a new value means the endpoint's per-socket session was lost. */
	connection: number;
	attached: boolean;
	/** The last status the endpoint answered on the CURRENT connection, or null. */
	status: EndpointStatus | null;
	/** This process's actor registration as this client observed it; lost with the process, not the connection. */
	registration: EndpointRegistrationPhase;
	closed: boolean;
	/** The endpoint process the native port verified for the CURRENT connection; absent when no native port is installed. */
	server?: EndpointServerIdentity | null;
	/**
	 * What a v2 attachment negotiated on the CURRENT connection; absent until
	 * one succeeds. The endpoint holds one protocol per socket session, so a
	 * v1 attachment, a failed attachment or a new connection drops it.
	 */
	negotiated?: EndpointNegotiation;
}

// NATIVE-ENDPOINT/1, a local consumer seam. The contract says how the endpoint
// authenticates THIS process, not how a client knows it dialed the endpoint.
// Linux keeps its rule (a socket in the service directory). On macOS and Windows
// an address proves nothing (creatable socket path, squattable pipe), so a host
// port names each connection server from the OS (audit token and signature,
// pipe server pid and Authenticode). None is installed: those stay unavailable.

export const ENDPOINT_NATIVE_PORT_VERSION = 1 as const;

/** How the endpoint is reached: a Unix domain socket, or a local Windows named pipe. */
export type EndpointNativeTransport = 'unix-socket' | 'named-pipe';

/** The process serving one connection, as the OS reported it for that connection. */
export interface EndpointServerIdentity {
	pid: number;
	/** Pid plus start time, so a reused pid is another process. */
	processBirthDigest: string;
	executableDigest: string;
	/** The service account, SID or code-signing requirement the OS names. */
	principal: string;
}

export type EndpointServerVerification =
	| { status: 'verified'; server: EndpointServerIdentity }
	| { status: 'refused'; reason: string }
	| { status: 'unavailable'; reason: string };

export interface EndpointNativePort {
	readonly version: typeof ENDPOINT_NATIVE_PORT_VERSION;
	/** The platform this port reads the OS of; it must be the host's. */
	readonly platform: string;
	readonly transport: EndpointNativeTransport;
	/** Name the process serving the connected `handle` and check it is the endpoint service; anything else keeps it unused. */
	verifyServer(connection: {
		address: string;
		handle: unknown;
		signal: AbortSignal;
	}): Promise<EndpointServerVerification>;
}

/** The endpoint transport of `platform`, or null where the endpoint ships none. */
export function endpointTransportOf(platform: string): EndpointNativeTransport | null {
	if (platform === 'linux' || platform === 'darwin') return 'unix-socket';
	if (platform === 'win32') return 'named-pipe';
	return null;
}

/** The longest Unix socket path every supported kernel accepts (`sun_path` less the terminator). */
export const ENDPOINT_MAX_SOCKET_PATH_BYTES = 103;
const PRINCIPAL = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
/** A LOCAL pipe only; a `\\host\pipe\` name crosses SMB, where no OS peer is known. */
const LOCAL_PIPE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,200}$/;

/** Why `address` is not an endpoint address on `platform`, or null. Pure. */
export function endpointAddressProblem(platform: string, address: string): string | null {
	const transport = endpointTransportOf(platform);
	if (transport === null) return `The endpoint has no transport on ${platform}.`;
	if (typeof address !== 'string' || address.length === 0) return 'The endpoint address is empty.';
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) || /^(localhost|127\.|\[::1\])/i.test(address)) {
		return 'The endpoint is reached over a local socket or pipe only; a URL, host or port is not accepted.';
	}
	if (transport === 'named-pipe') {
		return LOCAL_PIPE.test(address)
			? null
			: 'On Windows the endpoint is a local named pipe (\\\\.\\pipe\\<name>); a remote pipe or a file path is not accepted.';
	}
	if (!address.startsWith('/')) return 'The socket path must be absolute.';
	if (new TextEncoder().encode(address).length > ENDPOINT_MAX_SOCKET_PATH_BYTES) {
		return `The socket path is longer than ${ENDPOINT_MAX_SOCKET_PATH_BYTES} bytes.`;
	}
	return null;
}

/**
 * Why `native` cannot authenticate the endpoint on `platform`, or null. Linux
 * needs none (its socket directory is the service's); macOS and Windows need a
 * port of this version, for this platform and its transport. Pure.
 */
export function endpointNativePortProblem(
	platform: string,
	native: EndpointNativePort | undefined
): string | null {
	const transport = endpointTransportOf(platform);
	if (transport === null) return `The endpoint has no transport on ${platform}.`;
	if (!native) {
		return platform === 'linux'
			? null
			: `No native endpoint port is installed for ${platform}, so the process behind the ${transport} cannot be named; the endpoint is unavailable.`;
	}
	if (native.version !== ENDPOINT_NATIVE_PORT_VERSION) {
		return `The native endpoint port speaks version ${String(native.version)}, not ${ENDPOINT_NATIVE_PORT_VERSION}.`;
	}
	if (native.platform !== platform) {
		return `The native endpoint port reads ${native.platform}, not this host's ${platform}.`;
	}
	if (native.transport !== transport) {
		return `The native endpoint port verifies a ${native.transport}; ${platform} reaches the endpoint over a ${transport}.`;
	}
	return typeof native.verifyServer === 'function' ? null : 'The native port cannot verify.';
}

/** What is wrong with a verification the native port returned (a verified one must name a whole identity). Pure. */
export function endpointServerVerificationProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['the verification is not an object'];
	if (value.status === 'refused' || value.status === 'unavailable') {
		return [
			`the native port answered ${value.status}: ${typeof value.reason === 'string' ? value.reason : 'no reason'}`,
		];
	}
	if (value.status !== 'verified') return ['the verification has no known status'];
	const server = value.server;
	if (!isRecord(server)) return ['a verified answer names no server'];
	const checks: Array<[boolean, string]> = [
		[Number.isSafeInteger(server.pid) && (server.pid as number) > 0, 'pid is not a process id'],
		[isEndpointDigest(server.processBirthDigest), 'processBirthDigest is not a digest'],
		[isEndpointDigest(server.executableDigest), 'executableDigest is not a digest'],
		[typeof server.principal === 'string' && PRINCIPAL.test(server.principal), 'bad principal'],
	];
	return checks.filter(([ok]) => !ok).map(([, problem]) => `server.${problem}`);
}

/**
 * Local PREPARED/1 consumer seam, not a published wire operation. Only an
 * authenticated, negotiated producer may install this port. It resolves and
 * pins executable/resource identities, policy/DLP/route/credential constraints,
 * consumes once durably, and owns reconciliation and descendant revocation.
 * Its original lease owns bind/release/unknown settlement; never remint one
 * from executionBinding, executionConsumption or a broker_dispatched receipt.
 */
export interface PreparedExecutionPort extends Omit<HostAuthority, 'admit'> {
	readonly version: 1;
	admit(
		request: AdmissionRequest,
		binding: {
			identity: ManagedIdentityRecord;
			/** Socket generation under which the actor registration was authenticated. */
			connection: number;
		}
	): Promise<AdmissionOutcome>;
}

/**
 * The transport port. Everything it answers is an `EndpointInvokeOutcome`;
 * nothing it answers is authority. A host decides what to believe from a
 * status it received over a registered, attached connection, never from the
 * fact that a socket accepted bytes.
 */
export interface EndpointPort {
	/** Absent until a prepared protocol is published and authenticated negotiation succeeds. */
	readonly preparedExecution?: PreparedExecutionPort;
	readonly socketPath: string;
	state(): EndpointConnectionState;
	compatibility(
		request: EndpointCompatibilityRequest
	): Promise<EndpointInvokeOutcome<EndpointCompatibilityResult>>;
	attach(request: EndpointAttachmentRequest): Promise<EndpointInvokeOutcome<EndpointStatus>>;
	/** Any operation after `attach`; the payload is passed through and answered as the endpoint sent it. */
	invoke(
		operation: LocalEndpointOperation,
		payload: unknown
	): Promise<EndpointInvokeOutcome<unknown>>;
	/** Protocol 2 on its own path; absent on a port that speaks v1 only. v1 stays the default. */
	readonly v2?: EndpointPortV2;
	registration: {
		challenge(input: {
			runtimeId: string;
			processEpoch: string;
		}): Promise<EndpointInvokeOutcome<EndpointRegistrationApproval>>;
		redeem(): Promise<EndpointInvokeOutcome<EndpointRegistrationReceipt>>;
	};
	/** Drop the current socket so the next call dials fresh; the completed registration is kept. */
	redial(): void;
	/** Drop the connection; the endpoint's session for it ends with it. */
	close(): Promise<void>;
}

/**
 * The protocol 2 side of an `EndpointPort`. Every call goes to
 * `/v2/invoke` only: a v2 refusal (`unsupported_version` included) is
 * returned as the refusal and is never retried on `/v1/invoke`.
 */
export interface EndpointPortV2 {
	/**
	 * The v2 attachment on `/v2/invoke`: `supportedProtocols` [2], validated
	 * before a byte leaves. `attached` at protocol 2 records the negotiation on
	 * the connection state; any other answer leaves none.
	 */
	attach(req: EndpointAttachmentRequestV2): Promise<EndpointInvokeOutcome<EndpointStatusV2>>;
	/** Whether the current connection's v2 attachment negotiated `operation`. */
	negotiated(operation: string): boolean;
	/** One v2 envelope out, one answer read against it. `attachment` goes through `attach()`. */
	invoke(operation: string, payload: unknown): Promise<EndpointInvokeOutcome<unknown>>;
	registration: {
		/**
		 * The `registration_use` lookup: `unavailable` / `not-negotiated` with
		 * nothing sent unless the current v2 attachment negotiated it, otherwise
		 * `{}` on `/v2/invoke` and the reply validated by
		 * `endpointRegistrationUseReplyProblems` (`unavailable` / `malformed`
		 * when it fails). A projected or denied reply is `ok`.
		 */
		use(): Promise<EndpointInvokeOutcome<EndpointRegistrationUseReply>>;
	};
}

/** The serializable identity record a host's custody holds (`src/main/enterprise/identity-store.ts` is the sealed home). */
export type ManagedIdentityManagement =
	| 'enrolling'
	| 'enrolled'
	| 'suspended'
	| 'revoked'
	| 'retired';

export interface ManagedIdentityEndpointRef {
	socketPath: string;
	bindingDigest: string;
	trustRootDigest: string | null;
}

export interface ManagedIdentityRegistration {
	challengeId: string;
	actorId: string | null;
	runtimeId: string;
	processEpoch: string;
	bindingDigest: string;
	processBirthDigest: string | null;
	challengeDigest: string;
	expiresAt: string;
	registeredAt: string;
}

export interface ManagedIdentityRecord {
	version: 1;
	installationId: string;
	tenantId: string;
	orgId: string;
	/** Null until the endpoint reports it; the runtime socket does not carry it today. */
	enrollmentId: string | null;
	endpoint: ManagedIdentityEndpointRef;
	management: ManagedIdentityManagement;
	registration: ManagedIdentityRegistration | null;
	policy: {
		desiredRevision: number | null;
		appliedRevision: number | null;
		observedAt: string | null;
	};
	enrolledAt: string;
	updatedAt: string;
}

/** What a host may see of its identity custody: never the sealed file's own facts, never a secret. */
export interface ManagedIdentityView {
	status: 'none' | 'ok' | 'unprotected' | 'untrusted';
	reason: string | null;
	message: string | null;
	record: ManagedIdentityRecord | null;
}

/**
 * What this host believes about its managed standing, as one serializable
 * answer for a status pane, a CLI verb or a log line. `authority` is the only
 * field a sink may act on: `registered` means custody is protected, the record
 * says enrolled, THIS process redeemed an actor registration, the socket is
 * attached and the endpoint answered `managed`. Everything else is `none`.
 */
export interface ManagedEnrollmentStatus {
	identity: ManagedIdentityView;
	connection: EndpointConnectionState | null;
	endpoint: EndpointStatus | null;
	authority: 'none' | 'registered';
	/** Why authority is none, in one sentence; null when it is registered. */
	reason: string | null;
	/** An open registration challenge the actor must approve, with when it lapses. */
	pendingApproval: { challengeId: string; expiresAt: string } | null;
	lastDenial: { at: string; operation: string; reason: LocalEndpointDenialReason } | null;
}

/** The custody port a host injects beside the transport. Reads only; writes stay with the enrollment lifecycle. */
export interface ManagedIdentityPort {
	read(): ManagedIdentityView;
}
