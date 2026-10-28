/**
 * The remote endpoint identity (phase 08, MRC-08-04): what this desktop
 * requires of an SSH remote before a managed launch may target it.
 *
 * A login proves the remote host's key and our account, nothing about
 * whether a launch there is confined: the policy that admitted the launch
 * bounded THIS host's process, and on the remote the provider would run in a
 * login shell with whatever that account has. So a managed launch is handed
 * over only when the Maestro runtime running there attests, over the same
 * SSH connection (`maestro-cli host status --json`), a standing this host
 * accepts; the pure rule is `sshRemoteEndpointProblems` in
 * `launch/ssh-remote-resolver.ts`. `readRemoteAttestation` reads the probe
 * (never decides), `createRemoteEndpointProbe` runs it bounded over the
 * launch's own ssh command, `createRemoteEndpointQualifier` states this
 * host's expectation from its sealed enrollment and binds the identity to the
 * launch target or refuses by name, and the launch then runs nowhere. Not a
 * remote producer: a remote runtime of this build attests `ssh` as
 * `unverified`, so every real remote is refused by its own word. The host's
 * side of the attestation is `hostManagedStanding` (`runtime/server.ts`): a
 * headless host with a composed adapter reports `managed`; `maestro-cli host
 * start` composes none yet, so a real detached host still reports none.
 */

import { execFileNoThrow, type ExecResult } from '../../shared/maestro-lib/launch/exec-file';
import { buildSshCommand } from '../../shared/maestro-lib/launch/ssh-command-builder';
import {
	managedSshEndpointRef,
	qualifySshLaunchTarget,
	resolveSshLaunchTarget,
	unqualifiedSshLaunchTarget,
	type SshLaunchTarget,
	type SshRemoteEndpointRead,
	type SshRemoteExpectation,
	type SshRemoteSettingsStore,
} from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedSshEndpointRef } from '../../shared/maestro-lib/managed/types';
import { describeSshConnectionError } from '../../shared/sshConnection';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import type { EnterpriseIdentityStore, IdentityRead } from './identity-store';
import {
	callingLocalEffectActor,
	type LocalEffectActor,
	type LocalEffectAuthority,
	type LocalEffectDenial,
	type LocalEffectReceipt,
} from './local-effects-policy';

const LOG_CONTEXT = '[EnterpriseRemote]';

/** The remote program that attests the remote's standing, how it is asked, and the bounds on its answer. */
export const REMOTE_ATTESTATION_COMMAND = 'maestro-cli';
export const REMOTE_ATTESTATION_ARGS: readonly string[] = ['host', 'status', '--json'];
export const REMOTE_ATTESTATION_VIA = `${REMOTE_ATTESTATION_COMMAND} ${REMOTE_ATTESTATION_ARGS.join(' ')}`;
export const REMOTE_ATTESTATION_TIMEOUT_MS = 20_000;
export const REMOTE_ATTESTATION_MAX_BYTES = 256 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Read the probe's answer: `{ running: true, managed?: <identity> }` on a live
 * runtime, `{ running: false, reason }` on none, no JSON when ssh fails. Only
 * `managed` is an attestation, and it is checked later: this reads, never accepts.
 */
export function readRemoteAttestation(
	result: Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode'>
): SshRemoteEndpointRead {
	const stdout = result.stdout ?? '';
	if (Buffer.byteLength(stdout) > REMOTE_ATTESTATION_MAX_BYTES) {
		return {
			status: 'unattested',
			reason: `the remote answered ${Buffer.byteLength(stdout)} bytes where a status report was expected`,
		};
	}
	const text = stdout.trim();
	let parsed: unknown;
	if (text.startsWith('{')) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
	}
	if (!isObject(parsed)) {
		if (result.exitCode !== 0) {
			const detail =
				describeSshConnectionError(result.stderr ?? '') ??
				`the probe exited ${result.exitCode} with no output`;
			return { status: 'unreachable', reason: detail };
		}
		return {
			status: 'unattested',
			reason: 'the remote ran the probe but answered no status report',
		};
	}
	if (parsed.running !== true) {
		const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no host is running';
		return {
			status: 'unattested',
			reason: `no Maestro runtime is running on the remote (${reason})`,
		};
	}
	if (parsed.managed === undefined || parsed.managed === null) {
		const reason =
			'the Maestro runtime on the remote reports no managed standing (it holds no enrollment, or predates the attestation)';
		return { status: 'unattested', reason };
	}
	return { status: 'attested', identity: parsed.managed, via: REMOTE_ATTESTATION_VIA };
}

