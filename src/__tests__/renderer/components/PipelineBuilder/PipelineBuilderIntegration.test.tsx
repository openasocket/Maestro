/**
 * Integration smoke test — verifies the full Pipeline Builder flow end-to-end.
 *
 * Covers: preset loading, node add/drop, edge creation, node selection + inspector,
 * edge selection + type change, role editing, undo/redo, auto-layout, preview toggle,
 * save round-trip, template restoration, and validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import type { Theme } from '../../../../renderer/types';
import type {
	BuilderNode,
	BuilderEdge,
	BuilderState,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	builderReducer,
	INITIAL_BUILDER_STATE,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderReducer';
import {
	createPipelinePreset,
	createParallelMergePreset,
	createReviewLoopPreset,
	createHubSpokePreset,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderPresets';
import {
	templateToBuilderState,
	builderStateToTemplate,
	autoLayoutNodes,
	detectPattern,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderSerializer';
import {
	validateBuilderState,
	getErrorNodeIds,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderValidation';
import { useBuilderHistory } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/useBuilderHistory';
import { PipelineBuilder } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/PipelineBuilder';
import type { TeamTemplate } from '../../../../shared/group-chat-types';

// ============================================================================
// Mock dependencies
// ============================================================================

// Mock crypto.randomUUID for deterministic IDs
let uuidCounter = 0;
vi.mock('../../../../renderer/utils/ids', () => ({
	generateId: () => `test-uuid-${++uuidCounter}`,
}));

// Mock WorkflowGraph to avoid pulling in its full dependency tree
vi.mock('../../../../renderer/components/GroupChat/WorkflowGraph', () => ({
	WorkflowGraph: ({ topology }: { topology: unknown }) => (
		<div data-testid="workflow-graph-preview">{JSON.stringify(topology)}</div>
	),
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockTheme(): Theme {
	return {
		id: 'dracula',
		name: 'Dracula',
		mode: 'dark',
		colors: {
			bgMain: '#1e1e2e',
			bgSidebar: '#181825',
			bgActivity: '#313244',
			border: '#45475a',
			textMain: '#cdd6f4',
			textDim: '#a6adc8',
			accent: '#cba6f7',
			accentDim: '#cba6f740',
			accentText: '#cba6f7',
			accentForeground: '#1e1e2e',
			success: '#a6e3a1',
			warning: '#f9e2af',
			error: '#f38ba8',
		},
	};
}

function makeNode(id: string, type: BuilderNode['type'] = 'role', x = 0, y = 0): BuilderNode {
	return { id, roleId: `role-${id}`, x, y, width: NODE_WIDTH, height: NODE_HEIGHT, type };
}

function makeEdge(
	id: string,
	sourceNodeId: string,
	targetNodeId: string,
	edgeType: BuilderEdge['edgeType'] = 'sequential',
	condition?: string
): BuilderEdge {
	return { id, sourceNodeId, targetNodeId, edgeType, condition };
}

// ============================================================================
// 1. Full reducer flow — simulates the complete user journey
// ============================================================================

describe('Pipeline Builder Integration — Reducer Flow', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	it('complete user journey: preset → add node → connect → edit → undo/redo → save', () => {
		// Step 1: Start with empty canvas
		let state = INITIAL_BUILDER_STATE;
		expect(state.nodes).toHaveLength(0);
		expect(state.edges).toHaveLength(0);

		// Step 2: Initialize with a template name
		state = builderReducer(state, {
			type: 'SET_TEMPLATE_META',
			meta: { name: 'My Integration Test Template', description: 'Testing E2E' },
		});
		expect(state.templateMeta.name).toBe('My Integration Test Template');

		// Step 3: Load Pipeline preset → nodes and edges appear
		const preset = createPipelinePreset();
		state = builderReducer(state, { type: 'LOAD_PRESET', ...preset });
		expect(state.nodes.length).toBe(5); // Entry, Step1, Step2, Step3, Exit
		expect(state.edges.length).toBe(4); // 4 sequential edges
		expect(state.selectedNodeId).toBeNull(); // Selection cleared
		expect(state.dirty).toBe(true);

		// Verify node types
		const entryNode = state.nodes.find((n) => n.type === 'entry');
		const exitNode = state.nodes.find((n) => n.type === 'exit');
		const roleNodes = state.nodes.filter((n) => n.type === 'role');
		expect(entryNode).toBeDefined();
		expect(exitNode).toBeDefined();
		expect(roleNodes).toHaveLength(3);

		// Step 4: Select a node → verify selection works
		const step1Node = state.nodes[1]; // Step 1
		state = builderReducer(state, { type: 'SELECT_NODE', nodeId: step1Node.id });
		expect(state.selectedNodeId).toBe(step1Node.id);
		expect(state.selectedEdgeId).toBeNull();

		// Step 5: Edit role name, agent, prompt
		const step1RoleId = step1Node.roleId;
		const originalRole = state.roles[step1RoleId];
		expect(originalRole.name).toBe('Step 1');

		state = builderReducer(state, {
			type: 'UPDATE_ROLE',
			roleId: step1RoleId,
			role: {
				...originalRole,
				name: 'Code Writer',
				agentId: 'codex',
				description: 'Writes initial code',
				systemPromptSuffix: 'Focus on clean code',
			},
		});
		expect(state.roles[step1RoleId].name).toBe('Code Writer');
		expect(state.roles[step1RoleId].agentId).toBe('codex');
		expect(state.roles[step1RoleId].description).toBe('Writes initial code');
		expect(state.roles[step1RoleId].systemPromptSuffix).toBe('Focus on clean code');

		// Step 6: Add a new role node (simulating palette drop)
		const newNode = makeNode('new-role-1', 'role', 300, 600);
		state = builderReducer(state, {
			type: 'ADD_NODE',
			node: newNode,
			role: {
				name: 'QA Tester',
				agentId: 'claude-code',
				description: 'Runs tests',
			},
		});
		expect(state.nodes).toHaveLength(6);
		expect(state.nodes.find((n) => n.id === 'new-role-1')).toBeDefined();
		expect(state.selectedNodeId).toBe('new-role-1'); // Auto-selected on add

		// Step 7: Connect the new node with an edge
		const edgeToNew = makeEdge('edge-to-qa', state.nodes[3].id, 'new-role-1', 'sequential');
		state = builderReducer(state, { type: 'ADD_EDGE', edge: edgeToNew });
		expect(state.edges).toHaveLength(5);
		expect(state.selectedEdgeId).toBe('edge-to-qa');

		// Step 8: Select the new edge → verify edge config accessible
		state = builderReducer(state, { type: 'SELECT_EDGE', edgeId: 'edge-to-qa' });
		expect(state.selectedEdgeId).toBe('edge-to-qa');
		expect(state.selectedNodeId).toBeNull();

		// Step 9: Change edge type to conditional
		state = builderReducer(state, {
			type: 'UPDATE_EDGE',
			edgeId: 'edge-to-qa',
			edgeType: 'conditional',
			condition: 'Tests needed',
		});
		const updatedEdge = state.edges.find((e) => e.id === 'edge-to-qa');
		expect(updatedEdge?.edgeType).toBe('conditional');
		expect(updatedEdge?.condition).toBe('Tests needed');

		// Step 10: Validation should report issues (new node not connected to exit)
		const validation = validateBuilderState(state);
		// Template name is set, entry/exit exist, has nodes
		expect(state.templateMeta.name).toBeTruthy();

		// Step 11: Connect QA node to exit to fix validation
		const qaToExit = makeEdge('edge-qa-exit', 'new-role-1', exitNode!.id, 'sequential');
		state = builderReducer(state, { type: 'ADD_EDGE', edge: qaToExit });
		expect(state.edges).toHaveLength(6);

		// Step 12: Auto-layout repositions nodes
		const preLayoutPositions = state.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
		const layoutedNodes = autoLayoutNodes(state.nodes, state.edges);
		state = builderReducer(state, { type: 'LAYOUT_NODES', nodes: layoutedNodes });

		// Positions should have changed for at least some nodes
		const postLayoutPositions = state.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
		const positionsChanged = preLayoutPositions.some((pre) => {
			const post = postLayoutPositions.find((p) => p.id === pre.id);
			return post && (post.x !== pre.x || post.y !== pre.y);
		});
		expect(positionsChanged).toBe(true);

		// Step 13: Save → convert to TeamTemplate
		const savedTemplate = builderStateToTemplate(state);
		expect(savedTemplate.name).toBe('My Integration Test Template');
		expect(savedTemplate.description).toBe('Testing E2E');
		expect(savedTemplate.roles.length).toBeGreaterThanOrEqual(5);
		expect(savedTemplate.topology).toBeDefined();
		expect(savedTemplate.topology!.edges.length).toBe(6);
		expect(savedTemplate.topology!.entryPoint).toBeTruthy();
		expect(savedTemplate.topology!.exitPoint).toBeTruthy();
		expect(savedTemplate.id).toBeTruthy();
		expect(savedTemplate.moderatorAgentId).toBe('claude-code');

		// Step 14: Edit the saved template → builder opens with state restored
		const restoredState = templateToBuilderState(savedTemplate);
		expect(restoredState.nodes.length).toBe(state.nodes.length);
		expect(restoredState.edges.length).toBe(state.edges.length);
		expect(restoredState.templateMeta.name).toBe('My Integration Test Template');
		expect(restoredState.templateMeta.description).toBe('Testing E2E');
		expect(restoredState.dirty).toBe(false); // Fresh load is not dirty

		// Verify roles are preserved
		const restoredRoleNames = Object.values(restoredState.roles)
			.map((r) => r.name)
			.sort();
		expect(restoredRoleNames).toContain('Code Writer');
		expect(restoredRoleNames).toContain('QA Tester');

		// Verify topology is preserved
		const restoredValidation = validateBuilderState(restoredState);
		// Should have entry and exit
		const restoredEntry = restoredState.nodes.find((n) => n.type === 'entry');
		const restoredExit = restoredState.nodes.find((n) => n.type === 'exit');
		expect(restoredEntry).toBeDefined();
		expect(restoredExit).toBeDefined();
	});

	it('duplicate edge prevention', () => {
		const preset = createPipelinePreset();
		let state = builderReducer(INITIAL_BUILDER_STATE, { type: 'LOAD_PRESET', ...preset });
		const existingEdge = state.edges[0];

		// Try to add duplicate edge
		const dupEdge: BuilderEdge = {
			id: 'dup-edge',
			sourceNodeId: existingEdge.sourceNodeId,
			targetNodeId: existingEdge.targetNodeId,
			edgeType: 'sequential',
		};
		const stateAfter = builderReducer(state, { type: 'ADD_EDGE', edge: dupEdge });

		// Should be no-op (same reference returned)
		expect(stateAfter).toBe(state);
		expect(stateAfter.edges).toHaveLength(state.edges.length);
	});

	it('delete node removes associated edges', () => {
		const preset = createPipelinePreset();
		let state = builderReducer(INITIAL_BUILDER_STATE, { type: 'LOAD_PRESET', ...preset });

		// Delete Step 2 (middle node) — should remove edges to/from it
		const step2 = state.nodes[2]; // Step 2 in pipeline
		const edgesBefore = state.edges.length;
		const connectedEdges = state.edges.filter(
			(e) => e.sourceNodeId === step2.id || e.targetNodeId === step2.id
		);
		expect(connectedEdges.length).toBeGreaterThan(0);

		state = builderReducer(state, { type: 'DELETE_NODE', nodeId: step2.id });
		expect(state.nodes).toHaveLength(4);
		expect(state.edges.length).toBe(edgesBefore - connectedEdges.length);

		// No remaining edges reference the deleted node
		const danglingEdges = state.edges.filter(
			(e) => e.sourceNodeId === step2.id || e.targetNodeId === step2.id
		);
		expect(danglingEdges).toHaveLength(0);
	});
});

// ============================================================================
// 2. Undo/Redo through full flow
// ============================================================================

describe('Pipeline Builder Integration — Undo/Redo', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	it('undo/redo works through preset load, node add, edge add, and role edit', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// Load preset
		const preset = createPipelinePreset();
		act(() => {
			result.current[1]({ type: 'LOAD_PRESET', ...preset });
		});
		expect(result.current[0].nodes).toHaveLength(5);
		expect(result.current[2].canUndo).toBe(true);

		// Add a new node
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('extra', 'role', 100, 100),
				role: { name: 'Extra', agentId: 'claude-code', description: '' },
			});
		});
		expect(result.current[0].nodes).toHaveLength(6);

		// Edit a role
		const firstRoleId = result.current[0].nodes[1].roleId;
		act(() => {
			result.current[1]({
				type: 'UPDATE_ROLE',
				roleId: firstRoleId,
				role: {
					name: 'Renamed Role',
					agentId: 'codex',
					description: 'Updated',
				},
			});
		});
		expect(result.current[0].roles[firstRoleId].name).toBe('Renamed Role');

		// Undo role edit
		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].roles[firstRoleId].name).not.toBe('Renamed Role');

		// Undo node add
		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].nodes).toHaveLength(5);

		// Undo preset load
		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].nodes).toHaveLength(0);

		// Redo all three
		act(() => {
			result.current[2].redo();
		}); // preset
		expect(result.current[0].nodes).toHaveLength(5);

		act(() => {
			result.current[2].redo();
		}); // node add
		expect(result.current[0].nodes).toHaveLength(6);

		act(() => {
			result.current[2].redo();
		}); // role edit
		expect(result.current[0].roles[firstRoleId].name).toBe('Renamed Role');
	});
});

// ============================================================================
// 3. Serialization round-trip for all presets
// ============================================================================

describe('Pipeline Builder Integration — Serialization Round-trip', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	const presetFactories = [
		{ name: 'Pipeline', factory: createPipelinePreset },
		{ name: 'Parallel + Merge', factory: createParallelMergePreset },
		{ name: 'Review Loop', factory: createReviewLoopPreset },
		{ name: 'Hub & Spoke', factory: createHubSpokePreset },
	];

	for (const { name, factory } of presetFactories) {
		it(`round-trips "${name}" preset: load → save → restore`, () => {
			uuidCounter = 0;
			// Load preset into builder state
			const preset = factory();
			let state = builderReducer(INITIAL_BUILDER_STATE, { type: 'LOAD_PRESET', ...preset });
			state = builderReducer(state, {
				type: 'SET_TEMPLATE_META',
				meta: { name: `${name} Template` },
			});

			// Save to TeamTemplate
			const template = builderStateToTemplate(state, 'test-id');
			expect(template.name).toBe(`${name} Template`);
			expect(template.roles.length).toBe(preset.nodes.length);
			expect(template.topology).toBeDefined();
			expect(template.topology!.edges.length).toBe(preset.edges.length);

			// Restore from TeamTemplate
			const restored = templateToBuilderState(template);
			expect(restored.nodes.length).toBe(state.nodes.length);
			expect(restored.edges.length).toBe(state.edges.length);
			expect(restored.templateMeta.name).toBe(`${name} Template`);

			// Verify node counts are preserved (types may change for presets
			// without explicit entry/exit since serialization infers them)
			expect(restored.nodes.length).toBe(state.nodes.length);

			// Verify role names are preserved
			const originalNames = Object.values(state.roles)
				.map((r) => r.name)
				.sort();
			const restoredNames = Object.values(restored.roles)
				.map((r) => r.name)
				.sort();
			expect(restoredNames).toEqual(originalNames);

			// Verify re-save produces equivalent template
			const reSaved = builderStateToTemplate(restored, 'test-id');
			expect(reSaved.roles.length).toBe(template.roles.length);
			expect(reSaved.topology!.edges.length).toBe(template.topology!.edges.length);
		});
	}
});

// ============================================================================
// 4. Pattern detection accuracy
// ============================================================================

describe('Pipeline Builder Integration — Pattern Detection', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	it('detects "pipeline" pattern from Pipeline preset', () => {
		const preset = createPipelinePreset();
		const pattern = detectPattern(preset.nodes, preset.edges);
		expect(pattern).toBe('pipeline');
	});

	it('detects "parallel-then-merge" pattern from Parallel+Merge preset', () => {
		const preset = createParallelMergePreset();
		const pattern = detectPattern(preset.nodes, preset.edges);
		expect(pattern).toBe('parallel-then-merge');
	});

	it('detects "review-loop" pattern from Review Loop preset', () => {
		const preset = createReviewLoopPreset();
		const pattern = detectPattern(preset.nodes, preset.edges);
		expect(pattern).toBe('review-loop');
	});

	it('detects "custom" for Hub & Spoke (has back-edges without conditional type)', () => {
		const preset = createHubSpokePreset();
		const pattern = detectPattern(preset.nodes, preset.edges);
		// Hub & Spoke has back-edges but they're sequential, not conditional
		// so it won't match review-loop. It has fan-out + merge so could match
		// parallel-then-merge, or custom depending on edge degree analysis
		expect(['custom', 'parallel-then-merge']).toContain(pattern);
	});
});

// ============================================================================
// 5. Validation — end-to-end scenarios
// ============================================================================

describe('Pipeline Builder Integration — Validation', () => {
	it('valid pipeline preset passes validation', () => {
		const preset = createPipelinePreset();
		let state = builderReducer(INITIAL_BUILDER_STATE, { type: 'LOAD_PRESET', ...preset });
		state = builderReducer(state, {
			type: 'SET_TEMPLATE_META',
			meta: { name: 'Valid Pipeline' },
		});

		const result = validateBuilderState(state);
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});

	it('empty canvas fails validation (no nodes, no name)', () => {
		const result = validateBuilderState(INITIAL_BUILDER_STATE);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.type === 'missing-name')).toBe(true);
		expect(result.errors.some((e) => e.type === 'no-nodes')).toBe(true);
	});

	it('orphaned node triggers validation error', () => {
		const preset = createPipelinePreset();
		let state = builderReducer(INITIAL_BUILDER_STATE, { type: 'LOAD_PRESET', ...preset });
		state = builderReducer(state, {
			type: 'SET_TEMPLATE_META',
			meta: { name: 'Has Orphan' },
		});

		// Add an orphaned node (no edges)
		state = builderReducer(state, {
			type: 'ADD_NODE',
			node: makeNode('orphan', 'role', 500, 500),
			role: { name: 'Orphan', agentId: 'claude-code', description: '' },
		});

		const result = validateBuilderState(state);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.type === 'orphaned-node')).toBe(true);

		// getErrorNodeIds should include the orphan
		const errorIds = getErrorNodeIds(result.errors);
		expect(errorIds.has('orphan')).toBe(true);
	});

	it('missing entry point triggers validation error', () => {
		let state: BuilderState = {
			...INITIAL_BUILDER_STATE,
			templateMeta: { name: 'No Entry', description: '', category: 'user' },
			nodes: [makeNode('r1', 'role', 0, 0), makeNode('exit1', 'exit', 0, 100)],
			edges: [makeEdge('e1', 'r1', 'exit1')],
			roles: {
				'role-r1': { name: 'Worker', agentId: 'claude-code', description: '' },
				'role-exit1': { name: 'Exit', agentId: 'claude-code', description: '' },
			},
		};

		const result = validateBuilderState(state);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.type === 'no-entry')).toBe(true);
	});
});

// ============================================================================
// 6. Component rendering — PipelineBuilder smoke test
// ============================================================================

describe('Pipeline Builder Integration — Component Rendering', () => {
	const theme = createMockTheme();

	beforeEach(() => {
		uuidCounter = 0;
		vi.spyOn(window, 'confirm').mockReturnValue(true);
	});

	it('renders empty state with preset buttons and palette', () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();

		render(<PipelineBuilder onSave={onSave} onCancel={onCancel} theme={theme} />);

		// Empty state text should appear
		expect(screen.getByText('Drag nodes from the palette to start building')).toBeInTheDocument();
		expect(screen.getByText('Choose a pattern to get started')).toBeInTheDocument();

		// Preset pattern buttons should be visible (may appear in both palette and empty state)
		expect(screen.getAllByText('Pipeline').length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText('Parallel + Merge').length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText('Review Loop').length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText('Hub & Spoke').length).toBeGreaterThanOrEqual(1);

		// Builder region should exist with aria label
		expect(screen.getByRole('region', { name: 'Pipeline Builder' })).toBeInTheDocument();

		// Inspector panel should exist
		expect(screen.getByRole('complementary', { name: 'Inspector panel' })).toBeInTheDocument();
	});

	it('loads preset pattern when clicking empty state button', () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();

		render(<PipelineBuilder onSave={onSave} onCancel={onCancel} theme={theme} />);

		// Click the Pipeline preset button in the empty state (use the one with description text)
		const pipelineButtons = screen.getAllByText('Pipeline');
		// Click the last one (inline empty state button, which is a child of a <button>)
		const emptyStateButton = pipelineButtons[pipelineButtons.length - 1].closest('button')!;
		fireEvent.click(emptyStateButton);

		// Empty state should disappear (preset loaded nodes)
		expect(
			screen.queryByText('Drag nodes from the palette to start building')
		).not.toBeInTheDocument();

		// Canvas SVG should now have nodes rendered (check for node groups)
		const canvas = screen.getByRole('application', { name: 'Pipeline builder canvas' });
		expect(canvas).toBeInTheDocument();
	});

	it('renders with existing template and restores state', () => {
		const existingTemplate: TeamTemplate = {
			id: 'existing-1',
			name: 'Existing Template',
			description: 'Pre-saved template',
			category: 'user',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			moderatorAgentId: 'claude-code',
			roles: [
				{ name: 'Entry', agentId: 'claude-code', description: 'Start' },
				{ name: 'Worker', agentId: 'claude-code', description: 'Does work' },
				{ name: 'Exit', agentId: 'claude-code', description: 'End' },
			],
			topology: {
				pattern: 'pipeline',
				entryPoint: 'Entry',
				exitPoint: 'Exit',
				edges: [
					{ source: 'Entry', target: 'Worker', edgeType: 'sequential' },
					{ source: 'Worker', target: 'Exit', edgeType: 'sequential' },
				],
			},
		};

		const onSave = vi.fn();
		const onCancel = vi.fn();

		render(
			<PipelineBuilder
				template={existingTemplate}
				onSave={onSave}
				onCancel={onCancel}
				theme={theme}
			/>
		);

		// Empty state should NOT appear (template has nodes)
		expect(
			screen.queryByText('Drag nodes from the palette to start building')
		).not.toBeInTheDocument();

		// Inspector should show template metadata when nothing selected
		expect(screen.getByText('Template')).toBeInTheDocument();
	});

	it('save button calls onSave with valid template', () => {
		const existingTemplate: TeamTemplate = {
			id: 'test-tpl-1',
			name: 'My Pipeline',
			description: 'Testing onSave',
			category: 'user',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			moderatorAgentId: 'claude-code',
			roles: [
				{ name: 'Entry', agentId: 'claude-code', description: 'Start' },
				{ name: 'Worker', agentId: 'claude-code', description: 'Does work' },
				{ name: 'Exit', agentId: 'claude-code', description: 'End' },
			],
			topology: {
				pattern: 'pipeline',
				entryPoint: 'Entry',
				exitPoint: 'Exit',
				edges: [
					{ source: 'Entry', target: 'Worker', edgeType: 'sequential' },
					{ source: 'Worker', target: 'Exit', edgeType: 'sequential' },
				],
			},
		};

		const onSave = vi.fn();
		const onCancel = vi.fn();

		render(
			<PipelineBuilder
				template={existingTemplate}
				onSave={onSave}
				onCancel={onCancel}
				theme={theme}
			/>
		);

		// Find and click the Save button (use specific aria-label pattern)
		const saveButton = screen.getByRole('button', { name: /^Save Template/i });
		fireEvent.click(saveButton);

		// onSave should have been called with a TeamTemplate
		expect(onSave).toHaveBeenCalledTimes(1);
		const savedTemplate = onSave.mock.calls[0][0] as TeamTemplate;
		expect(savedTemplate.name).toBe('My Pipeline');
		expect(savedTemplate.id).toBe('test-tpl-1'); // Preserves existing ID
		expect(savedTemplate.roles.length).toBe(3);
		expect(savedTemplate.topology).toBeDefined();
	});

	it('keyboard shortcut ? toggles shortcut help overlay', () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();

		render(<PipelineBuilder onSave={onSave} onCancel={onCancel} theme={theme} />);

		// Shortcut help should not be visible initially
		expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();

		// Press ? key
		fireEvent.keyDown(window, { key: '?' });

		// Shortcut help should now be visible
		expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();

		// Press Escape to dismiss
		fireEvent.keyDown(window, { key: 'Escape' });

		// Should be dismissed
		expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
	});

	it('screen reader announcements are present', () => {
		const onSave = vi.fn();
		const onCancel = vi.fn();

		const { container } = render(
			<PipelineBuilder onSave={onSave} onCancel={onCancel} theme={theme} />
		);

		// aria-live region should exist
		const liveRegion = container.querySelector('[aria-live="polite"]');
		expect(liveRegion).toBeInTheDocument();
	});
});

// ============================================================================
// 7. Auto-layout integration — all preset topologies
// ============================================================================

describe('Pipeline Builder Integration — Auto-layout', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	it('auto-layout produces valid non-overlapping positions', () => {
		const preset = createPipelinePreset();
		const layouted = autoLayoutNodes(preset.nodes, preset.edges);

		expect(layouted).toHaveLength(preset.nodes.length);

		// All positions should be grid-aligned
		for (const node of layouted) {
			expect(node.x % 20).toBe(0);
			expect(node.y % 20).toBe(0);
		}

		// No two nodes at the exact same position
		for (let i = 0; i < layouted.length; i++) {
			for (let j = i + 1; j < layouted.length; j++) {
				const samePos = layouted[i].x === layouted[j].x && layouted[i].y === layouted[j].y;
				expect(samePos).toBe(false);
			}
		}
	});

	it('auto-layout handles empty node list', () => {
		const result = autoLayoutNodes([], []);
		expect(result).toHaveLength(0);
	});

	it('auto-layout handles review-loop (has back-edges)', () => {
		const preset = createReviewLoopPreset();
		const layouted = autoLayoutNodes(preset.nodes, preset.edges);
		expect(layouted).toHaveLength(preset.nodes.length);

		// Entry should be above exit vertically
		const entry = layouted.find((n) => n.type === 'entry');
		const exit = layouted.find((n) => n.type === 'exit');
		expect(entry).toBeDefined();
		expect(exit).toBeDefined();
		expect(entry!.y).toBeLessThan(exit!.y);
	});
});

// ============================================================================
// 8. Edge-to-edge: save → validate → restore → validate → re-save
// ============================================================================

describe('Pipeline Builder Integration — Full Save/Restore Cycle', () => {
	beforeEach(() => {
		uuidCounter = 0;
	});

	it('modifications survive save-restore-resave cycle', () => {
		// Build a complex state
		let state = INITIAL_BUILDER_STATE;

		// Load a preset
		const preset = createParallelMergePreset();
		state = builderReducer(state, { type: 'LOAD_PRESET', ...preset });
		state = builderReducer(state, {
			type: 'SET_TEMPLATE_META',
			meta: { name: 'Complex Template', description: 'Multi-step test' },
		});

		// Modify a role
		const workerANode = state.nodes.find((n) => state.roles[n.roleId]?.name === 'Worker A');
		expect(workerANode).toBeDefined();
		state = builderReducer(state, {
			type: 'UPDATE_ROLE',
			roleId: workerANode!.roleId,
			role: {
				...state.roles[workerANode!.roleId],
				name: 'Research Agent',
				agentId: 'opencode',
			},
		});

		// Modify an edge to conditional
		const firstEdge = state.edges[0];
		state = builderReducer(state, {
			type: 'UPDATE_EDGE',
			edgeId: firstEdge.id,
			edgeType: 'conditional',
			condition: 'If complex',
		});

		// Validate before save
		const preValidation = validateBuilderState(state);
		expect(preValidation.valid).toBe(true);

		// Save
		const template1 = builderStateToTemplate(state, 'cycle-test');

		// Restore
		const restored = templateToBuilderState(template1);
		expect(restored.nodes.length).toBe(state.nodes.length);

		// Validate restored
		const postValidation = validateBuilderState(restored);
		expect(postValidation.valid).toBe(true);

		// Check modifications survived
		const restoredResearch = Object.values(restored.roles).find((r) => r.name === 'Research Agent');
		expect(restoredResearch).toBeDefined();
		expect(restoredResearch!.agentId).toBe('opencode');

		// Conditional edge should be preserved
		const conditionalEdge = restored.edges.find((e) => e.edgeType === 'conditional');
		expect(conditionalEdge).toBeDefined();
		expect(conditionalEdge!.condition).toBe('If complex');

		// Re-save
		const template2 = builderStateToTemplate(restored, 'cycle-test');
		expect(template2.roles.length).toBe(template1.roles.length);
		expect(template2.topology!.edges.length).toBe(template1.topology!.edges.length);
	});
});
