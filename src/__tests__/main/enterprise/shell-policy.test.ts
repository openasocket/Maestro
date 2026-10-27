/**
 * The shell ceiling (MRC2-04-06): a closed, bounded document of exact command
 * strings per surface; one installed ceiling projected onto the standing the
 * notification command runner holds every configured command against; and the
 * pure verdict that compares the command the sink is about to run with the
 * ceiling character for character, with a receipt on every managed answer
 * and nothing at all on a standalone host.
 */

import { describe, expect, it } from 'vitest';

import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	SHELL_CEILING_LIMITS,
	createShellPolicySource,
	isShellCommandString,
	managedShellStanding,
	parseShellPolicyCeiling,
	shellCommandVerdict,
	type ManagedShellStanding,
	type ShellCommandRequest,
	type ShellPolicyCeiling,
} from '../../../main/enterprise/shell-policy';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		policyRevision: 3,
		surfaces: [{ surface: 'notification', commands: ['say', 'espeak | tee ~/notify.log'] }],
		...overrides,
	};
}

function problemsOf(raw: unknown): readonly string[] {
	const parsed = parseShellPolicyCeiling(raw);
	return parsed.ok ? [] : parsed.problems;
}

function ceilingOf(raw: Record<string, unknown> = document()): ShellPolicyCeiling {
	const parsed = parseShellPolicyCeiling(raw);
	if (!parsed.ok) throw new Error(parsed.problems.join('; '));
	return parsed.ceiling;
}

const managed = (ceiling = ceilingOf()): ManagedShellStanding => ({
	standing: 'managed',
	ceiling,
	policyRevision: ceiling.policyRevision,
});

function request(overrides: Partial<ShellCommandRequest> = {}): ShellCommandRequest {
	return {
		surface: 'notification',
		command: 'say',
		actor: { kind: 'transport', actor: { peer: 'in-process' } },
		...overrides,
	};
}

describe('parseShellPolicyCeiling', () => {
	it('accepts a complete document as a fresh value the input cannot reach', () => {
		const raw = document();
		const parsed = parseShellPolicyCeiling(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.ceiling).toEqual({
			policyRevision: 3,
			surfaces: [{ surface: 'notification', commands: ['say', 'espeak | tee ~/notify.log'] }],
		});
		(raw.surfaces as unknown[]).push({ surface: 'notification', commands: ['rm -rf /'] });
		((raw.surfaces as { commands: string[] }[])[0].commands as string[]).push('rm -rf /');
		expect(parsed.ceiling.surfaces).toHaveLength(1);
		expect(parsed.ceiling.surfaces[0].commands).toHaveLength(2);
	});

	it('admits an empty surface list and an empty command list (nothing runs)', () => {
		expect(ceilingOf(document({ surfaces: [] })).surfaces).toEqual([]);
		expect(
			ceilingOf(document({ surfaces: [{ surface: 'notification', commands: [] }] })).surfaces[0]
				.commands
		).toEqual([]);
	});

	it('names every problem by path and refuses the whole document on one', () => {
		expect(problemsOf(null)).toEqual(['the shell ceiling is not an object']);
		expect(problemsOf(document({ policyRevision: -1 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ policyRevision: 1.5 }))).toEqual([
			'policyRevision is not a policy revision',
		]);
		expect(problemsOf(document({ extra: true }))).toEqual(['extra is not a known key']);
		expect(problemsOf(document({ surfaces: {} }))).toEqual(['surfaces is not an array']);
		expect(problemsOf(document({ surfaces: [null] }))).toEqual(['surfaces[0] is not an object']);
		expect(
			problemsOf(document({ surfaces: [{ surface: 'terminal', commands: ['say'], x: 1 }] }))
		).toEqual(['surfaces[0].x is not a known key', 'surfaces[0].surface is not a shell surface']);
		expect(
			problemsOf(
				document({
					surfaces: [
						{ surface: 'notification', commands: ['say'] },
						{ surface: 'notification', commands: ['espeak'] },
					],
				})
			)
		).toEqual(['surfaces exceeds 1 entries']);
	});

	it('accepts only exact single-line trimmed command strings', () => {
		const bad = ['', ' say', 'say ', 'say\n', 'say\tloud', 'a'.repeat(4097)];
		for (const command of bad) expect(isShellCommandString(command), command).toBe(false);
		expect(isShellCommandString('say -v Alex')).toBe(true);
		expect(isShellCommandString('a'.repeat(SHELL_CEILING_LIMITS.commandLength))).toBe(true);
		expect(
			problemsOf(
				document({ surfaces: [{ surface: 'notification', commands: ['say', ' say', 7] }] })
			)
		).toEqual([
			'surfaces[0].commands[1] is not an exact single-line command string',
			'surfaces[0].commands[2] is not an exact single-line command string',
		]);
		const many = Array.from({ length: SHELL_CEILING_LIMITS.commands + 1 }, (_, i) => `cmd${i}`);
		expect(
			problemsOf(document({ surfaces: [{ surface: 'notification', commands: many }] }))
		).toEqual([`surfaces[0].commands exceeds ${SHELL_CEILING_LIMITS.commands} entries`]);
	});
});

