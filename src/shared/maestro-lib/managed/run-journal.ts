/**
 * The run journal: the durable record of every managed run this installation
 * accepted, what was tried for it, and how each try ended.
 *
 * `<userData>/maestro-managed-runs.json`, written through `writeStoreDocument`
 * (one atomic write at a time per file, schema-guarded) so it survives a
 * crash mid-write the same way the agent stores do. A logical run is one
 * idempotency key; it holds attempts, and each attempt moves through
 * `queued`, `dispatched`, then `terminal` or `unknown`.
 *
 * Rules the journal keeps, so no operation has to:
 *
 * - **A receipt is not an effect.** `submit` records that the host accepted
 *   the work; `markDispatched` records that a process exists; only
 *   `markTerminal` says how it ended. A caller that holds a receipt and no
 *   terminal record does not know whether anything ran.
 * - **Idempotency is immutable.** The same key with the same content digest
 *   is the same run and is `replayed`, never run twice; the same key with
 *   different content is a `conflict`, never a silent overwrite.
 * - **No blind resend after uncertain delivery.** A run whose latest attempt
 *   is `unknown` (the host restarted while it was dispatched, a receipt was
 *   lost) answers `unknown` to a resubmit. Someone has to look.
 * - **Cancellation has one owner.** The first principal to ask is recorded;
 *   a later request is honored but does not take the record over. A terminal
 *   run answers `already-terminal`, an unknown one `unknown`.
 *
 * On load, an attempt still marked `dispatched` whose run no process
 * registry remembers becomes `unknown`: the host cannot say what became of
 * it. One still `queued` becomes `failed` (the in-memory queue did not
 * survive, and nothing was started), which a new attempt may follow.
 */
import * as path from 'node:path';

import type { MaestroPaths } from '../paths/resolve';
import { readStoreDocument, writeStoreDocument, STORE_SCHEMA_KEY } from '../store/io';
import type {
	ManagedControlOutcome,
	ManagedPrincipalRef,
	ManagedRunRecord,
	ManagedRunState,
} from './types';

export const MANAGED_RUN_JOURNAL_FILE_NAME = 'maestro-managed-runs.json';

export function managedRunJournalPath(paths: Pick<MaestroPaths, 'userDataDir'>): string {
	return path.join(paths.userDataDir, MANAGED_RUN_JOURNAL_FILE_NAME);
}

export type JournalAttemptPhase = 'queued' | 'dispatched' | 'terminal' | 'unknown';
export type JournalTerminalOutcome = 'completed' | 'failed' | 'cancelled';

export interface JournalAttempt {
	attemptId: string;
	requestId: string;
	queuedAt: string;
	phase: JournalAttemptPhase;
	dispatchedAt: string | null;
	pid: number | null;
	leaseId: string | null;
	endedAt: string | null;
	outcome: JournalTerminalOutcome | null;
	detail: string | null;
}

export interface JournalCancellation {
	owner: ManagedPrincipalRef;
	kind: 'cancel' | 'interrupt';
	requestedAt: string;
	/** Later requesters, in order. They did not take ownership. */
	alsoRequestedBy: ManagedPrincipalRef[];
}

export interface JournalRun {
	runId: string;
	rootRunId: string;
	parentRunId: string | null;
	idempotencyKey: string;
	agentId: string;
	tabId: string;
	providerId: string;
	providerSessionId: string | null;
	contentSha256: string;
	resourceIds: string[];
	actor: ManagedPrincipalRef;
	traceId: string;
	submittedAt: string;
	state: ManagedRunState;
	attempts: JournalAttempt[];
	cancellation: JournalCancellation | null;
}

export interface RunJournalDocument {
	[STORE_SCHEMA_KEY]: number;
	runs: JournalRun[];
}

export interface SubmitRecord {
	idempotencyKey: string;
	requestId: string;
	attemptId: string;
	/** The run id the peer named, or null to let the journal mint one. */
	runId: string | null;
	rootRunId: string | null;
	parentRunId: string | null;
	agentId: string;
	tabId: string;
	providerId: string;
	contentSha256: string;
	resourceIds: readonly string[];
	actor: ManagedPrincipalRef;
	traceId: string;
}

export type SubmitDisposition =
	| { disposition: 'accepted'; run: JournalRun; attempt: JournalAttempt }
	| { disposition: 'replayed'; run: JournalRun }
	| { disposition: 'conflict'; run: JournalRun }
	| { disposition: 'unknown'; run: JournalRun };

export interface JournalPage {
	items: JournalRun[];
	nextCursor: string | null;
}

export type JournalLoad =
	| { ok: true; runs: number; recovered: { unknown: number; failed: number } }
	| { ok: false; reason: 'corrupt' | 'unreadable'; file: string; message: string };

