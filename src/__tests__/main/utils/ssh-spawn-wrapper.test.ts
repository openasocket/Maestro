import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Covers the two things the wrapper decides that its callers cannot see:
 * which env vars actually cross the SSH boundary, and what it does when the
 * remote the user picked no longer resolves.
 */

const mockGetSshRemoteConfig = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-remote-resolver', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../shared/maestro-lib/launch/ssh-remote-resolver')
	>()),
	getSshRemoteConfig: (...args: unknown[]) => mockGetSshRemoteConfig(...args),
}));

const mockBuildSshCommand = vi.fn();
const mockBuildSshCommandWithStdin = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-command-builder', () => ({
	buildSshCommand: (...args: unknown[]) => mockBuildSshCommand(...args),
	buildSshCommandWithStdin: (...args: unknown[]) => mockBuildSshCommandWithStdin(...args),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
	wrapManagedSpawnWithSsh,
	wrapSpawnWithSsh,
	sshUnresolvedRemoteMessage,
	type SshRemoteEndpointRead,
} from '../../../main/utils/ssh-spawn-wrapper';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import type { SshRemoteSettingsStore } from '../../../main/utils/ssh-remote-resolver';

const remote = {
	id: 'jennifer-box',
	name: 'Jennifer',
	host: 'jennifer.local',
	username: 'pedram',
	enabled: true,
};

const sshStore = { getSshRemotes: () => [remote] } as unknown as SshRemoteSettingsStore;

/** Read the `env` the wrapper handed to whichever builder it chose. */
function envPassedToBuilder(builder: ReturnType<typeof vi.fn>): Record<string, string> {
	return (builder.mock.calls[0][1] as { env: Record<string, string> }).env;
}

