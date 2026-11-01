/**
 * The permission-mode ceiling (MRC2-03-01, MRC2-03-03; tests MRC2-03-07).
 *
 * A managed route pins the widest permission mode a launch may ask for
 * (`ManagedRouteCeiling.permissionMode`). This suite holds the one width rule
 * and every consumer of it to the same words: `permissionModeWithinCeiling`
 * orders the modes, `managedArgsProblems` refuses by name every flag of every
 * provider's full-access vocabulary under a forbidding pin and admits them
 * under an allowing one, a `readonly` pin demands the flags the provider's
 * command line enforces and refuses a provider that cannot enforce it, the
 * desktop refusal reads the same rule, the headless authority lends the host's
 * route ceiling, and the Codex sandbox is held to the ceiling's sandbox.
 * Nothing is ever rewritten to fit: a problem is a denial, never a downgrade.
 */
import { describe, expect, it } from 'vitest';

import {
	KNOWN_FULL_ACCESS_FLAGS,
	applyManagedEnvCeiling,
	fullAccessFlagsOf,
	managedArgsProblems,
	managedPermissionModeProblem,
	permissionModeWithinCeiling,
	permissionVocabularyOf,
	type LaunchPermissionMode,
	type ManagedRouteCeiling,
} from '../../../../shared/maestro-lib/launch/env';
import { KNOWN_YOLO_FLAGS, filterYoloArgs } from '../../../../shared/maestro-lib/launch/agent-args';
import { AGENT_DEFINITIONS } from '../../../../shared/maestro-lib/providers/definitions';
import {
	createHeadlessSpawnAuthority,
	type HeadlessSpawnHost,
} from '../../../../shared/maestro-lib/managed/host-adapter';
import { createLocalHostAuthority } from '../../../../shared/maestro-lib/managed/authority';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';
import {
	managedGrokAcpRefusal,
	managedPermissionModeRefusal,
	runsOnGrokAcpRoute,
} from '../../../../main/process-manager/types';
import { fakeAdmission } from '../../../helpers/managedSpawnPort';
import {
	codexSandboxCeiling,
	parseCodexExecArgs,
} from '../../../../main/codex-app-server/invocation';

const ceiling = (
	providerId: string,
	permissionMode: LaunchPermissionMode | null,
	overrides: Partial<ManagedRouteCeiling> = {}
): ManagedRouteCeiling => ({
	providerId,
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'provider-login',
	permissionMode,
	...overrides,
});

/** Every provider a person can pick; the internal terminal has no permission vocabulary. */
const PROVIDERS = AGENT_DEFINITIONS.filter((definition) => definition.id !== 'terminal');
const FORBIDDING: readonly LaunchPermissionMode[] = ['standard', 'readonly'];
const ALLOWING: ReadonlyArray<LaunchPermissionMode | null> = ['full', null];

describe('permissionModeWithinCeiling', () => {
	it('orders readonly < standard < full and admits everything under null', () => {
		expect(permissionModeWithinCeiling('full', null)).toBe(true);
		expect(permissionModeWithinCeiling('full', 'full')).toBe(true);
		expect(permissionModeWithinCeiling('full', 'standard')).toBe(false);
		expect(permissionModeWithinCeiling('full', 'readonly')).toBe(false);
		expect(permissionModeWithinCeiling('standard', 'standard')).toBe(true);
		expect(permissionModeWithinCeiling('standard', 'readonly')).toBe(false);
		expect(permissionModeWithinCeiling('readonly', 'readonly')).toBe(true);
		expect(permissionModeWithinCeiling('readonly', 'full')).toBe(true);
	});

	it('is the rule the desktop spawn handler refuses with, and only on a managed host', () => {
		expect(managedPermissionModeRefusal('full', { permissionMode: 'standard' }, 'managed')).toMatch(
			/allows at most "standard"/
		);
		expect(
			managedPermissionModeRefusal('standard', { permissionMode: 'standard' }, 'managed')
		).toBe(null);
		expect(managedPermissionModeRefusal('full', { permissionMode: null }, 'managed')).toBe(null);
		expect(managedPermissionModeRefusal('full', { permissionMode: 'standard' }, 'standalone')).toBe(
			null
		);
	});

	it('words a mode problem with the request, the pin and the provider', () => {
		expect(
			managedPermissionModeProblem('full', { providerId: 'codex', permissionMode: 'standard' })
		).toBe(
			'permission mode "full" asks for more than the policy\'s ceiling, which allows at most "standard" for codex'
		);
		expect(
			managedPermissionModeProblem('standard', { providerId: 'pi', permissionMode: 'readonly' })
		).toContain('allows at most "readonly" for pi');
		expect(
			managedPermissionModeProblem('readonly', { providerId: 'codex', permissionMode: null })
		).toBe(null);
		expect(
			managedPermissionModeProblem('full', { providerId: 'codex', permissionMode: 'full' })
		).toBe(null);
	});
});

