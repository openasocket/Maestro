import os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnPty } = vi.hoisted(() => ({ spawnPty: vi.fn() }));
vi.mock('node-pty', () => ({ spawn: spawnPty }));
vi.mock('../../../shared/platformDetection', () => ({ isWindows: () => true }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-terminal-test.sock',
}));
import { ProcessManager } from '../../../main/process-manager';
import { fakeSpawnPort } from '../../helpers/managedSpawnPort';

class TerminalPty {
	pid = 0;
	write = vi.fn();
	resize = vi.fn();
	kill = vi.fn();
	private readonly exits: Array<(event: { exitCode: number; signal?: number }) => void> = [];
	onData = vi.fn();
	onExit(callback: (event: { exitCode: number; signal?: number }) => void) {
		this.exits.push(callback);
		return { dispose() {} };
	}
	exit() {
		for (const listener of this.exits) listener({ exitCode: 0 });
	}
}
let manager: ProcessManager;
let pty: TerminalPty;
const id = 'host-session-terminal-shared-tab';
const terminalConfig = () => ({ sessionId: id, cwd: os.tmpdir(), shell: 'powershell' });
beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	pty = new TerminalPty();
	spawnPty.mockReturnValue(pty);
	manager = new ProcessManager();
});
afterEach(() => {
	manager.killAll({ shutdown: true });
	vi.useRealTimers();
});

describe('canonical terminal creation attaches to the host registry', () => {
	it('does not publish a running capture for a failed host process start', () => {
		const capture = vi.fn();
		manager.on('spawn', capture);
		spawnPty.mockImplementationOnce(() => {
			throw new Error('spawn ENOENT');
		});
		expect(manager.spawnTerminalTab(terminalConfig()).success).toBe(false);
		expect(capture).not.toHaveBeenCalled();
		expect(manager.get(id)).toBeUndefined();
	});
	it('publishes one running capture for a new zero-PID shell, not repeated attachments', () => {
		const capture = vi.fn();
		manager.on('spawn', capture);
		expect(manager.spawnTerminalTab(terminalConfig()).success).toBe(true);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBe(true);
		expect(capture).toHaveBeenCalledTimes(1);
	});
	it('keeps one zero-PID ConPTY through repeated client initialization and delivers typed commands to it', () => {
		const first = manager.spawnTerminalTab(terminalConfig());
		expect(first).toEqual({ success: true, pid: 0 });
		const original = manager.get(id);
		for (let client = 0; client < 100; client++) {
			expect(manager.spawnTerminalTab(terminalConfig())).toEqual({
				success: true,
				pid: 0,
				attached: true,
			});
		}
		expect(manager.get(id)).toBe(original);
		expect(spawnPty).toHaveBeenCalledTimes(1);
		expect(pty.kill).not.toHaveBeenCalled();
		expect(manager.write(id, 'Write-Output shared-terminal\r')).toBe(true);
		expect(pty.write).toHaveBeenCalledWith('Write-Output shared-terminal\r');
	});
	it('reuses the same host-owned SSH terminal rather than restarting its interactive connection', () => {
		const config = {
			sessionId: id,
			toolType: 'terminal',
			command: 'ssh',
			args: ['-t', 'host'],
			cwd: os.tmpdir(),
			reuseTerminal: true,
		};
		manager.spawn(config);
		expect(manager.spawn(config).attached).toBe(true);
		expect(spawnPty).toHaveBeenCalledTimes(1);
		expect(pty.kill).not.toHaveBeenCalled();
	});
	it('still creates a fresh shell after explicit kill and ignores the predecessor exit', () => {
		manager.spawnTerminalTab(terminalConfig());
		manager.kill(id);
		const next = new TerminalPty();
		spawnPty.mockReturnValue(next);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBeUndefined();
		expect(spawnPty).toHaveBeenCalledTimes(2);
		pty.exit();
		expect(manager.get(id)?.ptyProcess).toBe(next);
		expect(manager.write(id, 'echo restarted\r')).toBe(true);
		expect(next.write).toHaveBeenCalledWith('echo restarted\r');
	});
	it('creates a shell again after the prior handle has genuinely exited', () => {
		manager.spawnTerminalTab(terminalConfig());
		pty.exit();
		expect(manager.get(id)).toBeUndefined();
		const next = new TerminalPty();
		spawnPty.mockReturnValue(next);
		expect(manager.spawnTerminalTab(terminalConfig()).attached).toBeUndefined();
		expect(manager.get(id)?.ptyProcess).toBe(next);
	});
});

