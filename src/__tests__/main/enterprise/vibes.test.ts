/**
 * VIBES evidence from the real lifecycle projection (MRC-10-05): sessions from
 * run starts and ends, delegations from the run tree, annotation ids under the
 * VIBES rule the sibling ingester recomputes, every unobserved field a named
 * gap, no decisions invented, no reasoning or prompt anywhere, and the graph
 * admitted as content by the `full_vibes` profile alone.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	createContentCapture,
	createContentCollectionSource,
} from '../../../main/enterprise/content';
import {
	buildVibesRecordedGraph,
	VIBES_ATTESTATION,
	VIBES_CAPABILITY,
	VIBES_RECORDED_PROFILE,
	vibesAnnotationId,
	vibesAnnotationsJsonl,
	vibesEvidenceOf,
} from '../../../main/enterprise/vibes';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	createLifecycleProjector,
	type LifecycleFact,
	type LifecycleLineage,
	type LifecycleProjector,
} from '../../../shared/maestro-lib/managed/events';

const INSTALLATION = { installationId: 'inst-1', runtimeId: 'rt-1', processEpoch: 'epoch-1' };
const T0 = Date.parse('2026-10-22T12:00:00.000Z');

const projector = (): LifecycleProjector =>
	createLifecycleProjector({
		installation: INSTALLATION,
		origin: 'desktop',
		actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
		policyRevision: () => 3,
	});

const fact = (overrides: Partial<LifecycleFact> = {}): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at: T0,
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'claude-code',
	model: 'opus',
	providerSessionId: null,
	runId: 'run-a',
	record: 'ledger',
	ledgerStatus: 'running',
	exitCode: null,
	durationMs: null,
	detail: null,
	...overrides,
});

const lineage = (runId: string, parentRunId: string | null): LifecycleLineage => ({
	identity: {
		requestId: `req-${runId}`,
		idempotencyKey: `key-${runId}`,
		attemptId: `attempt-${runId}`,
		runId,
		rootRunId: parentRunId ?? runId,
		parentRunId,
	},
	traceId: 'trace-1',
	workflow: null,
	delegation: { chain: [], grantRef: null },
});

/** A parent run that starts, a child it delegated to that starts and ends, then the parent ends. */
function tree(): LifecycleProjector {
	const p = projector();
	p.record(fact({ runId: 'run-a', lineage: lineage('run-a', null) }));
	p.record(
		fact({
			runId: 'run-b',
			at: T0 + 1_000,
			sessionId: 'agent-2-ai-tab-1',
			agentId: 'agent-2',
			provider: 'codex',
			lineage: lineage('run-b', 'run-a'),
		})
	);
	p.record(
		fact({
			runId: 'run-b',
			state: 'completed',
			at: T0 + 5_000,
			agentId: 'agent-2',
			provider: 'codex',
			ledgerStatus: 'completed',
			exitCode: 0,
			lineage: lineage('run-b', 'run-a'),
		})
	);
	p.record(
		fact({
			runId: 'run-a',
			state: 'failed',
			at: T0 + 9_000,
			ledgerStatus: 'crashed',
			exitCode: 1,
			lineage: lineage('run-a', null),
		})
	);
	return p;
}

