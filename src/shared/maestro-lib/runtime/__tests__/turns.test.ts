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
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import * as repositories from '../../agents/repository';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, ManagedApi, TurnEvent } from '../../client/types';
import {
	createLocalHostAuthority,
	type HostAuthority,
	type PolicyDecision,
} from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import { inProcessContext } from '../../managed/operations';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedOperationContext,
	type ManagedOperationEnvelope,
	type ManagedRunIdentity,
	type ManagedSubmitInput,
} from '../../managed/types';
import { readHistory } from '../../store/read-history';
import { runAgentTurn } from '../../turns/run-agent-turn';
import { RUNTIME_LOCK_FILE_NAME } from '../data-dir-lock';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import type { WatchDirectory } from '../settings-watch';

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
	let binaryExists: boolean;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const argvOut = path.join(work, `argv-${argvFiles.length + 1}.json`);
		argvFiles.push(argvOut);
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
		vi.restoreAllMocks();
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

		async function startManaged(
			authority: HostAuthority | null = managedAuthority(),
			extra: Partial<RuntimeDeps> = {},
			agent = seedAgent()
		) {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions: [agent], activeSessionId: 'a1' }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: { ...deps(), ...extra },
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
				...(authority ? { managed: { authority } } : {}),
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

		it.each([
			{ name: 'new allocation', early: ['native-new'], end: 'native-new' },
			{
				name: 'settings change during turn',
				early: ['native-new'],
				end: 'native-new',
				mutate: true,
			},
			{ name: 'end-only allocation', early: [], end: 'native-new' },
			{ name: 'allocation without terminal ID', early: ['native-new'], end: undefined },
			{ name: 'cancelled allocation', early: ['native-new'], end: undefined, cancel: true },
			{ name: 'raw same-ID resume', resume: 'original', early: ['original'], end: undefined },
			{ name: 'unobserved resume', resume: 'original', early: [], end: undefined },
			{ name: 'unobserved new turn', early: [], end: undefined },
			{
				name: 'rejected allocation write',
				early: ['native-new'],
				end: undefined,
				refused: true,
				writeRefused: 'allocation',
			},
			{
				name: 'rejected same-ID check',
				resume: 'original',
				early: ['original'],
				end: undefined,
				refused: true,
				writeRefused: 'check',
			},
			{ name: 'invalid early ID', early: ['\u0000bad'], end: undefined, refused: true },
			{ name: 'blank early ID', early: ['   '], end: undefined, refused: true },
			{ name: 'empty end ID', early: [], end: '', refused: true },
			{ name: 'invalid end ID', early: [], end: 'bad\nend', refused: true },
			{
				name: 'replaced early ID',
				resume: 'original',
				early: ['replacement'],
				end: 'original',
				refused: true,
			},
			{
				name: 'replaced end ID',
				resume: 'original',
				early: ['original'],
				end: 'replacement',
				refused: true,
			},
			{
				name: 'conflicting allocation',
				early: ['native-new', 'replacement'],
				end: 'replacement',
				refused: true,
			},
		])(
			'records Grok identity honestly: $name',
			async ({ resume, early, end, cancel, refused, writeRefused, mutate }) => {
				// Exercise the real repository/journal/recorder around controlled parsed ID observations.
				// The existing inert child still supplies the actual process, admission and cancellation.
				hold = cancel === true;
				recordings.grok = writeFakeTurn(work, {
					chunks: ['{"type":"text","data":"answer"}\n', '{"type":"end","stopReason":"EndTurn"}\n'],
					close: { code: 0, signal: null },
				});
				let changeScope: () => void = () => undefined;
				const run: RuntimeDeps['turns']['runAgentTurn'] = async (assembled, options) => {
					expect(assembled.resumeSessionId).toBe(resume);
					const started = await fakeProvider(assembled, options);
					if (!started.ok) return started;
					return {
						ok: true,
						run: {
							...started.run,
							events: (async function* () {
								for (const sessionId of early) yield { type: 'system' as const, sessionId };
								if (mutate) {
									value(await runtime.agents.update('a1', { provider: 'codex' }));
									changeScope();
								}
								for await (const event of started.run.events) yield event;
							})(),
							result: started.run.result.then((completed) => ({
								...completed,
								sessionId: end,
								usage: {
									inputTokens: 7,
									outputTokens: 3,
									cacheReadInputTokens: 0,
									cacheCreationInputTokens: 0,
									totalCostUsd: 0.01,
									contextWindow: 200_000,
								},
							})),
						},
					};
				};
				if (writeRefused || mutate) {
					const create = repositories.createAgentRepository;
					vi.spyOn(repositories, 'createAgentRepository').mockImplementationOnce((options) => {
						const repository = create(options);
						// A foreign settings snapshot can arrive outside the public busy edit guard.
						const get = repository.getAgent.bind(repository);
						changeScope = () => {
							vi.spyOn(repository, 'getAgent').mockImplementation((id) => {
								const agent = get(id);
								return (
									agent && {
										...agent,
										cwd: path.join(work, 'changed'),
										parentSessionId: 'changed-parent',
										sessionSshRemoteConfig: { enabled: true, remoteId: 'changed-host' },
									}
								);
							});
						};
						const record = repository.recordTabSession.bind(repository);
						vi.spyOn(repository, 'recordTabSession').mockImplementation((...args) => {
							const update = args[3];
							if (
								writeRefused === 'allocation'
									? !!update.agentSessionId
									: writeRefused === 'check' && !update.agentSessionId && !update.addUsage
							) {
								return Promise.resolve({
									ok: false,
									error: {
										code: 'rejected',
										method: 'turns.send',
										message: 'Native ownership changed.',
									},
								});
							}
							return record(...args);
						});
						return repository;
					});
				}
				const binding = { version: 1, state: 'unknown', reason: 'unobserved' };
				const runtime = await startManaged(
					managedAuthority(),
					{ turns: { runAgentTurn: run } },
					seedAgent({
						toolType: 'grok',
						aiTabs: [
							{
								id: 't1',
								agentSessionId: resume ?? null,
								name: null,
								logs: [],
								...(resume ? { nativeSessionBinding: binding } : {}),
							},
						],
					})
				);
				const turn = watch(runtime);
				const result = value(
					await managedOf(runtime).submit(
						envelope(runtime, {
							...submission('identity recording'),
							providerId: 'grok',
						})
					)
				);
				expect(result.status).toBe('ok');
				if (cancel) {
					await turn.saw('session');
					// Allocation is persisted before its event becomes visible, even if Stop follows it.
					expect(await tabOf(runtime)).toMatchObject({
						agentSessionId: 'native-new',
						nativeSessionBinding: binding,
					});
					value(await runtime.turns.interrupt('a1', 't1'));
				}
				await turn.outcome();
				const retained =
					resume ??
					(writeRefused
						? null
						: early[0] === 'native-new'
							? 'native-new'
							: !refused
								? end
								: null) ??
					null;
				const observed = refused ? undefined : (end ?? early[0]);
				const current = await tabOf(runtime);
				const tab = mutate
					? (current.providerSessions as Record<string, typeof current>).grok
					: current;
				expect(tab.agentSessionId).toBe(retained);
				expect(current.runtimeTurnId).toEqual(expect.any(String));
				if (retained) expect(tab.nativeSessionBinding).toEqual(binding);
				else expect(tab.nativeSessionBinding).toBeUndefined();
				expect(turn.outcomes()).toEqual([
					refused ? 'crashed' : cancel ? 'interrupted' : 'completed',
				]);
				const sessionIds = turn.events.flatMap((event) =>
					event.kind === 'session' ? [event.providerSessionId] : []
				);
				expect(sessionIds).toEqual(
					!resume && !writeRefused && early[0] === 'native-new'
						? ['native-new']
						: !refused && end
							? [end]
							: []
				);
				const history = readHistory(runtime.paths, 'a1');
				if (refused || cancel) expect(history.status).toBe('missing');
				else {
					if (history.status !== 'ok') throw new Error(`history ${history.status}`);
					expect(history.entries).toHaveLength(1);
					expect(history.entries[0].projectPath).toBe(work);
					expect(history.entries[0].agentSessionId).toBe(observed);
					expect(history.entries[0].nativeSessionBinding).toEqual(binding);
				}
				expect(journalRuns()[0]).toMatchObject({
					state: refused ? 'failed' : cancel ? 'cancelled' : 'completed',
					providerSessionId: observed ?? null,
					attempts: [
						expect.objectContaining({
							phase: 'terminal',
							outcome: refused ? 'failed' : cancel ? 'cancelled' : 'completed',
						}),
					],
				});
				if (refused) {
					expect(tab.usageStats).toBeUndefined();
					expect(turn.events).toContainEqual(
						expect.objectContaining({
							kind: 'error',
							error: expect.objectContaining({ type: 'session_not_found', recoverable: false }),
						})
					);
				} else expect(tab.usageStats).toMatchObject({ inputTokens: 7, outputTokens: 3 });
			}
		);

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
