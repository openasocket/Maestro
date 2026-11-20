/**
 * ManagedIndicator - the header badge that says this desktop is managed by a
 * Mega-Maestro instance, and what to tell an admin when it misbehaves.
 *
 * Drawn in the Left Bar's indicator band beside the other global indicators.
 * It shows only for an enrolled desktop (the same rule as the compact
 * `<ManagedStatus>` badge): an ordinary unmanaged Maestro keeps its header.
 * Hover shows the facts an admin asks first (the standing and why, the
 * organization, the server saved here, endpoint attachment, the applied policy
 * revision and its freshness, what policy holds, and the library version). A
 * click opens the Mega-Maestro window, which holds the full detail and the
 * server lookup. Nothing here contacts a server: every fact is already in the
 * projection or the saved settings.
 *
 * Connect status (MSX-01-08): when a `connectStatus` is supplied, the badge
 * shows the one word `viewFor()` gives for it (Connected, Waiting for approval,
 * Not connected, Needs reconnect, Unavailable) beside a status dot, and it shows
 * even before enrollment, since "Not connected" is the word a person needs
 * there. The word, not the dot's color, carries the status, and it is in the
 * accessible name. With no `connectStatus` the badge renders exactly as before.
 */

import { MAESTRO_LIB_VERSION } from '../../../shared/maestro-lib/version';
import { megaServerOrigin, type MegaServerSettings } from '../../../shared/megaServer';
import type { ManagedStateView } from '../../../main/enterprise/managed-state';
import { useManagedStatus } from '../../hooks/enterprise/useManagedStatus';
import { useMegaServerSettings } from '../../hooks/enterprise/useMegaServerSettings';
import { openUiSurface } from '../../utils/openUiSurface';
import type { Theme } from '../../types';
import { MANAGED_STANDING_COPY } from '../../hooks/enterprise/useManagedStatus';
import { STANDING_TINT } from './ManagedStatus';
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
	serverNotSet: 'not set',
	endpointDetached: 'not attached',
	noHolds: 'none',
	openDetails: 'Click to open the Mega-Maestro details.',
} as const;

/**
 * The lines the hover shows, in the order an admin reads them. Pure: the same
 * projection and saved settings always give the same text.
 */
export function managedIndicatorLines(
	state: ManagedStateView,
	server: MegaServerSettings | null | undefined
): string[] {
	const copy = MANAGED_STANDING_COPY[state.standing];
	const lines = [`${copy.label}: ${copy.detail}`];
	if (state.reason) lines.push(state.reason);
	if (state.enrollment) {
		lines.push(
			`Organization ${state.enrollment.orgId}, tenant ${state.enrollment.tenantId}`,
			`Enrollment ${state.enrollment.enrollmentId ?? 'none'}`
		);
	}
	const serverText =
		server && server.host.length > 0
			? megaServerOrigin(server)
			: MANAGED_INDICATOR_COPY.serverNotSet;
	lines.push(`Mega-Maestro server: ${serverText}`);
	lines.push(
		state.endpoint.attached
			? `Endpoint: attached (${state.endpoint.connectivity})`
			: `Endpoint: ${MANAGED_INDICATOR_COPY.endpointDetached}`
	);
	const observed = state.policy.observedAt ? `, observed ${state.policy.observedAt}` : '';
	lines.push(
		`Policy: revision ${state.policy.appliedRevision ?? 'none'}, ${state.policy.freshness}${observed}`
	);
	const holds =
		state.egress.held.length + state.listeners.held.length + (state.update.held ? 1 : 0);
	lines.push(`Held by policy: ${holds > 0 ? holds : MANAGED_INDICATOR_COPY.noHolds}`);
	lines.push(`Maestro library ${MAESTRO_LIB_VERSION}`);
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
	const server = useMegaServerSettings();
	const state = managed.state;
	if (connectStatus) {
		if (!managed.supported) return null;
		return (
			<ConnectIndicator
				theme={theme}
				status={connectStatus}
				title={
					state && state.standing !== 'unenrolled'
						? managedIndicatorLines(state, server).join('\n')
						: MANAGED_INDICATOR_COPY.openDetails
				}
			/>
		);
	}
	if (!managed.supported || !state || state.standing === 'unenrolled') return null;

	const copy = MANAGED_STANDING_COPY[state.standing];
	const tint = theme.colors[STANDING_TINT[state.standing]];
	const lines = managedIndicatorLines(state, server);
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
