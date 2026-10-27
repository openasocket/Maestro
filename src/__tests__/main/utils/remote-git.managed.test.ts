/**
 * The shared git executor under the managed repository ceiling (MRC2-04-01,
 * 04-01A, 04-03), proven at the executor itself: `execGit`, `execGitRemote`,
 * `execGitReadOnly`, `holdGitCommand`, `holdGitForgeEffect` and
 * `holdWorktreeSetupScript` in `remote-git.ts`, over the real gate and the
 * real policy source (`createGitExecutionGate`, `createRepositoryPolicySource`
 * in `repository-policy.ts`) and a mocked process layer. A refusal is proven
 * by the absence of a spawn, never by a mocked verdict; standalone (no gate
 * installed) runs every command exactly as before with no extra call.
 *
 * The first two groups pin the classifier and the gate on their own (what a
 * command line IS, and what the gate answers for it); the third runs the
 * executor end to end.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as execFile from '../../../main/utils/execFile';
import { buildSshCommand } from '../../../main/utils/ssh-command-builder';
import {
	GIT_REFUSED_EXIT_CODE,
	execGit,
	execGitReadOnly,
	execGitRemote,
	holdGitCommand,
	holdGitForgeEffect,
	holdWorktreeSetupScript,
	isGitRefusal,
	setGitExecutionGate,
} from '../../../main/utils/remote-git';
import {
	classifyGitOperation,
	createGitExecutionGate,
	createRepositoryPolicySource,
	type GitExecutionGateDeps,
	type GitExecutionRequest,
	type GitExecutionTarget,
} from '../../../main/enterprise/repository-policy';
import type { IdentityRead } from '../../../main/enterprise/identity-store';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('../../../main/utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

vi.mock('../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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

const unenrolled: IdentityRead = { status: 'none' } as never;

/** A ceiling that admits the operator's git writes, pull requests and setup scripts on acme repositories at github.com; no gist, no issue. */
const ceiling = {
	policyRevision: 3,
	actors: [
		{
			actor: 'operator',
			effects: ['push', 'commit', 'branch', 'clone', 'pull-request', 'setup-script'],
		},
	],
	repositories: { allow: ['acme/*'] },
	remotes: { allow: ['github.com'] },
};

/** The real policy source: enrolled (or not), with or without a ceiling installed. */
function source(read: IdentityRead = enrolled, document: Record<string, unknown> | null = null) {
	const src = createRepositoryPolicySource({
		identity: { read: () => read },
		policy: () => ({ appliedRevision: 3 }),
	});
	if (document) {
		const out = src.install(document);
		if (!out.installed) throw new Error(out.problems.join('; '));
	}
	return src;
}

const sshRemote: SshRemoteConfig = {
	id: 'r1',
	name: 'Box',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '/k',
	enabled: true,
};

const sshTarget: GitExecutionTarget = { kind: 'ssh', remote: sshRemote, cwd: '/remote' };

/** A qualifier that binds every remote to an enrolled endpoint (what MRC-08-04 answers for a managed remote). */
const qualified: NonNullable<GitExecutionGateDeps['qualifyRemote']> = async (remote) => ({
	kind: 'remote',
	remote,
	endpoint: { installationId: 'remote-inst' } as never,
});

/** A gate request with a recording reader that answers the listed `git <args>` and null for the rest. */
function request(
	args: string[],
	answers: Record<string, string | null> = {},
	target: GitExecutionTarget = { kind: 'local', cwd: '/repo' }
) {
	const read = vi.fn(async (a: string[]) => answers[a.join(' ')] ?? null);
	const req: GitExecutionRequest = { args, target, read };
	return { request: req, read };
}

