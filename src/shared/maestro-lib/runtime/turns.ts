/**
 * The runtime's turns: send, queue, stop, and the per-tab event stream (CH-2 to CH-5, gap L10).
 *
 * This is the thin owner that joins the pieces Phase 6 built, in the order a turn needs them:
 *
 * | Step | Piece |
 * | --- | --- |
 * | Run now or wait | `createExecutionQueue` (one per agent: a write turn waits for the agent's other tabs) |
 * | Read what a turn needs | `loadTurnContext` |
 * | Decide the prompt and arguments | `assembleTurn` |
 * | Start, stream, stop | `runAgentTurn` (through the library run layer) |
 * | Write the message down | `AgentRepository.beginTurn` |
 * | Say what happened | `createTurnEventMapper`, then the event bus |
 * | Write the turn down | `createTurnRecorder`, then `AgentRepository.recordTabSession` |
 *
 * Rules this owner keeps, so no caller has to:
 *
 * - **A message is never dropped.** A turn that cannot start (the provider is not installed, the
 *   SSH remote does not resolve, the fence closed) leaves its message in the queue, held, and says
 *   why. `send` reports the first failure as an error and the item stays listed until someone
 *   removes it. The queue owns that rule (`dispatch-failed`); this only reports it.
 * - **The message is durable before the provider answers**, and only once the process exists: a
 *   refused launch must not leave a transcript entry that a retry would write a second time.
 * - **`outcome` is the last event of a turn, and it follows the records.** A client that reads the
 *   tab after `outcome` sees the answer, the session id and the folded usage.
 * - **Resume belongs to the provider that issued the id.** The session id is written to the slot of
 *   the provider the turn was sent under, so a swap mid-turn, or swap-and-back after one, resumes
 *   the right conversation.
 * - **On an enrolled binding nothing is queued without a dispatch** (MRC3-01-01). A plain send is
 *   minted one here from the host's standing (`options.standing`), through the run journal, the way
 *   the managed facade mints a peer's submission; enrolled with nothing answering, it is refused
 *   before the queue and nothing is journaled. A managed item that cannot start is dropped, not
 *   held: its attempt is journaled as failed, and a held copy could be resumed into a second
 *   dispatch of the same attempt. A standalone binding queues as it always has.
 * - **The standing is checked again at the dequeue, unconditionally** (MRC3-01-02). An item that
 *   reaches `start` with no dispatch while the binding is enrolled (queued before the enrollment
 *   landed, or by an older process) is refused before the provider layer and dropped, never
 *   started, and the provider layer refuses the same on its own (`standing: 'enrolled'`). A
 *   managed item whose attempt went terminal at its start is dropped too, with the attempt
 *   journaled, so no held copy can be resumed into a second dispatch of one attempt.
 *
 * The queue is in memory. A host that exits drops what was waiting; a turn that was running is
 * stopped and recorded as interrupted (`stopAll`), which is what the person asked for by quitting.
 */

import { getClaudeTokenSourceFields, type ClaudeTokenSourceFields } from '../../claudeTokenMode';
import type { ToolType } from '../../types';
import type { AgentRepository } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, type RuleContext } from '../agents/rules';
import type { EventBus } from '../client/event-bus';
import type {
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	QueuedTurn,
	TurnEvent,
	TurnInput,
	TurnSendReceipt,
	TurnsApi,
	Unsubscribe,
} from '../client/types';
import { logger } from '../host';
import type { BinaryDetectionResult } from '../launch/path-prober';
import { createOutputParser } from '../parsers/parser-factory';
import type { MaestroPaths } from '../paths/resolve';
import type { CompletedTurn } from '../run/run-to-completion';
import {
	createExecutionQueue,
	TurnCollisionError,
	type ExecutionQueue,
	type QueueEvent,
	type QueueItem,
	type QueuedTurnHandle,
} from '../turns/queue';
import {
	lifecycleAdmissionOfLease,
	lifecycleLineageOf,
	type LifecycleAdmissionRef,
	type LifecycleEventSink,
} from '../managed/events';
import { ownRunIdentity, type HeadlessSpawnAuthority } from '../managed/host-adapter';
import {
	mintManagedDispatch,
	type ManagedDispatch,
	type ManagedSendResult,
	type ManagedTurnPort,
} from '../managed/operations';
import type { RunJournal } from '../managed/run-journal';
import {
	assembleTurn,
	type AssembledTurn,
	type TurnMessage,
	type TurnTab,
} from '../turns/assemble';
import { loadTurnContext } from '../turns/context';
import { resolveSlashCommand } from '../turns/prompt';
import {
	buildUserTranscriptEntry,
	createTurnRecorder,
	type TurnRecorder,
} from '../turns/record-turn';
import { toTurnAgent, toTurnTab } from '../turns/records';
import { runAgentTurn, type AgentTurnRun, type RunAgentTurnRefusal } from '../turns/run-agent-turn';
import { createTurnEventMapper, type UnstampedTurnEvent } from '../turns/turn-events';
import type { StatsConnectionConstructor } from '../turns/stats';
import type { DataDirVerdict } from './data-dir-lock';
import type { ProcessRegistry } from './processes';
import { createSshRemoteStore } from './ssh-store';

