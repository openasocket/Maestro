/**
 * The runtime's background turns: how a group chat turn and a consult are started, reported, and
 * stopped, over the real run layer. A missing binary and an unknown provider are the real thing
 * (nothing is faked for them); the rest replay a recorded stream through the fake agent.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { stopProcess } from '../../control/termination';
import { getAgentCapabilities } from '../../providers/capabilities';
import { getAgentDefinition, type AgentConfig } from '../../providers/definitions';
import { resolveMaestroPaths } from '../../paths/resolve';
import { groupChatTurnContext } from '../../groupchat/spawn';
import type { GroupChatSpawn } from '../../groupchat/types';
import {
	createLocalHostAuthority,
	type AdmissionRequest,
	type ContextVerification,
} from '../../managed/authority';
import type { ManagedBindingState } from '../../managed/binding';
import {
	MANAGED_DELEGATION_ENV_VAR,
	childDelegationContext,
	delegationContextOf,
	delegationContextEnv,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../managed/delegation';
import { createHeadlessSpawnAuthority } from '../../managed/host-adapter';
import { CALLER_CREDENTIAL_ENV_VAR } from '../../launch/env';
import {
	consultOwner,
	createBackgroundTurns,
	groupChatOwner,
	type BackgroundAdmissionEvent,
	type BackgroundManagedOptions,
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

		it('retains one registration until end reporting completes and rejects overlapping launches', async () => {
			const { background, provider } = turns(() => ({ text: 'done' }));
			const reporting = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const runner = background.groupChatRunner({
				...handlers,
				onEnd: async () => {
					reporting.resolve();
					await finish.promise;
				},
			});
			try {
				await expect(runner.start(spawnOf())).resolves.toMatchObject({ success: true });
				await reporting.promise;
				expect(background.activeCount()).toBe(0);
				expect(background.registeredCount()).toBe(1);
				expect(registry.size()).toBe(1);
				await expect(runner.start(spawnOf())).resolves.toMatchObject({ success: false });
				expect(provider!.calls).toHaveLength(1);
			} finally {
				finish.resolve();
				await background.whenSettled(() => true);
			}
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
			authority: ReturnType<typeof authorityOf> | null,
			actorId: string = actor.id,
			policyRevision = 3
		): BackgroundSpawnAuthorityPort => {
			const binding: ManagedBindingState = authority
				? {
						state: 'enrolled',
						file: '/data/maestro-managed-binding.json',
						record: {
							authorityId: 'fleet',
							policySources: [],
							policyRevision,
						} as unknown as Extract<ManagedBindingState, { state: 'enrolled' }>['record'],
					}
				: { state: 'standalone', files: [] };
			return createHeadlessSpawnAuthority({
				installation,
				binding,
				host: authority ? { authority, policy: () => ({ sources: [], policyRevision }) } : null,
				origin: 'headless',
				actor: { ...actor, id: actorId },
			});
		};

		function managedTurns(
			script: FakeScript,
			authority: ReturnType<typeof authorityOf> | null,
			account: string | null = null,
			readPort?: () => BackgroundSpawnAuthorityPort,
			managed: Partial<BackgroundManagedOptions> = {}
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
					port: readPort ?? (() => port),
					account,
					onAdmission: (event) => admissions.push(event),
					...managed,
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

		describe('live background source custody', () => {
			it.each(['managed', 'standalone'] as const)(
				'keeps %s process ownership when caller coordinates change during preparation',
				async (standing) => {
					const authority = authorityOf(() => 'allow');
					const { background, provider } = managedTurns(
						() => ({ text: 'working', hold: true }),
						standing === 'managed' ? authority : null
					);
					const runner = background.groupChatRunner(handlers);
					const spawn = spawnOf({ readOnlyMode: true });
					const pending = runner.start(spawn);
					spawn.processId = MODERATOR;
					spawn.readOnlyMode = false;
					const started = await pending;
					try {
						expect(started.success).toBe(true);
						expect(provider.calls[0].processId).toBe(PARTICIPANT);
						expect(registry.isBusy(groupChatOwner(CHAT_ID), PARTICIPANT)).toBe(true);
						expect(registry.isBusy(groupChatOwner(CHAT_ID), MODERATOR)).toBe(false);
						expect(background.sourceCustody(MODERATOR)).toBeNull();
						if (standing === 'managed')
							expect(background.sourceCustody(PARTICIPANT)?.writable).toBe(false);
						else expect(background.sourceCustody(PARTICIPANT)).toBeNull();
						runner.stop(PARTICIPANT);
						await background.whenSettled(() => true);
						expect(background.activeCount()).toBe(0);
						expect(registry.size()).toBe(0);
					} finally {
						// Clean up the fixture even if an ownership regression disconnects Stop.
						if (background.activeCount() && started.pid)
							stopProcess({ pid: started.pid }, { from: 'kill', graceMs: 0, immediate: true });
						await registry.stopAll();
					}
				}
			);

			it.each([
				['group-chat', 'preparation'],
				['consult', 'preparation'],
				['group-chat', 'admission'],
				['consult', 'admission'],
			])('pins the submitted %s identity and lineage through %s', async (kind, phase) => {
				const authority = authorityOf(() => 'allow');
				const waiting = Promise.withResolvers<void>();
				const resume = Promise.withResolvers<void>();
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					waiting.resolve();
					await resume.promise;
					return admit(request);
				});
				const { background, provider } = managedTurns(
					() => ({ text: 'original source', hold: true }),
					authority
				);
				const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
				const runner =
					kind === 'consult' ? background.consultRunner() : background.groupChatRunner(handlers);
				const processId = kind === 'consult' ? 'cross-agent-original' : PARTICIPANT;
				const delegation = carried(3);
				delegation.workflow = {
					workflowId: 'nightly',
					version: 'v1',
					triggerEventId: 'cue:1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				};
				delegation.delegation.grantRef = 'grant-1';
				const original = structuredClone(delegation);
				const spawn = spawnOf({
					processId,
					delegation,
					readOnlyMode: true,
					prompt: 'original prompt',
				});
				const pending = runner.start(spawn, observer);
				try {
					if (phase === 'admission') await waiting.promise;
					spawn.processId = MODERATOR;
					spawn.prompt = 'replacement prompt';
					spawn.readOnlyMode = false;
					delegation.identity.runId = 'replacement-run';
					delegation.delegation.chain[0].id = 'replacement-source';
					delegation.delegation.chain[1].id = 'replacement-target';
					delegation.delegation.grantRef = 'replacement-grant';
					delegation.workflow.fencingToken = 'replacement-fence';
					resume.resolve();
					expect((await pending).success).toBe(true);
					expect(provider.calls).toHaveLength(1);
					expect(provider.calls[0].processId).toBe(processId);
					expect(promptOf(provider.calls[0].spec)).toContain('original prompt');
					expect(promptOf(provider.calls[0].spec)).not.toContain('replacement prompt');
					const custody = background.sourceCustody(processId)!;
					expect(custody.writable).toBe(false);
					expect(custody.context.workflow).toEqual(original.workflow);
					expect(custody.context.delegation).toEqual(original.delegation);
					expect(custody.context.identity).toEqual(original.identity);
					expect(background.sourceCustody(MODERATOR)).toBeNull();
					expect(stampedOn(provider.calls[0].spec.env!)).toEqual(original);
					// Stop must reach the process registered under the submitted id.
					runner.stop(processId);
					expect(background.sourceCustody(processId)).toBeNull();
					await background.whenSettled(() => true);
					expect(authority.live()).toEqual([]);
					expect(registry.size()).toBe(0);
					// A fresh request may use the caller's edits; it is admitted independently.
					spawn.processId = processId;
					expect((await runner.start(spawn, observer)).success).toBe(true);
					expect(background.sourceCustody(processId)?.writable).toBe(true);
					expect(background.sourceCustody(processId)?.context.identity.runId).toBe(
						'replacement-run'
					);
					expect(asked).toHaveLength(2);
				} finally {
					resume.resolve();
					await pending;
					await registry.stopAll();
				}
			});

			it.each([true, false])(
				'retains original context and prepared readOnlyMode=%s',
				async (readOnlyMode) => {
					const authority = authorityOf(() => 'allow');
					const { background } = managedTurns(() => ({ text: 'working', hold: true }), authority);
					const runner = background.groupChatRunner(handlers);
					const spawn = spawnOf({ readOnlyMode, delegation: carried(3) });
					expect(background.sourceCustody(spawn.processId)).toBeNull();
					const started = await runner.start(spawn);
					expect(started.success).toBe(true);
					const custody = background.sourceCustody(spawn.processId)!;
					expect(custody.context).toBe(asked[0].context);
					expect(custody.writable).toBe(!readOnlyMode);
					expect(authority.live()[0].pid()).toBe(started.pid);
					spawn.readOnlyMode = !readOnlyMode;
					expect(background.sourceCustody(spawn.processId)).toEqual(custody);
					expect(background.sourceCustody('other-process')).toBeNull();
					runner.stop(spawn.processId);
					expect(background.sourceCustody(spawn.processId)).toBeNull();
					await background.whenSettled(() => true);
					expect(authority.live()).toEqual([]);
					await runner.start(spawn);
					expect(background.sourceCustody(spawn.processId)?.context).not.toBe(custody.context);
					expect(background.sourceCustody(spawn.processId)?.writable).toBe(readOnlyMode);
				}
			);

			it.each([
				'policy',
				'sources',
				'actor',
				'authority',
				'standing',
				'unreadable',
				'context',
				'lease',
				'revoked',
			] as const)(
				'withdraws custody on %s drift without reporting another admission',
				async (change) => {
					const authority = authorityOf(() => 'allow');
					let port = portOf(authority);
					let unreadable = false;
					const { background } = managedTurns(
						() => ({ text: 'working', hold: true }),
						authority,
						null,
						() => {
							if (unreadable) throw new Error('custody unavailable');
							return port;
						}
					);
					await background.groupChatRunner(handlers).start(spawnOf());
					const custody = background.sourceCustody(PARTICIPANT)!;
					expect(custody.context).toBe(asked[0].context);
					const before = admissions.length;
					switch (change) {
						case 'policy':
							port = portOf(authority, actor.id, 4);
							break;
						case 'sources':
							port.policy = () => ({
								sources: [{ kind: 'endpoint', id: 'changed', revision: 3 }],
								policyRevision: 3,
							});
							break;
						case 'actor':
							port = portOf(authority, 'replacement');
							break;
						case 'authority':
							port = portOf(authorityOf(() => 'allow'));
							break;
						case 'standing':
							port = portOf(null);
							break;
						case 'unreadable':
							unreadable = true;
							break;
						case 'context':
							custody.context.identity.attemptId = 'tampered';
							break;
						case 'lease':
							vi.spyOn(authority, 'live').mockReturnValueOnce([]);
							break;
						case 'revoked':
							authority.revoke(authority.live()[0].leaseId, 'source withdrawn');
							break;
					}
					expect(background.sourceCustody(PARTICIPANT)).toBeNull();
					expect(admissions).toHaveLength(before);
				}
			);

			it.each(['pending', 'denied', 'standalone'] as const)(
				'supplies no %s custody',
				async (mode) => {
					const authority = authorityOf(() => (mode === 'denied' ? 'deny' : 'allow'));
					const admission = Promise.withResolvers<void>();
					if (mode === 'pending') {
						const admit = authority.admit.bind(authority);
						vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
							await admission.promise;
							return admit(request);
						});
					}
					const { background } = managedTurns(
						() => ({ text: 'working', hold: true }),
						mode === 'standalone' ? null : authority
					);
					const pending = background.groupChatRunner(handlers).start(spawnOf());
					try {
						if (mode === 'pending')
							await vi.waitFor(() => expect(authority.admit).toHaveBeenCalled());
						else await pending;
						expect(background.sourceCustody(PARTICIPANT)).toBeNull();
					} finally {
						admission.resolve();
						await pending;
					}
				}
			);

			it.each(['stop', 'revoke'] as const)(
				'observes a %s during the current scope read',
				async (change) => {
					const authority = authorityOf(() => 'allow');
					const port = portOf(authority);
					const { background } = managedTurns(
						() => ({ text: 'working', hold: true }),
						authority,
						null,
						() => port
					);
					const runner = background.groupChatRunner(handlers);
					await runner.start(spawnOf());
					expect(background.sourceCustody(PARTICIPANT)).not.toBeNull();
					const context = port.context.bind(port);
					port.context = (input) => {
						if (change === 'stop') runner.stop(PARTICIPANT);
						else authority.revoke(authority.live()[0].leaseId, 'revoked during recheck');
						return context(input);
					};
					expect(background.sourceCustody(PARTICIPANT)).toBeNull();
				}
			);

			describe('caller credentials (MCOMP-17-03BJ)', () => {
				const credentialOf = (env: Record<string, string | undefined> | undefined) =>
					env?.[CALLER_CREDENTIAL_ENV_VAR];

				it.each(['group-chat', 'consult'] as const)(
					'stamps a fresh %s credential that resolves to its live process and owner, and never after it stops',
					async (kind) => {
						const authority = authorityOf(() => 'allow');
						const { background, provider } = managedTurns(
							() => ({ text: 'working', hold: true }),
							authority
						);
						const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
						const runner =
							kind === 'consult'
								? background.consultRunner()
								: background.groupChatRunner(handlers);
						const processId = kind === 'consult' ? 'cross-agent-credential' : PARTICIPANT;
						const owner = kind === 'consult' ? consultOwner(processId) : groupChatOwner(CHAT_ID);
						const spawn = spawnOf({ processId, delegation: carried(3) });
						expect((await runner.start(spawn, observer)).success).toBe(true);
						const first = credentialOf(provider.calls[0].spec.env);
						expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
						expect(background.callerSource(first!)).toEqual({ processId, owner });
						expect(background.callerSource('not-a-credential')).toBeNull();
						expect(background.callerSource(undefined as unknown as string)).toBeNull();
						runner.stop(processId);
						expect(background.callerSource(first!)).toBeNull();
						await background.whenSettled(() => true);
						expect(background.callerSource(first!)).toBeNull();

						expect((await runner.start(spawn, observer)).success).toBe(true);
						const second = credentialOf(provider.calls[1].spec.env);
						expect(second).toBeDefined();
						expect(second).not.toBe(first);
						expect(background.callerSource(second!)).toEqual({ processId, owner });
						expect(background.callerSource(first!)).toBeNull();
						runner.stop(processId);
						await background.whenSettled(() => true);
					}
				);

				it('stamps no credential on a standalone host and resolves nothing', async () => {
					const { background, provider } = managedTurns(
						() => ({ text: 'working', hold: true }),
						null
					);
					const runner = background.groupChatRunner(handlers);
					expect((await runner.start(spawnOf())).success).toBe(true);
					expect(credentialOf(provider.calls[0].spec.env)).toBeUndefined();
					runner.stop(PARTICIPANT);
					await background.whenSettled(() => true);
				});

				it('mints no credential for a refused turn', async () => {
					const authority = authorityOf(() => 'deny');
					const { background, provider } = managedTurns(() => ({ text: 'working' }), authority);
					const started = await background.groupChatRunner(handlers).start(spawnOf());
					expect(started.success).toBe(false);
					expect(provider.calls).toHaveLength(0);
				});

				it('keeps simultaneous credentials apart and drops one whose source scope is withdrawn', async () => {
					const authority = authorityOf(() => 'allow');
					let withdrawn = false;
					const { background, provider } = managedTurns(
						() => ({ text: 'working', hold: true }),
						authority
					);
					const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
					const first = background.consultRunner(() =>
						withdrawn ? { state: 'denied', code: 'policy-denied', message: 'source gone' } : null
					);
					const second = background.consultRunner();
					await first.start(
						spawnOf({ processId: 'cross-agent-first', delegation: carried(3) }),
						observer
					);
					await second.start(
						spawnOf({ processId: 'cross-agent-second', delegation: carried(3) }),
						observer
					);
					const [a, b] = provider.calls.map((call) => credentialOf(call.spec.env)!);
					expect(a).not.toBe(b);
					expect(background.callerSource(a)?.processId).toBe('cross-agent-first');
					expect(background.callerSource(b)?.processId).toBe('cross-agent-second');
					withdrawn = true;
					expect(background.callerSource(a)).toBeNull();
					expect(background.callerSource(b)).toEqual({
						processId: 'cross-agent-second',
						owner: consultOwner('cross-agent-second'),
					});
					first.stop('cross-agent-first');
					second.stop('cross-agent-second');
					await background.whenSettled(() => true);
				});

				it('drops a credential on registry shutdown before its end is reported', async () => {
					const authority = authorityOf(() => 'allow');
					const { background, provider } = managedTurns(
						() => ({ text: 'working', hold: true }),
						authority
					);
					await background.groupChatRunner(handlers).start(spawnOf({ processId: MODERATOR }));
					const credential = credentialOf(provider.calls[0].spec.env)!;
					expect(background.callerSource(credential)?.processId).toBe(MODERATOR);
					const stopping = registry.stopAll();
					expect(background.callerSource(credential)).toBeNull();
					await stopping;
				});
			});

			it('clears custody before asynchronous end reporting and on registry shutdown', async () => {
				const authority = authorityOf(() => 'allow');
				const reportedEnd = Promise.withResolvers<void>();
				const releaseReport = Promise.withResolvers<void>();
				const { background } = managedTurns(
					({ processId }) => ({ text: 'answer', hold: processId === MODERATOR }),
					authority
				);
				const runner = background.groupChatRunner({
					...handlers,
					onEnd: async () => {
						reportedEnd.resolve();
						await releaseReport.promise;
					},
				});
				try {
					await runner.start(spawnOf());
					await reportedEnd.promise;
					expect(background.registeredCount()).toBe(1);
					expect(background.sourceCustody(PARTICIPANT)).toBeNull();
					await runner.start(spawnOf({ processId: MODERATOR }));
					expect(background.sourceCustody(MODERATOR)).not.toBeNull();
					const stopping = registry.stopAll();
					expect(background.sourceCustody(MODERATOR)).toBeNull();
					releaseReport.resolve();
					await stopping;
				} finally {
					releaseReport.resolve();
				}
				expect(authority.live()).toEqual([]);
			});

			it('keeps simultaneous consult sources isolated and rechecks their individual scope', async () => {
				const authority = authorityOf(() => 'allow');
				let withdrawn = false;
				const { background } = managedTurns(() => ({ text: 'working', hold: true }), authority);
				const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
				const first = background.consultRunner(() =>
					withdrawn ? { state: 'denied', code: 'policy-denied', message: 'source gone' } : null
				);
				const second = background.consultRunner();
				await Promise.all([
					first.start(
						spawnOf({ processId: 'cross-agent-first', delegation: carried(3), readOnlyMode: true }),
						observer
					),
					second.start(
						spawnOf({ processId: 'cross-agent-second', delegation: carried(3) }),
						observer
					),
				]);
				expect(background.sourceCustody('cross-agent-first')?.writable).toBe(false);
				const other = background.sourceCustody('cross-agent-second');
				expect(other).not.toBeNull();
				withdrawn = true;
				expect(background.sourceCustody('cross-agent-first')).toBeNull();
				expect(background.sourceCustody('cross-agent-second')).toEqual(other);
				first.stop('cross-agent-first');
				second.stop('cross-agent-second');
				expect(background.sourceCustody('cross-agent-second')).toBeNull();
				await background.whenSettled(() => true);
				expect(observer.onEnd).not.toHaveBeenCalled();
			});

			it('rechecks each source in its original request context when a nested request reads it', async () => {
				const authority = authorityOf(() => 'allow');
				const parents = new AsyncLocalStorage<ContextVerification>();
				const source = portOf(authority, 'first-caller').context(carried(3));
				const other = portOf(authority, 'second-caller').context(carried(3));
				const { background } = managedTurns(
					() => ({ text: 'working', hold: true }),
					authority,
					null,
					undefined,
					{
						parentContext: () =>
							parents.getStore() ?? { ok: false, code: 'unauthenticated', problems: ['no caller'] },
					}
				);
				const runner = background.groupChatRunner(handlers);
				await Promise.all([
					parents.run(source, () => runner.start(spawnOf())),
					parents.run(other, () => runner.start(spawnOf({ processId: MODERATOR }))),
				]);
				const first = background.sourceCustody(PARTICIPANT)!;
				const second = background.sourceCustody(MODERATOR)!;
				expect(first.context.delegation.chain.at(-1)?.id).toBe('first-caller');
				expect(second.context.delegation.chain.at(-1)?.id).toBe('second-caller');
				expect(parents.run(other, () => background.sourceCustody(PARTICIPANT))).toEqual(first);
				expect(parents.run(source, () => background.sourceCustody(MODERATOR))).toEqual(second);
			});

			it('admits a nested child from live custody, withdraws with the parent and recovers freshly', async () => {
				const authority = authorityOf(() => 'allow');
				const source = managedTurns(() => ({ text: 'source', hold: true }), authority);
				const runner = source.background.groupChatRunner(handlers);
				const record = carried(3);
				record.workflow = {
					workflowId: 'nightly',
					version: 'v1',
					triggerEventId: 'cue:1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				};
				record.delegation.grantRef = 'grant-1';
				await runner.start(spawnOf({ delegation: record }));
				const child = managedTurns(
					() => ({ text: 'nested', hold: true }),
					authority,
					null,
					undefined,
					{
						parentContext: () => {
							const custody = source.background.sourceCustody(PARTICIPANT);
							return custody
								? { ok: true, context: custody.context }
								: { ok: false, code: 'unauthenticated', problems: ['source ended'] };
						},
					}
				);
				const childRunner = child.background.groupChatRunner(handlers);
				await expect(childRunner.start(spawnOf({ processId: MODERATOR }))).resolves.toMatchObject({
					success: true,
				});
				const custody = child.background.sourceCustody(MODERATOR)!;
				expect(custody.context.workflow).toEqual(record.workflow);
				expect(custody.context.delegation).toEqual({
					chain: [...record.delegation.chain, actor],
					grantRef: 'grant-1',
				});
				expect(asked).toHaveLength(2);
				runner.stop(PARTICIPANT);
				expect(child.background.sourceCustody(MODERATOR)).toBeNull();
				childRunner.stop(MODERATOR);
				await registry.stopAll();
				await expect(childRunner.start(spawnOf({ processId: MODERATOR }))).resolves.toMatchObject({
					success: false,
				});
				expect(asked).toHaveLength(2);
				await runner.start(spawnOf({ delegation: record }));
				await expect(childRunner.start(spawnOf({ processId: MODERATOR }))).resolves.toMatchObject({
					success: true,
				});
				expect(child.background.sourceCustody(MODERATOR)?.context).not.toBe(custody.context);
			});
		});

		describe('request-specific consult custody', () => {
			const refusal = {
				state: 'unavailable' as const,
				code: 'runtime-unavailable' as const,
				message: 'The consult source custody changed; submit a fresh request.',
			};

			describe.each(['initial', 'preparation', 'admission', 'observer', 'sink'] as const)(
				'%s boundary',
				(boundary) => {
					it.each(['refused', 'unreadable'] as const)(
						'refuses %s custody without binding a process and recovers',
						async (failure) => {
							const authority = authorityOf(() => 'allow');
							let withdrawn = boundary === 'initial';
							let recovered = false;
							const change = () => {
								if (!recovered) withdrawn = true;
							};
							const { background, provider } = managedTurns(
								() => {
									if (boundary === 'sink') change();
									return { text: 'Fresh answer' };
								},
								authority,
								null,
								undefined,
								{
									onAdmission: (event) => {
										admissions.push(event);
										if (event.kind === 'admitted' && boundary === 'observer') change();
									},
								}
							);
							const issued: import('../../managed/authority').DispatchLease[] = [];
							const admit = authority.admit.bind(authority);
							vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
								const result = await admit(request);
								if (result.state === 'admitted') issued.push(result.lease);
								if (boundary === 'admission') change();
								return result;
							});
							const runner = background.consultRunner(() => {
								if (withdrawn && failure === 'unreadable') throw new Error('custody unreadable');
								return withdrawn ? refusal : null;
							});
							const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
							const spawn = spawnOf({ processId: 'cross-agent-scoped', delegation: carried(3) });
							const pending = runner.start(spawn, observer);
							if (boundary === 'preparation') change();
							await expect(pending).resolves.toMatchObject({ success: false });
							await background.whenSettled(() => true);
							expect(admissions).toContainEqual(
								expect.objectContaining({
									kind: 'refused',
									message: expect.stringMatching(/custody/),
								})
							);
							expect(observer.onEnd).not.toHaveBeenCalled();
							expect(observer.onSessionId).not.toHaveBeenCalled();
							expect(authority.live()).toEqual([]);
							expect(registry.size()).toBe(0);
							expect(background.registeredCount()).toBe(0);
							if (boundary !== 'sink') expect(provider.calls).toEqual([]);
							if (boundary === 'initial' || boundary === 'preparation') expect(asked).toEqual([]);
							else {
								expect(issued).toHaveLength(1);
								expect(issued[0].pid()).toBeUndefined();
								expect(issued[0].ended()).toMatchObject({
									state: 'released',
									release: { outcome: 'spawn-failed' },
								});
							}
							withdrawn = false;
							recovered = true;
							await expect(runner.start(spawn, observer)).resolves.toMatchObject({ success: true });
							await background.whenSettled(() => true);
							expect(observer.onEnd).toHaveBeenCalledOnce();
							expect(issued.at(-1)!.pid()).toBeGreaterThan(0);
							expect(authority.live()).toEqual([]);
						}
					);
				}
			);

			it('isolates concurrent consult checks and preserves host admission', async () => {
				const authority = authorityOf(() => 'allow');
				const { background, provider } = managedTurns(() => ({ text: 'Allowed' }), authority);
				const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
				const results = await Promise.all([
					background
						.consultRunner(() => refusal)
						.start(
							spawnOf({ processId: 'cross-agent-withdrawn', delegation: carried(3) }),
							observer
						),
					background
						.consultRunner(() => null)
						.start(spawnOf({ processId: 'cross-agent-current', delegation: carried(3) }), observer),
				]);
				expect(results.map((result) => result.success)).toEqual([false, true]);
				await background.whenSettled(() => true);
				expect(provider.calls.map((call) => call.processId)).toEqual(['cross-agent-current']);
				expect(asked).toHaveLength(1);
				expect(observer.onEnd).toHaveBeenCalledOnce();
			});

			it('cannot replace host denial or authenticated parent verification with a passing check', async () => {
				for (const boundary of ['authority', 'parent'] as const) {
					const authority = authorityOf(() => (boundary === 'authority' ? 'deny' : 'allow'));
					const { background, provider } = managedTurns(
						() => ({ text: 'Must not run' }),
						authority,
						null,
						undefined,
						boundary === 'parent'
							? {
									parentContext: () => ({
										ok: false,
										code: 'unauthenticated',
										problems: ['withdrawn'],
									}),
								}
							: {}
					);
					await expect(
						background
							.consultRunner(() => null)
							.start(spawnOf({ processId: 'cross-agent-denied', delegation: carried(3) }), {
								onActivity: vi.fn(),
								onSessionId: vi.fn(),
								onEnd: vi.fn(),
							})
					).resolves.toMatchObject({ success: false });
					expect(provider.calls).toEqual([]);
					expect(authority.live()).toEqual([]);
				}
			});
		});

		describe('authenticated background parents', () => {
			function parent(authority: ReturnType<typeof authorityOf>, actorId = 'source', change = '') {
				const record = carried(7);
				record.workflow = {
					workflowId: 'nightly',
					version: 'v1',
					triggerEventId: 'cue:1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				};
				record.delegation.grantRef = change === 'grant' ? 'grant-2' : 'grant-1';
				if (change === 'fence') record.workflow.fencingToken = 'fence-2';
				if (change === 'policy') record.policyRevision = 8;
				const verified = portOf(authority, actorId, 7).context(record);
				if (!verified.ok) throw new Error(verified.problems.join('; '));
				return verified;
			}

			it.each([MODERATOR, PARTICIPANT, 'consult-1'])(
				'preserves the authenticated source and target scope for %s',
				async (processId) => {
					const authority = authorityOf(() => 'allow');
					const source = parent(authority);
					const expected = childDelegationContext(delegationContextOf(source.context), {
						link: source.context.actor,
						requestId: processId,
						attemptId: processId,
					});
					const readParent = vi.fn(() => parent(authority));
					const { background, provider } = managedTurns(
						() => ({ text: 'ok' }),
						authority,
						null,
						undefined,
						{ parentContext: readParent }
					);
					const spawn = spawnOf({
						processId,
						...(processId === 'consult-1' ? { delegation: expected } : {}),
						customEnvVars: delegationContextEnv(carried(null)),
					});
					const started =
						processId === 'consult-1'
							? await background.consultRunner().start(spawn, {
									onActivity: vi.fn(),
									onSessionId: vi.fn(),
									onEnd: vi.fn(),
								})
							: await background.groupChatRunner(handlers).start(spawn);
					expect(started).toMatchObject({ success: true });
					await background.whenSettled(() => true);
					expect(stampedOn(provider.calls[0].spec.env)).toEqual({ ...expected, policyRevision: 3 });
					expect(asked[0].context).toMatchObject({ ...expected, policyRevision: 3, actor });
					expect(readParent).toHaveBeenCalledWith(processId);
					expect(readParent.mock.calls.length).toBeGreaterThanOrEqual(4);
					expect(authority.live()).toEqual([]);
				}
			);

			it.each(['copied', 'missing', 'rejected', 'throw', 'depth', 'standalone'] as const)(
				'refuses a %s parent without preparing a child',
				async (mode) => {
					const authority = authorityOf(() => 'allow');
					const source = parent(authority);
					const readParent = () => {
						if (mode === 'throw') throw new Error('parent disconnected');
						if (mode === 'missing') return undefined as never;
						if (mode === 'copied') return structuredClone(source);
						if (mode === 'rejected')
							return {
								ok: false as const,
								code: 'unauthenticated' as const,
								problems: ['revoked'],
							};
						if (mode === 'depth') {
							const record = delegationContextOf(source.context);
							record.delegation.chain = Array.from({ length: 16 }, (_, i) => ({
								kind: 'agent' as const,
								id: `agent-${i}`,
							}));
							return portOf(authority, 'source', 7).context(record);
						}
						return source;
					};
					const { background, provider } = managedTurns(
						() => ({ text: 'never' }),
						mode === 'standalone' ? null : authority,
						null,
						undefined,
						{ parentContext: readParent }
					);
					await expect(
						background.groupChatRunner(handlers).start(spawnOf())
					).resolves.toMatchObject({ success: false });
					expect(asked).toEqual([]);
					expect(provider.calls).toEqual([]);
					expect(registry.size()).toBe(0);
				}
			);

			it.each(['workflow', 'grant', 'root', 'chain'] as const)(
				'refuses an explicit child with a different %s',
				async (field) => {
					const authority = authorityOf(() => 'allow');
					const source = parent(authority);
					const delegation = childDelegationContext(delegationContextOf(source.context), {
						link: source.context.actor,
						requestId: 'ask-2',
						attemptId: 'try-1',
					});
					if (field === 'workflow') delegation.workflow!.fencingToken = 'forged';
					if (field === 'grant') delegation.delegation.grantRef = 'forged';
					if (field === 'root') delegation.identity.rootRunId = 'forged';
					if (field === 'chain') delegation.delegation.chain = [];
					const { background, provider } = managedTurns(
						() => ({ text: 'never' }),
						authority,
						null,
						undefined,
						{ parentContext: () => source }
					);
					await expect(
						background.groupChatRunner(handlers).start(spawnOf({ delegation }))
					).resolves.toMatchObject({
						success: false,
						managed: { state: 'denied' },
					});
					expect(asked).toEqual([]);
					expect(provider.calls).toEqual([]);
				}
			);

			describe.each(['preparation', 'admission', 'observer', 'sink'] as const)(
				'%s source custody',
				(boundary) => {
					it.each(['actor', 'withdrawal', 'copied', 'throw', 'fence', 'grant', 'policy'] as const)(
						'refuses %s drift and admits a fresh attempt',
						async (changeKind) => {
							const authority = authorityOf(() => 'allow');
							let source: ContextVerification = parent(authority);
							let unreadable = false;
							const change = () => {
								if (changeKind === 'throw') unreadable = true;
								else if (changeKind === 'withdrawal')
									source = { ok: false, code: 'unauthenticated', problems: ['withdrawn'] };
								else if (changeKind === 'copied') source = structuredClone(source);
								else
									source = parent(
										authority,
										changeKind === 'actor' ? 'replaced-source' : 'source',
										changeKind
									);
							};
							let changed = false;
							const changeOnce = () => {
								if (!changed) {
									changed = true;
									change();
								}
							};
							const { background, provider } = managedTurns(
								() => {
									if (boundary === 'sink') changeOnce();
									return { text: 'ok' };
								},
								authority,
								null,
								undefined,
								{
									parentContext: () => {
										if (unreadable) throw new Error('parent disconnected');
										return source;
									},
									onAdmission: (event) => {
										admissions.push(event);
										if (boundary === 'observer') changeOnce();
									},
								}
							);
							const admit = authority.admit.bind(authority);
							vi.spyOn(authority, 'admit').mockImplementationOnce(async (request) => {
								const result = await admit(request);
								if (boundary === 'admission') change();
								return result;
							});
							const runner = background.groupChatRunner(handlers);
							const pending = runner.start(spawnOf());
							if (boundary === 'preparation') change();
							await expect(pending).resolves.toMatchObject({ success: false });
							await background.whenSettled(() => true);
							expect(reported).toEqual([]);
							expect(authority.live()).toEqual([]);
							expect(registry.size()).toBe(0);
							if (boundary !== 'sink') expect(provider.calls).toEqual([]);
							source = parent(authority, 'replaced-source');
							unreadable = false;
							await expect(runner.start(spawnOf())).resolves.toMatchObject({ success: true });
							await background.whenSettled(() => true);
							expect(asked.at(-1)!.context.delegation.chain.at(-1)!.id).toBe('replaced-source');
						}
					);
				}
			);
		});

		it.each([
			['preparation', 'group'],
			['preparation', 'consult'],
			['preparation', 'standalone'],
			['admission', 'group'],
			['admission', 'consult'],
			['admission', 'stopAgent'],
			['admission', 'stopTab'],
			['admission', 'interruptTab'],
			['admission', 'stopAll'],
			['admission', 'terminateAllNow'],
		] as const)('cancels during %s through %s without a child effect', async (phase, route) => {
			const authority = authorityOf(() => 'allow');
			const admissionReady = Promise.withResolvers<void>();
			const resumeAdmission = Promise.withResolvers<void>();
			const admit = authority.admit.bind(authority);
			let issued: ReturnType<typeof authority.live> = [];
			vi.spyOn(authority, 'admit').mockImplementationOnce(async (request) => {
				const result = await admit(request);
				issued = authority.live();
				admissionReady.resolve();
				await resumeAdmission.promise;
				return result;
			});
			const { background, provider } = managedTurns(
				() => ({ text: 'ok', sessionId: 'retry' }),
				route === 'standalone' ? null : authority
			);
			const observer = { onActivity: vi.fn(), onSessionId: vi.fn(), onEnd: vi.fn() };
			const consult = background.consultRunner();
			const group = background.groupChatRunner(handlers);
			const spawn = spawnOf({ delegation: carried(route === 'standalone' ? null : 3) });
			const start = () =>
				route === 'consult' ? consult.start(spawn, observer) : group.start(spawn);
			const pending = start();
			let stop: Promise<unknown> | undefined;
			try {
				if (phase === 'admission') await admissionReady.promise;
				expect(background.activeCount()).toBe(0);
				expect(background.registeredCount()).toBe(1);
				expect(registry.size()).toBe(1);
				const settled = vi.fn();
				const settlement = background.whenSettled((id) => id === spawn.processId).then(settled);
				const owner = groupChatOwner(CHAT_ID);
				if (route === 'consult') expect(consult.stop(spawn.processId)).toBe('');
				else if (route === 'stopAgent') stop = registry.stopAgent(owner);
				else if (route === 'stopTab') stop = registry.stopTab(owner, spawn.processId);
				else if (route === 'interruptTab') stop = registry.interruptTab(owner, spawn.processId);
				else if (route === 'stopAll') stop = registry.stopAll();
				else if (route === 'terminateAllNow') registry.terminateAllNow();
				else group.stop(spawn.processId);
				if (phase === 'admission') {
					await expect(start()).resolves.toMatchObject({
						success: false,
						error: expect.stringMatching(/still settling/),
					});
					expect(settled).not.toHaveBeenCalled();
					expect(issued[0].state()).toBe('issued');
				}
				resumeAdmission.resolve();
				await expect(pending).resolves.toMatchObject({
					success: false,
					error: expect.stringMatching(/cancelled/),
				});
				await stop;
				await settlement;
				expect(provider.calls).toEqual([]);
				expect(reported).toEqual([]);
				expect(observer.onEnd).not.toHaveBeenCalled();
				expect(observer.onSessionId).not.toHaveBeenCalled();
				expect(admissions).toEqual([]);
				expect(registry.size()).toBe(0);
				expect(background.registeredCount()).toBe(0);
				expect(authority.live()).toEqual([]);
				if (phase === 'admission') {
					expect(issued[0].pid()).toBeUndefined();
					expect(issued[0].ended()).toMatchObject({
						state: 'released',
						release: { outcome: 'spawn-failed' },
					});
				}
				// Cancellation owns one attempt only. A later retry is admitted and observed normally.
				await expect(start()).resolves.toMatchObject({ success: true });
				await background.whenSettled(() => true);
				expect(provider.calls).toHaveLength(1);
				if (route === 'consult') expect(observer.onEnd).toHaveBeenCalledOnce();
				else expect(reported.some((line) => line.startsWith('end:'))).toBe(true);
			} finally {
				resumeAdmission.resolve();
				await pending;
			}
		});

		it('honors a stop from the admission notification before binding a process', async () => {
			const authority = authorityOf(() => 'allow');
			const provider = createFakeGroupChatProvider(dir, () => ({ text: 'never' }));
			let issued: ReturnType<typeof authority.live> = [];
			const background = createBackgroundTurns({
				paths: paths(),
				registry,
				host: {},
				beginTurn,
				deps: { runTurn: provider.runTurn },
				managed: {
					port: () => portOf(authority),
					onAdmission: () => {
						issued = authority.live();
						registry.terminateAllNow();
					},
				},
			});
			await expect(background.groupChatRunner(handlers).start(spawnOf())).resolves.toMatchObject({
				success: false,
				error: expect.stringMatching(/cancelled/),
			});
			expect(provider.calls).toEqual([]);
			expect(issued[0].ended()).toMatchObject({
				state: 'released',
				release: { outcome: 'spawn-failed' },
			});
			expect(registry.size()).toBe(0);
		});

		it('drops pending registration when preparation or admission throws', async () => {
			const authority = authorityOf(() => 'allow');
			const { background, provider } = managedTurns(() => ({ text: 'never' }), authority);
			const runner = background.groupChatRunner(handlers);
			await expect(
				runner.start(spawnOf({ sshRemoteConfig: { enabled: true, remoteId: 'gone' } }))
			).rejects.toThrow(/SSH/);
			expect(background.registeredCount()).toBe(0);
			vi.spyOn(authority, 'admit').mockRejectedValueOnce(new Error('authority disconnected'));
			await expect(runner.start(spawnOf())).rejects.toThrow('authority disconnected');
			await background.whenSettled(() => true);
			expect(background.registeredCount()).toBe(0);
			expect(registry.size()).toBe(0);
			expect(provider.calls).toEqual([]);
		});

		it.each(['local', 'ssh'] as const)(
			'carries the bound workflow, grant and current policy through the %s launch plan',
			async (target) => {
				fs.mkdirSync(path.dirname(paths().settingsFile), { recursive: true });
				fs.writeFileSync(
					paths().settingsFile,
					JSON.stringify({
						sshRemotes: [
							{
								id: 'r1',
								name: 'Fixture',
								host: 'build.example.com',
								port: 22,
								username: 'dev',
								privateKeyPath: '',
								enabled: true,
							},
						],
					})
				);
				const authority = authorityOf(() => 'allow');
				const { background, provider } = managedTurns(() => ({ text: 'ok' }), authority);
				const record = carried(7);
				record.workflow = {
					workflowId: 'playbook:nightly',
					version: 'v1',
					triggerEventId: 'timer:1',
					ownerEpoch: 'opaque:epoch',
					fencingToken: 'fence-1',
				};
				record.delegation.grantRef = 'grant-1';
				const bound = { ...record, policyRevision: 3 };
				const started = await background.groupChatRunner(handlers).start(
					spawnOf({
						delegation: record,
						customEnvVars: delegationContextEnv(carried(null)),
						...(target === 'ssh'
							? {
									sshRemoteConfig: { enabled: true, remoteId: 'r1' },
									prompt: 'x'.repeat(5000),
								}
							: {}),
					})
				);
				expect(started.success).toBe(true);
				expect(asked[0].context).toMatchObject(bound);
				expect(asked[0].context.actor).toEqual(actor);
				if (target === 'local') {
					expect(stampedOn(provider.calls[0].spec.env)).toEqual(bound);
				} else {
					expect(provider.calls[0].spec.command).toMatch(/ssh/);
					expect(provider.calls[0].spec.stdin).toContain(
						delegationContextEnv(bound)[MANAGED_DELEGATION_ENV_VAR]
					);
				}
				expect(admissions[0]).toMatchObject({ kind: 'admitted', delegation: bound });
				await vi.waitFor(() => expect(authority.live()).toEqual([]));
			}
		);

		it.each([
			['preparation', 'enrollment-loss'],
			['preparation', 'enrollment-gain'],
			['preparation', 'authority'],
			['preparation', 'policy'],
			['preparation', 'actor'],
			['preparation', 'context-error'],
			['admission', 'enrollment-loss'],
			['admission', 'authority'],
			['admission', 'policy'],
			['admission', 'actor'],
			['admission', 'withdrawal'],
			['admission', 'context-error'],
		])('refuses %s when %s changes, with no child or outstanding lease', async (phase, change) => {
			const authority = authorityOf(() => 'allow');
			let current = portOf(change === 'enrollment-gain' ? null : authority);
			const { background, provider } = managedTurns(
				() => ({ text: 'never' }),
				authority,
				null,
				() => current
			);
			const changeScope = () => {
				if (change === 'enrollment-loss') current = portOf(null);
				else if (change === 'authority') current = portOf(authorityOf(() => 'allow'));
				else if (change === 'policy') current = portOf(authority, actor.id, 4);
				else if (change === 'actor') current = portOf(authority, 'operator:other');
				else if (change === 'withdrawal')
					current = {
						...current,
						context: () => ({ ok: false, code: 'unauthenticated', problems: ['actor withdrawn'] }),
					};
				else if (change === 'context-error')
					current = {
						...current,
						context: () => {
							throw new Error('host disconnected');
						},
					};
				else current = portOf(authority);
			};
			let issued: ReturnType<typeof authority.live> = [];
			if (phase === 'preparation') beginTurn.mockImplementationOnce(changeScope);
			else {
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementationOnce(async (request) => {
					const result = await admit(request);
					issued = authority.live();
					changeScope();
					return result;
				});
			}
			const started = await background.groupChatRunner(handlers).start(spawnOf());
			expect(started).toMatchObject({
				success: false,
				managed: {
					state: change === 'withdrawal' ? 'denied' : 'unavailable',
					code: change === 'withdrawal' ? 'unauthenticated' : 'runtime-unavailable',
				},
			});
			expect(provider.calls).toEqual([]);
			expect(registry.size()).toBe(0);
			expect(reported).toEqual([]);
			expect(asked).toHaveLength(phase === 'preparation' ? 0 : 1);
			expect(admissions).toHaveLength(1);
			expect(admissions[0].kind).toBe('refused');
			expect(authority.live()).toEqual([]);
			if (phase === 'admission')
				expect(issued[0].ended()).toMatchObject({
					state: 'released',
					release: { outcome: 'spawn-failed' },
				});
		});

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
			expect(stampedOn(provider.calls[0].spec.env)).toEqual({ ...turn, policyRevision: 3 });
			expect(admissions).toEqual([
				{
					kind: 'admitted',
					processId: PARTICIPANT,
					delegation: { ...turn, policyRevision: 3 },
					leaseId: 'lease-1',
				},
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

		it('refuses a nested child from an enrolled room on a standalone host', async () => {
			const { background, provider } = managedTurns(
				() => ({ text: 'ok' }),
				authorityOf(() => 'allow')
			);
			expect((await background.groupChatRunner(handlers).start(spawnOf())).success).toBe(true);
			await vi.waitFor(() => expect(background.activeCount()).toBe(0));
			const nested = managedTurns(() => ({ text: 'never' }), null);
			const started = await nested.background.groupChatRunner(handlers).start(
				spawnOf({
					processId: MODERATOR,
					delegation: stampedOn(provider.calls[0].spec.env),
				})
			);
			expect(started).toMatchObject({
				success: false,
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			});
			expect(nested.provider.calls).toEqual([]);
		});

		it('detects an in-place policy source change across preparation', async () => {
			const authority = authorityOf(() => 'allow');
			const source = { id: 'policy-1', kind: 'endpoint' as const, revision: 3 };
			const policy = { sources: [source], policyRevision: 3 };
			const port = { ...portOf(authority), policy: () => policy };
			const { background, provider } = managedTurns(
				() => ({ text: 'never' }),
				authority,
				null,
				() => port
			);
			beginTurn.mockImplementationOnce(() => {
				source.id = 'policy-2';
			});
			expect(await background.groupChatRunner(handlers).start(spawnOf())).toMatchObject({
				success: false,
				managed: { state: 'unavailable' },
			});
			expect(asked).toEqual([]);
			expect(provider.calls).toEqual([]);
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
			expect(stampedOn(provider.calls[0].spec.env)).toEqual({ ...record, policyRevision: 3 });
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
				expect(stampedOn(provider.calls[0].spec.env)).toEqual({ ...record, policyRevision: 3 });
				expect(stampedOn(provider.calls[0].spec.env)).not.toEqual(planted);

				// The same for a room turn: the room's child, never what the spawn's env claimed.
				const runner = background.groupChatRunner(handlers);
				await runner.start(spawnOf({ customEnvVars: delegationContextEnv(planted) }));
				await vi.waitFor(() => expect(background.activeCount()).toBe(0));
				expect(stampedOn(provider.calls[1].spec.env)).toEqual({
					...groupChatTurnContext({ processId: PARTICIPANT }),
					policyRevision: 3,
				});
			});
		});
	});
});
