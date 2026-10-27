/**
 * The Cue backup IPC handlers hand the managed ceilings and the calling
 * transport to the manager (MRC2-04-09A): a restore carries the install
 * authority, a delete the local-effects authority, both the actor the call
 * was admitted over, read at the boundary. Without the deps nothing is handed
 * over, so a standalone desktop holds nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	deleteCueBackup,
	restoreCueBackupAll,
	restoreCueBackupFile,
} from '../../../../main/cue/backup/cue-backup-manager';
import { registerCueBackupHandlers } from '../../../../main/ipc/handlers/cue-backup';
import { runAsTransport } from '../../../../main/web-server/auth/transport-actor';

const registered = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			registered.set(channel, handler);
		}),
	},
}));
vi.mock('../../../../main/cue/backup/cue-backup-manager', () => ({
	createCueBackup: vi.fn(),
	deleteCueBackup: vi.fn(async () => undefined),
	getCueBackupDiffStatus: vi.fn(),
	inspectCueBackup: vi.fn(),
	listCueBackups: vi.fn(),
	readCueBackupFile: vi.fn(),
	readLiveCueFile: vi.fn(),
	restoreCueBackupAll: vi.fn(() => ({ written: 0, skipped: [] })),
	restoreCueBackupFile: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const localEffects = { authorize: vi.fn() };
const install = { authorize: vi.fn(), authorizeMcpServer: vi.fn() };
const sessionsStore = { get: vi.fn(() => []) } as never;

describe('Cue backup handlers hand the ceilings and the transport to the manager (MRC2-04-09A)', () => {
	const call = (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args);

	beforeEach(() => {
		vi.clearAllMocks();
		registered.clear();
	});

	afterEach(() => {
		registered.clear();
	});

	it('with the deps wired, every restore and delete carries both authorities and the operator', async () => {
		registerCueBackupHandlers({
			sessionsStore,
			localEffects: () => localEffects,
			install: () => install,
		});
		const effects = {
			localEffects,
			install,
			actor: { kind: 'transport', actor: { peer: 'in-process' } },
		};
		await call('cueBackup:restoreFile', {
			filePath: '/b.zip',
			workspaceId: 'ws',
			relativePath: 'cue.yaml',
		});
		expect(restoreCueBackupFile).toHaveBeenCalledWith('/b.zip', 'ws', 'cue.yaml', effects);
		await call('cueBackup:restoreAll', { filePath: '/b.zip' });
		expect(restoreCueBackupAll).toHaveBeenCalledWith('/b.zip', effects);
		await call('cueBackup:delete', { filePath: '/b.zip' });
		expect(deleteCueBackup).toHaveBeenCalledWith('/b.zip', effects);
	});

	it('the actor is the transport the call was admitted over, read at the boundary', async () => {
		registerCueBackupHandlers({
			sessionsStore,
			localEffects: () => localEffects,
			install: () => install,
		});
		await runAsTransport({ kind: 'cli' }, () => call('cueBackup:delete', { filePath: '/b.zip' }));
		expect(vi.mocked(deleteCueBackup).mock.calls[0][1]).toMatchObject({
			actor: { kind: 'transport', actor: expect.not.objectContaining({ peer: 'in-process' }) },
		});
	});

	it('without the deps the manager is handed null authorities, so nothing is held; a manager refusal rejects the call', async () => {
		registerCueBackupHandlers({ sessionsStore });
		await call('cueBackup:delete', { filePath: '/b.zip' });
		expect(deleteCueBackup).toHaveBeenCalledWith('/b.zip', {
			localEffects: null,
			install: null,
			actor: { kind: 'transport', actor: { peer: 'in-process' } },
		});
		vi.mocked(deleteCueBackup).mockRejectedValueOnce(new Error('[managed-denied] refused'));
		await expect(call('cueBackup:delete', { filePath: '/b.zip' })).rejects.toThrow(
			'[managed-denied] refused'
		);
	});
});
