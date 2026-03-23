import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/NodeConfigPanel';
import type { PipelineNode, CuePipeline } from '../../../../../shared/cue-pipeline-types';

// Mock child config panels to isolate NodeConfigPanel dispatcher logic
vi.mock('../../../../../renderer/components/CuePipelineEditor/panels/triggers', () => ({
	TriggerConfig: () => <div data-testid="trigger-config" />,
}));
vi.mock('../../../../../renderer/components/CuePipelineEditor/panels/AgentConfigPanel', () => ({
	AgentConfigPanel: () => <div data-testid="agent-config" />,
}));
vi.mock('../../../../../renderer/components/CuePipelineEditor/panels/TeamConfigPanel', () => ({
	TeamConfigPanel: () => <div data-testid="team-config" />,
}));
vi.mock('../../../../../renderer/components/CuePipelineEditor/cueEventConstants', () => ({
	EVENT_ICONS: {},
	EVENT_LABELS: {},
}));

const mockPipelines: CuePipeline[] = [
	{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] },
];

const baseTriggerNode: PipelineNode = {
	id: 'trigger-1',
	type: 'trigger',
	position: { x: 0, y: 0 },
	data: { eventType: 'file.change', config: {} },
};

const baseAgentNode: PipelineNode = {
	id: 'agent-1',
	type: 'agent',
	position: { x: 100, y: 0 },
	data: { sessionId: 's1', sessionName: 'Claude', toolType: 'claude-code' },
};

const baseTeamNode: PipelineNode = {
	id: 'team-1',
	type: 'team',
	position: { x: 200, y: 0 },
	data: {
		templateId: 'tmpl-1',
		templateName: 'Review Team',
		roleCount: 3,
		topologyPattern: 'pipeline',
		inputPrompt: 'Review this code',
		outputPrompt: 'Summarize findings',
	},
};

const defaultProps = {
	selectedNode: null as PipelineNode | null,
	pipelines: mockPipelines,
	onUpdateNode: vi.fn(),
	onDeleteNode: vi.fn(),
};

describe('NodeConfigPanel', () => {
	it('returns null when no node is selected', () => {
		const { container } = render(<NodeConfigPanel {...defaultProps} />);
		expect(container.firstChild).toBeNull();
	});

	it('renders TriggerConfig for trigger nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseTriggerNode} />);
		expect(screen.getByTestId('trigger-config')).toBeInTheDocument();
		expect(screen.queryByTestId('agent-config')).not.toBeInTheDocument();
		expect(screen.queryByTestId('team-config')).not.toBeInTheDocument();
	});

	it('renders AgentConfigPanel for agent nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseAgentNode} />);
		expect(screen.getByTestId('agent-config')).toBeInTheDocument();
		expect(screen.queryByTestId('trigger-config')).not.toBeInTheDocument();
		expect(screen.queryByTestId('team-config')).not.toBeInTheDocument();
	});

	it('renders TeamConfigPanel for team nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseTeamNode} />);
		expect(screen.getByTestId('team-config')).toBeInTheDocument();
		expect(screen.queryByTestId('trigger-config')).not.toBeInTheDocument();
		expect(screen.queryByTestId('agent-config')).not.toBeInTheDocument();
	});

	it('shows "Configure Team" header with template name badge for team nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseTeamNode} />);
		expect(screen.getByText('Configure Team')).toBeInTheDocument();
		expect(screen.getByText('Review Team')).toBeInTheDocument();
	});

	it('shows agent session name and tool type for agent nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseAgentNode} />);
		expect(screen.getByText('Claude')).toBeInTheDocument();
		expect(screen.getByText('claude-code')).toBeInTheDocument();
	});

	it('shows expand/collapse button for team nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseTeamNode} />);
		expect(screen.getByTitle('Expand panel')).toBeInTheDocument();
	});

	it('shows expand/collapse button for agent nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseAgentNode} />);
		expect(screen.getByTitle('Expand panel')).toBeInTheDocument();
	});

	it('does not show expand/collapse button for trigger nodes', () => {
		render(<NodeConfigPanel {...defaultProps} selectedNode={baseTriggerNode} />);
		expect(screen.queryByTitle('Expand panel')).not.toBeInTheDocument();
	});

	it('calls onDeleteNode when delete button is clicked on team node', () => {
		const onDeleteNode = vi.fn();
		render(
			<NodeConfigPanel {...defaultProps} selectedNode={baseTeamNode} onDeleteNode={onDeleteNode} />
		);
		fireEvent.click(screen.getByTitle('Delete node'));
		expect(onDeleteNode).toHaveBeenCalledWith('team-1');
	});
});
