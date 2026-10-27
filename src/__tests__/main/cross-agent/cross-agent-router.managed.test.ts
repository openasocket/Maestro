/**
 * The desktop consult router under management (MRC2-02-03, MRC2-02-07).
 *
 * `startCrossAgentRequest()` is driven over the REAL router, consult service,
 * runner and group chat spawn helper against the real `ProcessManager`, whose
 * authority is the real lease authority and verifier behind `fakeSpawnPort`
 * (only the policy answer is a table) or the desktop's own
 * `createProcessSpawnAuthority`; the manager's `spawn` is spied at the very
 * end so the config the sink was handed is what these tests read. Each guard
 * here has a test that fails when the guard is removed:
 *
 * - initiator scope: the consult is a CHILD of the asking operation, derived
 *   as the sink derives a dispatched turn, so the record the process carries
 *   and the record the authority was asked to decide are one; a managed
 *   initiator's child on a standalone desktop is refused before a listener
 *   attaches, and a managed desktop admits it under its own generation;
 * - access: a consult never widens what its initiator may do (a consulted
 *   agent asking a third stays read-only whatever the write switch says);
 * - an unresolvable web actor (a paired device before the enrollment
 *   registers an actor) is refused `unauthenticated` at the sink: the asker
 *   reads the decision, nothing runs, every listener is removed;
 * - an unqualified route (SSH, a provider with no governed child-process
 *   route) is refused unasked at the authority;
 * - a standalone host and a bare manager run the consult as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/maestro-system-prompt', () => ({
	buildMaestroSystemPromptForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../main/agents/resolveClaudeSpawnMode', () => ({
	resolveClaudeSpawnMode: vi.fn(() => ({ mode: 'api', reason: 'auto' })),
}));
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(async () => undefined),
}));

import {
	cancelCrossAgentRequestsForSource,
	consultLineage,
	consultRefusal,
	resolveConsultInitiator,
	startCrossAgentRequest,
	type ConsultInitiator,
	type CrossAgentTargetSession,
	type StartCrossAgentRequestOptions,
} from '../../../main/cross-agent/cross-agent-router';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import { ProcessManager } from '../../../main/process-manager/ProcessManager';
import type { ProcessConfig, ProcessSpawnAuthorityPort } from '../../../main/process-manager/types';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../../shared/crossAgentTypes';
import {
	childDelegationContext,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../../shared/maestro-lib/managed/delegation';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

const AGENT = {
	id: 'claude-code',
	name: 'Claude Code',
	command: 'claude',
	path: 'claude',
	args: [],
	available: true,
	fullAccessArgs: ['--dangerously-skip-permissions'],
	readOnlyArgs: ['--permission-mode', 'plan'],
	readOnlyCliEnforced: true,
	capabilities: { supportsBatchMode: true },
};
const INSTALLATION = { installationId: 'inst-1', runtimeId: 'desktop-1', processEpoch: 'e1' };
const UNREGISTERED: IdentityRead = { status: 'ok', record: {} as never, epoch: 1 };
const REGISTERED: IdentityRead = {
	status: 'ok',
	record: { registration: { actorId: 'actor-registered' } } as never,
	epoch: 1,
};

/** The config the sink was handed: the group chat spawn's write switch rides it as `readOnlyMode`. */
type SpawnedConfig = ProcessConfig & { readOnlyMode?: boolean };

const target = (overrides: Partial<CrossAgentTargetSession> = {}): CrossAgentTargetSession => ({
	id: 'tgt',
	name: 'Target',
	toolType: 'claude-code',
	cwd: '/proj',
	...overrides,
});

