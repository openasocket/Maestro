/**
 * ExperiencesTab - Experiences sub-tab within MemorySettings.
 *
 * Contains: extraction status panel, background processing config,
 * promotion candidates, experience repository.
 * Moved from MemorySettings.tsx during MEM-TAB-01 redistribution.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Loader2, Check, ArrowUpCircle, Edit3, X, Pin, Globe } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	MemoryScope,
	PromotionCandidate,
	JobQueueStatus,
	TokenUsage,
	ExtractionDiagnostic,
	ExtractionProgress,
} from '../../../shared/memory-types';
import { ConfigToggle } from './MemoryConfigWidgets';
import { ExperienceRepositoryPanel } from './ExperienceRepositoryPanel';
import { TabDescriptionBanner } from './TabDescriptionBanner';

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

export function ExperiencesTab({
	theme,
	config,
	stats: _stats,
	projectPath,
	onUpdateConfig,
	onRefresh,
	activeAgentId,
	activeAgentType,
}: ExperiencesTabProps): React.ReactElement {
	// Promotion state
	const [promotionCandidates, setPromotionCandidates] = useState<PromotionCandidate[]>([]);
	const [editingPromotionId, setEditingPromotionId] = useState<string | null>(null);
	const [editingRuleText, setEditingRuleText] = useState('');
	const [error, setError] = useState<string | null>(null);

	// Extraction state
	const [queueStatus, setQueueStatus] = useState<JobQueueStatus | null>(null);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
	const [batchCapableAgents, setBatchCapableAgents] = useState<{ id: string; name: string }[]>([]);

	// Fetch batch-capable agents for provider dropdown
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

	// Subscribe to queue status updates + periodic refresh
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

	// Load promotion candidates
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

	// Promotion action handlers
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

	return (
		<div className="space-y-4">
			<TabDescriptionBanner
				theme={theme}
				description="Experiences are lessons learned from real coding sessions — what worked, what didn't, and why. They're automatically extracted from your agent interactions and can be promoted to permanent rules when patterns prove reliable."
			/>

			{error && (
				<div
					className="flex items-center gap-2 p-3 rounded-lg text-xs"
					style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
				>
					{error}
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

			{/* Background Processing Config */}
			<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Background Processing
				</div>

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

				<ConfigToggle
					label="Cross-Project Promotion"
					description="Detect recurring experiences across projects and suggest global promotion"
					checked={config.enableCrossProjectPromotion}
					onChange={(v) => onUpdateConfig({ enableCrossProjectPromotion: v })}
					theme={theme}
				/>
			</div>

			{/* Promotion Candidates */}
			{promotionCandidates.length > 0 && (
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
			)}

			{/* Experience Repository */}
			<ExperienceRepositoryPanel theme={theme} />
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
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			{/* Header with status indicator */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Experience Extraction
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

			{/* Recent extraction history */}
			{diagnostics.length > 0 && (
				<div className="space-y-1.5">
					<div className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						Recent Activity
					</div>
					{diagnostics
						.slice()
						.reverse()
						.map((d, i) => (
							<ExtractionDiagnosticRow key={`${d.sessionId}-${i}`} diagnostic={d} theme={theme} />
						))}
				</div>
			)}

			{diagnostics.length === 0 && !isProcessing && (
				<div className="text-xs text-center py-2" style={{ color: theme.colors.textDim }}>
					No extraction activity yet. Complete a session with 3+ interactions to trigger analysis.
				</div>
			)}
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
				<div className="flex items-center gap-2" style={{ color: theme.colors.textDim }}>
					<span>{timeAgo}</span>
					{diagnostic.providerUsed && <span>via {diagnostic.providerUsed}</span>}
					{tokens && <span>{tokens}</span>}
					{diagnostic.experiencesStored != null && diagnostic.experiencesStored > 0 && (
						<span>{diagnostic.experiencesStored} stored</span>
					)}
				</div>
			</div>
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
