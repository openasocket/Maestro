/**
 * The settings lock on every global-settings write sink (MRC2-06-08), over the
 * REAL policy source as the one authority: settings:set, the bridge's
 * set_setting and `maestro-cli settings set` refused through one handler; pins
 * restored on every policy change; the managedLocks read; standalone unlocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	app: { getPath: vi.fn().mockReturnValue('/mock/user/data'), on: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));
// The CLI verb: the file readers are doubles, the desktop is the real bridge handler below.
vi.mock('../../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../cli/services/storage')>()),
	readSettingValue: vi.fn(() => '/usr/bin/gh'),
	writeSettingValue: vi.fn(() => true),
	dataDirHasManagedBinding: vi.fn(() => false),
}));
vi.mock('../../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
// The bulk session writes: images are not relocated and no backup is taken in this suite.
vi.mock('../../../../main/storage/session-image-store', () => ({
	relocateSessionImages: vi.fn(async (sessions: unknown[]) => ({ sessions, relocated: 0 })),
	resolveToDataUrl: vi.fn(),
}));
vi.mock('../../../../main/stores/sessions-backup', () => ({
	backupSessionsBeforeWipe: vi.fn(async () => undefined),
}));

import {
	SESSION_LIFECYCLE_SYNC_CHANNEL,
	registerPersistenceHandlers,
	type PersistenceHandlerDependencies,
} from '../../../../main/ipc/handlers/persistence';
import {
	ManagedSettingLockedError,
	createSettingsPolicySource,
	guardSettingsStore,
	restoreManagedSettingPins,
	setSettingsWriteAuthority,
} from '../../../../main/enterprise/settings-policy';
import { handleSetSetting } from '../../../../main/web-server/handlers/messageHandlers/settings';
import type { MessageHandlerContext } from '../../../../main/web-server/handlers/messageHandlers/types';
import { logger } from '../../../../main/utils/logger';
import { settingsSet } from '../../../../cli/commands/settings-set';
import { withMaestroClient } from '../../../../cli/services/maestro-client';
import { writeSettingValue } from '../../../../cli/services/storage';
import { NO_MANAGED_SETTING_LOCKS } from '../../../../shared/managedSettingsLock';
import { installManagedSettingsPolicy } from '../../../helpers/managedSettingsPolicy';

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

/** An enrolled host under revision 3 with no settings policy installed. */
const enrolledWithoutPolicy = () =>
	createSettingsPolicySource({
		identity: { read: () => ({ status: 'ok', record: {}, fileExists: true }) as never },
		policy: () => ({ appliedRevision: 3 }),
	});

const PINNED = 'the "ghPath" setting is locked and pinned by managed policy revision 3';
const LOCKED = 'the "crashReportingEnabled" setting is locked by managed policy revision 3';

