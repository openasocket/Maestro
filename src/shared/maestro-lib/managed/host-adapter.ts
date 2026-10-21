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
}

export interface ManagedHostAdapter {
	readonly installation: ManagedInstallationIdentity;
	readonly identity: ManagedIdentityPort;
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	status(): ManagedEnrollmentStatus;
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
	const first = deps.identity.read();
	const authorityId = first.record ? managedAuthorityId(first.record) : 'unavailable';

	async function decide(request: AdmissionRequest): Promise<PolicyDecision> {
		const identity = deps.identity.read();
		if (identity.status !== 'ok' || !identity.record) {
			return {
				decision: 'unavailable',
				reason: identity.message ?? 'This host holds no enrollment.',
			};
		}
		if (managedAuthorityId(identity.record) !== authorityId) {
			return {
				decision: 'unavailable',
				reason: 'The enrollment record changed under this authority.',
			};
		}
		const standing = deps.status();
		if (standing.authority !== 'registered' || !deps.endpoint) {
			return { decision: 'unavailable', reason: standing.reason ?? 'No endpoint is attached.' };
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

	const authority = createLocalHostAuthority({
		authorityId,
		decide,
		now,
		newId: deps.newId ?? (() => `lease-${sha256Hex(`${now()}-${Math.random()}`).slice(0, 16)}`),
		...(deps.leaseTtlMs !== undefined ? { leaseTtlMs: deps.leaseTtlMs } : {}),
	});

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
				sources: [{ id: authorityId, kind: 'endpoint', revision }],
				policyRevision: revision,
			};
		},
		status: deps.status,
	};
}
