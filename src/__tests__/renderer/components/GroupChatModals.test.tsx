/**
 * @fileoverview Tests for GroupChatModal component (create and edit modes)
 *
 * Regression test for: MAESTRO_SESSION_RESUMED env var display in group chat moderator customization
 * This test ensures that when users customize the moderator agent in group chat modals,
 * they see the built-in MAESTRO_SESSION_RESUMED environment variable.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GroupChatModal } from '../../../renderer/components/GroupChatModal';
import type { Theme, GroupChat, AgentConfig } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Folder: ({ className }: { className?: string }) => (
		<span data-testid="folder-icon" className={className}>
			📁
		</span>
	),
	X: ({ className }: { className?: string }) => (
		<span data-testid="x-icon" className={className}>
			×
		</span>
	),
	RefreshCw: ({ className }: { className?: string }) => (
		<span data-testid="refresh-icon" className={className}>
			🔄
		</span>
	),
	Check: ({ className }: { className?: string }) => (
		<span data-testid="check-icon" className={className}>
			✓
		</span>
	),
	Plus: ({ className }: { className?: string }) => (
		<span data-testid="plus-icon" className={className}>
			+
		</span>
	),
	Trash2: ({ className }: { className?: string }) => (
		<span data-testid="trash-icon" className={className}>
			🗑
		</span>
	),
	HelpCircle: ({ className }: { className?: string }) => (
		<span data-testid="help-circle-icon" className={className}>
			?
		</span>
	),
	ChevronDown: ({ className }: { className?: string }) => (
		<span data-testid="chevron-down-icon" className={className}>
			▼
		</span>
	),
	Settings: ({ className }: { className?: string }) => (
		<span data-testid="settings-icon" className={className}>
			⚙
		</span>
	),
	ArrowLeft: ({ className }: { className?: string }) => (
		<span data-testid="arrow-left-icon" className={className}>
			←
		</span>
	),
	BookTemplate: ({ className }: { className?: string }) => (
		<span data-testid="book-template-icon" className={className}>
			T
		</span>
	),
	Users: ({ className }: { className?: string }) => (
		<span data-testid="users-icon" className={className}>
			U
		</span>
	),
	Star: ({ className }: { className?: string }) => (
		<span data-testid="star-icon" className={className}>
			*
		</span>
	),
	ChevronRight: ({ className }: { className?: string }) => (
		<span data-testid="chevron-right-icon" className={className}>
			&gt;
		</span>
	),
	Search: ({ className }: { className?: string }) => (
		<span data-testid="search-icon" className={className}>
			S
		</span>
	),
	Copy: ({ className }: { className?: string }) => (
		<span data-testid="copy-icon" className={className}>
			C
		</span>
	),
}));

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-group-chat-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock settings store for template feature flag
const mockSettingsState = {
	encoreFeatures: { teamOrchestration: true },
	teamOrchestrationSettings: { enableTemplates: true },
};

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (state: typeof mockSettingsState) => unknown) =>
		selector(mockSettingsState),
}));

// Mock notification store
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockTheme(): Theme {
	return {
		id: 'test-theme',
		name: 'Test Theme',
		colors: {
			bgMain: '#1a1a1a',
			bgSidebar: '#252525',
			bgActivity: '#333333',
			textMain: '#ffffff',
			textDim: '#888888',
			accent: '#6366f1',
			border: '#333333',
			success: '#22c55e',
			error: '#ef4444',
			warning: '#f59e0b',
			contextFree: '#22c55e',
			contextMedium: '#f59e0b',
			contextHigh: '#ef4444',
		},
	};
}

function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		available: true,
		path: '/usr/local/bin/claude',
		binaryName: 'claude',
		hidden: false,
		capabilities: {
			supportsModelSelection: false,
		},
		...overrides,
	} as AgentConfig;
}

function createMockGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'group-chat-1',
		name: 'Test Group Chat',
		moderatorAgentId: 'claude-code',
		createdAt: Date.now(),
		...overrides,
	};
}

// =============================================================================
// TESTS
// =============================================================================

describe('GroupChatModal', () => {
	/**
	 * Setup fresh mocks before each test.
	 * Uses mockResolvedValue for agent IPC methods (detect, getConfig, setConfig, getModels).
	 * Called in beforeEach; individual tests only need to call this again if they
	 * need different agents than the default single claude-code agent.
	 */
	function setupDefaultMocks(agents?: AgentConfig[]) {
		const defaultAgents = agents ?? [createMockAgent({ id: 'claude-code', name: 'Claude Code' })];
		vi.mocked(window.maestro.agents.detect).mockResolvedValue(defaultAgents);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({});
		vi.mocked(window.maestro.agents.setConfig).mockResolvedValue(undefined);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue([]);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockClear().mockReturnValue('layer-group-chat-123');
		mockUnregisterLayer.mockClear();
		mockUpdateLayerHandler.mockClear();
		setupDefaultMocks();
	});

	describe('create mode', () => {
		it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for agent detection and verify dropdown is rendered
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify Claude Code is selected in dropdown
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// Click the Customize button to expand config panel
			const customizeButton = screen.getByRole('button', { name: /customize/i });
			fireEvent.click(customizeButton);

			// Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show all available agents in dropdown', async () => {
			// Setup multiple agents
			setupDefaultMocks([
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
				createMockAgent({ id: 'opencode', name: 'OpenCode' }),
				createMockAgent({ id: 'factory-droid', name: 'Factory Droid' }),
			]);

			const onCreate = vi.fn();
			const onClose = vi.fn();

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={onClose}
					onCreate={onCreate}
				/>
			);

			// Wait for dropdown to be rendered
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify all agents appear as options
			expect(screen.getByRole('option', { name: /Claude Code/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Codex.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /OpenCode.*Beta/i })).toBeInTheDocument();
			expect(screen.getByRole('option', { name: /Factory Droid.*Beta/i })).toBeInTheDocument();
		});
	});

	describe('template integration (create mode)', () => {
		it('should show "Start from Template" section when templates are enabled and loaded', async () => {
			const mockTemplates = [
				{
					id: 'builtin-code-review',
					name: 'Code Review Team',
					description: 'Collaborative code review',
					category: 'builtin' as const,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					moderatorAgentId: 'claude-code',
					roles: [
						{ name: 'Implementer', agentId: 'claude-code', description: 'Writes code' },
						{ name: 'Reviewer', agentId: 'claude-code', description: 'Reviews code' },
					],
				},
			];

			vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(mockTemplates);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Start from Template')).toBeInTheDocument();
			});

			// Should show template card
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
			expect(screen.getByText('2 roles')).toBeInTheDocument();
		});

		it('should NOT show templates section when feature flag is disabled', async () => {
			mockSettingsState.encoreFeatures.teamOrchestration = false;

			vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue([]);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			// Wait for initial render
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			expect(screen.queryByText('Start from Template')).not.toBeInTheDocument();

			// Restore
			mockSettingsState.encoreFeatures.teamOrchestration = true;
		});

		it('should NOT show templates section in edit mode', async () => {
			vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue([
				{
					id: 't1',
					name: 'Template',
					description: 'Desc',
					category: 'builtin',
					createdAt: Date.now(),
					updatedAt: Date.now(),
					moderatorAgentId: 'claude-code',
					roles: [],
				},
			]);

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={createMockGroupChat()}
					onClose={vi.fn()}
					onSave={vi.fn()}
				/>
			);

			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			expect(screen.queryByText('Start from Template')).not.toBeInTheDocument();
		});

		it('should show "Browse All Templates" link', async () => {
			vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue([
				{
					id: 't1',
					name: 'Test Template',
					description: 'Desc',
					category: 'builtin',
					createdAt: Date.now(),
					updatedAt: Date.now(),
					moderatorAgentId: 'claude-code',
					roles: [{ name: 'Dev', agentId: 'claude-code', description: 'Develops' }],
				},
			]);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Browse All Templates')).toBeInTheDocument();
			});
		});

		it('should show template description when a template is selected', async () => {
			const mockTemplates = [
				{
					id: 'builtin-code-review',
					name: 'Code Review Team',
					description: 'Collaborative code review with multiple perspectives.',
					category: 'builtin' as const,
					createdAt: Date.now(),
					updatedAt: Date.now(),
					moderatorAgentId: 'claude-code',
					roles: [
						{ name: 'Implementer', agentId: 'claude-code', description: 'Writes code' },
						{ name: 'Reviewer', agentId: 'claude-code', description: 'Reviews code' },
					],
				},
			];

			vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(mockTemplates);

			render(
				<GroupChatModal
					mode="create"
					theme={createMockTheme()}
					isOpen={true}
					onClose={vi.fn()}
					onCreate={vi.fn()}
				/>
			);

			await waitFor(() => {
				expect(screen.getByText('Code Review Team')).toBeInTheDocument();
			});

			// Click the template card
			const templateCards = screen.getAllByText('Code Review Team');
			fireEvent.click(templateCards[0]);

			// Should show the description helper with role names
			await waitFor(() => {
				expect(screen.getByText(/Implementer, Reviewer/)).toBeInTheDocument();
			});
		});
	});

	describe('edit mode', () => {
		it('should display MAESTRO_SESSION_RESUMED in moderator configuration panel', async () => {
			const onSave = vi.fn();
			const onClose = vi.fn();
			const groupChat = createMockGroupChat();

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Wait for dropdown to be rendered
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Verify Claude Code is pre-selected
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			expect(dropdown).toHaveValue('claude-code');

			// Click the Customize button to expand config panel
			const customizeButton = screen.getByRole('button', { name: /customize/i });
			fireEvent.click(customizeButton);

			// Wait for config panel to appear and verify MAESTRO_SESSION_RESUMED is displayed
			await waitFor(() => {
				expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
			});

			// Also verify the value hint is shown
			expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
		});

		it('should show warning when changing moderator agent', async () => {
			// Setup multiple agents
			setupDefaultMocks([
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'codex', name: 'Codex' }),
			]);

			const onSave = vi.fn();
			const onClose = vi.fn();
			const groupChat = createMockGroupChat({ moderatorAgentId: 'claude-code' });

			render(
				<GroupChatModal
					mode="edit"
					theme={createMockTheme()}
					isOpen={true}
					groupChat={groupChat}
					onClose={onClose}
					onSave={onSave}
				/>
			);

			// Wait for dropdown
			await waitFor(
				() => {
					expect(screen.getByRole('combobox', { name: /select moderator/i })).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			// Change to different agent
			const dropdown = screen.getByRole('combobox', { name: /select moderator/i });
			fireEvent.change(dropdown, { target: { value: 'codex' } });

			// Verify warning message appears
			await waitFor(() => {
				expect(screen.getByText(/changing the moderator agent/i)).toBeInTheDocument();
			});
		});
	});
});
