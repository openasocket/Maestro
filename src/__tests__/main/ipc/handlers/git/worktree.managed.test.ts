/**
 * Worktrees, the user's setup script and the web git callbacks under
 * management (MRC2-04-03). `git:worktreeSetup` runs `worktree add` through
 * the shared executor, so a managed refusal spawns no process, releases the
 * creation mark and reports the reason; `git:worktreeRunSetup` holds the
 * configured script to the repository ceiling as the `setup-script` effect
 * before any shell starts, locally or over SSH, and answers `skipped` with the
 * reason instead of running it; the web git callbacks reach the executor with
 * the transport the host resolved for the socket. Standalone, every path
 * spawns what it spawned before.
 *
 * The real executor (`remote-git.ts`), the real setup-script runner and the
 * real gate and policy source (`repository-policy.ts`) run here over a mocked
 * process layer, so a refusal is proven by the absence of a spawn.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

import * as execFile from '../../../../../main/utils/execFile';
import { setGitExecutionGate } from '../../../../../main/utils/remote-git';
import {
	createGitExecutionGate,
	createRepositoryPolicySource,
} from '../../../../../main/enterprise/repository-policy';
import type { IdentityRead } from '../../../../../main/enterprise/identity-store';
import type { ProcessSpawnActor } from '../../../../../main/process-manager/types';
import { registerWorktreeHandlers } from '../../../../../main/ipc/handlers/git/worktree';
import {
	clearWorktreeCreationMarks,
	isWorktreeCreatedByMaestro,
} from '../../../../../main/ipc/handlers/git/worktreeCreationMarks';
import { registerGitCallbacks } from '../../../../../main/web-server/callbacks/gitCallbacks';
import {
	getActingTransport,
	runAsClient,
	transportSpawnActor,
} from '../../../../../main/web-server/auth/transport-actor';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
	execFileBufferNoThrow: vi.fn(),
	execFileStreaming: vi.fn(),
}));

const { mockBuildSshCommand, mockGetSshRemoteById, mockFs } = vi.hoisted(() => ({
	mockBuildSshCommand: vi.fn(),
	mockGetSshRemoteById: vi.fn(),
	mockFs: {
		access: vi.fn(),
		realpath: vi.fn(),
		readdir: vi.fn(),
		rmdir: vi.fn(),
		rm: vi.fn(),
	},
}));

vi.mock('fs/promises', () => ({ default: mockFs }));

vi.mock('../../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: mockBuildSshCommand,
}));

vi.mock('../../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => false),
}));

vi.mock('../../../../../main/utils/branch-switch-guard', () => ({
	branchSwitchBlocker: vi.fn(async () => null),
}));

vi.mock('../../../../../main/agent-run/worktree-stale', () => ({
	markStaleForDeletedWorktreeUsingStore: vi.fn(),
}));

vi.mock('../../../../../main/stores', () => ({
	getSshRemoteById: mockGetSshRemoteById,
}));

vi.mock('../../../../../shared/maestro-lib/launch/getShellPath', () => ({
	getShellPath: vi.fn(async () => '/shell/bin'),
	peekShellPath: vi.fn(() => null),
	default: vi.fn(async () => '/shell/bin'),
}));

const enrolled: IdentityRead = {
	status: 'ok',
	epoch: 1,
	record: {
		version: 1,
		installationId: 'inst',
		tenantId: 't',
		orgId: 'o',
		enrolledAt: 1,
		updatedAt: 1,
		managementState: 'enrolled',
		endpoint: { socketPath: '/tmp/x.sock', authorityId: 'a' },
		registration: { actorId: 'actor', registeredAt: 1 },
		policy: { appliedRevision: 3, appliedAt: 1 },
	} as never,
};

/** A ceiling that admits the operator's worktrees and setup scripts on acme repositories. */
const ceiling = {
	policyRevision: 3,
	actors: [{ actor: 'operator', effects: ['branch', 'setup-script'] }],
	repositories: { allow: ['acme/*'] },
};

