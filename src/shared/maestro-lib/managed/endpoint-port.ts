/**
 * The local endpoint port: what a Maestro host speaks to the Mega-Maestro
 * endpoint daemon over its private Unix socket, and the two ports a host
 * injects so that a desktop, a `maestro-cli host` and a TUI drive the same
 * code with their own custody and transport.
 *
 * The production wire is protocol 2 (contracts 0.3.0): one `POST /v2/invoke`
 * per operation, a JSON envelope `{ schemaVersion: 2, correlationId,
 * operation, payload }` both ways, the registration handshake
 * (`registration_challenge`, `registration_redeem`) included. A request of at most 1 MiB,
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

/**
 * The endpoint wire protocol: one JSON envelope per `POST /v2/invoke`, both
 * ways. It is the only protocol this client speaks; there is no earlier one.
 */
export const LOCAL_ENDPOINT_PROTOCOL = 2 as const;
export const LOCAL_ENDPOINT_INVOKE_PATH = '/v2/invoke';

/**
 * The pre-registration handshake (contracts 0.3.0 `localEndpointContractsV2`):
 * two v2 envelopes on ONE connection, before any attachment. A pending
 * challenge never moves to another socket.
 */
export const LOCAL_ENDPOINT_REGISTRATION_CHALLENGE_OPERATION = 'registration_challenge' as const;
export const LOCAL_ENDPOINT_REGISTRATION_REDEEM_OPERATION = 'registration_redeem' as const;
/** Pre-release contract: registration is purpose-bound v2 only, with no v1 fallback. */
export const LOCAL_ENDPOINT_REGISTRATION_VERSION = 2 as const;
export const LOCAL_ENDPOINT_REGISTRATION_PURPOSE = 'runtime_use' as const;
export const LOCAL_ENDPOINT_MAX_REQUEST_BYTES = 1024 * 1024;
export const LOCAL_ENDPOINT_MAX_RESPONSE_BYTES = 64 * 1024;
/** The endpoint's own request deadline; a client waits no longer than this plus slack. */
export const LOCAL_ENDPOINT_TIMEOUT_MS = 5_000;

export const LOCAL_ENDPOINT_OPERATIONS = [
	'attachment',
	'compatibility',
	'registration_use',
	'registration_challenge',
	'registration_redeem',
	'enrollment',
	'noticeList',
	'offline',
	'desktopPolicy',
	'telemetry',
	'inbox',
	'budget',
	'model',
	'command',
	'localControl',
	'execution',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
] as const;
export type LocalEndpointOperation = (typeof LOCAL_ENDPOINT_OPERATIONS)[number];

