// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { registerMemoryHandlers } from '../../../../main/ipc/handlers/memory';
import { logger } from '../../../../main/utils/logger';
import { execGitReadOnly } from '../../../../main/utils/remote-git';
import { runProviderProbe } from '../../../../main/agents/provider-probe';
import { setSettingsWriteAuthority } from '../../../../main/enterprise/settings-policy';
import { resolveClaudeMemoryPath } from '../../../../shared/maestro-lib/translation/memory';
import { createMockSession } from '../../../helpers/mockSession';
import { installManagedSettingsPolicy } from '../../../helpers/managedSettingsPolicy';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../../main/agents/provider-probe', () => ({ runProviderProbe: vi.fn() }));

describe('memory IPC selected provider scope (GT1-05-08)', () => {
	const operations: [string, string[]][] = [
		['list', []],
		['read', ['note.md']],
		['write', ['note.md', 'replacement']],
		['create', ['new.md', 'new memory']],
		['delete', ['note.md']],
		['search', ['marker']],
		['orphans', []],
		['getPath', []],
	];
	let root: string;
	let project: string;
	let sessions: ReturnType<typeof createMockSession>[];
	let handlers: Map<string, (...args: never[]) => unknown>;
	let deps: {
		sessionsStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
		settingsStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
		agentConfigsStore: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
		getAgentDetector: ReturnType<typeof vi.fn>;
	};
	const call = (operation: string, args: string[], id: string, cwd = project) =>
		handlers.get(`memory:${operation}`)!(
			{} as never,
			cwd as never,
			...(args as never[]),
			id as never
		) as Promise<Record<string, unknown>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-memory-ipc-'));
		project = path.join(root, 'project');
		await fs.mkdir(project);
		sessions = ['a', 'b'].map((account) =>
			createMockSession({
				id: `selected-${account}`,
				toolType: 'grok',
				cwd: project,
				projectRoot: project,
				customEnvVars: { GROK_HOME: path.join(root, `account-${account}`) },
			})
		);
		deps = {
			sessionsStore: { get: vi.fn(() => sessions), set: vi.fn() },
			settingsStore: { get: vi.fn(() => ({})), set: vi.fn() },
			agentConfigsStore: { get: vi.fn(() => ({})), set: vi.fn() },
			getAgentDetector: vi.fn(() => ({ getAgent: vi.fn(async () => undefined) })),
		};
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		registerMemoryHandlers(deps as unknown as Parameters<typeof registerMemoryHandlers>[0]);
	});

	afterEach(async () => {
		setSettingsWriteAuthority(null);
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it.each(operations)(
		'refuses native %s for both selected accounts before filesystem/config/probe effects',
		async (operation, args) => {
			const effects = (
				[
					'readdir',
					'readFile',
					'writeFile',
					'mkdir',
					'open',
					'unlink',
					'stat',
					'lstat',
					'realpath',
				] as const
			).map((method) => vi.spyOn(fs, method));
			for (const id of ['selected-a', 'selected-b', 'grok']) {
				await expect(call(operation, args, id)).resolves.toEqual({
					success: false,
					error: expect.stringContaining('Grok native project memory is not supported'),
				});
			}
			await expect(call(operation, args, 'missing-agent')).resolves.toEqual({
				success: false,
				error: expect.stringContaining('not supported for agent "missing-agent"'),
			});
			for (const effect of effects) expect(effect).not.toHaveBeenCalled();
			for (const store of [deps.settingsStore, deps.agentConfigsStore]) {
				expect(store.get).not.toHaveBeenCalled();
				expect(store.set).not.toHaveBeenCalled();
			}
			expect(deps.sessionsStore.set).not.toHaveBeenCalled();
			expect(deps.getAgentDetector).not.toHaveBeenCalled();
			expect(runProviderProbe).not.toHaveBeenCalled();
			expect(execGitReadOnly).not.toHaveBeenCalled();
		}
	);

	it.each(['wrong project', 'configured SSH', 'observed SSH'])(
		'rejects %s even with bound knowledge',
		async (scope) => {
			sessions[0].providerTranslationKnowledgeDirectory = path.join(project, 'knowledge-a');
			if (scope === 'configured SSH')
				sessions[0].sessionSshRemoteConfig = { enabled: true, remoteId: 'remote-a' };
			if (scope === 'observed SSH') sessions[0].sshRemoteId = 'remote-a';
			const read = vi.spyOn(fs, 'readFile');
			const write = vi.spyOn(fs, 'writeFile');
			for (const [operation, args] of operations) {
				await expect(
					call(operation, args, sessions[0].id, scope === 'wrong project' ? root : project)
				).resolves.toEqual({
					success: false,
					error: 'Error: Memory scope does not match the selected local agent',
				});
			}
			expect(read).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		}
	);

	it.each(operations)('redacts returned and logged %s errors', async (operation, args) => {
		deps.sessionsStore.get.mockImplementation(() => {
			throw new Error('password=fixture-private-value');
		});
		const result = await call(operation, args, sessions[0].id);
		expect(result).toEqual({ success: false, error: 'Error: password=[REDACTED_SECRET]' });
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('[REDACTED_SECRET]'),
			'[IPC:Memory]'
		);
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
			'fixture-private-value'
		);
	});

	it.each(['write', 'create', 'delete'])(
		'refuses native %s on an enrolled host without changing policy or account configuration',
		async (operation) => {
			installManagedSettingsPolicy([{ key: 'agentConfig.customEnvVars' }]);
			const snapshot = structuredClone(sessions);
			const args = operations.find(([name]) => name === operation)![1];
			const write = vi.spyOn(fs, 'writeFile');
			const open = vi.spyOn(fs, 'open');
			const remove = vi.spyOn(fs, 'unlink');
			await expect(call(operation, args, sessions[0].id)).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining('Grok native project memory is not supported'),
			});
			expect(sessions).toEqual(snapshot);
			for (const effect of [
				write,
				open,
				remove,
				deps.sessionsStore.set,
				deps.settingsStore.set,
				deps.agentConfigsStore.set,
			])
				expect(effect).not.toHaveBeenCalled();
		}
	);

	it.each(['read', 'write', 'create', 'delete'])(
		'does not echo a secret-bearing %s filename in errors or logs',
		async (operation) => {
			sessions[0].providerTranslationKnowledgeDirectory = path.join(project, 'knowledge-a');
			const filename = 'password=fixture-private-value.txt';
			const result = await call(
				operation,
				[filename, ...(operation === 'write' || operation === 'create' ? ['body'] : [])],
				sessions[0].id
			);
			expect(result).toEqual({
				success: false,
				error: 'Error: Memory filenames must end with .md: password=[REDACTED_SECRET]',
			});
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('[REDACTED_SECRET]'),
				'[IPC:Memory]'
			);
			expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
				'fixture-private-value'
			);
		}
	);

	it('keeps explicitly bound Grok knowledge local to each selected account and rejects an outside-project binding', async () => {
		for (const [index, session] of sessions.entries()) {
			session.providerTranslationKnowledgeDirectory = path.join(project, `knowledge-${index}`);
			const directory = path.join(session.providerTranslationKnowledgeDirectory, 'memory');
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, 'note.md'), `account-${index} marker`);
			await expect(call('getPath', [], session.id)).resolves.toEqual({
				success: true,
				path: directory,
			});
			await expect(call('read', ['note.md'], session.id)).resolves.toEqual({
				success: true,
				content: `account-${index} marker`,
			});
		}
		await expect(call('write', ['note.md', 'updated-a'], sessions[0].id)).resolves.toEqual({
			success: true,
		});
		await expect(call('read', ['note.md'], sessions[1].id)).resolves.toEqual({
			success: true,
			content: 'account-1 marker',
		});
		sessions[0].providerTranslationKnowledgeDirectory = path.join(root, 'outside');
		await expect(call('write', ['note.md', 'escaped'], sessions[0].id)).resolves.toEqual({
			success: false,
			error: 'Error: Unsafe translation target',
		});
		expect(deps.getAgentDetector).not.toHaveBeenCalled();
	});

	it('resolves Claude native memory from each selected account and preserves unsupported reference providers', async () => {
		vi.mocked(execGitReadOnly).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		for (const [index, session] of sessions.entries()) {
			session.toolType = 'claude-code';
			const account = path.join(root, `claude-${index}`);
			session.customEnvVars = { CLAUDE_CONFIG_DIR: account };
			const directory = resolveClaudeMemoryPath(project, account);
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, 'note.md'), `claude-${index}`);
			await expect(call('read', ['note.md'], session.id)).resolves.toEqual({
				success: true,
				content: `claude-${index}`,
			});
		}
		for (const provider of ['codex', 'antigravity'] as const) {
			sessions[0].toolType = provider;
			await expect(call('getPath', [], sessions[0].id)).resolves.toEqual({
				success: false,
				error: `Error: Memory viewer is not supported for agent "${provider}"`,
			});
		}
	});
});