export type RemoteEndpointProbe = (remote: SshRemoteConfig) => Promise<SshRemoteEndpointRead>;

export interface RemoteEndpointProbeDeps {
	/** Runs the ssh command. Default: `execFileNoThrow`, bounded by `timeoutMs`. */
	execSsh?(command: string, args: string[], timeoutMs: number): Promise<ExecResult>;
	/** The remote program. Default `maestro-cli`, found through the launch PATH bootstrap. */
	cliCommand?: string;
	timeoutMs?: number;
}

/**
 * Ask a remote for its managed standing over the launch's own ssh command
 * (same host, port, key, options and PATH bootstrap as the agent would get).
 * A connection or timeout failure is `unreachable`, never an exception.
 */
export function createRemoteEndpointProbe(deps: RemoteEndpointProbeDeps = {}): RemoteEndpointProbe {
	const timeoutMs = deps.timeoutMs ?? REMOTE_ATTESTATION_TIMEOUT_MS;
	const execSsh =
		deps.execSsh ??
		((command: string, args: string[], timeout: number) =>
			execFileNoThrow(command, args, undefined, { timeout }));
	const cliCommand = deps.cliCommand ?? REMOTE_ATTESTATION_COMMAND;
	return async (remote) => {
		let result: ExecResult;
		try {
			const command = await buildSshCommand(remote, {
				command: cliCommand,
				args: [...REMOTE_ATTESTATION_ARGS],
			});
			result = await execSsh(command.command, command.args, timeoutMs);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('Remote attestation probe failed', LOG_CONTEXT, { remoteId: remote.id, message });
			return { status: 'unreachable', reason: message };
		}
		const read = readRemoteAttestation(result);
		logger.info('Remote attestation read', LOG_CONTEXT, {
			remoteId: remote.id,
			status: read.status,
		});
		return read;
	};
}

/**
 * What this host expects of a remote, from its own sealed enrollment. With no
 * trusted record there is nothing to compare against: a refusal, never "any remote".
 */
export function remoteExpectation(
	read: IdentityRead,
	/** The provider the launch runs on the remote; null for a command that launches none (a git write), which skips the route-row check. */
	providerId: string | null
): { ok: true; expect: SshRemoteExpectation } | { ok: false; detail: string } {
	switch (read.status) {
		case 'ok': {
			const { tenantId, orgId, policy } = read.record;
			return {
				ok: true,
				expect: { tenantId, orgId, providerId, policyRevision: policy.appliedRevision },
			};
		}
		case 'none':
			return { ok: false, detail: 'this host holds no enrollment to compare the remote against.' };
		case 'unprotected':
		case 'untrusted':
			return {
				ok: false,
				detail: `this host's enrollment custody is ${read.status} (${read.message}), so there is no trusted enrollment to compare the remote against.`,
			};
	}
}

export interface RemoteEndpointQualifyInput {
	sshConfig: AgentSshRemoteConfig | null | undefined;
	sshStore: SshRemoteSettingsStore | undefined;
	/** The provider the launch would run on the remote (the agent's tool type). */
	providerId: string;
}

