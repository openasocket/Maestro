/**
 * The managed host adapter: how a Maestro host (the desktop, a `maestro-cli
 * host`, a TUI) turns an injected identity custody and an injected endpoint
 * socket into the `HostAuthority` its sinks admit with, without any of them
 * importing `src/main` or Electron.
 *
 * The adapter owns no custody and no transport. It is handed a
 * `ManagedIdentityPort` (reads the sealed record a host keeps; the desktop's
 * is `src/main/enterprise/identity-store.ts`), an `EndpointPort` (the socket
 * client; the desktop's is `src/main/enterprise/endpoint-client.ts`) and a
 * `status()` that says whether this process holds a registered, attached,
 * managed standing (the enrollment lifecycle's answer). From those it builds:
 *
 *   - `authority`: forwards the exact snapshot and authenticated context to
 *     the optional PREPARED/1 local port. The producer's original lease owns
 *     the protected process lifetime. A broker execution receipt is evidence
 *     of an effect, never permission to duplicate it locally. The published
 *     endpoint protocol has no prepared operation, so its client supplies no
 *     port and local admission remains unavailable. No speculative wire call
 *     or lossy execution request is sent as a substitute.
 *   - `policy()`: the sources admissions are decided on, which is the one
 *     endpoint the record names, at the revision it last reported.
 *   - the inputs the runtime mirrors into its own binding file under the
 *     data-directory lock (`bindingEnrollment`), so the lock holder and the
 *     sealed record agree on who answers for this installation.
 *
 * An enrolled record with no usable standing (custody unprotected or
 * untrusted, no socket, not registered in this process, the endpoint saying
 * anything but `managed`) answers `unavailable` on every admission. It never
 * answers standalone: that is what "enrolled contexts cannot omit authority"
 * means at the sink.
 *
 */

import { canonicalJson } from '../../canonicalJson';
import { generateUUID } from '../../uuid';
import type { ManagedRouteCeiling } from '../launch/env';
import { providerRouteSupport, type ManagedRoute } from '../providers/capabilities';
import {
	leaseAdmission,
	type DispatchAdmission,
	type DispatchAdmissionState,
	type DispatchAdmissionVerdict,
} from '../run/start-turn';
import type { EnrollInput, ManagedBindingState } from './binding';
import {
	buildDispatchSnapshot,
	createContextVerifier,
	dispatchSnapshotDigest,
	isVerifiedContext,
	sha256Hex,
	unavailableAuthority,
	type AdmissionOutcome,
	type AdmissionRequest,
	type ContextVerification,
	type DispatchAttribution,
	type DispatchLease,
	type DispatchSnapshot,
	type DispatchSpecLike,
	type HostAuthority,
	type PolicySourceSet,
} from './authority';
import {
	isEndpointIdentifier,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type EndpointStatus,
	type PreparedExecutionPort,
	type ManagedEnrollmentStatus,
	type ManagedIdentityPort,
	type ManagedIdentityRecord,
	type ManagedIdentityView,
} from './endpoint-port';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedAuthenticatedContext,
	type ManagedDelegationRef,
	type ManagedDenialCode,
	type ManagedInstallationIdentity,
	type ManagedOrigin,
	type ManagedPrincipalRef,
	type ManagedRunIdentity,
	type ManagedWorkflowRef,
	directDelegationRef,
} from './types';
import { endpointWorkflowOwnerPort, type WorkflowOwnerPort } from './workflows';
import {
	createManagedEffectAuthority,
	type ManagedEffectAuthority,
	type ManagedEffectProducer,
} from './effects';

// ---------------------------------------------------------------------------
// The spawn authority of a host with no Electron (maestro-cli, a headless
// host, a Cue engine), composed from the managed BINDING and, when this
// process is an attached host, the adapter above.
// ---------------------------------------------------------------------------

/**
 * What an attached host lends a headless spawn authority: its authority and
 * policy, and, when it composes one, the route ceiling producer the launch
 * plan bounds a provider's launch with (`ManagedRouteCeiling`, the same
 * object the desktop port's `routeCeiling` seam hands out). A host with no
 * producer bounds nothing by route; the admission on the snapshot decides,
 * as before.
 */
export interface HeadlessSpawnHost extends Pick<ManagedHostAdapter, 'authority' | 'policy'> {
	routeCeiling?(providerId: string): ManagedRouteCeiling | null;
}

export interface HeadlessSpawnAuthorityDeps {
	installation: ManagedInstallationIdentity;
	/** The binding this process read beside the data-dir lock (`createManagedBinding().state()` or the files). */
	binding: ManagedBindingState;
	/**
	 * The attached adapter when this process is itself a managed host
	 * (`maestro-cli host`); absent for a bare CLI invocation, which then holds
	 * no authority at all and refuses every managed launch as unavailable.
	 */
	host?: HeadlessSpawnHost | null;
	/** The origin the context carries; `cli` for maestro-cli, `headless` for a host. */
	origin: Extract<ManagedOrigin, 'cli' | 'headless' | 'cue'>;
	/** The principal this process acts as; attribution, never authority. */
	actor: ManagedPrincipalRef;
	now?: () => number;
}

export interface HeadlessSpawnContextInput {
	identity: ManagedRunIdentity;
	traceId: string;
	policyRevision: number | null;
	/**
	 * The workflow the launch belongs to, with its owner fence (an Auto Run, a
	 * Cue pipeline). Attribution: the authority decides whether it can bind
	 * one, and one it cannot bind is refused, never dropped. Default none.
	 */
	workflow?: ManagedWorkflowRef | null;
	/** The chain of principals behind the actor. Default a direct action. */
	delegation?: ManagedDelegationRef;
}

/**
 * What a non-desktop launch sink admits with. `standing()` is `standalone`
 * only when the binding says so; an enrolled binding whose authority this
 * process cannot reach (a bare CLI with no attached host, an adapter for
 * another binding, an unreadable file) is `managed` with an authority that
 * answers `unavailable` on every admission. Electron's absence is never an
 * opt-out: the binding is read from the same files the desktop writes, in
 * this data directory and the production one.
 */
export interface HeadlessSpawnAuthority {
	standing(): 'standalone' | 'managed';
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	/** Why the authority is unavailable, when it is; null when it answers. */
	readonly unavailableReason: string | null;
	context(input: HeadlessSpawnContextInput): ContextVerification;
	/**
	 * The route the attached host's policy pins for one provider
	 * (MRC2-03-03), handed to the launch plan as `managed.route` so the
	 * permission mode and the flags that ask for it are measured against its
	 * `permissionMode`. Null for a standalone binding, an authority with no
	 * attached host (nothing answers, and the admission refuses as
	 * unavailable anyway) and a host that composes no producer. Optional, as
	 * the desktop port's seam is: an authority composed by hand that lends
	 * none bounds nothing by route and the admission on the snapshot decides.
	 */
	routeCeiling?(providerId: string): ManagedRouteCeiling | null;
}

