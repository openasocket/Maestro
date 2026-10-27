/**
 * The tab naming turn under management (MRC-09-02B, MRC2-02-06).
 *
 * `generateTabName()` is driven against the REAL `ProcessManager` and the real
 * lease authority behind `fakeSpawnPort` (only the policy answer is a table),
 * with the manager's `spawn` spied at the very end so what the sink was handed
 * is what these tests read. Each guard here has a test that fails when the
 * guard is removed:
 *
 * - a dispatched naming turn (a plugin's `agents.generateTitle`) is admitted
 *   as the dispatching operation's child, with the lineage on the config and
 *   the admission the manager minted handed to the spawner;
 * - a turn the policy refuses never reaches `processManager.spawn` and the
 *   name resolves null at once;
 * - a naming turn with no admission on a managed host is refused by the sink
 *   before any spawner;
 * - a standalone host spawns as before, with no admission bound.
 */
import * as os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	app: { getPath: (): string => os.tmpdir() },
	safeStorage: { isEncryptionAvailable: (): boolean => false },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));
vi.mock('../../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn(() => 'You are a tab naming assistant. Generate a concise tab name.'),
}));

import { getAgentCapabilities } from '../../../../main/agents';
import type { AgentDetector } from '../../../../main/agents';
import { getAgentDefinition } from '../../../../main/agents/definitions';
import {
	generateTabName,
	type TabNamingHandlerDependencies,
} from '../../../../main/ipc/handlers/tabNaming';
import { ProcessManager } from '../../../../main/process-manager';
import type { ProcessConfig } from '../../../../main/process-manager/types';
import { logger } from '../../../../main/utils/logger';
import type { ManagedDelegationContext } from '../../../../shared/maestro-lib/managed/delegation';
import { MANAGED_CONTRACT_VERSION } from '../../../../shared/maestro-lib/managed/types';
import { fakeSpawnPort, type FakeSpawnPort } from '../../../helpers/managedSpawnPort';

/** The context a plugin's `agents.generateTitle` hands the title sink under management. */
const PLUGIN_CONTEXT: ManagedDelegationContext = {
	contractVersion: MANAGED_CONTRACT_VERSION,
	identity: {
		requestId: 'req-plugin',
		idempotencyKey: 'req-plugin',
		attemptId: 'att-plugin',
		runId: 'req-plugin',
		rootRunId: 'req-plugin',
		parentRunId: null,
	},
	traceId: 'plugin:p:req-plugin:att-plugin',
	workflow: null,
	delegation: {
		chain: [{ kind: 'service', id: 'plugin:p' }],
		grantRef: 'plugin-consent:p:sha256:deadbeef:1',
	},
	policyRevision: 1,
};
const DISPATCHED_AS = { requestId: 'req-naming', attemptId: 'att-naming' };
/** The same hand-off from an initiator that was never under management (no policy generation). */
const UNMANAGED_INITIATOR: ManagedDelegationContext = { ...PLUGIN_CONTEXT, policyRevision: null };

function fakeStore(data: Record<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
		set: (key: string, value: unknown) => {
			data[key] = value;
		},
	};
}

function detector(): AgentDetector {
	const definition = getAgentDefinition('codex');
	if (!definition) throw new Error('no codex definition');
	const agent = {
		...definition,
		available: true,
		path: '/usr/local/bin/codex',
		capabilities: getAgentCapabilities('codex'),
	};
	return {
		getAgent: async (id: string) => (id === 'codex' ? agent : null),
	} as unknown as AgentDetector;
}

interface Harness {
	deps: TabNamingHandlerDependencies;
	processManager: ProcessManager;
	spawn: ReturnType<typeof vi.spyOn>;
	/** Every `agent-error` the manager reported, as `[sessionId, message]`. */
	errors: Array<[string, string]>;
	/** Lets the naming turn finish with a name once the spawn was observed. */
	answer(name: string): void;
}

/**
 * The real manager over the port given (none: a bare manager with no
 * authority). `spawn` is replaced at the very end unless `spySpawn` is false,
 * in which case the real sink runs and its result can be read off the spy.
 */
