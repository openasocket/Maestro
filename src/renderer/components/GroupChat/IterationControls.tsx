/**
 * IterationControls.tsx
 *
 * Displays workflow iteration progress and provides controls for managing
 * the execution lifecycle of topology-based workflows:
 * - Iteration count with progress bar
 * - Termination mode label
 * - Stop / Force Complete / Add Iteration buttons
 *
 * Shown at the bottom of the Group Chat message area (above input) when
 * a topology-based workflow is actively running. Hidden for hub-spoke
 * routing or when no workflow is active.
 */

import React from 'react';
import { Square, FastForward, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import type { WorkflowExecutionState, WorkflowTopology } from '../../../shared/group-chat-types';
import type { TerminationMode } from '../../types';

const TERMINATION_MODE_LABELS: Record<TerminationMode, string> = {
	'moderator-decides': 'Moderator Decides',
	'max-iterations': 'Max Iterations',
	'quality-gate': 'Quality Gate',
};

export interface IterationControlsProps {
	theme: Theme;
	executionState: WorkflowExecutionState;
	topology: WorkflowTopology;
	maxIterations: number;
	terminationMode: TerminationMode;
	onStopAfterIteration: () => void;
	onForceComplete: () => void;
	onAddIteration: () => void;
}

export function IterationControls({
	theme,
	executionState,
	topology,
	maxIterations,
	terminationMode,
	onStopAfterIteration,
	onForceComplete,
	onAddIteration,
}: IterationControlsProps): JSX.Element | null {
	// Hide for hub-spoke (no topology routing) or terminal workflow states
	if (topology.pattern === 'hub-spoke') {
		return null;
	}
	if (
		executionState.status === 'completed' ||
		executionState.status === 'failed' ||
		executionState.status === 'terminated'
	) {
		return null;
	}

	const iteration = executionState.iterationCount;
	const progressPct = maxIterations > 0 ? Math.min((iteration / maxIterations) * 100, 100) : 0;

	return (
		<div
			className="flex flex-col gap-1.5 px-3 py-2 border-t"
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
			}}
			data-testid="iteration-controls"
		>
			{/* Top row: iteration label + mode */}
			<div className="flex items-center justify-between">
				<span className="text-xs font-semibold" style={{ color: theme.colors.textMain }}>
					Iteration {iteration} of {maxIterations}
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					Mode: {TERMINATION_MODE_LABELS[terminationMode]}
				</span>
			</div>

			{/* Progress bar */}
			<div
				className="w-full rounded-full overflow-hidden"
				style={{
					height: 4,
					backgroundColor: theme.colors.border,
				}}
			>
				<div
					className="h-full rounded-full transition-all duration-300"
					style={{
						width: `${progressPct}%`,
						backgroundColor: theme.colors.accent,
					}}
					data-testid="iteration-progress-bar"
				/>
			</div>

			{/* Control buttons */}
			<div className="flex items-center gap-2">
				<button
					className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
					style={{
						backgroundColor: theme.colors.warning + '22',
						color: theme.colors.warning,
						border: `1px solid ${theme.colors.warning}44`,
					}}
					onClick={onStopAfterIteration}
					title="Stop After This Iteration"
					data-testid="stop-after-iteration-btn"
				>
					<Square size={10} />
					Stop After This Iteration
				</button>
				<button
					className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
					style={{
						backgroundColor: theme.colors.error + '22',
						color: theme.colors.error,
						border: `1px solid ${theme.colors.error}44`,
					}}
					onClick={onForceComplete}
					title="Force Complete"
					data-testid="force-complete-btn"
				>
					<FastForward size={10} />
					Force Complete
				</button>
				<button
					className="flex items-center gap-1 px-2 py-1 rounded text-xs transition-opacity hover:opacity-80"
					style={{
						backgroundColor: theme.colors.accent + '22',
						color: theme.colors.accent,
						border: `1px solid ${theme.colors.accent}44`,
					}}
					onClick={onAddIteration}
					title="+1 Iteration"
					data-testid="add-iteration-btn"
				>
					<Plus size={10} />
					+1 Iteration
				</button>
			</div>
		</div>
	);
}
