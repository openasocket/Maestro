/**
 * Team Orchestration Event CRUD Operations
 *
 * Handles insertion, retrieval, aggregation, and export of team orchestration
 * workflow events for the Team Orchestration Management Modal dashboard.
 */

import type Database from 'better-sqlite3';
import type {
	TeamOrchEvent,
	TeamOrchParticipantStats,
	TeamOrchAggregation,
	TeamOrchHistoryQuery,
	TeamOrchHistoryResult,
	TeamOrchTimeRange,
} from '../../shared/team-orch-stats-types';
import { normalizePath, LOG_CONTEXT, perfMetrics } from './utils';
import { StatementCache } from './utils';
import { mapTeamOrchEventRow, type TeamOrchEventRow } from './row-mappers';
import { logger } from '../utils/logger';

const stmtCache = new StatementCache();

const INSERT_SQL = `
  INSERT INTO team_orch_events (
    id, group_chat_id, group_chat_name, template_id, template_name,
    topology_pattern, termination_mode, status, iteration_count, max_iterations,
    start_time, end_time, duration, participant_count, participant_breakdown,
    total_tokens, total_cost, moderator_agent_id, project_path
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Convert a TeamOrchTimeRange to epoch milliseconds start time.
 */
function getTeamOrchTimeRangeStart(range: TeamOrchTimeRange): number {
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;

	switch (range) {
		case 'day':
			return now - day;
		case 'week':
			return now - 7 * day;
		case 'month':
			return now - 30 * day;
		case 'quarter':
			return now - 90 * day;
		case 'year':
			return now - 365 * day;
		case 'all':
			return 0;
		default:
			return 0;
	}
}

// ============================================================================
// Insert
// ============================================================================

/**
 * Insert a new team orchestration event.
 */
export function insertTeamOrchEvent(db: Database.Database, event: TeamOrchEvent): void {
	const stmt = stmtCache.get(db, INSERT_SQL);

	stmt.run(
		event.id,
		event.groupChatId,
		event.groupChatName,
		event.templateId ?? null,
		event.templateName ?? null,
		event.topologyPattern,
		event.terminationMode,
		event.status,
		event.iterationCount,
		event.maxIterations,
		event.startTime,
		event.endTime,
		event.duration,
		event.participantCount,
		JSON.stringify(event.participantBreakdown),
		event.totalTokens,
		event.totalCost,
		event.moderatorAgentId,
		normalizePath(event.projectPath)
	);

	logger.debug(`Inserted team orch event ${event.id}`, LOG_CONTEXT);
}

// ============================================================================
// Aggregation
// ============================================================================

function queryTeamOrchTotals(
	db: Database.Database,
	startTime: number
): {
	totalRuns: number;
	completedRuns: number;
	failedRuns: number;
	terminatedRuns: number;
	sumIterations: number;
	sumDuration: number;
	totalTokens: number;
	totalCost: number;
} {
	const perfStart = perfMetrics.start();
	const result = db
		.prepare(
			`
      SELECT
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
        SUM(CASE WHEN status = 'terminated' THEN 1 ELSE 0 END) as terminated_runs,
        COALESCE(SUM(iteration_count), 0) as sum_iterations,
        COALESCE(SUM(duration), 0) as sum_duration,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(total_cost), 0) as total_cost
      FROM team_orch_events
      WHERE start_time >= ?
    `
		)
		.get(startTime) as {
		total_runs: number;
		completed_runs: number;
		failed_runs: number;
		terminated_runs: number;
		sum_iterations: number;
		sum_duration: number;
		total_tokens: number;
		total_cost: number;
	};
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:totals');
	return {
		totalRuns: result.total_runs,
		completedRuns: result.completed_runs,
		failedRuns: result.failed_runs,
		terminatedRuns: result.terminated_runs,
		sumIterations: result.sum_iterations,
		sumDuration: result.sum_duration,
		totalTokens: result.total_tokens,
		totalCost: result.total_cost,
	};
}

function queryByTopology(
	db: Database.Database,
	startTime: number
): Record<
	string,
	{ count: number; successRate: number; avgIterations: number; avgDuration: number }
> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT
        topology_pattern,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        AVG(iteration_count) as avg_iterations,
        AVG(duration) as avg_duration
      FROM team_orch_events
      WHERE start_time >= ?
      GROUP BY topology_pattern
    `
		)
		.all(startTime) as Array<{
		topology_pattern: string;
		count: number;
		completed: number;
		avg_iterations: number;
		avg_duration: number;
	}>;

	const result: Record<
		string,
		{ count: number; successRate: number; avgIterations: number; avgDuration: number }
	> = {};
	for (const row of rows) {
		result[row.topology_pattern] = {
			count: row.count,
			successRate: row.count > 0 ? Math.round((row.completed / row.count) * 100) : 0,
			avgIterations: Math.round(row.avg_iterations * 100) / 100,
			avgDuration: Math.round(row.avg_duration),
		};
	}
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:byTopology');
	return result;
}

