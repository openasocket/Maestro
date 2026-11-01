/**
 * @file pianola-supervisor.test.ts
 *
 * Unit tests for the supervised-daemon lifecycle: spawn, unexpected-exit
 * backoff, restart cap, clean-exit handling, the intentional-stop flag, the
 * stable-run reset, reconcile spawn/stop, kind-aware liveness/relaunch, the
 * health log buffer, and Encore-off teardown.
 *
 * No real processes: a fake ChildProcess (an EventEmitter with .pid/.kill and
 * stdout/stderr EventEmitters) is injected via the supervisor's spawnChild dep,
 * and fake timers drive backoff and stable-run timing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

// The store read/path are stubbed so reconcile/relaunch work off a controllable
// target list without touching electron, fs, or a real watcher.
vi.mock('../../../main/pianola/pianola-store-main', () => ({
	readSupervisorTargets: vi.fn(() => []),
	writeSupervisorTargets: vi.fn(),
	removeSupervisorTarget: vi.fn(() => []),
	supervisorFilePath: vi.fn(() => '/fake/maestro-pianola-supervisor.json'),
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({
	resolveMaestroCliScriptPath: () => '/fake/maestro-cli.js',
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('fs', () => ({
	existsSync: vi.fn(() => true),
	watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() })),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Force the POSIX kill path so killProcess uses child.kill (our spy) instead of
// shelling out to taskkill against a fake pid on Windows.
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: () => false,
	// Decides where the stop ladder reads the process table from.
	isLinux: () => process.platform === 'linux',
}));

import { PianolaSupervisor, type AutoWatchSession } from '../../../main/pianola/pianola-supervisor';
import {
	readSupervisorTargets,
	removeSupervisorTarget,
	writeSupervisorTargets,
} from '../../../main/pianola/pianola-store-main';
import { captureException } from '../../../main/utils/sentry';
import * as fs from 'fs';
import { PIANOLA_WATCH_RETIRED_EXIT_CODE } from '../../../shared/pianola/pianola-watcher';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';

// Mirror the (unexported) source constants so timing assertions stay in sync.
const MAX_RESTARTS = 5;
const BACKOFF_CAP_MS = 30_000;
const STABLE_RUN_MS = 60_000;

/** A child stream stub: an EventEmitter that also answers setEncoding. */
class FakeStream extends EventEmitter {
	setEncoding(): this {
		return this;
	}
}

/** Minimal ChildProcess double the supervisor can drive in tests. */
class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	killed = false;
	lastSignal: NodeJS.Signals | number | undefined;

	constructor(readonly pid: number) {
		super();
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.lastSignal = signal;
		return true;
	}

	/** Simulate the OS reporting this child exited. */
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}

	/** Simulate a line of stdout. */
	emitStdout(data: string): void {
		this.stdout.emit('data', data);
	}

	/** Simulate a line of stderr. */
	emitStderr(data: string): void {
		this.stderr.emit('data', data);
	}
}

let spawned: FakeChild[];
let spawnArgs: string[][];
let pidSeq: number;
let enabled: boolean;
let sup: PianolaSupervisor;

function makeSupervisor(storedSessions?: AutoWatchSession[]): PianolaSupervisor {
	return new PianolaSupervisor({
		getStoredSessions: storedSessions ? () => storedSessions : undefined,
		isEnabled: () => enabled,
		getPianolaAgentId: () => 'pianola-agent',
		spawnChild: (_command, args) => {
			spawnArgs.push([...args]);
			const child = new FakeChild(++pidSeq);
			spawned.push(child);
			return child as unknown as ChildProcess;
		},
	});
}

function watchTarget(id = 'w1', enabledFlag = true): PianolaSupervisedTarget {
	return { id, kind: 'watch', enabled: enabledFlag, createdAt: 0, tabId: 't1', agentId: 'a1' };
}

