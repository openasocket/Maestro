/**
 * SymphonyCollector — collects reward signals from Auto Run playbook execution
 * for later use by the GRPO training loop.
 *
 * IMPORTANT: This is a DATA COLLECTION layer, not a learning layer.
 * It does NOT generate semantic advantages or update the experience library.
 * The paper warns against naive experience generation from single executions.
 *
 * Collected data can be used in two ways:
 * 1. As training tasks for the explicit GRPO training loop (GRPO-08)
 * 2. As matched rollout pairs when the same task is executed multiple times
 *    across different playbook runs (natural rollout accumulation)
 *
 * Storage layout:
 *   <configDir>/grpo/signals/<projectHash>/signals.jsonl
 *   <configDir>/grpo/signals/<projectHash>/index.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import {
	collectAllRewards,
	computeAggregateReward,
	detectProjectCommands,
} from './reward-collector';
import type {
	CollectedSignal,
	BatchCollectionResult,
	CollectionSummary,
	TrainingReadiness,
	SignalIndex,
	SignalIndexEntry,
	GRPOConfig,
	RolloutGroup,
	RolloutOutput,
	SignalRealm,
} from '../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../shared/grpo-types';

const LOG_CONTEXT = '[SymphonyCollector]';
const SIGNAL_INDEX_VERSION = 1;

/**
 * Normalize task content for consistent hashing.
 * Strips leading/trailing whitespace, collapses internal whitespace, lowercases.
 */
