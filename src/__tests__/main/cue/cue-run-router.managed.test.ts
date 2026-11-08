/**
 * Managed admission in the Cue run router (MRC-07-02): a prompt run on a
 * managed host is bound on its lineage (the owning agent, the subscription,
 * the pipeline, the chain root and the firing event) into a verified context
 * that reaches the executor, or is refused explicitly before anything runs.
 *
 * The port is the REAL `createHeadlessSpawnAuthority` with origin `cue` over
 * an enrolled binding and a host whose authority is the real
 * `createLocalHostAuthority`; only the policy table, the binding record and
 * the executors are doubles. Declared doubles, labeled as such.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	cueRunLineage,
	cueWorkflowIdentity,
	cueWorkflowRef,
	executeCueRunAction,
	type CueAdmissionEvent,
	type CueManagedDeps,
	type CueRunActionDeps,
	type CueRunSessionRecord,
	type CueSpawnAuthorityPort,
	type OnCueRunParams,
} from '../../../main/cue/cue-run-router';
import type { CueExecutionConfig } from '../../../main/cue/cue-executor';
import {
	buildDispatchSnapshot,
	createLocalHostAuthority,
	type AdmissionOutcome,
	type AdmissionRequest,
	type DispatchLease,
} from '../../../shared/maestro-lib/managed/authority';
import {
	leaseAdmission,
	leaseAdmissionAuthority,
} from '../../../shared/maestro-lib/run/start-turn';
import { createHeadlessSpawnAuthority } from '../../../shared/maestro-lib/managed/host-adapter';
import type { WorkflowFenceLifetime } from '../../../shared/maestro-lib/managed/workflows';
import type { ManagedBindingState } from '../../../shared/maestro-lib/managed/binding';
import {
	delegationContextOf,
	isManagedDelegationContext,
	type ManagedDelegationContext,
} from '../../../shared/maestro-lib/managed/delegation';
import { canonicalJson } from '../../../shared/canonicalJson';
import type { CueRunResult } from '../../../shared/cue/contracts';

const SESSION: CueRunSessionRecord = {
	id: 'agent-1',
	name: 'Builder',
	toolType: 'claude-code',
	projectRoot: '/work/project',
	sessionSshRemoteConfig: { enabled: false, remoteId: null },
	customModel: 'opus',
};

const EVENT = {
	id: 'evt-1',
	type: 'time.scheduled',
	triggerName: 'nightly',
} as OnCueRunParams['event'];

function fakeResult(runId: string): CueRunResult {
	return { runId, subscriptionName: 'nightly', status: 'completed' } as unknown as CueRunResult;
}

/** The real headless port composed for a Cue engine, over a declared binding double. */
function cuePort(
	standing: 'standalone' | 'enrolled' = 'enrolled',
	actorId = 'actor-registered',
	now = () => Date.now()
): CueSpawnAuthorityPort {
	let leases = 0;
	const authority = createLocalHostAuthority({
		authorityId: 'endpoint-test',
		decide: () => ({ decision: 'allow', policyRevision: 7 }),
		now: () => 1_700_000_000_000,
		newId: () => `lease-${++leases}`,
	});
	const binding: ManagedBindingState =
		standing === 'standalone'
			? { state: 'standalone', files: [] }
			: {
					state: 'enrolled',
					file: '/data/managed-binding.json',
					record: {
						contractVersion: '1' as never,
						installationId: 'inst-1',
						authorityId: 'endpoint-test',
						endpointRef: '/tmp/endpoint.sock',
						enrolledAt: '2026-10-21T00:00:00.000Z',
						policySources: [{ id: 'endpoint-test', kind: 'endpoint', revision: 7 }],
						policyRevision: 7,
						digest: 'd',
					},
				};
	return createHeadlessSpawnAuthority({
		installation: { installationId: 'inst-1', runtimeId: 'cue-1', processEpoch: 'e1' },
		binding,
		host: { authority, policy: () => ({ sources: [], policyRevision: 7 }) },
		origin: 'cue',
		actor: { kind: 'human', id: actorId },
		now,
	});
}

function makeDeps(managed?: CueManagedDeps) {
	const deps = {
		executeCuePrompt: vi.fn(async (c: CueExecutionConfig) => fakeResult(c.runId)),
		executeCueShell: vi.fn(async (c: { runId: string }) => fakeResult(c.runId)),
		executeCueCli: vi.fn(async (c: { runId: string }) => fakeResult(c.runId)),
		stopCueRun: vi.fn(() => true),
		findSession: vi.fn((id: string) => (id === SESSION.id ? SESSION : undefined)),
		resolveAgentPath: vi.fn(async () => '/detected/claude'),
		sshStore: { getSshRemotes: () => [] },
		getAgentConfigValues: vi.fn(() => ({}) as Record<string, unknown>),
		onLog: vi.fn(),
		onNotify: vi.fn(async (p: { runId: string }) => fakeResult(p.runId)),
		...(managed ? { managed } : {}),
	};
	return deps as unknown as CueRunActionDeps & typeof deps;
}

function params(overrides: Partial<OnCueRunParams> = {}): OnCueRunParams {
	return {
		runId: 'run-9',
		sessionId: SESSION.id,
		prompt: 'review the nightly build',
		subscriptionName: 'nightly',
		event: EVENT,
		timeoutMs: 60_000,
		pipelineName: 'Nightly QA',
		chainRootId: 'root-1',
		parentEventId: 'run-8',
		...overrides,
	};
}

const FENCE = { ownerEpoch: 'epoch-3', fencingToken: 'fence-3' };

