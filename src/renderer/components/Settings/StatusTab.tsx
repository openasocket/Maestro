/**
 * StatusTab - Status sub-tab within MemorySettings.
 *
 * Contains: memory health panel, injection activity, embedding model status.
 * Moved from MemorySettings.tsx during MEM-TAB-01 redistribution.
 */

import React, { useState, useEffect } from 'react';
import {
	Activity,
	AlertTriangle,
	ArrowUpCircle,
	Archive,
	Link2,
	ChevronDown,
	ChevronRight,
	Zap,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats, MemoryEntry } from '../../../shared/memory-types';
import { TabDescriptionBanner } from './TabDescriptionBanner';

export interface StatusTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function StatusTab({
	theme,
	config,
	stats,
	projectPath,
}: StatusTabProps): React.ReactElement {
	// Load allMemories to compute atRiskCount
	const [allMemories, setAllMemories] = useState<MemoryEntry[]>([]);

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
				description="System health overview showing how the memory system is performing — which memories are being used, injection activity, and overall system metrics."
			/>

			{/* Memory Health */}
			{stats && (
				<MemoryHealthPanel
					stats={stats}
					theme={theme}
					promotionCandidatesCount={stats.promotionCandidates ?? 0}
					atRiskCount={atRiskCount}
				/>
			)}

			{/* Injection Activity */}
			<InjectionActivityPanel theme={theme} />

			{/* Embedding Model Status */}
			<EmbeddingModelStatus theme={theme} />
		</div>
	);
}

// ─── Memory Health Panel ────────────────────────────────────────────────────────

function MemoryHealthPanel({
	stats,
	theme,
	promotionCandidatesCount,
	atRiskCount,
}: {
	stats: MemoryStats;
	theme: Theme;
	promotionCandidatesCount: number;
	atRiskCount: number;
}) {
	const dist = stats.effectivenessDistribution;
	const total = dist.high + dist.medium + dist.low + dist.unscored;
	const highPct = total > 0 ? (dist.high / total) * 100 : 0;
	const medPct = total > 0 ? (dist.medium / total) * 100 : 0;
	const lowPct = total > 0 ? (dist.low / total) * 100 : 0;
	const unscoredPct = total > 0 ? (dist.unscored / total) * 100 : 0;

	const categoryEntries = Object.entries(stats.byCategory).sort(([, a], [, b]) => b - a);

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center gap-2">
				<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Memory Health
				</div>
			</div>

			{/* Effectiveness Distribution Bar */}
			{total > 0 && (
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
			)}

			{/* Memory Type Distribution Bar */}
			{stats.totalMemories > 0 && stats.byType && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Memory Types
					</div>
					<div
						className="flex h-3 rounded-full overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}40` }}
					>
						{(stats.byType.rule ?? 0) > 0 && (
							<div
								style={{
									width: `${((stats.byType.rule ?? 0) / stats.totalMemories) * 100}%`,
									backgroundColor: theme.colors.accent,
								}}
								title={`Rules: ${stats.byType.rule}`}
							/>
						)}
						{(stats.byType.experience ?? 0) > 0 && (
							<div
								style={{
									width: `${((stats.byType.experience ?? 0) / stats.totalMemories) * 100}%`,
									backgroundColor: '#22c55e',
								}}
								title={`Experiences: ${stats.byType.experience}`}
							/>
						)}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Rules: {stats.byType.rule ?? 0} | Experiences: {stats.byType.experience ?? 0}
					</div>
				</div>
			)}

			{/* Warning items */}
			<div className="space-y-1">
				{stats.neverInjectedCount > 0 && (
					<div className="flex items-center gap-1.5 text-xs" style={{ color: '#eab308' }}>
						<AlertTriangle className="w-3 h-3" />
						{stats.neverInjectedCount} memories never injected
					</div>
				)}
				{atRiskCount > 0 && (
					<div className="flex items-center gap-1.5 text-xs" style={{ color: '#eab308' }}>
						<AlertTriangle className="w-3 h-3" />
						{atRiskCount} memories approaching archive threshold
					</div>
				)}
				{(promotionCandidatesCount > 0 || stats.promotionCandidates > 0) && (
					<div className="flex items-center gap-1.5 text-xs" style={{ color: theme.colors.accent }}>
						<ArrowUpCircle className="w-3 h-3" />
						{promotionCandidatesCount || stats.promotionCandidates} experiences ready for promotion
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

			{/* Recent Activity */}
			<div className="space-y-1">
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Recent Activity (7 days)
				</div>
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					{stats.recentInjections} injections
					{stats.avgTokensPerInjection > 0 && (
						<> | avg {stats.avgTokensPerInjection.toLocaleString()} tokens/injection</>
					)}
				</div>
				{stats.totalLinks > 0 && (
					<div className="flex items-center gap-1 text-xs" style={{ color: theme.colors.textDim }}>
						<Link2 className="w-3 h-3" />
						{stats.totalLinks} inter-memory links
					</div>
				)}
			</div>

			{/* Categories */}
			{categoryEntries.length > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Categories
					</div>
					<div className="text-xs" style={{ color: theme.colors.textMain }}>
						{categoryEntries.map(([cat, count], i) => (
							<span key={cat}>
								{i > 0 && ' | '}
								{cat}: {count}
							</span>
						))}
					</div>
				</div>
			)}

			{/* Footer: hierarchy counts + type/source breakdown */}
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
		</div>
	);
}

