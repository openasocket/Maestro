import React, { useState, useCallback, useMemo } from 'react';
import {
	FileText,
	FolderOpen,
	Activity,
	Cpu,
	Database,
	FileBarChart,
	RefreshCw,
	AlertCircle,
	CheckCircle2,
	Shield,
	Loader2,
	Info,
	Download,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { UseVibesDataReturn } from '../../hooks';
import type {
	VibesAssuranceLevel,
	VibesAnnotation,
	VibesAction,
} from '../../../shared/vibes-types';
import { VibesLiveMonitor } from './VibesLiveMonitor';

interface VibesDashboardProps {
	theme: Theme;
	projectPath: string | undefined;
	vibesData: UseVibesDataReturn;
	vibesEnabled: boolean;
	vibesAssuranceLevel: VibesAssuranceLevel;
	vibesAutoInit?: boolean;
	binaryAvailable?: boolean | null;
	onAssuranceLevelChange?: (level: VibesAssuranceLevel) => void;
}

/** Color mapping for assurance level badges. */
const ASSURANCE_COLORS: Record<VibesAssuranceLevel, { bg: string; text: string; label: string }> = {
	low: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308', label: 'Low' },
	medium: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6', label: 'Medium' },
	high: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e', label: 'High' },
};

/** Colors for annotation action types. */
const ACTION_COLORS: Record<VibesAction, string> = {
	create: '#22c55e',
	modify: '#3b82f6',
	delete: '#ef4444',
	review: '#eab308',
};

/** Colors for model donut segments. */
const MODEL_PALETTE = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

/** Colors for assurance level distribution. */
const ASSURANCE_BAR_COLORS: Record<VibesAssuranceLevel, string> = {
	low: '#93c5fd',
	medium: '#3b82f6',
	high: '#6366f1',
};

/** Available time range options for the activity timeline. */
const TIMELINE_RANGES = [
	{ days: 30, label: '30d' },
	{ days: 14, label: '14d' },
	{ days: 7, label: '7d' },
	{ days: 1, label: '1d' },
] as const;

type TimelineRangeDays = (typeof TIMELINE_RANGES)[number]['days'];

/** Group annotations into time buckets for the activity timeline. */
function buildTimeline(
	annotations: VibesAnnotation[],
	rangeDays: TimelineRangeDays
): {
	buckets: { label: string; counts: Record<VibesAction, number>; total: number }[];
	maxCount: number;
} {
	const now = Date.now();
	const cutoff = now - rangeDays * 86400_000;

	const lineAnnotations = annotations.filter(
		(a): a is Extract<VibesAnnotation, { action: VibesAction }> =>
			(a.type === 'line' || a.type === 'function') && new Date(a.timestamp).getTime() >= cutoff
	);

	if (lineAnnotations.length === 0) return { buckets: [], maxCount: 0 };

	let bucketSize: number;
	let formatLabel: (d: Date) => string;

	if (rangeDays === 1) {
		// 1-day view: always bucket by hour (24 buckets max)
		bucketSize = 3600_000;
		formatLabel = (d) => `${d.getHours()}:00`;
	} else if (rangeDays <= 7) {
		// 7-day view: bucket by 6-hour blocks for more resolution
		bucketSize = 6 * 3600_000;
		formatLabel = (d) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`;
	} else {
		// 14d / 30d: bucket by day
		bucketSize = 86400_000;
		formatLabel = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
	}

	const bucketMap = new Map<number, Record<VibesAction, number>>();
	const bucketLabels = new Map<number, string>();

	for (const a of lineAnnotations) {
		const t = new Date(a.timestamp).getTime();
		const key = Math.floor(t / bucketSize) * bucketSize;
		const existing = bucketMap.get(key) ?? { create: 0, modify: 0, delete: 0, review: 0 };
		existing[a.action]++;
		bucketMap.set(key, existing);
		if (!bucketLabels.has(key)) bucketLabels.set(key, formatLabel(new Date(key)));
	}

	const sorted = [...bucketMap.entries()].sort((a, b) => a[0] - b[0]);
	let maxCount = 0;
	const buckets = sorted.map(([key, counts]) => {
		const total = counts.create + counts.modify + counts.delete + counts.review;
		if (total > maxCount) maxCount = total;
		return { label: bucketLabels.get(key) ?? '', counts, total };
	});

	return { buckets, maxCount };
}

/**
 * VIBES Dashboard — main overview shown when the VIBES tab is opened.
 *
 * Displays a status banner, stats cards row, assurance level indicator,
 * and quick-action buttons for common VIBES operations.
 */
export const VibesDashboard: React.FC<VibesDashboardProps> = ({
	theme,
	projectPath,
	vibesData,
	vibesEnabled,
	vibesAssuranceLevel,
	vibesAutoInit,
	binaryAvailable,
	onAssuranceLevelChange,
}) => {
	const { isInitialized, stats, sessions, models, isLoading, error, refresh, initialize } =
		vibesData;
	const [initProjectName, setInitProjectName] = useState('');
	const [isInitializing, setIsInitializing] = useState(false);
	const [actionStatus, setActionStatus] = useState<{
		type: 'success' | 'error';
		message: string;
	} | null>(null);
	const [timelineRange, setTimelineRange] = useState<TimelineRangeDays>(30);

	// ========================================================================
	// Computed visualizations
	// ========================================================================

	const timeline = useMemo(
		() => buildTimeline(vibesData.annotations, timelineRange),
		[vibesData.annotations, timelineRange]
	);

	const assuranceDist = useMemo(() => {
		const dist = { low: 0, medium: 0, high: 0 };
		for (const a of vibesData.annotations) {
			if (a.type === 'line' || a.type === 'function') {
				dist[a.assurance_level]++;
			}
		}
		return dist;
	}, [vibesData.annotations]);

	const assuranceTotal = assuranceDist.low + assuranceDist.medium + assuranceDist.high;

	// ========================================================================
	// Quick Actions
	// ========================================================================

	const handleBuildDatabase = useCallback(async () => {
		if (!projectPath) return;
		setActionStatus(null);
		try {
			const result = await window.maestro.vibes.build(projectPath);
			if (result.success) {
				setActionStatus({ type: 'success', message: 'Database built successfully' });
				refresh();
			} else {
				setActionStatus({ type: 'error', message: result.error ?? 'Build failed' });
			}
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Build failed',
			});
		}
	}, [projectPath, refresh]);

	const handleGenerateReport = useCallback(async () => {
		if (!projectPath) return;
		setActionStatus(null);
		try {
			const result = await window.maestro.vibes.getReport(projectPath, 'markdown');
			if (result.success) {
				setActionStatus({ type: 'success', message: 'Report generated successfully' });
			} else {
				setActionStatus({ type: 'error', message: result.error ?? 'Report generation failed' });
			}
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Report generation failed',
			});
		}
	}, [projectPath]);

	const handleInitialize = useCallback(async () => {
		const name = initProjectName.trim();
		if (!name) return;
		setIsInitializing(true);
		setActionStatus(null);
		try {
			await initialize(name);
			setInitProjectName('');
			setActionStatus({ type: 'success', message: 'VIBES initialized for this project' });
		} catch (err) {
			setActionStatus({
				type: 'error',
				message: err instanceof Error ? err.message : 'Initialization failed',
			});
		} finally {
			setIsInitializing(false);
		}
	}, [initProjectName, initialize]);

	// Export dropdown state
	const [showExportMenu, setShowExportMenu] = useState(false);

	const handleExport = useCallback(
		async (type: 'annotations' | 'manifest' | 'summary') => {
			if (!projectPath) return;
			setShowExportMenu(false);
			setActionStatus(null);
			try {
				let content: string;
				let defaultName: string;
				let ext: string;

				if (type === 'annotations') {
					const result = await window.maestro.vibes.getLog(projectPath, { json: true });
					content = result.data ?? '[]';
					defaultName = 'annotations.jsonl';
					ext = 'jsonl';
				} else if (type === 'manifest') {
					const result = await window.maestro.vibes.getManifest(projectPath);
					content = result.data ?? '{}';
					defaultName = 'manifest.json';
					ext = 'json';
				} else {
					// Generate markdown summary
					const lines = [
						'# VIBES Summary',
						'',
						`- **Annotations:** ${stats?.totalAnnotations ?? 0}`,
						`- **Files Covered:** ${stats?.filesCovered ?? 0} / ${stats?.totalTrackedFiles ?? 0}`,
						`- **Coverage:** ${stats?.coveragePercent ?? 0}%`,
						`- **Active Sessions:** ${stats?.activeSessions ?? 0}`,
						`- **Contributing Models:** ${stats?.contributingModels ?? 0}`,
						`- **Assurance Level:** ${vibesAssuranceLevel}`,
						'',
						'## Models',
						...vibesData.models.map((m) => `- ${m.modelName} (${m.percentage.toFixed(1)}%)`),
					];
					content = lines.join('\n');
					defaultName = 'vibes-summary.md';
					ext = 'md';
				}

				const savePath = await window.maestro.dialog.saveFile({
					title: `Export VIBES ${type}`,
					defaultPath: defaultName,
					filters: [
						{ name: `${ext.toUpperCase()} files`, extensions: [ext] },
						{ name: 'All files', extensions: ['*'] },
					],
				});

				if (savePath) {
					await window.maestro.fs.writeFile(savePath, content);
					setActionStatus({ type: 'success', message: `Exported ${type} successfully` });
				}
			} catch (err) {
				setActionStatus({
					type: 'error',
					message: err instanceof Error ? err.message : `Export ${type} failed`,
				});
			}
		},
		[projectPath, stats, vibesAssuranceLevel, vibesData.models]
	);

	// ========================================================================
	// Status Banner — disabled / not initialized / error states
	// ========================================================================

	if (!vibesEnabled) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Shield className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					VIBES is disabled
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Enable VIBES in Settings to start tracking AI attribution metadata.
				</span>
			</div>
		);
	}

	if (isLoading && !isInitialized && !stats) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					Initializing...
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading VIBES data for this project.
				</span>
			</div>
		);
	}

	if (!isInitialized && !isLoading) {
		return (
			<div className="flex flex-col items-center justify-center gap-4 py-12 px-4 text-center">
				<Shield className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					VIBES not initialized
				</span>
				<span className="text-xs max-w-xs" style={{ color: theme.colors.textDim }}>
					No <code>.ai-audit/</code> directory found for this project. Initialize VIBES to start
					recording AI attribution metadata.
				</span>
				{vibesAutoInit === false && (
					<div
						className="flex items-start gap-2 px-3 py-2.5 rounded text-xs max-w-xs text-left"
						style={{
							backgroundColor: 'rgba(59, 130, 246, 0.1)',
							border: '1px solid rgba(59, 130, 246, 0.3)',
						}}
					>
						<Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: '#3b82f6' }} />
						<span style={{ color: theme.colors.textDim }}>
							Auto-initialization is disabled. Enable it in Settings to automatically set up VIBES
							when opening new projects, or initialize manually below.
						</span>
					</div>
				)}
				<div className="flex items-center gap-2 mt-2">
					<input
						type="text"
						placeholder="Project name"
						value={initProjectName}
						onChange={(e) => setInitProjectName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') handleInitialize();
						}}
						className="px-3 py-1.5 rounded text-xs outline-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							border: `1px solid ${theme.colors.border}`,
							color: theme.colors.textMain,
						}}
					/>
					<button
						onClick={handleInitialize}
						disabled={!initProjectName.trim() || isInitializing}
						className="px-3 py-1.5 rounded text-xs font-medium transition-opacity"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
							opacity: !initProjectName.trim() || isInitializing ? 0.5 : 1,
						}}
					>
						{isInitializing ? 'Initializing...' : 'Initialize'}
					</button>
				</div>
				{actionStatus && (
					<StatusMessage
						theme={theme}
						status={actionStatus}
						onDismiss={() => setActionStatus(null)}
					/>
				)}
			</div>
		);
	}

	// ========================================================================
	// Main Dashboard
	// ========================================================================

	const effectiveLevel = stats?.assuranceLevel ?? vibesAssuranceLevel;
	const assurance = ASSURANCE_COLORS[effectiveLevel];

	return (
		<div className="flex flex-col gap-4 py-3">
			{/* Status Banner */}
			<div
				className="flex items-center gap-2 px-3 py-2 rounded text-xs"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
				<span style={{ color: theme.colors.textMain }}>VIBES is active</span>
				<span style={{ color: theme.colors.textDim }}>—</span>
				<div className="flex items-center gap-0.5 ml-1">
					{(['low', 'medium', 'high'] as VibesAssuranceLevel[]).map((level) => {
						const colors = ASSURANCE_COLORS[level];
						const isActive = effectiveLevel === level;
						return (
							<button
								key={level}
								onClick={() => onAssuranceLevelChange?.(level)}
								className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase transition-colors"
								style={{
									backgroundColor: isActive ? colors.bg : 'transparent',
									color: isActive ? colors.text : theme.colors.textDim,
									opacity: isActive ? 1 : 0.6,
								}}
								title={`Set assurance level to ${colors.label}`}
							>
								{colors.label}
							</button>
						);
					})}
				</div>
				<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
					assurance level
				</span>
			</div>

			{/* Error Banner */}
			{error && (
				<div
					className="flex items-center gap-2 px-3 py-2 rounded text-xs"
					style={{
						backgroundColor: 'rgba(239, 68, 68, 0.1)',
						border: '1px solid rgba(239, 68, 68, 0.3)',
					}}
				>
					<AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.error }} />
					<span style={{ color: theme.colors.error }}>{error}</span>
				</div>
			)}

			{/* Stats Cards */}
			<div className="grid grid-cols-2 gap-2">
				<StatsCard
					theme={theme}
					icon={<FileText className="w-4 h-4" />}
					label="Annotations"
					value={stats?.totalAnnotations ?? 0}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<FolderOpen className="w-4 h-4" />}
					label="Coverage"
					value={stats ? `${stats.filesCovered}/${stats.totalTrackedFiles}` : '0/0'}
					subtitle={
						stats && stats.totalTrackedFiles > 0
							? `${stats.coveragePercent.toFixed(0)}%`
							: undefined
					}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<Activity className="w-4 h-4" />}
					label="Sessions"
					value={stats?.activeSessions || sessions.length || 0}
					isLoading={isLoading}
				/>
				<StatsCard
					theme={theme}
					icon={<Cpu className="w-4 h-4" />}
					label="Models"
					value={stats?.contributingModels || models.length || 0}
					isLoading={isLoading}
				/>
			</div>

			{/* Activity Timeline */}
			{!isLoading && isInitialized && (
				<div className="flex flex-col gap-1.5" data-testid="activity-timeline">
					<div className="flex items-center justify-between">
						<span
							className="text-[10px] font-semibold uppercase tracking-wider"
							style={{ color: theme.colors.textDim }}
						>
							Activity Timeline
						</span>
						<div className="flex items-center gap-0.5">
							{TIMELINE_RANGES.map((range) => (
								<button
									key={range.days}
									onClick={() => setTimelineRange(range.days)}
									className="px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors"
									style={{
										backgroundColor:
											timelineRange === range.days ? theme.colors.accent + '22' : 'transparent',
										color:
											timelineRange === range.days ? theme.colors.accent : theme.colors.textDim,
										opacity: timelineRange === range.days ? 1 : 0.6,
									}}
								>
									{range.label}
								</button>
							))}
						</div>
					</div>
					{timeline.buckets.length > 0 ? (
						<div className="flex items-end gap-px" style={{ height: 100 }}>
							{timeline.buckets.map((bucket, i) => (
								<div
									key={i}
									className="flex-1 flex flex-col justify-end"
									style={{ height: '100%' }}
									title={`${bucket.label}: ${bucket.total} annotations`}
								>
									{(['create', 'modify', 'review', 'delete'] as VibesAction[]).map((action) =>
										bucket.counts[action] > 0 ? (
											<div
												key={action}
												data-testid={`bar-${action}`}
												style={{
													height: `${(bucket.counts[action] / timeline.maxCount) * 100}%`,
													backgroundColor: ACTION_COLORS[action],
													minHeight: 2,
												}}
											/>
										) : null
									)}
								</div>
							))}
						</div>
					) : (
						<span className="text-[10px] py-4 text-center" style={{ color: theme.colors.textDim }}>
							No activity yet
						</span>
					)}
					{timeline.buckets.length > 0 && (
						<div
							className="flex justify-between text-[9px]"
							style={{ color: theme.colors.textDim }}
						>
							<span>{timeline.buckets[0]?.label}</span>
							<span>{timeline.buckets[timeline.buckets.length - 1]?.label}</span>
						</div>
					)}
					{/* Action legend */}
					{timeline.buckets.length > 0 && (
						<div className="flex items-center gap-3 text-[9px]" data-testid="timeline-legend">
							{Object.entries(ACTION_COLORS).map(([action, color]) => (
								<span key={action} className="flex items-center gap-1">
									<span
										className="inline-block w-2 h-2 rounded-sm"
										style={{ backgroundColor: color }}
									/>
									{action}
								</span>
							))}
						</div>
					)}
				</div>
			)}

			{/* Model Contribution Donut */}
			{!isLoading && isInitialized && vibesData.models.length > 0 && (
				<div className="flex flex-col gap-1.5" data-testid="model-donut-section">
					<span
						className="text-[10px] font-semibold uppercase tracking-wider"
						style={{ color: theme.colors.textDim }}
					>
						Model Contributions
					</span>
					<div className="flex items-center gap-3">
						<div
							className="relative shrink-0"
							style={{ width: 64, height: 64 }}
							data-testid="model-donut"
						>
							<svg viewBox="0 0 36 36" width="64" height="64">
								<circle
									cx="18"
									cy="18"
									r="14"
									fill="none"
									stroke={theme.colors.bgActivity}
									strokeWidth="4"
								/>
								{(() => {
									let offset = 25; // start at 12 o'clock (25% offset on a 100-unit circle)
									return vibesData.models.map((model, i) => {
										const pct = model.percentage;
										const dashLen = pct * 0.8796; // circumference = 2*PI*14 ≈ 87.96
										const el = (
											<circle
												key={model.modelName}
												cx="18"
												cy="18"
												r="14"
												fill="none"
												stroke={MODEL_PALETTE[i % MODEL_PALETTE.length]}
												strokeWidth="4"
												strokeDasharray={`${dashLen} ${87.96 - dashLen}`}
												strokeDashoffset={-offset * 0.8796}
												data-testid={`model-segment-${i}`}
											/>
										);
										offset += pct;
										return el;
									});
								})()}
							</svg>
							<div className="absolute inset-0 flex items-center justify-center">
								<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
									{vibesData.models.length}
								</span>
							</div>
						</div>
						<div className="flex flex-col gap-0.5 text-[10px]" data-testid="model-legend">
							{vibesData.models.map((model, i) => (
								<span key={model.modelName} className="flex items-center gap-1.5">
									<span
										className="inline-block w-2 h-2 rounded-full shrink-0"
										style={{ backgroundColor: MODEL_PALETTE[i % MODEL_PALETTE.length] }}
									/>
									<span style={{ color: theme.colors.textMain }}>{model.modelName}</span>
									<span style={{ color: theme.colors.textDim }}>{model.percentage}%</span>
								</span>
							))}
						</div>
					</div>
				</div>
			)}

			{/* Assurance Level Distribution */}
			{!isLoading && isInitialized && assuranceTotal > 0 && (
				<div className="flex flex-col gap-1.5" data-testid="assurance-distribution">
					<span
						className="text-[10px] font-semibold uppercase tracking-wider"
						style={{ color: theme.colors.textDim }}
					>
						Assurance Distribution
					</span>
					<div
						className="flex h-3 rounded overflow-hidden"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						{assuranceDist.low > 0 && (
							<div
								data-testid="assurance-bar-low"
								style={{
									width: `${(assuranceDist.low / assuranceTotal) * 100}%`,
									backgroundColor: ASSURANCE_BAR_COLORS.low,
								}}
							/>
						)}
						{assuranceDist.medium > 0 && (
							<div
								data-testid="assurance-bar-medium"
								style={{
									width: `${(assuranceDist.medium / assuranceTotal) * 100}%`,
									backgroundColor: ASSURANCE_BAR_COLORS.medium,
								}}
							/>
						)}
						{assuranceDist.high > 0 && (
							<div
								data-testid="assurance-bar-high"
								style={{
									width: `${(assuranceDist.high / assuranceTotal) * 100}%`,
									backgroundColor: ASSURANCE_BAR_COLORS.high,
								}}
							/>
						)}
					</div>
					<div className="flex items-center gap-3 text-[10px]" data-testid="assurance-legend">
						{assuranceDist.low > 0 && (
							<span className="flex items-center gap-1">
								<span
									className="inline-block w-2 h-2 rounded-full"
									style={{ backgroundColor: ASSURANCE_BAR_COLORS.low }}
								/>
								Low: {assuranceDist.low}
							</span>
						)}
						{assuranceDist.medium > 0 && (
							<span className="flex items-center gap-1">
								<span
									className="inline-block w-2 h-2 rounded-full"
									style={{ backgroundColor: ASSURANCE_BAR_COLORS.medium }}
								/>
								Medium: {assuranceDist.medium}
							</span>
						)}
						{assuranceDist.high > 0 && (
							<span className="flex items-center gap-1">
								<span
									className="inline-block w-2 h-2 rounded-full"
									style={{ backgroundColor: ASSURANCE_BAR_COLORS.high }}
								/>
								High: {assuranceDist.high}
							</span>
						)}
					</div>
				</div>
			)}

			{/* Quick Actions */}
			<div className="flex flex-col gap-1.5">
				<span
					className="text-[10px] font-semibold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Quick Actions
				</span>
				<div className="flex gap-2">
					<ActionButton
						theme={theme}
						icon={<Database className="w-3.5 h-3.5" />}
						label="Build Database"
						onClick={handleBuildDatabase}
						disabled={binaryAvailable === false}
						title={binaryAvailable === false ? 'Requires vibecheck' : undefined}
					/>
					<ActionButton
						theme={theme}
						icon={<FileBarChart className="w-3.5 h-3.5" />}
						label="Generate Report"
						onClick={handleGenerateReport}
						disabled={binaryAvailable === false}
						title={binaryAvailable === false ? 'Requires vibecheck' : undefined}
					/>
					<ActionButton
						theme={theme}
						icon={<RefreshCw className="w-3.5 h-3.5" />}
						label="Refresh"
						onClick={refresh}
					/>
					<div className="relative">
						<ActionButton
							theme={theme}
							icon={<Download className="w-3.5 h-3.5" />}
							label="Export"
							onClick={() => setShowExportMenu((prev) => !prev)}
						/>
						{showExportMenu && (
							<div
								className="absolute top-full left-0 mt-1 z-20 rounded shadow-lg text-xs min-w-[160px]"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
								}}
								data-testid="export-dropdown"
							>
								<button
									onClick={() => handleExport('annotations')}
									className="block w-full text-left px-3 py-1.5 transition-opacity hover:opacity-80"
									style={{ color: theme.colors.textMain }}
								>
									Annotations (JSONL)
								</button>
								<button
									onClick={() => handleExport('manifest')}
									className="block w-full text-left px-3 py-1.5 transition-opacity hover:opacity-80"
									style={{ color: theme.colors.textMain }}
								>
									Manifest (JSON)
								</button>
								<button
									onClick={() => handleExport('summary')}
									className="block w-full text-left px-3 py-1.5 transition-opacity hover:opacity-80"
									style={{ color: theme.colors.textMain }}
								>
									Summary (Markdown)
								</button>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Live Monitor */}
			<VibesLiveMonitor theme={theme} projectPath={projectPath} />

			{/* Action Status */}
			{actionStatus && (
				<StatusMessage
					theme={theme}
					status={actionStatus}
					onDismiss={() => setActionStatus(null)}
				/>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface StatsCardProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	value: number | string;
	subtitle?: string;
	isLoading: boolean;
}

const StatsCard: React.FC<StatsCardProps> = ({
	theme,
	icon,
	label,
	value,
	subtitle,
	isLoading,
}) => (
	<div
		className="flex flex-col gap-1 px-3 py-2.5 rounded"
		style={{
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
		}}
	>
		<div className="flex items-center gap-1.5">
			<span style={{ color: theme.colors.textDim }}>{icon}</span>
			<span
				className="text-[10px] uppercase tracking-wider font-medium"
				style={{ color: theme.colors.textDim }}
			>
				{label}
			</span>
		</div>
		<div className="flex items-baseline gap-1.5">
			<span
				className="text-lg font-bold tabular-nums"
				style={{ color: isLoading ? theme.colors.textDim : theme.colors.textMain }}
			>
				{isLoading ? '—' : value}
			</span>
			{subtitle && (
				<span className="text-[10px]" style={{ color: theme.colors.accent }}>
					{subtitle}
				</span>
			)}
		</div>
	</div>
);

interface ActionButtonProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	title?: string;
}

const ActionButton: React.FC<ActionButtonProps> = ({
	theme,
	icon,
	label,
	onClick,
	disabled,
	title,
}) => (
	<button
		onClick={disabled ? undefined : onClick}
		disabled={disabled}
		title={title}
		className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors hover:opacity-80"
		style={{
			backgroundColor: theme.colors.bgActivity,
			border: `1px solid ${theme.colors.border}`,
			color: theme.colors.textMain,
			opacity: disabled ? 0.5 : 1,
			cursor: disabled ? 'not-allowed' : 'pointer',
		}}
	>
		{icon}
		{label}
	</button>
);

interface StatusMessageProps {
	theme: Theme;
	status: { type: 'success' | 'error'; message: string };
	onDismiss: () => void;
}

const StatusMessage: React.FC<StatusMessageProps> = ({ theme, status, onDismiss }) => (
	<div
		className="flex items-center gap-2 px-3 py-2 rounded text-xs cursor-pointer"
		onClick={onDismiss}
		style={{
			backgroundColor:
				status.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
			border: `1px solid ${
				status.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'
			}`,
		}}
	>
		{status.type === 'success' ? (
			<CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.success }} />
		) : (
			<AlertCircle className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.error }} />
		)}
		<span
			style={{
				color: status.type === 'success' ? theme.colors.success : theme.colors.error,
			}}
		>
			{status.message}
		</span>
		<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
			click to dismiss
		</span>
	</div>
);
