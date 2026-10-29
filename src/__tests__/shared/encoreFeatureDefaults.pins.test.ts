/**
 * A pinned Encore flag survives a user toggle (MRC2-07-06, tested MRC2-07-08):
 * over the REAL settings policy source as the one authority, the REAL
 * `settings:set` handler, the bridge's `set_setting` and `maestro-cli encore`,
 * a flag the policy pins reads as the pin whatever is stored, the pin is
 * restored into the stored object the way index.ts does it, a toggle that
 * flips it is refused on every sink with the flag's own line while one that
 * keeps it is admitted, the locks read names the pin, and the pinned-off
 * feature's shortcut is hidden whatever the store says. Standalone, nothing
 * is pinned and the store decides.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn().mockReturnValue('/mock/user/data'), on: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
vi.mock('../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => false }));
// The CLI verb: the settings file reader is a double over the store below, the desktop is the real bridge handler.
vi.mock('../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../cli/services/storage')>()),
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(() => true),
	dataDirHasManagedBinding: vi.fn(() => false),
}));
vi.mock('../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));

import {
	registerPersistenceHandlers,
	type PersistenceHandlerDependencies,
} from '../../main/ipc/handlers/persistence';
import {
	ManagedSettingLockedError,
	guardSettingsStore,
	restoreManagedSettingPins,
	setSettingsWriteAuthority,
} from '../../main/enterprise/settings-policy';
import { handleSetSetting } from '../../main/web-server/handlers/messageHandlers/settings';
import type { MessageHandlerContext } from '../../main/web-server/handlers/messageHandlers/types';
import { logger } from '../../main/utils/logger';
import { encoreSet } from '../../cli/commands/encore';
import { withMaestroClient } from '../../cli/services/maestro-client';
import { readSettingValue, writeSettingValue } from '../../cli/services/storage';
import {
	ENCORE_FEATURE_DEFAULTS,
	isEncoreFeatureEnabled,
	resolveEncoreFeatures,
} from '../../shared/encoreFeatureDefaults';
import { NO_MANAGED_SETTING_LOCKS, encoreFlagPins } from '../../shared/managedSettingsLock';
import { availableShortcuts } from '../../renderer/utils/encoreShortcuts';
import { DEFAULT_SHORTCUTS } from '../../renderer/constants/shortcuts';
import { installManagedSettingsPolicy } from '../helpers/managedSettingsPolicy';

/** A settings store as the desktop guards it: every write recorded, the data readable back. */
function fakeStore(data: Record<string, unknown>) {
	const writes: unknown[][] = [];
	return guardSettingsStore({
		writes,
		store: data,
		get: (key: string) => data[key],
		set(key: string, value: unknown) {
			writes.push([key, value]);
			data[key] = value;
		},
	});
}

const CUE_LINE =
	'the "encore.maestroCue" setting is locked and pinned by managed policy revision 3';
const PLUGINS_LINE =
	'the "encore.plugins" setting is locked and pinned by managed policy revision 3';
const PINS = [
	{ key: 'encore.maestroCue', pin: { value: false } },
	{ key: 'encore.plugins', pin: { value: true } },
];

