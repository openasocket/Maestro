/**
 * The runtime's group chats (GC-1 to GC-5): a whole round with no desktop, over a fake provider.
 *
 * The provider is `src/__tests__/fixtures/fake-agent.mjs` replaying a synthesized Claude Code
 * stream, so a turn is a real process on a real pipe: the runtime plans the real process spec
 * (SSH, Claude token source, pipe spec) and starts it through the real run layer; only the command
 * is swapped. The runtime, its repository, the engine, and the chat's storage are real and write
 * to a temp data directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	roleOf,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult } from '../../client/types';
import type { GroupChatEvent, GroupChatRecord } from '../../groupchat/chat';
import {
	createLocalHostAuthority,
	type AdmissionRequest,
	type ContextVerification,
	type HostAuthority,
} from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import {
	delegationContextEnv,
	delegationContextOf,
	readDelegationContextEnv,
} from '../../managed/delegation';
import { createHeadlessSpawnAuthority } from '../../managed/host-adapter';
import type { WorkflowFenceLifetime } from '../../managed/workflows';
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

/** The round every test starts from: the moderator addresses both, each answers, the moderator closes. */
const ROUND: FakeScript = (call) => {
	switch (call.role) {
		case 'moderator':
			return { text: '@Alpha @Beta please look at this and report back.' };
		case 'participant':
			return { text: `${call.participant} says: looks good.` };
		case 'synthesis':
			return { text: 'Both agree it is ready.' };
		default:
			return { text: 'unexpected' };
	}
};

