/**
 * The enrollment section of the Mega-Maestro pane: each card sends its own
 * phase through `window.maestro.enterprise.requestEnrollment`, a card whose text
 * is not a valid phase sends nothing, and the endpoint's answer is said in
 * plain words.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	EnrollmentPhases,
	describeEnrollmentOutcome,
} from '../../../../renderer/components/Settings/MegaMaestroEnrollment';
import { mockTheme } from '../../../helpers/mockTheme';

const requestEnrollment = vi.fn();
function setMaestro(value: unknown) {
	(window as unknown as { maestro: unknown }).maestro = value;
}
const MANAGEMENT = {
	origin: 'https://mega.example',
	tenantId: 't-1',
	issuerSha256: 'a'.repeat(64),
};

describe('EnrollmentPhases', () => {
	beforeEach(() => {
		requestEnrollment.mockReset();
		setMaestro({ enterprise: { requestEnrollment } });
	});
	afterEach(() => {
		setMaestro(undefined);
	});

	it('sends the request card as a request phase and reports the endpoint answer', async () => {
		requestEnrollment.mockResolvedValue({
			status: 'ok',
			value: { outcome: 'enrollment_requested', requestId: 'r-1' },
		});
		const onAnswered = vi.fn();
		render(<EnrollmentPhases theme={mockTheme} onAnswered={onAnswered} />);

		fireEvent.change(screen.getByLabelText('1. Request'), {
			target: {
				value: JSON.stringify({
					socketPath: '/tmp/ipc.sock',
					management: MANAGEMENT,
					orgId: 'org-1',
					serverCaPem: 'pem',
				}),
			},
		});
		fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[0]);

		await waitFor(() =>
			expect(screen.getByText(/Accepted by the endpoint \(enrollment requested\)/)).toBeTruthy()
		);
		expect(requestEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({ phase: 'request', orgId: 'org-1', socketPath: '/tmp/ipc.sock' })
		);
		expect(onAnswered).toHaveBeenCalledTimes(1);
	});

	it('sends nothing for a card whose text is not a valid phase', async () => {
		render(<EnrollmentPhases theme={mockTheme} onAnswered={vi.fn()} />);
		fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[1]);
		await waitFor(() => expect(screen.getByText(/Not sent\. Missing fields/)).toBeTruthy());
		expect(requestEnrollment).not.toHaveBeenCalled();
	});

	it('says so when the surface has no enrollment API', async () => {
		setMaestro(undefined);
		render(<EnrollmentPhases theme={mockTheme} onAnswered={vi.fn()} />);
		fireEvent.change(screen.getByLabelText('2. Prove possession'), {
			target: {
				value: JSON.stringify({
					socketPath: '/s',
					management: MANAGEMENT,
					challenge: { id: 'c-1' },
				}),
			},
		});
		fireEvent.click(screen.getAllByRole('button', { name: 'Send' })[1]);
		await waitFor(() =>
			expect(screen.getByText('This surface cannot send enrollment steps.')).toBeTruthy()
		);
	});
});

describe('describeEnrollmentOutcome', () => {
	it('names a denial by its operation and reason', () => {
		expect(
			describeEnrollmentOutcome({
				status: 'denied',
				reason: 'invalid_request',
				operation: 'enrollment',
			})
		).toBe('The endpoint denied enrollment: invalid request.');
	});

	it('passes a refusal or an unsupported answer through in its own words', () => {
		expect(
			describeEnrollmentOutcome({
				status: 'unsupported',
				message: 'Not offered.',
				owner: 'mega-maestro',
			})
		).toBe('Not offered.');
	});
});
