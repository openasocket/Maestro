import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports)
// ============================================================================

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	statRemote: vi.fn(),
}));

// The command-boundary cases use real remote-fs with an inert SSH transport.
vi.mock('../../../main/ssh-remote-manager', () => ({
	holdRemoteAccess: vi.fn().mockResolvedValue(null),
	remoteAccessRefusal: vi.fn(),
	sshRemoteManager: { buildSshArgs: vi.fn() },
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh-fixture'),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));

vi.mock('fs/promises', () => ({
	default: {
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { GrokSessionStorage } from '../../../main/storage/grok-session-storage';
import * as remoteFs from '../../../main/utils/remote-fs';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { REMOTE_SESSION_READ_CONCURRENCY } from '../../../main/utils/concurrency';
import type { SshRemoteConfig } from '../../../shared/types';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';

isolateAgentEnv(['GROK_HOME']);

// ============================================================================
// Fixtures
//
// Record shapes are derived from real captured Grok CLI sessions (see the
// Phase 02 research notes); paths and content are synthesized so nothing
// private lands in the repo.
// ============================================================================

const SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const PROJECT = '/Users/test/my-project';
const OTHER_PROJECT = '/Users/test/other-project';
const SESSION_ID = '019f0000-aaaa-7000-8000-000000000001';

const sshConfig: SshRemoteConfig = {
	id: 'r1',
	name: 'r1',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

/** summary.json content matching Grok's on-disk shape. */
function summaryJson(id: string, cwd: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		info: { id, cwd },
		session_summary: 'Create hello.txt File and Read Contents Back',
		generated_title: 'Create hello.txt File and Read Contents Back',
		created_at: '2026-07-09T17:44:28.000Z',
		updated_at: '2026-07-09T17:45:14.000Z',
		num_messages: 8,
		current_model_id: 'grok-4.5',
		...overrides,
	});
}

/**
 * A realistic chat_history.jsonl: system prompt, `<user_info>` environment
 * block, synthetic context injection, a real `<user_query>`-wrapped prompt,
 * reasoning, a tool call with its tool_result, and a final assistant reply.
 * Parses to 3 display messages (user, assistant+tool, assistant).
 */
function chatHistoryJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [
				{ type: 'text', text: '<user_info>\nOS Version: macos\nShell: /bin/zsh\n</user_info>' },
			],
		},
		{
			type: 'user',
			synthetic_reason: 'project_instructions',
			content: [
				{ type: 'text', text: '<system-reminder>\nProject instructions here.\n</system-reminder>' },
			],
		},
		{
			type: 'user',
			content: [
				{
					type: 'text',
					text: '<user_query>\nCreate a file named hello.txt containing the word hello, then read it back\n</user_query>',
				},
			],
		},
		{ type: 'reasoning', id: 'r1', status: 'completed', encrypted_content: 'opaque' },
		{
			type: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'call-1', name: 'write', arguments: '{"file_path":"hello.txt","contents":"hello"}' },
			],
		},
		{
			type: 'tool_result',
			tool_call_id: 'call-1',
			content: 'The file hello.txt has been created.',
		},
		{ type: 'assistant', content: 'Created `hello.txt` and read it back.' },
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** A never-prompted session: only system/environment/synthetic records. */
function neverPromptedJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
		},
		{
			type: 'user',
			synthetic_reason: 'system_reminder',
			content: [{ type: 'text', text: '<system-reminder>\nSkills available.\n</system-reminder>' }],
		},
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** Build the two on-disk files for one session under its percent-encoded cwd folder. */
function sessionFiles(
	cwd: string,
	sessionId: string,
	summary: string,
	chatHistory: string,
	sessionsDir = SESSIONS_DIR,
	join = path.join
): Record<string, string> {
	const dir = join(sessionsDir, encodeURIComponent(cwd), sessionId);
	return {
		[join(dir, 'summary.json')]: summary,
		[join(dir, 'chat_history.jsonl')]: chatHistory,
	};
}

/**
 * Wire the fs/promises mocks to serve a virtual file tree. Directories are
 * derived from file paths; anything else throws ENOENT like the real fs.
 */
function mockLocalFs(
	files: Record<string, string>,
	options: { sizeOverrides?: Record<string, number> } = {}
): void {
	// dir path -> child name -> isFile
	const children = new Map<string, Map<string, boolean>>();
	for (const filePath of Object.keys(files)) {
		let childPath = filePath;
		let isFile = true;
		for (;;) {
			const parent = path.dirname(childPath);
			if (parent === childPath) break;
			let entries = children.get(parent);
			if (!entries) {
				entries = new Map();
				children.set(parent, entries);
			}
			if (!entries.has(path.basename(childPath))) {
				entries.set(path.basename(childPath), isFile);
			}
			childPath = parent;
			isFile = false;
		}
	}

	const enoent = (p: string) =>
		Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: 'ENOENT' });

	vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
		const entries = children.get(String(dirPath));
		if (!entries) throw enoent(String(dirPath));
		return [...entries.entries()].map(([name, isFile]) => ({
			name,
			isDirectory: () => !isFile,
			isFile: () => isFile,
		})) as never;
	});

	vi.mocked(fs.stat).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		return {
			size: options.sizeOverrides?.[p] ?? Buffer.byteLength(files[p]),
			mtimeMs: 1_752_082_000_000,
		} as never;
	});

	vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		return files[p] as never;
	});
}

