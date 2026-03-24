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

import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import type { Theme } from '../../../types';
import type { BuilderState, BuilderAction, BuilderNode } from './builderTypes';
import { GRID_SIZE, NODE_WIDTH, NODE_HEIGHT, PORT_RADIUS, snapToGrid } from './builderTypes';
import { BuilderNodeComponent } from './BuilderNodeComponent';
import { BuilderEdgeComponent } from './BuilderEdgeComponent';
import { generateId } from '../../../utils/ids';

interface BuilderCanvasProps {
	state: BuilderState;
	dispatch: React.Dispatch<BuilderAction>;
	theme: Theme;
	errorNodeIds?: Set<string>;
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

export function BuilderCanvas({
	state,
	dispatch,
	theme,
	errorNodeIds,
}: BuilderCanvasProps): JSX.Element {
	const svgRef = useRef<SVGSVGElement>(null);
	const [spaceHeld, setSpaceHeld] = useState(false);
	const panRef = useRef<{ startX: number; startY: number; vpX: number; vpY: number } | null>(null);

	// Drop indicator state for drag-over preview
	const [dropIndicator, setDropIndicator] = useState<{ x: number; y: number } | null>(null);

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
			setDropIndicator(null);
			const data = e.dataTransfer.getData('application/pipeline-builder-node');
			if (!data || !svgRef.current) return;

			try {
				const parsed = JSON.parse(data);
				const rect = svgRef.current.getBoundingClientRect();
				const { x, y } = clientToCanvas(e.clientX, e.clientY, rect, state.viewport);

				// Center the node on drop point, snap to grid
				const snappedX = snapToGrid(x - NODE_WIDTH / 2);
				const snappedY = snapToGrid(y - NODE_HEIGHT / 2);

				const nodeId = generateId();
				const roleId = parsed.roleId || generateId();

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

	const handleDragOver = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'copy';
			}

			if (!svgRef.current) return;
			const rect = svgRef.current.getBoundingClientRect();
			const { x, y } = clientToCanvas(e.clientX, e.clientY, rect, state.viewport);
			setDropIndicator({
				x: snapToGrid(x - NODE_WIDTH / 2),
				y: snapToGrid(y - NODE_HEIGHT / 2),
			});
		},
		[state.viewport]
	);

	const handleDragLeave = useCallback(() => {
		setDropIndicator(null);
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

			const edgeId = generateId();
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

	// Compute validation info for visual highlighting
	const validationInfo = useMemo(() => {
		const connectedNodes = new Set<string>();
		const inDegree = new Map<string, number>();

		for (const edge of state.edges) {
			connectedNodes.add(edge.sourceNodeId);
			connectedNodes.add(edge.targetNodeId);
			inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1);
		}

		// Orphaned nodes: have no edges at all (only relevant when there are other connected nodes)
		const orphanedNodes = new Set<string>();
		if (state.nodes.length > 1 && state.edges.length > 0) {
			for (const node of state.nodes) {
				if (!connectedNodes.has(node.id)) {
					orphanedNodes.add(node.id);
				}
			}
		}

		// Entry point warnings
		const explicitEntryNodes = state.nodes.filter((n) => n.type === 'entry');
		const warningNodes = new Set<string>();

		// Multiple entry points
		if (explicitEntryNodes.length > 1) {
			for (const n of explicitEntryNodes) warningNodes.add(n.id);
		}

		// No explicit entry but there are connected nodes — warn implicit entry points
		if (explicitEntryNodes.length === 0 && state.edges.length > 0) {
			for (const node of state.nodes) {
				if (!orphanedNodes.has(node.id) && (inDegree.get(node.id) ?? 0) === 0) {
					warningNodes.add(node.id);
				}
			}
		}

		// Back-edges via topological ordering (Kahn's algorithm)
		const topoOrder = new Map<string, number>();
		const adjList = new Map<string, string[]>();
		const inDeg = new Map<string, number>();

		for (const n of state.nodes) {
			adjList.set(n.id, []);
			inDeg.set(n.id, 0);
		}
		for (const e of state.edges) {
			adjList.get(e.sourceNodeId)?.push(e.targetNodeId);
			inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) ?? 0) + 1);
		}

		let order = 0;
		const entryIds = state.nodes.filter((n) => n.type === 'entry').map((n) => n.id);
		const zeroInDeg = state.nodes
			.filter((n) => (inDeg.get(n.id) ?? 0) === 0 && !entryIds.includes(n.id))
			.map((n) => n.id);
		let queue = [...entryIds, ...zeroInDeg];
		const visited = new Set<string>();

		while (queue.length > 0) {
			const nextQueue: string[] = [];
			for (const id of queue) {
				if (visited.has(id)) continue;
				visited.add(id);
				topoOrder.set(id, order++);
				for (const next of adjList.get(id) ?? []) {
					const deg = (inDeg.get(next) ?? 1) - 1;
					inDeg.set(next, deg);
					if (deg <= 0 && !visited.has(next)) nextQueue.push(next);
				}
			}
			queue = nextQueue;
		}
		for (const n of state.nodes) {
			if (!visited.has(n.id)) topoOrder.set(n.id, order++);
		}

		const backEdges = new Set<string>();
		for (const edge of state.edges) {
			const si = topoOrder.get(edge.sourceNodeId) ?? 0;
			const ti = topoOrder.get(edge.targetNodeId) ?? 0;
			if (ti < si) backEdges.add(edge.id);
		}

		return { orphanedNodes, warningNodes, backEdges };
	}, [state.nodes, state.edges]);

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
			onDragLeave={handleDragLeave}
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

					return (
						<BuilderEdgeComponent
							key={edge.id}
							edge={edge}
							sourceNode={source}
							targetNode={target}
							theme={theme}
							selected={edge.id === state.selectedEdgeId}
							isBackEdge={validationInfo.backEdges.has(edge.id)}
							dispatch={dispatch}
						/>
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

				{/* Arrow markers for edge components */}
				<defs>
					{['sequential', 'parallel', 'conditional'].map((et) => (
						<marker
							key={et}
							id={`builder-arrow-${et}`}
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
						isOrphaned={validationInfo.orphanedNodes.has(node.id)}
						hasWarning={
							validationInfo.warningNodes.has(node.id) || (errorNodeIds?.has(node.id) ?? false)
						}
						dispatch={dispatch}
						viewportZoom={vp.zoom}
						onOutputPortMouseDown={handleOutputPortMouseDown}
						onInputPortMouseUp={handleInputPortMouseUp}
					/>
				))}

				{/* Drop indicator — ghost rectangle showing where node will land */}
				{dropIndicator && (
					<rect
						x={dropIndicator.x}
						y={dropIndicator.y}
						width={NODE_WIDTH}
						height={NODE_HEIGHT}
						rx={6}
						fill={theme.colors.accent}
						fillOpacity={0.1}
						stroke={theme.colors.accent}
						strokeWidth={1.5}
						strokeDasharray="6 3"
						style={{ pointerEvents: 'none' }}
					/>
				)}
			</g>
		</svg>
	);
}
