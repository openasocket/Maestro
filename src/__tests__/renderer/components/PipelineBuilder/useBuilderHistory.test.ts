/**
 * Tests for useBuilderHistory — undo/redo history wrapper around builderReducer.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBuilderHistory } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/useBuilderHistory';
import { INITIAL_BUILDER_STATE } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderReducer';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import type { BuilderNode } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';

function makeNode(id: string, type: 'role' | 'entry' | 'exit' = 'role'): BuilderNode {
	return { id, roleId: `role-${id}`, x: 0, y: 0, width: NODE_WIDTH, height: NODE_HEIGHT, type };
}

describe('useBuilderHistory', () => {
	it('should start with initial state and no history', () => {
		const { result } = renderHook(() => useBuilderHistory());
		const [state, , controls] = result.current;

		expect(state).toEqual(INITIAL_BUILDER_STATE);
		expect(controls.canUndo).toBe(false);
		expect(controls.canRedo).toBe(false);
		expect(controls.isDirty).toBe(false);
	});

	it('should dispatch actions and update state', () => {
		const { result } = renderHook(() => useBuilderHistory());

		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});

		const [state, , controls] = result.current;
		expect(state.nodes).toHaveLength(1);
		expect(state.nodes[0].id).toBe('n1');
		expect(controls.canUndo).toBe(true);
		expect(controls.isDirty).toBe(true);
	});

	it('should undo an action', () => {
		const { result } = renderHook(() => useBuilderHistory());

		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});

		expect(result.current[0].nodes).toHaveLength(1);

		act(() => {
			result.current[2].undo();
		});

		const [state, , controls] = result.current;
		expect(state.nodes).toHaveLength(0);
		expect(controls.canUndo).toBe(false);
		expect(controls.canRedo).toBe(true);
		expect(controls.isDirty).toBe(false);
	});

	it('should redo after undo', () => {
		const { result } = renderHook(() => useBuilderHistory());

		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});

		act(() => {
			result.current[2].undo();
		});

		expect(result.current[0].nodes).toHaveLength(0);

		act(() => {
			result.current[2].redo();
		});

		const [state, , controls] = result.current;
		expect(state.nodes).toHaveLength(1);
		expect(controls.canUndo).toBe(true);
		expect(controls.canRedo).toBe(false);
	});

	it('should clear future on new action after undo', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// Add two nodes
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n2'),
				role: { name: 'Reviewer', agentId: 'claude-code' },
			});
		});

		// Undo once
		act(() => {
			result.current[2].undo();
		});

		expect(result.current[2].canRedo).toBe(true);

		// New action should clear future
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n3'),
				role: { name: 'Editor', agentId: 'claude-code' },
			});
		});

		expect(result.current[2].canRedo).toBe(false);
	});

	it('should not push non-history actions onto the undo stack', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// SELECT_NODE should not affect history
		act(() => {
			result.current[1]({ type: 'SELECT_NODE', nodeId: 'n1' });
		});
		expect(result.current[2].canUndo).toBe(false);

		// SELECT_EDGE should not affect history
		act(() => {
			result.current[1]({ type: 'SELECT_EDGE', edgeId: 'e1' });
		});
		expect(result.current[2].canUndo).toBe(false);

		// PAN_VIEWPORT should not affect history
		act(() => {
			result.current[1]({ type: 'PAN_VIEWPORT', dx: 10, dy: 20 });
		});
		expect(result.current[2].canUndo).toBe(false);

		// ZOOM_VIEWPORT should not affect history
		act(() => {
			result.current[1]({ type: 'ZOOM_VIEWPORT', zoom: 1.5, centerX: 0, centerY: 0 });
		});
		expect(result.current[2].canUndo).toBe(false);

		// CLEAR_SELECTION should not affect history
		act(() => {
			result.current[1]({ type: 'CLEAR_SELECTION' });
		});
		expect(result.current[2].canUndo).toBe(false);

		// LOAD_STATE should not affect history (used for init)
		act(() => {
			result.current[1]({ type: 'LOAD_STATE', state: INITIAL_BUILDER_STATE });
		});
		expect(result.current[2].canUndo).toBe(false);
	});

	it('should preserve viewport on undo/redo', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// Add a node
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});

		// Change viewport (non-history action)
		act(() => {
			result.current[1]({ type: 'PAN_VIEWPORT', dx: 100, dy: 200 });
		});

		const vpBeforeUndo = result.current[0].viewport;

		// Undo the ADD_NODE
		act(() => {
			result.current[2].undo();
		});

		// Viewport should be preserved from before undo
		expect(result.current[0].viewport).toEqual(vpBeforeUndo);
	});

	it('should clear selection on undo/redo', () => {
		const { result } = renderHook(() => useBuilderHistory());

		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1'),
				role: { name: 'Writer', agentId: 'claude-code' },
			});
		});

		// ADD_NODE auto-selects the node
		expect(result.current[0].selectedNodeId).toBe('n1');

		act(() => {
			result.current[2].undo();
		});

		expect(result.current[0].selectedNodeId).toBeNull();
		expect(result.current[0].selectedEdgeId).toBeNull();
	});

	it('should cap history at 50 entries', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// Add 55 nodes (each pushes to history)
		for (let i = 0; i < 55; i++) {
			act(() => {
				result.current[1]({
					type: 'ADD_NODE',
					node: makeNode(`n${i}`),
					role: { name: `Role${i}`, agentId: 'claude-code' },
				});
			});
		}

		// Undo all 50 times (the limit)
		let undoCount = 0;
		while (result.current[2].canUndo) {
			act(() => {
				result.current[2].undo();
			});
			undoCount++;
		}

		// Should have been able to undo exactly 50 times
		expect(undoCount).toBe(50);
	});

	it('should be a no-op when undoing with empty past', () => {
		const { result } = renderHook(() => useBuilderHistory());
		const stateBefore = result.current[0];

		act(() => {
			result.current[2].undo();
		});

		expect(result.current[0]).toBe(stateBefore);
	});

	it('should be a no-op when redoing with empty future', () => {
		const { result } = renderHook(() => useBuilderHistory());
		const stateBefore = result.current[0];

		act(() => {
			result.current[2].redo();
		});

		expect(result.current[0]).toBe(stateBefore);
	});

	it('should handle multiple undo/redo cycles', () => {
		const { result } = renderHook(() => useBuilderHistory());

		// Add 3 nodes
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n1', 'entry'),
				role: { name: 'Entry', agentId: 'claude-code' },
			});
		});
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n2'),
				role: { name: 'Worker', agentId: 'claude-code' },
			});
		});
		act(() => {
			result.current[1]({
				type: 'ADD_NODE',
				node: makeNode('n3', 'exit'),
				role: { name: 'Exit', agentId: 'claude-code' },
			});
		});

		expect(result.current[0].nodes).toHaveLength(3);

		// Undo all 3
		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].nodes).toHaveLength(2);

		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].nodes).toHaveLength(1);

		act(() => {
			result.current[2].undo();
		});
		expect(result.current[0].nodes).toHaveLength(0);

		// Redo all 3
		act(() => {
			result.current[2].redo();
		});
		expect(result.current[0].nodes).toHaveLength(1);

		act(() => {
			result.current[2].redo();
		});
		expect(result.current[0].nodes).toHaveLength(2);

		act(() => {
			result.current[2].redo();
		});
		expect(result.current[0].nodes).toHaveLength(3);
	});
});
