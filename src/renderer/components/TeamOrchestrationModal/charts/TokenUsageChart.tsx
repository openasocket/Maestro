/**
 * TokenUsageChart
 *
 * SVG line chart showing team orchestration token usage over time with one line per agent.
 * Toggle between token count and duration views.
 *
 * Features:
 * - One line per agent from byAgentByDay data
 * - Metric toggle between Tokens and Duration
 * - Hover tooltips with exact values
 * - Responsive SVG rendering
 * - Theme-aware styling
 * - Colorblind mode support
 */

import React, { memo, useState, useMemo, useCallback } from 'react';
import { format, parseISO } from 'date-fns';
import type { Theme } from '../../../types';
import type { TeamOrchAggregation } from '../../../../shared/team-orch-stats-types';
import { formatTokenCount, formatDuration, clampTooltipPosition } from '../teamOrchUtils';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';

// 10 distinct colors for agents
const AGENT_COLORS = [
	'#a78bfa', // violet
	'#34d399', // emerald
	'#60a5fa', // blue
	'#f472b6', // pink
	'#fbbf24', // amber
	'#fb923c', // orange
	'#4ade80', // green
	'#38bdf8', // sky
	'#c084fc', // purple
	'#f87171', // red
];

interface AgentDayData {
	date: string;
	formattedDate: string;
	tokens: number;
	duration: number;
}

interface DayData {
	date: string;
	formattedDate: string;
	agents: Record<string, { tokens: number; duration: number }>;
}

interface TokenUsageChartProps {
	theme: Theme;
	data: TeamOrchAggregation;
	colorBlindMode?: boolean;
}

/**
 * Format duration for Y-axis labels (shorter format)
 */
function formatYAxisDuration(ms: number): string {
	if (ms === 0) return '0';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor(totalSeconds / 60);

	if (hours > 0) {
		return `${hours}h`;
	}
	if (minutes > 0) {
		return `${minutes}m`;
	}
	return `${totalSeconds}s`;
}

/**
 * Get agent color based on index, with colorblind mode support
 */
function getAgentColor(index: number, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	return AGENT_COLORS[index % AGENT_COLORS.length];
}

