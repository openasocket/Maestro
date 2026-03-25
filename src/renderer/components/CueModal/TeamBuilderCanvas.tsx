/**
 * TeamBuilderCanvas — Visual team builder using ReactFlow.
 *
 * Provides a drag-and-drop canvas for constructing team org structures
 * visually, using the same ReactFlow technology as the Cue pipeline editor.
 *
 * Users drag role nodes onto the canvas, draw connections between them,
 * and build organizational structures. Connections auto-infer type
 * (reports-to / delegates-to) based on role tiers.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
	ReactFlowProvider,
	useReactFlow,
	applyNodeChanges,
	applyEdgeChanges,
	Background,
	Controls,
	MiniMap,
	ConnectionMode,
	Handle,
	Position,
	BaseEdge,
	EdgeLabelRenderer,
	getBezierPath,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
	type NodeProps,
	type EdgeProps,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { GripVertical, Settings, Save, X, Crown, Briefcase, Wrench, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	TeamTemplate,
	TeamTemplateRole,
	WorkflowEdge,
} from '../../../shared/group-chat-types';

// ============================================================================
// Constants
// ============================================================================

const TIER_COLORS: Record<string, string> = {
	executive: '#f59e0b',
	manager: '#3b82f6',
	worker: '#22c55e',
};

const TIER_ICONS: Record<string, typeof Crown> = {
	executive: Crown,
	manager: Briefcase,
	worker: Wrench,
};

// ============================================================================
// Node data interface
// ============================================================================

export interface RoleBuilderNodeData {
	roleId: string;
	name: string;
	tier: 'executive' | 'manager' | 'worker';
	agentId: string;
	description: string;
	prompt: string;
	systemPromptSuffix?: string;
	onConfigure?: (nodeId: string) => void;
}

// ============================================================================
// Edge data interface
// ============================================================================

export interface TeamBuilderEdgeData {
	connectionType: 'reports-to' | 'delegates-to';
	tierColor: string;
}

// ============================================================================
// RoleBuilderNode — Placeholder (full version in CUE-TEAMS-TAB-04 task 3)
// ============================================================================

const RoleBuilderNode = memo(function RoleBuilderNode({
	id,
	data,
	selected,
}: NodeProps<RoleBuilderNodeData>) {
	const tier = data.tier ?? 'worker';
	const accentColor = TIER_COLORS[tier] ?? TIER_COLORS.worker;
	const TierIcon = TIER_ICONS[tier] ?? Wrench;
	const nodeHeight = tier === 'executive' ? 90 : 80;

	return (
		<div
			style={{
				minWidth: 200,
				maxWidth: 360,
				height: nodeHeight,
				borderRadius: 8,
				backgroundColor: '#1e1e2e',
				border: `2px solid ${selected ? accentColor : '#333'}`,
				boxShadow: selected ? `0 4px 16px ${accentColor}30` : '0 2px 8px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s',
				position: 'relative',
			}}
		>
			{/* Drag handle */}
			<div
				className="drag-handle"
				style={{
					width: 32,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'grab',
					color: '#555',
					flexShrink: 0,
					backgroundColor: accentColor,
					borderRadius: '6px 0 0 6px',
					transition: 'color 0.15s, filter 0.15s',
				}}
				onMouseEnter={(e) => {
					e.currentTarget.style.color = '#fff';
					e.currentTarget.style.filter = 'brightness(1.3)';
				}}
				onMouseLeave={(e) => {
					e.currentTarget.style.color = '#555';
					e.currentTarget.style.filter = 'brightness(1)';
				}}
				title="Drag to move"
			>
				<GripVertical size={16} />
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					padding: '8px 10px',
					overflow: 'hidden',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<TierIcon size={12} style={{ color: accentColor, flexShrink: 0 }} />
					<span
						style={{
							color: '#e4e4e7',
							fontSize: 13,
							fontWeight: 600,
							whiteSpace: 'nowrap',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							flex: 1,
						}}
					>
						{data.name || 'Unnamed Role'}
					</span>
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
					<span
						style={{
							fontSize: 9,
							fontWeight: 600,
							textTransform: 'uppercase',
							color: accentColor,
							backgroundColor: `${accentColor}20`,
							padding: '1px 5px',
							borderRadius: 3,
						}}
					>
						{tier}
					</span>
					<span style={{ color: '#6b7280', fontSize: 11 }}>{data.agentId}</span>
				</div>
			</div>

			{/* Gear icon */}
			<div
				onClick={(e) => {
					e.stopPropagation();
					data.onConfigure?.(id);
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					cursor: 'pointer',
					color: selected ? accentColor : '#555',
					flexShrink: 0,
					padding: '0 6px',
					marginRight: 14,
					borderRadius: 4,
					transition: 'color 0.15s',
				}}
				onMouseEnter={(e) => (e.currentTarget.style.color = accentColor)}
				onMouseLeave={(e) => (e.currentTarget.style.color = selected ? accentColor : '#555')}
				title="Configure"
			>
				<Settings size={14} />
			</div>

			{/* Top target handle (receives from higher tier) */}
			<Handle
				type="target"
				position={Position.Top}
				style={{
					backgroundColor: accentColor,
					border: '3px solid #1e1e2e',
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 14,
					height: 14,
					zIndex: 10,
					top: -7,
				}}
			/>
			{/* Bottom source handle (reports to / delegates to) */}
			<Handle
				type="source"
				position={Position.Bottom}
				style={{
					backgroundColor: accentColor,
					border: '3px solid #1e1e2e',
					boxShadow: `0 0 0 2px ${accentColor}`,
					width: 14,
					height: 14,
					zIndex: 10,
					bottom: -7,
				}}
			/>
		</div>
	);
});

