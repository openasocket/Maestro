/**
 * @file create-ssh-remote.test.ts
 * @description Tests for the create-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock crypto for deterministic UUIDs
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'mock-uuid-1234'),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	dataDirHasManagedBinding: vi.fn(() => false),
}));

// The host boundary: the command tests record what reaches it; the last block
// drives the real one over a mocked desktop connection.
vi.mock('../../../cli/services/managed-desktop-write', () => ({
	writeSettingThroughHost: vi.fn(async () => 'file'),
	reportDesktopWriteFailure: vi.fn(),
}));
vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createSshRemote } from '../../../cli/commands/create-ssh-remote';
import {
	readSshRemotes,
	writeSettingValue,
	dataDirHasManagedBinding,
} from '../../../cli/services/storage';
import {
	writeSettingThroughHost,
	reportDesktopWriteFailure,
} from '../../../cli/services/managed-desktop-write';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';

/** The sshRemotes array the command handed to the host boundary. */
function writtenRemotes(): unknown {
	const call = vi.mocked(writeSettingThroughHost).mock.calls.find(([key]) => key === 'sshRemotes');
	return call?.[1];
}
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('create-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(readSshRemotes).mockReturnValue([]);
	});

	describe('successful creation', () => {
		it('should create a remote with minimal options', async () => {
			await createSshRemote('Dev Server', { host: '192.168.1.100' });

			expect(writtenRemotes()).toEqual([
				expect.objectContaining({
					id: 'mock-uuid-1234',
					name: 'Dev Server',
					host: '192.168.1.100',
					port: 22,
					username: '',
					enabled: true,
				}),
			]);
			expect(formatSuccess).toHaveBeenCalledWith('Created SSH remote "Dev Server"');
		});

		it('should store extra ssh -o options', async () => {
			await createSshRemote('Tunnelled', {
				host: 'tailcat-devbox',
				sshOption: ['ProxyCommand=/opt/homebrew/bin/tailcat tcABC 22', 'ConnectTimeout=45'],
			});

			expect(writtenRemotes()).toEqual([
				expect.objectContaining({
					sshOptions: {
						ProxyCommand: '/opt/homebrew/bin/tailcat tcABC 22',
						ConnectTimeout: '45',
					},
				}),
			]);
		});

		it('should leave sshOptions unset when none are passed', async () => {
			await createSshRemote('Plain', { host: 'example.com' });

			const written = writtenRemotes() as Array<{ sshOptions?: unknown }>;
			expect(written[0].sshOptions).toBeUndefined();
		});

		it('should reject a malformed --ssh-option and not write', async () => {
			await createSshRemote('Bad', { host: 'example.com', sshOption: ['ProxyCommand'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Expected KEY=VALUE'));
			// process.exit is stubbed to a no-op here, so this only asserts the exit
			// was requested; in production it terminates before the write.
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject an attempt to override the reserved RequestTTY option', async () => {
			await createSshRemote('Bad', { host: 'example.com', sshOption: ['RequestTTY=force'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('cannot be overridden'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should create a remote with all options', async () => {
			await createSshRemote('Full Remote', {
				host: 'server.example.com',
				port: '2222',
				username: 'deploy',
				key: '~/.ssh/deploy_key',
				env: ['NODE_ENV=production', 'PORT=8080'],
			});

			expect(writtenRemotes()).toEqual([
				expect.objectContaining({
					name: 'Full Remote',
					host: 'server.example.com',
					port: 2222,
					username: 'deploy',
					privateKeyPath: '~/.ssh/deploy_key',
					remoteEnv: { NODE_ENV: 'production', PORT: '8080' },
				}),
			]);
		});

		it('should create with ssh-config mode', async () => {
			await createSshRemote('Config Remote', {
				host: 'dev-server',
				sshConfig: true,
			});

			expect(writtenRemotes()).toEqual([
				expect.objectContaining({
					host: 'dev-server',
					useSshConfig: true,
					sshConfigHost: 'dev-server',
				}),
			]);
		});

		it('should create in disabled state', async () => {
			await createSshRemote('Disabled', { host: 'server.com', disabled: true });

			expect(writtenRemotes()).toEqual([expect.objectContaining({ enabled: false })]);
		});

		it('should set as default when --set-default is provided', async () => {
			await createSshRemote('Default', { host: 'server.com', setDefault: true });

			expect(writeSettingThroughHost).toHaveBeenLastCalledWith(
				'defaultSshRemoteId',
				'mock-uuid-1234',
				undefined
			);
		});

		it('should append to existing remotes', async () => {
			const existing = {
				id: 'existing-id',
				name: 'Existing',
				host: 'old.com',
				port: 22,
				username: '',
				privateKeyPath: '',
				enabled: true,
			};
			vi.mocked(readSshRemotes).mockReturnValue([existing]);

			await createSshRemote('New', { host: 'new.com' });

			expect(writtenRemotes()).toEqual([
				existing,
				expect.objectContaining({ name: 'New', host: 'new.com' }),
			]);
		});

		it('should output JSON on success', async () => {
			await createSshRemote('JSON Remote', { host: 'server.com', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.id).toBe('mock-uuid-1234');
			expect(parsed.name).toBe('JSON Remote');
		});
	});

	describe('validation errors', () => {
		it('should reject missing host', async () => {
			await createSshRemote('No Host', { host: '' });

			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid port', async () => {
			await createSshRemote('Bad Port', { host: 'server.com', port: '99999' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject non-numeric port', async () => {
			await createSshRemote('Bad Port', { host: 'server.com', port: 'abc' });

			expect(formatError).toHaveBeenCalledWith('--port must be a number between 1 and 65535');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid env format', async () => {
			await createSshRemote('Bad Env', { host: 'server.com', env: ['NOEQUALS'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid --env format'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('the host command boundary (MCOMP-19-05)', () => {
		it('reports a refused write and never writes the default', async () => {
			vi.mocked(writeSettingThroughHost).mockRejectedValueOnce(
				Object.assign(new Error('Held by policy'), { managed: { state: 'denied' } })
			);

			await createSshRemote('Held', { host: 'server.com', setDefault: true, json: true });

			expect(writeSettingThroughHost).toHaveBeenCalledTimes(1);
			expect(reportDesktopWriteFailure).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Held by policy' }),
				true,
				'create SSH remote "Held"'
			);
			expect(consoleSpy).not.toHaveBeenCalled();
		});

		it('passes --json through so an enrolled offline refusal stays machine-readable', async () => {
			await createSshRemote('J', { host: 'server.com', json: true });

			expect(writeSettingThroughHost).toHaveBeenCalledWith('sshRemotes', expect.any(Array), true);
		});
	});

	describe('writeSettingThroughHost (real)', () => {
		type Real = typeof import('../../../cli/services/managed-desktop-write');
		let real: Real;

		beforeEach(async () => {
			real = await vi.importActual<Real>('../../../cli/services/managed-desktop-write');
			vi.mocked(writeSettingValue).mockReturnValue(true);
			vi.mocked(dataDirHasManagedBinding).mockReturnValue(false);
		});

		function desktopReplies(reply: unknown) {
			const sendCommand = vi.fn(async () => reply);
			vi.mocked(withMaestroClient).mockImplementation(async (send) =>
				send({ sendCommand } as never)
			);
			return sendCommand;
		}

		it('sends a held key to the running desktop and leaves the file alone', async () => {
			const sendCommand = desktopReplies({ type: 'set_setting_result', success: true });

			await expect(real.writeSettingThroughHost('sshRemotes', [], false)).resolves.toBe('desktop');

			expect(sendCommand).toHaveBeenCalledWith(
				{ type: 'set_setting', key: 'sshRemotes', value: [] },
				'set_setting_result'
			);
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('throws the desktop refusal with its managed state before any file write', async () => {
			desktopReplies({ type: 'error', message: 'Locked by policy', managed: { state: 'denied' } });

			await expect(
				real.writeSettingThroughHost('defaultSshRemoteId', 'x', false)
			).rejects.toMatchObject({ message: 'Locked by policy', managed: { state: 'denied' } });
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('writes the file when standalone and no desktop runs', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new MaestroNotRunningError('no-discovery-file')
			);

			await expect(real.writeSettingThroughHost('sshRemotes', [], false)).resolves.toBe('file');
			expect(writeSettingValue).toHaveBeenCalledWith('sshRemotes', []);
		});

		it('refuses an enrolled data dir with no desktop instead of writing the file', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new MaestroNotRunningError('no-discovery-file')
			);
			vi.mocked(dataDirHasManagedBinding).mockReturnValue(true);

			await expect(real.writeSettingThroughHost('sshRemotes', [], true)).rejects.toBeInstanceOf(
				MaestroNotRunningError
			);
			expect(writeSettingValue).not.toHaveBeenCalled();
		});

		it('writes a key no policy can hold straight to the file', async () => {
			await expect(real.writeSettingThroughHost('fontZoom', 1.2, false)).resolves.toBe('file');
			expect(withMaestroClient).not.toHaveBeenCalled();
			expect(writeSettingValue).toHaveBeenCalledWith('fontZoom', 1.2);
		});
	});
});