export interface RemoteEndpointQualifier {
	readonly probe: RemoteEndpointProbe;
	/** Local with SSH off; the remote with its endpoint bound when it qualifies; otherwise `unresolved`. */
	qualify(input: RemoteEndpointQualifyInput): Promise<SshLaunchTarget>;
	/**
	 * The same verdict over a remote a caller already resolved (the shared git
	 * executor holds the `SshRemoteConfig` it was handed, MRC2-04-01A), for a
	 * command that launches no provider: the enterprise, the registered
	 * authority and the policy revision are required, the route-row check is
	 * skipped. Never local: a disabled remote is `unresolved` by name.
	 */
	qualifyResolved(remote: SshRemoteConfig): Promise<SshLaunchTarget>;
}

export interface RemoteEndpointQualifierDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	probe?: RemoteEndpointProbe;
}

export function createRemoteEndpointQualifier(
	deps: RemoteEndpointQualifierDeps
): RemoteEndpointQualifier {
	const probe = deps.probe ?? createRemoteEndpointProbe();
	const qualifyTarget = async (
		target: Extract<SshLaunchTarget, { kind: 'remote' }>,
		providerId: string | null
	): Promise<SshLaunchTarget> => {
		const expectation = remoteExpectation(deps.identity.read(), providerId);
		if (!expectation.ok) return unqualifiedSshLaunchTarget(target.remote, expectation.detail);
		const read = await probe(target.remote);
		const qualified = qualifySshLaunchTarget(target, read, expectation.expect);
		if (qualified.kind === 'unresolved') {
			const remoteId = target.remote.id;
			logger.warn('Managed SSH remote not qualified', LOG_CONTEXT, {
				remoteId,
				providerId,
				read: read.status,
			});
		}
		return qualified;
	};
	return {
		probe,
		async qualify(input) {
			const target = resolveSshLaunchTarget(input.sshStore, input.sshConfig);
			if (target.kind !== 'remote') return target;
			return qualifyTarget(target, input.providerId);
		},
		async qualifyResolved(remote) {
			// The resolver's own rule for a remote the user switched off, so the
			// executor is told the same thing a launch would be, and runs nothing.
			const target = resolveSshLaunchTarget(
				{ getSshRemotes: () => [remote] },
				{ enabled: true, remoteId: remote.id }
			);
			if (target.kind !== 'remote') return target;
			return qualifyTarget(target, null);
		},
	};
}

// ---------------------------------------------------------------------------
// Remote file access and connection tests under the remote identity (MRC2-05-07)
// ---------------------------------------------------------------------------

/**
 * What a sink is about to do on a remote. Phase 1 bound the remote identity to
 * a LAUNCH; the File Explorer, Auto Run, session storage, the marketplace and
 * the connection test open SSH sessions of their own through `remote-fs.ts`
 * and `ssh-remote-manager.ts`, and under management each of those requires
 * the same qualified endpoint before a session opens. `read` runs a command
 * that changes nothing there (ls, cat, stat, find, du); `write` puts content
 * of this machine there (a file write, a mkdir, a rename, a zip) and also
 * consults the local-effects ceiling as the `remote-write` effect; `delete`
 * removes something there (rm) and is held as the destructive `delete` effect
 * by the delete sink that calls remote-fs (`holdDeleteEffect` covers remote
 * paths), so this rule binds the identity and does not hold it a second time;
 * `probe` asks the remote about itself (a connection test, later a `which` or
 * a version). Standalone (no enrollment) answers allow with no call at all.
 */
export const REMOTE_ACCESS_CLASSES = ['read', 'write', 'delete', 'probe'] as const;
export type RemoteAccessClass = (typeof REMOTE_ACCESS_CLASSES)[number];

export interface RemoteAccessRequest {
	class: RemoteAccessClass;
	remote: SshRemoteConfig;
	/** The operation by name (`readDir`, `writeFile`, `test-connection`). */
	operation: string;
	/** The remote path the operation names; null for one that names none. A batch names its first. */
	target?: string | null;
	/** How many items one hold covers; 1 when omitted. */
	count?: number;
}

