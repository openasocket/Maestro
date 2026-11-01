/**
 * @file pianola-orchestrate.test.ts
 * @description Tests for the Pianola orchestrate CLI loop. The key invariant: a
 * transient iteration error (e.g. a WS sendCommand timeout that rejects out of
 * runOrchestratorIteration) is logged and the run KEEPS GOING - it must not tear
 * down the whole orchestration. Mirrors the watcher's per-iteration try/catch.
 * The orchestration engine and the WebSocket client are mocked.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type {
	OrchestratorDeps,
	OrchestratorState,
} from '../../../shared/pianola/pianola-orchestrator';
import type {
	PianolaPlan,
	PianolaPlanProgress,
	PianolaTask,
} from '../../../shared/pianola/pianola-tasks';

const {
	connectMock,
	sendCommandMock,
	disconnectMock,
	runIterationMock,
	upsertAgentRunMock,
	appendAgentRunEventMock,
	getAgentRunMock,
	findActiveRunBySessionMock,
} = vi.hoisted(() => ({
	connectMock: vi.fn(),
	sendCommandMock: vi.fn(),
	disconnectMock: vi.fn(),
	runIterationMock: vi.fn(),
	upsertAgentRunMock: vi.fn(),
	appendAgentRunEventMock: vi.fn(),
	getAgentRunMock: vi.fn(),
	findActiveRunBySessionMock: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));
vi.mock('../../../cli/services/pianola-store', () => ({
	readPianolaPlans: vi.fn(() => []),
	getPianolaPlan: vi.fn(),
	upsertPianolaPlan: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = connectMock;
		sendCommand = sendCommandMock;
		disconnect = disconnectMock;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: vi.fn() }));
vi.mock('../../../shared/pianola/pianola-orchestrator', () => ({
	runOrchestratorIteration: runIterationMock,
	initialOrchestratorState: (plan: PianolaPlan): OrchestratorState => ({ plan, prevStates: {} }),
}));
vi.mock('../../../cli/services/agent-run-store', () => ({
	upsertAgentRun: upsertAgentRunMock,
	appendAgentRunEvent: appendAgentRunEventMock,
	getAgentRun: getAgentRunMock,
	findActiveRunBySession: findActiveRunBySessionMock,
}));

import {
	choosePianolaToolType,
	PIANOLA_COLD_START_TOOL_TYPE,
	pianolaOrchestrate,
	resolveExistingPianolaAgentType,
	type DesktopSessionEntry,
} from '../../../cli/commands/pianola-orchestrate';
import { readSettingValue } from '../../../cli/services/storage';
import { getPianolaPlan } from '../../../cli/services/pianola-store';
import { runDispatch } from '../../../cli/commands/dispatch';

const PLAN: PianolaPlan = { id: 'plan-1', title: 'P', createdAt: 1, tasks: [] };

const DONE_PROGRESS: PianolaPlanProgress = {
	total: 0,
	pending: 0,
	running: 0,
	done: 0,
	failed: 0,
	blocked: 0,
	skipped: 0,
	complete: true,
};

function doneResult(state: OrchestratorState) {
	return {
		state,
		progress: DONE_PROGRESS,
		completedTaskIds: [],
		failedTaskIds: [],
		dispatchedTaskIds: [],
		done: true,
	};
}

describe('pianolaOrchestrate - iteration error resilience', () => {
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		connectMock.mockResolvedValue(undefined);
		disconnectMock.mockReturnValue(undefined);
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		vi.mocked(getPianolaPlan).mockReturnValue(PLAN);
		getAgentRunMock.mockReturnValue(undefined);
		findActiveRunBySessionMock.mockReturnValue(undefined);
		upsertAgentRunMock.mockImplementation((run) => run);
		appendAgentRunEventMock.mockImplementation((event) => event);
	});

	it('logs a thrown iteration and keeps running until the plan completes', async () => {
		let calls = 0;
		runIterationMock.mockImplementation(async (state: OrchestratorState) => {
			calls += 1;
			if (calls === 1) throw new Error('ws timeout');
			return doneResult(state);
		});

		// interval '1' is the 1s minimum; the first tick throws, the loop logs and
		// sleeps, then the second tick completes the plan - proving the error did
		// not end the run.
		await pianolaOrchestrate('plan-1', { interval: '1' });

		expect(runIterationMock).toHaveBeenCalledTimes(2);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('iteration error: ws timeout'));
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it('still completes cleanly when the first iteration succeeds (happy path intact)', async () => {
		runIterationMock.mockImplementation(async (state: OrchestratorState) => doneResult(state));
		await pianolaOrchestrate('plan-1', {});
		expect(runIterationMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).not.toHaveBeenCalled();
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});

	it('records dispatched Pianola tasks into the AgentRun ledger', async () => {
		const plan: PianolaPlan = {
			id: 'plan-2',
			title: 'Ship',
			createdAt: 100,
			tasks: [
				{ id: 'task-1', title: 'Build', prompt: 'build it', dependsOn: [], status: 'pending' },
			],
		};
		const runningPlan: PianolaPlan = {
			...plan,
			tasks: [
				{
					...plan.tasks[0],
					status: 'running',
					agentId: 'agent-1',
					agentType: 'claude-code',
					tabId: 'tab-1',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(plan);
		runIterationMock.mockResolvedValue({
			state: { plan: runningPlan, prevStates: { 'task-1': 'connecting' } },
			progress: { ...DONE_PROGRESS, total: 1, pending: 0, running: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: ['task-1'],
			done: false,
		});

		await pianolaOrchestrate('plan-2', { once: true });

		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'pianola:plan-2:task-1',
				provider: 'claude-code',
				status: 'running',
				agentId: 'agent-1',
				tabId: 'tab-1',
				prompt: 'build it',
				source: 'pianola:plan-2',
			})
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'pianola:plan-2:task-1',
				type: 'pianola.dispatched',
				status: 'running',
			})
		);
	});

	it('mirrors an engine-side needs_review task onto the run via the guarded producer (ISC-5.8)', async () => {
		// The engine routed task-1 to needs_review with a bound runId; the store's
		// run carries an open finding, so markNeedsReview must transition it.
		const reviewPlan: PianolaPlan = {
			id: 'plan-3',
			title: 'Review',
			createdAt: 100,
			tasks: [
				{
					id: 'task-1',
					title: 'Build',
					prompt: 'build it',
					dependsOn: [],
					status: 'needs_review',
					runId: 'run-nr',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(reviewPlan);
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-nr'
				? {
						id: 'run-nr',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'running',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [{ severity: 'high', category: 'security', message: 'issue', status: 'open' }],
					}
				: undefined
		);
		runIterationMock.mockImplementation(async () => ({
			state: { plan: reviewPlan, prevStates: {} },
			progress: { ...DONE_PROGRESS, total: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: [],
			done: true,
		}));

		await pianolaOrchestrate('plan-3', { once: true });

		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-nr', status: 'needs_review' })
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({ runId: 'run-nr', type: 'status_change', status: 'needs_review' })
		);
	});

	it('leaves the run alone when a needs_review task has no open findings (ISC-5.8 anti)', async () => {
		const reviewPlan: PianolaPlan = {
			id: 'plan-4',
			title: 'CleanReview',
			createdAt: 100,
			tasks: [
				{
					id: 'task-1',
					title: 'Build',
					prompt: 'build it',
					dependsOn: [],
					status: 'needs_review',
					runId: 'run-clean',
				},
			],
		};
		vi.mocked(getPianolaPlan).mockReturnValue(reviewPlan);
		// Run exists but carries ZERO open findings (checks-only needs_review):
		// the guarded producer must refuse to park it in needs_review.
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-clean'
				? {
						id: 'run-clean',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'running',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [],
					}
				: undefined
		);
		runIterationMock.mockImplementation(async () => ({
			state: { plan: reviewPlan, prevStates: {} },
			progress: { ...DONE_PROGRESS, total: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: [],
			done: true,
		}));

		await pianolaOrchestrate('plan-4', { once: true });

		expect(upsertAgentRunMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'needs_review' })
		);
	});

	it('marks the run fixing through the producer when dispatchFix really dispatches (ISC-5.9)', async () => {
		// Autopilot on so the CLI's dispatchFix dep acts.
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		vi.mocked(runDispatch).mockResolvedValue({ success: true } as never);
		getAgentRunMock.mockImplementation((id: string) =>
			id === 'run-fx'
				? {
						id: 'run-fx',
						createdAt: 100,
						updatedAt: 100,
						provider: 'claude-code',
						status: 'needs_review',
						artifacts: [],
						touchedFiles: [],
						checks: [],
						reviews: [{ severity: 'high', category: 'security', message: 'issue', status: 'open' }],
					}
				: undefined
		);
		// Capture the deps the CLI hands the engine, then drive dispatchFix directly.
		let capturedDeps: Record<string, unknown> | undefined;
		runIterationMock.mockImplementation(async (state: OrchestratorState, deps: unknown) => {
			capturedDeps = deps as Record<string, unknown>;
			return doneResult(state);
		});

		await pianolaOrchestrate('plan-1', { once: true });
		const dispatchFix = capturedDeps?.dispatchFix as (
			task: unknown,
			ledger: unknown
		) => Promise<{ success: boolean }>;
		expect(dispatchFix).toBeTypeOf('function');

		const res = await dispatchFix(
			{
				id: 'task-1',
				title: 'Build',
				prompt: 'p',
				dependsOn: [],
				status: 'needs_review',
				agentId: 'agent-1',
				fixAttempts: 0,
			},
			{ runId: 'run-fx', openFindings: 1, checksPassed: false }
		);

		expect(res.success).toBe(true);
		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'run-fx', status: 'fixing' })
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: 'run-fx',
				type: 'status_change',
				status: 'fixing',
				data: expect.objectContaining({ fixAgentId: 'agent-1' }),
			})
		);
	});

	it('writes no fixing status when the fix dispatch fails (ISC-5.9 anti)', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true, autopilot: true });
		vi.mocked(runDispatch).mockResolvedValue({ success: false, error: 'agent busy' } as never);
		let capturedDeps: Record<string, unknown> | undefined;
		runIterationMock.mockImplementation(async (state: OrchestratorState, deps: unknown) => {
			capturedDeps = deps as Record<string, unknown>;
			return doneResult(state);
		});

		await pianolaOrchestrate('plan-1', { once: true });
		const dispatchFix = capturedDeps?.dispatchFix as (
			task: unknown,
			ledger: unknown
		) => Promise<{ success: boolean }>;

		const res = await dispatchFix(
			{
				id: 'task-1',
				title: 'Build',
				prompt: 'p',
				dependsOn: [],
				status: 'needs_review',
				agentId: 'agent-1',
			},
			{ runId: 'run-fx', openFindings: 1, checksPassed: false }
		);

		expect(res.success).toBe(false);
		expect(upsertAgentRunMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: 'fixing' })
		);
	});
});

describe('resolveExistingPianolaAgentType', () => {
	it('uses the live desktop session to backfill agentType for legacy agent-bound tasks', () => {
		expect(
			resolveExistingPianolaAgentType({ agentId: 'session-1' }, [
				{
					tabId: 'tab-1',
					sessionId: 'session-1',
					agentId: 'left-bar-owner',
					toolType: 'claude-code',
					state: 'idle',
				},
			])
		).toBe('claude-code');
	});

	it('keeps the stored task agentType ahead of live-session inference', () => {
		expect(
			resolveExistingPianolaAgentType({ agentId: 'session-1', agentType: 'codex' }, [
				{
					tabId: 'tab-1',
					sessionId: 'session-1',
					agentId: 'left-bar-owner',
					toolType: 'claude-code',
					state: 'idle',
				},
			])
		).toBe('codex');
	});
});

/**
 * GT1-08-20A: Grok tasks through the orchestrate CLI shell. The engine is
 * mocked, so the deps the CLI hands it are captured and driven directly.
 * A task bound to an existing Grok agent is dispatched to that agent with no
 * per-call override, so the account, model and remote target configured on
 * the agent are the ones that run; a fresh Grok session is created with the
 * Grok tool type and nothing invented (PianolaTask carries no account, model
 * or SSH field, recorded in the evidence); a refusal (unavailable, quota,
 * failed admission) is returned as is with no second create and no other
 * provider; and the AgentRun lineage, the failure toast and cancellation keep
 * the Grok binding.
 */
