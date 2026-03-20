/**
 * Tests for SaveAsTemplateModal and "Save as Template" context menu integration
 * in GroupChatList.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SaveAsTemplateModal } from '../../../renderer/components/SaveAsTemplateModal';
import { GroupChatList } from '../../../renderer/components/GroupChatList';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, GroupChat } from '../../../renderer/types';
import { notifyToast } from '../../../renderer/stores/notificationStore';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	BookTemplate: ({ className }: { className?: string }) => (
		<span data-testid="book-template-icon" className={className}>
			T
		</span>
	),
	MessageSquare: ({ className }: { className?: string }) => (
		<span data-testid="message-square-icon" className={className}>
			M
		</span>
	),
	ChevronDown: ({ className }: { className?: string }) => (
		<span data-testid="chevron-down" className={className}>
			v
		</span>
	),
	ChevronRight: ({ className }: { className?: string }) => (
		<span data-testid="chevron-right" className={className}>
			&gt;
		</span>
	),
	Edit3: ({ className }: { className?: string }) => (
		<span data-testid="edit3-icon" className={className}>
			E
		</span>
	),
	Trash2: ({ className }: { className?: string }) => (
		<span data-testid="trash2-icon" className={className}>
			D
		</span>
	),
	Settings: ({ className }: { className?: string }) => (
		<span data-testid="settings-icon" className={className}>
			S
		</span>
	),
	Archive: ({ className }: { className?: string }) => (
		<span data-testid="archive-icon" className={className}>
			A
		</span>
	),
	ArchiveRestore: ({ className }: { className?: string }) => (
		<span data-testid="archive-restore-icon" className={className}>
			AR
		</span>
	),
	X: () => <svg data-testid="x-icon" />,
}));

// Mock layer stack context
vi.mock('../../../renderer/contexts/LayerStackContext', async () => {
	const actual = await vi.importActual('../../../renderer/contexts/LayerStackContext');
	return {
		...actual,
		useLayerStack: () => ({
			registerLayer: vi.fn(() => 'layer-id'),
			unregisterLayer: vi.fn(),
			updateLayerHandler: vi.fn(),
		}),
	};
});

// Mock notification store
vi.mock('../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

// Mock settings store
const mockSettingsState = {
	encoreFeatures: { teamOrchestration: true },
	teamOrchestrationSettings: { enableTemplates: true },
};

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (state: typeof mockSettingsState) => unknown) =>
		selector(mockSettingsState),
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

function createMockGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'chat-1',
		name: 'Test Group Chat',
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'session-1',
		createdAt: Date.now(),
		participants: [
			{
				name: 'Agent 1',
				agentId: 'claude-code',
				sessionId: 'session-2',
				addedAt: Date.now(),
			},
		],
		logPath: '/tmp/log',
		imagesDir: '/tmp/images',
		...overrides,
	};
}

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// =============================================================================
// SaveAsTemplateModal Tests
// =============================================================================

describe('SaveAsTemplateModal', () => {
	const theme = createMockTheme();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should not render when isOpen is false', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={false}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={vi.fn()}
			/>
		);

		expect(screen.queryByText('Save Team Template')).not.toBeInTheDocument();
	});

	it('should render when isOpen is true', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('Save Team Template')).toBeInTheDocument();
	});

	it('should pre-fill the name field with the chat name', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="My Team Chat"
				onClose={vi.fn()}
			/>
		);

		const nameInput = screen.getByPlaceholderText('e.g., Code Review Team');
		expect(nameInput).toHaveValue('My Team Chat');
	});

	it('should show Template Name and Description labels', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('Template Name')).toBeInTheDocument();
		expect(screen.getByText('Description')).toBeInTheDocument();
	});

	it('should show helper text about capturing participants', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={vi.fn()}
			/>
		);

		expect(
			screen.getByText(
				'The template will capture the current participants and moderator configuration.'
			)
		).toBeInTheDocument();
	});

	it('should call createFromChat and show toast on save', async () => {
		const mockTemplate = {
			id: 'template-1',
			name: 'Test Chat',
			description: 'A test description',
			category: 'user' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			moderatorAgentId: 'claude-code',
			roles: [],
		};

		vi.mocked(window.maestro.teamTemplates.createFromChat).mockResolvedValue(mockTemplate);
		const onClose = vi.fn();

		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={onClose}
			/>
		);

		// Fill in description
		const descriptionTextarea = screen.getByPlaceholderText(
			'What does this team configuration do?'
		);
		fireEvent.change(descriptionTextarea, { target: { value: 'A test description' } });

		// Click Save Template
		const saveButton = screen.getByRole('button', { name: 'Save Template' });
		await act(async () => {
			fireEvent.click(saveButton);
		});

		await waitFor(() => {
			expect(window.maestro.teamTemplates.createFromChat).toHaveBeenCalledWith(
				'chat-1',
				'Test Chat',
				'A test description'
			);
		});

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'success',
				title: 'Team template saved',
			})
		);

		expect(onClose).toHaveBeenCalled();
	});

	it('should show error toast when createFromChat fails', async () => {
		vi.mocked(window.maestro.teamTemplates.createFromChat).mockRejectedValue(
			new Error('Storage error')
		);
		const onClose = vi.fn();

		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={onClose}
			/>
		);

		const saveButton = screen.getByRole('button', { name: 'Save Template' });
		await act(async () => {
			fireEvent.click(saveButton);
		});

		await waitFor(() => {
			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'error',
					title: 'Failed to save template',
					message: 'Storage error',
				})
			);
		});

		// Should NOT close the modal on error
		expect(onClose).not.toHaveBeenCalled();
	});

	it('should disable Save button when name is empty', () => {
		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName=""
				onClose={vi.fn()}
			/>
		);

		const saveButton = screen.getByRole('button', { name: 'Save Template' });
		expect(saveButton).toBeDisabled();
	});

	it('should call onClose when Cancel is clicked', async () => {
		const onClose = vi.fn();

		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={onClose}
			/>
		);

		const cancelButton = screen.getByRole('button', { name: 'Cancel' });
		await act(async () => {
			fireEvent.click(cancelButton);
		});

		expect(onClose).toHaveBeenCalled();
	});

	it('should pass description as undefined when empty', async () => {
		const mockTemplate = {
			id: 'template-1',
			name: 'Test Chat',
			description: '',
			category: 'user' as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			moderatorAgentId: 'claude-code',
			roles: [],
		};

		vi.mocked(window.maestro.teamTemplates.createFromChat).mockResolvedValue(mockTemplate);

		renderWithLayerStack(
			<SaveAsTemplateModal
				theme={theme}
				isOpen={true}
				chatId="chat-1"
				chatName="Test Chat"
				onClose={vi.fn()}
			/>
		);

		// Leave description empty, just click save
		const saveButton = screen.getByRole('button', { name: 'Save Template' });
		await act(async () => {
			fireEvent.click(saveButton);
		});

		await waitFor(() => {
			expect(window.maestro.teamTemplates.createFromChat).toHaveBeenCalledWith(
				'chat-1',
				'Test Chat',
				undefined
			);
		});
	});
});

// =============================================================================
// GroupChatList Context Menu Integration Tests
// =============================================================================

describe('GroupChatList - Save as Template context menu', () => {
	const theme = createMockTheme();
	const defaultProps = {
		theme,
		groupChats: [createMockGroupChat()],
		activeGroupChatId: null,
		onOpenGroupChat: vi.fn(),
		onNewGroupChat: vi.fn(),
		onEditGroupChat: vi.fn(),
		onRenameGroupChat: vi.fn(),
		onDeleteGroupChat: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		// Reset feature flags to enabled
		mockSettingsState.encoreFeatures.teamOrchestration = true;
		mockSettingsState.teamOrchestrationSettings.enableTemplates = true;
	});

	it('should show "Save as Template" in context menu when feature is enabled', async () => {
		render(<GroupChatList {...defaultProps} />);

		// Right-click on the group chat item
		const chatItems = screen.getAllByText('Test Group Chat');
		await act(async () => {
			fireEvent.contextMenu(chatItems[0]);
		});

		expect(screen.getByText('Save as Template')).toBeInTheDocument();
	});

	it('should NOT show "Save as Template" when teamOrchestration is disabled', async () => {
		mockSettingsState.encoreFeatures.teamOrchestration = false;

		render(<GroupChatList {...defaultProps} />);

		const chatItems = screen.getAllByText('Test Group Chat');
		await act(async () => {
			fireEvent.contextMenu(chatItems[0]);
		});

		expect(screen.queryByText('Save as Template')).not.toBeInTheDocument();
	});

	it('should NOT show "Save as Template" when enableTemplates is disabled', async () => {
		mockSettingsState.teamOrchestrationSettings.enableTemplates = false;

		render(<GroupChatList {...defaultProps} />);

		const chatItems = screen.getAllByText('Test Group Chat');
		await act(async () => {
			fireEvent.contextMenu(chatItems[0]);
		});

		expect(screen.queryByText('Save as Template')).not.toBeInTheDocument();
	});

	it('should open SaveAsTemplateModal when "Save as Template" is clicked', async () => {
		render(<GroupChatList {...defaultProps} />);

		// Right-click on the group chat item
		const chatItems = screen.getAllByText('Test Group Chat');
		await act(async () => {
			fireEvent.contextMenu(chatItems[0]);
		});

		// Click "Save as Template"
		const saveAsTemplateBtn = screen.getByText('Save as Template');
		await act(async () => {
			fireEvent.click(saveAsTemplateBtn);
		});

		// Modal should appear
		await waitFor(() => {
			expect(screen.getByText('Save Team Template')).toBeInTheDocument();
		});
	});

	it('should pre-fill modal with chat name', async () => {
		render(<GroupChatList {...defaultProps} />);

		const chatItems = screen.getAllByText('Test Group Chat');
		await act(async () => {
			fireEvent.contextMenu(chatItems[0]);
		});

		const saveAsTemplateBtn = screen.getByText('Save as Template');
		await act(async () => {
			fireEvent.click(saveAsTemplateBtn);
		});

		await waitFor(() => {
			const nameInput = screen.getByPlaceholderText('e.g., Code Review Team');
			expect(nameInput).toHaveValue('Test Group Chat');
		});
	});
});
