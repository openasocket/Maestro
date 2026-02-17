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

/** Signal realm — the source context that produced this signal */
export type SignalRealm = 'autorun' | 'manual' | 'groupchat' | 'process';

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
	/** Pre-computed 384-dim embedding vector for semantic retrieval (optional — computed lazily) */
	embedding?: number[];
	/** Which embedding model produced this vector ('multilingual' | 'english') — used to detect model switches */
	embeddingModel?: string;
}

/** Reward signal types from verifiable outcomes */
export type RewardSignalType =
	// Existing signals
	| 'test-pass'
	| 'test-fail'
	| 'build-success'
	| 'build-fail'
	| 'lint-clean'
	| 'lint-errors'
	| 'git-diff-quality'
	| 'task-complete'
	| 'task-timeout'
	| 'process-exit-code'
	// New signals (GRPO-15)
	| 'test-coverage-delta'
	| 'type-safety'
	| 'complexity-delta'
	| 'security-scan'
	| 'dependency-hygiene'
	| 'api-contract'
	| 'documentation-coverage'
	| 'runtime-performance'
	| 'bundle-size-delta'
	// Human feedback (GRPO-16)
	| 'human-feedback';

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

/** A single human feedback entry (thumbs up/down on an agent response) */
export interface HumanFeedback {
	/** Unique ID for this feedback entry */
	id: string;
	/** The session ID where feedback was given */
	sessionId: string;
	/** The agent type that produced the response */
	agentType: string;
	/** Project path at time of feedback */
	projectPath: string;
	/** Whether the user approved (true = thumbs up, false = thumbs down) */
	approved: boolean;
	/** SHA-256 hash of the agent response text (first 12 chars, for matching to signals) */
	responseHash: string;
	/** Truncated agent response text (first 500 chars, for introspection context) */
	responsePreview: string;
	/** Truncated user prompt that led to this response (first 200 chars) */
	promptPreview: string;
	/** Timestamp of feedback (ms) */
	createdAt: number;
	/** Signal realm this feedback belongs to */
	realm: SignalRealm;
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

/** Embedding model choices for semantic retrieval */
export type GRPOEmbeddingModel = 'multilingual' | 'english';

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
	/** Number of consecutive low-improvement epochs before early stop — default 3 */
	earlyStoppingEpochs: number;
	/** Whether early stopping is enabled — default true */
	earlyStoppingEnabled: boolean;
	/** Whether to use semantic embedding retrieval for experience selection (default: true) */
	semanticRetrievalEnabled: boolean;
	/** Minimum cosine similarity threshold for experience relevance (default: 0.15) */
	semanticSimilarityFloor: number;
	/** Embedding model for semantic retrieval — 'multilingual' (50+ langs, default) or 'english' (faster, EN only) */
	embeddingModel: GRPOEmbeddingModel;
	/** Whether human feedback thumbs-up/down collection is enabled (default: false) */
	humanFeedbackEnabled: boolean;
	/** Maximum age for human feedback signals before decay to zero (ms, default: 7 days) */
	humanFeedbackDecayMs: number;
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
		// New signals (GRPO-15)
		'test-coverage-delta': 0.9,
		'type-safety': 0.8,
		'complexity-delta': 0.6,
		'security-scan': 0.8,
		'dependency-hygiene': 0.5,
		'api-contract': 0.7,
		'documentation-coverage': 0.4,
		'runtime-performance': 0.5,
		'bundle-size-delta': 0.4,
		'human-feedback': 0.3,
	},
	varianceThreshold: 0.1,
	introspectionModel: 'claude-sonnet-4-5-20250929',
	introspectionAgent: 'claude-code',
	pruneAfterEpochs: 5,
	useGlobalFallback: true,
	earlyStoppingEpochs: 3,
	earlyStoppingEnabled: true,
	semanticRetrievalEnabled: true,
	semanticSimilarityFloor: 0.15,
	embeddingModel: 'multilingual',
	humanFeedbackEnabled: false,
	humanFeedbackDecayMs: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/** Summary of a rollout group for dashboard display */
export interface RolloutGroupSummary {
	id: RolloutGroupId;
	/** Truncated task prompt */
	taskPrompt: string;
	groupSize: number;
	meanReward: number;
	rewardStdDev: number;
	epoch: number;
	createdAt: number;
	/** Per-rollout summary rows */
	rollouts: {
		index: number;
		agentType: string;
		aggregateReward: number;
		rewardSignals: RewardSignalType[];
	}[];
	/** Operation counts: add/modify/delete from semantic advantage */
	operations: { add: number; modify: number; delete: number };
}

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
	/** Per-epoch stats for reward trends chart */
	epochs: EpochStats[];
	/** Recent rollout group summaries for comparison table */
	recentRolloutGroups: RolloutGroupSummary[];
}

// ─── Training Loop Types ─────────────────────────────────────────────

/** Statistics for a single training epoch */
export interface EpochStats {
	epoch: number;
	rolloutGroupsProcessed: number;
	meanReward: number;
	/** Reward improvement relative to previous epoch (fractional, e.g. 0.05 = 5%) */
	rewardImprovement: number;
	experienceOperations: { add: number; modify: number; delete: number };
	librarySize: number;
	durationMs: number;
	tokenCost: number;
}

/** Final result of a complete training loop run */
export interface TrainingResult {
	epochs: EpochStats[];
	finalLibrarySize: number;
	totalRollouts: number;
	totalTokenCost: number;
	/** Reward improvement from first epoch to last (fractional) */
	rewardImprovement: number;
	durationMs: number;
}

/** A single task for the training loop to process */
export interface TrainingTask {
	prompt: string;
	/** Optional: expected outcome for ground-truth comparison */
	expectedOutcome?: string;
}

// ─── Symphony Collector Types ────────────────────────────────────────────────

/** A collected reward signal from a single Auto Run task execution */
export interface CollectedSignal {
	taskContent: string;
	/** SHA-256 first 12 chars of normalized task content — for matching identical tasks across runs */
	taskContentHash: string;
	rewards: RewardSignal[];
	aggregateReward: number;
	agentType: string;
	sessionId: string;
	durationMs: number;
	collectedAt: number;
	documentPath: string;
	projectPath: string;
	/** The source realm that produced this signal */
	realm: SignalRealm;
}

/** Aggregated result for a single document in a batch run */
export interface BatchCollectionResult {
	documentPath: string;
	signals: CollectedSignal[];
	overallSuccess: boolean;
}

/** Summary generated after a batch run completes */
export interface CollectionSummary {
	documentsProcessed: number;
	signalsCollected: number;
	meanTaskReward: number;
	/** How many unique tasks now have 2+ executions (potential rollout groups) */
	matchedPairCount: number;
	/** Suggested: enough data for training? */
	trainingRecommended: boolean;
}

/** Training readiness assessment */
export interface TrainingReadiness {
	/** Total unique tasks with 2+ recorded executions */
	matchedTaskCount: number;
	/** Minimum rollout group size available */
	minGroupSize: number;
	/** Whether enough data exists for a meaningful training run */
	ready: boolean;
	/** Suggested tasks to use as training data */
	suggestedTasks: { prompt: string; executionCount: number }[];
}

/** Signal index entry — tracks per-task execution counts and latest rewards */
export interface SignalIndexEntry {
	taskContentHash: string;
	normalizedContent: string;
	executionCount: number;
	latestReward: number;
	firstSeen: number;
	lastSeen: number;
}

/** Signal index file format */
export interface SignalIndex {
	version: number;
	entries: Record<string, SignalIndexEntry>;
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
