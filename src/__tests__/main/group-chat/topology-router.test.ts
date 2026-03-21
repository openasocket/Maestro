/**
 * @file topology-router.test.ts
 * @description Unit tests for the graph-based workflow topology routing engine.
 *
 * Tests cover:
 * - Execution state initialization
 * - Pipeline routing (sequential handoff)
 * - Parallel-then-merge routing
 * - Review-loop routing (conditional branching)
 * - Custom routing (generic graph traversal)
 * - Workflow completion detection
 * - Execution state updates
 * - Condition evaluation prompt building
 * - Topology validation
 * - Topology description generation
 */

import { describe, it, expect } from 'vitest';
import type {
	WorkflowTopology,
	WorkflowEdge,
	WorkflowExecutionState,
} from '../../../shared/group-chat-types';
import {
	initExecutionState,
	getNextNodes,
	isWorkflowComplete,
	updateExecutionState,
	finalizeWorkflow,
	buildConditionEvalPrompt,
	validateTopology,
	describeTopology,
} from '../../../main/group-chat/topology-router';

// ============================================================================
// Test fixtures
// ============================================================================

function createPipelineTopology(): WorkflowTopology {
	return {
		pattern: 'pipeline',
		edges: [
			{ source: '__entry__', target: 'Researcher', edgeType: 'sequential' },
			{ source: 'Researcher', target: 'Writer', edgeType: 'sequential' },
			{ source: 'Writer', target: 'Editor', edgeType: 'sequential' },
			{ source: 'Editor', target: '__exit__', edgeType: 'sequential' },
		],
		entryPoint: 'Researcher',
		exitPoint: 'Editor',
	};
}

function createParallelMergeTopology(): WorkflowTopology {
	return {
		pattern: 'parallel-then-merge',
		edges: [
			{ source: '__entry__', target: 'Planner', edgeType: 'sequential' },
			{ source: 'Planner', target: 'Frontend', edgeType: 'parallel' },
			{ source: 'Planner', target: 'Backend', edgeType: 'parallel' },
			{ source: 'Planner', target: 'Database', edgeType: 'parallel' },
			{ source: 'Frontend', target: 'Integrator', edgeType: 'sequential' },
			{ source: 'Backend', target: 'Integrator', edgeType: 'sequential' },
			{ source: 'Database', target: 'Integrator', edgeType: 'sequential' },
			{ source: 'Integrator', target: '__exit__', edgeType: 'sequential' },
		],
		entryPoint: 'Planner',
		exitPoint: 'Integrator',
	};
}

function createReviewLoopTopology(): WorkflowTopology {
	return {
		pattern: 'review-loop',
		edges: [
			{ source: '__entry__', target: 'Implementer', edgeType: 'sequential' },
			{ source: 'Implementer', target: 'Reviewer', edgeType: 'sequential' },
			{ source: 'Reviewer', target: '__exit__', condition: 'approved', edgeType: 'conditional' },
			{ source: 'Reviewer', target: 'Implementer', condition: 'rejected', edgeType: 'conditional' },
		],
		entryPoint: 'Implementer',
		exitPoint: 'Reviewer',
	};
}

function createCustomTopology(): WorkflowTopology {
	return {
		pattern: 'custom',
		edges: [
			{ source: '__entry__', target: 'Triage', edgeType: 'sequential' },
			{ source: 'Triage', target: 'QuickFix', condition: 'simple bug', edgeType: 'conditional' },
			{
				source: 'Triage',
				target: 'DeepAnalysis',
				condition: 'complex issue',
				edgeType: 'conditional',
			},
			{ source: 'QuickFix', target: '__exit__', edgeType: 'sequential' },
			{ source: 'DeepAnalysis', target: '__exit__', edgeType: 'sequential' },
		],
		entryPoint: 'Triage',
		exitPoint: 'QuickFix', // or DeepAnalysis depending on path
	};
}

