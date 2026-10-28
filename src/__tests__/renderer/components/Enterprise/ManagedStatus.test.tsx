/**
 * The managed standing and notice inbox surfaces (MRC-11-06C, from the
 * MRC-11-04 smoke): `<ManagedStatus>` draws one word with its tint and one
 * sentence per standing, the four non-standing answers, and compact mode;
 * `<ManagedInbox>` is a labelled section whose bodies are plain text, whose
 * receipts are distinct typed acts, whose reply is sent once and cleared, and
 * whose every outcome reaches the one polite live region. No control hands a
 * notice to an agent, a composer or a queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
	ManagedStatus,
	STATUS_COPY,
	STANDING_TINT,
} from '../../../../renderer/components/Enterprise/ManagedStatus';
import { ManagedInbox, INBOX_COPY } from '../../../../renderer/components/Enterprise/ManagedInbox';
import { MANAGED_STANDING_COPY } from '../../../../renderer/hooks/enterprise/useManagedStatus';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { ManagedInboxView, NoticeView } from '../../../../main/enterprise/inbox';
import type { ManagedStanding, ManagedStateView } from '../../../../main/enterprise/managed-state';
import { mockTheme } from '../../../helpers/mockTheme';

const inboxState = vi.fn();
const inboxRefresh = vi.fn();
const inboxAct = vi.fn();

const BODY =
	'Maintenance tonight. See [the plan](http://example.test/plan) or <a href="x">here</a>.';

function notice(over: Partial<NoticeView> = {}): NoticeView {
	return {
		campaignId: 'camp-1',
		messageId: 'msg-1',
		body: BODY,
		expiresAt: '2026-10-30T00:00:00.000Z',
		kind: 'notice',
		agentInput: false,
		firstListedAt: '2026-10-23T10:00:00.000Z',
		recorded: 'delivered',
		receipts: { delivered: 'recorded' },
		...over,
	};
}

function view(
	notices: NoticeView[],
	standing: ManagedInboxView['status']['standing'] = { ok: true }
): ManagedInboxView {
	return {
		status: {
			file: null,
			loaded: true,
			load: null,
			standing,
			capabilities: { noticeList: true, inbox: true },
			notices: { held: notices.length, unread: 1, unacknowledged: notices.length },
			receipts: {
				total: notices.length,
				byState: { pending: 0, recorded: notices.length, denied: 0, uncertain: 0 },
			},
			lastRefresh: null,
		},
		notices,
	};
}

function listed(listedCount: number, newlyHeld: number) {
	return {
		at: '2026-10-23T12:00:00.000Z',
		outcome: 'listed',
		reason: null,
		denial: null,
		pages: 1,
		listed: listedCount,
		expired: 0,
		newlyHeld,
		delivered: { recorded: newlyHeld, uncertain: 0, denied: 0, unavailable: 0 },
	};
}

function stateOf(
	standing: ManagedStanding,
	reason: string | null = null,
	holds: Partial<Pick<ManagedStateView, 'egress' | 'update'>> = {}
): ManagedStateView {
	return {
		standing,
		reason,
		egress: { held: [] },
		update: { held: null },
		...holds,
	} as ManagedStateView;
}

function status(
	state: ManagedStateView | null | undefined,
	over: Partial<{ supported: boolean; error: string | null }> = {}
) {
	return { supported: true, error: null, ...over, state };
}

/** Every button a person can press on the surface, by its visible name. */
function buttonNames(): string[] {
	return screen.getAllByRole('button').map((button) => button.textContent ?? '');
}

const maestro = window.maestro as unknown as Record<string, unknown>;
const originalEnterprise = maestro.enterprise;

beforeEach(() => {
	clearCachedResources();
	inboxState
		.mockReset()
		.mockResolvedValue(view([notice(), notice({ messageId: 'msg-2', recorded: 'read' })]));
	inboxRefresh.mockReset().mockResolvedValue(listed(2, 0));
	inboxAct.mockReset().mockResolvedValue({ status: 'recorded', record: {}, duplicate: false });
	maestro.enterprise = { inboxState, inboxRefresh, inboxAct };
});

