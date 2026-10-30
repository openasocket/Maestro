/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep applyClaudeSpawnDecision + buildRemoteInteractiveSpawn REAL (they own the
// actual `--max-wait` arg injection, which is what we want to assert lands in
// the spawn). Only stub resolveClaudeSpawnMode so it deterministically resolves
// to the local interactive (maestro-p) path without needing a real binary or a
// usage snapshot.
const mockResolve = vi.fn();
vi.mock('../../../main/agents/resolveClaudeSpawnMode', async () => {
	const actual = await vi.importActual<
		typeof import('../../../main/agents/resolveClaudeSpawnMode')
	>('../../../main/agents/resolveClaudeSpawnMode');
	return {
		...actual,
		resolveClaudeSpawnMode: (...args: unknown[]) => mockResolve(...args),
	};
});

// SSH: stub the wrapper so we can hand back either a resolved remote or the
// silent local-fallback shape it produces when the remote can't be found.
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', async () => {
	const actual = await vi.importActual<
		typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
	>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
	return {
		...actual,
		wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	};
});
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../shared/maestro-lib/launch/ssh-remote-resolver', () => ({
	getSshRemoteConfig: vi.fn(() => ({ config: null, source: 'session' })),
}));

// Pin the non-Windows branch so the system-prompt flag is passed inline on
// every CI host (the Windows temp-file branch is covered by the delivery tests).
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return { ...actual, isWindows: () => false };
});

// The real ProcessManager (the sink the lineage cases bind at) pulls in the PTY
// spawner and the logger; neither is exercised here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../shared/maestro-lib/launch/ssh-path', () => ({
	resolveSshPath: async () => 'ssh',
}));

