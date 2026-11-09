/**
 * Local writes that REPLACE what is already there, under the local-effects
 * ceiling (MCOMP-19-03): an overwriting import (`fs:copyPath`), a rename onto a
 * taken name (`fs:rename`), a download over a chosen file
 * (`fs:downloadRemoteFile`), and the Auto Run backup, restore and working copy.
 * Each is held as the destructive `delete` of what it replaces, once with its
 * count, before anything is created, copied or moved; a write onto a free name
 * holds nothing. These run over a REAL temporary directory, so a refusal is
 * proven by what is still on disk (content unchanged, no folder created).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, BrowserWindow } from 'electron';
import * as nodeFs from 'fs';
import os from 'os';
import path from 'path';

import {
	createLocalEffectsPolicySource,
	replacedLocalPaths,
} from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import { registerAutorunHandlers } from '../../../../main/ipc/handlers/autorun';
import { registerFilesystemHandlers } from '../../../../main/ipc/handlers/filesystem';
import { getSshRemoteById } from '../../../../main/stores';
import { readBinaryFileRemoteAsBase64 } from '../../../../main/utils/remote-fs';

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
vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));
vi.mock('electron-store', () => ({ default: vi.fn() }));
vi.mock('../../../../main/utils/file-tree-walk', () => ({ walkLocalFileTree: vi.fn() }));
vi.mock('../../../../main/utils/drag-out-icon', () => ({ getDragOutIcon: vi.fn() }));
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

describe('local writes that replace an existing path are held before mutation (MCOMP-19-03)', () => {
	const confirm = vi.fn<(prompt: unknown) => Promise<'confirmed' | 'declined' | 'unavailable'>>();
	let root: string;

	const write = (rel: string, content: string) => {
		const p = path.join(root, rel);
		nodeFs.mkdirSync(path.dirname(p), { recursive: true });
		nodeFs.writeFileSync(p, content);
		return p;
	};
	const read = (rel: string) => nodeFs.readFileSync(path.join(root, rel), 'utf8');
	const exists = (rel: string) => nodeFs.existsSync(path.join(root, rel));

	function register(
		mode: 'standalone' | 'enrolled' | 'ceiling',
		verdict: 'allow' | 'deny' | 'confirm' = 'allow'
	) {
		registered.clear();
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
		registerFilesystemHandlers({ localEffects: () => source });
		registerAutorunHandlers({
			mainWindow: null,
			getMainWindow: () => null as unknown as BrowserWindow,
			app: { on: vi.fn() } as unknown as App,
			localEffects: () => source,
		});
	}
	const call = (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args);

	beforeEach(() => {
		vi.clearAllMocks();
		// realpath so the expected receipt paths match on macOS (/var -> /private/var).
		root = nodeFs.realpathSync(nodeFs.mkdtempSync(path.join(os.tmpdir(), 'mcomp-19-03-')));
	});

	afterEach(() => {
		registered.clear();
		nodeFs.rmSync(root, { recursive: true, force: true });
	});

	it('replacedLocalPaths names only entries already there, by their real path, and never the move source itself', async () => {
		const file = write('a.txt', 'a');
		nodeFs.mkdirSync(path.join(root, 'dir'));
		nodeFs.symlinkSync(file, path.join(root, 'link'));
		nodeFs.symlinkSync(path.join(root, 'gone'), path.join(root, 'dangling'));

		expect(await replacedLocalPaths([path.join(root, 'free.txt')])).toEqual([]);
		expect(
			await replacedLocalPaths([file, path.join(root, 'dir'), path.join(root, 'link')])
		).toEqual([file, path.join(root, 'dir'), file]);
		// A dangling link is still an entry a write would replace.
		expect(await replacedLocalPaths([path.join(root, 'dangling')])).toEqual([
			path.join(root, 'dangling'),
		]);
		// The same entry as the source (a case-only rename on a folding volume) replaces nothing.
		expect(await replacedLocalPaths([file], { source: file })).toEqual([]);
		expect(await replacedLocalPaths([file], { source: path.join(root, 'dir') })).toEqual([file]);
	});

	it('an overwriting import over an existing file is refused before the copy; onto a free name it holds nothing', async () => {
		const src = write('src/new.txt', 'NEW');
		const dest = write('ws/new.txt', 'OLD');
		register('ceiling', 'deny');

		await expect(call('fs:copyPath', src, dest, { overwrite: true })).rejects.toThrow(
			/^\[managed-denied\] the local-effects ceiling denies the destructive class; deleting .*new\.txt for the operator is refused$/
		);
		expect(read('ws/new.txt')).toBe('OLD');

		// Creating is not deleting: a free destination copies under the same denying ceiling.
		const free = path.join(root, 'ws/other.txt');
		expect(await call('fs:copyPath', src, free, { overwrite: true })).toEqual({ success: true });
		expect(read('ws/other.txt')).toBe('NEW');
		// Without overwrite the copy errors on an existing name by itself; nothing is held.
		await expect(call('fs:copyPath', src, dest)).rejects.toThrow(/^Failed to copy:/);
		expect(read('ws/new.txt')).toBe('OLD');
	});

	it('a rename onto a taken name is refused with both files intact; a free name and the same entry rename freely', async () => {
		write('a.txt', 'A');
		write('b.txt', 'B');
		register('ceiling', 'deny');

		await expect(
			call('fs:rename', path.join(root, 'a.txt'), path.join(root, 'b.txt'))
		).rejects.toThrow(/^\[managed-denied\]/);
		expect(read('a.txt')).toBe('A');
		expect(read('b.txt')).toBe('B');

		expect(await call('fs:rename', path.join(root, 'a.txt'), path.join(root, 'c.txt'))).toEqual({
			success: true,
		});
		expect(read('c.txt')).toBe('A');
		expect(await call('fs:rename', path.join(root, 'c.txt'), path.join(root, 'c.txt'))).toEqual({
			success: true,
		});
	});

	it('a download over a chosen existing file is refused before the remote is read', async () => {
		const dest = write('dl/out.bin', 'KEEP');
		vi.mocked(getSshRemoteById).mockReturnValue({ id: 'r1' } as never);
		vi.mocked(readBinaryFileRemoteAsBase64).mockResolvedValue({
			success: true,
			data: Buffer.from('REMOTE').toString('base64'),
		} as never);
		register('enrolled');

		await expect(call('fs:downloadRemoteFile', '/remote/out.bin', 'r1', dest)).rejects.toThrow(
			/^\[managed-unavailable\]/
		);
		expect(readBinaryFileRemoteAsBase64).not.toHaveBeenCalled();
		expect(read('dl/out.bin')).toBe('KEEP');
	});

	it('standalone replaces as before with nothing asked; a confirm ceiling asks once, and a decline replaces nothing', async () => {
		const src = write('src.txt', 'NEW');
		const dest = write('dest.txt', 'OLD');
		register('standalone');
		expect(await call('fs:copyPath', src, dest, { overwrite: true })).toEqual({ success: true });
		expect(read('dest.txt')).toBe('NEW');
		expect(confirm).not.toHaveBeenCalled();

		write('dest.txt', 'OLD');
		register('ceiling', 'confirm');
		confirm.mockResolvedValueOnce('declined');
		await expect(call('fs:copyPath', src, dest, { overwrite: true })).rejects.toThrow(
			/^\[managed-declined\] the operator declined deleting .*dest\.txt$/
		);
		expect(read('dest.txt')).toBe('OLD');
		confirm.mockResolvedValueOnce('confirmed');
		expect(await call('fs:copyPath', src, dest, { overwrite: true })).toEqual({ success: true });
		expect(read('dest.txt')).toBe('NEW');
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(confirm.mock.calls[0][0]).toMatchObject({
			effect: 'delete',
			class: 'destructive',
			target: dest,
			count: 1,
		});
	});

	it('Auto Run: a backup over an existing backup is refused with the old backup intact; the first backup is free', async () => {
		write('docs/Plan.md', 'v1');
		register('ceiling', 'deny');
		expect(await call('autorun:createBackup', path.join(root, 'docs'), 'Plan')).toEqual({
			success: true,
			backupFilename: 'Plan.backup.md',
		});
		expect(read('docs/Plan.backup.md')).toBe('v1');

		write('docs/Plan.md', 'v2');
		const out = await call('autorun:createBackup', path.join(root, 'docs'), 'Plan');
		expect(out.success).toBe(false);
		expect(out.error).toMatch(/\[managed-denied\]/);
		expect(read('docs/Plan.backup.md')).toBe('v1');
	});

	it('Auto Run: a restore holds the backup it consumes and the document it replaces in ONE hold', async () => {
		write('docs/Plan.md', 'edited');
		write('docs/Plan.backup.md', 'original');
		register('ceiling', 'confirm');
		confirm.mockResolvedValueOnce('declined');

		const out = await call('autorun:restoreBackup', path.join(root, 'docs'), 'Plan');
		expect(out.success).toBe(false);
		expect(out.error).toMatch(/\[managed-declined\]/);
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0][0]).toMatchObject({ effect: 'delete', count: 2 });
		expect(read('docs/Plan.md')).toBe('edited');
		expect(read('docs/Plan.backup.md')).toBe('original');
	});

	it('Auto Run: a working copy over an existing one is refused with the earlier copy intact; a free name creates its folder', async () => {
		write('docs/Loop.md', 'source');
		vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
		try {
			write('docs/runs/Loop-1700000000000-loop-1.md', 'earlier');
			register('enrolled');
			const refused = await call('autorun:createWorkingCopy', path.join(root, 'docs'), 'Loop', 1);
			expect(refused.success).toBe(false);
			expect(refused.error).toMatch(/\[managed-unavailable\]/);
			expect(read('docs/runs/Loop-1700000000000-loop-1.md')).toBe('earlier');

			// A free name in a sub-folder: allowed, and the folder appears only then.
			register('ceiling', 'deny');
			expect(exists('docs/runs/Sub')).toBe(false);
			write('docs/Sub/Step.md', 'step');
			const ok = await call('autorun:createWorkingCopy', path.join(root, 'docs'), 'Sub/Step', 2);
			expect(ok).toMatchObject({
				success: true,
				workingCopyPath: 'runs/Sub/Step-1700000000000-loop-2',
			});
			expect(read('docs/runs/Sub/Step-1700000000000-loop-2.md')).toBe('step');
		} finally {
			vi.restoreAllMocks();
		}
	});
});
