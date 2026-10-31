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
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Keep launch/account logic real without initializing the desktop's stores.
vi.mock('../../../../../main/stores', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../main/stores')>()),
	getProductionDataPath: () => path.resolve('tmp', 'grok-managed-spawn', 'data'),
}));
vi.mock('../../../../../main/utils/remote-fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../main/utils/remote-fs')>()),
	observePathRemote: vi.fn(async () => {
		throw new Error('Unexpected remote observation without a synthetic fixture');
	}),
}));

import * as platform from '../../../../../shared/platformDetection';
import { resolveAgentAccountRef } from '../../../../../shared/agentAccountDir';
import type { NativeSessionBinding } from '../../../../../shared/maestro-lib/agents/providerSwap';
import { installationIdentity } from '../../../../../shared/maestro-lib/managed/host-adapter';
import type { SshRemoteConfig } from '../../../../../shared/types';
import { getProductionDataPath } from '../../../../../main/stores';
import {
	observePathRemote,
	type RemoteGrokLaunchIdentity,
} from '../../../../../main/utils/remote-fs';
import * as sshPath from '../../../../../shared/maestro-lib/launch/ssh-path';
import * as sshBuilder from '../../../../../main/utils/ssh-command-builder';
import * as systemDelivery from '../../../../../main/utils/system-prompt-delivery';
import { embedSystemPromptInPrompt } from '../../../../../shared/embeddedSystemPrompt';
import { isolateAgentEnv } from '../../../../helpers/agentEnvIsolation';
import * as agentArgs from '../../../../../main/utils/agent-args';
import * as launchPlan from '../../../../../shared/maestro-lib/launch/launch-plan';
import * as promptDelivery from '../../../../../shared/maestro-lib/launch/prompt-delivery';
import { resolveSshLaunchTarget } from '../../../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { logger } from '../../../../../main/utils/logger';
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
// Existing directories supply real local identity without any native account reads.
const GROK_ACCOUNT = path.resolve('src', '__tests__', 'fixtures');