import * as os from 'os';
import * as path from 'node:path';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { buildAgentArgs } from '../../../shared/maestro-lib/launch/agent-args';
import { ensureRemoteMaestroPProbed } from '../../../main/agents/probeRemoteMaestroP';
import { getSshRemoteConfig } from '../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { logger } from '../../../shared/maestro-lib/host';
import type { SpawnGroupChatAgentConfig } from '../../../main/group-chat/spawnGroupChatAgent';
import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';
import { ProcessManager } from '../../../main/process-manager/ProcessManager';
import type { ProcessConfig, ProcessSpawnAuthorityPort } from '../../../main/process-manager/types';
import { createLocalEndpointClient } from '../../../main/enterprise/endpoint-client';
import { startFakeEndpoint } from '../enterprise/fakeEndpoint';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';
import {
	groupChatRoomContext,
	groupChatRoomRunId,
	groupChatTurnContext,
} from '../../../shared/maestro-lib/groupchat/spawn';
import {
	MANAGED_DELEGATION_ENV_VAR,
	delegationContextEnv,
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../../shared/maestro-lib/managed/delegation';
import { createManagedHostAdapter } from '../../../shared/maestro-lib/managed/host-adapter';
import type {
	EndpointPort,
	ManagedEnrollmentStatus,
	ManagedIdentityView,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';

function makeAgent(): AgentConfig {
	return {
		id: 'claude-code',
		command: 'claude',
		interactiveCommand: 'claude',
		interactiveModeArgs: ['--dangerously-skip-permissions'],
	} as unknown as AgentConfig;
}

describe('spawnGroupChatAgent', () => {
	let processManager: IProcessManager;
	let spawnSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.clearAllMocks();
		spawnSpy = vi.fn().mockReturnValue({ pid: 4242, success: true });
		processManager = {
			spawn: spawnSpy,
			write: vi.fn().mockReturnValue(true),
			kill: vi.fn().mockReturnValue(true),
		} as unknown as IProcessManager;
	});

	function managedManager(port: ProcessSpawnAuthorityPort = fakeSpawnPort()) {
		const manager = new ProcessManager(() => false, {
			spawnAuthority: () => port,
			isCoworkingEnabled: () => false,
		});
		const cli = vi.fn(() => ({ pid: 4242, success: true }));
		(manager as unknown as { childProcessSpawner: { spawn: typeof cli } }).childProcessSpawner = {
			spawn: cli,
		};
		const spawned = (): ProcessConfig => cli.mock.calls[0][0] as unknown as ProcessConfig;
		return { manager, cli, spawned };
	}

	it('forwards maxWaitSeconds as --max-wait on the interactive maestro-p spawn', async () => {
		// Decision: local interactive, with a resolved maestro-p script path.
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-1',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			maxWaitSeconds: 600,
			processManager,
			debugLabel: 'participant: Test',
		});

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		// process.execPath drives the maestro-p script under ELECTRON_RUN_AS_NODE.
		expect(spawned.command).toBe(process.execPath);
		// --max-wait must land after the script but before the batch args/prompt.
		const i = spawned.args.indexOf('--max-wait');
		expect(i).toBeGreaterThan(-1);
		expect(spawned.args[i + 1]).toBe('600');
		expect(spawned.args.indexOf('--max-wait')).toBeLessThan(spawned.args.indexOf('--'));
	});

	it('omits --max-wait when maxWaitSeconds is not provided', async () => {
		mockResolve.mockReturnValue({
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/bundled/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		});

		await spawnGroupChatAgent({
			sessionId: 'sess-2',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'interactive',
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
		expect(spawned.args).not.toContain('--max-wait');
	});

	it('does not inject --max-wait on the API path (no maestro-p)', async () => {
		mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });

		await spawnGroupChatAgent({
			sessionId: 'sess-3',
			agentId: 'claude-code',
			agent: makeAgent(),
			command: '/usr/local/bin/claude',
			args: ['--print', '--', 'hello'],
			cwd: '/tmp/work',
			tokenMode: 'api',
			maxWaitSeconds: 600,
			processManager,
		});

		const spawned = spawnSpy.mock.calls[0][0] as { command: string; args: string[] };
		expect(spawned.command).toBe('/usr/local/bin/claude');
		expect(spawned.args).not.toContain('--max-wait');
	});

	describe('SSH remote resolution', () => {
		const sshRemoteConfig = { enabled: true, remoteId: 'jennifer-box' };
		const sshStore = {} as never;

		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto', maestroPBinPath: null });
		});

		it('fails loudly instead of silently spawning locally when the remote cannot be resolved', async () => {
			// The shape wrapSpawnWithSsh returns on its local-fallback path: the
			// original command, unchanged, with no remote recorded.
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				customEnvVars: undefined,
				sshRemoteUsed: null,
			});

			await expect(
				spawnGroupChatAgent({
					sessionId: 'sess-ssh-1',
					agentId: 'claude-code',
					agent: makeAgent(),
					command: '/usr/local/bin/claude',
					args: ['--print', '--', 'hello'],
					cwd: '/remote/only/path',
					prompt: 'hello',
					sshRemoteConfig,
					sshStore,
					processManager,
				})
			).rejects.toThrow(/jennifer-box/);

			// The whole point: nothing ran on this machine.
			expect(spawnSpy).not.toHaveBeenCalled();
		});

		it('spawns normally when the remote resolves', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['user@host', 'claude --print'],
				cwd: '/Users/local/home',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'jennifer-box', name: 'Jennifer', host: 'host' },
			});

			await spawnGroupChatAgent({
				sessionId: 'sess-ssh-2',
				agentId: 'claude-code',
				agent: makeAgent(),
				command: '/usr/local/bin/claude',
				args: ['--print', '--', 'hello'],
				cwd: '/remote/only/path',
				prompt: 'hello',
				sshRemoteConfig,
				sshStore,
				processManager,
			});

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const spawned = spawnSpy.mock.calls[0][0] as { command: string };
			expect(spawned.command).toBe('ssh');
		});
	});

	describe('appendSystemPrompt', () => {
		const apiDecision = { mode: 'api', reason: 'auto' };
		const agentWith = (supportsAppendSystemPrompt: boolean) =>
			({
				...makeAgent(),
				capabilities: { supportsAppendSystemPrompt },
			}) as unknown as AgentConfig;

		it('passes the native flag for agents that support it', async () => {
			mockResolve.mockReturnValue(apiDecision);
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'claude-code',
				agent: agentWith(true),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				processManager,
			});
			const spawned = spawnSpy.mock.calls[0][0] as { args: string[]; prompt: string };
			expect(spawned.args).toEqual(['--print', '--append-system-prompt', 'SYS']);
			expect(spawned.prompt).toBe('hello');
		});

		it('re-sends the native flag on resume', async () => {
			mockResolve.mockReturnValue(apiDecision);
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'claude-code',
				agent: agentWith(true),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				isResume: true,
				processManager,
			});
			const spawned = spawnSpy.mock.calls[0][0] as { args: string[] };
			expect(spawned.args).toContain('--append-system-prompt');
		});

		it('embeds into the prompt for agents without the flag, and not on resume', async () => {
			mockResolve.mockReturnValue(apiDecision);
			const base = {
				sessionId: 's',
				agentId: 'codex',
				agent: agentWith(false),
				args: ['exec'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				processManager,
			};

			await spawnGroupChatAgent(base);
			expect((spawnSpy.mock.calls[0][0] as { prompt: string }).prompt).toBe(
				embedSystemPromptInPrompt('SYS', 'hello')
			);

			await spawnGroupChatAgent({ ...base, isResume: true });
			expect((spawnSpy.mock.calls[1][0] as { prompt: string }).prompt).toBe('hello');
		});

		it('hands the embedded prompt to the SSH wrapper', async () => {
			mockResolve.mockReturnValue(apiDecision);
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['host'],
				cwd: '/remote',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'r1', name: 'R', host: 'h' },
			});
			await spawnGroupChatAgent({
				sessionId: 's',
				agentId: 'codex',
				agent: agentWith(false),
				args: ['exec'],
				cwd: '/tmp/work',
				prompt: 'hello',
				appendSystemPrompt: 'SYS',
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				sshStore: { getSshRemotes: () => [] } as any,
				processManager,
			});
			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as { prompt: string };
			expect(wrapConfig.prompt).toBe(embedSystemPromptInPrompt('SYS', 'hello'));
		});
	});

	describe('private prompt-file handoff (GT1-02-10D1T)', () => {
		const roomId = '11111111-2222-4333-8444-555555555555';
		const providerSession = '019aa4fe-0000-7000-8000-000000000002';
		const remote = {
			id: 'r1',
			name: 'Box',
			host: 'box.invalid',
			port: 22,
			username: 'me',
			privateKeyPath: '',
			enabled: true,
			useSshConfig: false,
		};
		const remotePath = path.posix.join(
			'/tmp',
			'maestro-prompt-11111111-2222-4333-8444-555555555555.json'
		);
		let base: SpawnGroupChatAgentConfig;
		let spawnAdmitted: ReturnType<typeof vi.fn>;
		beforeEach(async () => {
			for (const level of ['debug', 'info', 'warn', 'error'] as const)
				vi.spyOn(logger, level).mockImplementation(() => {});
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
			vi.mocked(getSshRemoteConfig).mockReturnValue({ config: remote, source: 'session' });
			const actual = await vi.importActual<
				typeof import('../../../shared/maestro-lib/launch/ssh-spawn-wrapper')
			>('../../../shared/maestro-lib/launch/ssh-spawn-wrapper');
			mockWrapSpawnWithSsh.mockImplementation(actual.wrapSpawnWithSsh);
			spawnAdmitted = vi.fn().mockResolvedValue({ pid: 4343, success: true });
			base = {
				sessionId: `group-chat-${roomId}-participant-Alpha-1700000000000`,
				agentId: 'grok',
				agent: {
					...getAgentDefinition('grok')!,
					available: true,
					capabilities: { ...getAgentCapabilities('grok') },
					// Candidate declaration only; this does not activate the provider.
					promptFile: {
						format: 'acp-json',
						exclusivePromptFlags: ['-p', '--single', '--prompt-file'],
					},
					promptFileArgs: (file) => ['--prompt-file', file],
				},
				command: path.resolve('local tools', 'grok'),
				remoteCommand: path.posix.join('/opt', 'remote tools', 'grok'),
				args: ['--model', 'selected-model'],
				cwd: path.resolve('work'),
				prompt: 'private 雪\n$(keep) `literal`',
				appendSystemPrompt: 'private system',
				customEnvVars: { GROK_HOME: path.resolve('account') },
				// This artifact fixture has no read-only args; the boolean proves no enforcement.
				readOnlyMode: true,
				actor: { peer: 'web-login', username: 'pat' },
				processManager: { ...processManager, spawnAdmitted },
			};
		});
		afterEach(() => {
			vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'session' });
			mockWrapSpawnWithSsh.mockReset();
			vi.restoreAllMocks();
		});
		describe.each([false, true])('SSH=%s', (ssh) => {
			it.each([
				['composed', 'private 雪\n$(keep) `literal`', false],
				['empty', '', false],
				['sole system', '', false],
				['resumed', 'private 🧪\n'.repeat(4_000), true],
				['empty resumed', '', true],
			] as const)('hands off %s bytes once through admission', async (label, prompt, resumed) => {
				const config = { ...base, prompt, isResume: false };
				if (label === 'empty' || label === 'empty resumed') config.appendSystemPrompt = undefined;
				if (resumed) {
					config.sessionId = 'cross-agent-request';
					config.args = [...base.args, '--resume', providerSession];
				}
				if (ssh) {
					config.cwd = path.posix.join('/remote', 'team work');
					config.customEnvVars = { GROK_HOME: '/remote/account' };
					config.sshRemoteConfig = { enabled: true, remoteId: remote.id };
					config.sshStore = { getSshRemotes: () => [remote] };
					config.promptFileDestination = {
						owner: 'remote',
						path: remotePath,
						sshRemoteId: remote.id,
					};
				}
				expect(await spawnGroupChatAgent(config)).toEqual({ pid: 4343, success: true });
				expect(spawnAdmitted).toHaveBeenCalledTimes(1);
				expect(spawnSpy).not.toHaveBeenCalled();
				const [spawned, actor] = spawnAdmitted.mock.calls[0] as [ProcessConfig, unknown];
				const artifact = spawned.promptArtifact!;
				const text =
					resumed || !config.appendSystemPrompt
						? prompt
						: prompt
							? embedSystemPromptInPrompt(config.appendSystemPrompt, prompt)
							: config.appendSystemPrompt;
				expect(artifact.content).toBe(
					JSON.stringify({ type: 'acp', content: [{ type: 'text', text }] })
				);
				expect(artifact).toMatchObject({
					owner: ssh ? 'remote' : 'local',
					mode: 0o600,
					flag: 'wx',
					encoding: 'utf8',
					cleanup: 'turn',
				});
				expect(spawned).toMatchObject({
					toolType: 'grok',
					prompt: undefined,
					sendPromptViaStdin: false,
					sendPromptViaStdinRaw: false,
				});
				expect(actor).toEqual(base.actor);
				expect(spawned.agentSessionId).toBe(resumed ? providerSession : undefined);
				expect(spawned.delegation).toEqual(resumed ? undefined : groupChatRoomContext(roomId));
				if (ssh) {
					const wrapped = mockWrapSpawnWithSsh.mock.calls[0][0];
					const prepared = await mockWrapSpawnWithSsh.mock.results[0].value;
					expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
					expect(wrapped).toMatchObject({
						args: [...config.args, '--prompt-file', artifact.path],
						cwd: config.cwd,
						agentBinaryName: config.remoteCommand,
						prompt: undefined,
						promptArtifact: artifact,
						customEnvVars: config.customEnvVars,
					});
					expect(spawned).toMatchObject({
						command: 'ssh',
						args: prepared.args,
						sshStdinScript: prepared.sshStdinScript,
						sshRemoteId: remote.id,
						cwd: os.homedir(),
					});
					expect(artifact.path).toBe(remotePath);
					expect(spawned.sshStdinScript).toContain(
						Buffer.from(artifact.content).toString('base64')
					);
					expect(spawned.sshStdinScript).toContain(
						"'/opt/remote tools/grok' '--model' 'selected-model'"
					);
					expect(spawned.sshStdinScript).toContain("cd '/remote/team work' || exit 1");
					expect(spawned.sshStdinScript).toContain("export GROK_HOME='/remote/account'");
					expect(spawned.sshStdinScript!.includes(`'--resume' '${providerSession}'`)).toBe(resumed);
					expect(spawned.sshStdinScript).not.toContain(config.command);
					expect(spawned.args.join(' ')).not.toContain(artifact.path);
				} else {
					expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
					expect(path.isAbsolute(artifact.path)).toBe(true);
					expect(spawned).toMatchObject({
						command: config.command,
						cwd: config.cwd,
						customEnvVars: config.customEnvVars,
						args: [...config.args, '--prompt-file', artifact.path],
					});
				}
				const diagnostics = JSON.stringify([
					spawned.sshRemoteCommand,
					vi.mocked(logger.debug).mock.calls,
					vi.mocked(logger.info).mock.calls,
					vi.mocked(logger.warn).mock.calls,
				]);
				for (const value of ['private system', 'private 雪', 'private 🧪', artifact.path])
					expect(diagnostics).not.toContain(value);
			});
		});
		it('retains the selected capability snapshot while remote preparation is deferred', async () => {
			const selectedCapabilities = { ...base.agent.capabilities };
			let entered!: () => void;
			let release!: () => void;
			const probing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<undefined>((resolve) => {
				release = () => resolve(undefined);
			});
			vi.mocked(ensureRemoteMaestroPProbed).mockImplementationOnce(() => {
				entered();
				return gate;
			});
			const pending = spawnGroupChatAgent({
				...base,
				sshRemoteConfig: { enabled: true, remoteId: remote.id },
				sshStore: { getSshRemotes: () => [remote] },
			});
			await probing;
			base.agent.capabilities.supportsAppendSystemPrompt =
				!selectedCapabilities.supportsAppendSystemPrompt;
			base.agent.capabilities.supportsReadOnlyMode = !selectedCapabilities.supportsReadOnlyMode;
			release();
			expect(await pending).toEqual({ pid: 4343, success: true });
			expect(mockResolve).toHaveBeenCalledOnce();
			const captured = mockResolve.mock.calls[0][0].agent;
			expect(captured.capabilities).toEqual(selectedCapabilities);
			expect(captured.capabilities).not.toBe(base.agent.capabilities);
			expect(getAgentCapabilities('grok')).toEqual(selectedCapabilities);
			expect(spawnAdmitted).toHaveBeenCalledOnce();
			expect(spawnSpy).not.toHaveBeenCalled();
		});

		describe.each(['claude-code', 'codex'] as const)(
			'canonical %s read-only handoff',
			(provider) => {
				describe.each([false, true])('SSH=%s', (ssh) => {
					it.each([false, true])(
						'preserves prepared flags at admission, denied=%s',
						async (denied) => {
							const agent: AgentConfig = {
								...getAgentDefinition(provider)!,
								available: true,
								capabilities: { ...getAgentCapabilities(provider) },
							};
							const args = buildAgentArgs(agent, {
								baseArgs: agent.args,
								prompt: 'review only',
								readOnlyMode: true,
							});
							const port = fakeSpawnPort({
								decide: () => ({
									decision: 'deny',
									reason: 'Read-only control denied.',
									policyRevision: 1,
								}),
							});
							const { manager, cli } = managedManager(port);
							const legacySpawn = vi.spyOn(manager, 'spawn');
							const admission = denied ? vi.spyOn(manager, 'spawnAdmitted') : spawnAdmitted;
							const result = await spawnGroupChatAgent({
								sessionId: base.sessionId,
								agentId: provider,
								agent,
								args,
								prompt: 'review only',
								cwd: ssh ? '/remote/review' : os.tmpdir(),
								readOnlyMode: true,
								actor: base.actor,
								processManager: denied ? manager : base.processManager,
								...(ssh
									? {
											sshRemoteConfig: { enabled: true, remoteId: remote.id },
											sshStore: { getSshRemotes: () => [remote] },
										}
									: {}),
							});
							expect(admission).toHaveBeenCalledOnce();
							const [config, actor] = admission.mock.calls[0] as [ProcessConfig, unknown];
							expect(actor).toEqual(base.actor);
							expect(config).not.toHaveProperty('permission');
							const readOnly =
								provider === 'claude-code'
									? ['--permission-mode', 'plan']
									: ['--sandbox', 'read-only'];
							expect(args.slice(args.indexOf(readOnly[0]), args.indexOf(readOnly[0]) + 2)).toEqual(
								readOnly
							);
							if (ssh) {
								expect(mockWrapSpawnWithSsh).toHaveBeenCalledOnce();
								expect(mockWrapSpawnWithSsh.mock.calls[0][0].args).toEqual(args);
								const prepared = await mockWrapSpawnWithSsh.mock.results[0].value;
								expect(config.command).toBe('ssh');
								expect(config.args).toEqual(prepared.args);
								expect(config.sshRemoteCommand).toBe(prepared.sshRemoteCommand);
								// Short prompts use the packed SSH command rather than a stdin script.
								expect(config.sshStdinScript).toBeUndefined();
								expect(config.sshRemoteCommand).toContain(`'${readOnly[0]}' '${readOnly[1]}'`);
							} else {
								expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
								expect(config.args).toEqual(args);
								expect(config.sshStdinScript).toBeUndefined();
							}
							for (const bypass of [
								'--dangerously-skip-permissions',
								'--dangerously-bypass-approvals-and-sandbox',
							]) {
								expect(config.args).not.toContain(bypass);
								expect(config.args.join(' ')).not.toContain(bypass);
								expect(config.sshRemoteCommand ?? '').not.toContain(bypass);
								expect(config.sshStdinScript ?? '').not.toContain(bypass);
							}
							if (denied) {
								expect(result).toMatchObject({
									pid: -1,
									success: false,
									managed: { state: 'denied' },
								});
								expect(port.asked).toHaveLength(1);
								expect(port.authority.live()).toHaveLength(0);
								expect(manager.admissionOf(base.sessionId)).toBeNull();
							} else {
								expect(result).toEqual({ pid: 4343, success: true });
							}
							expect(legacySpawn).not.toHaveBeenCalled();
							expect(cli).not.toHaveBeenCalled();
							expect(spawnSpy).not.toHaveBeenCalled();
						}
					);
				});
			}
		);
		it.each(['ordered', 'image-only', 'unadmitted'])(
			'preserves %s image content and the system envelope across caller mutation',
			async (kind) => {
				const image = { type: 'image' as const, mimeType: 'image/png', data: 'AQID' };
				const blocks =
					kind === 'image-only'
						? [image]
						: [
								{ type: 'text' as const, text: 'before 雪' },
								image,
								{ type: 'text' as const, text: '\tafter 🧪 ' },
							];
				const support = {
					mimeTypes: ['image/png'],
					maxCount: 1,
					maxBytesPerImage: 3,
					maxTotalBytes: 3,
				};
				const pending = spawnGroupChatAgent({
					...base,
					prompt: undefined,
					promptBlocks: blocks,
					hasImages: true,
					embeddedImageSupport: kind === 'unadmitted' ? undefined : support,
				});
				image.data = 'BAUG';
				support.mimeTypes.length = 0;
				base.customEnvVars!.GROK_HOME = 'mutated';
				base.agent.promptFile!.format = 'text';
				if (kind === 'unadmitted') {
					await expect(pending).rejects.toThrow('Prompt-file group chat preparation unavailable.');
					expect(spawnAdmitted).not.toHaveBeenCalled();
					return;
				}
				await pending;
				const spawned = spawnAdmitted.mock.calls[0][0] as ProcessConfig;
				const originalImage = { ...image, data: 'AQID' };
				expect(JSON.parse(spawned.promptArtifact!.content)).toEqual({
					type: 'acp',
					content:
						kind === 'image-only'
							? [{ type: 'text', text: 'private system' }, originalImage]
							: [
									{ type: 'text', text: embedSystemPromptInPrompt('private system', 'before 雪') },
									originalImage,
									{ type: 'text', text: '\tafter 🧪 ' },
								],
				});
				expect(spawned.customEnvVars!.GROK_HOME).toBe(path.resolve('account'));
				expect(spawnAdmitted).toHaveBeenCalledTimes(1);
				expect(spawnSpy).not.toHaveBeenCalled();
			}
		);
		it.each([
			[
				'duplicate sources',
				{ promptBlocks: [{ type: 'text', text: 'private block' }] },
				'Supply either prompt text or ordered content blocks, not both.',
			],
			[
				'resume contradiction',
				{ args: ['--resume', providerSession], agentSessionId: 'other' },
				'Prompt-file resume identity does not match its launch arguments.',
			],
			[
				'missing resume ID',
				{ args: ['--resume'] },
				'Prompt-file resume requires an explicit provider session identity.',
			],
			[
				'conflicting argv',
				{ args: ['--single=private-argv'] },
				'Prompt-file group chat preparation unavailable.',
			],
			[
				'wrong owner',
				{ promptFileDestination: { owner: 'remote', path: remotePath, sshRemoteId: 'r1' } },
				'Prompt-file group chat preparation unavailable.',
			],
		] satisfies [string, Partial<SpawnGroupChatAgentConfig>, string][])(
			'refuses %s without admission, retry or private diagnostics',
			async (_label, overrides, message) => {
				await expect(spawnGroupChatAgent({ ...base, ...overrides })).rejects.toThrow(
					new Error(message)
				);
				expect(spawnAdmitted).not.toHaveBeenCalled();
				expect(spawnSpy).not.toHaveBeenCalled();
				expect(mockWrapSpawnWithSsh).not.toHaveBeenCalled();
				const logs = JSON.stringify([
					vi.mocked(logger.debug).mock.calls,
					vi.mocked(logger.warn).mock.calls,
					vi.mocked(logger.error).mock.calls,
				]);
				for (const value of ['private', remotePath, 'other']) expect(logs).not.toContain(value);
			}
		);

		it('sanitizes an SSH preparation failure and never falls back to a local process', async () => {
			mockWrapSpawnWithSsh.mockRejectedValueOnce(new Error(`private content at ${remotePath}`));
			await expect(
				spawnGroupChatAgent({
					...base,
					sshRemoteConfig: { enabled: true, remoteId: remote.id },
					sshStore: { getSshRemotes: () => [remote] },
				})
			).rejects.toThrow(/^Prompt-file group chat preparation unavailable\.$/);
			expect(spawnAdmitted).not.toHaveBeenCalled();
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
		});

		it('returns a managed refusal without retrying through the legacy spawn', async () => {
			const refusal = {
				pid: -1,
				success: false,
				error: 'The spawn was not admitted.',
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			};
			spawnAdmitted.mockResolvedValueOnce(refusal);
			expect(await spawnGroupChatAgent(base)).toEqual(refusal);
			expect(spawnAdmitted).toHaveBeenCalledTimes(1);
			expect(spawnSpy).not.toHaveBeenCalled();
		});
	});

	describe('the room lineage and the admitted spawn (MRC-07-05)', () => {
		const CHAT = '11111111-2222-4333-8444-555555555555';
		const PARTICIPANT = `group-chat-${CHAT}-participant-Alpha-1700000000000`;
		const apiDecision = { mode: 'api', reason: 'auto' };
		let spawnAdmitted: ReturnType<typeof vi.fn>;
		let admitting: IProcessManager;

		beforeEach(() => {
			mockResolve.mockReturnValue(apiDecision);
			spawnAdmitted = vi.fn().mockResolvedValue({ pid: 4343, success: true });
			admitting = {
				spawn: spawnSpy,
				spawnAdmitted,
				write: vi.fn().mockReturnValue(true),
				kill: vi.fn().mockReturnValue(true),
			} as unknown as IProcessManager;
		});

		it('spawns a room turn through the admitted path as the room’s child: the room record, the process id as its ids, the keyboard as the actor', async () => {
			const result = await spawnGroupChatAgent({
				sessionId: PARTICIPANT,
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				customEnvVars: { MINE: '1' },
				processManager: admitting,
			});

			expect(result).toEqual({ pid: 4343, success: true });
			expect(spawnSpy).not.toHaveBeenCalled();
			expect(spawnAdmitted).toHaveBeenCalledTimes(1);
			const [config, actor] = spawnAdmitted.mock.calls[0] as [
				{
					delegation: ManagedDelegationContext;
					dispatchedAs: { requestId: string; attemptId: string };
					customEnvVars: Record<string, string>;
				},
				unknown,
			];
			expect(actor).toEqual({ peer: 'in-process' });
			expect(config.delegation).toEqual(groupChatRoomContext(CHAT));
			expect(config.dispatchedAs).toEqual({ requestId: PARTICIPANT, attemptId: PARTICIPANT });
			// The process carries the CHILD record (the one the sink binds), beside the agent's own variables.
			const stamped = readDelegationContextEnv(config.customEnvVars);
			expect(stamped.status).toBe('ok');
			expect(stamped.status === 'ok' && stamped.context).toEqual(
				groupChatTurnContext({ processId: PARTICIPANT })
			);
			expect(config.customEnvVars.MINE).toBe('1');
		});

		it('reports a refusal at the sink as the result, with nothing spawned', async () => {
			spawnAdmitted.mockResolvedValue({
				pid: -1,
				success: false,
				error: 'The spawn was not admitted.',
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			});

			const result = await spawnGroupChatAgent({
				sessionId: PARTICIPANT,
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				processManager: admitting,
			});

			expect(result).toEqual({
				pid: -1,
				success: false,
				error: 'The spawn was not admitted.',
				managed: { state: 'unavailable', code: 'runtime-unavailable' },
			});
			expect(spawnSpy).not.toHaveBeenCalled();
		});

		it('hands a consult (no room) to the sink with no lineage and no stamp, and a named actor as given', async () => {
			await spawnGroupChatAgent({
				sessionId: 'cross-agent-req-1',
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				processManager: admitting,
				actor: { peer: 'web-login', username: 'pat' },
			});

			const [config, actor] = spawnAdmitted.mock.calls[0] as [
				{ delegation?: unknown; dispatchedAs?: unknown; customEnvVars?: Record<string, string> },
				unknown,
			];
			expect(actor).toEqual({ peer: 'web-login', username: 'pat' });
			expect(config.delegation).toBeUndefined();
			expect(config.dispatchedAs).toBeUndefined();
			expect(config.customEnvVars).toBeUndefined();
		});

		it('spawns as before through a process manager with no admitted path, still stamping the room record', async () => {
			await spawnGroupChatAgent({
				sessionId: PARTICIPANT,
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				processManager,
			});

			expect(spawnSpy).toHaveBeenCalledTimes(1);
			const spawned = spawnSpy.mock.calls[0][0] as {
				delegation: ManagedDelegationContext;
				customEnvVars: Record<string, string>;
			};
			expect(spawned.delegation).toEqual(groupChatRoomContext(CHAT));
			expect(readDelegationContextEnv(spawned.customEnvVars).status).toBe('ok');
		});

		it('stamps the record before the SSH wrap, so it reaches the remote agent', async () => {
			mockWrapSpawnWithSsh.mockResolvedValue({
				command: 'ssh',
				args: ['host'],
				cwd: '/remote',
				prompt: undefined,
				customEnvVars: undefined,
				sshRemoteUsed: { id: 'r1', name: 'R', host: 'h' },
			});
			await spawnGroupChatAgent({
				sessionId: PARTICIPANT,
				agentId: 'claude-code',
				agent: makeAgent(),
				args: ['--print'],
				cwd: '/tmp/work',
				prompt: 'hello',
				sshRemoteConfig: { enabled: true, remoteId: 'r1' },
				sshStore: { getSshRemotes: () => [] } as any,
				processManager: admitting,
			});
			const wrapConfig = mockWrapSpawnWithSsh.mock.calls[0][0] as {
				customEnvVars: Record<string, string>;
			};
			expect(readDelegationContextEnv(wrapConfig.customEnvVars).status).toBe('ok');
		});
	});

	/**
	 * Child lineage at the real sink (MRC-07-08, against CP-03). The helper hands
	 * the turn to a real `ProcessManager` over a managed port whose context
	 * verifier and lease authority are the real ones (the policy answer is a
	 * table, the spawner a stub that reports a pid). What is proven is the
	 * context the authority was asked to decide, the lease the process ran
	 * under, and the record the spawner was handed; never that the helper called
	 * something.
	 */
	describe('child lineage at the sink (MRC-07-08)', () => {
		const CHAT = '11111111-2222-4333-8444-555555555555';
		const ROOM = groupChatRoomRunId(CHAT);
		const PARTICIPANT = `group-chat-${CHAT}-participant-Alpha-1700000000000`;
		const MODERATOR = `group-chat-${CHAT}-moderator-1700000000001`;
		const BETA = `group-chat-${CHAT}-participant-Beta-1700000000002`;
		const RECOVERY = `group-chat-${CHAT}-participant-Alpha-recovery-1700000000003`;
		const cwd = os.tmpdir();

		beforeEach(() => {
			mockResolve.mockReturnValue({ mode: 'api', reason: 'auto' });
		});

		const turn = (
			sessionId: string,
			manager: ProcessManager,
			customEnvVars?: Record<string, string>
		) =>
			spawnGroupChatAgent({
				sessionId,
				agentId: 'claude-code',
				agent: makeAgent(),
				command: '/usr/local/bin/claude',
				args: ['--print'],
				cwd,
				prompt: 'hello',
				customEnvVars,
				processManager: manager,
			});

		it('binds a room turn as the room child under the host generation, runs it under the lease, and stamps the bound record on the process', async () => {
			const port = fakeSpawnPort();
			const { manager, cli, spawned } = managedManager(port);

			const result = await turn(PARTICIPANT, manager, { MINE: '1' });

			expect(result).toEqual({ pid: 4242, success: true });
			expect(port.asked).toHaveLength(1);
			const { context } = port.asked[0];
			expect(context.identity).toEqual({
				requestId: PARTICIPANT,
				idempotencyKey: PARTICIPANT,
				attemptId: PARTICIPANT,
				runId: PARTICIPANT,
				rootRunId: ROOM,
				parentRunId: ROOM,
			});
			expect(context.delegation).toEqual({
				chain: [
					{ kind: 'service', id: ROOM },
					{ kind: 'agent', id: PARTICIPANT },
				],
				grantRef: null,
			});
			expect(context.traceId).toBe(`delegated:${ROOM}:${PARTICIPANT}:${PARTICIPANT}`);
			expect(context.workflow).toBeNull();
			// The host's own generation, not the room's claim (null).
			expect(context.policyRevision).toBe(1);

			// The process ran under the lease this manager minted for that context.
			expect(cli).toHaveBeenCalledTimes(1);
			const config = spawned();
			expect(config.admission).toBeDefined();
			expect(config.admission?.requestId).toBe(PARTICIPANT);
			expect(manager.admissionOf(PARTICIPANT)).toBe(config.admission);
			const [lease] = port.authority.live();
			expect(lease.state()).toBe('bound');
			expect(lease.pid()).toBe(4242);

			// The record the process carries is the bound context's attribution half,
			// minus the generation (the room claims none; a grandchild is reauthorized).
			const stamped = readDelegationContextEnv(config.customEnvVars ?? {});
			expect(stamped.status).toBe('ok');
			if (stamped.status !== 'ok') return;
			expect(stamped.context.identity).toEqual(context.identity);
			expect(stamped.context.delegation).toEqual(context.delegation);
			expect(stamped.context.traceId).toBe(context.traceId);
			expect(stamped.context.workflow).toBeNull();
			expect(stamped.context.policyRevision).toBeNull();
			expect(config.customEnvVars?.MINE).toBe('1');

			manager.emit('exit', PARTICIPANT, 0);
			expect(port.authority.live()).toHaveLength(0);
			expect(lease.ended()).toMatchObject({ state: 'released', release: { outcome: 'exited' } });
			expect(manager.admissionOf(PARTICIPANT)).toBeNull();
		});

		it('parents every role of one room under the one room run, each its own request, each under its own lease', async () => {
			const port = fakeSpawnPort();
			const { manager } = managedManager(port);
			const ids = [MODERATOR, PARTICIPANT, BETA, RECOVERY];
			for (const id of ids) expect(await turn(id, manager)).toMatchObject({ success: true });

			const contexts = port.asked.map((a) => a.context);
			expect(contexts.map((c) => c.identity.requestId)).toEqual(ids);
			expect(new Set(contexts.map((c) => c.identity.parentRunId))).toEqual(new Set([ROOM]));
			expect(new Set(contexts.map((c) => c.identity.rootRunId))).toEqual(new Set([ROOM]));
			expect(contexts.map((c) => c.delegation.chain[0])).toEqual(
				ids.map(() => ({ kind: 'service', id: ROOM }))
			);
			expect(contexts.map((c) => c.delegation.chain[1].id)).toEqual(ids);
			// Four leases live, one per turn; each exit releases its own and no other.
			expect(port.authority.live()).toHaveLength(4);
			manager.emit('exit', BETA, 0);
			expect(port.authority.live()).toHaveLength(3);
			expect(
				port.authority
					.live()
					.map((l) => l.attemptId)
					.sort()
			).toEqual([MODERATOR, PARTICIPANT, RECOVERY].sort());
		});

		it('a dispatch from the participant shell is bound as the participant child: the chain one link deeper, parented under the turn, the room still the root', async () => {
			const port = fakeSpawnPort();
			const { manager, spawned } = managedManager(port);
			await turn(PARTICIPANT, manager);
			// What `maestro-cli dispatch` reads off the participant's environment.
			const carried = readDelegationContextEnv(spawned().customEnvVars ?? {});
			expect(carried.status).toBe('ok');
			if (carried.status !== 'ok') return;

			const admitted = await manager.admitSpawn(
				{
					sessionId: 'target-ai-tab-1',
					toolType: 'claude-code',
					cwd,
					command: '/usr/local/bin/claude',
					args: ['--print'],
					prompt: 'from the participant',
					delegation: carried.context,
					dispatchedAs: { requestId: 'req-grandchild', attemptId: 'att-grandchild' },
				} as ProcessConfig,
				{ peer: 'in-process' }
			);
			expect(admitted.state).toBe('admitted');
			const { context } = port.asked[1];
			expect(context.delegation).toEqual({
				chain: [
					{ kind: 'service', id: ROOM },
					{ kind: 'agent', id: PARTICIPANT },
					{ kind: 'agent', id: 'target' },
				],
				grantRef: null,
			});
			expect(context.identity).toEqual({
				requestId: 'req-grandchild',
				idempotencyKey: 'req-grandchild',
				attemptId: 'att-grandchild',
				runId: 'req-grandchild',
				rootRunId: ROOM,
				parentRunId: PARTICIPANT,
			});
			expect(context.traceId).toBe(`delegated:${ROOM}:req-grandchild:att-grandchild`);
			expect(context.workflow).toBeNull();
			expect(context.policyRevision).toBe(1);
		});

		it('binds a consult (no room, no record) as a chat turn of its own, stamping nothing', async () => {
			const port = fakeSpawnPort();
			const { manager, spawned } = managedManager(port);
			expect(await turn('cross-agent-req-1', manager)).toMatchObject({ success: true });
			const { context } = port.asked[0];
			expect(context.delegation).toEqual({ chain: [], grantRef: null });
			expect(context.identity).toMatchObject({ runId: null, rootRunId: null, parentRunId: null });
			expect(context.identity.requestId).not.toBe('cross-agent-req-1');
			expect(spawned().customEnvVars ?? {}).not.toHaveProperty(MANAGED_DELEGATION_ENV_VAR);
		});

		it('a record planted in the agent variables neither widens the binding nor reaches the process: the room child does', async () => {
			const port = fakeSpawnPort();
			const { manager, spawned } = managedManager(port);
			const planted: ManagedDelegationContext = {
				contractVersion: MANAGED_CONTRACT_VERSION,
				identity: {
					requestId: 'forged',
					idempotencyKey: 'forged',
					attemptId: 'forged',
					runId: 'forged',
					rootRunId: 'forged',
					parentRunId: null,
				},
				traceId: 'forged',
				workflow: {
					workflowId: 'wf',
					version: 'v1',
					triggerEventId: 'evt',
					ownerEpoch: '9',
					fencingToken: 'forged-fence',
				},
				delegation: { chain: [], grantRef: 'grant-forged' },
				policyRevision: 99,
			};
			await turn(PARTICIPANT, manager, delegationContextEnv(planted));
			const { context } = port.asked[0];
			expect(context.workflow).toBeNull();
			expect(context.delegation).toEqual({
				chain: [
					{ kind: 'service', id: ROOM },
					{ kind: 'agent', id: PARTICIPANT },
				],
				grantRef: null,
			});
			expect(context.identity.rootRunId).toBe(ROOM);
			const stamped = readDelegationContextEnv(spawned().customEnvVars ?? {});
			expect(stamped).toEqual({
				status: 'ok',
				context: groupChatTurnContext({ processId: PARTICIPANT }),
			});
		});

		/**
		 * The enrolled desktop, as it stands (CP-03): the real host adapter over the
		 * real socket client and the fake endpoint daemon. A room turn's context
		 * carries the room's chain, the adapter describes no chain to the endpoint
		 * and strips none, so the turn is refused unavailable before the endpoint
		 * is asked anything, and nothing runs.
		 */
		it('is refused unavailable on an enrolled desktop, unasked at the endpoint, with nothing spawned (CP-03)', async () => {
			const INSTALLATION = {
				installationId: 'inst-test',
				runtimeId: 'desktop-1',
				processEpoch: 'e1',
			};
			let executions = 0;
			const fake = await startFakeEndpoint({
				registrationRequired: true,
				capabilities: ['execution', 'telemetry'],
				operations: {
					execution: () => {
						executions += 1;
						return { outcome: 'denied', reason: 'policy_denied' };
					},
				},
			});
			const endpoint: EndpointPort = createLocalEndpointClient({
				socketPath: fake.socketPath,
				timeoutMs: 1_000,
			});
			try {
				await endpoint.registration.challenge({ runtimeId: 'desktop-1', processEpoch: 'e1' });
				await endpoint.registration.redeem();
				const attached = await endpoint.attach({
					installationId: 'inst-test',
					runtimeId: 'desktop-1',
					processEpoch: 'e1',
					components: [{ id: 'maestro', kind: 'maestro', version: '1.1.0-RC' }],
					supportedProtocols: [1],
					supportedCapabilities: ['attachment', 'compatibility', 'execution', 'telemetry'],
					requiredCapabilities: ['execution'],
				});
				expect(attached.status).toBe('ok');
				const view: ManagedIdentityView = {
					status: 'ok',
					reason: null,
					message: null,
					record: {
						version: 1,
						installationId: 'inst-test',
						tenantId: 'tenant-1',
						orgId: 'org-1',
						enrollmentId: 'enr-1',
						endpoint: {
							socketPath: fake.socketPath,
							bindingDigest: 'a'.repeat(64),
							trustRootDigest: null,
						},
						management: 'enrolled',
						registration: null,
						policy: {
							desiredRevision: 3,
							appliedRevision: 3,
							observedAt: '2026-10-21T12:00:00.000Z',
						},
						enrolledAt: '2026-10-21T12:00:00.000Z',
						updatedAt: '2026-10-21T12:00:00.000Z',
					},
				};
				const status = (): ManagedEnrollmentStatus => {
					const connection = endpoint.state();
					return {
						identity: view,
						connection,
						endpoint: connection?.status ?? null,
						authority: 'registered',
						reason: null,
						pendingApproval: null,
						lastDenial: null,
					};
				};
				const adapter = createManagedHostAdapter({
					installation: INSTALLATION,
					identity: { read: () => view },
					endpoint,
					status,
					now: () => Date.parse('2026-10-21T12:00:00Z'),
					newId: () => 'lease-1',
				});
				// The desktop port: the adapter's authority and policy, the real verifier.
				const verifier = fakeSpawnPort();
				const port: ProcessSpawnAuthorityPort = {
					standing: () => 'managed',
					authority: adapter.authority,
					policy: () => adapter.policy(),
					verify: (input) => verifier.verify(input),
				};
				const { manager, cli } = managedManager(port);

				const result = await turn(PARTICIPANT, manager);

				expect(result).toMatchObject({
					pid: -1,
					success: false,
					managed: { state: 'unavailable' },
				});
				expect(result.error).toContain('a delegation chain of 2');
				expect(result.error).toContain('CP-03');
				expect(cli).not.toHaveBeenCalled();
				expect(executions).toBe(0);
				expect(
					fake.calls
						.filter((c) => c.path === '/v1/invoke')
						.map((c) => (c.body as { operation?: string }).operation)
				).not.toContain('execution');
				expect(adapter.authority.live()).toHaveLength(0);
				expect(manager.admissionOf(PARTICIPANT)).toBeNull();
			} finally {
				await endpoint.close();
				await fake.close();
			}
		});
	});
});
