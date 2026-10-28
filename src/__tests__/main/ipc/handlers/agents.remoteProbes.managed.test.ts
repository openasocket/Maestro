/**
 * Agent SSH probes under the managed remote identity (MRC2-05-07A). The
 * `command -v` detection of every agent, the single-agent detection, the
 * `<binary> models` discovery, the OpenCode command and config reads, and the
 * `maestro-p --version` launch test all open an SSH session to a remote; here
 * each is held to the same remote identity a file command is (MRC2-05-07)
 * BEFORE any ssh command is built: a refused remote runs no ssh, the detection
 * answers every agent with the hold's line and a failed readiness snapshot,
 * a discovery is thrown by name (never an empty list), and the maestro-p
 * availability stays unknown (never a cached false). The authority is asked
 * once per detection, the holder records a refusal once per remote, class and
 * code, and standalone probes as it always has. Nothing here opens ssh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

// The handler module reaches `smol-toml` through the provider translation
// service; the package is not installed here, so the import is stubbed.
vi.mock('smol-toml', () => ({ parse: () => ({}), stringify: () => '' }));
vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/agents/path-prober', () => ({
	checkCustomPath: vi.fn(async (requestedPath: string) => ({ exists: true, path: requestedPath })),
}));
vi.mock('../../../../main/agents/codex-skills', () => ({
	discoverCodexSkills: vi.fn().mockRejectedValue(new Error('Unsupported skills/list')),
}));
vi.mock('../../../../main/agents', async () => {
	const opencodeConfig = await import('../../../../main/agents/opencode-config');
	const codexConfig = await import('../../../../main/agents/codex-config');
	return {
		getAgentCapabilities: vi.fn(() => ({})),
		AGENT_DEFINITIONS: [
			{ id: 'claude-code', name: 'Claude Code', binaryName: 'claude', configOptions: [] },
			{ id: 'opencode', name: 'OpenCode', binaryName: 'opencode', configOptions: [] },
			{ id: 'terminal', name: 'Terminal', binaryName: 'bash', configOptions: [] },
		],
		DEFAULT_CAPABILITIES: {},
		parseOpenCodeConfig: opencodeConfig.parseOpenCodeConfig,
		extractModelsFromConfig: opencodeConfig.extractModelsFromConfig,
		getOpenCodeConfigPaths: opencodeConfig.getOpenCodeConfigPaths,
		getOpenCodeCommandDirs: opencodeConfig.getOpenCodeCommandDirs,
		getCodexSkillDirs: codexConfig.getCodexSkillDirs,
		getCodexPromptDirs: codexConfig.getCodexPromptDirs,
		parseCodexMarkdownDoc: codexConfig.parseCodexMarkdownDoc,
	};
});
const execFileNoThrow = vi.fn();
vi.mock('../../../../main/utils/execFile', () => ({
	execFileNoThrow: (...args: unknown[]) => execFileNoThrow(...args),
}));
const buildSshCommand = vi.fn();
vi.mock('../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: (...args: unknown[]) => buildSshCommand(...args),
	buildSshCommandWithStdin: vi.fn(),
}));
vi.mock('../../../../main/utils/stripAnsi', () => ({
	stripAnsi: (text: string) => text,
}));

import {
	registerAgentsHandlers,
	type AgentsHandlerDependencies,
} from '../../../../main/ipc/handlers/agents';
import { capabilitySnapshots } from '../../../../main/agents/capability-snapshot';
import { probeRemoteMaestroP } from '../../../../main/agents/probeRemoteMaestroP';
import {
	getRemoteMaestroPAvailable,
	__clearRemoteMaestroPCache,
} from '../../../../main/agents/remoteMaestroPCache';
import {
	heldRemoteAccess,
	REMOTE_ACCESS_REFUSED_EXIT_CODE,
	setRemoteAccessAuthority,
} from '../../../../main/ssh-remote-manager';
import type {
	RemoteAccessAuthority,
	RemoteAccessDecision,
	RemoteAccessRequest,
} from '../../../../main/enterprise/remote';
import type { SshRemoteConfig } from '../../../../shared/types';

const buildBox: SshRemoteConfig = {
	id: 'remote-1',
	name: 'Build Box',
	host: 'build.example.com',
	port: 22,
	username: 'ci',
	privateKeyPath: '',
	enabled: true,
};

const REFUSAL_LINE = '[managed-remote-unqualified] the remote attests no managed standing';

function refusing(): RemoteAccessDecision {
	return {
		allowed: false,
		code: 'remote-unqualified',
		message: 'the remote attests no managed standing',
		managed: {
			policyRevision: 3,
			class: 'probe',
			operation: 'detect-agents',
			remoteId: buildBox.id,
			target: null,
			count: 1,
			endpoint: null,
			effect: null,
			outcome: 'remote-unqualified',
		},
	};
}

/** A recording authority: refuses every request, or admits every request, as asked. */
function authority(decision: () => RemoteAccessDecision | Promise<RemoteAccessDecision>) {
	const requests: RemoteAccessRequest[] = [];
	const hold = vi.fn(async (request: RemoteAccessRequest) => {
		requests.push(request);
		return decision();
	});
	return { authority: { hold } satisfies RemoteAccessAuthority, requests, hold };
}
const refusingAuthority = () => authority(refusing);
const admittingAuthority = () => authority(() => ({ allowed: true }));

