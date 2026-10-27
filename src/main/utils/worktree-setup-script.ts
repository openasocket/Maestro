/**
 * Worktree post-create setup script runner.
 *
 * Runs a user-configured shell command inside a freshly created git worktree so
 * per-machine bootstrap work (copying `.env.local` in, running `setup.sh`,
 * installing dependencies) happens automatically instead of by hand.
 *
 * The command comes from the agent's own worktree configuration - the user typed
 * it in the Worktree Configuration modal - so shell interpretation is the point,
 * not an injection vector. Nothing is ever read from the repository itself.
 *
 * Under management the script is a user-authored shell command for a
 * repository, so it runs only when the repository ceiling admits the
 * `setup-script` effect for the caller and that repository (MRC2-04-03). The
 * hold sits before the shell starts, on this machine or over SSH; a refusal
 * skips the script (`skipped: true`, nothing executed) and names its reason in
 * `error`, which the renderer shows as a notice. The worktree itself was
 * created by the caller before this runs and stays. Standalone, nothing is
 * held and no extra call is made.
 */

import { execFileNoThrow } from './execFile';
import { execShellRemote, holdWorktreeSetupScript } from './remote-git';
import type { GitExecutionTarget } from '../enterprise/repository-policy';
import { getShellPath } from '../runtime/getShellPath';
import { buildSpawnPath } from './spawnPath';
import { isWindows } from '../../shared/platformDetection';
import { logger } from './logger';
import type { SshRemoteConfig } from '../../shared/types';

const LOG_CONTEXT = '[WorktreeSetup]';

/**
 * Hard ceiling on script runtime. A setup script that blocks on input (or waits
 * on a lock forever) would otherwise leave the new agent wedged with no signal.
 */
export const WORKTREE_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/** Longest stdout/stderr tail handed back to the renderer for toasts and logs. */
const MAX_OUTPUT_CHARS = 4000;

/** Context handed to the script as environment variables. */
export interface WorktreeSetupContext {
	/** Absolute path of the newly created worktree (the script's cwd) */
	worktreePath: string;
	/** Branch checked out in the new worktree */
	branchName: string;
	/** Absolute path of the main repository the worktree was created from */
	mainRepoPath: string;
	/** Branch the new branch was based on, when the caller specified one */
	baseBranch?: string;
}

export interface WorktreeSetupScriptResult {
	/** True when the script ran and exited 0 */
	success: boolean;
	/** False when no script was configured, or the managed ceiling refused it (nothing was executed) */
	ran: boolean;
	/**
	 * True when a script was configured but the managed repository ceiling
	 * refused it, so it was skipped: `error` names the reason by code and
	 * `exitCode` is the executor's refusal code. Never set standalone.
	 */
	skipped?: true;
	/** Process exit code, or a string error code when it couldn't be spawned */
	exitCode?: number | string;
	stdout: string;
	stderr: string;
	/** Human-readable failure reason, set when success is false */
	error?: string;
}