beforeEach(() => {
	vi.mocked(observePathRemote)
		.mockReset()
		.mockRejectedValue(new Error('Unexpected remote observation without a synthetic fixture'));
});

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
function harness(
	port: FakeSpawnPort | null,
	options: { spySpawn?: boolean; provider?: 'codex' | 'grok' } = {}
): Harness {
	const provider = options.provider ?? 'codex';
	const definition = getAgentDefinition(provider);
	if (!definition) throw new Error(`no ${provider} definition`);
	const agent = {
		...definition,
		available: true,
		path: `/usr/local/bin/${provider}`,
		capabilities: getAgentCapabilities(provider),
	};
	const sessions = {
		sessions: [
			{ id: AGENT, name: 'Backend', toolType: provider, cwd: os.tmpdir(), aiTabs: [{ id: TAB }] },
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
				getAgent: async (id: string) => (id === provider ? agent : null),
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

/** Seed only explicit resume controls; missing-owner tests keep their empty tabs. */
function seedGrokLaunch(h: Harness, request: SpawnProcessConfig, remote?: SshRemoteConfig) {
	const account = request.sessionCustomEnvVars?.GROK_HOME;
	if (!account) throw new Error('Expected an explicit synthetic Grok account');
	const identity = remote
		? 'synthetic-grok-installation'
		: installationIdentity({
				hostname: os.hostname(),
				productionDataDir: getProductionDataPath(),
				mode: 'desktop',
				pid: process.pid,
				startedAt: '',
			}).installationId;
	if (remote) {
		const directory = {
			canonicalPath: request.cwd,
			kind: 'directory' as const,
			device: '1',
			inode: '2',
		};
		const receipt: RemoteGrokLaunchIdentity = {
			launchCwd: { ...directory },
			processCwd: { ...directory },
			cwd: { ...directory },
			account: { ...directory, canonicalPath: account, inode: '3' },
			inherited: { HOME: '/home/synthetic', GROK_HOME: null },
			effective: { HOME: '/home/synthetic', GROK_HOME: account },
		};
		vi.mocked(observePathRemote).mockImplementation(async (cwd, target, deps, launch) => {
			expect(cwd).toBe(request.cwd);
			expect(target).toEqual(remote);
			expect(deps).toBeUndefined();
			expect(launch).toMatchObject({ env: { GROK_HOME: account }, nativeCwd: request.cwd });
			return { success: true, data: structuredClone(receipt) };
		});
		h.deps.remoteQualifier = () => ({
			probe: async () => {
				throw new Error('Unexpected endpoint probe');
			},
			qualify: async () => {
				throw new Error('Unexpected managed SSH qualification');
			},
			qualifyResolved: async (selected) => {
				expect(selected).toEqual(remote);
				return {
					kind: 'remote',
					remote: selected,
					endpoint: {
						contractVersion: '1',
						installationId: identity,
						runtimeId: 'synthetic-runtime',
						processEpoch: 'synthetic-epoch',
						tenantId: 'fixture',
						orgId: 'fixture',
						authorityId: 'fixture',
						policyRevision: 1,
						authority: 'registered',
						routes: [],
					},
				};
			},
		});
	}
	if (!request.agentSessionId) return undefined;
	const binding: NativeSessionBinding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: request.agentSessionId,
		cwd: remote ? request.cwd : realpathSync(request.cwd),
		accountRef: resolveAgentAccountRef(
			{
				toolType: 'grok',
				sshRemote: !!remote,
				managedAccountDir: remote ? account : realpathSync(account),
			},
			{ homeDir: '' }
		)!,
		host: { kind: remote ? 'ssh' : 'local', identity },
	};
	h.deps.sessionsStore.set('sessions', [
		{
			id: AGENT,
			name: 'Backend',
			toolType: 'grok',
			cwd: request.cwd,
			customEnvVars: { ...request.sessionCustomEnvVars },
			sessionSshRemoteConfig: request.sessionSshRemoteConfig,
			aiTabs: [
				{
					id: TAB,
					turnProvider: 'grok',
					agentSessionId: request.agentSessionId,
					nativeSessionBinding: binding,
				},
			],
		},
	]);
	return binding;
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

describe('process:spawn launch refusal classification', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		{ target: 'local', selection: 'effort' },
		{ target: 'remote', selection: 'effort' },
		{ target: 'local', selection: 'model' },
		{ target: 'remote', selection: 'model' },
	])(
		'reports $target Grok $selection refusal without an SSH label or retry',
		async ({ target, selection }) => {
			const port = fakeSpawnPort();
			const h = harness(port, { provider: 'grok' });
			const definition = getAgentDefinition('grok')!;
			const remote = {
				id: 'remote-grok',
				name: 'Grok host',
				host: 'grok.example.test',
				enabled: true,
				port: 22,
				username: 'synthetic',
				privateKeyPath: '',
			};
			h.deps.settingsStore.set('sshRemotes', [remote]);
			const sshRemoteConfig =
				target === 'remote' ? { enabled: true, remoteId: remote.id } : undefined;
			const args = [
				...definition.args,
				'-m',
				'grok-selected',
				'--reasoning-effort',
				selection === 'effort' ? 'none' : 'high',
				...(selection === 'model' ? ['--model', 'grok-other'] : []),
			];
			const diagnostic =
				selection === 'effort'
					? 'Grok effort "none" requires verified support for the selected model.'
					: 'Conflicting Grok model selections. Configure one value across settings and custom arguments.';
			// Ordinary config composition rejects these values even earlier. Inject
			// final argv at that boundary to exercise the REAL planner's refusal and
			// this consumer's reporting, without manufacturing a planner result.
			const compose = vi.spyOn(agentArgs, 'applyAgentConfigOverrides').mockReturnValue({
				args,
				effectiveCustomEnvVars: undefined,
				modelSource: 'session',
				customArgsSource: 'session',
				customEnvSource: 'none',
			});
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			const result = await handleProcessSpawn(
				payload({
					toolType: 'grok',
					command: definition.command,
					args: [...definition.args],
					sessionCustomModel: 'grok-selected',
					sessionCustomEffort: selection === 'effort' ? 'none' : 'high',
					sessionSshRemoteConfig: sshRemoteConfig,
				}),
				h.deps
			);

			expect(result).toEqual({ success: false, pid: 0 });
			expect(compose).toHaveBeenCalledOnce();
			expect(plan).toHaveBeenCalledOnce();
			const input = plan.mock.calls[0][0];
			expect(input.args).toEqual(args);
			expect(resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig)).toEqual(
				target === 'remote' ? { kind: 'remote', remote } : { kind: 'local' }
			);
			expect(plan.mock.results[0].value).toEqual({
				ok: false,
				reason: 'grok-model-effort-refused',
				error: diagnostic,
			});
			expect(h.sent).toEqual([['process:data', PROCESS, `\r\n[Maestro] ${diagnostic}\r\n`]]);
			expect(h.errors).toEqual([]);
			expect(logger.error).toHaveBeenCalledExactlyOnceWith(
				'Grok model/effort selection refused; not spawning',
				'[ProcessManager]',
				{ sessionId: PROCESS, toolType: 'grok', reason: 'grok-model-effort-refused' }
			);
			expect(h.spawn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
		}
	);

	it('retains the genuine unresolved-SSH diagnostic and log classification', async () => {
		const port = fakeSpawnPort();
		const h = harness(port, { provider: 'grok' });
		const definition = getAgentDefinition('grok')!;
		const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
		const result = await handleProcessSpawn(
			payload({
				toolType: 'grok',
				command: definition.command,
				args: [...definition.args],
				sessionSshRemoteConfig: { enabled: true, remoteId: 'removed-remote' },
			}),
			h.deps
		);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(plan).toHaveBeenCalledOnce();
		const refusal = plan.mock.results[0].value;
		if (refusal.ok) throw new Error('Expected unresolved SSH refusal');
		expect(refusal).toMatchObject({ ok: false, reason: 'remote-not-found' });
		expect(refusalSentToTab(h)).toBe(`\r\n[Maestro] ${refusal.error}\r\n`);
		expect(logger.error).toHaveBeenCalledExactlyOnceWith(
			'SSH remote could not be resolved; not spawning',
			'[ProcessManager]',
			{ sessionId: PROCESS, remoteId: 'removed-remote', reason: 'remote-not-found' }
		);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		expect(port.authority.live()).toHaveLength(0);
	});

	it('retains managed launch refusal classification before a Grok selection is dispatched', async () => {
		const port = fakeSpawnPort();
		port.routeCeiling = () => ({
			providerId: 'codex',
			model: null,
			baseUrl: null,
			accountDir: null,
			login: 'provider-login',
			permissionMode: null,
		});
		const h = harness(port, { provider: 'grok' });
		const definition = getAgentDefinition('grok')!;
		const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
		const result = await handleProcessSpawn(
			payload({
				toolType: 'grok',
				command: definition.command,
				args: [...definition.args],
				sessionCustomModel: 'grok-selected',
				sessionCustomEffort: 'high',
			}),
			h.deps
		);
		expect(result).toEqual({ success: false, pid: 0 });
		expect(plan).toHaveBeenCalledOnce();
		expect(refusalSentToTab(h)).toBe(
			'\r\n[Maestro] The policy routes this launch to codex, not grok.\r\n'
		);
		expect(logger.error).toHaveBeenCalledExactlyOnceWith(
			'Managed launch plan refused the spawn; not spawning',
			'[ProcessManager]',
			{ sessionId: PROCESS, toolType: 'grok', reason: 'managed-route-refused' }
		);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(0);
		expect(port.authority.live()).toHaveLength(0);
	});
});

