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
 *     the endpoint registered this process for); the desktop operator, the
 *     logged-in browser account, the CLI secret or the paired Lite device is
 *     attribution on the delegation chain, because neither a keyboard, a Web
 *     Login cookie, a per-boot secret nor a pairing credential is an
 *     enterprise principal. One verifier per peer, each accepting only a
 *     context that names this installation. A paired Lite device is bound
 *     only once an actor IS registered (`pairedDeviceActorProblems`,
 *     MRC-08-03): before that the principal would be the installation's
 *     operator, and a device is not the operator.
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
import type { CueSpawnAuthorityPort } from '../cue/cue-run-router';
import type { HeadlessSpawnContextInput } from '../../shared/maestro-lib/managed/host-adapter';
import type { BrokerDispatch } from './dispatch';
import {
	identityStandingOf,
	publicEnterpriseIdentity,
	type EnterpriseIdentityStore,
} from './identity-store';

export interface ProcessSpawnAuthorityDeps {
	installation: ManagedInstallationIdentity;
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	host: Pick<ManagedHostAdapter, 'policy'>;
	dispatch: Pick<BrokerDispatch, 'authority'>;
	/** The per-effect authority, when a producer exists. Default: none, every effect unavailable. */
	effects?: ManagedEffectAuthority;
	/**
	 * The workflow owner claim the port hands the process sink as its
	 * `workflowFence` (MRC-07-06B): the service's `claimWorkflowFence`, which
	 * goes through the held ownership and the endpoint's workflow owner
	 * operation. Default: none, and an Auto Run that arrives unowned is
	 * refused at the sink by name.
	 */
	workflowFence?: NonNullable<ProcessSpawnAuthorityPort['workflowFence']>;
	now?: () => number;
}

/** The principal a managed spawn runs as: the registered actor, or the installation's operator before one is registered. */
export function spawnPrincipal(
	read: ReturnType<EnterpriseIdentityStore['read']>,
	installation: ManagedInstallationIdentity
): ManagedPrincipalRef {
	return managedActorPrincipal(publicEnterpriseIdentity(read), installation);
}

/**
 * The delegation chain the transport's actor contributes: attribution, never
 * the principal (MRC-08-01A). A web login is the human account the cookie
 * named; the CLI secret is the `maestro-cli` service; a paired Lite device is
 * the device, by the id the pairing issued; the keyboard (and the bare path
 * token, which admits the same owner-operator) contributes nothing, since the
 * principal already names the installation's operator.
 */
export function spawnDelegationChain(actor: ProcessSpawnActor): ManagedPrincipalRef[] {
	switch (actor.peer) {
		case 'web-login':
			return [{ kind: 'human', id: `web-login:${actor.username}` }];
		case 'host-secret':
			return [{ kind: 'service', id: 'maestro-cli' }];
		case 'device-pairing':
			return [{ kind: 'service', id: `lite-device:${actor.deviceId}` }];
		case 'in-process':
			return [];
	}
}

/**
 * Why a paired Lite device cannot be bound yet, if it cannot (MRC-08-03).
 *
 * Before the enrollment registers an actor, the principal a managed spawn
 * runs as is `operator:<installationId>`. For the keyboard that is the
 * truth: the operator is at it. The bare path token admits the same
 * owner-operator, a Web Login account is an equal operator of this desktop
 * and the CLI secret is a process on this machine. A paired Lite device is
 * none of those. Its credential admits a transport and names a DEVICE, and
 * binding that device to the installation's operator would let the pairing
 * stand in for the enterprise actor the enrollment has not registered, which
 * is the one thing a pairing secret must never become. So a device-admitted
 * spawn is refused `unauthenticated`, by name, until an actor is registered,
 * rather than admitted as the operator and left for the adapter to answer
 * `unavailable`. Once one is, the device rides the delegation chain as
 * attribution like every other transport, and the registry's immediate
 * revoke still closes its socket before the next dispatch.
 */