export function createHeadlessSpawnAuthority(
	deps: HeadlessSpawnAuthorityDeps
): HeadlessSpawnAuthority {
	const now = deps.now ?? (() => Date.now());
	const { binding } = deps;
	let authority: HostAuthority;
	let policy: () => PolicySourceSet;
	let unavailableReason: string | null = null;
	// Only an attached host that answers admissions lends a route ceiling;
	// every other standing bounds nothing by route (and admits nothing).
	let routeCeiling: (providerId: string) => ManagedRouteCeiling | null = () => null;
	switch (binding.state) {
		case 'standalone':
			authority = unavailableAuthority('This installation holds no enrollment.');
			policy = () => ({ sources: [], policyRevision: null });
			break;
		case 'enrolled':
			if (deps.host && deps.host.authority.authorityId === binding.record.authorityId) {
				const host = deps.host;
				authority = host.authority;
				policy = () => host.policy();
				routeCeiling = (providerId) => host.routeCeiling?.(providerId) ?? null;
			} else {
				unavailableReason = deps.host
					? `This process is attached to authority ${deps.host.authority.authorityId}, not to the binding's ${binding.record.authorityId}.`
					: 'This process holds no attached host authority; an enrolled installation launches through the desktop or a maestro-cli host.';
				authority = unavailableAuthority(unavailableReason);
				policy = () => ({
					sources: binding.record.policySources,
					policyRevision: binding.record.policyRevision,
				});
			}
			break;
		case 'enrolled-unavailable':
			unavailableReason = binding.reason;
			authority = unavailableAuthority(binding.reason);
			policy = () => ({
				sources: binding.record.policySources,
				policyRevision: binding.record.policyRevision,
			});
			break;
		case 'unreadable':
			unavailableReason = `The managed binding at ${binding.file} is unreadable: ${binding.reason}`;
			authority = unavailableAuthority(unavailableReason);
			policy = () => ({ sources: [], policyRevision: null });
			break;
	}
	const verifier = createContextVerifier({
		verifierId: `${deps.origin}:${deps.installation.runtimeId}`,
		peer: 'in-process',
		now,
		accept: (context) =>
			context.installation.installationId === deps.installation.installationId
				? []
				: [`installation ${context.installation.installationId} is not this one`],
	});
	return {
		standing: () => (binding.state === 'standalone' ? 'standalone' : 'managed'),
		authority,
		policy,
		unavailableReason,
		routeCeiling,
		context: (input) =>
			verifier.verify({
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: deps.installation,
				origin: deps.origin,
				actor: deps.actor,
				delegation: input.delegation ?? directDelegationRef(),
				identity: input.identity,
				policyRevision: input.policyRevision,
				workflow: input.workflow ?? null,
				traceId: input.traceId,
				requestedCapabilities: ['runs.submit'],
			}),
	};
}

/**
 * The installation identity a runtime and a desktop compute the same way, so
 * an adapter built before the runtime starts names the runtime it will serve.
 * `installationId` is a label for this machine and production data directory
 * (not a minted device identity); `runtimeId` names one host process by mode
 * and pid; `processEpoch` changes on every start and is an endpoint
 * identifier (hex), since the endpoint refuses a timestamp.
 */
export function installationIdentity(input: {
	hostname: string;
	productionDataDir: string;
	mode: string;
	pid: number;
	startedAt: string;
}): ManagedInstallationIdentity {
	return {
		installationId: sha256Hex(`${input.hostname}\n${input.productionDataDir}`).slice(0, 32),
		runtimeId: `${input.mode}-${input.pid}`,
		processEpoch: sha256Hex(`${input.pid}\n${input.startedAt}`).slice(0, 32),
	};
}

/** The authority id an enrollment record implies: one endpoint, one tenant, one organization. */
export function managedAuthorityId(record: ManagedIdentityRecord): string {
	const digest = sha256Hex(
		canonicalJson({
			tenantId: record.tenantId,
			orgId: record.orgId,
			socketPath: record.endpoint.socketPath,
		})
	);
	return `endpoint-${digest.slice(0, 16)}`;
}

/** What the runtime writes into its binding file for this record, under its lock. */
export function bindingEnrollment(record: ManagedIdentityRecord): EnrollInput {
	const authorityId = managedAuthorityId(record);
	return {
		installationId: record.installationId,
		authorityId,
		endpointRef: record.endpoint.socketPath,
		policySources: [{ id: authorityId, kind: 'endpoint', revision: record.policy.appliedRevision }],
		policyRevision: record.policy.appliedRevision,
	};
}

/**
 * The principal a managed launch runs as on this installation: the actor the
 * endpoint registered this process for, or the installation's operator before
 * one is registered. Attribution the sink binds, never authority: a keyboard,
 * a Web Login cookie and a host's own process are not enterprise principals,
 * and go on the delegation chain instead. Every host (the desktop's
 * `spawnPrincipal`, the headless runtime's Auto Run port) names it this way.
 */
export function managedActorPrincipal(
	identity: Pick<ManagedIdentityView, 'status' | 'record'> | null,
	installation: Pick<ManagedInstallationIdentity, 'installationId'>
): ManagedPrincipalRef {
	const registered =
		identity?.status === 'ok' ? (identity.record?.registration?.actorId ?? null) : null;
	return registered
		? { kind: 'human', id: registered }
		: { kind: 'human', id: `operator:${installation.installationId}` };
}

export interface ManagedHostAdapterDeps {
	installation: ManagedInstallationIdentity;
	identity: ManagedIdentityPort;
	endpoint: EndpointPort | null;
	/** Trusted host injection only, after EFFECT/1 authentication and negotiation. */
	effectProducer?: () => ManagedEffectProducer | null;
	/**
	 * WORKFLOW-CONTEXT/1 local seam, not a wire capability. The trusted host
	 * returns actual v2 negotiation only for this prepared producer and current
	 * authenticated identity/socket binding, or null. The producer must resolve
	 * principal chains/grantRef and owner fences through authenticated custody,
	 * reauthorize each admission and revoke its leases when that custody changes.
	 * Published v2 references alone cannot provide that mapping. No production
	 * implementation is installed until the extension is agreed and negotiated.
	 */
	workflowNegotiation?(binding: {
		preparedExecution: PreparedExecutionPort;
		identity: ManagedIdentityRecord;
		connection: number;
	}): { outcome: 'negotiated'; protocol: 2; capabilities: readonly string[] } | null;
	/** This process's standing, as the enrollment lifecycle sees it. */
	status(): ManagedEnrollmentStatus;
	now?: () => number;
	/** @deprecated Prepared producers own lease IDs and expiry. */
	newId?: () => string;
	/** @deprecated Configure expiry on the prepared producer. */
	leaseTtlMs?: number;
	/** How long the last attachment answer counts as fresh. Default `POLICY_FRESHNESS_MS`. */
	freshnessMs?: number;
}

