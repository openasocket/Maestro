/**
 * WorkflowGraph - Lightweight CSS-based workflow visualization.
 *
 * Renders a visual graph of the agent workflow topology with real-time
 * execution status indicators. Uses CSS flexbox/grid layout — no external
 * graph libraries (d3, reactflow, etc.).
 *
 * Layout is pattern-aware:
 * - pipeline: vertical top-to-bottom stack
 * - parallel-then-merge: entry → horizontal row → merger
 * - review-loop: vertical with loop-back indicator
 * - hub-spoke: center moderator with surrounding agents
 * - custom: topological sort, top-to-bottom
 */

import { useMemo } from 'react';
import { Bot, ArrowDown, ArrowRight, CornerDownLeft } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	WorkflowTopology,
	WorkflowExecutionState,
	GroupChatParticipant,
} from '../../../shared/group-chat-types';

// ============================================================================
// Types
// ============================================================================

export interface WorkflowGraphProps {
	topology: WorkflowTopology;
	executionState?: WorkflowExecutionState;
	participants: GroupChatParticipant[];
	theme: Theme;
	compact?: boolean;
}

type NodeStatus = 'pending' | 'active' | 'completed' | 'failed';

interface LayoutNode {
	role: string;
	row: number;
	col: number;
	status: NodeStatus;
	isEntry: boolean;
	isExit: boolean;
}

interface LayoutEdge {
	from: string;
	to: string;
	condition?: string;
	isActive: boolean;
	isCompleted: boolean;
	isLoopBack: boolean;
}

interface GraphLayout {
	nodes: LayoutNode[];
	edges: LayoutEdge[];
	rows: number;
	cols: number;
}

// ============================================================================
// Status helpers
// ============================================================================

function getNodeStatus(role: string, executionState?: WorkflowExecutionState): NodeStatus {
	if (!executionState) return 'pending';
	if (executionState.activeNodes.includes(role)) return 'active';
	if (executionState.completedNodes.includes(role)) return 'completed';
	if (executionState.status === 'failed' && executionState.currentPhase === role) return 'failed';
	return 'pending';
}

function statusColor(status: NodeStatus, theme: Theme): string {
	switch (status) {
		case 'active':
			return theme.colors.warning;
		case 'completed':
			return theme.colors.success;
		case 'failed':
			return theme.colors.error;
		default:
			return theme.colors.textDim;
	}
}

// ============================================================================
// Layout algorithms
// ============================================================================

function layoutPipeline(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	// Walk edges from entry to exit in order
	const ordered: string[] = [];
	const visited = new Set<string>();
	let current = topology.entryPoint;

	while (current && !visited.has(current)) {
		visited.add(current);
		ordered.push(current);
		const next = topology.edges.find((e) => e.source === current && e.target !== '__exit__');
		current = next ? next.target : '';
	}

	// Add any unvisited roles
	const allRoles = new Set<string>();
	for (const e of topology.edges) {
		if (e.source !== '__entry__' && e.source !== '__exit__') allRoles.add(e.source);
		if (e.target !== '__entry__' && e.target !== '__exit__') allRoles.add(e.target);
	}
	for (const role of allRoles) {
		if (!visited.has(role)) ordered.push(role);
	}

	const nodes: LayoutNode[] = ordered.map((role, i) => ({
		role,
		row: i,
		col: 0,
		status: getNodeStatus(role, executionState),
		isEntry: role === topology.entryPoint,
		isExit: role === topology.exitPoint,
	}));

	const edges: LayoutEdge[] = [];
	for (let i = 0; i < ordered.length - 1; i++) {
		const edge = topology.edges.find((e) => e.source === ordered[i] && e.target === ordered[i + 1]);
		edges.push({
			from: ordered[i],
			to: ordered[i + 1],
			condition: edge?.condition,
			isActive:
				getNodeStatus(ordered[i], executionState) === 'completed' &&
				getNodeStatus(ordered[i + 1], executionState) === 'active',
			isCompleted:
				getNodeStatus(ordered[i], executionState) === 'completed' &&
				getNodeStatus(ordered[i + 1], executionState) === 'completed',
			isLoopBack: false,
		});
	}

	return { nodes, edges, rows: ordered.length, cols: 1 };
}