describe('Cue run lineage', () => {
	it('names the pipeline as the workflow, the event as the trigger, and an edit as a new version', () => {
		const a = cueWorkflowIdentity({
			subscriptionName: 'nightly',
			pipelineName: 'Nightly QA',
			prompt: 'p1',
			event: EVENT,
		});
		const b = cueWorkflowIdentity({ subscriptionName: 'nightly', prompt: 'p2', event: EVENT });
		expect(a.workflowId).toBe('cue-pipeline:Nightly QA');
		expect(a.triggerEventId).toBe('time.scheduled:evt-1');
		expect(b.workflowId).toBe('cue:nightly');
		expect(a.version).not.toBe(b.version);
		expect(cueWorkflowRef(a, null)).toBeNull();
		expect(cueWorkflowRef(a, FENCE)).toEqual({ ...a, ...FENCE });
	});

	it('is one request per firing under the chain root, delegated through the subscription to its owner', () => {
		const lineage = cueRunLineage({
			runId: 'run-9',
			chainRootId: 'root-1',
			parentEventId: 'run-8',
			subscriptionName: 'nightly',
			prompt: 'p',
			event: EVENT,
			ownerAgentId: 'agent-1',
			attemptId: 'attempt-1',
		});
		expect(lineage.identity).toEqual({
			requestId: 'run-9',
			idempotencyKey: 'run-9',
			attemptId: 'attempt-1',
			runId: 'run-9',
			rootRunId: 'root-1',
			parentRunId: 'run-8',
		});
		expect(lineage.delegation.chain).toEqual([
			{ kind: 'service', id: 'cue-subscription:nightly' },
			{ kind: 'agent', id: 'agent-1' },
		]);
		expect(lineage.traceId).toBe('cue:root-1:run-9:attempt-1');
		// A root trigger is its own root and has no parent.
		const root = cueRunLineage({
			runId: 'run-1',
			subscriptionName: 'nightly',
			prompt: 'p',
			event: EVENT,
			ownerAgentId: 'agent-1',
			attemptId: 'a',
		});
		expect(root.identity.rootRunId).toBe('run-1');
		expect(root.identity.parentRunId).toBeNull();
	});
});

