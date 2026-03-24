/**
 * PipelineBuilder — Main component composing Toolbar + Canvas + Palette + Inspector.
 *
 * Manages builder state via useReducer. Provides:
 * - Top toolbar with back/name, undo/redo, zoom, preview, save
 * - Left palette for dragging new nodes onto the canvas
 * - Center SVG canvas with pan/zoom/grid (or WorkflowGraph preview)
 * - Right inspector panel for selected node/edge properties
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../../types';
import type {
	TeamTemplate,
	TeamTemplateRole,
	GroupChatParticipant,
} from '../../../../shared/group-chat-types';
import type { BuilderNode, BuilderEdge } from './builderTypes';
import { NODE_WIDTH, NODE_HEIGHT } from './builderTypes';
import { INITIAL_BUILDER_STATE } from './builderReducer';
import {
	templateToBuilderState,
	builderStateToTemplate,
	autoLayoutNodes,
} from './builderSerializer';
import { useBuilderHistory } from './useBuilderHistory';
import { BuilderCanvas } from './BuilderCanvas';
import { BuilderPalette } from './BuilderPalette';
import type { PresetType } from './BuilderPalette';
import { BuilderInspector } from './BuilderInspector';
import { BuilderToolbar } from './BuilderToolbar';
import { WorkflowGraph } from '../../GroupChat/WorkflowGraph';
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

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.0;

export function PipelineBuilder({
	template,
	onSave,
	onCancel,
	theme,
}: PipelineBuilderProps): JSX.Element {
	const [state, dispatch, history] = useBuilderHistory();
	const initializedRef = useRef(false);
	const [saving, setSaving] = useState(false);
	const [showPreview, setShowPreview] = useState(false);
	const canvasContainerRef = useRef<HTMLDivElement>(null);

	// Initialize state from template (or blank)
	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;

		if (template) {
			const loaded = templateToBuilderState(template);
			dispatch({ type: 'LOAD_STATE', state: loaded });
		} else {
			// Use LOAD_STATE for initialization so it doesn't push onto undo history
			dispatch({
				type: 'LOAD_STATE',
				state: {
					...INITIAL_BUILDER_STATE,
					templateMeta: { name: 'New Template', description: '', category: 'user' },
				},
			});
		}
	}, [template]);

	// Save handler
	const handleSave = useCallback(() => {
		if (!state.templateMeta.name.trim()) return;
		if (state.nodes.length === 0) return;
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
		if (history.isDirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard and close the builder?');
			if (!confirmed) return;
		}
		onCancel();
	}, [history.isDirty, onCancel]);

	// Template name change
	const handleNameChange = useCallback(
		(name: string) => {
			dispatch({ type: 'SET_TEMPLATE_META', meta: { name } });
		},
		[dispatch]
	);

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

	// Auto-layout
	const handleAutoLayout = useCallback(() => {
		if (state.nodes.length === 0) return;
		const layouted = autoLayoutNodes(state.nodes, state.edges);
		dispatch({ type: 'LAYOUT_NODES', nodes: layouted });
	}, [state.nodes, state.edges]);

	// Zoom controls
	const handleZoomIn = useCallback(() => {
		const newZoom = Math.min(MAX_ZOOM, state.viewport.zoom + ZOOM_STEP);
		const rect = canvasContainerRef.current?.getBoundingClientRect();
		const cx = rect ? rect.width / 2 : 400;
		const cy = rect ? rect.height / 2 : 300;
		dispatch({ type: 'ZOOM_VIEWPORT', zoom: newZoom, centerX: cx, centerY: cy });
	}, [state.viewport.zoom]);

	const handleZoomOut = useCallback(() => {
		const newZoom = Math.max(MIN_ZOOM, state.viewport.zoom - ZOOM_STEP);
		const rect = canvasContainerRef.current?.getBoundingClientRect();
		const cx = rect ? rect.width / 2 : 400;
		const cy = rect ? rect.height / 2 : 300;
		dispatch({ type: 'ZOOM_VIEWPORT', zoom: newZoom, centerX: cx, centerY: cy });
	}, [state.viewport.zoom]);

	const handleFitToView = useCallback(() => {
		if (state.nodes.length === 0) return;
		const rect = canvasContainerRef.current?.getBoundingClientRect();
		if (!rect) return;

		// Compute bounding box of all nodes
		let minX = Infinity,
			minY = Infinity,
			maxX = -Infinity,
			maxY = -Infinity;
		for (const n of state.nodes) {
			minX = Math.min(minX, n.x);
			minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + (n.width || NODE_WIDTH));
			maxY = Math.max(maxY, n.y + (n.height || NODE_HEIGHT));
		}

		const padding = 60;
		const graphW = maxX - minX + padding * 2;
		const graphH = maxY - minY + padding * 2;
		const scaleX = rect.width / graphW;
		const scaleY = rect.height / graphH;
		const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

		// Center the graph in the viewport
		const vpX = (rect.width - graphW * zoom) / 2 - (minX - padding) * zoom;
		const vpY = (rect.height - graphH * zoom) / 2 - (minY - padding) * zoom;

		dispatch({ type: 'ZOOM_VIEWPORT', zoom, centerX: 0, centerY: 0 });
		// Override with exact pan position after zoom
		dispatch({ type: 'LOAD_STATE', state: { ...state, viewport: { x: vpX, y: vpY, zoom } } });
	}, [state]);

	// Preview toggle
	const handleTogglePreview = useCallback(() => {
		setShowPreview((prev) => !prev);
	}, []);

	// Keyboard shortcuts: Undo, Redo, Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;

			// Cmd/Ctrl+Shift+Z → Redo
			if (mod && e.shiftKey && e.key === 'z') {
				e.preventDefault();
				history.redo();
				return;
			}

			// Cmd/Ctrl+Z → Undo
			if (mod && e.key === 'z') {
				e.preventDefault();
				history.undo();
				return;
			}

			// Escape → deselect all
			if (e.key === 'Escape') {
				dispatch({ type: 'CLEAR_SELECTION' });
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [history, dispatch]);

	// Build preview data from current state
	const previewData = useMemo(() => {
		if (!showPreview || state.nodes.length === 0) return null;
		const tpl = builderStateToTemplate(state, template?.id);
		if (!tpl.topology) return null;
		const participants: GroupChatParticipant[] = tpl.roles.map((r) => ({
			name: r.name,
			agentId: r.agentId,
			sessionId: `preview-${r.name}`,
			addedAt: Date.now(),
		}));
		return { topology: tpl.topology, participants };
	}, [showPreview, state, template?.id]);

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
			<BuilderToolbar
				theme={theme}
				templateName={state.templateMeta.name}
				onNameChange={handleNameChange}
				onCancel={handleCancel}
				onSave={handleSave}
				canSave={canSave}
				saving={saving}
				canUndo={history.canUndo}
				canRedo={history.canRedo}
				onUndo={history.undo}
				onRedo={history.redo}
				onAutoLayout={handleAutoLayout}
				zoom={state.viewport.zoom}
				onZoomIn={handleZoomIn}
				onZoomOut={handleZoomOut}
				onFitToView={handleFitToView}
				showPreview={showPreview}
				onTogglePreview={handleTogglePreview}
				hasNodes={state.nodes.length > 0}
			/>

			{/* Main area: palette + canvas + inspector */}
			<div className="flex flex-1 min-h-0">
				{/* Left palette */}
				<BuilderPalette state={state} theme={theme} onLoadPreset={handleLoadPreset} />

				{/* Canvas or Preview */}
				<div className="flex-1 min-w-0 relative" ref={canvasContainerRef}>
					{showPreview && previewData ? (
						<div
							className="absolute inset-0 overflow-auto p-6"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							<div
								className="rounded-lg border p-4"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgSidebar,
								}}
							>
								<p
									className="text-xs font-medium mb-3 uppercase tracking-wider"
									style={{ color: theme.colors.textDim }}
								>
									Template Preview
								</p>
								<WorkflowGraph
									topology={previewData.topology}
									participants={previewData.participants}
									theme={theme}
								/>
							</div>
						</div>
					) : (
						<>
							<BuilderCanvas state={state} dispatch={dispatch} theme={theme} />

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
						</>
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
