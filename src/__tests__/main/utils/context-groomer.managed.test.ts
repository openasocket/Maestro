/**
 * The grooming turn under management (MRC2-02-02, MRC2-02-02A, MRC2-02-06).
 *
 * `groomContext()` is driven against the REAL `ProcessManager` and the real
 * lease authority behind `fakeSpawnPort` (only the policy answer is a table),
 * with the manager's `spawn` spied at the very end so what the sink was handed
 * is what these tests read. Each guard here has a test that fails when the
 * guard is removed:
 *
 * - a utility turn is admitted as `purpose: utility` by the caller's origin,
 *   serving the agent and tab named (`utilityOf`), traced under that tab, and
 *   the spawner is handed the admission the manager minted;
 * - a turn the policy refuses, or the route ceiling refuses (another provider,
 *   a model other than the pinned one, a credential the turn cannot deliver),
 *   rejects with the reason and never reaches `processManager.spawn`;
 * - the lineage reader at the IPC boundary (`utilityLineageOf`) refuses a
 *   malformed id before any turn runs;
 * - a standalone host and a manager double with only `spawn` are unchanged.
 */
import * as os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: (): string => os.tmpdir() },
	safeStorage: { isEncryptionAvailable: (): boolean => false },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { getAgentCapabilities } from '../../../main/agents';
import type { AgentDetector } from '../../../main/agents';
import { getAgentDefinition } from '../../../main/agents/definitions';
import { ProcessManager } from '../../../main/process-manager';
import { utilityLineageOf, type ProcessConfig } from '../../../main/process-manager/types';
import {
	cancelAllGroomingSessions,
	getActiveGroomingSessionCount,
	groomContext,
	type GroomingProcessManager,
} from '../../../main/utils/context-groomer';
import type { ManagedRouteCeiling } from '../../../shared/maestro-lib/launch/env';
import { fakeSpawnPort, type FakeSpawnPort } from '../../helpers/managedSpawnPort';

const AGENT = '11111111-2222-4333-8444-555555555555';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ANSWER = 'x'.repeat(120);

function agentFor(id: string) {
	const definition = getAgentDefinition(id);
	if (!definition) throw new Error(`no ${id} definition`);
	return {
		...definition,
		available: true,
		path: `/usr/local/bin/${definition.binaryName}`,
		capabilities: getAgentCapabilities(id as never),
	};
}

function detector(): AgentDetector {
	return {
		getAgent: async (id: string) => agentFor(id),
	} as unknown as AgentDetector;
}

/**
 * The real manager over the port given (none: a bare manager with no
 * authority). `spawn` is replaced at the very end: no process starts, and the
 * turn is answered a moment later so the groomer resolves.
 */
function harness(port: FakeSpawnPort | null) {
	const processManager = port
		? new ProcessManager(() => true, { spawnAuthority: () => port })
		: new ProcessManager();
	processManager.on('agent-error', () => {});
	const spawn = vi.spyOn(processManager, 'spawn').mockImplementation(((config: ProcessConfig) => {
		setTimeout(() => {
			processManager.emit('data', config.sessionId, ANSWER);
			processManager.emit('exit', config.sessionId, 0);
		}, 5);
		return { pid: 4242, success: true };
	}) as never);
	return { processManager, spawn };
}

function spawned(h: ReturnType<typeof harness>): ProcessConfig {
	expect(h.spawn).toHaveBeenCalledOnce();
	return h.spawn.mock.calls[0][0] as ProcessConfig;
}

const route = (overrides: Partial<ManagedRouteCeiling> = {}): ManagedRouteCeiling => ({
	providerId: 'claude-code',
	model: null,
	baseUrl: null,
	accountDir: null,
	login: 'provider-login',
	permissionMode: null,
	...overrides,
});

const baseOptions = {
	projectRoot: os.tmpdir(),
	agentType: 'claude-code',
	prompt: 'Name this conversation.',
	timeoutMs: 2000,
	agentConfigValues: {},
};