/** The same ceiling with no user scripts at all. */
const noScripts = {
	policyRevision: 3,
	actors: [{ actor: 'operator', effects: ['branch'] }],
	repositories: { allow: ['acme/*'] },
};

/** Install the real gate over the real policy source: enrolled, with or without a ceiling. */
function manage(document: Record<string, unknown> | null = null): void {
	const repository = createRepositoryPolicySource({
		identity: { read: () => enrolled },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (document) {
		const out = repository.install(document);
		if (!out.installed) throw new Error(out.problems.join('; '));
	}
	setGitExecutionGate(createGitExecutionGate({ repository }));
}

const sshRemote = {
	id: 'r1',
	name: 'Box',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '/k',
	enabled: true,
};

/** Answer each command line the handlers and the gate run; an unlisted one fails. */
function answer(answers: Record<string, string>): void {
	vi.mocked(execFile.execFileNoThrow).mockImplementation(async (command, args) => {
		const key = `${command} ${(args as string[]).join(' ')}`;
		if (key in answers) return { stdout: answers[key], stderr: '', exitCode: 0 };
		return { stdout: '', stderr: `no answer for ${key}`, exitCode: 1 };
	});
}

/** Every command line run so far, as text. */
function ran(): string[] {
	return vi
		.mocked(execFile.execFileNoThrow)
		.mock.calls.map(([command, args]) => `${command} ${(args as string[]).join(' ')}`);
}

const shell = process.env.SHELL || '/bin/sh';
const ORIGIN = 'https://github.com/acme/widgets.git';
const SCRIPT_CONTEXT = { worktreePath: '/wt', branchName: 'feature', mainRepoPath: '/main/repo' };

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

describe('worktrees and the setup script under the repository ceiling (MRC2-04-03)', () => {
	let handlers: Map<string, Handler>;

	beforeEach(() => {
		vi.clearAllMocks();
		setGitExecutionGate(null);
		clearWorktreeCreationMarks();
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});
		registerWorktreeHandlers({ settingsStore: { get: vi.fn() }, getMainWindow: () => null });
		mockGetSshRemoteById.mockReturnValue(undefined);
		mockBuildSshCommand.mockResolvedValue({ command: 'ssh', args: ['h', 'git'] });
		// The worktree path does not exist yet and its parent has no physical alias.
		mockFs.access.mockRejectedValue(new Error('ENOENT'));
		mockFs.realpath.mockRejectedValue(new Error('ENOENT'));
		answer({});
	});

	afterEach(() => {
		setGitExecutionGate(null);
	});

	const run = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);

	describe('git:worktreeSetup', () => {
		it('standalone: spawns the same worktree add as before, with no extra git call', async () => {
			answer({ 'git worktree add -b feature /wt': 'Preparing worktree' });
			const result = await run('git:worktreeSetup', '/main/repo', '/wt', 'feature');
			expect(result).toEqual({
				success: true,
				created: true,
				currentBranch: 'feature',
				requestedBranch: 'feature',
				branchMismatch: false,
			});
			expect(ran()).toEqual(['git rev-parse --verify feature', 'git worktree add -b feature /wt']);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['worktree', 'add', '-b', 'feature', '/wt'],
				'/main/repo'
			);
			expect(isWorktreeCreatedByMaestro('/wt')).toBe(true);
		});

		it('managed with no ceiling: refuses the add with no process, releases the mark and names the reason', async () => {
			manage();
			const result = await run('git:worktreeSetup', '/main/repo', '/wt', 'feature');
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/^\[managed-unavailable\] the managed repository ceiling/);
			expect(ran()).toEqual(['git rev-parse --verify feature']);
			expect(isWorktreeCreatedByMaestro('/wt')).toBe(false);
		});

		it('managed: admits the add on an admitted repository after reading its origin, then spawns it', async () => {
			manage(ceiling);
			answer({
				'git remote get-url origin': ORIGIN,
				'git worktree add -b feature /wt main': 'Preparing worktree',
			});
			const result = await run(
				'git:worktreeSetup',
				'/main/repo',
				'/wt',
				'feature',
				undefined,
				'main'
			);
			expect(result).toMatchObject({ success: true, created: true });
			expect(ran()).toEqual([
				'git rev-parse --verify feature',
				'git remote get-url origin',
				'git worktree add -b feature /wt main',
			]);
			expect(isWorktreeCreatedByMaestro('/wt')).toBe(true);
		});

		it('managed: refuses the add on a repository the ceiling does not admit, with no process', async () => {
			manage(ceiling);
			answer({ 'git remote get-url origin': 'https://github.com/other/thing.git' });
			const result = await run('git:worktreeSetup', '/main/repo', '/wt', 'feature');
			expect(result.success).toBe(false);
			expect(result.error).toMatch(/^\[managed-repository-denied\]/);
			expect(ran()).not.toContainEqual(expect.stringContaining('worktree add'));
			expect(isWorktreeCreatedByMaestro('/wt')).toBe(false);
		});
	});

	describe('git:worktreeRunSetup', () => {
		it('standalone: runs the script in the worktree shell with no hold and no git call', async () => {
			answer({ [`${shell} -c ./setup.sh`]: 'installed' });
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT);
			expect(result).toMatchObject({ success: true, ran: true, exitCode: 0, stdout: 'installed' });
			expect(result.skipped).toBeUndefined();
			expect(ran()).toEqual([`${shell} -c ./setup.sh`]);
			const [, , cwd] = vi.mocked(execFile.execFileNoThrow).mock.calls[0];
			expect(cwd).toBe('/wt');
		});

		it('managed with no ceiling: skips the script with the reason and runs nothing at all', async () => {
			manage();
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT);
			expect(result).toMatchObject({
				success: false,
				ran: false,
				skipped: true,
				exitCode: 'EMANAGED',
				stdout: '',
				stderr: '',
			});
			expect(result.error).toMatch(/^\[managed-unavailable\]/);
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('managed: a ceiling with no setup-script effect skips the script after naming the repository', async () => {
			manage(noScripts);
			answer({ 'git remote get-url origin': ORIGIN });
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT);
			expect(result).toMatchObject({ success: false, ran: false, skipped: true });
			expect(result.error).toMatch(
				/^\[managed-outside-ceiling\] the repository ceiling admits no setup-script effect for the operator/
			);
			// The origin was read in the worktree, unheld; no shell started.
			expect(ran()).toEqual(['git remote get-url origin']);
			const [, , cwd] = vi.mocked(execFile.execFileNoThrow).mock.calls[0];
			expect(cwd).toBe('/wt');
		});

		it('managed: a ceiling admitting setup scripts on the repository runs the script', async () => {
			manage(ceiling);
			answer({
				'git remote get-url origin': ORIGIN,
				[`${shell} -c ./setup.sh`]: 'installed',
			});
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT);
			expect(result).toMatchObject({ success: true, ran: true, exitCode: 0 });
			expect(ran()).toEqual(['git remote get-url origin', `${shell} -c ./setup.sh`]);
		});

		it('managed: a repository outside the ceiling skips the script by name', async () => {
			manage(ceiling);
			answer({ 'git remote get-url origin': 'https://github.com/other/thing.git' });
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT);
			expect(result).toMatchObject({ success: false, ran: false, skipped: true });
			expect(result.error).toMatch(/^\[managed-repository-denied\]/);
			expect(ran()).toEqual(['git remote get-url origin']);
		});

		it('managed over SSH: an unqualified remote skips the script with nothing run on either machine', async () => {
			manage(ceiling);
			mockGetSshRemoteById.mockReturnValue(sshRemote);
			const result = await run('git:worktreeRunSetup', './setup.sh', SCRIPT_CONTEXT, 'r1');
			expect(result).toMatchObject({ success: false, ran: false, skipped: true });
			expect(result.error).toMatch(
				/^\[managed-remote-unqualified\] under management the SSH remote "Box" is not a qualified managed endpoint for a worktree setup script/
			);
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('a blank script is still a no-op before any hold', async () => {
			manage();
			const result = await run('git:worktreeRunSetup', '   ', SCRIPT_CONTEXT);
			expect(result).toEqual({ success: true, ran: false, stdout: '', stderr: '' });
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});
	});
});

