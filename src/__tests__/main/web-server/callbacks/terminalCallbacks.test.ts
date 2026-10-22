/**
 * The web terminal's PTY is a host sink (MRC-08-01): the main process spawns
 * it for a WebSocket client, so it is admitted for the actor the client's
 * transport resolved, exactly as the renderer's `process:spawnTerminalTab`
 * is. A standalone host spawns as before; an admitted spawn carries its
 * admission into the exact request that was admitted; a refusal spawns
 * nothing and names the authority's state, code and reason to the caller.
 *
 * The PTY outlives the socket (MRC-08-02): a reconnecting client attaches to
 * the live handle, and later writes and resizes arrive from whichever socket
 * is subscribed. Under management the PTY is bound to the actor it was
 * admitted for: that actor attaches, writes and resizes (no new admission is
 * asked for an attach), any other is refused with the reason, and a
 * standalone host behaves as it always did. The actor is resolved from the
 * real transport context `runAsClient` establishes, never mocked.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/stores/defaults', () => ({
	getDefaultShell: () => '/bin/zsh',
}));

import { registerTerminalCallbacks } from '../../../../main/web-server/callbacks/terminalCallbacks';
import {
	runAsClient,
	type TransportClient,
} from '../../../../main/web-server/auth/transport-actor';

type SpawnForWeb = (
	sessionId: string,
	config: { cwd: string; cols?: number; rows?: number }
) => Promise<{
	success: boolean;
	pid: number;
	error?: string;
	managed?: { state: string; code: string };
}>;
type InputResult = boolean | { success: false; error: string; managed?: unknown };
type WriteToTerminal = (sessionId: string, data: string) => InputResult;
type ResizeTerminal = (sessionId: string, cols: number, rows: number) => InputResult;
type KillForWeb = (sessionId: string) => boolean;

const ADMISSION = Object.freeze({
	leaseId: 'lease-1',
	authorityId: 'authority-1',
	requestDigest: 'digest-1',
	actor: { kind: 'human', id: 'operator:inst-1' },
	provider: 'terminal',
	operation: 'spawn',
	target: { kind: 'local' },
	policyRevision: 3,
	requestId: 'req-1',
	attemptId: 'att-1',
});

const ada: TransportClient = { user: { id: 'u1', username: 'ada', displayName: 'Ada' } };
const bob: TransportClient = { user: { id: 'u2', username: 'bob', displayName: 'Bob' } };
const cli: TransportClient = { cli: true };
const device: TransportClient = {
	admission: 'device-pairing',
	user: { id: 'paired-device:dev-7', username: 'paired-device', displayName: 'Pixel 9' },
};
const ownerToken: TransportClient = {};

interface Setup {
	admit: () => unknown;
	/** Whether the host holds a bound admission for the PTY (a managed host did). */
	admitted?: boolean;
}

function setup({ admit, admitted = false }: Setup) {
	let spawnForWeb: SpawnForWeb | undefined;
	let writeToTerminal: WriteToTerminal | undefined;
	let resizeTerminal: ResizeTerminal | undefined;
	let killForWeb: KillForWeb | undefined;
	const server = new Proxy(
		{},
		{
			get: (_target, prop: string) => {
				switch (prop) {
					case 'setSpawnTerminalForWebCallback':
						return (callback: SpawnForWeb) => {
							spawnForWeb = callback;
						};
					case 'setWriteToTerminalCallback':
						return (callback: WriteToTerminal) => {
							writeToTerminal = callback;
						};
					case 'setResizeTerminalCallback':
						return (callback: ResizeTerminal) => {
							resizeTerminal = callback;
						};
					case 'setKillTerminalForWebCallback':
						return (callback: KillForWeb) => {
							killForWeb = callback;
						};
					default:
						return () => {};
				}
			},
		}
	);
	// The PTY registry the callbacks consult: live after a successful spawn,
	// gone after a kill. `admissionOf` is what tells a host-admitted PTY from
	// a standalone one.
	const live = new Set<string>();
	const processManager = {
		admitSpawn: vi.fn(async () => admit()),
		terminalTabConfig: vi.fn((config: Record<string, unknown>) => ({
			...config,
			toolType: 'terminal',
			reuseTerminal: true,
			command: config.shell,
			args: [],
		})),
		spawnTerminalTab: vi.fn((config: { sessionId: string }) => {
			const attached = live.has(config.sessionId);
			live.add(config.sessionId);
			return attached ? { success: true, pid: 4242, attached: true } : { success: true, pid: 4242 };
		}),
		terminalAttachable: vi.fn((sessionId: string) => live.has(sessionId)),
		admissionOf: vi.fn((sessionId: string) => (admitted && live.has(sessionId) ? ADMISSION : null)),
		write: vi.fn(() => true),
		resize: vi.fn(() => true),
		get: vi.fn((sessionId: string) => (live.has(sessionId) ? { sessionId } : undefined)),
		kill: vi.fn((sessionId: string) => live.delete(sessionId)),
	};
	registerTerminalCallbacks(server as never, {
		getProcessManager: () => processManager as never,
		sessionsStore: { get: vi.fn(() => []) } as never,
		settingsStore: {
			get: vi.fn((_key: string, fallback: unknown) => fallback),
		} as never,
	});
	if (!spawnForWeb || !writeToTerminal || !resizeTerminal || !killForWeb) {
		throw new Error('terminal callbacks were not all registered');
	}
	return { spawnForWeb, writeToTerminal, resizeTerminal, killForWeb, processManager, live };
}

