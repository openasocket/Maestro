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

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
	ReactFlowProvider,
	useReactFlow,
	applyNodeChanges,
	applyEdgeChanges,
	Background,
	Controls,
	MiniMap,
	ConnectionMode,
	type Node,
	type Edge,
	type OnNodesChange,
	type OnEdgesChange,
	type Connection,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { Save, X, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import {
	ROLE_TIER_ORDER,
	type RoleTier,
	type TeamTemplate,
	type TeamTemplateRole,
	type WorkflowEdge,
	type WorkflowTopology,
} from '../../../shared/group-chat-types';
import { RoleBuilderNode, TIER_COLORS, type RoleBuilderNodeData } from './nodes/RoleBuilderNode';
import { TeamBuilderEdge, type TeamBuilderEdgeData } from './edges/TeamBuilderEdge';
import { RoleConfigPanel } from './panels/RoleConfigPanel';

// Re-export for consumers that import from this file
export type { RoleBuilderNodeData } from './nodes/RoleBuilderNode';
export type { TeamBuilderEdgeData } from './edges/TeamBuilderEdge';

// ============================================================================
// Tier-based prompt suffixes for approval flow
// ============================================================================

const EXECUTIVE_PROMPT_SUFFIX =
	'You are the final approver. Review all work submitted to you. If the quality is acceptable, produce the final output. If not, provide specific feedback and delegate corrections back down the chain.';
const MANAGER_PROMPT_SUFFIX =
	'You coordinate work from your team members. Summarize results, identify gaps, and escalate to your reporting executive when ready for final review.';

// ============================================================================
// Tier validation for connections
// ============================================================================

/**
 * Validate whether a connection between two tiers is allowed.
 * Rules:
 *   - Workers report to Managers or Executives (not other Workers)
 *   - Managers report to Executives or coordinate with other Managers
 *   - Executives report to other Executives (multi-level hierarchy)
 *   - Higher tier cannot report to lower tier
 */
export function validateTierConnection(
	sourceTier: RoleTier,
	targetTier: RoleTier
): { valid: boolean; reason?: string } {
	if (sourceTier === 'worker' && targetTier === 'worker') {
		return { valid: false, reason: 'Workers can only report to Managers or Executives' };
	}
	const sourceOrder = ROLE_TIER_ORDER[sourceTier];
	const targetOrder = ROLE_TIER_ORDER[targetTier];
	if (sourceOrder > targetOrder) {
		const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + 's';
		return { valid: false, reason: `${label(sourceTier)} cannot report to ${label(targetTier)}` };
	}
	return { valid: true };
}

/**
 * Build the systemPromptSuffix for a role based on its tier.
 * Appends tier-based approval flow instructions after any user-provided suffix.
 */
export function buildTierPromptSuffix(tier: RoleTier, userSuffix?: string): string | undefined {
	let tierSuffix: string | undefined;
	if (tier === 'executive') tierSuffix = EXECUTIVE_PROMPT_SUFFIX;
	else if (tier === 'manager') tierSuffix = MANAGER_PROMPT_SUFFIX;

	if (!tierSuffix && !userSuffix) return undefined;
	if (!tierSuffix) return userSuffix;
	if (!userSuffix) return tierSuffix;
	return `${userSuffix}\n\n${tierSuffix}`;
}

/**
 * Generate a WorkflowTopology from canvas nodes and edges.
 * Determines entry/exit points and edge types based on tier hierarchy.
 *
 * Algorithm:
 *   1. Entry points = nodes with no incoming edges (typically workers).
 *   2. Exit points = nodes with no outgoing edges (typically top executive).
 *   3. Edge type: source tier < target tier → sequential; same tier → conditional (peer-review).
 *   4. Pattern is always 'custom' for visual-builder topologies.
 */
export function generateTopologyFromCanvas(
	nodes: Node<RoleBuilderNodeData>[],
	edges: Edge<TeamBuilderEdgeData>[]
): WorkflowTopology | undefined {
	if (nodes.length < 2 || edges.length === 0) return undefined;

	// Build lookup from node ID → role name and tier
	const nodeMap = new Map<string, { name: string; tier: RoleTier }>();
	for (const n of nodes) {
		nodeMap.set(n.id, { name: n.data.name, tier: n.data.tier ?? 'worker' });
	}

	// Find entry points: nodes with no incoming edges
	const nodesWithIncoming = new Set(edges.map((e) => e.target));
	const entryPoints = nodes.filter((n) => !nodesWithIncoming.has(n.id));

	// Find exit points: nodes with no outgoing edges
	const nodesWithOutgoing = new Set(edges.map((e) => e.source));
	const exitPoints = nodes.filter((n) => !nodesWithOutgoing.has(n.id));

	// Generate workflow edges with tier-based edge types
	const workflowEdges: WorkflowEdge[] = edges.map((e) => {
		const sourceInfo = nodeMap.get(e.source);
		const targetInfo = nodeMap.get(e.target);
		const sourceTier = sourceInfo?.tier ?? 'worker';
		const targetTier = targetInfo?.tier ?? 'worker';
		const sourceOrder = ROLE_TIER_ORDER[sourceTier];
		const targetOrder = ROLE_TIER_ORDER[targetTier];

		if (sourceOrder === targetOrder) {
			return {
				source: sourceInfo?.name ?? e.source,
				target: targetInfo?.name ?? e.target,
				edgeType: 'conditional' as const,
				condition: 'peer-review',
			};
		}
		return {
			source: sourceInfo?.name ?? e.source,
			target: targetInfo?.name ?? e.target,
			edgeType: 'sequential' as const,
		};
	});

	// Pick entry/exit by tier: lowest tier for entry, highest for exit
	const pickByTier = (
		candidates: Node<RoleBuilderNodeData>[],
		prefer: 'lowest' | 'highest'
	): Node<RoleBuilderNodeData> => {
		if (candidates.length === 0) return nodes[0];
		return candidates.reduce((best, n) => {
			const bestOrder = ROLE_TIER_ORDER[(best.data.tier ?? 'worker') as RoleTier];
			const nOrder = ROLE_TIER_ORDER[(n.data.tier ?? 'worker') as RoleTier];
			if (prefer === 'lowest') return nOrder < bestOrder ? n : best;
			return nOrder > bestOrder ? n : best;
		});
	};

	const entryNode = pickByTier(entryPoints, 'lowest');
	const exitNode = pickByTier(exitPoints, 'highest');

	return {
		pattern: 'custom',
		edges: workflowEdges,
		entryPoint: entryNode.data.name,
		exitPoint: exitNode.data.name,
	};
}

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
	const roleTierMap = new Map<string, RoleTier>();
	template.roles.forEach((r, i) => {
		roleIndexMap.set(r.name, i);
		roleTierMap.set(r.name, r.tier ?? 'worker');
	});

	return template.topology.edges
		.filter((e) => roleIndexMap.has(e.source) && roleIndexMap.has(e.target))
		.map((e, idx) => {
			const sourceTier = roleTierMap.get(e.source) ?? 'worker';
			const targetTier = roleTierMap.get(e.target) ?? 'worker';
			return {
				id: `edge-${idx}`,
				source: `role-${roleIndexMap.get(e.source)!}`,
				target: `role-${roleIndexMap.get(e.target)!}`,
				type: 'team-edge',
				data: {
					connectionType: (e.edgeType === 'conditional' ? 'delegates-to' : 'reports-to') as
						| 'reports-to'
						| 'delegates-to',
					tierColor: TIER_COLORS[sourceTier] ?? TIER_COLORS.worker,
					sourceTier,
					targetTier,
				},
			};
		});
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
	// Build roles with tier and tier-aware prompt suffixes
	const roles: TeamTemplateRole[] = nodes.map((n) => {
		const tier = (n.data.tier ?? 'worker') as RoleTier;
		return {
			name: n.data.name,
			agentId: n.data.agentId,
			description: n.data.description,
			tier,
			systemPromptSuffix: buildTierPromptSuffix(tier, n.data.systemPromptSuffix),
		};
	});

	// Generate topology from canvas structure
	const topology = generateTopologyFromCanvas(nodes, edges);

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
		topology: topology ?? existingTemplate?.topology,
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
	const [connectionToast, setConnectionToast] = useState<string | null>(null);
	const initializedRef = useRef(false);
	const connectionToastTimerRef = useRef<ReturnType<typeof setTimeout>>();
	const connectionMadeRef = useRef(false);
	const lastInvalidReasonRef = useRef<string | null>(null);

	// Configure handler for node gear icon
	const handleConfigure = useCallback((nodeId: string) => {
		setSelectedNodeId(nodeId);
	}, []);

	// Update a node's data fields (used by RoleConfigPanel)
	const handleUpdateNode = useCallback((nodeId: string, data: Partial<RoleBuilderNodeData>) => {
		setNodes((nds) =>
			nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n))
		);
		// When tier changes, update connected edges so their tier data stays in sync
		if ('tier' in data && data.tier) {
			setEdges((eds) =>
				eds.map((e) => {
					if (!e.data) return e;
					if (e.source === nodeId) {
						return { ...e, data: { ...e.data, sourceTier: data.tier as RoleTier } };
					}
					if (e.target === nodeId) {
						return { ...e, data: { ...e.data, targetTier: data.tier as RoleTier } };
					}
					return e;
				})
			);
		}
	}, []);

	// Delete a node and its connected edges
	const handleDeleteNode = useCallback((nodeId: string) => {
		setNodes((nds) => nds.filter((n) => n.id !== nodeId));
		setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
		setSelectedNodeId(null);
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

	// Recompute hierarchy indicators (incomingCount, hasOutgoingToHigherTier) when edges change
	useEffect(() => {
		setNodes((currentNodes) => {
			// Build incoming count map in a single pass
			const incomingCounts = new Map<string, number>();
			for (const edge of edges) {
				incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
			}

			// Build tier lookup for outgoing-to-higher check
			const tierLookup = new Map<string, RoleTier>();
			for (const node of currentNodes) {
				tierLookup.set(node.id, (node.data.tier ?? 'worker') as RoleTier);
			}

			let anyChanged = false;
			const updated = currentNodes.map((node) => {
				const incomingCount = incomingCounts.get(node.id) ?? 0;
				const nodeTier = tierLookup.get(node.id) ?? 'worker';
				const hasOutgoingToHigherTier = edges.some(
					(e) =>
						e.source === node.id &&
						ROLE_TIER_ORDER[tierLookup.get(e.target) ?? 'worker'] > ROLE_TIER_ORDER[nodeTier]
				);

				if (
					node.data.incomingCount === incomingCount &&
					node.data.hasOutgoingToHigherTier === hasOutgoingToHigherTier
				) {
					return node;
				}
				anyChanged = true;
				return {
					...node,
					data: { ...node.data, incomingCount, hasOutgoingToHigherTier },
				};
			});
			return anyChanged ? updated : currentNodes;
		});
	}, [edges]);

	// ─── ReactFlow callbacks ──────────────────────────────────────────────

	const onNodesChange: OnNodesChange = useCallback((changes) => {
		setNodes((nds) => applyNodeChanges(changes, nds));
	}, []);

	const onEdgesChange: OnEdgesChange = useCallback((changes) => {
		setEdges((eds) => applyEdgeChanges(changes, eds));
	}, []);

	const showConnectionToast = useCallback((message: string) => {
		if (connectionToastTimerRef.current) clearTimeout(connectionToastTimerRef.current);
		setConnectionToast(message);
		connectionToastTimerRef.current = setTimeout(() => setConnectionToast(null), 2500);
	}, []);

	const isValidConnection = useCallback(
		(connection: Connection) => {
			lastInvalidReasonRef.current = null;
			if (!connection.source || !connection.target) return false;
			if (connection.source === connection.target) return false;

			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) {
				lastInvalidReasonRef.current = 'Connection already exists';
				return false;
			}

			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			const sourceTier = (sourceNode?.data.tier ?? 'worker') as RoleTier;
			const targetTier = (targetNode?.data.tier ?? 'worker') as RoleTier;

			const validation = validateTierConnection(sourceTier, targetTier);
			if (!validation.valid) {
				lastInvalidReasonRef.current = validation.reason!;
				return false;
			}
			return true;
		},
		[nodes, edges]
	);

	const onConnectStart = useCallback(() => {
		connectionMadeRef.current = false;
		lastInvalidReasonRef.current = null;
	}, []);

	const onConnectEnd = useCallback(() => {
		if (!connectionMadeRef.current && lastInvalidReasonRef.current) {
			showConnectionToast(lastInvalidReasonRef.current);
		}
		connectionMadeRef.current = false;
		lastInvalidReasonRef.current = null;
	}, [showConnectionToast]);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) return;
			if (connection.source === connection.target) return;

			// Check for existing edge
			const exists = edges.some(
				(e) => e.source === connection.source && e.target === connection.target
			);
			if (exists) return;

			// Validate tier-aware connection rules
			const sourceNode = nodes.find((n) => n.id === connection.source);
			const targetNode = nodes.find((n) => n.id === connection.target);
			const sourceTier = (sourceNode?.data.tier ?? 'worker') as RoleTier;
			const targetTier = (targetNode?.data.tier ?? 'worker') as RoleTier;

			const validation = validateTierConnection(sourceTier, targetTier);
			if (!validation.valid) {
				showConnectionToast(validation.reason!);
				return;
			}

			// Infer connection type from tier hierarchy
			const sourceOrder = ROLE_TIER_ORDER[sourceTier];
			const targetOrder = ROLE_TIER_ORDER[targetTier];
			const connectionType: 'reports-to' | 'delegates-to' =
				sourceOrder <= targetOrder ? 'reports-to' : 'delegates-to';

			const tierColor = TIER_COLORS[sourceTier] ?? TIER_COLORS.worker;

			const newEdge: Edge<TeamBuilderEdgeData> = {
				id: `edge-${Date.now()}`,
				source: connection.source,
				target: connection.target,
				type: 'team-edge',
				data: { connectionType, tierColor, sourceTier, targetTier },
			};

			connectionMadeRef.current = true;
			setEdges((eds) => [...eds, newEdge]);
		},
		[nodes, edges, showConnectionToast]
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
					onConnectStart={onConnectStart}
					onConnectEnd={onConnectEnd}
					isValidConnection={isValidConnection}
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

				{/* Connection validation toast */}
				{connectionToast && (
					<div
						style={{
							position: 'absolute',
							bottom: 16,
							left: '50%',
							transform: 'translateX(-50%)',
							backgroundColor: '#1e1e2e',
							border: '1px solid #ef444480',
							borderRadius: 8,
							padding: '6px 14px',
							fontSize: 12,
							color: '#ef4444',
							fontWeight: 500,
							zIndex: 20,
							pointerEvents: 'none',
							boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
						}}
					>
						{connectionToast}
					</div>
				)}

				{/* Role config panel (bottom panel when node selected) */}
				{selectedNodeId &&
					(() => {
						const selectedNode = nodes.find((n) => n.id === selectedNodeId);
						if (!selectedNode) return null;
						return (
							<RoleConfigPanel
								nodeId={selectedNodeId}
								nodeData={selectedNode.data}
								roleDrawerOpen={_roleDrawerOpen}
								onUpdateNode={handleUpdateNode}
								onDeleteNode={handleDeleteNode}
							/>
						);
					})()}
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
