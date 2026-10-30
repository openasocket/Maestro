/**
 * `runAgentTurn`: an assembled turn started, streamed, stopped, and refused.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn
 * (`src/__tests__/main/process-manager/recordings/`), so a turn here is a real process on a
 * real pipe. The assembled turn is the real `assembleTurn` output with only the command swapped
 * for the fake agent, which is what proves the plan, the environment, and the prompt reach the
 * process the way `assembleTurn` described them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Stop's remote half is observed here, never sent: a real one runs ssh.
const remoteSignals = vi.hoisted(
	() =>
		[] as Array<{
			pidFile: string;
			mode: string;
			promptArtifactPath?: string;
		}>
);
vi.mock('../../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../shared/maestro-lib/control/ssh-remote-signal')
	>()),
	signalRemoteAgent: (target: { pidFile: string; promptArtifactPath?: string }, mode: string) => {
		remoteSignals.push({
			pidFile: target.pidFile,
			mode,
			...(target.promptArtifactPath ? { promptArtifactPath: target.promptArtifactPath } : {}),
		});
		return true;
	},
}));

import {
	claudeTranscriptPath,
	clearRememberedClaudeSessionCosts,
} from '../../../../shared/claudeCostTracker';
import { getEffortRejection, resetEffortRejections } from '../../../../shared/effortRejection';
import { SSH_STDIN_REMOTE_SHELL } from '../../../../shared/maestro-lib/control/ssh-remote-signal';
import { newRemotePromptFileDestination } from '../../../../shared/maestro-lib/launch/ssh-command-builder';
import * as launchPlanner from '../../../../shared/maestro-lib/launch/launch-plan';
import * as runToCompletion from '../../../../shared/maestro-lib/run/run-to-completion';
import * as pipeSpawn from '../../../../shared/maestro-lib/run/pipe-spawn';
import * as turnArgs from '../../../../shared/maestro-lib/turns/args';
import { logger } from '../../../../shared/maestro-lib/host';

import {
	assembleTurn,
	type AssembledTurn,
	type TurnAgent,
	type TurnContext,
	type TurnTab,
} from '../../../../shared/maestro-lib/turns/assemble';
import {
	runAgentTurn,
	type AgentTurnRun,
	type RunAgentTurnOptions,
} from '../../../../shared/maestro-lib/turns/run-agent-turn';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import type { SshRemoteConfig } from '../../../../shared/types';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../main/process-manager/recordings/captured';
import {
	createScratchDir,
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../run/fakeAgent';
import { makeAgent, makeContext, makeTab } from './fixtures';

let scratch: { dir: string; cleanup: () => void };

beforeAll(() => {
	scratch = createScratchDir('maestro-run-agent-turn');
});

afterAll(() => {
	scratch.cleanup();
});

beforeEach(() => {
	remoteSignals.length = 0;
});

type RunAgentTurnDeps = NonNullable<RunAgentTurnOptions['deps']>;

let sequence = 0;

interface FakeOptions {
	recording: string;
	agent?: Partial<TurnAgent>;
	tab?: Partial<TurnTab>;
	context?: Partial<TurnContext>;
	/** Keep the fake agent running after its replay, until it is stopped. */
	hold?: boolean;
	/** Extra environment for the fake agent (it records what it was given). */
	env?: Record<string, string>;
	text?: string;
}

/** A real `assembleTurn` result whose process is the fake agent replaying a recording. */
function assembleWithFakeAgent(toolType: string, options: FakeOptions): AssembledTurn {
	const recording = CAPTURED_RECORDINGS[options.recording];
	const file = writeFakeTurn(scratch.dir, fakeTurnFromRecording(recording));
	const result = assembleTurn(
		makeAgent({
			toolType,
			cwd: scratch.dir,
			customEnvVars: {
				FAKE_AGENT_RECORDING: file,
				...(options.hold ? { FAKE_AGENT_HOLD: '1' } : {}),
				...options.env,
			},
			...options.agent,
		}),
		makeTab(options.tab),
		{ text: options.text ?? 'hello' },
		makeContext(toolType, options.context)
	);
	if (!result.ok) throw new Error(`expected a turn: ${result.message}`);
	const turn = result.turn;
	return {
		...turn,
		launch: {
			...turn.launch,
			command: process.execPath,
			args: [FAKE_AGENT_PATH, ...turn.launch.args],
		},
	};
}

function outFile(name: string): string {
	return path.join(scratch.dir, `${name}-${++sequence}.out`);
}

function optionsFor(overrides: Partial<RunAgentTurnOptions> = {}): RunAgentTurnOptions {
	return { sessionId: 'agent-1-ai-tab-1', stopGraceMs: 200, ...overrides };
}

async function start(turn: AssembledTurn, overrides: Partial<RunAgentTurnOptions> = {}) {
	const started = await runAgentTurn(turn, optionsFor(overrides));
	if (!started.ok) throw new Error(`expected a running turn: ${started.message}`);
	return started.run;
}

async function collect(run: AgentTurnRun): Promise<ParsedEvent[]> {
	const events: ParsedEvent[] = [];
	for await (const event of run.events) events.push(event);
	return events;
}

