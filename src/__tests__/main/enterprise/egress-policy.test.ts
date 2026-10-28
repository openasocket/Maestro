/**
 * The egress ceiling (MRC2-05-01): a closed, bounded document of destination
 * patterns per class; one installed ceiling projected onto the standing the
 * fetch chokepoint holds every outbound request against; and the pure verdict
 * that holds a request by class and origin, with a receipt on every managed
 * answer and nothing at all on a standalone host.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	DEFAULT_EGRESS_CLASS,
	EGRESS_CEILING_LIMITS,
	EGRESS_CLASSES,
	EGRESS_OPERATOR,
	EgressDeniedError,
	createEgressPolicySource,
	egressVerdict,
	formatEgressRefusal,
	isEgressAccountRef,
	isEgressClass,
	isEgressDeniedError,
	managedEgressStanding,
	parseEgressPolicyCeiling,
	type EgressPolicyCeiling,
	type EgressRequest,
	type ManagedEgressStanding,
} from '../../../main/enterprise/egress-policy';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		classes: [
			{ class: 'updates', destinations: ['github.com', '*.githubusercontent.com'] },
			{ class: 'content', destinations: ['*'] },
			{
				class: 'provider-account',
				destinations: ['https://chatgpt.com:443'],
				accounts: [APPROVED_ACCOUNT.accountRef],
			},
		],
		...overrides,
	};
}

/** An account the fixture ceiling approves, named the way a sink names it. */
const APPROVED_ACCOUNT = { providerId: 'codex', accountRef: 'a'.repeat(64) } as const;
/** An account no ceiling here lists: a personal login on a managed host. */
const PERSONAL_ACCOUNT = { providerId: 'codex', accountRef: 'b'.repeat(64) } as const;

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseEgressPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): EgressPolicyCeiling {
	const parsed = parseEgressPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedEgressStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<EgressRequest> = {}): EgressRequest {
	return {
		url: 'https://github.com/RunMaestro/Maestro/releases/latest',
		class: 'updates',
		...overrides,
	};
}

describe('EGRESS_CLASSES', () => {
	it('is the closed list the document names, with content as the default', () => {
		expect([...EGRESS_CLASSES]).toEqual([
			'vendor-telemetry',
			'updates',
			'provider-account',
			'content',
			'github',
			'plugin',
			'user-webhook',
			'enterprise-endpoint',
		]);
		expect(DEFAULT_EGRESS_CLASS).toBe('content');
		expect(isEgressClass('github')).toBe(true);
		expect(isEgressClass('telemetry')).toBe(false);
		expect(isEgressClass(undefined)).toBe(false);
		expect(EGRESS_OPERATOR).toEqual({ kind: 'transport', actor: { peer: 'in-process' } });
	});
});

