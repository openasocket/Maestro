/**
 * `process:spawn` under management (MRC2-02-01, MRC2-02-01A, MRC2-02-06).
 *
 * The handler is driven against the REAL `ProcessManager` and the real lease
 * authority behind `fakeSpawnPort` (only the policy answer is a table), with
 * the manager's `spawn` spied at the very end so what the sink was handed is
 * what these tests read. Each guard here has a test that fails when the guard
 * is removed:
 *
 * - an admitted spawn carries the admission the manager minted (a live lease
 *   on the authority) to the spawner, classified `conversation` and by the
 *   caller's origin;
 * - a spawn the policy refuses never reaches `processManager.spawn`, and the
 *   sink refuses a launch with no admission (or a forged one) before any
 *   spawner;
 * - a full-access request above the policy's permission ceiling is DENIED
 *   before the launch plan, never lowered to fit;
 * - a standalone host and a bare manager are unchanged.
 */
import * as os from 'os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
	app: { getPath: (): string => os.tmpdir() },
	safeStorage: { isEncryptionAvailable: (): boolean => false },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));
vi.mock('../../../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { getAgentCapabilities } from '../../../../../main/agents';
import type { AgentDetector } from '../../../../../main/agents';
import { getAgentDefinition } from '../../../../../main/agents/definitions';
import { handleProcessSpawn } from '../../../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnHandlerDependencies } from '../../../../../main/ipc/handlers/process/handle-spawn';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';
import { ProcessManager } from '../../../../../main/process-manager';
import type { ProcessConfig } from '../../../../../main/process-manager/types';
import {
	getActingTransport,
	issueDispatchTicket,
	runAsClient,
} from '../../../../../main/web-server/auth/transport-actor';
import {
	fakeAdmission,
	fakeSpawnPort,
	type FakeSpawnPort,
} from '../../../../helpers/managedSpawnPort';

const AGENT = '11111111-2222-4333-8444-555555555555';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROCESS = `${AGENT}-ai-${TAB}`;

function fakeStore(data: Record<string, unknown>) {
	return {
		get: (key: string, fallback?: unknown) => (key in data ? data[key] : fallback),
		set: (key: string, value: unknown) => {
			data[key] = value;
		},
	};
}

function payload(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	const definition = getAgentDefinition('codex');
	if (!definition) throw new Error('no codex definition');
	return {
		sessionId: PROCESS,
		toolType: 'codex',
		cwd: os.tmpdir(),
		command: definition.command,
		args: [...definition.args],
		prompt: 'List the files.',
		readOnlyMode: false,
		permissionMode: 'full',
		querySource: 'user',
		tabId: TAB,
		...overrides,
	};
}

interface Harness {
	deps: SpawnHandlerDependencies;
	processManager: ProcessManager;
	spawn: ReturnType<typeof vi.spyOn>;
	/** Everything the handler sent to the window, as `[channel, ...args]`. */
	sent: unknown[][];
	/** Every `agent-error` the manager reported, as `[sessionId, message]`. */
	errors: Array<[string, string]>;
}

/**
 * The real manager over the port given (none: a bare manager with no
 * authority), its `spawn` replaced at the very end so no process starts and
 * the config the sink was handed can be read back.
 */
function harness(port: FakeSpawnPort | null, options: { spySpawn?: boolean } = {}): Harness {
	const definition = getAgentDefinition('codex');
	if (!definition) throw new Error('no codex definition');
	const agent = {
		...definition,
		available: true,
		path: '/usr/local/bin/codex',
		capabilities: getAgentCapabilities('codex'),
	};
	const sessions = {
		sessions: [
			{ id: AGENT, name: 'Backend', toolType: 'codex', cwd: os.tmpdir(), aiTabs: [{ id: TAB }] },
		],
	};
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
	const sent: unknown[][] = [];
	const window = {
		isDestroyed: (): boolean => false,
		webContents: {
			isDestroyed: (): boolean => false,
			send: (channel: string, ...args: unknown[]): void => {
				sent.push([channel, ...args]);
			},
		},
	};
	const deps: SpawnHandlerDependencies = {
		getProcessManager: () => processManager,
		getAgentDetector: () =>
			({
				getAgent: async (id: string) => (id === 'codex' ? agent : null),
			}) as unknown as AgentDetector,
		agentConfigsStore: fakeStore({
			configs: {},
		}) as unknown as SpawnHandlerDependencies['agentConfigsStore'],
		settingsStore: fakeStore({
			shellEnvVars: {},
		}) as unknown as SpawnHandlerDependencies['settingsStore'],
		sessionsStore: fakeStore(sessions) as unknown as SpawnHandlerDependencies['sessionsStore'],
		getMainWindow: () => window as unknown as ReturnType<SpawnHandlerDependencies['getMainWindow']>,
		safeSend: (channel, ...args) => {
			sent.push([channel, ...args]);
		},
	};
	return { deps, processManager, spawn, sent, errors };
}

/**
 * The config the sink was handed. The renderer's `permissionMode` rides the
 * spread into it (the argument builder already acted on it) without being a
 * `ProcessConfig` field, so it is typed here for the ceiling assertions.
 */
type SpawnedConfig = ProcessConfig & { permissionMode?: string };

function spawned(h: Harness): SpawnedConfig {
	expect(h.spawn).toHaveBeenCalledOnce();
	return h.spawn.mock.calls[0][0] as SpawnedConfig;
}

function refusalSentToTab(h: Harness): string {
	const refusal = h.sent.find((m) => m[0] === 'process:data' && m[1] === PROCESS);
	expect(refusal).toBeDefined();
	return String(refusal?.[2]);
}

const denyProvider = (provider: string, reason: string) =>
	fakeSpawnPort({
		decide: (request) =>
			request.snapshot.provider === provider
				? { decision: 'deny', reason, policyRevision: 1, code: 'policy-denied' }
				: { decision: 'allow', policyRevision: 1 },
	});

describe('process:spawn under management: admission and classification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('admits an in-process spawn as a conversation at the desktop and hands the spawner the admission the manager minted', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const result = await handleProcessSpawn(payload(), h.deps);
		expect(result.success).toBe(true);
		expect(port.asked).toHaveLength(1);
		expect(port.asked[0].snapshot).toMatchObject({
			purpose: 'conversation',
			origin: 'desktop',
			provider: 'codex',
			operation: 'start',
		});
		const admitted = spawned(h);
		expect(admitted.purpose).toBe('conversation');
		expect(admitted.origin).toBe('desktop');
		// The admission on the config is a lease the real authority holds live,
		// for this policy generation and this request: not a look-alike.
		expect(admitted.admission).toBeDefined();
		const live = port.authority.live();
		expect(live).toHaveLength(1);
		expect(live[0].leaseId).toBe(admitted.admission?.leaseId);
		expect(admitted.admission?.authorityId).toBe(live[0].authorityId);
		expect(admitted.admission?.policyRevision).toBe(1);
		expect(admitted.admission?.provider).toBe('codex');
		expect('dispatchTicket' in admitted).toBe(false);
	});

	it('admits a ticketed maestro-cli dispatch with origin cli, host-authoritative, and strips the ticket from the process', async () => {
		const port = fakeSpawnPort();
		const h = harness(port);
		const ticket = runAsClient({ cli: true }, () =>
			issueDispatchTicket(getActingTransport(), { agentId: AGENT, tabId: TAB })
		);
		const result = await handleProcessSpawn(payload({ dispatchTicket: ticket }), h.deps);
		expect(result.success).toBe(true);
		expect(port.asked[0].snapshot).toMatchObject({ purpose: 'conversation', origin: 'cli' });
		const admitted = spawned(h);
		expect(admitted.origin).toBe('cli');
		expect(admitted.purpose).toBe('conversation');
		expect('dispatchTicket' in admitted).toBe(false);
	});

	it('a spawn the policy refuses never reaches the spawner: the handler fails with the reason and no lease is left live', async () => {
		const port = denyProvider('codex', 'codex is not an approved provider on this host');
		const h = harness(port);
		await expect(handleProcessSpawn(payload(), h.deps)).rejects.toThrow(
			/codex is not an approved provider/
		);
		expect(port.asked).toHaveLength(1);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.authority.live()).toHaveLength(0);
		// Reported into the tab as an agent error, since no process exists to.
		expect(h.errors).toEqual([[PROCESS, expect.stringMatching(/not an approved provider/)]]);
	});
});

