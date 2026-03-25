/**
 * TeamBuilderEdge — Custom ReactFlow edge for team builder connections.
 *
 * Renders tier-aware styling based on source and target role tiers:
 *   - Worker → Manager:     Solid line, green-to-blue gradient, "Reports to"
 *   - Manager → Executive:  Solid line, blue-to-amber gradient, "Escalates to"
 *   - Worker → Executive:   Solid line, green-to-amber gradient, "Reports to"
 *   - Executive → Executive: Dashed line, amber, "Reports to"
 *   - Manager → Manager:    Dotted line, blue, "Coordinates with"
 *
 * Label shown only when hovered or selected.
 */

import { memo, useState } from 'react';
import { getBezierPath, BaseEdge, EdgeLabelRenderer, type EdgeProps } from 'reactflow';
import { TIER_COLORS } from '../nodes/RoleBuilderNode';
import type { RoleTier } from '../../../../shared/group-chat-types';

// ============================================================================
// Edge data interface
// ============================================================================

export interface TeamBuilderEdgeData {
	connectionType: 'reports-to' | 'delegates-to';
	tierColor: string;
	sourceTier?: RoleTier;
	targetTier?: RoleTier;
}

// ============================================================================
// Tier-aware edge style configuration
// ============================================================================

export interface EdgeStyleConfig {
	label: string;
	strokeDasharray?: string;
	useGradient: boolean;
}

/**
 * Determine edge label and line style from source/target tiers.
 * Exported for unit testing.
 */
export function getEdgeStyleConfig(sourceTier: RoleTier, targetTier: RoleTier): EdgeStyleConfig {
	// Executive → Executive: Dashed line, amber, "Reports to"
	if (sourceTier === 'executive' && targetTier === 'executive') {
		return { label: 'Reports to', strokeDasharray: '6 3', useGradient: false };
	}

	// Manager → Manager: Dotted line, blue, "Coordinates with"
	if (sourceTier === 'manager' && targetTier === 'manager') {
		return { label: 'Coordinates with', strokeDasharray: '3 3', useGradient: false };
	}

	// Manager → Executive: Solid line, blue-to-amber gradient, "Escalates to"
	if (sourceTier === 'manager' && targetTier === 'executive') {
		return { label: 'Escalates to', useGradient: true };
	}

	// Worker → Manager: Solid line, green-to-blue gradient, "Reports to"
	// Worker → Executive: Solid line, green-to-amber gradient, "Reports to"
	return { label: 'Reports to', useGradient: true };
}

// ============================================================================
// TeamBuilderEdge component
// ============================================================================

export const TeamBuilderEdge = memo(function TeamBuilderEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	selected,
}: EdgeProps<TeamBuilderEdgeData>) {
	const sourceTier = data?.sourceTier ?? 'worker';
	const targetTier = data?.targetTier ?? 'worker';
	const sourceColor = TIER_COLORS[sourceTier] ?? TIER_COLORS.worker;
	const targetColor = TIER_COLORS[targetTier] ?? TIER_COLORS.worker;
	const fallbackColor = data?.tierColor ?? sourceColor;

	const styleConfig = getEdgeStyleConfig(sourceTier, targetTier);
	const gradientId = `edge-gradient-${id}`;

	// Determine the stroke value
	const strokeColor = styleConfig.useGradient ? `url(#${gradientId})` : sourceColor;
	// For label pill border, pick a representative color
	const labelColor = styleConfig.useGradient ? targetColor : sourceColor;

	const [hovered, setHovered] = useState(false);
	const showLabel = selected || hovered;

	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<>
			{/* SVG gradient definition for cross-tier edges */}
			{styleConfig.useGradient && (
				<defs>
					<linearGradient
						id={gradientId}
						gradientUnits="userSpaceOnUse"
						x1={sourceX}
						y1={sourceY}
						x2={targetX}
						y2={targetY}
					>
						<stop offset="0%" stopColor={sourceColor} />
						<stop offset="100%" stopColor={targetColor} />
					</linearGradient>
				</defs>
			)}

			{/* Glow underlay for selected edge */}
			{selected && (
				<BaseEdge
					id={`${id}-glow`}
					path={edgePath}
					style={{
						stroke: fallbackColor,
						strokeWidth: 8,
						opacity: 0.3,
						filter: `drop-shadow(0 0 4px ${fallbackColor})`,
						strokeLinecap: 'round',
					}}
				/>
			)}

			{/* Invisible wider hit area for hover detection */}
			<path
				d={edgePath}
				fill="none"
				stroke="transparent"
				strokeWidth={20}
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				style={{ pointerEvents: 'stroke' }}
			/>

			{/* Visible edge */}
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd="url(#team-arrow)"
				style={{
					stroke: strokeColor,
					strokeWidth: selected ? 3 : hovered ? 2 : 1.5,
					strokeDasharray: styleConfig.strokeDasharray,
					transition: 'stroke-width 0.15s',
				}}
			/>

			{/* Connection type label — shown on hover or selection */}
			{showLabel && (
				<EdgeLabelRenderer>
					<div
						onMouseEnter={() => setHovered(true)}
						onMouseLeave={() => setHovered(false)}
						style={{
							position: 'absolute',
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
							pointerEvents: 'all',
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							backgroundColor: '#1e1e2e',
							border: `1px solid ${labelColor}60`,
							borderRadius: 10,
							padding: '2px 8px',
							fontSize: 10,
							color: labelColor,
							fontWeight: 500,
						}}
					>
						{styleConfig.label}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
});

export const teamEdgeTypes = {
	'team-edge': TeamBuilderEdge,
};
