/**
 * ExperienceGrowthChart
 *
 * Stacked area chart showing experience library growth over training epochs.
 *
 * Features:
 * - Stacked areas: entries added (green), modified (yellow), deleted (red)
 * - Net library size line overlay
 * - Theme-aware styling with inline styles
 * - Colorblind-friendly mode support
 * - Tooltip showing exact values on hover
 */

import React, { useState, useMemo, useCallback } from 'react';
import type { Theme } from '../../types';
import type { EpochStats } from '../../../shared/grpo-types';
import { COLORBLIND_AGENT_PALETTE } from '../../constants/colorblindPalettes';

interface ExperienceGrowthChartProps {
	/** Per-epoch stats from GRPO training */
	epochs: EpochStats[];
	/** Current theme for styling */
	theme: Theme;
	/** Enable colorblind-friendly colors */
	colorBlindMode?: boolean;
}

// Chart dimensions
const CHART_WIDTH = 600;
const CHART_HEIGHT = 220;
const PADDING = { top: 20, right: 40, bottom: 40, left: 60 };
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right;
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom;

/** Colors for each operation type */
function getColors(colorBlindMode: boolean) {
	if (colorBlindMode) {
		return {
			add: COLORBLIND_AGENT_PALETTE[2],    // teal
			modify: COLORBLIND_AGENT_PALETTE[1],  // orange
			delete: COLORBLIND_AGENT_PALETTE[3],  // vermillion
			netLine: COLORBLIND_AGENT_PALETTE[0],  // blue
		};
	}
	return {
		add: '#22c55e',     // green
		modify: '#eab308',  // yellow
		delete: '#ef4444',  // red
		netLine: '#6366f1', // indigo
	};
}

