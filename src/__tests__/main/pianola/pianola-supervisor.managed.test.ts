/**
 * The Pianola supervisor under management (MRC2-02-05, MRC2-02-07).
 *
 * Same doubles as pianola-supervisor.test.ts (a fake ChildProcess through the
 * `spawnChild` dep, fake timers), with the port the REAL lease authority and
 * verifier behind `fakeSpawnPort` (only the policy answer is a table). Each
 * guard here has a test that fails when the guard is removed:
 *
 * - a denied child never starts, reports `denied` with the authority's answer,
 *   and enters no retry: the backoff ladder is for a child that died, so a
 *   denial costs one admission and no timer, however long the clock runs;
 * - a denied target is asked again only by a reconcile or the cadenced
 *   relaunch, once each; a target whose admission is in flight is left alone;
 * - an admitted child is bound on the exact spawn (`purpose: supervisor`, the
 *   pianola service on the chain) and the lease follows its exit, its crash
 *   and its revocation, which stops the child and leaves it denied for good;
 * - an unavailable authority is reported by its own state, not as a denial;
 * - a standalone port and no port spawn synchronously and ask nobody.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

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
// The POSIX kill path, so the stop ladder uses child.kill (the double) rather
// than taskkill against a fake pid.
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: () => false,
	isLinux: () => process.platform === 'linux',
}));

import { PianolaSupervisor } from '../../../main/pianola/pianola-supervisor';
import { readSupervisorTargets } from '../../../main/pianola/pianola-store-main';
import { logger } from '../../../main/utils/logger';
import type { PianolaSupervisedTarget } from '../../../shared/pianola/storage';
import type { PolicyDecision } from '../../../shared/maestro-lib/managed/authority';
import { fakeSpawnPort, type FakeSpawnPort } from '../../helpers/managedSpawnPort';

class FakeStream extends EventEmitter {
	setEncoding(): this {
		return this;
	}
}
class FakeChild extends EventEmitter {
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly stdout = new FakeStream();
	readonly stderr = new FakeStream();
	killed = false;
	constructor(readonly pid: number) {
		super();
	}
	kill(): boolean {
		this.killed = true;
		return true;
	}
	exit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}
}

let spawned: FakeChild[];
let spawnOpts: Array<Record<string, unknown>>;
let pidSeq: number;
let enabled: boolean;
/** Set to make the next spawn throw (a missing binary), once. */
let spawnFailure: Error | null;

function makeSupervisor(port: FakeSpawnPort | null): PianolaSupervisor {
	return new PianolaSupervisor({
		isEnabled: () => enabled,
		getPianolaAgentId: () => 'pianola-agent',
		spawnChild: (_command, _args, opts) => {
			if (spawnFailure) {
				const error = spawnFailure;
				spawnFailure = null;
				throw error;
			}
			spawnOpts.push(opts as Record<string, unknown>);
			const child = new FakeChild(++pidSeq);
			spawned.push(child);
			return child as unknown as ChildProcess;
		},
		managedPort: () => port,
	});
}

function watchTarget(id = 'w1'): PianolaSupervisedTarget {
	return { id, kind: 'watch', enabled: true, createdAt: 0, tabId: 't1', agentId: 'a1' };
}
function setTargets(targets: PianolaSupervisedTarget[]): void {
	vi.mocked(readSupervisorTargets).mockReturnValue(targets);
}
/** Let an in-flight admission settle (the authority answers over a few microtasks). */
const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};
const deny = (reason: string, policyRevision = 3): PolicyDecision => ({
	decision: 'deny',
	reason,
	policyRevision,
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.setSystemTime(0);
	spawned = [];
	spawnOpts = [];
	pidSeq = 0;
	enabled = true;
	spawnFailure = null;
	setTargets([]);
});
afterEach(() => {
	vi.useRealTimers();
});

