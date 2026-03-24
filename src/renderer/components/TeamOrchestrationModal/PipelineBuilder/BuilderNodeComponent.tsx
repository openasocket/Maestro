/**
 * BuilderNodeComponent — SVG <g> element rendering a single draggable node.
 *
 * Features:
 * - Rounded rect with role name centered
 * - Color-coded by type (role=accent, entry=green, exit=border)
 * - Input port (left) and output port (right)
 * - Selected state: thicker border + glow
 * - Draggable with snap-to-grid
 */

import { useCallback, useRef, useState } from 'react';
import type { Theme } from '../../../types';
import type { BuilderNode, BuilderAction } from './builderTypes';
import { NODE_WIDTH, NODE_HEIGHT, PORT_RADIUS, snapToGrid } from './builderTypes';

interface BuilderNodeComponentProps {
	node: BuilderNode;
	roleName: string;
	theme: Theme;
	selected: boolean;
	highlighted?: boolean;
	isOrphaned?: boolean;
	hasWarning?: boolean;
	dispatch: React.Dispatch<BuilderAction>;
	viewportZoom: number;
	onOutputPortMouseDown?: (nodeId: string) => void;
	onInputPortMouseUp?: (nodeId: string) => void;
}

function getNodeColor(type: BuilderNode['type'], theme: Theme): string {
	switch (type) {
		case 'entry':
			return theme.colors.success;
		case 'exit':
			return theme.colors.border;
		case 'role':
		default:
			return theme.colors.accent;
	}
}

export function BuilderNodeComponent({
	node,
	roleName,
	theme,
	selected,
	highlighted,
	isOrphaned,
	hasWarning,
	dispatch,
	viewportZoom,
	onOutputPortMouseDown,
	onInputPortMouseUp,
}: BuilderNodeComponentProps): JSX.Element {
	const dragRef = useRef<{
		startX: number;
		startY: number;
		nodeStartX: number;
		nodeStartY: number;
	} | null>(null);
	const [hoveredPort, setHoveredPort] = useState<'input' | 'output' | null>(null);

	const color = isOrphaned ? theme.colors.error : getNodeColor(node.type, theme);
	const borderWidth = selected ? 3 : highlighted ? 2.5 : 1.5;

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// Only left click
			if (e.button !== 0) return;
			e.stopPropagation();

			dispatch({ type: 'SELECT_NODE', nodeId: node.id });

			dragRef.current = {
				startX: e.clientX,
				startY: e.clientY,
				nodeStartX: node.x,
				nodeStartY: node.y,
			};

			const handleMouseMove = (me: MouseEvent) => {
				if (!dragRef.current) return;
				const dx = (me.clientX - dragRef.current.startX) / viewportZoom;
				const dy = (me.clientY - dragRef.current.startY) / viewportZoom;
				const newX = snapToGrid(dragRef.current.nodeStartX + dx);
				const newY = snapToGrid(dragRef.current.nodeStartY + dy);
				dispatch({ type: 'MOVE_NODE', nodeId: node.id, x: newX, y: newY });
			};

			const handleMouseUp = () => {
				dragRef.current = null;
				window.removeEventListener('mousemove', handleMouseMove);
				window.removeEventListener('mouseup', handleMouseUp);
			};

			window.addEventListener('mousemove', handleMouseMove);
			window.addEventListener('mouseup', handleMouseUp);
		},
		[node.id, node.x, node.y, dispatch, viewportZoom]
	);

	const cx = node.x + NODE_WIDTH / 2;
	const cy = node.y + NODE_HEIGHT / 2;
	const inputPortX = node.x;
	const inputPortY = cy;
	const outputPortX = node.x + NODE_WIDTH;
	const outputPortY = cy;

	return (
		<g onMouseDown={handleMouseDown} style={{ cursor: 'grab' }}>
			{/* Glow effect for selected or highlighted (Cmd+A) */}
			{(selected || highlighted) && (
				<rect
					x={node.x - 4}
					y={node.y - 4}
					width={NODE_WIDTH + 8}
					height={NODE_HEIGHT + 8}
					rx={12}
					ry={12}
					fill="none"
					stroke={color}
					strokeWidth={1}
					opacity={selected ? 0.3 : 0.2}
				/>
			)}

			{/* Node body */}
			<rect
				x={node.x}
				y={node.y}
				width={NODE_WIDTH}
				height={NODE_HEIGHT}
				rx={8}
				ry={8}
				fill={`${color}15`}
				stroke={color}
				strokeWidth={borderWidth}
				strokeDasharray={isOrphaned ? '6 3' : undefined}
			/>

			{/* Type label (entry/exit) */}
			{node.type !== 'role' && (
				<text
					x={cx}
					y={node.y - 6}
					textAnchor="middle"
					fill={theme.colors.textDim}
					fontSize={9}
					fontWeight={500}
				>
					{node.type === 'entry' ? 'Start' : 'End'}
				</text>
			)}

			{/* Role name */}
			<text
				x={cx}
				y={cy + 1}
				textAnchor="middle"
				dominantBaseline="central"
				fill={theme.colors.textMain}
				fontSize={12}
				fontWeight={600}
				style={{ pointerEvents: 'none', userSelect: 'none' }}
			>
				{roleName.length > 18 ? roleName.slice(0, 16) + '...' : roleName}
			</text>

			{/* Input port (left center) */}
			<circle
				cx={inputPortX}
				cy={inputPortY}
				r={hoveredPort === 'input' ? PORT_RADIUS + 2 : PORT_RADIUS}
				fill={hoveredPort === 'input' ? color : theme.colors.bgMain}
				stroke={color}
				strokeWidth={1.5}
				style={{ cursor: 'crosshair' }}
				onMouseUp={() => onInputPortMouseUp?.(node.id)}
				onMouseEnter={() => setHoveredPort('input')}
				onMouseLeave={() => setHoveredPort(null)}
			/>

			{/* Output port (right center) */}
			<circle
				cx={outputPortX}
				cy={outputPortY}
				r={hoveredPort === 'output' ? PORT_RADIUS + 2 : PORT_RADIUS}
				fill={hoveredPort === 'output' ? color : theme.colors.bgMain}
				stroke={color}
				strokeWidth={1.5}
				style={{ cursor: 'crosshair' }}
				onMouseDown={(e) => {
					e.stopPropagation();
					onOutputPortMouseDown?.(node.id);
				}}
				onMouseEnter={() => setHoveredPort('output')}
				onMouseLeave={() => setHoveredPort(null)}
			/>

			{/* Warning icon for entry point issues */}
			{hasWarning && (
				<g style={{ pointerEvents: 'none' }}>
					<polygon
						points={`${node.x + NODE_WIDTH - 8},${node.y - 2} ${node.x + NODE_WIDTH + 2},${node.y - 2} ${node.x + NODE_WIDTH - 3},${node.y - 12}`}
						fill={theme.colors.warning}
					/>
					<text
						x={node.x + NODE_WIDTH - 3}
						y={node.y - 3}
						textAnchor="middle"
						dominantBaseline="auto"
						fill={theme.colors.bgMain}
						fontSize={8}
						fontWeight={700}
					>
						!
					</text>
				</g>
			)}
		</g>
	);
}