const LOG_CONTEXT = '[RuntimeTurns]';

/** What the host passes the runtime so it can run turns. Every field is optional. */
export interface RuntimeTurnOptions {
	/**
	 * The host's `better-sqlite3` loader (the CLI's `loadBetterSqlite3`). Absent: a turn records no
	 * usage row, and says so once in the log.
	 */
	loadSqlite?: () => StatsConnectionConstructor;
	/** The `maestro-cli.js` agents are told to call (a bare script path, PA6). */
	maestroCliPath?: string;
	/** The directory of the running bundle, which the bundled prompts are found from. */
	moduleDirectory?: string;
	/** The bundled prompts directory, when the host knows it. */
	bundledPromptsDir?: string;
	/** The `maestro-p` script for a Claude agent whose token source is the TUI. None: `claude --print`. */
	maestroPBinPath?: string | null;
	/** The managed lifecycle projection every finished turn is reported to (MRC-10-01). Absent: none. */
	lifecycle?: LifecycleEventSink;
}

/** Seams for tests: the provider launch and the probes `loadTurnContext` makes. */
export interface RuntimeTurnDeps {
	runAgentTurn: typeof runAgentTurn;
	probeBinary?(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	readGitBranch?(cwd: string): Promise<string | undefined>;
	/** The clock for events and records. */
	now: () => number;
	/** `queue.recheckMs` and the timer behind it. */
	recheckMs?: number;
	schedule?(run: () => void, ms: number): () => void;
}

/**
 * The standing every plain submission is admitted on (MRC3-01-01). The port is the headless spawn
 * authority over the binding and the attached host, the one the background turns admit with,
 * built on every call so an enrollment that appeared, lapsed or changed hands applies to the next
 * send. Absent (a host composed with no binding, a test over the queue alone): every send is
 * standalone, which is what no binding means.
 */
export interface RuntimeTurnStanding {
	port(): Pick<
		HeadlessSpawnAuthority,
		'standing' | 'authority' | 'policy' | 'unavailableReason' | 'context'
	>;
	/** The run journal a minted dispatch is recorded in. Null: the journal could not be loaded. */
	journal(): RunJournal | null;
	/** Fresh request and attempt ids for a minted dispatch. */
	newId(): string;
}

export interface RuntimeTurnsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	bus: EventBus;
	registry: ProcessRegistry;
	fence(): DataDirVerdict;
	rules?: Partial<RuleContext>;
	/** Does an Auto Run hold this agent's working tree? A write message then waits for the run (AE17). */
	autoRunHolds?(agentId: string): boolean;
	/** The binding's standing a plain send is admitted on. Absent: standalone. */
	standing?: RuntimeTurnStanding;
	options?: RuntimeTurnOptions;
	deps?: Partial<RuntimeTurnDeps>;
}

export interface RuntimeTurns {
	readonly api: TurnsApi;
	/** The managed facade's side: a managed send, and cancel by run id. */
	readonly managed: ManagedTurnPort;
	/** Look at an agent's queue again, for a hold that cleared (an Auto Run ended). */
	drain(agentId: string): void;
	/** Stop looking at queues: nothing more starts. Running turns are left to `registry.stopAll`. */
	dispose(): void;
}

/** One queued message, as the runtime holds it. */
interface TurnItem extends QueueItem {
	text: string;
	queuedAt: number;
	/** Model and effort at the moment it was queued (a model change before it runs must not relabel it). */
	turnSettings: { model?: string; effort?: string };
	/**
	 * The provider those settings were chosen on. A model name means nothing to another provider,
	 * so a message still queued when the agent switches runs with the new provider's settings.
	 */
	settingsProvider: string;
	/** Set on a managed item: the authority admits it at the spawn, the journal records it. */
	managed?: ManagedDispatch;
}

type Verdict =
	| { ok: true }
	/** `dropped`: the queue let the item go (a terminal managed attempt, a refused admission). */
	| { ok: false; message: string; reason?: RunAgentTurnRefusal; dropped: boolean };

/**
 * A start the admission or the provider layer refused, with its reason, so a managed caller hears
 * which. The queue drops an item refused this way: the attempt is terminal, or never existed.
 */
