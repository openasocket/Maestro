import React, { useState, useMemo, useEffect } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import type { Theme } from '../../types';
import type { Persona, Role } from '../../../shared/memory-types';
import type { MatchedPersona } from '../../hooks/memory/usePersonaSelection';
import { PersonaCard } from './PersonaCard';

export interface PersonaPickerProps {
	theme: Theme;
	matchedPersonas: MatchedPersona[];
	allPersonas: Persona[];
	selectedIds: Set<string>;
	onToggle: (personaId: string) => void;
	isLoading: boolean;
	isMemoryEnabled: boolean;
	mode: 'wizard' | 'manual';
	compact?: boolean;
}

export function PersonaPicker({
	theme,
	matchedPersonas,
	allPersonas,
	selectedIds,
	onToggle,
	isLoading,
	isMemoryEnabled,
	mode,
	compact,
}: PersonaPickerProps): React.ReactElement {
	const [browseExpanded, setBrowseExpanded] = useState(false);
	const [filterText, setFilterText] = useState('');
	const [roleNameMap, setRoleNameMap] = useState<Record<string, string>>({});

	// Load role names for display
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await window.maestro.memory.role.list();
				if (!cancelled && result.success && result.data) {
					const map: Record<string, string> = {};
					for (const role of result.data as Role[]) {
						map[role.id] = role.name;
					}
					setRoleNameMap(map);
				}
			} catch {
				// Memory system unavailable — roleId used as fallback
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [allPersonas]);

	const resolveRoleName = (roleId: string): string => roleNameMap[roleId] ?? roleId;

	// Memory disabled state
	if (!isMemoryEnabled) {
		return (
			<div
				style={{
					padding: '12px 16px',
					color: theme.colors.textDim,
					fontSize: 12,
					fontStyle: 'italic',
					background: theme.colors.bgMain,
					borderRadius: 6,
					border: `1px dashed ${theme.colors.border}`,
				}}
			>
				Enable Agent Experiences in Settings to select personas.
			</div>
		);
	}

	// Loading state
	if (isLoading) {
		return (
			<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
				{[1, 2, 3].map((i) => (
					<div
						key={i}
						style={{
							flex: '1 1 260px',
							maxWidth: 340,
							height: compact ? 56 : 64,
							background: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
							borderRadius: 6,
							animation: 'pulse 1.5s ease-in-out infinite',
						}}
					/>
				))}
			</div>
		);
	}

	// Empty state
	if (allPersonas.length === 0 && matchedPersonas.length === 0) {
		return (
			<div
				style={{
					padding: '12px 16px',
					color: theme.colors.textDim,
					fontSize: 12,
					fontStyle: 'italic',
					background: theme.colors.bgMain,
					borderRadius: 6,
					border: `1px dashed ${theme.colors.border}`,
				}}
			>
				No personas available.
			</div>
		);
	}

	if (mode === 'wizard') {
		return (
			<WizardLayout
				theme={theme}
				matchedPersonas={matchedPersonas}
				allPersonas={allPersonas}
				selectedIds={selectedIds}
				onToggle={onToggle}
				browseExpanded={browseExpanded}
				setBrowseExpanded={setBrowseExpanded}
				resolveRoleName={resolveRoleName}
				compact={compact}
			/>
		);
	}

	return (
		<ManualLayout
			theme={theme}
			matchedPersonas={matchedPersonas}
			allPersonas={allPersonas}
			selectedIds={selectedIds}
			onToggle={onToggle}
			filterText={filterText}
			setFilterText={setFilterText}
			resolveRoleName={resolveRoleName}
			compact={compact}
		/>
	);
}

// ─── Wizard Mode ─────────────────────────────────────────────────────────

