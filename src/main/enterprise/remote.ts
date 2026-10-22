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
	qualifySshLaunchTarget,
	resolveSshLaunchTarget,
	unqualifiedSshLaunchTarget,
	type SshLaunchTarget,
	type SshRemoteEndpointRead,
	type SshRemoteExpectation,
	type SshRemoteSettingsStore,
} from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { describeSshConnectionError } from '../../shared/sshConnection';
import type { AgentSshRemoteConfig, SshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import type { EnterpriseIdentityStore, IdentityRead } from './identity-store';

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
	providerId: string
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
}

export interface RemoteEndpointQualifierDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	probe?: RemoteEndpointProbe;
}

export function createRemoteEndpointQualifier(
	deps: RemoteEndpointQualifierDeps
): RemoteEndpointQualifier {
	const probe = deps.probe ?? createRemoteEndpointProbe();
	return {
		probe,
		async qualify(input) {
			const target = resolveSshLaunchTarget(input.sshStore, input.sshConfig);
			if (target.kind !== 'remote') return target;
			const expectation = remoteExpectation(deps.identity.read(), input.providerId);
			if (!expectation.ok) return unqualifiedSshLaunchTarget(target.remote, expectation.detail);
			const read = await probe(target.remote);
			const qualified = qualifySshLaunchTarget(target, read, expectation.expect);
			if (qualified.kind === 'unresolved') {
				const remoteId = target.remote.id;
				logger.warn('Managed SSH remote not qualified', LOG_CONTEXT, {
					remoteId,
					read: read.status,
				});
			}
			return qualified;
		},
	};
}