let handlers: Map<string, (...args: never[]) => unknown>;

function register() {
	handlers = new Map();
	vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
		handlers.set(channel, handler as never);
	});
	const settingsStore = { get: vi.fn().mockReturnValue([buildBox]), set: vi.fn() };
	const deps: AgentsHandlerDependencies = {
		getAgentDetector: () =>
			({
				detectAgents: vi.fn(),
				getAgent: vi.fn(),
				clearCache: vi.fn(),
				setCustomPaths: vi.fn(),
				discoverModels: vi.fn(),
			}) as never,
		agentConfigsStore: { get: vi.fn().mockReturnValue({}), set: vi.fn() } as never,
		settingsStore: settingsStore as never,
	};
	registerAgentsHandlers(deps);
}

function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
	const handler = handlers.get(channel);
	if (!handler) throw new Error(`no handler for ${channel}`);
	return handler({} as never, ...(args as never[])) as Promise<T>;
}

beforeEach(() => {
	vi.clearAllMocks();
	capabilitySnapshots.__resetForTests();
	__clearRemoteMaestroPCache();
	buildSshCommand.mockResolvedValue({ command: 'ssh', args: ['ci@build.example.com', 'probe'] });
	execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: '/usr/local/bin/tool\n', stderr: '' });
	register();
});
afterEach(() => {
	setRemoteAccessAuthority(null);
});

describe('agents:detect over SSH', () => {
	it('standalone probes every agent and launch-tests maestro-p, as before', async () => {
		// Three `command -v` answers, then the version line the launch test wants.
		execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 0, stdout: '/usr/local/bin/tool\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '/usr/local/bin/tool\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '/usr/local/bin/tool\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '0.16.20-RC\n', stderr: '' });
		const agents = await call<Array<{ id: string; available: boolean; error?: string }>>(
			'agents:detect',
			buildBox.id
		);
		expect(agents.map((a) => a.available)).toEqual([true, true, true]);
		expect(agents.every((a) => a.error === undefined)).toBe(true);
		// Three `command -v` probes and one `maestro-p --version`.
		expect(buildSshCommand).toHaveBeenCalledTimes(4);
		expect(getRemoteMaestroPAvailable(buildBox.id)).toBe(true);
		expect(heldRemoteAccess()).toEqual([]);
	});

	it('a refused remote answers every agent with the hold, opens no session and asks once', async () => {
		const { authority: refuse, requests } = refusingAuthority();
		setRemoteAccessAuthority(refuse);

		const agents = await call<
			Array<{ id: string; available: boolean; path?: string; error?: string }>
		>('agents:detect', buildBox.id);

		expect(agents).toHaveLength(3);
		for (const agent of agents) {
			expect(agent.available).toBe(false);
			expect(agent.path).toBeUndefined();
			expect(agent.error).toBe(REFUSAL_LINE);
		}
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		// One hold for the whole detection, naming the class, the operation and
		// how many binaries it covers; the maestro-p probe never ran.
		expect(requests).toEqual([
			{
				class: 'probe',
				remote: buildBox,
				operation: 'detect-agents',
				target: null,
				count: 3,
			},
		]);
		expect(getRemoteMaestroPAvailable(buildBox.id)).toBeUndefined();
	});

	it('a refusal is the readiness snapshot of every agent and one row of the ledger', async () => {
		setRemoteAccessAuthority(refusingAuthority().authority);
		await call('agents:detect', buildBox.id);

		for (const id of ['claude-code', 'opencode']) {
			expect(capabilitySnapshots.get(id, buildBox.id)).toMatchObject({
				status: 'failed',
				lastError: REFUSAL_LINE,
				remoteId: buildBox.id,
			});
		}
		expect(capabilitySnapshots.get('terminal', buildBox.id)).toBeUndefined();
		expect(heldRemoteAccess()).toEqual([
			expect.objectContaining({
				remoteId: buildBox.id,
				remoteName: 'Build Box',
				class: 'probe',
				operation: 'detect-agents',
				code: 'remote-unqualified',
				message: REFUSAL_LINE,
				policyRevision: 3,
				count: 1,
			}),
		]);
	});

	it('a reprobe of a refused remote resolves the spinner to failed, never stuck at probing', async () => {
		setRemoteAccessAuthority(refusingAuthority().authority);
		const snapshot = await call<{ status: string; lastError?: string } | null>(
			'agents:reprobe',
			'claude-code',
			buildBox.id
		);
		expect(snapshot).toMatchObject({ status: 'failed', lastError: REFUSAL_LINE });
		expect(buildSshCommand).not.toHaveBeenCalled();
	});

	it('an admitted remote is probed as standalone is, with the identity asked for the detection and the launch test', async () => {
		const { authority: admit, requests } = admittingAuthority();
		setRemoteAccessAuthority(admit);

		const agents = await call<Array<{ available: boolean }>>('agents:detect', buildBox.id);

		expect(agents.map((a) => a.available)).toEqual([true, true, true]);
		expect(buildSshCommand).toHaveBeenCalledTimes(4);
		expect(requests.map((r) => [r.class, r.operation])).toEqual([
			['probe', 'detect-agents'],
			['probe', 'maestro-p-version'],
		]);
		expect(capabilitySnapshots.get('claude-code', buildBox.id)).toMatchObject({
			status: 'ok',
			path: '/usr/local/bin/tool',
		});
		expect(heldRemoteAccess()).toEqual([]);
	});
});