function layoutParallelMerge(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	// Entry at top, parallel nodes in a row, merger at bottom
	const parallelNodes = topology.edges
		.filter((e) => e.source === topology.entryPoint && e.edgeType === 'parallel')
		.map((e) => e.target)
		.filter((t) => t !== '__exit__');

	// Find merger: node that receives from parallel nodes but isn't one of them
	const parallelSet = new Set(parallelNodes);
	let merger = topology.exitPoint;
	for (const edge of topology.edges) {
		if (
			parallelSet.has(edge.source) &&
			!parallelSet.has(edge.target) &&
			edge.target !== '__exit__'
		) {
			merger = edge.target;
			break;
		}
	}

	const cols = Math.max(parallelNodes.length, 1);
	const nodes: LayoutNode[] = [];

	// Row 0: entry
	nodes.push({
		role: topology.entryPoint,
		row: 0,
		col: Math.floor(cols / 2),
		status: getNodeStatus(topology.entryPoint, executionState),
		isEntry: true,
		isExit: topology.entryPoint === topology.exitPoint,
	});

	// Row 1: parallel nodes
	parallelNodes.forEach((role, i) => {
		nodes.push({
			role,
			row: 1,
			col: i,
			status: getNodeStatus(role, executionState),
			isEntry: false,
			isExit: role === topology.exitPoint,
		});
	});

	// Row 2: merger (if different from entry)
	if (merger !== topology.entryPoint) {
		nodes.push({
			role: merger,
			row: 2,
			col: Math.floor(cols / 2),
			status: getNodeStatus(merger, executionState),
			isEntry: false,
			isExit: merger === topology.exitPoint,
		});
	}

	// Edges: entry → each parallel node
	const edges: LayoutEdge[] = parallelNodes.map((p) => ({
		from: topology.entryPoint,
		to: p,
		isActive:
			getNodeStatus(topology.entryPoint, executionState) === 'completed' &&
			getNodeStatus(p, executionState) === 'active',
		isCompleted:
			getNodeStatus(topology.entryPoint, executionState) === 'completed' &&
			getNodeStatus(p, executionState) === 'completed',
		isLoopBack: false,
	}));

	// Edges: each parallel node → merger
	if (merger !== topology.entryPoint) {
		for (const p of parallelNodes) {
			edges.push({
				from: p,
				to: merger,
				isActive:
					getNodeStatus(p, executionState) === 'completed' &&
					getNodeStatus(merger, executionState) === 'active',
				isCompleted:
					getNodeStatus(p, executionState) === 'completed' &&
					getNodeStatus(merger, executionState) === 'completed',
				isLoopBack: false,
			});
		}
	}

	return { nodes, edges, rows: merger !== topology.entryPoint ? 3 : 2, cols };
}

function layoutReviewLoop(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	// Vertical stack with a loop-back arrow from reviewer → implementer
	const ordered: string[] = [];
	const visited = new Set<string>();
	let current = topology.entryPoint;

	while (current && !visited.has(current)) {
		visited.add(current);
		ordered.push(current);
		// Follow sequential/conditional edges forward
		const next = topology.edges.find(
			(e) =>
				e.source === current &&
				e.target !== '__exit__' &&
				!visited.has(e.target) &&
				e.edgeType !== 'conditional'
		);
		if (next) {
			current = next.target;
		} else {
			// Try conditional edges
			const cond = topology.edges.find(
				(e) => e.source === current && e.target !== '__exit__' && !visited.has(e.target)
			);
			current = cond ? cond.target : '';
		}
	}

	// Add unvisited roles
	const allRoles = new Set<string>();
	for (const e of topology.edges) {
		if (e.source !== '__entry__' && e.source !== '__exit__') allRoles.add(e.source);
		if (e.target !== '__entry__' && e.target !== '__exit__') allRoles.add(e.target);
	}
	for (const role of allRoles) {
		if (!visited.has(role)) ordered.push(role);
	}

	const nodes: LayoutNode[] = ordered.map((role, i) => ({
		role,
		row: i,
		col: 0,
		status: getNodeStatus(role, executionState),
		isEntry: role === topology.entryPoint,
		isExit: role === topology.exitPoint,
	}));

	const edges: LayoutEdge[] = [];
	// Forward edges
	for (let i = 0; i < ordered.length - 1; i++) {
		const edge = topology.edges.find((e) => e.source === ordered[i] && e.target === ordered[i + 1]);
		edges.push({
			from: ordered[i],
			to: ordered[i + 1],
			condition: edge?.condition,
			isActive:
				getNodeStatus(ordered[i], executionState) === 'completed' &&
				getNodeStatus(ordered[i + 1], executionState) === 'active',
			isCompleted:
				getNodeStatus(ordered[i], executionState) === 'completed' &&
				getNodeStatus(ordered[i + 1], executionState) === 'completed',
			isLoopBack: false,
		});
	}

	// Loop-back edges (conditional edges that point to an earlier node)
	const orderIndex = new Map(ordered.map((r, i) => [r, i]));
	for (const edge of topology.edges) {
		if (
			edge.source !== '__entry__' &&
			edge.target !== '__exit__' &&
			edge.edgeType === 'conditional' &&
			orderIndex.has(edge.source) &&
			orderIndex.has(edge.target) &&
			orderIndex.get(edge.target)! < orderIndex.get(edge.source)!
		) {
			edges.push({
				from: edge.source,
				to: edge.target,
				condition: edge.condition,
				isActive: getNodeStatus(edge.source, executionState) === 'active',
				isCompleted: false,
				isLoopBack: true,
			});
		}
	}

	return { nodes, edges, rows: ordered.length, cols: 1 };
}