export function ExperienceGrowthChart({
	epochs,
	theme,
	colorBlindMode = false,
}: ExperienceGrowthChartProps) {
	const [hoveredEpoch, setHoveredEpoch] = useState<EpochStats | null>(null);
	const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

	const colors = useMemo(() => getColors(colorBlindMode), [colorBlindMode]);

	// Compute cumulative operations per epoch for stacked area
	const chartData = useMemo(() => {
		if (epochs.length === 0) return [];
		return epochs.map((ep) => ({
			epoch: ep.epoch,
			add: ep.experienceOperations.add,
			modify: ep.experienceOperations.modify,
			delete: ep.experienceOperations.delete,
			total: ep.experienceOperations.add + ep.experienceOperations.modify + ep.experienceOperations.delete,
			librarySize: ep.librarySize,
		}));
	}, [epochs]);

	// Compute scales
	const { xScale, yScale, yTicks } = useMemo(() => {
		if (chartData.length === 0) {
			return {
				xScale: (_: number) => PADDING.left,
				yScale: (_: number) => CHART_HEIGHT - PADDING.bottom,
				yMax: 10,
				yTicks: [0, 5, 10],
			};
		}

		const maxOps = Math.max(...chartData.map(d => d.total), 1);
		const maxLib = Math.max(...chartData.map(d => d.librarySize), 1);
		const yMaxVal = Math.max(maxOps, maxLib) * 1.1;

		const xScaleFn = (index: number) =>
			PADDING.left + (index / Math.max(chartData.length - 1, 1)) * INNER_WIDTH;
		const yScaleFn = (value: number) =>
			CHART_HEIGHT - PADDING.bottom - (value / yMaxVal) * INNER_HEIGHT;

		const tickCount = 5;
		const yTicksArr = Array.from({ length: tickCount }, (_, i) =>
			Math.round((yMaxVal / (tickCount - 1)) * i)
		);

		return { xScale: xScaleFn, yScale: yScaleFn, yMax: yMaxVal, yTicks: yTicksArr };
	}, [chartData]);

	// Generate stacked area paths
	const areaPaths = useMemo(() => {
		if (chartData.length === 0) return { add: '', modify: '', delete: '' };

		const baseline = CHART_HEIGHT - PADDING.bottom;

		// Add layer (bottom)
		const addPath = chartData
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.add)}`)
			.join(' ');
		const addClose = ` L ${xScale(chartData.length - 1)} ${baseline} L ${xScale(0)} ${baseline} Z`;

		// Modify layer (stacked on add)
		const modifyPath = chartData
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.add + d.modify)}`)
			.join(' ');
		const modifyBottom = [...chartData].reverse()
			.map((d, i) => `L ${xScale(chartData.length - 1 - i)} ${yScale(d.add)}`)
			.join(' ');

		// Delete layer (stacked on add + modify)
		const deletePath = chartData
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.add + d.modify + d.delete)}`)
			.join(' ');
		const deleteBottom = [...chartData].reverse()
			.map((d, i) => `L ${xScale(chartData.length - 1 - i)} ${yScale(d.add + d.modify)}`)
			.join(' ');

		return {
			add: addPath + addClose,
			modify: modifyPath + ' ' + modifyBottom + ' Z',
			delete: deletePath + ' ' + deleteBottom + ' Z',
		};
	}, [chartData, xScale, yScale]);

	// Net library size line
	const libLinePath = useMemo(() => {
		if (chartData.length === 0) return '';
		return chartData
			.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.librarySize)}`)
			.join(' ');
	}, [chartData, xScale, yScale]);

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
			aria-label={`Experience growth chart showing library changes across ${epochs.length} epochs`}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Experience Library Growth
				</h3>
			</div>

			{/* Chart */}
			<div className="relative">
				{chartData.length === 0 ? (
					<div
						className="flex items-center justify-center"
						style={{ height: CHART_HEIGHT, color: theme.colors.textDim }}
					>
						<span className="text-sm">No epoch data yet</span>
					</div>
				) : (
					<svg
						width="100%"
						viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
						preserveAspectRatio="xMidYMid meet"
						role="img"
						aria-label="Stacked area chart of experience library growth"
					>
						{/* Grid lines */}
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
									{tick}
								</text>
							</g>
						))}

						{/* X-axis labels */}
						{chartData.map((d, idx) => {
							const labelInterval = chartData.length > 14
								? Math.ceil(chartData.length / 7)
								: chartData.length > 7 ? 2 : 1;
							if (idx % labelInterval !== 0 && idx !== chartData.length - 1) return null;
							return (
								<text
									key={`xlabel-${idx}`}
									x={xScale(idx)}
									y={CHART_HEIGHT - PADDING.bottom + 20}
									textAnchor="middle"
									fontSize={10}
									fill={theme.colors.textDim}
								>
									{d.epoch}
								</text>
							);
						})}

						{/* Stacked areas */}
						<path d={areaPaths.add} fill={colors.add} fillOpacity={0.4} />
						<path d={areaPaths.modify} fill={colors.modify} fillOpacity={0.4} />
						<path d={areaPaths.delete} fill={colors.delete} fillOpacity={0.4} />

						{/* Net library size line */}
						<path
							d={libLinePath}
							fill="none"
							stroke={colors.netLine}
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeDasharray="6,3"
						/>

						{/* Hover points on library size line */}
						{epochs.map((ep, idx) => {
							const d = chartData[idx];
							if (!d) return null;
							const x = xScale(idx);
							const y = yScale(d.librarySize);
							const isHovered = hoveredEpoch?.epoch === ep.epoch;

							return (
								<circle
									key={`point-${idx}`}
									cx={x}
									cy={y}
									r={isHovered ? 5 : 3}
									fill={isHovered ? colors.netLine : theme.colors.bgMain}
									stroke={colors.netLine}
									strokeWidth={2}
									style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
									onMouseEnter={(e) => handleMouseEnter(ep, e)}
									onMouseLeave={handleMouseLeave}
									role="graphics-symbol"
									aria-label={`Epoch ${ep.epoch}: ${d.librarySize} entries`}
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
							Entries
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
								Library Size:{' '}
								<span style={{ color: theme.colors.textMain }}>{hoveredEpoch.librarySize}</span>
							</div>
							<div>
								Added:{' '}
								<span style={{ color: colors.add }}>{hoveredEpoch.experienceOperations.add}</span>
								{' '}Modified:{' '}
								<span style={{ color: colors.modify }}>{hoveredEpoch.experienceOperations.modify}</span>
								{' '}Deleted:{' '}
								<span style={{ color: colors.delete }}>{hoveredEpoch.experienceOperations.delete}</span>
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
					<div className="w-3 h-3 rounded-sm" style={{ backgroundColor: colors.add, opacity: 0.6 }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>Added</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="w-3 h-3 rounded-sm" style={{ backgroundColor: colors.modify, opacity: 0.6 }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>Modified</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="w-3 h-3 rounded-sm" style={{ backgroundColor: colors.delete, opacity: 0.6 }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>Deleted</span>
				</div>
				<div className="flex items-center gap-1.5">
					<div className="w-4 h-0.5 rounded" style={{ backgroundColor: colors.netLine, opacity: 0.8 }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>Library Size</span>
				</div>
			</div>
		</div>
	);
}

export default ExperienceGrowthChart;
