/**
 * Symphony Runner Service
 *
 * Orchestrates contributions using Auto Run with draft PR claiming.
 */

import path from 'path';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { execFileNoThrow } from '../utils/execFile';
import { ensureForkSetup } from '../utils/symphony-fork';
import { resolveGhPath } from '../utils/cliDetection';
import type { DocumentReference } from '../../shared/symphony-types';
import { PLAYBOOKS_DIR } from '../../shared/maestro-paths';
import { captureException } from '../utils/sentry';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';
import {
	toSafeDocumentFileName,
	uniqueDocumentFileName,
	SYMPHONY_DOCUMENT_FETCH_TIMEOUT_MS,
} from '../ipc/handlers/symphony/shared';
import {
	repositoryRemoteOrigin,
	repositorySlugFromRemote,
	type RepositoryEffectActor,
	type RepositoryEffectAuthority,
	type RepositoryEffectDecision,
	type RepositoryEffectKind,
	type RepositoryEffectReceipt,
	type RepositoryEffectRequest,
} from '../enterprise/repository-policy';
import { getActingTransport, transportSpawnActor } from '../web-server/auth/transport-actor';

const LOG_CONTEXT = '[SymphonyRunner]';

/**
 * What a caller hands the runner to hold every repository effect against
 * (MRC-09-05). Absent, or with a null authority, the runner is standalone and
 * runs byte-for-byte as before. The actor defaults to the transport the call
 * was admitted over, read from the call's own context, never the caller's word.
 */
export interface SymphonyRepositoryGate {
	authority: RepositoryEffectAuthority | null;
	actor?: RepositoryEffectActor;
}

interface RepositoryHold {
	hold(
		effect: RepositoryEffectKind,
		resource: RepositoryEffectRequest['resource'],
		repository: string | null,
		remote: string | null
	): RepositoryEffectDecision;
	/** Every managed answer, in order; empty on a standalone host. */
	receipts: RepositoryEffectReceipt[];
}

type Refused = Extract<RepositoryEffectDecision, { allowed: false }>;

/** Each effect held by itself, right before it runs; a standalone gate answers allowed with no receipt. */
function repositoryHold(gate: SymphonyRepositoryGate | undefined): RepositoryHold {
	const receipts: RepositoryEffectReceipt[] = [];
	const authority = gate?.authority ?? null;
	if (!authority) return { receipts, hold: () => ({ allowed: true }) };
	const actor: RepositoryEffectActor = gate?.actor ?? {
		kind: 'transport',
		actor: transportSpawnActor(getActingTransport()),
	};
	return {
		receipts,
		hold(effect, resource, repository, remote) {
			const decision = authority.authorize({
				surface: 'symphony-runner',
				effect,
				actor,
				resource,
				repository,
				remote,
			});
			if (decision.managed) receipts.push(decision.managed);
			if (!decision.allowed)
				logger.warn('Repository effect refused by the managed ceiling', LOG_CONTEXT, {
					effect,
					code: decision.code,
					repository,
					remote: decision.managed.remote,
				});
			return decision;
		},
	};
}

/** The failure a refused effect becomes: named by code, never a git or gh failure a login would fix. */
const refusal = (decision: Refused): string => `[managed-${decision.code}] ${decision.message}`;

/** The result with the managed receipts on it, or exactly the result on a standalone host. */
function withReceipts<T extends object>(result: T, hold: RepositoryHold): T {
	return hold.receipts.length > 0 ? { ...result, managed: hold.receipts } : result;
}

/** Where a push lands: the fork `ensureForkSetup` pointed origin at (the same forge), or the repository itself. */
function pushDestination(repoUrl: string, forkSlug: string | undefined): string {
	const origin = repositoryRemoteOrigin(repoUrl);
	return forkSlug && origin && origin !== 'file:' ? `${origin}/${forkSlug}.git` : repoUrl;
}

