/**
 * All Experiences Panel
 *
 * Aggregated view of all experiences across skill, project, and global scopes.
 * Supports sorting, filtering, inline confidence editing, and opens MemoryEditModal
 * for full editing including scope reassignment.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Search,
	Loader2,
	Brain,
	Pin,
	PinOff,
	Edit3,
	Trash2,
	ChevronDown,
	ChevronRight,
	Clock,
	BarChart3,
	Sparkles,
	Hash,
	ArrowUpDown,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryEntry, MemoryScope, SkillAreaId } from '../../../shared/memory-types';
import type { UseMemoryHierarchyReturn } from '../../hooks/memory/useMemoryHierarchy';
import { MemoryEditModal } from './MemoryEditModal';

// ─── Types ────────────────────────────────────────────────────────────────

type EnrichedExperience = MemoryEntry & {
	scopeLabel: string;
	skillAreaName?: string;
	personaName?: string;
};

type SortField = 'date' | 'confidence' | 'scope' | 'category';
type ScopeFilter = 'all' | 'skill' | 'project' | 'global';

interface AllExperiencesPanelProps {
	theme: Theme;
	projectPath: string | null;
	hierarchy: UseMemoryHierarchyReturn;
	onCountChange?: (count: number) => void;
}

// ─── Utility ──────────────────────────────────────────────────────────────

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

function getCategoryFromTags(tags: string[]): string | null {
	const cat = tags.find((t) => t.startsWith('category:'));
	return cat ? cat.slice('category:'.length) : null;
}

// ─── Experience Card ──────────────────────────────────────────────────────

function ExperienceCard({
	experience,
	theme,
	onEdit,
	onTogglePin,
	onDelete,
}: {
	experience: EnrichedExperience;
	theme: Theme;
	onEdit: () => void;
	onTogglePin: () => void;
	onDelete: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [contextExpanded, setContextExpanded] = useState(false);

	const category = getCategoryFromTags(experience.tags);
	const hasContext = experience.experienceContext;

	return (
		<div
			className="rounded-lg border p-3 space-y-2 transition-colors"
			style={{
				borderColor: experience.pinned ? theme.colors.accent : theme.colors.border,
				backgroundColor: experience.pinned ? `${theme.colors.accent}05` : 'transparent',
			}}
		>
			{/* Header row */}
			<div className="flex items-center gap-2 flex-wrap">
				{/* Scope badge */}
				<span
					className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{experience.scopeLabel}
				</span>

				{/* Category badge */}
				{category && (
					<span
						className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
						}}
					>
						{category}
					</span>
				)}

				{/* Source badge */}
				<span
					className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: `${theme.colors.border}40`,
						color: theme.colors.textDim,
					}}
				>
					{experience.source}
				</span>

				{/* Created date */}
				<span className="text-[10px] shrink-0 ml-auto" style={{ color: theme.colors.textDim }}>
					{formatRelativeTime(experience.createdAt)}
				</span>

				{/* Action buttons */}
				<button
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: experience.pinned ? theme.colors.accent : theme.colors.textDim }}
					title={experience.pinned ? 'Unpin' : 'Pin'}
					onClick={onTogglePin}
				>
					{experience.pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
				</button>
				<button
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Edit"
					onClick={onEdit}
				>
					<Edit3 className="w-3 h-3" />
				</button>
				<button
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.error }}
					title="Delete"
					onClick={onDelete}
				>
					<Trash2 className="w-3 h-3" />
				</button>
			</div>

			{/* Content */}
			<div
				className="text-xs leading-relaxed cursor-pointer"
				style={{ color: theme.colors.textMain }}
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					experience.content
				) : (
					<span>
						{experience.content.length > 200
							? `${experience.content.slice(0, 200)}...`
							: experience.content}
					</span>
				)}
			</div>

			{/* Experience context — expandable */}
			{hasContext && experience.experienceContext && (
				<div>
					<button
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
						onClick={() => setContextExpanded(!contextExpanded)}
					>
						{contextExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						Context
					</button>
					{contextExpanded && (
						<div className="mt-1 pl-4 space-y-1 text-xs" style={{ color: theme.colors.textDim }}>
							{experience.experienceContext.situation && (
								<div>
									<span className="font-medium">Situation:</span>{' '}
									{experience.experienceContext.situation}
								</div>
							)}
							{experience.experienceContext.learning && (
								<div>
									<span className="font-medium">Learning:</span>{' '}
									{experience.experienceContext.learning}
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{/* Tags */}
			{experience.tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{experience.tags.map((tag) => (
						<span
							key={tag}
							className="text-[10px] px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{tag}
						</span>
					))}
				</div>
			)}

			{/* Meta row */}
			<div className="flex items-center gap-3 text-[10px]" style={{ color: theme.colors.textDim }}>
				{/* Confidence bar */}
				<div
					className="flex items-center gap-1"
					title={`Confidence: ${(experience.confidence * 100).toFixed(0)}%`}
				>
					<BarChart3 className="w-3 h-3" />
					<div
						className="w-12 h-1 rounded-full"
						style={{ backgroundColor: `${theme.colors.border}60` }}
					>
						<div
							className="h-1 rounded-full"
							style={{
								width: `${experience.confidence * 100}%`,
								backgroundColor: theme.colors.accent,
							}}
						/>
					</div>
					<span>{(experience.confidence * 100).toFixed(0)}%</span>
				</div>

				{/* Effectiveness */}
				{experience.effectivenessScore > 0 && (
					<div className="flex items-center gap-1" title="Effectiveness">
						<Sparkles className="w-3 h-3" />
						{(experience.effectivenessScore * 100).toFixed(0)}%
					</div>
				)}

				{/* Use count */}
				{experience.useCount > 0 && (
					<div className="flex items-center gap-1" title="Times used">
						<Hash className="w-3 h-3" />
						{experience.useCount}
					</div>
				)}

				{/* Last used */}
				{experience.lastUsedAt > 0 && (
					<div className="flex items-center gap-1" title="Last used">
						<Clock className="w-3 h-3" />
						{formatRelativeTime(experience.lastUsedAt)}
					</div>
				)}
			</div>
		</div>
	);
}

// ─── Main Component ───────────────────────────────────────────────────────

export function AllExperiencesPanel({
	theme,
	projectPath,
	hierarchy,
	onCountChange,
}: AllExperiencesPanelProps): React.ReactElement {
	const [experiences, setExperiences] = useState<EnrichedExperience[]>([]);
	const [loading, setLoading] = useState(true);
	const [searchQuery, setSearchQuery] = useState('');
	const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
	const [sortField, setSortField] = useState<SortField>('date');
	const [editingMemory, setEditingMemory] = useState<EnrichedExperience | null>(null);

	// Available skills for the edit modal
	const availableSkills = useMemo(
		() =>
			hierarchy.skillAreas.map((s) => ({
				id: s.id,
				name: s.name,
				personaName: hierarchy.personas.find((p) => p.id === s.personaId)?.name ?? 'Unknown',
			})),
		[hierarchy.skillAreas, hierarchy.personas]
	);

	// Fetch all experiences
	const fetchExperiences = useCallback(async () => {
		setLoading(true);
		try {
			const res = await window.maestro.memory.listAllExperiences(projectPath ?? undefined);
			if (res.success) {
				setExperiences(res.data);
				onCountChange?.(res.data.length);
			}
		} catch {
			// Fetch error — non-critical
		} finally {
			setLoading(false);
		}
	}, [projectPath, onCountChange]);

	useEffect(() => {
		fetchExperiences();
	}, [fetchExperiences]);

	// Filter and sort
	const filtered = useMemo(() => {
		let result = experiences;

		// Scope filter
		if (scopeFilter !== 'all') {
			result = result.filter((e) => e.scope === scopeFilter);
		}

		// Keyword search
		if (searchQuery.length >= 2) {
			const q = searchQuery.toLowerCase();
			result = result.filter(
				(e) =>
					e.content.toLowerCase().includes(q) ||
					e.scopeLabel.toLowerCase().includes(q) ||
					e.tags.some((t) => t.toLowerCase().includes(q)) ||
					e.experienceContext?.situation?.toLowerCase().includes(q) ||
					e.experienceContext?.learning?.toLowerCase().includes(q)
			);
		}

		// Sort
		return [...result].sort((a, b) => {
			switch (sortField) {
				case 'date':
					return b.createdAt - a.createdAt;
				case 'confidence':
					return b.confidence - a.confidence;
				case 'scope':
					return a.scopeLabel.localeCompare(b.scopeLabel);
				case 'category': {
					const catA = getCategoryFromTags(a.tags) ?? '';
					const catB = getCategoryFromTags(b.tags) ?? '';
					return catA.localeCompare(catB);
				}
				default:
					return 0;
			}
		});
	}, [experiences, scopeFilter, searchQuery, sortField]);

	// ─── Handlers ─────────────────────────────────────────────────────────

	const handleTogglePin = useCallback(
		async (exp: EnrichedExperience) => {
			try {
				await window.maestro.memory.update(
					exp.id,
					{ pinned: !exp.pinned },
					exp.scope,
					exp.skillAreaId,
					exp.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
				await fetchExperiences();
			} catch {
				// Update error
			}
		},
		[projectPath, fetchExperiences]
	);

	const handleDelete = useCallback(
		async (exp: EnrichedExperience) => {
			try {
				await window.maestro.memory.delete(
					exp.id,
					exp.scope,
					exp.skillAreaId,
					exp.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
				await fetchExperiences();
			} catch {
				// Delete error
			}
		},
		[projectPath, fetchExperiences]
	);

	const handleSaveEdit = useCallback(
		async (data: {
			content: string;
			type: 'rule' | 'experience';
			scope: MemoryScope;
			skillAreaId?: SkillAreaId;
			tags: string[];
			confidence: number;
			pinned: boolean;
			experienceContext?: MemoryEntry['experienceContext'];
		}) => {
			if (!editingMemory) return;

			const scopeChanged =
				data.scope !== editingMemory.scope || data.skillAreaId !== editingMemory.skillAreaId;

			if (scopeChanged) {
				// Move to new scope
				await window.maestro.memory.moveScope(
					editingMemory.id,
					editingMemory.scope,
					editingMemory.skillAreaId,
					editingMemory.scope === 'project' ? (projectPath ?? undefined) : undefined,
					data.scope,
					data.skillAreaId,
					data.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
			} else {
				// Update in place
				await window.maestro.memory.update(
					editingMemory.id,
					{
						content: data.content,
						type: data.type,
						tags: data.tags,
						confidence: data.confidence,
						pinned: data.pinned,
						experienceContext: data.experienceContext,
					},
					editingMemory.scope,
					editingMemory.skillAreaId,
					editingMemory.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
			}

			await fetchExperiences();
		},
		[editingMemory, projectPath, fetchExperiences]
	);

	// ─── Render ───────────────────────────────────────────────────────────

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div
				className="shrink-0 px-3 py-2 border-b space-y-2"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Title row */}
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						All Experiences
					</div>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{filtered.length} experience{filtered.length === 1 ? '' : 's'}
					</span>
				</div>

				{/* Search bar */}
				<div
					className="flex items-center gap-2 px-2 py-1.5 rounded-lg border"
					style={{ borderColor: theme.colors.border }}
				>
					<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search experiences..."
						className="flex-1 bg-transparent outline-none text-xs"
						style={{ color: theme.colors.textMain }}
					/>
				</div>

				{/* Filters row */}
				<div className="flex items-center gap-1.5 flex-wrap">
					{/* Scope filters */}
					{(['all', 'skill', 'project', 'global'] as ScopeFilter[]).map((f) => (
						<button
							key={f}
							className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
							style={{
								backgroundColor: scopeFilter === f ? `${theme.colors.accent}20` : 'transparent',
								color: scopeFilter === f ? theme.colors.accent : theme.colors.textDim,
								border: `1px solid ${scopeFilter === f ? theme.colors.accent : theme.colors.border}`,
							}}
							onClick={() => setScopeFilter(f)}
						>
							{f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
						</button>
					))}

					{/* Sort selector */}
					<div className="flex items-center gap-1 ml-auto">
						<ArrowUpDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<select
							value={sortField}
							onChange={(e) => setSortField(e.target.value as SortField)}
							className="bg-transparent outline-none text-[10px] rounded px-1 py-0.5 border"
							style={{
								color: theme.colors.textMain,
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgSidebar,
							}}
						>
							<option value="date">Date</option>
							<option value="confidence">Confidence</option>
							<option value="scope">Scope</option>
							<option value="category">Category</option>
						</select>
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
				{loading && (
					<div
						className="flex items-center justify-center py-4 gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<Loader2 className="w-4 h-4 animate-spin" />
						<span className="text-xs">Loading experiences...</span>
					</div>
				)}

				{!loading && filtered.length === 0 && (
					<div className="flex flex-col items-center justify-center py-8 gap-2">
						<Brain className="w-6 h-6 opacity-20" style={{ color: theme.colors.textDim }} />
						<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
							{searchQuery || scopeFilter !== 'all'
								? 'No experiences match your filters.'
								: 'No experiences extracted yet.'}
						</div>
					</div>
				)}

				{filtered.map((exp) => (
					<ExperienceCard
						key={exp.id}
						experience={exp}
						theme={theme}
						onEdit={() => setEditingMemory(exp)}
						onTogglePin={() => handleTogglePin(exp)}
						onDelete={() => handleDelete(exp)}
					/>
				))}
			</div>

			{/* Edit Modal */}
			{editingMemory && (
				<MemoryEditModal
					theme={theme}
					memory={editingMemory}
					defaultScope={editingMemory.scope}
					defaultSkillAreaId={editingMemory.skillAreaId}
					availableSkills={availableSkills}
					onSave={handleSaveEdit}
					onClose={() => setEditingMemory(null)}
				/>
			)}
		</div>
	);
}
