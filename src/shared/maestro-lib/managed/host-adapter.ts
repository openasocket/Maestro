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
 *     with a matching receipt is `allow`, the endpoint's policy refusals are
 *     `deny`, no answer or no standing is `unavailable`, and a lost answer or
 *     a receipt that does not match is `unknown`. Nothing is decided locally.
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
import type { EnrollInput } from './binding';
import {
	createLocalHostAuthority,
	sha256Hex,
	type AdmissionRequest,
	type HostAuthority,
	type PolicyDecision,
	type PolicySourceSet,
} from './authority';
import type {
	EndpointPort,
	EndpointStatus,
	LocalEndpointDenialReason,
	ManagedEnrollmentStatus,
	ManagedIdentityPort,
	ManagedIdentityRecord,
} from './endpoint-port';
import type { ManagedInstallationIdentity, ManagedOrigin } from './types';

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

/** The endpoint's refusals that are a decision about this request, as opposed to no decision at all. */
const DECIDED_DENIALS: readonly LocalEndpointDenialReason[] = [
	'policy_denied',
	'budget_exhausted',
	'unknown_price',
	'untrusted_clock',
	'expired',
	'owner_unfenced',
];

const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_RESOURCES = 64;

/** Why the snapshot cannot be described to the endpoint at all, or null. */
function executionRequestProblem(request: AdmissionRequest): string | null {
	const { snapshot } = request;
	if (snapshot.args.length > MAX_ARGUMENTS)
		return `${snapshot.args.length} arguments exceed the bound of ${MAX_ARGUMENTS}`;
	if (snapshot.args.some((arg) => arg.length > MAX_ARGUMENT_LENGTH)) {
		return `an argument exceeds ${MAX_ARGUMENT_LENGTH} characters`;
	}
	if (snapshot.resourceIds.length > MAX_RESOURCES)
		return `${snapshot.resourceIds.length} resources exceed the bound of ${MAX_RESOURCES}`;
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
		const execution = {
			requestId: context.identity.requestId,
			attemptId: context.identity.attemptId,
			runId: context.identity.runId ?? context.identity.attemptId,
			source: EXECUTION_SOURCES[context.origin],
			operation: 'launch',
			arguments: [...snapshot.args],
			resources: [...snapshot.resourceIds],
			provider: snapshot.provider,
			model: snapshot.model ?? 'unspecified',
			...(context.identity.parentRunId ? { parentRunId: context.identity.parentRunId } : {}),
			policyRevision,
		};
		const outcome = await deps.endpoint.invoke('execution', execution);
		switch (outcome.status) {
			case 'denied':
				if (DECIDED_DENIALS.includes(outcome.reason)) {
					return {
						decision: 'deny',
						reason: `The endpoint refused the launch: ${outcome.reason}.`,
						policyRevision,
					};
				}
				return {
					decision: 'unavailable',
					reason: `The endpoint did not decide: ${outcome.reason}.`,
				};
			case 'unavailable':
				return { decision: 'unavailable', reason: outcome.message };
			case 'unknown':
				return { decision: 'unknown', reason: outcome.message };
			case 'ok':
				break;
		}
		const receipt = outcome.payload as Partial<{
			outcome: string;
			requestId: string;
			attemptId: string;
			runId: string;
			policyRevision: number;
		}> | null;
		if (
			receipt?.outcome !== 'broker_dispatched' ||
			receipt.requestId !== execution.requestId ||
			receipt.attemptId !== execution.attemptId ||
			receipt.runId !== execution.runId ||
			receipt.policyRevision !== policyRevision
		) {
			return {
				decision: 'unknown',
				reason:
					'The endpoint answered with a receipt that does not match the request; the decision is not known.',
			};
		}
		return { decision: 'allow', policyRevision };
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
