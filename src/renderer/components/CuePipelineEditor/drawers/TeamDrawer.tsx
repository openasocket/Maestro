import { memo, useState, useMemo, useRef, useEffect } from 'react';
import { Search, Users, X } from 'lucide-react';
import type { CuePipelineTeamInfo } from '../../../../shared/cue-pipeline-types';
import type { Theme } from '../../../types';

export interface TeamDrawerProps {
	isOpen: boolean;
	onClose: () => void;
	teams: CuePipelineTeamInfo[];
	onCanvasTemplateIds?: Set<string>;
	theme: Theme;
	/** When true, another drawer shares the right side — this drawer takes the bottom half */
	shareRight?: boolean;
	/** Navigate to the Teams tab for full template management */
	onManageTeams?: () => void;
}

function handleDragStart(e: React.DragEvent, team: CuePipelineTeamInfo) {
	e.dataTransfer.setData(
		'application/cue-pipeline',
		JSON.stringify({
			type: 'team',
			templateId: team.id,
			templateName: team.name,
			roleCount: team.roleCount,
			topologyPattern: team.topologyPattern,
		})
	);
	e.dataTransfer.effectAllowed = 'move';
}

export const TeamDrawer = memo(function TeamDrawer({
	isOpen,
	onClose,
	teams,
	onCanvasTemplateIds,
	theme,
	shareRight,
	onManageTeams,
}: TeamDrawerProps) {
	const [search, setSearch] = useState('');
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Auto-focus search input when drawer opens
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	const filtered = useMemo(() => {
		if (!search.trim()) return teams;
		const q = search.toLowerCase();
		return teams.filter((t) => t.name.toLowerCase().includes(q));
	}, [teams, search]);

	return (
		<div
			style={{
				position: 'absolute',
				right: 0,
				top: shareRight ? '50%' : 0,
				bottom: 0,
				width: 'min(240px, 28vw)',
				zIndex: 20,
				backgroundColor: theme.colors.bgMain,
				borderLeft: `1px solid ${theme.colors.border}`,
				transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
				transition: 'transform 200ms ease, top 200ms ease',
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
				<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>Teams</span>
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
						placeholder="Search teams..."
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

			{/* Team list */}
			<div style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 8px' }}>
				{filtered.map((team) => {
					const isOnCanvas = onCanvasTemplateIds?.has(team.id) ?? false;
					return (
						<div
							key={team.id}
							draggable
							onDragStart={(e) => handleDragStart(e, team)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 8,
								padding: '8px 10px',
								marginBottom: 4,
								borderRadius: 6,
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
							<Users size={14} style={{ color: theme.colors.textDim, flexShrink: 0 }} />
							<div style={{ flex: 1, minWidth: 0 }}>
								<div
									style={{
										color: theme.colors.textMain,
										fontSize: 12,
										fontWeight: 500,
										whiteSpace: 'nowrap',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
									}}
								>
									{team.name}
								</div>
								<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
									{team.roleCount} role{team.roleCount !== 1 ? 's' : ''}
									{team.topologyPattern ? ` \u00b7 ${team.topologyPattern}` : ''}
								</div>
							</div>
							{isOnCanvas && (
								<div
									style={{
										width: 6,
										height: 6,
										borderRadius: '50%',
										backgroundColor: '#22c55e',
										flexShrink: 0,
									}}
									title="On canvas"
								/>
							)}
						</div>
					);
				})}
				{filtered.length === 0 && (
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 12,
							textAlign: 'center',
							padding: '20px 0',
						}}
					>
						{search ? 'No teams match' : 'No teams available'}
					</div>
				)}
			</div>

			{/* Manage Teams link */}
			{onManageTeams && (
				<div
					style={{
						padding: '8px 12px',
						borderTop: `1px solid ${theme.colors.border}`,
						flexShrink: 0,
					}}
				>
					<button
						onClick={onManageTeams}
						style={{
							width: '100%',
							padding: '6px 0',
							fontSize: 11,
							fontWeight: 500,
							color: theme.colors.accent,
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
							textAlign: 'center',
						}}
					>
						Manage Teams →
					</button>
				</div>
			)}
		</div>
	);
});
