/**
 * HistoryTab
 *
 * Searchable, filterable, paginated table of past team orchestration workflow executions.
 * Displays Date, Group Chat, Topology, Iterations, Duration, Tokens, and Status columns
 * with alternating row backgrounds, clickable expansion, and filter/pagination controls.
 *
 * Features:
 * - Debounced search via useTeamOrchHistory hook
 * - Topology and status dropdown filters
 * - Paginated results table with alternating row styles
 * - Expandable row detail with participant breakdown and execution log
 * - Export to JSON and CSV
 * - Shimmer skeleton loading state
 * - Empty state with contextual message
 */

import React, { memo, useState, useEffect, useCallback } from 'react';
import { Search, Download, FileText, ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../types';
import type { TeamOrchEvent } from '../../../shared/team-orch-stats-types';
import { useTeamOrchHistory } from '../../hooks/teamOrch/useTeamOrchHistory';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import {
	formatDuration,
	formatTokenCount,
	formatCost,
	topologyDisplayName,
	statusColor,
} from './teamOrchUtils';

interface GroupChatHistoryEntry {
	id: string;
	timestamp: number;
	summary: string;
	participantName: string;
	participantColor: string;
	type: 'delegation' | 'response' | 'synthesis' | 'error';
	elapsedTimeMs?: number;
	tokenCount?: number;
	cost?: number;
	fullResponse?: string;
}

interface HistoryTabProps {
	theme: Theme;
}

const TOPOLOGY_OPTIONS = [
	{ value: '', label: 'All Topologies' },
	{ value: 'hub-spoke', label: 'Hub & Spoke' },
	{ value: 'pipeline', label: 'Pipeline' },
	{ value: 'parallel-then-merge', label: 'Parallel Merge' },
	{ value: 'review-loop', label: 'Review Loop' },
	{ value: 'custom', label: 'Custom' },
];

const STATUS_OPTIONS = [
	{ value: '', label: 'All Statuses' },
	{ value: 'completed', label: 'Completed' },
	{ value: 'failed', label: 'Failed' },
	{ value: 'terminated', label: 'Terminated' },
];

function formatDate(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	})} ${date.toLocaleTimeString('en-US', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	})}`;
}

function statusLabel(status: string): string {
	return status.charAt(0).toUpperCase() + status.slice(1);
}

const ENTRY_TYPE_COLORS: Record<string, { bg: string; text: string }> = {
	delegation: { bg: '#3b82f620', text: '#3b82f6' },
	response: { bg: '#10b98120', text: '#10b981' },
	synthesis: { bg: '#8b5cf620', text: '#8b5cf6' },
	error: { bg: '#ef444420', text: '#ef4444' },
};

function entryTypeBadge(type: string, theme: Theme) {
	const colors = ENTRY_TYPE_COLORS[type] ?? {
		bg: `${theme.colors.textDim}20`,
		text: theme.colors.textDim,
	};
	return colors;
}

function SkeletonRow({ theme, index }: { theme: Theme; index: number }) {
	return (
		<tr
			style={{
				backgroundColor: index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity,
			}}
		>
			<td className="px-2 py-3" style={{ width: 28 }} />
			{Array.from({ length: 7 }).map((_, col) => (
				<td key={col} className="px-3 py-3">
					<div
						className="rounded"
						style={{
							backgroundColor: theme.colors.border,
							opacity: 0.3,
							animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
							animationDelay: `${index * 100}ms`,
							height: 14,
							width: col === 0 ? '80%' : col === 1 ? '70%' : '60%',
						}}
					/>
				</td>
			))}
		</tr>
	);
}

/**
 * Expanded detail panel for a single history event row.
 * Shows participant breakdown, execution summary, and execution log timeline.
 */
function ExpandedDetail({ event, theme }: { event: TeamOrchEvent; theme: Theme }) {
	const [executionLog, setExecutionLog] = useState<GroupChatHistoryEntry[] | null>(null);
	const [logLoading, setLogLoading] = useState(false);
	const [logError, setLogError] = useState<string | null>(null);

	// Sort participants by tokens descending
	const sortedParticipants = [...event.participantBreakdown].sort(
		(a, b) => b.tokenCount - a.tokenCount
	);

	// Fetch execution log from group chat history
	useEffect(() => {
		let cancelled = false;

		async function fetchLog() {
			setLogLoading(true);
			setLogError(null);
			try {
				// Check if the group chat still exists
				const chats = await window.maestro.groupChat.list();
				const chatExists =
					Array.isArray(chats) && chats.some((c: { id: string }) => c.id === event.groupChatId);
				if (!chatExists) {
					if (!cancelled) setLogError('Execution log unavailable');
					return;
				}
				const entries = await window.maestro.groupChat.getHistory(event.groupChatId);
				if (!cancelled) {
					setExecutionLog(Array.isArray(entries) ? entries : []);
				}
			} catch {
				if (!cancelled) setLogError('Execution log unavailable');
			} finally {
				if (!cancelled) setLogLoading(false);
			}
		}

		fetchLog();
		return () => {
			cancelled = true;
		};
	}, [event.groupChatId]);

	return (
		<div className="space-y-4">
			{/* Participant Breakdown */}
			<div>
				<h4
					className="text-xs font-semibold mb-2 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Participant Breakdown
				</h4>
				<div
					className="rounded border overflow-hidden ml-2"
					style={{ borderColor: theme.colors.border }}
				>
					<table className="w-full text-xs">
						<thead>
							<tr style={{ borderBottom: `1px solid ${theme.colors.border}` }}>
								{['Name', 'Agent', 'Tokens', 'Messages', 'Time', 'Cost'].map((col) => (
									<th
										key={col}
										className="px-3 py-1.5 text-left font-medium"
										style={{ color: theme.colors.textDim }}
									>
										{col}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{sortedParticipants.map((p, i) => (
								<tr
									key={p.name}
									style={{
										backgroundColor: i % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity,
									}}
								>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textMain }}>
										{p.name}
									</td>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textDim }}>
										{p.agentId}
									</td>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textMain }}>
										{formatTokenCount(p.tokenCount)}
									</td>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textMain }}>
										{p.messageCount}
									</td>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textDim }}>
										{formatDuration(p.processingTimeMs)}
									</td>
									<td className="px-3 py-1.5" style={{ color: theme.colors.textDim }}>
										{formatCost(p.cost)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{/* Execution Summary */}
			<div>
				<h4
					className="text-xs font-semibold mb-2 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Execution Summary
				</h4>
				<div className="grid grid-cols-2 gap-x-6 gap-y-1 ml-2 text-xs">
					{event.templateName && (
						<>
							<span style={{ color: theme.colors.textDim }}>Template</span>
							<span style={{ color: theme.colors.textMain }}>{event.templateName}</span>
						</>
					)}
					<span style={{ color: theme.colors.textDim }}>Moderator</span>
					<span style={{ color: theme.colors.textMain }}>{event.moderatorAgentId}</span>
					<span style={{ color: theme.colors.textDim }}>Topology</span>
					<span style={{ color: theme.colors.textMain }}>
						{topologyDisplayName(event.topologyPattern)}
					</span>
					<span style={{ color: theme.colors.textDim }}>Termination</span>
					<span style={{ color: theme.colors.textMain }}>{event.terminationMode}</span>
					<span style={{ color: theme.colors.textDim }}>Start</span>
					<span style={{ color: theme.colors.textMain }}>{formatDate(event.startTime)}</span>
					<span style={{ color: theme.colors.textDim }}>End</span>
					<span style={{ color: theme.colors.textMain }}>{formatDate(event.endTime)}</span>
					<span style={{ color: theme.colors.textDim }}>Total Cost</span>
					<span style={{ color: theme.colors.textMain }}>{formatCost(event.totalCost)}</span>
				</div>
			</div>

			{/* Execution Log */}
			<div>
				<h4
					className="text-xs font-semibold mb-2 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Execution Log
				</h4>
				{logLoading ? (
					<div className="ml-2 text-xs" style={{ color: theme.colors.textDim }} aria-live="polite">
						Loading execution log...
					</div>
				) : logError ? (
					<div className="ml-2 text-xs" style={{ color: theme.colors.textDim }} aria-live="polite">
						{logError}
					</div>
				) : executionLog && executionLog.length > 0 ? (
					<div className="ml-2 space-y-1.5 max-h-60 overflow-y-auto">
						{executionLog.map((entry) => {
							const badgeColors = entryTypeBadge(entry.type, theme);
							return (
								<div key={entry.id} className="flex items-start gap-2 text-xs">
									<div
										className="flex-shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full"
										style={{ backgroundColor: badgeColors.text }}
									/>
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span
												className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
												style={{
													backgroundColor: badgeColors.bg,
													color: badgeColors.text,
												}}
											>
												{entry.type}
											</span>
											<span style={{ color: theme.colors.accent }}>{entry.participantName}</span>
											<span style={{ color: theme.colors.textDim }}>
												{new Date(entry.timestamp).toLocaleTimeString('en-US', {
													hour: '2-digit',
													minute: '2-digit',
													second: '2-digit',
													hour12: false,
												})}
											</span>
										</div>
										<div
											className="mt-0.5 truncate"
											style={{ color: theme.colors.textMain }}
											title={entry.summary}
										>
											{entry.summary}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<div className="ml-2 text-xs" style={{ color: theme.colors.textDim }}>
						No log entries available
					</div>
				)}
			</div>
		</div>
	);
}

export const HistoryTab = memo(function HistoryTab({ theme }: HistoryTabProps) {
	const history = useTeamOrchHistory(true);
	const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
	const [exporting, setExporting] = useState<'json' | 'csv' | null>(null);

	const hasActiveFilters =
		!!history.topologyFilter || !!history.statusFilter || !!history.searchQuery;

	const handleTopologyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		history.setTopologyFilter(e.target.value || undefined);
	};

	const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		history.setStatusFilter(e.target.value || undefined);
	};

	const handleRowClick = (eventId: string) => {
		setExpandedEventId((prev) => (prev === eventId ? null : eventId));
	};

	const handleExportJson = useCallback(async () => {
		if (exporting) return;
		setExporting('json');
		try {
			await window.maestro.teamOrchStats.exportJson('all');
		} catch {
			// Silently fail — Sentry will capture unexpected errors
		} finally {
			setExporting(null);
		}
	}, [exporting]);

	const handleExportCsv = useCallback(async () => {
		if (exporting) return;
		setExporting('csv');
		try {
			await window.maestro.teamOrchStats.exportCsv('all');
		} catch {
			// Silently fail — Sentry will capture unexpected errors
		} finally {
			setExporting(null);
		}
	}, [exporting]);

	// Pagination calculations
	const startItem = history.page * history.pageSize + 1;
	const endItem = Math.min((history.page + 1) * history.pageSize, history.total);
	const isFirstPage = history.page === 0;
	const isLastPage = history.page >= history.totalPages - 1;

	return (
		<div className="space-y-4" data-testid="history-tab">
			{/* Header with Search and Export */}
			<div className="flex items-center gap-3">
				{/* Search Bar */}
				<div className="relative flex-1">
					<Search
						className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
					<input
						type="text"
						placeholder="Search past workflows..."
						aria-label="Search past workflows"
						value={history.searchQuery}
						onChange={(e) => history.setSearchQuery(e.target.value)}
						className="w-full pl-10 pr-4 py-2 rounded-lg text-sm border outline-none"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						data-testid="history-search"
					/>
				</div>

				{/* Export Buttons */}
				<button
					onClick={handleExportJson}
					disabled={!!exporting}
					className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: exporting === 'json' ? `${theme.colors.accent}20` : 'transparent',
						color: theme.colors.textMain,
						opacity: exporting && exporting !== 'json' ? 0.5 : 1,
						cursor: exporting ? 'not-allowed' : 'pointer',
					}}
					data-testid="export-json-btn"
					aria-label="Export workflow history as JSON"
				>
					<Download className={`w-3.5 h-3.5 ${exporting === 'json' ? 'animate-pulse' : ''}`} />
					Export JSON
				</button>
				<button
					onClick={handleExportCsv}
					disabled={!!exporting}
					className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap"
					style={{
						borderColor: theme.colors.border,
						backgroundColor: exporting === 'csv' ? `${theme.colors.accent}20` : 'transparent',
						color: theme.colors.textMain,
						opacity: exporting && exporting !== 'csv' ? 0.5 : 1,
						cursor: exporting ? 'not-allowed' : 'pointer',
					}}
					data-testid="export-csv-btn"
					aria-label="Export workflow history as CSV"
				>
					<FileText className={`w-3.5 h-3.5 ${exporting === 'csv' ? 'animate-pulse' : ''}`} />
					Export CSV
				</button>
			</div>

			{/* Filter Row */}
			<div className="flex gap-3" data-testid="history-filters">
				<select
					value={history.topologyFilter ?? ''}
					onChange={handleTopologyChange}
					className="px-3 py-2 rounded-lg text-sm border outline-none cursor-pointer appearance-none"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="topology-filter"
					aria-label="Filter by topology"
				>
					{TOPOLOGY_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>

				<select
					value={history.statusFilter ?? ''}
					onChange={handleStatusChange}
					className="px-3 py-2 rounded-lg text-sm border outline-none cursor-pointer appearance-none"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					data-testid="status-filter"
					aria-label="Filter by status"
				>
					{STATUS_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
			</div>

			{/* Results Table */}
			{history.loading ? (
				<div
					className="overflow-x-auto rounded-lg border"
					style={{ borderColor: theme.colors.border }}
				>
					<table className="w-full text-sm" data-testid="history-skeleton" aria-busy="true">
						<thead>
							<tr style={{ borderBottom: `1px solid ${theme.colors.border}` }}>
								{[
									'',
									'Date',
									'Group Chat',
									'Topology',
									'Iterations',
									'Duration',
									'Tokens',
									'Status',
								].map((col) => (
									<th
										key={col || 'expand'}
										className="px-3 py-2 text-left text-xs font-medium"
										style={{ color: theme.colors.textDim, width: col === '' ? 28 : undefined }}
									>
										{col}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{Array.from({ length: 5 }).map((_, i) => (
								<SkeletonRow key={i} theme={theme} index={i} />
							))}
						</tbody>
					</table>
				</div>
			) : history.events.length === 0 ? (
				<TeamOrchEmptyState
					theme={theme}
					message={hasActiveFilters ? 'No results match your filters' : 'No workflow history yet'}
				/>
			) : (
				<>
					<div
						className="overflow-x-auto rounded-lg border"
						style={{ borderColor: theme.colors.border }}
						data-testid="history-table"
					>
						<table className="w-full text-sm">
							<thead>
								<tr style={{ borderBottom: `1px solid ${theme.colors.border}` }}>
									<th
										className="px-2 py-2 text-left text-xs font-medium"
										style={{ color: theme.colors.textDim, width: 28 }}
									/>
									{[
										'Date',
										'Group Chat',
										'Topology',
										'Iterations',
										'Duration',
										'Tokens',
										'Status',
									].map((col) => (
										<th
											key={col}
											className="px-3 py-2 text-left text-xs font-medium"
											style={{ color: theme.colors.textDim }}
										>
											{col}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{history.events.map((event, index) => {
									const isExpanded = expandedEventId === event.id;
									return (
										<React.Fragment key={event.id}>
											<tr
												className="cursor-pointer transition-colors"
												style={{
													backgroundColor:
														index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity,
												}}
												onClick={() => handleRowClick(event.id)}
												onKeyDown={(e) => {
													if (e.key === 'Enter' || e.key === ' ') {
														e.preventDefault();
														handleRowClick(event.id);
													}
												}}
												tabIndex={0}
												aria-expanded={isExpanded}
												aria-label={`${event.groupChatName} - ${statusLabel(event.status)} - ${formatDate(event.startTime)}`}
												onMouseEnter={(e) => {
													e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
												}}
												onMouseLeave={(e) => {
													e.currentTarget.style.backgroundColor =
														index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity;
												}}
												data-testid={`history-row-${event.id}`}
											>
												<td className="px-2 py-2.5" style={{ color: theme.colors.textDim }}>
													{isExpanded ? (
														<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
													) : (
														<ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
													)}
												</td>
												<td
													className="px-3 py-2.5 whitespace-nowrap"
													style={{ color: theme.colors.textMain }}
												>
													{formatDate(event.startTime)}
												</td>
												<td className="px-3 py-2.5" style={{ color: theme.colors.accent }}>
													{event.groupChatName}
												</td>
												<td className="px-3 py-2.5">
													<span
														className="inline-block px-2 py-0.5 rounded text-xs font-medium"
														style={{
															backgroundColor: `${theme.colors.accent}15`,
															color: theme.colors.accent,
														}}
													>
														{topologyDisplayName(event.topologyPattern)}
													</span>
												</td>
												<td
													className="px-3 py-2.5 whitespace-nowrap"
													style={{ color: theme.colors.textMain }}
												>
													{event.iterationCount} / {event.maxIterations}
												</td>
												<td
													className="px-3 py-2.5 whitespace-nowrap"
													style={{ color: theme.colors.textDim }}
												>
													{formatDuration(event.duration)}
												</td>
												<td
													className="px-3 py-2.5 whitespace-nowrap"
													style={{ color: theme.colors.textDim }}
												>
													{formatTokenCount(event.totalTokens)}
												</td>
												<td className="px-3 py-2.5">
													<span
														className="inline-block px-2 py-0.5 rounded text-xs font-medium"
														style={{
															backgroundColor: `${statusColor(event.status, theme)}20`,
															color: statusColor(event.status, theme),
														}}
													>
														{statusLabel(event.status)}
													</span>
												</td>
											</tr>
											{isExpanded && (
												<tr>
													<td
														colSpan={8}
														className="px-6 py-4 border-t"
														style={{
															backgroundColor: theme.colors.bgActivity,
															borderColor: theme.colors.border,
														}}
														data-testid={`history-detail-${event.id}`}
													>
														<ExpandedDetail event={event} theme={theme} />
													</td>
												</tr>
											)}
										</React.Fragment>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Pagination */}
					{history.total > 0 && (
						<div
							className="flex items-center justify-between text-sm"
							data-testid="history-pagination"
							role="navigation"
							aria-label="Workflow history pagination"
						>
							<span style={{ color: theme.colors.textDim }}>
								Showing {startItem}–{endItem} of {history.total}
							</span>

							<div className="flex items-center gap-2">
								<button
									onClick={() => history.setPage(history.page - 1)}
									disabled={isFirstPage}
									className="px-3 py-1.5 rounded text-xs font-medium border transition-colors"
									style={{
										borderColor: theme.colors.border,
										color: isFirstPage ? theme.colors.textDim : theme.colors.textMain,
										opacity: isFirstPage ? 0.5 : 1,
										cursor: isFirstPage ? 'not-allowed' : 'pointer',
										backgroundColor: 'transparent',
									}}
									aria-label="Previous page"
								>
									Previous
								</button>

								{Array.from({ length: history.totalPages }).map((_, i) => (
									<button
										key={i}
										onClick={() => history.setPage(i)}
										className="w-8 h-8 rounded text-xs font-medium transition-colors"
										aria-label={`Page ${i + 1}`}
										aria-current={i === history.page ? 'page' : undefined}
										style={{
											backgroundColor:
												i === history.page ? `${theme.colors.accent}20` : 'transparent',
											color: i === history.page ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{i + 1}
									</button>
								))}

								<button
									onClick={() => history.setPage(history.page + 1)}
									disabled={isLastPage}
									className="px-3 py-1.5 rounded text-xs font-medium border transition-colors"
									style={{
										borderColor: theme.colors.border,
										color: isLastPage ? theme.colors.textDim : theme.colors.textMain,
										opacity: isLastPage ? 0.5 : 1,
										cursor: isLastPage ? 'not-allowed' : 'pointer',
										backgroundColor: 'transparent',
									}}
									aria-label="Next page"
								>
									Next
								</button>
							</div>
						</div>
					)}
				</>
			)}
		</div>
	);
});

export default HistoryTab;