export interface ManagedHostAdapter {
	readonly installation: ManagedInstallationIdentity;
	readonly identity: ManagedIdentityPort;
	readonly authority: HostAuthority;
	readonly effects: ManagedEffectAuthority;
	/**
	 * The workflow owner producer over this adapter's endpoint socket (the
	 * endpoint's `workflow` operation, MRC-07-06A), for a host's
	 * `createWorkflowOwnership` to claim through; null while no socket is
	 * attached. A port, never a fence: the registry decides every claim, and
	 * an endpoint serving no such operation answers so by name (CP-03).
	 */
	readonly workflows: WorkflowOwnerPort | null;
	/**
	 * The endpoint's `telemetry` operation over this adapter's socket
	 * (MRC-10-03): one metadata event per request, answered with the endpoint's
	 * durable receipt or its denial. Null while no socket is open. A port, not
	 * delivery: the telemetry client (`src/main/enterprise/telemetry.ts`) takes
	 * from the event journal, reports here and settles with the answer.
	 */
	readonly telemetry: TelemetryPort | null;
	/**
	 * The endpoint's `noticeList` and `inbox` operations over this adapter's
	 * socket (MRC-11-02): the notices the endpoint retains for the actor this
	 * process is registered as, and the delivered / read / acknowledged / reply
	 * receipts it records. Null while no socket is open. A port, not custody:
	 * the inbox client (`src/main/enterprise/inbox.ts`) holds the receipts.
	 */
	readonly inbox: InboxPort | null;
	policy(): PolicySourceSet;
	status(): ManagedEnrollmentStatus;
	policyStatus(): ManagedPolicyStatus;
	/** Whether a report may be handed to the endpoint right now, and the binding every report carries. */
	telemetryStanding(): TelemetryStanding;
	/** Whether a notice may be listed or an inbox action recorded right now, and the binding each receipt carries. */
	inboxStanding(): InboxStanding;
}

// ---------------------------------------------------------------------------
// Inbox: the endpoint's notice listing and inbox action operations (MRC-11-02)
// ---------------------------------------------------------------------------

/**
 * The endpoint's `notice`: one ordinary user-facing notice the endpoint retains
 * for the actor it resolved from the OS peer. `agentInput: false` is the
 * contract's own word: the body is for the person, and never enters a model's
 * context without a separately approved operator prompt command.
 */
export interface EndpointNotice {
	campaignId: string;
	messageId: string;
	body: string;
	expiresAt: string;
	kind: 'notice';
	agentInput: false;
}

/** The endpoint's `noticeListRequest`: offset 0..7, limit 1..8; each page is freshly authorized. */
export interface EndpointNoticeListRequest {
	offset: number;
	limit: number;
}

export interface EndpointNoticeListResult {
	outcome: 'notices';
	items: readonly EndpointNotice[];
	nextOffset: number | null;
}

export type EndpointInboxAction =
	| { kind: 'delivered' }
	| { kind: 'read' }
	| { kind: 'acknowledged' }
	| { kind: 'reply'; text: string };

/** The endpoint's `inboxRequest`; the scope is the authenticated peer's, never a payload audience. */
export interface EndpointInboxRequest {
	campaignId: string;
	messageId: string;
	idempotencyKey: string;
	action: EndpointInboxAction;
}

export type EndpointInboxState = 'delivered' | 'read' | 'acknowledged' | 'replied';

export interface EndpointInboxReceipt {
	outcome: 'recorded';
	messageId: string;
	receiptId: string;
	state: EndpointInboxState;
}

/** The producer port. A host builds it over its endpoint socket; a test injects a table. */
export interface InboxPort {
	list(request: EndpointNoticeListRequest): Promise<EndpointInvokeOutcome<unknown>>;
	act(request: EndpointInboxRequest): Promise<EndpointInvokeOutcome<unknown>>;
}

/** The port over an attached endpoint socket. `inbox` is effectful (a lost answer is unknown); `noticeList` is not. */
export function endpointInboxPort(endpoint: Pick<EndpointPort, 'invoke'>): InboxPort {
	return {
		list: (request) => endpoint.invoke('noticeList', request),
		act: (request) => endpoint.invoke('inbox', request),
	};
}

/** What every receipt this host records is bound to; read per call, never cached across a standing change. */
export interface InboxBinding {
	tenantId: string;
	/** Null until the endpoint reports it (the runtime socket does not carry it today). */
	enrollmentId: string | null;
	/** The registration THIS process redeemed: its challenge id, and the actor it named when it did. */
	registrationId: string;
	actorId: string | null;
	installation: ManagedInstallationIdentity;
	policyRevision: number | null;
	/** Which of the two operations the endpoint negotiated on this connection. */
	capabilities: { noticeList: boolean; inbox: boolean };
}

export type InboxStanding = { standingKey: string } & (
	| { ok: true; binding: InboxBinding }
	| { ok: false; reason: string }
);

// ---------------------------------------------------------------------------
// Telemetry: the endpoint's metadata event operation (MRC-10-03)
// ---------------------------------------------------------------------------

/**
 * The endpoint's `telemetry` request (its `incomingMetadataEvent`), as this host
 * sends it: the subset a runtime report may carry. The endpoint binds a report to
 * the enrollment (`deviceId`), the installation (`instanceId`) and the reporting
 * process (`bootId`), and refuses a runtime report that names an agent, a
 * session, a run or a trace: those identities stay in the host's own event
 * journal, reachable by `eventId` through `events.resume`. Nothing here carries
 * content, a reference to content, or a secret.
 */
export interface EndpointTelemetryEvent {
	schemaVersion: 1;
	eventId: string;
	deviceId: string;
	instanceId: string;
	bootId: string;
	sequence: number;
	occurredAt: string;
	source: 'runtime';
	family: 'agent.lifecycle' | 'presence' | 'usage' | 'error';
	policyRevision: number;
	collectionProfile: 'metadata';
	completeness: {
		metadata: EndpointCompleteness;
		content: EndpointCompleteness;
		lineage: EndpointCompleteness;
	};
	usageProvenance: 'estimated' | 'unavailable';
	redaction: { state: 'not_applicable' | 'applied' | 'unavailable'; ruleIds: readonly string[] };
	contentReferences: readonly never[];
}

export type EndpointCompleteness =
	| 'complete'
	| 'partial'
	| 'unavailable'
	| 'filtered_by_policy'
	| 'truncated'
	| 'pending_upload'
	| 'verification_failed';

/** The producer port. A host builds it over its endpoint socket; a test injects a table. */
export interface TelemetryPort {
	report(event: EndpointTelemetryEvent): Promise<EndpointInvokeOutcome<unknown>>;
}

/** The port over an attached endpoint socket. The client decides unavailable vs unknown. */
export function endpointTelemetryPort(endpoint: Pick<EndpointPort, 'invoke'>): TelemetryPort {
	return { report: (event) => endpoint.invoke('telemetry', event) };
}

/** What every report this host sends is bound to; read per pass, never cached across a standing change. */
export interface TelemetryBinding {
	/** The enrollment id the endpoint issued: its `deviceId`. */
	deviceId: string;
	installation: ManagedInstallationIdentity;
	/** The applied policy revision collection is authorized under, as the endpoint last reported it. */
	policyRevision: number;
}

/**
 * Whether this host may hand a report to the endpoint right now. `standingKey`
 * names what the answer was made of (connection, registration, attachment,
 * management, revision, negotiated capabilities): a telemetry hold placed
 * under one key is released when the key changes, and not before.
 */
export type TelemetryStanding = { standingKey: string } & (
	| { ok: true; binding: TelemetryBinding }
	| { ok: false; reason: string }
);

// ---------------------------------------------------------------------------
// Policy status: what policy this host is under, and how far to trust it
// ---------------------------------------------------------------------------

/** Five minutes: the endpoint's attachment answer is re-read at least this often, or it is stale. */
export const POLICY_FRESHNESS_MS = 5 * 60_000;

