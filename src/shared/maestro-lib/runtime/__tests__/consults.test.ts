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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	promptOf,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { CROSS_AGENT_ASK_SESSION_ID, CROSS_AGENT_ASK_TAB_ID } from '../../../crossAgentTypes';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, MaestroEvent } from '../../client/types';
import { createLocalHostAuthority, type AdmissionRequest } from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import {
	MANAGED_DELEGATION_ENV_VAR,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../managed/delegation';
import { MANAGED_CONTRACT_VERSION } from '../../managed/types';
import { readHistory } from '../../store/read-history';
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
	let initiator: RuntimeDeps['consults']['initiator'];

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
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			background: { runTurn: provider.runTurn },
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
		initiator = undefined;
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

		it('on an enrolled runtime binds the consult on the port under the host’s generation, then refuses it until the runner carries an admission', async () => {
			const asked: AdmissionRequest[] = [];
			const authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide: (request) => {
					asked.push(request);
					return { decision: 'allow', policyRevision: 1 };
				},
				now: () => Date.now(),
				newId: () => 'lease-1',
				leaseTtlMs: 60_000,
			});
			// Enroll this data directory to the fleet authority, as a desktop or host would have.
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
			const runtime = await start(ANSWER, undefined, {}, { authority });
			expect(runtime.managedBinding.state().state).toBe('enrolled');

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Why?', fromAgentId: 'a1' })
			);
			expect(error.code).toBe('host-unavailable');
			expect(error.message).toMatch(/no managed admission yet/);
			// Nothing started, nothing reached the target, and no lease was asked for.
			expect(provider.calls).toEqual([]);
			expect(asked).toEqual([]);
			expect(consultTab('a2')).toBeUndefined();
			expect(admissions).toEqual([
				expect.objectContaining({
					kind: 'refused',
					state: 'unavailable',
					code: 'runtime-unavailable',
					// The host's generation decides, not the initiator's claim (none, standalone lineage).
					message: expect.stringContaining('policy revision none; this host holds 1'),
					delegation: expect.objectContaining({ policyRevision: null }),
				}),
			]);
		});
	});
});
