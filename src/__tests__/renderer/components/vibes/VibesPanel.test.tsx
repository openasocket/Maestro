import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { VibesPanel } from '../../../../renderer/components/vibes/VibesPanel';

// ============================================================================
// Mocks
// ============================================================================

const mockVibesData = {
	isInitialized: true,
	stats: null,
	annotations: [],
	sessions: [],
	models: [],
	isLoading: false,
	error: null,
	refresh: vi.fn(),
	initialize: vi.fn(),
};

let mockVibesEnabled = true;
const mockVibesAssuranceLevel = 'medium';

vi.mock('../../../../renderer/hooks', () => ({
	useSettings: () => ({
		vibesEnabled: mockVibesEnabled,
		vibesAssuranceLevel: mockVibesAssuranceLevel,
	}),
	useVibesData: () => mockVibesData,
}));

// Mock child components to test rendering without complex dependencies
vi.mock('../../../../renderer/components/vibes/VibesDashboard', () => ({
	VibesDashboard: (props: Record<string, unknown>) => (
		<div data-testid="vibes-dashboard">
			Dashboard: enabled={String(props.vibesEnabled)} level={String(props.vibesAssuranceLevel)} binaryAvailable={String(props.binaryAvailable)}
		</div>
	),
}));

vi.mock('../../../../renderer/components/vibes/VibesAnnotationLog', () => ({
	VibesAnnotationLog: () => (
		<div data-testid="vibes-annotation-log">AnnotationLog</div>
	),
}));

vi.mock('../../../../renderer/components/vibes/VibesModelAttribution', () => ({
	VibesModelAttribution: () => (
		<div data-testid="vibes-model-attribution">ModelAttribution</div>
	),
}));

vi.mock('../../../../renderer/components/vibes/VibesBlameView', () => ({
	VibesBlameView: (props: Record<string, unknown>) => (
		<div data-testid="vibes-blame-view">
			BlameView{props.initialFilePath ? `: file=${String(props.initialFilePath)}` : ''} binaryAvailable={String(props.binaryAvailable)}
		</div>
	),
}));

vi.mock('../../../../renderer/components/vibes/VibeCoverageView', () => ({
	VibeCoverageView: (props: Record<string, unknown>) => (
		<div data-testid="vibes-coverage-view">CoverageView binaryAvailable={String(props.binaryAvailable)}</div>
	),
}));

vi.mock('../../../../renderer/components/vibes/VibesReportView', () => ({
	VibesReportView: (props: Record<string, unknown>) => (
		<div data-testid="vibes-report-view">ReportView binaryAvailable={String(props.binaryAvailable)}</div>
	),
}));

vi.mock('lucide-react', () => ({
	Shield: () => <span data-testid="icon-shield">Shield</span>,
	Settings: () => <span data-testid="icon-settings">Settings</span>,
	RefreshCw: (props: { className?: string }) => (
		<span data-testid="icon-refresh" className={props.className}>RefreshCw</span>
	),
	AlertTriangle: () => <span data-testid="icon-alert-triangle">AlertTriangle</span>,
	CheckCircle2: () => <span data-testid="icon-check-circle">CheckCircle2</span>,
}));

// Mock window.maestro.vibes.findBinary
const mockFindBinary = vi.fn();

const mockTheme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark' as const,
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

// ============================================================================
// Tests
// ============================================================================

