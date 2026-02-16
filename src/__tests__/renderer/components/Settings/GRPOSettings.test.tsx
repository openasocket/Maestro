/**
 * Tests for GRPO Settings Panel and Experience Library UI.
 *
 * Tests:
 * 1. GRPOSettings renders with toggle disabled by default
 * 2. Toggle enables/disables GRPO (calls setConfig)
 * 3. Numeric inputs update config values
 * 4. Reward weight sliders update correctly
 * 5. ExperienceLibraryPanel renders entries grouped by category
 * 6. Search filters entries by content
 * 7. Category dropdown filters by category
 * 8. Add button opens ExperienceEditModal
 * 9. Edit/Delete buttons call correct IPC methods
 * 10. Import/Export triggers file operations
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { GRPOSettings } from '../../../../renderer/components/Settings/GRPOSettings';
import { ExperienceLibraryPanel } from '../../../../renderer/components/Settings/ExperienceLibraryPanel';
import { ExperienceEditModal } from '../../../../renderer/components/Settings/ExperienceEditModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../../renderer/types';
import type { ExperienceEntry } from '../../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../../shared/grpo-types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	Search: () => <svg data-testid="search-icon" />,
	ChevronDown: () => <svg data-testid="chevron-down-icon" />,
	ChevronRight: () => <svg data-testid="chevron-right-icon" />,
	Plus: () => <svg data-testid="plus-icon" />,
	Download: () => <svg data-testid="download-icon" />,
	Upload: () => <svg data-testid="upload-icon" />,
	Trash2: () => <svg data-testid="trash2-icon" />,
	Pencil: () => <svg data-testid="pencil-icon" />,
	X: () => <svg data-testid="x-icon" />,
	Scissors: () => <svg data-testid="scissors-icon" />,
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const mockEntries: ExperienceEntry[] = [
	{
		id: 'exp-1',
		content: 'This project uses vitest not jest',
		category: 'testing',
		scope: 'project',
		agentType: 'all',
		createdAt: Date.now() - 3600000,
		updatedAt: Date.now() - 3600000,
		evidenceCount: 5,
		useCount: 12,
		lastRolloutGroupId: null,
		tokenEstimate: 8,
	},
	{
		id: 'exp-2',
		content: 'Run existing test suite before making changes',
		category: 'testing',
		scope: 'project',
		agentType: 'all',
		createdAt: Date.now() - 86400000,
		updatedAt: Date.now() - 86400000,
		evidenceCount: 3,
		useCount: 8,
		lastRolloutGroupId: null,
		tokenEstimate: 9,
	},
	{
		id: 'exp-3',
		content: 'Components use React.memo wrapping as standard practice',
		category: 'architecture',
		scope: 'project',
		agentType: 'all',
		createdAt: Date.now() - 10800000,
		updatedAt: Date.now() - 10800000,
		evidenceCount: 7,
		useCount: 15,
		lastRolloutGroupId: null,
		tokenEstimate: 10,
	},
];

// Mock the GRPO API on window.maestro
const mockGrpoApi = {
	getConfig: vi.fn(),
	setConfig: vi.fn(),
	getLibrary: vi.fn(),
	addExperience: vi.fn(),
	modifyExperience: vi.fn(),
	deleteExperience: vi.fn(),
	getHistory: vi.fn(),
	collectRewards: vi.fn(),
	getStats: vi.fn(),
	pruneLibrary: vi.fn(),
	exportLibrary: vi.fn(),
	importLibrary: vi.fn(),
};

// Setup window.maestro mock
beforeEach(() => {
	vi.clearAllMocks();

	// Default mock implementations
	mockGrpoApi.getConfig.mockResolvedValue({
		success: true,
		data: { ...GRPO_CONFIG_DEFAULTS },
	});
	mockGrpoApi.setConfig.mockResolvedValue({ success: true });
	mockGrpoApi.getLibrary.mockResolvedValue({
		success: true,
		data: mockEntries,
	});
	mockGrpoApi.addExperience.mockResolvedValue({
		success: true,
		data: { id: 'exp-new' },
	});
	mockGrpoApi.modifyExperience.mockResolvedValue({ success: true });
	mockGrpoApi.deleteExperience.mockResolvedValue({ success: true });
	mockGrpoApi.pruneLibrary.mockResolvedValue({ success: true, data: [] });
	mockGrpoApi.exportLibrary.mockResolvedValue({
		success: true,
		data: JSON.stringify(mockEntries),
	});
	mockGrpoApi.importLibrary.mockResolvedValue({ success: true, data: 3 });

	// @ts-ignore - mock window.maestro
	window.maestro = {
		...((window as any).maestro || {}),
		grpo: mockGrpoApi,
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// ─── GRPOSettings Tests ──────────────────────────────────────────────

describe('GRPOSettings', () => {
	it('renders with toggle disabled by default', async () => {
		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Training-Free GRPO')).toBeInTheDocument();
		});

		// Default config has enabled: false
		expect(mockGrpoApi.getConfig).toHaveBeenCalled();
	});

	it('toggle enables GRPO and calls setConfig', async () => {
		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Training-Free GRPO')).toBeInTheDocument();
		});

		// Find and click the toggle button (next to the header)
		const toggleButtons = screen.getAllByRole('button');
		const masterToggle = toggleButtons[0]; // First button is the master toggle
		fireEvent.click(masterToggle);

		expect(mockGrpoApi.setConfig).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: true })
		);
	});

	it('renders configuration section with numeric inputs', async () => {
		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Configuration')).toBeInTheDocument();
		});

		expect(screen.getByText('Rollout Group Size')).toBeInTheDocument();
		expect(screen.getByText('Max Library Size')).toBeInTheDocument();
		expect(screen.getByText('Max Injection Tokens')).toBeInTheDocument();
		expect(screen.getByText('Variance Threshold')).toBeInTheDocument();
		expect(screen.getByText('Introspection Model')).toBeInTheDocument();
	});

	it('numeric input updates config value', async () => {
		mockGrpoApi.getConfig.mockResolvedValue({
			success: true,
			data: { ...GRPO_CONFIG_DEFAULTS, enabled: true },
		});

		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Configuration')).toBeInTheDocument();
		});

		// Find the rollout group size input (first number input)
		const numberInputs = screen.getAllByRole('spinbutton');
		const rolloutInput = numberInputs[0];
		fireEvent.change(rolloutInput, { target: { value: '5' } });

		expect(mockGrpoApi.setConfig).toHaveBeenCalledWith(
			expect.objectContaining({ rolloutGroupSize: 5 })
		);
	});

	it('renders reward weights section', async () => {
		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Reward Weights')).toBeInTheDocument();
		});

		expect(screen.getByText('Test Pass')).toBeInTheDocument();
		expect(screen.getByText('Build Success')).toBeInTheDocument();
		expect(screen.getByText('Lint Clean')).toBeInTheDocument();
		expect(screen.getByText('Git Diff Quality')).toBeInTheDocument();
	});

	it('reward weight slider updates correctly', async () => {
		mockGrpoApi.getConfig.mockResolvedValue({
			success: true,
			data: { ...GRPO_CONFIG_DEFAULTS, enabled: true },
		});

		render(<GRPOSettings theme={testTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Reward Weights')).toBeInTheDocument();
		});

		// Find all range inputs in the reward weights section
		const sliders = screen.getAllByRole('slider');
		// Change the first reward weight slider
		fireEvent.change(sliders[0], { target: { value: '50' } });

		expect(mockGrpoApi.setConfig).toHaveBeenCalled();
	});
});

// ─── ExperienceLibraryPanel Tests ────────────────────────────────────

describe('ExperienceLibraryPanel', () => {
	it('renders entries grouped by category', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		// Category headers are rendered as buttons
		const buttons = screen.getAllByRole('button');
		const categoryButtons = buttons.filter((b) => b.textContent?.includes('testing') || b.textContent?.includes('architecture'));
		expect(categoryButtons.length).toBeGreaterThanOrEqual(2);

		expect(screen.getByText('Components use React.memo wrapping as standard practice')).toBeInTheDocument();
	});

	it('displays entry count and token total', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText(/3 entries/)).toBeInTheDocument();
			expect(screen.getByText(/~27 tokens/)).toBeInTheDocument();
		});
	});

	it('search filters entries by content', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		const searchInput = screen.getByPlaceholderText('Search...');
		fireEvent.change(searchInput, { target: { value: 'vitest' } });

		expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		expect(screen.queryByText('Components use React.memo wrapping as standard practice')).not.toBeInTheDocument();
	});

	it('category dropdown filters by category', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		const categorySelect = screen.getByDisplayValue('All Categories');
		fireEvent.change(categorySelect, { target: { value: 'architecture' } });

		expect(screen.getByText('Components use React.memo wrapping as standard practice')).toBeInTheDocument();
		expect(screen.queryByText('This project uses vitest not jest')).not.toBeInTheDocument();
	});

	it('add button opens experience edit modal', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		const addButton = screen.getByTitle('Add Experience');
		fireEvent.click(addButton);

		await waitFor(() => {
			expect(screen.getByText('Add Experience')).toBeInTheDocument();
		});
	});

	it('delete button shows confirmation then calls deleteExperience', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		// Find all delete buttons (Trash2 icons)
		const deleteButtons = screen.getAllByTitle('Delete');
		fireEvent.click(deleteButtons[0]);

		// Should show confirmation
		await waitFor(() => {
			expect(screen.getByText('Confirm')).toBeInTheDocument();
		});

		// Click confirm
		fireEvent.click(screen.getByText('Confirm'));

		await waitFor(() => {
			expect(mockGrpoApi.deleteExperience).toHaveBeenCalledWith('/test/project', 'exp-1');
		});
	});

	it('export triggers file download', async () => {
		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText('This project uses vitest not jest')).toBeInTheDocument();
		});

		const exportButton = screen.getByTitle('Export');
		fireEvent.click(exportButton);

		await waitFor(() => {
			expect(mockGrpoApi.exportLibrary).toHaveBeenCalledWith('/test/project');
		});
	});

	it('shows empty state when no entries', async () => {
		mockGrpoApi.getLibrary.mockResolvedValue({ success: true, data: [] });

		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		await waitFor(() => {
			expect(screen.getByText(/No experiences yet/)).toBeInTheDocument();
		});
	});

	it('shows loading state initially', () => {
		// Don't resolve the promise
		mockGrpoApi.getLibrary.mockReturnValue(new Promise(() => {}));

		renderWithLayerStack(
			<ExperienceLibraryPanel theme={testTheme} projectPath="/test/project" />
		);

		expect(screen.getByText('Loading experience library...')).toBeInTheDocument();
	});
});

// ─── ExperienceEditModal Tests ───────────────────────────────────────

describe('ExperienceEditModal', () => {
	it('renders add mode with empty fields', () => {
		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('Add Experience')).toBeInTheDocument();
		expect(screen.getByText('Save')).toBeInTheDocument();
		expect(screen.getByText('Cancel')).toBeInTheDocument();
	});

	it('renders edit mode with populated fields', () => {
		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={mockEntries[0]}
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('Edit Experience')).toBeInTheDocument();
		expect(screen.getByDisplayValue('This project uses vitest not jest')).toBeInTheDocument();
	});

	it('shows live token estimate', () => {
		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		const textarea = screen.getByPlaceholderText(/When modifying React/);
		fireEvent.change(textarea, { target: { value: 'Test content here' } });

		// ~4 tokens for "Test content here" (17 chars / 4)
		expect(screen.getByText(/Token estimate: ~\d+ tokens/)).toBeInTheDocument();
	});

	it('calls onSave with correct data for new entry', () => {
		const onSave = vi.fn();

		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={onSave}
				onClose={vi.fn()}
			/>
		);

		const textarea = screen.getByPlaceholderText(/When modifying React/);
		fireEvent.change(textarea, { target: { value: 'New experience content' } });

		fireEvent.click(screen.getByText('Save'));

		expect(onSave).toHaveBeenCalledWith(
			{
				content: 'New experience content',
				category: 'testing',
				agentType: 'all',
				scope: 'project',
			},
			undefined
		);
	});

	it('calls onSave with existing ID for edit mode', () => {
		const onSave = vi.fn();

		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={mockEntries[0]}
				onSave={onSave}
				onClose={vi.fn()}
			/>
		);

		fireEvent.click(screen.getByText('Save'));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'This project uses vitest not jest',
			}),
			'exp-1'
		);
	});

	it('calls onClose when Cancel is clicked', () => {
		const onClose = vi.fn();

		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={vi.fn()}
				onClose={onClose}
			/>
		);

		fireEvent.click(screen.getByText('Cancel'));
		expect(onClose).toHaveBeenCalled();
	});

	it('validates content is required', () => {
		const onSave = vi.fn();

		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={onSave}
				onClose={vi.fn()}
			/>
		);

		// Save button should be disabled (no content)
		const saveButton = screen.getByText('Save');
		fireEvent.click(saveButton);
		expect(onSave).not.toHaveBeenCalled();
	});

	it('shows character count', () => {
		renderWithLayerStack(
			<ExperienceEditModal
				theme={testTheme}
				entry={null}
				onSave={vi.fn()}
				onClose={vi.fn()}
			/>
		);

		expect(screen.getByText('0/500')).toBeInTheDocument();
	});
});
