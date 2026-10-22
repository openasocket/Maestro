/**
 * The browser ceiling (MRC-09-04): a closed, bounded document schema that
 * refuses by name; one installed ceiling projected onto the standing the
 * relay and the coworking bridge hold every effect against; and the pure
 * verdict that binds the actor (which transport, or which agent), the effect
 * and the destination origin, with a receipt on every managed answer and
 * nothing at all on a standalone host.
 */

import { describe, expect, it } from 'vitest';

import {
	BROWSER_CEILING_LIMITS,
	browserActorLabel,
	browserDestinationOrigin,
	browserEffectVerdict,
	createBrowserPolicySource,
	managedBrowserStanding,
	matchesBrowserDestination,
	parseBrowserPolicyCeiling,
	type BrowserEffectRequest,
	type BrowserPolicyCeiling,
	type ManagedBrowserStanding,
} from '../../../main/enterprise/browser-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		actors: [
			{ actor: 'operator', effects: ['view', 'read', 'navigate', 'input', 'execute', 'clear'] },
			{ actor: 'web-login', effects: ['view', 'read', 'navigate', 'input'] },
			{ actor: 'agent', effects: ['view', 'read'] },
		],
		destinations: {
			allow: ['https://*.example.com', 'localhost:5173', 'about:blank'],
			deny: ['https://admin.example.com'],
		},
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseBrowserPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): BrowserPolicyCeiling {
	const parsed = parseBrowserPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedBrowserStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<BrowserEffectRequest> = {}): BrowserEffectRequest {
	return {
		surface: 'relay',
		effect: 'view',
		actor: { kind: 'transport', actor: { peer: 'in-process' } },
		resource: 'page',
		destination: 'https://app.example.com/path?token=secret#frag',
		...overrides,
	};
}

describe('parseBrowserPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseBrowserPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			actors: [
				{ actor: 'operator', effects: ['view', 'read', 'navigate', 'input', 'execute', 'clear'] },
				{ actor: 'web-login', effects: ['view', 'read', 'navigate', 'input'] },
				{ actor: 'agent', effects: ['view', 'read'] },
			],
			destinations: {
				allow: ['https://*.example.com', 'localhost:5173', 'about:blank'],
				deny: ['https://admin.example.com'],
			},
		});
		(raw.actors as unknown[]).push({ actor: 'maestro-cli', effects: ['execute'] });
		((raw.destinations as Record<string, string[]>).allow as string[]).push('*');
		expect(parsed.ceiling.actors).toHaveLength(3);
		expect(parsed.ceiling.destinations?.allow).toHaveLength(3);
	});

	it('accepts a document with no destinations clause and an empty actor list', () => {
		const parsed = parseBrowserPolicyCeiling({ policyRevision: 0, actors: [] });
		expect(parsed).toEqual({ ok: true, ceiling: { policyRevision: 0, actors: [] } });
	});

	it('refuses a non-object, unknown keys at every level and a malformed revision by path', () => {
		expect(problemsOf(null)).toEqual(['the browser ceiling is not an object']);
		expect(problemsOf([])).toEqual(['the browser ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: '3' }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(
			problemsOf(document({ actors: [{ actor: 'operator', effects: ['view'], names: ['x'] }] }))
		).toEqual(['actors[0].names is not a known key']);
		expect(problemsOf(document({ destinations: { allow: [], block: [] } }))).toEqual([
			'destinations.block is not a known key',
		]);
	});

	it('refuses every malformed actor entry by path and a kind named twice', () => {
		expect(problemsOf(document({ actors: 'all' }))).toEqual(['actors is not an array']);
		expect(problemsOf(document({ actors: [1] }))).toEqual(['actors[0] is not an object']);
		expect(problemsOf(document({ actors: [{ actor: 'root', effects: ['view'] }] }))).toEqual([
			'actors[0].actor is not a browser actor kind',
		]);
		expect(problemsOf(document({ actors: [{ actor: 'agent', effects: 'view' }] }))).toEqual([
			'actors[0].effects is not an array',
		]);
		expect(
			problemsOf(document({ actors: [{ actor: 'agent', effects: ['view', 'shell', ''] }] }))
		).toEqual([
			'actors[0].effects[1] is not a browser effect kind',
			'actors[0].effects[2] is not a browser effect kind',
		]);
		expect(
			problemsOf(
				document({
					actors: [
						{ actor: 'agent', effects: ['view'] },
						{ actor: 'agent', effects: ['read'] },
					],
				})
			)
		).toEqual(['actors[1].actor "agent" is named twice']);
	});

	it('refuses malformed destinations and every pattern that is not an origin pattern', () => {
		expect(problemsOf(document({ destinations: [] }))).toEqual(['destinations is not an object']);
		expect(problemsOf(document({ destinations: { allow: 'all' } }))).toEqual([
			'destinations.allow is not an array',
		]);
		expect(
			problemsOf(
				document({
					destinations: {
						deny: ['https://ok.example', 'https://x/path', 'javascript:alert(1)', '*.', 42],
					},
				})
			)
		).toEqual([
			'destinations.deny[1] is not a destination pattern',
			'destinations.deny[2] is not a destination pattern',
			'destinations.deny[3] is not a destination pattern',
			'destinations.deny[4] is not a destination pattern',
		]);
	});

	it('refuses, never truncates, a document past a bound', () => {
		const actors = Array.from({ length: BROWSER_CEILING_LIMITS.actors + 1 }, () => ({
			actor: 'agent',
			effects: ['view'],
		}));
		expect(problemsOf(document({ actors }))).toEqual([
			`actors exceeds ${BROWSER_CEILING_LIMITS.actors} entries`,
		]);
		const allow = Array.from({ length: BROWSER_CEILING_LIMITS.patterns + 1 }, () => '*');
		expect(problemsOf(document({ destinations: { allow } }))).toEqual([
			`destinations.allow exceeds ${BROWSER_CEILING_LIMITS.patterns} entries`,
		]);
		const long = `https://${'a'.repeat(BROWSER_CEILING_LIMITS.patternLength)}.example`;
		expect(problemsOf(document({ destinations: { allow: [long] } }))).toEqual([
			'destinations.allow[0] is not a destination pattern',
		]);
		expect(
			problemsOf(document({ actors: [{ actor: 'agent', effects: Array(7).fill('view') }] }))
		).toEqual(['actors[0].effects exceeds 6 entries']);
	});
});

