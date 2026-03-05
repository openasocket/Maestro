/**
 * ExperiencesTab - Experiences sub-tab within MemorySettings.
 *
 * Four-section layout:
 *   1. Extraction — pipeline config, status, background processing toggles
 *   2. Review — experience card list with filters, sort, per-card actions
 *   3. Promotion Candidates — system-identified promotion-ready experiences + cross-project config
 *   4. Repository — global experience repository (import/export/browse)
 *
 * Moved from MemorySettings.tsx during MEM-TAB-01 redistribution.
 * Restructured into sections during MEM-TAB-04.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
	Activity,
	Loader2,
	Check,
	ArrowUpCircle,
	Edit3,
	X,
	Pin,
	PinOff,
	Globe,
	Search,
	ChevronDown,
	ChevronRight,
	Archive,
	BarChart3,
	Sparkles,
	Hash,
	Brain,
	ArrowUpDown,
	Layers,
	SlidersHorizontal,
	TrendingUp,
	Clock,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	MemoryEntry,
	MemoryScope,
	MemorySource,
	SkillAreaId,
	PromotionCandidate,
	JobQueueStatus,
	TokenUsage,
	ExtractionDiagnostic,
	ExtractionProgress,
	SkillArea,
	Persona,
} from '../../../shared/memory-types';
import { ConfigToggle, ConfigSlider } from './MemoryConfigWidgets';
import { ExperienceRepositoryPanel } from './ExperienceRepositoryPanel';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';
import { MemoryEditModal } from './MemoryEditModal';
import {
	MemoryMovePromotePopover,
	PromotionDialog,
	ScopeConfirmDialog,
	type MovePromoteAction,
} from './MemoryMovePromotePopover';

// ─── Types ──────────────────────────────────────────────────────────────────────

type ReviewSortField = 'newest' | 'confidence' | 'most-used' | 'effectiveness';
type ReviewSourceFilter = 'all' | MemorySource;
type ReviewDeviationFilter = 'all' | 'deviation' | 'normal';

type EnrichedExperience = MemoryEntry & {
	scopeLabel: string;
	skillAreaName?: string;
	personaName?: string;
};

// ─── Section Header ─────────────────────────────────────────────────────────────

// SectionHeader is now imported from ./SectionHeader

// ─── Source color map for the stacked bar ────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
	'session-analysis': '#3b82f6', // blue
	'auto-run': '#8b5cf6', // purple
	user: '#22c55e', // green
	grpo: '#f59e0b', // amber
	consolidation: '#06b6d4', // cyan
	import: '#64748b', // slate
	repository: '#ec4899', // pink
};

const SOURCE_LABELS: Record<string, string> = {
	'session-analysis': 'Session Analysis',
	'auto-run': 'Auto Run',
	user: 'User',
	grpo: 'Promoted',
	consolidation: 'Consolidation',
	import: 'Imported',
	repository: 'Repository',
};

// ─── Experience Visualization Summary ────────────────────────────────────────────

function ExperienceVisualizationSummary({
	theme,
	experiences,
	currentProjectCount,
	promotionCandidateCount,
	promotedCount,
	lastDiagnostic,
}: {
	theme: Theme;
	experiences: EnrichedExperience[];
	currentProjectCount: number;
	promotionCandidateCount: number;
	promotedCount: number;
	lastDiagnostic: ExtractionDiagnostic | null;
}) {
	const total = experiences.length;

	// Source breakdown
	const sourceCounts = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const e of experiences) {
			counts[e.source] = (counts[e.source] ?? 0) + 1;
		}
		return Object.entries(counts).sort(([, a], [, b]) => b - a);
	}, [experiences]);

	// Deviation counts
	const deviationCount = useMemo(
		() => experiences.filter((e) => e.experienceContext?.isDeviation).length,
		[experiences]
	);
	const normalCount = total - deviationCount;

	if (total === 0) {
		return (
			<div
				className="rounded-lg border p-4 text-center"
				style={{ borderColor: theme.colors.border }}
			>
				<Sparkles className="w-5 h-5 mx-auto mb-2" style={{ color: theme.colors.textDim }} />
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					No experiences yet. Complete sessions with 3+ interactions to start building your
					experience library.
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-lg border p-3 space-y-3" style={{ borderColor: theme.colors.border }}>
			{/* Row 1: Totals + Source Bar */}
			<div className="flex items-start gap-4">
				{/* Total count */}
				<div className="shrink-0">
					<div className="text-lg font-bold leading-tight" style={{ color: theme.colors.textMain }}>
						{total}
					</div>
					<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{currentProjectCount > 0
							? `total (${currentProjectCount} this project)`
							: 'total experiences'}
					</div>
				</div>

				{/* Source stacked bar */}
				<div className="flex-1 min-w-0">
					<div className="text-[10px] mb-1" style={{ color: theme.colors.textDim }}>
						Sources
					</div>
					<div
						className="flex h-2.5 rounded-full overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}40` }}
					>
						{sourceCounts.map(([source, count]) => (
							<div
								key={source}
								title={`${SOURCE_LABELS[source] ?? source}: ${count}`}
								style={{
									width: `${(count / total) * 100}%`,
									backgroundColor: SOURCE_COLORS[source] ?? '#94a3b8',
									minWidth: count > 0 ? '3px' : 0,
								}}
							/>
						))}
					</div>
					{/* Legend */}
					<div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
						{sourceCounts.map(([source, count]) => (
							<div key={source} className="flex items-center gap-1">
								<div
									className="w-1.5 h-1.5 rounded-full shrink-0"
									style={{ backgroundColor: SOURCE_COLORS[source] ?? '#94a3b8' }}
								/>
								<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
									{SOURCE_LABELS[source] ?? source} ({count})
								</span>
							</div>
						))}
					</div>
				</div>
			</div>

			{/* Row 2: Deviation + Funnel + Last Extraction */}
			<div className="flex items-stretch gap-2">
				{/* Deviation analysis */}
				<div className="flex-1 rounded p-2" style={{ backgroundColor: `${theme.colors.border}15` }}>
					<div className="flex items-center gap-1 mb-1">
						<AlertTriangle className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
							Deviations
						</span>
					</div>
					<div className="flex items-baseline gap-2">
						<span
							className="text-sm font-bold"
							style={{ color: deviationCount > 0 ? '#f59e0b' : theme.colors.textMain }}
						>
							{deviationCount}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							deviation{deviationCount !== 1 ? 's' : ''}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							/ {normalCount} normal
						</span>
					</div>
				</div>

				{/* Promotion funnel */}
				<div className="flex-1 rounded p-2" style={{ backgroundColor: `${theme.colors.border}15` }}>
					<div className="flex items-center gap-1 mb-1">
						<TrendingUp className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
							Promotion Funnel
						</span>
					</div>
					<div
						className="flex items-center gap-1 text-[11px]"
						style={{ color: theme.colors.textMain }}
					>
						<span className="font-bold">{total}</span>
						<span style={{ color: theme.colors.textDim }}>→</span>
						<span
							className="font-bold"
							style={{ color: promotionCandidateCount > 0 ? '#f59e0b' : undefined }}
						>
							{promotionCandidateCount}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							candidates
						</span>
						<span style={{ color: theme.colors.textDim }}>→</span>
						<span
							className="font-bold"
							style={{ color: promotedCount > 0 ? '#22c55e' : undefined }}
						>
							{promotedCount}
						</span>
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							promoted
						</span>
					</div>
				</div>

				{/* Last extraction */}
				<div className="flex-1 rounded p-2" style={{ backgroundColor: `${theme.colors.border}15` }}>
					<div className="flex items-center gap-1 mb-1">
						<Clock className="w-3 h-3" style={{ color: theme.colors.textDim }} />
						<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
							Last Extraction
						</span>
					</div>
					{lastDiagnostic ? (
						<div>
							<div className="text-[11px] font-medium" style={{ color: theme.colors.textMain }}>
								{getRelativeTime(lastDiagnostic.timestamp)}
							</div>
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								{lastDiagnostic.status === 'success'
									? `extracted ${lastDiagnostic.experiencesStored ?? 0} experience${(lastDiagnostic.experiencesStored ?? 0) !== 1 ? 's' : ''}`
									: lastDiagnostic.status.replace(/-/g, ' ')}
							</div>
						</div>
					) : (
						<div className="text-[11px]" style={{ color: theme.colors.textDim }}>
							No extractions yet
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface ExperiencesTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	onRefresh: () => Promise<void>;
	activeAgentId?: string | null;
	activeAgentType?: string | null;
}

// ─── Main Component ─────────────────────────────────────────────────────────────

export function ExperiencesTab({
	theme,
	config,
	stats,
	projectPath,
	onUpdateConfig,
	onRefresh,
	activeAgentId,
	activeAgentType,
}: ExperiencesTabProps): React.ReactElement {
	// ─── Section collapse state ─────────────────────────────────────────
	const [extractionCollapsed, setExtractionCollapsed] = useState(false);
	const [reviewCollapsed, setReviewCollapsed] = useState(false);
	const [promotionCollapsed, setPromotionCollapsed] = useState(false);
	const [repositoryCollapsed, setRepositoryCollapsed] = useState(true);

	// ─── Promotion state ────────────────────────────────────────────────
	const [promotionCandidates, setPromotionCandidates] = useState<PromotionCandidate[]>([]);
	const [editingPromotionId, setEditingPromotionId] = useState<string | null>(null);
	const [editingRuleText, setEditingRuleText] = useState('');
	const [error, setError] = useState<string | null>(null);

	// ─── Extraction state ───────────────────────────────────────────────
	const [queueStatus, setQueueStatus] = useState<JobQueueStatus | null>(null);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
	const [batchCapableAgents, setBatchCapableAgents] = useState<{ id: string; name: string }[]>([]);

	// ─── Review state ───────────────────────────────────────────────────
	const [experiences, setExperiences] = useState<EnrichedExperience[]>([]);
	const [experiencesLoading, setExperiencesLoading] = useState(false);
	const [reviewSearch, setReviewSearch] = useState('');
	const [reviewSort, setReviewSort] = useState<ReviewSortField>('newest');
	const [reviewSourceFilter, setReviewSourceFilter] = useState<ReviewSourceFilter>('all');
	const [reviewDeviationFilter, setReviewDeviationFilter] = useState<ReviewDeviationFilter>('all');
	const [editingMemory, setEditingMemory] = useState<EnrichedExperience | null>(null);
	const [reviewConfidenceMin, setReviewConfidenceMin] = useState<number>(0);
	const [reviewConfidenceMax, setReviewConfidenceMax] = useState<number>(1);
	const [reviewDateRange, setReviewDateRange] = useState<'all' | '24h' | '7d' | '30d' | '90d'>(
		'all'
	);
	const [reviewProjectFilter, setReviewProjectFilter] = useState<string>('all');

	// ─── Hierarchy data for Move/Promote ────────────────────────────────
	const [skillAreas, setSkillAreas] = useState<SkillArea[]>([]);
	const [personasList, setPersonasList] = useState<Persona[]>([]);
	const [movePromoteMemory, setMovePromoteMemory] = useState<MemoryEntry | null>(null);
	const [movePromoteScopeConfirm, setMovePromoteScopeConfirm] = useState<{
		memory: MemoryEntry;
		direction: 'to-global' | 'to-project';
	} | null>(null);

	useEffect(() => {
		if (!config.enabled) return;
		(async () => {
			try {
				const [, personasRes, skillsRes] = await Promise.all([
					window.maestro.memory.role.list(),
					window.maestro.memory.persona.list(),
					window.maestro.memory.skill.list(),
				]);
				if (personasRes.success) setPersonasList(personasRes.data);
				if (skillsRes.success) setSkillAreas(skillsRes.data);
			} catch {
				// Non-critical
			}
		})();
	}, [config.enabled]);

	const handleMovePromoteAction = useCallback(
		(action: MovePromoteAction) => {
			switch (action.kind) {
				case 'promote-to-rule':
					setMovePromoteMemory(action.memory);
					break;
				case 'scope-to-global':
					setMovePromoteScopeConfirm({ memory: action.memory, direction: 'to-global' });
					break;
				case 'scope-to-project':
					setMovePromoteScopeConfirm({ memory: action.memory, direction: 'to-project' });
					break;
				case 'move-to-skill':
				case 'assign-skill':
					(async () => {
						try {
							await window.maestro.memory.moveScope(
								action.memory.id,
								action.memory.scope,
								action.memory.skillAreaId,
								action.memory.scope === 'project' ? (projectPath ?? undefined) : undefined,
								'skill',
								action.skillAreaId,
								undefined
							);
							onRefresh();
						} catch {
							// Move failed
						}
					})();
					break;
				default:
					break;
			}
		},
		[projectPath, onRefresh]
	);

	const handleMovePromoteConfirm = useCallback(
		async (ruleText: string, archiveSource: boolean) => {
			if (!movePromoteMemory) return;
			try {
				await window.maestro.memory.promote(
					movePromoteMemory.id,
					ruleText,
					movePromoteMemory.scope as string,
					movePromoteMemory.skillAreaId,
					movePromoteMemory.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
				if (archiveSource) {
					await window.maestro.memory.update(
						movePromoteMemory.id,
						{ active: false },
						movePromoteMemory.scope,
						movePromoteMemory.skillAreaId,
						movePromoteMemory.scope === 'project' ? (projectPath ?? undefined) : undefined
					);
				}
				onRefresh();
			} catch {
				// Promotion failed
			} finally {
				setMovePromoteMemory(null);
			}
		},
		[movePromoteMemory, projectPath, onRefresh]
	);

	const handleMovePromoteScopeConfirm = useCallback(
		async (keepCopy: boolean) => {
			if (!movePromoteScopeConfirm) return;
			const { memory, direction } = movePromoteScopeConfirm;
			try {
				const toScope: MemoryScope = direction === 'to-global' ? 'global' : 'project';
				if (keepCopy) {
					await window.maestro.memory.add(
						{
							content: memory.content,
							type: memory.type,
							scope: toScope,
							tags: memory.tags,
							source: memory.source,
							confidence: memory.confidence,
							pinned: memory.pinned,
							experienceContext: memory.experienceContext,
						},
						toScope === 'project' ? (projectPath ?? undefined) : undefined
					);
				} else {
					await window.maestro.memory.moveScope(
						memory.id,
						memory.scope,
						memory.skillAreaId,
						memory.scope === 'project' ? (projectPath ?? undefined) : undefined,
						toScope,
						undefined,
						toScope === 'project' ? (projectPath ?? undefined) : undefined
					);
				}
				onRefresh();
			} catch {
				// Scope change failed
			} finally {
				setMovePromoteScopeConfirm(null);
			}
		},
		[movePromoteScopeConfirm, projectPath, onRefresh]
	);

	// ─── Fetch batch-capable agents ─────────────────────────────────────
	useEffect(() => {
		if (!config.enabled || !config.enableExperienceExtraction) return;
		window.maestro.agents
			.detect()
			.then((agents: any[]) => {
				const batchAgents = agents
					.filter((a: any) => a.available && a.capabilities?.supportsBatchMode && !a.hidden)
					.map((a: any) => ({ id: a.id, name: a.name }));
				setBatchCapableAgents(batchAgents);
			})
			.catch(() => {});
	}, [config.enabled, config.enableExperienceExtraction]);

	// ─── Subscribe to queue status updates ──────────────────────────────
	useEffect(() => {
		if (!config.enabled) return;

		const handler = (status: JobQueueStatus) => setQueueStatus(status);
		const cleanup = (window.maestro.memory as any).onJobQueueUpdate(handler);

		const fetchAll = () => {
			(window.maestro.memory as any).getJobQueueStatus?.().then((res: any) => {
				if (res?.success) setQueueStatus(res.data);
			});
			(window.maestro.memory as any).getTokenUsage?.().then((res: any) => {
				if (res?.success) setTokenUsage(res.data);
			});
		};

		fetchAll();
		const interval = setInterval(fetchAll, 10000);

		return () => {
			cleanup?.();
			clearInterval(interval);
		};
	}, [config.enabled]);

	// ─── Load promotion candidates ──────────────────────────────────────
	const loadPromotionCandidates = useCallback(async () => {
		try {
			const res = await window.maestro.memory.getPromotionCandidates();
			if (res.success) {
				setPromotionCandidates(res.data);
			}
		} catch {
			// Non-critical
		}
	}, []);

	useEffect(() => {
		if (!config.enabled) return;
		let mounted = true;
		const timer = setTimeout(async () => {
			if (!mounted) return;
			await loadPromotionCandidates();
		}, 300);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	}, [config.enabled, loadPromotionCandidates]);

	// ─── Load experiences for review ────────────────────────────────────
	const loadExperiences = useCallback(async () => {
		setExperiencesLoading(true);
		try {
			const res = await window.maestro.memory.listAllExperiences(projectPath ?? undefined);
			if (res.success) {
				setExperiences(res.data);
			}
		} catch {
			// Non-critical
		} finally {
			setExperiencesLoading(false);
		}
	}, [projectPath]);

	useEffect(() => {
		if (!config.enabled) return;
		loadExperiences();
	}, [config.enabled, loadExperiences]);

	// ─── Unique projects for filter ────────────────────────────────────
	const availableProjects = useMemo(() => {
		const projects = new Set<string>();
		for (const e of experiences) {
			const p = e.experienceContext?.sourceProjectPath;
			if (p) projects.add(p);
		}
		return Array.from(projects).sort();
	}, [experiences]);

	// ─── Filtered & sorted experiences ──────────────────────────────────
	const filteredExperiences = useMemo(() => {
		let result = experiences;

		// Source filter
		if (reviewSourceFilter !== 'all') {
			result = result.filter((e) => e.source === reviewSourceFilter);
		}

		// Deviation filter
		if (reviewDeviationFilter === 'deviation') {
			result = result.filter((e) => e.experienceContext?.isDeviation);
		} else if (reviewDeviationFilter === 'normal') {
			result = result.filter((e) => !e.experienceContext?.isDeviation);
		}

		// Confidence range filter
		if (reviewConfidenceMin > 0 || reviewConfidenceMax < 1) {
			result = result.filter(
				(e) => e.confidence >= reviewConfidenceMin && e.confidence <= reviewConfidenceMax
			);
		}

		// Date range filter
		if (reviewDateRange !== 'all') {
			const now = Date.now();
			const cutoffs: Record<string, number> = {
				'24h': 24 * 60 * 60 * 1000,
				'7d': 7 * 24 * 60 * 60 * 1000,
				'30d': 30 * 24 * 60 * 60 * 1000,
				'90d': 90 * 24 * 60 * 60 * 1000,
			};
			const cutoff = now - (cutoffs[reviewDateRange] ?? 0);
			result = result.filter((e) => e.createdAt >= cutoff);
		}

		// Project filter
		if (reviewProjectFilter !== 'all') {
			result = result.filter((e) => e.experienceContext?.sourceProjectPath === reviewProjectFilter);
		}

		// Search
		if (reviewSearch.length >= 2) {
			const q = reviewSearch.toLowerCase();
			result = result.filter(
				(e) =>
					e.content.toLowerCase().includes(q) ||
					e.experienceContext?.situation?.toLowerCase().includes(q) ||
					e.experienceContext?.learning?.toLowerCase().includes(q) ||
					e.tags.some((t) => t.toLowerCase().includes(q))
			);
		}

		// Sort
		return [...result].sort((a, b) => {
			switch (reviewSort) {
				case 'newest':
					return b.createdAt - a.createdAt;
				case 'confidence':
					return b.confidence - a.confidence;
				case 'most-used':
					return b.useCount - a.useCount;
				case 'effectiveness':
					return b.effectivenessScore - a.effectivenessScore;
				default:
					return 0;
			}
		});
	}, [
		experiences,
		reviewSourceFilter,
		reviewDeviationFilter,
		reviewConfidenceMin,
		reviewConfidenceMax,
		reviewDateRange,
		reviewProjectFilter,
		reviewSearch,
		reviewSort,
	]);

	// ─── Available skills for edit modal ────────────────────────────────
	const [availableSkills, setAvailableSkills] = useState<
		{ id: SkillAreaId; name: string; personaName: string }[]
	>([]);

	useEffect(() => {
		if (!config.enabled) return;
		Promise.all([window.maestro.memory.skill.list(), window.maestro.memory.persona.list()]).then(
			([skillsRes, personasRes]) => {
				if (skillsRes.success && personasRes.success) {
					setAvailableSkills(
						skillsRes.data.map((s: any) => ({
							id: s.id,
							name: s.name,
							personaName:
								personasRes.data.find((p: any) => p.id === s.personaId)?.name ?? 'Unknown',
						}))
					);
				}
			}
		);
	}, [config.enabled]);

	// ─── Promotion action handlers ──────────────────────────────────────
	const handlePromote = useCallback(
		async (candidate: PromotionCandidate, ruleText: string) => {
			try {
				const { memory } = candidate;
				if (candidate.isCrossProjectCandidate && candidate.crossProjectPaths?.[0]) {
					const res = await window.maestro.memory.promoteCrossProject(
						memory.id,
						ruleText,
						candidate.crossProjectPaths[0]
					);
					if (!res.success) {
						setError(res.error);
						return;
					}
				} else {
					const res = await window.maestro.memory.promote(
						memory.id,
						ruleText,
						memory.scope as MemoryScope,
						memory.skillAreaId,
						memory.experienceContext?.sourceProjectPath
					);
					if (!res.success) {
						setError(res.error);
						return;
					}
				}
				setEditingPromotionId(null);
				await loadPromotionCandidates();
				await onRefresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to promote experience');
			}
		},
		[loadPromotionCandidates, onRefresh]
	);

	const handleDismissPromotion = useCallback(
		async (candidate: PromotionCandidate) => {
			try {
				const { memory } = candidate;
				const res = await window.maestro.memory.dismissPromotion(
					memory.id,
					memory.scope as MemoryScope,
					memory.skillAreaId,
					memory.experienceContext?.sourceProjectPath
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				await loadPromotionCandidates();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to dismiss promotion');
			}
		},
		[loadPromotionCandidates]
	);

	const handleKeepAsExperience = useCallback(
		async (candidate: PromotionCandidate) => {
			try {
				const { memory } = candidate;
				const res = await window.maestro.memory.update(
					memory.id,
					{ pinned: true },
					memory.scope as MemoryScope,
					memory.skillAreaId,
					memory.experienceContext?.sourceProjectPath
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				await loadPromotionCandidates();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to pin experience');
			}
		},
		[loadPromotionCandidates]
	);

	// ─── Review card action handlers ────────────────────────────────────
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
				await loadExperiences();
			} catch {
				// Non-critical
			}
		},
		[projectPath, loadExperiences]
	);

	const handleArchive = useCallback(
		async (exp: EnrichedExperience) => {
			try {
				await window.maestro.memory.update(
					exp.id,
					{ active: false },
					exp.scope,
					exp.skillAreaId,
					exp.scope === 'project' ? (projectPath ?? undefined) : undefined
				);
				await loadExperiences();
			} catch {
				// Non-critical
			}
		},
		[projectPath, loadExperiences]
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

			setEditingMemory(null);
			await loadExperiences();
			await onRefresh();
		},
		[editingMemory, projectPath, loadExperiences, onRefresh]
	);

	// ─── Experience counts ──────────────────────────────────────────────
	const totalExperiences = experiences.length;
	const currentProjectExperiences = experiences.filter(
		(e) => e.experienceContext?.sourceProjectPath === projectPath
	).length;

	// ─── Summary data ──────────────────────────────────────────────────
	const promotedCount = stats?.bySource?.grpo ?? 0;

	// Set of promotion candidate memory IDs for highlighting in review cards
	const promotionCandidateIds = useMemo(
		() => new Set(promotionCandidates.map((c) => c.memory.id)),
		[promotionCandidates]
	);
	const lastDiagnostic = useMemo(() => {
		const diags = queueStatus?.recentDiagnostics;
		if (!diags || diags.length === 0) return null;
		return diags[diags.length - 1];
	}, [queueStatus?.recentDiagnostics]);

	return (
		<div className="flex flex-col" style={{ height: '100%' }}>
			{/* Fixed header region — does not scroll */}
			<div className="shrink-0 space-y-3 pb-2">
				<TabDescriptionBanner
					theme={theme}
					description="Experiences are lessons learned from real coding sessions — what worked, what didn't, and why. They're automatically extracted from your agent interactions and can be promoted to permanent rules when patterns prove reliable."
				/>

				{/* Visualization Summary */}
				<ExperienceVisualizationSummary
					theme={theme}
					experiences={experiences}
					currentProjectCount={currentProjectExperiences}
					promotionCandidateCount={promotionCandidates.length}
					promotedCount={promotedCount}
					lastDiagnostic={lastDiagnostic}
				/>

				{error && (
					<div
						className="flex items-center gap-2 p-3 rounded-lg text-xs"
						style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
					>
						{error}
						<button
							className="ml-auto shrink-0 p-0.5 rounded hover:opacity-80"
							onClick={() => setError(null)}
						>
							<X className="w-3 h-3" />
						</button>
					</div>
				)}
			</div>

			{/* Scrollable content region — independent scroll */}
			<div className="flex-1 overflow-y-auto min-h-0 space-y-4 mt-2">
				{/* ═══════════════════════════════════════════════════════════════════
			    Section 1: Extraction Pipeline
			    ═══════════════════════════════════════════════════════════════════ */}
				<div className="rounded-lg border" style={{ borderColor: theme.colors.border }}>
					<SectionHeader
						theme={theme}
						icon={Activity}
						title="Extraction Pipeline"
						description="Configure how experiences are extracted from sessions"
						collapsible
						collapsed={extractionCollapsed}
						onToggle={() => setExtractionCollapsed(!extractionCollapsed)}
					/>

					{!extractionCollapsed && (
						<div className="px-4 pb-4 space-y-3">
							{/* Brief explanation */}
							<div
								className="text-xs leading-relaxed rounded p-2.5"
								style={{ backgroundColor: `${theme.colors.accent}08`, color: theme.colors.textDim }}
							>
								Experience extraction automatically learns from your coding sessions. After each
								session, the system analyzes what happened and captures reusable insights — patterns
								that worked, mistakes to avoid, and techniques worth remembering.
							</div>

							{/* Background Processing Toggles */}
							<ConfigToggle
								label="Background Experience Extraction"
								description="Analyze sessions after completion to extract learnings (uses LLM tokens)"
								checked={config.enableExperienceExtraction}
								onChange={(v) => onUpdateConfig({ enableExperienceExtraction: v })}
								theme={theme}
							/>

							<ConfigToggle
								label="Auto-Consolidation"
								description="Automatically merge similar memories (saves tokens on injection)"
								checked={config.enableAutoConsolidation}
								onChange={(v) => onUpdateConfig({ enableAutoConsolidation: v })}
								theme={theme}
							/>

							{/* Per-Turn Extraction */}
							{config.enableExperienceExtraction && (
								<div
									className="rounded border p-3 space-y-3"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: `${theme.colors.border}08`,
									}}
								>
									<ConfigToggle
										label="Per-Turn Extraction"
										description="Extract experiences during a session (not just after), when an interesting turn is detected"
										checked={config.enablePerTurnExtraction}
										onChange={(v) => onUpdateConfig({ enablePerTurnExtraction: v })}
										theme={theme}
									/>

									{config.enablePerTurnExtraction && (
										<>
											<ConfigSlider
												label="Interestingness Threshold"
												description="Minimum interestingness score (0-1) for a turn to trigger extraction"
												value={config.perTurnInterestingnessThreshold}
												min={0}
												max={1}
												step={0.05}
												onChange={(v) => onUpdateConfig({ perTurnInterestingnessThreshold: v })}
												theme={theme}
												formatValue={(v) => v.toFixed(2)}
											/>
											<ConfigSlider
												label="Cooldown (seconds)"
												description="Minimum seconds between per-turn extractions within the same session"
												value={config.perTurnCooldownSeconds}
												min={10}
												max={300}
												step={10}
												onChange={(v) => onUpdateConfig({ perTurnCooldownSeconds: v })}
												theme={theme}
											/>
											<ConfigSlider
												label="Max Extractions per Session"
												description="Maximum per-turn extractions allowed in a single session"
												value={config.perTurnMaxExtractionsPerSession}
												min={1}
												max={50}
												step={1}
												onChange={(v) => onUpdateConfig({ perTurnMaxExtractionsPerSession: v })}
												theme={theme}
											/>
										</>
									)}
								</div>
							)}

							{/* Extraction Status Panel */}
							{config.enableExperienceExtraction && (
								<ExtractionStatusPanel
									theme={theme}
									queueStatus={queueStatus}
									tokenUsage={tokenUsage}
									config={config}
									batchCapableAgents={batchCapableAgents}
									onUpdateConfig={onUpdateConfig}
									activeAgentId={activeAgentId}
									activeAgentType={activeAgentType}
									projectPath={projectPath}
								/>
							)}
						</div>
					)}
				</div>

				{/* ═══════════════════════════════════════════════════════════════════
			    Section 2: Experience Review
			    ═══════════════════════════════════════════════════════════════════ */}
				<div className="rounded-lg border" style={{ borderColor: theme.colors.border }}>
					<SectionHeader
						theme={theme}
						icon={Brain}
						title="Experience Review"
						description={`${totalExperiences} total${currentProjectExperiences > 0 ? `, ${currentProjectExperiences} from this project` : ''}`}
						collapsible
						collapsed={reviewCollapsed}
						onToggle={() => setReviewCollapsed(!reviewCollapsed)}
					/>

					{!reviewCollapsed && (
						<div className="px-4 pb-4 space-y-3">
							{/* Filter Bar */}
							<div className="space-y-2">
								{/* Search */}
								<div
									className="flex items-center gap-2 px-2 py-1.5 rounded-lg border"
									style={{ borderColor: theme.colors.border }}
								>
									<Search
										className="w-3.5 h-3.5 shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										type="text"
										value={reviewSearch}
										onChange={(e) => setReviewSearch(e.target.value)}
										placeholder="Search experiences..."
										className="flex-1 bg-transparent outline-none text-xs"
										style={{ color: theme.colors.textMain }}
									/>
								</div>

								{/* Filters row */}
								<div className="flex items-center gap-1.5 flex-wrap">
									{/* Source filter */}
									<select
										value={reviewSourceFilter}
										onChange={(e) => setReviewSourceFilter(e.target.value as ReviewSourceFilter)}
										className="text-[10px] rounded px-1.5 py-0.5 border bg-transparent"
										style={{
											color: theme.colors.textMain,
											borderColor: theme.colors.border,
										}}
									>
										<option value="all">All sources</option>
										<option value="session-analysis">Session analysis</option>
										<option value="auto-run">Auto run</option>
										<option value="user">User</option>
										<option value="consolidation">Consolidation</option>
										<option value="grpo">GRPO</option>
										<option value="import">Import</option>
										<option value="repository">Repository</option>
									</select>

									{/* Deviation filter */}
									<select
										value={reviewDeviationFilter}
										onChange={(e) =>
											setReviewDeviationFilter(e.target.value as ReviewDeviationFilter)
										}
										className="text-[10px] rounded px-1.5 py-0.5 border bg-transparent"
										style={{
											color: theme.colors.textMain,
											borderColor: theme.colors.border,
										}}
									>
										<option value="all">All types</option>
										<option value="deviation">Deviations only</option>
										<option value="normal">Normal only</option>
									</select>

									{/* Date range filter */}
									<select
										value={reviewDateRange}
										onChange={(e) => setReviewDateRange(e.target.value as typeof reviewDateRange)}
										className="text-[10px] rounded px-1.5 py-0.5 border bg-transparent"
										style={{
											color: theme.colors.textMain,
											borderColor: theme.colors.border,
										}}
									>
										<option value="all">All time</option>
										<option value="24h">Last 24h</option>
										<option value="7d">Last 7 days</option>
										<option value="30d">Last 30 days</option>
										<option value="90d">Last 90 days</option>
									</select>

									{/* Project filter */}
									{availableProjects.length > 1 && (
										<select
											value={reviewProjectFilter}
											onChange={(e) => setReviewProjectFilter(e.target.value)}
											className="text-[10px] rounded px-1.5 py-0.5 border bg-transparent truncate max-w-[120px]"
											style={{
												color: theme.colors.textMain,
												borderColor: theme.colors.border,
											}}
										>
											<option value="all">All projects</option>
											{availableProjects.map((p) => (
												<option key={p} value={p}>
													{p.split('/').pop()}
												</option>
											))}
										</select>
									)}

									{/* Sort */}
									<div className="flex items-center gap-1 ml-auto">
										<ArrowUpDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
										<select
											value={reviewSort}
											onChange={(e) => setReviewSort(e.target.value as ReviewSortField)}
											className="text-[10px] rounded px-1.5 py-0.5 border bg-transparent"
											style={{
												color: theme.colors.textMain,
												borderColor: theme.colors.border,
											}}
										>
											<option value="newest">Newest first</option>
											<option value="confidence">Highest confidence</option>
											<option value="most-used">Most used</option>
											<option value="effectiveness">Most effective</option>
										</select>
									</div>
								</div>

								{/* Confidence range filter */}
								<div
									className="flex items-center gap-2 text-[10px]"
									style={{ color: theme.colors.textDim }}
								>
									<SlidersHorizontal className="w-3 h-3 shrink-0" />
									<span className="shrink-0">Confidence:</span>
									<input
										type="range"
										min={0}
										max={1}
										step={0.05}
										value={reviewConfidenceMin}
										onChange={(e) => setReviewConfidenceMin(Number(e.target.value))}
										className="w-16 h-1 accent-current"
										title={`Min: ${(reviewConfidenceMin * 100).toFixed(0)}%`}
									/>
									<span className="font-mono w-8 text-center">
										{(reviewConfidenceMin * 100).toFixed(0)}%
									</span>
									<span>–</span>
									<input
										type="range"
										min={0}
										max={1}
										step={0.05}
										value={reviewConfidenceMax}
										onChange={(e) => setReviewConfidenceMax(Number(e.target.value))}
										className="w-16 h-1 accent-current"
										title={`Max: ${(reviewConfidenceMax * 100).toFixed(0)}%`}
									/>
									<span className="font-mono w-8 text-center">
										{(reviewConfidenceMax * 100).toFixed(0)}%
									</span>
								</div>
							</div>

							{/* Experience Cards */}
							{experiencesLoading ? (
								<div
									className="flex items-center justify-center py-4 gap-2"
									style={{ color: theme.colors.textDim }}
								>
									<Loader2 className="w-4 h-4 animate-spin" />
									<span className="text-xs">Loading experiences...</span>
								</div>
							) : filteredExperiences.length === 0 ? (
								<div className="flex flex-col items-center justify-center py-6 gap-2">
									<Brain className="w-6 h-6 opacity-20" style={{ color: theme.colors.textDim }} />
									<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
										{reviewSearch || reviewSourceFilter !== 'all' || reviewDeviationFilter !== 'all'
											? 'No experiences match your filters.'
											: 'No experiences extracted yet. Complete a session with 3+ interactions to trigger analysis.'}
									</div>
								</div>
							) : (
								<div className="space-y-2 max-h-96 overflow-y-auto scrollbar-thin">
									{filteredExperiences.map((exp) => (
										<ExperienceReviewCard
											key={exp.id}
											experience={exp}
											theme={theme}
											projectPath={projectPath}
											agentType={activeAgentType}
											onEdit={() => setEditingMemory(exp)}
											onTogglePin={() => handleTogglePin(exp)}
											onArchive={() => handleArchive(exp)}
											onPromote={(ruleText) =>
												handlePromote(
													{
														memory: exp,
														isCrossProjectCandidate: false,
														suggestedRuleText: ruleText,
														qualificationReason: 'Manual promotion',
														promotionScore: 1,
													},
													ruleText
												)
											}
											onMovePromote={handleMovePromoteAction}
											skillAreas={skillAreas}
											personas={personasList}
											isPromotionCandidate={promotionCandidateIds.has(exp.id)}
										/>
									))}
								</div>
							)}
						</div>
					)}
				</div>

				{/* ═══════════════════════════════════════════════════════════════════
			    Section 3: Promotion Candidates
			    ═══════════════════════════════════════════════════════════════════ */}
				<div className="rounded-lg border" style={{ borderColor: theme.colors.border }}>
					<SectionHeader
						theme={theme}
						icon={ArrowUpCircle}
						title="Promotion Candidates"
						description="Experiences ready to become rules"
						collapsible
						collapsed={promotionCollapsed}
						onToggle={() => setPromotionCollapsed(!promotionCollapsed)}
						badge={promotionCandidates.length > 0 ? promotionCandidates.length : null}
					/>

					{!promotionCollapsed && (
						<div className="px-4 pb-4 space-y-4">
							{/* Description */}
							<div
								className="text-xs leading-relaxed rounded-md px-3 py-2"
								style={{ color: theme.colors.textDim, backgroundColor: `${theme.colors.border}15` }}
							>
								Experiences that have been used multiple times, show high confidence, or appear
								across projects are surfaced here as candidates for promotion to permanent rules.
							</div>

							{/* Cross-Project Promotion Config */}
							<div
								className="rounded border p-3 space-y-3"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: `${theme.colors.border}08`,
								}}
							>
								<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
									Cross-Project Detection
								</div>
								<ConfigToggle
									label="Enable Cross-Project Promotion"
									description="Detect recurring experiences across projects and suggest global promotion"
									checked={config.enableCrossProjectPromotion}
									onChange={(v) => onUpdateConfig({ enableCrossProjectPromotion: v })}
									theme={theme}
								/>
								{config.enableCrossProjectPromotion && (
									<>
										<ConfigSlider
											label="Min. Projects Required"
											description="Number of distinct projects an experience must appear in before being flagged for cross-project promotion"
											value={config.crossProjectMinProjects}
											min={2}
											max={10}
											step={1}
											onChange={(v) => onUpdateConfig({ crossProjectMinProjects: v })}
											theme={theme}
										/>
										<ConfigSlider
											label="Similarity Threshold"
											description="Cosine similarity threshold for matching experiences across projects (higher = stricter matching)"
											value={config.crossProjectSimilarityThreshold}
											min={0.5}
											max={1.0}
											step={0.05}
											onChange={(v) => onUpdateConfig({ crossProjectSimilarityThreshold: v })}
											theme={theme}
										/>
									</>
								)}
							</div>

							{/* Candidates list */}
							{promotionCandidates.length > 0 ? (
								<PromotionSection
									theme={theme}
									candidates={promotionCandidates}
									editingId={editingPromotionId}
									editingText={editingRuleText}
									onEditTextChange={setEditingRuleText}
									onStartEdit={(id, text) => {
										setEditingPromotionId(id);
										setEditingRuleText(text);
									}}
									onCancelEdit={() => setEditingPromotionId(null)}
									onApprove={(c, text) => handlePromote(c, text)}
									onDismiss={handleDismissPromotion}
									onKeep={handleKeepAsExperience}
								/>
							) : (
								<div className="flex flex-col items-center justify-center py-6 gap-2">
									<ArrowUpCircle
										className="w-6 h-6 opacity-20"
										style={{ color: theme.colors.textDim }}
									/>
									<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
										No promotion candidates right now. Experiences become candidates when they show
										high confidence, repeated use, or cross-project evidence.
									</div>
								</div>
							)}
						</div>
					)}
				</div>

				{/* ═══════════════════════════════════════════════════════════════════
			    Section 4: Repository
			    ═══════════════════════════════════════════════════════════════════ */}
				<div className="border-t pt-4" style={{ borderColor: theme.colors.border }} />
				<div className="rounded-lg border" style={{ borderColor: theme.colors.border }}>
					<SectionHeader
						theme={theme}
						icon={Globe}
						title="Repository"
						description="Import and share experience bundles"
						collapsible
						collapsed={repositoryCollapsed}
						onToggle={() => setRepositoryCollapsed(!repositoryCollapsed)}
					/>

					{!repositoryCollapsed && (
						<div className="px-4 pb-4">
							<ExperienceRepositoryPanel theme={theme} />
						</div>
					)}
				</div>
			</div>
			{/* end scrollable content region */}

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

			{/* Move/Promote Promotion Dialog */}
			{movePromoteMemory && (
				<PromotionDialog
					memory={movePromoteMemory}
					theme={theme}
					onConfirm={handleMovePromoteConfirm}
					onClose={() => setMovePromoteMemory(null)}
				/>
			)}

			{/* Move/Promote Scope Confirmation */}
			{movePromoteScopeConfirm && (
				<ScopeConfirmDialog
					direction={movePromoteScopeConfirm.direction}
					theme={theme}
					onConfirm={handleMovePromoteScopeConfirm}
					onClose={() => setMovePromoteScopeConfirm(null)}
				/>
			)}
		</div>
	);
}