describe('runAgentTurn: a local turn', () => {
	it('streams the parsed events, then reports the outcome and the session id', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' })
		);

		const events = await collect(run);
		const result = await run.result;

		expect(events.map((event) => event.type)).toContain('result');
		expect(result.outcome).toBe('completed');
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
		expect(result.answerText).toBe('The capital of France is Paris.');
		expect(result.error).toBeUndefined();
		expect(result.exit.exitCode).toBe(0);
	});

	it('completes a Claude Code turn from its real recording', async () => {
		const run = await start(
			assembleWithFakeAgent('claude-code', { recording: 'captured-claude-code-normal' })
		);

		const result = await run.result;

		expect(result.outcome).toBe('completed');
		expect(result.sessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		expect(result.usage?.outputTokens).toBeGreaterThan(0);
	});

	it('holds events that arrive before anyone iterates, and ends the stream with the turn', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' })
		);
		await run.result;

		const late = await collect(run);

		expect(late.length).toBeGreaterThan(0);
		expect(late.map((event) => event.type)).toContain('result');
	});

	it('hands the process the arguments, the prompt, and the environment `assembleTurn` described', async () => {
		const argvOut = outFile('argv');
		const envOut = outFile('env');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			text: 'what is the capital of France',
			env: { FAKE_AGENT_ARGV_OUT: argvOut, FAKE_AGENT_ENV_OUT: envOut },
		});

		const run = await start(turn);
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const env = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
		// Everything after the script is what `assembleTurn` planned: its arguments, then the prompt.
		expect(argv.slice(0, turn.launch.args.length - 1)).toEqual(turn.launch.args.slice(1));
		expect(argv.join('\n')).toContain('what is the capital of France');
		expect(env.MAESTRO_CALLER_AGENT_ID).toBe('agent-1');
		expect(env.MAESTRO_CALLER_TAB_ID).toBe('tab-1');
	});

	it('resumes with the tab session id and returns the id the provider announced', async () => {
		const argvOut = outFile('argv');
		const run = await start(
			assembleWithFakeAgent('opencode', {
				recording: 'captured-opencode-resumed',
				tab: { agentSessionId: CAPTURED_OPENCODE_SESSION_ID },
				env: { FAKE_AGENT_ARGV_OUT: argvOut },
			})
		);

		const result = await run.result;

		expect(JSON.parse(fs.readFileSync(argvOut, 'utf8'))).toContain(CAPTURED_OPENCODE_SESSION_ID);
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('reports a provider that cannot be started as a crash that names the command', async () => {
		const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });

		const run = await start({ ...turn, launch: { ...turn.launch, command: '/no/such/provider' } });
		const result = await run.result;

		expect(result.outcome).toBe('crashed');
		expect(result.error?.message).toContain('/no/such/provider');
		expect(await collect(run)).toEqual([]);
	});
});

describe('runAgentTurn: stopping', () => {
	it('stops a running turn through the stop ladder and reports it as interrupted', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true })
		);

		// The fake agent has replayed the whole turn once the result event has arrived.
		for await (const event of run.events) {
			if (event.type === 'result') break;
		}
		expect(run.stopRequested()).toBe(false);
		run.interrupt();
		const result = await run.result;

		expect(run.stopRequested()).toBe(true);
		expect(result.outcome).toBe('interrupted');
		expect(result.exit.interrupted).toBe(true);
		expect(result.sessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
	});

	it('ends the event stream when the turn is stopped, so a reader never waits forever', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true })
		);
		const reader = collect(run);

		await new Promise((resolve) => setTimeout(resolve, 300));
		run.terminate();

		const events = await reader;
		expect(events.length).toBeGreaterThan(0);
		expect((await run.result).outcome).toBe('interrupted');
	});

	it('stops when its signal aborts', async () => {
		const controller = new AbortController();
		const run = await start(
			assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal', hold: true }),
			{ signal: controller.signal }
		);

		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();

		expect((await run.result).outcome).toBe('interrupted');
	});
});

describe('runAgentTurn: an SSH remote', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	const sshAgent: Partial<TurnAgent> = {
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
	};

	it('fails when the remote does not exist, and never runs the agent here in its place', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' } },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({ sshStore: { getSshRemotes: () => [remote] } })
		);

		expect(started.ok).toBe(false);
		if (started.ok) return;
		expect(started.reason).toBe('ssh-unresolved');
		expect(started.message).toContain('"gone"');
		expect(started.message).toContain('nothing ran on this machine');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when the remote is disabled', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({ sshStore: { getSshRemotes: () => [{ ...remote, enabled: false }] } })
		);

		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.message).toContain('disabled');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when there is no remote list to look the remote up in', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(turn, optionsFor());

		expect(started.ok).toBe(false);
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('fails when the wrapper degrades to a local spawn', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: sshAgent,
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			turn,
			optionsFor({
				sshStore: { getSshRemotes: () => [remote] },
				deps: {
					wrapSpawnWithSsh: async (config) => ({
						command: process.execPath,
						args: [FAKE_AGENT_PATH],
						cwd: config.cwd,
						sshRemoteUsed: null,
					}),
				},
			})
		);

		expect(started.ok).toBe(false);
		if (!started.ok) expect(started.reason).toBe('ssh-unresolved');
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('runs what the SSH wrapper built, with the remote command, not this machine`s path', async () => {
		const stdinOut = outFile('stdin');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { ...sshAgent, customPath: '/opt/remote/bin/opencode' },
		});
		let wrapped: Parameters<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>[0] | undefined;

		const run = await start(turn, {
			sshStore: { getSshRemotes: () => [remote] },
			deps: {
				env: {
					...process.env,
					FAKE_AGENT_RECORDING: writeFakeTurn(
						scratch.dir,
						fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
					),
					FAKE_AGENT_STDIN_OUT: stdinOut,
				},
				wrapSpawnWithSsh: async (config) => {
					wrapped = config;
					return {
						command: process.execPath,
						args: [FAKE_AGENT_PATH],
						cwd: scratch.dir,
						sshStdinScript: 'cd /work && exec opencode',
						sshRemoteUsed: remote,
					};
				},
			},
		});
		const result = await run.result;

		expect(wrapped?.command).toBe('/opt/remote/bin/opencode');
		expect(wrapped?.prompt).toBe(turn.launch.prompt);
		expect(wrapped?.cwd).toBe(scratch.dir);
		expect(wrapped?.agentBinaryName).toBe('opencode');
		expect(wrapped?.querySource).toBe('user');
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('cd /work && exec opencode');
		expect(result.outcome).toBe('completed');
	});
});

