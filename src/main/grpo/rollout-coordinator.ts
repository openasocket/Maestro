/**
 * RolloutCoordinator — dispatches same task to N agents and collects results.
 *
 * Isolation strategy (in priority order):
 * 1. git clone --shared: lightweight shared-object clone (best: parallel + isolated)
 * 2. git worktree: parallel worktrees from same repo (good: parallel, some lock contention)
 * 3. Sequential in-place: one rollout at a time with no isolation (fallback: no parallelism)
 *
 * After all rollouts complete, reward signals are collected for each,
 * and the results are assembled into a RolloutGroup.
 */

import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { buildAgentArgs } from '../utils/agent-args';
import {
	createIsolationEnvironments,
	cleanupIsolationEnvironments,
	cleanupStaleRolloutDirs,
	type IsolationEnvironment,
} from './rollout-isolation';
import {
	collectAllRewards,
	computeAggregateReward,
	detectProjectCommands,
	captureAllBaselines,
} from './reward-collector';
import type { GroomingProcessManager } from '../utils/context-groomer';
import type { AgentDetector } from '../agents';
import type {
	GRPOConfig,
	RolloutGroup,
	RolloutOutput,
	RewardSignal,
} from '../../shared/grpo-types';

const LOG_CONTEXT = '[RolloutCoordinator]';

/** Default timeout per rollout (5 minutes) */
const DEFAULT_ROLLOUT_TIMEOUT_MS = 5 * 60 * 1000;

/** Minimum response length to consider for idle timeout */
const MIN_RESPONSE_LENGTH = 100;

/** Idle timeout — if no data for this long and we have content, consider done */
const IDLE_TIMEOUT_MS = 5000;

/** Account ID type — string identifier for account multiplexing */
export type AccountId = string;

/** Account profile for multiplexing */
export interface AccountProfile {
	id: AccountId;
	active: boolean;
	throttled: boolean;
}

/** Output from a single rollout spawn-and-collect cycle */
interface RawRolloutOutput {
	index: number;
	output: string;
	exitCode: number;
	durationMs: number;
	timedOut: boolean;
}

// ─── Account Distribution ────────────────────────────────────────────────────

/**
 * Distributes rollouts across available accounts in round-robin fashion.
 * If only one account, all rollouts use it.
 * Returns undefined for each rollout if no accounts are available.
 */
export function distributeAccounts(
	rolloutCount: number,
	availableAccounts: AccountProfile[],
): (AccountId | undefined)[] {
	const active = availableAccounts.filter(a => a.active && !a.throttled);
	if (active.length === 0) {
		return Array.from({ length: rolloutCount }, () => undefined);
	}

	return Array.from({ length: rolloutCount }, (_, i) => active[i % active.length].id);
}

// ─── Rollout Group Assembly ──────────────────────────────────────────────────

/**
 * Assembles a RolloutGroup from collected outputs with statistics.
 */
export function assembleRolloutGroup(
	taskPrompt: string,
	projectPath: string,
	outputs: RolloutOutput[],
	epoch: number,
	experienceVersion: number,
): RolloutGroup {
	const rewards = outputs.map(o => o.aggregateReward);
	const meanReward = rewards.length > 0
		? rewards.reduce((sum, r) => sum + r, 0) / rewards.length
		: 0;
	const rewardStdDev = rewards.length > 1
		? Math.sqrt(rewards.reduce((sum, r) => sum + (r - meanReward) ** 2, 0) / rewards.length)
		: 0;

	return {
		id: randomUUID(),
		taskPrompt,
		projectPath,
		outputs,
		groupSize: outputs.length,
		meanReward,
		rewardStdDev,
		experienceVersion,
		epoch,
		createdAt: Date.now(),
	};
}

// ─── Spawn and Collect ───────────────────────────────────────────────────────

/**
 * Spawns a single rollout agent and collects its output.
 * Follows the context-groomer pattern: listen to events before spawning,
 * collect output in buffer, use idle timeout for completion detection.
 */
