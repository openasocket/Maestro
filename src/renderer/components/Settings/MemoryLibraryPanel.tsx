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
	Link2,
	X,
	CheckSquare,
	Archive,
	Tag,
	FolderInput,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { TreeNode } from './MemoryTreeBrowser';
import type {
	MemoryEntry,
	MemorySearchResult,
	MemoryType,
	MemoryScope,
	MemorySource,
	SkillAreaId,
	Role,
	Persona,
	SkillArea,
} from '../../../shared/memory-types';
import type { UseMemoryStoreReturn } from '../../hooks/memory/useMemoryStore';
import { RoleDetailView, PersonaDetailView } from './EntityDetailView';
import { MemoryEditModal } from './MemoryEditModal';

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
	// Hierarchy CRUD for entity detail editing
	onUpdateRole?: (
		id: string,
		updates: { name?: string; description?: string; systemPrompt?: string }
	) => Promise<void>;
	onUpdatePersona?: (id: string, updates: Partial<Persona>) => Promise<void>;
}

type TypeFilter = 'all' | 'rule' | 'experience';
type SourceFilter = MemorySource | 'all';
type SortOption = 'newest' | 'oldest' | 'most-used' | 'most-effective' | 'highest-confidence';

const SOURCE_LABELS: Record<MemorySource | 'all', string> = {
	all: 'All Sources',
	user: 'Manual',
	'auto-run': 'Auto Run',
	'session-analysis': 'Extracted',
	consolidation: 'Consolidated',
	grpo: 'Promoted',
	import: 'Imported',
	repository: 'Repository',
};