describe('web git callbacks carry the host-resolved caller to the executor (MRC2-04-03)', () => {
	type Callback = (sessionId: string) => Promise<unknown>;
	let branches: Callback;
	let worktrees: Callback;

	beforeEach(() => {
		vi.clearAllMocks();
		setGitExecutionGate(null);
		const server = {
			setGetGitStatusCallback: vi.fn(),
			setGetGitDiffCallback: vi.fn(),
			setGetGitBranchesForSessionCallback: vi.fn(),
			setListWorktreesForSessionCallback: vi.fn(),
		};
		registerGitCallbacks(server as never, {
			getMainWindow: () => null,
			sessionsStore: { get: vi.fn(() => [{ id: 's1', cwd: '/repo' }]) } as never,
		});
		branches = server.setGetGitBranchesForSessionCallback.mock.calls[0][0];
		worktrees = server.setListWorktreesForSessionCallback.mock.calls[0][0];
		answer({
			'git branch -a --format=%(refname:short)': 'main\nfeature',
			'git rev-parse --abbrev-ref HEAD': 'main',
			'git worktree list --porcelain': 'worktree /repo\nbranch refs/heads/main\n',
		});
	});

	afterEach(() => {
		setGitExecutionGate(null);
	});

	/** A gate double that records the actor the executor would bind for each command. */
	function recordingGate(): ProcessSpawnActor[] {
		const seen: ProcessSpawnActor[] = [];
		setGitExecutionGate({
			hold: async () => {
				seen.push(transportSpawnActor(getActingTransport()));
				return { allowed: true, operation: null };
			},
			holdForge: async () => ({ allowed: true, operation: null }),
			holdScript: async () => ({ allowed: true, operation: null }),
		});
		return seen;
	}

	it('binds the Web Login account the socket was admitted as, never the desktop', async () => {
		const seen = recordingGate();
		const client = { user: { id: 'u1', username: 'ada', displayName: 'Ada' } };
		const result = await runAsClient(client, () => branches('s1'));
		expect(result).toEqual({ branches: ['main', 'feature'], currentBranch: 'main' });
		expect(seen).toEqual([
			{ peer: 'web-login', username: 'ada' },
			{ peer: 'web-login', username: 'ada' },
		]);
	});

	it('binds the CLI secret and a paired device as themselves', async () => {
		const seen = recordingGate();
		await runAsClient({ cli: true }, () => worktrees('s1'));
		await runAsClient(
			{
				admission: 'device-pairing',
				user: { id: 'paired-device:d9', username: 'paired-device', displayName: 'Phone' },
			},
			() => worktrees('s1')
		);
		expect(seen).toEqual([{ peer: 'host-secret' }, { peer: 'device-pairing', deviceId: 'd9' }]);
	});

	it('outside any transport context the executor sees the operator', async () => {
		const seen = recordingGate();
		await branches('s1');
		expect(seen).toEqual([{ peer: 'in-process' }, { peer: 'in-process' }]);
	});

	it('managed with no ceiling: the callbacks only read, so they still answer', async () => {
		const repository = createRepositoryPolicySource({
			identity: { read: () => enrolled },
			policy: () => ({ appliedRevision: 3 }),
		});
		setGitExecutionGate(createGitExecutionGate({ repository }));
		const client = { user: { id: 'u1', username: 'ada', displayName: 'Ada' } };
		const result = await runAsClient(client, () => worktrees('s1'));
		expect(result).toEqual({ worktrees: [{ path: '/repo', branch: 'main', isBare: false }] });
		expect(ran()).toEqual(['git worktree list --porcelain']);
	});
});