describe('parseEgressPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseEgressPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			classes: [
				{ class: 'updates', destinations: ['github.com', '*.githubusercontent.com'] },
				{ class: 'content', destinations: ['*'] },
				{
					class: 'provider-account',
					destinations: ['https://chatgpt.com:443'],
					accounts: [APPROVED_ACCOUNT.accountRef],
				},
			],
		});
		(raw.classes as Array<{ destinations: string[] }>)[0].destinations.push('evil.example');
		expect(parsed.ceiling.classes[0].destinations).toEqual([
			'github.com',
			'*.githubusercontent.com',
		]);
	});

	it('accepts an empty class list (nothing leaves) and an empty destination list', () => {
		expect(parseEgressPolicyCeiling(document({ classes: [] }))).toEqual({
			ok: true,
			ceiling: { policyRevision: 3, classes: [] },
		});
		expect(
			parseEgressPolicyCeiling(document({ classes: [{ class: 'github', destinations: [] }] })).ok
		).toBe(true);
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the egress ceiling is not an object']);
		expect(problemsOf(document({ extra: 1 }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: 1.5 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ classes: 'all' }))).toEqual(['classes is not an array']);
		expect(problemsOf(document({ classes: [null] }))).toEqual(['classes[0] is not an object']);
		expect(
			problemsOf(document({ classes: [{ class: 'telemetry', destinations: ['*'] }] }))
		).toEqual(['classes[0].class is not an egress class']);
		expect(
			problemsOf(document({ classes: [{ class: 'github', destinations: ['*'], note: 'x' }] }))
		).toEqual(['classes[0].note is not a known key']);
		expect(
			problemsOf(document({ classes: [{ class: 'github', destinations: ['not a host'] }] }))
		).toEqual(['classes[0].destinations[0] is not a destination pattern']);
		expect(
			problemsOf(document({ classes: [{ class: 'github', destinations: 'github.com' }] }))
		).toEqual(['classes[0].destinations is not an array']);
	});

	it('accepts approved accounts on the provider-account class alone, as opaque references (MRC2-05-05)', () => {
		// Absent is not the same as empty: both approve none, and a class that
		// never named the key stays without it rather than growing an empty list.
		const bare = ceilingOf(
			document({ classes: [{ class: 'provider-account', destinations: ['chatgpt.com'] }] })
		);
		expect(bare.classes[0]).toEqual({ class: 'provider-account', destinations: ['chatgpt.com'] });
		expect(bare.classes[0]).not.toHaveProperty('accounts');
		const empty = ceilingOf(
			document({
				classes: [{ class: 'provider-account', destinations: ['chatgpt.com'], accounts: [] }],
			})
		);
		expect(empty.classes[0].accounts).toEqual([]);
		expect(
			problemsOf(document({ classes: [{ class: 'content', destinations: ['*'], accounts: [] }] }))
		).toEqual(['classes[0].accounts is only for the provider-account class']);
		expect(
			problemsOf(
				document({
					classes: [{ class: 'provider-account', destinations: ['chatgpt.com'], accounts: 'all' }],
				})
			)
		).toEqual(['classes[0].accounts is not an array']);
		expect(
			problemsOf(
				document({
					classes: [
						{
							class: 'provider-account',
							destinations: ['chatgpt.com'],
							accounts: ['', '/Users/me/.codex', 'has space', 'x'.repeat(257)],
						},
					],
				})
			)
		).toEqual([
			'classes[0].accounts[0] is not an account reference',
			'classes[0].accounts[1] is not an account reference',
			'classes[0].accounts[2] is not an account reference',
			'classes[0].accounts[3] is not an account reference',
		]);
		const many = Array.from({ length: EGRESS_CEILING_LIMITS.accounts + 1 }, (_, i) => `acct-${i}`);
		expect(
			problemsOf(
				document({
					classes: [{ class: 'provider-account', destinations: ['chatgpt.com'], accounts: many }],
				})
			)
		).toEqual([`classes[0].accounts exceeds ${EGRESS_CEILING_LIMITS.accounts} entries`]);
		expect(isEgressAccountRef(APPROVED_ACCOUNT.accountRef)).toBe(true);
		expect(isEgressAccountRef('codex:work-1')).toBe(true);
		expect(isEgressAccountRef('')).toBe(false);
		expect(isEgressAccountRef('me@example.com/home')).toBe(false);
	});

	it('refuses a class named twice and more classes than exist', () => {
		expect(
			problemsOf(
				document({
					classes: [
						{ class: 'github', destinations: ['*'] },
						{ class: 'github', destinations: ['api.github.com'] },
					],
				})
			)
		).toEqual(['classes[1].class "github" is named twice']);
		const tooMany = Array.from({ length: EGRESS_CLASSES.length + 1 }, () => ({
			class: 'content',
			destinations: ['*'],
		}));
		expect(problemsOf(document({ classes: tooMany }))).toEqual([
			`classes exceeds ${EGRESS_CLASSES.length} entries`,
		]);
		const wide = Array.from({ length: EGRESS_CEILING_LIMITS.destinations + 1 }, () => '*');
		expect(problemsOf(document({ classes: [{ class: 'content', destinations: wide }] }))).toEqual([
			`classes[0].destinations exceeds ${EGRESS_CEILING_LIMITS.destinations} entries`,
		]);
	});
});

