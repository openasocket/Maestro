/**
 * The git IPC writes and the arbitrary command runner under management
 * (MRC2-04-02). `git:runCommand` runs only its three enumerated command lines
 * and holds the exact argv it spawns to the repository ceiling before any
 * process or branch-switch lock exists; `git:createPR` holds the pull request
 * before the push and runs the push through the shared executor;
 * `git:createGist` holds the gist before gh starts; `git:commitAll` and
 * `git:checkoutBranch` reach the ceiling through the executor they already
 * use. Standalone, every handler spawns what it spawned before.
 *
 * The real executor (`remote-git.ts`) and the real gate and policy source
 * (`repository-policy.ts`) run here over a mocked process layer, so a refusal
 * is proven by the absence of a spawn, never by a mocked verdict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';

import * as execFile from '../../../../../main/utils/execFile';
import { setGitExecutionGate } from '../../../../../main/utils/remote-git';
import {
	createGitExecutionGate,
	createRepositoryPolicySource,
} from '../../../../../main/enterprise/repository-policy';
import type { IdentityRead } from '../../../../../main/enterprise/identity-store';
import { registerStreamingHandlers } from '../../../../../main/ipc/handlers/git/streaming';
import { registerGithubHandlers } from '../../../../../main/ipc/handlers/git/github';
import { registerBranchHandlers } from '../../../../../main/ipc/handlers/git/branch';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
	BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock('../../../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
	execFileBufferNoThrow: vi.fn(),
	execFileStreaming: vi.fn(),
}));

const { mockBuildSshCommand, mockBeginRemoteSync, mockBranchSwitchBlocker, mockGetSshRemoteById } =
	vi.hoisted(() => ({
		mockBuildSshCommand: vi.fn(),
		mockBeginRemoteSync: vi.fn(),
		mockBranchSwitchBlocker: vi.fn(),
		mockGetSshRemoteById: vi.fn(),
	}));

vi.mock('../../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: mockBuildSshCommand,
}));

vi.mock('../../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../../main/utils/sentry', () => ({
	captureMessage: vi.fn(),
	captureException: vi.fn(),
}));

vi.mock('../../../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async () => 'gh'),
	getCachedGhStatus: vi.fn(() => null),
	setCachedGhStatus: vi.fn(),
	getExpandedEnv: vi.fn(() => ({ PATH: '/expanded' })),
}));

vi.mock('../../../../../shared/maestro-lib/launch/getShellPath', () => ({
	getShellPath: vi.fn(async () => '/shell/bin'),
	default: vi.fn(async () => '/shell/bin'),
}));

vi.mock('../../../../../main/utils/branch-switch-guard', () => ({
	beginRemoteSync: mockBeginRemoteSync,
	branchSwitchBlocker: mockBranchSwitchBlocker,
}));

vi.mock('../../../../../main/stores', () => ({
	getSshRemoteById: mockGetSshRemoteById,
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

/** A ceiling that admits the operator's git writes and pull requests on acme repositories at github.com; no gist. */
const ceiling = {
	policyRevision: 3,
	actors: [{ actor: 'operator', effects: ['push', 'commit', 'branch', 'clone', 'pull-request'] }],
	repositories: { allow: ['acme/*'] },
	remotes: { allow: ['github.com'] },
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

/** Answer each `git <args>` / `gh <args>` the handlers and the gate run; an unlisted one fails. */
function answer(answers: Record<string, string>): void {
	vi.mocked(execFile.execFileNoThrow).mockImplementation(async (command, args) => {
		const key = `${command} ${(args as string[]).join(' ')}`;
		if (key in answers) return { stdout: answers[key], stderr: '', exitCode: 0 };
		return { stdout: '', stderr: `no answer for ${key}`, exitCode: 1 };
	});
}

/** Every `git`/`gh` command line run so far, as text. */
function ran(): string[] {
	return vi
		.mocked(execFile.execFileNoThrow)
		.mock.calls.map(([command, args]) => `${command} ${(args as string[]).join(' ')}`);
}

function streamingResult(exitCode: number | string = 0): void {
	vi.mocked(execFile.execFileStreaming).mockImplementation(() => ({
		result: Promise.resolve({ stdout: '', stderr: '', exitCode }),
		cancel: vi.fn(),
	}));
}

function event() {
	return { sender: { isDestroyed: () => false, send: vi.fn() } } as never;
}

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

describe('git IPC writes under the repository ceiling (MRC2-04-02)', () => {
	let handlers: Map<string, Handler>;

	beforeEach(() => {
		vi.clearAllMocks();
		setGitExecutionGate(null);
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as Handler);
		});
		registerStreamingHandlers();
		registerGithubHandlers();
		registerBranchHandlers({ settingsStore: { get: vi.fn() }, getMainWindow: () => null });
		mockBeginRemoteSync.mockResolvedValue(() => {});
		mockBranchSwitchBlocker.mockResolvedValue(null);
		mockGetSshRemoteById.mockReturnValue(undefined);
		mockBuildSshCommand.mockResolvedValue({ command: 'ssh', args: ['h', 'git push'] });
		answer({});
		streamingResult(0);
	});

	const run = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event(), ...args);

	describe('git:runCommand', () => {
		it('refuses an operation off the enumerated list before anything starts, standalone too', async () => {
			const result = await run('git:runCommand', {
				runId: 'r',
				operation: 'status --porcelain; rm -rf /',
				cwd: '/repo',
			});
			expect(result).toMatchObject({ success: false, exitCode: 1, cancelled: false });
			expect(result.error).toMatch(/runs only pull, push, fetch; ".*" was not run/);
			expect(execFile.execFileStreaming).not.toHaveBeenCalled();
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(mockBeginRemoteSync).not.toHaveBeenCalled();
		});

		it('standalone: spawns the same command line as before, with no hold and no extra git call', async () => {
			const result = await run('git:runCommand', { runId: 'r', operation: 'push', cwd: '/repo' });
			expect(result).toMatchObject({ success: true, exitCode: 0 });
			expect(execFile.execFileStreaming).toHaveBeenCalledWith(
				'git',
				['-c', 'color.ui=always', 'push', '--progress'],
				expect.objectContaining({ cwd: '/repo' })
			);
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('managed, no ceiling: a push is refused unavailable with no process, no lock and the reason in the console', async () => {
			manage();
			const ev = event();
			const result = await handlers.get('git:runCommand')!(ev, {
				runId: 'r',
				operation: 'push',
				cwd: '/repo',
			});
			expect(result).toEqual({
				success: false,
				exitCode: 'EMANAGED',
				cancelled: false,
				error: expect.stringMatching(/^\[managed-unavailable\] /),
			});
			expect(execFile.execFileStreaming).not.toHaveBeenCalled();
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(mockBeginRemoteSync).not.toHaveBeenCalled();
			expect((ev as any).sender.send).toHaveBeenCalledWith('git:commandOutput', {
				runId: 'r',
				stream: 'stderr',
				chunk: expect.stringMatching(/^\[managed-unavailable\] .*\n$/),
			});
		});

		it('managed, ceiling: a push to an admitted origin runs after the gate names the remote through reads', async () => {
			manage(ceiling);
			answer({
				'git rev-parse --abbrev-ref HEAD': 'main\n',
				'git config --get branch.main.remote': 'origin\n',
				'git remote get-url origin': 'https://github.com/acme/widgets.git\n',
			});
			const result = await run('git:runCommand', { runId: 'r', operation: 'push', cwd: '/repo' });
			expect(result).toMatchObject({ success: true, exitCode: 0 });
			expect(execFile.execFileStreaming).toHaveBeenCalledTimes(1);
			expect(mockBeginRemoteSync).toHaveBeenCalledWith('push', '/repo', undefined, undefined);
			// Reads only: the gate asked git where the push goes, and held nothing else.
			expect(ran()).toEqual([
				'git config --get remote.pushDefault',
				'git rev-parse --abbrev-ref HEAD',
				'git config --get branch.main.pushRemote',
				'git config --get branch.main.remote',
				'git remote get-url origin',
			]);
		});

		it('managed, ceiling: a pull from a denied origin is refused remote-denied and never spawns', async () => {
			manage(ceiling);
			answer({
				'git rev-parse --abbrev-ref HEAD': 'main\n',
				'git config --get branch.main.remote': 'origin\n',
				'git remote get-url origin': 'git@gitlab.com:acme/widgets.git\n',
			});
			const result = await run('git:runCommand', { runId: 'r', operation: 'pull', cwd: '/repo' });
			expect(result).toMatchObject({
				success: false,
				exitCode: 'EMANAGED',
				error: expect.stringMatching(/^\[managed-remote-denied\] .*gitlab\.com/),
			});
			expect(execFile.execFileStreaming).not.toHaveBeenCalled();
			expect(mockBeginRemoteSync).not.toHaveBeenCalled();
		});

		it('managed: a write over an SSH remote no qualifier binds is refused by name with nothing run on either machine', async () => {
			manage(ceiling);
			mockGetSshRemoteById.mockReturnValue(sshRemote);
			const result = await run('git:runCommand', {
				runId: 'r',
				operation: 'fetch',
				cwd: '/repo',
				sshRemoteId: 'r1',
				remoteCwd: '/remote/repo',
			});
			expect(result).toMatchObject({
				success: false,
				exitCode: 'EMANAGED',
				error: expect.stringMatching(/^\[managed-remote-unqualified\] .*"Box"/),
			});
			expect(execFile.execFileStreaming).not.toHaveBeenCalled();
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
			expect(mockBuildSshCommand).not.toHaveBeenCalled();
		});
	});

	describe('git:createPR', () => {
		const create = () => run('git:createPR', '/wt', 'main', 'Title', 'Body');
		const prCreate = 'gh pr create --base main --title Title --body Body';

		it('standalone: pushes through the shared executor with the shell PATH, then opens the PR', async () => {
			answer({
				'git push -u origin HEAD': '',
				[prCreate]: 'https://github.com/acme/widgets/pull/1\n',
			});
			await expect(create()).resolves.toEqual({
				success: true,
				prUrl: 'https://github.com/acme/widgets/pull/1',
			});
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'git',
				['push', '-u', 'origin', 'HEAD'],
				'/wt',
				{ env: expect.objectContaining({ PATH: '/shell/bin' }) }
			);
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['pr', 'create', '--base', 'main', '--title', 'Title', '--body', 'Body'],
				'/wt',
				expect.objectContaining({ PATH: '/shell/bin' })
			);
		});

		it('managed, no ceiling: the pull request is refused before the push, and nothing runs', async () => {
			manage();
			await expect(create()).resolves.toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-unavailable\] /),
			});
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('managed, ceiling: an admitted repository is pushed and opened', async () => {
			manage(ceiling);
			answer({
				'git remote get-url origin': 'https://github.com/acme/widgets.git\n',
				'git push -u origin HEAD': '',
				[prCreate]: 'https://github.com/acme/widgets/pull/2\n',
			});
			await expect(create()).resolves.toEqual({
				success: true,
				prUrl: 'https://github.com/acme/widgets/pull/2',
			});
			expect(ran().filter((line) => line.startsWith('git push'))).toHaveLength(1);
		});

		it('managed, ceiling: a repository outside the ceiling is refused with no push and no gh', async () => {
			manage(ceiling);
			answer({ 'git remote get-url origin': 'https://github.com/other/thing.git\n' });
			await expect(create()).resolves.toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-repository-denied\] .*other\/thing/),
			});
			expect(ran()).toEqual(['git remote get-url origin']);
		});
	});

	describe('git:createGist', () => {
		const create = () => run('git:createGist', 'log.txt', 'body', 'desc', false);

		it('standalone: publishes exactly as before', async () => {
			answer({
				'gh gist create --filename log.txt --desc desc -': 'https://gist.github.com/u/abc\n',
			});
			await expect(create()).resolves.toEqual({
				success: true,
				gistUrl: 'https://gist.github.com/u/abc',
			});
			expect(execFile.execFileNoThrow).toHaveBeenCalledWith(
				'gh',
				['gist', 'create', '--filename', 'log.txt', '--desc', 'desc', '-'],
				undefined,
				{ input: 'body', env: { PATH: '/expanded' } }
			);
		});

		it('managed, ceiling without the gist effect: refused outside-ceiling before gh starts', async () => {
			manage(ceiling);
			await expect(create()).resolves.toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-outside-ceiling\] /),
			});
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('managed, ceiling listing gist and admitting gist.github.com: publishes; a repositories clause refuses it by name', async () => {
			answer({
				'gh gist create --filename log.txt --desc desc -': 'https://gist.github.com/u/def\n',
			});
			manage({
				policyRevision: 3,
				actors: [{ actor: 'operator', effects: ['gist'] }],
				remotes: { allow: ['https://gist.github.com'] },
			});
			await expect(create()).resolves.toMatchObject({ success: true });
			expect(execFile.execFileNoThrow).toHaveBeenCalledTimes(1);

			vi.mocked(execFile.execFileNoThrow).mockClear();
			manage({
				policyRevision: 3,
				actors: [{ actor: 'operator', effects: ['gist'] }],
				repositories: { allow: ['acme/*'] },
			});
			await expect(create()).resolves.toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-repository-unknown\] /),
			});
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});
	});

	describe('git:commitAll and git:checkoutBranch (held by the executor they already use)', () => {
		it('standalone: commitAll stages, checks, commits and reads the hash as before', async () => {
			answer({
				'git add -A': '',
				'git status --porcelain': ' M a.txt\n',
				'git commit -m msg': '',
				'git rev-parse --short HEAD': 'abc123\n',
			});
			await expect(run('git:commitAll', '/repo', 'msg')).resolves.toEqual({
				success: true,
				committed: true,
				commitHash: 'abc123',
			});
		});

		it('managed, no ceiling: commitAll stages nothing and names the refusal', async () => {
			manage();
			await expect(run('git:commitAll', '/repo', 'msg')).resolves.toEqual({
				success: false,
				committed: false,
				error: expect.stringMatching(/^\[managed-unavailable\] /),
			});
			expect(execFile.execFileNoThrow).not.toHaveBeenCalled();
		});

		it('managed, ceiling: a checkout outside the admitted repositories is refused with no checkout', async () => {
			manage(ceiling);
			answer({ 'git remote get-url origin': 'https://github.com/other/thing.git\n' });
			await expect(run('git:checkoutBranch', '/repo', 'feature')).resolves.toEqual({
				success: false,
				error: expect.stringMatching(/^\[managed-repository-denied\] /),
			});
			expect(ran()).toEqual(['git remote get-url origin']);
		});

		it('managed, ceiling: a checkout in an admitted repository runs', async () => {
			manage(ceiling);
			answer({
				'git remote get-url origin': 'https://github.com/acme/widgets.git\n',
				'git checkout feature': '',
			});
			await expect(run('git:checkoutBranch', '/repo', 'feature')).resolves.toMatchObject({
				success: true,
			});
			expect(ran()).toEqual(['git remote get-url origin', 'git checkout feature']);
		});

		it('managed, no ceiling: a branch listing is a read and is unaffected', async () => {
			manage();
			answer({ 'git branch -a --format=%(refname:short)': 'main\nfeature\n' });
			await expect(run('git:branches', '/repo')).resolves.toEqual({
				branches: ['main', 'feature'],
			});
		});
	});
});