describe('runtime group chats', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	let provider: FakeGroupChatProvider;
	let binaryExists: boolean;

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
			probeBinary: async (binaryName) =>
				binaryExists ? { exists: true, path: `/fake/bin/${binaryName}` } : { exists: false },
			background: { runTurn: provider.runTurn },
		};
	}

	async function start(
		script: FakeScript = ROUND,
		sessions: unknown[] = [
			agentRecord('a1', 'Alpha', work),
			agentRecord('a2', 'Beta', work),
			agentRecord('a3', 'Gamma', work),
			agentRecord('a4', 'Shell', work, { toolType: 'terminal' }),
		],
		managed?: MaestroRuntimeOptions['managed']
	): Promise<MaestroRuntime> {
		provider = createFakeGroupChatProvider(work, script);
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
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

	async function startEnrolled(
		authority: HostAuthority,
		script: FakeScript = ROUND,
		managed: MaestroRuntimeOptions['managed'] = {}
	): Promise<MaestroRuntime> {
		const enroller = await start();
		const binding = createManagedBinding({
			paths: { userDataDir: dir, productionDataDir: dir },
			fence: () => ({ ok: true }),
			authority,
			now: () => T0,
		});
		const enrollment = await binding.enroll({
			installationId: enroller.installation.installationId,
			authorityId: 'fleet',
			endpointRef: 'fixture-endpoint',
			policySources: [],
			policyRevision: 3,
		});
		if (!enrollment.ok) throw new Error(enrollment.message);
		await enroller.connection.close();
		open.splice(open.indexOf(enroller), 1);
		return start(script, undefined, { ...managed, authority });
	}

	/** Collect a chat's events, and let a test wait for a state or a line. */
	function watch(runtime: MaestroRuntime) {
		const events: Array<{ chatId: string; event: GroupChatEvent }> = [];
		runtime.events.subscribe(
			(event) => {
				if (event.type === 'groupChat') events.push({ chatId: event.chatId, event: event.event });
			},
			{ types: ['groupChat'] }
		);
		const of = (kind: GroupChatEvent['kind']) =>
			events.filter((entry) => entry.event.kind === kind).map((entry) => entry.event);
		return {
			events,
			states: () => of('state').map((event) => (event.kind === 'state' ? event.state : '')),
			lines: () =>
				of('message').flatMap((event) =>
					event.kind === 'message' ? [`${event.line.from}: ${event.line.text}`] : []
				),
			working: () =>
				of('participant').flatMap((event) =>
					event.kind === 'participant' ? [`${event.name}:${event.working ? 'on' : 'off'}`] : []
				),
			/** Resolves once the n-th time the room went idle. */
			idle: (count = 1) =>
				vi.waitFor(
					() => {
						if (
							events.filter((e) => e.event.kind === 'state' && e.event.state === 'idle').length <
							count
						) {
							throw new Error(
								`room not idle yet: ${of('state').map((e) => (e.kind === 'state' ? e.state : ''))}`
							);
						}
					},
					{ timeout: 10_000, interval: 20 }
				),
		};
	}

	const startChat = async (runtime: MaestroRuntime, extra: { message?: string } = {}) =>
		value(
			await runtime.groupChats.create({
				name: 'Release review',
				participantIds: ['a1', 'a2'],
				...extra,
			})
		).chatId;

	const readChat = async (runtime: MaestroRuntime, chatId: string): Promise<GroupChatRecord> =>
		value(await runtime.groupChats.get(chatId));

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-gc-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-gc-work-'));
		open = [];
		binaryExists = true;
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('managed moderator refusal recovery', () => {
		it.each(['denied', 'unavailable', 'unknown'] as const)(
			'recovers an initial %s moderator without starting its process',
			async (state) => {
				await refusedRound('moderator', state);
			}
		);
		it.each(['denied', 'unavailable', 'unknown'] as const)(
			'recovers a %s synthesis without starting its process',
			async (state) => {
				await refusedRound('synthesis', state);
			}
		);

		async function refusedRound(
			role: 'moderator' | 'synthesis',
			state: 'denied' | 'unavailable' | 'unknown'
		) {
			const asked: AdmissionRequest[] = [];
			let refuse = true;
			let leases = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet',
				decide: (request) => {
					asked.push(request);
					if (refuse && asked.length === (role === 'moderator' ? 1 : 4)) {
						return state === 'denied'
							? { decision: 'deny', reason: 'Fixture parent revoked.', policyRevision: 3 }
							: { decision: state, reason: 'Fixture custody unanswered.' };
					}
					return { decision: 'allow', policyRevision: 3 };
				},
				newId: () => `lease-${++leases}`,
				now: () => Date.now(),
				leaseTtlMs: 60_000,
			});
			const runtime = await startEnrolled(authority);
			const chat = watch(runtime);
			const created = await runtime.groupChats.create({
				name: 'Managed review',
				participantIds: ['a1', 'a2'],
			});
			if (role === 'moderator') {
				expect(errorOf(created)).toMatchObject({
					code: 'failed',
					message: expect.stringContaining(`[managed-${state}]`),
				});
			} else value(created);
			await chat.idle();
			const [room] = value(await runtime.groupChats.list());
			expect(room.state).toBe('idle');
			if (role === 'synthesis') {
				const history = fs.readFileSync(
					path.join(dir, 'group-chats', room.id, 'history.jsonl'),
					'utf-8'
				);
				expect(history).toContain(`[managed-${state}]`);
			}
			expect(provider.calls).toHaveLength(role === 'moderator' ? 0 : 3);
			const refusedAttempt = asked.at(-1)!.context.identity.attemptId;
			expect(provider.calls.every((call) => call.processId !== refusedAttempt)).toBe(true);
			await vi.waitFor(() => expect(authority.live()).toEqual([]));

			refuse = false;
			const admittedBeforeRetry = asked.length;
			value(await runtime.groupChats.send(room.id, 'Retry with current authority.'));
			await chat.idle(2);
			expect(asked).toHaveLength(admittedBeforeRetry + 4);
			expect(provider.calls).toHaveLength(role === 'moderator' ? 4 : 7);
			expect(
				asked
					.slice(admittedBeforeRetry)
					.every((request) => request.context.identity.attemptId !== refusedAttempt)
			).toBe(true);
			expect(chat.lines()).toContain('moderator: Both agree it is ready.');
			expect((await readChat(runtime, room.id)).state).toBe('idle');
		}
	});

	describe('hosted authenticated parent custody', () => {
		async function enrolled(
			script: FakeScript = ROUND,
			extra: MaestroRuntimeOptions['managed'] = {},
			owned = true
		) {
			const asked: AdmissionRequest[] = [];
			const custody: { current: ContextVerification; onAdmit?: () => void; revision: number } = {
				current: { ok: false, code: 'unauthenticated', problems: ['Parent custody withdrawn.'] },
				revision: 3,
			};
			let leases = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet',
				decide: (request) => {
					asked.push(request);
					custody.onAdmit?.();
					return { decision: 'allow', policyRevision: custody.revision };
				},
				newId: () => `lease-${++leases}`,
				now: () => Date.now(),
				leaseTtlMs: 60_000,
			});
			const parentContext = vi.fn((_processId: string) => custody.current);
			const runtime = await startEnrolled(authority, script, {
				...extra,
				policy: () => ({ sources: [], policyRevision: custody.revision }),
				backgroundParentContext: parentContext,
			});
			const parent = (
				grant = 'grant-1',
				fencingToken = 'fence-1',
				actor = 'source-operator',
				runId = 'cue-run'
			) =>
				createHeadlessSpawnAuthority({
					installation: runtime.installation,
					binding: runtime.managedBinding.state(),
					host: { authority, policy: () => ({ sources: [], policyRevision: 7 }) },
					origin: 'cue',
					actor: { kind: 'human', id: actor },
				}).context({
					traceId: 'cue-trace',
					policyRevision: 7,
					identity: {
						requestId: 'cue-request',
						idempotencyKey: 'cue-request',
						attemptId: 'cue-attempt',
						runId,
						rootRunId: 'root-run',
						parentRunId: 'root-run',
					},
					workflow: owned
						? {
								workflowId: 'nightly',
								version: 'v1',
								triggerEventId: 'cue:1',
								ownerEpoch: 'epoch-1',
								fencingToken,
							}
						: null,
					delegation: { chain: [{ kind: 'agent', id: 'source-agent' }], grantRef: grant },
				});
			custody.current = parent();
			expect(custody.current.ok).toBe(true);
			return { runtime, custody, parent, parentContext, asked, authority };
		}

		it('binds moderator, participant and synthesis processes to the host-verified source', async () => {
			const { runtime, asked, parentContext } = await enrolled();
			const chat = watch(runtime);
			await startChat(runtime);
			await chat.idle();
			expect(provider.calls).toHaveLength(4);
			expect(asked).toHaveLength(4);
			for (const [index, call] of provider.calls.entries()) {
				const stamped = readDelegationContextEnv(call.spec.env);
				expect(stamped.status).toBe('ok');
				if (stamped.status !== 'ok') throw new Error('The child has no delegation context.');
				expect(stamped.context).toMatchObject({
					identity: { requestId: call.processId, rootRunId: 'root-run', parentRunId: 'cue-run' },
					workflow: {
						workflowId: 'nightly',
						version: 'v1',
						triggerEventId: 'cue:1',
						ownerEpoch: 'epoch-1',
						fencingToken: 'fence-1',
					},
					delegation: {
						chain: [
							{ kind: 'agent', id: 'source-agent' },
							{ kind: 'human', id: 'source-operator' },
						],
						grantRef: 'grant-1',
					},
					policyRevision: 3,
				});
				expect(asked[index].context).toMatchObject({
					...stamped.context,
					actor: { kind: 'human', id: `operator:${runtime.installation.installationId}` },
				});
				expect(parentContext).toHaveBeenCalledWith(call.processId);
			}
			expect(chat.lines()).toContain('moderator: Both agree it is ready.');
		});

		it.each(['withdrawn', 'copied', 'throws'] as const)(
			'refuses a %s parent without a child effect',
			async (kind) => {
				const { runtime, custody, parent, parentContext, asked } = await enrolled();
				if (kind === 'withdrawn')
					custody.current = {
						ok: false,
						code: 'unauthenticated',
						problems: ['Parent custody withdrawn.'],
					};
				if (kind === 'copied') custody.current = structuredClone(custody.current);
				if (kind === 'throws')
					parentContext.mockImplementation(() => {
						throw new Error('Custody unavailable.');
					});
				const chat = watch(runtime);
				expect(
					errorOf(
						await runtime.groupChats.create({
							name: 'Parent custody',
							participantIds: ['a1', 'a2'],
						})
					)
				).toMatchObject({
					code: 'failed',
					message: expect.stringMatching(/managed-(denied|unavailable)/),
				});
				const [room] = value(await runtime.groupChats.list());
				expect(room.state).toBe('idle');
				expect(provider.calls).toEqual([]);
				expect(asked).toEqual([]);
				custody.current = parent('fresh-grant');
				parentContext.mockImplementation(() => custody.current);
				value(await runtime.groupChats.send(room.id, 'Retry with verified custody.'));
				await chat.idle(2);
				expect(provider.calls).toHaveLength(4);
				expect(
					asked.every((request) => request.context.delegation.grantRef === 'fresh-grant')
				).toBe(true);
			}
		);

		describe.each(['participants', 'synthesis'] as const)('round custody at %s', (boundary) => {
			it.each(['grant', 'fence', 'actor', 'run'] as const)(
				'refuses a replacement %s until a fresh round',
				async (change) => {
					const { runtime, parent, parentContext, asked, authority } = await enrolled();
					const replacement = parent(
						change === 'grant' ? 'grant-2' : 'grant-1',
						change === 'fence' ? 'fence-2' : 'fence-1',
						change === 'actor' ? 'other-operator' : 'source-operator',
						change === 'run' ? 'other-run' : 'cue-run'
					);
					let firstProcess: string | undefined;
					parentContext.mockImplementation((processId) => {
						firstProcess ??= processId;
						return processId !== firstProcess &&
							(boundary === 'participants' || roleOf(processId).role !== 'participant')
							? replacement
							: parent();
					});
					const chat = watch(runtime);
					const chatId = await startChat(runtime);
					await chat.idle();
					const effects = boundary === 'participants' ? 1 : 3;
					expect(provider.calls).toHaveLength(effects);
					expect(asked).toHaveLength(effects);
					expect(authority.live()).toEqual([]);
					parentContext.mockImplementation(() => replacement);
					value(await runtime.groupChats.send(chatId, 'Start a fresh round.'));
					await chat.idle(2);
					expect(provider.calls).toHaveLength(effects + 4);
					expect(asked.slice(effects)).toHaveLength(4);
					if (!replacement.ok) throw new Error('Expected verified fixture parent.');
					for (const request of asked.slice(effects)) {
						expect(request.context.workflow).toEqual(replacement.context.workflow);
						expect(request.context.delegation.grantRef).toBe(
							replacement.context.delegation.grantRef
						);
						expect(request.context.identity.parentRunId).toBe(replacement.context.identity.runId);
						expect(request.context.delegation.chain).toContainEqual(replacement.context.actor);
					}
					expect(authority.live()).toEqual([]);
				}
			);
		});

		it.each(['substitution', 'withdrawal', 'copy', 'read failure'] as const)(
			'keeps a round refused after a transient parent %s',
			async (change) => {
				const { runtime, parent, parentContext, asked } = await enrolled();
				let substituted = false;
				parentContext.mockImplementation((processId) => {
					if (!substituted && roleOf(processId).role === 'participant') {
						substituted = true;
						if (change === 'withdrawal')
							return { ok: false, code: 'unauthenticated', problems: ['Parent withdrawn.'] };
						if (change === 'copy') return structuredClone(parent());
						if (change === 'read failure') throw new Error('Fixture parent unreadable.');
						return parent('other-grant');
					}
					return parent();
				});
				const chat = watch(runtime);
				const chatId = await startChat(runtime);
				await chat.idle();
				expect(substituted).toBe(true);
				expect(provider.calls).toHaveLength(1);
				expect(asked).toHaveLength(1);
				value(await runtime.groupChats.send(chatId, 'Retry with the original parent.'));
				await chat.idle(2);
				expect(provider.calls).toHaveLength(5);
			}
		);

		it('accepts re-verification and current policy without changing the round parent', async () => {
			const { runtime, custody, parent, parentContext, asked } = await enrolled();
			parentContext.mockImplementation((processId) => {
				if (roleOf(processId).role === 'participant') custody.revision = 4;
				return parent();
			});
			const chat = watch(runtime);
			await startChat(runtime);
			await chat.idle();
			expect(provider.calls).toHaveLength(4);
			expect(asked.map((request) => request.context.policyRevision)).toEqual([3, 4, 4, 4]);
		});

		it('isolates concurrent rounds with different authenticated parents', async () => {
			const { runtime, parent, parentContext, asked, authority } = await enrolled();
			const callers = new AsyncLocalStorage<ContextVerification>();
			parentContext.mockImplementation(
				() => callers.getStore() ?? { ok: false, code: 'unauthenticated', problems: ['No caller.'] }
			);
			const chat = watch(runtime);
			const [first, second] = await Promise.all([
				callers.run(parent('room-one'), () => startChat(runtime)),
				callers.run(parent('room-two'), () => startChat(runtime)),
			]);
			await chat.idle(2);
			expect(provider.calls).toHaveLength(8);
			expect(asked).toHaveLength(8);
			for (const [chatId, grant] of [
				[first, 'room-one'],
				[second, 'room-two'],
			]) {
				const requests = asked.filter((request) =>
					request.context.identity.requestId.includes(chatId)
				);
				expect(requests).toHaveLength(4);
				expect(requests.every((request) => request.context.delegation.grantRef === grant)).toBe(
					true
				);
			}
			expect(authority.live()).toEqual([]);
		});

		it.each(['participants', 'synthesis'] as const)(
			'rechecks custody before %s and reauthorizes a fresh round',
			async (boundary) => {
				const { runtime, custody, parent, parentContext, asked } = await enrolled();
				let firstProcess: string | undefined;
				let withdrawn = true;
				parentContext.mockImplementation((processId) => {
					firstProcess ??= processId;
					return withdrawn &&
						processId !== firstProcess &&
						(boundary === 'participants' || roleOf(processId).role !== 'participant')
						? { ok: false, code: 'unauthenticated', problems: ['Parent custody withdrawn.'] }
						: custody.current;
				});
				const chat = watch(runtime);
				const chatId = await startChat(runtime);
				await chat.idle();
				const effects = boundary === 'participants' ? 1 : 3;
				expect(provider.calls).toHaveLength(effects);
				expect(asked).toHaveLength(effects);
				expect(chat.lines().join('\n')).toContain('@Alpha @Beta please look at this');
				custody.current = parent('grant-2');
				custody.revision = 4;
				withdrawn = false;
				value(await runtime.groupChats.send(chatId, 'Try the renewed grant.'));
				await chat.idle(2);
				expect(provider.calls).toHaveLength(effects + 4);
				expect(asked.slice(effects)).toHaveLength(4);
				for (const request of asked.slice(effects)) {
					expect(request.context).toMatchObject({
						delegation: { grantRef: 'grant-2' },
						policyRevision: 4,
					});
				}
				expect(chat.lines()).toContain('moderator: Both agree it is ready.');
			}
		);

		it.each(['grant', 'fence', 'policy'] as const)(
			'releases an unused lease on a changed %s and permits a fresh retry',
			async (change) => {
				const { runtime, custody, parent, asked, authority } = await enrolled();
				const admission = vi.spyOn(authority, 'admit');
				custody.onAdmit = () => {
					if (change === 'policy') custody.revision = 4;
					else
						custody.current = parent(
							change === 'grant' ? 'replacement-grant' : 'grant-1',
							change === 'fence' ? 'fence-2' : 'fence-1'
						);
				};
				const chat = watch(runtime);
				expect(
					errorOf(
						await runtime.groupChats.create({
							name: 'Parent custody',
							participantIds: ['a1', 'a2'],
						})
					)
				).toMatchObject({ code: 'failed' });
				const [room] = value(await runtime.groupChats.list());
				const chatId = room.id;
				expect(room.state).toBe('idle');
				expect(provider.calls).toEqual([]);
				expect(asked).toHaveLength(1);
				const issued = await admission.mock.results[0].value;
				expect(issued.state).toBe('admitted');
				if (issued.state !== 'admitted') throw new Error('Expected a fixture lease.');
				expect(issued.lease.ended()).toMatchObject({
					state: 'released',
					release: { outcome: 'spawn-failed' },
				});
				expect(authority.live()).toEqual([]);
				custody.onAdmit = undefined;
				value(await runtime.groupChats.send(chatId, 'Try again.'));
				await chat.idle(2);
				expect(provider.calls).toHaveLength(4);
				expect(asked).toHaveLength(5);
				for (const request of asked.slice(1)) {
					expect(request.context).toMatchObject({
						delegation: { grantRef: change === 'grant' ? 'replacement-grant' : 'grant-1' },
						workflow: { fencingToken: change === 'fence' ? 'fence-2' : 'fence-1' },
						policyRevision: change === 'policy' ? 4 : 3,
					});
				}
			}
		);

		it('does not replace withdrawn host custody with caller JSON or environment context', async () => {
			const { runtime, custody, asked } = await enrolled();
			const source = custody.current;
			if (!source.ok) throw new Error('Expected verified fixture custody.');
			const context = delegationContextOf(source.context);
			custody.current = { ok: false, code: 'unauthenticated', problems: ['Parent withdrawn.'] };
			try {
				for (const [key, value] of Object.entries(delegationContextEnv(context)))
					vi.stubEnv(key, value);
				const result = await runtime.groupChats.create({
					name: 'Untrusted custody',
					participantIds: ['a1', 'a2'],
					...{ context, backgroundParentContext: () => source },
				});
				expect(errorOf(result).message).toContain('Parent withdrawn.');
				expect(asked).toEqual([]);
				expect(provider.calls).toEqual([]);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('requires managed standing when the host supplied a parent verifier', async () => {
			const parentContext = vi.fn(
				(): ContextVerification => ({
					ok: false,
					code: 'unauthenticated',
					problems: ['No parent.'],
				})
			);
			const runtime = await start(ROUND, undefined, { backgroundParentContext: parentContext });
			expect(
				errorOf(
					await runtime.groupChats.create({ name: 'Parent custody', participantIds: ['a1', 'a2'] })
				)
			).toMatchObject({
				code: 'failed',
				message: expect.stringContaining('requires managed host standing'),
			});
			const [room] = value(await runtime.groupChats.list());
			expect(room.state).toBe('idle');
			expect(provider.calls).toEqual([]);
			expect(parentContext).not.toHaveBeenCalled();
		});

		describe('a room !autorun', () => {
			const AUTORUN: FakeScript = (call) =>
				call.role === 'moderator' && call.nth === 1
					? { text: '!autorun @Alpha:plan.md' }
					: call.role === 'synthesis'
						? { text: 'Wrapped up.' }
						: { text: 'unexpected' };

			async function withPlan(runtime: MaestroRuntime) {
				const plan = path.join(work, 'plan.md');
				fs.writeFileSync(plan, '- [ ] one\n');
				value(await runtime.agents.update('a1', { autoRunFolderPath: work }));
				const runs: string[] = [];
				runtime.events.subscribe(
					(event) => {
						if (event.type === 'autorun') runs.push(event.agentId);
					},
					{ types: ['autorun'] }
				);
				return { plan, runs };
			}

			// MCOMP-17-03BW: the run is nested under the parent the host verifies for the room turn.
			it('nests the run under the room parent, with its own workflow and fence', async () => {
				const lifetime = {
					signal: new AbortController().signal,
					current: vi.fn(() => true),
					finish: vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined),
				};
				const claim = vi.fn(() => ({ ownerEpoch: 'epoch-9', fencingToken: 'fence-9', lifetime }));
				const { runtime, asked, parentContext } = await enrolled(
					AUTORUN,
					{ workflowFence: claim },
					false
				);
				const { runs } = await withPlan(runtime);
				value(
					await runtime.groupChats.create({
						name: 'Plan room',
						participantIds: ['a1'],
						message: 'Run the plan',
					})
				);
				const nestedOf = () =>
					asked.find((request) => request.context.workflow?.workflowId.includes('runtime-a1-'));
				await vi.waitFor(() => expect(nestedOf()).toBeDefined(), { timeout: 10_000, interval: 20 });
				expect(runs).toContain('a1');
				const moderator = provider.calls[0];
				expect(moderator.role).toBe('moderator');
				// The room's own turns own no workflow: the run's workflow is its own, under its own fence.
				expect(asked[0].context.workflow).toBeNull();
				expect(nestedOf()!.context).toMatchObject({
					identity: { parentRunId: 'cue-run', rootRunId: 'root-run' },
					workflow: { ownerEpoch: 'epoch-9', fencingToken: 'fence-9' },
					delegation: {
						chain: [
							{ kind: 'agent', id: 'source-agent' },
							{ kind: 'human', id: 'source-operator' },
						],
						grantRef: 'grant-1',
					},
				});
				expect(claim).toHaveBeenCalled();
				// Keyed by the moderator turn the directive came from, never a caller's coordinates.
				expect(parentContext).toHaveBeenCalledWith(moderator.processId);
			});

			it('starts no run when the room parent is withdrawn by launch', async () => {
				const { runtime, asked, custody, parentContext } = await enrolled(AUTORUN, {}, false);
				const { plan, runs } = await withPlan(runtime);
				const verified = custody.current;
				const chat = watch(runtime);
				// Verified for the moderator's turn, withdrawn once the room hands Alpha its `!autorun`.
				parentContext.mockImplementation(
					(): ContextVerification =>
						chat.states().includes('agent-working')
							? { ok: false, code: 'unauthenticated', problems: ['Room custody withdrawn.'] }
							: verified
				);
				value(
					await runtime.groupChats.create({
						name: 'Plan room',
						participantIds: ['a1'],
						message: 'Run the plan',
					})
				);
				await vi.waitFor(
					() =>
						expect(chat.lines()).toEqual(
							expect.arrayContaining([
								expect.stringMatching(
									/^Alpha: Auto Run could not start for Alpha: .*Room custody withdrawn\./
								),
							])
						),
					{ timeout: 5_000, interval: 20 }
				);
				expect(runs).toEqual([]);
				expect(runtime.runs.activeRuns()).toEqual([]);
				expect(fs.readFileSync(plan, 'utf8')).toBe('- [ ] one\n');
				expect(asked.every((request) => request.context.workflow === null)).toBe(true);
				expect(provider.calls.map((call) => call.role)).toEqual(['moderator']);
			});

			it('still launches on a managed host that verifies no parent', async () => {
				const authority = createLocalHostAuthority({
					authorityId: 'fleet',
					decide: () => ({ decision: 'allow', policyRevision: 3 }),
					newId: () => `lease-${Math.random()}`,
					now: () => Date.now(),
					leaseTtlMs: 60_000,
				});
				const runtime = await startEnrolled(authority, AUTORUN, {
					policy: () => ({ sources: [], policyRevision: 3 }),
				});
				const { runs } = await withPlan(runtime);
				value(
					await runtime.groupChats.create({
						name: 'Plan room',
						participantIds: ['a1'],
						message: 'Run the plan',
					})
				);
				await vi.waitFor(() => expect(runs).toContain('a1'), { timeout: 10_000, interval: 20 });
			});
		});
	});

	describe('a round (GC-1, GC-2)', () => {
		it('routes the opening message, collects both replies, and posts the synthesis', async () => {
			const runtime = await start();
			const chat = watch(runtime);

			const chatId = await startChat(runtime);
			await chat.idle();

			// The room moved: the moderator read it, the participants worked, the moderator closed it.
			// The synthesis is the moderator thinking again, before the room is free.
			expect(chat.states()).toEqual([
				'moderator-thinking',
				'agent-working',
				'moderator-thinking',
				'idle',
			]);
			expect(new Set(chat.working())).toEqual(
				new Set(['Alpha:on', 'Beta:on', 'Alpha:off', 'Beta:off'])
			);
			expect(chat.lines()).toEqual(
				expect.arrayContaining([
					expect.stringContaining('user: '),
					expect.stringContaining('moderator: @Alpha @Beta please look at this'),
					'Alpha: Alpha says: looks good.',
					'Beta: Beta says: looks good.',
					'moderator: Both agree it is ready.',
				])
			);

			// The chat reads whole from the host: lines in order, both participants on its roster.
			const read = await readChat(runtime, chatId);
			expect(read.name).toBe('Release review');
			expect(read.state).toBe('idle');
			expect(read.participants.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
			expect(read.participants.every((p) => p.provider === 'claude-code')).toBe(true);
			expect(read.lines.map((line) => line.from)).toEqual(
				expect.arrayContaining(['user', 'moderator', 'Alpha', 'Beta'])
			);
			expect(read.lines.at(-1)).toMatchObject({
				from: 'moderator',
				text: 'Both agree it is ready.',
			});
			expect(provider.callsFor('moderator')).toHaveLength(1);
			expect(provider.callsFor('participant')).toHaveLength(2);
			expect(provider.callsFor('synthesis')).toHaveLength(1);
		});

		it('lands the chat in the desktop layout: group-chats/<id>/{metadata.json,chat.log,images}', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const chatDir = path.join(dir, 'group-chats', chatId);
			expect(fs.existsSync(path.join(chatDir, 'metadata.json'))).toBe(true);
			expect(fs.existsSync(path.join(chatDir, 'chat.log'))).toBe(true);
			expect(fs.statSync(path.join(chatDir, 'images')).isDirectory()).toBe(true);
			const metadata = JSON.parse(fs.readFileSync(path.join(chatDir, 'metadata.json'), 'utf-8'));
			expect(metadata).toMatchObject({
				id: chatId,
				name: 'Release review',
				moderatorAgentId: 'claude-code',
			});
			expect(metadata.participants.map((p: { name: string }) => p.name).sort()).toEqual([
				'Alpha',
				'Beta',
			]);
			// The provider session ids of the turns were stored where the chat can resume them.
			expect(metadata.moderatorAgentSessionId).toMatch(/^session-/);
			expect(
				metadata.participants.every((p: { agentSessionId?: string }) => p.agentSessionId)
			).toBe(true);
		});

		it('starts each turn with the real launch: the probed binary, read-only for the moderator', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			await startChat(runtime);
			await chat.idle();

			const [moderator] = provider.callsFor('moderator');
			expect(moderator.spec.command).toBe('/fake/bin/claude');
			expect(moderator.spec.args).toEqual(expect.arrayContaining(['--print', '--output-format']));
			// The moderator reads and routes; it never edits (B16).
			expect(moderator.spec.args.join(' ')).toContain('plan');
			// The agent's own working directory, not the runtime's.
			expect(moderator.spec.cwd).toBeTruthy();
		});

		it('counts a participant that exited non-zero after emitting text as responded (B1)', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Beta'
					? { text: 'Beta: partial findings before the crash.', exitCode: 137 }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const read = await readChat(runtime, chatId);
			expect(
				read.lines.some((line) => line.from === 'Beta' && /partial findings/.test(line.text))
			).toBe(true);
			// The synthesis still ran: the crash did not hold the room.
			expect(provider.callsFor('synthesis')).toHaveLength(1);
		});

		it('closes out a participant that says nothing, silently, so the round still ends (B2)', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Beta'
					? { text: '', exitCode: 1, stderr: 'boom' }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const read = await readChat(runtime, chatId);
			expect(read.lines.some((line) => line.from === 'Beta')).toBe(false);
			expect(read.lines.some((line) => line.from === 'Alpha')).toBe(true);
			expect(provider.callsFor('synthesis')).toHaveLength(1);
			expect(read.state).toBe('idle');
		});

		it("records each turn's usage on the participant's card, before the round moves on", async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			const metadata = JSON.parse(
				fs.readFileSync(path.join(dir, 'group-chats', chatId, 'metadata.json'), 'utf-8')
			);
			for (const participant of metadata.participants) {
				// 1000 input + 200 cache read + 100 cache creation, of the agent's default window.
				expect(participant).toMatchObject({ totalCost: 0.01, tokenCount: 1300, contextUsage: 1 });
			}
			// Idle precedes the synthesis history append; wait for the entry and its usage together.
			await vi.waitFor(
				() => {
					const history = fs
						.readFileSync(path.join(dir, 'group-chats', chatId, 'history.jsonl'), 'utf-8')
						.trim()
						.split('\n')
						.map((line) => JSON.parse(line));
					const turns = history.filter((entry) => entry.type !== 'user');
					expect(turns.map((entry) => entry.type).sort()).toEqual([
						'delegation',
						'response',
						'response',
						'synthesis',
					]);
					expect(turns.every((entry) => entry.cost === 0.01 && entry.tokenCount === 1350)).toBe(
						true
					);
				},
				{ timeout: 10_000, interval: 20 }
			);
		});
	});

	describe('a message into a chat (GC-2)', () => {
		it('takes one round at a time: send is refused while the room works, and accepted when idle', async () => {
			let hold = true;
			const runtime = await start((call) =>
				call.role === 'participant' && call.participant === 'Alpha' && hold
					? { text: 'Alpha: still going.', hold: true }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant').length).toBeGreaterThan(0), {
				timeout: 10_000,
			});
			await vi.waitFor(async () =>
				expect((await readChat(runtime, chatId)).state).not.toBe('idle')
			);

			const refused = errorOf(await runtime.groupChats.send(chatId, 'Another thing'));
			expect(refused.code).toBe('rejected');
			expect(refused.message).toMatch(/still working/);

			// Stop ends the round; the room is free again.
			hold = false;
			value(await runtime.groupChats.stop(chatId));
			await chat.idle();
			expect((await readChat(runtime, chatId)).state).toBe('idle');

			value(await runtime.groupChats.send(chatId, 'Try again'));
			await chat.idle(2);
			expect(provider.callsFor('moderator').length).toBeGreaterThanOrEqual(2);
		});

		it('refuses an empty message and an unknown chat', async () => {
			const runtime = await start();
			expect(errorOf(await runtime.groupChats.send('nope', '   ')).code).toBe('invalid');
			expect(errorOf(await runtime.groupChats.send('nope', 'hello')).code).toBe('not-found');
		});

		it('hands an @participant message to that participant, and only that one (GC-5)', async () => {
			const runtime = await start((call) => {
				if (call.role !== 'moderator') return ROUND(call);
				// Round one routes to both. In round two the moderator names nobody at first; the user's
				// own @mention requires a handoff (B6), so the engine asks it once more and it names Beta.
				if (call.nth === 1) return ROUND(call);
				return call.nth === 2
					? { text: 'Understood.' }
					: { text: '@Beta please double-check the changelog.' };
			});
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();
			const before = provider.callsFor('participant').length;

			value(await runtime.groupChats.send(chatId, '@Beta can you double-check the changelog?'));
			await chat.idle(2);

			const addressed = provider.callsFor('participant').slice(before);
			expect(addressed.map((call) => call.participant)).toEqual(['Beta']);
			const read = await readChat(runtime, chatId);
			expect(read.lines.filter((line) => line.from === 'Beta')).toHaveLength(2);
			expect(read.lines.filter((line) => line.from === 'Alpha')).toHaveLength(1);
		});

		it('adds an agent the user @mentions to the roster, and it takes its turn (B7)', async () => {
			const runtime = await start((call) => {
				if (call.role !== 'moderator' || call.nth === 1) return ROUND(call);
				return call.nth === 2 ? { text: 'Welcome.' } : { text: '@Gamma welcome, please weigh in.' };
			});
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			value(await runtime.groupChats.send(chatId, '@Gamma join us and weigh in'));
			await chat.idle(2);

			const read = await readChat(runtime, chatId);
			expect(read.participants.map((p) => p.name)).toContain('Gamma');
			expect(provider.callsFor('participant').some((call) => call.participant === 'Gamma')).toBe(
				true
			);
		});
	});

	describe('stopping and deleting (GC-3)', () => {
		it('stops the round: the held participant ends, no synthesis runs, the room is idle', async () => {
			const runtime = await start((call) =>
				call.role === 'participant'
					? { text: `${call.participant}: working.`, hold: true }
					: ROUND(call)
			);
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});
			expect(runtime.roundsInFlight()).toBe(1);
			// The held processes are the chat's, not the agents': nothing reads busy because of them.
			expect(runtime.turnsInFlight()).toBe(0);

			value(await runtime.groupChats.stop(chatId));
			await chat.idle();

			expect(provider.callsFor('synthesis')).toHaveLength(0);
			expect(runtime.roundsInFlight()).toBe(0);
			// Stop reports each participant idle, and so does each stopped process as it
			// ends, so two is the floor, not the total.
			await vi.waitFor(() =>
				expect(chat.working().filter((w) => w.endsWith(':off')).length).toBeGreaterThanOrEqual(2)
			);
		});

		it('deletes a chat: its processes stop and its folder goes', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' ? { text: 'working', hold: true } : ROUND(call)
			);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});

			value(await runtime.groupChats.remove(chatId));

			expect(fs.existsSync(path.join(dir, 'group-chats', chatId))).toBe(false);
			expect(errorOf(await runtime.groupChats.get(chatId)).code).toBe('not-found');
			expect(value(await runtime.groupChats.list()).map((c) => c.id)).not.toContain(chatId);
			expect(errorOf(await runtime.groupChats.remove(chatId)).code).toBe('not-found');
		});

		it('renames a chat, and lists it without its lines', async () => {
			const runtime = await start();
			const chat = watch(runtime);
			const chatId = await startChat(runtime);
			await chat.idle();

			value(await runtime.groupChats.rename(chatId, '  Shipping  '));
			const listed = value(await runtime.groupChats.list());
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ id: chatId, name: 'Shipping', lines: [] });
			expect(errorOf(await runtime.groupChats.rename(chatId, '  ')).code).toBe('invalid');
			expect(errorOf(await runtime.groupChats.rename('nope', 'x')).code).toBe('not-found');
		});

		it('shutdown stops a round in flight and leaves the log written', async () => {
			const runtime = await start((call) =>
				call.role === 'participant' ? { text: 'working', hold: true } : ROUND(call)
			);
			const chatId = await startChat(runtime);
			await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
				timeout: 10_000,
			});

			await runtime.connection.close();

			const log = fs.readFileSync(path.join(dir, 'group-chats', chatId, 'chat.log'), 'utf-8');
			expect(log).toContain('please look at this');
		});
	});

	describe('creating a chat (GC-1)', () => {
		it('checks the request the way the desktop does: unknown agent, terminal, nobody', async () => {
			const runtime = await start();
			const create = (participantIds: string[], extra = {}) =>
				runtime.groupChats.create({ name: 'Room', participantIds, ...extra });

			expect(errorOf(await create(['zzz'])).code).toBe('not-found');
			expect(errorOf(await create(['a4'])).message).toMatch(/terminal agent/);
			expect(errorOf(await create([])).message).toMatch(/at least one participant/i);
			expect(errorOf(await create(['a1'], { moderatorAgentId: 'zzz' })).code).toBe('not-found');
			expect(
				errorOf(await runtime.groupChats.create({ name: ' ', participantIds: ['a1'] })).code
			).toBe('invalid');
			expect(value(await runtime.groupChats.list())).toEqual([]);
		});

		it('refuses a name two agents answer to, so a mention picks out one', async () => {
			const runtime = await start(ROUND, [
				agentRecord('a1', 'Review Bot', work),
				agentRecord('a2', 'review-bot', work),
			]);
			const error = errorOf(
				await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })
			);
			expect(error.code).toBe('invalid');
			expect(error.message).toMatch(/2 agents answer to @Review Bot/);
		});

		it('moderates with the named provider, or the named agent, or the first participant', async () => {
			const runtime = await start((call) =>
				call.role === 'moderator' ? { text: 'Fine.' } : ROUND(call)
			);
			const chat = watch(runtime);
			const named = value(
				await runtime.groupChats.create({
					name: 'By provider',
					participantIds: ['a1'],
					moderatorProvider: 'claude-code',
				})
			).chatId;
			await chat.idle();
			expect((await readChat(runtime, named)).moderatorProvider).toBe('claude-code');

			const byAgent = value(
				await runtime.groupChats.create({
					name: 'By agent',
					participantIds: ['a1'],
					moderatorAgentId: 'a2',
				})
			).chatId;
			await chat.idle(2);
			expect((await readChat(runtime, byAgent)).moderatorProvider).toBe('claude-code');
		});

		it('says the chat exists but the opening message failed when the provider is not installed', async () => {
			binaryExists = false;
			const runtime = await start();
			const error = errorOf(
				await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })
			);
			expect(error.code).toBe('failed');
			expect(error.message).toMatch(/created, but the opening message failed.*not available/);
			// The chat is there to read, and idle: nothing is stuck working.
			const [only] = value(await runtime.groupChats.list());
			expect(only.state).toBe('idle');
		});

		it('refuses to start work once the runtime is closed', async () => {
			const runtime = await start();
			await runtime.connection.close();
			expect(
				errorOf(await runtime.groupChats.create({ name: 'Room', participantIds: ['a1'] })).code
			).toBe('host-unavailable');
		});
	});
});
