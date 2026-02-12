import React, { useMemo, useState } from 'react';
import {
	Cpu,
	Award,
	BarChart3,
	Clock,
	Search,
	ArrowUpDown,
} from 'lucide-react';
import type { Theme } from '../../types';
import type { VibesModelInfo } from '../../hooks';

// ============================================================================
// Props
// ============================================================================

interface VibesModelAttributionProps {
	theme: Theme;
	models: VibesModelInfo[];
	isLoading: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/** Determine the tool display label from a tool name. */
function formatToolName(toolName?: string): string {
	if (!toolName) return 'Unknown';
	const lower = toolName.toLowerCase();
	if (lower.includes('claude') || lower.includes('claude-code')) return 'Claude Code';
	if (lower.includes('codex')) return 'Codex';
	if (lower.includes('maestro')) return 'Maestro';
	return toolName;
}

// ============================================================================
// Component
// ============================================================================

/**
 * VIBES Model Attribution — shows which AI models contributed to the project
 * and their relative contributions.
 *
 * Features:
 * - Model list with name, version, tool, annotation count, percentage bar
 * - Summary stats: total models, primary model, coverage by model
 * - Data sourced from the useVibesData hook's `models` array
 */
type SortField = 'count' | 'name' | 'percentage';

export const VibesModelAttribution: React.FC<VibesModelAttributionProps> = ({
	theme,
	models,
	isLoading,
}) => {
	const [searchQuery, setSearchQuery] = useState('');
	const [sortBy, setSortBy] = useState<SortField>('count');
	const [showAll, setShowAll] = useState(false);

	const sortedModels = useMemo(
		() => [...models].sort((a, b) => b.annotationCount - a.annotationCount),
		[models],
	);

	const totalAnnotations = useMemo(
		() => models.reduce((sum, m) => sum + m.annotationCount, 0),
		[models],
	);

	const primaryModel = useMemo(
		() => (sortedModels.length > 0 ? sortedModels[0] : null),
		[sortedModels],
	);

	// Filtered and re-sorted models for the list
	const displayModels = useMemo(() => {
		let filtered = [...models];
		if (searchQuery) {
			const q = searchQuery.toLowerCase();
			filtered = filtered.filter(
				(m) => m.modelName.toLowerCase().includes(q) || (m.toolName ?? '').toLowerCase().includes(q),
			);
		}
		filtered.sort((a, b) => {
			if (sortBy === 'name') return a.modelName.localeCompare(b.modelName);
			if (sortBy === 'percentage') return b.percentage - a.percentage;
			return b.annotationCount - a.annotationCount;
		});
		if (!showAll && filtered.length > 5) return filtered.slice(0, 5);
		return filtered;
	}, [models, searchQuery, sortBy, showAll]);

	const maxPercentage = useMemo(
		() => (displayModels.length > 0 ? Math.max(...displayModels.map((m) => m.percentage)) : 0),
		[displayModels],
	);

	// ========================================================================
	// Loading state
	// ========================================================================

	if (isLoading) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Clock className="w-6 h-6 animate-pulse" style={{ color: theme.colors.textDim }} />
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading model data...
				</span>
			</div>
		);
	}

	// ========================================================================
	// Empty state
	// ========================================================================

	if (models.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
				<Cpu className="w-8 h-8 opacity-40" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					No models recorded
				</span>
				<span className="text-xs max-w-xs" style={{ color: theme.colors.textDim }}>
					Model attribution data will appear here once AI agents have contributed annotations to this project.
				</span>
			</div>
		);
	}

	// ========================================================================
	// Main content
	// ========================================================================

	return (
		<div className="flex flex-col gap-4 py-3">
			{/* Summary Stats */}
			<div className="grid grid-cols-2 gap-2">
				<SummaryCard
					theme={theme}
					icon={<Cpu className="w-4 h-4" />}
					label="Total Models"
					value={models.length}
				/>
				<SummaryCard
					theme={theme}
					icon={<BarChart3 className="w-4 h-4" />}
					label="Total Annotations"
					value={totalAnnotations}
				/>
				{primaryModel && (
					<div
						className="col-span-2 flex items-center gap-2 px-3 py-2.5 rounded"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<Award className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
						<div className="flex flex-col gap-0.5 min-w-0">
							<span
								className="text-[10px] uppercase tracking-wider font-medium"
								style={{ color: theme.colors.textDim }}
							>
								Primary Model
							</span>
							<span
								className="text-xs font-semibold truncate"
								style={{ color: theme.colors.textMain }}
								title={primaryModel.modelName}
							>
								{primaryModel.modelName}
								{primaryModel.modelVersion && (
									<span className="font-normal" style={{ color: theme.colors.textDim }}>
										{' '}v{primaryModel.modelVersion}
									</span>
								)}
							</span>
						</div>
						<span
							className="ml-auto text-xs font-bold tabular-nums shrink-0"
							style={{ color: theme.colors.accent }}
						>
							{primaryModel.percentage.toFixed(1)}%
						</span>
					</div>
				)}
			</div>

			{/* Model List Header + Search/Sort */}
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-1.5 px-1">
					<span
						className="text-[10px] font-semibold uppercase tracking-wider"
						style={{ color: theme.colors.textDim }}
					>
						Model Contributions
					</span>
					<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
						({models.length})
					</span>
				</div>

				{/* Search and sort controls */}
				{models.length > 1 && (
					<div className="flex items-center gap-1.5" data-testid="model-search-bar">
						<div
							className="flex items-center gap-1.5 flex-1 px-2 py-1 rounded text-xs"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<Search className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
							<input
								type="text"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder="Filter models..."
								className="flex-1 bg-transparent text-xs outline-none"
								style={{ color: theme.colors.textMain }}
								data-testid="model-search-input"
							/>
						</div>
						<button
							onClick={() => setSortBy((prev) => (prev === 'count' ? 'name' : prev === 'name' ? 'percentage' : 'count'))}
							className="flex items-center gap-1 px-2 py-1 rounded text-[10px] shrink-0 transition-opacity hover:opacity-80"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
								color: theme.colors.textDim,
							}}
							title={`Sort by: ${sortBy}`}
							data-testid="model-sort-toggle"
						>
							<ArrowUpDown className="w-3 h-3" />
							{sortBy === 'count' ? '#' : sortBy === 'name' ? 'A-Z' : '%'}
						</button>
					</div>
				)}
			</div>

			{/* Model List */}
			<div className="flex flex-col gap-1">
				{displayModels.map((model, idx) => (
					<ModelRow
						key={`${model.modelName}-${model.toolName ?? ''}-${idx}`}
						theme={theme}
						model={model}
						maxPercentage={maxPercentage}
					/>
				))}
				{displayModels.length === 0 && searchQuery && (
					<span className="text-[11px] px-3 py-2" style={{ color: theme.colors.textDim }}>
						No models match &quot;{searchQuery}&quot;
					</span>
				)}
			</div>

			{/* Show all / Show top 5 toggle */}
			{models.length > 5 && (
				<button
					onClick={() => setShowAll((prev) => !prev)}
					className="text-[10px] font-medium px-1 transition-opacity hover:opacity-80"
					style={{ color: theme.colors.accent }}
					data-testid="model-show-toggle"
				>
					{showAll ? 'Show top 5' : `Show all (${models.length})`}
				</button>
			)}
		</div>
	);
};