describe('groomContext under management: admission and lineage', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('admits the utility turn serving the named agent and tab, traced under that tab, and hands the spawner the admission the manager minted', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const result = await groomContext(
			{ ...baseOptions, lineage: { sessionId: AGENT, tabId: TAB } },
			h.processManager,
			detector()
		);
		expect(result.response).toBe(ANSWER);
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			purpose: 'utility',
			origin: 'desktop',
			provider: 'claude-code',
			operation: 'start',
		});
		expect(port.asked[0].context.traceId).toBe(`${AGENT}-ai-${TAB}`);
		const admitted = spawned(h);
		expect(admitted.purpose).toBe('utility');
		expect(admitted.origin).toBe('desktop');
		expect(admitted.utilityOf).toEqual({ sessionId: AGENT, tabId: TAB });
		expect(admitted.admission).toBeDefined();
		const live = port.authority.live();
		expect(live).toHaveLength(1);
		expect(live[0].leaseId).toBe(admitted.admission?.leaseId);
		expect(admitted.admission?.provider).toBe('claude-code');
	});

	it('traces a turn that names no lineage under its own groomer id, serving nobody', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		await groomContext(baseOptions, h.processManager, detector());
		expect(port.asked[0].context.traceId).toMatch(/^groomer-/);
		expect(spawned(h)).not.toHaveProperty('utilityOf');
	});

	it('admits a turn raised by the CLI secret with origin cli', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		await groomContext(
			{ ...baseOptions, actor: { peer: 'host-secret' } },
			h.processManager,
			detector()
		);
		expect(port.asked[0].snapshot).toMatchObject({ purpose: 'utility', origin: 'cli' });
		expect(spawned(h).origin).toBe('cli');
	});

	it('a turn the policy refuses rejects with the reason, never reaches the spawner and leaves no lease live', async () => {
		const port = fakeSpawnPort({
			decide: (request) =>
				request.snapshot.provider === 'claude-code'
					? {
							decision: 'deny',
							reason: 'claude-code is not an approved provider',
							policyRevision: 1,
							code: 'policy-denied',
						}
					: { decision: 'allow', policyRevision: 1 },
		});
		const h = harness(port);
		await expect(groomContext(baseOptions, h.processManager, detector())).rejects.toThrow(
			/not an approved provider/
		);
		expect(port.asked).toHaveLength(1);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.authority.live()).toHaveLength(0);
	});
});

describe('groomContext under management: the utility route ceiling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses a ceiling that routes utility turns to another provider before the admission is asked', async () => {
		const port = fakeSpawnPort();
		const consulted: string[] = [];
		port.routeCeiling = (providerId) => {
			consulted.push(providerId);
			return route({ providerId: 'codex' });
		};
		const h = harness(port);
		await expect(groomContext(baseOptions, h.processManager, detector())).rejects.toThrow(
			/routes utility turns on this host to codex, not claude-code/
		);
		expect(consulted).toEqual(['claude-code']);
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
	});

	it('denies a utility model other than the pinned one, never lowering it to fit', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => route({ model: 'claude-opus-5-5' });
		const h = harness(port);
		await expect(
			groomContext({ ...baseOptions, modelId: 'claude-haiku-5-5' }, h.processManager, detector())
		).rejects.toThrow(/names claude-haiku-5-5 but the policy pins claude-opus-5-5/);
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
	});

	it('pins the model and strips the user route variables when the arguments name none', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => route({ model: 'claude-opus-5-5', accountDir: '/managed/home' });
		const h = harness(port);
		await groomContext(
			{ ...baseOptions, sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-user', KEEP: '1' } },
			h.processManager,
			detector()
		);
		expect(port.asked).toHaveLength(1);
		const admitted = spawned(h);
		expect(admitted.args.slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
		expect(admitted.customEnvVars).toMatchObject({
			KEEP: '1',
			ANTHROPIC_MODEL: 'claude-opus-5-5',
			CLAUDE_CONFIG_DIR: '/managed/home',
		});
		expect(admitted.customEnvVars).not.toHaveProperty('ANTHROPIC_API_KEY');
	});

	it('refuses a route that requires an approved credential, since a utility turn delivers none', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => route({ login: 'approved-credential' });
		const h = harness(port);
		await expect(groomContext(baseOptions, h.processManager, detector())).rejects.toThrow(
			/requires an approved credential and none was delivered/
		);
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
	});

	it('a ceiling of null bounds nothing: the admission decides and the user environment stays', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => null;
		const h = harness(port);
		await groomContext(
			{ ...baseOptions, sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-user' } },
			h.processManager,
			detector()
		);
		expect(spawned(h).customEnvVars).toMatchObject({ ANTHROPIC_API_KEY: 'sk-user' });
		expect(port.asked).toHaveLength(1);
	});
});

