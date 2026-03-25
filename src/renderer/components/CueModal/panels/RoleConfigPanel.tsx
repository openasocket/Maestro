/**
 * RoleConfigPanel — Bottom panel for configuring a selected role node
 * on the Team Builder canvas.
 *
 * Follows the same absolute-bottom positioning and expand/collapse pattern
 * as NodeConfigPanel in the Cue pipeline editor.
 */

import { useState } from 'react';
import { Trash2, ChevronsUp, ChevronsDown } from 'lucide-react';
import { AGENT_IDS } from '../../../../shared/agentIds';
import { TIER_COLORS, TIER_ICONS, type RoleBuilderNodeData } from '../nodes/RoleBuilderNode';

// ============================================================================
// Props
// ============================================================================

export interface RoleConfigPanelProps {
	/** The selected node ID */
	nodeId: string;
	/** The selected node's data */
	nodeData: RoleBuilderNodeData;
	/** Whether the role drawer is open (adjusts left offset) */
	roleDrawerOpen?: boolean;
	/** Callback to update node data fields */
	onUpdateNode: (nodeId: string, data: Partial<RoleBuilderNodeData>) => void;
	/** Callback to delete the node */
	onDeleteNode: (nodeId: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

const TIERS: Array<{ value: 'executive' | 'manager' | 'worker'; label: string }> = [
	{ value: 'executive', label: 'Executive' },
	{ value: 'manager', label: 'Manager' },
	{ value: 'worker', label: 'Worker' },
];

const AGENT_OPTIONS = AGENT_IDS.filter((id) => id !== 'terminal');

// ============================================================================
// Shared input styles
// ============================================================================

const inputStyle: React.CSSProperties = {
	width: '100%',
	backgroundColor: '#2a2a3e',
	border: '1px solid #444',
	borderRadius: 4,
	color: '#e4e4e7',
	padding: '4px 8px',
	fontSize: 12,
	outline: 'none',
	marginTop: 4,
};

const textareaStyle: React.CSSProperties = {
	...inputStyle,
	resize: 'vertical' as const,
	minHeight: 48,
	fontFamily: 'inherit',
};

const labelStyle: React.CSSProperties = {
	color: '#9ca3af',
	fontSize: 11,
	fontWeight: 500,
	display: 'block',
	marginBottom: 8,
};

// ============================================================================
// Component
// ============================================================================

export function RoleConfigPanel({
	nodeId,
	nodeData,
	roleDrawerOpen,
	onUpdateNode,
	onDeleteNode,
}: RoleConfigPanelProps) {
	const [expanded, setExpanded] = useState(false);

	const tier = nodeData.tier ?? 'worker';
	const accentColor = TIER_COLORS[tier] ?? TIER_COLORS.worker;
	const TierIcon = TIER_ICONS[tier] ?? TIER_ICONS.worker;
	const ExpandIcon = expanded ? ChevronsDown : ChevronsUp;

	const collapsedHeight = 240;

	return (
		<div
			style={{
				position: 'absolute',
				bottom: 0,
				left: roleDrawerOpen ? 'min(220px, 28vw)' : 0,
				right: 0,
				height: expanded ? '80%' : collapsedHeight,
				backgroundColor: '#1a1a2e',
				borderTop: '1px solid #333',
				borderLeft: '1px solid #333',
				borderRight: '1px solid #333',
				borderRadius: '8px 8px 0 0',
				boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'column',
				zIndex: 10,
				animation: 'roleSlideUp 0.15s ease-out',
				transition: 'height 0.2s ease-out',
			}}
		>
			<style>{`
				@keyframes roleSlideUp {
					from { transform: translateY(100%); }
					to { transform: translateY(0); }
				}
			`}</style>

			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '8px 16px',
					borderBottom: '1px solid #2a2a3e',
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<TierIcon size={14} style={{ color: accentColor }} />
					<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>Configure Role</span>
					<span
						style={{
							fontSize: 10,
							color: accentColor,
							backgroundColor: `${accentColor}20`,
							padding: '1px 6px',
							borderRadius: 4,
							fontWeight: 600,
							textTransform: 'uppercase',
						}}
					>
						{tier}
					</span>
				</div>
				<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
					<button
						onClick={() => setExpanded((v) => !v)}
						style={{
							display: 'flex',
							alignItems: 'center',
							padding: 4,
							color: '#6b7280',
							backgroundColor: 'transparent',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => (e.currentTarget.style.color = '#e4e4e7')}
						onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
						title={expanded ? 'Collapse panel' : 'Expand panel'}
					>
						<ExpandIcon size={14} />
					</button>
					<button
						onClick={() => onDeleteNode(nodeId)}
						style={{
							display: 'flex',
							alignItems: 'center',
							padding: 4,
							color: '#6b7280',
							backgroundColor: 'transparent',
							border: 'none',
							borderRadius: 4,
							cursor: 'pointer',
						}}
						onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
						onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
						title="Delete role"
					>
						<Trash2 size={14} />
					</button>
				</div>
			</div>

			{/* Content */}
			<div
				style={{
					flex: 1,
					overflow: 'auto',
					padding: '12px 16px',
					display: 'flex',
					flexDirection: 'column',
					minHeight: 0,
				}}
			>
				{/* Row 1: Role name + Tier selector + Agent ID */}
				<div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
					{/* Role name */}
					<label style={{ ...labelStyle, flex: 1, minWidth: 0 }}>
						Role Name
						<input
							type="text"
							value={nodeData.name}
							onChange={(e) => onUpdateNode(nodeId, { name: e.target.value })}
							placeholder="Role name..."
							style={inputStyle}
						/>
					</label>

					{/* Tier selector pills */}
					<label style={{ ...labelStyle, flexShrink: 0 }}>
						Tier
						<div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
							{TIERS.map(({ value, label }) => {
								const isActive = tier === value;
								const pillColor = TIER_COLORS[value];
								return (
									<button
										key={value}
										onClick={() => onUpdateNode(nodeId, { tier: value })}
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: 4,
											padding: '4px 10px',
											fontSize: 11,
											fontWeight: 500,
											color: isActive ? pillColor : '#9ca3af',
											backgroundColor: isActive ? `${pillColor}15` : 'transparent',
											border: `1px solid ${isActive ? pillColor : '#444'}`,
											borderRadius: 4,
											cursor: 'pointer',
											transition: 'all 0.15s',
										}}
									>
										{label}
									</button>
								);
							})}
						</div>
					</label>

					{/* Agent ID dropdown */}
					<label style={{ ...labelStyle, flexShrink: 0, minWidth: 120 }}>
						Agent
						<select
							value={nodeData.agentId}
							onChange={(e) => onUpdateNode(nodeId, { agentId: e.target.value })}
							style={{
								...inputStyle,
								cursor: 'pointer',
								appearance: 'auto' as React.CSSProperties['appearance'],
							}}
						>
							{AGENT_OPTIONS.map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</select>
					</label>
				</div>

				{/* Row 2: Description */}
				<label style={labelStyle}>
					Description
					<textarea
						value={nodeData.description}
						onChange={(e) => onUpdateNode(nodeId, { description: e.target.value })}
						placeholder="What this role does..."
						style={textareaStyle}
					/>
				</label>

				{/* Row 3: Prompt (shown in expanded mode or when there's content) */}
				<label style={labelStyle}>
					Prompt
					<textarea
						value={nodeData.prompt}
						onChange={(e) => onUpdateNode(nodeId, { prompt: e.target.value })}
						placeholder="Main instruction for this role..."
						style={{ ...textareaStyle, minHeight: expanded ? 80 : 48 }}
					/>
				</label>

				{/* Row 4: System Prompt Suffix (expanded only) */}
				{expanded && (
					<label style={labelStyle}>
						System Prompt Suffix
						<textarea
							value={nodeData.systemPromptSuffix ?? ''}
							onChange={(e) =>
								onUpdateNode(nodeId, { systemPromptSuffix: e.target.value || undefined })
							}
							placeholder="Additional behavioral context appended to system prompt..."
							style={{ ...textareaStyle, minHeight: 64 }}
						/>
					</label>
				)}
			</div>
		</div>
	);
}