describe('runAgentTurn: refusals', () => {
	it('refuses images before anything is started', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const started = await runAgentTurn(
			{ ...turn, launch: { ...turn.launch, hasImages: true } },
			optionsFor()
		);

		expect(started).toMatchObject({ ok: false, reason: 'images-unsupported' });
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('refuses Standard permission mode on a Claude Code API turn, never downgrading it', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			tab: { permissionMode: 'standard' },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});
		expect(turn.permissionMode).toBe('standard');

		const started = await runAgentTurn(turn, optionsFor());

		expect(started).toMatchObject({ ok: false, reason: 'standard-mode-unsupported' });
		expect(fs.existsSync(argvOut)).toBe(false);
	});

	it('runs Standard mode for a provider with no permission relay to miss', async () => {
		const run = await start(
			assembleWithFakeAgent('opencode', {
				recording: 'captured-opencode-normal',
				tab: { permissionMode: 'standard' },
			})
		);

		expect((await run.result).outcome).toBe('completed');
	});

	it('refuses a provider with no output parser', async () => {
		const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });

		const started = await runAgentTurn(
			{ ...turn, provider: { ...turn.provider, id: 'no-such-provider' } },
			optionsFor()
		);

		expect(started).toMatchObject({ ok: false, reason: 'no-parser' });
	});
});

