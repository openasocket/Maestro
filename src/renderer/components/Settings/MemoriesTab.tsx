/**
 * MemoriesTab - Primary memory management view within MemorySettings.
 *
 * Contains:
 * - Collapsible lifecycle settings (decay, pruning)
 * - Quick Create toolbar (New Rule, New Experience, Paste from Clipboard)
 * - Memory statistics summary bar
 * - Embedded MemoryBrowserPanel (tree browser + library panel)
 * - Cross-tab navigation via initialFilter prop
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Scissors,
	Loader2,
	Settings,
	Plus,
	Shield,
	Lightbulb,
	ClipboardPaste,
	X,
	BarChart3,
	AlertTriangle,
	Eye,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	MemoryEntry,
	MemoryScope,
	MemoryType,
	SkillAreaId,
	PersonaId,
	RoleId,
} from '../../../shared/memory-types';
import { ConfigSlider } from './MemoryConfigWidgets';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';
import { MemoryBrowserPanel } from './MemoryBrowserPanel';
import { MemoryEditModal } from './MemoryEditModal';
import { useMemoryHierarchy } from '../../hooks/memory/useMemoryHierarchy';

// ─── Types ────────────────────────────────────────────────────────────────

export interface MemoryFilter {
	skillAreaId?: SkillAreaId;
	personaId?: PersonaId;
	type?: MemoryType;
	source?: string;
}

export interface MemoriesTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	onRefresh: () => Promise<void>;
	/** Optional filter for cross-tab navigation (e.g., from Skills tab) */
	initialFilter?: MemoryFilter | null;
	/** Called when the user clears cross-tab filters */
	onClearFilter?: () => void;
	/** Called when user creates/edits/promotes — promotes engagement level to Active Curator */
	onCuratorAction?: () => void;
}

