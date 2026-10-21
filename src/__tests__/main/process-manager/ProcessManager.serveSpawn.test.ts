/**
 * The `spawn` event on the OpenCode serve transport.
 *
 * That transport reports its `exit` through the handlers every other process
 * uses, so anything that pairs a start with an end (the agent-run capture, the
 * dispatch callbacks) has to be told of the start too. This pins that the
 * process manager emits `spawn` for it exactly as it does for a CLI process:
 * once, with the config it was given, after the spawner has the process.
 */

import * as os from 'os';
import { describe, it, expect, vi } from 'vitest';

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';
import type { ProcessConfig } from '../../../main/process-manager/types';
import {
	buildServerKey,
	OPENCODE_MANAGED_PERMISSION_CONFIG,
	opencodeServerPermissionConfig,
} from '../../../main/opencode-server/OpencodeServerManager';
import {
	managedOpencodeRefusal,
	opencodeManagedScope,
	opencodePermissionEffect,
} from '../../../main/process-manager/spawners/OpencodeServerSpawner';
import { fakeAdmission, fakeSpawnPort } from '../../helpers/managedSpawnPort';
import {
	autoRunRunIdentity,
	autoRunTraceId,
	autoRunWorkflowRef,
	newAutoRunTurnRequest,
	nextAutoRunAttempt,
	type AutoRunWorkflowIdentity,
} from '../../../shared/maestro-lib/autorun/attribution';

const SERVE_RESULT = { pid: -1, success: true };

function config(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
	return {
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'opencode',
		cwd: os.tmpdir(),
		command: 'opencode',
		args: [],
		prompt: 'List the files.',
		...overrides,
	} as ProcessConfig;
}

/** A manager whose serve transport is on, with the two spawners stood in for. */
function createManager(): {
	manager: ProcessManager;
	order: string[];
	serve: ReturnType<typeof vi.fn>;
	cli: ReturnType<typeof vi.fn>;
} {
	const manager = new ProcessManager(() => true);
	const order: string[] = [];
	const serve = vi.fn(() => {
		order.push('serve spawner');
		return SERVE_RESULT;
	});
	const cli = vi.fn(() => {
		order.push('cli spawner');
		return { pid: 4242, success: true };
	});
	const internals = manager as unknown as {
		opencodeServerSpawner: { spawn: typeof serve };
		childProcessSpawner: { spawn: typeof cli };
	};
	internals.opencodeServerSpawner = { spawn: serve };
	internals.childProcessSpawner = { spawn: cli };
	manager.on('spawn', () => order.push('spawn event'));
	return { manager, order, serve, cli };
}

describe('ProcessManager spawn event on the OpenCode serve transport', () => {
	it('emits spawn once, with the config, after the serve spawner has the process', () => {
		const { manager, order, serve, cli } = createManager();
		const heard: ProcessConfig[] = [];
		manager.on('spawn', (spawned: ProcessConfig) => heard.push(spawned));
		const spawned = config();

		expect(manager.spawn(spawned)).toBe(SERVE_RESULT);

		expect(serve).toHaveBeenCalledWith(spawned);
		expect(cli).not.toHaveBeenCalled();
		expect(heard).toEqual([spawned]);
		expect(heard[0]).toBe(spawned);
		expect(order).toEqual(['serve spawner', 'spawn event']);
	});

	it('does not let a listener that throws break the spawn', () => {
		const { manager } = createManager();
		manager.on('spawn', () => {
			throw new Error('A capture listener failed.');
		});

		expect(manager.spawn(config())).toBe(SERVE_RESULT);
	});

	it('emits spawn once on the CLI path too, for a turn the serve transport does not take', () => {
		const { manager, order, serve } = createManager();

		// An image keeps an OpenCode turn on the CLI path.
		manager.spawn(config({ images: ['data:image/png;base64,AAAA'] }));

		expect(serve).not.toHaveBeenCalled();
		expect(order).toEqual(['cli spawner', 'spawn event']);
	});
});

/**
 * Managed admission at the process manager's sink (MRC-06-01, MRC-06-08):
 * on a managed host nothing spawns without an admission this manager minted,
 * still live, for the digest of the exact request; the lease is bound to the
 * spawner's result, released by the exit, and a revocation kills. The lease
 * authority is real; only its policy answer is a table.
 */