describe('the full-access vocabulary', () => {
	it('keeps the static list the read-only filter strips, and adds each provider its own flags', () => {
		expect([...KNOWN_YOLO_FLAGS]).toEqual([...KNOWN_FULL_ACCESS_FLAGS]);
		expect(fullAccessFlagsOf('hermes').has('--yolo')).toBe(true);
		expect(fullAccessFlagsOf('grok').has('--always-approve')).toBe(true);
		expect(fullAccessFlagsOf('claude-code').has('--dangerously-skip-permissions')).toBe(true);
		expect(fullAccessFlagsOf('codex').has('--dangerously-bypass-approvals-and-sandbox')).toBe(true);
		expect(fullAccessFlagsOf('copilot-cli').has('--allow-all')).toBe(true);
		expect(filterYoloArgs(['--print', '--dangerously-skip-permissions', '-y'], {})).toEqual([
			'--print',
		]);
	});

	it('knows nothing of an unknown provider beyond the static flags, and enforces nothing for it', () => {
		expect(fullAccessFlagsOf('no-such-provider').size).toBe(KNOWN_FULL_ACCESS_FLAGS.length);
		expect(permissionVocabularyOf('no-such-provider')).toEqual({
			providerId: 'no-such-provider',
			known: false,
			fullAccessFlags: [...KNOWN_FULL_ACCESS_FLAGS],
			readOnlyArgs: [],
			readOnlyCliEnforced: false,
		});
	});

	it('reads every provider from its definition: its flags, its read-only vocabulary, and whether the command line enforces it', () => {
		expect(PROVIDERS.length).toBeGreaterThan(5);
		for (const definition of PROVIDERS) {
			const vocabulary = permissionVocabularyOf(definition.id);
			expect(vocabulary.known).toBe(true);
			for (const flag of KNOWN_FULL_ACCESS_FLAGS) {
				expect(vocabulary.fullAccessFlags).toContain(flag);
			}
			for (const own of [
				...(definition.fullAccessArgs ?? []),
				...(definition.yoloModeArgs ?? []),
			]) {
				if (own.startsWith('-')) expect(vocabulary.fullAccessFlags).toContain(own);
			}
			expect(new Set(vocabulary.fullAccessFlags).size).toBe(vocabulary.fullAccessFlags.length);
			expect(vocabulary.readOnlyArgs).toEqual(definition.readOnlyArgs ?? []);
			expect(vocabulary.readOnlyCliEnforced).toBe(definition.readOnlyCliEnforced === true);
		}
		// The table the evidence reconciles against: enforcement is a declared
		// fact of the definition, never inferred from the presence of a flag.
		const enforced = PROVIDERS.filter((d) => permissionVocabularyOf(d.id).readOnlyCliEnforced).map(
			(d) => d.id
		);
		expect(enforced).toEqual(expect.arrayContaining(['claude-code', 'codex', 'factory-droid']));
		expect(enforced).not.toContain('gemini-cli');
		expect(enforced).not.toContain('antigravity');
		// Factory Droid enforces read-only with no flag at all (exec is read-only by default).
		expect(permissionVocabularyOf('factory-droid')).toMatchObject({
			readOnlyArgs: [],
			readOnlyCliEnforced: true,
		});
	});
});

