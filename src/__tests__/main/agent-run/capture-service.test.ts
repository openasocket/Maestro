/**
 * @file capture-service.test.ts
 * @description Behavioral tests for the F1 AgentRunCaptureService. All deps are
 * injected in-memory fakes (a Map<string, AgentRun> + an events array) - no fs,
 * no electron, no child_process. The contracts under test:
 *   - captureSpawn creates a `running` run with a unique id, a resolved provider,
 *     and the prompt passed through preparePrompt.
 *   - a second captureSpawn for the SAME live session supersedes the prior run
 *     (prior -> cancelled with metadata.supersededBy, a new distinct run created)
 *     (ISC-1.11).
 *   - captureExit settles via deriveTerminalStatus: exit 0 clean -> completed,
 *     exit 1 -> failed, exit 0 with an enrich hook that adds an open critical
 *     finding -> needs_review (ISC-8.4). Records exitCode/durationMs/completedAt.
 *   - terminal (`-terminal-`) and group-chat sessions are captured at NEITHER
 *     spawn NOR exit (ISC-1.7).
 *   - a throwing store dep never escapes captureSpawn/captureExit (ISC-1.8).
 *   - captureExit with no live run for the session settles nothing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	AgentRunCaptureService,
	lifecycleSurfaceOf,
	newRunId,
	spawnLifecycleAdmission,
	spawnLifecycleLineage,
	type CaptureServiceDeps,
} from '../../../main/agent-run/capture-service';
import type { ProcessSpawnAdmission } from '../../../main/process-manager/types';
import type { AgentRun, AgentRunEvent, AgentRunReviewFinding } from '../../../shared/agent-run';
import {
	LIFECYCLE_FACT_FIELDS,
	type LifecycleFact,
	type LifecycleLineage,
} from '../../../shared/maestro-lib/managed/events';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';

// Terminal states inlined as a static lookup so the fake store's "active run"
// resolution mirrors the real store without importing the impl's own helper.
const TERMINAL: Record<AgentRun['status'], boolean> = {
	queued: false,
	running: false,
	waiting: false,
	needs_review: false,
	fixing: false,
	completed: true,
	failed: true,
	cancelled: true,
	merged: true,
	discarded: true,
};

interface FakeStore {
	runs: Map<string, AgentRun>;
	events: AgentRunEvent[];
	deps: CaptureServiceDeps;
	clock: { t: number };
	seed: (run: AgentRun) => void;
}

const baseRun = (overrides: Partial<AgentRun> = {}): AgentRun => ({
	id: 'run-seed',
	createdAt: 1,
	updatedAt: 1,
	provider: 'claude-code',
	status: 'running',
	sessionId: 'session-seed',
	cwd: '/repo',
	artifacts: [],
	touchedFiles: [],
	checks: [],
	reviews: [],
	...overrides,
});

const openCritical = (): AgentRunReviewFinding => ({
	severity: 'critical',
	category: 'security',
	message: 'hardcoded secret',
	status: 'open',
});

function makeStore(extra: Partial<CaptureServiceDeps> = {}): FakeStore {
	const runs = new Map<string, AgentRun>();
	const events: AgentRunEvent[] = [];
	const clock = { t: 1000 };
	const deps: CaptureServiceDeps = {
		getAgentRun: (id) => runs.get(id),
		upsertAgentRun: (run) => {
			runs.set(run.id, run);
			return run;
		},
		appendAgentRunEvent: (event) => {
			events.push(event);
			return event;
		},
		findActiveRunBySession: (sessionId) => {
			for (const run of runs.values()) {
				if (run.sessionId === sessionId && !TERMINAL[run.status]) return run;
			}
			return undefined;
		},
		now: () => clock.t,
		log: () => {},
		...extra,
	};
	return {
		runs,
		events,
		deps,
		clock,
		seed: (run) => {
			runs.set(run.id, run);
		},
	};
}

describe('AgentRunCaptureService.captureSpawn', () => {
	let store: FakeStore;
	let service: AgentRunCaptureService;

	beforeEach(() => {
		store = makeStore({
			preparePrompt: (p) => (p === undefined ? undefined : `PREP:${p}`),
		});
		service = new AgentRunCaptureService(store.deps);
	});

	it('creates a running run with resolved provider, prepared prompt, and a status_change event', () => {
		store.clock.t = 1000;
		const created = service.captureSpawn({
			sessionId: 'sess-1',
			toolType: 'claude', // alias -> claude-code proves resolveAgentRunProvider ran
			cwd: '/repo',
			prompt: 'ship it',
		});

		expect(created).toBeDefined();
		expect(created?.status).toBe('running');
		expect(created?.provider).toBe('claude-code');
		expect(created?.prompt).toBe('PREP:ship it'); // ran through preparePrompt
		expect(created?.createdAt).toBe(1000);
		expect(created?.updatedAt).toBe(1000);
		expect(created?.sessionId).toBe('sess-1');

		// persisted, not just returned
		expect(store.runs.get(created!.id)).toEqual(created);

		// exactly one spawn event, running, tied to the run
		const spawnEvents = store.events.filter((e) => e.runId === created!.id);
		expect(spawnEvents).toHaveLength(1);
		expect(spawnEvents[0]).toMatchObject({
			runId: created!.id,
			type: 'status_change',
			status: 'running',
			message: 'run spawned',
		});
	});

	it('mints a unique run id per spawn even across different sessions', () => {
		store.clock.t = 1000;
		const a = service.captureSpawn({ sessionId: 'sess-a', toolType: 'codex', cwd: '/r' });
		store.clock.t = 1001;
		const b = service.captureSpawn({ sessionId: 'sess-b', toolType: 'codex', cwd: '/r' });
		expect(a?.id).toBeDefined();
		expect(b?.id).toBeDefined();
		expect(a?.id).not.toBe(b?.id);
		expect(store.runs.size).toBe(2);
	});

	it('stores prompt verbatim when no preparePrompt dep is injected', () => {
		const plain = makeStore();
		const svc = new AgentRunCaptureService(plain.deps);
		plain.clock.t = 5;
		const created = svc.captureSpawn({
			sessionId: 'sess-plain',
			toolType: 'codex',
			cwd: '/r',
			prompt: 'raw prompt',
		});
		expect(created?.prompt).toBe('raw prompt');
	});

	// ISC-1.11 - the key supersede case.
	it('supersedes a prior live run for the same session (prior -> cancelled with supersededBy)', () => {
		store.clock.t = 1000;
		const first = service.captureSpawn({ sessionId: 'sess-x', toolType: 'claude', cwd: '/r' });
		store.clock.t = 2000;
		const second = service.captureSpawn({ sessionId: 'sess-x', toolType: 'claude', cwd: '/r' });

		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second!.id).not.toBe(first!.id);

		const priorPersisted = store.runs.get(first!.id)!;
		expect(priorPersisted.status).toBe('cancelled');
		expect(priorPersisted.metadata?.supersededBy).toBe(second!.id);
		expect(priorPersisted.updatedAt).toBe(2000);

		const newPersisted = store.runs.get(second!.id)!;
		expect(newPersisted.status).toBe('running');

		// only one active run remains for the session
		expect(store.deps.findActiveRunBySession('sess-x')?.id).toBe(second!.id);

		// three status_change events: first running, first cancelled, second running
		const cancelEvent = store.events.find((e) => e.runId === first!.id && e.status === 'cancelled');
		expect(cancelEvent).toBeDefined();
		expect(cancelEvent?.message).toBe(`superseded by ${second!.id}`);
		expect(store.events.filter((e) => e.status === 'running')).toHaveLength(2);
	});

	it('does not supersede when the prior run for the session is already terminal', () => {
		store.seed(
			baseRun({
				id: 'done',
				sessionId: 'sess-done',
				status: 'completed',
				createdAt: 1,
				updatedAt: 1,
			})
		);
		store.clock.t = 3000;
		const created = service.captureSpawn({ sessionId: 'sess-done', toolType: 'codex', cwd: '/r' });
		expect(created?.status).toBe('running');
		// the completed run is untouched: still completed, no supersededBy stamped
		const done = store.runs.get('done')!;
		expect(done.status).toBe('completed');
		expect(done.metadata?.supersededBy).toBeUndefined();
	});

	// ISC-1.7 - filtered at spawn.
	it.each([
		['x-terminal-y', 'terminal session'],
		['sess-terminal', 'legacy -terminal suffix'],
		['group-chat-z', 'group-chat session'],
	])('captures nothing for %s (%s)', (sessionId) => {
		const created = service.captureSpawn({ sessionId, toolType: 'claude', cwd: '/r' });
		expect(created).toBeUndefined();
		expect(store.runs.size).toBe(0);
		expect(store.events).toHaveLength(0);
	});

	// ISC-1.8 - never throws.
	it('swallows a throwing upsert dep and returns undefined', () => {
		const throwing = makeStore({
			upsertAgentRun: () => {
				throw new Error('disk full');
			},
			log: vi.fn(),
		});
		const svc = new AgentRunCaptureService(throwing.deps);
		expect(() =>
			svc.captureSpawn({ sessionId: 'sess-boom', toolType: 'codex', cwd: '/r' })
		).not.toThrow();
		expect(
			svc.captureSpawn({ sessionId: 'sess-boom', toolType: 'codex', cwd: '/r' })
		).toBeUndefined();
		expect(throwing.deps.log).toHaveBeenCalled();
	});
});

describe('AgentRunCaptureService.captureExit', () => {
	let store: FakeStore;
	let service: AgentRunCaptureService;

	beforeEach(() => {
		store = makeStore();
		service = new AgentRunCaptureService(store.deps);
	});

	it('settles a clean exit (code 0) to completed with exitCode/durationMs/completedAt', async () => {
		store.seed(
			baseRun({
				id: 'run-1',
				sessionId: 'sess-1',
				status: 'running',
				createdAt: 1000,
				updatedAt: 1000,
			})
		);
		store.clock.t = 1500;
		const settled = await service.captureExit({ sessionId: 'sess-1', exitCode: 0 });

		expect(settled?.status).toBe('completed');
		expect(settled?.metadata?.exitCode).toBe(0);
		expect(settled?.metadata?.durationMs).toBe(500); // 1500 - 1000
		expect(settled?.metadata?.completedAt).toBe(1500);
		expect(settled?.updatedAt).toBe(1500);
		expect(store.runs.get('run-1')?.status).toBe('completed');

		const evt = store.events.find((e) => e.runId === 'run-1' && e.type === 'status_change');
		expect(evt).toMatchObject({ status: 'completed', message: 'run completed (exit 0)' });
	});

	it('settles a nonzero exit to failed regardless of findings', async () => {
		store.seed(
			baseRun({
				id: 'run-2',
				sessionId: 'sess-2',
				status: 'running',
				createdAt: 1000,
				reviews: [openCritical()], // open critical present but exit is nonzero
			})
		);
		store.clock.t = 1200;
		const settled = await service.captureExit({ sessionId: 'sess-2', exitCode: 1 });

		expect(settled?.status).toBe('failed');
		expect(settled?.metadata?.exitCode).toBe(1);
		expect(settled?.metadata?.durationMs).toBe(200);
	});

	// ISC-8.4 - exit 0 but an enrich hook surfaces an open critical finding.
	it('diverts a clean exit to needs_review when enrich adds an open critical finding', async () => {
		store.seed(baseRun({ id: 'run-3', sessionId: 'sess-3', status: 'running', createdAt: 1000 }));
		const enriched = makeStore({
			enrich: () => ({ reviews: [openCritical()] }),
		});
		enriched.seed(
			baseRun({ id: 'run-3', sessionId: 'sess-3', status: 'running', createdAt: 1000 })
		);
		const svc = new AgentRunCaptureService(enriched.deps);
		enriched.clock.t = 1400;
		const settled = await svc.captureExit({ sessionId: 'sess-3', exitCode: 0 });

		expect(settled?.status).toBe('needs_review');
		expect(settled?.reviews).toHaveLength(1);
		expect(settled?.reviews[0]?.severity).toBe('critical');
		expect(settled?.metadata?.exitCode).toBe(0);
		const evt = enriched.events.find((e) => e.runId === 'run-3' && e.type === 'status_change');
		expect(evt?.status).toBe('needs_review');
	});

	it('stays completed on a clean exit when enrich adds only a low-severity open finding', async () => {
		const enriched = makeStore({
			enrich: () => ({
				reviews: [
					{
						severity: 'low',
						category: 'style',
						message: 'nit',
						status: 'open',
					} as AgentRunReviewFinding,
				],
			}),
		});
		enriched.seed(
			baseRun({ id: 'run-low', sessionId: 'sess-low', status: 'running', createdAt: 1000 })
		);
		const svc = new AgentRunCaptureService(enriched.deps);
		enriched.clock.t = 1100;
		const settled = await svc.captureExit({ sessionId: 'sess-low', exitCode: 0 });
		// low severity does not clear the completed bar (needs_review is crit/high only)
		expect(settled?.status).toBe('completed');
	});

	it('survives a throwing enrich hook and still settles from the exit code', async () => {
		const enriched = makeStore({
			enrich: () => {
				throw new Error('git blew up');
			},
			log: vi.fn(),
		});
		enriched.seed(
			baseRun({ id: 'run-en', sessionId: 'sess-en', status: 'running', createdAt: 1000 })
		);
		const svc = new AgentRunCaptureService(enriched.deps);
		enriched.clock.t = 1050;
		const settled = await svc.captureExit({ sessionId: 'sess-en', exitCode: 0 });
		expect(settled?.status).toBe('completed');
		expect(enriched.deps.log).toHaveBeenCalled();
	});

	it('returns undefined and writes nothing when the session has no active run', async () => {
		const settled = await service.captureExit({ sessionId: 'sess-absent', exitCode: 0 });
		expect(settled).toBeUndefined();
		expect(store.events).toHaveLength(0);
	});

	it('returns undefined when the only run for the session is already terminal', async () => {
		store.seed(
			baseRun({ id: 'run-done', sessionId: 'sess-t', status: 'completed', createdAt: 1000 })
		);
		const settled = await service.captureExit({ sessionId: 'sess-t', exitCode: 1 });
		expect(settled).toBeUndefined();
		expect(store.runs.get('run-done')?.status).toBe('completed'); // untouched
	});

	// ISC-1.7 - filtered at exit: a seeded live run for a filtered session is not settled.
	it.each([
		['x-terminal-y', 'run-term'],
		['group-chat-z', 'run-gc'],
	])('settles nothing at exit for filtered session %s', async (sessionId, runId) => {
		store.seed(baseRun({ id: runId, sessionId, status: 'running', createdAt: 1000 }));
		store.clock.t = 9999;
		const settled = await service.captureExit({ sessionId, exitCode: 0 });
		expect(settled).toBeUndefined();
		// the seeded run stays running - the exit filter fired before any write
		expect(store.runs.get(runId)?.status).toBe('running');
		expect(store.events).toHaveLength(0);
	});

	// ISC-1.8 - never throws even when the store write fails after an active run resolves.
	it('swallows a throwing upsert dep and returns undefined', async () => {
		const throwing = makeStore({
			findActiveRunBySession: () =>
				baseRun({ id: 'run-boom', sessionId: 'sess-boom', status: 'running', createdAt: 1000 }),
			upsertAgentRun: () => {
				throw new Error('disk full');
			},
			log: vi.fn(),
		});
		const svc = new AgentRunCaptureService(throwing.deps);
		await expect(svc.captureExit({ sessionId: 'sess-boom', exitCode: 0 })).resolves.toBeUndefined();
		expect(throwing.deps.log).toHaveBeenCalled();
	});
});

describe('AgentRunCaptureService lifecycle projection (MRC-10-01)', () => {
	const ADMISSION: ProcessSpawnAdmission = Object.freeze({
		leaseId: 'lease-1',
		authorityId: 'auth-1',
		requestDigest: 'digest-1',
		actor: { kind: 'human', id: 'alice' },
		provider: 'claude-code',
		operation: 'start',
		target: { kind: 'local' },
		policyRevision: 4,
		requestId: 'req-1',
		attemptId: 'attempt-1',
	});

	function withSink(extra: Partial<CaptureServiceDeps> = {}) {
		const facts: LifecycleFact[] = [];
		const store = makeStore({
			lifecycle: {
				record: (fact) => {
					facts.push(fact);
					return [];
				},
			},
			...extra,
		});
		return { facts, store, service: new AgentRunCaptureService(store.deps) };
	}

	it('projects a ledger spawn and its exit under the ledger run and the owning agent, with no prompt', async () => {
		const { facts, store, service } = withSink();
		store.clock.t = 1000;
		const created = service.captureSpawn({
			sessionId: 'agent-7-ai-tab-1',
			toolType: 'claude',
			cwd: '/private/repo',
			tabId: 'tab-1',
			model: 'opus',
			prompt: 'CANARY the whole prompt sk-ant-123',
		});
		store.clock.t = 1750;
		await service.captureExit({ sessionId: 'agent-7-ai-tab-1', exitCode: 0 });

		expect(facts.map((f) => [f.state, f.ledgerStatus])).toEqual([
			['running', 'running'],
			['completed', 'completed'],
		]);
		expect(facts[0]).toMatchObject({
			surface: 'agent',
			at: 1000,
			sessionId: 'agent-7-ai-tab-1',
			agentId: 'agent-7',
			tabId: 'tab-1',
			provider: 'claude',
			model: 'opus',
			runId: created!.id,
			record: 'ledger',
			exitCode: null,
			durationMs: null,
			admission: null,
		});
		expect(facts[1]).toMatchObject({
			runId: created!.id,
			at: 1750,
			exitCode: 0,
			durationMs: 750,
		});
		const serialized = JSON.stringify(facts);
		expect(serialized).not.toContain('CANARY');
		expect(serialized).not.toContain('/private/repo');
		for (const fact of facts) {
			for (const key of Object.keys(fact)) expect(LIFECYCLE_FACT_FIELDS).toContain(key);
		}
	});

	it.each([
		['agent-7-terminal-2', 'terminal'],
		['group-chat-room-1', 'group-chat'],
	])(
		'projects %s, which the ledger omits, at spawn and at exit while the ledger stays empty',
		async (sessionId, surface) => {
			const { facts, store, service } = withSink();
			store.clock.t = 1000;
			expect(service.captureSpawn({ sessionId, toolType: 'terminal', cwd: '/r' })).toBeUndefined();
			store.clock.t = 1300;
			expect(await service.captureExit({ sessionId, exitCode: 130 })).toBeUndefined();

			expect(store.runs.size).toBe(0);
			expect(store.events).toHaveLength(0);
			expect(facts).toHaveLength(2);
			expect(facts[0]).toMatchObject({
				surface,
				state: 'running',
				sessionId,
				runId: `${sessionId}@1000`,
				record: 'omitted',
				ledgerStatus: null,
				tabId: null,
			});
			expect(facts[1]).toMatchObject({
				surface,
				state: 'failed',
				runId: `${sessionId}@1000`,
				record: 'omitted',
				exitCode: 130,
				durationMs: 300,
				detail: null,
			});
			expect(lifecycleSurfaceOf(sessionId)).toBe(surface);
		}
	);

	it('projects the exit of an omitted session whose spawn this process never saw, and says so', async () => {
		const { facts, service, store } = withSink();
		store.clock.t = 5000;
		await service.captureExit({ sessionId: 'x-terminal-y', exitCode: 0 });
		expect(facts).toEqual([
			expect.objectContaining({
				surface: 'terminal',
				state: 'completed',
				runId: 'x-terminal-y@5000',
				record: 'omitted',
				durationMs: null,
				detail: 'spawn not observed by this process',
			}),
		]);
	});

	it('projects a superseded run as cancelled before the replacing run starts', () => {
		const { facts, store, service } = withSink();
		store.clock.t = 1000;
		const first = service.captureSpawn({ sessionId: 'agent-1-ai-t', toolType: 'codex', cwd: '/r' });
		store.clock.t = 2000;
		const second = service.captureSpawn({
			sessionId: 'agent-1-ai-t',
			toolType: 'codex',
			cwd: '/r',
		});
		expect(facts.map((f) => [f.state, f.runId])).toEqual([
			['running', first!.id],
			['cancelled', first!.id],
			['running', second!.id],
		]);
		expect(facts[1]).toMatchObject({
			ledgerStatus: 'cancelled',
			durationMs: 1000,
			detail: `superseded by ${second!.id}`,
		});
	});

	it('carries the lineage and the admission on the start and on the exit', async () => {
		const { facts, store, service } = withSink();
		const lineage: LifecycleLineage = {
			identity: {
				requestId: 'req-1',
				idempotencyKey: 'req-1',
				attemptId: 'attempt-1',
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
			traceId: 'req-1',
			workflow: null,
			delegation: { chain: [], grantRef: null },
			actor: { kind: 'human', id: 'alice' },
			policyRevision: 4,
		};
		const admission = spawnLifecycleAdmission(ADMISSION);
		store.clock.t = 1000;
		service.captureSpawn({
			sessionId: 'agent-1-ai-t',
			toolType: 'claude-code',
			cwd: '/r',
			lineage,
			admission,
		});
		store.clock.t = 1200;
		await service.captureExit({ sessionId: 'agent-1-ai-t', exitCode: 1 });
		expect(facts).toHaveLength(2);
		for (const fact of facts) {
			expect(fact.lineage).toEqual(lineage);
			expect(fact.admission).toEqual({
				leaseId: 'lease-1',
				authorityId: 'auth-1',
				requestDigest: 'digest-1',
				policyRevision: 4,
				operation: 'start',
				target: { kind: 'local' },
			});
		}
		expect(facts[1]).toMatchObject({ state: 'failed', exitCode: 1 });
	});

	it('survives a throwing sink: the ledger write stands and the failure is logged', async () => {
		const log = vi.fn();
		const store = makeStore({
			lifecycle: {
				record: () => {
					throw new Error('sink down');
				},
			},
			log,
		});
		const service = new AgentRunCaptureService(store.deps);
		const created = service.captureSpawn({
			sessionId: 'agent-1-ai-t',
			toolType: 'codex',
			cwd: '/r',
		});
		expect(created?.status).toBe('running');
		expect(store.runs.size).toBe(1);
		await expect(
			service.captureExit({ sessionId: 'agent-1-ai-t', exitCode: 0 })
		).resolves.toMatchObject({ status: 'completed' });
		expect(log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('lifecycle projection failed'),
			expect.anything()
		);
	});

	it('projects nothing and binds nothing without a sink', async () => {
		const store = makeStore();
		const service = new AgentRunCaptureService(store.deps);
		expect(
			service.captureSpawn({ sessionId: 'a-terminal-1', toolType: 'terminal', cwd: '/r' })
		).toBeUndefined();
		expect(await service.captureExit({ sessionId: 'a-terminal-1', exitCode: 0 })).toBeUndefined();
		expect(store.runs.size).toBe(0);
	});

	describe('spawnLifecycleLineage', () => {
		const attribution = {
			workflow: { workflowId: 'wf-1', version: 'v1', triggerEventId: 'operator:1', runId: 'ar-1' },
			purpose: 'task' as never,
			document: 'doc.md',
			loopNumber: 1,
			requestId: 'task-req',
			idempotencyKey: 'task-key',
			attemptId: 'task-attempt',
			attempt: 1,
			turnRunId: 'turn-1',
			parentRunId: 'ar-1',
		};

		it('reads an Auto Run attempt off its attribution, with the fence as the workflow', () => {
			const lineage = spawnLifecycleLineage({
				sessionId: 'agent-1-ai-t',
				autoRun: { attribution, fence: { ownerEpoch: 'e1', fencingToken: 'f1' } },
				admission: ADMISSION,
			});
			expect(lineage).toEqual({
				identity: {
					requestId: 'task-req',
					idempotencyKey: 'task-key',
					attemptId: 'task-attempt',
					runId: 'turn-1',
					rootRunId: 'ar-1',
					parentRunId: 'ar-1',
				},
				traceId: 'autorun:ar-1:task-req:1',
				workflow: {
					workflowId: 'wf-1',
					version: 'v1',
					triggerEventId: 'operator:1',
					ownerEpoch: 'e1',
					fencingToken: 'f1',
				},
				delegation: { chain: [], grantRef: null },
				actor: { kind: 'human', id: 'alice' },
				policyRevision: 4,
			});
			// Unowned: the workflow is null (never invented), and a standalone host binds no actor.
			expect(
				spawnLifecycleLineage({ sessionId: 'agent-1-ai-t', autoRun: { attribution, fence: null } })
			).toMatchObject({ workflow: null });
			expect(
				spawnLifecycleLineage({ sessionId: 'agent-1-ai-t', autoRun: { attribution, fence: null } })
			).not.toHaveProperty('actor');
		});

		it('binds a dispatched spawn as its initiator child with the ids the handler minted', () => {
			const lineage = spawnLifecycleLineage({
				sessionId: 'agent-9-ai-tab',
				delegation: {
					contractVersion: MANAGED_CONTRACT_VERSION,
					identity: {
						requestId: 'cue-req',
						idempotencyKey: 'cue-key',
						attemptId: 'cue-attempt',
						runId: 'cue-run',
						rootRunId: 'cue-root',
						parentRunId: null,
					},
					traceId: 'cue:trace',
					workflow: null,
					delegation: { chain: [{ kind: 'service', id: 'cue' }], grantRef: 'g1' },
					policyRevision: 2,
				},
				dispatchedAs: { requestId: 'child-req', attemptId: 'child-attempt' },
			});
			expect(lineage).toMatchObject({
				identity: {
					requestId: 'child-req',
					attemptId: 'child-attempt',
					runId: 'child-req',
					rootRunId: 'cue-root',
					parentRunId: 'cue-run',
				},
				traceId: 'delegated:cue-root:child-req:child-attempt',
				delegation: {
					chain: [
						{ kind: 'service', id: 'cue' },
						{ kind: 'agent', id: 'agent-9' },
					],
					grantRef: 'g1',
				},
			});
			// A delegation with no minted ids and no admission is not guessed at.
			expect(
				spawnLifecycleLineage({
					sessionId: 'agent-9-ai-tab',
					delegation: {
						contractVersion: MANAGED_CONTRACT_VERSION,
						identity: {
							requestId: 'cue-req',
							idempotencyKey: 'cue-key',
							attemptId: 'cue-attempt',
							runId: null,
							rootRunId: null,
							parentRunId: null,
						},
						traceId: 'cue:trace',
						workflow: null,
						delegation: { chain: [], grantRef: null },
						policyRevision: null,
					},
				})
			).toBeUndefined();
		});

		it('names an admitted chat turn by its admission, and a standalone one by nothing', () => {
			expect(spawnLifecycleLineage({ sessionId: 'agent-1-ai-t', admission: ADMISSION })).toEqual({
				identity: {
					requestId: 'req-1',
					idempotencyKey: 'req-1',
					attemptId: 'attempt-1',
					runId: null,
					rootRunId: null,
					parentRunId: null,
				},
				traceId: 'req-1',
				workflow: null,
				delegation: { chain: [], grantRef: null },
				actor: { kind: 'human', id: 'alice' },
				policyRevision: 4,
			});
			expect(spawnLifecycleLineage({ sessionId: 'agent-1-ai-t' })).toBeUndefined();
			expect(spawnLifecycleAdmission(undefined)).toBeNull();
		});
	});
});

describe('newRunId', () => {
	it('embeds the session id and timestamp and is unique across calls', () => {
		const a = newRunId('sess-1', 1000);
		const b = newRunId('sess-1', 1000);
		expect(a).toContain('sess-1');
		expect(a).toContain('1000');
		expect(a).not.toBe(b); // random suffix keeps ids distinct at the same ts
	});
});
