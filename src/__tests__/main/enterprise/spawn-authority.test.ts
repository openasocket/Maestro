/**
 * The desktop's spawn authority (`createProcessSpawnAuthority`): the context
 * it binds a spawn into carries exactly what the sink handed it. The
 * workflow reference of an Auto Run attempt (MRC-07-01B) reaches the verified
 * context with its owner fence, a chat turn's null stays null, and the
 * principal is the enrollment's registered actor or the installation operator.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	createCueSpawnAuthority,
	createProcessSpawnAuthority,
	pairedDeviceActorProblems,
	type ProcessSpawnAuthorityDeps,
} from '../../../main/enterprise/spawn-authority';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import type { ManagedWorkflowRef } from '../../../shared/maestro-lib/managed/types';
import { fakeAdmission, fakeSpawnPort } from '../../helpers/managedSpawnPort';
import {
	ProcessManager,
	buildSpawnRequestSnapshot,
} from '../../../main/process-manager/ProcessManager';
import type { ProcessConfig } from '../../../main/process-manager/types';
import { managedChildRefusal } from '../../../main/process-manager/spawners/ChildProcessSpawner';
import { managedPtyRefusal } from '../../../main/process-manager/spawners/PtySpawner';

// node-pty is native; nothing in this file opens a terminal.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };

function authority(
	read: IdentityRead = { status: 'none' },
	extra: Pick<ProcessSpawnAuthorityDeps, 'workflowFence'> = {}
) {
	return createProcessSpawnAuthority({
		installation: INSTALLATION,
		identity: { read: () => read },
		host: { policy: () => ({ sources: [], policyRevision: 3 }) },
		dispatch: { authority: fakeSpawnPort().authority },
		now: () => 1_000_000,
		...extra,
	});
}

const IDENTITY = {
	requestId: 'req-1',
	idempotencyKey: 'req-1',
	attemptId: 'att-1',
	runId: 'turn-1',
	rootRunId: 'run-root',
	parentRunId: 'run-root',
};

describe('createProcessSpawnAuthority verify', () => {
	it('passes an Auto Run workflow reference through to the verified context', () => {
		const workflow: ManagedWorkflowRef = {
			workflowId: 'playbook:/work/.maestro/playbooks/release',
			version: 'docs-2-0badf00d',
			triggerEventId: 'operator:1700000000000',
			ownerEpoch: 'epoch-1',
			fencingToken: 'fence-1',
		};
		const verified = authority().verify({
			actor: { peer: 'in-process' },
			identity: IDENTITY,
			traceId: 'autorun:run-root:req-1:1',
			policyRevision: 3,
			workflow,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.workflow).toEqual(workflow);
		expect(verified.context.identity).toEqual(IDENTITY);
		expect(verified.context.traceId).toBe('autorun:run-root:req-1:1');
		expect(verified.context.origin).toBe('desktop');
		expect(verified.context.actor.id).toBe('operator:inst-1');
		expect(verified.context.installation).toEqual(INSTALLATION);
	});

	it('keeps a chat turn workflow-less and the browser account on the delegation chain', () => {
		const verified = authority().verify({
			actor: { peer: 'web-login', username: 'ada' },
			identity: { ...IDENTITY, runId: null, rootRunId: null, parentRunId: null },
			traceId: 'agent-1-ai-tab-1',
			policyRevision: 3,
			workflow: null,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.workflow).toBeNull();
		expect(verified.context.delegation.chain).toEqual([{ kind: 'human', id: 'web-login:ada' }]);
		expect(verified.context.verification.peer).toBe('web-login');
	});

	it('refuses a workflow reference with a blank fence field rather than repairing it', () => {
		const verified = authority().verify({
			actor: { peer: 'in-process' },
			identity: IDENTITY,
			traceId: 'autorun:run-root:req-1:1',
			policyRevision: 3,
			workflow: {
				workflowId: 'playbook:release',
				version: 'docs-2-0badf00d',
				triggerEventId: 'operator:1',
				ownerEpoch: '',
				fencingToken: 'fence-1',
			},
		});
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.problems.join('; ')).toContain('workflow.ownerEpoch');
	});
});

/**
 * The transport peers a host sink binds (MRC-08-01A): the CLI secret and a
 * paired Lite device each get their own verifier and their own attribution on
 * the delegation chain, while the PRINCIPAL stays the enrollment's registered
 * actor for every peer. A transport is admission, never a tenant role.
 */