function layoutHubSpoke(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	// Moderator in center (row 0), agents in a row below (row 1)
	const allRoles = new Set<string>();
	for (const e of topology.edges) {
		if (e.source !== '__entry__' && e.source !== '__exit__') allRoles.add(e.source);
		if (e.target !== '__entry__' && e.target !== '__exit__') allRoles.add(e.target);
	}

	const hub = topology.entryPoint;
	const spokes = [...allRoles].filter((r) => r !== hub);
	const cols = Math.max(spokes.length, 1);

	const nodes: LayoutNode[] = [];
	nodes.push({
		role: hub,
		row: 0,
		col: Math.floor(cols / 2),
		status: getNodeStatus(hub, executionState),
		isEntry: true,
		isExit: hub === topology.exitPoint,
	});

	spokes.forEach((role, i) => {
		nodes.push({
			role,
			row: 1,
			col: i,
			status: getNodeStatus(role, executionState),
			isEntry: false,
			isExit: role === topology.exitPoint,
		});
	});

	const edges: LayoutEdge[] = spokes.map((s) => ({
		from: hub,
		to: s,
		isActive: getNodeStatus(s, executionState) === 'active',
		isCompleted: getNodeStatus(s, executionState) === 'completed',
		isLoopBack: false,
	}));

	return { nodes, edges, rows: 2, cols };
}

function layoutCustom(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	// Simple topological sort, top to bottom
	const allRoles = new Set<string>();
	for (const e of topology.edges) {
		if (e.source !== '__entry__' && e.source !== '__exit__') allRoles.add(e.source);
		if (e.target !== '__entry__' && e.target !== '__exit__') allRoles.add(e.target);
	}

	// Build in-degree map for topological sort
	const inDegree = new Map<string, number>();
	const adjList = new Map<string, string[]>();
	for (const role of allRoles) {
		inDegree.set(role, 0);
		adjList.set(role, []);
	}
	for (const edge of topology.edges) {
		if (allRoles.has(edge.source) && allRoles.has(edge.target)) {
			adjList.get(edge.source)!.push(edge.target);
			inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
		}
	}

	// Kahn's algorithm — group by level for parallel placement
	const levels: string[][] = [];
	const queue = [...allRoles].filter((r) => (inDegree.get(r) || 0) === 0);
	const visited = new Set<string>();

	// Ensure entry point is first
	if (!queue.includes(topology.entryPoint) && allRoles.has(topology.entryPoint)) {
		queue.unshift(topology.entryPoint);
	}

	while (queue.length > 0) {
		const levelNodes = [...queue];
		queue.length = 0;
		const level: string[] = [];

		for (const node of levelNodes) {
			if (visited.has(node)) continue;
			visited.add(node);
			level.push(node);
			for (const next of adjList.get(node) || []) {
				const deg = (inDegree.get(next) || 1) - 1;
				inDegree.set(next, deg);
				if (deg <= 0 && !visited.has(next)) {
					queue.push(next);
				}
			}
		}
		if (level.length > 0) levels.push(level);
	}

	// Add any remaining unvisited nodes (cycles)
	const remaining = [...allRoles].filter((r) => !visited.has(r));
	if (remaining.length > 0) levels.push(remaining);

	const maxCols = Math.max(...levels.map((l) => l.length), 1);
	const nodes: LayoutNode[] = [];

	for (let row = 0; row < levels.length; row++) {
		const level = levels[row];
		for (let col = 0; col < level.length; col++) {
			nodes.push({
				role: level[col],
				row,
				col,
				status: getNodeStatus(level[col], executionState),
				isEntry: level[col] === topology.entryPoint,
				isExit: level[col] === topology.exitPoint,
			});
		}
	}

	const edges: LayoutEdge[] = [];
	for (const edge of topology.edges) {
		if (allRoles.has(edge.source) && allRoles.has(edge.target)) {
			edges.push({
				from: edge.source,
				to: edge.target,
				condition: edge.condition,
				isActive:
					getNodeStatus(edge.source, executionState) === 'completed' &&
					getNodeStatus(edge.target, executionState) === 'active',
				isCompleted:
					getNodeStatus(edge.source, executionState) === 'completed' &&
					getNodeStatus(edge.target, executionState) === 'completed',
				isLoopBack: false,
			});
		}
	}

	return { nodes, edges, rows: levels.length, cols: maxCols };
}

