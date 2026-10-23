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
	VIBES_MAX_RECORDS,
	VIBES_RECORDED_PROFILE,
	vibesAnnotationId,
	vibesAnnotationsJsonl,
	vibesEvidenceOf,
} from '../../../main/enterprise/vibes';
import { canonicalJson } from '../../../shared/canonicalJson';
import type { EndpointCollectionProfile } from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createLifecycleProjector,
	type InventoryFact,
	type LifecycleFact,
	type LifecycleLineage,
	type LifecycleProjector,
} from '../../../shared/maestro-lib/managed/events';
import { MANAGED_ROUTES } from '../../../shared/maestro-lib/providers/capabilities';

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

// MRC-10-08: the graph is run-states alone and bounded; the evidence is excluded by profile and grant, exact by digest, revocable, and free of the work's text.
describe('bounded VIBES evidence (MRC-10-08)', () => {
	const routes = Object.fromEntries(
		MANAGED_ROUTES.map((route) => [route, { standalone: 'unverified', managed: 'unsupported' }])
	) as InventoryFact['providers'][number]['routes'];

	const attachedUnder = (profile: EndpointCollectionProfile) =>
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

	const doc = (profile: EndpointCollectionProfile, roles: string[] = ['vibes.annotations']) => ({
		policyRevision: 3,
		profile,
		roles,
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
	});

	const under = (profile: EndpointCollectionProfile, roles?: string[]) => {
		const source = createContentCollectionSource({ status: () => attachedUnder(profile) });
		expect(source.install(doc(profile, roles)).ok).toBe(true);
		let n = 0;
		return createContentCapture({ source, newId: () => `ref-${++n}` });
	};

	const evidenceInput = (evidence: ReturnType<typeof vibesEvidenceOf>) => ({
		role: evidence.role,
		text: evidence.text,
		sessionId: 'host',
		agentId: 'agent-1',
		tabId: null,
		provider: 'maestro',
		runId: null,
	});

	it('is built from run-state events alone: a usage, an inventory and a decision on the same projector add no session, and a replayed state is one record', () => {
		const p = tree();
		p.recordUsage({
			surface: 'agent',
			state: 'completed',
			at: T0 + 5_000,
			sessionId: 'agent-2-ai-tab-1',
			agentId: 'agent-2',
			tabId: 'tab-1',
			provider: 'codex',
			model: 'gpt-5-codex',
			providerSessionId: null,
			runId: 'run-b',
			record: 'ledger',
			accountRef: null,
			attribution: null,
			lineage: lineage('run-b', 'run-a'),
			usage: {
				provenance: 'unavailable',
				tokens: 'none',
				cost: 'none',
				costUsd: null,
				priceRevision: null,
				reporting: 'none',
				events: 0,
				corrections: 0,
				cacheReadCounting: 'unknown',
				counts: null,
				contextWindow: null,
			},
		});
		p.recordInventory({
			at: T0,
			device: { deviceId: 'enr-1', hostname: 'CANARY-HOST', os: null },
			runtimes: [
				{
					runtimeId: 'rt-1',
					processEpoch: 'epoch-1',
					components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
				},
			],
			providers: [{ agentId: 'claude-code', installed: 'detected', version: null, routes }],
			subagents: {
				managed: { state: 'observed', count: 1 },
				providerInternal: { state: 'unavailable', count: null },
			},
			policyRevision: 3,
			completeness: 'partial',
			gaps: [],
		});
		const admitted = p.record(
			fact({
				runId: 'run-d',
				at: T0 + 10_000,
				admission: {
					leaseId: 'lease-CANARY',
					authorityId: 'auth-1',
					requestDigest: 'digest-1',
					policyRevision: 3,
				},
			})
		);
		expect(admitted.map((e) => e.kind)).toEqual(['decision', 'run-state']);
		// Replays: the same start again, and a second terminal state for a run already ended.
		p.record(fact({ runId: 'run-a', lineage: lineage('run-a', null) }));
		p.record(
			fact({
				runId: 'run-b',
				state: 'cancelled',
				at: T0 + 20_000,
				agentId: 'agent-2',
				provider: 'codex',
				ledgerStatus: 'interrupted',
				lineage: lineage('run-b', 'run-a'),
			})
		);
		// Four tree states, a usage, an inventory, a decision and its run-state, the replayed start, the second end.
		expect(p.recent()).toHaveLength(10);
		const graph = buildVibesRecordedGraph(p.recent(), { projectorGaps: p.gaps() });
		expect(graph.sessions.map((s) => [s.session_id, s.event])).toEqual([
			['run-a', 'start'],
			['run-a', 'end'],
			['run-b', 'start'],
			['run-b', 'end'],
			['run-d', 'start'],
		]);
		// The first end stands; the later cancelled replay is not a second end.
		expect(graph.sessions[3]!.timestamp).toBe('2026-10-22T12:00:05.000Z');
		expect(graph.delegations).toHaveLength(1);
		expect(graph.decisions).toEqual([]);
		expect(graph.annotations).toHaveLength(6);
		const jsonl = vibesAnnotationsJsonl(graph);
		for (const canary of ['CANARY', 'inventory', 'usage', 'decision', 'lease', 'gpt-5']) {
			expect(jsonl).not.toContain(canary);
		}
		expect(graph.gaps.filter((g) => g.kind === 'caller_reported_gap')).toEqual([
			{ kind: 'caller_reported_gap', reference: 'decisions:not-recorded-by-this-host' },
		]);
	});

	it('records no delegation for a run that names itself as parent, and stops at the profile bound saying so', () => {
		const p = projector();
		p.record(fact({ runId: 'run-s', lineage: lineage('run-s', 'run-s') }));
		const self = buildVibesRecordedGraph(p.recent());
		expect(self.sessions.map((s) => [s.session_id, s.parent_session_id])).toEqual([
			['run-s', 'run-s'],
		]);
		expect(self.delegations).toEqual([]);
		expect(self.gaps.filter((g) => g.kind !== 'missing_field')).toEqual([
			{ kind: 'caller_reported_gap', reference: 'decisions:not-recorded-by-this-host' },
		]);
		const wide = createLifecycleProjector({
			installation: INSTALLATION,
			origin: 'desktop',
			actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
			capacity: VIBES_MAX_RECORDS + 2,
		});
		for (let i = 0; i <= VIBES_MAX_RECORDS; i += 1) {
			wide.record(fact({ runId: `run-${i}`, sessionId: `agent-1-ai-tab-${i}`, at: T0 + i }));
		}
		const bounded = buildVibesRecordedGraph(wide.recent(), { projectorGaps: wide.gaps() });
		expect(bounded.sessions).toHaveLength(VIBES_MAX_RECORDS);
		expect(bounded.gaps).toContainEqual({
			kind: 'caller_reported_gap',
			reference: `events:truncated-at-${VIBES_MAX_RECORDS}`,
		});
		expect(bounded.gaps.filter((g) => g.kind === 'missing_field')).toHaveLength(
			VIBES_MAX_RECORDS * 2
		);
	});

	it('is excluded by the profile under metadata, redacted and full, and by the grant under full_vibes; no byte of it is held in any case', () => {
		const evidence = vibesEvidenceOf(buildVibesRecordedGraph(tree().recent()));
		const refused: Record<string, string> = {};
		for (const profile of ['redacted', 'full'] as const) {
			const cap = under(profile);
			const out = cap.capture(evidenceInput(evidence));
			expect(out.outcome).toBe('not-collected');
			if (out.outcome === 'not-collected') refused[profile] = out.reason;
			expect(cap.status()).toMatchObject({
				records: 0,
				held: { count: 0, bytes: 0 },
				notCollected: 1,
			});
		}
		expect(refused).toEqual({
			redacted: 'profile redacted admits no vibes.annotations',
			full: 'profile full admits no vibes.annotations',
		});
		const metadata = under('metadata');
		expect(metadata.capture(evidenceInput(evidence))).toMatchObject({
			outcome: 'not-collected',
			reason: expect.stringContaining('metadata profile'),
		});
		const ungranted = under('full_vibes', ['user.prompt']);
		expect(ungranted.capture(evidenceInput(evidence))).toEqual({
			outcome: 'not-collected',
			reason: 'the ceiling grants no vibes.annotations',
		});
		expect(ungranted.take('ref-1')).toBeNull();
	});

	it('is exact by digest: the evidence digest is the held bytes, the lines re-parse with ids that recompute, the same window digests the same, a new event moves it, and a revoke leaves the record and no bytes', () => {
		const p = tree();
		const first = vibesEvidenceOf(buildVibesRecordedGraph(p.recent()));
		const again = vibesEvidenceOf(buildVibesRecordedGraph(p.recent()));
		expect(again).toEqual(first);
		p.record(fact({ runId: 'run-e', at: T0 + 30_000 }));
		const moved = vibesEvidenceOf(buildVibesRecordedGraph(p.recent()));
		expect(moved.sha256).not.toBe(first.sha256);
		expect(moved.byteLength).toBeGreaterThan(first.byteLength);
		const cap = under('full_vibes');
		const out = cap.capture(evidenceInput(moved));
		if (out.outcome !== 'recorded') throw new Error('not recorded');
		expect(out.fact).toMatchObject({
			family: 'vibes.annotation',
			profile: 'full_vibes',
			sensitivity: 'restricted',
			kept: 'original',
			derivative: null,
			completeness: 'pending_upload',
			original: { sha256: moved.sha256, byteLength: moved.byteLength },
		});
		const held = cap.take(out.fact.original.referenceId)!;
		expect(createHash('sha256').update(held.bytes).digest('hex')).toBe(moved.sha256);
		const records = held.bytes
			.toString('utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		// Four tree sessions, the new start, one delegation.
		expect(records).toHaveLength(6);
		for (const record of records) expect(vibesAnnotationId(record)).toBe(record.annotation_id);
		expect(cap.revoke('profile withdrawn')).toBe(1);
		expect(out.fact).toMatchObject({
			kept: 'none',
			completeness: 'unavailable',
			gap: 'revoked: profile withdrawn',
			original: { sha256: moved.sha256 },
		});
		expect(cap.take(out.fact.original.referenceId)).toBeNull();
		expect(cap.status()).toMatchObject({ records: 1, held: { count: 0, bytes: 0 }, revoked: 1 });
	});

	it('carries none of the work: a detail, a model, a tab or a session id on the facts never reaches the evidence, and the private recording is not a source', () => {
		const p = projector();
		p.record(
			fact({
				runId: 'run-q',
				sessionId: 'agent-1-ai-tab-CANARYSESSION',
				tabId: 'tab-CANARY',
				model: 'opus-CANARY-model',
				detail: 'error: sk-ant-api03-CANARYTOKEN at /Users/canary/project',
				providerSessionId: 'thread-CANARY',
			})
		);
		p.record(
			fact({
				runId: 'run-q',
				state: 'failed',
				at: T0 + 1,
				model: 'opus-CANARY-model',
				detail: 'sk-ant-api03-CANARYTOKEN',
				exitCode: 1,
			})
		);
		const graph = buildVibesRecordedGraph(p.recent(), { projectorGaps: p.gaps() });
		const jsonl = vibesAnnotationsJsonl(graph);
		expect(graph.sessions.map((s) => s.event)).toEqual(['start', 'end']);
		for (const canary of ['CANARY', 'sk-ant', '/Users', 'thread-', 'tab-', 'opus']) {
			expect(jsonl).not.toContain(canary);
		}
		expect(jsonl).toContain('"agent_type":"claude-code"');
		for (const record of graph.annotations) {
			expect(Object.keys(record).sort()).toEqual(
				record.type === 'session'
					? [
							'agent_name',
							'agent_type',
							'annotation_id',
							'environment_hash',
							'event',
							'parent_session_id',
							'session_id',
							'timestamp',
							'type',
						]
					: [
							'annotation_id',
							'child_session_id',
							'delegation_type',
							'parent_session_id',
							'timestamp',
							'type',
						]
			);
		}
		expect(VIBES_CAPABILITY.unsupported).toEqual(
			expect.arrayContaining(['hidden_reasoning', 'private_recording_reuse', 'decision_records'])
		);
		expect(JSON.stringify(graph)).not.toContain('reasoning');
	});
});
