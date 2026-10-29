/**
 * The host the public adapter conformance fixture runs against (MCOMP-03-03A),
 * composed from the public entry's exports alone, the way the fixture's
 * `invocation.host.compose` says a host is: a run journal on a scratch file,
 * a context verifier accepting only the fixture's installation, a local
 * authority that allows, a standalone binding double, the fixture's agents as
 * the repository, its approved resource ids, and the declared turn-port double
 * scripted by each step's `sink`. No process starts: the sink answers what the
 * script says and writes the journal marks `runAgentTurn` would have written.
 * The runner drives every negotiation case and operation step in order and
 * reports, per case, where the answer departs from the fixture.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	createContextVerifier,
	createLocalHostAuthority,
	createManagedOperations,
	createRunJournal,
	type AgentRecord,
	type JournalTerminalOutcome,
	type ManagedApi,
	type ManagedDispatch,
	type ManagedSendResult,
	type ManagedTurnPort,
	type PolicySourceSet,
	type RunJournal,
} from '../../../shared/maestro-lib/index';
import {
	conformanceEnvelope,
	subsetProblems,
	type AdapterConformanceFixture,
	type ConformanceSinkScript,
} from './fixtures';

/** The declared turn-port double: armed with one step's script, counting every reach. */
export interface ConformanceSink extends ManagedTurnPort {
	/** Script the next step; armed with nothing, any reach is a departure the runner reports. */
	arm(script: ConformanceSinkScript | undefined): void;
	/** How many times the facade reached the sink since the last `arm`. */
	reached(): number;
}

export function conformanceSink(): ConformanceSink {
	let script: ConformanceSinkScript | undefined;
	let reached = 0;
	return {
		arm(next) {
			script = next;
			reached = 0;
		},
		reached: () => reached,
		async sendManaged(
			_agentId,
			_tabId,
			_text,
			dispatch: ManagedDispatch
		): Promise<ManagedSendResult> {
			reached += 1;
			const { journal, runId, attemptId } = dispatch;
			for (const mark of script?.then ?? []) {
				if (mark === 'markDispatched') {
					await journal.markDispatched(runId, attemptId, { pid: null, leaseId: null });
				} else if (mark === 'markUnknown') {
					await journal.markUnknown(runId, attemptId, 'the declared sink lost the attempt');
				} else {
					const outcome = mark.slice('markTerminal:'.length) as JournalTerminalOutcome;
					await journal.markTerminal(runId, attemptId, { outcome });
				}
			}
			const send = script?.send;
			if (send === undefined) {
				return { status: 'refused', reason: 'other', message: 'the step armed no send' };
			}
			if (typeof send === 'string') return { status: send };
			return {
				status: 'refused',
				reason: send.refused,
				message: send.message ?? `the declared sink answered ${send.refused}`,
			};
		},
		async cancelRun() {
			reached += 1;
			return script?.cancel ?? 'none';
		},
	};
}

export interface ConformanceHost {
	api: ManagedApi;
	sink: ConformanceSink;
	journal: RunJournal;
	/** The scratch directory the journal is written under. */
	dir: string;
	close(): void;
}