describe('runAgentTurn: Grok launch refusals', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	let turn: AssembledTurn;

	beforeEach(() => {
		resetEffortRejections();
		vi.spyOn(runToCompletion, 'runTurn').mockImplementation(() => {
			throw new Error('A refused launch must never start a process');
		});
		vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
		const assembled = assembleTurn(
			makeAgent({ toolType: 'grok', cwd: scratch.dir }),
			makeTab(),
			{ text: 'Keep the selected model and effort.' },
			makeContext('grok')
		);
		if (!assembled.ok) throw new Error(assembled.message);
		turn = assembled.turn;
	});

	afterEach(() => {
		try {
			expect(runToCompletion.runTurn).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			resetEffortRejections();
		}
	});

	describe.each(['local', 'resolved SSH'] as const)('%s', (target) => {
		it.each([
			{
				selection: 'unverified none',
				args: ['-m', 'fixture-model', '--reasoning-effort', 'none'],
				message: 'Grok effort "none" requires verified support for the selected model.',
			},
			{
				selection: 'conflicting models',
				args: ['-m', 'fixture-model', '--model=another-model', '--reasoning-effort', 'high'],
				message:
					'Conflicting Grok model selections. Configure one value across settings and custom arguments.',
			},
			{
				selection: 'conflicting efforts',
				args: ['-m', 'fixture-model', '--reasoning-effort', 'high', '--effort=low'],
				message:
					'Conflicting Grok effort selections. Configure one value across settings and custom arguments.',
			},
		])(
			'preserves $selection as a model/effort refusal without retrying',
			async ({ args, message }) => {
				const getSshRemotes = vi.fn(() => [remote]);
				const wrapSpawnWithSsh = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
				// Exercise the final launch boundary: normal assembly rejects these selections earlier.
				const launch = {
					...turn.launch,
					args: [...args],
					sshRemoteConfig:
						target === 'resolved SSH' ? { enabled: true, remoteId: remote.id } : undefined,
				};
				const started = await runAgentTurn(
					{ ...turn, launch },
					optionsFor({ sshStore: { getSshRemotes }, deps: { wrapSpawnWithSsh, env: {} } })
				);

				expect(started).toEqual({ ok: false, reason: 'grok-model-effort-refused', message });
				expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
				expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledWith(
					expect.objectContaining({ args, sshRemoteConfig: launch.sshRemoteConfig })
				);
				expect(launch.args).toEqual(args);
				// A remote prompt destination and the final plan each resolve the selected host.
				expect(getSshRemotes).toHaveBeenCalledTimes(target === 'resolved SSH' ? 2 : 0);
				expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
			}
		);
	});

	describe.each(['local', 'SSH'] as const)('%s grants', (host) => {
		describe.each([null, 'selected-native-session'])('resume %s', (resume) => {
			it.each([
				{ access: 'read', readOnly: false },
				{ access: 'write', readOnly: false },
				{ access: 'mixed', readOnly: false },
				{ access: 'read', readOnly: true },
				{ access: 'write', readOnly: true },
				{ access: 'duplicate read', readOnly: true },
				{ access: 'duplicate write', readOnly: true },
			])(
				'refuses $access with readonly=$readOnly before any artifact or retry',
				async ({ access, readOnly }) => {
					const root = '/PRIVATE grants/雪';
					const privateText = 'PRIVATE turn bytes 雪';
					const account =
						host === 'SSH'
							? '/remote/selected-account'
							: path.join(scratch.dir, 'selected-account');
					const cwd = host === 'SSH' ? '/remote/selected-project' : scratch.dir;
					const additionalDirectories = [
						{ path: root, read: access !== 'write', write: access !== 'read' },
						...(access === 'mixed'
							? [{ path: root + '/independent-read', read: true, write: false }]
							: []),
						...(access.startsWith('duplicate')
							? [
									{
										path: root,
										read: access === 'duplicate read',
										write: access === 'duplicate write',
									},
								]
							: []),
					];
					const captured = additionalDirectories.map((row) => ({ ...row }));
					const sshRemoteConfig =
						host === 'SSH' ? { enabled: true, remoteId: remote.id } : undefined;
					const assembled = assembleTurn(
						makeAgent({
							toolType: 'grok',
							cwd,
							additionalDirectories,
							customPath: '/selected/bin/grok',
							customEnvVars: { GROK_HOME: account },
							sessionSshRemoteConfig: sshRemoteConfig,
						}),
						makeTab({ agentSessionId: resume, readOnlyMode: readOnly }),
						{ text: privateText },
						makeContext('grok', { command: '/selected/bin/grok' })
					);
					if (!assembled.ok) throw new Error(assembled.message);
					const turn = assembled.turn;
					// An edit after assembly cannot drop the already selected grant refusal.
					additionalDirectories.forEach((row) => {
						row.read = false;
						row.write = false;
					});
					additionalDirectories.length = 0;
					// Synthetic file placement exercises ordering, not a Grok system-file capability.
					turn.systemPrompt = privateText;
					turn.systemPromptDelivery = { via: 'file' };
					const write = vi.spyOn(turnArgs, 'writeSystemPromptFile');
					const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
					const getSshRemotes = vi.fn(() => [remote]);
					const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
					const logs = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
						vi.spyOn(logger, level).mockImplementation(() => {})
					);
					const started = await runAgentTurn(
						turn,
						optionsFor({
							sshStore: { getSshRemotes },
							deps: { wrapSpawnWithSsh: wrap, env: {}, tempDir: scratch.dir },
						})
					);
					const message =
						readOnly && (access === 'write' || access === 'duplicate write')
							? "Grok CLI writable directory grants exceed this launch's read-only mode."
							: 'Grok CLI additional-directory read and write grants have no qualified native mechanism. Remove the grants to run with the selected working directory.';
					expect(started).toEqual({ ok: false, reason: 'grok-directory-grants-refused', message });
					expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
					expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledWith(
						expect.objectContaining({
							agent: turn.provider,
							additionalDirectories: captured,
							cwd,
							command: '/selected/bin/grok',
							remoteCommand: '/selected/bin/grok',
							sessionCustomEnvVars: { GROK_HOME: account },
							sshRemoteConfig,
							isResuming: !!resume,
							readOnlyMode: readOnly,
						})
					);
					if (resume) expect(turn.launch.args).toContain(resume);
					expect(getSshRemotes).toHaveBeenCalledTimes(host === 'SSH' ? 2 : 0);
					expect(write).not.toHaveBeenCalled();
					expect(cleanup).not.toHaveBeenCalled();
					expect(wrap).not.toHaveBeenCalled();
					expect(runToCompletion.runTurn).not.toHaveBeenCalled();
					expect(remoteSignals).toEqual([]);
					const disclosure = JSON.stringify({ started, logs: logs.map((log) => log.mock.calls) });
					for (const secret of [root, privateText, turn.launch.prompt!, account]) {
						expect(disclosure).not.toContain(secret);
						expect(disclosure).not.toContain(JSON.stringify(secret).slice(1, -1));
					}
				}
			);
		});
	});

	it.each(['missing', 'disabled'] as const)(
		'keeps a genuinely %s SSH remote classified as SSH, before effort validation',
		async (state) => {
			const wrapSpawnWithSsh = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>();
			const started = await runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						args: ['--reasoning-effort', 'none'],
						additionalDirectories: [{ path: '/private/grant', read: true, write: true }],
						sshRemoteConfig: { enabled: true, remoteId: remote.id },
					},
				},
				optionsFor({
					sshStore: {
						getSshRemotes: () => (state === 'missing' ? [] : [{ ...remote, enabled: false }]),
					},
					deps: { wrapSpawnWithSsh, env: {} },
				})
			);

			expect(started).toMatchObject({ ok: false, reason: 'ssh-unresolved' });
			if (started.ok) throw new Error('Expected an SSH refusal');
			expect(started.message).toContain(state === 'disabled' ? 'disabled' : remote.id);
			expect(started.message).toContain('nothing ran on this machine');
			expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
			expect(wrapSpawnWithSsh).not.toHaveBeenCalled();
		}
	);

	it('preserves the original managed route diagnostic ahead of an invalid Grok effort', async () => {
		const started = await runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					args: ['--reasoning-effort', 'none'],
					additionalDirectories: [{ path: '/private/grant', read: true, write: true }],
					managed: {
						route: {
							providerId: 'codex',
							model: null,
							baseUrl: null,
							accountDir: null,
							login: 'provider-login',
							permissionMode: null,
						},
					},
				},
			},
			optionsFor()
		);

		expect(started).toEqual({
			ok: false,
			reason: 'managed-denied',
			message: 'The policy routes this launch to codex, not grok.',
		});
		expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
	});

	it('retains the enrolled-host gate before planning an unmanaged Grok turn', async () => {
		turn.launch.additionalDirectories = [{ path: '/private/grant', read: true, write: true }];
		const started = await runAgentTurn(turn, optionsFor({ standing: 'enrolled' }));

		expect(started).toMatchObject({ ok: false, reason: 'managed-unavailable' });
		expect(launchPlanner.buildAgentLaunchPlan).not.toHaveBeenCalled();
	});

	it('leaves an unowned file untouched when Grok preflight refuses before materialization', async () => {
		const file = outFile('owned-system-prompt');
		fs.writeFileSync(file, 'Synthetic system prompt');
		// Ownership would transfer only if the materializer ran; preflight must skip it.
		const write = vi.spyOn(turnArgs, 'writeSystemPromptFile').mockImplementation(async (input) => ({
			args: [...input.args, '--append-system-prompt-file', file],
			prompt: input.prompt,
			tempFile: file,
			delivery: 'file',
		}));
		const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
		const started = await runAgentTurn(
			{
				...turn,
				systemPrompt: 'Synthetic system prompt',
				systemPromptDelivery: { via: 'file' },
				launch: { ...turn.launch, args: ['--reasoning-effort', 'none'] },
			},
			optionsFor({ deps: { tempDir: scratch.dir } })
		);

		expect(started).toEqual({
			ok: false,
			reason: 'grok-model-effort-refused',
			message: 'Grok effort "none" requires verified support for the selected model.',
		});
		expect(write).not.toHaveBeenCalled();
		expect(cleanup).not.toHaveBeenCalled();
		expect(launchPlanner.buildAgentLaunchPlan).toHaveBeenCalledOnce();
		expect(fs.readFileSync(file, 'utf8')).toBe('Synthetic system prompt');
	});
});

