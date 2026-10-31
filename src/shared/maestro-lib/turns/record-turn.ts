/**
 * What the runtime writes down when a turn ends (gap L13, CH-5): the transcript, the History
 * entry, and the usage row, so the desktop shows the same conversation and counts the same work.
 *
 * | Record | Where | Written by |
 * | --- | --- | --- |
 * | Transcript | the tab's `logs` in `maestro-sessions.json` | `AgentRepository.appendTranscript` |
 * | History | `<userData>/history/<agentId>.jsonl` | `createHistoryWriter` |
 * | Usage | `query_events` in `<userData>/stats.db` | `createStatsRecorder` |
 *
 * The three are independent. Each is attempted in that order whatever the one before did, and
 * none throws: the turn already happened, and a record that could not be written is a line in
 * the result, not a failed turn.
 *
 * Two departures from the desktop, both on purpose:
 *
 * - **The History summary comes from the answer** (`summarizeAnswer`, the function the desktop's
 *   exit toast uses), not from a synopsis agent. The desktop spawns a second provider turn per
 *   exit to write one; the runtime does not start work nobody asked for. `fullResponse` is the
 *   answer itself.
 * - **Only the user's message, the answer, and a failure are written to the transcript.** Thinking
 *   and tool cards stream live to the client; persisting them is a richer entry model than
 *   this task owns.
 *
 * A tab whose `saveToHistory` chip is off records no History entry (as on the desktop), and an
 * interrupted or crashed turn records none either: History is the record of work that finished.
 * Usage is recorded for every turn that ran.
 */

import { formatSessionId } from '../store/tab-display';
import type { LogEntryRecord } from '../store/transcript';
import type { AgentRecord, AITabRecord } from '../store/records';
import type { NativeSessionBinding } from '../agents/providerSwap';
import type { AgentRepository, TabWriteGuard } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, sshRecordOf, type RuleContext } from '../agents/rules';
import type { ClientResult } from '../client/types';
import {
	lifecycleStateOf,
	type LifecycleAdmissionRef,
	type LifecycleEventSink,
	type LifecycleFact,
	type LifecycleLineage,
} from '../managed/events';
import type { MaestroPaths } from '../paths/resolve';
import { estimateContextUsage } from '../parsers/usage-aggregator';
import type { CompletedTurn } from '../run/run-to-completion';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import { usageStatsToTurnFields } from '../../turnUsageLedger';
import type { HistoryEntry, ToolType } from '../../types';
import type { AssembledTurn } from './assemble';
import { createHistoryWriter, type HistoryAppendResult, type HistoryWriter } from './history';
import {
	createStatsRecorder,
	readStatsCollectionEnabled,
	type StatsConnectionConstructor,
	type StatsRecordResult,
	type StatsRecorder,
} from './stats';
import { summarizeAnswer } from './summary';

/** The stderr kept in a failure entry when the provider named no error. */
const STDERR_TAIL_CHARS = 500;

/** One finished turn, as the runtime knows it. */
export interface RecordedTurn {
	/** Original tab incarnation and turn/slot ownership, checked within each mutation queue. */
	writeGuard?: TabWriteGuard;
	/** Original turn attribution. It is not proof of canonical native ownership. */
	scope?: Readonly<{ projectPath: string; isRemote: boolean; isWorktree: boolean }>;
	/** Only the launch observer may bind this; absent/unknown never uses current settings. */
	nativeSessionBinding?: NativeSessionBinding;
	agentId: string;
	tabId: string;
	/** The turn as `assembleTurn` made it: what was sent and under which settings. */
	assembled: Pick<AssembledTurn, 'entry' | 'settings'>;
	/** How it ended, from `runAgentTurn`'s `result`. */
	completed: Pick<
		CompletedTurn,
		'outcome' | 'answerText' | 'sessionId' | 'usage' | 'error' | 'exit'
	>;
	/** When the message was sent, epoch ms. */
	startedAt: number;
	/** When the process ended, epoch ms. */
	endedAt: number;
	/**
	 * The person's message is already in the transcript (the runtime writes it when the turn
	 * starts, through `beginTurn`). The entries written here then start at the answer.
	 */
	userEntryWritten?: boolean;
	/** The managed lineage the turn ran under (`lifecycleLineageOf(dispatch.context)`), when it had one. */
	lineage?: LifecycleLineage;
	/** The lease the turn was admitted on (`lifecycleAdmissionOfLease`), when the authority minted one. */
	admission?: LifecycleAdmissionRef | null;
}