function createBaseExecutionState(): WorkflowExecutionState {
	return {
		currentPhase: '',
		completedNodes: [],
		pendingNodes: [],
		activeNodes: [],
		iterationCount: 0,
		nodeOutputs: {},
		status: 'running',
	};
}

// ============================================================================
// initExecutionState
// ============================================================================

describe('initExecutionState', () => {
	it('sets entry point as active node', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.activeNodes).toEqual(['Researcher']);
		expect(state.currentPhase).toBe('Researcher');
	});

	it('sets other nodes as pending', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.pendingNodes).toContain('Writer');
		expect(state.pendingNodes).toContain('Editor');
		expect(state.pendingNodes).not.toContain('Researcher');
	});

	it('starts with running status', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.status).toBe('running');
	});

	it('starts with zero iteration count', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.iterationCount).toBe(0);
	});

	it('starts with empty completed nodes and outputs', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.completedNodes).toEqual([]);
		expect(state.nodeOutputs).toEqual({});
	});

	it('excludes __entry__ and __exit__ from node lists', () => {
		const topology = createPipelineTopology();
		const state = initExecutionState(topology);

		expect(state.activeNodes).not.toContain('__entry__');
		expect(state.activeNodes).not.toContain('__exit__');
		expect(state.pendingNodes).not.toContain('__entry__');
		expect(state.pendingNodes).not.toContain('__exit__');
	});

	it('handles parallel topology correctly', () => {
		const topology = createParallelMergeTopology();
		const state = initExecutionState(topology);

		expect(state.activeNodes).toEqual(['Planner']);
		expect(state.pendingNodes).toContain('Frontend');
		expect(state.pendingNodes).toContain('Backend');
		expect(state.pendingNodes).toContain('Database');
		expect(state.pendingNodes).toContain('Integrator');
	});
});

// ============================================================================
// getNextNodes — Pipeline
// ============================================================================

describe('getNextNodes — pipeline', () => {
	it('returns next node in sequence', () => {
		const topology = createPipelineTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Researcher');
		expect(next).toEqual(['Writer']);
	});

	it('returns next node after middle of pipeline', () => {
		const topology = createPipelineTopology();
		const state = { ...createBaseExecutionState(), completedNodes: ['Researcher'] };

		const next = getNextNodes(topology, state, 'Writer');
		expect(next).toEqual(['Editor']);
	});

	it('returns empty when last node completes (exit edge)', () => {
		const topology = createPipelineTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Researcher', 'Writer'],
		};

		const next = getNextNodes(topology, state, 'Editor');
		expect(next).toEqual([]);
	});

	it('returns empty for unknown node', () => {
		const topology = createPipelineTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Unknown');
		expect(next).toEqual([]);
	});
});

// ============================================================================
// getNextNodes — Parallel-then-merge
// ============================================================================

describe('getNextNodes — parallel-then-merge', () => {
	it('activates all parallel branches when entry completes', () => {
		const topology = createParallelMergeTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Planner');
		expect(next).toHaveLength(3);
		expect(next).toContain('Frontend');
		expect(next).toContain('Backend');
		expect(next).toContain('Database');
	});

	it('returns empty when only some parallel nodes are done', () => {
		const topology = createParallelMergeTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Planner', 'Frontend'],
		};

		const next = getNextNodes(topology, state, 'Backend');
		expect(next).toEqual([]);
	});

	it('activates merger when ALL parallel nodes complete', () => {
		const topology = createParallelMergeTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Planner', 'Frontend', 'Backend'],
		};

		const next = getNextNodes(topology, state, 'Database');
		expect(next).toEqual(['Integrator']);
	});

	it('returns empty after merger completes (exit)', () => {
		const topology = createParallelMergeTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Planner', 'Frontend', 'Backend', 'Database'],
		};

		const next = getNextNodes(topology, state, 'Integrator');
		expect(next).toEqual([]);
	});
});

// ============================================================================
// getNextNodes — Review-loop
// ============================================================================