describe('process:spawn under management: the sink spawns nothing without an admission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses a launch that carries no admission on a managed host before any spawner runs', () => {
		const port = fakeSpawnPort();
		const h = harness(port, { spySpawn: false });
		const config: ProcessConfig = {
			sessionId: PROCESS,
			toolType: 'codex',
			cwd: os.tmpdir(),
			command: '/usr/local/bin/codex',
			args: [],
			prompt: 'List the files.',
		};
		const result = h.processManager.spawn(config);
		expect(result.success).toBe(false);
		expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
		expect(result.error).toMatch(/carries no admission/);
		expect(port.asked).toHaveLength(0);
		expect(h.errors).toEqual([[PROCESS, expect.stringMatching(/carries no admission/)]]);
	});

	it('refuses an admission this manager did not mint (a look-alike) as forged', () => {
		const port = fakeSpawnPort();
		const h = harness(port, { spySpawn: false });
		const result = h.processManager.spawn({
			sessionId: PROCESS,
			toolType: 'codex',
			cwd: os.tmpdir(),
			command: '/usr/local/bin/codex',
			args: [],
			prompt: 'List the files.',
			admission: fakeAdmission({ provider: 'codex' }),
		});
		expect(result.success).toBe(false);
		expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
		expect(result.error).toMatch(/this host did not mint/);
	});

	it('refuses an admission whose request changed after it was minted (the digest no longer matches)', async () => {
		const port = fakeSpawnPort();
		const h = harness(port, { spySpawn: false });
		const config: ProcessConfig = {
			sessionId: PROCESS,
			toolType: 'codex',
			cwd: os.tmpdir(),
			command: '/usr/local/bin/codex',
			args: ['--one'],
			prompt: 'List the files.',
		};
		const outcome = await h.processManager.admitSpawn(config, { peer: 'in-process' });
		expect(outcome.state).toBe('admitted');
		if (outcome.state !== 'admitted') return;
		const result = h.processManager.spawn({
			...config,
			args: ['--another'],
			admission: outcome.admission,
		});
		expect(result.success).toBe(false);
		expect(result.managed).toEqual({ state: 'denied', code: 'lease-invalid' });
		expect(result.error).toMatch(/the lease for this launch is/);
	});
});

