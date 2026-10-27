/**
 * SSH Remote Configuration Resolver.
 *
 * Provides utilities for resolving which SSH remote configuration should
 * be used for agent execution.
 *
 * SSH is SESSION-LEVEL ONLY:
 * - Each session can have its own SSH config (sessionSshRemoteConfig)
 * - If no session SSH config, execution is local
 * - There is NO agent-level or global default SSH
 *
 * This module is used by the process spawn handlers to determine whether
 * an agent command should be executed locally or via SSH on a remote host.
 */

import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../types';
import { isSupportStatus, type SupportStatus } from '../managed/compatibility';
import { MANAGED_CONTRACT_VERSION, type ManagedSshEndpointRef } from '../managed/types';

/**
 * Options for resolving SSH remote configuration.
 */
export interface SshRemoteResolveOptions {
	/**
	 * Session-specific SSH remote configuration (optional).
	 * If provided and enabled, the session will execute via SSH.
	 * This is the ONLY way to enable SSH - there are no agent-level or global defaults.
	 */
	sessionSshConfig?: AgentSshRemoteConfig;
}

/**
 * Result of SSH remote configuration resolution.
 */
export interface SshRemoteResolveResult {
	/**
	 * The resolved SSH remote configuration, or null for local execution.
	 */
	config: SshRemoteConfig | null;

	/**
	 * How the configuration was resolved.
	 * - 'session': Session-level SSH config was used
	 * - 'disabled': SSH remote is explicitly disabled for this session
	 * - 'none': No SSH remote configured (local execution)
	 */
	source: 'session' | 'disabled' | 'none';
}

/**
 * Store interface for accessing SSH remote settings.
 * This allows dependency injection for testing.
 */
export interface SshRemoteSettingsStore {
	/**
	 * Get all SSH remote configurations.
	 */
	getSshRemotes(): SshRemoteConfig[];
}

/**
 * Resolve the effective SSH remote configuration for agent execution.
 *
 * SSH is session-level only:
 * 1. If sessionSshConfig is provided and explicitly disabled -> local execution
 * 2. If sessionSshConfig is provided with a remoteId -> use that specific remote
 * 3. Otherwise -> local execution (no defaults)
 *
 * @param store The settings store to read SSH remote configurations from
 * @param options Resolution options including session-specific config
 * @returns Resolved SSH remote configuration with source information
 *
 * @example
 * // No session config = local execution
 * const result = getSshRemoteConfig(store, {});
 * // result.config === null, result.source === 'none'
 *
 * @example
 * // With session-specific SSH config
 * const result = getSshRemoteConfig(store, {
 *   sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
 * });
 */
export function getSshRemoteConfig(
	store: SshRemoteSettingsStore,
	options: SshRemoteResolveOptions = {}
): SshRemoteResolveResult {
	const { sessionSshConfig } = options;

	// Get all available SSH remotes
	const sshRemotes = store.getSshRemotes();

	// Check session-specific configuration (the ONLY way to enable SSH)
	if (sessionSshConfig) {
		// If explicitly disabled for this session, return null (local execution)
		if (!sessionSshConfig.enabled) {
			return {
				config: null,
				source: 'disabled',
			};
		}

		// If session has a specific remote ID configured, use it
		if (sessionSshConfig.remoteId) {
			const config = sshRemotes.find((r) => r.id === sessionSshConfig.remoteId && r.enabled);

			if (config) {
				return {
					config,
					source: 'session',
				};
			}
			// If the specified remote doesn't exist or is disabled, fall through to local execution
		}
	}

	// No SSH remote configured - local execution
	return {
		config: null,
		source: 'none',
	};
}

/**
 * Create a SshRemoteSettingsStore adapter from an electron-store instance.
 *
 * This adapter wraps an electron-store to provide the SshRemoteSettingsStore
 * interface, allowing the resolver to be used with the actual settings store.
 *
 * @param store The electron-store instance with SSH remote settings
 * @returns A SshRemoteSettingsStore adapter
 *
 * @example
 * const storeAdapter = createSshRemoteStoreAdapter(settingsStore);
 * const result = getSshRemoteConfig(storeAdapter, {
 *   sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
 * });
 */
export function createSshRemoteStoreAdapter<
	T extends {
		get(key: 'sshRemotes', defaultValue: SshRemoteConfig[]): SshRemoteConfig[];
	},
>(store: T): SshRemoteSettingsStore {
	return {
		getSshRemotes: () => store.get('sshRemotes', []),
	};
}

/**
 * Where an agent launch runs. `unresolved` means the user turned SSH on but no
 * usable remote was found, and the launch must FAIL rather than run locally:
 * the user opted into a remote host, and running on their own machine (against
 * the remote's cwd, no less) is a wrong answer that looks like a working one.
 * `getSshRemoteConfig` folds that case into `none`, which is how callers kept
 * falling back to local.
 */
