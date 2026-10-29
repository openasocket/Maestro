/**
 * Which shortcuts belong to an Encore Feature, and whether they exist right now.
 *
 * `useMainKeyboardHandler` already refuses to fire these chords while their
 * feature is off. This is the other half: a disabled feature's shortcut must
 * not be LISTED either (Shortcuts Help, Settings -> Shortcuts, the Usage
 * Dashboard's unused list) or counted in the keyboard-mastery denominator,
 * where a chord that cannot fire would hold the user below 100% forever.
 *
 * A managed policy's pins (MRC2-07-06) are read over the flags: a feature
 * pinned off has no shortcut whatever the store copy says, since the main
 * process restores the pin and refuses the write that would flip it.
 *
 * A new Encore Feature that adds a shortcut adds its id here.
 */

import type { EncoreFeatureFlags, Shortcut } from '../types';
import type { EncoreFlagPins } from '../../shared/encoreFeatureDefaults';
import { canOpenComputerHistory } from './computerHistoryAvailability';

export const SHORTCUT_ENCORE_FLAGS: Readonly<Record<string, keyof EncoreFeatureFlags>> = {
	usageDashboard: 'usageStats',
	openSymphony: 'symphony',
	directorNotes: 'directorNotes',
	searchDirectorNotes: 'directorNotes',
	openCue: 'maestroCue',
	computerHistory: 'computerHistory',
	toggleConcerto: 'concerto',
	toggleCadenzas: 'concerto',
	toggleThroughputGauge: 'throughputGauge',
};

type EncoreFlagsInput = Partial<EncoreFeatureFlags> | null | undefined;
type EncorePinsInput = EncoreFlagPins | null | undefined;

/** False only for a shortcut whose Encore Feature is switched off, or pinned off by policy. */
export function isShortcutAvailable(
	shortcutId: string,
	encoreFeatures: EncoreFlagsInput,
	pins?: EncorePinsInput
): boolean {
	const flag = SHORTCUT_ENCORE_FLAGS[shortcutId];
	if (!flag) return true;
	const pin = pins?.[flag as keyof EncoreFlagPins];
	const on = typeof pin === 'boolean' ? pin : encoreFeatures?.[flag] === true;
	// Same predicate the hotkey, palette and menu use: the viewer is also
	// withheld on the web-desktop build.
	if (flag === 'computerHistory') return canOpenComputerHistory({ computerHistory: on });
	return on;
}

/** Drop the shortcuts of every Encore Feature that is switched off or pinned off. */
export function availableShortcuts<T extends Shortcut>(
	shortcuts: Record<string, T>,
	encoreFeatures: EncoreFlagsInput,
	pins?: EncorePinsInput
): Record<string, T> {
	const available: Record<string, T> = {};
	for (const [id, shortcut] of Object.entries(shortcuts)) {
		if (isShortcutAvailable(id, encoreFeatures, pins)) available[id] = shortcut;
	}
	return available;
}
