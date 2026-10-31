/**
 * What the runtime writes when a turn ends: transcript, History, usage.
 *
 * Real repository, real History writer, real temp directory. The usage recorder is a spy where
 * the question is what row it is asked to write (`stats.test.ts` covers the row itself), and
 * the real one where the question is what happens when SQLite is not there.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';

vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
}));

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userData) } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { HistoryManager } from '../../../../main/history-manager';
import { createAgentRepository } from '../../../../shared/maestro-lib/agents/repository';
import {
	DEFAULT_TAB_DEFAULTS,
	type RuleContext,
} from '../../../../shared/maestro-lib/agents/rules';
import { createEventBus } from '../../../../shared/maestro-lib/client/event-bus';
import { resolveMaestroPaths } from '../../../../shared/maestro-lib/paths/resolve';
import type { MaestroPaths } from '../../../../shared/maestro-lib/paths/resolve';
import { transcriptOf } from '../../../../shared/maestro-lib/store/transcript';
import type {
	LifecycleEventSink,
	LifecycleFact,
} from '../../../../shared/maestro-lib/managed/events';
import {
	buildTurnLifecycleFact,
	buildTurnTranscript,
	buildUserTranscriptEntry,
	createTurnRecorder,
	type RecordedTurn,
} from '../../../../shared/maestro-lib/turns/record-turn';
import type { StatsRecorder } from '../../../../shared/maestro-lib/turns/stats';
import type { TurnExit } from '../../../../shared/maestro-lib/run/start-turn';
import type { QueryEvent } from '../../../../shared/stats-types';

const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

function context(): RuleContext {
	let id = 0;
	return { newId: () => `id-${++id}`, now: () => 1_000, random: () => 0 };
}

const USAGE = {
	inputTokens: 1000,
	outputTokens: 250,
	cacheReadInputTokens: 900,
	cacheCreationInputTokens: 80,
	totalCostUsd: 0.42,
	contextWindow: 200_000,
};

const CLEAN_EXIT: TurnExit = {
	exitCode: 0,
	signal: null,
	interrupted: false,
	stderrText: '',
	stdoutText: '',
	droppedOutputBytes: 0,
};

function turn(overrides: Partial<RecordedTurn> = {}): RecordedTurn {
	return {
		agentId: 'a1',
		tabId: 't1',
		assembled: {
			entry: { text: 'fix the login bug' },
			settings: { provider: 'claude-code', model: 'opus', effort: 'high' },
		},
		completed: {
			outcome: 'completed',
			answerText: 'Fixed the login bug in the session handler. Tests pass.',
			sessionId: 'abcd1234-0000-4000-8000-000000000000',
			usage: USAGE,
			error: undefined,
			exit: CLEAN_EXIT,
		},
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_004_200,
		...overrides,
	};
}

describe('turn records', () => {
	let paths: MaestroPaths;
	let statsEvents: Array<Omit<QueryEvent, 'id'>>;
	let statsRecorder: StatsRecorder;

	const seed = (extraAgent: Record<string, unknown> = {}, extraTab: Record<string, unknown> = {}) =>
		fs.writeFileSync(
			paths.sessionsFile,
			confText({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: '/work/a1',
						aiTabs: [{ id: 't1', name: 'Login work', logs: [], ...extraTab }],
						activeTabId: 't1',
						...extraAgent,
					},
				],
			})
		);

	async function recorder(
		options: {
			statsRecorder?: StatsRecorder;
			loadSqlite?: () => never;
			lifecycle?: LifecycleEventSink;
		} = {}
	) {
		const repository = createAgentRepository({
			paths,
			bus: createEventBus('[test]'),
			context: context(),
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
		});
		const loaded = await repository.load();
		if (!loaded.ok) throw new Error(loaded.failure.message);
		return {
			repository,
			recorder: createTurnRecorder({
				paths,
				repository,
				loadSqlite:
					options.loadSqlite ??
					(() => {
						throw new Error('unused');
					}),
				context: context(),
				// With a loader given, the real recorder runs; otherwise the spy.
				...(options.loadSqlite ? {} : { statsRecorder }),
				...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
			}),
		};
	}

	beforeEach(() => {
		const scratch = path.join(process.cwd(), 'tmp');
		fs.mkdirSync(scratch, { recursive: true });
		userData = fs.mkdtempSync(path.join(scratch, 'record-turn-test-'));
		paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userData } });
		statsEvents = [];
		statsRecorder = {
			startAutoRun: vi.fn<StatsRecorder['startAutoRun']>(),
			recordAutoTask: vi.fn<StatsRecorder['recordAutoTask']>(),
			endAutoRun: vi.fn<StatsRecorder['endAutoRun']>(),
			recordQuery: async (event) => {
				statsEvents.push(event);
				return { ok: true, id: 'stat-1' };
			},
		};
		seed();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(userData, { recursive: true, force: true });
	});

	it('appends the user message and the answer to the tab, stamped with the settings the turn ran under', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.transcript.ok).toBe(true);
		expect(transcriptOf(repository.getTab('a1', 't1')!).map(({ id, ...rest }) => rest)).toEqual([
			{ timestamp: 1_700_000_000_000, source: 'user', text: 'fix the login bug', delivered: true },
			{
				timestamp: 1_700_000_004_200,
				source: 'stdout',
				text: 'Fixed the login bug in the session handler. Tests pass.',
				turnModel: 'opus',
				turnEffort: 'high',
			},
		]);
		// The desktop reads the same file.
		const onDisk = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8'));
		expect(onDisk.sessions[0].aiTabs[0].logs).toHaveLength(2);
	});

	it('records usage under the provider the turn was sent to, not the one the agent has now', async () => {
		const { recorder: records } = await recorder();
		await records.recordTurn(
			turn({
				assembled: { entry: { text: 'hi' }, settings: { provider: 'codex' } },
			})
		);
		expect(statsEvents[0]?.agentType).toBe('codex');
	});

	it.each([false, true])(
		'detaches original Grok scope and binding before recording (remote/worktree=%s)',
		async (remote) => {
			const scope = { projectPath: '/original/project', isRemote: remote, isWorktree: remote };
			const binding = {
				version: 1 as const,
				state: 'bound' as const,
				provider: 'grok' as const,
				nativeSessionId: turn().completed.sessionId!,
				accountRef: 'grok-account:original',
				host: { kind: remote ? ('ssh' as const) : ('local' as const), identity: 'original-host' },
				cwd: scope.projectPath,
			};
			const originalBinding = structuredClone(binding);
			seed({
				toolType: 'codex',
				cwd: '/changed/project',
				parentSessionId: remote ? '' : 'parent',
				sessionSshRemoteConfig: { enabled: !remote, remoteId: 'changed-host' },
			});
			const { recorder: records, repository } = await recorder();
			const append = repository.appendTranscript.bind(repository);
			vi.spyOn(repository, 'appendTranscript').mockImplementationOnce(async (...args) => {
				scope.projectPath = '/mutated/project';
				scope.isRemote = !remote;
				scope.isWorktree = !remote;
				binding.host.identity = 'mutated-host';
				binding.nativeSessionId = 'mutated-native';
				return append(...args);
			});
			const result = await records.recordTurn(
				turn({
					scope,
					nativeSessionBinding: binding,
					assembled: {
						entry: { text: 'hi' },
						settings: { provider: 'grok', model: 'original-model' },
					},
				})
			);
			expect(result.history).toMatchObject({ ok: true });
			const [entry] = await new HistoryManager().getEntries('a1');
			expect(entry).toMatchObject({
				projectPath: '/original/project',
				nativeSessionBinding: originalBinding,
			});
			expect(statsEvents[0]).toMatchObject({
				agentType: 'grok',
				projectPath: '/original/project',
				isRemote: remote,
				isWorktree: remote,
			});
			expect(transcriptOf(repository.getTab('a1', 't1')!).at(-1)).toMatchObject({
				turnModel: 'original-model',
			});
		}
	);

	it('rejects an old transcript queued behind a successor without changing prior History or usage', async () => {
		seed(
			{ toolType: 'grok' },
			{
				agentSessionId: turn().completed.sessionId,
				runtimeTurnId: 'original',
				usageStats: USAGE,
			}
		);
		const { recorder: records, repository } = await recorder();
		const original = turn({ assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } } });
		await records.recordTurn(original);
		const historyFile = path.join(paths.historyDir, 'a1.jsonl');
		const historyBefore = fs.readFileSync(historyFile, 'utf-8');
		const statsBefore = structuredClone(statsEvents);
		const logsBefore = structuredClone(repository.getTab('a1', 't1')!.logs);
		const incarnation = repository.captureTabIncarnation('a1', 't1');
		const writeGuard = () =>
			incarnation() && repository.getTab('a1', 't1')?.runtimeTurnId === 'original';
		const successorEntry = buildUserTranscriptEntry({ text: 'successor' }, 2_000, context());
		// Both calls enter with the original owner; the actual queued mutation sees the successor.
		const successor = repository.beginTurn('a1', 't1', {
			turnId: 'successor',
			provider: 'grok',
			consumedMergedContext: false,
			userEntry: successorEntry,
		});
		expect(writeGuard()).toBe(true);
		const recording = records.recordTurn({ ...original, writeGuard });
		expect((await successor).ok).toBe(true);
		const result = await recording;
		expect(result.transcript).toMatchObject({ ok: false, error: { code: 'rejected' } });
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(result.stats).toMatchObject({ ok: false });
		expect(fs.readFileSync(historyFile, 'utf-8')).toBe(historyBefore);
		expect(statsEvents).toEqual(statsBefore);
		const stored = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8')).sessions[0].aiTabs[0];
		expect(stored).toMatchObject({
			runtimeTurnId: 'successor',
			agentSessionId: original.completed.sessionId,
			usageStats: USAGE,
		});
		expect(stored.logs).toEqual([...logsBefore!, successorEntry]);
	});

	it('holds a successor outside the real History append and keeps the original scope through stats', async () => {
		seed(
			{ toolType: 'grok' },
			{
				agentSessionId: turn().completed.sessionId,
				runtimeTurnId: 'original',
			}
		);
		const { recorder: records, repository } = await recorder();
		const incarnation = repository.captureTabIncarnation('a1', 't1');
		const writeGuard = () =>
			incarnation() && repository.getTab('a1', 't1')?.runtimeTurnId === 'original';
		expect(
			(
				await repository.updateAgent('a1', {
					provider: 'codex',
					cwd: '/changed/project',
					env: { GROK_HOME: '/changed/account' },
				})
			).ok
		).toBe(true);
		const recordQuery = statsRecorder.recordQuery;
		statsRecorder.recordQuery = async (event) => {
			// The ownership reservation must still cover the actual usage mutation.
			expect(writeGuard()).toBe(true);
			return recordQuery(event);
		};
		const blocked = Promise.withResolvers<void>();
		const writing = Promise.withResolvers<void>();
		const append = fsp.appendFile;
		vi.spyOn(fsp, 'appendFile').mockImplementationOnce(async (...args) => {
			writing.resolve();
			await blocked.promise;
			return append(...args);
		});
		const recording = records.recordTurn(
			turn({
				writeGuard,
				scope: { projectPath: '/original/project', isRemote: true, isWorktree: true },
				assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } },
			})
		);
		await writing.promise;
		let successorCommitted = false;
		const successor = repository
			.beginTurn('a1', 't1', {
				turnId: 'successor',
				provider: 'codex',
				consumedMergedContext: false,
				userEntry: buildUserTranscriptEntry({ text: 'successor' }, 2_000, context()),
			})
			.then((result) => {
				successorCommitted = true;
				return result;
			});
		try {
			await Promise.resolve();
			expect(successorCommitted).toBe(false);
			expect(repository.getTab('a1', 't1')?.runtimeTurnId).toBe('original');
			expect(statsEvents).toEqual([]);
		} finally {
			blocked.resolve();
		}
		expect((await recording).history.ok).toBe(true);
		expect((await successor).ok).toBe(true);
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry).toMatchObject({
			agentSessionId: turn().completed.sessionId,
			projectPath: '/original/project',
			usageStats: USAGE,
		});
		expect(statsEvents).toEqual([
			expect.objectContaining({
				agentType: 'grok',
				projectPath: '/original/project',
				isRemote: true,
				isWorktree: true,
			}),
		]);
		const stored = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8')).sessions[0].aiTabs[0];
		expect(stored.runtimeTurnId).toBe('successor');
		expect(stored.providerSessions.grok.agentSessionId).toBe(turn().completed.sessionId);
		expect(stored.logs.map((entry: { text: string }) => entry.text)).toEqual([
			'hi',
			turn().completed.answerText,
			'successor',
		]);
	});

	it('records unobserved Grok provenance without borrowing the current account or host', async () => {
		seed({
			toolType: 'grok',
			customEnvVars: { GROK_HOME: '/new/account' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'new-host' },
		});
		const { recorder: records } = await recorder();
		await records.recordTurn(
			turn({
				assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } },
			})
		);
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry.nativeSessionBinding).toEqual({
			version: 1,
			state: 'unknown',
			reason: 'unobserved',
		});
	});

	it.each(['different-native', undefined])(
		'refuses successful History for a mismatched end ID (%s)',
		async (sessionId) => {
			const { recorder: records } = await recorder();
			const result = await records.recordTurn(
				turn({
					assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } },
					completed: { ...turn().completed, sessionId },
					nativeSessionBinding: {
						version: 1,
						state: 'bound',
						provider: 'grok',
						nativeSessionId: 'original-native',
						accountRef: 'grok-account:original',
						host: { kind: 'local', identity: 'original-host' },
						cwd: '/original/project',
					},
				})
			);
			expect(result.history).toEqual({
				ok: false,
				reason: 'not-recorded',
				message: 'Native session identity mismatch.',
			});
			expect(fs.existsSync(path.join(paths.historyDir, 'a1.jsonl'))).toBe(false);
		}
	);

	it('records a USER history entry the desktop reads, built from the answer', async () => {
		const { recorder: records } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.history).toMatchObject({ ok: true });
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry).toEqual({
			id: 'id-3',
			type: 'USER',
			timestamp: 1_700_000_004_200,
			summary: 'Fixed the login bug in the session handler.',
			fullResponse: 'Fixed the login bug in the session handler. Tests pass.',
			agentSessionId: 'abcd1234-0000-4000-8000-000000000000',
			sessionName: 'Login work',
			projectPath: '/work/a1',
			sessionId: 'a1',
			tabId: 't1',
			contextUsage: 1,
			usageStats: USAGE,
			success: true,
			elapsedTimeMs: 4200,
		});
	});

	it('names an unnamed tab the way the tab strip does', async () => {
		seed({}, { name: null });
		const { recorder: records } = await recorder();
		await records.recordTurn(turn());
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry.sessionName).toBe('ABCD1234');
	});

	it('records the turn in usage with the per-turn token deltas and the agent facts', async () => {
		seed({ parentSessionId: 'parent', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });
		const { recorder: records } = await recorder();
		await records.recordTurn(turn());
		expect(statsEvents).toEqual([
			{
				sessionId: 'a1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 1_700_000_000_000,
				duration: 4200,
				projectPath: '/work/a1',
				tabId: 't1',
				isRemote: true,
				isWorktree: true,
				inputTokens: 1000,
				outputTokens: 250,
				cacheReadTokens: 900,
				cacheCreationTokens: 80,
				costUsd: 0.42,
			},
		]);
	});

	it('writes no History entry when the tab does not save to History, but still the transcript and usage', async () => {
		seed({}, { saveToHistory: false });
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(fs.existsSync(path.join(paths.historyDir, 'a1.jsonl'))).toBe(false);
		expect(repository.getTab('a1', 't1')?.logs).toHaveLength(2);
		expect(statsEvents).toHaveLength(1);
	});

	it('records an interrupted turn as the partial answer and usage, with no History entry', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(
			turn({
				completed: {
					...turn().completed,
					outcome: 'interrupted',
					answerText: 'Looking at the handler',
					exit: { ...CLEAN_EXIT, exitCode: null, signal: 'SIGINT', interrupted: true },
				},
			})
		);
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(transcriptOf(repository.getTab('a1', 't1')!).map((e) => e.source)).toEqual([
			'user',
			'stdout',
		]);
		expect(statsEvents).toHaveLength(1);
	});

	it('adds the provider error to the transcript of a crashed turn, and no History entry', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(
			turn({
				completed: {
					...turn().completed,
					outcome: 'crashed',
					answerText: undefined,
					usage: undefined,
					error: {
						type: 'auth_expired',
						message: 'Authentication failed. Sign in again.',
						recoverable: true,
						agentId: 'claude-code',
						timestamp: 1,
					},
					exit: { ...CLEAN_EXIT, exitCode: 1 },
				},
			})
		);
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		const entries = transcriptOf(repository.getTab('a1', 't1')!);
		expect(entries.map((e) => [e.source, e.text])).toEqual([
			['user', 'fix the login bug'],
			['error', 'Authentication failed. Sign in again.'],
		]);
		// No usage reported: the columns stay NULL rather than becoming 0.
		expect(statsEvents[0]).not.toHaveProperty('inputTokens');
	});

	describe('lifecycle projection (MRC-10-01)', () => {
		const sink = () => {
			const facts: LifecycleFact[] = [];
			const lifecycle: LifecycleEventSink = {
				record: (fact) => {
					facts.push(fact);
					return [];
				},
			};
			return { facts, lifecycle };
		};

		it('reports a finished turn as one metadata-only fact, after the records, with no text of the turn', async () => {
			const { facts, lifecycle } = sink();
			const { recorder: records } = await recorder({ lifecycle });
			const result = await records.recordTurn(turn());
			expect(result.transcript.ok).toBe(true);
			expect(facts).toEqual([
				{
					surface: 'headless-turn',
					state: 'completed',
					at: 1_700_000_004_200,
					sessionId: 'a1-ai-t1',
					agentId: 'a1',
					tabId: 't1',
					provider: 'claude-code',
					model: 'opus',
					providerSessionId: 'abcd1234-0000-4000-8000-000000000000',
					runId: 'a1-ai-t1@1700000000000',
					record: 'none',
					ledgerStatus: 'completed',
					exitCode: 0,
					durationMs: 4200,
					detail: null,
					admission: null,
				},
			]);
			const serialized = JSON.stringify(facts);
			expect(serialized).not.toContain('fix the login bug');
			expect(serialized).not.toContain('Fixed the login bug');
		});

		it('names the managed run from the lineage and carries the lease it was admitted on', async () => {
			const { facts, lifecycle } = sink();
			const { recorder: records } = await recorder({ lifecycle });
			const lineage = {
				identity: {
					requestId: 'req-1',
					idempotencyKey: 'key-1',
					attemptId: 'attempt-1',
					runId: 'run-1',
					rootRunId: 'run-1',
					parentRunId: null,
				},
				traceId: 'trace-1',
				workflow: null,
				delegation: { chain: [], grantRef: null },
				actor: { kind: 'human' as const, id: 'alice' },
				policyRevision: 3,
			};
			const admission = {
				leaseId: 'lease-1',
				authorityId: 'auth-1',
				requestDigest: 'digest-1',
				policyRevision: 3,
				decision: null,
			};
			await records.recordTurn(turn({ lineage, admission }));
			expect(facts[0]).toMatchObject({ runId: 'run-1', record: 'journal', lineage, admission });
		});

		it('folds an interrupted turn to cancelled and a crash to failed with the error classification', () => {
			const interrupted = buildTurnLifecycleFact(
				turn({
					completed: {
						...turn().completed,
						outcome: 'interrupted',
						exit: { ...CLEAN_EXIT, exitCode: null, signal: 'SIGINT', interrupted: true },
					},
				})
			);
			expect(interrupted).toMatchObject({
				state: 'cancelled',
				ledgerStatus: 'interrupted',
				exitCode: null,
			});
			const crashed = buildTurnLifecycleFact(
				turn({
					completed: {
						...turn().completed,
						outcome: 'crashed',
						answerText: undefined,
						error: {
							type: 'auth_expired',
							message: 'Authentication failed. Sign in again.',
							recoverable: true,
							agentId: 'claude-code',
							timestamp: 1,
						},
						exit: { ...CLEAN_EXIT, exitCode: 1 },
					},
				})
			);
			expect(crashed).toMatchObject({ state: 'failed', exitCode: 1, detail: 'auth_expired' });
			expect(JSON.stringify(crashed)).not.toContain('Sign in again');
		});

		it('still reports a turn whose agent or tab is gone, saying it was not recorded', async () => {
			const { facts, lifecycle } = sink();
			const { recorder: records } = await recorder({ lifecycle });
			await records.recordTurn(turn({ tabId: 'gone' }));
			expect(facts).toEqual([
				expect.objectContaining({
					tabId: 'gone',
					state: 'completed',
					detail: 'not recorded: the agent or tab is gone',
				}),
			]);
		});

		it('keeps the records when the sink throws, and reports nothing without one', async () => {
			const { recorder: throwing } = await recorder({
				lifecycle: {
					record: () => {
						throw new Error('sink down');
					},
				},
			});
			const result = await throwing.recordTurn(turn());
			expect(result.transcript.ok).toBe(true);
			expect(result.history).toMatchObject({ ok: true });
			const { recorder: plain } = await recorder();
			await expect(plain.recordTurn(turn())).resolves.toMatchObject({ history: { ok: true } });
		});
	});

	describe('buildTurnTranscript', () => {
		const ctx = context();

		it('words an unclassified crash from the exit facts', () => {
			const crash = (exit: Partial<TurnExit>) =>
				buildTurnTranscript(
					turn({
						completed: {
							...turn().completed,
							outcome: 'crashed',
							answerText: undefined,
							exit: { ...CLEAN_EXIT, ...exit },
						},
					}),
					ctx
				).at(-1)!.text;
			expect(crash({ exitCode: 2, stderrText: 'boom\n' })).toBe(
				'The agent exited with code 2.\nboom'
			);
			expect(crash({ exitCode: null, signal: 'SIGKILL' })).toBe(
				'The agent was stopped by SIGKILL.'
			);
			expect(crash({ spawnError: new Error('ENOENT') })).toBe(
				'The agent could not be started: ENOENT'
			);
		});

		it('carries what the composer sent: images, the read-only flag, and the command', () => {
			const [user] = buildTurnTranscript(
				turn({
					assembled: {
						settings: { provider: 'claude-code' },
						entry: {
							text: '/commit',
							images: ['maestro-image://store/a.png'],
							readOnly: true,
							aiCommand: { command: '/commit' },
						},
					},
				}),
				ctx
			);
			expect(user).toMatchObject({
				images: ['maestro-image://store/a.png'],
				readOnly: true,
				aiCommand: { command: '/commit', description: '' },
			});
		});

		it('starts at the answer when the runtime already wrote the message', () => {
			const entries = buildTurnTranscript(turn({ userEntryWritten: true }), ctx);
			expect(entries.map((e) => e.source)).toEqual(['stdout']);
		});

		it('builds the same user entry the recorder would, from the same inputs', () => {
			const sent = { text: 'fix it', readOnly: true as const };
			const entry = buildUserTranscriptEntry(sent, 42, ctx);
			expect(entry).toMatchObject({
				source: 'user',
				text: 'fix it',
				timestamp: 42,
				delivered: true,
				readOnly: true,
			});
		});

		it('leaves the pills off an answer that ran under the agent defaults, and writes no answer for an empty one', () => {
			const entries = buildTurnTranscript(
				turn({
					assembled: { entry: { text: 'hi' }, settings: { provider: 'claude-code' } },
					completed: { ...turn().completed, answerText: '  ' },
				}),
				ctx
			);
			expect(entries.map((e) => e.source)).toEqual(['user']);
			const [, answer] = buildTurnTranscript(
				turn({ assembled: { entry: { text: 'hi' }, settings: { provider: 'claude-code' } } }),
				ctx
			);
			expect(answer).not.toHaveProperty('turnModel');
			expect(answer).not.toHaveProperty('turnEffort');
		});
	});

	describe('when a record cannot be written', () => {
		it('keeps the turn, the transcript, and History when SQLite will not load, and says so once', async () => {
			fs.writeFileSync(paths.statsFile, '');
			const { recorder: records, repository } = await recorder({
				loadSqlite: () => {
					throw new Error("Maestro's database module cannot be loaded.");
				},
			});
			const result = await records.recordTurn(turn());
			expect(result.stats).toMatchObject({
				ok: false,
				reason: 'unavailable',
				message: "Maestro's database module cannot be loaded.",
			});
			expect(result.transcript.ok).toBe(true);
			expect(result.history).toMatchObject({ ok: true });
			expect(repository.getTab('a1', 't1')?.logs).toHaveLength(2);
			expect(await new HistoryManager().getEntries('a1')).toHaveLength(1);
		});

		it('still writes usage when the History file is on the legacy format', async () => {
			fs.mkdirSync(paths.historyDir, { recursive: true });
			fs.writeFileSync(path.join(paths.historyDir, 'a1.json'), JSON.stringify({ entries: [] }));
			const { recorder: records } = await recorder();
			const result = await records.recordTurn(turn());
			expect(result.history).toMatchObject({ ok: false, reason: 'legacy-format' });
			expect(result.transcript.ok).toBe(true);
			expect(statsEvents).toHaveLength(1);
		});

		it('says what is missing for an agent or tab that is gone, and writes nothing', async () => {
			const { recorder: records } = await recorder();
			const noTab = await records.recordTurn(turn({ tabId: 'gone' }));
			expect(noTab.transcript).toMatchObject({ ok: false, error: { code: 'not-found' } });
			const noAgent = await records.recordTurn(turn({ agentId: 'gone' }));
			expect(noAgent.history).toMatchObject({ ok: false, reason: 'not-recorded' });
			expect(statsEvents).toEqual([]);
			expect(fs.existsSync(paths.historyDir)).toBe(false);
		});
	});
});
