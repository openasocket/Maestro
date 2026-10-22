/**
 * The repository ceiling a managed desktop holds Symphony's repository and
 * publication effects to (MRC-09-05): the contribution runner
 * (`src/main/services/symphony-runner.ts`) and, through the same authority,
 * the Symphony IPC handlers. A contribution is a chain of effects that each
 * reach outside the host or change what will: a `clone` (content from a
 * remote), a `branch` and a `commit` (local), a `fork` (a repository created
 * under the actor's forge account), a `push` (refs to a remote), a
 * `pull-request` (a draft opened on the forge), a `finalize` (the draft made
 * ready and rewritten) and a `cancel` (the draft closed, the clone removed).
 * Under management each is held, by itself, before it runs, against the signed
 * ceiling of the policy revision the host is under: the actor (which
 * transport, or which agent), the repository the contribution targets and, for
 * a remote effect, the destination's origin. A clone that succeeded is never a
 * permit for the push, and a refusal is named by code so it can never read as
 * a git or gh failure a login would fix. `parseRepositoryPolicyCeiling()`
 * validates a document against a closed, bounded schema; `repositoryEffectVerdict()`
 * is the pure decision (standalone: allowed, no receipt);
 * `createRepositoryPolicySource()` holds the one installed ceiling, in memory
 * only, under the enrollment rule the spawn authority uses. No endpoint
 * operation of this build carries a repository ceiling (CP-01), so nothing
 * calls `install()` and an enrolled desktop refuses every effect `unavailable`.
 */

import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	BROWSER_ACTORS,
	browserActorLabel,
	isBrowserDestinationPattern,
	isPlainObject,
	matchesBrowserDestination,
	parseStringList,
	unknownKeys,
	type BrowserActorKind,
	type BrowserEffectActor,
} from './browser-policy';
import type { EnterpriseIdentityStore } from './identity-store';
import { pairedDeviceActorProblems } from './spawn-authority';

export const REPOSITORY_EFFECTS = [
	'clone',
	'branch',
	'commit',
	'fork',
	'push',
	'pull-request',
	'finalize',
	'cancel',
] as const;
export type RepositoryEffectKind = (typeof REPOSITORY_EFFECTS)[number];

/** The actor model is the browser ceiling's: which transport admitted the call, or which agent session. */
export type RepositoryEffectActor = BrowserEffectActor;
export type RepositoryActorKind = BrowserActorKind;

export interface RepositoryEffectRequest {
	surface: 'symphony-runner' | 'symphony';
	effect: RepositoryEffectKind;
	actor: RepositoryEffectActor;
	/** A remote effect is held against its destination; a local one (a branch, a commit, removing a clone) is not. */
	resource: 'remote' | 'local';
	/** The repository the contribution targets, `owner/repo`; null when the sink cannot name it. */
	repository: string | null;
	/** The remote the effect reaches: a URL, an scp-style address or a local path; null when unknown. */
	remote: string | null;
}

export interface RepositoryCeilingActor {
	actor: RepositoryActorKind;
	effects: RepositoryEffectKind[];
}

export interface RepositoryPolicyCeiling {
	policyRevision: number;
	/** An actor kind absent here performs no repository effect at all. */
	actors: RepositoryCeilingActor[];
	/** Slug patterns (`*`, `owner/*`, `owner/repo`); `allow` absent admits what `deny` does not name. */
	repositories?: { allow?: string[]; deny?: string[] };
	/** Remote patterns (`*`, `file:`, `[scheme://][*.]host[:port]`), matched against the remote's origin. */
	remotes?: { allow?: string[]; deny?: string[] };
}

export const REPOSITORY_CEILING_LIMITS = {
	actors: 16,
	patterns: 256,
	patternLength: 1024,
} as const;

const CEILING_KEYS = ['policyRevision', 'actors', 'repositories', 'remotes'] as const;
const ACTOR_KEYS = ['actor', 'effects'] as const;
const LIST_KEYS = ['allow', 'deny'] as const;
const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SLUG_PATTERN_RE = /^[A-Za-z0-9._-]+\/(?:\*|[A-Za-z0-9._-]+)$/;
/** `[user@]host:path`, the scp-style address git accepts (never `scheme://`). */
const SCP_RE = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.*)$/;

