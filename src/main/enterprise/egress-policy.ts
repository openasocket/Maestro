/**
 * The egress ceiling a managed desktop holds outbound HTTP to (MRC2-05-01).
 * Every main-process HTTP request of this build leaves through one chokepoint,
 * `fetchWithTimeout()` in `src/main/utils/fetchWithTimeout.ts`, and each call
 * names a destination CLASS: what the bytes are for, not merely where they go.
 * The classes are closed: `vendor-telemetry` (check-in, Cue stats, the
 * leaderboard, the 0din exchange), `updates` (release feeds and installers),
 * `provider-account` (a provider's account pages polled for usage or credits),
 * `content` (documents, images, catalogs and marketplace manifests a feature
 * reads), `github` (the GitHub API outside `gh`), `plugin` (a plugin's own
 * fetch), `user-webhook` (a URL the person configured to be called) and
 * `enterprise-endpoint` (the management endpoint, which this build reaches
 * over a Unix socket and never through here). A caller that names no class is
 * `content`. Standalone nothing here is consulted and a request leaves as it
 * always has. Under management the request is held, BEFORE any socket opens,
 * against the signed ceiling of the policy revision the host is under: the
 * ceiling admits classes, each to a bounded list of destination patterns (the
 * browser ceiling's spelling: `*`, `host`, `*.host`, `scheme://host:port`),
 * a class the ceiling does not name leaves nothing, and a refusal is named by
 * a stable code so it can never read as a network failure. Vendor telemetry
 * is therefore off by default on a managed host: the policy has to list it.
 * `parseEgressPolicyCeiling()` validates a document against a closed, bounded
 * schema; `egressVerdict()` is the pure decision (standalone: allowed, no
 * receipt); `createEgressPolicySource()` holds the one installed ceiling, in
 * memory only, under the enrollment rule the spawn authority uses, and is
 * what `setEgressAuthority()` installs on the chokepoint at app-ready. No
 * endpoint operation of this build carries an egress ceiling (CP-01), so
 * nothing calls `install()` and an enrolled desktop refuses every request
 * `unavailable` by name.
 *
 * A `provider-account` request is held once more, by ACCOUNT (MRC2-05-05):
 * the sink names the account whose token the request carries as an opaque
 * reference (`managedAccountRef()`, a digest of the provider and the resolved
 * account directory, never a path, an e-mail or a label), and the ceiling's
 * `provider-account` class lists the references the policy approves. A
 * request naming no account, or one the class does not list, is refused
 * `account-denied`: a personal account is never polled from a managed host,
 * and a denial leaves the usage display unavailable rather than at a stale
 * value presented as current. The other classes carry no account.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	browserActorLabel,
	browserDestinationOrigin,
	isBrowserDestinationPattern,
	isPlainObject,
	matchesBrowserDestination,
	parseStringList,
	unknownKeys,
	type BrowserEffectActor,
} from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

export { EgressDeniedError, isEgressDeniedError } from '../utils/fetchWithTimeout';

/** What an outbound request is for. Closed on purpose: a sink picks one, it never invents one. */
export const EGRESS_CLASSES = [
	'vendor-telemetry',
	'updates',
	'provider-account',
	'content',
	'github',
	'plugin',
	'user-webhook',
	'enterprise-endpoint',
] as const;
export type EgressClass = (typeof EGRESS_CLASSES)[number];

/** The class a caller that names none is held as. */
export const DEFAULT_EGRESS_CLASS: EgressClass = 'content';

/** Who asked for the bytes: the browser ceiling's actor model (which transport, or which agent). */
export type EgressActor = BrowserEffectActor;

/** The desktop's own automation (a poll, a check-in, an update check) acts as the operator who enabled it. */
export const EGRESS_OPERATOR: EgressActor = {
	kind: 'transport',
	actor: { peer: 'in-process' },
};

/**
 * The provider account a `provider-account` request carries the token of:
 * the provider and the opaque reference `managedAccountRef()` derives from
 * the resolved account directory. Never a path, an e-mail or a label.
 */
export interface EgressAccount {
	providerId: string;
	accountRef: string;
}

