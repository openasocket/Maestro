/**
 * Tests for builderReducer — LOAD_PRESET action.
 */

import { describe, it, expect } from 'vitest';
import {
	builderReducer,
	INITIAL_BUILDER_STATE,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderReducer';
import type { BuilderState } from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	NODE_WIDTH,
	NODE_HEIGHT,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderTypes';
import {
	createPipelinePreset,
	createParallelMergePreset,
	createReviewLoopPreset,
	createHubSpokePreset,
} from '../../../../renderer/components/TeamOrchestrationModal/PipelineBuilder/builderPresets';

// ============================================================================
// LOAD_PRESET
// ============================================================================

describe('builderReducer — LOAD_PRESET', () => {
	it('should replace nodes, edges, and roles with preset data', () => {
		const preset = createPipelinePreset();
		const result = builderReducer(INITIAL_BUILDER_STATE, {
			type: 'LOAD_PRESET',
			...preset,
		});

		expect(result.nodes).toBe(preset.nodes);
		expect(result.edges).toBe(preset.edges);
		expect(result.roles).toBe(preset.roles);
	});

	it('should reset selectedNodeId and selectedEdgeId to null', () => {
		const stateWithSelection: BuilderState = {
			...INITIAL_BUILDER_STATE,
			nodes: [
				{
					id: 'n1',
					roleId: 'r1',
					x: 0,
					y: 0,
					width: NODE_WIDTH,
					height: NODE_HEIGHT,
					type: 'role',
				},
			],
			selectedNodeId: 'n1',
			selectedEdgeId: 'e1',
		};

		const preset = createPipelinePreset();
		const result = builderReducer(stateWithSelection, {
			type: 'LOAD_PRESET',
			...preset,
		});

		expect(result.selectedNodeId).toBeNull();
		expect(result.selectedEdgeId).toBeNull();
	});

	it('should keep existing templateMeta', () => {
		const stateWithMeta: BuilderState = {
			...INITIAL_BUILDER_STATE,
			templateMeta: { name: 'My Custom Template', description: 'A description', category: 'user' },
		};

		const preset = createPipelinePreset();
		const result = builderReducer(stateWithMeta, {
			type: 'LOAD_PRESET',
			...preset,
		});

		expect(result.templateMeta.name).toBe('My Custom Template');
		expect(result.templateMeta.description).toBe('A description');
		expect(result.templateMeta.category).toBe('user');
	});

	it('should reset viewport to default', () => {
		const stateWithViewport: BuilderState = {
			...INITIAL_BUILDER_STATE,
			viewport: { x: 100, y: -50, zoom: 2.5 },
		};

		const preset = createReviewLoopPreset();
		const result = builderReducer(stateWithViewport, {
			type: 'LOAD_PRESET',
			...preset,
		});

		expect(result.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
	});

	it('should mark state as dirty', () => {
		const preset = createHubSpokePreset();
		const result = builderReducer(INITIAL_BUILDER_STATE, {
			type: 'LOAD_PRESET',
			...preset,
		});

		expect(result.dirty).toBe(true);
	});

	it('should work with each preset type', () => {
		const presets = [
			createPipelinePreset(),
			createParallelMergePreset(),
			createReviewLoopPreset(),
			createHubSpokePreset(),
		];

		for (const preset of presets) {
			const result = builderReducer(INITIAL_BUILDER_STATE, {
				type: 'LOAD_PRESET',
				...preset,
			});

			expect(result.nodes.length).toBeGreaterThan(0);
			expect(result.edges.length).toBeGreaterThan(0);
			expect(Object.keys(result.roles).length).toBeGreaterThan(0);
		}
	});

	it('should fully replace previous canvas content', () => {
		// Start with hub-spoke loaded
		const hubSpoke = createHubSpokePreset();
		const withHubSpoke = builderReducer(INITIAL_BUILDER_STATE, {
			type: 'LOAD_PRESET',
			...hubSpoke,
		});

		// Load pipeline preset over it
		const pipeline = createPipelinePreset();
		const result = builderReducer(withHubSpoke, {
			type: 'LOAD_PRESET',
			...pipeline,
		});

		// Should have pipeline nodes, not hub-spoke
		expect(result.nodes).toBe(pipeline.nodes);
		expect(result.edges).toBe(pipeline.edges);
		expect(result.nodes.length).toBe(pipeline.nodes.length);
	});
});