afterEach(() => {
	maestro.enterprise = originalEnterprise;
});

describe('ManagedStatus', () => {
	it('draws the word, its tint and the sentence for every standing, with the reason appended', () => {
		for (const standing of Object.keys(MANAGED_STANDING_COPY) as ManagedStanding[]) {
			const copy = MANAGED_STANDING_COPY[standing];
			const { unmount } = render(
				<ManagedStatus theme={mockTheme} status={status(stateOf(standing))} />
			);
			const badge = screen.getByTestId('managed-standing');
			expect(badge).toHaveTextContent(copy.label);
			expect(badge).toHaveStyle({ color: mockTheme.colors[STANDING_TINT[standing]] });
			expect(screen.getByText(STATUS_COPY.standing)).toBeInTheDocument();
			expect(screen.getByText(copy.detail)).toBeInTheDocument();
			unmount();
		}
		render(
			<ManagedStatus
				theme={mockTheme}
				status={status(stateOf('offline', 'No endpoint connection is open.'))}
			/>
		);
		expect(
			screen.getByText(`${MANAGED_STANDING_COPY.offline.detail} No endpoint connection is open.`)
		).toBeInTheDocument();
		// Nothing held: no list, no heading.
		expect(screen.queryByTestId('managed-holds')).not.toBeInTheDocument();
		expect(screen.queryByText(STATUS_COPY.holds)).not.toBeInTheDocument();
	});

	// MRC2-05-04A: what the ceilings hold is listed beside the standing, each as
	// the one `[managed-<code>] ...` line, from the projection's own records.
	it('lists the update hold in force and every egress hold under the standing', () => {
		const update = {
			code: 'pin-denied',
			message: 'Policy revision 3 pins this installation to 1.2.0.',
			policyRevision: 3,
			candidate: 'v1.3.0',
		};
		const egress = [
			{
				class: 'vendor-telemetry',
				code: 'class-denied',
				origin: 'https://runmaestro.ai',
				firstAt: '2026-10-28T09:00:00.000Z',
				lastAt: new Date().toISOString(),
				count: 3,
			},
			{
				class: 'updates',
				code: 'unavailable',
				origin: null,
				firstAt: '2026-10-28T09:00:00.000Z',
				lastAt: new Date().toISOString(),
				count: 1,
			},
		];
		const { rerender } = render(
			<ManagedStatus
				theme={mockTheme}
				status={status(
					stateOf('managed', null, { egress: { held: egress }, update: { held: update } })
				)}
			/>
		);
		const list = within(screen.getByTestId('managed-holds'));
		expect(list.getByText(STATUS_COPY.holds)).toBeInTheDocument();
		const items = list.getAllByRole('listitem').map((item) => item.textContent);
		expect(items).toEqual([
			'Update v1.3.0: [managed-pin-denied] Policy revision 3 pins this installation to 1.2.0.',
			expect.stringMatching(
				/^\[managed-class-denied\] 3 vendor-telemetry requests to https:\/\/runmaestro\.ai refused, last /
			),
			expect.stringMatching(
				/^\[managed-unavailable\] 1 updates request to an unnamed destination refused, last /
			),
		]);
		// No control: the list is a record, not a way to lift a hold.
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
		// A held check with no candidate names the check itself; egress alone still lists.
		rerender(
			<ManagedStatus
				theme={mockTheme}
				status={status(
					stateOf('managed', null, {
						update: { held: { ...update, code: 'held', candidate: null } },
					})
				)}
			/>
		);
		expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
			'Update check: [managed-held] Policy revision 3 pins this installation to 1.2.0.',
		]);
		// Compact draws the badge alone, holds or not.
		rerender(
			<ManagedStatus
				theme={mockTheme}
				status={status(stateOf('managed', null, { egress: { held: egress } }))}
				compact
			/>
		);
		expect(screen.queryByTestId('managed-holds')).not.toBeInTheDocument();
		expect(screen.getByTestId('managed-standing')).toBeInTheDocument();
	});

	it('answers a browser, no service, the first read and a failed read by their sentences', () => {
		const { rerender } = render(
			<ManagedStatus theme={mockTheme} status={status(undefined, { supported: false })} />
		);
		expect(screen.getByText(STATUS_COPY.desktopOnly)).toBeInTheDocument();
		expect(screen.queryByTestId('managed-standing')).not.toBeInTheDocument();
		rerender(<ManagedStatus theme={mockTheme} status={status(null)} />);
		expect(screen.getByText(STATUS_COPY.noService)).toBeInTheDocument();
		rerender(<ManagedStatus theme={mockTheme} status={status(undefined)} />);
		expect(screen.getByText(STATUS_COPY.reading)).not.toHaveStyle({
			color: mockTheme.colors.error,
		});
		rerender(<ManagedStatus theme={mockTheme} status={status(undefined, { error: 'x' })} />);
		expect(screen.getByText(STATUS_COPY.readFailed)).toHaveStyle({
			color: mockTheme.colors.error,
		});
		// A read error beside a standing does not hide the standing.
		rerender(
			<ManagedStatus theme={mockTheme} status={status(stateOf('managed'), { error: 'x' })} />
		);
		expect(screen.getByTestId('managed-standing')).toHaveTextContent('Managed');
		expect(screen.queryByText(STATUS_COPY.readFailed)).not.toBeInTheDocument();
	});

	it('compact: the badge alone with the detail as its title and description; nothing unmanaged', () => {
		const state = stateOf('offline', 'No endpoint connection is open.');
		const detail = `${MANAGED_STANDING_COPY.offline.detail} No endpoint connection is open.`;
		const { container, rerender } = render(
			<ManagedStatus theme={mockTheme} status={status(state)} compact />
		);
		const badge = screen.getByTestId('managed-standing');
		expect(badge).toHaveTextContent(MANAGED_STANDING_COPY.offline.label);
		expect(badge).toHaveAttribute('title', detail);
		expect(badge).toHaveAccessibleDescription(detail);
		expect(badge).toHaveStyle({ color: mockTheme.colors.warning });
		expect(screen.queryByText(STATUS_COPY.standing)).not.toBeInTheDocument();
		expect(screen.queryByText(detail)).not.toBeInTheDocument();
		expect(container.querySelectorAll('*')).toHaveLength(1);
		rerender(<ManagedStatus theme={mockTheme} status={status(stateOf('unenrolled'))} compact />);
		expect(container).toBeEmptyDOMElement();
		rerender(<ManagedStatus theme={mockTheme} status={status(null)} compact />);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<ManagedStatus theme={mockTheme} status={status(undefined, { supported: false })} compact />
		);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<ManagedStatus theme={mockTheme} status={status(undefined, { error: 'x' })} compact />
		);
		expect(container).toBeEmptyDOMElement();
	});
});

