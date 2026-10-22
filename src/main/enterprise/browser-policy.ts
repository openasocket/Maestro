/**
 * The browser ceiling a managed desktop holds browser and coworking effects
 * to (MRC-09-04): the remote browser relay (`src/main/browser/browser-relay.ts`)
 * and the coworking bridge (`src/main/coworking/coworking-bridge.ts`). Each
 * effect is a `view` (a frame, a list, a URL), a `read` (content leaving the
 * host), a `navigate`, an `input`, an `execute` (script in the page) or a
 * `clear` (the tab's data), and under management each is held, by itself,
 * against the signed ceiling of the policy revision the host is under: a
 * lease or a listed tab is never a permit for the next effect, and the local
 * gates (caps, input validation, the interaction toggle, the renderer's
 * confirmations, the URL scheme allowlists) run first and are never replaced.
 * `parseBrowserPolicyCeiling()` validates a document against a closed, bounded
 * schema; `browserEffectVerdict()` is the pure decision (standalone: allowed,
 * no receipt); `createBrowserPolicySource()` holds the one installed ceiling,
 * in memory only, under the enrollment rule the spawn authority uses. No
 * endpoint operation of this build carries a browser ceiling (CP-01), so
 * nothing calls `install()` and an enrolled desktop refuses every effect
 * `unavailable` by name.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import type { ProcessSpawnActor } from '../process-manager/types';
import { describeSpawnActor } from '../web-server/auth/transport-actor';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

export const BROWSER_EFFECTS = ['view', 'read', 'navigate', 'input', 'execute', 'clear'] as const;
export type BrowserEffectKind = (typeof BROWSER_EFFECTS)[number];

/** Who performs an effect, as the ceiling names them. */
export const BROWSER_ACTORS = [
	'operator',
	'web-login',
	'maestro-cli',
	'lite-device',
	'agent',
] as const;
export type BrowserActorKind = (typeof BROWSER_ACTORS)[number];

const TRANSPORT_ACTOR_KINDS: Record<ProcessSpawnActor['peer'], BrowserActorKind> = {
	'in-process': 'operator',
	'web-login': 'web-login',
	'host-secret': 'maestro-cli',
	'device-pairing': 'lite-device',
};

export type BrowserEffectActor =
	/** The relay: the transport the bridge admitted the client over. */
	| { kind: 'transport'; actor: ProcessSpawnActor }
	/** The coworking bridge: the agent session the handshake bound. */
	| { kind: 'agent'; sessionId: string; agentType: string | null };

export interface BrowserEffectRequest {
	surface: 'relay' | 'coworking';
	effect: BrowserEffectKind;
	actor: BrowserEffectActor;
	/** A page effect is held against its destination; a session effect (a list, a terminal) has none. */
	resource: 'page' | 'session';
	/** The URL the effect navigates to, or the page as the host last observed it; null when unknown. */
	destination: string | null;
}

export interface BrowserCeilingActor {
	actor: BrowserActorKind;
	effects: BrowserEffectKind[];
}

export interface BrowserPolicyCeiling {
	policyRevision: number;
	/** An actor kind absent here performs no browser effect at all. */
	actors: BrowserCeilingActor[];
	/** Origin patterns (`*`, `about:blank`, `[scheme://][*.]host[:port]`); `allow` absent admits what `deny` does not name. */
	destinations?: { allow?: string[]; deny?: string[] };
}

export const BROWSER_CEILING_LIMITS = { actors: 16, patterns: 256, patternLength: 1024 } as const;

const CEILING_KEYS = ['policyRevision', 'actors', 'destinations'] as const;
const ACTOR_KEYS = ['actor', 'effects'] as const;
const DESTINATION_KEYS = ['allow', 'deny'] as const;
const PATTERN_RE =
	/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

export type BrowserCeilingParse =
	| { ok: true; ceiling: BrowserPolicyCeiling }
	| { ok: false; problems: readonly string[] };

/** Shared with the repository ceiling (`repository-policy.ts`): the same closed-schema helpers. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const unknownKeys = (value: object, known: readonly string[], at: string): string[] =>
	Object.keys(value)
		.filter((key) => !known.includes(key))
		.map((key) => `${at}${key} is not a known key`);

/** `*`, `about:blank`, or `[scheme://][*.]host[:port]`. */
export function isBrowserDestinationPattern(pattern: string): boolean {
	return (
		pattern.length <= BROWSER_CEILING_LIMITS.patternLength &&
		(pattern === '*' || pattern === 'about:blank' || PATTERN_RE.test(pattern))
	);
}

