/**
 * The Mega-Maestro window: its own dialog with only Mega-Maestro content. What is
 * defended: the saved server is shown; an invalid address is refused and not
 * saved; a lookup shows what the server and the endpoint answered, and never a
 * made-up server version; the approval request names the saved server's origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MegaMaestroModal } from '../../../../renderer/components/MegaMaestro/MegaMaestroModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import type { MegaServerLookup } from '../../../../shared/megaServer';

vi.mock('../../../../renderer/components/Settings/MegaMaestroSettings', () => ({
	MegaMaestroSettings: () => <div data-testid="standing-body" />,
}));

const megaServerGet = vi.fn();
const megaServerSave = vi.fn();
const megaServerLookup = vi.fn();
const requestEnrollment = vi.fn();

function setMaestro(value: unknown) {
	(window as unknown as { maestro: unknown }).maestro = value;
}

const LOOKUP: MegaServerLookup = {
	checkedAt: '2026-11-20T00:00:00.000Z',
	reachable: true,
	health: 'alive',
	httpStatus: 200,
	serverVersion: null,
	serverVersionNote: 'Mega-Maestro does not publish its build version.',
	endpoint: { status: 'negotiated', protocol: 2, capabilities: ['attachment', 'compatibility'] },
	versions: { maestro: '1.1.1-RC', library: '0.44.0', contracts: '0.4.0' },
	message: 'The server answered its health route (alive).',
};

function renderModal() {
	return render(
		<LayerStackProvider>
			<MegaMaestroModal theme={mockTheme} onClose={vi.fn()} />
		</LayerStackProvider>
	);
}

describe('MegaMaestroModal', () => {
	beforeEach(() => {
		megaServerGet.mockReset().mockResolvedValue({
			host: 'mega.example.com',
			port: 443,
			endpointSocket: '/var/lib/mega/ipc.sock',
		});
		megaServerSave.mockReset().mockResolvedValue({ status: 'saved', message: 'Saved.' });
		megaServerLookup.mockReset().mockResolvedValue(LOOKUP);
		requestEnrollment.mockReset().mockResolvedValue({
			status: 'ok',
			value: { outcome: 'enrollment_requested', requestId: 'r-1' },
		});
		setMaestro({
			enterprise: { megaServerGet, megaServerSave, megaServerLookup, requestEnrollment },
		});
	});

	afterEach(() => {
		setMaestro(undefined);
	});

	it('is titled Mega-Maestro and holds no Settings tabs', async () => {
		renderModal();
		expect(await screen.findByText('Mega-Maestro')).toBeTruthy();
		expect(screen.queryByText('Notifications')).toBeNull();
		expect(screen.queryByText('Environment')).toBeNull();
		expect(screen.getByTestId('standing-body')).toBeTruthy();
	});

	it('shows the saved server', async () => {
		renderModal();
		await waitFor(() =>
			expect((screen.getByLabelText('Host name or IP address') as HTMLInputElement).value).toBe(
				'mega.example.com'
			)
		);
		expect((screen.getByLabelText('Local endpoint socket') as HTMLInputElement).value).toBe(
			'/var/lib/mega/ipc.sock'
		);
	});

	it('refuses an invalid address, shows why, and does not save', async () => {
		renderModal();
		const host = await screen.findByLabelText('Host name or IP address');
		fireEvent.change(host, { target: { value: 'https://mega.example.com' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText(/without a scheme/)).toBeTruthy();
		expect(megaServerSave).not.toHaveBeenCalled();
	});

	it('saves a valid address and reports it saved', async () => {
		renderModal();
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Saved.')).toBeTruthy();
		expect(megaServerSave).toHaveBeenCalledWith({
			host: 'mega.example.com',
			port: 443,
			endpointSocket: '/var/lib/mega/ipc.sock',
		});
	});

	it('looks the server up and shows what it found, without a server version', async () => {
		renderModal();
		fireEvent.click(await screen.findByRole('button', { name: 'Look up' }));
		expect(await screen.findByText('The server answered its health route (alive).')).toBeTruthy();
		expect(screen.getByText('Not published by the server')).toBeTruthy();
		expect(screen.getByText(/protocol 2, capabilities attachment, compatibility/)).toBeTruthy();
		expect(screen.getByText('Mega-Maestro contracts: 0.4.0')).toBeTruthy();
	});

	it('shows the local endpoint is unavailable, with the reason', async () => {
		megaServerLookup.mockResolvedValueOnce({
			...LOOKUP,
			endpoint: {
				status: 'unavailable',
				message: 'The local endpoint could not be asked: ENOENT.',
			},
		});
		renderModal();
		fireEvent.click(await screen.findByRole('button', { name: 'Look up' }));
		expect(await screen.findByText(/could not be asked: ENOENT/)).toBeTruthy();
	});

	it('sends the approval request to the saved server origin, with the console values', async () => {
		renderModal();
		await waitFor(() => expect(megaServerGet).toHaveBeenCalled());
		fireEvent.change(screen.getByLabelText('Organization ID'), { target: { value: 'org-1' } });
		fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'tenant-1' } });
		fireEvent.change(screen.getByLabelText('Issuer SHA-256 fingerprint'), {
			target: { value: 'a'.repeat(64) },
		});
		fireEvent.change(screen.getByLabelText('Server CA certificate (PEM)'), {
			target: { value: '-----BEGIN CERTIFICATE-----' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
		expect(
			await screen.findByText('Accepted by the endpoint (enrollment requested).')
		).toBeTruthy();
		expect(requestEnrollment).toHaveBeenCalledWith({
			phase: 'request',
			socketPath: '/var/lib/mega/ipc.sock',
			management: {
				origin: 'https://mega.example.com',
				tenantId: 'tenant-1',
				issuerSha256: 'a'.repeat(64),
			},
			orgId: 'org-1',
			serverCaPem: '-----BEGIN CERTIFICATE-----',
		});
	});

	it('will not send an approval request without a saved server', async () => {
		megaServerGet.mockResolvedValue(null);
		renderModal();
		await waitFor(() => expect(megaServerGet).toHaveBeenCalled());
		fireEvent.click(screen.getByRole('button', { name: 'Request approval' }));
		expect(await screen.findByText('Save a valid server first.')).toBeTruthy();
		expect(requestEnrollment).not.toHaveBeenCalled();
	});

	it('says it needs the desktop app when no enterprise bridge is present', async () => {
		setMaestro(undefined);
		renderModal();
		expect(
			await screen.findByText(
				'This window needs the desktop app. It cannot reach Mega-Maestro from a browser.'
			)
		).toBeTruthy();
	});
});
