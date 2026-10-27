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
 *
 * The shared git executor (`src/main/utils/remote-git.ts`) holds its writes
 * to the same ceiling (MRC2-04-01): `classifyGitOperation()` names one git
 * command line a `read`, a `local-write` or a `remote-write` and the ceiling
 * effect a write is held as, and `createGitExecutionGate()` holds a write
 * before the process starts, with the actor the call was admitted over, the
 * repository `origin` names and, for a remote write, the destination. A read
 * is never held, and a standalone host makes no extra call at all. The same
 * gate holds the two forge effects the git IPC handlers reach through `gh`
 * and no git command line carries (MRC2-04-02): a `pull-request` opened on
 * the repository `origin` names, and a `gist`, content published under the
 * actor's forge account outside any repository (held against
 * `https://gist.github.com`, and named by no repository, so a ceiling with a
 * `repositories` clause refuses it `repository-unknown`). The user's worktree
 * setup script (MRC2-04-03) is a `setup-script` effect of the same surface: a
 * shell command the person configured for a repository, run in a worktree of
 * it after `git worktree add`; held as a local effect against the repository
 * `origin` names, so a ceiling admits user scripts per actor and per
 * repository, and a refusal skips the script after the worktree is created.
 */

import type { SshLaunchTarget } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import type { SshRemoteConfig } from '../../shared/types';
import { getActingTransport, transportSpawnActor } from '../web-server/auth/transport-actor';
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
	'gist',
	'setup-script',
] as const;
export type RepositoryEffectKind = (typeof REPOSITORY_EFFECTS)[number];

/** The actor model is the browser ceiling's: which transport admitted the call, or which agent session. */
export type RepositoryEffectActor = BrowserEffectActor;
export type RepositoryActorKind = BrowserActorKind;

export interface RepositoryEffectRequest {
	/** `git` is the shared git executor (`remote-git.ts`), holding a write of any caller. */
	surface: 'symphony-runner' | 'symphony' | 'git';
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

// ---------------------------------------------------------------------------
// The shared git executor (MRC2-04-01): one git command line, classified, and
// its write held before the process starts.
// ---------------------------------------------------------------------------

export type GitOperationClass = 'read' | 'local-write' | 'remote-write';

export interface GitOperation {
	/**
	 * `read` changes nothing and is never held. `local-write` changes this
	 * repository (its index, its refs, its configuration, its worktrees).
	 * `remote-write` exchanges with a remote and changes a repository on one
	 * side of it: a push changes the remote; a clone, a fetch and a pull change
	 * the local one from it. It is held against the remote's origin.
	 */
	class: GitOperationClass;
	/** The subcommand, after git's own options (`-C`, `-c`, `--git-dir`, ...). */
	subcommand: string;
	/**
	 * The ceiling effect a write is held as: `push` for a push, `clone` for a
	 * clone, fetch or pull, `branch` for a change to refs or worktrees, `commit`
	 * for every other local change; null for a read.
	 */
	effect: RepositoryEffectKind | null;
	/** The remote a `remote-write` names on its command line (a name or an address); null when git would pick one. */
	remote: string | null;
}

/** Git's own options that consume the next argument (the `--option=value` forms are self-contained). */
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--super-prefix',
	'--config-env',
	'--attr-source',
]);

/** Subcommands that change nothing, whatever their arguments. */
const READ_SUBCOMMANDS = new Set([
	'annotate',
	'archive',
	'blame',
	'cat-file',
	'check-attr',
	'check-ignore',
	'check-mailmap',
	'check-ref-format',
	'cherry',
	'column',
	'count-objects',
	'describe',
	'diff',
	'diff-files',
	'diff-index',
	'diff-tree',
	'for-each-ref',
	'format-patch',
	'fsck',
	'get-tar-commit-id',
	'grep',
	'help',
	'interpret-trailers',
	'log',
	'ls-files',
	'ls-remote',
	'ls-tree',
	'mailinfo',
	'mailsplit',
	'merge-base',
	'name-rev',
	'patch-id',
	'range-diff',
	'request-pull',
	'rev-list',
	'rev-parse',
	'shortlog',
	'show',
	'show-branch',
	'show-index',
	'show-ref',
	'status',
	'stripspace',
	'var',
	'verify-commit',
	'verify-pack',
	'verify-tag',
	'version',
	'whatchanged',
]);

