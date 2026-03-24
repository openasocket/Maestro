/**
 * Validation logic for the Pipeline Builder.
 *
 * Checks structural integrity of the builder state: template name, node
 * presence, entry/exit existence, graph connectivity, and duplicate edges.
 */

import type { BuilderState, BuilderEdge } from './builderTypes';

// ============================================================================
// Types
// ============================================================================

export type BuilderErrorType =
	| 'missing-name'
	| 'no-nodes'
	| 'no-entry'
	| 'no-exit'
	| 'orphaned-node'
	| 'disconnected-graph'
	| 'duplicate-edge';

export interface BuilderError {
	type: BuilderErrorType;
	nodeId?: string;
	message: string;
}

export interface BuilderValidationResult {
	valid: boolean;
	errors: BuilderError[];
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate the builder state for structural correctness.
 * Returns a list of errors; if empty the state is valid for saving.
 */
export function validateBuilderState(state: BuilderState): BuilderValidationResult {
	const errors: BuilderError[] = [];

	// 1. Template name is non-empty
	if (!state.templateMeta.name.trim()) {
		errors.push({ type: 'missing-name', message: 'Template name is required' });
	}

	// 2. At least one role node exists
	const roleNodes = state.nodes.filter((n) => n.type === 'role');
	if (roleNodes.length === 0) {
		errors.push({ type: 'no-nodes', message: 'At least one role node is required' });
	}

	// 3. Entry point exists
	const entryNodes = state.nodes.filter((n) => n.type === 'entry');
	if (entryNodes.length === 0 && state.nodes.length > 0) {
		errors.push({ type: 'no-entry', message: 'An entry (Start) node is required' });
	}

	// 4. Exit point exists
	const exitNodes = state.nodes.filter((n) => n.type === 'exit');
	if (exitNodes.length === 0 && state.nodes.length > 0) {
		errors.push({ type: 'no-exit', message: 'An exit (End) node is required' });
	}

	// 5. All role nodes reachable from entry (BFS from entry nodes following edges)
	if (entryNodes.length > 0 && roleNodes.length > 0) {
		const reachableFromEntry = bfsReachable(
			entryNodes.map((n) => n.id),
			state.edges,
			'forward'
		);

		for (const node of roleNodes) {
			if (!reachableFromEntry.has(node.id)) {
				errors.push({
					type: 'disconnected-graph',
					nodeId: node.id,
					message: `"${state.roles[node.roleId]?.name ?? node.roleId}" is not reachable from entry`,
				});
			}
		}
	}

	// 6. Exit is reachable from at least one role node (BFS backward from exit)
	if (exitNodes.length > 0 && roleNodes.length > 0) {
		const reachableToExit = bfsReachable(
			exitNodes.map((n) => n.id),
			state.edges,
			'backward'
		);

		const anyRoleReachesExit = roleNodes.some((n) => reachableToExit.has(n.id));
		if (!anyRoleReachesExit) {
			errors.push({
				type: 'disconnected-graph',
				nodeId: exitNodes[0].id,
				message: 'No role node can reach the exit',
			});
		}
	}

	// 7. Orphaned nodes (connected to nothing when edges exist)
	if (state.edges.length > 0) {
		const connectedNodes = new Set<string>();
		for (const edge of state.edges) {
			connectedNodes.add(edge.sourceNodeId);
			connectedNodes.add(edge.targetNodeId);
		}
		for (const node of state.nodes) {
			if (!connectedNodes.has(node.id)) {
				errors.push({
					type: 'orphaned-node',
					nodeId: node.id,
					message: `"${state.roles[node.roleId]?.name ?? node.type}" has no connections`,
				});
			}
		}
	}

	// 8. No duplicate edges (same source + target)
	const edgeKeys = new Set<string>();
	for (const edge of state.edges) {
		const key = `${edge.sourceNodeId}->${edge.targetNodeId}`;
		if (edgeKeys.has(key)) {
			errors.push({
				type: 'duplicate-edge',
				message: `Duplicate edge from ${sourceLabel(edge.sourceNodeId, state)} to ${sourceLabel(edge.targetNodeId, state)}`,
			});
		}
		edgeKeys.add(key);
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Collect the set of node IDs that have validation errors, for canvas highlighting.
 */
export function getErrorNodeIds(errors: BuilderError[]): Set<string> {
	const ids = new Set<string>();
	for (const err of errors) {
		if (err.nodeId) ids.add(err.nodeId);
	}
	return ids;
}

// ============================================================================
// Helpers
// ============================================================================

/** BFS from a set of start node IDs, following edges forward or backward. */
function bfsReachable(
	startIds: string[],
	edges: BuilderEdge[],
	direction: 'forward' | 'backward'
): Set<string> {
	// Build adjacency list
	const adj = new Map<string, string[]>();
	for (const edge of edges) {
		const from = direction === 'forward' ? edge.sourceNodeId : edge.targetNodeId;
		const to = direction === 'forward' ? edge.targetNodeId : edge.sourceNodeId;
		if (!adj.has(from)) adj.set(from, []);
		adj.get(from)!.push(to);
	}

	const visited = new Set<string>();
	const queue = [...startIds];

	while (queue.length > 0) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		for (const next of adj.get(id) ?? []) {
			if (!visited.has(next)) queue.push(next);
		}
	}

	return visited;
}

/** Get a display label for a node ID (role name or type). */
function sourceLabel(nodeId: string, state: BuilderState): string {
	const node = state.nodes.find((n) => n.id === nodeId);
	if (!node) return nodeId;
	if (node.type === 'entry') return 'Start';
	if (node.type === 'exit') return 'End';
	return state.roles[node.roleId]?.name ?? node.roleId;
}