export const TokenUsageChart = memo(function TokenUsageChart({
	theme,
	data,
	colorBlindMode = false,
}: TokenUsageChartProps) {
	const [hoveredDay, setHoveredDay] = useState<{ dayIndex: number; agent?: string } | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);
	const [metricMode, setMetricMode] = useState<'tokens' | 'duration'>('tokens');

	// Chart dimensions
	const chartWidth = 600;
	const chartHeight = 220;
	const padding = { top: 20, right: 50, bottom: 40, left: 50 };
	const innerWidth = chartWidth - padding.left - padding.right;
	const innerHeight = chartHeight - padding.top - padding.bottom;

	// Build per-agent data aligned to sorted dates
	const { agents, chartData, allDates } = useMemo(() => {
		const byAgentByDay = data.byAgentByDay || {};

		// Calculate total tokens per agent to rank them
		const agentTotals: Array<{ agentId: string; totalTokens: number }> = [];
		for (const agentId of Object.keys(byAgentByDay)) {
			const totalTokens = byAgentByDay[agentId].reduce((sum, day) => sum + day.tokens, 0);
			agentTotals.push({ agentId, totalTokens });
		}

		// Sort by total tokens descending and take top 10
		agentTotals.sort((a, b) => b.totalTokens - a.totalTokens);
		const topAgents = agentTotals.slice(0, 10);
		const agentList = topAgents.map((a) => a.agentId);

		// Collect all unique dates
		const dateSet = new Set<string>();
		for (const agentId of agentList) {
			for (const day of byAgentByDay[agentId]) {
				dateSet.add(day.date);
			}
		}
		const sortedDates = Array.from(dateSet).sort();

		// Build per-agent arrays aligned to sorted dates
		const agentData: Record<string, AgentDayData[]> = {};
		for (const agentId of agentList) {
			const dayMap = new Map<string, { tokens: number; duration: number }>();
			for (const day of byAgentByDay[agentId]) {
				dayMap.set(day.date, { tokens: day.tokens, duration: day.duration });
			}

			agentData[agentId] = sortedDates.map((date) => ({
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				tokens: dayMap.get(date)?.tokens || 0,
				duration: dayMap.get(date)?.duration || 0,
			}));
		}

		// Build combined day data for tooltips
		const combinedData: DayData[] = sortedDates.map((date) => {
			const agentsMap: Record<string, { tokens: number; duration: number }> = {};
			for (const agentId of agentList) {
				const dayData = agentData[agentId].find((d) => d.date === date);
				if (dayData) {
					agentsMap[agentId] = { tokens: dayData.tokens, duration: dayData.duration };
				}
			}
			return {
				date,
				formattedDate: format(parseISO(date), 'EEEE, MMM d, yyyy'),
				agents: agentsMap,
			};
		});

		return {
			agents: agentList,
			chartData: agentData,
			allDates: combinedData,
		};
	}, [data.byAgentByDay]);

	// Calculate scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (allDates.length === 0) {
			return {
				xScale: (_: number) => padding.left,
				yScale: (_: number) => chartHeight - padding.bottom,
				yTicks: [0],
			};
		}

		// Find max value across all agents
		let maxValue = 1;
		for (const agent of agents) {
			const agentMax = Math.max(
				...chartData[agent].map((d) => (metricMode === 'tokens' ? d.tokens : d.duration))
			);
			maxValue = Math.max(maxValue, agentMax);
		}

		// Add 10% padding
		const yMax = metricMode === 'tokens' ? Math.ceil(maxValue * 1.1) : maxValue * 1.1;

		const xScaleFn = (index: number) =>
			padding.left + (index / Math.max(allDates.length - 1, 1)) * innerWidth;

		const yScaleFn = (value: number) => chartHeight - padding.bottom - (value / yMax) * innerHeight;

		const tickCount = 5;
		const yTicksArr =
			metricMode === 'tokens'
				? Array.from({ length: tickCount }, (_, i) => Math.round((yMax / (tickCount - 1)) * i))
				: Array.from({ length: tickCount }, (_, i) => (yMax / (tickCount - 1)) * i);

		return { xScale: xScaleFn, yScale: yScaleFn, yTicks: yTicksArr };
	}, [allDates, agents, chartData, metricMode, chartHeight, innerWidth, innerHeight, padding]);

	// Generate line paths for each agent
	const linePaths = useMemo(() => {
		const paths: Record<string, string> = {};
		for (const agent of agents) {
			const agentDays = chartData[agent];
			if (agentDays.length === 0) continue;

			paths[agent] = agentDays
				.map((day, idx) => {
					const x = xScale(idx);
					const y = yScale(metricMode === 'tokens' ? day.tokens : day.duration);
					return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
				})
				.join(' ');
		}
		return paths;
	}, [agents, chartData, xScale, yScale, metricMode]);

	const handleMouseEnter = useCallback(
		(dayIndex: number, agent: string, event: React.MouseEvent<SVGCircleElement>) => {
			setHoveredDay({ dayIndex, agent });
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos(
				clampTooltipPosition({
					x: rect.left + rect.width / 2,
					y: rect.top,
				})
			);
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredDay(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Token usage chart showing ${metricMode === 'tokens' ? 'token counts' : 'duration'} over time. ${agents.length} agents displayed.`}
		>
			{/* Header with title and metric toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Token Usage Over Time
				</h3>
				<div className="flex items-center gap-2">
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Show:
					</span>
					<div
						className="flex rounded overflow-hidden border"
						style={{ borderColor: theme.colors.border }}
					>
						<button
							onClick={() => setMetricMode('tokens')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor: metricMode === 'tokens' ? theme.colors.accent : 'transparent',
								color: metricMode === 'tokens' ? theme.colors.bgMain : theme.colors.textDim,
							}}
							aria-pressed={metricMode === 'tokens'}
						>
							Tokens
						</button>
						<button
							onClick={() => setMetricMode('duration')}
							className="px-2 py-1 text-xs transition-colors"
							style={{
								backgroundColor: metricMode === 'duration' ? theme.colors.accent : 'transparent',
								color: metricMode === 'duration' ? theme.colors.bgMain : theme.colors.textDim,
							}}
							aria-pressed={metricMode === 'duration'}
						>
							Duration
						</button>
					</div>
				</div>
			</div>

			{/* Chart container */}
			<div className="relative">
				{allDates.length === 0 || agents.length === 0 ? (
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
						aria-label={`Line chart showing ${metricMode === 'tokens' ? 'token usage' : 'duration'} per agent over time`}
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
								{metricMode === 'tokens' ? formatTokenCount(tick) : formatYAxisDuration(tick)}
							</text>
						))}

						{/* X-axis labels */}
						{allDates.map((day, idx) => {
							const labelInterval =
								allDates.length > 14 ? Math.ceil(allDates.length / 7) : allDates.length > 7 ? 2 : 1;

							if (idx % labelInterval !== 0 && idx !== allDates.length - 1) {
								return null;
							}

							const needsRotation = allDates.length > 10;

							return (
								<text
									key={`x-label-${idx}`}
									x={xScale(idx)}
									y={chartHeight - padding.bottom + 20}
									textAnchor={needsRotation ? 'end' : 'middle'}
									fontSize={10}
									fill={theme.colors.textDim}
									transform={
										needsRotation
											? `rotate(-30, ${xScale(idx)}, ${chartHeight - padding.bottom + 20})`
											: undefined
									}
								>
									{format(parseISO(day.date), 'MMM d')}
								</text>
							);
						})}

						{/* Lines for each agent */}
						{agents.map((agent, agentIdx) => {
							const color = getAgentColor(agentIdx, colorBlindMode);
							return (
								<path
									key={`line-${agent}`}
									d={linePaths[agent]}
									fill="none"
									stroke={color}
									strokeWidth={2}
									strokeLinecap="round"
									strokeLinejoin="round"
									style={{ transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
								/>
							);
						})}

						{/* Data points for each agent */}
						{agents.map((agent, agentIdx) => {
							const color = getAgentColor(agentIdx, colorBlindMode);
							return chartData[agent].map((day, dayIdx) => {
								const x = xScale(dayIdx);
								const y = yScale(metricMode === 'tokens' ? day.tokens : day.duration);
								const isHovered = hoveredDay?.dayIndex === dayIdx && hoveredDay?.agent === agent;

								return (
									<circle
										key={`point-${agent}-${dayIdx}`}
										cx={x}
										cy={y}
										r={isHovered ? 6 : 4}
										fill={isHovered ? color : theme.colors.bgMain}
										stroke={color}
										strokeWidth={2}
										style={{
											cursor: 'pointer',
											transition: 'r 0.15s ease',
										}}
										onMouseEnter={(e) => handleMouseEnter(dayIdx, agent, e)}
										onMouseLeave={handleMouseLeave}
									/>
								);
							});
						})}

						{/* Y-axis title */}
						<text
							x={12}
							y={chartHeight / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={11}
							fill={theme.colors.textDim}
							transform={`rotate(-90, 12, ${chartHeight / 2})`}
						>
							{metricMode === 'tokens' ? 'Tokens' : 'Time'}
						</text>
					</svg>
				)}

				{/* Tooltip */}
				{hoveredDay && tooltipPos && allDates[hoveredDay.dayIndex] && (
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
						<div className="font-medium mb-1">{allDates[hoveredDay.dayIndex].formattedDate}</div>
						<div style={{ color: theme.colors.textDim }}>
							{agents.map((agent, idx) => {
								const dayData = allDates[hoveredDay.dayIndex].agents[agent];
								if (!dayData || (dayData.tokens === 0 && dayData.duration === 0)) return null;
								const color = getAgentColor(idx, colorBlindMode);
								return (
									<div key={agent} className="flex items-center gap-2">
										<span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
										<span>{agent}:</span>
										<span style={{ color: theme.colors.textMain }}>
											{metricMode === 'tokens'
												? `${formatTokenCount(dayData.tokens)} tokens`
												: formatDuration(dayData.duration)}
										</span>
									</div>
								);
							})}
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			<div
				className="flex items-center justify-center gap-4 mt-3 pt-3 border-t flex-wrap"
				style={{ borderColor: theme.colors.border }}
			>
				{agents.map((agent, idx) => {
					const color = getAgentColor(idx, colorBlindMode);
					return (
						<div key={agent} className="flex items-center gap-1.5">
							<div className="w-3 h-0.5 rounded" style={{ backgroundColor: color }} />
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{agent}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
});

export default TokenUsageChart;
