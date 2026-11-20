/**
 * Connect to your organization: the default view of the Mega-Maestro window.
 *
 * Renders whatever `viewFor()` says the current connect status shows, with
 * every word from `megaConnect/copy.ts`. The status comes from main
 * (`window.maestro.enterprise.connect`); until the Mega adapter is bound main
 * answers `unavailable`, and so does this card when no bridge is present.
 *
 * Names rule: this card shows names only (REQ-1042, mega.acme.com,
 * platform-default@12). No host and port, socket, ID or digest appears here;
 * those live on the Troubleshoot tab.
 *
 * Field checks here are hints. Main validates every input again before
 * anything leaves the process. A deep link prefill fills the fields and never
 * starts a connection (invariant SX3).
 */

import { useEffect, useRef, useState } from 'react';
import type { Theme } from '../../types';
import type { ConnectResult, ConnectStatusView } from '../../../main/enterprise/connect';
import type { ConnectStartRequest } from '../../../main/preload/enterprise';
import type { MegaConnectPrefill } from '../../../shared/megaConnect/deepLink';
import { MEGA_CONNECT_COPY, fillMegaConnectCopy } from '../../../shared/megaConnect/copy';
import {
	validateJoinLink,
	validateServerHost,
	validateTeamCode,
	validateWorkEmail,
} from '../../../shared/megaConnect/input';
import {
	viewFor,
	type MegaConnectAction,
	type MegaConnectActionId,
	type MegaConnectFieldId,
	type MegaConnectStatus,
} from '../../../shared/megaConnect/view';

type FormMode = 'email' | 'joinLink' | 'teamCode';

type FieldValues = Record<MegaConnectFieldId, string>;

const EMPTY_FIELDS: FieldValues = { workEmail: '', joinLink: '', teamCode: '', server: '' };

const UNAVAILABLE: ConnectStatusView = { status: { kind: 'unavailable' } };

const FIELD_HINTS: Record<MegaConnectFieldId, string> = {
	workEmail: MEGA_CONNECT_COPY.workEmailHint,
	joinLink: MEGA_CONNECT_COPY.joinLinkHint,
	teamCode: MEGA_CONNECT_COPY.teamCodeHint,
	server: MEGA_CONNECT_COPY.serverHint,
};

const FIELD_TYPES: Record<MegaConnectFieldId, string> = {
	workEmail: 'email',
	joinLink: 'url',
	teamCode: 'text',
	server: 'text',
};

/** States whose card shows the input form instead of its own body. */
const FORM_STATES = new Set<MegaConnectStatus['kind']>(['notConnected', 'linkOrCode']);

/**
 * The last input main accepted, kept in memory for this app session only and
 * never persisted. "Open the browser again" sends it once more, so the
 * endpoint answers the same request instead of a new one.
 */
let lastAcceptedInput: ConnectStartRequest | null = null;

/** Forget the remembered input (tests, and a disconnect). */
export function forgetLastConnectInput(): void {
	lastAcceptedInput = null;
}

function refusalText(result: Extract<ConnectResult<unknown>, { ok: false }>): string | null {
	switch (result.refusal) {
		case 'pin_mismatch':
			return MEGA_CONNECT_COPY.cliRefusedPinMismatch;
		case 'invalid_input':
			return fillMegaConnectCopy('cliRefusedInvalidInput', { reason: result.reason ?? 'empty' });
		case 'open_refused':
			return MEGA_CONNECT_COPY.cliRefusedOpen;
		case 'endpoint_failed':
			return MEGA_CONNECT_COPY.cliRefusedEndpointFailed;
		default:
			// endpoint_connect_unavailable: the card itself turns to the unavailable state.
			return null;
	}
}

/** The start input for `mode`, or the first field whose shape check fails. */
function buildInput(
	mode: FormMode,
	fields: FieldValues
): { ok: true; input: ConnectStartRequest } | { ok: false; field: MegaConnectFieldId } {
	if (mode === 'email') {
		const email = validateWorkEmail(fields.workEmail);
		return email.ok
			? { ok: true, input: { kind: 'email', email: email.value } }
			: { ok: false, field: 'workEmail' };
	}
	if (mode === 'joinLink') {
		const link = validateJoinLink(fields.joinLink);
		return link.ok
			? { ok: true, input: { kind: 'joinLink', joinLink: link.value.url } }
			: { ok: false, field: 'joinLink' };
	}
	const code = validateTeamCode(fields.teamCode);
	if (!code.ok) return { ok: false, field: 'teamCode' };
	const server = validateServerHost(fields.server);
	if (!server.ok) return { ok: false, field: 'server' };
	return { ok: true, input: { kind: 'teamCode', teamCode: code.value, server: server.value } };
}