describe('runAgentTurn: private prompt-file handoff', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-file',
		name: 'File host',
		host: 'files.example.test',
		port: 2222,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};
	const fileAgent = {
		...makeContext('grok').provider,
		promptFile: { format: 'acp-json' as const, exclusivePromptFlags: ['-p', '--prompt-json-file'] },
		promptFileArgs: (file: string) => ['--prompt-json-file', file],
	};
	beforeEach(() => {
		vi.spyOn(runToCompletion, 'runTurn');
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe.each(['local', 'SSH'] as const)('%s owner', (host) => {
		it.each([
			{ name: 'short fresh', text: 'Unicode 雪', resume: null, grants: 'empty' },
			{
				name: 'long resumed',
				text: 'large 雪\n'.repeat(12_000),
				resume: 'grok-native-session',
				grants: 'off',
			},
			{
				name: 'empty resumed',
				text: '',
				resume: 'grok-native-session',
				grants: 'duplicate disabled',
			},
		])(
			'delivers $name content once and retains the correct cleanup owner',
			async ({ text, resume, grants }) => {
				const argvOut = outFile('file-argv');
				const stdinOut = outFile('file-stdin');
				const env = {
					FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
						chunks: [],
						close: { code: 0, signal: null },
					}),
					FAKE_AGENT_HOLD: '1',
					FAKE_AGENT_ARGV_OUT: argvOut,
					FAKE_AGENT_STDIN_OUT: stdinOut,
					GROK_HOME: path.join(scratch.dir, 'selected-account'),
				};
				const turn = assembleWithFakeAgent('grok', {
					recording: 'captured-opencode-normal',
					text: text || 'assembled placeholder',
					env,
					tab: { agentSessionId: resume },
					agent: {
						customPath: '/opt/remote grok/bin/grok',
						additionalDirectories:
							grants === 'empty'
								? []
								: [
										...(grants === 'duplicate disabled'
											? [{ path: '/private/root 雪', read: true, write: true }]
											: []),
										{ path: '/private/root 雪', read: false, write: false },
										{ path: '  ', read: true, write: true },
									],
					},
				});
				// Exercise an explicitly empty final launch without changing assembleTurn's empty-message gate.
				if (!text) turn.launch.prompt = '';
				if (host === 'SSH') turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
				const destination =
					host === 'SSH'
						? newRemotePromptFileDestination(remote.id, 'acp-json')
						: { owner: 'local' as const, path: outFile('private-prompt') + '.json' };
				turn.launch.promptFileDestination = destination;
				const sshArgs = ['-p', '2222', 'dev@files.example.test', ...SSH_STDIN_REMOTE_SHELL];
				const wrap = vi.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>(async () => ({
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...sshArgs],
					cwd: scratch.dir,
					sshStdinScript: 'synthetic remote transfer',
					sshRemoteUsed: remote,
				}));
				const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
				const getSshRemotes = vi.fn(() => [remote]);
				const run = await start(turn, {
					sshStore: { getSshRemotes },
					deps: { wrapSpawnWithSsh: wrap, env: { ...process.env, ...env } },
				});
				try {
					await waitUntil(() => fs.existsSync(stdinOut));
					const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
					const spec = vi.mocked(runToCompletion.runTurn).mock.calls[0][0];
					const content = JSON.stringify({
						type: 'acp',
						content: [{ type: 'text', text: turn.launch.prompt }],
					});
					expect(runToCompletion.runTurn).toHaveBeenCalledOnce();
					expect(plan).toHaveBeenCalledOnce();
					expect(getSshRemotes).toHaveBeenCalledTimes(host === 'SSH' ? 1 : 0);
					expect(plan.mock.calls[0][0].additionalDirectories).toEqual(
						turn.launch.additionalDirectories
					);
					expect(turn.launch.args.join(' ')).not.toContain('/private/root');
					if (host === 'local') {
						expect(wrap).not.toHaveBeenCalled();
						expect(spec).toMatchObject({
							command: process.execPath,
							cwd: scratch.dir,
							env: { GROK_HOME: env.GROK_HOME },
						});
						expect(argv).toEqual([...turn.launch.args.slice(1), '--prompt-file', destination.path]);
						expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');
						expect(fs.readFileSync(destination.path, 'utf8')).toBe(content);
					} else {
						expect(wrap).toHaveBeenCalledOnce();
						expect(wrap.mock.calls[0][0]).toMatchObject({
							command: '/opt/remote grok/bin/grok',
							cwd: scratch.dir,
							prompt: undefined,
							customEnvVars: { GROK_HOME: env.GROK_HOME },
							promptArtifact: { ...destination, content },
							args: [...turn.launch.args, '--prompt-file', destination.path],
						});
						expect(wrap.mock.calls[0][1]).toEqual(turn.launch.sshRemoteConfig);
						expect(spec.promptArtifact).toBeUndefined();
						expect(argv).toEqual(sshArgs);
						expect(fs.readFileSync(stdinOut, 'utf8')).toContain('synthetic remote transfer');
					}
					if (resume) expect(turn.launch.args).toContain(resume);
				} finally {
					run.terminate();
					await run.result;
				}
				if (host === 'local') {
					expect(fs.existsSync(destination.path)).toBe(false);
					expect(remoteSignals).toEqual([]);
				} else {
					expect(remoteSignals[0]).toMatchObject({
						mode: 'terminate',
						promptArtifactPath: destination.path,
						pidFile: expect.stringMatching(/^\/tmp\/maestro-prompt-owner-[0-9a-f-]+\.pid$/),
					});
				}
			}
		);
	});

	describe.each(['local', 'resolved SSH'] as const)('%s refusal', (host) => {
		it.each([
			'conflicting source',
			'wrong owner',
			'managed',
			'realized conflict',
			...(host === 'resolved SSH' ? ['remote preparation'] : []),
		])('preserves %s diagnostics and cleans only owned preparation', async (failure) => {
			const privateText = 'PRIVATE prompt "雪"\nnever disclose';
			const owned = outFile('private-owned-system');
			const untouched = outFile('unowned-preparation');
			fs.writeFileSync(untouched, 'keep unowned bytes');
			const destination =
				host === 'resolved SSH'
					? newRemotePromptFileDestination(remote.id, 'acp-json')
					: { owner: 'local' as const, path: outFile('private-prompt') + '.json' };
			const assembled = assembleTurn(
				makeAgent({ toolType: 'grok', cwd: scratch.dir }),
				makeTab(),
				{ text: privateText },
				makeContext('grok')
			);
			if (!assembled.ok) throw new Error(assembled.message);
			const turn = assembled.turn;
			turn.systemPrompt = privateText;
			turn.systemPromptDelivery = { via: 'file' };
			turn.launch.agent = fileAgent;
			turn.launch.promptFileDestination = destination;
			if (host === 'resolved SSH')
				turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
			// A managed route mismatch must win even over a competing prompt source.
			if (failure === 'conflicting source' || failure === 'managed')
				turn.launch.args.push('-p', privateText);
			if (failure === 'wrong owner')
				turn.launch.promptFileDestination = {
					...destination,
					owner: host === 'local' ? 'remote' : 'local',
				};
			if (failure === 'managed')
				turn.launch.managed = {
					route: {
						providerId: 'codex',
						model: null,
						baseUrl: null,
						accountDir: null,
						login: 'provider-login',
						permissionMode: null,
					},
				};
			const write = vi
				.spyOn(turnArgs, 'writeSystemPromptFile')
				.mockImplementation(async (input) => {
					fs.writeFileSync(owned, input.systemPrompt);
					return {
						args: [
							...input.args,
							...(failure === 'realized conflict'
								? ['-p', privateText]
								: ['--append-system-prompt-file', owned]),
						],
						prompt: input.prompt,
						tempFile: owned,
						delivery: 'file',
					};
				});
			const cleanup = vi.spyOn(pipeSpawn, 'removeTempFiles');
			const plan = vi.spyOn(launchPlanner, 'buildAgentLaunchPlan');
			vi.mocked(runToCompletion.runTurn).mockImplementation(() => {
				throw new Error('A refused launch must never start a process');
			});
			const logs = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
				vi.spyOn(logger, level).mockImplementation(() => {})
			);
			const getSshRemotes = vi.fn(() => [remote]);
			const wrap = vi
				.fn<NonNullable<RunAgentTurnDeps['wrapSpawnWithSsh']>>()
				.mockRejectedValue(new Error(`${privateText} ${owned} ${destination.path}`));
			const started = await runAgentTurn(
				turn,
				optionsFor({
					sshStore: { getSshRemotes },
					deps: { wrapSpawnWithSsh: wrap, env: {} },
				})
			);
			const message =
				failure === 'managed'
					? 'The policy routes this launch to codex, not grok.'
					: failure === 'remote preparation'
						? 'Remote prompt preparation unavailable.'
						: failure === 'wrong owner'
							? 'Prompt-file delivery requires a fresh owned .json destination on the executing host and a provider file-argument builder.'
							: 'Prompt-file delivery conflicts with another prompt source in the launch arguments.';
			expect(started).toEqual({
				ok: false,
				reason: failure === 'managed' ? 'managed-denied' : 'prompt-delivery-refused',
				message,
			});
			const materialized = failure === 'remote preparation' || failure === 'realized conflict';
			expect(plan).toHaveBeenCalledTimes(materialized ? 2 : 1);
			expect(getSshRemotes).toHaveBeenCalledTimes(
				host === 'resolved SSH' ? (materialized ? 2 : 1) : 0
			);
			if (materialized) {
				expect(plan.mock.results[0].value.ok).toBe(true);
				expect(plan.mock.calls[1][0].args).toEqual([
					...turn.launch.args,
					...(failure === 'realized conflict'
						? ['-p', privateText]
						: ['--append-system-prompt-file', owned]),
				]);
			}
			if (failure !== 'remote preparation') {
				expect(plan.mock.results.at(-1)!.value).toEqual({
					ok: false,
					reason: failure === 'managed' ? 'managed-route-refused' : 'prompt-delivery-refused',
					error: message,
				});
			} else {
				expect(plan.mock.results[0].value).toMatchObject({
					ok: true,
					plan: { target: { kind: 'remote' } },
				});
				expect(wrap.mock.calls[0][0]).toMatchObject({
					prompt: undefined,
					promptArtifact: destination,
				});
			}
			expect(wrap).toHaveBeenCalledTimes(failure === 'remote preparation' ? 1 : 0);
			expect(runToCompletion.runTurn).not.toHaveBeenCalled();
			if (materialized) {
				expect(write).toHaveBeenCalledOnce();
				expect(cleanup).toHaveBeenCalledExactlyOnceWith([owned]);
				await waitUntil(() => !fs.existsSync(owned));
			} else {
				expect(write).not.toHaveBeenCalled();
				expect(cleanup).not.toHaveBeenCalled();
			}
			expect(fs.existsSync(owned)).toBe(false);
			expect(fs.readFileSync(untouched, 'utf8')).toBe('keep unowned bytes');
			if (host === 'local') expect(fs.existsSync(destination.path)).toBe(false);
			expect(remoteSignals).toEqual([]);
			const disclosure = JSON.stringify({ started, logs: logs.map((log) => log.mock.calls) });
			for (const secret of [
				privateText,
				'never disclose',
				turn.launch.prompt!,
				owned,
				destination.path,
			]) {
				expect(disclosure).not.toContain(secret);
				expect(disclosure).not.toContain(JSON.stringify(secret).slice(1, -1));
			}
		});
	});
});

