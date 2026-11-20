/**
 * The Connect card's accessibility (MSX-03-02). What is defended: focus moves
 * to the number region once, when browserOpened appears, and never on a poll
 * or a later waiting state; the number's accessible name reads its digits one
 * at a time; the polite live region holds only the state word, never the
 * number, and does not change on a poll that brings the same state; every
 * state has a word and an icon with an accessible name; the waiting pulse runs
 * only when motion is allowed; every control has a visible focus ring; Escape
 * is not swallowed by the card.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
	ConnectCard,
	forgetLastConnectInput,
	spokenDigits,
} from '../../../../renderer/components/MegaMaestro/ConnectCard';
import type { MegaConnectStatus } from '../../../../shared/megaConnect/view';
import { MEGA_CONNECT_STATUS_KINDS, viewFor } from '../../../../shared/megaConnect/view';
import { mockTheme } from '../../../helpers/mockTheme';

type StatusView = { status: MegaConnectStatus };

let statusPush: ((next: StatusView) => void) | null = null;
const connectStatus = vi.fn();

function withStatus(status: MegaConnectStatus) {
	connectStatus.mockResolvedValue({ status });
}

function push(status: MegaConnectStatus) {
	act(() => statusPush!({ status }));
}

async function cardIn(kind: MegaConnectStatus['kind']) {
	await waitFor(() =>
		expect(screen.getByTestId('mega-connect-card').getAttribute('data-state')).toBe(kind)
	);
}

const SAMPLE: Record<MegaConnectStatus['kind'], MegaConnectStatus> = {
	notConnected: { kind: 'notConnected' },
	linkOrCode: { kind: 'linkOrCode', mode: 'joinLink' },
	managed: { kind: 'managed' },
	browserOpened: { kind: 'browserOpened', matchNumber: 47 },
	waiting: { kind: 'waiting', request: 1042 },
	connected: { kind: 'connected', orgName: 'Acme' },
	denied: { kind: 'denied' },
	expired: { kind: 'expired' },
	revoked: { kind: 'revoked' },
	grantExpired: { kind: 'grantExpired' },
	unavailable: { kind: 'unavailable' },
};

describe('ConnectCard accessibility', () => {
	beforeEach(() => {
		forgetLastConnectInput();
		statusPush = null;
		connectStatus.mockReset();
		withStatus({ kind: 'notConnected' });
		(window as unknown as { maestro: unknown }).maestro = {
			enterprise: {
				connect: {
					status: connectStatus,
					start: vi.fn(),
					disconnect: vi.fn(),
					onStatus: (cb: (next: StatusView) => void) => {
						statusPush = cb;
						return () => {
							statusPush = null;
						};
					},
					onPrefill: () => () => undefined,
				},
			},
		};
	});

	afterEach(() => {
		(window as unknown as { maestro: unknown }).maestro = undefined;
	});

	it('reads the number one digit at a time', () => {
		expect(spokenDigits('47')).toBe('4 7');
		expect(spokenDigits('07')).toBe('0 7');
		expect(spokenDigits(' 1 2 ')).toBe('1 2');
	});

	it('moves focus to the number when browserOpened appears, once', async () => {
		render(<ConnectCard theme={mockTheme} />);
		await cardIn('notConnected');
		const email = screen.getByLabelText('Work email');
		email.focus();
		push({ kind: 'browserOpened', matchNumber: 47, request: 1042 });
		const number = screen.getByRole('group', { name: 'Number to pick in your browser: 4 7' });
		expect(document.activeElement).toBe(number);
		expect(number.getAttribute('tabindex')).toBe('-1');
		// The visible digits are hidden from the reader; the name carries them spaced.
		expect(number.querySelector('[aria-hidden="true"]')?.textContent).toBe('47');

		// The person moves on; a poll that brings the same state does not pull focus back.
		const elsewhere = document.createElement('button');
		document.body.appendChild(elsewhere);
		elsewhere.focus();
		push({ kind: 'browserOpened', matchNumber: 47, request: 1042 });
		expect(document.activeElement).toBe(elsewhere);
		elsewhere.remove();
	});

	it('the waiting state updates in place and never steals focus', async () => {
		withStatus({ kind: 'browserOpened', matchNumber: 47 });
		render(<ConnectCard theme={mockTheme} />);
		await cardIn('browserOpened');
		const outside = document.createElement('button');
		document.body.appendChild(outside);
		outside.focus();
		push({ kind: 'waiting', request: 1042 });
		await cardIn('waiting');
		push({ kind: 'waiting', request: 1042 });
		expect(document.activeElement).toBe(outside);
		outside.remove();
	});

	it('announces only the state word, once per transition, never the number', async () => {
		render(<ConnectCard theme={mockTheme} />);
		await cardIn('notConnected');
		const live = screen.getByTestId('mega-connect-live');
		expect(live.getAttribute('aria-live')).toBe('polite');
		expect(live.textContent).toBe('Not connected');

		push({ kind: 'browserOpened', matchNumber: 47, request: 1042 });
		expect(live.textContent).toBe('Waiting for approval');
		expect(live.textContent).not.toContain('47');
		expect(live.textContent).not.toContain('4 7');

		// A poll with the same state leaves the live node untouched, so nothing is re-announced.
		const before = live.firstChild;
		push({ kind: 'browserOpened', matchNumber: 47, request: 1042 });
		expect(live.firstChild).toBe(before);
		expect(live.textContent).toBe('Waiting for approval');

		push({ kind: 'connected', orgName: 'Acme' });
		expect(live.textContent).toBe('Connected');
		// The only live region in the card is this one.
		const card = screen.getByTestId('mega-connect-card');
		expect(card.querySelectorAll('[aria-live]')).toHaveLength(1);
	});

	it('shows every state with a word and a named icon, not color alone', async () => {
		render(<ConnectCard theme={mockTheme} />);
		await cardIn('notConnected');
		for (const kind of MEGA_CONNECT_STATUS_KINDS) {
			if (kind === 'linkOrCode') continue; // a form mode of the card, not a state main pushes
			push(SAMPLE[kind]);
			const word = viewFor(SAMPLE[kind]).indicatorWord;
			const line = screen.getByTestId('mega-connect-state');
			expect(line.textContent).toBe(word);
			const icon = line.querySelector('[role="img"]');
			expect(icon?.getAttribute('aria-label')).toBe(word);
		}
	});

	it('pulses the waiting icon only when motion is allowed', async () => {
		withStatus({ kind: 'waiting', request: 1042 });
		const { container } = render(<ConnectCard theme={mockTheme} />);
		await cardIn('waiting');
		const icon = screen.getByTestId('mega-connect-state').querySelector('[role="img"]')!;
		expect(icon.getAttribute('class')).toContain('motion-safe:animate-pulse');
		// No animation class anywhere in the card runs without the motion-safe guard.
		for (const el of Array.from(container.querySelectorAll('[class]'))) {
			const classes = (el.getAttribute('class') ?? '').split(/\s+/);
			for (const name of classes) {
				if (/animate-/.test(name)) expect(name.startsWith('motion-safe:')).toBe(true);
			}
		}
	});

	it('gives every button and field a visible focus ring', async () => {
		render(<ConnectCard theme={mockTheme} />);
		await cardIn('notConnected');
		const controls = [...screen.getAllByRole('button'), screen.getByLabelText('Work email')];
		expect(controls.length).toBeGreaterThan(1);
		for (const control of controls) {
			expect(control.getAttribute('class')).toContain('focus-visible:ring-2');
		}
	});

	it('leaves Escape to the window', async () => {
		const onKeyDown = vi.fn();
		render(
			<div onKeyDown={onKeyDown}>
				<ConnectCard theme={mockTheme} />
			</div>
		);
		await cardIn('notConnected');
		fireEvent.keyDown(screen.getByLabelText('Work email'), { key: 'Escape' });
		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(onKeyDown.mock.calls[0][0].defaultPrevented).toBe(false);
	});
});
