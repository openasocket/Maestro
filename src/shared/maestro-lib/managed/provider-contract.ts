/**
 * Local conformance ports for provider adapters and the Electron/native host.
 * Declarations and structural checks grant no authority or provider availability.
 * Compose the existing lease/effect gates at the actual sink. PREPARED/1 and
 * EFFECT/1 in contract-coverage.json track the missing public wire mappings;
 * these interfaces add no endpoint operation or negotiated capability.
 */
import { serializedJsonByteLength } from '../../jsonUtils';
import type { ProcessSnapshotEntry } from '../control/process-tree';
import type { StopStage } from '../control/termination';
import type { ManagedRoute } from '../providers/capabilities';
import type { DispatchLease, DispatchSnapshot, HostAuthority, LeaseRelease } from './authority';
import type { ManagedEffect, ManagedEffectBinding, ManagedEffectDecision } from './effects';
import {
	LOCAL_ENDPOINT_MAX_REQUEST_BYTES,
	LOCAL_ENDPOINT_MAX_RESPONSE_BYTES,
	LOCAL_ENDPOINT_TIMEOUT_MS,
	type EndpointInvokeOutcome,
	type EndpointPort,
	type LocalEndpointOperation,
} from './endpoint-port';
import type { ManagedAuthenticatedContext, ManagedDispatchTarget } from './types';

export const PROVIDER_HOST_CONTRACT_VERSION = 1 as const;

/** Public execution schema 1 vocabulary; this mapping is not a support claim. */
export type ProviderRouteTransport = 'cli-process' | 'persistent-sdk' | 'pty' | 'ssh';

export function providerTransportForRoute(route: ManagedRoute): ProviderRouteTransport {
	switch (route) {
		case 'child-process':
			return 'cli-process';
		case 'codex-app-server':
		case 'opencode-server':
			return 'persistent-sdk';
		case 'pty':
		case 'ssh':
			return route;
		default:
			throw new Error('Unknown managed provider route.');
	}
}

/** Local call ceilings, reusing endpoint limits and executionBinding.resources. */
export const PROVIDER_CONFORMANCE_LIMITS = Object.freeze({
	timeoutMs: LOCAL_ENDPOINT_TIMEOUT_MS,
	requestBytes: LOCAL_ENDPOINT_MAX_REQUEST_BYTES,
	responseBytes: LOCAL_ENDPOINT_MAX_RESPONSE_BYTES,
	resources: 64,
	resourceTextLength: 4096,
});

/**
 * Every await must honor both cancellation and the deadline from call entry.
 * Bounds include the encoded envelope, not just a prompt or tool's input.
 * Refuse oversized requests before sending; cap responses while streaming.
 * Invalid bounds are refused, never clamped into a different request.
 */
export interface ProviderCallContext {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly requestBytes: number;
	readonly responseBytes: number;
}

/**
 * Structural preflight only. A transport must still enforce the deadline,
 * stream ceiling and signal, including after awaits and immediately at the sink.
 * Messages contain no payload, resource path, credential or provider output.
 */
export function providerCallProblems(call: ProviderCallContext, envelope: unknown): string[] {
	const problems: string[] = [];
	for (const key of ['timeoutMs', 'requestBytes', 'responseBytes'] as const) {
		if (
			!Number.isSafeInteger(call[key]) ||
			call[key] < 1 ||
			call[key] > PROVIDER_CONFORMANCE_LIMITS[key]
		) {
			problems.push(`${key} is outside the conformance bounds`);
		}
	}
	if (call.signal.aborted) problems.push('call is cancelled');
	const bytes = serializedJsonByteLength(envelope);
	if (bytes === null) problems.push('request is not JSON serializable');
	else if (bytes > call.requestBytes) problems.push('request exceeds its byte bound');
	return problems;
}

/**
 * Public executionBinding.resources member, resolved by the trusted backend.
 * Paths alone are insufficient: hold the identity/handle through execution and
 * descendants, reject symlink replacement and recheck before use. No wildcards
 * or implicit parent-directory grants. Nothing here authorizes a filesystem call.
 */
export interface ProviderPermittedResource {
	readonly path: string;
	readonly identity: string;
	readonly access: 'read' | 'write' | 'execute';
}

