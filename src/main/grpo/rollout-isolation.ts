/**
 * Rollout Isolation — creates isolated working directories for parallel rollouts.
 *
 * Strategy selection (in priority order):
 * 1. git clone --shared: lightweight shared-object clone (best: parallel + isolated)
 * 2. git worktree: parallel worktrees from same repo (good: parallel, some lock contention)
 * 3. Sequential in-place: one rollout at a time (fallback: no parallelism)
 *
 * IMPORTANT: Never use git stash for isolation — it's unsafe when the user
 * might interact with git concurrently, and stash corruption loses work.
 *
 * Isolation directories go in the system temp dir (os.tmpdir()), NOT in the
 * project root. This avoids needing .gitignore modifications and keeps the
 * project tree clean.
 */

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[RolloutIsolation]';

/** Maximum age for leftover rollout directories (1 hour) */
const STALE_DIR_MAX_AGE_MS = 60 * 60 * 1000;

/** Prefix for rollout isolation directories */
const ROLLOUT_DIR_PREFIX = 'grpo-rollout-';

export interface IsolationEnvironment {
	index: number;
	workingDir: string;
	type: 'clone' | 'worktree' | 'in-place';
}

/**
 * Creates isolated working directories for parallel rollouts.
 *
 * Strategy selection:
 * 1. Check for uncommitted changes — if dirty, use 'in-place' (refuse to risk user's work).
 * 2. Try git clone --shared into a temp directory.
 * 3. If clone fails, try git worktree add.
 * 4. If worktree fails, fall back to 'in-place'.
 */
export async function createIsolationEnvironments(
	projectPath: string,
	count: number,
): Promise<IsolationEnvironment[]> {
	// Check for uncommitted changes
	const isDirty = await isWorkingTreeDirty(projectPath);
	if (isDirty) {
		logger.info('Working tree is dirty, using in-place sequential mode', LOG_CONTEXT);
		return Array.from({ length: count }, (_, i) => ({
			index: i,
			workingDir: projectPath,
			type: 'in-place' as const,
		}));
	}

	// Try clone strategy
	const cloneEnvs = await tryCloneStrategy(projectPath, count);
	if (cloneEnvs) return cloneEnvs;

	// Try worktree strategy
	const worktreeEnvs = await tryWorktreeStrategy(projectPath, count);
	if (worktreeEnvs) return worktreeEnvs;

	// Fallback to in-place
	logger.warn('Clone and worktree strategies both failed, falling back to in-place', LOG_CONTEXT);
	return Array.from({ length: count }, (_, i) => ({
		index: i,
		workingDir: projectPath,
		type: 'in-place' as const,
	}));
}

/**
 * Cleans up isolation environments. Always runs, wrapped in try/catch per environment.
 * - clone: rm -rf the temp directory
 * - worktree: git worktree remove --force from the main repo
 * - in-place: no cleanup needed
 */
export async function cleanupIsolationEnvironments(
	environments: IsolationEnvironment[],
	projectPath?: string,
): Promise<void> {
	for (const env of environments) {
		try {
			switch (env.type) {
				case 'clone':
					await fs.rm(env.workingDir, { recursive: true, force: true });
					logger.debug(`Cleaned up clone environment: ${env.workingDir}`, LOG_CONTEXT);
					break;
				case 'worktree':
					if (projectPath) {
						await execCommand(`git worktree remove "${env.workingDir}" --force`, projectPath);
					} else {
						// Fallback: just remove the directory
						await fs.rm(env.workingDir, { recursive: true, force: true });
					}
					logger.debug(`Cleaned up worktree environment: ${env.workingDir}`, LOG_CONTEXT);
					break;
				case 'in-place':
					// No cleanup needed
					break;
			}
		} catch (err) {
			logger.warn(`Failed to clean up environment ${env.index} (${env.type}): ${err}`, LOG_CONTEXT);
		}
	}
}

/**
 * Startup garbage collector: scans the system temp directory for leftover
 * grpo-rollout-* directories older than 1 hour and removes them.
 * Handles the case where the app crashed mid-training.
 */