function orchestrateTarget(id = 'o1', enabledFlag = true): PianolaSupervisedTarget {
	return { id, kind: 'orchestrate', enabled: enabledFlag, createdAt: 0, planId: 'p1' };
}

function setTargets(targets: PianolaSupervisedTarget[]): void {
	vi.mocked(readSupervisorTargets).mockReturnValue(targets);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.setSystemTime(0);
	spawned = [];
	spawnArgs = [];
	pidSeq = 0;
	enabled = true;
	vi.mocked(readSupervisorTargets).mockReturnValue([]);
	sup = makeSupervisor();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('PianolaSupervisor automatic watches', () => {
	it('starts manual watches when startup pruning cannot be persisted', () => {
		const error = new Error('read-only store');
		setTargets([
			{ ...watchTarget('orphan'), agentId: 'gone', autoCreated: true },
			watchTarget('manual'),
		]);
		vi.mocked(writeSupervisorTargets).mockImplementationOnce(() => {
			throw error;
		});
		sup = makeSupervisor([{ id: 'a1', aiTabs: [{ id: 't1' }] }]);
		expect(() => sup.start()).not.toThrow();
		expect(fs.watch).toHaveBeenCalled();
		expect(sup.getHealth()).toContainEqual(
			expect.objectContaining({ id: 'manual', state: 'running' })
		);
		expect(captureException).toHaveBeenCalledWith(error, {
			operation: 'pianola:supervisor:pruneAutoWatches',
		});
		sup.stopAll();
	});

	it('prunes orphaned automatic watches before starting children, preserving manual targets', () => {
		const orphan = { ...watchTarget('orphan'), agentId: 'gone', autoCreated: true };
		const retained = [
			{ ...watchTarget('existing'), autoCreated: true },
			{ ...watchTarget('manual'), agentId: 'gone' },
			orchestrateTarget(),
		];
		setTargets([orphan, ...retained]);
		vi.mocked(writeSupervisorTargets).mockImplementation((targets) => {
			setTargets(targets);
			return targets;
		});
		sup = makeSupervisor([{ id: 'a1', aiTabs: [{ id: 't1' }] }]);
		sup.start();
		expect(writeSupervisorTargets).toHaveBeenCalledWith(retained);
		expect(
			sup
				.getHealth()
				.map((target) => target.id)
				.sort()
		).toEqual(['existing', 'manual', 'o1']);
		sup.stopAll();
	});

	it('registers only new top-level agents and waits for an AI tab', () => {
		vi.mocked(writeSupervisorTargets).mockImplementation((targets) => {
			setTargets(targets);
			return targets;
		});
		const newAgent = { id: 'new', aiTabs: [] as Array<{ id: string }>, activeTabId: 'file' };
		const pianola = { id: 'manager', isPianola: true, aiTabs: [{ id: 'manager-tab' }] };
		const child = { id: 'child', parentSessionId: 'new', aiTabs: [{ id: 'child-tab' }] };
		sup.autoWatchNewSessions([newAgent, pianola, child], [newAgent, pianola, child], true);
		expect(writeSupervisorTargets).not.toHaveBeenCalled();

		const ready = { ...newAgent, aiTabs: [{ id: 'ai-tab' }] };
		sup.autoWatchNewSessions([], [ready, pianola, child], true);
		expect(writeSupervisorTargets).toHaveBeenCalledOnce();
		expect(vi.mocked(writeSupervisorTargets).mock.calls[0][0]).toEqual([
			expect.objectContaining({ kind: 'watch', agentId: 'new', tabId: 'ai-tab', enabled: true }),
		]);
		expect(spawned).toHaveLength(1);
		sup.autoWatchNewSessions([], [ready], true);
		expect(writeSupervisorTargets).toHaveBeenCalledOnce();
	});

	it('respects the option, Encore gate, and existing disabled watches', () => {
		const fresh = { id: 'fresh', aiTabs: [{ id: 'tab' }] };
		sup.autoWatchNewSessions([fresh], [fresh], false);
		expect(writeSupervisorTargets).not.toHaveBeenCalled();
		enabled = false;
		sup.autoWatchNewSessions([fresh], [fresh], true);
		expect(writeSupervisorTargets).not.toHaveBeenCalled();
		enabled = true;
		setTargets([{ ...watchTarget(), agentId: 'fresh', enabled: false }]);
		sup.autoWatchNewSessions([fresh], [fresh], true);
		expect(writeSupervisorTargets).not.toHaveBeenCalled();
	});

	it('retires only automatically created watches when agents close', () => {
		const automatic = { ...watchTarget('auto'), agentId: 'closed', autoCreated: true };
		const manual = { ...watchTarget('manual'), agentId: 'closed' };
		setTargets([automatic, manual]);
		vi.mocked(writeSupervisorTargets).mockImplementation((targets) => {
			setTargets(targets);
			return targets;
		});
		sup.autoWatchNewSessions([], [], false, ['closed']);
		expect(writeSupervisorTargets).toHaveBeenCalledWith([manual]);
	});
});

describe('PianolaSupervisor spawn + exit lifecycle', () => {
	it('schedules a backoff on an unexpected exit', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		spawned[0].exit(1);

		const [health] = sup.getHealth();
		expect(health.state).toBe('backing-off');
		expect(health.restarts).toBe(1);
		expect(health.lastError).toContain('code 1');
	});

	it('marks a target failed after exceeding MAX_RESTARTS', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		for (let i = 0; i <= MAX_RESTARTS; i++) {
			spawned[spawned.length - 1].exit(1);
			if (sup.getHealth()[0]?.state === 'failed') break;
			// Fire the backoff timer to respawn the next crashing child.
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
		}

		const [health] = sup.getHealth();
		expect(health.state).toBe('failed');
		expect(health.restarts).toBe(MAX_RESTARTS + 1);
	});

	it('stops without scheduling a restart on a clean exit (code 0)', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].exit(0);

		expect(sup.getHealth()[0].state).toBe('stopped');
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
	});

	it('does not restart when the stopping flag is set', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		// Disabling the target marks the child stopping and kills it.
		setTargets([watchTarget('w1', false)]);
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);

		// A crash-code exit after an intentional stop must not trigger a restart.
		spawned[0].exit(1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
	});

	it('resets the restart counter after a stable run', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].exit(1);
		vi.advanceTimersByTime(1000); // fire the first backoff -> respawn
		expect(spawned).toHaveLength(2);
		expect(sup.getHealth()[0].restarts).toBe(1);

		// The respawned child runs long enough to count as recovered.
		vi.advanceTimersByTime(STABLE_RUN_MS);
		spawned[1].exit(1);

		// Reset to 0 on the stable run, then +1 for this fresh failure: 1, not 2.
		expect(sup.getHealth()[0].restarts).toBe(1);
		expect(sup.getHealth()[0].state).toBe('backing-off');
	});
});