/** Subcommands that change this repository, whatever their arguments. */
const LOCAL_WRITE_SUBCOMMANDS = new Set([
	'add',
	'am',
	'apply',
	'bisect',
	'checkout',
	'cherry-pick',
	'clean',
	'commit',
	'commit-tree',
	'fast-import',
	'filter-branch',
	'gc',
	'index-pack',
	'init',
	'maintenance',
	'merge',
	'mergetool',
	'mktag',
	'mktree',
	'mv',
	'pack-refs',
	'prune',
	'prune-packed',
	'read-tree',
	'rebase',
	'repack',
	'replace',
	'rerere',
	'reset',
	'restore',
	'revert',
	'rm',
	'sparse-checkout',
	'switch',
	'unpack-objects',
	'update-index',
	'update-ref',
	'write-tree',
]);

/** Local writes whose change is to refs or worktrees: held as a `branch` effect; every other local write is a `commit`. */
const REF_WRITE_SUBCOMMANDS = new Set([
	'branch',
	'checkout',
	'pack-refs',
	'reflog',
	'replace',
	'switch',
	'symbolic-ref',
	'tag',
	'update-ref',
	'worktree',
]);

/** Per subcommand, the options that consume the next argument, so a value is never read as a positional. */
const FETCH_VALUE_FLAGS = [
	'--depth',
	'--deepen',
	'--shallow-since',
	'--shallow-exclude',
	'--upload-pack',
	'-o',
	'--server-option',
	'--negotiation-tip',
	'-j',
	'--jobs',
	'--refmap',
	'--recurse-submodules-default',
	'--submodule-prefix',
	'--filter',
];
const SUBCOMMAND_VALUE_FLAGS: Record<string, readonly string[]> = {
	push: ['-o', '--push-option', '--receive-pack', '--exec', '--repo'],
	'send-pack': ['--receive-pack', '--exec'],
	fetch: FETCH_VALUE_FLAGS,
	'fetch-pack': ['--upload-pack', '--exec', '--depth', '--shallow-since', '--shallow-exclude'],
	pull: [...FETCH_VALUE_FLAGS, '-s', '--strategy', '-X', '--strategy-option', '-S', '--gpg-sign'],
	clone: [
		'-o',
		'--origin',
		'-b',
		'--branch',
		'-u',
		'--upload-pack',
		'--template',
		'-c',
		'--config',
		'--depth',
		'--shallow-since',
		'--shallow-exclude',
		'--reference',
		'--reference-if-able',
		'--separate-git-dir',
		'-j',
		'--jobs',
		'--filter',
		'--bundle-uri',
		'--server-option',
	],
	branch: ['-u', '--set-upstream-to', '--sort', '--format', '--color', '--column'],
	tag: ['-m', '--message', '-F', '--file', '-u', '--local-user', '--cleanup', '--sort', '--format'],
	config: ['-f', '--file', '--blob', '--type', '--default'],
	worktree: ['-b', '-B', '--reason'],
	'symbolic-ref': ['-m'],
};