describe('runAgentTurn: the Claude token source', () => {
	const tuiSource = { enableMaestroP: true, maestroPMode: 'interactive' as const };

	it('runs the maestro-p TUI for an agent set to it, pointing it at the real claude', async () => {
		const argvOut = outFile('argv');
		const envOut = outFile('env');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			env: { FAKE_AGENT_ARGV_OUT: argvOut, FAKE_AGENT_ENV_OUT: envOut },
		});

		// The fake agent stands in for the maestro-p script: it exists, and it is what runs.
		const run = await start(turn, {
			claudeTokenSource: tuiSource,
			maestroPBinPath: FAKE_AGENT_PATH,
		});
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const env = JSON.parse(fs.readFileSync(envOut, 'utf8')) as Record<string, string>;
		expect(argv).toContain('--dangerously-skip-permissions');
		expect(env.MAESTRO_CLAUDE_BIN).toBe(turn.launch.command);
		expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('falls back to API when the TUI is chosen but no maestro-p is installed', async () => {
		const envOut = outFile('env');
		const run = await start(
			assembleWithFakeAgent('claude-code', {
				recording: 'captured-claude-code-normal',
				env: { FAKE_AGENT_ENV_OUT: envOut },
			}),
			{ claudeTokenSource: tuiSource }
		);
		await run.result;

		expect(JSON.parse(fs.readFileSync(envOut, 'utf8')).MAESTRO_CLAUDE_BIN).toBeUndefined();
	});

	it('allows Standard mode on the TUI, which draws its own permission prompts', async () => {
		const run = await start(
			assembleWithFakeAgent('claude-code', {
				recording: 'captured-claude-code-normal',
				tab: { permissionMode: 'standard' },
			}),
			{ claudeTokenSource: tuiSource, maestroPBinPath: FAKE_AGENT_PATH }
		);

		expect((await run.result).outcome).toBe('completed');
	});
});

