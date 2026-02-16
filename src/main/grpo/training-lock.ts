/**
 * File-based training lock. Prevents multiple GRPO training loops
 * from running on the same project simultaneously.
 *
 * Lock file: <configDir>/grpo/training.lock/<projectHash>
 * Contains: { pid: number, startedAt: number, projectPath: string }
 *
 * Stale lock detection: if the PID in the lock file is no longer running,
 * the lock is considered stale and can be overwritten.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[TrainingLock]';

interface LockFileContent {
	pid: number;
	startedAt: number;
	projectPath: string;
}

/**
 * Hash a project path to a stable, filesystem-safe key.
 * Uses the same algorithm as ExperienceStore for consistency.
 */
function projectPathToHash(projectPath: string): string {
	return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

/** Get the lock file path for a project */
function getLockFilePath(projectPath: string, configDir: string): string {
	const hash = projectPathToHash(projectPath);
	return path.join(configDir, 'grpo', 'training.lock', hash);
}

/**
 * Check if a process with the given PID is still running.
 * Uses process.kill(pid, 0) which throws if the process doesn't exist.
 */
function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire a training lock for the given project.
 * Throws if a lock is already held by a running process.
 */
export async function acquireTrainingLock(
	projectPath: string,
	configDir: string,
): Promise<void> {
	const lockPath = getLockFilePath(projectPath, configDir);
	const lockDir = path.dirname(lockPath);

	// Ensure lock directory exists
	await fs.mkdir(lockDir, { recursive: true });

	// Check for existing lock
	try {
		const raw = await fs.readFile(lockPath, 'utf-8');
		const existing: LockFileContent = JSON.parse(raw);

		if (isProcessRunning(existing.pid)) {
			throw new Error(
				`GRPO training loop already running for this project (PID ${existing.pid}, started ${new Date(existing.startedAt).toISOString()})`,
			);
		}

		// Stale lock — process is dead, overwrite it
		logger.info(
			`Overwriting stale training lock (PID ${existing.pid} is no longer running)`,
			LOG_CONTEXT,
		);
	} catch (err) {
		// If we threw our own error, re-throw it
		if (err instanceof Error && err.message.startsWith('GRPO training loop already running')) {
			throw err;
		}
		// Otherwise: lock file doesn't exist or is corrupted — proceed to acquire
	}

	// Write lock file
	const lockContent: LockFileContent = {
		pid: process.pid,
		startedAt: Date.now(),
		projectPath,
	};

	await fs.writeFile(lockPath, JSON.stringify(lockContent, null, '\t'), 'utf-8');
	logger.info(`Training lock acquired for ${projectPath}`, LOG_CONTEXT);
}

/**
 * Release the training lock for the given project.
 * Silently succeeds if no lock exists (idempotent).
 */
export async function releaseTrainingLock(
	projectPath: string,
	configDir: string,
): Promise<void> {
	const lockPath = getLockFilePath(projectPath, configDir);

	try {
		await fs.unlink(lockPath);
		logger.info(`Training lock released for ${projectPath}`, LOG_CONTEXT);
	} catch (err) {
		// Lock file doesn't exist — that's fine
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn(`Failed to release training lock: ${err}`, LOG_CONTEXT);
		}
	}
}

/**
 * Check if a training lock is currently held for the given project.
 * Returns true only if the lock file exists AND the PID is still running.
 */
export async function isTrainingLockHeld(
	projectPath: string,
	configDir: string,
): Promise<boolean> {
	const lockPath = getLockFilePath(projectPath, configDir);

	try {
		const raw = await fs.readFile(lockPath, 'utf-8');
		const existing: LockFileContent = JSON.parse(raw);
		return isProcessRunning(existing.pid);
	} catch {
		return false;
	}
}
