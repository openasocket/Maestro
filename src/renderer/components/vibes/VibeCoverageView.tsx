import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
	BarChart3,
	FileCheck,
	FileX,
	FileMinus,
	Filter,
	ArrowUpDown,
	AlertTriangle,
	Database,
	Loader2,
	FolderOpen,
	ChevronRight,
	ChevronDown,
	FolderTree,
	Files,
	Code,
} from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

/** A single file entry from `vibecheck coverage --json`. */
interface CoverageFileEntry {
	file_path?: string;
	file?: string;
	path?: string;
	coverage_status?: 'full' | 'partial' | 'uncovered';
	status?: 'full' | 'partial' | 'uncovered';
	annotation_count?: number;
	annotations?: number;
	count?: number;
}

/** Normalized coverage file data for display. */
interface NormalizedCoverageFile {
	filePath: string;
	status: 'full' | 'partial' | 'uncovered';
	annotationCount: number;
}

/** Props for the VibeCoverageView component. */
interface VibeCoverageViewProps {
	theme: Theme;
	projectPath: string | undefined;
	/** Whether the vibecheck binary is available. When false, shows a targeted message. */
	binaryAvailable?: boolean | null;
}

type FilterMode = 'all' | 'covered' | 'uncovered';
type SortMode = 'status' | 'path' | 'annotations';
type ViewMode = 'files' | 'directories' | 'lines';

/** Directory-level grouping for the tree view. */
interface DirectoryGroup {
	dirPath: string;
	files: NormalizedCoverageFile[];
	covered: number;
	partial: number;
	uncovered: number;
	totalAnnotations: number;
	coveragePercent: number;
}

// ============================================================================
// Constants
// ============================================================================

const STATUS_CONFIG: Record<string, { label: string; color: string; sortOrder: number }> = {
	full: { label: 'Covered', color: '#22c55e', sortOrder: 0 },
	partial: { label: 'Partial', color: '#eab308', sortOrder: 1 },
	uncovered: { label: 'Uncovered', color: '#6b7280', sortOrder: 2 },
};

const FILTER_OPTIONS: { value: FilterMode; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'covered', label: 'Covered' },
	{ value: 'uncovered', label: 'Uncovered' },
];

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
	{ value: 'status', label: 'Status' },
	{ value: 'path', label: 'Path' },
	{ value: 'annotations', label: 'Annotations' },
];

// ============================================================================
// Helpers
// ============================================================================

/** Normalize the raw coverage file entries into a consistent shape. */
function normalizeCoverageData(raw: string | undefined): NormalizedCoverageFile[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);

		// vibecheck CLI format: { uncovered_files: string[], partial_files: [{file_path, ...}], ... }
		if (data.uncovered_files || data.partial_files) {
			const results: NormalizedCoverageFile[] = [];

			// Partial files — have annotations but not full coverage
			if (Array.isArray(data.partial_files)) {
				for (const pf of data.partial_files) {
					results.push({
						filePath: pf.file_path ?? pf.path ?? 'unknown',
						status: 'partial',
						annotationCount: pf.annotated_lines ?? pf.annotation_count ?? 1,
					});
				}
			}

			// Uncovered files — no annotations at all
			if (Array.isArray(data.uncovered_files)) {
				for (const fp of data.uncovered_files) {
					results.push({
						filePath: typeof fp === 'string' ? fp : (fp.file_path ?? fp.path ?? 'unknown'),
						status: 'uncovered',
						annotationCount: 0,
					});
				}
			}

			// Covered files — if present (some vibecheck versions may include them)
			if (Array.isArray(data.covered_files)) {
				for (const cf of data.covered_files) {
					results.push({
						filePath: typeof cf === 'string' ? cf : (cf.file_path ?? cf.path ?? 'unknown'),
						status: 'full',
						annotationCount: cf.annotation_count ?? cf.annotated_lines ?? 1,
					});
				}
			}

			return results;
		}

		// Fallback array format (from computeCoverageFromAnnotations or generic arrays)
		let entries: CoverageFileEntry[] = [];

		if (Array.isArray(data)) {
			entries = data;
		} else if (data.files && Array.isArray(data.files)) {
			entries = data.files;
		} else if (data.coverage && Array.isArray(data.coverage)) {
			entries = data.coverage;
		}

		return entries.map((entry) => ({
			filePath: entry.file_path ?? entry.file ?? entry.path ?? 'unknown',
			status: entry.coverage_status ?? entry.status ?? 'uncovered',
			annotationCount: entry.annotation_count ?? entry.annotations ?? entry.count ?? 0,
		}));
	} catch {
		return [];
	}
}

