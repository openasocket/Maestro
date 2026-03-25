/**
 * RoleDrawer — Slide-in drawer showing the full role prompt library
 * that users can drag onto the Team Builder canvas.
 *
 * Follows the same pattern as AgentDrawer.tsx / TriggerDrawer.tsx:
 * absolute positioned, slide-in transform, search filter, close button.
 *
 * Layout:
 *   1. Search bar — filters by name, description, tags
 *   2. Category filter pills — All, Leadership, Engineering, Quality, Operations
 *   3. Tier sections — Collapsible groups (Executives, Managers, Workers)
 *   4. Role cards — Draggable with tier-colored border, tags, prompt
 *   5. Custom Role card
 *   6. AI Generate Team button
 */

import { memo, useState, useMemo, useRef, useEffect, useCallback } from 'react';
import {
	Search,
	X,
	Crown,
	Briefcase,
	Wrench,
	Plus,
	ChevronDown,
	ChevronRight,
	Sparkles,
} from 'lucide-react';
import type { Theme } from '../../../types';
import { TIER_COLORS } from '../nodes/RoleBuilderNode';
import {
	ROLE_LIBRARY,
	ROLE_CATEGORIES,
	CATEGORY_LABELS,
	type RoleTemplate,
	type RoleCategory,
} from '../teamRoleLibrary';

// Re-export for consumers
export type { RoleTemplate } from '../teamRoleLibrary';

// ============================================================================
// Constants
// ============================================================================

const TIER_ICONS = {
	executive: Crown,
	manager: Briefcase,
	worker: Wrench,
} as const;

const TIER_LABELS: Record<string, string> = {
	executive: 'Executives',
	manager: 'Managers',
	worker: 'Workers',
};

const CUSTOM_ROLE = {
	id: 'custom',
	name: 'Custom Role',
	tier: 'worker' as const,
	defaultAgentId: 'claude-code',
	description: 'Blank role — configure after placing on canvas',
	prompt: '',
	tags: [] as string[],
	category: 'engineering',
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
			agentId: role.defaultAgentId,
			description: role.description,
			prompt: role.prompt,
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
	onOpenWizard?: () => void;
	theme: Theme;
}