describe('getNextNodes — review-loop', () => {
	it('routes from implementer to reviewer (non-conditional edge)', () => {
		const topology = createReviewLoopTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Implementer');
		expect(next).toEqual(['Reviewer']);
	});

	it('loops back on rejection via moderator decision', () => {
		const topology = createReviewLoopTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			nodeOutputs: { Reviewer: 'The code has issues' },
		};

		const next = getNextNodes(topology, state, 'Reviewer', 'rejected');
		expect(next).toEqual(['Implementer']);
	});

	it('proceeds to exit on approval via moderator decision', () => {
		const topology = createReviewLoopTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			nodeOutputs: { Reviewer: 'Code looks good' },
		};

		const next = getNextNodes(topology, state, 'Reviewer', 'approved');
		expect(next).toEqual([]);
	});

	it('auto-detects approval from node output when no moderator decision', () => {
		const topology = createReviewLoopTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			nodeOutputs: { Reviewer: 'This code is approved and ready for production.' },
		};

		const next = getNextNodes(topology, state, 'Reviewer');
		expect(next).toEqual([]);
	});

	it('auto-detects LGTM as approval', () => {
		const topology = createReviewLoopTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			nodeOutputs: { Reviewer: 'LGTM, ship it!' },
		};

		const next = getNextNodes(topology, state, 'Reviewer');
		expect(next).toEqual([]);
	});

	it('loops back when output has no approval signal', () => {
		const topology = createReviewLoopTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			nodeOutputs: { Reviewer: 'Several issues found: missing error handling, no tests.' },
		};

		const next = getNextNodes(topology, state, 'Reviewer');
		expect(next).toEqual(['Implementer']);
	});
});

// ============================================================================
// getNextNodes — Custom
// ============================================================================

describe('getNextNodes — custom', () => {
	it('follows conditional edge based on moderator decision', () => {
		const topology = createCustomTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Triage', 'this is a simple bug');
		expect(next).toEqual(['QuickFix']);
	});

	it('follows alternative conditional edge', () => {
		const topology = createCustomTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Triage', 'this is a complex issue');
		expect(next).toEqual(['DeepAnalysis']);
	});

	it('takes first conditional edge as default when no moderator decision', () => {
		const topology = createCustomTopology();
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Triage');
		expect(next).toEqual(['QuickFix']);
	});

	it('returns empty after leaf node completes', () => {
		const topology = createCustomTopology();
		const state = {
			...createBaseExecutionState(),
			completedNodes: ['Triage'],
		};

		const next = getNextNodes(topology, state, 'QuickFix');
		expect(next).toEqual([]);
	});
});

// ============================================================================
// getNextNodes — Hub-spoke (fallback)
// ============================================================================

describe('getNextNodes — hub-spoke', () => {
	it('returns empty array (hub-spoke uses default routing)', () => {
		const topology: WorkflowTopology = {
			pattern: 'hub-spoke',
			edges: [],
			entryPoint: 'Moderator',
			exitPoint: 'Moderator',
		};
		const state = createBaseExecutionState();

		const next = getNextNodes(topology, state, 'Moderator');
		expect(next).toEqual([]);
	});
});

// ============================================================================
// isWorkflowComplete
// ============================================================================

describe('isWorkflowComplete', () => {
	it('returns false when workflow is still running', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Researcher'],
			pendingNodes: ['Writer', 'Editor'],
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(false);
	});

	it('returns true when exit point has completed', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			completedNodes: ['Researcher', 'Writer', 'Editor'],
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});

	it('returns true when max iterations reached', () => {
		const topology = createReviewLoopTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Implementer'],
			iterationCount: 5,
		};

		expect(isWorkflowComplete(topology, state, 5)).toBe(true);
	});

	it('returns false when under max iterations', () => {
		const topology = createReviewLoopTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Implementer'],
			iterationCount: 4,
		};

		expect(isWorkflowComplete(topology, state, 5)).toBe(false);
	});

	it('returns true when status is completed', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			status: 'completed',
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});

	it('returns true when status is failed', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			status: 'failed',
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});

	it('returns true when status is terminated', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			status: 'terminated',
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});

	it('returns true when no active or pending nodes remain', () => {
		const topology = createPipelineTopology();
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			completedNodes: ['Researcher'],
			activeNodes: [],
			pendingNodes: [],
		};

		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});
});