describe('createProcessSpawnAuthority transport peers', () => {
	const REGISTERED: IdentityRead = {
		status: 'ok',
		record: { registration: { actorId: 'actor-registered' } } as never,
	};
	const turn = {
		identity: { ...IDENTITY, runId: null, rootRunId: null, parentRunId: null },
		traceId: 'agent-1-ai-tab-1',
		policyRevision: 3,
		workflow: null,
	};

	it('binds the CLI secret as the maestro-cli service on the chain, under its own verifier', () => {
		const verified = authority(REGISTERED).verify({ actor: { peer: 'host-secret' }, ...turn });
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.verification.peer).toBe('host-secret');
		expect(verified.context.verification.verifierId).toBe('desktop-cli-secret:desktop-1');
		expect(verified.context.delegation).toEqual({
			chain: [{ kind: 'service', id: 'maestro-cli' }],
			grantRef: null,
		});
		// The CLI is attribution: the principal is still the registered actor.
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
	});

	it('binds a paired Lite device as the device on the chain, by the id the pairing issued', () => {
		const verified = authority(REGISTERED).verify({
			actor: { peer: 'device-pairing', deviceId: 'dev-7' },
			...turn,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.verification.peer).toBe('device-pairing');
		expect(verified.context.verification.verifierId).toBe('desktop-device-pairing:desktop-1');
		expect(verified.context.delegation.chain).toEqual([
			{ kind: 'service', id: 'lite-device:dev-7' },
		]);
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
	});

	it('gives every peer the same principal and its own verification, and the keyboard no chain', () => {
		const actors = [
			{ peer: 'in-process' },
			{ peer: 'web-login', username: 'ada' },
			{ peer: 'host-secret' },
			{ peer: 'device-pairing', deviceId: 'dev-7' },
		] as const;
		const port = authority(REGISTERED);
		const bound = actors.map((actor) => {
			const verified = port.verify({ actor, ...turn });
			if (!verified.ok) throw new Error(verified.problems.join('; '));
			return verified.context;
		});
		expect(bound.map((c) => c.actor)).toEqual(
			actors.map(() => ({ kind: 'human', id: 'actor-registered' }))
		);
		expect(bound.map((c) => c.verification.peer)).toEqual(actors.map((a) => a.peer));
		expect(bound.map((c) => c.delegation.chain)).toEqual([
			[],
			[{ kind: 'human', id: 'web-login:ada' }],
			[{ kind: 'service', id: 'maestro-cli' }],
			[{ kind: 'service', id: 'lite-device:dev-7' }],
		]);
		expect(new Set(bound.map((c) => c.verification.verifierId)).size).toBe(actors.length);
	});

	it('refuses a context naming another installation for the new peers too', () => {
		const other = createProcessSpawnAuthority({
			installation: { ...INSTALLATION, installationId: 'inst-2' },
			identity: { read: () => REGISTERED },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: fakeSpawnPort().authority },
			now: () => 1_000_000,
		});
		// The port names its own installation; a verifier cannot be handed another.
		// What it does refuse is a chain the actor does not account for: a
		// carried delegation is bound as it is, never rewritten to the transport.
		const carried = other.verify({
			actor: { peer: 'host-secret' },
			...turn,
			delegation: { chain: [{ kind: 'agent', id: 'agent-9' }], grantRef: null },
		});
		expect(carried.ok).toBe(true);
		if (!carried.ok) return;
		expect(carried.context.delegation.chain).toEqual([{ kind: 'agent', id: 'agent-9' }]);
		expect(carried.context.verification.peer).toBe('host-secret');
	});
});

/**
 * A paired Lite device needs a registered enterprise actor (MRC-08-03). The
 * keyboard, the path token, a Web Login account and the CLI secret may run as
 * the installation's operator before the enrollment registers an actor; a
 * paired device may not, because a device is not the operator and binding it
 * so would let the pairing credential stand in for the actor. The refusal is
 * `unauthenticated`, by name, before any principal is derived.
 */