/** The remote a later effect reaches: what origin points at now (the fork after a fork setup). */
async function originRemote(localPath: string): Promise<string | null> {
	const result = await execFileNoThrow('git', ['remote', 'get-url', 'origin'], localPath);
	const url = result.stdout.trim();
	return result.exitCode === 0 && url ? url : null;
}

/**
 * Clean up local repository directory on failure.
 *
 * No provenance check here, unlike symphony:cancel: this runner clones into
 * localPath itself earlier in the same call, so the directory is known to be
 * ours, and a half-finished clone still has to be removable.
 */
async function cleanupLocalRepo(localPath: string): Promise<void> {
	try {
		await fs.rm(localPath, { recursive: true, force: true });
		logger.info('Cleaned up local repository', LOG_CONTEXT, { localPath });
	} catch (error) {
		void captureException(error);
		logger.warn('Failed to cleanup local repository', LOG_CONTEXT, { localPath, error });
	}
}

export interface SymphonyRunnerOptions {
	contributionId: string;
	repoSlug: string;
	repoUrl: string;
	issueNumber: number;
	issueTitle: string;
	documentPaths: DocumentReference[];
	localPath: string;
	branchName: string;
	onProgress?: (progress: { completedDocuments: number; totalDocuments: number }) => void;
	onStatusChange?: (status: string) => void;
	/** The managed repository gate; absent means standalone. */
	gate?: SymphonyRepositoryGate;
}

/**
 * Clone repository to local path (shallow clone for speed).
 */
async function cloneRepo(repoUrl: string, localPath: string): Promise<boolean> {
	logger.info('Cloning repository', LOG_CONTEXT, { repoUrl, localPath });
	const result = await execFileNoThrow('git', ['clone', '--depth=1', repoUrl, localPath]);
	return result.exitCode === 0;
}

/**
 * Create and checkout a new branch.
 */
async function createBranch(localPath: string, branchName: string): Promise<boolean> {
	const result = await execFileNoThrow('git', ['checkout', '-b', branchName], localPath);
	return result.exitCode === 0;
}

/**
 * Configure git user for commits (required for users without global git config).
 */
async function configureGitUser(localPath: string): Promise<boolean> {
	const nameResult = await execFileNoThrow(
		'git',
		['config', 'user.name', 'Maestro Symphony'],
		localPath
	);
	if (nameResult.exitCode !== 0) {
		logger.warn('Failed to set git user.name', LOG_CONTEXT, { error: nameResult.stderr });
		return false;
	}
	const emailResult = await execFileNoThrow(
		'git',
		['config', 'user.email', 'symphony@runmaestro.ai'],
		localPath
	);
	if (emailResult.exitCode !== 0) {
		logger.warn('Failed to set git user.email', LOG_CONTEXT, { error: emailResult.stderr });
		return false;
	}
	return true;
}

/**
 * Create an empty commit to enable pushing without changes.
 */
async function createEmptyCommit(localPath: string, message: string): Promise<boolean> {
	const result = await execFileNoThrow(
		'git',
		['commit', '--allow-empty', '-m', message],
		localPath
	);
	return result.exitCode === 0;
}

/**
 * Push branch to origin.
 */
async function pushBranch(localPath: string, branchName: string): Promise<boolean> {
	const result = await execFileNoThrow('git', ['push', '-u', 'origin', branchName], localPath);
	return result.exitCode === 0;
}

/**
 * Create a draft PR using GitHub CLI.
 */
