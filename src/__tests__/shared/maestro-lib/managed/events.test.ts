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
	INVENTORY_FACT_FIELDS,
	LIFECYCLE_FACT_FIELDS,
	createLifecycleProjector,
	inventoryEventId,
	inventoryFactProblems,
	projectInventoryEvent,
	lifecycleAdmissionOfLease,
	lifecycleEventId,
	lifecycleFactProblems,
	lifecycleLineageOf,
	lifecycleStateOf,
	projectLifecycleEvents,
	USAGE_FACT_FIELDS,
	usageEventId,
	usageFactProblems,
	type InventoryFact,
	type LifecycleFact,
	type LifecycleProjectionDeps,
	type UsageFact,
} from '../../../../shared/maestro-lib/managed/events';
import { MANAGED_ROUTES } from '../../../../shared/maestro-lib/providers/capabilities';
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

// MRC-10-04: the usage half of the projection.
const usageFact = (overrides: Partial<UsageFact> = {}): UsageFact => ({
	surface: 'agent',
	state: 'completed',
	at: 1_700_000_000_500,
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'codex',
	model: 'gpt-5-codex',
	providerSessionId: 'thread-1',
	runId: 'run:agent-1-ai-tab-1:1700000000000:abc123',
	record: 'ledger',
	accountRef: 'a'.repeat(64),
	attribution: { tenantId: 'tenant-1', orgId: 'org-eng' },
	usage: {
		provenance: 'estimated',
		tokens: 'provider-stream',
		cost: 'priced',
		costUsd: 0.0012,
		priceRevision: 'price-0123456789abcdef',
		reporting: 'running-total',
		events: 3,
		corrections: 0,
		cacheReadCounting: 'inside-input',
		counts: {
			inputTokens: 1_600,
			outputTokens: 80,
			cacheReadInputTokens: 1_300,
			cacheCreationInputTokens: null,
			reasoningTokens: null,
		},
		contextWindow: null,
	},
	...overrides,
});