describe('process:spawn private prompt-file planning (GT1-02-10ET)', () => {
	isolateAgentEnv();
	isolateAgentEnv(['GROK_HOME', 'GROK_AUTH', 'GROK_AUTH_PATH']);
	let h: Harness;
	let port: FakeSpawnPort;
	let request: SpawnProcessConfig;
	const remote = {
		id: 'remote-file',
		name: 'Synthetic file host',
		host: 'file.example.test',
		enabled: true,
		port: 22,
		username: 'synthetic',
		privateKeyPath: '',
	};
	const legacyPrompt = vi.fn(() => ['-p', 'legacy prompt']);
	const legacyImages = vi.fn(() => ['--image', 'legacy image']);
	const legacyEmbed = vi.fn(() => 'legacy embedded image');

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(sshPath, 'resolveSshPath').mockResolvedValue('ssh');
		port = denyProvider('grok', 'Synthetic file policy denial');
		port.setStanding('standalone');
		h = harness(port, { provider: 'grok' });
		const detector = h.deps.getAgentDetector()!;
		const agent = (await detector.getAgent('grok'))!;
		// Opt in only this fixture; the production Grok route remains withheld.
		h.deps.getAgentDetector = () => detector;
		vi.spyOn(detector, 'getAgent').mockResolvedValue({
			...agent,
			promptFile: {
				format: 'acp-json',
				exclusivePromptFlags: ['-p', '--prompt-file', '--prompt-json'],
			},
			promptFileArgs: (file) => ['--prompt-file', file],
			promptArgs: legacyPrompt,
			imageArgs: legacyImages,
			imagePromptBuilder: legacyEmbed,
		});
		h.deps.settingsStore.set('sshRemotes', [remote]);
		request = payload({
			toolType: 'grok',
			command: agent.command,
			args: [...agent.args],
			sessionCustomEnvVars: { GROK_HOME: GROK_ACCOUNT },
		});
	});

	afterEach(() => vi.restoreAllMocks());

	it.each(
		['local', 'remote'].flatMap((host) => [
			{ host, label: 'empty', prompt: '', system: undefined, resume: undefined },
			{
				host,
				label: 'composed Unicode',
				prompt: '私密 🪶\n"quoted"\n',
				system: 'System fixture',
				resume: undefined,
			},
			{
				host,
				label: 'large',
				prompt: 'large-file-only '.repeat(5000),
				system: undefined,
				resume: undefined,
			},
			{
				host,
				label: 'resume',
				prompt: 'resume-file-only',
				system: 'Already delivered',
				resume: 'native-session',
			},
		])
	)(
		'keeps one $host artifact for $label through both plans and the sink',
		async ({ host, prompt, system, resume }) => {
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			const ssh = vi.spyOn(sshBuilder, 'buildSshCommandWithStdin');
			request = {
				...request,
				cwd: host === 'remote' ? '/srv/synthetic-project' : os.tmpdir(),
				prompt,
				appendSystemPrompt: system,
				agentSessionId: resume,
				sessionCustomEnvVars: {
					GROK_HOME: host === 'remote' ? '/synthetic/selected-account' : GROK_ACCOUNT,
				},
				sessionSshRemoteConfig:
					host === 'remote' ? { enabled: true, remoteId: remote.id } : undefined,
			};
			const binding = seedGrokLaunch(h, request, host === 'remote' ? remote : undefined);
			expect(await handleProcessSpawn(request, h.deps)).toMatchObject({ success: true });
			expect(plan).toHaveBeenCalledTimes(2);
			const early = plan.mock.results[0].value;
			const final = plan.mock.results[1].value;
			if (!early.ok || early.plan.prompt.via !== 'file' || !final.ok)
				throw new Error('Expected file plans');
			const artifact = early.plan.prompt.artifact;
			expect(plan.mock.calls[1][0].promptFileDestination).toEqual(artifact);
			expect(final.plan.prompt).toEqual(early.plan.prompt);
			expect(artifact.content).toBe(
				JSON.stringify({
					type: 'acp',
					content: [
						{
							type: 'text',
							text: system && !resume ? embedSystemPromptInPrompt(system, prompt) : prompt,
						},
					],
				})
			);
			expect(artifact.owner).toBe(host);
			const config = spawned(h);
			if (resume) {
				expect(config.nativeSessionBinding).toEqual(binding);
				expect({ ...config.nativeSessionScope, nativeSessionId: config.agentSessionId }).toEqual(
					binding
				);
			}
			if (host === 'remote') expect(observePathRemote).toHaveBeenCalledTimes(2);
			expect(config.promptArtifact).toEqual(artifact);
			expect(config).toMatchObject({
				prompt: undefined,
				images: undefined,
				sendPromptViaStdin: false,
				sendPromptViaStdinRaw: false,
				promptArgs: undefined,
				imageArgs: undefined,
				imagePromptBuilder: undefined,
			});
			expect(config).not.toHaveProperty('appendSystemPrompt');
			expect(final.plan.args.filter((arg: string) => arg === '--prompt-file')).toHaveLength(1);
			expect(final.plan.args.slice(-2)).toEqual(['--prompt-file', artifact.path]);
			expect(final.plan.args).not.toContain('-p');
			expect(final.plan.args).toContain('--always-approve');
			if (host === 'remote') {
				expect(artifact.sshRemoteId).toBe(remote.id);
				expect(artifact.path).toMatch(/^\/tmp\/maestro-prompt-[\w-]+\.json$/);
				expect(config).toMatchObject({ command: 'ssh', cwd: os.homedir(), sshRemoteId: remote.id });
				expect(ssh).toHaveBeenCalledOnce();
				expect(ssh.mock.calls[0][0]).toEqual(remote);
				expect(ssh.mock.calls[0][1]).toMatchObject({
					cwd: '/srv/synthetic-project',
					promptArtifact: artifact,
					stdinInput: undefined,
					images: undefined,
					imageArgs: undefined,
					imagePromptBuilder: undefined,
				});
				expect(config.sshStdinScript).toContain(Buffer.from(artifact.content).toString('base64'));
				expect(config.sshRemoteCommand).not.toContain(artifact.path);
			} else {
				expect(artifact.sshRemoteId).toBeUndefined();
				expect(path.dirname(artifact.path)).toBe(os.tmpdir());
				expect(config.args).toEqual(final.plan.args);
				expect(config.sshStdinScript).toBeUndefined();
				expect(ssh).not.toHaveBeenCalled();
			}
			for (const legacy of [legacyPrompt, legacyImages, legacyEmbed])
				expect(legacy).not.toHaveBeenCalled();
			const diagnostics = JSON.stringify([
				h.sent,
				vi.mocked(logger.debug).mock.calls,
				vi.mocked(logger.info).mock.calls,
				vi.mocked(logger.error).mock.calls,
			]);
			expect(diagnostics).not.toContain(artifact.path);
			if (prompt) expect(diagnostics).not.toContain(prompt.split(/\s/)[0]);
		}
	);

	it.each(['local', 'remote'])(
		'refuses %s images without host-owned blocks before planning a text-only fallback',
		async (host) => {
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			request.images = ['data:image/png;base64,c3ludGhldGlj'];
			request.sessionSshRemoteConfig =
				host === 'remote' ? { enabled: true, remoteId: remote.id } : undefined;
			expect(await handleProcessSpawn(request, h.deps)).toEqual({ success: false, pid: 0 });
			expect(plan).toHaveBeenCalledOnce();
			expect(plan.mock.calls[0][0].hasImages).toBe(true);
			expect(plan.mock.results[0].value).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				error: 'Image content is missing from the ACP prompt file.',
			});
			expect(h.sent).toEqual([
				[
					'process:data',
					PROCESS,
					'\r\n[Maestro] Image content is missing from the ACP prompt file.\r\n',
				],
			]);
			expect(logger.error).toHaveBeenCalledExactlyOnceWith(
				'Prompt delivery refused; not spawning',
				'[ProcessManager]',
				{ sessionId: PROCESS, toolType: 'grok', reason: 'prompt-delivery-refused' }
			);
			expect(h.errors).toEqual([]);
			expect(h.spawn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
			for (const legacy of [legacyPrompt, legacyImages, legacyEmbed])
				expect(legacy).not.toHaveBeenCalled();
		}
	);

	it.each(
		['local', 'remote'].flatMap((host) =>
			['--prompt-file private-source', '--prompt-json=private-source', '-pprivate-source'].map(
				(source) => ({ host, source })
			)
		)
	)(
		'reports $host competing source $source as prompt delivery without preparation or retry (GT1-02-10AT)',
		async ({ host, source }) => {
			request.prompt = 'private-prompt-body-AT\n私密 "quoted"';
			request.appendSystemPrompt = 'private-system-body-AT';
			request.sessionCustomArgs = source;
			request.sessionSshRemoteConfig =
				host === 'remote' ? { enabled: true, remoteId: remote.id } : undefined;
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			const destination = vi.spyOn(promptDelivery, 'selectPromptFileDestination');
			const prepareSystem = vi.spyOn(systemDelivery, 'applySystemPromptDelivery');
			const ssh = vi.spyOn(sshBuilder, 'buildSshCommandWithStdin');
			const diagnostic =
				'Prompt-file delivery conflicts with another prompt source in the launch arguments.';

			const result = await handleProcessSpawn(request, h.deps);
			expect(result).toEqual({ success: false, pid: 0 });
			expect(plan).toHaveBeenCalledOnce();
			const input = plan.mock.calls[0][0];
			expect(input.prompt).toBe(
				embedSystemPromptInPrompt(request.appendSystemPrompt, request.prompt)
			);
			expect(resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig)).toEqual(
				host === 'remote' ? { kind: 'remote', remote } : { kind: 'local' }
			);
			expect(plan.mock.results[0].value).toEqual({
				ok: false,
				reason: 'prompt-delivery-refused',
				error: diagnostic,
			});
			expect(destination).toHaveBeenCalledOnce();
			const selected = destination.mock.results[0].value;
			if (!selected) throw new Error('Expected a selected destination before refusal');
			expect(selected.owner).toBe(host);
			expect(selected.sshRemoteId).toBe(host === 'remote' ? remote.id : undefined);
			expect(h.sent).toEqual([['process:data', PROCESS, `\r\n[Maestro] ${diagnostic}\r\n`]]);
			expect(h.errors).toEqual([]);
			expect(logger.error).toHaveBeenCalledExactlyOnceWith(
				'Prompt delivery refused; not spawning',
				'[ProcessManager]',
				{ sessionId: PROCESS, toolType: 'grok', reason: 'prompt-delivery-refused' }
			);
			// The early refusal owns no files: even system-prompt/SSH preparation
			// is unreachable, as are admission, materialization and every retry.
			expect(prepareSystem).not.toHaveBeenCalled();
			expect(ssh).not.toHaveBeenCalled();
			expect(h.spawn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
			for (const legacy of [legacyPrompt, legacyImages, legacyEmbed])
				expect(legacy).not.toHaveBeenCalled();
			const diagnostics = JSON.stringify([
				result,
				h.sent,
				h.errors,
				...[logger.debug, logger.info, logger.warn, logger.error].map(
					(log) => vi.mocked(log).mock.calls
				),
			]);
			for (const privateValue of [
				request.prompt,
				'private-prompt-body-AT',
				request.appendSystemPrompt,
				'private-source',
				selected.path,
			]) {
				expect(diagnostics).not.toContain(privateValue);
				expect(diagnostics).not.toContain(JSON.stringify(privateValue).slice(1, -1));
			}
		}
	);

	it.each(['content', 'target'])(
		'refuses changed %s between early and final plans',
		async (change) => {
			const deliver = systemDelivery.applySystemPromptDelivery;
			vi.spyOn(systemDelivery, 'applySystemPromptDelivery').mockImplementation(async (input) => {
				const delivered = await deliver(input);
				if (change === 'target')
					h.deps.settingsStore.set('sshRemotes', [{ ...remote, host: 'replacement.example.test' }]);
				return change === 'content' ? { ...delivered, prompt: 'changed-private-body' } : delivered;
			});
			request.sessionSshRemoteConfig =
				change === 'target' ? { enabled: true, remoteId: remote.id } : undefined;
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			expect(await handleProcessSpawn(request, h.deps)).toEqual({ success: false, pid: 0 });
			expect(plan).toHaveBeenCalledTimes(2);
			expect(refusalSentToTab(h)).toBe(
				'\r\n[Maestro] Prompt-file content or target changed during launch preparation. Nothing was started.\r\n'
			);
			expect(h.spawn).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
		}
	);

	it('preserves managed final admission refusal and hides private exception details', async () => {
		port.setStanding('managed');
		await expect(handleProcessSpawn(request, h.deps)).rejects.toThrow(
			'Private prompt-file launch failed.'
		);
		expect(h.spawn).not.toHaveBeenCalled();
		expect(port.asked).toHaveLength(1);
		expect(port.authority.live()).toHaveLength(0);
		expect(h.errors).toEqual([[PROCESS, 'Synthetic file policy denial']]);
	});

	it('hides private spawn failure details without an argv retry', async () => {
		h.spawn.mockImplementation(() => {
			throw new Error('private path and body from failed sink');
		});
		await expect(handleProcessSpawn(request, h.deps)).rejects.toThrow(
			'Private prompt-file launch failed.'
		);
		expect(h.spawn).toHaveBeenCalledOnce();
		expect(JSON.stringify([h.sent, h.errors, vi.mocked(logger.error).mock.calls])).not.toContain(
			'private path and body'
		);
	});
});

