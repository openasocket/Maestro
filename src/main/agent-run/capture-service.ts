/**
 * AgentRun capture service (F1) - main-process lifecycle capture.
 *
 * Turns real agent sessions into ledger records. It is the single writer the
 * desktop seams call: `captureSpawn` at `ProcessManager.spawn`, `captureExit`
 * at the `process:exit` seam. All writes go through the injected store deps
 * (which run under the F0 cross-process lock) and every status change is guarded
 * by the pure lifecycle table and mirrored to a `status_change` event.
 *
 * Invariants:
 *   - Never throws into a lifecycle path: every public method swallows and logs
 *     its own errors (ISC-1.8).
 *   - Terminal (`-terminal-`) and group-chat sessions are never captured
 *     (ISC-1.7), filtered at BOTH creation and completion.
 *   - A re-spawn of a live session supersedes the prior run (ISC-1.11).
 *
 * Producers (git diff, usage, checks, reviews, PR, merge) are injected as an
 * optional `enrich` hook so F2 can populate rich fields on completion without
 * this file importing git/gh/child_process.
 *
 * Lifecycle projection (MRC-10-01): with a `lifecycle` sink injected, every
 * spawn, supersede and exit this service hears is also projected as a
 * metadata-only managed lifecycle fact (`managed/events.ts`), INCLUDING the
 * terminal and group-chat sessions the ledger omits, which are projected with
 * `record: 'omitted'` so a fleet reader sees the omission instead of nothing.
 * The fact carries identities (session, agent, tab, run, lineage, admission),
 * the provider and model, the state, exit code and duration; never the prompt,
 * the working tree or anything the process printed.
 */

import {
	assertTransition,
	isTerminalAgentRunStatus,
	resolveAgentRunProvider,
	deriveTerminalStatus,
	type AgentRun,
	type AgentRunEvent,
	type AgentRunStatus,
} from '../../shared/agent-run';
import {
	autoRunRunIdentity,
	autoRunTraceId,
	autoRunWorkflowRef,
} from '../../shared/maestro-lib/autorun/attribution';
import { childDelegationContext } from '../../shared/maestro-lib/managed/delegation';
import {
	lifecycleStateOf,
	type LifecycleAdmissionRef,
	type LifecycleEventSink,
	type LifecycleLineage,
	type LifecycleRecord,
	type LifecycleSurface,
} from '../../shared/maestro-lib/managed/events';
import type { ManagedRunState } from '../../shared/maestro-lib/managed/types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import type { ProcessConfig, ProcessSpawnAdmission } from '../process-manager/types';

const GROUP_CHAT_PREFIX = 'group-chat-';

/** How many spawns with no exit yet the lifecycle bindings remember. Oldest go first. */
const MAX_LIVE_BINDINGS = 2_000;

/** Minimal shape of a spawn we capture, projected from ProcessConfig. */
export interface CaptureSpawnInput {
	sessionId: string;
	toolType: string;
	cwd: string;
	tabId?: string;
	model?: string;
	agentId?: string;
	agentName?: string;
	repo?: string;
	worktreePath?: string;
	branch?: string;
	baseBranch?: string;
	prompt?: string;
	source?: string;
	/** The managed lineage the spawn was bound as (`spawnLifecycleLineage`), when it has one. */
	lineage?: LifecycleLineage;
	/** The admission the sink granted the spawn (`spawnLifecycleAdmission`), when it was admitted. */
	admission?: LifecycleAdmissionRef | null;
}

export interface CaptureExitInput {
	sessionId: string;
	exitCode: number;
}

/** Everything the service touches that is not pure. Injected for testability. */
export interface CaptureServiceDeps {
	getAgentRun: (runId: string) => AgentRun | undefined;
	upsertAgentRun: (run: AgentRun) => AgentRun;
	appendAgentRunEvent: (event: AgentRunEvent) => AgentRunEvent;
	/** Find the live (non-terminal) run for a session, if any. */
	findActiveRunBySession: (sessionId: string) => AgentRun | undefined;
	/** Optional F2 hook: enrich a completed run with touchedFiles/usage/etc. */
	enrich?: (run: AgentRun, exitCode: number) => Promise<Partial<AgentRun>> | Partial<AgentRun>;
	/** Redaction/gating for prompt capture (F6 / D1). Defaults to storing verbatim. */
	preparePrompt?: (prompt: string | undefined) => string | undefined;
	/** The managed lifecycle projection (MRC-10-01). Absent: nothing is projected. */
	lifecycle?: LifecycleEventSink;
	now?: () => number;
	log?: (level: 'warn' | 'error', message: string, error?: unknown) => void;
}