export const RoleDrawer = memo(function RoleDrawer({
	isOpen,
	onClose,
	onOpenWizard,
	theme,
}: RoleDrawerProps) {
	const [search, setSearch] = useState('');
	const [activeCategory, setActiveCategory] = useState<RoleCategory | 'all'>('all');
	const [collapsedTiers, setCollapsedTiers] = useState<Record<string, boolean>>({});
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Auto-focus search input when drawer opens
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	// Toggle tier collapse
	const toggleTier = useCallback((tier: string) => {
		setCollapsedTiers((prev) => ({ ...prev, [tier]: !prev[tier] }));
	}, []);

	// Filter roles by search query and active category
	const filtered = useMemo(() => {
		let roles = ROLE_LIBRARY;

		// Category filter
		if (activeCategory !== 'all') {
			roles = roles.filter((role) => role.category === activeCategory);
		}

		// Search filter
		if (search.trim()) {
			const q = search.toLowerCase();
			roles = roles.filter(
				(role) =>
					role.name.toLowerCase().includes(q) ||
					role.tier.toLowerCase().includes(q) ||
					role.description.toLowerCase().includes(q) ||
					role.tags.some((tag) => tag.toLowerCase().includes(q))
			);
		}

		return roles;
	}, [search, activeCategory]);

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
		if (activeCategory !== 'all') return false;
		if (!search.trim()) return true;
		const q = search.toLowerCase();
		return (
			CUSTOM_ROLE.name.toLowerCase().includes(q) ||
			CUSTOM_ROLE.description.toLowerCase().includes(q) ||
			'custom'.includes(q)
		);
	}, [search, activeCategory]);

	return (
		<div
			style={{
				position: 'absolute',
				right: 0,
				top: 0,
				bottom: 0,
				width: 'min(280px, 32vw)',
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
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
					Role Library
				</span>
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
						placeholder="Filter by name, tags..."
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

			{/* Category filter pills */}
			<div
				style={{
					display: 'flex',
					gap: 4,
					padding: '6px 12px',
					flexShrink: 0,
					flexWrap: 'wrap',
				}}
			>
				<button
					onClick={() => setActiveCategory('all')}
					style={{
						fontSize: 10,
						fontWeight: 500,
						padding: '2px 8px',
						borderRadius: 10,
						border: `1px solid ${activeCategory === 'all' ? theme.colors.accent : theme.colors.border}`,
						backgroundColor: activeCategory === 'all' ? `${theme.colors.accent}20` : 'transparent',
						color: activeCategory === 'all' ? theme.colors.accent : theme.colors.textDim,
						cursor: 'pointer',
						transition: 'all 0.15s',
					}}
				>
					All
				</button>
				{ROLE_CATEGORIES.map((cat) => (
					<button
						key={cat}
						onClick={() => setActiveCategory(cat)}
						style={{
							fontSize: 10,
							fontWeight: 500,
							padding: '2px 8px',
							borderRadius: 10,
							border: `1px solid ${activeCategory === cat ? theme.colors.accent : theme.colors.border}`,
							backgroundColor: activeCategory === cat ? `${theme.colors.accent}20` : 'transparent',
							color: activeCategory === cat ? theme.colors.accent : theme.colors.textDim,
							cursor: 'pointer',
							transition: 'all 0.15s',
						}}
					>
						{CATEGORY_LABELS[cat]}
					</button>
				))}
			</div>

			{/* Role list grouped by tier */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
				{grouped.map(({ tier, label, roles }) => {
					const TierIcon = TIER_ICONS[tier as keyof typeof TIER_ICONS];
					const tierColor = TIER_COLORS[tier] ?? TIER_COLORS.worker;
					const isCollapsed = !!collapsedTiers[tier];
					return (
						<div key={tier}>
							{/* Tier section header — clickable to collapse */}
							<button
								onClick={() => toggleTier(tier)}
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
									background: 'none',
									border: 'none',
									cursor: 'pointer',
									width: '100%',
								}}
							>
								{isCollapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
								<TierIcon size={10} />
								{label}
								<span
									style={{
										fontSize: 9,
										fontWeight: 400,
										opacity: 0.7,
										marginLeft: 2,
									}}
								>
									({roles.length})
								</span>
							</button>

							{/* Collapsible role cards */}
							{!isCollapsed &&
								roles.map((role) => (
									<div
										key={role.id}
										draggable
										onDragStart={(e) => handleDragStart(e, role)}
										style={{
											display: 'flex',
											flexDirection: 'column',
											gap: 4,
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
										<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
											<span
												style={{
													color: theme.colors.textMain,
													fontSize: 12,
													fontWeight: 500,
													whiteSpace: 'nowrap',
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													flex: 1,
													minWidth: 0,
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
												whiteSpace: 'nowrap',
												overflow: 'hidden',
												textOverflow: 'ellipsis',
											}}
										>
											{role.description}
										</div>
										{/* Tags */}
										{role.tags.length > 0 && (
											<div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
												{role.tags.map((tag) => (
													<span
														key={tag}
														style={{
															fontSize: 9,
															color: theme.colors.textDim,
															backgroundColor: `${theme.colors.border}80`,
															padding: '0px 4px',
															borderRadius: 3,
															lineHeight: '14px',
														}}
													>
														{tag}
													</span>
												))}
											</div>
										)}
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

			{/* Divider + AI Generate Team button */}
			<div
				style={{
					borderTop: `1px solid ${theme.colors.border}`,
					padding: '10px 12px',
					flexShrink: 0,
				}}
			>
				<button
					onClick={onOpenWizard}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						gap: 6,
						width: '100%',
						padding: '8px 12px',
						borderRadius: 6,
						border: `1px solid ${theme.colors.accent}`,
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
						fontSize: 12,
						fontWeight: 600,
						cursor: 'pointer',
						transition: 'all 0.15s',
					}}
					onMouseEnter={(e) => {
						(e.currentTarget as HTMLElement).style.backgroundColor = `${theme.colors.accent}30`;
					}}
					onMouseLeave={(e) => {
						(e.currentTarget as HTMLElement).style.backgroundColor = `${theme.colors.accent}15`;
					}}
				>
					<Sparkles size={14} />
					AI Generate Team
				</button>
			</div>
		</div>
	);
});