function ActionButton({
	action,
	onClick,
	disabled,
	theme,
	primary = false,
}: {
	action: { id: string; label: string };
	onClick: () => void;
	disabled: boolean;
	theme: Theme;
	primary?: boolean;
}) {
	return (
		<button
			type="button"
			data-action={action.id}
			disabled={disabled}
			onClick={onClick}
			className="px-3 py-2 rounded border text-sm disabled:opacity-55"
			style={{
				borderColor: primary ? theme.colors.accent : theme.colors.border,
				backgroundColor: primary ? theme.colors.accent : theme.colors.bgActivity,
				color: primary ? theme.colors.accentForeground : theme.colors.textMain,
			}}
		>
			{action.label}
		</button>
	);
}

export function ConnectCard({ theme }: { theme: Theme }) {
	const api = typeof window !== 'undefined' ? window.maestro?.enterprise?.connect : undefined;
	const [current, setCurrent] = useState<ConnectStatusView>(UNAVAILABLE);
	const [form, setForm] = useState<FormMode | null>(null);
	const [fields, setFields] = useState<FieldValues>(EMPTY_FIELDS);
	const [invalid, setInvalid] = useState<MegaConnectFieldId | null>(null);
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const kindRef = useRef<MegaConnectStatus['kind']>(UNAVAILABLE.status.kind);

	useEffect(() => {
		if (!api) return;
		let cancelled = false;
		const take = (next: ConnectStatusView) => {
			if (cancelled) return;
			// A new state from main closes any form the person opened over the old one.
			if (kindRef.current !== next.status.kind) setForm(null);
			kindRef.current = next.status.kind;
			setCurrent(next);
		};
		void api.status().then(take, () => take(UNAVAILABLE));
		const offStatus = api.onStatus(take);
		const offPrefill = api.onPrefill((prefill: MegaConnectPrefill) => {
			if (cancelled) return;
			setInvalid(null);
			setRefusal(null);
			if (prefill.kind === 'join') {
				setFields((f) => ({
					...f,
					joinLink: `https://${prefill.server}/join/${prefill.code}`,
				}));
				setForm('joinLink');
			} else {
				setFields((f) => ({ ...f, teamCode: prefill.teamCode, server: prefill.server }));
				setForm('teamCode');
			}
		});
		return () => {
			cancelled = true;
			offStatus();
			offPrefill();
		};
	}, [api]);

	const live = current.status;
	const formOpen = form !== null && live.kind !== 'unavailable' && live.kind !== 'managed';
	const shown: MegaConnectStatus = formOpen
		? form === 'email'
			? { kind: 'notConnected' }
			: { kind: 'linkOrCode', mode: form }
		: live;
	const mode: FormMode = shown.kind === 'linkOrCode' ? shown.mode : 'email';
	const view = viewFor(shown);

	const send = async (input: ConnectStartRequest) => {
		if (!api || busy) return;
		setBusy(true);
		setRefusal(null);
		try {
			const result = await api.start(input);
			if (result.ok) {
				lastAcceptedInput = input;
				setForm(null);
				kindRef.current = result.value.status.kind;
				setCurrent(result.value);
			} else if (result.refusal === 'endpoint_connect_unavailable') {
				setForm(null);
				kindRef.current = 'unavailable';
				setCurrent(UNAVAILABLE);
			} else {
				setRefusal(refusalText(result));
			}
		} finally {
			setBusy(false);
		}
	};

	const connect = () => {
		const built = buildInput(mode, fields);
		if (!built.ok) {
			setInvalid(built.field);
			return;
		}
		setInvalid(null);
		void send(built.input);
	};

	const disconnect = async () => {
		if (!api || busy) return;
		setBusy(true);
		try {
			const result = await api.disconnect();
			if (result.ok) {
				forgetLastConnectInput();
				kindRef.current = result.value.status.kind;
				setCurrent(result.value);
			} else {
				setRefusal(refusalText(result));
			}
		} finally {
			setBusy(false);
		}
	};

	const openForm = (next: FormMode) => {
		setInvalid(null);
		setRefusal(null);
		setForm(next);
	};

	const run = (id: MegaConnectActionId) => {
		switch (id) {
			case 'connect':
				connect();
				return;
			case 'useLinkOrCode':
				openForm('joinLink');
				return;
			case 'openBrowserAgain':
				if (lastAcceptedInput) void send(lastAcceptedInput);
				return;
			case 'disconnect':
				void disconnect();
				return;
			case 'reconnect':
			case 'tryAgain':
			case 'connectAgain':
				openForm('email');
				return;
		}
	};

	const actionDisabled = (action: MegaConnectAction) =>
		!api || busy || (action.id === 'openBrowserAgain' && lastAcceptedInput === null);

	// In link-or-code mode the card offers the other code kind and the way back to email.
	const switches: Array<{ id: string; label: string; to: FormMode }> =
		shown.kind === 'linkOrCode'
			? [
					shown.mode === 'joinLink'
						? { id: 'useTeamCode', label: MEGA_CONNECT_COPY.useTeamCodeLink, to: 'teamCode' }
						: { id: 'useJoinLink', label: MEGA_CONNECT_COPY.useJoinLinkLink, to: 'joinLink' },
					{ id: 'useWorkEmail', label: MEGA_CONNECT_COPY.useWorkEmailLink, to: 'email' },
				]
			: [];

	return (
		<section
			aria-labelledby={view.title ? 'mega-connect-title' : undefined}
			aria-label={view.title ? undefined : MEGA_CONNECT_COPY.notConnectedTitle}
			data-testid="mega-connect-card"
			data-state={shown.kind}
			className="space-y-3 rounded border p-4"
			style={{ borderColor: theme.colors.border }}
		>
			{view.title ? (
				<h3 id="mega-connect-title" className="font-medium">
					{view.title}
				</h3>
			) : null}
			{view.body ? <p className="text-sm">{view.body}</p> : null}

			{view.showLargeNumber && view.largeNumber ? (
				<div
					role="group"
					aria-label={MEGA_CONNECT_COPY.largeNumberLabel}
					data-testid="mega-connect-number"
					className="text-5xl font-semibold tracking-widest tabular-nums"
				>
					{view.largeNumber}
				</div>
			) : null}

			{view.detail ? <p className="text-xs opacity-80">{view.detail}</p> : null}

			{FORM_STATES.has(shown.kind) && view.fields.length > 0 ? (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						connect();
					}}
				>
					{view.fields.map((field) => {
						const id = `mega-connect-${field.id}`;
						const hintId = `${id}-hint`;
						const bad = invalid === field.id;
						return (
							<div key={field.id} className="space-y-1">
								<label htmlFor={id} className="text-xs font-medium">
									{field.label}
								</label>
								<input
									id={id}
									type={FIELD_TYPES[field.id]}
									value={fields[field.id]}
									spellCheck={false}
									autoComplete={field.id === 'workEmail' ? 'email' : 'off'}
									aria-invalid={bad || undefined}
									aria-describedby={bad ? hintId : undefined}
									onChange={(event) => {
										const value = event.target.value;
										setFields((f) => ({ ...f, [field.id]: value }));
										if (bad) setInvalid(null);
									}}
									className="w-full px-2 py-1 rounded border text-sm"
									style={{
										borderColor: bad ? theme.colors.error : theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.textMain,
									}}
								/>
								{bad ? (
									<p id={hintId} className="text-xs" style={{ color: theme.colors.error }}>
										{FIELD_HINTS[field.id]}
									</p>
								) : null}
							</div>
						);
					})}
				</form>
			) : null}

			{refusal ? (
				<p role="status" className="text-xs" style={{ color: theme.colors.warning }}>
					{refusal}
				</p>
			) : null}

			<div className="flex flex-wrap items-center gap-2">
				{view.primaryAction ? (
					<ActionButton
						action={
							busy && view.primaryAction.id === 'connect'
								? { id: 'connect', label: MEGA_CONNECT_COPY.connectWorking }
								: view.primaryAction
						}
						onClick={() => run(view.primaryAction!.id)}
						disabled={actionDisabled(view.primaryAction)}
						theme={theme}
						primary
					/>
				) : null}
				{view.secondaryActions.map((action) => (
					<ActionButton
						key={action.id}
						action={action}
						onClick={() => run(action.id)}
						disabled={actionDisabled(action)}
						theme={theme}
					/>
				))}
				{switches.map((item) => (
					<ActionButton
						key={item.id}
						action={item}
						onClick={() => openForm(item.to)}
						disabled={busy}
						theme={theme}
					/>
				))}
			</div>
		</section>
	);
}
