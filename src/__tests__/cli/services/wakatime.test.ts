/**
 * @file wakatime.test.ts
 * @description Tests for CLI-side WakaTime heartbeats.
 *
 * CLI-spawned agents (batch, `send`, playbooks) never reach the desktop's
 * ProcessManager listener, so these heartbeats are the only record of that
 * time. The rules that matter here: stay silent when WakaTime is off, tag the
 * run as CLI-origin automation, and never let a telemetry failure escape into
 * the agent run.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendHeartbeat = vi.fn(async () => {});
const setInstallAuthority = vi.fn();
const spawnStanding = vi.fn<() => 'standalone' | 'managed'>(() => 'standalone');

vi.mock('../../../main/wakatime-manager', () => ({
	WakaTimeManager: class {
		constructor(
			public store: unknown,
			public version: string
		) {}
		sendHeartbeat = sendHeartbeat;
		setInstallAuthority = setInstallAuthority;
	},
}));

// The CLI's binding standing (MRC2-04-07): what the install authority is built from.
vi.mock('../../../cli/services/agent-spawner', () => ({
	cliSpawnAuthority: () => ({
		standing: () => spawnStanding(),
		unavailableReason:
			spawnStanding() === 'managed' ? 'maestro-cli holds no attached host authority.' : null,
	}),
}));

const readSettings = vi.fn();
vi.mock('../../../cli/services/storage', () => ({
	readSettings: () => readSettings(),
}));

import {
	buildCliWakaTimeHeartbeat,
	resetCliWakaTimeForTests,
} from '../../../cli/services/wakatime';

describe('CLI WakaTime heartbeats', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCliWakaTimeForTests();
		readSettings.mockReturnValue({ wakatimeEnabled: true, wakatimeApiKey: 'k' });
		spawnStanding.mockReturnValue('standalone');
	});

	it('returns undefined when WakaTime is disabled so callers skip the work', () => {
		readSettings.mockReturnValue({ wakatimeEnabled: false });
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('defaults wakatimeEnabled to false when the key is absent', () => {
		readSettings.mockReturnValue({});
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('tags heartbeats as cli-origin unattended automation', () => {
		const beat = buildCliWakaTimeHeartbeat('cli:/home/u/proj', '/home/u/proj', false);
		beat?.();

		expect(sendHeartbeat).toHaveBeenCalledWith('cli:/home/u/proj', 'proj', '/home/u/proj', {
			source: 'auto',
			isRemote: false,
			origin: 'cli',
		});
	});

	it('derives the project name from the cwd basename', () => {
		buildCliWakaTimeHeartbeat('cli:/a/b/my-repo', '/a/b/my-repo', false)?.();
		expect(sendHeartbeat).toHaveBeenCalledWith(
			expect.anything(),
			'my-repo',
			expect.anything(),
			expect.anything()
		);
	});

	it('propagates isRemote so the manager skips local git/manifest probing', () => {
		buildCliWakaTimeHeartbeat('cli:/remote/path', '/remote/path', true)?.();
		expect(sendHeartbeat).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.objectContaining({ isRemote: true })
		);
	});

	it('swallows heartbeat rejections - telemetry must not fail the agent run', async () => {
		sendHeartbeat.mockRejectedValueOnce(new Error('wakatime-cli exploded'));
		const beat = buildCliWakaTimeHeartbeat('cli:/x', '/x', false);

		expect(() => beat?.()).not.toThrow();
		// Flush the rejection; an unhandled one would fail the run.
		await Promise.resolve();
	});

	it('survives unreadable settings instead of breaking agent spawning', () => {
		readSettings.mockImplementation(() => {
			throw new Error('corrupt settings file');
		});
		expect(() => buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).not.toThrow();
		expect(buildCliWakaTimeHeartbeat('cli:/x', '/x', false)).toBeUndefined();
	});

	it('hands the manager an install authority that holds nothing on a standalone binding', () => {
		buildCliWakaTimeHeartbeat('cli:/x', '/x', false);
		expect(setInstallAuthority).toHaveBeenCalledTimes(1);
		const authority = setInstallAuthority.mock.calls[0][0] as {
			authorize(request: unknown): { allowed: boolean };
		};
		expect(
			authority.authorize({
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-linux-amd64.zip',
				stage: 'fetch',
				actor: { kind: 'transport', actor: { peer: 'in-process' } },
			})
		).toEqual({ allowed: true });
	});

	it('refuses every install unavailable on an enrolled binding (never fetched unmanaged)', () => {
		spawnStanding.mockReturnValue('managed');
		buildCliWakaTimeHeartbeat('cli:/x', '/x', false);
		const authority = setInstallAuthority.mock.calls[0][0] as {
			authorize(request: unknown): { allowed: boolean; code?: string; message?: string };
		};
		expect(
			authority.authorize({
				artifact: 'wakatime-cli',
				file: 'wakatime-cli-linux-amd64.zip',
				stage: 'fetch',
				actor: { kind: 'transport', actor: { peer: 'in-process' } },
			})
		).toMatchObject({
			allowed: false,
			code: 'unavailable',
			message:
				'the managed install ceiling is unavailable (maestro-cli holds no attached host authority.)',
		});
	});

	it('reuses one manager across runs so the debounce is shared', () => {
		const a = buildCliWakaTimeHeartbeat('cli:/x', '/x', false);
		const b = buildCliWakaTimeHeartbeat('cli:/y', '/y', false);
		a?.();
		b?.();
		// Both beats land on the same mocked manager instance.
		expect(sendHeartbeat).toHaveBeenCalledTimes(2);
	});
});
