/**
 * ManagedInbox - the notices the endpoint addressed to this desktop's actor,
 * and the receipts a person records on them (MRC-11-04).
 *
 * Over `useManagedInbox()`: the held notices with their bodies, a control to
 * list them again, and per notice the three receipts a person gives (read,
 * acknowledged, a private reply); `delivered` is recorded by the client when
 * a notice is first held, so no control exists for it. The four receipts stay
 * distinct here as they do in the ledger and at the endpoint.
 *
 * An affordance, not enforcement: the endpoint authorizes every inbox effect
 * against the actor it resolves itself, and the main process refuses an act
 * on a notice this host never listed. Privacy: the body is rendered as plain
 * text for the person alone (`agentInput: false` is the contract's word), no
 * control hands it to an agent, and a reply's text is sent once and cleared
 * here; it is kept nowhere on this desktop. Every string lives in
 * `INBOX_COPY`; outcomes are announced through a polite live region; the reply
 * field has a label; busy controls say so.
 */

import { useState, type ReactNode } from 'react';
import type { EndpointInboxState } from '../../../shared/maestro-lib/managed/host-adapter';
import type { NoticeView } from '../../../main/enterprise/inbox';
import { formatRelativeTime } from '../../../shared/formatters';
import {
	useManagedInbox,
	type InboxActResult,
	type InboxListResult,
} from '../../hooks/enterprise/useManagedInbox';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';

export const INBOX_COPY = {
	heading: 'Notices',
	intro:
		'Notices the endpoint addressed to you. They are shown here and recorded as delivered; nothing here hands a notice to an agent.',
	desktopOnly: 'Notices are available in the desktop app.',
	notComposed: 'No notice inbox is composed in this desktop.',
	reading: 'Reading notices...',
	readFailed: 'Could not read the notices. Try again.',
	empty: 'No notices are held.',
	list: 'Refresh notices',
	working: 'Working...',
	counts: (held: number, unread: number, unacknowledged: number) =>
		`${held} held, ${unread} unread, ${unacknowledged} unacknowledged.`,
	standing: (reason: string) => `Not listing: ${reason}`,
	expires: 'Expires',
	firstListed: 'First listed',
	notRecorded: 'Not yet recorded',
	state: {
		delivered: 'Delivered',
		read: 'Read',
		acknowledged: 'Acknowledged',
		replied: 'Replied',
	} satisfies Record<EndpointInboxState, string>,
	markRead: 'Mark read',
	acknowledge: 'Acknowledge',
	reply: 'Reply privately',
	replyLabel: 'Private reply to the endpoint administrator',
	replyHint: 'Sent once to the endpoint and kept nowhere on this desktop.',
	send: 'Send reply',
	cancel: 'Cancel',
} as const;

const STATE_RANK: Record<EndpointInboxState, number> = {
	delivered: 0,
	read: 1,
	acknowledged: 2,
	replied: 3,
};

const FAILED: ReadonlySet<InboxActResult['status'] | InboxListResult['status']> = new Set([
	'denied',
	'uncertain',
	'refused',
	'unavailable',
	'failed',
]);

function reached(notice: NoticeView, state: EndpointInboxState): boolean {
	return notice.recorded !== null && STATE_RANK[notice.recorded] >= STATE_RANK[state];
}

function Button({
	theme,
	label,
	busy = false,
	disabled = false,
	onClick,
}: {
	theme: Theme;
	label: string;
	busy?: boolean;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled || busy}
			aria-busy={busy}
			onClick={onClick}
			className="px-2.5 py-1 rounded border text-xs disabled:opacity-55"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgActivity }}
		>
			{busy ? INBOX_COPY.working : label}
		</button>
	);
}

