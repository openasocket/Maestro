/**
 * The runtime's turns: send, queue, stop, and swap-and-back, with a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a real recorded turn, so a
 * turn here is a real process on a real pipe, assembled by the real `assembleTurn` and started by
 * the real `runAgentTurn`; only the command is swapped for the fake agent. The runtime, its
 * repository, its queue, and its records are real and write to a temp data directory.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../../../../__tests__/main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeAgentSpec,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, ManagedApi, TurnEvent } from '../../client/types';
import {
	createLocalHostAuthority,
	type HostAuthority,
	type PolicyDecision,
} from '../../managed/authority';
import {
	createManagedBinding,
	readManagedBindingFile,
	type InstallationStanding,
	type InstallationStandingSource,
} from '../../managed/binding';
import { inProcessContext } from '../../managed/operations';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
	type ManagedOperationEnvelope,
	type ManagedRunIdentity,
	type ManagedSubmitInput,
} from '../../managed/types';
import {
	DispatchRefusedError,
	startTurn,
	turnSinkStanding,
	type StartTurnOptions,
} from '../../run/start-turn';
import { readHistory } from '../../store/read-history';
import { runAgentTurn, type RunAgentTurnOptions } from '../../turns/run-agent-turn';
import { RUNTIME_LOCK_FILE_NAME } from '../data-dir-lock';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import type { WatchDirectory } from '../settings-watch';
import * as runtimeTurns from '../turns';
import { isVerifiedContext } from '../../managed/authority';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

describe('runtime turns', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	/** The recording each provider replays, as a file the fake agent reads. */
	let recordings: Record<string, string>;
	/** Keep the fake agent running after its replay, until it is stopped. */
	let hold: boolean;
	let argvFiles: string[];
	/** The options each turn was started with. */
	let turnOptions: RunAgentTurnOptions[];
	let binaryExists: boolean;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const argvOut = path.join(work, `argv-${argvFiles.length + 1}.json`);
		argvFiles.push(argvOut);
		turnOptions.push(options);
		return runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...turn.launch.args],
					sessionCustomEnvVars: {
						...turn.launch.sessionCustomEnvVars,
						FAKE_AGENT_RECORDING: recordings[turn.provider.id],
						FAKE_AGENT_ARGV_OUT: argvOut,
						FAKE_AGENT_ENV_OUT: argvOut.replace(/argv-(\d+)\.json$/, 'env-$1.json'),
						...(hold ? { FAKE_AGENT_HOLD: '1' } : {}),
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
	};

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			probeBinary: async (binaryName) =>
				binaryExists ? { exists: true, path: `/fake/bin/${binaryName}` } : { exists: false },
			turns: { runAgentTurn: fakeProvider },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		aiTabs: [
			{ id: 't1', agentSessionId: null, name: null, logs: [] },
			{ id: 't2', agentSessionId: null, name: null, logs: [] },
		],
		activeTabId: 't1',
		unifiedTabOrder: [
			{ type: 'ai', id: 't1' },
			{ type: 'ai', id: 't2' },
		],
		...extra,
	});

	async function start(sessions: unknown[] = [seedAgent()]): Promise<MaestroRuntime> {
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	/** Collect a tab's turn events, and let a test wait for the n-th `outcome`. */
	function watch(runtime: MaestroRuntime, tabId = 't1') {
		const events: TurnEvent[] = [];
		const waiting: Array<{ count: number; resolve: () => void }> = [];
		runtime.turns.subscribe('a1', tabId, (event) => {
			events.push(event);
			if (event.kind !== 'outcome') return;
			const outcomes = events.filter((e) => e.kind === 'outcome').length;
			for (const waiter of waiting.filter((w) => w.count <= outcomes)) waiter.resolve();
		});
		return {
			events,
			kinds: () => events.map((event) => event.kind),
			outcomes: () => events.flatMap((event) => (event.kind === 'outcome' ? [event.outcome] : [])),
			outcome: (count = 1) =>
				new Promise<void>((resolve, reject) => {
					if (events.filter((e) => e.kind === 'outcome').length >= count) return resolve();
					const timer = setTimeout(
						() => reject(new Error(`no outcome ${count}; saw ${events.map((e) => e.kind)}`)),
						8_000
					);
					waiting.push({
						count,
						resolve: () => {
							clearTimeout(timer);
							resolve();
						},
					});
				}),
			started: () => saw('started'),
			saw,
		};
		/** Resolves once an event of the kind has been seen. */
		function saw(kind: TurnEvent['kind']): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no ${kind} event`)), 8_000);
				const poll = setInterval(() => {
					if (events.some((event) => event.kind === kind)) {
						clearInterval(poll);
						clearTimeout(timer);
						resolve();
					}
				}, 10);
			});
		}
	}

	const transcript = async (runtime: MaestroRuntime, tabId = 't1') =>
		value(await runtime.tabs.transcript('a1', tabId));
	const tabOf = async (runtime: MaestroRuntime, tabId = 't1') =>
		value(await runtime.tabs.list('a1')).find((tab) => tab.id === tabId)!;
	const sessions = () =>
		JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf-8'));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-turns-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-turns-work-'));
		open = [];
		hold = false;
		argvFiles = [];
		turnOptions = [];
		binaryExists = true;
		recordings = {
			'claude-code': writeFakeTurn(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
			),
			opencode: writeFakeTurn(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
			),
		};
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('send', () => {
		it('runs a turn on an idle agent, streams it to the tab, and ends on the outcome', async () => {
			const runtime = await start();
			const turn = watch(runtime);

			expect(value(await runtime.turns.send('a1', 't1', { text: 'hello' }))).toEqual({
				status: 'started',
			});
			await turn.outcome();

			const kinds = turn.kinds();
			expect(kinds.slice(0, 2)).toEqual(['user', 'started']);
			expect(kinds[kinds.length - 1]).toBe('outcome');
			expect(kinds.filter((kind) => kind === 'outcome')).toHaveLength(1);
			expect(kinds.filter((kind) => kind === 'session')).toHaveLength(1);
			expect(turn.events.find((event) => event.kind === 'session')).toMatchObject({
				providerSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
			expect(turn.outcomes()).toEqual(['completed']);
		});

		it("lets the turn accept claude's folder trust, since it runs in the agent's own cwd (#1872)", async () => {
			const runtime = await start();
			const turn = watch(runtime);

			value(await runtime.turns.send('a1', 't1', { text: 'hello' }));
			await turn.outcome();

			expect(turnOptions[0]?.acceptWorkspaceTrust).toBe(true);
		});

		it('writes the message, the answer, the session id, and the folded usage the desktop will show', async () => {
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'what is the capital of France' }));
			await turn.outcome();

			const entries = await transcript(runtime);
			expect(entries.map((entry) => entry.source)).toEqual(['user', 'stdout']);
			expect(entries[0].text).toBe('what is the capital of France');
			// The answer was said to the client once, and is what the transcript holds.
			const streamed = turn.events.flatMap((event) => (event.kind === 'text' ? [event.text] : []));
			expect(entries[1].text).toBe(streamed.join(''));

			const tab = await tabOf(runtime);
			expect(tab.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(tab.turnProvider).toBe('claude-code');
			expect((tab.usageStats as { outputTokens: number }).outputTokens).toBeGreaterThan(0);

			const history = readHistory(runtime.paths, 'a1');
			if (history.status !== 'ok') throw new Error(`history ${history.status}`);
			expect(history.entries).toHaveLength(1);
			expect(history.entries[0]).toMatchObject({
				type: 'USER',
				sessionId: 'a1',
				tabId: 't1',
				agentSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID,
			});
		});

		it('resumes the tab session on the next send, and does not announce the id it resumed', async () => {
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'one' }));
			await turn.outcome(1);
			value(await runtime.turns.send('a1', 't1', { text: 'two' }));
			await turn.outcome(2);

			const argv = JSON.parse(fs.readFileSync(argvFiles[1], 'utf-8')) as string[];
			expect(argv).toContain('--resume');
			expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(turn.kinds().filter((kind) => kind === 'session')).toHaveLength(1);
			expect((await transcript(runtime)).map((entry) => entry.source)).toEqual([
				'user',
				'stdout',
				'user',
				'stdout',
			]);
		});

		it('refuses what cannot run, and says which', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.turns.send('a1', 't1', { text: '   ' })).code).toBe('invalid');
			expect(
				errorOf(
					await runtime.turns.send('a1', 't1', { text: 'x', images: ['data:image/png;base64,AA'] })
				).code
			).toBe('unsupported');
			expect(errorOf(await runtime.turns.send('nope', 't1', { text: 'x' })).code).toBe('not-found');
			expect(errorOf(await runtime.turns.send('a1', 'nope', { text: 'x' })).code).toBe('not-found');
			expect(argvFiles).toEqual([]);
		});

		it('refuses a lifted agent with a pointer at peer:agentId, and starts nothing', async () => {
			const runtime = await start([
				seedAgent({ liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 } }),
			]);
			const error = errorOf(await runtime.turns.send('a1', 't1', { text: 'hello' }));
			expect(error.code).toBe('rejected');
			expect(error.message).toContain('Send to build-box:host-1 instead.');
			expect(argvFiles).toEqual([]);
		});

		it('answers host-unavailable once the runtime is closed', async () => {
			const runtime = await start();
			await runtime.connection.close();
			expect(errorOf(await runtime.turns.send('a1', 't1', { text: 'x' })).code).toBe(
				'host-unavailable'
			);
		});
	});

	describe('a message that cannot start', () => {
		it('is held in the queue with the reason, never dropped and never written to the transcript', async () => {
			binaryExists = false;
			const runtime = await start();
			const turn = watch(runtime);

			const failure = errorOf(await runtime.turns.send('a1', 't1', { text: 'do the thing' }));
			expect(failure.code).toBe('failed');
			expect(failure.message).toContain('was not found');
			expect(failure.message).toContain('held in the queue');

			const held = value(await runtime.turns.queue.list('a1'));
			expect(held).toEqual([
				expect.objectContaining({ tabId: 't1', text: 'do the thing', paused: true }),
			]);
			expect(turn.events).toEqual([
				expect.objectContaining({
					kind: 'error',
					error: expect.objectContaining({
						message: expect.stringContaining('The message was not sent'),
					}),
				}),
			]);
			expect(await transcript(runtime)).toEqual([]);

			expect(value(await runtime.turns.queue.remove('a1', held[0].itemId))).toEqual({
				removed: true,
			});
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
		});
	});

	describe('the queue and stop', () => {
		it('queues a message for a busy tab, lists it, and runs it when the first turn is stopped', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();

			hold = false;
			const receipt = value(await runtime.turns.send('a1', 't1', { text: 'second' }));
			expect(receipt).toMatchObject({ status: 'queued', position: 1, queueLength: 1 });
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([
				expect.objectContaining({ tabId: 't1', text: 'second', kind: 'message', paused: false }),
			]);

			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: true });
			await turn.outcome(2);

			expect(turn.outcomes()).toEqual(['interrupted', 'completed']);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			const entries = await transcript(runtime);
			expect(entries.filter((entry) => entry.source === 'user').map((entry) => entry.text)).toEqual(
				['first', 'second']
			);
		});

		it('holds a write on another tab while one runs, since the tabs share a working directory', async () => {
			hold = true;
			const runtime = await start();
			const first = watch(runtime, 't1');
			const second = watch(runtime, 't2');
			value(await runtime.turns.send('a1', 't1', { text: 'busy' }));
			await first.started();

			hold = false;
			expect(value(await runtime.turns.send('a1', 't2', { text: 'waits' }))).toMatchObject({
				status: 'queued',
			});
			value(await runtime.turns.interrupt('a1', 't1'));
			await second.outcome();
			expect(second.outcomes()).toEqual(['completed']);
		});

		it('drops a waiting message when it is removed, and reports a missing one as not removed', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'first' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'never sent' }));
			if (queued.status !== 'queued') throw new Error('expected queued');

			expect(value(await runtime.turns.queue.remove('a1', queued.itemId))).toEqual({
				removed: true,
			});
			expect(value(await runtime.turns.queue.remove('a1', queued.itemId))).toEqual({
				removed: false,
			});
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			expect(argvFiles).toHaveLength(1);
		});

		it('says nothing was stopped when the tab is idle', async () => {
			const runtime = await start();
			expect(value(await runtime.turns.interrupt('a1', 't1'))).toEqual({ stopped: false });
			expect(errorOf(await runtime.turns.queue.list('nope')).code).toBe('not-found');
		});

		it('stops a running turn and records it as interrupted when the runtime closes', async () => {
			hold = true;
			const runtime = await start();
			const turn = watch(runtime);
			value(await runtime.turns.send('a1', 't1', { text: 'long job' }));
			await turn.started();

			await runtime.connection.close();

			expect(turn.outcomes()).toEqual(['interrupted']);
			// The message was written before the provider ran, so the close cannot have lost it. (What
			// the agent had said by then depends on how far the replay got.)
			const stored = sessions().sessions[0].aiTabs[0].logs;
			expect(stored[0]).toMatchObject({ source: 'user', text: 'long job' });
		});
	});

	describe('swap and back', () => {
		it('resumes each provider on the conversation it left, with every tab and transcript intact', async () => {
			const runtime = await start();
			const turn = watch(runtime);

			value(await runtime.turns.send('a1', 't1', { text: 'on claude' }));
			await turn.outcome(1);
			expect((await tabOf(runtime)).agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			value(await runtime.agents.update('a1', { provider: 'opencode' }));
			expect((await tabOf(runtime)).agentSessionId).toBeNull();

			value(await runtime.turns.send('a1', 't1', { text: 'on opencode' }));
			await turn.outcome(2);
			const onOpencode = await tabOf(runtime);
			expect(onOpencode.agentSessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
			expect(onOpencode.turnProvider).toBe('opencode');
			expect(
				(onOpencode.providerSessions as Record<string, { agentSessionId: string }>)['claude-code']
					.agentSessionId
			).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			value(await runtime.agents.update('a1', { provider: 'claude-code' }));
			const back = await tabOf(runtime);
			expect(back.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(
				(back.providerSessions as Record<string, { agentSessionId: string }>).opencode
					.agentSessionId
			).toBe(CAPTURED_OPENCODE_SESSION_ID);

			value(await runtime.turns.send('a1', 't1', { text: 'back on claude' }));
			await turn.outcome(3);

			// The third turn resumed the Claude conversation, not the OpenCode one.
			const argv = JSON.parse(fs.readFileSync(argvFiles[2], 'utf-8')) as string[];
			expect(argv).toContain('--resume');
			expect(argv).toContain(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(argv).not.toContain(CAPTURED_OPENCODE_SESSION_ID);

			// Both tabs are still there and the transcript kept every message across both swaps.
			expect(value(await runtime.tabs.list('a1')).map((tab) => tab.id)).toEqual(['t1', 't2']);
			const entries = await transcript(runtime);
			expect(entries.filter((entry) => entry.source === 'user').map((entry) => entry.text)).toEqual(
				['on claude', 'on opencode', 'back on claude']
			);
			expect(entries.filter((entry) => entry.source === 'stdout')).toHaveLength(3);
		});
	});

	describe('managed runs', () => {
		const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

		function managedAuthority(decision: PolicyDecision = { decision: 'allow', policyRevision: 1 }) {
			let ids = 0;
			return createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: () => decision,
				now: () => Date.now(),
				newId: () => `lease-${++ids}`,
				leaseTtlMs: 60_000,
			});
		}

		/** The argv files the fake agent actually wrote: one per process that ran. */
		const ran = () => argvFiles.filter((file) => fs.existsSync(file));
		/** The environment the n-th started process actually ran with, once the fake agent wrote it. */
		async function envOf(nth: number): Promise<Record<string, string>> {
			const file = argvFiles[nth].replace(/argv-(\d+)\.json$/, 'env-$1.json');
			await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
			return JSON.parse(fs.readFileSync(file, 'utf-8'));
		}
		/** The caller credential the n-th process was stamped with. */
		async function credentialOf(nth: number): Promise<string> {
			const credential = (await envOf(nth))[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR];
			expect(typeof credential).toBe('string');
			return credential;
		}

		async function startManaged(
			authority: HostAuthority | null = managedAuthority(),
			extra: Partial<RuntimeDeps> = {},
			standing?: InstallationStandingSource
		) {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions: [seedAgent()], activeSessionId: 'a1' }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: { ...deps(), ...extra },
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
				...(authority || standing
					? {
							managed: {
								...(authority ? { authority } : {}),
								...(standing ? { standing } : {}),
							},
						}
					: {}),
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			open.push(started.runtime);
			return started.runtime;
		}

		function envelope<T>(
			runtime: MaestroRuntime,
			input: T,
			overrides: Omit<Partial<ManagedOperationContext>, 'identity'> & {
				identity?: Partial<ManagedRunIdentity>;
			} = {}
		): ManagedOperationEnvelope<T> {
			const { identity, ...rest } = overrides;
			return {
				context: inProcessContext({
					installation: runtime.installation,
					actor: { kind: 'service', id: 'fleet' },
					delegation: { chain: [], grantRef: null },
					identity: {
						requestId: 'req-1',
						idempotencyKey: 'key-1',
						attemptId: 'attempt-1',
						runId: null,
						rootRunId: null,
						parentRunId: null,
						...identity,
					},
					policyRevision: 1,
					workflow: null,
					traceId: 'trace-1',
					requestedCapabilities: [
						'runs.submit',
						'runs.inspect',
						'runs.cancel',
						'runs.interrupt',
						'runs.list',
						'agents.list',
						'capabilities.negotiate',
					],
					...rest,
				}),
				input,
			};
		}

		const submission = (text: string): ManagedSubmitInput => ({
			agentId: 'a1',
			tabId: 't1',
			providerId: 'claude-code',
			modelId: null,
			content: { text, sha256: sha(text) },
			resourceIds: [],
		});

		function managedOf(runtime: MaestroRuntime): ManagedApi {
			if (!runtime.managed) throw new Error('no managed facade');
			return runtime.managed;
		}

		const journalFile = () => path.join(dir, 'maestro-managed-runs.json');
		const journalRuns = () =>
			JSON.parse(fs.readFileSync(journalFile(), 'utf-8')).runs as Array<{
				runId: string;
				state: string;
				attempts: Array<{
					phase: string;
					pid: number | null;
					leaseId: string | null;
					outcome: string | null;
					detail: string | null;
				}>;
				cancellation: { owner: { id: string } } | null;
			}>;

		it('runs an admitted submission to completion: receipt, journal, transcript and the real process agree', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const turn = watch(runtime);

			const result = value(await managed.submit(envelope(runtime, submission('managed hello'))));
			expect(result).toMatchObject({
				status: 'ok',
				requestId: 'req-1',
				value: { disposition: 'accepted', run: { agentId: 'a1', attemptId: 'attempt-1' } },
			});
			if (result.status !== 'ok') return;
			const runId = result.value.run.runId;
			await turn.outcome();
			expect(turn.outcomes()).toEqual(['completed']);

			const inspected = value(await managed.inspect(envelope(runtime, { runId })));
			expect(inspected).toMatchObject({
				status: 'ok',
				value: { runId, state: 'completed', providerSessionId: CAPTURED_CLAUDE_CODE_SESSION_ID },
			});
			const [run] = journalRuns();
			expect(run).toMatchObject({ runId, state: 'completed' });
			expect(run.attempts).toEqual([
				expect.objectContaining({ phase: 'terminal', outcome: 'completed', leaseId: 'lease-1' }),
			]);
			expect(run.attempts[0].pid).toBeGreaterThan(0);
			expect((await transcript(runtime)).map((entry) => entry.text)[0]).toBe('managed hello');
			expect(argvFiles).toHaveLength(1);

			const listed = value(await managed.runs(envelope(runtime, { cursor: null, limit: 5 })));
			expect(listed).toMatchObject({
				status: 'ok',
				value: { items: [{ runId }], nextCursor: null },
			});
		});

		it('denies with zero effect: no process, no transcript, no queue item, a failed attempt in the journal', async () => {
			const runtime = await startManaged(
				managedAuthority({
					decision: 'deny',
					reason: 'agent a1 is not allowlisted',
					policyRevision: 2,
				})
			);
			const managed = managedOf(runtime);
			const turn = watch(runtime);

			const result = value(await managed.submit(envelope(runtime, submission('forbidden'))));
			expect(result).toMatchObject({
				status: 'denied',
				code: 'policy-denied',
				message: expect.stringContaining('not allowlisted'),
			});
			expect(ran()).toEqual([]);
			expect(await transcript(runtime)).toEqual([]);
			expect(turn.events.filter((event) => event.kind === 'started')).toEqual([]);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect(journalRuns()[0]).toMatchObject({
				state: 'failed',
				attempts: [
					{
						phase: 'terminal',
						outcome: 'failed',
						detail: expect.stringContaining('managed-denied'),
					},
				],
			});
			// Standalone sends on the same runtime still work: the denial governs managed runs only.
			value(await runtime.turns.send('a1', 't1', { text: 'plain' }));
			await turn.outcome();
			expect(ran()).toHaveLength(1);
		});

		it('refuses a forged or stale context before any policy or process is reached', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const otherInstallation = envelope(runtime, submission('x'), {
				installation: { installationId: 'someone-else', runtimeId: 'r', processEpoch: 'e' },
			});
			expect(value(await managed.submit(otherInstallation))).toMatchObject({
				status: 'denied',
				code: 'unauthenticated',
			});
			const malformed = envelope(runtime, submission('x'), { traceId: '' });
			expect(value(await managed.submit(malformed))).toMatchObject({
				status: 'denied',
				code: 'invalid-input',
			});
			const unrequested = envelope(runtime, submission('x'), {
				requestedCapabilities: ['runs.inspect'],
			});
			expect(value(await managed.submit(unrequested))).toMatchObject({
				status: 'denied',
				code: 'capability-unsupported',
			});
			const wrongDigest = envelope(runtime, {
				...submission('x'),
				content: { text: 'x', sha256: sha('y') },
			});
			expect(value(await managed.submit(wrongDigest))).toMatchObject({
				status: 'denied',
				code: 'invalid-input',
			});
			const unknownResource = envelope(runtime, { ...submission('x'), resourceIds: ['res-1'] });
			expect(value(await managed.submit(unknownResource))).toMatchObject({
				status: 'denied',
				code: 'policy-denied',
				message: expect.stringContaining('res-1'),
			});
			expect(argvFiles).toEqual([]);
			expect(fs.existsSync(journalFile())).toBe(true);
			expect(journalRuns()).toEqual([]);
		});

		it('refuses a lease the sink finds expired, as a denial with the reason', async () => {
			let ids = 0;
			const expiring = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: () => ({ decision: 'allow', policyRevision: 1 }),
				now: () => Date.now(),
				newId: () => `lease-${++ids}`,
				leaseTtlMs: -1,
			});
			const runtime = await startManaged(expiring);
			const result = value(await managedOf(runtime).submit(envelope(runtime, submission('late'))));
			expect(result).toMatchObject({
				status: 'denied',
				code: 'policy-denied',
				message: expect.stringContaining('expired'),
			});
			expect(ran()).toEqual([]);
			expect(journalRuns()[0]).toMatchObject({ state: 'failed' });
		});

		it('stops the running process when its lease is revoked, and journals the cancellation', async () => {
			hold = true;
			const authority = managedAuthority();
			const runtime = await startManaged(authority);
			const managed = managedOf(runtime);
			const turn = watch(runtime);
			const result = value(await managed.submit(envelope(runtime, submission('long job'))));
			if (result.status !== 'ok') throw new Error(result.status);
			await turn.started();
			expect(journalRuns()[0]).toMatchObject({
				state: 'running',
				attempts: [{ phase: 'dispatched' }],
			});

			expect(authority.revokeAll('policy revision 2')).toBe(1);
			await turn.outcome();
			expect(turn.outcomes()).toEqual(['interrupted']);
			expect(journalRuns()[0]).toMatchObject({
				state: 'cancelled',
				attempts: [{ phase: 'terminal', outcome: 'cancelled' }],
			});
			expect(
				value(await managed.inspect(envelope(runtime, { runId: result.value.run.runId })))
			).toMatchObject({
				status: 'ok',
				value: { state: 'cancelled' },
			});
		});

		it('replays the same idempotency key without running twice, and refuses a different payload', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const turn = watch(runtime);
			const first = value(await managed.submit(envelope(runtime, submission('once'))));
			if (first.status !== 'ok') throw new Error(first.status);
			await turn.outcome();

			const again = value(
				await managed.submit(
					envelope(runtime, submission('once'), { identity: { requestId: 'req-2' } })
				)
			);
			expect(again).toMatchObject({
				status: 'ok',
				requestId: 'req-2',
				value: { disposition: 'replayed', run: { runId: first.value.run.runId } },
			});
			expect(value(await managed.submit(envelope(runtime, submission('twice'))))).toMatchObject({
				status: 'denied',
				code: 'idempotency-conflict',
			});
			expect(argvFiles).toHaveLength(1);
		});

		it('answers unknown after a restart lost an attempt mid-dispatch, and never resends it', async () => {
			// What a crashed host leaves behind: an attempt dispatched, no end recorded.
			fs.writeFileSync(
				journalFile(),
				JSON.stringify({
					maestroSchemaVersion: 1,
					runs: [
						{
							runId: 'run-crashed',
							rootRunId: 'run-crashed',
							parentRunId: null,
							idempotencyKey: 'key-1',
							agentId: 'a1',
							tabId: 't1',
							providerId: 'claude-code',
							providerSessionId: null,
							contentSha256: sha('lost'),
							resourceIds: [],
							actor: { kind: 'service', id: 'fleet' },
							traceId: 'trace-0',
							submittedAt: '2026-10-21T00:00:00.000Z',
							state: 'running',
							attempts: [
								{
									attemptId: 'attempt-0',
									requestId: 'req-0',
									queuedAt: '2026-10-21T00:00:00.000Z',
									phase: 'dispatched',
									dispatchedAt: '2026-10-21T00:00:01.000Z',
									pid: 999999,
									leaseId: 'lease-0',
									endedAt: null,
									outcome: null,
									detail: null,
								},
							],
							cancellation: null,
						},
					],
				})
			);
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			expect(
				value(await managed.inspect(envelope(runtime, { runId: 'run-crashed' })))
			).toMatchObject({
				status: 'ok',
				value: { state: 'unknown' },
			});
			expect(value(await managed.submit(envelope(runtime, submission('lost'))))).toMatchObject({
				status: 'unknown',
				code: 'outcome-unknown',
			});
			expect(
				value(await managed.cancel(envelope(runtime, { runId: 'run-crashed' })))
			).toMatchObject({
				status: 'ok',
				value: { outcome: 'unknown' },
			});
			expect(argvFiles).toEqual([]);
			expect(runtime.managedRuns?.get('run-crashed')?.attempts[0]).toMatchObject({
				phase: 'unknown',
				detail: expect.stringContaining('restarted'),
			});
		});

		it('cancels a queued run before dispatch and interrupts a running one, with the first owner kept', async () => {
			hold = true;
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const turn = watch(runtime);
			const running = value(await managed.submit(envelope(runtime, submission('first'))));
			if (running.status !== 'ok') throw new Error(running.status);
			await turn.started();
			hold = false;
			const queued = value(
				await managed.submit(
					envelope(runtime, submission('second'), {
						identity: { requestId: 'req-2', idempotencyKey: 'key-2', attemptId: 'attempt-2' },
					})
				)
			);
			if (queued.status !== 'ok') throw new Error(queued.status);
			expect(queued.value.run.state).toBe('queued');

			expect(
				value(await managed.cancel(envelope(runtime, { runId: queued.value.run.runId })))
			).toMatchObject({
				status: 'ok',
				value: { outcome: 'requested' },
			});
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect(journalRuns().find((run) => run.runId === queued.value.run.runId)).toMatchObject({
				state: 'cancelled',
				cancellation: { owner: { id: 'fleet' } },
			});

			const interrupt = envelope(
				runtime,
				{ runId: running.value.run.runId },
				{ actor: { kind: 'human', id: 'operator' } }
			);
			expect(value(await managed.interrupt(interrupt))).toMatchObject({
				status: 'ok',
				value: { outcome: 'requested' },
			});
			await turn.outcome();
			expect(turn.outcomes()).toEqual(['interrupted']);
			expect(journalRuns().find((run) => run.runId === running.value.run.runId)).toMatchObject({
				state: 'cancelled',
				cancellation: { owner: { id: 'operator' } },
			});
			expect(
				value(await managed.cancel(envelope(runtime, { runId: running.value.run.runId })))
			).toMatchObject({
				status: 'ok',
				value: { outcome: 'already-terminal' },
			});
			expect(value(await managed.inspect(envelope(runtime, { runId: 'nope' })))).toMatchObject({
				status: 'denied',
				code: 'not-found',
			});
		});

		it('answers unavailable, not standalone, when enrolled with no reachable authority', async () => {
			const authority = managedAuthority();
			const enroller = await startManaged(authority);
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => T0,
			});
			expect(
				(
					await binding.enroll({
						installationId: enroller.installation.installationId,
						authorityId: 'fleet-authority',
						endpointRef: 'ep',
						policySources: [],
						policyRevision: 1,
					})
				).ok
			).toBe(true);
			await enroller.connection.close();

			const orphan = await startManaged(null);
			expect(orphan.managedBinding.state()).toMatchObject({ state: 'enrolled-unavailable' });
			const result = value(
				await managedOf(orphan).submit(envelope(orphan, submission('nobody answers')))
			);
			expect(result).toMatchObject({ status: 'unavailable', code: 'runtime-unavailable' });
			expect(ran()).toEqual([]);
			expect(journalRuns()[0]).toMatchObject({
				state: 'failed',
				attempts: [{ detail: expect.stringContaining('managed-unavailable') }],
			});
			const identity = value(await managedOf(orphan).identity(envelope(orphan, {})));
			expect(identity).toMatchObject({
				status: 'ok',
				value: { binding: 'enrolled-unavailable', authorityId: null },
			});
			// A plain send on an enrolled binding nothing answers for is refused before the queue, not
			// run standalone (MRC3-01-01): no process, no queue item, and nothing more in the journal.
			const plain = errorOf(await orphan.turns.send('a1', 't1', { text: 'plain' }));
			expect(plain.code).toBe('rejected');
			expect(plain.message).toContain('[managed-unavailable]');
			expect(plain.message).toContain('no authority answers');
			expect(ran()).toEqual([]);
			expect(value(await orphan.turns.queue.list('a1'))).toEqual([]);
			expect(journalRuns()).toHaveLength(1);
		});

		it('drops, never starts, a message queued without a dispatch once the binding is enrolled (MRC3-01-02)', async () => {
			const authority = managedAuthority();
			const runtime = await startManaged(authority);
			const turn = watch(runtime);
			hold = true;
			value(await runtime.turns.send('a1', 't1', { text: 'before enrollment' }));
			await turn.started();
			hold = false;
			// Queued behind the running turn on a standalone binding: no dispatch was minted for it.
			expect(value(await runtime.turns.send('a1', 't1', { text: 'waiting' }))).toMatchObject({
				status: 'queued',
				position: 1,
			});
			expect(journalRuns()).toEqual([]);

			// The enrollment lands while the message waits, and the runtime reads it.
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => T0,
			});
			expect(
				(
					await binding.enroll({
						installationId: runtime.installation.installationId,
						authorityId: 'fleet-authority',
						endpointRef: 'ep',
						policySources: [],
						policyRevision: 1,
					})
				).ok
			).toBe(true);
			expect(runtime.managedBinding.reload()).toMatchObject({ state: 'enrolled' });

			// The running turn ends and the queue reaches the waiting item: refused at the dequeue,
			// dropped, no process, nothing journaled (no attempt exists to record).
			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			await turn.saw('error');
			const refusal = turn.events.find((event) => event.kind === 'error');
			expect(refusal).toMatchObject({
				kind: 'error',
				error: { message: expect.stringContaining('dropped from the queue') },
			});
			expect(refusal && refusal.kind === 'error' ? refusal.error.message : '').toContain(
				'carries no managed dispatch'
			);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			// The provider layer was asked once, for the turn that ran; never for the dropped item.
			expect(argvFiles).toHaveLength(1);
			expect(journalRuns()).toEqual([]);
			expect(turn.events.filter((event) => event.kind === 'started')).toHaveLength(1);

			// A message sent now is minted its dispatch at the queue (MRC3-01-01) and runs admitted.
			value(await runtime.turns.send('a1', 't1', { text: 'after enrollment' }));
			await turn.outcome(2);
			expect(turn.outcomes()).toEqual(['interrupted', 'completed']);
			expect(argvFiles).toHaveLength(2);
			expect(journalRuns()).toHaveLength(1);
			expect(journalRuns()[0]).toMatchObject({
				state: 'completed',
				attempts: [expect.objectContaining({ phase: 'terminal', leaseId: 'lease-1' })],
			});
		});

		it('refuses a managed send on a runtime that lost its data directory, before anything is queued or spawned (MRC-08-05)', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const turn = watch(runtime);
			// Another process took the lock: this runtime is no longer the directory's writer.
			fs.writeFileSync(
				path.join(dir, RUNTIME_LOCK_FILE_NAME),
				JSON.stringify({
					pid: 200,
					mode: 'host',
					startedAt: new Date(T0).toISOString(),
					heartbeatAt: new Date(T0).toISOString(),
					bootTime: T0 - 3_600_000,
				})
			);
			const result = value(await managed.submit(envelope(runtime, submission('after takeover'))));
			expect(result).toMatchObject({
				status: 'unavailable',
				code: 'runtime-unavailable',
				message: expect.stringContaining('no longer owns its data directory'),
			});
			expect(ran()).toEqual([]);
			expect(turn.events.filter((event) => event.kind === 'started')).toEqual([]);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect(journalRuns()[0]).toMatchObject({
				state: 'failed',
				attempts: [
					{
						phase: 'terminal',
						outcome: 'failed',
						detail: expect.stringContaining('managed-unavailable'),
					},
				],
			});
		});

		it('stops a process a replaced provider launch started for a managed turn without a lease, and journals it (MRC-08-05)', async () => {
			// A host that swapped the provider launch for one that skips admission: the turn service
			// sees a process and no lease, and does not let it run as a managed turn.
			const unadmitted: RuntimeDeps['turns']['runAgentTurn'] = (turn, { managed: _, ...rest }) =>
				fakeProvider(turn, rest);
			const runtime = await startManaged(managedAuthority(), {
				turns: { runAgentTurn: unadmitted },
			});
			const managed = managedOf(runtime);
			const turn = watch(runtime);
			const result = value(await managed.submit(envelope(runtime, submission('unadmitted'))));
			expect(result).toMatchObject({
				status: 'unavailable',
				code: 'runtime-unavailable',
				message: expect.stringContaining('without a lease'),
			});
			expect(turn.events.filter((event) => event.kind === 'started')).toEqual([]);
			expect(await transcript(runtime)).toEqual([]);
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			expect(journalRuns()[0]).toMatchObject({
				state: 'failed',
				attempts: [
					{
						phase: 'terminal',
						outcome: 'failed',
						detail: expect.stringContaining('without a lease'),
					},
				],
			});
			expect(runtime.turnsInFlight()).toBe(0);
		});

		/** Enroll the data directory on disk the way the desktop would, for `fleet-authority`. */
		async function enrollDir(installationId: string, authority: HostAuthority) {
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => T0,
			});
			const enrolled = await binding.enroll({
				installationId,
				authorityId: 'fleet-authority',
				endpointRef: 'ep',
				policySources: [],
				policyRevision: 1,
			});
			if (!enrolled.ok) throw new Error(`enroll failed: ${enrolled.message}`);
		}

		describe('live source custody', () => {
			let capture: ReturnType<typeof vi.fn<typeof runtimeTurns.createRuntimeTurns>>;
			beforeEach(() => {
				hold = true;
				capture = vi.spyOn(runtimeTurns, 'createRuntimeTurns');
			});
			afterEach(() => vi.restoreAllMocks());

			it.each([false, true])(
				'returns the authenticated live source with readOnly=%s',
				async (readOnly) => {
					const authority = managedAuthority();
					const runtime = await startManaged(authority);
					await enrollDir(runtime.installation.installationId, authority);
					runtime.managedBinding.reload();
					const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
					expect(service.sourceCustody('a1', 't1')).toBeNull();
					const events = watch(runtime);
					value(await runtime.tabs.update('a1', 't1', { readOnly }));
					value(await runtime.turns.send('a1', 't1', { text: 'source' }));
					await vi.waitFor(() => expect(ran()).toHaveLength(1));
					const custody = service.sourceCustody('a1', 't1');
					expect(custody).toEqual({
						context: turnOptions[0].managed!.context,
						writable: !readOnly,
					});
					expect(isVerifiedContext(custody!.context)).toBe(true);
					expect(service.sourceCustody('a1', 't2')).toBeNull();
					expect(service.sourceCustody('other', 't1')).toBeNull();
					value(await runtime.tabs.update('a1', 't1', { readOnly: !readOnly }));
					value(await runtime.turns.send('a1', 't1', { text: 'queued' }));
					expect(service.sourceCustody('a1', 't1')).toEqual(custody);
					for (const item of value(await runtime.turns.queue.list('a1'))) {
						value(await runtime.turns.queue.remove('a1', item.itemId));
					}
					const stopped = runtime.turns.interrupt('a1', 't1');
					expect(service.sourceCustody('a1', 't1')).toBeNull();
					await stopped;
					await events.outcome();
					value(await runtime.turns.send('a1', 't1', { text: 'fresh' }));
					expect(service.sourceCustody('a1', 't1')!.context.identity.attemptId).not.toBe(
						custody!.context.identity.attemptId
					);
				}
			);

			it.each([
				'revoked',
				'released',
				'missing-lease',
				'wrong-pid',
				'authority',
				'policy',
				'policy-source',
				'unavailable',
				'standalone',
				'unreadable',
				'context',
				'fence',
				'disposed',
			])('withholds source custody after %s', async (change) => {
				const authority = managedAuthority();
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				const options = capture.mock.calls[0][0];
				value(await runtime.turns.send('a1', 't1', { text: 'source' }));
				const custody = service.sourceCustody('a1', 't1');
				expect(custody).not.toBeNull();
				const credential = await credentialOf(0);
				expect(service.callerSource(credential)).toEqual({ agentId: 'a1', tabId: 't1' });
				const lease = authority.live()[0];
				const port = options.standing.port();
				switch (change) {
					case 'revoked':
						authority.revoke(lease.leaseId, 'withdrawn');
						break;
					case 'released':
						lease.release({ outcome: 'stopped', by: 'authority' });
						break;
					case 'missing-lease':
						vi.spyOn(authority, 'live').mockReturnValue([]);
						break;
					case 'wrong-pid':
						vi.spyOn(lease, 'pid').mockReturnValue(-1);
						break;
					case 'authority':
						vi.spyOn(options.standing, 'port').mockReturnValue({
							...port,
							authority: { ...authority },
						});
						break;
					case 'policy':
						vi.spyOn(options.standing, 'port').mockReturnValue({
							...port,
							policy: () => ({ ...port.policy(), policyRevision: 2 }),
						});
						break;
					case 'policy-source':
						vi.spyOn(options.standing, 'port').mockReturnValue({
							...port,
							policy: () => ({
								...port.policy(),
								sources: [{ id: 'replacement', kind: 'local', revision: 1 }],
							}),
						});
						break;
					case 'unavailable':
						vi.spyOn(options.standing, 'port').mockReturnValue({
							...port,
							unavailableReason: 'offline',
						});
						break;
					case 'standalone':
						vi.spyOn(options.standing, 'port').mockReturnValue({
							...port,
							standing: () => 'standalone',
						});
						break;
					case 'unreadable':
						vi.spyOn(options.standing, 'port').mockImplementation(() => {
							throw new Error('custody unreadable');
						});
						break;
					case 'context':
						custody!.context.identity.rootRunId = 'changed';
						break;
					case 'fence':
						vi.spyOn(options, 'fence').mockReturnValue({
							ok: false,
							reason: 'lock-lost',
						});
						break;
					case 'disposed':
						service.dispose();
						break;
				}
				expect(service.sourceCustody('a1', 't1')).toBeNull();
				// The credential authenticates nobody once its process's custody is withheld.
				expect(service.callerSource(credential)).toBeNull();
			});

			it('retains the verified peer actor and complete workflow lineage', async () => {
				const authority = managedAuthority();
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				const request = envelope(runtime, submission('delegated source'), {
					workflow: {
						workflowId: 'nightly',
						version: 'v1',
						triggerEventId: 'cue:1',
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
					},
					delegation: { chain: [{ kind: 'agent', id: 'parent' }], grantRef: 'grant-1' },
					identity: { runId: 'run-source', rootRunId: 'root', parentRunId: 'parent' },
				});
				expect(value(await managedOf(runtime).submit(request))).toMatchObject({
					status: 'ok',
					value: { disposition: 'accepted', run: { agentId: 'a1', attemptId: 'attempt-1' } },
				});
				const custody = service.sourceCustody('a1', 't1');
				expect(custody!.context).toBe(turnOptions[0].managed!.context);
				expect(custody!.context).toMatchObject(request.context);
				expect(isVerifiedContext(custody!.context)).toBe(true);
			});

			it('keeps concurrent read-only source tabs isolated', async () => {
				const authority = managedAuthority();
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				for (const tab of ['t1', 't2']) {
					value(await runtime.tabs.update('a1', tab, { readOnly: true }));
					expect(value(await runtime.turns.send('a1', tab, { text: tab })).status).toBe('started');
				}
				const first = service.sourceCustody('a1', 't1');
				const second = service.sourceCustody('a1', 't2');
				expect(first!.context.identity.attemptId).not.toBe(second!.context.identity.attemptId);
				value(await runtime.turns.interrupt('a1', 't1'));
				expect(service.sourceCustody('a1', 't1')).toBeNull();
				expect(service.sourceCustody('a1', 't2')).toEqual(second);
			});

			it('records no source for a refused admission', async () => {
				const authority = managedAuthority({ decision: 'deny', reason: 'held', policyRevision: 1 });
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				expect(errorOf(await runtime.turns.send('a1', 't1', { text: 'held' })).code).toBe('failed');
				expect(service.sourceCustody('a1', 't1')).toBeNull();
				expect(ran()).toHaveLength(0);
			});

			it('exposes no pending admission, then removes custody when the real process exits', async () => {
				hold = false;
				const authority = managedAuthority();
				const admit = authority.admit.bind(authority);
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					await gate;
					return admit(request);
				});
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				const events = watch(runtime);
				const sent = runtime.turns.send('a1', 't1', { text: 'source' });
				await vi.waitFor(() => expect(authority.admit).toHaveBeenCalled());
				try {
					expect(service.sourceCustody('a1', 't1')).toBeNull();
				} finally {
					release();
				}
				value(await sent);
				await events.outcome();
				expect(service.sourceCustody('a1', 't1')).toBeNull();
			});

			it('stamps each admitted process with its own caller credential, valid only while it holds custody (MCOMP-17-03AI)', async () => {
				const authority = managedAuthority();
				const runtime = await startManaged(authority);
				await enrollDir(runtime.installation.installationId, authority);
				runtime.managedBinding.reload();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				// Read-only tabs run side by side, as in the isolation case above.
				for (const tab of ['t1', 't2']) {
					value(await runtime.tabs.update('a1', tab, { readOnly: true }));
					expect(value(await runtime.turns.send('a1', tab, { text: tab })).status).toBe('started');
				}
				const first = await credentialOf(0);
				const second = await credentialOf(1);
				expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
				expect(second).not.toBe(first);
				// The credential, not a stated id, names the source: each maps to its own tab only.
				expect(service.callerSource(first)).toEqual({ agentId: 'a1', tabId: 't1' });
				expect(service.callerSource(second)).toEqual({ agentId: 'a1', tabId: 't2' });
				for (const forged of ['', 'a1', 't1', first.slice(1), `${first} `, first.toUpperCase()]) {
					expect(service.callerSource(forged)).toBeNull();
				}
				expect(service.callerSource(undefined as unknown as string)).toBeNull();
				// Stopping one process withdraws its credential and leaves the other tab's alone.
				const stopped = runtime.turns.interrupt('a1', 't1');
				expect(service.callerSource(first)).toBeNull();
				await stopped;
				expect(service.callerSource(second)).toEqual({ agentId: 'a1', tabId: 't2' });
				// A fresh turn on the same tab gets a fresh credential; the old one stays dead.
				value(await runtime.turns.send('a1', 't1', { text: 'fresh' }));
				await vi.waitFor(() => expect(ran()).toHaveLength(3));
				const fresh = await credentialOf(2);
				expect(fresh).not.toBe(first);
				expect(service.callerSource(fresh)).toEqual({ agentId: 'a1', tabId: 't1' });
				expect(service.callerSource(first)).toBeNull();
			});

			it('replaces an inherited caller credential and never honors it (MCOMP-17-03AI)', async () => {
				const inherited = process.env[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR];
				process.env[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR] = 'inherited-forgery';
				try {
					const authority = managedAuthority();
					const runtime = await startManaged(authority);
					await enrollDir(runtime.installation.installationId, authority);
					runtime.managedBinding.reload();
					const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
					value(await runtime.turns.send('a1', 't1', { text: 'source' }));
					const credential = await credentialOf(0);
					expect(credential).not.toBe('inherited-forgery');
					expect(service.callerSource('inherited-forgery')).toBeNull();
					expect(service.callerSource(credential)).toEqual({ agentId: 'a1', tabId: 't1' });
				} finally {
					if (inherited === undefined) delete process.env[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR];
					else process.env[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR] = inherited;
				}
			});

			it('stamps no caller credential on a standalone process (MCOMP-17-03AI)', async () => {
				const runtime = await start();
				value(await runtime.turns.send('a1', 't1', { text: 'plain' }));
				await vi.waitFor(() => expect(ran()).toHaveLength(1));
				const env = await envOf(0);
				expect(env[runtimeTurns.CALLER_CREDENTIAL_ENV_VAR]).toBeUndefined();
				expect(env.MAESTRO_CALLER_AGENT_ID).toBe('a1');
			});

			it('never derives source custody from a standalone process', async () => {
				const runtime = await start();
				const service = capture.mock.results[0].value as runtimeTurns.RuntimeTurns;
				value(await runtime.turns.send('a1', 't1', { text: 'plain' }));
				await vi.waitFor(() => expect(ran()).toHaveLength(1));
				expect(service.sourceCustody('a1', 't1')).toBeNull();
			});
		});

		let bare = 0;
		function bareTurn() {
			const argvOut = path.join(work, `bare-${++bare}.json`);
			const spec = fakeAgentSpec(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal']),
				{ argvOut }
			);
			return {
				argvOut,
				run: (options: Partial<StartTurnOptions> = {}) =>
					startTurn(spec, {}, { stopGraceMs: 200, ...options }),
			};
		}
		/** A bare `startTurn` nobody admitted is refused before a child exists: no argv file, even later. */
		async function expectNoChild(argvOut: string) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(fs.existsSync(argvOut)).toBe(false);
		}

		const runDetails = () => JSON.stringify(journalRuns());

		it('journals a managed item withdrawn by a queue edit or a closed tab as cancelled, with nothing spawned (MCOMP-09-01)', async () => {
			const authority = managedAuthority();
			const runtime = await startManaged(authority);
			await enrollDir(runtime.installation.installationId, authority);
			expect(runtime.managedBinding.reload()).toMatchObject({ state: 'enrolled' });
			const turn = watch(runtime);
			hold = true;
			value(await runtime.turns.send('a1', 't1', { text: 'running' }));
			await turn.started();
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'removed by a client' }));
			if (queued.status !== 'queued') throw new Error('expected queued');
			// A write on another tab waits too: the tabs share a working directory.
			const other = value(await runtime.turns.send('a1', 't2', { text: 'its tab is closed' }));
			expect(other.status).toBe('queued');

			expect(value(await runtime.turns.queue.remove('a1', queued.itemId))).toEqual({
				removed: true,
			});
			value(await runtime.tabs.close('a1', 't2'));
			await vi.waitFor(() =>
				expect(journalRuns().filter((run) => run.state === 'cancelled')).toHaveLength(2)
			);
			expect(runDetails()).toContain(
				'Removed from the queue by a client before it was dispatched.'
			);
			expect(runDetails()).toContain('The tab was closed before it was dispatched.');
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);

			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			expect(argvFiles).toHaveLength(1);
		});

		it('drops a managed item at the dequeue when its agent switched provider while it waited (MCOMP-09-01)', async () => {
			const authority = managedAuthority();
			const runtime = await startManaged(authority);
			await enrollDir(runtime.installation.installationId, authority);
			runtime.managedBinding.reload();
			const turn = watch(runtime);
			hold = true;
			value(await runtime.turns.send('a1', 't1', { text: 'running' }));
			await turn.started();
			hold = false;
			const queued = value(await runtime.turns.send('a1', 't1', { text: 'admitted on claude' }));
			expect(queued.status).toBe('queued');
			value(await runtime.agents.update('a1', { provider: 'opencode' }));

			value(await runtime.turns.interrupt('a1', 't1'));
			await turn.outcome();
			await turn.saw('error');
			expect(JSON.stringify(turn.events)).toContain('dropped from the queue');
			expect(runDetails()).toContain('admitted for provider claude-code');
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			// The provider layer was asked once, for the turn before the switch; never for the dropped item.
			expect(argvFiles).toHaveLength(1);
		});

		it('installs the host standing at the spawn sink: an omitted or forged admission spawns nothing while enrolled, a standalone runtime runs a bare turn (MCOMP-09-02/02A)', async () => {
			// The explicit standalone positive regression.
			const authority = managedAuthority();
			const plain = await startManaged(authority);
			expect(turnSinkStanding()!.standing()).toBe('standalone');
			const allowed = bareTurn();
			expect((await allowed.run().done).exitCode).toBe(0);
			expect(fs.existsSync(allowed.argvOut)).toBe(true);

			// The enrollment lands; the sink reads it on the next call.
			await enrollDir(plain.installation.installationId, authority);
			expect(plain.managedBinding.reload()).toMatchObject({ state: 'enrolled' });
			expect(turnSinkStanding()!.standing()).toBe('managed');
			expect(turnSinkStanding()!.authorityId()).toBe('fleet-authority');
			const omitted = bareTurn();
			expect(() => omitted.run()).toThrow(DispatchRefusedError);
			expect(() => omitted.run()).toThrow(
				expect.objectContaining({
					code: 'runtime-unavailable',
					message: expect.stringContaining('carries no admission'),
				})
			);
			await expectNoChild(omitted.argvOut);
			// A hand-rolled gate is not one the authority minted (the gate is checked before anything else).
			const forged = bareTurn();
			const gate = { admit: () => ({ ok: true }) };
			expect(() => forged.run({ admission: { gate, attribution: {} } as never })).toThrow(
				DispatchRefusedError
			);
			await expectNoChild(forged.argvOut);
			// Normal send in the same process still runs, on a lease the dequeue minted.
			const turn = watch(plain);
			value(await plain.turns.send('a1', 't1', { text: 'admitted' }));
			await turn.outcome();
			expect(ran()).toHaveLength(1);

			// An enrolled runtime nothing answers for holds the sink managed with no authority.
			await plain.connection.close();
			open = open.filter((runtime) => runtime !== plain);
			const orphan = await startManaged(null);
			expect(orphan.managedBinding.state()).toMatchObject({ state: 'enrolled-unavailable' });
			expect(turnSinkStanding()!.standing()).toBe('managed');
			expect(turnSinkStanding()!.authorityId()).toBeNull();
			const unanswered = bareTurn();
			expect(() => unanswered.run()).toThrow(DispatchRefusedError);
			await expectNoChild(unanswered.argvOut);
			// Shutdown releases the install.
			await orphan.connection.close();
			open = open.filter((runtime) => runtime !== orphan);
			expect(turnSinkStanding()).toBeNull();
		});

		it('holds the binding to an injected custody standing: enrolled with no binding file, deleting the mirror releases nothing, a standalone custody removes a stale mirror (MCOMP-09-04A)', async () => {
			const authority = managedAuthority();
			const probe = await startManaged(null);
			const installationId = probe.installation.installationId;
			await probe.connection.close();
			open = open.filter((runtime) => runtime !== probe);
			const mirror = path.join(dir, 'maestro-managed-binding.json');
			let custody: InstallationStanding = {
				standing: 'managed',
				enrollment: {
					installationId,
					authorityId: 'fleet-authority',
					endpointRef: 'ep',
					policySources: [],
					policyRevision: 1,
					enrolledAt: new Date(T0).toISOString(),
				},
				management: 'enrolled',
				detail: 'the custody enrolls this installation',
			};
			const standing: InstallationStandingSource = { read: () => custody };
			expect(fs.existsSync(mirror)).toBe(false);

			const runtime = await startManaged(authority, {}, standing);
			expect(runtime.managedBinding.state()).toMatchObject({
				state: 'enrolled',
				record: { installationId, authorityId: 'fleet-authority' },
			});
			expect(readManagedBindingFile(mirror)).toMatchObject({ status: 'ok' });
			fs.unlinkSync(mirror);
			expect(runtime.managedBinding.reload()).toMatchObject({ state: 'enrolled' });
			const omitted = bareTurn();
			expect(() => omitted.run()).toThrow(DispatchRefusedError);
			await expectNoChild(omitted.argvOut);
			await runtime.connection.close();
			open = open.filter((candidate) => candidate !== runtime);

			// A record held but unreadable: managed and unavailable, no mirror written.
			custody = {
				standing: 'managed',
				enrollment: null,
				management: null,
				detail: 'the record is present and cannot be opened here',
			};
			const held = await startManaged(authority, {}, standing);
			expect(held.managedBinding.state()).toMatchObject({ state: 'unreadable' });
			expect(fs.existsSync(mirror)).toBe(false);
			const plain = errorOf(await held.turns.send('a1', 't1', { text: 'plain' }));
			expect(plain.message).toContain('[managed-unavailable]');
			expect(ran()).toEqual([]);
			await held.connection.close();
			open = open.filter((candidate) => candidate !== held);

			// Released by the custody: a stale mirror goes, and a bare turn runs as before.
			await enrollDir(installationId, authority);
			custody = { standing: 'standalone', detail: 'released' };
			const released = await startManaged(authority, {}, standing);
			expect(released.managedBinding.state()).toMatchObject({ state: 'standalone' });
			expect(fs.existsSync(mirror)).toBe(false);
			const allowed = bareTurn();
			expect((await allowed.run().done).exitCode).toBe(0);
		});

		it('lists agents in bounded pages and reports the actor it verified', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			const page = value(await managed.agents(envelope(runtime, { cursor: null, limit: 1 })));
			expect(page).toMatchObject({
				status: 'ok',
				value: {
					items: [{ agentId: 'a1', providerId: 'claude-code', tabIds: ['t1', 't2'] }],
					nextCursor: null,
				},
			});
			expect(
				value(await managed.agents(envelope(runtime, { cursor: 'nope', limit: 1 })))
			).toMatchObject({
				status: 'denied',
				code: 'not-found',
			});
			const identity = value(await managed.identity(envelope(runtime, {})));
			expect(identity).toMatchObject({
				status: 'ok',
				value: {
					actor: { kind: 'service', id: 'fleet' },
					binding: 'standalone',
					verification: { peer: 'in-process' },
					installation: runtime.installation,
				},
			});
			expect(
				value(
					await managed.negotiate({
						supportedVersions: [MANAGED_CONTRACT_VERSION],
						required: ['capabilities.negotiate'],
					})
				)
			).toMatchObject({ outcome: 'activated' });
			// Events (MRC-10-02A): a context that did not ask is denied; one that did reads the runtime's
			// own durable journal, empty and complete before any turn ran.
			expect(
				value(await managed.events(envelope(runtime, { cursor: null, limit: 1 })))
			).toMatchObject({ status: 'denied', code: 'capability-unsupported' });
			expect(
				value(
					await managed.events(
						envelope(
							runtime,
							{ cursor: null, limit: 1 },
							{ requestedCapabilities: ['events.resume'] }
						)
					)
				)
			).toMatchObject({
				status: 'ok',
				value: { items: [], nextCursor: null, completeness: 'complete' },
			});
		});

		it('refuses a managed write once the runtime is closed', async () => {
			const runtime = await startManaged();
			const managed = managedOf(runtime);
			await runtime.connection.close();
			expect(errorOf(await managed.submit(envelope(runtime, submission('x')))).code).toBe(
				'host-unavailable'
			);
		});
	});
});
