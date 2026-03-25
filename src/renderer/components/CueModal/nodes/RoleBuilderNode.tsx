/**
 * RoleBuilderNode — Custom ReactFlow node for team roles on the builder canvas.
 *
 * Visually distinct by role tier:
 *   - Executive: Gold/amber accent, Crown icon (stacked when has reports), taller node (90px)
 *   - Manager:   Blue accent, Network (org-chart) icon, standard height (80px)
 *   - Worker:    Green accent, Wrench icon, standard height (80px)
 *
 * Hierarchy indicators:
 *   - Incoming badge: pill showing "{N} report(s)" at top when other nodes report to this role
 *   - Outgoing arrow: ChevronUp below node when reporting to a higher tier
 *   - Tier rank icon: Crown-stack for executives with reports, Network for managers
 *
 * Follows the AgentNode.tsx pattern: rectangular card with drag handle,
 * content area, connection ports. Uses vertical org chart layout
 * (Top target, Bottom source) instead of horizontal like pipeline editor.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { GripVertical, Settings, Crown, Network, Wrench, ChevronUp } from 'lucide-react';
import { ROLE_TIER_ORDER, type RoleTier } from '../../../../shared/group-chat-types';

// ============================================================================
// Constants
// ============================================================================

export const TIER_COLORS: Record<string, string> = {
	executive: '#f59e0b',
	manager: '#3b82f6',
	worker: '#22c55e',
};

export const TIER_ICONS: Record<string, typeof Crown> = {
	executive: Crown,
	manager: Network,
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
	/** Number of nodes that report to this role (incoming edges) */
	incomingCount?: number;
	/** Whether this node has an outgoing edge to a higher tier */
	hasOutgoingToHigherTier?: boolean;
}

// ============================================================================
// Pure helper functions (exported for testing)
// ============================================================================

/**
 * Get the label for the incoming connections badge.
 * Returns null if count is 0 (badge should not be shown).
 */
export function getIncomingBadgeLabel(count: number): string | null {
	if (count <= 0) return null;
	return count === 1 ? '1 report' : `${count} reports`;
}

/**
 * Compute connection info for a single node given the edge list.
 * Used by the canvas to inject indicator data into node state.
 */
export function computeNodeConnectionInfo(
	nodeId: string,
	nodeTier: RoleTier,
	edges: ReadonlyArray<{ source: string; target: string }>,
	nodeTierLookup: ReadonlyMap<string, RoleTier>
): { incomingCount: number; hasOutgoingToHigherTier: boolean } {
	let incomingCount = 0;
	let hasOutgoingToHigherTier = false;
	for (const edge of edges) {
		if (edge.target === nodeId) incomingCount++;
		if (edge.source === nodeId && !hasOutgoingToHigherTier) {
			const targetTier = nodeTierLookup.get(edge.target) ?? 'worker';
			if (ROLE_TIER_ORDER[targetTier] > ROLE_TIER_ORDER[nodeTier]) {
				hasOutgoingToHigherTier = true;
			}
		}
	}
	return { incomingCount, hasOutgoingToHigherTier };
}

// ============================================================================
// RoleBuilderNode component
// ============================================================================

export const RoleBuilderNode = memo(function RoleBuilderNode({
	id,
	data,
	selected,
}: NodeProps<RoleBuilderNodeData>) {
	const tier = data.tier ?? 'worker';
	const accentColor = TIER_COLORS[tier] ?? TIER_COLORS.worker;
	const TierIcon = TIER_ICONS[tier] ?? Wrench;
	const nodeHeight = tier === 'executive' ? 90 : 80;
	const incomingCount = data.incomingCount ?? 0;
	const hasOutgoingToHigherTier = data.hasOutgoingToHigherTier ?? false;
	const badgeLabel = getIncomingBadgeLabel(incomingCount);

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
				animation: selected ? 'pipeline-node-pulse 2s ease-in-out infinite' : undefined,
				['--node-color-40' as string]: `${accentColor}40`,
				['--node-color-60' as string]: `${accentColor}60`,
				['--node-color-30' as string]: `${accentColor}30`,
				display: 'flex',
				flexDirection: 'row',
				overflow: 'visible',
				cursor: 'default',
				transition: 'border-color 0.15s, box-shadow 0.15s',
				position: 'relative',
			}}
		>
			{/* Incoming connections badge (top-right) */}
			{badgeLabel && (
				<div
					style={{
						position: 'absolute',
						top: -12,
						right: 12,
						backgroundColor: accentColor,
						color: '#1e1e2e',
						fontSize: 8,
						fontWeight: 700,
						borderRadius: 8,
						padding: '1px 5px',
						display: 'flex',
						alignItems: 'center',
						border: '2px solid #1e1e2e',
						zIndex: 11,
						whiteSpace: 'nowrap',
					}}
				>
					{badgeLabel}
				</div>
			)}

			{/* Outgoing to higher tier indicator (below bottom handle) */}
			{hasOutgoingToHigherTier && (
				<div
					style={{
						position: 'absolute',
						bottom: -22,
						left: '50%',
						transform: 'translateX(-50%)',
						color: accentColor,
						opacity: 0.7,
						zIndex: 11,
						pointerEvents: 'none',
					}}
				>
					<ChevronUp size={12} />
				</div>
			)}

			{/* Drag handle — tier-colored background */}
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

			{/* Content — role name (bold), tier badge, agent ID subtitle */}
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
					{/* Tier rank icon — crown-stack for executives with reports */}
					<div
						style={{
							position: 'relative',
							display: 'inline-flex',
							alignItems: 'center',
							flexShrink: 0,
						}}
					>
						{tier === 'executive' && incomingCount > 0 && (
							<TierIcon
								size={10}
								style={{
									color: accentColor,
									opacity: 0.3,
									position: 'absolute',
									left: -2,
									top: -2,
								}}
							/>
						)}
						<TierIcon size={12} style={{ color: accentColor, position: 'relative', zIndex: 1 }} />
					</div>
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
						title={data.name}
					>
						{data.name || 'Unnamed Role'}
					</span>
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
					{/* Tier badge pill */}
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

			{/* Settings gear icon — opens config panel */}
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

			{/* Top: target handle (receives from lower tier) */}
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
			{/* Bottom: source handle (reports to higher tier) */}
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
