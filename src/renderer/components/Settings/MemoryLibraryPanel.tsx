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
	BarChart3,
	RotateCcw,
	Link2,
	X,
	CheckSquare,
	Archive,
	Tag,
	FolderInput,
	Layers,
	Copy,
	ClipboardPaste,
	Filter,
	FileDown,
	FileUp,
	Check,
	ArrowUpCircle,
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
	ExperienceContext,
} from '../../../shared/memory-types';
import type { UseMemoryStoreReturn } from '../../hooks/memory/useMemoryStore';
import { RoleDetailView, PersonaDetailView } from './EntityDetailView';
import { MemoryEditModal } from './MemoryEditModal';
import {
	MemoryMovePromotePopover,
	PromotionDialog,
	ScopeConfirmDialog,
	type MovePromoteAction,
} from './MemoryMovePromotePopover';

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
type SearchMode = 'smart' | 'keyword' | 'tags';

const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
	smart: 'Smart',
	keyword: 'Keyword',
	tags: 'Tags',
};

const SEARCH_MODE_STRATEGY: Record<SearchMode, 'cascading' | 'keyword' | 'tag'> = {
	smart: 'cascading',
	keyword: 'keyword',
	tags: 'tag',
};

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
	onAddContext,
	onCopy,
	copied,
	agentType,
	projectPath,
	archived,
	onRestore,
	bulkMode,
	selected,
	onToggleSelect,
	onMovePromote,
	skillAreas,
	personas,
}: {
	memory: MemoryEntry;
	theme: Theme;
	onTogglePin: () => void;
	onEdit: () => void;
	onDelete: () => void;
	onAddContext?: () => void;
	onCopy?: () => void;
	copied?: boolean;
	agentType?: string;
	projectPath?: string;
	archived?: boolean;
	onRestore?: () => void;
	bulkMode?: boolean;
	selected?: boolean;
	onToggleSelect?: () => void;
	onMovePromote?: (action: MovePromoteAction) => void;
	skillAreas?: SkillArea[];
	personas?: Persona[];
}) {
	const [expanded, setExpanded] = useState(false);
	const [contextExpanded, setContextExpanded] = useState(false);
	const [originExpanded, setOriginExpanded] = useState(false);
	const [relatedExpanded, setRelatedExpanded] = useState(false);
	const [linkedMemories, setLinkedMemories] = useState<MemoryEntry[]>([]);
	const [linkedLoading, setLinkedLoading] = useState(false);
	const [similarExpanded, setSimilarExpanded] = useState(false);
	const [similarMemories, setSimilarMemories] = useState<MemorySearchResult[] | null>(null);
	const [similarLoading, setSimilarLoading] = useState(false);

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

	const loadSimilarMemories = useCallback(async () => {
		if (similarMemories !== null || similarLoading) return;
		setSimilarLoading(true);
		try {
			const res = await window.maestro.memory.search(
				memory.content.slice(0, 200),
				agentType ?? 'claude-code',
				projectPath
			);
			if (res?.success && res.data) {
				// Exclude the source memory and limit to top 5
				const filtered = res.data.filter((r) => r.entry.id !== memory.id).slice(0, 5);
				setSimilarMemories(filtered);
			} else {
				setSimilarMemories([]);
			}
		} catch {
			setSimilarMemories([]);
		} finally {
			setSimilarLoading(false);
		}
	}, [memory.id, memory.content, agentType, projectPath, similarMemories, similarLoading]);

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
				{!archived && (
					<button
						className="p-0.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: similarExpanded ? theme.colors.accent : theme.colors.textDim }}
						title="Find Similar"
						onClick={() => {
							const next = !similarExpanded;
							setSimilarExpanded(next);
							if (next) loadSimilarMemories();
						}}
					>
						<Layers className="w-3 h-3" />
					</button>
				)}
				{!archived && onMovePromote && (
					<MemoryMovePromotePopover
						memory={memory}
						theme={theme}
						skillAreas={skillAreas}
						personas={personas}
						onAction={onMovePromote}
					/>
				)}
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
				{onCopy && (
					<button
						className="p-0.5 rounded hover:opacity-80 transition-opacity"
						style={{ color: copied ? theme.colors.accent : theme.colors.textDim }}
						title={copied ? 'Copied!' : 'Copy to Clipboard'}
						onClick={onCopy}
					>
						{copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
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
				<EffectivenessBadge memory={memory} />
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

			{/* Rule context (experienceContext on a rule) — expandable */}
			{!isExperience && memory.experienceContext && (
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

			{/* Source origin — expandable, for rules with non-user sources */}
			{!isExperience && memory.source !== 'user' && (
				<div>
					<button
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
						onClick={() => setOriginExpanded(!originExpanded)}
					>
						{originExpanded ? (
							<ChevronDown className="w-3 h-3" />
						) : (
							<ChevronRight className="w-3 h-3" />
						)}
						Origin
					</button>
					{originExpanded && (
						<div className="mt-1 pl-4 text-xs" style={{ color: theme.colors.textDim }}>
							{memory.source === 'auto-run' && (
								<div>
									Auto-detected from repeated task pattern — {formatRelativeTime(memory.createdAt)}
									{memory.tags.length > 0 && (
										<div className="mt-0.5">Related tags: {memory.tags.join(', ')}</div>
									)}
								</div>
							)}
							{memory.source === 'consolidation' && (
								<div>
									Consolidated from similar memories — {formatRelativeTime(memory.createdAt)}
								</div>
							)}
							{memory.source === 'grpo' && (
								<div>Promoted from experience — {formatRelativeTime(memory.createdAt)}</div>
							)}
							{memory.source === 'session-analysis' && (
								<div>Extracted from session analysis — {formatRelativeTime(memory.createdAt)}</div>
							)}
							{memory.source === 'import' && (
								<div>Imported — {formatRelativeTime(memory.createdAt)}</div>
							)}
							{memory.source === 'repository' && (
								<div>
									From Global Experience Repository — {formatRelativeTime(memory.createdAt)}
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{/* Add Context action for rules without experienceContext */}
			{!isExperience && !memory.experienceContext && onAddContext && !archived && (
				<button
					className="text-[10px] font-medium hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.accent }}
					onClick={onAddContext}
				>
					+ Add Context
				</button>
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

			{/* Similar memories — expandable */}
			{similarExpanded && (
				<div>
					<div
						className="flex items-center gap-1 text-[10px] font-medium"
						style={{ color: theme.colors.textDim }}
					>
						<Layers className="w-3 h-3" />
						Similar Memories
					</div>
					<div className="mt-1 pl-4 space-y-1">
						{similarLoading && (
							<div
								className="flex items-center gap-1 text-[10px]"
								style={{ color: theme.colors.textDim }}
							>
								<Loader2 className="w-3 h-3 animate-spin" />
								Finding similar...
							</div>
						)}
						{similarMemories && similarMemories.length === 0 && !similarLoading && (
							<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
								No similar memories found.
							</div>
						)}
						{similarMemories?.map((result) => (
							<div
								key={result.entry.id}
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
											result.entry.type === 'experience'
												? `${theme.colors.warning}20`
												: `${theme.colors.border}60`,
										color:
											result.entry.type === 'experience'
												? theme.colors.warning
												: theme.colors.textDim,
									}}
								>
									{result.entry.type}
								</span>
								<span className="flex-1 truncate">
									{result.entry.content.length > 80
										? `${result.entry.content.slice(0, 80)}...`
										: result.entry.content}
								</span>
								<span
									className="text-[10px] font-mono shrink-0 px-1 py-0.5 rounded"
									style={{
										backgroundColor: `${theme.colors.accent}15`,
										color: theme.colors.accent,
									}}
								>
									{(result.similarity * 100).toFixed(0)}%
								</span>
							</div>
						))}
					</div>
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
				<EffectivenessBadge memory={memory} />

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
 * Colored effectiveness badge: green (>0.7), yellow (0.4-0.7), red (<0.4), gray (no data).
 */
function EffectivenessBadge({ memory }: { memory: MemoryEntry }) {
	const hasData = memory.effectivenessUpdatedAt > 0 || memory.effectivenessScore !== 0.5;
	const score = memory.effectivenessScore;

	let color: string;
	let bgColor: string;
	let label: string;

	if (!hasData) {
		color = '#9ca3af';
		bgColor = '#9ca3af20';
		label = 'No data';
	} else if (score > 0.7) {
		color = '#22c55e';
		bgColor = '#22c55e20';
		label = `${(score * 100).toFixed(0)}%`;
	} else if (score > 0.4) {
		color = '#eab308';
		bgColor = '#eab30820';
		label = `${(score * 100).toFixed(0)}%`;
	} else {
		color = '#ef4444';
		bgColor = '#ef444420';
		label = `${(score * 100).toFixed(0)}%`;
	}

	return (
		<span
			className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[10px] font-medium"
			style={{ backgroundColor: bgColor, color }}
			title={`Effectiveness: ${hasData ? `${(score * 100).toFixed(1)}%` : 'Not yet evaluated'}`}
		>
			<span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
			{label}
		</span>
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
	const [searchMode, setSearchMode] = useState<SearchMode>('smart');
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
	const [bulkResult, setBulkResult] = useState<string | null>(null);

	// Export/Import UI state
	const [exportDropdownOpen, setExportDropdownOpen] = useState(false);
	const [importPreview, setImportPreview] = useState<{
		memories: Array<{
			content: string;
			type?: MemoryType;
			tags?: string[];
			confidence?: number;
			pinned?: boolean;
			experienceContext?: ExperienceContext;
		}>;
		newCount: number;
		duplicateCount: number;
		typeBreakdown: Record<string, number>;
		targetScope: MemoryScope;
	} | null>(null);
	const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(
		null
	);
	const [importResult, setImportResult] = useState<{
		imported: number;
		skipped: number;
	} | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const exportDropdownRef = useRef<HTMLDivElement>(null);

	// Editor state
	const [addingMemory, setAddingMemory] = useState(false);
	const [editingMemory, setEditingMemory] = useState<MemoryEntry | null>(null);
	const [editShowContext, setEditShowContext] = useState(false);

	// Promotion-ready filter
	const [promotionReadyOnly, setPromotionReadyOnly] = useState(false);
	const [promotionReadyIds, setPromotionReadyIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await window.maestro.memory.getPromotionCandidates();
				if (!cancelled && res.success) {
					setPromotionReadyIds(new Set(res.data.map((c) => c.memory.id)));
				}
			} catch {
				// Non-critical
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [memories]);

	// Move/Promote dialog state
	const [promotingMemory, setPromotingMemory] = useState<MemoryEntry | null>(null);
	const [scopeConfirm, setScopeConfirm] = useState<{
		memory: MemoryEntry;
		direction: 'to-global' | 'to-project';
	} | null>(null);
	const [_demotionHelperText, setDemotionHelperText] = useState<string | null>(null);

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
		setSearchMode('smart');
		setTagCloudExpanded(false);
		setAddingMemory(false);
		setEditingMemory(null);
		setEditShowContext(false);
		setShowArchived(false);
		setBulkMode(false);
		setSelectedIds(new Set());
		setPromotingMemory(null);
		setScopeConfirm(null);
		setDemotionHelperText(null);
		setPromotionReadyOnly(false);
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

		const minLen = searchMode === 'tags' ? 1 : 3;
		if (searchQuery.length < minLen) {
			setSearchResults(null);
			return;
		}

		searchTimerRef.current = setTimeout(async () => {
			setSearching(true);
			try {
				const strategy = SEARCH_MODE_STRATEGY[searchMode];
				const results = await store.searchMemories(
					searchQuery,
					agentType ?? 'claude-code',
					strategy
				);
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
	}, [searchQuery, searchMode, agentType, store]);

	// Tag cloud state
	const [tagCloudExpanded, setTagCloudExpanded] = useState(false);

	// Derive unique tags with counts from memories
	const tagCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const m of memories) {
			for (const t of m.tags) {
				counts.set(t, (counts.get(t) ?? 0) + 1);
			}
		}
		return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
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
		if (promotionReadyOnly) {
			result = result.filter((m) => promotionReadyIds.has(m.id));
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
	}, [
		memories,
		typeFilter,
		sourceFilter,
		selectedTags,
		neverInjectedOnly,
		promotionReadyOnly,
		promotionReadyIds,
		sortBy,
	]);

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

	const handleBulkPromote = useCallback(async () => {
		const ids = Array.from(selectedIds);
		const experienceIds = ids.filter((id) => {
			const m = memories.find((mem) => mem.id === id);
			return m?.type === 'experience';
		});
		const skipped = ids.length - experienceIds.length;
		let promoted = 0;
		setBulkOpProgress({ label: 'Promoting', current: 0, total: experienceIds.length });
		try {
			for (let i = 0; i < experienceIds.length; i++) {
				setBulkOpProgress({ label: 'Promoting', current: i + 1, total: experienceIds.length });
				const mem = memories.find((m) => m.id === experienceIds[i]);
				if (!mem) continue;
				const ruleText = mem.experienceContext?.learning ?? mem.content;
				await window.maestro.memory.promote(
					mem.id,
					ruleText,
					mem.scope as string,
					mem.skillAreaId,
					mem.scope === 'project' ? resolvedProjectPath : undefined
				);
				promoted++;
			}
		} catch {
			// Partial failure
		} finally {
			setBulkOpProgress(null);
			setSelectedIds(new Set());
			setBulkResult(
				`Promoted ${promoted} experience${promoted !== 1 ? 's' : ''} to rules` +
					(skipped > 0 ? `, ${skipped} skipped (already rules)` : '')
			);
			setTimeout(() => setBulkResult(null), 4000);
			store.refresh();
		}
	}, [selectedIds, memories, resolvedProjectPath, store]);

	// Check if all selected are experiences (for enabling bulk promote)
	const allSelectedAreExperiences = useMemo(() => {
		if (selectedIds.size === 0) return false;
		return Array.from(selectedIds).every((id) => {
			const m = memories.find((mem) => mem.id === id);
			return m?.type === 'experience';
		});
	}, [selectedIds, memories]);

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

	// ─── Move/Promote Handlers ──────────────────────────────────────────

	const handleMovePromote = useCallback(
		(action: MovePromoteAction) => {
			switch (action.kind) {
				case 'promote-to-rule':
					setPromotingMemory(action.memory);
					break;
				case 'demote-to-experience':
					// Open edit modal with type changed to experience and helper text
					setDemotionHelperText(
						'Converting to experience — add context about when this was learned'
					);
					setEditShowContext(true);
					setEditingMemory({
						...action.memory,
						type: 'experience',
						experienceContext: action.memory.experienceContext ?? {
							situation: '',
							learning: action.memory.content,
						},
					});
					break;
				case 'scope-to-global':
					setScopeConfirm({ memory: action.memory, direction: 'to-global' });
					break;
				case 'scope-to-project':
					setScopeConfirm({ memory: action.memory, direction: 'to-project' });
					break;
				case 'move-to-skill':
				case 'assign-skill':
					(async () => {
						try {
							await window.maestro.memory.moveScope(
								action.memory.id,
								action.memory.scope,
								action.memory.skillAreaId,
								action.memory.scope === 'project' ? resolvedProjectPath : undefined,
								'skill',
								action.skillAreaId,
								undefined
							);
							store.refresh();
						} catch {
							// Move failed
						}
					})();
					break;
			}
		},
		[resolvedProjectPath, store]
	);

	const handlePromoteConfirm = useCallback(
		async (ruleText: string, archiveSource: boolean) => {
			if (!promotingMemory) return;
			try {
				await window.maestro.memory.promote(
					promotingMemory.id,
					ruleText,
					promotingMemory.scope as string,
					promotingMemory.skillAreaId,
					promotingMemory.scope === 'project' ? resolvedProjectPath : undefined
				);
				if (archiveSource) {
					await window.maestro.memory.update(
						promotingMemory.id,
						{ active: false },
						promotingMemory.scope,
						promotingMemory.skillAreaId,
						promotingMemory.scope === 'project' ? resolvedProjectPath : undefined
					);
				}
				store.refresh();
			} catch {
				// Promotion failed
			} finally {
				setPromotingMemory(null);
			}
		},
		[promotingMemory, resolvedProjectPath, store]
	);

	const handleScopeConfirm = useCallback(
		async (keepCopy: boolean) => {
			if (!scopeConfirm) return;
			const { memory, direction } = scopeConfirm;
			try {
				const toScope: MemoryScope = direction === 'to-global' ? 'global' : 'project';

				if (keepCopy) {
					// Add a copy in the new scope, keep original
					await window.maestro.memory.add(
						{
							content: memory.content,
							type: memory.type,
							scope: toScope,
							tags: memory.tags,
							source: memory.source,
							confidence: memory.confidence,
							pinned: memory.pinned,
							experienceContext: memory.experienceContext,
						},
						toScope === 'project' ? resolvedProjectPath : undefined
					);
				} else {
					// Move to new scope
					await window.maestro.memory.moveScope(
						memory.id,
						memory.scope,
						memory.skillAreaId,
						memory.scope === 'project' ? resolvedProjectPath : undefined,
						toScope,
						undefined,
						toScope === 'project' ? resolvedProjectPath : undefined
					);
				}
				store.refresh();
			} catch {
				// Scope change failed
			} finally {
				setScopeConfirm(null);
			}
		},
		[scopeConfirm, resolvedProjectPath, store]
	);

	// ─── Export Helpers ──────────────────────────────────────────────────

	const buildExportPayload = useCallback(
		(memoriesToExport: MemoryEntry[]) => ({
			version: 1,
			exportedAt: new Date().toISOString(),
			scope: resolvedScope,
			memoryCount: memoriesToExport.length,
			memories: memoriesToExport.map((m) => ({
				content: m.content,
				type: m.type,
				tags: m.tags,
				confidence: m.confidence,
				pinned: m.pinned,
				source: m.source,
				experienceContext: m.experienceContext,
			})),
		}),
		[resolvedScope]
	);

	const downloadJson = useCallback(
		(data: unknown, suffix: string) => {
			const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `memories-${breadcrumb.join('-').replace(/\s+/g, '_')}-${suffix}.json`;
			a.click();
			URL.revokeObjectURL(url);
		},
		[breadcrumb]
	);

	const handleExportCurrentView = useCallback(() => {
		const exported = buildExportPayload(filteredMemories);
		downloadJson(exported, 'filtered');
		setExportDropdownOpen(false);
	}, [filteredMemories, buildExportPayload, downloadJson]);

	const handleExportAllInScope = useCallback(async () => {
		try {
			const data = await store.exportLibrary();
			const exported = buildExportPayload(data.memories);
			downloadJson(exported, 'all');
		} catch {
			// Export error
		}
		setExportDropdownOpen(false);
	}, [store, buildExportPayload, downloadJson]);

	const handleExportSelected = useCallback(() => {
		const selected = memories.filter((m) => selectedIds.has(m.id));
		const exported = buildExportPayload(selected);
		downloadJson(exported, 'selected');
		setExportDropdownOpen(false);
	}, [memories, selectedIds, buildExportPayload, downloadJson]);

	// Close export dropdown on outside click
	useEffect(() => {
		if (!exportDropdownOpen) return;
		const handler = (e: MouseEvent) => {
			if (exportDropdownRef.current && !exportDropdownRef.current.contains(e.target as Node)) {
				setExportDropdownOpen(false);
			}
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [exportDropdownOpen]);

	// ─── Import Helpers ──────────────────────────────────────────────────

	const handleImport = useCallback(() => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const json = JSON.parse(text);
				const importMemories: Array<{
					content: string;
					type?: MemoryType;
					tags?: string[];
					confidence?: number;
					pinned?: boolean;
					experienceContext?: ExperienceContext;
				}> = json.memories ?? [];

				// Duplicate detection: compare by content
				const existingContents = new Set(memories.map((m) => m.content.trim().toLowerCase()));
				let newCount = 0;
				let duplicateCount = 0;
				const typeBreakdown: Record<string, number> = {};
				for (const m of importMemories) {
					const key = m.content.trim().toLowerCase();
					if (existingContents.has(key)) {
						duplicateCount++;
					} else {
						newCount++;
					}
					const t = m.type ?? 'rule';
					typeBreakdown[t] = (typeBreakdown[t] ?? 0) + 1;
				}

				setImportPreview({
					memories: importMemories,
					newCount,
					duplicateCount,
					typeBreakdown,
					targetScope: resolvedScope,
				});
			} catch {
				// Parse error
			}
		};
		input.click();
	}, [memories, resolvedScope]);

	const handleImportConfirm = useCallback(async () => {
		if (!importPreview) return;
		const existingContents = new Set(memories.map((m) => m.content.trim().toLowerCase()));
		const toImport = importPreview.memories.filter(
			(m) => !existingContents.has(m.content.trim().toLowerCase())
		);
		setImportProgress({ current: 0, total: toImport.length });
		let imported = 0;
		for (const m of toImport) {
			try {
				await store.addMemory({
					content: m.content,
					type: m.type,
					tags: m.tags,
					confidence: m.confidence,
					pinned: m.pinned,
					experienceContext: m.experienceContext,
				});
				imported++;
				setImportProgress({ current: imported, total: toImport.length });
			} catch {
				// Skip failed
			}
		}
		setImportResult({ imported, skipped: importPreview.duplicateCount });
		setImportPreview(null);
		setImportProgress(null);
		store.refresh();
	}, [importPreview, memories, store]);

	const handleImportCancel = useCallback(() => {
		setImportPreview(null);
		setImportProgress(null);
		setImportResult(null);
	}, []);

	// ─── Clipboard Helpers ───────────────────────────────────────────────

	const handleCopyMemory = useCallback(async (memory: MemoryEntry) => {
		const payload = {
			content: memory.content,
			type: memory.type,
			tags: memory.tags,
			...(memory.experienceContext ? { experienceContext: memory.experienceContext } : {}),
		};
		await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
		setCopiedId(memory.id);
		setTimeout(() => setCopiedId(null), 1500);
	}, []);

	const [pastedMemory, setPastedMemory] = useState<MemoryEntry | null>(null);

	const handlePasteFromClipboard = useCallback(async () => {
		try {
			const text = await navigator.clipboard.readText();
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed.content === 'string') {
				const pasted = {
					id: '__pasted__',
					content: parsed.content,
					type: parsed.type ?? 'rule',
					scope: resolvedScope,
					tags: parsed.tags ?? [],
					confidence: parsed.confidence ?? 0.5,
					pinned: false,
					active: true,
					useCount: 0,
					effectivenessScore: 0,
					effectivenessDelta: 0,
					effectivenessUpdatedAt: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					source: 'user' as const,
					experienceContext: parsed.experienceContext,
				} as MemoryEntry;
				setPastedMemory(pasted);
			}
		} catch {
			// Invalid clipboard content or parse error
		}
	}, [resolvedScope]);

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
						{/* Export dropdown */}
						<div className="relative" ref={exportDropdownRef}>
							<button
								className="p-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: exportDropdownOpen ? theme.colors.accent : theme.colors.textDim,
								}}
								title="Export"
								onClick={() => setExportDropdownOpen((p) => !p)}
							>
								<Download className="w-3.5 h-3.5" />
							</button>
							{exportDropdownOpen && (
								<div
									className="absolute right-0 top-full mt-1 z-50 rounded-lg border shadow-lg py-1 min-w-[180px]"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										borderColor: theme.colors.border,
									}}
								>
									<button
										className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80"
										style={{ color: theme.colors.textMain }}
										onClick={handleExportCurrentView}
									>
										<Filter className="w-3 h-3" style={{ color: theme.colors.textDim }} />
										Export Current View
										<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
											{filteredMemories.length}
										</span>
									</button>
									<button
										className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80"
										style={{ color: theme.colors.textMain }}
										onClick={handleExportAllInScope}
									>
										<FileDown className="w-3 h-3" style={{ color: theme.colors.textDim }} />
										Export All in Scope
										<span className="ml-auto text-[10px]" style={{ color: theme.colors.textDim }}>
											{memories.length}
										</span>
									</button>
									{bulkMode && selectedIds.size > 0 && (
										<button
											className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:opacity-80"
											style={{ color: theme.colors.accent }}
											onClick={handleExportSelected}
										>
											<CheckSquare className="w-3 h-3" style={{ color: theme.colors.accent }} />
											Export Selected
											<span className="ml-auto text-[10px]" style={{ color: theme.colors.accent }}>
												{selectedIds.size}
											</span>
										</button>
									)}
								</div>
							)}
						</div>
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
							style={{ color: theme.colors.textDim }}
							title="Paste from Clipboard"
							onClick={handlePasteFromClipboard}
						>
							<ClipboardPaste className="w-3.5 h-3.5" />
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
				<div className="flex items-center gap-1.5">
					<div
						className="flex items-center gap-2 px-2 py-1.5 rounded-lg border flex-1"
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
							placeholder={searchMode === 'tags' ? 'tag1, tag2, tag3...' : 'Search memories...'}
							className="flex-1 bg-transparent outline-none text-xs"
							style={{ color: theme.colors.textMain }}
						/>
					</div>
					{/* Search mode toggle */}
					<div className="flex items-center shrink-0">
						{(['smart', 'keyword', 'tags'] as SearchMode[]).map((mode) => (
							<button
								key={mode}
								className="text-[10px] px-1.5 py-1 font-medium transition-colors"
								style={{
									color: searchMode === mode ? theme.colors.accent : theme.colors.textDim,
									borderBottom:
										searchMode === mode
											? `2px solid ${theme.colors.accent}`
											: '2px solid transparent',
								}}
								onClick={() => {
									setSearchMode(mode);
									setSearchResults(null);
								}}
								title={
									mode === 'smart'
										? 'Cascading semantic search'
										: mode === 'keyword'
											? 'Keyword overlap search'
											: 'Search by tag names (comma-separated)'
								}
							>
								{SEARCH_MODE_LABELS[mode]}
							</button>
						))}
					</div>
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

					{/* Promotion-ready filter */}
					{promotionReadyIds.size > 0 && (
						<button
							className="text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors"
							style={{
								backgroundColor: promotionReadyOnly ? '#d4a01720' : 'transparent',
								color: promotionReadyOnly ? '#d4a017' : theme.colors.textDim,
								border: `1px solid ${promotionReadyOnly ? '#d4a017' : theme.colors.border}`,
							}}
							onClick={() => setPromotionReadyOnly(!promotionReadyOnly)}
						>
							Promotion-ready ({promotionReadyIds.size})
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

				{/* Tag cloud / tag filter panel */}
				{tagCounts.length > 0 && (
					<div className="space-y-1">
						<div className="flex flex-wrap gap-1">
							{(tagCounts.length > 10 && !tagCloudExpanded
								? tagCounts.slice(0, 10)
								: tagCounts
							).map(([tag, count]) => {
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
										{tag} ({count})
									</button>
								);
							})}
						</div>
						{tagCounts.length > 10 && (
							<button
								className="text-[10px] font-medium hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.accent }}
								onClick={() => setTagCloudExpanded(!tagCloudExpanded)}
							>
								{tagCloudExpanded ? 'Show fewer tags' : `Show all tags (${tagCounts.length})`}
							</button>
						)}
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
								agentType={agentType}
								projectPath={resolvedProjectPath}
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
								onEdit={() => {
									setDemotionHelperText(null);
									setEditShowContext(false);
									setEditingMemory(memory);
								}}
								onDelete={() => handleDelete(memory.id)}
								onAddContext={() => {
									setEditShowContext(true);
									setEditingMemory(memory);
								}}
								onCopy={() => handleCopyMemory(memory)}
								copied={copiedId === memory.id}
								agentType={agentType}
								projectPath={resolvedProjectPath}
								bulkMode={bulkMode}
								selected={selectedIds.has(memory.id)}
								onToggleSelect={() => handleToggleSelect(memory.id)}
								onMovePromote={handleMovePromote}
								skillAreas={skillAreas}
								personas={personas}
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
							<button
								className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:opacity-80 transition-opacity"
								style={{
									color: allSelectedAreExperiences ? theme.colors.accent : theme.colors.textDim,
									backgroundColor: allSelectedAreExperiences
										? `${theme.colors.accent}15`
										: `${theme.colors.border}40`,
									opacity: allSelectedAreExperiences ? 1 : 0.5,
								}}
								title={
									allSelectedAreExperiences
										? 'Promote selected experiences to rules'
										: 'Only available when all selected are experiences'
								}
								onClick={handleBulkPromote}
								disabled={!allSelectedAreExperiences}
							>
								<ArrowUpCircle className="w-3 h-3" />
								Promote
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
					initialShowContext={editShowContext}
					availableSkills={availableSkills}
					onSave={handleSaveEdit}
					onClose={() => {
						setEditingMemory(null);
						setEditShowContext(false);
						setDemotionHelperText(null);
					}}
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

			{/* Paste from Clipboard Modal */}
			{pastedMemory && (
				<MemoryEditModal
					theme={theme}
					memory={pastedMemory}
					defaultScope={resolvedScope}
					defaultSkillAreaId={resolvedSkillAreaId}
					defaultPersonaId={defaultPersonaId}
					defaultRoleId={defaultRoleId}
					availableSkills={availableSkills}
					onSave={async (data) => {
						await handleSaveCreate(data);
						setPastedMemory(null);
					}}
					onClose={() => setPastedMemory(null)}
				/>
			)}

			{/* Import Preview Panel */}
			{importPreview && (
				<div
					className="absolute inset-0 z-50 flex items-center justify-center"
					style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
					onClick={handleImportCancel}
				>
					<div
						className="rounded-lg border shadow-xl p-4 max-w-sm w-full space-y-3"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
						}}
						onClick={(e) => e.stopPropagation()}
					>
						<div className="flex items-center gap-2">
							<FileUp className="w-4 h-4" style={{ color: theme.colors.accent }} />
							<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Import Preview
							</span>
						</div>

						<div className="space-y-1.5">
							<div className="text-xs" style={{ color: theme.colors.textMain }}>
								Total memories: {importPreview.memories.length}
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Type breakdown:{' '}
								{Object.entries(importPreview.typeBreakdown)
									.map(([t, n]) => `${n} ${t}${n !== 1 ? 's' : ''}`)
									.join(', ')}
							</div>
							<div className="text-xs" style={{ color: theme.colors.accent }}>
								{importPreview.newCount} new
							</div>
							{importPreview.duplicateCount > 0 && (
								<div className="text-xs" style={{ color: theme.colors.warning }}>
									{importPreview.duplicateCount} duplicate
									{importPreview.duplicateCount !== 1 ? 's' : ''} (will skip)
								</div>
							)}
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Target scope: {importPreview.targetScope}
							</div>
						</div>

						{importProgress && (
							<div className="space-y-1">
								<div
									className="h-1.5 rounded-full overflow-hidden"
									style={{ backgroundColor: theme.colors.border }}
								>
									<div
										className="h-full rounded-full transition-all"
										style={{
											width: `${(importProgress.current / importProgress.total) * 100}%`,
											backgroundColor: theme.colors.accent,
										}}
									/>
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									{importProgress.current} / {importProgress.total}
								</div>
							</div>
						)}

						<div className="flex justify-end gap-2 pt-1">
							<button
								className="text-xs px-3 py-1.5 rounded hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.textDim }}
								onClick={handleImportCancel}
							>
								Cancel
							</button>
							<button
								className="text-xs px-3 py-1.5 rounded font-medium hover:opacity-80 transition-opacity"
								style={{ backgroundColor: theme.colors.accent, color: '#fff' }}
								onClick={handleImportConfirm}
								disabled={!!importProgress || importPreview.newCount === 0}
							>
								{importProgress
									? 'Importing...'
									: `Import ${importPreview.newCount} memor${importPreview.newCount === 1 ? 'y' : 'ies'}`}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Import Result Banner */}
			{importResult && (
				<div
					className="absolute bottom-3 left-3 right-3 z-50 flex items-center gap-2 px-3 py-2 rounded-lg border shadow-lg"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.accent,
					}}
				>
					<Check className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						Imported {importResult.imported} memor{importResult.imported === 1 ? 'y' : 'ies'}
						{importResult.skipped > 0 &&
							`, skipped ${importResult.skipped} duplicate${importResult.skipped !== 1 ? 's' : ''}`}
					</span>
					<div className="flex-1" />
					<button
						className="text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						onClick={() => setImportResult(null)}
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			)}

			{/* Bulk Result Banner */}
			{bulkResult && (
				<div
					className="absolute bottom-3 left-3 right-3 z-50 flex items-center gap-2 px-3 py-2 rounded-lg border shadow-lg"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.accent,
					}}
				>
					<Check className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
					<span className="text-xs" style={{ color: theme.colors.textMain }}>
						{bulkResult}
					</span>
					<div className="flex-1" />
					<button
						className="text-xs hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
						onClick={() => setBulkResult(null)}
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			)}

			{/* Promotion Dialog */}
			{promotingMemory && (
				<PromotionDialog
					memory={promotingMemory}
					theme={theme}
					onConfirm={handlePromoteConfirm}
					onClose={() => setPromotingMemory(null)}
				/>
			)}

			{/* Scope Confirmation Dialog */}
			{scopeConfirm && (
				<ScopeConfirmDialog
					direction={scopeConfirm.direction}
					theme={theme}
					onConfirm={handleScopeConfirm}
					onClose={() => setScopeConfirm(null)}
				/>
			)}
		</div>
	);
}
