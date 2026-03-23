/**
 * BuilderEdgeComponent — SVG group rendering a single edge between two nodes.
 *
 * Features:
 * - Cubic bezier path from source output port to target input port
 * - Edge type visual differentiation (sequential, parallel, conditional)
 * - Arrow head at target end via SVG marker
 * - Click to select with visual highlight
 * - Delete button on hover near midpoint
 * - Midpoint labels for parallel ("||") and conditional ("?" diamond)
 */

import { useState, useCallback, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { BuilderEdge, BuilderAction, BuilderNode } from './builderTypes';
import { NODE_WIDTH, NODE_HEIGHT } from './builderTypes';

interface BuilderEdgeComponentProps {
	edge: BuilderEdge;
	sourceNode: BuilderNode;
	targetNode: BuilderNode;
	theme: Theme;
	selected: boolean;
	isBackEdge?: boolean;
	dispatch: React.Dispatch<BuilderAction>;
}

/** Horizontal offset for bezier control points */
const CONTROL_POINT_OFFSET = 60;

/** Size of the delete button */
const DELETE_BUTTON_RADIUS = 10;

function getEdgeColor(edgeType: BuilderEdge['edgeType'], theme: Theme): string {
	switch (edgeType) {
		case 'parallel':
			return theme.colors.accent;
		case 'conditional':
			return theme.colors.warning;
		case 'sequential':
		default:
			return theme.colors.textMain;
	}
}

/** Compute the SVG path and midpoint for an edge between two nodes */
function computeEdgePath(sourceNode: BuilderNode, targetNode: BuilderNode, isBackEdge?: boolean) {
	const sx = sourceNode.x + NODE_WIDTH;
	const sy = sourceNode.y + NODE_HEIGHT / 2;
	const tx = targetNode.x;
	const ty = targetNode.y + NODE_HEIGHT / 2;

	let d: string;
	let midX: number;
	let midY: number;

	if (isBackEdge) {
		// Loop-back curve: route below both nodes then back up to target
		const loopOffset = 80;
		const bottomY = Math.max(sy, ty) + loopOffset;
		d = `M ${sx} ${sy} C ${sx + CONTROL_POINT_OFFSET} ${sy}, ${sx + CONTROL_POINT_OFFSET} ${bottomY}, ${(sx + tx) / 2} ${bottomY} C ${tx - CONTROL_POINT_OFFSET} ${bottomY}, ${tx - CONTROL_POINT_OFFSET} ${ty}, ${tx} ${ty}`;
		midX = (sx + tx) / 2;
		midY = bottomY;
	} else {
		// Normal forward curve
		const c1x = sx + CONTROL_POINT_OFFSET;
		const c1y = sy;
		const c2x = tx - CONTROL_POINT_OFFSET;
		const c2y = ty;
		d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
		midX = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx;
		midY = 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ty;
	}

	return { d, sx, sy, tx, ty, midX, midY };
}

export function BuilderEdgeComponent({
	edge,
	sourceNode,
	targetNode,
	theme,
	selected,
	isBackEdge,
	dispatch,
}: BuilderEdgeComponentProps): JSX.Element {
	const [hovered, setHovered] = useState(false);

	const { d, midX, midY } = useMemo(
		() => computeEdgePath(sourceNode, targetNode, isBackEdge),
		[sourceNode, targetNode, isBackEdge]
	);

	const color = getEdgeColor(edge.edgeType, theme);
	const strokeWidth = selected ? 3 : hovered ? 2.5 : 1.5;
	const isDashed = edge.edgeType === 'conditional';

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			dispatch({ type: 'SELECT_EDGE', edgeId: edge.id });
		},
		[dispatch, edge.id]
	);

	const handleDelete = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			dispatch({ type: 'DELETE_EDGE', edgeId: edge.id });
		},
		[dispatch, edge.id]
	);

	return (
		<g
			onClick={handleClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{ cursor: 'pointer' }}
			data-edge-id={edge.id}
		>
			{/* Invisible wider path for easier click target */}
			<path d={d} fill="none" stroke="transparent" strokeWidth={14} />

			{/* Visible edge path */}
			<path
				d={d}
				fill="none"
				stroke={selected ? theme.colors.accent : color}
				strokeWidth={strokeWidth}
				strokeDasharray={isDashed ? '6 3' : undefined}
				markerEnd={`url(#builder-arrow-${edge.edgeType})`}
			/>

			{/* Selected highlight glow */}
			{selected && (
				<path
					d={d}
					fill="none"
					stroke={theme.colors.accent}
					strokeWidth={strokeWidth + 4}
					strokeDasharray={isDashed ? '6 3' : undefined}
					opacity={0.15}
					style={{ pointerEvents: 'none' }}
				/>
			)}

			{/* Parallel edge label: "||" at midpoint */}
			{edge.edgeType === 'parallel' && (
				<g style={{ pointerEvents: 'none' }}>
					<rect
						x={midX - 10}
						y={midY - 8}
						width={20}
						height={16}
						rx={3}
						fill={theme.colors.bgMain}
						stroke={color}
						strokeWidth={1}
					/>
					<text
						x={midX}
						y={midY + 1}
						textAnchor="middle"
						dominantBaseline="central"
						fill={color}
						fontSize={10}
						fontWeight={700}
						fontFamily="monospace"
					>
						||
					</text>
				</g>
			)}

			{/* Conditional edge label: "?" diamond at midpoint */}
			{edge.edgeType === 'conditional' && (
				<g style={{ pointerEvents: 'none' }}>
					<polygon
						points={`${midX},${midY - 10} ${midX + 10},${midY} ${midX},${midY + 10} ${midX - 10},${midY}`}
						fill={theme.colors.bgMain}
						stroke={color}
						strokeWidth={1}
					/>
					<text
						x={midX}
						y={midY + 1}
						textAnchor="middle"
						dominantBaseline="central"
						fill={color}
						fontSize={11}
						fontWeight={700}
					>
						?
					</text>
				</g>
			)}

			{/* Condition text (if set) */}
			{edge.condition && (
				<text
					x={midX}
					y={midY - 16}
					textAnchor="middle"
					fill={theme.colors.textDim}
					fontSize={9}
					fontStyle="italic"
					style={{ pointerEvents: 'none' }}
				>
					{edge.condition}
				</text>
			)}

			{/* Back-edge loop label */}
			{isBackEdge && (
				<g style={{ pointerEvents: 'none' }}>
					<rect
						x={midX - 18}
						y={midY - 8}
						width={36}
						height={16}
						rx={4}
						fill={theme.colors.bgMain}
						stroke={theme.colors.warning}
						strokeWidth={1}
					/>
					<text
						x={midX}
						y={midY + 1}
						textAnchor="middle"
						dominantBaseline="central"
						fill={theme.colors.warning}
						fontSize={9}
						fontWeight={600}
						fontFamily="monospace"
					>
						loop
					</text>
				</g>
			)}

			{/* Delete button on hover */}
			{hovered && (
				<g onClick={handleDelete} style={{ cursor: 'pointer' }}>
					<circle
						cx={midX + 16}
						cy={midY - 12}
						r={DELETE_BUTTON_RADIUS}
						fill={theme.colors.error}
						opacity={0.85}
					/>
					{/* X icon */}
					<line
						x1={midX + 12}
						y1={midY - 16}
						x2={midX + 20}
						y2={midY - 8}
						stroke={theme.colors.bgMain}
						strokeWidth={2}
						strokeLinecap="round"
					/>
					<line
						x1={midX + 20}
						y1={midY - 16}
						x2={midX + 12}
						y2={midY - 8}
						stroke={theme.colors.bgMain}
						strokeWidth={2}
						strokeLinecap="round"
					/>
				</g>
			)}
		</g>
	);
}
