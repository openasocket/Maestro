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
 * - Shimmer skeleton loading state
 * - Empty state with contextual message
 */

import React, { memo, useState } from 'react';
import { Search } from 'lucide-react';
import type { Theme } from '../../types';
import { useTeamOrchHistory } from '../../hooks/teamOrch/useTeamOrchHistory';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import {
	formatDuration,
	formatTokenCount,
	topologyDisplayName,
	statusColor,
} from './teamOrchUtils';

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

function SkeletonRow({ theme, index }: { theme: Theme; index: number }) {
	return (
		<tr
			style={{
				backgroundColor: index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity,
			}}
		>
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

export const HistoryTab = memo(function HistoryTab({ theme }: HistoryTabProps) {
	const history = useTeamOrchHistory(true);
	const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

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

	// Pagination calculations
	const startItem = history.page * history.pageSize + 1;
	const endItem = Math.min((history.page + 1) * history.pageSize, history.total);
	const isFirstPage = history.page === 0;
	const isLastPage = history.page >= history.totalPages - 1;

	return (
		<div className="space-y-4" data-testid="history-tab">
			{/* Search Bar */}
			<div className="relative">
				<Search
					className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
					style={{ color: theme.colors.textDim }}
				/>
				<input
					type="text"
					placeholder="Search past workflows..."
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
					<table className="w-full text-sm" data-testid="history-skeleton">
						<thead>
							<tr style={{ borderBottom: `1px solid ${theme.colors.border}` }}>
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
								{history.events.map((event, index) => (
									<React.Fragment key={event.id}>
										<tr
											className="cursor-pointer transition-colors"
											style={{
												backgroundColor:
													index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity,
											}}
											onClick={() => handleRowClick(event.id)}
											onMouseEnter={(e) => {
												e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
											}}
											onMouseLeave={(e) => {
												e.currentTarget.style.backgroundColor =
													index % 2 === 0 ? theme.colors.bgMain : theme.colors.bgActivity;
											}}
											data-testid={`history-row-${event.id}`}
										>
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
										{expandedEventId === event.id && (
											<tr>
												<td
													colSpan={7}
													className="px-6 py-4 border-t"
													style={{
														backgroundColor: theme.colors.bgActivity,
														borderColor: theme.colors.border,
													}}
													data-testid={`history-detail-${event.id}`}
												>
													<div className="text-xs" style={{ color: theme.colors.textDim }}>
														Expanded detail — see next task
													</div>
												</td>
											</tr>
										)}
									</React.Fragment>
								))}
							</tbody>
						</table>
					</div>

					{/* Pagination */}
					{history.total > 0 && (
						<div
							className="flex items-center justify-between text-sm"
							data-testid="history-pagination"
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
								>
									Previous
								</button>

								{Array.from({ length: history.totalPages }).map((_, i) => (
									<button
										key={i}
										onClick={() => history.setPage(i)}
										className="w-8 h-8 rounded text-xs font-medium transition-colors"
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