describe('the recorded graph', () => {
	it('transcribes real starts, ends and the run tree, with VIBES annotation ids the ingester recomputes', () => {
		const p = tree();
		const graph = buildVibesRecordedGraph(p.recent(), { projectorGaps: p.gaps() });
		expect(graph).toMatchObject({
			profile: VIBES_RECORDED_PROFILE,
			executionAuthority: false,
			evolve: 'unsupported',
			decisions: [],
		});
		expect(graph.sessions.map((s) => [s.session_id, s.event])).toEqual([
			['run-a', 'start'],
			['run-a', 'end'],
			['run-b', 'start'],
			['run-b', 'end'],
		]);
		const childStart = graph.sessions[2]!;
		expect(childStart).toMatchObject({
			type: 'session',
			parent_session_id: 'run-a',
			agent_name: 'agent-2',
			agent_type: 'codex',
			timestamp: '2026-10-22T12:00:01.000Z',
			environment_hash: null,
		});
		expect(graph.delegations).toEqual([
			expect.objectContaining({
				type: 'delegation',
				parent_session_id: 'run-a',
				child_session_id: 'run-b',
				timestamp: childStart.timestamp,
				delegation_type: 'task',
			}),
		]);
		// The VIBES rule: SHA-256 of canonical JSON without annotation_id; unique per record.
		for (const record of graph.annotations) {
			const { annotation_id, ...rest } = record;
			expect(annotation_id).toMatch(/^[a-f0-9]{64}$/);
			expect(annotation_id).toBe(
				createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex')
			);
			expect(vibesAnnotationId(record as unknown as Record<string, unknown>)).toBe(annotation_id);
		}
		expect(new Set(graph.annotations.map((a) => a.annotation_id)).size).toBe(5);
		// What this host never observed is a named gap, never a value.
		expect(graph.gaps).toEqual(
			expect.arrayContaining([
				{
					kind: 'missing_field',
					reference: `${graph.sessions[0]!.annotation_id}:environment_hash`,
				},
				{ kind: 'missing_field', reference: `${childStart.annotation_id}:assurance_level` },
				{ kind: 'caller_reported_gap', reference: 'decisions:not-recorded-by-this-host' },
			])
		);
		expect(graph.gaps.filter((g) => g.kind === 'missing_reference')).toEqual([]);
		expect(graph.annotations).toHaveLength(graph.sessions.length + graph.delegations.length);
	});

	it('names an end without a start, a child whose parent this window never saw, and the projector window it was read from', () => {
		const p = projector();
		p.record(fact({ runId: 'run-x', state: 'completed', ledgerStatus: 'completed', exitCode: 0 }));
		p.record(fact({ runId: 'run-c', at: T0 + 1, lineage: lineage('run-c', 'run-gone') }));
		// Not sessions: a usage event and a decision ride the same projector and are ignored here.
		const graph = buildVibesRecordedGraph(p.recent(), {
			projectorGaps: { dropped: 4, refused: 1 },
		});
		expect(graph.sessions.map((s) => [s.session_id, s.event])).toEqual([
			['run-c', 'start'],
			['run-x', 'end'],
		]);
		expect(graph.delegations).toHaveLength(1);
		expect(graph.gaps).toEqual(
			expect.arrayContaining([
				{ kind: 'missing_reference', reference: 'run-x:start' },
				{ kind: 'missing_reference', reference: 'run-gone' },
				{ kind: 'caller_reported_gap', reference: 'projector-window:dropped-4' },
				{ kind: 'caller_reported_gap', reference: 'projector-window:refused-1' },
			])
		);
		expect(buildVibesRecordedGraph([])).toMatchObject({
			sessions: [],
			delegations: [],
			gaps: [{ kind: 'caller_reported_gap', reference: 'decisions:not-recorded-by-this-host' }],
		});
	});

	it('serializes the annotations as canonical JSON lines whose ids recompute, carrying no prompt, reasoning or output', () => {
		const graph = buildVibesRecordedGraph(tree().recent());
		const jsonl = vibesAnnotationsJsonl(graph);
		const lines = jsonl.split('\n').filter(Boolean);
		expect(lines).toHaveLength(5);
		for (const line of lines) {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			expect(canonicalJson(parsed)).toBe(line);
			expect(vibesAnnotationId(parsed)).toBe(parsed.annotation_id);
		}
		for (const word of ['prompt', 'reasoning', 'text', 'cwd', 'model'])
			expect(jsonl).not.toContain(`"${word}"`);
		const evidence = vibesEvidenceOf(graph);
		expect(evidence).toMatchObject({
			role: 'vibes.annotations',
			text: jsonl,
			sha256: createHash('sha256').update(Buffer.from(jsonl, 'utf8')).digest('hex'),
			byteLength: Buffer.byteLength(jsonl),
		});
	});

	it('claims no conformance, no key and no reasoning', () => {
		expect(VIBES_CAPABILITY).toMatchObject({
			standard: 'VIBES',
			status: 'unsupported',
			specificationVersion: null,
			wireVersions: [],
			pins: [],
			supported: [],
			fullConformance: false,
			recordedProfile: {
				profile: VIBES_RECORDED_PROFILE,
				produces: ['session', 'delegation'],
				admittedBy: 'full_vibes',
			},
		});
		expect(VIBES_CAPABILITY.unsupported).toEqual(
			expect.arrayContaining(['attestation', 'hidden_reasoning', 'private_recording_reuse'])
		);
		expect(VIBES_ATTESTATION.state).toBe('unavailable');
	});
});

describe('as content', () => {
	const attached = (profile: 'full' | 'full_vibes') =>
		({
			identity: {
				status: 'ok',
				reason: null,
				message: null,
				record: {
					version: 1,
					installationId: 'inst-1',
					tenantId: 'tenant-1',
					orgId: 'org-eng',
					enrollmentId: 'enr-1',
					endpoint: { socketPath: '/tmp/endpoint.sock' },
					management: 'managed',
					registration: null,
					policy: { desiredRevision: 3, appliedRevision: 3, observedAt: null },
					enrolledAt: '2026-10-22T11:00:00.000Z',
					updatedAt: '2026-10-22T11:00:00.000Z',
				},
			},
			connection: { connection: 1, registration: 'registered', attached: true },
			endpoint: {
				outcome: 'attached',
				protocol: 1,
				capabilities: ['telemetry'],
				management: 'managed',
				desiredPolicyRevision: 3,
				appliedPolicyRevision: 3,
				connectivity: 'online',
				collectionProfile: profile,
			},
			authority: 'registered',
			reason: null,
			pendingApproval: null,
			lastDenial: null,
		}) as never;

	it('is admitted by full_vibes alone, kept as the exact original bytes', () => {
		const evidence = vibesEvidenceOf(buildVibesRecordedGraph(tree().recent()));
		const doc = {
			policyRevision: 3,
			profile: 'full_vibes',
			roles: ['vibes.annotations'],
			permissions: {
				capture: true,
				upload: true,
				storage: true,
				index: false,
				display: false,
				export: false,
			},
			sensitivity: 'restricted',
			maxPayloadBytes: 1024 * 1024,
			redactionRuleIds: [],
		};
		const under = (profile: 'full' | 'full_vibes') => {
			const source = createContentCollectionSource({ status: () => attached(profile) });
			source.install({ ...doc, profile });
			return createContentCapture({ source, newId: () => 'ref-vibes' });
		};
		const input = {
			role: evidence.role,
			text: evidence.text,
			sessionId: 'host',
			agentId: 'agent-1',
			tabId: null,
			provider: 'maestro',
			runId: null,
		};
		expect(under('full').capture(input)).toEqual({
			outcome: 'not-collected',
			reason: 'profile full admits no vibes.annotations',
		});
		const capture = under('full_vibes');
		const out = capture.capture(input);
		expect(out).toMatchObject({
			outcome: 'recorded',
			fact: {
				family: 'vibes.annotation',
				kept: 'original',
				original: { sha256: evidence.sha256, byteLength: evidence.byteLength },
			},
		});
		expect(capture.take('ref-vibes')!.bytes.toString('utf8')).toBe(evidence.text);
	});
});
