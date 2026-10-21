/**
 * The desktop's spawn authority: the `ProcessSpawnAuthorityPort` the process
 * manager admits every spawn with, composed from the enterprise service's
 * parts (phase 06, MRC-06-01).
 *
 * Three answers, nothing else:
 *
 *   - `standing()`: `standalone` while this installation holds no enrollment
 *     record at all, `managed` the moment it holds one, usable or not. An
 *     enrollment whose custody is unprotected or untrusted, or whose endpoint
 *     is away, is still `managed`: its admissions come back `unavailable`
 *     from the adapter, and the sink refuses. It never drops to standalone.
 *   - `verify()`: binds the actor the transport resolved into a verified
 *     context. The PRINCIPAL is the enrollment's registered actor (the one
 *     the endpoint registered this process for); the desktop operator or
 *     the logged-in browser account is attribution on the delegation chain,
 *     because neither a keyboard nor a Web Login cookie is an enterprise
 *     principal. One verifier per peer, both accepting only a context that
 *     names this installation.
 *   - `authority` and `policy()`: the broker dispatch bridge's authority (so
 *     every decision lands in the receipt ledger) and the adapter's policy
 *     sources at their last reported revision.
 */

import {
	createContextVerifier,
	type ContextVerifier,
} from '../../shared/maestro-lib/managed/authority';
import {
	managedActorPrincipal,
	type ManagedHostAdapter,
} from '../../shared/maestro-lib/managed/host-adapter';
import {
	unavailableEffectAuthority,
	type ManagedEffectAuthority,
} from '../../shared/maestro-lib/managed/effects';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedInstallationIdentity,
	type ManagedOperationContext,
	type ManagedPrincipalRef,
} from '../../shared/maestro-lib/managed/types';
import type {
	ProcessSpawnActor,
	ProcessSpawnAuthorityPort,
	ProcessSpawnContextInput,
} from '../process-manager/types';
import type { BrokerDispatch } from './dispatch';
import { publicEnterpriseIdentity, type EnterpriseIdentityStore } from './identity-store';

export interface ProcessSpawnAuthorityDeps {
	installation: ManagedInstallationIdentity;
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	host: Pick<ManagedHostAdapter, 'policy'>;
	dispatch: Pick<BrokerDispatch, 'authority'>;
	/** The per-effect authority, when a producer exists. Default: none, every effect unavailable. */
	effects?: ManagedEffectAuthority;
	now?: () => number;
}

/** The principal a managed spawn runs as: the registered actor, or the installation's operator before one is registered. */
export function spawnPrincipal(
	read: ReturnType<EnterpriseIdentityStore['read']>,
	installation: ManagedInstallationIdentity
): ManagedPrincipalRef {
	return managedActorPrincipal(publicEnterpriseIdentity(read), installation);
}

/** The delegation chain the transport's actor contributes: a web login is attribution, never the principal. */
export function spawnDelegationChain(actor: ProcessSpawnActor): ManagedPrincipalRef[] {
	return actor.peer === 'web-login' ? [{ kind: 'human', id: `web-login:${actor.username}` }] : [];
}

export function createProcessSpawnAuthority(
	deps: ProcessSpawnAuthorityDeps
): ProcessSpawnAuthorityPort {
	const now = deps.now ?? (() => Date.now());
	const accept = (context: ManagedOperationContext): string[] =>
		context.installation.installationId === deps.installation.installationId
			? []
			: [`installation ${context.installation.installationId} is not this one`];
	const verifiers: Record<ProcessSpawnActor['peer'], ContextVerifier> = {
		'in-process': createContextVerifier({
			verifierId: `desktop-ipc:${deps.installation.runtimeId}`,
			peer: 'in-process',
			now,
			accept,
		}),
		'web-login': createContextVerifier({
			verifierId: `desktop-web-login:${deps.installation.runtimeId}`,
			peer: 'web-login',
			now,
			accept,
		}),
	};

	return {
		standing: () => (deps.identity.read().status === 'none' ? 'standalone' : 'managed'),
		get authority() {
			return deps.dispatch.authority;
		},
		policy: () => deps.host.policy(),
		// No per-effect operation exists on the endpoint socket in this build,
		// so a managed turn's commands, file changes, permissions and tool
		// calls are refused as unavailable, never decided here and never
		// granted by the provider's own full-access mode.
		effects:
			deps.effects ??
			unavailableEffectAuthority(
				'The endpoint exposes no per-effect authorization operation in this build (CP-01, CP-03; owner mega-maestro).'
			),
		verify(input: ProcessSpawnContextInput) {
			const context: ManagedOperationContext = {
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: deps.installation,
				origin: 'desktop',
				actor: spawnPrincipal(deps.identity.read(), deps.installation),
				delegation: { chain: spawnDelegationChain(input.actor), grantRef: null },
				identity: input.identity,
				policyRevision: input.policyRevision,
				// As the sink bound it: an Auto Run's workflow with its fence, or null
				// for a chat turn. Never stripped, never invented here.
				workflow: input.workflow,
				traceId: input.traceId,
				requestedCapabilities: ['runs.submit'],
			};
			return verifiers[input.actor.peer].verify(context);
		},
	};
}
