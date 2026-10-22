/**
 * Transport admission - WHICH transport admitted the caller of a main-process
 * call, kept apart from WHO the caller is.
 *
 * Four things admit a socket to this server, and none of them is an
 * enterprise principal (MRC-08-01):
 *
 *   - the path token alone (`owner-token`): the URL is the credential, every
 *     browser that has it is the owner-operator;
 *   - a Web Login session cookie (`web-login`): local accounts, equal
 *     operators of one desktop, a sender's name for History and stats;
 *   - the per-boot CLI secret (`cli`): a process on this machine that can
 *     read `cli-server.json`, so `maestro-cli` and whatever an agent runs;
 *   - a Lite pairing credential (`lite`): a paired DEVICE, bound to this
 *     host's origin and revocable at once (see `lite/pairing`).
 *
 * Each is transport admission, not tenant IAM: it says the call may reach
 * this server, never which enterprise actor it acts as. The managed
 * authority binds the registered actor as the principal and records the
 * transport on the delegation chain as attribution, so a host sink has to
 * know the transport exactly. Until now only the Web Login account was in
 * scope (`acting-user.ts`), which read a `maestro-cli` call as the desktop
 * and a paired device as a Web Login account named `paired-device`.
 *
 * `runAsClient()` establishes both answers for one dispatch: the acting user
 * (unchanged, for attribution) and the admission (new, for the sinks). The
 * bridge wraps every `bridge.invoke` in it and the WebSocket message handler
 * wraps every message, so a sink deep in the main process asks
 * {@link getActingTransport} the way it asks `getActingUser()`. An Electron
 * renderer call runs outside any context and reads `desktop`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { WebActingUser } from '../../../shared/webLogin';
import type { ProcessSpawnActor } from '../../process-manager/types';
import type { WebClient } from '../types';
import { logger } from '../../utils/logger';
import { runAsActingUser } from './acting-user';

export type TransportAdmission =
	/** An Electron renderer IPC call: the operator at the keyboard. */
	| { kind: 'desktop' }
	/** A socket admitted by the path token alone (Web Login off, no account). */
	| { kind: 'owner-token' }
	/** A socket admitted by a Web Login session cookie. */
	| { kind: 'web-login'; user: WebActingUser }
	/** A socket that presented this boot's CLI secret on its upgrade. */
	| { kind: 'cli' }
	/** A socket admitted by a Lite pairing credential: a paired device. */
	| { kind: 'lite'; deviceId: string; deviceName: string };

export const DESKTOP_ADMISSION: TransportAdmission = Object.freeze({ kind: 'desktop' as const });

/**
 * The acting user the Lite connection route synthesizes for a paired device
 * (`routes/liteConnectionRoutes.ts`), so History and stats can name the
 * device. The id form is what {@link resolveTransportAdmission} reads the
 * device id back from; the username is a constant, never an account.
 */
export const PAIRED_DEVICE_USER_ID_PREFIX = 'paired-device:';
export const PAIRED_DEVICE_USERNAME = 'paired-device';

export type TransportClient = Pick<WebClient, 'cli' | 'user' | 'admission'>;

/**
 * Read the transport that admitted a socket off the client the upgrade built.
 * The CLI secret wins over a cookie (a CLI process may carry a browser's
 * cookie jar, a browser cannot present the secret); a device pairing is
 * recognized by the admission method the upgrade recorded, never by the shape
 * of the user it synthesized; a cookie-less, secret-less socket is the
 * owner-operator the path token admits.
 */
export function resolveTransportAdmission(client: TransportClient): TransportAdmission {
	if (client.cli === true) return { kind: 'cli' };
	if (client.admission === 'device-pairing') {
		const id = client.user?.id ?? '';
		return {
			kind: 'lite',
			deviceId: id.startsWith(PAIRED_DEVICE_USER_ID_PREFIX)
				? id.slice(PAIRED_DEVICE_USER_ID_PREFIX.length)
				: id,
			deviceName: client.user?.displayName ?? '',
		};
	}
	if (client.user) return { kind: 'web-login', user: client.user };
	return { kind: 'owner-token' };
}