async function createDraftPR(
	localPath: string,
	issueNumber: number,
	issueTitle: string,
	upstreamSlug?: string,
	forkOwner?: string
): Promise<{ success: boolean; prUrl?: string; prNumber?: number; error?: string }> {
	const title = `[WIP] Symphony: ${issueTitle}`;
	const body = `## Symphony Contribution

This draft PR was created via Maestro Symphony.

Closes #${issueNumber}

---

*Work in progress - will be updated when Auto Run completes*`;

	const args = ['pr', 'create', '--draft', '--title', title, '--body', body];

	if (upstreamSlug) {
		args.push('--repo', upstreamSlug);
	}
	if (upstreamSlug && forkOwner) {
		// For cross-fork PRs, --head must specify the fork owner and branch
		const branchResult = await execFileNoThrow(
			'git',
			['rev-parse', '--abbrev-ref', 'HEAD'],
			localPath
		);
		const branchName = branchResult.stdout.trim();
		if (!branchName || branchResult.exitCode !== 0) {
			return { success: false, error: 'Failed to determine current branch name' };
		}
		args.push('--head', `${forkOwner}:${branchName}`);
	}

	const ghCommand = await resolveGhPath();
	const result = await execFileNoThrow(ghCommand, args, localPath);

	if (result.exitCode !== 0) {
		return { success: false, error: `PR creation failed: ${result.stderr}` };
	}

	const prUrl = result.stdout.trim();
	const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);

	return {
		success: true,
		prUrl,
		prNumber: prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined,
	};
}

/**
 * Download a file from a URL.
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
	try {
		const response = await fetchWithTimeout(url, {}, SYMPHONY_DOCUMENT_FETCH_TIMEOUT_MS);
		if (!response.ok) {
			logger.error('Failed to download file', LOG_CONTEXT, { url, status: response.status });
			return false;
		}
		const buffer = await response.arrayBuffer();
		await fs.writeFile(destPath, Buffer.from(buffer));
		return true;
	} catch (error) {
		void captureException(error);
		logger.error('Error downloading file', LOG_CONTEXT, { url, error });
		return false;
	}
}

/**
 * Copy or download Auto Run documents to local Auto Run Docs folder.
 * Handles both repo-relative paths and external URLs (GitHub attachments).
 */