function WizardLayout({
	theme,
	matchedPersonas,
	allPersonas,
	selectedIds,
	onToggle,
	browseExpanded,
	setBrowseExpanded,
	resolveRoleName,
	compact,
}: {
	theme: Theme;
	matchedPersonas: MatchedPersona[];
	allPersonas: Persona[];
	selectedIds: Set<string>;
	onToggle: (id: string) => void;
	browseExpanded: boolean;
	setBrowseExpanded: (v: boolean) => void;
	resolveRoleName: (roleId: string) => string;
	compact?: boolean;
}): React.ReactElement {
	const matchedIds = new Set(matchedPersonas.map((p) => p.personaId));
	const unmatched = allPersonas.filter((p) => p.active && !matchedIds.has(p.id));
	const noMatches = matchedPersonas.length === 0 && unmatched.length > 0;

	// Group unmatched by role (for browse all)
	const groupedUnmatched = useMemo(() => {
		const groups = new Map<string, Persona[]>();
		for (const p of unmatched) {
			const group = groups.get(p.roleId) || [];
			group.push(p);
			groups.set(p.roleId, group);
		}
		return groups;
	}, [unmatched]);

	// Auto-expand browse when no matches found
	const isExpanded = noMatches || browseExpanded;

	return (
		<div
			style={{
				maxHeight: 300,
				overflowY: 'auto',
			}}
		>
			{matchedPersonas.length > 0 && (
				<>
					<div
						style={{
							fontSize: 12,
							fontWeight: 600,
							color: theme.colors.textDim,
							marginBottom: 8,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						Recommended Personas
					</div>
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
						{matchedPersonas
							.sort((a, b) => b.similarity - a.similarity)
							.map((mp) => (
								<PersonaCard
									key={mp.personaId}
									theme={theme}
									personaId={mp.personaId}
									personaName={mp.personaName}
									roleName={mp.roleName}
									description={mp.description}
									similarity={mp.similarity}
									isSelected={selectedIds.has(mp.personaId)}
									onToggle={onToggle}
									compact={compact}
								/>
							))}
					</div>
				</>
			)}

			{noMatches && (
				<div
					style={{
						padding: '8px 0',
						color: theme.colors.textDim,
						fontSize: 12,
						fontStyle: 'italic',
						marginBottom: 8,
					}}
				>
					No matches found — browse all personas below.
				</div>
			)}

			{unmatched.length > 0 && (
				<div>
					{!noMatches && (
						<button
							onClick={() => setBrowseExpanded(!browseExpanded)}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 6,
								background: 'none',
								border: 'none',
								cursor: 'pointer',
								color: theme.colors.textDim,
								fontSize: 12,
								padding: '4px 0',
							}}
						>
							<ChevronRight
								size={12}
								style={{
									transform: isExpanded ? 'rotate(90deg)' : 'none',
									transition: 'transform 150ms',
								}}
							/>
							Browse all personas ({unmatched.length})
						</button>
					)}

					{isExpanded && (
						<div style={{ marginTop: 8 }}>
							{Array.from(groupedUnmatched.entries()).map(([roleId, personas]) => (
								<div key={roleId} style={{ marginBottom: 8 }}>
									<div
										style={{
											fontSize: 11,
											fontWeight: 600,
											color: theme.colors.textDim,
											marginBottom: 4,
										}}
									>
										{resolveRoleName(roleId)}
									</div>
									<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
										{personas
											.sort((a, b) => a.name.localeCompare(b.name))
											.map((p) => (
												<PersonaCard
													key={p.id}
													theme={theme}
													personaId={p.id}
													personaName={p.name}
													roleName={resolveRoleName(p.roleId)}
													description={p.description}
													isSelected={selectedIds.has(p.id)}
													onToggle={onToggle}
													compact={compact}
												/>
											))}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Manual Mode ─────────────────────────────────────────────────────────

function ManualLayout({
	theme,
	matchedPersonas,
	allPersonas,
	selectedIds,
	onToggle,
	filterText,
	setFilterText,
	resolveRoleName,
	compact,
}: {
	theme: Theme;
	matchedPersonas: MatchedPersona[];
	allPersonas: Persona[];
	selectedIds: Set<string>;
	onToggle: (id: string) => void;
	filterText: string;
	setFilterText: (v: string) => void;
	resolveRoleName: (roleId: string) => string;
	compact?: boolean;
}): React.ReactElement {
	const matchedIds = new Set(matchedPersonas.map((p) => p.personaId));
	const lowerFilter = filterText.toLowerCase();

	const filtered = useMemo(() => {
		const active = allPersonas.filter((p) => p.active);
		if (!lowerFilter) return active;
		return active.filter(
			(p) =>
				p.name.toLowerCase().includes(lowerFilter) ||
				p.description.toLowerCase().includes(lowerFilter) ||
				resolveRoleName(p.roleId).toLowerCase().includes(lowerFilter)
		);
	}, [allPersonas, lowerFilter, resolveRoleName]);

	// Group by roleId
	const grouped = useMemo(() => {
		const groups = new Map<string, Persona[]>();
		for (const p of filtered) {
			const group = groups.get(p.roleId) || [];
			group.push(p);
			groups.set(p.roleId, group);
		}
		return groups;
	}, [filtered]);

	// Suggested personas (from use-case description match)
	const suggested = matchedPersonas.filter((mp) => filtered.some((p) => p.id === mp.personaId));

	return (
		<div
			style={{
				maxHeight: 400,
				overflowY: 'auto',
			}}
		>
			{/* Section header */}
			<div
				style={{
					fontSize: 12,
					fontWeight: 600,
					color: theme.colors.textDim,
					marginBottom: 8,
					textTransform: 'uppercase',
					letterSpacing: '0.5px',
				}}
			>
				Select Personas
			</div>

			{/* Filter input */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 6,
					padding: '6px 10px',
					background: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
					borderRadius: 6,
					marginBottom: 10,
				}}
			>
				<Search size={13} color={theme.colors.textDim} />
				<input
					type="text"
					value={filterText}
					onChange={(e) => setFilterText(e.target.value)}
					placeholder="Filter personas..."
					style={{
						background: 'none',
						border: 'none',
						outline: 'none',
						color: theme.colors.textMain,
						fontSize: 12,
						width: '100%',
					}}
				/>
			</div>

			{/* Suggested section */}
			{suggested.length > 0 && (
				<>
					<div
						style={{
							fontSize: 11,
							fontWeight: 600,
							color: theme.colors.textDim,
							marginBottom: 6,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
						}}
					>
						Suggested
					</div>
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
						{suggested
							.sort((a, b) => b.similarity - a.similarity)
							.map((mp) => (
								<PersonaCard
									key={mp.personaId}
									theme={theme}
									personaId={mp.personaId}
									personaName={mp.personaName}
									roleName={mp.roleName}
									description={mp.description}
									similarity={mp.similarity}
									isSelected={selectedIds.has(mp.personaId)}
									onToggle={onToggle}
									compact={compact}
								/>
							))}
					</div>
				</>
			)}

			{/* All personas grouped by role */}
			{Array.from(grouped.entries()).map(([roleId, personas]) => {
				// Skip personas already shown in suggested
				const nonSuggested = personas.filter((p) => !matchedIds.has(p.id));
				if (nonSuggested.length === 0 && suggested.length > 0) return null;
				const displayPersonas = suggested.length > 0 ? nonSuggested : personas;
				if (displayPersonas.length === 0) return null;

				return (
					<div key={roleId} style={{ marginBottom: 10 }}>
						<div
							style={{
								fontSize: 11,
								fontWeight: 600,
								color: theme.colors.textDim,
								marginBottom: 4,
							}}
						>
							{resolveRoleName(roleId)}
						</div>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
							{displayPersonas
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((p) => (
									<PersonaCard
										key={p.id}
										theme={theme}
										personaId={p.id}
										personaName={p.name}
										roleName={resolveRoleName(p.roleId)}
										description={p.description}
										isSelected={selectedIds.has(p.id)}
										onToggle={onToggle}
										compact={compact}
									/>
								))}
						</div>
					</div>
				);
			})}

			{filtered.length === 0 && (
				<div
					style={{
						padding: '12px 16px',
						color: theme.colors.textDim,
						fontSize: 12,
						fontStyle: 'italic',
					}}
				>
					No personas match your filter.
				</div>
			)}
		</div>
	);
}
