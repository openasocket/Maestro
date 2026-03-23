/**
 * Tests for BuilderNodeComponent validation highlighting — orphaned and warning states.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { BuilderNodeComponent } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/BuilderNodeComponent';
import type { BuilderNode } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
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

function makeNode(id: string, x = 0, y = 0, type: BuilderNode['type'] = 'role'): BuilderNode {
	return { id, roleId: id, x, y, width: 160, height: 60, type };
}

function renderNode(
	node: BuilderNode,
	options: { selected?: boolean; isOrphaned?: boolean; hasWarning?: boolean } = {}
) {
	const theme = createMockTheme();
	return render(
		<svg>
			<BuilderNodeComponent
				node={node}
				roleName="Test Role"
				theme={theme}
				selected={options.selected ?? false}
				isOrphaned={options.isOrphaned ?? false}
				hasWarning={options.hasWarning ?? false}
				dispatch={vi.fn()}
				viewportZoom={1}
			/>
		</svg>
	);
}

describe('BuilderNodeComponent validation', () => {
	it('renders dashed border when orphaned', () => {
		const node = makeNode('n1');
		const { container } = renderNode(node, { isOrphaned: true });

		const rects = container.querySelectorAll('rect');
		// Node body rect (first rect, or second if selected)
		const bodyRect = rects[0];
		expect(bodyRect.getAttribute('stroke-dasharray')).toBe('6 3');
	});

	it('uses error color for stroke when orphaned', () => {
		const theme = createMockTheme();
		const node = makeNode('n1');
		const { container } = renderNode(node, { isOrphaned: true });

		const rects = container.querySelectorAll('rect');
		const bodyRect = rects[0];
		expect(bodyRect.getAttribute('stroke')).toBe(theme.colors.error);
	});

	it('does not render dashed border when not orphaned', () => {
		const node = makeNode('n1');
		const { container } = renderNode(node, { isOrphaned: false });

		const rects = container.querySelectorAll('rect');
		const bodyRect = rects[0];
		expect(bodyRect.getAttribute('stroke-dasharray')).toBeNull();
	});

	it('renders warning triangle icon when hasWarning is true', () => {
		const node = makeNode('n1');
		const { container } = renderNode(node, { hasWarning: true });

		const polygons = container.querySelectorAll('polygon');
		expect(polygons.length).toBe(1);

		const texts = container.querySelectorAll('text');
		const warningText = Array.from(texts).find((t) => t.textContent === '!');
		expect(warningText).toBeTruthy();
	});

	it('does not render warning icon when hasWarning is false', () => {
		const node = makeNode('n1');
		const { container } = renderNode(node, { hasWarning: false });

		const polygons = container.querySelectorAll('polygon');
		expect(polygons.length).toBe(0);
	});

	it('can show both orphaned and warning states simultaneously', () => {
		const node = makeNode('n1');
		const { container } = renderNode(node, { isOrphaned: true, hasWarning: true });

		// Dashed border
		const rects = container.querySelectorAll('rect');
		expect(rects[0].getAttribute('stroke-dasharray')).toBe('6 3');

		// Warning icon
		const polygons = container.querySelectorAll('polygon');
		expect(polygons.length).toBe(1);
	});
});
