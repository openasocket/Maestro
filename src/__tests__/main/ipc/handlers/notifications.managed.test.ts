/**
 * User-configured notification commands under management (MRC2-04-06). The
 * `notification:speak` handler runs the person's audio feedback or idle
 * command through a shell with the text on stdin and the Maestro context in
 * `MAESTRO_NOTIFY_*`. Under management the exact command string is held
 * against the shell ceiling right before the shell starts: a string the
 * ceiling does not list never spawns, the caller is answered `refused` with
 * the reason, the reason reaches the log once, and a refusal imposes no
 * spacing on the next command. Standalone spawns what it spawned before.
 *
 * The real handler and the real policy source run here over a mocked
 * `child_process`, so a refusal is proven by the absence of a spawn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { spawn } from 'child_process';

import { createShellPolicySource } from '../../../../main/enterprise/shell-policy';
import type { IdentityRead } from '../../../../main/enterprise/identity-store';
import {
	NOTIFICATION_SHELL_SURFACE,
	registerNotificationsHandlers,
	resetNotificationState,
	getActiveNotificationCount,
} from '../../../../main/ipc/handlers/notifications';
import { logger } from '../../../../main/utils/logger';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
	Notification: class {
		static isSupported() {
			return false;
		}
	},
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/deep-links', () => ({
	parseDeepLink: vi.fn(),
	dispatchDeepLink: vi.fn(),
}));

vi.mock('../../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

vi.mock('../../../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: vi.fn().mockResolvedValue(true),
}));

const { children } = vi.hoisted(() => ({ children: [] as Array<Record<string, any>> }));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const mockSpawn = vi.fn(() => {
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const child = {
			stdin: {
				written: [] as string[],
				write: vi.fn((data: string, _enc: string, cb?: () => void) => {
					child.stdin.written.push(data);
					cb?.();
				}),
				end: vi.fn(),
				on: vi.fn(),
			},
			stderr: { on: vi.fn() },
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				listeners.set(event, handler);
			}),
			kill: vi.fn(),
			/** Finish the process so the queue moves on. */
			close: () => listeners.get('close')?.(0, null),
		};
		children.push(child);
		return child;
	});
	return { ...actual, default: { ...actual, spawn: mockSpawn }, spawn: mockSpawn };
});

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

/** A ceiling that admits exactly two notification commands. */
const ceiling = {
	policyRevision: 3,
	surfaces: [{ surface: NOTIFICATION_SHELL_SURFACE, commands: ['say', 'espeak | tee ~/log'] }],
};

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

