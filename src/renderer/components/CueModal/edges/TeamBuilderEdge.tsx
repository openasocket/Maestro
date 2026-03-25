/**
 * TeamBuilderEdge — Custom ReactFlow edge for team builder connections.
 *
 * Shows a styled arrow with a label indicating the connection type:
 *   - 'reports-to':   Solid line, arrow at target
 *   - 'delegates-to': Dashed line, arrow at target
 *
 * Label ("Reports to" / "Delegates to") shown only when hovered or selected.
 * Uses the source node's tier color for the edge color.
 */

import { memo, useState } from 'react';
import { getBezierPath, BaseEdge, EdgeLabelRenderer, type EdgeProps } from 'reactflow';
import { TIER_COLORS } from '../nodes/RoleBuilderNode';

// ============================================================================
// Edge data interface
// ============================================================================

export interface TeamBuilderEdgeData {
	connectionType: 'reports-to' | 'delegates-to';
	tierColor: string;
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
	const connectionType = data?.connectionType ?? 'reports-to';
	const color = data?.tierColor ?? TIER_COLORS.worker;
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
			{/* Glow underlay for selected edge */}
			{selected && (
				<BaseEdge
					id={`${id}-glow`}
					path={edgePath}
					style={{
						stroke: color,
						strokeWidth: 8,
						opacity: 0.3,
						filter: `drop-shadow(0 0 4px ${color})`,
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
					stroke: color,
					strokeWidth: selected ? 3 : hovered ? 2 : 1.5,
					strokeDasharray: connectionType === 'delegates-to' ? '6 3' : undefined,
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
							border: `1px solid ${color}60`,
							borderRadius: 10,
							padding: '2px 8px',
							fontSize: 10,
							color,
							fontWeight: 500,
						}}
					>
						{connectionType === 'reports-to' ? 'Reports to' : 'Delegates to'}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
});

export const teamEdgeTypes = {
	'team-edge': TeamBuilderEdge,
};