describe('process:spawn under management: the permission-mode ceiling', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('refuses a full-access request under a ceiling pinning standard, before the launch plan and the sink, never lowering it', async () => {
		const port = fakeSpawnPort();
		const asked: string[] = [];
		port.permissionCeiling = (providerId: string) => {
			asked.push(providerId);
			return { permissionMode: 'standard' };
		};
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(asked).toEqual(['codex']);
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
		const refusal = refusalSentToTab(h);
		expect(refusal).toContain('Permission mode "full" is unavailable under management');
		expect(refusal).toContain('allows at most "standard"');
		expect(refusal).toContain('does not lower a request');
	});

	it('counts the legacy yolo boolean as a full request under the same ceiling', async () => {
		const port = fakeSpawnPort();
		port.permissionCeiling = () => ({ permissionMode: 'standard' });
		const h = harness(port);
		const result = await handleProcessSpawn(
			payload({ permissionMode: undefined, yoloMode: true }),
			h.deps
		);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(h.spawn).not.toHaveBeenCalled();
		expect(refusalSentToTab(h)).toContain('Permission mode "full"');
	});

	it('admits a request within the ceiling with its mode untouched', async () => {
		const port = fakeSpawnPort();
		port.permissionCeiling = () => ({ permissionMode: 'standard' });
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'readonly' }), h.deps);
		expect(result.success).toBe(true);
		expect(port.asked).toHaveLength(1);
		expect(spawned(h).permissionMode).toBe('readonly');
	});

	it('admits a full request as before when the port composes no ceiling producer', async () => {
		const port = fakeSpawnPort();
		expect(port.permissionCeiling).toBeUndefined();
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result.success).toBe(true);
		expect(port.asked).toHaveLength(1);
		expect(spawned(h).permissionMode).toBe('full');
	});

	it('forbids nothing under a ceiling that pins no mode', async () => {
		const port = fakeSpawnPort();
		port.permissionCeiling = () => ({ permissionMode: null });
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result.success).toBe(true);
		expect(spawned(h).permissionMode).toBe('full');
	});

	it('never consults the ceiling for a terminal, which asks for no mode', async () => {
		const port = fakeSpawnPort();
		const consulted = vi.fn(() => ({ permissionMode: 'readonly' as const }));
		port.permissionCeiling = consulted;
		const h = harness(port);
		const result = await handleProcessSpawn(
			{
				sessionId: `${AGENT}-terminal-1`,
				toolType: 'terminal',
				cwd: os.tmpdir(),
				command: '/bin/zsh',
				args: [],
			},
			h.deps
		);
		expect(consulted).not.toHaveBeenCalled();
		expect(result.success).toBe(true);
	});
});

/**
 * MRC2-03-03A: the launch plan is handed the mode the turn asks for and the
 * route the port lends (`routeCeiling`), measures both against the ceiling,
 * and its decision (`plan.permission`) rides the config to the sink,
 * host-authoritative. A port lending no route plans unmanaged, as before.
 */
