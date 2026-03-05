/**
 * PersonasTab - Personas sub-tab within MemorySettings.
 *
 * Card-based persona management with:
 * - Visualization summary row (counts, role distribution, embedding coverage)
 * - Card grid grouped by parent role
 * - CRUD actions (edit, duplicate, toggle, delete, re-embed)
 * - Create persona button
 * - Import/Export support
 * - Hierarchy suggestions (persona + skill area) with apply/dismiss actions
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
	Users,
	Lightbulb,
	Plus,
	X,
	Loader2,
	Edit3,
	Copy,
	Power,
	Trash2,
	RefreshCw,
	Check,
	AlertTriangle,
	Download,
	Upload,
	ChevronDown,
	Search,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	PersonaSuggestion,
	SkillAreaSuggestion,
	HierarchySuggestionResult,
	Role,
	Persona,
	SkillArea,
	MemoryEntry,
} from '../../../shared/memory-types';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';
import { PersonaEditModal } from './HierarchyEditModals';

export interface PersonasTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onHierarchyChange?: () => void;
	onRefresh: () => Promise<void>;
}

/** Persona with resolved counts for display */
interface PersonaCard extends Persona {
	skillCount: number;
	memoryCount: number;
	totalUseCount: number;
	roleName: string;
}

/** Role group for card layout */
interface RoleGroup {
	role: Role;
	personas: PersonaCard[];
}