function computeLayout(
	topology: WorkflowTopology,
	executionState?: WorkflowExecutionState
): GraphLayout {
	switch (topology.pattern) {
		case 'pipeline':
			return layoutPipeline(topology, executionState);
		case 'parallel-then-merge':
			return layoutParallelMerge(topology, executionState);
		case 'review-loop':
			return layoutReviewLoop(topology, executionState);
		case 'hub-spoke':
			return layoutHubSpoke(topology, executionState);
		case 'custom':
		default:
			return layoutCustom(topology, executionState);
	}
}

// ============================================================================
// Sub-components
// ============================================================================

function WorkflowNode({
	node,
	theme,
	compact,
	participantColor,
}: {
	node: LayoutNode;
	theme: Theme;
	compact: boolean;
	participantColor?: string;
}): JSX.Element {
	const color = statusColor(node.status, theme);
	const isPulsing = node.status === 'active';

	if (compact) {
		return (
			<div
				className="flex items-center justify-center"
				style={{ width: 12, height: 12 }}
				title={node.role}
			>
				<div
					style={{
						width: 8,
						height: 8,
						borderRadius: '50%',
						backgroundColor: color,
						animation: isPulsing ? 'wfg-pulse 1.5s ease-in-out infinite' : undefined,
					}}
				/>
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center gap-0.5">
			{node.isEntry && (
				<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
					Start
				</span>
			)}
			<div
				className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border"
				style={{
					borderColor: color,
					backgroundColor: `${color}15`,
					borderWidth: node.status === 'active' ? 2 : 1,
					animation: isPulsing ? 'wfg-pulse 1.5s ease-in-out infinite' : undefined,
					minWidth: 90,
					justifyContent: 'center',
				}}
			>
				<div
					style={{
						width: 6,
						height: 6,
						borderRadius: '50%',
						backgroundColor: color,
						flexShrink: 0,
					}}
				/>
				<Bot
					className="w-3 h-3 flex-shrink-0"
					style={{ color: participantColor || theme.colors.textDim }}
				/>
				<span
					className="text-xs font-semibold truncate"
					style={{ color: theme.colors.textMain, maxWidth: 100 }}
				>
					{node.role}
				</span>
			</div>
			{node.isExit && (
				<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
					End
				</span>
			)}
		</div>
	);
}

function EdgeArrow({
	edge,
	theme,
	compact,
	vertical,
}: {
	edge: LayoutEdge;
	theme: Theme;
	compact: boolean;
	vertical: boolean;
}): JSX.Element {
	const edgeColor = edge.isActive
		? theme.colors.accent
		: edge.isCompleted
			? theme.colors.success
			: theme.colors.border;

	if (compact) {
		return vertical ? (
			<ArrowDown className="w-2.5 h-2.5" style={{ color: edgeColor }} />
		) : (
			<ArrowRight className="w-2.5 h-2.5" style={{ color: edgeColor }} />
		);
	}

	if (edge.isLoopBack) {
		return (
			<div className="flex items-center gap-1" style={{ color: edgeColor }}>
				<CornerDownLeft className="w-3.5 h-3.5" />
				{edge.condition && (
					<span
						className="text-[9px] italic max-w-[80px] truncate"
						style={{ color: theme.colors.textDim }}
					>
						{edge.condition}
					</span>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center gap-0.5">
			{vertical ? (
				<ArrowDown className="w-3.5 h-3.5" style={{ color: edgeColor }} />
			) : (
				<ArrowRight className="w-3.5 h-3.5" style={{ color: edgeColor }} />
			)}
			{edge.condition && (
				<span
					className="text-[9px] italic max-w-[80px] truncate"
					style={{ color: theme.colors.textDim }}
					title={edge.condition}
				>
					{edge.condition}
				</span>
			)}
		</div>
	);
}

// ============================================================================
// Main component
// ============================================================================

export function WorkflowGraph({
	topology,
	executionState,
	participants,
	theme,
	compact = false,
}: WorkflowGraphProps): JSX.Element {
	const layout = useMemo(() => computeLayout(topology, executionState), [topology, executionState]);

	const colorMap = useMemo(() => {
		const map: Record<string, string> = {};
		for (const p of participants) {
			map[p.name] = p.color || theme.colors.accent;
		}
		return map;
	}, [participants, theme.colors.accent]);

	// Group nodes by row for rendering
	const rowGroups = useMemo(() => {
		const groups: Map<number, LayoutNode[]> = new Map();
		for (const node of layout.nodes) {
			if (!groups.has(node.row)) groups.set(node.row, []);
			groups.get(node.row)!.push(node);
		}
		// Sort columns within each row
		for (const nodes of groups.values()) {
			nodes.sort((a, b) => a.col - b.col);
		}
		return [...groups.entries()].sort(([a], [b]) => a - b);
	}, [layout.nodes]);

	// For edge rendering, build a set of edges between consecutive rows
	const forwardEdges = useMemo(() => layout.edges.filter((e) => !e.isLoopBack), [layout.edges]);
	const loopBackEdges = useMemo(() => layout.edges.filter((e) => e.isLoopBack), [layout.edges]);

	if (compact) {
		// Compact: inline minimap with dots and arrows
		return (
			<div className="flex items-center gap-0.5">
				{layout.nodes.slice(0, 4).map((node, i) => (
					<div key={node.role} className="flex items-center gap-0.5">
						{i > 0 && <ArrowRight className="w-2 h-2" style={{ color: theme.colors.border }} />}
						<div
							style={{
								width: 6,
								height: 6,
								borderRadius: '50%',
								backgroundColor: statusColor(node.status, theme),
							}}
							title={node.role}
						/>
					</div>
				))}
				{layout.nodes.length > 4 && (
					<span className="text-[8px]" style={{ color: theme.colors.textDim }}>
						+{layout.nodes.length - 4}
					</span>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center gap-1 w-full">
			{/* Inject keyframe animation */}
			<style>{`
				@keyframes wfg-pulse {
					0%, 100% { opacity: 1; }
					50% { opacity: 0.5; }
				}
			`}</style>

			{rowGroups.map(([rowIdx, nodes], groupIdx) => (
				<div key={rowIdx}>
					{/* Edge arrows between rows */}
					{groupIdx > 0 && (
						<div className="flex justify-center gap-4 py-0.5">
							{(() => {
								const prevRow = rowGroups[groupIdx - 1][1];
								// Find edges from previous row to this row
								const rowEdges = forwardEdges.filter(
									(e) =>
										prevRow.some((n) => n.role === e.from) && nodes.some((n) => n.role === e.to)
								);
								if (rowEdges.length === 0) {
									// Default arrow between rows
									return (
										<EdgeArrow
											edge={{
												from: '',
												to: '',
												isActive: false,
												isCompleted: false,
												isLoopBack: false,
											}}
											theme={theme}
											compact={false}
											vertical={true}
										/>
									);
								}
								return rowEdges.map((e) => (
									<EdgeArrow
										key={`${e.from}-${e.to}`}
										edge={e}
										theme={theme}
										compact={false}
										vertical={true}
									/>
								));
							})()}
						</div>
					)}

					{/* Node row */}
					<div className="flex items-start justify-center gap-3">
						{nodes.map((node) => (
							<WorkflowNode
								key={node.role}
								node={node}
								theme={theme}
								compact={false}
								participantColor={colorMap[node.role]}
							/>
						))}
					</div>
				</div>
			))}

			{/* Loop-back indicators */}
			{loopBackEdges.length > 0 && (
				<div
					className="flex items-center gap-2 mt-1 px-2 py-1 rounded"
					style={{ backgroundColor: `${theme.colors.warning}10` }}
				>
					<CornerDownLeft className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />
					{loopBackEdges.map((e) => (
						<span
							key={`${e.from}-${e.to}`}
							className="text-[10px]"
							style={{ color: theme.colors.textDim }}
						>
							{e.from} → {e.to}
							{e.condition && ` (${e.condition})`}
						</span>
					))}
				</div>
			)}
		</div>
	);
}