/** Operations whose request, once sent, may have had an effect; a lost answer is `unknown`, not a retry. */
export const LOCAL_ENDPOINT_EFFECTFUL_OPERATIONS: readonly LocalEndpointOperation[] = [
	'registration_redeem',
	'enrollment',
	'inbox',
	'telemetry',
	'budget',
	'offline',
	'model',
	'localControl',
	'command',
	'execution',
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
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

/**
 * The attachment, one per connection on `/v2/invoke`. `supportedProtocols` is
 * exactly [2]; every required capability must also be supported, and neither
 * list may repeat an entry.
 */
export interface EndpointAttachmentRequest {
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	components: readonly EndpointComponent[];
	supportedProtocols: readonly [typeof LOCAL_ENDPOINT_PROTOCOL];
	supportedCapabilities: readonly string[];
	requiredCapabilities: readonly string[];
}

export type EndpointManagementState = 'unenrolled' | 'enrolling' | 'managed' | 'suspended';
export type EndpointConnectivity = 'online' | 'offline' | 'unavailable';
export type EndpointCollectionProfile = 'metadata' | 'redacted' | 'full' | 'full_vibes';

/**
 * The endpoint's answer to an attachment: what it is to this peer, right now.
 * `protocol` is the protocol the attachment negotiated on the connection.
 */
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
 * The v2 `compatibility` request (the contract's `protocolNegotiationRequest`):
 * availability only, answered before any attachment. Every required
 * capability must also be supported.
 */
export interface EndpointCompatibilityRequest {
	supportedProtocols: readonly [typeof LOCAL_ENDPOINT_PROTOCOL];
	supportedCapabilities: readonly string[];
	requiredCapabilities: readonly string[];
}

/** The v2 `compatibility` answer (`protocolNegotiationResult` at protocol 2). */
export interface EndpointCompatibilityResult {
	outcome: 'negotiated';
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	capabilities: readonly string[];
}

/** What a v2 attachment negotiated on the current connection. */
export interface EndpointNegotiation {
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	/** The capabilities the endpoint selected; an operation is negotiated only when it is listed here. */
	capabilities: readonly string[];
	status: EndpointStatus;
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

/** The `registration_redeem` answer: `{ outcome: "registered" }`, with no protocol tag (the v2 envelope carries it). */
export interface EndpointRegistrationReceipt {
	outcome: 'registered';
}

// ---------------------------------------------------------------------------
// Relayed enrollment (contracts 0.3.0, decision D1), field for field
// ---------------------------------------------------------------------------
//
// The endpoint's service custody holds the non-exportable key and signs; the
// central browser administration runs begin, prove and activate between the
// phases. Every phase names the installation's approved management origin,
// tenant and trust, and every result echoes them. No phase takes or returns a
// bearer, invitation, private key or the challenge nonce's answer.

/** `enrollmentManagementV2`: a canonical HTTPS origin (`new URL(o).origin`), the tenant and the issuer digest. */
export interface EndpointEnrollmentManagement {
	origin: string;
	tenantId: string;
	issuerSha256: string;
}

/** `possessionChallenge`: what the operator's central begin issued for the service key to sign. */
export interface EndpointPossessionChallenge {
	id: string;
	enrollmentId: string;
	/** 43 characters of `[A-Za-z0-9_-]`. */
	nonce: string;
	expiresAt: string;
}

/** `enrollmentActivationV2`: the certificate the operator's central activation issued, and its trust. */
export interface EndpointEnrollmentActivation {
	enrollmentId: string;
	certificatePem: string;
	trust: {
		tenantId: string;
		certificatePem: string;
		issuerSha256: string;
		keyStorage: 'software' | 'customer_kms';
	};
}

/**
 * The protocol the pinned 0.3.0 enrollment phase request names for its
 * `identity`: the contract types that field with the attachment schema of
 * local-endpoint.js, which admits only protocol 1. It is a fact of the contract,
 * not a wire path: the phase itself travels on `/v2/invoke` like every
 * operation. Moving the field to protocol 2 is a contract change Mega owns; until
 * it lands, Maestro sends what the contract accepts.
 */
export const ENROLLMENT_IDENTITY_PROTOCOL = 1 as const;

/** The `identity` of a request phase: the attachment the contract fixes for enrollment. */
export type EndpointEnrollmentIdentity = Omit<EndpointAttachmentRequest, 'supportedProtocols'> & {
	supportedProtocols: readonly [typeof ENROLLMENT_IDENTITY_PROTOCOL];
};

/** `enrollmentPhaseRequestV2`: one relayed phase per request. */
export type EndpointEnrollmentPhaseRequest =
	| {
			phase: 'request';
			management: EndpointEnrollmentManagement;
			serverCaPem: string;
			identity: EndpointEnrollmentIdentity;
	  }
	| {
			phase: 'prove';
			management: EndpointEnrollmentManagement;
			challenge: EndpointPossessionChallenge;
	  }
	| {
			phase: 'activate';
			management: EndpointEnrollmentManagement;
			activation: EndpointEnrollmentActivation;
	  };

export type EndpointEnrollmentPhase = EndpointEnrollmentPhaseRequest['phase'];

/** `enrollmentPhaseResultV2`: the outcome each phase answers, echoing the management it named. */
export type EndpointEnrollmentPhaseResult =
	| {
			outcome: 'enrollment_requested';
			management: EndpointEnrollmentManagement;
			requestId: string;
			identity: EndpointAttachmentRequest & {
				publicKeyPem: string;
				keyStorage: 'software' | 'platform_non_exportable';
			};
	  }
	| {
			outcome: 'possession_signed';
			management: EndpointEnrollmentManagement;
			enrollmentId: string;
			challengeId: string;
			/** 86 characters of base64url. */
			signature: string;
	  }
	| {
			outcome: 'enrolled';
			management: EndpointEnrollmentManagement;
			enrollmentId: string;
			keyStorage: 'software' | 'platform_non_exportable';
	  };

/** The outcome each phase must answer (the contract's `enrollmentOutcomes`). */
export const ENDPOINT_ENROLLMENT_PHASE_OUTCOMES = Object.freeze({
	request: 'enrollment_requested',
	prove: 'possession_signed',
	activate: 'enrolled',
} as const);

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
export const LOCAL_ENDPOINT_WORKFLOW_OPERATIONS = [
	'workflow_claim',
	'workflow_renew',
	'workflow_settle',
	'workflow_release',
] as const;
export type EndpointWorkflowOperation = (typeof LOCAL_ENDPOINT_WORKFLOW_OPERATIONS)[number];

/**
 * The contract's `workflowOwnerReference`. `ownerEpoch` is an opaque
 * identifier string in v2, never v1's numeric epoch. A claim never sends one;
 * the producer returns it, and renew, settle and release echo it.
 */
export interface EndpointWorkflowOwner {
	ownerId: string;
	ownerEpoch: string;
	fencingToken: string;
}

/** The contract's `grantReference`: a grant UUID and the digest of its record. */
export interface EndpointGrantReference {
	grantId: string;
	digest: string;
}

/** The contract's `delegationReference`: the presented grant and its root-first chain ending in it. */
export interface EndpointDelegationReference {
	grant: EndpointGrantReference;
	chain: readonly EndpointGrantReference[];
}

/**
 * The contract's `workflowContextV2` (`operationAuthorityReferences` plus the
 * workflow lineage). References only: nothing here is an actor or authority.
 */
export interface EndpointWorkflowContext {
	registration: EndpointRuntimeUseReference;
	delegation: EndpointDelegationReference | null;
	/** At most 32, unique by `grantId`. */
	grants: readonly EndpointGrantReference[];
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
export interface EndpointWorkflowClaimRequest extends EndpointWorkflowContext {
	/** An integer from 1 to `ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS`. */
	requestedLeaseMs: number;
}

/** `workflowRenewRequest`: a claim that echoes the owner it holds. */
export interface EndpointWorkflowRenewRequest extends EndpointWorkflowClaimRequest {
	owner: EndpointWorkflowOwner;
}

/** The contract's `commandExecutionEffect`: settled with evidence, or uncertain with a reason. */
export type EndpointWorkflowEffect =
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
export interface EndpointWorkflowSettleRequest extends EndpointWorkflowContext {
	owner: EndpointWorkflowOwner;
	effect: EndpointWorkflowEffect;
}

/** `workflowReleaseRequest`: custody surrendered only once every effect settled or none began. */
export interface EndpointWorkflowReleaseRequest extends EndpointWorkflowContext {
	owner: EndpointWorkflowOwner;
	disposition: 'effects_settled' | 'no_effect_started';
}

/** `workflowLease`: the context echoed with the owner and a bounded positive lifetime. */
export interface EndpointWorkflowLease extends EndpointWorkflowContext {
	owner: EndpointWorkflowOwner;
	/** A timestamp; `expiresAt` follows it by at most `ENDPOINT_WORKFLOW_MAXIMUM_LEASE_MS`. */
	acquiredAt: string;
	expiresAt: string;
}

/** `workflowSettlementReceipt`: the settle request echoed, recorded. */
export interface EndpointWorkflowSettlementReceipt extends EndpointWorkflowSettleRequest {
	outcome: 'recorded';
	recordedAt: string;
}

/** `workflowReleaseReceipt`: the release request echoed, released. */
export interface EndpointWorkflowReleaseReceipt extends EndpointWorkflowReleaseRequest {
	outcome: 'released';
	releasedAt: string;
}

export type EndpointWorkflowClaimReply =
	| { outcome: 'owned'; lease: EndpointWorkflowLease }
	| EndpointDenied;
export type EndpointWorkflowRenewReply =
	| { outcome: 'renewed'; lease: EndpointWorkflowLease }
	| EndpointDenied;
export type EndpointWorkflowSettleReply = EndpointWorkflowSettlementReceipt | EndpointDenied;
export type EndpointWorkflowReleaseReply = EndpointWorkflowReleaseReceipt | EndpointDenied;

/** Each lifecycle operation's request and reply, keyed by its wire name. */
export interface EndpointWorkflowExchange {
	workflow_claim: { request: EndpointWorkflowClaimRequest; reply: EndpointWorkflowClaimReply };
	workflow_renew: { request: EndpointWorkflowRenewRequest; reply: EndpointWorkflowRenewReply };
	workflow_settle: {
		request: EndpointWorkflowSettleRequest;
		reply: EndpointWorkflowSettleReply;
	};
	workflow_release: {
		request: EndpointWorkflowReleaseRequest;
		reply: EndpointWorkflowReleaseReply;
	};
}

// ---------------------------------------------------------------------------
// v2 execution (contracts 0.3.0 protocol.js), field for field
// ---------------------------------------------------------------------------

/** The envelope operation `/v2/invoke` carries a run submission under. */
export const LOCAL_ENDPOINT_EXECUTION_OPERATION = 'execution' as const;
/** The payload's own `operation`: `runs.submit`, the sole v2 execution body. */
export const ENDPOINT_EXECUTION_PAYLOAD_OPERATION = 'runs.submit' as const;

/** The contract's `executionWorkflowReferenceV2`: the claimed workflow and the owner custody echoed. */
export interface EndpointExecutionWorkflow {
	workflowId: string;
	workflowVersion: string;
	triggerId: string;
	owner: EndpointWorkflowOwner;
}

/**
 * The contract's `executionRequestV2` (`runs.submit`), every field. The
 * authority references (`registration`, `delegation`, `grants`) and the
 * workflow custody are echoed from the producer's lease; the endpoint
 * resolves each of them under its own custody, so nothing here is authority.
 */
export interface EndpointExecutionRequest {
	requestId: string;
	attemptId: string;
	runId: string;
	source: 'ux' | 'cli' | 'cue' | 'headless';
	provider: string;
	model: string;
	policyRevision: number;
	operation: typeof ENDPOINT_EXECUTION_PAYLOAD_OPERATION;
	agentId: string;
	contentRef: string;
	/** Lowercase SHA-256 hex of the approved content. */
	contentSha256: string;
	/** At most 64. */
	resourceIds: readonly string[];
	idempotencyKey: string;
	workflow: EndpointExecutionWorkflow | null;
	registration: EndpointRuntimeUseReference;
	delegation: EndpointDelegationReference | null;
	grants: readonly EndpointGrantReference[];
	rootRunId: string;
	parentRunId: string | null;
}

/**
 * The contract's `dispatchReceiptV2`: the broker reports dispatch, never
 * completion. `unknown` is an uncertain dispatch that needs durable
 * reconciliation before anything is settled.
 */
export interface EndpointDispatchReceipt {
	outcome: 'broker_dispatched';
	requestId: string;
	attemptId: string;
	runId: string;
	decisionId: string;
	requestDigest: string;
	brokerId: string;
	policyRevision: number;
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL;
	/** The grant the broker dispatched under (a UUID). */
	grantId: string;
	idempotencyKey: string;
	authorityDigest: string;
	ownerGeneration: number;
	state: 'dispatched' | 'unknown';
}

// ---------------------------------------------------------------------------
// The v2 operation clients (contracts 0.2.0 protocol.js), field for field
// ---------------------------------------------------------------------------
//
// Every operation below is carried on `/v2/invoke` under its wire name, with the
// domain schema the contract shares (local-endpoint.js and desktop-policy.js); no
// shape here is pending a later Mega batch. Schema presence is not support: an
// operation is sent only when the attachment on the current connection
// negotiated it.

/** The v2 operations Maestro has a client for, by their wire names. */
export const LOCAL_ENDPOINT_OPERATION_CLIENTS = [
	'noticeList',
	'inbox',
	'telemetry',
	'budget',
	'offline',
	'desktopPolicy',
	'model',
	'localControl',
	'command',
] as const;
export type EndpointOperationClient = (typeof LOCAL_ENDPOINT_OPERATION_CLIENTS)[number];

/** `noticeListRequest`: offset 0..7, limit 1..8; each page is freshly authorized. */
/** `noticeListResult` or `denied`. */
export type EndpointNoticeListReply = EndpointNoticeListResult | EndpointDenied;

/**
 * `inboxRequest`: the inbox request as the wire carries it. A resend keeps its
 * `idempotencyKey`, so it stays one receipt.
 */
/** `inboxReceipt` or `denied`. */
export type EndpointInboxReply = EndpointInboxReceipt | EndpointDenied;

/** The inbox request as it is sent: every field copied, `idempotencyKey` unchanged. */
export function inboxRequest(request: EndpointInboxRequest): EndpointInboxRequest {
	return {
		campaignId: request.campaignId,
		messageId: request.messageId,
		idempotencyKey: request.idempotencyKey,
		action: request.action,
	};
}

/** `incomingMetadataEvent`, as this host sends it (the runtime-report subset). */
export type EndpointTelemetryRequest = EndpointTelemetryEvent;
/** The contract's `durableReceipt`. */
export interface EndpointDurableReceipt {
	outcome: 'durably_accepted';
	eventId: string;
	receivedAt: string;
	duplicate: boolean;
}
export type EndpointTelemetryReply = EndpointDurableReceipt | EndpointDenied;

/** The contract's `budgetRequest`. */
export interface EndpointBudgetRequest {
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
export interface EndpointBudgetReceipt {
	outcome: 'reserved';
	reservationId: string;
	destinationId: string;
	attributedOrgId: string;
	maximumUnits: number;
	expiresAt: string;
}
export type EndpointBudgetReply = EndpointBudgetReceipt | EndpointDenied;

/** The contract's `offlineRequest`. */
export interface EndpointOfflineRequest {
	policyRevision: number;
	verifiedPolicyDigest: string;
	exceptionExpiresAt: string | null;
	allowanceId: string;
	allowanceExpiresAt: string;
	signedAllowance: string;
	clockState: 'trusted' | 'uncertain' | 'rollback_detected';
}
/** The contract's `offlineResult`. */
export interface EndpointOfflineResult {
	outcome: 'offline_active';
	policyRevision: number;
	allowanceId: string;
	validUntil: string;
	remainingUnits: number;
}
export type EndpointOfflineReply = EndpointOfflineResult | EndpointDenied;

/** The contract's `desktopAuthoringRequest` (desktop-policy.js). */
export interface EndpointDesktopAuthoringRequest {
	subject: 'agent' | 'tab';
	operation: DesktopAuthoringOperation;
	items: number;
	resultingCount: number;
	selections: Record<string, readonly string[]>;
	managedSettingKeys: readonly string[];
	personalSettingKeys: readonly string[];
}
/** The contract's `desktopSettingsRequest`: a projection, or a decision on one exact authoring request. */
export type EndpointDesktopPolicyRequest =
	| { kind: 'projection' }
	| { kind: 'authorize'; projectionDigest: string; request: EndpointDesktopAuthoringRequest };
/** The contract's `desktopDecisionReceipt`: metadata only, never a grant. */
export interface EndpointDesktopDecisionReceipt {
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
export type EndpointDesktopPolicyReply =
	| { outcome: 'projection'; result: DesktopPolicyResult; projectionDigest: string | null }
	| { outcome: 'decision'; receipt: EndpointDesktopDecisionReceipt }
	| EndpointDenied;

/** The contract's `modelInvocationRequest`. */
export interface EndpointModelRequest {
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
export interface EndpointModelResult {
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
export type EndpointModelReply = EndpointModelResult | EndpointDenied;

// ---------------------------------------------------------------------------
// Local control (decision D2) and signed v2 commands (contracts 0.3.0)
// ---------------------------------------------------------------------------

/** The local GUI selectors `localControl` carries (the `commandRequest` actions of local-endpoint.js). */
export type EndpointLocalControlAction =
	| { kind: 'cancel_run'; runId: string }
	| { kind: 'refresh_policy'; desiredRevision: number }
	| { kind: 'report_status' };

export type EndpointLocalControlKind = EndpointLocalControlAction['kind'];

/**
 * The registration purpose each selector needs (the contract's
 * `localControlAuthority`): the endpoint authorizes the peer for it on every
 * call, and this client refuses to send one its own registration cannot carry.
 */
export const ENDPOINT_LOCAL_CONTROL_AUTHORITY: Readonly<
	Record<EndpointLocalControlKind, 'runtime_use' | 'fleet_management'>
> = Object.freeze({
	cancel_run: 'runtime_use',
	report_status: 'runtime_use',
	refresh_policy: 'fleet_management',
});

/**
 * `localControlRequest`: the `commandRequest` shape, never a signed body.
 * A selector that reaches no run sends `expectedRunId: null`; a cancel must
 * expect the run it names.
 */
export interface EndpointLocalControlRequest {
	commandId: string;
	targetId: string;
	expiresAt: string;
	policyRevision: number;
	precondition: { processEpoch: string; expectedRunId: string | null };
	action: EndpointLocalControlAction;
}

/** The `commandReceipt` that `localControl` answers. */
export interface EndpointLocalControlReceipt {
	outcome: 'accepted' | 'completed' | 'unknown';
	commandId: string;
}
export type EndpointLocalControlReply = EndpointLocalControlReceipt | EndpointDenied;

/**
 * `commandRequestV2`: the signed central delivery embedded unchanged, and its
 * correlation (`operationAuthorityReferences` plus request, attempt and
 * envelope digest). The signature is the issuer's; this client never builds
 * or alters one, and the endpoint verifies it.
 */
export interface EndpointCommandRequest {
	command: Record<string, unknown> & { payload: Record<string, unknown> & { commandId: string } };
	correlation: Record<string, unknown> & {
		registration: Record<string, unknown>;
		requestId: string;
		attemptId: string;
		envelopeDigest: string;
	};
}

/** `commandReceiptV2`: the outcome, the command, its run and epoch, and the correlation echoed exactly. */
export interface EndpointCommandReceipt {
	outcome: 'accepted' | 'completed' | 'unknown';
	commandId: string;
	runId: string;
	processEpoch: string;
	correlation: EndpointCommandRequest['correlation'];
}
export type EndpointCommandReply = EndpointCommandReceipt | EndpointDenied;

/** Each v2 operation client's request and reply, keyed by its wire name. */
export interface EndpointOperationExchange {
	noticeList: { request: EndpointNoticeListRequest; reply: EndpointNoticeListReply };
	inbox: { request: EndpointInboxRequest; reply: EndpointInboxReply };
	telemetry: { request: EndpointTelemetryRequest; reply: EndpointTelemetryReply };
	budget: { request: EndpointBudgetRequest; reply: EndpointBudgetReply };
	offline: { request: EndpointOfflineRequest; reply: EndpointOfflineReply };
	desktopPolicy: { request: EndpointDesktopPolicyRequest; reply: EndpointDesktopPolicyReply };
	model: { request: EndpointModelRequest; reply: EndpointModelReply };
	localControl: { request: EndpointLocalControlRequest; reply: EndpointLocalControlReply };
	command: { request: EndpointCommandRequest; reply: EndpointCommandReply };
}

/**
 * The v2 operations an existing caller is moved onto. Each one is a
 * **passing** row of Mega's endpoint v2 parity matrix
 * (`docs/evidence/endpoint-v2/parity-matrix.md`, FINISH-08-06, observed at
 * Mega `dd9a42b0`), plus `execution` (Mega FINISH-10, handoff item 10),
 * whose only client is `createEndpointExecutionClient` in `./execution`;
 * no v1 caller moves onto it. Selection is not an offer: an operation is
 * still sent only when the attachment on the current connection negotiated
 * it, and otherwise nothing is sent, so `execution` stays unused until a peer
 * offers it. `src/main/enterprise/endpoint-ops.ts` re-exports it; this is
 * its one home so the shared callers can read it.
 */
export const ENDPOINT_OPERATIONS_OFFERED: readonly string[] = [
	'noticeList',
	'inbox',
	'telemetry',
	'budget',
	'offline',
	'desktopPolicy',
	'model',
	'localControl',
	'command',
	LOCAL_ENDPOINT_EXECUTION_OPERATION,
];

/** Whether the attachment on the connection behind `clientState` negotiated `operation`. False before an attachment. */
export function operationNegotiated(
	clientState: Pick<EndpointConnectionState, 'negotiated'>,
	operation: string
): boolean {
	return clientState.negotiated?.capabilities.includes(operation) ?? false;
}

/**
 * The one gate for a caller that is not an operation client: an operation is
 * sent only when the attachment on the current connection negotiated it;
 * otherwise `unavailable` / `not-negotiated` and nothing is sent.
 */
export async function invokeNegotiated(
	endpoint: Pick<EndpointPort, 'invoke' | 'negotiated'>,
	operation: LocalEndpointOperation,
	payload: unknown
): Promise<EndpointInvokeOutcome<unknown>> {
	if (!endpoint.negotiated(operation)) {
		return {
			status: 'unavailable',
			reason: 'not-negotiated',
			message: `The attachment on this connection did not negotiate ${operation}; nothing was sent.`,
		};
	}
	return endpoint.invoke(operation, payload);
}

/**
 * The protocol 2 envelope, both ways on `POST /v2/invoke`: the contract's
 * `localRequestEnvelopeV2` / `localResponseEnvelopeV2`. `operation` is a
 * plain string because the v2 operation set is the endpoint's, negotiated per
 * connection; the client checks it against what the attachment returned.
 */
export interface LocalEndpointEnvelope {
	schemaVersion: typeof LOCAL_ENDPOINT_PROTOCOL;
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

/** `endpointAttachmentRequestProblems` for protocol 2: [2], unique lists, required within supported. */
export function endpointAttachmentRequestProblems(value: unknown): string[] {
	const problems = attachmentRequestProblems(value, LOCAL_ENDPOINT_PROTOCOL);
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

function attachmentRequestProblems(
	value: unknown,
	protocol: typeof LOCAL_ENDPOINT_PROTOCOL
): string[] {
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

/** `endpointStatusProblems` for a v2 attachment answer: protocol 2, unique negotiated capabilities. */
export function endpointStatusProblems(value: unknown): string[] {
	const problems = statusProblems(value, LOCAL_ENDPOINT_PROTOCOL);
	if (isRecord(value) && isStringList(value.capabilities, 128) && !isUniqueList(value.capabilities))
		problems.push('capabilities repeats an entry');
	return problems;
}

function statusProblems(value: unknown, protocol: typeof LOCAL_ENDPOINT_PROTOCOL): string[] {
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
	if (value.outcome !== 'negotiated') problems.push('outcome is not negotiated');
	if (value.protocol !== LOCAL_ENDPOINT_PROTOCOL) problems.push('protocol is not 2');
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

/** Frame a request for `POST /v2/invoke`. */
export function frameLocalEndpointRequest(
	operation: string,
	payload: unknown,
	correlationId: string
): LocalEndpointEnvelope {
	if (!isEndpointIdentifier(correlationId))
		throw new Error('correlationId is not an endpoint identifier');
	if (!isEndpointIdentifier(operation)) throw new Error('operation is not an endpoint identifier');
	return { schemaVersion: LOCAL_ENDPOINT_PROTOCOL, correlationId, operation, payload };
}

/** `parseLocalEndpointResponse` for protocol 2: schemaVersion 2, same correlation and operation rule. */
export function parseLocalEndpointResponse(
	raw: unknown,
	expected: { correlationId: string; operation: string }
): { ok: true; payload: unknown } | { ok: false; problem: string } {
	return parseEnvelopeAnswer(raw, LOCAL_ENDPOINT_PROTOCOL, expected);
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
	| 'not-negotiated'
	/**
	 * This process's registration does not carry the purpose the request needs
	 * (`localControl`), or an execution carries no grant to run under; nothing was sent.
	 */
	| 'not-authorized'
	/**
	 * An execution's lease is no longer what is held: the owner store's fence,
	 * the lease's expiry, the current registration or the run's lineage moved;
	 * nothing was sent.
	 */
	| 'stale-authority'
	/** This client already sent an execution with that idempotency key; it is reconciled, not resent. */
	| 'duplicate';

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
	 * a failed attachment or a new connection drops it.
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
	/** Availability only, answered before any attachment; records nothing on the connection. */
	compatibility(
		request: EndpointCompatibilityRequest
	): Promise<EndpointInvokeOutcome<EndpointCompatibilityResult>>;
	/** The attachment: the one protocol this connection speaks, with the capabilities it negotiated. */
	attach(request: EndpointAttachmentRequest): Promise<EndpointInvokeOutcome<EndpointStatus>>;
	/**
	 * Any operation after `attach`, sent under its wire name on `/v2/invoke`. An
	 * operation the attachment on this connection did not negotiate is not sent
	 * (`unavailable` / `not-negotiated`).
	 */
	invoke(
		operation: LocalEndpointOperation,
		payload: unknown
	): Promise<EndpointInvokeOutcome<unknown>>;
	/** Whether the current connection's attachment negotiated `operation`. */
	negotiated(operation: string): boolean;
	registration: {
		challenge(input: {
			runtimeId: string;
			processEpoch: string;
		}): Promise<EndpointInvokeOutcome<EndpointRegistrationApproval>>;
		redeem(): Promise<EndpointInvokeOutcome<EndpointRegistrationReceipt>>;
		/**
		 * The `registration_use` lookup: `unavailable` / `not-negotiated` with nothing
		 * sent unless the current attachment negotiated it, otherwise the reply checked
		 * by `endpointRegistrationUseReplyProblems`. A projected or denied reply is `ok`.
		 */
		use(): Promise<EndpointInvokeOutcome<EndpointRegistrationUseReply>>;
	};
	/** Drop the current socket so the next call dials fresh; the completed registration is kept. */
	redial(): void;
	/** Drop the connection; the endpoint's session for it ends with it. */
	close(): Promise<void>;
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
	/**
	 * The `registration_use` reference the endpoint projected on the CURRENT
	 * connection, with its expiry; null until one is projected, after a new
	 * connection, and once it lapses. Read from the endpoint only, never
	 * computed here. Absent on a host that predates protocol 2.
	 */
	registrationUse?: { reference: EndpointRuntimeUseReference; expiresAt: string } | null;
}

/** The custody port a host injects beside the transport. Reads only; writes stay with the enrollment lifecycle. */
export interface ManagedIdentityPort {
	read(): ManagedIdentityView;
}
