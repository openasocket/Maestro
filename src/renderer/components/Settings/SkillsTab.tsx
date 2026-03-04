/**
 * SkillsTab - Skills sub-tab within MemorySettings.
 *
 * Card-based skill area management with:
 * - Filterable card grid grouped by parent persona
 * - Search by name/description
 * - Filter by persona, embedding status, capacity
 * - Capacity progress bars (green/yellow/red)
 * - Skill-level config (maxMemoriesPerSkillArea)
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Layers, Loader2, Search, Check, AlertTriangle, X } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats, Persona, SkillArea } from '../../../shared/memory-types';
import { ConfigSlider } from './MemoryConfigWidgets';
import { TabDescriptionBanner } from './TabDescriptionBanner';

export interface SkillsTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
}

/** Skill with resolved counts for display */
interface SkillCard extends SkillArea {
	memoryCount: number;
	personaName: string;
}

/** Persona group for card layout */
interface PersonaGroup {
	persona: Persona;
	skills: SkillCard[];
}

type EmbeddingFilter = 'all' | 'has' | 'missing';
type CapacityFilter = 'all' | 'near-full' | 'over';

export function SkillsTab({
	theme,
	config,
	stats: _stats,
	onUpdateConfig,
}: SkillsTabProps): React.ReactElement {
	// ─── Data state ─────────────────────────────────────────────────
	const [personas, setPersonas] = useState<Persona[]>([]);
	const [skills, setSkills] = useState<SkillArea[]>([]);
	const [memoryCounts, setMemoryCounts] = useState<Map<string, number>>(new Map());
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set());

	// ─── Filter state ───────────────────────────────────────────────
	const [searchQuery, setSearchQuery] = useState('');
	const [personaFilter, setPersonaFilter] = useState<string>('all');
	const [embeddingFilter, setEmbeddingFilter] = useState<EmbeddingFilter>('all');
	const [capacityFilter, setCapacityFilter] = useState<CapacityFilter>('all');

	const maxPerSkill = config.maxMemoriesPerSkillArea;

	// ─── Load skill data ────────────────────────────────────────────
	const loadData = useCallback(async () => {
		try {
			const [personasRes, skillsRes] = await Promise.all([
				window.maestro.memory.persona.list(),
				window.maestro.memory.skill.list(),
			]);
			if (personasRes.success) setPersonas(personasRes.data);
			if (skillsRes.success) {
				setSkills(skillsRes.data);

				// Load memory counts per skill
				const counts = new Map<string, number>();
				for (const skill of skillsRes.data) {
					try {
						const memRes = await window.maestro.memory.list('skill', skill.id, undefined, true);
						if (memRes.success) counts.set(skill.id, memRes.data.length);
					} catch {
						counts.set(skill.id, 0);
					}
				}
				setMemoryCounts(counts);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load skills');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (config.enabled) loadData();
	}, [config.enabled, loadData]);

	// ─── Build persona groups ───────────────────────────────────────
	const personaGroups = useMemo((): PersonaGroup[] => {
		const personaMap = new Map(personas.map((p) => [p.id, p]));

		const skillCards: SkillCard[] = skills.map((s) => ({
			...s,
			memoryCount: memoryCounts.get(s.id) ?? 0,
			personaName: personaMap.get(s.personaId)?.name ?? 'Unknown',
		}));

		// Apply filters
		const filtered = skillCards.filter((s) => {
			// Search
			if (searchQuery) {
				const q = searchQuery.toLowerCase();
				if (!s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) {
					return false;
				}
			}
			// Persona filter
			if (personaFilter !== 'all' && s.personaId !== personaFilter) return false;
			// Embedding filter
			const hasEmb = s.embedding && s.embedding.length > 0;
			if (embeddingFilter === 'has' && !hasEmb) return false;
			if (embeddingFilter === 'missing' && hasEmb) return false;
			// Capacity filter
			const ratio = s.memoryCount / maxPerSkill;
			if (capacityFilter === 'near-full' && ratio < 0.7) return false;
			if (capacityFilter === 'over' && ratio < 0.9) return false;
			return true;
		});

		// Group by persona
		const groups: PersonaGroup[] = [];
		const byPersona = new Map<string, SkillCard[]>();
		for (const s of filtered) {
			const list = byPersona.get(s.personaId) ?? [];
			list.push(s);
			byPersona.set(s.personaId, list);
		}

		for (const [personaId, personaSkills] of byPersona) {
			const persona = personaMap.get(personaId);
			if (persona) {
				groups.push({ persona, skills: personaSkills });
			} else {
				groups.push({
					persona: {
						id: personaId,
						roleId: '',
						name: 'Unknown Persona',
						description: '',
						systemPrompt: '',
						embedding: null,
						skillAreaIds: [],
						assignedAgents: [],
						assignedProjects: [],
						active: true,
						createdAt: 0,
						updatedAt: 0,
					},
					skills: personaSkills,
				});
			}
		}

		return groups;
	}, [
		skills,
		personas,
		memoryCounts,
		searchQuery,
		personaFilter,
		embeddingFilter,
		capacityFilter,
		maxPerSkill,
	]);

	// ─── Toggle description expansion ───────────────────────────────
	const toggleDescription = useCallback((id: string) => {
		setExpandedDescriptions((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// ─── Capacity color helper ──────────────────────────────────────
	const capacityColor = useCallback(
		(count: number): string => {
			const ratio = count / maxPerSkill;
			if (ratio > 0.9) return theme.colors.error;
			if (ratio >= 0.7) return theme.colors.warning;
			return theme.colors.success;
		},
		[maxPerSkill, theme.colors]
	);

	const hasActiveFilters =
		searchQuery || personaFilter !== 'all' || embeddingFilter !== 'all' || capacityFilter !== 'all';
	const totalFiltered = personaGroups.reduce((sum, g) => sum + g.skills.length, 0);

	return (
		<div className="space-y-4">
			<TabDescriptionBanner
				theme={theme}
				description="Skills are specific domains of expertise within a persona. They organize your memories into focused knowledge areas like 'Error Handling' or 'API Design'. The system matches incoming tasks to relevant skills to find the right memories."
			/>

			{/* Skill-level config */}
			<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center gap-2">
					<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Skill Configuration
					</div>
				</div>

				<ConfigSlider
					label="Max Memories per Skill Area"
					description="Prune oldest memories above this limit"
					value={config.maxMemoriesPerSkillArea}
					min={10}
					max={200}
					step={10}
					onChange={(v) => onUpdateConfig({ maxMemoriesPerSkillArea: v })}
					theme={theme}
				/>
			</div>

			{/* Error banner */}
			{error && (
				<div
					className="flex items-center gap-2 rounded-lg border px-4 py-2 text-xs"
					style={{
						borderColor: theme.colors.error,
						color: theme.colors.error,
						backgroundColor: `${theme.colors.error}10`,
					}}
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					<span className="flex-1">{error}</span>
					<button className="p-0.5 hover:opacity-70" onClick={() => setError(null)}>
						<X className="w-3 h-3" />
					</button>
				</div>
			)}

			{/* ─── Filter Bar ────────────────────────────────────────── */}
			{!loading && skills.length > 0 && (
				<div
					className="rounded-lg border p-3 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Search input */}
					<div className="relative">
						<Search
							className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3"
							style={{ color: theme.colors.textDim }}
						/>
						<input
							type="text"
							placeholder="Search skills by name or description..."
							className="w-full pl-8 pr-3 py-1.5 rounded border bg-transparent text-xs outline-none"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>
						{searchQuery && (
							<button
								className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 hover:opacity-70"
								onClick={() => setSearchQuery('')}
							>
								<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							</button>
						)}
					</div>

					{/* Filter dropdowns */}
					<div className="flex flex-wrap gap-2">
						{/* Persona filter */}
						<select
							className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							value={personaFilter}
							onChange={(e) => setPersonaFilter(e.target.value)}
						>
							<option value="all">All personas</option>
							{personas.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>

						{/* Embedding filter */}
						<select
							className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							value={embeddingFilter}
							onChange={(e) => setEmbeddingFilter(e.target.value as EmbeddingFilter)}
						>
							<option value="all">All embeddings</option>
							<option value="has">Has embedding</option>
							<option value="missing">Missing embedding</option>
						</select>

						{/* Capacity filter */}
						<select
							className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							value={capacityFilter}
							onChange={(e) => setCapacityFilter(e.target.value as CapacityFilter)}
						>
							<option value="all">All capacity</option>
							<option value="near-full">Near full (&gt;70%)</option>
							<option value="over">Over capacity (&gt;90%)</option>
						</select>

						{/* Clear filters */}
						{hasActiveFilters && (
							<button
								className="px-2 py-1 rounded text-xs hover:opacity-70"
								style={{ color: theme.colors.accent }}
								onClick={() => {
									setSearchQuery('');
									setPersonaFilter('all');
									setEmbeddingFilter('all');
									setCapacityFilter('all');
								}}
							>
								Clear filters
							</button>
						)}
					</div>

					{/* Filter result count */}
					{hasActiveFilters && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Showing {totalFiltered} of {skills.length} skills
						</div>
					)}
				</div>
			)}

			{/* ─── Skill Cards by Persona ────────────────────────────── */}
			{loading ? (
				<div className="flex items-center justify-center py-12">
					<Loader2 className="w-5 h-5 animate-spin" style={{ color: theme.colors.textDim }} />
				</div>
			) : skills.length === 0 ? (
				<div
					className="flex flex-col items-center justify-center py-12 gap-3"
					style={{ color: theme.colors.textDim }}
				>
					<Layers className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
					<div className="text-xs font-medium">
						No skills yet. Skills are created within personas or via hierarchy suggestions.
					</div>
				</div>
			) : personaGroups.length === 0 ? (
				<div
					className="flex flex-col items-center justify-center py-8 gap-3"
					style={{ color: theme.colors.textDim }}
				>
					<Search className="w-6 h-6" style={{ opacity: 0.5 }} />
					<div className="text-xs font-medium">No skills match the current filters</div>
				</div>
			) : (
				personaGroups.map((group) => (
					<div key={group.persona.id} className="space-y-2">
						{/* Persona header */}
						<div className="flex items-center gap-2 pt-2">
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: theme.colors.accent }}
							/>
							<div
								className="text-xs font-bold uppercase tracking-wider"
								style={{ color: theme.colors.textDim }}
							>
								{group.persona.name}
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
								({group.skills.length})
							</div>
						</div>

						{/* Skill cards */}
						<div
							className="grid gap-3"
							style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
						>
							{group.skills.map((skill) => (
								<SkillCardView
									key={skill.id}
									skill={skill}
									theme={theme}
									maxPerSkill={maxPerSkill}
									capacityColor={capacityColor}
									isDescExpanded={expandedDescriptions.has(skill.id)}
									onToggleDescription={() => toggleDescription(skill.id)}
								/>
							))}
						</div>
					</div>
				))
			)}
		</div>
	);
}

// ─── Skill Card Component ───────────────────────────────────────────────────

function SkillCardView({
	skill,
	theme,
	maxPerSkill,
	capacityColor,
	isDescExpanded,
	onToggleDescription,
}: {
	skill: SkillCard;
	theme: Theme;
	maxPerSkill: number;
	capacityColor: (count: number) => string;
	isDescExpanded: boolean;
	onToggleDescription: () => void;
}) {
	const hasEmbedding = skill.embedding && skill.embedding.length > 0;
	const ratio = Math.min(skill.memoryCount / maxPerSkill, 1);
	const color = capacityColor(skill.memoryCount);

	return (
		<div
			className="rounded-lg border p-4 space-y-2.5"
			style={{
				borderColor: skill.active ? theme.colors.border : `${theme.colors.border}80`,
				opacity: skill.active ? 1 : 0.7,
			}}
		>
			{/* Header: name + active dot */}
			<div className="flex items-center gap-2 min-w-0">
				<div
					className="w-2 h-2 rounded-full shrink-0"
					style={{
						backgroundColor: skill.active ? theme.colors.success : theme.colors.textDim,
					}}
					title={skill.active ? 'Active' : 'Inactive'}
				/>
				<div className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
					{skill.name}
				</div>
			</div>

			{/* Persona badge + embedding status */}
			<div className="flex items-center gap-2">
				<span
					className="px-2 py-0.5 rounded text-xs"
					style={{ backgroundColor: `${theme.colors.accent}15`, color: theme.colors.accent }}
				>
					{skill.personaName}
				</span>
				{hasEmbedding ? (
					<span
						className="flex items-center gap-0.5 text-xs"
						style={{ color: theme.colors.success }}
						title="Embedding ready"
					>
						<Check className="w-3 h-3" />
					</span>
				) : (
					<span
						className="flex items-center gap-0.5 text-xs"
						style={{ color: theme.colors.warning }}
						title="Missing embedding — will not be matched to tasks"
					>
						<AlertTriangle className="w-3 h-3" />
					</span>
				)}
			</div>

			{/* Description (truncated, expandable) */}
			{skill.description && (
				<div
					className="text-xs cursor-pointer"
					style={{ color: theme.colors.textDim }}
					onClick={onToggleDescription}
				>
					{isDescExpanded
						? skill.description
						: skill.description.length > 100
							? skill.description.slice(0, 100) + '...'
							: skill.description}
				</div>
			)}

			{/* Memory count + capacity bar */}
			<div className="space-y-1">
				<div className="flex items-center justify-between text-xs">
					<span style={{ color: theme.colors.textDim }}>
						{skill.memoryCount} / {maxPerSkill} memories
					</span>
					<span style={{ color }}>{Math.round(ratio * 100)}%</span>
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: `${theme.colors.border}40` }}
				>
					<div
						className="h-full rounded-full transition-all"
						style={{
							width: `${ratio * 100}%`,
							backgroundColor: color,
						}}
					/>
				</div>
			</div>
		</div>
	);
}