describe('managedArgsProblems under a permission-mode pin', () => {
	it('adds nothing when the ceiling pins no mode, whatever the flags ask for', () => {
		expect(
			managedArgsProblems(
				['--print', '--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions'],
				ceiling('claude-code', null)
			)
		).toEqual([]);
		for (const definition of PROVIDERS) {
			for (const flag of fullAccessFlagsOf(definition.id)) {
				expect(managedArgsProblems([flag], ceiling(definition.id, null))).toEqual([]);
			}
		}
	});

	describe.each(PROVIDERS.map((definition) => [definition.id] as const))(
		'%s full-access table',
		(providerId) => {
			const flags = [...fullAccessFlagsOf(providerId)];

			it.each(ALLOWING.map((pin) => [pin] as const))('admits every flag under %s', (pin) => {
				for (const flag of flags) {
					const problems = managedArgsProblems(['--print', flag], ceiling(providerId, pin));
					expect(problems.filter((p) => p.includes('full access'))).toEqual([]);
				}
			});

			it.each(FORBIDDING.map((pin) => [pin] as const))(
				'refuses every flag by name under %s and rewrites nothing',
				(pin) => {
					for (const flag of flags) {
						const args = ['--print', flag];
						const before = [...args];
						const problems = managedArgsProblems(args, ceiling(providerId, pin));
						expect(problems).toContain(
							`${flag} asks for full access but the policy's ceiling allows at most "${pin}" for ${providerId}`
						);
						expect(args).toEqual(before);
					}
				}
			);
		}
	);

	it('refuses a mode flag whose value names full access, inline or spaced, and leaves the read-only values alone', () => {
		expect(
			managedArgsProblems(
				['--permission-mode', 'bypassPermissions'],
				ceiling('claude-code', 'standard')
			)
		).toEqual([
			'--permission-mode bypassPermissions asks for full access but the policy\'s ceiling allows at most "standard" for claude-code',
		]);
		expect(
			managedArgsProblems(['--permission-mode=bypassPermissions'], ceiling('grok', 'readonly'))
		).toEqual([
			expect.stringContaining('--permission-mode bypassPermissions asks for full access'),
			expect.stringContaining('read-only flags'),
		]);
		expect(
			managedArgsProblems(['--sandbox=danger-full-access'], ceiling('codex', 'standard'))
		).toHaveLength(1);
		expect(managedArgsProblems(['-a', 'never'], ceiling('codex', 'standard'))).toHaveLength(1);
		expect(
			managedArgsProblems(['--ask-for-approval', 'never'], ceiling('codex', 'standard'))
		).toHaveLength(1);
		expect(
			managedArgsProblems(['--approval-mode', 'yolo'], ceiling('qwen3-coder', 'standard'))
		).toHaveLength(1);
		expect(
			managedArgsProblems(['--permission-mode', 'plan'], ceiling('claude-code', 'standard'))
		).toEqual([]);
		expect(managedArgsProblems(['--sandbox', 'read-only'], ceiling('codex', 'standard'))).toEqual(
			[]
		);
		expect(
			managedArgsProblems(['--approval-mode', 'plan'], ceiling('qwen3-coder', 'standard'))
		).toEqual([]);
	});

	it('under readonly demands the enforced read-only flags with their values, spaced or inline', () => {
		expect(
			managedArgsProblems(
				['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check'],
				ceiling('codex', 'readonly')
			)
		).toEqual([]);
		expect(
			managedArgsProblems(
				['exec', '--json', '--sandbox=read-only', '--skip-git-repo-check'],
				ceiling('codex', 'readonly')
			)
		).toEqual([]);
		expect(managedArgsProblems(['exec', '--json'], ceiling('codex', 'readonly'))).toEqual([
			"the policy pins read-only and the arguments do not carry codex's read-only flags (--sandbox read-only --skip-git-repo-check)",
		]);
		// A workspace-write sandbox is not the read-only value: seen by the absence.
		expect(
			managedArgsProblems(
				['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'],
				ceiling('codex', 'readonly')
			)
		).toHaveLength(1);
		// A request for standard leaves no flag behind: seen by the absence too.
		expect(managedArgsProblems(['--print'], ceiling('claude-code', 'readonly'))).toEqual([
			"the policy pins read-only and the arguments do not carry claude-code's read-only flags (--permission-mode plan)",
		]);
		expect(
			managedArgsProblems(
				['--print', '--permission-mode', 'plan'],
				ceiling('claude-code', 'readonly')
			)
		).toEqual([]);
		expect(
			managedArgsProblems(['--tools', 'read,grep,find,ls'], ceiling('pi', 'readonly'))
		).toEqual([]);
		expect(managedArgsProblems(['--tools', 'read,write'], ceiling('pi', 'readonly'))).toHaveLength(
			1
		);
		// Factory Droid exec is read-only with no flag.
		expect(managedArgsProblems(['exec'], ceiling('factory-droid', 'readonly'))).toEqual([]);
	});

	it('under readonly refuses a provider whose command line cannot enforce it, beside the flag problems', () => {
		expect(managedArgsProblems(['--sandbox'], ceiling('antigravity', 'readonly'))).toEqual([
			'the policy pins read-only but antigravity cannot enforce it on the command line',
		]);
		expect(managedArgsProblems(['-y'], ceiling('gemini-cli', 'readonly'))).toEqual([
			'-y asks for full access but the policy\'s ceiling allows at most "readonly" for gemini-cli',
			'the policy pins read-only but gemini-cli cannot enforce it on the command line',
		]);
		expect(managedArgsProblems([], ceiling('no-such-provider', 'readonly'))).toEqual([
			'the policy pins read-only but no-such-provider cannot enforce it on the command line',
		]);
		// Under standard the same providers are held only to their flags.
		expect(managedArgsProblems(['--sandbox'], ceiling('antigravity', 'standard'))).toEqual([]);
		expect(managedArgsProblems(['-y'], ceiling('gemini-cli', 'standard'))).toHaveLength(1);
	});

	it('keeps the route checks beside the mode checks, each naming its own problem', () => {
		expect(
			managedArgsProblems(
				['--model', 'other', '--dangerously-skip-permissions'],
				ceiling('claude-code', 'standard', { model: 'pinned' })
			)
		).toEqual([
			'--model names other but the policy pins pinned',
			'--dangerously-skip-permissions asks for full access but the policy\'s ceiling allows at most "standard" for claude-code',
		]);
		expect(
			managedArgsProblems(
				['--model', 'pinned', '--api-key', 'sk-x'],
				ceiling('claude-code', 'full', { model: 'pinned' })
			)
		).toEqual(['--api-key is not allowed under management']);
	});
});