// ============================================================================
// updateExecutionState
// ============================================================================

describe('updateExecutionState', () => {
	it('moves completed node from active to completed', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Researcher'],
			pendingNodes: ['Writer', 'Editor'],
		};

		const updated = updateExecutionState(state, 'Researcher', 'Research complete', ['Writer']);
		expect(updated.completedNodes).toContain('Researcher');
		expect(updated.activeNodes).not.toContain('Researcher');
		expect(updated.activeNodes).toContain('Writer');
	});

	it('stores node output', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Researcher'],
		};

		const updated = updateExecutionState(state, 'Researcher', 'Research findings', ['Writer']);
		expect(updated.nodeOutputs['Researcher']).toBe('Research findings');
	});

	it('removes activated nodes from pending', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Researcher'],
			pendingNodes: ['Writer', 'Editor'],
		};

		const updated = updateExecutionState(state, 'Researcher', 'Done', ['Writer']);
		expect(updated.pendingNodes).not.toContain('Writer');
		expect(updated.pendingNodes).toContain('Editor');
	});

	it('increments iteration count when isLoop is true', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Reviewer'],
			iterationCount: 1,
		};

		const updated = updateExecutionState(
			state,
			'Reviewer',
			'Needs revision',
			['Implementer'],
			true
		);
		expect(updated.iterationCount).toBe(2);
	});

	it('does not increment iteration count when isLoop is false', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Writer'],
			iterationCount: 0,
		};

		const updated = updateExecutionState(state, 'Writer', 'Draft done', ['Editor']);
		expect(updated.iterationCount).toBe(0);
	});

	it('updates currentPhase to first next node', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			currentPhase: 'Researcher',
			activeNodes: ['Researcher'],
		};

		const updated = updateExecutionState(state, 'Researcher', 'Done', ['Writer']);
		expect(updated.currentPhase).toBe('Writer');
	});

	it('keeps currentPhase as completed node when no next nodes', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			currentPhase: 'Editor',
			activeNodes: ['Editor'],
		};

		const updated = updateExecutionState(state, 'Editor', 'Final output', []);
		expect(updated.currentPhase).toBe('Editor');
	});

	it('does not duplicate already-completed node', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			completedNodes: ['Implementer'],
			activeNodes: ['Implementer'],
		};

		const updated = updateExecutionState(state, 'Implementer', 'Done again', ['Reviewer']);
		// Implementer should appear only once in completedNodes
		expect(updated.completedNodes.filter((n) => n === 'Implementer')).toHaveLength(1);
	});

	it('does not mutate original state', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Researcher'],
			pendingNodes: ['Writer'],
		};

		const updated = updateExecutionState(state, 'Researcher', 'Done', ['Writer']);
		expect(state.activeNodes).toEqual(['Researcher']);
		expect(state.pendingNodes).toEqual(['Writer']);
		expect(state.completedNodes).toEqual([]);
		expect(updated).not.toBe(state);
	});
});

// ============================================================================
// finalizeWorkflow
// ============================================================================