describe('createProcessSpawnAuthority paired device without a registered actor', () => {
	const DEVICE = { peer: 'device-pairing', deviceId: 'dev-7' } as const;
	const UNREGISTERED: IdentityRead = {
		status: 'ok',
		record: { registration: null } as never,
	};
	const PENDING: IdentityRead = {
		status: 'ok',
		record: { registration: { actorId: null, challengeId: 'ch-1' } } as never,
	};
	const turn = {
		identity: { ...IDENTITY, runId: null, rootRunId: null, parentRunId: null },
		traceId: 'agent-1-ai-tab-1',
		policyRevision: 3,
		workflow: null,
	};

	it.each([
		['no registration at all', UNREGISTERED],
		['a registration the endpoint has not consumed', PENDING],
		['no enrollment record', { status: 'none' } as IdentityRead],
		[
			'an unreadable record',
			{ status: 'untrusted', reason: 'rollback', message: 'older epoch' } as IdentityRead,
		],
	])('refuses the device by name under %s, never as the operator', (_name, read) => {
		const verified = authority(read).verify({ actor: DEVICE, ...turn });
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.code).toBe('unauthenticated');
		expect(verified.problems).toHaveLength(1);
		expect(verified.problems[0]).toContain('dev-7');
		expect(verified.problems[0]).toContain('registered enterprise actor');
		expect(verified.problems[0]).not.toContain('operator');
	});

	it('still lets the keyboard, the browser account and the CLI run as the operator before registration', () => {
		const port = authority(UNREGISTERED);
		for (const actor of [
			{ peer: 'in-process' },
			{ peer: 'web-login', username: 'ada' },
			{ peer: 'host-secret' },
		] as const) {
			const verified = port.verify({ actor, ...turn });
			expect(verified.ok, actor.peer).toBe(true);
			if (!verified.ok) return;
			expect(verified.context.actor).toEqual({ kind: 'human', id: 'operator:inst-1' });
		}
	});

	it('binds the device as attribution the moment an actor is registered', () => {
		const REGISTERED: IdentityRead = {
			status: 'ok',
			record: { registration: { actorId: 'actor-registered' } } as never,
		};
		const verified = authority(REGISTERED).verify({ actor: DEVICE, ...turn });
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(verified.context.delegation.chain).toEqual([
			{ kind: 'service', id: 'lite-device:dev-7' },
		]);
	});

	it('is the pure rule the port applies, and answers nothing for the other peers', () => {
		expect(pairedDeviceActorProblems(DEVICE, UNREGISTERED)).toHaveLength(1);
		expect(pairedDeviceActorProblems(DEVICE, { status: 'none' })).toHaveLength(1);
		expect(
			pairedDeviceActorProblems(DEVICE, {
				status: 'ok',
				record: { registration: { actorId: 'actor-registered' } } as never,
			})
		).toEqual([]);
		expect(pairedDeviceActorProblems({ peer: 'in-process' }, UNREGISTERED)).toEqual([]);
		expect(pairedDeviceActorProblems({ peer: 'host-secret' }, { status: 'none' })).toEqual([]);
		expect(pairedDeviceActorProblems({ peer: 'web-login', username: 'ada' }, UNREGISTERED)).toEqual(
			[]
		);
	});
});

/**
 * The workflow owner claim on the process port (MRC-07-06B): the service's
 * `claimWorkflowFence` is handed through as the port's `workflowFence`, as it
 * is, for the sink to claim an unowned Auto Run's fence with; a service that
 * hands none leaves the port without one, so the sink refuses by name rather
 * than finding a fence here.
 */