export interface EgressRequest {
	/** The absolute URL the sink is about to request. */
	url: string;
	class: EgressClass;
	/** Absent: the operator (the desktop acting for the person who runs it). */
	actor?: EgressActor;
	/** The account a `provider-account` request acts as; a request of that class naming none is refused. */
	account?: EgressAccount;
}

export interface EgressCeilingClass {
	class: EgressClass;
	/** Destination patterns in the browser ceiling's spelling; empty admits none. */
	destinations: string[];
	/** `provider-account` only: the opaque account references the policy approves; absent or empty approves none. */
	accounts?: string[];
}

export interface EgressPolicyCeiling {
	policyRevision: number;
	/** A class absent here leaves nothing. */
	classes: EgressCeilingClass[];
}

export const EGRESS_CEILING_LIMITS = { destinations: 256, accounts: 64, accountRef: 256 } as const;

const CEILING_KEYS = ['policyRevision', 'classes'] as const;
const CLASS_KEYS = ['class', 'destinations', 'accounts'] as const;

/** The one class held by account; every other class carries none. */
const ACCOUNT_HELD_CLASS: EgressClass = 'provider-account';

/** An opaque account reference as the policy spells it: a bounded, non-empty token with no path or space in it. */
export function isEgressAccountRef(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= EGRESS_CEILING_LIMITS.accountRef &&
		/^[A-Za-z0-9._:-]+$/.test(value)
	);
}

export type EgressCeilingParse =
	| { ok: true; ceiling: EgressPolicyCeiling }
	| { ok: false; problems: readonly string[] };

export function isEgressClass(value: unknown): value is EgressClass {
	return (EGRESS_CLASSES as readonly unknown[]).includes(value);
}

function parseClass(raw: unknown, at: string, problems: string[]): EgressCeilingClass | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, CLASS_KEYS, `${at}.`));
	const before = problems.length;
	if (!isEgressClass(raw.class)) problems.push(`${at}.class is not an egress class`);
	const destinations = parseStringList(
		raw.destinations,
		`${at}.destinations`,
		EGRESS_CEILING_LIMITS.destinations,
		'a destination pattern',
		isBrowserDestinationPattern,
		problems
	);
	let accounts: string[] | null | undefined;
	if (raw.accounts !== undefined) {
		if (raw.class === ACCOUNT_HELD_CLASS)
			accounts = parseStringList(
				raw.accounts,
				`${at}.accounts`,
				EGRESS_CEILING_LIMITS.accounts,
				'an account reference',
				isEgressAccountRef,
				problems
			);
		else problems.push(`${at}.accounts is only for the ${ACCOUNT_HELD_CLASS} class`);
	}
	if (problems.length !== before || !destinations || accounts === null) return null;
	return {
		class: raw.class as EgressClass,
		destinations,
		...(accounts === undefined ? {} : { accounts }),
	};
}

/**
 * Validate an egress ceiling document. The result is a fresh value the
 * caller's input can no longer reach; every problem is named by its path, and
 * one problem refuses the whole document.
 */
export function parseEgressPolicyCeiling(raw: unknown): EgressCeilingParse {
	if (!isPlainObject(raw)) return { ok: false, problems: ['the egress ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const classes: EgressCeilingClass[] = [];
	if (!Array.isArray(raw.classes)) problems.push('classes is not an array');
	else if (raw.classes.length > EGRESS_CLASSES.length)
		problems.push(`classes exceeds ${EGRESS_CLASSES.length} entries`);
	else
		raw.classes.forEach((entry, index) => {
			const parsed = parseClass(entry, `classes[${index}]`, problems);
			if (parsed && classes.some((seen) => seen.class === parsed.class))
				problems.push(`classes[${index}].class "${parsed.class}" is named twice`);
			else if (parsed) classes.push(parsed);
		});
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, ceiling: { policyRevision: raw.policyRevision as number, classes } };
}

export type ManagedEgressStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: EgressPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the chokepoint holds against: the rule of `managedBrowserStanding`, for the egress ceiling. */
export function managedEgressStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: EgressPolicyCeiling | null;
}): ManagedEgressStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no egress ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed egress ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

export type EgressDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'url-invalid'
	| 'class-denied'
	| 'destination-denied'
	| 'account-denied';

