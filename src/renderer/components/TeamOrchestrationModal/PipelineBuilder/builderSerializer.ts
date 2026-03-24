/**
 * Serialization between BuilderState and TeamTemplate.
 *
 * - templateToBuilderState: import existing template into the builder
 * - builderStateToTemplate: export builder state to a saveable TeamTemplate
 * - autoLayoutNodes: simple layered layout via topological sort
 */

import type {
	TeamTemplate,
	TeamTemplateRole,
	WorkflowEdge,
	WorkflowTopology,
} from '../../../../shared/group-chat-types';
import type { BuilderState, BuilderNode, BuilderEdge } from './builderTypes';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
	LAYOUT_VERTICAL_SPACING,
	LAYOUT_HORIZONTAL_SPACING,
	snapToGrid,
} from './builderTypes';

// ============================================================================
// Template → BuilderState
// ============================================================================

/**
 * Convert an existing TeamTemplate into BuilderState for editing.
 * If no position data exists, uses auto-layout.
 */
export function templateToBuilderState(template: TeamTemplate): BuilderState {
	const roles: Record<string, TeamTemplateRole> = {};
	const nodes: BuilderNode[] = [];
	const edges: BuilderEdge[] = [];

	// Create nodes from roles
	for (const role of template.roles) {
		const nodeId = `node-${role.name.replace(/\s+/g, '-').toLowerCase()}`;
		const roleId = nodeId;
		roles[roleId] = { ...role };

		let nodeType: BuilderNode['type'] = 'role';
		if (template.topology) {
			if (template.topology.entryPoint === role.name) nodeType = 'entry';
			else if (template.topology.exitPoint === role.name) nodeType = 'exit';
		}

		nodes.push({
			id: nodeId,
			roleId,
			x: 0,
			y: 0,
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			type: nodeType,
		});
	}

	// Create edges from topology
	if (template.topology) {
		const nodeByRoleName = new Map<string, BuilderNode>();
		for (const node of nodes) {
			const role = roles[node.roleId];
			if (role) nodeByRoleName.set(role.name, node);
		}

		for (const edge of template.topology.edges) {
			const sourceNode = nodeByRoleName.get(edge.source);
			const targetNode = nodeByRoleName.get(edge.target);
			if (!sourceNode || !targetNode) continue;

			edges.push({
				id: `edge-${sourceNode.id}-${targetNode.id}`,
				sourceNodeId: sourceNode.id,
				targetNodeId: targetNode.id,
				edgeType: edge.edgeType,
				condition: edge.condition,
			});
		}
	}

	// Auto-layout since we don't persist position data
	const layoutNodes = autoLayoutNodes(nodes, edges);

	return {
		nodes: layoutNodes,
		edges,
		roles,
		selectedNodeId: null,
		selectedEdgeId: null,
		viewport: { x: 40, y: 40, zoom: 1 },
		templateMeta: {
			name: template.name,
			description: template.description,
			category:
				template.category === 'builtin' ? 'user' : (template.category as 'user' | 'exchange'),
		},
		dirty: false,
	};
}

// ============================================================================
// BuilderState → Template
// ============================================================================

/**
 * Convert builder state back to a TeamTemplate for saving.
 * Auto-detects topology pattern from graph shape.
 */
export function builderStateToTemplate(state: BuilderState, existingId?: string): TeamTemplate {
	const now = Date.now();

	// Build roles array from state
	const templateRoles: TeamTemplateRole[] = state.nodes
		.filter((n) => state.roles[n.roleId])
		.map((n) => ({ ...state.roles[n.roleId] }));

	// Deduplicate roles by name
	const seenNames = new Set<string>();
	const uniqueRoles = templateRoles.filter((r) => {
		if (seenNames.has(r.name)) return false;
		seenNames.add(r.name);
		return true;
	});

	// Build topology if we have edges
	let topology: WorkflowTopology | undefined;
	if (state.edges.length > 0) {
		const entryNode = state.nodes.find((n) => n.type === 'entry');
		const exitNode = state.nodes.find((n) => n.type === 'exit');

		const workflowEdges: WorkflowEdge[] = state.edges.map((e) => {
			const sourceNode = state.nodes.find((n) => n.id === e.sourceNodeId);
			const targetNode = state.nodes.find((n) => n.id === e.targetNodeId);
			return {
				source: sourceNode
					? (state.roles[sourceNode.roleId]?.name ?? sourceNode.roleId)
					: e.sourceNodeId,
				target: targetNode
					? (state.roles[targetNode.roleId]?.name ?? targetNode.roleId)
					: e.targetNodeId,
				edgeType: e.edgeType,
				condition: e.condition,
			};
		});

		const entryPointName = entryNode
			? (state.roles[entryNode.roleId]?.name ?? entryNode.roleId)
			: (uniqueRoles[0]?.name ?? '');
		const exitPointName = exitNode
			? (state.roles[exitNode.roleId]?.name ?? exitNode.roleId)
			: (uniqueRoles[uniqueRoles.length - 1]?.name ?? '');

		const pattern = detectPattern(state.nodes, state.edges);

		topology = {
			pattern,
			edges: workflowEdges,
			entryPoint: entryPointName,
			exitPoint: exitPointName,
		};
	}

	return {
		id: existingId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		name: state.templateMeta.name.trim(),
		description: state.templateMeta.description.trim(),
		category: state.templateMeta.category,
		createdAt: existingId ? now : now, // Existing templates keep original via save handler
		updatedAt: now,
		moderatorAgentId: 'claude-code',
		roles: uniqueRoles,
		topology,
	};
}