const BRANCH_WRITE_FLAGS = [
	'-d',
	'-D',
	'--delete',
	'-m',
	'-M',
	'--move',
	'-c',
	'-C',
	'--copy',
	'-u',
	'--set-upstream-to',
	'--unset-upstream',
	'--edit-description',
];
const BRANCH_LIST_FLAGS = [
	'-l',
	'--list',
	'-a',
	'--all',
	'-r',
	'--remotes',
	'--show-current',
	'--contains',
	'--no-contains',
	'--merged',
	'--no-merged',
	'--points-at',
	'-v',
	'-vv',
	'--verbose',
];
const TAG_WRITE_FLAGS = [
	'-d',
	'--delete',
	'-f',
	'--force',
	'-a',
	'--annotate',
	'-s',
	'--sign',
	'-u',
	'--local-user',
	'-m',
	'--message',
	'-F',
	'--file',
	'-e',
	'--edit',
];
const TAG_LIST_FLAGS = [
	'-l',
	'--list',
	'--contains',
	'--no-contains',
	'--points-at',
	'--merged',
	'--no-merged',
	'--sort',
	'--format',
	'--column',
	'-i',
	'--ignore-case',
];
const CONFIG_READ_FLAGS = [
	'--get',
	'--get-all',
	'--get-regexp',
	'--get-urlmatch',
	'--list',
	'-l',
	'--get-color',
	'--get-colorbool',
	'--show-origin',
	'--show-scope',
];
const CONFIG_WRITE_FLAGS = [
	'--unset',
	'--unset-all',
	'--add',
	'--replace-all',
	'--rename-section',
	'--remove-section',
	'-e',
	'--edit',
];

interface SubcommandArgs {
	/** Option tokens with any `=value` removed. */
	flags: string[];
	/** The value of each option that consumed the next argument. */
	values: Record<string, string>;
	positionals: string[];
}

/** Split a subcommand's arguments: `--` ends options; a lone `-` is a positional. */
function splitSubcommandArgs(
	rest: readonly string[],
	valueFlags: readonly string[]
): SubcommandArgs {
	const out: SubcommandArgs = { flags: [], values: {}, positionals: [] };
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token === '--') {
			out.positionals.push(...rest.slice(i + 1));
			break;
		}
		if (token.length > 1 && token.startsWith('-')) {
			const eq = token.startsWith('--') ? token.indexOf('=') : -1;
			const flag = eq === -1 ? token : token.slice(0, eq);
			out.flags.push(flag);
			if (eq !== -1) out.values[flag] = token.slice(eq + 1);
			else if (valueFlags.includes(flag) && i + 1 < rest.length) out.values[flag] = rest[++i];
			continue;
		}
		out.positionals.push(token);
	}
	return out;
}

/** The subcommand after git's own options, and what follows it; null when the command line names none. */
export function splitGitCommandLine(args: readonly string[]): {
	subcommand: string;
	rest: string[];
} | null {
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === '--version') return { subcommand: 'version', rest: [] };
		if (token === '--help' || token === '-h')
			return { subcommand: 'help', rest: args.slice(i + 1) };
		if (token.length > 1 && token.startsWith('-')) {
			if (GIT_GLOBAL_VALUE_OPTIONS.has(token)) i++;
			continue;
		}
		return { subcommand: token, rest: args.slice(i + 1) };
	}
	return null;
}

/**
 * Name what one git command line does. Pure, and complete for the commands
 * Maestro runs; a subcommand it cannot name answers null, which the gate
 * refuses under management rather than guessing a class for it.
 */
