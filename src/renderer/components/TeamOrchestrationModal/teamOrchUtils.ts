/**
 * teamOrchUtils
 *
 * Shared utility functions for Team Orchestration modal components.
 * Handles formatting of durations, token counts, costs, percentages,
 * topology display names, and status-to-color mapping.
 */

import type { Theme } from '../../types';

/**
 * Format milliseconds as a human-readable duration string.
 * Examples: "2h 15m", "5m 30s", "45s"
 */
export function formatDuration(ms: number): string {
	if (ms === 0) return '0s';

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Format large numbers with K/M suffixes.
 * Examples: 1500 -> "1.5K", 1200000 -> "1.2M", 500 -> "500"
 */
export function formatTokenCount(count: number): string {
	if (count >= 1000000) {
		return `${(count / 1000000).toFixed(1)}M`;
	}
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * Format a USD amount as "$X.XX".
 */
export function formatCost(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

/**
 * Format a number as a percentage string "X.X%".
 */
export function formatPercentage(value: number): string {
	return `${value.toFixed(1)}%`;
}

const TOPOLOGY_DISPLAY_NAMES: Record<string, string> = {
	'hub-spoke': 'Hub & Spoke',
	pipeline: 'Pipeline',
	'parallel-then-merge': 'Parallel Merge',
	'review-loop': 'Review Loop',
	custom: 'Custom',
};

/**
 * Map a topology pattern ID to a human-readable display name.
 */
export function topologyDisplayName(pattern: string): string {
	return TOPOLOGY_DISPLAY_NAMES[pattern] ?? pattern;
}

/**
 * Map a workflow status to an appropriate theme color.
 */
/**
 * Adjust tooltip position to prevent clipping at viewport edges.
 * Assumes a tooltip roughly 200px wide and 100px tall.
 */
export function clampTooltipPosition(pos: { x: number; y: number }): { x: number; y: number } {
	const margin = 8;
	const tooltipWidth = 200;
	const tooltipHeight = 100;
	return {
		x: Math.min(pos.x, window.innerWidth - tooltipWidth - margin),
		y: Math.max(margin + tooltipHeight, Math.min(pos.y, window.innerHeight - margin)),
	};
}

export function statusColor(status: string, theme: Theme): string {
	switch (status) {
		case 'completed':
			return theme.colors.success;
		case 'failed':
			return theme.colors.error;
		case 'terminated':
			return theme.colors.warning;
		case 'running':
			return theme.colors.accent;
		default:
			return theme.colors.textDim;
	}
}
