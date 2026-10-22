/**
 * The lifecycle metadata projection (MRC-10-01): facts from the real producers
 * become `ManagedEvent`s with the identities a fleet joins on and nothing a
 * fleet must not see. Pure module; no fs, no process.
 */
import { describe, expect, it } from 'vitest';

import {
	createContextVerifier,
	createLocalHostAuthority,
	buildDispatchSnapshot,
} from '../../../../shared/maestro-lib/managed/authority';
import {
	LIFECYCLE_FACT_FIELDS,
	createLifecycleProjector,
	lifecycleAdmissionOfLease,
	lifecycleEventId,
	lifecycleFactProblems,
	lifecycleLineageOf,
	lifecycleStateOf,
	projectLifecycleEvents,
	type LifecycleFact,
	type LifecycleProjectionDeps,
} from '../../../../shared/maestro-lib/managed/events';
import {
	MANAGED_CONTRACT_VERSION,
	managedContextProblems,
	type ManagedOperationContext,
} from '../../../../shared/maestro-lib/managed/types';

const INSTALLATION = { installationId: 'inst-1', runtimeId: 'rt-1', processEpoch: 'epoch-1' };

const deps = (): LifecycleProjectionDeps => ({
	installation: INSTALLATION,
	origin: 'desktop',
	actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
	policyRevision: () => 7,
});

const fact = (overrides: Partial<LifecycleFact> = {}): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at: 1_700_000_000_000,
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'claude-code',
	model: 'opus',
	providerSessionId: null,
	runId: 'run:agent-1-ai-tab-1:1700000000000:abc123',
	record: 'ledger',
	ledgerStatus: 'running',
	exitCode: null,
	durationMs: null,
	detail: null,
	...overrides,
});

function context(): ManagedOperationContext {
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installation: INSTALLATION,
		origin: 'headless',
		actor: { kind: 'human', id: 'alice' },
		delegation: { chain: [{ kind: 'service', id: 'maestro-cli' }], grantRef: 'grant-1' },
		identity: {
			requestId: 'req-1',
			idempotencyKey: 'key-1',
			attemptId: 'attempt-1',
			runId: 'run-1',
			rootRunId: 'root-1',
			parentRunId: 'parent-1',
		},
		policyRevision: 3,
		workflow: {
			workflowId: 'wf-1',
			version: 'v1',
			triggerEventId: 'cue:1',
			ownerEpoch: 'e1',
			fencingToken: 'f1',
		},
		traceId: 'trace-1',
		requestedCapabilities: ['runs.submit'],
	};
}

describe('lifecycle facts', () => {
	it('accepts a complete fact and names every problem of a malformed one', () => {
		expect(lifecycleFactProblems(fact())).toEqual([]);
		expect(lifecycleFactProblems('nope')).toEqual(['fact is not an object']);
		const problems = lifecycleFactProblems({
			...fact(),
			surface: 'renderer',
			state: 'done',
			record: 'disk',
			at: 'yesterday',
			runId: '',
			tabId: 42,
			exitCode: 'zero',
			detail: 'x'.repeat(600),
		});
		expect(problems).toEqual(
			expect.arrayContaining([
				'surface is unknown',
				'state is unknown',
				'record is unknown',
				'at is not a time',
				'runId is not an id',
				'tabId is not an id or null',
				'exitCode is not a number or null',
				'detail is not a string within 512 characters or null',
			])
		);
	});

	it('refuses a fact that smuggles content under any key it does not know', () => {
		for (const key of ['prompt', 'answerText', 'cwd', 'env', 'args', 'stdin', 'toolOutput']) {
			expect(lifecycleFactProblems({ ...fact(), [key]: 'sk-secret-or-prose' })).toEqual([
				`unknown field "${key}"`,
			]);
		}
		expect(LIFECYCLE_FACT_FIELDS).not.toContain('prompt');
	});

	it('folds the producers vocabularies onto the six run states, never guessing success', () => {
		expect(lifecycleStateOf('waiting')).toBe('running');
		expect(lifecycleStateOf('needs_review')).toBe('running');
		expect(lifecycleStateOf('fixing')).toBe('running');
		expect(lifecycleStateOf('merged')).toBe('completed');
		expect(lifecycleStateOf('completed-with-warning')).toBe('completed');
		expect(lifecycleStateOf('crashed')).toBe('failed');
		expect(lifecycleStateOf('discarded')).toBe('cancelled');
		expect(lifecycleStateOf('interrupted')).toBe('cancelled');
		expect(lifecycleStateOf('queued')).toBe('queued');
		expect(lifecycleStateOf('vanished')).toBe('unknown');
	});

	it('copies a context into a lineage and a lease into an admission reference', () => {
		const lineage = lifecycleLineageOf(context());
		expect(lineage).toEqual({
			identity: context().identity,
			traceId: 'trace-1',
			workflow: context().workflow,
			delegation: context().delegation,
			actor: { kind: 'human', id: 'alice' },
			policyRevision: 3,
			origin: 'headless',
		});
		const admission = lifecycleAdmissionOfLease({
			leaseId: 'lease-1',
			authorityId: 'auth-1',
			snapshotDigest: 'digest-1',
			policyRevision: 5,
			decision: { decisionId: 'd1', requestDigest: 'digest-1', brokerId: 'b1', policyRevision: 5 },
		});
		expect(admission).toEqual({
			leaseId: 'lease-1',
			authorityId: 'auth-1',
			requestDigest: 'digest-1',
			policyRevision: 5,
			decision: { decisionId: 'd1', requestDigest: 'digest-1', brokerId: 'b1', policyRevision: 5 },
		});
	});
});

