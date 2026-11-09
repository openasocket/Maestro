/**
 * @file update-ssh-remote.test.ts
 * @description Tests for the update-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	resolveSshRemoteId: vi.fn((id: string) => id),
}));

// The host boundary (MCOMP-19-05A): record what reaches it.
vi.mock('../../../cli/services/managed-desktop-write', () => ({
	writeSettingThroughHost: vi.fn(async () => 'file'),
	reportDesktopWriteFailure: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { updateSshRemote } from '../../../cli/commands/update-ssh-remote';
import { readSshRemotes, resolveSshRemoteId } from '../../../cli/services/storage';
import {
	writeSettingThroughHost,
	reportDesktopWriteFailure,
} from '../../../cli/services/managed-desktop-write';
import { formatError } from '../../../cli/output/formatter';

const mockRemote = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Dev Server',
	host: '192.168.1.100',
	port: 22,
	username: 'deploy',
	privateKeyPath: '~/.ssh/id_rsa',
	enabled: true,
	...overrides,
});

/** The single config handed to the host boundary's sshRemotes write. */
function written(): SshRemoteConfig {
	const call = vi.mocked(writeSettingThroughHost).mock.calls.find(([key]) => key === 'sshRemotes');
	return (call?.[1] as SshRemoteConfig[])[0];
}