// ============================================================================
// Sub-components
// ============================================================================

interface SummaryCardProps {
	theme: Theme;
	icon: React.ReactNode;
	label: string;
	value: number | string;
}

const SummaryCard: React.FC<SummaryCardProps> = ({ theme, icon, label, value }) => (
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
		<span
			className="text-lg font-bold tabular-nums"
			style={{ color: theme.colors.textMain }}
		>
			{value}
		</span>
	</div>
);

// ----------------------------------------------------------------------------
// Model row with percentage bar
// ----------------------------------------------------------------------------

interface ModelRowProps {
	theme: Theme;
	model: VibesModelInfo;
	maxPercentage: number;
}

const ModelRow: React.FC<ModelRowProps> = ({ theme, model, maxPercentage }) => {
	const barWidth = maxPercentage > 0 ? (model.percentage / maxPercentage) * 100 : 0;

	return (
		<div
			className="flex flex-col gap-1.5 px-3 py-2 rounded"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			{/* Top row: model info */}
			<div className="flex items-center gap-2 min-w-0">
				<Cpu className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				<span
					className="text-xs font-semibold truncate"
					style={{ color: theme.colors.textMain }}
					title={model.modelName}
				>
					{model.modelName}
				</span>
				{model.modelVersion && (
					<span
						className="text-[10px] shrink-0"
						style={{ color: theme.colors.textDim }}
					>
						v{model.modelVersion}
					</span>
				)}
				<span
					className="ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0"
					style={{
						backgroundColor: theme.colors.accentDim,
						color: theme.colors.accent,
					}}
				>
					{formatToolName(model.toolName)}
				</span>
			</div>

			{/* Bottom row: bar + stats */}
			<div className="flex items-center gap-2">
				{/* Proportion bar */}
				<div
					className="flex-1 h-1.5 rounded-full overflow-hidden"
					style={{ backgroundColor: theme.colors.border }}
				>
					<div
						className="h-full rounded-full transition-all"
						style={{
							width: `${barWidth}%`,
							backgroundColor: theme.colors.accent,
						}}
					/>
				</div>

				{/* Annotation count and percentage */}
				<span
					className="text-[10px] tabular-nums shrink-0"
					style={{ color: theme.colors.textDim }}
				>
					{model.annotationCount} ann
				</span>
				<span
					className="text-[10px] font-semibold tabular-nums shrink-0"
					style={{ color: theme.colors.textMain }}
				>
					{model.percentage.toFixed(1)}%
				</span>
			</div>
		</div>
	);
};