describe('agents:get over SSH', () => {
	it('a refused remote is the agent error and its failed snapshot, with no session opened', async () => {
		const { authority: refuse, requests } = refusingAuthority();
		setRemoteAccessAuthority(refuse);

		const agent = await call<{ available: boolean; error?: string }>(
			'agents:get',
			'claude-code',
			buildBox.id
		);

		expect(agent.available).toBe(false);
		expect(agent.error).toBe(REFUSAL_LINE);
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(requests).toEqual([
			{ class: 'probe', remote: buildBox, operation: 'detect-agent', target: null },
		]);
		expect(capabilitySnapshots.get('claude-code', buildBox.id)).toMatchObject({
			status: 'failed',
			lastError: REFUSAL_LINE,
		});
	});

	it('an admitted remote is probed and marked ok with its path', async () => {
		setRemoteAccessAuthority(admittingAuthority().authority);
		execFileNoThrow.mockResolvedValue({
			exitCode: 0,
			stdout: '/home/ci/.local/bin/claude\n',
			stderr: '',
		});

		const agent = await call<{ available: boolean; path?: string }>(
			'agents:get',
			'claude-code',
			buildBox.id
		);

		expect(agent).toMatchObject({ available: true, path: '/home/ci/.local/bin/claude' });
		expect(buildSshCommand).toHaveBeenCalledWith(
			buildBox,
			expect.objectContaining({ command: 'command', args: ['-v', 'claude'] })
		);
		expect(capabilitySnapshots.get('claude-code', buildBox.id)).toMatchObject({ status: 'ok' });
	});

	it('a remote that is not installed stays not_installed, never failed', async () => {
		setRemoteAccessAuthority(admittingAuthority().authority);
		execFileNoThrow.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });

		const agent = await call<{ available: boolean; error?: string }>(
			'agents:get',
			'claude-code',
			buildBox.id
		);

		expect(agent).toMatchObject({ available: false });
		expect(agent.error).toBeUndefined();
		expect(capabilitySnapshots.get('claude-code', buildBox.id)).toMatchObject({
			status: 'not_installed',
		});
	});
});

describe('agents:getModels over SSH', () => {
	it('a refused remote is thrown by name, never an empty model list, with no session opened', async () => {
		const { authority: refuse, requests } = refusingAuthority();
		setRemoteAccessAuthority(refuse);

		await expect(call('agents:getModels', 'claude-code', true, buildBox.id)).rejects.toMatchObject({
			name: 'RemoteAccessRefusedError',
			message: REFUSAL_LINE,
		});
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(requests).toEqual([
			{ class: 'probe', remote: buildBox, operation: 'discover-models', target: null },
		]);
	});

	it('an admitted remote runs the models probe, and for OpenCode a read of its configs', async () => {
		const { authority: admit, requests } = admittingAuthority();
		setRemoteAccessAuthority(admit);
		execFileNoThrow
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'anthropic/claude\nopenai/gpt\n', stderr: '' })
			.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

		const models = await call<string[]>('agents:getModels', 'opencode', true, buildBox.id);

		expect(models).toEqual(['anthropic/claude', 'openai/gpt']);
		expect(requests.map((r) => [r.class, r.operation, r.count])).toEqual([
			['probe', 'discover-models', undefined],
			['read', 'read-opencode-configs', 3],
		]);
	});

	it('models cached from an earlier admission are served without asking again', async () => {
		const { authority: admit, requests } = admittingAuthority();
		setRemoteAccessAuthority(admit);
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: 'sonnet\n', stderr: '' });
		await call('agents:getModels', 'claude-code', true, buildBox.id);
		requests.length = 0;

		setRemoteAccessAuthority(refusingAuthority().authority);
		const models = await call<string[]>('agents:getModels', 'claude-code', false, buildBox.id);

		expect(models).toEqual(['sonnet']);
		expect(requests).toEqual([]);
	});
});

