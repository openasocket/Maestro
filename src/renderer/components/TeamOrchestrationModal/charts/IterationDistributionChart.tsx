/**
 * IterationDistributionChart
 *
 * SVG histogram showing the distribution of iteration counts across workflows.
 * Each bar represents a specific iteration count and how many workflows used that many iterations.
 *
 * Features:
 * - Vertical bars, one per iteration count value
 * - Bar height proportional to workflow count
 * - X-axis: iteration numbers, Y-axis: count values
 * - Hover tooltip showing iterations and workflow count
 * - Theme-aware styling with colorblind support
 * - Responsive SVG rendering
 */

import React, { memo, useState, useMemo, useCallback } from 'react';
import type { Theme } from '../../../types';
import type { TeamOrchAggregation } from '../../../../shared/team-orch-stats-types';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';
import { clampTooltipPosition } from '../teamOrchUtils';

interface IterationDistributionChartProps {
	theme: Theme;
	data: TeamOrchAggregation;
	colorBlindMode?: boolean;
}

export const IterationDistributionChart = memo(function IterationDistributionChart({
	theme,
	data,
	colorBlindMode = false,
}: IterationDistributionChartProps) {
	const [hoveredBar, setHoveredBar] = useState<number | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 180;
	const padding = { top: 16, right: 20, bottom: 32, left: 40 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	// Sort distribution data by iteration count
	const distribution = useMemo(() => {
		if (!data.iterationDistribution || data.iterationDistribution.length === 0) return [];
		return [...data.iterationDistribution].sort((a, b) => a.iterations - b.iterations);
	}, [data.iterationDistribution]);

	// Calculate scales and bar dimensions
	const { maxCount, barWidth, yTicks } = useMemo(() => {
		if (distribution.length === 0) {
			return { maxCount: 0, barWidth: 0, yTicks: [0] };
		}

		const max = Math.max(...distribution.map((d) => d.count));
		const gap = 4;
		const bw = Math.max((innerWidth - gap * (distribution.length - 1)) / distribution.length, 8);

		// Y-axis ticks
		const tickCount = 4;
		const yMax = Math.ceil(max * 1.1) || 1;
		const ticks = Array.from({ length: tickCount }, (_, i) =>
			Math.round((yMax / (tickCount - 1)) * i)
		);

		return { maxCount: yMax, barWidth: bw, yTicks: ticks };
	}, [distribution, innerWidth]);

	const barColor = colorBlindMode ? COLORBLIND_AGENT_PALETTE[0] : theme.colors.accent;

	const xOffset = useCallback(
		(index: number) => {
			const gap = 4;
			const totalWidth = distribution.length * barWidth + (distribution.length - 1) * gap;
			const startX = padding.left + (innerWidth - totalWidth) / 2;
			return startX + index * (barWidth + gap);
		},
		[distribution.length, barWidth, padding.left, innerWidth]
	);

	const yScale = useCallback(
		(value: number) => {
			return chartHeight - padding.bottom - (value / (maxCount || 1)) * innerHeight;
		},
		[chartHeight, padding.bottom, maxCount, innerHeight]
	);

	const handleMouseEnter = useCallback((index: number, event: React.MouseEvent<SVGRectElement>) => {
		setHoveredBar(index);
		const rect = event.currentTarget.getBoundingClientRect();
		setTooltipPos(
			clampTooltipPosition({
				x: rect.left + rect.width / 2,
				y: rect.top,
			})
		);
	}, []);

	const handleMouseLeave = useCallback(() => {
		setHoveredBar(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Iteration distribution histogram showing how many workflows used each iteration count. ${distribution.length} distinct iteration counts.`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Iteration Distribution
				</h3>
			</div>

			{/* Chart container */}
			<div className="relative">
				{distribution.length === 0 ? (
					<svg
						width="100%"
						viewBox={`0 0 ${chartWidth} ${chartHeight}`}
						preserveAspectRatio="xMidYMid meet"
					>
						<text
							x={chartWidth / 2}
							y={chartHeight / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={13}
							fill={theme.colors.textDim}
						>
							No data yet
						</text>
					</svg>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${chartWidth} ${chartHeight}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label="Histogram of iteration counts per workflow"
					>
						{/* Grid lines */}
						{yTicks.map((tick, idx) => (
							<line
								key={`grid-${idx}`}
								x1={padding.left}
								y1={yScale(tick)}
								x2={chartWidth - padding.right}
								y2={yScale(tick)}
								stroke={theme.colors.border}
								strokeOpacity={0.3}
								strokeDasharray="4,4"
							/>
						))}

						{/* Y-axis labels */}
						{yTicks.map((tick, idx) => (
							<text
								key={`y-${idx}`}
								x={padding.left - 8}
								y={yScale(tick)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{tick}
							</text>
						))}

						{/* Bars */}
						{distribution.map((item, idx) => {
							const x = xOffset(idx);
							const barH = (item.count / (maxCount || 1)) * innerHeight;
							const y = chartHeight - padding.bottom - barH;
							const isHovered = hoveredBar === idx;

							return (
								<rect
									key={`bar-${item.iterations}`}
									x={x}
									y={y}
									width={barWidth}
									height={Math.max(barH, 1)}
									rx={2}
									fill={barColor}
									opacity={isHovered ? 1 : 0.75}
									style={{
										cursor: 'pointer',
										transition: 'opacity 0.15s ease, height 0.3s ease, y 0.3s ease',
									}}
									onMouseEnter={(e) => handleMouseEnter(idx, e)}
									onMouseLeave={handleMouseLeave}
								/>
							);
						})}

						{/* X-axis labels */}
						{distribution.map((item, idx) => (
							<text
								key={`x-${item.iterations}`}
								x={xOffset(idx) + barWidth / 2}
								y={chartHeight - padding.bottom + 16}
								textAnchor="middle"
								fontSize={10}
								fill={theme.colors.textDim}
							>
								{item.iterations}
							</text>
						))}

						{/* Axis labels */}
						<text
							x={chartWidth / 2}
							y={chartHeight - 4}
							textAnchor="middle"
							fontSize={10}
							fill={theme.colors.textDim}
						>
							Iterations
						</text>
						<text
							x={10}
							y={chartHeight / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={10}
							fill={theme.colors.textDim}
							transform={`rotate(-90, 10, ${chartHeight / 2})`}
						>
							Workflows
						</text>
					</svg>
				)}

				{/* Tooltip */}
				{hoveredBar !== null && tooltipPos && distribution[hoveredBar] && (
					<div
						className="fixed z-50 px-3 py-2 rounded text-xs whitespace-nowrap pointer-events-none shadow-lg"
						style={{
							left: tooltipPos.x,
							top: tooltipPos.y - 8,
							transform: 'translate(-50%, -100%)',
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div className="font-medium">
							{distribution[hoveredBar].iterations}{' '}
							{distribution[hoveredBar].iterations === 1 ? 'iteration' : 'iterations'}
						</div>
						<div style={{ color: theme.colors.textDim }}>
							{distribution[hoveredBar].count}{' '}
							{distribution[hoveredBar].count === 1 ? 'workflow' : 'workflows'}
						</div>
					</div>
				)}
			</div>
		</div>
	);
});

export default IterationDistributionChart;