export type RemoteAccessDenial = 'remote-unqualified' | LocalEffectDenial;

export interface RemoteAccessReceipt {
	policyRevision: number | null;
	class: RemoteAccessClass;
	operation: string;
	remoteId: string;
	target: string | null;
	count: number;
	/** The endpoint the remote qualified as; null when it did not. */
	endpoint: ManagedSshEndpointRef | null;
	/** The local-effects receipt of a `write`; null for every other class and for an unqualified remote. */
	effect: LocalEffectReceipt | null;
	outcome: 'within-ceiling' | RemoteAccessDenial;
}

export type RemoteAccessDecision =
	| { allowed: true; managed?: RemoteAccessReceipt }
	| { allowed: false; code: RemoteAccessDenial; message: string; managed: RemoteAccessReceipt };

/** What a sink holds a remote access with: the authority below, or a test double. */
export interface RemoteAccessAuthority {
	hold(request: RemoteAccessRequest): Promise<RemoteAccessDecision>;
}

/**
 * How long one remote's qualification is reused. A file tree walk asks for
 * hundreds of reads in seconds; asking the remote for its standing on each
 * would open an SSH session per question. An admission is kept for a minute,
 * a refusal for fifteen seconds (so a remote that comes up is retried soon),
 * and concurrent askers share one in-flight probe. The key carries the
 * remote's connection fields and this host's enrollment epoch and applied
 * revision, so an edited remote or a moved policy is asked again.
 */
export const REMOTE_ACCESS_QUALIFICATION_TTL_MS = { admitted: 60_000, refused: 15_000 } as const;
/** Distinct remotes the cache keeps; past it the cache starts over rather than grow. */
export const MAX_REMOTE_QUALIFICATION_CACHE = 64;

export function describeRemoteAccess(
	request: Pick<RemoteAccessRequest, 'class' | 'operation' | 'target' | 'count'>
): string {
	const count = request.count ?? 1;
	const items = count > 1 ? `, ${count} items` : '';
	const target = request.target ? ` of ${request.target}` : '';
	return `a remote ${request.class} (${request.operation}${target}${items})`;
}

export interface RemoteAccessAuthorityDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	/**
	 * Bind the remote to the enrolled endpoint it attests (the service's
	 * `remote.qualifyResolved`); absent, every managed access is refused by name.
	 */
	qualifyRemote?(remote: SshRemoteConfig): Promise<SshLaunchTarget>;
	/** The local-effects ceiling a `write` consults; none under management refuses the write `unavailable`. */
	localEffects(): LocalEffectAuthority | null;
	/** Who asks. Default: the transport this call was admitted over (AsyncLocalStorage survives the sink's awaits). */
	actor?(): LocalEffectActor;
	now?(): number;
	ttlMs?: Partial<typeof REMOTE_ACCESS_QUALIFICATION_TTL_MS>;
}

type QualificationEntry =
	| { until: number; target: SshLaunchTarget }
	| { until: null; promise: Promise<SshLaunchTarget> };

function remoteQualificationKey(remote: SshRemoteConfig, read: IdentityRead): string {
	const enrollment =
		read.status === 'ok' ? `${read.epoch}:${read.record.policy.appliedRevision}` : read.status;
	return [
		enrollment,
		remote.id,
		remote.host,
		remote.port,
		remote.username ?? '',
		remote.privateKeyPath ?? '',
		remote.useSshConfig ? 'config' : '',
		JSON.stringify(remote.sshOptions ?? {}),
	].join('\n');
}

/**
 * The authority every remote-fs command and connection test is held with
 * under management. The remote must qualify as an enrolled endpoint (the
 * launch rule, with no provider route to confine since a file command launches
 * none); a `write` is then held on the local-effects ceiling as `remote-write`
 * with the path and count. A refusal names the remote, the operation and the
 * reason, and the sink opens no SSH session: nothing runs on the remote
 * unmanaged and nothing runs on this machine instead.
 */