describe('executeCueRunAction under management', () => {
	it('a standalone host asks no admission and hands the executor no context', async () => {
		const port = cuePort('standalone');
		const deps = makeDeps({ port: () => port, workflowFence: () => FENCE });
		await executeCueRunAction(deps, params());
		const config = deps.executeCuePrompt.mock.calls[0][0];
		expect(config.admission).toBeUndefined();
		expect(config.managed).toBeUndefined();
	});

	it('a host with no port to offer is unmanaged', async () => {
		const deps = makeDeps({ port: () => null, workflowFence: () => FENCE });
		await executeCueRunAction(deps, params());
		expect(deps.executeCuePrompt.mock.calls[0][0].admission).toBeUndefined();
	});

	it('an unowned workflow is refused unavailable before the agent is resolved into a launch', async () => {
		const events: CueAdmissionEvent[] = [];
		const deps = makeDeps({
			port: () => cuePort(),
			workflowFence: () => null,
			onAdmission: (event) => events.push(event),
		});
		const result = await executeCueRunAction(deps, params());

		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.exitCode).toBeNull();
		expect(result.managed).toEqual({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(result.stderr).toContain(
			'[managed-unavailable] Cue workflow "cue-pipeline:Nightly QA" has no workflow owner fence'
		);
		expect(result.pipelineName).toBe('Nightly QA');
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe('refused');
		expect(events[0].lineage.identity.rootRunId).toBe('root-1');
		expect(deps.onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('"nightly" was not admitted (unavailable, runtime-unavailable)')
		);
	});

	it('with an owner fence the run reaches the executor bound on its lineage, origin cue', async () => {
		const events: CueAdmissionEvent[] = [];
		const launch = { route: { provider: 'claude-code' } } as never;
		const port = cuePort();
		const deps = makeDeps({
			port: () => port,
			workflowFence: (workflow) =>
				workflow.workflowId === 'cue-pipeline:Nightly QA' ? FENCE : null,
			launch,
			account: 'acct-ref',
			newId: () => 'attempt-7',
			onAdmission: (event) => events.push(event),
		});
		await executeCueRunAction(deps, params());

		expect(deps.executeCuePrompt).toHaveBeenCalledTimes(1);
		const config = deps.executeCuePrompt.mock.calls[0][0];
		expect(config.managed).toBe(launch);
		const admission = config.admission!;
		expect(admission.authority).not.toBe(port.authority);
		expect(admission.authority.authorityId).toBe(port.authority.authorityId);
		expect(admission.policy.policyRevision).toBe(7);
		expect(admission.account).toBe('acct-ref');
		const context = admission.context;
		expect(context.origin).toBe('cue');
		expect(context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(context.installation.installationId).toBe('inst-1');
		expect(context.identity).toEqual({
			requestId: 'run-9',
			idempotencyKey: 'run-9',
			attemptId: 'attempt-7',
			runId: 'run-9',
			rootRunId: 'root-1',
			parentRunId: 'run-8',
		});
		expect(context.delegation.chain).toEqual([
			{ kind: 'service', id: 'cue-subscription:nightly' },
			{ kind: 'agent', id: 'agent-1' },
		]);
		expect(context.workflow).toMatchObject({
			workflowId: 'cue-pipeline:Nightly QA',
			triggerEventId: 'time.scheduled:evt-1',
			ownerEpoch: 'epoch-3',
			fencingToken: 'fence-3',
		});
		expect(context.policyRevision).toBe(7);
		expect(context.traceId).toBe('cue:root-1:run-9:attempt-7');
		// Nothing admitted yet: the authority decides at the spawn, in the lifecycle.
		expect(events).toEqual([]);
		expect(port.authority.live()).toEqual([]);
	});

	it('a context the port will not bind is denied with the verifier code', async () => {
		const port: CueSpawnAuthorityPort = {
			...cuePort(),
			context: () => ({
				ok: false,
				code: 'context-mismatch',
				problems: ['installation x is not this one'],
			}),
		};
		const deps = makeDeps({ port: () => port, workflowFence: () => FENCE });
		const result = await executeCueRunAction(deps, params());
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
		expect(result.managed).toEqual({ state: 'denied', code: 'context-mismatch' });
		expect(result.stderr).toContain('installation x is not this one');
	});

	it('reads the standing on every firing', async () => {
		let standing: 'standalone' | 'enrolled' = 'standalone';
		const deps = makeDeps({ port: () => cuePort(standing), workflowFence: () => null });
		await executeCueRunAction(deps, params({ runId: 'run-a' }));
		expect(deps.executeCuePrompt).toHaveBeenCalledTimes(1);
		standing = 'enrolled';
		const refused = await executeCueRunAction(deps, params({ runId: 'run-b' }));
		expect(deps.executeCuePrompt).toHaveBeenCalledTimes(1);
		expect(refused.managed?.state).toBe('unavailable');
	});

	it('leaves the notify action to its own gate (the shell and maestro-cli actions are admitted below)', async () => {
		const deps = makeDeps({ port: () => cuePort(), workflowFence: () => null });
		await executeCueRunAction(
			deps,
			params({ action: 'notify', notify: { message: 'hi' } as never })
		);
		expect(deps.onNotify).toHaveBeenCalledTimes(1);
	});
});

describe('a shell action under management (MRC-07-03)', () => {
	const shellParams = (overrides: Partial<OnCueRunParams> = {}) =>
		params({
			action: 'command',
			prompt: 'shell',
			command: { mode: 'shell', shell: 'echo hi' } as never,
			...overrides,
		});

	it('a standalone host hands the shell executor no admission', async () => {
		const deps = makeDeps({ port: () => cuePort('standalone'), workflowFence: () => FENCE });
		await executeCueRunAction(deps, shellParams());
		expect(deps.executeCueShell).toHaveBeenCalledTimes(1);
		expect(deps.executeCueShell.mock.calls[0][0]).not.toHaveProperty('admission');
	});

	it('an unowned workflow is refused unavailable before the command is substituted', async () => {
		const events: CueAdmissionEvent[] = [];
		const deps = makeDeps({
			port: () => cuePort(),
			workflowFence: () => null,
			onAdmission: (event) => events.push(event),
		});
		const result = await executeCueRunAction(deps, shellParams());

		expect(deps.executeCueShell).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.managed).toEqual({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(result.stderr).toContain('cue-pipeline:Nightly QA');
		expect(events).toHaveLength(1);
		// The versioned text of a shell action is its command, not the prompt carrier.
		expect(events[0].lineage.workflow.version).toBe(
			cueWorkflowIdentity({
				subscriptionName: 'nightly',
				pipelineName: 'Nightly QA',
				prompt: 'echo hi',
				action: 'command',
				event: EVENT,
			}).version
		);
		expect(events[0].lineage.delegation.chain).toEqual([
			{ kind: 'service', id: 'cue-subscription:nightly' },
			{ kind: 'agent', id: 'agent-1' },
		]);
	});

	it('with an owner fence the shell executor receives the admission bound on the run lineage', async () => {
		const port = cuePort();
		const deps = makeDeps({
			port: () => port,
			workflowFence: () => FENCE,
			account: 'acct-ref',
			newId: () => 'attempt-s',
		});
		await executeCueRunAction(deps, shellParams());

		expect(deps.executeCueShell).toHaveBeenCalledTimes(1);
		const config = deps.executeCueShell.mock.calls[0][0] as unknown as {
			shellCommand: string;
			admission: CueExecutionConfig['admission'];
		};
		expect(config.shellCommand).toBe('echo hi');
		const admission = config.admission!;
		expect(admission.authority).not.toBe(port.authority);
		expect(admission.authority.authorityId).toBe(port.authority.authorityId);
		expect(admission.policy.policyRevision).toBe(7);
		expect(admission.account).toBe('acct-ref');
		expect(admission.context.origin).toBe('cue');
		expect(admission.context.identity).toMatchObject({
			requestId: 'run-9',
			attemptId: 'attempt-s',
			rootRunId: 'root-1',
			parentRunId: 'run-8',
		});
		expect(admission.context.workflow).toMatchObject({
			workflowId: 'cue-pipeline:Nightly QA',
			ownerEpoch: 'epoch-3',
			fencingToken: 'fence-3',
		});
	});
});

describe('a maestro-cli action under management (MRC-07-04)', () => {
	const CLI_CALL = { command: 'send', target: 'agent-2', message: 'hi' };
	const cliParams = (overrides: Partial<OnCueRunParams> = {}) =>
		params({
			action: 'command',
			prompt: 'cli',
			command: { mode: 'cli', cli: CLI_CALL } as never,
			...overrides,
		});
	type CliConfig = {
		cli: unknown;
		admission?: CueExecutionConfig['admission'];
		delegation: ManagedDelegationContext;
	};
	const cliConfig = (deps: ReturnType<typeof makeDeps>): CliConfig =>
		deps.executeCueCli.mock.calls[0][0] as unknown as CliConfig;

	it('a standalone host hands the cli executor the run lineage as the context, with no admission', async () => {
		const deps = makeDeps({ port: () => cuePort('standalone'), workflowFence: () => FENCE });
		await executeCueRunAction(deps, cliParams());

		expect(deps.executeCueShell).not.toHaveBeenCalled();
		expect(deps.executeCueCli).toHaveBeenCalledTimes(1);
		const config = cliConfig(deps);
		expect(config).not.toHaveProperty('admission');
		expect(config.cli).toEqual(CLI_CALL);
		expect(isManagedDelegationContext(config.delegation)).toBe(true);
		expect(config.delegation).toMatchObject({
			identity: {
				requestId: 'run-9',
				runId: 'run-9',
				rootRunId: 'root-1',
				parentRunId: 'run-8',
			},
			traceId: expect.stringMatching(/^cue:root-1:run-9:/),
			workflow: null,
			policyRevision: null,
			delegation: {
				chain: [
					{ kind: 'service', id: 'cue-subscription:nightly' },
					{ kind: 'agent', id: 'agent-1' },
				],
				grantRef: null,
			},
		});
	});

	it('a host with no port to offer hands the same context', async () => {
		const deps = makeDeps();
		await executeCueRunAction(deps, cliParams());
		expect(cliConfig(deps).delegation.workflow).toBeNull();
	});

	it('an unowned workflow is refused unavailable before the target is substituted', async () => {
		const events: CueAdmissionEvent[] = [];
		const deps = makeDeps({
			port: () => cuePort(),
			workflowFence: () => null,
			onAdmission: (event) => events.push(event),
		});
		const result = await executeCueRunAction(deps, cliParams());

		expect(deps.executeCueCli).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.managed).toEqual({ state: 'unavailable', code: 'runtime-unavailable' });
		expect(events).toHaveLength(1);
		// The versioned text of a cli action is the call itself, not the prompt carrier.
		expect(events[0].lineage.workflow.version).toBe(
			cueWorkflowIdentity({
				subscriptionName: 'nightly',
				pipelineName: 'Nightly QA',
				prompt: canonicalJson(CLI_CALL),
				action: 'command',
				event: EVENT,
			}).version
		);
	});

	it('with an owner fence the cli executor receives the admission and the verified context as the one the child carries', async () => {
		const port = cuePort();
		const deps = makeDeps({
			port: () => port,
			workflowFence: () => FENCE,
			account: 'acct-ref',
			newId: () => 'attempt-c',
		});
		await executeCueRunAction(deps, cliParams());

		expect(deps.executeCueCli).toHaveBeenCalledTimes(1);
		const config = cliConfig(deps);
		const admission = config.admission!;
		expect(admission.authority).not.toBe(port.authority);
		expect(admission.authority.authorityId).toBe(port.authority.authorityId);
		expect(admission.account).toBe('acct-ref');
		expect(admission.context.origin).toBe('cue');
		expect(config.delegation).toEqual(delegationContextOf(admission.context));
		expect(config.delegation).toMatchObject({
			identity: { requestId: 'run-9', attemptId: 'attempt-c', rootRunId: 'root-1' },
			workflow: { workflowId: 'cue-pipeline:Nightly QA', ownerEpoch: 'epoch-3' },
			policyRevision: 7,
		});
	});
});

describe('the owner fence claimed per firing (MRC-07-06)', () => {
	describe.each([
		{ name: 'prompt', overrides: {} },
		{
			name: 'shell',
			overrides: { action: 'command', command: { mode: 'shell', shell: 'echo hi' } },
		},
		{
			name: 'cli',
			overrides: {
				action: 'command',
				command: { mode: 'cli', cli: { command: 'send', target: 'agent-2', message: 'hi' } },
			},
		},
	] satisfies { name: string; overrides: Partial<OnCueRunParams> }[])(
		'$name owner claim',
		({ overrides }) => {
			it.each(['withdrawn', 'standalone', 'replacement', 'mutated'] as const)(
				'refuses %s authority while the owner claim is pending',
				async (change) => {
					const initial = cuePort();
					let current: CueSpawnAuthorityPort | null = initial;
					const entered = Promise.withResolvers<void>();
					const claim = Promise.withResolvers<typeof FENCE>();
					const onAdmission = vi.fn();
					const deps = makeDeps({
						port: () => current,
						workflowFence: () => {
							entered.resolve();
							return claim.promise;
						},
						onAdmission,
					});
					const pending = executeCueRunAction(deps, params(overrides));
					await entered.promise;
					if (change === 'withdrawn') current = null;
					else if (change === 'standalone') current = cuePort('standalone');
					else if (change === 'replacement') current = cuePort();
					else Object.defineProperty(initial, 'authority', { value: cuePort().authority });
					claim.resolve(FENCE);
					const result = await pending;
					expect(result).toMatchObject({
						status: 'failed',
						executionStarted: false,
						pipelineName: 'Nightly QA',
						managed: { state: 'unavailable', code: 'runtime-unavailable' },
					});
					expect(result.stderr).toContain('standing or authority changed');
					expect(onAdmission).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({ kind: 'refused' })
					);
					expect(deps.executeCuePrompt).not.toHaveBeenCalled();
					expect(deps.executeCueShell).not.toHaveBeenCalled();
					expect(deps.executeCueCli).not.toHaveBeenCalled();
				}
			);

			it.each(['fenced', 'refused'] as const)(
				'stays stopped after a late %s claim',
				async (answer) => {
					const port = cuePort();
					const entered = Promise.withResolvers<void>();
					const claim =
						Promise.withResolvers<
							Awaited<ReturnType<NonNullable<CueManagedDeps['workflowFence']>>>
						>();
					const controller = new AbortController();
					const onAdmission = vi.fn();
					const context = vi.spyOn(port, 'context');
					const deps = makeDeps({
						port: () => port,
						workflowFence: () => {
							entered.resolve();
							return claim.promise;
						},
						onAdmission,
					});
					const pending = executeCueRunAction(
						deps,
						params({ ...overrides, signal: controller.signal })
					);
					await entered.promise;
					controller.abort();
					claim.resolve(
						answer === 'fenced'
							? FENCE
							: {
									fence: null,
									state: 'denied',
									code: 'policy-denied',
									message: 'Owner revoked',
								}
					);
					expect(await pending).toMatchObject({
						status: 'stopped',
						executionStarted: false,
						pipelineName: 'Nightly QA',
						exitCode: null,
					});
					expect(context).not.toHaveBeenCalled();
					expect(onAdmission).not.toHaveBeenCalled();
					expect(deps.executeCuePrompt).not.toHaveBeenCalled();
					expect(deps.executeCueShell).not.toHaveBeenCalled();
					expect(deps.executeCueCli).not.toHaveBeenCalled();
				}
			);
		}
	);

	it('binds the fresh port policy and verified lineage after each successful claim', async () => {
		const initial = cuePort();
		const current: CueSpawnAuthorityPort = {
			...initial,
			policy: () => ({
				sources: [{ id: 'endpoint-test', kind: 'endpoint', revision: 8 }],
				policyRevision: 8,
			}),
			context: vi.fn(initial.context),
		};
		let offered = initial;
		let attempt = 0;
		const workflowFence = vi.fn(async () => {
			offered = current;
			return { ownerEpoch: `epoch-${attempt}`, fencingToken: `fence-${attempt}` };
		});
		const deps = makeDeps({
			port: () => offered,
			workflowFence,
			newId: () => `attempt-${++attempt}`,
		});
		for (const runId of ['run-9', 'retry-9']) {
			await executeCueRunAction(deps, params({ runId }));
			const context = deps.executeCuePrompt.mock.calls.at(-1)![0].admission!.context;
			expect(context).toMatchObject({
				actor: { kind: 'human', id: 'actor-registered' },
				origin: 'cue',
				policyRevision: 8,
				identity: {
					requestId: runId,
					attemptId: `attempt-${attempt}`,
					rootRunId: 'root-1',
					parentRunId: 'run-8',
				},
				workflow: {
					...FENCE,
					ownerEpoch: `epoch-${attempt}`,
					fencingToken: `fence-${attempt}`,
					triggerEventId: 'time.scheduled:evt-1',
				},
			});
			expect(workflowFence).toHaveBeenLastCalledWith(expect.anything(), {
				runId,
				attemptId: `attempt-${attempt}`,
			});
		}
		expect(current.context).toHaveBeenCalledTimes(2);
		expect(deps.executeCuePrompt).toHaveBeenCalledTimes(2);
	});

	it('does not execute when the fresh context is revoked after the owner claim', async () => {
		const port = cuePort();
		const deps = makeDeps({
			port: () => port,
			workflowFence: async () => {
				vi.spyOn(port, 'context').mockReturnValue({
					ok: false,
					code: 'context-mismatch',
					problems: ['actor revoked'],
				});
				return FENCE;
			},
		});
		const result = await executeCueRunAction(deps, params());
		expect(result.managed).toEqual({ state: 'denied', code: 'context-mismatch' });
		expect(result.stderr).toContain('actor revoked');
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
	});

	it('propagates an unreadable host after the claim without starting an executor', async () => {
		const port = cuePort();
		const readPort = vi.fn(() => port);
		const deps = makeDeps({
			port: readPort,
			workflowFence: async () => {
				readPort.mockImplementation(() => {
					throw new Error('host read failed');
				});
				return FENCE;
			},
		});
		await expect(executeCueRunAction(deps, params())).rejects.toThrow('host read failed');
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
	});

	it('asks the fence producer for this run and attempt, awaits it, and binds what it answers', async () => {
		const asked: unknown[] = [];
		const port = cuePort();
		const deps = makeDeps({
			port: () => port,
			workflowFence: async (workflow, run) => {
				asked.push([workflow, run]);
				await new Promise((resolve) => setTimeout(resolve, 1));
				return { ownerEpoch: '5', fencingToken: 'token-5' };
			},
			newId: () => 'attempt-w',
		});
		await executeCueRunAction(deps, params());

		expect(asked).toEqual([
			[
				cueWorkflowIdentity({
					subscriptionName: 'nightly',
					pipelineName: 'Nightly QA',
					prompt: 'review the nightly build',
					event: EVENT,
				}),
				{ runId: 'run-9', attemptId: 'attempt-w' },
			],
		]);
		expect(deps.executeCuePrompt).toHaveBeenCalledTimes(1);
		const config = deps.executeCuePrompt.mock.calls[0][0];
		expect(config.admission?.context.workflow).toMatchObject({
			workflowId: 'cue-pipeline:Nightly QA',
			ownerEpoch: '5',
			fencingToken: 'token-5',
		});
	});

	it("the producer's refusal is the run's result, with its state and code, on the prompt and the shell path", async () => {
		const events: CueAdmissionEvent[] = [];
		const deps = makeDeps({
			port: () => cuePort(),
			workflowFence: () => ({
				fence: null,
				state: 'denied',
				code: 'policy-denied',
				message: 'Workflow "cue-pipeline:Nightly QA" is fenced: the registry holds another owner.',
			}),
			onAdmission: (event) => events.push(event),
		});
		const prompt = await executeCueRunAction(deps, params());
		expect(prompt.managed).toEqual({ state: 'denied', code: 'policy-denied' });
		expect(prompt.stderr).toContain(
			'[managed-denied] Workflow "cue-pipeline:Nightly QA" is fenced'
		);
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();

		const shell = await executeCueRunAction(
			deps,
			params({ action: 'command', command: { mode: 'shell', shell: 'echo hi' } as never })
		);
		expect(shell.managed).toEqual({ state: 'denied', code: 'policy-denied' });
		expect(deps.executeCueShell).not.toHaveBeenCalled();
		expect(events.map((e) => e.kind)).toEqual(['refused', 'refused']);
		expect(events[0]).toMatchObject({ state: 'denied', code: 'policy-denied' });
	});

	it('a producer that cannot be reached is unavailable by its own reason, never an unmanaged run', async () => {
		const deps = makeDeps({
			port: () => cuePort(),
			workflowFence: async () => ({
				fence: null,
				state: 'unavailable',
				code: 'capability-unsupported',
				message: 'The endpoint serves no workflow owner operation (CP-03, owner mega-maestro).',
			}),
		});
		const result = await executeCueRunAction(deps, params());
		expect(result.managed).toEqual({ state: 'unavailable', code: 'capability-unsupported' });
		expect(result.stderr).toContain('CP-03');
		expect(deps.executeCuePrompt).not.toHaveBeenCalled();
	});
});

describe('Cue custody across preparation, admission and the spawn gate', () => {
	// The executor is a declared double: this exercises its real authority and lease gate,
	// without running a provider or claiming a qualified shell/CLI route.
	const snapshot = buildDispatchSnapshot(
		{ command: '/fixture/claude', args: ['--print', 'review'], cwd: SESSION.projectRoot, env: {} },
		{
			provider: 'claude-code',
			model: 'opus',
			operation: 'start',
			account: null,
			target: { kind: 'local' },
		}
	);

	describe.each(['prepared', 'awaiting admission', 'spawn gate'] as const)('%s', (boundary) => {
		it.each([
			'withdrawn',
			'standalone',
			'replacement',
			'mutated',
			'policy',
			'sources',
			'actor',
			'rejected',
			'unreadable',
		] as const)('refuses %s custody and releases any unused lease', async (change) => {
			const initial = cuePort();
			const owner = initial.authority;
			let current: CueSpawnAuthorityPort | null = initial;
			let unreadable = false;
			const deps = makeDeps({
				port: () => {
					if (unreadable) throw new Error('fixture custody read failed');
					return current;
				},
				workflowFence: () => FENCE,
			});
			await executeCueRunAction(deps, params());
			const admission = deps.executeCuePrompt.mock.calls[0][0].admission!;
			const request = { context: admission.context, policy: admission.policy, snapshot };
			const entered = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const issued: DispatchLease[] = [];
			const originalAdmit = owner.admit.bind(owner);
			const asked = vi.spyOn(owner, 'admit').mockImplementation(async (input: AdmissionRequest) => {
				if (boundary === 'awaiting admission') {
					entered.resolve();
					await resume.promise;
				}
				const outcome = await originalAdmit(input);
				if (outcome.state === 'admitted') issued.push(outcome.lease);
				return outcome;
			});
			const pending = boundary === 'prepared' ? null : admission.authority.admit(request);
			if (boundary === 'awaiting admission') await entered.promise;
			if (boundary === 'spawn gate') expect((await pending)?.state).toBe('admitted');

			if (change === 'withdrawn') current = null;
			else if (change === 'standalone') current = cuePort('standalone');
			else if (change === 'replacement') current = cuePort();
			else if (change === 'mutated')
				Object.defineProperty(initial, 'authority', { value: cuePort().authority });
			else if (change === 'policy')
				current = { ...initial, policy: () => ({ sources: [], policyRevision: 8 }) };
			else if (change === 'sources')
				current = {
					...initial,
					policy: () => ({
						sources: [{ id: 'new-ceiling', kind: 'endpoint', revision: 7 }],
						policyRevision: 7,
					}),
				};
			else if (change === 'actor')
				current = { ...initial, context: cuePort('enrolled', 'other-actor').context };
			else if (change === 'rejected')
				current = {
					...initial,
					context: () => ({ ok: false, code: 'unauthenticated', problems: ['actor revoked'] }),
				};
			else unreadable = true;

			resume.resolve();
			if (boundary === 'spawn gate') {
				const gate = leaseAdmission(admission.authority, issued[0]);
				expect(gate.admit(snapshot)).toMatchObject({ ok: false, code: 'lease-invalid' });
			} else {
				expect(await (pending ?? admission.authority.admit(request))).toMatchObject({
					state: 'unavailable',
					code: 'runtime-unavailable',
				});
			}
			expect(asked).toHaveBeenCalledTimes(boundary === 'prepared' ? 0 : 1);
			expect(owner.live()).toEqual([]);
			for (const lease of issued) {
				expect(lease.state()).toBe('released');
				expect(lease.ended().release).toMatchObject({ outcome: 'spawn-failed' });
			}
		});
	});

	it.each(['prepared', 'awaiting admission', 'spawn gate'] as const)(
		'rejects changed request context and policy at %s even with unchanged host custody',
		async (boundary) => {
			for (const field of ['context', 'policy'] as const) {
				const port = cuePort();
				const deps = makeDeps({ port: () => port, workflowFence: () => FENCE });
				await executeCueRunAction(deps, params());
				const admission = deps.executeCuePrompt.mock.calls[0][0].admission!;
				const request = { context: admission.context, policy: admission.policy, snapshot };
				const changeRequest = () => {
					if (field === 'context') request.context.actor.id = 'changed-request-actor';
					else
						request.policy.sources = [
							{ id: 'changed-request-policy', kind: 'endpoint', revision: 7 },
						];
				};
				const originalAdmit = port.authority.admit.bind(port.authority);
				const issued: DispatchLease[] = [];
				const asked = vi.spyOn(port.authority, 'admit').mockImplementation(async (input) => {
					const outcome = await originalAdmit(input);
					if (outcome.state === 'admitted') issued.push(outcome.lease);
					if (boundary === 'awaiting admission') changeRequest();
					return outcome;
				});
				if (boundary === 'prepared') changeRequest();
				const outcome = await admission.authority.admit(request);
				if (boundary === 'spawn gate') {
					if (outcome.state !== 'admitted') throw new Error(`Unexpected ${outcome.state}`);
					changeRequest();
					const gate = leaseAdmission(admission.authority, outcome.lease);
					expect(gate.admit(snapshot)).toMatchObject({ ok: false, code: 'lease-invalid' });
				} else {
					expect(outcome).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
				}
				expect(asked).toHaveBeenCalledTimes(boundary === 'prepared' ? 0 : 1);
				expect(port.authority.live()).toEqual([]);
				for (const lease of issued)
					expect(lease.ended().release).toMatchObject({ outcome: 'spawn-failed' });
			}
		}
	);

	it.each([
		{ state: 'unknown', code: 'outcome-unknown', message: 'Acknowledgment lost' },
		{ state: 'denied', code: 'policy-denied', message: 'Actor revoked', policyRevision: 7 },
		{ state: 'unavailable', code: 'runtime-unavailable', message: 'Endpoint unavailable' },
	] satisfies AdmissionOutcome[])(
		'preserves producer $state when custody changes during admission',
		async (outcome) => {
			const initial = cuePort();
			let current: CueSpawnAuthorityPort | null = initial;
			const deps = makeDeps({ port: () => current, workflowFence: () => FENCE });
			await executeCueRunAction(deps, params());
			const admission = deps.executeCuePrompt.mock.calls[0][0].admission!;
			const entered = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<AdmissionOutcome>();
			vi.spyOn(initial.authority, 'admit').mockImplementation(() => {
				entered.resolve();
				return answer.promise;
			});
			const pending = admission.authority.admit({ ...admission, snapshot });
			await entered.promise;
			current = null;
			answer.resolve(outcome);
			expect(await pending).toBe(outcome);
			expect(initial.authority.live()).toEqual([]);
		}
	);

	it('allows equivalent fresh ports and verification times while preserving producer lease custody', async () => {
		let now = 1_700_000_000_000;
		const initial = cuePort('enrolled', 'actor-registered', () => now);
		const deps = makeDeps({ port: () => ({ ...initial }), workflowFence: () => FENCE });
		await executeCueRunAction(deps, params());
		const admission = deps.executeCuePrompt.mock.calls[0][0].admission!;
		const request = { context: admission.context, policy: admission.policy, snapshot };
		const asked = vi.spyOn(initial.authority, 'admit');
		now += 1000;
		const outcome = await admission.authority.admit(request);
		expect(asked).toHaveBeenCalledExactlyOnceWith(request);
		if (outcome.state !== 'admitted') throw new Error(`Unexpected ${outcome.state}`);
		const gate = leaseAdmission(admission.authority, outcome.lease);
		expect(leaseAdmissionAuthority(gate)).toBe(initial.authority.authorityId);
		expect(admission.authority.live()).toEqual(initial.authority.live());
		expect(admission.authority.live()[0]).toBe(outcome.lease);
		now += 1000;
		expect(gate.admit(snapshot)).toEqual({ ok: true });
		gate.bound?.(1234);
		expect(outcome.lease.pid()).toBe(1234);
		const revoked = vi.fn();
		gate.onRevoked?.(revoked);
		expect(admission.authority.revoke(outcome.lease.leaseId, 'fixture withdrawal')).toBe(true);
		expect(revoked).toHaveBeenCalledExactlyOnceWith('fixture withdrawal');
		expect(initial.authority.live()).toEqual([]);
		const second = await admission.authority.admit(request);
		if (second.state !== 'admitted') throw new Error(`Unexpected ${second.state}`);
		expect(admission.authority.revokeAll('fixture teardown')).toBe(1);
		expect(second.lease.state()).toBe('revoked');
	});

	it('rebinds a fresh attempt after custody replacement without reusing the refused admission', async () => {
		let current = cuePort();
		let attempt = 0;
		const workflowFence = vi.fn(() => FENCE);
		const deps = makeDeps({ port: () => current, workflowFence, newId: () => `try-${++attempt}` });
		await executeCueRunAction(deps, params());
		const first = deps.executeCuePrompt.mock.calls[0][0].admission!;
		current = cuePort();
		expect(await first.authority.admit({ ...first, snapshot })).toMatchObject({
			state: 'unavailable',
		});
		await executeCueRunAction(deps, params());
		const retry = deps.executeCuePrompt.mock.calls[1][0].admission!;
		expect(retry.context.identity).toMatchObject({
			requestId: 'run-9',
			attemptId: 'try-2',
			rootRunId: 'root-1',
			parentRunId: 'run-8',
		});
		expect(retry.context.workflow).toEqual(first.context.workflow);
		expect(workflowFence).toHaveBeenCalledTimes(2);
		const outcome = await retry.authority.admit({ ...retry, snapshot });
		if (outcome.state !== 'admitted') throw new Error(`Unexpected ${outcome.state}`);
		outcome.lease.release({ outcome: 'stopped', by: 'caller' });
		expect(current.authority.live()).toEqual([]);
	});
});

describe('Cue workflow fence lifetime', () => {
	// The owner lifetime and executors are declared doubles. Admission uses the real
	// headless port and local lease authority; this does not qualify a provider route.
	function fixture() {
		const controller = new AbortController();
		const lifetime = {
			signal: controller.signal,
			current: vi.fn(() => !controller.signal.aborted),
			finish: vi.fn<WorkflowFenceLifetime['finish']>().mockResolvedValue(undefined),
		};
		const port = cuePort();
		const workflowFence = vi.fn<NonNullable<CueManagedDeps['workflowFence']>>(async () => ({
			...FENCE,
			lifetime,
		}));
		const deps = makeDeps({ port: () => port, workflowFence });
		return { controller, lifetime, port, workflowFence, deps };
	}

	describe.each([
		{ name: 'prompt', executor: 'executeCuePrompt', overrides: {} },
		{
			name: 'shell',
			executor: 'executeCueShell',
			overrides: {
				action: 'command',
				command: { mode: 'shell', shell: 'echo hi' },
			},
		},
		{
			name: 'cli',
			executor: 'executeCueCli',
			overrides: {
				action: 'command',
				command: { mode: 'cli', cli: { command: 'send', target: 'agent-2' } },
			},
		},
	] satisfies {
		name: string;
		executor: 'executeCuePrompt' | 'executeCueShell' | 'executeCueCli';
		overrides: Partial<OnCueRunParams>;
	}[])('$name', ({ executor, overrides }) => {
		it.each(['cancelled', 'revoked', 'stale'] as const)(
			'settles an unused late %s claim',
			async (change) => {
				const { deps, controller, lifetime, workflowFence } = fixture();
				const caller = new AbortController();
				workflowFence.mockImplementationOnce(async () => {
					if (change === 'cancelled') caller.abort();
					else if (change === 'revoked') controller.abort();
					else lifetime.current.mockReturnValue(false);
					return { ...FENCE, lifetime };
				});
				const result = await executeCueRunAction(
					deps,
					params({ ...overrides, signal: caller.signal })
				);
				expect(result).toMatchObject({ status: 'stopped', executionStarted: false });
				expect(deps[executor]).not.toHaveBeenCalled();
				expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('no_effect');
			}
		);

		it('stops registered work on revocation and waits for its terminal result before settlement', async () => {
			const { deps, controller, lifetime } = fixture();
			const entered = Promise.withResolvers<AbortSignal | undefined>();
			const ended = Promise.withResolvers<CueRunResult>();
			deps[executor].mockImplementation(async (config) => {
				entered.resolve((config as CueExecutionConfig).signal);
				return ended.promise;
			});
			const pending = executeCueRunAction(deps, params(overrides));
			const signal = await entered.promise;
			controller.abort();
			expect(signal?.aborted).toBe(true);
			expect(deps.stopCueRun).toHaveBeenCalledExactlyOnceWith('run-9');
			expect(lifetime.finish).not.toHaveBeenCalled();
			ended.resolve({ ...fakeResult('run-9'), status: 'stopped', executionStarted: true });
			await pending;
			expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('uncertain');
		});
	});

	it.each([
		{ status: 'completed', executionStarted: true, effect: 'applied' },
		{ status: 'failed', executionStarted: true, effect: 'uncertain' },
		{ status: 'failed', executionStarted: false, effect: 'no_effect' },
		{ status: 'failed', effect: 'uncertain' },
		{
			status: 'failed',
			executionStarted: false,
			managed: { state: 'unknown', code: 'outcome-unknown' },
			effect: 'uncertain',
		},
	] as const)(
		'settles $status / $executionStarted as $effect and removes its listener first',
		async ({ effect, ...outcome }) => {
			const { deps, lifetime, controller } = fixture();
			deps.executeCuePrompt.mockResolvedValueOnce({ ...fakeResult('run-9'), ...outcome });
			lifetime.finish.mockImplementationOnce(async () => {
				controller.abort();
			});
			await executeCueRunAction(deps, params());
			expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith(effect);
			expect(deps.stopCueRun).not.toHaveBeenCalled();
		}
	);

	it.each(['before admission', 'after admission', 'spawn gate'] as const)(
		'rechecks current ownership %s without changing the producer lease',
		async (boundary) => {
			const { deps, lifetime, port } = fixture();
			const snapshot = buildDispatchSnapshot(
				{ command: '/fixture/claude', args: [], env: {} },
				{
					provider: 'claude-code',
					model: 'opus',
					operation: 'start',
					account: null,
					target: { kind: 'local' },
				}
			);
			const original = port.authority.admit.bind(port.authority);
			const admit = vi.spyOn(port.authority, 'admit');
			if (boundary === 'after admission') {
				admit.mockImplementationOnce(async (request) => {
					const answer = await original(request);
					lifetime.current.mockReturnValue(false);
					return answer;
				});
			}
			deps.executeCuePrompt.mockImplementationOnce(async ({ admission }) => {
				if (boundary === 'before admission') lifetime.current.mockReturnValue(false);
				const answer = await admission!.authority.admit({
					context: admission!.context,
					policy: admission!.policy,
					snapshot,
				});
				if (boundary === 'spawn gate') {
					expect(answer.state).toBe('admitted');
					if (answer.state !== 'admitted') throw new Error('Expected a lease');
					expect(port.authority.live()[0]).toBe(answer.lease);
					lifetime.current.mockReturnValue(false);
					expect(leaseAdmission(admission!.authority, answer.lease).admit(snapshot)).toMatchObject({
						state: 'denied',
					});
				} else expect(answer.state).toBe('unavailable');
				return { ...fakeResult('run-9'), status: 'failed', executionStarted: false };
			});
			await executeCueRunAction(deps, params());
			expect(admit).toHaveBeenCalledTimes(boundary === 'before admission' ? 0 : 1);
			expect(port.authority.live()).toHaveLength(0);
			expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('no_effect');
		}
	);

	it.each(['before executor', 'in executor'] as const)(
		'retains exceptions %s and settles conservatively',
		async (boundary) => {
			const { deps, lifetime, port, controller } = fixture();
			if (boundary === 'before executor')
				vi.spyOn(port, 'context').mockImplementationOnce(() => {
					throw new Error('context failed');
				});
			else deps.executeCuePrompt.mockRejectedValueOnce(new Error('executor failed'));
			await expect(executeCueRunAction(deps, params())).rejects.toThrow('failed');
			expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith(
				boundary === 'before executor' ? 'no_effect' : 'uncertain'
			);
			controller.abort();
			expect(deps.stopCueRun).not.toHaveBeenCalled();
		}
	);

	it('retains the executor result when settlement fails and reports the uncertainty', async () => {
		const { deps, lifetime } = fixture();
		lifetime.finish.mockRejectedValueOnce(new Error('settlement offline'));
		const result = await executeCueRunAction(deps, params());
		expect(result.status).toBe('completed');
		expect(deps.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('settlement offline'));
	});

	it('reclaims on retry and removes the previous attempt listener', async () => {
		const first = fixture();
		const next = fixture();
		first.workflowFence
			.mockResolvedValueOnce({ ...FENCE, lifetime: first.lifetime })
			.mockResolvedValueOnce({ ...FENCE, lifetime: next.lifetime });
		first.deps.executeCuePrompt.mockResolvedValue({
			...fakeResult('run-9'),
			executionStarted: true,
		});
		await executeCueRunAction(first.deps, params());
		first.controller.abort();
		await executeCueRunAction(first.deps, params({ runId: 'retry-9' }));
		expect(first.workflowFence).toHaveBeenCalledTimes(2);
		expect(first.workflowFence.mock.calls[1][1]).toMatchObject({ runId: 'retry-9' });
		expect(first.lifetime.finish).toHaveBeenCalledExactlyOnceWith('applied');
		expect(next.lifetime.finish).toHaveBeenCalledExactlyOnceWith('applied');
		expect(first.deps.stopCueRun).not.toHaveBeenCalled();
	});

	it('fences an actual fixture process through the existing Cue Stop registry', async () => {
		const { runProcess, stopProcess, getActiveProcessMap } =
			await import('../../../main/cue/cue-process-lifecycle');
		const { deps, controller, lifetime, port } = fixture();
		const runId = 'workflow-lifetime-process';
		deps.stopCueRun.mockImplementation(stopProcess);
		deps.executeCuePrompt.mockImplementationOnce(async (config) => ({
			...fakeResult(runId),
			...(await runProcess(
				runId,
				{
					command: process.execPath,
					args: ['-e', 'setInterval(() => {}, 1000)'],
					cwd: process.cwd(),
					env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
				},
				{
					toolType: 'terminal',
					timeoutMs: 10_000,
					onLog: vi.fn(),
					signal: config.signal,
					managed: {
						...config.admission!,
						attribution: {
							provider: 'terminal',
							model: null,
							operation: 'start',
							account: null,
							target: { kind: 'local' },
						},
					},
				}
			)),
		}));
		const pending = executeCueRunAction(deps, params({ runId }));
		try {
			await vi.waitFor(() => expect(getActiveProcessMap().has(runId)).toBe(true));
			expect(port.authority.live()).toHaveLength(1);
			controller.abort();
			expect(await pending).toMatchObject({ status: 'stopped', executionStarted: true });
			expect(deps.stopCueRun).toHaveBeenCalledExactlyOnceWith(runId);
			expect(getActiveProcessMap().has(runId)).toBe(false);
			expect(port.authority.live()).toHaveLength(0);
			expect(lifetime.finish).toHaveBeenCalledExactlyOnceWith('uncertain');
		} finally {
			stopProcess(runId);
			await pending;
		}
	});
});
