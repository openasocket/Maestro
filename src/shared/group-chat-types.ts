/**
 * @file group-chat-types.ts
 * @description Shared type definitions and utilities for Group Chat feature.
 * Used by both main process and renderer.
 */

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Normalize a name for use in @mentions.
 * Replaces spaces with hyphens so names can be referenced without quotes.
 *
 * @param name - Original name (may contain spaces)
 * @returns Normalized name with hyphens instead of spaces
 */
export function normalizeMentionName(name: string): string {
	return name.replace(/\s+/g, '-');
}

/**
 * Check if a name matches a mention target (handles normalized names).
 *
 * @param mentionedName - The name from the @mention (may be hyphenated)
 * @param actualName - The actual session/participant name (may have spaces)
 * @returns True if they match
 */
export function mentionMatches(mentionedName: string, actualName: string): boolean {
	return (
		mentionedName.toLowerCase() === actualName.toLowerCase() ||
		mentionedName.toLowerCase() === normalizeMentionName(actualName).toLowerCase()
	);
}

// ============================================================================
// TEAM TEMPLATE TYPES
// ============================================================================

/**
 * Organizational tier for a role in a team hierarchy.
 * Executives approve, managers coordinate, workers execute.
 */
export type RoleTier = 'executive' | 'manager' | 'worker';

/**
 * Tier authority ordering. Higher number = higher authority.
 * Used for connection validation and topology generation.
 */
export const ROLE_TIER_ORDER: Record<RoleTier, number> = { executive: 3, manager: 2, worker: 1 };

/**
 * A role definition within a team template.
 * Roles represent abstract positions (not bound to specific sessions).
 */
export interface TeamTemplateRole {
	/** Role display name, e.g., "Frontend Specialist" */
	name: string;
	/** Default agent type for this role */
	agentId: string;
	/** What this role does */
	description: string;
	/** Additional context injected into participant prompt */
	systemPromptSuffix?: string;
	/** Organizational tier: executive (approves), manager (coordinates), worker (executes). Defaults to 'worker'. */
	tier?: RoleTier;
	/** What this role expects (for TEAM-ORCH-05) */
	inputContract?: string[];
	/** What this role produces (for TEAM-ORCH-05) */
	outputContract?: string[];
}

/**
 * A directed edge between two roles in a workflow topology.
 */
export interface WorkflowEdge {
	/** Role name (or '__entry__' for user input) */
	source: string;
	/** Role name (or '__exit__' for final output) */
	target: string;
	/** Natural-language condition evaluated by moderator */
	condition?: string;
	/** How this edge is traversed */
	edgeType: 'sequential' | 'parallel' | 'conditional';
}

/**
 * Workflow topology for structured agent routing.
 * Defines graph-based patterns beyond hub-spoke moderator routing.
 */
export interface WorkflowTopology {
	/** The routing pattern for this workflow */
	pattern: 'hub-spoke' | 'pipeline' | 'parallel-then-merge' | 'review-loop' | 'custom';
	/** Directed edges between roles */
	edges: WorkflowEdge[];
	/** Role name that receives initial input */
	entryPoint: string;
	/** Role name that produces final output */
	exitPoint: string;
}

/**
 * Runtime state for tracking workflow execution progress.
 */
export interface WorkflowExecutionState {
	/** Which node/role is currently active */
	currentPhase: string;
	/** Roles that have finished */
	completedNodes: string[];
	/** Roles waiting for upstream */
	pendingNodes: string[];
	/** Roles currently executing */
	activeNodes: string[];
	/** Loop iteration count (for review-loop patterns) */
	iterationCount: number;
	/** Last output per role name */
	nodeOutputs: Record<string, string>;
	/** Overall workflow status */
	status: 'running' | 'completed' | 'failed' | 'terminated';
	/** When true, workflow terminates after the current iteration completes */
	stopAfterIteration?: boolean;
	/** Quality gate evaluation status: pending means waiting for evaluation, approved means gate passed */
	qualityGatePending?: boolean;
}

/**
 * A reusable team configuration template.
 * Users can save Group Chat configurations as templates and
 * load them when creating new group chats.
 */
