/**
 * AnalyticsTab
 *
 * Analytics view for Team Orchestration modal. Composes four chart components
 * into a responsive grid layout with time range selection and cost estimation.
 *
 * Features:
 * - Time range pills for day/week/month/quarter/year/all
 * - Responsive 2-column grid (collapses to 1 column at narrow widths)
 * - ChartErrorBoundary wrapping each chart
 * - Cost estimation section when cost data exists
 * - Loading skeleton and empty states
 * - Keyboard-navigable sections
 */

import React, { memo, useRef, useCallback, useState, useEffect } from 'react';
import type { Theme } from '../../types';
import type { TeamOrchAggregation, TeamOrchTimeRange } from '../../../shared/team-orch-stats-types';
import { ChartErrorBoundary } from '../UsageDashboard/ChartErrorBoundary';
import { TeamOrchSkeleton } from './TeamOrchSkeletons';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import { TokenUsageChart } from './charts/TokenUsageChart';
import { CompletionRatesChart } from './charts/CompletionRatesChart';
import { IterationDistributionChart } from './charts/IterationDistributionChart';
import { AgentPerformanceChart } from './charts/AgentPerformanceChart';
import { formatCost, topologyDisplayName } from './teamOrchUtils';

interface AnalyticsTabProps {
	theme: Theme;
	data: TeamOrchAggregation | null;
	loading: boolean;
	timeRange: TeamOrchTimeRange;
	onTimeRangeChange: (range: TeamOrchTimeRange) => void;
	colorBlindMode?: boolean;
}

const TIME_RANGE_PILLS: { value: TeamOrchTimeRange; label: string }[] = [
	{ value: 'day', label: 'Day' },
	{ value: 'week', label: 'Week' },
	{ value: 'month', label: 'Month' },
	{ value: 'quarter', label: 'Quarter' },
	{ value: 'year', label: 'Year' },
	{ value: 'all', label: 'All' },
];

/**
 * Check if all chart data sources are empty
 */
function isAllChartsEmpty(data: TeamOrchAggregation): boolean {
	const hasAgentByDay = Object.keys(data.byAgentByDay).length > 0;
	const hasTopology = Object.keys(data.byTopology).length > 0;
	const hasIterations = data.iterationDistribution.length > 0;
	const hasAgents = Object.keys(data.byAgent).length > 0;
	return !hasAgentByDay && !hasTopology && !hasIterations && !hasAgents;
}