export function spawnAndCollectRollout(
	index: number,
	groupId: string,
	taskPrompt: string,
	environment: IsolationEnvironment,
	agentType: string,
	processManager: GroomingProcessManager,
	agentConfig: { command: string; args: string[]; promptArgs?: (prompt: string) => string[]; noPromptSeparator?: boolean },
	timeoutMs: number,
): Promise<RawRolloutOutput> {
	const sessionId = `grpo-rollout-${groupId}-${index}`;
	const startTime = Date.now();

	return new Promise<RawRolloutOutput>((resolve) => {
		let responseBuffer = '';
		let lastDataTime = Date.now();
		let idleCheckInterval: NodeJS.Timeout | null = null;
		let resolved = false;

		const cleanup = () => {
			if (idleCheckInterval) {
				clearInterval(idleCheckInterval);
				idleCheckInterval = null;
			}
			processManager.off('data', onData);
			processManager.off('exit', onExit);
			processManager.off('agent-error', onError);
		};

		const finish = (exitCode: number, timedOut: boolean) => {
			if (resolved) return;
			resolved = true;
			cleanup();

			resolve({
				index,
				output: responseBuffer,
				exitCode,
				durationMs: Date.now() - startTime,
				timedOut,
			});
		};

		const onData = (...args: unknown[]) => {
			const [eventSessionId, data] = args as [string, string];
			if (eventSessionId !== sessionId) return;
			responseBuffer += data;
			lastDataTime = Date.now();
		};

		const onExit = (...args: unknown[]) => {
			const [eventSessionId, exitCode] = args as [string, number];
			if (eventSessionId !== sessionId) return;
			finish(exitCode, false);
		};

		const onError = (...args: unknown[]) => {
			const [eventSessionId] = args as [string, unknown];
			if (eventSessionId !== sessionId) return;
			finish(1, false);
		};

		// Listen for events BEFORE spawning
		processManager.on('data', onData);
		processManager.on('exit', onExit);
		processManager.on('agent-error', onError);

		// Spawn the agent in batch mode
		const spawnResult = processManager.spawn({
			sessionId,
			toolType: agentType,
			cwd: environment.workingDir,
			command: agentConfig.command,
			args: agentConfig.args,
			prompt: taskPrompt,
			promptArgs: agentConfig.promptArgs,
			noPromptSeparator: agentConfig.noPromptSeparator,
		});

		if (!spawnResult || spawnResult.pid <= 0) {
			finish(1, false);
			return;
		}

		// Idle check: if no data for IDLE_TIMEOUT_MS and we have enough content, finish
		idleCheckInterval = setInterval(() => {
			const idleTime = Date.now() - lastDataTime;
			if (idleTime > IDLE_TIMEOUT_MS && responseBuffer.length >= MIN_RESPONSE_LENGTH) {
				logger.debug(`Rollout ${index} finishing via idle timeout`, LOG_CONTEXT);
				finish(0, false);
			}
		}, 1000);

		// Overall timeout
		setTimeout(() => {
			if (!resolved) {
				logger.warn(`Rollout ${index} timed out after ${timeoutMs}ms`, LOG_CONTEXT);
				try {
					processManager.kill(sessionId);
				} catch {
					// Process may have already exited
				}
				finish(-1, true);
			}
		}, timeoutMs);
	});
}

// ─── Main Coordinator ────────────────────────────────────────────────────────

/**
 * Executes a full rollout group: creates isolation environments, spawns agents,
 * collects outputs, runs reward collection, and assembles the RolloutGroup.
 */