describe('projectLifecycleEvents', () => {
	it('projects a standalone start as one run-state event whose context is a valid contract context', () => {
		const events = projectLifecycleEvents(fact(), deps(), 1);
		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event.kind).toBe('run-state');
		expect(event.sequence).toBe(1);
		expect(event.eventId).toMatch(/^evt-[0-9a-f]{64}$/);
		expect(event.occurredAt).toBe('2023-11-14T22:13:20.000Z');
		expect(event.installation).toEqual(INSTALLATION);
		expect(managedContextProblems(event.context)).toEqual([]);
		// The run is the producer's own: one request, one attempt, its own root.
		expect(event.context.identity).toEqual({
			requestId: fact().runId,
			idempotencyKey: fact().runId,
			attemptId: fact().runId,
			runId: fact().runId,
			rootRunId: fact().runId,
			parentRunId: null,
		});
		expect(event.context.actor).toEqual({ kind: 'human', id: 'operator:inst-1' });
		expect(event.context.origin).toBe('desktop');
		expect(event.context.policyRevision).toBe(7);
		expect(event.run).toEqual({
			runId: fact().runId,
			rootRunId: fact().runId,
			parentRunId: null,
			attemptId: fact().runId,
			agentId: 'agent-1',
			providerSessionId: null,
			state: 'running',
		});
		expect(event.source).toEqual({
			surface: 'agent',
			sessionId: 'agent-1-ai-tab-1',
			tabId: 'tab-1',
			provider: 'claude-code',
			model: 'opus',
			runId: fact().runId,
			record: 'ledger',
			ledgerStatus: 'running',
			exitCode: null,
			durationMs: null,
			detail: null,
		});
		expect(event).not.toHaveProperty('decision');
	});

	it('uses the lineage for the context and the managed run when the work had one', () => {
		const lineage = lifecycleLineageOf(context());
		const [event] = projectLifecycleEvents(fact({ lineage, record: 'journal' }), deps(), 4);
		expect(event.context.identity).toEqual(context().identity);
		expect(event.context.actor).toEqual({ kind: 'human', id: 'alice' });
		expect(event.context.origin).toBe('headless');
		expect(event.context.policyRevision).toBe(3);
		expect(event.context.workflow).toEqual(context().workflow);
		expect(event.context.delegation).toEqual(context().delegation);
		expect(event.context.traceId).toBe('trace-1');
		expect(event.run).toMatchObject({
			runId: 'run-1',
			rootRunId: 'root-1',
			parentRunId: 'parent-1',
			attemptId: 'attempt-1',
		});
		// The producer's own id is still in the source, beside the managed run.
		expect(event.source.runId).toBe(fact().runId);
		expect(managedContextProblems(event.context)).toEqual([]);
	});

	it('puts a decision event before the run-state of an admitted start, with the lease identities', () => {
		const admission = {
			leaseId: 'lease-9',
			authorityId: 'auth-1',
			requestDigest: 'digest-9',
			policyRevision: 11,
			operation: 'start' as const,
			target: { kind: 'local' as const },
		};
		const events = projectLifecycleEvents(fact({ admission }), deps(), 10);
		expect(events.map((e) => [e.kind, e.sequence])).toEqual([
			['decision', 10],
			['run-state', 11],
		]);
		expect(events[0].decision).toEqual(admission);
		expect(events[0].context.policyRevision).toBe(11);
		expect(events[1]).not.toHaveProperty('decision');
		// An exit under the same admission is a run-state alone: the decision was already projected.
		const exit = projectLifecycleEvents(
			fact({ admission, state: 'completed', exitCode: 0, durationMs: 50 }),
			deps(),
			12
		);
		expect(exit.map((e) => e.kind)).toEqual(['run-state']);
	});

	it('gives the same fact the same event id, and a different state or time another', () => {
		const a = lifecycleEventId(INSTALLATION, 'run-state', fact());
		expect(lifecycleEventId(INSTALLATION, 'run-state', fact())).toBe(a);
		expect(lifecycleEventId(INSTALLATION, 'run-state', fact({ state: 'completed' }))).not.toBe(a);
		expect(lifecycleEventId(INSTALLATION, 'run-state', fact({ at: 1 }))).not.toBe(a);
		expect(lifecycleEventId(INSTALLATION, 'decision', fact())).not.toBe(a);
		expect(
			lifecycleEventId({ ...INSTALLATION, processEpoch: 'epoch-2' }, 'run-state', fact())
		).not.toBe(a);
	});

	it('projects the surfaces the ledger omits, saying so', () => {
		const terminal = fact({
			surface: 'terminal',
			sessionId: 'agent-1-terminal-3',
			tabId: null,
			provider: 'terminal',
			model: null,
			runId: 'agent-1-terminal-3@1700000000000',
			record: 'omitted',
			ledgerStatus: null,
		});
		const [event] = projectLifecycleEvents(terminal, deps(), 1);
		expect(event.source).toMatchObject({ surface: 'terminal', record: 'omitted' });
		expect(managedContextProblems(event.context)).toEqual([]);
	});

	it('carries no text of the work: serialized events never contain the canaries', () => {
		const canary = 'CANARY-PROMPT-sk-ant-0123456789';
		const events = projectLifecycleEvents(
			{ ...fact(), prompt: canary, answer: canary } as unknown as LifecycleFact,
			deps(),
			1
		);
		expect(JSON.stringify(events)).not.toContain(canary);
	});
});

