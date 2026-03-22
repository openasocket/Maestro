/**
 * TemplatesTab
 *
 * Template library browser for the Team Orchestration modal. Displays:
 * - Category filter pills (All, Built-in, User, Exchange)
 * - Debounced search bar
 * - 2-column template card grid
 * - Detail side panel for selected template
 *
 * Features:
 * - Fetches templates via window.maestro.teamTemplates.list()
 * - Per-template usage stats from TeamOrchAggregation.byTemplate
 * - Compact WorkflowGraph preview for topology templates
 * - Responsive layout (2-col grid → 1-col on narrow)
 */

import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import type { Theme } from '../../types';
import type { TeamOrchAggregation } from '../../../shared/team-orch-stats-types';
import type { TeamTemplate } from '../../../shared/group-chat-types';
import { WorkflowGraph } from '../GroupChat/WorkflowGraph';
import { TeamOrchEmptyState } from './TeamOrchEmptyState';
import { topologyDisplayName, formatPercentage } from './teamOrchUtils';

type CategoryFilter = 'all' | 'builtin' | 'user' | 'exchange';

const CATEGORY_PILLS: { value: CategoryFilter; label: string }[] = [
	{ value: 'all', label: 'All' },
	{ value: 'builtin', label: 'Built-in' },
	{ value: 'user', label: 'User' },
	{ value: 'exchange', label: 'Exchange' },
];

interface TemplatesTabProps {
	theme: Theme;
	data: TeamOrchAggregation | null;
}

export const TemplatesTab = memo(function TemplatesTab({ theme, data }: TemplatesTabProps) {
	const [templates, setTemplates] = useState<TeamTemplate[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
	const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
	const [searchQuery, setSearchQuery] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');
	const mountedRef = useRef(true);

	// Debounce search input (300ms)
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedSearch(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Fetch templates on mount
	const fetchTemplates = useCallback(async () => {
		try {
			const list = await window.maestro.teamTemplates.list();
			if (mountedRef.current) {
				setTemplates(list);
			}
		} catch (err) {
			console.error('Failed to fetch templates:', err);
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		fetchTemplates();
		return () => {
			mountedRef.current = false;
		};
	}, [fetchTemplates]);

	// Filter templates by category and search
	const filteredTemplates = useMemo(() => {
		let result = templates;

		if (categoryFilter !== 'all') {
			result = result.filter((t) => t.category === categoryFilter);
		}

		if (debouncedSearch) {
			const q = debouncedSearch.toLowerCase();
			result = result.filter(
				(t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
			);
		}

		return result;
	}, [templates, categoryFilter, debouncedSearch]);

	const selectedTemplate = useMemo(
		() => templates.find((t) => t.id === selectedTemplateId) ?? null,
		[templates, selectedTemplateId]
	);

	if (loading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 4 }).map((_, i) => (
					<div
						key={i}
						className="h-24 rounded-lg"
						style={{
							backgroundColor: theme.colors.border,
							opacity: 0.15,
							animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
							animationDelay: `${i * 100}ms`,
						}}
					/>
				))}
			</div>
		);
	}

	return (
		<div className="flex gap-4" style={{ minHeight: 400 }}>
			{/* Left panel: filters + grid */}
			<div className={selectedTemplate ? 'flex-1 min-w-0' : 'w-full'}>
				{/* Category filter pills */}
				<div className="flex items-center gap-2 mb-3">
					{CATEGORY_PILLS.map((pill) => (
						<button
							key={pill.value}
							onClick={() => setCategoryFilter(pill.value)}
							className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
							style={{
								backgroundColor:
									categoryFilter === pill.value ? theme.colors.accent : theme.colors.bgActivity,
								color: categoryFilter === pill.value ? '#fff' : theme.colors.textDim,
							}}
						>
							{pill.label}
						</button>
					))}
				</div>

				{/* Search bar */}
				<div className="relative mb-4">
					<Search
						className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
						style={{ color: theme.colors.textDim }}
					/>
					<input
						type="text"
						placeholder="Search templates..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full pl-9 pr-3 py-2 rounded-lg text-sm border outline-none"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					/>
				</div>

				{/* Template card grid */}
				{filteredTemplates.length === 0 ? (
					<TeamOrchEmptyState theme={theme} message="No templates found" />
				) : (
					<div
						className="grid gap-3"
						style={{
							gridTemplateColumns: selectedTemplate
								? '1fr'
								: 'repeat(auto-fill, minmax(280px, 1fr))',
						}}
					>
						{filteredTemplates.map((template) => (
							<TemplateCard
								key={template.id}
								template={template}
								theme={theme}
								selected={template.id === selectedTemplateId}
								stats={data?.byTemplate?.[template.id] ?? null}
								onClick={() =>
									setSelectedTemplateId(template.id === selectedTemplateId ? null : template.id)
								}
							/>
						))}
					</div>
				)}
			</div>

			{/* Detail side panel */}
			{selectedTemplate && (
				<TemplateDetailPanel
					template={selectedTemplate}
					theme={theme}
					stats={data?.byTemplate?.[selectedTemplate.id] ?? null}
					onClose={() => setSelectedTemplateId(null)}
				/>
			)}
		</div>
	);
});

/**
 * A single template card in the grid.
 */