export function PersonasTab({
	theme,
	config,
	stats: _stats,
	projectPath,
	onHierarchyChange,
	onRefresh,
}: PersonasTabProps): React.ReactElement {
	// ─── Suggestion state (preserved from original) ─────────────────────
	const [suggestions, setSuggestions] = useState<HierarchySuggestionResult | null>(null);
	const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
	const [applyingSuggestion, setApplyingSuggestion] = useState<string | null>(null);
	const suggestionsLoaded = useRef(false);
	const [error, setError] = useState<string | null>(null);

	// ─── Persona data state ─────────────────────────────────────────────
	const [roles, setRoles] = useState<Role[]>([]);
	const [personas, setPersonas] = useState<Persona[]>([]);
	const [skills, setSkills] = useState<SkillArea[]>([]);
	const [memories, setMemories] = useState<MemoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set());
	const [expandedPrompts, setExpandedPrompts] = useState<Set<string>>(new Set());

	// ─── Search state ───────────────────────────────────────────────────
	const [searchQuery, setSearchQuery] = useState('');

	// ─── Modal state ────────────────────────────────────────────────────
	const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
	const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [createRoleId, setCreateRoleId] = useState<string>('');
	const [showDeleteConfirm, setShowDeleteConfirm] = useState<{ persona: PersonaCard } | null>(null);
	const [actionLoading, setActionLoading] = useState<string | null>(null);

	// ─── Import/Export state ────────────────────────────────────────────
	const [importPreview, setImportPreview] = useState<{
		personas: Array<{ name: string; roleName: string; skillCount: number }>;
		raw: PersonaExportData;
	} | null>(null);
	const [importTargetRoleId, setImportTargetRoleId] = useState<string>('');
	const [showExportDropdown, setShowExportDropdown] = useState(false);
	const exportRef = useRef<HTMLDivElement>(null);

	// ─── Load persona data ──────────────────────────────────────────────
	const loadData = useCallback(async () => {
		try {
			const [rolesRes, personasRes, skillsRes] = await Promise.all([
				window.maestro.memory.role.list(),
				window.maestro.memory.persona.list(),
				window.maestro.memory.skill.list(),
			]);
			if (rolesRes.success) setRoles(rolesRes.data);
			if (personasRes.success) setPersonas(personasRes.data);
			if (skillsRes.success) setSkills(skillsRes.data);

			// Load all skill-scoped memories to get counts and useCount
			if (skillsRes.success && skillsRes.data.length > 0) {
				const allMemories: MemoryEntry[] = [];
				for (const skill of skillsRes.data) {
					try {
						const memRes = await window.maestro.memory.list('skill', skill.id, undefined, true);
						if (memRes.success) allMemories.push(...memRes.data);
					} catch {
						// Skip failed loads
					}
				}
				setMemories(allMemories);
			} else {
				setMemories([]);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to load personas');
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (config.enabled) loadData();
	}, [config.enabled, loadData]);

	// ─── Build role groups ──────────────────────────────────────────────
	const roleGroups = useMemo((): RoleGroup[] => {
		const roleMap = new Map(roles.map((r) => [r.id, r]));
		const skillsByPersona = new Map<string, SkillArea[]>();
		for (const skill of skills) {
			const list = skillsByPersona.get(skill.personaId) ?? [];
			list.push(skill);
			skillsByPersona.set(skill.personaId, list);
		}
		const memoriesByPersona = new Map<string, MemoryEntry[]>();
		for (const mem of memories) {
			if (mem.personaId) {
				const list = memoriesByPersona.get(mem.personaId) ?? [];
				list.push(mem);
				memoriesByPersona.set(mem.personaId, list);
			}
		}

		const groups: RoleGroup[] = [];
		for (const role of roles) {
			const rolePersonas = personas
				.filter((p) => p.roleId === role.id)
				.map((p): PersonaCard => {
					const personaMemories = memoriesByPersona.get(p.id) ?? [];
					return {
						...p,
						skillCount: (skillsByPersona.get(p.id) ?? []).length,
						memoryCount: personaMemories.length,
						totalUseCount: personaMemories.reduce((sum, m) => sum + m.useCount, 0),
						roleName: roleMap.get(p.roleId)?.name ?? 'Unknown',
					};
				});
			if (rolePersonas.length > 0) {
				groups.push({ role, personas: rolePersonas });
			}
		}

		// Include personas with no matching role (orphans)
		const assignedRoleIds = new Set(roles.map((r) => r.id));
		const orphans = personas.filter((p) => !assignedRoleIds.has(p.roleId));
		if (orphans.length > 0) {
			const orphanCards = orphans.map((p): PersonaCard => {
				const personaMemories = memoriesByPersona.get(p.id) ?? [];
				return {
					...p,
					skillCount: (skillsByPersona.get(p.id) ?? []).length,
					memoryCount: personaMemories.length,
					totalUseCount: personaMemories.reduce((sum, m) => sum + m.useCount, 0),
					roleName: 'Unassigned',
				};
			});
			groups.push({
				role: {
					id: '__orphans',
					name: 'Unassigned',
					description: '',
					systemPrompt: '',
					personaIds: [],
					createdAt: 0,
					updatedAt: 0,
				},
				personas: orphanCards,
			});
		}

		return groups;
	}, [roles, personas, skills, memories]);

	// ─── Filtered role groups (by search query) ─────────────────────────
	const filteredRoleGroups = useMemo((): RoleGroup[] => {
		if (!searchQuery.trim()) return roleGroups;
		const q = searchQuery.toLowerCase();
		return roleGroups
			.map((g) => ({
				...g,
				personas: g.personas.filter((p) => p.name.toLowerCase().includes(q)),
			}))
			.filter((g) => g.personas.length > 0);
	}, [roleGroups, searchQuery]);

	// ─── Visualization stats ────────────────────────────────────────────
	const vizStats = useMemo(() => {
		const activeCount = personas.filter((p) => p.active).length;
		const inactiveCount = personas.filter((p) => !p.active).length;
		const withEmbedding = personas.filter((p) => p.embedding && p.embedding.length > 0).length;
		const roleDistribution = roleGroups.map((g) => ({
			name: g.role.name,
			count: g.personas.length,
		}));
		const allCards = roleGroups.flatMap((g) => g.personas);
		const mostActive =
			allCards.length > 0
				? allCards.reduce((best, cur) => (cur.totalUseCount > best.totalUseCount ? cur : best))
				: null;
		return {
			activeCount,
			inactiveCount,
			withEmbedding,
			total: personas.length,
			roleDistribution,
			mostActive,
		};
	}, [personas, roleGroups]);

	// ─── Load hierarchy suggestions ─────────────────────────────────────
	useEffect(() => {
		if (!config.enabled || !projectPath || suggestionsLoaded.current) return;
		let mounted = true;
		const timer = setTimeout(async () => {
			try {
				const res = await window.maestro.memory.suggestHierarchy(projectPath);
				if (!mounted) return;
				if (res.success) {
					setSuggestions(res.data);
					suggestionsLoaded.current = true;
				}
			} catch {
				// Non-critical — silently degrade
			}
		}, 500);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	}, [config.enabled, projectPath]);

	// ─── Suggestion handlers ────────────────────────────────────────────
	const handleApplyPersona = useCallback(
		async (suggestion: PersonaSuggestion) => {
			const key = `persona:${suggestion.suggestedName}`;
			setApplyingSuggestion(key);
			try {
				let roleId = suggestion.suggestedRoleId;
				if (!roleId) {
					const roleRes = await window.maestro.memory.role.create(
						suggestion.suggestedRoleName,
						`${suggestion.suggestedRoleName} role`
					);
					if (!roleRes.success) {
						setError(roleRes.error);
						return;
					}
					roleId = roleRes.data.id;
				}
				const personaRes = await window.maestro.memory.persona.create(
					roleId,
					suggestion.suggestedName,
					suggestion.suggestedDescription
				);
				if (!personaRes.success) {
					setError(personaRes.error);
					return;
				}
				for (const skillName of suggestion.suggestedSkills) {
					await window.maestro.memory.skill.create(
						personaRes.data.id,
						skillName,
						`${skillName} expertise`
					);
				}
				setDismissedSuggestions((prev) => new Set([...prev, key]));
				await onRefresh();
				await loadData();
				onHierarchyChange?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create persona');
			} finally {
				setApplyingSuggestion(null);
			}
		},
		[onHierarchyChange, onRefresh, loadData]
	);

	const handleApplySkillArea = useCallback(
		async (suggestion: SkillAreaSuggestion) => {
			const key = `skill:${suggestion.suggestedName}`;
			setApplyingSuggestion(key);
			try {
				const skillRes = await window.maestro.memory.skill.create(
					suggestion.suggestedPersonaId,
					suggestion.suggestedName,
					suggestion.suggestedDescription
				);
				if (!skillRes.success) {
					setError(skillRes.error);
					return;
				}
				setDismissedSuggestions((prev) => new Set([...prev, key]));
				await onRefresh();
				await loadData();
				onHierarchyChange?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create skill area');
			} finally {
				setApplyingSuggestion(null);
			}
		},
		[onHierarchyChange, onRefresh, loadData]
	);

	const handleDismissSuggestion = useCallback((key: string) => {
		setDismissedSuggestions((prev) => new Set([...prev, key]));
	}, []);

	// ─── Persona actions ────────────────────────────────────────────────
	const handleEditPersona = useCallback((persona: Persona) => {
		setEditingPersona(persona);
		setEditingRoleId(persona.roleId);
	}, []);

	const handleSavePersona = useCallback(
		async (data: {
			name: string;
			description: string;
			systemPrompt: string;
			assignedAgents: string[];
			assignedProjects: string[];
		}) => {
			if (editingPersona) {
				const res = await window.maestro.memory.persona.update(editingPersona.id, data);
				if (!res.success) throw new Error(res.error);
			} else if (createRoleId) {
				const res = await window.maestro.memory.persona.create(
					createRoleId,
					data.name,
					data.description,
					data.assignedAgents,
					data.assignedProjects,
					data.systemPrompt
				);
				if (!res.success) throw new Error(res.error);
			}
			setEditingPersona(null);
			setEditingRoleId(null);
			setShowCreateModal(false);
			await onRefresh();
			await loadData();
			onHierarchyChange?.();
		},
		[editingPersona, createRoleId, onRefresh, loadData, onHierarchyChange]
	);

	const handleDuplicate = useCallback(
		async (persona: PersonaCard) => {
			setActionLoading(`duplicate:${persona.id}`);
			try {
				const res = await window.maestro.memory.persona.create(
					persona.roleId,
					`${persona.name} (Copy)`,
					persona.description,
					persona.assignedAgents,
					persona.assignedProjects,
					persona.systemPrompt
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				await onRefresh();
				await loadData();
				onHierarchyChange?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to duplicate persona');
			} finally {
				setActionLoading(null);
			}
		},
		[onRefresh, loadData, onHierarchyChange]
	);

	const handleToggleActive = useCallback(
		async (persona: Persona) => {
			setActionLoading(`toggle:${persona.id}`);
			try {
				const res = await window.maestro.memory.persona.update(persona.id, {
					active: !persona.active,
				});
				if (!res.success) {
					setError(res.error);
					return;
				}
				await loadData();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to toggle persona');
			} finally {
				setActionLoading(null);
			}
		},
		[loadData]
	);

	const handleDeleteConfirmed = useCallback(async () => {
		if (!showDeleteConfirm) return;
		const { persona } = showDeleteConfirm;
		setActionLoading(`delete:${persona.id}`);
		try {
			const res = await window.maestro.memory.persona.delete(persona.id);
			if (!res.success) {
				setError(res.error);
				return;
			}
			setShowDeleteConfirm(null);
			await onRefresh();
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to delete persona');
		} finally {
			setActionLoading(null);
		}
	}, [showDeleteConfirm, onRefresh, loadData, onHierarchyChange]);

	const handleReEmbed = useCallback(
		async (persona: Persona) => {
			setActionLoading(`reembed:${persona.id}`);
			try {
				// Re-compute embeddings for all skills under this persona
				for (const skill of skills.filter((s) => s.personaId === persona.id)) {
					await window.maestro.memory.ensureEmbeddings('skill', skill.id);
				}
				await loadData();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to re-embed persona');
			} finally {
				setActionLoading(null);
			}
		},
		[skills, loadData]
	);

	// ─── Import/Export ───────────────────────────────────────────────────
	const handleExportAll = useCallback(() => {
		const exportData = buildPersonaExport(roleGroups, skills, memories);
		downloadPersonaJson(exportData, 'all-personas');
		setShowExportDropdown(false);
	}, [roleGroups, skills, memories]);

	const handleImportFile = useCallback(() => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const data = JSON.parse(text) as PersonaExportData;
				if (!data.version || !data.personas) {
					setError('Invalid persona export file');
					return;
				}
				setImportPreview({
					personas: data.personas.map((p) => ({
						name: p.name,
						roleName: p.role?.name ?? 'Unknown',
						skillCount: p.skills?.length ?? 0,
					})),
					raw: data,
				});
				if (roles.length > 0) setImportTargetRoleId(roles[0].id);
			} catch {
				setError('Failed to parse import file');
			}
		};
		input.click();
	}, [roles]);

	const handleImportConfirm = useCallback(async () => {
		if (!importPreview) return;
		setActionLoading('import');
		try {
			for (const exportedPersona of importPreview.raw.personas) {
				let targetRoleId = importTargetRoleId;
				// If the exported persona has role info and no target selected, create the role
				if (!targetRoleId && exportedPersona.role) {
					const roleRes = await window.maestro.memory.role.create(
						exportedPersona.role.name,
						exportedPersona.role.name
					);
					if (roleRes.success) targetRoleId = roleRes.data.id;
				}
				if (!targetRoleId) continue;

				const personaRes = await window.maestro.memory.persona.create(
					targetRoleId,
					exportedPersona.name,
					exportedPersona.description ?? '',
					exportedPersona.assignedAgents,
					exportedPersona.assignedProjects,
					exportedPersona.systemPrompt
				);
				if (!personaRes.success) continue;

				// Create skills under the new persona
				if (exportedPersona.skills) {
					for (const skill of exportedPersona.skills) {
						await window.maestro.memory.skill.create(
							personaRes.data.id,
							skill.name,
							skill.description ?? ''
						);
					}
				}
			}
			setImportPreview(null);
			await onRefresh();
			await loadData();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to import personas');
		} finally {
			setActionLoading(null);
		}
	}, [importPreview, importTargetRoleId, onRefresh, loadData, onHierarchyChange]);

	// Close export dropdown on outside click
	useEffect(() => {
		if (!showExportDropdown) return;
		const handler = (e: MouseEvent) => {
			if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
				setShowExportDropdown(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [showExportDropdown]);

	// ─── Helpers ─────────────────────────────────────────────────────────
	const toggleExpanded = (
		id: string,
		setter: React.Dispatch<React.SetStateAction<Set<string>>>
	) => {
		setter((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const visiblePersonas =
		suggestions?.personaSuggestions.filter(
			(s) => !dismissedSuggestions.has(`persona:${s.suggestedName}`)
		) ?? [];
	const visibleSkills =
		suggestions?.skillSuggestions.filter(
			(s) => !dismissedSuggestions.has(`skill:${s.suggestedName}`)
		) ?? [];
	const hasSuggestions = visiblePersonas.length > 0 || visibleSkills.length > 0;

	return (
		<div className="flex flex-col" style={{ height: '100%' }}>
			{/* ─── Fixed Header: Banner + Search/Actions + Stats ─────────── */}
			<div className="shrink-0 space-y-3 pb-2">
				<TabDescriptionBanner
					theme={theme}
					description="Personas are expert profiles that shape how your AI agents think and respond. Each persona has specialized knowledge areas and a behavioral style. When a task matches a persona's expertise, relevant memories are automatically injected."
				/>

				{error && (
					<div
						className="flex items-center justify-between gap-2 p-3 rounded-lg text-xs"
						style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
					>
						<span>{error}</span>
						<button onClick={() => setError(null)} className="hover:opacity-70">
							<X className="w-3 h-3" />
						</button>
					</div>
				)}

				{/* ─── Search + Action Bar: Search + Create + Import/Export ── */}
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 flex-1 min-w-0">
						<div className="relative flex-1 min-w-0 max-w-[240px]">
							<Search
								className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3"
								style={{ color: theme.colors.textDim }}
							/>
							<input
								type="text"
								placeholder="Search personas..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="w-full pl-7 pr-2 py-1.5 rounded border bg-transparent text-xs outline-none"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</div>
						<button
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border shrink-0"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
							}}
							onClick={() => {
								if (roles.length > 0) {
									setCreateRoleId(roles[0].id);
									setShowCreateModal(true);
								} else {
									setError('Create a role first before adding personas');
								}
							}}
						>
							<Plus className="w-3 h-3" />
							Create Persona
						</button>

						{/* Role selector for create (inline when creating) */}
						{showCreateModal && roles.length > 1 && (
							<select
								className="px-2 py-1.5 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={createRoleId}
								onChange={(e) => setCreateRoleId(e.target.value)}
							>
								{roles.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
									</option>
								))}
							</select>
						)}
					</div>

					<div className="flex items-center gap-2 shrink-0">
						<div className="relative" ref={exportRef}>
							<button
								className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
								onClick={() => setShowExportDropdown(!showExportDropdown)}
							>
								<Download className="w-3 h-3" />
								Export
								<ChevronDown className="w-3 h-3" />
							</button>
							{showExportDropdown && (
								<div
									className="absolute right-0 top-full mt-1 rounded-lg border shadow-lg z-50 min-w-[160px]"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
									}}
								>
									<button
										className="w-full text-left px-3 py-2 text-xs hover:opacity-80"
										style={{ color: theme.colors.textMain }}
										onClick={handleExportAll}
									>
										Export all personas
									</button>
								</div>
							)}
						</div>
						<button
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							onClick={handleImportFile}
						>
							<Upload className="w-3 h-3" />
							Import
						</button>
					</div>
				</div>

				{/* ─── Summary Stats Row ─────────────────────────────────────── */}
				{personas.length > 0 && (
					<div
						className="flex flex-wrap gap-4 text-xs px-1"
						style={{ color: theme.colors.textDim }}
					>
						<span>
							{vizStats.total} personas ({vizStats.activeCount} active)
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
						{vizStats.mostActive && vizStats.mostActive.totalUseCount > 0 && (
							<span>
								Most active: {vizStats.mostActive.name} ({vizStats.mostActive.totalUseCount}{' '}
								injections)
							</span>
						)}
						{vizStats.roleDistribution.length > 1 && (
							<span>
								Roles:{' '}
								{vizStats.roleDistribution.map((rd) => `${rd.name} (${rd.count})`).join(', ')}
							</span>
						)}
					</div>
				)}
			</div>

			{/* ─── Scrollable Content: Cards + Suggestions ───────────────── */}
			<div className="flex-1 overflow-y-auto min-h-0 space-y-4 mt-2">
				{/* ─── Hierarchy Suggestions ──────────────────────────────────── */}
				{hasSuggestions && (
					<div
						className="rounded-lg border p-4 space-y-3"
						style={{
							borderColor: theme.colors.accent,
							backgroundColor: `${theme.colors.accent}08`,
						}}
					>
						<SectionHeader theme={theme} icon={Lightbulb} title="Suggestions for this project" />

						{visiblePersonas.map((suggestion) => {
							const key = `persona:${suggestion.suggestedName}`;
							const isApplying = applyingSuggestion === key;
							return (
								<div
									key={key}
									className="rounded border p-3 space-y-1.5"
									style={{ borderColor: theme.colors.border }}
								>
									<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
										Add persona: &ldquo;{suggestion.suggestedName}&rdquo;
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Evidence: {suggestion.evidence.join(', ')}
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Skills: {suggestion.suggestedSkills.join(', ')}
									</div>
									<div className="flex gap-2 mt-2">
										<button
											className="px-3 py-1 rounded text-xs font-medium border"
											style={{
												borderColor: theme.colors.accent,
												color: theme.colors.accent,
												backgroundColor: `${theme.colors.accent}10`,
											}}
											onClick={() => handleApplyPersona(suggestion)}
											disabled={isApplying}
										>
											{isApplying ? (
												<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
											) : (
												<Plus className="w-3 h-3 inline mr-1" />
											)}
											Add
										</button>
										<button
											className="px-3 py-1 rounded text-xs border"
											style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
											onClick={() => handleDismissSuggestion(key)}
											disabled={isApplying}
										>
											<X className="w-3 h-3 inline mr-1" />
											Dismiss
										</button>
									</div>
								</div>
							);
						})}

						{visibleSkills.map((suggestion) => {
							const key = `skill:${suggestion.suggestedName}`;
							const isApplying = applyingSuggestion === key;
							return (
								<div
									key={key}
									className="rounded border p-3 space-y-1.5"
									style={{ borderColor: theme.colors.border }}
								>
									<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
										New skill area: &ldquo;{suggestion.suggestedName}&rdquo;
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Under: {suggestion.suggestedPersonaName}
									</div>
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										Contains: {suggestion.memoryIds.length} related project memories
									</div>
									<div className="flex gap-2 mt-2">
										<button
											className="px-3 py-1 rounded text-xs font-medium border"
											style={{
												borderColor: theme.colors.accent,
												color: theme.colors.accent,
												backgroundColor: `${theme.colors.accent}10`,
											}}
											onClick={() => handleApplySkillArea(suggestion)}
											disabled={isApplying}
										>
											{isApplying ? (
												<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
											) : (
												<Plus className="w-3 h-3 inline mr-1" />
											)}
											Create
										</button>
										<button
											className="px-3 py-1 rounded text-xs border"
											style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
											onClick={() => handleDismissSuggestion(key)}
											disabled={isApplying}
										>
											<X className="w-3 h-3 inline mr-1" />
											Dismiss
										</button>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{/* ─── Persona Match Preview ─────────────────────────────────── */}
				<PersonaMatchPreview theme={theme} config={config} />

				{/* ─── Persona Cards by Role ──────────────────────────────────── */}
				{loading ? (
					<div className="flex items-center justify-center py-12">
						<Loader2 className="w-5 h-5 animate-spin" style={{ color: theme.colors.textDim }} />
					</div>
				) : filteredRoleGroups.length === 0 ? (
					<div
						className="flex flex-col items-center justify-center py-12 gap-3"
						style={{ color: theme.colors.textDim }}
					>
						<Users className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
						<div className="text-xs font-medium">
							{searchQuery.trim()
								? `No personas matching "${searchQuery}"`
								: 'No personas yet. Create one or apply a suggestion above.'}
						</div>
					</div>
				) : (
					filteredRoleGroups.map((group) => (
						<div key={group.role.id} className="space-y-2">
							{/* Role header */}
							<div className="flex items-center gap-2 pt-2">
								<div
									className="w-2 h-2 rounded-full"
									style={{ backgroundColor: theme.colors.accent }}
								/>
								<div
									className="text-xs font-bold uppercase tracking-wider"
									style={{ color: theme.colors.textDim }}
								>
									{group.role.name}
								</div>
								<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.6 }}>
									({group.personas.length})
								</div>
							</div>

							{/* Persona cards */}
							<div
								className="grid gap-3"
								style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}
							>
								{group.personas.map((persona) => (
									<PersonaCardView
										key={persona.id}
										persona={persona}
										theme={theme}
										actionLoading={actionLoading}
										expandedDescriptions={expandedDescriptions}
										expandedPrompts={expandedPrompts}
										onToggleDescription={() => toggleExpanded(persona.id, setExpandedDescriptions)}
										onTogglePrompt={() => toggleExpanded(persona.id, setExpandedPrompts)}
										onEdit={() => handleEditPersona(persona)}
										onDuplicate={() => handleDuplicate(persona)}
										onToggleActive={() => handleToggleActive(persona)}
										onDelete={() => setShowDeleteConfirm({ persona })}
										onReEmbed={() => handleReEmbed(persona)}
									/>
								))}
							</div>
						</div>
					))
				)}
			</div>
			{/* end scrollable content */}

			{/* ─── Delete Confirmation Dialog ─────────────────────────────── */}
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
							Delete Persona
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Are you sure you want to delete &ldquo;{showDeleteConfirm.persona.name}&rdquo;?
							{showDeleteConfirm.persona.memoryCount > 0 && (
								<span style={{ color: theme.colors.warning }}>
									{' '}
									This persona has {showDeleteConfirm.persona.memoryCount} memories. Deleting will
									orphan them.
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
								disabled={actionLoading === `delete:${showDeleteConfirm.persona.id}`}
							>
								{actionLoading === `delete:${showDeleteConfirm.persona.id}` ? (
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

			{/* ─── Import Preview Dialog ──────────────────────────────────── */}
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
							Import Personas
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							{importPreview.personas.length} persona(s) found:
						</div>
						<div className="space-y-1.5 max-h-48 overflow-y-auto">
							{importPreview.personas.map((p, i) => (
								<div
									key={i}
									className="flex items-center justify-between px-3 py-2 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									<span className="font-medium">{p.name}</span>
									<span style={{ color: theme.colors.textDim }}>
										{p.roleName} &middot; {p.skillCount} skills
									</span>
								</div>
							))}
						</div>
						<div>
							<label
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Import into role
							</label>
							<select
								className="w-full px-3 py-2 rounded border bg-transparent text-xs outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								value={importTargetRoleId}
								onChange={(e) => setImportTargetRoleId(e.target.value)}
							>
								<option value="">Create new role from export</option>
								{roles.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
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
								disabled={actionLoading === 'import'}
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

			{/* ─── Edit/Create Modal ──────────────────────────────────────── */}
			{(editingRoleId || showCreateModal) && (
				<PersonaEditModal
					theme={theme}
					persona={editingPersona}
					roleId={editingRoleId || createRoleId}
					onSave={handleSavePersona}
					onClose={() => {
						setEditingPersona(null);
						setEditingRoleId(null);
						setShowCreateModal(false);
					}}
				/>
			)}
		</div>
	);
}

// ─── PersonaMatchPreview ─────────────────────────────────────────────────────

interface PersonaMatchResult {
	personaId: string;
	personaName: string;
	roleName: string;
	description: string;
	systemPrompt: string;
	similarity: number;
}

function PersonaMatchPreview({ theme, config }: { theme: Theme; config: MemoryConfig }) {
	const [query, setQuery] = useState('');
	const [results, setResults] = useState<PersonaMatchResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [hasSearched, setHasSearched] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout>>();

	const runPreview = useCallback(async (text: string) => {
		if (!text.trim()) {
			setResults([]);
			setHasSearched(false);
			return;
		}
		setLoading(true);
		setHasSearched(true);
		try {
			const resp = await window.maestro.memory.matchPersonas(text, 'claude-code');
			if (resp.success) {
				setResults(resp.data);
			} else {
				setResults([]);
			}
		} catch {
			setResults([]);
		} finally {
			setLoading(false);
		}
	}, []);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const val = e.target.value;
			setQuery(val);
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => runPreview(val), 400);
		},
		[runPreview]
	);

	const threshold = config.personaMatchThreshold ?? 0.3;

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={Search}
				title="Persona Match Preview"
				description="— type a task description to see which personas would match"
			/>

			<input
				type="text"
				placeholder="e.g. Fix the React component state management bug..."
				value={query}
				onChange={handleChange}
				className="w-full px-3 py-2 rounded border bg-transparent text-xs outline-none"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			/>

			{loading && (
				<div className="flex items-center gap-2 py-2">
					<Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.textDim }} />
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						Matching...
					</span>
				</div>
			)}

			{!loading && hasSearched && results.length === 0 && (
				<div className="text-xs py-2 space-y-1" style={{ color: theme.colors.textDim }}>
					<div>No personas matched this task description.</div>
					<div>
						Possible reasons: personas may lack embeddings, the similarity threshold (
						{threshold.toFixed(2)}) may be too high, or no persona's description is semantically
						close to this query.
					</div>
				</div>
			)}

			{!loading && results.length > 0 && (
				<div className="space-y-2">
					{results.map((match) => {
						const pct = (match.similarity * 100).toFixed(1);
						const barColor =
							match.similarity >= 0.7
								? theme.colors.success
								: match.similarity >= 0.4
									? theme.colors.warning
									: theme.colors.error;
						return (
							<div
								key={match.personaId}
								className="rounded border p-3 space-y-1.5"
								style={{ borderColor: theme.colors.border }}
							>
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-2 min-w-0">
										<div
											className="text-xs font-bold truncate"
											style={{ color: theme.colors.textMain }}
										>
											{match.personaName}
										</div>
										<span
											className="px-1.5 py-0.5 rounded text-xs shrink-0"
											style={{
												backgroundColor: `${theme.colors.accent}15`,
												color: theme.colors.accent,
											}}
										>
											{match.roleName}
										</span>
									</div>
									<div className="text-xs font-mono font-bold shrink-0" style={{ color: barColor }}>
										{pct}%
									</div>
								</div>
								{/* Similarity bar */}
								<div
									className="h-1.5 rounded-full overflow-hidden"
									style={{ backgroundColor: `${theme.colors.border}40` }}
								>
									<div
										className="h-full rounded-full transition-all"
										style={{
											width: `${match.similarity * 100}%`,
											backgroundColor: barColor,
										}}
									/>
								</div>
								{match.description && (
									<div className="text-xs" style={{ color: theme.colors.textDim }}>
										{match.description.length > 150
											? match.description.slice(0, 150) + '...'
											: match.description}
									</div>
								)}
							</div>
						);
					})}
					<div className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
						Match threshold: {threshold.toFixed(2)} — personas below this score are excluded
					</div>
				</div>
			)}
		</div>
	);
}

// ─── PersonaCardView ────────────────────────────────────────────────────────

interface PersonaCardViewProps {
	persona: PersonaCard;
	theme: Theme;
	actionLoading: string | null;
	expandedDescriptions: Set<string>;
	expandedPrompts: Set<string>;
	onToggleDescription: () => void;
	onTogglePrompt: () => void;
	onEdit: () => void;
	onDuplicate: () => void;
	onToggleActive: () => void;
	onDelete: () => void;
	onReEmbed: () => void;
}

function PersonaCardView({
	persona,
	theme,
	actionLoading,
	expandedDescriptions,
	expandedPrompts,
	onToggleDescription,
	onTogglePrompt,
	onEdit,
	onDuplicate,
	onToggleActive,
	onDelete,
	onReEmbed,
}: PersonaCardViewProps) {
	const isDescExpanded = expandedDescriptions.has(persona.id);
	const isPromptExpanded = expandedPrompts.has(persona.id);
	const hasEmbedding = persona.embedding && persona.embedding.length > 0;

	return (
		<div
			className="rounded-lg border p-4 space-y-2.5"
			style={{
				borderColor: persona.active ? theme.colors.border : `${theme.colors.border}80`,
				opacity: persona.active ? 1 : 0.7,
			}}
		>
			{/* Header row: name + status + actions */}
			<div className="flex items-start justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0">
					<div
						className="w-2 h-2 rounded-full shrink-0"
						style={{
							backgroundColor: persona.active ? theme.colors.success : theme.colors.textDim,
						}}
						title={persona.active ? 'Active' : 'Inactive'}
					/>
					<div className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
						{persona.name}
					</div>
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<ActionButton icon={Edit3} title="Edit" onClick={onEdit} theme={theme} loading={false} />
					<ActionButton
						icon={Copy}
						title="Duplicate"
						onClick={onDuplicate}
						theme={theme}
						loading={actionLoading === `duplicate:${persona.id}`}
					/>
					<ActionButton
						icon={Power}
						title={persona.active ? 'Deactivate' : 'Activate'}
						onClick={onToggleActive}
						theme={theme}
						loading={actionLoading === `toggle:${persona.id}`}
					/>
					<ActionButton
						icon={RefreshCw}
						title="Re-embed"
						onClick={onReEmbed}
						theme={theme}
						loading={actionLoading === `reembed:${persona.id}`}
					/>
					<ActionButton
						icon={Trash2}
						title="Delete"
						onClick={onDelete}
						theme={theme}
						loading={actionLoading === `delete:${persona.id}`}
						danger
					/>
				</div>
			</div>

			{/* Role badge */}
			<div className="flex items-center gap-2">
				<span
					className="px-2 py-0.5 rounded text-xs"
					style={{ backgroundColor: `${theme.colors.accent}15`, color: theme.colors.accent }}
				>
					{persona.roleName}
				</span>
				{/* Embedding status */}
				{hasEmbedding ? (
					<span
						className="flex items-center gap-0.5 text-xs"
						style={{ color: theme.colors.success }}
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

			{/* Description (truncated) */}
			{persona.description && (
				<div
					className="text-xs cursor-pointer"
					style={{ color: theme.colors.textDim }}
					onClick={onToggleDescription}
				>
					{isDescExpanded
						? persona.description
						: persona.description.length > 120
							? persona.description.slice(0, 120) + '...'
							: persona.description}
				</div>
			)}

			{/* System prompt preview */}
			{persona.systemPrompt && (
				<div
					className="text-xs font-mono cursor-pointer p-2 rounded"
					style={{ color: theme.colors.textDim, backgroundColor: `${theme.colors.border}20` }}
					onClick={onTogglePrompt}
				>
					{isPromptExpanded
						? persona.systemPrompt
						: persona.systemPrompt.length > 100
							? persona.systemPrompt.slice(0, 100) + '...'
							: persona.systemPrompt}
				</div>
			)}

			{/* Badges row: skills, memories, agents, projects */}
			<div className="flex flex-wrap gap-1.5">
				<Badge theme={theme} label={`${persona.skillCount} skills`} />
				<Badge theme={theme} label={`${persona.memoryCount} memories`} />
				{persona.assignedAgents.length > 0 ? (
					persona.assignedAgents.map((a) => <Badge key={a} theme={theme} label={a} accent />)
				) : (
					<Badge theme={theme} label="All agents" />
				)}
				{persona.assignedProjects.length > 0 ? (
					persona.assignedProjects.map((p) => (
						<Badge key={p} theme={theme} label={p.split('/').pop() ?? p} />
					))
				) : (
					<Badge theme={theme} label="All projects" />
				)}
			</div>
		</div>
	);
}

// ─── Small UI components ────────────────────────────────────────────────────

function ActionButton({
	icon: Icon,
	title,
	onClick,
	theme,
	loading,
	danger,
}: {
	icon: React.FC<{ className?: string; style?: React.CSSProperties }>;
	title: string;
	onClick: () => void;
	theme: Theme;
	loading: boolean;
	danger?: boolean;
}) {
	return (
		<button
			className="p-1 rounded hover:opacity-70"
			title={title}
			onClick={onClick}
			disabled={loading}
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

function Badge({ theme, label, accent }: { theme: Theme; label: string; accent?: boolean }) {
	return (
		<span
			className="px-1.5 py-0.5 rounded text-xs"
			style={{
				backgroundColor: accent ? `${theme.colors.accent}15` : `${theme.colors.border}30`,
				color: accent ? theme.colors.accent : theme.colors.textDim,
			}}
		>
			{label}
		</span>
	);
}

// ─── Export/Import types and helpers ─────────────────────────────────────────

interface PersonaExportData {
	version: number;
	exportedAt: string;
	personas: Array<{
		name: string;
		description?: string;
		systemPrompt?: string;
		assignedAgents?: string[];
		assignedProjects?: string[];
		role?: { id: string; name: string };
		skills?: Array<{ name: string; description?: string }>;
		memoryCount?: number;
	}>;
}

function buildPersonaExport(
	roleGroups: RoleGroup[],
	skills: SkillArea[],
	memories: MemoryEntry[]
): PersonaExportData {
	const personas: PersonaExportData['personas'] = [];
	for (const group of roleGroups) {
		for (const persona of group.personas) {
			const personaSkills = skills
				.filter((s) => s.personaId === persona.id)
				.map((s) => ({ name: s.name, description: s.description }));
			const memoryCount = memories.filter((m) => m.personaId === persona.id).length;
			personas.push({
				name: persona.name,
				description: persona.description,
				systemPrompt: persona.systemPrompt,
				assignedAgents: persona.assignedAgents,
				assignedProjects: persona.assignedProjects,
				role: { id: group.role.id, name: group.role.name },
				skills: personaSkills,
				memoryCount,
			});
		}
	}
	return {
		version: 1,
		exportedAt: new Date().toISOString(),
		personas,
	};
}

function downloadPersonaJson(data: PersonaExportData, label: string) {
	const json = JSON.stringify(data, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = `maestro-personas-${label}-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
