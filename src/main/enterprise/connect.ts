/**
 * The connect service: Connect to your organization, in main.
 *
 * It validates every input with the contracts 0.5.0 connect rules in
 * `megaConnect/input.ts` (the connect* functions),
 * talks to a ConnectPort (Maestro's own boundary, `megaConnect/port.ts`), opens
 * the approval page only through the local-effects hold and only on the server
 * the request went to, polls the status (every 3 seconds while a request is
 * open, every 60 seconds otherwise), and turns each change into at most one OS
 * notification through `megaConnect/notify.ts`.
 *
 * With no port bound (no Mega adapter yet, or an endpoint that does not
 * advertise the connect operations) start and disconnect refuse with
 * `endpoint_connect_unavailable` and the status is `unavailable`.
 *
 * Every refusal start or disconnect answers is noted, by code alone, in a
 * 50-entry in-memory history the Copy diagnostics bundle reads
 * (`connect-diagnostics.ts`, MSX-03-04).
 *
 * Logging rule: only state names reach the log. The matching number, the
 * request reference, the approval URL, a join code and the socket path never do.
 */

import { logger } from '../utils/logger';
import type { Redacted } from '../../shared/megaConnect/diagnostics';
import { resolveEndpointSocket, type ResolvedEndpointSocket } from '../../shared/megaServer';
import { buildConnectDiagnostics, createConnectRefusalHistory } from './connect-diagnostics';
import { canonicalJson } from '../../shared/canonicalJson';
import {
	connectJoinLink,
	connectServerHost,
	connectTeamCode,
	connectWorkEmail,
	type MegaConnectInputReason,
} from '../../shared/megaConnect/input';
import {
	createMegaConnectNotifier,
	type MegaConnectNotification,
} from '../../shared/megaConnect/notify';
import type { MegaConnectStatus } from '../../shared/megaConnect/view';
import type {
	ConnectDisplayNames,
	ConnectPort,
	ConnectStartInput,
} from '../../shared/megaConnect/port';
import {
	callingLocalEffectActor,
	holdLocalEffect,
	type LocalEffectActor,
	type LocalEffectAuthority,
} from './local-effects-policy';

const LOG_CONTEXT = 'MegaConnect';

/** Poll interval while a request waits on a person (browser opened, waiting). */
export const CONNECT_POLL_WAITING_MS = 3_000;
/** Poll interval in every other state. */
export const CONNECT_POLL_IDLE_MS = 60_000;

export type ConnectRefusal =
	/** No port is bound: the endpoint cannot connect. */
	| 'endpoint_connect_unavailable'
	/** The approval URL is not https, or not on the server the request went to. */
	| 'pin_mismatch'
	/** The input failed its shape check; `reason` names the rule, never the value. */
	| 'invalid_input'
	/** The local-effects hold refused opening the browser. */
	| 'open_refused'
	/** The port threw; the message is not passed on, it may carry a value. */
	| 'endpoint_failed';

export type ConnectResult<T> =
	| { ok: true; value: T }
	| { ok: false; refusal: ConnectRefusal; reason?: MegaConnectInputReason };

export interface ConnectStatusView {
	status: MegaConnectStatus;
	names?: ConnectDisplayNames;
}

/** Cancels a timer set with `setTimer`. */
export type CancelTimer = () => void;

export interface ConnectServiceDeps {
	/** The bound port, a getter for it, or null when none is bound. */
	port: ConnectPort | null | (() => ConnectPort | null);
	/** The local-effects authority every OS hand-off is held by. */
	localEffects: LocalEffectAuthority | null;
	/** Delivers an OS notification (the helper `ipc/handlers/notifications.ts` uses). */
	notify: (notification: MegaConnectNotification) => void;
	/** Opens a URL outside Maestro; called only after the hold allowed it. */
	openExternal: (url: string) => Promise<void>;
	now?: () => number;
	/**
	 * What the diagnostics bundle reads beyond the service's own state: the app
	 * version and the endpoint socket in use. Absent: no app version, and the
	 * platform's standard socket.
	 */
	diagnostics?: { appVersion: string | null; socket: () => ResolvedEndpointSocket };
	setTimer?: (fn: () => void, ms: number) => CancelTimer;
}