// ─── Experience Review Card ─────────────────────────────────────────────────────

function ExperienceReviewCard({
	experience,
	theme,
	projectPath,
	agentType,
	onEdit,
	onTogglePin,
	onArchive,
	onPromote,
	onMovePromote,
	skillAreas,
	personas,
	isPromotionCandidate,
}: {
	experience: EnrichedExperience;
	theme: Theme;
	projectPath?: string | null;
	agentType?: string | null;
	onEdit: () => void;
	onTogglePin: () => void;
	onArchive: () => void;
	onPromote: (ruleText: string) => void;
	onMovePromote?: (action: MovePromoteAction) => void;
	skillAreas?: SkillArea[];
	personas?: Persona[];
	isPromotionCandidate?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const [similarExpanded, setSimilarExpanded] = useState(false);
	const [similarMemories, setSimilarMemories] = useState<
		{ entry: MemoryEntry; similarity: number; combinedScore: number }[] | null
	>(null);
	const [similarLoading, setSimilarLoading] = useState(false);

	const loadSimilarMemories = useCallback(async () => {
		if (similarMemories !== null || similarLoading) return;
		setSimilarLoading(true);
		try {
			const res = await window.maestro.memory.search(
				experience.content.slice(0, 200),
				agentType ?? 'claude-code',
				projectPath ?? undefined
			);
			if (res?.success && res.data) {
				const filtered = res.data.filter((r: any) => r.entry.id !== experience.id).slice(0, 5);
				setSimilarMemories(filtered);
			} else {
				setSimilarMemories([]);
			}
		} catch {
			setSimilarMemories([]);
		} finally {
			setSimilarLoading(false);
		}
	}, [experience.id, experience.content, agentType, projectPath, similarMemories, similarLoading]);
	const ctx = experience.experienceContext;
	const crossProjectCount = ctx?.crossProjectEvidence?.length ?? 0;

	const confidenceColor =
		experience.confidence >= 0.7 ? '#22c55e' : experience.confidence >= 0.4 ? '#eab308' : '#ef4444';

	return (
		<div
			className="rounded-lg border p-3 space-y-2 transition-colors"
			style={{
				borderColor: isPromotionCandidate
					? '#d4a017'
					: experience.pinned
						? theme.colors.accent
						: theme.colors.border,
				backgroundColor: isPromotionCandidate
					? '#d4a01708'
					: experience.pinned
						? `${theme.colors.accent}05`
						: 'transparent',
			}}
		>
			{/* Promotion candidate indicator */}
			{isPromotionCandidate && (
				<div
					className="flex items-center gap-1 text-[10px] font-medium"
					style={{ color: '#d4a017' }}
				>
					<Sparkles className="w-3 h-3" />
					Promotion-ready
				</div>
			)}
			{/* Situation (italic) */}
			{ctx?.situation && (
				<div className="text-xs italic leading-relaxed" style={{ color: theme.colors.textDim }}>
					{ctx.situation}
				</div>
			)}

			{/* Learning (bold) */}
			{ctx?.learning && (
				<div
					className="text-xs font-semibold leading-relaxed"
					style={{ color: theme.colors.textMain }}
				>
					{ctx.learning}
				</div>
			)}

			{/* Content */}
			<div
				className="text-xs leading-relaxed cursor-pointer"
				style={{ color: theme.colors.textMain }}
				onClick={() => setExpanded(!expanded)}
			>
				{expanded
					? experience.content
					: experience.content.length > 200
						? `${experience.content.slice(0, 200)}...`
						: experience.content}
			</div>

			{/* Provenance badges */}
			<div className="flex items-center gap-1.5 flex-wrap">
				{/* Source badge */}
				<span
					className="text-[10px] font-medium px-1.5 py-0.5 rounded"
					style={{
						backgroundColor: `${theme.colors.border}40`,
						color: theme.colors.textDim,
					}}
				>
					{experience.source}
				</span>

				{/* Deviation badge */}
				{ctx?.isDeviation && ctx.deviationType && (
					<span
						className="text-[10px] font-medium px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
						}}
					>
						{ctx.deviationType}
					</span>
				)}

				{/* Project path badge */}
				{ctx?.sourceProjectPath && (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded truncate max-w-[120px]"
						style={{
							backgroundColor: `${theme.colors.accent}10`,
							color: theme.colors.textDim,
						}}
						title={ctx.sourceProjectPath}
					>
						{ctx.sourceProjectPath.split('/').pop()}
					</span>
				)}

				{/* Timestamp */}
				<span className="text-[10px] ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
					{getRelativeTime(experience.createdAt)}
				</span>
			</div>

			{/* Confidence bar + quality indicators */}
			<div className="flex items-center gap-3 text-[10px]" style={{ color: theme.colors.textDim }}>
				{/* Confidence bar */}
				<div
					className="flex items-center gap-1"
					title={`Confidence: ${(experience.confidence * 100).toFixed(0)}%`}
				>
					<BarChart3 className="w-3 h-3" />
					<div
						className="w-12 h-1.5 rounded-full"
						style={{ backgroundColor: `${theme.colors.border}60` }}
					>
						<div
							className="h-1.5 rounded-full transition-all"
							style={{
								width: `${experience.confidence * 100}%`,
								backgroundColor: confidenceColor,
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
						{experience.useCount}x
					</div>
				)}

				{/* Cross-project evidence */}
				{crossProjectCount > 0 && (
					<div className="flex items-center gap-1" title="Cross-project evidence">
						<Globe className="w-3 h-3" />
						{crossProjectCount} project{crossProjectCount !== 1 ? 's' : ''}
					</div>
				)}
			</div>

			{/* Action buttons */}
			<div className="flex items-center gap-1.5">
				<button
					className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors"
					style={{
						borderColor: theme.colors.accent,
						color: theme.colors.accent,
						backgroundColor: `${theme.colors.accent}10`,
					}}
					title="Promote to Rule"
					onClick={() => onPromote(experience.content)}
				>
					<ArrowUpCircle className="w-3 h-3" />
					Promote
				</button>
				{onMovePromote && (
					<MemoryMovePromotePopover
						memory={experience}
						theme={theme}
						skillAreas={skillAreas}
						personas={personas}
						onAction={onMovePromote}
					/>
				)}
				<button
					className="p-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Edit"
					onClick={onEdit}
				>
					<Edit3 className="w-3 h-3" />
				</button>
				<button
					className="p-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					title="Archive"
					onClick={onArchive}
				>
					<Archive className="w-3 h-3" />
				</button>
				<button
					className="p-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: similarExpanded ? theme.colors.accent : theme.colors.textDim }}
					title="Find Similar"
					onClick={() => {
						const next = !similarExpanded;
						setSimilarExpanded(next);
						if (next) loadSimilarMemories();
					}}
				>
					<Layers className="w-3 h-3" />
				</button>
				<button
					className="p-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: experience.pinned ? theme.colors.accent : theme.colors.textDim }}
					title={experience.pinned ? 'Unpin' : 'Pin'}
					onClick={onTogglePin}
				>
					{experience.pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
				</button>
			</div>

			{/* Similar memories — expandable */}
			{similarExpanded && (
				<div>
					<div
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
					>
						<Layers className="w-3 h-3" />
						Similar Memories
					</div>
					<div className="mt-1 pl-4 space-y-1">
						{similarLoading && (
							<div
								className="flex items-center gap-1 text-[10px]"
								style={{ color: theme.colors.textDim }}
							>
								<Loader2 className="w-3 h-3 animate-spin" />
								Finding similar...
							</div>
						)}
						{similarMemories && similarMemories.length === 0 && !similarLoading && (
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								No similar memories found.
							</div>
						)}
						{similarMemories?.map((result) => (
							<div
								key={result.entry.id}
								className="flex items-center gap-2 rounded px-2 py-1 text-xs"
								style={{
									backgroundColor: `${theme.colors.border}20`,
									color: theme.colors.textMain,
								}}
							>
								<span
									className="text-[10px] font-medium px-1 py-0.5 rounded shrink-0"
									style={{
										backgroundColor:
											result.entry.type === 'experience'
												? `${theme.colors.warning}20`
												: `${theme.colors.border}60`,
										color:
											result.entry.type === 'experience'
												? theme.colors.warning
												: theme.colors.textDim,
									}}
								>
									{result.entry.type}
								</span>
								<span className="truncate flex-1">
									{result.entry.content.length > 80
										? result.entry.content.slice(0, 80) + '...'
										: result.entry.content}
								</span>
								<span
									className="text-[10px] font-medium shrink-0"
									style={{ color: theme.colors.accent }}
								>
									{(result.combinedScore * 100).toFixed(0)}%
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

// ─── Extraction Status Panel ────────────────────────────────────────────────────

function ExtractionStatusPanel({
	theme,
	queueStatus,
	tokenUsage,
	config,
	batchCapableAgents,
	onUpdateConfig,
	activeAgentId,
	activeAgentType,
	projectPath,
}: {
	theme: Theme;
	queueStatus: JobQueueStatus | null;
	tokenUsage: TokenUsage | null;
	config: MemoryConfig;
	batchCapableAgents: { id: string; name: string }[];
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	activeAgentId?: string | null;
	activeAgentType?: string | null;
	projectPath?: string | null;
}) {
	const isProcessing =
		queueStatus?.processing && queueStatus.currentJob === 'experience-extraction';
	const diagnostics = queueStatus?.recentDiagnostics ?? [];
	const lastDiag = diagnostics.length > 0 ? diagnostics[diagnostics.length - 1] : null;

	// Global retroactive analysis state
	const [analysisStats, setAnalysisStats] = useState<{
		totalSessions: number;
		analyzedSessions: number;
		unanalyzedSessions: number;
	} | null>(null);
	const [retroactiveResult, setRetroactiveResult] = useState<string | null>(null);
	const [analyzingHistory, setAnalyzingHistory] = useState(false);

	// Per-agent analysis state
	const [agentStats, setAgentStats] = useState<{
		totalSessions: number;
		analyzedSessions: number;
		unanalyzedSessions: number;
	} | null>(null);
	const [agentAnalysisResult, setAgentAnalysisResult] = useState<string | null>(null);
	const [analyzingAgent, setAnalyzingAgent] = useState(false);

	// Fetch global + agent analysis stats on mount / agent change
	useEffect(() => {
		window.maestro.memory.getAnalysisStats().then((res) => {
			if (res.success) setAnalysisStats(res.data);
		});
	}, []);

	useEffect(() => {
		if (activeAgentId) {
			setAgentAnalysisResult(null);
			window.maestro.memory.getAgentAnalysisStats(activeAgentId).then((res) => {
				if (res.success) setAgentStats(res.data);
			});
		} else {
			setAgentStats(null);
		}
	}, [activeAgentId]);

	const handleAnalyzeHistory = async () => {
		setAnalyzingHistory(true);
		setRetroactiveResult(null);
		try {
			const res = await window.maestro.memory.analyzeHistoricalSessions();
			if (res.success) {
				setRetroactiveResult(
					`Queued ${res.data.queued} sessions for analysis` +
						(res.data.skipped > 0 ? ` (${res.data.skipped} skipped)` : '')
				);
				const statsRes = await window.maestro.memory.getAnalysisStats();
				if (statsRes.success) setAnalysisStats(statsRes.data);
			} else {
				setRetroactiveResult('Failed to start analysis');
			}
		} catch {
			setRetroactiveResult('Failed to start analysis');
		} finally {
			setAnalyzingHistory(false);
		}
	};

	const handleAnalyzeAgent = async () => {
		if (!activeAgentId || !activeAgentType) return;
		setAnalyzingAgent(true);
		setAgentAnalysisResult(null);
		try {
			const res = await window.maestro.memory.analyzeAgentSessions(
				activeAgentId,
				activeAgentType,
				projectPath ?? undefined
			);
			if (res.success) {
				const parts: string[] = [];
				if (res.data.queued > 0) parts.push(`${res.data.queued} queued`);
				if (res.data.alreadyAnalyzed > 0) parts.push(`${res.data.alreadyAnalyzed} already done`);
				if (res.data.skipped > 0) parts.push(`${res.data.skipped} skipped`);
				setAgentAnalysisResult(parts.join(', ') || 'No sessions to analyze');
				const statsRes = await window.maestro.memory.getAgentAnalysisStats(activeAgentId);
				if (statsRes.success) setAgentStats(statsRes.data);
				const globalRes = await window.maestro.memory.getAnalysisStats();
				if (globalRes.success) setAnalysisStats(globalRes.data);
			} else {
				setAgentAnalysisResult('Failed to start analysis');
			}
		} catch {
			setAgentAnalysisResult('Failed to start analysis');
		} finally {
			setAnalyzingAgent(false);
		}
	};

	const statusColor = isProcessing
		? theme.colors.accent
		: lastDiag?.status === 'success'
			? '#22c55e'
			: lastDiag?.status?.startsWith('skipped')
				? '#eab308'
				: lastDiag
					? '#ef4444'
					: theme.colors.textDim;
	const statusLabel = isProcessing
		? 'Running'
		: lastDiag?.status === 'success'
			? 'Healthy'
			: lastDiag?.status?.startsWith('skipped')
				? 'Idle'
				: lastDiag
					? 'Error'
					: 'Waiting';

	return (
		<div
			className="rounded border p-3 space-y-3"
			style={{ borderColor: theme.colors.border, backgroundColor: `${theme.colors.border}10` }}
		>
			{/* Header with status indicator */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Extraction Status
					</span>
				</div>
				<div className="flex items-center gap-1.5">
					{isProcessing && (
						<Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.accent }} />
					)}
					<span
						className="text-xs font-medium px-1.5 py-0.5 rounded"
						style={{ backgroundColor: `${statusColor}20`, color: statusColor }}
					>
						{statusLabel}
					</span>
				</div>
			</div>

			{/* Extraction progress */}
			{isProcessing &&
			queueStatus?.extractionProgress &&
			queueStatus.extractionProgress.stage !== 'complete' ? (
				<ExtractionProgressDisplay
					progress={queueStatus.extractionProgress}
					theme={theme}
					queueLength={queueStatus.queueLength}
				/>
			) : isProcessing && queueStatus?.currentActivity ? (
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					{queueStatus.currentActivity}
					{queueStatus.queueLength > 0 && (
						<span style={{ color: theme.colors.textDim }}>
							{' '}
							({queueStatus.queueLength} more queued)
						</span>
					)}
				</div>
			) : null}

			{/* Provider config + Token usage row */}
			<div className="grid grid-cols-2 gap-3">
				<div
					className="rounded p-2 space-y-1.5"
					style={{ backgroundColor: `${theme.colors.border}30` }}
				>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Provider
					</div>
					<select
						className="w-full rounded px-1.5 py-1 text-xs border"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						value={config.extractionProvider ?? ''}
						onChange={(e) => onUpdateConfig({ extractionProvider: e.target.value || undefined })}
					>
						<option value="">Auto-detect</option>
						{batchCapableAgents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.name}
							</option>
						))}
					</select>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Model
					</div>
					<input
						type="text"
						className="w-full rounded px-1.5 py-1 text-xs border"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
						placeholder="Provider default"
						value={config.extractionModel ?? ''}
						onChange={(e) => onUpdateConfig({ extractionModel: e.target.value || undefined })}
					/>
				</div>

				<div
					className="rounded p-2 space-y-0.5"
					style={{ backgroundColor: `${theme.colors.border}30` }}
				>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Tokens (24h)
					</div>
					<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						{tokenUsage
							? `${(tokenUsage.extractionTokens + tokenUsage.injectionTokens).toLocaleString()}`
							: '0'}
					</div>
					{tokenUsage && tokenUsage.extractionCalls > 0 ? (
						<>
							<div className="text-xs" style={{ color: theme.colors.textMain }}>
								{tokenUsage.extractionCalls} extraction{tokenUsage.extractionCalls !== 1 ? 's' : ''}
							</div>
							<div className="text-xs font-medium" style={{ color: theme.colors.accent }}>
								${tokenUsage.estimatedCostUsd.toFixed(3)}
							</div>
							{tokenUsage.extractionTokens > 0 && (
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{tokenUsage.extractionTokens.toLocaleString()} extraction
								</div>
							)}
							{tokenUsage.injectionTokens > 0 && (
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{tokenUsage.injectionTokens.toLocaleString()} injection
								</div>
							)}
						</>
					) : (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							No extractions yet
						</div>
					)}
				</div>
			</div>

			{/* History Analysis */}
			<div className="space-y-2">
				<div className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
					History Analysis
				</div>

				{activeAgentId && (
					<div
						className="flex items-center justify-between rounded p-2"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						<div className="text-xs" style={{ color: theme.colors.textMain }}>
							{agentStats ? (
								<>
									<span style={{ color: theme.colors.textDim }}>Current agent: </span>
									{agentStats.unanalyzedSessions > 0
										? `${agentStats.unanalyzedSessions} unanalyzed / ${agentStats.totalSessions} sessions`
										: agentStats.totalSessions > 0
											? `All ${agentStats.totalSessions} sessions analyzed`
											: 'No history yet'}
								</>
							) : (
								'Loading...'
							)}
						</div>
						<button
							className="text-xs font-medium px-2 py-1 rounded border transition-colors shrink-0"
							style={{
								borderColor: theme.colors.accent,
								color: theme.colors.accent,
								backgroundColor: `${theme.colors.accent}10`,
								opacity: analyzingAgent || !agentStats?.unanalyzedSessions ? 0.5 : 1,
							}}
							disabled={analyzingAgent || !agentStats?.unanalyzedSessions}
							onClick={handleAnalyzeAgent}
						>
							{analyzingAgent ? 'Queuing...' : 'Analyze Agent'}
						</button>
					</div>
				)}
				{agentAnalysisResult && (
					<div className="text-xs px-2" style={{ color: theme.colors.accent }}>
						{agentAnalysisResult}
					</div>
				)}

				<div
					className="flex items-center justify-between rounded p-2"
					style={{ backgroundColor: `${theme.colors.border}30` }}
				>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{analysisStats
							? `All agents: ${analysisStats.unanalyzedSessions} unanalyzed / ${analysisStats.totalSessions} total`
							: 'Loading session stats...'}
					</div>
					<button
						className="text-xs font-medium px-2 py-1 rounded border transition-colors shrink-0"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: `${theme.colors.border}20`,
							opacity: analyzingHistory || !analysisStats?.unanalyzedSessions ? 0.5 : 1,
						}}
						disabled={analyzingHistory || !analysisStats?.unanalyzedSessions}
						onClick={handleAnalyzeHistory}
					>
						{analyzingHistory ? 'Queuing...' : 'Analyze All'}
					</button>
				</div>
				{retroactiveResult && (
					<div className="text-xs px-2" style={{ color: theme.colors.accent }}>
						{retroactiveResult}
					</div>
				)}
			</div>

			{/* Cooldown config */}
			<div
				className="flex items-center justify-between text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span>Cooldown between analyses</span>
				<select
					className="rounded px-1.5 py-0.5 text-xs border"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
					value={Math.round(config.analysisCooldownMs / 60000)}
					onChange={(e) => onUpdateConfig({ analysisCooldownMs: Number(e.target.value) * 60000 })}
				>
					{[1, 2, 5, 10, 15, 30].map((m) => (
						<option key={m} value={m}>
							{m} min
						</option>
					))}
				</select>
			</div>

			{/* Full extraction diagnostic history (last 10) */}
			<ExtractionHistory diagnostics={diagnostics} isProcessing={!!isProcessing} theme={theme} />
		</div>
	);
}

// ─── Extraction Sub-components ──────────────────────────────────────────────────

function ExtractionDiagnosticRow({
	diagnostic,
	theme,
}: {
	diagnostic: ExtractionDiagnostic;
	theme: Theme;
}) {
	const statusColor =
		diagnostic.status === 'success'
			? '#22c55e'
			: diagnostic.status.startsWith('skipped')
				? '#eab308'
				: '#ef4444';
	const statusIcon =
		diagnostic.status === 'success' ? '●' : diagnostic.status.startsWith('skipped') ? '○' : '✕';
	const timeAgo = getRelativeTime(diagnostic.timestamp);
	const tokens = diagnostic.tokenUsage
		? `${(diagnostic.tokenUsage.inputTokens + diagnostic.tokenUsage.outputTokens).toLocaleString()} tokens`
		: null;

	const triggerBadge = diagnostic.trigger
		? {
				exit: { label: 'exit', color: '#6366f1' },
				'mid-session': { label: 'mid-session', color: '#f59e0b' },
				retroactive: { label: 'retroactive', color: '#8b5cf6' },
				'per-turn': { label: 'per-turn', color: '#10b981' },
			}[diagnostic.trigger]
		: null;

	return (
		<div
			className="flex items-start gap-1.5 text-xs rounded px-2 py-1"
			style={{ backgroundColor: `${theme.colors.border}20` }}
		>
			<span style={{ color: statusColor, lineHeight: '1.4' }}>{statusIcon}</span>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-1.5" style={{ color: theme.colors.textMain }}>
					<span className="truncate">{diagnostic.message}</span>
					{triggerBadge && (
						<span
							className="shrink-0 text-[10px] font-medium px-1 py-px rounded"
							style={{ backgroundColor: `${triggerBadge.color}20`, color: triggerBadge.color }}
						>
							{triggerBadge.label}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2 flex-wrap" style={{ color: theme.colors.textDim }}>
					<span>{timeAgo}</span>
					{diagnostic.agentType && <span>{diagnostic.agentType}</span>}
					{diagnostic.providerUsed && <span>via {diagnostic.providerUsed}</span>}
					{tokens && <span>{tokens}</span>}
					{diagnostic.experiencesStored != null && diagnostic.experiencesStored > 0 && (
						<span style={{ color: '#22c55e' }}>{diagnostic.experiencesStored} stored</span>
					)}
				</div>
				{diagnostic.status.startsWith('failed') && diagnostic.message && (
					<div className="text-[10px] mt-0.5" style={{ color: '#ef4444' }}>
						{diagnostic.message}
					</div>
				)}
			</div>
		</div>
	);
}

function ExtractionHistory({
	diagnostics,
	isProcessing,
	theme,
}: {
	diagnostics: ExtractionDiagnostic[];
	isProcessing: boolean;
	theme: Theme;
}) {
	const [expanded, setExpanded] = useState(false);
	const last10 = diagnostics.slice().reverse().slice(0, 10);

	if (last10.length === 0 && !isProcessing) {
		return (
			<div className="text-xs text-center py-2" style={{ color: theme.colors.textDim }}>
				No extraction activity yet. Complete a session with 3+ interactions to trigger analysis.
			</div>
		);
	}

	if (last10.length === 0) return null;

	const successCount = last10.filter((d) => d.status === 'success').length;
	const failedCount = last10.filter((d) => d.status.startsWith('failed')).length;
	const skippedCount = last10.filter((d) => d.status.startsWith('skipped')).length;

	return (
		<div className="space-y-1.5">
			<button
				className="flex items-center justify-between w-full text-xs font-medium group"
				style={{ color: theme.colors.textDim }}
				onClick={() => setExpanded(!expanded)}
			>
				<div className="flex items-center gap-1.5">
					{expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
					<span>Extraction History ({last10.length})</span>
				</div>
				<div className="flex items-center gap-2 text-[10px]">
					{successCount > 0 && <span style={{ color: '#22c55e' }}>{successCount} ok</span>}
					{failedCount > 0 && <span style={{ color: '#ef4444' }}>{failedCount} failed</span>}
					{skippedCount > 0 && <span style={{ color: '#eab308' }}>{skippedCount} skipped</span>}
				</div>
			</button>

			{expanded &&
				last10.map((d, i) => (
					<ExtractionDiagnosticRow key={`${d.sessionId}-${i}`} diagnostic={d} theme={theme} />
				))}
		</div>
	);
}

function getRelativeTime(timestamp: number): string {
	const seconds = Math.round((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

const EXTRACTION_STAGES: { id: ExtractionProgress['stage']; label: string; activeLabel: string }[] =
	[
		{ id: 'gathering', label: 'Gather session data', activeLabel: 'Gathering session data...' },
		{ id: 'sending', label: 'Send to LLM', activeLabel: 'Sending to LLM...' },
		{ id: 'streaming', label: 'Stream response', activeLabel: 'Streaming response...' },
		{ id: 'parsing', label: 'Parse results', activeLabel: 'Filtering experiences...' },
		{ id: 'storing', label: 'Store experiences', activeLabel: 'Storing experiences...' },
	];

function ElapsedTime({ startedAt, color }: { startedAt: number; color: string }) {
	const [elapsed, setElapsed] = useState(Date.now() - startedAt);
	useEffect(() => {
		const interval = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
		return () => clearInterval(interval);
	}, [startedAt]);
	const seconds = Math.floor(elapsed / 1000);
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return (
		<span className="font-mono text-xs" style={{ color }}>
			{mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
		</span>
	);
}

function ExtractionProgressDisplay({
	progress,
	theme,
	queueLength,
}: {
	progress: ExtractionProgress;
	theme: Theme;
	queueLength: number;
}) {
	const currentStageIndex = EXTRACTION_STAGES.findIndex((s) => s.id === progress.stage);
	const progressPercent = Math.min(
		95,
		progress.estimatedTotalTokens > 0
			? Math.round((progress.tokensStreamed / progress.estimatedTotalTokens) * 100)
			: (currentStageIndex / EXTRACTION_STAGES.length) * 100
	);

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between text-xs">
				<span style={{ color: theme.colors.textMain }}>{progress.message}</span>
				<ElapsedTime startedAt={progress.startedAt} color={theme.colors.textDim} />
			</div>

			<div>
				<div className="flex justify-between text-xs mb-1">
					<span style={{ color: theme.colors.textDim }}>Progress</span>
					<span style={{ color: theme.colors.textMain }}>{progressPercent}%</span>
				</div>
				<div
					className="h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: `${theme.colors.border}60` }}
				>
					<div
						className="h-full rounded-full transition-all duration-500 ease-out"
						style={{
							width: `${progressPercent}%`,
							backgroundColor: theme.colors.accent,
						}}
					/>
				</div>
			</div>

			<div className="flex items-center gap-3 text-xs" style={{ color: theme.colors.textDim }}>
				{progress.providerUsed && <span>via {progress.providerUsed}</span>}
				{progress.tokensStreamed > 0 && (
					<span>{progress.tokensStreamed.toLocaleString()} tokens</span>
				)}
				{progress.estimatedCostSoFar > 0 && (
					<span className="font-medium" style={{ color: theme.colors.accent }}>
						${progress.estimatedCostSoFar.toFixed(4)}
					</span>
				)}
				{queueLength > 0 && <span>+{queueLength} queued</span>}
			</div>

			<div className="space-y-1">
				{EXTRACTION_STAGES.map((stage, index) => {
					const isActive = index === currentStageIndex;
					const isCompleted = index < currentStageIndex;
					return (
						<div key={stage.id} className="flex items-center gap-2">
							<div className="w-4 h-4 flex items-center justify-center shrink-0">
								{isCompleted ? (
									<div
										className="w-3.5 h-3.5 rounded-full flex items-center justify-center"
										style={{ backgroundColor: '#22c55e' }}
									>
										<Check className="w-2 h-2" style={{ color: '#fff' }} />
									</div>
								) : isActive ? (
									<Loader2
										className="w-3.5 h-3.5 animate-spin"
										style={{ color: theme.colors.accent }}
									/>
								) : (
									<div
										className="w-3.5 h-3.5 rounded-full border"
										style={{ borderColor: theme.colors.border }}
									/>
								)}
							</div>
							<span
								className="text-xs"
								style={{
									color: isActive
										? theme.colors.textMain
										: isCompleted
											? '#22c55e'
											: theme.colors.textDim,
									fontWeight: isActive ? 500 : 400,
								}}
							>
								{isActive ? stage.activeLabel : stage.label}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

// ─── Promotion Section ──────────────────────────────────────────────────────────

function PromotionSection({
	theme,
	candidates,
	editingId,
	editingText,
	onEditTextChange,
	onStartEdit,
	onCancelEdit,
	onApprove,
	onDismiss,
	onKeep,
}: {
	theme: Theme;
	candidates: PromotionCandidate[];
	editingId: string | null;
	editingText: string;
	onEditTextChange: (text: string) => void;
	onStartEdit: (id: string, text: string) => void;
	onCancelEdit: () => void;
	onApprove: (candidate: PromotionCandidate, ruleText: string) => void;
	onDismiss: (candidate: PromotionCandidate) => void;
	onKeep: (candidate: PromotionCandidate) => void;
}) {
	return (
		<div
			className="rounded-lg border p-4 space-y-3"
			style={{
				borderColor: theme.colors.accent,
				backgroundColor: `${theme.colors.accent}08`,
			}}
		>
			<div className="flex items-center gap-2">
				<ArrowUpCircle className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					{candidates.length} experience{candidates.length !== 1 ? 's' : ''} ready for promotion
				</div>
			</div>

			{candidates.map((candidate) => {
				const { memory } = candidate;
				const isEditing = editingId === memory.id;
				return (
					<div
						key={memory.id}
						className="rounded border p-3 space-y-2"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs" style={{ color: theme.colors.textMain }}>
							{memory.content.length > 120 ? memory.content.slice(0, 120) + '...' : memory.content}
						</div>
						{candidate.qualificationReason && (
							<div className="text-xs italic" style={{ color: theme.colors.accent }}>
								{candidate.qualificationReason}
							</div>
						)}
						{candidate.isCrossProjectCandidate && (
							<div
								className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
								}}
							>
								<Globe className="w-3 h-3" />
								Seen in {candidate.crossProjectCount} projects — will promote to global scope
							</div>
						)}
						<div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
							eff: {(memory.effectivenessScore * 100).toFixed(0)}% | used {memory.useCount}x |
							confidence: {(memory.confidence * 100).toFixed(0)}%
						</div>

						{isEditing ? (
							<div className="space-y-2">
								<textarea
									className="w-full rounded border p-2 text-xs font-mono resize-none"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: `${theme.colors.border}20`,
										color: theme.colors.textMain,
										outline: 'none',
									}}
									rows={3}
									value={editingText}
									onChange={(e) => onEditTextChange(e.target.value)}
								/>
								<div className="flex gap-2">
									<button
										className="px-3 py-1 rounded text-xs font-medium border"
										style={{
											borderColor: theme.colors.accent,
											color: theme.colors.accent,
											backgroundColor: `${theme.colors.accent}10`,
										}}
										onClick={() => onApprove(candidate, editingText)}
									>
										<Check className="w-3 h-3 inline mr-1" />
										Confirm
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={onCancelEdit}
									>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<>
								<div className="text-xs" style={{ color: theme.colors.accent }}>
									Suggested rule: &ldquo;
									{candidate.suggestedRuleText.length > 100
										? candidate.suggestedRuleText.slice(0, 100) + '...'
										: candidate.suggestedRuleText}
									&rdquo;
								</div>
								<div className="flex gap-2">
									<button
										className="px-3 py-1 rounded text-xs font-medium border"
										style={{
											borderColor: theme.colors.accent,
											color: theme.colors.accent,
											backgroundColor: `${theme.colors.accent}10`,
										}}
										onClick={() => onApprove(candidate, candidate.suggestedRuleText)}
									>
										<Check className="w-3 h-3 inline mr-1" />
										Approve
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onStartEdit(memory.id, candidate.suggestedRuleText)}
									>
										<Edit3 className="w-3 h-3 inline mr-1" />
										Edit & Approve
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onDismiss(candidate)}
									>
										<X className="w-3 h-3 inline mr-1" />
										Dismiss
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onKeep(candidate)}
									>
										<Pin className="w-3 h-3 inline mr-1" />
										Keep as XP
									</button>
								</div>
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}