const request = (overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest => ({
	requestId: 'r1',
	sourceSessionId: 'src',
	sourceTabId: 'tab',
	targetSessionId: 'tgt',
	userPrompt: 'What is your take?',
	transcript: [],
	strategy: { kind: 'full' },
	createdAt: 0,
	...overrides,
});

/** The record of a run admitted elsewhere under policy revision 7 (a Cue pipeline). */
const managedInitiator = (): ManagedDelegationContext => ({
	contractVersion: MANAGED_CONTRACT_VERSION,
	identity: {
		requestId: 'cue-run-1',
		idempotencyKey: 'cue-run-1',
		attemptId: 'cue-run-1',
		runId: 'cue-run-1',
		rootRunId: 'cue-run-1',
		parentRunId: null,
	},
	traceId: 'cue-run-1',
	workflow: null,
	delegation: { chain: [{ kind: 'service', id: 'cue:pipeline' }], grantRef: null },
	policyRevision: 7,
});

/** The stamped record a spawned consult carries, read back off its environment. */
function stampedOn(config: ProcessConfig): ManagedDelegationContext {
	const stamped = readDelegationContextEnv(config.customEnvVars ?? {});
	if (stamped.status !== 'ok') throw new Error(`expected a record, got ${stamped.status}`);
	return stamped.context;
}

type DispatchOptions = Partial<
	Pick<StartCrossAgentRequestOptions, 'writable' | 'actor' | 'initiator'>
> & { target?: Partial<CrossAgentTargetSession> | null };

/**
 * The real manager over the port given (none: a bare manager with no
 * authority), `spawn` replaced at the very end so no process starts and the
 * config the sink was handed can be read back.
 */
function harness(port: ProcessSpawnAuthorityPort | null) {
	const manager = new ProcessManager(() => false, {
		...(port ? { spawnAuthority: () => port } : {}),
		isCoworkingEnabled: () => false,
	});
	const spawned: SpawnedConfig[] = [];
	vi.spyOn(manager, 'spawn').mockImplementation((async (config: SpawnedConfig) => {
		spawned.push(config);
		return { pid: 4242, success: true };
	}) as never);
	const chunks: CrossAgentResponseChunk[] = [];
	const listeners = () => manager.listenerCount('data') + manager.listenerCount('exit');
	const dispatch = (overrides: Partial<CrossAgentRequest> = {}, opts: DispatchOptions = {}) =>
		startCrossAgentRequest(request(overrides), {
			processManager: manager,
			agentDetector: { getAgent: async () => AGENT } as never,
			sshStore: null,
			getTargetSession: () => (opts.target === null ? null : target(opts.target)),
			writable: opts.writable,
			actor: opts.actor,
			initiator: opts.initiator,
			onChunk: (c) => chunks.push(c),
		});
	return { manager, spawned, chunks, listeners, dispatch };
}

/** The desktop's own spawn authority over an enrollment read, its decisions in `table`. */
function realAuthority(read: IdentityRead) {
	const table = fakeSpawnPort();
	const port = createProcessSpawnAuthority({
		installation: INSTALLATION,
		identity: { read: () => read },
		host: { policy: () => ({ sources: [], policyRevision: 1 }) },
		dispatch: { authority: table.authority },
		now: () => 1_000_000,
	});
	return { port, table };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(() => {
	cancelCrossAgentRequestsForSource('src');
	cancelCrossAgentRequestsForSource('tgt');
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('consult lineage: the asking operation and its child', () => {
	it('derives the fallback initiator as a lineage of the ask with the asking agent as the chain, unmanaged', () => {
		const initiator = resolveConsultInitiator(request());
		expect(initiator.writable).toBeNull();
		expect(initiator.delegation.policyRevision).toBeNull();
		expect(initiator.delegation.delegation.chain).toEqual([{ kind: 'agent', id: 'src' }]);
		expect(initiator.delegation.identity.requestId).toBe('ask:src:r1');
		// A `maestro-cli ask` that named no asking agent has an empty chain.
		const unattributed = resolveConsultInitiator(request({ sourceSessionId: 'cli-ask' }));
		expect(unattributed.delegation.delegation.chain).toEqual([]);
	});

	it('derives the child as the sink derives a dispatched turn: the chain one link deeper, this request as its run', () => {
		const initiator = { delegation: managedInitiator(), writable: false };
		const { dispatchedBy, child } = consultLineage(request(), initiator);
		expect(dispatchedBy).toEqual({
			delegation: managedInitiator(),
			dispatchedAs: { requestId: 'r1', attemptId: 'r1' },
		});
		expect(child).toEqual(
			childDelegationContext(managedInitiator(), {
				link: { kind: 'agent', id: 'cross-agent-r1' },
				requestId: 'r1',
				attemptId: 'r1',
			})
		);
		expect(child.identity.parentRunId).toBe('cue-run-1');
		expect(child.policyRevision).toBe(7);
	});

	it('on a managed desktop binds the consult as the initiator child, stamps the same record, and the authority decides on that chain', async () => {
		const port = fakeSpawnPort();
		const { spawned, chunks, dispatch } = harness(port);
		await dispatch();
		expect(chunks).toEqual([]);
		expect(spawned).toHaveLength(1);
		const config = spawned[0];
		expect(config.dispatchedAs).toEqual({ requestId: 'r1', attemptId: 'r1' });
		expect(config.delegation?.delegation.chain).toEqual([{ kind: 'agent', id: 'src' }]);
		const stamped = stampedOn(config);
		expect(stamped.delegation.chain).toEqual([
			{ kind: 'agent', id: 'src' },
			{ kind: 'agent', id: 'cross-agent-r1' },
		]);
		expect(stamped.identity.requestId).toBe('r1');
		expect(stamped.identity.parentRunId).toBe('ask:src:r1');
		// The admission on the config is the lease the real authority holds live for this request.
		expect(config.admission?.requestId).toBe('r1');
		const live = port.authority.live();
		expect(live).toHaveLength(1);
		expect(config.admission?.leaseId).toBe(live[0].leaseId);
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].context.delegation.chain).toEqual(stamped.delegation.chain);
		expect(port.asked[0].context.identity.requestId).toBe('r1');
		expect(port.asked[0].snapshot).toMatchObject({ provider: 'claude-code', origin: 'desktop' });
	});
});

describe('initiator scope: the asking run meets the standing of this host', () => {
	it('a managed initiator child on a standalone desktop is refused before anything attaches, naming the revision, and never run unmanaged', async () => {
		const { manager, spawned, chunks, listeners, dispatch } = harness(
			fakeSpawnPort({ standing: 'standalone' })
		);
		const before = listeners();
		await dispatch({}, { initiator: { delegation: managedInitiator(), writable: null } });
		expect(spawned).toHaveLength(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toMatch(/^\[managed-unavailable\] /);
		expect(chunks[0].error).toContain('policy revision 7');
		expect(listeners()).toBe(before);
		expect(manager.listenerCount('session-id')).toBe(0);
	});

	it('a managed desktop admits the same child under its own generation and says so', async () => {
		const port = fakeSpawnPort();
		const { spawned, chunks, dispatch } = harness(port);
		await dispatch({}, { initiator: { delegation: managedInitiator(), writable: null } });
		expect(chunks).toEqual([]);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].admission?.policyRevision).toBe(1);
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('cue-run-1');
		expect(port.asked[0].context.delegation.chain).toEqual([
			{ kind: 'service', id: 'cue:pipeline' },
			{ kind: 'agent', id: 'cross-agent-r1' },
		]);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining(
				'admitted under policy revision 7; this host admits the consult under 1'
			),
			expect.anything()
		);
	});

	it('answers the scope and route table directly', () => {
		const port = fakeSpawnPort({ standing: 'managed' });
		const plain: Pick<ManagedDelegationContext, 'policyRevision' | 'identity'> = {
			policyRevision: null,
			identity: { requestId: 'x' } as never,
		};
		expect(consultRefusal(port, plain, target())).toBeNull();
		expect(consultRefusal(null, managedInitiator(), target())?.code).toBe('runtime-unavailable');
		expect(consultRefusal(null, plain, null)).toBeNull();
		expect(consultRefusal(port, plain, null)).toBeNull();
	});
});