describe('update-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(resolveSshRemoteId).mockImplementation((id: string) => id);
	});

	describe('field updates', () => {
		it('leaves untouched fields alone', async () => {
			await updateSshRemote('remote-1', { name: 'Renamed' });

			expect(written()).toMatchObject({
				name: 'Renamed',
				host: '192.168.1.100',
				port: 22,
				username: 'deploy',
			});
		});

		it('updates host and port', async () => {
			await updateSshRemote('remote-1', { host: 'tailcat-devbox', port: '2222' });

			expect(written()).toMatchObject({ host: 'tailcat-devbox', port: 2222 });
		});

		it('treats an empty username as clearing the override', async () => {
			// Blank hands the decision back to ~/.ssh/config or the system default,
			// which is exactly what a tailcat-style setup wants.
			await updateSshRemote('remote-1', { username: '' });

			expect(written().username).toBe('');
		});

		it('parses --enabled as a tri-state boolean', async () => {
			await updateSshRemote('remote-1', { enabled: 'false' });

			expect(written().enabled).toBe(false);
		});

		it('rejects a non-boolean --enabled', async () => {
			await updateSshRemote('remote-1', { enabled: 'maybe' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('--enabled'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('switches the remote to ssh-config mode', async () => {
			await updateSshRemote('remote-1', { host: 'tailcat-devbox', sshConfig: 'true' });

			expect(written()).toMatchObject({
				useSshConfig: true,
				sshConfigHost: 'tailcat-devbox',
			});
		});
	});

	describe('ssh -o options', () => {
		it('adds options to a remote that had none', async () => {
			await updateSshRemote('remote-1', {
				sshOption: ['ProxyCommand=/opt/homebrew/bin/tailcat tcABC 22'],
			});

			expect(written().sshOptions).toEqual({
				ProxyCommand: '/opt/homebrew/bin/tailcat tcABC 22',
			});
		});

		it('merges with existing options rather than replacing them', async () => {
			// A single edit must not silently drop the rest of the set.
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			await updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=45'] });

			expect(written().sshOptions).toEqual({
				ProxyCommand: 'tailcat tcABC 22',
				ConnectTimeout: '45',
			});
		});

		it('overwrites the value of an option already present', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ConnectTimeout: '45' } }),
			]);

			await updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=90'] });

			expect(written().sshOptions).toEqual({ ConnectTimeout: '90' });
		});

		it('clears every option with --clear-ssh-options', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			await updateSshRemote('remote-1', { clearSshOptions: true });

			expect(written().sshOptions).toBeUndefined();
		});

		it('clears then re-adds when both flags are passed', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'old', ConnectTimeout: '45' } }),
			]);

			await updateSshRemote('remote-1', {
				clearSshOptions: true,
				sshOption: ['ProxyCommand=new'],
			});

			expect(written().sshOptions).toEqual({ ProxyCommand: 'new' });
		});

		it('splits a ProxyCommand value on the first equals only', async () => {
			await updateSshRemote('remote-1', {
				sshOption: ['ProxyCommand=tailcat --key=default tcABC 22'],
			});

			expect(written().sshOptions).toEqual({
				ProxyCommand: 'tailcat --key=default tcABC 22',
			});
		});

		it('rejects an attempt to override the reserved RequestTTY option', async () => {
			await updateSshRemote('remote-1', { sshOption: ['RequestTTY=force'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('cannot be overridden'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('parking entries (the CLI spelling of the eye button)', () => {
		it('switches an ssh option off, keeping its value', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ProxyCommand: 'tailcat tcABC 22', ConnectTimeout: '45' } }),
			]);

			await updateSshRemote('remote-1', { disableSshOption: ['ProxyCommand'] });

			expect(written().sshOptions).toEqual({ ConnectTimeout: '45' });
			expect(written().sshOptionsDisabled).toEqual({ ProxyCommand: 'tailcat tcABC 22' });
		});

		it('switches a parked ssh option back on', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptionsDisabled: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			await updateSshRemote('remote-1', { enableSshOption: ['ProxyCommand'] });

			expect(written().sshOptions).toEqual({ ProxyCommand: 'tailcat tcABC 22' });
			expect(written().sshOptionsDisabled).toBeUndefined();
		});

		it('parks and unparks env vars the same way', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ remoteEnv: { FOO: '1' }, remoteEnvDisabled: { BAR: '2' } }),
			]);

			await updateSshRemote('remote-1', { disableEnv: ['FOO'], enableEnv: ['BAR'] });

			expect(written().remoteEnv).toEqual({ BAR: '2' });
			expect(written().remoteEnvDisabled).toEqual({ FOO: '1' });
		});

		it('runs disable before enable so one command can swap which key is live', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({
					sshOptions: { ConnectTimeout: '45' },
					sshOptionsDisabled: { ProxyJump: 'bastion' },
				}),
			]);

			await updateSshRemote('remote-1', {
				disableSshOption: ['ConnectTimeout'],
				enableSshOption: ['ProxyJump'],
			});

			expect(written().sshOptions).toEqual({ ProxyJump: 'bastion' });
			expect(written().sshOptionsDisabled).toEqual({ ConnectTimeout: '45' });
		});

		it('ignores a key that exists in neither record', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptions: { ConnectTimeout: '45' } }),
			]);

			await updateSshRemote('remote-1', { disableSshOption: ['NoSuchOption'] });

			expect(written().sshOptions).toEqual({ ConnectTimeout: '45' });
			expect(written().sshOptionsDisabled).toBeUndefined();
		});

		it('clears the parked record too, so --clear leaves nothing resurrectable', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({
					sshOptions: { ConnectTimeout: '45' },
					sshOptionsDisabled: { ProxyCommand: 'tailcat tcABC 22' },
					remoteEnv: { FOO: '1' },
					remoteEnvDisabled: { BAR: '2' },
				}),
			]);

			await updateSshRemote('remote-1', { clearSshOptions: true, clearEnv: true });

			expect(written().sshOptions).toBeUndefined();
			expect(written().sshOptionsDisabled).toBeUndefined();
			expect(written().remoteEnv).toBeUndefined();
			expect(written().remoteEnvDisabled).toBeUndefined();
		});

		it('reports parked entries in JSON but keeps them out of the resolved set', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([
				mockRemote({ sshOptionsDisabled: { ProxyCommand: 'tailcat tcABC 22' } }),
			]);

			await updateSshRemote('remote-1', { json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.sshOptionsDisabled).toEqual({ ProxyCommand: 'tailcat tcABC 22' });
			expect(parsed.resolvedSshOptions).not.toHaveProperty('ProxyCommand');
		});
	});

	describe('environment variables', () => {
		it('merges with existing env vars', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote({ remoteEnv: { FOO: '1' } })]);

			await updateSshRemote('remote-1', { env: ['BAR=2'] });

			expect(written().remoteEnv).toEqual({ FOO: '1', BAR: '2' });
		});

		it('clears every env var with --clear-env', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote({ remoteEnv: { FOO: '1' } })]);

			await updateSshRemote('remote-1', { clearEnv: true });

			expect(written().remoteEnv).toBeUndefined();
		});
	});

	describe('errors and output', () => {
		it('reports an unknown remote', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);

			await updateSshRemote('nope', { name: 'x' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('not found'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects an out-of-range port', async () => {
			await updateSshRemote('remote-1', { port: '99999' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('sets the remote as default when asked', async () => {
			await updateSshRemote('remote-1', { setDefault: true });

			expect(writeSettingThroughHost).toHaveBeenCalledWith(
				'defaultSshRemoteId',
				'remote-1',
				undefined
			);
		});

		it('emits the resolved option set in JSON mode', async () => {
			await updateSshRemote('remote-1', { sshOption: ['ConnectTimeout=45'], json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.sshOptions).toEqual({ ConnectTimeout: '45' });
			expect(parsed.resolvedSshOptions).toMatchObject({
				ConnectTimeout: '45',
				BatchMode: 'yes',
			});
		});

		it('reports a failure as JSON when --json is set', async () => {
			vi.mocked(readSshRemotes).mockReturnValue([]);

			await updateSshRemote('nope', { name: 'x', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(consoleErrorSpy).not.toHaveBeenCalled();
		});
	});

	describe('the host command boundary (MCOMP-19-05A)', () => {
		it('sends the edited list through the host with --json passed through', async () => {
			await updateSshRemote('remote-1', { name: 'Renamed', json: true });

			expect(writeSettingThroughHost).toHaveBeenCalledWith(
				'sshRemotes',
				[expect.objectContaining({ id: 'remote-1', name: 'Renamed' })],
				true
			);
		});

		it('reports a refused write and never writes the default', async () => {
			vi.mocked(writeSettingThroughHost).mockRejectedValueOnce(
				Object.assign(new Error('Held by policy'), { managed: { state: 'denied' } })
			);

			await updateSshRemote('remote-1', { name: 'Held', setDefault: true, json: true });

			expect(writeSettingThroughHost).toHaveBeenCalledTimes(1);
			expect(reportDesktopWriteFailure).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Held by policy' }),
				true,
				'update SSH remote "Held"'
			);
			expect(consoleSpy).not.toHaveBeenCalled();
		});
	});
});
