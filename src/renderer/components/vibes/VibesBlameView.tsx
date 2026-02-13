import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
	FileCode,
	Search,
	Clock,
	AlertTriangle,
	Database,
	Cpu,
	Folder,
	FolderOpen,
	ChevronRight,
	ChevronDown,
	ArrowLeft,
} from 'lucide-react';
import type { Theme } from '../../types';

// ============================================================================
// Types
// ============================================================================

/** A single blame entry from `vibecheck blame --json`. */
interface BlameEntry {
	line_start: number;
	line_end: number;
	model_name: string;
	model_version?: string;
	tool_name?: string;
	action: 'create' | 'modify' | 'delete' | 'review';
	timestamp: string;
	session_id?: string;
}

/** Tracked file info extracted from coverage data. */
interface TrackedFileInfo {
	filePath: string;
	status?: 'full' | 'partial' | 'uncovered';
	annotationCount?: number;
}

/** A node in the file directory tree. */
interface FileTreeNode {
	name: string;
	fullPath: string;
	isDirectory: boolean;
	children: FileTreeNode[];
	fileInfo?: TrackedFileInfo;
	totalFiles: number;
	totalAnnotations: number;
}

/** Props for the VibesBlameView component. */
interface VibesBlameViewProps {
	theme: Theme;
	projectPath: string | undefined;
	/** Optional pre-selected file path (e.g. from file explorer context menu). */
	initialFilePath?: string;
	/** Whether the vibecheck binary is available. When false, shows a targeted message. */
	binaryAvailable?: boolean | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Consistent color palette for model assignment (cycles for > 6 models). */
const MODEL_COLORS = [
	'#bd93f9', // purple
	'#50fa7b', // green
	'#ff79c6', // pink
	'#8be9fd', // cyan
	'#f1fa8c', // yellow
	'#ffb86c', // orange
	'#ff5555', // red
	'#6272a4', // blue-gray
];

const ACTION_COLORS: Record<string, { bg: string; text: string }> = {
	create: { bg: 'rgba(34, 197, 94, 0.15)', text: '#22c55e' },
	modify: { bg: 'rgba(59, 130, 246, 0.15)', text: '#3b82f6' },
	delete: { bg: 'rgba(239, 68, 68, 0.15)', text: '#ef4444' },
	review: { bg: 'rgba(234, 179, 8, 0.15)', text: '#eab308' },
};

const STATUS_COLORS: Record<string, string> = {
	full: '#22c55e',
	partial: '#eab308',
	uncovered: '#6b7280',
};

// ============================================================================
// Helpers
// ============================================================================

/** Format a timestamp as relative time (e.g., "3 days ago"). */
function formatRelativeTime(timestamp: string): string {
	const now = Date.now();
	const then = new Date(timestamp).getTime();
	if (isNaN(then)) return timestamp;

	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);