describe('finalizeWorkflow', () => {
	it('sets status to completed', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Editor'],
			completedNodes: ['Researcher', 'Writer'],
		};

		const finalized = finalizeWorkflow(state, 'completed');
		expect(finalized.status).toBe('completed');
		expect(finalized.activeNodes).toEqual([]);
		expect(finalized.pendingNodes).toEqual([]);
	});

	it('sets status to terminated', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Implementer'],
			iterationCount: 5,
		};

		const finalized = finalizeWorkflow(state, 'terminated');
		expect(finalized.status).toBe('terminated');
		expect(finalized.activeNodes).toEqual([]);
	});

	it('sets status to failed', () => {
		const state = createBaseExecutionState();
		const finalized = finalizeWorkflow(state, 'failed');
		expect(finalized.status).toBe('failed');
	});

	it('preserves completed nodes and outputs', () => {
		const state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			completedNodes: ['Researcher', 'Writer'],
			nodeOutputs: { Researcher: 'Data', Writer: 'Draft' },
		};

		const finalized = finalizeWorkflow(state, 'completed');
		expect(finalized.completedNodes).toEqual(['Researcher', 'Writer']);
		expect(finalized.nodeOutputs).toEqual({ Researcher: 'Data', Writer: 'Draft' });
	});
});

// ============================================================================
// buildConditionEvalPrompt
// ============================================================================

describe('buildConditionEvalPrompt', () => {
	it('builds prompt with condition options', () => {
		const edges: WorkflowEdge[] = [
			{ source: 'Reviewer', target: '__exit__', condition: 'approved', edgeType: 'conditional' },
			{ source: 'Reviewer', target: 'Implementer', condition: 'rejected', edgeType: 'conditional' },
		];

		const prompt = buildConditionEvalPrompt(edges, 'The code looks good overall.');
		expect(prompt).toContain('approved');
		expect(prompt).toContain('rejected');
		expect(prompt).toContain('The code looks good overall.');
		expect(prompt).toContain('workflow exit');
		expect(prompt).toContain('@Implementer');
	});

	it('truncates long output', () => {
		const edges: WorkflowEdge[] = [
			{ source: 'A', target: 'B', condition: 'yes', edgeType: 'conditional' },
		];

		const longOutput = 'x'.repeat(2000);
		const prompt = buildConditionEvalPrompt(edges, longOutput);
		expect(prompt).toContain('...(truncated)');
		expect(prompt.length).toBeLessThan(longOutput.length + 500);
	});

	it('does not truncate short output', () => {
		const edges: WorkflowEdge[] = [
			{ source: 'A', target: 'B', condition: 'yes', edgeType: 'conditional' },
		];

		const prompt = buildConditionEvalPrompt(edges, 'Short output');
		expect(prompt).not.toContain('truncated');
	});

	it('skips edges without conditions', () => {
		const edges: WorkflowEdge[] = [
			{ source: 'A', target: 'B', edgeType: 'sequential' },
			{ source: 'A', target: 'C', condition: 'if complex', edgeType: 'conditional' },
		];

		const prompt = buildConditionEvalPrompt(edges, 'Output');
		expect(prompt).toContain('if complex');
		expect(prompt).not.toContain('undefined');
	});
});

// ============================================================================
// validateTopology
// ============================================================================