// ============================================================================
// TeamBuilderEdge — Placeholder (full version in CUE-TEAMS-TAB-04 task 4)
// ============================================================================

const TeamBuilderEdge = memo(function TeamBuilderEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
	selected,
}: EdgeProps<TeamBuilderEdgeData>) {
	const connectionType = data?.connectionType ?? 'reports-to';
	const color = data?.tierColor ?? TIER_COLORS.worker;

	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
	});

	return (
		<>
			{selected && (
				<BaseEdge
					id={`${id}-glow`}
					path={edgePath}
					style={{
						stroke: color,
						strokeWidth: 8,
						opacity: 0.3,
						filter: `drop-shadow(0 0 4px ${color})`,
						strokeLinecap: 'round',
					}}
				/>
			)}
			<BaseEdge
				id={id}
				path={edgePath}
				markerEnd="url(#team-arrow)"
				style={{
					stroke: color,
					strokeWidth: selected ? 3 : 1.5,
					strokeDasharray: connectionType === 'delegates-to' ? '6 3' : undefined,
				}}
			/>
			{(selected || false) && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: 'absolute',
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
							pointerEvents: 'all',
							display: 'flex',
							alignItems: 'center',
							gap: 4,
							backgroundColor: '#1e1e2e',
							border: `1px solid ${color}60`,
							borderRadius: 10,
							padding: '2px 8px',
							fontSize: 10,
							color,
							fontWeight: 500,
						}}
					>
						{connectionType === 'reports-to' ? 'Reports to' : 'Delegates to'}
					</div>
				</EdgeLabelRenderer>
			)}
		</>
	);
});

// ============================================================================
// Tier order for connection inference
// ============================================================================

const TIER_ORDER: Record<string, number> = {
	executive: 0,
	manager: 1,
	worker: 2,
};

