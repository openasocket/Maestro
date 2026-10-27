import { ipcMain } from 'electron';
import { execFileNoThrow } from '../../../utils/execFile';
import { execGit, holdGitForgeEffect } from '../../../utils/remote-git';
import { logger } from '../../../utils/logger';
import { withIpcErrorLogging } from '../../../utils/ipcHandler';
import {
	resolveGhPath,
	getCachedGhStatus,
	setCachedGhStatus,
	getExpandedEnv,
} from '../../../utils/cliDetection';
import { getShellPath } from '../../../runtime/getShellPath';
import { captureMessage } from '../../../utils/sentry';
import { LOG_CONTEXT, handlerOpts } from './shared';

/** Where `gh gist create` publishes: the destination a managed gist is held against. */
const GIST_DESTINATION = 'https://gist.github.com';

/**
 * Register GitHub CLI integration Git IPC handlers: createPR, checkGhCli, createGist.
 */
export function registerGithubHandlers(): void {
	// Create a PR from the worktree branch to a base branch
	// ghPath parameter allows specifying custom path to gh binary
	ipcMain.handle(
		'git:createPR',
		withIpcErrorLogging(
			handlerOpts('createPR'),
			async (
				worktreePath: string,
				baseBranch: string,
				title: string,
				body: string,
				ghPath?: string
			) => {
				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI at: ${ghCommand}`, LOG_CONTEXT);

				// Two effects reach the forge here, the push and the pull request,
				// and under management each is held by itself against the
				// repository ceiling (MRC2-04-02). The pull request is held first,
				// before the push runs, so a draft the ceiling refuses never costs
				// a branch on the remote (Symphony's createDraftPR rule). The push
				// is held by the shared executor when it runs. Standalone, nothing
				// is held and both run exactly as before.
				const prRefused = await holdGitForgeEffect('pull-request', worktreePath);
				if (prRefused) return { success: false, error: prRefused.stderr };

				// Build env with the user's full shell PATH so git hooks
				// (e.g. Husky pre-push running npm) can find Node/npm binaries
				let shellPath: string | null = null;
				try {
					shellPath = (await getShellPath()) || null;
				} catch (error) {
					captureMessage(
						`git:createPR falling back to default PATH: ${error instanceof Error ? error.message : String(error)}`,
						'warning'
					);
				}
				const shellEnv: NodeJS.ProcessEnv | undefined = shellPath
					? { ...process.env, PATH: shellPath }
					: undefined;

				// First, push the current branch to origin (through the shared
				// executor, which layers the extra PATH over this process's env).
				const pushResult = await execGit(
					['push', '-u', 'origin', 'HEAD'],
					worktreePath,
					undefined,
					undefined,
					shellPath ? { env: { PATH: shellPath } } : {}
				);
				if (pushResult.exitCode !== 0) {
					return { success: false, error: `Failed to push branch: ${pushResult.stderr}` };
				}

				// Create the PR using gh CLI
				const prResult = await execFileNoThrow(
					ghCommand,
					['pr', 'create', '--base', baseBranch, '--title', title, '--body', body],
					worktreePath,
					shellEnv
				);

				if (prResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						prResult.stderr.includes('command not found') ||
						prResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create PRs.',
						};
					}
					return { success: false, error: prResult.stderr || 'Failed to create PR' };
				}

				// The PR URL is typically in stdout
				const prUrl = prResult.stdout.trim();
				return { success: true, prUrl };
			}
		)
	);

	// Check if GitHub CLI (gh) is installed and authenticated
	// ghPath parameter allows specifying custom path to gh binary (e.g., /opt/homebrew/bin/gh)
	// Results are cached for 1 minute to avoid repeated subprocess calls
	ipcMain.handle(
		'git:checkGhCli',
		withIpcErrorLogging(handlerOpts('checkGhCli'), async (ghPath?: string) => {
			// Resolve gh CLI path (uses cached detection or custom path). This comes
			// before the cache read because the cached verdict is keyed by the command
			// it was reached against.
			const ghCommand = await resolveGhPath(ghPath);

			// Check cache first (skip if custom path provided)
			if (!ghPath) {
				const cached = getCachedGhStatus(ghCommand);
				if (cached !== null) {
					logger.debug(
						`Using cached gh CLI status: installed=${cached.installed}, authenticated=${cached.authenticated}`,
						LOG_CONTEXT
					);
					return cached;
				}
			}

			logger.debug(`Checking gh CLI at: ${ghCommand}`, LOG_CONTEXT);

			// Check if gh is installed by running gh --version.
			// The expanded env is required, not optional: gh is frequently a shim
			// (asdf, mise, rbenv-style) that re-execs its parent tool, so it only runs
			// if that parent is on PATH. A GUI-launched Electron process does not
			// inherit the user's shell PATH, so probing without it reports a perfectly
			// good install as missing.
			const env = getExpandedEnv();
			const versionResult = await execFileNoThrow(ghCommand, ['--version'], undefined, env);
			if (versionResult.exitCode !== 0) {
				logger.warn(
					`gh CLI not found at ${ghCommand}: exit=${versionResult.exitCode}, stderr=${versionResult.stderr}`,
					LOG_CONTEXT
				);
				const result = { installed: false, authenticated: false };
				if (!ghPath) setCachedGhStatus(ghCommand, false, false);
				return result;
			}
			logger.debug(`gh CLI found: ${versionResult.stdout.trim().split('\n')[0]}`, LOG_CONTEXT);

			// Check if gh is authenticated by running gh auth status
			const authResult = await execFileNoThrow(ghCommand, ['auth', 'status'], undefined, env);
			const authenticated = authResult.exitCode === 0;
			logger.debug(
				`gh auth status: ${authenticated ? 'authenticated' : 'not authenticated'}`,
				LOG_CONTEXT
			);

			// Cache the result (only if not using custom path)
			if (!ghPath) {
				setCachedGhStatus(ghCommand, true, authenticated);
			}

			return { installed: true, authenticated };
		})
	);

	// Create a GitHub Gist from file content
	// Returns the gist URL on success
	ipcMain.handle(
		'git:createGist',
		withIpcErrorLogging(
			handlerOpts('createGist'),
			async (
				filename: string,
				content: string,
				description: string,
				isPublic: boolean,
				ghPath?: string
			) => {
				// A gist is content published under the actor's forge account,
				// outside any repository. Under management it is held against the
				// repository ceiling as the `gist` effect reaching gist.github.com
				// before gh starts; standalone nothing is held (MRC2-04-02).
				const refused = await holdGitForgeEffect('gist', null, GIST_DESTINATION);
				if (refused) return { success: false, error: refused.stderr };

				// Resolve gh CLI path (uses cached detection or custom path)
				const ghCommand = await resolveGhPath(ghPath);
				logger.debug(`Using gh CLI for gist creation at: ${ghCommand}`, LOG_CONTEXT);

				// Create gist using gh CLI with stdin for content
				// gh gist create --filename <name> --desc <desc> [--public] -
				const args = ['gist', 'create', '--filename', filename];
				if (description) {
					args.push('--desc', description);
				}
				if (isPublic) {
					args.push('--public');
				}
				args.push('-'); // Read from stdin

				const gistResult = await execFileNoThrow(ghCommand, args, undefined, {
					input: content,
					env: getExpandedEnv(),
				});

				if (gistResult.exitCode !== 0) {
					// Check if gh CLI is not installed
					if (
						gistResult.stderr.includes('command not found') ||
						gistResult.stderr.includes('not recognized')
					) {
						return {
							success: false,
							error: 'GitHub CLI (gh) is not installed. Please install it to create gists.',
						};
					}
					// Check for authentication issues
					if (
						gistResult.stderr.includes('not logged') ||
						gistResult.stderr.includes('authentication')
					) {
						return {
							success: false,
							error: 'GitHub CLI is not authenticated. Please run "gh auth login" first.',
						};
					}
					return { success: false, error: gistResult.stderr || 'Failed to create gist' };
				}

				// The gist URL is typically in stdout
				const gistUrl = gistResult.stdout.trim();
				logger.info(`${LOG_CONTEXT} Created gist: ${gistUrl}`);
				return { success: true, gistUrl };
			}
		)
	);
}
