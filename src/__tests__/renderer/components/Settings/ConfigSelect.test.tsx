/**
 * Tests for ConfigSelect widget and extraction depth selector integration.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfigSelect } from '../../../../renderer/components/Settings/MemoryConfigWidgets';
import type { Theme } from '../../../../renderer/types';

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

const extractionDepthOptions = [
	{ value: 'minimal' as const, label: 'Minimal', description: 'Fast extraction.' },
	{ value: 'standard' as const, label: 'Standard', description: 'Balanced extraction.' },
	{ value: 'rich' as const, label: 'Rich', description: 'Deep extraction.' },
];

describe('ConfigSelect', () => {
	it('renders label and description', () => {
		render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="standard"
				options={extractionDepthOptions}
				onChange={() => {}}
				theme={testTheme}
			/>
		);

		expect(screen.getByText('Extraction Depth')).toBeDefined();
		expect(screen.getByText('How much data to include')).toBeDefined();
	});

	it('renders all option buttons with labels and descriptions', () => {
		render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="standard"
				options={extractionDepthOptions}
				onChange={() => {}}
				theme={testTheme}
			/>
		);

		expect(screen.getByText('Minimal')).toBeDefined();
		expect(screen.getByText('Standard')).toBeDefined();
		expect(screen.getByText('Rich')).toBeDefined();
		expect(screen.getByText('Fast extraction.')).toBeDefined();
		expect(screen.getByText('Balanced extraction.')).toBeDefined();
		expect(screen.getByText('Deep extraction.')).toBeDefined();
	});

	it('calls onChange when an option is clicked', () => {
		const onChange = vi.fn();
		render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="standard"
				options={extractionDepthOptions}
				onChange={onChange}
				theme={testTheme}
			/>
		);

		fireEvent.click(screen.getByText('Rich'));
		expect(onChange).toHaveBeenCalledWith('rich');

		fireEvent.click(screen.getByText('Minimal'));
		expect(onChange).toHaveBeenCalledWith('minimal');
	});

	it('visually highlights the selected option with accent border', () => {
		const { container } = render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="standard"
				options={extractionDepthOptions}
				onChange={() => {}}
				theme={testTheme}
			/>
		);

		const buttons = container.querySelectorAll('button');
		expect(buttons).toHaveLength(3);

		// Standard (index 1) should have accent border color (jsdom normalizes hex to rgb)
		expect(buttons[1].style.borderColor).toBe('rgb(0, 122, 204)');
		// Others should have normal border
		expect(buttons[0].style.borderColor).toBe('rgb(64, 64, 64)');
		expect(buttons[2].style.borderColor).toBe('rgb(64, 64, 64)');
	});

	it('shows warning when last option is selected', () => {
		render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="rich"
				options={extractionDepthOptions}
				onChange={() => {}}
				theme={testTheme}
				warning="Uses more tokens."
			/>
		);

		expect(screen.getByText('Uses more tokens.')).toBeDefined();
	});

	it('hides warning when last option is not selected', () => {
		render(
			<ConfigSelect
				label="Extraction Depth"
				description="How much data to include"
				value="standard"
				options={extractionDepthOptions}
				onChange={() => {}}
				theme={testTheme}
				warning="Uses more tokens."
			/>
		);

		expect(screen.queryByText('Uses more tokens.')).toBeNull();
	});
});
