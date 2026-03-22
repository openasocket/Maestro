/**
 * Tests for builderSerializer — conversion between BuilderState and TeamTemplate.
 */

import { describe, it, expect } from 'vitest';
import {
	templateToBuilderState,
	builderStateToTemplate,
	autoLayoutNodes,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderSerializer';
import type { TeamTemplate, TeamTemplateRole } from '../../../../shared/group-chat-types';
import type {
	BuilderNode,
	BuilderEdge,
	BuilderState,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
	GRID_SIZE,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';

// ============================================================================
// Helpers
// ============================================================================

function makeRole(name: string, agentId = 'claude-code'): TeamTemplateRole {
	return { name, agentId, description: `${name} role` };
}

function makeTemplate(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
	return {
		id: 'test-template-1',
		name: 'Test Template',
		description: 'A test template',
		category: 'user',
		createdAt: 1000,
		updatedAt: 2000,
		moderatorAgentId: 'claude-code',
		roles: [makeRole('Frontend'), makeRole('Backend'), makeRole('Reviewer')],
		...overrides,
	};
}

function makeBuilderNode(
	id: string,
	type: BuilderNode['type'] = 'role',
	x = 0,
	y = 0
): BuilderNode {
	return { id, roleId: id, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, type };
}

function makeBuilderEdge(
	sourceNodeId: string,
	targetNodeId: string,
	edgeType: BuilderEdge['edgeType'] = 'sequential'
): BuilderEdge {
	return {
		id: `edge-${sourceNodeId}-${targetNodeId}`,
		sourceNodeId,
		targetNodeId,
		edgeType,
	};
}

// ============================================================================
// templateToBuilderState
// ============================================================================

describe('templateToBuilderState', () => {
	it('should create a node for each role', () => {
		const template = makeTemplate();
		const state = templateToBuilderState(template);

		expect(state.nodes).toHaveLength(3);
		// Each node should reference a role
		for (const node of state.nodes) {
			expect(state.roles[node.roleId]).toBeDefined();
		}
	});

	it('should preserve role data', () => {
		const template = makeTemplate();
		const state = templateToBuilderState(template);

		const roleNames = Object.values(state.roles).map((r) => r.name);
		expect(roleNames).toContain('Frontend');
		expect(roleNames).toContain('Backend');
		expect(roleNames).toContain('Reviewer');
	});

	it('should preserve template meta', () => {
		const template = makeTemplate({ name: 'My Team', description: 'Does stuff', category: 'user' });
		const state = templateToBuilderState(template);

		expect(state.templateMeta.name).toBe('My Team');
		expect(state.templateMeta.description).toBe('Does stuff');
		expect(state.templateMeta.category).toBe('user');
	});

	it('should map builtin category to user', () => {
		const template = makeTemplate({ category: 'builtin' });
		const state = templateToBuilderState(template);

		expect(state.templateMeta.category).toBe('user');
	});

	it('should mark entry and exit nodes from topology', () => {
		const template = makeTemplate({
			topology: {
				pattern: 'pipeline',
				edges: [
					{ source: 'Frontend', target: 'Backend', edgeType: 'sequential' },
					{ source: 'Backend', target: 'Reviewer', edgeType: 'sequential' },
				],
				entryPoint: 'Frontend',
				exitPoint: 'Reviewer',
			},
		});
		const state = templateToBuilderState(template);

		const entryNode = state.nodes.find((n) => n.type === 'entry');
		const exitNode = state.nodes.find((n) => n.type === 'exit');
		expect(entryNode).toBeDefined();
		expect(exitNode).toBeDefined();
		expect(state.roles[entryNode!.roleId].name).toBe('Frontend');
		expect(state.roles[exitNode!.roleId].name).toBe('Reviewer');
	});

	it('should create edges from topology', () => {
		const template = makeTemplate({
			topology: {
				pattern: 'pipeline',
				edges: [
					{ source: 'Frontend', target: 'Backend', edgeType: 'sequential' },
					{ source: 'Backend', target: 'Reviewer', edgeType: 'parallel' },
				],
				entryPoint: 'Frontend',
				exitPoint: 'Reviewer',
			},
		});
		const state = templateToBuilderState(template);

		expect(state.edges).toHaveLength(2);
		expect(state.edges[0].edgeType).toBe('sequential');
		expect(state.edges[1].edgeType).toBe('parallel');
	});

	it('should preserve edge conditions', () => {
		const template = makeTemplate({
			topology: {
				pattern: 'review-loop',
				edges: [
					{ source: 'Frontend', target: 'Reviewer', edgeType: 'sequential' },
					{
						source: 'Reviewer',
						target: 'Frontend',
						edgeType: 'conditional',
						condition: 'needs revision',
					},
				],
				entryPoint: 'Frontend',
				exitPoint: 'Reviewer',
			},
		});
		const state = templateToBuilderState(template);

		const conditionalEdge = state.edges.find((e) => e.edgeType === 'conditional');
		expect(conditionalEdge).toBeDefined();
		expect(conditionalEdge!.condition).toBe('needs revision');
	});

	it('should initialize with clean state (not dirty, no selection)', () => {
		const state = templateToBuilderState(makeTemplate());

		expect(state.dirty).toBe(false);
		expect(state.selectedNodeId).toBeNull();
		expect(state.selectedEdgeId).toBeNull();
	});

	it('should handle template with no topology', () => {
		const template = makeTemplate({ topology: undefined });
		const state = templateToBuilderState(template);

		expect(state.edges).toHaveLength(0);
		// All nodes should be 'role' type (no entry/exit without topology)
		for (const node of state.nodes) {
			expect(node.type).toBe('role');
		}
	});

	it('should skip edges referencing nonexistent roles', () => {
		const template = makeTemplate({
			topology: {
				pattern: 'pipeline',
				edges: [
					{ source: 'Frontend', target: 'NonExistent', edgeType: 'sequential' },
					{ source: 'Frontend', target: 'Backend', edgeType: 'sequential' },
				],
				entryPoint: 'Frontend',
				exitPoint: 'Backend',
			},
		});
		const state = templateToBuilderState(template);

		// Only the valid edge should be created
		expect(state.edges).toHaveLength(1);
	});

	it('should handle empty roles array', () => {
		const template = makeTemplate({ roles: [] });
		const state = templateToBuilderState(template);

		expect(state.nodes).toHaveLength(0);
		expect(state.edges).toHaveLength(0);
	});
});

// ============================================================================
// builderStateToTemplate
// ============================================================================

describe('builderStateToTemplate', () => {
	function makeState(overrides: Partial<BuilderState> = {}): BuilderState {
		const roleA: TeamTemplateRole = { name: 'Coder', agentId: 'claude-code', description: 'codes' };
		const roleB: TeamTemplateRole = {
			name: 'Tester',
			agentId: 'claude-code',
			description: 'tests',
		};
		return {
			nodes: [makeBuilderNode('n1', 'entry'), makeBuilderNode('n2', 'exit', 0, 200)],
			edges: [makeBuilderEdge('n1', 'n2')],
			roles: { n1: roleA, n2: roleB },
			selectedNodeId: null,
			selectedEdgeId: null,
			viewport: { x: 0, y: 0, zoom: 1 },
			templateMeta: { name: 'Built', description: 'desc', category: 'user' },
			dirty: true,
			...overrides,
		};
	}

	it('should produce a valid TeamTemplate', () => {
		const state = makeState();
		const template = builderStateToTemplate(state);

		expect(template.name).toBe('Built');
		expect(template.description).toBe('desc');
		expect(template.category).toBe('user');
		expect(template.roles).toHaveLength(2);
		expect(template.moderatorAgentId).toBe('claude-code');
	});

	it('should use existing id when provided', () => {
		const template = builderStateToTemplate(makeState(), 'keep-this-id');
		expect(template.id).toBe('keep-this-id');
	});

	it('should generate a new id when none provided', () => {
		const template = builderStateToTemplate(makeState());
		expect(template.id).toMatch(/^user-/);
	});

	it('should map edges to WorkflowEdge using role names', () => {
		const state = makeState();
		const template = builderStateToTemplate(state);

		expect(template.topology).toBeDefined();
		expect(template.topology!.edges).toHaveLength(1);
		expect(template.topology!.edges[0].source).toBe('Coder');
		expect(template.topology!.edges[0].target).toBe('Tester');
	});

	it('should set entryPoint and exitPoint from typed nodes', () => {
		const state = makeState();
		const template = builderStateToTemplate(state);

		expect(template.topology!.entryPoint).toBe('Coder');
		expect(template.topology!.exitPoint).toBe('Tester');
	});

	it('should omit topology when no edges exist', () => {
		const state = makeState({ edges: [] });
		const template = builderStateToTemplate(state);

		expect(template.topology).toBeUndefined();
	});

	it('should detect pipeline pattern for single-path graph', () => {
		const state = makeState();
		const template = builderStateToTemplate(state);

		expect(template.topology!.pattern).toBe('pipeline');
	});

	it('should detect parallel-then-merge pattern', () => {
		const roleA: TeamTemplateRole = { name: 'Start', agentId: 'claude-code', description: '' };
		const roleB: TeamTemplateRole = { name: 'Worker1', agentId: 'claude-code', description: '' };
		const roleC: TeamTemplateRole = { name: 'Worker2', agentId: 'claude-code', description: '' };
		const roleD: TeamTemplateRole = { name: 'Merge', agentId: 'claude-code', description: '' };

		const state: BuilderState = {
			nodes: [
				makeBuilderNode('n1', 'entry'),
				makeBuilderNode('n2', 'role', 0, 200),
				makeBuilderNode('n3', 'role', 200, 200),
				makeBuilderNode('n4', 'exit', 100, 400),
			],
			edges: [
				makeBuilderEdge('n1', 'n2'),
				makeBuilderEdge('n1', 'n3'), // fan-out
				makeBuilderEdge('n2', 'n4'),
				makeBuilderEdge('n3', 'n4'), // merge
			],
			roles: { n1: roleA, n2: roleB, n3: roleC, n4: roleD },
			selectedNodeId: null,
			selectedEdgeId: null,
			viewport: { x: 0, y: 0, zoom: 1 },
			templateMeta: { name: 'PTM', description: '', category: 'user' },
			dirty: false,
		};

		const template = builderStateToTemplate(state);
		expect(template.topology!.pattern).toBe('parallel-then-merge');
	});

	it('should detect review-loop pattern with conditional back-edge', () => {
		const roleA: TeamTemplateRole = { name: 'Coder', agentId: 'claude-code', description: '' };
		const roleB: TeamTemplateRole = { name: 'Reviewer', agentId: 'claude-code', description: '' };

		const state: BuilderState = {
			nodes: [makeBuilderNode('n1', 'entry'), makeBuilderNode('n2', 'exit', 0, 200)],
			edges: [
				makeBuilderEdge('n1', 'n2'),
				{
					id: 'edge-n2-n1',
					sourceNodeId: 'n2',
					targetNodeId: 'n1',
					edgeType: 'conditional',
					condition: 'needs fix',
				},
			],
			roles: { n1: roleA, n2: roleB },
			selectedNodeId: null,
			selectedEdgeId: null,
			viewport: { x: 0, y: 0, zoom: 1 },
			templateMeta: { name: 'Loop', description: '', category: 'user' },
			dirty: false,
		};

		const template = builderStateToTemplate(state);
		expect(template.topology!.pattern).toBe('review-loop');
	});

	it('should deduplicate roles by name', () => {
		const role: TeamTemplateRole = { name: 'Same', agentId: 'claude-code', description: '' };
		const state: BuilderState = {
			nodes: [makeBuilderNode('n1', 'role'), makeBuilderNode('n2', 'role', 0, 200)],
			edges: [makeBuilderEdge('n1', 'n2')],
			roles: { n1: role, n2: { ...role } },
			selectedNodeId: null,
			selectedEdgeId: null,
			viewport: { x: 0, y: 0, zoom: 1 },
			templateMeta: { name: 'Dedup', description: '', category: 'user' },
			dirty: false,
		};

		const template = builderStateToTemplate(state);
		expect(template.roles).toHaveLength(1);
	});

	it('should trim name and description', () => {
		const state = makeState();
		state.templateMeta.name = '  Spaced  ';
		state.templateMeta.description = '  desc  ';
		const template = builderStateToTemplate(state);

		expect(template.name).toBe('Spaced');
		expect(template.description).toBe('desc');
	});
});

// ============================================================================
// autoLayoutNodes
// ============================================================================

describe('autoLayoutNodes', () => {
	it('should return empty array for empty input', () => {
		expect(autoLayoutNodes([], [])).toEqual([]);
	});

	it('should position a single node', () => {
		const nodes = [makeBuilderNode('n1')];
		const result = autoLayoutNodes(nodes, []);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe('n1');
		// Should be snapped to grid
		expect(result[0].x % GRID_SIZE).toBe(0);
		expect(result[0].y % GRID_SIZE).toBe(0);
	});

	it('should layer nodes in topological order', () => {
		const nodes = [
			makeBuilderNode('a', 'entry'),
			makeBuilderNode('b', 'role'),
			makeBuilderNode('c', 'exit'),
		];
		const edges = [makeBuilderEdge('a', 'b'), makeBuilderEdge('b', 'c')];
		const result = autoLayoutNodes(nodes, edges);

		// Entry should be at the top (lowest y)
		const aNode = result.find((n) => n.id === 'a')!;
		const bNode = result.find((n) => n.id === 'b')!;
		const cNode = result.find((n) => n.id === 'c')!;
		expect(aNode.y).toBeLessThan(bNode.y);
		expect(bNode.y).toBeLessThan(cNode.y);
	});

	it('should place entry nodes first', () => {
		// Even if entry appears last in the array
		const nodes = [
			makeBuilderNode('b', 'role'),
			makeBuilderNode('c', 'exit'),
			makeBuilderNode('a', 'entry'),
		];
		const edges = [makeBuilderEdge('a', 'b'), makeBuilderEdge('b', 'c')];
		const result = autoLayoutNodes(nodes, edges);

		const aNode = result.find((n) => n.id === 'a')!;
		const bNode = result.find((n) => n.id === 'b')!;
		expect(aNode.y).toBeLessThan(bNode.y);
	});

	it('should handle parallel nodes on the same layer', () => {
		const nodes = [
			makeBuilderNode('start', 'entry'),
			makeBuilderNode('w1', 'role'),
			makeBuilderNode('w2', 'role'),
			makeBuilderNode('end', 'exit'),
		];
		const edges = [
			makeBuilderEdge('start', 'w1'),
			makeBuilderEdge('start', 'w2'),
			makeBuilderEdge('w1', 'end'),
			makeBuilderEdge('w2', 'end'),
		];
		const result = autoLayoutNodes(nodes, edges);

		const w1 = result.find((n) => n.id === 'w1')!;
		const w2 = result.find((n) => n.id === 'w2')!;
		// Parallel workers should be on the same y level
		expect(w1.y).toBe(w2.y);
		// But different x positions
		expect(w1.x).not.toBe(w2.x);
	});

	it('should handle cycles without infinite loop', () => {
		const nodes = [makeBuilderNode('a'), makeBuilderNode('b')];
		const edges = [makeBuilderEdge('a', 'b'), makeBuilderEdge('b', 'a')];
		// Should complete without hanging
		const result = autoLayoutNodes(nodes, edges);
		expect(result).toHaveLength(2);
	});

	it('should handle disconnected nodes', () => {
		const nodes = [makeBuilderNode('a'), makeBuilderNode('b'), makeBuilderNode('c')];
		// No edges — all disconnected
		const result = autoLayoutNodes(nodes, []);

		expect(result).toHaveLength(3);
		// All should be on the same layer (same y)
		expect(result[0].y).toBe(result[1].y);
		expect(result[1].y).toBe(result[2].y);
	});

	it('should snap all positions to grid', () => {
		const nodes = [makeBuilderNode('a', 'entry'), makeBuilderNode('b', 'role')];
		const edges = [makeBuilderEdge('a', 'b')];
		const result = autoLayoutNodes(nodes, edges);

		for (const node of result) {
			expect(node.x % GRID_SIZE).toBe(0);
			expect(node.y % GRID_SIZE).toBe(0);
		}
	});

	it('should preserve node dimensions and type', () => {
		const nodes = [makeBuilderNode('a', 'entry')];
		const result = autoLayoutNodes(nodes, []);

		expect(result[0].width).toBe(NODE_WIDTH);
		expect(result[0].height).toBe(NODE_HEIGHT);
		expect(result[0].type).toBe('entry');
	});
});

// ============================================================================
// Round-trip conversion
// ============================================================================

describe('round-trip: template → builder → template', () => {
	it('should preserve role names through round-trip', () => {
		const original = makeTemplate({
			topology: {
				pattern: 'pipeline',
				edges: [
					{ source: 'Frontend', target: 'Backend', edgeType: 'sequential' },
					{ source: 'Backend', target: 'Reviewer', edgeType: 'sequential' },
				],
				entryPoint: 'Frontend',
				exitPoint: 'Reviewer',
			},
		});

		const state = templateToBuilderState(original);
		const rebuilt = builderStateToTemplate(state, original.id);

		const originalNames = original.roles.map((r) => r.name).sort();
		const rebuiltNames = rebuilt.roles.map((r) => r.name).sort();
		expect(rebuiltNames).toEqual(originalNames);
	});

	it('should preserve topology edges through round-trip', () => {
		const original = makeTemplate({
			topology: {
				pattern: 'pipeline',
				edges: [
					{ source: 'Frontend', target: 'Backend', edgeType: 'sequential' },
					{ source: 'Backend', target: 'Reviewer', edgeType: 'sequential' },
				],
				entryPoint: 'Frontend',
				exitPoint: 'Reviewer',
			},
		});

		const state = templateToBuilderState(original);
		const rebuilt = builderStateToTemplate(state, original.id);

		expect(rebuilt.topology).toBeDefined();
		expect(rebuilt.topology!.edges).toHaveLength(2);
		expect(rebuilt.topology!.entryPoint).toBe('Frontend');
		expect(rebuilt.topology!.exitPoint).toBe('Reviewer');
	});

	it('should preserve template id through round-trip', () => {
		const original = makeTemplate();
		const state = templateToBuilderState(original);
		const rebuilt = builderStateToTemplate(state, original.id);

		expect(rebuilt.id).toBe(original.id);
	});
});
