/**
 * Tests for builderValidation — validateBuilderState and getErrorNodeIds.
 */

import { describe, it, expect } from 'vitest';
import {
	validateBuilderState,
	getErrorNodeIds,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderValidation';
import { INITIAL_BUILDER_STATE } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderReducer';
import type { BuilderState } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';

// ============================================================================
// Helpers
// ============================================================================

function makeNode(id: string, type: 'entry' | 'exit' | 'role', roleId = `role-${id}`) {
	return { id, roleId, x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, type } as const;
}

function makeEdge(id: string, sourceNodeId: string, targetNodeId: string) {
	return { id, sourceNodeId, targetNodeId, edgeType: 'sequential' as const };
}

function makeRole(name: string) {
	return { name, agentId: 'claude-code', description: '' };
}

/** A minimal valid builder state: entry -> role -> exit, with a name. */
function validState(): BuilderState {
	return {
		...INITIAL_BUILDER_STATE,
		templateMeta: { name: 'Test Template', description: '', category: 'user' },
		nodes: [makeNode('entry', 'entry'), makeNode('worker', 'role'), makeNode('exit', 'exit')],
		edges: [makeEdge('e1', 'entry', 'worker'), makeEdge('e2', 'worker', 'exit')],
		roles: {
			'role-entry': makeRole('Start'),
			'role-worker': makeRole('Worker'),
			'role-exit': makeRole('End'),
		},
	};
}

// ============================================================================
// missing-name
// ============================================================================

describe('validateBuilderState — missing-name', () => {
	it('returns error when template name is empty', () => {
		const state = validState();
		state.templateMeta.name = '';
		const result = validateBuilderState(state);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.type === 'missing-name')).toBe(true);
	});

	it('returns error when template name is only whitespace', () => {
		const state = validState();
		state.templateMeta.name = '   ';
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'missing-name')).toBe(true);
	});

	it('passes when template name is non-empty', () => {
		const state = validState();
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'missing-name')).toBe(false);
	});
});

// ============================================================================
// no-nodes
// ============================================================================

describe('validateBuilderState — no-nodes', () => {
	it('returns error when there are no role nodes', () => {
		const state = validState();
		state.nodes = [makeNode('entry', 'entry'), makeNode('exit', 'exit')];
		state.edges = [makeEdge('e1', 'entry', 'exit')];
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'no-nodes')).toBe(true);
	});

	it('passes when role nodes exist', () => {
		const state = validState();
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'no-nodes')).toBe(false);
	});
});

// ============================================================================
// no-entry / no-exit
// ============================================================================

describe('validateBuilderState — no-entry / no-exit', () => {
	it('returns no-entry error when no entry node exists', () => {
		const state = validState();
		state.nodes = state.nodes.filter((n) => n.type !== 'entry');
		state.edges = state.edges.filter((e) => e.sourceNodeId !== 'entry');
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'no-entry')).toBe(true);
	});

	it('returns no-exit error when no exit node exists', () => {
		const state = validState();
		state.nodes = state.nodes.filter((n) => n.type !== 'exit');
		state.edges = state.edges.filter((e) => e.targetNodeId !== 'exit');
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'no-exit')).toBe(true);
	});

	it('does not report entry/exit errors when there are no nodes at all', () => {
		const state: BuilderState = {
			...INITIAL_BUILDER_STATE,
			templateMeta: { name: 'Empty', description: '', category: 'user' },
			nodes: [],
			edges: [],
			roles: {},
		};
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'no-entry')).toBe(false);
		expect(result.errors.some((e) => e.type === 'no-exit')).toBe(false);
	});
});

// ============================================================================
// disconnected-graph
// ============================================================================

