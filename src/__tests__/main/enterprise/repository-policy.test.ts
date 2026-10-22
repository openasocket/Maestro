/**
 * The repository ceiling (MRC-09-05): a closed, bounded document schema that
 * refuses by name; one installed ceiling projected onto the standing the
 * Symphony sinks hold every repository effect against; and the pure verdict
 * that binds the actor, the effect, the repository the contribution targets
 * and, for a remote effect, the destination origin, with a receipt on every
 * managed answer and nothing at all on a standalone host.
 */

import { describe, expect, it } from 'vitest';

import {
	REPOSITORY_CEILING_LIMITS,
	REPOSITORY_EFFECTS,
	createRepositoryPolicySource,
	isRepositoryRemotePattern,
	isRepositorySlugPattern,
	managedRepositoryStanding,
	matchesRepositoryRemote,
	matchesRepositorySlug,
	parseRepositoryPolicyCeiling,
	repositoryEffectVerdict,
	repositoryRemoteOrigin,
	repositorySlugFromRemote,
	type ManagedRepositoryStanding,
	type RepositoryEffectDecision,
	type RepositoryEffectKind,
	type RepositoryEffectRequest,
	type RepositoryPolicyCeiling,
} from '../../../main/enterprise/repository-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { isGitHubAuthError, isGitHubMissingScopeError } from '../../../main/utils/ghErrors';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		actors: [
			{ actor: 'operator', effects: [...REPOSITORY_EFFECTS] },
			{ actor: 'web-login', effects: ['clone', 'branch', 'commit'] },
			{ actor: 'agent', effects: ['clone'] },
		],
		repositories: { allow: ['acme/*', 'Maestro/maestro'], deny: ['acme/secrets'] },
		remotes: { allow: ['github.com', 'file:'], deny: ['https://gist.github.com'] },
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseRepositoryPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): RepositoryPolicyCeiling {
	const parsed = parseRepositoryPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedRepositoryStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<RepositoryEffectRequest> = {}): RepositoryEffectRequest {
	return {
		surface: 'symphony-runner',
		effect: 'push',
		actor: { kind: 'transport', actor: { peer: 'in-process' } },
		resource: 'remote',
		repository: 'acme/widgets',
		remote: 'https://token@github.com/acme/widgets.git',
		...overrides,
	};
}

