/**
 * The runtime's consults (XM-1 to XM-4): `ask` end to end with no desktop, over a fake provider.
 *
 * As in the group chat tests, a consult is a real process on a real pipe: the runtime plans the
 * real spawn and starts it through the real run layer, and only the command is swapped for the
 * fake agent. The runtime, its repository, and the target's consult tab are real and write to a
 * temp data directory, so what the tests read back is what a desktop would read.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	promptOf,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { CROSS_AGENT_ASK_SESSION_ID, CROSS_AGENT_ASK_TAB_ID } from '../../../crossAgentTypes';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import {
	FAKE_AGENT_PATH,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { runAgentTurn } from '../../turns/run-agent-turn';
import type { ClientResult, MaestroEvent } from '../../client/types';
import {
	createLocalHostAuthority,
	type AdmissionRequest,
	type ContextVerification,
	type DispatchLease,
} from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import {
	MANAGED_DELEGATION_ENV_VAR,
	childDelegationContext,
	delegationContextOf,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../managed/delegation';
import { createHeadlessSpawnAuthority } from '../../managed/host-adapter';
import { MANAGED_CONTRACT_VERSION } from '../../managed/types';
import { readHistory } from '../../store/read-history';
import type { BackgroundAdmissionEvent } from '../background-turns';
import type { ConsultAdmissionEvent } from '../consults';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeDeps,
} from '../index';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

const agentRecord = (
	id: string,
	name: string,
	cwd: string,
	extra: Record<string, unknown> = {}
) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd,
	projectRoot: cwd,
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
	...extra,
});

const ANSWER: FakeScript = (call) => ({ text: `Answer ${call.nth}: use a queue.` });

/**
 * The value of `--permission-mode`, read as a flag pair. The args also carry the Maestro system
 * prompt, whose text mentions plans, so a substring search over them proves nothing.
 */
function permissionMode(args: readonly string[]): string | undefined {
	const at = args.indexOf('--permission-mode');
	return at === -1 ? undefined : args[at + 1];
}