/** A bounded list of strings each `accept`s; every bad member is a problem, and a bad list is null. */
export function parseStringList(
	raw: unknown,
	at: string,
	max: number,
	what: string,
	accept: (value: string) => boolean,
	problems: string[]
): string[] | null {
	if (!Array.isArray(raw)) {
		problems.push(`${at} is not an array`);
		return null;
	}
	if (raw.length > max) {
		problems.push(`${at} exceeds ${max} entries`);
		return null;
	}
	const out: string[] = [];
	raw.forEach((value, index) => {
		if (typeof value === 'string' && value.length > 0 && accept(value)) out.push(value);
		else problems.push(`${at}[${index}] is not ${what}`);
	});
	return out;
}

function parseActor(raw: unknown, at: string, problems: string[]): BrowserCeilingActor | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, ACTOR_KEYS, `${at}.`));
	const before = problems.length;
	if (!(BROWSER_ACTORS as readonly unknown[]).includes(raw.actor))
		problems.push(`${at}.actor is not a browser actor kind`);
	const effects = parseStringList(
		raw.effects,
		`${at}.effects`,
		BROWSER_EFFECTS.length,
		'a browser effect kind',
		(value) => (BROWSER_EFFECTS as readonly string[]).includes(value),
		problems
	);
	if (problems.length !== before || !effects) return null;
	return { actor: raw.actor as BrowserActorKind, effects: effects as BrowserEffectKind[] };
}

/**
 * Validate a browser ceiling document. The result is a fresh value the
 * caller's input can no longer reach; every problem is named by its path,
 * and one problem refuses the whole document.
 */
export function parseBrowserPolicyCeiling(raw: unknown): BrowserCeilingParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the browser ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const actors: BrowserCeilingActor[] = [];
	if (!Array.isArray(raw.actors)) problems.push('actors is not an array');
	else if (raw.actors.length > BROWSER_CEILING_LIMITS.actors)
		problems.push(`actors exceeds ${BROWSER_CEILING_LIMITS.actors} entries`);
	else
		raw.actors.forEach((entry, index) => {
			const parsed = parseActor(entry, `actors[${index}]`, problems);
			if (parsed && actors.some((seen) => seen.actor === parsed.actor))
				problems.push(`actors[${index}].actor "${parsed.actor}" is named twice`);
			else if (parsed) actors.push(parsed);
		});
	let destinations: BrowserPolicyCeiling['destinations'];
	if (raw.destinations !== undefined && !isPlainObject(raw.destinations))
		problems.push('destinations is not an object');
	else if (raw.destinations !== undefined) {
		problems.push(...unknownKeys(raw.destinations, DESTINATION_KEYS, 'destinations.'));
		destinations = {};
		for (const key of DESTINATION_KEYS) {
			if (raw.destinations[key] === undefined) continue;
			const parsed = parseStringList(
				raw.destinations[key],
				`destinations.${key}`,
				BROWSER_CEILING_LIMITS.patterns,
				'a destination pattern',
				isBrowserDestinationPattern,
				problems
			);
			if (parsed) destinations[key] = parsed;
		}
	}
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: {
			policyRevision: raw.policyRevision as number,
			actors,
			...(destinations ? { destinations } : {}),
		},
	};
}

export type ManagedBrowserStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: BrowserPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedPluginStanding`, for the browser ceiling. */
export function managedBrowserStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: BrowserPolicyCeiling | null;
}): ManagedBrowserStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no browser ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed browser ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type BrowserEffectDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'outside-ceiling'
	| 'destination-denied'
	| 'destination-unknown';

export interface BrowserEffectReceipt {
	policyRevision: number | null;
	surface: BrowserEffectRequest['surface'];
	actor: string;
	effect: BrowserEffectKind;
	/** The destination's origin only; never a path, query or fragment. */
	destination: string | null;
	outcome: 'within-ceiling' | BrowserEffectDenial;
}

export type BrowserEffectDecision =
	| { allowed: true; managed?: BrowserEffectReceipt }
	| { allowed: false; code: BrowserEffectDenial; message: string; managed: BrowserEffectReceipt };

/** The ceiling's kind for an actor and a label for a message. */
export function browserActorLabel(actor: BrowserEffectActor): [BrowserActorKind, string] {
	if (actor.kind === 'agent')
		return ['agent', `agent ${actor.sessionId}${actor.agentType ? ` (${actor.agentType})` : ''}`];
	return [TRANSPORT_ACTOR_KINDS[actor.actor.peer], describeSpawnActor(actor.actor)];
}

/** The origin a destination is held as: `scheme://host[:port]`, `about:blank`, or null for no explicit URL. */
export function browserDestinationOrigin(destination: string | null): string | null {
	if (destination === null) return null;
	const trimmed = destination.trim();
	if (trimmed.toLowerCase() === 'about:blank') return 'about:blank';
	try {
		const url = new URL(trimmed);
		return url.host ? `${url.protocol}//${url.host}`.toLowerCase() : null;
	} catch {
		return null;
	}
}