describe('pianolaOrchestrate with Grok tasks (GT1-08-20A)', () => {
	let errorSpy: MockInstance;
	let logSpy: MockInstance;

	const grokTask = (overrides: Partial<PianolaTask> = {}): PianolaTask => ({
		id: 'g1',
		title: 'Grok refactor',
		prompt: 'refactor the parser',
		dependsOn: [],
		status: 'pending',
		...overrides,
	});
	const grokPlan = (tasks: PianolaTask[]): PianolaPlan => ({
		id: 'grok-plan',
		title: 'Grok work',
		createdAt: 100,
		tasks,
	});
	const session = (
		sessionId: string,
		toolType: string,
		state: 'idle' | 'busy' = 'idle'
	): DesktopSessionEntry => ({
		tabId: `${sessionId}-tab`,
		sessionId,
		agentId: `${sessionId}-owner`,
		toolType,
		state,
	});
	const desktop = (
		sessions: DesktopSessionEntry[],
		create: () => Promise<unknown> = async () => ({ success: true, sessionId: 'grok-new' })
	) => {
		sendCommandMock.mockImplementation(async (command: { type: string }) => {
			if (command.type === 'list_desktop_sessions') return { sessions };
			if (command.type === 'create_session') return create();
			return {};
		});
	};
	const sentOfType = (type: string) =>
		sendCommandMock.mock.calls.filter(([command]) => (command as { type: string }).type === type);
	const captureDeps = async (p: PianolaPlan): Promise<OrchestratorDeps> => {
		vi.mocked(getPianolaPlan).mockReturnValue(p);
		let captured: OrchestratorDeps | undefined;
		runIterationMock.mockImplementation(
			async (state: OrchestratorState, deps: OrchestratorDeps) => {
				captured = deps;
				return doneResult(state);
			}
		);
		await pianolaOrchestrate(p.id, { once: true });
		if (!captured) throw new Error('deps were not handed to the engine');
		return captured;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		connectMock.mockResolvedValue(undefined);
		disconnectMock.mockReturnValue(undefined);
		vi.mocked(readSettingValue).mockReturnValue({ pianola: true });
		getAgentRunMock.mockReturnValue(undefined);
		findActiveRunBySessionMock.mockReturnValue(undefined);
		upsertAgentRunMock.mockImplementation((run) => run);
		appendAgentRunEventMock.mockImplementation((event) => event);
		desktop([]);
	});

	it('keeps a task bound to an existing Grok agent on that agent and dispatches with no override', async () => {
		const task = grokTask({ agentId: 'grok-agent-1', agentType: 'grok', cwd: '/repo/remote' });
		const deps = await captureDeps(grokPlan([task]));
		vi.mocked(runDispatch).mockResolvedValue({ success: true, sessionId: 'grok-tab-9' } as never);

		await expect(deps.ensureAgent(task)).resolves.toEqual({
			agentId: 'grok-agent-1',
			agentType: 'grok',
		});
		await expect(deps.dispatch(task, 'grok-agent-1')).resolves.toEqual({
			success: true,
			tabId: 'grok-tab-9',
			error: undefined,
		});
		// The empty options object is the proof: no account, model, effort or
		// remote is forced over what the Grok agent itself is configured with.
		expect(runDispatch).toHaveBeenCalledTimes(1);
		expect(runDispatch).toHaveBeenCalledWith('grok-agent-1', 'refactor the parser', {});
		expect(sentOfType('create_session')).toHaveLength(0);
		expect(sentOfType('list_desktop_sessions')).toHaveLength(0);
	});

	it('backfills a legacy agent-bound task as Grok from the live session and creates nothing', async () => {
		const task = grokTask({ agentId: 'grok-agent-1' });
		desktop([session('claude-1', 'claude-code'), session('grok-agent-1', 'grok')]);
		const deps = await captureDeps(grokPlan([task]));

		await expect(deps.ensureAgent(task)).resolves.toEqual({
			agentId: 'grok-agent-1',
			agentType: 'grok',
		});
		expect(sentOfType('create_session')).toHaveLength(0);
	});

	it('keeps the bound agent with no type, never another provider, when the session list is unavailable', async () => {
		const task = grokTask({ agentId: 'grok-agent-1' });
		const deps = await captureDeps(grokPlan([task]));
		sendCommandMock.mockRejectedValue(new Error('ws timeout'));

		await expect(deps.ensureAgent(task)).resolves.toEqual({ agentId: 'grok-agent-1' });
		expect(sentOfType('create_session')).toHaveLength(0);
	});

	it('creates a fresh Grok session for a task that names Grok, with nothing but name, type and cwd', async () => {
		const task = grokTask({ agentType: 'grok', cwd: '/work/grok-repo' });
		desktop([session('claude-1', 'claude-code')]);
		const deps = await captureDeps(grokPlan([task]));

		await expect(deps.ensureAgent(task)).resolves.toEqual({
			agentId: 'grok-new',
			agentType: 'grok',
		});
		const creates = sentOfType('create_session');
		expect(creates).toHaveLength(1);
		expect(creates[0]).toEqual([
			{ type: 'create_session', name: 'Grok refactor', toolType: 'grok', cwd: '/work/grok-repo' },
			'create_session_result',
		]);
		// A named provider is never re-chosen from the pool.
		expect(sentOfType('list_desktop_sessions')).toHaveLength(0);
	});

	it('creates a Grok session from an all-Grok pool even when every Grok session is busy', async () => {
		const task = grokTask();
		desktop([session('grok-a', 'grok', 'busy'), session('grok-b', 'grok', 'busy')]);
		const deps = await captureDeps(grokPlan([task]));

		await expect(deps.ensureAgent(task)).resolves.toEqual({
			agentId: 'grok-new',
			agentType: 'grok',
		});
		expect(sentOfType('create_session')[0][0]).toMatchObject({ toolType: 'grok' });
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('creating a fresh grok session'));
		expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('defaulting to'));
	});

	it('returns an unavailable or quota refusal from create_session as is, with no second create', async () => {
		const refusals = [
			'Grok CLI is not installed on this machine',
			'grok account is rate limited until 14:00',
		];
		for (const error of refusals) {
			const task = grokTask({ agentType: 'grok' });
			desktop([session('claude-1', 'claude-code')], async () => ({ success: false, error }));
			const deps = await captureDeps(grokPlan([task]));
			sendCommandMock.mockClear();

			await expect(deps.ensureAgent(task)).resolves.toEqual({ error });
			const creates = sentOfType('create_session');
			expect(creates).toHaveLength(1);
			expect(creates[0][0]).toMatchObject({ toolType: 'grok' });
		}
	});

	it('names the missing session id and propagates a lost create answer without retrying another provider', async () => {
		const task = grokTask({ agentType: 'grok' });
		desktop([], async () => ({ success: true }));
		const deps = await captureDeps(grokPlan([task]));
		await expect(deps.ensureAgent(task)).resolves.toEqual({
			error: 'create_session did not return a sessionId',
		});

		desktop([], async () => {
			throw new Error('create_session timed out');
		});
		sendCommandMock.mockClear();
		await expect(deps.ensureAgent(task)).rejects.toThrow('create_session timed out');
		expect(sentOfType('create_session')).toHaveLength(1);
	});

	it('reports a refused Grok dispatch as failed with its reason and falls back to nothing', async () => {
		const task = grokTask({ agentId: 'grok-agent-1', agentType: 'grok' });
		const deps = await captureDeps(grokPlan([task]));
		vi.mocked(runDispatch).mockResolvedValue({
			success: false,
			error: 'managed admission refused: policy-denied',
		} as never);

		await expect(deps.dispatch(task, 'grok-agent-1')).resolves.toEqual({
			success: false,
			tabId: undefined,
			error: 'managed admission refused: policy-denied',
		});
		expect(runDispatch).toHaveBeenCalledTimes(1);
		expect(sentOfType('create_session')).toHaveLength(0);
	});

	it('records a dispatched Grok task, then its failure, on one AgentRun with the Grok provider', async () => {
		const running = grokTask({
			status: 'running',
			agentId: 'grok-agent-1',
			agentType: 'grok',
			tabId: 'grok-tab-1',
			cwd: '/repo',
		});
		const failed: PianolaTask = {
			...running,
			status: 'failed',
			error: 'agent entered error state',
		};
		const p = grokPlan([grokTask()]);
		vi.mocked(getPianolaPlan).mockReturnValue(p);
		let calls = 0;
		runIterationMock.mockImplementation(async () => {
			calls += 1;
			const first = calls === 1;
			return {
				state: { plan: grokPlan([first ? running : failed]), prevStates: {} },
				progress: { ...DONE_PROGRESS, total: 1, complete: !first },
				completedTaskIds: [],
				failedTaskIds: first ? [] : ['g1'],
				dispatchedTaskIds: first ? ['g1'] : [],
				done: !first,
			};
		});

		await pianolaOrchestrate('grok-plan', { interval: '1' });

		const runId = 'pianola:grok-plan:g1';
		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: runId,
				provider: 'grok',
				status: 'running',
				agentId: 'grok-agent-1',
				sessionId: 'grok-agent-1',
				tabId: 'grok-tab-1',
				cwd: '/repo',
				source: 'pianola:grok-plan',
				metadata: { pianola: { planId: 'grok-plan', taskId: 'g1', taskStatus: 'running' } },
			})
		);
		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({ id: runId, provider: 'grok', status: 'failed' })
		);
		expect(appendAgentRunEventMock).toHaveBeenCalledWith(
			expect.objectContaining({
				runId,
				type: 'pianola.failed',
				status: 'failed',
				data: { planId: 'grok-plan', taskId: 'g1' },
			})
		);
	});

	it('binds a Grok task to the run the desktop captured for its session', async () => {
		const running = grokTask({
			status: 'running',
			agentId: 'grok-agent-1',
			agentType: 'grok',
			tabId: 'grok-tab-1',
		});
		findActiveRunBySessionMock.mockImplementation((id: string) =>
			id === 'grok-agent-1' ? { id: 'captured-grok-run' } : undefined
		);
		vi.mocked(getPianolaPlan).mockReturnValue(grokPlan([grokTask()]));
		runIterationMock.mockResolvedValue({
			state: { plan: grokPlan([running]), prevStates: {} },
			progress: { ...DONE_PROGRESS, total: 1, running: 1, complete: false },
			completedTaskIds: [],
			failedTaskIds: [],
			dispatchedTaskIds: ['g1'],
			done: false,
		});

		await pianolaOrchestrate('grok-plan', { once: true });

		expect(upsertAgentRunMock).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'captured-grok-run',
				provider: 'grok',
				agentId: 'grok-agent-1',
			})
		);
		expect(upsertAgentRunMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ id: 'pianola:grok-plan:g1' })
		);
	});

	it('raises the failure toast on the Grok agent and tab that failed', async () => {
		const failed = grokTask({
			status: 'failed',
			agentId: 'grok-agent-1',
			agentType: 'grok',
			tabId: 'grok-tab-1',
		});
		const deps = await captureDeps(grokPlan([failed]));
		await deps.notify?.({ kind: 'task_failed', task: failed });

		expect(sendCommandMock).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'notify_toast',
				message: 'Task failed: Grok refactor',
				color: 'red',
				sessionId: 'grok-agent-1',
				tabId: 'grok-tab-1',
				clickAction: { kind: 'jump-session', sessionId: 'grok-agent-1', tabId: 'grok-tab-1' },
			}),
			'notify_toast_result'
		);
	});

	it('stops a Grok plan on SIGINT after the current tick and disconnects', async () => {
		const onSpy = vi.spyOn(process, 'on');
		const offSpy = vi.spyOn(process, 'off');
		vi.mocked(getPianolaPlan).mockReturnValue(grokPlan([grokTask()]));
		let calls = 0;
		runIterationMock.mockImplementation(async (state: OrchestratorState) => {
			calls += 1;
			if (calls > 1) return doneResult(state);
			const sigint = onSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as () => void;
			sigint();
			return { ...doneResult(state), done: false, progress: { ...DONE_PROGRESS, complete: false } };
		});

		await pianolaOrchestrate('grok-plan', { interval: '1' });

		expect(runIterationMock).toHaveBeenCalledTimes(1);
		expect(disconnectMock).toHaveBeenCalledTimes(1);
		const handler = onSpy.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
		expect(offSpy).toHaveBeenCalledWith('SIGINT', handler);
	});

	it('stops a Grok plan when Pianola is switched off between ticks', async () => {
		let consent = true;
		vi.mocked(readSettingValue).mockImplementation(() => ({ pianola: consent }));
		vi.mocked(getPianolaPlan).mockReturnValue(grokPlan([grokTask()]));
		runIterationMock.mockImplementation(async (state: OrchestratorState) => {
			consent = false;
			return { ...doneResult(state), done: false, progress: { ...DONE_PROGRESS, complete: false } };
		});

		await pianolaOrchestrate('grok-plan', { interval: '1' });

		expect(runIterationMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledWith('[orchestrator] Pianola disabled in Settings; stopping.');
		expect(disconnectMock).toHaveBeenCalledTimes(1);
	});
});