describe('the settings lock on every global-settings write sink (MRC2-06-08)', () => {
	let handlers: Map<string, (...args: never[]) => unknown>;
	let store: ReturnType<typeof fakeStore>;
	let sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	const set = (key: string, value: unknown) =>
		handlers.get('settings:set')!({ sender } as never, key as never, value as never);

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		store = fakeStore({ ghPath: '/usr/bin/gh', crashReportingEnabled: true, fontSize: 14 });
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

	it('settings:set refuses a locked, a pinned and a sensitive key by name, writes nothing, and admits the rest', async () => {
		installManagedSettingsPolicy([
			{ key: 'ghPath', pin: { value: '/opt/managed/gh' } },
			{ key: 'crashReportingEnabled' },
			{ key: 'webAuthToken' },
		]);
		expect(await set('ghPath', '/x')).toBe(false);
		expect(await set('crashReportingEnabled', false)).toBe(false);
		expect(await set('webAuthToken', 't')).toBe(false);
		// A credential the plain settings file would keep: refused on every managed host (custody).
		expect(await set('wakatimeApiKey', 'k')).toBe(false);
		expect(store.writes).toEqual([]);
		expect(sender.send).toHaveBeenCalledTimes(4);
		expect(sender.send).toHaveBeenCalledWith('settings:externalChange');
		expect(vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]).slice(0, 40))).toEqual([
			`Settings write refused (locked): ${PINNED}`.slice(0, 40),
			`Settings write refused (locked): ${LOCKED}`.slice(0, 40),
			'Settings write refused (locked): the "we',
			'Settings write refused (custody): the Wa',
		]);
		expect(logger.warn).toHaveBeenCalledWith(expect.any(String), 'Settings', {
			key: 'ghPath',
			policyRevision: 3,
		});
		// An unmarked key and a lockable key the policy does not name go through.
		expect(await set('fontSize', 12)).toBe(true);
		expect(await set('shellEnvVars', { PATH: '/bin' })).toBe(true);
		expect(store.writes).toEqual([
			['fontSize', 12],
			['shellEnvVars', { PATH: '/bin' }],
		]);
		expect(sender.send).toHaveBeenCalledTimes(4);
	});

	it('holds every lockable key unavailable on an enrolled host with no usable policy, and nothing standalone', async () => {
		setSettingsWriteAuthority(enrolledWithoutPolicy());
		expect(await set('ghPath', '/x')).toBe(false);
		expect(await set('encoreFeatures', { cue: false })).toBe(false);
		expect(vi.mocked(logger.warn).mock.calls[0][0]).toBe(
			'Settings write refused (unavailable): the "ghPath" setting is held by managed policy and the managed settings policy is unavailable (no settings policy is installed for policy revision 3)'
		);
		expect(await set('fontSize', 12)).toBe(true);
		expect(store.writes).toEqual([['fontSize', 12]]);
		// Standalone: no authority composed, every key goes through, the credential too.
		setSettingsWriteAuthority(null);
		expect(await set('ghPath', '/x')).toBe(true);
		expect(await set('webAuthToken', 't')).toBe(true);
		expect(await set('wakatimeApiKey', 'k')).toBe(true);
		expect(store.writes).toHaveLength(4);
		expect(sender.send).toHaveBeenCalledTimes(2);
	});

	it('restores a pin at install and on every policy change through the unguarded setter alone, and never opens an enrolled host', async () => {
		// A host whose applied revision moves with each policy the endpoint hands over.
		let applied = 3;
		const source = createSettingsPolicySource({
			identity: { read: () => ({ status: 'ok', record: {}, fileExists: true }) as never },
			policy: () => ({ appliedRevision: applied }),
		});
		setSettingsWriteAuthority(source);
		const pinned = (revision: number, locks: unknown[]) => {
			applied = revision;
			return source.install({ policyRevision: revision, locks });
		};
		expect(pinned(3, [{ key: 'ghPath', pin: { value: '/opt/managed/gh' } }])).toMatchObject({
			installed: true,
		});
		// Composed as index.ts does: pins restored now and on every install or clear.
		const restored: string[][] = [];
		const restore = () => restored.push(restoreManagedSettingPins(store, source.pins()));
		source.onChange(restore);
		restore();
		expect(restored).toEqual([['ghPath']]);
		expect(store.store.ghPath).toBe('/opt/managed/gh');
		// The guard refuses the renderer and main-process code alike; the restore passed it.
		expect(() => store.set('ghPath', '/x')).toThrow(ManagedSettingLockedError);
		expect(await set('ghPath', '/x')).toBe(false);
		expect(store.writes).toEqual([['ghPath', '/opt/managed/gh']]);
		// A new revision moves the pin and adds one: both restored, the line names the revision.
		expect(
			pinned(4, [
				{ key: 'ghPath', pin: { value: '/opt/v4/gh' } },
				{ key: 'defaultShell', pin: { value: 'zsh' } },
			])
		).toEqual({ installed: true, policyRevision: 4 });
		expect(restored[1]).toEqual(['ghPath', 'defaultShell']);
		expect(store.store).toMatchObject({ ghPath: '/opt/v4/gh', defaultShell: 'zsh' });
		expect(() => store.set('defaultShell', 'bash')).toThrow(
			'the "defaultShell" setting is locked and pinned by managed policy revision 4'
		);
		// A revision that drops the pin leaves the value where it is and admits the write again.
		expect(pinned(5, [])).toMatchObject({ installed: true });
		expect(restored[2]).toEqual([]);
		expect(store.store.ghPath).toBe('/opt/v4/gh');
		expect(await set('ghPath', '/x')).toBe(true);
		expect(store.store.ghPath).toBe('/x');
		// Clearing the policy leaves the host enrolled: held unavailable, not open.
		source.clear();
		expect(restored[3]).toEqual([]);
		expect(await set('ghPath', '/y')).toBe(false);
		expect(store.store.ghPath).toBe('/x');
	});

	it('settings:managedLocks reads the same verdict the writes meet, and nothing standalone', async () => {
		const read = () => handlers.get('settings:managedLocks')!() as Promise<unknown>;
		expect(await read()).toEqual(NO_MANAGED_SETTING_LOCKS);
		installManagedSettingsPolicy([
			{ key: 'ghPath', pin: { value: '/opt/managed/gh' } },
			{ key: 'crashReportingEnabled' },
		]);
		expect(await read()).toEqual({
			policyRevision: 3,
			locks: {
				ghPath: { code: 'locked', message: PINNED, pinned: true },
				crashReportingEnabled: { code: 'locked', message: LOCKED, pinned: false },
			},
		});
		setSettingsWriteAuthority(enrolledWithoutPolicy());
		const view = (await read()) as { policyRevision: number; locks: Record<string, unknown> };
		expect(view.policyRevision).toBe(3);
		expect(Object.keys(view.locks).length).toBeGreaterThan(30);
		expect(view.locks.ghPath).toMatchObject({ code: 'unavailable', pinned: false });
	});

	it('the bridge set_setting and maestro-cli settings set are refused through the same handler as settings:set', async () => {
		installManagedSettingsPolicy([{ key: 'ghPath' }]);
		// The bridge handler over the real IPC handler, the way the desktop composes it.
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
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		try {
			await expect(settingsSet('ghPath', '/opt/gh', { json: true })).rejects.toThrow(
				'process.exit(1)'
			);
			expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toEqual({
				error: 'the "ghPath" setting is locked by managed policy revision 3',
				managed: { state: 'denied', code: 'locked' },
			});
			expect(frames).toEqual([
				{
					type: 'error',
					message: 'the "ghPath" setting is locked by managed policy revision 3',
					key: 'ghPath',
					managed: { state: 'denied', code: 'locked' },
				},
			]);
			expect(store.writes).toEqual([]);
			// A lockable key the policy leaves alone reaches the store through the same chain.
			await settingsSet('crashReportingEnabled', 'false', { json: true });
			expect(frames[1]).toEqual({
				type: 'set_setting_result',
				success: true,
				key: 'crashReportingEnabled',
			});
			expect(store.writes).toEqual([['crashReportingEnabled', false]]);
			expect(writeSettingValue).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('renderer bulk session writes against the per-provider locks (MCOMP-21-08)', () => {
	let handlers: Map<string, (...args: never[]) => unknown>;
	let stored: Record<string, unknown>[];
	let sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
	const STORED = {
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		cwd: '/repo',
		customPath: '/usr/bin/claude',
		customModel: 'opus',
	};
	/** A renderer edit of every locked field (path, args, env, model, effort) plus an unlocked one. */
	const EDITED = {
		...STORED,
		name: 'Renamed',
		customPath: '/tmp/evil',
		customArgs: '--dangerously-skip-permissions',
		customEnvVars: { ANTHROPIC_BASE_URL: 'http://x' },
		customModel: 'haiku',
		customEffort: 'high',
	};
	const lockEveryField = () =>
		installManagedSettingsPolicy([
			{ key: 'agentConfig.customPath' },
			{ key: 'agentConfig.customArgs' },
			{ key: 'agentConfig.customEnvVars' },
			{ key: 'agentConfig.model' },
			{ key: 'agentConfig.reasoningEffort' },
		]);
	const writeVia = (channel: 'sessions:setMany' | 'sessions:setAll', edited: unknown) =>
		channel === 'sessions:setMany'
			? handlers.get(channel)!({ sender } as never, [edited] as never, [] as never)
			: handlers.get(channel)!({ sender } as never, [edited] as never);
	const syncCalls = () =>
		sender.send.mock.calls.filter(([channel]) => channel === SESSION_LIFECYCLE_SYNC_CHANNEL);

	beforeEach(() => {
		vi.clearAllMocks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		stored = [{ ...STORED }];
		sender = { isDestroyed: () => false, send: vi.fn() };
		registerPersistenceHandlers({
			settingsStore: fakeStore({}) as never,
			sessionsStore: {
				get: () => stored,
				set: (_key: string, value: Record<string, unknown>[]) => void (stored = value),
				path: '/mock/sessions.json',
			} as never,
			groupsStore: { get: () => [], set: vi.fn() } as never,
			getWebServer: () => null,
			flushSessionWrites: async () => {},
		} as PersistenceHandlerDependencies);
	});

	afterEach(() => setSettingsWriteAuthority(null));

	for (const channel of ['sessions:setMany', 'sessions:setAll'] as const) {
		it(`${channel} puts every locked field back, keeps the rest, and corrects the renderer`, async () => {
			lockEveryField();
			expect(await writeVia(channel, EDITED)).toBe(true);
			expect(stored).toHaveLength(1);
			const persisted = stored[0];
			expect(persisted).toMatchObject({
				id: 'agent-1',
				name: 'Renamed',
				customPath: '/usr/bin/claude',
				customModel: 'opus',
			});
			for (const field of ['customArgs', 'customEnvVars', 'customEffort'])
				expect(persisted).not.toHaveProperty(field);
			expect(vi.mocked(logger.warn).mock.calls.map((call) => call[0])).toEqual([
				'Agent record field held by the managed policy: agentConfig.customPath',
				'Agent record field held by the managed policy: agentConfig.customArgs',
				'Agent record field held by the managed policy: agentConfig.customEnvVars',
				'Agent record field held by the managed policy: agentConfig.model',
				'Agent record field held by the managed policy: agentConfig.reasoningEffort',
			]);
			// The writer is told what was kept instead, against what it sent.
			expect(syncCalls()).toEqual([
				[
					SESSION_LIFECYCLE_SYNC_CHANNEL,
					{
						added: [],
						removedIds: [],
						updated: [persisted],
						baselines: [expect.objectContaining({ customModel: 'haiku', customPath: '/tmp/evil' })],
					},
				],
			]);
		});

		it(`${channel} passes a field the policy does not lock, and everything standalone`, async () => {
			installManagedSettingsPolicy([{ key: 'agentConfig.model' }]);
			expect(
				await writeVia(channel, { ...STORED, customPath: '/opt/claude', customModel: 'haiku' })
			).toBe(true);
			expect(stored[0]).toMatchObject({ customPath: '/opt/claude', customModel: 'opus' });
			expect(syncCalls()).toHaveLength(1);
			// An unlocked write alone sends no correction.
			sender.send.mockClear();
			expect(await writeVia(channel, { ...stored[0], customPath: '/opt/other' })).toBe(true);
			expect(stored[0]).toMatchObject({ customPath: '/opt/other', customModel: 'opus' });
			expect(syncCalls()).toEqual([]);
			setSettingsWriteAuthority(null);
			expect(await writeVia(channel, { ...EDITED })).toBe(true);
			expect(stored[0]).toMatchObject({
				customPath: '/tmp/evil',
				customArgs: '--dangerously-skip-permissions',
				customEnvVars: { ANTHROPIC_BASE_URL: 'http://x' },
				customModel: 'haiku',
				customEffort: 'high',
			});
			expect(syncCalls()).toEqual([]);
		});
	}

	it('a new record created with a locked field is written without it', async () => {
		lockEveryField();
		const created = {
			id: 'agent-2',
			name: 'New',
			toolType: 'codex',
			cwd: '/r',
			customModel: 'gpt-x',
		};
		expect(await writeVia('sessions:setMany', created)).toBe(true);
		const persisted = stored.find((session) => session.id === 'agent-2')!;
		expect(persisted).toMatchObject({ name: 'New', toolType: 'codex' });
		expect(persisted).not.toHaveProperty('customModel');
		expect(stored.find((session) => session.id === 'agent-1')).toMatchObject(STORED);
	});
});