class TurnStartRefusal extends Error {
	constructor(
		readonly reason: RunAgentTurnRefusal,
		message: string
	) {
		super(message);
		this.name = 'TurnStartRefusal';
	}
}

function terminalOutcomeOf(completed: CompletedTurn): 'completed' | 'failed' | 'cancelled' {
	switch (completed.outcome) {
		case 'completed':
		case 'completed-with-warning':
			return 'completed';
		case 'interrupted':
			return 'cancelled';
		case 'crashed':
			return 'failed';
	}
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fail<T = never>(
	method: ClientMethod,
	code: ClientErrorCode,
	message: string
): ClientResult<T> {
	const error: ClientError = { code, message, method };
	return { ok: false, error };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function noLoader(): never {
	throw new Error('This host did not provide a SQLite loader, so usage is not recorded.');
}

export function createRuntimeTurns(options: RuntimeTurnsOptions): RuntimeTurns {
	const { paths, repository, bus, registry } = options;
	const host = options.options ?? {};
	const deps: RuntimeTurnDeps = {
		runAgentTurn,
		now: () => Date.now(),
		...options.deps,
	};
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.rules };

	const recorder: TurnRecorder = createTurnRecorder({
		paths,
		repository,
		loadSqlite: host.loadSqlite ?? noLoader,
		fence: options.fence,
		context: options.rules,
		...(host.lifecycle ? { lifecycle: host.lifecycle } : {}),
	});

	const sshStore = createSshRemoteStore(paths);

	const queues = new Map<string, ExecutionQueue<TurnItem>>();
	/** Resolved by the first dispatch attempt of an item that ran straight away. */
	const verdicts = new Map<string, (verdict: Verdict) => void>();

	const emitTurn = (agentId: string, tabId: string, event: UnstampedTurnEvent): void => {
		bus.emit({
			type: 'turn',
			agentId,
			tabId,
			event: { ...event, at: deps.now() } as TurnEvent,
		});
	};

	// -----------------------------------------------------------------------
	// Starting one turn (the queue's `start`)
	// -----------------------------------------------------------------------

	/** Is the binding enrolled right now? Read at every dequeue, so an enrollment that landed while an item waited counts. */
	const enrolledStanding = (): boolean => options.standing?.port().standing() === 'managed';

	async function startItem(agentId: string, item: TurnItem): Promise<QueuedTurnHandle> {
		const record = repository.getAgent(agentId);
		if (!record) throw new Error(`No agent ${agentId}.`);
		const tabRecord = repository.getTab(agentId, item.tabId);
		if (!tabRecord) throw new Error(`The tab ${item.tabId} no longer exists.`);
		// The tab's previous process has not gone yet: a timing collision, not a verdict on the item.
		if (registry.isBusy(agentId, item.tabId)) throw new TurnCollisionError();

		// The dequeue admission (MRC3-01-02), before anything is read for the turn: on an enrolled
		// binding an item with no dispatch is refused and dropped, never started, and nothing is
		// journaled, since no attempt exists to record. A standalone binding reads nothing here.
		const enrolled = enrolledStanding();
		const managed = item.managed;
		if (enrolled && !managed) {
			throw new TurnStartRefusal(
				'managed-unavailable',
				'This installation is enrolled and the queued message carries no managed dispatch (it was queued before the enrollment, or by an older process), so it was dropped rather than started; send it again.'
			);
		}

		const agent = toTurnAgent(record);
		if (!agent) throw new Error('The agent has no working directory to run in.');

		const loaded = await loadTurnContext(agent, {
			paths,
			...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
			...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			...(host.maestroCliPath ? { maestroCliPath: host.maestroCliPath } : {}),
			...(deps.probeBinary ? { probeBinary: deps.probeBinary } : {}),
			...(deps.readGitBranch ? { readGitBranch: deps.readGitBranch } : {}),
			now: () => new Date(deps.now()),
		});
		if (!loaded.ok) throw new Error(loaded.message);

		const tab: TurnTab = toTurnTab(tabRecord);
		const command = resolveSlashCommand(item.text, loaded.commands, agent.agentCommands);
		const message: TurnMessage = {
			text: item.text,
			// Frozen settings only hold on the provider they were frozen on (see `settingsProvider`).
			...(item.settingsProvider === agent.toolType ? { turnSettings: item.turnSettings } : {}),
			...(command ? { command } : {}),
			...(item.readOnly ? { readOnly: true } : {}),
		};
		const assembled = assembleTurn(agent, tab, message, {
			...loaded.context,
			// A run that started between this message being queued and now makes it read-only instead.
			autoRunHoldsTree: options.autoRunHolds?.(agentId) ?? false,
		});
		if (!assembled.ok) throw new Error(assembled.message);
		const turn: AssembledTurn = assembled.turn;
		const provider = turn.settings.provider;

		// The single-writer check, before the spawn (MRC-08-05): a runtime that lost its data directory
		// starts nothing (its records would be refused once the process existed); a managed attempt is journaled.
		const writer = options.fence();
		if (!writer.ok) {
			const message = `This runtime no longer owns its data directory: ${writer.reason}`;
			if (managed) {
				await managed.journal
					.markTerminal(managed.runId, managed.attemptId, {
						outcome: 'failed',
						detail: `managed-unavailable: ${message}`,
					})
					.catch((error) =>
						logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT)
					);
				throw new TurnStartRefusal('managed-unavailable', message);
			}
			throw new Error(message);
		}
		const admitted: { leaseId: string | null; admission: LifecycleAdmissionRef | null } = {
			leaseId: null,
			admission: null,
		};
		const started = await deps.runAgentTurn(turn, {
			sessionId: `${agentId}-ai-${item.tabId}`,
			sshStore,
			claudeTokenSource: getClaudeTokenSourceFields(record as ClaudeTokenSourceFields),
			maestroPBinPath: host.maestroPBinPath ?? null,
			// The provider layer holds the same rule on its own: enrolled, a turn runs managed or not at all.
			standing: enrolled ? 'enrolled' : 'standalone',
			...(managed
				? {
						managed: {
							authority: managed.authority,
							context: managed.context,
							policy: managed.policy,
							resourceIds: managed.resources.map((resource) => resource.id),
							onLease: (lease) => {
								admitted.leaseId = lease.leaseId;
								admitted.admission = lifecycleAdmissionOfLease(lease);
							},
						},
					}
				: {}),
		});
		if (!started.ok) {
			if (managed) {
				await managed.journal.markTerminal(managed.runId, managed.attemptId, {
					outcome: 'failed',
					detail: `${started.reason}: ${started.message}`,
				});
			}
			throw new TurnStartRefusal(started.reason, started.message);
		}
		const run = started.run;
		// A managed turn runs on a lease or not at all: a sink that answered with a process and no lease
		// did not admit it (a replaced provider launch cannot run it unadmitted), so it is stopped here.
		if (managed && admitted.leaseId === null) {
			run.terminateNow();
			await run.result.catch(() => undefined);
			const message =
				'The provider launch started a process for a managed turn without a lease from the authority; it was stopped.';
			await managed.journal
				.markTerminal(managed.runId, managed.attemptId, {
					outcome: 'failed',
					detail: `managed-unavailable: ${message}`,
				})
				.catch((error) =>
					logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT)
				);
			throw new TurnStartRefusal('managed-unavailable', message);
		}

		// The process exists, so the registry learns of it before anything is awaited: the agent
		// reads busy to Auto Run, and a shutdown stops this process, from this line on. `settled`
		// stands in for the stream's end until the stream exists.
		let settle: () => void = () => undefined;
		const settled = new Promise<void>((resolve) => {
			settle = resolve;
		});
		registry.register(
			agentId,
			item.tabId,
			{
				interrupt: () => run.interrupt(),
				terminate: () => run.terminate(),
				terminateNow: () => run.terminateNow(),
				done: settled,
			},
			managed ? { runId: managed.runId } : {}
		);
		// The process exists: the attempt is dispatched. A receipt the journal
		// cannot write is an unknown attempt, not a started one.
		if (managed) {
			try {
				await managed.journal.markDispatched(managed.runId, managed.attemptId, {
					pid: run.pid ?? null,
					leaseId: admitted.leaseId,
				});
			} catch (error) {
				logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT);
			}
		}

		let done: Promise<void>;
		try {
			// The message is now sent: write it down, and spend a merge it carried.
			const startedAt = deps.now();
			const userEntry = buildUserTranscriptEntry(turn.entry, startedAt, ctx);
			const begun = await repository.beginTurn(agentId, item.tabId, {
				userEntry,
				provider: provider as ToolType,
				consumedMergedContext: turn.consumedMergedContext,
			});
			// Not recorded means not sent, as far as the person can tell: stop it and hold the item.
			if (!begun.ok) throw new Error(begun.error.message);

			emitTurn(agentId, item.tabId, { kind: 'user', entry: userEntry });
			emitTurn(agentId, item.tabId, { kind: 'started' });

			done = streamTurn({
				agentId,
				tabId: item.tabId,
				turn,
				run,
				startedAt,
				managed,
				admission: admitted.admission,
			});
		} catch (error) {
			run.terminate();
			await run.result.catch(() => undefined);
			settle();
			throw error;
		}
		done.then(settle, settle);
		return { done, interrupt: () => run.interrupt() };
	}

	// -----------------------------------------------------------------------
	// One turn's stream and its records
	// -----------------------------------------------------------------------

	async function streamTurn(input: {
		agentId: string;
		tabId: string;
		turn: AssembledTurn;
		run: AgentTurnRun;
		startedAt: number;
		managed: ManagedDispatch | undefined;
		/** The lease the turn was admitted on, for the lifecycle projection. Null when none was minted. */
		admission: LifecycleAdmissionRef | null;
	}): Promise<void> {
		const { agentId, tabId, turn, run, startedAt, managed, admission } = input;
		const provider = turn.settings.provider;
		const mapper = createTurnEventMapper({
			agentId: provider,
			parser: createOutputParser(provider) ?? undefined,
			resumedSessionId: turn.resumeSessionId,
			now: deps.now,
		});
		let recordedSession: string | undefined = turn.resumeSessionId;
		let sessionWrite: Promise<unknown> = Promise.resolve();

		/** Write the provider's session id the moment it is announced: a crash after this still resumes. */
		const noteSession = (id: string): void => {
			if (id === recordedSession) return;
			recordedSession = id;
			sessionWrite = sessionWrite.then(() =>
				repository.recordTabSession(agentId, tabId, provider, { agentSessionId: id })
			);
		};

		try {
			for await (const parsed of run.events) {
				for (const event of mapper.map(parsed)) {
					if (event.kind === 'session') noteSession(event.providerSessionId);
					emitTurn(agentId, tabId, event);
				}
			}
		} catch (error) {
			logger.warn(`Reading the turn's events failed: ${errorText(error)}`, LOG_CONTEXT);
		}

		let completed: CompletedTurn;
		try {
			completed = await run.result;
		} catch (error) {
			// The process ran and its ending was lost: the attempt is unknown, never retried blind.
			if (managed) {
				await managed.journal
					.markUnknown(managed.runId, managed.attemptId, errorText(error))
					.catch(() => undefined);
			}
			throw error;
		}
		const endedAt = deps.now();
		if (managed) {
			try {
				await managed.journal.markTerminal(managed.runId, managed.attemptId, {
					outcome: terminalOutcomeOf(completed),
					...(completed.error ? { detail: completed.error.message } : {}),
					providerSessionId: completed.sessionId ?? null,
				});
			} catch (error) {
				logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT);
			}
		}
		if (completed.sessionId && completed.sessionId !== mapper.sessionId()) {
			emitTurn(agentId, tabId, { kind: 'session', providerSessionId: completed.sessionId });
		}
		if (completed.sessionId) noteSession(completed.sessionId);
		await sessionWrite.catch(() => undefined);

		try {
			const recorded = await recorder.recordTurn({
				agentId,
				tabId,
				assembled: turn,
				completed,
				startedAt,
				endedAt,
				userEntryWritten: true,
				...(managed ? { lineage: lifecycleLineageOf(managed.context) } : {}),
				admission,
			});
			if (!recorded.transcript.ok && recorded.transcript.error.code !== 'not-found') {
				logger.warn(
					`The turn's transcript was not written: ${recorded.transcript.error.message}`,
					LOG_CONTEXT
				);
			}
			// The folded usage the tab record carries (`TurnEvent.usage` says clients must not sum).
			if (completed.usage) {
				await repository.recordTabSession(agentId, tabId, provider, {
					addUsage: completed.usage,
				});
			}
		} catch (error) {
			logger.warn(`Recording the turn failed: ${errorText(error)}`, LOG_CONTEXT);
		}

		emitTurn(agentId, tabId, {
			kind: 'outcome',
			outcome: completed.outcome,
			exitCode: completed.exit.exitCode,
			...(completed.error ? { error: completed.error } : {}),
		});
	}

	// -----------------------------------------------------------------------
	// Queues
	// -----------------------------------------------------------------------

	function onQueueEvent(agentId: string, event: QueueEvent<TurnItem>): void {
		switch (event.type) {
			case 'started':
				verdicts.get(event.item.id)?.({ ok: true });
				verdicts.delete(event.item.id);
				break;
			case 'dispatch-failed': {
				// Dropped, not held (MRC3-01-02): an item the admission refused (no dispatch on an
				// enrolled binding) and a managed item whose attempt is terminal now. A held copy could be
				// resumed into a second dispatch of one attempt, or started with no dispatch at all.
				const managed = event.item.managed;
				const refusal = event.error instanceof TurnStartRefusal;
				const dropped = event.held && (managed !== undefined || refusal);
				if (dropped) queues.get(agentId)?.remove(event.item.id);
				if (event.held) {
					logger.warn(`A turn could not start: ${event.error.message}`, LOG_CONTEXT);
					emitTurn(agentId, event.item.tabId, {
						kind: 'error',
						error: {
							type: 'unknown',
							message: dropped
								? `The message was not sent and was dropped from the queue: ${event.error.message}`
								: `The message was not sent: ${event.error.message}`,
							recoverable: true,
							agentId: repository.getAgent(agentId)?.toolType ?? 'unknown',
							timestamp: deps.now(),
						},
					});
				}
				// A managed item dropped on a cause nobody journaled (the tab went, the context could not
				// be loaded, the message could not be recorded, the collision cap): its attempt is written
				// down as failed, since the queue let the item go on that record, and the verdict follows
				// the record. A refusal journaled itself; a collision under the cap retries the attempt.
				const journaled =
					dropped && managed && !refusal
						? managed.journal
								.markTerminal(managed.runId, managed.attemptId, {
									outcome: 'failed',
									detail: `launch: ${event.error.message}`,
								})
								.catch((error) =>
									logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT)
								)
						: Promise.resolve();
				const verdict = verdicts.get(event.item.id);
				verdicts.delete(event.item.id);
				const { error } = event;
				void journaled.then(() =>
					verdict?.({
						ok: false,
						message: error.message,
						dropped,
						...(error instanceof TurnStartRefusal ? { reason: error.reason } : {}),
					})
				);
				break;
			}
			default:
				break;
		}
	}

	function queueFor(agentId: string): ExecutionQueue<TurnItem> {
		let queue = queues.get(agentId);
		if (!queue) {
			queue = createExecutionQueue<TurnItem>({
				start: (item) => startItem(agentId, item),
				onEvent: (event) => onQueueEvent(agentId, event),
				holdsTree: () => options.autoRunHolds?.(agentId) ?? false,
				...(deps.recheckMs !== undefined ? { recheckMs: deps.recheckMs } : {}),
				...(deps.schedule ? { schedule: deps.schedule } : {}),
			});
			queues.set(agentId, queue);
		}
		return queue;
	}

	// An agent that is removed takes its queue with it; a tab that closes takes the messages waiting for it.
	const unsubscribeLifecycle = bus.subscribe(
		(event) => {
			if (event.type === 'agent.removed') {
				const queue = queues.get(event.agentId);
				queue?.dispose();
				queues.delete(event.agentId);
			} else if (event.type === 'tab.removed') {
				const queue = queues.get(event.agentId);
				for (const item of queue?.items() ?? []) {
					if (item.tabId === event.tabId) queue?.remove(item.id);
				}
			}
		},
		{ types: ['agent.removed', 'tab.removed'] }
	);

	// -----------------------------------------------------------------------
	// The API
	// -----------------------------------------------------------------------

	type ManagedRefusalReason = Extract<
		RunAgentTurnRefusal,
		'managed-denied' | 'managed-unavailable' | 'managed-unknown'
	>;

	type Submission =
		| { status: 'queued'; receipt: Extract<TurnSendReceipt, { status: 'queued' }> }
		| { status: 'started' }
		/** Could not start. `held`: the item stays in the queue; a managed item was dropped instead. */
		| { status: 'failed'; message: string; reason?: RunAgentTurnRefusal; held: boolean }
		/** Refused by the binding's standing before anything was queued or journaled. */
		| { status: 'refused'; message: string; reason: ManagedRefusalReason }
		| { status: 'not-found' | 'rejected'; message: string };

	type StandingAdmission =
		| { kind: 'standalone' }
		| { kind: 'minted'; dispatch: ManagedDispatch }
		| { kind: 'refused'; reason: ManagedRefusalReason; message: string };

	/**
	 * The dispatch a plain submission runs under on this binding (MRC3-01-01). Standalone: none, and
	 * nothing is read or written. Enrolled with an answering authority: minted here from the host's
	 * standing (the installation, the registered actor, the policy revision of this moment, a fresh
	 * request and attempt through the run journal), the way the managed facade mints a peer's
	 * submission. Enrolled with nothing answering (no attached host, a host for another binding, an
	 * unreadable record, a lost data directory, no journal): refused, and nothing is journaled, since
	 * a journal entry would name an attempt nothing can admit.
	 */
	async function admitStanding(
		agentId: string,
		tabId: string,
		providerId: string,
		text: string
	): Promise<StandingAdmission> {
		const standing = options.standing;
		if (!standing) return { kind: 'standalone' };
		const port = standing.port();
		if (port.standing() === 'standalone') return { kind: 'standalone' };
		const unavailable = (message: string): StandingAdmission => ({
			kind: 'refused',
			reason: 'managed-unavailable',
			message,
		});
		if (port.unavailableReason !== null) {
			return unavailable(
				`This installation is enrolled and no authority answers for it, so the message was not queued: ${port.unavailableReason}`
			);
		}
		const writer = options.fence();
		if (!writer.ok) {
			return unavailable(`This runtime no longer owns its data directory: ${writer.reason}`);
		}
		const journal = standing.journal();
		if (!journal) {
			return unavailable(
				'This installation is enrolled and its run journal could not be loaded, so the message was not queued.'
			);
		}
		const policy = port.policy();
		const identity = ownRunIdentity(standing.newId);
		const verified = port.context({
			identity,
			traceId: `turn:${identity.requestId}`,
			policyRevision: policy.policyRevision,
		});
		if (!verified.ok) {
			return {
				kind: 'refused',
				reason: 'managed-denied',
				message: `The turn's context was not accepted: ${verified.problems.join('; ')}`,
			};
		}
		const minted = await mintManagedDispatch({
			context: verified.context,
			authority: port.authority,
			policy,
			journal,
			agentId,
			tabId,
			providerId,
			text,
			resources: [],
		});
		switch (minted.status) {
			case 'accepted':
				return { kind: 'minted', dispatch: minted.dispatch };
			case 'unavailable':
				return unavailable(
					`The run journal could not be written, so the message was not queued: ${minted.message}`
				);
			// A fresh request id cannot replay or collide; an answer that says it did is not a dispatch.
			case 'replayed':
			case 'conflict':
			case 'unknown':
				return {
					kind: 'refused',
					reason: 'managed-unknown',
					message: `The run journal answered ${minted.status} for a fresh submission (run ${minted.run.runId}); the message was not queued.`,
				};
		}
	}

	/** Build the item and submit it; the two senders word the answer. */
	async function submitText(
		agentId: string,
		tabId: string,
		text: string,
		managed?: ManagedDispatch
	): Promise<Submission> {
		const record = repository.getAgent(agentId);
		if (!record) return { status: 'not-found', message: `No agent ${agentId}.` };
		const tabRecord = repository.getTab(agentId, tabId);
		if (!tabRecord) return { status: 'not-found', message: `No tab ${tabId}.` };
		const agent = toTurnAgent(record);
		if (!agent) {
			return { status: 'rejected', message: 'The agent has no working directory to run in.' };
		}
		const tab = toTurnTab(tabRecord);

		// A dispatch the caller brought (the managed facade) or the binding's own; never neither on
		// an enrolled binding.
		let dispatch = managed;
		if (!dispatch) {
			const admitted = await admitStanding(agentId, tabId, agent.toolType, text);
			if (admitted.kind === 'refused') {
				return { status: 'refused', reason: admitted.reason, message: admitted.message };
			}
			if (admitted.kind === 'minted') dispatch = admitted.dispatch;
		}

		const item: TurnItem = {
			id: ctx.newId(),
			tabId,
			text,
			queuedAt: deps.now(),
			readOnly: tab.readOnlyMode === true || tab.permissionMode === 'readonly',
			turnSettings: {
				model: tab.customModel ?? agent.customModel,
				effort: tab.customEffort ?? agent.customEffort,
			},
			settingsProvider: agent.toolType,
			...(dispatch ? { managed: dispatch } : {}),
		};

		const queue = queueFor(agentId);
		const attempt = new Promise<Verdict>((resolve) => verdicts.set(item.id, resolve));
		const { queued } = queue.submit(item);
		if (queued) {
			verdicts.delete(item.id);
			const waiting = queue.items();
			return {
				status: 'queued',
				receipt: {
					status: 'queued',
					itemId: item.id,
					// 1-based: the position the message holds in line, as the desktop reports it.
					position: waiting.findIndex((entry) => entry.id === item.id) + 1,
					queueLength: waiting.length,
				},
			};
		}
		const verdict = await attempt;
		if (verdict.ok) return { status: 'started' };
		// A managed item, or one the admission refused, was dropped by the queue as it failed (its
		// attempt journaled as failed); any other item is held with its cause.
		return {
			status: 'failed',
			message: verdict.message,
			reason: verdict.reason,
			held: !verdict.dropped,
		};
	}

	async function send(
		agentId: string,
		tabId: string,
		input: TurnInput
	): Promise<ClientResult<TurnSendReceipt>> {
		const method: ClientMethod = 'turns.send';
		if (input.images?.length) {
			return fail(
				method,
				'unsupported',
				'Images cannot be sent from here yet. Send the message without them, or use the desktop.'
			);
		}
		if (!input.text?.trim()) return fail(method, 'invalid', 'There is nothing to send.');
		const submitted = await submitText(agentId, tabId, input.text);
		switch (submitted.status) {
			case 'queued':
				return ok(submitted.receipt);
			case 'started':
				return ok({ status: 'started' });
			case 'not-found':
			case 'rejected':
				return fail(method, submitted.status, submitted.message);
			// The binding's standing refused it: nothing was queued, nothing was journaled.
			case 'refused':
				return fail(method, 'rejected', `[${submitted.reason}] ${submitted.message}`);
			case 'failed':
				return fail(
					method,
					'failed',
					submitted.held
						? `${submitted.message} The message is held in the queue; remove it or fix the cause and resume.`
						: `${submitted.message} The message was dropped, not held; send it again for a new attempt.`
				);
		}
	}

	const managedPort: ManagedTurnPort = {
		async sendManaged(agentId, tabId, text, dispatch): Promise<ManagedSendResult> {
			// The single-writer check at the port (MRC-08-05): nothing of a managed send is queued on a
			// runtime that lost its data directory; the attempt is journaled as failed, a fact a peer reads.
			const writer = options.fence();
			if (!writer.ok) {
				const message = `This runtime no longer owns its data directory: ${writer.reason}`;
				await dispatch.journal
					.markTerminal(dispatch.runId, dispatch.attemptId, {
						outcome: 'failed',
						detail: `managed-unavailable: ${message}`,
					})
					.catch((error) =>
						logger.warn(`The run journal was not written: ${errorText(error)}`, LOG_CONTEXT)
					);
				return { status: 'refused', reason: 'managed-unavailable', message };
			}
			const submitted = await submitText(agentId, tabId, text, dispatch);
			switch (submitted.status) {
				case 'queued':
				case 'started':
					return { status: submitted.status };
				case 'not-found':
				case 'rejected':
					await dispatch.journal.markTerminal(dispatch.runId, dispatch.attemptId, {
						outcome: 'failed',
						detail: submitted.message,
					});
					return { status: 'refused', reason: 'other', message: submitted.message };
				// A caller that brought its dispatch is never refused by the standing; kept for the type.
				case 'refused':
					return { status: 'refused', reason: submitted.reason, message: submitted.message };
				case 'failed': {
					// The attempt is journaled as failed and the queue dropped the item (see `onQueueEvent`).
					const reason =
						submitted.reason === 'managed-denied' ||
						submitted.reason === 'managed-unavailable' ||
						submitted.reason === 'managed-unknown'
							? submitted.reason
							: 'other';
					return { status: 'refused', reason, message: submitted.message };
				}
			}
		},
		async cancelRun(runId, kind) {
			for (const queue of queues.values()) {
				const waiting = queue.items().find((item) => item.managed?.runId === runId);
				if (waiting?.managed && queue.remove(waiting.id)) {
					await waiting.managed.journal.markTerminal(runId, waiting.managed.attemptId, {
						outcome: 'cancelled',
						detail: 'Removed from the queue before it was dispatched.',
					});
					return 'dequeued';
				}
			}
			const stopped =
				kind === 'interrupt' ? await registry.interruptRun(runId) : await registry.stopRun(runId);
			return stopped ? 'stopped' : 'none';
		},
	};

	const api: TurnsApi = {
		send,

		interrupt: async (agentId, tabId) => {
			const queue = queues.get(agentId);
			if (!queue?.isTabBusy(tabId)) return ok({ stopped: false });
			queue.interrupt(tabId);
			return ok({ stopped: true });
		},

		queue: {
			list: async (agentId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.list', 'not-found', `No agent ${agentId}.`);
				}
				const items = queues.get(agentId)?.items() ?? [];
				return ok(
					items.map(
						(item): QueuedTurn => ({
							itemId: item.id,
							tabId: item.tabId,
							queuedAt: item.queuedAt,
							kind: 'message',
							text: item.text,
							paused: item.paused === true,
						})
					)
				);
			},
			remove: async (agentId, itemId) => {
				if (!repository.getAgent(agentId)) {
					return fail('turns.queue.remove', 'not-found', `No agent ${agentId}.`);
				}
				return ok({ removed: queues.get(agentId)?.remove(itemId) ?? false });
			},
		},

		subscribe: (agentId, tabId, listener): Unsubscribe =>
			bus.subscribe(
				(event) => {
					if (event.type === 'turn' && event.tabId === tabId) listener(event.event);
				},
				{ types: ['turn'], agentId }
			),
	};

	return {
		api,
		managed: managedPort,
		drain: (agentId) => queues.get(agentId)?.drain(),
		dispose() {
			unsubscribeLifecycle();
			for (const queue of queues.values()) queue.dispose();
			queues.clear();
		},
	};
}