/** A host over the public exports and the fixture's `host` section, with a loaded scratch journal. */
export async function composeConformanceHost(
	fixture: AdapterConformanceFixture
): Promise<ConformanceHost> {
	const { host } = fixture;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-conformance-'));
	let clock = Date.parse('2026-10-29T12:00:00Z');
	const now = () => (clock += 1);
	let minted = 0;
	const newId = () => `minted-${++minted}`;
	const journal = createRunJournal({
		file: path.join(dir, 'maestro-managed-runs.json'),
		now,
		newId,
	});
	const loaded = await journal.load();
	if (!loaded.ok) throw new Error(`the scratch journal did not load: ${loaded.message}`);
	const verifier = createContextVerifier({
		verifierId: 'conformance:in-process',
		peer: 'in-process',
		now,
		accept: (context) =>
			context.installation.installationId === host.installation.installationId &&
			context.installation.runtimeId === host.installation.runtimeId
				? []
				: ['the context names another installation'],
	});
	const policy = (): PolicySourceSet => ({
		sources: [{ id: 'conformance-local', kind: 'local', revision: host.policyRevision }],
		policyRevision: host.policyRevision,
	});
	const authority = createLocalHostAuthority({
		authorityId: 'conformance-authority',
		decide: () => ({ decision: 'allow', policyRevision: host.policyRevision }),
		now,
		newId,
	});
	const agents: AgentRecord[] = host.agents.map((agent) => ({
		id: agent.agentId,
		name: agent.name,
		toolType: agent.providerId,
		aiTabs: agent.tabIds.map((id) => ({ id })),
		activeTabId: agent.activeTabId,
	}));
	const sink = conformanceSink();
	const api = createManagedOperations({
		installation: host.installation,
		binding: { state: () => ({ state: 'standalone', files: [] }), authority: () => authority },
		verifier,
		journal,
		repository: {
			listAgents: () => agents,
			getAgent: (agentId) => agents.find((agent) => agent.id === agentId),
			getTab: (agentId, tabId) =>
				agents.find((agent) => agent.id === agentId)?.aiTabs?.find((tab) => tab.id === tabId),
		},
		turns: sink,
		providers: () => [...new Set(agents.map((agent) => agent.toolType))],
		resolveResource: (id) =>
			host.approvedResourceIds.includes(id)
				? { id, kind: 'document', path: path.join(dir, id), sha256: null }
				: null,
		policy,
	});
	return {
		api,
		sink,
		journal,
		dir,
		close: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

export interface ConformanceCaseResult {
	id: string;
	kind: 'negotiation' | 'operation';
	/** Empty when the answer is what the fixture says. */
	problems: string[];
}

export interface ConformanceReport {
	cases: ConformanceCaseResult[];
	/** The ids of the cases with problems, in fixture order. */
	failed: string[];
}

/**
 * Every negotiation case, then every operation step, in fixture order against
 * one host: `expect` matched as a subset, `missingNames` against a denial's
 * `missing`, the requestId echo checked on every step, and the sink reached
 * exactly once on a step with a `sink` and never on a step without one.
 */
export async function runAdapterConformance(
	api: ManagedApi,
	fixture: AdapterConformanceFixture,
	sink: ConformanceSink
): Promise<ConformanceReport> {
	const cases: ConformanceCaseResult[] = [];
	for (const negotiation of fixture.negotiation.cases) {
		const answered = await api.negotiate(negotiation.offer);
		const problems = answered.ok
			? subsetProblems(answered.value, negotiation.expect, 'outcome')
			: [`negotiate failed: ${answered.error.code}`];
		if (answered.ok && negotiation.missingNames) {
			const missing = answered.value.outcome === 'denied' ? answered.value.missing.join('\n') : '';
			for (const name of negotiation.missingNames) {
				if (!missing.includes(name)) problems.push(`outcome.missing does not mention ${name}`);
			}
		}
		cases.push({ id: negotiation.id, kind: 'negotiation', problems });
	}
	for (const step of fixture.operations.steps) {
		const envelope = conformanceEnvelope(fixture, step);
		sink.arm(step.sink);
		const answered = await api[step.op](envelope as never);
		const problems: string[] = [];
		if (!answered.ok) {
			problems.push(`${step.op} failed: ${answered.error.code}`);
		} else {
			problems.push(...subsetProblems(answered.value, step.expect));
			const sent = envelope.context.identity.requestId;
			if (answered.value.requestId !== sent) {
				problems.push(
					`result.requestId is ${JSON.stringify(answered.value.requestId)}, the context sent ${JSON.stringify(sent)}`
				);
			}
		}
		const expectedReach = step.sink ? 1 : 0;
		if (sink.reached() !== expectedReach) {
			problems.push(`the sink was reached ${sink.reached()} time(s), expected ${expectedReach}`);
		}
		cases.push({ id: step.id, kind: 'operation', problems });
	}
	return { cases, failed: cases.filter((c) => c.problems.length > 0).map((c) => c.id) };
}