// ============================================================================
// Tests
// ============================================================================

describe('GrokSessionStorage - selected account scope', () => {
	const accounts = {
		default: path.dirname(SESSIONS_DIR),
		alpha: path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'alpha'),
		beta: path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'beta'),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		const files: Record<string, string> = {};
		for (const [label, root] of Object.entries(accounts)) {
			// Same cwd and native ID in every account. The unique search text is
			// after the initial exchange, so metadata alone cannot satisfy it.
			const history = [
				chatHistoryJsonl(),
				JSON.stringify({ type: 'user', content: `${label} follow-up request` }),
				JSON.stringify({ type: 'assistant', content: `${label} transcript-only answer` }),
			].join('\n');
			Object.assign(
				files,
				sessionFiles(
					PROJECT,
					SESSION_ID,
					summaryJson(SESSION_ID, PROJECT, { session_summary: `${label} account title` }),
					history,
					path.join(root, 'sessions')
				)
			);
		}
		mockLocalFs(files);
	});

	it.each([
		['provider default', undefined, undefined, undefined, 'default'],
		['empty ambient account', '', undefined, undefined, 'default'],
		['whitespace ambient account', ' \t ', undefined, undefined, 'default'],
		['ambient account', accounts.beta, undefined, undefined, 'beta'],
		['explicit alpha account', accounts.beta, undefined, accounts.alpha, 'alpha'],
		['explicit beta account', accounts.alpha, undefined, accounts.beta, 'beta'],
		['constructor account', accounts.beta, accounts.alpha, undefined, 'alpha'],
		['empty constructor account', accounts.beta, '', undefined, 'default'],
		['whitespace constructor account', accounts.beta, ' \t ', undefined, 'default'],
		['explicit override of constructor', accounts.alpha, accounts.alpha, accounts.beta, 'beta'],
		['explicit default account', accounts.beta, accounts.alpha, accounts.default, 'default'],
		['empty selection', accounts.beta, accounts.alpha, '', 'default'],
		['whitespace selection', accounts.beta, accounts.alpha, ' \t\n ', 'default'],
	] as const)(
		'keeps list, read, search and path consistent for %s',
		async (_name, hostRoot, boundRoot, selectedRoot, label) => {
			if (hostRoot !== undefined) process.env.GROK_HOME = hostRoot;
			const storage = new GrokSessionStorage(boundRoot);
			const sessionsDir = path.join(accounts[label], 'sessions');
			const transcriptPath = path.join(
				sessionsDir,
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			);

			const sessions = await storage.listSessions(PROJECT, undefined, selectedRoot);
			expect(sessions).toEqual([
				expect.objectContaining({
					sessionId: SESSION_ID,
					sessionName: `${label} account title`,
					messageCount: 5,
				}),
			]);
			expect(
				await storage.listSessionsPaginated(PROJECT, { configDir: selectedRoot, limit: 1 })
			).toEqual({ sessions, totalCount: 1, hasMore: false, nextCursor: null });
			expect(
				await storage.readSessionMessages(PROJECT, SESSION_ID, {
					configDir: selectedRoot,
					limit: 2,
				})
			).toMatchObject({
				messages: [
					{ role: 'user', content: `${label} follow-up request` },
					{ role: 'assistant', content: `${label} transcript-only answer` },
				],
				total: 5,
				hasMore: true,
			});
			expect(storage.getSessionPath(PROJECT, SESSION_ID, undefined, selectedRoot)).toBe(
				transcriptPath
			);

			for (const [mode, text] of [
				['title', 'account title'],
				['user', 'follow-up request'],
				['assistant', 'transcript-only answer'],
				['all', 'transcript-only answer'],
			] as const) {
				const results = await storage.searchSessions(
					PROJECT,
					`${label} ${text}`,
					mode,
					undefined,
					selectedRoot
				);
				expect(results).toEqual([
					expect.objectContaining({ sessionId: SESSION_ID, matchPreview: `${label} ${text}` }),
				]);
			}
			for (const other of Object.keys(accounts).filter((name) => name !== label)) {
				expect(
					await storage.searchSessions(PROJECT, `${other} `, 'all', undefined, selectedRoot)
				).toEqual([]);
			}

			expect(vi.mocked(fs.readFile).mock.calls.map(([file]) => String(file))).toContain(
				transcriptPath
			);
			for (const [file] of [
				...vi.mocked(fs.readdir).mock.calls,
				...vi.mocked(fs.stat).mock.calls,
				...vi.mocked(fs.readFile).mock.calls,
			]) {
				expect(
					String(file) === sessionsDir || String(file).startsWith(sessionsDir + path.sep)
				).toBe(true);
			}
			expect(remoteFs.readDirRemote).not.toHaveBeenCalled();
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			expect(remoteFs.statRemote).not.toHaveBeenCalled();
		}
	);

	it('isolates concurrent same-ID searches without changing the instance account', async () => {
		process.env.GROK_HOME = accounts.beta;
		const storage = new GrokSessionStorage(accounts.default);
		const results = await Promise.all(
			[accounts.alpha, accounts.beta, undefined].map((root) =>
				storage.searchSessions(PROJECT, 'transcript-only', 'assistant', undefined, root)
			)
		);
		expect(results).toEqual(
			['alpha', 'beta', 'default'].map((label) => [
				{
					sessionId: SESSION_ID,
					matchType: 'assistant',
					matchPreview: `${label} transcript-only answer`,
					matchCount: 1,
				},
			])
		);
		expect((await storage.listSessions(PROJECT))[0].sessionName).toBe('default account title');
	});

	it.each(['per-call', 'constructor'] as const)(
		'returns empty results for a missing %s account without reading available accounts',
		async (scope) => {
			process.env.GROK_HOME = accounts.beta;
			const missingRoot = path.join(path.dirname(accounts.alpha), 'missing');
			const storage = new GrokSessionStorage(
				scope === 'constructor' ? missingRoot : accounts.alpha
			);
			const selectedRoot = scope === 'per-call' ? missingRoot : undefined;

			expect(await storage.listSessions(PROJECT, undefined, selectedRoot)).toEqual([]);
			expect(await storage.listSessionsPaginated(PROJECT, { configDir: selectedRoot })).toEqual({
				sessions: [],
				totalCount: 0,
				hasMore: false,
				nextCursor: null,
			});
			expect(
				await storage.readSessionMessages(PROJECT, SESSION_ID, { configDir: selectedRoot })
			).toEqual({ messages: [], total: 0, hasMore: false });
			expect(
				await storage.searchSessions(PROJECT, 'account title', 'title', undefined, selectedRoot)
			).toEqual([]);
			expect(
				await storage.searchSessions(PROJECT, 'transcript-only', 'all', undefined, selectedRoot)
			).toEqual([]);
			// Path lookup is a synchronous guess, not proof that this account exists.
			expect(storage.getSessionPath(PROJECT, SESSION_ID, undefined, selectedRoot)).toBe(
				path.join(
					missingRoot,
					'sessions',
					encodeURIComponent(PROJECT),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			expect(fs.readdir).toHaveBeenCalled();
			for (const [dir] of vi.mocked(fs.readdir).mock.calls) {
				expect(dir).toBe(path.join(missingRoot, 'sessions'));
			}
			expect(fs.readFile).not.toHaveBeenCalled();
			expect(fs.stat).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);
});

describe('GrokSessionStorage - local listing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists sessions for the project and excludes other projects without opening their files', async () => {
		const otherId = '019f0000-aaaa-7000-8000-000000000002';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			...sessionFiles(
				OTHER_PROJECT,
				otherId,
				summaryJson(otherId, OTHER_PROJECT),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		expect(sessions[0].projectPath).toBe(PROJECT);
		// Project filtering happens on folder names - the foreign session's
		// files must never be opened.
		const readPaths = vi.mocked(fs.readFile).mock.calls.map((c) => String(c[0]));
		expect(readPaths.some((p) => p.includes(encodeURIComponent(OTHER_PROJECT)))).toBe(false);
	});

	it('exposes summary.json metadata: title, timestamps, preview, message count, zero tokens', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session.sessionName).toBe('Create hello.txt File and Read Contents Back');
		expect(session.timestamp).toBe('2026-07-09T17:44:28.000Z');
		expect(session.modifiedAt).toBe('2026-07-09T17:45:14.000Z');
		expect(session.durationSeconds).toBe(46);
		// Preview is the real prompt with the <user_query> wrapper stripped.
		expect(session.firstMessage).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
		expect(session.messageCount).toBe(3);
		// No usage.json (a 0.x session): zeros, not fabricated values.
		expect(session.inputTokens).toBe(0);
		expect(session.outputTokens).toBe(0);
		expect(session.costUsd).toBeUndefined();
	});

	it('reads session tokens and cost from usage.json (grok 1.x)', async () => {
		const dir = path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID);
		// Trimmed from a real 1.0.41 session after two turns. On disk inputTokens
		// INCLUDES cached reads (93742 = 19374 uncached + 74368 cached).
		const usageJson = JSON.stringify({
			sessionId: SESSION_ID,
			session: {
				inputTokens: 93742,
				outputTokens: 193,
				cachedReadTokens: 74368,
				cacheCreationTokens: 0,
				reasoningTokens: 107,
				costUsdTicks: 262106000,
				modelUsage: {
					'grok-4.7-build': {
						inputTokens: 93742,
						outputTokens: 193,
						cachedReadTokens: 74368,
						cacheCreationTokens: 0,
						costUsdTicks: 262106000,
					},
				},
			},
		});
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			[path.join(dir, 'usage.json')]: usageJson,
		});

		const [session] = await new GrokSessionStorage().listSessions(PROJECT);

		// Stream convention: input EXCLUDES cache reads, so the dashboard's
		// input + cacheRead does not count the cached tokens twice.
		expect(session).toMatchObject({
			inputTokens: 19374,
			outputTokens: 193,
			cacheReadTokens: 74368,
			cacheCreationTokens: 0,
		});
		expect(session.costUsd).toBeCloseTo(0.0262106, 10);
		expect(session.byModel).toEqual([
			{
				model: 'grok-4.7-build',
				inputTokens: 19374,
				outputTokens: 193,
				cacheReadTokens: 74368,
				cacheCreationTokens: 0,
				costUsd: expect.closeTo(0.0262106, 10),
				costEstimated: false,
			},
		]);
	});

	it('reads a cost-less usage.json (custom grok-compatible binary) as tokens with an unknown cost', async () => {
		const dir = path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID);
		// A grok-compatible custom binary that reports tokens but no cost writes this.
		const usageJson = JSON.stringify({
			sessionId: SESSION_ID,
			session: {
				inputTokens: 15364,
				outputTokens: 32,
				cachedReadTokens: 3200,
				cacheCreationTokens: 0,
				turnCount: 1,
			},
		});
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			[path.join(dir, 'usage.json')]: usageJson,
		});

		const [session] = await new GrokSessionStorage().listSessions(PROJECT);

		expect(session).toMatchObject({ inputTokens: 12164, outputTokens: 32, cacheReadTokens: 3200 });
		// Unknown, not $0: the dashboard then estimates it and flags it estimated.
		expect(session.costUsd).toBeUndefined();
		expect(session.byModel).toBeUndefined();
	});

	it.each([
		['/private/var/grok-test', '/var/grok-test'],
		['/private/tmp/grok-test', '/tmp/grok-test'],
		['/private/etc/grok-test', '/etc/grok-test'],
		['/var/grok-test', '/private/var/grok-test'],
		['/tmp/grok-test', '/private/tmp/grok-test'],
		['/etc/grok-test', '/private/etc/grok-test'],
	])('matches local recorded cwd %s through alias %s', async (recordedCwd, projectPath) => {
		mockLocalFs(
			sessionFiles(
				recordedCwd,
				SESSION_ID,
				summaryJson(SESSION_ID, recordedCwd),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
	});

	it('includes sessions whose recorded cwd is a subdirectory of the project path', async () => {
		const subdirCwd = `${PROJECT}/packages/app`;
		mockLocalFs(
			sessionFiles(subdirCwd, SESSION_ID, summaryJson(SESSION_ID, subdirCwd), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		// A sibling project sharing the prefix must NOT match.
		expect(await storage.listSessions('/Users/test/my-proj')).toEqual([]);
	});

	it('returns an empty list when the sessions directory does not exist', async () => {
		mockLocalFs({}); // no files: readdir on the base dir throws ENOENT

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});

	it('excludes never-prompted sessions that contain only system/synthetic records', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), neverPromptedJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
	});

	it('skips a session with malformed summary.json without throwing, keeping good sessions', async () => {
		const goodId = '019f0000-aaaa-7000-8000-000000000003';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, 'not valid json {', chatHistoryJsonl()),
			...sessionFiles(PROJECT, goodId, summaryJson(goodId, PROJECT), chatHistoryJsonl()),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([goodId]);
	});

	it('tolerates malformed transcript lines (live-write partial line) without throwing', async () => {
		// Grok appends while running, so a live session can end mid-record.
		const truncated = `${chatHistoryJsonl()}\n{"type":"assistant","content":"cut off mid-wri`;
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), truncated));

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].messageCount).toBe(3);
	});

	it('sorts sessions newest-first by modifiedAt', async () => {
		const olderId = '019f0000-aaaa-7000-8000-00000000000a';
		const newerId = '019f0000-aaaa-7000-8000-00000000000b';
		mockLocalFs({
			...sessionFiles(
				PROJECT,
				olderId,
				summaryJson(olderId, PROJECT, { updated_at: '2026-07-08T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
			...sessionFiles(
				PROJECT,
				newerId,
				summaryJson(newerId, PROJECT, { updated_at: '2026-07-09T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([newerId, olderId]);
	});

	it('skips sessions whose transcript exceeds the 100MB read budget without reading it', async () => {
		const files = sessionFiles(
			PROJECT,
			SESSION_ID,
			summaryJson(SESSION_ID, PROJECT),
			chatHistoryJsonl()
		);
		const transcriptPath = Object.keys(files).find((p) => p.endsWith('chat_history.jsonl'))!;
		mockLocalFs(files, { sizeOverrides: { [transcriptPath]: 200 * 1024 * 1024 } });

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		const readPaths = vi.mocked(fs.readFile).mock.calls.map((c) => String(c[0]));
		expect(readPaths).not.toContain(transcriptPath);
	});
});

describe('GrokSessionStorage - reading messages', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('maps transcript records to display messages, merging tool_result into the tool call', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(false);
		const [user, toolTurn, reply] = result.messages;

		// The <user_query> wrapper is stripped; synthetic/system/reasoning
		// records never surface.
		expect(user.role).toBe('user');
		expect(user.content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);

		expect(toolTurn.role).toBe('assistant');
		const toolUse = toolTurn.toolUse as Array<{
			tool?: string;
			state: { status: string; input?: unknown; output?: string };
		}>;
		expect(toolUse).toHaveLength(1);
		expect(toolUse[0].tool).toBe('write');
		expect(toolUse[0].state.status).toBe('completed');
		expect(toolUse[0].state.input).toEqual({ file_path: 'hello.txt', contents: 'hello' });
		expect(toolUse[0].state.output).toBe('The file hello.txt has been created.');

		expect(reply.role).toBe('assistant');
		expect(reply.content).toBe('Created `hello.txt` and read it back.');
	});

	it('joins multiple <user_query> wrappers in a single user turn', async () => {
		const multiWrapperHistory = [
			{
				type: 'user',
				content: [
					{
						type: 'text',
						text: '<user_query>\nFirst block\n</user_query>\n\n<preamble>\nignored\n</preamble>\n\n<user_query>\nSecond block\n</user_query>',
					},
				],
			},
			{ type: 'assistant', content: 'ok' },
		]
			.map((record) => JSON.stringify(record))
			.join('\n');

		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), multiWrapperHistory)
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result.messages[0].content).toBe('First block\n\nSecond block');
	});

	it('returns an empty result for a session owned by a different project (ownership guard)', async () => {
		mockLocalFs(
			sessionFiles(
				OTHER_PROJECT,
				SESSION_ID,
				summaryJson(SESSION_ID, OTHER_PROJECT),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result).toEqual({ messages: [], total: 0, hasMore: false });
	});

	it('paginates from the end of the transcript', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2 });

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(true);
		expect(result.messages).toHaveLength(2);
		// Most recent messages come back: the tool turn and the final reply.
		expect(result.messages[1].content).toBe('Created `hello.txt` and read it back.');
	});
});