describe('wrapSpawnWithSsh', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSshRemoteConfig.mockReturnValue({ config: remote, source: 'session' });
		mockBuildSshCommand.mockResolvedValue({
			command: 'ssh',
			args: ['jennifer.local', 'claude'],
			remoteCommandLine: 'claude',
		});
		mockBuildSshCommandWithStdin.mockResolvedValue({
			command: 'ssh',
			args: ['jennifer.local'],
			stdinScript: '#!/bin/bash',
			remoteCommandLine: 'claude',
		});
	});

	const baseConfig = {
		command: '/opt/homebrew/bin/claude',
		args: ['--print'],
		cwd: '/remote/project',
		agentBinaryName: 'claude',
	};

	describe('blank env values', () => {
		it('does not export blank values to the remote host', async () => {
			// Nothing of the local env crosses the SSH boundary, so a blank here can
			// only ever produce `export FOO=''` on the remote - a set-but-empty
			// variable, which is what kills an agent that reads it as a path.
			await wrapSpawnWithSsh(
				{
					...baseConfig,
					customEnvVars: { CLAUDE_CONFIG_DIR: '', PADDED: '  ', KEPT: 'value' },
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			const env = envPassedToBuilder(mockBuildSshCommand);
			expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
			expect('PADDED' in env).toBe(false);
			expect(env.KEPT).toBe('value');
		});

		it('drops blanks on the large-prompt stdin path too', async () => {
			await wrapSpawnWithSsh(
				{
					...baseConfig,
					prompt: 'x'.repeat(4001),
					customEnvVars: { CLAUDE_CONFIG_DIR: '', KEPT: 'value' },
				},
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			const env = envPassedToBuilder(mockBuildSshCommandWithStdin);
			expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
			expect(env.KEPT).toBe('value');
		});

		it('still stamps the turn-origin marker after the user layers', async () => {
			// The marker is not a user value, so stripping must not reach it, and an
			// agent override must not be able to relabel a Cue run as interactive.
			await wrapSpawnWithSsh(
				{ ...baseConfig, customEnvVars: { MAESTRO_QUERY_SOURCE: 'user' }, querySource: 'cue' },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(envPassedToBuilder(mockBuildSshCommand).MAESTRO_QUERY_SOURCE).toBe('cue');
		});
	});

	describe('stdin-script launch', () => {
		// Only a stdin-script launch can record the remote agent's pid, which is
		// what lets Stop reach the agent and not only the local ssh client.
		it('launches a small prompt through the stdin script when asked, prompt still in argv', async () => {
			const result = await wrapSpawnWithSsh(
				{ ...baseConfig, prompt: 'do the thing', launchViaStdinScript: true },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(mockBuildSshCommandWithStdin).toHaveBeenCalledTimes(1);
			const options = mockBuildSshCommandWithStdin.mock.calls[0][1] as {
				args: string[];
				stdinInput?: string;
			};
			expect(options.args).toContain('do the thing');
			expect(options.stdinInput).toBeUndefined();
			expect(result.sshStdinScript).toBe('#!/bin/bash');
			expect(result.prompt).toBeUndefined();
		});

		it('keeps the inline command for a small prompt by default', async () => {
			const result = await wrapSpawnWithSsh(
				{ ...baseConfig, prompt: 'do the thing' },
				{ enabled: true, remoteId: 'jennifer-box' },
				sshStore
			);

			expect(mockBuildSshCommand).toHaveBeenCalledTimes(1);
			expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
			expect(result.sshStdinScript).toBeUndefined();
		});
	});

	describe('unresolved remote', () => {
		it('reports sshRemoteUsed: null rather than throwing', async () => {
			// The wrapper itself degrades to local on purpose; the CONTRACT is that
			// callers detect it. Locking the shape in keeps a future "helpful" throw
			// from silently changing what every call site has to handle.
			mockGetSshRemoteConfig.mockReturnValue({ config: null, source: 'session' });

			const result = await wrapSpawnWithSsh(
				baseConfig,
				{ enabled: true, remoteId: 'gone' },
				sshStore
			);

			expect(result.sshRemoteUsed).toBeNull();
			expect(result.command).toBe('/opt/homebrew/bin/claude');
			// The trap: the cwd handed back is the REMOTE's, so a caller that takes
			// this result runs locally against a path that is missing or wrong.
			expect(result.cwd).toBe('/remote/project');
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
		});

		it('names the remote in the message callers are meant to throw', () => {
			expect(sshUnresolvedRemoteMessage({ enabled: true, remoteId: 'jennifer-box' })).toContain(
				'"jennifer-box"'
			);
			expect(sshUnresolvedRemoteMessage({ enabled: true, remoteId: null })).toContain(
				'could not be resolved'
			);
		});
	});

	it('leaves the config untouched when SSH is switched off', async () => {
		const result = await wrapSpawnWithSsh(
			{ ...baseConfig, customEnvVars: { KEPT: 'value' } },
			{ enabled: false, remoteId: null },
			sshStore
		);

		expect(result.sshRemoteUsed).toBeNull();
		expect(result.customEnvVars).toEqual({ KEPT: 'value' });
		expect(mockGetSshRemoteConfig).not.toHaveBeenCalled();
	});
});

/**
 * MRC-08-04: the managed wrap. With SSH on it never answers with a local
 * launch: an unresolved remote is the resolver's refusal, a resolved remote
 * is handed the launch only once the runtime there attests a standing this
 * host accepts, and the endpoint identity rides the wrap. SSH off is the
 * standalone wrap.
 */
describe('wrapManagedSpawnWithSsh', () => {
	const baseConfig = {
		command: '/opt/homebrew/bin/claude',
		args: ['--print'],
		cwd: '/remote/project',
		agentBinaryName: 'claude',
	};
	const expect_ = {
		tenantId: 'tenant-1',
		orgId: 'org-1',
		providerId: 'claude-code',
		policyRevision: 3 as number | null,
	};
	const identity = {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installationId: 'inst-remote',
		runtimeId: 'headless-42',
		processEpoch: 'epoch-remote',
		tenantId: 'tenant-1',
		orgId: 'org-1',
		authorityId: 'endpoint-remote',
		policyRevision: 3,
		authority: 'registered' as const,
		routes: [{ providerId: 'claude-code', route: 'ssh', managed: 'implemented' as const }],
	};
	const sshOn = { enabled: true, remoteId: 'jennifer-box' };

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetSshRemoteConfig.mockReturnValue({ config: remote, source: 'session' });
		mockBuildSshCommand.mockResolvedValue({
			command: 'ssh',
			args: ['jennifer.local', 'claude'],
			remoteCommandLine: 'claude',
		});
	});

	it('is the standalone local wrap when SSH is off, and asks the remote nothing', async () => {
		const readEndpoint = vi.fn();
		const outcome = await wrapManagedSpawnWithSsh(
			baseConfig,
			{ enabled: false, remoteId: null },
			sshStore,
			{
				expect: expect_,
				readEndpoint,
			}
		);
		expect(outcome).toMatchObject({ ok: true, target: { kind: 'local' } });
		if (!outcome.ok) throw new Error('expected ok');
		expect(outcome.wrapped.sshRemoteUsed).toBeNull();
		expect(outcome.wrapped.sshRemoteEndpoint).toBeUndefined();
		expect(readEndpoint).not.toHaveBeenCalled();
	});

	it('hands the launch to a qualified remote with its endpoint identity on the wrap', async () => {
		const readEndpoint = vi.fn(
			async (): Promise<SshRemoteEndpointRead> => ({ status: 'attested', identity, via: 'probe' })
		);
		const outcome = await wrapManagedSpawnWithSsh(baseConfig, sshOn, sshStore, {
			expect: expect_,
			readEndpoint,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error('expected ok');
		expect(readEndpoint).toHaveBeenCalledWith(remote);
		expect(outcome.wrapped.sshRemoteUsed).toEqual(remote);
		expect(outcome.wrapped.command).toBe('ssh');
		expect(outcome.wrapped.sshRemoteEndpoint).toEqual(identity);
		expect(outcome.target).toEqual({ kind: 'remote', remote, endpoint: identity });
	});

	it("refuses an unresolved remote with the resolver's reason, before asking the remote", async () => {
		const readEndpoint = vi.fn();
		const outcome = await wrapManagedSpawnWithSsh(
			baseConfig,
			{ enabled: true, remoteId: 'gone' },
			sshStore,
			{ expect: expect_, readEndpoint }
		);
		expect(outcome).toMatchObject({ ok: false, reason: 'remote-not-found' });
		if (outcome.ok) throw new Error('expected refusal');
		expect(outcome.message).toContain('nothing ran on this machine');
		expect(readEndpoint).not.toHaveBeenCalled();
		expect(mockBuildSshCommand).not.toHaveBeenCalled();
	});

	it.each([
		[
			'unreachable',
			{ status: 'unreachable' as const, reason: 'Connection timed out.' },
			'Connection timed out.',
		],
		[
			'unattested',
			{ status: 'unattested' as const, reason: 'no Maestro runtime is running on the remote' },
			'no Maestro runtime',
		],
		[
			'attesting an unverified ssh route',
			{
				status: 'attested' as const,
				identity: {
					...identity,
					routes: [{ ...identity.routes[0], managed: 'unverified' as const }],
				},
				via: 'probe',
			},
			'route table says unverified',
		],
		[
			'enrolled with another tenant',
			{
				status: 'attested' as const,
				identity: { ...identity, tenantId: 'tenant-2' },
				via: 'probe',
			},
			'tenant tenant-2',
		],
	])(
		'refuses a resolved remote that is %s, and builds no ssh command',
		async (_case, read, fragment) => {
			const outcome = await wrapManagedSpawnWithSsh(baseConfig, sshOn, sshStore, {
				expect: expect_,
				readEndpoint: async () => read,
			});
			expect(outcome).toMatchObject({ ok: false, reason: 'remote-unqualified' });
			if (outcome.ok) throw new Error('expected refusal');
			expect(outcome.message).toContain(fragment);
			expect(outcome.message).toContain('nothing ran on the remote unmanaged');
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(mockBuildSshCommandWithStdin).not.toHaveBeenCalled();
		}
	);

	it('refuses, never degrades, when the remote is lost between qualifying and wrapping', async () => {
		mockGetSshRemoteConfig.mockReturnValue({ config: null, source: 'none' });
		const outcome = await wrapManagedSpawnWithSsh(baseConfig, sshOn, sshStore, {
			expect: expect_,
			readEndpoint: async () => ({ status: 'attested', identity, via: 'probe' }),
		});
		expect(outcome).toMatchObject({ ok: false, reason: 'remote-not-found' });
		if (outcome.ok) throw new Error('expected refusal');
		expect(outcome.message).toBe(sshUnresolvedRemoteMessage(sshOn));
	});
});