/**
 * Auto-detect workflow pattern from graph shape.
 */
export function detectPattern(
	nodes: BuilderNode[],
	edges: BuilderEdge[]
): WorkflowTopology['pattern'] {
	// Check for back-edges (review-loop)
	const nodeOrder = new Map<string, number>();
	nodes.forEach((n, i) => nodeOrder.set(n.id, i));
	const hasBackEdge = edges.some((e) => {
		const si = nodeOrder.get(e.sourceNodeId) ?? 0;
		const ti = nodeOrder.get(e.targetNodeId) ?? 0;
		return ti < si && e.edgeType === 'conditional';
	});
	if (hasBackEdge) return 'review-loop';

	// Check for fan-out (parallel-then-merge)
	const outDegree = new Map<string, number>();
	const inDegree = new Map<string, number>();
	for (const e of edges) {
		outDegree.set(e.sourceNodeId, (outDegree.get(e.sourceNodeId) ?? 0) + 1);
		inDegree.set(e.targetNodeId, (inDegree.get(e.targetNodeId) ?? 0) + 1);
	}
	const hasFanOut = [...outDegree.values()].some((d) => d > 1);
	const hasMerge = [...inDegree.values()].some((d) => d > 1);
	if (hasFanOut && hasMerge) return 'parallel-then-merge';

	// Check for simple pipeline (single path)
	const maxOut = Math.max(0, ...outDegree.values());
	const maxIn = Math.max(0, ...inDegree.values());
	if (maxOut <= 1 && maxIn <= 1 && edges.length > 0) return 'pipeline';

	return 'custom';
}

// ============================================================================
// Auto-layout
// ============================================================================

/**
 * Detect back-edges in the graph using DFS coloring.
 * Returns the set of forward edges (back-edges removed).
 */
function classifyEdges(
	nodes: BuilderNode[],
	edges: BuilderEdge[]
): { forwardEdges: BuilderEdge[]; backEdgeIds: Set<string> } {
	const adjList = new Map<string, Array<{ target: string; edgeId: string }>>();
	for (const n of nodes) adjList.set(n.id, []);
	for (const e of edges) {
		adjList.get(e.sourceNodeId)?.push({ target: e.targetNodeId, edgeId: e.id });
	}

	const WHITE = 0,
		GRAY = 1,
		BLACK = 2;
	const color = new Map<string, number>();
	for (const n of nodes) color.set(n.id, WHITE);

	const backEdgeIds = new Set<string>();

	function dfs(nodeId: string): void {
		color.set(nodeId, GRAY);
		for (const { target, edgeId } of adjList.get(nodeId) ?? []) {
			if (color.get(target) === GRAY) {
				backEdgeIds.add(edgeId);
			} else if (color.get(target) === WHITE) {
				dfs(target);
			}
		}
		color.set(nodeId, BLACK);
	}

	// Start DFS from entry nodes first, then remaining unvisited
	for (const n of nodes) {
		if (n.type === 'entry' && color.get(n.id) === WHITE) dfs(n.id);
	}
	for (const n of nodes) {
		if (color.get(n.id) === WHITE) dfs(n.id);
	}

	return {
		forwardEdges: edges.filter((e) => !backEdgeIds.has(e.id)),
		backEdgeIds,
	};
}

/**
 * Layered layout for pipeline builder nodes.
 *
 * Algorithm:
 * 1. Detect and temporarily remove back-edges (review loops)
 * 2. Topological sort (Kahn's) to assign depth/layer to each node
 * 3. Within each layer, order nodes to minimize edge crossings
 *    (barycenter heuristic: sort by average position of parents in previous layer)
 * 4. Entry node at layer 0, exit node at final layer
 * 5. Assign x/y positions: layers spaced vertically, nodes centered per layer
 */