/**
 * A run id is UNIQUE per spawn (not per session), so a re-spawn of the same
 * session produces a distinct record and the prior run can be superseded rather
 * than overwritten. Exits resolve the live run via findActiveRunBySession.
 */
export function newRunId(sessionId: string, ts: number): string {
	return `run:${sessionId}:${ts}:${Math.random().toString(36).slice(2, 8)}`;
}

/** The surface a process session id names. The ledger records only `agent` (ISC-1.7). */
export function lifecycleSurfaceOf(sessionId: string): LifecycleSurface {
	if (sessionId.includes('-terminal-') || sessionId.endsWith('-terminal')) return 'terminal';
	if (sessionId.startsWith(GROUP_CHAT_PREFIX)) return 'group-chat';
	return 'agent';
}

function isCapturable(sessionId: string): boolean {
	return !!sessionId && lifecycleSurfaceOf(sessionId) === 'agent';
}

/** The decision identities of a desktop admission, for the lifecycle fact. Null for a standalone spawn. */
export function spawnLifecycleAdmission(
	admission: ProcessSpawnAdmission | undefined
): LifecycleAdmissionRef | null {
	if (!admission) return null;
	return {
		leaseId: admission.leaseId,
		authorityId: admission.authorityId,
		requestDigest: admission.requestDigest,
		policyRevision: admission.policyRevision,
		operation: admission.operation,
		target: admission.target,
	};
}

/**
 * The managed lineage a desktop spawn was bound as, read off the same config
 * fields the sink binds (`ProcessManager.admitSpawn`): an Auto Run attempt on
 * its attribution, a dispatched turn as its initiator's child (with the ids
 * the handler minted, else the ones the admission holds), an admitted chat
 * turn on the admission's own request (the sink's rule: its idempotency key is
 * its request id). A standalone chat turn has none, and the projection then
 * names the ledger run itself. Nothing is minted here.
 */