export function classifyGitOperation(args: readonly string[]): GitOperation | null {
	const split = splitGitCommandLine(args);
	if (!split) return null;
	const { subcommand, rest } = split;
	const read: GitOperation = { class: 'read', subcommand, effect: null, remote: null };
	const local = (effect: 'branch' | 'commit'): GitOperation => ({
		class: 'local-write',
		subcommand,
		effect,
		remote: null,
	});
	const remote = (effect: 'clone' | 'push', named: string | null | undefined): GitOperation => ({
		class: 'remote-write',
		subcommand,
		effect,
		remote: named ?? null,
	});
	if (READ_SUBCOMMANDS.has(subcommand)) return read;
	const { flags, values, positionals } = splitSubcommandArgs(
		rest,
		SUBCOMMAND_VALUE_FLAGS[subcommand] ?? []
	);
	const has = (names: readonly string[]) => names.some((name) => flags.includes(name));
	const first = positionals[0];
	switch (subcommand) {
		case 'push':
			return remote('push', values['--repo'] ?? first);
		case 'send-pack':
			return remote('push', first);
		case 'fetch':
		case 'fetch-pack':
		case 'pull':
		case 'clone':
			return remote('clone', first);
		case 'branch':
			if (has(BRANCH_WRITE_FLAGS)) return local('branch');
			if (has(BRANCH_LIST_FLAGS)) return read;
			return positionals.length > 0 ? local('branch') : read;
		case 'tag':
			if (has(TAG_WRITE_FLAGS)) return local('branch');
			if (has(TAG_LIST_FLAGS) || flags.some((flag) => flag.startsWith('-n'))) return read;
			return positionals.length > 0 ? local('branch') : read;
		case 'remote':
			if (first === undefined || first === 'show' || first === 'get-url') return read;
			if (first === 'update') return remote('clone', positionals[1]);
			return local('commit');
		case 'worktree':
			return first === 'list' ? read : local('branch');
		case 'stash':
			return first === 'list' || first === 'show' ? read : local('commit');
		case 'config':
			if (has(CONFIG_WRITE_FLAGS)) return local('commit');
			if (has(CONFIG_READ_FLAGS) || first === 'get' || first === 'list') return read;
			if (first === 'set' || first === 'unset' || first === 'edit') return local('commit');
			if (first === 'rename-section' || first === 'remove-section') return local('commit');
			return positionals.length > 1 ? local('commit') : read;
		case 'submodule':
			if (first === undefined || first === 'status' || first === 'summary') return read;
			if (first === 'update') return remote('clone', null);
			if (first === 'add') return remote('clone', positionals[1]);
			return local('commit');
		case 'reflog':
			return first === 'expire' || first === 'delete' ? local('branch') : read;
		case 'symbolic-ref':
			return has(['-d', '--delete']) || positionals.length > 1 ? local('branch') : read;
		case 'notes':
			if (first === undefined || first === 'list' || first === 'show' || first === 'get-ref')
				return read;
			return local('commit');
		case 'bundle':
			return first === 'unbundle' ? local('commit') : read;
		case 'hash-object':
			return has(['-w']) ? local('commit') : read;
		default:
			if (LOCAL_WRITE_SUBCOMMANDS.has(subcommand))
				return local(REF_WRITE_SUBCOMMANDS.has(subcommand) ? 'branch' : 'commit');
			return null;
	}
}

/** Where the executor runs the command: a folder on this machine, or a folder on an SSH remote. */
export type GitExecutionTarget =
	| { kind: 'local'; cwd: string }
	| { kind: 'ssh'; remote: SshRemoteConfig; cwd: string | undefined };

export interface GitExecutionRequest {
	args: readonly string[];
	target: GitExecutionTarget;
	/**
	 * Run a read-class git command where the request runs and answer its
	 * trimmed stdout, or null when it fails or prints nothing. Called only under
	 * management, only for a write, and never re-held.
	 */
	read(args: string[]): Promise<string | null>;
}

export type GitExecutionRefusal =
	| RepositoryEffectDenial
	| 'operation-unknown'
	| 'remote-unqualified';

export type GitExecutionDecision =
	| { allowed: true; operation: GitOperation | null; managed?: RepositoryEffectReceipt }
	| {
			allowed: false;
			operation: GitOperation | null;
			code: GitExecutionRefusal;
			message: string;
			managed?: RepositoryEffectReceipt;
	  };

/**
 * A forge effect of the git surface that `gh` performs and no git command
 * line carries: the pull request `git:createPR` opens, the gist
 * `git:createGist` publishes. Held through the same gate as a git write, with
 * the same actor and the same ceiling.
 */
export type GitForgeEffect = 'pull-request' | 'gist';

