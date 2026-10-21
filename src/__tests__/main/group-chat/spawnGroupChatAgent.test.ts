/**
 * @file spawnGroupChatAgent.test.ts
 * @description Verifies the Group Chat spawn helper forwards `maxWaitSeconds`
 * into maestro-p's `--max-wait`. Without this the interactive (TUI) path falls
 * back to maestro-p's 300s idle default and silently kills a still-working
 * moderator/participant whose JSONL output stalls past 300s, even though the
 * router would wait the full supervising timeout. Regression guard for that.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { spawnGroupChatAgent } from '../../../main/group-chat/spawnGroupChatAgent';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import type { AgentConfig } from '../../../main/agents/definitions';
import type { IProcessManager } from '../../../main/group-chat/group-chat-moderator';
import {
	groupChatRoomContext,
	groupChatTurnContext,
} from '../../../shared/maestro-lib/groupchat/spawn';
import {
	readDelegationContextEnv,
	type ManagedDelegationContext,
} from '../../../shared/maestro-lib/managed/delegation';

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
});
