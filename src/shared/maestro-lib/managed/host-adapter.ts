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
 *   - `authority`: the existing lease authority (`createLocalHostAuthority`)
 *     with a policy reader that asks the ENDPOINT. An admission becomes one
 *     `execution` request over the attached socket; `broker_dispatched`
 *     with a matching receipt is `allow` (and the lease carries the broker's
 *     decision id, request digest and broker id, so it joins the broker's
 *     own receipt ledger), the endpoint's policy refusals are `deny`, a
 *     `replay` is a denial too (the broker consumed that request already),
 *     no answer or no standing is `unavailable`, and a lost answer or a
 *     receipt that does not match is `unknown`. Nothing is decided locally.
 *
 * What the request carries is the broker's vocabulary, not Maestro's: the
 * run identity, the source, the operation (`start`, `input`, `resume`), the
 * provider and model, the resource ids and the policy revision. The resolved
 * executable, arguments and environment stay in the local snapshot the lease
 * is bound to; the broker treats any argument on the wire as an unsafe
 * override and refuses it, since the installed provider is its own fact to
 * resolve, not the caller's to assert.
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
 * The endpoint in the sibling checkout advertises no `execution` capability
 * to an unprovisioned broker, so today every decision this adapter asks for
 * comes back `unsupported_capability` and is reported `unavailable` (CP-04,
 * owner mega-maestro). The adapter is the Maestro side of that pair; it does
 * not fill the other side in.
 */

import { canonicalJson } from '../../canonicalJson';
import type { EnrollInput, ManagedBindingState } from './binding';
import {
	createContextVerifier,
	createLocalHostAuthority,
	sha256Hex,
	unavailableAuthority,
	type AdmissionRequest,
	type ContextVerification,
	type HostAuthority,
	type ManagedDecisionReceipt,
	type PolicyDecision,
	type PolicySourceSet,
} from './authority';
import {
	isEndpointDigest,
	isEndpointIdentifier,
	type EndpointPort,
	type EndpointStatus,
	type LocalEndpointDenialReason,
	type ManagedEnrollmentStatus,
	type ManagedIdentityPort,
	type ManagedIdentityRecord,
	type ManagedIdentityView,
} from './endpoint-port';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedDelegationRef,
	type ManagedDenialCode,
	type ManagedInstallationIdentity,
	type ManagedOrigin,
	type ManagedPrincipalRef,
	type ManagedRunIdentity,
	type ManagedWorkflowRef,
} from './types';

// ---------------------------------------------------------------------------
// The spawn authority of a host with no Electron (maestro-cli, a headless
// host, a Cue engine), composed from the managed BINDING and, when this
// process is an attached host, the adapter above.
// ---------------------------------------------------------------------------

export interface HeadlessSpawnAuthorityDeps {
	installation: ManagedInstallationIdentity;
	/** The binding this process read beside the data-dir lock (`createManagedBinding().state()` or the files). */
	binding: ManagedBindingState;
	/**
	 * The attached adapter when this process is itself a managed host
	 * (`maestro-cli host`); absent for a bare CLI invocation, which then holds
	 * no authority at all and refuses every managed launch as unavailable.
	 */
	host?: Pick<ManagedHostAdapter, 'authority' | 'policy'> | null;
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
}

