/**
 * Tests for BuilderEdgeComponent — edge rendering, selection, deletion, and type labels.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { BuilderEdgeComponent } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/BuilderEdgeComponent';
import type {
	BuilderNode,
	BuilderEdge,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import type { Theme } from '../../../../shared/theme-types';

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

function makeNode(id: string, x = 0, y = 0): BuilderNode {
	return { id, roleId: id, x, y, width: 160, height: 60, type: 'role' };
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

/** Render the edge inside an SVG so SVG elements work correctly */
function renderEdge(
	edge: BuilderEdge,
	sourceNode: BuilderNode,
	targetNode: BuilderNode,
	selected = false,
	dispatch = vi.fn()
) {
	const theme = createMockTheme();
	return render(
		<svg>
			<BuilderEdgeComponent
				edge={edge}
				sourceNode={sourceNode}
				targetNode={targetNode}
				theme={theme}
				selected={selected}
				dispatch={dispatch}
			/>
		</svg>
	);
}

// ============================================================================
// Tests
// ============================================================================

describe('BuilderEdgeComponent', () => {
	it('renders an SVG path for a sequential edge', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'sequential');

		const { container } = renderEdge(edge, source, target);

		// Should have visible path + transparent hit area path
		const paths = container.querySelectorAll('path');
		expect(paths.length).toBeGreaterThanOrEqual(2);

		// The visible path should not be dashed (sequential = solid)
		const visiblePath = paths[1];
		expect(visiblePath.getAttribute('stroke-dasharray')).toBeNull();
	});

	it('renders a dashed path for a conditional edge', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'conditional');

		const { container } = renderEdge(edge, source, target);

		const paths = container.querySelectorAll('path');
		const visiblePath = paths[1];
		expect(visiblePath.getAttribute('stroke-dasharray')).toBe('6 3');
	});

	it('renders "||" label for parallel edges', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'parallel');

		const { container } = renderEdge(edge, source, target);

		const texts = container.querySelectorAll('text');
		const parallelLabel = Array.from(texts).find((t) => t.textContent === '||');
		expect(parallelLabel).toBeTruthy();
	});

	it('renders "?" diamond for conditional edges', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'conditional');

		const { container } = renderEdge(edge, source, target);

		// Should have a polygon (diamond shape) and "?" text
		const polygons = container.querySelectorAll('polygon');
		expect(polygons.length).toBe(1);

		const texts = container.querySelectorAll('text');
		const condLabel = Array.from(texts).find((t) => t.textContent === '?');
		expect(condLabel).toBeTruthy();
	});

	it('does not render parallel or conditional labels for sequential edges', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'sequential');

		const { container } = renderEdge(edge, source, target);

		const polygons = container.querySelectorAll('polygon');
		expect(polygons.length).toBe(0);

		const texts = container.querySelectorAll('text');
		expect(texts.length).toBe(0);
	});

	it('renders condition text when edge has a condition', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'conditional', 'approval == true');

		const { container } = renderEdge(edge, source, target);

		const texts = container.querySelectorAll('text');
		const condText = Array.from(texts).find((t) => t.textContent === 'approval == true');
		expect(condText).toBeTruthy();
	});

	it('dispatches SELECT_EDGE on click', () => {
		const dispatch = vi.fn();
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b');

		const { container } = renderEdge(edge, source, target, false, dispatch);

		// Click the group element (find by data-edge-id)
		const group = container.querySelector('[data-edge-id="e1"]');
		expect(group).toBeTruthy();
		fireEvent.click(group!);

		expect(dispatch).toHaveBeenCalledWith({
			type: 'SELECT_EDGE',
			edgeId: 'e1',
		});
	});

	it('renders glow path when selected', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b', 'sequential');

		const { container } = renderEdge(edge, source, target, true);

		// Selected edges have 3 paths: hit area, visible, and glow
		const paths = container.querySelectorAll('path');
		expect(paths.length).toBe(3);

		// Glow path should have low opacity
		const glowPath = paths[2];
		expect(glowPath.getAttribute('opacity')).toBe('0.15');
	});

	it('shows delete button on hover and dispatches DELETE_EDGE', () => {
		const dispatch = vi.fn();
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);
		const edge = makeEdge('e1', 'a', 'b');

		const { container } = renderEdge(edge, source, target, false, dispatch);

		const group = container.querySelector('[data-edge-id="e1"]');
		expect(group).toBeTruthy();

		// No delete button before hover
		let circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(0);

		// Hover to show delete button
		fireEvent.mouseEnter(group!);
		circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(1);

		// Click the delete button (which is in a nested <g>)
		const deleteGroup = circles[0].parentElement;
		fireEvent.click(deleteGroup!);

		expect(dispatch).toHaveBeenCalledWith({
			type: 'DELETE_EDGE',
			edgeId: 'e1',
		});

		// Mouse leave should hide the button
		fireEvent.mouseLeave(group!);
		circles = container.querySelectorAll('circle');
		expect(circles.length).toBe(0);
	});

	it('sets data-edge-id attribute on the group element', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 100);
		const edge = makeEdge('edge-xyz', 'a', 'b');

		const { container } = renderEdge(edge, source, target);

		const group = container.querySelector('[data-edge-id="edge-xyz"]');
		expect(group).toBeTruthy();
	});

	it('uses correct marker reference for edge type', () => {
		const source = makeNode('a', 0, 0);
		const target = makeNode('b', 300, 0);

		for (const edgeType of ['sequential', 'parallel', 'conditional'] as const) {
			const edge = makeEdge(`e-${edgeType}`, 'a', 'b', edgeType);
			const { container } = renderEdge(edge, source, target);

			const paths = container.querySelectorAll('path');
			const visiblePath = paths[1];
			expect(visiblePath.getAttribute('marker-end')).toBe(`url(#builder-arrow-${edgeType})`);
		}
	});
});
