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

export const LOCAL_ENDPOINT_PROTOCOL = 1 as const;
export const LOCAL_ENDPOINT_SCHEMA_VERSION = 1 as const;
export const LOCAL_ENDPOINT_INVOKE_PATH = '/v1/invoke';
export const LOCAL_ENDPOINT_REGISTRATION_CHALLENGE_PATH = '/v1/registration/challenge';
export const LOCAL_ENDPOINT_REGISTRATION_REDEEM_PATH = '/v1/registration/redeem';
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

export interface LocalEndpointEnvelope {
	schemaVersion: typeof LOCAL_ENDPOINT_SCHEMA_VERSION;
	correlationId: string;
	operation: LocalEndpointOperation;
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
	if (!Array.isArray(value.supportedProtocols) || value.supportedProtocols.join() !== '1') {
		problems.push('supportedProtocols is not [1]');
	}
	if (!isStringList(value.supportedCapabilities, 128))
		problems.push('supportedCapabilities is not a capability list');
	if (!isStringList(value.requiredCapabilities, 128))
		problems.push('requiredCapabilities is not a capability list');
	return problems;
}

export function endpointStatusProblems(value: unknown): string[] {
	if (!isRecord(value)) return ['status is not an object'];
	const problems: string[] = [];
	if (value.outcome !== 'attached') problems.push('outcome is not attached');
	if (value.protocol !== LOCAL_ENDPOINT_PROTOCOL) problems.push('protocol is not 1');
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
	if (!isRecord(raw)) return { ok: false, problem: 'response is not an object' };
	if (raw.schemaVersion !== LOCAL_ENDPOINT_SCHEMA_VERSION) {
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
	| 'http-status';

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
}

/**
 * The transport port. Everything it answers is an `EndpointInvokeOutcome`;
 * nothing it answers is authority. A host decides what to believe from a
 * status it received over a registered, attached connection, never from the
 * fact that a socket accepted bytes.
 */
export interface EndpointPort {
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
