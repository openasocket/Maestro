/**
 * The Auto Run turn runner when the provider refuses the effort a turn asked for: it runs the turn
 * once more at the agent's own effort, as the CLI and the desktop do. Each turn is the real
 * `runAgentTurn` over the fake agent, replaying a refusal or an answer.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../run/run-to-completion', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../run/run-to-completion')>()),
}));

import * as processTurns from '../../run/run-to-completion';
import { claudeStream } from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import {
	FAKE_AGENT_PATH,
	writeFakeTurn,
} from '../../../../__tests__/shared/maestro-lib/run/fakeAgent';
import { getEffortRejection, resetEffortRejections } from '../../../effortRejection';
import type { AutoRunOwnerFence, AutoRunWorkflowIdentity } from '../../autorun/attribution';
import {
	createContextVerifier,
	createLocalHostAuthority,
	type AdmissionOutcome,
	type AdmissionRequest,
	type ContextVerification,
	type DispatchLease,
	type PolicyDecision,
} from '../../managed/authority';
import { createManagedBinding } from '../../managed/binding';
import {
	delegationContextOf,
	MANAGED_DELEGATION_ENV_VAR,
	MAX_DELEGATION_DEPTH,
	readDelegationContextEnv,
} from '../../managed/delegation';
import { createHeadlessSpawnAuthority, installationIdentity } from '../../managed/host-adapter';
import type { WorkflowFenceLifetime } from '../../managed/workflows';
import { resolveMaestroPaths } from '../../paths/resolve';
import type { AgentRecord } from '../../store/records';
import type { AssembledTurn } from '../../turns/assemble';
import { runAgentTurn, type RunAgentTurnOptions } from '../../turns/run-agent-turn';
import {
	createAutoRunTurnRunner,
	type AutoRunAdmissionEvent,
	type AutoRunSpawnAuthorityPort,
	type AutoRunTurnRunnerOptions,
} from '../autorun-turns';
import { createProcessRegistry } from '../processes';

const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

/** Codex's answer to a retired effort value, as the Responses API words it. */
const REFUSAL = JSON.stringify({
	type: 'error',
	status: 400,
	error: {
		message:
			"Unsupported value: 'minimal' is not supported with the 'gpt-6-astra' model. " +
			"Supported values are: 'low', 'medium', 'high'.",
		param: 'reasoning.effort',
	},
});

/** `hold`: answer, then stay running until stopped (a turn mid-work, for a revocation to reach). */
type Reply = 'refuse' | 'fail' | 'answer' | 'hold';

