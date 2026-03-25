/**
 * RoleDrawer — Slide-in drawer showing available role templates
 * that users can drag onto the Team Builder canvas.
 *
 * Follows the same pattern as AgentDrawer.tsx / TriggerDrawer.tsx:
 * absolute positioned, slide-in transform, search filter, close button.
 *
 * Sections:
 *   1. Quick Roles — Pre-built role cards organized by tier
 *   2. Custom Role — Blank role node at the bottom
 */

import { memo, useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, Crown, Briefcase, Wrench, Plus } from 'lucide-react';
import type { Theme } from '../../../types';
import { TIER_COLORS } from '../nodes/RoleBuilderNode';

// ============================================================================
// Role template definitions
// ============================================================================

export interface RoleTemplate {
	name: string;
	tier: 'executive' | 'manager' | 'worker';
	agentId: string;
	description: string;
}

const TIER_ICONS = {
	executive: Crown,
	manager: Briefcase,
	worker: Wrench,
} as const;

const TIER_LABELS: Record<string, string> = {
	executive: 'Executive',
	manager: 'Manager',
	worker: 'Worker',
};

const QUICK_ROLES: RoleTemplate[] = [
	// Executive tier
	{
		name: 'Technical Director',
		tier: 'executive',
		agentId: 'claude-code',
		description: 'Oversees technical strategy and architecture decisions',
	},
	{
		name: 'Product Owner',
		tier: 'executive',
		agentId: 'claude-code',
		description: 'Defines requirements and prioritizes deliverables',
	},
	{
		name: 'Quality Assurance Lead',
		tier: 'executive',
		agentId: 'claude-code',
		description: 'Sets quality standards and review processes',
	},
	// Manager tier
	{
		name: 'Project Coordinator',
		tier: 'manager',
		agentId: 'claude-code',
		description: 'Coordinates tasks and tracks progress across roles',
	},
	{
		name: 'Code Review Manager',
		tier: 'manager',
		agentId: 'claude-code',
		description: 'Manages code review workflow and standards',
	},
	{
		name: 'Architecture Lead',
		tier: 'manager',
		agentId: 'claude-code',
		description: 'Guides system design and technical patterns',
	},
	// Worker tier
	{
		name: 'Frontend Developer',
		tier: 'worker',
		agentId: 'claude-code',
		description: 'Implements UI components and client-side logic',
	},
	{
		name: 'Backend Developer',
		tier: 'worker',
		agentId: 'claude-code',
		description: 'Builds APIs, services, and server-side logic',
	},
	{
		name: 'Test Engineer',
		tier: 'worker',
		agentId: 'claude-code',
		description: 'Writes and maintains test suites',
	},
	{
		name: 'Documentation Writer',
		tier: 'worker',
		agentId: 'claude-code',
		description: 'Creates and maintains project documentation',
	},
	{
		name: 'Security Analyst',
		tier: 'worker',
		agentId: 'claude-code',
		description: 'Reviews code for vulnerabilities and security issues',
	},
];

const CUSTOM_ROLE: RoleTemplate = {
	name: 'Custom Role',
	tier: 'worker',
	agentId: 'claude-code',
	description: 'Blank role — configure after placing on canvas',
};

// ============================================================================
// Drag handler
// ============================================================================

function handleDragStart(e: React.DragEvent, role: RoleTemplate) {
	e.dataTransfer.setData(
		'application/team-builder',
		JSON.stringify({
			name: role.name,
			tier: role.tier,
			agentId: role.agentId,
			description: role.description,
		})
	);
	e.dataTransfer.effectAllowed = 'move';
}

// ============================================================================
// Component
// ============================================================================

export interface RoleDrawerProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
}