describe('parseRepositoryPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseRepositoryPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			actors: [
				{ actor: 'operator', effects: [...REPOSITORY_EFFECTS] },
				{ actor: 'web-login', effects: ['clone', 'branch', 'commit'] },
				{ actor: 'agent', effects: ['clone'] },
			],
			repositories: { allow: ['acme/*', 'Maestro/maestro'], deny: ['acme/secrets'] },
			remotes: { allow: ['github.com', 'file:'], deny: ['https://gist.github.com'] },
		});
		(raw.actors as unknown[]).push({ actor: 'lite-device', effects: ['push'] });
		(raw.remotes as { allow: string[] }).allow.push('*');
		expect(parsed.ceiling.actors).toHaveLength(3);
		expect(parsed.ceiling.remotes?.allow).toEqual(['github.com', 'file:']);
	});

	it('accepts a document with neither clause and omits them', () => {
		const ceiling = ceilingOf(document({ repositories: undefined, remotes: undefined }));
		expect('repositories' in ceiling).toBe(false);
		expect('remotes' in ceiling).toBe(false);
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the repository ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ actors: {} }))).toEqual(['actors is not an array']);
		expect(problemsOf(document({ actors: [{ actor: 'root', effects: ['push'] }] }))).toEqual([
			'actors[0].actor is not a repository actor kind',
		]);
		expect(
			problemsOf(document({ actors: [{ actor: 'operator', effects: ['push', 'merge'] }] }))
		).toEqual(['actors[0].effects[1] is not a repository effect kind']);
		expect(
			problemsOf(
				document({
					actors: [
						{ actor: 'operator', effects: ['push'] },
						{ actor: 'operator', effects: ['clone'] },
					],
				})
			)
		).toEqual(['actors[1].actor "operator" is named twice']);
		expect(problemsOf(document({ repositories: [] }))).toEqual(['repositories is not an object']);
		expect(problemsOf(document({ repositories: { allow: ['acme'] } }))).toEqual([
			'repositories.allow[0] is not a repository slug pattern',
		]);
		expect(problemsOf(document({ remotes: { deny: ['not a host'], other: [] } }))).toEqual([
			'remotes.other is not a known key',
			'remotes.deny[0] is not a remote pattern',
		]);
	});

	it('refuses every bound rather than truncating', () => {
		const actors = Array.from({ length: REPOSITORY_CEILING_LIMITS.actors + 1 }, () => ({
			actor: 'operator',
			effects: ['push'],
		}));
		expect(problemsOf(document({ actors }))).toEqual([
			`actors exceeds ${REPOSITORY_CEILING_LIMITS.actors} entries`,
		]);
		const allow = Array.from({ length: REPOSITORY_CEILING_LIMITS.patterns + 1 }, () => '*');
		expect(problemsOf(document({ remotes: { allow } }))).toEqual([
			`remotes.allow exceeds ${REPOSITORY_CEILING_LIMITS.patterns} entries`,
		]);
		const long = `acme/${'x'.repeat(REPOSITORY_CEILING_LIMITS.patternLength)}`;
		expect(isRepositorySlugPattern(long)).toBe(false);
	});

	it.each([
		['*', true],
		['acme/*', true],
		['acme/widgets', true],
		['Acme/wid.gets-2', true],
		['acme', false],
		['acme/', false],
		['*/widgets', false],
		['acme/widgets/more', false],
	])('slug pattern %s -> %s', (pattern, accepted) => {
		expect(isRepositorySlugPattern(pattern)).toBe(accepted);
	});

	it.each([
		['*', true],
		['file:', true],
		['github.com', true],
		['ssh://*.corp.example', true],
		['https://github.com:443', true],
		['about:blank', false],
		['not a host', false],
	])('remote pattern %s -> %s', (pattern, accepted) => {
		expect(isRepositoryRemotePattern(pattern)).toBe(accepted);
	});
});

