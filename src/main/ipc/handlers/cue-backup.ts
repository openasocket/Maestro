/**
 * Cue Backup IPC Handlers
 *
 * Thin transport layer over `cue-backup-manager` - every handler is a
 * one-line delegation. Reads and writes to the user-data `cue-backups/`
 * directory. Used by the Cue modal's Backup tab.
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	createCueBackup,
	deleteCueBackup,
	getCueBackupDiffStatus,
	inspectCueBackup,
	listCueBackups,
	readCueBackupFile,
	readLiveCueFile,
	restoreCueBackupAll,
	restoreCueBackupFile,
	type CueBackupEffectOptions,
} from '../../cue/backup/cue-backup-manager';
import type { InstallAuthority } from '../../enterprise/install-policy';
import {
	callingLocalEffectActor,
	type LocalEffectAuthority,
} from '../../enterprise/local-effects-policy';
import type { SessionsData } from '../../stores/types';
import type {
	CueBackupDiffStatusMap,
	CueBackupManifest,
	CueBackupRestoreResult,
	CueBackupSummary,
} from '../../../shared/cue-backup-types';

const LOG_CONTEXT = '[CueBackup]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface CueBackupHandlerDependencies {
	sessionsStore: Store<SessionsData>;
	/** The managed local-effects ceiling a backup delete is held to (MRC2-04-09A); absent or null holds nothing. */
	localEffects?: () => LocalEffectAuthority | null;
	/** The managed install ceiling a restore holds the archive to, by digest (MRC2-04-09A); absent or null holds nothing. */
	install?: () => InstallAuthority | null;
}

export function registerCueBackupHandlers(deps: CueBackupHandlerDependencies): void {
	const { sessionsStore } = deps;
	// Read at the boundary, before any await, so a hold binds the transport this call came over.
	const effects = (): CueBackupEffectOptions => ({
		localEffects: deps.localEffects?.() ?? null,
		install: deps.install?.() ?? null,
		actor: callingLocalEffectActor(),
	});

	ipcMain.handle(
		'cueBackup:create',
		withIpcErrorLogging(handlerOpts('create'), async (): Promise<CueBackupSummary> => {
			const sessions = sessionsStore.get('sessions', []);
			return createCueBackup(sessions);
		})
	);

	ipcMain.handle(
		'cueBackup:list',
		withIpcErrorLogging(handlerOpts('list'), async (): Promise<CueBackupSummary[]> => {
			return listCueBackups();
		})
	);

	ipcMain.handle(
		'cueBackup:inspect',
		withIpcErrorLogging(
			handlerOpts('inspect'),
			async (args: { filePath: string }): Promise<CueBackupManifest> => {
				return inspectCueBackup(args.filePath);
			}
		)
	);

	ipcMain.handle(
		'cueBackup:readFile',
		withIpcErrorLogging(
			handlerOpts('readFile'),
			async (args: {
				filePath: string;
				workspaceId: string;
				relativePath: string;
			}): Promise<string | null> => {
				return readCueBackupFile(args.filePath, args.workspaceId, args.relativePath);
			}
		)
	);

	ipcMain.handle(
		'cueBackup:readLive',
		withIpcErrorLogging(
			handlerOpts('readLive'),
			async (args: { cwd: string; relativePath: string }): Promise<string | null> => {
				return readLiveCueFile(args.cwd, args.relativePath);
			}
		)
	);

	ipcMain.handle(
		'cueBackup:restoreFile',
		withIpcErrorLogging(
			handlerOpts('restoreFile'),
			async (args: {
				filePath: string;
				workspaceId: string;
				relativePath: string;
			}): Promise<void> => {
				restoreCueBackupFile(args.filePath, args.workspaceId, args.relativePath, effects());
			}
		)
	);

	ipcMain.handle(
		'cueBackup:restoreAll',
		withIpcErrorLogging(
			handlerOpts('restoreAll'),
			async (args: { filePath: string }): Promise<CueBackupRestoreResult> => {
				return restoreCueBackupAll(args.filePath, effects());
			}
		)
	);

	ipcMain.handle(
		'cueBackup:getDiffStatus',
		withIpcErrorLogging(
			handlerOpts('getDiffStatus'),
			async (args: { filePath: string }): Promise<CueBackupDiffStatusMap> => {
				return getCueBackupDiffStatus(args.filePath);
			}
		)
	);

	ipcMain.handle(
		'cueBackup:delete',
		withIpcErrorLogging(
			handlerOpts('delete'),
			async (args: { filePath: string }): Promise<void> => {
				await deleteCueBackup(args.filePath, effects());
			}
		)
	);
}
