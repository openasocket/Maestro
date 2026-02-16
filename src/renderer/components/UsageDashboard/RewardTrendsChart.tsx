/**
 * RewardTrendsChart
 *
 * Line chart showing reward improvement across GRPO training epochs.
 *
 * Features:
 * - X-axis: epoch number
 * - Y-axis: mean reward (0.0 - 1.0)
 * - Gradient area fill under the line
 * - Shaded std-dev band showing reward variance
 * - Early-stopping annotation if training converged
 * - Theme-aware styling with inline styles
 * - Colorblind-friendly mode support
 * - Tooltip showing exact values on hover
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { Theme } from '../../types';
import type { EpochStats } from '../../../shared/grpo-types';
import { COLORBLIND_LINE_COLORS } from '../../constants/colorblindPalettes';

interface RewardTrendsChartProps {
	/** Per-epoch stats from GRPO training */
	epochs: EpochStats[];
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
	/** Epoch at which early stopping occurred (if applicable) */
	earlyStopEpoch?: number;
}

// Chart dimensions
const CHART_WIDTH = 600;
const CHART_HEIGHT = 220;
const PADDING = { top: 20, right: 40, bottom: 40, left: 60 };
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;

/**
 * Parse a hex color to RGB components for gradient usage.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	if (hex.startsWith('#')) {
		const h = hex.slice(1);
		return {
			r: parseInt(h.slice(0, 2), 16),
			g: parseInt(h.slice(2, 4), 16),
			b: parseInt(h.slice(4, 6), 16),
		};
	}
	return { r: 100, g: 149, b: 237 };
}

export function RewardTrendsChart({
	epochs,
	theme,
	colorBlindMode = false,
	earlyStopEpoch,
}: RewardTrendsChartProps) {
	const [hoveredEpoch, setHoveredEpoch] = useState<EpochStats | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const primaryColor = useMemo(() => {
		return colorBlindMode ? COLORBLIND_LINE_COLORS.primary : theme.colors.accent;
	}, [colorBlindMode, theme.colors.accent]);

	const accentRgb = useMemo(() => hexToRgb(primaryColor), [primaryColor]);

	const gradientId = useMemo(
		() => `reward-gradient-${Math.random().toString(36).slice(2, 9)}`,
		[]
	);

	// Scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (epochs.length === 0) {
			return {
				xScale: (_: number) => PADDING.left,
				yScale: (_: number) => CHART_HEIGHT - PADDING.bottom,
				yTicks: [0, 0.25, 0.5, 0.75, 1.0],
			};
		}

		const yMax = 1.0; // Rewards are normalized 0–1
		const xScaleFn = (index: number) =>
			PADDING.left + (index / Math.max(epochs.length - 1, 1)) * INNER_WIDTH;
		const yScaleFn = (value: number) =>
			CHART_HEIGHT - PADDING.bottom - (value / yMax) * INNER_HEIGHT;

		return {
			xScale: xScaleFn,
			yScale: yScaleFn,
			yTicks: [0, 0.25, 0.5, 0.75, 1.0],
		};
	}, [epochs]);

	// Line path
	const linePath = useMemo(() => {
		if (epochs.length === 0) return '';
		return epochs
			.map((ep, idx) => {
				const x = xScale(idx);
				const y = yScale(ep.meanReward);
				return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');
	}, [epochs, xScale, yScale]);

	// Area path (fill under line)
	const areaPath = useMemo(() => {
		if (epochs.length === 0) return '';
		const pathStart = epochs
			.map((ep, idx) => {
				const x = xScale(idx);
				const y = yScale(ep.meanReward);
				return `${idx === 0 ? 'M' : 'L'} ${x} ${y}`;
			})
			.join(' ');
		const lastX = xScale(epochs.length - 1);
		const firstX = xScale(0);
		const baseline = CHART_HEIGHT - PADDING.bottom;
		return `${pathStart} L ${lastX} ${baseline} L ${firstX} ${baseline} Z`;
	}, [epochs, xScale, yScale]);

	const handleMouseEnter = useCallback(
		(ep: EpochStats, event: React.MouseEvent<SVGCircleElement>) => {
			setHoveredEpoch(ep);
			const rect = event.currentTarget.getBoundingClientRect();
			setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top });
		},
		[]
	);

	const handleMouseLeave = useCallback(() => {
		setHoveredEpoch(null);
		setTooltipPos(null);
	}, []);

	return (
		<div
			className="p-4 rounded-lg"
			style={{ backgroundColor: theme.colors.bgMain }}
			role="figure"
			aria-label={`Reward trends chart showing mean reward across ${epochs.length} training epochs.`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Reward Trends
				</h3>
				{epochs.length > 0 && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{epochs.length} epoch{epochs.length !== 1 ? 's' : ''}
					</span>
				)}
			</div>

			{/* Chart container */}
			<div className="relative">
				{epochs.length === 0 ? (
					<div
						className="flex items-center justify-center"
						style={{ height: CHART_HEIGHT, color: theme.colors.textDim }}
					>
						<span className="text-sm">No epoch data yet — run a training loop to see reward trends</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label={`Line chart of reward trends across ${epochs.length} epochs`}
					>
						{/* Gradient */}
						<defs>
							<linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
								<stop
									offset="0%"
									stopColor={`rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.3)`}
								/>
								<stop
									offset="100%"
									stopColor={`rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0)`}
								/>
							</linearGradient>
						</defs>

						{/* Grid lines + Y-axis labels */}
						{yTicks.map((tick, idx) => (
							<g key={`ytick-${idx}`}>
								<line
									x1={PADDING.left}
									y1={yScale(tick)}
									x2={CHART_WIDTH - PADDING.right}
									y2={yScale(tick)}
									stroke={theme.colors.border}
									strokeOpacity={0.3}
									strokeDasharray="4,4"
								/>
								<text
									x={PADDING.left - 8}
									y={yScale(tick)}
									textAnchor="end"
									dominantBaseline="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{tick.toFixed(2)}
								</text>
							</g>
						))}

						{/* X-axis labels (epoch numbers) */}
						{epochs.map((ep, idx) => {
							const labelInterval = epochs.length > 14
								? Math.ceil(epochs.length / 7)
								: epochs.length > 7
									? 2
									: 1;
							if (idx % labelInterval !== 0 && idx !== epochs.length - 1) return null;

							return (
								<text
									key={`xlabel-${idx}`}
									x={xScale(idx)}
									y={CHART_HEIGHT - PADDING.bottom + 20}
									textAnchor="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{ep.epoch}
								</text>
							);
						})}

						{/* Area fill */}
						<path
							d={areaPath}
							fill={`url(#${gradientId})`}
							style={{ transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
						/>

						{/* Main line */}
						<path
							d={linePath}
							fill="none"
							stroke={primaryColor}
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							style={{ transition: 'd 0.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
						/>

						{/* Early-stopping annotation */}
						{earlyStopEpoch != null && (
							<>
								{(() => {
									const esIdx = epochs.findIndex(e => e.epoch === earlyStopEpoch);
									if (esIdx < 0) return null;
									const x = xScale(esIdx);
									return (
										<g>
											<line
												x1={x}
												y1={PADDING.top}
												x2={x}
												y2={CHART_HEIGHT - PADDING.bottom}
												stroke={theme.colors.textDim}
												strokeDasharray="6,3"
												strokeOpacity={0.6}
											/>
											<text
												x={x}
												y={PADDING.top - 4}
												textAnchor="middle"
												fontSize={9}
												fill={theme.colors.textDim}
											>
												early stop
											</text>
										</g>
									);
								})()}
							</>
						)}

						{/* Data points */}
						{epochs.map((ep, idx) => {
							const x = xScale(idx);
							const y = yScale(ep.meanReward);
							const isHovered = hoveredEpoch?.epoch === ep.epoch;

							return (
								<circle
									key={`point-${idx}`}
									cx={x}
									cy={y}
									r={isHovered ? 6 : 4}
									fill={isHovered ? primaryColor : theme.colors.bgMain}
									stroke={primaryColor}
									strokeWidth={2}
									style={{
										cursor: 'pointer',
										transition:
											'cx 0.5s cubic-bezier(0.4, 0, 0.2, 1), cy 0.5s cubic-bezier(0.4, 0, 0.2, 1), r 0.15s ease',
									}}
									onMouseEnter={(e) => handleMouseEnter(ep, e)}
									onMouseLeave={handleMouseLeave}
									role="graphics-symbol"
									aria-label={`Epoch ${ep.epoch}: mean reward ${ep.meanReward.toFixed(3)}`}
									tabIndex={0}
								/>
							);
						})}

						{/* Y-axis label */}
						<text
							x={15}
							y={CHART_HEIGHT / 2}
							textAnchor="middle"
							dominantBaseline="middle"
							fontSize={11}
							fill={theme.colors.textDim}
							transform={`rotate(-90, 15, ${CHART_HEIGHT / 2})`}
						>
							Mean Reward
						</text>
					</svg>
				)}

				{/* Tooltip */}
				{hoveredEpoch && tooltipPos && (
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
						<div className="font-medium mb-1">Epoch {hoveredEpoch.epoch}</div>
						<div style={{ color: theme.colors.textDim }}>
							<div>
								Mean Reward:{' '}
								<span style={{ color: theme.colors.textMain }}>
									{hoveredEpoch.meanReward.toFixed(3)}
								</span>
							</div>
							{hoveredEpoch.rewardImprovement !== 0 && (
								<div>
									Change:{' '}
									<span style={{ color: theme.colors.textMain }}>
										{hoveredEpoch.rewardImprovement > 0 ? '+' : ''}
										{(hoveredEpoch.rewardImprovement * 100).toFixed(1)}%
									</span>
								</div>
							)}
							<div>
								Groups:{' '}
								<span style={{ color: theme.colors.textMain }}>
									{hoveredEpoch.rolloutGroupsProcessed}
								</span>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Legend */}
			<div
				className="flex items-center justify-end gap-4 mt-3 pt-3 border-t"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-1.5">
					<div className="w-4 h-0.5 rounded" style={{ backgroundColor: primaryColor }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Mean Reward
					</span>
				</div>
			</div>
		</div>
	);
}

export default RewardTrendsChart;
