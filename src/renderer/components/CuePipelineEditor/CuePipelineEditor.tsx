/**
 * CuePipelineEditor — React Flow-based visual pipeline editor for Maestro Cue.
 *
 * Thin shell that wires three hooks (usePipelineState, usePipelineSelection)
 * and three components (PipelineToolbar, PipelineCanvas, PipelineContextMenu).
 * Retains canvas-specific callbacks (onNodesChange, onConnect, onDrop, keyboard
 * shortcuts, context menu handlers) that are tightly coupled to ReactFlow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ReactFlowProvider,
	useReactFlow,
	applyNodeChanges,
	type Node,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import type { Theme } from '../../types';
import type {
	CueGraphSession,
	TriggerNodeData,
	AgentNodeData,
	TeamNodeData,
	CueEventType,
	PipelineNode,
	CuePipeline,
	CuePipelineTeamInfo,
} from '../../../shared/cue-pipeline-types';
import { getNextPipelineColor } from './pipelineColors';
import { convertToReactFlowNodes, convertToReactFlowEdges } from './utils/pipelineGraph';
import { usePipelineState, DEFAULT_TRIGGER_LABELS } from '../../hooks/cue/usePipelineState';
import type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';
import { usePipelineSelection } from '../../hooks/cue/usePipelineSelection';
import { PipelineToolbar } from './PipelineToolbar';
import { PipelineCanvas } from './PipelineCanvas';
import { PipelineContextMenu, type ContextMenuState } from './PipelineContextMenu';

export { validatePipelines, DEFAULT_TRIGGER_LABELS } from '../../hooks/cue/usePipelineState';
export type { SessionInfo, ActiveRunInfo } from '../../hooks/cue/usePipelineState';

export interface CuePipelineEditorProps {
	sessions: SessionInfo[];
	groups?: { id: string; name: string; emoji: string }[];
	graphSessions: CueGraphSession[];
	onSwitchToSession: (id: string) => void;
	onClose: () => void;
	onDirtyChange?: (isDirty: boolean) => void;
	theme: Theme;
	activeRuns?: ActiveRunInfo[];
	/** Callback to manually trigger a pipeline by name */
	onTriggerPipeline?: (pipelineName: string) => void;
	/** Bumped when Teams tab creates/edits/deletes a template — triggers team list re-fetch */
	teamTemplatesVersion?: number;
	/** Switch to the Teams tab, optionally pre-selecting a template for editing */
	onSwitchToTeamsTab?: (templateId?: string) => void;
}

/** Bridges the circular dependency between usePipelineState and usePipelineSelection. */
function useSelectionRef() {
	return useRef({
		selectedNodePipelineId: null as string | null,
		selectedEdgePipelineId: null as string | null,
		setSelectedNodeId: (() => {}) as React.Dispatch<React.SetStateAction<string | null>>,
		setSelectedEdgeId: (() => {}) as React.Dispatch<React.SetStateAction<string | null>>,
	});
}