export function matchesBrowserDestination(origin: string, pattern: string): boolean {
	if (pattern === '*') return true;
	if (origin === 'about:blank' || pattern === 'about:blank') return origin === pattern;
	const schemeEnd = pattern.indexOf('://');
	const scheme = schemeEnd === -1 ? null : pattern.slice(0, schemeEnd).toLowerCase();
	let rest = schemeEnd === -1 ? pattern : pattern.slice(schemeEnd + 3);
	const anySub = rest.startsWith('*.');
	if (anySub) rest = rest.slice(2);
	const portAt = rest.lastIndexOf(':');
	const port = portAt === -1 ? null : rest.slice(portAt + 1);
	const host = (portAt === -1 ? rest : rest.slice(0, portAt)).toLowerCase();
	const target = new URL(origin);
	const targetScheme = target.protocol.slice(0, -1);
	if (scheme ? targetScheme !== scheme : targetScheme !== 'http' && targetScheme !== 'https')
		return false;
	const targetPort =
		target.port || (targetScheme === 'https' ? '443' : targetScheme === 'http' ? '80' : '');
	if (port !== null && targetPort !== port) return false;
	const targetHost = target.hostname.toLowerCase();
	return targetHost === host || (anySub && targetHost.endsWith(`.${host}`));
}

/** Hold one effect against the standing. Pure: `unbindable` is what the caller knows about the actor (a paired device before an actor is registered). */
export function browserEffectVerdict(
	standing: ManagedBrowserStanding,
	request: BrowserEffectRequest,
	unbindable: readonly string[] = []
): BrowserEffectDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const [kind, label] = browserActorLabel(request.actor);
	const origin = request.resource === 'page' ? browserDestinationOrigin(request.destination) : null;
	const receipt = (outcome: BrowserEffectReceipt['outcome']): BrowserEffectReceipt => ({
		policyRevision: standing.policyRevision,
		surface: request.surface,
		actor: label,
		effect: request.effect,
		destination: origin,
		outcome,
	});
	const deny = (code: BrowserEffectDenial, message: string): BrowserEffectDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed browser ceiling is unavailable (${standing.reason})`);
	const entry = standing.ceiling.actors.find((candidate) => candidate.actor === kind);
	if (!entry || !entry.effects.includes(request.effect))
		return deny(
			'outside-ceiling',
			`the browser ceiling admits no ${entry ? `${request.effect} ` : 'browser '}effect for ${label}`
		);
	const destinations = standing.ceiling.destinations;
	if (destinations && request.resource === 'page') {
		if (origin === null)
			return deny(
				'destination-unknown',
				request.destination === null
					? `the host observed no page for this ${request.effect} effect; the browser ceiling admits only a known destination`
					: 'the destination is not an explicit URL; the browser ceiling admits no search query or bare host'
			);
		if (destinations.deny?.some((pattern) => matchesBrowserDestination(origin, pattern)))
			return deny('destination-denied', `the browser ceiling denies ${origin}`);
		if (destinations.allow && !destinations.allow.some((p) => matchesBrowserDestination(origin, p)))
			return deny('destination-denied', `the browser ceiling does not admit ${origin}`);
	}
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type BrowserCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface BrowserPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a sink holds an effect with: the source, or a test double. */
export interface BrowserEffectAuthority {
	authorize(request: BrowserEffectRequest): BrowserEffectDecision;
}

export interface BrowserPolicySource extends BrowserEffectAuthority {
	standing(): ManagedBrowserStanding;
	installed(): BrowserPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): BrowserCeilingInstallOutcome;
	clear(): void;
}

export function createBrowserPolicySource(deps: BrowserPolicySourceDeps): BrowserPolicySource {
	let installed: BrowserPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedBrowserStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseBrowserPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		authorize(request) {
			const read = deps.identity.read();
			const unbindable =
				request.actor.kind === 'transport'
					? pairedDeviceActorProblems(request.actor.actor, read)
					: [];
			return browserEffectVerdict(standing(read), request, unbindable);
		},
	};
}
