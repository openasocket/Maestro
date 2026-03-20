/**
 * Tests for TemplateBrowserModal component.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TemplateBrowserModal } from '../../../renderer/components/TemplateBrowserModal';
import type { Theme } from '../../../renderer/types';
import type { TeamTemplate } from '../../../shared/group-chat-types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Search: ({ className }: { className?: string }) => (
		<span data-testid="search-icon" className={className}>
			S
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
	Copy: ({ className }: { className?: string }) => (
		<span data-testid="copy-icon" className={className}>
			C
		</span>
	),
	Trash2: ({ className }: { className?: string }) => (
		<span data-testid="trash-icon" className={className}>
			D
		</span>
	),
	X: () => <svg data-testid="x-icon" />,
}));

// Mock layer stack context
vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-template-browser'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
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

function createMockTemplate(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
	return {
		id: 'template-1',
		name: 'Test Template',
		description: 'A test team template',
		category: 'builtin',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		moderatorAgentId: 'claude-code',
		roles: [
			{
				name: 'Developer',
				agentId: 'claude-code',
				description: 'Writes code',
			},
			{
				name: 'Reviewer',
				agentId: 'claude-code',
				description: 'Reviews code',
			},
		],
		...overrides,
	};
}

// =============================================================================
// TESTS
// =============================================================================

describe('TemplateBrowserModal', () => {
	const theme = createMockTheme();

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('should not render when isOpen is false', () => {
		render(<TemplateBrowserModal theme={theme} isOpen={false} onClose={vi.fn()} />);

		expect(screen.queryByText('Team Templates')).not.toBeInTheDocument();
	});

	it('should render when isOpen is true and show loading state', () => {
		vi.mocked(window.maestro.teamTemplates.list).mockReturnValue(
			new Promise(() => {}) // Never resolves - stays loading
		);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		expect(screen.getByText('Team Templates')).toBeInTheDocument();
	});

	it('should display templates after loading', async () => {
		const templates = [
			createMockTemplate({ id: 't1', name: 'Code Review Team' }),
			createMockTemplate({ id: 't2', name: 'Research Team', category: 'user' }),
		];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
			expect(screen.getByText('Research Team')).toBeInTheDocument();
		});
	});

	it('should show empty state when no templates match search', async () => {
		const templates = [createMockTemplate({ id: 't1', name: 'Code Review Team' })];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
		});

		// Search for something that doesn't exist
		const searchInput = screen.getByPlaceholderText('Search templates...');
		fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

		expect(screen.getByText('No templates match your search.')).toBeInTheDocument();
	});

	it('should filter templates by search text', async () => {
		const templates = [
			createMockTemplate({ id: 't1', name: 'Code Review Team' }),
			createMockTemplate({ id: 't2', name: 'Research Team' }),
		];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
		});

		const searchInput = screen.getByPlaceholderText('Search templates...');
		fireEvent.change(searchInput, { target: { value: 'Code Review' } });

		expect(screen.getByText('Code Review Team')).toBeInTheDocument();
		expect(screen.queryByText('Research Team')).not.toBeInTheDocument();
	});

	it('should filter by category when clicking filter buttons', async () => {
		const templates = [
			createMockTemplate({ id: 't1', name: 'Builtin Template', category: 'builtin' }),
			createMockTemplate({ id: 't2', name: 'User Template', category: 'user' }),
		];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('Builtin Template')).toBeInTheDocument();
			expect(screen.getByText('User Template')).toBeInTheDocument();
		});

		// Click "Custom" filter
		fireEvent.click(screen.getByText('Custom'));

		expect(screen.queryByText('Builtin Template')).not.toBeInTheDocument();
		expect(screen.getByText('User Template')).toBeInTheDocument();

		// Click "Built-in" filter
		fireEvent.click(screen.getByText('Built-in'));

		expect(screen.getByText('Builtin Template')).toBeInTheDocument();
		expect(screen.queryByText('User Template')).not.toBeInTheDocument();
	});

	it('should call onSelect with selected template and close', async () => {
		const templates = [createMockTemplate({ id: 't1', name: 'Code Review Team' })];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);
		const onSelect = vi.fn();
		const onClose = vi.fn();

		render(
			<TemplateBrowserModal theme={theme} isOpen={true} onClose={onClose} onSelect={onSelect} />
		);

		await waitFor(() => {
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
		});

		// Click to select the template
		fireEvent.click(screen.getByText('Code Review Team'));

		// Click "Use Template" button
		const useButton = screen.getByRole('button', { name: 'Use Template' });
		await act(async () => {
			fireEvent.click(useButton);
		});

		expect(onSelect).toHaveBeenCalledWith(templates[0]);
		expect(onClose).toHaveBeenCalled();
	});

	it('should disable "Use Template" button when nothing is selected', async () => {
		const templates = [createMockTemplate({ id: 't1', name: 'Code Review Team' })];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(
			<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} onSelect={vi.fn()} />
		);

		await waitFor(() => {
			expect(screen.getByText('Code Review Team')).toBeInTheDocument();
		});

		const useButton = screen.getByRole('button', { name: 'Use Template' });
		expect(useButton).toBeDisabled();
	});

	it('should show role count for each template', async () => {
		const templates = [
			createMockTemplate({
				id: 't1',
				name: 'Two Roles',
				roles: [
					{ name: 'Dev', agentId: 'claude-code', description: 'Develops' },
					{ name: 'Reviewer', agentId: 'claude-code', description: 'Reviews' },
				],
			}),
			createMockTemplate({
				id: 't2',
				name: 'One Role',
				roles: [{ name: 'Solo', agentId: 'claude-code', description: 'Does everything' }],
			}),
		];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('2 roles')).toBeInTheDocument();
			expect(screen.getByText('1 role')).toBeInTheDocument();
		});
	});

	it('should show delete button only for user templates', async () => {
		const templates = [
			createMockTemplate({ id: 't1', name: 'Builtin Template', category: 'builtin' }),
			createMockTemplate({ id: 't2', name: 'My User Template', category: 'user' }),
		];

		vi.mocked(window.maestro.teamTemplates.list).mockResolvedValue(templates);

		render(<TemplateBrowserModal theme={theme} isOpen={true} onClose={vi.fn()} />);

		await waitFor(() => {
			expect(screen.getByText('Builtin Template')).toBeInTheDocument();
			expect(screen.getByText('My User Template')).toBeInTheDocument();
		});

		// Should only have one delete button (for the user template)
		const deleteButtons = screen.getAllByTitle('Delete template');
		expect(deleteButtons).toHaveLength(1);
	});
});