describe('managedBrowserStanding', () => {
	const ceiling = ceilingOf();
	it('is standalone while never enrolled, whatever is installed', () => {
		expect(managedBrowserStanding({ enrolled: false, policy: null, ceiling })).toEqual({
			standing: 'standalone',
		});
	});
	it('names each reason a ceiling is unusable and binds a usable one to the applied revision', () => {
		expect(managedBrowserStanding({ enrolled: true, policy: null, ceiling })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(
			managedBrowserStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no browser ceiling is installed for policy revision 3',
		});
		expect(
			managedBrowserStanding({ enrolled: true, policy: { appliedRevision: 4 }, ceiling })
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 4,
			reason:
				'the installed browser ceiling is for policy revision 3; this host is under revision 4',
		});
		expect(
			managedBrowserStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling })
		).toEqual({
			standing: 'managed',
			ceiling,
			policyRevision: 3,
		});
	});
});

describe('browser destinations', () => {
	it('reduces a destination to its origin and refuses what is not an explicit URL', () => {
		expect(browserDestinationOrigin('https://App.Example.com/path?token=secret#x')).toBe(
			'https://app.example.com'
		);
		expect(browserDestinationOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
		expect(browserDestinationOrigin(' ABOUT:BLANK ')).toBe('about:blank');
		expect(browserDestinationOrigin('example.com')).toBeNull();
		expect(browserDestinationOrigin('how to bake bread')).toBeNull();
		expect(browserDestinationOrigin('javascript:alert(1)')).toBeNull();
		expect(browserDestinationOrigin(null)).toBeNull();
	});

	it.each([
		['https://app.example.com', '*', true],
		['https://app.example.com', 'https://*.example.com', true],
		['https://example.com', 'https://*.example.com', true],
		['https://evil-example.com', 'https://*.example.com', false],
		['https://app.example.com', 'https://app.example.com', true],
		['https://app.example.com', 'http://app.example.com', false],
		['http://app.example.com', 'app.example.com', true],
		['https://app.example.com', 'app.example.com', true],
		['ftp://app.example.com', 'app.example.com', false],
		['ftp://app.example.com', 'ftp://app.example.com', true],
		['http://localhost:5173', 'localhost:5173', true],
		['http://localhost:5174', 'localhost:5173', false],
		['https://app.example.com', 'https://app.example.com:443', true],
		['https://app.example.com:8443', 'https://app.example.com', true],
		['about:blank', 'about:blank', true],
		['about:blank', '*', true],
		['about:blank', '*.example.com', false],
		['https://app.example.com', 'about:blank', false],
	])('%s against %s is %s', (origin, pattern, expected) => {
		expect(matchesBrowserDestination(origin, pattern)).toBe(expected);
	});
});

describe('browserEffectVerdict', () => {
	it('answers allowed with no receipt on a standalone host', () => {
		expect(
			browserEffectVerdict({ standing: 'standalone' }, request({ effect: 'execute' }))
		).toEqual({ allowed: true });
	});

	it('refuses by name, with a receipt, when no usable ceiling is installed', () => {
		const decision = browserEffectVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'none installed' },
			request()
		);
		expect(decision).toEqual({
			allowed: false,
			code: 'unavailable',
			message: 'the managed browser ceiling is unavailable (none installed)',
			managed: {
				policyRevision: 3,
				surface: 'relay',
				actor: 'the operator',
				effect: 'view',
				destination: 'https://app.example.com',
				outcome: 'unavailable',
			},
		});
	});

	it('admits an effect within the ceiling with a receipt naming the actor, effect and origin only', () => {
		const decision = browserEffectVerdict(
			managed(),
			request({
				actor: { kind: 'transport', actor: { peer: 'web-login', username: 'ada' } },
				effect: 'input',
			})
		);
		expect(decision).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				surface: 'relay',
				actor: 'web-login:ada',
				effect: 'input',
				destination: 'https://app.example.com',
				outcome: 'within-ceiling',
			},
		});
	});

	it('refuses an actor kind the ceiling omits and an effect the ceiling omits for the actor', () => {
		const cli = browserEffectVerdict(
			managed(),
			request({ actor: { kind: 'transport', actor: { peer: 'host-secret' } } })
		);
		expect(cli).toMatchObject({
			allowed: false,
			code: 'outside-ceiling',
			message: 'the browser ceiling admits no browser effect for maestro-cli',
		});
		const agent = browserEffectVerdict(
			managed(),
			request({
				surface: 'coworking',
				actor: { kind: 'agent', sessionId: 'sess-A', agentType: 'codex' },
				effect: 'execute',
			})
		);
		expect(agent).toMatchObject({
			allowed: false,
			code: 'outside-ceiling',
			message: 'the browser ceiling admits no execute effect for agent sess-A (codex)',
			managed: { surface: 'coworking', actor: 'agent sess-A (codex)', outcome: 'outside-ceiling' },
		});
		expect(
			browserEffectVerdict(
				managed(),
				request({
					actor: { kind: 'transport', actor: { peer: 'web-login', username: 'ada' } },
					effect: 'execute',
				})
			)
		).toMatchObject({ code: 'outside-ceiling' });
	});

	it('holds a page effect against the destination: deny before allow, and unknown refused by name', () => {
		expect(
			browserEffectVerdict(managed(), request({ destination: 'https://admin.example.com/x' }))
		).toMatchObject({
			code: 'destination-denied',
			message: 'the browser ceiling denies https://admin.example.com',
		});
		expect(
			browserEffectVerdict(managed(), request({ destination: 'https://other.test/' }))
		).toMatchObject({
			code: 'destination-denied',
			message: 'the browser ceiling does not admit https://other.test',
		});
		expect(browserEffectVerdict(managed(), request({ destination: null }))).toMatchObject({
			code: 'destination-unknown',
			message:
				'the host observed no page for this view effect; the browser ceiling admits only a known destination',
			managed: { destination: null },
		});
		expect(
			browserEffectVerdict(managed(), request({ effect: 'navigate', destination: 'bake bread' }))
		).toMatchObject({
			code: 'destination-unknown',
			message:
				'the destination is not an explicit URL; the browser ceiling admits no search query or bare host',
		});
		expect(
			browserEffectVerdict(managed(), request({ effect: 'navigate', destination: 'about:blank' }))
		).toMatchObject({ allowed: true, managed: { destination: 'about:blank' } });
	});

	it('holds a session effect (a list, a terminal) by actor and effect alone, never a destination', () => {
		expect(
			browserEffectVerdict(
				managed(),
				request({
					surface: 'coworking',
					actor: { kind: 'agent', sessionId: 'sess-A', agentType: null },
					effect: 'read',
					resource: 'session',
					destination: null,
				})
			)
		).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				surface: 'coworking',
				actor: 'agent sess-A',
				effect: 'read',
				destination: null,
				outcome: 'within-ceiling',
			},
		});
	});

	it('does not hold destinations when the ceiling has no destinations clause', () => {
		const ceiling = ceilingOf(document({ destinations: undefined }));
		expect(
			browserEffectVerdict(managed(ceiling), request({ destination: 'https://anything.test' }))
		).toMatchObject({ allowed: true });
		expect(browserEffectVerdict(managed(ceiling), request({ destination: null }))).toMatchObject({
			allowed: true,
		});
	});

	it('refuses an actor the caller could not bind before the ceiling is read', () => {
		const decision = browserEffectVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'none' },
			request({ actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } } }),
			['a paired Lite device (d1) admits its transport only']
		);
		expect(decision).toMatchObject({
			code: 'unauthenticated',
			message: 'a paired Lite device (d1) admits its transport only',
			managed: { actor: 'lite-device:d1', outcome: 'unauthenticated' },
		});
	});

	it('labels every actor the way the sinks name them', () => {
		expect(browserActorLabel({ kind: 'transport', actor: { peer: 'in-process' } })).toEqual([
			'operator',
			'the operator',
		]);
		expect(browserActorLabel({ kind: 'transport', actor: { peer: 'host-secret' } })).toEqual([
			'maestro-cli',
			'maestro-cli',
		]);
		expect(
			browserActorLabel({ kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } })
		).toEqual(['lite-device', 'lite-device:d1']);
	});
});