describe('validateTopology', () => {
	it('returns empty array for valid topology', () => {
		const topology = createPipelineTopology();
		const roleNames = ['Researcher', 'Writer', 'Editor'];

		const warnings = validateTopology(topology, roleNames);
		expect(warnings).toEqual([]);
	});

	it('warns about unknown entry point', () => {
		const topology = createPipelineTopology();
		const roleNames = ['Writer', 'Editor']; // missing Researcher

		const warnings = validateTopology(topology, roleNames);
		expect(warnings).toContain('Entry point "Researcher" is not a known role');
	});

	it('warns about unknown exit point', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [{ source: 'A', target: 'B', edgeType: 'sequential' }],
			entryPoint: 'A',
			exitPoint: 'Unknown',
		};

		const warnings = validateTopology(topology, ['A', 'B']);
		expect(warnings).toContain('Exit point "Unknown" is not a known role');
	});

	it('warns about unknown edge source', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [{ source: 'Unknown', target: 'B', edgeType: 'sequential' }],
			entryPoint: 'B',
			exitPoint: 'B',
		};

		const warnings = validateTopology(topology, ['B']);
		expect(warnings.some((w) => w.includes('Unknown'))).toBe(true);
	});

	it('warns about unknown edge target', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [{ source: 'A', target: 'Unknown', edgeType: 'sequential' }],
			entryPoint: 'A',
			exitPoint: 'A',
		};

		const warnings = validateTopology(topology, ['A']);
		expect(warnings.some((w) => w.includes('Unknown'))).toBe(true);
	});

	it('warns about disconnected nodes', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [{ source: 'A', target: 'B', edgeType: 'sequential' }],
			entryPoint: 'A',
			exitPoint: 'C',
		};

		const warnings = validateTopology(topology, ['A', 'B', 'C']);
		expect(warnings.some((w) => w.includes('"C" is not connected'))).toBe(true);
	});

	it('warns about empty edges', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [],
			entryPoint: 'A',
			exitPoint: 'A',
		};

		const warnings = validateTopology(topology, ['A']);
		expect(warnings).toContain('Topology has no edges defined');
	});

	it('does not warn about __entry__ and __exit__ as edge endpoints', () => {
		const topology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [
				{ source: '__entry__', target: 'A', edgeType: 'sequential' },
				{ source: 'A', target: '__exit__', edgeType: 'sequential' },
			],
			entryPoint: 'A',
			exitPoint: 'A',
		};

		const warnings = validateTopology(topology, ['A']);
		expect(warnings).toEqual([]);
	});
});

// ============================================================================
// describeTopology
// ============================================================================

describe('describeTopology', () => {
	it('describes a pipeline topology', () => {
		const topology = createPipelineTopology();
		const description = describeTopology(topology);

		expect(description).toContain('pipeline');
		expect(description).toContain('Researcher');
		expect(description).toContain('Editor');
		expect(description).toContain('→');
	});

	it('shows conditional edges', () => {
		const topology = createReviewLoopTopology();
		const description = describeTopology(topology);

		expect(description).toContain('approved');
		expect(description).toContain('rejected');
		expect(description).toContain('conditional');
	});

	it('shows parallel edges', () => {
		const topology = createParallelMergeTopology();
		const description = describeTopology(topology);

		expect(description).toContain('parallel');
		expect(description).toContain('Frontend');
		expect(description).toContain('Backend');
		expect(description).toContain('Database');
	});

	it('uses (start) and (end) for __entry__ and __exit__', () => {
		const topology = createPipelineTopology();
		const description = describeTopology(topology);

		expect(description).toContain('(start)');
		expect(description).toContain('(end)');
	});

	it('shows entry and exit points', () => {
		const topology = createPipelineTopology();
		const description = describeTopology(topology);

		expect(description).toContain('Entry: Researcher');
		expect(description).toContain('Exit: Editor');
	});
});

// ============================================================================
// End-to-end workflow scenarios
// ============================================================================

describe('end-to-end: pipeline workflow', () => {
	it('completes a full pipeline from start to finish', () => {
		const topology = createPipelineTopology();
		let state = initExecutionState(topology);

		// Step 1: Researcher active
		expect(state.activeNodes).toEqual(['Researcher']);

		// Step 2: Researcher completes → Writer activates
		const next1 = getNextNodes(topology, state, 'Researcher');
		expect(next1).toEqual(['Writer']);
		state = updateExecutionState(state, 'Researcher', 'Research data', next1);
		expect(state.activeNodes).toEqual(['Writer']);
		expect(isWorkflowComplete(topology, state, 10)).toBe(false);

		// Step 3: Writer completes → Editor activates
		const next2 = getNextNodes(topology, state, 'Writer');
		expect(next2).toEqual(['Editor']);
		state = updateExecutionState(state, 'Writer', 'Draft article', next2);
		expect(state.activeNodes).toEqual(['Editor']);
		expect(isWorkflowComplete(topology, state, 10)).toBe(false);

		// Step 4: Editor completes → workflow done
		const next3 = getNextNodes(topology, state, 'Editor');
		expect(next3).toEqual([]);
		state = updateExecutionState(state, 'Editor', 'Final article', []);
		expect(isWorkflowComplete(topology, state, 10)).toBe(true);

		// Finalize
		state = finalizeWorkflow(state, 'completed');
		expect(state.status).toBe('completed');
		expect(state.completedNodes).toEqual(['Researcher', 'Writer', 'Editor']);
	});
});

