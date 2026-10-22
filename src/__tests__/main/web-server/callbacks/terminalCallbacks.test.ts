/**
 * The web terminal's PTY spawn is a host sink (MRC-08-01): the main process
 * spawns it for a WebSocket client, so it is admitted for the actor the
 * client's transport resolved, exactly as the renderer's
 * `process:spawnTerminalTab` is. A standalone host spawns as before; an
 * admitted spawn carries its admission into the exact request that was
 * admitted; a refusal spawns nothing and names the authority's state, code and
 * reason to the caller.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/stores/defaults', () => ({
	getDefaultShell: () => '/bin/zsh',
}));
// The actor resolver lives beside the renderer's spawn handler, which drags
// Electron in; the callback only hands its answer to `admitSpawn`.
const currentSpawnActor = vi.fn(() => ({ peer: 'in-process' as const }));
vi.mock('../../../../main/ipc/handlers/process/handle-spawn', () => ({
	currentSpawnActor: () => currentSpawnActor(),
}));

import { registerTerminalCallbacks } from '../../../../main/web-server/callbacks/terminalCallbacks';
import { runAsClient } from '../../../../main/web-server/auth/transport-actor';

type SpawnForWeb = (
	sessionId: string,
	config: { cwd: string; cols?: number; rows?: number }
) => Promise<{
	success: boolean;
	pid: number;
	error?: string;
	managed?: { state: string; code: string };
}>;

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

function setup(admit: () => unknown) {
	let spawnForWeb: SpawnForWeb | undefined;
	const server = new Proxy(
		{},
		{
			get: (_target, prop: string) =>
				prop === 'setSpawnTerminalForWebCallback'
					? (callback: SpawnForWeb) => {
							spawnForWeb = callback;
						}
					: () => {},
		}
	);
	const processManager = {
		admitSpawn: vi.fn(async () => admit()),
		terminalTabConfig: vi.fn((config: Record<string, unknown>) => ({
			...config,
			toolType: 'terminal',
			reuseTerminal: true,
			command: config.shell,
			args: [],
		})),
		spawnTerminalTab: vi.fn(() => ({ success: true, pid: 4242 })),
	};
	registerTerminalCallbacks(server as never, {
		getProcessManager: () => processManager as never,
		sessionsStore: { get: vi.fn(() => []) } as never,
		settingsStore: {
			get: vi.fn((_key: string, fallback: unknown) => fallback),
		} as never,
	});
	if (!spawnForWeb) throw new Error('spawnTerminalForWeb callback was not registered');
	return { spawnForWeb, processManager };
}

describe('spawnTerminalForWeb admission', () => {
	beforeEach(() => {
		currentSpawnActor.mockReset();
		currentSpawnActor.mockReturnValue({ peer: 'in-process' });
	});

	it('spawns as before on a standalone host, with no admission on the request', async () => {
		const { spawnForWeb, processManager } = setup(() => ({ state: 'standalone' }));
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
		currentSpawnActor.mockReturnValue({ peer: 'web-login', username: 'ada' } as never);
		const { spawnForWeb, processManager } = setup(() => ({
			state: 'admitted',
			admission: ADMISSION,
		}));
		await expect(spawnForWeb('agent-1', { cwd: '/work' })).resolves.toEqual({
			success: true,
			pid: 4242,
		});
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

	it('spawns nothing on a refusal and names the state, code and reason', async () => {
		const { spawnForWeb, processManager } = setup(() => ({
			state: 'unavailable',
			code: 'capability-unsupported',
			message: 'A managed PTY for terminal is unavailable on this host.',
		}));
		await expect(spawnForWeb('agent-1', { cwd: '/work' })).resolves.toEqual({
			success: false,
			pid: -1,
			error: 'A managed PTY for terminal is unavailable on this host.',
			managed: { state: 'unavailable', code: 'capability-unsupported' },
		});
		expect(processManager.spawnTerminalTab).not.toHaveBeenCalled();
	});

	it('resolves the actor inside the client context the message handler establishes', async () => {
		// The callback does not read the client itself; the resolver it calls
		// does, from the context `runAsClient` set up around the dispatch.
		currentSpawnActor.mockImplementation(() => ({ peer: 'in-process' }));
		const { spawnForWeb, processManager } = setup(() => ({ state: 'standalone' }));
		await runAsClient({ cli: true }, () => spawnForWeb('agent-1', { cwd: '/work' }));
		expect(currentSpawnActor).toHaveBeenCalledTimes(1);
		expect(processManager.admitSpawn).toHaveBeenCalledWith(expect.anything(), {
			peer: 'in-process',
		});
	});
});
