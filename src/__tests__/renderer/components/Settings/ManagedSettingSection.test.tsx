/**
 * The lock indication in Settings (MRC2-06-05): the badge and the section root
 * that disables itself on a held key. Standalone (nothing held) renders the
 * plain data-setting-id root.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedSettingSection } from '../../../../renderer/components/Settings/ManagedSettingSection';
import { ManagedLockBadge } from '../../../../renderer/components/ui/ManagedLockBadge';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { NO_MANAGED_SETTING_LOCKS } from '../../../../shared/managedSettingsLock';
import { mockTheme } from '../../../helpers/mockTheme';

const reasonFor = (key: string) =>
	`the "${key}" setting is locked and pinned by managed policy revision 3`;
const hold = (keys: string[]) =>
	useSettingsStore.setState({
		managedLocks: {
			policyRevision: 3,
			locks: Object.fromEntries(
				keys.map((key) => [key, { code: 'locked', message: reasonFor(key), pinned: true }])
			),
		},
	});
afterEach(() => useSettingsStore.setState({ managedLocks: NO_MANAGED_SETTING_LOCKS }));

function renderSection(props: Partial<React.ComponentProps<typeof ManagedSettingSection>> = {}) {
	const onChange = vi.fn();
	render(
		<ManagedSettingSection settingId="general-gh-path" theme={mockTheme} {...props}>
			<div role="button" tabIndex={0} onClick={onChange} onKeyDown={onChange}>
				Row
			</div>
			<button type="button" onClick={onChange}>
				Native
			</button>
			<input aria-label="Path" defaultValue="/usr/bin/gh" />
		</ManagedSettingSection>
	);
	return onChange;
}
const badge = () => screen.getByTestId('managed-lock-badge');

describe('ManagedLockBadge', () => {
	it('is a focusable note named by the policy line, with the line as its tooltip', () => {
		render(<ManagedLockBadge theme={mockTheme} reason={reasonFor('ghPath')} id="b" />);
		expect(badge().getAttribute('role')).toBe('note');
		expect(badge().tabIndex).toBe(0);
		expect(badge().getAttribute('aria-label')).toBe(reasonFor('ghPath'));
		expect(badge().getAttribute('title')).toBe(reasonFor('ghPath'));
		expect(badge().id).toBe('b');
		expect(badge().textContent).toBe('Managed');
	});
});

describe('ManagedSettingSection', () => {
	it('renders the plain data-setting-id root with live controls while nothing is held', () => {
		const onChange = renderSection();
		const root = document.querySelector('[data-setting-id="general-gh-path"]')!;
		expect(root.querySelector('fieldset')).toBeNull();
		expect(root.hasAttribute('data-managed-lock')).toBe(false);
		expect(screen.queryByTestId('managed-lock-badge')).toBeNull();
		fireEvent.click(screen.getByText('Native'));
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('disables every control, refuses the hand-rolled row and badges the section on a held registry key', () => {
		hold(['ghPath']);
		const onChange = renderSection();
		const root = document.querySelector('[data-setting-id="general-gh-path"]')!;
		expect(root.getAttribute('data-managed-lock')).toBe('ghPath');
		const fieldset = root.querySelector('fieldset')!;
		expect(fieldset.disabled).toBe(true);
		expect(fieldset.getAttribute('aria-describedby')).toBe('managed-lock-general-gh-path');
		expect(badge().id).toBe('managed-lock-general-gh-path');
		expect(badge().getAttribute('aria-label')).toBe(reasonFor('ghPath'));
		expect(screen.getByLabelText('Path').matches(':disabled')).toBe(true);
		fireEvent.click(screen.getByText('Native'));
		fireEvent.click(screen.getByText('Row'));
		fireEvent.keyDown(screen.getByText('Row'), { key: 'Enter' });
		fireEvent.keyDown(screen.getByText('Row'), { key: ' ' });
		expect(onChange).not.toHaveBeenCalled();
		// Tab still reaches the badge: a key the row does not act on is not refused.
		fireEvent.keyDown(screen.getByText('Row'), { key: 'Tab' });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it('holds an id-less root on explicit keys, naming the first key the policy holds', () => {
		hold(['enableBetaUpdates']);
		renderSection({
			settingId: undefined,
			keys: ['checkForUpdatesOnStartup', 'enableBetaUpdates'],
		});
		const root = document.querySelector('[data-managed-lock="enableBetaUpdates"]')!;
		expect(root.hasAttribute('data-setting-id')).toBe(false);
		expect(badge().id).toBe('managed-lock-enableBetaUpdates');
	});

	it('keeps the controls live under disable={false} and still shows the badge', () => {
		hold(['ghPath']);
		const onChange = renderSection({ disable: false });
		expect(document.querySelector('fieldset')).toBeNull();
		expect(badge().getAttribute('aria-label')).toBe(reasonFor('ghPath'));
		fireEvent.click(screen.getByText('Native'));
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});
