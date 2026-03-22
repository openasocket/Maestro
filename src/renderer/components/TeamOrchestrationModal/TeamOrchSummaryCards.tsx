/**
 * TeamOrchSummaryCards
 *
 * Displays key team orchestration metrics in a responsive card grid.
 *
 * Metrics displayed:
 * - Total Runs
 * - Active Workflows (accent-highlighted when > 0)
 * - Avg Iterations
 * - Success Rate (color-coded by threshold)
 * - Total Tokens
 * - Avg Completion Time
 *
 * Features:
 * - Theme-aware styling with inline styles
 * - Staggered entrance animation (50ms per card)
 * - Graceful null-data fallback ("--")
 * - Responsive grid (3 columns wide, 2 narrow)
 */

import React, { memo } from 'react';
import { BarChart3, Activity, RefreshCw, CheckCircle, Zap, Clock } from 'lucide-react';
import type { Theme } from '../../types';
import type { TeamOrchAggregation } from '../../../shared/team-orch-stats-types';
import { formatDuration, formatTokenCount, formatPercentage } from './teamOrchUtils';

interface TeamOrchSummaryCardsProps {
	/** Current theme for styling */
	theme: Theme;
	/** Aggregated stats data, or null when unavailable */
	data: TeamOrchAggregation | null;
	/** Number of currently active workflows */
	activeWorkflowCount: number;
}

/**
 * Determine success rate color based on threshold:
 * - > 80%: green (success)
 * - > 50%: yellow (warning)
 * - Otherwise: red (error)
 */
function successRateColor(rate: number, theme: Theme): string {
	if (rate > 80) return theme.colors.success;
	if (rate > 50) return theme.colors.warning;
	return theme.colors.error;
}

export const TeamOrchSummaryCards = memo(function TeamOrchSummaryCards({
	theme,
	data,
	activeWorkflowCount,
}: TeamOrchSummaryCardsProps) {
	const hasData = data !== null;

	const metrics = [
		{
			icon: <BarChart3 className="w-4 h-4" />,
			label: 'Total Runs',
			value: hasData ? data.totalRuns.toString() : '--',
			iconColor: theme.colors.accent,
		},
		{
			icon: <Activity className="w-4 h-4" />,
			label: 'Active Workflows',
			value: activeWorkflowCount.toString(),
			iconColor: activeWorkflowCount > 0 ? theme.colors.accent : theme.colors.textDim,
			valueColor: activeWorkflowCount > 0 ? theme.colors.accent : undefined,
		},
		{
			icon: <RefreshCw className="w-4 h-4" />,
			label: 'Avg Iterations',
			value: hasData ? data.avgIterations.toFixed(1) : '--',
			iconColor: theme.colors.accent,
		},
		{
			icon: <CheckCircle className="w-4 h-4" />,
			label: 'Success Rate',
			value: hasData ? formatPercentage(data.successRate) : '--',
			iconColor: hasData ? successRateColor(data.successRate, theme) : theme.colors.accent,
			valueColor: hasData ? successRateColor(data.successRate, theme) : undefined,
		},
		{
			icon: <Zap className="w-4 h-4" />,
			label: 'Total Tokens',
			value: hasData ? formatTokenCount(data.totalTokens) : '--',
			iconColor: theme.colors.accent,
		},
		{
			icon: <Clock className="w-4 h-4" />,
			label: 'Avg Completion',
			value: hasData ? formatDuration(data.avgDuration) : '--',
			iconColor: theme.colors.accent,
		},
	];

	return (
		<div
			className="grid gap-4"
			style={{
				gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
			}}
			data-testid="team-orch-summary-cards"
			role="region"
			aria-label="Team orchestration summary metrics"
		>
			{metrics.map((metric, index) => (
				<div
					key={metric.label}
					className="p-4 rounded-lg flex items-start gap-3 dashboard-card-enter"
					style={{
						backgroundColor: theme.colors.bgMain,
						border: `1px solid ${theme.colors.border}`,
						animationDelay: `${index * 50}ms`,
					}}
					data-testid="team-orch-metric-card"
					role="group"
					aria-label={`${metric.label}: ${metric.value}`}
				>
					<div
						className="flex-shrink-0 p-2 rounded-md"
						style={{
							backgroundColor: `${metric.iconColor}15`,
							color: metric.iconColor,
						}}
					>
						{metric.icon}
					</div>
					<div className="min-w-0 flex-1">
						<div
							className="text-xs uppercase tracking-wide mb-1"
							style={{ color: theme.colors.textDim }}
						>
							{metric.label}
						</div>
						<div
							className="text-2xl font-bold"
							style={{ color: metric.valueColor ?? theme.colors.textMain }}
							title={metric.value}
						>
							{metric.value}
						</div>
					</div>
				</div>
			))}
		</div>
	);
});

export default TeamOrchSummaryCards;