export interface EgressReceipt {
	policyRevision: number | null;
	class: EgressClass;
	actor: string;
	/** The origin held (`scheme://host[:port]`), never the path or query, which may carry a token. */
	origin: string | null;
	/** The opaque account reference a `provider-account` request named; absent when the request named none. */
	account?: string;
	outcome: 'within-ceiling' | EgressDenial;
}

export type EgressDecision =
	| { allowed: true; managed?: EgressReceipt }
	| { allowed: false; code: EgressDenial; message: string; managed: EgressReceipt };

/** The one line a refusal is reported as, so a refused request never reads as a network failure. */
export function formatEgressRefusal(decision: { code: string; message: string }): string {
	return `[managed-${decision.code}] ${decision.message}`;
}

/**
 * Hold one outbound request against the standing. Pure: `unbindable` is what
 * the caller knows about the actor (a paired device before an actor is
 * registered). The request is held by class and origin; a class the ceiling
 * does not name leaves nothing, and a named class leaves only for the
 * destinations it lists. A `provider-account` request leaves only for an
 * account the class lists, named by its opaque reference.
 */
export function egressVerdict(
	standing: ManagedEgressStanding,
	request: EgressRequest,
	unbindable: readonly string[] = []
): EgressDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const actor = request.actor ?? EGRESS_OPERATOR;
	const [, label] = browserActorLabel(actor);
	// `about:blank` is a page the browser ceiling can hold; for egress it is no destination at all.
	const held = browserDestinationOrigin(request.url);
	const origin = held === 'about:blank' ? null : held;
	const receipt = (outcome: EgressReceipt['outcome']): EgressReceipt => ({
		policyRevision: standing.policyRevision,
		class: request.class,
		actor: label,
		origin,
		...(request.account ? { account: request.account.accountRef } : {}),
		outcome,
	});
	const deny = (code: EgressDenial, message: string): EgressDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny('unavailable', `the managed egress ceiling is unavailable (${standing.reason})`);
	if (origin === null || !/^https?:\/\//.test(origin))
		return deny(
			'url-invalid',
			`a ${request.class} request for ${label} names no destination origin the egress ceiling can hold; only an absolute http(s) URL leaves a managed host`
		);
	const entry = standing.ceiling.classes.find((candidate) => candidate.class === request.class);
	if (!entry)
		return deny(
			'class-denied',
			`the egress ceiling admits no ${request.class} request for ${label}; a request of this class leaves only when the policy lists the class`
		);
	if (!entry.destinations.some((pattern) => matchesBrowserDestination(origin, pattern)))
		return deny(
			'destination-denied',
			`the egress ceiling does not list ${origin} for ${request.class} requests by ${label}; a request leaves only for a destination the policy lists`
		);
	if (request.class === ACCOUNT_HELD_CLASS) {
		if (!request.account)
			return deny(
				'account-denied',
				`a ${request.class} request for ${label} to ${origin} names no account; a provider account is polled from a managed host only when the policy approves it`
			);
		if (!entry.accounts?.includes(request.account.accountRef))
			return deny(
				'account-denied',
				`the egress ceiling approves no ${request.account.providerId} account ${request.account.accountRef.slice(0, 12)} for ${request.class} requests by ${label} to ${origin}; a personal account is never polled from a managed host`
			);
	}
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type EgressCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface EgressPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What the chokepoint holds a request with: the source, or a test double. */
export interface EgressAuthority {
	evaluateEgress(request: EgressRequest): EgressDecision;
}

export interface EgressPolicySource extends EgressAuthority {
	standing(): ManagedEgressStanding;
	installed(): EgressPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): EgressCeilingInstallOutcome;
	clear(): void;
}

export function createEgressPolicySource(deps: EgressPolicySourceDeps): EgressPolicySource {
	let installed: EgressPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedEgressStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseEgressPolicyCeiling(raw);
			if (!parsed.ok) return { installed: false, problems: parsed.problems };
			installed = parsed.ceiling;
			return { installed: true, policyRevision: parsed.ceiling.policyRevision };
		},
		clear() {
			installed = null;
		},
		evaluateEgress(request) {
			const read = deps.identity.read();
			const actor = request.actor ?? EGRESS_OPERATOR;
			const unbindable =
				actor.kind === 'transport' ? pairedDeviceActorProblems(actor.actor, read) : [];
			return egressVerdict(standing(read), request, unbindable);
		},
	};
}
