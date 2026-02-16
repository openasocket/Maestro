/**
 * Training-Free GRPO types for context-space policy optimization.
 * Based on arXiv:2510.08191 — experience library replaces gradient updates.
 *
 * Core loop: rollout → reward → semantic advantage → experience update
 */

/** Unique identifier for an experience entry */
export type ExperienceId = string;

/** Unique identifier for a rollout group */
export type RolloutGroupId = string;

/** Operations that can be performed on the experience library */
export type ExperienceOperation = 'add' | 'modify' | 'delete';

/** Scope for experience entries — project-local or global */
export type ExperienceScope = 'project' | 'global';

/** A single experience entry in the library — natural language insight */
export interface ExperienceEntry {
	id: ExperienceId;
	/** The natural-language insight (e.g., "When editing React components in this project, check for existing useMemo patterns before adding new ones") */
	content: string;
	/** Category tag for organization (e.g., "testing", "architecture", "tooling", "debugging") */
	category: string;
	/** Scope: project-local or globally shared */
	scope: ExperienceScope;
	/** Agent type this experience applies to, or 'all' for universal */
	agentType: string;
	/** When this experience was created (ms timestamp) */
	createdAt: number;
	/** When this experience was last updated (ms timestamp) */
	updatedAt: number;
	/** How many rollout groups contributed to this experience */
	evidenceCount: number;
	/** How many times this experience has been injected into a prompt */
	useCount: number;
	/** The rollout group ID that last modified this experience */
	lastRolloutGroupId: RolloutGroupId | null;
	/** Estimated token count for prompt injection budgeting */
	tokenEstimate: number;
}

/** Reward signal types from verifiable outcomes */
export type RewardSignalType =
	| 'test-pass'
	| 'test-fail'
	| 'build-success'
	| 'build-fail'
	| 'lint-clean'
	| 'lint-errors'
	| 'git-diff-quality'
	| 'task-complete'
	| 'task-timeout'
	| 'process-exit-code';

/** A single verifiable reward signal */
export interface RewardSignal {
	type: RewardSignalType;
	/** Numerical score: 1.0 for success, 0.0 for failure, fractional for partial */
	score: number;
	/** Human-readable description of the signal */
	description: string;
	/** Raw output that produced this signal (e.g., test runner output, lint errors) */
	rawOutput?: string;
	/** Timestamp of signal collection (ms) */
	collectedAt: number;
}

/** A single rollout output (one agent's attempt at a task) */
export interface RolloutOutput {
	/** Index within the rollout group (0-based) */
	index: number;
	/** Agent type that produced this output */
	agentType: string;
	/** Session ID for the agent run */
	sessionId: string;
	/** Account ID used (if account multiplexing is active) */
	accountId?: string;
	/** The prompt sent to the agent */
	prompt: string;
	/** Raw output from the agent */
	output: string;
	/** Collected reward signals for this output */
	rewards: RewardSignal[];
	/** Aggregate reward score: weighted mean of individual signals */
	aggregateReward: number;
	/** Duration of the agent run in ms */
	durationMs: number;
	/** Token usage for this run */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
	};
}

/** A group of rollouts for the same task — the unit of comparison */
export interface RolloutGroup {
	id: RolloutGroupId;
	/** The task/prompt that was given to all rollouts */
	taskPrompt: string;
	/** Project path this rollout was executed in */
	projectPath: string;
	/** All rollout outputs in this group */
	outputs: RolloutOutput[];
	/** Group size (paper: G outputs per query) */
	groupSize: number;
	/** Mean reward across the group */
	meanReward: number;
	/** Std deviation of rewards (variance check: skip if 0) */
	rewardStdDev: number;
	/** The experience library version used for these rollouts */
	experienceVersion: number;
	/** Epoch number (training iteration) */
	epoch: number;
	/** When this group was created (ms timestamp) */
	createdAt: number;
}

