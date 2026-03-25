/**
 * @fileoverview Tests for auto-topology generation and tier prompt suffixes
 * in TeamBuilderCanvas.
 *
 * Tests the algorithm:
 *   1. Entry points = nodes with no incoming edges
 *   2. Exit points = nodes with no outgoing edges
 *   3. Edge type: source tier < target tier → sequential; same tier → conditional (peer-review)
 *   4. Pattern is always 'custom'
 *   5. Tier-based prompt suffixes for executives and managers
 */

import { describe, it, expect } from 'vitest';
import type { Node, Edge } from 'reactflow';
import type { RoleTier } from '../../../shared/group-chat-types';
import {
	generateTopologyFromCanvas,
	buildTierPromptSuffix,
	type RoleBuilderNodeData,
	type TeamBuilderEdgeData,
} from '../../../renderer/components/CueModal/TeamBuilderCanvas';

// ============================================================================
// Helpers
// ============================================================================

function makeNode(id: string, name: string, tier: RoleTier): Node<RoleBuilderNodeData> {
	return {
		id,
		type: 'role',
		position: { x: 0, y: 0 },
		data: {
			roleId: id,
			name,
			tier,
			agentId: 'claude-code',
			description: `${name} role`,
			prompt: '',
			onConfigure: () => {},
		},
	};
}

function makeEdge(id: string, source: string, target: string): Edge<TeamBuilderEdgeData> {
	return {
		id,
		source,
		target,
		type: 'team-edge',
		data: {
			connectionType: 'reports-to',
			tierColor: '#888',
		},
	};
}

// ============================================================================
// generateTopologyFromCanvas
// ============================================================================

describe('generateTopologyFromCanvas', () => {
	it('returns undefined when fewer than 2 nodes', () => {
		const nodes = [makeNode('n1', 'Solo Worker', 'worker')];
		const edges = [makeEdge('e1', 'n1', 'n1')];
		expect(generateTopologyFromCanvas(nodes, edges)).toBeUndefined();
	});

	it('returns undefined when no edges', () => {
		const nodes = [makeNode('n1', 'Worker A', 'worker'), makeNode('n2', 'Manager B', 'manager')];
		expect(generateTopologyFromCanvas(nodes, [])).toBeUndefined();
	});

	describe('simple Worker → Manager → Executive chain', () => {
		const nodes = [
			makeNode('n1', 'Developer', 'worker'),
			makeNode('n2', 'Lead', 'manager'),
			makeNode('n3', 'CTO', 'executive'),
		];
		const edges = [makeEdge('e1', 'n1', 'n2'), makeEdge('e2', 'n2', 'n3')];
		const topology = generateTopologyFromCanvas(nodes, edges)!;

		it('sets pattern to custom', () => {
			expect(topology.pattern).toBe('custom');
		});

		it('identifies Developer as entry point (no incoming edges, lowest tier)', () => {
			expect(topology.entryPoint).toBe('Developer');
		});

		it('identifies CTO as exit point (no outgoing edges, highest tier)', () => {
			expect(topology.exitPoint).toBe('CTO');
		});

		it('creates sequential edges for cross-tier connections', () => {
			expect(topology.edges).toHaveLength(2);
			expect(topology.edges[0]).toEqual({
				source: 'Developer',
				target: 'Lead',
				edgeType: 'sequential',
			});
			expect(topology.edges[1]).toEqual({
				source: 'Lead',
				target: 'CTO',
				edgeType: 'sequential',
			});
		});
	});

	describe('same-tier peer connections', () => {
		const nodes = [
			makeNode('n1', 'Manager A', 'manager'),
			makeNode('n2', 'Manager B', 'manager'),
			makeNode('n3', 'VP', 'executive'),
		];
		const edges = [
			makeEdge('e1', 'n1', 'n2'),
			makeEdge('e2', 'n1', 'n3'),
			makeEdge('e3', 'n2', 'n3'),
		];
		const topology = generateTopologyFromCanvas(nodes, edges)!;

		it('marks same-tier edges as conditional with peer-review', () => {
			const peerEdge = topology.edges.find(
				(e) => e.source === 'Manager A' && e.target === 'Manager B'
			);
			expect(peerEdge).toBeDefined();
			expect(peerEdge!.edgeType).toBe('conditional');
			expect(peerEdge!.condition).toBe('peer-review');
		});

		it('marks cross-tier edges as sequential', () => {
			const crossEdge = topology.edges.find((e) => e.source === 'Manager A' && e.target === 'VP');
			expect(crossEdge).toBeDefined();
			expect(crossEdge!.edgeType).toBe('sequential');
		});
	});

	describe('multiple workers reporting to same manager', () => {
		const nodes = [
			makeNode('n1', 'Frontend Dev', 'worker'),
			makeNode('n2', 'Backend Dev', 'worker'),
			makeNode('n3', 'Tech Lead', 'manager'),
		];
		const edges = [makeEdge('e1', 'n1', 'n3'), makeEdge('e2', 'n2', 'n3')];
		const topology = generateTopologyFromCanvas(nodes, edges)!;

		it('selects a worker as entry point', () => {
			// Both workers are entry points; first one by reduction wins
			expect(['Frontend Dev', 'Backend Dev']).toContain(topology.entryPoint);
		});

		it('selects Tech Lead as exit point', () => {
			expect(topology.exitPoint).toBe('Tech Lead');
		});

		it('generates all edges as sequential (worker→manager)', () => {
			expect(topology.edges).toHaveLength(2);
			for (const edge of topology.edges) {
				expect(edge.edgeType).toBe('sequential');
			}
		});
	});

	describe('executive-to-executive chain', () => {
		const nodes = [
			makeNode('n1', 'Worker', 'worker'),
			makeNode('n2', 'VP Engineering', 'executive'),
			makeNode('n3', 'CEO', 'executive'),
		];
		const edges = [makeEdge('e1', 'n1', 'n2'), makeEdge('e2', 'n2', 'n3')];
		const topology = generateTopologyFromCanvas(nodes, edges)!;

		it('marks executive→executive as conditional peer-review', () => {
			const execEdge = topology.edges.find(
				(e) => e.source === 'VP Engineering' && e.target === 'CEO'
			);
			expect(execEdge).toBeDefined();
			expect(execEdge!.edgeType).toBe('conditional');
			expect(execEdge!.condition).toBe('peer-review');
		});

		it('picks highest-tier exit point (CEO)', () => {
			// Both executives have no outgoing (CEO) or n2 has outgoing, so CEO is exit
			expect(topology.exitPoint).toBe('CEO');
		});

		it('picks lowest-tier entry point (Worker)', () => {
			expect(topology.entryPoint).toBe('Worker');
		});
	});

	describe('worker direct to executive (skip manager)', () => {
		const nodes = [makeNode('n1', 'Analyst', 'worker'), makeNode('n2', 'Director', 'executive')];
		const edges = [makeEdge('e1', 'n1', 'n2')];
		const topology = generateTopologyFromCanvas(nodes, edges)!;

		it('creates sequential edge', () => {
			expect(topology.edges[0].edgeType).toBe('sequential');
		});

		it('entry is Analyst, exit is Director', () => {
			expect(topology.entryPoint).toBe('Analyst');
			expect(topology.exitPoint).toBe('Director');
		});
	});
});