describe('runAgentTurn: the system prompt file (Windows host)', () => {
	it('writes it, appends the file argument, and removes it when the turn ends', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			hold: true,
			context: { isWindowsHost: true },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});
		expect(turn.systemPromptDelivery).toEqual({ via: 'file' });

		const run = await start(turn, { deps: { tempDir: scratch.dir } });
		for await (const event of run.events) {
			if (event.type === 'result') break;
		}

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		const flag = argv.indexOf('--append-system-prompt-file');
		expect(flag).toBeGreaterThan(-1);
		const file = argv[flag + 1];
		expect(path.dirname(file)).toBe(scratch.dir);
		// The name every spawn uses: a safe slug of the session id, and a suffix that keeps two
		// spawns in the same millisecond apart.
		expect(path.basename(file)).toMatch(
			/^maestro-sysprompt-agent-1-ai-tab-1-\d+-[0-9a-f]{8}\.txt$/
		);
		expect(fs.readFileSync(file, 'utf8')).toBe(turn.systemPrompt);
		if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(argv).not.toContain('--append-system-prompt');

		run.terminate();
		await run.result;
		await waitUntil(() => !fs.existsSync(file));
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe('runAgentTurn: the system prompt file cannot be written', () => {
	it('runs the turn with the prompt inline instead of refusing it', async () => {
		const argvOut = outFile('argv');
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-normal',
			context: { isWindowsHost: true },
			env: { FAKE_AGENT_ARGV_OUT: argvOut },
		});

		const run = await start(turn, { deps: { tempDir: path.join(scratch.dir, 'no-such-dir') } });
		await run.result;

		const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8')) as string[];
		expect(argv).not.toContain('--append-system-prompt-file');
		expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(turn.systemPrompt);
	});
});

