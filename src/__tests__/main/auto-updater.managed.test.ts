/**
 * electron-updater under management (MRC2-05-04): a hold stops the check,
 * the download and the install before the feed is read or a byte moves, and
 * is reported as `held-by-policy` by name; a pin admits exactly the pinned
 * version; a stable channel caps the person's prerelease opt-in; the feed
 * and the download are held as `updates` on the egress ceiling even though
 * electron-updater has its own HTTP stack; and with no authority installed
 * every handler runs exactly as it always has.
 *
 * The module is loaded once: the authorities live in `update-checker.ts` and
 * `fetchWithTimeout.ts`, and a reset module graph would hold against another
 * instance than the one the test installs on.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IdentityRead } from '../../main/enterprise/identity-store';
import { createEgressPolicySource } from '../../main/enterprise/egress-policy';
import { createUpdatePolicySource } from '../../main/enterprise/update-policy';
import { heldEgress, setEgressAuthority } from '../../main/utils/fetchWithTimeout';
import { heldUpdate, setUpdateAuthority } from '../../main/update-checker';
import { denyingEgressAuthority } from '../helpers/egressAuthority';

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	BrowserWindow: class {},
	app: { getVersion: () => '1.0.0' },
	ipcMain: {
		handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
			ipcHandlers.set(channel, fn);
		},
	},
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));

vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn().mockResolvedValue(undefined),
}));

const mockAutoUpdater = {
	autoDownload: false,
	autoInstallOnAppQuit: false,
	allowPrerelease: false,
	on: vi.fn(),
	checkForUpdates: vi.fn(),
	downloadUpdate: vi.fn(),
	quitAndInstall: vi.fn(),
	setFeedURL: vi.fn(),
};

/** Every status the main process sent to the renderer, in order. */
const sent: unknown[] = [];
const mainWindow = {
	webContents: { send: (_channel: string, status: unknown) => sent.push(status) },
};

function enrolled(): IdentityRead {
	return {
		status: 'ok',
		epoch: 1,
		record: {
			registration: { actorId: 'actor', registeredAt: 1 },
			policy: { appliedRevision: 3, appliedAt: 1 },
		},
	} as never;
}

