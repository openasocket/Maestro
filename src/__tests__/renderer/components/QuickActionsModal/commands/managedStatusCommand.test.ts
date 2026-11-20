/**
 * The command palette entry for the Mega-Maestro management pane (MRC2-07-05).
 *
 * The pane is a section of Settings > Environment, present in every build, so
 * the entry is unconditional and opens through the surface registry: the same
 * `openSettings(tab, settingId)` deep link `maestro-cli open managed-status`
 * and the hamburger menu row take.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureCommands } from '../../../../../renderer/components/QuickActionsModal/commands/featureCommands';
import {
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../../../renderer/stores/modalStore';
import { resolveUiSurface } from '../../../../../shared/uiSurfaces';

function build(close = vi.fn()) {
	return buildFeatureCommands({
		activeSession: undefined,
		setQuickActionOpen: close,
		setSuccessFlashNotification: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		bionifyReadingMode: false,
		setBionifyReadingMode: vi.fn(),
		audioFeedbackEnabled: false,
		setAudioFeedbackEnabled: vi.fn(),
		idleNotificationEnabled: false,
		setIdleNotificationEnabled: vi.fn(),
		showStarredSessionsSection: true,
		setShowStarredSessionsSection: vi.fn(),
		shortcuts: {},
	});
}

describe('Mega-Maestro Management palette entry', () => {
	afterEach(() => {
		useModalStore.getState().closeModal('settings');
	});

	it('is listed with no agent and no opener handed down, under the label the registry advertises', () => {
		const entry = build().find((a) => a.id === 'managed-status');
		expect(entry).toBeDefined();
		expect(entry!.label).toBe(resolveUiSurface('managed-status')!.commandPalette);
		expect(entry!.shortcut).toBeUndefined();
	});

	it('opens the Mega-Maestro window, and closes the palette', () => {
		const close = vi.fn();
		const entry = build(close).find((a) => a.id === 'managed-status')!;
		entry.action();
		expect(selectModalOpen('megaMaestro')(useModalStore.getState())).toBe(true);
		expect(selectModalOpen('settings')(useModalStore.getState())).toBe(false);
		expect(close).toHaveBeenCalledWith(false);
	});
});
