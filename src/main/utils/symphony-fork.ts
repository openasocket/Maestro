import { execFileNoThrow } from './execFile';
import { logger } from './logger';
import { getExpandedEnv } from '../agents/path-prober';
import { resolveGhPath } from './cliDetection';

const LOG_CONTEXT = '[SymphonyFork]';

export interface ForkSetupResult {
	isFork: boolean;
	forkSlug?: string;
	error?: string;
}

export interface ForkSetupOptions {
	/**
	 * Held right before `gh repo fork` runs (MRC-09-05): a non-null answer is
	 * the refusal, by name, and ends the setup with it as the error before the
	 * fork or any remote change. Never called when no fork is needed.
	 */
	beforeFork?: () => Promise<string | null>;
	/**
	 * Held right before EACH remote reconfiguration that follows a fork
	 * (MCOMP-21-10): the rename of origin to upstream, the set-url fallback,
	 * the add of the fork as origin and the set-head that reads it. A
	 * permitted fork grants none of them: each is its own fresh hold, with the
	 * effect and resource `forkRemoteChange()` names, and a non-null answer
	 * ends the setup with it before that command runs. Required whenever
	 * `beforeFork` is given: a managed setup with no remote-change hold
	 * refuses before any change.
	 */
	beforeRemoteChange?: (change: ForkRemoteChange) => Promise<string | null>;
	/**
	 * The URL origin was cloned from. With `beforeRemoteChange`, every step
	 * first re-reads the remote it acts on and refuses when it no longer names
	 * what the setup expects (origin, then upstream, is this URL; origin is the
	 * fork after the add), so a remote changed across the awaits is never
	 * renamed or overwritten.
	 */
	expectedOrigin?: string;
}

/** One post-fork remote reconfiguration, as the repository ceiling holds it. */
export type ForkRemoteStep = 'rename' | 'set-url' | 'add' | 'set-head';

export interface ForkRemoteChange {
	step: ForkRemoteStep;
	/**
	 * `rename` is a local configuration write (`commit`, local, as the shared
	 * git executor classifies `git remote`); `set-url` and `add` point origin
	 * at the fork, so they are held as `fork` against that destination; `set-head -a`
	 * reads the fork (`clone`, the fetch class) against it.
	 */
	effect: 'commit' | 'fork' | 'clone';
	resource: 'local' | 'remote';
	/** The destination a remote-held step reaches; null for a local one. */
	remote: string | null;
}

/** How each post-fork step is held: separate remote effects from the local configuration write. */
export function forkRemoteChange(step: ForkRemoteStep, forkCloneUrl: string): ForkRemoteChange {
	switch (step) {
		case 'rename':
			return { step, effect: 'commit', resource: 'local', remote: null };
		case 'set-head':
			return { step, effect: 'clone', resource: 'remote', remote: forkCloneUrl };
		default:
			return { step, effect: 'fork', resource: 'remote', remote: forkCloneUrl };
	}
}

/**
 * Ensures the user has push access to the repo, forking if necessary.
 * Reconfigures git remotes so `origin` points to the user's fork
 * and `upstream` points to the original repo.
 */