describe('managedRepositoryStanding', () => {
	it('is standalone while never enrolled', () => {
		expect(managedRepositoryStanding({ enrolled: false, policy: null, ceiling: null })).toEqual({
			standing: 'standalone',
		});
	});

	it('names the reason until a ceiling for the applied revision is installed', () => {
		expect(managedRepositoryStanding({ enrolled: true, policy: null, ceiling: null })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(
			managedRepositoryStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toMatchObject({ reason: 'no repository ceiling is installed for policy revision 3' });
		expect(
			managedRepositoryStanding({
				enrolled: true,
				policy: { appliedRevision: 4 },
				ceiling: ceilingOf(),
			})
		).toMatchObject({
			reason:
				'the installed repository ceiling is for policy revision 3; this host is under revision 4',
		});
		expect(
			managedRepositoryStanding({
				enrolled: true,
				policy: { appliedRevision: 3 },
				ceiling: ceilingOf(),
			})
		).toEqual({ standing: 'managed', ceiling: ceilingOf(), policyRevision: 3 });
	});
});

describe('remote origins and slugs', () => {
	it.each([
		[null, null],
		['', null],
		['https://github.com/acme/widgets.git', 'https://github.com'],
		['https://token@GitHub.com:8443/acme/widgets', 'https://github.com:8443'],
		['git@github.com:acme/widgets.git', 'ssh://github.com'],
		['ssh://git@corp.example:2222/acme/widgets.git', 'ssh://corp.example:2222'],
		['file:///tmp/remotes/acme/widgets.git', 'file:'],
		['/tmp/remotes/acme/widgets.git', 'file:'],
		['../remotes/widgets.git', 'file:'],
		['C:\\remotes\\widgets.git', 'file:'],
		['https://', null],
		['just-a-name', null],
	])('origin of %s is %s', (remote, origin) => {
		expect(repositoryRemoteOrigin(remote)).toBe(origin);
	});

	it.each([
		[null, null],
		['https://github.com/acme/widgets.git', 'acme/widgets'],
		['https://github.com/acme/widgets', 'acme/widgets'],
		['git@github.com:acme/widgets.git', 'acme/widgets'],
		['/tmp/remotes/acme/widgets.git/', 'acme/widgets'],
		['file:///tmp/remotes/acme/widgets.git', 'acme/widgets'],
		['C:\\remotes\\acme\\widgets.git', 'acme/widgets'],
		['https://github.com/widgets', null],
		['https://', null],
	])('slug of %s is %s', (remote, slug) => {
		expect(repositorySlugFromRemote(remote)).toBe(slug);
	});

	it.each([
		['acme/widgets', '*', true],
		['acme/widgets', 'acme/*', true],
		['ACME/Widgets', 'acme/widgets', true],
		['acme/widgets', 'acme/gadgets', false],
		['acmecorp/widgets', 'acme/*', false],
	])('slug %s against %s -> %s', (slug, pattern, matched) => {
		expect(matchesRepositorySlug(slug, pattern)).toBe(matched);
	});

	it.each([
		['https://github.com', '*', true],
		['https://github.com', 'github.com', true],
		['https://github.com', 'https://*.github.com', true],
		['https://github.com', 'https://*.example.com', false],
		['https://gist.github.com', '*.github.com', true],
		['ssh://github.com', 'github.com', false],
		['ssh://github.com', 'ssh://github.com', true],
		['file:', 'file:', true],
		['file:', '*', true],
		['file:', 'github.com', false],
		['https://github.com', 'file:', false],
	])('origin %s against %s -> %s', (origin, pattern, matched) => {
		expect(matchesRepositoryRemote(origin, pattern)).toBe(matched);
	});
});

describe('repositoryEffectVerdict', () => {
	it('answers allowed with no receipt on a standalone host', () => {
		expect(repositoryEffectVerdict({ standing: 'standalone' }, request())).toEqual({
			allowed: true,
		});
	});

	it('refuses unavailable with a receipt when no usable ceiling is installed', () => {
		const decision = repositoryEffectVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'nothing installed' },
			request()
		);
		expect(decision).toEqual({
			allowed: false,
			code: 'unavailable',
			message: 'the managed repository ceiling is unavailable (nothing installed)',
			managed: {
				policyRevision: 3,
				surface: 'symphony-runner',
				actor: 'the operator',
				effect: 'push',
				repository: 'acme/widgets',
				remote: 'https://github.com',
				outcome: 'unavailable',
			},
		});
	});

	it('admits within the ceiling with a receipt that carries the origin only', () => {
		expect(repositoryEffectVerdict(managed(), request())).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				surface: 'symphony-runner',
				actor: 'the operator',
				effect: 'push',
				repository: 'acme/widgets',
				remote: 'https://github.com',
				outcome: 'within-ceiling',
			},
		});
	});

	it('refuses an actor kind and an effect the ceiling omits, by name', () => {
		const device = request({
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'dev-1' } },
		});
		expect(repositoryEffectVerdict(managed(), device)).toMatchObject({
			code: 'outside-ceiling',
			message: expect.stringContaining('admits no repository effect for'),
		});
		const agentPush = request({
			actor: { kind: 'agent', sessionId: 's1', agentType: 'codex' },
		});
		expect(repositoryEffectVerdict(managed(), agentPush)).toMatchObject({
			code: 'outside-ceiling',
			message: 'the repository ceiling admits no push effect for agent s1 (codex)',
		});
		expect(repositoryEffectVerdict(managed(), { ...agentPush, effect: 'clone' })).toMatchObject({
			allowed: true,
		});
	});

	it('holds the repository: unknown, denied before allowed, and outside the allow list', () => {
		expect(repositoryEffectVerdict(managed(), request({ repository: null }))).toMatchObject({
			code: 'repository-unknown',
		});
		expect(repositoryEffectVerdict(managed(), request({ repository: '  ' }))).toMatchObject({
			code: 'repository-unknown',
		});
		expect(
			repositoryEffectVerdict(managed(), request({ repository: 'acme/secrets' }))
		).toMatchObject({
			code: 'repository-denied',
			message: 'the repository ceiling denies acme/secrets',
		});
		expect(
			repositoryEffectVerdict(managed(), request({ repository: 'other/widgets' }))
		).toMatchObject({
			code: 'repository-denied',
			message: 'the repository ceiling does not admit other/widgets',
		});
		expect(
			repositoryEffectVerdict(managed(), request({ repository: 'maestro/MAESTRO' }))
		).toMatchObject({ allowed: true });
	});

	it('holds a remote effect against the destination origin and a local one not at all', () => {
		expect(repositoryEffectVerdict(managed(), request({ remote: null }))).toMatchObject({
			code: 'remote-unknown',
			message: expect.stringContaining('named no remote for this push effect'),
		});
		expect(repositoryEffectVerdict(managed(), request({ remote: 'widgets' }))).toMatchObject({
			code: 'remote-unknown',
			message: expect.stringContaining('not a URL, an scp-style address or a local path'),
		});
		expect(
			repositoryEffectVerdict(
				managed(),
				request({ remote: 'https://gist.github.com/acme/widgets' })
			)
		).toMatchObject({
			code: 'remote-denied',
			message: 'the repository ceiling denies https://gist.github.com',
		});
		expect(
			repositoryEffectVerdict(managed(), request({ remote: 'git@github.com:acme/widgets.git' }))
		).toMatchObject({
			code: 'remote-denied',
			message: 'the repository ceiling does not admit ssh://github.com',
		});
		expect(
			repositoryEffectVerdict(managed(), request({ remote: '/tmp/remotes/acme/widgets.git' }))
		).toMatchObject({ allowed: true, managed: { remote: 'file:' } });
		expect(
			repositoryEffectVerdict(
				managed(),
				request({ effect: 'commit', resource: 'local', remote: null })
			)
		).toEqual({
			allowed: true,
			managed: expect.objectContaining({ effect: 'commit', remote: null }),
		});
	});

	it('admits any repository and remote when the ceiling has no clause for it', () => {
		const open = managed(ceilingOf(document({ repositories: undefined, remotes: undefined })));
		expect(
			repositoryEffectVerdict(open, request({ repository: null, remote: null }))
		).toMatchObject({ allowed: true });
	});

	it('refuses an unbindable actor before the ceiling is read', () => {
		const standing: ManagedRepositoryStanding = {
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'nothing installed',
		};
		expect(repositoryEffectVerdict(standing, request(), ['no actor registered'])).toMatchObject({
			code: 'unauthenticated',
			message: 'no actor registered',
		});
	});
});