describe('PianolaSupervisor watch retirement', () => {
	it('removes a watch target that exits with the retired code and never relaunches it', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].exit(PIANOLA_WATCH_RETIRED_EXIT_CODE);

		expect(removeSupervisorTarget).toHaveBeenCalledWith('w1');
		expect(sup.getHealth()).toHaveLength(0);
		// The store write is what keeps it gone; simulate the file now lacking it.
		setTargets([]);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(1);
	});

	it('treats the retired code from an orchestrate target as an ordinary failure', () => {
		setTargets([orchestrateTarget()]);
		sup.reconcile();

		spawned[0].exit(PIANOLA_WATCH_RETIRED_EXIT_CODE);

		expect(removeSupervisorTarget).not.toHaveBeenCalled();
		expect(sup.getHealth()[0].state).toBe('backing-off');
	});

	it('passes a target idle timeout through to the watch command', () => {
		setTargets([{ ...watchTarget(), idleHours: 2 }, watchTarget('w2')]);
		sup.reconcile();

		expect(spawnArgs[0]).toEqual(expect.arrayContaining(['--idle-hours', '2']));
		expect(spawnArgs[1]).not.toContain('--idle-hours');
	});
});

describe('PianolaSupervisor reconcile', () => {
	it('spawns an enabled target with no child and stops a removed one', () => {
		setTargets([watchTarget('w1'), orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned).toHaveLength(2);
		expect(
			sup
				.getHealth()
				.map((h) => h.id)
				.sort()
		).toEqual(['o1', 'w1']);

		// Removing w1 should stop and forget its child but leave o1 running.
		setTargets([orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);
		expect(sup.getHealth().map((h) => h.id)).toEqual(['o1']);
	});

	it('kills all children when Encore is off', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(spawned).toHaveLength(1);

		enabled = false;
		sup.reconcile();
		expect(spawned[0].killed).toBe(true);
		expect(sup.getHealth()).toHaveLength(0);
	});
});

describe('PianolaSupervisor stopAll', () => {
	it('kills every child and clears the health snapshot', () => {
		setTargets([watchTarget('w1'), orchestrateTarget('o1')]);
		sup.reconcile();
		expect(spawned).toHaveLength(2);

		sup.stopAll();

		expect(spawned[0].killed).toBe(true);
		expect(spawned[1].killed).toBe(true);
		expect(sup.getHealth()).toHaveLength(0);
	});
});

describe('PianolaSupervisor kind-aware relaunch', () => {
	it('relaunches a stopped enabled watch target (stale)', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		spawned[0].exit(0); // a watch that cleanly exits should be relaunched
		expect(sup.getHealth()[0].state).toBe('stopped');

		expect(sup.relaunchStale()).toBe(1);
		expect(spawned).toHaveLength(2);
		expect(sup.getHealth()[0].state).toBe('running');
	});

	it('does not relaunch a stopped orchestrate target (terminal)', () => {
		setTargets([orchestrateTarget()]);
		sup.reconcile();
		spawned[0].exit(0); // an orchestrate plan finishing is terminal
		expect(sup.getHealth()[0].state).toBe('stopped');

		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(1);
	});

	it('does not relaunch a running target', () => {
		setTargets([watchTarget()]);
		sup.reconcile();
		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(1);
	});

	it('does not relaunch a disabled target', () => {
		setTargets([watchTarget('w1', false)]);
		sup.reconcile();
		expect(spawned).toHaveLength(0);
		expect(sup.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(0);
	});
});

describe('PianolaSupervisor health log buffer', () => {
	it('exposes recent child logs in the health snapshot', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		spawned[0].emitStdout('line a\nline b\n');
		spawned[0].emitStderr('err c\n');

		expect(sup.getHealth()[0].recentLogs).toEqual(['line a', 'line b', 'err c']);
	});

	it('bounds recentLogs to the most recent lines', () => {
		setTargets([watchTarget()]);
		sup.reconcile();

		for (let i = 0; i < 120; i++) spawned[0].emitStdout(`line ${i}\n`);

		const logs = sup.getHealth()[0].recentLogs;
		expect(logs).toHaveLength(50);
		expect(logs[0]).toBe('line 70');
		expect(logs[49]).toBe('line 119');
	});
});