/** One word for a log line: which transport, and for a login or a device, which one. */
export function describeTransportAdmission(admission: TransportAdmission): string {
	switch (admission.kind) {
		case 'web-login':
			return `web-login:${admission.user.username}`;
		case 'lite':
			return `lite-device:${admission.deviceId}`;
		default:
			return admission.kind;
	}
}

/**
 * The actor a host sink binds for a transport (MRC-08-01A): what
 * `ProcessManager.admitSpawn()` is handed, and what the spawn authority turns
 * into the verification's peer and the delegation chain's attribution. The
 * desktop renderer and the bare path token are both the owner-operator
 * (`in-process`); a Web Login cookie is the account it named; the CLI secret
 * is the host secret, so `maestro-cli` is never bound as the operator at the
 * keyboard; a Lite pairing is the device, never the `paired-device` account
 * the route synthesizes for History.
 */
export function transportSpawnActor(admission: TransportAdmission): ProcessSpawnActor {
	switch (admission.kind) {
		case 'web-login':
			return { peer: 'web-login', username: admission.user.username };
		case 'cli':
			return { peer: 'host-secret' };
		case 'lite':
			return { peer: 'device-pairing', deviceId: admission.deviceId };
		case 'desktop':
		case 'owner-token':
			return { peer: 'in-process' };
	}
}

/**
 * Whether two spawn actors are the same caller (MRC-08-02): the same peer,
 * and for a login the same account, for a device the same device. What a
 * sink that keeps a process across calls (the web terminal's PTY) compares
 * the caller of a later attach, write or resize against the actor the
 * process was admitted for. Subscription to the session is not part of it.
 */
export function sameSpawnActor(a: ProcessSpawnActor, b: ProcessSpawnActor): boolean {
	switch (a.peer) {
		case 'web-login':
			return b.peer === 'web-login' && b.username === a.username;
		case 'device-pairing':
			return b.peer === 'device-pairing' && b.deviceId === a.deviceId;
		case 'host-secret':
		case 'in-process':
			return b.peer === a.peer;
	}
}

/** One word for a message: which caller a spawn actor is. */
export function describeSpawnActor(actor: ProcessSpawnActor): string {
	switch (actor.peer) {
		case 'web-login':
			return `web-login:${actor.username}`;
		case 'host-secret':
			return 'maestro-cli';
		case 'device-pairing':
			return `lite-device:${actor.deviceId}`;
		case 'in-process':
			return 'the operator';
	}
}

const storage = new AsyncLocalStorage<TransportAdmission>();

/** Run `fn` with `admission` as the acting transport for every await inside it. */
export function runAsTransport<T>(admission: TransportAdmission, fn: () => T): T {
	return storage.run(admission, fn);
}

/** The transport the current call was admitted over, or `desktop` outside any context. */
export function getActingTransport(): TransportAdmission {
	return storage.getStore() ?? DESKTOP_ADMISSION;
}

/**
 * Run one dispatch from `client` with both answers in scope: the acting user
 * (`getActingUser()`, attribution) and the transport admission
 * (`getActingTransport()`, what a host sink binds). The one wrapper every
 * server entry point uses, so the two cannot disagree about a caller.
 */
export function runAsClient<T>(client: TransportClient, fn: () => T): T {
	return runAsActingUser(client.user, () => runAsTransport(resolveTransportAdmission(client), fn));
}

