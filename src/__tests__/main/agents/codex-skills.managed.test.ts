/**
 * The Codex skill probe under management (MRC2-02-04, MRC2-02-07A).
 *
 * `discoverCodexSkills()` is driven against the real lease authority and the
 * real context verifier behind `fakeSpawnPort` (only the policy answer is a
 * table), with `startTurn` mocked as `codex-skills.test.ts` mocks it, so the
 * spec and the admission the sink was handed are what these tests read. The
 * route table (`providerRouteSupport`) is the real one except where a test
 * names a qualified table for the admitted cases, since no Codex probe route
 * has an enforcement producer in this build. Each guard here has a test that
 * fails when the guard is removed:
 *
 * - a call with no `managed`, and a standalone port, spawn exactly as before
 *   (no `admission` key) and ask nobody;
 * - a managed host refuses the `codex-app-server` route by name before
 *   `startTurn` and before the actor is bound, and a second detection answers
 *   from the remembered refusal without reading the route table again;
 * - on a qualified route the probe is admitted `purpose: probe`,
 *   `operation: start`, by the actor's origin and under the
 *   `codex-skill-probe:<cwd>` trace id, and the gate the sink is handed admits
 *   the spec `startTurn` received and refuses a changed one `lease-invalid`;
 * - a policy denial starts nothing, is remembered per directory, actor and
 *   revision, is asked again on a new revision and once the TTL has passed;
 * - an actor the port cannot bind and an unavailable authority refuse with
 *   their state and code, and nothing starts;
 * - the agents handler hands the manager's port and the transport's actor as
 *   the fourth argument, keeps three arguments with no port, and logs a
 *   refusal at warn with no Sentry report while the disk scan still answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';

vi.mock('../../../shared/maestro-lib/run/start-turn', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/run/start-turn')>();
	return { ...actual, startTurn: vi.fn() };
});
vi.mock('../../../shared/maestro-lib/providers/capabilities', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../shared/maestro-lib/providers/capabilities')>();
	return { ...actual, providerRouteSupport: vi.fn(actual.providerRouteSupport) };
});
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
// `smol-toml` is not installed in every environment and the translation
// service imports it at the top level; the handler under test never reaches it.
vi.mock('../../../main/provider-translation-service', () => ({
	ProviderTranslationService: class {},
}));
vi.mock('../../../main/web-server/auth/transport-actor', () => ({
	currentSpawnActor: vi.fn(() => ({ peer: 'host-secret' })),
}));
// The disk scan the handler falls back to reads nothing here, so what it
// answers after a refusal is the empty list and not this machine's skills.
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readdirSync: vi.fn(() => []),
	accessSync: vi.fn(),
	constants: { R_OK: 4 },
	promises: {
		readdir: vi.fn(async () => {
			throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
		}),
		readFile: vi.fn(),
	},
}));

import {
	startTurn,
	DispatchRefusedError,
	type TurnHandlers,
	type TurnExit,
	type TurnProcessSpec,
	type StartTurnOptions,
} from '../../../shared/maestro-lib/run/start-turn';
import { providerRouteSupport } from '../../../shared/maestro-lib/providers/capabilities';
import {
	buildDispatchSnapshot,
	dispatchSnapshotDigest,
} from '../../../shared/maestro-lib/managed/authority';
import { PROBE_REFUSAL_TTL_MS } from '../../../shared/maestro-lib/managed/host-adapter';
import * as codexSkills from '../../../main/agents/codex-skills';
import {
	discoverCodexSkills,
	clearCodexSkillProbeRefusals,
	CODEX_SKILL_PROBE_ROUTE,
	type CodexSkillProbeManaged,
} from '../../../main/agents/codex-skills';
import { registerAgentsHandlers } from '../../../main/ipc/handlers/agents';
import { ipcMain } from 'electron';
import { logger } from '../../../main/utils/logger';
import { captureException } from '../../../main/utils/sentry';
import { currentSpawnActor } from '../../../main/web-server/auth/transport-actor';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

const cwd = path.resolve('project');
const actor = { peer: 'host-secret' } as const;
const ALL_ROUTES = ['child-process', 'codex-app-server', 'opencode-server', 'pty', 'ssh'] as const;

/** A route table that qualifies the app-server route: the admitted cases need one. */
function qualifiedRoutes(): void {
	vi.mocked(providerRouteSupport).mockImplementation((agentId: string) =>
		ALL_ROUTES.map((route) => ({
			agentId,
			route: route as never,
			standalone: 'implemented' as const,
			managed: (route === 'codex-app-server' || route === 'child-process'
				? 'implemented'
				: 'unsupported') as never,
			note: 'test table',
		}))
	);
}