describe('Auto Run turns: a refused effort, and the fence claimed per attempt', () => {
	let dir: string;
	/** The effort each turn was assembled with, in order (assembled, which is before the authority is asked). */
	let efforts: Array<string | undefined>;
	/** How many processes actually started: the fake agent writes one file per process it runs as. */
	const startedProcesses = (): number =>
		fs.readdirSync(dir).filter((name) => name.startsWith('started-')).length;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-autorun-turns-'));
		efforts = [];
		resetEffortRejections();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function runner(
		replies: Reply[],
		extra: Pick<AutoRunTurnRunnerOptions, 'workflow' | 'managed'> = {},
		customEnvVars?: Record<string, string>,
		prepare?: (options: RunAgentTurnOptions, turn: AssembledTurn) => void | Promise<void>
	) {
		const record = {
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: dir,
			projectRoot: dir,
			customEnvVars,
		} as unknown as AgentRecord;
		return createAutoRunTurnRunner({
			...extra,
			agentId: 'a1',
			paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
			repository: { getAgent: () => record },
			registry: createProcessRegistry({ waitMs: 2_000 }),
			statsRecorder: { recordQuery: async () => ({ ok: true, id: 'q1' }) },
			host: { bundledPromptsDir: BUNDLED_PROMPTS },
			deps: {
				now: () => Date.now(),
				probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
				runAgentTurn: async (turn: AssembledTurn, options) => {
					efforts.push(turn.settings.effort);
					await prepare?.(options, turn);
					const reply = replies.shift() ?? 'answer';
					const recording = writeFakeTurn(
						dir,
						reply === 'answer' || reply === 'hold'
							? { chunks: claudeStream('Done.', 'sess-1'), close: { code: 0, signal: null } }
							: {
									chunks: [],
									stderr: reply === 'refuse' ? `${REFUSAL}\n` : 'something else broke\n',
									close: { code: 1, signal: null },
								}
					);
					return runAgentTurn(
						{
							...turn,
							launch: {
								...turn.launch,
								command: process.execPath,
								args: [FAKE_AGENT_PATH, ...turn.launch.args],
								sessionCustomEnvVars: {
									...turn.launch.sessionCustomEnvVars,
									FAKE_AGENT_RECORDING: recording,
									FAKE_AGENT_ARGV_OUT: path.join(dir, `started-${efforts.length}.json`),
									FAKE_AGENT_ENV_OUT: path.join(dir, `env-${efforts.length}.json`),
									...(reply === 'hold' ? { FAKE_AGENT_HOLD: '1' } : {}),
								},
							},
						},
						{ ...options, stopGraceMs: 200 }
					);
				},
			},
			onStream: () => undefined,
		});
	}

	it('runs the turn once more without the effort, and notes the refusal', async () => {
		const result = await runner(['refuse', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal', undefined]);
		expect(result).toMatchObject({ success: true, response: 'Done.' });
		expect(getEffortRejection('claude-code', 'minimal')).toBeDefined();
	});

	it('does not retry a turn that sent no effort of its own', async () => {
		const result = await runner(['refuse']).run({ purpose: 'task', prompt: 'do the task' });

		expect(efforts).toEqual([undefined]);
		expect(result.success).toBe(false);
	});

	it('does not retry a failure that is not a refused effort', async () => {
		const result = await runner(['fail', 'answer']).run({
			purpose: 'task',
			prompt: 'do the task',
			effort: 'minimal',
		});

		expect(efforts).toEqual(['minimal']);
		expect(result.success).toBe(false);
	});

	/**
	 * Under management (MRC-07-06A): the workflow's owner fence is claimed on every attempt for
	 * that attempt's request and attempt ids, through the host's producer seam, and the producer's
	 * refusal is the turn's reason. The port is the real headless spawn authority over a binding
	 * enrolled in the temp data directory to a local authority that allows everything, a double.
	 */
	describe('the fence claimed per attempt', () => {
		const workflow: AutoRunWorkflowIdentity = {
			workflowId: 'playbook:nightly',
			version: 'v1',
			triggerEventId: 'cli:launch:1',
			runId: 'run-1',
		};

		const FENCE: AutoRunOwnerFence = { ownerEpoch: '2', fencingToken: 'fence-2' };
		const ALLOW: PolicyDecision = { decision: 'allow', policyRevision: 1 };

		/**
		 * The port, and the authority behind it so a test can revoke what it minted. `decide` is
		 * the policy table double; the default allows everything.
		 */
		async function managedPort(
			decide: (request: AdmissionRequest) => PolicyDecision = () => ALLOW
		): Promise<{
			port: AutoRunSpawnAuthorityPort;
			authority: ReturnType<typeof createLocalHostAuthority>;
		}> {
			let leases = 0;
			const authority = createLocalHostAuthority({
				authorityId: 'fleet-authority',
				decide,
				now: () => Date.now(),
				newId: () => `lease-${++leases}`,
				leaseTtlMs: 60_000,
			});
			const binding = createManagedBinding({
				paths: { userDataDir: dir, productionDataDir: dir },
				fence: () => ({ ok: true }),
				authority,
				now: () => Date.now(),
			});
			const installation = installationIdentity({
				hostname: 'testhost',
				productionDataDir: dir,
				mode: 'tui',
				pid: 1,
				startedAt: new Date().toISOString(),
			});
			const enrolled = await binding.enroll({
				installationId: installation.installationId,
				authorityId: 'fleet-authority',
				endpointRef: 'ep',
				policySources: [],
				policyRevision: 1,
			});
			if (!enrolled.ok) throw new Error(enrolled.message);
			const port = createHeadlessSpawnAuthority({
				installation,
				binding: binding.state(),
				host: { authority, policy: () => ({ sources: [], policyRevision: 1 }) },
				origin: 'headless',
				actor: { kind: 'human', id: 'operator' },
			});
			return { port, authority };
		}

		describe('trusted incoming Auto Run delegation', () => {
			function parentOf(port: AutoRunSpawnAuthorityPort) {
				const bound = port.context({
					identity: {
						requestId: 'cue-request',
						idempotencyKey: 'cue-request',
						attemptId: 'cue-attempt',
						runId: 'cue-run',
						rootRunId: 'pipeline-root',
						parentRunId: 'pipeline-parent',
					},
					traceId: 'cue-trace',
					policyRevision: 1,
					workflow: {
						workflowId: workflow.workflowId,
						version: workflow.version,
						triggerEventId: workflow.triggerEventId,
						...FENCE,
					},
					delegation: { chain: [{ kind: 'human', id: 'source-human' }], grantRef: 'source-grant' },
				});
				if (!bound.ok) throw new Error(bound.problems.join('; '));
				const parent = createContextVerifier({
					...bound.context.verification,
					now: Date.now,
					accept: () => [],
				}).verify({ ...bound.context, actor: { kind: 'agent', id: 'source-agent' } });
				if (!parent.ok) throw new Error(parent.problems.join('; '));
				return parent;
			}

			it.each(['synopsis', 'goal-handoff'] as const)(
				'preserves incoming custody through an effort retry and %s in real child environments',
				async (purpose) => {
					const requests: AdmissionRequest[] = [];
					const { port } = await managedPort((request) => {
						requests.push(request);
						return ALLOW;
					});
					const parent = parentOf(port);
					const parentContext = vi.fn(() => {
						parent.context.verification.verifiedAt = new Date(
							Date.parse(parent.context.verification.verifiedAt) + 1
						).toISOString();
						return parent;
					});
					const turns = runner(['refuse', 'answer', 'answer'], {
						workflow,
						managed: { port, fence: () => FENCE, parentContext },
					});
					expect(
						await turns.run({ purpose: 'task', prompt: 'work', effort: 'minimal' })
					).toMatchObject({ success: true });
					expect(
						await turns.run({ purpose, prompt: 'summary', resumeSessionId: 'sess-1' })
					).toMatchObject({ success: true });
					expect(startedProcesses()).toBe(3);
					expect(requests).toHaveLength(3);
					for (const [index, { context }] of requests.entries()) {
						const env = JSON.parse(
							fs.readFileSync(path.join(dir, `env-${index + 1}.json`), 'utf8')
						);
						expect(readDelegationContextEnv(env)).toEqual({
							status: 'ok',
							context: delegationContextOf(context),
						});
						expect(context.identity.rootRunId).toBe('pipeline-root');
						expect(context.identity.parentRunId).toBe(
							index === 2 ? requests[1].context.identity.runId : 'cue-run'
						);
						expect(context.workflow).toEqual(parent.context.workflow);
						expect(context.delegation).toEqual({
							chain: [
								{ kind: 'human', id: 'source-human' },
								{ kind: 'agent', id: 'source-agent' },
							],
							grantRef: 'source-grant',
						});
						expect(context.actor).toEqual({ kind: 'human', id: 'operator' });
					}
					expect(requests[0].context.identity.requestId).toBe(
						requests[1].context.identity.requestId
					);
					expect(requests[0].context.identity.attemptId).not.toBe(
						requests[1].context.identity.attemptId
					);
					expect(parentContext.mock.calls.length).toBeGreaterThan(3);
				}
			);

			it.each([
				'withdrawn',
				'throwing',
				'unverified',
				'workflow',
				'fence',
				'standalone',
				'depth',
			] as const)('refuses a %s incoming source before creating a child', async (change) => {
				const decide = vi.fn(() => ALLOW);
				const { port } = await managedPort(decide);
				const parent = parentOf(port);
				if (change === 'workflow') parent.context.workflow!.version = 'different-version';
				if (change === 'fence') parent.context.workflow!.fencingToken = 'stale-fence';
				if (change === 'standalone') port.standing = () => 'standalone';
				if (change === 'depth')
					parent.context.delegation.chain = Array.from(
						{ length: MAX_DELEGATION_DEPTH },
						(_, i) => ({
							kind: 'agent',
							id: `prior-${i}`,
						})
					);
				const result = await runner(['answer'], {
					workflow,
					managed: {
						port,
						fence: () => FENCE,
						parentContext: () => {
							if (change === 'throwing') throw new Error('parent unavailable');
							if (change === 'unverified')
								return { ok: true, context: structuredClone(parent.context) };
							if (change === 'withdrawn')
								return { ok: false, code: 'unauthenticated', problems: ['parent revoked'] };
							return parent;
						},
					},
				}).run({ purpose: 'task', prompt: 'work' });
				expect(result.success).toBe(false);
				expect(result.managed).toBeDefined();
				expect(decide).not.toHaveBeenCalled();
				expect(startedProcesses()).toBe(0);
			});

			describe.each(['fence', 'preparation', 'admission', 'spawn gate'] as const)(
				'%s source recheck',
				(boundary) => {
					it.each(['grant', 'actor', 'withdrawn', 'throwing', 'unverified'] as const)(
						'refuses %s drift, releases unused custody and permits a fresh retry',
						async (change) => {
							const { port, authority } = await managedPort();
							const parent = parentOf(port);
							let changed = false;
							let enabled = true;
							const mutate = () => {
								if (enabled) changed = true;
							};
							const issued: DispatchLease[] = [];
							const original = authority.admit.bind(authority);
							vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
								const outcome = await original(request);
								if (outcome.state === 'admitted') issued.push(outcome.lease);
								if (boundary === 'admission') mutate();
								return outcome;
							});
							const turns = runner(
								['answer', 'answer'],
								{
									workflow,
									managed: {
										port,
										onAdmission: (event) => {
											if (event.kind === 'admitted' && boundary === 'spawn gate') mutate();
										},
										fence: async () => {
											if (boundary === 'fence') mutate();
											return FENCE;
										},
										parentContext: (): ContextVerification => {
											if (!changed) return parent;
											if (change === 'unverified')
												return { ok: true, context: structuredClone(parent.context) };
											if (change === 'throwing') throw new Error('parent read failed');
											if (change === 'withdrawn')
												return { ok: false, code: 'unauthenticated', problems: ['parent revoked'] };
											const next = parentOf(port);
											if (change === 'grant') next.context.delegation.grantRef = 'changed-grant';
											else next.context.actor.id = 'replacement-source';
											return next;
										},
									},
								},
								undefined,
								() => {
									if (boundary === 'preparation') mutate();
								}
							);
							expect(await turns.run({ purpose: 'task', prompt: 'work' })).toMatchObject({
								success: false,
							});
							expect(startedProcesses()).toBe(0);
							expect(authority.live()).toEqual([]);
							expect(issued).toHaveLength(
								boundary === 'admission' || boundary === 'spawn gate' ? 1 : 0
							);
							for (const lease of issued) {
								expect(lease.pid()).toBeUndefined();
								expect(lease.ended().release).toMatchObject({ outcome: 'spawn-failed' });
							}
							enabled = false;
							changed = false;
							expect(await turns.run({ purpose: 'task', prompt: 'retry' })).toMatchObject({
								success: true,
							});
							expect(startedProcesses()).toBe(1);
						}
					);
				}
			);
		});

		describe('shared turn cancellation and unused custody', () => {
			it.each(['preparation', 'admission', 'observer'] as const)(
				'creates no process when cancelled during %s and admits a fresh retry',
				async (boundary) => {
					const { port, authority } = await managedPort();
					const stop = new AbortController();
					const execute = vi.spyOn(processTurns, 'runTurn');
					const leases: DispatchLease[] = [];
					const tempDir = path.join(dir, 'prompts');
					fs.mkdirSync(tempDir);
					const admit = authority.admit.bind(authority);
					vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
						const answer = await admit(request);
						if (answer.state === 'admitted') {
							leases.push(answer.lease);
							vi.spyOn(answer.lease, 'release');
							vi.spyOn(answer.lease, 'bind');
						}
						if (boundary === 'admission') stop.abort();
						return answer;
					});
					const onAdmission = vi.fn((event: AutoRunAdmissionEvent) => {
						if (event.kind === 'admitted' && boundary === 'observer') stop.abort();
					});
					const turns = runner(
						['answer', 'answer'],
						{ workflow, managed: { port, fence: () => FENCE, onAdmission } },
						undefined,
						(options, turn) => {
							turn.systemPromptDelivery = { via: 'file' };
							options.deps = { tempDir };
							if (boundary === 'preparation') stop.abort();
						}
					);
					const result = await turns.run({ purpose: 'task', prompt: 'work', signal: stop.signal });
					expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cancel/i) });
					expect(execute).not.toHaveBeenCalled();
					expect(startedProcesses()).toBe(0);
					expect(authority.live()).toEqual([]);
					expect(fs.readdirSync(tempDir)).toEqual([]);
					expect(onAdmission).toHaveBeenCalledTimes(boundary === 'observer' ? 1 : 0);
					for (const lease of leases) {
						expect(lease.bind).not.toHaveBeenCalled();
						expect(lease.release).toHaveBeenCalledExactlyOnceWith({
							outcome: 'spawn-failed',
							message: expect.stringMatching(/cancel/i),
						});
					}
					expect((await turns.run({ purpose: 'task', prompt: 'retry' })).success).toBe(true);
					expect(startedProcesses()).toBe(1);
					expect(new Set(leases.map((lease) => lease.leaseId)).size).toBe(leases.length);
					expect(authority.live()).toEqual([]);
				}
			);

			it('releases an unused lease and prompt file when the admission observer throws', async () => {
				const { port, authority } = await managedPort();
				const execute = vi.spyOn(processTurns, 'runTurn');
				let lease!: DispatchLease;
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					const answer = await admit(request);
					if (answer.state === 'admitted') {
						lease = answer.lease;
						vi.spyOn(lease, 'release');
					}
					return answer;
				});
				const tempDir = path.join(dir, 'prompts');
				fs.mkdirSync(tempDir);
				const turns = runner(
					['answer'],
					{
						workflow,
						managed: {
							port,
							fence: () => FENCE,
							onAdmission: () => {
								throw new Error('observer failed');
							},
						},
					},
					undefined,
					(options, turn) => {
						turn.systemPromptDelivery = { via: 'file' };
						options.deps = { tempDir };
					}
				);
				await expect(turns.run({ purpose: 'task', prompt: 'work' })).resolves.toMatchObject({
					success: false,
					error: expect.stringContaining('observer failed'),
				});
				expect(execute).not.toHaveBeenCalled();
				expect(lease.release).toHaveBeenCalledExactlyOnceWith({
					outcome: 'spawn-failed',
					message: 'observer failed',
				});
				expect(authority.live()).toEqual([]);
				expect(fs.readdirSync(tempDir)).toEqual([]);
			});

			it.each(['denied', 'unavailable', 'unknown', 'throws'] as const)(
				'keeps a late %s admission diagnostic and cleans the prompt file after cancellation',
				async (state) => {
					const { port, authority } = await managedPort();
					const stop = new AbortController();
					const execute = vi.spyOn(processTurns, 'runTurn');
					const tempDir = path.join(dir, 'prompts');
					fs.mkdirSync(tempDir);
					vi.spyOn(authority, 'admit').mockImplementation(async () => {
						expect(fs.readdirSync(tempDir)).toHaveLength(1);
						stop.abort();
						if (state === 'throws') throw new Error('producer reply lost');
						if (state === 'denied')
							return {
								state,
								code: 'policy-denied',
								message: 'late denied',
								policyRevision: 1,
							};
						if (state === 'unknown')
							return {
								state,
								code: 'outcome-unknown',
								message: 'late unknown',
							};
						return { state, code: 'runtime-unavailable', message: 'late unavailable' };
					});
					const turns = runner(
						['answer'],
						{ workflow, managed: { port, fence: () => FENCE } },
						undefined,
						(options, turn) => {
							turn.systemPromptDelivery = { via: 'file' };
							options.deps = { tempDir };
						}
					);
					const result = turns.run({ purpose: 'task', prompt: 'work', signal: stop.signal });
					if (state === 'throws') await expect(result).rejects.toThrow('producer reply lost');
					else
						await expect(result).resolves.toMatchObject({
							success: false,
							managed: { state },
							error: expect.stringContaining(`late ${state}`),
						});
					expect(execute).not.toHaveBeenCalled();
					expect(authority.live()).toEqual([]);
					expect(fs.readdirSync(tempDir)).toEqual([]);
				}
			);

			it.each(['standalone', 'managed'] as const)(
				'stops a %s turn cancelled during SSH preparation before admission or any child',
				async (mode) => {
					const { port, authority } = await managedPort();
					const admit = vi.spyOn(authority, 'admit');
					const execute = vi.spyOn(processTurns, 'runTurn');
					const stop = new AbortController();
					const remote = {
						id: 'remote-1',
						name: 'Fixture',
						host: 'fixture.invalid',
						port: 22,
						username: 'fixture',
						privateKeyPath: path.join(dir, 'fixture-key'),
						enabled: true,
					};
					const wrap = vi.fn<
						NonNullable<NonNullable<RunAgentTurnOptions['deps']>['wrapSpawnWithSsh']>
					>(async (config) => {
						await Promise.resolve();
						stop.abort();
						return {
							command: process.execPath,
							args: [FAKE_AGENT_PATH],
							cwd: config.cwd,
							sshRemoteUsed: remote,
						};
					});
					const result = await runner(
						['answer'],
						mode === 'managed' ? { workflow, managed: { port, fence: () => FENCE } } : {},
						undefined,
						(options, turn) => {
							turn.launch.sshRemoteConfig = { enabled: true, remoteId: remote.id };
							options.sshStore = { getSshRemotes: () => [remote] };
							options.deps = { wrapSpawnWithSsh: wrap };
						}
					).run({ purpose: 'task', prompt: 'work', signal: stop.signal });
					expect(result).toMatchObject({ success: false, error: expect.stringMatching(/cancel/i) });
					expect(wrap).toHaveBeenCalledOnce();
					expect(admit).not.toHaveBeenCalled();
					expect(execute).not.toHaveBeenCalled();
					expect(startedProcesses()).toBe(0);
				}
			);

			it('releases a lease when the native spawn synchronously proves nonstart', async () => {
				const { port, authority } = await managedPort();
				let lease!: DispatchLease;
				const admit = authority.admit.bind(authority);
				vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
					const answer = await admit(request);
					if (answer.state === 'admitted') {
						lease = answer.lease;
						vi.spyOn(lease, 'release');
					}
					return answer;
				});
				const result = await runner(
					['answer'],
					{ workflow, managed: { port, fence: () => FENCE } },
					undefined,
					(_options, turn) => {
						turn.launch.cwd = '\0';
					}
				).run({ purpose: 'task', prompt: 'work' });
				expect(result).toMatchObject({
					success: false,
					error: expect.stringContaining('Could not start'),
				});
				expect(lease.release).toHaveBeenCalledExactlyOnceWith({
					outcome: 'spawn-failed',
					message: expect.any(String),
				});
				expect(authority.live()).toEqual([]);
				expect(startedProcesses()).toBe(0);
			});

			it('does not classify an unproven executor exception as an unused lease', async () => {
				const { port, authority } = await managedPort();
				vi.spyOn(processTurns, 'runTurn').mockImplementationOnce(() => {
					throw new Error('executor outcome lost');
				});
				try {
					await expect(
						runner(['answer'], { workflow, managed: { port, fence: () => FENCE } }).run({
							purpose: 'task',
							prompt: 'work',
						})
					).rejects.toThrow('executor outcome lost');
					expect(authority.live()).toHaveLength(1);
				} finally {
					authority.revokeAll('test cleanup');
				}
			});
		});

		describe('workflow fence lifetime', () => {
			function ownership() {
				const owner = new AbortController();
				const lifetime = {
					signal: owner.signal,
					current: vi.fn(() => !owner.signal.aborted),
					finish: vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined),
				};
				const detached = vi.spyOn(owner.signal, 'removeEventListener');
				return { owner, lifetime, detached, fence: { ...FENCE, lifetime } };
			}

			it.each(['cancelled', 'withdrawn', 'rejected', 'throws', 'expired', 'revoked'] as const)(
				'settles an unused claim when launch is %s after the claim',
				async (change) => {
					const { port, authority } = await managedPort();
					const { owner, lifetime, detached, fence } = ownership();
					const stop = new AbortController();
					const run = runner(['answer'], {
						workflow,
						managed: {
							port,
							fence: async () => {
								if (change === 'cancelled') stop.abort();
								if (change === 'withdrawn') port.standing = () => 'standalone';
								if (change === 'rejected')
									port.context = () => ({
										ok: false,
										code: 'unauthenticated',
										problems: ['revoked'],
									});
								if (change === 'throws')
									port.policy = () => {
										throw new Error('policy lost');
									};
								if (change === 'expired') lifetime.current.mockReturnValue(false);
								if (change === 'revoked') owner.abort();
								return fence;
							},
						},
					}).run({ purpose: 'task', prompt: 'work', signal: stop.signal });
					if (change === 'throws') await expect(run).rejects.toThrow('policy lost');
					else expect((await run).success).toBe(false);
					expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('no_effect');
					expect(detached).toHaveBeenCalledWith('abort', expect.any(Function));
					expect(startedProcesses()).toBe(0);
					expect(authority.live()).toEqual([]);
				}
			);

			it.each(['preparation', 'admission'] as const)(
				'cancels %s on workflow revocation and settles the unused claim',
				async (boundary) => {
					const { port, authority } = await managedPort();
					const { owner, lifetime, fence } = ownership();
					const admit = authority.admit.bind(authority);
					vi.spyOn(authority, 'admit').mockImplementation(async (request) => {
						const answer = await admit(request);
						owner.abort();
						return answer;
					});
					let signal: AbortSignal | undefined;
					const result = await runner(
						['answer'],
						{ workflow, managed: { port, fence: () => fence } },
						undefined,
						(options) => {
							signal = options.signal;
							if (boundary === 'preparation') owner.abort();
						}
					).run({ purpose: 'task', prompt: 'work' });
					expect(result.success).toBe(false);
					expect(signal?.aborted).toBe(true);
					expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('no_effect');
					expect(startedProcesses()).toBe(0);
					expect(authority.live()).toEqual([]);
				}
			);

			it.each([
				{ state: 'denied', code: 'policy-denied', policyRevision: 1 },
				{ state: 'unavailable', code: 'runtime-unavailable' },
				{ state: 'unknown', code: 'outcome-unknown' },
			] as const)(
				'preserves a late $state admission and settles without inventing a child effect',
				async (outcome) => {
					const { state } = outcome;
					const { port } = await managedPort();
					const { owner, lifetime, fence } = ownership();
					vi.spyOn(port.authority, 'admit').mockImplementation(async () => {
						owner.abort();
						return { ...outcome, message: 'Producer reply' };
					});
					const result = await runner(['answer'], {
						workflow,
						managed: { port, fence: () => fence },
					}).run({ purpose: 'task', prompt: 'work' });
					expect(result).toMatchObject({
						success: false,
						managed: { state },
						error: `[managed-${state}] Producer reply`,
					});
					expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith(
						state === 'unknown' ? 'uncertain' : 'no_effect'
					);
					expect(startedProcesses()).toBe(0);
				}
			);

			it('retains uncertainty when the turn executor throws', async () => {
				const { port } = await managedPort();
				const { lifetime, fence } = ownership();
				await expect(
					runner(['answer'], { workflow, managed: { port, fence: () => fence } }, undefined, () => {
						throw new Error('executor failed');
					}).run({ purpose: 'task', prompt: 'work' })
				).rejects.toThrow('executor failed');
				expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('uncertain');
			});

			it.each(['owner', 'operator'] as const)(
				'stops a real running process on %s cancellation and settles uncertainty',
				async (source) => {
					const { port, authority } = await managedPort();
					const { owner, lifetime, fence } = ownership();
					const stop = new AbortController();
					const run = runner(['hold'], { workflow, managed: { port, fence: () => fence } }).run({
						purpose: 'task',
						prompt: 'work',
						signal: stop.signal,
					});
					try {
						await vi.waitFor(() => expect(startedProcesses()).toBe(1));
						(source === 'owner' ? owner : stop).abort();
						await vi.waitFor(() =>
							expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('uncertain')
						);
						expect(await run).toMatchObject({ success: false, outcome: 'interrupted' });
						expect(authority.live()).toEqual([]);
					} finally {
						stop.abort();
						authority.revokeAll('test cleanup');
						await run;
					}
				}
			);

			it.each(['task', 'synopsis', 'goal-handoff'] as const)(
				'settles a completed %s only after detaching ownership cancellation',
				async (purpose) => {
					const { port, authority } = await managedPort();
					const { owner, lifetime, detached, fence } = ownership();
					let signal: AbortSignal | undefined;
					lifetime.finish.mockImplementation(async () => {
						expect(detached).toHaveBeenCalledWith('abort', expect.any(Function));
						owner.abort();
						expect(signal?.aborted).toBe(false);
					});
					const result = await runner(
						['answer'],
						{ workflow, managed: { port, fence: () => fence } },
						undefined,
						(options) => {
							signal = options.signal;
						}
					).run({ purpose, prompt: 'work' });
					expect(result.success).toBe(true);
					expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('applied');
					expect(authority.live()).toEqual([]);
				}
			);

			it('settles each attempt before claiming fresh ownership for the effort retry', async () => {
				const { port } = await managedPort();
				const claims = [ownership(), ownership()];
				let claim = 0;
				const result = await runner(['refuse', 'answer'], {
					workflow,
					managed: {
						port,
						fence: () => {
							if (claim === 1)
								expect(claims[0].lifetime.finish).toHaveBeenCalledExactlyOnceWith('uncertain');
							return claims[claim++].fence;
						},
					},
				}).run({ purpose: 'task', prompt: 'work', effort: 'minimal' });
				expect(result.success).toBe(true);
				expect(claim).toBe(2);
				expect(claims[1].lifetime.finish).toHaveBeenCalledExactlyOnceWith('applied');
				expect(startedProcesses()).toBe(2);
			});

			it('does not report success when ownership settlement throws', async () => {
				const { port } = await managedPort();
				const { lifetime, fence } = ownership();
				lifetime.finish.mockRejectedValue(new Error('settlement lost'));
				await expect(
					runner(['answer'], { workflow, managed: { port, fence: () => fence } }).run({
						purpose: 'task',
						prompt: 'work',
					})
				).rejects.toThrow('settlement lost');
				expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('applied');
			});

			it.each(['standalone', 'dormant port', 'legacy fence'] as const)(
				'keeps the original caller signal with a %s',
				async (mode) => {
					const { port } = await managedPort();
					if (mode === 'dormant port') port.standing = () => 'standalone';
					const stop = new AbortController();
					const fence = vi.fn(() => FENCE);
					const result = await runner(
						['answer'],
						{
							workflow,
							...(mode !== 'standalone' ? { managed: { port, fence } } : {}),
						},
						undefined,
						(options) => {
							expect(options.signal).toBe(stop.signal);
						}
					).run({ purpose: 'task', prompt: 'work', signal: stop.signal });
					expect(result.success).toBe(true);
					expect(fence).toHaveBeenCalledTimes(mode === 'legacy fence' ? 1 : 0);
				}
			);

			it('waits for settlement acknowledgment before returning completion', async () => {
				const { port } = await managedPort();
				const { lifetime, fence } = ownership();
				let release!: () => void;
				lifetime.finish.mockReturnValue(
					new Promise<void>((resolve) => {
						release = resolve;
					})
				);
				const completed = vi.fn();
				const run = runner(['answer'], { workflow, managed: { port, fence: () => fence } })
					.run({ purpose: 'task', prompt: 'work' })
					.then(completed);
				try {
					await vi.waitFor(() => expect(lifetime.finish).toHaveBeenCalledWith('applied'));
					expect(completed).not.toHaveBeenCalled();
				} finally {
					release();
					await run;
				}
				expect(completed).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
			});
		});

		it.each(['synopsis', 'goal-handoff'] as const)(
			'carries the verified task and %s context into the child environment, overriding inherited and configured records',
			async (purpose) => {
				vi.stubEnv(MANAGED_DELEGATION_ENV_VAR, 'stale inherited context');
				const requests: AdmissionRequest[] = [];
				const { port } = await managedPort((request) => {
					requests.push(request);
					return ALLOW;
				});
				const context = port.context.bind(port);
				// A trusted fixture host binds its own chain/grant. The environment cannot supply either.
				port.context = (input) =>
					context({
						...input,
						delegation: {
							chain: [
								{ kind: 'human', id: 'source-actor' },
								{ kind: 'agent', id: 'a1' },
							],
							grantRef: 'authenticated-grant',
						},
					});
				const fence = { ownerEpoch: 'opaque-epoch', fencingToken: 'opaque-fence' };
				const turns = runner(
					['answer', 'answer'],
					{
						workflow,
						managed: { port, fence: () => fence },
					},
					{ [MANAGED_DELEGATION_ENV_VAR]: 'forged configured context' }
				);
				expect(
					(await turns.run({ purpose: 'task', prompt: 'work', document: 'TASKS.md' })).success
				).toBe(true);
				expect(
					(await turns.run({ purpose, prompt: 'summarize', resumeSessionId: 'sess-1' })).success
				).toBe(true);
				expect(startedProcesses()).toBe(2);
				expect(requests).toHaveLength(2);
				for (const [index, request] of requests.entries()) {
					const env = JSON.parse(fs.readFileSync(path.join(dir, `env-${index + 1}.json`), 'utf8'));
					expect(readDelegationContextEnv(env)).toEqual({
						status: 'ok',
						context: delegationContextOf(request.context),
					});
					expect(request.context.actor).toEqual({ kind: 'human', id: 'operator' });
					expect(request.context.workflow).toEqual({
						workflowId: workflow.workflowId,
						version: workflow.version,
						triggerEventId: workflow.triggerEventId,
						...fence,
					});
					expect(env.MAESTRO_QUERY_SOURCE).toBe('auto');
				}
				expect(requests[1].context.identity.parentRunId).toBe(requests[0].context.identity.runId);
				expect(requests[1].context.identity.rootRunId).toBe(workflow.runId);
			}
		);

		it('stamps the renewed fence, current policy and fresh attempt on an effort retry', async () => {
			let revision = 0;
			const requests: AdmissionRequest[] = [];
			const { port } = await managedPort((request) => {
				requests.push(request);
				return { decision: 'allow', policyRevision: revision };
			});
			port.policy = () => ({ sources: [], policyRevision: revision });
			const result = await runner(['refuse', 'answer'], {
				workflow,
				managed: {
					port,
					fence: async () => ({
						ownerEpoch: `epoch-${++revision}`,
						fencingToken: `fence-${revision}`,
					}),
				},
			}).run({ purpose: 'task', prompt: 'work', effort: 'minimal' });
			expect(result.success).toBe(true);
			expect(requests).toHaveLength(2);
			for (const [index, request] of requests.entries()) {
				const env = JSON.parse(fs.readFileSync(path.join(dir, `env-${index + 1}.json`), 'utf8'));
				expect(readDelegationContextEnv(env)).toEqual({
					status: 'ok',
					context: delegationContextOf(request.context),
				});
				expect(request.context.policyRevision).toBe(index + 1);
				expect(request.context.workflow).toMatchObject({
					ownerEpoch: `epoch-${index + 1}`,
					fencingToken: `fence-${index + 1}`,
				});
			}
			expect(requests[0].context.identity.requestId).toBe(requests[1].context.identity.requestId);
			expect(requests[0].context.identity.attemptId).not.toBe(
				requests[1].context.identity.attemptId
			);
		});

		it.each(['standing', 'authority'] as const)(
			'refuses a host %s change while awaiting the owner claim',
			async (change) => {
				const decide = vi.fn(() => ALLOW);
				const { port, authority } = await managedPort(decide);
				const mutablePort = { ...port };
				const result = await runner(['answer'], {
					workflow,
					managed: {
						port: mutablePort,
						fence: async () => {
							if (change === 'standing') mutablePort.standing = () => 'standalone';
							else mutablePort.authority = { ...authority }; // Even a replacement with the same id.
							return FENCE;
						},
					},
				}).run({ purpose: 'task', prompt: 'work' });
				expect(result).toMatchObject({
					success: false,
					managed: { state: 'unavailable', code: 'runtime-unavailable' },
				});
				expect(decide).not.toHaveBeenCalled();
				expect(startedProcesses()).toBe(0);
			}
		);

		describe.each(['preparation', 'admission', 'spawn gate'] as const)(
			'%s scope recheck',
			(boundary) => {
				it.each([
					'standing',
					'authority',
					'policy',
					'sources',
					'actor',
					'rejected',
					'unreadable',
					'context mutation',
					'policy mutation',
					'fence',
					'owner signal',
				] as const)(
					'refuses %s drift without starting a process or keeping an unused lease',
					async (change) => {
						const { port, authority } = await managedPort();
						const mutablePort = { ...port };
						const issued: DispatchLease[] = [];
						const owner = new AbortController();
						let held = true;
						let launch: RunAgentTurnOptions | undefined;
						const mutate = () => {
							if (change === 'standing') mutablePort.standing = () => 'standalone';
							else if (change === 'authority') mutablePort.authority = { ...authority };
							else if (change === 'policy')
								mutablePort.policy = () => ({ sources: [], policyRevision: 2 });
							else if (change === 'sources')
								mutablePort.policy = () => ({
									sources: [{ id: 'new-ceiling', kind: 'endpoint', revision: 1 }],
									policyRevision: 1,
								});
							else if (change === 'actor')
								mutablePort.context = (input) => {
									const verified = port.context(input);
									if (!verified.ok) return verified;
									return createContextVerifier({
										...verified.context.verification,
										now: Date.now,
										accept: () => [],
									}).verify({ ...verified.context, actor: { kind: 'human', id: 'replacement' } });
								};
							else if (change === 'rejected')
								mutablePort.context = () => ({
									ok: false,
									code: 'unauthenticated',
									problems: ['actor revoked'],
								});
							else if (change === 'unreadable')
								mutablePort.policy = () => {
									throw new Error('read failed');
								};
							else if (change === 'context mutation')
								launch!.managed!.context.actor.id = 'changed-request';
							else if (change === 'policy mutation')
								launch!.managed!.policy.sources = [
									{ id: 'changed-request', kind: 'endpoint', revision: 1 },
								];
							else if (change === 'fence') held = false;
							else owner.abort();
						};
						const original = authority.admit.bind(authority);
						const asked = vi.spyOn(authority, 'admit').mockImplementation(async (input) => {
							const outcome = await original(input);
							if (outcome.state === 'admitted') issued.push(outcome.lease);
							if (boundary === 'admission') mutate();
							return outcome;
						});
						const result = await runner(
							['answer'],
							{
								workflow,
								managed: {
									port: mutablePort,
									fence: () => ({
										...FENCE,
										lifetime: {
											signal: owner.signal,
											current: () => held,
											finish: async () => undefined,
										},
									}),
									onAdmission: (event) => {
										if (event.kind === 'admitted' && boundary === 'spawn gate') mutate();
									},
								},
							},
							undefined,
							(options) => {
								launch = options;
								if (boundary === 'preparation') mutate();
							}
						).run({ purpose: 'task', prompt: 'work', effort: 'minimal' });
						if (change === 'owner signal' && boundary !== 'admission') {
							// Cancellation now stops before admission or the final gate can decide.
							expect(result).toMatchObject({
								success: false,
								error: expect.stringMatching(/cancel/i),
							});
							expect(result.managed).toBeUndefined();
						} else {
							expect(result).toMatchObject({
								success: false,
								managed: { state: boundary === 'spawn gate' ? 'denied' : 'unavailable' },
							});
						}
						expect(asked).toHaveBeenCalledTimes(boundary === 'preparation' ? 0 : 1);
						expect(efforts).toHaveLength(1);
						expect(startedProcesses()).toBe(0);
						expect(authority.live()).toEqual([]);
						for (const lease of issued) {
							expect(lease.pid()).toBeUndefined();
							expect(lease.ended().release).toMatchObject({ outcome: 'spawn-failed' });
						}
					}
				);
			}
		);

		it.each([
			{ state: 'unknown', code: 'outcome-unknown', message: 'Acknowledgment lost' },
			{ state: 'denied', code: 'policy-denied', message: 'Actor revoked', policyRevision: 1 },
			{ state: 'unavailable', code: 'runtime-unavailable', message: 'Endpoint unavailable' },
		] satisfies AdmissionOutcome[])(
			'preserves a late producer $state when standing changes',
			async (outcome) => {
				const { port, authority } = await managedPort();
				const entered = Promise.withResolvers<void>();
				const answer = Promise.withResolvers<AdmissionOutcome>();
				vi.spyOn(authority, 'admit').mockImplementation(() => {
					entered.resolve();
					return answer.promise;
				});
				const result = runner(['answer'], { workflow, managed: { port, fence: () => FENCE } }).run({
					purpose: 'task',
					prompt: 'work',
					effort: 'minimal',
				});
				await entered.promise;
				port.standing = () => 'standalone';
				answer.resolve(outcome);
				expect(await result).toMatchObject({
					success: false,
					error: `[managed-${outcome.state}] ${outcome.message}`,
					managed: { state: outcome.state, code: outcome.code },
				});
				expect(startedProcesses()).toBe(0);
				expect(authority.live()).toEqual([]);
			}
		);

		it('accepts fresh verification timestamps and retains the original producer lease', async () => {
			const { port, authority } = await managedPort();
			const originalContext = port.context.bind(port);
			let now = 1_700_000_000_000;
			const timestamps: string[] = [];
			port.context = (input) => {
				const result = originalContext(input);
				if (!result.ok) return result;
				const verified = createContextVerifier({
					...result.context.verification,
					now: () => now++,
					accept: () => [],
				}).verify(result.context);
				if (verified.ok) timestamps.push(verified.context.verification.verifiedAt);
				return verified;
			};
			let lease: DispatchLease | undefined;
			const result = await runner(['answer'], {
				workflow,
				managed: {
					port,
					fence: () => FENCE,
					onAdmission: (event) => {
						if (event.kind === 'admitted') lease = authority.live()[0];
					},
				},
			}).run({ purpose: 'task', prompt: 'work' });
			expect(result.success).toBe(true);
			expect(new Set(timestamps).size).toBeGreaterThanOrEqual(4);
			expect(lease?.pid()).toBeTypeOf('number');
			expect(lease?.state()).toBe('released');
			expect(authority.live()).toEqual([]);
			expect(startedProcesses()).toBe(1);
		});

		it('claims and admits a fresh attempt after a prior preparation changed scope', async () => {
			const { port, authority } = await managedPort();
			let revision = 1;
			port.policy = () => ({ sources: [], policyRevision: revision });
			const fence = vi.fn(() => FENCE);
			const asked = vi.spyOn(authority, 'admit');
			const turns = runner(
				['answer', 'answer'],
				{ workflow, managed: { port, fence } },
				undefined,
				() => {
					if (efforts.length === 1) revision = 2;
				}
			);
			expect(await turns.run({ purpose: 'task', prompt: 'first' })).toMatchObject({
				success: false,
				managed: { state: 'unavailable' },
			});
			expect((await turns.run({ purpose: 'task', prompt: 'retry' })).success).toBe(true);
			expect(fence).toHaveBeenCalledTimes(2);
			expect(fence.mock.calls[0]).not.toEqual(fence.mock.calls[1]);
			expect(asked).toHaveBeenCalledTimes(1);
			expect(asked.mock.calls[0][0].context.policyRevision).toBe(2);
			expect(startedProcesses()).toBe(1);
		});

		it('does not downgrade an already managed run after it loses enrollment', async () => {
			const { port } = await managedPort();
			const turns = runner(['answer', 'answer'], {
				workflow,
				managed: { port, fence: () => FENCE },
			});
			expect((await turns.run({ purpose: 'task', prompt: 'first' })).success).toBe(true);
			port.standing = () => 'standalone';
			const result = await turns.run({ purpose: 'task', prompt: 'second' });
			expect(result).toMatchObject({ success: false, managed: { state: 'unavailable' } });
			expect(startedProcesses()).toBe(1);
		});

		it('starts no process if the run is stopped while awaiting its fence', async () => {
			const controller = new AbortController();
			const decide = vi.fn(() => ALLOW);
			const { port } = await managedPort(decide);
			const result = await runner(['answer'], {
				workflow,
				managed: {
					port,
					fence: async () => {
						controller.abort();
						return FENCE;
					},
				},
			}).run({ purpose: 'task', prompt: 'work', signal: controller.signal });
			expect(result).toMatchObject({ success: false, outcome: 'interrupted' });
			expect(decide).not.toHaveBeenCalled();
			expect(startedProcesses()).toBe(0);
		});

		it('claims for the request and each attempt, the effort retry included, and admits on the fence it was given', async () => {
			const claims: Array<{ runId: string; attemptId: string }> = [];
			const admissions: AutoRunAdmissionEvent[] = [];
			const result = await runner(['refuse', 'answer'], {
				workflow,
				managed: {
					port: (await managedPort()).port,
					fence: (run) => {
						claims.push(run);
						return FENCE;
					},
					onAdmission: (event) => admissions.push(event),
				},
			}).run({ purpose: 'task', prompt: 'do the task', effort: 'minimal' });

			expect(result).toMatchObject({ success: true, response: 'Done.' });
			expect(efforts).toEqual(['minimal', undefined]);
			// Two attempts of one request: the same run id, a fresh attempt id, a claim for each.
			expect(claims).toHaveLength(2);
			expect(claims[0].runId).toBe(claims[1].runId);
			expect(claims[0].attemptId).not.toBe(claims[1].attemptId);
			expect(admissions.map((event) => event.kind)).toEqual(['admitted', 'admitted']);
			const [first, retry] = admissions as Array<AutoRunAdmissionEvent & { kind: 'admitted' }>;
			expect(first.attribution.requestId).toBe(claims[0].runId);
			expect(first.attribution.attemptId).toBe(claims[0].attemptId);
			expect(retry.attribution.attemptId).toBe(claims[1].attemptId);
			expect(retry.attribution.attempt).toBe(2);
		});

		it("is refused with the producer's state and code when the claim is answered that way, later, and starts nothing", async () => {
			const admissions: AutoRunAdmissionEvent[] = [];
			const result = await runner(['answer'], {
				workflow,
				managed: {
					port: (await managedPort()).port,
					fence: async () => ({
						fence: null,
						state: 'unknown',
						code: 'outcome-unknown',
						message: 'The answer to the claim on workflow "playbook:nightly" was lost.',
					}),
					onAdmission: (event) => admissions.push(event),
				},
			}).run({ purpose: 'task', prompt: 'do the task', effort: 'minimal' });

			expect(result).toMatchObject({
				success: false,
				error: '[managed-unknown] The answer to the claim on workflow "playbook:nightly" was lost.',
				managed: { state: 'unknown', code: 'outcome-unknown' },
				agentError: { type: 'permission_denied', recoverable: true },
			});
			// No process, no effort retry of a turn that never ran, one refusal on the record.
			expect(efforts).toEqual([]);
			expect(admissions).toEqual([
				expect.objectContaining({
					kind: 'refused',
					state: 'unknown',
					code: 'outcome-unknown',
					attribution: expect.objectContaining({ workflow, attempt: 1 }),
				}),
			]);
		});

		/**
		 * Zero effect (MRC-07-07): an owner the registry fenced, a policy that changed between two
		 * attempts, a lease revoked while the turn runs, and a lineage with a fabricated trigger or
		 * fence. Each one leaves no process behind that should not exist, and each is told apart by
		 * its state and code rather than folded into one failure.
		 */
		describe('zero effect: a revoked owner, a revoked policy, a fabricated trigger', () => {
			const task = { purpose: 'task' as const, prompt: 'do the task', effort: 'minimal' };

			it('an owner the registry fenced (owner_unfenced) starts nothing, retries nothing, and is a denial nobody retries into', async () => {
				const decide = vi.fn(() => ALLOW);
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port } = await managedPort(decide);

				const result = await runner(['answer'], {
					workflow,
					managed: {
						port,
						fence: () => ({
							fence: null,
							state: 'denied',
							code: 'policy-denied',
							message:
								'Workflow "playbook:nightly" is fenced: the registry holds it for another owner (owner_unfenced).',
						}),
						onAdmission: (event) => admissions.push(event),
					},
				}).run(task);

				expect(result).toMatchObject({
					success: false,
					error:
						'[managed-denied] Workflow "playbook:nightly" is fenced: the registry holds it for another owner (owner_unfenced).',
					managed: { state: 'denied', code: 'policy-denied' },
					// A decision, so the run parks for a person instead of retrying into it.
					agentError: { type: 'permission_denied', recoverable: false },
				});
				// The authority was never asked and no process was started: the fence comes first.
				expect(decide).not.toHaveBeenCalled();
				expect(efforts).toEqual([]);
				expect(startedProcesses()).toBe(0);
				expect(admissions).toEqual([
					expect.objectContaining({ kind: 'refused', state: 'denied', code: 'policy-denied' }),
				]);
			});

			it('a policy that changes between two attempts of one request is applied to the retry: the first attempt ran, the retry is refused with the decision, and nothing starts for it', async () => {
				const answers: PolicyDecision[] = [
					ALLOW,
					{
						decision: 'deny',
						reason: 'policy revision 2 forbids automation on this host',
						policyRevision: 2,
					},
				];
				const claims: Array<{ runId: string; attemptId: string }> = [];
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port } = await managedPort(() => answers.shift() ?? ALLOW);

				const result = await runner(['refuse', 'answer'], {
					workflow,
					managed: {
						port,
						fence: (run) => {
							claims.push(run);
							return FENCE;
						},
						onAdmission: (event) => admissions.push(event),
					},
				}).run(task);

				// Attempt 1 ran (and was refused its effort by the provider). Attempt 2 was assembled
				// and taken to the authority, which is where the new policy met it: no second process.
				expect(efforts).toEqual(['minimal', undefined]);
				expect(startedProcesses()).toBe(1);
				expect(result).toMatchObject({
					success: false,
					error: '[managed-denied] policy revision 2 forbids automation on this host',
					managed: { state: 'denied', code: 'policy-denied' },
				});
				expect(answers).toEqual([]);
				// The retry claimed its own fence and was decided on its own attempt.
				expect(claims).toHaveLength(2);
				expect(admissions.map((event) => event.kind)).toEqual(['admitted', 'refused']);
				expect(admissions[1]).toMatchObject({
					kind: 'refused',
					attribution: { attempt: 2, requestId: claims[1].runId, attemptId: claims[1].attemptId },
				});
			});

			it('a revocation while the turn runs stops the process; the authority owns that stop, the turn is interrupted, and no lease stays live', async () => {
				const admissions: AutoRunAdmissionEvent[] = [];
				const { port, authority } = await managedPort();

				const running = runner(['hold'], {
					workflow,
					managed: {
						port,
						fence: () => FENCE,
						onAdmission: (event) => admissions.push(event),
					},
				}).run({ purpose: 'task', prompt: 'do the task' });

				await vi.waitFor(() => expect(admissions).toHaveLength(1));
				const admitted = admissions[0] as AutoRunAdmissionEvent & { kind: 'admitted' };
				// The lease is bound to the process the instant it exists.
				await vi.waitFor(() =>
					expect(authority.live().map((lease) => [lease.leaseId, lease.state()])).toEqual([
						[admitted.leaseId, 'bound'],
					])
				);
				const [lease] = authority.live();
				// And running: the revocation reaches a process at work, not one still loading.
				await vi.waitFor(() => expect(startedProcesses()).toBe(1));

				expect(authority.revoke(admitted.leaseId, 'the owner withdrew the workflow')).toBe(true);
				const result = await running;

				// Stopped by the authority: not a success, not a crash, and not an operator stop
				// either, so the engine neither records a finished task nor retries into it.
				expect(result.success).toBe(false);
				expect(result.outcome).toBe('interrupted');
				expect(lease.ended()).toMatchObject({
					state: 'revoked',
					reason: 'the owner withdrew the workflow',
				});
				expect(authority.live()).toEqual([]);
				expect(startedProcesses()).toBe(1);
			});

			it('a fabricated trigger, or a fabricated fence, is refused by the verifier before the authority is asked, and nothing starts', async () => {
				const decide = vi.fn(() => ALLOW);
				const { port } = await managedPort(decide);

				// A trigger nobody raised: the workflow names no event it was started by.
				const forgedTrigger = await runner(['answer'], {
					workflow: { ...workflow, triggerEventId: '' },
					managed: { port, fence: () => FENCE },
				}).run(task);
				expect(forgedTrigger).toMatchObject({
					success: false,
					error: expect.stringContaining('workflow.triggerEventId is not an id'),
					managed: { state: 'denied', code: 'invalid-input' },
				});

				// A fence no registry issued: a token that is not one.
				const forgedFence = await runner(['answer'], {
					workflow,
					managed: { port, fence: () => ({ ownerEpoch: '3', fencingToken: '' }) },
				}).run(task);
				expect(forgedFence).toMatchObject({
					success: false,
					error: expect.stringContaining('workflow.fencingToken is not an id'),
					managed: { state: 'denied', code: 'invalid-input' },
				});

				expect(decide).not.toHaveBeenCalled();
				expect(efforts).toEqual([]);
				expect(startedProcesses()).toBe(0);
			});
		});
	});
});