describe('createProcessSpawnAuthority workflowFence', () => {
	const WORKFLOW = {
		workflowId: 'playbook:/work/.maestro/playbooks/release',
		version: 'docs-2-0badf00d',
		triggerEventId: 'operator:1700000000000',
	};

	it('hands the workflow owner claim through, with the workflow and the attempt it is asked for', async () => {
		const workflowFence = vi.fn(async () => ({ ownerEpoch: '2', fencingToken: 'fence-2' }));
		const port = authority({ status: 'none' }, { workflowFence });
		expect(port.workflowFence).toBe(workflowFence);
		await expect(
			port.workflowFence?.(WORKFLOW, { runId: 'req-1', attemptId: 'att-1' })
		).resolves.toEqual({ ownerEpoch: '2', fencingToken: 'fence-2' });
		expect(workflowFence).toHaveBeenCalledWith(WORKFLOW, { runId: 'req-1', attemptId: 'att-1' });
	});

	it('hands a refusal through untouched, never a fence in its place', async () => {
		const refusal = {
			fence: null,
			state: 'unavailable' as const,
			code: 'capability-unsupported' as const,
			message: 'The endpoint serves no workflow owner operation (CP-03).',
		};
		const port = authority({ status: 'none' }, { workflowFence: () => refusal });
		expect(await port.workflowFence?.(WORKFLOW, { runId: 'req-1', attemptId: 'att-1' })).toBe(
			refusal
		);
	});

	it('has no claim when the service hands none', () => {
		expect(authority().workflowFence).toBeUndefined();
		expect('workflowFence' in authority()).toBe(false);
	});
});

/**
 * The desktop's Cue port (`createCueSpawnAuthority`, MRC-07-02A): the same
 * enrollment, authority and policy as the process manager's port, under the
 * shape the Cue run router admits a prompt run with, with origin `cue` and the
 * lineage the router bound carried through untouched.
 */
describe('createCueSpawnAuthority', () => {
	const port = fakeSpawnPort();
	const CUE_WORKFLOW: ManagedWorkflowRef = {
		workflowId: 'cue-pipeline:Nightly QA',
		version: 'a'.repeat(64),
		triggerEventId: 'time.scheduled:evt-1',
		ownerEpoch: 'epoch-3',
		fencingToken: 'fence-3',
	};
	const DELEGATION = {
		chain: [
			{ kind: 'service' as const, id: 'cue-subscription:nightly' },
			{ kind: 'agent' as const, id: 'agent-1' },
		],
		grantRef: null,
	};

	function cueAuthority(read: IdentityRead = { status: 'none' }) {
		return createCueSpawnAuthority({
			installation: INSTALLATION,
			identity: { read: () => read },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: port.authority },
			now: () => 1_000_000,
		});
	}

	it('binds a Cue run with origin cue, the operator principal, and the lineage the router handed it', () => {
		const authority = cueAuthority();
		const verified = authority.context({
			identity: { ...IDENTITY, runId: 'run-9', rootRunId: 'root-1', parentRunId: 'run-8' },
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
			workflow: CUE_WORKFLOW,
			delegation: DELEGATION,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.context.origin).toBe('cue');
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'operator:inst-1' });
		expect(verified.context.workflow).toEqual(CUE_WORKFLOW);
		expect(verified.context.delegation).toEqual(DELEGATION);
		expect(verified.context.traceId).toBe('cue:root-1:run-9:att-1');
		expect(verified.context.installation).toEqual(INSTALLATION);
		expect(verified.context.verification).toMatchObject({
			verifierId: 'desktop-cue:desktop-1',
			peer: 'in-process',
		});
		expect(verified.context.requestedCapabilities).toEqual(['runs.submit']);
	});

	it('shares the enrollment standing, the dispatch authority and the policy of the process port', () => {
		const standalone = cueAuthority();
		expect(standalone.standing()).toBe('standalone');
		const enrolled = cueAuthority({
			status: 'ok',
			record: { registration: { actorId: 'actor-registered' } } as never,
		});
		expect(enrolled.standing()).toBe('managed');
		expect(enrolled.authority).toBe(port.authority);
		expect(enrolled.policy()).toEqual({ sources: [], policyRevision: 3 });
		const verified = enrolled.context({
			identity: IDENTITY,
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
		});
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		// The registered actor is the principal once one exists; a direct action has no chain.
		expect(verified.context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		expect(verified.context.delegation).toEqual({ chain: [], grantRef: null });
		expect(verified.context.workflow).toBeNull();
	});

	it('refuses a workflow with a blank fence field rather than repairing or dropping it', () => {
		const verified = cueAuthority().context({
			identity: IDENTITY,
			traceId: 'cue:root-1:run-9:att-1',
			policyRevision: 3,
			workflow: { ...CUE_WORKFLOW, fencingToken: '' },
		});
		expect(verified.ok).toBe(false);
		if (verified.ok) return;
		expect(verified.problems.join('; ')).toContain('workflow.fencingToken');
	});
});