describe('classifyGitOperation', () => {
	const cases: Array<[string[], unknown]> = [
		[['status', '--porcelain'], { class: 'read', subcommand: 'status' }],
		[
			['-C', '/x', '--no-optional-locks', 'rev-parse', 'HEAD'],
			{ class: 'read', subcommand: 'rev-parse' },
		],
		[['-c', 'core.quotepath=off', 'diff', '--numstat'], { class: 'read' }],
		[['branch', '-a', '--format=%(refname:short)'], { class: 'read' }],
		[['branch', '--show-current'], { class: 'read' }],
		[['branch', '--list', 'feat*'], { class: 'read' }],
		[['branch', 'feature'], { class: 'local-write', effect: 'branch' }],
		[['branch', '-d', 'feature'], { class: 'local-write', effect: 'branch' }],
		[['branch', '-u', 'origin/main'], { class: 'local-write' }],
		[['tag', '--list'], { class: 'read' }],
		[['tag', '-n3'], { class: 'read' }],
		[['tag', 'v1'], { class: 'local-write', effect: 'branch' }],
		[['tag', '-a', 'v1', '-m', 'msg'], { class: 'local-write' }],
		[['remote', 'get-url', 'origin'], { class: 'read' }],
		[['remote', '-v'], { class: 'read' }],
		[['remote', 'add', 'x', 'url'], { class: 'local-write', effect: 'commit' }],
		[['remote', 'update', 'origin'], { class: 'remote-write', effect: 'clone', remote: 'origin' }],
		[['worktree', 'list', '--porcelain'], { class: 'read' }],
		[['worktree', 'add', '/p', 'b'], { class: 'local-write', effect: 'branch' }],
		[['stash', 'list'], { class: 'read' }],
		[['stash', 'push', '-m', 'x'], { class: 'local-write', effect: 'commit' }],
		[['config', '--get', 'user.name'], { class: 'read' }],
		[['config', 'user.name'], { class: 'read' }],
		[['config', 'user.name', 'x'], { class: 'local-write' }],
		[['config', '--global', '--list'], { class: 'read' }],
		[['config', '--unset', 'a.b'], { class: 'local-write' }],
		[['push'], { class: 'remote-write', effect: 'push', remote: null }],
		[['push', '-u', 'origin', 'main'], { class: 'remote-write', effect: 'push', remote: 'origin' }],
		[['push', '-o', 'ci.skip', 'upstream', 'main'], { remote: 'upstream' }],
		[['push', '--repo=fork', 'main'], { remote: 'fork' }],
		[['push', '--force-with-lease', 'origin', 'HEAD'], { remote: 'origin' }],
		[['push', 'https://github.com/a/b.git', 'main'], { remote: 'https://github.com/a/b.git' }],
		[['fetch', '--all'], { class: 'remote-write', effect: 'clone', remote: null }],
		[['fetch', '--depth', '1', 'origin'], { remote: 'origin' }],
		[['pull', '--rebase', 'origin', 'main'], { effect: 'clone', remote: 'origin' }],
		[
			['clone', '--depth', '1', 'git@github.com:a/b.git', '/dst'],
			{ effect: 'clone', remote: 'git@github.com:a/b.git' },
		],
		[['commit', '-m', 'x'], { class: 'local-write', effect: 'commit' }],
		[['add', '-A'], { class: 'local-write', effect: 'commit' }],
		[['init'], { class: 'local-write' }],
		[['checkout', '-b', 'x'], { class: 'local-write', effect: 'branch' }],
		[['switch', 'x'], { class: 'local-write', effect: 'branch' }],
		[['symbolic-ref', 'HEAD'], { class: 'read' }],
		[['symbolic-ref', 'HEAD', 'refs/heads/x'], { class: 'local-write' }],
		[['reflog'], { class: 'read' }],
		[['reflog', 'expire', '--all'], { class: 'local-write' }],
		[['ls-remote', '--heads', 'origin'], { class: 'read' }],
		[['--version'], { class: 'read', subcommand: 'version' }],
		[['log', '--', 'push'], { class: 'read' }],
	];
	for (const [args, expected] of cases) {
		it(`git ${args.join(' ')}`, () => {
			expect(classifyGitOperation(args)).toMatchObject(expected as object);
		});
	}

	it('names nothing for an unknown subcommand or none', () => {
		expect(classifyGitOperation(['credential', 'fill'])).toBeNull();
		expect(classifyGitOperation(['difftool'])).toBeNull();
		expect(classifyGitOperation([])).toBeNull();
		expect(classifyGitOperation(['-C', '/x'])).toBeNull();
	});
});