function Notice({
	theme,
	notice,
	busy,
	onAct,
}: {
	theme: Theme;
	notice: NoticeView;
	busy: string | null;
	onAct: (
		notice: NoticeView,
		action: { kind: 'read' } | { kind: 'acknowledged' } | { kind: 'reply'; text: string }
	) => Promise<InboxActResult>;
}) {
	const [replying, setReplying] = useState(false);
	const [text, setText] = useState('');
	const mine = busy === notice.messageId;
	const replyId = `notice-reply-${notice.messageId}`;
	const send = async () => {
		const result = await onAct(notice, { kind: 'reply', text });
		// A reply the endpoint recorded is gone from here; an uncertain or refused
		// one stays in the field so the person can send it again.
		if (result.status === 'recorded' || result.status === 'duplicate') {
			setText('');
			setReplying(false);
		}
	};
	return (
		<li className="rounded border p-2 space-y-1.5" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center gap-2 text-2xs opacity-70">
				<MiniBadge
					label={notice.recorded ? INBOX_COPY.state[notice.recorded] : INBOX_COPY.notRecorded}
					theme={theme}
					color={notice.recorded ? theme.colors.success : theme.colors.warning}
				/>
				<span>{`${INBOX_COPY.firstListed} ${formatRelativeTime(notice.firstListedAt)}`}</span>
				<span>{`${INBOX_COPY.expires} ${formatRelativeTime(notice.expiresAt)}`}</span>
			</div>
			<p className="text-xs whitespace-pre-wrap break-words select-text">{notice.body}</p>
			<div className="flex flex-wrap gap-1.5">
				<Button
					theme={theme}
					label={INBOX_COPY.markRead}
					busy={mine}
					disabled={busy !== null || reached(notice, 'read')}
					onClick={() => void onAct(notice, { kind: 'read' })}
				/>
				<Button
					theme={theme}
					label={INBOX_COPY.acknowledge}
					busy={mine}
					disabled={busy !== null || reached(notice, 'acknowledged')}
					onClick={() => void onAct(notice, { kind: 'acknowledged' })}
				/>
				{replying ? null : (
					<Button
						theme={theme}
						label={INBOX_COPY.reply}
						disabled={busy !== null}
						onClick={() => setReplying(true)}
					/>
				)}
			</div>
			{replying ? (
				<div className="space-y-1">
					<label htmlFor={replyId} className="block text-xs font-medium">
						{INBOX_COPY.replyLabel}
					</label>
					<textarea
						id={replyId}
						value={text}
						onChange={(event) => setText(event.target.value)}
						rows={3}
						aria-describedby={`${replyId}-hint`}
						className="w-full p-2 rounded border bg-transparent outline-none text-xs resize-y"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					/>
					<p id={`${replyId}-hint`} className="text-2xs opacity-70">
						{INBOX_COPY.replyHint}
					</p>
					<div className="flex gap-1.5">
						<Button
							theme={theme}
							label={INBOX_COPY.send}
							busy={mine}
							disabled={busy !== null || text.trim().length === 0}
							onClick={() => void send()}
						/>
						<Button
							theme={theme}
							label={INBOX_COPY.cancel}
							disabled={mine}
							onClick={() => {
								setText('');
								setReplying(false);
							}}
						/>
					</div>
				</div>
			) : null}
		</li>
	);
}

export function ManagedInbox({ theme }: { theme: Theme }) {
	const inbox = useManagedInbox();
	const [outcome, setOutcome] = useState<InboxActResult | InboxListResult | null>(null);
	/** The message id being acted on, `list` for a listing, or null. */
	const [busy, setBusy] = useState<string | null>(null);
	const view = inbox.view;

	const run = async <T extends InboxActResult | InboxListResult>(
		key: string,
		work: () => Promise<T>
	): Promise<T> => {
		setBusy(key);
		try {
			const result = await work();
			setOutcome(result);
			return result;
		} finally {
			setBusy(null);
		}
	};

	let body: ReactNode;
	if (!inbox.supported) body = <p className="text-xs">{INBOX_COPY.desktopOnly}</p>;
	else if (view === undefined && inbox.error) {
		body = (
			<p className="text-xs" style={{ color: theme.colors.error }}>
				{INBOX_COPY.readFailed}
			</p>
		);
	} else if (view === undefined) body = <p className="text-xs">{INBOX_COPY.reading}</p>;
	else if (view === null) body = <p className="text-xs">{INBOX_COPY.notComposed}</p>;
	else {
		const { notices: counts, standing } = view.status;
		body = (
			<>
				<p className="text-xs opacity-70">
					{INBOX_COPY.counts(counts.held, counts.unread, counts.unacknowledged)}
					{standing.ok ? '' : ` ${INBOX_COPY.standing(standing.reason)}`}
				</p>
				{view.notices.length === 0 ? (
					<p className="text-xs">{INBOX_COPY.empty}</p>
				) : (
					<ul aria-label={INBOX_COPY.heading} className="space-y-2">
						{view.notices.map((notice) => (
							<Notice
								key={`${notice.campaignId}:${notice.messageId}`}
								theme={theme}
								notice={notice}
								busy={busy}
								onAct={(target, action) =>
									run(target.messageId, () =>
										inbox.act(
											{ campaignId: target.campaignId, messageId: target.messageId },
											action
										)
									)
								}
							/>
						))}
					</ul>
				)}
				<Button
					theme={theme}
					label={INBOX_COPY.list}
					busy={busy === 'list'}
					disabled={busy !== null}
					onClick={() => void run('list', inbox.list)}
				/>
			</>
		);
	}

	return (
		<section aria-labelledby="managed-inbox-heading" className="space-y-2">
			<h4 id="managed-inbox-heading" className="font-medium">
				{INBOX_COPY.heading}
			</h4>
			<p className="text-xs opacity-70">{INBOX_COPY.intro}</p>
			{body}
			<div role="status" aria-live="polite" className="text-xs">
				{outcome ? (
					<p style={FAILED.has(outcome.status) ? { color: theme.colors.error } : undefined}>
						{outcome.message}
					</p>
				) : null}
			</div>
		</section>
	);
}
