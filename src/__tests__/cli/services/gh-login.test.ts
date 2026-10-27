/**
 * `maestro-cli feedback login` under management (MRC2-04-05): a bare CLI on
 * an enrolled installation holds no authority that could hold the GitHub
 * sign-in to a ceiling, so the login is refused by name before any process
 * starts. Standalone, gh runs attached to the terminal as before.
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockCliSpawnAuthority } = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockCliSpawnAuthority: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: mockSpawn }));
vi.mock('../../../cli/services/agent-spawner', () => ({
	cliSpawnAuthority: () => mockCliSpawnAuthority(),
}));

import { GhLoginRefusedError, runGhLogin } from '../../../cli/services/gh-login';

const login = {
	command: '/opt/gh',
	args: ['auth', 'login', '--web'],
	display: 'gh auth login --web',
};

/** A child that exits with `code` on the next tick. */
function exitingChild(code: number) {
	const child = new EventEmitter();
	mockSpawn.mockImplementation(() => {
		queueMicrotask(() => child.emit('exit', code, null));
		return child;
	});
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('runGhLogin under management (MRC2-04-05)', () => {
	it('standalone: spawns gh attached to the terminal and resolves to its exit code', async () => {
		exitingChild(0);
		const standalone = { standing: () => 'standalone' as const, unavailableReason: null };

		await expect(runGhLogin(login, true, standalone)).resolves.toBe(0);
		expect(mockSpawn).toHaveBeenCalledWith('/opt/gh', ['auth', 'login', '--web'], {
			stdio: ['inherit', 2, 'inherit'],
		});
	});

	it("managed: refuses by name with the authority's reason and spawns nothing", async () => {
		const managed = {
			standing: () => 'managed' as const,
			unavailableReason: 'This process holds no attached host authority.',
		};

		const refusal = await runGhLogin(login, false, managed).catch((e: unknown) => e);
		expect(refusal).toBeInstanceOf(GhLoginRefusedError);
		expect((refusal as Error).message).toMatch(/^\[managed-unavailable\] /);
		expect((refusal as Error).message).toContain('This process holds no attached host authority.');
		expect((refusal as Error).message).toContain('Nothing was run');
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("reads the CLI's own binding by default", async () => {
		mockCliSpawnAuthority.mockReturnValue({
			standing: () => 'managed',
			unavailableReason: 'enrolled, no attached host',
		});

		await expect(runGhLogin(login)).rejects.toThrow('[managed-unavailable]');
		expect(mockCliSpawnAuthority).toHaveBeenCalledTimes(1);
		expect(mockSpawn).not.toHaveBeenCalled();

		exitingChild(3);
		mockCliSpawnAuthority.mockReturnValue({
			standing: () => 'standalone',
			unavailableReason: null,
		});
		await expect(runGhLogin(login)).resolves.toBe(3);
		expect(mockSpawn).toHaveBeenCalledTimes(1);
	});
});