// ─── Injection Activity Panel ───────────────────────────────────────────────────

interface InjectionEventRecord {
	sessionId: string;
	memoryIds: string[];
	tokenCount: number;
	timestamp: number;
	scopeGroups: Array<{ scope: string; skillAreaId?: string; projectPath?: string; ids: string[] }>;
}

function InjectionActivityPanel({ theme }: { theme: Theme }) {
	const [expanded, setExpanded] = useState(false);
	const [injections, setInjections] = useState<InjectionEventRecord[]>([]);
	const [loaded, setLoaded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		window.maestro.memory
			.getRecentInjections(20)
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
	const recentCount = injections.filter((e) => e.timestamp >= sevenDaysAgo).length;

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
					Recent Injections ({loaded ? `${recentCount} in 7 days` : '...'})
				</span>
			</button>

			{expanded && (
				<div className="space-y-1.5 pt-1">
					{!loaded && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading...
						</div>
					)}
					{loaded && injections.length === 0 && (
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							No memories injected recently. Memories are injected when agents encounter relevant
							tasks.
						</div>
					)}
					{loaded &&
						injections.slice(0, 20).map((event, i) => {
							const preview =
								event.memoryIds.length > 0
									? `${event.memoryIds.length} memor${event.memoryIds.length === 1 ? 'y' : 'ies'}`
									: 'No memories';
							const scopes = event.scopeGroups
								.map((g) => g.scope)
								.filter((v, idx, arr) => arr.indexOf(v) === idx)
								.join(', ');
							return (
								<div
									key={`${event.timestamp}-${i}`}
									className="flex items-center gap-2 text-[10px] py-1 px-2 rounded"
									style={{ backgroundColor: `${theme.colors.border}20` }}
								>
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
									<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
										{event.tokenCount > 0 && `${event.tokenCount} tokens`}
									</span>
									<span className="ml-auto shrink-0" style={{ color: theme.colors.textDim }}>
										{formatInjectionTime(event.timestamp)}
									</span>
								</div>
							);
						})}
				</div>
			)}
		</div>
	);
}

function formatInjectionTime(ts: number): string {
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

// ─── Embedding Model Status ─────────────────────────────────────────────────────

function EmbeddingModelStatus({ theme }: { theme: Theme }) {
	const [status, setStatus] = useState<{
		loaded: boolean;
		modelName: string;
		dimensions: number;
	} | null>(null);

	useEffect(() => {
		let mounted = true;
		window.maestro.settings
			.get('grpo:modelStatus')
			.then((result) => {
				if (mounted && result && typeof result === 'object') {
					setStatus(result as { loaded: boolean; modelName: string; dimensions: number });
				}
			})
			.catch(() => {});
		return () => {
			mounted = false;
		};
	}, []);

	if (!status) return null;

	return (
		<div
			className="rounded-lg border p-3 flex items-center gap-3"
			style={{ borderColor: theme.colors.border }}
		>
			<div className={`w-2 h-2 rounded-full ${status.loaded ? 'bg-green-500' : 'bg-yellow-500'}`} />
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Embedding Model
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{status.loaded ? `${status.modelName} (${status.dimensions}d)` : 'Not loaded'}
				</div>
			</div>
		</div>
	);
}
