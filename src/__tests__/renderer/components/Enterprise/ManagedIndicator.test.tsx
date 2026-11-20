/**
 * The header indicator that says this desktop is managed by a Mega-Maestro
 * instance: it shows only for an enrolled desktop, its hover names the facts a
 * person asks first (names only, MSX-03-05: no server, endpoint, ID or library
 * line), and a click opens the Mega-Maestro window. The text is a pure function
 * of the projection and the connect status, so it is tested as one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	ManagedIndicator,
	managedIndicatorLines,
} from '../../../../renderer/components/Enterprise/ManagedIndicator';
import { useManagedStatus } from '../../../../renderer/hooks/enterprise/useManagedStatus';
import { useConnectStatus } from '../../../../renderer/hooks/enterprise/useConnectStatus';
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
vi.mock('../../../../renderer/hooks/enterprise/useConnectStatus', () => ({
	useConnectStatus: vi.fn(),
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

const CONNECTED: MegaConnectStatus = {
	kind: 'connected',
	orgName: 'Acme',
	teamPath: 'platform/web',
	policy: { name: 'platform-default', revision: 12 },
};
const UUID = '3f2a9c1e-8b4d-4e6f-9a01-2b3c4d5e6f70';
/** Nothing technical belongs in the hover: no server, endpoint, IDs or library version. */
const TECHNICAL =
	/Mega-Maestro server|Endpoint:|socket|Maestro library|tenant|Enrollment|org-acme|inst-1|enr-42|mega\.example|8443/;

describe('managedIndicatorLines', () => {
	it('names the standing, the organization, the team path and the policy with its revision', () => {
		const lines = managedIndicatorLines(stateOf('managed'), CONNECTED);
		expect(lines[0]).toMatch(/^Managed: /);
		expect(lines).toContain('Organization: Acme');
		expect(lines).toContain('Team: platform/web');
		expect(lines).toContain('Policy: platform-default@12');
		expect(lines).toContain('Held by policy: none');
		expect(lines[lines.length - 1]).toMatch(/Click to open/);
	});

	it('never shows the server, the endpoint attachment, an ID or the library version', () => {
		for (const connect of [CONNECTED, undefined, { kind: 'notConnected' } as const]) {
			const text = managedIndicatorLines(stateOf('managed'), connect).join('\n');
			expect(text).not.toMatch(TECHNICAL);
			expect(text).not.toContain(MAESTRO_LIB_VERSION);
		}
		const detached = managedIndicatorLines(
			stateOf('offline', { endpoint: { ...stateOf('offline').endpoint, attached: false } }),
			undefined
		).join('\n');
		expect(detached).not.toMatch(TECHNICAL);
	});

	it('drops a name line whose name is absent or shaped like an ID, rather than show an ID', () => {
		const lines = managedIndicatorLines(stateOf('managed'), {
			kind: 'connected',
			orgName: UUID,
			policy: { name: 'platform-default' },
		});
		expect(lines.join('\n')).not.toContain(UUID);
		expect(lines.some((line) => line.startsWith('Organization'))).toBe(false);
		expect(lines.some((line) => line.startsWith('Team'))).toBe(false);
		expect(lines).toContain('Policy: platform-default');
		const unnamed = managedIndicatorLines(stateOf('managed'), { kind: 'waiting', request: 1042 });
		expect(unnamed.some((line) => /^(Organization|Team|Policy)/.test(line))).toBe(false);
		expect(unnamed.join('\n')).not.toContain('1042');
	});

	it('counts every hold the policy is applying, and carries the reason', () => {
		const lines = managedIndicatorLines(
			stateOf('denied', {
				reason: 'The request was refused.',
				egress: { held: [{ class: 'network' } as never] },
				listeners: { held: [{ kind: 'web' } as never, { kind: 'tunnel' } as never] },
				update: { held: { candidate: '1.2.0' } as never },
			}),
			undefined
		);
		expect(lines).toContain('The request was refused.');
		expect(lines).toContain('Held by policy: 4');
	});
});

describe('ManagedIndicator', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useConnectStatus).mockReturnValue(undefined);
	});

	it('draws nothing for an unenrolled or unsupported desktop, so the ordinary header is unchanged', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('unenrolled')));
		const { container, rerender } = render(<ManagedIndicator theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();

		vi.mocked(useManagedStatus).mockReturnValue(statusOf(undefined, false));
		rerender(<ManagedIndicator theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('shows the standing word, with the live names on hover and the details on click', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('managed')));
		vi.mocked(useConnectStatus).mockReturnValue(CONNECTED);
		render(<ManagedIndicator theme={mockTheme} />);
		const badge = screen.getByTestId('managed-indicator');
		expect(badge).toHaveTextContent('Managed');
		const title = badge.getAttribute('title') ?? '';
		expect(title).toContain('Organization: Acme');
		expect(title).toContain('Policy: platform-default@12');
		expect(title).not.toMatch(TECHNICAL);
		fireEvent.click(badge);
		expect(openUiSurface).toHaveBeenCalledWith('managed-status');
	});
});

describe('ManagedIndicator with a connect status', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(useConnectStatus).mockReturnValue(undefined);
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

	it('names the passed status on hover once enrolled, with no technical line', () => {
		vi.mocked(useManagedStatus).mockReturnValue(statusOf(stateOf('managed')));
		vi.mocked(useConnectStatus).mockReturnValue({ kind: 'notConnected' });
		render(<ManagedIndicator theme={mockTheme} connectStatus={CONNECTED} />);
		const title = screen.getByTestId('managed-indicator').getAttribute('title') ?? '';
		expect(title).toContain('Organization: Acme');
		expect(title).toContain('Team: platform/web');
		expect(title).not.toMatch(TECHNICAL);
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
