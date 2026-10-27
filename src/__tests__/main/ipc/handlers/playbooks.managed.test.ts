/**
 * The playbooks file delete and the ZIP import under the managed ceilings
 * (MRC2-04-09A). `playbooks:deleteAll` is a `destructive` effect held to the
 * local-effects ceiling before the unlink; `playbooks:import` holds every
 * archive entry it reads or writes (the manifest, the documents, the assets)
 * to the install ceiling by the digest of its bytes BEFORE the first write,
 * and a zip-slip entry name refuses the whole archive in every mode.
 *
 * The real handlers and the real policy sources run here over a mocked
 * `fs/promises` and a mocked archive read, so a refusal is proven by the
 * absence of any mkdir or write.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, BrowserWindow } from 'electron';
import { dialog } from 'electron';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { createInstallPolicySource } from '../../../../main/enterprise/install-policy';
import { createLocalEffectsPolicySource } from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import { registerPlaybooksHandlers } from '../../../../main/ipc/handlers/playbooks';
import { logger } from '../../../../main/utils/logger';
import { readZipArchive } from '../../../../main/utils/zip-archive';
import { runAsTransport } from '../../../../main/web-server/auth/transport-actor';

const registered = new Map<string, (event: unknown, ...args: any[]) => Promise<any>>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: any[]) => Promise<any>) => {
			registered.set(channel, handler);
		}),
	},
	dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
	BrowserWindow: vi.fn(),
	App: vi.fn(),
}));
vi.mock('fs/promises', () => ({
	default: { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), unlink: vi.fn() },
}));
vi.mock('fs', () => {
	const createWriteStream = vi.fn();
	return { createWriteStream, default: { createWriteStream } };
});
vi.mock('archiver', () => ({ default: vi.fn() }));
vi.mock('../../../../main/utils/zip-archive', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/zip-archive')>()),
	readZipArchive: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = Buffer.from(
	JSON.stringify({ name: 'Imported', documents: [{ filename: 'doc1', order: 0 }] })
);
const doc = Buffer.from('# Document');
const asset = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const entry = (entryName: string, bytes: Buffer) => ({
	entryName,
	isDirectory: false,
	size: bytes.length,
	getData: () => bytes,
});
const archive = (entries: ReturnType<typeof entry>[]) => ({
	getEntries: () => entries,
	getEntry: (name: string) => entries.find((e) => e.entryName === name),
});
const goodEntries = [
	entry('manifest.json', manifest),
	entry('documents/doc1.md', doc),
	entry('assets/logo.png', asset),
];
const pin = (file: string, bytes: Buffer) => ({
	artifact: 'playbook-archive',
	file,
	sha256: sha(bytes),
	source: null,
});

describe('playbooks delete and ZIP import under the managed ceilings (MRC2-04-09A)', () => {
	function register(
		mode: 'standalone' | 'enrolled' | 'ceiling' | 'none',
		options: { verdict?: 'allow' | 'deny'; pins?: ReturnType<typeof pin>[] } = {}
	) {
		const identity = {
			read: (): IdentityRead => (mode === 'standalone' ? { status: 'none' } : enrolled),
		};
		const policy = () => ({ appliedRevision: 3 });
		const localEffects = createLocalEffectsPolicySource({ identity, policy });
		const install = createInstallPolicySource({ identity, policy });
		if (mode === 'ceiling') {
			const effects = localEffects.install({
				policyRevision: 3,
				classes: [{ class: 'destructive', verdict: options.verdict ?? 'allow' }],
			});
			if (!effects.installed) throw new Error(effects.problems.join('; '));
			const pins = install.install({ policyRevision: 3, pins: options.pins ?? [] });
			if (!pins.installed) throw new Error(pins.problems.join('; '));
		}
		registerPlaybooksHandlers({
			mainWindow: null,
			getMainWindow: () => ({}) as BrowserWindow,
			app: { getPath: () => '/userData' } as unknown as App,
			...(mode === 'none' ? {} : { localEffects: () => localEffects, install: () => install }),
		});
	}

	const call = (channel: string, ...args: unknown[]) => registered.get(channel)!({}, ...args);
	const importArchive = () => call('playbooks:import', 'session-1', '/autorun');

	beforeEach(() => {
		vi.clearAllMocks();
		registered.clear();
		vi.mocked(dialog.showOpenDialog).mockResolvedValue({
			canceled: false,
			filePaths: ['/picked/playbook.zip'],
		} as never);
		vi.mocked(readZipArchive).mockReturnValue(archive(goodEntries));
		vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.unlink).mockResolvedValue(undefined);
	});

	afterEach(() => {
		registered.clear();
	});

	it('standalone and no authority: the delete and the import run as before, nothing digested', async () => {
		register('standalone');
		expect(await call('playbooks:deleteAll', 'session-1')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledWith(path.join('/userData', 'playbooks', 'session-1.json'));
		const imported = await importArchive();
		expect(imported.success).toBe(true);
		expect(imported.importedDocs).toEqual(['doc1']);
		expect(imported.importedAssets).toEqual(['logo.png']);
		expect(fs.writeFile).toHaveBeenCalledTimes(3);
		expect(logger.warn).not.toHaveBeenCalled();

		registered.clear();
		register('none');
		expect((await importArchive()).success).toBe(true);
	});

	it('enrolled with no ceiling: the import is refused unavailable before any folder or file is written, and the delete leaves the file', async () => {
		register('enrolled');
		const imported = await importArchive();
		expect(imported.success).toBe(false);
		expect(imported.error).toContain(
			'[managed-unavailable] the managed install ceiling is unavailable (no install ceiling is installed for policy revision 3)'
		);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();

		const deleted = await call('playbooks:deleteAll', 'session-1');
		expect(deleted.success).toBe(false);
		expect(deleted.error).toContain('[managed-unavailable] the managed local-effects ceiling');
		expect(fs.unlink).not.toHaveBeenCalled();
		expect(vi.mocked(logger.warn).mock.calls[0]).toEqual([
			'Delete refused by the managed local-effects ceiling; nothing was removed',
			'[Playbooks]',
			expect.objectContaining({ code: 'unavailable' }),
		]);
	});

	it('every entry is held before the first write: one unpinned asset refuses the whole import, a wrong digest too, and three pins admit it', async () => {
		register('ceiling', { pins: [pin('manifest.json', manifest), pin('doc1.md', doc)] });
		const unpinned = await importArchive();
		expect(unpinned.error).toContain(
			'[managed-unpinned] the install ceiling pins no playbook-archive logo.png'
		);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();

		registered.clear();
		register('ceiling', {
			pins: [
				pin('manifest.json', manifest),
				pin('doc1.md', Buffer.from('# Tampered')),
				pin('logo.png', asset),
			],
		});
		expect((await importArchive()).error).toContain('[managed-digest-mismatch]');
		expect(fs.writeFile).not.toHaveBeenCalled();

		registered.clear();
		register('ceiling', {
			pins: [pin('manifest.json', manifest), pin('doc1.md', doc), pin('logo.png', asset)],
		});
		const imported = await importArchive();
		expect(imported.success).toBe(true);
		expect(fs.writeFile).toHaveBeenCalledTimes(3);
		expect(fs.writeFile).toHaveBeenCalledWith(
			path.join('/autorun', 'doc1.md'),
			'# Document',
			'utf-8'
		);
	});

	it('a zip-slip entry name refuses the whole archive in every mode, before the manifest is read', async () => {
		vi.mocked(readZipArchive).mockReturnValue(
			archive([...goodEntries, entry('documents/../../evil.md', doc)])
		);
		register('standalone');
		const result = await importArchive();
		expect(result.success).toBe(false);
		expect(result.error).toContain(
			'Invalid playbook file: unsafe entry name "documents/../../evil.md"'
		);
		expect(fs.mkdir).not.toHaveBeenCalled();
		expect(fs.writeFile).not.toHaveBeenCalled();
	});

	it('a denying destructive class leaves the playbooks file in place and names the transport; an allowing one deletes', async () => {
		register('ceiling', { verdict: 'deny' });
		const result = await runAsTransport({ kind: 'cli' }, () =>
			call('playbooks:deleteAll', 'session-1')
		);
		expect(result.error).toMatch(
			/\[managed-denied\] the local-effects ceiling denies the destructive class; deleting .*session-1\.json for maestro-cli is refused/
		);
		expect(fs.unlink).not.toHaveBeenCalled();

		registered.clear();
		register('ceiling', { verdict: 'allow' });
		expect(await call('playbooks:deleteAll', 'session-1')).toEqual({ success: true });
		expect(fs.unlink).toHaveBeenCalledTimes(1);
	});
});