const standalone = () => ({ state: 'standalone' });
const managed = () => ({ state: 'admitted', admission: ADMISSION });

describe('spawnTerminalForWeb admission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('spawns as before on a standalone host, with no admission on the request', async () => {
		const { spawnForWeb, processManager } = setup({ admit: standalone });
		await expect(spawnForWeb('agent-1', { cwd: '/work', cols: 100, rows: 30 })).resolves.toEqual({
			success: true,
			pid: 4242,
		});
		expect(processManager.admitSpawn).toHaveBeenCalledTimes(1);
		const [spawned] = processManager.spawnTerminalTab.mock.calls[0] as [Record<string, unknown>];
		expect(spawned).toMatchObject({
			sessionId: 'agent-1-terminal',
			cwd: '/work',
			shell: '/bin/zsh',
			cols: 100,
			rows: 30,
		});
		expect(spawned).not.toHaveProperty('admission');
	});

	it('admits the exact request it spawns, for the actor the transport resolved', async () => {
		const { spawnForWeb, processManager } = setup({ admit: managed });
		await expect(runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }))).resolves.toEqual(
			{ success: true, pid: 4242 }
		);
		const [admittedConfig, actor] = processManager.admitSpawn.mock.calls[0] as unknown as [
			Record<string, unknown>,
			unknown,
		];
		expect(actor).toEqual({ peer: 'web-login', username: 'ada' });
		expect(admittedConfig).toMatchObject({
			sessionId: 'agent-1-terminal',
			toolType: 'terminal',
			cwd: '/work',
		});
		const [spawned] = processManager.spawnTerminalTab.mock.calls[0] as [Record<string, unknown>];
		expect(spawned.admission).toBe(ADMISSION);
		expect(spawned).toMatchObject({ sessionId: 'agent-1-terminal', cwd: '/work' });
	});

	it('binds the CLI secret as the host secret and a paired device as the device', async () => {
		const { spawnForWeb, processManager } = setup({ admit: standalone });
		await runAsClient(cli, () => spawnForWeb('agent-1', { cwd: '/work' }));
		await runAsClient(device, () => spawnForWeb('agent-2', { cwd: '/work' }));
		expect(processManager.admitSpawn.mock.calls.map((call) => call[1])).toEqual([
			{ peer: 'host-secret' },
			{ peer: 'device-pairing', deviceId: 'dev-7' },
		]);
	});

	it('spawns nothing on a refusal and names the state, code and reason', async () => {
		const { spawnForWeb, processManager } = setup({
			admit: () => ({
				state: 'unavailable',
				code: 'capability-unsupported',
				message: 'A managed PTY for terminal is unavailable on this host.',
			}),
		});
		await expect(spawnForWeb('agent-1', { cwd: '/work' })).resolves.toEqual({
			success: false,
			pid: -1,
			error: 'A managed PTY for terminal is unavailable on this host.',
			managed: { state: 'unavailable', code: 'capability-unsupported' },
		});
		expect(processManager.spawnTerminalTab).not.toHaveBeenCalled();
	});
});

