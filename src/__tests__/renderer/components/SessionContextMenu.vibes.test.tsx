/**
 * Tests for the VIBES Level submenu in the agent context menu.
 *
 * The submenu lets the user set a project's VIBES assurance level directly
 * from the Left Bar. It renders ONLY when onSetVibesLevel is provided (the
 * SessionList passes it only while the VIBES plugin + capture toggle are on),
 * marks the current level, and initializes untracked projects on selection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SessionContextMenu } from '../../../renderer/components/SessionList/SessionContextMenu';
import { createMockSession } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';

function renderMenu(overrides: Partial<React.ComponentProps<typeof SessionContextMenu>> = {}) {
	const props: React.ComponentProps<typeof SessionContextMenu> = {
		x: 10,
		y: 10,
		theme: mockTheme,
		session: createMockSession({ name: 'Agent One', cwd: '/proj/one' }),
		groups: [],
		hasWorktreeChildren: false,
		onRename: vi.fn(),
		onEdit: vi.fn(),
		onDuplicate: vi.fn(),
		onToggleBookmark: vi.fn(),
		onMoveToGroup: vi.fn(),
		onDelete: vi.fn(),
		onDismiss: vi.fn(),
		...overrides,
	};
	return render(<SessionContextMenu {...props} />);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('SessionContextMenu VIBES Level submenu', () => {
	it('is hidden when onSetVibesLevel is not provided (plugin off)', () => {
		renderMenu();
		expect(screen.queryByText('VIBES Level')).not.toBeInTheDocument();
	});

	it('renders the trigger with the current level when provided', () => {
		renderMenu({ onSetVibesLevel: vi.fn(), vibesCurrentLevel: 'high' });
		expect(screen.getByText('VIBES Level')).toBeInTheDocument();
		expect(screen.getByText('high')).toBeInTheDocument();
	});

	it('opens the flyout on hover and lists all three levels', () => {
		renderMenu({ onSetVibesLevel: vi.fn(), vibesCurrentLevel: 'medium' });

		fireEvent.mouseEnter(screen.getByText('VIBES Level').closest('div')!);

		expect(screen.getByText('Low')).toBeInTheDocument();
		expect(screen.getByText('Medium')).toBeInTheDocument();
		expect(screen.getByText('High')).toBeInTheDocument();
	});

	it('fires onSetVibesLevel with the chosen level and dismisses', () => {
		const onSetVibesLevel = vi.fn();
		const onDismiss = vi.fn();
		renderMenu({ onSetVibesLevel, onDismiss, vibesCurrentLevel: 'medium' });

		fireEvent.mouseEnter(screen.getByText('VIBES Level').closest('div')!);
		fireEvent.click(screen.getByText('High'));

		expect(onSetVibesLevel).toHaveBeenCalledWith('high');
		expect(onDismiss).toHaveBeenCalled();
	});

	it('disables the current level and marks it', () => {
		const onSetVibesLevel = vi.fn();
		renderMenu({ onSetVibesLevel, vibesCurrentLevel: 'low' });

		fireEvent.mouseEnter(screen.getByText('VIBES Level').closest('div')!);

		const lowButton = screen.getByText('Low').closest('button')!;
		expect(lowButton).toBeDisabled();
		expect(screen.getByText('(current)')).toBeInTheDocument();

		fireEvent.click(lowButton);
		expect(onSetVibesLevel).not.toHaveBeenCalled();
	});

	it('shows the initialization hint for untracked projects', () => {
		renderMenu({ onSetVibesLevel: vi.fn(), vibesCurrentLevel: null });

		fireEvent.mouseEnter(screen.getByText('VIBES Level').closest('div')!);

		expect(
			screen.getByText('Project not tracked yet; picking a level initializes it')
		).toBeInTheDocument();
	});
});