export function normalizeTaskContent(content: string): string {
	return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Compute a content hash for matching identical/similar tasks across runs.
 * Uses SHA-256, first 12 hex chars.
 */
export function computeTaskContentHash(content: string): string {
	const normalized = normalizeTaskContent(content);
	return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Produce a stable, filesystem-safe hash of a project path.
 * Returns the first 12 chars of the SHA-256 hex digest.
 */
function projectPathToHash(projectPath: string): string {
	return createHash('sha256').update(projectPath).digest('hex').slice(0, 12);
}

/**
 * SymphonyCollector manages passive signal collection from Auto Run execution.
 * Signals are stored in JSONL files and indexed for task matching.
 */
export class SymphonyCollector {
	private baseDir: string;
	private config: GRPOConfig;
	private writeQueue = new Map<string, Promise<void>>();

	constructor(config: GRPOConfig, baseDirOverride?: string) {
		this.baseDir = baseDirOverride ?? path.join(app.getPath('userData'), 'grpo', 'signals');
		this.config = config;
	}

	/** Update config (e.g., after settings change) */
	setConfig(config: GRPOConfig): void {
		this.config = config;
	}

	/** Initialize — create base directory */
	async initialize(): Promise<void> {
		await fs.mkdir(this.baseDir, { recursive: true });
		logger.debug('Symphony collector initialized', LOG_CONTEXT);
	}

	// ─── Path Helpers ────────────────────────────────────────────────────

	private getProjectDir(projectPath: string): string {
		return path.join(this.baseDir, projectPathToHash(projectPath));
	}

	private getSignalsPath(projectPath: string): string {
		return path.join(this.getProjectDir(projectPath), 'signals.jsonl');
	}

	private getIndexPath(projectPath: string): string {
		return path.join(this.getProjectDir(projectPath), 'index.json');
	}

	// ─── Serialized Writes ───────────────────────────────────────────────

	private async serializedWrite<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
		const key = projectPathToHash(projectPath);
		const prev = this.writeQueue.get(key) ?? Promise.resolve();
		let result: T;
		const next = prev.then(async () => { result = await fn(); });
		this.writeQueue.set(key, next.catch(() => {}));
		await next;
		return result!;
	}

	// ─── Index Operations ────────────────────────────────────────────────

	private async readIndex(projectPath: string): Promise<SignalIndex> {
		const indexPath = this.getIndexPath(projectPath);
		try {
			const data = await fs.readFile(indexPath, 'utf-8');
			return JSON.parse(data) as SignalIndex;
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return { version: SIGNAL_INDEX_VERSION, entries: {} };
			}
			logger.warn(`Failed to read signal index: ${err}`, LOG_CONTEXT);
			captureException(err, { operation: 'symphony:readIndex', projectPath });
			return { version: SIGNAL_INDEX_VERSION, entries: {} };
		}
	}

	private async writeIndex(projectPath: string, index: SignalIndex): Promise<void> {
		const indexPath = this.getIndexPath(projectPath);
		const tmpPath = indexPath + '.tmp';
		await fs.writeFile(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
		await fs.rename(tmpPath, indexPath);
	}

	// ─── Signal Storage ──────────────────────────────────────────────────

	private async appendSignal(projectPath: string, signal: CollectedSignal): Promise<void> {
		const signalsPath = this.getSignalsPath(projectPath);
		await fs.appendFile(signalsPath, JSON.stringify(signal) + '\n', 'utf-8');
	}

	private async readAllSignals(projectPath: string): Promise<CollectedSignal[]> {
		const signalsPath = this.getSignalsPath(projectPath);
		try {
			const data = await fs.readFile(signalsPath, 'utf-8');
			const lines = data.trim().split('\n').filter(line => line.length > 0);
			return lines.map(line => JSON.parse(line) as CollectedSignal);
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			logger.warn(`Failed to read signals: ${err}`, LOG_CONTEXT);
			captureException(err, { operation: 'symphony:readSignals', projectPath });
			return [];
		}
	}

	// ─── Public API ──────────────────────────────────────────────────────

	/**
	 * Called when an Auto Run task completes (either success or failure).
	 * Collects reward signals and stores them in the signal database.
	 */
	async onTaskComplete(
		taskContent: string,
		projectPath: string,
		agentType: string,
		sessionId: string,
		exitCode: number,
		output: string,
		durationMs: number,
		documentPath: string,
		realm: SignalRealm = 'autorun',
	): Promise<CollectedSignal> {
		return this.serializedWrite(projectPath, async () => {
			// Ensure project directory exists
			await fs.mkdir(this.getProjectDir(projectPath), { recursive: true });

			// Collect reward signals
			const commands = await detectProjectCommands(projectPath);
			const rewards = await collectAllRewards(
				projectPath,
				exitCode,
				output,
				this.config,
				commands,
			);
			const aggregateReward = computeAggregateReward(rewards, this.config.rewardWeights);

			const taskContentHash = computeTaskContentHash(taskContent);
			const now = Date.now();

			const signal: CollectedSignal = {
				taskContent,
				taskContentHash,
				rewards,
				aggregateReward,
				agentType,
				sessionId,
				durationMs,
				collectedAt: now,
				documentPath,
				projectPath,
				realm,
			};

			// Append signal to JSONL
			await this.appendSignal(projectPath, signal);

			// Update index
			const index = await this.readIndex(projectPath);
			const existing = index.entries[taskContentHash];
			if (existing) {
				existing.executionCount += 1;
				existing.latestReward = aggregateReward;
				existing.lastSeen = now;
			} else {
				index.entries[taskContentHash] = {
					taskContentHash,
					normalizedContent: normalizeTaskContent(taskContent),
					executionCount: 1,
					latestReward: aggregateReward,
					firstSeen: now,
					lastSeen: now,
				};
			}
			await this.writeIndex(projectPath, index);

			logger.debug(
				`Collected signal for task ${taskContentHash} (reward: ${aggregateReward.toFixed(3)})`,
				LOG_CONTEXT,
			);

			return signal;
		});
	}

	/**
	 * Called when all tasks in a document complete.
	 * Currently a no-op hook for future per-document aggregation.
	 */
	async onDocumentComplete(
		_documentPath: string,
		_projectPath: string,
		_taskResults: CollectedSignal[],
	): Promise<void> {
		// Per-document aggregation is a future enhancement.
		// The signal index already tracks cross-document task matching.
	}

	/**
	 * Called when the entire batch run completes.
	 * Generates a collection summary and checks if enough data
	 * has accumulated for a training run.
	 */
	async onBatchComplete(
		projectPath: string,
		batchResults: BatchCollectionResult[],
	): Promise<CollectionSummary> {
		const allSignals = batchResults.flatMap(r => r.signals);
		const meanTaskReward = allSignals.length > 0
			? allSignals.reduce((sum, s) => sum + s.aggregateReward, 0) / allSignals.length
			: 0;

		// Read index to count matched pairs
		const index = await this.readIndex(projectPath);
		let matchedPairCount = 0;
		for (const entry of Object.values(index.entries)) {
			if (entry.executionCount >= 2) {
				matchedPairCount++;
			}
		}

		const summary: CollectionSummary = {
			documentsProcessed: batchResults.length,
			signalsCollected: allSignals.length,
			meanTaskReward,
			matchedPairCount,
			trainingRecommended: matchedPairCount >= 5,
		};

		logger.info(
			`Batch complete: ${summary.signalsCollected} signals, ${summary.matchedPairCount} matched pairs` +
			(summary.trainingRecommended ? ' — training recommended' : ''),
			LOG_CONTEXT,
		);

		return summary;
	}

	/**
	 * Checks if enough matched rollout pairs exist to trigger
	 * a proper GRPO training run.
	 */
	async getTrainingReadiness(projectPath: string): Promise<TrainingReadiness> {
		const index = await this.readIndex(projectPath);
		const minGroupSize = this.config.rolloutGroupSize;

		const matchedEntries: SignalIndexEntry[] = [];
		for (const entry of Object.values(index.entries)) {
			if (entry.executionCount >= minGroupSize) {
				matchedEntries.push(entry);
			}
		}

		// Check variance for matched entries by reading their signals
		const allSignals = await this.readAllSignals(projectPath);
		const signalsByHash = new Map<string, CollectedSignal[]>();
		for (const signal of allSignals) {
			const existing = signalsByHash.get(signal.taskContentHash) ?? [];
			existing.push(signal);
			signalsByHash.set(signal.taskContentHash, existing);
		}

		let matchedWithVariance = 0;
		for (const entry of matchedEntries) {
			const signals = signalsByHash.get(entry.taskContentHash) ?? [];
			if (signals.length >= minGroupSize) {
				const rewards = signals.map(s => s.aggregateReward);
				const mean = rewards.reduce((a, b) => a + b, 0) / rewards.length;
				const stdDev = Math.sqrt(
					rewards.reduce((sum, r) => sum + (r - mean) ** 2, 0) / rewards.length,
				);
				if (stdDev > this.config.varianceThreshold) {
					matchedWithVariance++;
				}
			}
		}

		const suggestedTasks = matchedEntries
			.sort((a, b) => b.executionCount - a.executionCount)
			.map(e => ({ prompt: e.normalizedContent, executionCount: e.executionCount }));

		return {
			matchedTaskCount: matchedWithVariance,
			minGroupSize,
			ready: matchedWithVariance >= 3,
			suggestedTasks,
		};
	}

	/**
	 * Forms natural rollout groups from accumulated signal data.
	 * Called when the user triggers a GRPO training run.
	 *
	 * This is the correct way to do "passive GRPO" — accumulate genuine
	 * rollout data over time, then run standard comparison-based learning.
	 */
	async formNaturalRolloutGroups(projectPath: string): Promise<RolloutGroup[]> {
		const index = await this.readIndex(projectPath);
		const allSignals = await this.readAllSignals(projectPath);
		const minGroupSize = this.config.rolloutGroupSize;

		// Group signals by task hash
		const signalsByHash = new Map<string, CollectedSignal[]>();
		for (const signal of allSignals) {
			const existing = signalsByHash.get(signal.taskContentHash) ?? [];
			existing.push(signal);
			signalsByHash.set(signal.taskContentHash, existing);
		}

		const groups: RolloutGroup[] = [];

		for (const [hash, signals] of signalsByHash) {
			const indexEntry = index.entries[hash];
			if (!indexEntry || signals.length < minGroupSize) continue;

			// Take the N most recent executions
			const recentSignals = signals
				.sort((a, b) => b.collectedAt - a.collectedAt)
				.slice(0, minGroupSize);

			// Convert CollectedSignal[] to RolloutOutput[]
			const outputs: RolloutOutput[] = recentSignals.map((s, i) => ({
				index: i,
				agentType: s.agentType,
				sessionId: s.sessionId,
				prompt: s.taskContent,
				output: '', // Agent output not stored in signals (too large)
				rewards: s.rewards,
				aggregateReward: s.aggregateReward,
				durationMs: s.durationMs,
			}));

			// Compute group stats
			const rewards = outputs.map(o => o.aggregateReward);
			const meanReward = rewards.reduce((sum, r) => sum + r, 0) / rewards.length;
			const rewardStdDev = rewards.length > 1
				? Math.sqrt(rewards.reduce((sum, r) => sum + (r - meanReward) ** 2, 0) / rewards.length)
				: 0;

			// Skip low-variance groups (same filter as active rollouts)
			if (rewardStdDev <= this.config.varianceThreshold) continue;

			groups.push({
				id: randomUUID(),
				taskPrompt: indexEntry.normalizedContent,
				projectPath,
				outputs,
				groupSize: outputs.length,
				meanReward,
				rewardStdDev,
				experienceVersion: 0, // Natural groups don't track library versions
				epoch: 0, // Will be set by the training loop
				createdAt: Date.now(),
			});
		}

		logger.info(
			`Formed ${groups.length} natural rollout groups from ${allSignals.length} signals`,
			LOG_CONTEXT,
		);

		return groups;
	}

	/** Get the base directory (for testing/debugging) */
	getBaseDir(): string {
		return this.baseDir;
	}
}

// ─── Singleton ─────────────────────────────────────────────────────────────

let symphonyCollectorInstance: SymphonyCollector | null = null;

/**
 * Get the singleton SymphonyCollector instance.
 */
export function getSymphonyCollector(config?: GRPOConfig): SymphonyCollector {
	if (!symphonyCollectorInstance) {
		symphonyCollectorInstance = new SymphonyCollector(config ?? GRPO_CONFIG_DEFAULTS);
	} else if (config) {
		symphonyCollectorInstance.setConfig(config);
	}
	return symphonyCollectorInstance;
}

/**
 * Initialize the singleton SymphonyCollector.
 */
export async function initializeSymphonyCollector(config?: GRPOConfig): Promise<void> {
	const collector = getSymphonyCollector(config);
	await collector.initialize();
}

/**
 * Reset the singleton (for testing).
 */
export function resetSymphonyCollector(): void {
	symphonyCollectorInstance = null;
}