/** What happened to each record. A skipped record says why. */
export interface TurnRecordResult {
	transcript: ClientResult<void>;
	history: HistoryAppendResult | { ok: false; reason: 'not-recorded'; message: string };
	stats: StatsRecordResult;
}

export interface TurnRecorderOptions {
	paths: Pick<MaestroPaths, 'historyDir' | 'statsFile' | 'settingsFile'>;
	repository: Pick<AgentRepository, 'getAgent' | 'getTab' | 'appendTranscript'> &
		Partial<Pick<AgentRepository, 'withTabWriteGuard'>>;
	/** The host's `better-sqlite3` loader (the CLI's `loadBetterSqlite3`). It throws when the module cannot load. */
	loadSqlite: () => StatsConnectionConstructor;
	/** Is this process still the data directory's writer? Asked before the History and usage writes. */
	fence?: () => DataDirVerdict;
	/** Ids and the clock for the entries it makes. */
	context?: Partial<RuleContext>;
	/** Test seams: the writers themselves. */
	historyWriter?: HistoryWriter;
	statsRecorder?: StatsRecorder;
	/**
	 * The managed lifecycle projection (MRC-10-01). Every recorded turn ends as one metadata-only
	 * fact (`buildTurnLifecycleFact`), after the records, whatever became of them. Absent: none.
	 */
	lifecycle?: LifecycleEventSink;
}

export interface TurnRecorder {
	/** Write every record of a finished turn. Never throws. */
	recordTurn(turn: RecordedTurn): Promise<TurnRecordResult>;
}

/** The text of a failure entry for a crash the provider did not classify. */
export function describeCrash(exit: CompletedTurn['exit']): string {
	if (exit.spawnError) return `The agent could not be started: ${exit.spawnError.message}`;
	const stderr = exit.stderrText.trim().slice(-STDERR_TAIL_CHARS);
	const how = exit.signal
		? `was stopped by ${exit.signal}`
		: `exited with code ${exit.exitCode ?? 'unknown'}`;
	return stderr ? `The agent ${how}.\n${stderr}` : `The agent ${how}.`;
}

/**
 * The transcript entry for the message a person sent (CH-5): what they typed, never the hidden
 * layers. Pure; the id and time come from the caller.
 */
export function buildUserTranscriptEntry(
	entry: AssembledTurn['entry'],
	timestamp: number,
	ctx: Pick<RuleContext, 'newId'>
): LogEntryRecord {
	return {
		id: ctx.newId(),
		timestamp,
		source: 'user',
		text: entry.text,
		delivered: true,
		...(entry.images?.length ? { images: entry.images } : {}),
		...(entry.readOnly ? { readOnly: true } : {}),
		...(entry.aiCommand
			? {
					aiCommand: {
						command: entry.aiCommand.command,
						description: entry.aiCommand.description ?? '',
					},
				}
			: {}),
	};
}

/**
 * The transcript entries of one turn: the message the person sent (unless the runtime already
 * wrote it), then the answer, then a failure when it crashed. Pure; ids and times come from the
 * caller.
 */
export function buildTurnTranscript(turn: RecordedTurn, ctx: RuleContext): LogEntryRecord[] {
	const { entry, settings } = turn.assembled;
	const entries: LogEntryRecord[] = turn.userEntryWritten
		? []
		: [buildUserTranscriptEntry(entry, turn.startedAt, ctx)];

	const answer = turn.completed.answerText?.trim() ? turn.completed.answerText : undefined;
	if (answer) {
		entries.push({
			id: ctx.newId(),
			timestamp: turn.endedAt,
			source: 'stdout',
			text: answer,
			// What the turn ran under, frozen at send (a model change mid-stream must not relabel it).
			...(settings.model ? { turnModel: settings.model } : {}),
			...(settings.effort ? { turnEffort: settings.effort } : {}),
		});
	}

	if (turn.completed.outcome === 'crashed') {
		entries.push({
			id: ctx.newId(),
			timestamp: turn.endedAt,
			source: 'error',
			text: turn.completed.error?.message ?? describeCrash(turn.completed.exit),
		});
	}
	return entries;
}