describe('validateBuilderState — disconnected-graph', () => {
	it('returns error for role nodes unreachable from entry', () => {
		const state = validState();
		// Add an isolated role node
		state.nodes.push(makeNode('isolated', 'role'));
		state.roles['role-isolated'] = makeRole('Isolated');
		const result = validateBuilderState(state);
		const disconnected = result.errors.filter((e) => e.type === 'disconnected-graph');
		expect(disconnected.length).toBeGreaterThanOrEqual(1);
		expect(disconnected.some((e) => e.nodeId === 'isolated')).toBe(true);
	});

	it('returns error when exit is unreachable from any role node', () => {
		const state = validState();
		// Remove edge from worker to exit
		state.edges = state.edges.filter((e) => e.targetNodeId !== 'exit');
		const result = validateBuilderState(state);
		const disconnected = result.errors.filter((e) => e.type === 'disconnected-graph');
		expect(disconnected.some((e) => e.message.includes('exit'))).toBe(true);
	});

	it('passes when all roles are reachable and exit is connected', () => {
		const state = validState();
		const result = validateBuilderState(state);
		expect(result.errors.filter((e) => e.type === 'disconnected-graph')).toHaveLength(0);
	});
});

// ============================================================================
// orphaned-node
// ============================================================================

describe('validateBuilderState — orphaned-node', () => {
	it('returns error for nodes with no connections when edges exist', () => {
		const state = validState();
		state.nodes.push(makeNode('orphan', 'role'));
		state.roles['role-orphan'] = makeRole('Orphan');
		const result = validateBuilderState(state);
		const orphaned = result.errors.filter((e) => e.type === 'orphaned-node');
		expect(orphaned.some((e) => e.nodeId === 'orphan')).toBe(true);
	});

	it('does not flag orphans when there are no edges', () => {
		const state: BuilderState = {
			...INITIAL_BUILDER_STATE,
			templateMeta: { name: 'No Edges', description: '', category: 'user' },
			nodes: [makeNode('a', 'entry'), makeNode('b', 'role')],
			edges: [],
			roles: { 'role-a': makeRole('Start'), 'role-b': makeRole('Worker') },
		};
		const result = validateBuilderState(state);
		expect(result.errors.filter((e) => e.type === 'orphaned-node')).toHaveLength(0);
	});
});

// ============================================================================
// duplicate-edge
// ============================================================================

describe('validateBuilderState — duplicate-edge', () => {
	it('returns error for duplicate edges (same source and target)', () => {
		const state = validState();
		state.edges.push(makeEdge('dup', 'entry', 'worker'));
		const result = validateBuilderState(state);
		expect(result.errors.some((e) => e.type === 'duplicate-edge')).toBe(true);
	});

	it('does not flag reverse-direction edges as duplicates', () => {
		const state = validState();
		// Add a back-edge (worker -> entry), not a duplicate
		state.edges.push(makeEdge('back', 'worker', 'entry'));
		const result = validateBuilderState(state);
		expect(result.errors.filter((e) => e.type === 'duplicate-edge')).toHaveLength(0);
	});
});

// ============================================================================
// valid state
// ============================================================================

describe('validateBuilderState — valid state', () => {
	it('returns valid: true with no errors for a well-formed template', () => {
		const state = validState();
		const result = validateBuilderState(state);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ============================================================================
// getErrorNodeIds
// ============================================================================

describe('getErrorNodeIds', () => {
	it('collects unique node IDs from errors', () => {
		const ids = getErrorNodeIds([
			{ type: 'orphaned-node', nodeId: 'n1', message: '' },
			{ type: 'disconnected-graph', nodeId: 'n2', message: '' },
			{ type: 'missing-name', message: '' },
			{ type: 'orphaned-node', nodeId: 'n1', message: '' },
		]);
		expect(ids.size).toBe(2);
		expect(ids.has('n1')).toBe(true);
		expect(ids.has('n2')).toBe(true);
	});

	it('returns empty set when no nodeIds present', () => {
		const ids = getErrorNodeIds([
			{ type: 'missing-name', message: '' },
			{ type: 'no-nodes', message: '' },
		]);
		expect(ids.size).toBe(0);
	});
});