/**
 * Dispatch tickets (MRC-08-01B): the transport across the renderer round trip.
 *
 * A `send_command` the server receives is not spawned here. The handler hands
 * the prompt to the desktop renderer (`remote:executeCommand`), which builds
 * the spawn and sends it back over Electron IPC as `process:spawn`. No
 * AsyncLocalStorage survives that hop, so the sink read every such dispatch
 * as the desktop's own action: a `maestro-cli dispatch` or a paired phone's
 * prompt was admitted as the operator at the keyboard.
 *
 * The ticket closes the gap without trusting the renderer's word for the
 * transport. The handler, still inside the client context, ISSUES a ticket
 * bound to the agent (and tab, when one was named) it is dispatching to; the
 * renderer echoes the opaque string on the spawn config (and on a queued item,
 * so a dispatch that waits keeps it); the spawn handler CLAIMS it for the
 * agent and tab it is actually spawning. The ticket itself carries no actor:
 * it is a random key into this registry, and only the registry knows which
 * admission it stands for. It is single-use and bounded (a TTL and a cap on
 * outstanding tickets), and an unknown, expired, reused or mismatched ticket
 * is worth nothing: the sink falls back to the caller's OWN standing (an IPC
 * call outside any context, `in-process`), never to what the ticket claimed.
 */
export interface DispatchTicketTarget {
	/** The agent the dispatch is addressed to. */
	agentId: string;
	/** The tab it names, or undefined when the renderer picks the active one. */
	tabId?: string;
}

export interface DispatchTicketRegistryOptions {
	/** The clock, injected by tests. */
	now?: () => number;
	/** How long an issued ticket may wait to be claimed. */
	ttlMs?: number;
	/** How many unclaimed tickets may exist at once; the oldest are dropped past it. */
	maxOutstanding?: number;
}

export interface DispatchTicketRegistry {
	/** Mint a ticket for `admission`, bound to the dispatch target. */
	issue(admission: TransportAdmission, target: DispatchTicketTarget): string;
	/**
	 * Spend a ticket for the spawn being admitted. Returns the admission it was
	 * issued for, or undefined when the ticket is unknown, already spent,
	 * expired, or was issued for another agent or tab. Either way the ticket
	 * is gone afterwards: a mismatch burns it rather than leaving it to try again.
	 */
	claim(ticket: string, target: DispatchTicketTarget): TransportAdmission | undefined;
	/** Drop a ticket the dispatch it was issued for never reached the renderer. */
	withdraw(ticket: string): boolean;
	/** Unclaimed, unexpired tickets right now. */
	readonly size: number;
}

/** A dispatch has this long to reach the sink, queue included. */
export const DISPATCH_TICKET_TTL_MS = 15 * 60 * 1000;
/** Past this many unclaimed tickets, issuing another drops the oldest. */
export const DISPATCH_TICKET_MAX_OUTSTANDING = 256;

interface IssuedDispatchTicket extends DispatchTicketTarget {
	admission: TransportAdmission;
	expiresAt: number;
}

export function createDispatchTicketRegistry(
	options: DispatchTicketRegistryOptions = {}
): DispatchTicketRegistry {
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? DISPATCH_TICKET_TTL_MS;
	const maxOutstanding = options.maxOutstanding ?? DISPATCH_TICKET_MAX_OUTSTANDING;
	// Insertion-ordered, so the first key is always the oldest ticket.
	const tickets = new Map<string, IssuedDispatchTicket>();

	const sweepExpired = (): void => {
		const at = now();
		for (const [ticket, issued] of tickets) {
			if (issued.expiresAt <= at) tickets.delete(ticket);
		}
	};

	return {
		issue(admission, target) {
			sweepExpired();
			while (tickets.size >= maxOutstanding) {
				const oldest = tickets.keys().next();
				if (oldest.done) break;
				tickets.delete(oldest.value);
			}
			const ticket = randomBytes(24).toString('base64url');
			tickets.set(ticket, {
				admission,
				agentId: target.agentId,
				tabId: target.tabId,
				expiresAt: now() + ttlMs,
			});
			return ticket;
		},
		claim(ticket, target) {
			const issued = tickets.get(ticket);
			if (!issued) return undefined;
			tickets.delete(ticket);
			if (issued.expiresAt <= now()) return undefined;
			if (issued.agentId !== target.agentId) return undefined;
			if (issued.tabId !== undefined && issued.tabId !== target.tabId) return undefined;
			return issued.admission;
		},
		withdraw(ticket) {
			return tickets.delete(ticket);
		},
		get size() {
			sweepExpired();
			return tickets.size;
		},
	};
}