describe('process:spawn Grok directory-grant refusal (GT1-02-11A1T)', () => {
	isolateAgentEnv();
	isolateAgentEnv(['GROK_HOME', 'GROK_AUTH', 'GROK_AUTH_PATH']);
	const definition = getAgentDefinition('grok')!;
	const remote = {
		id: 'grant-host',
		name: 'Grant host',
		host: 'grants.example.test',
		enabled: true,
		port: 22,
		username: 'synthetic',
		privateKeyPath: '',
	};
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(sshPath, 'resolveSshPath').mockResolvedValue('ssh');
	});
	afterEach(() => vi.restoreAllMocks());

	it.each(
		['local', 'remote'].flatMap((host) =>
			[false, true].flatMap((resume) =>
				['read', 'write', 'mixed', 'readonly-read', 'readonly-write', 'flag', 'flag-equals'].map(
					(kind) => ({ host, resume, kind })
				)
			)
		)
	)(
		'refuses $host resume=$resume $kind before preparation or admission',
		async ({ host, resume, kind }) => {
			const port = fakeSpawnPort();
			const h = harness(port, { provider: 'grok' });
			h.deps.settingsStore.set('sshRemotes', [remote]);
			const readonly = kind.includes('readonly');
			const root = '/private/grant root 私密';
			const grants = kind.startsWith('flag')
				? []
				: [
						{
							path: root,
							read: kind.endsWith('read') || kind === 'mixed',
							write: kind.endsWith('write'),
						},
						...(kind === 'mixed' ? [{ path: `${root}/second`, read: false, write: true }] : []),
					];
			const request = payload({
				toolType: 'grok',
				command: definition.command,
				args: [...definition.args],
				cwd: host === 'remote' ? '/srv/chosen-project' : os.tmpdir(),
				prompt: 'private-grant-prompt 私密',
				appendSystemPrompt: 'private-grant-system',
				agentSessionId: resume ? 'native-grant-session' : undefined,
				permissionMode: readonly ? 'readonly' : 'full',
				readOnlyMode: readonly,
				sessionAdditionalDirectories: grants,
				sessionCustomArgs:
					kind === 'flag'
						? `--add-dir "${root}"`
						: kind === 'flag-equals'
							? `--add-dir="${root}"`
							: undefined,
				sessionCustomEnvVars: {
					GROK_HOME: host === 'remote' ? '/synthetic/selected-account' : GROK_ACCOUNT,
				},
				sessionSshRemoteConfig:
					host === 'remote' ? { enabled: true, remoteId: remote.id } : undefined,
			});
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			const destination = vi.spyOn(promptDelivery, 'selectPromptFileDestination');
			const prepareSystem = vi.spyOn(systemDelivery, 'applySystemPromptDelivery');
			const ssh = vi.spyOn(sshBuilder, 'buildSshCommandWithStdin');
			seedGrokLaunch(h, request, host === 'remote' ? remote : undefined);
			const diagnostic = kind.startsWith('flag')
				? 'Grok CLI has no qualified --add-dir argument for additional-directory grants.'
				: readonly && kind.endsWith('write')
					? "Grok CLI writable directory grants exceed this launch's read-only mode."
					: 'Grok CLI additional-directory read and write grants have no qualified native mechanism. Remove the grants to run with the selected working directory.';
			expect(await handleProcessSpawn(request, h.deps)).toEqual({ success: false, pid: 0 });
			expect(plan).toHaveBeenCalledOnce();
			const input = plan.mock.calls[0][0];
			expect(input).toMatchObject({
				additionalDirectories: grants,
				cwd: request.cwd,
				sessionCustomEnvVars: request.sessionCustomEnvVars,
				readOnlyMode: readonly,
			});
			expect(input.args.includes('--resume')).toBe(resume);
			if (resume) expect(input.args).toContain('native-grant-session');
			expect(resolveSshLaunchTarget(input.sshStore, input.sshRemoteConfig)).toEqual(
				host === 'remote' ? { kind: 'remote', remote } : { kind: 'local' }
			);
			expect(plan.mock.results[0].value).toEqual({
				ok: false,
				reason: 'grok-directory-grants-refused',
				error: diagnostic,
			});
			expect(h.sent).toEqual([['process:data', PROCESS, `\r\n[Maestro] ${diagnostic}\r\n`]]);
			expect(logger.error).toHaveBeenCalledExactlyOnceWith(
				'Grok directory-grant configuration refused; not spawning',
				'[ProcessManager]',
				{ sessionId: PROCESS, toolType: 'grok', reason: 'grok-directory-grants-refused' }
			);
			expect(h.errors).toEqual([]);
			expect(observePathRemote).not.toHaveBeenCalled();
			for (const boundary of [destination, prepareSystem, ssh, h.spawn])
				expect(boundary).not.toHaveBeenCalled();
			expect(port.asked).toHaveLength(0);
			expect(port.authority.live()).toHaveLength(0);
			const diagnostics = JSON.stringify([
				h.sent,
				h.errors,
				...[logger.debug, logger.info, logger.warn, logger.error].map(
					(log) => vi.mocked(log).mock.calls
				),
			]);
			for (const value of [root, request.prompt!, request.appendSystemPrompt!]) {
				expect(diagnostics).not.toContain(value);
				expect(diagnostics).not.toContain(JSON.stringify(value).slice(1, -1));
			}
		}
	);

	it.each(
		['local', 'remote'].flatMap((host) =>
			[false, true].flatMap((resume) => ['empty', 'inert'].map((kind) => ({ host, resume, kind })))
		)
	)(
		'keeps $host resume=$resume $kind grants on the selected launch',
		async ({ host, resume, kind }) => {
			const h = harness(fakeSpawnPort({ standing: 'standalone' }), { provider: 'grok' });
			h.deps.settingsStore.set('sshRemotes', [remote]);
			const grants =
				kind === 'empty'
					? []
					: [
							{ path: ' ', read: true, write: true },
							{ path: '/disabled-root', read: true, write: true },
							{ path: '/disabled-root', read: false, write: false },
						];
			const request = payload({
				toolType: 'grok',
				command: definition.command,
				args: [...definition.args],
				cwd: host === 'remote' ? '/srv/chosen-project' : os.tmpdir(),
				agentSessionId: resume ? 'native-grant-session' : undefined,
				sessionAdditionalDirectories: grants,
				sessionCustomEnvVars: {
					GROK_HOME: host === 'remote' ? '/synthetic/selected-account' : GROK_ACCOUNT,
				},
				sessionSshRemoteConfig:
					host === 'remote' ? { enabled: true, remoteId: remote.id } : undefined,
			});
			const plan = vi.spyOn(launchPlan, 'buildAgentLaunchPlan');
			const binding = seedGrokLaunch(h, request, host === 'remote' ? remote : undefined);
			expect(await handleProcessSpawn(request, h.deps)).toMatchObject({ success: true });
			expect(plan).toHaveBeenCalledTimes(2);
			for (const [input] of plan.mock.calls) expect(input.additionalDirectories).toEqual(grants);
			const result = plan.mock.results[1].value;
			if (!result.ok) throw new Error('Expected a launch with inert grants');
			expect(result.plan.cwd).toBe(request.cwd);
			expect(result.plan.envVars?.GROK_HOME).toBe(request.sessionCustomEnvVars!.GROK_HOME);
			expect(result.plan.args).not.toContain('--add-dir');
			expect(result.plan.args.includes('--resume')).toBe(resume);
			if (resume) expect(result.plan.args).toContain('native-grant-session');
			expect(result.plan.target).toEqual(
				host === 'remote' ? { kind: 'remote', remote } : { kind: 'local' }
			);
			const config = spawned(h);
			expect(config.promptArtifact).toMatchObject({ owner: host });
			if (resume) {
				expect(config.nativeSessionBinding).toEqual(binding);
				expect({ ...config.nativeSessionScope, nativeSessionId: config.agentSessionId }).toEqual(
					binding
				);
			}
			if (host === 'remote') expect(observePathRemote).toHaveBeenCalledTimes(2);
			expect(h.errors).toEqual([]);
		}
	);
});

