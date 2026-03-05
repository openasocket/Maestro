/**
 * SkillsTab - Skills sub-tab within MemorySettings.
 *
 * Card-based skill area management with:
 * - Filterable card grid grouped by parent persona
 * - Search by name/description
 * - Filter by persona, embedding status, capacity
 * - Capacity progress bars (green/yellow/red)
 * - Skill-level config (maxMemoriesPerSkillArea)
 * - CRUD actions (edit, view memories, move, merge, re-embed, delete)
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Layers,
	Loader2,
	Search,
	Check,
	AlertTriangle,
	X,
	Edit3,
	List,
	ArrowRight,
	GitMerge,
	RefreshCw,
	Trash2,
	Plus,
	BarChart3,
	AlertCircle,
	Archive,
	Download,
	Upload,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryEntry,
	MemoryStats,
	MemoryType,
	Persona,
	SkillArea,
} from '../../../shared/memory-types';
import { ConfigSlider } from './MemoryConfigWidgets';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';
import { SkillEditModal } from './HierarchyEditModals';

export interface SkillsTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	/** Navigate to Memories tab filtered by skill area */
	onViewMemories?: (skillAreaId: string) => void;
	/** Called when hierarchy structure changes (skills created/deleted/moved) */
	onHierarchyChange?: () => void;
	/** Called when user creates/edits/deletes — promotes engagement level to Active Curator */
	onCuratorAction?: () => void;
	/** User engagement level for progressive disclosure (0=passive, 1=aware, 2=active curator) */
	engagementLevel?: number;
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
	onViewMemories,
	onHierarchyChange,
	onCuratorAction,
	engagementLevel = 2,
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

	// ─── Action state ───────────────────────────────────────────────
	const [actionLoading, setActionLoading] = useState<string | null>(null);
	const [editingSkill, setEditingSkill] = useState<SkillArea | null>(null);
	const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ skill: SkillCard } | null>(null);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [createPersonaId, setCreatePersonaId] = useState<string>('');
	const [moveTarget, setMoveTarget] = useState<{ skill: SkillCard; personaId: string } | null>(
		null
	);
	const [mergeTarget, setMergeTarget] = useState<{ source: SkillCard; targetId: string } | null>(
		null
	);

	// ─── Import/Export state ────────────────────────────────────────────
	const [exportIncludeMemories, setExportIncludeMemories] = useState(false);
	const [exportLoading, setExportLoading] = useState(false);
	const [importPreview, setImportPreview] = useState<{
		skills: Array<{ name: string; personaName: string; memoryCount: number }>;
		raw: SkillExportData;
	} | null>(null);
	const [importTargetPersonaId, setImportTargetPersonaId] = useState<string>('');

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

	// ─── Visualization stats ────────────────────────────────────────
	const vizStats = useMemo(() => {
		const allCards: SkillCard[] = skills.map((s) => ({
			...s,
			memoryCount: memoryCounts.get(s.id) ?? 0,
			personaName: personas.find((p) => p.id === s.personaId)?.name ?? 'Unknown',
		}));

		const activeCount = allCards.filter((s) => s.active).length;
		const inactiveCount = allCards.length - activeCount;
		const withEmbedding = allCards.filter((s) => s.embedding && s.embedding.length > 0).length;
		const nearCapacity = allCards.filter((s) => s.memoryCount / maxPerSkill > 0.8).length;
		const emptySkills = allCards.filter((s) => s.memoryCount === 0).length;

		// Top 10 skills by memory count for distribution bar
		const sorted = [...allCards].sort((a, b) => b.memoryCount - a.memoryCount);
		const top10 = sorted.slice(0, 10);
		const otherCount = sorted.slice(10).reduce((sum, s) => sum + s.memoryCount, 0);
		const totalMemories = allCards.reduce((sum, s) => sum + s.memoryCount, 0);

		return {
			total: allCards.length,
			activeCount,
			inactiveCount,
			withEmbedding,
			nearCapacity,
			emptySkills,
			top10,
			otherCount,
			totalMemories,
		};
	}, [skills, memoryCounts, personas, maxPerSkill]);

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

	// ─── Action handlers ────────────────────────────────────────────

	const handleEdit = useCallback((skill: SkillCard) => {
		setEditingSkill(skill);
		setEditingPersonaId(skill.personaId);
	}, []);

	const handleSaveSkill = useCallback(
		async (data: { name: string; description: string }) => {
			if (editingSkill) {
				// Update existing skill
				const res = await window.maestro.memory.skill.update(editingSkill.id, {
					name: data.name,
					description: data.description,
				});
				if (!res.success) throw new Error(res.error ?? 'Failed to update skill');
			} else if (createPersonaId) {
				// Create new skill
				const res = await window.maestro.memory.skill.create(
					createPersonaId,
					data.name,
					data.description
				);
				if (!res.success) throw new Error(res.error ?? 'Failed to create skill');
				// Trigger embedding computation for the new skill
				try {
					await window.maestro.memory.ensureEmbeddings('skill', res.data.id);
				} catch {
					// Non-fatal: embedding can be re-triggered later
				}
			}
			setEditingSkill(null);
			setEditingPersonaId(null);
			setShowCreateModal(false);
			await loadData();
			onHierarchyChange?.();
			onCuratorAction?.();
		},
		[editingSkill, createPersonaId, loadData, onHierarchyChange, onCuratorAction]
	);

	const handleReEmbed = useCallback(
		async (skill: SkillCard) => {
			setActionLoading(`reembed:${skill.id}`);
			try {
				await window.maestro.memory.ensureEmbeddings('skill', skill.id);
				await loadData();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to re-embed skill');
			} finally {
				setActionLoading(null);
			}
		},
		[loadData]
	);

	const handleDeleteConfirmed = useCallback(async () => {
		if (!showDeleteConfirm) return;
		const { skill } = showDeleteConfirm;
		setActionLoading(`delete:${skill.id}`);
		try {
			const res = await window.maestro.memory.skill.delete(skill.id);
			if (!res.success) {
				setError(res.error ?? 'Failed to delete skill');
				return;
			}
			setShowDeleteConfirm(null);
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to delete skill');
		} finally {
			setActionLoading(null);
		}
	}, [showDeleteConfirm, loadData, onHierarchyChange]);

	const handleMoveConfirmed = useCallback(async () => {
		if (!moveTarget) return;
		const { skill, personaId } = moveTarget;
		if (personaId === skill.personaId) {
			setMoveTarget(null);
			return;
		}
		setActionLoading(`move:${skill.id}`);
		try {
			const res = await window.maestro.memory.skill.update(skill.id, {});
			// The skill.update API only supports name/description/active, so we need to
			// update the personaId. Use the IPC directly for updating personaId.
			// Since the preload skill.update doesn't expose personaId, we do it by
			// creating a new skill in the target persona, moving memories, then deleting the old one.
			const createRes = await window.maestro.memory.skill.create(
				personaId,
				skill.name,
				skill.description
			);
			if (!createRes.success) {
				setError(createRes.error ?? 'Failed to create skill in target persona');
				setActionLoading(null);
				return;
			}
			const newSkillId = createRes.data.id;

			// Move all memories from old skill to new skill
			const memRes = await window.maestro.memory.list('skill', skill.id, undefined, true);
			if (memRes.success) {
				for (const mem of memRes.data) {
					await window.maestro.memory.moveScope(
						mem.id,
						'skill',
						skill.id,
						undefined,
						'skill',
						newSkillId,
						undefined
					);
				}
			}

			// Delete old skill
			await window.maestro.memory.skill.delete(skill.id);

			// Re-embed new skill
			await window.maestro.memory.ensureEmbeddings('skill', newSkillId);

			// Suppress unused var warning for the initial update res
			void res;

			setMoveTarget(null);
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to move skill');
		} finally {
			setActionLoading(null);
		}
	}, [moveTarget, loadData, onHierarchyChange]);

	const handleMergeConfirmed = useCallback(async () => {
		if (!mergeTarget) return;
		const { source, targetId } = mergeTarget;
		if (targetId === source.id) {
			setMergeTarget(null);
			return;
		}
		setActionLoading(`merge:${source.id}`);
		try {
			// Move all memories from source skill to target skill
			const memRes = await window.maestro.memory.list('skill', source.id, undefined, true);
			if (memRes.success) {
				for (const mem of memRes.data) {
					await window.maestro.memory.moveScope(
						mem.id,
						'skill',
						source.id,
						undefined,
						'skill',
						targetId,
						undefined
					);
				}
			}

			// Delete the source skill
			await window.maestro.memory.skill.delete(source.id);

			setMergeTarget(null);
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to merge skills');
		} finally {
			setActionLoading(null);
		}
	}, [mergeTarget, loadData, onHierarchyChange]);

	// ─── Import/Export ──────────────────────────────────────────────

	const handleExportAll = useCallback(async () => {
		setExportLoading(true);
		try {
			const personaMap = new Map(personas.map((p) => [p.id, p]));
			const exportSkills: SkillExportData['skills'] = [];

			for (const skill of skills) {
				const persona = personaMap.get(skill.personaId);
				const entry: SkillExportData['skills'][number] = {
					name: skill.name,
					description: skill.description,
					active: skill.active,
					persona: { id: skill.personaId, name: persona?.name ?? 'Unknown' },
				};

				if (exportIncludeMemories) {
					try {
						const memRes = await window.maestro.memory.list('skill', skill.id, undefined, true);
						if (memRes.success) {
							entry.memories = memRes.data.map((m: MemoryEntry) => ({
								content: m.content,
								type: m.type,
								tags: m.tags,
								confidence: m.confidence,
								pinned: m.pinned,
							}));
						}
					} catch {
						// Non-fatal: skip memories for this skill
					}
				}

				exportSkills.push(entry);
			}

			const exportData: SkillExportData = {
				version: 1,
				exportedAt: new Date().toISOString(),
				skills: exportSkills,
			};

			downloadSkillJson(exportData, 'all-skills');
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to export skills');
		} finally {
			setExportLoading(false);
		}
	}, [skills, personas, exportIncludeMemories]);

	const handleImportFile = useCallback(() => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const data = JSON.parse(text) as SkillExportData;
				if (!data.version || !data.skills) {
					setError('Invalid skill export file');
					return;
				}
				setImportPreview({
					skills: data.skills.map((s) => ({
						name: s.name,
						personaName: s.persona?.name ?? 'Unknown',
						memoryCount: s.memories?.length ?? 0,
					})),
					raw: data,
				});
				if (personas.length > 0) setImportTargetPersonaId(personas[0].id);
			} catch {
				setError('Failed to parse import file');
			}
		};
		input.click();
	}, [personas]);

	const handleImportConfirm = useCallback(async () => {
		if (!importPreview || !importTargetPersonaId) return;
		setActionLoading('import');
		try {
			for (const exportedSkill of importPreview.raw.skills) {
				const skillRes = await window.maestro.memory.skill.create(
					importTargetPersonaId,
					exportedSkill.name,
					exportedSkill.description ?? ''
				);
				if (!skillRes.success) continue;

				// Trigger embedding
				try {
					await window.maestro.memory.ensureEmbeddings('skill', skillRes.data.id);
				} catch {
					// Non-fatal
				}

				// Import memories if present
				if (exportedSkill.memories && exportedSkill.memories.length > 0) {
					try {
						await window.maestro.memory.import(
							{ memories: exportedSkill.memories },
							'skill',
							skillRes.data.id,
							undefined
						);
					} catch {
						// Non-fatal: memories can be imported separately
					}
				}
			}
			setImportPreview(null);
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to import skills');
		} finally {
			setActionLoading(null);
		}
	}, [importPreview, importTargetPersonaId, loadData, onHierarchyChange]);

	// ─── Sibling skills for merge picker ────────────────────────────
	const getSiblingSkills = useCallback(
		(skill: SkillCard): SkillCard[] => {
			return skills
				.filter((s) => s.personaId === skill.personaId && s.id !== skill.id)
				.map((s) => ({
					...s,
					memoryCount: memoryCounts.get(s.id) ?? 0,
					personaName: skill.personaName,
				}));
		},
		[skills, memoryCounts]
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

			{/* ─── Visualization Summary ────────────────────────────────── */}
			{!loading && skills.length > 0 && (
				<div
					className="rounded-lg border p-4 space-y-3"
					style={{ borderColor: theme.colors.border }}
				>
					<SectionHeader theme={theme} icon={BarChart3} title="Skills Overview" />

					{/* Stats row */}
					<div className="flex flex-wrap gap-4 text-xs" style={{ color: theme.colors.textDim }}>
						<span>
							Total: {vizStats.total} ({vizStats.activeCount} active, {vizStats.inactiveCount}{' '}
							inactive)
						</span>
						<span>
							Embeddings: {vizStats.withEmbedding}/{vizStats.total}
							{vizStats.withEmbedding < vizStats.total && (
								<span style={{ color: theme.colors.warning }}>
									{' '}
									— {vizStats.total - vizStats.withEmbedding} missing
								</span>
							)}
						</span>
					</div>

					{/* Alerts row */}
					<div className="flex flex-wrap gap-4 text-xs">
						{vizStats.nearCapacity > 0 && (
							<span className="flex items-center gap-1" style={{ color: theme.colors.warning }}>
								<AlertCircle className="w-3 h-3" />
								{vizStats.nearCapacity} skill{vizStats.nearCapacity !== 1 ? 's' : ''} near capacity
								(&gt;80%)
							</span>
						)}
						{vizStats.emptySkills > 0 && (
							<span className="flex items-center gap-1" style={{ color: theme.colors.textDim }}>
								<Archive className="w-3 h-3" />
								{vizStats.emptySkills} skill{vizStats.emptySkills !== 1 ? 's' : ''} with no memories
							</span>
						)}
					</div>

					{/* Memory distribution bar */}
					{vizStats.totalMemories > 0 && (
						<div className="space-y-1">
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Memory distribution ({vizStats.totalMemories} total)
							</div>
							<div className="flex gap-0.5 h-3 rounded overflow-hidden">
								{vizStats.top10.map((skill, i) =>
									skill.memoryCount > 0 ? (
										<div
											key={skill.id}
											className="h-full"
											style={{
												width: `${(skill.memoryCount / vizStats.totalMemories) * 100}%`,
												backgroundColor: theme.colors.accent,
												opacity: 0.3 + ((10 - i) / 10) * 0.7,
											}}
											title={`${skill.name}: ${skill.memoryCount} memories`}
										/>
									) : null
								)}
								{vizStats.otherCount > 0 && (
									<div
										className="h-full"
										style={{
											width: `${(vizStats.otherCount / vizStats.totalMemories) * 100}%`,
											backgroundColor: theme.colors.textDim,
											opacity: 0.3,
										}}
										title={`Other: ${vizStats.otherCount} memories`}
									/>
								)}
							</div>
							<div className="flex flex-wrap gap-3 text-xs" style={{ color: theme.colors.textDim }}>
								{vizStats.top10
									.filter((s) => s.memoryCount > 0)
									.map((skill) => (
										<span key={skill.id}>
											{skill.name}: {skill.memoryCount}
										</span>
									))}
								{vizStats.otherCount > 0 && <span>Other: {vizStats.otherCount}</span>}
							</div>
						</div>
					)}
				</div>
			)}

			{/* Skill-level config */}
			<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
				<SectionHeader theme={theme} icon={Layers} title="Skill Configuration" />

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

			{/* ─── Action Bar: Create + Import/Export ────────────────── */}
			{!loading && personas.length > 0 && (
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<button
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
							}}
							onClick={() => {
								setCreatePersonaId(personas[0].id);
								setShowCreateModal(true);
							}}
						>
							<Plus className="w-3 h-3" />
							Create Skill
						</button>

						{/* Persona selector for create (inline when creating) */}
						{showCreateModal && personas.length > 1 && (
							<select
								className="px-2 py-1.5 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={createPersonaId}
								onChange={(e) => setCreatePersonaId(e.target.value)}
							>
								{personas.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
						)}
					</div>

					{engagementLevel >= 2 && (
						<div className="flex items-center gap-2">
							<label
								className="flex items-center gap-1 text-xs"
								style={{ color: theme.colors.textDim }}
							>
								<input
									type="checkbox"
									checked={exportIncludeMemories}
									onChange={(e) => setExportIncludeMemories(e.target.checked)}
								/>
								Include memories
							</label>
							<button
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={handleExportAll}
								disabled={exportLoading || skills.length === 0}
							>
								{exportLoading ? (
									<Loader2 className="w-3 h-3 animate-spin" />
								) : (
									<Download className="w-3 h-3" />
								)}
								Export
							</button>
							<button
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={handleImportFile}
							>
								<Upload className="w-3 h-3" />
								Import
							</button>
						</div>
					)}
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
									actionLoading={actionLoading}
									isDescExpanded={expandedDescriptions.has(skill.id)}
									onToggleDescription={() => toggleDescription(skill.id)}
									onEdit={() => handleEdit(skill)}
									onViewMemories={onViewMemories ? () => onViewMemories(skill.id) : undefined}
									onMove={() => setMoveTarget({ skill, personaId: skill.personaId })}
									onMerge={() => {
										const siblings = getSiblingSkills(skill);
										if (siblings.length === 0) {
											setError('No sibling skills to merge with');
											return;
										}
										setMergeTarget({ source: skill, targetId: siblings[0].id });
									}}
									onReEmbed={() => handleReEmbed(skill)}
									onDelete={() => setShowDeleteConfirm({ skill })}
									hasSiblings={getSiblingSkills(skill).length > 0}
								/>
							))}
						</div>
					</div>
				))
			)}

			{/* ─── Delete Confirmation Dialog ─────────────────────────── */}
			{showDeleteConfirm && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
				>
					<div
						className="rounded-lg border p-6 space-y-4 max-w-sm w-full mx-4"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Delete Skill
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Are you sure you want to delete &ldquo;{showDeleteConfirm.skill.name}&rdquo;?
							{showDeleteConfirm.skill.memoryCount > 0 && (
								<span style={{ color: theme.colors.warning }}>
									{' '}
									This skill has {showDeleteConfirm.skill.memoryCount} memories that will be lost.
								</span>
							)}
						</div>
						<div className="flex justify-end gap-2">
							<button
								className="px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={() => setShowDeleteConfirm(null)}
							>
								Cancel
							</button>
							<button
								className="px-3 py-1.5 rounded text-xs font-medium"
								style={{ backgroundColor: theme.colors.error, color: '#fff' }}
								onClick={handleDeleteConfirmed}
								disabled={actionLoading === `delete:${showDeleteConfirm.skill.id}`}
							>
								{actionLoading === `delete:${showDeleteConfirm.skill.id}` ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<Trash2 className="w-3 h-3 inline mr-1" />
								)}
								Delete
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ─── Move Skill Dialog ──────────────────────────────────── */}
			{moveTarget && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
				>
					<div
						className="rounded-lg border p-6 space-y-4 max-w-sm w-full mx-4"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Move Skill
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Move &ldquo;{moveTarget.skill.name}&rdquo; to a different persona.
							{moveTarget.skill.memoryCount > 0 && (
								<span> {moveTarget.skill.memoryCount} memories will be moved along with it.</span>
							)}
						</div>
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Target Persona
							</label>
							<select
								className="w-full px-3 py-2 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={moveTarget.personaId}
								onChange={(e) => setMoveTarget({ ...moveTarget, personaId: e.target.value })}
							>
								{personas.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
										{p.id === moveTarget.skill.personaId ? ' (current)' : ''}
									</option>
								))}
							</select>
						</div>
						<div className="flex justify-end gap-2">
							<button
								className="px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={() => setMoveTarget(null)}
							>
								Cancel
							</button>
							<button
								className="px-3 py-1.5 rounded text-xs font-medium border"
								style={{
									borderColor: theme.colors.accent,
									color: theme.colors.accent,
									backgroundColor: `${theme.colors.accent}10`,
								}}
								onClick={handleMoveConfirmed}
								disabled={
									moveTarget.personaId === moveTarget.skill.personaId ||
									actionLoading === `move:${moveTarget.skill.id}`
								}
							>
								{actionLoading === `move:${moveTarget.skill.id}` ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<ArrowRight className="w-3 h-3 inline mr-1" />
								)}
								Move
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ─── Merge Skill Dialog ─────────────────────────────────── */}
			{mergeTarget && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
				>
					<div
						className="rounded-lg border p-6 space-y-4 max-w-sm w-full mx-4"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Merge Skill
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Merge &ldquo;{mergeTarget.source.name}&rdquo; into another skill. All{' '}
							{mergeTarget.source.memoryCount} memories will be moved to the target skill, then this
							skill will be deleted.
						</div>
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Merge Into
							</label>
							<select
								className="w-full px-3 py-2 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={mergeTarget.targetId}
								onChange={(e) => setMergeTarget({ ...mergeTarget, targetId: e.target.value })}
							>
								{getSiblingSkills(mergeTarget.source).map((s) => (
									<option key={s.id} value={s.id}>
										{s.name} ({s.memoryCount} memories)
									</option>
								))}
							</select>
						</div>
						<div className="flex justify-end gap-2">
							<button
								className="px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={() => setMergeTarget(null)}
							>
								Cancel
							</button>
							<button
								className="px-3 py-1.5 rounded text-xs font-medium"
								style={{ backgroundColor: theme.colors.warning, color: '#fff' }}
								onClick={handleMergeConfirmed}
								disabled={actionLoading === `merge:${mergeTarget.source.id}`}
							>
								{actionLoading === `merge:${mergeTarget.source.id}` ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<GitMerge className="w-3 h-3 inline mr-1" />
								)}
								Merge
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ─── Import Preview Dialog ─────────────────────────────── */}
			{importPreview && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
				>
					<div
						className="rounded-lg border p-6 space-y-4 max-w-md w-full mx-4"
						style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
					>
						<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Import Skills
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{importPreview.skills.length} skill(s) found:
						</div>
						<div className="space-y-1.5 max-h-48 overflow-y-auto">
							{importPreview.skills.map((s, i) => (
								<div
									key={i}
									className="flex items-center justify-between px-3 py-2 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<span className="font-medium">{s.name}</span>
									<span style={{ color: theme.colors.textDim }}>
										{s.personaName} &middot; {s.memoryCount} memories
									</span>
								</div>
							))}
						</div>
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Import into persona
							</label>
							<select
								className="w-full px-3 py-2 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={importTargetPersonaId}
								onChange={(e) => setImportTargetPersonaId(e.target.value)}
							>
								{personas.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
						</div>
						<div className="flex justify-end gap-2">
							<button
								className="px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={() => setImportPreview(null)}
							>
								Cancel
							</button>
							<button
								className="px-3 py-1.5 rounded text-xs font-medium border"
								style={{
									borderColor: theme.colors.accent,
									color: theme.colors.accent,
									backgroundColor: `${theme.colors.accent}10`,
								}}
								onClick={handleImportConfirm}
								disabled={actionLoading === 'import' || !importTargetPersonaId}
							>
								{actionLoading === 'import' ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<Upload className="w-3 h-3 inline mr-1" />
								)}
								Import
							</button>
						</div>
					</div>
				</div>
			)}

			{/* ─── Edit/Create Modal ──────────────────────────────────── */}
			{(editingPersonaId || showCreateModal) && (
				<SkillEditModal
					theme={theme}
					skill={editingSkill}
					personaId={editingPersonaId || createPersonaId}
					onSave={handleSaveSkill}
					onClose={() => {
						setEditingSkill(null);
						setEditingPersonaId(null);
						setShowCreateModal(false);
					}}
				/>
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
	actionLoading,
	isDescExpanded,
	onToggleDescription,
	onEdit,
	onViewMemories,
	onMove,
	onMerge,
	onReEmbed,
	onDelete,
	hasSiblings,
}: {
	skill: SkillCard;
	theme: Theme;
	maxPerSkill: number;
	capacityColor: (count: number) => string;
	actionLoading: string | null;
	isDescExpanded: boolean;
	onToggleDescription: () => void;
	onEdit: () => void;
	onViewMemories?: () => void;
	onMove: () => void;
	onMerge: () => void;
	onReEmbed: () => void;
	onDelete: () => void;
	hasSiblings: boolean;
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
			{/* Header: name + active dot + actions */}
			<div className="flex items-start justify-between gap-2">
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
				<div className="flex items-center gap-1 shrink-0">
					<ActionButton icon={Edit3} title="Edit" onClick={onEdit} theme={theme} loading={false} />
					{onViewMemories && (
						<ActionButton
							icon={List}
							title="View Memories"
							onClick={onViewMemories}
							theme={theme}
							loading={false}
						/>
					)}
					<ActionButton
						icon={ArrowRight}
						title="Move to another persona"
						onClick={onMove}
						theme={theme}
						loading={actionLoading === `move:${skill.id}`}
					/>
					<ActionButton
						icon={GitMerge}
						title={hasSiblings ? 'Merge into another skill' : 'No sibling skills to merge with'}
						onClick={onMerge}
						theme={theme}
						loading={actionLoading === `merge:${skill.id}`}
						disabled={!hasSiblings}
					/>
					<ActionButton
						icon={RefreshCw}
						title="Re-embed"
						onClick={onReEmbed}
						theme={theme}
						loading={actionLoading === `reembed:${skill.id}`}
					/>
					<ActionButton
						icon={Trash2}
						title="Delete"
						onClick={onDelete}
						theme={theme}
						loading={actionLoading === `delete:${skill.id}`}
						danger
					/>
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

// ─── ActionButton (reusable, matches PersonasTab pattern) ────────────────────

function ActionButton({
	icon: Icon,
	title,
	onClick,
	theme,
	loading,
	danger,
	disabled,
}: {
	icon: React.FC<{ className?: string; style?: React.CSSProperties }>;
	title: string;
	onClick: () => void;
	theme: Theme;
	loading: boolean;
	danger?: boolean;
	disabled?: boolean;
}) {
	return (
		<button
			className="p-1 rounded hover:opacity-70"
			title={title}
			onClick={onClick}
			disabled={loading || disabled}
			style={{ opacity: disabled ? 0.4 : undefined }}
		>
			{loading ? (
				<Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.textDim }} />
			) : (
				<Icon
					className="w-3 h-3"
					style={{ color: danger ? theme.colors.error : theme.colors.textDim }}
				/>
			)}
		</button>
	);
}

// ─── Export/Import types and helpers ─────────────────────────────────────────

interface SkillExportData {
	version: number;
	exportedAt: string;
	skills: Array<{
		name: string;
		description: string;
		active: boolean;
		persona: { id: string; name: string };
		memories?: Array<{
			content: string;
			type?: MemoryType;
			tags?: string[];
			confidence?: number;
			pinned?: boolean;
		}>;
	}>;
}

function downloadSkillJson(data: SkillExportData, label: string) {
	const json = JSON.stringify(data, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `maestro-skills-${label}-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