describe('HeadlessSpawnAuthority.routeCeiling', () => {
	const INSTALLATION = { installationId: 'inst', runtimeId: 'r1', processEpoch: 'e1' };
	const RECORD = {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installationId: 'inst',
		authorityId: 'authority-1',
		endpointRef: '/tmp/endpoint.sock',
		enrolledAt: '2026-10-21T00:00:00.000Z',
		policySources: [],
		policyRevision: 2,
		digest: 'd'.repeat(64),
	};
	const ENROLLED = { state: 'enrolled' as const, record: RECORD, file: '/tmp/binding.json' };
	const ACTOR = { kind: 'service' as const, id: 'maestro-cli:test' };
	const host = (routeCeiling?: HeadlessSpawnHost['routeCeiling']): HeadlessSpawnHost => ({
		authority: createLocalHostAuthority({
			authorityId: 'authority-1',
			decide: () => ({ decision: 'allow', policyRevision: 2 }),
			now: () => 1_000,
			newId: () => 'lease-1',
		}),
		policy: () => ({ sources: [], policyRevision: 2 }),
		...(routeCeiling ? { routeCeiling } : {}),
	});

	it('lends the attached host route for the provider it names and answers null everywhere else', () => {
		const pinned = ceiling('codex', 'standard');
		const lending = createHeadlessSpawnAuthority({
			installation: INSTALLATION,
			binding: ENROLLED,
			host: host((id) => (id === 'codex' ? pinned : null)),
			origin: 'cli',
			actor: ACTOR,
		});
		expect(lending.routeCeiling!('codex')).toBe(pinned);
		expect(lending.routeCeiling!('claude-code')).toBeNull();

		const noProducer = createHeadlessSpawnAuthority({
			installation: INSTALLATION,
			binding: ENROLLED,
			host: host(),
			origin: 'cli',
			actor: ACTOR,
		});
		expect(noProducer.routeCeiling!('codex')).toBeNull();

		// A standalone binding lends nothing, even over a host that would pin.
		const standalone = createHeadlessSpawnAuthority({
			installation: INSTALLATION,
			binding: { state: 'standalone', files: [] },
			host: host(() => pinned),
			origin: 'cli',
			actor: ACTOR,
		});
		expect(standalone.routeCeiling!('codex')).toBeNull();

		const bare = createHeadlessSpawnAuthority({
			installation: INSTALLATION,
			binding: ENROLLED,
			host: null,
			origin: 'cli',
			actor: ACTOR,
		});
		expect(bare.standing()).toBe('managed');
		expect(bare.routeCeiling!('codex')).toBeNull();
	});
});

