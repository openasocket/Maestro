/**
 * ManagedIndicator - the header badge that says this desktop is managed by a
 * Mega-Maestro instance, and what to tell an admin when it misbehaves.
 *
 * Drawn in the Left Bar's indicator band beside the other global indicators.
 * It shows only for an enrolled desktop (the same rule as the compact
 * `<ManagedStatus>` badge): an ordinary unmanaged Maestro keeps its header.
 * Hover shows the facts a person asks first: the standing and why, then the
 * organization, team path and policy (platform-default@12) as names from the
 * connect status, and how much policy holds. A name that is absent drops its
 * line rather than show an ID (MSX-03-05). The saved server, the endpoint
 * attachment, the IDs and the library version are technical and live in the
 * Troubleshoot tab of the Mega-Maestro window, which a click opens.
 *
 * Connect status (MSX-01-08): when a `connectStatus` is supplied, the badge
 * shows the one word `viewFor()` gives for it (Connected, Waiting for approval,
 * Not connected, Needs reconnect, Unavailable) beside a status dot, and it shows
 * even before enrollment, since "Not connected" is the word a person needs
 * there. The word, not the dot's color, carries the status, and it is in the
 * accessible name. With no `connectStatus` the badge renders exactly as before.
 */

import type { ManagedStateView } from '../../../main/enterprise/managed-state';
import { useManagedStatus } from '../../hooks/enterprise/useManagedStatus';
import { useConnectStatus } from '../../hooks/enterprise/useConnectStatus';
import { openUiSurface } from '../../utils/openUiSurface';
import type { Theme } from '../../types';
import { MANAGED_STANDING_COPY } from '../../hooks/enterprise/useManagedStatus';
import { STANDING_TINT, connectionNameLines } from './ManagedStatus';
import { viewFor, type MegaConnectStatus } from '../../../shared/megaConnect/view';
import type { MegaConnectCopyKey } from '../../../shared/megaConnect/copy';

/** The theme color of the dot beside each connect indicator word. */
export const CONNECT_INDICATOR_TINT: Partial<
	Record<MegaConnectCopyKey, 'success' | 'warning' | 'error' | 'textDim'>
> = {
	indicatorConnected: 'success',
	indicatorWaiting: 'warning',
	indicatorNotConnected: 'textDim',
	indicatorNeedsReconnect: 'error',
	indicatorUnavailable: 'error',
};

export const MANAGED_INDICATOR_COPY = {
	noHolds: 'none',
	openDetails: 'Click to open the Mega-Maestro details.',
} as const;

/**
 * The lines the hover shows, in the order a person reads them. Pure: the same
 * projection and connect status always give the same text. Names come from
 * the connect status only; nothing here prints an ID, a host or a socket.
 */
export function managedIndicatorLines(
	state: ManagedStateView,
	connect: MegaConnectStatus | null | undefined
): string[] {
	const copy = MANAGED_STANDING_COPY[state.standing];
	const lines = [`${copy.label}: ${copy.detail}`];
	if (state.reason) lines.push(state.reason);
	lines.push(...connectionNameLines(connect));
	const holds =
		state.egress.held.length + state.listeners.held.length + (state.update.held ? 1 : 0);
	lines.push(`Held by policy: ${holds > 0 ? holds : MANAGED_INDICATOR_COPY.noHolds}`);
	lines.push(MANAGED_INDICATOR_COPY.openDetails);
	return lines;
}

export function ManagedIndicator({
	theme,
	connectStatus,
}: {
	theme: Theme;
	/** Maestro's connect status; omitted until the connect service feeds it (MSX-02). */
	connectStatus?: MegaConnectStatus;
}) {
	const managed = useManagedStatus();
	const liveConnect = useConnectStatus();
	// The names follow the status the badge shows, or the live one when none is passed.
	const connect = connectStatus ?? liveConnect;
	const state = managed.state;
	if (connectStatus) {
		if (!managed.supported) return null;
		return (
			<ConnectIndicator
				theme={theme}
				status={connectStatus}
				title={
					state && state.standing !== 'unenrolled'
						? managedIndicatorLines(state, connect).join('\n')
						: MANAGED_INDICATOR_COPY.openDetails
				}
			/>
		);
	}
	if (!managed.supported || !state || state.standing === 'unenrolled') return null;

	const copy = MANAGED_STANDING_COPY[state.standing];
	const tint = theme.colors[STANDING_TINT[state.standing]];
	const lines = managedIndicatorLines(state, connect);
	return (
		<button
			type="button"
			data-testid="managed-indicator"
			onClick={() => openUiSurface('managed-status')}
			title={lines.join('\n')}
			aria-label={`${copy.label}. ${copy.detail} ${MANAGED_INDICATOR_COPY.openDetails}`}
			className="flex-shrink-0 px-1.5 py-0.5 rounded text-2xs font-bold uppercase tracking-wide transition-colors hover:bg-white/10"
			style={{ color: tint, backgroundColor: `${tint}20` }}
		>
			{copy.label}
		</button>
	);
}

function ConnectIndicator({
	theme,
	status,
	title,
}: {
	theme: Theme;
	status: MegaConnectStatus;
	title: string;
}) {
	const view = viewFor(status);
	const tint = theme.colors[CONNECT_INDICATOR_TINT[view.indicatorKey] ?? 'textDim'];
	return (
		<button
			type="button"
			data-testid="managed-indicator"
			data-connect-status={view.kind}
			onClick={() => openUiSurface('managed-status')}
			title={title}
			aria-label={`${view.indicatorWord}. ${MANAGED_INDICATOR_COPY.openDetails}`}
			className="flex-shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-bold transition-colors hover:bg-white/10"
			style={{ color: tint, backgroundColor: `${tint}20` }}
		>
			<span
				aria-hidden="true"
				data-testid="managed-indicator-dot"
				className="inline-block w-1.5 h-1.5 rounded-full"
				style={{ backgroundColor: tint }}
			/>
			<span>{view.indicatorWord}</span>
		</button>
	);
}