describe('runAgentTurn: a resumed Claude session', () => {
	it('records the turn’s own cost, not the session’s running total', async () => {
		clearRememberedClaudeSessionCosts();
		const configDir = path.join(scratch.dir, `claude-config-${++sequence}`);
		// What the session had cost before this turn: the last `cost-state` row claude wrote.
		const transcript = claudeTranscriptPath(
			configDir,
			scratch.dir,
			CAPTURED_CLAUDE_CODE_SESSION_ID
		);
		fs.mkdirSync(path.dirname(transcript), { recursive: true });
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: 'cost-state', totalCostUSD: 0.0840728, modelUsage: {} })}\n`
		);
		const turn = assembleWithFakeAgent('claude-code', {
			recording: 'captured-claude-code-resumed',
			tab: { agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID },
			env: { CLAUDE_CONFIG_DIR: configDir },
		});
		expect(turn.resumeSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

		const result = await (await start(turn)).result;

		// The recording reports the session's total, 0.1948228; this turn spent the rest.
		expect(result.usage?.totalCostUsd).toBeCloseTo(0.1948228 - 0.0840728, 6);
	});
});

describe('runAgentTurn: an SSH turn’s remote agent', () => {
	const remote: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Build box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	/** An SSH turn whose ssh client is the fake agent, holding until stopped. */
	async function startRemote(stdinOut: string) {
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			agent: { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } },
		});
		return start(turn, {
			sshStore: { getSshRemotes: () => [remote] },
			deps: {
				env: {
					...process.env,
					FAKE_AGENT_RECORDING: writeFakeTurn(
						scratch.dir,
						fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
					),
					FAKE_AGENT_STDIN_OUT: stdinOut,
					FAKE_AGENT_HOLD: '1',
				},
				wrapSpawnWithSsh: async () => ({
					command: process.execPath,
					// The stdin-script shape: the connection, then the remote shell that reads the script.
					args: [FAKE_AGENT_PATH, 'dev@build.example.com', ...SSH_STDIN_REMOTE_SHELL],
					cwd: scratch.dir,
					sshStdinScript: 'cd /work && exec opencode',
					sshRemoteUsed: remote,
				}),
			},
		});
	}

	it('records the agent’s pid in the script, and Stop signals it on its host', async () => {
		const stdinOut = outFile('stdin');
		const run = await startRemote(stdinOut);
		await waitUntil(() => fs.existsSync(stdinOut));

		const script = fs.readFileSync(stdinOut, 'utf8');
		const pidFile = /maestro-agent-[0-9a-f-]+\.pid/.exec(script)?.[0];
		expect(pidFile).toBeDefined();
		expect(script.endsWith('\ncd /work && exec opencode')).toBe(true);

		run.interrupt();
		await run.result;

		expect(remoteSignals[0]).toEqual({ pidFile: `/tmp/${pidFile}`, mode: 'interrupt' });
	});

	it('terminates the remote agent with the turn, and signals nothing once it has ended', async () => {
		const stdinOut = outFile('stdin');
		const run = await startRemote(stdinOut);
		await waitUntil(() => fs.existsSync(stdinOut));

		run.terminate();
		await run.result;
		expect(remoteSignals.map((signal) => signal.mode)).toEqual(['terminate']);

		run.terminate();
		expect(remoteSignals).toHaveLength(1);
	});
});

describe('runAgentTurn: a process whose stdio outlives it', () => {
	it.skipIf(process.platform === 'win32')(
		'settles once the grace after its exit has passed, though a grandchild holds the pipes',
		async () => {
			const pidOut = outFile('pid');
			const turn = assembleWithFakeAgent('opencode', { recording: 'captured-opencode-normal' });
			// The process exits at once and leaves a grandchild holding stdout and stderr open, as
			// an SSH ControlMaster does: `close` would not come for 30 seconds.
			const run = await start({
				...turn,
				launch: {
					...turn.launch,
					command: '/bin/sh',
					args: ['-c', 'sleep 30 & echo $! > "$0"; exit 0', pidOut],
				},
			});
			try {
				const result = await run.result;
				expect(result.exit.exitCode).toBe(0);
			} finally {
				const pid = Number(fs.readFileSync(pidOut, 'utf8'));
				if (pid > 0) process.kill(pid, 'SIGKILL');
			}
		},
		15_000
	);
});

describe('runAgentTurn: a refused effort', () => {
	beforeEach(() => {
		resetEffortRejections();
	});

	it('notes the refusal for the process, so the value stops being offered', async () => {
		const refusal = JSON.stringify({
			type: 'error',
			status: 400,
			error: {
				message:
					"Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model. " +
					"Supported values are: 'low', 'medium', 'high'.",
				param: 'reasoning.effort',
			},
		});
		const turn = assembleWithFakeAgent('opencode', {
			recording: 'captured-opencode-normal',
			env: {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, {
					chunks: [],
					stderr: `${refusal}\n`,
					close: { code: 1, signal: null },
				}),
			},
		});

		const result = await (await start(turn)).result;

		expect(result.outcome).toBe('crashed');
		expect(getEffortRejection('opencode', 'minimal')).toMatchObject({
			value: 'minimal',
			supported: ['low', 'medium', 'high'],
		});
	});
});

/** Poll until `done`, for a removal that happens after the turn settles. */
async function waitUntil(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!done() && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