export interface GitForgeRequest {
	effect: GitForgeEffect;
	/**
	 * The destination the effect reaches when the effect itself names it (a
	 * gist: `https://gist.github.com`); null to read it off the repository
	 * (`remote get-url origin`), which also names the repository the effect
	 * targets. A gist names no repository.
	 */
	destination: string | null;
	/** Read-class git in the repository the effect targets (never re-held); null for an effect that targets none. */
	read: ((args: string[]) => Promise<string | null>) | null;
}

/**
 * The user's worktree setup script (MRC2-04-03): a shell command the person
 * configured for a repository, about to run in a worktree of it at `target`.
 * Held as the `setup-script` effect against the repository the worktree's
 * `origin` names, with the same actor and the same ceiling as a git write; on
 * an SSH target the remote must be the qualified endpoint a write needs.
 */
export interface GitScriptRequest {
	target: GitExecutionTarget;
	/** Read-class git in the worktree the script runs in (never re-held). */
	read(args: string[]): Promise<string | null>;
}

/** What the executor holds a command with: the gate, or a test double. */
export interface GitExecutionGate {
	hold(request: GitExecutionRequest): Promise<GitExecutionDecision>;
	holdForge(request: GitForgeRequest): Promise<GitExecutionDecision>;
	holdScript(request: GitScriptRequest): Promise<GitExecutionDecision>;
}

export interface GitExecutionGateDeps {
	repository: Pick<RepositoryPolicySource, 'standing' | 'authorize'>;
	/** Who runs the command. Default: the transport this call was admitted over, read from the call's own context. */
	actor?(): RepositoryEffectActor;
	/**
	 * Bind an SSH remote to the enrolled endpoint it attests before a write runs
	 * there (MRC-08-04); absent, a managed write over SSH is refused by name,
	 * never run on the remote unmanaged and never run on this machine instead.
	 */
	qualifyRemote?(remote: SshRemoteConfig): Promise<SshLaunchTarget>;
}

const transportActor = (): RepositoryEffectActor => ({
	kind: 'transport',
	actor: transportSpawnActor(getActingTransport()),
});

/** The remote git itself would use for a transfer that names none (`remote.pushDefault`, the branch's remote, `origin`). */
async function defaultRemoteName(
	request: GitExecutionRequest,
	operation: GitOperation
): Promise<string> {
	if (operation.effect === 'push') {
		const pushDefault = await request.read(['config', '--get', 'remote.pushDefault']);
		if (pushDefault) return pushDefault;
	}
	const branch = await request.read(['rev-parse', '--abbrev-ref', 'HEAD']);
	if (branch && branch !== 'HEAD') {
		if (operation.effect === 'push') {
			const pushRemote = await request.read(['config', '--get', `branch.${branch}.pushRemote`]);
			if (pushRemote) return pushRemote;
		}
		const upstream = await request.read(['config', '--get', `branch.${branch}.remote`]);
		if (upstream) return upstream;
	}
	return 'origin';
}

/**
 * The gate the shared git executor consults (MRC2-04-01). Standalone answers
 * allowed at once, with no classification and no git call. Under management a
 * read is allowed unheld; a write is classified (an operation the classifier
 * cannot name is refused), an SSH target is bound to its enrolled endpoint
 * first, the repository and the remote are named through read-class git calls
 * (only while a ceiling is installed, since an unavailable ceiling refuses
 * without them) and the effect is held against the ceiling. A refusal names
 * its code and runs nothing.
 */
