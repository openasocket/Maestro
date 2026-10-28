/**
 * The listener ceiling a managed desktop holds its inbound surfaces to
 * (MRC2-05-06). The egress ceiling holds what leaves this machine; this one
 * holds what may LISTEN on it. Every socket Maestro opens for others to reach,
 * and every tunnel that publishes one, is a listener of a closed KIND: `web`
 * (the fastify server behind maestro-cli and Live Mode), `tunnel` (the
 * cloudflared quick tunnel that puts that server on the Internet),
 * `ssh-tunnel` (the loopback forward a Lite client opens with `ssh -L` to
 * reach a host: the opposite direction, so never the cloudflared kind),
 * `lite-control` (the Lite client's OS-local control endpoint behind
 * `maestro-cli lite`), `tailnet` (the Lite host's direct listener on a
 * Tailscale or a LAN interface) and `mdns` (its discovery advertisement),
 * `cue-webhook` and `cue-status` (the Cue engine's webhook receiver and its
 * loopback status server), `relay` (the permission relay bridge), `steering`
 * (the maestro-p steering socket) and `coworking` (the coworking MCP server).
 * A sink names its kind, the address it is about to bind and the port; the
 * policy answers BEFORE the bind, so a forbidden listener never exists for
 * even a moment.
 *
 * What the ceiling says of a kind is how far a socket of that kind may REACH:
 * `loopback` (this machine only), `tailnet` (a Tailscale address), `lan` (one
 * named interface of the local network), `any` (every interface) or `public`
 * (the Internet, which only a tunnel ever is). The reach a request has is
 * read from the bind address (`listenerReach()`); a `tunnel` is `public`
 * whatever local target it forwards to, and an OS-local endpoint (a Unix
 * socket path, a Windows named pipe) is `loopback`. A kind the ceiling does not list may
 * not bind at all; a listed kind binds only as far as its entry reaches, so a
 * policy that lists `web` at `loopback` keeps the CLI server and refuses Live
 * Mode's `0.0.0.0` by name. Standalone nothing here is consulted and every
 * listener binds as it always has. Every refusal is named by a stable code so
 * it never reads as a port collision or a network failure.
 *
 * `parseListenerPolicyCeiling()` validates a closed, bounded document;
 * `listenerVerdict()` is the pure decision (standalone: allowed, no receipt);
 * `createListenerPolicySource()` holds the one installed ceiling, in memory
 * only, under the enrollment rule the spawn authority uses, and is what
 * `setListenerAuthority()` (`listener-gate.ts`, the leaf the sinks import)
 * installs at app-ready. Listeners are opened by the desktop for the person
 * who runs it (at boot, from the Live Mode toggle, from the Lite pairing
 * window), never for a paired device or an agent, so a request carries no
 * actor. No endpoint operation of this build carries a listener ceiling
 * (CP-01), so nothing calls `install()` and an enrolled desktop refuses every
 * listener `unavailable` by name.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import { isPlainObject, unknownKeys } from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';

export {
	ListenerDeniedError,
	heldListeners,
	holdListener,
	isListenerDeniedError,
	listenerHoldFor,
	setListenerAuthority,
	type ListenerHold,
} from './listener-gate';

/** What a socket is for. Closed on purpose: a sink picks one, it never invents one. */
export const LISTENER_KINDS = [
	'web',
	'tunnel',
	'ssh-tunnel',
	'lite-control',
	'tailnet',
	'mdns',
	'cue-webhook',
	'cue-status',
	'relay',
	'steering',
	'coworking',
] as const;
export type ListenerKind = (typeof LISTENER_KINDS)[number];

/** How far a socket can be reached, narrowest first; an entry admits its reach and every narrower one. */
export const LISTENER_REACHES = ['loopback', 'tailnet', 'lan', 'any', 'public'] as const;
export type ListenerReach = (typeof LISTENER_REACHES)[number];