describe('createGitExecutionGate', () => {
	describe('hold (a git command line)', () => {
		it('standalone: allowed with no classification and no read', async () => {
			const gate = createGitExecutionGate({ repository: source(unenrolled) });
			const { request: req, read } = request(['push', 'origin', 'main']);
			expect(await gate.hold(req)).toEqual({ allowed: true, operation: null });
			expect(read).not.toHaveBeenCalled();
		});

		it('managed: a read is allowed unheld, with no git call', async () => {
			const gate = createGitExecutionGate({ repository: source() });
			const { request: req, read } = request(['status', '--porcelain']);
			expect(await gate.hold(req)).toMatchObject({
				allowed: true,
				operation: { class: 'read' },
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, no ceiling: a write is refused unavailable with no read', async () => {
			const gate = createGitExecutionGate({ repository: source() });
			const { request: req, read } = request(['push', 'origin', 'main']);
			const decision = await gate.hold(req);
			expect(decision).toMatchObject({ allowed: false, code: 'unavailable' });
			expect(read).not.toHaveBeenCalled();
		});

		it('managed: an unknown operation is refused by name, naming the subcommand', async () => {
			const gate = createGitExecutionGate({ repository: source() });
			const { request: req, read } = request(['credential', 'fill']);
			const decision = await gate.hold(req);
			expect(decision).toMatchObject({ allowed: false, code: 'operation-unknown' });
			if (!decision.allowed) expect(decision.message).toContain('"git credential"');
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, ceiling: a push to an admitted remote is held within, after one read of the remote url', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['push', 'origin', 'main'], {
				'remote get-url origin': 'https://github.com/acme/widgets.git',
			});
			expect(await gate.hold(req)).toMatchObject({
				allowed: true,
				managed: {
					outcome: 'within-ceiling',
					effect: 'push',
					repository: 'acme/widgets',
					remote: 'https://github.com',
					surface: 'git',
				},
			});
			expect(read).toHaveBeenCalledTimes(1);
		});

		it('managed, ceiling: a push naming a url holds that url with no read', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['push', 'https://github.com/acme/w.git', 'main']);
			expect(await gate.hold(req)).toMatchObject({
				allowed: true,
				managed: { outcome: 'within-ceiling', repository: 'acme/w' },
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, ceiling: a push with no remote named resolves the remote git itself would use', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['push'], {
				'rev-parse --abbrev-ref HEAD': 'main',
				'config --get branch.main.remote': 'upstream',
				'remote get-url upstream': 'git@gitlab.com:acme/widgets.git',
			});
			expect(await gate.hold(req)).toMatchObject({ allowed: false, code: 'remote-denied' });
			expect(read.mock.calls.map((c) => c[0].join(' '))).toEqual([
				'config --get remote.pushDefault',
				'rev-parse --abbrev-ref HEAD',
				'config --get branch.main.pushRemote',
				'config --get branch.main.remote',
				'remote get-url upstream',
			]);
		});

		it('managed, ceiling: remote.pushDefault wins over the branch remote for a push', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['push'], {
				'config --get remote.pushDefault': 'fork',
				'remote get-url fork': 'https://github.com/acme/widgets.git',
			});
			expect(await gate.hold(req)).toMatchObject({ allowed: true, managed: { effect: 'push' } });
			expect(read).toHaveBeenCalledTimes(2);
		});

		it('managed, ceiling: a fetch with no remote named falls back to origin', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['fetch'], {
				'rev-parse --abbrev-ref HEAD': 'HEAD',
				'remote get-url origin': 'https://github.com/acme/widgets.git',
			});
			expect(await gate.hold(req)).toMatchObject({ allowed: true, managed: { effect: 'clone' } });
			expect(read.mock.calls.map((c) => c[0].join(' '))).toEqual([
				'rev-parse --abbrev-ref HEAD',
				'remote get-url origin',
			]);
		});

		it('managed, ceiling: a local write is held against the origin repository', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const denied = request(['commit', '-m', 'x'], {
				'remote get-url origin': 'https://github.com/other/thing.git',
			});
			expect(await gate.hold(denied.request)).toMatchObject({
				allowed: false,
				code: 'repository-denied',
			});
			const ok = request(['commit', '-m', 'x'], {
				'remote get-url origin': 'https://github.com/acme/thing.git',
			});
			expect(await gate.hold(ok.request)).toMatchObject({
				allowed: true,
				managed: { effect: 'commit', remote: null, repository: 'acme/thing' },
			});
		});

		it('managed, ceiling: a local write in a repository with no origin is refused repository-unknown', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req } = request(['commit', '-m', 'x']);
			expect(await gate.hold(req)).toMatchObject({ allowed: false, code: 'repository-unknown' });
		});

		it('managed, ceiling: an effect the actor is not granted is refused outside-ceiling', async () => {
			const gate = createGitExecutionGate({
				repository: source(enrolled, {
					...ceiling,
					actors: [{ actor: 'operator', effects: ['commit'] }],
				}),
			});
			const { request: req } = request(['push', 'origin', 'main'], {
				'remote get-url origin': 'https://github.com/acme/widgets.git',
			});
			expect(await gate.hold(req)).toMatchObject({ allowed: false, code: 'outside-ceiling' });
		});

		it('managed: a write over SSH with no qualifier is refused remote-unqualified, with no read', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { request: req, read } = request(['worktree', 'add', '/p', 'b'], {}, sshTarget);
			const decision = await gate.hold(req);
			expect(decision).toMatchObject({
				allowed: false,
				code: 'remote-unqualified',
				operation: { subcommand: 'worktree' },
			});
			expect(read).not.toHaveBeenCalled();
			if (!decision.allowed) {
				expect(decision.message).toMatch(/"Box"/);
				expect(decision.message).toMatch(/a git worktree/);
				expect(decision.message).toMatch(/nothing ran on this machine/);
			}
		});

		it('managed: a write over SSH the qualifier leaves unresolved is refused with its message', async () => {
			const gate = createGitExecutionGate({
				repository: source(enrolled, ceiling),
				qualifyRemote: async () => ({
					kind: 'unresolved',
					reason: 'remote-unqualified',
					message: 'the endpoint attests another tenant.',
				}),
			});
			const { request: req, read } = request(['commit', '-m', 'x'], {}, sshTarget);
			const decision = await gate.hold(req);
			expect(decision).toMatchObject({ allowed: false, code: 'remote-unqualified' });
			if (!decision.allowed) expect(decision.message).toContain('attests another tenant');
			expect(read).not.toHaveBeenCalled();
		});

		it('managed: a write over SSH with a qualified remote is then held like a local one', async () => {
			const gate = createGitExecutionGate({
				repository: source(enrolled, ceiling),
				qualifyRemote: qualified,
			});
			const { request: req, read } = request(
				['commit', '-m', 'x'],
				{ 'remote get-url origin': 'https://github.com/acme/t.git' },
				sshTarget
			);
			expect(await gate.hold(req)).toMatchObject({
				allowed: true,
				managed: { outcome: 'within-ceiling', repository: 'acme/t' },
			});
			expect(read).toHaveBeenCalledTimes(1);
		});

		it('managed: a read over SSH is never qualified and never held', async () => {
			const qualify = vi.fn(qualified);
			const gate = createGitExecutionGate({
				repository: source(enrolled, ceiling),
				qualifyRemote: qualify,
			});
			const { request: req, read } = request(['status', '--porcelain'], {}, sshTarget);
			expect(await gate.hold(req)).toMatchObject({ allowed: true, operation: { class: 'read' } });
			expect(qualify).not.toHaveBeenCalled();
			expect(read).not.toHaveBeenCalled();
		});

		it('managed: the injected actor is the one the ceiling is held against', async () => {
			const gate = createGitExecutionGate({
				repository: source(enrolled, ceiling),
				actor: () => ({ kind: 'agent', sessionId: 's1', agentType: 'claude-code' }),
			});
			const { request: req } = request(['commit', '-m', 'x'], {
				'remote get-url origin': 'https://github.com/acme/t.git',
			});
			const decision = await gate.hold(req);
			expect(decision).toMatchObject({
				allowed: false,
				code: 'outside-ceiling',
				managed: { actor: 'agent s1 (claude-code)' },
			});
		});
	});

	describe('holdForge (a gh effect of the git surface)', () => {
		it('standalone: allowed with no read', async () => {
			const gate = createGitExecutionGate({ repository: source(unenrolled) });
			const read = vi.fn(async () => null);
			expect(await gate.holdForge({ effect: 'pull-request', destination: null, read })).toEqual({
				allowed: true,
				operation: null,
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, no ceiling: refused unavailable with no read', async () => {
			const gate = createGitExecutionGate({ repository: source() });
			const read = vi.fn(async () => null);
			expect(
				await gate.holdForge({ effect: 'pull-request', destination: null, read })
			).toMatchObject({ allowed: false, code: 'unavailable' });
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, ceiling: a pull request reads the origin to name both the repository and the remote', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const read = vi.fn(async (a: string[]) =>
				a.join(' ') === 'remote get-url origin' ? 'https://github.com/acme/widgets.git' : null
			);
			expect(
				await gate.holdForge({ effect: 'pull-request', destination: null, read })
			).toMatchObject({
				allowed: true,
				managed: {
					effect: 'pull-request',
					repository: 'acme/widgets',
					remote: 'https://github.com',
				},
			});
			expect(read).toHaveBeenCalledTimes(1);
		});

		it('managed, ceiling: a sink that names the repository itself is held with no read', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const read = vi.fn(async () => 'https://github.com/other/thing.git');
			expect(
				await gate.holdForge({
					effect: 'pull-request',
					destination: 'https://github.com',
					repository: 'acme/named',
					read,
				})
			).toMatchObject({
				allowed: true,
				managed: { repository: 'acme/named', remote: 'https://github.com' },
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, ceiling: an effect that targets no repository names only its destination', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const decision = await gate.holdForge({
				effect: 'gist',
				destination: 'https://gist.github.com',
				read: null,
			});
			expect(decision).toMatchObject({
				allowed: false,
				code: 'outside-ceiling',
				managed: { effect: 'gist', repository: null },
			});
		});
	});

	describe('holdScript (the worktree setup script)', () => {
		it('standalone: allowed with no read', async () => {
			const gate = createGitExecutionGate({ repository: source(unenrolled) });
			const { request: req, read } = request([]);
			expect(await gate.holdScript({ target: req.target, read })).toEqual({
				allowed: true,
				operation: null,
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, no ceiling: refused unavailable with no read', async () => {
			const gate = createGitExecutionGate({ repository: source() });
			const { request: req, read } = request([]);
			expect(await gate.holdScript({ target: req.target, read })).toMatchObject({
				allowed: false,
				code: 'unavailable',
			});
			expect(read).not.toHaveBeenCalled();
		});

		it('managed, ceiling: held as the setup-script effect of the origin repository', async () => {
			const gate = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const ok = request([], { 'remote get-url origin': 'https://github.com/acme/w.git' });
			expect(await gate.holdScript({ target: ok.request.target, read: ok.read })).toMatchObject({
				allowed: true,
				managed: { effect: 'setup-script', repository: 'acme/w', remote: null },
			});
			const denied = request([], { 'remote get-url origin': 'https://github.com/other/w.git' });
			expect(
				await gate.holdScript({ target: denied.request.target, read: denied.read })
			).toMatchObject({ allowed: false, code: 'repository-denied' });
		});

		it('managed over SSH: an unqualified remote is refused by name, a qualified one is held', async () => {
			const bare = createGitExecutionGate({ repository: source(enrolled, ceiling) });
			const { read } = request([]);
			const refused = await bare.holdScript({ target: sshTarget, read });
			expect(refused).toMatchObject({ allowed: false, code: 'remote-unqualified' });
			if (!refused.allowed) expect(refused.message).toMatch(/a worktree setup script/);
			expect(read).not.toHaveBeenCalled();

			const bound = createGitExecutionGate({
				repository: source(enrolled, ceiling),
				qualifyRemote: qualified,
			});
			const ok = request([], { 'remote get-url origin': 'https://github.com/acme/w.git' });
			expect(await bound.holdScript({ target: sshTarget, read: ok.read })).toMatchObject({
				allowed: true,
				managed: { effect: 'setup-script', repository: 'acme/w' },
			});
			expect(ok.read).toHaveBeenCalledTimes(1);
		});
	});
});

