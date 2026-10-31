/**
 * Tests for src/main/agents/provider-account-dirs.ts
 *
 * Covers the attribution failures this module exists to prevent:
 *   - two Codex accounts are two account dirs, not one merged read
 *   - an account dir outside $HOME is still found, because a configured agent
 *     names it (the sibling scan never could)
 *   - a symlinked shared transcript pool is read once, not once per account
 *   - an unrelated `<subdir>-*` folder with no sessions subtree is not an account
 *   - an SSH-remote agent's dir is NOT adopted: it names a path on that host
 *   - a provider with no account-selecting env var reports no account dirs
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../../shared/types';
import type { SshLaunchTarget } from '../../../shared/maestro-lib/launch/ssh-remote-resolver';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// The module reads the sessions / agent-configs stores when the caller does not
// inject them. Every test here injects, so the stores only need to not explode
// at import time.
vi.mock('../../../main/stores/instances', () => ({
	isInitialized: () => false,
}));

vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => {
		throw new Error('stores must not be read when sessions are injected');
	},
	getAgentConfigsStore: () => {
		throw new Error('stores must not be read when env vars are injected');
	},
	getSettingsStore: () => {
		throw new Error('stores must not be read when shell env vars are injected');
	},
}));

import {
	getProviderAccountDirs,
	resolveAgentAccountDir,
	type AgentAccountDirOptions,
} from '../../../main/agents/provider-account-dirs';
import {
	resolveAgentAccountDir as resolveAccountDirForAgent,
	resolveAgentAccountRef,
	observeGrokLaunchScope,
	type GrokLaunchScopePorts,
} from '../../../shared/agentAccountDir';

let homeDir: string;
let outsideHome: string;

/**
 * Windows refuses a 'dir' symlink without elevation or developer mode, but
 * allows a junction, which realpath resolves identically.
 */
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

/** Create `<home>/<name>/<sessionsSubdir>` and return the account dir. */
function makeAccountDir(root: string, name: string, sessionsSubdir: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(path.join(dir, sessionsSubdir), { recursive: true });
	return dir;
}

let tmpRoot: string;