export interface ListenerRequest {
	kind: ListenerKind;
	/** The address the sink is about to bind (`127.0.0.1`, `0.0.0.0`, a tailnet or LAN address); a tunnel names its local target. */
	bind: string;
	/** The port the sink asked for; 0 when the OS picks one. */
	port: number;
}

export interface ListenerCeilingEntry {
	kind: ListenerKind;
	/** The widest reach a listener of this kind may have. */
	reach: ListenerReach;
}

export interface ListenerPolicyCeiling {
	policyRevision: number;
	/** A kind absent here may not bind at all. */
	listeners: ListenerCeilingEntry[];
}

const CEILING_KEYS = ['policyRevision', 'listeners'] as const;
const ENTRY_KEYS = ['kind', 'reach'] as const;

export function isListenerKind(value: unknown): value is ListenerKind {
	return (LISTENER_KINDS as readonly unknown[]).includes(value);
}

export function isListenerReach(value: unknown): value is ListenerReach {
	return (LISTENER_REACHES as readonly unknown[]).includes(value);
}

/** Tailscale's CGNAT range (100.64.0.0/10) and its IPv6 prefix (fd7a:115c:a1e0::/48). */
function isTailnetAddress(address: string): boolean {
	const v4 = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
	if (v4) {
		const second = Number(v4[1]);
		return second >= 64 && second <= 127;
	}
	return /^fd7a:115c:a1e0:/i.test(address);
}

/** A Unix socket path or a Windows named pipe: an endpoint only a process on this machine can open. */
export function isOsLocalEndpoint(bind: string): boolean {
	return bind.startsWith('/') || /^(\\\\|\/\/)[.?][\\/]pipe[\\/]/i.test(bind);
}

/**
 * How far a socket bound at `bind` can be reached. The empty string, `0.0.0.0`
 * and `::` are every interface; `localhost`, `127.0.0.0/8`, `::1` and an
 * OS-local endpoint are this machine; a Tailscale address is the tailnet; any
 * other address is one interface of the local network. A tunnel is public
 * whatever it forwards to.
 */
export function listenerReach(kind: ListenerKind, bind: string): ListenerReach {
	if (kind === 'tunnel') return 'public';
	if (isOsLocalEndpoint(bind)) return 'loopback';
	const address = bind
		.trim()
		.replace(/^\[|\]$/g, '')
		.toLowerCase();
	const unscoped = address.replace(/%.*$/, '');
	if (unscoped === '' || unscoped === '0.0.0.0' || unscoped === '::' || unscoped === '::0')
		return 'any';
	if (
		unscoped === 'localhost' ||
		unscoped === '::1' ||
		/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(unscoped)
	)
		return 'loopback';
	if (/^::ffff:127\./.test(unscoped)) return 'loopback';
	if (isTailnetAddress(unscoped.replace(/^::ffff:/, ''))) return 'tailnet';
	return 'lan';
}

/** True when a socket reaching `reach` stays within an entry that admits `admitted`. */
export function reachWithin(reach: ListenerReach, admitted: ListenerReach): boolean {
	return LISTENER_REACHES.indexOf(reach) <= LISTENER_REACHES.indexOf(admitted);
}

export type ListenerCeilingParse =
	| { ok: true; ceiling: ListenerPolicyCeiling }
	| { ok: false; problems: readonly string[] };

function parseEntry(raw: unknown, at: string, problems: string[]): ListenerCeilingEntry | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, ENTRY_KEYS, `${at}.`));
	const before = problems.length;
	if (!isListenerKind(raw.kind)) problems.push(`${at}.kind is not a listener kind`);
	if (!isListenerReach(raw.reach)) problems.push(`${at}.reach is not a listener reach`);
	else if (raw.reach === 'public' && raw.kind !== 'tunnel')
		problems.push(`${at}.reach "public" is only for the tunnel kind`);
	if (problems.length !== before) return null;
	return { kind: raw.kind as ListenerKind, reach: raw.reach as ListenerReach };
}

