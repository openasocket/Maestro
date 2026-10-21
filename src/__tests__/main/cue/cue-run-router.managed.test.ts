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
import { createLocalHostAuthority } from '../../../shared/maestro-lib/managed/authority';
import { createHeadlessSpawnAuthority } from '../../../shared/maestro-lib/managed/host-adapter';
import type { ManagedBindingState } from '../../../shared/maestro-lib/managed/binding';
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
function cuePort(standing: 'standalone' | 'enrolled' = 'enrolled'): CueSpawnAuthorityPort {
	const authority = createLocalHostAuthority({
		authorityId: 'endpoint-test',
		decide: () => ({ decision: 'allow', policyRevision: 7 }),
		now: () => 1_700_000_000_000,
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
		actor: { kind: 'human', id: 'actor-registered' },
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
		expect(admission.authority).toBe(port.authority);
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

	it('leaves the maestro-cli and notify actions to their own gates (the shell action is admitted below)', async () => {
		const deps = makeDeps({ port: () => cuePort(), workflowFence: () => null });
		await executeCueRunAction(
			deps,
			params({
				action: 'command',
				command: { mode: 'cli', cli: { message: 'hi' } } as never,
			})
		);
		expect(deps.executeCueCli).toHaveBeenCalledTimes(1);
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
		expect(admission.authority).toBe(port.authority);
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

	it('a maestro-cli action carries no admission yet (MRC-07-04), unchanged', async () => {
		const deps = makeDeps({ port: () => cuePort(), workflowFence: () => FENCE });
		await executeCueRunAction(
			deps,
			shellParams({ command: { mode: 'cli', cli: { message: 'hi' } } as never })
		);
		expect(deps.executeCueShell).not.toHaveBeenCalled();
		expect(deps.executeCueCli).toHaveBeenCalledTimes(1);
		expect(deps.executeCueCli.mock.calls[0][0]).not.toHaveProperty('admission');
	});
});
