/**
 * RolloutComparisonTable
 *
 * Table showing recent rollout groups with expandable details.
 * Displays group-level metrics and per-rollout breakdown.
 *
 * Features:
 * - Expandable rows showing individual rollout details
 * - Reward signals displayed as colored badges
 * - Operations column: +N ~N -N for add/modify/delete counts
 * - "no var" label when variance below threshold
 * - Pagination for large histories
 * - Theme-aware styling with inline styles
 */

import React, { useState, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { Theme } from '../../types';
import type { RolloutGroupSummary, RewardSignalType } from '../../../shared/grpo-types';

interface RolloutComparisonTableProps {
	/** Rollout group summaries from GRPO stats */
	rolloutGroups: RolloutGroupSummary[];
	/** Current theme for styling */
	theme: Theme;
	/** Minimum variance threshold for meaningful learning (default: 0.1) */
	varianceThreshold?: number;
	/** Page size for pagination (default: 10) */
	pageSize?: number;
}

/** Reward signal type → pass/fail classification */
const PASS_SIGNALS: Set<RewardSignalType> = new Set([
	'test-pass',
	'build-success',
	'lint-clean',
	'task-complete',
]);

/**
 * Get badge color for a reward signal.
 */
function getSignalColor(signal: RewardSignalType): string {
	if (PASS_SIGNALS.has(signal)) return '#22c55e'; // green
	return '#ef4444'; // red
}

/**
 * Format reward signal as short label.
 */
function formatSignal(signal: RewardSignalType): string {
	return signal.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Format operations as +N ~N -N string.
 */
function formatOperations(ops: { add: number; modify: number; delete: number }): string {
	if (ops.add === 0 && ops.modify === 0 && ops.delete === 0) return '—';
	const parts: string[] = [];
	if (ops.add > 0) parts.push(`+${ops.add}`);
	if (ops.modify > 0) parts.push(`~${ops.modify}`);
	if (ops.delete > 0) parts.push(`-${ops.delete}`);
	return parts.join(' ');
}

/**
 * Truncate a string with ellipsis.
 */
function truncate(str: string, maxLen: number): string {
	if (str.length <= maxLen) return str;
	return str.slice(0, maxLen - 2) + '..';
}

export function RolloutComparisonTable({
	rolloutGroups,
	theme,
	varianceThreshold = 0.1,
	pageSize = 10,
}: RolloutComparisonTableProps) {
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	const [currentPage, setCurrentPage] = useState(0);

	const toggleGroup = useCallback((groupId: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			return next;
		});
	}, []);

	const totalPages = useMemo(
		() => Math.max(1, Math.ceil(rolloutGroups.length / pageSize)),
		[rolloutGroups.length, pageSize]
	);

	const paginatedGroups = useMemo(
		() => rolloutGroups.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
		[rolloutGroups, currentPage, pageSize]
	);

	const headerStyle: React.CSSProperties = {
		color: theme.colors.textDim,
		borderBottomColor: theme.colors.border,
	};

	const cellStyle: React.CSSProperties = {
		color: theme.colors.textMain,
		borderBottomColor: `${theme.colors.border}40`,
	};

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Rollout comparison table showing ${rolloutGroups.length} groups`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Rollout Groups
				</h3>
				{rolloutGroups.length > 0 && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{rolloutGroups.length} group{rolloutGroups.length !== 1 ? 's' : ''}
					</span>
				)}
			</div>

			{rolloutGroups.length === 0 ? (
				<div
					className="flex items-center justify-center h-32"
					style={{ color: theme.colors.textDim }}
				>
					<span className="text-sm">No rollout groups yet</span>
				</div>
			) : (
				<>
					{/* Table */}
					<div className="overflow-x-auto">
						<table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
							<thead>
								<tr>
									<th className="text-left py-2 px-2 font-medium border-b" style={headerStyle}>Group</th>
									<th className="text-left py-2 px-2 font-medium border-b" style={headerStyle}>Task</th>
									<th className="text-center py-2 px-2 font-medium border-b" style={headerStyle}>Size</th>
									<th className="text-center py-2 px-2 font-medium border-b" style={headerStyle}>Mean Reward</th>
									<th className="text-center py-2 px-2 font-medium border-b" style={headerStyle}>Variance</th>
									<th className="text-center py-2 px-2 font-medium border-b" style={headerStyle}>Operations</th>
								</tr>
							</thead>
							<tbody>
								{paginatedGroups.map((group) => {
									const isExpanded = expandedGroups.has(group.id);
									const lowVariance = group.rewardStdDev < varianceThreshold;

									return (
										<React.Fragment key={group.id}>
											{/* Group row */}
											<tr
												className="cursor-pointer"
												style={{
													backgroundColor: isExpanded
														? `${theme.colors.accent}08`
														: undefined,
												}}
												onClick={() => toggleGroup(group.id)}
												role="row"
												aria-expanded={isExpanded}
											>
												<td className="py-2 px-2 border-b" style={cellStyle}>
													<div className="flex items-center gap-1">
														{isExpanded
															? <ChevronDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
															: <ChevronRight className="w-3 h-3" style={{ color: theme.colors.textDim }} />
														}
														<span className="font-mono">{truncate(group.id, 8)}</span>
													</div>
												</td>
												<td
													className="py-2 px-2 border-b max-w-[160px] truncate"
													style={cellStyle}
													title={group.taskPrompt}
												>
													{truncate(group.taskPrompt, 30)}
												</td>
												<td className="py-2 px-2 border-b text-center" style={cellStyle}>
													{group.groupSize}
												</td>
												<td className="py-2 px-2 border-b text-center" style={cellStyle}>
													{group.meanReward.toFixed(2)}
												</td>
												<td className="py-2 px-2 border-b text-center" style={cellStyle}>
													{lowVariance ? (
														<span
															className="px-1.5 py-0.5 rounded text-xs"
															style={{
																backgroundColor: `${theme.colors.textDim}20`,
																color: theme.colors.textDim,
															}}
														>
															no var
														</span>
													) : (
														group.rewardStdDev.toFixed(2)
													)}
												</td>
												<td className="py-2 px-2 border-b text-center font-mono" style={cellStyle}>
													{formatOperations(group.operations)}
												</td>
											</tr>

											{/* Expanded rollout details */}
											{isExpanded && group.rollouts.map((rollout) => (
												<tr
													key={`${group.id}-${rollout.index}`}
													style={{
														backgroundColor: `${theme.colors.accent}05`,
													}}
												>
													<td
														colSpan={6}
														className="py-1.5 px-2 border-b"
														style={{
															...cellStyle,
															paddingLeft: '2rem',
														}}
													>
														<div className="flex items-center gap-3">
															<span style={{ color: theme.colors.textDim }}>
																Rollout {rollout.index + 1}:
															</span>
															<span className="font-medium">
																{rollout.agentType}
															</span>
															<span style={{ color: theme.colors.textDim }}>
																score: {rollout.aggregateReward.toFixed(2)}
															</span>
															<div className="flex items-center gap-1">
																{rollout.rewardSignals.map((signal, i) => (
																	<span
																		key={i}
																		className="px-1.5 py-0.5 rounded text-xs"
																		style={{
																			backgroundColor: `${getSignalColor(signal)}20`,
																			color: getSignalColor(signal),
																		}}
																	>
																		{formatSignal(signal)}
																	</span>
																))}
															</div>
														</div>
													</td>
												</tr>
											))}
										</React.Fragment>
									);
								})}
							</tbody>
						</table>
					</div>

					{/* Pagination */}
					{totalPages > 1 && (
						<div
							className="flex items-center justify-between mt-3 pt-3 border-t"
							style={{ borderColor: theme.colors.border }}
						>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Page {currentPage + 1} of {totalPages}
							</span>
							<div className="flex items-center gap-2">
								<button
									className="px-2 py-1 rounded text-xs"
									style={{
										backgroundColor: `${theme.colors.border}40`,
										color: theme.colors.textMain,
										opacity: currentPage === 0 ? 0.5 : 1,
									}}
									disabled={currentPage === 0}
									onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
								>
									Prev
								</button>
								<button
									className="px-2 py-1 rounded text-xs"
									style={{
										backgroundColor: `${theme.colors.border}40`,
										color: theme.colors.textMain,
										opacity: currentPage >= totalPages - 1 ? 0.5 : 1,
									}}
									disabled={currentPage >= totalPages - 1}
									onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
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
}

export default RolloutComparisonTable;