function harness(port: FakeSpawnPort | null, options: { spySpawn?: boolean } = {}): Harness {
	const processManager = port
		? new ProcessManager(() => true, { spawnAuthority: () => port })
		: new ProcessManager();
	const errors: Array<[string, string]> = [];
	processManager.on('agent-error', (sessionId: string, error: { message: string }) => {
		errors.push([sessionId, error.message]);
	});
	const spawn = vi.spyOn(processManager, 'spawn');
	if (options.spySpawn !== false) {
		spawn.mockImplementation(() => ({ pid: 4242, success: true }));
	}
	const deps: TabNamingHandlerDependencies = {
		getProcessManager: () => processManager,
		getAgentDetector: detector,
		agentConfigsStore: fakeStore({
			configs: {},
		}) as unknown as TabNamingHandlerDependencies['agentConfigsStore'],
		settingsStore: fakeStore({
			shellEnvVars: {},
			utilityAgentId: null,
			utilityModelId: null,
			shortenLongTabNames: false,
		}) as unknown as TabNamingHandlerDependencies['settingsStore'],
	};
	return {
		deps,
		processManager,
		spawn,
		errors,
		answer(name) {
			const config = spawn.mock.calls[0][0] as ProcessConfig;
			processManager.emit('data', config.sessionId, name);
			processManager.emit('exit', config.sessionId, 0);
		},
	};
}

function baseConfig() {
	return {
		userMessage: 'Build a login form',
		agentType: 'codex',
		cwd: os.tmpdir(),
		sessionCustomEnvVars: { MINE: '1' },
		useUtilityAgent: false,
		enableMaestroP: false,
	};
}

function dispatchedConfig(delegation: ManagedDelegationContext = PLUGIN_CONTEXT) {
	return { ...baseConfig(), delegation, dispatchedAs: DISPATCHED_AS };
}

describe('generateTabName under management: the dispatched naming turn', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("admits a dispatched turn as the dispatching operation's child and hands the spawner the admission the manager minted", async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const pending = generateTabName(h.deps, dispatchedConfig());
		await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
		const admitted = h.spawn.mock.calls[0][0] as ProcessConfig;
		// The lineage on the config is what the sink bound: the plugin's chain one
		// link deeper (the naming session), parented under the plugin's request,
		// minted as the ids the caller fixed.
		expect(admitted.delegation).toEqual(PLUGIN_CONTEXT);
		expect(admitted.dispatchedAs).toEqual(DISPATCHED_AS);
		expect(port.asked).toHaveLength(1);
		const { context, snapshot } = port.asked[0];
		expect(snapshot).toMatchObject({ provider: 'codex', operation: 'start', origin: 'desktop' });
		expect(context.delegation.chain).toEqual([
			{ kind: 'service', id: 'plugin:p' },
			{ kind: 'agent', id: admitted.sessionId },
		]);
		expect(context.delegation.grantRef).toBe('plugin-consent:p:sha256:deadbeef:1');
		expect(context.identity).toMatchObject({
			requestId: 'req-naming',
			attemptId: 'att-naming',
			parentRunId: 'req-plugin',
			rootRunId: 'req-plugin',
		});
		// The admission on the config is a lease the real authority holds live.
		expect(admitted.admission).toBeDefined();
		const live = port.authority.live();
		expect(live).toHaveLength(1);
		expect(live[0].leaseId).toBe(admitted.admission?.leaseId);
		expect(admitted.admission?.requestId).toBe('req-naming');
		expect(admitted.admission?.attemptId).toBe('att-naming');
		h.answer('Login Form');
		await expect(pending).resolves.toBe('Login Form');
	});

	it('a dispatched turn the policy refuses never reaches the spawner and resolves null at once', async () => {
		const port = fakeSpawnPort({
			decide: (request) =>
				request.snapshot.provider === 'codex'
					? {
							decision: 'deny',
							reason: 'codex is not an approved provider on this host',
							policyRevision: 1,
							code: 'policy-denied',
						}
					: { decision: 'allow', policyRevision: 1 },
		});
		const h = harness(port);
		const result = await generateTabName(h.deps, dispatchedConfig());
		expect(result).toBeNull();
		expect(port.asked).toHaveLength(1);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.authority.live()).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalledWith(
			'Dispatched tab naming spawn was not admitted',
			'[TabNaming]',
			expect.objectContaining({
				managed: { state: 'denied', code: 'policy-denied' },
				error: expect.stringMatching(/not an approved provider/),
			})
		);
		// Reported into the naming session as an agent error, since no process exists to.
		expect(h.errors).toEqual([
			[expect.stringMatching(/^tab-naming-/), expect.stringMatching(/not an approved provider/)],
		]);
	});

	it('a dispatched turn whose carried context is not one is refused as invalid input, never spawned', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const result = await generateTabName(h.deps, {
			...dispatchedConfig(),
			// A record from another contract: what a forged or stale hand-off looks like.
			delegation: {
				...PLUGIN_CONTEXT,
				contractVersion: 'not-a-version',
			} as unknown as ManagedDelegationContext,
		});
		expect(result).toBeNull();
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			'Dispatched tab naming spawn was not admitted',
			'[TabNaming]',
			expect.objectContaining({ managed: { state: 'denied', code: 'invalid-input' } })
		);
	});
});

