/**
 * Auto Run in the runtime: launch, progress, controls, holds, and the records a run leaves, with a
 * fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs`, so every task is a real process on a real
 * pipe, assembled by the real `assembleAutoRunTurn`, started by the real `runAgentTurn`, and driven
 * by the real engine. Only the command is swapped: the fake agent ticks the first unchecked task of
 * the document it is told to and replays a Claude Code stream saying what a script says. The
 * runtime, its repository, its queue, its history writer, and `cli-activity.json` are real and live
 * in a temp data directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
} from '../../../../__tests__/main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
	type FakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import type { HistoryEntry } from '../../../types';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { autoRunWorkflowVersion } from '../../autorun/attribution';
import type { AutoRunRunEvent } from '../../autorun/run-tracker';
import type { AutoRunOutcome, ClientResult, MaestroEvent } from '../../client/types';
import {
	createLocalHostAuthority,
	type AdmissionRequest,
	type HostAuthority,
} from '../../managed/authority';
import { CALLER_CREDENTIAL_ENV_VAR } from '../../launch/env';
import { createManagedBinding } from '../../managed/binding';
import type { WorkflowFenceAnswer, WorkflowFenceLifetime } from '../../managed/workflows';
import { readHistory } from '../../store/read-history';
import { AUTO_RUN_SESSION_COLUMNS, AUTO_RUN_TASK_COLUMNS } from '../../stats/auto-run-insert';
import { QUERY_EVENT_COLUMNS } from '../../stats/query-event-insert';
import { runAgentTurn } from '../../turns/run-agent-turn';
import { outcomeOfEngineEvent } from '../autorun';
import * as autoRunService from '../autorun';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeDeps,
} from '../index';
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

/** The line Claude Code ends a turn on when the API refused it: an expired key, classified `auth_expired`. */
const AUTH_FAILURE =
	'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

/**
 * One Claude Code turn that says `text`: what the fake agent replays for a task or an iteration.
 * With `failure`, the turn ends on that error and exits 1.
 */
function claudeTurn(text: string, sessionId: string, failure?: string): FakeTurn {
	const usage = {
		input_tokens: 10,
		output_tokens: 5,
		cache_read_input_tokens: 0,
		cache_creation_input_tokens: 0,
	};
	const line = (object: unknown) => `${JSON.stringify(object)}\n`;
	return {
		chunks: [
			line({ type: 'system', subtype: 'init', session_id: sessionId }),
			line({
				type: 'assistant',
				message: { role: 'assistant', content: [{ type: 'text', text }], usage },
				session_id: sessionId,
			}),
			line({
				type: 'result',
				subtype: failure ? 'error_during_execution' : 'success',
				is_error: failure !== undefined,
				result: failure ?? text,
				session_id: sessionId,
				total_cost_usd: 0.01,
				usage,
			}),
		],
		close: { code: failure ? 1 : 0, signal: null },
	};
}

/** What the fake agent does for one Auto Run turn, in the order the run starts them. */
interface Step {
	text: string;
	/** The document the agent ticks a task in. Absent: it changes no file (a synopsis, a handoff). */
	tick?: string;
	/** The turn ends on this API error instead of an answer. */
	failure?: string;
	/** The agent says nothing more and stays running, as a hung agent does. */
	hang?: boolean;
}