describe('managedEgressStanding', () => {
	it('is standalone when not enrolled, whatever else is known', () => {
		expect(managedEgressStanding({ enrolled: false, policy: null, ceiling: null })).toEqual({
			standing: 'standalone',
		});
		expect(
			managedEgressStanding({
				enrolled: false,
				policy: { appliedRevision: 3 },
				ceiling: ceilingOf(),
			})
		).toEqual({ standing: 'standalone' });
	});

	it('names why no ceiling binds once enrolled', () => {
		expect(managedEgressStanding({ enrolled: true, policy: null, ceiling: ceilingOf() })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(
			managedEgressStanding({ enrolled: true, policy: { appliedRevision: 3 }, ceiling: null })
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no egress ceiling is installed for policy revision 3',
		});
		expect(
			managedEgressStanding({
				enrolled: true,
				policy: { appliedRevision: 4 },
				ceiling: ceilingOf(),
			})
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 4,
			reason:
				'the installed egress ceiling is for policy revision 3; this host is under revision 4',
		});
	});

	it('binds the ceiling of the applied revision', () => {
		expect(
			managedEgressStanding({
				enrolled: true,
				policy: { appliedRevision: 3 },
				ceiling: ceilingOf(),
			})
		).toEqual(managed());
	});
});

describe('egressVerdict', () => {
	it('allows everything standalone with no receipt, even a bad URL', () => {
		expect(egressVerdict({ standing: 'standalone' }, request())).toEqual({ allowed: true });
		expect(egressVerdict({ standing: 'standalone' }, request({ url: 'not a url' }))).toEqual({
			allowed: true,
		});
	});

	it('refuses unavailable with a receipt when no ceiling binds', () => {
		const decision = egressVerdict(
			{
				standing: 'managed',
				ceiling: null,
				policyRevision: 3,
				reason: 'no egress ceiling is installed for policy revision 3',
			},
			request()
		);
		expect(decision).toEqual({
			allowed: false,
			code: 'unavailable',
			message:
				'the managed egress ceiling is unavailable (no egress ceiling is installed for policy revision 3)',
			managed: {
				policyRevision: 3,
				class: 'updates',
				actor: 'the operator',
				origin: 'https://github.com',
				outcome: 'unavailable',
			},
		});
	});

	it('refuses unauthenticated first, before the ceiling is read', () => {
		const decision = egressVerdict(managed(), request(), ['no actor is registered']);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('unauthenticated');
		expect(decision.message).toBe('no actor is registered');
	});

	it('admits a listed class to a listed destination with a receipt naming the origin only', () => {
		const decision = egressVerdict(
			managed(),
			request({ url: 'https://objects.githubusercontent.com/release/Maestro.dmg?token=secret' })
		);
		expect(decision).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				class: 'updates',
				actor: 'the operator',
				origin: 'https://objects.githubusercontent.com',
				outcome: 'within-ceiling',
			},
		});
	});

	it('holds the class the sink named, so vendor telemetry leaves only when listed', () => {
		const decision = egressVerdict(
			managed(),
			request({ url: 'https://api.runmaestro.ai/checkin', class: 'vendor-telemetry' })
		);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('class-denied');
		expect(decision.message).toBe(
			'the egress ceiling admits no vendor-telemetry request for the operator; a request of this class leaves only when the policy lists the class'
		);
		expect(decision.managed.outcome).toBe('class-denied');
		const listed = ceilingOf(
			document({
				classes: [{ class: 'vendor-telemetry', destinations: ['api.runmaestro.ai'] }],
			})
		);
		expect(
			egressVerdict(
				managed(listed),
				request({ url: 'https://api.runmaestro.ai/checkin', class: 'vendor-telemetry' })
			).allowed
		).toBe(true);
	});

	it('refuses a destination the class does not list, by origin', () => {
		const decision = egressVerdict(
			managed(),
			request({ url: 'https://evil.example/releases/latest', class: 'updates' })
		);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('destination-denied');
		expect(decision.message).toBe(
			'the egress ceiling does not list https://evil.example for updates requests by the operator; a request leaves only for a destination the policy lists'
		);
		const port = egressVerdict(
			managed(),
			request({ url: 'https://chatgpt.com:8443/backend-api/usage', class: 'provider-account' })
		);
		expect(port.allowed).toBe(false);
		const scheme = egressVerdict(
			managed(),
			request({ url: 'http://chatgpt.com/backend-api/usage', class: 'provider-account' })
		);
		expect(scheme.allowed).toBe(false);
		expect(
			egressVerdict(
				managed(),
				request({
					url: 'https://chatgpt.com/backend-api/usage',
					class: 'provider-account',
					account: APPROVED_ACCOUNT,
				})
			).allowed
		).toBe(true);
	});

	it('holds a provider-account request by the account it names, after the destination (MRC2-05-05)', () => {
		const poll = (account?: EgressRequest['account'], ceiling = ceilingOf()) =>
			egressVerdict(
				managed(ceiling),
				request({
					url: 'https://chatgpt.com/backend-api/wham/usage',
					class: 'provider-account',
					account,
				})
			);
		const approved = poll(APPROVED_ACCOUNT);
		expect(approved).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				class: 'provider-account',
				actor: 'the operator',
				origin: 'https://chatgpt.com',
				account: APPROVED_ACCOUNT.accountRef,
				outcome: 'within-ceiling',
			},
		});

		// A personal login on a managed host: the class and the destination are
		// listed, the account is not, and the refusal names the account by its
		// opaque reference, never by a path or an e-mail.
		const personal = poll(PERSONAL_ACCOUNT);
		expect(personal.allowed).toBe(false);
		if (personal.allowed) return;
		expect(personal.code).toBe('account-denied');
		expect(personal.message).toBe(
			`the egress ceiling approves no codex account ${'b'.repeat(12)} for provider-account requests by the operator to https://chatgpt.com; a personal account is never polled from a managed host`
		);
		expect(personal.managed).toEqual({
			policyRevision: 3,
			class: 'provider-account',
			actor: 'the operator',
			origin: 'https://chatgpt.com',
			account: PERSONAL_ACCOUNT.accountRef,
			outcome: 'account-denied',
		});

		// A sink that names no account is refused too: the policy cannot approve
		// what it cannot see.
		const anonymous = poll(undefined);
		expect(anonymous.allowed).toBe(false);
		if (anonymous.allowed) return;
		expect(anonymous.code).toBe('account-denied');
		expect(anonymous.message).toBe(
			'a provider-account request for the operator to https://chatgpt.com names no account; a provider account is polled from a managed host only when the policy approves it'
		);
		expect(anonymous.managed).not.toHaveProperty('account');

		// A class that lists no accounts approves none, even the one a sink names.
		const unlisted = ceilingOf(
			document({ classes: [{ class: 'provider-account', destinations: ['chatgpt.com'] }] })
		);
		const none = poll(APPROVED_ACCOUNT, unlisted);
		expect(none.allowed).toBe(false);
		if (!none.allowed) expect(none.code).toBe('account-denied');

		// The destination is held first, so an unlisted origin never reads as an
		// account problem; and no other class carries an account.
		const elsewhere = egressVerdict(
			managed(),
			request({
				url: 'https://evil.example/usage',
				class: 'provider-account',
				account: APPROVED_ACCOUNT,
			})
		);
		expect(elsewhere.allowed).toBe(false);
		if (!elsewhere.allowed) expect(elsewhere.code).toBe('destination-denied');
		expect(
			egressVerdict(managed(), request({ url: 'https://models.dev/api.json', class: 'content' }))
				.allowed
		).toBe(true);
	});

	it('refuses a URL with no http(s) origin before any class is read', () => {
		for (const url of ['not a url', 'file:///etc/hosts', 'about:blank', '']) {
			const decision = egressVerdict(managed(), request({ url, class: 'content' }));
			expect(decision.allowed).toBe(false);
			if (decision.allowed) continue;
			expect(decision.code).toBe('url-invalid');
			expect(decision.managed.origin).toBeNull();
		}
		const ftp = egressVerdict(
			managed(),
			request({ url: 'ftp://files.example/x', class: 'content' })
		);
		expect(ftp.allowed).toBe(false);
		if (!ftp.allowed) expect(ftp.code).toBe('url-invalid');
		if (!ftp.allowed) expect(ftp.managed.origin).toBe('ftp://files.example');
	});

	it('names the actor who asked, defaulting to the operator', () => {
		const agent = egressVerdict(
			managed(),
			request({
				url: 'https://evil.example/',
				class: 'content',
				actor: { kind: 'agent', sessionId: 's1', agentType: 'claude-code' },
			})
		);
		expect(agent.allowed).toBe(true);
		if (agent.allowed) expect(agent.managed?.actor).toBe('agent s1 (claude-code)');
		const defaulted = egressVerdict(managed(), request({ class: 'content' }));
		if (defaulted.allowed) expect(defaulted.managed?.actor).toBe('the operator');
	});

	it('formats a refusal as one managed line and the error carries it', () => {
		const decision = egressVerdict(managed(), request({ class: 'github' }));
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(formatEgressRefusal(decision)).toBe(`[managed-class-denied] ${decision.message}`);
		const error = new EgressDeniedError(decision, request().url);
		expect(error.message).toBe(formatEgressRefusal(decision));
		expect(error.name).toBe('EgressDeniedError');
		expect(error.code).toBe('class-denied');
		expect(error.class).toBe('github');
		expect(error.url).toBe(request().url);
		expect(error.receipt).toEqual(decision.managed);
		expect(isEgressDeniedError(error)).toBe(true);
		expect(isEgressDeniedError(new Error(error.message))).toBe(false);
	});
});

