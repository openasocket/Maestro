/**
 * BuilderPalette — Left-side panel with draggable node items and one-click preset patterns.
 *
 * Two sections:
 * - Nodes: Draggable Role, Entry Point, Exit Point items (entry/exit grayed if one exists)
 * - Quick Start Patterns: Click to load preset layouts (Pipeline, Parallel+Merge, Review Loop, Hub & Spoke)
 */

import { useCallback } from 'react';
import { User, Play, Flag, ArrowDown, GitBranch, RefreshCw, Network } from 'lucide-react';
import type { Theme } from '../../../types';
import type { BuilderState, BuilderNodeType } from './builderTypes';

export type PresetType = 'pipeline' | 'parallel-merge' | 'review-loop' | 'hub-spoke';

interface BuilderPaletteProps {
	state: BuilderState;
	theme: Theme;
	onLoadPreset: (presetType: PresetType) => void;
}

interface DraggableNodeItem {
	label: string;
	nodeType: BuilderNodeType;
	icon: typeof User;
	description: string;
}

const NODE_ITEMS: DraggableNodeItem[] = [
	{ label: 'Role', nodeType: 'role', icon: User, description: 'A participant role' },
	{ label: 'Entry Point', nodeType: 'entry', icon: Play, description: 'Workflow start' },
	{ label: 'Exit Point', nodeType: 'exit', icon: Flag, description: 'Workflow end' },
];

interface PatternItem {
	type: PresetType;
	label: string;
	icon: typeof ArrowDown;
	description: string;
}

const PATTERN_ITEMS: PatternItem[] = [
	{
		type: 'pipeline',
		label: 'Pipeline',
		icon: ArrowDown,
		description: '3 sequential steps',
	},
	{
		type: 'parallel-merge',
		label: 'Parallel + Merge',
		icon: GitBranch,
		description: 'Fan-out then merge',
	},
	{
		type: 'review-loop',
		label: 'Review Loop',
		icon: RefreshCw,
		description: 'Implement & review cycle',
	},
	{
		type: 'hub-spoke',
		label: 'Hub & Spoke',
		icon: Network,
		description: 'Central moderator pattern',
	},
];

export function BuilderPalette({ state, theme, onLoadPreset }: BuilderPaletteProps): JSX.Element {
	const hasEntry = state.nodes.some((n) => n.type === 'entry');
	const hasExit = state.nodes.some((n) => n.type === 'exit');

	const handlePatternClick = useCallback(
		(presetType: PresetType) => {
			if (state.nodes.length > 0) {
				const confirmed = window.confirm('This will replace your current layout. Continue?');
				if (!confirmed) return;
			}
			onLoadPreset(presetType);
		},
		[state.nodes.length, onLoadPreset]
	);

	return (
		<div
			className="flex-shrink-0 border-r overflow-y-auto flex flex-col"
			role="complementary"
			aria-label="Node palette"
			style={{
				width: 220,
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
			}}
		>
			{/* Nodes Section */}
			<div className="p-3">
				<h4
					className="text-[10px] font-semibold uppercase tracking-wide mb-2"
					style={{ color: theme.colors.textDim }}
				>
					Nodes
				</h4>
				<div className="space-y-2" role="list" aria-label="Draggable node types">
					{NODE_ITEMS.map((item) => {
						const disabled =
							(item.nodeType === 'entry' && hasEntry) || (item.nodeType === 'exit' && hasExit);
						return (
							<PaletteNodeCard key={item.nodeType} item={item} disabled={disabled} theme={theme} />
						);
					})}
				</div>
			</div>

			{/* Divider */}
			<div className="mx-3" style={{ height: 1, backgroundColor: theme.colors.border }} />

			{/* Patterns Section */}
			<div className="p-3 flex-1">
				<h4
					className="text-[10px] font-semibold uppercase tracking-wide mb-2"
					style={{ color: theme.colors.textDim }}
				>
					Quick Start Patterns
				</h4>
				<div className="space-y-2">
					{PATTERN_ITEMS.map((pattern) => (
						<PatternButton
							key={pattern.type}
							pattern={pattern}
							theme={theme}
							onClick={() => handlePatternClick(pattern.type)}
						/>
					))}
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Draggable palette node card
// ============================================================================

function PaletteNodeCard({
	item,
	disabled,
	theme,
}: {
	item: DraggableNodeItem;
	disabled: boolean;
	theme: Theme;
}): JSX.Element {
	const handleDragStart = useCallback(
		(e: React.DragEvent) => {
			if (disabled) {
				e.preventDefault();
				return;
			}
			e.dataTransfer.setData(
				'application/pipeline-builder-node',
				JSON.stringify({
					nodeType: item.nodeType,
					roleName: item.label,
					agentId: 'claude-code',
					description: item.description,
				})
			);
			e.dataTransfer.effectAllowed = 'copy';
		},
		[item, disabled]
	);

	const Icon = item.icon;

	return (
		<div
			draggable={!disabled}
			onDragStart={handleDragStart}
			role="listitem"
			aria-label={`Drag to add ${item.label} node`}
			aria-disabled={disabled || undefined}
			className="flex items-center gap-2 px-2.5 py-2 rounded border transition-colors"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgMain,
				cursor: disabled ? 'not-allowed' : 'grab',
				opacity: disabled ? 0.4 : 1,
			}}
		>
			<Icon
				className="w-3.5 h-3.5 flex-shrink-0"
				style={{
					color:
						item.nodeType === 'entry'
							? theme.colors.success
							: item.nodeType === 'exit'
								? theme.colors.textDim
								: theme.colors.accent,
				}}
			/>
			<div>
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{item.label}
				</div>
				<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{item.description}
					{disabled ? ' (already placed)' : ''}
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// Preset pattern button
// ============================================================================

function PatternButton({
	pattern,
	theme,
	onClick,
}: {
	pattern: PatternItem;
	theme: Theme;
	onClick: () => void;
}): JSX.Element {
	const Icon = pattern.icon;

	return (
		<button
			onClick={onClick}
			className="flex items-center gap-2 w-full px-2.5 py-2 rounded border text-left transition-colors hover:opacity-80"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgActivity,
			}}
		>
			<Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
			<div>
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{pattern.label}
				</div>
				<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
					{pattern.description}
				</div>
			</div>
		</button>
	);
}