describe('VibesPanel', () => {
	beforeEach(() => {
		mockVibesEnabled = true;
		vi.clearAllMocks();
		mockFindBinary.mockResolvedValue({ path: '/usr/local/bin/vibecheck', version: '0.3.2' });
		(window as any).maestro = {
			vibes: {
				findBinary: mockFindBinary,
			},
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ========================================================================
	// Disabled state
	// ========================================================================

	it('renders disabled state when vibesEnabled is false', () => {
		mockVibesEnabled = false;
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		expect(screen.getByText('VIBES is disabled')).toBeTruthy();
		expect(screen.getByText(/Enable VIBES in Settings/)).toBeTruthy();
		expect(screen.getByText('Open Settings')).toBeTruthy();
	});

	it('dispatches tour:action event when Open Settings is clicked', () => {
		mockVibesEnabled = false;
		const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);
		fireEvent.click(screen.getByText('Open Settings'));

		expect(dispatchSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'tour:action',
				detail: { type: 'openSettings' },
			}),
		);
		dispatchSpy.mockRestore();
	});

	// ========================================================================
	// Sub-tab navigation
	// ========================================================================

	it('renders sub-tab navigation with all 6 tabs', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		expect(screen.getByText('Overview')).toBeTruthy();
		expect(screen.getByText('Log')).toBeTruthy();
		expect(screen.getByText('Models')).toBeTruthy();
		expect(screen.getByText('Blame')).toBeTruthy();
		expect(screen.getByText('Coverage')).toBeTruthy();
		expect(screen.getByText('Reports')).toBeTruthy();
	});

	it('defaults to Overview sub-tab', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		expect(screen.getByTestId('vibes-dashboard')).toBeTruthy();
		expect(screen.queryByTestId('vibes-annotation-log')).toBeNull();
		expect(screen.queryByTestId('vibes-model-attribution')).toBeNull();
	});

	it('switches to Log sub-tab when clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByText('Log'));

		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-annotation-log')).toBeTruthy();
		expect(screen.queryByTestId('vibes-model-attribution')).toBeNull();
	});

	it('switches to Models sub-tab when clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByText('Models'));

		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.queryByTestId('vibes-annotation-log')).toBeNull();
		expect(screen.getByTestId('vibes-model-attribution')).toBeTruthy();
	});

	it('switches to Blame sub-tab when clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByText('Blame'));

		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-blame-view')).toBeTruthy();
	});

	it('switches to Coverage sub-tab when clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByText('Coverage'));

		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-coverage-view')).toBeTruthy();
	});

	it('switches to Reports sub-tab when clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByText('Reports'));

		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-report-view')).toBeTruthy();
	});

	it('switches back to Overview from another tab', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Go to Log
		fireEvent.click(screen.getByText('Log'));
		expect(screen.getByTestId('vibes-annotation-log')).toBeTruthy();

		// Back to Overview
		fireEvent.click(screen.getByText('Overview'));
		expect(screen.getByTestId('vibes-dashboard')).toBeTruthy();
		expect(screen.queryByTestId('vibes-annotation-log')).toBeNull();
	});

	it('only renders one sub-tab content at a time when switching between all tabs', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Overview is default
		expect(screen.getByTestId('vibes-dashboard')).toBeTruthy();
		expect(screen.queryByTestId('vibes-blame-view')).toBeNull();
		expect(screen.queryByTestId('vibes-coverage-view')).toBeNull();
		expect(screen.queryByTestId('vibes-report-view')).toBeNull();

		// Switch to Blame
		fireEvent.click(screen.getByText('Blame'));
		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-blame-view')).toBeTruthy();
		expect(screen.queryByTestId('vibes-coverage-view')).toBeNull();
		expect(screen.queryByTestId('vibes-report-view')).toBeNull();

		// Switch to Coverage
		fireEvent.click(screen.getByText('Coverage'));
		expect(screen.queryByTestId('vibes-blame-view')).toBeNull();
		expect(screen.getByTestId('vibes-coverage-view')).toBeTruthy();
		expect(screen.queryByTestId('vibes-report-view')).toBeNull();

		// Switch to Reports
		fireEvent.click(screen.getByText('Reports'));
		expect(screen.queryByTestId('vibes-coverage-view')).toBeNull();
		expect(screen.getByTestId('vibes-report-view')).toBeTruthy();
	});

	// ========================================================================
	// Props passing
	// ========================================================================

	it('passes vibesEnabled and vibesAssuranceLevel to VibesDashboard', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		const dashboard = screen.getByTestId('vibes-dashboard');
		expect(dashboard.textContent).toContain('enabled=true');
		expect(dashboard.textContent).toContain('level=medium');
	});

	it('renders with undefined projectPath', () => {
		render(<VibesPanel theme={mockTheme} projectPath={undefined} />);

		// Should still render the sub-tab navigation and dashboard
		expect(screen.getByText('Overview')).toBeTruthy();
		expect(screen.getByTestId('vibes-dashboard')).toBeTruthy();
	});

	// ========================================================================
	// Active tab styling
	// ========================================================================

	it('highlights the active sub-tab with accent color', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		const overviewTab = screen.getByText('Overview');
		const logTab = screen.getByText('Log');

		// Overview should be active by default — borderColor may be hex or rgb
		expect(overviewTab.style.borderColor).not.toBe('transparent');
		expect(logTab.style.borderColor).toBe('transparent');

		// Switch to Log
		fireEvent.click(logTab);
		expect(logTab.style.borderColor).not.toBe('transparent');
		expect(overviewTab.style.borderColor).toBe('transparent');
	});

	// ========================================================================
	// initialBlameFilePath — context menu integration
	// ========================================================================

	it('auto-navigates to blame sub-tab when initialBlameFilePath is provided', () => {
		render(
			<VibesPanel
				theme={mockTheme}
				projectPath="/project"
				initialBlameFilePath="src/index.ts"
			/>,
		);

		// Should show blame view, not dashboard
		expect(screen.queryByTestId('vibes-dashboard')).toBeNull();
		expect(screen.getByTestId('vibes-blame-view')).toBeTruthy();
	});

	it('passes initialBlameFilePath to VibesBlameView as initialFilePath', () => {
		render(
			<VibesPanel
				theme={mockTheme}
				projectPath="/project"
				initialBlameFilePath="src/utils/helpers.ts"
			/>,
		);

		const blameView = screen.getByTestId('vibes-blame-view');
		expect(blameView.textContent).toContain('file=src/utils/helpers.ts');
	});

	it('calls onBlameFileConsumed after processing initialBlameFilePath', () => {
		const onBlameFileConsumed = vi.fn();
		render(
			<VibesPanel
				theme={mockTheme}
				projectPath="/project"
				initialBlameFilePath="src/index.ts"
				onBlameFileConsumed={onBlameFileConsumed}
			/>,
		);

		expect(onBlameFileConsumed).toHaveBeenCalledTimes(1);
	});

	it('does not auto-navigate when initialBlameFilePath is undefined', () => {
		render(
			<VibesPanel
				theme={mockTheme}
				projectPath="/project"
				initialBlameFilePath={undefined}
			/>,
		);

		// Should remain on Overview (default)
		expect(screen.getByTestId('vibes-dashboard')).toBeTruthy();
		expect(screen.queryByTestId('vibes-blame-view')).toBeNull();
	});

	// ========================================================================
	// Global refresh button
	// ========================================================================

	it('renders refresh button in tab bar', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		expect(screen.getByTestId('vibes-refresh-button')).toBeTruthy();
		expect(screen.getByTestId('icon-refresh')).toBeTruthy();
	});

	it('calls vibesData.refresh when refresh button clicked', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.click(screen.getByTestId('vibes-refresh-button'));

		expect(mockVibesData.refresh).toHaveBeenCalledTimes(1);
	});

	it('shows spinning animation while loading', () => {
		mockVibesData.isLoading = true;
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		const refreshIcon = screen.getByTestId('icon-refresh');
		expect(refreshIcon.className).toContain('animate-spin');

		mockVibesData.isLoading = false;
	});

	it('does not show spinning animation when not loading', () => {
		mockVibesData.isLoading = false;
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		const refreshIcon = screen.getByTestId('icon-refresh');
		expect(refreshIcon.className).not.toContain('animate-spin');
	});

	it('refreshes on Ctrl+Shift+R keyboard shortcut', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		fireEvent.keyDown(document, { key: 'R', ctrlKey: true, shiftKey: true });

		expect(mockVibesData.refresh).toHaveBeenCalledTimes(1);
	});

	it('shows tooltip on refresh button', () => {
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		const button = screen.getByTestId('vibes-refresh-button');
		expect(button.getAttribute('title')).toBe('Refresh VIBES data (Ctrl+Shift+R)');
	});

	// ========================================================================
	// Binary status banner
	// ========================================================================

	it('shows binary not-found banner when vibecheck unavailable', async () => {
		mockFindBinary.mockResolvedValue({ path: null, version: null });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		await waitFor(() => {
			expect(screen.getByTestId('binary-not-found-banner')).toBeTruthy();
		});

		expect(screen.getByText('vibecheck not found')).toBeTruthy();
		expect(screen.getByText(/Blame, Coverage, Reports, and Build require vibecheck/)).toBeTruthy();
		expect(screen.getByTestId('install-guide-btn')).toBeTruthy();
		expect(screen.getByText('Set Custom Path')).toBeTruthy();
	});

	it('shows version when vibecheck available', async () => {
		mockFindBinary.mockResolvedValue({ path: '/usr/local/bin/vibecheck', version: '0.3.2' });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		await waitFor(() => {
			expect(screen.getByTestId('binary-version-badge')).toBeTruthy();
		});

		expect(screen.getByText(/v0\.3\.2/)).toBeTruthy();
		expect(screen.queryByTestId('binary-not-found-banner')).toBeNull();
	});

	it('passes binaryAvailable to child components', async () => {
		mockFindBinary.mockResolvedValue({ path: null, version: null });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Wait for binary check to resolve
		await waitFor(() => {
			expect(screen.getByTestId('binary-not-found-banner')).toBeTruthy();
		});

		// Dashboard gets binaryAvailable
		const dashboard = screen.getByTestId('vibes-dashboard');
		expect(dashboard.textContent).toContain('binaryAvailable=false');

		// Switch to Blame tab and check
		fireEvent.click(screen.getByText('Blame'));
		const blameView = screen.getByTestId('vibes-blame-view');
		expect(blameView.textContent).toContain('binaryAvailable=false');

		// Switch to Coverage tab and check
		fireEvent.click(screen.getByText('Coverage'));
		const coverageView = screen.getByTestId('vibes-coverage-view');
		expect(coverageView.textContent).toContain('binaryAvailable=false');

		// Switch to Reports tab and check
		fireEvent.click(screen.getByText('Reports'));
		const reportView = screen.getByTestId('vibes-report-view');
		expect(reportView.textContent).toContain('binaryAvailable=false');
	});

	it('shows install guide when Install Guide button clicked', async () => {
		mockFindBinary.mockResolvedValue({ path: null, version: null });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		await waitFor(() => {
			expect(screen.getByTestId('install-guide-btn')).toBeTruthy();
		});

		// Install guide should not be visible initially
		expect(screen.queryByTestId('install-guide-panel')).toBeNull();

		// Click Install Guide
		fireEvent.click(screen.getByTestId('install-guide-btn'));

		// Install guide should now be visible
		expect(screen.getByTestId('install-guide-panel')).toBeTruthy();
		expect(screen.getByText(/cargo install --path \./)).toBeTruthy();
		expect(screen.getByText(/cargo build --release/)).toBeTruthy();
	});

	it('hides install guide on close', async () => {
		mockFindBinary.mockResolvedValue({ path: null, version: null });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		await waitFor(() => {
			expect(screen.getByTestId('install-guide-btn')).toBeTruthy();
		});

		// Show install guide
		fireEvent.click(screen.getByTestId('install-guide-btn'));
		expect(screen.getByTestId('install-guide-panel')).toBeTruthy();

		// Toggle it closed by clicking again
		fireEvent.click(screen.getByTestId('install-guide-btn'));
		expect(screen.queryByTestId('install-guide-panel')).toBeNull();
	});

	it('Check Again button triggers binary re-check', async () => {
		mockFindBinary
			.mockResolvedValueOnce({ path: null, version: null })
			.mockResolvedValueOnce({ path: '/usr/local/bin/vibecheck', version: '0.3.2' });

		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Wait for initial check to show banner
		await waitFor(() => {
			expect(screen.getByTestId('binary-not-found-banner')).toBeTruthy();
		});

		// Open install guide and click Check Again
		fireEvent.click(screen.getByTestId('install-guide-btn'));
		expect(screen.getByTestId('check-again-btn')).toBeTruthy();

		fireEvent.click(screen.getByTestId('check-again-btn'));

		// After re-check, binary should be found — banner should disappear
		await waitFor(() => {
			expect(screen.queryByTestId('binary-not-found-banner')).toBeNull();
		});

		expect(screen.getByTestId('binary-version-badge')).toBeTruthy();
		expect(mockFindBinary).toHaveBeenCalledTimes(2);
	});

	// ========================================================================
	// Last updated timestamp
	// ========================================================================

	it('shows last updated timestamp after data loads', async () => {
		// Simulate loading transition: isLoading starts true then goes false
		mockVibesData.isLoading = true;
		const { rerender } = render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Transition to not loading — triggers lastRefreshed update
		mockVibesData.isLoading = false;
		rerender(<VibesPanel theme={mockTheme} projectPath="/project" />);

		await waitFor(() => {
			expect(screen.getByTestId('last-updated-label')).toBeTruthy();
		});

		const label = screen.getByTestId('last-updated-label');
		expect(label.textContent).toMatch(/just now|1s ago|2s ago/);
	});

	it('updates relative time display as time progresses', () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		const now = 1_700_000_000_000;
		vi.setSystemTime(now);

		// Simulate loading transition to trigger lastRefreshed
		mockVibesData.isLoading = true;
		const { rerender } = render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		mockVibesData.isLoading = false;
		rerender(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// Run pending effects to set lastRefreshed and start the interval
		act(() => {
			vi.advanceTimersByTime(0);
		});

		// Initially should show "just now" (delta < 5s)
		expect(screen.getByTestId('last-updated-label').textContent).toBe('just now');

		// Advance 10 seconds — setSystemTime controls Date.now() for the delta calc
		// advanceTimersByTime fires the setInterval callback
		act(() => {
			vi.setSystemTime(now + 10_000);
			vi.advanceTimersByTime(1_000);
		});
		// Delta is 10s, so should show "10s ago"
		expect(screen.getByTestId('last-updated-label').textContent).toMatch(/^\d+s ago$/);

		// Advance to 2 minutes
		act(() => {
			vi.setSystemTime(now + 120_000);
			vi.advanceTimersByTime(1_000);
		});
		expect(screen.getByTestId('last-updated-label').textContent).toBe('2m ago');

		// Advance to 1 hour
		act(() => {
			vi.setSystemTime(now + 3_600_000);
			vi.advanceTimersByTime(1_000);
		});
		expect(screen.getByTestId('last-updated-label').textContent).toBe('1h ago');

		vi.useRealTimers();
	});

	it('does not show last updated label before data has loaded', () => {
		mockVibesData.isLoading = false;
		render(<VibesPanel theme={mockTheme} projectPath="/project" />);

		// No loading transition has happened, so no timestamp should be shown
		expect(screen.queryByTestId('last-updated-label')).toBeNull();
	});
});
