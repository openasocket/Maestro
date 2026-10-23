/**
 * ManagedStatus - the one word for this desktop's managed standing, with the
 * sentence beside it (MRC-11-04).
 *
 * Drawn from `useManagedStatus()`'s answer, so the Settings pane, a header
 * slot and any later surface show the same word with the same tint:
 * `MANAGED_STANDING_COPY` spells it, `STANDING_TINT` colors it, and the four
 * answers that are not a standing (a browser, a desktop with no service, the
 * first read, a failed read) each get their own sentence here and nowhere
 * else. A display, never authority: a sink admits on the host adapter's
 * standing, not on the word shown.
 *
 * `compact` is the badge alone for a header: the detail becomes its title and
 * accessible name, and an unmanaged desktop (no service, not enrolled) draws
 * nothing, so the ordinary unmanaged Maestro keeps its header. Every string a
 * person reads lives in `STATUS_COPY`.
 */

import type { ManagedStanding, ManagedStateView } from '../../../main/enterprise/managed-state';
import { MANAGED_STANDING_COPY } from '../../hooks/enterprise/useManagedStatus';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';

export const STATUS_COPY = {
	standing: 'Standing',
	desktopOnly: 'Mega-Maestro management is available in the desktop app.',
	noService: 'The enterprise enrollment service is not running in this desktop.',
	reading: 'Reading the managed standing...',
	readFailed: 'Could not read the managed standing. Try again.',
} as const;

export const STANDING_TINT: Record<ManagedStanding, 'success' | 'warning' | 'error' | 'textDim'> = {
	managed: 'success',
	stale: 'warning',
	unregistered: 'warning',
	offline: 'warning',
	enrolling: 'warning',
	denied: 'error',
	suspended: 'error',
	revoked: 'error',
	'custody-refused': 'error',
	retired: 'textDim',
	unenrolled: 'textDim',
};

export function standingColor(theme: Theme, standing: ManagedStanding): string {
	return theme.colors[STANDING_TINT[standing]];
}

export interface ManagedStatusProps {
	theme: Theme;
	/** The hook's answer: `supported`, the `state` (undefined reading, null no service) and the read error. */
	status: { supported: boolean; state: ManagedStateView | null | undefined; error: string | null };
	/** The badge alone, for a header; nothing at all for an unmanaged desktop. */
	compact?: boolean;
	testId?: string;
}

export function ManagedStatus({
	theme,
	status,
	compact = false,
	testId = 'managed-standing',
}: ManagedStatusProps) {
	const { supported, state, error } = status;
	if (!supported || state === undefined || state === null) {
		if (compact) return null;
		let sentence: string = STATUS_COPY.reading;
		let color: string | undefined;
		if (!supported) sentence = STATUS_COPY.desktopOnly;
		else if (state === null) sentence = STATUS_COPY.noService;
		else if (error) {
			sentence = STATUS_COPY.readFailed;
			color = theme.colors.error;
		}
		return (
			<p className="text-xs" style={color ? { color } : undefined}>
				{sentence}
			</p>
		);
	}

	const copy = MANAGED_STANDING_COPY[state.standing];
	const tint = standingColor(theme, state.standing);
	const detail = state.reason ? `${copy.detail} ${state.reason}` : copy.detail;
	if (compact) {
		if (state.standing === 'unenrolled') return null;
		// The label is the badge's own accessible name; the detail is its description.
		return (
			<MiniBadge label={copy.label} theme={theme} color={tint} title={detail} testId={testId} />
		);
	}
	return (
		<>
			<div className="flex items-center gap-2">
				<span className="font-medium">{STATUS_COPY.standing}</span>
				<MiniBadge label={copy.label} theme={theme} color={tint} testId={testId} />
			</div>
			<p className="text-xs opacity-70">{detail}</p>
		</>
	);
}
