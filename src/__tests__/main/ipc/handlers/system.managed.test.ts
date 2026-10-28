/**
 * The system handlers under the local-effects ceiling (MRC2-04-09). Every
 * hand-off to the OS these handlers perform (`shell:openExternal` and its
 * `file:` and bare-path branches, `shell:openPath`, `shell:trashItem`,
 * `clipboard:writeText`, `clipboard:writeImage`) is held right before the
 * Electron call, as the transport that asked: a denied effect never reaches
 * `shell` or `clipboard`, the caller is rejected by code, the receipt reaches
 * the log, and a `confirm` class asks the operator first. Standalone performs
 * what it performed before, and a host with no authority wired holds nothing.
 *
 * The real handlers and the real policy source run here over a mocked
 * `electron`, so a refusal is proven by the absence of the Electron call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboard, ipcMain, nativeImage, shell } from 'electron';
import * as fsSync from 'fs';

import { createLocalEffectsPolicySource } from '../../../../main/enterprise/local-effects-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import {
	registerSystemHandlers,
	restoreManagedSyncPath,
	type SystemHandlerDependencies,
} from '../../../../main/ipc/handlers/system';
import { logger } from '../../../../main/utils/logger';
import { runAsTransport } from '../../../../main/web-server/auth/transport-actor';
import { setSettingsWriteAuthority } from '../../../../main/enterprise/settings-policy';
import { installManagedSettingsPolicy } from '../../../helpers/managedSettingsPolicy';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
	dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
	shell: {
		openExternal: vi.fn(),
		openPath: vi.fn(),
		showItemInFolder: vi.fn(),
		trashItem: vi.fn(),
	},
	BrowserWindow: { getFocusedWindow: vi.fn() },
	app: { getVersion: vi.fn(), getPath: vi.fn() },
	clipboard: { writeText: vi.fn(), writeImage: vi.fn(), readImage: vi.fn() },
	nativeImage: { createFromDataURL: vi.fn(), createFromBuffer: vi.fn() },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
		getLogs: vi.fn(),
		clearLogs: vi.fn(),
		setLogLevel: vi.fn(),
		getLogLevel: vi.fn(),
		setMaxLogBuffer: vi.fn(),
		getMaxLogBuffer: vi.fn(),
		getLogFilePath: vi.fn(),
		isFileLoggingEnabled: vi.fn(),
		enableFileLogging: vi.fn(),
		on: vi.fn(),
	},
}));
vi.mock('../../../../main/utils/shellDetector', () => ({ detectShells: vi.fn() }));
vi.mock('../../../../main/utils/cliDetection', () => ({ isCloudflaredInstalled: vi.fn() }));
vi.mock('../../../../shared/maestro-lib/launch/getShellPath', () => ({
	peekShellPath: vi.fn(() => '/usr/bin:/bin'),
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../../main/update-checker', () => ({ checkForUpdates: vi.fn() }));
vi.mock('../../../../main/auto-updater', () => ({ setAllowPrerelease: vi.fn() }));
vi.mock('../../../../main/power-manager', () => ({
	powerManager: {
		setEnabled: vi.fn(),
		isEnabled: vi.fn(),
		setKeepDisplayAwake: vi.fn(),
		isKeepingDisplayAwake: vi.fn(),
		getStatus: vi.fn(),
		addBlockReason: vi.fn(),
		removeBlockReason: vi.fn(),
	},
}));
vi.mock('../../../../main/tunnel-manager', () => ({
	tunnelManager: { start: vi.fn(), stop: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('fs', () => ({
	default: {
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(),
		copyFileSync: vi.fn(),
	},
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
	readFileSync: vi.fn(),
	copyFileSync: vi.fn(),
}));

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

describe('system handlers under the local-effects ceiling (MRC2-04-09)', () => {
	let handlers: Map<string, Handler>;
	const confirm = vi.fn<(prompt: unknown) => Promise<'confirmed' | 'declined' | 'unavailable'>>();

	function register(
		mode: 'standalone' | 'enrolled' | 'ceiling' | 'none',
		classes: Array<{ class: string; verdict: string }> = [
			{ class: 'data-transfer', verdict: 'allow' },
			{ class: 'destructive', verdict: 'allow' },
		]
	) {
		const source = createLocalEffectsPolicySource({
			identity: { read: () => (mode === 'standalone' ? { status: 'none' } : enrolled) },
			policy: () => ({ appliedRevision: 3 }),
			confirm,
		});
		if (mode === 'ceiling') {
			const out = source.install({ policyRevision: 3, classes });
			if (!out.installed) throw new Error(out.problems.join('; '));
		}
		const deps: SystemHandlerDependencies = {
			getMainWindow: () => null,
			app: {} as never,
			settingsStore: { get: vi.fn(), set: vi.fn() } as never,
			tunnelManager: {} as never,
			getWebServer: () => null,
			...(mode === 'none' ? {} : { localEffects: () => source }),
		};
		registerSystemHandlers(deps);
		return source;
	}

	const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});
		vi.mocked(fsSync.existsSync).mockReturnValue(true);
		vi.mocked(shell.openExternal).mockResolvedValue(undefined);
		vi.mocked(shell.openPath).mockResolvedValue('');
		vi.mocked(shell.trashItem).mockResolvedValue(undefined);
		vi.mocked(nativeImage.createFromDataURL).mockReturnValue({ isEmpty: () => false } as never);
	});

	afterEach(() => {
		handlers.clear();
	});

	it('standalone: every effect reaches Electron as before, nothing is asked and nothing is logged', async () => {
		register('standalone');
		await call('shell:openExternal', 'https://example.com/a');
		await call('shell:openExternal', 'file:///Users/me/doc.pdf');
		await call('shell:openExternal', '/Users/me/bare.txt');
		await call('shell:openPath', '/Users/me/folder');
		await call('shell:trashItem', '/Users/me/old.txt');
		await call('clipboard:writeText', 'copied');
		await call('clipboard:writeImage', 'data:image/png;base64,iVBORw0KGgo=');
		expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/a');
		expect(shell.openPath).toHaveBeenCalledTimes(3);
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
		expect(clipboard.writeText).toHaveBeenCalledWith('copied');
		expect(clipboard.writeImage).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('no authority wired (tests, a bare host) holds nothing', async () => {
		register('none');
		await call('shell:openExternal', 'https://example.com/a');
		await call('shell:trashItem', '/Users/me/old.txt');
		expect(shell.openExternal).toHaveBeenCalledTimes(1);
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
	});

	it('enrolled with no ceiling: every effect is refused unavailable by name before Electron is reached', async () => {
		register('enrolled');
		await expect(call('shell:openExternal', 'https://example.com/a')).rejects.toThrow(
			/^\[managed-unavailable\] the managed local-effects ceiling is unavailable \(no local-effects ceiling is installed for policy revision 3\); opening https:\/\/example\.com\/a outside Maestro for the operator is refused$/
		);
		await expect(call('shell:openExternal', 'file:///Users/me/doc.pdf')).rejects.toThrow(
			'[managed-unavailable]'
		);
		await expect(call('shell:openExternal', '/Users/me/bare.txt')).rejects.toThrow(
			'[managed-unavailable]'
		);
		await expect(call('shell:openPath', '/Users/me/folder')).rejects.toThrow(
			'[managed-unavailable]'
		);
		await expect(call('shell:trashItem', '/Users/me/old.txt')).rejects.toThrow(
			'[managed-unavailable]'
		);
		await expect(call('clipboard:writeText', 'copied')).rejects.toThrow('[managed-unavailable]');
		await expect(
			call('clipboard:writeImage', 'data:image/png;base64,iVBORw0KGgo=')
		).rejects.toThrow('[managed-unavailable]');
		expect(shell.openExternal).not.toHaveBeenCalled();
		expect(shell.openPath).not.toHaveBeenCalled();
		expect(shell.trashItem).not.toHaveBeenCalled();
		expect(clipboard.writeText).not.toHaveBeenCalled();
		expect(clipboard.writeImage).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(7);
		expect(vi.mocked(logger.warn).mock.calls[0][2]).toEqual({
			code: 'unavailable',
			receipt: {
				policyRevision: 3,
				class: 'data-transfer',
				effect: 'open-external',
				actor: 'the operator',
				target: 'https://example.com',
				count: 1,
				outcome: 'unavailable',
			},
		});
	});

	it('under a ceiling: a denied class never reaches Electron while an allowed class does; the local gates still run first', async () => {
		register('ceiling', [
			{ class: 'data-transfer', verdict: 'deny' },
			{ class: 'destructive', verdict: 'allow' },
		]);
		await expect(call('shell:openExternal', 'https://example.com/a')).rejects.toThrow(
			/^\[managed-denied\] the local-effects ceiling denies the data-transfer class; opening https:\/\/example\.com\/a outside Maestro for the operator is refused$/
		);
		await expect(call('shell:openPath', '/Users/me/folder')).rejects.toThrow('[managed-denied]');
		await expect(call('clipboard:writeText', 'copied')).rejects.toThrow('[managed-denied]');
		expect(shell.openExternal).not.toHaveBeenCalled();
		expect(shell.openPath).not.toHaveBeenCalled();
		expect(clipboard.writeText).not.toHaveBeenCalled();
		// The scheme allowlist and the existence checks answer before the ceiling is consulted.
		await expect(call('shell:openExternal', 'javascript:alert(1)')).rejects.toThrow(
			'Protocol not allowed'
		);
		vi.mocked(fsSync.existsSync).mockReturnValue(false);
		await expect(call('shell:openPath', '/gone')).resolves.toBeUndefined();
		vi.mocked(fsSync.existsSync).mockReturnValue(true);
		expect(logger.warn).toHaveBeenCalledTimes(4);
		// The destructive class is allowed: the trash runs with a receipt.
		await call('shell:trashItem', '/Users/me/old.txt');
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('a confirm class asks the operator once per effect with the full target; declined performs nothing', async () => {
		register('ceiling', [
			{ class: 'data-transfer', verdict: 'allow' },
			{ class: 'destructive', verdict: 'confirm' },
		]);
		confirm.mockResolvedValueOnce('declined');
		await expect(call('shell:trashItem', '/Users/me/old.txt')).rejects.toThrow(
			'[managed-declined] the operator declined moving /Users/me/old.txt to the trash'
		);
		expect(shell.trashItem).not.toHaveBeenCalled();
		expect(confirm).toHaveBeenCalledWith({
			effect: 'trash',
			class: 'destructive',
			target: '/Users/me/old.txt',
			count: 1,
			actor: 'the operator',
			message: expect.stringContaining("requires the operator's confirmation"),
		});
		confirm.mockResolvedValueOnce('confirmed');
		await call('shell:trashItem', '/Users/me/old.txt');
		expect(shell.trashItem).toHaveBeenCalledWith('/Users/me/old.txt');
		confirm.mockResolvedValueOnce('unavailable');
		await expect(call('shell:trashItem', '/Users/me/old.txt')).rejects.toThrow(
			'[managed-confirm-unavailable]'
		);
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
		// An allowed class never asks.
		await call('shell:openExternal', 'https://example.com/a');
		expect(confirm).toHaveBeenCalledTimes(3);
	});

	it('the hold binds the transport the call was admitted over', async () => {
		register('ceiling', [{ class: 'data-transfer', verdict: 'deny' }]);
		await expect(
			runAsTransport({ kind: 'cli' }, () => call('shell:openExternal', 'https://example.com/a'))
		).rejects.toThrow(/for maestro-cli is refused$/);
		await expect(
			runAsTransport({ kind: 'web-login', user: { username: 'ana' } as never }, () =>
				call('clipboard:writeText', 'copied')
			)
		).rejects.toThrow(/for web-login:ana is refused$/);
		expect(vi.mocked(logger.warn).mock.calls[1][2]).toMatchObject({
			receipt: { actor: 'web-login:ana', effect: 'clipboard-write', target: null },
		});
	});

	it('a ceiling installed after registration is honored by the next call without re-wiring', async () => {
		const source = register('enrolled');
		await expect(call('shell:openExternal', 'https://example.com/a')).rejects.toThrow(
			'[managed-unavailable]'
		);
		source.install({ policyRevision: 3, classes: [{ class: 'data-transfer', verdict: 'allow' }] });
		await call('shell:openExternal', 'https://example.com/a');
		expect(shell.openExternal).toHaveBeenCalledTimes(1);
	});

	describe('the sync folder and the tunnel under the settings lock (MRC2-06-04A)', () => {
		const bootstrap = {
			data: {} as Record<string, unknown>,
			get: vi.fn((key: string) => bootstrap.data[key]),
			set: vi.fn((key: string, value: unknown) => void (bootstrap.data[key] = value)),
			delete: vi.fn((key: string) => void delete bootstrap.data[key]),
		};
		const tunnel = { start: vi.fn(), stop: vi.fn(), getStatus: vi.fn() };
		const registerLocks = () =>
			registerSystemHandlers({
				getMainWindow: () => null,
				app: { getPath: () => '/data' } as never,
				settingsStore: { get: vi.fn(), set: vi.fn() } as never,
				tunnelManager: tunnel as never,
				getWebServer: () => ({ getSecureUrl: () => 'http://127.0.0.1:8080/tok' }) as never,
				bootstrapStore: bootstrap as never,
			});
		beforeEach(() => {
			bootstrap.data = {};
			vi.mocked(fsSync.existsSync).mockReturnValue(false);
		});
		afterEach(() => setSettingsWriteAuthority(null));

		it('standalone moves the folder and starts the tunnel as before', async () => {
			registerLocks();
			tunnel.start.mockResolvedValue({ success: true, url: 'https://x.trycloudflare.com' });
			await expect(call('sync:setCustomPath', '/Users/me/Sync')).resolves.toMatchObject({
				success: true,
				requiresRestart: true,
			});
			expect(bootstrap.data.customSyncPath).toBe('/Users/me/Sync');
			await expect(call('tunnel:start')).resolves.toEqual({
				success: true,
				url: 'https://x.trycloudflare.com/tok',
			});
			expect(logger.warn).not.toHaveBeenCalled();
		});

		it('refuses a locked move and a locked tunnel by the policy line before anything is touched', async () => {
			registerLocks();
			installManagedSettingsPolicy([
				{ key: 'storage.syncPath', pin: { value: '/Managed/Sync' } },
				{ key: 'web.tunnel' },
			]);
			await expect(call('sync:setCustomPath', '/Users/me/Sync')).resolves.toEqual({
				success: false,
				error: 'the "storage.syncPath" setting is locked and pinned by managed policy revision 3',
				managed: { code: 'locked', policyRevision: 3 },
			});
			expect(fsSync.mkdirSync).not.toHaveBeenCalled();
			expect(bootstrap.set).not.toHaveBeenCalled();
			await expect(call('tunnel:start')).resolves.toEqual({
				success: false,
				error: 'the "web.tunnel" setting is locked by managed policy revision 3',
				managed: { code: 'locked', policyRevision: 3 },
			});
			expect(tunnel.start).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledTimes(2);
		});

		it('restores a pinned folder by the same migration, keeps the folder under an unusable pin, and does nothing unpinned', () => {
			const pinned = installManagedSettingsPolicy([
				{ key: 'storage.syncPath', pin: { value: '/Managed/Sync' } },
			]).pins();
			expect(restoreManagedSyncPath(bootstrap as never, '/data', pinned)).toBe(
				'Storage location restored to the managed pin /Managed/Sync (0 files migrated); it takes effect at the next launch'
			);
			expect(bootstrap.data.customSyncPath).toBe('/Managed/Sync');
			expect(restoreManagedSyncPath(bootstrap as never, '/data', pinned)).toBeNull();
			// Too short for isValidSyncPath on every platform: named, never written.
			const unusable = installManagedSettingsPolicy([
				{ key: 'storage.syncPath', pin: { value: '/a' } },
			]).pins();
			expect(restoreManagedSyncPath(bootstrap as never, '/data', unusable)).toMatch(
				/^Storage location pinned by managed policy to \/a is not a usable sync folder/
			);
			expect(bootstrap.data.customSyncPath).toBe('/Managed/Sync');
			expect(restoreManagedSyncPath(bootstrap as never, '/data', null)).toBeNull();
			const unpinned = installManagedSettingsPolicy([{ key: 'storage.syncPath' }]).pins();
			expect(restoreManagedSyncPath(bootstrap as never, '/data', unpinned)).toBeNull();
		});
	});
});
