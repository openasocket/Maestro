/**
 * Preload API for Team Orchestration Stats
 *
 * Provides the window.maestro.teamOrchStats namespace for:
 * - Recording team orchestration workflow events
 * - Querying aggregated stats for dashboard display
 * - Paginated history with filters
 * - Event detail view
 * - CSV and JSON export
 * - Real-time stats update subscription
 */

import { ipcRenderer } from 'electron';
import type {
	TeamOrchEvent,
	TeamOrchAggregation,
	TeamOrchTimeRange,
	TeamOrchHistoryQuery,
	TeamOrchHistoryResult,
} from '../../shared/team-orch-stats-types';

/**
 * Creates the Team Orchestration Stats API object for preload exposure
 */
export function createTeamOrchStatsApi() {
	return {
		// Record a team orchestration workflow event
		record: (event: TeamOrchEvent): Promise<string | null> =>
			ipcRenderer.invoke('teamOrchStats:record', event),

		// Get aggregated statistics for dashboard display
		getAggregation: (range: TeamOrchTimeRange): Promise<TeamOrchAggregation> =>
			ipcRenderer.invoke('teamOrchStats:getAggregation', range),

		// Get paginated event history with optional filters
		getHistory: (query: TeamOrchHistoryQuery): Promise<TeamOrchHistoryResult> =>
			ipcRenderer.invoke('teamOrchStats:getHistory', query),

		// Get a single event's full details
		getEventDetail: (id: string): Promise<TeamOrchEvent | null> =>
			ipcRenderer.invoke('teamOrchStats:getEventDetail', id),

		// Export events as CSV (shows save dialog)
		exportCsv: (range: TeamOrchTimeRange): Promise<{ saved: boolean; path: string | null }> =>
			ipcRenderer.invoke('teamOrchStats:exportCsv', range),

		// Export events as JSON (shows save dialog)
		exportJson: (range: TeamOrchTimeRange): Promise<{ saved: boolean; path: string | null }> =>
			ipcRenderer.invoke('teamOrchStats:exportJson', range),

		// Subscribe to stats updates (for real-time dashboard refresh)
		onStatsUpdate: (callback: () => void): (() => void) => {
			const handler = () => callback();
			ipcRenderer.on('teamOrchStats:updated', handler);
			return () => {
				ipcRenderer.removeListener('teamOrchStats:updated', handler);
			};
		},
	};
}

export type TeamOrchStatsApi = ReturnType<typeof createTeamOrchStatsApi>;
