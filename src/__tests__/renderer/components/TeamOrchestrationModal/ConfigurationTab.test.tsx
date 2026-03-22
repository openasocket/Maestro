/**
 * Tests for ConfigurationTab component
 *
 * Tests the Configuration tab including:
 * - Core settings section rendering (toggles, slider, dropdown)
 * - Toggle interactions for templates, topology, visualization
 * - Max iterations slider changes
 * - Termination mode dropdown changes
 * - Advanced settings section collapse/expand
 * - Default topology pattern dropdown
 * - Quality gate threshold (conditional on termination mode)
 * - Auto-save templates toggle
 * - Per-pattern max iterations CRUD
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigurationTab } from '../../../../renderer/components/TeamOrchestrationModal/ConfigurationTab';
import type { Theme } from '../../../../renderer/types';

const mockSetTeamOrchestrationSettings = vi.fn();

let mockSettings: Record<string, any> = {};

vi.mock('../../../../renderer/hooks', () => ({
	useSettings: () => ({
		teamOrchestrationSettings: {
			enableTemplates: true,
			enableWorkflowTopology: false,
			enableVisualization: false,
			maxIterations: 5,
			defaultTerminationMode: 'moderator-decides',
			defaultTopologyPattern: undefined,
			qualityGateThreshold: 80,
			autoSaveTemplates: false,
			perPatternMaxIterations: {},
			...mockSettings,
		},
		setTeamOrchestrationSettings: mockSetTeamOrchestrationSettings,
	}),
}));

const mockTheme: Theme = {
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
		accentDim: '#bd93f920',
		accentText: '#ff79c6',
		accentForeground: '#ffffff',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
	},
};

describe('ConfigurationTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSettings = {};
	});

	it('renders core settings section header', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		expect(screen.getByText('Core Settings')).toBeDefined();
	});

	it('renders all core setting labels', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		expect(screen.getByText('Team Templates')).toBeDefined();
		expect(screen.getByText('Workflow Topology')).toBeDefined();
		expect(screen.getByText('Workflow Visualization')).toBeDefined();
		expect(screen.getByText(/Max Iterations: 5/)).toBeDefined();
		expect(screen.getByText('Default Termination Mode')).toBeDefined();
	});

	it('renders Beta badges on topology and visualization', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const badges = screen.getAllByText('Beta');
		expect(badges.length).toBe(2);
	});

	it('toggles enableTemplates on click', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const description = screen.getByText('Reusable team configurations with predefined roles');
		const toggleContainer = description.closest('.flex.items-center.justify-between');
		const toggle = toggleContainer?.querySelector('button');
		fireEvent.click(toggle!);
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enableTemplates: false })
		);
	});

	it('toggles enableWorkflowTopology on click', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const description = screen.getByText(
			'Graph-based routing with pipeline, parallel, and loop patterns'
		);
		const toggleContainer = description.closest('.flex.items-center.justify-between');
		const toggle = toggleContainer?.querySelector('button');
		fireEvent.click(toggle!);
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enableWorkflowTopology: true })
		);
	});

	it('toggles enableVisualization on click', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const description = screen.getByText('Real-time workflow graph in Group Chat');
		const toggleContainer = description.closest('.flex.items-center.justify-between');
		const toggle = toggleContainer?.querySelector('button');
		fireEvent.click(toggle!);
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ enableVisualization: true })
		);
	});

	it('updates maxIterations via slider', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const slider = screen.getByRole('slider');
		fireEvent.change(slider, { target: { value: '12' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ maxIterations: 12 })
		);
	});

	it('updates terminationMode via dropdown', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		const select = screen.getByLabelText('Select termination mode');
		fireEvent.change(select, { target: { value: 'quality-gate' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ defaultTerminationMode: 'quality-gate' })
		);
	});

	it('renders advanced settings collapsed by default', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		expect(screen.getByText('Advanced Settings')).toBeDefined();
		// The default topology pattern label should not be visible
		expect(screen.queryByText('Default Topology Pattern')).toBeNull();
	});

	it('expands advanced settings on click', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		expect(screen.getByText('Default Topology Pattern')).toBeDefined();
		expect(screen.getByText('Auto-save Templates')).toBeDefined();
		expect(screen.getByText('Per-Pattern Max Iterations')).toBeDefined();
	});

	it('updates default topology pattern', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		const select = screen.getByLabelText('Select default topology pattern');
		fireEvent.change(select, { target: { value: 'pipeline' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ defaultTopologyPattern: 'pipeline' })
		);
	});

	it('clears default topology pattern when "(No default)" selected', () => {
		mockSettings = { defaultTopologyPattern: 'pipeline' };
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		const select = screen.getByLabelText('Select default topology pattern');
		fireEvent.change(select, { target: { value: '' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ defaultTopologyPattern: undefined })
		);
	});

	it('does not show quality gate threshold when mode is not quality-gate', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		expect(screen.queryByText(/Quality Threshold/)).toBeNull();
	});

	it('shows quality gate threshold when mode is quality-gate', () => {
		mockSettings = { defaultTerminationMode: 'quality-gate' };
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		expect(screen.getByText('Quality Threshold: 80%')).toBeDefined();
	});

	it('updates quality gate threshold via slider', () => {
		mockSettings = { defaultTerminationMode: 'quality-gate' };
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		// Two sliders: maxIterations + quality gate
		const sliders = screen.getAllByRole('slider');
		const qualitySlider = sliders[1];
		fireEvent.change(qualitySlider, { target: { value: '90' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ qualityGateThreshold: 90 })
		);
	});

	it('toggles autoSaveTemplates', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		const description = screen.getByText(
			'Automatically save completed group chats as user templates'
		);
		const toggleContainer = description.closest('.flex.items-center.justify-between');
		const toggle = toggleContainer?.querySelector('button');
		fireEvent.click(toggle!);
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ autoSaveTemplates: true })
		);
	});

	it('shows Add Override button when no overrides exist', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		expect(screen.getByText('Add Override')).toBeDefined();
	});

	it('adds a pattern override', () => {
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		fireEvent.click(screen.getByText('Add Override'));
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				perPatternMaxIterations: { 'hub-spoke': 5 },
			})
		);
	});

	it('renders existing pattern overrides', () => {
		mockSettings = {
			perPatternMaxIterations: { pipeline: 3, 'review-loop': 10 },
		};
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		// Pattern names appear both in the dropdown options and the override rows
		expect(screen.getAllByText('Pipeline').length).toBeGreaterThanOrEqual(2);
		expect(screen.getAllByText('Review Loop').length).toBeGreaterThanOrEqual(2);
		// Verify the number inputs exist with correct values
		expect(screen.getByDisplayValue('3')).toBeDefined();
		expect(screen.getByDisplayValue('10')).toBeDefined();
	});

	it('removes a pattern override', () => {
		mockSettings = {
			perPatternMaxIterations: { pipeline: 3 },
		};
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		const removeBtn = screen.getByTitle('Remove override');
		fireEvent.click(removeBtn);
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({ perPatternMaxIterations: {} })
		);
	});

	it('updates a pattern override value', () => {
		mockSettings = {
			perPatternMaxIterations: { pipeline: 3 },
		};
		render(<ConfigurationTab theme={mockTheme} />);
		fireEvent.click(screen.getByText('Advanced Settings'));
		const input = screen.getByDisplayValue('3');
		fireEvent.change(input, { target: { value: '7' } });
		expect(mockSetTeamOrchestrationSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				perPatternMaxIterations: { pipeline: 7 },
			})
		);
	});
});