/**
 * The policy standing of this host, projected from the endpoint's last
 * attachment answer and the sealed record. `source` says where the revisions
 * came from (`endpoint`: the live attached answer; `cached`: the record's
 * copy, which is what stays installed offline; `none`). `admission` is not a
 * policy decision: it says whether a fresh decision can be asked for at all,
 * and lists every reason it cannot. A stale observation, a lapsed registration
 * or a lapsed approval each deny, and an offline host keeps its installed
 * revision without gaining any new grant from it.
 */
export interface ManagedPolicyStatus {
	desiredRevision: number | null;
	appliedRevision: number | null;
	/** The record's last applied revision: the policy kept while offline. */
	installedRevision: number | null;
	source: 'endpoint' | 'cached' | 'none';
	freshness: 'fresh' | 'stale' | 'unknown';
	observedAt: string | null;
	connectivity: EndpointStatus['connectivity'] | 'detached';
	management: EndpointStatus['management'] | null;
	capabilities: readonly string[];
	/** Whether desired and applied agree; null when either is unknown. */
	converged: boolean | null;
	offline: {
		installedPolicyAvailable: boolean;
		mode: 'endpoint' | 'installed-policy-only' | 'none';
	};
	approval: { state: 'none' | 'pending' | 'expired'; expiresAt: string | null };
	registration: { state: 'none' | 'live' | 'expired'; expiresAt: string | null };
	admission: { possible: boolean; reasons: readonly string[] };
}

export function projectPolicyStatus(input: {
	standing: ManagedEnrollmentStatus;
	now: number;
	freshnessMs?: number;
}): ManagedPolicyStatus {
	const { standing, now } = input;
	const freshnessMs = input.freshnessMs ?? POLICY_FRESHNESS_MS;
	const record = standing.identity.status === 'ok' ? standing.identity.record : null;
	const live = standing.connection?.attached ? standing.endpoint : null;
	const observedAt = record?.policy.observedAt ?? null;
	const age = observedAt === null ? null : now - Date.parse(observedAt);
	// An observation from the future is a clock the host cannot trust, not a fresh one.
	const freshness: ManagedPolicyStatus['freshness'] =
		age === null || !Number.isFinite(age) || age < 0
			? 'unknown'
			: age <= freshnessMs
				? 'fresh'
				: 'stale';
	const source: ManagedPolicyStatus['source'] = live ? 'endpoint' : record ? 'cached' : 'none';
	const desiredRevision = live?.desiredPolicyRevision ?? record?.policy.desiredRevision ?? null;
	const appliedRevision = live?.appliedPolicyRevision ?? record?.policy.appliedRevision ?? null;
	const installedRevision = record?.policy.appliedRevision ?? null;

	const lapsed = (at: string | null) => at !== null && Date.parse(at) <= now;
	const approval: ManagedPolicyStatus['approval'] = standing.pendingApproval
		? {
				state: lapsed(standing.pendingApproval.expiresAt) ? 'expired' : 'pending',
				expiresAt: standing.pendingApproval.expiresAt,
			}
		: { state: 'none', expiresAt: null };
	const registration: ManagedPolicyStatus['registration'] = record?.registration
		? {
				state: lapsed(record.registration.expiresAt) ? 'expired' : 'live',
				expiresAt: record.registration.expiresAt,
			}
		: { state: 'none', expiresAt: null };

	const reasons: string[] = [];
	if (standing.authority !== 'registered')
		reasons.push(standing.reason ?? 'No registered standing.');
	if (freshness !== 'fresh') reasons.push(`The policy observation is ${freshness}.`);
	if (registration.state === 'expired') reasons.push('The actor registration has lapsed.');
	if (approval.state === 'expired')
		reasons.push('The pending approval has lapsed without a redeem.');
	if (live && live.connectivity !== 'online' && desiredRevision !== appliedRevision) {
		reasons.push(`The endpoint is ${live.connectivity} with a policy update outstanding.`);
	}
	if (appliedRevision === null) reasons.push('No applied policy revision is known.');

	return {
		desiredRevision,
		appliedRevision,
		installedRevision,
		source,
		freshness,
		observedAt,
		connectivity: live?.connectivity ?? 'detached',
		management: live?.management ?? null,
		capabilities: live?.capabilities ?? [],
		converged:
			desiredRevision === null || appliedRevision === null
				? null
				: desiredRevision === appliedRevision,
		offline: {
			installedPolicyAvailable: installedRevision !== null,
			mode: live ? 'endpoint' : installedRevision !== null ? 'installed-policy-only' : 'none',
		},
		approval,
		registration,
		admission: { possible: reasons.length === 0, reasons },
	};
}

/** What a standing is made of (connection, registration, attachment, management, revision, capabilities): a hold placed under one key lifts when the key changes. */
function standingKeyOf(standing: ManagedEnrollmentStatus): string {
	const connection = standing.connection;
	const live = standing.endpoint;
	const record = standing.identity.status === 'ok' ? standing.identity.record : null;
	const revision = live?.appliedPolicyRevision ?? record?.policy.appliedRevision ?? null;
	return [
		connection?.connection ?? 0,
		connection?.registration ?? 'none',
		connection?.attached ? 'attached' : 'detached',
		live?.management ?? 'none',
		revision ?? 'none',
		(live?.capabilities ?? []).join('+'),
	].join(':');
}

const MAX_RESOURCES = 64;
const MAX_RESOURCE_LENGTH = 4096;

/** Why the snapshot cannot be described to the endpoint at all, or null. */
function executionRequestProblem(request: AdmissionRequest): string | null {
	const { snapshot } = request;
	if (snapshot.resourceIds.length > MAX_RESOURCES)
		return `${snapshot.resourceIds.length} resources exceed the bound of ${MAX_RESOURCES}`;
	if (snapshot.resourceIds.some((id) => id.length === 0 || id.length > MAX_RESOURCE_LENGTH)) {
		return `a resource id is empty or exceeds ${MAX_RESOURCE_LENGTH} characters`;
	}
	if (!isEndpointIdentifier(snapshot.provider)) return 'the provider is not an endpoint identifier';
	if (snapshot.model !== null && !isEndpointIdentifier(snapshot.model)) {
		return 'the model is not an endpoint identifier';
	}
	if (request.policy.policyRevision === null) return 'no policy revision is known for this host';
	return null;
}