function CuePipelineEditorInner({
	sessions,
	groups,
	graphSessions,
	onSwitchToSession,
	onDirtyChange,
	theme,
	activeRuns: activeRunsProp,
	onTriggerPipeline,
	teamTemplatesVersion,
	onSwitchToTeamsTab,
}: CuePipelineEditorProps) {
	const reactFlowInstance = useReactFlow();

	// Local drawer/context-menu state
	const [triggerDrawerOpen, setTriggerDrawerOpen] = useState(false);
	const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
	const [teamDrawerOpen, setTeamDrawerOpen] = useState(false);
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	// Team templates for the team drawer
	const [teams, setTeams] = useState<CuePipelineTeamInfo[]>([]);

	// Bridge ref: usePipelineState needs selection IDs, but usePipelineSelection
	// needs pipelineState. We use a ref so state hook reads latest selection values
	// without creating a hook ordering issue. On first render both are null (correct).
	const selectionRef = useSelectionRef();

	const stateHook = usePipelineState({
		sessions,
		graphSessions,
		activeRuns: activeRunsProp,
		onDirtyChange,
		reactFlowInstance,
		selectedNodePipelineId: selectionRef.current.selectedNodePipelineId,
		selectedEdgePipelineId: selectionRef.current.selectedEdgePipelineId,
		setSelectedNodeId: selectionRef.current.setSelectedNodeId,
		setSelectedEdgeId: selectionRef.current.setSelectedEdgeId,
		setTriggerDrawerOpen,
		setAgentDrawerOpen,
	});

	const selectionHook = usePipelineSelection({
		pipelineState: stateHook.pipelineState,
	});

	// Update ref so state hook gets fresh values on next render
	selectionRef.current = {
		selectedNodePipelineId: selectionHook.selectedNodePipelineId,
		selectedEdgePipelineId: selectionHook.selectedEdgePipelineId,
		setSelectedNodeId: selectionHook.setSelectedNodeId,
		setSelectedEdgeId: selectionHook.setSelectedEdgeId,
	};

	const {
		pipelineState,
		setPipelineState,
		isAllPipelinesView,
		isDirty,
		setIsDirty,
		saveStatus,
		validationErrors,
		cueSettings,
		setCueSettings,
		showSettings,
		setShowSettings,
		runningPipelineIds,
		persistLayout,
		handleSave,
		handleDiscard,
		createPipeline,
		deletePipeline,
		renamePipeline,
		selectPipeline,
		changePipelineColor,
		onUpdateNode,
		onUpdateEdgePrompt,
		onDeleteNode,
		onUpdateEdge,
		onDeleteEdge,
	} = stateHook;

	const {
		selectedNodeId,
		setSelectedNodeId,
		selectedEdgeId,
		setSelectedEdgeId,
		selectedNode,
		selectedNodePipelineId,
		selectedNodeHasOutgoingEdge,
		hasIncomingAgentEdges,
		incomingTriggerEdges,
		selectedEdge,
		selectedEdgePipelineId,
		selectedEdgePipelineColor,
		edgeSourceNode,
		edgeTargetNode,
		onCanvasSessionIds,
		onNodeClick,
		onEdgeClick,
		onPaneClick,
		handleConfigureNode,
	} = selectionHook;

	// ─── Fetch team templates on mount ──────────────────────────────────────

	useEffect(() => {
		window.maestro.teamTemplates.list().then((templates) => {
			setTeams(
				templates.map((t) => ({
					id: t.id,
					name: t.name,
					roleCount: t.roles.length,
					topologyPattern: t.topology?.pattern,
				}))
			);
		});
	}, [teamTemplatesVersion]);

	// Compute set of template IDs already on the canvas
	const onCanvasTemplateIds = useMemo(() => {
		const ids = new Set<string>();
		for (const pipeline of pipelineState.pipelines) {
			for (const node of pipeline.nodes) {
				if (node.type === 'team') {
					ids.add((node.data as TeamNodeData).templateId);
				}
			}
		}
		return ids;
	}, [pipelineState.pipelines]);

	// ─── ReactFlow nodes/edges ───────────────────────────────────────────────

	// Derive nodes from pipeline state. This is the "canonical" version.
	// During drag, ReactFlow's applyNodeChanges handles interim positions
	// so we don't cascade re-renders through pipelineState on every frame.
	const [nodes, setNodes] = useState<Node[]>([]);
	const isDraggingRef = useRef(false);

	// Sync nodes from pipeline state when it changes (but not during drag)
	useEffect(() => {
		if (isDraggingRef.current) return;
		setNodes(
			convertToReactFlowNodes(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				handleConfigureNode,
				{
					onTriggerPipeline,
					isSaved: !isDirty,
					runningPipelineIds,
				}
			)
		);
	}, [
		pipelineState.pipelines,
		pipelineState.selectedPipelineId,
		handleConfigureNode,
		onTriggerPipeline,
		isDirty,
		runningPipelineIds,
	]);

	const edges = useMemo(
		() =>
			convertToReactFlowEdges(
				pipelineState.pipelines,
				pipelineState.selectedPipelineId,
				runningPipelineIds,
				selectedEdgeId
			),
		[pipelineState.pipelines, pipelineState.selectedPipelineId, runningPipelineIds, selectedEdgeId]
	);

	// ─── Canvas callbacks ────────────────────────────────────────────────────

	const onNodesChange: OnNodesChange = useCallback(
		(changes) => {
			// Let ReactFlow handle all change types (position, dimensions, select, etc.)
			// during drag for smooth visual updates without cascading state re-renders.
			setNodes((nds) => applyNodeChanges(changes, nds));

			// Track drag state so we don't overwrite ReactFlow's interim positions
			const isDragging = changes.some((c) => c.type === 'position' && c.dragging);
			isDraggingRef.current = isDragging;

			// When drag ends, sync final positions back to pipeline state
			const finalPositions = new Map<string, { x: number; y: number }>();
			for (const change of changes) {
				if (change.type === 'position' && change.position && !change.dragging) {
					finalPositions.set(change.id, change.position);
				}
			}

			if (finalPositions.size > 0) {
				setPipelineState((prev) => {
					const newPipelines = prev.pipelines.map((pipeline) => ({
						...pipeline,
						nodes: pipeline.nodes.map((pNode) => {
							const newPos = finalPositions.get(`${pipeline.id}:${pNode.id}`);
							if (newPos) {
								return { ...pNode, position: newPos };
							}
							return pNode;
						}),
					}));
					return { ...prev, pipelines: newPipelines };
				});
				persistLayout();
			}
		},
		[persistLayout, setPipelineState]
	);

	const onEdgesChange: OnEdgesChange = useCallback(() => {}, []);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;

			const sourcePipelineId = connection.source.split(':')[0];
			const targetPipelineId = connection.target.split(':')[0];
			if (sourcePipelineId !== targetPipelineId) return;

			const sourceNodeId = connection.source.split(':').slice(1).join(':');
			const targetNodeId = connection.target.split(':').slice(1).join(':');

			setPipelineState((prev) => {
				const pipeline = prev.pipelines.find((p) => p.id === sourcePipelineId);
				if (!pipeline) return prev;

				const targetNode = pipeline.nodes.find((n) => n.id === targetNodeId);
				if (!targetNode || targetNode.type === 'trigger') return prev;

				const newEdge = {
					id: `edge-${Date.now()}`,
					source: sourceNodeId,
					target: targetNodeId,
					mode: 'pass' as const,
				};

				return {
					...prev,
					pipelines: prev.pipelines.map((p) => {
						if (p.id !== sourcePipelineId) return p;
						return { ...p, edges: [...p.edges, newEdge] };
					}),
				};
			});
		},
		[setPipelineState]
	);

	const isValidConnection = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return false;
			if (connection.source === connection.target) return false;

			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			if (!sourceNode || !targetNode) return false;

			if (sourceNode.type === 'trigger' && targetNode.type === 'trigger') return false;
			if (targetNode.type === 'trigger') return false;

			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return false;

			return true;
		},
		[nodes, edges]
	);

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const raw = event.dataTransfer.getData('application/cue-pipeline');
			if (!raw) return;

			let dropData: {
				type: string;
				eventType?: CueEventType;
				label?: string;
				sessionId?: string;
				sessionName?: string;
				toolType?: string;
				templateId?: string;
				templateName?: string;
				roleCount?: number;
				topologyPattern?: string;
			};
			try {
				dropData = JSON.parse(raw);
			} catch {
				return;
			}

			const position = reactFlowInstance.screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			});

			setPipelineState((prev) => {
				let targetPipeline: CuePipeline;
				let pipelines = prev.pipelines;
				const selectedId = prev.selectedPipelineId;

				if (selectedId) {
					const found = pipelines.find((p) => p.id === selectedId);
					if (found) {
						targetPipeline = found;
					} else {
						return prev;
					}
				} else if (pipelines.length > 0) {
					targetPipeline = pipelines[0];
				} else {
					targetPipeline = {
						id: `pipeline-${Date.now()}`,
						name: 'Pipeline 1',
						color: getNextPipelineColor([]),
						nodes: [],
						edges: [],
					};
					pipelines = [targetPipeline];
				}

				let newNode: PipelineNode;

				if (dropData.type === 'trigger' && dropData.eventType) {
					const triggerData: TriggerNodeData = {
						eventType: dropData.eventType,
						label:
							dropData.label ?? DEFAULT_TRIGGER_LABELS[dropData.eventType] ?? dropData.eventType,
						config: {},
					};
					newNode = {
						id: `trigger-${Date.now()}`,
						type: 'trigger',
						position,
						data: triggerData,
					};
				} else if (dropData.type === 'agent' && dropData.sessionId) {
					const agentData: AgentNodeData = {
						sessionId: dropData.sessionId,
						sessionName: dropData.sessionName ?? 'Agent',
						toolType: dropData.toolType ?? 'unknown',
					};
					newNode = {
						id: `agent-${dropData.sessionId}-${Date.now()}`,
						type: 'agent',
						position,
						data: agentData,
					};
				} else if (dropData.type === 'team' && dropData.templateId) {
					const teamData: TeamNodeData = {
						templateId: dropData.templateId,
						templateName: dropData.templateName ?? 'Team',
						roleCount: dropData.roleCount ?? 0,
						topologyPattern: dropData.topologyPattern,
						inputPrompt: '',
						outputPrompt: '',
					};
					newNode = {
						id: `team-${dropData.templateId}-${Date.now()}`,
						type: 'team',
						position,
						data: teamData,
					};
				} else {
					return prev;
				}

				const updatedPipelines = pipelines.map((p) => {
					if (p.id === targetPipeline.id) {
						return { ...p, nodes: [...p.nodes, newNode] };
					}
					return p;
				});

				if (!pipelines.some((p) => p.id === targetPipeline.id)) {
					targetPipeline.nodes.push(newNode);
					updatedPipelines.push(targetPipeline);
				}

				const compositeId = `${targetPipeline.id}:${newNode.id}`;
				setTimeout(() => {
					setSelectedNodeId(compositeId);
					setSelectedEdgeId(null);
				}, 50);

				return {
					pipelines: updatedPipelines,
					selectedPipelineId: prev.selectedPipelineId ?? targetPipeline.id,
				};
			});
		},
		[reactFlowInstance, setPipelineState, setSelectedNodeId, setSelectedEdgeId]
	);

	// ─── Keyboard shortcuts ──────────────────────────────────────────────────

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (isInput) return;
				if (selectedNode && selectedNodePipelineId) {
					e.preventDefault();
					onDeleteNode(selectedNode.id);
				} else if (selectedEdge && selectedEdgePipelineId) {
					e.preventDefault();
					onDeleteEdge(selectedEdge.id);
				}
			} else if (e.key === 'Escape') {
				if (triggerDrawerOpen) {
					setTriggerDrawerOpen(false);
				} else if (agentDrawerOpen) {
					setAgentDrawerOpen(false);
				} else if (teamDrawerOpen) {
					setTeamDrawerOpen(false);
				} else if (selectedNodeId || selectedEdgeId) {
					setSelectedNodeId(null);
					setSelectedEdgeId(null);
				}
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [
		selectedNode,
		selectedNodePipelineId,
		selectedEdge,
		selectedEdgePipelineId,
		selectedNodeId,
		selectedEdgeId,
		onDeleteNode,
		onDeleteEdge,
		triggerDrawerOpen,
		agentDrawerOpen,
		teamDrawerOpen,
		handleSave,
		setSelectedNodeId,
		setSelectedEdgeId,
	]);

	// ─── Context menu handlers ───────────────────────────────────────────────

	const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
		event.preventDefault();
		const sepIdx = node.id.indexOf(':');
		if (sepIdx === -1) return;
		const pipelineId = node.id.substring(0, sepIdx);
		const nodeId = node.id.substring(sepIdx + 1);
		setContextMenu({
			x: event.clientX,
			y: event.clientY,
			nodeId,
			pipelineId,
			nodeType: node.type as 'trigger' | 'agent' | 'team',
		});
	}, []);

	const handleContextMenuConfigure = useCallback(() => {
		if (!contextMenu) return;
		setSelectedNodeId(`${contextMenu.pipelineId}:${contextMenu.nodeId}`);
		setSelectedEdgeId(null);
		setContextMenu(null);
	}, [contextMenu, setSelectedNodeId, setSelectedEdgeId]);

	const handleContextMenuDelete = useCallback(() => {
		if (!contextMenu) return;
		setPipelineState((prev) => ({
			...prev,
			pipelines: prev.pipelines.map((p) => {
				if (p.id !== contextMenu.pipelineId) return p;
				return {
					...p,
					nodes: p.nodes.filter((n) => n.id !== contextMenu.nodeId),
					edges: p.edges.filter(
						(e) => e.source !== contextMenu.nodeId && e.target !== contextMenu.nodeId
					),
				};
			}),
		}));
		setSelectedNodeId(null);
		setContextMenu(null);
	}, [contextMenu, setPipelineState, setSelectedNodeId]);

	const handleContextMenuDuplicate = useCallback(() => {
		if (!contextMenu || contextMenu.nodeType !== 'trigger') return;
		setPipelineState((prev) => {
			const pipeline = prev.pipelines.find((p) => p.id === contextMenu.pipelineId);
			if (!pipeline) return prev;
			const original = pipeline.nodes.find((n) => n.id === contextMenu.nodeId);
			if (!original || original.type !== 'trigger') return prev;
			const newNode: PipelineNode = {
				id: `trigger-${Date.now()}`,
				type: 'trigger',
				position: { x: original.position.x + 50, y: original.position.y + 50 },
				data: { ...(original.data as TriggerNodeData) },
			};
			return {
				...prev,
				pipelines: prev.pipelines.map((p) => {
					if (p.id !== contextMenu.pipelineId) return p;
					return { ...p, nodes: [...p.nodes, newNode] };
				}),
			};
		});
		setContextMenu(null);
	}, [contextMenu, setPipelineState]);

	// ─── Render ──────────────────────────────────────────────────────────────

	return (
		<div
			style={{
				flex: 1,
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				overflow: 'hidden',
			}}
		>
			<PipelineToolbar
				theme={theme}
				isAllPipelinesView={isAllPipelinesView}
				triggerDrawerOpen={triggerDrawerOpen}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				agentDrawerOpen={agentDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
				teamDrawerOpen={teamDrawerOpen}
				onToggleTeamDrawer={() => !isAllPipelinesView && setTeamDrawerOpen((v) => !v)}
				showSettings={showSettings}
				setShowSettings={setShowSettings}
				pipelines={pipelineState.pipelines}
				selectedPipelineId={pipelineState.selectedPipelineId}
				selectPipeline={selectPipeline}
				createPipeline={createPipeline}
				deletePipeline={deletePipeline}
				renamePipeline={renamePipeline}
				changePipelineColor={changePipelineColor}
				isDirty={isDirty}
				saveStatus={saveStatus}
				handleSave={handleSave}
				handleDiscard={handleDiscard}
				validationErrors={validationErrors}
			/>

			<PipelineCanvas
				theme={theme}
				nodes={nodes}
				edges={edges}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				isValidConnection={isValidConnection}
				onNodeClick={onNodeClick}
				onEdgeClick={onEdgeClick}
				onPaneClick={onPaneClick}
				onNodeContextMenu={onNodeContextMenu}
				onDragOver={onDragOver}
				onDrop={onDrop}
				triggerDrawerOpen={triggerDrawerOpen}
				setTriggerDrawerOpen={setTriggerDrawerOpen}
				agentDrawerOpen={agentDrawerOpen}
				setAgentDrawerOpen={setAgentDrawerOpen}
				teamDrawerOpen={teamDrawerOpen}
				setTeamDrawerOpen={setTeamDrawerOpen}
				sessions={sessions}
				groups={groups}
				onCanvasSessionIds={onCanvasSessionIds}
				teams={teams}
				onCanvasTemplateIds={onCanvasTemplateIds}
				pipelineCount={pipelineState.pipelines.length}
				createPipeline={createPipeline}
				selectedPipelineId={pipelineState.selectedPipelineId}
				pipelines={pipelineState.pipelines}
				selectPipeline={selectPipeline}
				showSettings={showSettings}
				cueSettings={cueSettings}
				setCueSettings={setCueSettings}
				setShowSettings={setShowSettings}
				setIsDirty={setIsDirty}
				selectedNode={selectedNode}
				selectedEdge={selectedEdge}
				selectedNodeHasOutgoingEdge={selectedNodeHasOutgoingEdge}
				hasIncomingAgentEdges={hasIncomingAgentEdges}
				incomingTriggerEdges={incomingTriggerEdges}
				onUpdateNode={onUpdateNode}
				onUpdateEdgePrompt={onUpdateEdgePrompt}
				onDeleteNode={onDeleteNode}
				onSwitchToSession={onSwitchToSession}
				triggerDrawerOpenForConfig={triggerDrawerOpen}
				agentDrawerOpenForConfig={agentDrawerOpen}
				teamDrawerOpenForConfig={teamDrawerOpen}
				edgeSourceNode={edgeSourceNode}
				edgeTargetNode={edgeTargetNode}
				selectedEdgePipelineColor={selectedEdgePipelineColor}
				onUpdateEdge={onUpdateEdge}
				onDeleteEdge={onDeleteEdge}
				onTriggerPipeline={onTriggerPipeline}
				isDirty={isDirty}
				runningPipelineIds={runningPipelineIds}
				onManageTeams={onSwitchToTeamsTab ? () => onSwitchToTeamsTab() : undefined}
				onEditTeamTemplate={onSwitchToTeamsTab}
			/>

			{contextMenu && (
				<PipelineContextMenu
					contextMenu={contextMenu}
					onConfigure={handleContextMenuConfigure}
					onDelete={handleContextMenuDelete}
					onDuplicate={handleContextMenuDuplicate}
				/>
			)}
		</div>
	);
}

export function CuePipelineEditor(props: CuePipelineEditorProps) {
	return (
		<ReactFlowProvider>
			<CuePipelineEditorInner {...props} />
		</ReactFlowProvider>
	);
}