describe('usage facts', () => {
	it('accepts a complete fact and names every problem of a malformed one', () => {
		expect(usageFactProblems(usageFact())).toEqual([]);
		expect(usageFactProblems(usageFact({ accountRef: null, attribution: null }))).toEqual([]);
		const problems = usageFactProblems({
			...usageFact(),
			state: 'done',
			accountRef: 42,
			attribution: { tenantId: 't', orgId: 'o', path: '/eng' },
			usage: {
				...usageFact().usage,
				provenance: 'provider_reported',
				cost: 'free',
				costUsd: -1,
				events: 1.5,
				counts: { ...usageFact().usage.counts, inputTokens: -3, prompt: 'x' },
			},
		});
		expect(problems).toEqual(
			expect.arrayContaining([
				'state is unknown',
				'accountRef is not an id or null',
				'attribution is not a tenant and org, or null',
				"usage.provenance provider_reported is the gateway's or the provider's word, not this host's",
				'usage.cost is unknown',
				'usage.costUsd is not an amount or null',
				'usage.events and usage.corrections are not counts',
				'unknown field "usage.counts.prompt"',
				'usage.counts input and output are not counts',
			])
		);
	});

	it('holds the words to the figures: no tokens means no counts, a priced cost names its revision, a reported one does not', () => {
		const base = usageFact().usage;
		expect(usageFactProblems(usageFact({ usage: { ...base, tokens: 'none' } }))).toEqual([
			'usage with no tokens carries counts or a provenance',
		]);
		expect(usageFactProblems(usageFact({ usage: { ...base, counts: null } }))).toEqual([
			'usage with tokens carries no counts',
		]);
		expect(usageFactProblems(usageFact({ usage: { ...base, cost: 'none' } }))).toEqual([
			'usage with no cost carries a figure',
			'usage.priceRevision is set exactly when this host priced the tokens',
		]);
		expect(usageFactProblems(usageFact({ usage: { ...base, cost: 'reported' } }))).toEqual([
			'usage.priceRevision is set exactly when this host priced the tokens',
		]);
		expect(
			usageFactProblems(
				usageFact({
					usage: {
						...base,
						provenance: 'unavailable',
						tokens: 'none',
						cost: 'none',
						costUsd: null,
						priceRevision: null,
						counts: null,
					},
				})
			)
		).toEqual([]);
	});

	it('refuses a fact that smuggles content under any key, at the top or inside usage', () => {
		for (const key of ['prompt', 'answerText', 'cwd', 'env', 'accountDir', 'apiKey']) {
			expect(usageFactProblems({ ...usageFact(), [key]: 'sk-secret-or-prose' })).toEqual([
				`unknown field "${key}"`,
			]);
			expect(
				usageFactProblems(usageFact({ usage: { ...usageFact().usage, [key]: 'x' } as never }))
			).toEqual([`unknown field "usage.${key}"`]);
		}
		expect(USAGE_FACT_FIELDS).toHaveLength(16);
	});

	it('projects one usage event under the shared sequence with the identities, the figures and the attribution of record, by allowlist', () => {
		const projector = createLifecycleProjector(deps());
		projector.record(fact({ at: 1_700_000_000_000 }));
		const [event] = projector.recordUsage(usageFact());
		expect(event.kind).toBe('usage');
		expect(event.sequence).toBe(2);
		expect(projector.nextSequence()).toBe(3);
		expect(event.eventId).toBe(usageEventId(INSTALLATION, usageFact()));
		expect(event.run).toMatchObject({
			runId: usageFact().runId,
			agentId: 'agent-1',
			providerSessionId: 'thread-1',
			state: 'completed',
		});
		expect(event.source).toEqual({
			surface: 'agent',
			sessionId: 'agent-1-ai-tab-1',
			tabId: 'tab-1',
			provider: 'codex',
			model: 'gpt-5-codex',
			runId: usageFact().runId,
			record: 'ledger',
			ledgerStatus: null,
			exitCode: null,
			durationMs: null,
			detail: null,
		});
		expect(event.usage).toEqual({
			...usageFact().usage,
			accountRef: 'a'.repeat(64),
			attribution: { tenantId: 'tenant-1', orgId: 'org-eng' },
		});
		expect(managedContextProblems(event.context)).toEqual([]);
		expect(event.context.identity.runId).toBe(usageFact().runId);
		expect(projector.recent().map((e) => e.kind)).toEqual(['run-state', 'usage']);
	});

	it('is one event for the same settled usage and another for a corrected total; a refused fact is counted, not thrown', () => {
		const projector = createLifecycleProjector(deps());
		const [first] = projector.recordUsage(usageFact());
		const [again] = projector.recordUsage(usageFact());
		expect(again.eventId).toBe(first.eventId);
		const [corrected] = projector.recordUsage(
			usageFact({
				usage: {
					...usageFact().usage,
					counts: { ...usageFact().usage.counts!, outputTokens: 81 },
				},
			})
		);
		expect(corrected.eventId).not.toBe(first.eventId);
		// A later move of the installation is another fact; the first keeps the org it was settled under.
		const [moved] = projector.recordUsage(
			usageFact({ attribution: { tenantId: 'tenant-1', orgId: 'org-platform' } })
		);
		expect(moved.usage.attribution?.orgId).toBe('org-platform');
		expect(first.usage.attribution?.orgId).toBe('org-eng');
		expect(
			projector.recordUsage({ ...usageFact(), prompt: 'the prompt' } as unknown as UsageFact)
		).toEqual([]);
		expect(projector.gaps()).toEqual({ dropped: 0, refused: 1 });
		expect(JSON.stringify(projector.recent())).not.toContain('the prompt');
	});

	it('carries the lineage and the admission a managed run settled under, so cost joins the request, run and attempt', () => {
		const projector = createLifecycleProjector(deps());
		const lineage = lifecycleLineageOf(context());
		const [event] = projector.recordUsage(
			usageFact({
				lineage,
				admission: {
					leaseId: 'lease-1',
					authorityId: 'auth-1',
					requestDigest: 'd1',
					policyRevision: 3,
				},
				record: 'journal',
			})
		);
		expect(event.context.identity).toEqual(lineage.identity);
		expect(event.context.actor).toEqual({ kind: 'human', id: 'alice' });
		expect(event.context.policyRevision).toBe(3);
		expect(event.run.rootRunId).toBe('root-1');
		// The lease is part of what identifies the event; another lease on the same figures is another event.
		const [other] = projector.recordUsage(
			usageFact({
				lineage,
				admission: {
					leaseId: 'lease-2',
					authorityId: 'auth-1',
					requestDigest: 'd1',
					policyRevision: 3,
				},
				record: 'journal',
			})
		);
		expect(other.eventId).not.toBe(event.eventId);
	});
});

