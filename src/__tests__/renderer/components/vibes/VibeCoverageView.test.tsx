import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VibeCoverageView } from '../../../../renderer/components/vibes/VibeCoverageView';
import type { Theme } from '../../../../renderer/types';

// Mock lucide-react
vi.mock('lucide-react', () => ({
	BarChart3: () => <span data-testid="icon-barchart">BarChart3</span>,
	FileCheck: () => <span data-testid="icon-filecheck">FileCheck</span>,
	FileX: () => <span data-testid="icon-filex">FileX</span>,
	FileMinus: () => <span data-testid="icon-fileminus">FileMinus</span>,
	Filter: () => <span data-testid="icon-filter">Filter</span>,
	ArrowUpDown: () => <span data-testid="icon-arrowupdown">ArrowUpDown</span>,
	AlertTriangle: () => <span data-testid="icon-alert">AlertTriangle</span>,
	Database: () => <span data-testid="icon-database">Database</span>,
	Loader2: () => <span data-testid="icon-loader">Loader2</span>,
	Settings: () => <span data-testid="icon-settings">Settings</span>,
	FolderOpen: () => <span data-testid="icon-folderopen">FolderOpen</span>,
	ChevronRight: () => <span data-testid="icon-chevron-right">ChevronRight</span>,
	ChevronDown: () => <span data-testid="icon-chevron-down">ChevronDown</span>,
	FolderTree: () => <span data-testid="icon-foldertree">FolderTree</span>,
	Files: () => <span data-testid="icon-files">Files</span>,
}));

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#1e1f29',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: 'rgba(189, 147, 249, 0.2)',
		accentText: '#bd93f9',
		accentForeground: '#f8f8f2',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

const mockCoverageData = [
	{
		file_path: 'src/main.ts',
		coverage_status: 'full',
		annotation_count: 12,
	},
	{
		file_path: 'src/utils/helpers.ts',
		coverage_status: 'partial',
		annotation_count: 5,
	},
	{
		file_path: 'src/config.ts',
		coverage_status: 'uncovered',
		annotation_count: 0,
	},
	{
		file_path: 'src/index.ts',
		coverage_status: 'full',
		annotation_count: 8,
	},
];

// Setup window.maestro mock
const mockGetCoverage = vi.fn();
const mockBuild = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();

	mockGetCoverage.mockResolvedValue({
		success: true,
		data: JSON.stringify(mockCoverageData),
	});

	mockBuild.mockResolvedValue({ success: true });

	(window as any).maestro = {
		vibes: {
			getCoverage: mockGetCoverage,
			build: mockBuild,
		},
	};
});