describe('runtime Auto Run', () => {
	let dir: string;
	let work: string;
	let docs: string;
	let open: MaestroRuntime[];
	let script: Step[];
	let chatRecording: string;
	let envFiles: string[];
	/** What each Auto Run turn was launched with, in the order the run started them. */
	let runLaunches: Array<{ prompt: string; args: string[] }>;
	/** The SQL the fake stats connection was asked to run, with its bind values. */
	let statsWrites: Array<{ sql: string; params: unknown[] }>;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		const isRun = turn.launch.querySource === 'auto';
		const step = isRun ? script.shift() : undefined;
		if (isRun && !step) throw new Error('The script has no step left for this Auto Run turn.');
		if (isRun) runLaunches.push({ prompt: turn.launch.prompt ?? '', args: [...turn.launch.args] });
		const recording = step
			? writeFakeTurn(work, claudeTurn(step.text, `provider-${envFiles.length + 1}`, step.failure))
			: chatRecording;
		const envOut = path.join(work, `env-${envFiles.length + 1}.json`);
		envFiles.push(envOut);
		return runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...turn.launch.args],
					sessionCustomEnvVars: {
						...turn.launch.sessionCustomEnvVars,
						FAKE_AGENT_RECORDING: recording,
						FAKE_AGENT_ENV_OUT: envOut,
						...(step?.tick ? { FAKE_AGENT_TICK_FILE: step.tick } : {}),
						...(step?.hang ? { FAKE_AGENT_HOLD: '1' } : {}),
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
	};

	/** A stats.db stand-in: it has every column the recorder checks for, and records what it is asked to run. */
	class FakeDatabase {
		pragma(source: string): unknown {
			const table = /^table_info\((\w+)\)$/.exec(source)?.[1];
			const columns: Record<string, readonly string[]> = {
				query_events: QUERY_EVENT_COLUMNS,
				auto_run_sessions: AUTO_RUN_SESSION_COLUMNS,
				auto_run_tasks: AUTO_RUN_TASK_COLUMNS,
			};
			return table ? (columns[table] ?? []).map((name) => ({ name })) : undefined;
		}
		prepare(sql: string) {
			return { run: (...params: unknown[]) => void statsWrites.push({ sql, params }) };
		}
		close() {}
	}

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
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			turns: { runAgentTurn: fakeProvider },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'Alpha',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		autoRunFolderPath: docs,
		aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
		activeTabId: 't1',
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		...extra,
	});

	async function start(
		agent: Record<string, unknown> = seedAgent(),
		managed?: MaestroRuntimeOptions['managed']
	): Promise<MaestroRuntime> {
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions: [agent], activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: {
				bundledPromptsDir: BUNDLED_PROMPTS,
				loadSqlite: () => FakeDatabase as never,
			},
			...(managed ? { managed } : {}),
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	const doc = (name: string, text: string): string => {
		const file = path.join(docs, `${name}.md`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		return file;
	};
	const tasks = (count: number, checked = 0): string =>
		Array.from({ length: count }, (_, i) => `- [${i < checked ? 'x' : ' '}] task ${i + 1}`).join(
			'\n'
		);
	const read = (file: string): string => fs.readFileSync(file, 'utf-8');

	/**
	 * Watch a run: every `autorun` event, how each run ended (`outcomes`, with the number of
	 * `autorun` events seen when it was said), and a way to wait for a frame or for the end.
	 */
	function watchRun(runtime: MaestroRuntime, agentId = 'a1') {
		const events: AutoRunRunEvent[] = [];
		const outcomes: Array<{ outcome: AutoRunOutcome; afterEvents: number }> = [];
		const waiting: Array<{ test: (events: AutoRunRunEvent[]) => boolean; resolve: () => void }> =
			[];
		runtime.events.subscribe(
			(event: MaestroEvent) => {
				if (event.type === 'autorun.ended') {
					if (event.agentId === agentId) {
						outcomes.push({ outcome: event.outcome, afterEvents: events.length });
					}
					return;
				}
				if (event.type !== 'autorun') return;
				events.push(event.event);
				for (const waiter of waiting.filter((w) => w.test(events))) waiter.resolve();
			},
			{ types: ['autorun', 'autorun.ended'], agentId }
		);
		const until = (test: (events: AutoRunRunEvent[]) => boolean, label: string) =>
			new Promise<void>((resolve, reject) => {
				if (test(events)) return resolve();
				const timer = setTimeout(
					() => reject(new Error(`${label}; saw ${events.map((e) => e.kind).join(',')}`)),
					15_000
				);
				waiting.push({
					test,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		return {
			events,
			outcomes,
			/** The one outcome the run ended with. */
			outcome: () => {
				expect(outcomes).toHaveLength(1);
				return outcomes[0].outcome;
			},
			frames: () =>
				events.flatMap((event) => (event.kind === 'state' && event.state ? [event.state] : [])),
			ended: () =>
				until(
					(all) => all.some((e) => e.kind === 'state' && e.state === null),
					'the run did not end'
				),
			paused: () =>
				until(
					(all) => all.some((e) => e.kind === 'state' && e.state?.pause !== undefined),
					'the run did not pause'
				),
		};
	}

	const auto = (runtime: MaestroRuntime): HistoryEntry[] => {
		const history = readHistory(runtime.paths, 'a1', { limit: 1000 });
		if (history.status !== 'ok') throw new Error(`history ${history.status}`);
		return history.entries.filter((entry) => entry.type === 'AUTO').reverse();
	};
	const activityFile = () => path.join(dir, 'cli-activity.json');

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-autorun-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-autorun-work-'));
		docs = path.join(work, 'docs');
		fs.mkdirSync(docs);
		open = [];
		script = [];
		envFiles = [];
		runLaunches = [];
		statsWrites = [];
		chatRecording = writeFakeTurn(
			work,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
		);
		// `stats.db` exists, so the recorder tries to write; the connection behind it is the fake.
		fs.writeFileSync(path.join(dir, 'stats.db'), '');
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('a spec-driven run', () => {
		it('works through every task, reports its progress, and leaves the rows the desktop counts', async () => {
			const file = doc('tasks', tasks(3));
			script = [1, 2, 3].map((n) => ({
				text: `Finished task number ${n} of the list. More detail follows.`,
				tick: file,
			}));
			const runtime = await start();
			const run = watchRun(runtime);

			expect(value(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toBeUndefined();
			await run.ended();

			// Every box is ticked and the run is no longer registered as working.
			expect(read(file)).toBe(tasks(3, 3));
			expect(runtime.runs.activeRuns()).toEqual([]);
			expect(runtime.runs.latestState('a1')).toBeUndefined();
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);

			// Progress: the bars moved with the files, and the last frame is `null`.
			const frames = run.frames();
			expect(frames[0]).toMatchObject({ isRunning: true, tasksTotal: 3, tasksDone: 0 });
			expect(frames[frames.length - 1]).toMatchObject({ tasksTotal: 3, tasksDone: 3 });
			expect(run.events[run.events.length - 1]).toMatchObject({ kind: 'state', state: null });
			// How it ended is said once, just before that last frame.
			expect(run.outcome()).toEqual({ status: 'completed' });
			expect(run.outcomes[0].afterEvents).toBe(run.events.length - 1);
			// The agent's words and usage reach the output stream.
			expect(run.events.some((e) => e.kind === 'output' && e.text.includes('Finished task'))).toBe(
				true
			);
			expect(run.events.some((e) => e.kind === 'usage')).toBe(true);

			// History: three per-task rows with their synopsis from the answer (no extra turn per
			// task), and one final row that is the run boundary.
			const rows = auto(runtime);
			expect(rows).toHaveLength(4);
			const taskRows = rows.filter((row) => row.completedTaskCount !== undefined);
			expect(taskRows).toHaveLength(3);
			expect(taskRows.map((row) => row.completedTaskCount)).toEqual([1, 1, 1]);
			expect(taskRows[0].summary).toBe('Finished task number 1 of the list.');
			expect(taskRows.every((row) => row.projectPath === work && row.sessionId === 'a1')).toBe(
				true
			);
			expect(rows[3].summary).toBe('Auto Run completed: 3 tasks in 1 loop');
			expect(envFiles).toHaveLength(3);

			// Each turn is automation, not someone typing.
			const env = JSON.parse(read(envFiles[0]));
			expect(env.MAESTRO_QUERY_SOURCE).toBe('auto');
		});

		it('writes the usage rows the Usage Dashboard counts', async () => {
			const file = doc('tasks', tasks(3));
			script = [1, 2, 3].map(() => ({ text: 'Done with this task. Details.', tick: file }));
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			const into = (table: string) =>
				statsWrites.filter((write) => write.sql.includes(`INSERT INTO ${table}`));
			// One run, three tasks, and one `query_events` row per turn marked as automation.
			expect(into('auto_run_sessions')).toHaveLength(1);
			expect(into('auto_run_sessions')[0].params).toContain('tasks');
			// A document run is stored as spec-driven, the last bound column.
			expect(into('auto_run_sessions')[0].params.at(-1)).toBe('spec-driven');
			expect(into('auto_run_tasks')).toHaveLength(3);
			const queries = into('query_events');
			expect(queries).toHaveLength(3);
			expect(queries.every((write) => write.params[1] === 'a1' && write.params[3] === 'auto')).toBe(
				true
			);
			// The run is closed with its duration and the tasks it finished.
			const closing = statsWrites.filter((write) =>
				write.sql.startsWith('UPDATE auto_run_sessions')
			);
			expect(closing).toHaveLength(1);
			expect(closing[0].params[1]).toBe(3);
		});

		it('runs every task under the prompt the launch states, in place of the default', async () => {
			const file = doc('tasks', tasks(1));
			script = [{ text: 'Done with this task. Details.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(
				await runtime.autoRun.launch('a1', {
					documents: [{ file }],
					prompt: 'CUSTOM RUN PROMPT: tick exactly one box.',
				})
			);
			await run.ended();

			expect(runLaunches).toHaveLength(1);
			expect(runLaunches[0].prompt).toContain('CUSTOM RUN PROMPT: tick exactly one box.');
		});

		it('skips the documents’ model hints when the launch says to', async () => {
			const hinted = '<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] task 1';
			const argsOf = async (name: string, ignoreModelHints: boolean): Promise<string[]> => {
				const file = doc(name, hinted);
				script = [{ text: 'Done with this task. Details.', tick: file }];
				runLaunches = [];
				const runtime = await start();
				const run = watchRun(runtime);
				value(
					await runtime.autoRun.launch('a1', {
						documents: [{ file }],
						...(ignoreModelHints ? { ignoreModelHints } : {}),
					})
				);
				await run.ended();
				await runtime.connection.close();
				return runLaunches[0].args;
			};
			// The marker picks the model and effort of the task under it.
			const hintedArgs = await argsOf('hinted', false);
			expect(hintedArgs).toContain('--model');
			expect(hintedArgs).toContain('--effort');
			// Skipped, the task runs at the agent's own settings, which here are the provider's defaults.
			const ignoredArgs = await argsOf('ignored', true);
			expect(ignoredArgs).not.toContain('--model');
			expect(ignoredArgs).not.toContain('--effort');
		});

		it('refuses before anything starts, with the reason', async () => {
			const open1 = doc('open', tasks(2));
			const done = doc('done', tasks(2, 2));
			const halted = doc('halted', `${tasks(1)}\n<!-- maestro:halt: a person must look -->\n`);
			const outside = path.join(work, 'elsewhere.md');
			fs.writeFileSync(outside, tasks(1));
			const runtime = await start();

			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [] })).code).toBe('invalid');
			expect(
				errorOf(await runtime.autoRun.launch('ghost', { documents: [{ file: open1 }] })).code
			).toBe('not-found');
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: outside }] }))
			).toMatchObject({
				code: 'invalid',
			});
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: done }] }))
			).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('no unchecked tasks'),
			});
			expect(
				errorOf(await runtime.autoRun.launch('a1', { documents: [{ file: halted }] }))
			).toMatchObject({
				code: 'rejected',
			});
			// A document that does not exist is not one with nothing left to do.
			expect(
				errorOf(
					await runtime.autoRun.launch('a1', {
						documents: [{ file: open1 }, { file: path.join(path.dirname(open1), 'gone.md') }],
					})
				)
			).toMatchObject({ code: 'not-found', message: expect.stringContaining('1 of 2') });
			// Nothing started: no process, no History, no activity entry.
			expect(envFiles).toHaveLength(0);
			expect(runtime.runs.activeRuns()).toEqual([]);
			expect(fs.existsSync(activityFile())).toBe(false);
		});

		it('refuses when Auto Run is turned off, or the agent works on an SSH remote', async () => {
			const file = doc('tasks', tasks(1));
			fs.writeFileSync(
				path.join(dir, 'maestro-settings.json'),
				JSON.stringify({ autoRunDisabled: true })
			);
			const runtime = await start();
			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('turned off'),
			});

			fs.writeFileSync(path.join(dir, 'maestro-settings.json'), JSON.stringify({}));
			const remote = await start(
				seedAgent({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } })
			);
			expect(errorOf(await remote.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('SSH'),
			});
		});
	});

	describe('a run that waits on a person', () => {
		const gated = () =>
			`- [ ] before the gate\n<!-- MAESTRO:HITL reason="Approve the migration" -->\n- [ ] after the gate\n`;

		it('parks at a gate, holds the agent, and goes on when resumed', async () => {
			const file = doc('gated', gated());
			script = [
				{ text: 'Did the first task. Done.', tick: file },
				{ text: 'Did the second task. Done.', tick: file },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();

			// Parked: the frame says why, the run is listed as paused, and the agent is held.
			const parked = run
				.frames()
				.filter((frame) => frame.pause)
				.pop();
			expect(parked?.pause).toMatchObject({ type: 'hitl_gate', message: 'Approve the migration' });
			expect(runtime.runs.activeRuns()).toMatchObject([
				{ agentId: 'a1', kind: 'playbook', paused: true },
			]);
			expect(runtime.runs.latestState('a1')).toMatchObject({ isRunning: true, errorPaused: true });
			expect(errorOf(await runtime.autoRun.launch('a1', { documents: [{ file }] }))).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('busy'),
			});

			// A chat message that would write waits behind the run (AE17).
			const chatEnded = new Promise<void>((resolve) => {
				runtime.turns.subscribe('a1', 't1', (event) => {
					if (event.kind === 'outcome') resolve();
				});
			});
			const chat = value(await runtime.turns.send('a1', 't1', { text: 'hello there' }));
			expect(chat).toMatchObject({ status: 'queued', position: 1 });
			expect(envFiles).toHaveLength(1);

			// A second answer is refused: nothing is pending any more once resumed, and `skip` of a
			// run that is not paused is a stale click.
			value(await runtime.autoRun.resume('a1'));
			await run.ended();
			expect(read(file)).toContain('- [x] before the gate');
			expect(read(file)).toContain('- [x] after the gate');
			expect(errorOf(await runtime.autoRun.skip('a1')).code).toBe('not-found');

			// The run ended, so the held message starts and finishes.
			await chatEnded;
			expect(value(await runtime.turns.queue.list('a1'))).toEqual([]);
			const tab = value(await runtime.tabs.list('a1'))[0];
			expect(tab.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
		});

		it('lets one of two launches that race start, and refuses the other as busy', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			const [first, second] = await Promise.all([
				runtime.autoRun.launch('a1', { documents: [{ file }] }),
				runtime.autoRun.launch('a1', { documents: [{ file }] }),
			]);

			expect([first.ok, second.ok].sort()).toEqual([false, true]);
			expect(errorOf(first.ok ? second : first)).toMatchObject({
				code: 'rejected',
				message: expect.stringContaining('busy'),
			});
			await run.paused();
			expect(runtime.runs.activeRuns()).toHaveLength(1);
		});

		it('ends a parked run, and records it, when the runtime is closed', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			await runtime.connection.close();

			// Nothing is left running, and History says how the run ended.
			expect(runtime.runs.activeRuns()).toEqual([]);
			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toMatch(/^Auto Run stopped:/);
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);
		});

		it('ends the run when a person aborts it, and records that', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			value(await runtime.autoRun.abort('a1'));
			await run.ended();

			expect(read(file)).toContain('- [x] before the gate');
			expect(read(file)).toContain('- [ ] after the gate');
			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toBe('Auto Run stopped: aborted by operator');
			// A person ended it: a stop, not a failure, and not a run that completed.
			expect(run.outcome()).toEqual({ status: 'stopped' });
		});

		it('answers a stop with an abort while parked, and refuses a control when no run exists', async () => {
			const file = doc('gated', gated());
			script = [{ text: 'Did the first task. Done.', tick: file }];
			const runtime = await start();
			const run = watchRun(runtime);

			expect(errorOf(await runtime.autoRun.stop('a1')).code).toBe('not-found');
			expect(errorOf(await runtime.autoRun.resume('a1')).code).toBe('not-found');

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			value(await runtime.autoRun.stop('a1'));
			await run.ended();

			const rows = auto(runtime);
			expect(rows[rows.length - 1].summary).toMatch(/^Auto Run stopped:/);
			expect(run.outcome()).toEqual({ status: 'stopped' });
		});
	});

	describe('when the agent fails', () => {
		it('parks on a classified error, and retries the same task when resumed', async () => {
			const file = doc('tasks', tasks(1));
			script = [
				{ text: 'The key was refused.', failure: AUTH_FAILURE },
				{ text: 'Did the task this time. Done.', tick: file },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			expect(
				run
					.frames()
					.filter((frame) => frame.pause)
					.pop()?.pause
			).toMatchObject({
				type: 'auth_expired',
			});
			// The pause explains itself in History, and the document is untouched.
			expect(auto(runtime).map((row) => row.summary)).toContain(
				'Auto Run error: Authentication Required (tasks)'
			);
			expect(read(file)).toBe(tasks(1));

			value(await runtime.autoRun.resume('a1'));
			await run.ended();
			expect(read(file)).toBe(tasks(1, 1));
		});

		it('leaves the document, not the run, when a person skips the failing document', async () => {
			const first = doc('first', tasks(1));
			const second = doc('second', tasks(1));
			script = [
				{ text: 'Refused.', failure: AUTH_FAILURE },
				{ text: 'Did the second document. Done.', tick: second },
			];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file: first }, { file: second }] }));
			await run.paused();
			value(await runtime.autoRun.skip('a1'));
			await run.ended();

			expect(read(first)).toBe(tasks(1));
			expect(read(second)).toBe(tasks(1, 1));
		});

		it('kills a hung agent, trips the stall guard at once, and says so in History', async () => {
			const file = doc('tasks', tasks(2));
			// 0.01 minutes of silence is 600 ms: long enough for the agent to start, short for a test.
			fs.writeFileSync(
				path.join(dir, 'maestro-settings.json'),
				JSON.stringify({ autoRunInactivityTimeoutMin: 0.01 })
			);
			script = [{ text: 'Working on it.', hang: true }];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			// One dispatch only: a watchdog failure is a dead run, not a slow one.
			expect(envFiles).toHaveLength(1);
			expect(read(file)).toBe(tasks(2));
			const summaries = auto(runtime).map((row) => row.summary);
			expect(summaries).toContain('[tasks] Task failed');
			expect(summaries).toContain('Document stalled: tasks (2 tasks remaining)');
		});
	});

	describe('a goal-driven run', () => {
		it('iterates until the agent reports the goal met, and writes the rows the desktop does', async () => {
			script = [
				{ text: 'Made a start on it.\n<!-- maestro:progress 40 | halfway there -->' },
				// The handoff note the engine asks the first iteration for before the next one starts.
				{ text: 'Left the parser half done.' },
				{
					text: 'All finished.\n<!-- maestro:progress 100 | done -->\n<!-- maestro:goal-complete -->',
				},
			];
			const runtime = await start();
			const run = watchRun(runtime);

			expect(
				value(await runtime.autoRun.launchGoal('a1', { goal: 'Ship the parser', maxIterations: 5 }))
			).toEqual({});
			await run.ended();

			const frames = run.frames();
			expect(frames[0]).toMatchObject({ goal: { iteration: 0 }, tasksTotal: 100 });
			expect(frames.some((frame) => frame.goal?.percent === 40)).toBe(true);
			expect(frames.some((frame) => frame.goal?.percent === 100)).toBe(true);

			const rows = auto(runtime);
			expect(rows.map((row) => row.summary)).toEqual([
				'Goal-Driven Auto Run started',
				'Goal progress: 40% - halfway there',
				'Goal progress: 100% - done',
				'Goal completed (100%)',
			]);
			expect(rows[3].success).toBe(true);
			expect(run.outcome()).toEqual({ status: 'completed' });
			expect(envFiles).toHaveLength(3);
			expect(JSON.parse(read(activityFile())).activities).toEqual([]);
			// The run shows in the Usage Dashboard as a goal run on the 0 to 100 scale.
			const sessions = statsWrites.filter((write) =>
				write.sql.includes('INSERT INTO auto_run_sessions')
			);
			expect(sessions[0].params).toContain('Goal: Ship the parser');
			// Stored as a goal run, not as the spec-driven default an unlabeled row reads as.
			expect(sessions[0].params.at(-1)).toBe('goal-driven');
		});

		it('refuses an empty goal', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.autoRun.launchGoal('a1', { goal: '   ' })).code).toBe('invalid');
		});
	});

	/**
	 * The runtime on an enrolled installation (MRC-07-01A): every turn is admitted on the run's
	 * lineage against the injected authority, or refused before a process starts. The fleet
	 * authority allows everything and keeps what it was asked, so the test reads the context the
	 * runtime built rather than trusting the caller's word for it.
	 */
	describe('under management', () => {
		function fleetAuthority(): { authority: HostAuthority; asked: AdmissionRequest[] } {
			const asked: AdmissionRequest[] = [];
			let ids = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: (request) => {
					asked.push(request);
					return { decision: 'allow', policyRevision: 1 };
				},
				now: () => Date.now(),
				newId: () => `lease-${++ids}`,
				leaseTtlMs: 60_000,
			});
			return { authority, asked };
		}

		/** Enroll this data directory to the fleet authority, as a desktop or host would have, then start on it. */
		async function startEnrolled(
			authority: HostAuthority,
			workflowFence?: NonNullable<MaestroRuntimeOptions['managed']>['workflowFence']
		): Promise<MaestroRuntime> {
			const enroller = await start();
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => T0,
			});
			const enrolled = await binding.enroll({
				installationId: enroller.installation.installationId,
				authorityId: 'fleet-authority',
				endpointRef: 'ep',
				policySources: [],
				policyRevision: 1,
			});
			if (!enrolled.ok) throw new Error(enrolled.message);
			await enroller.connection.close();
			open.splice(open.indexOf(enroller), 1);
			const runtime = await start(seedAgent(), {
				authority,
				...(workflowFence ? { workflowFence } : {}),
			});
			expect(runtime.managedBinding.state().state).toBe('enrolled');
			return runtime;
		}

		it('refuses every turn of a workflow with no owner producer by name, parks the run with the reason, and starts no process', async () => {
			const file = doc('tasks', tasks(1));
			const { authority, asked } = fleetAuthority();
			// No host adapter, so the runtime's own ownership has no producer port to claim through
			// (MRC-07-06A): the claim is refused by that name, and nothing stands in for the registry.
			const runtime = await startEnrolled(authority);
			expect(
				await runtime.claimWorkflowFence(
					{ workflowId: 'wf', version: 'v1', triggerEventId: 'cli:x' },
					{ runId: 'req-1', attemptId: 'att-1' }
				)
			).toMatchObject({
				fence: null,
				state: 'unavailable',
				code: 'runtime-unavailable',
				message: expect.stringContaining('No workflow owner producer is attached'),
			});
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			expect(
				run
					.frames()
					.filter((frame) => frame.pause)
					.pop()?.pause
			).toMatchObject({
				type: 'permission_denied',
				recoverable: true,
				message: expect.stringContaining('No workflow owner producer is attached'),
			});
			// Nothing was decided and nothing ran: no admission reached the authority, no provider
			// started, and the document is as it was.
			expect(asked).toEqual([]);
			expect(runLaunches).toEqual([]);
			expect(read(file)).toBe(tasks(1));

			value(await runtime.autoRun.abort('a1'));
			await run.ended();
			expect(run.outcome()).toEqual({ status: 'stopped' });
			expect(runLaunches).toEqual([]);
		});

		describe('service source custody', () => {
			let service: autoRunService.RuntimeAutoRun;
			let config: autoRunService.RuntimeAutoRunOptions;

			beforeEach(() => {
				const create = autoRunService.createRuntimeAutoRun;
				// Observe the real service composed by the runtime; keep its runner and processes real.
				vi.spyOn(autoRunService, 'createRuntimeAutoRun').mockImplementation((options) => {
					config = options;
					service = create(options);
					return service;
				});
			});
			afterEach(() => vi.restoreAllMocks());

			async function liveSource(kind: 'playbook' | 'goal' | 'standalone' = 'playbook') {
				const file = doc('source', tasks(1));
				const { authority, asked } = fleetAuthority();
				const owner = new AbortController();
				const lifetime = {
					signal: owner.signal,
					current: vi.fn(() => true),
					finish: vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined),
				};
				const claim = vi.fn(() => ({ ownerEpoch: 'epoch-1', fencingToken: 'fence-1', lifetime }));
				const runtime =
					kind === 'standalone' ? await start() : await startEnrolled(authority, claim);
				const run = watchRun(runtime);
				script = [{ text: 'Source is working.', hang: true }];
				value<unknown>(
					await (kind === 'goal'
						? runtime.autoRun.launchGoal('a1', { goal: 'Work', maxIterations: 1 })
						: runtime.autoRun.launch('a1', { documents: [{ file }] }))
				);
				await vi.waitFor(() => expect(run.events.some((e) => e.kind === 'output')).toBe(true));
				const event = run.events.find((e) => e.kind === 'output');
				if (event?.kind !== 'output') throw new Error('No source process output');
				return {
					runtime,
					run,
					processId: event.processId,
					authority,
					asked,
					claim,
					owner,
					lifetime,
					file,
				};
			}

			it.each(['playbook', 'goal'] as const)(
				'exposes original live %s custody without another admission or claim',
				async (kind) => {
					const { processId, authority, asked, claim, lifetime } = await liveSource(kind);
					const leases = authority.live();
					expect(service.sourceCustody('a1', processId)).toEqual({
						context: asked[0].context,
						writable: true,
					});
					expect(service.sourceCustody('a1', processId)?.context).toBe(asked[0].context);
					expect(service.sourceCustody('other', processId)).toBeNull();
					expect(service.sourceCustody('a1', 'wrong-process')).toBeNull();
					expect(asked[0].context.identity.runId).toEqual(expect.any(String));
					expect(service.sourceCustody('a1', asked[0].context.identity.runId ?? '')).toBeNull();
					expect(asked).toHaveLength(1);
					expect(claim).toHaveBeenCalledTimes(1);
					expect(lifetime.finish).not.toHaveBeenCalled();
					expect(authority.live()).toEqual(leases);
					expect(leases[0].state()).toBe('bound');
				}
			);

			it('returns no custody for a real standalone process', async () => {
				const { processId, asked, claim } = await liveSource('standalone');
				expect(service.sourceCustody('a1', processId)).toBeNull();
				expect(asked).toEqual([]);
				expect(claim).not.toHaveBeenCalled();
			});

			it('isolates concurrent agents and keeps the other source live after a stop', async () => {
				const { runtime, processId, file, asked } = await liveSource();
				const { agentId } = value(
					await runtime.agents.create({
						name: 'Beta',
						provider: 'claude-code',
						cwd: work,
						autoRunFolderPath: docs,
					})
				);
				const run = watchRun(runtime, agentId);
				script = [{ text: 'Beta is working.', hang: true }];
				value(await runtime.autoRun.launch(agentId, { documents: [{ file }] }));
				await vi.waitFor(() => expect(run.events.some((e) => e.kind === 'output')).toBe(true));
				const event = run.events.find((e) => e.kind === 'output');
				if (event?.kind !== 'output') throw new Error('No concurrent process');
				expect(service.sourceCustody('a1', processId)?.context).toBe(asked[0].context);
				expect(service.sourceCustody(agentId, event.processId)?.context).toBe(asked[1].context);
				expect(service.sourceCustody('a1', event.processId)).toBeNull();
				expect(service.sourceCustody(agentId, processId)).toBeNull();
				value(await runtime.autoRun.stop('a1'));
				expect(service.sourceCustody('a1', processId)).toBeNull();
				expect(service.sourceCustody(agentId, event.processId)?.context).toBe(asked[1].context);
			});

			it('withdraws on graceful stop while the source process is still alive', async () => {
				const { runtime, processId, authority } = await liveSource();
				expect(service.sourceCustody('a1', processId)).not.toBeNull();
				value(await runtime.autoRun.stop('a1'));
				expect(service.sourceCustody('a1', processId)).toBeNull();
				expect(authority.live()[0].state()).toBe('bound');
			});

			it('withdraws on shutdown and independently authorizes a fresh run', async () => {
				const { runtime, processId, asked, file } = await liveSource();
				const stopping = service.stopAll();
				expect(service.sourceCustody('a1', processId)).toBeNull();
				await stopping;
				const run = watchRun(runtime);
				script = [{ text: 'Fresh source.', hang: true }];
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await vi.waitFor(() => expect(run.events.some((e) => e.kind === 'output')).toBe(true));
				const event = run.events.find((e) => e.kind === 'output');
				if (event?.kind !== 'output') throw new Error('No fresh process');
				expect(event.processId).not.toBe(processId);
				expect(service.sourceCustody('a1', processId)).toBeNull();
				expect(service.sourceCustody('a1', event.processId)?.context).toBe(asked[1].context);
				expect(asked[1].context.identity).not.toEqual(asked[0].context.identity);
			});

			it.each(['lost', 'throws', 'during-read', 'stop-during-read'] as const)(
				'refuses %s service custody',
				async (change) => {
					const { processId, authority, lifetime } = await liveSource();
					const originalFence = config.fence;
					if (change === 'lost') config.fence = () => ({ ok: false, reason: 'ownership lost' });
					if (change === 'throws')
						config.fence = () => {
							throw new Error('ownership unreadable');
						};
					if (change === 'during-read') {
						lifetime.current.mockImplementation(() => {
							config.fence = () => ({ ok: false, reason: 'ownership lost during lookup' });
							return true;
						});
					}
					if (change === 'stop-during-read') {
						lifetime.current.mockImplementation(() => {
							void service.api.stop('a1');
							return true;
						});
					}
					expect(service.sourceCustody('a1', processId)).toBeNull();
					expect(authority.live()[0].state()).toBe('bound');
					expect(lifetime.finish).not.toHaveBeenCalled();
					config.fence = originalFence;
				}
			);

			it.each(['revoked', 'expired', 'mutated'] as const)(
				'preserves the runner refusal for %s custody',
				async (change) => {
					const { processId, authority, asked, lifetime } = await liveSource();
					if (change === 'revoked') authority.revoke(authority.live()[0].leaseId, 'revoked');
					if (change === 'expired') lifetime.current.mockReturnValue(false);
					if (change === 'mutated') asked[0].context.identity.attemptId = 'changed';
					expect(service.sourceCustody('a1', processId)).toBeNull();
				}
			);

			describe('caller credentials (MCOMP-17-03AY)', () => {
				/** The caller credentials Auto Run processes were stamped with, in launch order. */
				const stamped = () =>
					envFiles
						.filter((file) => fs.existsSync(file))
						.map((file) => JSON.parse(fs.readFileSync(file, 'utf-8'))[CALLER_CREDENTIAL_ENV_VAR])
						.filter((credential): credential is string => typeof credential === 'string');
				async function credentialAt(index: number): Promise<string> {
					await vi.waitFor(() => expect(stamped().length).toBeGreaterThan(index));
					return stamped()[index];
				}

				it.each(['playbook', 'goal'] as const)(
					'resolves a live %s credential to its agent and process without another admission',
					async (kind) => {
						const { processId, authority, asked, claim } = await liveSource(kind);
						const credential = await credentialAt(0);
						const leases = authority.live();
						expect(service.callerSource(credential)).toEqual({ agentId: 'a1', processId });
						for (const forged of ['', 'A'.repeat(credential.length), credential.slice(0, -1), 42])
							expect(service.callerSource(forged as string)).toBeNull();
						expect(asked).toHaveLength(1);
						expect(claim).toHaveBeenCalledTimes(1);
						expect(authority.live()).toEqual(leases);
					}
				);

				it('mints none for a standalone run', async () => {
					await liveSource('standalone');
					await vi.waitFor(() => expect(envFiles.some((file) => fs.existsSync(file))).toBe(true));
					expect(stamped()).toEqual([]);
				});

				it('keeps concurrent agents apart and withdraws only the stopped run', async () => {
					const { runtime, processId, file } = await liveSource();
					const first = await credentialAt(0);
					const { agentId } = value(
						await runtime.agents.create({
							name: 'Beta',
							provider: 'claude-code',
							cwd: work,
							autoRunFolderPath: docs,
						})
					);
					const run = watchRun(runtime, agentId);
					script = [{ text: 'Beta is working.', hang: true }];
					value(await runtime.autoRun.launch(agentId, { documents: [{ file }] }));
					await vi.waitFor(() => expect(run.events.some((e) => e.kind === 'output')).toBe(true));
					const event = run.events.find((e) => e.kind === 'output');
					if (event?.kind !== 'output') throw new Error('No concurrent process');
					const second = await credentialAt(1);
					expect(second).not.toBe(first);
					expect(service.callerSource(first)).toEqual({ agentId: 'a1', processId });
					expect(service.callerSource(second)).toEqual({ agentId, processId: event.processId });
					value(await runtime.autoRun.stop('a1'));
					expect(service.callerSource(first)).toBeNull();
					expect(service.callerSource(second)).toEqual({ agentId, processId: event.processId });
				});

				it.each(['stopAll', 'fence-lost', 'fence-throws', 'revoked', 'expired'] as const)(
					'refuses the credential after %s',
					async (change) => {
						const { processId, authority, lifetime } = await liveSource();
						const credential = await credentialAt(0);
						expect(service.callerSource(credential)).toEqual({ agentId: 'a1', processId });
						const originalFence = config.fence;
						let stopping: Promise<void> | undefined;
						if (change === 'stopAll') stopping = service.stopAll();
						if (change === 'fence-lost')
							config.fence = () => ({ ok: false, reason: 'ownership lost' });
						if (change === 'fence-throws')
							config.fence = () => {
								throw new Error('ownership unreadable');
							};
						if (change === 'revoked') authority.revoke(authority.live()[0].leaseId, 'revoked');
						if (change === 'expired') lifetime.current.mockReturnValue(false);
						expect(service.callerSource(credential)).toBeNull();
						config.fence = originalFence;
						await stopping;
					}
				);
			});

			it('returns no custody during a pending owner claim or after cancellation', async () => {
				const file = doc('pending', tasks(1));
				const { authority, asked } = fleetAuthority();
				const pending = Promise.withResolvers<WorkflowFenceAnswer>();
				const claim = vi.fn(() => pending.promise);
				const runtime = await startEnrolled(authority, claim);
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
				expect(service.sourceCustody('a1', 'pending')).toBeNull();
				const stopping = service.stopAll();
				pending.resolve(null);
				await stopping;
				expect(service.sourceCustody('a1', 'pending')).toBeNull();
				expect(asked).toEqual([]);
				expect(runLaunches).toEqual([]);
			});

			it('removes custody before reporting successful completion and settlement', async () => {
				const file = doc('completed', tasks(1));
				const { authority } = fleetAuthority();
				let processId = '';
				const finish = vi.fn<WorkflowFenceLifetime['finish']>(async () => {
					expect(processId).not.toBe('');
					expect(service.sourceCustody('a1', processId)).toBeNull();
				});
				const runtime = await startEnrolled(authority, () => ({
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
					lifetime: { signal: new AbortController().signal, current: () => true, finish },
				}));
				const run = watchRun(runtime);
				const ended = vi.fn(() => expect(service.sourceCustody('a1', processId)).toBeNull());
				runtime.events.subscribe(
					(event) => {
						if (event.type === 'autorun' && event.event.kind === 'output')
							processId = event.event.processId;
						if (event.type === 'autorun.ended') ended();
					},
					{ types: ['autorun', 'autorun.ended'] }
				);
				script = [{ text: 'Finished the task.', tick: file }];
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await run.ended();
				expect(run.outcome()).toEqual({ status: 'completed' });
				expect(finish).toHaveBeenCalledWith('applied');
				expect(ended).toHaveBeenCalledOnce();
				expect(service.sourceCustody('a1', processId)).toBeNull();
			});
		});

		describe('workflow settlement', () => {
			describe.each(['playbook', 'goal'] as const)('late %s owner claims', (kind) => {
				it.each(
					(['shutdown', 'expired', 'revoked'] as const).flatMap((change) =>
						[true, false].map((success) => ({ change, success }))
					)
				)(
					'settles $change custody before ending with success=$success',
					async ({ change, success }) => {
						const file = doc('tasks', tasks(1));
						const { authority, asked } = fleetAuthority();
						const pendingClaim = Promise.withResolvers<WorkflowFenceAnswer>();
						const pendingFinish = Promise.withResolvers<void>();
						const owner = new AbortController();
						const finish = vi.fn<WorkflowFenceLifetime['finish']>(() => pendingFinish.promise);
						const retryFinish = vi
							.fn<WorkflowFenceLifetime['finish']>()
							.mockResolvedValue(undefined);
						const claim = vi
							.fn<NonNullable<NonNullable<MaestroRuntimeOptions['managed']>['workflowFence']>>()
							.mockImplementationOnce(() => pendingClaim.promise)
							.mockImplementation(() => ({
								ownerEpoch: 'epoch-2',
								fencingToken: 'fence-2',
								lifetime: {
									signal: new AbortController().signal,
									current: () => true,
									finish: retryFinish,
								},
							}));
						const runtime = await startEnrolled(authority, claim);
						const run = watchRun(runtime);
						const launch = () =>
							kind === 'playbook'
								? runtime.autoRun.launch('a1', { documents: [{ file }] })
								: runtime.autoRun.launchGoal('a1', { goal: 'Ship the parser', maxIterations: 1 });
						value<unknown>(await launch());
						await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
						const closing = change === 'shutdown' ? runtime.connection.close() : undefined;
						if (change === 'revoked') owner.abort();
						pendingClaim.resolve({
							ownerEpoch: 'epoch-1',
							fencingToken: 'fence-1',
							lifetime: {
								signal: owner.signal,
								current: () => change !== 'expired',
								finish,
							},
						});
						try {
							await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('no_effect'));
							expect(run.outcomes).toEqual([]);
							expect(runtime.runs.activeRuns()).toHaveLength(1);
							expect(asked).toEqual([]);
							expect(runLaunches).toEqual([]);
							expect(envFiles).toEqual([]);
							expect(read(file)).toBe(tasks(1));
							expect(errorOf(await launch()).code).toBe(
								change === 'shutdown' ? 'host-unavailable' : 'rejected'
							);
						} finally {
							// A failing assertion must not leave the test's run or shutdown pending.
							await runtime.autoRun.stop('a1');
							if (success) pendingFinish.resolve();
							else pendingFinish.reject(new Error('late release acknowledgement lost'));
						}
						await run.ended();
						await closing;
						expect(finish.mock.calls).toEqual([['no_effect']]);
						expect(run.outcome()).toEqual(
							success
								? { status: 'stopped' }
								: {
										status: 'error',
										reason:
											'Workflow settlement remains uncertain: late release acknowledgement lost',
									}
						);
						expect(runtime.runs.activeRuns()).toEqual([]);
						if (closing) return;
						// A fresh attempt gets fresh custody and reaches the real fixture process.
						script =
							kind === 'playbook'
								? [{ text: 'Finished task one. Done.', tick: file }]
								: [{ text: 'Finished.\n<!-- maestro:goal-complete -->' }];
						const retry = watchRun(runtime);
						value<unknown>(await launch());
						await retry.ended();
						expect(retry.outcome()).toEqual({ status: 'completed' });
						expect(retryFinish.mock.calls).toEqual([['applied']]);
						expect(claim).toHaveBeenCalledTimes(2);
						expect(claim.mock.calls[1][1].attemptId).not.toBe(claim.mock.calls[0][1].attemptId);
						expect(asked).toHaveLength(1);
						expect(runLaunches).toHaveLength(1);
						expect(envFiles.every((env) => fs.existsSync(env))).toBe(true);
					}
				);
			});

			it('continues to the next task when a successful release ends the old owner signal', async () => {
				const file = doc('tasks', tasks(2));
				script = [1, 2].map(() => ({ text: 'Finished this task. Done.', tick: file }));
				const { authority } = fleetAuthority();
				const finishes: Array<ReturnType<typeof vi.fn<WorkflowFenceLifetime['finish']>>> = [];
				const runtime = await startEnrolled(authority, () => {
					const owner = new AbortController();
					const finish = vi.fn<WorkflowFenceLifetime['finish']>(async () => owner.abort());
					finishes.push(finish);
					return {
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
						lifetime: { signal: owner.signal, current: () => !owner.signal.aborted, finish },
					};
				});
				const run = watchRun(runtime);
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await run.ended();
				expect(run.outcome()).toEqual({ status: 'completed' });
				expect(finishes.map((finish) => finish.mock.calls)).toEqual([[['applied']], [['applied']]]);
				expect(read(file)).toBe(tasks(2, 2));
			});

			it.each(['playbook', 'goal'] as const)(
				'reports rejected settlement after a completed %s and admits a fresh retry',
				async (kind) => {
					const file = doc('tasks', tasks(1));
					const { authority, asked } = fleetAuthority();
					const finish = vi
						.fn<WorkflowFenceLifetime['finish']>()
						.mockRejectedValueOnce(new Error('release acknowledgement lost'))
						.mockResolvedValue(undefined);
					const claim = vi.fn(() => ({
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
						lifetime: { signal: new AbortController().signal, current: () => true, finish },
					}));
					const runtime = await startEnrolled(authority, claim);
					for (const retry of [false, true]) {
						fs.writeFileSync(file, tasks(1));
						script =
							kind === 'playbook'
								? [{ text: 'Finished task one. Done.', tick: file }]
								: [{ text: 'Finished.\n<!-- maestro:goal-complete -->' }];
						const run = watchRun(runtime);
						value<unknown>(
							await (kind === 'playbook'
								? runtime.autoRun.launch('a1', { documents: [{ file }] })
								: runtime.autoRun.launchGoal('a1', { goal: 'Ship the parser', maxIterations: 1 }))
						);
						await run.ended();
						expect(run.outcome()).toEqual(
							retry
								? { status: 'completed' }
								: {
										status: 'error',
										reason: 'Workflow settlement remains uncertain: release acknowledgement lost',
									}
						);
						expect(runtime.runs.activeRuns()).toEqual([]);
					}
					expect(finish.mock.calls).toEqual([['applied'], ['applied']]);
					expect(claim).toHaveBeenCalledTimes(2);
					expect(asked).toHaveLength(2);
					expect(asked[0].context.identity.attemptId).not.toBe(asked[1].context.identity.attemptId);
					expect(runLaunches).toHaveLength(2);
				}
			);

			it.each(['throw', 'reject'] as const)(
				'retains settlement failures when finish uses %s',
				async (mode) => {
					const file = doc('tasks', tasks(1));
					script = [{ text: 'Finished task one. Done.', tick: file }];
					const { authority } = fleetAuthority();
					const finish = vi.fn<WorkflowFenceLifetime['finish']>(() => {
						if (mode === 'throw') throw new Error('release failed');
						return Promise.reject('release failed');
					});
					const runtime = await startEnrolled(authority, () => ({
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
						lifetime: { signal: new AbortController().signal, current: () => true, finish },
					}));
					const run = watchRun(runtime);
					value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
					await run.ended();
					expect(run.outcome()).toEqual({
						status: 'error',
						reason: 'Workflow settlement remains uncertain: release failed',
					});
					expect(finish.mock.calls).toEqual([['applied']]);
					expect(read(file)).toBe(tasks(1, 1));
				}
			);

			it.each([true, false])('settles an unused claim once with success=%s', async (success) => {
				const file = doc('tasks', tasks(1));
				script = [{ text: 'Never starts.' }];
				const { authority } = fleetAuthority();
				authority.admit = async () => ({
					state: 'denied',
					code: 'policy-denied',
					message: 'No effects allowed.',
					policyRevision: 1,
				});
				const finish = vi.fn<WorkflowFenceLifetime['finish']>(() =>
					success ? Promise.resolve() : Promise.reject('release failed')
				);
				const runtime = await startEnrolled(authority, () => ({
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
					lifetime: { signal: new AbortController().signal, current: () => true, finish },
				}));
				const run = watchRun(runtime);
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				if (success) {
					await run.paused();
					value(await runtime.autoRun.abort('a1'));
				}
				await run.ended();
				expect(run.outcome()).toEqual(
					success
						? { status: 'stopped' }
						: {
								status: 'error',
								reason: 'Workflow settlement remains uncertain: release failed',
							}
				);
				expect(finish.mock.calls).toEqual([['no_effect']]);
				expect(envFiles.every((file) => !fs.existsSync(file))).toBe(true);
				expect(read(file)).toBe(tasks(1));
			});

			it('settles each attempt once while preserving a later engine failure', async () => {
				const file = doc('tasks', tasks(2));
				script = [{ text: 'Finished task one. Done.', tick: file }];
				const { authority } = fleetAuthority();
				const finish = vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined);
				const runtime = await startEnrolled(authority, () => ({
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
					lifetime: { signal: new AbortController().signal, current: () => true, finish },
				}));
				const run = watchRun(runtime);
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await run.ended();
				expect(run.outcome()).toEqual({
					status: 'error',
					reason: expect.stringContaining('no step left'),
				});
				expect(finish.mock.calls).toEqual([['applied'], ['uncertain']]);
				expect(read(file)).toBe(tasks(2, 1));
			});

			it('settles a revoked running attempt once as uncertain', async () => {
				const file = doc('tasks', tasks(1));
				script = [{ text: 'Working.', hang: true }];
				const { authority } = fleetAuthority();
				const owner = new AbortController();
				const finish = vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined);
				const runtime = await startEnrolled(authority, () => ({
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
					lifetime: { signal: owner.signal, current: () => !owner.signal.aborted, finish },
				}));
				const run = watchRun(runtime);
				value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
				await vi.waitFor(() => expect(envFiles.some((file) => fs.existsSync(file))).toBe(true));
				owner.abort();
				await run.ended();
				expect(run.outcome()).toEqual({ status: 'stopped' });
				expect(finish.mock.calls).toEqual([['uncertain']]);
				expect(read(file)).toBe(tasks(1));
			});

			it.each([true, false])(
				'holds the run until settlement finishes with success=%s',
				async (success) => {
					const file = doc('tasks', tasks(1));
					script = [{ text: 'Finished task one. Done.', tick: file }];
					const { authority } = fleetAuthority();
					const pending = Promise.withResolvers<void>();
					const owner = new AbortController();
					const removed = vi.spyOn(owner.signal, 'removeEventListener');
					const finish = vi.fn<WorkflowFenceLifetime['finish']>(() => pending.promise);
					const runtime = await startEnrolled(authority, () => ({
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
						lifetime: { signal: owner.signal, current: () => !owner.signal.aborted, finish },
					}));
					const run = watchRun(runtime);
					value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
					try {
						await vi.waitFor(() => expect(finish).toHaveBeenCalledWith('applied'));
						expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
						expect(run.outcomes).toEqual([]);
						expect(runtime.runs.activeRuns()).toHaveLength(1);
						expect(
							errorOf(await runtime.autoRun.launch('a1', { documents: [{ file }] }))
						).toMatchObject({
							code: 'rejected',
							message: expect.stringContaining('busy'),
						});
					} finally {
						if (success) pending.resolve();
						else pending.reject(new Error('release failed'));
						removed.mockRestore();
					}
					await run.ended();
					expect(run.outcome()).toEqual(
						success
							? { status: 'completed' }
							: {
									status: 'error',
									reason: 'Workflow settlement remains uncertain: release failed',
								}
					);
					expect(runtime.runs.activeRuns()).toEqual([]);
				}
			);
		});

		it("parks the run on the producer's own refusal, with its state and code, and asks the authority nothing", async () => {
			const file = doc('tasks', tasks(1));
			const { authority, asked } = fleetAuthority();
			const runtime = await startEnrolled(authority, async (workflow) => ({
				fence: null,
				state: 'denied',
				code: 'policy-denied',
				message: `Workflow "${workflow.workflowId}" is fenced: the registry holds another owner.`,
			}));
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.paused();
			expect(
				run
					.frames()
					.filter((frame) => frame.pause)
					.pop()?.pause
			).toMatchObject({
				type: 'permission_denied',
				// A denial is a decision nobody retries into.
				recoverable: false,
				message: expect.stringMatching(/^Workflow "runtime-a1-\d+" is fenced/),
			});
			expect(asked).toEqual([]);
			expect(runLaunches).toEqual([]);

			value(await runtime.autoRun.abort('a1'));
			await run.ended();
			expect(run.outcome()).toEqual({ status: 'stopped' });
		});

		it("admits each task on the run's lineage: the workflow with its fence, the run id, one request per task, the fence claimed per attempt", async () => {
			const file = doc('tasks', tasks(2));
			script = [
				{ text: 'Finished task one. Done.', tick: file },
				{ text: 'Finished task two. Done.', tick: file },
			];
			const { authority, asked } = fleetAuthority();
			const claims: Array<{ workflowId: string; runId: string; attemptId: string }> = [];
			const runtime = await startEnrolled(authority, (workflow, run) => {
				claims.push({ workflowId: workflow.workflowId, ...run });
				return { ownerEpoch: 'epoch-1', fencingToken: 'fence-1' };
			});
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			expect(run.outcome()).toEqual({ status: 'completed' });
			expect(read(file)).toBe(tasks(2, 2));
			expect(runLaunches).toHaveLength(2);
			expect(asked).toHaveLength(2);
			const contexts = asked.map((request) => request.context);
			// One claim per attempt, for the request and attempt the authority then saw.
			expect(claims).toEqual(
				contexts.map((context) => ({
					workflowId: context.workflow?.workflowId,
					runId: context.identity.requestId,
					attemptId: context.identity.attemptId,
				}))
			);
			const runId = contexts[0].identity.rootRunId;
			expect(runId).toEqual(expect.any(String));
			// The playbook id the runtime minted carries the launch time; the trigger event names the same launch.
			const startedAt = contexts[0].workflow?.workflowId.slice('runtime-a1-'.length);
			expect(startedAt).toMatch(/^\d+$/);
			for (const context of contexts) {
				expect(context).toMatchObject({
					origin: 'headless',
					// No actor is registered for this process, so the installation's operator is the principal.
					actor: { kind: 'human', id: `operator:${runtime.installation.installationId}` },
					delegation: { chain: [], grantRef: null },
					workflow: {
						workflowId: expect.stringMatching(/^runtime-a1-/),
						version: autoRunWorkflowVersion(['tasks']),
						triggerEventId: `cli:autoRun.launch:a1:${startedAt}`,
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
					},
					identity: { rootRunId: runId, parentRunId: runId },
					policyRevision: 1,
				});
			}
			// One logical request per task, each its own run under the Auto Run's root.
			expect(new Set(contexts.map((context) => context.identity.requestId)).size).toBe(2);
			expect(new Set(contexts.map((context) => context.identity.runId)).size).toBe(2);
			expect(asked.map((request) => request.snapshot.operation)).toEqual(['start', 'start']);
		});
	});

	describe('how a run ended', () => {
		it('says the engine failed, with what it threw, instead of passing the run off as done', async () => {
			const file = doc('tasks', tasks(2));
			// No step for the first task: the provider throws out of the engine.
			script = [];
			const runtime = await start();
			const run = watchRun(runtime);

			value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
			await run.ended();

			expect(run.outcome()).toEqual({
				status: 'error',
				reason: expect.stringContaining('no step left'),
			});
			// The progress frames alone could not tell: they end in `null` as a finished run's do.
			expect(run.events[run.events.length - 1]).toMatchObject({ kind: 'state', state: null });
			expect(runtime.runs.activeRuns()).toEqual([]);
		});

		it("reads each of the engine's closing events", () => {
			const at = { timestamp: 1 };
			expect(outcomeOfEngineEvent({ ...at, type: 'complete', success: true })).toEqual({
				status: 'completed',
			});
			expect(
				outcomeOfEngineEvent({ ...at, type: 'complete', success: false, stopped: true })
			).toEqual({ status: 'stopped' });
			expect(
				outcomeOfEngineEvent({
					...at,
					type: 'complete',
					success: false,
					halted: true,
					haltReason: 'the build is red',
				})
			).toEqual({ status: 'failed', reason: 'the run halted: the build is red' });
			expect(
				outcomeOfEngineEvent({
					...at,
					type: 'error',
					message: 'No unchecked tasks found in any documents',
					code: 'NO_TASKS',
				})
			).toEqual({ status: 'failed', reason: 'No unchecked tasks found in any documents' });
			expect(
				outcomeOfEngineEvent({
					...at,
					type: 'goal_complete',
					success: false,
					exitReason: 'stopped-by-user',
				})
			).toEqual({ status: 'stopped' });
			expect(
				outcomeOfEngineEvent({
					...at,
					type: 'goal_complete',
					success: false,
					exitReason: 'stalled',
					exitDetail: 'No progress in 3 iterations.',
				})
			).toEqual({ status: 'failed', reason: 'the goal was not met: No progress in 3 iterations.' });
			expect(outcomeOfEngineEvent({ ...at, type: 'task_complete' })).toBeUndefined();
		});
	});
});
