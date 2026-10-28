/**
 * SSH Remote Manager for Maestro.
 *
 * Manages SSH remote configurations and provides connection testing.
 * Used to execute AI agent commands on remote hosts via SSH.
 */

import { SshRemoteConfig, SshRemoteTestResult } from '../shared/types';
import { execFileNoThrow, ExecResult } from './utils/execFile';
import { expandTilde } from '../shared/pathUtils';
import { captureException } from './utils/sentry';
import { getPathAccessCache, defaultReadableProbe } from './utils/path-access-cache';
import { validateSshOption } from '../shared/sshOptions';
import {
	buildSshConnectionArgs,
	buildSshProbeCommand,
	describeSshConnectionError,
	readSshProbeOutput,
	SSH_PROBE_MARKER,
} from '../shared/sshConnection';
import {
	detectNonPosixRemoteShell,
	nonPosixRemoteShellRemediation,
} from '../shared/sshRemoteShell';
import { formatManagedHold } from '../shared/formatters';
import { logger } from './utils/logger';
import type {
	RemoteAccessAuthority,
	RemoteAccessClass,
	RemoteAccessDecision,
	RemoteAccessDenial,
	RemoteAccessRequest,
} from './enterprise/remote';

const LOG_CONTEXT = '[SshRemote]';

/**
 * The remote identity every SSH session this process opens for a file command
 * or a connection test is held to under management (MRC2-05-07), and the quiet
 * record of what it refused. This module is the one `remote-fs.ts` and the
 * connection test already share, so it holds the authority the desktop installs
 * at app-ready (`setRemoteAccessAuthority()` from `src/main/index.ts`, composed
 * by `createRemoteAccessAuthority()` in `src/main/enterprise/remote.ts`, which
 * is imported here by type only). With none installed nothing is consulted and
 * a standalone host never pays for the question. A refusal is recorded once per
 * remote, class and code with a count (`heldRemoteAccess()`) and warned once,
 * so a file tree walk refused a hundred times is one row, not a hundred toasts.
 */
let remoteAccessAuthority: RemoteAccessAuthority | null = null;
const remoteAccessHolds = new Map<string, RemoteAccessHold>();

/** One refusal a sink carries, and one row of the ledger. */
export interface RemoteAccessHold {
	remoteId: string;
	remoteName: string;
	class: RemoteAccessClass;
	operation: string;
	code: RemoteAccessDenial;
	/** `[managed-<code>] ...`, the line a sink answers with. */
	message: string;
	policyRevision: number | null;
	firstAt: string;
	lastAt: string;
	count: number;
}

/** Distinct holds the ledger keeps; a refusal past the bound is still answered, only its record is dropped. */
export const MAX_REMOTE_ACCESS_HOLDS = 64;

/** The exit code of a remote command the managed identity refused: ssh never ran. */
export const REMOTE_ACCESS_REFUSED_EXIT_CODE = 'EMANAGED';

/** Install (or, with null, remove) the authority every remote access of this process is held with. Clears the ledger. */
export function setRemoteAccessAuthority(authority: RemoteAccessAuthority | null): void {
	remoteAccessAuthority = authority;
	remoteAccessHolds.clear();
}

function recordRemoteAccessHold(
	request: RemoteAccessRequest,
	decision: Extract<RemoteAccessDecision, { allowed: false }>
): RemoteAccessHold {
	const key = `${request.remote.id}\n${request.class}\n${decision.code}`;
	const at = new Date().toISOString();
	const seen = remoteAccessHolds.get(key);
	if (seen) {
		seen.lastAt = at;
		seen.count += 1;
		return { ...seen };
	}
	const hold: RemoteAccessHold = {
		remoteId: request.remote.id,
		remoteName: request.remote.name || request.remote.id,
		class: request.class,
		operation: request.operation,
		code: decision.code,
		message: formatManagedHold(decision),
		policyRevision: decision.managed.policyRevision,
		firstAt: at,
		lastAt: at,
		count: 1,
	};
	if (remoteAccessHolds.size < MAX_REMOTE_ACCESS_HOLDS) remoteAccessHolds.set(key, hold);
	logger.warn(
		'Remote access refused by the managed remote identity; no SSH session was opened',
		LOG_CONTEXT,
		{
			remoteId: request.remote.id,
			class: request.class,
			operation: request.operation,
			code: decision.code,
			receipt: decision.managed,
		}
	);
	return { ...hold };
}

/**
 * The hold a remote access meets, or null when the session may open. With no
 * authority installed nothing is consulted and the answer is null. A refusal
 * is recorded before it is answered; the sink opens nothing and answers the
 * hold's message.
 */
export async function holdRemoteAccess(
	request: RemoteAccessRequest
): Promise<RemoteAccessHold | null> {
	if (!remoteAccessAuthority) return null;
	const decision = await remoteAccessAuthority.hold(request);
	if (decision.allowed) return null;
	return recordRemoteAccessHold(request, decision);
}

