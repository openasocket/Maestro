/**
 * StatusTab - Status & Health sub-tab within MemorySettings.
 *
 * Four sections: System Health, Injection Activity, System Metrics, Impact Dashboard.
 * Provides diagnostics, injection tracking, and visual evidence of memory system value.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
	AlertTriangle,
	Archive,
	ArrowRightLeft,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Clock,
	Filter,
	GitMerge,
	Layers,
	Plus,
	Scissors,
	Trash2,
	Zap,
	Cpu,
	BarChart3,
	CheckCircle2,
	XCircle,
	MinusCircle,
	Star,
	TrendingUp,
	TrendingDown,
	Users,
	DollarSign,
	Download,
	Edit3,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	MemoryEntry,
	JobQueueStatus,
	TokenUsage,
	ExtractionDiagnostic,
	MemoryChangeEvent,
	MemoryChangeEventType,
} from '../../../shared/memory-types';
import type {
	EmbeddingUsageSummary,
	EmbeddingUsageBucket,
} from '../../../main/stats/embedding-usage';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { SectionHeader } from './SectionHeader';

export interface StatusTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onConfigChange?: () => void;
	/** Navigate to another sub-tab with optional filter */
	onNavigateToTab?: (tab: string, filter?: Record<string, string> | null) => void;
}

/** Shared health context fetched once and passed to subsections. */
interface HealthContext {
	lastInjectionTime: number | null;
	liveSessionCount: number;
	extractionDiagnostics: ExtractionDiagnostic[];
}