export interface TeamTemplate {
	/** Unique identifier (UUID or deterministic ID for builtins) */
	id: string;
	/** Template display name, e.g., "Code Review Team" */
	name: string;
	/** What this team does */
	description: string;
	/** Lucide icon name (optional) */
	icon?: string;
	/** Source category */
	category: 'builtin' | 'user' | 'exchange';
	/** Creation timestamp (epoch ms) */
	createdAt: number;
	/** Last update timestamp (epoch ms) */
	updatedAt: number;

	/** Default agent type for moderator */
	moderatorAgentId: string;
	/** Optional moderator configuration overrides */
	moderatorConfig?: {
		customArgs?: string;
		customEnvVars?: Record<string, string>;
	};

	/** Participant role definitions */
	roles: TeamTemplateRole[];

	/** Optional workflow topology (for TEAM-ORCH-04) */
	topology?: WorkflowTopology;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Group chat participant
 */
export interface GroupChatParticipant {
	name: string;
	agentId: string;
	/** Internal process session ID (used for routing) */
	sessionId: string;
	/** Agent's session ID (e.g., Claude Code's session GUID for continuity) */
	agentSessionId?: string;
	addedAt: number;
	lastActivity?: number;
	lastSummary?: string;
	contextUsage?: number;
	// Color for this participant (assigned on join)
	color?: string;
	// Stats tracking
	tokenCount?: number;
	messageCount?: number;
	processingTimeMs?: number;
	/** Total cost in USD (optional, depends on provider) */
	totalCost?: number;
	/** SSH remote name (displayed as pill when running on SSH remote) */
	sshRemoteName?: string;
}

/**
 * Custom configuration for an agent (moderator)
 */
export interface ModeratorConfig {
	/** Custom path to the agent binary */
	customPath?: string;
	/** Custom CLI arguments */
	customArgs?: string;
	/** Custom environment variables */
	customEnvVars?: Record<string, string>;
	/** Custom model selection (e.g., 'ollama/qwen3:8b') */
	customModel?: string;
	/** SSH remote config for remote execution */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/**
 * Group chat metadata
 */
export interface GroupChat {
	id: string;
	name: string;
	createdAt: number;
	updatedAt?: number;
	moderatorAgentId: string;
	/** Internal session ID prefix used for routing (e.g., 'group-chat-{id}-moderator') */
	moderatorSessionId: string;
	/** Claude Code agent session UUID (set after first message is processed) */
	moderatorAgentSessionId?: string;
	/** Custom configuration for the moderator agent */
	moderatorConfig?: ModeratorConfig;
	participants: GroupChatParticipant[];
	logPath: string;
	imagesDir: string;
	draftMessage?: string;
	archived?: boolean;
	/** Optional workflow topology (when using graph-based routing) */
	topology?: WorkflowTopology;
	/** Runtime execution state for topology-based workflows */
	executionState?: WorkflowExecutionState;
	/** Template role definitions (preserved for contract-based routing) */
	templateRoles?: TeamTemplateRole[];
}

/**
 * Group chat message entry from the chat log
 */
export interface GroupChatMessage {
	timestamp: string;
	from: string;
	content: string;
	readOnly?: boolean;
	/** Base64 data URLs of images attached to this message */
	images?: string[];
}

/**
 * Group chat state for UI display
 */
export type GroupChatState = 'idle' | 'moderator-thinking' | 'agent-working';

/**
 * Type of history entry in a group chat
 */
export type GroupChatHistoryEntryType = 'delegation' | 'response' | 'synthesis' | 'error';

/**
 * History entry for group chat activity tracking.
 * Stored in JSONL format in the group chat directory.
 */
export interface GroupChatHistoryEntry {
	/** Unique identifier for the entry */
	id: string;
	/** Timestamp when this entry was created */
	timestamp: number;
	/** One-sentence summary of what was accomplished */
	summary: string;
	/** Name of the participant who did the work (or 'Moderator' for synthesis) */
	participantName: string;
	/** Color assigned to this participant (for visualization) */
	participantColor: string;
	/** Type of activity */
	type: GroupChatHistoryEntryType;
	/** Time taken to complete the task (ms) */
	elapsedTimeMs?: number;
	/** Token count for this activity */
	tokenCount?: number;
	/** Cost in USD for this activity */
	cost?: number;
	/** Full response text (optional, for detail view) */
	fullResponse?: string;
}
