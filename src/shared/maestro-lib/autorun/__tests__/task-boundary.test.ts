/**
 * The cooperative task boundary (MCOMP-29-01A): the engine awaits a managed run's boundary before
 * every task dispatch, so a management pause parks the run between tasks (never inside one), a
 * resume releases it, and a cancel stops it there. The gate is the real
 * `createCooperativePauseGate`; its settle records what the command ledger would be told.
 */
import { describe, expect, it } from 'vitest';
import type { Playbook } from '../../../types';
import {
	COOPERATIVE_PAUSE_MODE,
	createCooperativePauseGate,
	type CommandEffect,
	type ManagedRuntimeCommand,
} from '../../managed/commands';
import { createRunController } from '../run-control';
import { runPlaybook } from '../run-playbook';
import type { AutoRunEvent } from '../engine-types';
import { collect, createFakeDeps, session, tickFirstTask } from './fake-deps';

const RUN = 'workflow-run-1';

const playbook: Playbook = {
	id: 'pb-1',
	name: 'Test Playbook',
	createdAt: 0,
	updatedAt: 0,
	prompt: 'Do the task',
	documents: [{ filename: 'tasks', resetOnCompletion: false }],
	loopEnabled: false,
};

/** The gate reads only the command id; the executor has already checked the rest. */
const command = (commandId: string) => ({ commandId }) as unknown as ManagedRuntimeCommand;

function harness(doc = '- [ ] one\n- [ ] two\n') {
	const settled: Array<{ commandId: string; effect: CommandEffect; detail?: string | null }> = [];
	const gate = createCooperativePauseGate({
		settle: async (commandId, effect, detail) => {
			settled.push({ commandId, effect, detail });
		},
		now: () => 0,
	});
	const tracked = gate.track(RUN);
	const fake = createFakeDeps({ tasks: doc });
	fake.deps.boundary = tracked;
	return { gate, tracked, fake, settled };
}

/** Resolves once the engine has parked at a boundary (the gate says `paused`). */
async function parked(gate: ReturnType<typeof createCooperativePauseGate>): Promise<void> {
	for (let i = 0; i < 200 && gate.state(RUN) !== 'paused'; i++) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	expect(gate.state(RUN)).toBe('paused');
}

const taskTurns = (requests: Array<{ purpose: string }>) =>
	requests.filter((r) => r.purpose === 'task').length;

describe('the engine at a cooperative task boundary', () => {
	it('parks between two tasks on a pause, finishing the task in flight, and runs on after resume', async () => {
		const { gate, fake, settled } = harness();
		let accepted: unknown;
		fake.onTurn = async (_request, f) => {
			// The pause arrives while the first task is running: that task still finishes.
			if (taskTurns(f.requests) === 1) accepted = await gate.pause(RUN, command('p-1'));
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'done' };
		};

		const run = collect(runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps));
		await parked(gate);

		expect(accepted).toMatchObject({
			outcome: 'accepted',
			facts: { mode: COOPERATIVE_PAUSE_MODE, osSuspension: false },
		});
		expect(taskTurns(fake.requests)).toBe(1);
		expect(fake.docs.get('tasks')).toBe('- [x] one\n- [ ] two\n');
		// Reaching the boundary is what completes the pause, exactly once.
		expect(settled).toEqual([
			expect.objectContaining({
				commandId: 'p-1',
				effect: expect.objectContaining({ state: 'settled', outcome: 'completed' }),
			}),
		]);

		await expect(gate.resume(RUN, command('r-1'))).resolves.toMatchObject({
			outcome: 'completed',
		});
		const events = await run;

		expect(taskTurns(fake.requests)).toBe(2);
		expect(fake.docs.get('tasks')).toBe('- [x] one\n- [x] two\n');
		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 2,
		});
		expect(gate.state(RUN)).toBe('running');
	});

	it('withdraws a pause the run has not reached yet: no park, the pause settles no-effect', async () => {
		const { gate, fake, settled } = harness();
		fake.onTurn = async (_request, f) => {
			if (taskTurns(f.requests) === 1) {
				await gate.pause(RUN, command('p-1'));
				await gate.resume(RUN, command('r-1'));
			}
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'done' };
		};

		const events = await collect(
			runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps)
		);

		expect(taskTurns(fake.requests)).toBe(2);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
		expect(settled).toEqual([
			expect.objectContaining({
				commandId: 'p-1',
				effect: expect.objectContaining({ outcome: 'no-effect' }),
			}),
		]);
	});

	it('stops a run parked at its boundary on a cancel, dispatching nothing more', async () => {
		const { gate, fake } = harness();
		fake.onTurn = async (_request, f) => {
			if (taskTurns(f.requests) === 1) await gate.pause(RUN, command('p-1'));
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'done' };
		};

		const run = collect(runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps));
		await parked(gate);
		expect(gate.stop(RUN)).toBe(true);
		const events: AutoRunEvent[] = await run;

		expect(taskTurns(fake.requests)).toBe(1);
		expect(fake.docs.get('tasks')).toBe('- [x] one\n- [ ] two\n');
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: false, stopped: true });
		expect(fake.activity.at(-1)).toBe('end:agent-1');
	});

	it('stops at the boundary when a local stop lands while the run is parked', async () => {
		const { gate, fake } = harness();
		const controller = createRunController({ clock: fake.deps.clock });
		fake.deps.controller = controller;
		fake.onTurn = async (_request, f) => {
			if (taskTurns(f.requests) === 1) await gate.pause(RUN, command('p-1'));
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'done' };
		};

		const run = collect(runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps));
		await parked(gate);
		// What the runtime's stop does: ask the controller, and wake the parked boundary.
		controller.requestStop();
		gate.stop(RUN);
		const events = await run;

		expect(taskTurns(fake.requests)).toBe(1);
		expect(events.at(-1)).toMatchObject({ type: 'complete', stopped: true });
	});

	it('settles a pause still pending when the run ends as no-effect once the owner ends it', async () => {
		const { gate, tracked, fake, settled } = harness('- [ ] only\n');
		fake.onTurn = async (_request, f) => {
			// Asked during the last task: there is no later boundary to reach.
			await gate.pause(RUN, command('p-1'));
			f.docs.set('tasks', tickFirstTask(f.docs.get('tasks') ?? ''));
			return { success: true, response: 'done' };
		};

		const events = await collect(
			runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps)
		);
		expect(events.at(-1)).toMatchObject({ type: 'complete', success: true });
		expect(settled).toEqual([]);

		await tracked.end();

		expect(settled).toEqual([
			expect.objectContaining({
				commandId: 'p-1',
				effect: expect.objectContaining({ outcome: 'no-effect' }),
			}),
		]);
		expect(gate.state(RUN)).toBeNull();
	});

	it('waits at no boundary without one: a run with no managed host is unchanged', async () => {
		const fake = createFakeDeps({ tasks: '- [ ] one\n- [ ] two\n' });

		const events = await collect(
			runPlaybook(session(), playbook, '/p', { skipSynopsis: true }, fake.deps)
		);

		expect(events.at(-1)).toMatchObject({
			type: 'complete',
			success: true,
			totalTasksCompleted: 2,
		});
	});
});