describe('groomContext on a standalone host: unchanged', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('a standalone port never consults the ceiling, asks no admission and binds none, still classifying the turn', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const consulted = vi.fn(() => route({ providerId: 'codex' }));
		port.routeCeiling = consulted;
		const h = harness(port);
		await groomContext(
			{ ...baseOptions, lineage: { sessionId: AGENT, tabId: TAB } },
			h.processManager,
			detector()
		);
		expect(consulted).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		const admitted = spawned(h);
		expect(admitted.admission).toBeUndefined();
		expect(admitted.purpose).toBe('utility');
		expect(admitted.utilityOf).toEqual({ sessionId: AGENT, tabId: TAB });
	});

	it('a bare manager with no authority spawns as before, still classified', async () => {
		const h = harness(null);
		await groomContext(baseOptions, h.processManager, detector());
		const admitted = spawned(h);
		expect(admitted).toMatchObject({ purpose: 'utility', origin: 'desktop' });
		expect(admitted.admission).toBeUndefined();
	});

	it('a manager double with only spawn runs as before, classified as a utility turn with its lineage', async () => {
		const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
		let last: Record<string, unknown> | null = null;
		const pm: GroomingProcessManager = {
			spawn(config) {
				last = config as unknown as Record<string, unknown>;
				setTimeout(() => {
					for (const fn of handlers.get('data') ?? []) fn(config.sessionId, ANSWER);
					for (const fn of handlers.get('exit') ?? []) fn(config.sessionId, 0);
				}, 5);
				return { pid: 1, success: true };
			},
			on: (e, h) => {
				handlers.set(e, [...(handlers.get(e) ?? []), h]);
			},
			off: () => {},
			kill: vi.fn(),
		};
		const result = await groomContext(
			{ ...baseOptions, lineage: { sessionId: AGENT, tabId: TAB } },
			pm,
			detector()
		);
		expect(result.response).toBe(ANSWER);
		expect(last).toMatchObject({
			purpose: 'utility',
			origin: 'desktop',
			utilityOf: { sessionId: AGENT, tabId: TAB },
		});
		expect(last).not.toHaveProperty('admission');
	});
});

describe('groomContext cancellation across desktop admission', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => {
		cancelAllGroomingSessions();
		vi.restoreAllMocks();
	});

	it('cancels before detector completion without asking admission or starting a reader', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const admitted = vi.spyOn(h.processManager, 'spawnAdmitted');
		const kill = vi.spyOn(h.processManager, 'kill').mockReturnValue(true);
		let resolveAgent!: (agent: ReturnType<typeof agentFor>) => void;
		const pendingAgent = new Promise<ReturnType<typeof agentFor>>((resolve) => {
			resolveAgent = resolve;
		});
		const selectedDetector = detector();
		vi.spyOn(selectedDetector, 'getAgent').mockReturnValue(pendingAgent);
		const pending = groomContext(baseOptions, h.processManager, selectedDetector);
		const rejected = expect(pending).rejects.toThrow('Grooming cancelled by user');
		expect(getActiveGroomingSessionCount()).toBe(1);
		cancelAllGroomingSessions();
		resolveAgent(agentFor('claude-code'));
		await rejected;
		expect(admitted).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
		expect(getActiveGroomingSessionCount()).toBe(0);
	});

	it.each(['allow', 'deny', 'reject'] as const)(
		'cancels while a %s policy decision is pending and never starts its late reader',
		async (decision) => {
			let finishDecision!: () => void;
			const decisionGate = new Promise<void>((resolve) => {
				finishDecision = resolve;
			});
			let markAsked!: () => void;
			const asked = new Promise<void>((resolve) => {
				markAsked = resolve;
			});
			const privatePrompt = 'PRIVATE pending grooming content /synthetic/private.json';
			const port = fakeSpawnPort({
				decide: async () => {
					markAsked();
					await decisionGate;
					if (decision === 'reject') throw new Error(privatePrompt);
					return decision === 'allow'
						? { decision: 'allow', policyRevision: 1 }
						: { decision: 'deny', policyRevision: 1, code: 'policy-denied', reason: privatePrompt };
				},
			});
			const h = harness(port);
			const admitted = vi.spyOn(h.processManager, 'spawnAdmitted');
			const kill = vi.spyOn(h.processManager, 'kill').mockReturnValue(true);
			const pending = groomContext(
				{
					...baseOptions,
					prompt: privatePrompt,
					lineage: { sessionId: AGENT, tabId: TAB },
					actor: { peer: 'host-secret' },
				},
				h.processManager,
				detector()
			);
			const rejected = expect(pending).rejects.toThrow('Grooming cancelled by user');
			await asked;
			const [request, actor, controls] = admitted.mock.calls[0];
			expect(controls?.signal?.aborted).toBe(false);
			expect(request).not.toHaveProperty('signal');
			expect(actor).toEqual({ peer: 'host-secret' });
			expect(request.utilityOf).toEqual({ sessionId: AGENT, tabId: TAB });
			cancelAllGroomingSessions();
			cancelAllGroomingSessions();
			await rejected;
			expect(controls?.signal?.aborted).toBe(true);
			finishDecision();
			const outcome = await admitted.mock.results[0].value;
			expect(outcome).toEqual({
				pid: -1,
				success: false,
				error: 'Spawn cancelled before starting.',
			});
			expect(admitted).toHaveBeenCalledOnce();
			expect(h.spawn).not.toHaveBeenCalled();
			expect(kill).toHaveBeenCalledExactlyOnceWith(request.sessionId);
			expect(port.authority.live()).toHaveLength(0);
			expect(getActiveGroomingSessionCount()).toBe(0);
			expect(h.processManager.listenerCount('data')).toBe(0);
			expect(h.processManager.listenerCount('exit')).toBe(1);
			expect(h.processManager.listenerCount('agent-error')).toBe(1);
			const serialized = JSON.stringify({ requests: port.asked, outcome });
			expect(serialized).not.toContain(privatePrompt);
			expect(serialized).not.toContain('"signal"');
		}
	);

	it('keeps Stop on the existing active reader after admission succeeds', async () => {
		const h = harness(fakeSpawnPort());
		const admitted = vi.spyOn(h.processManager, 'spawnAdmitted');
		const kill = vi.spyOn(h.processManager, 'kill').mockReturnValue(true);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		h.spawn.mockImplementationOnce(() => {
			markStarted();
			return { pid: 4242, success: true };
		});
		const pending = groomContext(baseOptions, h.processManager, detector());
		const rejected = expect(pending).rejects.toThrow('Grooming cancelled by user');
		await started;
		await admitted.mock.results[0].value;
		const request = spawned(h);
		const signal = admitted.mock.calls[0][2]?.signal;
		expect(signal?.aborted).toBe(false);
		cancelAllGroomingSessions();
		await rejected;
		cancelAllGroomingSessions();
		expect(signal?.aborted).toBe(true);
		expect(kill).toHaveBeenCalledExactlyOnceWith(request.sessionId);
		h.processManager.emit('data', request.sessionId, 'late reader data');
		h.processManager.emit('exit', request.sessionId, 0);
		expect(getActiveGroomingSessionCount()).toBe(0);
		expect(h.processManager.listenerCount('data')).toBe(0);
		expect(h.processManager.listenerCount('exit')).toBe(1);
	});

	it.each(['managed', 'standalone'] as const)(
		'finishes an uncanceled %s turn with the signal outside the launch configuration',
		async (standing) => {
			const h = harness(fakeSpawnPort({ standing }));
			const admitted = vi.spyOn(h.processManager, 'spawnAdmitted');
			const kill = vi.spyOn(h.processManager, 'kill').mockReturnValue(true);
			const result = await groomContext(baseOptions, h.processManager, detector());
			expect(result.response).toBe(ANSWER);
			const signal = admitted.mock.calls[0][2]?.signal;
			expect(signal?.aborted).toBe(false);
			expect(spawned(h)).not.toHaveProperty('signal');
			expect(JSON.stringify(spawned(h))).not.toContain('"signal"');
			cancelAllGroomingSessions();
			expect(signal?.aborted).toBe(false);
			expect(kill).not.toHaveBeenCalled();
			expect(getActiveGroomingSessionCount()).toBe(0);
		}
	);
});

