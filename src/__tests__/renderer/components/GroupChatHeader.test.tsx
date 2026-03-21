import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GroupChatHeader } from '../../../renderer/components/GroupChatHeader';
import type { Theme, Shortcut } from '../../../renderer/types';
import type { WorkflowTopology, GroupChatParticipant } from '../../../shared/group-chat-types';

vi.mock('lucide-react', () => ({
	Info: ({ className }: { className?: string }) => (
		<span data-testid="info-icon" className={className}>
			i
		</span>
	),
	Edit2: ({ className }: { className?: string }) => (
		<span data-testid="edit-icon" className={className}>
			✎
		</span>
	),
	Columns: ({ className }: { className?: string }) => (
		<span data-testid="columns-icon" className={className}>
			▥
		</span>
	),
	DollarSign: ({ className }: { className?: string }) => (
		<span data-testid="dollar-icon" className={className}>
			$
		</span>
	),
	Bot: ({ className }: { className?: string }) => (
		<span data-testid="bot-icon" className={className}>
			🤖
		</span>
	),
	ArrowDown: ({ className, style }: { className?: string; style?: object }) => (
		<span data-testid="arrow-down" className={className} style={style}>
			↓
		</span>
	),
	ArrowRight: ({ className, style }: { className?: string; style?: object }) => (
		<span data-testid="arrow-right" className={className} style={style}>
			→
		</span>
	),
	CornerDownLeft: ({ className, style }: { className?: string; style?: object }) => (
		<span data-testid="corner-down-left" className={className} style={style}>
			↲
		</span>
	),
}));

// Mock settingsStore
const mockSettingsStore = {
	encoreFeatures: { teamOrchestration: false } as Record<string, boolean>,
	teamOrchestrationSettings: { enableVisualization: false } as Record<string, boolean>,
};

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (s: typeof mockSettingsStore) => unknown) =>
		selector(mockSettingsStore),
}));