describe('ProcessManager managed admission at the sink', () => {
	function managedManager(port = fakeSpawnPort()) {
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		const cli = vi.fn(() => ({ pid: 4242, success: true }));
		const internals = manager as unknown as {
			opencodeServerSpawner: { spawn: typeof serve };
			childProcessSpawner: { spawn: typeof cli };
		};
		internals.opencodeServerSpawner = { spawn: serve };
		internals.childProcessSpawner = { spawn: cli };
		const errors: unknown[] = [];
		manager.on('agent-error', (_id: string, error: unknown) => errors.push(error));
		return { manager, port, serve, cli, errors };
	}

	it('refuses a managed spawn that carries no admission, before any branch', () => {
		const { manager, serve, cli, errors } = managedManager();
		const result = manager.spawn(config());

		expect(result).toMatchObject({
			success: false,
			pid: -1,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(serve).not.toHaveBeenCalled();
		expect(cli).not.toHaveBeenCalled();
		expect(errors).toHaveLength(1);
		expect((errors[0] as { message: string }).message).toContain('carries no admission');
	});

	it('refuses a look-alike admission this manager did not mint', () => {
		const { manager, serve } = managedManager();
		expect(manager.spawn(config({ admission: fakeAdmission() }))).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('admits the exact request, refuses a changed one, binds the lease and releases it on exit', async () => {
		const { manager, port, serve } = managedManager();
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			provider: 'opencode',
			operation: 'start',
			executable: 'opencode',
			target: { kind: 'local' },
		});
		expect(port.asked[0].context.actor).toEqual({ kind: 'human', id: 'ada' });

		// A different prompt is a different request: the digest does not match.
		expect(
			manager.spawn({ ...request, prompt: 'Delete everything.', admission: admitted.admission })
		).toMatchObject({ success: false, managed: { state: 'denied', code: 'lease-invalid' } });
		expect(serve).not.toHaveBeenCalled();

		// The admitted request runs on the serve transport under the lease.
		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		const [lease] = port.authority.live();
		expect(lease.state()).toBe('bound');
		expect(manager.admissionOf(request.sessionId)).toBe(admitted.admission);
		expect(manager.admissionLive(request.sessionId)).toEqual({ ok: true });

		// The lease is spent: the same admission cannot start a second process.
		expect(manager.spawn({ ...request, admission: admitted.admission })).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});

		manager.emit('exit', request.sessionId, 0);
		expect(port.authority.live()).toHaveLength(0);
		expect(lease.ended()).toMatchObject({ state: 'released', release: { outcome: 'exited' } });
		expect(manager.admissionOf(request.sessionId)).toBeNull();
	});

	it('returns a policy denial as a decision and starts nothing', async () => {
		const port = fakeSpawnPort({
			decide: () => ({ decision: 'deny', reason: 'opencode is not allowed', policyRevision: 1 }),
		});
		const { manager, serve } = managedManager(port);
		const outcome = await manager.admitSpawn(config(), { peer: 'in-process' });
		expect(outcome).toEqual({
			state: 'denied',
			code: 'policy-denied',
			message: 'opencode is not allowed',
		});
		expect(await manager.spawnAdmitted(config(), { peer: 'in-process' })).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'policy-denied' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('refuses an actor the verifier does not accept, before the authority is asked', async () => {
		const port = fakeSpawnPort({ accept: () => ['the actor is not registered here'] });
		const { manager } = managedManager(port);
		const outcome = await manager.admitSpawn(config(), { peer: 'web-login', username: 'mallory' });
		expect(outcome).toMatchObject({ state: 'denied', code: 'unauthenticated' });
		expect(port.asked).toHaveLength(0);
	});

	it('kills the process when the authority revokes its lease', async () => {
		const { manager, port } = managedManager();
		const kill = vi.spyOn(manager, 'kill').mockReturnValue(true);
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		manager.spawn({ ...request, admission: admitted.admission });

		expect(port.authority.revokeAll('policy changed')).toBe(1);
		expect(kill).toHaveBeenCalledWith(request.sessionId);
		expect(manager.admissionLive(request.sessionId)).toMatchObject({ ok: false });
	});

	it('releases the lease as a spawn failure when the spawner fails', async () => {
		const { manager, port, serve } = managedManager();
		serve.mockReturnValueOnce({ pid: -1, success: false, error: 'no server' });
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		expect(manager.spawn({ ...request, admission: admitted.admission }).success).toBe(false);
		expect(port.authority.live()).toHaveLength(0);
	});

	it('spawns as before on a standalone host and never asks the authority', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		expect(await manager.admitSpawn(config(), { peer: 'in-process' })).toEqual({
			state: 'standalone',
		});
		expect(manager.spawn(config())).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		expect(port.asked).toHaveLength(0);
	});
});

/**
 * An Auto Run attempt at the sink (MRC-07-01B): a spawn that carries its
 * lineage (`config.autoRun`) is bound on the task's request and attempt ids
 * under the workflow's run, with the workflow reference and its owner fence
 * in the verified context, instead of the anonymous identity a chat turn
 * gets. An unowned workflow (no fence) is refused unavailable before the
 * authority is asked, and a standalone host ignores the lineage.
 */
describe('ProcessManager admission on an Auto Run lineage', () => {
	const WORKFLOW: AutoRunWorkflowIdentity = {
		workflowId: 'playbook:/work/.maestro/playbooks/release',
		version: 'docs-2-0badf00d',
		triggerEventId: 'operator:1700000000000',
		runId: 'run-root',
	};
	const FENCE = { ownerEpoch: 'epoch-1', fencingToken: 'fence-1' };
	let ids = 0;
	const newId = () => `id-${++ids}`;
	const taskRequest = () =>
		newAutoRunTurnRequest(WORKFLOW, { purpose: 'task', document: '01-build', newId });

	function managedManager(port = fakeSpawnPort()) {
		const manager = new ProcessManager(() => true, { spawnAuthority: () => port });
		const serve = vi.fn(() => SERVE_RESULT);
		(
			manager as unknown as { opencodeServerSpawner: { spawn: typeof serve } }
		).opencodeServerSpawner = { spawn: serve };
		return { manager, port, serve };
	}

	it('binds the attempt on its lineage: identity, workflow reference, fence and trace id', async () => {
		const { manager, port, serve } = managedManager();
		const attribution = taskRequest();
		const request = config({ autoRun: { attribution, fence: FENCE } });

		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		if (admitted.state !== 'admitted') return;

		expect(port.asked).toHaveLength(1);
		const { context } = port.asked[0];
		expect(context.identity).toEqual(autoRunRunIdentity(attribution));
		expect(context.identity).toMatchObject({
			requestId: attribution.requestId,
			attemptId: attribution.attemptId,
			rootRunId: 'run-root',
			parentRunId: 'run-root',
		});
		expect(context.workflow).toEqual(autoRunWorkflowRef(WORKFLOW, FENCE));
		expect(context.workflow).toMatchObject({
			workflowId: WORKFLOW.workflowId,
			ownerEpoch: 'epoch-1',
			fencingToken: 'fence-1',
		});
		expect(context.traceId).toBe(autoRunTraceId(attribution));
		expect(context.traceId).not.toBe(request.sessionId);
		// The admission the handler journals names the task's request and attempt.
		expect(admitted.admission.requestId).toBe(attribution.requestId);
		expect(admitted.admission.attemptId).toBe(attribution.attemptId);

		expect(manager.spawn({ ...request, admission: admitted.admission })).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
	});

	it('admits a retry as its own attempt under the same request', async () => {
		const { manager, port } = managedManager();
		const first = taskRequest();
		const retry = nextAutoRunAttempt(first, newId);

		const one = await manager.admitSpawn(
			config({ autoRun: { attribution: first, fence: FENCE } }),
			{ peer: 'in-process' }
		);
		const two = await manager.admitSpawn(
			config({ autoRun: { attribution: retry, fence: FENCE } }),
			{ peer: 'in-process' }
		);
		expect(one.state).toBe('admitted');
		expect(two.state).toBe('admitted');
		if (one.state !== 'admitted' || two.state !== 'admitted') return;

		expect(two.admission.requestId).toBe(one.admission.requestId);
		expect(two.admission.attemptId).not.toBe(one.admission.attemptId);
		expect(two.admission.leaseId).not.toBe(one.admission.leaseId);
		expect(port.asked.map((ask) => ask.context.identity.attemptId)).toEqual([
			first.attemptId,
			retry.attemptId,
		]);
	});

	it('refuses an unowned workflow as unavailable before the authority is asked', async () => {
		const { manager, port, serve } = managedManager();
		const request = config({ autoRun: { attribution: taskRequest(), fence: null } });

		const outcome = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(outcome).toMatchObject({ state: 'unavailable', code: 'runtime-unavailable' });
		if (outcome.state !== 'unavailable') return;
		expect(outcome.message).toContain(WORKFLOW.workflowId);
		expect(outcome.message).toContain('no workflow owner fence');
		expect(port.asked).toHaveLength(0);

		// Admit-then-spawn reports the same refusal and starts nothing.
		expect(await manager.spawnAdmitted(request, { peer: 'in-process' })).toMatchObject({
			success: false,
			managed: { state: 'unavailable', code: 'runtime-unavailable' },
		});
		expect(serve).not.toHaveBeenCalled();
	});

	it('binds a chat turn under a fresh identity with no workflow, as before', async () => {
		const { manager, port } = managedManager();
		const request = config();
		const admitted = await manager.admitSpawn(request, { peer: 'in-process' });
		expect(admitted.state).toBe('admitted');
		const { context } = port.asked[0];
		expect(context.workflow).toBeNull();
		expect(context.identity).toMatchObject({ runId: null, rootRunId: null, parentRunId: null });
		expect(context.identity.idempotencyKey).toBe(context.identity.requestId);
		expect(context.traceId).toBe(request.sessionId);
	});

	it('ignores the lineage on a standalone host', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { manager, serve } = managedManager(port);
		const request = config({ autoRun: { attribution: taskRequest(), fence: null } });
		expect(await manager.admitSpawn(request, { peer: 'in-process' })).toEqual({
			state: 'standalone',
		});
		expect(manager.spawn(request)).toBe(SERVE_RESULT);
		expect(serve).toHaveBeenCalledTimes(1);
		expect(port.asked).toHaveLength(0);
	});
});

