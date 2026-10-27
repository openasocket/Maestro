/**
 * The Auto Run deletes under the local-effects ceiling (MRC2-04-09A).
 * `autorun:deleteImage`, `autorun:deleteFolder`, `autorun:restoreBackup`
 * (which consumes its backup) and `autorun:deleteBackups` are `destructive`
 * effects held once per call before anything is removed, locally or on an
 * SSH remote: a denied delete leaves every file in place and answers the
 * handler's error with the reason by code, a sweep is one hold with its
 * count, a `confirm` class asks the operator once, and standalone deletes
 * what it deleted before.
 *
 * The real handlers and the real policy source run here over a mocked
 * `fs/promises` and `remote-fs`, so a refusal is proven by the absence of
 * any removal call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import { createLocalEffectsPolicySource } from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import { registerAutorunHandlers } from '../../../../main/ipc/handlers/autorun';
import { logger } from '../../../../main/utils/logger';
import {
	deleteRemote,
	readDirRemote,
	readFileRemote,
	writeFileRemote,
} from '../../../../main/utils/remote-fs';
import { runAsTransport } from '../../../../main/web-server/auth/transport-actor';

const registered = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			registered.set(channel, handler);
		}),
		on: vi.fn(),
	},
	BrowserWindow: vi.fn(),
	App: vi.fn(),
}));
vi.mock('fs/promises', () => {
	const api = {
		readdir: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		stat: vi.fn(),
		access: vi.fn(),
		mkdir: vi.fn(),
		unlink: vi.fn(),
		rm: vi.fn(),
		copyFile: vi.fn(),
	};
	return { ...api, default: api };
});
vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));
vi.mock('electron-store', () => ({ default: vi.fn() }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	writeFileRemote: vi.fn(),
	mkdirRemote: vi.fn(),
	deleteRemote: vi.fn(),
	existsRemote: vi.fn(),
	readBinaryFileRemoteAsBase64: vi.fn(),
	writeBinaryFileRemote: vi.fn(),
	listTreeRemote: vi.fn(),
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

const sshRemote = { id: 'remote-1', name: 'r', host: 'h', username: 'u' };
const settingsStore = { get: vi.fn(() => [sshRemote]) };

const dirent = (name: string, dir = false) => ({
	name,
	isDirectory: () => dir,
	isFile: () => !dir,
	isSymbolicLink: () => false,
});

describe('Auto Run deletes under the local-effects ceiling (MRC2-04-09A)', () => {
	const confirm = vi.fn<(prompt: unknown) => Promise<'confirmed' | 'declined' | 'unavailable'>>();

	function register(
		mode: 'standalone' | 'enrolled' | 'ceiling' | 'none',
		verdict: 'allow' | 'deny' | 'confirm' = 'allow'
	) {
		const source = createLocalEffectsPolicySource({
			identity: { read: () => (mode === 'standalone' ? { status: 'none' } : enrolled) },
			policy: () => ({ appliedRevision: 3 }),
			confirm,
		});
		if (mode === 'ceiling') {
			const out = source.install({
				policyRevision: 3,
				classes: [{ class: 'destructive', verdict }],
			});
			if (!out.installed) throw new Error(out.problems.join('; '));
		}
		registerAutorunHandlers({
			mainWindow: null,
			getMainWindow: () => null as unknown as BrowserWindow,
			app: { on: vi.fn() } as unknown as App,
			settingsStore: settingsStore as never,
			...(mode === 'none' ? {} : { localEffects: () => source }),
		});
		return source;
	}

	const call = (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args);

	beforeEach(() => {
		vi.clearAllMocks();
		registered.clear();
		vi.mocked(fs.access).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(fs.copyFile).mockResolvedValue(undefined);
		vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as never);
		vi.mocked(fs.readdir).mockResolvedValue([
			dirent('doc1.backup.md'),
			dirent('doc2.md'),
			dirent('sub', true),
		] as never);
		vi.mocked(fs.readdir).mockResolvedValueOnce([
			dirent('doc1.backup.md'),
			dirent('doc2.md'),
			dirent('sub', true),
		] as never);
		vi.mocked(fs.readdir).mockResolvedValueOnce([dirent('nested.backup.md')] as never);
		vi.mocked(deleteRemote).mockResolvedValue({ success: true });
		vi.mocked(readFileRemote).mockResolvedValue({ success: true, data: '# backup' });
		vi.mocked(writeFileRemote).mockResolvedValue({ success: true });
		vi.mocked(readDirRemote).mockResolvedValue({
			success: true,
			data: [
				{ name: 'a.backup.md', isDirectory: false, isSymlink: false },
				{ name: 'b.backup.md', isDirectory: false, isSymlink: false },
			],
		} as never);
	});

	afterEach(() => {
		registered.clear();
	});

	it('standalone and no authority: every delete runs as before, locally and on a remote, with nothing asked', async () => {
		register('standalone');
		expect(await call('autorun:deleteImage', '/f', 'images/a.png')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledWith(path.join('/f', 'images/a.png'));
		expect(await call('autorun:deleteFolder', '/p')).toEqual({ success: true });
		expect(fs.rm).toHaveBeenCalledTimes(2);
		expect(await call('autorun:restoreBackup', '/f', 'doc1')).toEqual({ success: true });
		expect(fs.copyFile).toHaveBeenCalledTimes(1);
		expect(fs.unlink).toHaveBeenCalledWith(path.join('/f', 'doc1.backup.md'));
		expect(await call('autorun:deleteBackups', '/f')).toEqual({ success: true, deletedCount: 2 });
		expect(fs.unlink).toHaveBeenCalledTimes(4);
		expect(await call('autorun:deleteBackups', '/r', 'remote-1')).toEqual({
			success: true,
			deletedCount: 2,
		});
		expect(deleteRemote).toHaveBeenCalledTimes(2);
		expect(confirm).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();

		registered.clear();
		register('none');
		expect(await call('autorun:deleteImage', '/f', 'images/a.png')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledTimes(5);
	});

	it('enrolled with no ceiling: every delete is refused unavailable by code, nothing removed, locally and remotely', async () => {
		register('enrolled');
		const refused =
			/\[managed-unavailable\] the managed local-effects ceiling is unavailable \(no local-effects ceiling is installed for policy revision 3\)/;

		const image = await call('autorun:deleteImage', '/f', 'images/a.png');
		expect(image.success).toBe(false);
		expect(image.error).toMatch(refused);
		expect(image.error).toContain(`deleting ${path.join('/f', 'images/a.png')} for the operator`);

		const remoteImage = await call('autorun:deleteImage', '/r', 'images/a.png', 'remote-1');
		expect(remoteImage.error).toMatch(refused);
		expect(deleteRemote).not.toHaveBeenCalled();

		const folder = await call('autorun:deleteFolder', '/p');
		expect(folder.error).toMatch(refused);
		expect(folder.error).toContain('deleting items (2 items, the first');
		expect(fs.rm).not.toHaveBeenCalled();

		const restore = await call('autorun:restoreBackup', '/f', 'doc1');
		expect(restore.error).toMatch(refused);
		expect(fs.copyFile).not.toHaveBeenCalled();

		const remoteRestore = await call('autorun:restoreBackup', '/r', 'doc1', 'remote-1');
		expect(remoteRestore.error).toMatch(refused);
		expect(readFileRemote).toHaveBeenCalledTimes(1);
		expect(writeFileRemote).not.toHaveBeenCalled();

		const sweep = await call('autorun:deleteBackups', '/f');
		expect(sweep.error).toMatch(refused);
		expect(sweep.error).toContain(
			`deleting items (2 items, the first ${path.join('/f', 'doc1.backup.md')})`
		);
		const remoteSweep = await call('autorun:deleteBackups', '/r', 'remote-1');
		expect(remoteSweep.error).toMatch(refused);

		expect(fs.unlink).not.toHaveBeenCalled();
		expect(deleteRemote).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(7);
		expect(vi.mocked(logger.warn).mock.calls[5]).toEqual([
			'Delete refused by the managed local-effects ceiling; nothing was removed',
			'[AutoRun]',
			{
				code: 'unavailable',
				receipt: {
					policyRevision: 3,
					class: 'destructive',
					effect: 'delete',
					actor: 'the operator',
					target: path.join('/f', 'doc1.backup.md'),
					count: 2,
					outcome: 'unavailable',
				},
			},
		]);
	});

	it('the local gates still answer first: a bad path, a missing image or backup and a non-folder refuse before the hold', async () => {
		register('enrolled');
		expect((await call('autorun:deleteImage', '/f', 'doc1.md')).error).toContain(
			'Invalid image path'
		);
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'));
		expect((await call('autorun:deleteImage', '/f', 'images/a.png')).error).toContain(
			'Image file not found'
		);
		vi.mocked(fs.access).mockRejectedValueOnce(new Error('ENOENT'));
		expect((await call('autorun:restoreBackup', '/f', 'doc1')).error).toContain(
			'Backup file not found'
		);
		vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
		expect(await call('autorun:deleteFolder', '/p')).toEqual({ success: true });
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('a denying ceiling leaves everything in place; an allowing one deletes with a receipt; a sweep that finds nothing holds nothing', async () => {
		register('ceiling', 'deny');
		const sweep = await call('autorun:deleteBackups', '/f');
		expect(sweep.error).toContain(
			'[managed-denied] the local-effects ceiling denies the destructive class'
		);
		expect((await call('autorun:deleteFolder', '/p')).error).toContain('[managed-denied]');
		expect(fs.unlink).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
		vi.mocked(fs.readdir).mockReset();
		vi.mocked(fs.readdir).mockResolvedValue([dirent('doc2.md')] as never);
		expect(await call('autorun:deleteBackups', '/f')).toEqual({ success: true, deletedCount: 0 });
		expect(logger.warn).toHaveBeenCalledTimes(2);

		registered.clear();
		register('ceiling', 'allow');
		expect(await call('autorun:deleteFolder', '/p')).toEqual({ success: true });
		expect(fs.rm).toHaveBeenCalledTimes(2);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('a confirm class asks once for the whole folder pair; declined removes nothing, confirmed removes both', async () => {
		register('ceiling', 'confirm');
		confirm.mockResolvedValueOnce('declined');
		const declined = await call('autorun:deleteFolder', '/p');
		expect(declined.error).toContain(
			`[managed-declined] the operator declined deleting items (2 items, the first ${path.join('/p', '.maestro/playbooks')})`
		);
		expect(fs.rm).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith({
			effect: 'delete',
			class: 'destructive',
			target: path.join('/p', '.maestro/playbooks'),
			count: 2,
			actor: 'the operator',
			message: expect.stringContaining('destructive class before deleting items (2 items'),
		});
		confirm.mockResolvedValueOnce('confirmed');
		expect(await call('autorun:deleteFolder', '/p')).toEqual({ success: true });
		expect(fs.rm).toHaveBeenCalledTimes(2);
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it('the hold binds the transport the call was admitted over', async () => {
		register('ceiling', 'deny');
		const result = await runAsTransport({ kind: 'cli' }, () =>
			call('autorun:deleteImage', '/f', 'images/a.png')
		);
		expect(result.error).toMatch(/\[managed-denied\] .*for maestro-cli is refused/);
		expect(vi.mocked(logger.warn).mock.calls[0][2]).toMatchObject({
			receipt: { actor: 'maestro-cli' },
		});
		expect(fs.unlink).not.toHaveBeenCalled();
	});
});