export function createManagedHostAdapter(deps: ManagedHostAdapterDeps): ManagedHostAdapter {
	const now = deps.now ?? (() => Date.now());
	/** Follows the record: a desktop composed before it enrolls gets its authority id when the record lands. */
	const authorityId = (): string => {
		const view = deps.identity.read();
		return view.status === 'ok' && view.record ? managedAuthorityId(view.record) : 'unavailable';
	};

	// Unknown attempts stay held until the producer reconciles them. This local
	// fence prevents blind retries; durable replay protection belongs to the port.
	const attempts = new Map<string, AdmissionOutcome>();
	const owners = new Map<
		DispatchLease,
		{
			port: PreparedExecutionPort;
			generation: string;
			request: AdmissionRequest;
			input: string;
			workflowKey: string;
			ended: AbortController;
		}
	>();
	let invalidation = 0;
	function workflowNegotiationKey(request: AdmissionRequest, port: PreparedExecutionPort) {
		const { delegation, workflow } = request.context;
		const delegated = delegation.principals.length > 0 || delegation.delegation !== null;
		if (!delegated && workflow === null) return 'direct';
		const identity = deps.identity.read();
		const standing = deps.status();
		if (
			identity.status !== 'ok' ||
			!identity.record ||
			standing.authority !== 'registered' ||
			!standing.connection?.attached
		)
			return null;
		const negotiated = deps.workflowNegotiation?.({
			preparedExecution: port,
			identity: structuredClone(identity.record),
			connection: standing.connection.connection,
		});
		if (
			negotiated?.outcome !== 'negotiated' ||
			negotiated.protocol !== 2 ||
			!Array.isArray(negotiated.capabilities) ||
			negotiated.capabilities.length > 128 ||
			!negotiated.capabilities.every(isEndpointIdentifier) ||
			new Set(negotiated.capabilities).size !== negotiated.capabilities.length
		)
			return null;
		const required = ['execution', 'registration_use'];
		if (delegated) required.push('delegation');
		if (workflow !== null)
			required.push('workflow_claim', 'workflow_renew', 'workflow_settle', 'workflow_release');
		if (!required.every((capability) => negotiated.capabilities.includes(capability))) return null;
		return canonicalJson(negotiated);
	}

	function generation(): string {
		const standing = deps.status();
		const identity = deps.identity.read();
		const record = identity.record;
		return canonicalJson({
			invalidation,
			standing: standingKeyOf(standing),
			authority: standing.authority,
			custody: identity.status,
			installation: deps.installation,
			identity: record && {
				installationId: record.installationId,
				tenantId: record.tenantId,
				orgId: record.orgId,
				enrollmentId: record.enrollmentId,
				management: record.management,
				endpoint: record.endpoint,
				registration: record.registration,
				policy: {
					desiredRevision: record.policy.desiredRevision,
					appliedRevision: record.policy.appliedRevision,
				},
			},
		});
	}

	async function admit(request: AdmissionRequest): Promise<AdmissionOutcome> {
		const unavailable = (message: string): AdmissionOutcome => ({
			state: 'unavailable',
			code: 'runtime-unavailable',
			message,
		});
		const key = canonicalJson([
			request.context.identity.requestId,
			request.context.identity.attemptId,
		]);
		const previous = attempts.get(key);
		if (previous?.state === 'unknown') return previous;
		const identity = deps.identity.read();
		if (identity.status !== 'ok' || !identity.record)
			return unavailable(identity.message ?? 'This host holds no enrollment.');
		const standing = deps.status();
		if (
			standing.authority !== 'registered' ||
			!deps.endpoint ||
			!standing.connection?.attached ||
			identity.record.management !== 'enrolled'
		)
			return unavailable(standing.reason ?? 'No endpoint is attached.');
		const policy = projectPolicyStatus({ standing, now: now(), freshnessMs: deps.freshnessMs });
		if (!policy.admission.possible) return unavailable(policy.admission.reasons.join(' '));
		const problem = executionRequestProblem(request);
		if (problem) return unavailable(`The launch cannot be described to the endpoint: ${problem}.`);
		const port = deps.endpoint.preparedExecution;
		if (!port || port.version !== 1) {
			return unavailable(
				'No negotiated prepared execution authority (PREPARED/1); workflow and delegation authority cannot be dropped, and a broker dispatch receipt is not a local launch permit.'
			);
		}
		const { context, snapshot } = request;
		const { record } = identity;
		const registration = record.registration;
		if (
			!isVerifiedContext(context) ||
			canonicalJson(context.installation) !== canonicalJson(deps.installation) ||
			record.installationId !== deps.installation.installationId ||
			!registration?.actorId ||
			!Number.isFinite(Date.parse(registration.expiresAt)) ||
			Date.parse(registration.expiresAt) <= now() ||
			context.actor.kind !== 'human' ||
			context.actor.id !== registration.actorId ||
			registration.runtimeId !== deps.installation.runtimeId ||
			registration.processEpoch !== deps.installation.processEpoch
		) {
			return {
				state: 'denied',
				code: 'unauthenticated',
				message: 'The prepared actor/installation does not match the current registration.',
				policyRevision: policy.appliedRevision,
			};
		}
		if (snapshot.contractVersion !== MANAGED_CONTRACT_VERSION)
			return {
				state: 'denied',
				code: 'version-unsupported',
				message: 'Unsupported dispatch snapshot version.',
				policyRevision: policy.appliedRevision,
			};
		if (
			context.policyRevision !== policy.appliedRevision ||
			request.policy.policyRevision !== policy.appliedRevision ||
			port.authorityId !== authorityId()
		)
			return unavailable('The prepared authority or policy generation is no longer current.');
		const workflowKey = workflowNegotiationKey(request, port);
		if (workflowKey === null)
			return unavailable(
				'No authenticated v2 workflow/delegation negotiation for this prepared authority; the complete context must be preserved.'
			);
		if (previous)
			return {
				state: 'denied',
				code: 'idempotency-conflict',
				message: 'This prepared attempt was already consumed; do not retry it.',
				policyRevision: policy.appliedRevision,
			};
		const unknown: AdmissionOutcome = {
			state: 'unknown',
			code: 'outcome-unknown',
			message:
				'Prepared admission may have been consumed; reconcile with its authority before retrying.',
		};
		attempts.set(key, unknown);
		const before = generation();
		const input = canonicalJson(request);
		const digest = dispatchSnapshotDigest(snapshot);
		let outcome: AdmissionOutcome;
		try {
			// Preserve every field, including delegation/workflow and exact resolved
			// argv/cwd/env/stdin/resource digests. The producer pins native handles.
			outcome = await port.admit(request, {
				identity: structuredClone(record),
				connection: standing.connection!.connection,
			});
		} catch {
			return unknown; // A thrown/lost response is never safe to retry.
		}
		if (outcome.state === 'admitted') {
			const { lease } = outcome;
			if (
				before !== generation() ||
				input !== canonicalJson(request) ||
				deps.endpoint.preparedExecution !== port ||
				workflowNegotiationKey(request, port) !== workflowKey ||
				!projectPolicyStatus({ standing: deps.status(), now: now(), freshnessMs: deps.freshnessMs })
					.admission.possible ||
				lease.authorityId !== authorityId() ||
				lease.snapshotDigest !== digest ||
				canonicalJson(lease.actor) !== canonicalJson(context.actor) ||
				lease.policyRevision !== policy.appliedRevision ||
				outcome.policyRevision !== policy.appliedRevision ||
				lease.attemptId !== context.identity.attemptId ||
				lease.runId !== context.identity.runId ||
				!port.check(lease, digest).ok
			) {
				port.revoke(
					lease.leaseId,
					'Prepared input or authority changed before admission completed.'
				);
				return unknown;
			}
			const ended = new AbortController();
			const release = lease.release.bind(lease);
			lease.release = (result) => {
				ended.abort();
				release(result);
			};
			lease.onRevoked(() => ended.abort());
			owners.set(lease, { port, generation: before, request, input, workflowKey, ended });
		}
		if (outcome.state === 'unavailable') attempts.delete(key);
		else attempts.set(key, outcome);
		return outcome;
	}

	const authority: HostAuthority = {
		get authorityId() {
			return authorityId();
		},
		admit,
		check(lease, digest) {
			const owner = owners.get(lease);
			if (!owner) return { ok: false, reason: 'forged' };
			if (
				owner.generation !== generation() ||
				owner.input !== canonicalJson(owner.request) ||
				deps.endpoint?.preparedExecution !== owner.port ||
				workflowNegotiationKey(owner.request, owner.port) !== owner.workflowKey ||
				!projectPolicyStatus({ standing: deps.status(), now: now(), freshnessMs: deps.freshnessMs })
					.admission.possible
			) {
				owner.port.revoke(lease.leaseId, 'Prepared authority generation changed.');
				return { ok: false, reason: 'revoked' };
			}
			return owner.port.check(lease, digest);
		},
		revoke(leaseId, reason) {
			for (const [lease, owner] of owners)
				if (lease.leaseId === leaseId) return owner.port.revoke(leaseId, reason);
			return false;
		},
		revokeAll(reason) {
			invalidation++;
			let count = 0;
			for (const [lease, owner] of owners) if (owner.port.revoke(lease.leaseId, reason)) count++;
			return count;
		},
		live: () =>
			[...owners.keys()].filter((lease) => lease.state() === 'issued' || lease.state() === 'bound'),
	};

	return {
		installation: deps.installation,
		identity: deps.identity,
		authority,
		effects: createManagedEffectAuthority({
			authorityId,
			producer: () => deps.effectProducer?.() ?? null,
			now,
			scope(binding) {
				const matches = [...owners].filter(([lease]) => lease.leaseId === binding.leaseId);
				if (matches.length !== 1) return null;
				const [lease, owner] = matches[0];
				const current = () => {
					const registration = deps.identity.read().record?.registration;
					const verdict = authority.check(lease, lease.snapshotDigest);
					return (
						lease.state() === 'bound' &&
						canonicalJson(binding.actor) === canonicalJson(lease.actor) &&
						binding.provider === owner.request.snapshot.provider &&
						!!registration &&
						Date.parse(registration.expiresAt) > now() &&
						// check guards a launch; an owned bound lease has already launched.
						(verdict.ok || verdict.reason === 'already-bound')
					);
				};
				return { lease, generation: owner.generation, signal: owner.ended.signal, current };
			},
		}),
		// Read per access: a desktop composes the adapter before its socket opens.
		get workflows() {
			return deps.endpoint ? endpointWorkflowOwnerPort(deps.endpoint) : null;
		},
		get telemetry() {
			return deps.endpoint ? endpointTelemetryPort(deps.endpoint) : null;
		},
		get inbox() {
			return deps.endpoint ? endpointInboxPort(deps.endpoint) : null;
		},
		inboxStanding() {
			const standing = deps.status();
			const { identity } = standing;
			const record = identity.status === 'ok' ? identity.record : null;
			const live = standing.endpoint;
			const standingKey = standingKeyOf(standing);
			const refuse = (reason: string): InboxStanding => ({ standingKey, ok: false, reason });
			if (!record) return refuse(identity.message ?? 'This host holds no enrollment.');
			if (standing.authority !== 'registered' || !deps.endpoint || !live) {
				return refuse(standing.reason ?? 'No endpoint is attached.');
			}
			// `registered` means THIS process redeemed the registration the record carries.
			const registration = record.registration;
			if (!registration || Date.parse(registration.expiresAt) <= now()) {
				return refuse('This process holds no live actor registration.');
			}
			const capabilities = {
				noticeList: live.capabilities.includes('noticeList'),
				inbox: live.capabilities.includes('inbox'),
			};
			if (!capabilities.noticeList && !capabilities.inbox) {
				return refuse('The endpoint negotiated neither noticeList nor inbox on this connection.');
			}
			return {
				standingKey,
				ok: true,
				binding: {
					tenantId: record.tenantId,
					enrollmentId: record.enrollmentId,
					registrationId: registration.challengeId,
					actorId: registration.actorId,
					installation: deps.installation,
					policyRevision: live.appliedPolicyRevision ?? record.policy.appliedRevision,
					capabilities,
				},
			};
		},
		telemetryStanding() {
			// One standing read: the lifecycle's view already carries the custody read.
			const standing = deps.status();
			const { identity } = standing;
			const record = identity.status === 'ok' ? identity.record : null;
			const live = standing.endpoint;
			const revision = live?.appliedPolicyRevision ?? record?.policy.appliedRevision ?? null;
			const standingKey = standingKeyOf(standing);
			const refuse = (reason: string): TelemetryStanding => ({ standingKey, ok: false, reason });
			if (!record) return refuse(identity.message ?? 'This host holds no enrollment.');
			if (standing.authority !== 'registered' || !deps.endpoint || !live) {
				return refuse(standing.reason ?? 'No endpoint is attached.');
			}
			if (!live.capabilities.includes('telemetry')) {
				return refuse('The endpoint negotiated no telemetry capability on this connection.');
			}
			if (record.enrollmentId === null) {
				return refuse('The record names no enrollment id; the endpoint binds every report to one.');
			}
			if (revision === null) {
				return refuse('No applied policy revision is known; collection is authorized under one.');
			}
			return {
				standingKey,
				ok: true,
				binding: {
					deviceId: record.enrollmentId,
					installation: deps.installation,
					policyRevision: revision,
				},
			};
		},
		policy() {
			const identity = deps.identity.read();
			if (identity.status !== 'ok' || !identity.record)
				return { sources: [], policyRevision: null };
			const live = deps.status().endpoint;
			const revision = live?.appliedPolicyRevision ?? identity.record.policy.appliedRevision;
			return {
				sources: [{ id: authorityId(), kind: 'endpoint', revision }],
				policyRevision: revision,
			};
		},
		status: deps.status,
		policyStatus: () =>
			projectPolicyStatus({ standing: deps.status(), now: now(), freshnessMs: deps.freshnessMs }),
	};
}

