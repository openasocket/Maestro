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
	bindCrossAgentConsultInitiator,
	cancelCrossAgentRequestsForSource,
	consultLineage,
	consultRefusal,
	getCrossAgentConsultParties,
	MAX_BOUND_CONSULT_INITIATORS,
	MAX_WITHDRAWN_CONSULT_TICKETS,
	resolveConsultInitiator,
	startCrossAgentRequest,
	withdrawCrossAgentConsult,
	type ConsultInitiator,
	type CrossAgentTargetSession,
	type StartCrossAgentRequestOptions,
} from '../../../main/cross-agent/cross-agent-router';
import { createProcessSpawnAuthority } from '../../../main/enterprise/spawn-authority';
import { DISPATCH_TICKET_TTL_MS } from '../../../main/web-server/auth/transport-actor';
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
	Pick<StartCrossAgentRequestOptions, 'writable' | 'actor' | 'initiator' | 'dispatchTicket'>
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
			dispatchTicket: opts.dispatchTicket,
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

describe('withdrawing a consult by its ask ticket (MCOMP-17-03AT)', () => {
	it('stops the consult in flight that the withdrawn ticket started, settled as canceled, once', async () => {
		const { spawned, chunks, dispatch } = harness(null);
		await dispatch({ requestId: 'r-at1' }, { dispatchTicket: 'ticket-at1' });
		expect(spawned).toHaveLength(1);
		expect(getCrossAgentConsultParties('r-at1')).not.toBeNull();

		expect(withdrawCrossAgentConsult('ticket-at1')).toBe(true);
		expect(getCrossAgentConsultParties('r-at1')).toBeNull();
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ requestId: 'r-at1', done: true, canceled: true });
		expect(chunks[0].error).toBeUndefined();
		// A second withdrawal finds nothing left to stop.
		expect(withdrawCrossAgentConsult('ticket-at1')).toBe(false);
		expect(chunks).toHaveLength(1);
	});

	it('refuses a consult whose ask was withdrawn before it arrived: nothing spawns, no listener stays', async () => {
		const { spawned, chunks, listeners, dispatch } = harness(null);
		const before = listeners();
		expect(withdrawCrossAgentConsult('ticket-at2')).toBe(false);
		await dispatch({ requestId: 'r-at2' }, { dispatchTicket: 'ticket-at2' });
		expect(spawned).toHaveLength(0);
		expect(listeners()).toBe(before);
		expect(getCrossAgentConsultParties('r-at2')).toBeNull();
		expect(chunks).toHaveLength(1);
		expect(chunks[0]).toMatchObject({ requestId: 'r-at2', done: true, canceled: true });
	});

	it('stops only the consult its own ticket started', async () => {
		const { chunks, dispatch } = harness(null);
		await dispatch({ requestId: 'r-at3' }, { dispatchTicket: 'ticket-at3' });
		await dispatch({ requestId: 'r-at4' }, { dispatchTicket: 'ticket-at4' });
		await dispatch({ requestId: 'r-at5' });
		expect(withdrawCrossAgentConsult('ticket-at3')).toBe(true);
		expect(chunks.map((c) => c.requestId)).toEqual(['r-at3']);
		expect(getCrossAgentConsultParties('r-at4')).not.toBeNull();
		expect(getCrossAgentConsultParties('r-at5')).not.toBeNull();
		// An unknown or empty ticket stops nothing.
		expect(withdrawCrossAgentConsult('ticket-unknown')).toBe(false);
		expect(withdrawCrossAgentConsult('')).toBe(false);
		expect(chunks).toHaveLength(1);
	});

	it('forgets a withdrawn ticket once it could no longer be claimed', async () => {
		const { spawned, dispatch } = harness(null);
		withdrawCrossAgentConsult('ticket-at6');
		vi.setSystemTime(Date.now() + DISPATCH_TICKET_TTL_MS + 1);
		await dispatch({ requestId: 'r-at6' }, { dispatchTicket: 'ticket-at6' });
		expect(spawned).toHaveLength(1);
	});

	it('remembers at most the cap of withdrawn tickets, forgetting the oldest first', async () => {
		const { spawned, chunks, dispatch } = harness(null);
		withdrawCrossAgentConsult('ticket-oldest');
		for (let i = 0; i < MAX_WITHDRAWN_CONSULT_TICKETS; i++)
			withdrawCrossAgentConsult(`ticket-cap-${i}`);
		await dispatch({ requestId: 'r-at7' }, { dispatchTicket: 'ticket-oldest' });
		expect(spawned).toHaveLength(1);
		await dispatch({ requestId: 'r-at8' }, { dispatchTicket: 'ticket-cap-0' });
		expect(spawned).toHaveLength(1);
		expect(chunks.at(-1)).toMatchObject({ requestId: 'r-at8', done: true, canceled: true });
	});
});