describe('GrokSessionStorage - SSH remote', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(remoteFs.readDirRemote).mockReset();
		vi.mocked(remoteFs.readFileRemote).mockReset();
		vi.mocked(remoteFs.statRemote).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		expect(fs.readdir).not.toHaveBeenCalled();
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(fs.stat).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	const encodedProject = encodeURIComponent(PROJECT);

	/** Exact fake remote paths: unknown accounts/files cannot borrow fixture content. */
	function mockRemoteSession({ accountDir = '~/.grok', cwd = PROJECT, ids = [SESSION_ID] } = {}) {
		const sessionsDir = path.posix.join(accountDir, 'sessions');
		const cwdDir = path.posix.join(sessionsDir, encodeURIComponent(cwd));
		const directories = new Map<string, remoteFs.RemoteDirEntry[]>([
			[sessionsDir, [{ name: encodeURIComponent(cwd), isDirectory: true, isSymlink: false }]],
			[cwdDir, ids.map((name) => ({ name, isDirectory: true, isSymlink: false }))],
		]);
		const files: Record<string, string> = Object.assign(
			{},
			...ids.map((id) =>
				sessionFiles(
					cwd,
					id,
					summaryJson(id, cwd),
					chatHistoryJsonl(),
					sessionsDir,
					path.posix.join
				)
			)
		);
		vi.mocked(remoteFs.readDirRemote).mockImplementation(async (dirPath: string) => {
			if (directories.has(dirPath)) return { success: true, data: directories.get(dirPath) };
			return { success: false, error: 'Directory not found or not accessible' };
		});
		vi.mocked(remoteFs.statRemote).mockImplementation(async (filePath) => {
			if (!(filePath in files)) return { success: false, error: 'No such file' };
			return {
				success: true,
				data: {
					size: Buffer.byteLength(files[filePath]),
					isDirectory: false,
					mtime: 1_752_082_000_000,
				},
			};
		});
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath in files) return { success: true, data: files[filePath] };
			return { success: false, error: 'No such file' };
		});
		return { sessionsDir, cwdDir, directories, files };
	}

	it.each([undefined, '', ' \t ', '/srv/Grok accounts/研究', "~/O'Brien/研究", '~'])(
		'keeps all remote operations scoped to account %j, ignoring the local environment',
		async (accountDir) => {
			process.env.GROK_HOME = path.resolve('src/__tests__/fixtures/grok-accounts/local-decoy');
			const cwd = "/remote/研究/O'Brien project";
			const root = accountDir?.trim() || '~/.grok';
			const { sessionsDir, cwdDir } = mockRemoteSession({ accountDir: root, cwd });
			const storage = new GrokSessionStorage();
			const sessions = await storage.listSessions(cwd, sshConfig, accountDir);
			expect(sessions).toEqual([
				expect.objectContaining({ sessionId: SESSION_ID, projectPath: cwd }),
			]);
			expect(
				await storage.listSessionsPaginated(cwd, { configDir: accountDir }, sshConfig)
			).toMatchObject({ sessions, totalCount: 1 });
			expect(
				await storage.readSessionMessages(cwd, SESSION_ID, { configDir: accountDir }, sshConfig)
			).toMatchObject({ total: 3 });
			expect(
				await storage.searchSessions(cwd, 'Created', 'assistant', sshConfig, accountDir)
			).toEqual([expect.objectContaining({ sessionId: SESSION_ID, matchType: 'assistant' })]);
			expect(storage.getSessionPath(cwd, SESSION_ID, sshConfig, accountDir)).toBe(
				path.posix.join(cwdDir, SESSION_ID, 'chat_history.jsonl')
			);
			for (const [file, config] of [
				...vi.mocked(remoteFs.readDirRemote).mock.calls,
				...vi.mocked(remoteFs.readFileRemote).mock.calls,
				...vi.mocked(remoteFs.statRemote).mock.calls,
			]) {
				expect(file === sessionsDir || file.startsWith(sessionsDir + '/')).toBe(true);
				expect(config).toBe(sshConfig);
			}
		}
	);

	it('does not fall back to available default history when the chosen remote account is absent', async () => {
		mockRemoteSession();
		const storage = new GrokSessionStorage('~/missing account');
		expect(await storage.listSessions(PROJECT, sshConfig)).toEqual([]);
		expect(await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig)).toEqual({
			messages: [],
			total: 0,
			hasMore: false,
		});
		expect(await storage.searchSessions(PROJECT, 'Created', 'all', sshConfig)).toEqual([]);
		expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		expect(remoteFs.statRemote).not.toHaveBeenCalled();
		for (const [dir] of vi.mocked(remoteFs.readDirRemote).mock.calls) {
			expect(dir).toBe('~/missing account/sessions');
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('rejects malformed cwd folders before joins, retaining lowercase encoded slashes and descendants', async () => {
		const cwd = '/remote/project/sub';
		const fixture = mockRemoteSession({ cwd });
		const valid = encodeURIComponent(cwd).replace(/%2F/g, '%2f');
		fixture.directories.set(
			path.posix.join(fixture.sessionsDir, valid),
			fixture.directories.get(fixture.cwdDir)!
		);
		for (const [file, content] of Object.entries(fixture.files)) {
			fixture.files[file.replace(encodeURIComponent(cwd), valid)] = content;
		}
		const rejected = [
			'',
			'.',
			'..',
			'raw/slash',
			'raw\\slash',
			'\0',
			'%',
			'%2',
			'%GG',
			'%C0%AF',
			'%ED%A0%80',
			'%2Fremote%2Fproject%2F..%2Foutside',
			'%2Fremote%2Fproject%2F.%2Fsub',
			'%2Fremote%2Fproject%5C..%5Coutside',
			'%2Fremote%2Fproject%00',
			encodeURIComponent('/remote/project-sibling'),
		];
		fixture.directories.set(
			fixture.sessionsDir,
			[...rejected, valid].map((name) => ({
				name,
				isDirectory: true,
				isSymlink: false,
			}))
		);
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions('/remote/project/', sshConfig)).toEqual([
			expect.objectContaining({ sessionId: SESSION_ID, projectPath: cwd }),
		]);
		expect(
			await storage.readSessionMessages('/remote/project', SESSION_ID, undefined, sshConfig)
		).toMatchObject({ total: 3 });
		for (const [dir] of vi.mocked(remoteFs.readDirRemote).mock.calls) {
			expect([fixture.sessionsDir, path.posix.join(fixture.sessionsDir, valid)]).toContain(dir);
		}
		for (const [file] of [
			...vi.mocked(remoteFs.readFileRemote).mock.calls,
			...vi.mocked(remoteFs.statRemote).mock.calls,
		]) {
			expect(file.startsWith(path.posix.join(fixture.sessionsDir, valid, SESSION_ID) + '/')).toBe(
				true
			);
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('filters traversal entries but retains opaque IDs and directory identity when summaries disagree', async () => {
		const ids = ['not-a-uuid', 'native..id', '%2F..%2Fopaque'];
		const fixture = mockRemoteSession({ ids });
		fixture.directories.get(fixture.cwdDir)!.push(
			...['', '.', '..', '../outside', 'nested/id', 'nested\\id', 'bad\0id'].map((name) => ({
				name,
				isDirectory: true,
				isSymlink: false,
			}))
		);
		for (const id of ids)
			fixture.files[path.posix.join(fixture.cwdDir, id, 'summary.json')] = summaryJson(
				'../redirected',
				OTHER_PROJECT
			);
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions(PROJECT, sshConfig)).toEqual(
			ids.map((sessionId) => expect.objectContaining({ sessionId, projectPath: PROJECT }))
		);
		expect(
			(await storage.searchSessions(PROJECT, 'Created', 'assistant', sshConfig)).map(
				(s) => s.sessionId
			)
		).toEqual(ids);
		for (const id of ids) {
			expect(await storage.readSessionMessages(PROJECT, id, undefined, sshConfig)).toMatchObject({
				total: 3,
			});
			expect(storage.getSessionPath(PROJECT, id, sshConfig)).toBe(
				path.posix.join(fixture.cwdDir, id, 'chat_history.jsonl')
			);
		}
		for (const [file] of [
			...vi.mocked(remoteFs.readFileRemote).mock.calls,
			...vi.mocked(remoteFs.statRemote).mock.calls,
		]) {
			expect(
				Object.keys(fixture.files).includes(file) ||
					ids.some((id) => file === path.posix.join(fixture.cwdDir, id, 'usage.json'))
			).toBe(true);
		}
	});

	it.each(['/var/project', '/tmp/project', '/etc/project'])(
		'keeps remote %s distinct from /private while accepting POSIX root descendants',
		async (cwd) => {
			mockRemoteSession({ cwd: `/private${cwd}` });
			const storage = new GrokSessionStorage();
			expect(await storage.listSessions(cwd, sshConfig)).toEqual([]);
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			expect(await storage.listSessions(`/private${cwd}/`, sshConfig)).toHaveLength(1);
			expect(await storage.listSessions('/', sshConfig)).toHaveLength(1);
		}
	);

	it('follows remote directory symlinks but ignores file and unresolved symlinks', async () => {
		const { directories } = mockRemoteSession();
		for (const entries of directories.values()) {
			entries[0].isSymlink = true;
			entries.push({ name: 'unresolved-link', isDirectory: false, isSymlink: true });
		}
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions(PROJECT, sshConfig)).toHaveLength(1);
		expect(
			await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig)
		).toMatchObject({ total: 3 });
		for (const [file] of vi.mocked(remoteFs.readDirRemote).mock.calls)
			expect(file).not.toContain('unresolved-link');
	});

	it.each(['readDirRemote', 'statRemote', 'readFileRemote'] as const)(
		'classifies expected misses and disconnects at %s without local fallback',
		async (method) => {
			for (const error of ['No such file', 'Permission denied', 'ssh connection reset by peer']) {
				vi.clearAllMocks();
				mockRemoteSession();
				vi.mocked(remoteFs[method]).mockResolvedValue({ success: false, error });
				expect(await new GrokSessionStorage().listSessions(PROJECT, sshConfig)).toEqual([]);
				if (error.includes('connection reset')) {
					const operation = {
						readDirRemote: 'listCwdFolders',
						statRemote: 'statSessionFile',
						readFileRemote: 'readSessionFile',
					}[method];
					expect(captureException).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({ message: error }),
						expect.objectContaining({ operation: `grokStorage:${operation}` })
					);
					expect(logger.warn).toHaveBeenCalledWith(
						expect.stringContaining(error),
						'[GrokSessionStorage]'
					);
				} else expect(captureException).not.toHaveBeenCalled();
				expect(fs.readdir).not.toHaveBeenCalled();
				expect(fs.readFile).not.toHaveBeenCalled();
				expect(fs.stat).not.toHaveBeenCalled();
				expect(execFileNoThrow).not.toHaveBeenCalled();
			}
		}
	);

	it('bounds concurrent remote reads and drains every session without dropping results', async () => {
		vi.useFakeTimers();
		const ids = Array.from(
			{ length: REMOTE_SESSION_READ_CONCURRENCY * 3 + 1 },
			(_, i) => `native-${i}`
		);
		mockRemoteSession({ ids });
		const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
		let active = 0;
		let peak = 0;
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return await read(...args);
			} finally {
				active--;
			}
		});
		const result = new GrokSessionStorage().listSessions(PROJECT, sshConfig);
		await vi.runAllTimersAsync();
		expect((await result).map((s) => s.sessionId)).toEqual(ids);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(REMOTE_SESSION_READ_CONCURRENCY);
		expect(active).toBe(0);
		expect(remoteFs.statRemote).toHaveBeenCalledTimes(ids.length);
		expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(ids.length * 3);
	});

	it.each([
		[
			"/srv/O'Brien/研究 $cash;$(probe)",
			"'/srv/O'\\''Brien/研究 $cash;$(probe)'",
			'native $(probe);id',
		],
		[
			"~/O'Brien/研究 $cash;$(probe)",
			'"$HOME/O\'Brien/研究 \\$cash;\\$(probe)"',
			'native \\$(probe);id',
		],
	])(
		'quotes every path passed to the real remote-fs transport for %s',
		async (accountDir, escapedRoot, escapedId) => {
			const actual = await vi.importActual<typeof remoteFs>('../../../main/utils/remote-fs');
			const id = 'native $(probe);id';
			const cwd = '/remote/研究 project';
			const encoded = encodeURIComponent(cwd);
			// These shell tokens are independently specified, never produced by the escaper under test.
			const commands = new Map<string, string | undefined>();
			for (const [suffix, stdout] of [
				['sessions', `${encoded}/\n__SYMDIR__\n`],
				[`sessions/${encoded}`, `${id}@\n__SYMDIR__\n${id}\n`],
				[`sessions/${encoded}/${escapedId}/summary.json`, summaryJson(id, cwd)],
				[`sessions/${encoded}/${escapedId}/chat_history.jsonl`, chatHistoryJsonl()],
				[`sessions/${encoded}/${escapedId}/usage.json`, undefined],
			] as const) {
				const token = `${escapedRoot.slice(0, -1)}/${suffix}${escapedRoot.slice(-1)}`;
				if (!suffix.includes(escapedId)) {
					commands.set(
						`ls -1AF --color=never ${token} 2>/dev/null || echo "__LS_ERROR__"; echo "__SYMDIR__"; find ${token} -mindepth 1 -maxdepth 1 -type l -exec test -d {} \\; -exec basename {} \\; 2>/dev/null`,
						stdout
					);
				} else {
					commands.set(`cat ${token}`, stdout);
					if (suffix.endsWith('chat_history.jsonl'))
						commands.set(
							`stat --printf='%s\\n%F\\n%Y' ${token} 2>/dev/null || stat -f $'%z\\n%HT\\n%m' ${token}`,
							'2048\nregular file\n1752082000'
						);
				}
			}
			const deps: remoteFs.RemoteFsDeps = {
				buildSshArgs: () => ['fixture@host'],
				execSsh: vi.fn(async (binary, args) => {
					expect(binary).toBe('ssh-fixture');
					expect(args).toHaveLength(2);
					expect(args[0]).toBe('fixture@host');
					expect(commands.has(args[1])).toBe(true);
					const stdout = commands.get(args[1]);
					return {
						stdout: stdout ?? '',
						stderr: stdout === undefined ? 'No such file' : '',
						exitCode: stdout === undefined ? 1 : 0,
					};
				}),
			};
			vi.mocked(remoteFs.readDirRemote).mockImplementation((file, config) =>
				actual.readDirRemote(file, config, deps)
			);
			vi.mocked(remoteFs.readFileRemote).mockImplementation((file, config) =>
				actual.readFileRemote(file, config, deps)
			);
			vi.mocked(remoteFs.statRemote).mockImplementation((file, config) =>
				actual.statRemote(file, config, deps)
			);
			expect(await new GrokSessionStorage(accountDir).listSessions(cwd, sshConfig)).toEqual([
				expect.objectContaining({ sessionId: id, projectPath: cwd, messageCount: 3 }),
			]);
			expect(deps.execSsh).toHaveBeenCalledTimes(6);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('lists and reads sessions on a remote host via remote-fs', async () => {
		mockRemoteSession();

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		// No local fs access on the remote path.
		expect(vi.mocked(fs.readdir)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();

		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);
		expect(result.total).toBe(3);
		expect(result.messages[0].content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
	});

	it('returns an empty list when the remote sessions directory does not exist, without reporting', async () => {
		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: false,
			error: 'Directory not found or not accessible',
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toEqual([]);
		expect(vi.mocked(remoteFs.readFileRemote)).not.toHaveBeenCalled();
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});

	it('reports unexpected remote stat failures to Sentry when reading messages', async () => {
		vi.mocked(remoteFs.readDirRemote).mockImplementation(async (dirPath: string) => {
			if (dirPath === '~/.grok/sessions') {
				return {
					success: true,
					data: [{ name: encodedProject, isDirectory: true, isSymlink: false }],
				};
			}
			if (dirPath === `~/.grok/sessions/${encodedProject}`) {
				return {
					success: true,
					data: [{ name: SESSION_ID, isDirectory: true, isSymlink: false }],
				};
			}
			return { success: false, error: 'Directory not found or not accessible' };
		});
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath.endsWith('/summary.json')) {
				return { success: true, data: summaryJson(SESSION_ID, PROJECT) };
			}
			return { success: false, error: 'No such file' };
		});
		vi.mocked(remoteFs.statRemote).mockResolvedValue({
			success: false,
			error: 'ssh connection reset by peer',
		});

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);

		expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		expect(vi.mocked(captureException)).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('connection reset') }),
			expect.objectContaining({ operation: 'grokStorage:statSessionFile' })
		);
	});
});