export type RepositoryCeilingParse =
	| { ok: true; ceiling: RepositoryPolicyCeiling }
	| { ok: false; problems: readonly string[] };

/** `*`, `owner/*` or `owner/repo`. */
export function isRepositorySlugPattern(pattern: string): boolean {
	return (
		pattern.length <= REPOSITORY_CEILING_LIMITS.patternLength &&
		(pattern === '*' || SLUG_PATTERN_RE.test(pattern))
	);
}

/** `*`, `file:` (a local path or `file://` URL) or the browser ceiling's `[scheme://][*.]host[:port]`. */
export function isRepositoryRemotePattern(pattern: string): boolean {
	return pattern === 'file:' || (pattern !== 'about:blank' && isBrowserDestinationPattern(pattern));
}

function parseActor(raw: unknown, at: string, problems: string[]): RepositoryCeilingActor | null {
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return null;
	}
	problems.push(...unknownKeys(raw, ACTOR_KEYS, `${at}.`));
	const before = problems.length;
	if (!(BROWSER_ACTORS as readonly unknown[]).includes(raw.actor))
		problems.push(`${at}.actor is not a repository actor kind`);
	const effects = parseStringList(
		raw.effects,
		`${at}.effects`,
		REPOSITORY_EFFECTS.length,
		'a repository effect kind',
		(value) => (REPOSITORY_EFFECTS as readonly string[]).includes(value),
		problems
	);
	if (problems.length !== before || !effects) return null;
	return { actor: raw.actor as RepositoryActorKind, effects: effects as RepositoryEffectKind[] };
}

function parseClause(
	raw: unknown,
	at: string,
	what: string,
	accept: (value: string) => boolean,
	problems: string[]
): { allow?: string[]; deny?: string[] } | undefined {
	if (raw === undefined) return undefined;
	if (!isPlainObject(raw)) {
		problems.push(`${at} is not an object`);
		return undefined;
	}
	problems.push(...unknownKeys(raw, LIST_KEYS, `${at}.`));
	const clause: { allow?: string[]; deny?: string[] } = {};
	for (const key of LIST_KEYS) {
		if (raw[key] === undefined) continue;
		const parsed = parseStringList(
			raw[key],
			`${at}.${key}`,
			REPOSITORY_CEILING_LIMITS.patterns,
			what,
			accept,
			problems
		);
		if (parsed) clause[key] = parsed;
	}
	return clause;
}

/**
 * Validate a repository ceiling document. The result is a fresh value the
 * caller's input can no longer reach; every problem is named by its path,
 * and one problem refuses the whole document.
 */
export function parseRepositoryPolicyCeiling(raw: unknown): RepositoryCeilingParse {
	if (!isPlainObject(raw))
		return { ok: false, problems: ['the repository ceiling is not an object'] };
	const problems = unknownKeys(raw, CEILING_KEYS, '');
	if (!Number.isSafeInteger(raw.policyRevision) || (raw.policyRevision as number) < 0)
		problems.push('policyRevision is not a policy revision');
	const actors: RepositoryCeilingActor[] = [];
	if (!Array.isArray(raw.actors)) problems.push('actors is not an array');
	else if (raw.actors.length > REPOSITORY_CEILING_LIMITS.actors)
		problems.push(`actors exceeds ${REPOSITORY_CEILING_LIMITS.actors} entries`);
	else
		raw.actors.forEach((entry, index) => {
			const parsed = parseActor(entry, `actors[${index}]`, problems);
			if (parsed && actors.some((seen) => seen.actor === parsed.actor))
				problems.push(`actors[${index}].actor "${parsed.actor}" is named twice`);
			else if (parsed) actors.push(parsed);
		});
	const repositories = parseClause(
		raw.repositories,
		'repositories',
		'a repository slug pattern',
		isRepositorySlugPattern,
		problems
	);
	const remotes = parseClause(
		raw.remotes,
		'remotes',
		'a remote pattern',
		isRepositoryRemotePattern,
		problems
	);
	if (problems.length > 0) return { ok: false, problems };
	return {
		ok: true,
		ceiling: {
			policyRevision: raw.policyRevision as number,
			actors,
			...(repositories ? { repositories } : {}),
			...(remotes ? { remotes } : {}),
		},
	};
}

