/**
 * The runtime's turn runner for Auto Run: one process per task, iteration, synopsis, or handoff.
 *
 * The engine (`autorun/run-playbook.ts`, `run-goal.ts`) decides what to ask and what the answer
 * means; this starts the agent. It is the same path a chat turn takes, with an Auto Run's
 * differences (`spawnAgentForSession`, `assembleAutoRunTurn`):
 *
 * | Step | Piece |
 * | --- | --- |
 * | Read what the turn needs | `loadTurnContext` |
 * | Decide arguments and environment | `assembleAutoRunTurn` (no tab, no nudge, always writes, `querySource: auto`) |
 * | Start, stream, stop | `runAgentTurn`, under the desktop's batch id `<agentId>-batch-<ts>` |
 * | Be seen as busy | the process registry, as `(agentId, 'autorun')` |
 * | Notice a hung agent | `createIdleWatchdog` (AE11) |
 * | Count the work | one `query_events` row, `source: 'auto'` (AE12) |
 *
 * A run does not write a transcript: it has no tab, and its record is History.
 *
 * What the watchdog does is the desktop's: a turn silent for `autoRunInactivityTimeoutMin`, or
 * running past `autoRunMaxTaskDurationMin`, is killed and comes back `crashed` with an
 * `errorKind`, so the stall guard trips at once instead of after three more dispatches. A
 * watchdog kill is not an operator stop, which is why it never reads as `interrupted`.
 *
 * A turn sent with an effort the provider refuses is run once more without it, as the CLI's
 * `spawnAgent` and the desktop's `spawnAgentForSession` do. The effort an Auto Run sends usually
 * came off Maestro's static ladder (a document hint, the synopsis pin), and a provider can retire
 * a rung without notice: failing every task on a value nobody typed is the wrong outcome. The
 * refusal is noted (by `runAgentTurn`), so later turns stop asking for the value.
 *
 * Under management every attempt carries the run's lineage (`autorun/attribution.ts`): the
 * workflow (the playbook, its version, what triggered it), the Auto Run's run id, the task's
 * request id and the attempt id. A dispatch, its effort retry, a synopsis and a handoff are each
 * admitted on their own attempt against the authority, right before their spawn; nothing admitted
 * once is reused for the next. A workflow with no owner fence is refused as unavailable, since a
 * managed host does not run an unowned workflow and this runner never mints a fence. The run's own
 * scheduling (the stall guard, auto-resume, the watchdog) is the Auto Run's and stays so: a
 * re-dispatch after a refusal is a new attempt that is admitted again, not the refusal overridden.
 */