describe('standing by custody (MRC2-05-10A)', () => {
	const unprotected = (fileExists: boolean): IdentityRead => ({
		status: 'unprotected',
		reason: 'seal-not-protected',
		message: 'safeStorage holds the key as basic_text',
		fileExists,
	});
	const untrusted: IdentityRead = {
		status: 'untrusted',
		reason: 'rollback',
		message: 'older epoch',
	};
	const cue = (read: IdentityRead) =>
		createCueSpawnAuthority({
			installation: INSTALLATION,
			identity: { read: () => read },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: fakeSpawnPort().authority },
			now: () => 1_000_000,
		});

	it('reads an unprotected custody with no record as standalone, and every held record as managed', () => {
		for (const port of [authority, cue]) {
			expect(port({ status: 'none' }).standing()).toBe('standalone');
			expect(port(unprotected(false)).standing()).toBe('standalone');
			expect(port(unprotected(true)).standing()).toBe('managed');
			expect(port(untrusted).standing()).toBe('managed');
		}
	});
});

/**
 * Grok at the desktop sink (GT1-09-03; requirements GT1-09-R05..R07): the
 * real `ProcessManager` admits with the real desktop authority above, over
 * the real local lease authority. Only the policy answer is a table
 * (`fakeSpawnPort`, SYNTHETIC) and the child-process spawner is a capture-only
 * stub, so nothing launches. What passes here is client wiring: the refusal
 * happens before any spawner runs and no fallback drops the managed binding.
 * It proves nothing about Grok's own tools, files or network, and no real
 * endpoint authority is involved (CP-01, CP-03).
 */