/**
 * The lifecycle fact one finished turn amounts to (MRC-10-01): the terminal state from the
 * outcome (an interrupted turn is `cancelled`, a crash `failed`), the identities, the provider
 * and model, the exit code and elapsed time, and the error's classification as the detail. The
 * run is the managed run when the turn had a lineage with one (recorded in the run journal),
 * else the process session at its start (recorded nowhere). Pure. No text of the turn is in it.
 */
export function buildTurnLifecycleFact(
	turn: RecordedTurn,
	detail: string | null = turn.completed.error?.type ?? null
): LifecycleFact {
	const sessionId = `${turn.agentId}-ai-${turn.tabId}`;
	const managedRunId = turn.lineage?.identity.runId ?? null;
	return {
		surface: 'headless-turn',
		state: lifecycleStateOf(turn.completed.outcome),
		at: turn.endedAt,
		sessionId,
		agentId: turn.agentId,
		tabId: turn.tabId,
		provider: turn.assembled.settings.provider,
		model: turn.assembled.settings.model ?? null,
		providerSessionId: turn.completed.sessionId ?? null,
		runId: managedRunId ?? `${sessionId}@${turn.startedAt}`,
		record: managedRunId ? 'journal' : 'none',
		ledgerStatus: turn.completed.outcome,
		exitCode: turn.completed.exit.exitCode ?? null,
		durationMs: Math.max(0, turn.endedAt - turn.startedAt),
		detail,
		...(turn.lineage ? { lineage: turn.lineage } : {}),
		admission: turn.admission ?? null,
	};
}