describe('generateTabName under management: no admission, no process', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('a naming turn with no delegation reaches the sink bare on a managed host and is refused before any spawner', async () => {
		const port = fakeSpawnPort();
		const h = harness(port, { spySpawn: false });
		const controller = new AbortController();
		const pending = generateTabName(h.deps, baseConfig(), controller.signal);
		await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
		const config = h.spawn.mock.calls[0][0] as ProcessConfig;
		expect(config.admission).toBeUndefined();
		const result = h.spawn.mock.results[0].value as {
			success: boolean;
			managed?: { state: string; code: string };
			error?: string;
		};
		expect(result.success).toBe(false);
		expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
		expect(result.error).toMatch(/carries no admission/);
		expect(port.asked).toHaveLength(0);
		expect(h.errors).toEqual([[config.sessionId, expect.stringMatching(/carries no admission/)]]);
		// Observed, not a guard: the bare spawn's refusal is not read back by the
		// naming turn, which waits for an exit that never comes until its own
		// timeout (or a cancellation, as here).
		controller.abort();
		await expect(pending).resolves.toBeNull();
	});
});

describe('generateTabName on a standalone host: unchanged', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('a standalone port spawns a turn dispatched by an unmanaged initiator with the lineage on the config, asking no admission and binding none', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const h = harness(port);
		const pending = generateTabName(h.deps, dispatchedConfig(UNMANAGED_INITIATOR));
		await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
		const config = h.spawn.mock.calls[0][0] as ProcessConfig;
		expect(config.delegation).toEqual(UNMANAGED_INITIATOR);
		expect(config.dispatchedAs).toEqual(DISPATCHED_AS);
		expect(config.admission).toBeUndefined();
		expect(port.asked).toHaveLength(0);
		h.answer('Login Form');
		await expect(pending).resolves.toBe('Login Form');
	});

	it("a managed initiator's turn on a standalone host is refused unavailable, never run unmanaged in its place", async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const h = harness(port);
		const result = await generateTabName(h.deps, dispatchedConfig(PLUGIN_CONTEXT));
		expect(result).toBeNull();
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		expect(logger.warn).toHaveBeenCalledWith(
			'Dispatched tab naming spawn was not admitted',
			'[TabNaming]',
			expect.objectContaining({
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
				error: expect.stringMatching(/does not run unmanaged in its place/),
			})
		);
	});

	it('a standalone port spawns an undispatched turn exactly as before: no lineage, no admission', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const h = harness(port);
		const pending = generateTabName(h.deps, baseConfig());
		await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
		const config = h.spawn.mock.calls[0][0] as ProcessConfig;
		expect(config).not.toHaveProperty('delegation');
		expect(config).not.toHaveProperty('dispatchedAs');
		expect(config.admission).toBeUndefined();
		expect(config.customEnvVars).toMatchObject({ MINE: '1' });
		expect(port.asked).toHaveLength(0);
		expect(h.errors).toEqual([]);
		h.answer('Login Form');
		await expect(pending).resolves.toBe('Login Form');
	});

	it('a bare manager with no authority spawns an unmanaged dispatched turn with its lineage and no admission', async () => {
		const h = harness(null);
		const pending = generateTabName(h.deps, dispatchedConfig(UNMANAGED_INITIATOR));
		await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
		const config = h.spawn.mock.calls[0][0] as ProcessConfig;
		expect(config.delegation).toEqual(UNMANAGED_INITIATOR);
		expect(config.admission).toBeUndefined();
		h.answer('Login Form');
		await expect(pending).resolves.toBe('Login Form');
	});
});