function queryByAgent(
	db: Database.Database,
	startTime: number
): Record<
	string,
	{
		tokenCount: number;
		messageCount: number;
		processingTimeMs: number;
		cost: number;
		runCount: number;
	}
> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT participant_breakdown
      FROM team_orch_events
      WHERE start_time >= ?
    `
		)
		.all(startTime) as Array<{ participant_breakdown: string | null }>;

	const result: Record<
		string,
		{
			tokenCount: number;
			messageCount: number;
			processingTimeMs: number;
			cost: number;
			runCount: number;
		}
	> = {};

	for (const row of rows) {
		if (!row.participant_breakdown) continue;
		let participants: TeamOrchParticipantStats[];
		try {
			participants = JSON.parse(row.participant_breakdown) as TeamOrchParticipantStats[];
		} catch {
			continue;
		}
		const seen = new Set<string>();
		for (const p of participants) {
			if (!result[p.agentId]) {
				result[p.agentId] = {
					tokenCount: 0,
					messageCount: 0,
					processingTimeMs: 0,
					cost: 0,
					runCount: 0,
				};
			}
			result[p.agentId].tokenCount += p.tokenCount;
			result[p.agentId].messageCount += p.messageCount;
			result[p.agentId].processingTimeMs += p.processingTimeMs;
			result[p.agentId].cost += p.cost;
			if (!seen.has(p.agentId)) {
				result[p.agentId].runCount += 1;
				seen.add(p.agentId);
			}
		}
	}
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:byAgent');
	return result;
}

function queryByDay(
	db: Database.Database,
	startTime: number
): Array<{ date: string; count: number; tokens: number; duration: number; cost: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT
        date(start_time / 1000, 'unixepoch', 'localtime') as date,
        COUNT(*) as count,
        COALESCE(SUM(total_tokens), 0) as tokens,
        COALESCE(SUM(duration), 0) as duration,
        COALESCE(SUM(total_cost), 0) as cost
      FROM team_orch_events
      WHERE start_time >= ?
      GROUP BY date(start_time / 1000, 'unixepoch', 'localtime')
      ORDER BY date ASC
    `
		)
		.all(startTime) as Array<{
		date: string;
		count: number;
		tokens: number;
		duration: number;
		cost: number;
	}>;
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:byDay');
	return rows;
}

function queryByAgentByDay(
	db: Database.Database,
	startTime: number
): Record<string, Array<{ date: string; tokens: number; duration: number }>> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT
        date(start_time / 1000, 'unixepoch', 'localtime') as date,
        participant_breakdown
      FROM team_orch_events
      WHERE start_time >= ?
      ORDER BY date ASC
    `
		)
		.all(startTime) as Array<{ date: string; participant_breakdown: string | null }>;

	// Accumulate per-agent per-day: { agentId -> { date -> { tokens, duration } } }
	const accumulator: Record<string, Record<string, { tokens: number; duration: number }>> = {};

	for (const row of rows) {
		if (!row.participant_breakdown) continue;
		let participants: TeamOrchParticipantStats[];
		try {
			participants = JSON.parse(row.participant_breakdown) as TeamOrchParticipantStats[];
		} catch {
			continue;
		}
		for (const p of participants) {
			if (!accumulator[p.agentId]) {
				accumulator[p.agentId] = {};
			}
			if (!accumulator[p.agentId][row.date]) {
				accumulator[p.agentId][row.date] = { tokens: 0, duration: 0 };
			}
			accumulator[p.agentId][row.date].tokens += p.tokenCount;
			accumulator[p.agentId][row.date].duration += p.processingTimeMs;
		}
	}

	// Convert to result shape
	const result: Record<string, Array<{ date: string; tokens: number; duration: number }>> = {};
	for (const [agentId, dayMap] of Object.entries(accumulator)) {
		result[agentId] = Object.entries(dayMap)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([date, stats]) => ({ date, tokens: stats.tokens, duration: stats.duration }));
	}
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:byAgentByDay');
	return result;
}

function queryIterationDistribution(
	db: Database.Database,
	startTime: number
): Array<{ iterations: number; count: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT iteration_count as iterations, COUNT(*) as count
      FROM team_orch_events
      WHERE start_time >= ?
      GROUP BY iteration_count
      ORDER BY iteration_count ASC
    `
		)
		.all(startTime) as Array<{ iterations: number; count: number }>;
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:iterationDistribution');
	return rows;
}

