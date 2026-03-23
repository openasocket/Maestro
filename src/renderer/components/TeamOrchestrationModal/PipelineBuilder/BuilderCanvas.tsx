/**
 * BuilderCanvas — SVG canvas with pan, zoom, snap-to-grid, and node rendering.
 *
 * Features:
 * - Fills container via SVG with 100% width/height
 * - Viewport transform via <g transform="translate(x,y) scale(zoom)">
 * - 20px grid lines rendered in background
 * - Pan: middle-click drag or Space+drag
 * - Zoom: mouse wheel
 * - Click empty canvas to deselect
 * - Drop target for palette nodes
 * - Edge rendering between connected nodes
 */

import { useCallback, useRef, useState, useEffect } from 'react';
import type { Theme } from '../../../types';
import type { BuilderState, BuilderAction, BuilderNode } from './builderTypes';
import { GRID_SIZE, NODE_WIDTH, NODE_HEIGHT, PORT_RADIUS } from './builderTypes';
import { BuilderNodeComponent } from './BuilderNodeComponent';

interface BuilderCanvasProps {
	state: BuilderState;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
}

/** Convert client mouse coords to SVG canvas coords accounting for viewport */
function clientToCanvas(
	clientX: number,
	clientY: number,
	svgRect: DOMRect,
	viewport: BuilderState['viewport']
): { x: number; y: number } {
	const svgX = clientX - svgRect.left;
	const svgY = clientY - svgRect.top;
	return {
		x: (svgX - viewport.x) / viewport.zoom,
		y: (svgY - viewport.y) / viewport.zoom,
	};
}

function getEdgeColor(edgeType: string, theme: Theme): string {
	switch (edgeType) {
		case 'parallel':
			return theme.colors.warning;
		case 'conditional':
			return theme.colors.accent;
		case 'sequential':
		default:
			return theme.colors.textDim;
	}
}