describe('inventory facts (MRC-10-06)', () => {
	const routes = (managed: 'implemented' | 'unsupported' = 'unsupported') =>
		Object.fromEntries(
			MANAGED_ROUTES.map((route) => [
				route,
				{
					standalone: route === 'child-process' ? 'implemented' : 'unverified',
					managed: route === 'child-process' ? managed : 'unsupported',
				},
			])
		) as InventoryFact['providers'][number]['routes'];

	const inventory = (overrides: Partial<InventoryFact> = {}): InventoryFact => ({
		at: 1_700_000_000_000,
		device: { deviceId: 'enr-1', hostname: 'box', os: 'darwin 25.0.0 arm64' },
		runtimes: [
			{
				runtimeId: 'desktop-4242',
				processEpoch: 'epoch-1',
				components: [
					{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' },
					{ id: 'maestro-lib', kind: 'runtime', version: '0.21.0' },
				],
			},
		],
		providers: [
			{
				agentId: 'claude-code',
				installed: 'detected',
				version: '2.0.1',
				routes: routes('implemented'),
			},
			{ agentId: 'codex', installed: 'unknown', version: null, routes: routes() },
		],
		subagents: {
			managed: { state: 'observed', count: 0 },
			providerInternal: { state: 'unavailable', count: null },
		},
		policyRevision: 7,
		completeness: 'partial',
		gaps: ['runtimes: only this process is inventoried'],
		...overrides,
	});

	it('projects an inventory event under the shared sequence, with the host as its surface and no run', () => {
		const projector = createLifecycleProjector(deps());
		projector.record(fact());
		const [event] = projector.recordInventory(inventory());
		expect(event.kind).toBe('inventory');
		expect(event.sequence).toBe(2);
		expect(event.run).toBeUndefined();
		expect(event.source).toMatchObject({
			surface: 'host',
			sessionId: 'rt-1',
			provider: 'maestro',
			runId: 'host:rt-1:epoch-1',
			record: 'none',
			detail: 'inventory partial',
		});
		expect(event.context.identity.runId).toBe('host:rt-1:epoch-1');
		expect(event.context.policyRevision).toBe(7);
		expect(event.inventory).toEqual({
			device: { deviceId: 'enr-1', hostname: 'box', os: 'darwin 25.0.0 arm64' },
			runtimes: inventory().runtimes,
			providers: inventory().providers,
			subagents: inventory().subagents,
			policyRevision: 7,
			completeness: 'partial',
			gaps: ['runtimes: only this process is inventoried'],
		});
		// An allowlist copy: the source is not the fact, and a later mutation of the fact does not reach it.
		expect(event.inventory).not.toBe(inventory());
		expect(projector.recent()).toHaveLength(2);
		expect(projector.nextSequence()).toBe(3);
	});

	it('digests the inventory, not its time: an unchanged inventory is one event, a change is the delta', () => {
		const later = inventory({ at: 1_700_000_999_999 });
		expect(inventoryEventId(INSTALLATION, later)).toBe(inventoryEventId(INSTALLATION, inventory()));
		const detected = inventory({
			providers: [
				{ ...inventory().providers[0] },
				{ ...inventory().providers[1], installed: 'detected', version: '0.42.0' },
			],
		});
		const rebooted = inventory({
			runtimes: [{ ...inventory().runtimes[0], processEpoch: 'epoch-2' }],
		});
		const applied = inventory({ policyRevision: 8 });
		const ids = new Set(
			[inventory(), detected, rebooted, applied].map((f) => inventoryEventId(INSTALLATION, f))
		);
		expect(ids.size).toBe(4);
		expect(inventoryEventId({ installationId: 'inst-2' }, inventory())).not.toBe(
			inventoryEventId(INSTALLATION, inventory())
		);
		const event = projectInventoryEvent(inventory(), deps(), 1);
		expect(event.eventId).toBe(inventoryEventId(INSTALLATION, inventory()));
		expect(event.occurredAt).toBe('2023-11-14T22:13:20.000Z');
	});

	it('refuses a fact with an unknown field at any level, an unbounded list, a repeat, or a word that is not ours, whole', () => {
		expect(inventoryFactProblems(inventory())).toEqual([]);
		expect(INVENTORY_FACT_FIELDS).toContain('gaps');
		const problems = (value: unknown) => inventoryFactProblems(value);
		expect(problems({ ...inventory(), socketPath: '/run/endpoint.sock' })).toEqual([
			'unknown field "socketPath"',
		]);
		expect(
			problems(inventory({ device: { ...inventory().device, path: '/Users/me' } as never }))
		).toEqual(['device is not a device id, hostname and os, each or null']);
		expect(
			problems(
				inventory({
					runtimes: [inventory().runtimes[0], { ...inventory().runtimes[0] }],
				})
			)
		).toEqual(['runtimes[1] repeats desktop-4242']);
		expect(
			problems(
				inventory({
					runtimes: [
						{
							...inventory().runtimes[0],
							components: [
								{ id: 'maestro', kind: 'maestro', version: '1' },
								{ id: 'maestro', kind: 'secret' as never, version: '' },
							],
						},
					],
				})
			)
		).toEqual([
			'runtimes[0].components[1].kind is unknown',
			'runtimes[0].components[1].version is not 1 to 64 characters',
			'runtimes[0] repeats component maestro',
		]);
		const provider = inventory().providers[0];
		expect(
			problems(
				inventory({
					providers: [
						{ ...provider, installed: 'yes' as never, version: 'x'.repeat(65) },
						{
							...provider,
							routes: {
								...provider.routes,
								pty: { standalone: 'enforced', managed: 'implemented' },
							} as never,
						},
					],
				})
			)
		).toEqual([
			'providers[0].installed is unknown',
			'providers[0].version is not a version or null',
			'providers[1].routes.pty is not a standalone and managed support word',
			'providers[1] repeats claude-code',
		]);
		expect(
			problems(
				inventory({
					providers: [
						{ ...provider, routes: { 'child-process': provider.routes['child-process'] } as never },
					],
				})
			)
		).toEqual(['providers[0].routes does not name every route once']);
		// An unobserved count is never a zero, and an observed one is never null.
		expect(
			problems(
				inventory({
					subagents: {
						managed: { state: 'unavailable', count: 0 } as never,
						providerInternal: { state: 'observed', count: null } as never,
					},
				})
			)
		).toEqual([
			'subagents.managed is not an observed count or unavailable with none',
			'subagents.providerInternal is not an observed count or unavailable with none',
		]);
		expect(
			problems(
				inventory({ policyRevision: -1, completeness: 'done' as never, gaps: ['x'.repeat(513)] })
			)
		).toEqual([
			'policyRevision is not a revision or null',
			'completeness is unknown',
			'gaps is not a list of at most 64 strings',
		]);
		const projector = createLifecycleProjector(deps());
		expect(projector.recordInventory({ ...inventory(), token: 'sk-live' } as never)).toEqual([]);
		expect(projector.gaps()).toEqual({ dropped: 0, refused: 1 });
		expect(JSON.stringify(projector.recent())).not.toContain('sk-live');
	});
});

// MRC-10-07: dedup, arrival order, window gaps, the other surfaces and canaries across the three fact kinds.
describe('lifecycle projector: dedup, order, gaps and canaries (MRC-10-07)', () => {
	const routes = Object.fromEntries(
		MANAGED_ROUTES.map((route) => [route, { standalone: 'unverified', managed: 'unsupported' }])
	) as InventoryFact['providers'][number]['routes'];
	const inv = (overrides: Partial<InventoryFact> = {}): InventoryFact => ({
		at: 1_700_000_000_000,
		device: { deviceId: 'enr-1', hostname: null, os: null },
		runtimes: [
			{
				runtimeId: 'rt-1',
				processEpoch: 'epoch-1',
				components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
			},
		],
		providers: [{ agentId: 'claude-code', installed: 'detected', version: null, routes }],
		subagents: {
			managed: { state: 'observed', count: 0 },
			providerInternal: { state: 'unavailable', count: null },
		},
		policyRevision: 7,
		completeness: 'partial',
		gaps: [],
		...overrides,
	});

	it('gives a replayed fact of each kind the same event id while the sequence counts every projection', () => {
		const projector = createLifecycleProjector(deps());
		const admission = {
			leaseId: 'lease-7',
			authorityId: 'auth-1',
			requestDigest: 'digest-7',
			policyRevision: 7,
		};
		const first = projector.record(fact({ admission }));
		const again = projector.record(fact({ admission }));
		expect(first.map((e) => e.kind)).toEqual(['decision', 'run-state']);
		expect(again.map((e) => e.eventId)).toEqual(first.map((e) => e.eventId));
		expect(first[0].eventId).not.toBe(first[1].eventId);
		const [usageOnce] = projector.recordUsage(usageFact());
		const [usageAgain] = projector.recordUsage(usageFact());
		expect(usageAgain.eventId).toBe(usageOnce.eventId);
		const [inventoryOnce] = projector.recordInventory(inv());
		const [inventoryLater] = projector.recordInventory(inv({ at: inv().at + 60_000 }));
		expect(inventoryLater.eventId).toBe(inventoryOnce.eventId);
		// Eight projections, eight sequence numbers, four distinct ids: the projector numbers, the journal dedups.
		expect(projector.nextSequence()).toBe(9);
		expect(new Set(projector.recent().map((e) => e.sequence)).size).toBe(8);
		expect(new Set(projector.recent().map((e) => e.eventId)).size).toBe(4);
		// The same run under another kind is never the same id.
		expect(usageOnce.eventId).not.toBe(first[1].eventId);
		expect(inventoryOnce.eventId).not.toBe(usageOnce.eventId);
	});

	it('numbers by arrival and stamps by occurrence: facts out of time order keep their own time, and the ids do not depend on the order', () => {
		const late = fact({ at: 1_700_000_000_000, state: 'running' });
		const early = fact({ at: 1_699_999_999_000, state: 'queued' });
		const a = createLifecycleProjector(deps());
		const [lateA] = a.record(late);
		const [earlyA] = a.record(early);
		const b = createLifecycleProjector(deps());
		const [earlyB] = b.record(early);
		const [lateB] = b.record(late);
		expect([lateA.sequence, earlyA.sequence]).toEqual([1, 2]);
		expect([earlyB.sequence, lateB.sequence]).toEqual([1, 2]);
		expect(lateA.eventId).toBe(lateB.eventId);
		expect(earlyA.eventId).toBe(earlyB.eventId);
		expect(lateA.occurredAt > earlyA.occurredAt).toBe(true);
		// A reader that orders by occurrence reads the same story from both.
		const byTime = (events: readonly { occurredAt: string; eventId: string }[]) =>
			[...events].sort((x, y) => x.occurredAt.localeCompare(y.occurredAt)).map((e) => e.eventId);
		expect(byTime(a.recent())).toEqual(byTime(b.recent()));
	});

	it('counts what the window dropped and what it refused across the three kinds; a refusal takes no sequence number', () => {
		const projector = createLifecycleProjector({ ...deps(), capacity: 2 });
		projector.record(fact({ at: 1 }));
		projector.recordUsage(usageFact());
		projector.recordInventory(inv());
		expect(projector.gaps()).toEqual({ dropped: 1, refused: 0 });
		expect(projector.recent().map((e) => e.kind)).toEqual(['usage', 'inventory']);
		expect(projector.record({ ...fact(), prompt: 'p' } as never)).toEqual([]);
		expect(projector.recordUsage({ ...usageFact(), apiKey: 'k' } as never)).toEqual([]);
		expect(projector.recordInventory({ ...inv(), socketPath: '/s' } as never)).toEqual([]);
		expect(projector.gaps()).toEqual({ dropped: 1, refused: 3 });
		const [next] = projector.record(fact({ at: 2, state: 'completed', exitCode: 0 }));
		expect(next.sequence).toBe(4);
		expect(projector.gaps()).toEqual({ dropped: 2, refused: 3 });
		expect(projector.recent().map((e) => e.sequence)).toEqual([3, 4]);
	});

	it('projects every surface the producers run work on, not only an AI tab, each with a valid context', () => {
		const projector = createLifecycleProjector(deps());
		const surfaces: Partial<LifecycleFact>[] = [
			{
				surface: 'terminal',
				sessionId: 'agent-1-terminal-2',
				tabId: null,
				provider: 'terminal',
				model: null,
				runId: 'agent-1-terminal-2@1700000000000',
				record: 'omitted',
				ledgerStatus: null,
			},
			{
				surface: 'group-chat',
				sessionId: 'room-1',
				tabId: null,
				runId: 'room-1:turn-3',
				record: 'omitted',
				ledgerStatus: null,
			},
			{
				surface: 'headless-turn',
				sessionId: 'cli-7',
				tabId: null,
				runId: 'run-headless-1',
				record: 'journal',
				ledgerStatus: null,
			},
		];
		for (const overrides of surfaces) {
			const [event] = projector.record(fact(overrides));
			expect(event.source).toMatchObject({ surface: overrides.surface, record: overrides.record });
			expect(managedContextProblems(event.context)).toEqual([]);
		}
		const [usage] = projector.recordUsage(
			usageFact({
				surface: 'group-chat',
				sessionId: 'room-1',
				tabId: null,
				runId: 'room-1:turn-3',
				record: 'omitted',
			})
		);
		expect(usage.source).toMatchObject({ surface: 'group-chat', record: 'omitted' });
		expect(projector.recent().map((e) => e.source.surface)).toEqual([
			'terminal',
			'group-chat',
			'headless-turn',
			'group-chat',
		]);
	});

	it('lets no prompt, token or path through under any key of any kind at any level it validates, and keeps only the bounded detail', () => {
		const canaries = [
			'CANARY the user asked for a refactor',
			'sk-ant-api03-CANARY0123456789',
			'/Users/canary/.codex/auth.json',
		];
		const projector = createLifecycleProjector(deps());
		for (const value of canaries) {
			expect(projector.record({ ...fact(), stdin: value } as never)).toEqual([]);
			expect(
				projector.recordUsage(
					usageFact({
						usage: {
							...usageFact().usage,
							counts: { ...usageFact().usage.counts!, note: value },
						} as never,
					})
				)
			).toEqual([]);
			expect(
				projector.recordUsage(
					usageFact({
						attribution: { tenantId: 'tenant-1', orgId: 'org-eng', note: value } as never,
					})
				)
			).toEqual([]);
			expect(
				projector.recordInventory(inv({ device: { ...inv().device, path: value } as never }))
			).toEqual([]);
			expect(
				projector.recordInventory(inv({ subagents: { ...inv().subagents, note: value } as never }))
			).toEqual([]);
		}
		expect(projector.gaps()).toEqual({ dropped: 0, refused: 15 });
		// What a fact may carry is a bounded word about the state, and the source keeps it as given.
		const [kept] = projector.record(fact({ detail: 'superseded by run-2' }));
		expect(kept.source.detail).toBe('superseded by run-2');
		expect(projector.recent()).toHaveLength(1);
		const wire = JSON.stringify(projector.recent());
		for (const value of canaries) expect(wire).not.toContain(value);
	});
});