describe('PianolaSupervisor under management: a denial starts nothing and retries nothing', () => {
	it('a denying policy starts no child, reports denied with the reason, and never retries on a timer', async () => {
		const port = fakeSpawnPort({ decide: () => deny('Pianola is off here') });
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		expect(spawned).toHaveLength(0);
		await flush();
		expect(spawned).toHaveLength(0);
		expect(port.asked).toHaveLength(1);
		const [health] = sup.getHealth();
		expect(health).toMatchObject({
			id: 'w1',
			state: 'denied',
			restarts: 0,
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(health.lastError).toMatch(/^\[managed-denied\] .*Pianola is off here/);
		expect(health.pid).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('not admitted (denied, policy-denied)'),
			'[PianolaSupervisor]'
		);
		// No retry storm: an hour of timers asks nobody and starts nothing.
		vi.advanceTimersByTime(60 * 60_000);
		await flush();
		expect(spawned).toHaveLength(0);
		expect(port.asked).toHaveLength(1);
		expect(sup.getHealth()[0]).toMatchObject({ state: 'denied', restarts: 0 });
		expect(port.authority.live()).toHaveLength(0);
		sup.stopAll();
	});

	it('a denied target is asked again by a reconcile and by the cadenced relaunch, once each', async () => {
		let decision: PolicyDecision = deny('no', 1);
		const port = fakeSpawnPort({ decide: () => decision });
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		expect(sup.getHealth()[0].state).toBe('denied');
		sup.reconcile();
		await flush();
		expect(port.asked).toHaveLength(2);
		expect(spawned).toHaveLength(0);
		decision = { decision: 'allow', policyRevision: 2 };
		expect(sup.relaunchStale()).toBe(1);
		await flush();
		expect(port.asked).toHaveLength(3);
		expect(spawned).toHaveLength(1);
		expect(sup.getHealth()[0]).toMatchObject({ state: 'running', pid: 1 });
		expect(sup.getHealth()[0].managed).toBeUndefined();
		sup.stopAll();
	});

	it('an unavailable authority is reported by its state, not a denial, and not retried', async () => {
		const port = fakeSpawnPort({
			decide: () => ({ decision: 'unavailable', reason: 'endpoint detached' }),
		});
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		expect(sup.getHealth()[0]).toMatchObject({
			state: 'denied',
			managed: { state: 'unavailable' },
		});
		expect(sup.getHealth()[0].lastError).toMatch(/^\[managed-unavailable\]/);
		vi.advanceTimersByTime(60_000);
		await flush();
		expect(spawned).toHaveLength(0);
		expect(port.asked).toHaveLength(1);
		sup.stopAll();
	});

	it('a policy that throws is answered unavailable by the authority; a port that throws is an answer lost (unknown); neither starts anything', async () => {
		const throwingPolicy = fakeSpawnPort({
			decide: () => {
				throw new Error('policy socket closed');
			},
		});
		const sup = makeSupervisor(throwingPolicy);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		expect(spawned).toHaveLength(0);
		expect(sup.getHealth()[0]).toMatchObject({
			state: 'denied',
			managed: { state: 'unavailable', code: 'runtime-unavailable' },
		});
		sup.stopAll();

		const throwingPort = fakeSpawnPort();
		throwingPort.verify = () => {
			throw new Error('verifier socket closed');
		};
		const lost = makeSupervisor(throwingPort);
		lost.start();
		await flush();
		expect(spawned).toHaveLength(0);
		expect(lost.getHealth()[0]).toMatchObject({
			state: 'denied',
			managed: { state: 'unknown', code: 'outcome-unknown' },
		});
		expect(lost.getHealth()[0].lastError).toContain('verifier socket closed');
		lost.stopAll();
	});
});

describe('PianolaSupervisor under management: an admitted child and its lease', () => {
	it('an allowed child is admitted on the exact spawn as the pianola service, bound, and released with its exit', async () => {
		const port = fakeSpawnPort();
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		expect(spawned).toHaveLength(0);
		await flush();
		expect(spawned).toHaveLength(1);
		const request = port.asked[0];
		expect(request.snapshot).toMatchObject({
			purpose: 'supervisor',
			origin: 'desktop',
			operation: 'start',
			provider: 'maestro-supervisor:pianola',
			executable: process.execPath,
			args: ['/fake/maestro-cli.js', 'pianola', 'watch', 't1', '--agent', 'a1', '--interval', '5'],
			cwd: process.cwd(),
			shell: false,
		});
		expect(request.snapshot.resourceIds).toEqual(['agent:a1', 'pianola-target:w1']);
		expect(request.snapshot.envKeys).toContain('ELECTRON_RUN_AS_NODE');
		expect(request.snapshot.envKeys).toContain('MAESTRO_AGENT_ID');
		expect(request.context.delegation.chain).toEqual([
			{ kind: 'service', id: 'maestro-supervisor:pianola' },
		]);
		expect(request.context.traceId).toBe('pianola-supervisor:w1');
		expect(spawnOpts[0]).toMatchObject({ cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
		const [lease] = port.authority.live();
		expect(lease.state()).toBe('bound');
		expect(lease.pid()).toBe(1);
		spawned[0].exit(0);
		expect(lease.state()).toBe('released');
		expect(lease.ended().release).toEqual({ outcome: 'exited', exitCode: 0, signal: null });
		expect(sup.getHealth()[0].state).toBe('stopped');
		sup.stopAll();
	});

	it('a crash re-asks the authority on every backoff respawn with a fresh lease', async () => {
		const port = fakeSpawnPort();
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		const first = port.authority.live()[0];
		spawned[0].exit(1);
		expect(first.state()).toBe('released');
		expect(sup.getHealth()[0].state).toBe('backing-off');
		vi.advanceTimersByTime(1000);
		await flush();
		expect(port.asked).toHaveLength(2);
		expect(spawned).toHaveLength(2);
		expect(port.authority.live()[0].leaseId).not.toBe(first.leaseId);
		sup.stopAll();
	});

	it('a spawn that fails releases the lease as spawn-failed and the backoff asks again', async () => {
		const port = fakeSpawnPort();
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		spawnFailure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
		sup.start();
		await flush();
		expect(spawned).toHaveLength(0);
		expect(port.authority.live()).toHaveLength(0);
		expect(sup.getHealth()[0]).toMatchObject({ state: 'backing-off', restarts: 1 });
		vi.advanceTimersByTime(1000);
		await flush();
		expect(port.asked).toHaveLength(2);
		expect(spawned).toHaveLength(1);
		expect(port.authority.live()[0].state()).toBe('bound');
		sup.stopAll();
	});

	it('a revocation stops the child, leaves it denied with the reason, and never restarts it', async () => {
		const port = fakeSpawnPort();
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		const [lease] = port.authority.live();
		expect(port.authority.revoke(lease.leaseId, 'policy revision 9 forbids pianola')).toBe(true);
		expect(spawned[0].killed).toBe(true);
		spawned[0].exit(null, 'SIGTERM');
		expect(lease.state()).toBe('revoked');
		expect(lease.ended().reason).toBe('policy revision 9 forbids pianola');
		expect(sup.getHealth()[0]).toMatchObject({
			state: 'denied',
			restarts: 0,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(sup.getHealth()[0].lastError).toContain('policy revision 9 forbids pianola');
		vi.advanceTimersByTime(60 * 60_000);
		await flush();
		expect(spawned).toHaveLength(1);
		expect(port.asked).toHaveLength(1);
		sup.stopAll();
	});

	it('a target stopped while the authority answers starts nothing and releases the lease unused', async () => {
		let resolve!: (d: PolicyDecision) => void;
		const port = fakeSpawnPort({
			decide: () => new Promise<PolicyDecision>((r) => (resolve = r)),
		});
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		await flush();
		expect(port.asked).toHaveLength(1);
		// Mid-flight the target is alive: neither a relaunch nor a reconcile asks twice.
		expect(sup.relaunchStale()).toBe(0);
		sup.reconcile();
		expect(port.asked).toHaveLength(1);
		setTargets([]);
		sup.reconcile();
		resolve({ decision: 'allow', policyRevision: 1 });
		await flush();
		expect(spawned).toHaveLength(0);
		expect(port.authority.live()).toHaveLength(0);
		expect(sup.getHealth()).toHaveLength(0);
		sup.stopAll();
	});
});

describe('PianolaSupervisor on a standalone host: unchanged', () => {
	it('a standalone port spawns synchronously and asks nobody; no port likewise', () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const sup = makeSupervisor(port);
		setTargets([watchTarget()]);
		sup.start();
		expect(spawned).toHaveLength(1);
		expect(port.asked).toHaveLength(0);
		expect(sup.getHealth()[0]).toMatchObject({ state: 'running', pid: 1 });
		expect(sup.getHealth()[0].managed).toBeUndefined();
		sup.stopAll();
		const bare = makeSupervisor(null);
		bare.start();
		expect(spawned).toHaveLength(2);
		expect(bare.getHealth()[0]).toMatchObject({ state: 'running', pid: 2 });
		bare.stopAll();
	});
});
