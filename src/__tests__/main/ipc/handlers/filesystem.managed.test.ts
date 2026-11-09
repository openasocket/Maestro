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
import {
	deleteManyRemote,
	deleteRemote,
	remotePathWouldBeReplaced,
	renameRemote,
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
	remotePathWouldBeReplaced: vi.fn(),
	countItemsRemote: vi.fn(),
	compressFolderRemote: vi.fn(),
	listTreeRemote: vi.fn(),
}));
vi.mock('../../../../main/stores', () => ({ getSshRemoteById: vi.fn() }));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
// The real replacement probe resolves the ssh binary first; this suite runs it over an ssh double.
vi.mock('../../../../shared/maestro-lib/launch/ssh-path', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/launch/ssh-path')>()),
	resolveSshPath: async () => 'ssh',
}));

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

	describe('a remote write that replaces what is there is held as a delete (MCOMP-21-11A)', () => {
		const remote = { id: 'remote-1', host: 'h', username: 'u' };

		/** Answer the replacement probe with the REAL remote-fs check over an ssh double answering `answer`. */
		async function probeAnswers(answer: { stdout: string; exitCode: number }) {
			const actual = await vi.importActual<typeof import('../../../../main/utils/remote-fs')>(
				'../../../../main/utils/remote-fs'
			);
			const execSsh = vi.fn(async () => ({ stderr: 'stat: unreadable', ...answer }));
			vi.mocked(remotePathWouldBeReplaced).mockImplementation((path, config, options) =>
				actual.remotePathWouldBeReplaced(path, config, options, { execSsh, buildSshArgs: () => [] })
			);
			return execSsh;
		}

		beforeEach(() => {
			vi.mocked(getSshRemoteById).mockReturnValue(remote as never);
			vi.mocked(renameRemote).mockResolvedValue({ success: true } as never);
			vi.mocked(deleteRemote).mockResolvedValue({ success: true } as never);
			vi.mocked(writeFileRemote).mockResolvedValue({ success: true } as never);
			vi.mocked(fs.readFile).mockResolvedValue(Buffer.from('bytes') as never);
			vi.mocked(remotePathWouldBeReplaced).mockResolvedValue(true);
		});

		it('a rename onto a taken name and an overwriting import are refused before any remote mv or cp', async () => {
			register('ceiling', 'deny');
			await expect(call('fs:rename', '/r/old', '/r/taken', 'remote-1')).rejects.toThrow(
				/^\[managed-denied\] .*deleting \/r\/taken for the operator is refused$/
			);
			expect(remotePathWouldBeReplaced).toHaveBeenCalledWith('/r/taken', remote, {
				source: '/r/old',
			});
			await expect(
				call('fs:copyPath', '/local/a.txt', '/r/taken', {
					overwrite: true,
					sshRemoteId: 'remote-1',
				})
			).rejects.toThrow(/^\[managed-denied\] .*deleting \/r\/taken/);
			expect(remotePathWouldBeReplaced).toHaveBeenLastCalledWith('/r/taken', remote, {});
			expect(renameRemote).not.toHaveBeenCalled();
			expect(fs.stat).not.toHaveBeenCalled();
			expect(deleteRemote).not.toHaveBeenCalled();
			expect(writeFileRemote).not.toHaveBeenCalled();
			expect(vi.mocked(logger.warn).mock.calls[0][2]).toMatchObject({
				receipt: { effect: 'delete', class: 'destructive', target: '/r/taken', outcome: 'denied' },
			});
		});

		it('the hold is the destructive delete, asked before the write runs; declined runs nothing, confirmed runs it', async () => {
			register('ceiling', 'confirm');
			confirm.mockResolvedValueOnce('declined');
			await expect(call('fs:rename', '/r/old', '/r/taken', 'remote-1')).rejects.toThrow(
				'[managed-declined]'
			);
			expect(renameRemote).not.toHaveBeenCalled();
			expect(confirm).toHaveBeenCalledWith(
				expect.objectContaining({ effect: 'delete', class: 'destructive', target: '/r/taken' })
			);
			confirm.mockResolvedValueOnce('confirmed');
			expect(await call('fs:rename', '/r/old', '/r/taken', 'remote-1')).toEqual({ success: true });
			expect(renameRemote).toHaveBeenCalledWith('/r/old', '/r/taken', remote);
			confirm.mockResolvedValueOnce('confirmed');
			expect(
				await call('fs:copyPath', '/local/a.txt', '/r/taken', {
					overwrite: true,
					sshRemoteId: 'remote-1',
				})
			).toEqual({ success: true });
			expect(confirm).toHaveBeenCalledTimes(3);
			expect(vi.mocked(confirm).mock.invocationCallOrder[2]).toBeLessThan(
				vi.mocked(deleteRemote).mock.invocationCallOrder[0]
			);
			expect(writeFileRemote).toHaveBeenCalledWith('/r/taken', expect.anything(), remote);
		});

		it('a probe that fails counts as replaced: the real check over ssh exits non-zero and the move is refused', async () => {
			register('ceiling', 'deny');
			const execSsh = await probeAnswers({ stdout: '', exitCode: 1 });
			await expect(call('fs:rename', '/r/old', '/r/unreadable', 'remote-1')).rejects.toThrow(
				'[managed-denied]'
			);
			expect(execSsh).toHaveBeenCalled();
			expect(renameRemote).not.toHaveBeenCalled();
			await probeAnswers({ stdout: 'garbled', exitCode: 0 });
			await expect(call('fs:rename', '/r/old', '/r/unreadable', 'remote-1')).rejects.toThrow(
				'[managed-denied]'
			);
			expect(renameRemote).not.toHaveBeenCalled();
		});

		it('the same entry (-ef) and a free name replace nothing: they run unheld even under a denying ceiling', async () => {
			register('ceiling', 'deny');
			const same = await probeAnswers({ stdout: 'SAME\n', exitCode: 0 });
			expect(await call('fs:rename', '/r/Name', '/r/name', 'remote-1')).toEqual({ success: true });
			const probe = (same.mock.calls[0] as unknown as [string, string[]])[1].at(-1);
			expect(probe).toContain("-ef '/r/Name'");
			await probeAnswers({ stdout: 'ABSENT\n', exitCode: 0 });
			expect(await call('fs:rename', '/r/old', '/r/free', 'remote-1')).toEqual({ success: true });
			expect(
				await call('fs:copyPath', '/local/a.txt', '/r/free', {
					overwrite: true,
					sshRemoteId: 'remote-1',
				})
			).toEqual({ success: true });
			expect(renameRemote).toHaveBeenCalledTimes(2);
			expect(writeFileRemote).toHaveBeenCalledTimes(1);
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('standalone (no authority): no probe is made and the remote move and import run as before', async () => {
			register('none');
			expect(await call('fs:rename', '/r/old', '/r/taken', 'remote-1')).toEqual({ success: true });
			expect(
				await call('fs:copyPath', '/local/a.txt', '/r/taken', {
					overwrite: true,
					sshRemoteId: 'remote-1',
				})
			).toEqual({ success: true });
			expect(remotePathWouldBeReplaced).not.toHaveBeenCalled();
			expect(renameRemote).toHaveBeenCalledTimes(1);
			expect(deleteRemote).toHaveBeenCalledTimes(1);
			expect(writeFileRemote).toHaveBeenCalledTimes(1);
			expect(confirm).not.toHaveBeenCalled();
		});
	});
});