describe('createBrowserPolicySource', () => {
	const enrolled: IdentityRead = {
		status: 'ok',
		epoch: 1,
		record: { registration: { actorId: 'actor-1' } } as never,
	};
	const unregistered: IdentityRead = { status: 'ok', epoch: 1, record: {} as never };

	function source(read: IdentityRead, appliedRevision: number | null = 3) {
		return createBrowserPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision }),
		});
	}

	it('is standalone while never enrolled and holds nothing, whatever is installed', () => {
		const src = source({ status: 'none' });
		expect(src.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(src.standing()).toEqual({ standing: 'standalone' });
		expect(src.authorize(request({ effect: 'execute' }))).toEqual({ allowed: true });
	});

	it('refuses by name once enrolled until a ceiling for the applied revision is installed', () => {
		const src = source(enrolled);
		expect(src.authorize(request())).toMatchObject({
			code: 'unavailable',
			message:
				'the managed browser ceiling is unavailable (no browser ceiling is installed for policy revision 3)',
		});
		expect(src.install(document({ policyRevision: 2 }))).toEqual({
			installed: true,
			policyRevision: 2,
		});
		expect(src.authorize(request())).toMatchObject({
			code: 'unavailable',
			message:
				'the managed browser ceiling is unavailable (the installed browser ceiling is for policy revision 2; this host is under revision 3)',
		});
		expect(src.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(src.authorize(request())).toMatchObject({
			allowed: true,
			managed: { policyRevision: 3 },
		});
		expect(src.installed()?.policyRevision).toBe(3);
	});

	it('keeps the previous installation on a refused document and holds nothing after clear', () => {
		const src = source(enrolled);
		src.install(document());
		expect(src.install(document({ actors: 'all' }))).toEqual({
			installed: false,
			problems: ['actors is not an array'],
		});
		expect(src.installed()?.policyRevision).toBe(3);
		src.clear();
		expect(src.installed()).toBeNull();
		expect(src.authorize(request())).toMatchObject({ code: 'unavailable' });
	});

	it('refuses a paired device as unauthenticated until an actor is registered, by the spawn authority rule', () => {
		const device = request({
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } },
		});
		const before = source(unregistered);
		before.install(document({ actors: [{ actor: 'lite-device', effects: ['view'] }] }));
		expect(before.authorize(device)).toMatchObject({
			code: 'unauthenticated',
			message: expect.stringContaining('a paired Lite device (d1) admits its transport only'),
		});
		const after = source(enrolled);
		after.install(document({ actors: [{ actor: 'lite-device', effects: ['view'] }] }));
		expect(after.authorize(device)).toMatchObject({ allowed: true });
		expect(after.authorize({ ...device, effect: 'input' })).toMatchObject({
			code: 'outside-ceiling',
		});
	});

	it('reads the standing live: a revision move refuses the next call, unprotected custody stays managed, never back to standalone until the record is gone', () => {
		let read: IdentityRead = enrolled;
		let revision: number | null = 3;
		const src = createBrowserPolicySource({
			identity: { read: () => read },
			policy: () => ({ appliedRevision: revision }),
		});
		src.install(document());
		expect(src.authorize(request())).toMatchObject({ allowed: true });
		revision = 4;
		expect(src.authorize(request())).toMatchObject({ code: 'unavailable' });
		revision = 3;
		read = { status: 'unprotected', reason: 'plaintext' as never, message: 'x', fileExists: true };
		expect(src.standing().standing).toBe('managed');
		expect(src.authorize(request())).toMatchObject({
			allowed: true,
			managed: { policyRevision: 3 },
		});
		read = { status: 'none' };
		expect(src.authorize(request({ effect: 'execute' }))).toEqual({ allowed: true });
	});
});
