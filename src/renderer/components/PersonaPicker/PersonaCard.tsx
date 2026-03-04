import React, { useState } from 'react';
import type { Theme } from '../../types';

export interface PersonaCardProps {
	theme: Theme;
	personaId: string;
	personaName: string;
	roleName: string;
	description: string;
	similarity?: number;
	isSelected: boolean;
	onToggle: (id: string) => void;
	compact?: boolean;
}

function getRoleBadgeColor(roleName: string): string {
	let hash = 0;
	for (let i = 0; i < roleName.length; i++) {
		hash = roleName.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 50%, 40%)`;
}

export function PersonaCard({
	theme,
	personaId,
	personaName,
	roleName,
	description,
	similarity,
	isSelected,
	onToggle,
	compact,
}: PersonaCardProps): React.ReactElement {
	const [isHovered, setIsHovered] = useState(false);
	const badgeColor = getRoleBadgeColor(roleName);

	const bgColor = isSelected
		? `${theme.colors.accent}11`
		: isHovered
			? `${theme.colors.textMain}08`
			: theme.colors.bgMain;

	return (
		<div
			role="checkbox"
			aria-checked={isSelected}
			tabIndex={0}
			onClick={() => onToggle(personaId)}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onToggle(personaId);
				}
			}}
			style={{
				display: 'flex',
				alignItems: 'flex-start',
				gap: 10,
				padding: compact ? '8px 10px' : '10px 12px',
				background: bgColor,
				border: `1px solid ${theme.colors.border}`,
				borderLeft: isSelected ? `3px solid ${theme.colors.accent}` : `3px solid transparent`,
				borderRadius: 6,
				cursor: 'pointer',
				transition: 'background 150ms, border-color 150ms',
				minWidth: 0,
				flex: '1 1 260px',
				maxWidth: 340,
			}}
		>
			{/* Checkbox */}
			<div
				style={{
					width: 16,
					height: 16,
					borderRadius: 3,
					border: `2px solid ${isSelected ? theme.colors.accent : theme.colors.border}`,
					background: isSelected ? theme.colors.accent : 'transparent',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					flexShrink: 0,
					marginTop: 1,
				}}
			>
				{isSelected && (
					<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
						<path
							d="M2 5L4 7L8 3"
							stroke={theme.colors.accentForeground}
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				)}
			</div>

			{/* Content */}
			<div style={{ minWidth: 0, flex: 1 }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
					<span
						style={{
							fontWeight: 600,
							fontSize: compact ? 12 : 13,
							color: theme.colors.textMain,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{personaName}
					</span>
					<span
						style={{
							fontSize: 10,
							padding: '1px 5px',
							borderRadius: 3,
							background: `${badgeColor}22`,
							color: badgeColor,
							fontWeight: 500,
							whiteSpace: 'nowrap',
						}}
					>
						{roleName}
					</span>
				</div>
				<div
					style={{
						fontSize: 11,
						color: theme.colors.textDim,
						lineHeight: 1.4,
						display: '-webkit-box',
						WebkitLineClamp: 2,
						WebkitBoxOrient: 'vertical',
						overflow: 'hidden',
					}}
				>
					{description}
				</div>
			</div>

			{/* Similarity badge (wizard mode) */}
			{similarity !== undefined && (
				<span
					style={{
						fontSize: 11,
						fontWeight: 600,
						color: theme.colors.accent,
						whiteSpace: 'nowrap',
						flexShrink: 0,
					}}
				>
					{Math.round(similarity * 100)}%
				</span>
			)}
		</div>
	);
}