/** Group files by parent directory (first 2 path segments). */
function groupByDirectory(files: NormalizedCoverageFile[]): DirectoryGroup[] {
	const groups = new Map<string, NormalizedCoverageFile[]>();

	for (const file of files) {
		const parts = file.filePath.split('/');
		const dirPath = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0] ?? '.';
		const existing = groups.get(dirPath);
		if (existing) {
			existing.push(file);
		} else {
			groups.set(dirPath, [file]);
		}
	}

	return [...groups.entries()]
		.map(([dirPath, dirFiles]) => {
			const covered = dirFiles.filter((f) => f.status === 'full').length;
			const partial = dirFiles.filter((f) => f.status === 'partial').length;
			const uncovered = dirFiles.filter((f) => f.status === 'uncovered').length;
			const total = dirFiles.length;
			return {
				dirPath,
				files: dirFiles,
				covered,
				partial,
				uncovered,
				totalAnnotations: dirFiles.reduce((sum, f) => sum + f.annotationCount, 0),
				coveragePercent: total > 0 ? Math.round(((covered + partial * 0.5) / total) * 100) : 0,
			};
		})
		.sort((a, b) => b.coveragePercent - a.coveragePercent);
}

/** File extension stats for the distribution chart. */
interface ExtensionStats {
	ext: string;
	covered: number;
	partial: number;
	uncovered: number;
	total: number;
}

/** Group files by extension for the file-type distribution chart. */
function groupByExtension(files: NormalizedCoverageFile[]): ExtensionStats[] {
	const groups = new Map<string, { covered: number; partial: number; uncovered: number }>();

	for (const file of files) {
		const lastDot = file.filePath.lastIndexOf('.');
		const ext = lastDot >= 0 ? file.filePath.substring(lastDot) : 'other';
		const existing = groups.get(ext) ?? { covered: 0, partial: 0, uncovered: 0 };
		if (file.status === 'full') existing.covered++;
		else if (file.status === 'partial') existing.partial++;
		else existing.uncovered++;
		groups.set(ext, existing);
	}

	const stats = [...groups.entries()]
		.map(([ext, counts]) => ({
			ext,
			...counts,
			total: counts.covered + counts.partial + counts.uncovered,
		}))
		.sort((a, b) => b.total - a.total);

	// Limit to top 8 extensions; collapse rest into "Other"
	if (stats.length > 8) {
		const top = stats.slice(0, 8);
		const rest = stats.slice(8);
		const other = rest.reduce(
			(acc, s) => ({
				ext: 'Other',
				covered: acc.covered + s.covered,
				partial: acc.partial + s.partial,
				uncovered: acc.uncovered + s.uncovered,
				total: acc.total + s.total,
			}),
			{ ext: 'Other', covered: 0, partial: 0, uncovered: 0, total: 0 },
		);
		top.push(other);
		return top;
	}

	return stats;
}