describe('access: a consult never widens what its initiator may do', () => {
	it('a consulted agent asking a third is that consult child: the chain deepens and read-only holds against the write switch', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		await dispatch({ requestId: 'r1', sourceSessionId: 'src', targetSessionId: 'tgt' });
		// The target (tgt) now asks a third agent, with the write switch on.
		await dispatch(
			{ requestId: 'r2', sourceSessionId: 'tgt', targetSessionId: 'third' },
			{ writable: true, target: { id: 'third', name: 'Third' } }
		);
		expect(spawned).toHaveLength(2);
		const second = spawned[1];
		expect(stampedOn(second).delegation.chain).toEqual([
			{ kind: 'agent', id: 'src' },
			{ kind: 'agent', id: 'cross-agent-r1' },
			{ kind: 'agent', id: 'cross-agent-r2' },
		]);
		expect(stampedOn(second).identity.parentRunId).toBe('r1');
		expect(stampedOn(second).identity.rootRunId).toBe('ask:src:r1');
		expect(second.readOnlyMode).toBe(true);
		expect(second.args).toContain('--permission-mode');
		expect(second.args).not.toContain('--dangerously-skip-permissions');
	});

	it('a named read-only initiator keeps its consult read-only against the write switch', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		const initiator: ConsultInitiator = { delegation: managedInitiator(), writable: false };
		await dispatch({}, { writable: true, initiator });
		expect(spawned).toHaveLength(1);
		expect(spawned[0].readOnlyMode).toBe(true);
		expect(spawned[0].args).not.toContain('--dangerously-skip-permissions');
	});

	it('a writable consult stays writable when nothing narrows it', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		await dispatch({}, { writable: true });
		expect(spawned[0].readOnlyMode).toBe(false);
		expect(spawned[0].args).toContain('--dangerously-skip-permissions');
	});
});