export function BuilderCanvas({ state, dispatch, theme }: BuilderCanvasProps): JSX.Element {
	const svgRef = useRef<SVGSVGElement>(null);
	const [spaceHeld, setSpaceHeld] = useState(false);
	const panRef = useRef<{ startX: number; startY: number; vpX: number; vpY: number } | null>(null);

	// Edge drawing interaction state
	const [drawingEdge, setDrawingEdge] = useState<{
		sourceNodeId: string;
		mouseX: number;
		mouseY: number;
	} | null>(null);
	const viewportRef = useRef(state.viewport);
	viewportRef.current = state.viewport;
	const drawingEdgeRef = useRef(drawingEdge);
	drawingEdgeRef.current = drawingEdge;

	// Track space key for pan mode
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code === 'Space' && !e.repeat) {
				e.preventDefault();
				setSpaceHeld(true);
			}
			if (e.code === 'Delete' || e.code === 'Backspace') {
				if (state.selectedNodeId) {
					dispatch({ type: 'DELETE_NODE', nodeId: state.selectedNodeId });
				} else if (state.selectedEdgeId) {
					dispatch({ type: 'DELETE_EDGE', edgeId: state.selectedEdgeId });
				}
			}
		};
		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.code === 'Space') {
				setSpaceHeld(false);
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		window.addEventListener('keyup', handleKeyUp);
		return () => {
			window.removeEventListener('keydown', handleKeyDown);
			window.removeEventListener('keyup', handleKeyUp);
		};
	}, [state.selectedNodeId, state.selectedEdgeId, dispatch]);

	// Wheel zoom
	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			const delta = e.deltaY > 0 ? -0.1 : 0.1;
			const newZoom = state.viewport.zoom + delta;
			if (!svgRef.current) return;
			const rect = svgRef.current.getBoundingClientRect();
			dispatch({
				type: 'ZOOM_VIEWPORT',
				zoom: newZoom,
				centerX: e.clientX - rect.left,
				centerY: e.clientY - rect.top,
			});
		},
		[state.viewport.zoom, dispatch]
	);

	// Pan start (middle-click or space+left-click)
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			// Middle-click or space+left-click → pan
			if (e.button === 1 || (e.button === 0 && spaceHeld)) {
				e.preventDefault();
				panRef.current = {
					startX: e.clientX,
					startY: e.clientY,
					vpX: state.viewport.x,
					vpY: state.viewport.y,
				};

				const handleMouseMove = (me: MouseEvent) => {
					if (!panRef.current) return;
					const dx = me.clientX - panRef.current.startX;
					const dy = me.clientY - panRef.current.startY;
					dispatch({
						type: 'LOAD_STATE',
						state: {
							...state,
							viewport: {
								...state.viewport,
								x: panRef.current.vpX + dx,
								y: panRef.current.vpY + dy,
							},
						},
					});
				};

				const handleMouseUp = () => {
					panRef.current = null;
					window.removeEventListener('mousemove', handleMouseMove);
					window.removeEventListener('mouseup', handleMouseUp);
				};

				window.addEventListener('mousemove', handleMouseMove);
				window.addEventListener('mouseup', handleMouseUp);
				return;
			}

			// Left click on empty canvas → deselect
			if (e.button === 0 && e.target === svgRef.current) {
				dispatch({ type: 'CLEAR_SELECTION' });
			}
		},
		[spaceHeld, state, dispatch]
	);

	// Drop handler for palette items
	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			const data = e.dataTransfer.getData('application/pipeline-builder-node');
			if (!data || !svgRef.current) return;

			try {
				const parsed = JSON.parse(data);
				const rect = svgRef.current.getBoundingClientRect();
				const { x, y } = clientToCanvas(e.clientX, e.clientY, rect, state.viewport);

				// Center the node on drop point
				const snappedX = Math.round((x - NODE_WIDTH / 2) / GRID_SIZE) * GRID_SIZE;
				const snappedY = Math.round((y - NODE_HEIGHT / 2) / GRID_SIZE) * GRID_SIZE;

				const nodeId = `node-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
				const roleId = parsed.roleId || nodeId;

				dispatch({
					type: 'ADD_NODE',
					node: {
						id: nodeId,
						roleId,
						x: snappedX,
						y: snappedY,
						width: NODE_WIDTH,
						height: NODE_HEIGHT,
						type: parsed.nodeType || 'role',
					},
					role: {
						name: parsed.roleName || 'New Role',
						agentId: parsed.agentId || 'claude-code',
						description: parsed.description || '',
					},
				});
			} catch {
				// Invalid drop data, ignore
			}
		},
		[state.viewport, dispatch]
	);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
	}, []);

	// Edge drawing: start from output port
	const handleOutputPortMouseDown = useCallback(
		(nodeId: string) => {
			const sourceNode = state.nodes.find((n) => n.id === nodeId);
			if (!sourceNode) return;

			const outputX = sourceNode.x + NODE_WIDTH;
			const outputY = sourceNode.y + NODE_HEIGHT / 2;
			setDrawingEdge({ sourceNodeId: nodeId, mouseX: outputX, mouseY: outputY });

			const handleMouseMove = (me: MouseEvent) => {
				if (!svgRef.current) return;
				const rect = svgRef.current.getBoundingClientRect();
				const { x, y } = clientToCanvas(me.clientX, me.clientY, rect, viewportRef.current);
				setDrawingEdge((prev) => (prev ? { ...prev, mouseX: x, mouseY: y } : null));
			};

			const handleMouseUp = () => {
				setDrawingEdge(null);
				window.removeEventListener('mousemove', handleMouseMove);
				window.removeEventListener('mouseup', handleMouseUp);
			};

			window.addEventListener('mousemove', handleMouseMove);
			window.addEventListener('mouseup', handleMouseUp);
		},
		[state.nodes]
	);

	// Edge drawing: complete on input port
	const handleInputPortMouseUp = useCallback(
		(targetNodeId: string) => {
			const de = drawingEdgeRef.current;
			if (!de) return;

			const { sourceNodeId } = de;

			// Prevent self-connections
			if (sourceNodeId === targetNodeId) {
				setDrawingEdge(null);
				return;
			}

			// Prevent duplicate edges
			const exists = state.edges.some(
				(e) => e.sourceNodeId === sourceNodeId && e.targetNodeId === targetNodeId
			);
			if (exists) {
				setDrawingEdge(null);
				return;
			}

			const edgeId = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			dispatch({
				type: 'ADD_EDGE',
				edge: {
					id: edgeId,
					sourceNodeId,
					targetNodeId,
					edgeType: 'sequential',
				},
			});

			setDrawingEdge(null);
		},
		[state.edges, dispatch]
	);

	// Build a lookup for nodes by ID
	const nodeById = new Map<string, BuilderNode>();
	for (const n of state.nodes) {
		nodeById.set(n.id, n);
	}

	// Compute visible grid bounds
	const vp = state.viewport;
	const gridColor = theme.colors.border;

	return (
		<svg
			ref={svgRef}
			width="100%"
			height="100%"
			style={{
				cursor: spaceHeld ? 'grab' : 'default',
				backgroundColor: theme.colors.bgMain,
			}}
			onWheel={handleWheel}
			onMouseDown={handleMouseDown}
			onDrop={handleDrop}
			onDragOver={handleDragOver}
		>
			<g transform={`translate(${vp.x},${vp.y}) scale(${vp.zoom})`}>
				{/* Grid pattern */}
				<defs>
					<pattern
						id="builder-grid"
						width={GRID_SIZE}
						height={GRID_SIZE}
						patternUnits="userSpaceOnUse"
					>
						<path
							d={`M ${GRID_SIZE} 0 L 0 0 0 ${GRID_SIZE}`}
							fill="none"
							stroke={gridColor}
							strokeWidth={0.3}
							opacity={0.3}
						/>
					</pattern>
				</defs>
				<rect x={-5000} y={-5000} width={10000} height={10000} fill="url(#builder-grid)" />

				{/* Edges */}
				{state.edges.map((edge) => {
					const source = nodeById.get(edge.sourceNodeId);
					const target = nodeById.get(edge.targetNodeId);
					if (!source || !target) return null;

					const sx = source.x + NODE_WIDTH;
					const sy = source.y + NODE_HEIGHT / 2;
					const tx = target.x;
					const ty = target.y + NODE_HEIGHT / 2;

					// Cubic bezier for smooth edge
					const midX = (sx + tx) / 2;
					const d = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`;
					const edgeColor = getEdgeColor(edge.edgeType, theme);
					const isSelected = edge.id === state.selectedEdgeId;

					return (
						<g
							key={edge.id}
							onClick={(e) => {
								e.stopPropagation();
								dispatch({ type: 'SELECT_EDGE', edgeId: edge.id });
							}}
							style={{ cursor: 'pointer' }}
						>
							{/* Invisible wider path for easier click target */}
							<path d={d} fill="none" stroke="transparent" strokeWidth={12} />
							<path
								d={d}
								fill="none"
								stroke={edgeColor}
								strokeWidth={isSelected ? 3 : 1.5}
								strokeDasharray={edge.edgeType === 'conditional' ? '6 3' : undefined}
								markerEnd={`url(#arrow-${edge.edgeType})`}
							/>
							{edge.condition && (
								<text
									x={midX}
									y={(sy + ty) / 2 - 8}
									textAnchor="middle"
									fill={theme.colors.textDim}
									fontSize={9}
									fontStyle="italic"
								>
									{edge.condition}
								</text>
							)}
						</g>
					);
				})}

				{/* Temporary drawing edge */}
				{drawingEdge &&
					(() => {
						const sourceNode = nodeById.get(drawingEdge.sourceNodeId);
						if (!sourceNode) return null;
						const sx = sourceNode.x + NODE_WIDTH;
						const sy = sourceNode.y + NODE_HEIGHT / 2;
						const tx = drawingEdge.mouseX;
						const ty = drawingEdge.mouseY;
						const midX = (sx + tx) / 2;
						const d = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`;
						return (
							<path
								d={d}
								fill="none"
								stroke={theme.colors.accent}
								strokeWidth={2}
								strokeDasharray="6 3"
								opacity={0.5}
								style={{ pointerEvents: 'none' }}
							/>
						);
					})()}

				{/* Arrow markers */}
				<defs>
					{['sequential', 'parallel', 'conditional'].map((et) => (
						<marker
							key={et}
							id={`arrow-${et}`}
							markerWidth={8}
							markerHeight={8}
							refX={PORT_RADIUS + 6}
							refY={4}
							orient="auto"
						>
							<path d="M 0 0 L 8 4 L 0 8 Z" fill={getEdgeColor(et, theme)} />
						</marker>
					))}
				</defs>

				{/* Nodes */}
				{state.nodes.map((node) => (
					<BuilderNodeComponent
						key={node.id}
						node={node}
						roleName={state.roles[node.roleId]?.name ?? node.roleId}
						theme={theme}
						selected={node.id === state.selectedNodeId}
						dispatch={dispatch}
						viewportZoom={vp.zoom}
						onOutputPortMouseDown={handleOutputPortMouseDown}
						onInputPortMouseUp={handleInputPortMouseUp}
					/>
				))}
			</g>
		</svg>
	);
}