/** Calculate coverage summary statistics. */
function calculateSummary(files: NormalizedCoverageFile[]) {
	const total = files.length;
	const covered = files.filter((f) => f.status === 'full').length;
	const partial = files.filter((f) => f.status === 'partial').length;
	const uncovered = files.filter((f) => f.status === 'uncovered').length;
	const percentage = total > 0 ? Math.round(((covered + partial * 0.5) / total) * 100) : 0;
	const totalAnnotations = files.reduce((sum, f) => sum + f.annotationCount, 0);

	return { total, covered, partial, uncovered, percentage, totalAnnotations };
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Coverage View — shows which files in the project have AI
 * annotation coverage and which don't.
 *
 * Features:
 * - Coverage summary bar with overall percentage
 * - File list with coverage status, annotation count, color indicator
 * - Filter options (All / Covered / Uncovered)
 * - Sort options (Status / Path / Annotations)
 */
export const VibeCoverageView: React.FC<VibeCoverageViewProps> = ({
	theme,
	projectPath,
	binaryAvailable,
}) => {
	const [files, setFiles] = useState<NormalizedCoverageFile[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [needsBuild, setNeedsBuild] = useState(false);
	const [isBuilding, setIsBuilding] = useState(false);
	const [filter, setFilter] = useState<FilterMode>('all');
	const [sort, setSort] = useState<SortMode>('status');
	const [viewMode, setViewMode] = useState<ViewMode>('files');
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [locData, setLocData] = useState<{
		totalLines: number;
		annotatedLines: number;
		coveragePercent: number;
		files: Array<{
			file_path: string;
			total_lines: number;
			annotated_lines: number;
			coverage_percent: number;
		}>;
	} | null>(null);

	// ========================================================================
	// Fetch coverage data
	// ========================================================================

	const fetchCoverage = useCallback(async () => {
		if (!projectPath) return;

		setIsLoading(true);
		setError(null);
		setNeedsBuild(false);

		try {
			const result = await window.maestro.vibes.getCoverage(projectPath);
			if (result.success && result.data) {
				const normalized = normalizeCoverageData(result.data);
				setFiles(normalized);
			} else {
				const errMsg = result.error ?? 'Failed to fetch coverage data';
				if (
					errMsg.toLowerCase().includes('build') ||
					errMsg.toLowerCase().includes('database') ||
					errMsg.toLowerCase().includes('audit.db')
				) {
					setNeedsBuild(true);
				} else {
					setError(errMsg);
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to fetch coverage data');
		} finally {
			setIsLoading(false);
		}
	}, [projectPath]);

	const fetchLocCoverage = useCallback(async () => {
		if (!projectPath) return;
		try {
			const result = await window.maestro.vibes.getLocCoverage(projectPath);
			if (result.success && result.data) {
				setLocData(JSON.parse(result.data));
			}
		} catch {
			// LOC data is supplementary; don't show errors for it
		}
	}, [projectPath]);

	useEffect(() => {
		fetchCoverage();
		fetchLocCoverage();
	}, [fetchCoverage, fetchLocCoverage]);

	// ========================================================================
	// Build Now handler
	// ========================================================================

	const handleBuild = useCallback(async () => {
		if (!projectPath) return;
		setIsBuilding(true);
		try {
			const result = await window.maestro.vibes.build(projectPath);
			if (result.success) {
				setNeedsBuild(false);
				fetchCoverage();
			} else {
				setError(result.error ?? 'Build failed');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Build failed');
		} finally {
			setIsBuilding(false);
		}
	}, [projectPath, fetchCoverage]);

	// ========================================================================
	// Summary stats
	// ========================================================================

	const summary = useMemo(() => calculateSummary(files), [files]);
	const directoryGroups = useMemo(() => groupByDirectory(files), [files]);
	const extensionStats = useMemo(() => groupByExtension(files), [files]);

	const toggleDirectory = useCallback((dirPath: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dirPath)) next.delete(dirPath);
			else next.add(dirPath);
			return next;
		});
	}, []);

	// ========================================================================
	// Filtered + sorted file list
	// ========================================================================

	const displayedFiles = useMemo(() => {
		let filtered = files;

		if (filter === 'covered') {
			filtered = files.filter((f) => f.status === 'full' || f.status === 'partial');
		} else if (filter === 'uncovered') {
			filtered = files.filter((f) => f.status === 'uncovered');
		}

		const sorted = [...filtered];
		if (sort === 'status') {
			sorted.sort((a, b) => {
				const aOrder = STATUS_CONFIG[a.status]?.sortOrder ?? 9;
				const bOrder = STATUS_CONFIG[b.status]?.sortOrder ?? 9;
				return aOrder - bOrder || a.filePath.localeCompare(b.filePath);
			});
		} else if (sort === 'path') {
			sorted.sort((a, b) => a.filePath.localeCompare(b.filePath));
		} else if (sort === 'annotations') {
			sorted.sort((a, b) => b.annotationCount - a.annotationCount || a.filePath.localeCompare(b.filePath));
		}

		return sorted;
	}, [files, filter, sort]);

	// ========================================================================
	// Render
	// ========================================================================

	return (
		<div className="flex flex-col h-full">
			{/* Header — summary + controls */}
			<div
				className="sticky top-0 z-10 flex flex-col gap-3 px-3 py-3"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{/* Coverage donut chart + summary stats (hidden in LOC view which has its own) */}
				{!isLoading && !error && !needsBuild && files.length > 0 && viewMode !== 'lines' && (
					<div className="flex flex-col gap-3">
						<div className="flex items-start gap-4">
							{/* Donut chart */}
							<CoverageDonut
								covered={summary.covered}
								partial={summary.partial}
								uncovered={summary.uncovered}
								percentage={summary.percentage}
							/>

							{/* Stats list */}
							<div className="flex flex-col gap-1.5 pt-1">
								<div className="flex items-center gap-2">
									<BarChart3 className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
									<span className="text-[11px] font-semibold" style={{ color: theme.colors.textDim }}>
										Coverage
									</span>
								</div>
								<div className="flex flex-col gap-1 text-[10px]" style={{ color: theme.colors.textDim }}>
									<span>{summary.total} total files</span>
									<span style={{ color: STATUS_CONFIG.full.color }}>{summary.covered} covered</span>
									<span style={{ color: STATUS_CONFIG.partial.color }}>{summary.partial} partial</span>
									<span>{summary.uncovered} uncovered</span>
									<span>{summary.totalAnnotations} annotations</span>
								</div>
							</div>
						</div>

						{/* Legend */}
						<div className="flex items-center gap-4 text-[10px]" data-testid="coverage-legend">
							<span className="flex items-center gap-1">
								<span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_CONFIG.full.color }} />
								AI Code ({summary.covered})
							</span>
							<span className="flex items-center gap-1">
								<span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_CONFIG.partial.color }} />
								Partial ({summary.partial})
							</span>
							<span className="flex items-center gap-1">
								<span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: '#6b7280' }} />
								Unknown ({summary.uncovered})
							</span>
						</div>

						{/* File-type distribution bars */}
						{extensionStats.length > 0 && (
							<div className="flex flex-col gap-1" data-testid="extension-distribution">
								<span className="text-[10px] font-semibold" style={{ color: theme.colors.textDim }}>
									By File Type
								</span>
								{extensionStats.map((ext) => (
									<div key={ext.ext} className="flex items-center gap-2 text-[10px]">
										<span className="w-10 shrink-0 font-mono text-right" style={{ color: theme.colors.textDim }}>
											{ext.ext}
										</span>
										<div className="flex-1 flex h-3 rounded overflow-hidden" style={{ backgroundColor: theme.colors.bgActivity }}>
											{ext.covered > 0 && (
												<div
													style={{
														width: `${(ext.covered / ext.total) * 100}%`,
														backgroundColor: STATUS_CONFIG.full.color,
													}}
												/>
											)}
											{ext.partial > 0 && (
												<div
													style={{
														width: `${(ext.partial / ext.total) * 100}%`,
														backgroundColor: STATUS_CONFIG.partial.color,
													}}
												/>
											)}
											{ext.uncovered > 0 && (
												<div
													style={{
														width: `${(ext.uncovered / ext.total) * 100}%`,
														backgroundColor: '#6b7280',
													}}
												/>
											)}
										</div>
										<span className="w-6 shrink-0 text-right tabular-nums" style={{ color: theme.colors.textDim }}>
											{ext.total}
										</span>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* Filter + sort + view controls */}
				{!isLoading && !error && !needsBuild && files.length > 0 && (
					<div className="flex items-center gap-3">
						{/* Filter */}
						<div className="flex items-center gap-1.5">
							<Filter className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<div className="flex items-center gap-0.5">
								{FILTER_OPTIONS.map((opt) => (
									<button
										key={opt.value}
										onClick={() => setFilter(opt.value)}
										className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
										style={{
											backgroundColor: filter === opt.value ? theme.colors.accentDim : 'transparent',
											color: filter === opt.value ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>

						{/* View mode toggle */}
						<div className="flex items-center gap-0.5">
							<button
								onClick={() => setViewMode('files')}
								className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1"
								style={{
									backgroundColor: viewMode === 'files' ? theme.colors.accentDim : 'transparent',
									color: viewMode === 'files' ? theme.colors.accent : theme.colors.textDim,
								}}
								data-testid="view-files-btn"
							>
								<Files className="w-3 h-3" />
								Files
							</button>
							<button
								onClick={() => setViewMode('directories')}
								className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1"
								style={{
									backgroundColor: viewMode === 'directories' ? theme.colors.accentDim : 'transparent',
									color: viewMode === 'directories' ? theme.colors.accent : theme.colors.textDim,
								}}
								data-testid="view-dirs-btn"
							>
								<FolderTree className="w-3 h-3" />
								Directories
							</button>
							<button
								onClick={() => setViewMode('lines')}
								className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors flex items-center gap-1"
								style={{
									backgroundColor: viewMode === 'lines' ? theme.colors.accentDim : 'transparent',
									color: viewMode === 'lines' ? theme.colors.accent : theme.colors.textDim,
								}}
								data-testid="view-lines-btn"
							>
								<Code className="w-3 h-3" />
								Lines
							</button>
						</div>

						{/* Sort */}
						<div className="flex items-center gap-1.5 ml-auto">
							<ArrowUpDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<div className="flex items-center gap-0.5">
								{SORT_OPTIONS.map((opt) => (
									<button
										key={opt.value}
										onClick={() => setSort(opt.value)}
										className="px-2 py-0.5 rounded text-[10px] font-medium transition-colors"
										style={{
											backgroundColor: sort === opt.value ? theme.colors.accentDim : 'transparent',
											color: sort === opt.value ? theme.colors.accent : theme.colors.textDim,
										}}
									>
										{opt.label}
									</button>
								))}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Content area */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{/* Loading */}
				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading coverage data...
						</span>
					</div>
				)}

				{/* Build Required notice */}
				{!isLoading && needsBuild && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Database className="w-6 h-6 opacity-60" style={{ color: theme.colors.warning }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							Build Required
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							The audit database needs to be built before viewing coverage data.
						</span>
						<button
							onClick={handleBuild}
							disabled={isBuilding}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-opacity hover:opacity-80 mt-1"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
								opacity: isBuilding ? 0.6 : 1,
							}}
						>
							<Database className="w-3.5 h-3.5" />
							{isBuilding ? 'Building...' : 'Build Now'}
						</button>
					</div>
				)}

				{/* Error */}
				{!isLoading && error && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<AlertTriangle className="w-6 h-6 opacity-60" style={{ color: theme.colors.error }} />
						<span className="text-xs" style={{ color: theme.colors.error }}>
							{error}
						</span>
					</div>
				)}

				{/* Empty state — no tracked files / no coverage data */}
				{!isLoading && !error && !needsBuild && files.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<FolderOpen className="w-6 h-6 opacity-40" style={{ color: theme.colors.textDim }} />
						<span
							className="text-sm font-medium"
							style={{ color: theme.colors.textMain }}
						>
							No tracked files
						</span>
						<span
							className="text-xs max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							This project has no AI annotation coverage data. This may occur if no files match the configured tracked extensions, or if no annotations have been recorded yet.
						</span>
						<span
							className="text-[10px] max-w-xs"
							style={{ color: theme.colors.textDim }}
						>
							Check that your <code className="font-mono">tracked_extensions</code> are configured in{' '}
							<code className="font-mono">.ai-audit/config.json</code> — for example:{' '}
							<code className="font-mono">[".ts", ".tsx", ".js", ".py"]</code>
						</span>
					</div>
				)}

				{/* File list (flat view) */}
				{!isLoading && !error && !needsBuild && displayedFiles.length > 0 && viewMode === 'files' && (
					<div className="flex flex-col">
						{displayedFiles.map((file) => (
							<CoverageFileRow
								key={file.filePath}
								theme={theme}
								file={file}
							/>
						))}
					</div>
				)}

				{/* Directory view */}
				{!isLoading && !error && !needsBuild && files.length > 0 && viewMode === 'directories' && (
					<div className="flex flex-col" data-testid="directory-view">
						{directoryGroups.map((dir) => (
							<div key={dir.dirPath}>
								<button
									onClick={() => toggleDirectory(dir.dirPath)}
									className="flex items-center gap-2 w-full px-3 py-2 border-b text-xs hover:opacity-80 transition-opacity"
									style={{ borderColor: theme.colors.border }}
									data-testid={`dir-row-${dir.dirPath}`}
								>
									{expandedDirs.has(dir.dirPath) ? (
										<ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
									) : (
										<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
									)}
									<span className="font-semibold" style={{ color: theme.colors.textMain }}>
										{dir.dirPath}/
									</span>
									{/* Mini progress bar */}
									<div className="flex-1 flex h-1.5 rounded overflow-hidden mx-2" style={{ backgroundColor: theme.colors.bgActivity }}>
										{dir.covered > 0 && (
											<div style={{ width: `${(dir.covered / dir.files.length) * 100}%`, backgroundColor: STATUS_CONFIG.full.color }} />
										)}
										{dir.partial > 0 && (
											<div style={{ width: `${(dir.partial / dir.files.length) * 100}%`, backgroundColor: STATUS_CONFIG.partial.color }} />
										)}
									</div>
									<span className="text-[10px] tabular-nums shrink-0" style={{ color: theme.colors.textDim }}>
										{dir.coveragePercent}%
									</span>
									<span className="text-[10px] shrink-0 px-1.5 py-0.5 rounded" style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}>
										{dir.files.length} files
									</span>
								</button>
								{expandedDirs.has(dir.dirPath) && dir.files.map((file) => (
									<div key={file.filePath} className="pl-6">
										<CoverageFileRow theme={theme} file={file} />
									</div>
								))}
							</div>
						))}
					</div>
				)}

				{/* LOC (Lines of Code) view */}
				{!isLoading && !error && !needsBuild && viewMode === 'lines' && locData && (
					<div className="flex flex-col" data-testid="loc-view">
						{/* LOC summary header */}
						<div className="flex items-start gap-4 px-3 py-3">
							<CoverageDonut
								covered={locData.annotatedLines}
								partial={0}
								uncovered={locData.totalLines - locData.annotatedLines}
								percentage={locData.coveragePercent}
							/>
							<div className="flex flex-col gap-1.5 pt-1">
								<div className="flex items-center gap-2">
									<Code className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
									<span className="text-[11px] font-semibold" style={{ color: theme.colors.textDim }}>
										LOC Coverage
									</span>
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									{locData.annotatedLines.toLocaleString()} of {locData.totalLines.toLocaleString()} lines covered ({locData.coveragePercent}%)
								</div>
							</div>
						</div>

						{/* Per-file breakdown */}
						{locData.files.map((file) => {
							const rowColor = file.coverage_percent > 80
								? STATUS_CONFIG.full.color
								: file.coverage_percent >= 20
									? STATUS_CONFIG.partial.color
									: '#6b7280';
							return (
								<div
									key={file.file_path}
									className="flex items-center gap-2 px-3 py-2 border-b text-xs"
									style={{ borderColor: theme.colors.border }}
								>
									<div
										className="w-2 h-2 rounded-full shrink-0"
										style={{ backgroundColor: rowColor }}
									/>
									<span
										className="flex-1 min-w-0 truncate font-mono text-[11px]"
										style={{ color: theme.colors.textMain }}
										title={file.file_path}
									>
										{file.file_path}
									</span>
									<span
										className="shrink-0 tabular-nums text-[10px]"
										style={{ color: theme.colors.textDim }}
									>
										{file.annotated_lines}/{file.total_lines}
									</span>
									<span
										className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 min-w-[3ch] text-right"
										style={{
											backgroundColor: `${rowColor}20`,
											color: rowColor,
										}}
									>
										{file.coverage_percent}%
									</span>
								</div>
							);
						})}
					</div>
				)}

				{/* LOC view — no data */}
				{!isLoading && !error && !needsBuild && viewMode === 'lines' && !locData && (
					<div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							No LOC coverage data available.
						</span>
					</div>
				)}

				{/* No results for current filter */}
				{!isLoading && !error && !needsBuild && files.length > 0 && displayedFiles.length === 0 && (
					<div className="flex flex-col items-center justify-center gap-2 py-8 px-4 text-center">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							No files match the current filter.
						</span>
					</div>
				)}
			</div>

			{/* Footer */}
			{!isLoading && (files.length > 0 || (viewMode === 'lines' && locData)) && (
				<div
					className="flex items-center justify-between px-3 py-1.5 text-[10px] border-t"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
						backgroundColor: theme.colors.bgSidebar,
					}}
				>
					{viewMode === 'lines' && locData ? (
						<>
							<span>
								{locData.files.length} files
							</span>
							<span>{locData.annotatedLines.toLocaleString()} / {locData.totalLines.toLocaleString()} lines covered</span>
						</>
					) : (
						<>
							<span>
								{displayedFiles.length} of {files.length} files
							</span>
							<span>{summary.totalAnnotations} total annotations</span>
						</>
					)}
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface CoverageFileRowProps {
	theme: Theme;
	file: NormalizedCoverageFile;
}

/** SVG donut chart showing AI vs Partial vs Unknown code distribution. */
const CoverageDonut: React.FC<{
	covered: number;
	partial: number;
	uncovered: number;
	percentage: number;
}> = ({ covered, partial, uncovered, percentage }) => {
	const total = covered + partial + uncovered;
	const radius = 50;
	const circumference = 2 * Math.PI * radius;

	// Calculate dash segments
	const coveredLen = total > 0 ? (covered / total) * circumference : 0;
	const partialLen = total > 0 ? (partial / total) * circumference : 0;
	const uncoveredLen = total > 0 ? (uncovered / total) * circumference : circumference;

	return (
		<div className="relative shrink-0" style={{ width: 120, height: 120 }} data-testid="coverage-donut">
			<svg viewBox="0 0 120 120" width="120" height="120">
				{/* Background circle */}
				<circle cx="60" cy="60" r={radius} fill="none" stroke="#374151" strokeWidth="12" />
				{/* Covered segment (green) */}
				{coveredLen > 0 && (
					<circle
						cx="60" cy="60" r={radius}
						fill="none"
						stroke={STATUS_CONFIG.full.color}
						strokeWidth="12"
						strokeDasharray={`${coveredLen} ${circumference - coveredLen}`}
						strokeDashoffset={circumference * 0.25}
						data-testid="donut-covered"
					/>
				)}
				{/* Partial segment (yellow) */}
				{partialLen > 0 && (
					<circle
						cx="60" cy="60" r={radius}
						fill="none"
						stroke={STATUS_CONFIG.partial.color}
						strokeWidth="12"
						strokeDasharray={`${partialLen} ${circumference - partialLen}`}
						strokeDashoffset={circumference * 0.25 - coveredLen}
						data-testid="donut-partial"
					/>
				)}
				{/* Uncovered segment (gray) — only if there's no other data */}
				{total > 0 && uncoveredLen > 0 && (covered > 0 || partial > 0) && (
					<circle
						cx="60" cy="60" r={radius}
						fill="none"
						stroke="#6b7280"
						strokeWidth="12"
						strokeDasharray={`${uncoveredLen} ${circumference - uncoveredLen}`}
						strokeDashoffset={circumference * 0.25 - coveredLen - partialLen}
						data-testid="donut-uncovered"
					/>
				)}
			</svg>
			{/* Center label */}
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="text-lg font-bold" data-testid="donut-percentage">{percentage}%</span>
				<span className="text-[9px] opacity-60">AI Coverage</span>
			</div>
		</div>
	);
};

const CoverageFileRow: React.FC<CoverageFileRowProps> = ({ theme, file }) => {
	const statusInfo = STATUS_CONFIG[file.status] ?? STATUS_CONFIG.uncovered;
	const StatusIcon = file.status === 'full'
		? FileCheck
		: file.status === 'partial'
			? FileMinus
			: FileX;

	return (
		<div
			className="flex items-center gap-2 px-3 py-2 border-b text-xs"
			style={{ borderColor: theme.colors.border }}
		>
			{/* Status color indicator */}
			<div
				className="w-2 h-2 rounded-full shrink-0"
				style={{ backgroundColor: statusInfo.color }}
			/>

			{/* File icon */}
			<StatusIcon className="w-3.5 h-3.5 shrink-0" style={{ color: statusInfo.color }} />

			{/* File path */}
			<span
				className="flex-1 min-w-0 truncate font-mono text-[11px]"
				style={{ color: theme.colors.textMain }}
				title={file.filePath}
			>
				{file.filePath}
			</span>

			{/* Status badge */}
			<span
				className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0"
				style={{
					backgroundColor: `${statusInfo.color}20`,
					color: statusInfo.color,
				}}
			>
				{statusInfo.label}
			</span>

			{/* Annotation count */}
			<span
				className="shrink-0 tabular-nums text-[10px] min-w-[3ch] text-right"
				style={{ color: theme.colors.textDim }}
			>
				{file.annotationCount}
			</span>
		</div>
	);
};
