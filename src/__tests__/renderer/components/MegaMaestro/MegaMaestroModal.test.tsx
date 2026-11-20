/**
 * The Mega-Maestro window: its own dialog with only Mega-Maestro content. What is
 * defended: the saved server is shown; an invalid address is refused and not
 * saved; a lookup shows what the server and the endpoint answered, and never a
 * made-up server version; the approval request names the saved server's origin.
 * The default view (Overview) holds the standing summary and no host, port,
 * socket or enrollment control; the Troubleshoot tab holds all of them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MegaMaestroModal } from '../../../../renderer/components/MegaMaestro/MegaMaestroModal';
import { forgetLastConnectInput } from '../../../../renderer/components/MegaMaestro/ConnectCard';
import type { MegaConnectStatus } from '../../../../shared/megaConnect/view';
import type { MegaConnectPrefill } from '../../../../shared/megaConnect/deepLink';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import type { MegaServerLookup } from '../../../../shared/megaServer';

vi.mock('../../../../renderer/components/Settings/MegaMaestroSettings', () => ({
	MegaMaestroSettings: ({ enrollment }: { enrollment?: boolean }) => (
		<div data-testid="standing-body" data-enrollment={String(enrollment ?? true)} />
	),
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

/** Renders the window and switches to its Troubleshoot tab. */
async function renderTroubleshoot() {
	const view = renderModal();
	fireEvent.click(await screen.findByRole('radio', { name: 'Troubleshoot' }));
	return view;
}