export type SshLaunchTarget =
	| { kind: 'local' }
	| {
			kind: 'remote';
			remote: SshRemoteConfig;
			/** The enrolled remote runtime a managed launch was qualified against (`qualifySshLaunchTarget`); absent until then. */
			endpoint?: SshRemoteEndpointIdentity;
	  }
	| {
			kind: 'unresolved';
			reason: SshLaunchUnresolvedReason;
			/** Says what is wrong and what to change, for showing to the user as-is. */
			message: string;
	  };

/** Why a launch that asked for SSH has no target; `remote-unqualified` is managed-only (`qualifySshLaunchTarget`). */
export type SshLaunchUnresolvedReason =
	| 'no-remote-selected'
	| 'remote-not-found'
	| 'remote-disabled'
	| 'no-remote-store'
	| 'remote-unqualified';

/**
 * Resolve where a launch runs, before anything is spawned. SSH is session-level
 * only (see `getSshRemoteConfig`); this adds the one thing that function cannot
 * say: that SSH was requested and cannot be honored, and why.
 */
export function resolveSshLaunchTarget(
	store: SshRemoteSettingsStore | undefined,
	sessionSshConfig: AgentSshRemoteConfig | null | undefined
): SshLaunchTarget {
	if (!sessionSshConfig?.enabled) return { kind: 'local' };

	const unresolved = (
		reason: Exclude<SshLaunchUnresolvedReason, 'remote-unqualified'>,
		detail: string
	): SshLaunchTarget => ({
		kind: 'unresolved',
		reason,
		message: `SSH remote execution is enabled for this agent, but ${detail} The agent was not started, so nothing ran on this machine instead.`,
	});

	const remoteId = sessionSshConfig.remoteId;
	if (!remoteId) {
		return unresolved(
			'no-remote-selected',
			'no remote is selected. Pick an SSH remote in the agent settings, or turn SSH off.'
		);
	}
	if (!store) {
		return unresolved(
			'no-remote-store',
			`the SSH remote list is not available here, so remote "${remoteId}" cannot be looked up.`
		);
	}
	const remote = store.getSshRemotes().find((r) => r.id === remoteId);
	if (!remote) {
		return unresolved(
			'remote-not-found',
			`its remote "${remoteId}" no longer exists. Choose another remote in the agent settings, or turn SSH off.`
		);
	}
	if (!remote.enabled) {
		const label = remote.name ? `"${remote.name}"` : `"${remoteId}"`;
		return unresolved(
			'remote-disabled',
			`its remote ${label} is disabled. Enable it in Settings -> SSH Hosts, or turn SSH off for this agent.`
		);
	}
	return { kind: 'remote', remote };
}

// ---------------------------------------------------------------------------
// The remote endpoint identity (MRC-08-04)
// ---------------------------------------------------------------------------

/**
 * What an enrolled Maestro runtime on an SSH remote attests about itself, read
 * back over the launch's own SSH connection (`src/main/enterprise/remote.ts`;
 * the remote's `maestro-cli host status --json` reports it under `managed`).
 * Attestation, not authority: SSH authenticated the host and our account, the
 * fields are the remote runtime's word, and `sshRemoteEndpointProblems` is
 * what this host requires of them. No secret and no device identity in here.
 */
export interface SshRemoteEndpointIdentity {
	contractVersion: string;
	installationId: string;
	runtimeId: string;
	processEpoch: string;
	/** The enterprise the remote is enrolled with. A launch stays inside one. */
	tenantId: string;
	orgId: string;
	/** The authority the remote's binding names (its own endpoint, tenant, org). */
	authorityId: string;
	/** The policy revision the remote applies, or null before one is installed. */
	policyRevision: number | null;
	/** `registered` only while the remote runtime holds a redeemed registration and its endpoint answers managed. */
	authority: 'none' | 'registered';
	/** The remote's OWN route table for launches arriving over SSH, one row per provider; the local table never stands in. */
	routes: readonly SshRemoteRouteRow[];
}

export interface SshRemoteRouteRow {
	providerId: string;
	/** As the REMOTE sees it: a launch arriving over SSH is `ssh`. */
	route: string;
	managed: SupportStatus;
	note?: string;
}

/** The route a launch takes from the remote's point of view. */
export const SSH_REMOTE_ARRIVAL_ROUTE = 'ssh';

/** What a probe came back with: `attested` carries the raw value for the rule to check; the others say why there is none. */
export type SshRemoteEndpointRead =
	| { status: 'attested'; identity: unknown; via: string }
	| { status: 'unreachable'; reason: string }
	| { status: 'unattested'; reason: string };