/**
 * OpenCode server isolation (MRC-06-04): a managed scope never shares an
 * instance with a standalone session or another actor or policy, starts in
 * ask mode, and the route stays explicitly unavailable until the table
 * qualifies it; permission events map to exact effects.
 */
describe('OpenCode server isolation under management', () => {
	const base = { binaryPath: '/opt/opencode', cwd: '/p' };
	const scope = (actorId: string, policyRevision: number | null = 3) => ({
		authorityId: 'endpoint-1',
		actor: { kind: 'human' as const, id: actorId },
		policyRevision,
	});

	it('keys a managed server by authority, actor and policy revision, apart from standalone', () => {
		const standalone = buildServerKey(base);
		const ada = buildServerKey({ ...base, managed: scope('ada') });
		expect(ada).not.toBe(standalone);
		expect(buildServerKey({ ...base, managed: scope('ada') })).toBe(ada);
		expect(buildServerKey({ ...base, managed: scope('bob') })).not.toBe(ada);
		expect(buildServerKey({ ...base, managed: scope('ada', 4) })).not.toBe(ada);
		expect(
			buildServerKey({ ...base, managed: { ...scope('ada'), authorityId: 'other' } })
		).not.toBe(ada);
	});

	it('starts a managed server in ask mode and a standalone one with the auto-approve config', () => {
		expect(opencodeServerPermissionConfig(scope('ada'))).toBe(OPENCODE_MANAGED_PERMISSION_CONFIG);
		expect(OPENCODE_MANAGED_PERMISSION_CONFIG.permission['*']).toBe('ask');
		expect(OPENCODE_MANAGED_PERMISSION_CONFIG.permission.question).toBe('deny');
		expect(opencodeServerPermissionConfig(undefined).permission['*']).toBe('allow');
	});

	it('refuses a managed OpenCode turn while the route table has no qualified producer, and none standalone', () => {
		expect(managedOpencodeRefusal(config())).toBeNull();
		expect(managedOpencodeRefusal(config({ admission: fakeAdmission() }))).toMatchObject({
			state: 'unavailable',
			code: 'capability-unsupported',
		});
	});

	it('takes the server scope from the admission and the effect from the permission event', () => {
		expect(opencodeManagedScope(fakeAdmission({ policyRevision: 7 }))).toEqual({
			authorityId: 'test-authority',
			actor: { kind: 'human', id: 'ada' },
			policyRevision: 7,
		});
		const permission = (type: string, pattern: string | string[], metadata = {}) => ({
			id: 'perm-1',
			type,
			pattern,
			sessionID: 'ses',
			messageID: 'msg',
			title: 'May I?',
			metadata,
			time: { created: 1 },
		});
		expect(opencodePermissionEffect(permission('bash', 'rm *', { command: 'rm -rf /' }))).toEqual({
			kind: 'command',
			command: 'rm -rf /',
			cwd: null,
			argv: null,
		});
		expect(opencodePermissionEffect(permission('edit', ['/p/b.ts', '/p/a.ts']))).toEqual({
			kind: 'file-change',
			paths: ['/p/a.ts', '/p/b.ts'],
			cwd: null,
		});
		expect(
			opencodePermissionEffect(permission('webfetch', 'https://x', { url: 'https://x' }))
		).toEqual({ kind: 'tool-call', tool: 'webfetch', input: { url: 'https://x' } });
	});
});
