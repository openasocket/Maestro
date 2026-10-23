/**
 * The Mega-Maestro management section (MRC-11-03): the standing and its facts
 * are drawn from the narrow IPC projection, the three verbs act and refresh, a
 * required management is reported with no control to leave it, the approval
 * code a recovery hands back is shown once, and a browser or a desktop with no
 * service each get their own sentence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	MegaMaestroSettings,
	COPY,
} from '../../../../renderer/components/Settings/MegaMaestroSettings';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { ManagedStateView } from '../../../../main/enterprise/managed-state';
import { mockTheme } from '../../../helpers/mockTheme';
import { THEMES } from '../../../../shared/themes';

const managedState = vi.fn();
const refreshPolicy = vi.fn();
const recoverPolicy = vi.fn();
const completeRegistration = vi.fn();

function view(over: Partial<ManagedStateView> = {}): ManagedStateView {
	return {
		at: '2026-10-23T12:00:00.000Z',
		standing: 'managed',
		reason: null,
		custody: { state: 'protected', record: 'ok', message: null },
		enrollment: {
			installationId: 'inst-1',
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			management: 'enrolled',
			enrolledAt: '2026-10-20T10:00:00.000Z',
			updatedAt: '2026-10-23T11:59:00.000Z',
		},
		endpoint: {
			attached: true,
			management: 'managed',
			connectivity: 'online',
			collectionProfile: 'metadata',
			lastDenial: null,
		},
		actor: {
			phase: 'registered',
			actorId: null,
			registration: { state: 'live', expiresAt: '2026-10-23T18:00:00.000Z' },
			approval: { state: 'none', expiresAt: null },
		},
		policy: {
			desiredRevision: 3,
			appliedRevision: 3,
			installedRevision: 3,
			source: 'endpoint',
			freshness: 'fresh',
			observedAt: '2026-10-23T11:59:00.000Z',
			converged: true,
			offline: { installedPolicyAvailable: true, mode: 'endpoint' },
			admission: { possible: true, reasons: [] },
		},
		capabilities: {
			supported: ['attachment', 'execution', 'telemetry'],
			negotiated: ['attachment', 'execution'],
			missing: ['telemetry'],
		},
		localRelease: {
			allowed: false,
			reason: 'required',
			message: 'Management of this installation by org-1 (tenant-1) is required.',
		},
		...over,
	};
}

const originalEnterprise = (window.maestro as unknown as Record<string, unknown>).enterprise;

beforeEach(() => {
	clearCachedResources();
	managedState.mockReset().mockResolvedValue(view());
	refreshPolicy.mockReset().mockResolvedValue({ status: 'ok', value: {} });
	recoverPolicy.mockReset().mockResolvedValue({ status: 'not-needed' });
	completeRegistration.mockReset().mockResolvedValue({ status: 'ok', value: {} });
	(window.maestro as unknown as Record<string, unknown>).enterprise = {
		managedState,
		refreshPolicy,
		recoverPolicy,
		completeRegistration,
	};
});

afterEach(() => {
	(window.maestro as unknown as Record<string, unknown>).enterprise = originalEnterprise;
});

describe('MegaMaestroSettings', () => {
	it.each(['ayu-light', 'solarized-dark'])(
		'shows the standing and its facts using %s',
		async (themeId) => {
			render(<MegaMaestroSettings theme={THEMES[themeId]} />);
			expect(await screen.findByTestId('managed-standing')).toHaveTextContent('Managed');
			expect(screen.getByText('org-1 (tenant tenant-1)')).toBeInTheDocument();
			expect(screen.getByText('inst-1')).toBeInTheDocument();
			expect(
				screen.getByText(/Attached: managed, online, collection metadata/)
			).toBeInTheDocument();
			expect(screen.getByText('attachment, execution')).toBeInTheDocument();
			expect(screen.getByText('telemetry')).toBeInTheDocument();
			expect(screen.getByText(COPY.possible)).toBeInTheDocument();
			// Required management is reported, and nothing here offers to leave it.
			expect(screen.getByText(/org-1 \(tenant-1\) is required/)).toBeInTheDocument();
			expect(screen.queryByText(/forget/i)).not.toBeInTheDocument();
			expect(screen.queryByText(/retire/i)).not.toBeInTheDocument();
			expect(screen.queryByText(COPY.complete)).not.toBeInTheDocument();
		}
	);

	it('lists why admission is not possible and names the denial', async () => {
		managedState.mockResolvedValue(
			view({
				standing: 'denied',
				reason: 'No endpoint connection is open.',
				endpoint: {
					attached: false,
					management: null,
					connectivity: 'detached',
					collectionProfile: null,
					lastDenial: {
						at: '2026-10-23T11:58:00.000Z',
						operation: 'attachment',
						reason: 'unauthenticated',
					},
				},
				policy: {
					...view().policy,
					admission: {
						possible: false,
						reasons: ['No registered standing.', 'The policy observation is stale.'],
					},
				},
			})
		);
		render(<MegaMaestroSettings theme={mockTheme} />);
		expect(await screen.findByTestId('managed-standing')).toHaveTextContent('Denied');
		expect(screen.getByText(/unauthenticated on attachment/)).toBeInTheDocument();
		expect(screen.getByText('No registered standing.')).toBeInTheDocument();
		expect(screen.getByText('The policy observation is stale.')).toBeInTheDocument();
		expect(screen.getByText(COPY.detached)).toBeInTheDocument();
	});

	it('refreshes the policy, announces the outcome and re-reads the standing', async () => {
		render(<MegaMaestroSettings theme={mockTheme} />);
		await screen.findByTestId('managed-standing');
		fireEvent.click(screen.getByText(COPY.refresh));
		expect(await screen.findByText('Policy refreshed from the endpoint.')).toBeInTheDocument();
		expect(refreshPolicy).toHaveBeenCalledTimes(1);
		expect(managedState.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(screen.getByRole('status')).toHaveTextContent('Policy refreshed from the endpoint.');
	});

	it('shows a recovery approval code once and then offers to complete the registration', async () => {
		recoverPolicy.mockResolvedValue({
			status: 'approval-required',
			handoff: {
				challengeId: 'ch-1',
				nonce: 'PAIR-CODE-42',
				challengeDigest: 'c'.repeat(64),
				expiresAt: '2026-10-23T12:10:00.000Z',
			},
		});
		render(<MegaMaestroSettings theme={mockTheme} />);
		await screen.findByTestId('managed-standing');
		fireEvent.click(screen.getByText(COPY.recover));
		expect(await screen.findByText('PAIR-CODE-42')).toBeInTheDocument();
		expect(screen.getByText(/Approval code, shown once \(ch-1/)).toBeInTheDocument();
		expect(screen.queryByText('c'.repeat(64))).not.toBeInTheDocument();
		fireEvent.click(screen.getByText(COPY.complete));
		await waitFor(() => expect(completeRegistration).toHaveBeenCalledTimes(1));
		expect(await screen.findByText(/Registration completed/)).toBeInTheDocument();
		expect(screen.queryByText('PAIR-CODE-42')).not.toBeInTheDocument();
	});

	it('reports a denied verb in the error color without hiding the standing', async () => {
		refreshPolicy.mockResolvedValue({
			status: 'denied',
			reason: 'expired',
			operation: 'attachment',
		});
		render(<MegaMaestroSettings theme={mockTheme} />);
		await screen.findByTestId('managed-standing');
		fireEvent.click(screen.getByText(COPY.refresh));
		const line = await screen.findByText('The endpoint denied attachment: expired.');
		expect(line).toHaveStyle({ color: mockTheme.colors.error });
		expect(screen.getByTestId('managed-standing')).toBeInTheDocument();
	});

	it('says so when no service runs, when the read fails, and in a browser', async () => {
		managedState.mockResolvedValue(null);
		const { unmount } = render(<MegaMaestroSettings theme={mockTheme} />);
		expect(await screen.findByText(COPY.noService)).toBeInTheDocument();
		unmount();
		clearCachedResources();

		managedState.mockRejectedValue(new Error('private main diagnostic'));
		const failed = render(<MegaMaestroSettings theme={mockTheme} />);
		expect(await screen.findByText(COPY.readFailed)).toBeInTheDocument();
		expect(screen.queryByText('private main diagnostic')).not.toBeInTheDocument();
		failed.unmount();

		(window.maestro as unknown as Record<string, unknown>).enterprise = undefined;
		render(<MegaMaestroSettings theme={mockTheme} />);
		expect(screen.getByText(COPY.desktopOnly)).toBeInTheDocument();
		expect(managedState).toHaveBeenCalledTimes(2);
	});
});