// ---------------------------------------------------------------------------
// Probe turns: a provider started for its metadata alone (MRC2-02-04)
// ---------------------------------------------------------------------------
//
// A probe is a `DispatchPurpose` of `probe`: Maestro starts the provider to
// read what it knows (Codex's skill list, a version, a slash-command table),
// sends it no prompt of the person's and stops it when the answer is in. It
// still starts the provider's own executable on one of its routes, so under
// management it is admitted exactly like a turn: the host's authority sees a
// snapshot of the final spec, mints a lease on it, and the sink (`startTurn`)
// checks the lease against the spec that reaches `spawn`. A surface that
// probes outside the process manager (`discoverCodexSkills`) composes its
// admission from these; a standalone host passes none and probes as before.

/**
 * Why a launch of Maestro's own (a probe, a supervisor's child) may not run:
 * the authority's three distinctions, plus a route with no enforcement.
 */
export interface ManagedAdmissionRefusal {
	state: DispatchAdmissionState;
	code: ManagedDenialCode;
	message: string;
}

/** Why a probe may not run. */
export type ProbeTurnRefusal = ManagedAdmissionRefusal;

/**
 * Why a probe may not take a route under management, or null when the route
 * is qualified. A probe starts the provider the way a turn on that route
 * would (`codex app-server` for Codex's skill list), so it is held to the
 * route's managed standing in the support table: a route with no enforcement
 * producer refuses `unavailable`, by name, before any process and before the
 * authority is asked, and is never run unmanaged in its place.
 */