export type ManagedRepositoryStanding =
	| { standing: 'standalone' }
	| { standing: 'managed'; ceiling: RepositoryPolicyCeiling; policyRevision: number }
	| { standing: 'managed'; ceiling: null; policyRevision: number | null; reason: string };

/** The standing the sinks hold against: the rule of `managedPluginStanding`, for the repository ceiling. */
export function managedRepositoryStanding(input: {
	enrolled: boolean;
	policy: Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
	ceiling: RepositoryPolicyCeiling | null;
}): ManagedRepositoryStanding {
	if (!input.enrolled) return { standing: 'standalone' };
	const revision = input.policy?.appliedRevision ?? null;
	const reason =
		revision === null
			? 'no applied policy revision is known for this host'
			: !input.ceiling
				? `no repository ceiling is installed for policy revision ${revision}`
				: input.ceiling.policyRevision !== revision
					? `the installed repository ceiling is for policy revision ${input.ceiling.policyRevision}; this host is under revision ${revision}`
					: null;
	if (reason !== null || !input.ceiling || revision === null)
		return { standing: 'managed', ceiling: null, policyRevision: revision, reason: reason ?? '' };
	return { standing: 'managed', ceiling: input.ceiling, policyRevision: revision };
}

/**
 * The origin a remote is held as: `scheme://host[:port]` for a URL (credentials
 * in the URL never survive), `ssh://host` for an scp-style address, `file:` for
 * a local path or `file://` URL, or null when the remote names no host.
 */
export function repositoryRemoteOrigin(remote: string | null): string | null {
	if (remote === null) return null;
	const trimmed = remote.trim();
	if (!trimmed) return null;
	if (/^(?:file:\/\/|[/.]|[A-Za-z]:[\\/])/.test(trimmed)) return 'file:';
	if (!trimmed.includes('://')) {
		const scp = SCP_RE.exec(trimmed);
		return scp ? `ssh://${scp[1].toLowerCase()}` : null;
	}
	try {
		const url = new URL(trimmed);
		return url.host ? `${url.protocol}//${url.host}`.toLowerCase() : null;
	} catch {
		return null;
	}
}

/** The `owner/repo` a remote's last two path segments name, or null. */
export function repositorySlugFromRemote(remote: string | null): string | null {
	if (remote === null) return null;
	const trimmed = remote.trim();
	let pathname: string;
	if (trimmed.includes('://')) {
		try {
			pathname = new URL(trimmed).pathname;
		} catch {
			return null;
		}
	} else {
		const scp = SCP_RE.exec(trimmed);
		pathname = scp ? scp[2] : trimmed;
	}
	const parts = pathname
		.replace(/\\/g, '/')
		.replace(/\/+$/, '')
		.replace(/\.git$/, '')
		.split('/')
		.filter(Boolean);
	if (parts.length < 2) return null;
	const slug = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
	return SLUG_RE.test(slug) ? slug : null;
}

export function matchesRepositorySlug(slug: string, pattern: string): boolean {
	if (pattern === '*') return true;
	const target = slug.toLowerCase();
	const wanted = pattern.toLowerCase();
	return wanted.endsWith('/*') ? target.startsWith(wanted.slice(0, -1)) : target === wanted;
}

export function matchesRepositoryRemote(origin: string, pattern: string): boolean {
	if (pattern === '*') return true;
	if (origin === 'file:' || pattern === 'file:') return origin === pattern;
	return matchesBrowserDestination(origin, pattern);
}

export type RepositoryEffectDenial =
	| 'unavailable'
	| 'unauthenticated'
	| 'outside-ceiling'
	| 'repository-unknown'
	| 'repository-denied'
	| 'remote-unknown'
	| 'remote-denied';

export interface RepositoryEffectReceipt {
	policyRevision: number | null;
	surface: RepositoryEffectRequest['surface'];
	actor: string;
	effect: RepositoryEffectKind;
	repository: string | null;
	/** The remote's origin only; never a path, a credential or a query. */
	remote: string | null;
	outcome: 'within-ceiling' | RepositoryEffectDenial;
}

export type RepositoryEffectDecision =
	| { allowed: true; managed?: RepositoryEffectReceipt }
	| {
			allowed: false;
			code: RepositoryEffectDenial;
			message: string;
			managed: RepositoryEffectReceipt;
	  };

