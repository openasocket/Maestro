/**
 * Memory Library Panel
 *
 * Displays memories for the currently selected tree node.
 * When a skill area is selected, shows memories in that skill.
 * When project/global is selected, shows flat-scope memories.
 * Supports search, filter by tags, add/edit/delete.
 */

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
	Search,
	Plus,
	Pin,
	PinOff,
	Edit3,
	Trash2,
	Download,
	Upload,
	ChevronDown,
	ChevronRight,
	Loader2,
	AlertTriangle,
	Brain,
	Clock,
	BarChart3,
	Hash,
	Sparkles,
	RotateCcw,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { TreeNode } from './MemoryTreeBrowser';
import type {
	MemoryEntry,
	MemorySearchResult,
	MemoryType,
	MemoryScope,
	Role,
	Persona,
	SkillArea,
} from '../../../shared/memory-types';
import type { UseMemoryStoreReturn } from '../../hooks/memory/useMemoryStore';

// ─── Types ────────────────────────────────────────────────────────────────

interface MemoryLibraryPanelProps {
	theme: Theme;
	selectedNode: TreeNode | null;
	projectPath: string | null;
	agentType?: string;
	store: UseMemoryStoreReturn;
	// Hierarchy data for breadcrumbs
	roles: Role[];
	personas: Persona[];
	skillAreas: SkillArea[];
}

type TypeFilter = 'all' | 'rule' | 'experience';

// ─── Breadcrumb Builder ───────────────────────────────────────────────────

function buildBreadcrumb(
	node: TreeNode | null,
	roles: Role[],
	personas: Persona[],
	skillAreas: SkillArea[]
): string[] {
	if (!node) return [];
	if (node.type === 'project') return ['Project Memories'];
	if (node.type === 'global') return ['Global Memories'];
	if (node.type === 'role') {
		const role = roles.find((r) => r.id === node.id);
		return role ? [role.name] : ['Unknown Role'];
	}
	if (node.type === 'persona') {
		const persona = personas.find((p) => p.id === node.id);
		const role = persona ? roles.find((r) => r.id === persona.roleId) : null;
		return [role?.name ?? '?', persona?.name ?? 'Unknown Persona'];
	}
	if (node.type === 'skill') {
		const skill = skillAreas.find((s) => s.id === node.id);
		const persona = skill ? personas.find((p) => p.id === skill.personaId) : null;
		const role = persona ? roles.find((r) => r.id === persona.roleId) : null;
		return [role?.name ?? '?', persona?.name ?? '?', skill?.name ?? 'Unknown Skill'];
	}
	return [];
}

// ─── Scope Derivation ─────────────────────────────────────────────────────

function deriveScope(node: TreeNode | null): { scope: MemoryScope; skillAreaId?: string } {
	if (!node) return { scope: 'global' };
	switch (node.type) {
		case 'skill':
			return { scope: 'skill', skillAreaId: node.id };
		case 'project':
			return { scope: 'project' };
		case 'global':
			return { scope: 'global' };
		case 'role':
		case 'persona':
			return { scope: 'skill' };
		default:
			return { scope: 'global' };
	}
}

// ─── Memory Card ──────────────────────────────────────────────────────────