function generateId(): string {
	return `role-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================================
// Convert TeamTemplate to ReactFlow nodes/edges
// ============================================================================

function templateToNodes(
	template: TeamTemplate,
	onConfigure: (nodeId: string) => void
): Node<RoleBuilderNodeData>[] {
	return template.roles.map((role, idx) => {
		const col = idx % 3;
		const row = Math.floor(idx / 3);
		return {
			id: `role-${idx}`,
			type: 'role',
			position: { x: 100 + col * 280, y: 80 + row * 140 },
			data: {
				roleId: `role-${idx}`,
				name: role.name,
				tier: 'worker' as const,
				agentId: role.agentId,
				description: role.description,
				prompt: '',
				systemPromptSuffix: role.systemPromptSuffix,
				onConfigure,
			},
			dragHandle: '.drag-handle',
		};
	});
}

function templateToEdges(template: TeamTemplate): Edge<TeamBuilderEdgeData>[] {
	if (!template.topology?.edges) return [];

	const roleIndexMap = new Map<string, number>();
	template.roles.forEach((r, i) => roleIndexMap.set(r.name, i));

	return template.topology.edges
		.filter((e) => roleIndexMap.has(e.source) && roleIndexMap.has(e.target))
		.map((e, idx) => ({
			id: `edge-${idx}`,
			source: `role-${roleIndexMap.get(e.source)!}`,
			target: `role-${roleIndexMap.get(e.target)!}`,
			type: 'team-edge',
			data: {
				connectionType: (e.edgeType === 'conditional' ? 'delegates-to' : 'reports-to') as
					| 'reports-to'
					| 'delegates-to',
				tierColor: TIER_COLORS.worker,
			},
		}));
}

// ============================================================================
// Convert ReactFlow state back to TeamTemplate
// ============================================================================

function canvasToTemplate(
	nodes: Node<RoleBuilderNodeData>[],
	edges: Edge<TeamBuilderEdgeData>[],
	teamName: string,
	teamDescription: string,
	existingTemplate?: TeamTemplate
): TeamTemplate {
	const roles: TeamTemplateRole[] = nodes.map((n) => ({
		name: n.data.name,
		agentId: n.data.agentId,
		description: n.data.description,
		systemPromptSuffix: n.data.systemPromptSuffix,
	}));

	// Build a lookup from node ID → role name
	const nodeIdToRoleName = new Map<string, string>();
	for (const n of nodes) {
		nodeIdToRoleName.set(n.id, n.data.name);
	}

	const workflowEdges: WorkflowEdge[] = edges.map((e) => ({
		source: nodeIdToRoleName.get(e.source) ?? e.source,
		target: nodeIdToRoleName.get(e.target) ?? e.target,
		edgeType:
			e.data?.connectionType === 'delegates-to'
				? ('conditional' as const)
				: ('sequential' as const),
	}));

	const now = Date.now();

	return {
		id: existingTemplate?.id ?? `template-${now}`,
		name: teamName.trim() || 'Untitled Team',
		description: teamDescription.trim(),
		category: existingTemplate?.category ?? 'user',
		createdAt: existingTemplate?.createdAt ?? now,
		updatedAt: now,
		moderatorAgentId: existingTemplate?.moderatorAgentId ?? 'claude-code',
		moderatorConfig: existingTemplate?.moderatorConfig,
		roles,
		topology:
			workflowEdges.length > 0 && roles.length >= 2
				? {
						pattern: 'custom',
						edges: workflowEdges,
						entryPoint: roles[0]?.name ?? '',
						exitPoint: roles[roles.length - 1]?.name ?? '',
					}
				: existingTemplate?.topology,
	};
}

// ============================================================================
// Inner component (must be inside ReactFlowProvider)
// ============================================================================

export interface TeamBuilderCanvasProps {
	theme: Theme;
	editingTemplate?: TeamTemplate;
	onSave: (template: TeamTemplate) => Promise<void>;
	onCancel: () => void;
}

const nodeTypes = { role: RoleBuilderNode };
const edgeTypes = { 'team-edge': TeamBuilderEdge };

function TeamBuilderCanvasInner({
	theme,
	editingTemplate,
	onSave,
	onCancel,
}: TeamBuilderCanvasProps) {
	const reactFlowInstance = useReactFlow();

	// Canvas state
	const [teamName, setTeamName] = useState(editingTemplate?.name ?? '');
	const [teamDescription, setTeamDescription] = useState(editingTemplate?.description ?? '');
	const [nodes, setNodes] = useState<Node<RoleBuilderNodeData>[]>([]);
	const [edges, setEdges] = useState<Edge<TeamBuilderEdgeData>[]>([]);
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [_roleDrawerOpen, _setRoleDrawerOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const initializedRef = useRef(false);

	// Configure handler for node gear icon
	const handleConfigure = useCallback((nodeId: string) => {
		setSelectedNodeId(nodeId);
	}, []);

	// Initialize from editing template
	useEffect(() => {
		if (initializedRef.current) return;
		initializedRef.current = true;
		if (editingTemplate) {
			setNodes(templateToNodes(editingTemplate, handleConfigure));
			setEdges(templateToEdges(editingTemplate));
		}
	}, [editingTemplate, handleConfigure]);

	// ─── ReactFlow callbacks ──────────────────────────────────────────────

	const onNodesChange: OnNodesChange = useCallback((changes) => {
		setNodes((nds) => applyNodeChanges(changes, nds));
	}, []);

	const onEdgesChange: OnEdgesChange = useCallback((changes) => {
		setEdges((eds) => applyEdgeChanges(changes, eds));
	}, []);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;
			if (connection.source === connection.target) return;

			// Check for existing edge
			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return;

			// Infer connection type from tier order
			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			const sourceTier = TIER_ORDER[sourceNode?.data.tier ?? 'worker'] ?? 2;
			const targetTier = TIER_ORDER[targetNode?.data.tier ?? 'worker'] ?? 2;

			const connectionType: 'reports-to' | 'delegates-to' =
				sourceTier >= targetTier ? 'reports-to' : 'delegates-to';

			const tierColor = TIER_COLORS[sourceNode?.data.tier ?? 'worker'] ?? TIER_COLORS.worker;

			const newEdge: Edge<TeamBuilderEdgeData> = {
				id: `edge-${Date.now()}`,
				source: connection.source,
				target: connection.target,
				type: 'team-edge',
				data: { connectionType, tierColor },
			};

			setEdges((eds) => [...eds, newEdge]);
		},
		[nodes, edges]
	);

	// ─── Drag-and-drop ────────────────────────────────────────────────────

	const onDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = 'move';
	}, []);

	const onDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			event.stopPropagation();

			const raw = event.dataTransfer.getData('application/team-builder');
			if (!raw) return;

			let dropData: {
				name: string;
				tier: 'executive' | 'manager' | 'worker';
				agentId: string;
				description: string;
				prompt?: string;
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

			const roleId = generateId();
			const newNode: Node<RoleBuilderNodeData> = {
				id: roleId,
				type: 'role',
				position,
				data: {
					roleId,
					name: dropData.name,
					tier: dropData.tier,
					agentId: dropData.agentId,
					description: dropData.description,
					prompt: dropData.prompt ?? '',
					onConfigure: handleConfigure,
				},
				dragHandle: '.drag-handle',
			};

			setNodes((nds) => [...nds, newNode]);
			setSelectedNodeId(roleId);
		},
		[reactFlowInstance, handleConfigure]
	);

	// ─── Save handler ─────────────────────────────────────────────────────

	const handleSave = useCallback(async () => {
		if (saving) return;
		setSaving(true);
		try {
			const template = canvasToTemplate(nodes, edges, teamName, teamDescription, editingTemplate);
			await onSave(template);
		} finally {
			setSaving(false);
		}
	}, [nodes, edges, teamName, teamDescription, editingTemplate, onSave, saving]);

	// ─── Keyboard shortcuts ───────────────────────────────────────────────

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isInput =
				target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (isInput) return;
				if (selectedNodeId) {
					e.preventDefault();
					setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
					setEdges((eds) =>
						eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId)
					);
					setSelectedNodeId(null);
				}
			} else if (e.key === 'Escape') {
				if (selectedNodeId) {
					setSelectedNodeId(null);
				}
			} else if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [selectedNodeId, handleSave]);

	// ─── Add role button (quick-add without drawer) ───────────────────────

	const handleAddRole = useCallback(() => {
		const roleId = generateId();
		const position = {
			x: 100 + (nodes.length % 3) * 280,
			y: 80 + Math.floor(nodes.length / 3) * 140,
		};
		const newNode: Node<RoleBuilderNodeData> = {
			id: roleId,
			type: 'role',
			position,
			data: {
				roleId,
				name: `Role ${nodes.length + 1}`,
				tier: 'worker',
				agentId: 'claude-code',
				description: '',
				prompt: '',
				onConfigure: handleConfigure,
			},
			dragHandle: '.drag-handle',
		};
		setNodes((nds) => [...nds, newNode]);
		setSelectedNodeId(roleId);
	}, [nodes.length, handleConfigure]);

	// ─── Render ───────────────────────────────────────────────────────────

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
			{/* Top toolbar */}
			<div
				className="flex items-center justify-between px-4 py-2 border-b"
				style={{ borderColor: theme.colors.border, flexShrink: 0 }}
			>
				{/* Left: team info inputs */}
				<div className="flex items-center gap-3" style={{ flex: 1, minWidth: 0 }}>
					<input
						type="text"
						value={teamName}
						onChange={(e) => setTeamName(e.target.value)}
						placeholder="Team name..."
						style={{
							background: 'none',
							border: `1px solid ${theme.colors.border}`,
							borderRadius: 6,
							padding: '4px 10px',
							color: theme.colors.textMain,
							fontSize: 13,
							fontWeight: 600,
							outline: 'none',
							width: 200,
						}}
					/>
					<input
						type="text"
						value={teamDescription}
						onChange={(e) => setTeamDescription(e.target.value)}
						placeholder="Description..."
						style={{
							background: 'none',
							border: `1px solid ${theme.colors.border}`,
							borderRadius: 6,
							padding: '4px 10px',
							color: theme.colors.textDim,
							fontSize: 12,
							outline: 'none',
							flex: 1,
							minWidth: 100,
						}}
					/>
				</div>

				{/* Right: actions */}
				<div className="flex items-center gap-2">
					<button
						onClick={handleAddRole}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
						title="Add a role node"
					>
						<Plus size={12} />
						Add Role
					</button>

					<button
						onClick={onCancel}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: 'transparent',
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
						title="Cancel and return to library"
					>
						<X size={12} />
						Cancel
					</button>

					<button
						onClick={handleSave}
						disabled={saving}
						className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}`,
							cursor: saving ? 'wait' : 'pointer',
							transition: 'all 0.15s',
						}}
						title="Save team template"
					>
						<Save size={12} />
						{saving ? 'Saving...' : 'Save'}
					</button>
				</div>
			</div>

			{/* Canvas */}
			<div style={{ flex: 1, position: 'relative' }}>
				<ReactFlow
					nodes={nodes}
					edges={edges}
					nodeTypes={nodeTypes}
					edgeTypes={edgeTypes}
					onNodesChange={onNodesChange}
					onEdgesChange={onEdgesChange}
					onConnect={onConnect}
					onDrop={onDrop}
					onDragOver={onDragOver}
					connectionMode={ConnectionMode.Loose}
					fitView
					style={{ backgroundColor: theme.colors.bgMain }}
					onNodeClick={(_e, node) => setSelectedNodeId(node.id)}
					onPaneClick={() => setSelectedNodeId(null)}
				>
					<Background color={theme.colors.border} gap={20} />
					<Controls
						style={
							{
								button: { backgroundColor: theme.colors.bgActivity },
							} as React.CSSProperties
						}
					/>
					<MiniMap
						nodeColor={(node) => {
							const tier = (node.data as RoleBuilderNodeData)?.tier ?? 'worker';
							return TIER_COLORS[tier] ?? TIER_COLORS.worker;
						}}
						style={{ backgroundColor: theme.colors.bgActivity }}
					/>

					{/* Arrow marker definition */}
					<svg style={{ position: 'absolute', width: 0, height: 0 }}>
						<defs>
							<marker
								id="team-arrow"
								viewBox="0 0 10 10"
								refX="10"
								refY="5"
								markerWidth="8"
								markerHeight="8"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280" />
							</marker>
						</defs>
					</svg>
				</ReactFlow>

				{/* Empty state */}
				{nodes.length === 0 && (
					<div
						style={{
							position: 'absolute',
							top: '50%',
							left: '50%',
							transform: 'translate(-50%, -50%)',
							textAlign: 'center',
							pointerEvents: 'none',
						}}
					>
						<div
							style={{
								color: theme.colors.textDim,
								fontSize: 14,
								marginBottom: 8,
							}}
						>
							Drag roles onto the canvas or click "Add Role"
						</div>
						<div style={{ color: theme.colors.textDim, fontSize: 12, opacity: 0.6 }}>
							Connect roles to define reporting structures
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

// ============================================================================
// Exported wrapper with ReactFlowProvider
// ============================================================================

export function TeamBuilderCanvas(props: TeamBuilderCanvasProps) {
	return (
		<ReactFlowProvider>
			<TeamBuilderCanvasInner {...props} />
		</ReactFlowProvider>
	);
}
