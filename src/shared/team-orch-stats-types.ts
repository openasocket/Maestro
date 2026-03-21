/**
 * Type definitions for the Team Orchestration stats tracking system
 *
 * These types are shared between main process (stats/) and renderer (dashboard).
 * Used for recording, querying, and aggregating team orchestration workflow events.
 */

/**
 * Per-participant statistics within a team orchestration run
 */
export interface TeamOrchParticipantStats {
	name: string;
	agentId: string;
	tokenCount: number;
	messageCount: number;
	processingTimeMs: number;
	cost: number;
}

/**
 * A single team orchestration workflow event
 */
export interface TeamOrchEvent {
	id: string;
	groupChatId: string;
	groupChatName: string;
	templateId?: string;
	templateName?: string;
	topologyPattern: string;
	terminationMode: string;
	status: 'completed' | 'failed' | 'terminated';
	iterationCount: number;
	maxIterations: number;
	startTime: number;
	endTime: number;
	duration: number;
	participantCount: number;
	participantBreakdown: TeamOrchParticipantStats[];
	totalTokens: number;
	totalCost: number;
	moderatorAgentId: string;
	projectPath?: string;
}

/**
 * Aggregated statistics for team orchestration dashboard display
 */
export interface TeamOrchAggregation {
	totalRuns: number;
	completedRuns: number;
	failedRuns: number;
	terminatedRuns: number;
	/** Success rate as a percentage (0-100) */
	successRate: number;
	avgIterations: number;
	avgDuration: number;
	totalTokens: number;
	totalCost: number;
	byTopology: Record<
		string,
		{
			count: number;
			successRate: number;
			avgIterations: number;
			avgDuration: number;
		}
	>;
	byAgent: Record<
		string,
		{
			tokenCount: number;
			messageCount: number;
			processingTimeMs: number;
			cost: number;
			runCount: number;
		}
	>;
	byDay: Array<{
		date: string;
		count: number;
		tokens: number;
		duration: number;
		cost: number;
	}>;
	byAgentByDay: Record<
		string,
		Array<{
			date: string;
			tokens: number;
			duration: number;
		}>
	>;
	iterationDistribution: Array<{
		iterations: number;
		count: number;
	}>;
	byTemplate: Record<
		string,
		{
			count: number;
			successRate: number;
			avgIterations: number;
		}
	>;
}

/**
 * Time range for querying team orchestration stats
 */
export type TeamOrchTimeRange = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all';

/**
 * Query parameters for paginated team orchestration history
 */
export interface TeamOrchHistoryQuery {
	offset: number;
	limit: number;
	topologyPattern?: string;
	status?: string;
	search?: string;
}

/**
 * Paginated result for team orchestration history queries
 */
export interface TeamOrchHistoryResult {
	events: TeamOrchEvent[];
	total: number;
}