const SORT_LABELS: Record<SortOption, string> = {
	newest: 'Newest first',
	oldest: 'Oldest first',
	'most-used': 'Most used',
	'most-effective': 'Most effective',
	'highest-confidence': 'Highest confidence',
};

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
	if (node.type === 'all-experiences') return ['All Experiences'];
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
	bulkMode,
	selected,
	onToggleSelect,
}: {
	memory: MemoryEntry;
	theme: Theme;
	onTogglePin: () => void;
	onEdit: () => void;
	onDelete: () => void;
	archived?: boolean;
	onRestore?: () => void;
	bulkMode?: boolean;
	selected?: boolean;
	onToggleSelect?: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [contextExpanded, setContextExpanded] = useState(false);
	const [relatedExpanded, setRelatedExpanded] = useState(false);
	const [linkedMemories, setLinkedMemories] = useState<MemoryEntry[]>([]);
	const [linkedLoading, setLinkedLoading] = useState(false);

	const loadLinkedMemories = useCallback(async () => {
		if (linkedMemories.length > 0 || linkedLoading) return;
		setLinkedLoading(true);
		try {
			const res = await window.maestro.memory.getLinked(
				memory.id,
				memory.scope,
				memory.skillAreaId,
				undefined // projectPath not available at card level
			);
			if (res?.success && res.data) {
				setLinkedMemories(res.data);
			}
		} catch {
			// Failed to load linked memories — non-critical
		} finally {
			setLinkedLoading(false);
		}
	}, [memory.id, memory.scope, memory.skillAreaId, linkedMemories.length, linkedLoading]);

	const handleToggleRelated = useCallback(() => {
		const next = !relatedExpanded;
		setRelatedExpanded(next);
		if (next) {
			loadLinkedMemories();
		}
	}, [relatedExpanded, loadLinkedMemories]);

	const handleUnlink = useCallback(
		async (linkedId: string, linkedScope: MemoryScope, linkedSkillAreaId?: string) => {
			try {
				await window.maestro.memory.unlink(
					memory.id,
					memory.scope,
					linkedId,
					linkedScope,
					memory.skillAreaId,
					undefined,
					linkedSkillAreaId,
					undefined
				);
				setLinkedMemories((prev) => prev.filter((m) => m.id !== linkedId));
			} catch {
				// Unlink failed — non-critical
			}
		},
		[memory.id, memory.scope, memory.skillAreaId]
	);

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
				{/* Bulk select checkbox */}
				{bulkMode && (
					<input
						type="checkbox"
						checked={!!selected}
						onChange={onToggleSelect}
						className="shrink-0 w-3.5 h-3.5 cursor-pointer accent-current"
						style={{ accentColor: theme.colors.accent }}
						onClick={(e) => e.stopPropagation()}
					/>
				)}
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

			{/* Metadata badges row */}
			<div className="flex items-center gap-2 text-[10px]" style={{ color: theme.colors.textDim }}>
				<span>{formatRelativeTime(memory.createdAt)}</span>
				{memory.useCount > 0 ? (
					<UseCountBadge useCount={memory.useCount} lastUsedAt={memory.lastUsedAt} theme={theme} />
				) : (
					memory.createdAt < Date.now() - 7 * 24 * 60 * 60 * 1000 && (
						<span style={{ color: '#ea8b23', opacity: 0.8 }}>Never used</span>
					)
				)}
				{memory.effectivenessScore > 0 && (
					<span
						className="flex items-center gap-1"
						title={`Effectiveness: ${(memory.effectivenessScore * 100).toFixed(1)}%`}
					>
						<span
							className="inline-block w-1.5 h-1.5 rounded-full"
							style={{
								backgroundColor:
									memory.effectivenessScore > 0.7
										? '#22c55e'
										: memory.effectivenessScore > 0.4
											? '#eab308'
											: '#ef4444',
							}}
						/>
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

			{/* Related memories — expandable */}
			{(memory.relatedMemoryIds?.length ?? 0) > 0 && (
				<div>
					<button
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
						onClick={handleToggleRelated}
					>
						{relatedExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						<Link2 className="w-3 h-3" />
						Related ({memory.relatedMemoryIds!.length})
					</button>
					{relatedExpanded && (
						<div className="mt-1 pl-4 space-y-1">
							{linkedLoading && (
								<div
									className="flex items-center gap-1 text-[10px]"
									style={{ color: theme.colors.textDim }}
								>
									<Loader2 className="w-3 h-3 animate-spin" />
									Loading...
								</div>
							)}
							{linkedMemories.map((linked) => (
								<div
									key={linked.id}
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
												linked.type === 'experience'
													? `${theme.colors.warning}20`
													: `${theme.colors.border}60`,
											color:
												linked.type === 'experience' ? theme.colors.warning : theme.colors.textDim,
										}}
									>
										{linked.type}
									</span>
									<span className="flex-1 truncate">
										{linked.content.length > 80
											? `${linked.content.slice(0, 80)}...`
											: linked.content}
									</span>
									{linked.effectivenessScore > 0 && (
										<span
											className="text-[10px] shrink-0"
											style={{ color: theme.colors.textDim }}
											title="Effectiveness"
										>
											{(linked.effectivenessScore * 100).toFixed(0)}%
										</span>
									)}
									<button
										className="p-0.5 rounded hover:opacity-80 transition-opacity shrink-0"
										style={{ color: theme.colors.error }}
										title="Unlink"
										onClick={() => handleUnlink(linked.id, linked.scope, linked.skillAreaId)}
									>
										<X className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}
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
				{memory.useCount > 0 ? (
					<UseCountBadge useCount={memory.useCount} lastUsedAt={memory.lastUsedAt} theme={theme} />
				) : (
					memory.createdAt < Date.now() - 7 * 24 * 60 * 60 * 1000 && (
						<span style={{ color: '#ea8b23', opacity: 0.8 }}>Never used</span>
					)
				)}
			</div>
		</div>
	);
}

/**
 * Clickable "Used Nx" badge that shows a tooltip with lastUsedAt on click.
 */
function UseCountBadge({
	useCount,
	lastUsedAt,
	theme,
}: {
	useCount: number;
	lastUsedAt: number;
	theme: Theme;
}) {
	const [showTooltip, setShowTooltip] = useState(false);

	return (
		<span className="relative inline-flex">
			<button
				className="px-1 py-0.5 rounded text-[10px] cursor-pointer hover:opacity-80 transition-opacity"
				style={{ backgroundColor: `${theme.colors.border}40` }}
				onClick={(e) => {
					e.stopPropagation();
					setShowTooltip(!showTooltip);
				}}
				onBlur={() => setShowTooltip(false)}
			>
				Used {useCount}x
			</button>
			{showTooltip && lastUsedAt > 0 && (
				<span
					className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded text-[10px] whitespace-nowrap z-50"
					style={{
						backgroundColor: theme.colors.bgMain,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
						boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
					}}
				>
					Last used: {formatRelativeTime(lastUsedAt)}
				</span>
			)}
		</span>
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
	onUpdateRole,
	onUpdatePersona,
}: MemoryLibraryPanelProps): React.ReactElement {
	const { memories, loading, error } = store;

	// Search state
	const [searchQuery, setSearchQuery] = useState('');
	const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
	const [searching, setSearching] = useState(false);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Filters
	const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
	const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
	const [sortBy, setSortBy] = useState<SortOption>('newest');
	const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
	const [neverInjectedOnly, setNeverInjectedOnly] = useState(false);

	// Archive state
	const [showArchived, setShowArchived] = useState(false);
	const [archivedMemories, setArchivedMemories] = useState<MemoryEntry[]>([]);
	const [archivedLoading, setArchivedLoading] = useState(false);

	// Bulk selection state
	const [bulkMode, setBulkMode] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	// Bulk operation state
	const [bulkOpProgress, setBulkOpProgress] = useState<{
		label: string;
		current: number;
		total: number;
	} | null>(null);
	const [bulkConfirm, setBulkConfirm] = useState<{ action: 'delete'; count: number } | null>(null);
	const [bulkTagInput, setBulkTagInput] = useState(false);
	const [bulkTagValue, setBulkTagValue] = useState('');
	const [bulkMoveOpen, setBulkMoveOpen] = useState(false);

	// Editor state
	const [addingMemory, setAddingMemory] = useState(false);
	const [editingMemory, setEditingMemory] = useState<MemoryEntry | null>(null);

	// Derive scope from selectedNode for direct archive API calls
	const { scope: resolvedScope, skillAreaId: resolvedSkillAreaId } = useMemo(
		() => deriveScope(selectedNode),
		[selectedNode]
	);
	const resolvedProjectPath = _projectPath ?? undefined;

	// Derive persona/role IDs from selected node for create modal defaults
	const { defaultPersonaId, defaultRoleId } = useMemo(() => {
		if (selectedNode?.type === 'skill') {
			const skill = skillAreas.find((s) => s.id === selectedNode.id);
			if (skill) {
				const persona = personas.find((p) => p.id === skill.personaId);
				return {
					defaultPersonaId: skill.personaId,
					defaultRoleId: persona?.roleId,
				};
			}
		}
		return { defaultPersonaId: undefined, defaultRoleId: undefined };
	}, [selectedNode, skillAreas, personas]);

	// Reset filters when node changes
	useEffect(() => {
		setTypeFilter('all');
		setSourceFilter('all');
		setSortBy('newest');
		setSelectedTags(new Set());
		setNeverInjectedOnly(false);
		setSearchQuery('');
		setSearchResults(null);
		setAddingMemory(false);
		setEditingMemory(null);
		setShowArchived(false);
		setBulkMode(false);
		setSelectedIds(new Set());
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

	// Apply filters and sorting
	const filteredMemories = useMemo(() => {
		let result = memories;
		if (typeFilter !== 'all') {
			result = result.filter((m) => m.type === typeFilter);
		}
		if (sourceFilter !== 'all') {
			result = result.filter((m) => m.source === sourceFilter);
		}
		if (selectedTags.size > 0) {
			result = result.filter((m) => m.tags.some((t) => selectedTags.has(t)));
		}
		if (neverInjectedOnly) {
			result = result.filter((m) => m.useCount === 0);
		}
		// Pinned first, then apply sort
		return result.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			switch (sortBy) {
				case 'oldest':
					return a.createdAt - b.createdAt;
				case 'most-used':
					return b.useCount - a.useCount;
				case 'most-effective':
					return b.effectivenessScore - a.effectivenessScore;
				case 'highest-confidence':
					return b.confidence - a.confidence;
				case 'newest':
				default:
					return b.createdAt - a.createdAt;
			}
		});
	}, [memories, typeFilter, sourceFilter, selectedTags, neverInjectedOnly, sortBy]);

	// Count of never-injected memories for the filter badge
	const neverInjectedCount = useMemo(
		() => memories.filter((m) => m.useCount === 0).length,
		[memories]
	);

	// Breadcrumb
	const breadcrumb = buildBreadcrumb(selectedNode, roles, personas, skillAreas);

	// ─── Handlers ─────────────────────────────────────────────────────────

	const handleToggleBulkMode = useCallback(() => {
		setBulkMode((prev) => {
			if (prev) setSelectedIds(new Set());
			return !prev;
		});
	}, []);

	const handleToggleSelect = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const handleSelectAll = useCallback(() => {
		setSelectedIds(new Set(filteredMemories.map((m) => m.id)));
	}, [filteredMemories]);

	const handleDeselectAll = useCallback(() => {
		setSelectedIds(new Set());
	}, []);

	// ─── Bulk Operations ──────────────────────────────────────────────

	const handleBulkDelete = useCallback(async () => {
		const ids = Array.from(selectedIds);
		setBulkConfirm(null);
		setBulkOpProgress({ label: 'Deleting', current: 0, total: ids.length });
		try {
			for (let i = 0; i < ids.length; i++) {
				setBulkOpProgress({ label: 'Deleting', current: i + 1, total: ids.length });
				await window.maestro.memory.delete(
					ids[i],
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
			}
		} catch {
			// Partial failure — still clear and refresh what we can
		} finally {
			setBulkOpProgress(null);
			setSelectedIds(new Set());
			store.refresh();
		}
	}, [selectedIds, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]);

	const handleBulkArchive = useCallback(async () => {
		const ids = Array.from(selectedIds);
		setBulkOpProgress({ label: 'Archiving', current: 0, total: ids.length });
		try {
			for (let i = 0; i < ids.length; i++) {
				setBulkOpProgress({ label: 'Archiving', current: i + 1, total: ids.length });
				await window.maestro.memory.update(
					ids[i],
					{ active: false },
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
			}
		} catch {
			// Partial failure
		} finally {
			setBulkOpProgress(null);
			setSelectedIds(new Set());
			store.refresh();
		}
	}, [selectedIds, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]);

	const handleBulkPin = useCallback(async () => {
		const ids = Array.from(selectedIds);
		setBulkOpProgress({ label: 'Pinning', current: 0, total: ids.length });
		try {
			for (let i = 0; i < ids.length; i++) {
				setBulkOpProgress({ label: 'Pinning', current: i + 1, total: ids.length });
				await window.maestro.memory.update(
					ids[i],
					{ pinned: true },
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
			}
		} catch {
			// Partial failure
		} finally {
			setBulkOpProgress(null);
			setSelectedIds(new Set());
			store.refresh();
		}
	}, [selectedIds, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]);

	const handleBulkUnpin = useCallback(async () => {
		const ids = Array.from(selectedIds);
		setBulkOpProgress({ label: 'Unpinning', current: 0, total: ids.length });
		try {
			for (let i = 0; i < ids.length; i++) {
				setBulkOpProgress({ label: 'Unpinning', current: i + 1, total: ids.length });
				await window.maestro.memory.update(
					ids[i],
					{ pinned: false },
					resolvedScope,
					resolvedSkillAreaId,
					resolvedProjectPath
				);
			}
		} catch {
			// Partial failure
		} finally {
			setBulkOpProgress(null);
			setSelectedIds(new Set());
			store.refresh();
		}
	}, [selectedIds, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]);

	const handleBulkTag = useCallback(
		async (rawInput: string) => {
			const newTags = rawInput
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			if (newTags.length === 0) return;
			const ids = Array.from(selectedIds);
			setBulkTagInput(false);
			setBulkTagValue('');
			setBulkOpProgress({ label: 'Tagging', current: 0, total: ids.length });
			try {
				for (let i = 0; i < ids.length; i++) {
					setBulkOpProgress({ label: 'Tagging', current: i + 1, total: ids.length });
					const memory = memories.find((m) => m.id === ids[i]);
					const existingTags = memory?.tags ?? [];
					const merged = [...new Set([...existingTags, ...newTags])];
					await window.maestro.memory.update(
						ids[i],
						{ tags: merged },
						resolvedScope,
						resolvedSkillAreaId,
						resolvedProjectPath
					);
				}
			} catch {
				// Partial failure
			} finally {
				setBulkOpProgress(null);
				setSelectedIds(new Set());
				store.refresh();
			}
		},
		[selectedIds, memories, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]
	);

	const handleBulkMove = useCallback(
		async (toScope: MemoryScope, toSkillAreaId?: string) => {
			const ids = Array.from(selectedIds);
			setBulkMoveOpen(false);
			setBulkOpProgress({ label: 'Moving', current: 0, total: ids.length });
			try {
				for (let i = 0; i < ids.length; i++) {
					setBulkOpProgress({ label: 'Moving', current: i + 1, total: ids.length });
					await window.maestro.memory.moveScope(
						ids[i],
						resolvedScope,
						resolvedSkillAreaId,
						resolvedScope === 'project' ? resolvedProjectPath : undefined,
						toScope,
						toSkillAreaId,
						toScope === 'project' ? resolvedProjectPath : undefined
					);
				}
			} catch {
				// Partial failure
			} finally {
				setBulkOpProgress(null);
				setSelectedIds(new Set());
				store.refresh();
			}
		},
		[selectedIds, resolvedScope, resolvedSkillAreaId, resolvedProjectPath, store]
	);

	// Available skills for the edit modal
	const availableSkills = useMemo(
		() =>
			skillAreas.map((s) => ({
				id: s.id as SkillAreaId,
				name: s.name,
				personaName: personas.find((p) => p.id === s.personaId)?.name ?? 'Unknown',
			})),
		[skillAreas, personas]
	);

	const handleSaveEdit = useCallback(
		async (data: {
			content: string;
			type: MemoryType;
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
				// Move to new scope via moveScope IPC
				await window.maestro.memory.moveScope(
					editingMemory.id,
					editingMemory.scope,
					editingMemory.skillAreaId,
					editingMemory.scope === 'project' ? resolvedProjectPath : undefined,
					data.scope,
					data.skillAreaId,
					data.scope === 'project' ? resolvedProjectPath : undefined
				);
			} else {
				// Update in place
				await store.updateMemory(editingMemory.id, {
					content: data.content,
					type: data.type,
					tags: data.tags,
					confidence: data.confidence,
					pinned: data.pinned,
					experienceContext: data.experienceContext,
				});
			}

			store.refresh();
		},
		[editingMemory, store, resolvedProjectPath]
	);

	const handleSaveCreate = useCallback(
		async (data: {
			content: string;
			type: MemoryType;
			scope: MemoryScope;
			skillAreaId?: SkillAreaId;
			personaId?: string;
			roleId?: string;
			tags: string[];
			confidence: number;
			pinned: boolean;
			experienceContext?: MemoryEntry['experienceContext'];
		}) => {
			const res = await window.maestro.memory.add(
				{
					content: data.content,
					type: data.type,
					scope: data.scope,
					skillAreaId: data.skillAreaId,
					personaId: data.personaId,
					roleId: data.roleId,
					tags: data.tags,
					source: 'user',
					confidence: data.confidence,
					pinned: data.pinned,
					experienceContext: data.experienceContext,
				},
				data.scope === 'project' ? resolvedProjectPath : undefined
			);
			if (!res.success) throw new Error(res.error);
			store.refresh();
		},
		[store, resolvedProjectPath]
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

	// ─── Role / Persona Detail View ──────────────────────────────────────

	if (selectedNode.type === 'role') {
		const role = roles.find((r) => r.id === selectedNode.id);
		if (role && onUpdateRole) {
			return <RoleDetailView theme={theme} role={role} onSave={onUpdateRole} />;
		}
	}

	if (selectedNode.type === 'persona') {
		const persona = personas.find((p) => p.id === selectedNode.id);
		const parentRole = persona ? roles.find((r) => r.id === persona.roleId) : undefined;
		if (persona && onUpdatePersona) {
			return (
				<PersonaDetailView
					theme={theme}
					persona={persona}
					parentRoleName={parentRole?.name ?? 'Unknown Role'}
					onSave={onUpdatePersona}
				/>
			);
		}
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
							style={{ color: bulkMode ? theme.colors.accent : theme.colors.textDim }}
							title={bulkMode ? 'Exit Select' : 'Select'}
							onClick={handleToggleBulkMode}
						>
							<CheckSquare className="w-3.5 h-3.5" />
						</button>
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

					{/* Never injected filter */}
					{neverInjectedCount > 0 && (
						<button
							className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
							style={{
								backgroundColor: neverInjectedOnly ? '#ea8b2320' : 'transparent',
								color: neverInjectedOnly ? '#ea8b23' : theme.colors.textDim,
								border: `1px solid ${neverInjectedOnly ? '#ea8b23' : theme.colors.border}`,
							}}
							onClick={() => setNeverInjectedOnly(!neverInjectedOnly)}
						>
							Never injected ({neverInjectedCount})
						</button>
					)}
				</div>

				{/* Source filter + Sort */}
				<div className="flex items-center gap-1.5">
					<select
						className="text-[10px] px-1.5 py-0.5 rounded font-medium outline-none cursor-pointer"
						style={{
							backgroundColor: sourceFilter !== 'all' ? `${theme.colors.accent}20` : 'transparent',
							color: sourceFilter !== 'all' ? theme.colors.accent : theme.colors.textDim,
							border: `1px solid ${sourceFilter !== 'all' ? theme.colors.accent : theme.colors.border}`,
						}}
						value={sourceFilter}
						onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
					>
						{(Object.keys(SOURCE_LABELS) as (MemorySource | 'all')[]).map((key) => (
							<option key={key} value={key}>
								{SOURCE_LABELS[key]}
							</option>
						))}
					</select>

					<div className="flex-1" />

					<select
						className="text-[10px] px-1.5 py-0.5 rounded font-medium outline-none cursor-pointer"
						style={{
							backgroundColor: 'transparent',
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.border}`,
						}}
						value={sortBy}
						onChange={(e) => setSortBy(e.target.value as SortOption)}
					>
						{(Object.keys(SORT_LABELS) as SortOption[]).map((key) => (
							<option key={key} value={key}>
								{SORT_LABELS[key]}
							</option>
						))}
					</select>
				</div>

				{/* Bulk mode controls */}
				{bulkMode && !showArchived && (
					<div className="flex items-center gap-2">
						<button
							className="text-[10px] px-2 py-0.5 rounded font-medium hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.accent }}
							onClick={handleSelectAll}
						>
							Select All
						</button>
						<button
							className="text-[10px] px-2 py-0.5 rounded font-medium hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
							onClick={handleDeselectAll}
						>
							Deselect All
						</button>
						<span className="text-[10px] ml-auto" style={{ color: theme.colors.accent }}>
							{selectedIds.size} selected
						</span>
					</div>
				)}

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

						{filteredMemories.map((memory) => (
							<MemoryCard
								key={memory.id}
								memory={memory}
								theme={theme}
								onTogglePin={() => handleTogglePin(memory)}
								onEdit={() => setEditingMemory(memory)}
								onDelete={() => handleDelete(memory.id)}
								bulkMode={bulkMode}
								selected={selectedIds.has(memory.id)}
								onToggleSelect={() => handleToggleSelect(memory.id)}
							/>
						))}
					</>
				)}
			</div>

			{/* Bulk Action Toolbar */}
			{bulkMode && selectedIds.size > 0 && !showArchived && (
				<div
					className="shrink-0 flex items-center gap-2 px-3 py-2 border-t"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						boxShadow: '0 -2px 8px rgba(0,0,0,0.15)',
					}}
				>
					{bulkOpProgress ? (
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textMain }}
						>
							<Loader2 className="w-3.5 h-3.5 animate-spin" />
							{bulkOpProgress.label} {bulkOpProgress.current}/{bulkOpProgress.total}...
						</div>
					) : bulkConfirm ? (
						<>
							<span className="text-xs" style={{ color: theme.colors.error }}>
								Delete {bulkConfirm.count} memor{bulkConfirm.count === 1 ? 'y' : 'ies'}? This cannot
								be undone.
							</span>
							<div className="flex-1" />
							<button
								className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim }}
								onClick={() => setBulkConfirm(null)}
							>
								Cancel
							</button>
							<button
								className="text-xs px-2 py-1 rounded font-medium hover:opacity-80 transition-opacity"
								style={{ backgroundColor: theme.colors.error, color: '#fff' }}
								onClick={handleBulkDelete}
							>
								Confirm Delete
							</button>
						</>
					) : bulkTagInput ? (
						<form
							className="flex items-center gap-2 flex-1"
							onSubmit={(e) => {
								e.preventDefault();
								handleBulkTag(bulkTagValue);
							}}
						>
							<Tag className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
							<input
								autoFocus
								className="flex-1 text-xs px-2 py-1 rounded border outline-none"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
								placeholder="tag1, tag2, tag3..."
								value={bulkTagValue}
								onChange={(e) => setBulkTagValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										setBulkTagInput(false);
										setBulkTagValue('');
									}
								}}
							/>
							<button
								type="submit"
								className="text-xs px-2 py-1 rounded font-medium hover:opacity-80 transition-opacity"
								style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
							>
								Apply
							</button>
							<button
								type="button"
								className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim }}
								onClick={() => {
									setBulkTagInput(false);
									setBulkTagValue('');
								}}
							>
								Cancel
							</button>
						</form>
					) : bulkMoveOpen ? (
						<div className="flex items-center gap-1 flex-1 flex-wrap">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Move to:
							</span>
							{resolvedScope !== 'project' && (
								<button
									className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
									style={{
										color: theme.colors.textMain,
										backgroundColor: `${theme.colors.border}60`,
									}}
									onClick={() => handleBulkMove('project')}
								>
									Project
								</button>
							)}
							{resolvedScope !== 'global' && (
								<button
									className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
									style={{
										color: theme.colors.textMain,
										backgroundColor: `${theme.colors.border}60`,
									}}
									onClick={() => handleBulkMove('global')}
								>
									Global
								</button>
							)}
							{skillAreas
								.filter((s) => s.id !== resolvedSkillAreaId)
								.map((s) => (
									<button
										key={s.id}
										className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
										style={{
											color: theme.colors.textMain,
											backgroundColor: `${theme.colors.border}60`,
										}}
										onClick={() => handleBulkMove('skill', s.id)}
										title={`Move to skill: ${s.name}`}
									>
										{s.name}
									</button>
								))}
							<div className="flex-1" />
							<button
								className="text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim }}
								onClick={() => setBulkMoveOpen(false)}
							>
								Cancel
							</button>
						</div>
					) : (
						<>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{ color: '#fff', backgroundColor: theme.colors.error }}
								title="Delete selected"
								onClick={() => setBulkConfirm({ action: 'delete', count: selectedIds.size })}
							>
								<Trash2 className="w-3 h-3" />
								Delete
							</button>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: theme.colors.textMain,
									backgroundColor: `${theme.colors.border}60`,
								}}
								title="Archive selected"
								onClick={handleBulkArchive}
							>
								<Archive className="w-3 h-3" />
								Archive
							</button>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: theme.colors.textMain,
									backgroundColor: `${theme.colors.border}60`,
								}}
								title="Pin selected"
								onClick={handleBulkPin}
							>
								<Pin className="w-3 h-3" />
								Pin
							</button>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: theme.colors.textMain,
									backgroundColor: `${theme.colors.border}60`,
								}}
								title="Unpin selected"
								onClick={handleBulkUnpin}
							>
								<PinOff className="w-3 h-3" />
								Unpin
							</button>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: theme.colors.textMain,
									backgroundColor: `${theme.colors.border}60`,
								}}
								title="Tag selected"
								onClick={() => setBulkTagInput(true)}
							>
								<Tag className="w-3 h-3" />
								Tag
							</button>
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: theme.colors.textMain,
									backgroundColor: `${theme.colors.border}60`,
								}}
								title="Move selected to another scope"
								onClick={() => setBulkMoveOpen(true)}
							>
								<FolderInput className="w-3 h-3" />
								Move
							</button>
						</>
					)}
				</div>
			)}

			{/* Edit Modal */}
			{editingMemory && (
				<MemoryEditModal
					theme={theme}
					memory={editingMemory}
					defaultScope={resolvedScope}
					defaultSkillAreaId={resolvedSkillAreaId}
					availableSkills={availableSkills}
					onSave={handleSaveEdit}
					onClose={() => setEditingMemory(null)}
				/>
			)}

			{/* Create Modal */}
			{addingMemory && (
				<MemoryEditModal
					theme={theme}
					memory={null}
					defaultScope={resolvedScope}
					defaultSkillAreaId={resolvedSkillAreaId}
					defaultPersonaId={defaultPersonaId}
					defaultRoleId={defaultRoleId}
					availableSkills={availableSkills}
					onSave={handleSaveCreate}
					onClose={() => setAddingMemory(false)}
				/>
			)}
		</div>
	);
}
