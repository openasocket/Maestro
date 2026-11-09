/**
 * The desktop's usage producer (MRC-10-04): parsed reports observed per raw
 * process session, a fact settled with the host's total, the agent's account
 * reference and the tenant and org of record, projected as a `usage` event
 * through the real projector and kept by the real journal. Missingness is
 * explicit (a silent process is `unavailable`, an unreported field is null),
 * a Codex turn is priced here under a named rate-table revision, a Claude turn
 * keeps the cost its stream reported, and no prompt, path or directory name
 * reaches an event under any key.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	buildUsageFact,
	createUsageCapture,
	usageAttributionOf,
	usageReportFromStats,
	usageSettlingSink,
	type UsageSettleInput,
} from '../../../main/enterprise/usage';
import type { ManagedIdentityView } from '../../../shared/maestro-lib/managed/endpoint-port';
import { createEventJournal } from '../../../shared/maestro-lib/managed/event-journal';
import {
	createLifecycleProjector,
	usageFactProblems,
	type LifecycleFact,
	type LifecycleProjector,
	type ManagedUsageEvent,
} from '../../../shared/maestro-lib/managed/events';
import {
	UsageProvenanceTracker,
	usagePriceRevision,
} from '../../../shared/maestro-lib/streaming/usage-accumulator';
import type { UsageStats } from '../../../shared/types';

const T0 = Date.parse('2026-10-22T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-100',
	processEpoch: 'epoch-1',
};

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projector(): LifecycleProjector {
	return createLifecycleProjector({
		installation: INSTALLATION,
		origin: 'desktop',
		actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
		policyRevision: () => 3,
	});
}

const enrolled = (orgId = 'org-eng'): Pick<ManagedIdentityView, 'status' | 'record'> => ({
	status: 'ok',
	record: {
		version: 1,
		installationId: 'inst-1',
		tenantId: 'tenant-1',
		orgId,
		enrollmentId: 'enr-1',
		endpoint: { socketPath: '/tmp/endpoint.sock' } as never,
		management: 'managed' as never,
		registration: null,
		policy: { desiredRevision: 3, appliedRevision: 3, observedAt: null },
		enrolledAt: '2026-10-22T11:00:00.000Z',
		updatedAt: '2026-10-22T11:00:00.000Z',
	},
});

const total = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 1_600,
	outputTokens: 80,
	cacheReadInputTokens: 1_300,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0,
	contextWindow: 272_000,
	...overrides,
});

const settle = (overrides: Partial<UsageSettleInput> = {}): UsageSettleInput => ({
	surface: 'agent',
	state: 'completed',
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'codex',
	model: 'gpt-5-codex',
	providerSessionId: 'thread-1',
	runId: 'run-1',
	record: 'ledger',
	total: total(),
	...overrides,
});

describe('usageAttributionOf', () => {
	it('reads the tenant and org off a readable record and nothing off anything else', () => {
		expect(usageAttributionOf(enrolled())).toEqual({ tenantId: 'tenant-1', orgId: 'org-eng' });
		expect(usageAttributionOf(null)).toBeNull();
		expect(usageAttributionOf({ status: 'none', record: null })).toBeNull();
		expect(usageAttributionOf({ status: 'unprotected', record: enrolled().record })).toBeNull();
	});
});

describe('createUsageCapture', () => {
	it('settles a Codex turn priced here under the rate table revision, bound to the account and the org of record', () => {
		const p = projector();
		const resolved: string[] = [];
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: ({ agentId, provider }) => {
				resolved.push(`${agentId}:${provider}`);
				return 'b'.repeat(64);
			},
			now: () => T0,
		});
		capture.observe('agent-1-ai-tab-1', 'codex', {
			inputTokens: 1_000,
			outputTokens: 50,
			cacheReadTokens: 800,
			model: 'gpt-5-codex',
		});
		capture.observe('agent-1-ai-tab-1', 'codex', {
			inputTokens: 1_600,
			outputTokens: 80,
			cacheReadTokens: 1_300,
			model: 'gpt-5-codex',
		});
		expect(capture.size()).toBe(1);
		const [event] = capture.settle(settle());
		expect(capture.size()).toBe(0);
		expect(resolved).toEqual(['agent-1:codex']);
		expect(event.kind).toBe('usage');
		expect(event.occurredAt).toBe('2026-10-22T12:00:00.000Z');
		expect(event.usage).toMatchObject({
			provenance: 'estimated',
			tokens: 'provider-stream',
			cost: 'priced',
			priceRevision: usagePriceRevision('gpt-5-codex'),
			reporting: 'running-total',
			events: 2,
			cacheReadCounting: 'inside-input',
			counts: {
				inputTokens: 1_600,
				outputTokens: 80,
				cacheReadInputTokens: 1_300,
				cacheCreationInputTokens: null,
				reasoningTokens: null,
			},
			accountRef: 'b'.repeat(64),
			attribution: { tenantId: 'tenant-1', orgId: 'org-eng' },
		});
		expect(event.usage.costUsd).toBeCloseTo((300 * 1.25 + 1_300 * 0.125 + 80 * 10) / 1_000_000, 10);
		expect(event.run).toMatchObject({ runId: 'run-1', agentId: 'agent-1', state: 'completed' });
	});

	it('keeps the cost a Claude stream reported, and a silent process settles as unavailable with no counts', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('agent-1-ai-tab-1', 'claude-code', {
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 900,
			cacheCreationTokens: 100,
			costUsd: 0.0123,
		});
		const [claude] = capture.settle(
			settle({
				provider: 'claude-code',
				model: 'claude-opus-4-8',
				total: total({
					inputTokens: 10,
					outputTokens: 5,
					cacheReadInputTokens: 900,
					cacheCreationInputTokens: 100,
					totalCostUsd: 0.0123,
				}),
			})
		);
		expect(claude.usage).toMatchObject({
			cost: 'reported',
			costUsd: 0.0123,
			priceRevision: null,
			reporting: 'turn-total',
			cacheReadCounting: 'beside-input',
			accountRef: null,
			attribution: null,
		});
		const [silent] = capture.settle(
			settle({ sessionId: 'agent-1-ai-tab-2', runId: 'run-2', state: 'failed', total: undefined })
		);
		expect(silent.usage).toMatchObject({
			provenance: 'unavailable',
			tokens: 'none',
			cost: 'none',
			costUsd: null,
			counts: null,
			reporting: 'none',
			events: 0,
		});
		expect(silent.run.state).toBe('failed');
	});

	it('keeps concurrent processes apart by raw session id, forgets on request, bounds what it tracks, and survives a throwing resolver', () => {
		const p = projector();
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: () => {
				throw new Error('store unavailable');
			},
			capacity: 2,
		});
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		capture.observe('agent-1-ai-tab-1-fp-1', 'codex', { inputTokens: 900, outputTokens: 9 });
		// A third open session pushes the oldest out: it settles as silent.
		capture.observe('agent-2-ai-tab-1', 'codex', { inputTokens: 5, outputTokens: 5 });
		expect(capture.size()).toBe(2);
		const [evicted] = capture.settle(
			settle({ total: total({ inputTokens: 100, outputTokens: 1 }) })
		);
		expect(evicted.usage.tokens).toBe('none');
		const [parallel] = capture.settle(
			settle({
				sessionId: 'agent-1-ai-tab-1-fp-1',
				runId: 'run-fp',
				total: total({ inputTokens: 900, outputTokens: 9, cacheReadInputTokens: 0 }),
			})
		);
		expect(parallel.usage).toMatchObject({
			tokens: 'provider-stream',
			counts: { inputTokens: 900, outputTokens: 9, cacheReadInputTokens: null },
			accountRef: null,
			attribution: { tenantId: 'tenant-1', orgId: 'org-eng' },
		});
		capture.forget('agent-2-ai-tab-1');
		expect(capture.size()).toBe(0);
	});

	it('stamps the org the record names at settle and never rewrites an earlier fact; the real journal keeps both', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-usage-'));
		dirs.push(dir);
		let ids = 0;
		const journal = createEventJournal({
			file: path.join(dir, 'maestro-managed-events.json'),
			now: () => T0,
			newId: () => `j-${++ids}`,
		});
		const loaded = await journal.load();
		if (!loaded.ok) throw new Error(loaded.message);
		const p = projector();
		journal.attach(p);
		let identity = enrolled('org-eng');
		const capture = createUsageCapture({
			events: p,
			identity: () => identity,
			accountRef: () => null,
			now: () => T0,
		});
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		const [before] = capture.settle(
			settle({ total: total({ inputTokens: 100, outputTokens: 1 }) })
		);
		identity = enrolled('org-platform');
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		const [after] = capture.settle(
			settle({ runId: 'run-2', total: total({ inputTokens: 100, outputTokens: 1 }) })
		);
		expect(before.usage.attribution?.orgId).toBe('org-eng');
		expect(after.usage.attribution?.orgId).toBe('org-platform');
		// The same settled usage replayed is the same event; the journal holds it once.
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		const [replay] = capture.settle(
			settle({ runId: 'run-2', total: total({ inputTokens: 100, outputTokens: 1 }) })
		);
		expect(replay.eventId).toBe(after.eventId);
		const page = journal.page({ cursor: null, limit: 10 });
		expect(page.items.map((e) => e.eventId)).toEqual([before.eventId, after.eventId]);
		expect(page.items.map((e) => e.sequence)).toEqual([1, 2]);
		await journal.flush();
	});

	it('lets nothing but metadata through: a report or a settle carrying a prompt, a path or a directory name leaves no trace', () => {
		const p = projector();
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: () => '/Users/someone/.codex-work',
		});
		capture.observe('agent-1-ai-tab-1', 'codex', {
			inputTokens: 100,
			outputTokens: 1,
			prompt: 'the whole prompt',
			cwd: '/Users/someone/project',
		} as never);
		const events = capture.settle(
			settle({
				total: total({ inputTokens: 100, outputTokens: 1 }),
				answerText: 'the answer',
			} as never)
		);
		expect(events).toHaveLength(1);
		const wire = JSON.stringify(events);
		for (const canary of ['the whole prompt', '/Users/someone/project', 'the answer']) {
			expect(wire).not.toContain(canary);
		}
		// A directory name is not an account reference; it is on the fact as given and the fact says so by shape.
		const fact = buildUsageFact(settle(), new UsageProvenanceTracker().summary(), {
			at: T0,
			accountRef: '/Users/someone/.codex-work',
			attribution: null,
		});
		expect(usageFactProblems(fact)).toEqual([]);
		expect(fact.accountRef).toBe('/Users/someone/.codex-work');
	});
});

// MRC-10-07: unknown usage (no model, no total, replays only), the other surfaces, the managed lineage, and canaries.
describe('usage capture: unknown usage, replays, surfaces and canaries (MRC-10-07)', () => {
	const lineage = {
		identity: {
			requestId: 'req-1',
			idempotencyKey: 'key-1',
			attemptId: 'attempt-1',
			runId: 'run-1',
			rootRunId: 'root-1',
			parentRunId: null,
		},
		traceId: 'trace-1',
		workflow: null,
		delegation: { chain: [], grantRef: null },
	};

	it('settles what nothing can price as estimated tokens with no cost: a stream that named no model and a settle that names none', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('pi-1', 'pi', { inputTokens: 10, outputTokens: 2 });
		capture.observe('pi-1', 'pi', { inputTokens: 12, outputTokens: 3 });
		const [event] = capture.settle(
			settle({
				sessionId: 'pi-1',
				provider: 'pi',
				model: null,
				providerSessionId: null,
				total: total({
					inputTokens: 22,
					outputTokens: 5,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					contextWindow: 0,
				}),
			})
		);
		expect(event.usage).toEqual({
			provenance: 'estimated',
			tokens: 'provider-stream',
			cost: 'none',
			costUsd: null,
			priceRevision: null,
			reporting: 'per-step',
			events: 2,
			corrections: 0,
			cacheReadCounting: 'unknown',
			counts: {
				inputTokens: 22,
				outputTokens: 5,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				reasoningTokens: null,
			},
			contextWindow: null,
			accountRef: null,
			attribution: null,
		});
		expect(event.source.model).toBeNull();
	});

	it('a stream that reported but a host that summed nothing is unavailable with the reports counted; replays that carry only a correction are not reports', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('codex-1', 'codex', { inputTokens: 5, outputTokens: 1 });
		const [noTotal] = capture.settle(settle({ sessionId: 'codex-1', total: undefined }));
		expect(noTotal.usage).toMatchObject({
			provenance: 'unavailable',
			tokens: 'none',
			cost: 'none',
			costUsd: null,
			counts: null,
			events: 1,
			corrections: 0,
			reporting: 'running-total',
		});
		capture.observe('codex-2', 'codex', { inputTokens: 5, outputTokens: 1, correctionOnly: true });
		capture.observe('codex-2', 'codex', { inputTokens: 5, outputTokens: 1, correctionOnly: true });
		const [onlyCorrections] = capture.settle(
			settle({ sessionId: 'codex-2', runId: 'run-2', total: total() })
		);
		expect(onlyCorrections.usage).toMatchObject({
			provenance: 'unavailable',
			tokens: 'none',
			events: 0,
			corrections: 2,
			reporting: 'none',
			counts: null,
		});
		expect(capture.size()).toBe(0);
	});

	it('names the reporting: a known provider keeps its word even for one report, a tracker told nothing says single-event, and a context window counts only when a report named it', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('pi-1', 'pi', {
			inputTokens: 10,
			outputTokens: 2,
			contextWindowReported: true,
		});
		const [single] = capture.settle(
			settle({
				sessionId: 'pi-1',
				provider: 'pi',
				total: total({ inputTokens: 10, outputTokens: 2 }),
			})
		);
		// The capture names every provider's reporting up front, so one report is still that word; only a tracker told nothing says single-event.
		expect(single.usage).toMatchObject({ reporting: 'per-step', contextWindow: 272_000 });
		const untold = new UsageProvenanceTracker();
		untold.observe({ inputTokens: 10, outputTokens: 2 });
		expect(untold.summary().reporting).toBe('single-event');
		capture.observe('claude-1', 'claude-code', { inputTokens: 10, outputTokens: 2 });
		const [turn] = capture.settle(
			settle({
				sessionId: 'claude-1',
				provider: 'claude-code',
				model: 'claude-opus-4-8',
				total: total({ inputTokens: 10, outputTokens: 2 }),
			})
		);
		expect(turn.usage).toMatchObject({ reporting: 'turn-total', contextWindow: null });
	});

	it('the model a stream names prices the turn but never reaches the event; a token-shaped model, a prompt or a key in a report leaves no trace', () => {
		const canaryModel = 'sk-ant-api03-CANARY-MODEL';
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('pi-1', 'pi', {
			inputTokens: 100,
			outputTokens: 10,
			model: canaryModel,
			prompt: 'CANARY PROMPT',
			apiKey: 'CANARY KEY',
		} as never);
		const [event] = capture.settle(
			settle({
				sessionId: 'pi-1',
				provider: 'pi',
				model: null,
				total: total({
					inputTokens: 100,
					outputTokens: 10,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				}),
			})
		);
		// A model nothing resolves prices at the default table: the revision is the table's digest, not the name.
		expect(event.usage).toMatchObject({ cost: 'priced', priceRevision: usagePriceRevision(null) });
		expect(event.usage.priceRevision).toBe(usagePriceRevision(canaryModel));
		expect(event.source.model).toBeNull();
		const wire = JSON.stringify(p.recent());
		for (const canary of [canaryModel, 'CANARY PROMPT', 'CANARY KEY', 'sk-ant']) {
			expect(wire).not.toContain(canary);
		}
	});

	it('carries the lineage and the admission of a managed settle, so the usage joins the request and the lease; another lease on the same figures is another event', () => {
		const p = projector();
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: () => null,
		});
		const admission = {
			leaseId: 'lease-1',
			authorityId: 'auth-1',
			requestDigest: 'digest-1',
			policyRevision: 3,
		};
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		const [first] = capture.settle(
			settle({
				lineage,
				admission,
				record: 'journal',
				total: total({ inputTokens: 100, outputTokens: 1 }),
			})
		);
		expect(first.context.identity).toEqual(lineage.identity);
		expect(first.context.traceId).toBe('trace-1');
		expect(first.context.policyRevision).toBe(3);
		expect(first.run).toMatchObject({
			runId: 'run-1',
			rootRunId: 'root-1',
			attemptId: 'attempt-1',
		});
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		const [other] = capture.settle(
			settle({
				lineage,
				admission: { ...admission, leaseId: 'lease-2' },
				record: 'journal',
				total: total({ inputTokens: 100, outputTokens: 1 }),
			})
		);
		expect(other.eventId).not.toBe(first.eventId);
		expect(other.usage).toEqual(first.usage);
	});

	it('settles every surface: a room turn and a headless turn are usage events too, with the record each producer keeps', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('room-1', 'codex', { inputTokens: 40, outputTokens: 4 });
		const [room] = capture.settle(
			settle({
				surface: 'group-chat',
				sessionId: 'room-1',
				tabId: null,
				runId: 'room-1:turn-3',
				record: 'omitted',
				total: total({ inputTokens: 40, outputTokens: 4 }),
			})
		);
		capture.observe('cli-7', 'claude-code', { inputTokens: 30, outputTokens: 3, costUsd: 0.001 });
		const [headless] = capture.settle(
			settle({
				surface: 'headless-turn',
				sessionId: 'cli-7',
				tabId: null,
				provider: 'claude-code',
				model: 'claude-opus-4-8',
				runId: 'run-headless-1',
				record: 'journal',
				total: total({ inputTokens: 30, outputTokens: 3, totalCostUsd: 0.001 }),
			})
		);
		expect(room.source).toMatchObject({ surface: 'group-chat', record: 'omitted', tabId: null });
		expect(headless.source).toMatchObject({ surface: 'headless-turn', record: 'journal' });
		expect(headless.usage).toMatchObject({
			cost: 'reported',
			costUsd: 0.001,
			reporting: 'turn-total',
		});
		expect(p.recent().map((e) => e.kind)).toEqual(['usage', 'usage']);
	});

	it('a settle the projector refuses is a counted gap in the attached journal, never a throw, and the file never sees what it carried', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-usage-'));
		dirs.push(dir);
		let ids = 0;
		const journal = createEventJournal({
			file: path.join(dir, 'maestro-managed-events.json'),
			now: () => T0,
			newId: () => `j-${++ids}`,
		});
		const loaded = await journal.load();
		if (!loaded.ok) throw new Error(loaded.message);
		const p = projector();
		journal.attach(p);
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		capture.observe('agent-1-ai-tab-1', 'codex', { inputTokens: 100, outputTokens: 1 });
		expect(
			capture.settle(
				settle({
					state: 'done' as never,
					answerText: 'CANARY ANSWER',
					total: total({ inputTokens: 100, outputTokens: 1 }),
				} as never)
			)
		).toEqual([]);
		expect(p.gaps()).toEqual({ dropped: 0, refused: 1 });
		// The refused settle forgot its session: the next settle of it is a silent one.
		expect(capture.size()).toBe(0);
		const [next] = capture.settle(settle({ runId: 'run-2', total: total() }));
		expect(next.usage.provenance).toBe('unavailable');
		expect(journal.status().gaps).toEqual([
			expect.objectContaining({ kind: 'projector-refused', count: 1, afterSequence: 0 }),
		]);
		expect(journal.page({ cursor: null, limit: 10 })).toMatchObject({ completeness: 'gap' });
		await journal.flush();
		expect(fs.readFileSync(journal.file, 'utf8')).not.toContain('CANARY ANSWER');
	});
});

describe('actual process usage stream and run settlement (MCOMP-27-01)', () => {
	const lifecycleFact = (overrides: Partial<LifecycleFact> = {}): LifecycleFact => ({
		surface: 'agent',
		state: 'completed',
		at: T0,
		sessionId: 'agent-1-ai-tab-1',
		agentId: 'agent-1',
		tabId: 'tab-1',
		provider: 'claude-code',
		model: 'claude-sonnet-4-5',
		providerSessionId: null,
		runId: 'run-1',
		record: 'ledger',
		ledgerStatus: 'completed',
		exitCode: 0,
		durationMs: 1_000,
		detail: null,
		admission: null,
		...overrides,
	});

	it('reads emitted stats back conservatively: an unfilled zero is not reported, a correction is not a report', () => {
		expect(usageReportFromStats(total({ cacheReadInputTokens: 0, totalCostUsd: 0 }))).toEqual({
			inputTokens: 1_600,
			outputTokens: 80,
		});
		expect(
			usageReportFromStats(
				total({ cacheCreationInputTokens: 40, totalCostUsd: 0.02, reasoningTokens: 7 })
			)
		).toEqual({
			inputTokens: 1_600,
			outputTokens: 80,
			cacheReadTokens: 1_300,
			cacheCreationTokens: 40,
			reasoningTokens: 7,
			costUsd: 0.02,
		});
		expect(usageReportFromStats(total({ contextWindowCorrectionOnly: true }))).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			correctionOnly: true,
		});
	});

	it('sums the stream, settles on the run terminal fact with the reported cost, and passes every lifecycle fact through', () => {
		const p = projector();
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: ({ provider }) => (provider === 'claude-code' ? 'c'.repeat(64) : null),
			now: () => T0,
		});
		const sink = usageSettlingSink(p, capture);
		sink.record(lifecycleFact({ state: 'running', ledgerStatus: 'running', exitCode: null }));
		capture.observeStats(
			'agent-1-ai-tab-1',
			'claude-code',
			total({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, totalCostUsd: 0.01 })
		);
		capture.observeStats(
			'agent-1-ai-tab-1',
			'claude-code',
			total({ inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 30, totalCostUsd: 0.02 })
		);
		// A window correction replays counts already reported: observed, never summed.
		capture.observeStats(
			'agent-1-ai-tab-1',
			'claude-code',
			total({ inputTokens: 20, outputTokens: 7, contextWindowCorrectionOnly: true })
		);
		expect(capture.size()).toBe(1);
		sink.record(lifecycleFact());
		expect(capture.size()).toBe(0);
		const kinds = p.recent().map((event) => event.kind);
		expect(kinds.filter((kind) => kind === 'usage')).toHaveLength(1);
		const usageEvent = p.recent().find((event) => event.kind === 'usage') as ManagedUsageEvent;
		expect(usageEvent.usage).toMatchObject({
			provenance: 'estimated',
			cost: 'reported',
			events: 2,
			corrections: 1,
			counts: { inputTokens: 30, outputTokens: 12, cacheReadInputTokens: 30 },
		});
		expect(usageEvent.usage.costUsd).toBeCloseTo(0.03, 10);
		expect(usageEvent.usage.accountRef).toBe('c'.repeat(64));
	});

	it('settles a silent run as unavailable, never a zero, and settles nothing for a shell terminal or a running fact', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		const sink = usageSettlingSink(p, capture);
		sink.record(
			lifecycleFact({ surface: 'terminal', sessionId: 'agent-1-terminal', record: 'omitted' })
		);
		sink.record(lifecycleFact({ state: 'running', ledgerStatus: 'running', exitCode: null }));
		expect(p.recent().some((event) => event.kind === 'usage')).toBe(false);
		sink.record(lifecycleFact({ state: 'failed', ledgerStatus: 'failed', exitCode: 1 }));
		const usageEvents = p.recent().filter((event) => event.kind === 'usage') as ManagedUsageEvent[];
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0].usage).toMatchObject({
			provenance: 'unavailable',
			counts: null,
			costUsd: null,
		});
	});

	it('keeps a retry or a provider swap on the same session a separate fact under its own run and provider', () => {
		const p = projector();
		const capture = createUsageCapture({ events: p, identity: () => null, accountRef: () => null });
		const sink = usageSettlingSink(p, capture);
		capture.observeStats('agent-1-ai-tab-1', 'claude-code', total({ totalCostUsd: 0.05 }));
		sink.record(
			lifecycleFact({
				state: 'cancelled',
				ledgerStatus: 'cancelled',
				detail: 'superseded by run-2',
			})
		);
		capture.observeStats('agent-1-ai-tab-1', 'codex', total({ inputTokens: 5, outputTokens: 1 }));
		sink.record(lifecycleFact({ runId: 'run-2', provider: 'codex', model: 'gpt-5-codex' }));
		const usageEvents = p.recent().filter((event) => event.kind === 'usage') as ManagedUsageEvent[];
		expect(usageEvents.map((event) => event.eventId)).toHaveLength(2);
		expect(new Set(usageEvents.map((event) => event.eventId)).size).toBe(2);
		expect(usageEvents[0].usage).toMatchObject({
			cost: 'reported',
			counts: { inputTokens: 1_600 },
		});
		expect(usageEvents[1].usage).toMatchObject({ cost: 'priced', counts: { inputTokens: 5 } });
	});

	it('never lets a failing settle disturb the lifecycle path', () => {
		const p = projector();
		const sink = usageSettlingSink(p, {
			settle: () => {
				throw new Error('boom');
			},
		});
		expect(sink.record(lifecycleFact())).not.toHaveLength(0);
	});
});

// MCOMP-27-04: the actual process stream, settled by the run capture, kept by the real journal.
describe('actual process usage into the journal (MCOMP-27-04)', () => {
	const terminal = (overrides: Partial<LifecycleFact>): LifecycleFact => ({
		surface: 'agent',
		state: 'completed',
		at: T0,
		sessionId: 'agent-1-ai-tab-1',
		agentId: 'agent-1',
		tabId: 'tab-1',
		provider: 'codex',
		model: 'gpt-5-codex',
		providerSessionId: null,
		runId: 'run-a',
		record: 'ledger',
		ledgerStatus: 'completed',
		exitCode: 0,
		durationMs: 1_000,
		detail: null,
		admission: null,
		...overrides,
	});

	it('keeps concurrent processes apart, settles each run under its own provider and account, and a replayed exit never adds spend', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-usage-'));
		dirs.push(dir);
		let ids = 0;
		const journal = createEventJournal({
			file: path.join(dir, 'maestro-managed-events.json'),
			now: () => T0,
			newId: () => `j-${++ids}`,
		});
		const loaded = await journal.load();
		if (!loaded.ok) throw new Error(loaded.message);
		const p = projector();
		journal.attach(p);
		const capture = createUsageCapture({
			events: p,
			identity: () => enrolled(),
			accountRef: ({ provider }) => (provider === 'codex' ? 'a'.repeat(64) : null),
			now: () => T0,
		});
		const sink = usageSettlingSink(p, capture);
		const codexStep = (input: number, output: number) =>
			total({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0 });
		capture.observeStats('agent-1-ai-tab-1', 'codex', codexStep(1_000, 10));
		capture.observeStats(
			'agent-2-ai-tab-9',
			'claude-code',
			total({ inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, totalCostUsd: 0.004 })
		);
		capture.observeStats('agent-1-ai-tab-1', 'codex', codexStep(500, 5));
		expect(capture.size()).toBe(2);
		sink.record(
			terminal({
				sessionId: 'agent-2-ai-tab-9',
				agentId: 'agent-2',
				tabId: 'tab-9',
				provider: 'claude-code',
				model: 'claude-sonnet-4-5',
				runId: 'run-b',
			})
		);
		sink.record(terminal({}));
		sink.record(terminal({}));
		expect(capture.size()).toBe(0);

		const usage = journal
			.page({ cursor: null, limit: 50 })
			.items.filter((e) => e.kind === 'usage') as unknown as ManagedUsageEvent[];
		const withFigures = usage.filter((e) => e.usage.counts !== null);
		expect(withFigures.map((e) => e.run.runId)).toEqual(['run-b', 'run-a']);
		const [claude, codex] = withFigures;
		expect(claude.usage).toMatchObject({
			cost: 'reported',
			costUsd: 0.004,
			counts: { inputTokens: 50, outputTokens: 5 },
		});
		expect(claude.usage.accountRef).toBeNull();
		expect(codex.usage).toMatchObject({
			cost: 'priced',
			counts: { inputTokens: 1_500, outputTokens: 15 },
			accountRef: 'a'.repeat(64),
		});
		expect(codex.usage.costUsd).toBeGreaterThan(0);
		// Whatever the replay records, it is missingness, never a figure or a zero.
		for (const replay of usage.filter((e) => e.usage.counts === null))
			expect(replay.usage).toMatchObject({ provenance: 'unavailable', costUsd: null });
		expect(new Set(usage.map((e) => e.eventId)).size).toBe(usage.length);
		await journal.flush();
	});
});
