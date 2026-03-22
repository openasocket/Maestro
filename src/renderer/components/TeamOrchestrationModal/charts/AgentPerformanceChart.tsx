/**
 * AgentPerformanceChart
 *
 * CSS horizontal bar chart showing per-agent performance metrics.
 * Displays token usage, message counts, and processing time for each agent
 * involved in team orchestration workflows.
 *
 * Features:
 * - One horizontal bar per agent, sorted by active metric descending
 * - Top 10 agents displayed
 * - Metric toggle: switch between "Tokens", "Messages", "Time" views
 * - Theme-aware styling with colorblind support
 * - Accessible meter roles
 * - Hover tooltip with detailed stats
 */

import React, { memo, useMemo, useCallback, useState } from 'react';
import type { Theme } from '../../../types';
import type { TeamOrchAggregation } from '../../../../shared/team-orch-stats-types';
import { formatTokenCount, formatDuration } from '../teamOrchUtils';
import { COLORBLIND_AGENT_PALETTE } from '../../../constants/colorblindPalettes';

type MetricView = 'tokens' | 'messages' | 'time';

interface AgentRow {
	agentId: string;
	tokenCount: number;
	messageCount: number;
	processingTimeMs: number;
	cost: number;
	runCount: number;
	barPercentage: number;
	color: string;
}

interface AgentPerformanceChartProps {
	theme: Theme;
	data: TeamOrchAggregation;
	colorBlindMode?: boolean;
}

const METRIC_OPTIONS: { value: MetricView; label: string }[] = [
	{ value: 'tokens', label: 'Tokens' },
	{ value: 'messages', label: 'Messages' },
	{ value: 'time', label: 'Time' },
];

const MAX_AGENTS = 10;

function getAgentColor(index: number, theme: Theme, colorBlindMode: boolean): string {
	if (colorBlindMode) {
		return COLORBLIND_AGENT_PALETTE[index % COLORBLIND_AGENT_PALETTE.length];
	}
	if (index === 0) {
		return theme.colors.accent;
	}
	const additionalColors = [
		'#10b981', // emerald
		'#8b5cf6', // violet
		'#ef4444', // red
		'#06b6d4', // cyan
		'#ec4899', // pink
		'#f59e0b', // amber
		'#84cc16', // lime
		'#6366f1', // indigo
	];
	return additionalColors[(index - 1) % additionalColors.length];
}

function getMetricValue(agent: AgentRow, metric: MetricView): number {
	switch (metric) {
		case 'tokens':
			return agent.tokenCount;
		case 'messages':
			return agent.messageCount;
		case 'time':
			return agent.processingTimeMs;
	}
}

function formatMetricValue(value: number, metric: MetricView): string {
	switch (metric) {
		case 'tokens':
			return formatTokenCount(value);
		case 'messages':
			return value.toString();
		case 'time':
			return formatDuration(value);
	}
}