describe('createEgressPolicySource', () => {
	const none: IdentityRead = { status: 'none' };
	const enrolled = (actorId: string | null): IdentityRead =>
		({
			status: 'ok',
			epoch: 1,
			record: {
				registration: actorId ? { actorId, registeredAt: 1 } : undefined,
				policy: { appliedRevision: 3, appliedAt: 1 },
			},
		}) as never;

	function source(read: IdentityRead, revision: number | null = 3) {
		return createEgressPolicySource({
			identity: { read: () => read },
			policy: () => (revision === null ? null : { appliedRevision: revision }),
		});
	}

	it('holds nothing standalone and refuses unavailable once enrolled with no ceiling', () => {
		expect(source(none).standing()).toEqual({ standing: 'standalone' });
		expect(source(none).evaluateEgress(request({ url: 'anything' }))).toEqual({ allowed: true });
		const decision = source(enrolled('actor')).evaluateEgress(request());
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe('unavailable');
	});

	it('installs a valid ceiling, keeps the previous one on a refused document, and clears', () => {
		const s = source(enrolled('actor'));
		expect(s.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(s.installed()).toEqual(ceilingOf());
		expect(s.evaluateEgress(request()).allowed).toBe(true);
		expect(s.install(document({ extra: 1 }))).toEqual({
			installed: false,
			problems: ['extra is not a known key'],
		});
		expect(s.installed()).toEqual(ceilingOf());
		s.clear();
		expect(s.installed()).toBeNull();
		expect(s.evaluateEgress(request()).allowed).toBe(false);
	});

	it('refuses a ceiling of another revision unavailable until the host catches up', () => {
		const s = source(enrolled('actor'), 4);
		s.install(document());
		const decision = s.evaluateEgress(request());
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe('unavailable');
		expect(source(enrolled('actor'), null).evaluateEgress(request()).allowed).toBe(false);
	});

	it('refuses a paired device unauthenticated until an actor is registered', () => {
		const device = request({
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } as never },
		});
		const unregistered = source(enrolled(null));
		unregistered.install(document());
		const refused = unregistered.evaluateEgress(device);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) expect(refused.code).toBe('unauthenticated');
		const registered = source(enrolled('actor'));
		registered.install(document());
		expect(registered.evaluateEgress(device).allowed).toBe(true);
	});
});

describe('desktop wiring', () => {
	const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8');

	it('composes one egress source over the enterprise service and installs it on the chokepoint', () => {
		expect(source.match(/createEgressPolicySource\(\{/g)).toHaveLength(1);
		expect(source).toMatch(
			/const egressPolicy = createEgressPolicySource\(\{\n\t+identity: \{ read: \(\) => enterpriseService\?\.identity\.read\(\) \?\? \{ status: 'none' \} \},\n\t+policy: \(\) => enterpriseService\?\.policy\.status\(\) \?\? null,\n\t+\}\);\n\t+setEgressAuthority\(egressPolicy\);/
		);
		expect(source.match(/setEgressAuthority\(/g)).toHaveLength(1);
		expect(source.indexOf('setEgressAuthority(egressPolicy)')).toBeGreaterThan(
			source.indexOf('setMcpInstallAuthority(installPolicy)')
		);
	});
});