describe('createRepositoryPolicySource', () => {
	const enrolled: IdentityRead = {
		status: 'ok',
		record: {
			installationId: 'inst-1',
			tenantId: 'tenant-1',
			deviceId: 'device-1',
			enrolledAt: '2026-10-22T00:00:00.000Z',
			endpoint: { socketPath: '/tmp/endpoint.sock' },
		},
	} as unknown as IdentityRead;
	const registered = {
		...enrolled,
		record: { ...(enrolled as { record: object }).record, registration: { actorId: 'actor-1' } },
	} as unknown as IdentityRead;

	function source(read: IdentityRead, appliedRevision: number | null = 3) {
		return createRepositoryPolicySource({
			identity: { read: () => read },
			policy: () => (appliedRevision === null ? null : { appliedRevision }),
		});
	}

	it('holds nothing on a host that was never enrolled', () => {
		const src = source({ status: 'none' } as IdentityRead);
		expect(src.standing()).toEqual({ standing: 'standalone' });
		expect(src.authorize(request())).toEqual({ allowed: true });
		expect(src.installed()).toBeNull();
	});

	it('refuses by name until a ceiling for the applied revision is installed', () => {
		const src = source(enrolled);
		expect(src.authorize(request())).toMatchObject({
			code: 'unavailable',
			message: expect.stringContaining('no repository ceiling is installed for policy revision 3'),
		});
		expect(src.install(document({ policyRevision: 2 }))).toEqual({
			installed: true,
			policyRevision: 2,
		});
		expect(src.authorize(request())).toMatchObject({
			code: 'unavailable',
			message: expect.stringContaining('is for policy revision 2; this host is under revision 3'),
		});
		expect(src.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(src.authorize(request())).toMatchObject({
			allowed: true,
			managed: { outcome: 'within-ceiling', policyRevision: 3 },
		});
	});

	it('keeps the previous ceiling on a refused document and holds none after clear', () => {
		const src = source(enrolled);
		src.install(document());
		expect(src.install({ policyRevision: 3 })).toEqual({
			installed: false,
			problems: ['actors is not an array'],
		});
		expect(src.installed()?.policyRevision).toBe(3);
		src.clear();
		expect(src.installed()).toBeNull();
		expect(src.authorize(request())).toMatchObject({ code: 'unavailable' });
	});

	it('refuses a paired device before an actor is registered, and admits it after', () => {
		const device = request({
			effect: 'clone',
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'dev-1' } },
		});
		const before = source(enrolled);
		before.install(document({ actors: [{ actor: 'lite-device', effects: ['clone'] }] }));
		expect(before.authorize(device)).toMatchObject({
			code: 'unauthenticated',
			message: expect.stringContaining('a paired Lite device (dev-1)'),
		});
		const after = source(registered);
		after.install(document({ actors: [{ actor: 'lite-device', effects: ['clone'] }] }));
		expect(after.authorize(device)).toMatchObject({ allowed: true });
	});

	it('reads the revision live, so a policy move invalidates the installed ceiling', () => {
		let revision = 3;
		const src = createRepositoryPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: revision }),
		});
		src.install(document());
		expect(src.authorize(request())).toMatchObject({ allowed: true });
		revision = 4;
		expect(src.authorize(request())).toMatchObject({ code: 'unavailable' });
	});
});