export const RoleDrawer = memo(function RoleDrawer({ isOpen, onClose, theme }: RoleDrawerProps) {
	const [search, setSearch] = useState('');
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Auto-focus search input when drawer opens
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	// Filter roles by search query
	const filtered = useMemo(() => {
		if (!search.trim()) return QUICK_ROLES;
		const q = search.toLowerCase();
		return QUICK_ROLES.filter(
			(role) =>
				role.name.toLowerCase().includes(q) ||
				role.tier.toLowerCase().includes(q) ||
				role.description.toLowerCase().includes(q)
		);
	}, [search]);

	// Group filtered roles by tier (preserve tier ordering)
	const grouped = useMemo(() => {
		const tiers: ('executive' | 'manager' | 'worker')[] = ['executive', 'manager', 'worker'];
		const result: { tier: string; label: string; roles: RoleTemplate[] }[] = [];
		for (const tier of tiers) {
			const roles = filtered.filter((r) => r.tier === tier);
			if (roles.length > 0) {
				result.push({ tier, label: TIER_LABELS[tier], roles });
			}
		}
		return result;
	}, [filtered]);

	// Check if custom role matches search
	const showCustomRole = useMemo(() => {
		if (!search.trim()) return true;
		const q = search.toLowerCase();
		return (
			CUSTOM_ROLE.name.toLowerCase().includes(q) ||
			CUSTOM_ROLE.description.toLowerCase().includes(q) ||
			'custom'.includes(q)
		);
	}, [search]);

	return (
		<div
			style={{
				position: 'absolute',
				right: 0,
				top: 0,
				bottom: 0,
				width: 'min(240px, 28vw)',
				zIndex: 20,
				backgroundColor: theme.colors.bgMain,
				borderLeft: `1px solid ${theme.colors.border}`,
				transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
				transition: 'transform 200ms ease',
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '10px 12px',
					borderBottom: `1px solid ${theme.colors.border}`,
					flexShrink: 0,
				}}
			>
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>Roles</span>
				<button
					onClick={onClose}
					style={{
						background: 'none',
						border: 'none',
						cursor: 'pointer',
						padding: 2,
						display: 'flex',
						alignItems: 'center',
						color: theme.colors.textDim,
					}}
				>
					<X size={14} />
				</button>
			</div>

			{/* Search */}
			<div style={{ padding: '8px 12px 4px', flexShrink: 0 }}>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						backgroundColor: theme.colors.bgActivity,
						borderRadius: 6,
						padding: '4px 8px',
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<Search size={12} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
					<input
						ref={searchInputRef}
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter roles..."
						style={{
							flex: 1,
							background: 'none',
							border: 'none',
							outline: 'none',
							color: theme.colors.textMain,
							fontSize: 12,
						}}
					/>
				</div>
			</div>

			{/* Role list grouped by tier */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
				{grouped.map(({ tier, label, roles }) => {
					const TierIcon = TIER_ICONS[tier as keyof typeof TIER_ICONS];
					const tierColor = TIER_COLORS[tier] ?? TIER_COLORS.worker;
					return (
						<div key={tier}>
							{/* Tier section header */}
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 4,
									color: tierColor,
									fontSize: 10,
									fontWeight: 600,
									textTransform: 'uppercase',
									letterSpacing: '0.05em',
									padding: '8px 4px 4px',
								}}
							>
								<TierIcon size={10} />
								{label}
							</div>
							{roles.map((role) => (
								<div
									key={role.name}
									draggable
									onDragStart={(e) => handleDragStart(e, role)}
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 8,
										padding: '8px 10px',
										marginBottom: 4,
										borderRadius: 6,
										borderLeft: `3px solid ${tierColor}`,
										backgroundColor: theme.colors.bgActivity,
										cursor: 'grab',
										transition: 'filter 0.15s',
									}}
									onMouseEnter={(e) => {
										(e.currentTarget as HTMLElement).style.filter = 'brightness(1.2)';
									}}
									onMouseLeave={(e) => {
										(e.currentTarget as HTMLElement).style.filter = 'brightness(1)';
									}}
								>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div
											style={{
												display: 'flex',
												alignItems: 'center',
												gap: 6,
											}}
										>
											<span
												style={{
													color: theme.colors.textMain,
													fontSize: 12,
													fontWeight: 500,
													whiteSpace: 'nowrap',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
												}}
											>
												{role.name}
											</span>
											<span
												style={{
													fontSize: 9,
													fontWeight: 600,
													textTransform: 'uppercase',
													color: tierColor,
													backgroundColor: `${tierColor}20`,
													padding: '1px 4px',
													borderRadius: 3,
													flexShrink: 0,
												}}
											>
												{role.tier}
											</span>
										</div>
										<div
											style={{
												color: theme.colors.textDim,
												fontSize: 10,
												marginTop: 2,
												whiteSpace: 'nowrap',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}
										>
											{role.description}
										</div>
									</div>
								</div>
							))}
						</div>
					);
				})}

				{/* Custom Role card */}
				{showCustomRole && (
					<>
						<div
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								fontWeight: 600,
								textTransform: 'uppercase',
								letterSpacing: '0.05em',
								padding: '8px 4px 4px',
							}}
						>
							Custom
						</div>
						<div
							draggable
							onDragStart={(e) => handleDragStart(e, CUSTOM_ROLE)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								padding: '8px 10px',
								marginBottom: 4,
								borderRadius: 6,
								borderLeft: `3px dashed ${theme.colors.border}`,
								backgroundColor: theme.colors.bgActivity,
								cursor: 'grab',
								transition: 'filter 0.15s',
							}}
							onMouseEnter={(e) => {
								(e.currentTarget as HTMLElement).style.filter = 'brightness(1.2)';
							}}
							onMouseLeave={(e) => {
								(e.currentTarget as HTMLElement).style.filter = 'brightness(1)';
							}}
						>
							<Plus size={14} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
							<div style={{ flex: 1, minWidth: 0 }}>
								<div
									style={{
										color: theme.colors.textMain,
										fontSize: 12,
										fontWeight: 500,
									}}
								>
									Custom Role
								</div>
								<div
									style={{
										color: theme.colors.textDim,
										fontSize: 10,
										marginTop: 2,
									}}
								>
									Blank role — configure after placing
								</div>
							</div>
						</div>
					</>
				)}

				{/* Empty state */}
				{grouped.length === 0 && !showCustomRole && (
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 12,
							textAlign: 'center',
							padding: '20px 0',
						}}
					>
						No roles match
					</div>
				)}
			</div>
		</div>
	);
});