describe('the shared git executor over the real gate (MRC2-04-01)', () => {
	/** Answer each `git <args>` (local) or `ssh <host> git <args>` (remote) the executor runs; an unlisted one fails. */
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

	/** Install the real gate over the real source. */
	function manage(
		document: Record<string, unknown> | null = null,
		extra: Omit<GitExecutionGateDeps, 'repository'> = {}
	): void {
		setGitExecutionGate(
			createGitExecutionGate({ repository: source(enrolled, document), ...extra })
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		setGitExecutionGate(null);
		// A remote command line is `ssh <host> git <args>`, so answers can name it the same way.
		vi.mocked(buildSshCommand).mockImplementation(async (remote, options) => ({
			command: 'ssh',
			args: [remote.host, `${options.command} ${options.args.join(' ')}`],
		}));
		answer({});
	});

	describe('standalone (no gate installed)', () => {
		it('execGit runs the command with no hold and no extra call', async () => {
			answer({ 'git push origin main': 'ok' });
			const result = await execGit(['push', 'origin', 'main'], '/repo');
			expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
			expect(ran()).toEqual(['git push origin main']);
			expect(vi.mocked(execFile.execFileNoThrow).mock.calls[0]?.[2]).toBe('/repo');
		});

		it('execGitRemote runs the command over ssh with no hold', async () => {
			answer({ 'ssh h git push origin main': 'ok' });
			const result = await execGitRemote(['push', 'origin', 'main'], {
				sshRemote,
				remoteCwd: '/remote',
			});
			expect(result.exitCode).toBe(0);
			expect(ran()).toEqual(['ssh h git push origin main']);
			expect(buildSshCommand).toHaveBeenCalledTimes(1);
		});

		it('the holds answer null with no call at all', async () => {
			expect(await holdGitCommand(['push'], { kind: 'local', cwd: '/repo' })).toBeNull();
			expect(await holdGitForgeEffect('pull-request', '/repo')).toBeNull();
			expect(await holdWorktreeSetupScript({ kind: 'local', cwd: '/repo' })).toBeNull();
			expect(ran()).toEqual([]);
		});
	});

	describe('managed with no ceiling', () => {
		beforeEach(() => manage());

		it('execGit refuses a write with zero process and the reason on stderr', async () => {
			const result = await execGit(['push', 'origin', 'main'], '/repo');
			expect(result.exitCode).toBe(GIT_REFUSED_EXIT_CODE);
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stdout).toBe('');
			expect(result.stderr).toMatch(/^\[managed-unavailable\] /);
			expect(ran()).toEqual([]);
		});

		it('execGit still runs a read unchanged', async () => {
			answer({ 'git status --porcelain': ' M a.ts' });
			const result = await execGit(['status', '--porcelain'], '/repo');
			expect(result).toEqual({ stdout: ' M a.ts', stderr: '', exitCode: 0 });
			expect(isGitRefusal(result)).toBe(false);
			expect(ran()).toEqual(['git status --porcelain']);
		});

		it('execGitReadOnly polls are unaffected and keep their timeout and lock env', async () => {
			answer({ 'git status --porcelain': '' });
			const result = await execGitReadOnly(['status', '--porcelain'], '/repo');
			expect(result.exitCode).toBe(0);
			expect(ran()).toEqual(['git status --porcelain']);
			const options = vi.mocked(execFile.execFileNoThrow).mock.calls[0]?.[3] as {
				timeout?: number;
				env?: Record<string, string>;
			};
			expect(options.timeout).toBeGreaterThan(0);
			expect(options.env?.GIT_OPTIONAL_LOCKS).toBe('0');
		});

		it('execGitRemote refuses a write before any ssh command is built', async () => {
			const result = await execGitRemote(['commit', '-m', 'x'], {
				sshRemote,
				remoteCwd: '/remote',
			});
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stderr).toMatch(/^\[managed-remote-unqualified\] /);
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(ran()).toEqual([]);
		});

		it('holdGitForgeEffect and holdWorktreeSetupScript answer the refusal with no git call', async () => {
			const forge = await holdGitForgeEffect('pull-request', '/repo');
			expect(forge && isGitRefusal(forge)).toBe(true);
			expect(forge?.stderr).toMatch(/^\[managed-unavailable\] /);
			const script = await holdWorktreeSetupScript({ kind: 'local', cwd: '/repo' });
			expect(script && isGitRefusal(script)).toBe(true);
			expect(ran()).toEqual([]);
		});

		it('an operation the executor cannot name is refused by that name', async () => {
			const result = await execGit(['credential', 'fill'], '/repo');
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stderr).toMatch(/^\[managed-operation-unknown\] /);
			expect(ran()).toEqual([]);
		});
	});

	describe('managed under a ceiling', () => {
		beforeEach(() => manage(ceiling));

		it('execGit names the remote through an unheld read at the same cwd, then runs the push', async () => {
			answer({
				'git remote get-url origin': 'https://github.com/acme/widgets.git',
				'git push origin main': 'pushed',
			});
			const result = await execGit(['push', 'origin', 'main'], '/repo');
			expect(result).toEqual({ stdout: 'pushed', stderr: '', exitCode: 0 });
			expect(ran()).toEqual(['git remote get-url origin', 'git push origin main']);
			for (const call of vi.mocked(execFile.execFileNoThrow).mock.calls) {
				expect(call[2]).toBe('/repo');
			}
		});

		it('execGit keeps the timeout and env of the held command, not of the gate read', async () => {
			answer({
				'git remote get-url origin': 'https://github.com/acme/widgets.git',
				'git commit -m x': 'done',
			});
			await execGit(['commit', '-m', 'x'], '/repo', null, undefined, {
				timeout: 5000,
				env: { GIT_AUTHOR_NAME: 'a' },
			});
			const calls = vi.mocked(execFile.execFileNoThrow).mock.calls;
			expect(calls[0]?.[3]).toBeUndefined();
			expect(calls[1]?.[3]).toMatchObject({ timeout: 5000 });
			expect((calls[1]?.[3] as { env: Record<string, string> }).env.GIT_AUTHOR_NAME).toBe('a');
		});

		it('execGit refuses a push to a remote outside the ceiling with zero process after the read', async () => {
			answer({ 'git remote get-url origin': 'git@gitlab.com:acme/widgets.git' });
			const result = await execGit(['push', 'origin', 'main'], '/repo');
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stderr).toMatch(/^\[managed-remote-denied\] /);
			expect(ran()).toEqual(['git remote get-url origin']);
		});

		it('a failed gate read names no repository and the write is refused repository-unknown', async () => {
			answer({});
			const result = await execGit(['commit', '-m', 'x'], '/repo');
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stderr).toMatch(/^\[managed-repository-unknown\] /);
			expect(ran()).toEqual(['git remote get-url origin']);
		});

		it('execGitRemote over an unqualified remote runs nothing on either machine', async () => {
			const result = await execGitRemote(['commit', '-m', 'x'], {
				sshRemote,
				remoteCwd: '/remote',
			});
			expect(isGitRefusal(result)).toBe(true);
			expect(result.stderr).toMatch(/^\[managed-remote-unqualified\] /);
			expect(result.stderr).toContain('"Box"');
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(ran()).toEqual([]);
		});

		it('execGitRemote over a qualified remote reads and writes on the remote, never locally', async () => {
			manage(ceiling, { qualifyRemote: qualified });
			answer({
				'ssh h git remote get-url origin': 'https://github.com/acme/widgets.git',
				'ssh h git commit -m x': 'committed',
			});
			const result = await execGitRemote(['commit', '-m', 'x'], {
				sshRemote,
				remoteCwd: '/remote',
			});
			expect(result).toEqual({ stdout: 'committed', stderr: '', exitCode: 0 });
			expect(ran()).toEqual(['ssh h git remote get-url origin', 'ssh h git commit -m x']);
			expect(vi.mocked(buildSshCommand).mock.calls.map((c) => c[1].cwd)).toEqual([
				'/remote',
				'/remote',
			]);
		});

		it('execGit with an ssh remote holds at the ssh target and reads a remote read unheld', async () => {
			manage(ceiling, { qualifyRemote: qualified });
			answer({ 'ssh h git status --porcelain': '' });
			const result = await execGit(['status', '--porcelain'], '/local', sshRemote, '/remote');
			expect(result.exitCode).toBe(0);
			expect(ran()).toEqual(['ssh h git status --porcelain']);
		});

		it('holdGitForgeEffect reads the origin for a pull request and nothing for a sink-named repository', async () => {
			answer({ 'git remote get-url origin': 'https://github.com/acme/widgets.git' });
			expect(await holdGitForgeEffect('pull-request', '/repo')).toBeNull();
			expect(ran()).toEqual(['git remote get-url origin']);

			vi.mocked(execFile.execFileNoThrow).mockClear();
			expect(
				await holdGitForgeEffect('pull-request', '/repo', 'https://github.com', 'acme/named')
			).toBeNull();
			expect(ran()).toEqual([]);

			const denied = await holdGitForgeEffect(
				'pull-request',
				'/repo',
				'https://github.com',
				'other/thing'
			);
			expect(denied?.stderr).toMatch(/^\[managed-repository-denied\] /);
			expect(ran()).toEqual([]);
		});

		it('holdGitForgeEffect with no cwd holds the destination alone', async () => {
			const denied = await holdGitForgeEffect('gist', null, 'https://gist.github.com');
			expect(denied && isGitRefusal(denied)).toBe(true);
			expect(denied?.stderr).toMatch(/^\[managed-outside-ceiling\] /);
			expect(ran()).toEqual([]);
		});

		it('holdWorktreeSetupScript admits the script of an admitted repository and refuses the rest', async () => {
			answer({ 'git remote get-url origin': 'https://github.com/acme/widgets.git' });
			expect(await holdWorktreeSetupScript({ kind: 'local', cwd: '/wt' })).toBeNull();
			expect(vi.mocked(execFile.execFileNoThrow).mock.calls[0]?.[2]).toBe('/wt');

			answer({ 'git remote get-url origin': 'https://github.com/other/thing.git' });
			const refused = await holdWorktreeSetupScript({ kind: 'local', cwd: '/wt' });
			expect(refused?.stderr).toMatch(/^\[managed-repository-denied\] /);
		});

		it('holdWorktreeSetupScript over an unqualified remote refuses before any ssh command', async () => {
			const refused = await holdWorktreeSetupScript(sshTarget);
			expect(refused?.stderr).toMatch(/^\[managed-remote-unqualified\] /);
			expect(buildSshCommand).not.toHaveBeenCalled();
			expect(ran()).toEqual([]);
		});
	});
});
