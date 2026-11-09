/**
 * The CLI's one held settings write (MCOMP-19-06): `writeSettingThroughHost()`
 * driven end to end over the desktop's REAL `set_setting` bridge handler and
 * the REAL settings policy source, with independent recording sinks for the
 * desktop store write and the settings file. GUI/CLI parity is asserted by
 * putting the same key to `holdSettingWrite()`, the call the GUI's
 * `settings:set` IPC handler makes, and requiring the same answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	dataDirHasManagedBinding: vi.fn(() => false),
	writeSettingValue: vi.fn(() => true),
}));

import { writeSettingThroughHost } from '../../../cli/services/managed-desktop-write';
import { withMaestroClient, type MaestroClient } from '../../../cli/services/maestro-client';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import { dataDirHasManagedBinding, writeSettingValue } from '../../../cli/services/storage';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import {
	createSettingsPolicySource,
	holdSettingWrite,
	setSettingsWriteAuthority,
} from '../../../main/enterprise/settings-policy';
import { handleSetSetting } from '../../../main/web-server/handlers/messageHandlers/settings';
import type {
	MessageHandlerContext,
	WebClient,
} from '../../../main/web-server/handlers/messageHandlers/types';
import { LOCKABLE_SETTING_KEYS } from '../../../shared/managedSettingsLock';
import { SETTINGS_METADATA } from '../../../shared/settingsMetadata';

const HELD_KEY = 'sshRemotes';
const PLAIN_KEY = Object.keys(SETTINGS_METADATA).find(
	(key) => !LOCKABLE_SETTING_KEYS.includes(key)
);
const REMOTES = [{ id: 'r1', name: 'Box', host: 'box.example', port: 22 }];

const enrolled = { status: 'ok', record: {} as never, fileExists: true } as unknown as IdentityRead;
let identity: IdentityRead = enrolled;
let revision: number | null = 3;
const policy = createSettingsPolicySource({
	identity: { read: () => identity },
	policy: () => (revision === null ? null : { appliedRevision: revision }),
});

/** What reached the desktop's store (the GUI's own write path, behind the hold). */
const desktopWrites: Array<[string, unknown]> = [];
/** Every command frame the CLI put on the bridge. */
const frames: Array<Record<string, unknown>> = [];

/** A desktop over the real handler: the reply frame `sendCommand` resolves with is the one the handler sends. */
function connectDesktop(): void {
	vi.mocked(withMaestroClient).mockImplementation(async (send) => {
		const client = {
			sendCommand: (command: Record<string, unknown>) =>
				new Promise((resolve) => {
					frames.push(command);
					const ctx = {
						send: (_c: WebClient, data: Record<string, unknown>) => resolve(data),
						sendError: (_c: WebClient, message: string, extra?: Record<string, unknown>) =>
							resolve({ type: 'error', message, ...extra }),
						callbacks: {
							setSetting: async (key: string, value: unknown) => {
								desktopWrites.push([key, value]);
								return true;
							},
						},
					} as unknown as MessageHandlerContext;
					handleSetSetting(
						ctx,
						{ cli: true } as WebClient,
						{ ...command, requestId: 'q1' } as never
					);
				}),
		} as unknown as MaestroClient;
		return send(client);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	desktopWrites.length = 0;
	frames.length = 0;
	identity = enrolled;
	revision = 3;
	policy.clear();
	vi.mocked(dataDirHasManagedBinding).mockReturnValue(false);
	setSettingsWriteAuthority(policy);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	connectDesktop();
});

afterEach(() => setSettingsWriteAuthority(null));

describe('writeSettingThroughHost over the real desktop hold (MCOMP-19-06)', () => {
	it('holds the keys the SSH remote verbs write, and a plain key exists to contrast with', () => {
		expect(LOCKABLE_SETTING_KEYS).toContain(HELD_KEY);
		expect(LOCKABLE_SETTING_KEYS).toContain('defaultSshRemoteId');
		expect(PLAIN_KEY).toBeDefined();
	});

	it('writes an admitted held key through the desktop exactly once and never the file', async () => {
		expect(policy.install({ policyRevision: 3, locks: [{ key: 'ghPath' }] })).toMatchObject({
			installed: true,
		});
		await expect(writeSettingThroughHost(HELD_KEY, REMOTES)).resolves.toBe('desktop');
		expect(frames).toEqual([{ type: 'set_setting', key: HELD_KEY, value: REMOTES }]);
		expect(desktopWrites).toEqual([[HELD_KEY, REMOTES]]);
		expect(writeSettingValue).not.toHaveBeenCalled();
		expect(holdSettingWrite(HELD_KEY, { value: REMOTES })).toEqual({ allowed: true });
	});

	it('refuses a locked key with the policy line and state, writing neither sink; the GUI path answers the same', async () => {
		policy.install({ policyRevision: 3, locks: [{ key: HELD_KEY }] });
		const refused = await writeSettingThroughHost(HELD_KEY, REMOTES).catch((e: unknown) => e);
		const gui = holdSettingWrite(HELD_KEY, { value: REMOTES });
		expect(gui.allowed).toBe(false);
		if (gui.allowed) return;
		expect(refused).toBeInstanceOf(Error);
		expect((refused as Error).message).toBe(gui.message);
		expect((refused as { managed?: unknown }).managed).toEqual({ state: 'denied', code: gui.code });
		expect(desktopWrites).toEqual([]);
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('refuses unavailable, never falling back to the file, when an enrolled desktop has no usable policy', async () => {
		const refused = await writeSettingThroughHost(HELD_KEY, REMOTES).catch((e: unknown) => e);
		expect((refused as { managed?: unknown }).managed).toEqual({
			state: 'unavailable',
			code: 'unavailable',
		});
		expect(holdSettingWrite(HELD_KEY)).toMatchObject({ allowed: false, code: 'unavailable' });
		expect(desktopWrites).toEqual([]);
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('decides at dispatch, not at a CLI-side check: a policy move between two writes refuses the second', async () => {
		policy.install({ policyRevision: 3, locks: [] });
		await expect(writeSettingThroughHost(HELD_KEY, REMOTES)).resolves.toBe('desktop');
		revision = 4; // the endpoint applied a new revision; the installed policy is now stale
		const refused = await writeSettingThroughHost(HELD_KEY, []).catch((e: unknown) => e);
		expect((refused as { managed?: unknown }).managed).toMatchObject({ code: 'unavailable' });
		expect(desktopWrites).toEqual([[HELD_KEY, REMOTES]]);
		expect(frames).toHaveLength(2);
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('refuses an enrolled data dir with no desktop as not running, touching no file', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError('connect-failed'));
		vi.mocked(dataDirHasManagedBinding).mockReturnValue(true);
		await expect(writeSettingThroughHost(HELD_KEY, REMOTES)).rejects.toBeInstanceOf(
			MaestroNotRunningError
		);
		expect(writeSettingValue).not.toHaveBeenCalled();
	});

	it('writes the file only standalone with no desktop, and a plain key never asks the desktop', async () => {
		vi.mocked(withMaestroClient).mockRejectedValue(new MaestroNotRunningError('connect-failed'));
		await expect(writeSettingThroughHost(HELD_KEY, REMOTES)).resolves.toBe('file');
		expect(writeSettingValue).toHaveBeenCalledWith(HELD_KEY, REMOTES);
		vi.mocked(withMaestroClient).mockClear();
		await expect(writeSettingThroughHost(PLAIN_KEY as string, 1)).resolves.toBe('file');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});