describe('agents:discoverSlashCommands for a remote OpenCode agent', () => {
	it('a refused remote is thrown by name with the cwd it would have read', async () => {
		const { authority: refuse, requests } = refusingAuthority();
		setRemoteAccessAuthority(refuse);

		await expect(
			call('agents:discoverSlashCommands', 'opencode', '/srv/app', undefined, buildBox.id)
		).rejects.toMatchObject({ name: 'RemoteAccessRefusedError', message: REFUSAL_LINE });
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(requests).toEqual([
			{
				class: 'read',
				remote: buildBox,
				operation: 'discover-opencode-commands',
				target: '/srv/app',
				count: 7,
			},
		]);
	});

	it('an admitted remote reads its command files as before', async () => {
		setRemoteAccessAuthority(admittingAuthority().authority);
		execFileNoThrow.mockResolvedValue({
			exitCode: 0,
			stdout: '___CMD_FILE_START___ review.md\nReview the diff.\n___CMD_FILE_END___\n',
			stderr: '',
		});

		const commands = await call<Array<{ name: string; prompt?: string }>>(
			'agents:discoverSlashCommands',
			'opencode',
			'/srv/app',
			undefined,
			buildBox.id
		);

		expect(commands).toEqual([{ name: 'review', prompt: 'Review the diff.' }]);
	});
});

describe('the maestro-p launch test', () => {
	it('a refused remote leaves the availability unknown, never a cached false, and opens no session', async () => {
		const { authority: refuse, requests } = refusingAuthority();
		setRemoteAccessAuthority(refuse);

		const available = await call<boolean | null>(
			'agents:getRemoteMaestroPAvailable',
			buildBox.id,
			true
		);

		expect(available).toBeNull();
		expect(getRemoteMaestroPAvailable(buildBox.id)).toBeUndefined();
		expect(buildSshCommand).not.toHaveBeenCalled();
		expect(requests).toEqual([
			{ class: 'probe', remote: buildBox, operation: 'maestro-p-version', target: null },
		]);
		expect(heldRemoteAccess()).toEqual([
			expect.objectContaining({ class: 'probe', operation: 'maestro-p-version', count: 1 }),
		]);
	});

	it('the ledger keeps one row per remote, class and code across the probes that share them', async () => {
		setRemoteAccessAuthority(refusingAuthority().authority);
		await call('agents:detect', buildBox.id);
		await call('agents:get', 'claude-code', buildBox.id);
		await call('agents:getRemoteMaestroPAvailable', buildBox.id, true);

		const held = heldRemoteAccess();
		expect(held).toHaveLength(1);
		expect(held[0]).toMatchObject({ class: 'probe', code: 'remote-unqualified', count: 3 });
	});

	it('an admitted remote is launch-tested and cached as before', async () => {
		setRemoteAccessAuthority(admittingAuthority().authority);
		execFileNoThrow.mockResolvedValue({ exitCode: 0, stdout: '0.16.20-RC\n', stderr: '' });

		expect(await probeRemoteMaestroP(buildBox)).toBe(true);
		expect(getRemoteMaestroPAvailable(buildBox.id)).toBe(true);
		expect(buildSshCommand).toHaveBeenCalledWith(
			buildBox,
			expect.objectContaining({ command: 'maestro-p', args: ['--version'] })
		);
	});

	it('an authority that throws leaves the availability unknown rather than caching an answer', async () => {
		setRemoteAccessAuthority(
			authority(() => Promise.reject(new Error('attestation socket closed'))).authority
		);

		expect(await probeRemoteMaestroP(buildBox)).toBeNull();
		expect(getRemoteMaestroPAvailable(buildBox.id)).toBeUndefined();
		expect(buildSshCommand).not.toHaveBeenCalled();
	});
});

describe('the refusal result', () => {
	it('is spelled with an exit code no shell produces, so a probe never reads it as found or not found', () => {
		expect(REMOTE_ACCESS_REFUSED_EXIT_CODE).toBe('EMANAGED');
		expect(typeof REMOTE_ACCESS_REFUSED_EXIT_CODE).toBe('string');
	});
});
