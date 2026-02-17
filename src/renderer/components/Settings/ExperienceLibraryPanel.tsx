/**
 * Experience Library Panel
 *
 * Displays the per-project experience library with search, filter, grouping,
 * add/edit/delete, and import/export functionality.
 */

import { useState, useMemo, useCallback, memo } from 'react';
import { Search, ChevronDown, ChevronRight, Plus, Download, Upload, Trash2, Pencil, X, Scissors } from 'lucide-react';
import type { Theme } from '../../types';
import type { ExperienceEntry, ExperienceId } from '../../../shared/grpo-types';
import { useExperienceLibrary } from '../../hooks/grpo/useExperienceLibrary';
import { ExperienceEditModal } from './ExperienceEditModal';

const CATEGORIES = ['testing', 'architecture', 'tooling', 'debugging', 'patterns', 'performance'];

interface ExperienceLibraryPanelProps {
	theme: Theme;
	projectPath: string | null;
}

function formatTimeAgo(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export const ExperienceLibraryPanel = memo(function ExperienceLibraryPanel({
	theme,
	projectPath,
}: ExperienceLibraryPanelProps) {
	const {
		library,
		loading,
		error,
		addExperience,
		modifyExperience,
		deleteExperience,
		refresh,
		exportLibrary,
		importLibrary,
		pruneLibrary,
	} = useExperienceLibrary(projectPath);

	const [searchQuery, setSearchQuery] = useState('');
	const [categoryFilter, setCategoryFilter] = useState<string>('all');
	const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
	const [editingEntry, setEditingEntry] = useState<ExperienceEntry | null>(null);
	const [showAddModal, setShowAddModal] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<ExperienceId | null>(null);
	const [confirmPrune, setConfirmPrune] = useState(false);
	const [pruning, setPruning] = useState(false);

	// Filter and group entries
	const filteredEntries = useMemo(() => {
		let entries = library;
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			entries = entries.filter((e) => e.content.toLowerCase().includes(q));
		}
		if (categoryFilter !== 'all') {
			entries = entries.filter((e) => e.category === categoryFilter);
		}
		return entries;
	}, [library, searchQuery, categoryFilter]);

	const groupedEntries = useMemo(() => {
		const groups: Record<string, ExperienceEntry[]> = {};
		for (const entry of filteredEntries) {
			if (!groups[entry.category]) {
				groups[entry.category] = [];
			}
			groups[entry.category].push(entry);
		}
		return groups;
	}, [filteredEntries]);

	const totalTokens = useMemo(() => {
		return library.reduce((sum, e) => sum + (e.tokenEstimate || Math.ceil(e.content.length / 4)), 0);
	}, [library]);

	const toggleCategory = useCallback((cat: string) => {
		setCollapsedCategories((prev) => {
			const next = new Set(prev);
			if (next.has(cat)) {
				next.delete(cat);
			} else {
				next.add(cat);
			}
			return next;
		});
	}, []);

	const handleDelete = useCallback(async (id: ExperienceId) => {
		try {
			await deleteExperience(id);
		} catch (err) {
			console.error('Failed to delete experience:', err);
		}
		setConfirmDelete(null);
	}, [deleteExperience]);

	const handleExport = useCallback(async () => {
		try {
			const json = await exportLibrary();
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = 'experience-library.json';
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			console.error('Failed to export library:', err);
		}
	}, [exportLibrary]);

	const handleImport = useCallback(() => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async (e) => {
			const file = (e.target as HTMLInputElement).files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				await importLibrary(text);
			} catch (err) {
				console.error('Failed to import library:', err);
			}
		};
		input.click();
	}, [importLibrary]);

	const handlePrune = useCallback(async () => {
		setPruning(true);
		try {
			await pruneLibrary();
		} catch (err) {
			console.error('Failed to prune library:', err);
		} finally {
			setPruning(false);
			setConfirmPrune(false);
		}
	}, [pruneLibrary]);

	const handleSaveEntry = useCallback(async (entry: {
		content: string;
		category: string;
		agentType: string;
		scope: 'project' | 'global';
	}, existingId?: ExperienceId) => {
		try {
			if (existingId) {
				await modifyExperience(existingId, {
					content: entry.content,
					category: entry.category,
					agentType: entry.agentType,
				});
			} else {
				await addExperience(entry);
			}
		} catch (err) {
			console.error('Failed to save experience:', err);
		}
		setEditingEntry(null);
		setShowAddModal(false);
	}, [addExperience, modifyExperience]);

	if (loading) {
		return (
			<div className="text-sm opacity-50 p-4">Loading experience library...</div>
		);
	}

	if (error) {
		return (
			<div className="p-4">
				<p className="text-xs" style={{ color: theme.colors.error }}>
					{error}
				</p>
				<button
					onClick={refresh}
					className="text-xs mt-2 px-2 py-1 rounded border"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					Retry
				</button>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Header */}
			<div>
				<h4 className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Experience Library ({library.length} entries, ~{totalTokens} tokens)
				</h4>
				{projectPath && (
					<p className="text-[10px] mt-0.5 font-mono truncate" style={{ color: theme.colors.textDim }}>
						Project: {projectPath}
					</p>
				)}
			</div>

			{/* Toolbar */}
			<div className="flex items-center gap-2 flex-wrap">
				{/* Search */}
				<div className="flex items-center gap-1 flex-1 min-w-[140px] p-1.5 rounded border" style={{ borderColor: theme.colors.border }}>
					<Search className="w-3 h-3 opacity-50" />
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search..."
						className="flex-1 bg-transparent outline-none text-xs"
						style={{ color: theme.colors.textMain }}
					/>
				</div>

				{/* Category Filter */}
				<select
					value={categoryFilter}
					onChange={(e) => setCategoryFilter(e.target.value)}
					className="p-1.5 text-xs rounded border bg-transparent outline-none"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<option value="all">All Categories</option>
					{CATEGORIES.map((c) => (
						<option key={c} value={c}>{c}</option>
					))}
				</select>

				{/* Action Buttons */}
				<button
					onClick={() => setShowAddModal(true)}
					className="p-1.5 rounded border hover:bg-white/10 transition-colors"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					title="Add Experience"
				>
					<Plus className="w-3.5 h-3.5" />
				</button>
				<button
					onClick={handleImport}
					className="p-1.5 rounded border hover:bg-white/10 transition-colors"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					title="Import"
				>
					<Upload className="w-3.5 h-3.5" />
				</button>
				<button
					onClick={handleExport}
					className="p-1.5 rounded border hover:bg-white/10 transition-colors"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
					title="Export"
				>
					<Download className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Entries grouped by category */}
			{Object.keys(groupedEntries).length === 0 ? (
				<div className="text-xs text-center py-6 opacity-50">
					{library.length === 0
						? 'No experiences yet. Run GRPO training or add entries manually.'
						: 'No entries match your search.'
					}
				</div>
			) : (
				<div className="space-y-2">
					{Object.entries(groupedEntries).map(([category, entries]) => {
						const isCollapsed = collapsedCategories.has(category);
						return (
							<div
								key={category}
								className="rounded-lg border overflow-hidden"
								style={{ borderColor: theme.colors.border }}
							>
								{/* Category Header */}
								<button
									onClick={() => toggleCategory(category)}
									className="w-full flex items-center gap-2 px-3 py-2 text-xs font-bold hover:bg-white/5 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									{isCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									<span>{category}</span>
									<span className="font-normal" style={{ color: theme.colors.textDim }}>
										({entries.length})
									</span>
								</button>

								{/* Entries */}
								{!isCollapsed && (
									<div className="border-t" style={{ borderColor: theme.colors.border }}>
										{entries.map((entry) => (
											<div
												key={entry.id}
												className="px-3 py-2 border-b last:border-b-0 hover:bg-white/5 transition-colors"
												style={{ borderColor: theme.colors.border }}
											>
												<div className="flex items-start gap-2">
													{/* Actions */}
													<div className="flex items-center gap-1 mt-0.5 shrink-0">
														<button
															onClick={() => setEditingEntry(entry)}
															className="p-0.5 rounded hover:bg-white/10"
															title="Edit"
															style={{ color: theme.colors.textDim }}
														>
															<Pencil className="w-3 h-3" />
														</button>
														{confirmDelete === entry.id ? (
															<div className="flex items-center gap-1">
																<button
																	onClick={() => handleDelete(entry.id)}
																	className="text-[10px] px-1 rounded"
																	style={{ color: theme.colors.error }}
																>
																	Confirm
																</button>
																<button
																	onClick={() => setConfirmDelete(null)}
																	className="p-0.5 rounded hover:bg-white/10"
																	style={{ color: theme.colors.textDim }}
																>
																	<X className="w-3 h-3" />
																</button>
															</div>
														) : (
															<button
																onClick={() => setConfirmDelete(entry.id)}
																className="p-0.5 rounded hover:bg-white/10"
																title="Delete"
																style={{ color: theme.colors.textDim }}
															>
																<Trash2 className="w-3 h-3" />
															</button>
														)}
													</div>

													{/* Content */}
													<div className="flex-1 min-w-0">
														<p className="text-xs leading-relaxed" style={{ color: theme.colors.textMain }}>
															{entry.content}
														</p>
														<div className="flex items-center gap-3 mt-1">
															<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
																Evidence: {entry.evidenceCount}
															</span>
															<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
																Used: {entry.useCount}
															</span>
															<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
																Updated: {formatTimeAgo(entry.updatedAt)}
															</span>
														</div>
													</div>
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{/* Prune Button */}
			{library.length > 0 && (
				<div className="pt-2">
					{confirmPrune ? (
						<div className="flex items-center gap-2">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Remove stale entries?
							</span>
							<button
								onClick={handlePrune}
								disabled={pruning}
								className="text-xs px-2 py-1 rounded border"
								style={{ borderColor: theme.colors.error, color: theme.colors.error }}
							>
								{pruning ? 'Pruning...' : 'Confirm'}
							</button>
							<button
								onClick={() => setConfirmPrune(false)}
								className="text-xs px-2 py-1 rounded border"
								style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
							>
								Cancel
							</button>
						</div>
					) : (
						<button
							onClick={() => setConfirmPrune(true)}
							className="flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-white/10 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
						>
							<Scissors className="w-3 h-3" />
							Prune Stale Entries
						</button>
					)}
				</div>
			)}

			{/* Add/Edit Modal */}
			{(showAddModal || editingEntry) && (
				<ExperienceEditModal
					theme={theme}
					entry={editingEntry}
					onSave={handleSaveEntry}
					onClose={() => {
						setShowAddModal(false);
						setEditingEntry(null);
					}}
				/>
			)}
		</div>
	);
});