export interface RunJournal {
	readonly file: string;
	/** Read the file and recover attempts the restart interrupted. Once, before anything else. */
	load(options?: { liveRunIds?: readonly string[] }): Promise<JournalLoad>;
	submit(input: SubmitRecord): Promise<SubmitDisposition>;
	markDispatched(
		runId: string,
		attemptId: string,
		info: { pid: number | null; leaseId: string | null }
	): Promise<JournalRun | null>;
	markTerminal(
		runId: string,
		attemptId: string,
		info: { outcome: JournalTerminalOutcome; detail?: string; providerSessionId?: string | null }
	): Promise<JournalRun | null>;
	markUnknown(runId: string, attemptId: string, detail: string): Promise<JournalRun | null>;
	requestCancel(
		runId: string,
		request: { owner: ManagedPrincipalRef; kind: 'cancel' | 'interrupt' }
	): Promise<{ outcome: ManagedControlOutcome; run: JournalRun | null }>;
	get(runId: string): JournalRun | null;
	/** Newest first. `cursor` is the last `runId` of the previous page. */
	list(options: { agentId?: string; cursor: string | null; limit: number }): JournalPage;
	/** Every run that is not terminal, for a host that reports work in flight. */
	open(): JournalRun[];
}

export interface RunJournalDeps {
	file: string;
	now(): number;
	newId(): string;
	/** How many runs to keep. Oldest terminal runs go first; nothing open is ever dropped. */
	maxRuns?: number;
}

const DEFAULT_MAX_RUNS = 2_000;
const MAX_PAGE = 500;

const TERMINAL: readonly ManagedRunState[] = ['completed', 'failed', 'cancelled'];
export const isTerminalRunState = (state: ManagedRunState): boolean => TERMINAL.includes(state);

export function journalRunRecord(run: JournalRun): ManagedRunRecord {
	const latest = run.attempts[run.attempts.length - 1];
	return {
		runId: run.runId,
		rootRunId: run.rootRunId,
		parentRunId: run.parentRunId,
		attemptId: latest?.attemptId ?? '',
		agentId: run.agentId,
		providerSessionId: run.providerSessionId,
		state: run.state,
	};
}

function emptyDocument(): RunJournalDocument {
	return { [STORE_SCHEMA_KEY]: 1, runs: [] };
}

function latestAttempt(run: JournalRun): JournalAttempt | undefined {
	return run.attempts[run.attempts.length - 1];
}

function samePrincipal(a: ManagedPrincipalRef, b: ManagedPrincipalRef): boolean {
	return a.kind === b.kind && a.id === b.id;
}