export const AnalyticsTab = memo(function AnalyticsTab({
	theme,
	data,
	loading,
	timeRange,
	onTimeRangeChange,
	colorBlindMode = false,
}: AnalyticsTabProps) {
	const tokenChartRef = useRef<HTMLDivElement>(null);
	const completionChartRef = useRef<HTMLDivElement>(null);
	const iterationChartRef = useRef<HTMLDivElement>(null);
	const agentChartRef = useRef<HTMLDivElement>(null);
	const costRef = useRef<HTMLDivElement>(null);

	// Track container width for responsive layout
	const containerRef = useRef<HTMLDivElement>(null);
	const [isNarrow, setIsNarrow] = useState(false);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setIsNarrow(entry.contentRect.width < 700);
			}
		});

		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	const handleTimeRangeClick = useCallback(
		(range: TeamOrchTimeRange) => {
			onTimeRangeChange(range);
		},
		[onTimeRangeChange]
	);

	if (loading) {
		return <TeamOrchSkeleton theme={theme} />;
	}

	if (!data || isAllChartsEmpty(data)) {
		return <TeamOrchEmptyState theme={theme} message="Run some team workflows to see analytics" />;
	}

	// Cost data for the estimation section
	const hasCostData = data.totalCost > 0;
	const avgCostPerRun = data.totalRuns > 0 ? data.totalCost / data.totalRuns : 0;
	// Build cost-by-topology from byTopology + rough proportional estimate
	const topologyCostEntries = Object.entries(data.byTopology)
		.filter(([, stats]) => stats.count > 0)
		.map(([pattern, stats]) => ({
			pattern,
			displayName: topologyDisplayName(pattern),
			count: stats.count,
			estimatedCost: data.totalRuns > 0 ? (stats.count / data.totalRuns) * data.totalCost : 0,
		}))
		.sort((a, b) => b.estimatedCost - a.estimatedCost);

	return (
		<div ref={containerRef} className="space-y-6">
			{/* Time Range Pills */}
			<div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Analytics time range">
				{TIME_RANGE_PILLS.map((pill) => (
					<button
						key={pill.value}
						onClick={() => handleTimeRangeClick(pill.value)}
						className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
						style={{
							backgroundColor:
								timeRange === pill.value ? `${theme.colors.accent}20` : 'transparent',
							color: timeRange === pill.value ? theme.colors.accent : theme.colors.textDim,
						}}
						role="radio"
						aria-checked={timeRange === pill.value}
					>
						{pill.label}
					</button>
				))}
			</div>

			{/* Row 1: Token Usage Chart (full width) */}
			<section
				ref={tokenChartRef}
				tabIndex={0}
				className="outline-none dashboard-section-enter"
				style={{ animationDelay: '0ms' }}
				role="region"
				aria-label="Token usage chart"
			>
				<ChartErrorBoundary theme={theme} chartName="Token Usage">
					<TokenUsageChart theme={theme} data={data} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</section>

			{/* Row 2: Completion Rates + Iteration Distribution (2-col or 1-col) */}
			<div
				className="gap-4"
				style={{
					display: 'grid',
					gridTemplateColumns: isNarrow ? '1fr' : '1fr 1fr',
				}}
			>
				<section
					ref={completionChartRef}
					tabIndex={0}
					className="outline-none dashboard-section-enter"
					style={{ animationDelay: '100ms' }}
					role="region"
					aria-label="Completion rates chart"
				>
					<ChartErrorBoundary theme={theme} chartName="Completion Rates">
						<CompletionRatesChart theme={theme} data={data} colorBlindMode={colorBlindMode} />
					</ChartErrorBoundary>
				</section>

				<section
					ref={iterationChartRef}
					tabIndex={0}
					className="outline-none dashboard-section-enter"
					style={{ animationDelay: '100ms' }}
					role="region"
					aria-label="Iteration distribution chart"
				>
					<ChartErrorBoundary theme={theme} chartName="Iteration Distribution">
						<IterationDistributionChart theme={theme} data={data} colorBlindMode={colorBlindMode} />
					</ChartErrorBoundary>
				</section>
			</div>

			{/* Row 3: Agent Performance Chart (full width) */}
			<section
				ref={agentChartRef}
				tabIndex={0}
				className="outline-none dashboard-section-enter"
				style={{ animationDelay: '200ms' }}
				role="region"
				aria-label="Agent performance chart"
			>
				<ChartErrorBoundary theme={theme} chartName="Agent Performance">
					<AgentPerformanceChart theme={theme} data={data} colorBlindMode={colorBlindMode} />
				</ChartErrorBoundary>
			</section>

			{/* Cost Estimation Section */}
			{hasCostData && (
				<section
					ref={costRef}
					tabIndex={0}
					className="p-4 rounded-lg outline-none dashboard-section-enter"
					style={{ backgroundColor: theme.colors.bgMain, animationDelay: '300ms' }}
					role="region"
					aria-label="Cost estimation"
				>
					<h3 className="text-sm font-medium mb-4" style={{ color: theme.colors.textMain }}>
						Cost Estimation
					</h3>

					{/* Summary metrics */}
					<div className="flex flex-wrap gap-6 mb-4">
						<div>
							<div className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
								Total Cost
							</div>
							<div className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
								{formatCost(data.totalCost)}
							</div>
						</div>
						<div>
							<div className="text-xs mb-1" style={{ color: theme.colors.textDim }}>
								Avg Cost per Run
							</div>
							<div className="text-lg font-semibold" style={{ color: theme.colors.textMain }}>
								{formatCost(avgCostPerRun)}
							</div>
						</div>
					</div>

					{/* Cost by topology table */}
					{topologyCostEntries.length > 0 && (
						<div>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
								Cost by Topology (estimated)
							</div>
							<table className="w-full text-xs">
								<thead>
									<tr
										style={{
											color: theme.colors.textDim,
											borderBottom: `1px solid ${theme.colors.border}`,
										}}
									>
										<th className="text-left py-1.5 font-medium" scope="col">
											Topology
										</th>
										<th className="text-right py-1.5 font-medium" scope="col">
											Runs
										</th>
										<th className="text-right py-1.5 font-medium" scope="col">
											Est. Cost
										</th>
									</tr>
								</thead>
								<tbody>
									{topologyCostEntries.map((entry) => (
										<tr
											key={entry.pattern}
											style={{
												borderBottom: `1px solid ${theme.colors.border}40`,
											}}
										>
											<td className="py-1.5" style={{ color: theme.colors.textMain }}>
												{entry.displayName}
											</td>
											<td className="text-right py-1.5" style={{ color: theme.colors.textDim }}>
												{entry.count}
											</td>
											<td className="text-right py-1.5" style={{ color: theme.colors.textMain }}>
												{formatCost(entry.estimatedCost)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			)}
		</div>
	);
});

export default AnalyticsTab;