export function pairedDeviceActorProblems(
	actor: ProcessSpawnActor,
	read: ReturnType<EnterpriseIdentityStore['read']>
): string[] {
	if (actor.peer !== 'device-pairing') return [];
	const registered = read.status === 'ok' ? (read.record.registration?.actorId ?? null) : null;
	if (registered) return [];
	return [
		`a paired Lite device (${actor.deviceId}) admits its transport only; a managed action over it needs the enrollment's registered enterprise actor, and none is registered`,
	];
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
		'host-secret': createContextVerifier({
			verifierId: `desktop-cli-secret:${deps.installation.runtimeId}`,
			peer: 'host-secret',
			now,
			accept,
		}),
		'device-pairing': createContextVerifier({
			verifierId: `desktop-device-pairing:${deps.installation.runtimeId}`,
			peer: 'device-pairing',
			now,
			accept,
		}),
	};

	return {
		standing: () => identityStandingOf(deps.identity.read()),
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
		// The sink claims an unowned Auto Run's fence through this, for the
		// attempt it is admitting; handed through as it is, never wrapped in a
		// fallback that answers a fence the registry did not issue.
		...(deps.workflowFence ? { workflowFence: deps.workflowFence } : {}),
		verify(input: ProcessSpawnContextInput) {
			const read = deps.identity.read();
			// A device is refused before the principal is derived: the operator
			// fallback is never computed for it, so it cannot leak into a context.
			const unbindable = pairedDeviceActorProblems(input.actor, read);
			if (unbindable.length > 0)
				return { ok: false, code: 'unauthenticated', problems: unbindable };
			const context: ManagedOperationContext = {
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: deps.installation,
				origin: 'desktop',
				actor: spawnPrincipal(read, deps.installation),
				// A dispatched turn arrives with its initiator's chain already ending
				// in this target; it is bound as it is. Only a spawn that is its own
				// request takes the transport's attribution.
				delegation: input.delegation ?? {
					chain: spawnDelegationChain(input.actor),
					grantRef: null,
				},
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

/** What the desktop's Cue port is composed from: the same parts as the process manager's, minus the effects nothing on the Cue path asks for and the fence claim the Cue router takes on its own deps. */
export type CueSpawnAuthorityDeps = Omit<ProcessSpawnAuthorityDeps, 'effects' | 'workflowFence'>;

/**
 * The desktop's Cue port (MRC-07-02A): what the Cue run router admits a prompt
 * run with on a desktop (`CueRunActionDeps.managed.port`). The same standing,
 * authority and policy as the process manager's port, since the same
 * enrollment answers for both, under the `CueSpawnAuthorityPort` shape the
 * router takes from any host (the headless engine composes
 * `createHeadlessSpawnAuthority` with origin `cue` for the same seat).
 *
 * The context carries origin `cue`, the registered actor (or the operator
 * before registration) as the principal, and whatever the router bound: the
 * run's lineage, the subscription-then-agent delegation chain and the
 * workflow with its owner fence. None of it is stripped or invented here: a
 * context naming another installation is refused, a workflow the router did
 * not fence never reaches this port (the router refuses it first), and a
 * Cue firing is a direct action of this process (peer `in-process`), never a
 * Web Login's.
 */
export function createCueSpawnAuthority(deps: CueSpawnAuthorityDeps): CueSpawnAuthorityPort {
	const now = deps.now ?? (() => Date.now());
	const verifier = createContextVerifier({
		verifierId: `desktop-cue:${deps.installation.runtimeId}`,
		peer: 'in-process',
		now,
		accept: (context) =>
			context.installation.installationId === deps.installation.installationId
				? []
				: [`installation ${context.installation.installationId} is not this one`],
	});
	return {
		standing: () => identityStandingOf(deps.identity.read()),
		get authority() {
			return deps.dispatch.authority;
		},
		policy: () => deps.host.policy(),
		context(input: HeadlessSpawnContextInput) {
			return verifier.verify({
				contractVersion: MANAGED_CONTRACT_VERSION,
				installation: deps.installation,
				origin: 'cue',
				actor: spawnPrincipal(deps.identity.read(), deps.installation),
				delegation: input.delegation ?? { chain: [], grantRef: null },
				identity: input.identity,
				policyRevision: input.policyRevision,
				workflow: input.workflow ?? null,
				traceId: input.traceId,
				requestedCapabilities: ['runs.submit'],
			});
		},
	};
}