export function StatusTab({
	theme,
	config,
	stats,
	projectPath,
	onConfigChange,
	onNavigateToTab,
}: StatusTabProps): React.ReactElement {
	const [allMemories, setAllMemories] = useState<MemoryEntry[]>([]);
	const [healthCtx, setHealthCtx] = useState<HealthContext>({
		lastInjectionTime: null,
		liveSessionCount: 0,
		extractionDiagnostics: [],
	});

	useEffect(() => {
		if (!config.enabled) return;
		let mounted = true;
		// Fetch memories, recent injections, and job queue in parallel
		Promise.allSettled([
			window.maestro.memory.listAllExperiences(projectPath ?? undefined),
			window.maestro.memory.getRecentInjections(200),
			window.maestro.memory.getJobQueueStatus(),
		]).then(([memResult, injResult, queueResult]) => {
			if (!mounted) return;
			if (memResult.status === 'fulfilled' && memResult.value.success) {
				setAllMemories(memResult.value.data);
			}
			const ctx: HealthContext = {
				lastInjectionTime: null,
				liveSessionCount: 0,
				extractionDiagnostics: [],
			};
			if (injResult.status === 'fulfilled') {
				const res = injResult.value as { success: boolean; data?: InjectionEventRecord[] };
				if (res.success && Array.isArray(res.data) && res.data.length > 0) {
					// Most recent event first (ring buffer returns newest last)
					const sorted = [...res.data].sort((a, b) => b.timestamp - a.timestamp);
					ctx.lastInjectionTime = sorted[0].timestamp;
					// Count unique sessions in last 24h
					const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
					const recentSessions = new Set(
						sorted.filter((e) => e.timestamp >= oneDayAgo).map((e) => e.sessionId)
					);
					ctx.liveSessionCount = recentSessions.size;
				}
			}
			if (queueResult.status === 'fulfilled') {
				const res = queueResult.value as { success: boolean; data?: JobQueueStatus };
				if (res.success && res.data?.recentDiagnostics) {
					ctx.extractionDiagnostics = res.data.recentDiagnostics;
				}
			}
			setHealthCtx(ctx);
		});
		return () => {
			mounted = false;
		};
	}, [config.enabled, projectPath, stats]);

	const atRiskCount = allMemories.filter(
		(m) =>
			m.active &&
			!m.archived &&
			!m.pinned &&
			m.confidence < config.minConfidenceThreshold * 2 &&
			m.confidence >= config.minConfidenceThreshold
	).length;

	const overallHealth = getOverallHealth(config, stats);
	const healthLabel =
		overallHealth === 'green' ? 'Healthy' : overallHealth === 'yellow' ? 'Degraded' : 'Unhealthy';

	return (
		<div className="flex flex-col" style={{ height: '100%' }}>
			{/* ─── Fixed Header: Banner + Health Summary ───────────────── */}
			<div className="shrink-0 space-y-3 pb-2">
				<TabDescriptionBanner
					theme={theme}
					description="System diagnostics and impact visualization — health status, injection activity, technical metrics, and evidence that the memory system is delivering value."
				/>

				{/* Quick health summary bar */}
				<div
					className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs"
					style={{
						backgroundColor: theme.colors.bgActivity,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<HealthDot level={overallHealth} size={10} />
					<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
						System: {healthLabel}
					</span>
					{stats && (
						<>
							<span style={{ color: theme.colors.textDim }}>·</span>
							<span style={{ color: theme.colors.textDim }}>{stats.totalMemories} memories</span>
							<span style={{ color: theme.colors.textDim }}>·</span>
							<span style={{ color: theme.colors.textDim }}>
								{stats.recentInjections} recent injections
							</span>
							{atRiskCount > 0 && (
								<>
									<span style={{ color: theme.colors.textDim }}>·</span>
									<span style={{ color: '#eab308' }}>{atRiskCount} at risk</span>
								</>
							)}
						</>
					)}
				</div>
			</div>

			{/* ─── Scrollable Content: All sections ────────────────────── */}
			<div className="flex-1 overflow-y-auto min-h-0 space-y-4 mt-2">
				{/* Section 1: System Health */}
				<SystemHealthSection
					stats={stats}
					theme={theme}
					config={config}
					atRiskCount={atRiskCount}
					healthCtx={healthCtx}
				/>

				{/* Section 2: Injection Activity */}
				<InjectionActivitySection
					theme={theme}
					config={config}
					stats={stats}
					onConfigChange={onConfigChange}
					onNavigateToTab={onNavigateToTab}
				/>

				{/* Section 3: Memory Timeline */}
				<MemoryTimelineSection theme={theme} config={config} />

				{/* Section 4: System Metrics (collapsed by default) */}
				<SystemMetricsSection theme={theme} />

				{/* Section 4: Impact Dashboard */}
				{stats && <ImpactDashboardSection stats={stats} theme={theme} allMemories={allMemories} />}

				{/* Section 5: Embedding Usage */}
				<EmbeddingUsageSection theme={theme} config={config} />

				{/* Section 6: Promotion History */}
				<PromotionHistorySection theme={theme} allMemories={allMemories} />

				{/* Section 7: Persona Shifts */}
				<PersonaShiftSection theme={theme} config={config} allMemories={allMemories} />
			</div>
		</div>
	);
}

// ─── Traffic Light Helpers ──────────────────────────────────────────────────────

type HealthLevel = 'green' | 'yellow' | 'red';

function getOverallHealth(config: MemoryConfig, stats: MemoryStats | null): HealthLevel {
	if (!config.enabled) return 'red';
	if (!stats) return 'yellow';

	const noRecentInjections = stats.recentInjections === 0;
	const noMemories = stats.totalMemories === 0;
	const allNeverInjected =
		stats.totalMemories > 0 && stats.neverInjectedCount === stats.totalMemories;
	const manyPendingEmbeddings = stats.pendingEmbeddings > stats.totalMemories * 0.5;

	// Red: system enabled but nothing is working
	if (noMemories || allNeverInjected) return 'red';

	// Yellow: some issues
	if (noRecentInjections || manyPendingEmbeddings) return 'yellow';

	return 'green';
}

function HealthDot({ level, size = 8 }: { level: HealthLevel; size?: number }) {
	const color = level === 'green' ? '#22c55e' : level === 'yellow' ? '#eab308' : '#ef4444';
	return (
		<div
			className="rounded-full shrink-0"
			style={{ width: size, height: size, backgroundColor: color }}
		/>
	);
}

function SubsystemRow({
	theme,
	label,
	enabled,
	detail,
}: {
	theme: Theme;
	label: string;
	enabled: boolean;
	detail?: string;
}) {
	return (
		<div className="flex items-center gap-2 text-xs py-0.5">
			{enabled ? (
				<CheckCircle2 className="w-3 h-3 shrink-0" style={{ color: '#22c55e' }} />
			) : (
				<XCircle className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
			)}
			<span style={{ color: theme.colors.textMain }}>{label}</span>
			{detail && (
				<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
					{detail}
				</span>
			)}
		</div>
	);
}

// ─── Section 1: System Health ───────────────────────────────────────────────────

function SystemHealthSection({
	stats,
	theme,
	config,
	atRiskCount,
	healthCtx,
}: {
	stats: MemoryStats | null;
	theme: Theme;
	config: MemoryConfig;
	atRiskCount: number;
	healthCtx: HealthContext;
}) {
	const overallHealth = getOverallHealth(config, stats);

	const healthLabel =
		overallHealth === 'green'
			? 'All systems operational'
			: overallHealth === 'yellow'
				? 'Some issues detected'
				: !config.enabled
					? 'System disabled'
					: 'System needs attention';

	// Derive extraction details from diagnostics
	const extractionDetail = useMemo(() => {
		const diags = healthCtx.extractionDiagnostics;
		if (diags.length === 0) return undefined;
		const successes = diags.filter((d) => d.status === 'success').length;
		const lastDiag = diags[0]; // most recent
		const lastTime = lastDiag ? formatRelativeTime(lastDiag.timestamp) : '';
		return `${successes}/${diags.length} ok${lastTime ? ` · last ${lastTime}` : ''}`;
	}, [healthCtx.extractionDiagnostics]);

	// Injection detail: count + last time
	const injectionDetail = useMemo(() => {
		const parts: string[] = [];
		if (stats) parts.push(`${stats.recentInjections} in 7d`);
		if (healthCtx.lastInjectionTime) {
			parts.push(`last ${formatRelativeTime(healthCtx.lastInjectionTime)}`);
		}
		return parts.length > 0 ? parts.join(' · ') : undefined;
	}, [stats, healthCtx.lastInjectionTime]);

	// Decay detail: rate + half-life
	const decayDetail = useMemo(() => {
		if (config.confidenceDecayRate <= 0) return undefined;
		return `${config.confidenceDecayRate}/day · ${config.decayHalfLifeDays}d half-life`;
	}, [config.confidenceDecayRate, config.decayHalfLifeDays]);

	// Live injection: session count
	const liveDetail = useMemo(() => {
		if (!config.enableLiveInjection) return undefined;
		return healthCtx.liveSessionCount > 0
			? `${healthCtx.liveSessionCount} session${healthCtx.liveSessionCount !== 1 ? 's' : ''} (24h)`
			: 'no recent sessions';
	}, [config.enableLiveInjection, healthCtx.liveSessionCount]);

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			{/* Traffic light summary */}
			<div className="flex items-center gap-2">
				<HealthDot level={overallHealth} size={10} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					System Health
				</div>
				<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
					{healthLabel}
				</span>
			</div>

			{/* Subsystem rows */}
			<div className="space-y-0.5">
				<SubsystemRow
					theme={theme}
					label="Memory Injection"
					enabled={config.enabled}
					detail={injectionDetail}
				/>
				<SubsystemRow
					theme={theme}
					label="Experience Extraction"
					enabled={config.enableExperienceExtraction}
					detail={extractionDetail}
				/>
				<SubsystemRow
					theme={theme}
					label="Confidence Decay"
					enabled={config.confidenceDecayRate > 0}
					detail={decayDetail}
				/>
				<SubsystemRow
					theme={theme}
					label="Auto-Consolidation"
					enabled={config.enableAutoConsolidation}
				/>
				<SubsystemRow
					theme={theme}
					label="Live Injection"
					enabled={config.enableLiveInjection}
					detail={liveDetail}
				/>
				<SubsystemRow
					theme={theme}
					label="Cross-Agent Broadcast"
					enabled={config.enableCrossAgentBroadcast}
				/>
			</div>

			{/* At-risk indicator */}
			{atRiskCount > 0 && (
				<div className="flex items-center gap-1.5 text-xs" style={{ color: '#eab308' }}>
					<AlertTriangle className="w-3 h-3" />
					{atRiskCount} memories approaching archive threshold
				</div>
			)}

			{/* Effectiveness Distribution Bar (from original MemoryHealthPanel) */}
			{stats && <EffectivenessBar stats={stats} theme={theme} />}

			{/* Warning items */}
			{stats && (
				<div className="space-y-1">
					{stats.neverInjectedCount > 0 && (
						<div className="flex items-center gap-1.5 text-xs" style={{ color: '#eab308' }}>
							<AlertTriangle className="w-3 h-3" />
							{stats.neverInjectedCount} memories never injected
						</div>
					)}
					{(stats.promotionCandidates ?? 0) > 0 && (
						<div className="flex items-center gap-1.5 text-xs" style={{ color: '#d4a017' }}>
							<Star className="w-3 h-3" />
							Promotion Suggestions: {stats.promotionCandidates} experience
							{stats.promotionCandidates !== 1 ? 's' : ''} ready
						</div>
					)}
					{stats.archivedCount > 0 && (
						<div
							className="flex items-center gap-1.5 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<Archive className="w-3 h-3" />
							{stats.archivedCount} archived memories
						</div>
					)}
				</div>
			)}

			{/* Footer: hierarchy counts */}
			{stats && (
				<div
					className="pt-2 border-t text-xs space-y-1"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<div>
						Roles: {stats.totalRoles} | Personas: {stats.totalPersonas} | Skills:{' '}
						{stats.totalSkillAreas}
					</div>
					<div style={{ color: theme.colors.textMain }}>
						Rules: {stats.byType?.rule ?? 0} | Experiences: {stats.byType?.experience ?? 0}
					</div>
					{stats.bySource &&
						(() => {
							const sourceLabels: Record<string, string> = {
								user: 'manual',
								'auto-run': 'auto-run',
								'session-analysis': 'extracted',
								consolidation: 'consolidated',
								grpo: 'promoted',
								import: 'imported',
							};
							const parts = Object.entries(stats.bySource)
								.filter(([, count]) => count > 0)
								.map(([key, count]) => `${count} ${sourceLabels[key] || key}`);
							return parts.length > 0 ? <div>Sources: {parts.join(', ')}</div> : null;
						})()}
				</div>
			)}
		</div>
	);
}

function EffectivenessBar({ stats, theme }: { stats: MemoryStats; theme: Theme }) {
	const dist = stats.effectivenessDistribution;
	const total = dist.high + dist.medium + dist.low + dist.unscored;
	if (total === 0) return null;

	const highPct = (dist.high / total) * 100;
	const medPct = (dist.medium / total) * 100;
	const lowPct = (dist.low / total) * 100;
	const unscoredPct = (dist.unscored / total) * 100;

	return (
		<div className="space-y-1">
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				Effectiveness Distribution
			</div>
			<div
				className="flex h-3 rounded-full overflow-hidden"
				style={{ backgroundColor: `${theme.colors.border}40` }}
			>
				{highPct > 0 && (
					<div
						style={{ width: `${highPct}%`, backgroundColor: '#22c55e' }}
						title={`High: ${dist.high}`}
					/>
				)}
				{medPct > 0 && (
					<div
						style={{ width: `${medPct}%`, backgroundColor: '#eab308' }}
						title={`Medium: ${dist.medium}`}
					/>
				)}
				{lowPct > 0 && (
					<div
						style={{ width: `${lowPct}%`, backgroundColor: '#ef4444' }}
						title={`Low: ${dist.low}`}
					/>
				)}
				{unscoredPct > 0 && (
					<div
						style={{ width: `${unscoredPct}%`, backgroundColor: '#6b7280' }}
						title={`Unscored: ${dist.unscored}`}
					/>
				)}
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				High: {dist.high} | Medium: {dist.medium} | Low: {dist.low} | Unscored: {dist.unscored}
			</div>
		</div>
	);
}

// ─── Section 2: Injection Activity ──────────────────────────────────────────────

interface PersonaMatchRecord {
	personaId: string;
	personaName: string;
	score: number;
}

interface SkillMatchRecord {
	skillAreaId: string;
	skillAreaName: string;
	score: number;
}

interface InjectionEventRecord {
	sessionId: string;
	memoryIds: string[];
	tokenCount: number;
	timestamp: number;
	scopeGroups: Array<{ scope: string; skillAreaId?: string; projectPath?: string; ids: string[] }>;
	noMatch?: boolean;
	matchedPersonas?: PersonaMatchRecord[];
	matchedSkills?: SkillMatchRecord[];
	checkpointType?: string;
}

/** Timeline bucket for hour-by-hour or day-by-day display. */
interface TimelineBucket {
	label: string;
	start: number;
	end: number;
	events: InjectionEventRecord[];
	noMatchCount: number;
}

function buildTimeline(injections: InjectionEventRecord[]): TimelineBucket[] {
	const todayStart = new Date();
	todayStart.setHours(0, 0, 0, 0);
	const buckets: TimelineBucket[] = [];

	// Hour-by-hour for today (up to current hour)
	const currentHour = new Date().getHours();
	for (let h = 0; h <= currentHour; h++) {
		const start = todayStart.getTime() + h * 3600000;
		const end = start + 3600000;
		const events = injections.filter((e) => e.timestamp >= start && e.timestamp < end);
		buckets.push({
			label: `${h.toString().padStart(2, '0')}:00`,
			start,
			end,
			events,
			noMatchCount: events.filter((e) => e.noMatch).length,
		});
	}

	// Day-by-day for previous 6 days
	for (let d = 1; d <= 6; d++) {
		const dayStart = todayStart.getTime() - d * 86400000;
		const dayEnd = dayStart + 86400000;
		const events = injections.filter((e) => e.timestamp >= dayStart && e.timestamp < dayEnd);
		const dt = new Date(dayStart);
		buckets.push({
			label: `${dt.getMonth() + 1}/${dt.getDate()}`,
			start: dayStart,
			end: dayEnd,
			events,
			noMatchCount: events.filter((e) => e.noMatch).length,
		});
	}

	return buckets;
}

interface DiagnosticResult {
	label: string;
	ok: boolean;
	detail?: string;
}

function InjectionActivitySection({
	theme,
	config,
	stats,
	onConfigChange,
	onNavigateToTab,
}: {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	onConfigChange?: () => void;
	onNavigateToTab?: (tab: string, filter?: Record<string, string> | null) => void;
}) {
	const [expanded, setExpanded] = useState(true);
	const [injections, setInjections] = useState<InjectionEventRecord[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
	const [debugResults, setDebugResults] = useState<DiagnosticResult[] | null>(null);
	const [debugRunning, setDebugRunning] = useState(false);
	const [enabling, setEnabling] = useState(false);
	const [computing, setComputing] = useState(false);
	const [computeResult, setComputeResult] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		window.maestro.memory
			.getRecentInjections(200)
			.then((res: { success: boolean; data?: unknown[] }) => {
				if (cancelled) return;
				if (res.success && Array.isArray(res.data)) {
					setInjections(res.data as InjectionEventRecord[]);
				}
				setLoaded(true);
			})
			.catch(() => setLoaded(true));
		return () => {
			cancelled = true;
		};
	}, []);

	const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const realInjections = injections.filter((e) => !e.noMatch);
	const recentCount = realInjections.filter((e) => e.timestamp >= sevenDaysAgo).length;
	const noMatchCount = injections.filter((e) => e.noMatch && e.timestamp >= sevenDaysAgo).length;
	const checkpointCount = realInjections.filter(
		(e) => e.checkpointType && e.timestamp >= sevenDaysAgo
	).length;

	// Timeline buckets
	const timeline = useMemo(() => buildTimeline(injections), [injections]);
	const maxTimelineEvents = Math.max(...timeline.map((b) => b.events.length), 1);

	// Diagnostic checklist when no injections
	const diagnosticItems = useMemo(() => {
		const realEvents = injections.filter((e) => !e.noMatch);
		if (realEvents.length > 0) return [];
		const items: Array<{ text: string; ok: boolean }> = [];
		// Prerequisites checklist
		items.push({ text: 'Memory system enabled', ok: config.enabled });
		items.push({
			text: 'Memories exist',
			ok: stats != null && stats.totalMemories > 0,
		});
		items.push({
			text: 'Embeddings computed',
			ok: stats != null && stats.pendingEmbeddings === 0,
		});
		if (stats && stats.pendingEmbeddings > 0) {
			items.push({
				text: `${stats.pendingEmbeddings} memories still missing embeddings`,
				ok: false,
			});
		}
		items.push({
			text: 'Hierarchy seeded (personas/skills exist)',
			ok: stats != null && stats.totalPersonas > 0 && stats.totalSkillAreas > 0,
		});
		const hasNoMatchEvents = injections.some((e) => e.noMatch);
		if (hasNoMatchEvents) {
			items.push({
				text: 'Matching memories found for tasks (recent searches returned no matches)',
				ok: false,
			});
		}
		if (items.every((item) => item.ok) && realEvents.length === 0) {
			items.push({
				text: 'Agent sessions started (no agents launched since system enabled)',
				ok: false,
			});
		}
		return items;
	}, [injections, config.enabled, stats]);

	return (
		<div className="rounded-lg border p-4 space-y-2" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={Zap}
				title={`Injection Activity (${loaded ? `${recentCount} in 7 days` : '...'})`}
				collapsible
				collapsed={!expanded}
				onToggle={() => setExpanded(!expanded)}
				action={
					<span className="flex items-center gap-1">
						{checkpointCount > 0 && (
							<span
								className="text-[10px] px-1.5 py-0.5 rounded"
								style={{ color: theme.colors.accent, backgroundColor: `${theme.colors.accent}15` }}
							>
								{checkpointCount} checkpoint
							</span>
						)}
						{noMatchCount > 0 && (
							<span
								className="text-[10px] px-1.5 py-0.5 rounded"
								style={{ color: '#eab308', backgroundColor: '#eab30815' }}
							>
								{noMatchCount} no-match
							</span>
						)}
					</span>
				}
			/>

			{expanded && (
				<div className="space-y-3 pt-1">
					{/* Prominent disabled warning with one-click enable */}
					{!config.enabled && (
						<div
							className="rounded p-3 flex items-center gap-2"
							style={{ backgroundColor: '#eab30810', border: '1px solid #eab30830' }}
						>
							<AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#eab308' }} />
							<div className="flex-1 min-w-0">
								<div className="text-xs font-medium" style={{ color: '#eab308' }}>
									Memory system is disabled
								</div>
								<div className="text-[10px]" style={{ color: '#eab30899' }}>
									Enable it to start injecting memories into your agents.
								</div>
							</div>
							<button
								className="shrink-0 px-3 py-1 rounded text-[10px] font-medium"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
								}}
								disabled={enabling}
								onClick={async () => {
									setEnabling(true);
									try {
										await window.maestro.memory.setConfig({ enabled: true });
										onConfigChange?.();
									} catch {
										// non-critical
									}
									setEnabling(false);
								}}
							>
								{enabling ? 'Enabling...' : 'Enable'}
							</button>
						</div>
					)}

					{/* Embedding health check */}
					{config.enabled && stats && stats.pendingEmbeddings > 0 && (
						<div
							className="rounded p-2 flex items-center gap-2 text-[10px]"
							style={{ backgroundColor: '#eab30810', border: '1px solid #eab30820' }}
						>
							<AlertTriangle className="w-3 h-3 shrink-0" style={{ color: '#eab308' }} />
							<span className="flex-1" style={{ color: '#eab308' }}>
								{stats.pendingEmbeddings} item{stats.pendingEmbeddings !== 1 ? 's' : ''} missing
								embeddings — memories under these personas cannot be matched to tasks.
								{computeResult && (
									<span style={{ color: theme.colors.textDim, marginLeft: 4 }}>
										({computeResult})
									</span>
								)}
							</span>
							<button
								className="shrink-0 px-2 py-0.5 rounded text-[10px] font-medium"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.bgMain,
									opacity: computing ? 0.6 : 1,
								}}
								disabled={computing}
								onClick={async () => {
									setComputing(true);
									setComputeResult(null);
									try {
										const res = await window.maestro.memory.computeAllEmbeddings();
										if (res.success) {
											const total = res.data.memoriesUpdated + res.data.hierarchyUpdated;
											setComputeResult(`${total} embedded`);
											onConfigChange?.();
										} else {
											setComputeResult(res.error);
										}
									} catch (err: any) {
										setComputeResult(err.message ?? 'Failed');
									}
									setComputing(false);
								}}
							>
								{computing ? 'Computing...' : 'Compute All'}
							</button>
						</div>
					)}

					{!loaded && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading...
						</div>
					)}

					{/* Timeline view */}
					{loaded && injections.length > 0 && (
						<div className="space-y-1">
							<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
								Timeline — today (hourly) + last 6 days
							</div>
							<div className="flex items-end gap-px" style={{ height: 32 }}>
								{timeline.map((bucket, i) => {
									const total = bucket.events.filter((e) => !e.noMatch).length;
									const height = (total / maxTimelineEvents) * 100;
									const hasNoMatch = bucket.noMatchCount > 0;
									return (
										<div
											key={i}
											className="flex-1 rounded-t relative"
											style={{
												height: `${Math.max(height, total > 0 ? 10 : 2)}%`,
												backgroundColor:
													total > 0
														? theme.colors.accent
														: hasNoMatch
															? '#eab30830'
															: `${theme.colors.border}40`,
											}}
											title={`${bucket.label}: ${total} injection${total !== 1 ? 's' : ''}${hasNoMatch ? `, ${bucket.noMatchCount} no-match` : ''}`}
										/>
									);
								})}
							</div>
							<div className="flex text-[9px]" style={{ color: theme.colors.textDim }}>
								<span>{timeline[0]?.label}</span>
								{/* Separator between today and prior days */}
								{timeline.length > 1 && (
									<span className="ml-auto">{timeline[timeline.length - 1]?.label}</span>
								)}
							</div>
						</div>
					)}

					{/* No activity diagnostic */}
					{loaded && realInjections.length === 0 && (
						<div className="space-y-1.5">
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								No injection activity recorded.
							</div>
							{diagnosticItems.length > 0 && (
								<div
									className="rounded p-2 space-y-1"
									style={{ backgroundColor: `${theme.colors.border}20` }}
								>
									<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
										Prerequisites checklist:
									</div>
									{diagnosticItems.map((item, i) => (
										<div
											key={i}
											className="flex items-center gap-1.5 text-[10px]"
											style={{ color: item.ok ? '#22c55e' : '#eab308' }}
										>
											{item.ok ? (
												<CheckCircle2 className="w-3 h-3 shrink-0" />
											) : (
												<MinusCircle className="w-3 h-3 shrink-0" />
											)}
											{item.text}
										</div>
									))}
								</div>
							)}
						</div>
					)}

					{/* Injection event list with drill-down */}
					{loaded && realInjections.length > 0 && (
						<div className="space-y-1">
							<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
								Recent events (newest first)
							</div>
							{realInjections.slice(0, 30).map((event, i) => {
								const preview =
									event.memoryIds.length > 0
										? `${event.memoryIds.length} memor${event.memoryIds.length === 1 ? 'y' : 'ies'}`
										: 'No memories';
								const scopes = event.scopeGroups
									.map((g) => g.scope)
									.filter((v, idx, arr) => arr.indexOf(v) === idx)
									.join(', ');
								const isExpanded = expandedEvent === i;

								return (
									<div key={`${event.timestamp}-${i}`}>
										<button
											className="w-full flex items-center gap-2 text-[10px] py-1 px-2 rounded text-left"
											style={{ backgroundColor: `${theme.colors.border}20` }}
											onClick={() => setExpandedEvent(isExpanded ? null : i)}
										>
											{isExpanded ? (
												<ChevronDown
													className="w-2.5 h-2.5 shrink-0"
													style={{ color: theme.colors.textDim }}
												/>
											) : (
												<ChevronRight
													className="w-2.5 h-2.5 shrink-0"
													style={{ color: theme.colors.textDim }}
												/>
											)}
											<span
												className="shrink-0 px-1.5 py-0.5 rounded font-medium"
												style={{
													backgroundColor: `${theme.colors.accent}20`,
													color: theme.colors.accent,
												}}
											>
												{preview}
											</span>
											{event.matchedPersonas && event.matchedPersonas.length > 0 && (
												<span
													className="shrink-0 px-1.5 py-0.5 rounded truncate max-w-[120px]"
													style={{
														backgroundColor: `${theme.colors.accent}15`,
														color: theme.colors.accent,
													}}
													title={event.matchedPersonas.map((p) => p.personaName).join(', ')}
												>
													{event.matchedPersonas[0].personaName}
													{event.matchedPersonas.length > 1 &&
														` +${event.matchedPersonas.length - 1}`}
												</span>
											)}
											{scopes && (
												<span
													className="shrink-0 px-1.5 py-0.5 rounded"
													style={{
														backgroundColor: `${theme.colors.border}40`,
														color: theme.colors.textDim,
													}}
												>
													{scopes}
												</span>
											)}
											{event.checkpointType && (
												<span
													className="shrink-0 px-1.5 py-0.5 rounded font-medium"
													style={{
														backgroundColor:
															event.checkpointType === 'first-error' ||
															event.checkpointType === 'context-pressure'
																? `${theme.colors.error ?? '#ef4444'}25`
																: `${theme.colors.warning ?? '#f59e0b'}20`,
														color:
															event.checkpointType === 'first-error' ||
															event.checkpointType === 'context-pressure'
																? (theme.colors.error ?? '#ef4444')
																: (theme.colors.warning ?? '#f59e0b'),
													}}
													title={`Checkpoint trigger: ${event.checkpointType}`}
												>
													{event.checkpointType === 'first-error'
														? 'error'
														: event.checkpointType === 'context-pressure'
															? 'context'
															: event.checkpointType === 'query-complete'
																? 'question'
																: event.checkpointType.replace(/-/g, ' ')}
												</span>
											)}
											<span style={{ color: theme.colors.textDim }}>
												{event.tokenCount > 0 && `${event.tokenCount} tok`}
											</span>
											<span className="ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
												{formatInjectionTime(event.timestamp)}
											</span>
										</button>
										{/* Drill-down details */}
										{isExpanded && (
											<div
												className="ml-5 mt-1 mb-1 rounded p-2 space-y-1.5 text-[10px]"
												style={{ backgroundColor: `${theme.colors.border}10` }}
											>
												{event.sessionId && (
													<div style={{ color: theme.colors.textDim }}>
														<span className="font-medium">Agent:</span>{' '}
														{event.sessionId.slice(0, 12)}...
													</div>
												)}
												{event.matchedPersonas && event.matchedPersonas.length > 0 && (
													<div className="space-y-0.5">
														<div className="font-medium" style={{ color: theme.colors.textDim }}>
															Matched personas:
														</div>
														{event.matchedPersonas.map((p, pi) => (
															<div
																key={pi}
																className="flex items-center gap-1.5 ml-2"
																style={{ color: theme.colors.textMain }}
															>
																<span
																	className={`px-1 rounded${onNavigateToTab ? ' cursor-pointer hover:opacity-80' : ''}`}
																	style={{
																		backgroundColor: `${theme.colors.accent}20`,
																		color: theme.colors.accent,
																	}}
																	onClick={
																		onNavigateToTab ? () => onNavigateToTab('personas') : undefined
																	}
																>
																	{p.personaName}
																</span>
																<span style={{ color: theme.colors.textDim }}>
																	score: {p.score.toFixed(2)}
																</span>
															</div>
														))}
													</div>
												)}
												{event.matchedSkills && event.matchedSkills.length > 0 && (
													<div className="space-y-0.5">
														<div className="font-medium" style={{ color: theme.colors.textDim }}>
															Matched skills:
														</div>
														{event.matchedSkills.map((s, si) => (
															<div
																key={si}
																className="flex items-center gap-1.5 ml-2"
																style={{ color: theme.colors.textMain }}
															>
																<span
																	className="px-1 rounded"
																	style={{ backgroundColor: `${theme.colors.border}30` }}
																>
																	{s.skillAreaName}
																</span>
																<span style={{ color: theme.colors.textDim }}>
																	score: {s.score.toFixed(2)}
																</span>
															</div>
														))}
													</div>
												)}
												<div style={{ color: theme.colors.textDim }}>
													<span className="font-medium">Time:</span>{' '}
													{new Date(event.timestamp).toLocaleString()}
												</div>
												{event.scopeGroups.length > 0 && (
													<div className="space-y-0.5">
														<div className="font-medium" style={{ color: theme.colors.textDim }}>
															Scope breakdown:
														</div>
														{event.scopeGroups.map((sg, si) => (
															<div
																key={si}
																className="flex items-center gap-1.5 ml-2"
																style={{ color: theme.colors.textMain }}
															>
																<span
																	className="px-1 rounded"
																	style={{ backgroundColor: `${theme.colors.border}30` }}
																>
																	{sg.scope}
																</span>
																<span style={{ color: theme.colors.textDim }}>
																	{sg.ids.length} memor{sg.ids.length === 1 ? 'y' : 'ies'}
																</span>
																{sg.skillAreaId && (
																	<span style={{ color: theme.colors.textDim }}>
																		(skill: {sg.skillAreaId.slice(0, 8)}...)
																	</span>
																)}
																{sg.projectPath && (
																	<span style={{ color: theme.colors.textDim }}>
																		({sg.projectPath.split('/').pop()})
																	</span>
																)}
															</div>
														))}
													</div>
												)}
												{event.memoryIds.length > 0 && (
													<div className="space-y-0.5">
														<div className="font-medium" style={{ color: theme.colors.textDim }}>
															Memory IDs:
														</div>
														<div className="ml-2 flex flex-wrap gap-1">
															{event.memoryIds.slice(0, 10).map((id, mi) => (
																<span
																	key={mi}
																	className="px-1 rounded font-mono"
																	style={{
																		backgroundColor: `${theme.colors.border}30`,
																		color: theme.colors.textDim,
																		fontSize: '9px',
																	}}
																>
																	{id.slice(0, 12)}
																</span>
															))}
															{event.memoryIds.length > 10 && (
																<span style={{ color: theme.colors.textDim }}>
																	+{event.memoryIds.length - 10} more
																</span>
															)}
														</div>
													</div>
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}

					{/* No-match events summary */}
					{loaded && noMatchCount > 0 && (
						<div
							className="rounded p-2 text-[10px] flex items-center gap-1.5"
							style={{ backgroundColor: '#eab30810', color: '#eab308' }}
						>
							<AlertTriangle className="w-3 h-3 shrink-0" />
							{noMatchCount} search{noMatchCount !== 1 ? 'es' : ''} returned no matching memories in
							the last 7 days
						</div>
					)}

					{/* Debug Injection button */}
					{loaded && (
						<div className="pt-1">
							<button
								className="text-[10px] px-2 py-1 rounded"
								style={{
									backgroundColor: `${theme.colors.border}30`,
									color: theme.colors.textDim,
								}}
								disabled={debugRunning}
								onClick={async () => {
									setDebugRunning(true);
									try {
										const res = await window.maestro.memory.debugInjection();
										if (res.success) {
											setDebugResults(res.data);
										}
									} catch {
										// non-critical
									}
									setDebugRunning(false);
								}}
							>
								{debugRunning ? 'Running...' : 'Debug Injection'}
							</button>

							{debugResults && (
								<div
									className="mt-2 rounded p-2 space-y-1"
									style={{ backgroundColor: `${theme.colors.border}15` }}
								>
									<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
										Injection pipeline diagnostic:
									</div>
									{debugResults.map((item, i) => (
										<div key={i} className="space-y-0.5">
											<div
												className="flex items-center gap-1.5 text-[10px]"
												style={{ color: item.ok ? '#22c55e' : '#ef4444' }}
											>
												{item.ok ? (
													<CheckCircle2 className="w-3 h-3 shrink-0" />
												) : (
													<XCircle className="w-3 h-3 shrink-0" />
												)}
												{item.label}
											</div>
											{item.detail && (
												<div
													className="ml-[18px] text-[9px]"
													style={{ color: theme.colors.textDim }}
												>
													{item.detail}
												</div>
											)}
										</div>
									))}
									{debugResults.every((r) => r.ok) && realInjections.length === 0 && (
										<div
											className="mt-1 text-[10px] p-1.5 rounded"
											style={{
												backgroundColor: `${theme.colors.accent}10`,
												color: theme.colors.accent,
											}}
										>
											All prerequisites pass. Try starting a new agent session — memories are
											injected at agent startup when the task context matches a persona's expertise.
										</div>
									)}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Section 3: Memory Timeline ─────────────────────────────────────────────────

type TimelineFilter = 'all' | 'created' | 'promoted' | 'decayed' | 'pruned';
type TimeRange = 'today' | '7d' | '30d' | 'all';

const EVENT_TYPE_CONFIG: Record<
	MemoryChangeEventType,
	{
		icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
		color: string;
		label: string;
	}
> = {
	created: { icon: Plus, color: '#22c55e', label: 'Created' },
	updated: { icon: Edit3, color: '#3b82f6', label: 'Updated' },
	archived: { icon: Archive, color: '#6b7280', label: 'Archived' },
	deleted: { icon: Trash2, color: '#ef4444', label: 'Deleted' },
	promoted: { icon: ArrowUp, color: '#8b5cf6', label: 'Promoted' },
	decayed: { icon: TrendingDown, color: '#eab308', label: 'Decayed' },
	pruned: { icon: Scissors, color: '#ef4444', label: 'Pruned' },
	consolidated: { icon: GitMerge, color: '#3b82f6', label: 'Consolidated' },
	imported: { icon: Download, color: '#22c55e', label: 'Imported' },
};

const FILTER_TYPES: Record<TimelineFilter, MemoryChangeEventType[]> = {
	all: [],
	created: ['created', 'imported'],
	promoted: ['promoted'],
	decayed: ['decayed'],
	pruned: ['pruned', 'deleted', 'archived'],
};

function getTimeRangeStart(range: TimeRange): number | undefined {
	if (range === 'all') return undefined;
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;
	switch (range) {
		case 'today': {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			return today.getTime();
		}
		case '7d':
			return now - 7 * dayMs;
		case '30d':
			return now - 30 * dayMs;
	}
}

function MemoryTimelineSection({ theme, config }: { theme: Theme; config: MemoryConfig }) {
	const [collapsed, setCollapsed] = useState(false);
	const [events, setEvents] = useState<MemoryChangeEvent[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [typeFilter, setTypeFilter] = useState<TimelineFilter>('all');
	const [timeRange, setTimeRange] = useState<TimeRange>('7d');
	const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

	useEffect(() => {
		if (!config.enabled) return;
		let cancelled = false;
		const since = getTimeRangeStart(timeRange);
		window.maestro.memory
			.getChangeLog(since, 200)
			.then((res) => {
				if (cancelled) return;
				if (res.success && Array.isArray(res.data)) {
					setEvents(res.data);
				}
				setLoaded(true);
			})
			.catch(() => setLoaded(true));
		return () => {
			cancelled = true;
		};
	}, [config.enabled, timeRange]);

	const filtered = useMemo(() => {
		const allowedTypes = FILTER_TYPES[typeFilter];
		if (allowedTypes.length === 0) return events;
		return events.filter((e) => allowedTypes.includes(e.type));
	}, [events, typeFilter]);

	// Summary stats for the header
	const summary = useMemo(() => {
		const counts: Partial<Record<MemoryChangeEventType, number>> = {};
		for (const e of events) {
			counts[e.type] = (counts[e.type] ?? 0) + 1;
		}
		return counts;
	}, [events]);

	if (!config.enabled) return null;

	const summaryParts: string[] = [];
	if (summary.created) summaryParts.push(`+${summary.created} created`);
	if (summary.promoted) summaryParts.push(`${summary.promoted} promoted`);
	if (summary.decayed) summaryParts.push(`${summary.decayed} decayed`);
	if (summary.pruned) summaryParts.push(`${summary.pruned} pruned`);
	if (summary.deleted) summaryParts.push(`${summary.deleted} deleted`);

	return (
		<div className="rounded-lg border p-4 space-y-2" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={Clock}
				title="Memory Timeline"
				description={summaryParts.length > 0 ? `(${summaryParts.join(', ')})` : undefined}
				collapsible
				collapsed={collapsed}
				onToggle={() => setCollapsed((c) => !c)}
				badge={events.length || null}
			/>

			{!collapsed && (
				<div className="space-y-3">
					{/* Filter bar */}
					<div className="flex items-center gap-2 flex-wrap">
						<Filter className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
						{(['all', 'created', 'promoted', 'decayed', 'pruned'] as TimelineFilter[]).map((f) => (
							<button
								key={f}
								className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
								style={{
									backgroundColor: typeFilter === f ? `${theme.colors.accent}20` : 'transparent',
									color: typeFilter === f ? theme.colors.accent : theme.colors.textDim,
									border: `1px solid ${typeFilter === f ? theme.colors.accent : theme.colors.border}`,
								}}
								onClick={() => setTypeFilter(f)}
							>
								{f.charAt(0).toUpperCase() + f.slice(1)}
							</button>
						))}
						<div className="ml-auto flex items-center gap-1">
							{(['today', '7d', '30d', 'all'] as TimeRange[]).map((r) => (
								<button
									key={r}
									className="text-[10px] px-1.5 py-0.5 rounded transition-colors"
									style={{
										backgroundColor: timeRange === r ? `${theme.colors.accent}20` : 'transparent',
										color: timeRange === r ? theme.colors.accent : theme.colors.textDim,
									}}
									onClick={() => setTimeRange(r)}
								>
									{r === 'all' ? 'All' : r === 'today' ? 'Today' : r}
								</button>
							))}
						</div>
					</div>

					{/* Timeline */}
					{!loaded ? (
						<div className="text-[10px] py-4 text-center" style={{ color: theme.colors.textDim }}>
							Loading timeline...
						</div>
					) : filtered.length === 0 ? (
						<div className="text-[10px] py-4 text-center" style={{ color: theme.colors.textDim }}>
							No events for this filter/time range.
						</div>
					) : (
						<div className="space-y-0 max-h-[320px] overflow-y-auto">
							{filtered.slice(0, 50).map((evt, idx) => {
								const cfg = EVENT_TYPE_CONFIG[evt.type];
								const Icon = cfg.icon;
								const isExpanded = expandedIdx === idx;
								const contentPreview = evt.memoryContent
									? evt.memoryContent.split('\n')[0].slice(0, 80)
									: '';

								return (
									<button
										key={`${evt.timestamp}-${evt.memoryId}-${idx}`}
										className="flex items-start gap-2 w-full text-left py-1.5 px-1 rounded hover:bg-white/5 transition-colors"
										onClick={() => setExpandedIdx(isExpanded ? null : idx)}
									>
										{/* Timeline line + icon */}
										<div className="flex flex-col items-center shrink-0 mt-0.5">
											<div
												className="w-5 h-5 rounded-full flex items-center justify-center"
												style={{ backgroundColor: `${cfg.color}20` }}
											>
												<Icon className="w-3 h-3" style={{ color: cfg.color }} />
											</div>
											{idx < filtered.length - 1 && (
												<div
													className="w-px flex-1 min-h-[12px]"
													style={{ backgroundColor: theme.colors.border }}
												/>
											)}
										</div>

										{/* Content */}
										<div className="flex-1 min-w-0 pb-1">
											<div className="flex items-center gap-1.5">
												<span className="text-[10px] font-medium" style={{ color: cfg.color }}>
													{cfg.label}
												</span>
												<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
													{formatRelativeTime(evt.timestamp)}
												</span>
												<span
													className="text-[10px] ml-auto"
													style={{ color: theme.colors.textDim }}
												>
													{evt.triggeredBy === 'user' ? 'manual' : 'auto'}
												</span>
											</div>
											{contentPreview && (
												<div
													className="text-[10px] truncate mt-0.5"
													style={{ color: theme.colors.textMain }}
												>
													{contentPreview}
												</div>
											)}
											{isExpanded && (
												<div
													className="text-[10px] mt-1 p-1.5 rounded space-y-1"
													style={{
														backgroundColor: theme.colors.bgActivity,
														color: theme.colors.textDim,
													}}
												>
													{evt.details && <div>{evt.details}</div>}
													<div>
														Type: {evt.memoryType} · Scope: {evt.scope}
													</div>
													<div className="font-mono text-[9px] opacity-60">ID: {evt.memoryId}</div>
												</div>
											)}
										</div>
									</button>
								);
							})}
							{filtered.length > 50 && (
								<div
									className="text-[10px] text-center py-1"
									style={{ color: theme.colors.textDim }}
								>
									Showing 50 of {filtered.length} events
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Section 4: System Metrics ──────────────────────────────────────────────────

function SystemMetricsSection({ theme }: { theme: Theme }) {
	const [expanded, setExpanded] = useState(false);
	const [embeddingStatus, setEmbeddingStatus] = useState<{
		loaded: boolean;
		modelName: string;
		dimensions: number;
	} | null>(null);
	const [queueStatus, setQueueStatus] = useState<JobQueueStatus | null>(null);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
	const [storeSize, setStoreSize] = useState<{ totalBytes: number; fileCount: number } | null>(
		null
	);

	useEffect(() => {
		let mounted = true;

		Promise.allSettled([
			window.maestro.settings.get('grpo:modelStatus'),
			window.maestro.memory.getJobQueueStatus(),
			window.maestro.memory.getTokenUsage(),
			window.maestro.memory.getStoreSize(),
		]).then(([embResult, queueResult, tokenResult, sizeResult]) => {
			if (!mounted) return;
			if (
				embResult.status === 'fulfilled' &&
				embResult.value &&
				typeof embResult.value === 'object'
			) {
				setEmbeddingStatus(
					embResult.value as { loaded: boolean; modelName: string; dimensions: number }
				);
			}
			if (queueResult.status === 'fulfilled') {
				const res = queueResult.value as { success: boolean; data?: JobQueueStatus };
				if (res.success && res.data) setQueueStatus(res.data);
			}
			if (tokenResult.status === 'fulfilled') {
				const res = tokenResult.value as { success: boolean; data?: TokenUsage };
				if (res.success && res.data) setTokenUsage(res.data);
			}
			if (sizeResult.status === 'fulfilled') {
				const res = sizeResult.value as {
					success: boolean;
					data?: { totalBytes: number; fileCount: number };
				};
				if (res.success && res.data) setStoreSize(res.data);
			}
		});

		return () => {
			mounted = false;
		};
	}, []);

	return (
		<div className="rounded-lg border p-4 space-y-2" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={Cpu}
				title="System Metrics"
				description="(power users)"
				collapsible
				collapsed={!expanded}
				onToggle={() => setExpanded(!expanded)}
			/>

			{expanded && (
				<div className="space-y-3 pt-1">
					{/* Embedding Model */}
					{embeddingStatus && (
						<div className="flex items-center gap-2 text-xs">
							<div
								className="w-2 h-2 rounded-full shrink-0"
								style={{ backgroundColor: embeddingStatus.loaded ? '#22c55e' : '#eab308' }}
							/>
							<span style={{ color: theme.colors.textMain }}>Embedding Model</span>
							<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
								{embeddingStatus.loaded
									? `${embeddingStatus.modelName} (${embeddingStatus.dimensions}d)`
									: 'Not loaded'}
							</span>
						</div>
					)}

					{/* Token Usage */}
					{tokenUsage && (
						<div className="space-y-1">
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Token Usage (24h)
							</div>
							<div className="grid grid-cols-2 gap-1 text-[10px]">
								<div style={{ color: theme.colors.textMain }}>
									Extraction: {tokenUsage.extractionTokens.toLocaleString()} tokens
								</div>
								<div style={{ color: theme.colors.textMain }}>
									Injection: {tokenUsage.injectionTokens.toLocaleString()} tokens
								</div>
								<div style={{ color: theme.colors.textDim }}>
									Calls: {tokenUsage.extractionCalls}
								</div>
								{tokenUsage.estimatedCostUsd > 0 && (
									<div style={{ color: theme.colors.textDim }}>
										Est. cost: ${tokenUsage.estimatedCostUsd.toFixed(4)}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Queue Status */}
					{queueStatus && (
						<div className="space-y-1">
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Job Queue
							</div>
							<div className="text-[10px] space-y-0.5">
								<div style={{ color: theme.colors.textMain }}>
									{queueStatus.processing
										? `Processing: ${queueStatus.currentActivity || queueStatus.currentJob || 'active'}`
										: 'Idle'}
								</div>
								{queueStatus.queueLength > 0 && (
									<div style={{ color: theme.colors.textDim }}>
										{queueStatus.queueLength} job{queueStatus.queueLength !== 1 ? 's' : ''} pending
										{queueStatus.estimatedSecondsRemaining != null &&
											` (~${Math.ceil(queueStatus.estimatedSecondsRemaining)}s remaining)`}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Search Performance */}
					<div className="flex items-center gap-2 text-xs">
						<div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: '#6b7280' }} />
						<span style={{ color: theme.colors.textMain }}>Search Performance</span>
						<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
							Not tracked
						</span>
					</div>

					{/* Store Size */}
					{storeSize && (
						<div className="flex items-center gap-2 text-xs">
							<div
								className="w-2 h-2 rounded-full shrink-0"
								style={{ backgroundColor: '#22c55e' }}
							/>
							<span style={{ color: theme.colors.textMain }}>Store Size</span>
							<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
								{formatBytes(storeSize.totalBytes)} ({storeSize.fileCount} files)
							</span>
						</div>
					)}

					{!embeddingStatus && !tokenUsage && !queueStatus && !storeSize && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							No metrics available
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Section 4: Impact Dashboard ────────────────────────────────────────────────

function ImpactDashboardSection({
	stats,
	theme,
	allMemories,
}: {
	stats: MemoryStats;
	theme: Theme;
	allMemories: MemoryEntry[];
}) {
	// Injection events for frequency chart and session counting
	const [injectionEvents, setInjectionEvents] = useState<InjectionEventRecord[]>([]);
	useEffect(() => {
		let cancelled = false;
		window.maestro.memory
			.getRecentInjections(200)
			.then((res: { success: boolean; data?: unknown[] }) => {
				if (cancelled) return;
				if (res.success && Array.isArray(res.data)) {
					setInjectionEvents(res.data as InjectionEventRecord[]);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	// Weekly stats for non-technical summary
	const weeklyStats = useMemo(() => {
		const oneWeekAgo = Date.now() - 7 * 86400000;
		const weekEvents = injectionEvents.filter((e) => e.timestamp >= oneWeekAgo && !e.noMatch);
		const weekSessions = new Set(weekEvents.map((e) => e.sessionId).filter(Boolean));
		let totalMemoriesDelivered = 0;
		for (const ev of weekEvents) {
			totalMemoriesDelivered += ev.memoryIds.length;
		}
		return {
			memoriesDelivered: totalMemoriesDelivered,
			sessionCount: weekSessions.size,
			experiencesLearned: stats.byType?.experience ?? 0,
		};
	}, [injectionEvents, stats]);

	// Non-technical summary
	const summaryText = `Your memory system has delivered ${weeklyStats.memoriesDelivered} relevant memories across ${weeklyStats.sessionCount} agent sessions this week, with ${weeklyStats.experiencesLearned} new experiences learned.`;

	// Most-used memories (top 5 by useCount)
	const topMemories = useMemo(() => {
		return [...allMemories]
			.filter((m) => m.useCount > 0)
			.sort((a, b) => b.useCount - a.useCount)
			.slice(0, 5);
	}, [allMemories]);

	// Most active personas (top 3 by total useCount across their memories)
	const topPersonas = useMemo(() => {
		const personaMap = new Map<
			string,
			{ personaId: string; personaName: string; totalUseCount: number; memoryCount: number }
		>();
		for (const m of allMemories) {
			if (!m.personaId || !m.active || m.archived) continue;
			const pName = (m as MemoryEntry & { personaName?: string }).personaName ?? m.personaId;
			const existing = personaMap.get(m.personaId);
			if (existing) {
				existing.totalUseCount += m.useCount;
				existing.memoryCount++;
			} else {
				personaMap.set(m.personaId, {
					personaId: m.personaId,
					personaName: pName,
					totalUseCount: m.useCount,
					memoryCount: 1,
				});
			}
		}
		return Array.from(personaMap.values())
			.sort((a, b) => b.totalUseCount - a.totalUseCount)
			.slice(0, 3);
	}, [allMemories]);

	// Effectiveness distribution buckets
	const effectBuckets = useMemo(() => {
		const buckets = [0, 0, 0, 0, 0]; // 0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0
		for (const m of allMemories) {
			if (!m.active || m.archived) continue;
			const score = m.effectivenessScore;
			if (score >= 0.8) buckets[4]++;
			else if (score >= 0.6) buckets[3]++;
			else if (score >= 0.4) buckets[2]++;
			else if (score >= 0.2) buckets[1]++;
			else buckets[0]++;
		}
		return buckets;
	}, [allMemories]);

	const bucketLabels = ['0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'];
	const maxBucket = Math.max(...effectBuckets, 1);

	// Effectiveness trends: improving, declining, never evaluated
	const effectivenessTrends = useMemo(() => {
		const sevenDaysAgo = Date.now() - 7 * 86400000;
		let improving = 0;
		let declining = 0;
		let neverEvaluated = 0;

		for (const m of allMemories) {
			if (!m.active || m.archived) continue;
			// Never evaluated: injected at least once but effectiveness never updated
			if (m.useCount > 0 && (!m.effectivenessUpdatedAt || m.effectivenessUpdatedAt === 0)) {
				neverEvaluated++;
				continue;
			}
			// Check recent delta (updated within last 7 days)
			if (m.effectivenessUpdatedAt && m.effectivenessUpdatedAt >= sevenDaysAgo) {
				const delta = m.effectivenessDelta ?? 0;
				if (delta > 0.1) improving++;
				else if (delta < -0.1) declining++;
			}
		}

		return { improving, declining, neverEvaluated };
	}, [allMemories]);

	// Extraction ROI
	const experienceCount = stats.byType?.experience ?? 0;
	const promotedCount = stats.bySource?.grpo ?? 0;

	// Injection frequency: bar chart for last 14 days, segmented by scope
	const dayBars = useMemo(() => {
		const now = Date.now();
		const days: { label: string; count: number; skill: number; project: number; global: number }[] =
			[];
		for (let i = 13; i >= 0; i--) {
			const dayStart = now - (i + 1) * 86400000;
			const dayEnd = now - i * 86400000;
			const dayEvents = injectionEvents.filter(
				(e) => e.timestamp >= dayStart && e.timestamp < dayEnd
			);
			let skill = 0,
				project = 0,
				global = 0;
			for (const ev of dayEvents) {
				for (const sg of ev.scopeGroups) {
					if (sg.scope === 'skill') skill += sg.ids.length;
					else if (sg.scope === 'project') project += sg.ids.length;
					else global += sg.ids.length;
				}
			}
			const d = new Date(dayEnd);
			days.push({
				label: `${d.getMonth() + 1}/${d.getDate()}`,
				count: dayEvents.length,
				skill,
				project,
				global,
			});
		}
		return days;
	}, [injectionEvents]);

	const maxDayCount = Math.max(...dayBars.map((d) => d.count), 1);

	// Before/After: count sessions with memory injection vs total unique sessions
	const sessionContext = useMemo(() => {
		const allSessions = new Set(injectionEvents.map((e) => e.sessionId).filter(Boolean));
		const matchSessions = new Set(
			injectionEvents
				.filter((e) => !e.noMatch && e.memoryIds.length > 0)
				.map((e) => e.sessionId)
				.filter(Boolean)
		);
		const noMatchSessions = allSessions.size - matchSessions.size;
		return {
			withMemory: matchSessions.size,
			withoutMemory: noMatchSessions,
			total: allSessions.size,
		};
	}, [injectionEvents]);

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<SectionHeader theme={theme} icon={BarChart3} title="Impact Dashboard" />

			{/* Non-technical summary */}
			<div
				className="text-xs rounded p-2"
				style={{ backgroundColor: `${theme.colors.accent}10`, color: theme.colors.textMain }}
			>
				{summaryText}
			</div>

			{/* Injection frequency chart (14 days) */}
			{dayBars.some((d) => d.count > 0) && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Injection Frequency (14 days)
					</div>
					<div className="flex items-end gap-px" style={{ height: 40 }}>
						{dayBars.map((day, i) => {
							const height = (day.count / maxDayCount) * 100;
							return (
								<div
									key={i}
									className="flex-1 rounded-t"
									style={{
										height: `${Math.max(height, day.count > 0 ? 10 : 2)}%`,
										backgroundColor:
											day.count > 0 ? theme.colors.accent : `${theme.colors.border}40`,
									}}
									title={`${day.label}: ${day.count} injections (skill: ${day.skill}, project: ${day.project}, global: ${day.global})`}
								/>
							);
						})}
					</div>
					<div className="flex justify-between text-[9px]" style={{ color: theme.colors.textDim }}>
						<span>{dayBars[0]?.label}</span>
						<span>{dayBars[dayBars.length - 1]?.label}</span>
					</div>
				</div>
			)}

			{/* Most-used memories */}
			{topMemories.length > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Most Used Memories
					</div>
					{topMemories.map((m) => (
						<div
							key={m.id}
							className="flex items-center gap-2 text-[10px] py-1 px-2 rounded"
							style={{ backgroundColor: `${theme.colors.border}20` }}
						>
							<Star className="w-3 h-3 shrink-0" style={{ color: '#eab308' }} />
							<span
								className="truncate flex-1 min-w-0"
								style={{ color: theme.colors.textMain }}
								title={m.content}
							>
								{m.content.length > 80 ? m.content.slice(0, 80) + '...' : m.content}
							</span>
							<span className="shrink-0 ml-auto" style={{ color: theme.colors.textDim }}>
								{m.useCount}x
							</span>
						</div>
					))}
				</div>
			)}

			{/* Most active personas (top 3) */}
			{topPersonas.length > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Most Active Personas
					</div>
					{topPersonas.map((p) => (
						<div
							key={p.personaId}
							className="flex items-center gap-2 text-[10px] py-1 px-2 rounded"
							style={{ backgroundColor: `${theme.colors.border}20` }}
						>
							<Users className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
							<span className="truncate flex-1 min-w-0" style={{ color: theme.colors.textMain }}>
								{p.personaName}
							</span>
							<span className="shrink-0 text-right" style={{ color: theme.colors.textDim }}>
								{p.totalUseCount} injections / {p.memoryCount} memories
							</span>
						</div>
					))}
				</div>
			)}

			{/* Effectiveness distribution (5 buckets) */}
			{allMemories.length > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Effectiveness Distribution
					</div>
					<div className="space-y-0.5">
						{bucketLabels.map((label, i) => (
							<div key={label} className="flex items-center gap-2 text-[10px]">
								<span className="w-10 text-right" style={{ color: theme.colors.textDim }}>
									{label}
								</span>
								<div
									className="flex-1 h-2.5 rounded-full overflow-hidden"
									style={{ backgroundColor: `${theme.colors.border}30` }}
								>
									<div
										className="h-full rounded-full"
										style={{
											width: `${(effectBuckets[i] / maxBucket) * 100}%`,
											backgroundColor: i >= 3 ? '#22c55e' : i >= 2 ? '#eab308' : '#6b7280',
										}}
									/>
								</div>
								<span className="w-6 text-right" style={{ color: theme.colors.textDim }}>
									{effectBuckets[i]}
								</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Effectiveness Trends (7 day) */}
			{(effectivenessTrends.improving > 0 ||
				effectivenessTrends.declining > 0 ||
				effectivenessTrends.neverEvaluated > 0) && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Effectiveness Trends (7d)
					</div>
					<div className="flex items-center gap-2 text-[10px] flex-wrap">
						{effectivenessTrends.improving > 0 && (
							<span
								className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
								style={{ backgroundColor: '#22c55e20', color: '#22c55e' }}
							>
								<TrendingUp className="w-3 h-3" />
								{effectivenessTrends.improving} improving
							</span>
						)}
						{effectivenessTrends.declining > 0 && (
							<span
								className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
								style={{ backgroundColor: '#ef444420', color: '#ef4444' }}
							>
								<TrendingDown className="w-3 h-3" />
								{effectivenessTrends.declining} declining
							</span>
						)}
						{effectivenessTrends.neverEvaluated > 0 && (
							<span
								className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
								style={{ backgroundColor: '#6b728020', color: '#9ca3af' }}
							>
								<MinusCircle className="w-3 h-3" />
								{effectivenessTrends.neverEvaluated} never evaluated
							</span>
						)}
					</div>
				</div>
			)}

			{/* Extraction ROI */}
			<div className="space-y-1">
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Learning Pipeline
				</div>
				<div
					className="flex items-center gap-1 text-[10px] flex-wrap"
					style={{ color: theme.colors.textMain }}
				>
					<span
						className="px-1.5 py-0.5 rounded"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						{experienceCount} extracted
					</span>
					<TrendingUp className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span
						className="px-1.5 py-0.5 rounded"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						{promotedCount} promoted
					</span>
					<TrendingUp className="w-3 h-3" style={{ color: theme.colors.textDim }} />
					<span
						className="px-1.5 py-0.5 rounded"
						style={{ backgroundColor: `${theme.colors.border}30` }}
					>
						{stats.recentInjections} injected (7d)
					</span>
				</div>
			</div>

			{/* Before/After: session context */}
			{sessionContext.total > 0 && (
				<div
					className="text-[10px] rounded p-2 space-y-0.5"
					style={{ backgroundColor: `${theme.colors.border}15`, color: theme.colors.textDim }}
				>
					<div>
						Memory-equipped agents: {sessionContext.withMemory} sessions with memories injected
					</div>
					{sessionContext.withoutMemory > 0 && (
						<div>
							Standard agents: {sessionContext.withoutMemory} sessions without matching memories
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ─── Utilities ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ─── Section 5: Embedding Usage ─────────────────────────────────────────────────

function EmbeddingUsageSection({ theme, config }: { theme: Theme; config: MemoryConfig }) {
	const [expanded, setExpanded] = useState(false);
	const [summaryAllTime, setSummaryAllTime] = useState<EmbeddingUsageSummary | null>(null);
	const [summary24h, setSummary24h] = useState<EmbeddingUsageSummary | null>(null);
	const [summary7d, setSummary7d] = useState<EmbeddingUsageSummary | null>(null);
	const [summary30d, setSummary30d] = useState<EmbeddingUsageSummary | null>(null);
	const [timeline, setTimeline] = useState<EmbeddingUsageBucket[]>([]);
	const [providerStatus, setProviderStatus] = useState<{
		ready: boolean;
		modelName: string;
		error?: string;
	} | null>(null);

	const isCloud = config.embeddingProvider?.providerId === 'openai';
	const providerId = config.embeddingProvider?.providerId ?? null;

	const fetchUsage = useCallback(async () => {
		const now = Date.now();
		try {
			const results = await Promise.allSettled([
				window.maestro.embedding.getUsageSummary(0), // all-time
				window.maestro.embedding.getUsageSummary(now - 86400000),
				window.maestro.embedding.getUsageSummary(now - 604800000),
				window.maestro.embedding.getStatus(),
				...(isCloud
					? [
							window.maestro.embedding.getUsageSummary(now - 2592000000),
							window.maestro.embedding.getUsageTimeline(now - 604800000, 86400000),
						]
					: []),
			]);
			if (results[0].status === 'fulfilled' && results[0].value.success)
				setSummaryAllTime(results[0].value.data);
			if (results[1].status === 'fulfilled' && results[1].value.success)
				setSummary24h(results[1].value.data);
			if (results[2].status === 'fulfilled' && results[2].value.success)
				setSummary7d(results[2].value.data);
			if (results[3].status === 'fulfilled' && results[3].value.success) {
				const statusData = results[3].value.data;
				if (providerId && statusData.statuses[providerId]) {
					setProviderStatus(statusData.statuses[providerId]);
				}
			}
			if (isCloud) {
				if (
					results[4]?.status === 'fulfilled' &&
					(results[4].value as { success: boolean; data?: EmbeddingUsageSummary }).success
				)
					setSummary30d(
						(results[4].value as { success: boolean; data: EmbeddingUsageSummary }).data
					);
				if (
					results[5]?.status === 'fulfilled' &&
					(results[5].value as { success: boolean; data?: EmbeddingUsageBucket[] }).success
				)
					setTimeline(
						(results[5].value as { success: boolean; data: EmbeddingUsageBucket[] }).data
					);
			}
		} catch {
			// Non-critical
		}
	}, [isCloud, providerId]);

	useEffect(() => {
		if (!config.enabled) return;
		fetchUsage();
	}, [config.enabled, fetchUsage]);

	const providerName = providerId ?? 'none';
	const latencyStr =
		summary24h && summary24h.totalTexts > 0 && summary24h.avgDurationMs > 0
			? `${Math.round(summary24h.avgDurationMs)}ms`
			: 'N/A';

	// Billing period estimate: extrapolate 30d cost to current month
	const billingEstimate = useMemo(() => {
		if (!isCloud || !summary30d) return null;
		const now = new Date();
		const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
		const dayOfMonth = now.getDate();
		if (dayOfMonth === 0 || summary30d.totalCostUsd === 0) return null;
		const dailyAvg = summary30d.totalCostUsd / 30;
		return dailyAvg * daysInMonth;
	}, [isCloud, summary30d]);

	return (
		<div className="rounded-lg border overflow-hidden" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				title="Embedding Usage"
				theme={theme}
				icon={DollarSign}
				description={isCloud ? 'Cost & usage tracking' : 'Usage tracking'}
				collapsible
				collapsed={!expanded}
				onToggle={() => setExpanded((v) => !v)}
			/>

			{expanded && (
				<div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: theme.colors.border }}>
					{/* Provider info with model name and status */}
					<div
						className="flex items-center gap-2 pt-3 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Provider:</span>
						<span style={{ color: theme.colors.textMain, fontWeight: 500 }}>{providerName}</span>
						{providerStatus && (
							<>
								<span>·</span>
								<span style={{ color: theme.colors.textMain }}>{providerStatus.modelName}</span>
								<span>·</span>
								<span
									className="inline-flex items-center gap-1"
									style={{
										color: providerStatus.ready
											? '#22c55e'
											: providerStatus.error
												? '#ef4444'
												: theme.colors.textDim,
									}}
								>
									<span
										className="inline-block w-1.5 h-1.5 rounded-full"
										style={{
											backgroundColor: providerStatus.ready
												? '#22c55e'
												: providerStatus.error
													? '#ef4444'
													: theme.colors.textDim,
										}}
									/>
									{providerStatus.ready ? 'Ready' : providerStatus.error ? 'Error' : 'Inactive'}
								</span>
							</>
						)}
					</div>

					{/* Core metrics */}
					<div className="grid grid-cols-3 gap-2">
						<UsageStatCard
							theme={theme}
							label="Texts (all-time)"
							value={formatNumber(summaryAllTime?.totalTexts ?? 0)}
						/>
						<UsageStatCard theme={theme} label="Texts (24h)" value={summary24h?.totalTexts ?? 0} />
						<UsageStatCard theme={theme} label="Avg Latency" value={latencyStr} />
					</div>

					{/* OpenAI-specific: cost breakdown */}
					{isCloud && (
						<>
							<div className="text-xs font-medium pt-1" style={{ color: theme.colors.textMain }}>
								Cost Breakdown
							</div>
							<div className="grid grid-cols-3 gap-2">
								<UsageStatCard
									theme={theme}
									label="Tokens (24h)"
									value={formatNumber(summary24h?.totalTokens ?? 0)}
									sub={`$${(summary24h?.totalCostUsd ?? 0).toFixed(4)}`}
								/>
								<UsageStatCard
									theme={theme}
									label="Tokens (7d)"
									value={formatNumber(summary7d?.totalTokens ?? 0)}
									sub={`$${(summary7d?.totalCostUsd ?? 0).toFixed(4)}`}
								/>
								<UsageStatCard
									theme={theme}
									label="Tokens (30d)"
									value={formatNumber(summary30d?.totalTokens ?? 0)}
									sub={`$${(summary30d?.totalCostUsd ?? 0).toFixed(4)}`}
								/>
							</div>

							{/* Billing period estimate */}
							{billingEstimate !== null && billingEstimate > 0 && (
								<div
									className="flex items-center gap-2 p-2 rounded-lg text-xs"
									style={{ backgroundColor: theme.colors.bgActivity }}
								>
									<TrendingUp
										className="w-3.5 h-3.5 shrink-0"
										style={{ color: theme.colors.accent }}
									/>
									<span style={{ color: theme.colors.textDim }}>Current period estimate:</span>
									<span style={{ color: theme.colors.textMain, fontWeight: 600 }}>
										${billingEstimate.toFixed(4)}
									</span>
								</div>
							)}

							{/* Mini bar chart for daily cost */}
							{timeline.length > 0 && (
								<div className="pt-1">
									<div className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
										Daily Cost (7d)
									</div>
									<div className="flex items-end gap-1" style={{ height: 40 }}>
										{(() => {
											const maxCost = Math.max(...timeline.map((b) => b.cost), 0.0001);
											return timeline.map((bucket, i) => (
												<div
													key={i}
													className="flex-1 rounded-t"
													style={{
														height: `${Math.max((bucket.cost / maxCost) * 100, 2)}%`,
														backgroundColor: theme.colors.accent,
														opacity: 0.7,
													}}
													title={`$${bucket.cost.toFixed(4)} — ${new Date(bucket.bucket).toLocaleDateString()}`}
												/>
											));
										})()}
									</div>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

function UsageStatCard({
	theme,
	label,
	value,
	sub,
}: {
	theme: Theme;
	label: string;
	value: string | number;
	sub?: string;
}) {
	return (
		<div
			className="p-2 rounded-lg text-center"
			style={{ backgroundColor: theme.colors.bgActivity }}
		>
			<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
				{value}
			</div>
			<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
			{sub && (
				<div className="text-[10px] mt-0.5" style={{ color: theme.colors.accent }}>
					{sub}
				</div>
			)}
		</div>
	);
}

function formatNumber(n: number): string {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

// ─── Section 6: Promotion History ──────────────────────────────────────────────

function PromotionHistorySection({
	theme,
	allMemories,
}: {
	theme: Theme;
	allMemories: MemoryEntry[];
}) {
	const [collapsed, setCollapsed] = useState(true);

	// Derive promotion history from memories with 'promoted:experience' tag
	const promotionHistory = useMemo(() => {
		return allMemories
			.filter(
				(m) => m.type === 'rule' && m.tags.includes('promoted:experience') && m.experienceContext
			)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, 20);
	}, [allMemories]);

	if (promotionHistory.length === 0) return null;

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={TrendingUp}
				title="Promotion History"
				collapsible
				collapsed={collapsed}
				onToggle={() => setCollapsed(!collapsed)}
				action={
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{promotionHistory.length} promotion{promotionHistory.length !== 1 ? 's' : ''}
					</span>
				}
			/>

			{!collapsed && (
				<div className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin">
					{promotionHistory.map((entry) => (
						<div
							key={entry.id}
							className="rounded border p-2.5 space-y-1.5"
							style={{ borderColor: theme.colors.border }}
						>
							{/* Original experience (if context available) */}
							{entry.experienceContext?.situation && (
								<div className="text-[10px] italic" style={{ color: theme.colors.textDim }}>
									{entry.experienceContext.situation.length > 120
										? `${entry.experienceContext.situation.slice(0, 120)}...`
										: entry.experienceContext.situation}
								</div>
							)}

							{/* Resulting rule */}
							<div className="text-xs" style={{ color: theme.colors.textMain }}>
								{entry.content.length > 150 ? `${entry.content.slice(0, 150)}...` : entry.content}
							</div>

							{/* Meta: timestamp + source */}
							<div
								className="flex items-center gap-2 text-[10px]"
								style={{ color: theme.colors.textDim }}
							>
								<span>{formatRelativeTime(entry.updatedAt)}</span>
								<span
									className="px-1.5 py-0.5 rounded"
									style={{ backgroundColor: `${theme.colors.border}40` }}
								>
									{entry.source === 'consolidation' ? 'user' : entry.source}
								</span>
								{entry.experienceContext?.sourceProjectPath && (
									<span
										className="truncate max-w-[100px]"
										title={entry.experienceContext.sourceProjectPath}
									>
										{entry.experienceContext.sourceProjectPath.split('/').pop()}
									</span>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Section 6: Persona Shifts ──────────────────────────────────────────────────

interface PersonaShiftRecord {
	timestamp: number;
	sessionId: string;
	fromPersona: { id: string; name: string; score: number };
	toPersona: { id: string; name: string; score: number };
	triggerContext: string;
}

function PersonaShiftSection({
	theme,
	config,
	allMemories,
}: {
	theme: Theme;
	config: MemoryConfig;
	allMemories: MemoryEntry[];
}) {
	const [collapsed, setCollapsed] = useState(true);
	const [shifts, setShifts] = useState<PersonaShiftRecord[]>([]);
	const [injections, setInjections] = useState<InjectionEventRecord[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		if (!config.enabled) return;
		let cancelled = false;
		Promise.allSettled([
			window.maestro.memory.getPersonaShifts(100),
			window.maestro.memory.getRecentInjections(200),
		]).then(([shiftResult, injResult]) => {
			if (cancelled) return;
			if (shiftResult.status === 'fulfilled' && shiftResult.value.success) {
				setShifts(shiftResult.value.data as PersonaShiftRecord[]);
			}
			if (injResult.status === 'fulfilled' && injResult.value.success) {
				setInjections((injResult.value as { success: true; data: InjectionEventRecord[] }).data);
			}
			setLoaded(true);
		});
		return () => {
			cancelled = true;
		};
	}, [config.enabled]);

	const sevenDaysAgo = Date.now() - 7 * 86400000;

	// Persona usage: count how many times each persona was matched in the last 7 days
	const personaUsage = useMemo(() => {
		const counts = new Map<string, { name: string; count: number }>();
		for (const ev of injections) {
			if (ev.timestamp < sevenDaysAgo || !ev.matchedPersonas) continue;
			for (const p of ev.matchedPersonas) {
				const existing = counts.get(p.personaId);
				if (existing) {
					existing.count++;
				} else {
					counts.set(p.personaId, { name: p.personaName, count: 1 });
				}
			}
		}
		return Array.from(counts.entries())
			.map(([id, v]) => ({ id, name: v.name, count: v.count }))
			.sort((a, b) => b.count - a.count);
	}, [injections, sevenDaysAgo]);

	const maxUsageCount = Math.max(...personaUsage.map((p) => p.count), 1);

	// Shift frequency in last 7 days
	const recentShifts = useMemo(
		() => shifts.filter((s) => s.timestamp >= sevenDaysAgo),
		[shifts, sevenDaysAgo]
	);

	// Never-matched personas: personas from allMemories that have never appeared in any injection event
	const neverMatched = useMemo(() => {
		const matchedIds = new Set<string>();
		for (const ev of injections) {
			if (ev.matchedPersonas) {
				for (const p of ev.matchedPersonas) matchedIds.add(p.personaId);
			}
		}
		// Collect unique personas from memories
		const personaMap = new Map<string, string>();
		for (const m of allMemories) {
			if (m.personaId && !personaMap.has(m.personaId)) {
				personaMap.set(
					m.personaId,
					(m as MemoryEntry & { personaName?: string }).personaName ?? m.personaId
				);
			}
		}
		return Array.from(personaMap.entries())
			.filter(([id]) => !matchedIds.has(id))
			.map(([id, name]) => ({ id, name }));
	}, [injections, allMemories]);

	if (!config.enabled) return null;

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<SectionHeader
				theme={theme}
				icon={ArrowRightLeft}
				title="Persona Shifts"
				collapsible
				collapsed={collapsed}
				onToggle={() => setCollapsed(!collapsed)}
				action={
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{loaded
							? `${recentShifts.length} shift${recentShifts.length !== 1 ? 's' : ''} (7d)`
							: '...'}
					</span>
				}
			/>

			{!collapsed && (
				<div className="space-y-3 pt-1">
					{!loaded && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading...
						</div>
					)}

					{/* Persona Usage Chart (horizontal bars) */}
					{loaded && personaUsage.length > 0 && (
						<div className="space-y-1">
							<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
								Persona Match Frequency (7 days)
							</div>
							<div className="space-y-1">
								{personaUsage.map((p) => (
									<div key={p.id} className="flex items-center gap-2 text-[10px]">
										<span
											className="w-24 truncate text-right shrink-0"
											style={{ color: theme.colors.textMain }}
											title={p.name}
										>
											{p.name}
										</span>
										<div
											className="flex-1 h-3 rounded-full overflow-hidden"
											style={{ backgroundColor: `${theme.colors.border}30` }}
										>
											<div
												className="h-full rounded-full"
												style={{
													width: `${(p.count / maxUsageCount) * 100}%`,
													backgroundColor: theme.colors.accent,
												}}
											/>
										</div>
										<span
											className="w-6 text-right shrink-0"
											style={{ color: theme.colors.textDim }}
										>
											{p.count}
										</span>
									</div>
								))}
							</div>
						</div>
					)}

					{loaded && personaUsage.length === 0 && injections.length > 0 && (
						<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
							No persona matches recorded in the last 7 days.
						</div>
					)}

					{/* Shift Frequency Summary */}
					{loaded && recentShifts.length > 0 && (
						<div
							className="rounded p-2 text-[10px]"
							style={{ backgroundColor: `${theme.colors.border}15` }}
						>
							<span style={{ color: theme.colors.textMain }}>
								{recentShifts.length} persona shift{recentShifts.length !== 1 ? 's' : ''} detected
								in the last 7 days
							</span>
							{recentShifts.length >= 10 && (
								<span style={{ color: '#eab308' }}>
									{' '}
									— high shift count may indicate personas need better differentiation or the
									hierarchy needs reorganization
								</span>
							)}
						</div>
					)}

					{/* Shift Timeline */}
					{loaded && recentShifts.length > 0 && (
						<div className="space-y-1">
							<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
								Shift Timeline
							</div>
							<div className="space-y-1 max-h-60 overflow-y-auto scrollbar-thin">
								{recentShifts.slice(0, 20).map((shift, i) => (
									<div
										key={`${shift.timestamp}-${i}`}
										className="rounded border p-2 space-y-1"
										style={{ borderColor: theme.colors.border }}
									>
										<div className="flex items-center gap-1.5 text-[10px] flex-wrap">
											<span
												className="px-1.5 py-0.5 rounded"
												style={{
													backgroundColor: `${theme.colors.border}40`,
													color: theme.colors.textMain,
												}}
											>
												{shift.fromPersona.name}
											</span>
											<ArrowRightLeft
												className="w-3 h-3 shrink-0"
												style={{ color: theme.colors.textDim }}
											/>
											<span
												className="px-1.5 py-0.5 rounded"
												style={{
													backgroundColor: `${theme.colors.accent}20`,
													color: theme.colors.accent,
												}}
											>
												{shift.toPersona.name}
											</span>
											<span className="ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
												{formatRelativeTime(shift.timestamp)}
											</span>
										</div>
										<div className="flex items-center gap-1.5 text-[9px]">
											<span style={{ color: theme.colors.textDim }}>
												{shift.fromPersona.score.toFixed(2)} → {shift.toPersona.score.toFixed(2)}
											</span>
											<span style={{ color: theme.colors.textDim }}>
												· {shift.sessionId.slice(0, 12)}...
											</span>
										</div>
										{shift.triggerContext && (
											<div
												className="text-[9px] italic truncate"
												style={{ color: theme.colors.textDim }}
												title={shift.triggerContext}
											>
												{shift.triggerContext.length > 100
													? `${shift.triggerContext.slice(0, 100)}...`
													: shift.triggerContext}
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					)}

					{/* Never-Matched Personas */}
					{loaded && neverMatched.length > 0 && (
						<div className="space-y-1">
							<div className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
								Never-Matched Personas
							</div>
							<div
								className="rounded p-2 space-y-0.5 text-[10px]"
								style={{ backgroundColor: `${theme.colors.border}10` }}
							>
								<div style={{ color: '#eab308' }}>
									{neverMatched.length} persona{neverMatched.length !== 1 ? 's have' : ' has'} never
									been matched to any task. Consider improving descriptions/embeddings or removing
									unnecessary personas.
								</div>
								<div className="flex flex-wrap gap-1 mt-1">
									{neverMatched.map((p) => (
										<span
											key={p.id}
											className="px-1.5 py-0.5 rounded"
											style={{
												backgroundColor: `${theme.colors.border}30`,
												color: theme.colors.textDim,
											}}
										>
											{p.name}
										</span>
									))}
								</div>
							</div>
						</div>
					)}

					{loaded &&
						shifts.length === 0 &&
						personaUsage.length === 0 &&
						neverMatched.length === 0 && (
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								No persona activity recorded yet. Start agent sessions to begin tracking persona
								matches and shifts.
							</div>
						)}
				</div>
			)}
		</div>
	);
}

function formatInjectionTime(ts: number): string {
	return formatRelativeTime(ts);
}

function formatRelativeTime(ts: number): string {
	const diff = Date.now() - ts;
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}