describe('createLifecycleProjector', () => {
	it('numbers events from 1, keeps a bounded window and counts what fell out of it', () => {
		const projector = createLifecycleProjector({ ...deps(), capacity: 3 });
		expect(projector.nextSequence()).toBe(1);
		projector.record(fact({ at: 1 }));
		projector.record(fact({ at: 2, state: 'completed', exitCode: 0 }));
		projector.record(fact({ at: 3, sessionId: 'agent-1-ai-tab-2', runId: 'r2' }));
		projector.record(fact({ at: 4, sessionId: 'agent-1-ai-tab-2', runId: 'r2', state: 'failed' }));
		expect(projector.nextSequence()).toBe(5);
		expect(projector.recent().map((e) => e.sequence)).toEqual([2, 3, 4]);
		expect(projector.gaps()).toEqual({ dropped: 1, refused: 0 });
	});

	it('refuses a fact that is not one, counts it, and never throws', () => {
		const projector = createLifecycleProjector(deps());
		expect(
			projector.record({ ...fact(), prompt: 'the whole prompt' } as unknown as LifecycleFact)
		).toEqual([]);
		expect(projector.record(fact({ runId: '' }))).toEqual([]);
		expect(projector.gaps()).toEqual({ dropped: 0, refused: 2 });
		expect(projector.recent()).toEqual([]);
		expect(projector.nextSequence()).toBe(1);
	});

	it('hands every event to each subscriber, drops a throwing one for that event only, and unsubscribes', () => {
		const projector = createLifecycleProjector(deps());
		const heard: string[] = [];
		const unsubscribe = projector.subscribe((event) => heard.push(`a:${event.sequence}`));
		projector.subscribe(() => {
			throw new Error('consumer bug');
		});
		projector.subscribe((event) => heard.push(`b:${event.sequence}`));
		expect(() => projector.record(fact({ at: 1 }))).not.toThrow();
		unsubscribe();
		projector.record(fact({ at: 2, state: 'completed', exitCode: 0 }));
		expect(heard).toEqual(['a:1', 'b:1', 'b:2']);
	});

	it('joins a start to the lease a real authority minted, and never to a forged one', async () => {
		const verifier = createContextVerifier({
			verifierId: 'v1',
			peer: 'in-process',
			now: () => 1_000,
			accept: () => [],
		});
		const verified = verifier.verify(context());
		if (!verified.ok) throw new Error(verified.problems.join('; '));
		const authority = createLocalHostAuthority({
			authorityId: 'auth-1',
			decide: () => ({
				decision: 'allow',
				policyRevision: 3,
				receipt: { decisionId: 'd1', requestDigest: 'x', brokerId: 'b1', policyRevision: 3 },
			}),
			now: () => 1_000,
			newId: () => 'lease-1',
		});
		const snapshot = buildDispatchSnapshot(
			{ command: 'claude', args: ['-p'], cwd: '/w', env: {}, stdin: 'the prompt text' },
			{ provider: 'claude-code' }
		);
		const admitted = await authority.admit({
			context: verified.context,
			snapshot,
			policy: { sources: [], policyRevision: 3 },
		});
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		const projector = createLifecycleProjector(deps());
		const events = projector.record(
			fact({
				lineage: lifecycleLineageOf(verified.context),
				admission: lifecycleAdmissionOfLease(admitted.lease),
				record: 'journal',
			})
		);
		expect(events[0].kind).toBe('decision');
		expect(events[0].decision).toEqual({
			leaseId: 'lease-1',
			authorityId: 'auth-1',
			requestDigest: admitted.lease.snapshotDigest,
			policyRevision: 3,
			decision: { decisionId: 'd1', requestDigest: 'x', brokerId: 'b1', policyRevision: 3 },
		});
		// The prompt went into the snapshot by digest; the event has the digest and not the text.
		expect(JSON.stringify(events)).not.toContain('the prompt text');
	});
});