export const AgentPerformanceChart = memo(function AgentPerformanceChart({
	theme,
	data,
	colorBlindMode = false,
}: AgentPerformanceChartProps) {
	const [metricView, setMetricView] = useState<MetricView>('tokens');
	const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	// Process agent data — sort by active metric, take top 10
	const agentData = useMemo((): AgentRow[] => {
		const entries = Object.entries(data.byAgent);
		if (entries.length === 0) return [];

		const rows: AgentRow[] = entries.map(([agentId, stats], index) => ({
			agentId,
			tokenCount: stats.tokenCount,
			messageCount: stats.messageCount,
			processingTimeMs: stats.processingTimeMs,
			cost: stats.cost,
			runCount: stats.runCount,
			barPercentage: 0,
			color: getAgentColor(index, theme, colorBlindMode),
		}));

		// Sort by active metric descending
		rows.sort((a, b) => getMetricValue(b, metricView) - getMetricValue(a, metricView));

		// Take top N
		const top = rows.slice(0, MAX_AGENTS);

		// Calculate bar percentages relative to the max value
		const maxVal = top.length > 0 ? getMetricValue(top[0], metricView) : 0;
		for (const row of top) {
			row.barPercentage = maxVal > 0 ? (getMetricValue(row, metricView) / maxVal) * 100 : 0;
		}

		return top;
	}, [data.byAgent, metricView, theme, colorBlindMode]);

	const handleMouseEnter = useCallback(
		(agentId: string, event: React.MouseEvent<HTMLDivElement>) => {
			setHoveredAgent(agentId);
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos({
				x: rect.right + 8,
				y: rect.top + rect.height / 2,
			});
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredAgent(null);
		setTooltipPos(null);
	}, []);

	const hoveredData = useMemo(() => {
		if (!hoveredAgent) return null;
		return agentData.find((d) => d.agentId === hoveredAgent) || null;
	}, [hoveredAgent, agentData]);

	const totalAgents = Object.keys(data.byAgent).length;
	const barHeight = 28;

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Agent performance chart showing ${metricView} by agent. ${agentData.length} agents displayed.`}
		>
			{/* Header with metric toggle */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Agent Performance
				</h3>

				{/* Metric toggle pills */}
				<div
					className="flex rounded-lg overflow-hidden border"
					style={{ borderColor: theme.colors.border }}
					role="radiogroup"
					aria-label="Performance metric selector"
				>
					{METRIC_OPTIONS.map((option) => (
						<button
							key={option.value}
							onClick={() => setMetricView(option.value)}
							className="px-3 py-1 text-xs font-medium transition-colors"
							style={{
								backgroundColor:
									metricView === option.value ? `${theme.colors.accent}20` : 'transparent',
								color: metricView === option.value ? theme.colors.accent : theme.colors.textDim,
							}}
							role="radio"
							aria-checked={metricView === option.value}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>

			{/* Chart container */}
			<div className="relative">
				{agentData.length === 0 ? (
					<div
						className="flex items-center justify-center h-32"
						style={{ color: theme.colors.textDim }}
					>
						<span className="text-sm">No agent data available</span>
					</div>
				) : (
					<div className="space-y-2" role="list" aria-label="Agent performance data">
						{agentData.map((agent) => {
							const isHovered = hoveredAgent === agent.agentId;
							const barWidth = Math.max(agent.barPercentage, 2);
							const metricVal = getMetricValue(agent, metricView);

							return (
								<div
									key={agent.agentId}
									className="flex items-center gap-3"
									style={{ height: barHeight }}
									onMouseEnter={(e) => handleMouseEnter(agent.agentId, e)}
									onMouseLeave={handleMouseLeave}
									role="listitem"
									aria-label={`${agent.agentId}: ${formatMetricValue(metricVal, metricView)} ${metricView}`}
								>
									{/* Agent name label */}
									<div
										className="w-28 text-sm truncate flex-shrink-0"
										style={{
											color: isHovered ? theme.colors.textMain : theme.colors.textDim,
										}}
										title={agent.agentId}
									>
										{agent.agentId}
									</div>

									{/* Bar container */}
									<div
										className="flex-1 h-full rounded overflow-hidden relative"
										style={{
											backgroundColor: `${theme.colors.border}30`,
										}}
										role="meter"
										aria-valuenow={agent.barPercentage}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-label={`${agent.agentId} ${metricView} percentage`}
									>
										{/* Bar fill */}
										<div
											className="h-full rounded flex items-center"
											style={{
												width: `${barWidth}%`,
												backgroundColor: agent.color,
												opacity: isHovered ? 1 : 0.85,
												transition: 'width 0.5s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease',
											}}
											aria-hidden="true"
										>
											{/* Value label inside bar (if bar is wide enough) */}
											{barWidth > 15 && (
												<span
													className="text-xs font-medium px-2 text-white"
													style={{
														textShadow: '0 1px 2px rgba(0,0,0,0.3)',
													}}
												>
													{formatMetricValue(metricVal, metricView)}
												</span>
											)}
										</div>

										{/* Value label outside bar (if too narrow) */}
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
												{formatMetricValue(metricVal, metricView)}
											</span>
										)}
									</div>

									{/* Secondary metric labels */}
									<div
										className="flex items-center gap-3 flex-shrink-0"
										style={{ color: theme.colors.textDim }}
									>
										<div className="text-xs text-right whitespace-nowrap" title="Token count">
											{formatTokenCount(agent.tokenCount)} tok
										</div>
										<div className="text-xs text-right whitespace-nowrap" title="Message count">
											{agent.messageCount} msg
										</div>
										<div
											className="w-14 text-xs text-right font-medium"
											title="Processing time"
											style={{ color: theme.colors.textMain }}
										>
											{formatDuration(agent.processingTimeMs)}
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
						<div className="font-medium mb-1 flex items-center gap-2">
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: hoveredData.color }}
							/>
							{hoveredData.agentId}
						</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>{formatTokenCount(hoveredData.tokenCount)} tokens</div>
							<div>{hoveredData.messageCount} messages</div>
							<div>{formatDuration(hoveredData.processingTimeMs)} processing</div>
							<div>{hoveredData.runCount} runs</div>
						</div>
					</div>
				)}
			</div>

			{/* Overflow indicator */}
			{totalAgents > MAX_AGENTS && (
				<div className="mt-3 pt-2 border-t" style={{ borderColor: theme.colors.border }}>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Showing top {MAX_AGENTS} of {totalAgents} agents
					</span>
				</div>
			)}
		</div>
	);
});

export default AgentPerformanceChart;