describe('utilityLineageOf: the lineage reader at the IPC boundary', () => {
	it('reads nothing as no lineage, which is what every caller sent before the ids existed', () => {
		expect(utilityLineageOf(undefined)).toBeUndefined();
		expect(utilityLineageOf(null)).toBeUndefined();
		expect(utilityLineageOf({})).toBeUndefined();
		expect(utilityLineageOf({ sessionId: undefined, tabId: undefined })).toBeUndefined();
	});

	it('reads plain strings and drops a missing tab', () => {
		expect(utilityLineageOf({ sessionId: 'a1' })).toEqual({ sessionId: 'a1' });
		expect(utilityLineageOf({ sessionId: 'a1', tabId: 't1' })).toEqual({
			sessionId: 'a1',
			tabId: 't1',
		});
		expect(utilityLineageOf({ sessionId: 'a1', tabId: null })).toEqual({ sessionId: 'a1' });
	});

	it('refuses anything that is not a plain non-empty string before any turn runs', () => {
		expect(() => utilityLineageOf('a1')).toThrow(/must name an agent/);
		expect(() => utilityLineageOf({ sessionId: 7 })).toThrow(/agent id must be a string/);
		expect(() => utilityLineageOf({ sessionId: '' })).toThrow(/agent id/);
		expect(() => utilityLineageOf({ sessionId: 'a'.repeat(257) })).toThrow(/agent id/);
		expect(() => utilityLineageOf({ sessionId: 'a1', tabId: {} })).toThrow(/tab id must be/);
		expect(() => utilityLineageOf({ sessionId: 'a1', tabId: '' })).toThrow(/tab id/);
	});

	it('refuses a tab named without the agent it belongs to', () => {
		expect(() => utilityLineageOf({ tabId: 't1' })).toThrow(/names a tab but not the agent/);
	});
});