/** Hold one effect against the standing. Pure: `unbindable` is what the caller knows about the actor. */
export function repositoryEffectVerdict(
	standing: ManagedRepositoryStanding,
	request: RepositoryEffectRequest,
	unbindable: readonly string[] = []
): RepositoryEffectDecision {
	if (standing.standing === 'standalone') return { allowed: true };
	const [kind, label] = browserActorLabel(request.actor);
	const repository = request.repository?.trim() || null;
	const origin = request.resource === 'remote' ? repositoryRemoteOrigin(request.remote) : null;
	const receipt = (outcome: RepositoryEffectReceipt['outcome']): RepositoryEffectReceipt => ({
		policyRevision: standing.policyRevision,
		surface: request.surface,
		actor: label,
		effect: request.effect,
		repository,
		remote: origin,
		outcome,
	});
	const deny = (code: RepositoryEffectDenial, message: string): RepositoryEffectDecision => ({
		allowed: false,
		code,
		message,
		managed: receipt(code),
	});
	if (unbindable.length > 0) return deny('unauthenticated', unbindable.join('; '));
	if (!standing.ceiling)
		return deny(
			'unavailable',
			`the managed repository ceiling is unavailable (${standing.reason})`
		);
	const entry = standing.ceiling.actors.find((candidate) => candidate.actor === kind);
	if (!entry || !entry.effects.includes(request.effect))
		return deny(
			'outside-ceiling',
			`the repository ceiling admits no ${entry ? `${request.effect} ` : 'repository '}effect for ${label}`
		);
	const repositories = standing.ceiling.repositories;
	if (repositories) {
		if (repository === null)
			return deny(
				'repository-unknown',
				`the sink named no repository for this ${request.effect} effect; the repository ceiling admits only a named repository`
			);
		if (repositories.deny?.some((pattern) => matchesRepositorySlug(repository, pattern)))
			return deny('repository-denied', `the repository ceiling denies ${repository}`);
		if (
			repositories.allow &&
			!repositories.allow.some((pattern) => matchesRepositorySlug(repository, pattern))
		)
			return deny('repository-denied', `the repository ceiling does not admit ${repository}`);
	}
	const remotes = standing.ceiling.remotes;
	if (remotes && request.resource === 'remote') {
		if (origin === null)
			return deny(
				'remote-unknown',
				request.remote === null
					? `the sink named no remote for this ${request.effect} effect; the repository ceiling admits only a known remote`
					: 'the remote is not a URL, an scp-style address or a local path the repository ceiling can name'
			);
		if (remotes.deny?.some((pattern) => matchesRepositoryRemote(origin, pattern)))
			return deny('remote-denied', `the repository ceiling denies ${origin}`);
		if (remotes.allow && !remotes.allow.some((p) => matchesRepositoryRemote(origin, p)))
			return deny('remote-denied', `the repository ceiling does not admit ${origin}`);
	}
	return { allowed: true, managed: receipt('within-ceiling') };
}

export type RepositoryCeilingInstallOutcome =
	| { installed: true; policyRevision: number }
	| { installed: false; problems: readonly string[] };

export interface RepositoryPolicySourceDeps {
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	policy(): Pick<ManagedPolicyStatus, 'appliedRevision'> | null;
}

/** What a sink holds an effect with: the source, or a test double. */
export interface RepositoryEffectAuthority {
	authorize(request: RepositoryEffectRequest): RepositoryEffectDecision;
}

export interface RepositoryPolicySource extends RepositoryEffectAuthority {
	standing(): ManagedRepositoryStanding;
	installed(): RepositoryPolicyCeiling | null;
	/** Install a ceiling an authenticated endpoint path handed over; a refused document keeps the previous one. */
	install(raw: unknown): RepositoryCeilingInstallOutcome;
	clear(): void;
}

export function createRepositoryPolicySource(
	deps: RepositoryPolicySourceDeps
): RepositoryPolicySource {
	let installed: RepositoryPolicyCeiling | null = null;
	const standing = (read = deps.identity.read()) =>
		managedRepositoryStanding({
			enrolled: read.status !== 'none',
			policy: deps.policy(),
			ceiling: installed,
		});
	return {
		standing: () => standing(),
		installed: () => installed,
		install(raw) {
			const parsed = parseRepositoryPolicyCeiling(raw);
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
			return repositoryEffectVerdict(standing(read), request, unbindable);
		},
	};
}