describe('a web actor the host cannot resolve is refused at the sink', () => {
	it('a device-asked consult before the enrollment registers an actor is refused unauthenticated: the asker reads why, nothing runs, every listener is removed', async () => {
		const { port, table } = realAuthority(UNREGISTERED);
		const { manager, spawned, chunks, listeners, dispatch } = harness(port);
		const before = listeners();
		await dispatch({}, { actor: { peer: 'device-pairing', deviceId: 'dev-7' } });
		expect(spawned).toHaveLength(0);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].done).toBe(true);
		expect(chunks[0].error).toMatch(/Target could not be started\./);
		expect(chunks[0].error).toContain('paired Lite device (dev-7) admits its transport only');
		// Refused at the verifier: the policy was never asked and no lease exists.
		expect(table.asked).toHaveLength(0);
		expect(table.authority.live()).toHaveLength(0);
		expect(listeners()).toBe(before);
		expect(manager.listenerCount('session-id')).toBe(0);
	});

	it('the same device-asked consult is admitted once an actor is registered, under the device verifier and the asking chain', async () => {
		const { port, table } = realAuthority(REGISTERED);
		const { spawned, chunks, dispatch } = harness(port);
		await dispatch({}, { actor: { peer: 'device-pairing', deviceId: 'dev-7' } });
		expect(chunks).toEqual([]);
		expect(spawned).toHaveLength(1);
		expect(table.asked).toHaveLength(1);
		expect(table.asked[0].context.verification.peer).toBe('device-pairing');
		expect(table.asked[0].context.actor).toEqual({ kind: 'human', id: 'actor-registered' });
		// A dispatched turn is bound on its initiator's chain as it is.
		expect(table.asked[0].context.delegation.chain).toEqual([
			{ kind: 'agent', id: 'src' },
			{ kind: 'agent', id: 'cross-agent-r1' },
		]);
		expect(spawned[0].admission?.leaseId).toBe(table.authority.live()[0].leaseId);
	});
});

describe('route: only a route this build governs', () => {
	it('refuses an SSH target under management, unasked at the authority, with nothing attached', async () => {
		const port = fakeSpawnPort();
		const { spawned, chunks, listeners, dispatch } = harness(port);
		const before = listeners();
		await dispatch({}, { target: { sshRemoteConfig: { enabled: true, remoteId: 'r1' } } });
		expect(spawned).toHaveLength(0);
		expect(port.asked).toHaveLength(0);
		expect(chunks[0].error).toMatch(/^\[managed-unavailable\] .*ssh route/);
		expect(listeners()).toBe(before);
	});

	it('refuses a provider with no governed child-process route under management', async () => {
		const port = fakeSpawnPort();
		const { spawned, chunks, dispatch } = harness(port);
		await dispatch({}, { target: { toolType: 'terminal' as never } });
		expect(spawned).toHaveLength(0);
		expect(port.asked).toHaveLength(0);
		expect(chunks[0].error).toMatch(/^\[managed-unavailable\] .*child-process route/);
	});
});

describe('standalone: unchanged', () => {
	it('a bare process manager spawns the consult as before, still carrying the lineage and no admission', async () => {
		const { spawned, chunks, dispatch } = harness(null);
		await dispatch();
		expect(chunks).toEqual([]);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].admission).toBeUndefined();
		expect(spawned[0].dispatchedAs).toEqual({ requestId: 'r1', attemptId: 'r1' });
		expect(spawned[0].readOnlyMode).toBe(true);
	});

	it('a standalone port spawns without an admission and never asks the authority', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const { spawned, dispatch } = harness(port);
		await dispatch();
		expect(spawned).toHaveLength(1);
		expect(spawned[0].admission).toBeUndefined();
		expect(port.asked).toHaveLength(0);
	});
});