function queryByTemplate(
	db: Database.Database,
	startTime: number
): Record<string, { count: number; successRate: number; avgIterations: number }> {
	const perfStart = perfMetrics.start();
	const rows = db
		.prepare(
			`
      SELECT
        COALESCE(template_id, '_none_') as template_key,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        AVG(iteration_count) as avg_iterations
      FROM team_orch_events
      WHERE start_time >= ?
      GROUP BY template_key
    `
		)
		.all(startTime) as Array<{
		template_key: string;
		count: number;
		completed: number;
		avg_iterations: number;
	}>;

	const result: Record<string, { count: number; successRate: number; avgIterations: number }> = {};
	for (const row of rows) {
		result[row.template_key] = {
			count: row.count,
			successRate: row.count > 0 ? Math.round((row.completed / row.count) * 100) : 0,
			avgIterations: Math.round(row.avg_iterations * 100) / 100,
		};
	}
	perfMetrics.end(perfStart, 'getTeamOrchAggregation:byTemplate');
	return result;
}

/**
 * Get aggregated team orchestration statistics for a time range.
 */
export function getTeamOrchAggregation(
	db: Database.Database,
	startTime: number
): TeamOrchAggregation {
	const perfStart = perfMetrics.start();

	const totals = queryTeamOrchTotals(db, startTime);
	const byTopology = queryByTopology(db, startTime);
	const byAgent = queryByAgent(db, startTime);
	const byDay = queryByDay(db, startTime);
	const byAgentByDay = queryByAgentByDay(db, startTime);
	const iterationDistribution = queryIterationDistribution(db, startTime);
	const byTemplate = queryByTemplate(db, startTime);

	perfMetrics.end(perfStart, 'getTeamOrchAggregation:total', {
		totalRuns: totals.totalRuns,
	});

	return {
		totalRuns: totals.totalRuns,
		completedRuns: totals.completedRuns,
		failedRuns: totals.failedRuns,
		terminatedRuns: totals.terminatedRuns,
		successRate:
			totals.totalRuns > 0 ? Math.round((totals.completedRuns / totals.totalRuns) * 100) : 0,
		avgIterations:
			totals.totalRuns > 0 ? Math.round((totals.sumIterations / totals.totalRuns) * 100) / 100 : 0,
		avgDuration: totals.totalRuns > 0 ? Math.round(totals.sumDuration / totals.totalRuns) : 0,
		totalTokens: totals.totalTokens,
		totalCost: totals.totalCost,
		byTopology,
		byAgent,
		byDay,
		byAgentByDay,
		iterationDistribution,
		byTemplate,
	};
}

// ============================================================================
// History (paginated)
// ============================================================================

/**
 * Get paginated team orchestration event history with optional filters.
 */
export function getTeamOrchHistory(
	db: Database.Database,
	query: TeamOrchHistoryQuery
): TeamOrchHistoryResult {
	let whereClauses = '';
	const params: (string | number)[] = [];

	if (query.topologyPattern) {
		whereClauses += ' AND topology_pattern = ?';
		params.push(query.topologyPattern);
	}
	if (query.status) {
		whereClauses += ' AND status = ?';
		params.push(query.status);
	}
	if (query.search) {
		whereClauses += ' AND group_chat_name LIKE ?';
		params.push(`%${query.search}%`);
	}

	const whereSQL = whereClauses ? `WHERE 1=1${whereClauses}` : '';

	// Count total matching records
	const countResult = db
		.prepare(`SELECT COUNT(*) as total FROM team_orch_events ${whereSQL}`)
		.get(...params) as { total: number };

	// Fetch paginated results
	const rows = db
		.prepare(`SELECT * FROM team_orch_events ${whereSQL} ORDER BY start_time DESC LIMIT ? OFFSET ?`)
		.all(...params, query.limit, query.offset) as TeamOrchEventRow[];

	return {
		events: rows.map(mapTeamOrchEventRow),
		total: countResult.total,
	};
}

// ============================================================================
// Single event detail
// ============================================================================

/**
 * Get a single team orchestration event by ID.
 */
export function getTeamOrchEventDetail(db: Database.Database, id: string): TeamOrchEvent | null {
	const row = db.prepare('SELECT * FROM team_orch_events WHERE id = ?').get(id) as
		| TeamOrchEventRow
		| undefined;

	if (!row) return null;
	return mapTeamOrchEventRow(row);
}

// ============================================================================
// Export
// ============================================================================

/**
 * Export all team orchestration events after a given start time.
 */
export function exportTeamOrchEvents(db: Database.Database, startTime: number): TeamOrchEvent[] {
	const rows = db
		.prepare('SELECT * FROM team_orch_events WHERE start_time >= ? ORDER BY start_time DESC')
		.all(startTime) as TeamOrchEventRow[];

	return rows.map(mapTeamOrchEventRow);
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Convert a TeamOrchTimeRange to epoch start time.
 * Exported for use by IPC handlers.
 */
export { getTeamOrchTimeRangeStart };

/**
 * Clear the statement cache (call when database is closed).
 */
export function clearTeamOrchEventCache(): void {
	stmtCache.clear();
}