/** Semantic advantage: LLM's introspection on why outputs differ */
export interface SemanticAdvantage {
	rolloutGroupId: RolloutGroupId;
	/** Natural-language analysis of what succeeded vs. failed */
	analysis: string;
	/** Proposed operations on the experience library */
	operations: ExperienceUpdateOperation[];
	/** The LLM model used for introspection */
	introspectionModel: string;
	/** When this advantage was generated (ms timestamp) */
	generatedAt: number;
}

/** A single proposed change to the experience library */
export interface ExperienceUpdateOperation {
	operation: ExperienceOperation;
	/** For 'modify' and 'delete': the existing experience ID */
	targetId?: ExperienceId;
	/** For 'add' and 'modify': the new/updated content */
	content?: string;
	/** For 'add' and 'modify': the category tag */
	category?: string;
	/** Reasoning for this operation (from the LLM introspection) */
	reasoning: string;
}

/** Configuration for the GRPO training loop */
export interface GRPOConfig {
	/** Whether the GRPO system is enabled */
	enabled: boolean;
	/** Number of rollouts per task (paper: G) — default 3 */
	rolloutGroupSize: number;
	/** Maximum experience library size in entries — default 50 */
	maxLibrarySize: number;
	/** Maximum token budget for experience injection — default 2500 (accounts for ~200 token wrapper overhead) */
	maxInjectionTokens: number;
	/** Reward signal weights (type → weight multiplier) */
	rewardWeights: Record<RewardSignalType, number>;
	/** Minimum reward variance threshold to trigger semantic advantage — default 0.1 */
	varianceThreshold: number;
	/** Model to use for semantic advantage generation (introspection) */
	introspectionModel: string;
	/** Agent to use for introspection (default: claude-code in read-only mode) */
	introspectionAgent: string;
	/** Number of epochs before pruning stale experiences — default 5 */
	pruneAfterEpochs: number;
	/** Whether to use global library as fallback for new projects */
	useGlobalFallback: boolean;
}

/** Default GRPO configuration */
export const GRPO_CONFIG_DEFAULTS: GRPOConfig = {
	enabled: false,
	rolloutGroupSize: 3,
	maxLibrarySize: 50,
	maxInjectionTokens: 2500,
	rewardWeights: {
		'test-pass': 1.0,
		'test-fail': 0.0,
		'build-success': 1.0,
		'build-fail': 0.0,
		'lint-clean': 0.8,
		'lint-errors': 0.2,
		'git-diff-quality': 0.7,
		'task-complete': 1.0,
		'task-timeout': 0.0,
		'process-exit-code': 0.5,
	},
	varianceThreshold: 0.1,
	introspectionModel: 'claude-sonnet-4-5-20250929',
	introspectionAgent: 'claude-code',
	pruneAfterEpochs: 5,
	useGlobalFallback: true,
};

/** Stats snapshot for dashboard display */
export interface GRPOStats {
	/** Total rollout groups processed */
	totalRolloutGroups: number;
	/** Total individual rollouts */
	totalRollouts: number;
	/** Total experience entries in the library */
	librarySize: number;
	/** Current epoch number */
	currentEpoch: number;
	/** Mean reward across all rollouts */
	overallMeanReward: number;
	/** Mean reward for the latest epoch */
	latestEpochMeanReward: number;
	/** Reward trend: positive = improving */
	rewardTrend: number;
	/** Total experience add/modify/delete operations */
	totalOperations: { add: number; modify: number; delete: number };
	/** Token cost estimate for GRPO overhead (introspection + rollouts) */
	totalGRPOTokens: number;
}

/** Agent-specific reward weight overrides */
export const AGENT_REWARD_OVERRIDES: Partial<Record<string, Partial<Record<RewardSignalType, number>>>> = {
	'claude-code': {
		// Claude Code is strong at testing, weight test signals higher
		'test-pass': 1.0,
		'test-fail': 0.0,
	},
	'codex': {
		// Codex batch mode: emphasize build success and exit code
		'build-success': 1.0,
		'process-exit-code': 0.8,
	},
};