describe('the Codex sandbox under the ceiling', () => {
	const EXEC = ['exec', '--json', '--skip-git-repo-check'];

	it('maps the ceiling to the widest sandbox it allows', () => {
		expect(codexSandboxCeiling(null)).toBeNull();
		expect(codexSandboxCeiling('full')).toBeNull();
		expect(codexSandboxCeiling('standard')).toBe('workspace-write');
		expect(codexSandboxCeiling('readonly')).toBe('read-only');
	});

	it('parses an unmanaged turn, and a turn under an allowing ceiling, exactly as before', () => {
		const asBefore = { ok: true, invocation: { cwd: '/p', configArgs: [] } };
		expect(parseCodexExecArgs([...EXEC], '/p')).toEqual(asBefore);
		expect(parseCodexExecArgs([...EXEC], '/p', null)).toEqual(asBefore);
		expect(parseCodexExecArgs([...EXEC], '/p', { ceiling: null })).toEqual(asBefore);
		expect(parseCodexExecArgs([...EXEC], '/p', { ceiling: 'full' })).toEqual(asBefore);
	});

	it('refuses a sandbox wider than the ceiling and never narrows it to fit', () => {
		expect(
			parseCodexExecArgs([...EXEC, '--dangerously-bypass-approvals-and-sandbox'], '/p', {
				ceiling: 'standard',
			})
		).toEqual({
			ok: false,
			refused: true,
			reason: expect.stringContaining('sandbox danger-full-access asks for more'),
		});
		expect(
			parseCodexExecArgs([...EXEC, '--sandbox', 'danger-full-access'], '/p', {
				ceiling: 'readonly',
			})
		).toMatchObject({ ok: false, refused: true });
		expect(
			parseCodexExecArgs([...EXEC, '-s', 'workspace-write'], '/p', { ceiling: 'readonly' })
		).toMatchObject({
			ok: false,
			refused: true,
			reason: expect.stringContaining('at most "readonly" (read-only) for codex'),
		});
	});

	it('pins a turn that named no sandbox at the ceiling, so config.toml cannot widen it', () => {
		expect(parseCodexExecArgs([...EXEC], '/p', { ceiling: 'standard' })).toEqual({
			ok: true,
			invocation: {
				cwd: '/p',
				configArgs: [],
				sandbox: 'workspace-write',
				sandboxFromCeiling: true,
			},
		});
		expect(parseCodexExecArgs([...EXEC], '/p', { ceiling: 'readonly' })).toEqual({
			ok: true,
			invocation: { cwd: '/p', configArgs: [], sandbox: 'read-only', sandboxFromCeiling: true },
		});
	});

	it('keeps a sandbox within the ceiling as the args named it', () => {
		expect(
			parseCodexExecArgs([...EXEC, '--sandbox', 'read-only'], '/p', { ceiling: 'standard' })
		).toEqual({ ok: true, invocation: { cwd: '/p', configArgs: [], sandbox: 'read-only' } });
		expect(
			parseCodexExecArgs([...EXEC, '--sandbox', 'read-only'], '/p', { ceiling: 'readonly' })
		).toEqual({ ok: true, invocation: { cwd: '/p', configArgs: [], sandbox: 'read-only' } });
	});

	it('leaves a write grant under a pinned workspace-write unsupported, not refused', () => {
		expect(
			parseCodexExecArgs([...EXEC, '--add-dir', '/other'], '/p', { ceiling: 'standard' })
		).toEqual({ ok: false, reason: 'write grant (--add-dir) outside full access' });
	});
});

