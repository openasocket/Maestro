/**
 * The filesystem deletes under the local-effects ceiling (MRC2-04-09).
 * `fs:delete` and `fs:deleteMany` are `destructive` effects held once per
 * call (a batch once, with its count) before anything is removed, locally or
 * on an SSH remote: a denied delete leaves every path in place and rejects
 * with the reason by code, a `confirm` class asks the operator first, and
 * standalone deletes what it deleted before.
 *
 * The real handlers and the real policy source run here over a mocked
 * `fs/promises` and `remote-fs`, so a refusal is proven by the absence of
 * any removal call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';

import { createLocalEffectsPolicySource } from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import { registerFilesystemHandlers } from '../../../../main/ipc/handlers/filesystem';
import { getSshRemoteById } from '../../../../main/stores';
import { logger } from '../../../../main/utils/logger';
import { deleteManyRemote, deleteRemote } from '../../../../main/utils/remote-fs';
import { runAsTransport } from '../../../../main/web-server/auth/transport-actor';

const registered = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			registered.set(channel, handler);
		}),
		on: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/file-tree-walk', () => ({ walkLocalFileTree: vi.fn() }));
vi.mock('../../../../main/utils/drag-out-icon', () => ({ getDragOutIcon: vi.fn() }));
vi.mock('fs', () => {
	const existsSync = vi.fn(() => true);
	const createWriteStream = vi.fn();
	return { existsSync, createWriteStream, default: { existsSync, createWriteStream } };
});
vi.mock('archiver', () => ({ default: vi.fn() }));
vi.mock('os', () => ({ default: { homedir: vi.fn(() => '/Users/testuser') } }));
vi.mock('fs/promises', () => ({
	default: {
		readdir: vi.fn(),
		readFile: vi.fn(),
		stat: vi.fn(),
		writeFile: vi.fn(),
		rename: vi.fn(),
		mkdir: vi.fn(),
		rm: vi.fn(),
		unlink: vi.fn(),
		cp: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/remote-fs', () => ({
	readDirRemote: vi.fn(),
	readFileRemote: vi.fn(),
	readBinaryFileRemoteAsBase64: vi.fn(),
	readFileRemoteAbortable: vi.fn(),
	writeFileRemote: vi.fn(),
	mkdirRemote: vi.fn(),
	statRemote: vi.fn(),
	directorySizeRemote: vi.fn(),
	renameRemote: vi.fn(),
	deleteRemote: vi.fn(),
	deleteManyRemote: vi.fn(),
	existsRemote: vi.fn(),
	countItemsRemote: vi.fn(),
	compressFolderRemote: vi.fn(),
	listTreeRemote: vi.fn(),
}));
vi.mock('../../../../main/stores', () => ({ getSshRemoteById: vi.fn() }));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

describe('filesystem deletes under the local-effects ceiling (MRC2-04-09)', () => {
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
		if (mode === 'none') registerFilesystemHandlers();
		else registerFilesystemHandlers({ localEffects: () => source });
		return source;
	}

	const call = (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args);

	beforeEach(() => {
		vi.clearAllMocks();
		registered.clear();
		vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as never);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
	});

	afterEach(() => {
		registered.clear();
	});

	it('standalone and no authority: deletes run as before, locally and on a remote, with nothing asked', async () => {
		register('standalone');
		expect(await call('fs:delete', '/test/file.txt')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
		expect(await call('fs:deleteMany', ['/test/a.txt', '/test/b.txt'])).toEqual({
			results: [
				{ path: '/test/a.txt', success: true },
				{ path: '/test/b.txt', success: true },
			],
		});
		expect(fs.unlink).toHaveBeenCalledTimes(3);
		expect(confirm).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();

		registered.clear();
		register('none');
		expect(await call('fs:delete', '/test/file.txt')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledTimes(4);
	});

	it('enrolled with no ceiling: refused unavailable by its own code, every path left in place, locally and remotely', async () => {
		register('enrolled');
		await expect(call('fs:delete', '/test/file.txt')).rejects.toThrow(
			/^\[managed-unavailable\] the managed local-effects ceiling is unavailable \(no local-effects ceiling is installed for policy revision 3\); deleting \/test\/file\.txt for the operator is refused$/
		);
		await expect(call('fs:deleteMany', ['/test/a.txt', '/test/b.txt', '/test/c'])).rejects.toThrow(
			/^\[managed-unavailable\] .*deleting items \(3 items, the first \/test\/a\.txt\) for the operator is refused$/
		);
		vi.mocked(getSshRemoteById).mockReturnValue({
			id: 'remote-1',
			host: 'h',
			username: 'u',
		} as never);
		await expect(
			call('fs:delete', '/remote/file.txt', { sshRemoteId: 'remote-1' })
		).rejects.toThrow('[managed-unavailable]');
		await expect(
			call('fs:deleteMany', ['/remote/a.txt'], { sshRemoteId: 'remote-1' })
		).rejects.toThrow('[managed-unavailable]');
		expect(fs.stat).not.toHaveBeenCalled();
		expect(fs.unlink).not.toHaveBeenCalled();
		expect(fs.rm).not.toHaveBeenCalled();
		expect(deleteRemote).not.toHaveBeenCalled();
		expect(deleteManyRemote).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(4);
		expect(vi.mocked(logger.warn).mock.calls[1][2]).toEqual({
			code: 'unavailable',
			receipt: {
				policyRevision: 3,
				class: 'destructive',
				effect: 'delete',
				actor: 'the operator',
				target: '/test/a.txt',
				count: 3,
				outcome: 'unavailable',
			},
		});
	});

	it('a denying ceiling leaves the files in place; an allowing one deletes with a receipt; an empty batch holds nothing', async () => {
		register('ceiling', 'deny');
		await expect(call('fs:delete', '/test/file.txt')).rejects.toThrow(
			'[managed-denied] the local-effects ceiling denies the destructive class; deleting /test/file.txt for the operator is refused'
		);
		await expect(call('fs:deleteMany', ['/test/a.txt'])).rejects.toThrow('[managed-denied]');
		expect(fs.unlink).not.toHaveBeenCalled();
		expect(await call('fs:deleteMany', [])).toEqual({ results: [] });
		expect(logger.warn).toHaveBeenCalledTimes(2);

		registered.clear();
		register('ceiling', 'allow');
		expect(await call('fs:delete', '/test/file.txt')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledWith('/test/file.txt');
		expect(confirm).not.toHaveBeenCalled();
	});

	it('a confirm class asks once for the whole batch; declined removes nothing, confirmed removes every path', async () => {
		register('ceiling', 'confirm');
		confirm.mockResolvedValueOnce('declined');
		await expect(call('fs:deleteMany', ['/test/a.txt', '/test/b.txt'])).rejects.toThrow(
			'[managed-declined] the operator declined deleting items (2 items, the first /test/a.txt)'
		);
		expect(fs.unlink).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm).toHaveBeenCalledWith({
			effect: 'delete',
			class: 'destructive',
			target: '/test/a.txt',
			count: 2,
			actor: 'the operator',
			message: expect.stringContaining('destructive class before deleting items (2 items'),
		});
		confirm.mockResolvedValueOnce('confirmed');
		expect(await call('fs:deleteMany', ['/test/a.txt', '/test/b.txt'])).toEqual({
			results: [
				{ path: '/test/a.txt', success: true },
				{ path: '/test/b.txt', success: true },
			],
		});
		expect(fs.unlink).toHaveBeenCalledTimes(2);
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it('the hold binds the transport the call was admitted over, and a refusal is not wrapped as a failed delete', async () => {
		register('ceiling', 'deny');
		await expect(
			runAsTransport({ kind: 'cli' }, () => call('fs:delete', '/test/file.txt'))
		).rejects.toThrow(/^\[managed-denied\] .*for maestro-cli is refused$/);
		expect(vi.mocked(logger.warn).mock.calls[0][2]).toMatchObject({
			receipt: { actor: 'maestro-cli' },
		});
	});
});