describe('process:spawn native request correlation (GT1-04-07E1PT)', () => {
	isolateAgentEnv(['GROK_HOME', 'GROK_AUTH', 'GROK_AUTH_PATH']);
	const definition = getAgentDefinition('grok')!;
	// Existing repository directories stand in for the selected account/project.
	// Only directory identity is observed; no provider files are opened or written.
	const cwd = path.resolve('src', '__tests__');
	const account = path.resolve('src', '__tests__', 'fixtures');
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
	});
	afterEach(() => vi.restoreAllMocks());

	it.each(['discovery', 'preparation', 'admission'])(
		'preserves the submitted token and launch scope when the caller mutates during %s',
		async (stage) => {
			const token = `Request_${'a'.repeat(120)}`;
			const request = payload({
				toolType: 'grok',
				command: definition.command,
				args: [...definition.args],
				cwd,
				nativeSessionRequestId: token,
				sessionCustomEnvVars: { GROK_HOME: account },
			});
			const mutate = () => {
				request.nativeSessionRequestId = 'replacement';
				request.agentSessionId = 'invented-native-id';
				request.cwd = path.join(cwd, 'wrong-project');
				request.sessionCustomEnvVars!.GROK_HOME = path.join(account, 'wrong-account');
				request.args.push('--resume', 'invented-native-id');
				request.tabId = 'replacement-tab';
				request.sessionSshRemoteConfig = { enabled: true, remoteId: 'wrong-host' };
			};
			const port = fakeSpawnPort({
				decide: async () => {
					if (stage === 'admission') mutate();
					return { decision: 'allow', policyRevision: 1 };
				},
			});
			const h = harness(port, { provider: 'grok' });
			if (stage === 'discovery') {
				const detector = h.deps.getAgentDetector()!;
				const getAgent = detector.getAgent.bind(detector);
				vi.spyOn(detector, 'getAgent').mockImplementation(async (id) => {
					mutate();
					return getAgent(id);
				});
				h.deps.getAgentDetector = () => detector;
			}
			if (stage === 'preparation') {
				const deliver = systemDelivery.applySystemPromptDelivery;
				vi.spyOn(systemDelivery, 'applySystemPromptDelivery').mockImplementation(async (input) => {
					mutate();
					return deliver(input);
				});
			}
			expect(await handleProcessSpawn(request, h.deps)).toMatchObject({ success: true });
			expect(request.nativeSessionRequestId).toBe('replacement');
			const config = spawned(h);
			expect(config).toMatchObject({
				nativeSessionRequestId: token,
				tabId: TAB,
				cwd,
				customEnvVars: { GROK_HOME: account },
				nativeSessionScope: {
					version: 1,
					state: 'bound',
					provider: 'grok',
					cwd: realpathSync(cwd),
					accountRef: resolveAgentAccountRef(
						{ toolType: 'grok', managedAccountDir: realpathSync(account) },
						{ homeDir: '' }
					),
					host: { kind: 'local', identity: expect.any(String) },
				},
			});
			expect(config.agentSessionId).toBeUndefined();
			expect(config.nativeSessionBinding).toBeUndefined();
			expect(config.sshRemoteId).toBeUndefined();
			expect(config.args).not.toContain('--resume');
			for (const value of [config.args, config.customEnvVars, config.shellEnvVars, port.asked])
				expect(JSON.stringify(value) ?? '').not.toContain(token);
			expect(port.asked).toHaveLength(1);
			expect(port.asked[0].snapshot).toMatchObject({ provider: 'grok', operation: 'start' });
			expect(port.authority.live()[0].leaseId).toBe(config.admission?.leaseId);
			// A spied sink never installed a process: the handler cannot invent its receipt.
			expect(h.processManager.nativeSessionLaunchOf(PROCESS)).toBeUndefined();
		}
	);

	it.each(['grok', 'codex'] as const)('keeps optional legacy omission for %s', async (provider) => {
		const agent = getAgentDefinition(provider)!;
		const h = harness(fakeSpawnPort(), { provider });
		expect(
			await handleProcessSpawn(
				payload({
					toolType: provider,
					command: agent.command,
					args: [...agent.args],
					cwd,
					sessionCustomEnvVars: { GROK_HOME: account },
				}),
				h.deps
			)
		).toMatchObject({ success: true });
		expect(spawned(h)).not.toHaveProperty('nativeSessionRequestId');
		expect(h.processManager.nativeSessionLaunchOf(PROCESS)).toBeUndefined();
	});

	it.each(['ownership', 'admission', 'sink'])(
		'cannot use a caller token to recover %s failure or manufacture a receipt',
		async (failure) => {
			const port =
				failure === 'admission'
					? denyProvider('grok', 'Synthetic correlation policy denial')
					: fakeSpawnPort();
			const h = harness(port, { provider: 'grok' });
			if (failure === 'sink')
				h.spawn.mockReturnValue({ pid: -1, success: false, error: 'Synthetic sink failure' });
			const run = handleProcessSpawn(
				payload({
					toolType: 'grok',
					command: definition.command,
					args: [...definition.args],
					cwd,
					nativeSessionRequestId: 'requested-native-id',
					agentSessionId: failure === 'ownership' ? 'requested-native-id' : undefined,
					sessionCustomEnvVars: { GROK_HOME: account },
				}),
				h.deps
			);
			if (failure === 'ownership') {
				expect(await run).toMatchObject({
					success: false,
					error: expect.stringContaining('no retained native ownership'),
				});
			} else {
				await expect(run).rejects.toThrow('Private prompt-file launch failed.');
				expect(port.asked).toHaveLength(1);
				if (failure === 'admission') expect(port.authority.live()).toHaveLength(0);
			}
			if (failure !== 'sink') expect(h.spawn).not.toHaveBeenCalled();
			else expect(h.spawn).toHaveBeenCalledOnce();
			if (failure === 'ownership') expect(port.asked).toHaveLength(0);
			expect(h.processManager.nativeSessionLaunchOf(PROCESS)).toBeUndefined();
		}
	);
});