/** The result a refused remote command answers in place of ssh's: the hold's line on stderr and an exit code no shell produces. */
export function remoteAccessRefusal(hold: RemoteAccessHold): ExecResult {
	return { stdout: '', stderr: hold.message, exitCode: REMOTE_ACCESS_REFUSED_EXIT_CODE };
}

/** True when a remote command's result is a managed refusal rather than an answer from the remote. */
export function isRemoteAccessRefusal(result: ExecResult): boolean {
	return result.exitCode === REMOTE_ACCESS_REFUSED_EXIT_CODE;
}

/** What the identity has refused since the authority was installed, once per remote, class and code with a count. Copies. */
export function heldRemoteAccess(): readonly RemoteAccessHold[] {
	return [...remoteAccessHolds.values()].map((hold) => ({ ...hold }));
}

/**
 * Validation result for SSH remote configuration.
 */
export interface SshRemoteValidation {
	/** Whether the configuration is valid */
	valid: boolean;
	/** List of validation error messages */
	errors: string[];
}

/**
 * Dependencies that can be injected for testing.
 */
export interface SshRemoteManagerDeps {
	/** Function to check file accessibility */
	checkFileAccess: (filePath: string) => boolean;
	/** Function to execute SSH commands */
	execSsh: (command: string, args: string[]) => Promise<ExecResult>;
}

/**
 * Default dependencies using real implementations. `checkFileAccess` is
 * wrapped behind {@link PathAccessCache} so rapid re-validation (e.g.
 * consecutive Test Connection clicks) skips the duplicate stat. Test
 * deps mock `checkFileAccess` directly and bypass the cache entirely.
 */
const defaultDeps: SshRemoteManagerDeps = {
	checkFileAccess: (filePath: string): boolean => {
		return getPathAccessCache().check(filePath, defaultReadableProbe);
	},
	execSsh: (command: string, args: string[]): Promise<ExecResult> => {
		return execFileNoThrow(command, args);
	},
};

/**
 * Manager for SSH remote configurations and connections.
 *
 * Provides:
 * - Configuration validation
 * - Connection testing
 * - SSH argument building
 */
export class SshRemoteManager {
	private readonly deps: SshRemoteManagerDeps;

	/**
	 * Default SSH options used for all connections.
	 * These options ensure non-interactive key-based authentication.
	 */
	/**
	 * Create a new SshRemoteManager.
	 *
	 * @param deps Optional dependencies for testing. Uses real implementations if not provided.
	 */
	constructor(deps?: Partial<SshRemoteManagerDeps>) {
		this.deps = { ...defaultDeps, ...deps };
	}

	/**
	 * Validate an SSH remote configuration.
	 *
	 * Checks:
	 * - Required fields are present
	 * - Port is in valid range (1-65535)
	 * - Private key file exists and is readable (unless using SSH config)
	 *
	 * When useSshConfig is true, username and privateKeyPath are optional
	 * as they can be inherited from ~/.ssh/config.
	 *
	 * @param config The SSH remote configuration to validate
	 * @returns Validation result with any error messages
	 */
	validateConfig(config: SshRemoteConfig): SshRemoteValidation {
		const errors: string[] = [];

		// Note: id is intentionally NOT validated here. It is a storage concern,
		// not a connection concern, and the save handler always assigns one
		// (crypto.randomUUID) before persisting. Requiring it here would break
		// "Test Connection" before saving a brand-new remote, which has no id yet.

		if (!config.name || config.name.trim() === '') {
			errors.push('Name is required');
		}

		if (!config.host || config.host.trim() === '') {
			errors.push('Host is required');
		}

		// Username and privateKeyPath are always optional - SSH will use:
		// 1. Values from ~/.ssh/config if the host matches a Host pattern
		// 2. ssh-agent for key authentication
		// 3. System defaults (current user, default keys)
		// The connection test will verify if the configuration actually works.

		// Port validation
		if (typeof config.port !== 'number' || config.port < 1 || config.port > 65535) {
			errors.push('Port must be between 1 and 65535');
		}

		// Private key file existence check (only if path is provided)
		if (config.privateKeyPath && config.privateKeyPath.trim() !== '') {
			const keyPath = expandTilde(config.privateKeyPath);
			if (!this.deps.checkFileAccess(keyPath)) {
				errors.push(`Private key not readable: ${config.privateKeyPath}`);
			}
		}

		// Extra `-o` options. A malformed keyword makes ssh exit before it dials,
		// so rejecting it here names the offending option instead of surfacing a
		// bare "command-line: line 0: Bad configuration option" at spawn time.
		for (const [key, value] of Object.entries(config.sshOptions ?? {})) {
			const invalid = validateSshOption(key, value);
			if (invalid) errors.push(invalid);
		}

		return {
			valid: errors.length === 0,
			errors,
		};
	}

