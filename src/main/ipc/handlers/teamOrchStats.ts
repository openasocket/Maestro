/**
 * Team Orchestration Stats IPC Handlers
 *
 * Provides IPC handlers for recording, querying, and exporting team orchestration
 * workflow analytics data for the Team Orchestration Management Modal dashboard.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import { logger } from '../../utils/logger';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import { getStatsDB } from '../../stats';
import type {
	TeamOrchEvent,
	TeamOrchTimeRange,
	TeamOrchHistoryQuery,
} from '../../../shared/team-orch-stats-types';

const LOG_CONTEXT = '[TeamOrchStats]';

// Helper to create handler options with consistent context
const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Dependencies for team orchestration stats handlers
 */
export interface TeamOrchStatsHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	settingsStore?: {
		get: (key: string) => unknown;
	};
}

/**
 * Check if stats collection is enabled
 */
function isStatsCollectionEnabled(settingsStore?: { get: (key: string) => unknown }): boolean {
	if (!settingsStore) return true;
	const enabled = settingsStore.get('statsCollectionEnabled');
	return enabled !== false;
}

/**
 * Broadcast team orch stats update to renderer
 */
function broadcastTeamOrchStatsUpdate(getMainWindow: () => BrowserWindow | null): void {
	const mainWindow = getMainWindow();
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send('teamOrchStats:updated');
	}
}

/**
 * Format team orch events as CSV string
 */
function formatEventsCsv(events: TeamOrchEvent[]): string {
	const headers = [
		'id',
		'group_chat_id',
		'group_chat_name',
		'template_id',
		'template_name',
		'topology_pattern',
		'termination_mode',
		'status',
		'iteration_count',
		'max_iterations',
		'start_time',
		'end_time',
		'duration',
		'participant_count',
		'total_tokens',
		'total_cost',
		'moderator_agent_id',
		'project_path',
	];

	const rows = events.map((e) =>
		[
			e.id,
			e.groupChatId,
			`"${e.groupChatName.replace(/"/g, '""')}"`,
			e.templateId ?? '',
			e.templateName ? `"${e.templateName.replace(/"/g, '""')}"` : '',
			e.topologyPattern,
			e.terminationMode,
			e.status,
			e.iterationCount,
			e.maxIterations,
			e.startTime,
			e.endTime,
			e.duration,
			e.participantCount,
			e.totalTokens,
			e.totalCost,
			e.moderatorAgentId,
			e.projectPath ?? '',
		].join(',')
	);

	return [headers.join(','), ...rows].join('\n');
}

/**
 * Register all Team Orchestration Stats IPC handlers.
 */
export function registerTeamOrchStatsHandlers(deps: TeamOrchStatsHandlerDependencies): void {
	const { getMainWindow, settingsStore } = deps;

	// Record a team orchestration event
	ipcMain.handle(
		'teamOrchStats:record',
		withIpcErrorLogging(handlerOpts('record'), async (event: TeamOrchEvent) => {
			if (!isStatsCollectionEnabled(settingsStore)) {
				logger.debug('Stats collection disabled, skipping team orch event', LOG_CONTEXT);
				return null;
			}

			const db = getStatsDB();
			db.insertTeamOrchEvent(event);
			logger.debug(`Recorded team orch event: ${event.id}`, LOG_CONTEXT, {
				groupChatId: event.groupChatId,
				status: event.status,
				topologyPattern: event.topologyPattern,
			});
			broadcastTeamOrchStatsUpdate(getMainWindow);
			return event.id;
		})
	);

	// Get aggregated stats for dashboard
	ipcMain.handle(
		'teamOrchStats:getAggregation',
		withIpcErrorLogging(handlerOpts('getAggregation'), async (range: TeamOrchTimeRange) => {
			const db = getStatsDB();
			return db.getTeamOrchAggregation(range);
		})
	);

	// Get paginated history with filters
	ipcMain.handle(
		'teamOrchStats:getHistory',
		withIpcErrorLogging(handlerOpts('getHistory'), async (query: TeamOrchHistoryQuery) => {
			const db = getStatsDB();
			return db.getTeamOrchHistory(query);
		})
	);

	// Get single event detail
	ipcMain.handle(
		'teamOrchStats:getEventDetail',
		withIpcErrorLogging(handlerOpts('getEventDetail'), async (id: string) => {
			const db = getStatsDB();
			return db.getTeamOrchEventDetail(id);
		})
	);

	// Export events as CSV via save dialog
	ipcMain.handle(
		'teamOrchStats:exportCsv',
		withIpcErrorLogging(handlerOpts('exportCsv'), async (range: TeamOrchTimeRange) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				throw new Error('No main window available');
			}

			const db = getStatsDB();
			const events = db.exportTeamOrchEvents(range);
			const csv = formatEventsCsv(events);

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const defaultFilename = `team-orch-events-${timestamp}.csv`;

			const result = await dialog.showSaveDialog(mainWindow, {
				title: 'Export Team Orchestration Events',
				defaultPath: defaultFilename,
				filters: [{ name: 'CSV Files', extensions: ['csv'] }],
			});

			if (result.canceled || !result.filePath) {
				return { saved: false, path: null };
			}

			fs.writeFileSync(result.filePath, csv, 'utf-8');
			logger.info(`Exported ${events.length} team orch events to CSV`, LOG_CONTEXT, {
				path: result.filePath,
			});
			return { saved: true, path: result.filePath };
		})
	);

	// Export events as JSON via save dialog
	ipcMain.handle(
		'teamOrchStats:exportJson',
		withIpcErrorLogging(handlerOpts('exportJson'), async (range: TeamOrchTimeRange) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				throw new Error('No main window available');
			}

			const db = getStatsDB();
			const events = db.exportTeamOrchEvents(range);
			const json = JSON.stringify(events, null, 2);

			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const defaultFilename = `team-orch-events-${timestamp}.json`;

			const result = await dialog.showSaveDialog(mainWindow, {
				title: 'Export Team Orchestration Events',
				defaultPath: defaultFilename,
				filters: [{ name: 'JSON Files', extensions: ['json'] }],
			});

			if (result.canceled || !result.filePath) {
				return { saved: false, path: null };
			}

			fs.writeFileSync(result.filePath, json, 'utf-8');
			logger.info(`Exported ${events.length} team orch events to JSON`, LOG_CONTEXT, {
				path: result.filePath,
			});
			return { saved: true, path: result.filePath };
		})
	);
}
