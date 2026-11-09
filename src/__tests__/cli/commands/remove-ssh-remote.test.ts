/**
 * @file remove-ssh-remote.test.ts
 * @description Tests for the remove-ssh-remote CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	readSshRemotes: vi.fn(),
	resolveSshRemoteId: vi.fn(),
	readSettingValue: vi.fn(),
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

import { removeSshRemote } from '../../../cli/commands/remove-ssh-remote';
import {
	readSshRemotes,
	resolveSshRemoteId,
	readSettingValue,
} from '../../../cli/services/storage';
import {
	writeSettingThroughHost,
	reportDesktopWriteFailure,
} from '../../../cli/services/managed-desktop-write';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

const mockRemote = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Dev Server',
	host: '192.168.1.100',
	port: 22,
	username: 'deploy',
	privateKeyPath: '',
	enabled: true,
	...overrides,
});

describe('remove-ssh-remote command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should remove a remote successfully', async () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		await removeSshRemote('remote-1', {});

		expect(writeSettingThroughHost).toHaveBeenCalledWith('sshRemotes', [], undefined);
		expect(formatSuccess).toHaveBeenCalledWith('Removed SSH remote "Dev Server" (remote-1)');
	});

	it('should clear default when removing the default remote', async () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue('remote-1');

		await removeSshRemote('remote-1', {});

		expect(writeSettingThroughHost).toHaveBeenCalledWith('defaultSshRemoteId', null, undefined);
	});

	it('should not clear default when removing a non-default remote', async () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue('other-remote');

		await removeSshRemote('remote-1', {});

		expect(writeSettingThroughHost).toHaveBeenCalledTimes(1);
		expect(writeSettingThroughHost).not.toHaveBeenCalledWith(
			'defaultSshRemoteId',
			expect.anything(),
			undefined
		);
	});

	it('should output JSON on success', async () => {
		vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
		vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		await removeSshRemote('remote-1', { json: true });

		const output = consoleSpy.mock.calls[0][0];
		const parsed = JSON.parse(output);
		expect(parsed.success).toBe(true);
		expect(parsed.id).toBe('remote-1');
		expect(parsed.name).toBe('Dev Server');
	});

	it('should error when ID cannot be resolved', async () => {
		vi.mocked(resolveSshRemoteId).mockImplementation(() => {
			throw new Error('SSH remote not found: xyz');
		});

		await removeSshRemote('xyz', {});

		expect(formatError).toHaveBeenCalledWith('SSH remote not found: xyz');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should only remove the target remote from the list', async () => {
		const remote1 = mockRemote({ id: 'r1', name: 'Server A' });
		const remote2 = mockRemote({ id: 'r2', name: 'Server B' });
		vi.mocked(resolveSshRemoteId).mockReturnValue('r1');
		vi.mocked(readSshRemotes).mockReturnValue([remote1, remote2]);
		vi.mocked(readSettingValue).mockReturnValue(null);

		await removeSshRemote('r1', {});

		expect(writeSettingThroughHost).toHaveBeenCalledWith('sshRemotes', [remote2], undefined);
	});

	describe('the host command boundary (MCOMP-19-05A)', () => {
		it('reports a refused write and never clears the default', async () => {
			vi.mocked(resolveSshRemoteId).mockReturnValue('remote-1');
			vi.mocked(readSshRemotes).mockReturnValue([mockRemote()]);
			vi.mocked(readSettingValue).mockReturnValue('remote-1');
			vi.mocked(writeSettingThroughHost).mockRejectedValueOnce(
				Object.assign(new Error('Held by policy'), { managed: { state: 'denied' } })
			);

			await removeSshRemote('remote-1', { json: true });

			expect(writeSettingThroughHost).toHaveBeenCalledTimes(1);
			expect(writeSettingThroughHost).toHaveBeenCalledWith('sshRemotes', [], true);
			expect(reportDesktopWriteFailure).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Held by policy' }),
				true,
				'remove SSH remote "Dev Server"'
			);
			expect(consoleSpy).not.toHaveBeenCalled();
		});
	});
});
