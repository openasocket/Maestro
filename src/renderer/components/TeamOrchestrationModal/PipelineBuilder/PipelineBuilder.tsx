/**
 * PipelineBuilder — Main component composing Canvas + Palette + Inspector.
 *
 * Manages builder state via useReducer. Provides:
 * - Left palette for dragging new nodes onto the canvas
 * - Center SVG canvas with pan/zoom/grid
 * - Top toolbar for template name/description and save/cancel
 * - Right inspector panel for selected node/edge properties
 */

import { useReducer, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import type { Theme } from '../../../types';
import type { TeamTemplate, TeamTemplateRole } from '../../../../shared/group-chat-types';
import type { BuilderNode, BuilderEdge } from './builderTypes';
import { builderReducer, INITIAL_BUILDER_STATE } from './builderReducer';
import { templateToBuilderState, builderStateToTemplate } from './builderSerializer';
import { BuilderCanvas } from './BuilderCanvas';
import { BuilderPalette } from './BuilderPalette';
import type { PresetType } from './BuilderPalette';
import { BuilderInspector } from './BuilderInspector';
import {
	createPipelinePreset,
	createParallelMergePreset,
	createReviewLoopPreset,
	createHubSpokePreset,
} from './builderPresets';

interface PipelineBuilderProps {
	template?: TeamTemplate;
	onSave: (template: TeamTemplate) => void;
	onCancel: () => void;
	theme: Theme;
}

export function PipelineBuilder({
	template,
	onSave,
	onCancel,
	theme,
}: PipelineBuilderProps): JSX.Element {
	const [state, dispatch] = useReducer(builderReducer, INITIAL_BUILDER_STATE);
	const initializedRef = useRef(false);
	const [saving, setSaving] = useState(false);

	// Initialize state from template (or blank)
	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;

		if (template) {
			const loaded = templateToBuilderState(template);
			dispatch({ type: 'LOAD_STATE', state: loaded });
		} else {
			dispatch({
				type: 'SET_TEMPLATE_META',
				meta: { name: 'New Template', description: '', category: 'user' },
			});
		}
	}, [template]);

	// Save handler
	const handleSave = useCallback(() => {
		if (!state.templateMeta.name.trim()) return;
		setSaving(true);
		try {
			const result = builderStateToTemplate(state, template?.id);
			onSave(result);
		} finally {
			setSaving(false);
		}
	}, [state, template, onSave]);

	// Cancel with dirty check
	const handleCancel = useCallback(() => {
		if (state.dirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard and close the builder?');
			if (!confirmed) return;
		}
		onCancel();
	}, [state.dirty, onCancel]);

	// Load a preset pattern onto the canvas
	const handleLoadPreset = useCallback(
		(presetType: PresetType) => {
			const generators: Record<
				PresetType,
				() => {
					nodes: BuilderNode[];
					edges: BuilderEdge[];
					roles: Record<string, TeamTemplateRole>;
				}
			> = {
				pipeline: createPipelinePreset,
				'parallel-merge': createParallelMergePreset,
				'review-loop': createReviewLoopPreset,
				'hub-spoke': createHubSpokePreset,
			};
			const generator = generators[presetType];
			if (!generator) return;
			const preset = generator();
			dispatch({ type: 'LOAD_PRESET', ...preset });
		},
		[dispatch]
	);

	// Selected node/edge info
	const selectedNode = useMemo(
		() => state.nodes.find((n) => n.id === state.selectedNodeId) ?? null,
		[state.nodes, state.selectedNodeId]
	);
	const selectedEdge = useMemo(
		() => state.edges.find((e) => e.id === state.selectedEdgeId) ?? null,
		[state.edges, state.selectedEdgeId]
	);
	const selectedRole = selectedNode ? (state.roles[selectedNode.roleId] ?? null) : null;

	const canSave = state.templateMeta.name.trim().length > 0 && state.nodes.length > 0;

	return (
		<div className="flex flex-col w-full h-full" style={{ backgroundColor: theme.colors.bgMain }}>
			{/* Top toolbar */}
			<div
				className="flex items-center gap-3 px-4 py-2 border-b flex-shrink-0"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<input
					type="text"
					value={state.templateMeta.name}
					onChange={(e) => dispatch({ type: 'SET_TEMPLATE_META', meta: { name: e.target.value } })}
					placeholder="Template name"
					className="flex-1 px-2 py-1 text-sm font-semibold rounded border outline-none"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
						maxWidth: 300,
					}}
				/>
				<input
					type="text"
					value={state.templateMeta.description}
					onChange={(e) =>
						dispatch({
							type: 'SET_TEMPLATE_META',
							meta: { description: e.target.value },
						})
					}
					placeholder="Description"
					className="flex-1 px-2 py-1 text-xs rounded border outline-none"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>
				<div className="flex items-center gap-2 flex-shrink-0">
					<button
						onClick={handleCancel}
						className="flex items-center gap-1 px-3 py-1.5 rounded text-xs transition-colors hover:opacity-80"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						<X className="w-3.5 h-3.5" />
						Cancel
					</button>
					<button
						onClick={handleSave}
						disabled={!canSave || saving}
						className="flex items-center gap-1 px-3 py-1.5 rounded text-xs font-medium transition-colors"
						style={{
							backgroundColor: canSave && !saving ? theme.colors.accent : theme.colors.border,
							color: '#fff',
							opacity: canSave && !saving ? 1 : 0.5,
						}}
					>
						<Save className="w-3.5 h-3.5" />
						{saving ? 'Saving...' : 'Save Template'}
					</button>
				</div>
			</div>

			{/* Main area: palette + canvas + inspector */}
			<div className="flex flex-1 min-h-0">
				{/* Left palette */}
				<BuilderPalette state={state} theme={theme} onLoadPreset={handleLoadPreset} />

				{/* Canvas */}
				<div className="flex-1 min-w-0 relative">
					<BuilderCanvas state={state} dispatch={dispatch} theme={theme} />

					{/* Zoom indicator */}
					<div
						className="absolute bottom-3 right-3 px-2 py-1 rounded text-[10px] font-mono"
						style={{
							backgroundColor: `${theme.colors.bgSidebar}cc`,
							color: theme.colors.textDim,
						}}
					>
						{Math.round(state.viewport.zoom * 100)}%
					</div>

					{/* Empty state hint */}
					{state.nodes.length === 0 && (
						<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
							<div
								className="text-center px-6 py-4 rounded-lg"
								style={{
									backgroundColor: `${theme.colors.bgSidebar}cc`,
									color: theme.colors.textDim,
								}}
							>
								<p className="text-sm font-medium mb-1">Drag nodes from the palette</p>
								<p className="text-xs">or use a Quick Start Pattern to get started</p>
							</div>
						</div>
					)}
				</div>

				{/* Right inspector — always visible */}
				<BuilderInspector
					state={state}
					dispatch={dispatch}
					theme={theme}
					selectedNode={selectedNode}
					selectedEdge={selectedEdge}
					selectedRole={selectedRole}
				/>
			</div>
		</div>
	);
}
