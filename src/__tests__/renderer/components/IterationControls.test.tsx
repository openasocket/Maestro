import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IterationControls } from '../../../renderer/components/GroupChat/IterationControls';
import type { Theme, TerminationMode } from '../../../renderer/types';
import type { WorkflowTopology, WorkflowExecutionState } from '../../../shared/group-chat-types';

vi.mock('lucide-react', () => ({
	Square: ({ size }: { size?: number }) => (
		<span data-testid="square-icon" data-size={size}>
			■
		</span>
	),
	FastForward: ({ size }: { size?: number }) => (
		<span data-testid="fast-forward-icon" data-size={size}>
			⏩
		</span>
	),
	Plus: ({ size }: { size?: number }) => (
		<span data-testid="plus-icon" data-size={size}>
			+
		</span>
	),
}));

const mockTheme = {
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		border: '#0f3460',
		textMain: '#e0e0e0',
		textDim: '#666',
		accent: '#6366f1',
		success: '#4caf50',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as Theme;

const mockTopology: WorkflowTopology = {
	pattern: 'review-loop',
	edges: [
		{ source: '__entry__', target: 'Writer', edgeType: 'sequential' },
		{ source: 'Writer', target: 'Reviewer', edgeType: 'sequential' },
		{
			source: 'Reviewer',
			target: 'Writer',
			edgeType: 'conditional',
			condition: 'needs revision',
		},
		{
			source: 'Reviewer',
			target: '__exit__',
			edgeType: 'conditional',
			condition: 'approved',
		},
	],
	entryPoint: 'Writer',
	exitPoint: 'Reviewer',
};

const mockExecutionState: WorkflowExecutionState = {
	currentPhase: 'Writer',
	completedNodes: [],
	pendingNodes: ['Reviewer'],
	activeNodes: ['Writer'],
	iterationCount: 2,
	nodeOutputs: {},
	status: 'running',
};

describe('IterationControls', () => {
	const defaultProps = {
		theme: mockTheme,
		executionState: mockExecutionState,
		topology: mockTopology,
		maxIterations: 5,
		terminationMode: 'moderator-decides' as TerminationMode,
		onStopAfterIteration: vi.fn(),
		onForceComplete: vi.fn(),
		onAddIteration: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders iteration count and mode', () => {
		render(<IterationControls {...defaultProps} />);
		expect(screen.getByText('Iteration 2 of 5')).toBeTruthy();
		expect(screen.getByText('Mode: Moderator Decides')).toBeTruthy();
	});

	it('renders all three control buttons', () => {
		render(<IterationControls {...defaultProps} />);
		expect(screen.getByTestId('stop-after-iteration-btn')).toBeTruthy();
		expect(screen.getByTestId('force-complete-btn')).toBeTruthy();
		expect(screen.getByTestId('add-iteration-btn')).toBeTruthy();
	});

	it('renders progress bar with correct width', () => {
		render(<IterationControls {...defaultProps} />);
		const bar = screen.getByTestId('iteration-progress-bar');
		// iteration 2 of 5 = 40%
		expect(bar.style.width).toBe('40%');
	});

	it('caps progress bar at 100%', () => {
		render(
			<IterationControls
				{...defaultProps}
				executionState={{ ...mockExecutionState, iterationCount: 10 }}
				maxIterations={5}
			/>
		);
		const bar = screen.getByTestId('iteration-progress-bar');
		expect(bar.style.width).toBe('100%');
	});

	it('calls onStopAfterIteration when Stop button is clicked', () => {
		render(<IterationControls {...defaultProps} />);
		fireEvent.click(screen.getByTestId('stop-after-iteration-btn'));
		expect(defaultProps.onStopAfterIteration).toHaveBeenCalledOnce();
	});

	it('calls onForceComplete when Force Complete button is clicked', () => {
		render(<IterationControls {...defaultProps} />);
		fireEvent.click(screen.getByTestId('force-complete-btn'));
		expect(defaultProps.onForceComplete).toHaveBeenCalledOnce();
	});

	it('calls onAddIteration when +1 Iteration button is clicked', () => {
		render(<IterationControls {...defaultProps} />);
		fireEvent.click(screen.getByTestId('add-iteration-btn'));
		expect(defaultProps.onAddIteration).toHaveBeenCalledOnce();
	});

	it('returns null for hub-spoke topology', () => {
		const hubSpokeTopology: WorkflowTopology = {
			pattern: 'hub-spoke',
			edges: [],
			entryPoint: 'Mod',
			exitPoint: 'Mod',
		};
		const { container } = render(
			<IterationControls {...defaultProps} topology={hubSpokeTopology} />
		);
		expect(container.innerHTML).toBe('');
	});

	it('returns null when workflow is completed', () => {
		const { container } = render(
			<IterationControls
				{...defaultProps}
				executionState={{ ...mockExecutionState, status: 'completed' }}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('returns null when workflow is failed', () => {
		const { container } = render(
			<IterationControls
				{...defaultProps}
				executionState={{ ...mockExecutionState, status: 'failed' }}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('returns null when workflow is terminated', () => {
		const { container } = render(
			<IterationControls
				{...defaultProps}
				executionState={{ ...mockExecutionState, status: 'terminated' }}
			/>
		);
		expect(container.innerHTML).toBe('');
	});

	it('displays max-iterations mode label correctly', () => {
		render(<IterationControls {...defaultProps} terminationMode="max-iterations" />);
		expect(screen.getByText('Mode: Max Iterations')).toBeTruthy();
	});

	it('displays quality-gate mode label correctly', () => {
		render(<IterationControls {...defaultProps} terminationMode="quality-gate" />);
		expect(screen.getByText('Mode: Quality Gate')).toBeTruthy();
	});

	it('renders with iteration 0', () => {
		render(
			<IterationControls
				{...defaultProps}
				executionState={{ ...mockExecutionState, iterationCount: 0 }}
			/>
		);
		expect(screen.getByText('Iteration 0 of 5')).toBeTruthy();
		const bar = screen.getByTestId('iteration-progress-bar');
		expect(bar.style.width).toBe('0%');
	});

	it('handles maxIterations of 0 gracefully', () => {
		render(<IterationControls {...defaultProps} maxIterations={0} />);
		const bar = screen.getByTestId('iteration-progress-bar');
		expect(bar.style.width).toBe('0%');
	});

	it('renders for pipeline topology', () => {
		const pipelineTopology: WorkflowTopology = {
			pattern: 'pipeline',
			edges: [{ source: 'A', target: 'B', edgeType: 'sequential' }],
			entryPoint: 'A',
			exitPoint: 'B',
		};
		render(<IterationControls {...defaultProps} topology={pipelineTopology} />);
		expect(screen.getByTestId('iteration-controls')).toBeTruthy();
	});
});