	if (diffSec < 60) return 'just now';
	if (diffMin < 60) return `${diffMin} min ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	if (diffDay < 30) return `${diffDay}d ago`;
	return new Date(timestamp).toLocaleDateString();
}

/** Format a tool name for display. */
function formatToolName(toolName?: string): string {
	if (!toolName) return 'Unknown';
	const lower = toolName.toLowerCase();
	if (lower.includes('claude') || lower.includes('claude-code')) return 'Claude Code';
	if (lower.includes('codex')) return 'Codex';
	if (lower.includes('maestro')) return 'Maestro';
	return toolName;
}

/** Parse the JSON output from `vibecheck blame --json`. */
function parseBlameData(raw: string | undefined): BlameEntry[] {
	if (!raw) return [];
	try {
		const data = JSON.parse(raw);
		if (Array.isArray(data)) return data;
		if (data.entries && Array.isArray(data.entries)) return data.entries;
		if (data.blame && Array.isArray(data.blame)) return data.blame;
		return [];
	} catch {
		return [];
	}
}

/** Parse coverage API response into TrackedFileInfo[]. */
function parseCoverageFiles(raw: string): TrackedFileInfo[] {
	try {
		const data = JSON.parse(raw);
		const items: Array<Record<string, unknown>> = Array.isArray(data)
			? data
			: Array.isArray(data.files)
				? data.files
				: [];

		const files: TrackedFileInfo[] = [];
		for (const item of items) {
			const fp = (item.file_path ?? item.file ?? item.path) as string | undefined;
			if (!fp) continue;
			files.push({
				filePath: fp,
				status: (item.coverage_status ?? item.status) as TrackedFileInfo['status'],
				annotationCount: (item.annotation_count ?? item.annotations ?? item.count) as number | undefined,
			});
		}
		return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
	} catch {
		return [];
	}
}

/** Build a directory tree from a flat list of tracked files. */
function buildFileTree(files: TrackedFileInfo[]): FileTreeNode[] {
	const root: FileTreeNode = {
		name: '',
		fullPath: '',
		isDirectory: true,
		children: [],
		totalFiles: 0,
		totalAnnotations: 0,
	};

	for (const file of files) {
		const parts = file.filePath.split('/');
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			const childPath = parts.slice(0, i + 1).join('/');

			let existing = current.children.find((c) => c.name === part);
			if (!existing) {
				existing = {
					name: part,
					fullPath: childPath,
					isDirectory: !isLast,
					children: [],
					fileInfo: isLast ? file : undefined,
					totalFiles: 0,
					totalAnnotations: 0,
				};
				current.children.push(existing);
			}
			current = existing;
		}
	}

	// Compute aggregate stats and sort
	const computeStats = (node: FileTreeNode): void => {
		if (!node.isDirectory) {
			node.totalFiles = 1;
			node.totalAnnotations = node.fileInfo?.annotationCount ?? 0;
			return;
		}
		node.totalFiles = 0;
		node.totalAnnotations = 0;
		for (const child of node.children) {
			computeStats(child);
			node.totalFiles += child.totalFiles;
			node.totalAnnotations += child.totalAnnotations;
		}
		// Sort: directories first, then alphabetically
		node.children.sort((a, b) => {
			if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	};

	for (const child of root.children) {
		computeStats(child);
	}
	root.children.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return root.children;
}

/** Get all directory paths that should be expanded by default (all of them for annotation trees). */
function getAllDirPaths(nodes: FileTreeNode[]): Set<string> {
	const paths = new Set<string>();
	const walk = (list: FileTreeNode[]) => {
		for (const node of list) {
			if (node.isDirectory) {
				paths.add(node.fullPath);
				walk(node.children);
			}
		}
	};
	walk(nodes);
	return paths;
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Blame View — shows AI attribution per line for a selected file,
 * similar to `git blame` but for AI involvement.
 *
 * Features:
 * - File directory tree browser with expand/collapse
 * - Search filter for quick file lookup
 * - Blame display with line ranges, model info, action types, timestamps
 * - Color-coded gutter by model
 * - Empty state and "Build Required" notice
 */
export const VibesBlameView: React.FC<VibesBlameViewProps> = ({
	theme,
	projectPath,
	initialFilePath,
	binaryAvailable,
}) => {
	const [filePath, setFilePath] = useState(initialFilePath ?? '');
	const [fileSearch, setFileSearch] = useState('');
	const [trackedFiles, setTrackedFiles] = useState<TrackedFileInfo[]>([]);
	const [blameEntries, setBlameEntries] = useState<BlameEntry[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [needsBuild, setNeedsBuild] = useState(false);
	const [isBuilding, setIsBuilding] = useState(false);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [showDropdown, setShowDropdown] = useState(false);

	// Build a stable model -> color map
	const modelColorMap = useMemo(() => {
		const map = new Map<string, string>();
		const uniqueModels = [...new Set(blameEntries.map((e) => e.model_name))];
		uniqueModels.forEach((model, idx) => {
			map.set(model, MODEL_COLORS[idx % MODEL_COLORS.length]);
		});
		return map;
	}, [blameEntries]);

	// Build file tree from tracked files
	const fileTree = useMemo(() => buildFileTree(trackedFiles), [trackedFiles]);

	// Auto-expand all directories on initial load
	useEffect(() => {
		if (fileTree.length > 0 && expandedDirs.size === 0) {
			setExpandedDirs(getAllDirPaths(fileTree));
		}
	}, [fileTree, expandedDirs.size]);

	// ========================================================================
	// Fetch tracked files from coverage data
	// ========================================================================

	useEffect(() => {
		if (!projectPath) return;
		let cancelled = false;

		(async () => {
			try {
				const result = await window.maestro.vibes.getCoverage(projectPath);
				if (cancelled) return;
				if (result.success && result.data) {
					const files = parseCoverageFiles(result.data);
					setTrackedFiles(files);
				}
			} catch {
				// Coverage fetch failed silently
			}
		})();

		return () => { cancelled = true; };
	}, [projectPath]);

	// ========================================================================
	// Fetch blame data when file is selected
	// ========================================================================

	const fetchBlame = useCallback(async (path: string) => {
		if (!projectPath || !path.trim()) return;

		setIsLoading(true);
		setError(null);
		setNeedsBuild(false);
		setBlameEntries([]);

		try {
			const result = await window.maestro.vibes.getBlame(projectPath, path);
			if (result.success) {
				const entries = parseBlameData(result.data);
				setBlameEntries(entries);
			} else {
				const errMsg = result.error ?? 'Failed to fetch blame data';
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
			setError(err instanceof Error ? err.message : 'Failed to fetch blame data');
		} finally {
			setIsLoading(false);
		}
	}, [projectPath]);

	// Fetch blame when filePath changes
	useEffect(() => {
		if (filePath) {
			fetchBlame(filePath);
		}
	}, [filePath, fetchBlame]);

	// Update filePath when initialFilePath prop changes
	useEffect(() => {
		if (initialFilePath) {
			setFilePath(initialFilePath);
		}
	}, [initialFilePath]);

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
				if (filePath) {
					fetchBlame(filePath);
				}
			} else {
				setError(result.error ?? 'Build failed');
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Build failed');
		} finally {
			setIsBuilding(false);
		}
	}, [projectPath, filePath, fetchBlame]);

	// ========================================================================
	// File tree interactions
	// ========================================================================

	const toggleDir = useCallback((dirPath: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dirPath)) {
				next.delete(dirPath);
			} else {
				next.add(dirPath);
			}
			return next;
		});
	}, []);

	const handleSelectFile = useCallback((path: string) => {
		setFilePath(path);
		setFileSearch('');
		setShowDropdown(false);
	}, []);

	const handleBackToTree = useCallback(() => {
		setFilePath('');
		setBlameEntries([]);
		setError(null);
		setNeedsBuild(false);
	}, []);

	// ========================================================================
	// Search filter for dropdown
	// ========================================================================

	const filteredFiles = useMemo(() => {
		if (!fileSearch.trim()) return [];
		const search = fileSearch.toLowerCase();
		return trackedFiles.filter((f) => f.filePath.toLowerCase().includes(search));
	}, [trackedFiles, fileSearch]);

	const handleInputKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'Enter') {
				setShowDropdown(false);
				if (filteredFiles.length > 0) {
					handleSelectFile(filteredFiles[0].filePath);
				} else if (fileSearch.trim()) {
					setFilePath(fileSearch.trim());
				}
			} else if (e.key === 'Escape') {
				setShowDropdown(false);
				setFileSearch('');
			}
		},
		[fileSearch, filteredFiles, handleSelectFile],
	);

	// ========================================================================
	// Render
	// ========================================================================

	const isViewingBlame = !!filePath;

	return (
		<div className="flex flex-col h-full">
			{/* Header area */}
			<div
				className="sticky top-0 z-10 flex flex-col gap-2 px-3 py-2"
				style={{ backgroundColor: theme.colors.bgSidebar }}
			>
				{isViewingBlame ? (
					/* Blame mode header: back button + file path */
					<div className="flex items-center gap-2 min-w-0">
						<button
							onClick={handleBackToTree}
							className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-70"
							style={{ color: theme.colors.textDim }}
							title="Back to file browser"
						>
							<ArrowLeft className="w-3.5 h-3.5" />
						</button>
						<FileCode className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						<span
							className="text-[11px] font-mono truncate"
							style={{ color: theme.colors.textMain }}
							title={filePath}
						>
							{filePath}
						</span>
					</div>
				) : (
					/* Tree mode header: search bar */
					<>
						<div className="flex items-center gap-2">
							<Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
							<span className="text-[11px] font-semibold" style={{ color: theme.colors.textDim }}>
								File Browser
							</span>
							{trackedFiles.length > 0 && (
								<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
									{trackedFiles.length} file{trackedFiles.length !== 1 ? 's' : ''}
								</span>
							)}
						</div>
						<div className="relative">
							<div className="flex items-center gap-2">
								<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
								<input
									type="text"
									placeholder="Search files..."
									value={fileSearch}
									onChange={(e) => {
										setFileSearch(e.target.value);
										setShowDropdown(true);
									}}
									onFocus={() => {
										if (fileSearch.trim()) setShowDropdown(true);
									}}
									onKeyDown={handleInputKeyDown}
									className="flex-1 px-2 py-1 rounded text-xs bg-transparent outline-none font-mono"
									style={{
										border: `1px solid ${theme.colors.border}`,
										color: theme.colors.textMain,
									}}
								/>
							</div>

							{/* Dropdown search results */}
							{showDropdown && filteredFiles.length > 0 && (
								<div
									className="absolute left-0 right-0 top-full mt-1 max-h-48 overflow-y-auto rounded border z-20 scrollbar-thin"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
									}}
								>
									{filteredFiles.slice(0, 50).map((file) => (
										<button
											key={file.filePath}
											onClick={() => handleSelectFile(file.filePath)}
											className="flex items-center gap-2 w-full text-left px-2 py-1.5 text-[11px] font-mono transition-colors hover:opacity-80"
											style={{
												color: theme.colors.textMain,
												backgroundColor: 'transparent',
											}}
										>
											<FileCode className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
											<span className="truncate">{file.filePath}</span>
											{file.status && (
												<span
													className="w-1.5 h-1.5 rounded-full shrink-0 ml-auto"
													style={{ backgroundColor: STATUS_COLORS[file.status] ?? STATUS_COLORS.uncovered }}
												/>
											)}
										</button>
									))}
									{filteredFiles.length > 50 && (
										<div
											className="px-2 py-1 text-[10px]"
											style={{ color: theme.colors.textDim }}
										>
											...and {filteredFiles.length - 50} more
										</div>
									)}
								</div>
							)}
						</div>
					</>
				)}
			</div>

			{/* Content area */}
			<div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin">
				{/* Binary unavailable notice */}
				{binaryAvailable === false && (
					<div
						className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center"
						data-testid="binary-unavailable-notice"
					>
						<AlertTriangle className="w-6 h-6 opacity-60" style={{ color: '#eab308' }} />
						<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Blame view requires vibecheck CLI
						</span>
						<span className="text-xs max-w-xs" style={{ color: theme.colors.textDim }}>
							Install vibecheck to view per-line AI attribution.
						</span>
					</div>
				)}

				{/* ====== TREE VIEW (no file selected) ====== */}
				{binaryAvailable !== false && !isViewingBlame && !isLoading && (
					<>
						{trackedFiles.length === 0 ? (
							<EmptyState
								theme={theme}
								icon={<Folder className="w-6 h-6 opacity-40" />}
								message="No tracked files"
								detail="No files with AI annotations found. Run an AI agent to generate attribution data."
							/>
						) : (
							<div className="flex flex-col py-1">
								{fileTree.map((node) => (
									<FileTreeItem
										key={node.fullPath}
										node={node}
										theme={theme}
										depth={0}
										expandedDirs={expandedDirs}
										onToggleDir={toggleDir}
										onSelectFile={handleSelectFile}
									/>
								))}
							</div>
						)}
					</>
				)}

				{/* ====== BLAME VIEW (file selected) ====== */}

				{/* Loading */}
				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
						<Clock className="w-6 h-6 animate-pulse" style={{ color: theme.colors.textDim }} />
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Loading blame data...
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
							Annotations exist but the audit database hasn&apos;t been built yet.
							Build it to view blame data.
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

				{/* No blame data for file */}
				{!isLoading && !error && !needsBuild && isViewingBlame && blameEntries.length === 0 && (
					<EmptyState
						theme={theme}
						icon={<FileCode className="w-6 h-6 opacity-40" />}
						message="No blame data for this file"
						detail="This file has no AI attribution annotations recorded."
					/>
				)}

				{/* Blame entries */}
				{!isLoading && !error && !needsBuild && blameEntries.length > 0 && (
					<div className="flex flex-col">
						{blameEntries.map((entry, idx) => (
							<BlameRow
								key={`${entry.line_start}-${entry.line_end}-${idx}`}
								theme={theme}
								entry={entry}
								gutterColor={modelColorMap.get(entry.model_name) ?? MODEL_COLORS[0]}
							/>
						))}
					</div>
				)}
			</div>

			{/* Footer */}
			{isViewingBlame && !isLoading && blameEntries.length > 0 && (
				<div
					className="flex items-center justify-between px-3 py-1.5 text-[10px] border-t"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textDim,
						backgroundColor: theme.colors.bgSidebar,
					}}
				>
					<span>{blameEntries.length} blame entries</span>
					<span>{modelColorMap.size} model{modelColorMap.size !== 1 ? 's' : ''}</span>
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface EmptyStateProps {
	theme: Theme;
	icon: React.ReactNode;
	message: string;
	detail: string;
}

const EmptyState: React.FC<EmptyStateProps> = ({ theme, icon, message, detail }) => (
	<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
		<span style={{ color: theme.colors.textDim }}>{icon}</span>
		<span
			className="text-sm font-medium"
			style={{ color: theme.colors.textMain }}
		>
			{message}
		</span>
		<span
			className="text-xs max-w-xs"
			style={{ color: theme.colors.textDim }}
		>
			{detail}
		</span>
	</div>
);

// ----------------------------------------------------------------------------
// File tree item (recursive)
// ----------------------------------------------------------------------------

interface FileTreeItemProps {
	node: FileTreeNode;
	theme: Theme;
	depth: number;
	expandedDirs: Set<string>;
	onToggleDir: (path: string) => void;
	onSelectFile: (path: string) => void;
}

const FileTreeItem: React.FC<FileTreeItemProps> = ({
	node,
	theme,
	depth,
	expandedDirs,
	onToggleDir,
	onSelectFile,
}) => {
	const isExpanded = expandedDirs.has(node.fullPath);
	const indent = depth * 16;

	if (node.isDirectory) {
		return (
			<>
				<button
					onClick={() => onToggleDir(node.fullPath)}
					className="flex items-center gap-1.5 w-full text-left py-1 pr-2 transition-colors hover:opacity-80"
					style={{
						paddingLeft: `${8 + indent}px`,
						color: theme.colors.textMain,
					}}
				>
					{isExpanded
						? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
						: <ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					}
					{isExpanded
						? <FolderOpen className="w-3.5 h-3.5 shrink-0" style={{ color: '#eab308' }} />
						: <Folder className="w-3.5 h-3.5 shrink-0" style={{ color: '#eab308' }} />
					}
					<span className="text-[11px] font-medium truncate">{node.name}</span>
					<span
						className="text-[10px] ml-auto shrink-0 tabular-nums"
						style={{ color: theme.colors.textDim }}
					>
						{node.totalFiles}
					</span>
				</button>
				{isExpanded && node.children.map((child) => (
					<FileTreeItem
						key={child.fullPath}
						node={child}
						theme={theme}
						depth={depth + 1}
						expandedDirs={expandedDirs}
						onToggleDir={onToggleDir}
						onSelectFile={onSelectFile}
					/>
				))}
			</>
		);
	}

	// File node
	const status = node.fileInfo?.status;
	const count = node.fileInfo?.annotationCount;

	return (
		<button
			onClick={() => onSelectFile(node.fullPath)}
			className="flex items-center gap-1.5 w-full text-left py-1 pr-2 transition-colors hover:opacity-80"
			style={{
				paddingLeft: `${8 + indent + 16}px`,
				color: theme.colors.textMain,
			}}
			title={node.fullPath}
		>
			<FileCode className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
			<span className="text-[11px] font-mono truncate">{node.name}</span>
			<span className="flex items-center gap-1.5 ml-auto shrink-0">
				{count != null && count > 0 && (
					<span
						className="text-[10px] tabular-nums"
						style={{ color: theme.colors.textDim }}
					>
						{count}
					</span>
				)}
				{status && (
					<span
						className="w-1.5 h-1.5 rounded-full shrink-0"
						style={{ backgroundColor: STATUS_COLORS[status] ?? STATUS_COLORS.uncovered }}
						title={status}
					/>
				)}
			</span>
		</button>
	);
};

// ----------------------------------------------------------------------------
// Blame row
// ----------------------------------------------------------------------------

interface BlameRowProps {
	theme: Theme;
	entry: BlameEntry;
	gutterColor: string;
}

const BlameRow: React.FC<BlameRowProps> = ({ theme, entry, gutterColor }) => {
	const actionColor = ACTION_COLORS[entry.action] ?? ACTION_COLORS.modify;
	const lineRange =
		entry.line_start === entry.line_end
			? `L${entry.line_start}`
			: `L${entry.line_start}-${entry.line_end}`;

	return (
		<div
			className="flex items-center gap-0 border-b text-xs"
			style={{ borderColor: theme.colors.border }}
		>
			{/* Color-coded gutter */}
			<div
				className="w-1 self-stretch shrink-0"
				style={{ backgroundColor: gutterColor }}
			/>

			{/* Content */}
			<div className="flex items-center gap-2 flex-1 min-w-0 px-3 py-2">
				{/* Line range */}
				<span
					className="shrink-0 w-16 font-mono text-[11px] tabular-nums"
					style={{ color: theme.colors.accent }}
				>
					{lineRange}
				</span>

				{/* Model name + version */}
				<div className="flex items-center gap-1.5 shrink-0 min-w-0 max-w-[140px]">
					<Cpu className="w-3 h-3 shrink-0" style={{ color: gutterColor }} />
					<span
						className="truncate text-[11px] font-medium"
						style={{ color: theme.colors.textMain }}
						title={entry.model_name}
					>
						{entry.model_name}
					</span>
					{entry.model_version && (
						<span
							className="text-[10px] shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							v{entry.model_version}
						</span>
					)}
				</div>

				{/* Agent type badge */}
				<span
					className="px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textDim,
					}}
				>
					{formatToolName(entry.tool_name)}
				</span>

				{/* Action badge */}
				<span
					className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase shrink-0"
					style={{ backgroundColor: actionColor.bg, color: actionColor.text }}
				>
					{entry.action}
				</span>

				{/* Relative timestamp */}
				<span
					className="text-[10px] shrink-0 ml-auto tabular-nums"
					style={{ color: theme.colors.textDim }}
				>
					{formatRelativeTime(entry.timestamp)}
				</span>

				{/* Session ID (shortened) */}
				{entry.session_id && (
					<span
						className="text-[10px] font-mono shrink-0 cursor-pointer hover:underline"
						style={{ color: theme.colors.accent }}
						title={`Session: ${entry.session_id}`}
					>
						{entry.session_id.slice(0, 8)}
					</span>
				)}
			</div>
		</div>
	);
};
