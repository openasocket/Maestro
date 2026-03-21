/**
 * @fileoverview Tests for TeamBuilderWizard component
 *
 * Tests the 4-step wizard flow: Intent → Roles → Topology → Confirm
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TeamBuilderWizard } from '../../../renderer/components/GroupChat/TeamBuilderWizard';
import type { Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => {
	const icon =
		(name: string) =>
		({ className }: { className?: string }) => (
			<span data-testid={`${name}-icon`} className={className}>
				{name}
			</span>
		);
	return {
		Wand2: icon('wand2'),
		Plus: icon('plus'),
		Trash2: icon('trash2'),
		ChevronDown: icon('chevron-down'),
		ChevronRight: icon('chevron-right'),
		RotateCcw: icon('rotate-ccw'),
		ArrowRight: icon('arrow-right'),
		ArrowLeft: icon('arrow-left'),
		Save: icon('save'),
		MessageSquarePlus: icon('message-square-plus'),
		Loader2: icon('loader2'),
		X: icon('x'),
	};
});

// Mock layer stack context
const mockRegisterLayer = vi.fn(() => 'layer-team-builder-123');
const mockUnregisterLayer = vi.fn();
const mockUpdateLayerHandler = vi.fn();

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mockRegisterLayer,
		unregisterLayer: mockUnregisterLayer,
		updateLayerHandler: mockUpdateLayerHandler,
	}),
}));

// Mock settings store
const mockSettingsState = {
	encoreFeatures: { teamOrchestration: true },
	teamOrchestrationSettings: {
		enableTemplates: true,
		enableWorkflowTopology: false,
		enableVisualization: false,
		maxIterations: 5,
		defaultTerminationMode: 'moderator-decides',
	},
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
			accentForeground: '#ffffff',
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

function renderWizard(overrides: Partial<Parameters<typeof TeamBuilderWizard>[0]> = {}) {
	const defaultProps = {
		theme: createMockTheme(),
		isOpen: true,
		onClose: vi.fn(),
		onCreateGroupChat: vi.fn(),
		onSaveTemplate: vi.fn(),
		...overrides,
	};
	return { ...render(<TeamBuilderWizard {...defaultProps} />), props: defaultProps };
}

// =============================================================================
// TESTS
// =============================================================================

describe('TeamBuilderWizard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRegisterLayer.mockClear().mockReturnValue('layer-team-builder-123');
	});

	describe('Rendering', () => {
		it('should not render when isOpen is false', () => {
			const { container } = render(
				<TeamBuilderWizard
					theme={createMockTheme()}
					isOpen={false}
					onClose={vi.fn()}
					onCreateGroupChat={vi.fn()}
					onSaveTemplate={vi.fn()}
				/>
			);
			expect(container.innerHTML).toBe('');
		});

		it('should render the modal with Team Builder title when open', () => {
			renderWizard();
			expect(screen.getByRole('dialog')).toBeInTheDocument();
			expect(screen.getByText('Team Builder')).toBeInTheDocument();
		});

		it('should show step 0 (intent input) by default', () => {
			renderWizard();
			expect(
				screen.getByPlaceholderText('Describe what you want this team to accomplish...')
			).toBeInTheDocument();
		});

		it('should display example intent chips', () => {
			renderWizard();
			expect(screen.getByText('Build a full-stack feature with code review')).toBeInTheDocument();
			expect(
				screen.getByText('Research a topic and produce a comprehensive report')
			).toBeInTheDocument();
		});

		it('should show Build Team button on step 0', () => {
			renderWizard();
			expect(screen.getByText('Build Team')).toBeInTheDocument();
		});
	});

	describe('Step 0 — Intent Input', () => {
		it('should disable Build Team when textarea is empty', () => {
			renderWizard();
			const button = screen.getByText('Build Team');
			expect(button).toBeDisabled();
		});

		it('should enable Build Team when intent is entered', () => {
			renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a REST API' } });
			expect(screen.getByText('Build Team')).not.toBeDisabled();
		});

		it('should populate textarea when clicking an example chip', () => {
			renderWizard();
			const chip = screen.getByText('Build a full-stack feature with code review');
			fireEvent.click(chip);
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			) as HTMLTextAreaElement;
			expect(textarea.value).toBe('Build a full-stack feature with code review');
		});
	});

	describe('Step 0 → Step 1 transition', () => {
		it('should show loading state when Build Team is clicked', async () => {
			renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a feature' } });
			fireEvent.click(screen.getByText('Build Team'));

			await waitFor(() => {
				expect(screen.getByText('Building your team...')).toBeInTheDocument();
			});
		});

		it('should transition to step 1 after AI generates roles', async () => {
			renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a feature' } });
			fireEvent.click(screen.getByText('Build Team'));

			await waitFor(
				() => {
					expect(screen.getByText('Team Name')).toBeInTheDocument();
					expect(screen.getByDisplayValue('Development Team')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
		});
	});

	describe('Step 1 — Role Assignment Review', () => {
		async function goToStep1() {
			const result = renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a feature' } });
			fireEvent.click(screen.getByText('Build Team'));
			await waitFor(
				() => {
					expect(screen.getByDisplayValue('Development Team')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
			return result;
		}

		it('should display generated roles', async () => {
			await goToStep1();
			expect(screen.getByDisplayValue('Lead Developer')).toBeInTheDocument();
			expect(screen.getByDisplayValue('Code Reviewer')).toBeInTheDocument();
			expect(screen.getByDisplayValue('Test Engineer')).toBeInTheDocument();
		});

		it('should allow editing role names', async () => {
			await goToStep1();
			const input = screen.getByDisplayValue('Lead Developer');
			fireEvent.change(input, { target: { value: 'Senior Developer' } });
			expect(screen.getByDisplayValue('Senior Developer')).toBeInTheDocument();
		});

		it('should allow removing a role', async () => {
			await goToStep1();
			const removeButtons = screen.getAllByTitle('Remove role');
			expect(removeButtons.length).toBe(3);
			fireEvent.click(removeButtons[0]);
			expect(screen.queryByDisplayValue('Lead Developer')).not.toBeInTheDocument();
		});

		it('should allow adding a new role', async () => {
			await goToStep1();
			fireEvent.click(screen.getByText('Add Role'));
			expect(screen.getByDisplayValue('New Role')).toBeInTheDocument();
		});

		it('should show Approve & Continue and Revise buttons', async () => {
			await goToStep1();
			expect(screen.getByText('Approve & Continue')).toBeInTheDocument();
			expect(screen.getByText('Revise')).toBeInTheDocument();
		});

		it('should show Back button', async () => {
			await goToStep1();
			expect(screen.getByText('Back')).toBeInTheDocument();
		});

		it('should go back to step 0 when Back is clicked', async () => {
			await goToStep1();
			fireEvent.click(screen.getByText('Back'));
			expect(
				screen.getByPlaceholderText('Describe what you want this team to accomplish...')
			).toBeInTheDocument();
		});
	});

	describe('Step 1 → Step 3 (topology disabled)', () => {
		it('should skip topology and go to confirmation when topology is disabled', async () => {
			renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a feature' } });
			fireEvent.click(screen.getByText('Build Team'));

			await waitFor(
				() => {
					expect(screen.getByDisplayValue('Development Team')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);

			fireEvent.click(screen.getByText('Approve & Continue'));

			await waitFor(
				() => {
					expect(screen.getByText('Create Group Chat')).toBeInTheDocument();
					expect(screen.getByText('Save as Template')).toBeInTheDocument();
				},
				{ timeout: 3000 }
			);
		});
	});

	describe('Step 3 — Confirmation', () => {
		async function goToStep3() {
			const result = renderWizard();
			const textarea = screen.getByPlaceholderText(
				'Describe what you want this team to accomplish...'
			);
			fireEvent.change(textarea, { target: { value: 'Build a feature' } });
			fireEvent.click(screen.getByText('Build Team'));
			await waitFor(
				() => expect(screen.getByDisplayValue('Development Team')).toBeInTheDocument(),
				{ timeout: 3000 }
			);
			fireEvent.click(screen.getByText('Approve & Continue'));
			await waitFor(() => expect(screen.getByText('Create Group Chat')).toBeInTheDocument(), {
				timeout: 3000,
			});
			return result;
		}

		it('should show team summary', async () => {
			await goToStep3();
			expect(screen.getByText('Development Team')).toBeInTheDocument();
			expect(screen.getByText('Roles (3)')).toBeInTheDocument();
		});

		it('should call onCreateGroupChat when Create Group Chat is clicked', async () => {
			const { props } = await goToStep3();
			fireEvent.click(screen.getByText('Create Group Chat'));
			expect(props.onCreateGroupChat).toHaveBeenCalledTimes(1);
			expect(props.onCreateGroupChat).toHaveBeenCalledWith(
				'Development Team',
				'claude-code',
				expect.arrayContaining([expect.objectContaining({ name: 'Lead Developer' })]),
				undefined
			);
		});

		it('should call onSaveTemplate when Save as Template is clicked', async () => {
			const { props } = await goToStep3();
			fireEvent.click(screen.getByText('Save as Template'));
			expect(props.onSaveTemplate).toHaveBeenCalledTimes(1);
			expect(props.onSaveTemplate).toHaveBeenCalledWith(
				expect.objectContaining({
					name: 'Development Team',
					moderatorAgentId: 'claude-code',
				})
			);
		});

		it('should call both when Create & Save is clicked', async () => {
			const { props } = await goToStep3();
			fireEvent.click(screen.getByText('Create & Save'));
			expect(props.onSaveTemplate).toHaveBeenCalledTimes(1);
			expect(props.onCreateGroupChat).toHaveBeenCalledTimes(1);
		});

		it('should call onClose after any final action', async () => {
			const { props } = await goToStep3();
			fireEvent.click(screen.getByText('Create Group Chat'));
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Close behavior', () => {
		it('should call onClose and reset state when Cancel is clicked', () => {
			const { props } = renderWizard();
			fireEvent.click(screen.getByText('Cancel'));
			expect(props.onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Step indicator', () => {
		it('should show step dots', () => {
			renderWizard();
			// Step 0 should show "Describe" as active label
			expect(screen.getByText('Describe')).toBeInTheDocument();
		});
	});
});