/** Trim long output to a tail - the last lines are the ones that explain a failure. */
function tail(output: string): string {
	if (output.length <= MAX_OUTPUT_CHARS) return output;
	return `...(truncated)\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

/**
 * Environment variables exposed to the setup script, so a single script can
 * serve every worktree instead of hard-coding paths.
 */
export function buildSetupScriptEnv(context: WorktreeSetupContext): Record<string, string> {
	const env: Record<string, string> = {
		MAESTRO_WORKTREE_PATH: context.worktreePath,
		MAESTRO_WORKTREE_BRANCH: context.branchName,
		MAESTRO_MAIN_REPO_PATH: context.mainRepoPath,
	};
	if (context.baseBranch) {
		env.MAESTRO_BASE_BRANCH = context.baseBranch;
	}
	return env;
}

/**
 * Shell used to interpret the configured command. `cmd.exe /d /s /c` on Windows,
 * the user's login shell (falling back to `/bin/sh`) everywhere else.
 */
export function resolveSetupShell(): { command: string; args: (script: string) => string[] } {
	if (isWindows()) {
		return {
			command: process.env.ComSpec || 'cmd.exe',
			args: (script) => ['/d', '/s', '/c', script],
		};
	}
	return {
		command: process.env.SHELL || '/bin/sh',
		args: (script) => ['-c', script],
	};
}

/**
 * Run the configured post-create setup script in a worktree.
 *
 * @param script Shell command to run; blank/whitespace means "not configured"
 * @param context Worktree paths and branch names, exposed as MAESTRO_* env vars
 * @param sshRemote When set, the worktree lives on a remote host and the script
 *                  runs there over SSH instead of locally
 */
export async function runWorktreeSetupScript(
	script: string | undefined,
	context: WorktreeSetupContext,
	sshRemote?: SshRemoteConfig | null
): Promise<WorktreeSetupScriptResult> {
	const trimmed = (script ?? '').trim();
	if (!trimmed) {
		return { success: true, ran: false, stdout: '', stderr: '' };
	}

	// Held before any shell starts, where the script would run. The worktree
	// is the repository the ceiling names (its origin is read there, unheld).
	const target: GitExecutionTarget = sshRemote
		? { kind: 'ssh', remote: sshRemote, cwd: context.worktreePath }
		: { kind: 'local', cwd: context.worktreePath };
	const refused = await holdWorktreeSetupScript(target);
	if (refused) {
		logger.warn(
			`Worktree setup script skipped by the managed repository ceiling in ${context.worktreePath}`,
			LOG_CONTEXT
		);
		return {
			success: false,
			ran: false,
			skipped: true,
			exitCode: refused.exitCode,
			stdout: '',
			stderr: '',
			error: refused.stderr,
		};
	}

	const env = buildSetupScriptEnv(context);

	logger.info(
		`Running worktree setup script in ${context.worktreePath}${sshRemote ? ' (remote)' : ''}`,
		LOG_CONTEXT
	);

	let result;
	if (sshRemote) {
		result = await execShellRemote(trimmed, sshRemote, {
			cwd: context.worktreePath,
			env,
			timeoutMs: WORKTREE_SETUP_TIMEOUT_MS,
		});
	} else {
		const shell = resolveSetupShell();
		result = await execFileNoThrow(shell.command, shell.args(trimmed), context.worktreePath, {
			timeout: WORKTREE_SETUP_TIMEOUT_MS,
			// GUI-launched Electron gets a truncated PATH on macOS, so tools the
			// script expects (node, npm, pnpm) would be missing. Same treatment
			// git:createPR gives the gh CLI.
			env: { ...process.env, ...env, PATH: await resolveLocalPath() },
		});
	}

	const stdout = tail(result.stdout ?? '');
	const stderr = tail(result.stderr ?? '');

	if (result.exitCode === 0) {
		return { success: true, ran: true, exitCode: 0, stdout, stderr };
	}

	logger.warn(
		`Worktree setup script failed (exit ${result.exitCode}) in ${context.worktreePath}`,
		LOG_CONTEXT
	);

	return {
		success: false,
		ran: true,
		exitCode: result.exitCode,
		stdout,
		stderr,
		error:
			result.exitCode === 'ETIMEDOUT'
				? `Setup script timed out after ${WORKTREE_SETUP_TIMEOUT_MS / 1000}s`
				: stderr.trim() || `Setup script exited with code ${result.exitCode}`,
	};
}

/**
 * Login-shell PATH, falling back to the expanded spawn PATH when the probe
 * fails. Never the bare process PATH: a Dock/Finder launch inherits launchd's
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which has no Homebrew (#1573). A missing
 * PATH would break most setup scripts, so this never throws.
 */
async function resolveLocalPath(): Promise<string> {
	try {
		const shellPath = await getShellPath();
		if (shellPath) return shellPath;
	} catch {
		// Probe failed or timed out - fall through to the expanded PATH.
	}
	return buildSpawnPath();
}