describe('GrokSessionStorage - misc contract', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('reports message-pair deletion as unsupported', async () => {
		const storage = new GrokSessionStorage();
		const result = await storage.deleteMessagePair(PROJECT, SESSION_ID, 'grok-msg-0');

		expect(result.success).toBe(false);
		expect(result.error).toContain('not supported');
	});

	it('getSessionPath returns the encoded-cwd transcript path guess', async () => {
		const storage = new GrokSessionStorage();
		const sessionPath = storage.getSessionPath(PROJECT, SESSION_ID);

		expect(sessionPath).toBe(
			path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'chat_history.jsonl')
		);
	});

	describe('getSessionPath symlink-prefix handling', () => {
		const originalPlatform = process.platform;

		function setPlatform(value: string) {
			Object.defineProperty(process, 'platform', { value, configurable: true });
		}

		afterEach(() => {
			setPlatform(originalPlatform);
		});

		it('expands macOS /var|/tmp|/etc to the /private realpath form Grok records', () => {
			setPlatform('darwin');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/tmp/grok-test', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			expect(storage.getSessionPath('/var/folders/x/T', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/var/folders/x/T'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			// Already-realpath'd input passes through unchanged.
			expect(storage.getSessionPath('/private/tmp/grok-test', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			// Trailing slashes are stripped before encoding.
			expect(storage.getSessionPath('/tmp/grok-test/', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});

		it('leaves /var paths untouched on Linux, where /var is a real directory', () => {
			setPlatform('linux');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/var/www/app', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/var/www/app'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});

		it('leaves remote paths untouched regardless of the local platform', () => {
			setPlatform('darwin');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/tmp/remote-proj', SESSION_ID, sshConfig)).toBe(
				path.posix.join(
					'~/.grok/sessions',
					encodeURIComponent('/tmp/remote-proj'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});
	});

	it.each(['', '.', '..', '../other-project', 'foo/bar', 'foo\\bar', 'bad\0id'])(
		'rejects unsafe session ID %j before any local or remote filesystem access',
		async (id) => {
			const storage = new GrokSessionStorage();
			for (const config of [undefined, sshConfig]) {
				expect(storage.getSessionPath(PROJECT, id, config)).toBeNull();
				expect(await storage.readSessionMessages(PROJECT, id, undefined, config)).toEqual({
					messages: [],
					total: 0,
					hasMore: false,
				});
			}
			for (const operation of [
				fs.readdir,
				fs.readFile,
				fs.stat,
				remoteFs.readDirRemote,
				remoteFs.readFileRemote,
				remoteFs.statRemote,
			])
				expect(operation).not.toHaveBeenCalled();
		}
	);

	it.each(['/project/../other', '/project/./child', '/project\0', '/project/\ud800'])(
		'refuses malformed project path guesses: %j',
		(cwd) => {
			for (const config of [undefined, sshConfig]) {
				expect(new GrokSessionStorage().getSessionPath(cwd, SESSION_ID, config)).toBeNull();
			}
		}
	);

	it('getSessionPath honors GROK_HOME for the local sessions root', () => {
		const accountDir = path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'custom');
		process.env.GROK_HOME = accountDir;
		const storage = new GrokSessionStorage();
		expect(storage.getSessionPath(PROJECT, SESSION_ID)).toBe(
			path.join(
				accountDir,
				'sessions',
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			)
		);
	});
});