export function autoLayoutNodes(nodes: BuilderNode[], edges: BuilderEdge[]): BuilderNode[] {
	if (nodes.length === 0) return [];

	const nodeMap = new Map(nodes.map((n) => [n.id, n]));

	// Step 1: Remove back-edges so topological sort can proceed on a DAG
	const { forwardEdges } = classifyEdges(nodes, edges);

	// Step 2: Kahn's algorithm to assign layers
	const adjList = new Map<string, string[]>();
	const inDeg = new Map<string, number>();
	for (const n of nodes) {
		adjList.set(n.id, []);
		inDeg.set(n.id, 0);
	}
	for (const e of forwardEdges) {
		adjList.get(e.sourceNodeId)?.push(e.targetNodeId);
		inDeg.set(e.targetNodeId, (inDeg.get(e.targetNodeId) ?? 0) + 1);
	}

	const layers: string[][] = [];
	const visited = new Set<string>();

	// Prioritize entry nodes, then remaining zero in-degree nodes
	const entryNodeIds = nodes.filter((n) => n.type === 'entry').map((n) => n.id);
	const zeroInDeg = nodes
		.filter((n) => (inDeg.get(n.id) ?? 0) === 0 && !entryNodeIds.includes(n.id))
		.map((n) => n.id);
	let queue = [...entryNodeIds, ...zeroInDeg];

	if (queue.length === 0) queue = [nodes[0].id];

	while (queue.length > 0) {
		const level: string[] = [];
		const nextQueue: string[] = [];

		for (const id of queue) {
			if (visited.has(id)) continue;
			visited.add(id);
			level.push(id);

			for (const next of adjList.get(id) ?? []) {
				const deg = (inDeg.get(next) ?? 1) - 1;
				inDeg.set(next, deg);
				if (deg <= 0 && !visited.has(next)) {
					nextQueue.push(next);
				}
			}
		}

		if (level.length > 0) layers.push(level);
		queue = nextQueue;
	}

	// Handle remaining unvisited nodes (from cycles despite back-edge removal)
	const remaining = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id);
	if (remaining.length > 0) layers.push(remaining);

	// Ensure exit nodes are on the final layer
	const exitNodeIds = new Set(nodes.filter((n) => n.type === 'exit').map((n) => n.id));
	if (exitNodeIds.size > 0 && layers.length > 1) {
		const lastIdx = layers.length - 1;
		for (let i = 0; i < lastIdx; i++) {
			const exitsInLayer = layers[i].filter((id) => exitNodeIds.has(id));
			if (exitsInLayer.length > 0) {
				layers[i] = layers[i].filter((id) => !exitNodeIds.has(id));
				layers[lastIdx].push(...exitsInLayer);
			}
		}
	}

	// Remove empty layers
	const cleanLayers = layers.filter((l) => l.length > 0);

	// Step 3: Order nodes within each layer to minimize edge crossings
	// Barycenter heuristic: sort by average index of connected parents in previous layer
	const reverseAdj = new Map<string, string[]>();
	for (const n of nodes) reverseAdj.set(n.id, []);
	for (const e of forwardEdges) {
		reverseAdj.get(e.targetNodeId)?.push(e.sourceNodeId);
	}

	for (let i = 1; i < cleanLayers.length; i++) {
		const prevPositions = new Map<string, number>();
		cleanLayers[i - 1].forEach((id, idx) => prevPositions.set(id, idx));

		cleanLayers[i].sort((a, b) => {
			const aParents = (reverseAdj.get(a) ?? []).filter((p) => prevPositions.has(p));
			const bParents = (reverseAdj.get(b) ?? []).filter((p) => prevPositions.has(p));

			const avgA =
				aParents.length > 0
					? aParents.reduce((sum, p) => sum + (prevPositions.get(p) ?? 0), 0) / aParents.length
					: Infinity;
			const avgB =
				bParents.length > 0
					? bParents.reduce((sum, p) => sum + (prevPositions.get(p) ?? 0), 0) / bParents.length
					: Infinity;

			return avgA - avgB;
		});
	}

	// Step 4: Assign positions — layers vertical, nodes centered per layer
	const positioned: BuilderNode[] = [];

	for (let layerIdx = 0; layerIdx < cleanLayers.length; layerIdx++) {
		const level = cleanLayers[layerIdx];
		const totalWidth =
			level.length * NODE_WIDTH + (level.length - 1) * (LAYOUT_HORIZONTAL_SPACING - NODE_WIDTH);
		const startX = snapToGrid(-totalWidth / 2 + 400); // Center around x=400

		for (let colIdx = 0; colIdx < level.length; colIdx++) {
			const original = nodeMap.get(level[colIdx]);
			if (!original) continue;
			positioned.push({
				...original,
				x: snapToGrid(startX + colIdx * LAYOUT_HORIZONTAL_SPACING),
				y: snapToGrid(60 + layerIdx * LAYOUT_VERTICAL_SPACING),
			});
		}
	}

	return positioned;
}