describe('binding the asking run to its ask ticket (MCOMP-17-03BF)', () => {
	/** The record an admitted Auto Run attempt was verified on: its run, trace and fenced workflow. */
	const autoRunLineage = (): ManagedDelegationContext => ({
		contractVersion: MANAGED_CONTRACT_VERSION,
		identity: {
			requestId: 'attempt-req-1',
			idempotencyKey: 'attempt-req-1',
			attemptId: 'attempt-1',
			runId: 'run-attempt-1',
			rootRunId: 'run-root',
			parentRunId: 'run-root',
		},
		traceId: 'trace-run-root',
		workflow: {
			workflowId: 'playbook:/work/.maestro/playbooks/release',
			version: 'docs-2-0badf00d',
			triggerEventId: 'operator:1700000000000',
			ownerEpoch: 'epoch-1',
			fencingToken: 'fence-1',
		},
		delegation: { chain: [{ kind: 'agent', id: 'src' }], grantRef: null },
		policyRevision: 1,
	});

	it('binds the consult its ticket starts as a child of the bound run, on its fenced workflow', async () => {
		const port = fakeSpawnPort();
		const { spawned, chunks, dispatch } = harness(port);
		expect(bindCrossAgentConsultInitiator('ticket-bf1', autoRunLineage())).toBe(true);
		await dispatch({ requestId: 'r-bf1' }, { dispatchTicket: 'ticket-bf1' });
		expect(chunks).toEqual([]);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].delegation).toEqual(autoRunLineage());
		const stamped = stampedOn(spawned[0]);
		expect(stamped).toEqual(
			childDelegationContext(autoRunLineage(), {
				link: { kind: 'agent', id: 'cross-agent-r-bf1' },
				requestId: 'r-bf1',
				attemptId: 'r-bf1',
			})
		);
		expect(stamped.identity.parentRunId).toBe('run-attempt-1');
		expect(stamped.identity.rootRunId).toBe('run-root');
		expect(stamped.workflow).toEqual(autoRunLineage().workflow);
		expect(port.asked[0].context.workflow).toEqual(autoRunLineage().workflow);
		expect(port.asked[0].context.delegation.chain).toEqual(stamped.delegation.chain);
	});

	it('uses a binding once: a replay of the ticket falls back to the plain ask lineage', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf2', autoRunLineage());
		await dispatch({ requestId: 'r-bf2' }, { dispatchTicket: 'ticket-bf2' });
		await dispatch({ requestId: 'r-bf3' }, { dispatchTicket: 'ticket-bf2' });
		expect(spawned).toHaveLength(2);
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('run-attempt-1');
		expect(stampedOn(spawned[1]).identity.parentRunId).toBe('ask:src:r-bf3');
		expect(stampedOn(spawned[1]).workflow).toBeNull();
	});

	it('the first binding holds: a second one is refused, never merged or replaced', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		expect(bindCrossAgentConsultInitiator('ticket-bf4', autoRunLineage())).toBe(true);
		expect(
			bindCrossAgentConsultInitiator('ticket-bf4', { ...managedInitiator(), policyRevision: 1 })
		).toBe(false);
		await dispatch({ requestId: 'r-bf4' }, { dispatchTicket: 'ticket-bf4' });
		expect(stampedOn(spawned[0]).identity.rootRunId).toBe('run-root');
	});

	it('copies the record in and out: changing the caller object never reaches the consult', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		const record = autoRunLineage();
		bindCrossAgentConsultInitiator('ticket-bf5', record);
		record.workflow!.fencingToken = 'forged';
		record.delegation.chain.push({ kind: 'agent', id: 'intruder' });
		await dispatch({ requestId: 'r-bf5' }, { dispatchTicket: 'ticket-bf5' });
		const stamped = stampedOn(spawned[0]);
		expect(stamped.workflow!.fencingToken).toBe('fence-1');
		expect(stamped.delegation.chain).toEqual([
			{ kind: 'agent', id: 'src' },
			{ kind: 'agent', id: 'cross-agent-r-bf5' },
		]);
	});

	it('a record the caller named outranks the binding, which is still spent', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf6', autoRunLineage());
		await dispatch(
			{ requestId: 'r-bf6' },
			{
				dispatchTicket: 'ticket-bf6',
				initiator: { delegation: { ...managedInitiator(), policyRevision: 1 }, writable: null },
			}
		);
		await dispatch({ requestId: 'r-bf7' }, { dispatchTicket: 'ticket-bf6' });
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('cue-run-1');
		expect(stampedOn(spawned[1]).identity.parentRunId).toBe('ask:src:r-bf7');
	});

	it('a consult without the ticket, or with another, never picks the binding up', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf8', autoRunLineage());
		await dispatch({ requestId: 'r-bf8' });
		await dispatch({ requestId: 'r-bf9' }, { dispatchTicket: 'ticket-other' });
		await dispatch({ requestId: 'r-bf10' }, { dispatchTicket: 'ticket-bf8' });
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('ask:src:r-bf8');
		expect(stampedOn(spawned[1]).identity.parentRunId).toBe('ask:src:r-bf9');
		expect(stampedOn(spawned[2]).identity.parentRunId).toBe('run-attempt-1');
	});

	it('a withdrawn ticket drops its binding and binds nothing more; the consult is refused', async () => {
		const { spawned, chunks, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf11', autoRunLineage());
		withdrawCrossAgentConsult('ticket-bf11');
		expect(bindCrossAgentConsultInitiator('ticket-bf11', autoRunLineage())).toBe(false);
		await dispatch({ requestId: 'r-bf11' }, { dispatchTicket: 'ticket-bf11' });
		expect(spawned).toHaveLength(0);
		expect(chunks.at(-1)).toMatchObject({ requestId: 'r-bf11', done: true, canceled: true });
	});

	it('refuses an empty ticket or a missing record', () => {
		expect(bindCrossAgentConsultInitiator('', autoRunLineage())).toBe(false);
		expect(bindCrossAgentConsultInitiator('ticket-bf12', null as never)).toBe(false);
	});

	it('expires a binding with its ticket', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf13', autoRunLineage());
		vi.setSystemTime(Date.now() + DISPATCH_TICKET_TTL_MS + 1);
		await dispatch({ requestId: 'r-bf13' }, { dispatchTicket: 'ticket-bf13' });
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('ask:src:r-bf13');
	});

	it('remembers at most the cap of bindings, forgetting the oldest first', async () => {
		const { spawned, dispatch } = harness(fakeSpawnPort());
		bindCrossAgentConsultInitiator('ticket-bf-oldest', autoRunLineage());
		for (let i = 0; i < MAX_BOUND_CONSULT_INITIATORS; i++)
			bindCrossAgentConsultInitiator(`ticket-bf-cap-${i}`, autoRunLineage());
		await dispatch({ requestId: 'r-bf14' }, { dispatchTicket: 'ticket-bf-oldest' });
		await dispatch({ requestId: 'r-bf15' }, { dispatchTicket: 'ticket-bf-cap-0' });
		expect(stampedOn(spawned[0]).identity.parentRunId).toBe('ask:src:r-bf14');
		expect(stampedOn(spawned[1]).identity.parentRunId).toBe('run-attempt-1');
	});
});
