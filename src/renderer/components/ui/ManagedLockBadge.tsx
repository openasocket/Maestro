/**
 * ManagedLockBadge - the chip a Settings control carries when a managed
 * policy holds its key (MRC2-06-05).
 *
 * Built on `<MiniBadge>`; the tooltip and the accessible name are the one line
 * a refused write is named with (`managedSettingLockReason()`), so the badge,
 * the handler's log line and the CLI's refusal read the same. Focusable so a
 * keyboard user reaches the reason: the control it explains is disabled and
 * skipped by Tab, and a screen reader hears the line from the badge's name.
 */

import { MiniBadge } from './MiniBadge';
import type { Theme } from '../../types';

export const MANAGED_LOCK_LABEL = 'Managed';

export interface ManagedLockBadgeProps {
	theme: Theme;
	/** The policy's line: "the "ghPath" setting is locked and pinned by managed policy revision 3". */
	reason: string;
	/** Set when a disabled control names this badge with `aria-describedby`. */
	id?: string;
	className?: string;
}

export function ManagedLockBadge({ theme, reason, id, className = '' }: ManagedLockBadgeProps) {
	return (
		<span
			id={id}
			role="note"
			tabIndex={0}
			aria-label={reason}
			title={reason}
			className={`inline-flex focus-ring rounded ${className}`}
			data-testid="managed-lock-badge"
		>
			<MiniBadge label={MANAGED_LOCK_LABEL} theme={theme} color={theme.colors.warning} />
		</span>
	);
}

export default ManagedLockBadge;
