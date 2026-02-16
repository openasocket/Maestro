/**
 * Training state persistence for resumable GRPO training loops.
 *
 * State is saved to <configDir>/grpo/training-state/<projectHash>.json
 * after each rollout group completes. On resume, the loop skips
 * already-completed tasks in the current epoch.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger';
import type { GRPOConfig, EpochStats } from '../../shared/grpo-types';

const LOG_CONTEXT = '[TrainingState]';

export interface TrainingState {
	projectPath: string;
	config: GRPOConfig;
	currentEpoch: number;
	completedTasks: number;
	epochStats: EpochStats[];
	startedAt: number;
	lastCheckpointAt: number;
}

/**
 * Hash a project path to a stable, filesystem-safe key.
 */
function projectPathToHash(projectPath: string): string {
	return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

/** Get the state file path for a project */
function getStatePath(projectPath: string, configDir: string): string {
	const hash = projectPathToHash(projectPath);
	return path.join(configDir, 'grpo', 'training-state', `${hash}.json`);
}

/**
 * Save training state checkpoint to disk.
 * Uses atomic write (write to temp, then rename) for crash safety.
 */
export async function saveTrainingState(
	state: TrainingState,
	configDir: string,
): Promise<void> {
	const statePath = getStatePath(state.projectPath, configDir);
	const stateDir = path.dirname(statePath);
	const tmpPath = `${statePath}.tmp`;

	await fs.mkdir(stateDir, { recursive: true });

	state.lastCheckpointAt = Date.now();
	await fs.writeFile(tmpPath, JSON.stringify(state, null, '\t'), 'utf-8');
	await fs.rename(tmpPath, statePath);

	logger.debug(
		`Training state saved: epoch=${state.currentEpoch}, tasks=${state.completedTasks}`,
		LOG_CONTEXT,
	);
}

/**
 * Load training state from a previous run.
 * Returns null if no state exists or the state is corrupted.
 */
export async function loadTrainingState(
	projectPath: string,
	configDir: string,
): Promise<TrainingState | null> {
	const statePath = getStatePath(projectPath, configDir);

	try {
		const raw = await fs.readFile(statePath, 'utf-8');
		const state: TrainingState = JSON.parse(raw);

		// Validate basic structure
		if (!state.projectPath || typeof state.currentEpoch !== 'number') {
			logger.warn('Corrupted training state file, ignoring', LOG_CONTEXT);
			return null;
		}

		logger.info(
			`Loaded training state: epoch=${state.currentEpoch}, tasks=${state.completedTasks}`,
			LOG_CONTEXT,
		);
		return state;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		logger.warn(`Failed to load training state: ${err}`, LOG_CONTEXT);
		return null;
	}
}

/**
 * Clear training state for a project (after successful completion or manual reset).
 */
export async function clearTrainingState(
	projectPath: string,
	configDir: string,
): Promise<void> {
	const statePath = getStatePath(projectPath, configDir);

	try {
		await fs.unlink(statePath);
		logger.info(`Training state cleared for ${projectPath}`, LOG_CONTEXT);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger.warn(`Failed to clear training state: ${err}`, LOG_CONTEXT);
		}
	}
}
