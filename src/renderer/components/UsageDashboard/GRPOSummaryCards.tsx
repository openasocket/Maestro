/**
 * GRPOSummaryCards
 *
 * Displays key GRPO metrics in card format for the Usage Dashboard.
 *
 * Metrics displayed:
 * - Library Size: current entries / max configured size
 * - Mean Reward: overall mean reward with trend arrow
 * - Total Rollouts: total rollouts processed
 * - Token Cost: estimated USD cost of GRPO overhead
 *
 * Features:
 * - Theme-aware styling with inline styles
 * - Trend arrow (↑/↓) for reward direction
 * - Subtle icons for each metric
 * - Responsive grid layout
 * - Staggered entrance animation
 */

import React, { useMemo } from 'react';
import { Database, TrendingUp, GitBranch, Coins } from 'lucide-react';
import type { Theme } from '../../types';
import type { GRPOStats, GRPOConfig } from '../../../shared/grpo-types';

interface GRPOSummaryCardsProps {
	/** GRPO stats data from the API */
	data: GRPOStats;
	/** Current theme for styling */
	theme: Theme;
	/** GRPO config for max library size */
	config?: GRPOConfig | null;
	/** Number of columns for responsive layout (default: 4) */
	columns?: number;
	/** Training status from auto-trainer events */
	trainingStatus?: 'idle' | 'running' | 'complete' | 'error';
}

/**
 * Single metric card component
 */
interface MetricCardProps {
	icon: React.ReactNode;
	label: string;
	value: string;
	subtitle?: string;
	theme: Theme;
	/** Animation delay index for staggered entrance (0-based) */
	animationIndex?: number;
}

function MetricCard({ icon, label, value, subtitle, theme, animationIndex = 0 }: MetricCardProps) {
	return (
		<div
			className="p-4 rounded-lg flex items-start gap-3 dashboard-card-enter"
			style={{
				backgroundColor: theme.colors.bgMain,
				animationDelay: `${animationIndex * 50}ms`,
			}}
			data-testid="grpo-metric-card"
			role="group"
			aria-label={`${label}: ${value}`}
		>
			<div
				className="flex-shrink-0 p-2 rounded-md"
				style={{
					backgroundColor: `${theme.colors.accent}15`,
					color: theme.colors.accent,
				}}
			>
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div
					className="text-xs uppercase tracking-wide mb-1"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</div>
				<div className="text-2xl font-bold" style={{ color: theme.colors.textMain }} title={value}>
					{value}
				</div>
				{subtitle && (
					<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{subtitle}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Estimate USD cost from token count.
 * Uses a rough average of $3 per 1M input tokens as baseline.
 */
function estimateTokenCost(tokens: number): string {
	if (tokens === 0) return '$0.00';
	const costPerMillion = 3.0;
	const cost = (tokens / 1_000_000) * costPerMillion;
	if (cost < 0.01) return '<$0.01';
	return `~$${cost.toFixed(2)}`;
}

/**
 * Format reward trend as arrow and percentage.
 */
function formatRewardTrend(trend: number): string {
	if (trend === 0) return '—';
	const arrow = trend > 0 ? '↑' : '↓';
	const percent = Math.abs(trend * 100).toFixed(0);
	return `${arrow} ${percent}%`;
}

export function GRPOSummaryCards({ data, theme, config, columns = 4, trainingStatus = 'idle' }: GRPOSummaryCardsProps) {
	const metrics = useMemo(() => {
		const maxLib = config?.maxLibrarySize ?? 50;
		const libSubtitle = `/ ${maxLib} max`;

		const rewardValue = data.overallMeanReward > 0
			? data.overallMeanReward.toFixed(2)
			: '—';
		const rewardSubtitle = data.rewardTrend !== 0
			? formatRewardTrend(data.rewardTrend)
			: undefined;

		return [
			{
				icon: <Database className="w-4 h-4" />,
				label: 'Library Size',
				value: data.librarySize.toString(),
				subtitle: libSubtitle,
			},
			{
				icon: <TrendingUp className="w-4 h-4" />,
				label: 'Mean Reward',
				value: rewardValue,
				subtitle: rewardSubtitle,
			},
			{
				icon: <GitBranch className="w-4 h-4" />,
				label: 'Total Rollouts',
				value: data.totalRollouts.toString(),
			},
			{
				icon: <Coins className="w-4 h-4" />,
				label: 'Token Cost',
				value: estimateTokenCost(data.totalGRPOTokens),
				subtitle: 'overhead',
			},
		];
	}, [data, config]);

	return (
		<div>
			<div
				className="grid gap-4"
				style={{
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
				}}
				data-testid="grpo-summary-cards"
				role="region"
				aria-label="GRPO summary metrics"
			>
				{metrics.map((metric, index) => (
					<MetricCard
						key={metric.label}
						icon={metric.icon}
						label={metric.label}
						value={metric.value}
						subtitle={metric.subtitle}
						theme={theme}
						animationIndex={index}
					/>
				))}
			</div>
			{trainingStatus === 'running' && (
				<div
					className="flex items-center gap-2 mt-3 px-1"
					style={{ color: theme.colors.accent }}
					data-testid="grpo-training-indicator"
				>
					<div
						className="w-2 h-2 rounded-full"
						style={{
							backgroundColor: theme.colors.accent,
							animation: 'pulse 1.5s ease-in-out infinite',
						}}
					/>
					<span className="text-xs font-medium">Learning...</span>
				</div>
			)}
		</div>
	);
}

export default GRPOSummaryCards;