/**
 * Validate a listener ceiling document. The result is a fresh value the
 * caller's input can no longer reach; every problem is named by its path, and
 * one problem refuses the whole document.
 */
export function parseListenerPolicyCeiling(raw: unknown): ListenerCeilingParse {
	if (!isPlainObject(raw))
		return { ok: false, problems: ['the listener ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const listeners: ListenerCeilingEntry[] = [];
	if (!Array.isArray(raw.listeners)) problems.push('listeners is not an array');
	else if (raw.listeners.length > LISTENER_KINDS.length)
		problems.push(`listeners exceeds ${LISTENER_KINDS.length} entries`);
	else
		raw.listeners.forEach((entry, index) => {
			const parsed = parseEntry(entry, `listeners[${index}]`, problems);
			if (parsed && listeners.some((seen) => seen.kind === parsed.kind))
				problems.push(`listeners[${index}].kind "${parsed.kind}" is named twice`);
			else if (parsed) listeners.push(parsed);
		});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, ceiling: { policyRevision: raw.policyRevision as number, listeners } };
}

export type ManagedListenerStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: ListenerPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedEgressStanding`, for the listener ceiling. */
export function managedListenerStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: ListenerPolicyCeiling | null;
}): ManagedListenerStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no listener ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed listener ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type ListenerDenial = 'unavailable' | 'kind-denied' | 'reach-denied';

export interface ListenerReceipt {
	policyRevision: number | null;
	kind: ListenerKind;
	bind: string;
	port: number;
	reach: ListenerReach;
	outcome: 'within-ceiling' | ListenerDenial;
}

export type ListenerDecision =
	| { allowed: true; managed?: ListenerReceipt }
	| { allowed: false; code: ListenerDenial; message: string; managed: ListenerReceipt };

/**
 * Hold one listener against the standing. Pure. A kind the ceiling does not
 * list may not bind; a listed kind binds only as far as its entry reaches.
 */
export function listenerVerdict(
	standing: ManagedListenerStanding,
	request: ListenerRequest
): ListenerDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const reach = listenerReach(request.kind, request.bind);
	const where = `${request.bind || '*'}:${request.port}`;
	const receipt = (outcome: ListenerReceipt['outcome']): ListenerReceipt => ({
		policyRevision: standing.policyRevision,
		kind: request.kind,
		bind: request.bind,
		port: request.port,
		reach,
		outcome,
	});
	const deny = (code: ListenerDenial, message: string): ListenerDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (!standing.ceiling)
		return deny(
			'unavailable',
			`the managed listener ceiling is unavailable (${standing.reason}); the ${request.kind} listener on ${where} is not opened`
		);
	const entry = standing.ceiling.listeners.find((candidate) => candidate.kind === request.kind);
	if (!entry)
		return deny(
			'kind-denied',
			`the listener ceiling admits no ${request.kind} listener; the ${request.kind} listener on ${where} is opened only when the policy lists the kind`
		);
	if (!reachWithin(reach, entry.reach))
		return deny(
			'reach-denied',
			`the listener ceiling admits a ${request.kind} listener as far as ${entry.reach}; ${where} reaches ${reach} and is not opened`
		);
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type ListenerCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface ListenerPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a sink holds a listener with: the source, or a test double. */
export interface ListenerAuthority {
	evaluateListener(request: ListenerRequest): ListenerDecision;
}

export interface ListenerPolicySource extends ListenerAuthority {
	standing(): ManagedListenerStanding;
	installed(): ListenerPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): ListenerCeilingInstallOutcome;
	clear(): void;
}

export function createListenerPolicySource(deps: ListenerPolicySourceDeps): ListenerPolicySource {
	let installed: ListenerPolicyCeiling | null = null;
	const standing = () =>
		managedListenerStanding({
			enrolled: deps.identity.read().status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing,
		installed: () => installed,
		install(raw) {
			const parsed = parseListenerPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		evaluateListener(request) {
			return listenerVerdict(standing(), request);
		},
	};
}
