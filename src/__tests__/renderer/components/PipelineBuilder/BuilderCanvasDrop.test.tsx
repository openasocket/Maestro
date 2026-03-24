/**
 * Tests for BuilderCanvas drop handling — drag-over indicator and node creation on drop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { BuilderCanvas } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/BuilderCanvas';
import { INITIAL_BUILDER_STATE } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderReducer';
import {
	GRID_SIZE,
	NODE_WIDTH,
	NODE_HEIGHT,
	snapToGrid,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import type { Theme } from '../../../../shared/theme-types';

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

// Mock crypto.randomUUID for deterministic IDs
let uuidCounter = 0;
vi.mock('../../../../renderer/utils/ids', () => ({
	generateId: () => `test-uuid-${++uuidCounter}`,
}));

describe('BuilderCanvas drop handling', () => {
	const theme = createMockTheme();

	beforeEach(() => {
		uuidCounter = 0;
	});

	// ============================================================================
	// snapToGrid centering logic (pure function tests)
	// ============================================================================

	describe('drop position snapping', () => {
		it('snaps drop position to 20px grid after centering offset', () => {
			// Simulates: drop at canvas coord (250, 170), center on NODE_WIDTH/2, NODE_HEIGHT/2
			const rawX = 250;
			const rawY = 170;
			const snappedX = snapToGrid(rawX - NODE_WIDTH / 2);
			const snappedY = snapToGrid(rawY - NODE_HEIGHT / 2);

			// 250 - 80 = 170, nearest 20 = 180
			expect(snappedX).toBe(180);
			// 170 - 30 = 140, nearest 20 = 140
			expect(snappedY).toBe(140);
		});

		it('handles exact grid alignment', () => {
			const rawX = NODE_WIDTH / 2 + 100; // 80 + 100 = 180
			const rawY = NODE_HEIGHT / 2 + 60; // 30 + 60 = 90
			const snappedX = snapToGrid(rawX - NODE_WIDTH / 2);
			const snappedY = snapToGrid(rawY - NODE_HEIGHT / 2);

			expect(snappedX).toBe(100);
			expect(snappedY).toBe(60);
		});

		it('rounds to nearest grid line, not floor', () => {
			// 155 - 80 = 75, nearest 20 = 80 (rounds up from 75)
			const snappedX = snapToGrid(155 - NODE_WIDTH / 2);
			expect(snappedX).toBe(80);

			// 44 - 30 = 14, nearest 20 = 20 (rounds up from 14)
			const snappedY = snapToGrid(44 - NODE_HEIGHT / 2);
			expect(snappedY).toBe(20);
		});
	});

	// ============================================================================
	// Component drop integration
	// ============================================================================

	describe('onDrop dispatches ADD_NODE', () => {
		it('dispatches ADD_NODE with role type from palette data', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			// Mock getBoundingClientRect for coordinate calculation
			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			const dropData = JSON.stringify({
				nodeType: 'role',
				roleName: 'New Role',
				agentId: 'claude-code',
				description: 'A participant role',
			});

			fireEvent.drop(svg, {
				dataTransfer: {
					getData: () => dropData,
				},
				clientX: 300,
				clientY: 200,
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'ADD_NODE',
					node: expect.objectContaining({
						type: 'role',
						width: NODE_WIDTH,
						height: NODE_HEIGHT,
					}),
					role: expect.objectContaining({
						name: 'New Role',
						agentId: 'claude-code',
					}),
				})
			);
		});

		it('dispatches ADD_NODE with entry type when entry is dragged', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			const dropData = JSON.stringify({
				nodeType: 'entry',
				roleName: 'Entry Point',
				agentId: 'claude-code',
				description: 'Workflow start',
			});

			fireEvent.drop(svg, {
				dataTransfer: { getData: () => dropData },
				clientX: 400,
				clientY: 100,
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'ADD_NODE',
					node: expect.objectContaining({ type: 'entry' }),
					role: expect.objectContaining({ name: 'Entry Point' }),
				})
			);
		});

		it('dispatches ADD_NODE with exit type when exit is dragged', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			const dropData = JSON.stringify({
				nodeType: 'exit',
				roleName: 'Exit Point',
				agentId: 'claude-code',
				description: 'Workflow end',
			});

			fireEvent.drop(svg, {
				dataTransfer: { getData: () => dropData },
				clientX: 500,
				clientY: 400,
			});

			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'ADD_NODE',
					node: expect.objectContaining({ type: 'exit' }),
					role: expect.objectContaining({ name: 'Exit Point' }),
				})
			);
		});

		it('snaps drop coordinates to 20px grid', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			fireEvent.drop(svg, {
				dataTransfer: {
					getData: () =>
						JSON.stringify({
							nodeType: 'role',
							roleName: 'New Role',
							agentId: 'claude-code',
							description: '',
						}),
				},
				clientX: 300,
				clientY: 200,
			});

			const addNodeAction = dispatch.mock.calls[0]?.[0];
			expect(addNodeAction.type).toBe('ADD_NODE');
			// Node position must be grid-aligned (multiple of GRID_SIZE)
			// jsdom DragEvent may zero out clientX/clientY; the important thing is snapping works
			expect(addNodeAction.node.x).toBe(snapToGrid(addNodeAction.node.x));
			expect(addNodeAction.node.y).toBe(snapToGrid(addNodeAction.node.y));
			expect(addNodeAction.node.width).toBe(NODE_WIDTH);
			expect(addNodeAction.node.height).toBe(NODE_HEIGHT);
		});

		it('uses generateId for node and role IDs', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			fireEvent.drop(svg, {
				dataTransfer: {
					getData: () =>
						JSON.stringify({
							nodeType: 'role',
							roleName: 'R',
							agentId: 'claude-code',
							description: '',
						}),
				},
				clientX: 100,
				clientY: 100,
			});

			const addNodeAction = dispatch.mock.calls[0]?.[0];
			expect(addNodeAction.node.id).toMatch(/^test-uuid-/);
			expect(addNodeAction.node.roleId).toMatch(/^test-uuid-/);
		});

		it('ignores drop with empty dataTransfer', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			fireEvent.drop(svg, {
				dataTransfer: { getData: () => '' },
			});

			expect(dispatch).not.toHaveBeenCalled();
		});

		it('ignores drop with invalid JSON', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			fireEvent.drop(svg, {
				dataTransfer: { getData: () => 'not-json{{{' },
			});

			expect(dispatch).not.toHaveBeenCalled();
		});
	});

	// ============================================================================
	// DragOver indicator
	// ============================================================================

	describe('drag over indicator', () => {
		it('shows drop indicator rect on dragOver', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			// Initially no drop indicator rect (dashed)
			const indicatorsBefore = container.querySelectorAll('rect[stroke-dasharray]');
			const dashedBefore = Array.from(indicatorsBefore).filter(
				(r) => r.getAttribute('stroke-dasharray') === '6 3'
			);
			expect(dashedBefore.length).toBe(0);

			// Fire dragover
			fireEvent.dragOver(svg, {
				clientX: 300,
				clientY: 200,
			});

			// Now a dashed drop indicator should appear
			const indicatorsAfter = container.querySelectorAll('rect[stroke-dasharray]');
			const dashedAfter = Array.from(indicatorsAfter).filter(
				(r) => r.getAttribute('stroke-dasharray') === '6 3'
			);
			expect(dashedAfter.length).toBe(1);
		});

		it('clears drop indicator on dragLeave', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			// Show indicator
			fireEvent.dragOver(svg, { clientX: 300, clientY: 200 });
			let dashed = Array.from(container.querySelectorAll('rect[stroke-dasharray]')).filter(
				(r) => r.getAttribute('stroke-dasharray') === '6 3'
			);
			expect(dashed.length).toBe(1);

			// Clear on drag leave
			fireEvent.dragLeave(svg);
			dashed = Array.from(container.querySelectorAll('rect[stroke-dasharray]')).filter(
				(r) => r.getAttribute('stroke-dasharray') === '6 3'
			);
			expect(dashed.length).toBe(0);
		});

		it('clears drop indicator on drop', () => {
			const dispatch = vi.fn();
			const { container } = render(
				<BuilderCanvas state={INITIAL_BUILDER_STATE} dispatch={dispatch} theme={theme} />
			);
			const svg = container.querySelector('svg')!;

			svg.getBoundingClientRect = vi.fn(() => ({
				left: 0,
				top: 0,
				right: 800,
				bottom: 600,
				width: 800,
				height: 600,
				x: 0,
				y: 0,
				toJSON: () => {},
			}));

			// Show indicator
			fireEvent.dragOver(svg, { clientX: 300, clientY: 200 });

			// Drop clears it
			fireEvent.drop(svg, {
				dataTransfer: {
					getData: () =>
						JSON.stringify({
							nodeType: 'role',
							roleName: 'R',
							agentId: 'claude-code',
							description: '',
						}),
				},
				clientX: 300,
				clientY: 200,
			});

			const dashed = Array.from(container.querySelectorAll('rect[stroke-dasharray]')).filter(
				(r) => r.getAttribute('stroke-dasharray') === '6 3'
			);
			expect(dashed.length).toBe(0);
		});
	});
});