export async function cleanupStaleRolloutDirs(): Promise<number> {
	const tmpBase = os.tmpdir();
	let cleaned = 0;

	try {
		const entries = await fs.readdir(tmpBase, { withFileTypes: true });
		const now = Date.now();

		for (const entry of entries) {
			if (!entry.isDirectory() || !entry.name.startsWith(ROLLOUT_DIR_PREFIX)) continue;

			const dirPath = path.join(tmpBase, entry.name);
			try {
				const stat = await fs.stat(dirPath);
				const ageMs = now - stat.mtimeMs;

				if (ageMs > STALE_DIR_MAX_AGE_MS) {
					await fs.rm(dirPath, { recursive: true, force: true });
					cleaned++;
					logger.info(`Cleaned stale rollout dir: ${entry.name} (age: ${Math.round(ageMs / 60000)}m)`, LOG_CONTEXT);
				}
			} catch {
				// Skip individual entries that fail
			}
		}
	} catch (err) {
		logger.warn(`Failed to scan for stale rollout dirs: ${err}`, LOG_CONTEXT);
	}

	if (cleaned > 0) {
		logger.info(`Cleaned ${cleaned} stale rollout directories`, LOG_CONTEXT);
	}

	return cleaned;
}

// ─── Strategy Implementations ────────────────────────────────────────────────

async function tryCloneStrategy(
	projectPath: string,
	count: number,
): Promise<IsolationEnvironment[] | null> {
	const environments: IsolationEnvironment[] = [];
	const groupId = Date.now().toString(36);

	try {
		for (let i = 0; i < count; i++) {
			const dirName = `${ROLLOUT_DIR_PREFIX}${groupId}-${i}`;
			const targetPath = path.join(os.tmpdir(), dirName);

			await execCommand(`git clone --shared "${projectPath}" "${targetPath}"`, projectPath);

			environments.push({
				index: i,
				workingDir: targetPath,
				type: 'clone',
			});
		}

		logger.info(`Created ${count} clone isolation environments`, LOG_CONTEXT);
		return environments;
	} catch (err) {
		logger.warn(`Clone strategy failed: ${err}`, LOG_CONTEXT);
		// Clean up any partially created clones
		for (const env of environments) {
			try {
				await fs.rm(env.workingDir, { recursive: true, force: true });
			} catch {
				// Best effort cleanup
			}
		}
		return null;
	}
}

async function tryWorktreeStrategy(
	projectPath: string,
	count: number,
): Promise<IsolationEnvironment[] | null> {
	const environments: IsolationEnvironment[] = [];
	const groupId = Date.now().toString(36);

	try {
		for (let i = 0; i < count; i++) {
			const dirName = `${ROLLOUT_DIR_PREFIX}${groupId}-${i}`;
			const targetPath = path.join(os.tmpdir(), dirName);

			await execCommand(`git worktree add "${targetPath}" HEAD --detach`, projectPath);

			environments.push({
				index: i,
				workingDir: targetPath,
				type: 'worktree',
			});
		}

		logger.info(`Created ${count} worktree isolation environments`, LOG_CONTEXT);
		return environments;
	} catch (err) {
		logger.warn(`Worktree strategy failed: ${err}`, LOG_CONTEXT);
		// Clean up any partially created worktrees
		for (const env of environments) {
			try {
				await execCommand(`git worktree remove "${env.workingDir}" --force`, projectPath);
			} catch {
				try {
					await fs.rm(env.workingDir, { recursive: true, force: true });
				} catch {
					// Best effort cleanup
				}
			}
		}
		return null;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function isWorkingTreeDirty(projectPath: string): Promise<boolean> {
	try {
		const result = await execCommand('git status --porcelain', projectPath);
		return result.trim().length > 0;
	} catch {
		// If git status fails, treat as dirty to be safe
		return true;
	}
}

function execCommand(command: string, cwd: string, timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`Command failed: ${command}\n${stderr || error.message}`));
				return;
			}
			resolve(stdout);
		});

		child.on('error', reject);
	});
}