/**
 * GT1-08-20A: standalone supervision of Grok work. The supervisor launches
 * maestro-cli for a Grok agent's watcher or a plan of Grok tasks, never a
 * provider binary, and every restart, retirement and cancellation keeps the
 * same agent, tab and plan: no provider word enters the argv, a failed launch
 * retries the same command, and a cancelled target is never relaunched.
 * (The managed admission cases are GT1-08-20, pianola-supervisor.managed.test.ts.)
 */
describe('PianolaSupervisor with Grok targets (GT1-08-20A)', () => {
	let launches: Array<{ command: string; env: NodeJS.ProcessEnv | undefined }>;
	let failNextSpawn: NodeJS.ErrnoException | null;

	const grokWatch = (
		overrides: Partial<PianolaSupervisedTarget> = {}
	): PianolaSupervisedTarget => ({
		id: 'grok-watch',
		kind: 'watch',
		enabled: true,
		createdAt: 0,
		tabId: 'grok-tab',
		agentId: 'grok-agent-7',
		intervalSeconds: 9,
		...overrides,
	});
	const grokPlan = (overrides: Partial<PianolaSupervisedTarget> = {}): PianolaSupervisedTarget => ({
		id: 'grok-orch',
		kind: 'orchestrate',
		enabled: true,
		createdAt: 0,
		planId: 'grok-plan',
		concurrency: 2,
		intervalSeconds: 7,
		...overrides,
	});
	const GROK_WATCH_ARGS = [
		'/fake/maestro-cli.js',
		'pianola',
		'watch',
		'grok-tab',
		'--agent',
		'grok-agent-7',
		'--interval',
		'9',
	];
	const GROK_PLAN_ARGS = [
		'/fake/maestro-cli.js',
		'pianola',
		'orchestrate',
		'grok-plan',
		'--concurrency',
		'2',
		'--interval',
		'7',
	];

	function grokSupervisor(storedSessions?: AutoWatchSession[]): PianolaSupervisor {
		return new PianolaSupervisor({
			getStoredSessions: storedSessions ? () => storedSessions : undefined,
			isEnabled: () => enabled,
			getPianolaAgentId: () => 'pianola-agent',
			spawnChild: (command, args, opts) => {
				if (failNextSpawn) {
					const error = failNextSpawn;
					failNextSpawn = null;
					throw error;
				}
				launches.push({ command, env: opts?.env });
				spawnArgs.push([...args]);
				const child = new FakeChild(++pidSeq);
				spawned.push(child);
				return child as unknown as ChildProcess;
			},
		});
	}

	beforeEach(() => {
		launches = [];
		failNextSpawn = null;
	});

	it('launches maestro-cli for a Grok watcher with the Pianola lineage and no provider binary', () => {
		const s = grokSupervisor();
		setTargets([grokWatch({ idleHours: 3 })]);
		s.reconcile();
		expect(spawnArgs).toEqual([[...GROK_WATCH_ARGS, '--idle-hours', '3']]);
		expect(launches[0].command).toBe(process.execPath);
		expect(launches[0].env).toMatchObject({
			ELECTRON_RUN_AS_NODE: '1',
			MAESTRO_AGENT_ID: 'pianola-agent',
			MAESTRO_CLI_JS: '/fake/maestro-cli.js',
		});
		expect(spawnArgs[0].join(' ')).not.toMatch(/claude|codex|grok-cli|--model|--account/);
		s.stopAll();
	});

	it('auto-watches a new top-level Grok agent on its active AI tab, not its sub-agent, and retires it on close', () => {
		vi.mocked(writeSupervisorTargets).mockImplementation((targets) => {
			setTargets(targets);
			return targets;
		});
		const s = grokSupervisor();
		const grokAgent = {
			id: 'grok-agent-7',
			activeTabId: 'grok-tab-2',
			aiTabs: [{ id: 'grok-tab-1' }, { id: 'grok-tab-2' }],
		};
		const grokChild = {
			id: 'grok-sub',
			parentSessionId: 'grok-agent-7',
			aiTabs: [{ id: 'sub-tab' }],
		};
		s.autoWatchNewSessions([grokAgent, grokChild], [grokAgent, grokChild], true);
		expect(vi.mocked(writeSupervisorTargets).mock.calls[0][0]).toEqual([
			expect.objectContaining({
				kind: 'watch',
				agentId: 'grok-agent-7',
				tabId: 'grok-tab-2',
				autoCreated: true,
			}),
		]);
		expect(spawnArgs).toHaveLength(1);
		expect(spawnArgs[0]).toEqual(expect.arrayContaining(['grok-tab-2', '--agent', 'grok-agent-7']));
		expect(spawnArgs.flat()).not.toContain('grok-sub');

		s.autoWatchNewSessions([], [], false, ['grok-agent-7']);
		expect(vi.mocked(writeSupervisorTargets).mock.calls.at(-1)?.[0]).toEqual([]);
		s.stopAll();
	});

	it('retries a Grok watcher whose launch failed with the same command and reports no crash for ENOENT', () => {
		const s = grokSupervisor();
		failNextSpawn = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
		setTargets([grokWatch()]);
		s.reconcile();
		expect(spawned).toHaveLength(0);
		expect(s.getHealth()[0]).toMatchObject({
			id: 'grok-watch',
			state: 'backing-off',
			restarts: 1,
			lastError: 'spawn node ENOENT',
		});
		expect(captureException).not.toHaveBeenCalled();
		vi.advanceTimersByTime(BACKOFF_CAP_MS);
		expect(spawnArgs).toEqual([GROK_WATCH_ARGS]);
		expect(s.getHealth()[0].state).toBe('running');
		s.stopAll();
	});

	it('restarts a crashing Grok watcher on the same agent and tab until the cap, then gives up', () => {
		const s = grokSupervisor();
		setTargets([grokWatch()]);
		s.reconcile();
		for (let i = 0; i <= MAX_RESTARTS; i++) {
			spawned[spawned.length - 1].exit(1);
			if (s.getHealth()[0]?.state === 'failed') break;
			vi.advanceTimersByTime(BACKOFF_CAP_MS);
		}
		expect(s.getHealth()[0]).toMatchObject({ state: 'failed', restarts: MAX_RESTARTS + 1 });
		expect(spawnArgs).toHaveLength(MAX_RESTARTS + 1);
		for (const args of spawnArgs) expect(args).toEqual(GROK_WATCH_ARGS);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 10);
		expect(spawned).toHaveLength(MAX_RESTARTS + 1);
	});

	it('removes a retired Grok watcher and never relaunches it', () => {
		const s = grokSupervisor();
		setTargets([grokWatch()]);
		s.reconcile();
		spawned[0].exit(PIANOLA_WATCH_RETIRED_EXIT_CODE);
		expect(removeSupervisorTarget).toHaveBeenCalledWith('grok-watch');
		setTargets([]);
		expect(s.relaunchStale()).toBe(0);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
	});

	it('cancels a pending Grok restart when the target is removed while backing off', () => {
		const s = grokSupervisor();
		setTargets([grokWatch()]);
		s.reconcile();
		spawned[0].exit(1);
		expect(s.getHealth()[0].state).toBe('backing-off');
		setTargets([]);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
		expect(s.getHealth()).toHaveLength(0);
	});

	it('does not relaunch a crashed Grok plan once Pianola is switched off', () => {
		const s = grokSupervisor();
		setTargets([grokPlan()]);
		s.reconcile();
		spawned[0].exit(1);
		enabled = false;
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
		expect(s.getHealth()[0].state).toBe('stopped');
	});

	it('relaunches a crashed Grok plan with the same plan, concurrency and interval, and a clean finish is terminal', () => {
		const s = grokSupervisor();
		setTargets([grokPlan()]);
		s.reconcile();
		spawned[0].exit(1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS);
		expect(spawnArgs).toEqual([GROK_PLAN_ARGS, GROK_PLAN_ARGS]);
		spawned[1].exit(0);
		expect(s.getHealth()[0].state).toBe('stopped');
		expect(s.relaunchStale()).toBe(0);
		expect(spawned).toHaveLength(2);
	});

	it('stops a running Grok watcher when it is disabled and ignores its crash-code exit', () => {
		const s = grokSupervisor();
		setTargets([grokWatch()]);
		s.reconcile();
		setTargets([grokWatch({ enabled: false })]);
		s.reconcile();
		expect(spawned[0].killed).toBe(true);
		spawned[0].exit(1);
		vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
		expect(spawned).toHaveLength(1);
		expect(s.relaunchStale()).toBe(0);
	});
});