describe("process:spawn under management: the plan's permission decision rides to the sink", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	const route = (permissionMode: 'readonly' | 'standard' | 'full' | null) => ({
		providerId: 'codex',
		model: null,
		baseUrl: null,
		accountDir: null,
		login: 'provider-login' as const,
		permissionMode,
	});

	it('hands the plan the lent route and refuses a full request above its ceiling by name, before admission and the sink', async () => {
		const port = fakeSpawnPort();
		const asked: string[] = [];
		port.routeCeiling = (providerId: string) => {
			asked.push(providerId);
			return route('standard');
		};
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(asked).toEqual(['codex']);
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
		const refusal = refusalSentToTab(h);
		expect(refusal).toContain('permission mode "full" asks for more than the policy\'s ceiling');
		expect(refusal).toContain('allows at most "standard" for codex');
	});

	it('stamps the plan decision on the config the sink is handed for a request within the ceiling', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => route('standard');
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'readonly' }), h.deps);
		expect(result).toEqual({ pid: 4242, success: true });
		expect(port.asked).toHaveLength(1);
		const config = spawned(h);
		expect(config.permission).toEqual({ requested: 'readonly', ceiling: 'standard' });
		expect(config.args).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
		expect(config.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
		expect(config.admission).toBeDefined();
	});

	it("refuses a standard Codex request under a standard ceiling by the bypass flag the desktop's batch arguments carry, naming the flag", async () => {
		// Codex's batch arguments add `--dangerously-bypass-approvals-and-sandbox`
		// in every mode but read-only, so on the desktop a "standard" Codex turn
		// asks for full access on its command line; the plan's flag check holds
		// it to the ceiling by name rather than trusting the mode's label.
		const port = fakeSpawnPort();
		port.routeCeiling = () => route('standard');
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'standard' }), h.deps);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(port.asked).toHaveLength(0);
		expect(h.spawn).not.toHaveBeenCalled();
		const refusal = refusalSentToTab(h);
		expect(refusal).toContain('The launch arguments route around the policy');
		expect(refusal).toContain(
			'--dangerously-bypass-approvals-and-sandbox asks for full access but the policy\'s ceiling allows at most "standard" for codex'
		);
	});

	it('names no ceiling when the lent route pins no mode, and runs the full request as asked', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => route(null);
		const h = harness(port);
		await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		const config = spawned(h);
		expect(config.permission).toEqual({ requested: 'full', ceiling: null });
		expect(config.args).toContain('--dangerously-bypass-approvals-and-sandbox');
	});

	it('plans unmanaged when the port lends no route, the decision still stamped and naming no ceiling', async () => {
		const port = fakeSpawnPort();
		expect(port.routeCeiling).toBeUndefined();
		const h = harness(port);
		await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(spawned(h).permission).toEqual({ requested: 'full', ceiling: null });
	});

	it('never asks a standalone port for a route, and a decision the renderer sends is replaced by the plan', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const consulted = vi.fn(() => route('standard'));
		port.routeCeiling = consulted;
		const h = harness(port);
		const forged = { permission: { requested: 'readonly', ceiling: 'readonly' } };
		await handleProcessSpawn(
			{ ...payload({ permissionMode: 'full' }), ...forged } as SpawnProcessConfig,
			h.deps
		);
		expect(consulted).not.toHaveBeenCalled();
		expect(spawned(h).permission).toEqual({ requested: 'full', ceiling: null });
	});
});

describe('process:spawn on a standalone host: unchanged', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('a standalone port never consults the ceiling, asks no admission and binds none, still classifying the spawn', async () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const consulted = vi.fn(() => ({ permissionMode: 'readonly' as const }));
		port.permissionCeiling = consulted;
		const h = harness(port);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result.success).toBe(true);
		expect(consulted).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		const admitted = spawned(h);
		expect(admitted.purpose).toBe('conversation');
		expect(admitted.origin).toBe('desktop');
		expect(admitted.permissionMode).toBe('full');
		expect(admitted.admission).toBeUndefined();
	});

	it('a bare manager with no authority spawns as before, still classified', async () => {
		const h = harness(null);
		const result = await handleProcessSpawn(payload({ permissionMode: 'full' }), h.deps);
		expect(result.success).toBe(true);
		const admitted = spawned(h);
		expect(admitted).toMatchObject({ purpose: 'conversation', origin: 'desktop' });
		expect(admitted.admission).toBeUndefined();
	});
});
