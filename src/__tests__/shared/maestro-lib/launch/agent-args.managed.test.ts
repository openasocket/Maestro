/**
 * Agent arguments under a managed ceiling (MRC2-03-01, 03-03, 03-04, 03-04A;
 * tests MRC2-03-07).
 *
 * The ceiling is read where the arguments are built and where they are
 * launched, and in neither place is a request lowered to fit:
 *
 * - `buildAgentArgs` under `managedCeiling` throws `ManagedPermissionModeError`
 *   for a request above the pin and is byte for byte unchanged with none;
 * - `buildAgentLaunchPlan` refuses a request above the pin before the flags
 *   are looked at, still refuses a full-access flag when the request itself
 *   was named within the pin (so a `--customArgs` flag cannot widen what the
 *   ceiling allows), and reports `plan.permission` for the sinks;
 * - `cliRequestedPermissionMode` names what a CLI command line asks for, so
 *   a headless spawn is measured against the same ceiling;
 * - a provider probe (`runProviderProbe`, the slash-command probe, the
 *   detector's model discovery) is a provider started on the probe's own
 *   arguments: under a `standard` pin its `--dangerously-skip-permissions` is
 *   refused by name before the actor is bound, a policy denial starts nothing
 *   and is remembered per probe and directory, the cached slash probe asks
 *   nobody the next time, and a standalone host probes exactly as before.
 *
 * The probes run against the real lease authority and verifier behind
 * `fakeSpawnPort`; `startTurn` and `execFileNoThrow` are mocked so no provider
 * is ever started.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../shared/maestro-lib/run/start-turn', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../shared/maestro-lib/run/start-turn')>();
	return { ...actual, startTurn: vi.fn() };
});
vi.mock('../../../../shared/maestro-lib/launch/exec-file', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../shared/maestro-lib/launch/exec-file')>();
	return { ...actual, execFileNoThrow: vi.fn() };
});
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/web-server/auth/transport-actor', () => ({
	currentSpawnActor: vi.fn(() => ({ peer: 'host-secret' })),
}));

import {
	buildAgentArgs,
	ManagedPermissionModeError,
} from '../../../../shared/maestro-lib/launch/agent-args';
import type { ManagedRouteCeiling } from '../../../../shared/maestro-lib/launch/env';
import {
	buildAgentLaunchPlan,
	defaultLaunchPermissionMode,
	type AgentLaunchInput,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import {
	startTurn,
	DispatchRefusedError,
	type TurnHandlers,
	type TurnExit,
	type TurnProcessSpec,
	type StartTurnOptions,
} from '../../../../shared/maestro-lib/run/start-turn';
import { execFileNoThrow } from '../../../../shared/maestro-lib/launch/exec-file';
import { buildDispatchSnapshot } from '../../../../shared/maestro-lib/managed/authority';
import { cliRequestedPermissionMode } from '../../../../cli/services/agent-spawner';
import {
	runProviderProbe,
	clearProviderProbeRefusals,
	providerProbeManaged,
	PROVIDER_PROBE_ROUTE,
	type ProviderProbeManaged,
} from '../../../../main/agents/provider-probe';
import {
	probeClaudeSlashCommands,
	probeClaudeSlashCommandsCached,
	clearClaudeSlashCommandCache,
} from '../../../../main/agents/claude-slash-command-probe';
import { clearCodexSkillProbeRefusals } from '../../../../main/agents/codex-skills';
import { AgentDetector, PROBE_REFUSED_EXIT_CODE } from '../../../../main/agents/detector';
import { logger } from '../../../../main/utils/logger';
import { captureException } from '../../../../main/utils/sentry';
import { fakeSpawnPort } from '../../../helpers/managedSpawnPort';

const route = (overrides: Partial<ManagedRouteCeiling> = {}): ManagedRouteCeiling => ({
	providerId: 'claude-code',
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'provider-login',
	permissionMode: null,
	...overrides,
});

const agentFor = (id: string) => ({
	...getAgentDefinition(id)!,
	capabilities: getAgentCapabilities(id as never),
	available: true,
	path: `/usr/local/bin/${id}`,
});

function launchInput(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
	const definition = getAgentDefinition('claude-code')!;
	return {
		surface: 'cli',
		agent: { ...definition, capabilities: getAgentCapabilities('claude-code') },
		command: '/usr/bin/claude',
		args: ['--print'],
		cwd: '/p',
		prompt: 'hi',
		batchMode: true,
		...overrides,
	};
}

describe('buildAgentArgs under an authority', () => {
	const claude = agentFor('claude-code');

	it('is byte for byte unchanged with no ceiling, a null ceiling, or a ceiling pinning no mode', () => {
		const before = buildAgentArgs(claude, { baseArgs: ['--print'], permissionMode: 'full' });
		expect(before).toEqual(['--print', '--dangerously-skip-permissions']);
		expect(
			buildAgentArgs(claude, {
				baseArgs: ['--print'],
				permissionMode: 'full',
				managedCeiling: null,
			})
		).toEqual(before);
		expect(
			buildAgentArgs(claude, {
				baseArgs: ['--print'],
				permissionMode: 'full',
				managedCeiling: { providerId: 'claude-code', permissionMode: null },
			})
		).toEqual(before);
	});

	it('throws, and never lowers, when the request is above the ceiling', () => {
		let caught: unknown;
		try {
			buildAgentArgs(claude, {
				baseArgs: ['--print'],
				yoloMode: true,
				managedCeiling: { providerId: 'claude-code', permissionMode: 'standard' },
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ManagedPermissionModeError);
		const error = caught as ManagedPermissionModeError;
		expect(error.requested).toBe('full');
		expect(error.pinned).toBe('standard');
		expect(error.providerId).toBe('claude-code');
		expect(error.message).toContain('allows at most "standard" for claude-code');
	});

	it('admits a request at or under the ceiling with the flags it asked for', () => {
		expect(
			buildAgentArgs(claude, {
				baseArgs: ['--print'],
				permissionMode: 'full',
				managedCeiling: { providerId: 'claude-code', permissionMode: 'full' },
			})
		).toEqual(['--print', '--dangerously-skip-permissions']);
		expect(
			buildAgentArgs(claude, {
				baseArgs: ['--print'],
				permissionMode: 'readonly',
				managedCeiling: { providerId: 'claude-code', permissionMode: 'standard' },
			})
		).toEqual(['--print', '--permission-mode', 'plan']);
	});

	it('holds a provider with no full-access flag to the ceiling too', () => {
		const pi = agentFor('pi');
		expect(() =>
			buildAgentArgs(pi, {
				baseArgs: [],
				permissionMode: 'full',
				managedCeiling: { providerId: 'pi', permissionMode: 'readonly' },
			})
		).toThrow(ManagedPermissionModeError);
		expect(() =>
			buildAgentArgs(pi, {
				baseArgs: [],
				permissionMode: 'standard',
				managedCeiling: { providerId: 'pi', permissionMode: 'readonly' },
			})
		).toThrow(/permission mode "standard" asks for more/);
		expect(
			buildAgentArgs(pi, {
				baseArgs: [],
				permissionMode: 'readonly',
				managedCeiling: { providerId: 'pi', permissionMode: 'readonly' },
			})
		).toEqual(['--tools', 'read,grep,find,ls']);
	});
});

describe('the launch plan permission decision', () => {
	it('derives readonly and standard by default, never full', () => {
		expect(defaultLaunchPermissionMode({})).toBe('standard');
		expect(defaultLaunchPermissionMode({ readOnlyMode: true })).toBe('readonly');
		expect(defaultLaunchPermissionMode({ permissionMode: 'full', readOnlyMode: true })).toBe(
			'full'
		);
	});

	it('an unmanaged plan reports the request with no ceiling', () => {
		const standard = buildAgentLaunchPlan(launchInput());
		expect(standard.ok && standard.plan.permission).toEqual({
			requested: 'standard',
			ceiling: null,
		});
		const readonly = buildAgentLaunchPlan(launchInput({ readOnlyMode: true }));
		expect(readonly.ok && readonly.plan.permission).toEqual({
			requested: 'readonly',
			ceiling: null,
		});
		const full = buildAgentLaunchPlan(
			launchInput({ permissionMode: 'full', args: ['--print', '--dangerously-skip-permissions'] })
		);
		expect(full.ok && full.plan.permission).toEqual({ requested: 'full', ceiling: null });
	});

	it('refuses a request above the pin before the flags are looked at', () => {
		const result = buildAgentLaunchPlan(
			launchInput({
				permissionMode: 'full',
				args: ['--print'],
				managed: { route: route({ permissionMode: 'standard' }) },
			})
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('managed-route-refused');
		expect(result.error).toContain('The launch asks for more than the policy allows');
		expect(result.error).toContain('permission mode "full"');
		expect(result.error).toContain('at most "standard" for claude-code');
	});

	it('still refuses the flag when the request itself was named within the pin: a flag cannot widen the mode', () => {
		const result = buildAgentLaunchPlan(
			launchInput({
				permissionMode: 'standard',
				args: ['--print', '--dangerously-skip-permissions'],
				managed: { route: route({ permissionMode: 'standard' }) },
			})
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('managed-route-refused');
		expect(result.error).toContain('--dangerously-skip-permissions asks for full access');
	});

	it('plans a request within the pin and reports the ceiling to the sinks', () => {
		const full = buildAgentLaunchPlan(
			launchInput({
				permissionMode: 'full',
				args: ['--print', '--dangerously-skip-permissions'],
				managed: { route: route({ permissionMode: 'full' }) },
			})
		);
		expect(full.ok && full.plan.permission).toEqual({ requested: 'full', ceiling: 'full' });
		expect(full.ok && full.plan.args).toContain('--dangerously-skip-permissions');
		const unpinned = buildAgentLaunchPlan(
			launchInput({
				permissionMode: 'full',
				args: ['--print', '--dangerously-skip-permissions'],
				managed: { route: route() },
			})
		);
		expect(unpinned.ok && unpinned.plan.permission).toEqual({ requested: 'full', ceiling: null });
		const standard = buildAgentLaunchPlan(
			launchInput({ managed: { route: route({ permissionMode: 'standard' }) } })
		);
		expect(standard.ok && standard.plan.permission).toEqual({
			requested: 'standard',
			ceiling: 'standard',
		});
	});
});

describe('the CLI request', () => {
	it('names full for a command line carrying a full-access flag, standard for none, and readonly first', () => {
		expect(
			cliRequestedPermissionMode('claude-code', true, ['--dangerously-skip-permissions'])
		).toBe('readonly');
		expect(
			cliRequestedPermissionMode('claude-code', false, ['--dangerously-skip-permissions'])
		).toBe('full');
		expect(
			cliRequestedPermissionMode('codex', false, [
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
			])
		).toBe('full');
		expect(cliRequestedPermissionMode('copilot-cli', false, ['--allow-all'])).toBe('full');
		expect(cliRequestedPermissionMode('hermes', undefined, ['-Q', '--yolo'])).toBe('full');
		expect(cliRequestedPermissionMode('pi', false, ['--mode', 'json'])).toBe('standard');
	});

	it('a custom CLI flag cannot widen the ceiling: the plan refuses it whatever mode the CLI named', () => {
		const customArgs = ['--print', '--dangerously-skip-permissions'];
		const requested = cliRequestedPermissionMode('claude-code', false, customArgs);
		expect(requested).toBe('full');
		const byMode = buildAgentLaunchPlan(
			launchInput({
				permissionMode: requested,
				args: customArgs,
				managed: { route: route({ permissionMode: 'standard' }) },
			})
		);
		expect(byMode.ok).toBe(false);
		// Even a caller that under-reports the mode is caught by the flag itself.
		const byFlag = buildAgentLaunchPlan(
			launchInput({
				permissionMode: 'standard',
				args: customArgs,
				managed: { route: route({ permissionMode: 'standard' }) },
			})
		);
		expect(byFlag.ok).toBe(false);
		if (byFlag.ok) return;
		expect(byFlag.error).toContain('--dangerously-skip-permissions');
	});
});

describe('provider probes under admission', () => {
	const actor = { peer: 'host-secret' } as const;
	const initLine = (commands: string[]) =>
		JSON.stringify({ type: 'system', subtype: 'init', slash_commands: commands }) + '\n';
	const calls: Array<{ spec: TurnProcessSpec; options: StartTurnOptions }> = [];
	let stdoutText = '';

	async function refusalOf(promise: Promise<unknown>): Promise<DispatchRefusedError> {
		const error = await promise.then(
			() => null,
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(DispatchRefusedError);
		return error as DispatchRefusedError;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		calls.length = 0;
		stdoutText = '';
		clearProviderProbeRefusals();
		clearClaudeSlashCommandCache();
		// The sink: the gate sees the spec it is handed the instant before spawn,
		// the turn prints `stdoutText` and exits 0, and the lease is released.
		vi.mocked(startTurn).mockImplementation((spec, handlers: TurnHandlers, options) => {
			calls.push({ spec, options });
			const verdict = options.admission?.gate.admit(
				buildDispatchSnapshot(spec, options.admission.attribution)
			);
			if (verdict && !verdict.ok)
				throw new DispatchRefusedError(verdict.state, verdict.code, verdict.message);
			options.admission?.gate.bound?.(4242);
			const done = Promise.resolve().then(() => {
				handlers.onStdout?.(stdoutText);
				const exit: TurnExit = {
					exitCode: 0,
					signal: null,
					interrupted: false,
					stderrText: '',
					stdoutText: '',
					droppedOutputBytes: 0,
				};
				options.admission?.gate.released?.(exit);
				return exit;
			});
			return { done, terminate: vi.fn(), pid: 4242 } as unknown as ReturnType<typeof startTurn>;
		});
	});

	describe('standalone', () => {
		it('with no managed half runs execFileNoThrow as before, the env as { env } when given', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: 'x', stderr: '', exitCode: 0 });
			const env = { PATH: '/bin' };
			const result = await runProviderProbe({
				providerId: 'opencode',
				kind: 'models',
				command: '/bin/opencode',
				args: ['models'],
				env,
			});
			expect(result).toEqual({ stdout: 'x', stderr: '', exitCode: 0 });
			expect(execFileNoThrow).toHaveBeenCalledWith('/bin/opencode', ['models'], undefined, { env });
			await runProviderProbe({
				providerId: 'claude-code',
				kind: 'k',
				command: 'c',
				args: ['a'],
				cwd: '/p',
			});
			expect(execFileNoThrow).toHaveBeenLastCalledWith('c', ['a'], '/p');
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('a standalone port runs execFileNoThrow and asks nobody; no port is no managed half', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
			const port = fakeSpawnPort({ standing: 'standalone' });
			const verify = vi.spyOn(port, 'verify');
			await runProviderProbe(
				{ providerId: 'claude-code', kind: 'k', command: 'c', args: [] },
				{ port, actor }
			);
			expect(execFileNoThrow).toHaveBeenCalledOnce();
			expect(verify).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(startTurn).not.toHaveBeenCalled();
			expect(providerProbeManaged(null)).toBeUndefined();
			expect(providerProbeManaged(fakeSpawnPort())).toMatchObject({
				actor: { peer: 'host-secret' },
			});
		});
	});

	describe('managed', () => {
		it('admits the probe as a probe turn on the child-process route, the lease covering the spec startTurn received', async () => {
			const port = fakeSpawnPort();
			stdoutText = 'model-a\nmodel-b\n';
			const result = await runProviderProbe(
				{
					providerId: 'opencode',
					kind: 'models',
					command: '/bin/opencode',
					args: ['models'],
					cwd: '/proj',
					env: { PATH: '/bin' },
				},
				{ port, actor }
			);
			expect(result).toEqual({ stdout: 'model-a\nmodel-b\n', stderr: '', exitCode: 0 });
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(1);
			expect(port.asked[0].snapshot).toMatchObject({
				purpose: 'probe',
				operation: 'start',
				provider: 'opencode',
				origin: 'cli',
			});
			expect(port.asked[0].context.traceId).toBe('opencode-models-probe:/proj');
			expect(calls).toHaveLength(1);
			expect(calls[0].spec).toMatchObject({
				command: '/bin/opencode',
				args: ['models'],
				cwd: '/proj',
				env: { PATH: '/bin' },
			});
			expect(calls[0].options.label).toBe('opencode-probe:models');
			expect(port.authority.live()).toHaveLength(0);
		});

		it('a policy denial starts nothing and is remembered for the actor, the probe and the directory', async () => {
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', policyRevision: 1, reason: 'no probes' }),
			});
			const managed: ProviderProbeManaged = { port, actor };
			const request = {
				providerId: 'claude-code',
				kind: 'k',
				command: 'c',
				args: ['--help'],
				cwd: '/p',
			};
			const error = await refusalOf(runProviderProbe(request, managed));
			expect(error.state).toBe('denied');
			expect(error.code).toBe('policy-denied');
			expect(error.message).toContain('no probes');
			expect(startTurn).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			await refusalOf(runProviderProbe(request, managed));
			expect(port.asked).toHaveLength(1);
			// Another probe kind, and another directory, are each their own decision.
			await refusalOf(runProviderProbe({ ...request, kind: 'other' }, managed));
			expect(port.asked).toHaveLength(2);
			await refusalOf(runProviderProbe({ ...request, cwd: '/q' }, managed));
			expect(port.asked).toHaveLength(3);
			// The Codex skill probe shares the one cache: its clear forgets these too.
			clearCodexSkillProbeRefusals();
			await refusalOf(runProviderProbe(request, managed));
			expect(port.asked).toHaveLength(4);
		});

		it('a probe asking for skip-permissions under a standard ceiling is denied by the flag, before the actor is bound', async () => {
			const port = fakeSpawnPort();
			(port as ProviderProbeManaged['port']).routeCeiling = () =>
				route({ permissionMode: 'standard' });
			const verify = vi.spyOn(port, 'verify');
			const error = await refusalOf(
				runProviderProbe(
					{
						providerId: 'claude-code',
						kind: 'slash-commands',
						command: '/bin/claude',
						args: ['--print', '--dangerously-skip-permissions', '--', '/help'],
						cwd: '/p',
					},
					{ port, actor }
				)
			);
			expect(error.state).toBe('denied');
			expect(error.code).toBe('policy-denied');
			expect(error.message).toContain('--dangerously-skip-permissions');
			expect(error.message).toContain('standard');
			expect(verify).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('a ceiling pinning no mode admits skip-permissions and strips the route names from the env', async () => {
			const port = fakeSpawnPort();
			(port as ProviderProbeManaged['port']).routeCeiling = () =>
				route({ accountDir: '/managed/claude' });
			stdoutText = initLine(['/help']);
			await runProviderProbe(
				{
					providerId: 'claude-code',
					kind: 'slash-commands',
					command: '/bin/claude',
					args: ['--print', '--dangerously-skip-permissions', '--', '/help'],
					cwd: '/p',
					env: { PATH: '/bin', CLAUDE_CONFIG_DIR: '/personal', ANTHROPIC_API_KEY: 'sk-x' },
				},
				{ port, actor }
			);
			expect(port.asked).toHaveLength(1);
			expect(calls[0].spec.args).toContain('--dangerously-skip-permissions');
			expect(calls[0].spec.env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/managed/claude' });
		});

		it('a route requiring an approved credential refuses the probe, which delivers none', async () => {
			const port = fakeSpawnPort();
			(port as ProviderProbeManaged['port']).routeCeiling = () =>
				route({ login: 'approved-credential' });
			const error = await refusalOf(
				runProviderProbe(
					{ providerId: 'claude-code', kind: 'k', command: 'c', args: ['--help'], cwd: '/p' },
					{ port, actor }
				)
			);
			expect(error.code).toBe('policy-denied');
			expect(error.message).toContain('approved credential');
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('a provider with no child-process route, and an actor the port cannot bind, each refuse by name', async () => {
			const unrouted = await refusalOf(
				runProviderProbe(
					{ providerId: 'gemini-cli', kind: 'k', command: 'c', args: [] },
					{ port: fakeSpawnPort(), actor }
				)
			);
			expect(unrouted.state).toBe('unavailable');
			expect(unrouted.code).toBe('capability-unsupported');
			expect(unrouted.message).toContain(PROVIDER_PROBE_ROUTE);
			const unbound = await refusalOf(
				runProviderProbe(
					{ providerId: 'claude-code', kind: 'k', command: 'c', args: [] },
					{ port: fakeSpawnPort({ accept: () => ['not this installation'] }), actor }
				)
			);
			expect(unbound.state).toBe('denied');
			expect(unbound.message).toContain('not this installation');
			expect(startTurn).not.toHaveBeenCalled();
		});
	});

	describe('the slash-command probe', () => {
		it('standalone keeps its exact execFileNoThrow call, skip-permissions included', async () => {
			vi.mocked(execFileNoThrow).mockResolvedValue({
				stdout: initLine(['/help']),
				stderr: '',
				exitCode: 0,
			});
			await expect(probeClaudeSlashCommands('/bin/claude', '/proj')).resolves.toEqual(['/help']);
			expect(execFileNoThrow).toHaveBeenCalledWith(
				'/bin/claude',
				[
					'--print',
					'--verbose',
					'--output-format',
					'stream-json',
					'--dangerously-skip-permissions',
					'--no-session-persistence',
					'--',
					'/help',
				],
				'/proj'
			);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('managed and admitted, reads the init event from the admitted turn', async () => {
			const port = fakeSpawnPort();
			stdoutText = 'warn\n' + initLine(['/help', '/compact']);
			await expect(
				probeClaudeSlashCommands('/bin/claude', '/proj', { PATH: '/bin' }, { port, actor })
			).resolves.toEqual(['/help', '/compact']);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(port.asked[0].snapshot).toMatchObject({ purpose: 'probe', provider: 'claude-code' });
			expect(port.asked[0].context.traceId).toBe('claude-code-slash-commands-probe:/proj');
			expect(calls[0].spec.args).toContain('--dangerously-skip-permissions');
		});

		it('refused under a standard ceiling: no process, null, a warn by name, and the cached form asks nobody next time', async () => {
			const port = fakeSpawnPort();
			(port as ProviderProbeManaged['port']).routeCeiling = () =>
				route({ permissionMode: 'standard' });
			const env = { PATH: '/bin' };
			await expect(
				probeClaudeSlashCommandsCached('/bin/claude', '/proj', env, { port, actor })
			).resolves.toBeNull();
			expect(startTurn).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(logger.warn).toHaveBeenCalledWith(
				'Slash command probe refused under management; offering no commands',
				expect.any(String),
				expect.objectContaining({
					state: 'denied',
					code: 'policy-denied',
					message: expect.stringContaining('--dangerously-skip-permissions'),
				})
			);
			const routeCeiling = vi.spyOn(port as ProviderProbeManaged['port'], 'routeCeiling');
			await expect(
				probeClaudeSlashCommandsCached('/bin/claude', '/proj', env, { port, actor })
			).resolves.toBeNull();
			expect(routeCeiling).not.toHaveBeenCalled();
			expect(startTurn).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});
	});

	describe('the detector', () => {
		const binaryOnly = () =>
			vi.mocked(execFileNoThrow).mockImplementation(async () => ({
				stdout: '/usr/bin/opencode\n',
				stderr: '',
				exitCode: 0,
			}));

		it('with no deps probes exactly as before', async () => {
			vi.mocked(execFileNoThrow).mockImplementation(async (cmd: string) =>
				cmd === 'which' || cmd === 'where'
					? { stdout: '/usr/bin/opencode\n', stderr: '', exitCode: 0 }
					: { stdout: 'm1\nm2\n', stderr: '', exitCode: 0 }
			);
			const detector = new AgentDetector();
			detector.setCustomPaths({ opencode: '/usr/bin/opencode' });
			expect(await detector.discoverModels('opencode')).toEqual(
				expect.arrayContaining(['m1', 'm2'])
			);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('managed: a denied models probe is a failed run by name, no Sentry, and the other sources still answer', async () => {
			binaryOnly();
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', policyRevision: 1, reason: 'no probes' }),
			});
			const detector = new AgentDetector(undefined, { managedProbe: () => ({ port, actor }) });
			detector.setCustomPaths({ opencode: '/usr/bin/opencode' });
			expect(await detector.discoverModels('opencode')).toEqual([]);
			expect(startTurn).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'Probe of opencode (models) refused under management',
				expect.any(String),
				expect.objectContaining({ state: 'denied', code: 'policy-denied' })
			);
			expect(logger.warn).toHaveBeenCalledWith(
				`CLI model discovery failed for opencode: exit code ${PROBE_REFUSED_EXIT_CODE}`,
				expect.any(String),
				expect.objectContaining({ stderr: expect.stringContaining('no probes') })
			);
			// The exec mock served binary detection only, never the probe.
			for (const call of vi.mocked(execFileNoThrow).mock.calls) {
				expect(call[1]).not.toEqual(['models']);
			}
		});

		it('managed and admitted: the models probe runs under the lease', async () => {
			binaryOnly();
			const port = fakeSpawnPort();
			stdoutText = 'm1\n';
			const detector = new AgentDetector(undefined, { managedProbe: () => ({ port, actor }) });
			detector.setCustomPaths({ opencode: '/usr/bin/opencode' });
			expect(await detector.discoverModels('opencode')).toContain('m1');
			expect(port.asked).toHaveLength(1);
			expect(port.asked[0].snapshot).toMatchObject({ purpose: 'probe', provider: 'opencode' });
			expect(calls[0].spec.args).toEqual(['models']);
		});
	});
});