describe('managedShellStanding', () => {
	const policy = { appliedRevision: 3 };

	it('is standalone while not enrolled, whatever is installed', () => {
		expect(managedShellStanding({ enrolled: false, policy, ceiling: ceilingOf() })).toEqual({
			standing: 'standalone',
		});
	});

	it('is managed with the ceiling only when it matches the applied revision', () => {
		expect(managedShellStanding({ enrolled: true, policy, ceiling: ceilingOf() })).toEqual(
			managed()
		);
		expect(managedShellStanding({ enrolled: true, policy: null, ceiling: ceilingOf() })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: null,
			reason: 'no applied policy revision is known for this host',
		});
		expect(managedShellStanding({ enrolled: true, policy, ceiling: null })).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'no shell ceiling is installed for policy revision 3',
		});
		expect(
			managedShellStanding({
				enrolled: true,
				policy,
				ceiling: ceilingOf(document({ policyRevision: 2 })),
			})
		).toEqual({
			standing: 'managed',
			ceiling: null,
			policyRevision: 3,
			reason: 'the installed shell ceiling is for policy revision 2; this host is under revision 3',
		});
	});
});

describe('shellCommandVerdict', () => {
	it('standalone allows with no receipt and reads nothing', () => {
		expect(
			shellCommandVerdict({ standing: 'standalone' }, request({ command: 'rm -rf /' }))
		).toEqual({ allowed: true });
	});

	it('an unavailable ceiling refuses by name with a receipt', () => {
		const decision = shellCommandVerdict(
			{ standing: 'managed', ceiling: null, policyRevision: 3, reason: 'none installed' },
			request()
		);
		expect(decision).toEqual({
			allowed: false,
			code: 'unavailable',
			message: 'the managed shell ceiling is unavailable (none installed)',
			managed: {
				policyRevision: 3,
				surface: 'notification',
				actor: 'the operator',
				command: 'say',
				outcome: 'unavailable',
			},
		});
	});

	it('an unbindable actor is refused unauthenticated before the ceiling is read', () => {
		const decision = shellCommandVerdict(managed(), request(), ['no actor registered']);
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('unauthenticated');
		expect(decision.message).toBe('no actor registered');
	});

	it('admits exactly the listed strings and nothing near them', () => {
		const within = shellCommandVerdict(
			managed(),
			request({ command: 'espeak | tee ~/notify.log' })
		);
		expect(within).toEqual({
			allowed: true,
			managed: {
				policyRevision: 3,
				surface: 'notification',
				actor: 'the operator',
				command: 'espeak | tee ~/notify.log',
				outcome: 'within-ceiling',
			},
		});
		for (const command of ['say -v Alex', 'Say', 'say ', 'say; rm -rf /', 'espeak | tee ~/x']) {
			const decision = shellCommandVerdict(managed(), request({ command }));
			expect(decision.allowed, command).toBe(false);
			if (decision.allowed) continue;
			expect(decision.code).toBe('outside-ceiling');
			expect(decision.message).toContain(`"${command}"`);
			expect(decision.managed.command).toBe(command);
		}
	});

	it('a surface the ceiling does not name runs no command at all', () => {
		const decision = shellCommandVerdict(managed(ceilingOf(document({ surfaces: [] }))), request());
		expect(decision.allowed).toBe(false);
		if (decision.allowed) return;
		expect(decision.code).toBe('outside-ceiling');
		expect(decision.message).toBe(
			'the shell ceiling admits no notification command for the operator; a configured command runs only when the policy lists it exactly'
		);
	});
});

describe('createShellPolicySource', () => {
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
		return createShellPolicySource({
			identity: { read: () => read },
			policy: () => (revision === null ? null : { appliedRevision: revision }),
		});
	}

	it('holds nothing standalone and refuses unavailable once enrolled with no ceiling', () => {
		expect(source(none).standing()).toEqual({ standing: 'standalone' });
		expect(source(none).authorize(request({ command: 'anything' }))).toEqual({ allowed: true });
		const decision = source(enrolled('actor')).authorize(request());
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.code).toBe('unavailable');
	});

	it('installs a valid ceiling, keeps the previous one on a refused document, and clears', () => {
		const s = source(enrolled('actor'));
		expect(s.install(document())).toEqual({ installed: true, policyRevision: 3 });
		expect(s.installed()).toEqual(ceilingOf());
		expect(s.authorize(request()).allowed).toBe(true);
		expect(s.install(document({ extra: 1 }))).toEqual({
			installed: false,
			problems: ['extra is not a known key'],
		});
		expect(s.installed()).toEqual(ceilingOf());
		s.clear();
		expect(s.installed()).toBeNull();
		expect(s.authorize(request()).allowed).toBe(false);
	});

	it('refuses a paired device unauthenticated until an actor is registered', () => {
		const device = request({
			actor: { kind: 'transport', actor: { peer: 'device-pairing', deviceId: 'd1' } as never },
		});
		const unregistered = source(enrolled(null));
		unregistered.install(document());
		const refused = unregistered.authorize(device);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) expect(refused.code).toBe('unauthenticated');
		const registered = source(enrolled('actor'));
		registered.install(document());
		expect(registered.authorize(device).allowed).toBe(true);
	});
});