export async function executeRolloutGroup(
	taskPrompt: string,
	projectPath: string,
	config: GRPOConfig,
	epoch: number,
	processManager: GroomingProcessManager,
	experienceStore: { getLibrary: (projectPath: string) => Promise<unknown[]> },
	rewardCollector: {
		detectProjectCommands: typeof detectProjectCommands;
		captureAllBaselines: typeof captureAllBaselines;
		collectAllRewards: typeof collectAllRewards;
		computeAggregateReward: typeof computeAggregateReward;
	},
	agentDetector: AgentDetector,
	accounts?: AccountProfile[],
): Promise<RolloutGroup> {
	const groupId = randomUUID().slice(0, 8);
	const groupSize = config.rolloutGroupSize;

	logger.info(`Starting rollout group ${groupId}: ${groupSize} rollouts`, LOG_CONTEXT, {
		taskPrompt: taskPrompt.slice(0, 100),
		epoch,
	});

	// 1. Detect project commands and capture all baselines
	const commands = await rewardCollector.detectProjectCommands(projectPath);
	const baselines = await rewardCollector.captureAllBaselines(projectPath, commands, config);

	// 2. Get experience library version (for tracking)
	const library = await experienceStore.getLibrary(projectPath);
	const experienceVersion = library.length;

	// 3. Determine agent assignments
	const agentType = config.introspectionAgent ?? 'claude-code';
	const agent = await agentDetector.getAgent(agentType);
	if (!agent || !agent.available) {
		throw new Error(`Agent ${agentType} is not available for rollouts`);
	}

	// Build agent args for batch mode
	const agentArgs = buildAgentArgs(agent, {
		baseArgs: agent.args || [],
		prompt: taskPrompt,
		cwd: projectPath,
		readOnlyMode: false,
	});

	// 4. Distribute accounts
	const accountAssignments = accounts
		? distributeAccounts(groupSize, accounts)
		: Array.from({ length: groupSize }, () => undefined);

	// 5. Create isolation environments
	let environments: IsolationEnvironment[] = [];
	try {
		environments = await createIsolationEnvironments(projectPath, groupSize);
	} catch (err) {
		logger.error(`Failed to create isolation environments: ${err}`, LOG_CONTEXT);
		captureException(err, { operation: 'rollout:createIsolation', groupId });
		throw err;
	}

	const isParallel = environments.length > 0 && environments[0].type !== 'in-place';

	try {
		// 6. Spawn rollouts (parallel for clone/worktree, sequential for in-place)
		const agentConfig = {
			command: agent.command,
			args: agentArgs,
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
		};

		let rawOutputs: RawRolloutOutput[];

		if (isParallel) {
			rawOutputs = await Promise.all(
				environments.map((env, i) =>
					spawnAndCollectRollout(
						i, groupId, taskPrompt, env, agentType,
						processManager, agentConfig, DEFAULT_ROLLOUT_TIMEOUT_MS,
					)
				)
			);
		} else {
			rawOutputs = [];
			for (let i = 0; i < environments.length; i++) {
				rawOutputs.push(
					await spawnAndCollectRollout(
						i, groupId, taskPrompt, environments[i], agentType,
						processManager, agentConfig, DEFAULT_ROLLOUT_TIMEOUT_MS,
					)
				);
			}
		}

		// 7. Collect rewards for each rollout
		const rolloutOutputs: RolloutOutput[] = [];

		for (const raw of rawOutputs) {
			const env = environments[raw.index];
			const rewardPath = env.type === 'in-place' ? projectPath : env.workingDir;

			let rewards: RewardSignal[];
			let aggregateReward: number;

			if (raw.timedOut) {
				// Timed-out rollout gets default output with score 0
				rewards = [{
					type: 'task-timeout',
					score: 0,
					description: 'Rollout timed out',
					collectedAt: Date.now(),
				}];
				aggregateReward = 0;
			} else {
				rewards = await rewardCollector.collectAllRewards(
					rewardPath, raw.exitCode, raw.output, config, commands, baselines,
				);
				aggregateReward = rewardCollector.computeAggregateReward(rewards, config.rewardWeights, config.humanFeedbackDecayMs);
			}

			rolloutOutputs.push({
				index: raw.index,
				agentType,
				sessionId: `grpo-rollout-${groupId}-${raw.index}`,
				accountId: accountAssignments[raw.index],
				prompt: taskPrompt,
				output: raw.output,
				rewards,
				aggregateReward,
				durationMs: raw.durationMs,
			});
		}

		// 8. Assemble RolloutGroup
		const rolloutGroup = assembleRolloutGroup(
			taskPrompt, projectPath, rolloutOutputs, epoch, experienceVersion,
		);

		logger.info(`Rollout group ${groupId} complete`, LOG_CONTEXT, {
			meanReward: rolloutGroup.meanReward.toFixed(3),
			rewardStdDev: rolloutGroup.rewardStdDev.toFixed(3),
			parallelMode: isParallel,
		});

		return rolloutGroup;
	} finally {
		// 9. Cleanup: always runs, even on error
		await cleanupIsolationEnvironments(environments, projectPath);
	}
}

/**
 * Initialize the rollout coordinator: runs startup garbage collection.
 */
export async function initializeRolloutCoordinator(): Promise<void> {
	await cleanupStaleRolloutDirs();
}