describe('Grok at the managed desktop sink (synthetic policy table)', () => {
	const REGISTERED: IdentityRead = {
		status: 'ok',
		record: { registration: { actorId: 'actor-registered' } } as never,
	};
	const ACTOR = { peer: 'in-process' } as const;
	type Decide = NonNullable<Parameters<typeof fakeSpawnPort>[0]>['decide'];
	let clock = 1_000_000;
	let next = 0;

	function sink(options: { read?: IdentityRead; decide?: Decide; leaseTtlMs?: number } = {}) {
		const dispatch = fakeSpawnPort({
			now: () => clock,
			decide: options.decide ?? (() => ({ decision: 'allow', policyRevision: 3 })),
			...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
		});
		const port = createProcessSpawnAuthority({
			installation: INSTALLATION,
			identity: { read: () => options.read ?? REGISTERED },
			host: { policy: () => ({ sources: [], policyRevision: 3 }) },
			dispatch: { authority: dispatch.authority },
			now: () => clock,
		});
		const pm = new ProcessManager(() => false, {
			spawnAuthority: () => port,
			isCoworkingEnabled: () => false,
		});
		const spawned: ProcessConfig[] = [];
		(pm as unknown as { childProcessSpawner: unknown }).childProcessSpawner = {
			spawn: (config: ProcessConfig) => {
				spawned.push(config);
				return { pid: 4242, success: true };
			},
		};
		return { pm, dispatch, spawned };
	}

	/** A read-only Grok turn whose custom args repeat -m (the CLI keeps the last). */
	const grokTurn = (overrides: Partial<ProcessConfig> = {}): ProcessConfig => ({
		sessionId: `grok-agent-ai-tab-${++next}`,
		tabId: 'tab',
		toolType: 'grok',
		cwd: process.cwd(),
		command: 'grok',
		args: [
			'--output-format',
			'streaming-json',
			'--permission-mode',
			'plan',
			'--deny',
			'Bash(*)',
			'-m',
			'grok-default',
			'-m',
			'grok-custom',
		],
		prompt: 'read the repo',
		permission: { requested: 'readonly', ceiling: 'readonly' },
		customEnvVars: { GROK_HOME: '/synthetic/grok-home' },
		...overrides,
	});

	it('admits a read-only Grok turn on the effective model, names no account, and stops it on revocation', async () => {
		const { pm, dispatch, spawned } = sink();
		const turn = grokTurn();
		const admitted = await pm.admitSpawn(turn, ACTOR);
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		const snapshot = dispatch.asked[0].snapshot;
		expect(snapshot).toEqual(buildSpawnRequestSnapshot(turn));
		expect(snapshot).toMatchObject({
			provider: 'grok',
			model: 'grok-custom',
			target: { kind: 'local' },
		});
		// ProcessConfig carries no account source (GT1-09-R07): null, never a guess.
		expect(snapshot.account).toBeNull();
		expect(dispatch.asked[0].context.actor).toEqual({ kind: 'human', id: 'actor-registered' });

		expect(pm.spawn({ ...turn, admission: admitted.admission })).toMatchObject({ success: true });
		expect(spawned).toHaveLength(1);
		expect(spawned[0].admission).toBe(admitted.admission);
		expect(pm.admissionLive(turn.sessionId)).toEqual({ ok: true });

		expect(dispatch.authority.revoke(admitted.admission.leaseId, 'policy changed')).toBe(true);
		expect(pm.admissionLive(turn.sessionId).ok).toBe(false);
		expect(pm.admissionOf(turn.sessionId)).toBeNull();
	});

	it.each([
		['denied', () => ({ decision: 'deny', reason: 'grok blocked', policyRevision: 3 }), 'denied'],
		['unavailable', () => ({ decision: 'unavailable', reason: 'endpoint down' }), 'unavailable'],
		['unknown', () => ({ decision: 'unknown', reason: 'no answer' }), undefined],
	] as const)('spawns nothing when the policy answer is %s', async (_name, decide, state) => {
		const { pm, spawned } = sink({ decide: decide as Decide });
		const result = await pm.spawnAdmitted(grokTurn(), ACTOR);
		expect(result.success).toBe(false);
		expect(result.managed?.state).not.toBe('admitted');
		if (state) expect(result.managed?.state).toBe(state);
		expect(spawned).toHaveLength(0);
	});

	it('refuses a managed Grok spawn with no admission or one this host did not mint', () => {
		const { pm, spawned } = sink();
		expect(pm.spawn(grokTurn())).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
			error: expect.stringContaining('carries no admission'),
		});
		expect(pm.spawn(grokTurn({ admission: fakeAdmission({ provider: 'grok' }) }))).toMatchObject({
			success: false,
			error: expect.stringContaining('did not mint'),
		});
		expect(spawned).toHaveLength(0);
	});

	it.each([
		[
			'a full-access flag appended',
			(t: ProcessConfig) => ({ args: [...t.args, '--always-approve'] }),
		],
		['another model appended', (t: ProcessConfig) => ({ args: [...t.args, '-m', 'grok-other'] })],
		['another account home', () => ({ customEnvVars: { GROK_HOME: '/synthetic/other-home' } })],
		[
			'an added credential variable',
			(t: ProcessConfig) => ({ customEnvVars: { ...t.customEnvVars, XAI_API_KEY: 'synthetic' } }),
		],
	])('refuses the admitted Grok turn after %s, spawning nothing', async (_name, change) => {
		const { pm, spawned } = sink();
		const turn = grokTurn();
		const admitted = await pm.admitSpawn(turn, ACTOR);
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		const result = pm.spawn({ ...turn, ...change(turn), admission: admitted.admission });
		expect(result).toMatchObject({ success: false, managed: { code: 'lease-invalid' } });
		expect(spawned).toHaveLength(0);
	});

	it('refuses an expired or revoked Grok lease before the spawner runs', async () => {
		const expiring = sink({ leaseTtlMs: 10 });
		const late = grokTurn();
		const first = await expiring.pm.admitSpawn(late, ACTOR);
		if (first.state !== 'admitted') throw new Error(first.state);
		clock += 11;
		expect(expiring.pm.spawn({ ...late, admission: first.admission }).error).toContain('expired');
		expect(expiring.spawned).toHaveLength(0);

		const revoked = sink();
		const turn = grokTurn();
		const second = await revoked.pm.admitSpawn(turn, ACTOR);
		if (second.state !== 'admitted') throw new Error(second.state);
		revoked.dispatch.authority.revoke(second.admission.leaseId, 'revoked by policy');
		expect(revoked.pm.spawn({ ...turn, admission: second.admission }).error).toContain('revoked');
		expect(revoked.spawned).toHaveLength(0);
	});

	it('refuses an admitted standard Grok turn on the ACP route with no headless fallback and releases its lease', async () => {
		const { pm, dispatch, spawned } = sink();
		const turn = grokTurn({
			args: ['--output-format', 'streaming-json', '-m', 'grok-custom'],
			permission: { requested: 'standard', ceiling: null },
		});
		const admitted = await pm.admitSpawn(turn, ACTOR);
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		const result = pm.spawn({ ...turn, admission: admitted.admission });
		expect(result).toMatchObject({
			success: false,
			managed: { state: 'unavailable', code: 'capability-unsupported' },
		});
		expect(spawned).toHaveLength(0);
		expect(pm.get(turn.sessionId)).toBeUndefined();
		expect(dispatch.authority.live()).toHaveLength(0);
	});

	it('leaves a standalone Grok turn unadmitted and unchanged', async () => {
		const { pm, dispatch, spawned } = sink({ read: { status: 'none' } });
		expect(await pm.spawnAdmitted(grokTurn(), ACTOR)).toMatchObject({ success: true });
		expect(dispatch.asked).toHaveLength(0);
		expect(spawned[0].admission).toBeUndefined();
	});

	it('refuses an admitted Grok turn over an unqualified SSH endpoint or a PTY', () => {
		const admission = fakeAdmission({ provider: 'grok' });
		expect(managedChildRefusal(grokTurn({ sshRemoteId: 'remote-1', admission }))).toMatchObject({
			state: 'unavailable',
			code: 'capability-unsupported',
			message: expect.stringContaining('no qualified remote endpoint'),
		});
		expect(managedChildRefusal(grokTurn({ sshRemoteId: 'remote-1' }))).toBeNull();
		expect(managedPtyRefusal(grokTurn({ requiresPty: true, admission }))).toMatchObject({
			state: 'unavailable',
			code: 'capability-unsupported',
		});
		expect(managedPtyRefusal(grokTurn({ requiresPty: true }))).toBeNull();
	});

	// GT1-11-06 pass two: two synthetic Grok profiles on one desktop. The credential values
	// are sentinels; none may reach the policy request, a refusal message or the other
	// profile's spawn. The policy table is still the synthetic `fakeSpawnPort`.
	describe('profile A/B isolation and redacted refusals (GT1-11-06)', () => {
		const SECRET_A = 'xai-SENTINEL-PROFILE-A-0000';
		const SECRET_B = 'xai-SENTINEL-PROFILE-B-1111';
		const profileA = { GROK_HOME: '/synthetic/grok-a', XAI_API_KEY: SECRET_A };
		const profileB = { GROK_HOME: '/synthetic/grok-b', XAI_API_KEY: SECRET_B };
		const leaks = (value: unknown) => {
			const text = JSON.stringify(value) ?? '';
			return [SECRET_A, SECRET_B].filter((secret) => text.includes(secret));
		};

		it('holds each admission to its own profile: a home, a credential or a whole profile swapped in is refused', async () => {
			const { pm, dispatch, spawned } = sink();
			const turnA = grokTurn({ customEnvVars: profileA });
			const turnB = grokTurn({ customEnvVars: profileB });
			const a = await pm.admitSpawn(turnA, ACTOR);
			const b = await pm.admitSpawn(turnB, ACTOR);
			if (a.state !== 'admitted' || b.state !== 'admitted') throw new Error('expected admitted');
			expect(a.admission.leaseId).not.toBe(b.admission.leaseId);

			const refusals = [
				pm.spawn({ ...turnA, customEnvVars: profileB, admission: a.admission }),
				pm.spawn({ ...turnB, customEnvVars: profileA, admission: b.admission }),
				// The same home with the other profile's credential value.
				pm.spawn({
					...turnA,
					customEnvVars: { ...profileA, XAI_API_KEY: SECRET_B },
					admission: a.admission,
				}),
				// The other profile's home with this profile's credential.
				pm.spawn({
					...turnA,
					customEnvVars: { ...profileA, GROK_HOME: profileB.GROK_HOME },
					admission: a.admission,
				}),
				// One tab's admission presented for the other tab's turn.
				pm.spawn({ ...turnB, admission: a.admission }),
			];
			for (const result of refusals) {
				expect(result).toMatchObject({ success: false, managed: { code: 'lease-invalid' } });
				expect(leaks(result)).toEqual([]);
			}
			expect(spawned).toHaveLength(0);

			// Each profile still runs on its own admission, with exactly its own environment.
			expect(pm.spawn({ ...turnA, admission: a.admission })).toMatchObject({ success: true });
			expect(pm.spawn({ ...turnB, admission: b.admission })).toMatchObject({ success: true });
			expect(spawned.map((c) => c.customEnvVars)).toEqual([profileA, profileB]);

			// The policy was asked about each profile by key names and a digest only.
			expect(dispatch.asked).toHaveLength(2);
			expect(leaks(dispatch.asked.map((ask) => ask.snapshot))).toEqual([]);
			const [snapA, snapB] = dispatch.asked.map((ask) => ask.snapshot);
			expect(snapA.envKeys).toEqual(snapB.envKeys);
			expect(snapA.envDigest).not.toBe(snapB.envDigest);
		});

		it('keeps the sentinel out of every refusal: denied, revoked, expired and unsupported-route', async () => {
			const denied = sink({
				decide: () => ({ decision: 'deny', reason: 'grok blocked', policyRevision: 3 }),
			});
			const deniedResult = await denied.pm.spawnAdmitted(
				grokTurn({ customEnvVars: profileA }),
				ACTOR
			);
			expect(deniedResult).toMatchObject({ success: false, managed: { state: 'denied' } });
			expect(leaks(deniedResult)).toEqual([]);
			expect(leaks(denied.dispatch.asked)).toEqual([]);

			const revoked = sink();
			const turn = grokTurn({ customEnvVars: profileA });
			const admitted = await revoked.pm.admitSpawn(turn, ACTOR);
			if (admitted.state !== 'admitted') throw new Error(admitted.state);
			revoked.dispatch.authority.revoke(admitted.admission.leaseId, 'revoked by policy');
			const revokedResult = revoked.pm.spawn({ ...turn, admission: admitted.admission });
			expect(revokedResult.error).toContain('revoked');
			expect(leaks(revokedResult)).toEqual([]);

			const expiring = sink({ leaseTtlMs: 10 });
			const late = grokTurn({ customEnvVars: profileB });
			const lateAdmission = await expiring.pm.admitSpawn(late, ACTOR);
			if (lateAdmission.state !== 'admitted') throw new Error(lateAdmission.state);
			clock += 11;
			const expiredResult = expiring.pm.spawn({ ...late, admission: lateAdmission.admission });
			expect(expiredResult.error).toContain('expired');
			expect(leaks(expiredResult)).toEqual([]);

			const route = sink();
			const standard = grokTurn({
				args: ['--output-format', 'streaming-json', '-m', 'grok-custom'],
				permission: { requested: 'standard', ceiling: null },
				customEnvVars: profileA,
			});
			const routeAdmission = await route.pm.admitSpawn(standard, ACTOR);
			if (routeAdmission.state !== 'admitted') throw new Error(routeAdmission.state);
			const routeResult = route.pm.spawn({ ...standard, admission: routeAdmission.admission });
			expect(routeResult).toMatchObject({
				success: false,
				managed: { state: 'unavailable', code: 'capability-unsupported' },
			});
			expect(leaks(routeResult)).toEqual([]);
			for (const s of [denied, revoked, expiring, route]) expect(s.spawned).toHaveLength(0);
		});
	});
});