describe('attaching to a live web PTY (MRC-08-02)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('on a standalone host any client attaches, as before, and no admission is asked for', async () => {
		const { spawnForWeb, processManager } = setup({ admit: standalone });
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		await expect(runAsClient(bob, () => spawnForWeb('agent-1', { cwd: '/work' }))).resolves.toEqual(
			{ success: true, pid: 4242, attached: true }
		);
		expect(processManager.admitSpawn).toHaveBeenCalledTimes(1);
	});

	it('under management the actor the PTY was admitted for attaches again without a new admission', async () => {
		const { spawnForWeb, processManager } = setup({ admit: managed, admitted: true });
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		// The same account on a fresh socket (a reconnect).
		await expect(
			runAsClient({ user: { id: 'u1-again', username: 'ada', displayName: 'Ada L.' } }, () =>
				spawnForWeb('agent-1', { cwd: '/work' })
			)
		).resolves.toEqual({ success: true, pid: 4242, attached: true });
		expect(processManager.admitSpawn).toHaveBeenCalledTimes(1);
	});

	it("under management another actor is refused and the PTY stays its owner's", async () => {
		const { spawnForWeb, processManager } = setup({ admit: managed, admitted: true });
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		const result = await runAsClient(bob, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(result).toMatchObject({
			success: false,
			pid: -1,
			managed: { state: 'denied', code: 'context-mismatch' },
		});
		expect(result.error).toContain('admitted for web-login:ada');
		expect(result.error).toContain('attaching by web-login:bob');
		expect(processManager.spawnTerminalTab).toHaveBeenCalledTimes(1);
		expect(processManager.kill).not.toHaveBeenCalled();
		// The device and the CLI are different actors from the account too.
		await expect(
			runAsClient(device, () => spawnForWeb('agent-1', { cwd: '/work' }))
		).resolves.toMatchObject({ success: false });
		await expect(
			runAsClient(cli, () => spawnForWeb('agent-1', { cwd: '/work' }))
		).resolves.toMatchObject({ success: false });
	});

	it('a PTY that died is spawned again and records its new owner', async () => {
		const { spawnForWeb, live, processManager } = setup({ admit: managed, admitted: true });
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		live.delete('agent-1-terminal');
		await expect(runAsClient(bob, () => spawnForWeb('agent-1', { cwd: '/work' }))).resolves.toEqual(
			{ success: true, pid: 4242 }
		);
		expect(processManager.admitSpawn).toHaveBeenCalledTimes(2);
		// Bob owns it now: Ada is the one refused.
		await expect(
			runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }))
		).resolves.toMatchObject({ success: false });
	});
});

describe('web PTY input is bound to the admitted actor (MRC-08-02)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('on a standalone host any subscribed client writes and resizes, as before', async () => {
		const { spawnForWeb, writeToTerminal, resizeTerminal, processManager } = setup({
			admit: standalone,
		});
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(runAsClient(bob, () => writeToTerminal('agent-1', 'ls\r'))).toBe(true);
		expect(runAsClient(cli, () => resizeTerminal('agent-1', 120, 40))).toBe(true);
		expect(processManager.write).toHaveBeenCalledWith('agent-1-terminal', 'ls\r');
		expect(processManager.resize).toHaveBeenCalledWith('agent-1-terminal', 120, 40);
	});

	it('under management the owner writes and resizes; another account, the CLI and a device are refused', async () => {
		const { spawnForWeb, writeToTerminal, resizeTerminal, processManager } = setup({
			admit: managed,
			admitted: true,
		});
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(runAsClient(ada, () => writeToTerminal('agent-1', 'ls\r'))).toBe(true);
		expect(runAsClient(ada, () => resizeTerminal('agent-1', 80, 24))).toBe(true);

		const refusedWrite = runAsClient(bob, () => writeToTerminal('agent-1', 'rm -rf /\r'));
		expect(refusedWrite).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'context-mismatch' },
		});
		expect((refusedWrite as { error: string }).error).toContain('input by web-login:bob');
		expect(runAsClient(cli, () => writeToTerminal('agent-1', 'x'))).toMatchObject({
			success: false,
		});
		expect(runAsClient(device, () => writeToTerminal('agent-1', 'x'))).toMatchObject({
			success: false,
		});
		expect(runAsClient(bob, () => resizeTerminal('agent-1', 1, 1))).toMatchObject({
			success: false,
		});
		// Nothing of the refused input reached the PTY.
		expect(processManager.write).toHaveBeenCalledTimes(1);
		expect(processManager.resize).toHaveBeenCalledTimes(1);
	});

	it('a host-admitted PTY with no recorded web owner belongs to the operator', () => {
		// The desktop's own handler admitted `{agent}-terminal` for in-process;
		// the path token is the operator too, an account is not.
		const { writeToTerminal, live } = setup({ admit: managed, admitted: true });
		live.add('agent-1-terminal');
		expect(runAsClient(ownerToken, () => writeToTerminal('agent-1', 'ls\r'))).toBe(true);
		expect(runAsClient(ada, () => writeToTerminal('agent-1', 'ls\r'))).toMatchObject({
			success: false,
		});
	});

	it('a kill forgets the owner, so the next spawn records whoever asks', async () => {
		const { spawnForWeb, killForWeb, writeToTerminal } = setup({
			admit: managed,
			admitted: true,
		});
		await runAsClient(ada, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(killForWeb('agent-1')).toBe(true);
		await runAsClient(device, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(runAsClient(device, () => writeToTerminal('agent-1', 'ls\r'))).toBe(true);
		expect(runAsClient(ada, () => writeToTerminal('agent-1', 'ls\r'))).toMatchObject({
			success: false,
		});
	});
});