beforeEach(() => {
	const fixtureRoot = path.join(process.cwd(), 'tmp');
	fs.mkdirSync(fixtureRoot, { recursive: true });
	tmpRoot = fs.mkdtempSync(path.join(fixtureRoot, 'maestro-account-dirs-'));
	fs.mkdirSync(path.join(tmpRoot, 'home'), { recursive: true });
	fs.mkdirSync(path.join(tmpRoot, 'elsewhere'), { recursive: true });
	// realpath so macOS's /var -> /private/var symlink does not make every
	// expectation fail on a path the module correctly resolved.
	homeDir = fs.realpathSync(path.join(tmpRoot, 'home'));
	outsideHome = fs.realpathSync(path.join(tmpRoot, 'elsewhere'));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('getProviderAccountDirs', () => {
	it('discovers two Grok transcript roots without adopting an SSH account as local', async () => {
		const personal = makeAccountDir(homeDir, '.grok', 'sessions');
		const work = makeAccountDir(homeDir, '.grok-work', 'sessions');
		const remoteOnly = makeAccountDir(outsideHome, 'grok-remote', 'sessions');
		const dirs = await getProviderAccountDirs('grok', {
			homeDir,
			env: {},
			agentLevelEnvVars: {},
			sessions: [
				{
					toolType: 'grok',
					customEnvVars: { GROK_HOME: remoteOnly },
					sessionSshRemoteConfig: { enabled: true },
				},
			],
		});

		expect(dirs.sort()).toEqual([personal, work].sort());
	});

	it('keeps two Codex accounts apart instead of merging them', async () => {
		const defaultHome = makeAccountDir(homeDir, '.codex', 'sessions');
		const workHome = makeAccountDir(homeDir, '.codex-work', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs.sort()).toEqual([defaultHome, workHome].sort());
	});

	it("finds an account dir outside $HOME from an agent's own customEnvVars", async () => {
		makeAccountDir(homeDir, '.codex', 'sessions');
		const external = makeAccountDir(outsideHome, 'codex-acc-1', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'codex', customEnvVars: { CODEX_HOME: external } }],
			agentLevelEnvVars: {},
		});

		expect(dirs).toContain(external);
	});

	it('falls back to the provider-level env when the agent sets none', async () => {
		makeAccountDir(homeDir, '.codex', 'sessions');
		const external = makeAccountDir(outsideHome, 'codex-provider', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'codex' }],
			agentLevelEnvVars: { CODEX_HOME: external },
		});

		expect(dirs).toContain(external);
	});

	it("does not adopt an SSH-remote agent's dir, which names a path on that host", async () => {
		makeAccountDir(homeDir, '.claude', 'projects');
		const remoteOnlyPath = path.join(outsideHome, 'claude-on-the-remote');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [
				{
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: remoteOnlyPath },
					sessionSshRemoteConfig: { enabled: true },
				},
			],
			agentLevelEnvVars: {},
		});

		expect(dirs).not.toContain(remoteOnlyPath);
	});

	it('reads a symlinked shared transcript pool exactly once', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		// The common multi-account setup: separate credentials, one shared pool.
		const sharedHome = path.join(homeDir, '.claude-work');
		fs.mkdirSync(sharedHome, { recursive: true });
		fs.symlinkSync(
			path.join(defaultHome, 'projects'),
			path.join(sharedHome, 'projects'),
			SYMLINK_TYPE
		);

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it('reads a shared pool once while still reading a genuinely separate account', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		const ownPool = makeAccountDir(homeDir, '.claude-work', 'projects');
		const sharedHome = path.join(homeDir, '.claude-gmail');
		fs.mkdirSync(sharedHome, { recursive: true });
		fs.symlinkSync(
			path.join(defaultHome, 'projects'),
			path.join(sharedHome, 'projects'),
			SYMLINK_TYPE
		);

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs.sort()).toEqual([defaultHome, ownPool].sort());
	});

	it('keeps an account whose sessions tree does not exist yet', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		const fresh = path.join(outsideHome, 'claude-fresh');
		fs.mkdirSync(fresh, { recursive: true });

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: fresh } }],
			agentLevelEnvVars: {},
		});

		// A brand-new account with no transcripts yet still appears rather than
		// silently collapsing into another account.
		expect(dirs.sort()).toEqual([defaultHome, fresh].sort());
	});

	it('ignores a lookalike folder with no sessions subtree', async () => {
		const defaultHome = makeAccountDir(homeDir, '.codex', 'sessions');
		fs.mkdirSync(path.join(homeDir, '.codex-notes'), { recursive: true });

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it('ignores a backup copy of an account dir', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		makeAccountDir(homeDir, '.claude-backup', 'projects');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it("honours Maestro's own environment for a user who exports the var", async () => {
		makeAccountDir(homeDir, '.copilot', 'session-state');
		const exported = makeAccountDir(outsideHome, 'copilot-exported', 'session-state');

		const dirs = await getProviderAccountDirs('copilot-cli', {
			homeDir,
			env: { COPILOT_HOME: exported },
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toContain(exported);
	});

	it('reports no account dirs for a provider with no account-selecting env var', async () => {
		await expect(
			getProviderAccountDirs('opencode', { homeDir, env: {}, sessions: [], agentLevelEnvVars: {} })
		).resolves.toEqual([]);
		await expect(
			getProviderAccountDirs('factory-droid', {
				homeDir,
				env: {},
				sessions: [],
				agentLevelEnvVars: {},
			})
		).resolves.toEqual([]);
	});

	it('still reports the default account when nothing exists on disk yet', async () => {
		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([path.join(homeDir, '.codex')]);
	});
});

// One agent's own account: what its session browser must list and total,
// since claude only resumes sessions from the config dir it was started with.
describe('resolveAgentAccountDir', () => {
	const agent = (overrides: Record<string, unknown> = {}) => ({
		id: 'agent-1',
		toolType: 'claude-code',
		...overrides,
	});
	const base = () => ({
		homeDir,
		env: {} as NodeJS.ProcessEnv,
		agentLevelEnvVars: {},
		globalShellEnvVars: {},
	});

	it('resolves each stored Grok agent to its own transcript root', () => {
		const personal = makeAccountDir(homeDir, '.grok', 'sessions');
		const work = makeAccountDir(outsideHome, 'grok-work', 'sessions');
		const options = {
			...base(),
			sessions: [
				agent({ toolType: 'grok', customEnvVars: { GROK_HOME: personal } }),
				agent({ id: 'agent-2', toolType: 'grok', customEnvVars: { GROK_HOME: work } }),
			],
		};

		expect(resolveAgentAccountDir('agent-1', options)).toBe(personal);
		expect(resolveAgentAccountDir('agent-2', options)).toBe(work);
	});

	it.each([
		['session', { GROK_HOME: 'session' }, 'provider', 'global', 'host', 'session'],
		['provider', undefined, 'provider', 'global', 'host', 'provider'],
		['empty session replaces provider', {}, 'provider', 'global', 'host', 'global'],
		[
			'unrelated session replaces provider',
			{ OTHER: 'value' },
			'provider',
			'global',
			'host',
			'global',
		],
		['global', undefined, undefined, 'global', 'host', 'global'],
		['host', undefined, undefined, undefined, 'host', 'host'],
		['default', undefined, undefined, undefined, undefined, '.grok'],
	] as const)(
		'resolves Grok precedence: %s',
		(_name, custom: Record<string, string> | undefined, provider, global, host, expected) => {
			const customEnvVars =
				custom &&
				('GROK_HOME' in custom ? { GROK_HOME: path.posix.join('~', custom.GROK_HOME) } : custom);
			const dir = resolveAgentAccountDir('agent-1', {
				...base(),
				sessions: [agent({ toolType: 'grok', customEnvVars })],
				agentLevelEnvVars: provider ? { GROK_HOME: path.join(homeDir, provider) } : {},
				globalShellEnvVars: global ? { GROK_HOME: path.join(homeDir, global) } : {},
				env: host ? { GROK_HOME: path.join(homeDir, host) } : {},
			});

			expect(dir).toBe(path.join(homeDir, expected));
		}
	);

	it.each(['', ' \t\n', '\u00a0'])(
		'lets a blank Grok override %j cancel every lower account layer',
		(blank) => {
			const root = path.join(outsideHome, 'lower-account');
			const layers = {
				...base(),
				agentLevelEnvVars: { GROK_HOME: root },
				globalShellEnvVars: { GROK_HOME: root },
				env: { GROK_HOME: root },
			};
			const session = agent({ toolType: 'grok' });
			const cases: AgentAccountDirOptions[] = [
				{ ...layers, sessions: [{ ...session, customEnvVars: { GROK_HOME: blank } }] },
				{ ...layers, sessions: [session], agentLevelEnvVars: { GROK_HOME: blank } },
				{
					...layers,
					sessions: [session],
					agentLevelEnvVars: {},
					globalShellEnvVars: { GROK_HOME: blank },
				},
				{ ...base(), sessions: [session], env: { GROK_HOME: blank } },
			];

			for (const options of cases) {
				expect(resolveAgentAccountDir('agent-1', options)).toBe(path.join(homeDir, '.grok'));
			}
		}
	);

	it('keeps Grok SSH paths remote and never borrows local global or host roots', () => {
		const root = path.posix.join('~', '.grok-work');
		const session = agent({ toolType: 'grok', customEnvVars: { GROK_HOME: root } });
		const options = {
			...base(),
			globalShellEnvVars: { GROK_HOME: path.join(outsideHome, 'global') },
			env: { GROK_HOME: path.join(outsideHome, 'host') },
		};
		expect(resolveAgentAccountDir('agent-1', { ...options, sessions: [session] })).toBe(
			path.join(homeDir, '.grok-work')
		);
		const remote = { ...session, sessionSshRemoteConfig: { enabled: true } };
		expect(resolveAgentAccountDir('agent-1', { ...options, sessions: [remote] })).toBe(root);
		expect(
			resolveAgentAccountDir('agent-1', {
				...options,
				sessions: [{ ...remote, customEnvVars: undefined }],
				agentLevelEnvVars: { GROK_HOME: root },
			})
		).toBe(root);
		for (const customEnvVars of [undefined, {}, { GROK_HOME: '' }, { GROK_HOME: ' \t' }]) {
			expect(
				resolveAgentAccountDir('agent-1', {
					...options,
					sessions: [{ ...remote, customEnvVars }],
				})
			).toBeUndefined();
		}
		expect(
			resolveAgentAccountDir('agent-1', {
				...options,
				agentLevelEnvVars: { GROK_HOME: root },
				sessions: [{ ...remote, customEnvVars: { GROK_HOME: ' \t' } }],
			})
		).toBeUndefined();
	});

	it.each([false, true])(
		'honors a managed Grok account above user and host roots (SSH=%s)',
		(sshRemote) => {
			const managedRoot = path.posix.join('~', '.grok-managed');
			const layers = {
				...base(),
				agentLevelEnvVars: { GROK_HOME: path.join(outsideHome, 'provider') },
				globalShellEnvVars: { GROK_HOME: path.join(outsideHome, 'global') },
				env: { GROK_HOME: path.join(outsideHome, 'host') },
			};
			const expected = sshRemote ? managedRoot : path.join(homeDir, '.grok-managed');
			const boundRef = resolveAgentAccountRef(
				{
					toolType: 'grok',
					sshRemote,
					customEnvVars: { GROK_HOME: expected },
				},
				base()
			);
			expect(boundRef).not.toBeNull();

			for (const override of [path.join(outsideHome, 'session'), '', ' \t']) {
				const bound = {
					toolType: 'grok',
					sshRemote,
					managedAccountDir: ` ${managedRoot} `,
					customEnvVars: { GROK_HOME: override },
				};
				expect(resolveAccountDirForAgent(bound, layers)).toBe(expected);
				expect(resolveAgentAccountRef(bound, layers)).toBe(boundRef);
				expect(resolveAgentAccountRef({ ...bound, managedAccountDir: null }, layers)).not.toBe(
					boundRef
				);
			}
		}
	);

	it("uses the agent's own CLAUDE_CONFIG_DIR, expanding ~", () => {
		const dir = resolveAgentAccountDir('agent-1', {
			...base(),
			sessions: [agent({ customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-work' } })],
		});
		expect(dir).toBe(path.join(homeDir, '.claude-work'));
	});

	it('lets the provider-level set stand in when the agent has none, and the agent set replace it', () => {
		const providerDir = path.join(outsideHome, 'provider');
		const agentDir = path.join(outsideHome, 'agent');
		const options = { ...base(), agentLevelEnvVars: { CLAUDE_CONFIG_DIR: providerDir } };

		expect(resolveAgentAccountDir('agent-1', { ...options, sessions: [agent()] })).toBe(
			providerDir
		);
		expect(
			resolveAgentAccountDir('agent-1', {
				...options,
				sessions: [agent({ customEnvVars: { CLAUDE_CONFIG_DIR: agentDir } })],
			})
		).toBe(agentDir);
	});

	it('falls back through Settings -> Environment, then Maestro env, then the default', () => {
		const globalDir = path.join(outsideHome, 'global');
		const envDir = path.join(outsideHome, 'env');
		const sessions = [agent()];

		expect(
			resolveAgentAccountDir('agent-1', {
				...base(),
				sessions,
				globalShellEnvVars: { CLAUDE_CONFIG_DIR: globalDir },
				env: { CLAUDE_CONFIG_DIR: envDir },
			})
		).toBe(globalDir);
		expect(
			resolveAgentAccountDir('agent-1', { ...base(), sessions, env: { CLAUDE_CONFIG_DIR: envDir } })
		).toBe(envDir);
		expect(resolveAgentAccountDir('agent-1', { ...base(), sessions })).toBe(
			path.join(homeDir, '.claude')
		);
	});

	it('returns an SSH agent its remote path untouched, and nothing when it set none', () => {
		const ssh = { sessionSshRemoteConfig: { enabled: true } };
		expect(
			resolveAgentAccountDir('agent-1', {
				...base(),
				sessions: [agent({ ...ssh, customEnvVars: { CLAUDE_CONFIG_DIR: '~/.claude-remote' } })],
			})
		).toBe('~/.claude-remote');
		expect(
			resolveAgentAccountDir('agent-1', {
				...base(),
				sessions: [agent(ssh)],
				env: { CLAUDE_CONFIG_DIR: path.join(outsideHome, 'local-only') },
			})
		).toBeUndefined();
	});

	it('answers undefined for an unknown agent or a provider with no account dir', () => {
		expect(resolveAgentAccountDir('missing', { ...base(), sessions: [agent()] })).toBeUndefined();
		expect(
			resolveAgentAccountDir('agent-1', { ...base(), sessions: [agent({ toolType: 'terminal' })] })
		).toBeUndefined();
	});
});
describe('observeGrokLaunchScope shared directory ports', () => {
	let cwd: string;
	let env: NodeJS.ProcessEnv;
	let ports: GrokLaunchScopePorts;
	let remote: SshRemoteConfig;
	let endpoint: string;
	let receipt: {
		cwd: { canonicalPath: string; inode: string };
		account: { canonicalPath: string; inode: string };
		effective: { HOME: string; GROK_HOME: string };
	};
	const observe = (target: SshRemoteConfig | null = null, args: string[] = []) =>
		observeGrokLaunchScope({ cwd }, target, env, args, ports);

	beforeEach(() => {
		cwd = path.join(tmpRoot, 'virtual-project');
		env = { HOME: homeDir, USERPROFILE: homeDir };
		remote = {
			id: 'remote-1',
			name: 'Fixture',
			host: 'fixture.invalid',
			port: 22,
			username: 'fixture',
			privateKeyPath: '',
			enabled: true,
			remoteEnv: {},
		};
		endpoint = 'remote-installation';
		receipt = {
			cwd: { canonicalPath: '/remote/project', inode: '2' },
			account: { canonicalPath: '/remote/account', inode: '3' },
			effective: { HOME: '/remote/home', GROK_HOME: '/remote/account' },
		};
		ports = {
			local: {
				homedir: vi.fn(() => homeDir),
				realpath: vi.fn(async (directory) => directory),
				stat: vi.fn(async () => ({ isDirectory: () => true })),
				realpathSync: vi.fn((directory) => directory),
				isExpectedError: vi.fn((error) => (error as NodeJS.ErrnoException).code === 'ENOENT'),
				installationId: vi.fn(() => 'local-installation'),
			},
			remote: {
				observe: vi.fn(async () => ({ success: true, data: structuredClone(receipt) })),
				qualify: vi.fn(
					async (selected): Promise<SshLaunchTarget> => ({
						kind: 'remote',
						remote: selected,
						endpoint: {
							contractVersion: '1',
							installationId: endpoint,
							runtimeId: 'runtime',
							processEpoch: 'epoch',
							tenantId: 'tenant',
							orgId: 'org',
							authorityId: 'authority',
							policyRevision: 1,
							authority: 'registered',
							routes: [],
						},
					})
				),
				isExpectedError: vi.fn((error) => error === 'disconnected'),
			},
		};
	});

	it.each([undefined, '', 'relative-account', '~/.grok-work', 'absolute'])(
		'observes the native local root %j through injected directories only',
		async (root) => {
			env.GROK_HOME = root === 'absolute' ? outsideHome : root;
			const account = root ? path.resolve(cwd, env.GROK_HOME!) : path.join(homeDir, '.grok');
			const result = await observe();
			expect(result.scope).toEqual({
				version: 1,
				state: 'bound',
				provider: 'grok',
				cwd,
				accountRef: resolveAgentAccountRef(
					{ toolType: 'grok', managedAccountDir: account },
					{ homeDir }
				),
				host: { kind: 'local', identity: 'local-installation' },
			});
			expect(vi.mocked(ports.local.realpath).mock.calls).toEqual([[cwd], [account]]);
			expect(vi.mocked(ports.local.stat).mock.calls).toEqual([[cwd], [account]]);
			expect(result.recheck?.()).toBe(true); // Local admission recheck stays synchronous.
			expect(vi.mocked(ports.local.realpathSync).mock.calls).toEqual([[cwd], [account]]);
			expect(ports.remote.observe).not.toHaveBeenCalled();
			expect(ports.remote.qualify).not.toHaveBeenCalled();
			expect(Object.isFrozen(result.scope)).toBe(true);
			if (result.scope.state === 'bound') expect(Object.isFrozen(result.scope.host)).toBe(true);
			expect(result.scope).not.toHaveProperty('nativeSessionId');
		}
	);

	it('uses the injected home fallback and keeps two canonical accounts separate', async () => {
		env = {};
		const personal = await observe();
		expect(ports.local.homedir).toHaveBeenCalledOnce();
		env.GROK_HOME = outsideHome;
		const work = await observe();
		expect(work.scope.state).toBe('bound');
		expect(work.scope).not.toEqual(personal.scope);
		vi.mocked(ports.local.realpath).mockImplementation(async (dir) =>
			dir === outsideHome ? path.join(homeDir, '.grok') : dir
		);
		expect((await observe()).scope).toEqual(personal.scope);
	});

	it.each(['whitespace-root', 'padded-root', 'relative-home', 'empty-home', 'relative-cwd'])(
		'keeps %s unknown without directory probes',
		async (selection) => {
			if (selection === 'whitespace-root') env.GROK_HOME = ' \t';
			if (selection === 'padded-root') env.GROK_HOME = ` ${outsideHome} `;
			if (selection === 'relative-home') env.HOME = env.USERPROFILE = 'relative-home';
			if (selection === 'empty-home') env.HOME = env.USERPROFILE = '';
			if (selection === 'relative-cwd') cwd = 'relative-project';
			expect(await observe()).toEqual({
				scope: { version: 1, state: 'unknown', reason: 'unobserved' },
			});
			expect(ports.local.realpath).not.toHaveBeenCalled();
			expect(ports.local.installationId).not.toHaveBeenCalled();
		}
	);

	it.each(['missing-account', 'not-directory', 'unexpected'])(
		'preserves %s instead of falling back to the default root',
		async (failure) => {
			env.GROK_HOME = outsideHome;
			const error = Object.assign(new Error(failure), {
				code: failure === 'unexpected' ? 'EMFILE' : 'ENOENT',
			});
			if (failure === 'not-directory')
				vi.mocked(ports.local.stat).mockResolvedValue({ isDirectory: () => false });
			else
				vi.mocked(ports.local.realpath).mockImplementation(async (dir) => {
					if (dir === outsideHome) throw error;
					return dir;
				});
			if (failure === 'unexpected') await expect(observe()).rejects.toBe(error);
			else expect((await observe()).scope.state).toBe('unknown');
			expect(vi.mocked(ports.local.realpath).mock.calls).toEqual([[cwd], [outsideHome]]);
			expect(ports.local.installationId).not.toHaveBeenCalled();
		}
	);

	it.each(['cwd', 'account', 'missing', 'unexpected'])(
		'refuses changed local %s on recheck and propagates unexpected errors',
		async (change) => {
			const result = await observe();
			const error = Object.assign(new Error(change), {
				code: change === 'missing' ? 'ENOENT' : 'EMFILE',
			});
			vi.mocked(ports.local.realpathSync).mockImplementation((dir) => {
				if (change === 'missing' || change === 'unexpected') throw error;
				return dir === (change === 'cwd' ? cwd : path.join(homeDir, '.grok')) ? outsideHome : dir;
			});
			if (change === 'unexpected') expect(() => result.recheck?.()).toThrow(error);
			else expect(result.recheck?.()).toBe(false);
		}
	);

	describe('SSH observations', () => {
		beforeEach(() => {
			cwd = '/remote/shell-project';
		});
		afterEach(() => {
			for (const port of Object.values(ports.local)) expect(port).not.toHaveBeenCalled();
		});

		it.each([
			{ args: [], nativeCwd: undefined },
			{ args: ['--cwd', 'relative-project'], nativeCwd: 'relative-project' },
			{ args: ['--cwd=~/literal-project'], nativeCwd: '~/literal-project' },
		])(
			'passes native cwd separately from the shell cwd: $nativeCwd',
			async ({ args, nativeCwd }) => {
				env = { GROK_HOME: '~/chosen account', HOME: '/selected/home' };
				const result = await observe(remote, args);
				expect(ports.remote.observe).toHaveBeenCalledWith(cwd, remote, {
					env,
					nativeCwd,
				});
				expect(result.scope).toEqual({
					version: 1,
					state: 'bound',
					provider: 'grok',
					cwd: '/remote/project',
					accountRef: resolveAgentAccountRef(
						{ toolType: 'grok', sshRemote: true, managedAccountDir: '/remote/account' },
						{ homeDir: '' }
					),
					host: { kind: 'ssh', identity: endpoint },
				});
				expect(vi.mocked(ports.remote.qualify).mock.calls[0][0]).not.toBe(remote);
				expect(await result.recheck?.()).toBe(true);
				expect(ports.remote.qualify).toHaveBeenCalledTimes(4);
			}
		);

		it.each([undefined, '', ' \t', 'relative-account', '~/.grok-work'])(
			'leaves remote root %j to the injected host observation',
			async (root) => {
				env = { GROK_HOME: root };
				const result = await observe(remote);
				expect(ports.remote.observe).toHaveBeenCalledWith(cwd, remote, {
					env,
					nativeCwd: undefined,
				});
				expect(result.scope.state).toBe('bound');
				expect(await result.recheck?.()).toBe(true);
			}
		);

		it.each(['cwd', 'account'] as const)(
			'does not normalize an unrepresentable remote %s',
			async (field) => {
				for (const canonicalPath of [' /remote/padded ', '/remote/literal\\name']) {
					receipt[field].canonicalPath = canonicalPath;
					expect(await observe(remote)).toEqual({
						scope: { version: 1, state: 'unknown', reason: 'unobserved' },
					});
				}
			}
		);

		it('separates accounts and executing installations despite identical SSH aliases', async () => {
			const first = await observe(remote);
			receipt.account.canonicalPath = '/remote/account-two';
			const second = await observe(remote);
			expect(second.scope.state).toBe('bound');
			expect(second.scope).not.toEqual(first.scope);
			receipt.account.canonicalPath = '/remote/account';
			endpoint = 'second-installation';
			expect((await observe(remote)).scope).toEqual({
				...first.scope,
				host: { kind: 'ssh', identity: endpoint },
			});
		});

		it.each([
			'unqualified',
			'wrong-config',
			'blank-identity',
			'control-identity',
			'changed-endpoint',
		])('leaves %s unknown without inventing a config-based host identity', async (failure) => {
			const qualified = await ports.remote.qualify(remote);
			vi.mocked(ports.remote.qualify).mockClear();
			if (failure === 'unqualified') vi.mocked(ports.remote.qualify).mockResolvedValue(undefined);
			if (failure === 'wrong-config')
				vi.mocked(ports.remote.qualify).mockResolvedValue({
					...qualified,
					remote: { ...remote, host: 'different.invalid' },
				} as SshLaunchTarget);
			if (failure === 'blank-identity') endpoint = ' ';
			if (failure === 'control-identity') endpoint = 'bad\nidentity';
			if (failure === 'changed-endpoint')
				vi.mocked(ports.remote.observe).mockImplementation(async () => {
					endpoint = 'replacement-installation';
					return { success: true, data: receipt };
				});
			expect((await observe(remote)).scope.state).toBe('unknown');
			if (failure !== 'changed-endpoint') expect(ports.remote.observe).not.toHaveBeenCalled();
		});

		it.each(['missing', 'disconnected', 'unexpected'])(
			'preserves remote %s during both observation and recheck',
			async (failure) => {
				const result = await observe(remote);
				vi.mocked(ports.remote.observe).mockResolvedValue({
					success: false,
					error: failure,
					...(failure === 'missing' ? { errorCode: 'identity-unavailable' } : {}),
				});
				if (failure === 'unexpected') {
					await expect(observe(remote)).rejects.toThrow(failure);
					await expect(result.recheck?.()).rejects.toThrow(failure);
				} else {
					expect((await observe(remote)).scope.state).toBe('unknown');
					expect(await result.recheck?.()).toBe(false);
				}
			}
		);

		it.each(['cwd', 'account', 'inode', 'environment', 'endpoint-before', 'endpoint-after'])(
			'rechecks complete remote evidence: %s',
			async (change) => {
				const result = await observe(remote);
				if (change === 'cwd') receipt.cwd.canonicalPath = '/remote/changed';
				if (change === 'account') receipt.account.canonicalPath = '/remote/changed';
				if (change === 'inode') receipt.account.inode = 'replacement-inode';
				if (change === 'environment') receipt.effective.HOME = '/changed-home';
				if (change === 'endpoint-before') endpoint = 'replacement-installation';
				if (change === 'endpoint-after')
					vi.mocked(ports.remote.observe).mockImplementation(async () => {
						endpoint = 'replacement-installation';
						return { success: true, data: receipt };
					});
				expect(await result.recheck?.()).toBe(false);
				if (change === 'endpoint-before') expect(ports.remote.observe).toHaveBeenCalledOnce();
			}
		);
	});
});
