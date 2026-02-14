/**
 * Tests for VibesDashboard component
 *
 * Validates error handling, loading states, and status banners:
 * - "Initializing..." state during first data load
 * - "vibecheck binary not found" warning with installation guidance
 * - VIBES disabled state
 * - Not-initialized state with project name input
 * - Error banner display
 * - Stats cards with loading indicators
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { VibesDashboard } from '../../../../renderer/components/vibes/VibesDashboard';
import type { Theme } from '../../../../shared/theme-types';
import type { UseVibesDataReturn } from '../../../../renderer/hooks/useVibesData';
import type { VibesAssuranceLevel } from '../../../../shared/vibes-types';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('lucide-react', () => ({
	FileText: () => <svg data-testid="file-text-icon" />,
	FolderOpen: () => <svg data-testid="folder-open-icon" />,
	Activity: () => <svg data-testid="activity-icon" />,
	Cpu: () => <svg data-testid="cpu-icon" />,
	Database: () => <svg data-testid="database-icon" />,
	FileBarChart: () => <svg data-testid="file-bar-chart-icon" />,
	RefreshCw: () => <svg data-testid="refresh-icon" />,
	AlertCircle: () => <svg data-testid="alert-circle-icon" />,
	CheckCircle2: () => <svg data-testid="check-circle-icon" />,
	Shield: () => <svg data-testid="shield-icon" />,
	Loader2: ({ className }: { className?: string }) => (
		<svg data-testid="loader-icon" className={className} />
	),
	AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
	Download: () => <svg data-testid="download-icon" />,
}));

vi.mock('../../../../renderer/components/vibes/VibesLiveMonitor', () => ({
	VibesLiveMonitor: () => <div data-testid="vibes-live-monitor">LiveMonitor</div>,
}));

// ============================================================================
// Test Theme & Helpers
// ============================================================================

const testTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		border: '#44475a',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentDim: '#bd93f940',
		accentText: '#bd93f9',
		accentForeground: '#282a36',
		success: '#50fa7b',
		warning: '#f1fa8c',
		error: '#ff5555',
	},
};

function createMockVibesData(
	overrides: Partial<UseVibesDataReturn> = {},
): UseVibesDataReturn {
	return {
		isInitialized: true,
		stats: {
			totalAnnotations: 42,
			filesCovered: 10,
			totalTrackedFiles: 20,
			coveragePercent: 50,
			activeSessions: 2,
			contributingModels: 3,
			assuranceLevel: 'medium',
		},
		annotations: [],
		sessions: [],
		models: [],
		isLoading: false,
		error: null,
		refresh: vi.fn(),
		initialize: vi.fn(),
		...overrides,
	};
}

// Mock window.maestro.vibes
const mockFindBinary = vi.fn();
const mockBuild = vi.fn();
const mockGetReport = vi.fn();
const mockGetManifest = vi.fn();
const mockGetLog = vi.fn();
const mockSaveFile = vi.fn();
const mockWriteFile = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	mockFindBinary.mockResolvedValue({ path: '/usr/local/bin/vibecheck', version: 'vibecheck 0.3.2' });
	mockGetManifest.mockResolvedValue({ success: true, data: '{}' });
	mockGetLog.mockResolvedValue({ success: true, data: '[]' });
	mockSaveFile.mockResolvedValue(null);

	(window as any).maestro = {
		vibes: {
			findBinary: mockFindBinary,
			build: mockBuild,
			getReport: mockGetReport,
			getManifest: mockGetManifest,
			getLog: mockGetLog,
		},
		dialog: {
			saveFile: mockSaveFile,
		},
		fs: {
			writeFile: mockWriteFile,
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('VibesDashboard', () => {
	it('shows disabled state when VIBES is not enabled', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={false}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES is disabled')).toBeTruthy();
		expect(screen.getByText(/Enable VIBES in Settings/)).toBeTruthy();
	});

	it('shows initializing state during first data load', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					isLoading: true,
					isInitialized: false,
					stats: null,
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Initializing...')).toBeTruthy();
		expect(screen.getByText('Loading VIBES data for this project.')).toBeTruthy();
		expect(screen.getByTestId('loader-icon')).toBeTruthy();
	});

	it('shows not-initialized state with initialization controls', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					isInitialized: false,
					stats: null,
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES not initialized')).toBeTruthy();
		expect(screen.getByPlaceholderText('Project name')).toBeTruthy();
		expect(screen.getByText('Initialize')).toBeTruthy();
	});

	it('disables Build and Report buttons when binary unavailable', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
				binaryAvailable={false}
			/>,
		);

		const buildBtn = screen.getByText('Build Database').closest('button')!;
		const reportBtn = screen.getByText('Generate Report').closest('button')!;
		const refreshBtn = screen.getByText('Refresh').closest('button')!;

		expect(buildBtn.disabled).toBe(true);
		expect(reportBtn.disabled).toBe(true);
		expect(refreshBtn.disabled).toBeFalsy();
	});

	it('keeps buttons enabled when binary is available', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
				binaryAvailable={true}
			/>,
		);

		const buildBtn = screen.getByText('Build Database').closest('button')!;
		const reportBtn = screen.getByText('Generate Report').closest('button')!;

		expect(buildBtn.disabled).toBeFalsy();
		expect(reportBtn.disabled).toBeFalsy();
	});

	it('shows error banner when vibesData has an error', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ error: 'Connection failed' })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Connection failed')).toBeTruthy();
	});

	it('shows stats cards with loading dashes when loading', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ isLoading: true })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Stats cards show "—" when loading
		const dashes = screen.getAllByText('—');
		expect(dashes.length).toBeGreaterThanOrEqual(4);
	});

	it('shows active status banner with assurance level', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('VIBES is active')).toBeTruthy();
		expect(screen.getByText('Medium')).toBeTruthy();
	});

	it('shows quick action buttons', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('Build Database')).toBeTruthy();
		expect(screen.getByText('Generate Report')).toBeTruthy();
		expect(screen.getByText('Refresh')).toBeTruthy();
	});

	it('renders live monitor when initialized', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('vibes-live-monitor')).toBeTruthy();
	});

	// ========================================================================
	// Activity Timeline
	// ========================================================================

	it('renders activity timeline with annotation bars', () => {
		const now = Date.now();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: new Date(now - 60000).toISOString(), assurance_level: 'medium' },
						{ type: 'line', file_path: 'b.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: new Date(now).toISOString(), assurance_level: 'high' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('activity-timeline')).toBeTruthy();
		expect(screen.getByText('Activity Timeline')).toBeTruthy();
	});

	it('shows empty state when no annotations for timeline', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ annotations: [] })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByText('No activity yet')).toBeTruthy();
	});

	it('renders action legend in timeline', () => {
		const now = Date.now();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: new Date(now).toISOString(), assurance_level: 'medium' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('timeline-legend')).toBeTruthy();
		expect(screen.getByText('create')).toBeTruthy();
		expect(screen.getByText('modify')).toBeTruthy();
	});

	// ========================================================================
	// Timeline Range Toggle
	// ========================================================================

	it('renders timeline range toggle buttons with 30d active by default', () => {
		const now = Date.now();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: new Date(now).toISOString(), assurance_level: 'medium' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// All four range buttons should be present
		expect(screen.getByText('30d')).toBeTruthy();
		expect(screen.getByText('14d')).toBeTruthy();
		expect(screen.getByText('7d')).toBeTruthy();
		expect(screen.getByText('1d')).toBeTruthy();

		// 30d should be the active (full opacity) button by default
		const btn30 = screen.getByText('30d');
		expect(btn30.style.opacity).toBe('1');
	});

	it('switches timeline range when toggle button is clicked', () => {
		const now = Date.now();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: new Date(now).toISOString(), assurance_level: 'medium' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		const btn7d = screen.getByText('7d');
		fireEvent.click(btn7d);

		// After clicking 7d, it should become active
		expect(btn7d.style.opacity).toBe('1');
		// And 30d should become inactive
		expect(screen.getByText('30d').style.opacity).toBe('0.6');
	});

	it('filters out old annotations when switching to a shorter range', () => {
		const now = Date.now();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						// Recent annotation (within 1d)
						{ type: 'line', file_path: 'recent.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: new Date(now - 3600_000).toISOString(), assurance_level: 'medium' },
						// Old annotation (20 days ago — within 30d but outside 7d and 1d)
						{ type: 'line', file_path: 'old.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: new Date(now - 20 * 86400_000).toISOString(), assurance_level: 'medium' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Default 30d: both annotations should produce bar segments
		const createBars30d = screen.getAllByTestId('bar-create');
		const modifyBars30d = screen.getAllByTestId('bar-modify');
		expect(createBars30d.length).toBe(1);
		expect(modifyBars30d.length).toBe(1);

		// Switch to 1d — old annotation should be filtered out
		fireEvent.click(screen.getByText('1d'));

		// Only the recent "create" annotation should remain
		const createBars1d = screen.getAllByTestId('bar-create');
		expect(createBars1d.length).toBe(1);
		expect(screen.queryAllByTestId('bar-modify').length).toBe(0);
	});

	// ========================================================================
	// Model Contribution Donut
	// ========================================================================

	it('renders model pie chart when models data available', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					models: [
						{ modelName: 'claude-sonnet', modelVersion: '4.5', toolName: 'claude-code', annotationCount: 30, percentage: 60 },
						{ modelName: 'gpt-4o', modelVersion: '2024-05', toolName: 'copilot', annotationCount: 20, percentage: 40 },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('model-donut-section')).toBeTruthy();
		expect(screen.getByTestId('model-donut')).toBeTruthy();
		expect(screen.getByText('claude-sonnet')).toBeTruthy();
		expect(screen.getByText('gpt-4o')).toBeTruthy();
	});

	it('shows model count in donut center', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					models: [
						{ modelName: 'model-a', modelVersion: '1', toolName: 'tool-a', annotationCount: 10, percentage: 50 },
						{ modelName: 'model-b', modelVersion: '1', toolName: 'tool-b', annotationCount: 10, percentage: 50 },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Donut center shows model count
		const donut = screen.getByTestId('model-donut');
		expect(donut.textContent).toContain('2');
	});

	it('does not render model donut when no models', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({ models: [] })}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.queryByTestId('model-donut-section')).toBeNull();
	});

	// ========================================================================
	// Assurance Level Distribution
	// ========================================================================

	it('renders assurance level distribution bar', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: '2025-01-01T00:00:00Z', assurance_level: 'low' },
						{ type: 'line', file_path: 'b.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: '2025-01-01T00:01:00Z', assurance_level: 'medium' },
						{ type: 'line', file_path: 'c.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: '2025-01-01T00:02:00Z', assurance_level: 'medium' },
						{ type: 'line', file_path: 'd.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'create', timestamp: '2025-01-01T00:03:00Z', assurance_level: 'high' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		expect(screen.getByTestId('assurance-distribution')).toBeTruthy();
		expect(screen.getByTestId('assurance-bar-low')).toBeTruthy();
		expect(screen.getByTestId('assurance-bar-medium')).toBeTruthy();
		expect(screen.getByTestId('assurance-bar-high')).toBeTruthy();
	});

	it('shows correct counts in assurance legend', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: '2025-01-01T00:00:00Z', assurance_level: 'low' },
						{ type: 'line', file_path: 'b.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: '2025-01-01T00:01:00Z', assurance_level: 'high' },
						{ type: 'line', file_path: 'c.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: '2025-01-01T00:02:00Z', assurance_level: 'high' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		const legend = screen.getByTestId('assurance-legend');
		expect(legend.textContent).toContain('Low: 1');
		expect(legend.textContent).toContain('High: 2');
		// Medium should not appear (0 count)
		expect(legend.textContent).not.toContain('Medium');
	});

	it('handles single assurance level', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData({
					annotations: [
						{ type: 'line', file_path: 'a.ts', line_start: 1, line_end: 5, environment_hash: 'h1', action: 'create', timestamp: '2025-01-01T00:00:00Z', assurance_level: 'high' },
						{ type: 'line', file_path: 'b.ts', line_start: 1, line_end: 3, environment_hash: 'h1', action: 'modify', timestamp: '2025-01-01T00:01:00Z', assurance_level: 'high' },
					],
				})}
				vibesEnabled={true}
				vibesAssuranceLevel="high"
			/>,
		);

		expect(screen.getByTestId('assurance-bar-high')).toBeTruthy();
		expect(screen.queryByTestId('assurance-bar-low')).toBeNull();
		expect(screen.queryByTestId('assurance-bar-medium')).toBeNull();
	});

	// ========================================================================
	// Export dropdown
	// ========================================================================

	it('shows export dropdown with 3 options when Export clicked', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Click export button
		fireEvent.click(screen.getByText('Export'));

		// Dropdown should appear with 3 options
		expect(screen.getByTestId('export-dropdown')).toBeTruthy();
		expect(screen.getByText('Annotations (JSONL)')).toBeTruthy();
		expect(screen.getByText('Manifest (JSON)')).toBeTruthy();
		expect(screen.getByText('Summary (Markdown)')).toBeTruthy();
	});

	it('calls save dialog for annotation export', async () => {
		mockSaveFile.mockResolvedValue('/tmp/annotations.jsonl');
		mockGetLog.mockResolvedValue({ success: true, data: '[{"type":"line"}]' });

		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		fireEvent.click(screen.getByText('Export'));
		fireEvent.click(screen.getByText('Annotations (JSONL)'));

		await waitFor(() => {
			expect(mockSaveFile).toHaveBeenCalled();
		});
	});

	// ========================================================================
	// Assurance Level Switcher
	// ========================================================================

	it('renders assurance level toggle with all three levels', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// All three level buttons should be present in the status banner
		expect(screen.getByTitle('Set assurance level to Low')).toBeTruthy();
		expect(screen.getByTitle('Set assurance level to Medium')).toBeTruthy();
		expect(screen.getByTitle('Set assurance level to High')).toBeTruthy();
	});

	it('highlights the active assurance level', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		const mediumBtn = screen.getByTitle('Set assurance level to Medium');
		const lowBtn = screen.getByTitle('Set assurance level to Low');

		// Active button should have full opacity, inactive should be dimmed
		expect(mediumBtn.style.opacity).toBe('1');
		expect(lowBtn.style.opacity).toBe('0.6');
	});

	it('calls onAssuranceLevelChange when a level button is clicked', () => {
		const handleChange = vi.fn();
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
				onAssuranceLevelChange={handleChange}
			/>,
		);

		fireEvent.click(screen.getByTitle('Set assurance level to High'));
		expect(handleChange).toHaveBeenCalledWith('high');

		fireEvent.click(screen.getByTitle('Set assurance level to Low'));
		expect(handleChange).toHaveBeenCalledWith('low');
	});

	it('does not crash when onAssuranceLevelChange is not provided', () => {
		render(
			<VibesDashboard
				theme={testTheme}
				projectPath="/test/project"
				vibesData={createMockVibesData()}
				vibesEnabled={true}
				vibesAssuranceLevel="medium"
			/>,
		);

		// Should not throw when clicking without handler
		expect(() => {
			fireEvent.click(screen.getByTitle('Set assurance level to High'));
		}).not.toThrow();
	});
});