export function probeRouteRefusal(
	providerId: string,
	route: ManagedRoute
): ProbeTurnRefusal | null {
	const support = providerRouteSupport(providerId).find((entry) => entry.route === route);
	if (support?.managed === 'implemented') return null;
	return {
		state: 'unavailable',
		code: 'capability-unsupported',
		message: `A managed probe of ${providerId} over the ${route} route is unavailable on this host: ${support?.note ?? 'the route is not known'}. Nothing was started.`,
	};
}

/**
 * The identity of a launch that is its own request (a probe, a supervisor's
 * child): one request, one attempt, no run above it.
 */
export function ownRunIdentity(newId: () => string = generateUUID): ManagedRunIdentity {
	const requestId = newId();
	return {
		requestId,
		idempotencyKey: requestId,
		attemptId: newId(),
		runId: null,
		rootRunId: null,
		parentRunId: null,
	};
}

/** The identity of a probe: its own request, one attempt, no run above it. */
export function probeTurnIdentity(newId: () => string = generateUUID): ManagedRunIdentity {
	return ownRunIdentity(newId);
}

export interface ProbeTurnRequest {
	/** The host's authority: it mints the lease and checks it again at the sink. */
	authority: Pick<HostAuthority, 'admit' | 'check'>;
	policy: PolicySourceSet;
	/** The verified context the host bound the probing actor into. */
	context: ManagedAuthenticatedContext;
	/**
	 * The spec exactly as it will reach `startTurn`. The lease covers the
	 * digest of this snapshot, and `startTurn` rebuilds the snapshot from the
	 * spec it is handed the instant before `spawn`, so a spec changed between
	 * the two fails at the sink rather than running.
	 */
	spec: DispatchSpecLike;
	/** The provider and target; the purpose is always `probe` and the operation `start`. */
	attribution: Omit<DispatchAttribution, 'purpose' | 'operation'>;
}

export type ProbeTurnAdmission =
	| {
			ok: true;
			leaseId: string;
			/** What to hand `startTurn` as `options.admission`. */
			admission: { gate: DispatchAdmission; attribution: DispatchAttribution };
	  }
	| ({ ok: false } & ProbeTurnRefusal);

/**
 * Ask the host's authority for a lease on a probe of the final spec, and
 * turn the lease into the admission `startTurn` takes. The gate is the one
 * every lease-backed sink uses (`leaseAdmission`): the lease is re-checked
 * against the final snapshot, bound to the pid, released with the exit, and
 * a revocation stops the process. A refusal is the authority's own answer,
 * with its state and code; nothing was started.
 */
export async function admitProbeTurn(request: ProbeTurnRequest): Promise<ProbeTurnAdmission> {
	const attribution: DispatchAttribution = {
		...request.attribution,
		operation: 'start',
		purpose: 'probe',
	};
	const outcome = await request.authority.admit({
		context: request.context,
		snapshot: buildDispatchSnapshot(request.spec, attribution),
		policy: request.policy,
	});
	if (outcome.state !== 'admitted') {
		return { ok: false, state: outcome.state, code: outcome.code, message: outcome.message };
	}
	return {
		ok: true,
		leaseId: outcome.lease.leaseId,
		admission: { gate: leaseAdmission(request.authority, outcome.lease), attribution },
	};
}

/**
 * What a remembered probe refusal was decided on. The policy revision is part
 * of the key, so a new revision never answers from an old refusal; `scope`
 * is whatever else the caller's decision depended on (the actor's transport,
 * the directory probed), as one string.
 */
export interface ProbeRefusalKey {
	authorityId: string;
	policyRevision: number | null;
	providerId: string;
	route: ManagedRoute;
	scope: string;
}

export interface ProbeRefusalCache {
	/** The refusal remembered for this key, or null once it expired or was never recorded. */
	recall(key: ProbeRefusalKey): ProbeTurnRefusal | null;
	/** Remember a refusal for this key until the TTL passes; returns the refusal. */
	remember(key: ProbeRefusalKey, refusal: ProbeTurnRefusal): ProbeTurnRefusal;
	clear(): void;
	size(): number;
}

/** How long a probe refusal is remembered: the same bound a policy status is fresh for. */
export const PROBE_REFUSAL_TTL_MS = POLICY_FRESHNESS_MS;

/**
 * Remembers a probe's refusal so a surface that probes on every detection
 * (a provider's skill list on each agent start) does not ask the authority
 * again for the same answer. A refusal is kept for its key until the TTL
 * passes; a changed policy revision or authority is a different key, so a
 * decision made on an old revision is never replayed on a new one, and an
 * `unavailable` from an endpoint that was away is retried once the TTL has
 * run out. Nothing admitted is ever cached: an admission is a lease on one
 * snapshot and is asked for every time.
 */
export function createProbeRefusalCache(
	options: { now?: () => number; ttlMs?: number } = {}
): ProbeRefusalCache {
	const now = options.now ?? (() => Date.now());
	const ttl = options.ttlMs ?? PROBE_REFUSAL_TTL_MS;
	const entries = new Map<string, { refusal: ProbeTurnRefusal; until: number }>();
	const keyOf = (key: ProbeRefusalKey): string => canonicalJson(key);
	const sweep = (at: number): void => {
		for (const [key, entry] of entries) if (entry.until <= at) entries.delete(key);
	};
	return {
		recall(key) {
			const at = now();
			const entry = entries.get(keyOf(key));
			if (!entry) return null;
			if (entry.until <= at) {
				sweep(at);
				return null;
			}
			return entry.refusal;
		},
		remember(key, refusal) {
			const at = now();
			sweep(at);
			entries.set(keyOf(key), { refusal, until: at + ttl });
			return refusal;
		},
		clear() {
			entries.clear();
		},
		size() {
			return entries.size;
		},
	};
}

// ---------------------------------------------------------------------------
// Supervisor children: a background service's own process (MRC2-02-05)
// ---------------------------------------------------------------------------
//
// A supervisor child is a `DispatchPurpose` of `supervisor`: a long-running
// process of Maestro's own that a background service of the host starts and
// keeps alive (a Pianola watcher or orchestration run through the bundled CLI,
// the Computer History accessibility helper), raised by no turn of anyone's.
// Nobody is at a keyboard for it, so the actor it binds is a SERVICE: the
// supervisor names itself on the delegation chain (`supervisorServicePrincipal`)
// and the port binds that chain to the installation it answers for (the
// verified context carries the installation and its principal, the registered
// actor or the operator). Under management the child is admitted exactly like
// a launch: the authority sees the snapshot of the final spawn (executable,
// argv, cwd, environment), mints a lease on it, and the supervisor drives the
// lease around the raw child it spawns itself (`SupervisedChildLifetime`):
// re-check the instant before `spawn`, bind the pid, hear a revocation, release
// with the exit. A refusal is a reported state of the supervisor, never a
// retry: the backoff ladder is for a child that died, and a policy that said no
// is asked again only when the supervisor is told to start again (a reconcile,
// an enable, a restart of the host), never by a timer of its own.