describe('notification commands under the shell ceiling (MRC2-04-06)', () => {
	let handlers: Map<string, Handler>;

	/** Register the handlers over the real source: standalone, or enrolled with or without a ceiling. */
	function register(mode: 'standalone' | 'enrolled' | 'ceiling'): void {
		const shell = createShellPolicySource({
			identity: { read: () => (mode === 'standalone' ? { status: 'none' } : enrolled) },
			policy: () => ({ appliedRevision: 3 }),
		});
		if (mode === 'ceiling') {
			const out = shell.install(ceiling);
			if (!out.installed) throw new Error(out.problems.join('; '));
		}
		registerNotificationsHandlers({ getMainWindow: () => null, shellAuthority: () => shell });
	}

	const speak = (text: string, command?: string, vars?: Record<string, string>) =>
		handlers.get('notification:speak')!({}, text, command, vars);

	beforeEach(() => {
		vi.clearAllMocks();
		children.length = 0;
		resetNotificationState();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});
	});

	afterEach(() => {
		resetNotificationState();
	});

	it('standalone: any configured command spawns through the shell with stdin and the context env', async () => {
		register('standalone');
		const result = await speak('Build finished', 'fabric | say -v Alex', {
			agent: 'Maestro',
			tab: 'main',
		});
		expect(result).toEqual({ success: true, notificationId: 1 });
		expect(spawn).toHaveBeenCalledTimes(1);
		const [command, args, options] = vi.mocked(spawn).mock.calls[0] as unknown as [
			string,
			string[],
			Record<string, any>,
		];
		expect(command).toBe('fabric | say -v Alex');
		expect(args).toEqual([]);
		expect(options.shell).toBe(true);
		expect(options.stdio).toEqual(['pipe', 'ignore', 'pipe']);
		expect(options.env.MAESTRO_NOTIFY_AGENT).toBe('Maestro');
		expect(options.env.MAESTRO_NOTIFY_TAB).toBe('main');
		expect(options.env.MAESTRO_NOTIFY_GROUP).toBeUndefined();
		expect(children[0].stdin.written).toEqual(['Build finished']);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('enrolled with no ceiling: refuses unavailable by name, spawns nothing, logs once per reason', async () => {
		register('enrolled');
		const first = await speak('Build finished', 'say');
		expect(first.success).toBe(false);
		expect(first.refused).toBe(true);
		expect(first.error).toMatch(
			/^\[managed-unavailable\] the managed shell ceiling is unavailable/
		);
		expect(first.notificationId).toBeUndefined();
		expect(spawn).not.toHaveBeenCalled();
		expect(getActiveNotificationCount()).toBe(0);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(vi.mocked(logger.warn).mock.calls[0][2]).toMatchObject({
			command: 'say',
			code: 'unavailable',
			receipt: {
				policyRevision: 3,
				surface: 'notification',
				actor: 'the operator',
				command: 'say',
				outcome: 'unavailable',
			},
		});
		// The same reason is not written again, whatever command carried it: an
		// unavailable ceiling is one fact about the host, not one per toast.
		const second = await speak('Tests passed', 'say');
		expect(second.refused).toBe(true);
		const third = await speak('Tests passed', 'espeak');
		expect(third.refused).toBe(true);
		expect(third.error).toBe(first.error);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(spawn).not.toHaveBeenCalled();
	});

	it('under a ceiling: the exact listed string runs with stdin and env; a near miss never spawns', async () => {
		register('ceiling');
		const refused = await speak('Build finished', 'say -v Alex', { agent: 'Maestro' });
		expect(refused).toEqual({
			success: false,
			refused: true,
			error: expect.stringMatching(
				/^\[managed-outside-ceiling\] the shell ceiling does not list the configured notification command "say -v Alex"/
			),
		});
		expect(spawn).not.toHaveBeenCalled();
		for (const command of ['Say', 'say; rm -rf ~', 'espeak | tee ~/log2']) {
			const result = await speak('Build finished', command);
			expect(result.refused, command).toBe(true);
		}
		expect(spawn).not.toHaveBeenCalled();

		// A refusal imposes no spacing: the admitted command that follows runs at once.
		const admitted = await speak('Build finished', ' espeak | tee ~/log ', { task: 'Ship it' });
		expect(admitted).toEqual({ success: true, notificationId: 1 });
		expect(spawn).toHaveBeenCalledTimes(1);
		const [command, , options] = vi.mocked(spawn).mock.calls[0] as unknown as [
			string,
			string[],
			Record<string, any>,
		];
		expect(command).toBe('espeak | tee ~/log');
		expect(options.shell).toBe(true);
		expect(options.env.MAESTRO_NOTIFY_TASK).toBe('Ship it');
		expect(children[0].stdin.written).toEqual(['Build finished']);
	});

	it('the default command is held by its resolved string, and the empty text short-circuit runs no hold', async () => {
		register('ceiling');
		// No command configured resolves to the default `say`, which the ceiling lists.
		const result = await speak('Done', undefined);
		expect(result.success).toBe(true);
		expect(vi.mocked(spawn).mock.calls[0][0]).toBe('say');
		children[0].close();
		// Empty text never reaches the hold or the shell, in any mode.
		expect(await speak('   ', 'rm -rf ~')).toEqual({ success: true });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('a ceiling installed after registration is honored by the next command without re-wiring', async () => {
		const shell = createShellPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		registerNotificationsHandlers({ getMainWindow: () => null, shellAuthority: () => shell });
		expect((await speak('Done', 'say')).refused).toBe(true);
		expect(spawn).not.toHaveBeenCalled();
		shell.install(ceiling);
		expect((await speak('Done', 'say')).success).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it('no authority wired (tests, a bare host) holds nothing', async () => {
		registerNotificationsHandlers({ getMainWindow: () => null });
		expect((await speak('Done', 'anything | at all')).success).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});
