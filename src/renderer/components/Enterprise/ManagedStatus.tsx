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
 *
 * Below the sentence, the full pane lists what the ceilings hold (MRC2-05-03,
 * MRC2-05-04A): the update hold in force and every egress class refused, each
 * as one `[managed-<code>] ...` line from the projection's own records. A
 * quiet record in place of a toast per start; nothing here is a control.
 */

import { formatManagedHold, formatRelativeTime } from '../../../shared/formatters';
import type { ManagedStanding, ManagedStateView } from '../../../main/enterprise/managed-state';
import type { EgressHold } from '../../../main/utils/fetchWithTimeout';
import type { UpdateHoldView } from '../../types';
import { MANAGED_STANDING_COPY } from '../../hooks/enterprise/useManagedStatus';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';

export const STATUS_COPY = {
	standing: 'Standing',
	desktopOnly: 'Mega-Maestro management is available in the desktop app.',
	noService: 'The enterprise enrollment service is not running in this desktop.',
	reading: 'Reading the managed standing...',
	readFailed: 'Could not read the managed standing. Try again.',
	holds: 'Held by policy',
	/** The update hold in force: the version held (or the check itself), then the ceiling's line. */
	updateHold: (held: UpdateHoldView) =>
		`Update ${held.candidate ?? 'check'}: ${formatManagedHold(held)}`,
	/** One egress class refused for one origin, with how often and how recently. */
	egressHold: (hold: EgressHold) =>
		formatManagedHold({
			code: hold.code,
			message: `${hold.count} ${hold.class} request${hold.count === 1 ? '' : 's'} to ${hold.origin ?? 'an unnamed destination'} refused, last ${formatRelativeTime(hold.lastAt)}`,
		}),
} as const;

/** The list under the standing, or null when nothing is held. */
function Holds({ state }: { state: ManagedStateView }) {
	const update = state.update.held;
	const egress = state.egress.held;
	if (!update && egress.length === 0) return null;
	return (
		<div className="text-xs" data-testid="managed-holds">
			<span className="font-medium">{STATUS_COPY.holds}</span>
			<ul className="list-disc pl-4 mt-0.5 select-text">
				{update ? <li>{STATUS_COPY.updateHold(update)}</li> : null}
				{egress.map((hold) => (
					<li key={`${hold.class}\n${hold.code}\n${hold.origin ?? ''}`}>
						{STATUS_COPY.egressHold(hold)}
					</li>
				))}
			</ul>
		</div>
	);
}

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
			<Holds state={state} />
		</>
	);
}