import { getClaudeTokenSourceFields, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import { usageStatsToTurnFields } from '../../turnUsageLedger';
import type { UsageStats } from '../../types';
import type { AgentRepository } from '../agents/repository';
import {
	autoRunRunIdentity,
	autoRunTraceId,
	autoRunWorkflowRef,
	newAutoRunTurnRequest,
	nextAutoRunAttempt,
	type AutoRunOwnerFence,
	type AutoRunTurnAttribution,
	type AutoRunWorkflowIdentity,
} from '../autorun/attribution';
import type { AutoRunTurnResult, AutoRunTurnRequest } from '../autorun/engine-types';
import { createIdleWatchdog } from '../control/idle-watchdog';
import { logger } from '../host';
import type { ManagedLaunchInput } from '../launch/launch-plan';
import type { ContextVerification, HostAuthority, PolicySourceSet } from '../managed/authority';
import type { HeadlessSpawnContextInput } from '../managed/host-adapter';
import type { ManagedDenialCode } from '../managed/types';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import { readSettingsStore } from '../store/read-stores';
import { sshRecordOf } from '../agents/rules';
import { assembleAutoRunTurn } from '../turns/assemble';
import { loadTurnContext } from '../turns/context';
import { describeCrash } from '../turns/record-turn';
import { toTurnAgent } from '../turns/records';
import {
	effortRefusalOf,
	runAgentTurn,
	type ManagedTurnAuthority,
	type RunAgentTurnRefusal,
} from '../turns/run-agent-turn';
import type { StatsRecorder } from '../turns/stats';
import { createTurnEventMapper } from '../turns/turn-events';
import type { ProcessRegistry } from './processes';
import { createSshRemoteStore } from './ssh-store';
import type { RuntimeTurnDeps, RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[AutoRunTurns]';

/** The registry tab id an Auto Run's process is filed under: the run has no tab of its own. */
export const AUTORUN_PROCESS_TAB_ID = 'autorun';

/** The desktop's defaults (`settingsStore`): four hours of silence, eight hours in all. 0 turns one off. */
const DEFAULT_INACTIVITY_TIMEOUT_MIN = 240;
const DEFAULT_MAX_TASK_DURATION_MIN = 480;
/** The longest delay `setTimeout` takes. An idle budget of "never" is this. */
const MAX_TIMER_MS = 2_147_483_647;

/** What a run's process says while it works, folded by `reduceAutoRun` into the output tail and totals. */
export type AutoRunStreamEvent =
	| { kind: 'output'; processId: string; text: string }
	| { kind: 'usage'; processId: string; usage: UsageStats };

/**
 * What a managed Auto Run admits with: the headless spawn authority of the host running it
 * (`createHeadlessSpawnAuthority`, or the desktop's port under the same shape).
 */
export interface AutoRunSpawnAuthorityPort {
	standing(): 'standalone' | 'managed';
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	context(input: HeadlessSpawnContextInput): ContextVerification;
}

export type AutoRunManagedState = 'denied' | 'unavailable' | 'unknown';

/** What became of one attempt's admission, for a journal or a test. */
export type AutoRunAdmissionEvent =
	| { kind: 'admitted'; attribution: AutoRunTurnAttribution; leaseId: string }
	| {
			kind: 'refused';
			attribution: AutoRunTurnAttribution;
			state: AutoRunManagedState;
			code: ManagedDenialCode;
			message: string;
	  };

export interface AutoRunManagedOptions {
	port: AutoRunSpawnAuthorityPort;
	/**
	 * The workflow's owner fence, read on every attempt so a fence that lapses stops the next
	 * dispatch rather than the next run. Null: the workflow has no owner, and a managed host runs
	 * none of its turns (unavailable, not denied: no policy decided). The fence comes from a
	 * workflow owner producer; this runner never mints one.
	 */
	fence(): AutoRunOwnerFence | null;
	/** An opaque account reference for the snapshot; never a credential. */
	account?: string | null;
	/** The policy's route ceiling and approved credential references, when the host has them. */
	launch?: ManagedLaunchInput;
	onAdmission?(event: AutoRunAdmissionEvent): void;
}

export interface AutoRunTurnRunnerOptions {
	agentId: string;
	paths: MaestroPaths;
	repository: Pick<AgentRepository, 'getAgent'>;
	registry: ProcessRegistry;
	statsRecorder: Pick<StatsRecorder, 'recordQuery'>;
	/** What the host told the runtime about prompts, the CLI script, and maestro-p. */
	host: RuntimeTurnOptions;
	deps: Pick<RuntimeTurnDeps, 'runAgentTurn' | 'probeBinary' | 'readGitBranch' | 'now'>;
	/** The run's live output and usage, for the progress stream. */
	onStream(event: AutoRunStreamEvent): void;
	/**
	 * The run as a workflow, so every turn carries its lineage. Absent: turns carry none, which a
	 * managed host refuses (it cannot bind what it was not told) and a standalone host ignores.
	 */
	workflow?: AutoRunWorkflowIdentity;
	/** The managed authority this run's turns are admitted with. Absent: no admission is asked. */
	managed?: AutoRunManagedOptions;
	/** Id minting for the lineage, injected by a test. */
	newId?(): string;
}

export interface AutoRunTurnRunner {
	run(request: AutoRunTurnRequest): Promise<AutoRunTurnResult>;
}

function minutesSetting(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The watchdog's two budgets in ms, read fresh so a change in the desktop applies to the next turn. */
function watchdogLimits(paths: Pick<MaestroPaths, 'settingsFile'>): {
	idleMs: number;
	maxMs: number;
} {
	const read = readSettingsStore(paths.settingsFile);
	const data = read.status === 'ok' ? read.data : {};
	const idle = minutesSetting(data.autoRunInactivityTimeoutMin, DEFAULT_INACTIVITY_TIMEOUT_MIN);
	const max = minutesSetting(data.autoRunMaxTaskDurationMin, DEFAULT_MAX_TASK_DURATION_MIN);
	return { idleMs: idle * 60_000, maxMs: max * 60_000 };
}

const failure = (error: string): AutoRunTurnResult => ({ success: false, error });

/** One attempt's result, and whether it failed on a refused effort. */
interface AutoRunAttempt {
	result: AutoRunTurnResult;
	effortRefused: boolean;
}

const attempt = (result: AutoRunTurnResult): AutoRunAttempt => ({ result, effortRefused: false });

/** The denial code `runAgentTurn` folds into its reason, by state; the message keeps the detail. */
const REFUSAL_CODES: Record<AutoRunManagedState, ManagedDenialCode> = {
	denied: 'policy-denied',
	unavailable: 'runtime-unavailable',
	unknown: 'outcome-unknown',
};

function managedStateOf(reason: RunAgentTurnRefusal): AutoRunManagedState | null {
	switch (reason) {
		case 'managed-denied':
			return 'denied';
		case 'managed-unavailable':
			return 'unavailable';
		case 'managed-unknown':
			return 'unknown';
		default:
			return null;
	}
}

/** What one attempt runs under, decided afresh for every attempt. */
type ManagedTurn =
	| { managed: false }
	| { managed: true; authority: ManagedTurnAuthority }
	| { managed: true; refusal: AutoRunAttempt };

export function createAutoRunTurnRunner(options: AutoRunTurnRunnerOptions): AutoRunTurnRunner {
	const { agentId, paths, repository, registry, statsRecorder, host, deps } = options;
	const sshStore = createSshRemoteStore(paths);
	const startTurn = deps.runAgentTurn ?? runAgentTurn;
	/** The task turn each provider session came from, so a synopsis hangs under the turn it resumes. */
	const turnsBySession = new Map<string, AutoRunTurnAttribution>();

	function attributionFor(request: AutoRunTurnRequest): AutoRunTurnAttribution | null {
		if (!options.workflow) return null;
		const resumes = request.resumeSessionId
			? (turnsBySession.get(request.resumeSessionId) ?? null)
			: null;
		return newAutoRunTurnRequest(options.workflow, {
			purpose: request.purpose,
			document: request.document ?? null,
			resumes,
			...(options.newId ? { newId: options.newId } : {}),
		});
	}

	async function run(request: AutoRunTurnRequest): Promise<AutoRunTurnResult> {
		const attribution = attributionFor(request);
		const first = await runOnce(request, attribution);
		// Only a turn that sent an effort retries, so a refusal of the agent's own configured
		// effort cannot loop. A run stopped meanwhile is not started again, and a turn a managed
		// host refused never ran, so there is no provider refusal to answer.
		if (first.result.success || !request.effort || !first.effortRefused) return first.result;
		if (first.result.managed || request.signal?.aborted) return first.result;
		logger.warn(
			`The provider refused effort "${request.effort}"; running the turn again at the agent's own effort`,
			LOG_CONTEXT,
			{ agentId }
		);
		// The same request, tried again: the retry is its own attempt and its own admission.
		const retry = attribution ? nextAutoRunAttempt(attribution, options.newId) : null;
		return (await runOnce({ ...request, effort: undefined }, retry)).result;
	}

	function managedRefusal(
		provider: string,
		attribution: AutoRunTurnAttribution | null,
		state: AutoRunManagedState,
		code: ManagedDenialCode,
		message: string
	): AutoRunAttempt {
		if (attribution) {
			options.managed?.onAdmission?.({ kind: 'refused', attribution, state, code, message });
		}
		logger.warn(`An Auto Run turn was not admitted (${state}, ${code}): ${message}`, LOG_CONTEXT, {
			agentId,
			...(attribution
				? {
						workflowId: attribution.workflow.runId,
						requestId: attribution.requestId,
						attemptId: attribution.attemptId,
					}
				: {}),
		});
		return attempt({
			success: false,
			error: `[managed-${state}] ${message}`,
			managed: { state, code },
			// A classified failure, so a run that can pause does and a person reads the reason. A
			// denial is a decision nobody retries into; the other two may clear on their own.
			agentError: {
				type: 'permission_denied',
				message,
				recoverable: state !== 'denied',
				agentId: provider,
				timestamp: deps.now(),
			},
		});
	}

	/**
	 * The admission of one attempt. Asked on every attempt: the fence, the policy revision and
	 * the context are read now, not when the run started, so what changed since applies here.
	 */
	function managedTurnFor(
		provider: string,
		attribution: AutoRunTurnAttribution | null
	): ManagedTurn {
		const managed = options.managed;
		if (!managed || managed.port.standing() === 'standalone') return { managed: false };
		const refuse = (state: AutoRunManagedState, code: ManagedDenialCode, message: string) =>
			({
				managed: true,
				refusal: managedRefusal(provider, attribution, state, code, message),
			}) as const;
		if (!attribution) {
			return refuse(
				'unavailable',
				'runtime-unavailable',
				'This Auto Run carries no workflow identity, so a managed host cannot bind its turns.'
			);
		}
		const fence = managed.fence();
		if (!fence) {
			return refuse(
				'unavailable',
				'runtime-unavailable',
				`Auto Run "${attribution.workflow.workflowId}" has no workflow owner fence; a managed host does not run an unowned workflow, and this runner does not mint one (CP-03, the workflow owner producer).`
			);
		}
		const policy = managed.port.policy();
		const verified = managed.port.context({
			identity: autoRunRunIdentity(attribution),
			traceId: autoRunTraceId(attribution),
			policyRevision: policy.policyRevision,
			workflow: autoRunWorkflowRef(attribution.workflow, fence),
		});
		if (!verified.ok) {
			return refuse(
				'denied',
				verified.code,
				`The run's context was not accepted: ${verified.problems.join('; ')}`
			);
		}
		return {
			managed: true,
			authority: {
				authority: managed.port.authority,
				context: verified.context,
				policy,
				account: managed.account ?? null,
				...(managed.launch ? { launch: managed.launch } : {}),
				onLease: (lease) =>
					managed.onAdmission?.({ kind: 'admitted', attribution, leaseId: lease.leaseId }),
			},
		};
	}

	async function runOnce(
		request: AutoRunTurnRequest,
		attribution: AutoRunTurnAttribution | null
	): Promise<AutoRunAttempt> {
		const record = repository.getAgent(agentId);
		const agent = record ? toTurnAgent(record) : undefined;
		if (!record || !agent)
			return attempt(failure('The agent is gone or has no working directory to run in.'));

		const loaded = await loadTurnContext(agent, {
			paths,
			...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
			...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			...(host.maestroCliPath ? { maestroCliPath: host.maestroCliPath } : {}),
			...(deps.probeBinary ? { probeBinary: deps.probeBinary } : {}),
			...(deps.readGitBranch ? { readGitBranch: deps.readGitBranch } : {}),
			now: () => new Date(deps.now()),
		});
		if (!loaded.ok) return attempt(failure(loaded.message));

		const assembled = assembleAutoRunTurn(
			agent,
			{
				prompt: request.prompt,
				resumeSessionId: request.resumeSessionId,
				model: request.model,
				effort: request.effort,
			},
			loaded.context
		);
		if (!assembled.ok) return attempt(failure(assembled.message));
		const turn = assembled.turn;
		const provider = turn.settings.provider;

		// Admission is per attempt and the lease is checked again inside the spawn, so nothing
		// decided for an earlier turn, or for this request's earlier attempt, carries into this one.
		const managedTurn = managedTurnFor(provider, attribution);
		if (managedTurn.managed && 'refusal' in managedTurn) return managedTurn.refusal;

		const sessionId = `${agentId}-batch-${deps.now()}`;
		const started = await startTurn(turn, {
			sessionId,
			sshStore,
			claudeTokenSource: getClaudeTokenSourceFields(record as ClaudeTokenSourceFields),
			maestroPBinPath: host.maestroPBinPath ?? null,
			...(request.signal ? { signal: request.signal } : {}),
			...(managedTurn.managed ? { managed: managedTurn.authority } : {}),
		});
		if (!started.ok) {
			const state = managedStateOf(started.reason);
			return state
				? managedRefusal(provider, attribution, state, REFUSAL_CODES[state], started.message)
				: attempt(failure(started.message));
		}
		const process = started.run;
		const startedAt = deps.now();

		// The watchdog is the run's own: one budget for silence, one for the whole turn. A turn it
		// gives up on is killed, and the result says why (the stall guard reads that).
		let watchdogKind: 'watchdog-stalled' | 'watchdog-timeout' | undefined;
		const limits = watchdogLimits(paths);
		const watchdog =
			limits.idleMs > 0 || limits.maxMs > 0
				? createIdleWatchdog({
						idleMs: limits.idleMs > 0 ? Math.min(limits.idleMs, MAX_TIMER_MS) : MAX_TIMER_MS,
						...(limits.maxMs > 0 ? { maxMs: Math.min(limits.maxMs, MAX_TIMER_MS) } : {}),
						onIdle: () => {
							watchdogKind = 'watchdog-stalled';
							process.terminate();
						},
						onMax: () => {
							watchdogKind = 'watchdog-timeout';
							process.terminate();
						},
					})
				: undefined;

		const mapper = createTurnEventMapper({
			agentId: provider,
			parser: createOutputParser(provider) ?? undefined,
			resumedSessionId: turn.resumeSessionId,
			now: deps.now,
		});

		const finished = (async () => {
			try {
				for await (const parsed of process.events) {
					watchdog?.touch();
					for (const event of mapper.map(parsed)) {
						if (event.kind === 'text') {
							options.onStream({ kind: 'output', processId: sessionId, text: event.text });
						} else if (event.kind === 'usage') {
							options.onStream({ kind: 'usage', processId: sessionId, usage: event.usage });
						}
					}
				}
			} catch (error) {
				logger.warn(
					`Reading an Auto Run turn's events failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			}
			const completed = await process.result;
			watchdog?.disarm();
			return completed;
		})();

		registry.register(agentId, AUTORUN_PROCESS_TAB_ID, {
			interrupt: () => process.interrupt(),
			terminate: () => process.terminate(),
			terminateNow: () => process.terminateNow(),
			done: finished,
		});
		const completed = await finished;
		const endedAt = deps.now();

		// The usage row the desktop writes for every turn it spawns, marked as automation.
		await statsRecorder.recordQuery({
			sessionId: agentId,
			agentType: provider,
			source: 'auto',
			startTime: startedAt,
			duration: endedAt - startedAt,
			projectPath: agent.cwd,
			isRemote: sshRecordOf(record.sessionSshRemoteConfig)?.enabled === true,
			isWorktree: typeof record.parentSessionId === 'string' && record.parentSessionId !== '',
			...usageStatsToTurnFields(completed.usage),
		});

		const finishedWell =
			completed.outcome === 'completed' || completed.outcome === 'completed-with-warning';
		// A synopsis or a handoff resumes this session: it hangs under this turn, not the root.
		if (attribution && completed.sessionId) turnsBySession.set(completed.sessionId, attribution);
		const common = {
			...(completed.answerText ? { response: completed.answerText } : {}),
			...(completed.sessionId ? { agentSessionId: completed.sessionId } : {}),
			...(completed.usage ? { usageStats: completed.usage } : {}),
		};

		if (watchdogKind) {
			// Killed by the watchdog, which is a stuck agent and not a stop: `crashed`, never
			// `interrupted`, so the engine does not end the run as if the operator had.
			return attempt({
				success: false,
				outcome: 'crashed',
				errorKind: watchdogKind,
				error:
					watchdogKind === 'watchdog-timeout'
						? 'The agent task exceeded the maximum duration'
						: 'The agent task stalled: no output within the inactivity timeout',
				...common,
			});
		}
		return {
			effortRefused: effortRefusalOf(completed) !== null,
			result: {
				success: finishedWell,
				outcome: completed.outcome,
				...(finishedWell
					? {}
					: {
							error: completed.error?.message ?? describeCrash(completed.exit),
							// A classified failure is what pauses a run that has somebody to answer it.
							...(completed.error && completed.outcome !== 'interrupted'
								? { agentError: completed.error }
								: {}),
						}),
				...common,
			},
		};
	}

	return { run };
}