describe('end-to-end: parallel-then-merge workflow', () => {
	it('completes a full parallel merge workflow', () => {
		const topology = createParallelMergeTopology();
		let state = initExecutionState(topology);

		// Step 1: Planner active
		expect(state.activeNodes).toEqual(['Planner']);

		// Step 2: Planner completes → parallel branches activate
		const branches = getNextNodes(topology, state, 'Planner');
		expect(branches).toHaveLength(3);
		state = updateExecutionState(state, 'Planner', 'Plan ready', branches);
		expect(state.activeNodes).toContain('Frontend');
		expect(state.activeNodes).toContain('Backend');
		expect(state.activeNodes).toContain('Database');

		// Step 3: Frontend completes (others still working)
		let next = getNextNodes(topology, state, 'Frontend');
		expect(next).toEqual([]); // waiting for others
		state = updateExecutionState(state, 'Frontend', 'UI done', next);

		// Step 4: Backend completes (Database still working)
		next = getNextNodes(topology, state, 'Backend');
		expect(next).toEqual([]); // waiting for Database
		state = updateExecutionState(state, 'Backend', 'API done', next);

		// Step 5: Database completes → Integrator activates
		next = getNextNodes(topology, state, 'Database');
		expect(next).toEqual(['Integrator']);
		state = updateExecutionState(state, 'Database', 'Schema done', next);
		expect(state.activeNodes).toEqual(['Integrator']);

		// Step 6: Integrator completes → done
		next = getNextNodes(topology, state, 'Integrator');
		expect(next).toEqual([]);
		state = updateExecutionState(state, 'Integrator', 'Integration complete', next);
		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});
});

describe('end-to-end: review-loop workflow', () => {
	it('loops once then approves', () => {
		const topology = createReviewLoopTopology();
		let state = initExecutionState(topology);

		// Step 1: Implementer active
		expect(state.activeNodes).toEqual(['Implementer']);

		// Step 2: Implementer completes → Reviewer
		let next = getNextNodes(topology, state, 'Implementer');
		expect(next).toEqual(['Reviewer']);
		state = updateExecutionState(state, 'Implementer', 'First draft', next);

		// Step 3: Reviewer rejects → back to Implementer
		state = {
			...state,
			nodeOutputs: { ...state.nodeOutputs, Reviewer: 'Issues found, needs fixes' },
		};
		next = getNextNodes(topology, state, 'Reviewer', 'rejected');
		expect(next).toEqual(['Implementer']);
		state = updateExecutionState(state, 'Reviewer', 'Needs fixes', next, true);
		expect(state.iterationCount).toBe(1);

		// Step 4: Implementer tries again → Reviewer
		next = getNextNodes(topology, state, 'Implementer');
		expect(next).toEqual(['Reviewer']);
		state = updateExecutionState(state, 'Implementer', 'Revised implementation', next);

		// Step 5: Reviewer approves → done
		next = getNextNodes(topology, state, 'Reviewer', 'approved');
		expect(next).toEqual([]);
		state = updateExecutionState(state, 'Reviewer', 'Approved', next);
		expect(isWorkflowComplete(topology, state, 10)).toBe(true);
	});

	it('terminates after max iterations', () => {
		const topology = createReviewLoopTopology();
		let state: WorkflowExecutionState = {
			...createBaseExecutionState(),
			activeNodes: ['Implementer'],
			iterationCount: 3,
		};

		expect(isWorkflowComplete(topology, state, 3)).toBe(true);
		state = finalizeWorkflow(state, 'terminated');
		expect(state.status).toBe('terminated');
	});
});