// ============================================================================
// buildTierPromptSuffix
// ============================================================================

describe('buildTierPromptSuffix', () => {
	it('returns undefined for workers with no user suffix', () => {
		expect(buildTierPromptSuffix('worker')).toBeUndefined();
		expect(buildTierPromptSuffix('worker', undefined)).toBeUndefined();
	});

	it('returns user suffix only for workers with a user suffix', () => {
		expect(buildTierPromptSuffix('worker', 'Be concise')).toBe('Be concise');
	});

	it('returns executive prompt suffix when no user suffix', () => {
		const result = buildTierPromptSuffix('executive');
		expect(result).toContain('final approver');
		expect(result).toContain('delegate corrections');
	});

	it('returns manager prompt suffix when no user suffix', () => {
		const result = buildTierPromptSuffix('manager');
		expect(result).toContain('coordinate work');
		expect(result).toContain('escalate to your reporting executive');
	});

	it('concatenates user suffix with executive suffix', () => {
		const result = buildTierPromptSuffix('executive', 'Focus on security');
		expect(result).toBe(
			'Focus on security\n\nYou are the final approver. Review all work submitted to you. If the quality is acceptable, produce the final output. If not, provide specific feedback and delegate corrections back down the chain.'
		);
	});

	it('concatenates user suffix with manager suffix', () => {
		const result = buildTierPromptSuffix('manager', 'Track deadlines');
		expect(result).toBe(
			'Track deadlines\n\nYou coordinate work from your team members. Summarize results, identify gaps, and escalate to your reporting executive when ready for final review.'
		);
	});

	it('returns user suffix only for workers (no tier suffix injected)', () => {
		const result = buildTierPromptSuffix('worker', 'Write clean code');
		expect(result).toBe('Write clean code');
		expect(result).not.toContain('approver');
		expect(result).not.toContain('coordinate');
	});
});