/** What this host requires of a remote: the same enterprise, a registered authority, a policy no older than ours, confinement of the provider's SSH arrivals. */
export interface SshRemoteExpectation {
	tenantId: string;
	orgId: string;
	/**
	 * The provider the launch would run on the remote, whose `ssh` row of the
	 * remote's route table must say `implemented`. Null for a command that
	 * launches no provider (a git write the managed executor runs over the
	 * remote's shell, MRC2-04-01A): the route-row check is skipped, and the
	 * enterprise, the registered authority and the policy revision still hold.
	 */
	providerId: string | null;
	/** What this host applies; the remote may not be behind it. */
	policyRevision: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;

/** The problems with a value offered as a remote endpoint identity against the expectation; shape first, then the rule. Pure. */
export function sshRemoteEndpointProblems(value: unknown, expect: SshRemoteExpectation): string[] {
	if (!isObject(value)) return ['the remote attestation is not an object'];
	const problems: string[] = [];
	if (value.contractVersion !== MANAGED_CONTRACT_VERSION) {
		problems.push(
			`the remote runtime speaks managed contract ${String(value.contractVersion)}, not ${MANAGED_CONTRACT_VERSION}`
		);
	}
	for (const key of [
		'installationId',
		'runtimeId',
		'processEpoch',
		'tenantId',
		'orgId',
		'authorityId',
	] as const) {
		if (!isId(value[key])) problems.push(`${key} is not an id`);
	}
	if (
		value.policyRevision !== null &&
		(typeof value.policyRevision !== 'number' || !Number.isInteger(value.policyRevision))
	) {
		problems.push('policyRevision is not an integer or null');
	}
	if (value.authority !== 'none' && value.authority !== 'registered') {
		problems.push('authority is not none or registered');
	}
	if (!Array.isArray(value.routes)) problems.push('routes is not an array');
	else {
		value.routes.forEach((row, i) => {
			if (
				!isObject(row) ||
				!isId(row.providerId) ||
				!isId(row.route) ||
				!isSupportStatus(row.managed)
			) {
				problems.push(`routes[${i}] is not a route row`);
			}
		});
	}
	if (problems.length > 0) return problems;

	const identity = value as unknown as SshRemoteEndpointIdentity;
	if (identity.tenantId !== expect.tenantId || identity.orgId !== expect.orgId) {
		problems.push(
			`the remote is enrolled with tenant ${identity.tenantId} / org ${identity.orgId}, not this host's ${expect.tenantId} / ${expect.orgId}`
		);
	}
	if (identity.authority !== 'registered') {
		problems.push(
			'the remote runtime holds no registered authority (enrolled but unattached, or no actor registered there)'
		);
	}
	if (
		expect.policyRevision !== null &&
		(identity.policyRevision === null || identity.policyRevision < expect.policyRevision)
	) {
		problems.push(
			`the remote applies policy revision ${identity.policyRevision ?? 'none'}, behind this host's ${expect.policyRevision}`
		);
	}
	if (expect.providerId === null) return problems;
	const row = identity.routes.find(
		(entry) => entry.providerId === expect.providerId && entry.route === SSH_REMOTE_ARRIVAL_ROUTE
	);
	if (!row) {
		problems.push(
			`the remote does not report whether it confines ${expect.providerId} launches arriving over SSH`
		);
	} else if (row.managed !== 'implemented') {
		problems.push(
			`the remote does not confine ${expect.providerId} launches arriving over SSH (its route table says ${row.managed}${row.note ? `: ${row.note}` : ''})`
		);
	}
	return problems;
}

/** The managed refusal for a resolved remote, with the no-fallback promise for both machines. `detail` ends the sentence. */
export function unqualifiedSshLaunchTarget(
	remote: Pick<SshRemoteConfig, 'id' | 'name'>,
	detail: string
): Extract<SshLaunchTarget, { kind: 'unresolved' }> {
	const label = remote.name ? `"${remote.name}"` : `"${remote.id}"`;
	return {
		kind: 'unresolved',
		reason: 'remote-unqualified',
		message: `SSH remote execution is enabled for this agent, but under management its remote ${label} is not a qualified managed endpoint: ${detail} The agent was not started: nothing ran on the remote unmanaged, and nothing ran on this machine instead.`,
	};
}

/**
 * Bind a resolved remote to the endpoint it attested, or refuse by name: a
 * local approval, the local route table and a working login prove nothing
 * about the remote, and a refused launch runs nowhere. Local and unresolved pass through.
 */
export function qualifySshLaunchTarget(
	target: SshLaunchTarget,
	read: SshRemoteEndpointRead,
	expect: SshRemoteExpectation
): SshLaunchTarget {
	if (target.kind !== 'remote') return target;
	const unqualified = (detail: string) => unqualifiedSshLaunchTarget(target.remote, detail);
	if (read.status === 'unreachable') {
		return unqualified(`the remote could not be asked for its managed standing (${read.reason}).`);
	}
	if (read.status === 'unattested') {
		return unqualified(`${read.reason}.`);
	}
	const problems = sshRemoteEndpointProblems(read.identity, expect);
	if (problems.length > 0) return unqualified(`${problems.join('; ')}.`);
	return {
		kind: 'remote',
		remote: target.remote,
		endpoint: structuredClone(read.identity as SshRemoteEndpointIdentity),
	};
}

/** The part of an attested identity a lease's target names: which remote installation, process and authority (never the route table). */
export function managedSshEndpointRef(identity: SshRemoteEndpointIdentity): ManagedSshEndpointRef {
	return {
		installationId: identity.installationId,
		runtimeId: identity.runtimeId,
		processEpoch: identity.processEpoch,
		authorityId: identity.authorityId,
		policyRevision: identity.policyRevision,
	};
}
