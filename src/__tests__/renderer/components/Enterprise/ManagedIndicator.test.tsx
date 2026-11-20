/**
 * The header indicator that says this desktop is managed by a Mega-Maestro
 * instance: it shows only for an enrolled desktop, its hover names the facts an
 * admin asks first, and a click opens the Mega-Maestro window. The text is a
 * pure function of the projection and the saved server, so it is tested as one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	ManagedIndicator,
	managedIndicatorLines,
} from '../../../../renderer/components/Enterprise/ManagedIndicator';
import { useManagedStatus } from '../../../../renderer/hooks/enterprise/useManagedStatus';
import { useMegaServerSettings } from '../../../../renderer/hooks/enterprise/useMegaServerSettings';
import { openUiSurface } from '../../../../renderer/utils/openUiSurface';
import type { ManagedStanding, ManagedStateView } from '../../../../main/enterprise/managed-state';
import { MAESTRO_LIB_VERSION } from '../../../../shared/maestro-lib/version';
import { mockTheme } from '../../../helpers/mockTheme';
import type { MegaConnectStatus } from '../../../../shared/megaConnect/view';

vi.mock('../../../../renderer/hooks/enterprise/useManagedStatus', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../renderer/hooks/enterprise/useManagedStatus')
	>()),
	useManagedStatus: vi.fn(),
}));
vi.mock('../../../../renderer/hooks/enterprise/useMegaServerSettings', () => ({
	useMegaServerSettings: vi.fn(),
}));
vi.mock('../../../../renderer/utils/openUiSurface', () => ({ openUiSurface: vi.fn() }));

function stateOf(
	standing: ManagedStanding,
	over: Partial<ManagedStateView> = {}
): ManagedStateView {
	return {
		at: '2026-11-20T09:00:00.000Z',
		standing,
		reason: null,
		custody: { state: 'ok', record: 'ok', message: null },
		enrollment: {
			installationId: 'inst-1',
			tenantId: 'tenant-7',
			orgId: 'org-acme',
			enrollmentId: 'enr-42',
			management: 'enrolled',
			enrolledAt: '2026-11-01T00:00:00.000Z',
			updatedAt: '2026-11-19T00:00:00.000Z',
		},
		endpoint: {
			attached: true,
			management: 'enrolled',
			connectivity: 'online',
			collectionProfile: null,
			lastDenial: null,
		},
		actor: { phase: 'registered', actorId: null, registration: null, approval: null },
		policy: {
			desiredRevision: 4,
			appliedRevision: 4,
			installedRevision: 4,
			source: 'endpoint',
			freshness: 'fresh',
			observedAt: '2026-11-20T08:59:00.000Z',
			converged: true,
			offline: null,
			admission: null,
		},
		capabilities: { supported: [], negotiated: [], missing: [] },
		egress: { held: [] },
		update: { held: null },
		listeners: { held: [] },
		localRelease: { allowed: false, reason: 'required', message: 'required' },
		...over,
	} as unknown as ManagedStateView;
}

function statusOf(state: ManagedStateView | null | undefined, supported = true) {
	return { supported, state, error: null, update: undefined } as never;
}

const SERVER = { host: 'mega.example.com', port: 8443, endpointSocket: '' };

describe('managedIndicatorLines', () => {
	it('names the standing, the organization, the saved server and the policy an admin needs', () => {
		const lines = managedIndicatorLines(stateOf('managed'), SERVER);
		expect(lines[0]).toMatch(/^Managed: /);
		expect(lines).toContain('Organization org-acme, tenant tenant-7');
		expect(lines).toContain('Enrollment enr-42');
		expect(lines).toContain('Mega-Maestro server: https://mega.example.com:8443');
		expect(lines).toContain('Endpoint: attached (online)');
		expect(lines).toContain('Policy: revision 4, fresh, observed 2026-11-20T08:59:00.000Z');
		expect(lines).toContain('Held by policy: none');
		expect(lines).toContain(`Maestro library ${MAESTRO_LIB_VERSION}`);
		expect(lines[lines.length - 1]).toMatch(/Click to open/);
	});

	it('says so when no server is saved, and when the endpoint is detached', () => {
		const lines = managedIndicatorLines(
			stateOf('offline', { endpoint: { ...stateOf('offline').endpoint, attached: false } }),
			null
		);
		expect(lines).toContain('Mega-Maestro server: not set');
		expect(lines).toContain('Endpoint: not attached');
	});

	it('counts every hold the policy is applying, and carries the reason', () => {
		const lines = managedIndicatorLines(
			stateOf('denied', {
				reason: 'The endpoint refused the last request.',
				egress: { held: [{ class: 'network' } as never] },
				listeners: { held: [{ kind: 'web' } as never, { kind: 'tunnel' } as never] },
				update: { held: { candidate: '1.2.0' } as never },
			}),
			SERVER
		);
		expect(lines).toContain('The endpoint refused the last request.');
		expect(lines).toContain('Held by policy: 4');
	});
});

describe('ManagedIndicator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useMegaServerSettings).mockReturnValue(SERVER);
	});

	it('draws nothing for an unenrolled or unsupported desktop, so the ordinary header is unchanged', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('unenrolled')));
		const { container, rerender } = render(<ManagedIndicator theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();

		vi.mocked(useManagedStatus).mockReturnValue(statusOf(undefined, false));
		rerender(<ManagedIndicator theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('shows the standing word, with the detail on hover and the details on click', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('managed')));
		render(<ManagedIndicator theme={mockTheme} />);
		const badge = screen.getByTestId('managed-indicator');
		expect(badge).toHaveTextContent('Managed');
		expect(badge.getAttribute('title')).toContain('Organization org-acme, tenant tenant-7');
		fireEvent.click(badge);
		expect(openUiSurface).toHaveBeenCalledWith('managed-status');
	});
});

describe('ManagedIndicator with a connect status', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useMegaServerSettings).mockReturnValue(SERVER);
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('unenrolled')));
	});

	const CASES: Array<[MegaConnectStatus, string]> = [
		[{ kind: 'connected', orgName: 'Acme' }, 'Connected'],
		[{ kind: 'waiting', request: 1042 }, 'Waiting for approval'],
		[{ kind: 'browserOpened', matchNumber: 42 }, 'Waiting for approval'],
		[{ kind: 'managed' }, 'Waiting for approval'],
		[{ kind: 'notConnected' }, 'Not connected'],
		[{ kind: 'denied' }, 'Not connected'],
		[{ kind: 'expired' }, 'Not connected'],
		[{ kind: 'revoked' }, 'Needs reconnect'],
		[{ kind: 'grantExpired' }, 'Needs reconnect'],
		[{ kind: 'unavailable' }, 'Unavailable'],
	];

	it.each(CASES)('shows one word for %o, with the word in its accessible name', (status, word) => {
		render(<ManagedIndicator theme={mockTheme} connectStatus={status} />);
		const badge = screen.getByTestId('managed-indicator');
		expect(badge).toHaveTextContent(word);
		expect(badge.textContent).toBe(word);
		expect(badge.getAttribute('aria-label')).toContain(word);
		expect(screen.getByTestId('managed-indicator-dot')).toHaveAttribute('aria-hidden', 'true');
	});

	it('never shows the matching number or the request reference on the badge', () => {
		render(
			<ManagedIndicator
				theme={mockTheme}
				connectStatus={{ kind: 'browserOpened', matchNumber: 4821, request: 1042 }}
			/>
		);
		const badge = screen.getByTestId('managed-indicator');
		expect(badge.textContent).not.toMatch(/4821|1042/);
		expect(badge.getAttribute('aria-label')).not.toMatch(/4821|1042/);
	});

	it('opens the panel on click, as the standing badge does', () => {
		render(<ManagedIndicator theme={mockTheme} connectStatus={{ kind: 'notConnected' }} />);
		fireEvent.click(screen.getByTestId('managed-indicator'));
		expect(openUiSurface).toHaveBeenCalledWith('managed-status');
	});

	it('keeps the existing hover facts once enrolled', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('managed')));
		render(<ManagedIndicator theme={mockTheme} connectStatus={{ kind: 'connected' }} />);
		const badge = screen.getByTestId('managed-indicator');
		expect(badge.getAttribute('title')).toContain('Organization org-acme, tenant tenant-7');
	});

	it('draws nothing where the managed service is not supported', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(undefined, false));
		const { container } = render(
			<ManagedIndicator theme={mockTheme} connectStatus={{ kind: 'notConnected' }} />
		);
		expect(container).toBeEmptyDOMElement();
	});

	it('renders exactly as before when no connect status is supplied', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('managed')));
		const { container: withoutProp } = render(<ManagedIndicator theme={mockTheme} />);
		const html = withoutProp.innerHTML;
		expect(screen.queryByTestId('managed-indicator-dot')).toBeNull();
		expect(screen.getByTestId('managed-indicator')).toHaveTextContent('Managed');
		const { container: again } = render(
			<ManagedIndicator theme={mockTheme} connectStatus={undefined} />
		);
		expect(again.innerHTML).toBe(html);
	});
});
