/**
 * ManagedSettingSection - the `data-setting-id` root of a settings section
 * that disables and badges itself when a managed policy holds one of its
 * keys (MRC2-06-05).
 *
 * Which keys a section writes is the search registry's call (`settingKeys` on
 * its `SearchableSetting`), so the badge, the `locked` search keyword and the
 * DOM parity test read one declaration; pass `keys` for a root the registry
 * does not name (the Updates section holds two rows under one id-less root).
 * Unlocked, and standalone where nothing is held, it renders the plain
 * `<div data-setting-id>` the style guide asks for.
 *
 * Locked, the body is a disabled `<fieldset>`: every native control inside is
 * disabled by the browser, and the capture handlers refuse a click and an
 * Enter or Space on the hand-rolled `role="button"` rows, so no write reaches
 * the store (which the main process would refuse anyway). Text stays
 * selectable and readable; the badge sits at the top right, beside the
 * section heading, focusable and carrying the reason.
 */

import type { KeyboardEvent, ReactNode, SyntheticEvent } from 'react';
import type { ManagedSettingLockView } from '../../../shared/managedSettingsLock';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types';
import { ManagedLockBadge } from '../ui/ManagedLockBadge';
import { settingKeysOf } from './searchableSettings';

/** The first held key among `keys`, with its lock, or null when the policy holds none of them. */
export function useManagedSettingLock(
	keys: readonly string[]
): (ManagedSettingLockView & { key: string }) | null {
	const locks = useSettingsStore((s) => s.managedLocks.locks);
	for (const key of keys) if (locks[key]) return { key, ...locks[key] };
	return null;
}

export interface ManagedSettingSectionProps {
	/** The `data-setting-id`; omit it for a root the registry does not name, with `keys`. */
	settingId?: string;
	theme: Theme;
	/** Overrides the registry's `settingKeys` for this id. */
	keys?: readonly string[];
	/** False keeps the controls live and shows the badge alone (a pane the policy holds only in part, like the plugin set). */
	disable?: boolean;
	className?: string;
	testId?: string;
	children: ReactNode;
}

const refuse = (event: SyntheticEvent) => {
	event.preventDefault();
	event.stopPropagation();
};
const refuseActivation = (event: KeyboardEvent) => {
	if (event.key === 'Enter' || event.key === ' ') refuse(event);
};

export function ManagedSettingSection({
	settingId,
	theme,
	keys,
	disable = true,
	className = '',
	testId,
	children,
}: ManagedSettingSectionProps) {
	const held = useManagedSettingLock(keys ?? (settingId ? settingKeysOf(settingId) : []));
	if (!held)
		return (
			<div data-setting-id={settingId} className={className || undefined} data-testid={testId}>
				{children}
			</div>
		);
	const badgeId = `managed-lock-${settingId ?? held.key}`;
	return (
		<div
			data-setting-id={settingId}
			data-managed-lock={held.key}
			className={`relative ${className}`}
			data-testid={testId}
		>
			<ManagedLockBadge
				id={badgeId}
				theme={theme}
				reason={held.message}
				className="absolute right-0 top-0 z-10"
			/>
			{disable ? (
				<fieldset
					disabled
					aria-disabled="true"
					aria-describedby={badgeId}
					className="min-w-0 cursor-not-allowed opacity-70"
					onClickCapture={refuse}
					onKeyDownCapture={refuseActivation}
				>
					{children}
				</fieldset>
			) : (
				children
			)}
		</div>
	);
}

export default ManagedSettingSection;
