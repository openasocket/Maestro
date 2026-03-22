/**
 * CompletionRatesChart
 *
 * CSS horizontal bar chart showing completion rates by topology pattern.
 * Each bar represents a topology with its total count and success rate percentage.
 *
 * Features:
 * - One horizontal bar per topology pattern
 * - Stacked proportions: completed (success) vs failed (error) vs terminated (warning)
 * - Percentage label inside bar if wide enough, outside otherwise
 * - Theme-aware styling with colorblind support
 * - Accessible meter roles
 */

import React, { memo, useMemo, useCallback, useState } from 'react';
import type { Theme } from '../../../types';
import type { TeamOrchAggregation } from '../../../../shared/team-orch-stats-types';
import { topologyDisplayName, formatPercentage } from '../teamOrchUtils';

interface TopologyData {
	pattern: string;
	displayName: string;
	count: number;
	successRate: number;
	barPercentage: number;
}

interface CompletionRatesChartProps {
	theme: Theme;
	data: TeamOrchAggregation;
	colorBlindMode?: boolean;
}

export const CompletionRatesChart = memo(function CompletionRatesChart({
	theme,
	data,
	colorBlindMode = false,
}: CompletionRatesChartProps) {
	const [hoveredPattern, setHoveredPattern] = useState<string | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Process topology data
	const topologyData = useMemo((): TopologyData[] => {
		const entries = Object.entries(data.byTopology);
		if (entries.length === 0) return [];

		const maxCount = Math.max(...entries.map(([, stats]) => stats.count));

		return entries
			.map(([pattern, stats]) => ({
				pattern,
				displayName: topologyDisplayName(pattern),
				count: stats.count,
				successRate: stats.successRate,
				barPercentage: maxCount > 0 ? (stats.count / maxCount) * 100 : 0,
			}))
			.sort((a, b) => b.count - a.count);
	}, [data.byTopology]);

	const handleMouseEnter = useCallback(
		(pattern: string, event: React.MouseEvent<HTMLDivElement>) => {
			setHoveredPattern(pattern);
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos({
				x: rect.right + 8,
				y: rect.top + rect.height / 2,
			});
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredPattern(null);
		setTooltipPos(null);
	}, []);

	const hoveredData = useMemo(() => {
		if (!hoveredPattern) return null;
		return topologyData.find((d) => d.pattern === hoveredPattern) || null;
	}, [hoveredPattern, topologyData]);

	// Colors for success/failure portions
	const successColor = colorBlindMode ? '#0077BB' : theme.colors.success;
	const failColor = colorBlindMode ? '#CC3311' : theme.colors.error;

	const barHeight = 28;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Completion rates chart showing success rates by topology pattern. ${topologyData.length} topologies displayed.`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Completion Rates by Topology
				</h3>
			</div>

			{/* Chart container */}
			<div className="relative">
				{topologyData.length === 0 ? (
					<div
						className="flex items-center justify-center h-32"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-sm">No topology data available</span>
					</div>
				) : (
					<div className="space-y-2" role="list" aria-label="Topology completion rates">
						{topologyData.map((topology) => {
							const isHovered = hoveredPattern === topology.pattern;
							const barWidth = Math.max(topology.barPercentage, 2);
							const successWidth = topology.successRate;
							const failWidth = 100 - topology.successRate;

							return (
								<div
									key={topology.pattern}
									className="flex items-center gap-3"
									style={{ height: barHeight }}
									onMouseEnter={(e) => handleMouseEnter(topology.pattern, e)}
									onMouseLeave={handleMouseLeave}
									role="listitem"
									aria-label={`${topology.displayName}: ${topology.count} runs, ${formatPercentage(topology.successRate)} success rate`}
								>
									{/* Topology name label */}
									<div
										className="w-28 text-sm truncate flex-shrink-0"
										style={{
											color: isHovered ? theme.colors.textMain : theme.colors.textDim,
										}}
										title={topology.displayName}
									>
										{topology.displayName}
									</div>

									{/* Bar container */}
									<div
										className="flex-1 h-full rounded overflow-hidden relative"
										style={{
											backgroundColor: `${theme.colors.border}30`,
										}}
										role="meter"
										aria-valuenow={topology.successRate}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`${topology.displayName} success rate`}
									>
										{/* Outer bar (sized by count relative to max) */}
										<div
											className="h-full rounded flex overflow-hidden"
											style={{
												width: `${barWidth}%`,
												opacity: isHovered ? 1 : 0.85,
												transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
											}}
											aria-hidden="true"
										>
											{/* Success portion */}
											<div
												className="h-full"
												style={{
													width: `${successWidth}%`,
													backgroundColor: successColor,
												}}
											/>
											{/* Failure portion */}
											{failWidth > 0 && (
												<div
													className="h-full"
													style={{
														width: `${failWidth}%`,
														backgroundColor: failColor,
													}}
												/>
											)}
										</div>

										{/* Percentage label inside bar (if wide enough) */}
										{barWidth > 15 && (
											<span
												className="absolute text-xs font-medium px-2 text-white"
												style={{
													top: '50%',
													left: 4,
													transform: 'translateY(-50%)',
													textShadow: '0 1px 2px rgba(0,0,0,0.3)',
												}}
											>
												{formatPercentage(topology.successRate)}
											</span>
										)}

										{/* Percentage label outside bar (if too narrow) */}
										{barWidth <= 15 && (
											<span
												className="absolute text-xs font-medium"
												style={{
													left: `calc(${barWidth}% + 4px)`,
													top: '50%',
													transform: 'translateY(-50%)',
													color: theme.colors.textDim,
												}}
											>
												{formatPercentage(topology.successRate)}
											</span>
										)}
									</div>

									{/* Count label */}
									<div
										className="flex items-center gap-3 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									>
										<div className="text-xs text-right whitespace-nowrap" title="Run count">
											{topology.count} {topology.count === 1 ? 'run' : 'runs'}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{/* Tooltip */}
				{hoveredData && tooltipPos && (
					<div
						className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
						style={{
							left: tooltipPos.x,
							top: tooltipPos.y,
							transform: 'translateY(-50%)',
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="font-medium mb-1">{hoveredData.displayName}</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								{hoveredData.count} {hoveredData.count === 1 ? 'run' : 'runs'}
							</div>
							<div>
								<span style={{ color: successColor }}>
									{formatPercentage(hoveredData.successRate)}
								</span>{' '}
								success rate
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			{topologyData.length > 0 && (
				<div
					className="flex flex-wrap gap-4 mt-4 pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					role="list"
					aria-label="Chart legend"
				>
					<div className="flex items-center gap-1.5" role="listitem">
						<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: successColor }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Completed
						</span>
					</div>
					<div className="flex items-center gap-1.5" role="listitem">
						<div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: failColor }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Failed / Terminated
						</span>
					</div>
				</div>
			)}
		</div>
	);
});

export default CompletionRatesChart;