function managed(ceiling: Record<string, unknown> | null) {
	const source = createUpdatePolicySource({
		identity: { read: () => enrolled() },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (ceiling) {
		const outcome = source.install({
			policyRevision: 3,
			hold: false,
			channel: 'stable',
			pin: null,
			...ceiling,
		});
		if (!outcome.installed) throw new Error(outcome.problems.join('; '));
	}
	setUpdateAuthority(source);
	return source;
}

const handler = (channel: string) => {
	const fn = ipcHandlers.get(channel);
	if (!fn) throw new Error(`no handler for ${channel}`);
	return fn;
};

const lastStatus = () => sent[sent.length - 1] as { status: string; held?: { code: string } };

type AutoUpdaterModule = typeof import('../../main/auto-updater');
let mod: AutoUpdaterModule;

describe('auto-updater under an update authority', () => {
	beforeAll(async () => {
		mod = await import('../../main/auto-updater');
		mod.__setAutoUpdaterForTesting(
			mockAutoUpdater as unknown as Parameters<typeof mod.__setAutoUpdaterForTesting>[0]
		);
		mod.initAutoUpdater(mainWindow as unknown as Parameters<typeof mod.initAutoUpdater>[0]);
	});

	beforeEach(() => {
		sent.length = 0;
		mockAutoUpdater.allowPrerelease = false;
		mockAutoUpdater.checkForUpdates.mockReset();
		mockAutoUpdater.downloadUpdate.mockReset();
		mockAutoUpdater.quitAndInstall.mockReset();
		mockAutoUpdater.setFeedURL.mockReset();
		mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.3.0' } });
		mockAutoUpdater.downloadUpdate.mockResolvedValue(undefined);
	});

	afterEach(() => {
		setUpdateAuthority(null);
		setEgressAuthority(null);
	});

	it('runs the check and the download as before with no authority installed', async () => {
		const check = await handler('updates:checkAutoUpdater')();
		expect(check).toEqual({ success: true, updateInfo: { version: '1.3.0' } });
		const download = await handler('updates:download')({}, 'v1.3.0');
		expect(download).toEqual({ success: true });
		expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
		expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		expect(lastStatus().status).toBe('downloading');
	});

	it('passes through standalone authorities with nothing held or recorded (MRC2-05-08)', async () => {
		// Installed, but over an identity that is not enrolled: the desktop shape
		// on a standalone host. Every step runs as with no authority at all, each
		// source is asked and answers allowed, and both ledgers stay empty.
		const updateSource = createUpdatePolicySource({
			identity: { read: () => ({ status: 'none' }) },
			policy: () => null,
		});
		const egressSource = createEgressPolicySource({
			identity: { read: () => ({ status: 'none' }) },
			policy: () => null,
		});
		const evaluateUpdate = vi.spyOn(updateSource, 'evaluateUpdate');
		const evaluateEgress = vi.spyOn(egressSource, 'evaluateEgress');
		setUpdateAuthority(updateSource);
		setEgressAuthority(egressSource);

		const check = await handler('updates:checkAutoUpdater')();
		expect(check).toEqual({ success: true, updateInfo: { version: '1.3.0' } });
		const download = await handler('updates:download')({}, 'v1.3.0');
		expect(download).toEqual({ success: true });
		expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		expect(lastStatus().status).toBe('downloading');
		await expect(mod.checkForUpdatesManual()).resolves.toEqual({ version: '1.3.0' });

		expect(evaluateUpdate).toHaveBeenCalled();
		expect(evaluateEgress).toHaveBeenCalled();
		for (const result of [...evaluateUpdate.mock.results, ...evaluateEgress.mock.results]) {
			expect(result.value).toEqual({ allowed: true });
		}
		expect(heldUpdate()).toBeNull();
		expect(heldEgress()).toEqual([]);
		expect(sent.every((status) => (status as { status: string }).status !== 'held-by-policy')).toBe(
			true
		);
	});

	it('holds the check by name before the feed is read when the ceiling holds', async () => {
		managed({ hold: true });
		const result = await handler('updates:checkAutoUpdater')();
		expect(result).toMatchObject({ success: true, held: { code: 'held', candidate: null } });
		expect(result).not.toHaveProperty('updateInfo');
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(lastStatus()).toMatchObject({ status: 'held-by-policy', held: { code: 'held' } });
		expect(await handler('updates:getStatus')()).toMatchObject({ status: 'held-by-policy' });
	});

	it('holds the download with a target tag before the feed is pointed anywhere', async () => {
		managed({ hold: true });
		const result = await handler('updates:download')({}, 'v1.3.0');
		expect(result).toMatchObject({
			success: false,
			error: expect.stringMatching(/^\[managed-held\] /),
			held: { code: 'held', candidate: 'v1.3.0' },
		});
		expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
		expect(lastStatus().status).toBe('held-by-policy');
		// The step it stopped is the hold in force for the status projection (MRC2-05-04A).
		expect(heldUpdate()).toMatchObject({ code: 'held', candidate: 'v1.3.0' });
	});

	it('holds an enrolled host with no ceiling unavailable: no feed, no download', async () => {
		managed(null);
		const result = await handler('updates:download')();
		expect(result).toMatchObject({ success: false, held: { code: 'unavailable' } });
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
	});

	it('admits exactly the pinned version and holds the version the feed resolves to', async () => {
		managed({ pin: '1.2.0' });
		// The feed resolves to a newer release than the pin: held after the check, before a byte moves.
		const newer = await handler('updates:download')();
		expect(newer).toMatchObject({
			success: false,
			held: { code: 'pin-denied', candidate: '1.3.0' },
		});
		expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
		expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
		expect(lastStatus()).toMatchObject({
			status: 'held-by-policy',
			info: { version: '1.3.0' },
			held: { code: 'pin-denied' },
		});
		// The renderer offers the pin itself: admitted and downloaded.
		mockAutoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.2.0' } });
		const pinned = await handler('updates:download')({}, 'v1.2.0');
		expect(pinned).toEqual({ success: true });
		expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
		// A tag above the pin is held before the feed is pointed at it.
		const above = await handler('updates:download')({}, 'v1.4.0');
		expect(above).toMatchObject({
			success: false,
			held: { code: 'pin-denied', candidate: 'v1.4.0' },
		});
		expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
	});

	it('reports a held version from the electron-updater check without offering it', async () => {
		managed({ pin: '1.2.0' });
		const result = await handler('updates:checkAutoUpdater')();
		expect(result).toMatchObject({
			success: true,
			held: { code: 'pin-denied', candidate: '1.3.0' },
		});
		expect(result).not.toHaveProperty('updateInfo');
		expect(lastStatus()).toMatchObject({ status: 'held-by-policy', info: { version: '1.3.0' } });
	});

	it('caps the prerelease opt-in to a stable channel and leaves a prerelease channel to the person', async () => {
		const source = managed({ channel: 'stable' });
		mod.setAllowPrerelease(true);
		expect(mockAutoUpdater.allowPrerelease).toBe(false);
		mod.setAllowPrerelease(false);
		expect(mockAutoUpdater.allowPrerelease).toBe(false);
		source.install({ policyRevision: 3, hold: false, channel: 'prerelease', pin: null });
		mod.setAllowPrerelease(true);
		expect(mockAutoUpdater.allowPrerelease).toBe(true);
		// A ceiling that lands after the setting was applied caps the next check.
		source.install({ policyRevision: 3, hold: false, channel: 'stable', pin: null });
		await handler('updates:checkAutoUpdater')();
		expect(mockAutoUpdater.allowPrerelease).toBe(false);
		expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
	});

	it('holds the feed as an updates request on the egress ceiling, recorded once in the ledger', async () => {
		managed({});
		const { authority, requests } = denyingEgressAuthority('class-denied');
		setEgressAuthority(authority);
		const check = await handler('updates:checkAutoUpdater')();
		expect(check).toMatchObject({
			success: true,
			held: { code: 'class-denied', candidate: null },
		});
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		const download = await handler('updates:download')({}, 'v1.3.0');
		expect(download).toMatchObject({ success: false, held: { code: 'class-denied' } });
		expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
		expect(requests.map((r) => [r.class, r.url])).toEqual([
			['updates', 'https://github.com/RunMaestro/Maestro/releases.atom'],
			['updates', 'https://github.com/RunMaestro/Maestro/releases/download/v1.3.0/'],
		]);
		expect(heldEgress()).toEqual([
			expect.objectContaining({ class: 'updates', origin: 'https://github.com', count: 2 }),
		]);
		expect(lastStatus()).toMatchObject({
			status: 'held-by-policy',
			held: { code: 'class-denied' },
		});
	});

	it('holds the install of a downloaded version a later pin no longer admits', async () => {
		const source = managed({});
		await handler('updates:download')({}, 'v1.3.0');
		// electron-updater reports the download; the status now names v1.3.0.
		const downloaded = mockAutoUpdater.on.mock.calls.find(
			([event]) => event === 'update-downloaded'
		);
		(downloaded![1] as (info: { version: string }) => void)({ version: '1.3.0' });
		source.install({ policyRevision: 3, hold: false, channel: 'stable', pin: '1.2.0' });
		await handler('updates:install')();
		expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(lastStatus()).toMatchObject({
			status: 'held-by-policy',
			info: { version: '1.3.0' },
			held: { code: 'pin-denied', candidate: '1.3.0' },
		});
		// With the authority removed (standalone), the install proceeds.
		setUpdateAuthority(null);
		await handler('updates:install')();
		expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
	});

	it('keeps the qualified version when a hold lands after an admitted download (MRC2-05-08)', async () => {
		// The download was admitted; the policy then holds updates entirely. The
		// install is refused by name, the manual check reads no feed, and the
		// hold in force is the install step the host stopped at.
		const source = managed({});
		await handler('updates:download')({}, 'v1.3.0');
		const downloaded = mockAutoUpdater.on.mock.calls.find(
			([event]) => event === 'update-downloaded'
		);
		(downloaded![1] as (info: { version: string }) => void)({ version: '1.3.0' });
		expect(lastStatus().status).toBe('downloaded');
		mockAutoUpdater.checkForUpdates.mockClear();

		source.install({ policyRevision: 3, hold: true, channel: 'stable', pin: null });
		await handler('updates:install')();
		expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
		expect(lastStatus()).toMatchObject({
			status: 'held-by-policy',
			info: { version: '1.3.0' },
			held: { code: 'held', candidate: '1.3.0' },
		});
		expect(heldUpdate()).toMatchObject({ code: 'held', candidate: '1.3.0' });
		await expect(mod.checkForUpdatesManual()).resolves.toBeNull();
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		expect(await handler('updates:getStatus')()).toMatchObject({ status: 'held-by-policy' });
	});

	it('holds the Lite connection update flow by name with nothing checked or downloaded', async () => {
		managed({ hold: true });
		const checked = await mod.connectionUpdateAction('check');
		expect(checked.status).toBe('held-by-policy');
		expect(checked.message).toContain('[managed-held]');
		expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
		await expect(mod.connectionUpdateAction('download')).resolves.toMatchObject({
			status: 'error',
			message: expect.stringContaining('Check for an available update first.'),
		});
		expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
	});
});