const TECHNICAL_LABELS = [
	'Host name or IP address',
	'Port',
	'Local endpoint socket',
	'Organization ID',
	'Tenant ID',
	'Issuer SHA-256 fingerprint',
	'Server CA certificate (PEM)',
	'1. Request',
	'2. Prove possession',
	'3. Activate',
];

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

	it('opens on Overview: the standing summary and no technical field', async () => {
		renderModal();
		expect(await screen.findByTestId('standing-body')).toBeTruthy();
		await waitFor(() => expect(megaServerGet).toHaveBeenCalled());
		expect(screen.getByRole('radio', { name: 'Overview' }).getAttribute('aria-checked')).toBe(
			'true'
		);
		for (const label of TECHNICAL_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
		expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Look up' })).toBeNull();
		expect(screen.queryByRole('button', { name: 'Request approval' })).toBeNull();
		expect(screen.queryByText('Enroll this desktop')).toBeNull();
		// The standing pane is asked to leave its enrollment cards out here.
		expect(screen.getByTestId('standing-body').getAttribute('data-enrollment')).toBe('false');
	});

	it('Troubleshoot holds the host, port, socket and every enrollment field, and no standing', async () => {
		await renderTroubleshoot();
		for (const label of TECHNICAL_LABELS) expect(screen.getByLabelText(label)).toBeTruthy();
		expect(screen.getByText('Enroll this desktop')).toBeTruthy();
		expect(screen.queryByTestId('standing-body')).toBeNull();
		fireEvent.click(screen.getByRole('radio', { name: 'Overview' }));
		expect(screen.getByTestId('standing-body')).toBeTruthy();
		expect(screen.queryByLabelText('Host name or IP address')).toBeNull();
	});

	it('runs a classic enrollment phase from Troubleshoot', async () => {
		await renderTroubleshoot();
		fireEvent.change(screen.getByLabelText('1. Request'), {
			target: {
				value: JSON.stringify({
					socketPath: '/var/lib/mega/ipc.sock',
					management: {
						origin: 'https://mega.example.com',
						tenantId: 'tenant-1',
						issuerSha256: 'a'.repeat(64),
					},
					orgId: 'org-1',
					serverCaPem: '-----BEGIN CERTIFICATE-----',
				}),
			},
		});
		fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]);
		await waitFor(() => expect(requestEnrollment).toHaveBeenCalledTimes(1));
		expect(requestEnrollment.mock.calls[0][0]).toMatchObject({
			phase: 'request',
			orgId: 'org-1',
		});
	});

	it('is titled Mega-Maestro and holds no Settings tabs', async () => {
		renderModal();
		expect(await screen.findByText('Mega-Maestro')).toBeTruthy();
		expect(screen.queryByText('Notifications')).toBeNull();
		expect(screen.queryByText('Environment')).toBeNull();
		expect(screen.getByTestId('standing-body')).toBeTruthy();
	});

	it('shows the saved server', async () => {
		await renderTroubleshoot();
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
		await renderTroubleshoot();
		const host = await screen.findByLabelText('Host name or IP address');
		fireEvent.change(host, { target: { value: 'https://mega.example.com' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText(/without a scheme/)).toBeTruthy();
		expect(megaServerSave).not.toHaveBeenCalled();
	});

	it('saves a valid address and reports it saved', async () => {
		await renderTroubleshoot();
		fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Saved.')).toBeTruthy();
		expect(megaServerSave).toHaveBeenCalledWith({
			host: 'mega.example.com',
			port: 443,
			endpointSocket: '/var/lib/mega/ipc.sock',
		});
	});

	it('looks the server up and shows what it found, without a server version', async () => {
		await renderTroubleshoot();
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
		await renderTroubleshoot();
		fireEvent.click(await screen.findByRole('button', { name: 'Look up' }));
		expect(await screen.findByText(/could not be asked: ENOENT/)).toBeTruthy();
	});

	it('sends the approval request to the saved server origin, with the console values', async () => {
		await renderTroubleshoot();
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
		await renderTroubleshoot();
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

describe('MegaMaestroModal Connect card', () => {
	let statusPush: ((view: { status: MegaConnectStatus }) => void) | null;
	let prefillPush: ((prefill: MegaConnectPrefill) => void) | null;
	const connectStatus = vi.fn();
	const connectStart = vi.fn();
	const connectDisconnect = vi.fn();

	function withStatus(status: MegaConnectStatus) {
		connectStatus.mockResolvedValue({ status });
	}

	beforeEach(() => {
		forgetLastConnectInput();
		statusPush = null;
		prefillPush = null;
		connectStatus.mockReset();
		connectStart.mockReset();
		connectDisconnect.mockReset();
		withStatus({ kind: 'notConnected' });
		megaServerGet.mockReset().mockResolvedValue({
			host: 'mega.example.com',
			port: 8443,
			endpointSocket: '/var/lib/mega/ipc.sock',
		});
		setMaestro({
			enterprise: {
				megaServerGet,
				megaServerSave,
				megaServerLookup,
				requestEnrollment,
				connect: {
					status: connectStatus,
					start: connectStart,
					disconnect: connectDisconnect,
					onStatus: (cb: typeof statusPush) => {
						statusPush = cb;
						return () => undefined;
					},
					onPrefill: (cb: typeof prefillPush) => {
						prefillPush = cb;
						return () => undefined;
					},
				},
			},
		});
	});

	afterEach(() => {
		setMaestro(undefined);
	});

	async function cardIn(state: string) {
		await waitFor(() =>
			expect(screen.getByTestId('mega-connect-card').getAttribute('data-state')).toBe(state)
		);
		return screen.getByTestId('mega-connect-card');
	}

	it('shows the unavailable state before the Mega adapter is bound (no connect bridge)', async () => {
		setMaestro({
			enterprise: { megaServerGet, megaServerSave, megaServerLookup, requestEnrollment },
		});
		renderModal();
		await cardIn('unavailable');
		expect(screen.getByText(/cannot reach the Mega-Maestro endpoint/)).toBeTruthy();
		expect(screen.queryByRole('textbox')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
	});

	it('shows the unavailable state main answers', async () => {
		withStatus({ kind: 'unavailable' });
		renderModal();
		await cardIn('unavailable');
		expect(screen.getByText(/Use Troubleshoot for details/)).toBeTruthy();
	});

	const BODIES: Array<[MegaConnectStatus, RegExp, string | null]> = [
		[{ kind: 'notConnected' }, /Enter your work email/, 'Connect'],
		[{ kind: 'managed' }, /Your organization manages this Maestro/, null],
		[{ kind: 'waiting', request: 1042 }, /approve request REQ-1042/, null],
		[{ kind: 'denied' }, /was not approved/, 'Try again'],
		[{ kind: 'expired' }, /expired before it was approved/, 'Try again'],
		[{ kind: 'revoked' }, /administrator disconnected/, 'Connect again'],
		[{ kind: 'grantExpired' }, /Your connection expired/, 'Connect again'],
	];

	it.each(BODIES)('renders %o with its copy and action', async (status, body, button) => {
		withStatus(status);
		renderModal();
		await cardIn(status.kind);
		expect(screen.getByText(body)).toBeTruthy();
		if (button) expect(screen.getByRole('button', { name: button })).toBeTruthy();
	});

	it('managed shows its copy with no fields', async () => {
		withStatus({ kind: 'managed' });
		renderModal();
		await cardIn('managed');
		expect(screen.queryByLabelText('Work email')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('connected shows names, never an ID, and offers Disconnect', async () => {
		withStatus({
			kind: 'connected',
			orgName: 'Acme',
			teamPath: 'platform/web',
			policy: { name: 'platform-default', revision: 12 },
			syncedAt: Date.now(),
		});
		renderModal();
		await cardIn('connected');
		expect(screen.getByText('Connected to Acme')).toBeTruthy();
		expect(screen.getByText(/platform\/web · Policy platform-default@12 enforced/)).toBeTruthy();
		connectDisconnect.mockResolvedValue({ ok: true, value: { status: { kind: 'notConnected' } } });
		fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
		await cardIn('notConnected');
		expect(connectDisconnect).toHaveBeenCalledTimes(1);
	});

	it('browserOpened shows the large number, the request line and Open the browser again', async () => {
		withStatus({
			kind: 'browserOpened',
			matchNumber: 47,
			request: 1042,
			serverName: 'mega.acme.com',
		});
		renderModal();
		await cardIn('browserOpened');
		const number = screen.getByRole('group', { name: 'Number to pick in your browser: 4 7' });
		expect(number.textContent).toBe('47');
		expect(screen.getByText('Request REQ-1042 · mega.acme.com')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Open the browser again' })).toBeTruthy();
	});

	it('the default view never shows host, port, socket, IDs or digests', async () => {
		const uuid = '123e4567-e89b-12d3-a456-426614174000';
		const digest = 'a'.repeat(64);
		withStatus({
			kind: 'browserOpened',
			matchNumber: 47,
			request: 1042,
			serverName: 'mega.acme.com:8443',
		});
		const view = renderModal();
		await cardIn('browserOpened');
		await waitFor(() => expect(megaServerGet).toHaveBeenCalled());
		statusPush!({
			status: {
				kind: 'connected',
				orgName: uuid,
				teamPath: digest,
				policy: { name: uuid, revision: 3 },
			},
		});
		await cardIn('connected');
		expect(screen.getByRole('heading', { name: 'Connected' })).toBeTruthy();
		const text = view.container.textContent ?? '';
		for (const forbidden of [uuid, digest, 'ipc.sock', '8443', 'mega.example.com']) {
			expect(text).not.toContain(forbidden);
		}
		for (const label of TECHNICAL_LABELS) expect(screen.queryByLabelText(label)).toBeNull();
	});

	it('a status push from main moves the card to the new state', async () => {
		renderModal();
		await cardIn('notConnected');
		statusPush!({ status: { kind: 'waiting' } });
		await cardIn('waiting');
		expect(screen.getByText(/approve your request/)).toBeTruthy();
	});

	it('a malformed email shows the hint and is not sent; a valid one starts with the validated input', async () => {
		connectStart.mockResolvedValue({
			ok: true,
			value: { status: { kind: 'browserOpened', matchNumber: '07', request: 'REQ-9' } },
		});
		renderModal();
		await cardIn('notConnected');
		const email = screen.getByLabelText('Work email');
		fireEvent.change(email, { target: { value: 'not-an-email' } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		expect(await screen.findByText(/like alice@acme.com/)).toBeTruthy();
		expect(email.getAttribute('aria-invalid')).toBe('true');
		expect(connectStart).not.toHaveBeenCalled();

		fireEvent.change(email, { target: { value: ' Alice@Acme.com ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await cardIn('browserOpened');
		expect(connectStart).toHaveBeenCalledWith({ kind: 'email', email: 'alice@acme.com' });
		expect(screen.getByRole('group', { name: /^Number to pick in your browser/ }).textContent).toBe(
			'07'
		);

		// Open the browser again sends the same input: the endpoint answers the same request.
		fireEvent.click(screen.getByRole('button', { name: 'Open the browser again' }));
		await waitFor(() => expect(connectStart).toHaveBeenCalledTimes(2));
		expect(connectStart.mock.calls[1][0]).toEqual(connectStart.mock.calls[0][0]);
	});

	it('Open the browser again is disabled when this session sent nothing', async () => {
		withStatus({ kind: 'browserOpened', matchNumber: 12 });
		renderModal();
		await cardIn('browserOpened');
		const again = screen.getByRole('button', { name: 'Open the browser again' });
		expect((again as HTMLButtonElement).disabled).toBe(true);
	});

	it('a refused start shows its sentence and stays on the form', async () => {
		connectStart.mockResolvedValue({ ok: false, refusal: 'pin_mismatch' });
		renderModal();
		await cardIn('notConnected');
		fireEvent.change(screen.getByLabelText('Work email'), {
			target: { value: 'alice@acme.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		expect(await screen.findByText(/not on the server you named/)).toBeTruthy();
		expect(screen.getByTestId('mega-connect-card').getAttribute('data-state')).toBe('notConnected');
	});

	it('an unavailable refusal turns the card to the unavailable state', async () => {
		connectStart.mockResolvedValue({ ok: false, refusal: 'endpoint_connect_unavailable' });
		renderModal();
		await cardIn('notConnected');
		fireEvent.change(screen.getByLabelText('Work email'), {
			target: { value: 'alice@acme.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await cardIn('unavailable');
	});

	it('switches to a join link, then to a team code with its Server field', async () => {
		connectStart.mockResolvedValue({ ok: true, value: { status: { kind: 'waiting' } } });
		renderModal();
		await cardIn('notConnected');
		fireEvent.click(screen.getByRole('button', { name: 'Use a link or code instead' }));
		await cardIn('linkOrCode');
		expect(screen.getByLabelText('Join link')).toBeTruthy();
		expect(screen.queryByLabelText('Work email')).toBeNull();
		expect(screen.queryByLabelText('Server')).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Use a team code' }));
		expect(screen.getByLabelText('Team code')).toBeTruthy();
		expect(screen.getByLabelText('Server')).toBeTruthy();
		fireEvent.change(screen.getByLabelText('Team code'), { target: { value: 'acme-web-7k3m' } });
		fireEvent.change(screen.getByLabelText('Server'), { target: { value: 'Mega.Acme.com' } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await waitFor(() =>
			expect(connectStart).toHaveBeenCalledWith({
				kind: 'teamCode',
				teamCode: 'ACME-WEB-7K3M',
				server: 'mega.acme.com',
			})
		);

		// And back to email.
		statusPush!({ status: { kind: 'notConnected' } });
		await cardIn('notConnected');
		fireEvent.click(screen.getByRole('button', { name: 'Use a link or code instead' }));
		fireEvent.click(screen.getByRole('button', { name: 'Use my work email instead' }));
		expect(screen.getByLabelText('Work email')).toBeTruthy();
	});

	it('a join deep link prefills the join link and never starts a connection', async () => {
		renderModal();
		await cardIn('notConnected');
		const code = 'AbCdEfGhIjKlMnOpQrStUv';
		prefillPush!({ kind: 'join', server: 'mega.acme.com', code });
		await cardIn('linkOrCode');
		expect((screen.getByLabelText('Join link') as HTMLInputElement).value).toBe(
			`https://mega.acme.com/join/${code}`
		);
		expect(connectStart).not.toHaveBeenCalled();

		connectStart.mockResolvedValue({ ok: true, value: { status: { kind: 'waiting' } } });
		fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
		await waitFor(() =>
			expect(connectStart).toHaveBeenCalledWith({
				kind: 'joinLink',
				joinLink: `https://mega.acme.com/join/${code}`,
			})
		);
	});

	it('a connect deep link prefills the team code and server and never starts a connection', async () => {
		renderModal();
		await cardIn('notConnected');
		prefillPush!({ kind: 'connect', server: 'mega.acme.com', teamCode: 'ACME-WEB-7K3M' });
		await cardIn('linkOrCode');
		expect((screen.getByLabelText('Team code') as HTMLInputElement).value).toBe('ACME-WEB-7K3M');
		expect((screen.getByLabelText('Server') as HTMLInputElement).value).toBe('mega.acme.com');
		expect(connectStart).not.toHaveBeenCalled();
	});

	it('Try again after a denial reopens the email form', async () => {
		withStatus({ kind: 'denied' });
		renderModal();
		await cardIn('denied');
		fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
		await cardIn('notConnected');
		expect(screen.getByLabelText('Work email')).toBeTruthy();
	});
});