/** Shape/bounds only; native identity resolution and authorization stay at the sink. */
export function providerResourceProblems(resources: unknown): string[] {
	if (!Array.isArray(resources) || resources.length > PROVIDER_CONFORMANCE_LIMITS.resources) {
		return ['resources is not a bounded list'];
	}
	const problems: string[] = [];
	for (const [index, resource] of resources.entries()) {
		const at = `resources[${index}]`;
		if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) {
			problems.push(`${at} is not a resource`);
			continue;
		}
		if (Object.keys(resource).some((key) => !['path', 'identity', 'access'].includes(key))) {
			problems.push(`${at} has unknown fields`);
		}
		for (const key of ['path', 'identity'] as const) {
			const value = resource[key];
			if (
				typeof value !== 'string' ||
				value.length < 1 ||
				value.length > PROVIDER_CONFORMANCE_LIMITS.resourceTextLength ||
				value.includes('\0')
			) {
				problems.push(`${at}.${key} is not bounded text`);
			}
		}
		if (!['read', 'write', 'execute'].includes(resource.access)) {
			problems.push(`${at}.access is unknown`);
		}
	}
	return problems;
}

/**
 * Reuse process-tree's pid + opaque birth identity, scoped to the actual host.
 * Native Windows producers supply creation identity; SSH uses the remote's
 * identity, never that of the local ssh client. A pid or claimed epoch alone
 * cannot authenticate a peer or identify a process safe to signal.
 */
export interface ProviderProcessIdentity extends Readonly<ProcessSnapshotEntry> {
	readonly target: ManagedDispatchTarget;
}

/** Verifier output, never renderer/provider assertions or a bearer credential. */
export interface ProviderConnectedPeer {
	readonly process: ProviderProcessIdentity;
	readonly connection: ReturnType<EndpointPort['state']>['connection'];
	readonly context: ManagedAuthenticatedContext;
}

export interface ProviderPeerPort {
	/** Authenticate the connected OS peer and resolve its current registered actor. */
	authenticate(call: ProviderCallContext): Promise<EndpointInvokeOutcome<ProviderConnectedPeer>>;
	/** Recheck birth, connection generation, registration and revocation at each sink. */
	isCurrent(peer: ProviderConnectedPeer): boolean;
}

/**
 * Bounded invocation over an authenticated connection. Existing EndpointPort
 * owns attachment/registration; this port adds call bounds and peer observation.
 * An aborted/failed call is unavailable only if unsent or read-only. Once an
 * effectful request may have left, a lost reply is unknown: journal and reconcile,
 * never replay, redial-and-retry, or fall back to standalone/another route.
 */
export interface ProviderTransportPort {
	readonly peer: ProviderPeerPort;
	state: EndpointPort['state'];
	invoke(
		operation: LocalEndpointOperation,
		payload: unknown,
		call: ProviderCallContext
	): Promise<EndpointInvokeOutcome<unknown>>;
	close: EndpointPort['close'];
}

/**
 * The existing exact effect/binding/decision vocabulary with explicit bounds.
 * Keep pending effects suspended. Only allow grants, and only while the lease,
 * peer and binding remain current after the await. Abort/revocation refuses the
 * provider immediately. A lost decision stays unknown, not allow or retry.
 * Adapt to ManagedEffectAuthority.decide at the existing provider approval sink.
 */
export interface ProviderEffectPort {
	readonly authorityId: string;
	decide(
		effect: ManagedEffect,
		binding: ManagedEffectBinding,
		call: ProviderCallContext
	): Promise<ManagedEffectDecision>;
}

/**
 * One admitted turn, even when a persistent SDK daemon serves several turns.
 * Check/bind/release through leaseAdmission; this record cannot mint a lease.
 */
export interface ProviderExecutionScope {
	readonly route: ManagedRoute;
	readonly snapshot: DispatchSnapshot;
	readonly lease: DispatchLease;
	readonly resources: readonly ProviderPermittedResource[];
}

export interface ProviderProcessLifetime {
	readonly scope: ProviderExecutionScope;
	readonly process: ProviderProcessIdentity;
	/** Current owned descendants with birth identity, retained beyond parent exit. */
	descendants(): readonly ProviderProcessIdentity[];
	readonly finished: Promise<LeaseRelease>;
	/**
	 * SDK: cancel the bound thread/turn, fence pending effects and observe completion;
	 * never kill a shared daemon's other turns. PTY/CLI: use stopProcess's stages
	 * and observe owned descendants gone, not just a delivered signal. SSH: obtain
	 * remote process/descendant confirmation; local ssh exit is not remote success.
	 * Resolve stopped only after that observation; loss/timeout is unknown and
	 * retains custody for reconciliation. Repeated cancellation is idempotent.
	 */
	cancel(stage: StopStage, call: ProviderCallContext): Promise<LeaseRelease>;
	/** Observe the original operation; never start it again to discover its outcome. */
	reconcile(call: ProviderCallContext): Promise<LeaseRelease | { outcome: 'running' }>;
}

/** All ports are trusted host dependencies. Their presence is not qualification. */
export interface ProviderHostConformancePort {
	readonly version: typeof PROVIDER_HOST_CONTRACT_VERSION;
	readonly authority: HostAuthority;
	readonly transport: ProviderTransportPort;
	readonly effects: ProviderEffectPort;
}