describe('choosePianolaToolType with Grok in the pool (GT1-08-20A)', () => {
	const t = (overrides: Partial<PianolaTask> = {}): PianolaTask => ({
		id: 'x',
		title: 'X',
		prompt: 'p',
		dependsOn: [],
		status: 'pending',
		...overrides,
	});
	const s = (sessionId: string, toolType: string, state: 'idle' | 'busy' = 'idle') => ({
		tabId: `${sessionId}-tab`,
		sessionId,
		agentId: sessionId,
		toolType,
		state,
	});

	it('chooses Grok from an idle all-Grok pool with no note', () => {
		expect(choosePianolaToolType(t(), [s('g1', 'grok')], [])).toEqual({ toolType: 'grok' });
	});

	it('counts running and fixing Grok tasks as load and picks the less-loaded sibling', () => {
		const pool = [s('g1', 'grok'), s('c1', 'claude-code')];
		const claudeRunning = [
			t({ id: 'c', status: 'running', agentType: 'claude-code' }),
			t({ id: 'd', status: 'done', agentType: 'claude-code' }),
		];
		// Grok idle, Claude carrying one: Grok is the less-loaded type.
		expect(choosePianolaToolType(t(), pool, claudeRunning)).toEqual({ toolType: 'grok' });
		// A Grok task in fixing holds a Grok agent: one each, the tie breaks by
		// tool type id, deterministic.
		const grokFixing = [...claudeRunning, t({ id: 'b', status: 'fixing', agentType: 'grok' })];
		expect(choosePianolaToolType(t(), pool, grokFixing)).toEqual({ toolType: 'claude-code' });
		const grokRunning = [...claudeRunning, t({ id: 'a', status: 'running', agentType: 'grok' })];
		expect(choosePianolaToolType(t(), pool, grokRunning)).toEqual({ toolType: 'claude-code' });
		const grokFinished = [...claudeRunning, t({ id: 'e', status: 'done', agentType: 'grok' })];
		expect(choosePianolaToolType(t(), pool, grokFinished)).toEqual({ toolType: 'grok' });
	});

	it('keeps Grok when its only sibling type is fully busy and Grok has a free session', () => {
		const pool = [s('g1', 'grok', 'busy'), s('g2', 'grok'), s('c1', 'claude-code', 'busy')];
		expect(choosePianolaToolType(t(), pool, [])).toEqual({ toolType: 'grok' });
	});

	it('defaults to the cold-start provider only on an empty pool', () => {
		const choice = choosePianolaToolType(t({ id: 'cold' }), [], []);
		expect(choice.toolType).toBe(PIANOLA_COLD_START_TOOL_TYPE);
		expect(choice.note).toContain('no candidate agents');
		expect(choice.note).toContain(`defaulting to ${PIANOLA_COLD_START_TOOL_TYPE}`);
	});
});