export interface ConnectService {
	/** Validate `raw`, open a connect request, and open its approval page. */
	start(raw: unknown, actor?: LocalEffectActor): Promise<ConnectResult<ConnectStatusView>>;
	/** Poll the port now and answer the current status. */
	status(): Promise<ConnectStatusView>;
	/** The last known status, without asking the port. */
	current(): ConnectStatusView;
	disconnect(): Promise<ConnectResult<ConnectStatusView>>;
	/**
	 * Note a refusal a caller answered before the service saw the input (the
	 * handlers' own validation), so the history holds it too. Code only.
	 */
	noteRefusal(refusal: ConnectRefusal): void;
	/** The refusal codes of this app session, oldest first, at most 50. */
	refusals(): ConnectRefusal[];
	/** The redacted Copy diagnostics bundle (`connect-diagnostics.ts`). */
	diagnostics(): Promise<Redacted>;
	/** Called with every status change; returns an unsubscribe function. */
	onChange(listener: (view: ConnectStatusView) => void): () => void;
	/** Start the poll loop (start() starts it too). */
	watch(): void;
	/** Stop the poll loop and drop the listeners. */
	dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(raw: Record<string, unknown>, key: string): string | null {
	const value = raw[key];
	return typeof value === 'string' ? value : null;
}

/**
 * Validate a renderer, bridge or CLI start input into a ConnectStartInput by the
 * contracts 0.5.0 connect schemas (the shape checks are only the renderer hint).
 * Accepts `{kind:'email', email}`, `{kind:'joinLink', joinLink}`,
 * `{kind:'teamCode', teamCode, server}` and `{kind:'managed'}`. A rejection
 * names its rule and never carries the value.
 */
export function parseConnectStartInput(
	raw: unknown
): { ok: true; value: ConnectStartInput } | { ok: false; reason: MegaConnectInputReason } {
	if (!isRecord(raw)) return { ok: false, reason: 'empty' };
	switch (raw.kind) {
		case 'email': {
			const checked = connectWorkEmail(stringField(raw, 'email') ?? '');
			return checked.ok ? { ok: true, value: { kind: 'email', email: checked.value } } : checked;
		}
		case 'joinLink': {
			const checked = connectJoinLink(stringField(raw, 'joinLink') ?? '');
			return checked.ok
				? { ok: true, value: { kind: 'joinLink', joinLink: checked.value } }
				: checked;
		}
		case 'teamCode': {
			const code = connectTeamCode(stringField(raw, 'teamCode') ?? '');
			if (!code.ok) return code;
			const server = connectServerHost(stringField(raw, 'server') ?? '');
			if (!server.ok) return server;
			return { ok: true, value: { kind: 'teamCode', teamCode: code.value, server: server.value } };
		}
		case 'managed':
			return { ok: true, value: { kind: 'managed' } };
		default:
			return { ok: false, reason: 'empty' };
	}
}

function hostOf(host: string): string {
	return host
		.trim()
		.replace(/^\[(.*)\]$/, '$1')
		.toLowerCase();
}

/**
 * Whether `approvalUrl` may be opened: https, no credentials, and on `server`.
 * When the person named a server (a join link, a team code), the endpoint's
 * server must also be that one (AR-7, AR-15).
 */
export function approvalUrlMatchesServer(
	approvalUrl: string,
	server: string,
	requested: string | null
): boolean {
	let url: URL;
	try {
		url = new URL(approvalUrl);
	} catch {
		return false;
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
	const expected = hostOf(server);
	if (expected.length === 0 || hostOf(url.hostname) !== expected) return false;
	return requested === null || hostOf(requested) === expected;
}

function requestedServer(input: ConnectStartInput): string | null {
	if (input.kind === 'joinLink') return input.joinLink.host;
	if (input.kind === 'teamCode') return input.server;
	return null;
}

const OPEN_STATES = new Set<MegaConnectStatus['kind']>(['browserOpened', 'waiting']);

function defaultSetTimer(fn: () => void, ms: number): CancelTimer {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
}

export function createConnectService(deps: ConnectServiceDeps): ConnectService {
	const setTimer = deps.setTimer ?? defaultSetTimer;
	const portOf = (): ConnectPort | null =>
		typeof deps.port === 'function' ? deps.port() : deps.port;
	const notifier = createMegaConnectNotifier();
	const refusalHistory = createConnectRefusalHistory();
	const refuse = <T>(result: ConnectResult<T>): ConnectResult<T> => {
		if (!result.ok) refusalHistory.note(result.refusal);
		return result;
	};
	const listeners = new Set<(view: ConnectStatusView) => void>();
	let view: ConnectStatusView = {
		status: portOf() ? { kind: 'notConnected' } : { kind: 'unavailable' },
	};
	let lastKey = canonicalJson(view);
	let cancelTimer: CancelTimer | null = null;
	let watching = false;

	const apply = (next: ConnectStatusView): ConnectStatusView => {
		const key = canonicalJson(next);
		if (key === lastKey) return view;
		const previousKind = view.status.kind;
		view = next;
		lastKey = key;
		if (previousKind !== next.status.kind) {
			logger.info(`connect state ${previousKind} to ${next.status.kind}`, LOG_CONTEXT);
		}
		const notification = notifier.observe(next.status);
		if (notification) deps.notify(notification);
		for (const listener of listeners) listener(view);
		return view;
	};

	const schedule = () => {
		cancelTimer?.();
		cancelTimer = null;
		if (!watching) return;
		const ms = OPEN_STATES.has(view.status.kind) ? CONNECT_POLL_WAITING_MS : CONNECT_POLL_IDLE_MS;
		cancelTimer = setTimer(() => {
			void poll().finally(schedule);
		}, ms);
	};

	const poll = async (): Promise<ConnectStatusView> => {
		const port = portOf();
		if (!port) return apply({ status: { kind: 'unavailable' } });
		try {
			const answer = await port.status();
			return apply(
				answer.names ? { status: answer.status, names: answer.names } : { status: answer.status }
			);
		} catch {
			logger.warn('connect status poll failed', LOG_CONTEXT);
			return apply({ status: { kind: 'unavailable' } });
		}
	};

	const watch = () => {
		if (watching) return;
		watching = true;
		schedule();
	};

	const start = async (
		raw: unknown,
		effectActor: LocalEffectActor
	): Promise<ConnectResult<ConnectStatusView>> => {
		const parsed = parseConnectStartInput(raw);
		if (!parsed.ok) return { ok: false, refusal: 'invalid_input', reason: parsed.reason };
		const port = portOf();
		if (!port) {
			apply({ status: { kind: 'unavailable' } });
			return { ok: false, refusal: 'endpoint_connect_unavailable' };
		}
		let result;
		try {
			result = await port.start(parsed.value);
		} catch {
			logger.warn(`connect start failed (${parsed.value.kind})`, LOG_CONTEXT);
			return { ok: false, refusal: 'endpoint_failed' };
		}
		if (
			!approvalUrlMatchesServer(result.approvalUrl, result.server, requestedServer(parsed.value))
		) {
			logger.warn('connect approval page refused: not on the request server', LOG_CONTEXT);
			return { ok: false, refusal: 'pin_mismatch' };
		}
		const decision = await holdLocalEffect(deps.localEffects, {
			effect: 'open-external',
			actor: effectActor,
			target: result.approvalUrl,
		});
		if (!decision.allowed) {
			logger.warn(
				`connect approval page refused by the local-effects hold (${decision.code})`,
				LOG_CONTEXT
			);
			return { ok: false, refusal: 'open_refused' };
		}
		await deps.openExternal(result.approvalUrl);
		const opened = apply({
			status: {
				kind: 'browserOpened',
				matchNumber: result.number,
				request: result.requestNumber,
				serverName: hostOf(result.server),
			},
			names: { server: hostOf(result.server) },
		});
		watch();
		schedule();
		return { ok: true, value: opened };
	};

	const disconnect = async (): Promise<ConnectResult<ConnectStatusView>> => {
		const port = portOf();
		if (!port) {
			apply({ status: { kind: 'unavailable' } });
			return { ok: false, refusal: 'endpoint_connect_unavailable' };
		}
		try {
			await port.disconnect();
		} catch {
			logger.warn('connect disconnect failed', LOG_CONTEXT);
			return { ok: false, refusal: 'endpoint_failed' };
		}
		const after = apply({ status: { kind: 'notConnected' } });
		schedule();
		return { ok: true, value: after };
	};

	return {
		// Read the calling transport before any await, so the hold binds that actor.
		start: async (raw, actor) => refuse(await start(raw, actor ?? callingLocalEffectActor())),
		status: poll,
		current: () => view,
		disconnect: async () => refuse(await disconnect()),
		noteRefusal: (refusal) => refusalHistory.note(refusal),
		refusals: () => refusalHistory.list(),
		diagnostics: () =>
			buildConnectDiagnostics({
				status: view,
				refusals: refusalHistory.list(),
				appVersion: deps.diagnostics?.appVersion ?? null,
				socket: deps.diagnostics?.socket() ?? resolveEndpointSocket('', process.platform),
				certificateExpiry: null,
				now: (deps.now ?? Date.now)(),
			}),
		onChange(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		watch,
		dispose() {
			watching = false;
			cancelTimer?.();
			cancelTimer = null;
			listeners.clear();
		},
	};
}