async function refusalOf(promise: Promise<unknown>): Promise<DispatchRefusedError> {
	const error = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(error).toBeInstanceOf(DispatchRefusedError);
	return error as DispatchRefusedError;
}

describe('Codex skill probe under admission', () => {
	let handlers: TurnHandlers;
	let finish: (exit: TurnExit) => void;
	const write = vi.fn();
	const terminate = vi.fn();
	const calls: Array<{ spec: TurnProcessSpec; options: StartTurnOptions }> = [];

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(providerRouteSupport).mockReset();
		calls.length = 0;
		clearCodexSkillProbeRefusals();
		vi.mocked(startTurn).mockImplementation((spec, callbacks, options) => {
			calls.push({ spec, options });
			handlers = callbacks;
			const done = new Promise<TurnExit>((resolve) => {
				finish = resolve;
			});
			terminate.mockImplementation(() => finish({} as TurnExit));
			write.mockImplementation((line: string) => {
				const message = JSON.parse(line);
				if (message.id)
					queueMicrotask(() =>
						handlers.onLine?.(
							JSON.stringify({
								id: message.id,
								result:
									message.method === 'initialize'
										? {}
										: {
												data: [
													{
														cwd,
														skills: [
															{ name: 'review', enabled: true, path: path.join(cwd, 'SKILL.md') },
														],
													},
												],
											},
							})
						)
					);
				return true;
			});
			return {
				child: { stdin: { writable: true, write } },
				terminate,
				done,
			} as unknown as ReturnType<typeof startTurn>;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('standalone', () => {
		it('a call with no managed argument spawns as before, with no admission, and asks nobody', async () => {
			const skills = await discoverCodexSkills('codex', cwd, { CODEX_HOME: cwd });
			expect(skills.map((s) => s.name)).toEqual(['review']);
			expect(calls).toHaveLength(1);
			expect(calls[0].options).not.toHaveProperty('admission');
			expect(calls[0].options).toMatchObject({
				keepStdinOpen: true,
				label: 'codex-skill-discovery',
			});
			expect(calls[0].spec).toMatchObject({ cwd, env: { CODEX_HOME: cwd }, args: ['app-server'] });
			expect(providerRouteSupport).not.toHaveBeenCalled();
			expect(terminate).toHaveBeenCalledOnce();
		});

		it('a standalone port spawns as before, with no admission, and asks nobody', async () => {
			const port = fakeSpawnPort({ standing: 'standalone' });
			const verify = vi.spyOn(port, 'verify');
			const skills = await discoverCodexSkills('codex', cwd, {}, { port, actor });
			expect(skills.map((s) => s.name)).toEqual(['review']);
			expect(calls).toHaveLength(1);
			expect(calls[0].options).not.toHaveProperty('admission');
			expect(verify).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
			expect(providerRouteSupport).not.toHaveBeenCalled();
		});
	});

	describe('the route', () => {
		it('a managed host refuses the codex-app-server route by name, before startTurn and before the actor is bound', async () => {
			const port = fakeSpawnPort();
			const verify = vi.spyOn(port, 'verify');
			const error = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(error.state).toBe('unavailable');
			expect(error.code).toBe('capability-unsupported');
			expect(error.message).toContain(CODEX_SKILL_PROBE_ROUTE);
			expect(error.message).toContain('codex');
			expect(error.message).toContain('Nothing was started');
			expect(startTurn).not.toHaveBeenCalled();
			expect(verify).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
			expect(providerRouteSupport).toHaveBeenCalledTimes(1);
			expect(providerRouteSupport).toHaveBeenCalledWith('codex');
		});

		it('a second detection answers from the remembered refusal without reading the route table', async () => {
			const port = fakeSpawnPort();
			const managed: CodexSkillProbeManaged = { port, actor };
			await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(providerRouteSupport).toHaveBeenCalledTimes(1);
			const again = await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(again).toMatchObject({ state: 'unavailable', code: 'capability-unsupported' });
			expect(providerRouteSupport).toHaveBeenCalledTimes(1);
			expect(startTurn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
		});

		it('clearing the remembered refusals reads the route table again', async () => {
			const port = fakeSpawnPort();
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			clearCodexSkillProbeRefusals();
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(providerRouteSupport).toHaveBeenCalledTimes(2);
		});
	});

	describe('a qualified route', () => {
		beforeEach(qualifiedRoutes);

		it('admits the probe as a probe turn of the CLI secret, traced under the directory, with the lease covering the spec startTurn received', async () => {
			const port = fakeSpawnPort();
			const skills = await discoverCodexSkills('codex', cwd, { A: '1' }, { port, actor });
			expect(skills.map((s) => s.name)).toEqual(['review']);
			expect(port.asked).toHaveLength(1);
			expect(port.asked[0].snapshot).toMatchObject({
				purpose: 'probe',
				origin: 'cli',
				operation: 'start',
				provider: 'codex',
				cwd,
				args: ['app-server'],
				envKeys: ['A'],
				target: { kind: 'local' },
			});
			expect(port.asked[0].context).toMatchObject({
				traceId: `codex-skill-probe:${cwd}`,
				policyRevision: 1,
				workflow: null,
				delegation: { chain: [], grantRef: null },
			});
			// Its own request, one attempt, no run above it.
			const { identity } = port.asked[0].context;
			expect(identity.runId).toBeNull();
			expect(identity.rootRunId).toBeNull();
			expect(identity.parentRunId).toBeNull();
			expect(identity.idempotencyKey).toBe(identity.requestId);
			expect(port.asked[0].policy).toEqual({ sources: [], policyRevision: 1 });

			expect(calls).toHaveLength(1);
			const { admission } = calls[0].options;
			expect(admission).toBeDefined();
			expect(admission!.attribution).toEqual({
				provider: 'codex',
				purpose: 'probe',
				operation: 'start',
				origin: 'cli',
				target: { kind: 'local' },
			});
			expect(calls[0].options).toMatchObject({
				keepStdinOpen: true,
				label: 'codex-skill-discovery',
			});
			// The gate checks out against the spec startTurn was handed, and not another.
			expect(
				admission!.gate.admit(buildDispatchSnapshot(calls[0].spec, admission!.attribution))
			).toEqual({ ok: true });
			expect(
				admission!.gate.admit(
					buildDispatchSnapshot({ ...calls[0].spec, cwd: '/elsewhere' }, admission!.attribution)
				)
			).toMatchObject({ ok: false, state: 'denied', code: 'lease-invalid' });
			expect(
				admission!.gate.admit(
					buildDispatchSnapshot(
						{ ...calls[0].spec, args: [...calls[0].spec.args, '--extra'] },
						admission!.attribution
					)
				)
			).toMatchObject({ ok: false, code: 'lease-invalid' });
			// The lease the authority minted is the one on the admission, still live
			// for the sink to bind (startTurn is a double here and binds nothing).
			const live = port.authority.live();
			expect(live).toHaveLength(1);
			expect(live[0].snapshotDigest).toBe(dispatchSnapshotDigest(port.asked[0].snapshot));
			expect(live[0].snapshotDigest).toBe(
				dispatchSnapshotDigest(buildDispatchSnapshot(calls[0].spec, admission!.attribution))
			);
		});

		it('a web login is admitted origin desktop with the account on the chain; an in-process actor is desktop too', async () => {
			const port = fakeSpawnPort();
			await discoverCodexSkills(
				'codex',
				cwd,
				{},
				{ port, actor: { peer: 'web-login', username: 'ada' } }
			);
			expect(port.asked[0].snapshot.origin).toBe('desktop');
			expect(port.asked[0].context.delegation.chain).toEqual([
				{ kind: 'human', id: 'web-login:ada' },
			]);
			expect(calls[0].options.admission?.attribution.origin).toBe('desktop');

			await discoverCodexSkills('codex', cwd, {}, { port, actor: { peer: 'in-process' } });
			expect(port.asked[1].snapshot.origin).toBe('desktop');
			expect(calls[1].options.admission?.attribution.origin).toBe('desktop');
		});

		it('an admission is never remembered: every detection asks the authority again', async () => {
			const port = fakeSpawnPort();
			const managed: CodexSkillProbeManaged = { port, actor };
			await discoverCodexSkills('codex', cwd, {}, managed);
			await discoverCodexSkills('codex', cwd, {}, managed);
			expect(port.asked).toHaveLength(2);
			expect(calls).toHaveLength(2);
			expect(calls[1].options.admission).toBeDefined();
			expect(calls[1].options.admission).not.toBe(calls[0].options.admission);
		});

		it('a policy denial starts nothing and is thrown with the authority state, code and reason', async () => {
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', reason: 'no probes here', policyRevision: 1 }),
			});
			const error = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(error.state).toBe('denied');
			expect(error.code).toBe('policy-denied');
			expect(error.message).toBe('no probes here');
			expect(startTurn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(1);
			expect(port.authority.live()).toHaveLength(0);
		});

		it('a denial is remembered for the directory and the actor; another directory or transport is its own decision', async () => {
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', reason: 'no probes', policyRevision: 1 }),
			});
			const verify = vi.spyOn(port, 'verify');
			const managed: CodexSkillProbeManaged = { port, actor };
			await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(port.asked).toHaveLength(1);
			// The same directory and actor: answered from memory, nobody asked, nothing bound.
			const again = await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(again).toMatchObject({ state: 'denied', code: 'policy-denied', message: 'no probes' });
			expect(port.asked).toHaveLength(1);
			expect(verify).toHaveBeenCalledTimes(1);
			// Another directory is its own decision.
			await refusalOf(discoverCodexSkills('codex', `${cwd}-2`, {}, managed));
			expect(port.asked).toHaveLength(2);
			expect(port.asked[1].context.traceId).toBe(`codex-skill-probe:${cwd}-2`);
			// Another transport for the same directory is its own decision.
			await refusalOf(
				discoverCodexSkills(
					'codex',
					cwd,
					{},
					{ port, actor: { peer: 'web-login', username: 'ada' } }
				)
			);
			expect(port.asked).toHaveLength(3);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('a denial made on one policy revision is asked again on the next', async () => {
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', reason: 'no probes', policyRevision: 1 }),
			});
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(port.asked).toHaveLength(1);
			const revised: CodexSkillProbeManaged['port'] = {
				...port,
				policy: () => ({ sources: [], policyRevision: 2 }),
			};
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port: revised, actor }));
			expect(port.asked).toHaveLength(2);
			expect(port.asked[1].context.policyRevision).toBe(2);
			expect(port.asked[1].policy.policyRevision).toBe(2);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('a remembered denial expires with the TTL and is asked again', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-10-27T12:00:00Z'));
			const port = fakeSpawnPort({
				decide: () => ({ decision: 'deny', reason: 'no probes', policyRevision: 1 }),
			});
			const managed: CodexSkillProbeManaged = { port, actor };
			await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			vi.setSystemTime(new Date('2026-10-27T12:00:00Z').getTime() + PROBE_REFUSAL_TTL_MS - 1);
			await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(port.asked).toHaveLength(1);
			vi.setSystemTime(new Date('2026-10-27T12:00:00Z').getTime() + PROBE_REFUSAL_TTL_MS);
			await refusalOf(discoverCodexSkills('codex', cwd, {}, managed));
			expect(port.asked).toHaveLength(2);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('an actor the port cannot bind is refused denied, naming the problems, before the authority is asked', async () => {
			const port = fakeSpawnPort({ accept: () => ['installation inst-other is not this one'] });
			const error = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(error.state).toBe('denied');
			expect(error.code).toBe('unauthenticated');
			expect(error.message).toContain('could not be bound');
			expect(error.message).toContain('installation inst-other is not this one');
			expect(error.message).toContain('Nothing was started');
			expect(startTurn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			// Remembered like any refusal: the port is not asked to bind again.
			const verify = vi.spyOn(port, 'verify');
			await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(verify).not.toHaveBeenCalled();
		});

		it('an unavailable authority is refused unavailable, by its reason, and not asked again within the TTL', async () => {
			const port = fakeSpawnPort({ decide: () => ({ decision: 'unavailable', reason: 'away' }) });
			const error = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(error.state).toBe('unavailable');
			expect(error.code).toBe('runtime-unavailable');
			expect(error.message).toBe('away');
			const again = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(again).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
			expect(port.asked).toHaveLength(1);
			expect(startTurn).not.toHaveBeenCalled();
		});

		it('an authority whose outcome is unknown is refused by that state', async () => {
			const port = fakeSpawnPort({ decide: () => ({ decision: 'unknown', reason: 'lost' }) });
			const error = await refusalOf(discoverCodexSkills('codex', cwd, {}, { port, actor }));
			expect(error.state).toBe('unknown');
			expect(error.code).toBe('outcome-unknown');
			expect(startTurn).not.toHaveBeenCalled();
		});
	});
});

describe('the agents handler and the probe', () => {
	type Handler = (...args: unknown[]) => Promise<unknown>;
	const detector = {
		getAgent: vi.fn(async () => ({
			id: 'codex',
			available: true,
			path: '/bin/codex',
			command: 'codex',
		})),
	};
	const store = { get: vi.fn(() => ({})), set: vi.fn() };

	function register(processManager: unknown): Handler {
		const registered = new Map<string, Handler>();
		vi.mocked(ipcMain.handle).mockImplementation(((channel: string, handler: Handler) => {
			registered.set(channel, handler);
		}) as never);
		registerAgentsHandlers({
			getAgentDetector: () => detector as never,
			agentConfigsStore: store as never,
			...(processManager === undefined ? {} : { getProcessManager: () => processManager as never }),
		});
		return registered.get('agents:discoverSlashCommands')!;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(providerRouteSupport).mockReset();
		clearCodexSkillProbeRefusals();
		vi.mocked(currentSpawnActor).mockReturnValue({ peer: 'host-secret' } as never);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('hands the manager port and the transport actor to the probe as the fourth argument', async () => {
		const discover = vi.spyOn(codexSkills, 'discoverCodexSkills').mockResolvedValue([]);
		const port = fakeSpawnPort();
		vi.mocked(currentSpawnActor).mockReturnValue({ peer: 'web-login', username: 'ada' } as never);
		await register({ get: vi.fn(), managedPort: () => port })({}, 'codex', '/test');
		expect(discover).toHaveBeenCalledTimes(1);
		expect(discover.mock.calls[0]).toHaveLength(4);
		expect(discover.mock.calls[0][0]).toBe('/bin/codex');
		expect(discover.mock.calls[0][1]).toBe('/test');
		expect(discover.mock.calls[0][3]).toEqual({
			port,
			actor: { peer: 'web-login', username: 'ada' },
		});
		expect(discover.mock.calls[0][3]!.port).toBe(port);
	});

	it('keeps three arguments when the manager has no port, answers null for one, or there is no manager', async () => {
		const discover = vi.spyOn(codexSkills, 'discoverCodexSkills').mockResolvedValue([]);
		await register({ get: vi.fn() })({}, 'codex', '/test');
		await register({ get: vi.fn(), managedPort: () => null })({}, 'codex', '/test');
		await register(null)({}, 'codex', '/test');
		await register(undefined)({}, 'codex', '/test');
		expect(discover).toHaveBeenCalledTimes(4);
		for (const call of discover.mock.calls) {
			expect(call).toHaveLength(3);
			expect(call[3]).toBeUndefined();
		}
		expect(currentSpawnActor).not.toHaveBeenCalled();
	});

	it('logs a refusal at warn by its state and code, reports nothing to Sentry, and the disk scan still answers', async () => {
		const discover = vi
			.spyOn(codexSkills, 'discoverCodexSkills')
			.mockRejectedValue(new DispatchRefusedError('denied', 'policy-denied', 'no probes'));
		const result = await register({ get: vi.fn(), managedPort: () => fakeSpawnPort() })(
			{},
			'codex',
			'/test'
		);
		expect(result).toEqual([]);
		expect(discover).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('refused under management'),
			expect.anything(),
			{ state: 'denied', code: 'policy-denied', message: 'no probes' }
		);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('still reports an unexpected probe failure to Sentry: the refusal is the one quiet error', async () => {
		const failure = new TypeError('Malformed skills/list response');
		vi.spyOn(codexSkills, 'discoverCodexSkills').mockRejectedValue(failure);
		expect(
			await register({ get: vi.fn(), managedPort: () => fakeSpawnPort() })({}, 'codex', '/test')
		).toEqual([]);
		expect(captureException).toHaveBeenCalledWith(failure, {
			operation: 'discoverCodexSlashCommands',
		});
		expect(logger.warn).not.toHaveBeenCalledWith(
			expect.stringContaining('refused under management'),
			expect.anything(),
			expect.anything()
		);
	});

	it('on a managed host in this build the real probe is refused by route at the handler, starts nothing, and the listing is the disk scan', async () => {
		const port = fakeSpawnPort();
		const verify = vi.spyOn(port, 'verify');
		expect(await register({ get: vi.fn(), managedPort: () => port })({}, 'codex', '/test')).toEqual(
			[]
		);
		expect(startTurn).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('refused under management'),
			expect.anything(),
			expect.objectContaining({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: expect.stringContaining(CODEX_SKILL_PROBE_ROUTE),
			})
		);
		expect(captureException).not.toHaveBeenCalled();
	});
});