/** The one word before the service: a supervisor's service principal and its provider are both named by it. */
export const SUPERVISOR_SERVICE_PREFIX = 'maestro-supervisor:';

/** The service principal a supervisor acts as; the link it puts on the delegation chain. */
export function supervisorServicePrincipal(service: string): ManagedPrincipalRef {
	return { kind: 'service', id: `${SUPERVISOR_SERVICE_PREFIX}${service}` };
}

/**
 * The provider a supervisor's child is admitted as. A supervisor runs no
 * provider: the executable is Maestro's own, so the snapshot names the
 * service, and a policy that denies `maestro-supervisor:pianola` denies every
 * Pianola child and nothing else.
 */
export function supervisorChildProvider(service: string): string {
	return `${SUPERVISOR_SERVICE_PREFIX}${service}`;
}

/** What a supervisor hands the port to bind: this process, the service on the chain, no workflow. */
export interface SupervisorContextInput {
	actor: { peer: 'in-process' };
	identity: ManagedRunIdentity;
	traceId: string;
	policyRevision: number | null;
	workflow: null;
	delegation: ManagedDelegationRef;
}

/**
 * The slice of a host's spawn authority port a supervisor admits with. The
 * desktop's `ProcessSpawnAuthorityPort` satisfies it as it is; a double with
 * no port, or a port whose standing is `standalone`, admits nothing and the
 * supervisor spawns as before.
 */
export interface SupervisorChildPort {
	standing(): 'standalone' | 'managed';
	readonly authority: Pick<HostAuthority, 'admit' | 'check'>;
	policy(): PolicySourceSet;
	verify(input: SupervisorContextInput): ContextVerification;
}

export interface SupervisorChildRequest {
	port: SupervisorChildPort;
	/** Which service of Maestro's own is spawning: `pianola`, `computer-history`. */
	service: string;
	traceId: string;
	/**
	 * The spawn exactly as the supervisor will make it: the lease covers the
	 * digest of this snapshot and `SupervisedChildLifetime.admit` rebuilds it
	 * the instant before `spawn`, so a spec changed between the two fails at
	 * the sink rather than running.
	 */
	spec: DispatchSpecLike;
	/** What the spec does not say: the resources (a target, an agent) and the target kind. */
	attribution?: Pick<DispatchAttribution, 'resourceIds' | 'target' | 'model' | 'account'>;
	/** Which surface raised the launch; the desktop's own services are `desktop`. */
	origin?: ManagedOrigin;
	newId?: () => string;
}

/** Why a supervisor's child may not run. */
export type SupervisorChildRefusal = ManagedAdmissionRefusal;

/**
 * The lease of an admitted supervisor child, driven around the raw child the
 * supervisor spawns itself (no `startTurn` in between). The steps are the
 * lease gate's own (`leaseAdmission`): nothing here decides anything.
 */
export interface SupervisedChildLifetime {
	readonly leaseId: string;
	/**
	 * Re-check the lease against the snapshot the instant before `spawn`. A
	 * refusal has released the lease; nothing may be started on it.
	 */
	admit(): DispatchAdmissionVerdict;
	/** The process exists: bind its pid; the protected lifetime begins. */
	spawned(child: { pid?: number | undefined }): void;
	/** The process could not be started; the lease is released as such. */
	spawnFailed(error: Error): void;
	/** Hear a revocation while bound, so the supervisor stops the child. Returns the unsubscribe. */
	onRevoked(listener: (reason: string) => void): () => void;
	/** The process is gone: who stopped it, or how it exited. */
	exited(exit: {
		exitCode: number | null;
		signal: string | null;
		stoppedBy?: 'caller' | 'authority';
	}): void;
	/** Nothing was started on the lease (the target went away while the authority answered). */
	withdraw(message: string): void;
}

export type SupervisorChildAdmission =
	| { state: 'standalone' }
	| {
			state: 'admitted';
			lease: DispatchLease;
			snapshot: DispatchSnapshot;
			/** The principal the child runs as: the installation's, as the port bound it. */
			actor: ManagedPrincipalRef;
			/** The service on the delegation chain. */
			service: ManagedPrincipalRef;
			lifetime: SupervisedChildLifetime;
	  }
	| ({ state: 'denied' | 'unavailable' | 'unknown' } & Omit<SupervisorChildRefusal, 'state'>);

/**
 * Admit one supervisor child on the host, or say why not, before anything
 * starts. A standalone standing admits nothing and needs nothing. Under
 * management the port binds this process with the service on the chain
 * (`supervisorServicePrincipal`), and the authority admits the snapshot of
 * exactly the spawn the supervisor will make, stamped `purpose: supervisor`
 * and `operation: start`. A refusal is the authority's own answer, with its
 * state and code; nothing was started.
 */
export async function admitSupervisorChild(
	request: SupervisorChildRequest
): Promise<SupervisorChildAdmission> {
	const { port } = request;
	if (port.standing() !== 'managed') return { state: 'standalone' };
	const policy = port.policy();
	const service = supervisorServicePrincipal(request.service);
	const verified = port.verify({
		actor: { peer: 'in-process' },
		identity: ownRunIdentity(request.newId),
		traceId: request.traceId,
		policyRevision: policy.policyRevision,
		workflow: null,
		delegation: { principals: [service], delegation: null, grants: [] },
	});
	if (!verified.ok) {
		return {
			state: 'denied',
			code: verified.code,
			message: `The ${request.service} supervisor's service actor could not be bound: ${verified.problems.join('; ')}. Nothing was started.`,
		};
	}
	const attribution: DispatchAttribution = {
		...request.attribution,
		provider: supervisorChildProvider(request.service),
		operation: 'start',
		purpose: 'supervisor',
		origin: request.origin ?? 'desktop',
		target: request.attribution?.target ?? { kind: 'local' },
	};
	const snapshot = buildDispatchSnapshot(request.spec, attribution);
	const outcome = await port.authority.admit({ context: verified.context, snapshot, policy });
	if (outcome.state !== 'admitted') {
		return { state: outcome.state, code: outcome.code, message: outcome.message };
	}
	const { lease } = outcome;
	const gate = leaseAdmission(port.authority, lease);
	const lifetime: SupervisedChildLifetime = {
		leaseId: lease.leaseId,
		admit() {
			const verdict = gate.admit(buildDispatchSnapshot(request.spec, attribution));
			if (!verdict.ok) lease.release({ outcome: 'unknown', message: verdict.message });
			return verdict;
		},
		spawned: (child) => lease.bind(child.pid),
		spawnFailed: (error) => lease.release({ outcome: 'spawn-failed', message: error.message }),
		onRevoked: (listener) => lease.onRevoked(listener),
		exited: (exit) =>
			lease.release(
				exit.stoppedBy
					? { outcome: 'stopped', by: exit.stoppedBy }
					: { outcome: 'exited', exitCode: exit.exitCode, signal: exit.signal }
			),
		withdraw: (message) => lease.release({ outcome: 'unknown', message }),
	};
	return {
		state: 'admitted',
		lease,
		snapshot,
		actor: verified.context.actor,
		service,
		lifetime,
	};
}
