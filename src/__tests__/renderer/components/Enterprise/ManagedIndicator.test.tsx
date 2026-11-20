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