/**
 * Grok under the managed ceiling (GT1-09-03; requirements GT1-09-R05..R07).
 * Pure rules over synthetic argv and a synthetic admission (`fakeAdmission`,
 * a look-alike the spawners read and the process manager would refuse): they
 * prove what the client refuses before a launch, never that Grok's own tools,
 * files or network obey a policy.
 */
describe('Grok under the managed ceiling', () => {
	const READ_ONLY = ['--permission-mode', 'plan', '--deny', 'Bash(*)'];
	const HEADLESS = ['--output-format', 'streaming-json', '-p', 'hi'];

	it('reads the read-only and full-access vocabulary from the Grok definition', () => {
		expect(permissionVocabularyOf('grok')).toMatchObject({
			known: true,
			readOnlyArgs: READ_ONLY,
			readOnlyCliEnforced: true,
		});
		expect(permissionVocabularyOf('grok').fullAccessFlags).toContain('--always-approve');
	});

	it('refuses a read-only turn that also carries a full-access flag, by name, and rewrites nothing', () => {
		const args = [...HEADLESS, ...READ_ONLY, '--always-approve'];
		const before = [...args];
		expect(managedArgsProblems(args, ceiling('grok', 'readonly'))).toEqual([
			'--always-approve asks for full access but the policy\'s ceiling allows at most "readonly" for grok',
		]);
		expect(args).toEqual(before);
		// A custom argument re-asking for bypass after the plan flags is the same collision.
		expect(
			managedArgsProblems(
				[...HEADLESS, ...READ_ONLY, '--permission-mode', 'bypassPermissions'],
				ceiling('grok', 'readonly')
			)
		).toEqual([
			expect.stringContaining('--permission-mode bypassPermissions asks for full access'),
		]);
		expect(
			managedArgsProblems([...HEADLESS, '--always-approve'], ceiling('grok', 'standard'))
		).toHaveLength(1);
		// Under an allowing pin the same flag is the person's own choice.
		expect(managedArgsProblems([...HEADLESS, '--always-approve'], ceiling('grok', 'full'))).toEqual(
			[]
		);
	});

	it('under readonly demands both plan and the Bash deny, so a custom override dropping one is seen', () => {
		expect(managedArgsProblems([...HEADLESS, ...READ_ONLY], ceiling('grok', 'readonly'))).toEqual(
			[]
		);
		expect(
			managedArgsProblems([...HEADLESS, '--permission-mode', 'plan'], ceiling('grok', 'readonly'))
		).toEqual([
			"the policy pins read-only and the arguments do not carry grok's read-only flags (--permission-mode plan --deny Bash(*))",
		]);
	});

	it('holds every Grok model flag to a pinned model, however a custom argument spells it', () => {
		const pinned = ceiling('grok', 'standard', { model: 'grok-pinned' });
		expect(managedArgsProblems(['-m', 'grok-pinned'], pinned)).toEqual([]);
		expect(managedArgsProblems(['-m=grok-pinned'], pinned)).toEqual([]);
		// The CLI keeps the last -m; a custom argument appended after the pin is refused, not ignored.
		expect(managedArgsProblems(['-m', 'grok-pinned', '-m', 'grok-other'], pinned)).toEqual([
			'-m names grok-other but the policy pins grok-pinned',
		]);
		expect(managedArgsProblems(['--model=grok-other'], pinned)).toEqual([
			'--model names grok-other but the policy pins grok-pinned',
		]);
		expect(managedArgsProblems(['-m'], pinned)).toEqual([
			'-m names (nothing) but the policy pins grok-pinned',
		]);
	});

	it('pins a Grok account home and refuses a model or approved-credential pin the environment cannot carry, rather than launching unpinned', () => {
		// Grok's PROVIDER_ROUTE_ENV_NAMES entry carries the account home
		// (GROK_HOME, GT1-09-04A) but no model variable, so the model pin and the
		// missing approved credential are problems the caller refuses on (synthetic env).
		const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
		const report = applyManagedEnvCeiling(env, {
			ceiling: ceiling('grok', 'standard', {
				model: 'grok-pinned',
				accountDir: '/managed/grok-home',
				login: 'approved-credential',
			}),
			credentialEnvVars: {},
		});
		expect(report.pinned).toEqual(['GROK_HOME']);
		expect(env.GROK_HOME).toBe('/managed/grok-home');
		expect(report.problems).toEqual([
			'the policy pins the model but grok has no variable for it',
			'the route requires an approved credential and none was delivered; grok would fall back to the personal login in its account home',
		]);
	});

	it('holds a full-access request to the desktop mode refusal on a managed host only', () => {
		expect(managedPermissionModeRefusal('full', { permissionMode: 'readonly' }, 'managed')).toMatch(
			/allows at most "readonly"/
		);
		expect(
			managedPermissionModeRefusal('full', { permissionMode: 'readonly' }, 'standalone')
		).toBeNull();
	});

	describe('the grok-acp route under an admission', () => {
		const admission = fakeAdmission({ provider: 'grok' });
		const turn = (requested: LaunchPermissionMode, extra: Record<string, unknown> = {}) => ({
			toolType: 'grok',
			permission: { requested, ceiling: null },
			...extra,
		});

		it('routes the standard (provider-prompting) Grok turn to ACP and every other mode to the child process', () => {
			expect(runsOnGrokAcpRoute(turn('standard'))).toBe(true);
			expect(runsOnGrokAcpRoute(turn('readonly'))).toBe(false);
			expect(runsOnGrokAcpRoute(turn('full'))).toBe(false);
			expect(
				runsOnGrokAcpRoute({
					toolType: 'codex',
					permission: { requested: 'standard', ceiling: null },
				})
			).toBe(false);
			expect(runsOnGrokAcpRoute({ toolType: 'grok' })).toBe(false);
		});

		it('refuses an admitted ACP turn unavailable/capability-unsupported, with no headless fallback', () => {
			const refusal = managedGrokAcpRefusal(turn('standard', { admission }));
			expect(refusal).toMatchObject({ state: 'unavailable', code: 'capability-unsupported' });
			expect(refusal?.message).toContain('grok-acp route is unavailable');
			expect(refusal?.message).toContain('CP-01');
			expect(refusal?.message).toContain('does not fall back to headless streaming');
			expect(refusal?.message).toContain('Nothing was started.');
			// A forwarded native command takes ACP whatever the mode, so it is refused too.
			expect(
				managedGrokAcpRefusal(turn('readonly', { admission, grokNativeCommand: {} as never }))
			).toMatchObject({ code: 'capability-unsupported' });
		});

		it('leaves standalone ACP and admitted child-process Grok turns to their own checks', () => {
			expect(managedGrokAcpRefusal(turn('standard'))).toBeNull();
			expect(managedGrokAcpRefusal(turn('readonly', { admission }))).toBeNull();
			expect(managedGrokAcpRefusal(turn('full', { admission }))).toBeNull();
		});
	});
});