export function createRemoteAccessAuthority(
	deps: RemoteAccessAuthorityDeps
): RemoteAccessAuthority {
	const now = deps.now ?? Date.now;
	const ttl = { ...REMOTE_ACCESS_QUALIFICATION_TTL_MS, ...deps.ttlMs };
	const actor = deps.actor ?? callingLocalEffectActor;
	const cache = new Map<string, QualificationEntry>();

	const qualify = (remote: SshRemoteConfig, read: IdentityRead): Promise<SshLaunchTarget> => {
		const key = remoteQualificationKey(remote, read);
		const seen = cache.get(key);
		if (seen) {
			if (seen.until === null) return seen.promise;
			if (seen.until > now()) return Promise.resolve(seen.target);
			cache.delete(key);
		}
		if (!deps.qualifyRemote)
			return Promise.resolve(
				unqualifiedSshLaunchTarget(
					remote,
					'this host binds no remote endpoint identity for remote file access.'
				)
			);
		const promise = deps.qualifyRemote(remote).then(
			(target) => {
				const admitted = target.kind === 'remote' && target.endpoint !== undefined;
				if (cache.size >= MAX_REMOTE_QUALIFICATION_CACHE) cache.clear();
				cache.set(key, { until: now() + (admitted ? ttl.admitted : ttl.refused), target });
				return target;
			},
			(error: unknown) => {
				cache.delete(key);
				throw error;
			}
		);
		cache.set(key, { until: null, promise });
		return promise;
	};

	return {
		async hold(request) {
			const read = deps.identity.read();
			if (read.status === 'none') return { allowed: true };
			const label = request.remote.name ? `"${request.remote.name}"` : `"${request.remote.id}"`;
			const what = describeRemoteAccess(request);
			const receipt = (
				outcome: RemoteAccessReceipt['outcome'],
				endpoint: ManagedSshEndpointRef | null,
				effect: LocalEffectReceipt | null
			): RemoteAccessReceipt => ({
				policyRevision: deps.policy()?.appliedRevision ?? null,
				class: request.class,
				operation: request.operation,
				remoteId: request.remote.id,
				target: request.target ?? null,
				count: request.count ?? 1,
				endpoint,
				effect,
				outcome,
			});
			const unqualified = (detail: string): RemoteAccessDecision => ({
				allowed: false,
				code: 'remote-unqualified',
				message: `under management the SSH remote ${label} is not a qualified managed endpoint for ${what}: ${detail} No SSH session was opened.`,
				managed: receipt('remote-unqualified', null, null),
			});
			const target = await qualify(request.remote, read);
			if (target.kind === 'unresolved') return unqualified(target.message);
			if (target.kind !== 'remote' || !target.endpoint)
				return unqualified('the remote was resolved but no enrolled endpoint was bound to it.');
			const endpoint = managedSshEndpointRef(target.endpoint);
			if (request.class !== 'write')
				return { allowed: true, managed: receipt('within-ceiling', endpoint, null) };
			const localEffects = deps.localEffects();
			if (!localEffects)
				return {
					allowed: false,
					code: 'unavailable',
					message: `under management ${what} on the SSH remote ${label} is held on the local-effects ceiling, and this host composes none. No SSH session was opened.`,
					managed: receipt('unavailable', endpoint, null),
				};
			const decision = await localEffects.authorize({
				effect: 'remote-write',
				actor: actor(),
				target: request.target ?? null,
				count: request.count ?? 1,
			});
			if (decision.allowed)
				return {
					allowed: true,
					managed: receipt('within-ceiling', endpoint, decision.managed ?? null),
				};
			return {
				allowed: false,
				code: decision.code,
				message: `${decision.message} (${what} on the SSH remote ${label}; no SSH session was opened)`,
				managed: receipt(decision.code, endpoint, decision.managed),
			};
		},
	};
}