const TemplateCard = memo(function TemplateCard({
	template,
	theme,
	selected,
	stats,
	onClick,
}: {
	template: TeamTemplate;
	theme: Theme;
	selected: boolean;
	stats: { count: number; successRate: number; avgIterations: number } | null;
	onClick: () => void;
}) {
	const [hovered, setHovered] = useState(false);

	return (
		<button
			type="button"
			onClick={onClick}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			className="text-left p-4 rounded-lg border transition-colors outline-none"
			style={{
				backgroundColor: hovered ? theme.colors.bgActivity : theme.colors.bgMain,
				borderColor: selected ? theme.colors.accent : theme.colors.border,
				borderWidth: selected ? 2 : 1,
			}}
		>
			<div className="flex items-start gap-3">
				{/* Icon fallback: first character */}
				<div
					className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{template.name.charAt(0).toUpperCase()}
				</div>

				<div className="min-w-0 flex-1">
					<div className="text-sm font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{template.name}
					</div>
					<div className="text-xs mt-0.5 line-clamp-2" style={{ color: theme.colors.textDim }}>
						{template.description}
					</div>

					{/* Badges row */}
					<div className="flex items-center gap-2 mt-2 flex-wrap">
						<span
							className="text-[10px] px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accent,
							}}
						>
							{template.roles.length} role{template.roles.length !== 1 ? 's' : ''}
						</span>

						{template.topology && (
							<span
								className="text-[10px] px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.accent}15`,
									color: theme.colors.accent,
								}}
							>
								{topologyDisplayName(template.topology.pattern)}
							</span>
						)}

						{stats && stats.count > 0 && (
							<span
								className="text-[10px] px-2 py-0.5 rounded-full"
								style={{
									backgroundColor: `${theme.colors.success}15`,
									color: theme.colors.success,
								}}
							>
								{stats.count} run{stats.count !== 1 ? 's' : ''} ·{' '}
								{formatPercentage(stats.successRate)}
							</span>
						)}
					</div>
				</div>
			</div>
		</button>
	);
});

/**
 * Detail panel shown when a template is selected.
 */
const TemplateDetailPanel = memo(function TemplateDetailPanel({
	template,
	theme,
	stats,
	onClose,
}: {
	template: TeamTemplate;
	theme: Theme;
	stats: { count: number; successRate: number; avgIterations: number } | null;
	onClose: () => void;
}) {
	return (
		<div
			className="w-[40%] min-w-[280px] max-w-[400px] rounded-lg border p-4 overflow-y-auto flex-shrink-0"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div className="flex items-start justify-between mb-4">
				<div className="min-w-0 flex-1">
					<h3 className="text-base font-semibold" style={{ color: theme.colors.textMain }}>
						{template.name}
					</h3>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						{template.description}
					</p>
				</div>
				<button
					onClick={onClose}
					className="flex-shrink-0 ml-2 text-xs px-2 py-1 rounded hover:opacity-80"
					style={{ color: theme.colors.textDim }}
				>
					✕
				</button>
			</div>

			{/* Category badge */}
			<div className="mb-4">
				<span
					className="text-[10px] px-2 py-0.5 rounded-full font-medium"
					style={{
						backgroundColor: `${theme.colors.accent}15`,
						color: theme.colors.accent,
					}}
				>
					{template.category}
				</span>
			</div>

			{/* Usage stats */}
			{stats && stats.count > 0 && (
				<div
					className="mb-4 p-3 rounded-lg text-xs"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<div className="flex justify-between mb-1">
						<span style={{ color: theme.colors.textDim }}>Times used</span>
						<span style={{ color: theme.colors.textMain }}>{stats.count}</span>
					</div>
					<div className="flex justify-between mb-1">
						<span style={{ color: theme.colors.textDim }}>Success rate</span>
						<span style={{ color: theme.colors.textMain }}>
							{formatPercentage(stats.successRate)}
						</span>
					</div>
					<div className="flex justify-between">
						<span style={{ color: theme.colors.textDim }}>Avg iterations</span>
						<span style={{ color: theme.colors.textMain }}>{stats.avgIterations.toFixed(1)}</span>
					</div>
				</div>
			)}

			{/* Roles list */}
			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-2 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Roles ({template.roles.length})
				</h4>
				<div className="space-y-2">
					{template.roles.map((role, idx) => (
						<div
							key={idx}
							className="p-2 rounded border text-xs"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							<div className="flex items-center gap-2 mb-0.5">
								<span className="font-medium" style={{ color: theme.colors.textMain }}>
									{role.name}
								</span>
								<span
									className="text-[10px] px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: `${theme.colors.border}80`,
										color: theme.colors.textDim,
									}}
								>
									{role.agentId}
								</span>
							</div>
							<p style={{ color: theme.colors.textDim }}>{role.description}</p>
						</div>
					))}
				</div>
			</div>

			{/* Topology preview */}
			{template.topology && (
				<div className="mb-4">
					<h4
						className="text-xs font-semibold mb-2 uppercase tracking-wide"
						style={{ color: theme.colors.textDim }}
					>
						Topology
					</h4>
					<div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border }}>
						<WorkflowGraph
							topology={template.topology}
							participants={[]}
							theme={theme}
							compact={true}
						/>
					</div>
				</div>
			)}

			{/* Moderator */}
			<div className="mb-4">
				<h4
					className="text-xs font-semibold mb-1 uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					Moderator
				</h4>
				<span className="text-xs" style={{ color: theme.colors.textMain }}>
					{template.moderatorAgentId}
				</span>
			</div>

			{/* Timestamps */}
			<div className="text-[10px] space-y-1" style={{ color: theme.colors.textDim }}>
				<div>Created: {new Date(template.createdAt).toLocaleDateString()}</div>
				<div>Updated: {new Date(template.updatedAt).toLocaleDateString()}</div>
			</div>
		</div>
	);
});

export default TemplatesTab;