describe('a pinned Encore flag survives a user toggle (MRC2-07-06)', () => {
	let handlers: Map<string, (...args: never[]) => unknown>;
	let store: ReturnType<typeof fakeStore>;
	let sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	const set = (key: string, value: unknown) =>
		handlers.get('settings:set')!({ sender } as never, key as never, value as never);
	const flags = () => store.store.encoreFeatures as Record<string, boolean>;

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		// What a user left behind before the policy landed: Cue on, plugins off.
		store = fakeStore({ encoreFeatures: { maestroCue: true, symphony: false, plugins: false } });
		sender = { isDestroyed: () => false, send: vi.fn() };
		registerPersistenceHandlers({
			settingsStore: store as never,
			sessionsStore: { get: () => [], set: vi.fn(), path: '/mock/sessions.json' } as never,
			groupsStore: { get: () => [], set: vi.fn() } as never,
			getWebServer: () => null,
			flushSessionWrites: async () => {},
		} as PersistenceHandlerDependencies);
	});

	afterEach(() => setSettingsWriteAuthority(null));

	it('reads the pin whatever is stored, restores it into the stored object, and refuses the toggle that flips it while admitting one that keeps it', async () => {
		const source = installManagedSettingsPolicy(PINS);
		const pins = encoreFlagPins(source.pins());
		expect(pins).toEqual({ maestroCue: false, plugins: true });
		// The resolver: a pinned flag is the pin, the rest the store and the defaults.
		expect(resolveEncoreFeatures(flags(), pins)).toEqual({
			...ENCORE_FEATURE_DEFAULTS,
			maestroCue: false,
			symphony: false,
			plugins: true,
		});
		// Restored into the object, as index.ts does at composition and on every policy change:
		// each flag named by its lock key, the object written once.
		expect(restoreManagedSettingPins(store, source.pins())).toEqual([
			'encore.maestroCue',
			'encore.plugins',
		]);
		expect(flags()).toEqual({ maestroCue: false, symphony: false, plugins: true });
		expect(isEncoreFeatureEnabled(store, 'maestroCue')).toBe(false);
		expect(isEncoreFeatureEnabled(store, 'plugins')).toBe(true);
		// The toggle in Settings: the renderer writes its whole object with one pin flipped.
		expect(await set('encoreFeatures', { maestroCue: true, symphony: false, plugins: true })).toBe(
			false
		);
		expect(
			await set('encoreFeatures', { maestroCue: false, symphony: false, plugins: false })
		).toBe(false);
		expect(logger.warn).toHaveBeenNthCalledWith(
			1,
			`Settings write refused (locked): ${CUE_LINE}`,
			'Settings',
			{ key: 'encoreFeatures', policyRevision: 3 }
		);
		expect(logger.warn).toHaveBeenNthCalledWith(
			2,
			`Settings write refused (locked): ${PLUGINS_LINE}`,
			'Settings',
			{ key: 'encoreFeatures', policyRevision: 3 }
		);
		// The sender reloads so its copy snaps back to the pin.
		expect(sender.send).toHaveBeenCalledTimes(2);
		expect(sender.send).toHaveBeenCalledWith('settings:externalChange');
		expect(flags()).toEqual({ maestroCue: false, symphony: false, plugins: true });
		// Another flag toggled under the pins goes through, the pins kept.
		expect(await set('encoreFeatures', { maestroCue: false, symphony: true, plugins: true })).toBe(
			true
		);
		expect(flags()).toEqual({ maestroCue: false, symphony: true, plugins: true });
		expect(store.writes).toEqual([
			['encoreFeatures', { maestroCue: false, symphony: false, plugins: true }],
			['encoreFeatures', { maestroCue: false, symphony: true, plugins: true }],
		]);
		// Main-process code is refused by the guard the same way the renderer is.
		expect(() => store.set('encoreFeatures', { maestroCue: true })).toThrow(
			ManagedSettingLockedError
		);
		// A copy written before the policy still reads as the pin, and the next restore corrects it.
		store.store.encoreFeatures = { maestroCue: true, plugins: true };
		expect(resolveEncoreFeatures(flags(), pins).maestroCue).toBe(false);
		expect(restoreManagedSettingPins(store, source.pins())).toEqual(['encore.maestroCue']);
		expect(flags()).toEqual({ maestroCue: false, plugins: true });
		// A later policy that drops the pin leaves the value where it is and admits the toggle again.
		expect(source.install({ policyRevision: 3, locks: [] })).toMatchObject({ installed: true });
		expect(restoreManagedSettingPins(store, source.pins())).toEqual([]);
		expect(await set('encoreFeatures', { maestroCue: true, plugins: true })).toBe(true);
		expect(flags()).toEqual({ maestroCue: true, plugins: true });
	});

	it("the bridge set_setting and maestro-cli encore enable are refused through the same handler as settings:set, by the flag's own line", async () => {
		const source = installManagedSettingsPolicy(PINS);
		restoreManagedSettingPins(store, source.pins());
		const frames: Record<string, unknown>[] = [];
		const ctx = {
			send: (_client: unknown, frame: Record<string, unknown>) => void frames.push(frame),
			sendError: (_client: unknown, message: string, extra?: Record<string, unknown>) =>
				void frames.push({ type: 'error', message, ...extra }),
			callbacks: { setSetting: (key: string, value: unknown) => set(key, value) },
		} as unknown as MessageHandlerContext;
		const sendCommand = vi.fn(async (message: Record<string, unknown>) => {
			const before = frames.length;
			handleSetSetting(ctx, { cli: true } as never, message as never);
			await vi.waitFor(() => expect(frames.length).toBe(before + 1));
			return frames[before];
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		// The CLI merges its flag into the object the desktop holds.
		vi.mocked(readSettingValue).mockImplementation(() => flags());
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		try {
			await expect(encoreSet('cue', true, { json: true })).rejects.toThrow('process.exit(1)');
			expect(frames).toEqual([
				{
					type: 'error',
					message: CUE_LINE,
					key: 'encoreFeatures',
					managed: { state: 'denied', code: 'locked' },
				},
			]);
			expect(sendCommand).toHaveBeenCalledWith(
				{
					type: 'set_setting',
					key: 'encoreFeatures',
					value: expect.objectContaining({ maestroCue: true, plugins: true }),
				},
				'set_setting_result'
			);
			await expect(encoreSet('plugins', false, { json: true })).rejects.toThrow('process.exit(1)');
			expect(frames[1]).toMatchObject({ type: 'error', message: PLUGINS_LINE });
			expect(flags()).toEqual({ maestroCue: false, symphony: false, plugins: true });
			expect(store.writes).toHaveLength(1);
			// A flag the policy leaves alone reaches the store through the same chain, the pins kept.
			await encoreSet('symphony', true, { json: true });
			expect(frames[2]).toEqual({
				type: 'set_setting_result',
				success: true,
				key: 'encoreFeatures',
			});
			expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
				success: true,
				feature: 'symphony',
				enabled: true,
			});
			expect(flags()).toMatchObject({ maestroCue: false, symphony: true, plugins: true });
			expect(writeSettingValue).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it('names the pin in the locks read, hides the pinned-off shortcut whatever the store says, and pins nothing standalone', async () => {
		installManagedSettingsPolicy(PINS);
		const read = () =>
			handlers.get('settings:managedLocks')!() as Promise<{
				policyRevision: number | null;
				locks: Record<string, unknown>;
				encorePins?: Record<string, boolean>;
			}>;
		const view = await read();
		expect(view).toEqual({
			policyRevision: 3,
			locks: {
				'encore.maestroCue': { code: 'locked', message: CUE_LINE, pinned: true },
				'encore.plugins': { code: 'locked', message: PLUGINS_LINE, pinned: true },
			},
			encorePins: { maestroCue: false, plugins: true },
		});
		// The renderer reads the pins over its own copy: a stale `maestroCue: true` hides nothing.
		const stale = resolveEncoreFeatures({ maestroCue: true, symphony: true });
		const visible = availableShortcuts(DEFAULT_SHORTCUTS, stale, view.encorePins);
		expect(visible.openCue).toBeUndefined();
		expect(visible.openSymphony).toBe(DEFAULT_SHORTCUTS.openSymphony);
		expect(availableShortcuts(DEFAULT_SHORTCUTS, stale).openCue).toBe(DEFAULT_SHORTCUTS.openCue);
		// Standalone: no authority, nothing pinned, the store decides.
		setSettingsWriteAuthority(null);
		expect(await read()).toEqual(NO_MANAGED_SETTING_LOCKS);
		expect(encoreFlagPins(null)).toEqual({});
		expect(await set('encoreFeatures', { maestroCue: true, plugins: true })).toBe(true);
		expect(flags()).toEqual({ maestroCue: true, plugins: true });
		expect(resolveEncoreFeatures(flags(), encoreFlagPins(null)).maestroCue).toBe(true);
	});
});