export function createGitExecutionGate(deps: GitExecutionGateDeps): GitExecutionGate {
	const actor = deps.actor ?? transportActor;
	/** The ceiling's answer as the executor's decision, with the receipt a managed answer carries. */
	const held = (
		operation: GitOperation | null,
		decision: RepositoryEffectDecision
	): GitExecutionDecision => {
		if (decision.allowed)
			return {
				allowed: true,
				operation,
				...(decision.managed ? { managed: decision.managed } : {}),
			};
		return {
			allowed: false,
			operation,
			code: decision.code,
			message: decision.message,
			managed: decision.managed,
		};
	};
	/**
	 * Bind an SSH target to its enrolled endpoint before anything runs there
	 * (MRC-08-04): the refusal to answer instead, or null when the remote is
	 * qualified. `what` names the command in the refusal.
	 */
	const unqualifiedSshTarget = async (
		remote: SshRemoteConfig,
		what: string
	): Promise<GitExecutionDecision | null> => {
		const label = remote.name ? `"${remote.name}"` : `"${remote.id}"`;
		const unqualified = (detail: string): GitExecutionDecision => ({
			allowed: false,
			operation: null,
			code: 'remote-unqualified',
			message: `under management the SSH remote ${label} is not a qualified managed endpoint for ${what}: ${detail} Nothing ran on the remote unmanaged, and nothing ran on this machine instead.`,
		});
		if (!deps.qualifyRemote)
			return unqualified('this host binds no remote endpoint identity for git commands.');
		const target = await deps.qualifyRemote(remote);
		if (target.kind === 'unresolved') return unqualified(target.message);
		if (target.kind !== 'remote' || !target.endpoint)
			return unqualified('the remote was resolved but no enrolled endpoint was bound to it.');
		return null;
	};
	return {
		async holdScript(request) {
			const standing = deps.repository.standing();
			if (standing.standing === 'standalone') return { allowed: true, operation: null };
			if (request.target.kind === 'ssh') {
				const refused = await unqualifiedSshTarget(
					request.target.remote,
					'a worktree setup script'
				);
				if (refused) return refused;
			}
			const repository = standing.ceiling
				? repositorySlugFromRemote(await request.read(['remote', 'get-url', 'origin']))
				: null;
			return held(
				null,
				deps.repository.authorize({
					surface: 'git',
					effect: 'setup-script',
					actor: actor(),
					resource: 'local',
					repository,
					remote: null,
				})
			);
		},
		async holdForge(request) {
			const standing = deps.repository.standing();
			if (standing.standing === 'standalone') return { allowed: true, operation: null };
			let repository: string | null = null;
			let address = request.destination;
			if (standing.ceiling && request.read) {
				address = request.destination ?? (await request.read(['remote', 'get-url', 'origin']));
				repository = repositorySlugFromRemote(address);
			}
			return held(
				null,
				deps.repository.authorize({
					surface: 'git',
					effect: request.effect,
					actor: actor(),
					resource: 'remote',
					repository,
					remote: address,
				})
			);
		},
		async hold(request) {
			const standing = deps.repository.standing();
			if (standing.standing === 'standalone') return { allowed: true, operation: null };
			const operation = classifyGitOperation(request.args);
			const refuse = (code: GitExecutionRefusal, message: string): GitExecutionDecision => ({
				allowed: false,
				operation,
				code,
				message,
			});
			if (!operation) {
				const named = splitGitCommandLine(request.args)?.subcommand ?? '(no subcommand)';
				return refuse(
					'operation-unknown',
					`the managed git executor cannot name what "git ${named}" does, so it was not run`
				);
			}
			if (operation.class === 'read') return { allowed: true, operation };
			if (request.target.kind === 'ssh') {
				const refused = await unqualifiedSshTarget(
					request.target.remote,
					`a git ${operation.subcommand}`
				);
				if (refused) return { ...refused, operation };
			}
			let repository: string | null = null;
			let address: string | null = null;
			if (standing.ceiling) {
				if (operation.class === 'remote-write') {
					const name = operation.remote ?? (await defaultRemoteName(request, operation));
					address =
						repositoryRemoteOrigin(name) !== null
							? name
							: await request.read(['remote', 'get-url', name]);
					repository = repositorySlugFromRemote(address);
				} else {
					repository = repositorySlugFromRemote(
						await request.read(['remote', 'get-url', 'origin'])
					);
				}
			}
			return held(
				operation,
				deps.repository.authorize({
					surface: 'git',
					effect: operation.effect as RepositoryEffectKind,
					actor: actor(),
					resource: operation.class === 'remote-write' ? 'remote' : 'local',
					repository,
					remote: address,
				})
			);
		},
	};
}