describe('runtime consults', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	let provider: FakeGroupChatProvider;
	/** Every admission the runtime decided, and the asking turn a test names (none by default). */
	let admissions: ConsultAdmissionEvent[];
	/** Every admission the background runner decided at the spawn (MRC-07-05). */
	let backgroundAdmissions: BackgroundAdmissionEvent[];
	let onBackgroundAdmission: RuntimeDeps['background']['onAdmission'];
	let initiator: RuntimeDeps['consults']['initiator'];
	let probeBinary: RuntimeDeps['probeBinary'] | undefined;
	let chatTurn: RuntimeDeps['turns']['runAgentTurn'];

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory: () => ({ close: () => undefined }),
			...(chatTurn ? { turns: { runAgentTurn: chatTurn } } : {}),
			probeBinary: async (binaryName, customPath) =>
				probeBinary
					? probeBinary(binaryName, customPath)
					: { exists: true, path: `/fake/bin/${binaryName}` },
			background: {
				runTurn: provider.runTurn,
				onAdmission: (event) => {
					backgroundAdmissions.push(event);
					onBackgroundAdmission?.(event);
				},
			},
			consults: {
				minTimeoutMs: 50,
				onAdmission: (event) => admissions.push(event),
				...(initiator ? { initiator } : {}),
			},
		};
	}

	const sessionsFile = () => path.join(dir, 'maestro-sessions.json');
	const readSessions = () => JSON.parse(fs.readFileSync(sessionsFile(), 'utf-8')).sessions;

	async function start(
		script: FakeScript = ANSWER,
		sessions: unknown[] = [
			agentRecord('a1', 'Alpha', work),
			agentRecord('a2', 'Beta', work),
			agentRecord('a3', 'Gamma', work),
		],
		settings: Record<string, unknown> = {},
		managed?: MaestroRuntimeOptions['managed']
	): Promise<MaestroRuntime> {
		provider = createFakeGroupChatProvider(work, script);
		fs.writeFileSync(
			sessionsFile(),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		fs.writeFileSync(path.join(dir, 'maestro-settings.json'), JSON.stringify(settings));
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			...(managed ? { managed } : {}),
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	/** The hidden consult tab Beta keeps for Alpha's asks. */
	const consultTab = (agentId: string) =>
		readSessions()
			.find((s: { id: string }) => s.id === agentId)
			.aiTabs.find((t: { consultOrigin?: unknown }) => t.consultOrigin);

	/** The record the consult's process was handed, as the consulted agent would read it. */
	const lineageOf = (nth: number): ManagedDelegationContext => {
		const read = readDelegationContextEnv(provider.callsFor('consult')[nth].spec.env);
		if (read.status !== 'ok') throw new Error(`the process carried no lineage: ${read.status}`);
		return read.context;
	};

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-consult-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-consult-work-'));
		open = [];
		admissions = [];
		backgroundAdmissions = [];
		onBackgroundAdmission = undefined;
		initiator = undefined;
		probeBinary = undefined;
		chatTurn = undefined;
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('an answer, inline (XM-2)', () => {
		it('asks the target and returns what it said', async () => {
			const runtime = await start();
			const answer = value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'How should we retry?',
					fromAgentId: 'a1',
				})
			);

			expect(answer).toEqual({ answer: 'Answer 1: use a queue.', agentName: 'Beta' });
			const [call] = provider.callsFor('consult');
			expect(call.processId).toMatch(/^cross-agent-/);
			expect(call.spec.command).toBe('/fake/bin/claude');
			// The question and the consulting agent's name are in what the target was told.
			expect(promptOf(call.spec)).toContain('How should we retry?');
		});

		it('is read-only by default, and writable only when the user opted in (B19)', async () => {
			const readOnly = await start();
			value(await readOnly.consults.ask({ targetAgentId: 'a2', question: 'Look at this' }));
			expect(permissionMode(provider.callsFor('consult')[0].spec.args)).toBe('plan');
			await readOnly.connection.close();

			const writable = await start(ANSWER, undefined, { crossAgentMentionsWritable: true });
			value(await writable.consults.ask({ targetAgentId: 'a2', question: 'Fix this' }));
			expect(permissionMode(provider.callsFor('consult')[0].spec.args)).toBeUndefined();
		});

		it('creates no tab, no tab event, and no unread on the consulted agent (XM-2)', async () => {
			const runtime = await start();
			const events: MaestroEvent[] = [];
			runtime.events.subscribe((event) => events.push(event));
			const before = value(await runtime.tabs.list('a2'));
			const activeBefore = value(await runtime.agents.get('a2')).activeTabId;

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'Quietly, please',
					fromAgentId: 'a1',
				})
			);

			// What a person sees of Beta is exactly what it was.
			expect(value(await runtime.tabs.list('a2'))).toEqual(before);
			expect(value(await runtime.agents.get('a2')).activeTabId).toBe(activeBefore);
			expect(events.filter((event) => event.type.startsWith('tab.'))).toEqual([]);
			expect(events.some((event) => event.type === 'turn')).toBe(false);

			// The exchange lives on a hidden tab of its own, keyed by who asked.
			const tab = consultTab('a2');
			expect(tab).toMatchObject({
				hidden: true,
				name: '↩ Alpha',
				consultOrigin: { sourceSessionId: 'a1', sourceTabId: CROSS_AGENT_ASK_TAB_ID },
			});
			expect(tab.hasUnread).toBeFalsy();
			expect(tab.logs.map((entry: { source: string }) => entry.source)).toEqual(['user', 'ai']);
			expect(tab.logs[1].text).toBe('Answer 1: use a queue.');
			// The asking agent's own tabs are untouched.
			expect(value(await runtime.tabs.list('a1')).map((t) => t.id)).toEqual(['a1-t1']);
		});

		it('writes a History entry on the target saying who consulted it and about what', async () => {
			const runtime = await start();
			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'How should we retry the webhook?',
					fromAgentId: 'a1',
				})
			);

			const read = readHistory({ historyDir: path.join(dir, 'history') }, 'a2');
			if (read.status !== 'ok') throw new Error(`history was ${read.status}`);
			expect(read.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'AGENT',
						sourceAgentName: 'Alpha',
						summary: expect.stringContaining('How should we retry the webhook?'),
						success: true,
					}),
				])
			);
		});

		it('keys an unattributed ask on one shared consult tab, like the desktop', async () => {
			const runtime = await start();
			value(await runtime.consults.ask({ targetAgentId: 'a2', question: 'First' }));
			value(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Second' }));

			const tabs = readSessions()
				.find((s: { id: string }) => s.id === 'a2')
				.aiTabs.filter((t: { consultOrigin?: unknown }) => t.consultOrigin);
			expect(tabs).toHaveLength(1);
			expect(tabs[0].consultOrigin).toEqual({
				sourceSessionId: CROSS_AGENT_ASK_SESSION_ID,
				sourceTabId: CROSS_AGENT_ASK_TAB_ID,
			});
			expect(tabs[0].name).toBe('↩ CLI');
			expect(tabs[0].logs).toHaveLength(4);
		});

		it('forwards the asking tab as context only when asked to, windowed by the question', async () => {
			const sessions = [
				agentRecord('a1', 'Alpha', work, {
					aiTabs: [
						{
							id: 'a1-t1',
							agentSessionId: null,
							name: null,
							logs: [
								{ id: 'l1', timestamp: 1, source: 'user', text: 'We chose Postgres.' },
								{ id: 'l2', timestamp: 2, source: 'stdout', text: 'Noted: Postgres.' },
							],
						},
					],
				}),
				agentRecord('a2', 'Beta', work),
			];
			const runtime = await start(ANSWER, sessions);

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'What did we pick?',
					fromAgentId: 'a1',
				})
			);
			expect(promptOf(provider.callsFor('consult')[0].spec)).not.toContain('We chose Postgres.');

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'What did we pick?',
					fromAgentId: 'a1',
					withContext: true,
				})
			);
			expect(promptOf(provider.callsFor('consult')[1].spec)).toContain('We chose Postgres.');
		});
	});

	describe('continuity and failure (B17, B18)', () => {
		it('resumes the target’s provider session on the next ask from the same agent', async () => {
			const runtime = await start((call) => ({
				text: `Answer ${call.nth}`,
				sessionId: `provider-session-${call.nth}`,
			}));
			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'One', fromAgentId: 'a1' })
			);
			expect(consultTab('a2').agentSessionId).toBe('provider-session-1');
			expect(provider.callsFor('consult')[0].spec.args).not.toContain('--resume');

			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Two', fromAgentId: 'a1' })
			);
			const second = provider.callsFor('consult')[1].spec.args;
			expect(second[second.indexOf('--resume') + 1]).toBe('provider-session-1');
		});

		it('fails on a non-zero exit even when the target said something, and stores no resume id (B17, B18)', async () => {
			const runtime = await start(() => ({
				text: 'I got halfway.',
				exitCode: 1,
				sessionId: 'doomed-session',
			}));

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Try', fromAgentId: 'a1' })
			);

			expect(error.code).toBe('failed');
			expect(error.message).toMatch(/Beta exited with code 1/);
			const tab = consultTab('a2');
			// What it said is kept on the tab, with the reason after it; the failed session is not resumed.
			expect(tab.logs.at(-1)).toMatchObject({ source: 'error' });
			expect(tab.logs.at(-1).text).toContain('I got halfway.');
			expect(tab.agentSessionId ?? null).toBeNull();
		});

		it('says the target produced no output when it exits clean and silent', async () => {
			const runtime = await start(() => ({ text: '' }));
			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hello?' })
			);
			expect(error.message).toMatch(/no visible output/);
		});

		it('refuses an empty question, an unknown target, and an agent asking itself', async () => {
			const runtime = await start();
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: '  ' })).code
			).toBe('invalid');
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'zzz', question: 'Hi' })).code
			).toBe('not-found');
			expect(
				errorOf(
					await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hi', fromAgentId: 'a2' })
				).code
			).toBe('invalid');
			expect(provider.calls).toEqual([]);
		});

		it('refuses a target with no directory to run in', async () => {
			const runtime = await start(ANSWER, [
				agentRecord('a1', 'Alpha', work),
				{ id: 'a2', name: 'Beta', toolType: 'claude-code', aiTabs: [] },
			]);
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hi' })).code
			).toBe('rejected');
		});
	});

	describe('fan-out and Stop (XM-4, B20, GD18, GD19)', () => {
		it('asks several agents at once: one slow answer does not hold the others back', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'slow', hold: true } : { text: `fast ${call.nth}` }
			);
			// The first consult (to Beta) never finishes on its own.
			const slow = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Slow one',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));
			expect(runtime.consultsInFlight()).toBe(1);

			// A different agent answers while it is still running.
			const fast = value(
				await runtime.consults.ask({
					targetAgentId: 'a3',
					question: 'Fast one',
					fromAgentId: 'a1',
				})
			);
			expect(fast.answer).toBe('fast 2');
			expect(runtime.consultsInFlight()).toBe(1);

			// Stop on the asking agent ends the slow one and reports why.
			value(await runtime.turns.interrupt('a1', 'a1-t1'));
			const stopped = errorOf(await slow);
			expect(stopped.code).toBe('rejected');
			expect(stopped.message).toMatch(/Beta was stopped|consult with Beta was stopped/);
			expect(runtime.consultsInFlight()).toBe(0);
		});

		it('runs consults that share a consult tab one at a time (GD18)', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'first', hold: true } : { text: `second ${call.nth}` }
			);
			const first = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'First',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));

			const second = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Second',
				fromAgentId: 'a1',
			});
			// Two processes resuming one provider session corrupt it: the second waits.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(provider.callsFor('consult')).toHaveLength(1);

			value(await runtime.turns.interrupt('a1', 'a1-t1'));
			expect(errorOf(await first).code).toBe('rejected');
			expect(value(await second).answer).toBe('second 2');
			expect(provider.callsFor('consult')).toHaveLength(2);
		});

		it('stops the consult when the caller’s wait runs out (GD19)', async () => {
			const runtime = await start(() => ({ text: 'never done', hold: true }));

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Too slow', timeoutMs: 100 })
			);

			expect(error.code).toBe('timeout');
			expect(error.message).toMatch(/did not answer within/);
			await vi.waitFor(() => expect(runtime.consultsInFlight()).toBe(0));
		});

		it('shutdown stops a consult in flight, writes down how it ended, and starts nothing queued behind it', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'working', hold: true } : { text: 'should never run' }
			);
			const first = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Long one',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));
			// Waiting behind the first on the same consult tab.
			const queued = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Behind it',
				fromAgentId: 'a1',
			});

			await runtime.connection.close();

			// The running one ended as stopped, and that is on the consult tab before the lock went.
			expect(errorOf(await first).code).toBe('rejected');
			expect(errorOf(await queued).code).toBe('host-unavailable');
			expect(provider.callsFor('consult')).toHaveLength(1);
			expect(consultTab('a2').logs.at(-1).text).toMatch(/was stopped/);
			// And nothing more is accepted.
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Too late' })).code
			).toBe('host-unavailable');
		});
	});

	/**
	 * The consult as a CHILD of the asking operation (MRC-07-04A): the record its process is
	 * handed, the chain that deepens when a consulted agent asks a third, and the scope this host
	 * meets it with. Nothing is admitted yet: the consult runner carries no admission (MRC-07-05),
	 * so an enrolled runtime refuses rather than run a consult unmanaged.
	 */
	describe('lineage and admission (MRC-07-04A)', () => {
		let authority: ReturnType<typeof createLocalHostAuthority>;
		/** An asking turn the host can name: admitted elsewhere under `policyRevision`. */
		const namedInitiator = (
			policyRevision: number | null,
			writable: boolean | null
		): NonNullable<RuntimeDeps['consults']['initiator']> => {
			const record: ManagedDelegationContext = {
				contractVersion: MANAGED_CONTRACT_VERSION,
				identity: {
					requestId: 'run-7',
					idempotencyKey: 'run-7',
					attemptId: 'run-7-a1',
					runId: 'run-7',
					rootRunId: 'run-7',
					parentRunId: null,
				},
				traceId: 'trace-7',
				workflow: null,
				delegation: { chain: [{ kind: 'agent', id: 'a1' }], grantRef: null },
				policyRevision,
			};
			return () => ({ delegation: record, writable });
		};

		it('hands the consult its lineage: the asker as the chain, the target as the new link, this request as the child run', async () => {
			const runtime = await start();
			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?', fromAgentId: 'a1' })
			);

			const lineage = lineageOf(0);
			const requestId = provider.callsFor('consult')[0].processId.slice('cross-agent-'.length);
			expect(lineage).toMatchObject({
				workflow: null,
				policyRevision: null,
				delegation: {
					chain: [
						{ kind: 'agent', id: 'a1' },
						{ kind: 'agent', id: 'a2' },
					],
					grantRef: null,
				},
				identity: { requestId, attemptId: requestId, runId: requestId },
			});
			// The asking turn is unnamed on this host, so its run is the one minted for this ask.
			expect(lineage.identity.parentRunId).toMatch(/^ask:a1:/);
			expect(lineage.identity.rootRunId).toBe(lineage.identity.parentRunId);
			expect(lineage.traceId).toBe(
				`delegated:${lineage.identity.rootRunId}:${requestId}:${requestId}`
			);
			// Standalone: nothing to admit, and the target's own env vars are untouched beside the record.
			expect(admissions).toEqual([]);
			expect(Object.keys(provider.callsFor('consult')[0].spec.env)).toContain(
				MANAGED_DELEGATION_ENV_VAR
			);
		});

		it('carries an empty chain plus the target for an unattributed ask', async () => {
			const runtime = await start();
			value(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?' }));
			expect(lineageOf(0).delegation.chain).toEqual([{ kind: 'agent', id: 'a2' }]);
			expect(lineageOf(0).identity.parentRunId).toMatch(
				new RegExp(`^ask:${CROSS_AGENT_ASK_SESSION_ID}:`)
			);
		});

		it('makes a consulted agent asking a third that consult’s child: the chain deepens, and a read-only consult never widens through a hand-off', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'thinking', hold: true } : { text: `nested ${call.nth}` }
			);
			const outer = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Outer',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));

			// Beta, answering read-only, hands work to Gamma. A hand-off may write by default, but
			// Beta may not, so neither may Gamma on Beta's behalf.
			const nested = value(
				await runtime.consults.ask({
					targetAgentId: 'a3',
					question: 'Save this',
					fromAgentId: 'a2',
					handoffAnswer: 'The answer.',
				})
			);
			expect(nested.answer).toBe('nested 2');
			expect(permissionMode(provider.callsFor('consult')[1].spec.args)).toBe('plan');
			const outerLineage = lineageOf(0);
			const inner = lineageOf(1);
			expect(inner.delegation.chain).toEqual([
				{ kind: 'agent', id: 'a1' },
				{ kind: 'agent', id: 'a2' },
				{ kind: 'agent', id: 'a3' },
			]);
			expect(inner.identity.parentRunId).toBe(outerLineage.identity.requestId);
			expect(inner.identity.rootRunId).toBe(outerLineage.identity.rootRunId);

			value(await runtime.turns.interrupt('a1', 'a1-t1'));
			expect(errorOf(await outer).code).toBe('rejected');
		});

		it('refuses a managed initiator on a standalone runtime, and starts nothing', async () => {
			initiator = namedInitiator(7, null);
			const runtime = await start();
			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?', fromAgentId: 'a1' })
			);
			expect(error.code).toBe('host-unavailable');
			expect(error.message).toMatch(/policy revision 7/);
			expect(provider.calls).toEqual([]);
			expect(consultTab('a2')).toBeUndefined();
			expect(admissions).toEqual([
				expect.objectContaining({
					kind: 'refused',
					state: 'unavailable',
					code: 'runtime-unavailable',
					delegation: expect.objectContaining({
						policyRevision: 7,
						delegation: {
							chain: [
								{ kind: 'agent', id: 'a1' },
								{ kind: 'agent', id: 'a2' },
							],
							grantRef: null,
						},
						identity: expect.objectContaining({ parentRunId: 'run-7', rootRunId: 'run-7' }),
					}),
				}),
			]);
		});

		it('narrows access to what a named initiator may write: a read-only asking turn gets no writable consult, even opted in', async () => {
			initiator = namedInitiator(null, false);
			const runtime = await start(ANSWER, undefined, { crossAgentMentionsWritable: true });
			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Fix this', fromAgentId: 'a1' })
			);
			expect(permissionMode(provider.callsFor('consult')[0].spec.args)).toBe('plan');
			expect(lineageOf(0).identity.parentRunId).toBe('run-7');
		});

		/** An enrolled runtime over `authority`: the fleet authority a desktop or host would have enrolled with. */
		async function startEnrolled(
			decide: (request: AdmissionRequest) => 'allow' | 'deny',
			asked: AdmissionRequest[],
			script: FakeScript = ANSWER,
			managed?: MaestroRuntimeOptions['managed']
		): Promise<MaestroRuntime> {
			let leaseId = 0;
			authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: (request) => {
					asked.push(request);
					return decide(request) === 'allow'
						? { decision: 'allow', policyRevision: 1 }
						: { decision: 'deny', reason: 'the policy says no', policyRevision: 1 };
				},
				now: () => Date.now(),
				newId: () => `lease-${++leaseId}`,
				leaseTtlMs: 60_000,
			});
			const enroller = await start();
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => T0,
			});
			const enrolled = await binding.enroll({
				installationId: enroller.installation.installationId,
				authorityId: 'fleet-authority',
				endpointRef: 'ep',
				policySources: [],
				policyRevision: 1,
			});
			if (!enrolled.ok) throw new Error(enrolled.message);
			await enroller.connection.close();
			open.splice(open.indexOf(enroller), 1);
			const runtime = await start(script, undefined, {}, { ...managed, authority });
			expect(runtime.managedBinding.state().state).toBe('enrolled');
			return runtime;
		}

		describe('live chat source composition', () => {
			const callers = new AsyncLocalStorage<{
				agentId: string;
				tabId: string;
				processId?: string;
				kind?: 'auto-run';
			}>();
			let readable: boolean;
			let sourceLookup: ReturnType<
				typeof vi.fn<NonNullable<NonNullable<MaestroRuntimeOptions['managed']>['consultSource']>>
			>;
			let sourceAdmissions: AdmissionRequest[];
			const input = {
				targetAgentId: 'a2',
				fromAgentId: 'a1',
				fromTabId: 'a1-t1',
				question: 'Check this',
			};
			const ask = (runtime: MaestroRuntime, request = input) =>
				callers.run({ agentId: request.fromAgentId, tabId: request.fromTabId }, () =>
					runtime.consults.ask(request)
				);

			async function liveChat(script: FakeScript = ANSWER, readOnly = true) {
				readable = true;
				sourceAdmissions = [];
				const recording = writeFakeTurn(work, { chunks: [], close: { code: 0, signal: null } });
				chatTurn = (turn, options) =>
					runAgentTurn(
						{
							...turn,
							launch: {
								...turn.launch,
								command: process.execPath,
								args: [FAKE_AGENT_PATH],
								sessionCustomEnvVars: {
									...turn.launch.sessionCustomEnvVars,
									FAKE_AGENT_RECORDING: recording,
									FAKE_AGENT_HOLD: '1',
								},
							},
						},
						{ ...options, stopGraceMs: 200 }
					);
				sourceLookup = vi.fn(() => (readable ? (callers.getStore() ?? null) : null));
				const runtime = await startEnrolled(() => 'allow', sourceAdmissions, script, {
					consultSource: sourceLookup,
				});
				value(await runtime.tabs.update('a1', 'a1-t1', { readOnly }));
				value(await runtime.turns.send('a1', 'a1-t1', { text: 'Source operation' }));
				return runtime;
			}

			it('refuses unknown source kinds without borrowing live chat custody', async () => {
				const runtime = await liveChat();
				sourceLookup.mockImplementation(() => ({
					agentId: 'a1',
					tabId: 'a1-t1',
					kind: 'unknown' as 'auto-run',
				}));
				expect(errorOf(await ask(runtime)).message).toMatch(/custody/i);
				expect(sourceAdmissions).toHaveLength(1);
				expect(provider.calls).toHaveLength(0);
				expect(consultTab('a2')).toBeUndefined();
				sourceLookup.mockImplementation(() => callers.getStore() ?? null);
				value(await ask(runtime));
			});

			describe('live Auto Run source composition', () => {
				async function liveAutoRun(kind: 'playbook' | 'goal' = 'playbook', script = ANSWER) {
					readable = true;
					sourceAdmissions = [];
					const processes: string[] = [];
					const recording = writeFakeTurn(work, { chunks: [], close: { code: 0, signal: null } });
					chatTurn = async (turn, options) => {
						const started = await runAgentTurn(
							{
								...turn,
								launch: {
									...turn.launch,
									command: process.execPath,
									args: [FAKE_AGENT_PATH],
									sessionCustomEnvVars: {
										...turn.launch.sessionCustomEnvVars,
										FAKE_AGENT_RECORDING: recording,
										FAKE_AGENT_HOLD: '1',
									},
								},
							},
							{ ...options, stopGraceMs: 200 }
						);
						if (started.ok) processes.push(options.sessionId);
						return started;
					};
					const owner = new AbortController();
					const lifetime = {
						signal: owner.signal,
						current: vi.fn(() => true),
						finish: vi.fn(async () => {}),
					};
					const claim = vi.fn(() => ({ ownerEpoch: 'epoch-1', fencingToken: 'fence-1', lifetime }));
					sourceLookup = vi.fn(() => (readable ? (callers.getStore() ?? null) : null));
					const runtime = await startEnrolled(() => 'allow', sourceAdmissions, script, {
						consultSource: sourceLookup,
						workflowFence: claim,
					});
					const file = path.join(work, 'source.md');
					fs.writeFileSync(file, '- [ ] Source task\n');
					value(await runtime.agents.update('a1', { autoRunFolderPath: work }));
					value<unknown>(
						await (kind === 'goal'
							? runtime.autoRun.launchGoal('a1', { goal: 'Source work', maxIterations: 1 })
							: runtime.autoRun.launch('a1', { documents: [{ file }] }))
					);
					await vi.waitFor(() => expect(processes).toHaveLength(1));
					const caller: NonNullable<ReturnType<typeof sourceLookup>> = {
						agentId: 'a1',
						tabId: 'a1-t1',
						processId: processes[0],
						kind: 'auto-run',
					};
					const nested = () =>
						callers.run(caller, () =>
							runtime.consults.ask({ ...input, handoffAnswer: 'Save the answer.' })
						);
					return { runtime, caller, nested, owner, lifetime, claim, file, processes };
				}

				it.each(['playbook', 'goal'] as const)(
					'binds live %s lineage and access without reclaiming the source',
					async (kind) => {
						const { nested, claim, lifetime } = await liveAutoRun(kind);
						const lease = authority.live()[0];
						expect(value(await nested()).answer).toBe('Answer 1: use a queue.');
						const child = lineageOf(0);
						expect(child).toEqual(
							childDelegationContext(delegationContextOf(sourceAdmissions[0].context), {
								link: { kind: 'agent', id: 'a2' },
								requestId: child.identity.requestId,
								attemptId: child.identity.attemptId,
							})
						);
						expect(child.workflow).toMatchObject({
							ownerEpoch: 'epoch-1',
							fencingToken: 'fence-1',
						});
						expect(permissionMode(provider.calls[0].spec.args)).toBeUndefined();
						expect(sourceAdmissions).toHaveLength(2);
						expect(claim).toHaveBeenCalledTimes(1);
						expect(lifetime.finish).not.toHaveBeenCalled();
						expect(authority.live()).toEqual([lease]);
						expect(lease.state()).toBe('bound');
					}
				);

				it.each([
					'missing',
					'blank',
					'wrong-agent',
					'wrong-tab',
					'wrong-kind',
					'stopped',
					'ended',
					'revoked',
					'owner',
					'withdrawn',
					'unreadable',
				] as const)('refuses %s Auto Run custody without a child effect', async (mode) => {
					const { runtime, caller, nested, lifetime, owner } = await liveAutoRun();
					if (mode === 'missing') delete caller.processId;
					if (mode === 'blank') caller.processId = '';
					if (mode === 'wrong-agent') caller.agentId = 'a3';
					if (mode === 'wrong-tab') caller.tabId = 'a1-t2';
					if (mode === 'wrong-kind') delete caller.kind;
					if (mode === 'stopped') value(await runtime.autoRun.stop('a1'));
					if (mode === 'ended') {
						owner.abort();
						await vi.waitFor(() => expect(runtime.runs.activeRuns()).toHaveLength(0));
					}
					if (mode === 'revoked') authority.revoke(authority.live()[0].leaseId, 'Source revoked');
					if (mode === 'owner') lifetime.current.mockReturnValue(false);
					if (mode === 'withdrawn') readable = false;
					if (mode === 'unreadable')
						sourceLookup.mockImplementation(() => {
							throw new Error('No source');
						});
					expect(errorOf(await nested()).message).toMatch(/custody/i);
					expect(provider.calls).toHaveLength(0);
					expect(consultTab('a2')).toBeUndefined();
					expect(sourceAdmissions).toHaveLength(1);
				});

				it.each(['preparation', 'admission', 'observer', 'sink'] as const)(
					'rechecks Auto Run custody at %s and releases unused leases before recovery',
					async (boundary) => {
						let withdraw = false;
						let withdrawSource = () => {};
						const { nested, lifetime } = await liveAutoRun('playbook', () => {
							if (withdraw && boundary === 'sink') withdrawSource();
							return { text: 'Recovered' };
						});
						withdrawSource = () => lifetime.current.mockReturnValue(false);
						const leases: DispatchLease[] = [];
						const admit = authority.admit.bind(authority);
						vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
							const answer = await admit(request);
							if (answer.state === 'admitted') leases.push(answer.lease);
							if (withdraw && boundary === 'admission') withdrawSource();
							return answer;
						});
						probeBinary = async () => {
							if (withdraw && boundary === 'preparation') withdrawSource();
							return { exists: true, path: '/fake/bin/claude' };
						};
						onBackgroundAdmission = (event) => {
							if (withdraw && boundary === 'observer' && event.kind === 'admitted')
								withdrawSource();
						};
						withdraw = true;
						expect(errorOf(await nested()).message).toMatch(/custody|lease.*released/i);
						expect(leases).toHaveLength(boundary === 'preparation' ? 0 : 1);
						for (const lease of leases) {
							expect(lease.pid()).toBeUndefined();
							expect(lease.ended()).toMatchObject({
								state: 'released',
								release: { outcome: 'spawn-failed' },
							});
						}
						expect(authority.live()).toHaveLength(1);
						withdraw = false;
						lifetime.current.mockReturnValue(true);
						expect(value(await nested()).answer).toBe('Recovered');
						expect(authority.live()).toHaveLength(1);
					}
				);

				it.each(['process', 'kind'] as const)(
					'refuses changed Auto Run %s selection through preparation',
					async (field) => {
						const { caller, nested } = await liveAutoRun();
						const original = { ...caller };
						probeBinary = async () => {
							if (field === 'kind') delete caller.kind;
							else caller.processId = 'replacement';
							return { exists: true, path: '/fake/bin/claude' };
						};
						expect(errorOf(await nested()).message).toMatch(/custody/i);
						expect(sourceAdmissions).toHaveLength(1);
						expect(provider.calls).toHaveLength(0);
						probeBinary = undefined;
						Object.assign(caller, original);
						value(await nested());
					}
				);

				it('isolates concurrent Auto Run sources and checks the exact owning agent', async () => {
					const { runtime, caller, file, processes } = await liveAutoRun();
					value(await runtime.agents.update('a3', { autoRunFolderPath: work }));
					value(await runtime.autoRun.launch('a3', { documents: [{ file }] }));
					await vi.waitFor(() => expect(processes).toHaveLength(2));
					const other = { ...caller, agentId: 'a3', tabId: 'a3-t1', processId: processes[1] };
					const request = {
						...input,
						fromAgentId: 'a3',
						fromTabId: 'a3-t1',
						handoffAnswer: 'Save this.',
					};
					expect(
						errorOf(
							await callers.run({ ...other, processId: processes[0] }, () =>
								runtime.consults.ask(request)
							)
						).message
					).toMatch(/custody/i);
					expect(provider.calls).toHaveLength(0);
					const answers = await Promise.all([
						callers.run(caller, () => runtime.consults.ask({ ...input, targetAgentId: 'a3' })),
						callers.run(other, () => runtime.consults.ask(request)),
					]);
					answers.forEach(value);
					expect(
						[lineageOf(0).identity.parentRunId, lineageOf(1).identity.parentRunId].sort()
					).toEqual(
						sourceAdmissions
							.slice(0, 2)
							.map((request) => request.context.identity.runId)
							.sort()
					);
					expect(authority.live()).toHaveLength(2);
				});

				it('keeps nested consults under the Auto Run workflow and the read-only child ceiling', async () => {
					const { runtime, caller } = await liveAutoRun('playbook', (call) => ({
						text: 'Nested',
						hold: call.nth === 1,
					}));
					const outer = callers.run(caller, () => runtime.consults.ask(input));
					await vi.waitFor(() =>
						expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(2)
					);
					const nestedCaller = {
						agentId: 'a2',
						tabId: consultTab('a2').id,
						processId: provider.calls[0].processId,
					};
					value(
						await callers.run(nestedCaller, () =>
							runtime.consults.ask({
								targetAgentId: 'a3',
								fromAgentId: 'a2',
								fromTabId: nestedCaller.tabId,
								question: 'More',
								handoffAnswer: 'Save this.',
							})
						)
					);
					expect(lineageOf(1).workflow).toEqual(lineageOf(0).workflow);
					expect(lineageOf(1).identity.parentRunId).toBe(lineageOf(0).identity.requestId);
					expect(lineageOf(1).identity.rootRunId).toBe(lineageOf(0).identity.rootRunId);
					expect(permissionMode(provider.calls[1].spec.args)).toBe('plan');
					authority.revoke(authority.live()[1].leaseId, 'Finish child');
					await outer;
				});

				it('rechecks queued Auto Run work after a graceful stop and recovers on a new run', async () => {
					const { runtime, caller, nested, file, processes } = await liveAutoRun(
						'playbook',
						(call) => ({ text: 'Answer', hold: call.nth === 1 })
					);
					const first = nested();
					await vi.waitFor(() =>
						expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(2)
					);
					const reads = sourceLookup.mock.calls.length;
					const queued = nested();
					await vi.waitFor(() => expect(sourceLookup.mock.calls.length).toBeGreaterThan(reads));
					value(await runtime.autoRun.stop('a1'));
					authority.revoke(authority.live()[1].leaseId, 'Finish first child');
					await first;
					expect(errorOf(await queued).message).toMatch(/custody/i);
					expect(provider.calls).toHaveLength(1);
					authority.revoke(authority.live()[0].leaseId, 'Finish source');
					await vi.waitFor(() => expect(runtime.runs.activeRuns()).toHaveLength(0));
					value(await runtime.autoRun.launch('a1', { documents: [{ file }] }));
					await vi.waitFor(() => expect(processes).toHaveLength(2));
					expect(errorOf(await nested()).message).toMatch(/custody/i);
					caller.processId = processes[1];
					value(await nested());
					expect(lineageOf(1).identity.parentRunId).toBe(
						sourceAdmissions[2].context.identity.runId
					);
				});
			});

			async function liveConsult(
				readOnly = true,
				script: FakeScript = (call) => ({
					text: 'Nested answer',
					hold: call.nth === 1,
				})
			) {
				const runtime = await liveChat(script, readOnly);
				const outer = callers.run({ agentId: 'a1', tabId: 'a1-t1' }, () =>
					runtime.consults.ask({ ...input, handoffAnswer: 'Check the answer.' })
				);
				await vi.waitFor(() => {
					expect(provider.calls).toHaveLength(1);
					expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(2);
				});
				const request = {
					...input,
					targetAgentId: 'a3',
					fromAgentId: 'a2',
					fromTabId: consultTab('a2').id as string,
					handoffAnswer: 'Save the answer.',
				};
				const caller = {
					agentId: request.fromAgentId,
					tabId: request.fromTabId,
					processId: provider.calls[0].processId,
				};
				const nested = () => callers.run(caller, () => runtime.consults.ask(request));
				return { runtime, outer, request, caller, nested };
			}

			it.each([true, false])(
				'composes a live consult source with readOnly=%s',
				async (readOnly) => {
					const { runtime, outer, nested } = await liveConsult(readOnly);
					expect(value(await nested()).answer).toBe('Nested answer');
					const parent = sourceAdmissions[1].context;
					const child = lineageOf(1);
					expect(child).toEqual(
						childDelegationContext(delegationContextOf(parent), {
							link: { kind: 'agent', id: 'a3' },
							requestId: child.identity.requestId,
							attemptId: child.identity.attemptId,
						})
					);
					expect(permissionMode(provider.calls[1].spec.args)).toBe(readOnly ? 'plan' : undefined);
					expect(sourceAdmissions).toHaveLength(3);
					expect(authority.live()).toHaveLength(2);
					value(await runtime.turns.interrupt('a1', 'a1-t1'));
					await outer;
				}
			);

			it.each([
				'missing',
				'blank',
				'wrong-agent',
				'wrong-tab',
				'stopped',
				'revoked',
				'withdrawn',
				'unreadable',
			] as const)('refuses %s nested source custody without a child effect', async (mode) => {
				const { runtime, outer, caller, request, nested } = await liveConsult();
				if (mode === 'missing') caller.processId = 'not-a-live-process';
				if (mode === 'blank') caller.processId = '';
				if (mode === 'wrong-agent') caller.agentId = 'a3';
				if (mode === 'wrong-tab') caller.tabId = 'a2-t1';
				if (mode === 'stopped') {
					value(await runtime.turns.interrupt('a1', 'a1-t1'));
					await outer;
				}
				if (mode === 'revoked') authority.revoke(authority.live()[1].leaseId, 'Source revoked');
				if (mode === 'withdrawn') readable = false;
				if (mode === 'unreadable')
					sourceLookup.mockImplementation(() => {
						throw new Error('No source');
					});
				expect(errorOf(await nested()).message).toMatch(/custody/i);
				expect(provider.calls).toHaveLength(1);
				expect(consultTab(request.targetAgentId)).toBeUndefined();
				expect(sourceAdmissions).toHaveLength(2);
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
				await outer;
			});

			it.each(['preparation', 'admission', 'observer', 'sink'] as const)(
				'rechecks nested custody at %s, releases unused leases and recovers',
				async (boundary) => {
					let withdraw = true;
					let revokedCaller: object | undefined;
					const setup = await liveConsult(true, (call) => {
						if (call.nth > 1 && withdraw && boundary === 'sink') revokedCaller = callers.getStore();
						return { text: 'Recovered', hold: call.nth === 1 };
					});
					const { runtime, outer, nested } = setup;
					sourceLookup.mockImplementation(() =>
						callers.getStore() === revokedCaller ? null : (callers.getStore() ?? null)
					);
					const issued: DispatchLease[] = [];
					const admit = authority.admit.bind(authority);
					vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
						const answer = await admit(request);
						if (answer.state === 'admitted') issued.push(answer.lease);
						if (withdraw && boundary === 'admission') revokedCaller = callers.getStore();
						return answer;
					});
					probeBinary = async () => {
						if (withdraw && boundary === 'preparation') revokedCaller = callers.getStore();
						return { exists: true, path: '/fake/bin/claude' };
					};
					onBackgroundAdmission = (event) => {
						if (withdraw && boundary === 'observer' && event.kind === 'admitted')
							revokedCaller = callers.getStore();
					};
					expect(errorOf(await nested()).message).toMatch(/custody|lease.*released/i);
					expect(issued).toHaveLength(boundary === 'preparation' ? 0 : 1);
					for (const lease of issued) {
						expect(lease.pid()).toBeUndefined();
						expect(lease.ended()).toMatchObject({
							state: 'released',
							release: { outcome: 'spawn-failed' },
						});
					}
					expect(authority.live()).toHaveLength(2);
					withdraw = false;
					revokedCaller = undefined;
					expect(value(await nested()).answer).toBe('Recovered');
					expect(authority.live()).toHaveLength(2);
					value(await runtime.turns.interrupt('a1', 'a1-t1'));
					await outer;
				}
			);

			it('keeps a three-level nested chain bound to each original request', async () => {
				const { runtime, outer, nested } = await liveConsult(true, (call) => ({
					text: 'Deep answer',
					hold: call.nth < 3,
				}));
				const inner = nested();
				await vi.waitFor(() =>
					expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(3)
				);
				const caller = {
					agentId: 'a3',
					tabId: consultTab('a3').id,
					processId: provider.calls[1].processId,
				};
				value(
					await callers.run(caller, () =>
						runtime.consults.ask({
							targetAgentId: 'a1',
							fromAgentId: caller.agentId,
							fromTabId: caller.tabId,
							question: 'Third level',
							handoffAnswer: 'Save this.',
						})
					)
				);
				expect(lineageOf(2).identity.parentRunId).toBe(lineageOf(1).identity.requestId);
				expect(lineageOf(2).identity.rootRunId).toBe(lineageOf(0).identity.rootRunId);
				expect(lineageOf(2).delegation.chain).toEqual([
					...lineageOf(1).delegation.chain,
					{ kind: 'agent', id: 'a1' },
				]);
				expect(permissionMode(provider.calls[2].spec.args)).toBe('plan');
				value(await runtime.turns.interrupt('a2', consultTab('a2').id));
				await inner;
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
				await outer;
			});

			it('isolates concurrent background sources and refuses a substituted process', async () => {
				const { runtime, outer, caller, request, nested } = await liveConsult(true, (call) => ({
					text: 'Concurrent answer',
					hold: call.nth <= 2,
				}));
				const other = ask(runtime, { ...input, targetAgentId: 'a3' });
				await vi.waitFor(() =>
					expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(3)
				);
				const otherCaller = {
					agentId: 'a3',
					tabId: consultTab('a3').id,
					processId: provider.calls[1].processId,
				};
				const otherRequest = {
					...request,
					targetAgentId: 'a1',
					fromAgentId: 'a3',
					fromTabId: otherCaller.tabId,
				};
				const answers = await Promise.all([
					callers.run(caller, () => runtime.consults.ask({ ...request, targetAgentId: 'a1' })),
					callers.run(otherCaller, () => runtime.consults.ask(otherRequest)),
				]);
				answers.forEach(value);
				expect(
					[lineageOf(2).identity.parentRunId, lineageOf(3).identity.parentRunId].sort()
				).toEqual([lineageOf(0).identity.requestId, lineageOf(1).identity.requestId].sort());
				const original = caller.processId;
				probeBinary = async () => {
					caller.processId = otherCaller.processId;
					return { exists: true, path: '/fake/bin/claude' };
				};
				expect(errorOf(await nested()).message).toMatch(/custody/i);
				expect(provider.calls).toHaveLength(4);
				probeBinary = undefined;
				caller.processId = original;
				value(await nested());
				expect(lineageOf(4).identity.parentRunId).toBe(lineageOf(0).identity.requestId);
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
				await Promise.all([outer, other]);
			});

			it('refuses queued nested work after its source is revoked', async () => {
				const { runtime, outer, nested } = await liveConsult(true, (call) => ({
					text: 'Waiting',
					hold: call.nth <= 2,
				}));
				const first = nested();
				await vi.waitFor(() =>
					expect(authority.live().filter((lease) => lease.state() === 'bound')).toHaveLength(3)
				);
				const calls = sourceLookup.mock.calls.length;
				const queued = nested();
				await vi.waitFor(() => expect(sourceLookup.mock.calls.length).toBeGreaterThan(calls));
				const leases = authority.live();
				authority.revoke(leases[1].leaseId, 'Source revoked');
				authority.revoke(leases[2].leaseId, 'Finish the first child');
				await Promise.all([outer, first]);
				expect(errorOf(await queued).message).toMatch(/custody/i);
				expect(provider.calls).toHaveLength(2);
				expect(authority.live()).toHaveLength(1);
				value(await ask(runtime));
				expect(lineageOf(2).identity.parentRunId).toBe(
					sourceAdmissions[0].context.identity.requestId
				);
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
			});

			it('refuses a completed background source instead of falling back to chat custody', async () => {
				const runtime = await liveChat();
				value(await ask(runtime));
				const caller = { agentId: 'a1', tabId: 'a1-t1', processId: provider.calls[0].processId };
				expect(
					errorOf(await callers.run(caller, () => runtime.consults.ask(input))).message
				).toMatch(/custody/i);
				expect(provider.calls).toHaveLength(1);
				value(await ask(runtime));
				expect(provider.calls).toHaveLength(2);
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
			});

			it('preserves standalone consults with a configured source lookup', async () => {
				const lookup = vi.fn(() => null);
				const runtime = await start(ANSWER, undefined, {}, { consultSource: lookup });
				value(await runtime.consults.ask(input));
				expect(lookup).not.toHaveBeenCalled();
			});

			it('requires source custody if enrollment arrives during preparation', async () => {
				const runtime = await start(ANSWER, undefined, {}, { consultSource: () => null });
				authority = createLocalHostAuthority({
					authorityId: 'fleet-authority',
					decide: () => ({ decision: 'allow', policyRevision: 1 }),
					now: () => T0,
					newId: () => 'enrollment-transition-lease',
				});
				const binding = createManagedBinding({
					paths: { userDataDir: dir, productionDataDir: dir },
					fence: () => ({ ok: true }),
					authority,
					now: () => T0,
				});
				probeBinary = async () => {
					const enrolled = await binding.enroll({
						installationId: runtime.installation.installationId,
						authorityId: 'fleet-authority',
						endpointRef: 'ep',
						policySources: [],
						policyRevision: 1,
					});
					expect(enrolled.ok).toBe(true);
					runtime.managedBinding.reload();
					return { exists: true, path: '/fake/bin/claude' };
				};
				expect(errorOf(await runtime.consults.ask(input)).message).toMatch(/custody/i);
				expect(provider.calls).toEqual([]);
			});

			it.each([false, true])(
				'binds a live source and retains readOnly=%s for handoffs',
				async (readOnly) => {
					const runtime = await liveChat(ANSWER, readOnly);
					const source = sourceAdmissions[0].context;
					const result = await callers.run({ agentId: 'a1', tabId: 'a1-t1' }, () =>
						runtime.consults.ask({ ...input, handoffAnswer: 'Apply this answer' })
					);
					value(result);
					const child = lineageOf(0);
					expect(child.identity.parentRunId).toBe(
						source.identity.runId ?? source.identity.requestId
					);
					expect(child).toEqual(
						childDelegationContext(delegationContextOf(source), {
							link: { kind: 'agent', id: 'a2' },
							requestId: child.identity.requestId,
							attemptId: child.identity.attemptId,
						})
					);
					expect(child.delegation.chain).toEqual([
						...source.delegation.chain,
						{ kind: 'agent', id: 'a2' },
					]);
					expect(sourceAdmissions).toHaveLength(2);
					expect(permissionMode(provider.calls[0].spec.args)).toBe(readOnly ? 'plan' : undefined);
					expect(sourceLookup.mock.calls.length).toBeGreaterThan(3);
					expect(authority.live()).toHaveLength(1);
				}
			);

			it.each([
				'no-caller',
				'different-agent',
				'different-tab',
				'omitted-tab',
				'unreadable',
				'stopped',
				'revoked',
			] as const)('refuses %s source custody before writing the target', async (mode) => {
				const runtime = await liveChat();
				if (mode === 'unreadable')
					sourceLookup.mockImplementation(() => {
						throw new Error('No custody');
					});
				if (mode === 'stopped') value(await runtime.turns.interrupt('a1', 'a1-t1'));
				if (mode === 'revoked') authority.revoke(authority.live()[0].leaseId, 'Source revoked');
				const request = {
					...input,
					...(mode === 'different-agent' ? { fromAgentId: 'a3' } : {}),
					...(mode === 'different-tab' ? { fromTabId: 'a1-other' } : {}),
					...(mode === 'omitted-tab' ? { fromTabId: undefined } : {}),
				};
				const invoke = () => runtime.consults.ask(request);
				const result = await (mode === 'no-caller'
					? invoke()
					: callers.run({ agentId: 'a1', tabId: 'a1-t1' }, invoke));
				expect(errorOf(result).message).toMatch(/custody/i);
				expect(provider.calls).toEqual([]);
				expect(consultTab('a2')).toBeUndefined();
				expect(sourceAdmissions).toHaveLength(1);
			});

			it.each(['preparation', 'admission', 'observer', 'sink'] as const)(
				'rechecks a withdrawn caller at %s and admits a fresh request',
				async (boundary) => {
					let withdraw = true;
					const runtime = await liveChat(() => {
						if (withdraw && boundary === 'sink') readable = false;
						return { text: 'Fresh answer' };
					});
					const issued: DispatchLease[] = [];
					const admit = authority.admit.bind(authority);
					vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
						const answer = await admit(request);
						if (answer.state === 'admitted') issued.push(answer.lease);
						if (withdraw && boundary === 'admission') readable = false;
						return answer;
					});
					probeBinary = async () => {
						if (withdraw && boundary === 'preparation') readable = false;
						return { exists: true, path: '/fake/bin/claude' };
					};
					onBackgroundAdmission = (event) => {
						if (withdraw && boundary === 'observer' && event.kind === 'admitted') readable = false;
					};
					expect(errorOf(await ask(runtime)).message).toMatch(/custody|lease.*released/i);
					expect(authority.live()).toHaveLength(1);
					for (const lease of issued) {
						expect(lease.pid()).toBeUndefined();
						expect(lease.ended()).toMatchObject({
							state: 'released',
							release: { outcome: 'spawn-failed' },
						});
					}
					if (boundary !== 'sink') expect(provider.calls).toEqual([]);
					withdraw = false;
					readable = true;
					value(await ask(runtime));
					expect(lineageOf(provider.calls.length - 1).identity.parentRunId).toBe(
						sourceAdmissions[0].context.identity.requestId
					);
					expect(authority.live()).toHaveLength(1);
				}
			);

			it('keeps concurrent source tabs separate and rejects a queued request after its source stops', async () => {
				const runtime = await liveChat((call) => ({ text: 'Answer', hold: call.nth === 1 }));
				value(await runtime.tabs.update('a3', 'a3-t1', { readOnly: true }));
				value(await runtime.turns.send('a3', 'a3-t1', { text: 'Other source' }));
				const first = ask(runtime);
				await vi.waitFor(() => expect(provider.calls).toHaveLength(1));
				const queued = ask(runtime);
				const other = { ...input, targetAgentId: 'a1', fromAgentId: 'a3', fromTabId: 'a3-t1' };
				value(await ask(runtime, other));
				expect(lineageOf(0).identity.parentRunId).toBe(
					sourceAdmissions[0].context.identity.requestId
				);
				expect(lineageOf(1).identity.parentRunId).toBe(
					sourceAdmissions[1].context.identity.requestId
				);
				value(await runtime.turns.interrupt('a1', 'a1-t1'));
				await first;
				expect(errorOf(await queued).message).toMatch(/custody/i);
				expect(provider.calls).toHaveLength(2);
				value(await ask(runtime, other));
				expect(runtime.consultsInFlight()).toBe(0);
				expect(authority.live()).toHaveLength(1);
			});
		});

		describe('explicit consult delegates with authenticated parents', () => {
			it.each([
				'ask',
				'handoff',
				'workflow',
				'grant',
				'root',
				'parent',
				'chain',
				'policy',
				'copied',
				'withdrawn',
				'admission',
				'observer',
				'sink',
				'host-denial',
			] as const)('preserves the delegate and enforces %s custody', async (mode) => {
				const asked: AdmissionRequest[] = [];
				let source: ContextVerification = {
					ok: false,
					code: 'unauthenticated',
					problems: ['Source withdrawn.'],
				};
				const withdrawn = source;
				let record = namedInitiator(7, false)({ agentId: 'a1' })!;
				record.delegation.workflow = {
					workflowId: 'nightly',
					version: 'v1',
					triggerEventId: 'cue:1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				};
				record.delegation.delegation.grantRef = 'grant-1';
				const saved = structuredClone(record);
				initiator = () => record;
				const parentContext = vi.fn(() => source);
				let firstAttempt = true;
				const issued: DispatchLease[] = [];
				onBackgroundAdmission = (event) => {
					if (event.kind === 'admitted') {
						if (firstAttempt && mode === 'observer') source = withdrawn;
					}
				};
				const runtime = await startEnrolled(
					() => {
						if (firstAttempt && mode === 'admission') source = withdrawn;
						return firstAttempt && mode === 'host-denial' ? 'deny' : 'allow';
					},
					asked,
					() => {
						if (firstAttempt && mode === 'sink') source = withdrawn;
						return { text: 'Verified child answer.' };
					},
					{ backgroundParentContext: parentContext }
				);
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					const result = await admit(request);
					if (result.state === 'admitted') issued.push(result.lease);
					return result;
				});
				const verified = createHeadlessSpawnAuthority({
					installation: runtime.installation,
					binding: runtime.managedBinding.state(),
					host: { authority, policy: () => ({ sources: [], policyRevision: 7 }) },
					origin: 'cue',
					actor: { kind: 'human', id: 'source-operator' },
				}).context(record.delegation);
				if (!verified.ok) throw new Error(verified.problems.join('; '));
				source = verified;
				if (mode === 'workflow') record.delegation.workflow!.fencingToken = 'forged';
				if (mode === 'grant') record.delegation.delegation.grantRef = 'forged';
				if (mode === 'root') record.delegation.identity.rootRunId = 'forged';
				if (mode === 'parent') record.delegation.identity.runId = 'forged';
				if (mode === 'chain') record.delegation.delegation.chain[0].id = 'forged';
				if (mode === 'policy') record.delegation.policyRevision = 8;
				if (mode === 'copied') source = structuredClone(verified);
				if (mode === 'withdrawn') source = withdrawn;
				const input = {
					targetAgentId: mode === 'handoff' ? 'a3' : 'a2',
					fromAgentId: 'a1',
					fromTabId: 'a1-t1',
					question: 'Check the delegated task.',
					...(mode === 'handoff' ? { handoffAnswer: 'Save this answer.' } : {}),
				};
				const first = await runtime.consults.ask(input);
				if (mode !== 'ask' && mode !== 'handoff') {
					const reason =
						mode === 'copied'
							? /parent is unavailable/
							: mode === 'sink'
								? /The lease for this launch is released/
								: ['withdrawn', 'admission', 'observer'].includes(mode)
									? /Source withdrawn/
									: mode === 'host-denial'
										? /policy says no/
										: /does not match its authenticated parent/;
					expect(errorOf(first).message).toMatch(reason);
					expect(asked).toHaveLength(
						['admission', 'observer', 'sink', 'host-denial'].includes(mode) ? 1 : 0
					);
					if (mode !== 'sink') expect(provider.calls).toEqual([]);
					else expect(provider.calls).toHaveLength(1);
					expect(authority.live()).toEqual([]);
					expect(issued).toHaveLength(['admission', 'observer', 'sink'].includes(mode) ? 1 : 0);
					for (const lease of issued) {
						expect(lease.pid()).toBeUndefined();
						expect(lease.ended()).toMatchObject({
							state: 'released',
							release: {
								outcome: 'spawn-failed',
								message: expect.stringContaining('Source withdrawn'),
							},
						});
					}
					firstAttempt = false;
					record = saved;
					source = verified;
					expect(value(await runtime.consults.ask(input)).answer).toBe('Verified child answer.');
				} else expect(value(first).answer).toBe('Verified child answer.');
				const lineage = lineageOf(provider.callsFor('consult').length - 1);
				expect(lineage).toMatchObject({
					workflow: saved.delegation.workflow,
					policyRevision: 1,
					identity: { rootRunId: 'run-7', parentRunId: 'run-7' },
					delegation: {
						chain: [
							...saved.delegation.delegation.chain,
							{ kind: 'agent', id: input.targetAgentId },
						],
						grantRef: 'grant-1',
					},
				});
				expect(asked.at(-1)!.context.actor).not.toEqual(verified.context.actor);
				expect(delegationContextOf(asked.at(-1)!.context)).toEqual(lineage);
				expect(permissionMode(provider.calls.at(-1)!.spec.args)).toBe('plan');
				expect(parentContext).toHaveBeenCalledWith(provider.calls.at(-1)!.processId);
				expect(parentContext.mock.calls.length).toBeGreaterThanOrEqual(4);
				expect(authority.live()).toEqual([]);
			});
		});

		describe('trusted consult source custody', () => {
			let current: ReturnType<NonNullable<typeof initiator>>;
			let unreadable: boolean;
			beforeEach(() => {
				current = namedInitiator(1, true)({ agentId: 'a1' })!;
				current.delegation.workflow = {
					workflowId: 'workflow-1',
					version: 'v1',
					triggerEventId: 'trigger-1',
					ownerEpoch: 'epoch-1',
					fencingToken: 'fence-1',
				};
				current.delegation.delegation.grantRef = 'grant-1';
				unreadable = false;
				initiator = vi.fn(() => {
					if (unreadable) throw new Error('source custody unavailable');
					return current;
				});
			});

			it.each(['missing', 'unreadable', 'malformed'] as const)(
				'refuses %s initial custody without an inferred fallback, then recovers',
				async (change) => {
					const asked: AdmissionRequest[] = [];
					const runtime = await startEnrolled(() => 'allow', asked);
					const saved = structuredClone(current);
					if (change === 'missing') current = null;
					if (change === 'unreadable') unreadable = true;
					if (change === 'malformed') current!.delegation.identity.requestId = '';
					const input = {
						targetAgentId: 'a2',
						fromAgentId: 'a1',
						fromTabId: 'a1-t1',
						question: 'Why?',
					};
					expect(errorOf(await runtime.consults.ask(input)).message).toMatch(/initiator|custody/i);
					expect(provider.calls).toEqual([]);
					expect(asked).toEqual([]);
					expect(consultTab('a2')).toBeUndefined();
					current = saved;
					unreadable = false;
					value(await runtime.consults.ask(input));
					expect(initiator).toHaveBeenCalledWith({ agentId: 'a1', tabId: 'a1-t1' });
					expect(lineageOf(0)).toMatchObject({
						workflow: saved!.delegation.workflow,
						delegation: {
							grantRef: 'grant-1',
							chain: [
								{ kind: 'agent', id: 'a1' },
								{ kind: 'agent', id: 'a2' },
							],
						},
						identity: { parentRunId: 'run-7', rootRunId: 'run-7' },
					});
				}
			);

			it.each(['missing', 'unreadable', 'grant', 'fence', 'policy', 'access', 'run'] as const)(
				'refuses %s custody after queueing and authorizes a fresh request',
				async (change) => {
					const asked: AdmissionRequest[] = [];
					const runtime = await startEnrolled(
						() => 'allow',
						asked,
						(call) => ({ text: `answer ${call.nth}`, hold: call.nth === 1 })
					);
					const input = { targetAgentId: 'a2', fromAgentId: 'a1', question: 'First' };
					const first = runtime.consults.ask(input);
					await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));
					const queued = runtime.consults.ask({ ...input, question: 'Queued with old custody' });
					expect(runtime.consultsInFlight()).toBe(2);
					const saved = structuredClone(current);
					if (change === 'missing') current = null;
					if (change === 'unreadable') unreadable = true;
					if (change === 'grant') current!.delegation.delegation.grantRef = 'grant-2';
					if (change === 'fence') current!.delegation.workflow!.fencingToken = 'fence-2';
					if (change === 'policy') current!.delegation.policyRevision = 2;
					if (change === 'access') current!.writable = false;
					if (change === 'run') current!.delegation.identity.runId = 'new-source-run';
					value(await runtime.turns.interrupt('a1', 'a1-t1'));
					expect(errorOf(await first).code).toBe('rejected');
					expect(errorOf(await queued).message).toMatch(/initiator|custody/i);
					expect(provider.callsFor('consult')).toHaveLength(1);
					expect(asked).toHaveLength(1);
					expect(
						consultTab('a2').logs.some(
							(log: { text: string }) => log.text === 'Queued with old custody'
						)
					).toBe(false);
					if (!current) current = saved;
					unreadable = false;
					value(
						await runtime.consults.ask({ ...input, question: 'Fresh', handoffAnswer: 'Do this' })
					);
					expect(provider.callsFor('consult')).toHaveLength(2);
					expect(asked).toHaveLength(2);
					expect(lineageOf(1)).toMatchObject({
						workflow: current!.delegation.workflow,
						delegation: { grantRef: current!.delegation.delegation.grantRef },
						identity: { parentRunId: current!.delegation.identity.runId },
					});
					expect(permissionMode(provider.callsFor('consult')[1].spec.args)).toBe(
						change === 'access' ? 'plan' : undefined
					);
					expect(
						provider.callsFor('consult')[1].spec.args.includes('--dangerously-skip-permissions')
					).toBe(change !== 'access');
				}
			);

			it('refuses custody withdrawn while preparing the consult before runner handoff', async () => {
				const asked: AdmissionRequest[] = [];
				const runtime = await startEnrolled(() => 'allow', asked);
				const entered = Promise.withResolvers<void>();
				const proceed = Promise.withResolvers<void>();
				probeBinary = async () => {
					entered.resolve();
					await proceed.promise;
					return { exists: true, path: '/fake/bin/claude' };
				};
				const input = { targetAgentId: 'a2', fromAgentId: 'a1', question: 'Prepare this' };
				const pending = runtime.consults.ask(input);
				await entered.promise;
				const saved = current;
				current = null;
				proceed.resolve();
				expect(errorOf(await pending).message).toMatch(/initiator|custody/i);
				expect(provider.calls).toEqual([]);
				expect(asked).toEqual([]);
				expect(consultTab('a2').logs.at(-1).source).toBe('error');
				current = saved;
				value(await runtime.consults.ask(input));
				expect(provider.callsFor('consult')).toHaveLength(1);
			});

			it('requires a known source when the host supplies an initiator lookup', async () => {
				const asked: AdmissionRequest[] = [];
				const runtime = await startEnrolled(() => 'allow', asked);
				for (const fromAgentId of [undefined, 'unknown']) {
					expect(
						errorOf(
							await runtime.consults.ask({
								targetAgentId: 'a2',
								question: 'Unattributed',
								fromAgentId,
							})
						).message
					).toMatch(/initiator|custody/i);
				}
				expect(provider.calls).toEqual([]);
				expect(asked).toEqual([]);
				expect(consultTab('a2')).toBeUndefined();
			});

			describe.each(['admission', 'observer', 'sink'] as const)('%s boundary', (boundary) => {
				it.each(['missing', 'unreadable', 'grant', 'fence', 'policy', 'access', 'run'] as const)(
					'refuses %s custody after runner handoff, releases the lease and recovers',
					async (change) => {
						const asked: AdmissionRequest[] = [];
						const saved = structuredClone(current);
						let recovered = false;
						const withdraw = () => {
							if (recovered) return;
							if (change === 'missing') current = null;
							if (change === 'unreadable') unreadable = true;
							if (change === 'grant') current!.delegation.delegation.grantRef = 'grant-2';
							if (change === 'fence') current!.delegation.workflow!.fencingToken = 'fence-2';
							if (change === 'policy') current!.delegation.policyRevision = 2;
							if (change === 'access') current!.writable = false;
							if (change === 'run') current!.delegation.identity.runId = 'new-source-run';
						};
						const runtime = await startEnrolled(
							() => 'allow',
							asked,
							() => {
								if (boundary === 'sink') withdraw();
								return { text: 'Fresh answer' };
							}
						);
						const issued: DispatchLease[] = [];
						const admit = authority.admit.bind(authority);
						vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
							const result = await admit(request);
							if (result.state === 'admitted') issued.push(result.lease);
							if (boundary === 'admission') withdraw();
							return result;
						});
						onBackgroundAdmission = (event) => {
							if (boundary === 'observer' && event.kind === 'admitted') withdraw();
						};
						const input = {
							targetAgentId: 'a2',
							fromAgentId: 'a1',
							fromTabId: 'a1-t1',
							question: 'Act on this answer',
							handoffAnswer: 'Use a queue',
						};
						expect(errorOf(await runtime.consults.ask(input)).code).toBe('failed');
						expect(admissions).toContainEqual(
							expect.objectContaining({
								kind: 'refused',
								state: 'unavailable',
								message: expect.stringMatching(/custody/i),
							})
						);
						expect(asked).toHaveLength(1);
						expect(issued).toHaveLength(1);
						expect(issued[0].pid()).toBeUndefined();
						expect(issued[0].ended()).toMatchObject({
							state: 'released',
							release: { outcome: 'spawn-failed' },
						});
						expect(authority.live()).toEqual([]);
						expect(runtime.consultsInFlight()).toBe(0);
						if (boundary !== 'sink') expect(provider.calls).toEqual([]);
						expect(consultTab('a2').agentSessionId).toBeNull();
						expect(consultTab('a2').logs.map((log: { source: string }) => log.source)).toEqual([
							'user',
							'error',
						]);
						if (!current) current = saved;
						unreadable = false;
						recovered = true;
						expect(value(await runtime.consults.ask(input)).answer).toBe('Fresh answer');
						expect(asked).toHaveLength(2);
						expect(issued[1].pid()).toBeGreaterThan(0);
						expect(asked[1].context.identity.requestId).not.toBe(
							asked[0].context.identity.requestId
						);
						expect(authority.live()).toEqual([]);
						const last = provider.callsFor('consult').length - 1;
						expect(lineageOf(last)).toMatchObject({
							workflow: current!.delegation.workflow,
							delegation: {
								grantRef: current!.delegation.delegation.grantRef,
								chain: [
									{ kind: 'agent', id: 'a1' },
									{ kind: 'agent', id: 'a2' },
								],
							},
							identity: { parentRunId: current!.delegation.identity.runId, rootRunId: 'run-7' },
						});
						expect(permissionMode(provider.callsFor('consult')[last].spec.args)).toBe(
							change === 'access' ? 'plan' : undefined
						);
					}
				);
			});

			it('keeps concurrent consult source checks independent while one admission is pending', async () => {
				const other = namedInitiator(1, false)({ agentId: 'a3' })!;
				other.delegation.delegation.chain = [{ kind: 'agent', id: 'a3' }];
				initiator = ({ agentId }) => (agentId === 'a3' ? other : current);
				const asked: AdmissionRequest[] = [];
				const runtime = await startEnrolled(() => 'allow', asked);
				const entered = Promise.withResolvers<void>();
				const proceed = Promise.withResolvers<void>();
				const issued: DispatchLease[] = [];
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					const result = await admit(request);
					if (result.state === 'admitted') issued.push(result.lease);
					if (request.context.delegation.chain[0].id === 'a1') {
						entered.resolve();
						await proceed.promise;
					}
					return result;
				});
				const first = runtime.consults.ask({
					targetAgentId: 'a2',
					fromAgentId: 'a1',
					question: 'First',
				});
				try {
					await entered.promise;
					current = null;
					value(
						await runtime.consults.ask({
							targetAgentId: 'a2',
							fromAgentId: 'a3',
							question: 'Other',
						})
					);
					expect(provider.callsFor('consult')).toHaveLength(1);
					expect(lineageOf(0).delegation.chain).toEqual([
						{ kind: 'agent', id: 'a3' },
						{ kind: 'agent', id: 'a2' },
					]);
				} finally {
					proceed.resolve();
				}
				expect(errorOf(await first).message).toMatch(/custody/i);
				expect(issued[0].pid()).toBeUndefined();
				expect(issued[0].ended()).toMatchObject({
					state: 'released',
					release: { outcome: 'spawn-failed' },
				});
				expect(issued[1].pid()).toBeGreaterThan(0);
				expect(authority.live()).toEqual([]);
				expect(runtime.consultsInFlight()).toBe(0);
			});
		});

		it('on an enrolled runtime binds the consult under the host’s generation and admits its process on a lease over the final spec (MRC-07-05)', async () => {
			const asked: AdmissionRequest[] = [];
			const runtime = await startEnrolled(() => 'allow', asked);

			const answer = value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?', fromAgentId: 'a1' })
			);
			expect(answer.answer).toMatch(/^Answer \d+: use a queue\.$/);
			// The stage before the target hears of it refused nothing; the lease was asked for once, on
			// the consult's own context: this host, the headless origin, the chain one link deeper than
			// the asker's, under the host's generation (not the initiator's claim, which was none).
			expect(admissions).toEqual([]);
			expect(asked).toHaveLength(1);
			expect(asked[0].context).toMatchObject({
				installation: { installationId: runtime.installation.installationId },
				origin: 'headless',
				policyRevision: 1,
				workflow: null,
				delegation: {
					chain: [
						{ kind: 'agent', id: 'a1' },
						{ kind: 'agent', id: 'a2' },
					],
					grantRef: null,
				},
			});
			expect(asked[0].snapshot).toMatchObject({
				provider: 'claude-code',
				operation: 'start',
				target: { kind: 'local' },
				resourceIds: [`dir:${work}`],
			});
			// The process ran with the record the admission bound, and the admitted lease is journaled.
			expect(lineageOf(0).identity.requestId).toBe(asked[0].context.identity.requestId);
			expect(backgroundAdmissions).toEqual([
				expect.objectContaining({
					kind: 'admitted',
					leaseId: 'lease-1',
					processId: provider.callsFor('consult')[0].processId,
					delegation: expect.objectContaining({
						identity: expect.objectContaining({ requestId: asked[0].context.identity.requestId }),
					}),
				}),
			]);
		});

		it('on an enrolled runtime a denied lease starts nothing: the consult fails with the decision and the target ran no process', async () => {
			const asked: AdmissionRequest[] = [];
			const runtime = await startEnrolled(() => 'deny', asked);

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?', fromAgentId: 'a1' })
			);
			expect(error.code).toBe('failed');
			expect(error.message).toMatch(/\[managed-denied\]/);
			expect(asked).toHaveLength(1);
			expect(provider.calls).toEqual([]);
			expect(backgroundAdmissions).toEqual([
				expect.objectContaining({ kind: 'refused', state: 'denied', code: 'policy-denied' }),
			]);
			// The question was written before the spawn; the refusal is recorded on the consult tab
			// after it, so the target shows why nothing ran rather than a silent loss.
			const tab = consultTab('a2');
			expect(tab.logs.map((entry: { source: string }) => entry.source)).toEqual(['user', 'error']);
		});
	});
});