export async function ensureForkSetup(
	repoPath: string,
	repoSlug: string,
	options?: ForkSetupOptions
): Promise<ForkSetupResult> {
	const env = getExpandedEnv();
	const ghCommand = await resolveGhPath();

	// 1. Get authenticated GitHub user
	logger.info('Checking GitHub authentication', LOG_CONTEXT);
	const userResult = await execFileNoThrow(
		ghCommand,
		['api', 'user', '--jq', '.login'],
		undefined,
		env
	);
	if (userResult.exitCode !== 0) {
		logger.error('GitHub CLI not authenticated', LOG_CONTEXT, { stderr: userResult.stderr });
		return { isFork: false, error: 'GitHub CLI not authenticated' };
	}
	const ghUser = userResult.stdout.trim();

	// 2. Check if user owns the repo
	const [owner, repoName] = repoSlug.split('/');
	if (owner === ghUser) {
		logger.info('User owns the repo, no fork needed', LOG_CONTEXT);
		return { isFork: false };
	}

	// 3. Check push access
	logger.info(`Checking push access to ${repoSlug}`, LOG_CONTEXT);
	const accessResult = await execFileNoThrow(
		ghCommand,
		['api', `repos/${repoSlug}`, '--jq', '.permissions.push'],
		undefined,
		env
	);
	if (accessResult.exitCode === 0 && accessResult.stdout.trim() === 'true') {
		logger.info('User has push access, no fork needed', LOG_CONTEXT);
		return { isFork: false };
	}

	// 4. Fork the repo (idempotent). A managed host holds the fork here, the
	// one place the publication happens, after the access checks above.
	const refusal = (await options?.beforeFork?.()) ?? null;
	if (refusal) {
		logger.warn('Fork refused before it ran', LOG_CONTEXT, { repoSlug });
		return { isFork: false, error: refusal };
	}
	logger.info(`Forking ${repoSlug}`, LOG_CONTEXT);
	const forkResult = await execFileNoThrow(
		ghCommand,
		['repo', 'fork', repoSlug, '--clone=false'],
		undefined,
		env
	);
	if (forkResult.exitCode !== 0) {
		// gh repo fork returns non-zero if fork already exists but prints to stderr - check for that
		const alreadyExists = forkResult.stderr.includes('already exists');
		if (!alreadyExists) {
			logger.error('Failed to fork repo', LOG_CONTEXT, { stderr: forkResult.stderr });
			return { isFork: false, error: `Failed to fork repo: ${forkResult.stderr}` };
		}
		logger.info('Fork already exists', LOG_CONTEXT);
	}

	// 5. Get fork clone URL
	const forkSlug = `${ghUser}/${repoName}`;
	logger.info(`Getting clone URL for ${forkSlug}`, LOG_CONTEXT);
	const urlResult = await execFileNoThrow(
		ghCommand,
		['api', `repos/${forkSlug}`, '--jq', '.clone_url'],
		undefined,
		env
	);
	if (urlResult.exitCode !== 0) {
		logger.error('Failed to get fork clone URL', LOG_CONTEXT, { stderr: urlResult.stderr });
		return { isFork: false, error: `Failed to get fork clone URL: ${urlResult.stderr}` };
	}
	const forkCloneUrl = urlResult.stdout.trim();

	// 6. Reconfigure remotes. Under management each command is held by itself
	// right before it runs, after the remote it acts on is read again.
	const holdStep = async (
		step: ForkRemoteStep,
		check: { name: string; expected: string | undefined }
	): Promise<string | null> => {
		const hook = options?.beforeRemoteChange;
		if (!options?.beforeFork && !hook) return null;
		if (!hook) return 'the remote change after the fork has no managed hold; nothing was changed';
		if (check.expected !== undefined) {
			const read = await execFileNoThrow('git', ['remote', 'get-url', check.name], repoPath);
			const now = read.exitCode === 0 ? read.stdout.trim() : null;
			if (now !== check.expected) {
				logger.warn('Remote changed across the fork setup; the step was refused', LOG_CONTEXT, {
					step,
					remote: check.name,
				});
				return `the ${check.name} remote no longer names the repository this setup expects; the ${step} step was refused`;
			}
		}
		return hook(forkRemoteChange(step, forkCloneUrl));
	};
	const source = options?.expectedOrigin;
	logger.info('Reconfiguring git remotes', LOG_CONTEXT);
	const renameRefused = await holdStep('rename', { name: 'origin', expected: source });
	if (renameRefused) return { isFork: false, error: renameRefused };
	const renameResult = await execFileNoThrow(
		'git',
		['remote', 'rename', 'origin', 'upstream'],
		repoPath
	);
	if (renameResult.exitCode !== 0) {
		// Fallback: upstream already exists, just set origin URL
		logger.warn('Could not rename origin to upstream, trying set-url fallback', LOG_CONTEXT, {
			stderr: renameResult.stderr,
		});
		const setUrlRefused = await holdStep('set-url', { name: 'origin', expected: source });
		if (setUrlRefused) return { isFork: false, error: setUrlRefused };
		const setUrlResult = await execFileNoThrow(
			'git',
			['remote', 'set-url', 'origin', forkCloneUrl],
			repoPath
		);
		if (setUrlResult.exitCode !== 0) {
			logger.error('Failed to set origin URL', LOG_CONTEXT, { stderr: setUrlResult.stderr });
			return { isFork: false, error: `Failed to reconfigure remotes: ${setUrlResult.stderr}` };
		}
	} else {
		const addRefused = await holdStep('add', { name: 'upstream', expected: source });
		if (addRefused) return { isFork: false, error: addRefused };
		const addResult = await execFileNoThrow(
			'git',
			['remote', 'add', 'origin', forkCloneUrl],
			repoPath
		);
		if (addResult.exitCode !== 0) {
			logger.error('Failed to add origin remote', LOG_CONTEXT, { stderr: addResult.stderr });
			return { isFork: false, error: `Failed to add origin remote: ${addResult.stderr}` };
		}
	}

	// Set HEAD for origin so getDefaultBranch() works correctly with fork remotes
	const setHeadRefused = await holdStep('set-head', { name: 'origin', expected: forkCloneUrl });
	if (setHeadRefused) return { isFork: false, error: setHeadRefused };
	await execFileNoThrow('git', ['remote', 'set-head', 'origin', '-a'], repoPath);

	logger.info(`Fork setup complete: ${forkSlug}`, LOG_CONTEXT);
	return { isFork: true, forkSlug };
}