const dispatchTickets = createDispatchTicketRegistry();

/** Issue a ticket from the host's registry (see {@link DispatchTicketRegistry.issue}). */
export function issueDispatchTicket(
	admission: TransportAdmission,
	target: DispatchTicketTarget
): string {
	return dispatchTickets.issue(admission, target);
}

/** Claim a ticket at a spawn sink (see {@link DispatchTicketRegistry.claim}). */
export function claimDispatchTicket(
	ticket: string,
	target: DispatchTicketTarget
): TransportAdmission | undefined {
	return dispatchTickets.claim(ticket, target);
}

/** Withdraw a ticket whose dispatch the renderer refused (see {@link DispatchTicketRegistry.withdraw}). */
export function withdrawDispatchTicket(ticket: string): boolean {
	return dispatchTickets.withdraw(ticket);
}

const LOG_CONTEXT = '[TransportActor]';

/** What a sink hands {@link currentSpawnActor} to claim a dispatch ticket with. */
export interface DispatchTicketClaim {
	/** The ticket the request carried, as it arrived (unvalidated). */
	ticket: unknown;
	/** The agent being spawned (the base session id). */
	agentId: string;
	/** The tab being spawned into, when the request names one. */
	tabId?: string;
}

/**
 * Who is asking for this spawn, as the transport knows it (MRC-08-01A): a
 * bridge call or a WebSocket message runs inside the transport context
 * `runAsClient` established (a Web Login account, the CLI secret, a Lite
 * pairing, or the bare path token), an Electron IPC call from the desktop
 * renderer runs outside any and is the operator at the keyboard. This is
 * attribution the managed authority binds, never authority itself: none of
 * these transports is an enterprise principal. Read through
 * `transportSpawnActor`, never off the acting user, which still names a
 * paired device `paired-device` for History and gives the CLI no name at all.
 *
 * A spawn the renderer builds for a WebSocket dispatch (`send_command`)
 * arrives over Electron IPC, outside the transport context the dispatch was
 * admitted in. It carries the host-minted ticket the WS handler issued
 * instead (MRC-08-01B): `claim` spends it for the agent and tab actually
 * being spawned and binds the transport it was issued for. A ticket that is
 * unknown, already spent, expired, or issued for another agent or tab is
 * worth nothing, and the spawn binds the caller's own standing, never what
 * the ticket claimed. The ticket names no actor; only the host's registry
 * knows which admission it stood for.
 *
 * One function for every sink a renderer-relayed dispatch reaches: the
 * `process:spawn` handler (`ipc/handlers/process/handle-spawn.ts`), the web
 * terminal callback, the `cross-agent:send` consult handler, whose spawn
 * is the main-process consult runner rather than `process:spawn` and claims
 * the ticket `cross_agent_ask` issued for the target (MRC-08-01C), and the
 * `process:spawnTerminalTab` handler, where a desktop terminal tab a remote
 * `open_terminal_tab` created claims the ticket on its first spawn
 * (MRC-08-02A).
 */
export function currentSpawnActor(claim?: DispatchTicketClaim): ProcessSpawnActor {
	if (claim && typeof claim.ticket === 'string' && claim.ticket) {
		const issuedFor = claimDispatchTicket(claim.ticket, {
			agentId: claim.agentId,
			tabId: claim.tabId,
		});
		if (issuedFor) return transportSpawnActor(issuedFor);
		logger.warn(
			'Dispatch ticket not honored (unknown, spent, expired or mismatched); binding the caller as itself',
			LOG_CONTEXT,
			{ agentId: claim.agentId, tabId: claim.tabId }
		);
	}
	return transportSpawnActor(getActingTransport());
}