export function createTurnRecorder(options: TurnRecorderOptions): TurnRecorder {
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.context };
	const historyWriter =
		options.historyWriter ??
		createHistoryWriter({
			paths: options.paths,
			...(options.fence ? { fence: options.fence } : {}),
		});
	const statsRecorder =
		options.statsRecorder ??
		createStatsRecorder({
			paths: options.paths,
			loadSqlite: options.loadSqlite,
			...(options.fence ? { fence: options.fence } : {}),
			// The same gate the desktop's stats writers use: collected unless explicitly turned off.
			isEnabled: () => readStatsCollectionEnabled(options.paths.settingsFile),
		});

	/** The projection hears every turn, whatever became of its records. Never throws into the recorder. */
	const project = (turn: RecordedTurn, detail?: string): void => {
		if (!options.lifecycle) return;
		try {
			options.lifecycle.record(
				detail === undefined ? buildTurnLifecycleFact(turn) : buildTurnLifecycleFact(turn, detail)
			);
		} catch {
			// The projection is a consumer of the turn, not a condition of it.
		}
	};

	async function recordTurn(turn: RecordedTurn): Promise<TurnRecordResult> {
		// Detach attribution before the first writer yields to settings/receipt changes.
		turn = {
			...turn,
			scope: turn.scope && { ...turn.scope },
			nativeSessionBinding: turn.nativeSessionBinding && structuredClone(turn.nativeSessionBinding),
		};
		const agent = options.repository.getAgent(turn.agentId);
		const tab = options.repository.getTab(turn.agentId, turn.tabId);
		const missing = !agent
			? `No agent ${turn.agentId}.`
			: !tab
				? `No tab ${turn.tabId}.`
				: undefined;
		if (!agent || !tab) {
			const message = missing ?? 'Nothing to record against.';
			project(
				turn.writeGuard ? { ...turn, completed: { ...turn.completed, outcome: 'crashed' } } : turn,
				'not recorded: the agent or tab is gone'
			);
			return {
				transcript: { ok: false, error: { code: 'not-found', message, method: 'tabs.update' } },
				history: { ok: false, reason: 'not-recorded', message },
				stats: { ok: false, reason: 'failed', message },
			};
		}

		const transcript = await options.repository.appendTranscript(
			turn.agentId,
			turn.tabId,
			buildTurnTranscript(turn, ctx),
			...(turn.writeGuard ? [turn.writeGuard] : [])
		);

		// Reserve the repository mutation queue across the writers' own queues and
		// filesystem awaits. A prior CAS alone leaves a replacement race here.
		if (turn.writeGuard) {
			const guarded =
				transcript.ok && options.repository.withTabWriteGuard
					? await options.repository.withTabWriteGuard(turn.writeGuard, () =>
							recordOther(turn, transcript, agent, tab)
						)
					: { ok: false as const, error: { message: 'The original turn could not be recorded.' } };
			if (!guarded.ok) {
				const message = guarded.error.message;
				project({ ...turn, completed: { ...turn.completed, outcome: 'crashed' } }, message);
				return {
					transcript: transcript.ok
						? { ok: false, error: { code: 'rejected', message, method: 'tabs.update' } }
						: transcript,
					history: { ok: false, reason: 'not-recorded', message },
					stats: { ok: false, reason: 'failed', message },
				};
			}
			project(turn);
			return guarded.value;
		}
		const result = await recordOther(turn, transcript, agent, tab);
		project(turn);
		return result;
	}

	async function recordOther(
		turn: RecordedTurn,
		transcript: ClientResult<void>,
		agent: AgentRecord,
		tab: AITabRecord
	): Promise<TurnRecordResult> {
		const { completed } = turn;
		// The provider the turn ran under, frozen at send: the agent may have swapped since.
		const provider = turn.assembled.settings.provider;
		const finished =
			completed.outcome === 'completed' || completed.outcome === 'completed-with-warning';
		const summary = summarizeAnswer(completed.answerText) || 'Completed successfully';
		let history: TurnRecordResult['history'];
		if (!finished) {
			history = { ok: false, reason: 'not-recorded', message: `The turn ${completed.outcome}.` };
		} else if (
			turn.nativeSessionBinding?.state === 'bound' &&
			(turn.nativeSessionBinding.provider !== provider ||
				turn.nativeSessionBinding.nativeSessionId !== completed.sessionId)
		) {
			history = {
				ok: false,
				reason: 'not-recorded',
				message: 'Native session identity mismatch.',
			};
		} else if (tab.saveToHistory === false) {
			history = {
				ok: false,
				reason: 'not-recorded',
				message: 'The tab does not save to History.',
			};
		} else {
			const context = completed.usage
				? estimateContextUsage(completed.usage, provider as ToolType)
				: null;
			const entry: HistoryEntry = {
				id: ctx.newId(),
				type: 'USER',
				timestamp: turn.endedAt,
				summary,
				...(completed.answerText ? { fullResponse: completed.answerText } : {}),
				...(completed.sessionId ? { agentSessionId: completed.sessionId } : {}),
				sessionName:
					tab.name || (completed.sessionId ? formatSessionId(completed.sessionId) : undefined),
				projectPath: turn.scope?.projectPath ?? agent.cwd ?? '',
				...(provider === 'grok'
					? {
							nativeSessionBinding: structuredClone(
								turn.nativeSessionBinding ?? {
									version: 1,
									state: 'unknown',
									reason: 'unobserved',
								}
							),
						}
					: {}),
				sessionId: agent.id,
				tabId: tab.id,
				...(context !== null ? { contextUsage: context } : {}),
				...(completed.usage ? { usageStats: completed.usage } : {}),
				success: true,
				elapsedTimeMs: turn.endedAt - turn.startedAt,
			};
			history = await historyWriter.append(agent.id, entry);
		}

		const stats = await statsRecorder.recordQuery({
			sessionId: agent.id,
			agentType: provider,
			source: 'user',
			startTime: turn.startedAt,
			duration: turn.endedAt - turn.startedAt,
			projectPath: turn.scope?.projectPath ?? agent.cwd,
			tabId: tab.id,
			isRemote: turn.scope?.isRemote ?? sshRecordOf(agent.sessionSshRemoteConfig)?.enabled === true,
			isWorktree:
				turn.scope?.isWorktree ??
				(typeof agent.parentSessionId === 'string' && agent.parentSessionId !== ''),
			...usageStatsToTurnFields(completed.usage),
		});

		return { transcript, history, stats };
	}

	return { recordTurn };
}