/**
 * Terminal and one-off sinks under management (MRC-06-06, MRC-06-09): a
 * managed PTY is unavailable, a terminal that predates the enrollment takes
 * no input, and a one-off command is refused at the runner before a shell
 * starts; a standalone host keeps every behavior above.
 */
describe('managed terminal sinks', () => {
	it('refuses a managed terminal tab without an admission, and a managed PTY even with one', async () => {
		const port = fakeSpawnPort();
		const managed = new ProcessManager(undefined, { spawnAuthority: () => port });
		const lines: string[] = [];
		managed.on('agent-error', (_id: string, error: { message: string }) =>
			lines.push(error.message)
		);

		expect(managed.spawnTerminalTab(terminalConfig())).toMatchObject({
			success: false,
			managed: { state: 'denied', code: 'lease-invalid' },
		});
		expect(spawnPty).not.toHaveBeenCalled();

		const request = managed.terminalTabConfig(terminalConfig());
		const admitted = await managed.admitSpawn(request, { peer: 'in-process' });
		if (admitted.state !== 'admitted') throw new Error(admitted.state);
		expect(
			managed.spawnTerminalTab({ ...terminalConfig(), admission: admitted.admission })
		).toMatchObject({
			success: false,
			managed: { state: 'unavailable', code: 'capability-unsupported' },
		});
		expect(spawnPty).not.toHaveBeenCalled();
		expect(lines.some((line) => line.includes('raw terminal has no confinement'))).toBe(true);
		// The lease was released by the refusal, not left issued.
		expect(port.authority.live()).toHaveLength(0);
		managed.killAll({ shutdown: true });
	});

	it('blocks writes into a terminal that predates the enrollment and surfaces why in the pane', () => {
		const port = fakeSpawnPort({ standing: 'standalone' });
		const host = new ProcessManager(undefined, { spawnAuthority: () => port });
		expect(host.spawnTerminalTab(terminalConfig()).success).toBe(true);
		expect(host.write(id, 'echo before\r')).toBe(true);

		port.setStanding('managed');
		const pane: string[] = [];
		host.on('data', (_id: string, data: string) => pane.push(data));
		expect(host.write(id, 'echo after\r')).toBe(false);
		expect(pty.write).toHaveBeenCalledTimes(1);
		expect(pane.join('')).toContain('started without an admission');
		host.killAll({ shutdown: true });
	});

	it('refuses a one-off local and SSH command at the runner with exit 126 and nothing started', async () => {
		const port = fakeSpawnPort();
		const managed = new ProcessManager(undefined, { spawnAuthority: () => port });
		const stderr: string[] = [];
		const exits: number[] = [];
		managed.on('stderr', (_id: string, text: string) => stderr.push(text));
		managed.on('command-exit', (_id: string, code: number) => exits.push(code));

		await expect(managed.runCommand(id, 'rm -rf /', '/tmp')).resolves.toEqual({ exitCode: 126 });
		await expect(
			managed.runCommand(id, 'rm -rf /', '/tmp', undefined, undefined, {
				id: 'r1',
				name: 'r1',
				host: 'remote',
				port: 22,
				username: 'dev',
				enabled: true,
			} as never)
		).resolves.toEqual({ exitCode: 126 });

		expect(spawnPty).not.toHaveBeenCalled();
		expect(exits).toEqual([126, 126]);
		expect(stderr.join('')).toContain('unavailable under management');
		expect(managed.cancelCommand(id)).toBe(false);
	});
});
