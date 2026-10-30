/**
 * The runtime's background turns: how a group chat turn and a consult are started, reported, and
 * stopped, over the real run layer. A missing binary and an unknown provider are the real thing
 * (nothing is faked for them); the rest replay a recorded stream through the fake agent.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stop's remote half is observed here, never sent: a real one runs ssh.
const remoteSignals = vi.hoisted(() => [] as Array<{ pidFile: string; mode: string }>);
vi.mock('../../control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../control/ssh-remote-signal')>()),
	signalRemoteAgent: (target: { pidFile: string }, mode: string) => {
		remoteSignals.push({ pidFile: target.pidFile, mode });
		return true;
	},
}));

import {
	createFakeGroupChatProvider,
	promptOf,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	claudeTranscriptPath,
	clearRememberedClaudeSessionCosts,
} from '../../../claudeCostTracker';
import { embedSystemPromptInPrompt } from '../../../embeddedSystemPrompt';
import * as systemDelivery from '../../turns/args';
import * as remoteControl from '../../control/ssh-remote-signal';
import { getAgentCapabilities } from '../../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../../providers/definitions';
import { resolveMaestroPaths } from '../../paths/resolve';
import { groupChatTurnContext } from '../../groupchat/spawn';
import * as groupChatPreparation from '../../groupchat/spawn';
import type { GroupChatSpawn } from '../../groupchat/types';
import { createLocalHostAuthority, type AdmissionRequest } from '../../managed/authority';
import type { ManagedBindingState } from '../../managed/binding';
import {
	MANAGED_DELEGATION_ENV_VAR,
	delegationContextEnv,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../managed/delegation';
import { createHeadlessSpawnAuthority } from '../../managed/host-adapter';
import {
	consultOwner,
	createBackgroundTurns,
	groupChatOwner,
	type BackgroundAdmissionEvent,
	type BackgroundSpawnAuthorityPort,
	type GroupChatRunnerHandlers,
} from '../background-turns';
import { createProcessRegistry, type ProcessRegistry } from '../processes';

const CHAT_ID = '11111111-2222-4333-8444-555555555555';
const MODERATOR = `group-chat-${CHAT_ID}-moderator-1700000000000`;
const PARTICIPANT = `group-chat-${CHAT_ID}-participant-Alpha-1700000000000`;

const claude = (path = '/fake/bin/claude'): AgentConfig =>
	({
		...getAgentDefinition('claude-code')!,
		available: true,
		path,
		capabilities: getAgentCapabilities('claude-code'),
	}) as AgentConfig;

// Candidate file delivery is opted in only by this fixture, never by the provider registry.
const grok: AgentConfig = {
	...getAgentDefinition('grok')!,
	available: true,
	path: path.resolve('synthetic-grok'),
	capabilities: getAgentCapabilities('grok'),
	promptFile: { format: 'acp-json', exclusivePromptFlags: ['-p', '--prompt-file'] },
	promptFileArgs: (file) => ['--prompt-file', file],
};

const spawnOf = (overrides: Partial<GroupChatSpawn> = {}): GroupChatSpawn => ({
	processId: PARTICIPANT,
	providerId: 'claude-code',
	agent: claude(),
	args: ['--print', '--verbose', '--output-format', 'stream-json'],
	cwd: os.tmpdir(),
	prompt: 'hello',
	...overrides,
});

describe('background turns', () => {
	let dir: string;
	let registry: ProcessRegistry;
	let beginTurn: ReturnType<typeof vi.fn<(processId: string) => void>>;
	let reported: string[];
	let handlers: GroupChatRunnerHandlers;

	const paths = () => resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } });

	function turns(script?: FakeScript) {
		const provider = script ? createFakeGroupChatProvider(dir, script) : undefined;
		const background = createBackgroundTurns({
			paths: paths(),
			registry,
			host: {},
			beginTurn,
			...(provider ? { deps: { runTurn: provider.runTurn } } : {}),
		});
		return { background, provider };
	}

	beforeEach(() => {
		remoteSignals.length = 0;
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-background-turns-'));
		registry = createProcessRegistry({ waitMs: 2_000 });
		beginTurn = vi.fn<(processId: string) => void>();
		reported = [];
		handlers = {
			chatIdOf: () => CHAT_ID,
			onActivity: () => undefined,
			onOutput: () => undefined,
			onSessionId: async (_id, sessionId) => void reported.push(`session:${sessionId}`),
			onUsage: (_id, usage) => void reported.push(`usage:${usage.contextWindow}`),
			onEnd: async (_id, completed) =>
				void reported.push(`end:${completed.answerText}:${completed.exit.exitCode}`),
		};
	});
	afterEach(async () => {
		await registry.stopAll();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('a group chat turn', () => {
		it('reports the session id, then usage, then the end, in that order', async () => {
			const { background } = turns(() => ({ text: 'Done.', sessionId: 'sess-1' }));
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf());

			expect(started).toMatchObject({ success: true });
			expect(started.pid).toBeGreaterThan(0);
			await vi.waitFor(() => expect(reported).toHaveLength(3));
			// Usage carries the agent's configured window when the provider reported none.
			expect(reported).toEqual(['session:sess-1', 'usage:200000', 'end:Done.:0']);
			expect(beginTurn).toHaveBeenCalledExactlyOnceWith(PARTICIPANT);
		});

		it('owns the process under the chat, so no agent reads busy for it and shutdown reaches it', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			await runner.start(spawnOf());

			expect(background.activeCount()).toBe(1);
			expect(registry.size()).toBe(1);
			expect(registry.isBusy(groupChatOwner(CHAT_ID), PARTICIPANT)).toBe(true);
			expect(registry.isBusy('any-agent')).toBe(false);

			await registry.stopAll();
			expect(background.activeCount()).toBe(0);
			// A stopped turn is still reported: the engine decides what a stop means.
			await vi.waitFor(() => expect(reported.some((entry) => entry.startsWith('end:'))).toBe(true));
		});

		it('stops a turn by its full id, and ignores one it does not know', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			await runner.start(spawnOf({ processId: MODERATOR }));

			runner.stop('group-chat-unknown');
			expect(background.activeCount()).toBe(1);
			runner.stop(MODERATOR);

			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(registry.size()).toBe(0);
		});

		// Windows starts agents through a shell (`getWindowsSpawnConfig`), which exists and gets a pid:
		// there a missing binary is the shell's non-zero exit, reported as an ordinary end.
		it.skipIf(process.platform === 'win32')(
			'answers a refusal, with no end to follow, when the binary does not exist',
			async () => {
				const { background } = turns();
				const runner = background.groupChatRunner(handlers);

				const started = await runner.start(
					spawnOf({ agent: claude('/nonexistent/dir/claude'), command: '/nonexistent/dir/claude' })
				);

				expect(started.success).toBe(false);
				expect(started.error).toMatch(/ENOENT|spawn/i);
				expect(background.activeCount()).toBe(0);
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(reported).toEqual([]);
			}
		);

		it('answers a refusal for a provider with no output parser', async () => {
			const { background } = turns();
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf({ providerId: 'no-such-provider' }));

			expect(started).toMatchObject({
				success: false,
				error: expect.stringMatching(/no-such-provider/),
			});
		});

		it('lets a launch that cannot be prepared throw, so the engine words it for the room', async () => {
			const { background } = turns();
			const runner = background.groupChatRunner(handlers);

			await expect(
				runner.start(spawnOf({ sshRemoteConfig: { enabled: true, remoteId: 'gone' } }))
			).rejects.toThrow(/SSH/);
			expect(beginTurn).not.toHaveBeenCalled();
		});

		it('keeps one turn’s failure to report from taking the runner down', async () => {
			const { background } = turns(() => ({ text: 'x' }));
			const runner = background.groupChatRunner({
				...handlers,
				onEnd: async () => {
					throw new Error('the engine fell over');
				},
			});
			await runner.start(spawnOf());
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(registry.size()).toBe(0);
		});
	});

	describe('the system prompt a turn carries', () => {
		it('rides the native flag for an agent that has one', async () => {
			const { background, provider } = turns(() => ({ text: 'ok' }));
			await background.groupChatRunner(handlers).start(spawnOf({ appendSystemPrompt: 'BE BRIEF' }));

			const args = provider!.calls[0].spec.args;
			if (process.platform === 'win32') {
				// A Windows host cannot hold a large prompt on its command line: it goes to a temp file.
				expect(args).toContain('--append-system-prompt-file');
				expect(args).not.toContain('BE BRIEF');
			} else {
				expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('BE BRIEF');
			}
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
		});

		it('is embedded in the prompt for an agent without the flag, and not again on a resume', async () => {
			const codex: AgentConfig = {
				...getAgentDefinition('codex')!,
				available: true,
				path: '/fake/bin/codex',
				capabilities: getAgentCapabilities('codex'),
			} as AgentConfig;
			const codexSpawn = (overrides: Partial<GroupChatSpawn>) =>
				spawnOf({
					providerId: 'codex',
					agent: codex,
					args: ['exec', '--json'],
					appendSystemPrompt: 'BE BRIEF',
					...overrides,
				});
			const { background, provider } = turns(() => ({ text: 'ok' }));
			const runner = background.groupChatRunner(handlers);

			await runner.start(codexSpawn({}));
			await runner.start(codexSpawn({ processId: MODERATOR, isResume: true }));

			const [first, resumed] = provider!.calls.map((call) => promptOf(call.spec));
			expect(first).toContain(embedSystemPromptInPrompt('BE BRIEF', 'hello'));
			expect(resumed).not.toContain('BE BRIEF');
			expect(resumed).toContain('hello');
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
		});
	});

	describe('candidate Grok file delivery', () => {
		afterEach(() => vi.restoreAllMocks());

		it.each(['group', 'consult'] as const)(
			'captures %s capabilities and nested file ownership before system delivery yields',
			async (kind) => {
				const selectedCapabilities = { ...getAgentCapabilities('grok') };
				const selectedPromptFile = {
					...grok.promptFile!,
					exclusivePromptFlags: [...grok.promptFile!.exclusivePromptFlags],
				};
				const callerPromptFlags = [...selectedPromptFile.exclusivePromptFlags];
				const agent: AgentConfig = {
					...grok,
					capabilities: { ...selectedCapabilities },
					promptFile: {
						...selectedPromptFile,
						exclusivePromptFlags: callerPromptFlags,
					},
				};
				let finish!: (result: systemDelivery.SystemPromptDeliveryResult) => void;
				const delivery = vi.spyOn(systemDelivery, 'deliverSystemPrompt').mockReturnValueOnce(
					new Promise((resolve) => {
						finish = resolve;
					})
				);
				const prepare = vi.spyOn(groupChatPreparation, 'prepareGroupChatSpawn');
				const { background, provider } = turns(() => ({ text: '' }));
				const spawn = spawnOf({ providerId: 'grok', agent, prompt: 'private captured input' });
				const started =
					kind === 'group'
						? background.groupChatRunner(handlers).start(spawn)
						: background.consultRunner().start(spawn, {
								onActivity: vi.fn(),
								onSessionId: vi.fn(),
								onEnd: vi.fn(),
							});
				expect(delivery).toHaveBeenCalledOnce();
				expect(prepare).not.toHaveBeenCalled();
				agent.capabilities.supportsAppendSystemPrompt =
					!selectedCapabilities.supportsAppendSystemPrompt;
				agent.capabilities.supportsReadOnlyMode = !selectedCapabilities.supportsReadOnlyMode;
				callerPromptFlags.push('--print');
				finish({ args: spawn.args, prompt: spawn.prompt });

				expect(await started).toMatchObject({ success: true });
				expect(prepare).toHaveBeenCalledOnce();
				const captured = prepare.mock.calls[0][0].agent;
				expect(captured.capabilities).toEqual(selectedCapabilities);
				expect(captured.capabilities).not.toBe(agent.capabilities);
				expect(captured.promptFile).toEqual(selectedPromptFile);
				expect(captured.promptFile!.exclusivePromptFlags).not.toBe(
					agent.promptFile!.exclusivePromptFlags
				);
				expect(getAgentCapabilities('grok')).toEqual(selectedCapabilities);
				expect(grok.promptFile).toEqual(selectedPromptFile);
				const spec = provider!.calls[0].spec;
				expect(spec.promptArtifact).toMatchObject({ owner: 'local', mode: 0o600, cleanup: 'turn' });
				expect(JSON.parse(spec.promptArtifact!.content)).toEqual({
					type: 'acp',
					content: [{ type: 'text', text: spawn.prompt }],
				});
				expect(spec.args.join(' ')).not.toContain(spawn.prompt);
				expect(spec.stdin).toBeUndefined();
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			}
		);

		it.each([
			['empty', '', undefined, false],
			['composed', 'private 雪\n'.repeat(5_000), 'SYSTEM', false],
			['resumed', 'next turn', 'SYSTEM', true],
		] as const)(
			'hands %s content to the local file owner without argv or stdin fallback',
			async (_label, prompt, system, resume) => {
				const { background, provider } = turns(() => ({ text: '' }));
				const spawn = spawnOf({
					providerId: 'grok',
					agent: grok,
					prompt,
					appendSystemPrompt: system,
					args: ['--model', 'selected-model', ...(resume ? ['--resume', 'session-1'] : [])],
					customEnvVars: { GROK_HOME: path.join(dir, 'selected-account') },
				});
				const started = background.groupChatRunner(handlers).start(spawn);
				spawn.args[1] = 'changed-model';
				spawn.customEnvVars!.GROK_HOME = path.join(dir, 'changed-account');
				expect(await started).toMatchObject({ success: true });
				const spec = provider!.calls[0].spec;
				const text = system && !resume ? embedSystemPromptInPrompt(system, prompt) : prompt;
				expect(JSON.parse(spec.promptArtifact!.content)).toEqual({
					type: 'acp',
					content: [{ type: 'text', text }],
				});
				expect(spec.promptArtifact).toMatchObject({
					owner: 'local',
					mode: 0o600,
					flag: 'wx',
					cleanup: 'turn',
				});
				expect(spec.args.join(' ')).toContain('selected-model');
				expect(spec.args.join(' ')).toContain(spec.promptArtifact!.path);
				expect(spec.env.GROK_HOME).toBe(path.join(dir, 'selected-account'));
				expect(spec.stdin).toBeUndefined();
				if (prompt) expect(spec.args.join(' ')).not.toContain(prompt);
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			}
		);

		it.each([
			{ args: ['-p', 'conflicting-private-input'] },
			{ isResume: true, args: [] },
			{ sshRemoteConfig: { enabled: true, remoteId: 'missing-private-host' } },
		])(
			'refuses invalid private preparation without a retry or diagnostic disclosure: %j',
			async (override) => {
				const { background, provider } = turns(() => ({ text: 'never' }));
				await expect(
					background.groupChatRunner(handlers).start(
						spawnOf({
							providerId: 'grok',
							agent: grok,
							prompt: 'private prompt',
							...override,
						})
					)
				).rejects.toEqual(new Error('Prompt-file background preparation unavailable.'));
				expect(provider!.calls).toEqual([]);
				expect(beginTurn).not.toHaveBeenCalled();
				expect(reported).toEqual([]);
			}
		);

		it.each(['group', 'consult'] as const)(
			'cleans abandoned system preparation when a %s is stopped',
			async (kind) => {
				const file = path.join(dir, 'private-system.txt');
				fs.writeFileSync(file, 'private system');
				let finish!: (result: systemDelivery.SystemPromptDeliveryResult) => void;
				vi.spyOn(systemDelivery, 'deliverSystemPrompt').mockReturnValueOnce(
					new Promise((resolve) => {
						finish = resolve;
					})
				);
				const { background, provider } = turns(() => ({ text: 'never' }));
				const group = background.groupChatRunner(handlers);
				const consult = background.consultRunner();
				const spawn = spawnOf({ providerId: 'grok', agent: grok });
				const started =
					kind === 'group'
						? group.start(spawn)
						: consult.start(spawn, {
								onActivity: vi.fn(),
								onSessionId: vi.fn(),
								onEnd: vi.fn(),
							});
				(kind === 'group' ? group : consult).stop(spawn.processId);
				finish({ args: spawn.args, prompt: spawn.prompt, tempFile: file });
				expect(await started).toEqual({
					success: false,
					error: 'Background turn cancelled before spawn.',
				});
				await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 2_000 });
				expect(provider!.calls).toEqual([]);
				expect(beginTurn).not.toHaveBeenCalled();
			}
		);
	});

	describe('a resumed Claude session', () => {
		it('records the turn’s own cost, not the session’s running total', async () => {
			const configDir = path.join(dir, 'claude-config');
			const transcript = claudeTranscriptPath(configDir, os.tmpdir(), 'sess-r');
			fs.mkdirSync(path.dirname(transcript), { recursive: true });
			fs.writeFileSync(
				transcript,
				`${JSON.stringify({ type: 'cost-state', totalCostUSD: 0.004, modelUsage: {} })}\n`
			);
			const { background } = turns(() => ({ text: 'Done.', sessionId: 'sess-r' }));
			// The fake provider is built first: it forgets every total remembered so far.
			clearRememberedClaudeSessionCosts();
			const costs: number[] = [];
			await background
				.groupChatRunner({
					...handlers,
					onUsage: (_id, usage) => void costs.push(usage.totalCostUsd),
				})
				.start(
					spawnOf({
						args: ['--print', '--output-format', 'stream-json', '--resume', 'sess-r'],
						customEnvVars: { CLAUDE_CONFIG_DIR: configDir },
					})
				);

			// The stream reports the session's total, 0.01; this turn spent the rest.
			await vi.waitFor(() => expect(costs).toHaveLength(1));
			expect(costs[0]).toBeCloseTo(0.006, 6);
		});
	});

	describe('a turn on an SSH remote', () => {
		beforeEach(() => {
			const settings = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }).settingsFile;
			fs.mkdirSync(path.dirname(settings), { recursive: true });
			fs.writeFileSync(
				settings,
				JSON.stringify({
					sshRemotes: [
						{
							id: 'r1',
							name: 'Build box',
							host: 'build.example.com',
							port: 22,
							username: 'dev',
							privateKeyPath: '',
							enabled: true,
						},
					],
				})
			);
		});

		it('pins Grok private content and account to the selected SSH host through preparation and Stop', async () => {
			const signal = vi.spyOn(remoteControl, 'signalRemoteAgent');
			const { background, provider } = turns(() => ({ text: '', hold: true }));
			const runner = background.groupChatRunner(handlers);
			const spawn = spawnOf({
				providerId: 'grok',
				agent: grok,
				args: ['--model', 'selected-model'],
				prompt: 'private remote 雪',
				customEnvVars: { GROK_HOME: '/remote/account' },
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});
			const started = runner.start(spawn);
			const settings = paths().settingsFile;
			const changed = JSON.parse(fs.readFileSync(settings, 'utf8'));
			changed.sshRemotes[0].host = 'changed.example.com';
			fs.writeFileSync(settings, JSON.stringify(changed));
			spawn.sshRemoteConfig!.remoteId = 'other';
			expect(await started).toMatchObject({ success: true });
			const spec = provider!.calls[0].spec;
			expect(spec.promptArtifact).toBeUndefined();
			expect(spec.args.join(' ')).toContain('build.example.com');
			expect(spec.args.join(' ')).not.toContain('changed.example.com');
			expect(spec.args.join(' ')).not.toContain('private remote');
			expect(spec.stdin).toContain('/remote/account');
			expect(spec.stdin).toContain('selected-model');
			expect(spec.stdin).toContain(
				Buffer.from(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text: 'private remote 雪' }] })
				).toString('base64')
			);
			const pidFile = /\/tmp\/maestro-prompt-owner-[0-9a-f-]+\.pid/.exec(spec.stdin!)?.[0];
			expect(pidFile).toBeDefined();
			runner.stop(PARTICIPANT);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(signal).toHaveBeenCalledWith(
				expect.objectContaining({
					pidFile,
					sshArgs: spec.args,
					promptArtifactPath: expect.stringMatching(/^\/tmp\/maestro-prompt-.*\.json$/),
				}),
				'terminate'
			);
			signal.mockRestore();
		});

		it('records the agent’s pid in its script, and Stop reaches it on its host', async () => {
			const { background, provider } = turns(() => ({ text: 'working', hold: true }));
			const runner = background.groupChatRunner(handlers);
			// A large prompt rides a stdin script, the launch that records the agent's pid.
			await runner.start(
				spawnOf({ sshRemoteConfig: { enabled: true, remoteId: 'r1' }, prompt: 'x'.repeat(5000) })
			);

			const script = provider!.calls[0].spec.stdin ?? '';
			const pidFile = /\/tmp\/maestro-agent-[0-9a-f-]+\.pid/.exec(script)?.[0];
			expect(pidFile).toBeDefined();

			runner.stop(PARTICIPANT);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			expect(remoteSignals).toEqual([{ pidFile, mode: 'terminate' }]);
		});
	});

	describe('a consult', () => {
		const consultSpawn = (id = 'cross-agent-r1') => spawnOf({ processId: id });

		it('hands the observer the session id and the end, with the text read lazily', async () => {
			const { background } = turns(() => ({ text: 'The answer.', sessionId: 'sess-9' }));
			const seen: string[] = [];
			const ended = new Promise<{ exitCode: number | null; text: string }>((resolve) => {
				background.consultRunner().start(consultSpawn(), {
					onActivity: () => undefined,
					onSessionId: (id) => void seen.push(id),
					onEnd: ({ exitCode, readText }) => resolve({ exitCode, text: readText() }),
				});
			});

			expect(await ended).toEqual({ exitCode: 0, text: 'The answer.' });
			expect(seen).toEqual(['sess-9']);
		});

		it('registers under a consult owner, apart from any chat', async () => {
			const { background } = turns(() => ({ text: 'working', hold: true }));
			await background.consultRunner().start(consultSpawn(), {
				onActivity: () => undefined,
				onSessionId: () => undefined,
				onEnd: () => undefined,
			});
			expect(registry.isBusy(consultOwner('cross-agent-r1'), 'cross-agent-r1')).toBe(true);
		});

		it('stops with the partial answer, and reports nothing after it', async () => {
			const provider = createFakeGroupChatProvider(dir, () => ({
				text: 'Half an answer.',
				hold: true,
			}));
			const runTurn = vi.spyOn(provider, 'runTurn');
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: { runTurn },
			});
			const runner = background.consultRunner();
			const events: string[] = [];
			await runner.start(consultSpawn(), {
				onActivity: () => void events.push('activity'),
				onSessionId: () => void events.push('session'),
				onEnd: () => void events.push('end'),
			});
			// Wait until the answer has streamed in.
			await vi.waitFor(() =>
				expect(runTurn.mock.results[0]?.value.answerSoFar()).toBe('Half an answer.')
			);
			expect(runner.stop('cross-agent-other')).toBe('');

			const partial = runner.stop('cross-agent-r1');
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));

			expect(partial).toBe('Half an answer.');
			expect(events).not.toContain('end');
			expect(events).not.toContain('session');
		});

		it('is idempotent, and safe for a process that does not exist yet', () => {
			const { background } = turns();
			const runner = background.consultRunner();
			expect(runner.stop('cross-agent-never')).toBe('');
			expect(runner.stop('cross-agent-never')).toBe('');
		});
	});

	describe('resolving a provider', () => {
		it('answers the definition with where it is, or that it is not installed here', async () => {
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: {
					probeBinary: async (binaryName) =>
						binaryName === 'claude' ? { exists: true, path: '/probed/claude' } : { exists: false },
				},
			});

			expect(await background.resolveAgent('claude-code')).toMatchObject({
				id: 'claude-code',
				available: true,
				path: '/probed/claude',
			});
			expect(await background.resolveAgent('codex')).toMatchObject({
				id: 'codex',
				available: false,
			});
			expect(await background.resolveAgent('no-such-provider')).toBeNull();
		});
	});

	describe('managed admission (MRC-07-05)', () => {
		const installation = { installationId: 'inst-1', runtimeId: 'host-1', processEpoch: 'abc123' };
		const actor = { kind: 'human', id: 'operator:inst-1' } as const;
		let asked: AdmissionRequest[];
		let admissions: BackgroundAdmissionEvent[];
		let leases: number;

		/** The fleet authority an enrolled host answers admissions with, deciding as `decide` says. */
		const authorityOf = (decide: (request: AdmissionRequest) => 'allow' | 'deny') =>
			createLocalHostAuthority({
				authorityId: 'fleet',
				decide: (request) => {
					asked.push(request);
					return decide(request) === 'allow'
						? { decision: 'allow', policyRevision: 3 }
						: { decision: 'deny', reason: 'the policy says no', policyRevision: 3 };
				},
				now: () => Date.now(),
				newId: () => `lease-${++leases}`,
				leaseTtlMs: 60_000,
			});

		/** The headless spawn port of a host enrolled with `authority`, or of a standalone one. */
		const portOf = (
			authority: ReturnType<typeof authorityOf> | null
		): BackgroundSpawnAuthorityPort => {
			const binding: ManagedBindingState = authority
				? {
						state: 'enrolled',
						file: '/data/maestro-managed-binding.json',
						record: {
							authorityId: 'fleet',
							policySources: [],
							policyRevision: 3,
						} as unknown as Extract<ManagedBindingState, { state: 'enrolled' }>['record'],
					}
				: { state: 'standalone', files: [] };
			return createHeadlessSpawnAuthority({
				installation,
				binding,
				host: authority ? { authority, policy: () => ({ sources: [], policyRevision: 3 }) } : null,
				origin: 'headless',
				actor,
			});
		};

		function managedTurns(
			script: FakeScript,
			authority: ReturnType<typeof authorityOf> | null,
			account: string | null = null
		) {
			const provider = createFakeGroupChatProvider(dir, script);
			const port = portOf(authority);
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: { runTurn: provider.runTurn },
				managed: {
					port: () => port,
					account,
					onAdmission: (event) => admissions.push(event),
				},
			});
			return { background, provider };
		}

		/** The record a process was handed, as the agent inside it would read it. */
		const stampedOn = (env: Record<string, string | undefined>): ManagedDelegationContext => {
			const read = readDelegationContextEnv(env);
			if (read.status !== 'ok') throw new Error(`no record on the process: ${read.status}`);
			return read.context;
		};

		/** A record from an operation admitted elsewhere under policy revision 7. */
		const carried = (policyRevision: number | null): ManagedDelegationContext => ({
			contractVersion: 'maestro-managed/1',
			identity: {
				requestId: 'ask-1',
				idempotencyKey: 'ask-1',
				attemptId: 'ask-1',
				runId: 'ask-1',
				rootRunId: 'turn-0',
				parentRunId: 'turn-0',
			},
			traceId: 'delegated:turn-0:ask-1:ask-1',
			workflow: null,
			delegation: {
				chain: [
					{ kind: 'agent', id: 'asker' },
					{ kind: 'agent', id: 'target' },
				],
				grantRef: null,
			},
			policyRevision,
		});

		beforeEach(() => {
			asked = [];
			admissions = [];
			leases = 0;
		});

		it.each(['deny', 'cancel'] as const)(
			'does not run or retry a private Grok turn after %s admission',
			async (decision) => {
				const authority = authorityOf(() => {
					if (decision === 'cancel') runner.stop(PARTICIPANT);
					return decision === 'deny' ? 'deny' : 'allow';
				});
				const { background, provider } = managedTurns(
					() => ({ text: 'never' }),
					authority,
					'account-selected'
				);
				const runner = background.groupChatRunner(handlers);
				const spawn = spawnOf({
					providerId: 'grok',
					agent: grok,
					prompt: 'private admission content',
					args: ['--model', 'selected-model'],
					agentConfigValues: { model: 'selected-model' },
				});
				const result = await runner.start(spawn);
				expect(result.success).toBe(false);
				if (decision === 'deny')
					expect(result.managed).toEqual({ state: 'denied', code: 'policy-denied' });
				else expect(result.error).toBe('Background turn cancelled before spawn.');
				expect(asked).toHaveLength(1);
				expect(asked[0].snapshot).toMatchObject({
					provider: 'grok',
					account: 'account-selected',
					model: 'selected-model',
					target: { kind: 'local' },
				});
				expect(JSON.stringify(asked)).not.toContain('private admission content');
				expect(provider.calls).toEqual([]);
				expect(authority.live()).toEqual([]);
			}
		);

		it('admits a room turn as the room’s child on a lease over the final spec, stamps the record, and releases the lease when the turn ends', async () => {
			const authority = authorityOf(() => 'allow');
			const { background, provider } = managedTurns(
				() => ({ text: 'Done.', sessionId: 'sess-1' }),
				authority,
				'acct-1'
			);
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf());

			expect(started).toMatchObject({ success: true });
			const turn = groupChatTurnContext({ processId: PARTICIPANT })!;
			expect(asked).toHaveLength(1);
			expect(asked[0].context).toMatchObject({
				installation,
				origin: 'headless',
				actor,
				policyRevision: 3,
				workflow: null,
				identity: turn.identity,
				traceId: turn.traceId,
				delegation: {
					chain: [
						{ kind: 'service', id: `group-chat:${CHAT_ID}` },
						{ kind: 'agent', id: PARTICIPANT },
					],
					grantRef: null,
				},
			});
			expect(asked[0].snapshot).toMatchObject({
				provider: 'claude-code',
				account: 'acct-1',
				operation: 'start',
				target: { kind: 'local' },
				resourceIds: [`dir:${os.tmpdir()}`],
			});
			// The process carries the record the admission bound.
			expect(stampedOn(provider.calls[0].spec.env)).toEqual(turn);
			expect(admissions).toEqual([
				{ kind: 'admitted', processId: PARTICIPANT, delegation: turn, leaseId: 'lease-1' },
			]);
			// The lease lives with the process and is released with its exit.
			await vi.waitFor(() => expect(reported).toHaveLength(3));
			await vi.waitFor(() => expect(authority.live()).toEqual([]));
		});

		it('refuses a denied turn before anything runs: no process, no end, the decision on the result', async () => {
			const { background, provider } = managedTurns(
				() => ({ text: 'never' }),
				authorityOf(() => 'deny')
			);
			const runner = background.groupChatRunner(handlers);

			const started = await runner.start(spawnOf({ processId: MODERATOR }));

			expect(started).toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-denied\] /),
				managed: { state: 'denied', code: 'policy-denied' },
			});
			expect(asked).toHaveLength(1);
			expect(provider.calls).toEqual([]);
			expect(background.activeCount()).toBe(0);
			expect(admissions).toEqual([
				expect.objectContaining({
					kind: 'refused',
					processId: MODERATOR,
					state: 'denied',
					code: 'policy-denied',
					delegation: groupChatTurnContext({ processId: MODERATOR }),
				}),
			]);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(reported).toEqual([]);
		});

		it('binds a consult under the record it carries, as it is, and never as a fresh turn of the target', async () => {
			const { background, provider } = managedTurns(
				() => ({ text: 'The answer.' }),
				authorityOf(() => 'allow')
			);
			const record = carried(null);
			const ended = new Promise<void>((resolve) => {
				void background
					.consultRunner()
					.start(spawnOf({ processId: 'cross-agent-r1', delegation: record }), {
						onActivity: () => undefined,
						onSessionId: () => undefined,
						onEnd: () => resolve(),
					});
			});
			await ended;

			expect(asked).toHaveLength(1);
			expect(asked[0].context).toMatchObject({
				identity: record.identity,
				traceId: record.traceId,
				delegation: record.delegation,
				// The host's generation decides, not the initiator's claim.
				policyRevision: 3,
			});
			expect(stampedOn(provider.calls[0].spec.env)).toEqual(record);
		});

		it('refuses a consult that carries no record on a managed host: nothing to bind, nothing run unmanaged', async () => {
			const { background, provider } = managedTurns(
				() => ({ text: 'never' }),
				authorityOf(() => 'allow')
			);

			const started = await background
				.consultRunner()
				.start(spawnOf({ processId: 'cross-agent-r1' }), {
					onActivity: () => undefined,
					onSessionId: () => undefined,
					onEnd: () => undefined,
				});

			expect(started).toMatchObject({
				success: false,
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			});
			expect(asked).toEqual([]);
			expect(provider.calls).toEqual([]);
			expect(admissions).toEqual([
				expect.objectContaining({ kind: 'refused', delegation: null, state: 'unavailable' }),
			]);
		});

		it('refuses a managed initiator’s child on a standalone host, and runs an unmanaged one as before', async () => {
			const { background, provider } = managedTurns(() => ({ text: 'ok' }), null);
			const observer = {
				onActivity: () => undefined,
				onSessionId: () => undefined,
				onEnd: () => undefined,
			};

			const refused = await background
				.consultRunner()
				.start(spawnOf({ processId: 'cross-agent-r1', delegation: carried(7) }), observer);
			expect(refused).toMatchObject({
				success: false,
				error: expect.stringMatching(/^\[managed-unavailable\] /),
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			});
			expect(provider.calls).toEqual([]);

			const ran = await background
				.consultRunner()
				.start(spawnOf({ processId: 'cross-agent-r2', delegation: carried(null) }), observer);
			expect(ran.success).toBe(true);
			// Standalone: no admission, but the record still rides the process for what it dispatches.
			expect(asked).toEqual([]);
			expect(Object.keys(provider.calls[0].spec.env)).toContain(MANAGED_DELEGATION_ENV_VAR);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
		});

		it('stops a running turn when its lease is revoked, and reports the end', async () => {
			const authority = authorityOf(() => 'allow');
			const { background } = managedTurns(() => ({ text: 'working', hold: true }), authority);
			const runner = background.groupChatRunner(handlers);
			const started = await runner.start(spawnOf());
			expect(started.success).toBe(true);
			expect(background.activeCount()).toBe(1);

			expect(authority.revoke('lease-1', 'the policy changed')).toBe(true);

			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			await vi.waitFor(() => expect(reported.some((entry) => entry.startsWith('end:'))).toBe(true));
			expect(authority.live()).toEqual([]);
		});

		/**
		 * Zero effect (MRC-07-07): a consult's owner revoked mid-answer, a policy that changed
		 * between two turns of one room, a record carrying a fabricated fence, and a read-only
		 * consult trying to widen itself through its own environment. Nothing runs that should
		 * not, and what runs carries exactly what was bound.
		 */
		describe('zero effect: a revoked owner, a revoked policy, a fabricated fence, an escalating consult', () => {
			const observer = (onEnd: (exitCode: number | null) => void) => ({
				onActivity: () => undefined,
				onSessionId: () => undefined,
				onEnd: ({ exitCode }: { exitCode: number | null }) => onEnd(exitCode),
			});

			it('stops a running consult when its lease is revoked: the authority owns that stop, the observer hears the end, and no lease stays live', async () => {
				const authority = authorityOf(() => 'allow');
				const { background } = managedTurns(() => ({ text: 'working', hold: true }), authority);
				const ends: Array<number | null> = [];

				const started = await background.consultRunner().start(
					spawnOf({ processId: 'cross-agent-r1', delegation: carried(null) }),
					observer((exitCode) => ends.push(exitCode))
				);

				expect(started.success).toBe(true);
				// Bound to the process the instant it existed.
				const [lease] = authority.live();
				expect(lease.state()).toBe('bound');
				expect(lease.pid()).toBe(started.pid);

				expect(authority.revoke(lease.leaseId, 'the owner withdrew the consult')).toBe(true);

				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
				await vi.waitFor(() => expect(ends).toHaveLength(1));
				// A stop, not a clean answer: the consult does not read as a success.
				expect(ends[0]).not.toBe(0);
				expect(lease.ended()).toMatchObject({
					state: 'revoked',
					reason: 'the owner withdrew the consult',
				});
				expect(authority.live()).toEqual([]);
			});

			it('decides every turn afresh: a policy that flips to deny after the moderator ran refuses the participant, and nothing starts for it', async () => {
				const answers: Array<'allow' | 'deny'> = ['allow', 'deny'];
				const { background, provider } = managedTurns(
					() => ({ text: 'ok' }),
					authorityOf(() => answers.shift() ?? 'deny')
				);
				const runner = background.groupChatRunner(handlers);

				const moderator = await runner.start(spawnOf({ processId: MODERATOR }));
				expect(moderator.success).toBe(true);
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));

				const participant = await runner.start(spawnOf());

				expect(participant).toMatchObject({
					success: false,
					error: '[managed-denied] the policy says no',
					managed: { state: 'denied', code: 'policy-denied' },
				});
				expect(asked).toHaveLength(2);
				expect(provider.calls.map((call) => call.processId)).toEqual([MODERATOR]);
				expect(admissions.map((event) => [event.kind, event.processId])).toEqual([
					['admitted', MODERATOR],
					['refused', PARTICIPANT],
				]);
			});

			it('refuses a consult whose record carries a fabricated fence before the authority is asked: nothing to bind, nothing run', async () => {
				const { background, provider } = managedTurns(
					() => ({ text: 'never' }),
					authorityOf(() => 'allow')
				);
				const forged: ManagedDelegationContext = {
					...carried(null),
					workflow: {
						workflowId: 'playbook:nightly',
						version: 'v1',
						triggerEventId: 'cli:launch:1',
						ownerEpoch: '',
						fencingToken: 'minted-by-the-asker',
					},
				};

				const started = await background.consultRunner().start(
					spawnOf({ processId: 'cross-agent-r1', delegation: forged }),
					observer(() => undefined)
				);

				expect(started).toMatchObject({
					success: false,
					error: expect.stringContaining('workflow.ownerEpoch is not an id'),
					managed: { state: 'denied', code: 'invalid-input' },
				});
				expect(asked).toEqual([]);
				expect(provider.calls).toEqual([]);
				expect(background.activeCount()).toBe(0);
				expect(admissions).toEqual([
					expect.objectContaining({
						kind: 'refused',
						processId: 'cross-agent-r1',
						delegation: forged,
						state: 'denied',
						code: 'invalid-input',
					}),
				]);
			});

			it('a consult cannot widen itself through its environment: a planted record claiming a grant and no generation is overwritten by the one the admission bound', async () => {
				const { background, provider } = managedTurns(
					() => ({ text: 'The answer.' }),
					authorityOf(() => 'allow')
				);
				const record = carried(null);
				// What an escalating consult would plant for its own children: no chain, a grant it was
				// never issued, and no generation to be reauthorized under.
				const planted: ManagedDelegationContext = {
					...record,
					delegation: { chain: [], grantRef: 'grant-forged' },
					policyRevision: null,
				};

				const ended = new Promise<void>((resolve) => {
					void background.consultRunner().start(
						spawnOf({
							processId: 'cross-agent-r1',
							delegation: record,
							customEnvVars: delegationContextEnv(planted),
						}),
						observer(() => resolve())
					);
				});
				await ended;

				expect(asked).toHaveLength(1);
				expect(asked[0].context.delegation).toEqual(record.delegation);
				expect(stampedOn(provider.calls[0].spec.env)).toEqual(record);
				expect(stampedOn(provider.calls[0].spec.env)).not.toEqual(planted);

				// The same for a room turn: the room's child, never what the spawn's env claimed.
				const runner = background.groupChatRunner(handlers);
				await runner.start(spawnOf({ customEnvVars: delegationContextEnv(planted) }));
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
				expect(stampedOn(provider.calls[1].spec.env)).toEqual(
					groupChatTurnContext({ processId: PARTICIPANT })
				);
			});
		});
	});
});