describe('ManagedInbox', () => {
	it('is a labelled section: the list under its heading, the counts, bodies as plain text', async () => {
		render(<ManagedInbox theme={mockTheme} />);
		const section = screen.getByRole('region', { name: INBOX_COPY.heading });
		expect(within(section).getByRole('heading', { level: 4 })).toHaveTextContent(
			INBOX_COPY.heading
		);
		expect(within(section).getByText(INBOX_COPY.intro)).toBeInTheDocument();
		const list = await within(section).findByRole('list', { name: INBOX_COPY.heading });
		const items = within(list).getAllByRole('listitem');
		expect(items).toHaveLength(2);
		// The body is text, never markup: the markdown link and the anchor stay literal.
		expect(within(list).getAllByText(BODY)).toHaveLength(2);
		expect(within(section).queryByRole('link')).not.toBeInTheDocument();
		expect(section.querySelector('a')).toBeNull();
		expect(screen.getByText(INBOX_COPY.counts(2, 1, 2))).toBeInTheDocument();
		expect(within(items[0]).getByText(INBOX_COPY.state.delivered)).toBeInTheDocument();
		expect(within(items[1]).getByText(INBOX_COPY.state.read)).toBeInTheDocument();
		expect(within(items[0]).getByText(/First listed/)).toBeInTheDocument();
		expect(within(items[0]).getByText(/Expires/)).toBeInTheDocument();
		// Reached states are disabled; the next ones are enabled.
		expect(within(items[0]).getByText(INBOX_COPY.markRead)).toBeEnabled();
		expect(within(items[0]).getByText(INBOX_COPY.acknowledge)).toBeEnabled();
		expect(within(items[1]).getByText(INBOX_COPY.markRead)).toBeDisabled();
		expect(within(items[1]).getByText(INBOX_COPY.acknowledge)).toBeEnabled();
		expect(within(items[1]).getByText(INBOX_COPY.reply)).toBeEnabled();
		// The whole set of controls: three receipts per notice and the listing.
		// Nothing hands a notice to an agent, a composer or a queue.
		expect(buttonNames()).toEqual([
			INBOX_COPY.markRead,
			INBOX_COPY.acknowledge,
			INBOX_COPY.reply,
			INBOX_COPY.markRead,
			INBOX_COPY.acknowledge,
			INBOX_COPY.reply,
			INBOX_COPY.list,
		]);
		expect(
			screen.queryByRole('button', { name: /agent|composer|queue|insert|send to|ask/i })
		).not.toBeInTheDocument();
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		const live = screen.getByRole('status');
		expect(live).toHaveAttribute('aria-live', 'polite');
		expect(live).toBeEmptyDOMElement();
	});

	it('records read and acknowledged as distinct typed acts, marks the busy controls, announces', async () => {
		let settle: (value: unknown) => void = () => {};
		inboxAct.mockImplementationOnce(() => new Promise((resolve) => (settle = resolve)));
		render(<ManagedInbox theme={mockTheme} />);
		const items = await screen.findAllByRole('listitem');
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.acknowledge));
		expect(inboxAct).toHaveBeenCalledWith({
			campaignId: 'camp-1',
			messageId: 'msg-1',
			action: { kind: 'acknowledged' },
		});
		// While it runs: that notice's receipt controls say so, every other control waits.
		const working = within(items[0]).getAllByText(INBOX_COPY.working);
		expect(working).toHaveLength(2);
		for (const control of working) {
			expect(control).toHaveAttribute('aria-busy', 'true');
			expect(control).toBeDisabled();
		}
		expect(within(items[1]).getByText(INBOX_COPY.acknowledge)).toBeDisabled();
		expect(screen.getByText(INBOX_COPY.list)).toBeDisabled();
		inboxState.mockResolvedValue(view([notice({ recorded: 'acknowledged' })]));
		settle({ status: 'recorded', record: {}, duplicate: false });
		const live = screen.getByRole('status');
		expect(await within(live).findByText('Acknowledged.')).not.toHaveStyle({
			color: mockTheme.colors.error,
		});
		// The view was re-read after the act, and the reached states are now disabled.
		expect(inboxState.mock.calls.length).toBeGreaterThanOrEqual(2);
		await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
		expect(screen.getByText(INBOX_COPY.markRead)).toBeDisabled();
		expect(screen.getByText(INBOX_COPY.acknowledge)).toBeDisabled();
		expect(screen.getByText(INBOX_COPY.list)).toBeEnabled();
		// Read is its own act with its own sentence, and a duplicate says so.
		inboxState.mockResolvedValue(view([notice(), notice({ messageId: 'msg-2' })]));
		fireEvent.click(screen.getByText(INBOX_COPY.list));
		await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
		const two = screen.getAllByRole('listitem');
		fireEvent.click(within(two[1]).getByText(INBOX_COPY.markRead));
		expect(inboxAct).toHaveBeenLastCalledWith({
			campaignId: 'camp-1',
			messageId: 'msg-2',
			action: { kind: 'read' },
		});
		expect(await within(live).findByText('Marked read.')).toBeInTheDocument();
		inboxAct.mockResolvedValueOnce({ status: 'recorded', record: {}, duplicate: true });
		fireEvent.click(within(two[0]).getByText(INBOX_COPY.markRead));
		expect(
			await within(live).findByText('Already recorded; nothing was sent again.')
		).toBeInTheDocument();
		expect(within(live).getAllByRole('paragraph')).toHaveLength(1);
	});

	it('sends a private reply once and clears it; an uncertain answer keeps the text for resending', async () => {
		render(<ManagedInbox theme={mockTheme} />);
		const items = await screen.findAllByRole('listitem');
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.reply));
		// The field is labelled and described; the reply control takes the button's place.
		const field = screen.getByLabelText(INBOX_COPY.replyLabel);
		expect(field).toHaveAccessibleDescription(INBOX_COPY.replyHint);
		expect(field).toHaveValue('');
		expect(within(items[0]).queryByText(INBOX_COPY.reply)).not.toBeInTheDocument();
		expect(within(items[1]).getByText(INBOX_COPY.reply)).toBeInTheDocument();
		expect(screen.getByText(INBOX_COPY.send)).toBeDisabled();
		fireEvent.change(field, { target: { value: '   ' } });
		expect(screen.getByText(INBOX_COPY.send)).toBeDisabled();
		fireEvent.change(field, { target: { value: 'Please delay by one hour.' } });
		expect(screen.getByText(INBOX_COPY.send)).toBeEnabled();
		// Cancel clears the text and closes the field; nothing was sent.
		fireEvent.click(screen.getByText(INBOX_COPY.cancel));
		expect(screen.queryByLabelText(INBOX_COPY.replyLabel)).not.toBeInTheDocument();
		expect(inboxAct).not.toHaveBeenCalled();
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.reply));
		expect(screen.getByLabelText(INBOX_COPY.replyLabel)).toHaveValue('');
		fireEvent.change(screen.getByLabelText(INBOX_COPY.replyLabel), {
			target: { value: 'Please delay by one hour.' },
		});
		inboxAct.mockResolvedValueOnce({ status: 'uncertain', record: {}, detail: 'lost' });
		fireEvent.click(screen.getByText(INBOX_COPY.send));
		const live = screen.getByRole('status');
		expect(await within(live).findByText(/answer was not seen/)).toHaveStyle({
			color: mockTheme.colors.error,
		});
		expect(screen.getByLabelText(INBOX_COPY.replyLabel)).toHaveValue('Please delay by one hour.');
		fireEvent.click(screen.getByText(INBOX_COPY.send));
		expect(
			await within(live).findByText('Your reply was recorded by the endpoint.')
		).not.toHaveStyle({ color: mockTheme.colors.error });
		expect(inboxAct).toHaveBeenCalledTimes(2);
		expect(inboxAct).toHaveBeenLastCalledWith({
			campaignId: 'camp-1',
			messageId: 'msg-1',
			action: { kind: 'reply', text: 'Please delay by one hour.' },
		});
		// Recorded: the field is gone and the text is kept nowhere on the surface.
		expect(screen.queryByLabelText(INBOX_COPY.replyLabel)).not.toBeInTheDocument();
		expect(screen.queryByText(/Please delay by one hour/)).not.toBeInTheDocument();
		expect(document.body.innerHTML).not.toContain('Please delay by one hour.');
	});

	it('shows a handler refusal, a denial and an unavailable answer by their sentences, in the error color', async () => {
		render(<ManagedInbox theme={mockTheme} />);
		const items = await screen.findAllByRole('listitem');
		const live = screen.getByRole('status');
		inboxAct.mockRejectedValueOnce(
			new Error(
				"Error invoking remote method 'enterprise:inboxAct': Error: action: a reply needs text."
			)
		);
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.markRead));
		expect(await within(live).findByText('action: a reply needs text.')).toHaveStyle({
			color: mockTheme.colors.error,
		});
		inboxAct.mockResolvedValueOnce({
			status: 'denied',
			reason: 'unknown-message',
			detail: 'never listed',
			record: null,
		});
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.markRead));
		expect(
			await within(live).findByText('The endpoint refused to record read: unknown-message.')
		).toHaveStyle({ color: mockTheme.colors.error });
		inboxAct.mockResolvedValueOnce({ status: 'unavailable', detail: 'The socket is closed.' });
		fireEvent.click(within(items[0]).getByText(INBOX_COPY.acknowledge));
		expect(await within(live).findByText('The socket is closed.')).toHaveStyle({
			color: mockTheme.colors.error,
		});
		// The surface is usable again after each failure.
		expect(within(items[0]).getByText(INBOX_COPY.markRead)).toBeEnabled();
	});

	it('lists again on request and announces the listing, or its denial', async () => {
		render(<ManagedInbox theme={mockTheme} />);
		await screen.findAllByRole('listitem');
		const live = screen.getByRole('status');
		inboxRefresh.mockResolvedValueOnce(listed(3, 1));
		inboxState.mockResolvedValue(
			view([notice(), notice({ messageId: 'msg-2' }), notice({ messageId: 'msg-3' })])
		);
		fireEvent.click(screen.getByText(INBOX_COPY.list));
		expect(await within(live).findByText('Listed 3 notices, 1 new.')).not.toHaveStyle({
			color: mockTheme.colors.error,
		});
		expect(inboxRefresh).toHaveBeenCalledTimes(1);
		await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
		expect(screen.getByText(INBOX_COPY.counts(3, 1, 3))).toBeInTheDocument();
		inboxRefresh.mockResolvedValueOnce({
			...listed(0, 0),
			outcome: 'denied',
			denial: 'unauthenticated',
		});
		fireEvent.click(screen.getByText(INBOX_COPY.list));
		expect(
			await within(live).findByText('The endpoint denied the listing: unauthenticated.')
		).toHaveStyle({ color: mockTheme.colors.error });
		inboxRefresh.mockResolvedValueOnce({
			...listed(0, 0),
			outcome: 'no-standing',
			reason: 'The socket is detached.',
		});
		fireEvent.click(screen.getByText(INBOX_COPY.list));
		expect(
			await within(live).findByText(
				/listed only while this desktop is registered and attached\. The socket is detached\./
			)
		).toBeInTheDocument();
		expect(inboxRefresh).toHaveBeenCalledTimes(3);
	});

	it('says so with no composed client, with no notices (and why), on a failed read, and in a browser', async () => {
		inboxState.mockResolvedValue(null);
		const none = render(<ManagedInbox theme={mockTheme} />);
		expect(await screen.findByText(INBOX_COPY.notComposed)).toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
		none.unmount();
		clearCachedResources();
		inboxState.mockResolvedValue(view([], { ok: false, reason: 'The socket is detached.' }));
		const empty = render(<ManagedInbox theme={mockTheme} />);
		expect(await screen.findByText(INBOX_COPY.empty)).toBeInTheDocument();
		expect(
			screen.getByText(
				`${INBOX_COPY.counts(0, 1, 0)} ${INBOX_COPY.standing('The socket is detached.')}`
			)
		).toBeInTheDocument();
		expect(screen.queryByRole('list')).not.toBeInTheDocument();
		expect(buttonNames()).toEqual([INBOX_COPY.list]);
		empty.unmount();
		clearCachedResources();
		inboxState.mockRejectedValue(new Error('read failed'));
		const failed = render(<ManagedInbox theme={mockTheme} />);
		expect(await screen.findByText(INBOX_COPY.readFailed)).toHaveStyle({
			color: mockTheme.colors.error,
		});
		failed.unmount();
		maestro.enterprise = undefined;
		render(<ManagedInbox theme={mockTheme} />);
		expect(screen.getByText(INBOX_COPY.desktopOnly)).toBeInTheDocument();
		expect(screen.getByRole('region', { name: INBOX_COPY.heading })).toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});
});