function MemoryCard({
	memory,
	theme,
	onTogglePin,
	onEdit,
	onDelete,
	archived,
	onRestore,
}: {
	memory: MemoryEntry;
	theme: Theme;
	onTogglePin: () => void;
	onEdit: () => void;
	onDelete: () => void;
	archived?: boolean;
	onRestore?: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [contextExpanded, setContextExpanded] = useState(false);

	const isExperience = memory.type === 'experience';
	const hasContext = isExperience && memory.experienceContext;

	return (
		<div
			className="rounded-lg border p-3 space-y-2 transition-colors"
			style={{
				borderColor: memory.pinned ? theme.colors.accent : theme.colors.border,
				backgroundColor: memory.pinned ? `${theme.colors.accent}05` : 'transparent',
				opacity: archived ? 0.7 : 1,
			}}
		>
			{/* Header row */}
			<div className="flex items-center gap-2">
				{/* Type badge — shows "Archived" when in archive view */}
				<span
					className="text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: archived
							? `${theme.colors.textDim}20`
							: isExperience
								? `${theme.colors.warning}20`
								: `${theme.colors.border}60`,
						color: archived
							? theme.colors.textDim
							: isExperience
								? theme.colors.warning
								: theme.colors.textDim,
					}}
				>
					{archived ? 'Archived' : memory.type}
				</span>

				{/* Source badge */}
				<span
					className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: `${theme.colors.border}40`,
						color: theme.colors.textDim,
					}}
				>
					{memory.source}
				</span>

				<div className="flex-1" />

				{/* Action buttons */}
				<button
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: memory.pinned ? theme.colors.accent : theme.colors.textDim }}
					title={memory.pinned ? 'Unpin' : 'Pin'}
					onClick={onTogglePin}
				>
					{memory.pinned ? <Pin className="w-3 h-3" /> : <PinOff className="w-3 h-3" />}
				</button>
				{archived && onRestore ? (
					<button
						className="p-0.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.accent }}
						title="Restore"
						onClick={onRestore}
					>
						<RotateCcw className="w-3 h-3" />
					</button>
				) : (
					<button
						className="p-0.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						title="Edit"
						onClick={onEdit}
					>
						<Edit3 className="w-3 h-3" />
					</button>
				)}
				<button
					className="p-0.5 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.error }}
					title="Delete"
					onClick={onDelete}
				>
					<Trash2 className="w-3 h-3" />
				</button>
			</div>

			{/* Content */}
			<div
				className="text-xs leading-relaxed cursor-pointer"
				style={{ color: theme.colors.textMain }}
				onClick={() => setExpanded(!expanded)}
			>
				{expanded ? (
					memory.content
				) : (
					<span>
						{memory.content.length > 200 ? `${memory.content.slice(0, 200)}...` : memory.content}
					</span>
				)}
			</div>

			{/* Experience context — expandable */}
			{hasContext && memory.experienceContext && (
				<div>
					<button
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
						onClick={() => setContextExpanded(!contextExpanded)}
					>
						{contextExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						Context
					</button>
					{contextExpanded && (
						<div className="mt-1 pl-4 space-y-1 text-xs" style={{ color: theme.colors.textDim }}>
							{memory.experienceContext.situation && (
								<div>
									<span className="font-medium">Situation:</span>{' '}
									{memory.experienceContext.situation}
								</div>
							)}
							{memory.experienceContext.learning && (
								<div>
									<span className="font-medium">Learning:</span> {memory.experienceContext.learning}
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{/* Tags */}
			{memory.tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{memory.tags.map((tag) => (
						<span
							key={tag}
							className="text-[10px] px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{tag}
						</span>
					))}
				</div>
			)}

			{/* Meta row */}
			<div className="flex items-center gap-3 text-[10px]" style={{ color: theme.colors.textDim }}>
				{/* Confidence bar */}
				<div
					className="flex items-center gap-1"
					title={`Confidence: ${(memory.confidence * 100).toFixed(0)}%`}
				>
					<BarChart3 className="w-3 h-3" />
					<div
						className="w-12 h-1 rounded-full"
						style={{ backgroundColor: `${theme.colors.border}60` }}
					>
						<div
							className="h-1 rounded-full"
							style={{
								width: `${memory.confidence * 100}%`,
								backgroundColor: theme.colors.accent,
							}}
						/>
					</div>
					<span>{(memory.confidence * 100).toFixed(0)}%</span>
				</div>

				{/* Effectiveness */}
				{memory.effectivenessScore > 0 && (
					<div className="flex items-center gap-1" title="Effectiveness">
						<Sparkles className="w-3 h-3" />
						{(memory.effectivenessScore * 100).toFixed(0)}%
					</div>
				)}

				{/* Use count */}
				{memory.useCount > 0 && (
					<div className="flex items-center gap-1" title="Times used">
						<Hash className="w-3 h-3" />
						{memory.useCount}
					</div>
				)}

				{/* Last used */}
				{memory.lastUsedAt > 0 && (
					<div className="flex items-center gap-1" title="Last used">
						<Clock className="w-3 h-3" />
						{formatRelativeTime(memory.lastUsedAt)}
					</div>
				)}
			</div>
		</div>
	);
}

function formatRelativeTime(timestamp: number): string {
	const now = Date.now();
	const diff = now - timestamp;
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

// ─── Search Result Card ───────────────────────────────────────────────────

function SearchResultCard({ result, theme }: { result: MemorySearchResult; theme: Theme }) {
	const { entry, similarity, personaName, skillAreaName } = result;

	return (
		<div className="rounded-lg border p-3 space-y-1.5" style={{ borderColor: theme.colors.border }}>
			{/* Breadcrumb + similarity */}
			<div className="flex items-center justify-between">
				<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{[personaName, skillAreaName].filter(Boolean).join(' > ') || entry.scope}
				</div>
				<span
					className="text-[10px] font-mono px-1.5 py-0.5 rounded"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{(similarity * 100).toFixed(0)}%
				</span>
			</div>

			{/* Type badge */}
			<span
				className="text-[10px] font-medium px-1.5 py-0.5 rounded inline-block"
				style={{
					backgroundColor:
						entry.type === 'experience' ? `${theme.colors.warning}20` : `${theme.colors.border}60`,
					color: entry.type === 'experience' ? theme.colors.warning : theme.colors.textDim,
				}}
			>
				{entry.type}
			</span>

			{/* Content */}
			<div className="text-xs" style={{ color: theme.colors.textMain }}>
				{entry.content.length > 200 ? `${entry.content.slice(0, 200)}...` : entry.content}
			</div>

			{/* Tags */}
			{entry.tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{entry.tags.map((tag) => (
						<span
							key={tag}
							className="text-[10px] px-1.5 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{tag}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

// ─── Inline Memory Editor ─────────────────────────────────────────────────

function InlineMemoryEditor({
	theme,
	initial,
	onSave,
	onCancel,
}: {
	theme: Theme;
	initial?: { content: string; type: MemoryType; tags: string[] };
	onSave: (content: string, type: MemoryType, tags: string[]) => void;
	onCancel: () => void;
}) {
	const [content, setContent] = useState(initial?.content ?? '');
	const [type, setType] = useState<MemoryType>(initial?.type ?? 'rule');
	const [tagsInput, setTagsInput] = useState(initial?.tags.join(', ') ?? '');
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		textareaRef.current?.focus();
	}, []);

	const handleSave = () => {
		if (!content.trim()) return;
		const tags = tagsInput
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		onSave(content.trim(), type, tags);
	};

	return (
		<div className="rounded-lg border p-3 space-y-2" style={{ borderColor: theme.colors.accent }}>
			<textarea
				ref={textareaRef}
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Memory content..."
				rows={3}
				className="w-full bg-transparent outline-none text-xs resize-none"
				style={{ color: theme.colors.textMain }}
				onKeyDown={(e) => {
					if (e.key === 'Escape') onCancel();
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSave();
				}}
			/>
			<div className="flex items-center gap-2">
				<select
					value={type}
					onChange={(e) => setType(e.target.value as MemoryType)}
					className="bg-transparent outline-none text-xs rounded px-1.5 py-0.5 border"
					style={{
						color: theme.colors.textMain,
						borderColor: theme.colors.border,
					}}
				>
					<option value="rule">Rule</option>
					<option value="experience">Experience</option>
				</select>
				<input
					type="text"
					value={tagsInput}
					onChange={(e) => setTagsInput(e.target.value)}
					placeholder="Tags (comma-separated)"
					className="flex-1 bg-transparent outline-none text-xs"
					style={{ color: theme.colors.textMain }}
				/>
			</div>
			<div className="flex items-center justify-end gap-2">
				<button
					className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					className="text-xs px-3 py-1 rounded font-medium hover:opacity-80 transition-opacity"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
					onClick={handleSave}
					disabled={!content.trim()}
				>
					{initial ? 'Save' : 'Add'}
				</button>
			</div>
		</div>
	);
}

// ─── Main Component ───────────────────────────────────────────────────────

export function MemoryLibraryPanel({
	theme,
	selectedNode,
	projectPath: _projectPath,
	agentType,
	store,
	roles,
	personas,
	skillAreas,
}: MemoryLibraryPanelProps): React.ReactElement {
	const { memories, loading, error } = store;

	// Search state
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
	const [searching, setSearching] = useState(false);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Filters
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
	const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

	// Archive state
	const [showArchived, setShowArchived] = useState(false);
	const [archivedMemories, setArchivedMemories] = useState<MemoryEntry[]>([]);
	const [archivedLoading, setArchivedLoading] = useState(false);

	// Inline editor state
	const [addingMemory, setAddingMemory] = useState(false);
	const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);

	// Derive scope from selectedNode for direct archive API calls
	const { scope: resolvedScope, skillAreaId: resolvedSkillAreaId } = useMemo(
		() => deriveScope(selectedNode),
		[selectedNode]
	);
	const resolvedProjectPath = _projectPath ?? undefined;

	// Reset filters when node changes
	useEffect(() => {
		setTypeFilter('all');
		setSelectedTags(new Set());
		setSearchQuery('');
		setSearchResults(null);
		setAddingMemory(false);
		setEditingMemoryId(null);
		setShowArchived(false);
	}, [selectedNode]);

	// Fetch archived memories for count display and archive view
	useEffect(() => {
		let cancelled = false;
		async function fetchArchived() {
			if (!selectedNode) {
				setArchivedMemories([]);
				return;
			}
			setArchivedLoading(true);
			try {
				const res = await window.maestro.memory.listArchived(
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
				if (!cancelled && res.success) {
					setArchivedMemories(res.data);
				}
			} catch {
				// Ignore — archive count is supplementary
			} finally {
				if (!cancelled) setArchivedLoading(false);
			}
		}
		fetchArchived();
		return () => {
			cancelled = true;
		};
	}, [selectedNode, resolvedScope, resolvedSkillAreaId, resolvedProjectPath]);

	// Debounced search
	useEffect(() => {
		if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

		if (searchQuery.length < 3) {
			setSearchResults(null);
			return;
		}

		searchTimerRef.current = setTimeout(async () => {
			setSearching(true);
			try {
				const results = await store.searchMemories(searchQuery, agentType ?? 'claude-code');
				setSearchResults(results);
			} catch {
				setSearchResults(null);
			} finally {
				setSearching(false);
			}
		}, 300);

		return () => {
			if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
		};
	}, [searchQuery, agentType, store]);

	// Derive unique tags from memories
	const allTags = useMemo(() => {
		const tagSet = new Set<string>();
		for (const m of memories) {
			for (const t of m.tags) tagSet.add(t);
		}
		return Array.from(tagSet).sort();
	}, [memories]);

	// Apply filters
	const filteredMemories = useMemo(() => {
		let result = memories;
		if (typeFilter !== 'all') {
			result = result.filter((m) => m.type === typeFilter);
		}
		if (selectedTags.size > 0) {
			result = result.filter((m) => m.tags.some((t) => selectedTags.has(t)));
		}
		// Pinned first, then by updatedAt desc
		return result.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return b.updatedAt - a.updatedAt;
		});
	}, [memories, typeFilter, selectedTags]);

	// Breadcrumb
	const breadcrumb = buildBreadcrumb(selectedNode, roles, personas, skillAreas);

	// ─── Handlers ─────────────────────────────────────────────────────────

	const handleAddMemory = useCallback(
		async (content: string, type: MemoryType, tags: string[]) => {
			try {
				// Derive personaId and roleId from the selected node for skill-scoped memories
				let personaId: string | undefined;
				let roleId: string | undefined;
				if (selectedNode?.type === 'skill') {
					const skill = skillAreas.find((s) => s.id === selectedNode.id);
					if (skill) {
						personaId = skill.personaId;
						const persona = personas.find((p) => p.id === skill.personaId);
						if (persona) roleId = persona.roleId;
					}
				}
				await store.addMemory({ content, type, tags, source: 'user', personaId, roleId });
			} catch {
				// Error from store
			}
			setAddingMemory(false);
		},
		[store, selectedNode, skillAreas, personas]
	);

	const handleUpdateMemory = useCallback(
		async (id: string, content: string, type: MemoryType, tags: string[]) => {
			try {
				await store.updateMemory(id, { content, type, tags });
			} catch {
				// Error from store
			}
			setEditingMemoryId(null);
		},
		[store]
	);

	const handleTogglePin = useCallback(
		async (memory: MemoryEntry) => {
			try {
				await store.updateMemory(memory.id, { pinned: !memory.pinned });
			} catch {
				// Error from store
			}
		},
		[store]
	);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await store.deleteMemory(id);
			} catch {
				// Error from store
			}
		},
		[store]
	);

	const handleRestore = useCallback(
		async (id: string) => {
			try {
				const res = await window.maestro.memory.restore(
					id,
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
				if (res.success) {
					// Remove from archived list
					setArchivedMemories((prev) => prev.filter((m) => m.id !== id));
					// Refresh normal memories to show restored entry
					store.refresh();
				}
			} catch {
				// Error from restore
			}
		},
		[resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]
	);

	const handleExport = useCallback(async () => {
		try {
			const data = await store.exportLibrary();
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `memories-${breadcrumb.join('-').replace(/\s+/g, '_')}.json`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			// Export error
		}
	}, [store, breadcrumb]);

	const handleImport = useCallback(async () => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const json = JSON.parse(text);
				await store.importLibrary(json);
			} catch {
				// Import error
			}
		};
		input.click();
	}, [store]);

	// ─── No Selection State ───────────────────────────────────────────────

	if (!selectedNode) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-2 p-4">
				<Brain className="w-8 h-8 opacity-20" style={{ color: theme.colors.textDim }} />
				<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
					Select a node from the tree to view memories.
				</div>
			</div>
		);
	}

	// ─── Render ───────────────────────────────────────────────────────────

	return (
		<div className="flex flex-col h-full">
			{/* Header: breadcrumb + actions */}
			<div
				className="shrink-0 px-3 py-2 border-b space-y-2"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Breadcrumb */}
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
						{breadcrumb.join(' > ')}
					</div>
					<div className="flex items-center gap-1">
						<button
							className="p-1 rounded hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							title="Export"
							onClick={handleExport}
						>
							<Download className="w-3.5 h-3.5" />
						</button>
						<button
							className="p-1 rounded hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							title="Import"
							onClick={handleImport}
						>
							<Upload className="w-3.5 h-3.5" />
						</button>
						<button
							className="p-1 rounded hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.accent }}
							title="Add Memory"
							onClick={() => setAddingMemory(true)}
						>
							<Plus className="w-3.5 h-3.5" />
						</button>
					</div>
				</div>

				{/* Search bar */}
				<div
					className="flex items-center gap-2 px-2 py-1.5 rounded-lg border"
					style={{ borderColor: theme.colors.border }}
				>
					{searching ? (
						<Loader2
							className="w-3.5 h-3.5 animate-spin shrink-0"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
					)}
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Search memories..."
						className="flex-1 bg-transparent outline-none text-xs"
						style={{ color: theme.colors.textMain }}
					/>
				</div>

				{/* Type filter */}
				<div className="flex items-center gap-1.5">
					{(['all', 'rule', 'experience'] as TypeFilter[]).map((f) => (
						<button
							key={f}
							className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
							style={{
								backgroundColor: typeFilter === f ? `${theme.colors.accent}20` : 'transparent',
								color: typeFilter === f ? theme.colors.accent : theme.colors.textDim,
								border: `1px solid ${typeFilter === f ? theme.colors.accent : theme.colors.border}`,
							}}
							onClick={() => setTypeFilter(f)}
						>
							{f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) + 's'}
						</button>
					))}

					{/* Memory count */}
					<span className="text-[10px] ml-auto" style={{ color: theme.colors.textDim }}>
						{showArchived
							? `${archivedMemories.length} archived`
							: `${filteredMemories.length} memor${filteredMemories.length === 1 ? 'y' : 'ies'}`}
					</span>

					{/* Archive toggle */}
					<button
						className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
						style={{
							backgroundColor: showArchived ? `${theme.colors.warning}20` : 'transparent',
							color: showArchived ? theme.colors.warning : theme.colors.textDim,
							border: `1px solid ${showArchived ? theme.colors.warning : theme.colors.border}`,
						}}
						onClick={() => setShowArchived(!showArchived)}
					>
						Archived ({archivedLoading ? '...' : archivedMemories.length})
					</button>
				</div>

				{/* Tag filter chips */}
				{allTags.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{allTags.map((tag) => {
							const isSelected = selectedTags.has(tag);
							return (
								<button
									key={tag}
									className="text-[10px] px-1.5 py-0.5 rounded-full transition-colors"
									style={{
										backgroundColor: isSelected
											? `${theme.colors.accent}25`
											: `${theme.colors.border}40`,
										color: isSelected ? theme.colors.accent : theme.colors.textDim,
									}}
									onClick={() => {
										setSelectedTags((prev) => {
											const next = new Set(prev);
											if (next.has(tag)) next.delete(tag);
											else next.add(tag);
											return next;
										});
									}}
								>
									{tag}
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Error */}
			{error && (
				<div
					className="flex items-center gap-2 px-3 py-2 text-xs"
					style={{ color: theme.colors.error }}
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					{error}
				</div>
			)}

			{/* Content */}
			<div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
				{/* Inline add form */}
				{addingMemory && !showArchived && (
					<InlineMemoryEditor
						theme={theme}
						onSave={handleAddMemory}
						onCancel={() => setAddingMemory(false)}
					/>
				)}

				{/* Loading */}
				{(showArchived ? archivedLoading : loading) && (
					<div
						className="flex items-center justify-center py-4 gap-2"
						style={{ color: theme.colors.textDim }}
					>
						<Loader2 className="w-4 h-4 animate-spin" />
						<span className="text-xs">Loading...</span>
					</div>
				)}

				{showArchived ? (
					/* Archived memories view */
					<>
						{!archivedLoading && archivedMemories.length === 0 && (
							<div className="flex flex-col items-center justify-center py-8 gap-2">
								<Brain className="w-6 h-6 opacity-20" style={{ color: theme.colors.textDim }} />
								<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
									No archived memories.
								</div>
							</div>
						)}

						{archivedMemories.map((memory) => (
							<MemoryCard
								key={memory.id}
								memory={memory}
								theme={theme}
								archived
								onRestore={() => handleRestore(memory.id)}
								onTogglePin={() => handleTogglePin(memory)}
								onEdit={() => {}}
								onDelete={() => handleDelete(memory.id)}
							/>
						))}
					</>
				) : searchResults !== null ? (
					/* Search results mode */
					searchResults.length === 0 ? (
						<div className="text-xs text-center py-4" style={{ color: theme.colors.textDim }}>
							No matching memories found.
						</div>
					) : (
						searchResults.map((result) => (
							<SearchResultCard key={result.entry.id} result={result} theme={theme} />
						))
					)
				) : (
					/* Normal list mode */
					<>
						{!loading && filteredMemories.length === 0 && (
							<div className="flex flex-col items-center justify-center py-8 gap-2">
								<Brain className="w-6 h-6 opacity-20" style={{ color: theme.colors.textDim }} />
								<div className="text-xs text-center" style={{ color: theme.colors.textDim }}>
									{selectedNode.type === 'role' || selectedNode.type === 'persona'
										? 'Select a skill area to view memories.'
										: 'No memories yet. Click + to add one.'}
								</div>
							</div>
						)}

						{filteredMemories.map((memory) =>
							editingMemoryId === memory.id ? (
								<InlineMemoryEditor
									key={memory.id}
									theme={theme}
									initial={{
										content: memory.content,
										type: memory.type,
										tags: memory.tags,
									}}
									onSave={(content, type, tags) =>
										handleUpdateMemory(memory.id, content, type, tags)
									}
									onCancel={() => setEditingMemoryId(null)}
								/>
							) : (
								<MemoryCard
									key={memory.id}
									memory={memory}
									theme={theme}
									onTogglePin={() => handleTogglePin(memory)}
									onEdit={() => setEditingMemoryId(memory.id)}
									onDelete={() => handleDelete(memory.id)}
								/>
							)
						)}
					</>
				)}
			</div>
		</div>
	);
}
