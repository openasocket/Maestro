/**
 * The Cue backup restore and delete under the managed ceilings (MRC2-04-09A).
 * A restore inflates an archive into live workspaces, so it is held WHOLE to
 * the install ceiling by the digest of the archive's bytes before it is read
 * (artifact `cue-backup`); a delete is a `destructive` effect held to the
 * local-effects ceiling before the unlink. With no options (a standalone
 * caller) nothing is held.
 *
 * Real files under a temporary user-data directory; only the archive read is
 * replaced, so a refusal is proven by the file still being there and the
 * workspace still being empty.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInstallPolicySource } from '../../../../main/enterprise/install-policy';
import { createLocalEffectsPolicySource } from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import {
	deleteCueBackup,
	restoreCueBackupAll,
	restoreCueBackupFile,
	type CueBackupEffectOptions,
} from '../../../../main/cue/backup/cue-backup-manager';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import { digestFileSha256 } from '../../../../shared/maestro-lib/managed/tui-handshake';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-backup-managed-'));

vi.mock('electron', () => ({
	app: { getPath: () => userData },
}));
vi.mock('archiver', () => ({ default: vi.fn() }));
vi.mock('../../../../main/utils/zip-archive', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/zip-archive')>()),
	readZipArchive: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
const operator: CueBackupEffectOptions['actor'] = {
	kind: 'transport',
	actor: { peer: 'in-process' },
};

describe('Cue backup restore and delete under the managed ceilings (MRC2-04-09A)', () => {
	let workspace: string;
	let backupPath: string;

	function archiveFor(ws: string) {
		const manifest = {
			version: 1,
			createdAt: '2026-10-27T00:00:00.000Z',
			workspaces: [
				{
					id: 'ws_1',
					cwd: ws,
					agents: [],
					files: [{ relativePath: 'cue.yaml', size: 9 }],
				},
			],
		};
		const entries = [
			{ entryName: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
			{ entryName: 'workspaces/ws_1/cue.yaml', data: Buffer.from('pipelines:') },
		];
		return {
			getEntries: () => entries.map(toEntry),
			getEntry: (name: string) => {
				const found = entries.find((e) => e.entryName === name);
				return found ? toEntry(found) : undefined;
			},
		};
	}
	const toEntry = (e: { entryName: string; data: Buffer }) => ({
		entryName: e.entryName,
		isDirectory: false,
		size: e.data.length,
		getData: () => e.data,
	});

	function options(
		mode: 'enrolled' | 'ceiling',
		config: { verdict?: 'allow' | 'deny'; sha256?: string } = {}
	): CueBackupEffectOptions {
		const identity = { read: () => enrolled };
		const policy = () => ({ appliedRevision: 3 });
		const localEffects = createLocalEffectsPolicySource({ identity, policy });
		const install = createInstallPolicySource({ identity, policy });
		if (mode === 'ceiling') {
			localEffects.install({
				policyRevision: 3,
				classes: [{ class: 'destructive', verdict: config.verdict ?? 'allow' }],
			});
			const out = install.install({
				policyRevision: 3,
				pins: config.sha256
					? [{ artifact: 'cue-backup', file: 'b.zip', sha256: config.sha256, source: null }]
					: [],
			});
			if (!out.installed) throw new Error(out.problems.join('; '));
		}
		return { localEffects, install, actor: operator };
	}

	beforeEach(() => {
		vi.clearAllMocks();
		workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-backup-ws-'));
		fs.mkdirSync(path.join(userData, 'cue-backups'), { recursive: true });
		backupPath = path.join(userData, 'cue-backups', 'b.zip');
		fs.writeFileSync(backupPath, Buffer.from('not really a zip, the read is replaced'));
		vi.mocked(readZipArchive).mockReturnValue(archiveFor(workspace));
	});

	afterEach(() => {
		fs.rmSync(workspace, { recursive: true, force: true });
		fs.rmSync(path.join(userData, 'cue-backups'), { recursive: true, force: true });
	});

	const restored = () => path.join(workspace, '.maestro', 'cue.yaml');

	it('with no options a restore writes and a delete unlinks, as before', async () => {
		expect(restoreCueBackupAll(backupPath)).toEqual({ written: 1, skipped: [] });
		expect(fs.readFileSync(restored(), 'utf-8')).toBe('pipelines:');
		await deleteCueBackup(backupPath);
		expect(fs.existsSync(backupPath)).toBe(false);
	});

	it('enrolled with no ceiling: restores are refused unavailable before the archive is read and the delete leaves the file', async () => {
		const opts = options('enrolled');
		expect(() => restoreCueBackupAll(backupPath, opts)).toThrow(
			'[managed-unavailable] the managed install ceiling is unavailable (no install ceiling is installed for policy revision 3)'
		);
		expect(() => restoreCueBackupFile(backupPath, 'ws_1', 'cue.yaml', opts)).toThrow(
			'[managed-unavailable]'
		);
		expect(readZipArchive).not.toHaveBeenCalled();
		expect(fs.existsSync(restored())).toBe(false);
		await expect(deleteCueBackup(backupPath, opts)).rejects.toThrow(
			`[managed-unavailable] the managed local-effects ceiling is unavailable (no local-effects ceiling is installed for policy revision 3); deleting ${backupPath} for the operator is refused`
		);
		expect(fs.existsSync(backupPath)).toBe(true);
	});

	it('a pin on the archive digest admits the restore; a wrong digest or no pin refuses it with nothing written', async () => {
		expect(() =>
			restoreCueBackupAll(backupPath, options('ceiling', { sha256: 'a'.repeat(64) }))
		).toThrow('[managed-digest-mismatch]');
		expect(() => restoreCueBackupAll(backupPath, options('ceiling'))).toThrow(
			'[managed-unpinned] the install ceiling pins no cue-backup b.zip'
		);
		expect(fs.existsSync(restored())).toBe(false);

		const pinned = options('ceiling', { sha256: digestFileSha256(backupPath) });
		expect(restoreCueBackupAll(backupPath, pinned)).toEqual({ written: 1, skipped: [] });
		expect(fs.readFileSync(restored(), 'utf-8')).toBe('pipelines:');
		fs.rmSync(restored());
		restoreCueBackupFile(backupPath, 'ws_1', 'cue.yaml', pinned);
		expect(fs.existsSync(restored())).toBe(true);
	});

	it('a denying destructive class leaves the backup; an allowing one deletes it; a path outside the directory is still refused first', async () => {
		await expect(
			deleteCueBackup(backupPath, options('ceiling', { verdict: 'deny' }))
		).rejects.toThrow('[managed-denied] the local-effects ceiling denies the destructive class');
		expect(fs.existsSync(backupPath)).toBe(true);
		await expect(
			deleteCueBackup(path.join(os.tmpdir(), 'elsewhere.zip'), options('ceiling'))
		).rejects.toThrow('Backup path must be inside the cue-backups directory');
		await deleteCueBackup(backupPath, options('ceiling'));
		expect(fs.existsSync(backupPath)).toBe(false);
	});
});