export function MemoriesTab({
	theme,
	config,
	stats,
	projectPath,
	onUpdateConfig,
	onRefresh,
	initialFilter,
	onClearFilter,
	onCuratorAction,
}: MemoriesTabProps): React.ReactElement {
	const [allMemories, setAllMemories] = useState<MemoryEntry[]>([]);
	const [pruneConfirm, setPruneConfirm] = useState(false);
	const [pruning, setPruning] = useState(false);
	const [pruneProgress, setPruneProgress] = useState<{ done: number; total: number } | null>(null);
	const [lifecycleOpen, setLifecycleOpen] = useState(false);
	const [defaultScope, setDefaultScope] = useState<MemoryScope>('project');

	// Modal state for Quick Create
	const [editModal, setEditModal] = useState<{
		memory: MemoryEntry | null;
		type: MemoryType;
		scope: MemoryScope;
	} | null>(null);

	// Hierarchy for edit modal skill areas and breadcrumb display
	const hierarchy = useMemoryHierarchy();

	// Load all memories for lifecycle stats
	useEffect(() => {
		if (!config.enabled) return;
		let mounted = true;
		window.maestro.memory
			.listAllExperiences(projectPath ?? undefined)
			.then((res) => {
				if (mounted && res.success) setAllMemories(res.data);
			})
			.catch(() => {});
		return () => {
			mounted = false;
		};
	}, [config.enabled, projectPath, stats]);

	const prunableMemories = allMemories.filter(
		(m) => m.active && !m.archived && !m.pinned && m.confidence < config.minConfidenceThreshold
	);
	const atRiskMemories = allMemories.filter(
		(m) =>
			m.active &&
			!m.archived &&
			!m.pinned &&
			m.confidence < config.minConfidenceThreshold * 2 &&
			m.confidence >= config.minConfidenceThreshold
	);

	// Computed stats from allMemories
	const computedStats = useMemo(() => {
		const active = allMemories.filter((m) => m.active && !m.archived);
		const archived = allMemories.filter((m) => m.archived || !m.active);
		const rules = active.filter((m) => m.type === 'rule');
		const experiences = active.filter((m) => m.type === 'experience');
		const bySkill = active.filter((m) => m.scope === 'skill');
		const byProject = active.filter((m) => m.scope === 'project');
		const byGlobal = active.filter((m) => m.scope === 'global');
		const avgConfidence =
			active.length > 0 ? active.reduce((sum, m) => sum + m.confidence, 0) / active.length : 0;
		const neverUsed = active.filter((m) => m.useCount === 0);
		const totalTokens = active.reduce((sum, m) => sum + (m.tokenEstimate || 0), 0);

		return {
			activeCount: active.length,
			archivedCount: archived.length,
			ruleCount: rules.length,
			experienceCount: experiences.length,
			skillCount: bySkill.length,
			projectCount: byProject.length,
			globalCount: byGlobal.length,
			avgConfidence,
			neverUsedCount: neverUsed.length,
			totalTokens,
		};
	}, [allMemories]);

	// Breadcrumb for cross-tab filter
	const filterBreadcrumb = useMemo(() => {
		if (!initialFilter) return null;
		const parts: string[] = [];
		if (initialFilter.skillAreaId) {
			const skill = hierarchy.skillAreas.find((s) => s.id === initialFilter.skillAreaId);
			if (skill) {
				const persona = hierarchy.personas.find((p) => p.id === skill.personaId);
				if (persona) parts.push(persona.name);
				parts.push(skill.name);
			}
		}
		if (initialFilter.personaId && !initialFilter.skillAreaId) {
			const persona = hierarchy.personas.find((p) => p.id === initialFilter.personaId);
			if (persona) parts.push(persona.name);
		}
		if (initialFilter.type) {
			parts.push(initialFilter.type === 'rule' ? 'Rules' : 'Experiences');
		}
		return parts.length > 0 ? parts.join(' > ') : null;
	}, [initialFilter, hierarchy.skillAreas, hierarchy.personas]);

	const handlePruneMemories = useCallback(async () => {
		setPruning(true);
		setPruneProgress({ done: 0, total: prunableMemories.length });
		try {
			for (let i = 0; i < prunableMemories.length; i++) {
				const m = prunableMemories[i];
				await window.maestro.memory.update(
					m.id,
					{ active: false },
					m.scope,
					m.skillAreaId,
					undefined
				);
				setPruneProgress({ done: i + 1, total: prunableMemories.length });
			}
			await onRefresh();
		} catch {
			// Error handled by parent via stats refresh
		} finally {
			setPruning(false);
			setPruneConfirm(false);
			setPruneProgress(null);
		}
	}, [prunableMemories, onRefresh]);

	// Available skills for the edit modal
	const availableSkills = useMemo(() => {
		return hierarchy.skillAreas.map((s) => {
			const persona = hierarchy.personas.find((p) => p.id === s.personaId);
			return {
				id: s.id,
				name: s.name,
				personaName: persona?.name ?? 'Unknown',
			};
		});
	}, [hierarchy.skillAreas, hierarchy.personas]);

	const handleQuickCreate = useCallback(
		(type: MemoryType) => {
			setEditModal({ memory: null, type, scope: defaultScope });
		},
		[defaultScope]
	);

	const handlePasteFromClipboard = useCallback(async () => {
		try {
			const text = await navigator.clipboard.readText();
			const parsed = JSON.parse(text);
			// Pre-populate from parsed JSON
			const entry: Partial<MemoryEntry> = {
				content: parsed.content ?? '',
				type: parsed.type ?? 'rule',
				scope: parsed.scope ?? defaultScope,
				tags: parsed.tags ?? [],
				confidence: parsed.confidence ?? 0.8,
				pinned: parsed.pinned ?? false,
				experienceContext: parsed.experienceContext,
			};
			setEditModal({
				memory: entry as MemoryEntry,
				type: entry.type as MemoryType,
				scope: entry.scope as MemoryScope,
			});
		} catch {
			// If not valid JSON, just open empty modal
			setEditModal({ memory: null, type: 'rule', scope: defaultScope });
		}
	}, [defaultScope]);

	const handleSaveMemory = useCallback(
		async (data: {
			content: string;
			type: MemoryType;
			scope: MemoryScope;
			skillAreaId?: SkillAreaId;
			personaId?: PersonaId;
			roleId?: RoleId;
			tags: string[];
			confidence: number;
			pinned: boolean;
		}) => {
			await window.maestro.memory.add(
				{
					content: data.content,
					type: data.type,
					scope: data.scope,
					skillAreaId: data.skillAreaId,
					personaId: data.personaId,
					roleId: data.roleId,
					tags: data.tags,
					confidence: data.confidence,
					pinned: data.pinned,
					source: 'user',
				},
				data.scope === 'project' ? (projectPath ?? undefined) : undefined
			);
			setEditModal(null);
			await onRefresh();
			onCuratorAction?.();
		},
		[projectPath, onRefresh, onCuratorAction]
	);

	return (
		<div className="space-y-3">
			<TabDescriptionBanner
				theme={theme}
				description="Memories are the individual knowledge entries that get injected into your agents' prompts. Rules are prescriptive ('always do X'), while experiences are contextual ('we learned Y when Z happened'). All memories have confidence scores that decay over time if unused."
			/>

			{/* Cross-tab filter breadcrumb */}
			{filterBreadcrumb && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
					style={{
						backgroundColor: `${theme.colors.accent}10`,
						borderLeft: `3px solid ${theme.colors.accent}`,
						color: theme.colors.textMain,
					}}
				>
					<Eye className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
					<span>
						Showing memories in: <strong>{filterBreadcrumb}</strong>
					</span>
					<button
						className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded text-xs transition-colors hover:opacity-80"
						style={{
							color: theme.colors.textDim,
							backgroundColor: `${theme.colors.border}40`,
						}}
						onClick={() => onClearFilter?.()}
					>
						<X className="w-3 h-3" />
						Clear Filters
					</button>
				</div>
			)}

			{/* Collapsible Lifecycle Settings */}
			<div
				className="rounded-lg border overflow-hidden"
				style={{ borderColor: theme.colors.border }}
			>
				<div
					className="px-4 transition-colors"
					style={{
						backgroundColor: lifecycleOpen ? `${theme.colors.border}20` : 'transparent',
					}}
				>
					<SectionHeader
						theme={theme}
						icon={Settings}
						title="Lifecycle Settings"
						collapsible
						collapsed={!lifecycleOpen}
						onToggle={() => setLifecycleOpen((v) => !v)}
						action={
							prunableMemories.length > 0 ? (
								<span
									className="px-1.5 py-0.5 rounded-full text-[10px]"
									style={{
										backgroundColor: '#eab30820',
										color: '#eab308',
									}}
								>
									{prunableMemories.length} prunable
								</span>
							) : undefined
						}
					/>
				</div>

				{lifecycleOpen && (
					<div
						className="px-4 pb-4 space-y-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="pt-3">
							<ConfigSlider
								label="Confidence Decay Rate"
								description="How much confidence decreases per day for unused memories (0 = no decay)"
								value={config.confidenceDecayRate}
								min={0}
								max={0.1}
								step={0.005}
								onChange={(v) => onUpdateConfig({ confidenceDecayRate: v })}
								theme={theme}
								formatValue={(v) => v.toFixed(3)}
							/>
						</div>

						<ConfigSlider
							label="Auto-Archive Threshold"
							description="Memories below this confidence are automatically archived"
							value={config.minConfidenceThreshold}
							min={0}
							max={0.5}
							step={0.05}
							onChange={(v) => onUpdateConfig({ minConfidenceThreshold: v })}
							theme={theme}
							formatValue={(v) => v.toFixed(2)}
						/>

						<ConfigSlider
							label="Max Memories Per Skill"
							description="Oldest memories are evicted when a skill area exceeds this count"
							value={config.maxMemoriesPerSkillArea}
							min={10}
							max={200}
							step={10}
							onChange={(v) => onUpdateConfig({ maxMemoriesPerSkillArea: v })}
							theme={theme}
						/>

						{/* Prune Now */}
						<div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
							{!pruneConfirm ? (
								<button
									className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors"
									style={{
										color: theme.colors.textDim,
										backgroundColor: `${theme.colors.border}40`,
									}}
									onClick={() => setPruneConfirm(true)}
									disabled={pruning || prunableMemories.length === 0}
									title={
										prunableMemories.length === 0
											? 'No memories below threshold'
											: `${prunableMemories.length} memories below ${config.minConfidenceThreshold} confidence`
									}
								>
									<Scissors className="w-3 h-3" />
									Prune Low-Confidence Memories
									{prunableMemories.length > 0 && (
										<span
											className="ml-1 px-1.5 py-0.5 rounded-full text-xs"
											style={{ backgroundColor: `${theme.colors.border}60` }}
										>
											{prunableMemories.length}
										</span>
									)}
								</button>
							) : pruning ? (
								<div
									className="flex items-center gap-2 text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<Loader2 className="w-3 h-3 animate-spin" />
									{pruneProgress
										? `Pruning... ${pruneProgress.done}/${pruneProgress.total}`
										: 'Pruning...'}
								</div>
							) : (
								<div className="space-y-2">
									<div className="text-xs" style={{ color: theme.colors.textMain }}>
										Archive {prunableMemories.length} memories below {config.minConfidenceThreshold}{' '}
										confidence?
									</div>
									<div className="flex gap-2">
										<button
											className="px-2.5 py-1 rounded text-xs"
											style={{
												color: theme.colors.textMain,
												backgroundColor: '#ef4444',
											}}
											onClick={handlePruneMemories}
										>
											Confirm
										</button>
										<button
											className="px-2.5 py-1 rounded text-xs"
											style={{
												color: theme.colors.textDim,
												backgroundColor: `${theme.colors.border}40`,
											}}
											onClick={() => setPruneConfirm(false)}
										>
											Cancel
										</button>
									</div>
								</div>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Memory Statistics Summary Bar */}
			{stats && (
				<div
					className="rounded-lg border p-3 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<SectionHeader theme={theme} icon={BarChart3} title="Memory Overview" />

					{/* Row 1: counts */}
					<div
						className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>
							<strong style={{ color: theme.colors.textMain }}>{computedStats.activeCount}</strong>{' '}
							active
							{computedStats.archivedCount > 0 && (
								<>
									, <strong>{computedStats.archivedCount}</strong> archived
								</>
							)}
						</span>
						<span>
							<span
								className="inline-block w-2 h-2 rounded-full mr-1"
								style={{ backgroundColor: theme.colors.accent }}
							/>
							{computedStats.ruleCount} rules
						</span>
						<span>
							<span
								className="inline-block w-2 h-2 rounded-full mr-1"
								style={{ backgroundColor: '#eab308' }}
							/>
							{computedStats.experienceCount} experiences
						</span>
					</div>

					{/* Row 2: scope breakdown */}
					<div
						className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>{computedStats.skillCount} in skills</span>
						<span>{computedStats.projectCount} project-scoped</span>
						<span>{computedStats.globalCount} global</span>
					</div>

					{/* Row 3: confidence + alerts */}
					<div
						className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						{/* Average confidence bar */}
						<span className="flex items-center gap-1.5">
							Avg confidence:
							<span
								className="inline-block h-1.5 rounded-full"
								style={{
									width: '60px',
									backgroundColor: `${theme.colors.border}40`,
								}}
							>
								<span
									className="block h-full rounded-full"
									style={{
										width: `${Math.round(computedStats.avgConfidence * 100)}%`,
										backgroundColor:
											computedStats.avgConfidence >= 0.6
												? '#22c55e'
												: computedStats.avgConfidence >= 0.3
													? '#eab308'
													: '#ef4444',
									}}
								/>
							</span>
							<span>{(computedStats.avgConfidence * 100).toFixed(0)}%</span>
						</span>
					</div>

					{/* Row 4: alerts */}
					<div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
						{atRiskMemories.length > 0 && (
							<span style={{ color: '#eab308' }}>
								<AlertTriangle
									className="w-3 h-3 inline mr-1"
									style={{ verticalAlign: 'text-bottom' }}
								/>
								{atRiskMemories.length} below archive threshold
							</span>
						)}
						{computedStats.neverUsedCount > 0 && (
							<span style={{ color: theme.colors.textDim }}>
								{computedStats.neverUsedCount} never used
							</span>
						)}
						<span style={{ color: theme.colors.textDim }}>
							{computedStats.totalTokens.toLocaleString()} tokens /{' '}
							{config.maxTokenBudget.toLocaleString()} budget
						</span>
					</div>
				</div>
			)}

			{/* Quick Create Toolbar */}
			<div className="flex items-center gap-2 flex-wrap">
				<button
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80"
					style={{
						color: theme.colors.accent,
						backgroundColor: `${theme.colors.accent}15`,
						border: `1px solid ${theme.colors.accent}30`,
					}}
					onClick={() => handleQuickCreate('rule')}
					title="Create a new rule memory"
				>
					<Plus className="w-3 h-3" />
					<Shield className="w-3 h-3" />
					New Rule
				</button>
				<button
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80"
					style={{
						color: '#eab308',
						backgroundColor: '#eab30815',
						border: '1px solid #eab30830',
					}}
					onClick={() => handleQuickCreate('experience')}
					title="Create a new experience memory"
				>
					<Plus className="w-3 h-3" />
					<Lightbulb className="w-3 h-3" />
					New Experience
				</button>
				<button
					className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors hover:opacity-80"
					style={{
						color: theme.colors.textDim,
						backgroundColor: `${theme.colors.border}30`,
						border: `1px solid ${theme.colors.border}60`,
					}}
					onClick={handlePasteFromClipboard}
					title="Paste memory JSON from clipboard"
				>
					<ClipboardPaste className="w-3 h-3" />
					Paste from Clipboard
				</button>

				{/* Scope selector */}
				<div className="ml-auto flex items-center gap-1.5">
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						Default scope:
					</span>
					<select
						className="text-xs rounded px-1.5 py-1 border outline-none"
						style={{
							backgroundColor: 'transparent',
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						value={defaultScope}
						onChange={(e) => setDefaultScope(e.target.value as MemoryScope)}
					>
						<option value="skill">Skill</option>
						<option value="project">Project</option>
						<option value="global">Global</option>
					</select>
				</div>
			</div>

			{/* Memory Browser Panel (tree + library) */}
			<MemoryBrowserPanel
				theme={theme}
				projectPath={projectPath ?? null}
				hierarchy={hierarchy}
				injectionTone={config.injectionTone}
			/>

			{/* Quick Create Modal */}
			{editModal && (
				<MemoryEditModal
					theme={theme}
					memory={editModal.memory}
					defaultScope={editModal.scope}
					availableSkills={availableSkills}
					onSave={handleSaveMemory}
					onClose={() => setEditModal(null)}
				/>
			)}
		</div>
	);
}