async function setupAutoRunDocs(
	localPath: string,
	documentPaths: DocumentReference[]
): Promise<string> {
	const autoRunPath = path.posix.join(localPath, PLAYBOOKS_DIR);
	await fs.mkdir(autoRunPath, { recursive: true });

	// Names already written in this batch, so two references that reduce to the
	// same file name do not overwrite each other.
	const usedFileNames = new Set<string>();

	for (const doc of documentPaths) {
		// The name is link text from the issue body, so reduce it to a bare file
		// name before joining it onto the Auto Run docs directory.
		const safeFileName = toSafeDocumentFileName(doc.name);
		if (!safeFileName) {
			logger.warn('Skipping document with unusable name', LOG_CONTEXT, { name: doc.name });
			continue;
		}
		const uniqueFileName = uniqueDocumentFileName(safeFileName, usedFileNames);
		if (!uniqueFileName) {
			logger.warn('Skipping document, cannot find a free file name', LOG_CONTEXT, {
				name: doc.name,
			});
			continue;
		}
		if (uniqueFileName !== safeFileName) {
			logger.info('Renamed document to avoid a name collision', LOG_CONTEXT, {
				name: doc.name,
				to: uniqueFileName,
			});
		}
		const destPath = path.posix.join(autoRunPath, uniqueFileName);

		if (doc.isExternal) {
			// Download external file (GitHub attachment)
			logger.info('Downloading external document', LOG_CONTEXT, { name: doc.name, url: doc.path });
			const success = await downloadFile(doc.path, destPath);
			if (!success) {
				logger.warn('Failed to download document, skipping', LOG_CONTEXT, { name: doc.name });
			}
		} else {
			// Copy from repo using Node.js fs API
			const sourcePath = path.posix.join(localPath, doc.path);
			try {
				await fs.copyFile(sourcePath, destPath);
			} catch (error) {
				logger.warn('Failed to copy document', LOG_CONTEXT, {
					name: doc.name,
					source: sourcePath,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	return autoRunPath;
}

/**
 * Start a Symphony contribution.
 *
 * Flow:
 * 1. Clone the repository (shallow)
 * 2. Create a new branch
 * 3. Create an empty commit
 * 4. Push the branch
 * 5. Create a draft PR (claims the issue via "Closes #N")
 * 6. Set up Auto Run documents
 *
 * Under management (`options.gate`) every step that reaches a remote or
 * changes what will be published is held by itself before it runs: the clone, the branch,
 * the fork (inside `ensureForkSetup`, only when one is needed), the commit,
 * the push (against the fork when origin was pointed at one) and the draft
 * PR. A refusal after the clone removes the clone like any other failure and
 * is reported `[managed-<code>]` with the receipts, never as a git failure.
 */
export async function startContribution(options: SymphonyRunnerOptions): Promise<{
	success: boolean;
	draftPrUrl?: string;
	draftPrNumber?: number;
	autoRunPath?: string;
	isFork?: boolean;
	forkSlug?: string;
	error?: string;
	managed?: RepositoryEffectReceipt[];
}> {
	const {
		repoSlug,
		repoUrl,
		localPath,
		branchName,
		issueNumber,
		issueTitle,
		documentPaths,
		onStatusChange,
	} = options;
	const gate = repositoryHold(options.gate);
	const refused = (decision: Refused) =>
		withReceipts({ success: false, error: refusal(decision) }, gate);

	try {
		// 1. Clone
		const cloneHold = gate.hold('clone', 'remote', repoSlug, repoUrl);
		if (!cloneHold.allowed) return refused(cloneHold);
		onStatusChange?.('cloning');
		if (!(await cloneRepo(repoUrl, localPath))) {
			return withReceipts({ success: false, error: 'Clone failed' }, gate);
		}

		// 2. Create branch
		onStatusChange?.('setting_up');
		const branchHold = gate.hold('branch', 'local', repoSlug, null);
		if (!branchHold.allowed) {
			await cleanupLocalRepo(localPath);
			return refused(branchHold);
		}
		if (!(await createBranch(localPath, branchName))) {
			await cleanupLocalRepo(localPath);
			return withReceipts({ success: false, error: 'Branch creation failed' }, gate);
		}

		// 2.5. Fork setup - detect if user needs a fork for push access. The
		// fork itself is held where it happens, right before `gh repo fork`.
		logger.info('Checking fork requirements', LOG_CONTEXT, { repoSlug });
		const forkGate: { refused: Refused | null } = { refused: null };
		const forkResult = options.gate?.authority
			? await ensureForkSetup(localPath, repoSlug, {
					beforeFork: async () => {
						const decision = gate.hold('fork', 'remote', repoSlug, repoUrl);
						forkGate.refused = decision.allowed ? null : decision;
						return forkGate.refused ? refusal(forkGate.refused) : null;
					},
				})
			: await ensureForkSetup(localPath, repoSlug);
		if (forkResult.error) {
			await cleanupLocalRepo(localPath);
			if (forkGate.refused) return refused(forkGate.refused);
			return withReceipts(
				{ success: false, error: `Fork setup failed: ${forkResult.error}` },
				gate
			);
		}
		if (forkResult.isFork) {
			logger.info('Using fork for contribution', LOG_CONTEXT, {
				forkSlug: forkResult.forkSlug,
				upstreamSlug: repoSlug,
			});
		} else {
			logger.info('User has push access, no fork needed', LOG_CONTEXT, { repoSlug });
		}

		// 2.6. Configure git user for commits
		await configureGitUser(localPath);

		// 3. Empty commit
		const commitHold = gate.hold('commit', 'local', repoSlug, null);
		if (!commitHold.allowed) {
			await cleanupLocalRepo(localPath);
			return refused(commitHold);
		}
		const commitMessage = `[Symphony] Start contribution for #${issueNumber}`;
		if (!(await createEmptyCommit(localPath, commitMessage))) {
			await cleanupLocalRepo(localPath);
			return withReceipts({ success: false, error: 'Empty commit failed' }, gate);
		}

		// 4. Push branch (to the fork when origin now points at one)
		const pushHold = gate.hold(
			'push',
			'remote',
			repoSlug,
			pushDestination(repoUrl, forkResult.isFork ? forkResult.forkSlug : undefined)
		);
		if (!pushHold.allowed) {
			await cleanupLocalRepo(localPath);
			return refused(pushHold);
		}
		if (!(await pushBranch(localPath, branchName))) {
			await cleanupLocalRepo(localPath);
			return withReceipts({ success: false, error: 'Push failed' }, gate);
		}

		// 5. Create draft PR (cross-fork if needed)
		const prHold = gate.hold('pull-request', 'remote', repoSlug, repoUrl);
		if (!prHold.allowed) {
			await cleanupLocalRepo(localPath);
			return refused(prHold);
		}
		const forkOwner =
			forkResult.isFork && forkResult.forkSlug ? forkResult.forkSlug.split('/')[0] : undefined;
		if (forkResult.isFork) {
			logger.info('Creating cross-fork draft PR', LOG_CONTEXT, {
				upstreamSlug: repoSlug,
				forkSlug: forkResult.forkSlug,
				branchName,
			});
		}
		const prResult = await createDraftPR(
			localPath,
			issueNumber,
			issueTitle,
			forkResult.isFork ? repoSlug : undefined,
			forkOwner
		);
		if (!prResult.success) {
			await cleanupLocalRepo(localPath);
			return withReceipts({ success: false, error: prResult.error }, gate);
		}

		// 6. Setup Auto Run docs
		const autoRunPath = await setupAutoRunDocs(localPath, documentPaths);

		// Ready - actual Auto Run processing happens via session
		onStatusChange?.('running');

		return withReceipts(
			{
				success: true,
				draftPrUrl: prResult.prUrl,
				draftPrNumber: prResult.prNumber,
				autoRunPath,
				isFork: forkResult.isFork,
				forkSlug: forkResult.forkSlug,
			},
			gate
		);
	} catch (error) {
		await cleanupLocalRepo(localPath);
		return withReceipts(
			{
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error',
			},
			gate
		);
	}
}

/**
 * Finalize a contribution by converting draft PR to ready for review.
 *
 * Under management the commit, the push (against what origin points at now)
 * and the finalization (the PR made ready and rewritten) are each held before
 * they run; the repository is the upstream slug when given, else the one the
 * origin remote names.
 */
export async function finalizeContribution(
	localPath: string,
	prNumber: number,
	issueNumber: number,
	issueTitle: string,
	upstreamSlug?: string,
	gate?: SymphonyRepositoryGate
): Promise<{
	success: boolean;
	prUrl?: string;
	error?: string;
	managed?: RepositoryEffectReceipt[];
}> {
	const hold = repositoryHold(gate);
	const remote = gate?.authority ? await originRemote(localPath) : null;
	const repository = upstreamSlug ?? repositorySlugFromRemote(remote);
	const commitHold = hold.hold('commit', 'local', repository, null);
	if (!commitHold.allowed)
		return withReceipts({ success: false, error: refusal(commitHold) }, hold);

	// Configure git user for commits (in case not already configured)
	await configureGitUser(localPath);

	// Commit all changes
	await execFileNoThrow('git', ['add', '-A'], localPath);

	const commitMessage = `[Symphony] Complete contribution for #${issueNumber}

Processed all Auto Run documents for: ${issueTitle}`;

	const commitResult = await execFileNoThrow('git', ['commit', '-m', commitMessage], localPath);
	if (commitResult.exitCode !== 0 && !commitResult.stderr.includes('nothing to commit')) {
		return withReceipts({ success: false, error: `Commit failed: ${commitResult.stderr}` }, hold);
	}

	// Push changes (origin points to fork if ensureForkSetup ran)
	const pushHold = hold.hold('push', 'remote', repository, remote);
	if (!pushHold.allowed) return withReceipts({ success: false, error: refusal(pushHold) }, hold);
	const pushResult = await execFileNoThrow('git', ['push'], localPath);
	if (pushResult.exitCode !== 0) {
		return withReceipts({ success: false, error: `Push failed: ${pushResult.stderr}` }, hold);
	}

	// Convert draft to ready for review
	const finalizeHold = hold.hold('finalize', 'remote', repository, remote);
	if (!finalizeHold.allowed)
		return withReceipts({ success: false, error: refusal(finalizeHold) }, hold);
	const ghCommand = await resolveGhPath();
	const readyArgs = ['pr', 'ready', prNumber.toString()];
	if (upstreamSlug) readyArgs.push('--repo', upstreamSlug);
	const readyResult = await execFileNoThrow(ghCommand, readyArgs, localPath);
	if (readyResult.exitCode !== 0) {
		return withReceipts(
			{ success: false, error: `Failed to mark PR ready: ${readyResult.stderr}` },
			hold
		);
	}

	// Update PR body with completion summary
	const body = `## Symphony Contribution

This PR was created via Maestro Symphony.

Closes #${issueNumber}

---

**Task:** ${issueTitle}

*Contributed by the Maestro Symphony community* 🎵`;

	const editArgs = ['pr', 'edit', prNumber.toString(), '--body', body];
	if (upstreamSlug) editArgs.push('--repo', upstreamSlug);
	await execFileNoThrow(ghCommand, editArgs, localPath);

	// Get final PR URL
	const viewArgs = ['pr', 'view', prNumber.toString(), '--json', 'url', '-q', '.url'];
	if (upstreamSlug) viewArgs.push('--repo', upstreamSlug);
	const prInfoResult = await execFileNoThrow(ghCommand, viewArgs, localPath);

	return withReceipts(
		{
			success: true,
			prUrl: prInfoResult.stdout.trim(),
		},
		hold
	);
}

/**
 * Cancel a contribution by closing the draft PR and cleaning up.
 *
 * Under management the cancel (the PR closed on the forge, the remote branch
 * deleted) is held before `gh pr close` runs, against what origin points at.
 */
export async function cancelContribution(
	localPath: string,
	prNumber: number,
	cleanup: boolean = true,
	upstreamSlug?: string,
	gate?: SymphonyRepositoryGate
): Promise<{ success: boolean; error?: string; managed?: RepositoryEffectReceipt[] }> {
	const hold = repositoryHold(gate);
	const remote = gate?.authority ? await originRemote(localPath) : null;
	const cancelHold = hold.hold(
		'cancel',
		'remote',
		upstreamSlug ?? repositorySlugFromRemote(remote),
		remote
	);
	if (!cancelHold.allowed)
		return withReceipts({ success: false, error: refusal(cancelHold) }, hold);

	// Close the draft PR
	const ghCommand = await resolveGhPath();
	const closeArgs = ['pr', 'close', prNumber.toString()];
	if (!upstreamSlug) {
		// Only delete branch for non-fork PRs - cross-fork delete-branch fails due to permissions
		closeArgs.push('--delete-branch');
	} else {
		closeArgs.push('--repo', upstreamSlug);
	}
	const closeResult = await execFileNoThrow(ghCommand, closeArgs, localPath);
	if (closeResult.exitCode !== 0) {
		logger.warn('Failed to close PR', LOG_CONTEXT, { prNumber, error: closeResult.stderr });
		return withReceipts(
			{
				success: false,
				error: `Failed to close PR #${prNumber}: ${closeResult.stderr || closeResult.stdout}`,
			},
			hold
		);
	}

	// Clean up local directory using Node.js fs API
	if (cleanup) {
		await cleanupLocalRepo(localPath);
	}

	return withReceipts({ success: true }, hold);
}