export function createHeadlessSpawnAuthority(
	deps: HeadlessSpawnAuthorityDeps
): HeadlessSpawnAuthority {
	const now = deps.now ?? (() => Date.now());
	const { binding } = deps;
	let authority: HostAuthority;
	let policy: () => PolicySourceSet;
	let unavailableReason: string | null = null;
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
		context: (input) =>
			verifier.verify({
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: deps.installation,
				origin: deps.origin,
				actor: deps.actor,
				delegation: input.delegation ?? { chain: [], grantRef: null },
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
	/** This process's standing, as the enrollment lifecycle sees it. */
	status(): ManagedEnrollmentStatus;
	now?: () => number;
	newId?: () => string;
	leaseTtlMs?: number;
	/** How long the last attachment answer counts as fresh. Default `POLICY_FRESHNESS_MS`. */
	freshnessMs?: number;
}

export interface ManagedHostAdapter {
	readonly installation: ManagedInstallationIdentity;
	readonly identity: ManagedIdentityPort;
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	status(): ManagedEnrollmentStatus;
	policyStatus(): ManagedPolicyStatus;
}

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

const EXECUTION_SOURCES: Record<ManagedOrigin, 'ux' | 'cli' | 'cue' | 'headless'> = {
	desktop: 'ux',
	cli: 'cli',
	cue: 'cue',
	headless: 'headless',
	enterprise: 'headless',
	embedded: 'headless',
};

/**
 * The endpoint's refusals that are a decision about this request, as opposed
 * to no decision at all, and the denial code each one maps to. A `replay` is
 * the broker saying it already consumed this request and attempt: a denial
 * the caller must not retry, not an outage.
 */
const DECIDED_DENIALS: Readonly<Partial<Record<LocalEndpointDenialReason, ManagedDenialCode>>> = {
	policy_denied: 'policy-denied',
	budget_exhausted: 'policy-denied',
	unknown_price: 'policy-denied',
	untrusted_clock: 'policy-denied',
	expired: 'policy-denied',
	owner_unfenced: 'policy-denied',
	replay: 'idempotency-conflict',
};

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

/** The broker's receipt for a dispatched request, read structurally; null when it is not one. */
function readDispatchReceipt(payload: unknown): ManagedDecisionReceipt | null {
	const receipt = payload as Partial<{
		outcome: string;
		decisionId: string;
		requestDigest: string;
		brokerId: string;
		policyRevision: number;
	}> | null;
	if (
		receipt?.outcome !== 'broker_dispatched' ||
		!isEndpointIdentifier(receipt.decisionId) ||
		!isEndpointDigest(receipt.requestDigest) ||
		!isEndpointIdentifier(receipt.brokerId) ||
		typeof receipt.policyRevision !== 'number'
	) {
		return null;
	}
	return {
		decisionId: receipt.decisionId,
		requestDigest: receipt.requestDigest,
		brokerId: receipt.brokerId,
		policyRevision: receipt.policyRevision,
	};
}

export function createManagedHostAdapter(deps: ManagedHostAdapterDeps): ManagedHostAdapter {
	const now = deps.now ?? (() => Date.now());
	/** Follows the record: a desktop composed before it enrolls gets its authority id when the record lands. */
	const authorityId = (): string => {
		const view = deps.identity.read();
		return view.status === 'ok' && view.record ? managedAuthorityId(view.record) : 'unavailable';
	};

	async function decide(request: AdmissionRequest): Promise<PolicyDecision> {
		const identity = deps.identity.read();
		if (identity.status !== 'ok' || !identity.record) {
			return {
				decision: 'unavailable',
				reason: identity.message ?? 'This host holds no enrollment.',
			};
		}
		const standing = deps.status();
		if (standing.authority !== 'registered' || !deps.endpoint) {
			return { decision: 'unavailable', reason: standing.reason ?? 'No endpoint is attached.' };
		}
		// A stale observation, a lapsed registration or a lapsed approval is not
		// a standing to ask under: the installed policy stays, no new grant comes.
		const policy = projectPolicyStatus({ standing, now: now(), freshnessMs: deps.freshnessMs });
		if (!policy.admission.possible) {
			return { decision: 'unavailable', reason: policy.admission.reasons.join(' ') };
		}
		const problem = executionRequestProblem(request);
		if (problem)
			return {
				decision: 'unavailable',
				reason: `The launch cannot be described to the endpoint: ${problem}.`,
			};
		const { context, snapshot } = request;
		const policyRevision = request.policy.policyRevision as number;
		// The endpoint's execution operation names a run, never a workflow owner:
		// a launch that belongs to a workflow cannot be described to it with the
		// workflow attached, and is not described with the workflow stripped off
		// (the sibling bridge refuses a nonempty workflow context, CP-03). Until a
		// producer binds workflow authority, the honest answer is no decision.
		if (context.workflow) {
			return {
				decision: 'unavailable',
				reason: `The endpoint carries no workflow authority, so workflow "${context.workflow.workflowId}" cannot be bound to this launch and is not dropped from it (CP-03).`,
			};
		}
		// Nor does it name a delegation: a launch whose context carries a chain
		// of principals (a dispatched turn, a Web Login's attribution) or a grant
		// reference is not described with them stripped off either (the sibling
		// bridge refuses a nonempty delegation, CP-03).
		const { chain, grantRef } = context.delegation;
		if (chain.length > 0 || grantRef !== null) {
			const carried = [
				...(chain.length > 0 ? [`a delegation chain of ${chain.length}`] : []),
				...(grantRef !== null ? ['a grant reference'] : []),
			].join(' and ');
			return {
				decision: 'unavailable',
				reason: `The endpoint carries no delegation authority, so ${carried} cannot be bound to this launch and is not dropped from it (CP-03).`,
			};
		}
		// The broker's request: identity, operation, provider, model, resources and
		// the revision. No arguments: the resolved command line is bound in the
		// local lease, and the broker refuses any argument as an unsafe override.
		const execution = {
			requestId: context.identity.requestId,
			attemptId: context.identity.attemptId,
			runId: context.identity.runId ?? context.identity.attemptId,
			source: EXECUTION_SOURCES[context.origin],
			operation: snapshot.operation,
			arguments: [] as string[],
			resources: [...snapshot.resourceIds],
			provider: snapshot.provider,
			model: snapshot.model ?? 'unspecified',
			...(context.identity.parentRunId ? { parentRunId: context.identity.parentRunId } : {}),
			policyRevision,
		};
		const outcome = await deps.endpoint.invoke('execution', execution);
		switch (outcome.status) {
			case 'denied': {
				const code = DECIDED_DENIALS[outcome.reason];
				if (code) {
					return {
						decision: 'deny',
						reason: `The endpoint refused the launch: ${outcome.reason}.`,
						policyRevision,
						code,
					};
				}
				return {
					decision: 'unavailable',
					reason: `The endpoint did not decide: ${outcome.reason}.`,
				};
			}
			case 'unavailable':
				return { decision: 'unavailable', reason: outcome.message };
			case 'unknown':
				return { decision: 'unknown', reason: outcome.message };
			case 'ok':
				break;
		}
		const answered = outcome.payload as Partial<{
			requestId: string;
			attemptId: string;
			runId: string;
		}> | null;
		const receipt = readDispatchReceipt(outcome.payload);
		if (
			!receipt ||
			answered?.requestId !== execution.requestId ||
			answered.attemptId !== execution.attemptId ||
			answered.runId !== execution.runId ||
			receipt.policyRevision !== policyRevision
		) {
			return {
				decision: 'unknown',
				reason:
					'The endpoint answered with a receipt that does not match the request; the decision is not known.',
			};
		}
		return { decision: 'allow', policyRevision, receipt };
	}

	// The lease authority reads the id at every mint, so a lease names the
	// authority of the record that was current when it was admitted.
	const leases = createLocalHostAuthority({
		get authorityId() {
			return authorityId();
		},
		decide,
		now,
		newId: deps.newId ?? (() => `lease-${sha256Hex(`${now()}-${Math.random()}`).slice(0, 16)}`),
		...(deps.leaseTtlMs !== undefined ? { leaseTtlMs: deps.leaseTtlMs } : {}),
	});

	const authority: HostAuthority = {
		get authorityId() {
			return authorityId();
		},
		admit: (request) => leases.admit(request),
		check: (lease, digest) => leases.check(lease, digest),
		revoke: (leaseId, reason) => leases.revoke(leaseId, reason),
		revokeAll: (reason) => leases.revokeAll(reason),
		live: () => leases.live(),
	};

	return {
		installation: deps.installation,
		identity: deps.identity,
		authority,
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