describe('VibeCoverageView', () => {
	// ========================================================================
	// Initial rendering and data loading
	// ========================================================================

	it('renders loading state while fetching coverage data', () => {
		mockGetCoverage.mockReturnValue(new Promise(() => {}));

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		expect(screen.getByText('Loading coverage data...')).toBeTruthy();
	});

	it('fetches coverage data on mount', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(mockGetCoverage).toHaveBeenCalledWith('/test/project');
		});
	});

	it('renders file list after loading', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		expect(screen.getByText('src/utils/helpers.ts')).toBeTruthy();
		expect(screen.getByText('src/config.ts')).toBeTruthy();
		expect(screen.getByText('src/index.ts')).toBeTruthy();
	});

	// ========================================================================
	// Coverage summary
	// ========================================================================

	it('displays coverage percentage', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			// 2 full + 0.5 * 1 partial = 2.5 / 4 = 62.5% → 63%
			expect(screen.getByText('63%')).toBeTruthy();
		});
	});

	it('displays file count stats', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('4 total files')).toBeTruthy();
		});

		expect(screen.getByText('2 covered')).toBeTruthy();
		expect(screen.getByText('1 partial')).toBeTruthy();
		expect(screen.getByText('1 uncovered')).toBeTruthy();
	});

	it('displays total annotation count', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('25 annotations')).toBeTruthy();
		});
	});

	// ========================================================================
	// Coverage status badges
	// ========================================================================

	it('shows correct status badges for each file', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// "Covered" appears as: filter button + 2 status badges = 3 total
		const coveredElements = screen.getAllByText('Covered');
		expect(coveredElements.length).toBe(3);

		// "Partial" appears once as status badge (filter has different text)
		expect(screen.getByText('Partial')).toBeTruthy();

		// "Uncovered" appears as: filter button + 1 status badge = 2 total
		const uncoveredElements = screen.getAllByText('Uncovered');
		expect(uncoveredElements.length).toBe(2);
	});

	// ========================================================================
	// Filter options
	// ========================================================================

	it('renders filter buttons', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('All')).toBeTruthy();
		});

		// "Covered" and "Uncovered" appear in both filter buttons and status badges
		expect(screen.getAllByText('Covered').length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByText('Uncovered').length).toBeGreaterThanOrEqual(1);
	});

	it('filters to show only covered files', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Covered" filter — the filter button, not the status badge
		const filterButtons = screen.getAllByText('Covered');
		// The filter button is in the header area
		fireEvent.click(filterButtons[0]);

		// Covered files should remain
		expect(screen.getByText('src/main.ts')).toBeTruthy();
		expect(screen.getByText('src/utils/helpers.ts')).toBeTruthy();
		expect(screen.getByText('src/index.ts')).toBeTruthy();

		// Uncovered file should be hidden
		expect(screen.queryByText('src/config.ts')).toBeNull();
	});

	it('filters to show only uncovered files', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Uncovered" filter
		const uncoveredButtons = screen.getAllByText('Uncovered');
		fireEvent.click(uncoveredButtons[0]);

		// Uncovered file should show
		expect(screen.getByText('src/config.ts')).toBeTruthy();

		// Covered files should be hidden
		expect(screen.queryByText('src/main.ts')).toBeNull();
		expect(screen.queryByText('src/index.ts')).toBeNull();
	});

	it('shows message when filter returns no results', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{ file_path: 'src/main.ts', coverage_status: 'full', annotation_count: 10 },
			]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Click "Uncovered" filter — no uncovered files exist
		fireEvent.click(screen.getByText('Uncovered'));

		expect(screen.getByText('No files match the current filter.')).toBeTruthy();
	});

	// ========================================================================
	// Sort options
	// ========================================================================

	it('renders sort buttons', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Status')).toBeTruthy();
		});

		expect(screen.getByText('Path')).toBeTruthy();
		expect(screen.getByText('Annotations')).toBeTruthy();
	});

	// ========================================================================
	// Empty state
	// ========================================================================

	it('shows empty state when no coverage data exists', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('No tracked files')).toBeTruthy();
		});

		expect(screen.getByText(/no AI annotation coverage data/)).toBeTruthy();
		expect(screen.getByText(/tracked_extensions/)).toBeTruthy();
	});

	// ========================================================================
	// Build Required state
	// ========================================================================

	it('shows Build Required when database is missing', async () => {
		mockGetCoverage.mockResolvedValue({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Build Required')).toBeTruthy();
		});

		expect(screen.getByText('Build Now')).toBeTruthy();
	});

	it('calls build when Build Now button is clicked', async () => {
		mockGetCoverage.mockResolvedValueOnce({
			success: false,
			error: 'audit.db not found. Run build first.',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Build Now')).toBeTruthy();
		});

		// After build succeeds, coverage will be re-fetched
		mockGetCoverage.mockResolvedValueOnce({
			success: true,
			data: JSON.stringify(mockCoverageData),
		});

		fireEvent.click(screen.getByText('Build Now'));

		await waitFor(() => {
			expect(mockBuild).toHaveBeenCalledWith('/test/project');
		});
	});

	// ========================================================================
	// Error state
	// ========================================================================

	it('shows error state on fetch failure', async () => {
		mockGetCoverage.mockResolvedValue({
			success: false,
			error: 'Something went wrong',
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Something went wrong')).toBeTruthy();
		});
	});

	it('shows error state on exception', async () => {
		mockGetCoverage.mockRejectedValue(new Error('Network error'));

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('Network error')).toBeTruthy();
		});
	});

	// ========================================================================
	// Footer
	// ========================================================================

	it('displays footer with file count and annotation total', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('4 of 4 files')).toBeTruthy();
		});

		expect(screen.getByText('25 total annotations')).toBeTruthy();
	});

	// ========================================================================
	// Alternative data formats
	// ========================================================================

	it('handles nested files array in coverage response', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify({
				files: [
					{ file_path: 'src/nested.ts', coverage_status: 'full', annotation_count: 3 },
				],
			}),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/nested.ts')).toBeTruthy();
		});
	});

	it('does not fetch when projectPath is undefined', () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath={undefined}
			/>,
		);

		expect(mockGetCoverage).not.toHaveBeenCalled();
	});

	// ========================================================================
	// Donut chart
	// ========================================================================

	it('renders donut chart with correct segment proportions', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('coverage-donut')).toBeTruthy();
		});

		// With 2 covered, 1 partial, 1 uncovered: all three segments should render
		expect(screen.getByTestId('donut-covered')).toBeTruthy();
		expect(screen.getByTestId('donut-partial')).toBeTruthy();
		expect(screen.getByTestId('donut-uncovered')).toBeTruthy();

		// Verify the covered segment has a stroke-dasharray proportional to 2/4 = 50%
		const coveredCircle = screen.getByTestId('donut-covered');
		const dashArray = coveredCircle.getAttribute('stroke-dasharray');
		expect(dashArray).toBeTruthy();
		// The covered segment length should be ~50% of circumference (2*PI*50 ≈ 314.16)
		const coveredLen = parseFloat(dashArray!.split(' ')[0]);
		expect(coveredLen).toBeCloseTo(314.159 * 0.5, 0);
	});

	it('shows percentage label in donut center', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('donut-percentage')).toBeTruthy();
		});

		// 2 full + 0.5 * 1 partial = 2.5 / 4 = 62.5% → 63%
		expect(screen.getByTestId('donut-percentage').textContent).toBe('63%');
		expect(screen.getByText('AI Coverage')).toBeTruthy();
	});

	it('renders legend with correct counts', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('coverage-legend')).toBeTruthy();
		});

		const legend = screen.getByTestId('coverage-legend');
		expect(legend.textContent).toContain('AI Code (2)');
		expect(legend.textContent).toContain('Partial (1)');
		expect(legend.textContent).toContain('Unknown (1)');
	});

	it('handles 0% coverage (all gray)', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{ file_path: 'src/a.ts', coverage_status: 'uncovered', annotation_count: 0 },
				{ file_path: 'src/b.ts', coverage_status: 'uncovered', annotation_count: 0 },
			]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('coverage-donut')).toBeTruthy();
		});

		// 0% coverage: no covered or partial segments
		expect(screen.getByTestId('donut-percentage').textContent).toBe('0%');
		expect(screen.queryByTestId('donut-covered')).toBeNull();
		expect(screen.queryByTestId('donut-partial')).toBeNull();
	});

	it('handles 100% coverage (all green)', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{ file_path: 'src/a.ts', coverage_status: 'full', annotation_count: 5 },
				{ file_path: 'src/b.ts', coverage_status: 'full', annotation_count: 3 },
			]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('coverage-donut')).toBeTruthy();
		});

		// 100% coverage: only covered segment, no partial or uncovered
		expect(screen.getByTestId('donut-percentage').textContent).toBe('100%');
		expect(screen.getByTestId('donut-covered')).toBeTruthy();
		expect(screen.queryByTestId('donut-partial')).toBeNull();
		expect(screen.queryByTestId('donut-uncovered')).toBeNull();
	});

	// ========================================================================
	// Directory view
	// ========================================================================

	it('renders directory view when toggle is active', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Default view is "files" — directory-view container should not exist
		expect(screen.queryByTestId('directory-view')).toBeNull();

		// Click Directories toggle
		fireEvent.click(screen.getByTestId('view-dirs-btn'));

		// Directory view container should now appear
		expect(screen.getByTestId('directory-view')).toBeTruthy();
	});

	it('groups files by parent directory', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Switch to directory view
		fireEvent.click(screen.getByTestId('view-dirs-btn'));

		// mockCoverageData has:
		//   src/main.ts       → dir "src"
		//   src/utils/helpers.ts → dir "src/utils"
		//   src/config.ts     → dir "src"
		//   src/index.ts      → dir "src"
		// So we expect two directory groups: "src" (3 files) and "src/utils" (1 file)
		expect(screen.getByTestId('dir-row-src')).toBeTruthy();
		expect(screen.getByTestId('dir-row-src/utils')).toBeTruthy();

		// Verify file count badges
		expect(screen.getByText('3 files')).toBeTruthy();
		expect(screen.getByText('1 files')).toBeTruthy();
	});

	it('shows directory-level coverage percentage', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Switch to directory view
		fireEvent.click(screen.getByTestId('view-dirs-btn'));

		// "src" dir: 2 full + 0 partial + 1 uncovered = (2 + 0) / 3 = 67%
		// "src/utils" dir: 0 full + 1 partial + 0 uncovered = (0 + 0.5) / 1 = 50%
		// These percentages should be visible
		expect(screen.getByText('67%')).toBeTruthy();
		expect(screen.getByText('50%')).toBeTruthy();
	});

	it('expands directory to show child files', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Switch to directory view
		fireEvent.click(screen.getByTestId('view-dirs-btn'));

		// Files should not be visible yet (directories are collapsed by default)
		expect(screen.queryByText('src/main.ts')).toBeNull();
		expect(screen.queryByText('src/config.ts')).toBeNull();

		// Click the "src" directory row to expand
		fireEvent.click(screen.getByTestId('dir-row-src'));

		// Child files should now be visible
		expect(screen.getByText('src/main.ts')).toBeTruthy();
		expect(screen.getByText('src/config.ts')).toBeTruthy();
		expect(screen.getByText('src/index.ts')).toBeTruthy();

		// Files from other directory should NOT be visible
		expect(screen.queryByText('src/utils/helpers.ts')).toBeNull();
	});

	it('collapses directory on click', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('src/main.ts')).toBeTruthy();
		});

		// Switch to directory view
		fireEvent.click(screen.getByTestId('view-dirs-btn'));

		// Expand the "src" directory
		fireEvent.click(screen.getByTestId('dir-row-src'));
		expect(screen.getByText('src/main.ts')).toBeTruthy();

		// Click again to collapse
		fireEvent.click(screen.getByTestId('dir-row-src'));

		// Child files should be hidden again
		expect(screen.queryByText('src/main.ts')).toBeNull();
		expect(screen.queryByText('src/config.ts')).toBeNull();
	});

	// ========================================================================
	// File-type distribution
	// ========================================================================

	it('renders extension distribution section', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('extension-distribution')).toBeTruthy();
		});

		expect(screen.getByText('By File Type')).toBeTruthy();
	});

	it('shows extension labels with file counts', async () => {
		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('extension-distribution')).toBeTruthy();
		});

		// All 4 files in mockCoverageData are .ts
		expect(screen.getByText('.ts')).toBeTruthy();
		const distSection = screen.getByTestId('extension-distribution');
		expect(distSection.textContent).toContain('4');
	});

	it('shows multiple extensions when files have different types', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([
				{ file_path: 'src/app.tsx', coverage_status: 'full', annotation_count: 10 },
				{ file_path: 'src/style.css', coverage_status: 'uncovered', annotation_count: 0 },
				{ file_path: 'src/main.ts', coverage_status: 'full', annotation_count: 5 },
				{ file_path: 'src/utils.ts', coverage_status: 'partial', annotation_count: 2 },
			]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByTestId('extension-distribution')).toBeTruthy();
		});

		// Should show .ts (2 files, sorted first by count), .tsx (1), .css (1)
		expect(screen.getByText('.ts')).toBeTruthy();
		expect(screen.getByText('.tsx')).toBeTruthy();
		expect(screen.getByText('.css')).toBeTruthy();
	});

	it('does not render extension distribution when no files', async () => {
		mockGetCoverage.mockResolvedValue({
			success: true,
			data: JSON.stringify([]),
		});

		render(
			<VibeCoverageView
				theme={mockTheme}
				projectPath="/test/project"
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText('No tracked files')).toBeTruthy();
		});

		expect(screen.queryByTestId('extension-distribution')).toBeNull();
	});
});