	/**
	 * Test SSH connection to a remote host.
	 *
	 * Executes a simple command on the remote to verify:
	 * - SSH connection can be established
	 * - Authentication succeeds
	 * - Remote shell is accessible
	 *
	 * Optionally checks if the specified agent command is available.
	 *
	 * @param config The SSH remote configuration to test
	 * @param agentCommand Optional agent command to check availability (e.g., 'claude')
	 * @returns Test result with success status and remote info
	 */
	async testConnection(
		config: SshRemoteConfig,
		agentCommand?: string
	): Promise<SshRemoteTestResult> {
		// First validate the config
		const validation = this.validateConfig(config);
		if (!validation.valid) {
			return {
				success: false,
				error: validation.errors.join('; '),
			};
		}

		// Under management the remote must qualify as an enrolled endpoint before a
		// session opens (MRC2-05-07): the refusal is the test's answer, ssh never runs.
		const hold = await holdRemoteAccess({
			class: 'probe',
			remote: config,
			operation: 'test-connection',
			target: null,
		});
		if (hold) return { success: false, error: hold.message };

		// Build SSH command for connection test
		const sshArgs = this.buildSshArgs(config);

		sshArgs.push(buildSshProbeCommand(agentCommand));

		try {
			const result = await this.deps.execSsh('ssh', sshArgs);

			if (result.exitCode !== 0) {
				// A Windows shell rejecting `&&` means SSH itself worked; say so
				// rather than surfacing the PowerShell parser dump as a connection error.
				const shell = detectNonPosixRemoteShell(`${result.stdout}\n${result.stderr}`);
				if (shell) {
					const remediation = nonPosixRemoteShellRemediation(
						shell,
						await this.probeHostname(config)
					);
					return { success: false, error: remediation.detail, remediation };
				}

				// Parse common SSH error patterns
				const errorMessage = this.parseSSHError(result.stderr) || 'Connection failed';
				return { success: false, error: errorMessage };
			}

			const reading = readSshProbeOutput(result.stdout, Boolean(agentCommand));
			if (!reading.ok) {
				// cmd.exe honors `&&` but does not strip the quotes around the marker,
				// so a quoted marker identifies the shell rather than a broken host.
				const lines = result.stdout.trim().split('\n');
				if (lines[0]?.trim() === `"${SSH_PROBE_MARKER}"`) {
					const remediation = nonPosixRemoteShellRemediation('cmd', lines[1]?.trim() || undefined);
					return { success: false, error: remediation.detail, remediation };
				}
				return { success: false, error: 'Unexpected response from remote host' };
			}

			return {
				success: true,
				remoteInfo: {
					hostname: reading.hostname ?? 'unknown',
					agentVersion: reading.agentFound ? 'installed' : undefined,
				},
			};
		} catch (err) {
			void captureException(err);
			return {
				success: false,
				error: `Connection test failed: ${String(err)}`,
			};
		}
	}

	/**
	 * Ask a remote for its hostname with a command every shell understands.
	 *
	 * `hostname` is a bare executable on Windows and a builtin or binary on
	 * POSIX systems, so it survives the shell mismatch that broke the main test
	 * command. Used only to name the host in the non-POSIX shell error.
	 *
	 * @param config The SSH remote configuration
	 * @returns The remote hostname, or undefined if the probe failed
	 */
	private async probeHostname(config: SshRemoteConfig): Promise<string | undefined> {
		try {
			const args = this.buildSshArgs(config);
			args.push('hostname');
			const result = await this.deps.execSsh('ssh', args);
			if (result.exitCode !== 0) {
				return undefined;
			}
			return result.stdout.trim().split('\n')[0]?.trim() || undefined;
		} catch {
			// The caller already has a failure to report; a missing hostname only
			// costs the error message some specificity.
			return undefined;
		}
	}

	/**
	 * Build SSH command-line arguments for a remote connection.
	 *
	 * Constructs the argument array needed for spawning SSH with
	 * proper authentication and connection options.
	 *
	 * When config.useSshConfig is true, the arguments are minimal,
	 * allowing SSH to use settings from ~/.ssh/config.
	 *
	 * @param config The SSH remote configuration
	 * @returns Array of SSH command-line arguments
	 */
	buildSshArgs(config: SshRemoteConfig): string[] {
		// Delegates so the connection this tests is byte-identical to the one an
		// agent spawn opens. See src/shared/sshConnection.ts.
		return buildSshConnectionArgs(config);
	}

	/**
	 * Parse SSH error messages to provide user-friendly descriptions.
	 *
	 * @param stderr The stderr output from SSH
	 * @returns Human-readable error message, or undefined if not recognized
	 */
	private parseSSHError(stderr: string): string | undefined {
		// Shared so the CLI's test verb names a failure exactly as the app does.
		return describeSshConnectionError(stderr);
	}
}

/**
 * Singleton instance of SshRemoteManager.
 * Use this for all SSH remote operations.
 */
export const sshRemoteManager = new SshRemoteManager();