describe('repository effects over a local fixture, never an authentication fallback (MRC-09-07)', () => {
	/** The local fixture: a bare repository on this disk is the only remote the ceiling admits. */
	const LOCAL_REMOTE = '/tmp/remotes/acme/widgets.git';
	const localDocument = (effects: readonly RepositoryEffectKind[] = REPOSITORY_EFFECTS) =>
		document({
			actors: [
				{ actor: 'operator', effects: [...effects] },
				{ actor: 'lite-device', effects: [...REPOSITORY_EFFECTS] },
			],
			repositories: { allow: ['acme/*'] },
			remotes: { allow: ['file:'] },
		});
	const enrolled = { status: 'ok', record: { registration: { actorId: 'actor-1' } } };
	const unregistered = { status: 'ok', record: {} };
	const sourceOver = (raw: Record<string, unknown> | null, read: object = enrolled) => {
		const src = createRepositoryPolicySource({
			identity: { read: () => read as IdentityRead },
			policy: () => ({ appliedRevision: 3 }),
		});
		if (raw) {
			const outcome = src.install(raw);
			if (!outcome.installed) throw new Error(outcome.problems.join('; '));
		}
		return src;
	};
	/** The chain a contribution runs, as the runner holds it: each effect by itself, remote ones against the fixture. */
	const chain: Array<[RepositoryEffectKind, RepositoryEffectRequest['resource'], string | null]> = [
		['clone', 'remote', LOCAL_REMOTE],
		['branch', 'local', null],
		['fork', 'remote', LOCAL_REMOTE],
		['commit', 'local', null],
		['push', 'remote', `file://${LOCAL_REMOTE}`],
		['pull-request', 'remote', LOCAL_REMOTE],
		['finalize', 'remote', LOCAL_REMOTE],
		['cancel', 'remote', LOCAL_REMOTE],
	];

	it('admits every effect of a contribution against the local remote, each with its own receipt', () => {
		const src = sourceOver(localDocument());
		for (const [effect, resource, remote] of chain) {
			expect(src.authorize(request({ effect, resource, remote })), effect).toEqual({
				allowed: true,
				managed: {
					policyRevision: 3,
					surface: 'symphony-runner',
					actor: 'the operator',
					effect,
					repository: 'acme/widgets',
					remote: resource === 'remote' ? 'file:' : null,
					outcome: 'within-ceiling',
				},
			});
		}
	});

	it('holds each effect by itself: an admitted clone is no permit for a push the ceiling omits', () => {
		const src = sourceOver(localDocument(['clone', 'branch', 'commit', 'pull-request']));
		expect(src.authorize(request({ effect: 'clone', remote: LOCAL_REMOTE }))).toMatchObject({
			allowed: true,
		});
		expect(src.authorize(request({ effect: 'push', remote: LOCAL_REMOTE }))).toMatchObject({
			allowed: false,
			code: 'outside-ceiling',
			message: 'the repository ceiling admits no push effect for the operator',
			managed: { effect: 'push', outcome: 'outside-ceiling' },
		});
		expect(src.authorize(request({ effect: 'pull-request', remote: LOCAL_REMOTE }))).toMatchObject({
			allowed: true,
		});
	});

	it('never answers a refusal as an authentication failure a login would fix', () => {
		const device: RepositoryEffectRequest['actor'] = {
			kind: 'transport',
			actor: { peer: 'device-pairing', deviceId: 'dev-1' },
		};
		type Overrides = Partial<RepositoryEffectRequest>;
		const refusals: Array<[string, Record<string, unknown> | null, Overrides, object?]> = [
			['unavailable', null, { remote: LOCAL_REMOTE }],
			['unauthenticated', localDocument(), { actor: device, remote: LOCAL_REMOTE }, unregistered],
			['outside-ceiling', localDocument(['branch']), {}],
			['repository-unknown', localDocument(), { repository: null }],
			['repository-denied', localDocument(), { repository: 'acme-x/w' }],
			['remote-unknown', localDocument(), { remote: null }],
			['remote-denied', localDocument(), {}],
		];
		for (const [code, raw, overrides, read] of refusals) {
			const decision: RepositoryEffectDecision = sourceOver(raw, read).authorize(
				request(overrides)
			);
			expect(decision.allowed, code).toBe(false);
			if (decision.allowed) continue;
			expect(decision.code, code).toBe(code);
			expect(decision.managed.outcome, code).toBe(code);
			const asRunnerReports = `[managed-${decision.code}] ${decision.message}`;
			expect(asRunnerReports, code).not.toBe('GitHub CLI not authenticated');
			expect(asRunnerReports, code).not.toMatch(/gh auth|log ?in|logged|credential/i);
			expect(isGitHubAuthError({ message: asRunnerReports, stderr: '' }), code).toBe(false);
			expect(isGitHubMissingScopeError({ message: asRunnerReports }), code).toBe(false);
		}
	});

	it('moves nothing on a refusal: the standing stays managed, the ceiling installed, the next effect held again', () => {
		const src = sourceOver(localDocument(['clone', 'branch', 'commit']));
		expect(src.authorize(request({ remote: LOCAL_REMOTE }))).toMatchObject({
			code: 'outside-ceiling',
		});
		expect(src.standing()).toMatchObject({ standing: 'managed', policyRevision: 3 });
		expect(src.installed()?.policyRevision).toBe(3);
		expect(src.authorize(request({ effect: 'clone', remote: LOCAL_REMOTE }))).toMatchObject({
			allowed: true,
			managed: { outcome: 'within-ceiling' },
		});
		src.clear();
		expect(src.standing()).toMatchObject({ standing: 'managed', ceiling: null });
		expect(src.authorize(request({ effect: 'clone', remote: LOCAL_REMOTE }))).toMatchObject({
			code: 'unavailable',
		});
	});
});