const mockTheme = {
	colors: {
		bgSidebar: '#1e1e1e',
		border: '#333',
		textMain: '#fff',
		textDim: '#999',
		success: '#4caf50',
		accent: '#6366f1',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as Theme;

const mockShortcuts: Record<string, Shortcut> = {
	toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle right panel', keys: ['Cmd', 'B'] },
};

const mockTopology: WorkflowTopology = {
	pattern: 'pipeline',
	edges: [{ from: 'Researcher', to: 'Writer' }],
	entryPoint: 'Researcher',
	exitPoint: 'Writer',
};

const mockParticipants: GroupChatParticipant[] = [
	{
		name: 'Researcher',
		agentId: 'claude-code',
		sessionId: 's1',
		addedAt: Date.now(),
		color: '#ff0000',
	},
	{
		name: 'Writer',
		agentId: 'claude-code',
		sessionId: 's2',
		addedAt: Date.now(),
		color: '#00ff00',
	},
];

const defaultProps = {
	theme: mockTheme,
	name: 'Test Chat',
	participantCount: 3,
	onRename: vi.fn(),
	onShowInfo: vi.fn(),
	rightPanelOpen: false,
	onToggleRightPanel: vi.fn(),
	shortcuts: mockShortcuts,
};

describe('GroupChatHeader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSettingsStore.encoreFeatures = { teamOrchestration: false } as Record<string, boolean>;
		mockSettingsStore.teamOrchestrationSettings = {
			enableVisualization: false,
		} as Record<string, boolean>;
	});

	it('renders group chat name and participant count', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.getByText('Group Chat: Test Chat')).toBeTruthy();
		expect(screen.getByText('3 participants')).toBeTruthy();
	});

	it('does not render a close (X) button', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.queryByTitle('Close')).toBeNull();
	});

	it('renders info button', () => {
		render(<GroupChatHeader {...defaultProps} />);
		expect(screen.getByTitle('Info')).toBeTruthy();
	});

	it('calls onRename when title is clicked', () => {
		render(<GroupChatHeader {...defaultProps} />);
		fireEvent.click(screen.getByText('Group Chat: Test Chat'));
		expect(defaultProps.onRename).toHaveBeenCalled();
	});

	it('shows cost pill when totalCost is provided', () => {
		render(<GroupChatHeader {...defaultProps} totalCost={6.98} />);
		expect(screen.getByText('6.98')).toBeTruthy();
	});

	it('shows right panel toggle when panel is closed', () => {
		render(<GroupChatHeader {...defaultProps} rightPanelOpen={false} />);
		expect(screen.getByTestId('columns-icon')).toBeTruthy();
	});

	it('hides right panel toggle when panel is open', () => {
		render(<GroupChatHeader {...defaultProps} rightPanelOpen={true} />);
		expect(screen.queryByTestId('columns-icon')).toBeNull();
	});

	it('uses singular "participant" for count of 1', () => {
		render(<GroupChatHeader {...defaultProps} participantCount={1} />);
		expect(screen.getByText('1 participant')).toBeTruthy();
	});

	it('does not show workflow minimap when feature flags are off', () => {
		render(
			<GroupChatHeader {...defaultProps} topology={mockTopology} participants={mockParticipants} />
		);
		expect(screen.queryByTitle('Show workflow')).toBeNull();
	});

	it('shows workflow minimap when feature flags and topology are present', () => {
		mockSettingsStore.encoreFeatures = { teamOrchestration: true } as Record<string, boolean>;
		mockSettingsStore.teamOrchestrationSettings = {
			enableVisualization: true,
		} as Record<string, boolean>;

		render(
			<GroupChatHeader {...defaultProps} topology={mockTopology} participants={mockParticipants} />
		);
		expect(screen.getByTitle('Show workflow')).toBeTruthy();
	});

	it('does not show workflow minimap when topology is absent', () => {
		mockSettingsStore.encoreFeatures = { teamOrchestration: true } as Record<string, boolean>;
		mockSettingsStore.teamOrchestrationSettings = {
			enableVisualization: true,
		} as Record<string, boolean>;

		render(<GroupChatHeader {...defaultProps} participants={mockParticipants} />);
		expect(screen.queryByTitle('Show workflow')).toBeNull();
	});

	it('clicking workflow minimap calls onShowWorkflow and opens right panel', () => {
		mockSettingsStore.encoreFeatures = { teamOrchestration: true } as Record<string, boolean>;
		mockSettingsStore.teamOrchestrationSettings = {
			enableVisualization: true,
		} as Record<string, boolean>;

		const onShowWorkflow = vi.fn();
		const onToggleRightPanel = vi.fn();
		render(
			<GroupChatHeader
				{...defaultProps}
				topology={mockTopology}
				participants={mockParticipants}
				onShowWorkflow={onShowWorkflow}
				onToggleRightPanel={onToggleRightPanel}
				rightPanelOpen={false}
			/>
		);

		fireEvent.click(screen.getByTitle('Show workflow'));
		expect(onToggleRightPanel).toHaveBeenCalled();
		expect(onShowWorkflow).toHaveBeenCalled();
	});

	it('clicking workflow minimap does not toggle right panel if already open', () => {
		mockSettingsStore.encoreFeatures = { teamOrchestration: true } as Record<string, boolean>;
		mockSettingsStore.teamOrchestrationSettings = {
			enableVisualization: true,
		} as Record<string, boolean>;

		const onShowWorkflow = vi.fn();
		const onToggleRightPanel = vi.fn();
		render(
			<GroupChatHeader
				{...defaultProps}
				topology={mockTopology}
				participants={mockParticipants}
				onShowWorkflow={onShowWorkflow}
				onToggleRightPanel={onToggleRightPanel}
				rightPanelOpen={true}
			/>
		);

		fireEvent.click(screen.getByTitle('Show workflow'));
		expect(onToggleRightPanel).not.toHaveBeenCalled();
		expect(onShowWorkflow).toHaveBeenCalled();
	});
});
