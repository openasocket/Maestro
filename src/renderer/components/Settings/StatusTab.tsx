/**
 * StatusTab - Status & Health sub-tab within MemorySettings.
 *
 * Four sections: System Health, Injection Activity, System Metrics, Impact Dashboard.
 * Provides diagnostics, injection tracking, and visual evidence of memory system value.
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
	AlertTriangle,
	ArrowUpCircle,
	Archive,
	ChevronDown,
	ChevronRight,
	Zap,
	Cpu,
	BarChart3,
	CheckCircle2,
	XCircle,
	MinusCircle,
	Star,
	TrendingUp,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	MemoryEntry,
	JobQueueStatus,
	TokenUsage,
	ExtractionDiagnostic,
} from '../../../shared/memory-types';
import { TabDescriptionBanner } from './TabDescriptionBanner';

export interface StatusTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
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

	return (
		<div className="space-y-4">
			<TabDescriptionBanner
				theme={theme}
				description="System diagnostics and impact visualization — health status, injection activity, technical metrics, and evidence that the memory system is delivering value."
			/>

			{/* Section 1: System Health */}
			<SystemHealthSection
				stats={stats}
				theme={theme}
				config={config}
				atRiskCount={atRiskCount}
				healthCtx={healthCtx}
			/>

			{/* Section 2: Injection Activity */}
			<InjectionActivitySection theme={theme} config={config} stats={stats} />

			{/* Section 3: System Metrics (collapsed by default) */}
			<SystemMetricsSection theme={theme} />

			{/* Section 4: Impact Dashboard */}
			{stats && <ImpactDashboardSection stats={stats} theme={theme} allMemories={allMemories} />}
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
						<div
							className="flex items-center gap-1.5 text-xs"
							style={{ color: theme.colors.accent }}
						>
							<ArrowUpCircle className="w-3 h-3" />
							{stats.promotionCandidates} experiences ready for promotion
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

interface InjectionEventRecord {
	sessionId: string;
	memoryIds: string[];
	tokenCount: number;
	timestamp: number;
	scopeGroups: Array<{ scope: string; skillAreaId?: string; projectPath?: string; ids: string[] }>;
	noMatch?: boolean;
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

function InjectionActivitySection({
	theme,
	config,
	stats,
}: {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
}) {
	const [expanded, setExpanded] = useState(true);
	const [injections, setInjections] = useState<InjectionEventRecord[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

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
			<button
				className="w-full flex items-center gap-2 text-left"
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					<ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				) : (
					<ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				)}
				<Zap className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Injection Activity ({loaded ? `${recentCount} in 7 days` : '...'})
				</span>
				{noMatchCount > 0 && (
					<span
						className="text-[10px] px-1.5 py-0.5 rounded"
						style={{ color: '#eab308', backgroundColor: `${'#eab308'}15` }}
					>
						{noMatchCount} no-match
					</span>
				)}
			</button>

			{expanded && (
				<div className="space-y-3 pt-1">
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
				</div>
			)}
		</div>
	);
}

// ─── Section 3: System Metrics ──────────────────────────────────────────────────

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
			<button
				className="w-full flex items-center gap-2 text-left"
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					<ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				) : (
					<ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				)}
				<Cpu className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					System Metrics
				</span>
				<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
					(power users)
				</span>
			</button>

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
	// Non-technical summary
	const summaryText = `Your memory system has delivered ${stats.recentInjections} relevant memories across ${stats.totalInjections} total injections, with ${stats.byType?.experience ?? 0} experiences learned.`;

	// Most-used memories (top 5 by useCount)
	const topMemories = useMemo(() => {
		return [...allMemories]
			.filter((m) => m.useCount > 0)
			.sort((a, b) => b.useCount - a.useCount)
			.slice(0, 5);
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

	// Extraction ROI
	const experienceCount = stats.byType?.experience ?? 0;
	const promotedCount = stats.bySource?.grpo ?? 0;

	// Injection frequency: simple bar chart for last 14 days (from injection events)
	const [injectionsByDay, setInjectionsByDay] = useState<InjectionEventRecord[]>([]);
	useEffect(() => {
		let cancelled = false;
		window.maestro.memory
			.getRecentInjections(200)
			.then((res: { success: boolean; data?: unknown[] }) => {
				if (cancelled) return;
				if (res.success && Array.isArray(res.data)) {
					setInjectionsByDay(res.data as InjectionEventRecord[]);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const dayBars = useMemo(() => {
		const now = Date.now();
		const days: { label: string; count: number; skill: number; project: number; global: number }[] =
			[];
		for (let i = 13; i >= 0; i--) {
			const dayStart = now - (i + 1) * 86400000;
			const dayEnd = now - i * 86400000;
			const dayEvents = injectionsByDay.filter(
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
	}, [injectionsByDay]);

	const maxDayCount = Math.max(...dayBars.map((d) => d.count), 1);

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center gap-2">
				<BarChart3 className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Impact Dashboard
				</div>
			</div>

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

			{/* Extraction ROI */}
			<div className="space-y-1">
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Learning Pipeline
				</div>
				<div
					className="flex items-center gap-1 text-[10px]"
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

			{/* Session count context */}
			{stats.totalInjections > 0 && (
				<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
					Memory-equipped agents: {stats.totalInjections} total injection events recorded
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