export function spawnLifecycleLineage(
	config: Pick<ProcessConfig, 'sessionId' | 'autoRun' | 'delegation' | 'dispatchedAs' | 'admission'>
): LifecycleLineage | undefined {
	const admission = config.admission;
	const bound = admission
		? { actor: admission.actor, policyRevision: admission.policyRevision }
		: {};
	if (config.autoRun) {
		const { attribution, fence } = config.autoRun;
		return {
			identity: autoRunRunIdentity(attribution),
			traceId: autoRunTraceId(attribution),
			workflow: autoRunWorkflowRef(attribution.workflow, fence),
			delegation: { chain: [], grantRef: null },
			...bound,
		};
	}
	const ids =
		config.dispatchedAs ??
		(admission ? { requestId: admission.requestId, attemptId: admission.attemptId } : null);
	if (config.delegation && ids) {
		const child = childDelegationContext(config.delegation, {
			link: { kind: 'agent', id: resolveOwningMaestroSessionId(config.sessionId) },
			...ids,
		});
		return {
			identity: child.identity,
			traceId: child.traceId,
			workflow: child.workflow,
			delegation: child.delegation,
			...bound,
		};
	}
	if (admission) {
		return {
			identity: {
				requestId: admission.requestId,
				idempotencyKey: admission.requestId,
				attemptId: admission.attemptId,
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
			traceId: admission.requestId,
			workflow: null,
			delegation: { chain: [], grantRef: null },
			...bound,
		};
	}
	return undefined;
}

/** What the projection needs about a spawn when its exit arrives. Held in memory only. */
interface LiveBinding {
	runId: string;
	surface: LifecycleSurface;
	record: LifecycleRecord;
	provider: string;
	model: string | null;
	agentId: string;
	tabId: string | null;
	startedAt: number;
	lineage?: LifecycleLineage;
	admission: LifecycleAdmissionRef | null;
}

export class AgentRunCaptureService {
	private readonly deps: CaptureServiceDeps;
	private readonly live = new Map<string, LiveBinding>();

	constructor(deps: CaptureServiceDeps) {
		this.deps = deps;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private report(level: 'warn' | 'error', message: string, error?: unknown): void {
		this.deps.log?.(level, message, error);
	}

	/**
	 * Create (or supersede+recreate) the AgentRun for a spawning session. A live
	 * prior run for the same session is marked superseded so a re-spawn/replay
	 * never leaves an orphan (ISC-1.11). Filtered for terminal/group-chat
	 * (ISC-1.7), which the lifecycle projection still hears. Never throws (ISC-1.8).
	 */
	captureSpawn(input: CaptureSpawnInput): AgentRun | undefined {
		try {
			if (!input.sessionId) return undefined;
			const ts = this.now();
			if (!isCapturable(input.sessionId)) {
				this.bindAndProject(input, {
					runId: `${input.sessionId}@${ts}`,
					surface: lifecycleSurfaceOf(input.sessionId),
					record: 'omitted',
					startedAt: ts,
				});
				return undefined;
			}
			const runId = newRunId(input.sessionId, ts);

			const prior = this.deps.findActiveRunBySession(input.sessionId);
			if (prior && !isTerminalAgentRunStatus(prior.status)) {
				this.supersede(prior, runId, ts);
			}

			const prepared = (this.deps.preparePrompt ?? ((p) => p))(input.prompt);
			const run: AgentRun = {
				id: runId,
				createdAt: ts,
				updatedAt: ts,
				provider: resolveAgentRunProvider(input.toolType),
				status: 'running',
				model: input.model,
				agentId: input.agentId,
				agentName: input.agentName,
				sessionId: input.sessionId,
				tabId: input.tabId,
				cwd: input.cwd,
				repo: input.repo,
				worktreePath: input.worktreePath,
				branch: input.branch,
				baseBranch: input.baseBranch,
				prompt: prepared,
				source: input.source,
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
			};
			const saved = this.deps.upsertAgentRun(run);
			this.emit(runId, 'status_change', ts, 'running', 'run spawned');
			this.bindAndProject(input, { runId, surface: 'agent', record: 'ledger', startedAt: ts });
			return saved;
		} catch (error) {
			this.report('error', `captureSpawn failed for ${input.sessionId}`, error);
			return undefined;
		}
	}

	/**
	 * Settle a run to completed (exit 0) or failed (nonzero) at process exit,
	 * recording exitCode + duration and running the optional F2 enrich hook.
	 * Filtered and guarded like captureSpawn; an omitted surface's exit is still
	 * projected, from the binding its spawn left (or, after a restart, as an
	 * exit whose spawn this process never saw).
	 */
	async captureExit(input: CaptureExitInput): Promise<AgentRun | undefined> {
		try {
			if (!input.sessionId) return undefined;
			if (!isCapturable(input.sessionId)) {
				this.projectOmittedExit(input);
				return undefined;
			}
			const existing = this.deps.findActiveRunBySession(input.sessionId);
			if (!existing || isTerminalAgentRunStatus(existing.status)) return undefined;
			const runId = existing.id;

			const ts = this.now();

			let enrichment: Partial<AgentRun> = {};
			if (this.deps.enrich) {
				try {
					enrichment = await this.deps.enrich(existing, input.exitCode);
				} catch (error) {
					this.report('warn', `enrich failed for ${runId}`, error);
				}
			}

			// Merge enrichment first so review findings are visible, THEN derive the
			// terminal status: an exit-0 run with open critical/high findings settles
			// to needs_review, not completed (ISC-8.4/5.8).
			const merged: AgentRun = { ...existing, ...enrichment };
			const target = deriveTerminalStatus(merged, input.exitCode);
			assertTransition(existing.status, target);

			const durationMs = Math.max(0, ts - existing.createdAt);
			const next: AgentRun = {
				...merged,
				status: target,
				updatedAt: ts,
				metadata: {
					...(existing.metadata ?? {}),
					...(enrichment.metadata ?? {}),
					exitCode: input.exitCode,
					durationMs,
					completedAt: ts,
				},
			};
			const saved = this.deps.upsertAgentRun(next);
			this.emit(runId, 'status_change', ts, target, `run ${target} (exit ${input.exitCode})`);
			const bound = this.live.get(input.sessionId);
			if (bound?.runId === runId) this.live.delete(input.sessionId);
			this.project(
				bound?.runId === runId
					? bound
					: {
							runId,
							surface: 'agent',
							record: 'ledger',
							provider: existing.provider,
							model: existing.model ?? null,
							agentId: existing.agentId ?? resolveOwningMaestroSessionId(input.sessionId),
							tabId: existing.tabId ?? null,
							startedAt: existing.createdAt,
							admission: null,
						},
				{
					sessionId: input.sessionId,
					state: lifecycleStateOf(target),
					at: ts,
					ledgerStatus: target,
					exitCode: input.exitCode,
					durationMs,
					detail: null,
				}
			);
			return saved;
		} catch (error) {
			this.report('error', `captureExit failed for ${input.sessionId}`, error);
			return undefined;
		}
	}

	private supersede(prior: AgentRun, replacedBy: string, ts: number): void {
		try {
			assertTransition(prior.status, 'cancelled', { audited: true });
			this.deps.upsertAgentRun({
				...prior,
				status: 'cancelled',
				updatedAt: ts,
				metadata: { ...(prior.metadata ?? {}), supersededBy: replacedBy },
			});
			this.emit(prior.id, 'status_change', ts, 'cancelled', `superseded by ${replacedBy}`);
			const bound = prior.sessionId ? this.live.get(prior.sessionId) : undefined;
			if (bound?.runId === prior.id && prior.sessionId) {
				this.live.delete(prior.sessionId);
				this.project(bound, {
					sessionId: prior.sessionId,
					state: 'cancelled',
					at: ts,
					ledgerStatus: 'cancelled',
					exitCode: null,
					durationMs: Math.max(0, ts - bound.startedAt),
					detail: `superseded by ${replacedBy}`,
				});
			}
		} catch (error) {
			this.report('warn', `supersede failed for ${prior.id}`, error);
		}
	}

	private emit(
		runId: string,
		type: string,
		timestamp: number,
		status: AgentRunStatus,
		message: string
	): void {
		try {
			this.deps.appendAgentRunEvent({
				id: `evt:${runId}:${type}:${timestamp}`,
				runId,
				timestamp,
				type,
				status,
				message,
			});
		} catch (error) {
			this.report('warn', `event append failed for ${runId}`, error);
		}
	}

	/** Remember what the exit will need, then project the start. Bounded; nothing here writes a store. */
	private bindAndProject(
		input: CaptureSpawnInput,
		run: Pick<LiveBinding, 'runId' | 'surface' | 'record' | 'startedAt'>
	): void {
		if (!this.deps.lifecycle) return;
		const binding: LiveBinding = {
			...run,
			provider: input.toolType,
			model: input.model ?? null,
			agentId: input.agentId ?? resolveOwningMaestroSessionId(input.sessionId),
			tabId: input.tabId ?? null,
			...(input.lineage ? { lineage: input.lineage } : {}),
			admission: input.admission ?? null,
		};
		if (this.live.size >= MAX_LIVE_BINDINGS) {
			const oldest = this.live.keys().next().value;
			if (oldest !== undefined) this.live.delete(oldest);
		}
		this.live.set(input.sessionId, binding);
		this.project(binding, {
			sessionId: input.sessionId,
			state: 'running',
			at: run.startedAt,
			ledgerStatus: run.record === 'ledger' ? 'running' : null,
			exitCode: null,
			durationMs: null,
			detail: null,
		});
	}

	/** The exit of a terminal or group-chat session: projected from its binding, or as a start this process never saw. */
	private projectOmittedExit(input: CaptureExitInput): void {
		if (!this.deps.lifecycle) return;
		const ts = this.now();
		const bound = this.live.get(input.sessionId);
		if (bound) this.live.delete(input.sessionId);
		this.project(
			bound ?? {
				runId: `${input.sessionId}@${ts}`,
				surface: lifecycleSurfaceOf(input.sessionId),
				record: 'omitted',
				provider: 'unknown',
				model: null,
				agentId: resolveOwningMaestroSessionId(input.sessionId),
				tabId: null,
				startedAt: ts,
				admission: null,
			},
			{
				sessionId: input.sessionId,
				state: input.exitCode === 0 ? 'completed' : 'failed',
				at: ts,
				ledgerStatus: null,
				exitCode: input.exitCode,
				durationMs: bound ? Math.max(0, ts - bound.startedAt) : null,
				detail: bound ? null : 'spawn not observed by this process',
			}
		);
	}

	private project(
		binding: LiveBinding,
		fact: {
			sessionId: string;
			state: ManagedRunState;
			at: number;
			ledgerStatus: string | null;
			exitCode: number | null;
			durationMs: number | null;
			detail: string | null;
		}
	): void {
		const sink = this.deps.lifecycle;
		if (!sink) return;
		try {
			sink.record({
				surface: binding.surface,
				state: fact.state,
				at: fact.at,
				sessionId: fact.sessionId,
				agentId: binding.agentId,
				tabId: binding.tabId,
				provider: binding.provider,
				model: binding.model,
				providerSessionId: null,
				runId: binding.runId,
				record: binding.record,
				ledgerStatus: fact.ledgerStatus,
				exitCode: fact.exitCode,
				durationMs: fact.durationMs,
				detail: fact.detail,
				...(binding.lineage ? { lineage: binding.lineage } : {}),
				admission: binding.admission,
			});
		} catch (error) {
			this.report('warn', `lifecycle projection failed for ${fact.sessionId}`, error);
		}
	}
}