export function createRunJournal(deps: RunJournalDeps): RunJournal {
	const maxRuns = deps.maxRuns ?? DEFAULT_MAX_RUNS;
	let doc: RunJournalDocument = emptyDocument();
	let loaded = false;
	const byKey = new Map<string, JournalRun>();
	const byId = new Map<string, JournalRun>();

	const iso = (): string => new Date(deps.now()).toISOString();

	function index(): void {
		byKey.clear();
		byId.clear();
		for (const run of doc.runs) {
			byKey.set(run.idempotencyKey, run);
			byId.set(run.runId, run);
		}
	}

	function trim(): void {
		if (doc.runs.length <= maxRuns) return;
		const keep: JournalRun[] = [];
		let excess = doc.runs.length - maxRuns;
		for (const run of doc.runs) {
			if (excess > 0 && isTerminalRunState(run.state)) {
				excess -= 1;
				continue;
			}
			keep.push(run);
		}
		doc.runs = keep;
		index();
	}

	async function persist(): Promise<void> {
		if (!loaded) throw new Error('The run journal was not loaded.');
		trim();
		await writeStoreDocument(deps.file, doc);
	}

	function requireLoaded(): void {
		if (!loaded) throw new Error('The run journal was not loaded.');
	}

	function attemptOf(runId: string, attemptId: string): [JournalRun, JournalAttempt] | null {
		const run = byId.get(runId);
		const attempt = run?.attempts.find((a) => a.attemptId === attemptId);
		return run && attempt ? [run, attempt] : null;
	}

	return {
		file: deps.file,

		async load(options = {}) {
			const read = await readStoreDocument<RunJournalDocument>(deps.file, (value) =>
				Array.isArray(value.runs) ? null : 'runs is not an array'
			);
			if (read.status === 'corrupt' || read.status === 'unreadable') {
				return { ok: false, reason: read.status, file: deps.file, message: read.reason };
			}
			doc = read.status === 'ok' ? read.data : emptyDocument();
			index();
			loaded = true;

			const live = new Set(options.liveRunIds ?? []);
			const recovered = { unknown: 0, failed: 0 };
			const at = iso();
			for (const run of doc.runs) {
				for (const attempt of run.attempts) {
					if (attempt.phase === 'dispatched' && !live.has(run.runId)) {
						attempt.phase = 'unknown';
						attempt.endedAt = at;
						attempt.detail = 'The host restarted while this attempt was dispatched.';
						run.state = 'unknown';
						recovered.unknown += 1;
					} else if (attempt.phase === 'queued') {
						attempt.phase = 'terminal';
						attempt.outcome = 'failed';
						attempt.endedAt = at;
						attempt.detail = 'The host restarted before this attempt was dispatched.';
						if (run.state === 'queued') run.state = 'failed';
						recovered.failed += 1;
					}
				}
			}
			if (recovered.unknown + recovered.failed > 0 || read.status === 'missing') await persist();
			return { ok: true, runs: doc.runs.length, recovered };
		},

		async submit(input) {
			requireLoaded();
			const existing = byKey.get(input.idempotencyKey);
			if (existing) {
				if (existing.contentSha256 !== input.contentSha256) {
					return { disposition: 'conflict', run: existing };
				}
				if (existing.state === 'unknown') return { disposition: 'unknown', run: existing };
				return { disposition: 'replayed', run: existing };
			}
			if (input.runId !== null && byId.has(input.runId)) {
				return { disposition: 'conflict', run: byId.get(input.runId) as JournalRun };
			}
			const runId = input.runId ?? deps.newId();
			const attempt: JournalAttempt = {
				attemptId: input.attemptId,
				requestId: input.requestId,
				queuedAt: iso(),
				phase: 'queued',
				dispatchedAt: null,
				pid: null,
				leaseId: null,
				endedAt: null,
				outcome: null,
				detail: null,
			};
			const run: JournalRun = {
				runId,
				rootRunId: input.rootRunId ?? runId,
				parentRunId: input.parentRunId,
				idempotencyKey: input.idempotencyKey,
				agentId: input.agentId,
				tabId: input.tabId,
				providerId: input.providerId,
				providerSessionId: null,
				contentSha256: input.contentSha256,
				resourceIds: [...input.resourceIds],
				actor: input.actor,
				traceId: input.traceId,
				submittedAt: attempt.queuedAt,
				state: 'queued',
				attempts: [attempt],
				cancellation: null,
			};
			doc.runs.push(run);
			byKey.set(run.idempotencyKey, run);
			byId.set(run.runId, run);
			await persist();
			return { disposition: 'accepted', run, attempt };
		},

		async markDispatched(runId, attemptId, info) {
			requireLoaded();
			const found = attemptOf(runId, attemptId);
			if (!found) return null;
			const [run, attempt] = found;
			if (attempt.phase !== 'queued') return run;
			attempt.phase = 'dispatched';
			attempt.dispatchedAt = iso();
			attempt.pid = info.pid;
			attempt.leaseId = info.leaseId;
			run.state = 'running';
			await persist();
			return run;
		},

		async markTerminal(runId, attemptId, info) {
			requireLoaded();
			const found = attemptOf(runId, attemptId);
			if (!found) return null;
			const [run, attempt] = found;
			if (attempt.phase === 'terminal') return run;
			attempt.phase = 'terminal';
			attempt.outcome = info.outcome;
			attempt.endedAt = iso();
			attempt.detail = info.detail ?? null;
			run.state = info.outcome;
			if (info.providerSessionId !== undefined) run.providerSessionId = info.providerSessionId;
			await persist();
			return run;
		},

		async markUnknown(runId, attemptId, detail) {
			requireLoaded();
			const found = attemptOf(runId, attemptId);
			if (!found) return null;
			const [run, attempt] = found;
			if (attempt.phase === 'terminal') return run;
			attempt.phase = 'unknown';
			attempt.endedAt = iso();
			attempt.detail = detail;
			run.state = 'unknown';
			await persist();
			return run;
		},

		async requestCancel(runId, request) {
			requireLoaded();
			const run = byId.get(runId);
			if (!run) return { outcome: 'unknown', run: null };
			if (isTerminalRunState(run.state)) return { outcome: 'already-terminal', run };
			if (run.state === 'unknown') return { outcome: 'unknown', run };
			if (run.cancellation === null) {
				run.cancellation = {
					owner: request.owner,
					kind: request.kind,
					requestedAt: iso(),
					alsoRequestedBy: [],
				};
			} else if (
				!samePrincipal(run.cancellation.owner, request.owner) &&
				!run.cancellation.alsoRequestedBy.some((p) => samePrincipal(p, request.owner))
			) {
				run.cancellation.alsoRequestedBy.push(request.owner);
			}
			await persist();
			return { outcome: 'requested', run };
		},

		get: (runId) => byId.get(runId) ?? null,

		list({ agentId, cursor, limit }) {
			requireLoaded();
			const size = Math.max(1, Math.min(limit, MAX_PAGE));
			const all = [...doc.runs].reverse().filter((run) => !agentId || run.agentId === agentId);
			const start = cursor === null ? 0 : all.findIndex((run) => run.runId === cursor) + 1;
			const items = all.slice(start, start + size);
			const last = items[items.length - 1];
			return {
				items,
				nextCursor: last && start + size < all.length ? last.runId : null,
			};
		},

		open: () => doc.runs.filter((run) => !isTerminalRunState(run.state)),
	};
}

/** The latest attempt's phase, for a caller that reports it. */
export function journalRunPhase(run: JournalRun): JournalAttemptPhase | null {
	return latestAttempt(run)?.phase ?? null;
}
