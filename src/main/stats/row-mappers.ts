/**
 * Row Mapper Functions
 *
 * Converts snake_case SQLite row objects to camelCase TypeScript interfaces.
 * Centralizes the mapping logic that was previously duplicated across CRUD methods.
 */

import type {
	QueryEvent,
	AutoRunSession,
	AutoRunTask,
	SessionLifecycleEvent,
} from '../../shared/stats-types';
import type { TeamOrchEvent, TeamOrchParticipantStats } from '../../shared/team-orch-stats-types';
import type { MigrationRecord } from './types';

// ============================================================================
// Raw Row Types (snake_case from SQLite)
// ============================================================================

export interface QueryEventRow {
	id: string;
	session_id: string;
	agent_type: string;
	source: 'user' | 'auto';
	start_time: number;
	duration: number;
	project_path: string | null;
	tab_id: string | null;
	is_remote: number | null;
}

export interface AutoRunSessionRow {
	id: string;
	session_id: string;
	agent_type: string;
	document_path: string | null;
	start_time: number;
	duration: number;
	tasks_total: number | null;
	tasks_completed: number | null;
	project_path: string | null;
}

export interface AutoRunTaskRow {
	id: string;
	auto_run_session_id: string;
	session_id: string;
	agent_type: string;
	task_index: number;
	task_content: string | null;
	start_time: number;
	duration: number;
	success: number;
}

export interface SessionLifecycleRow {
	id: string;
	session_id: string;
	agent_type: string;
	project_path: string | null;
	created_at: number;
	closed_at: number | null;
	duration: number | null;
	is_remote: number | null;
}

export interface TeamOrchEventRow {
	id: string;
	group_chat_id: string;
	group_chat_name: string;
	template_id: string | null;
	template_name: string | null;
	topology_pattern: string;
	termination_mode: string;
	status: 'completed' | 'failed' | 'terminated';
	iteration_count: number;
	max_iterations: number;
	start_time: number;
	end_time: number;
	duration: number;
	participant_count: number;
	participant_breakdown: string | null;
	total_tokens: number;
	total_cost: number;
	moderator_agent_id: string;
	project_path: string | null;
}

export interface MigrationRecordRow {
	version: number;
	description: string;
	applied_at: number;
	status: 'success' | 'failed';
	error_message: string | null;
}

// ============================================================================
// Mapper Functions
// ============================================================================

export function mapQueryEventRow(row: QueryEventRow): QueryEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		source: row.source,
		startTime: row.start_time,
		duration: row.duration,
		projectPath: row.project_path ?? undefined,
		tabId: row.tab_id ?? undefined,
		isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
	};
}

export function mapAutoRunSessionRow(row: AutoRunSessionRow): AutoRunSession {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		documentPath: row.document_path ?? undefined,
		startTime: row.start_time,
		duration: row.duration,
		tasksTotal: row.tasks_total ?? undefined,
		tasksCompleted: row.tasks_completed ?? undefined,
		projectPath: row.project_path ?? undefined,
	};
}

export function mapAutoRunTaskRow(row: AutoRunTaskRow): AutoRunTask {
	return {
		id: row.id,
		autoRunSessionId: row.auto_run_session_id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		taskIndex: row.task_index,
		taskContent: row.task_content ?? undefined,
		startTime: row.start_time,
		duration: row.duration,
		success: row.success === 1,
	};
}

export function mapSessionLifecycleRow(row: SessionLifecycleRow): SessionLifecycleEvent {
	return {
		id: row.id,
		sessionId: row.session_id,
		agentType: row.agent_type,
		projectPath: row.project_path ?? undefined,
		createdAt: row.created_at,
		closedAt: row.closed_at ?? undefined,
		duration: row.duration ?? undefined,
		isRemote: row.is_remote !== null ? row.is_remote === 1 : undefined,
	};
}

export function mapTeamOrchEventRow(row: TeamOrchEventRow): TeamOrchEvent {
	let participantBreakdown: TeamOrchParticipantStats[] = [];
	if (row.participant_breakdown) {
		try {
			participantBreakdown = JSON.parse(row.participant_breakdown) as TeamOrchParticipantStats[];
		} catch {
			participantBreakdown = [];
		}
	}
	return {
		id: row.id,
		groupChatId: row.group_chat_id,
		groupChatName: row.group_chat_name,
		templateId: row.template_id ?? undefined,
		templateName: row.template_name ?? undefined,
		topologyPattern: row.topology_pattern,
		terminationMode: row.termination_mode,
		status: row.status,
		iterationCount: row.iteration_count,
		maxIterations: row.max_iterations,
		startTime: row.start_time,
		endTime: row.end_time,
		duration: row.duration,
		participantCount: row.participant_count,
		participantBreakdown,
		totalTokens: row.total_tokens,
		totalCost: row.total_cost,
		moderatorAgentId: row.moderator_agent_id,
		projectPath: row.project_path ?? undefined,
	};
}

export function mapMigrationRecordRow(row: MigrationRecordRow): MigrationRecord {
	return {
		version: row.version,
		description: row.description,
		appliedAt: row.applied_at,
		status: row.status,
		errorMessage: row.error_message ?? undefined,
	};
}
