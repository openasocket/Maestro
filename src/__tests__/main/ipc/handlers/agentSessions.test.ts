/**
 * Tests for the agentSessions IPC handlers
 *
 * These tests verify the generic agent session management API that works
 * with any agent supporting the AgentSessionStorage interface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';
import {
	registerAgentSessionsHandlers,
	isExpectedSessionReadError,
} from '../../../../main/ipc/handlers/agentSessions';
import * as agentSessionStorage from '../../../../main/agents';
import {
	GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
	GLOBAL_STATS_CACHE_VERSION,
	loadGlobalStatsCache,
	saveGlobalStatsCache,
} from '../../../../main/utils/statsCache';
import os from 'os';
import path from 'path';
import { promises as realFs } from 'fs';
import { getLiveSessions, getSshRemoteById } from '../../../../main/stores';
import * as mirrors from '../../../../main/storage/starred-transcript-mirror';
import { createMockSession } from '../../../helpers/mockSession';

const accountStores = vi.hoisted(() => ({
	provider: {} as Record<string, string>,
	global: {} as Record<string, string>,
}));

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock the agents module (session storage exports)
vi.mock('../../../../main/agents', () => ({
	getSessionStorage: vi.fn(),
	hasSessionStorage: vi.fn(),
	getAllSessionStorages: vi.fn(),
}));

// Keep account resolution real, with only its stores replaced by inert inputs.
vi.mock('../../../../main/stores', () => ({
	getSshRemoteById: vi.fn().mockReturnValue(undefined),
	getLiveSessions: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../../../main/stores/getters', () => ({
	getAgentConfigsStore: () => ({
		get: () => ({ grok: { customEnvVars: accountStores.provider } }),
	}),
	getSettingsStore: () => ({ get: () => accountStores.global }),
}));
vi.mock('../../../../main/storage/starred-transcript-mirror', () => ({
	restoreStarredTranscript: vi.fn().mockResolvedValue(false),
	snapshotStarredTranscript: vi.fn(),
	releaseTranscriptMirror: vi.fn(),
	releaseSnoozedTranscriptMirror: vi.fn(),
	listMirroredStarredSessions: vi.fn().mockResolvedValue([]),
}));

// The global stats scan reads and writes a cache under userData; start cold
// and discard writes so a test only ever sees the transcripts it created.
vi.mock('../../../../main/utils/statsCache', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/utils/statsCache')>()),
	loadGlobalStatsCache: vi.fn().mockResolvedValue(null),
	saveGlobalStatsCache: vi.fn().mockResolvedValue(undefined),
}));

// Mock the logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('agentSessions IPC handlers', () => {
	let handlers: Map<string, (...args: any[]) => any>;

	beforeEach(() => {
		// Clear mocks
		vi.clearAllMocks();
		vi.mocked(getLiveSessions).mockReset().mockReturnValue([]);
		vi.mocked(getSshRemoteById).mockReset().mockReturnValue(undefined);
		accountStores.provider = {};
		accountStores.global = {};

		// Capture all registered handlers
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});

		// Register handlers
		registerAgentSessionsHandlers();
	});

	afterEach(() => {
		handlers.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe('registration', () => {
		it('should register all agentSessions handlers', () => {
			const expectedChannels = [
				'agentSessions:list',
				'agentSessions:listPaginated',
				'agentSessions:read',
				'agentSessions:search',
				'agentSessions:getPath',
				'agentSessions:deleteMessagePair',
				'agentSessions:hasStorage',
				'agentSessions:getAvailableStorages',
			];

			for (const channel of expectedChannels) {
				expect(handlers.has(channel)).toBe(true);
			}
		});
	});

	describe('agentSessions:list', () => {
		it('should return sessions from storage', async () => {
			const mockSessions = [
				{ sessionId: 'session-1', projectPath: '/test', firstMessage: 'Hello' },
				{ sessionId: 'session-2', projectPath: '/test', firstMessage: 'Hi' },
			];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'claude-code', '/test');

			expect(mockStorage.listSessions).toHaveBeenCalledWith('/test', undefined);
			expect(result).toEqual(mockSessions);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:list');
			const result = await handler!({} as any, 'unknown-agent', '/test');

			expect(result).toEqual([]);
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockSessions = [{ sessionId: 'session-1', projectPath: '/test' }];

			const mockStorage = {
				agentId: 'claude-code',
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:list');
			await expect(handler!({} as any, 'claude-code', '/test', 'ssh-remote-1')).rejects.toThrow(
				/History SSH target unavailable/
			);
			expect(mockStorage.listSessions).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:listPaginated', () => {
		it('should return paginated sessions from storage', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: true,
				totalCount: 50,
				nextCursor: 'session-1',
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'claude-code', '/test', { limit: 10 });

			expect(mockStorage.listSessionsPaginated).toHaveBeenCalledWith(
				'/test',
				{ limit: 10 },
				undefined
			);
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:listPaginated');
			const result = await handler!({} as any, 'unknown-agent', '/test', {});

			expect(result).toEqual({
				sessions: [],
				hasMore: false,
				totalCount: 0,
				nextCursor: null,
			});
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResult = {
				sessions: [{ sessionId: 'session-1' }],
				hasMore: false,
				totalCount: 1,
				nextCursor: null,
			};

			const mockStorage = {
				agentId: 'claude-code',
				listSessionsPaginated: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:listPaginated');
			await expect(
				handler!({} as any, 'claude-code', '/test', { limit: 10 }, 'ssh-remote-1')
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.listSessionsPaginated).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:read', () => {
		it('should return session messages from storage', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 10,
				hasMore: true,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1', {
				offset: 0,
				limit: 20,
			});

			expect(mockStorage.readSessionMessages).toHaveBeenCalledWith(
				'/test',
				'session-1',
				{
					offset: 0,
					limit: 20,
				},
				undefined
			);
			expect(mirrors.restoreStarredTranscript).toHaveBeenCalledExactlyOnceWith({
				agentId: 'claude-code',
				projectPath: '/test',
				sessionId: 'session-1',
			});
			expect(result).toEqual(mockResult);
		});

		it('should return empty result when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:read');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', {});

			expect(result).toEqual({ messages: [], total: 0, hasMore: false });
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResult = {
				messages: [{ type: 'user', content: 'Hello' }],
				total: 1,
				hasMore: false,
			};

			const mockStorage = {
				agentId: 'claude-code',
				readSessionMessages: vi.fn().mockResolvedValue(mockResult),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:read');
			await expect(
				handler!(
					{} as any,
					'claude-code',
					'/test',
					'session-1',
					{ offset: 0, limit: 20 },
					'ssh-remote-1'
				)
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.readSessionMessages).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:search', () => {
		it('should return search results from storage', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'claude-code', '/test', 'hello', 'all');

			expect(mockStorage.searchSessions).toHaveBeenCalledWith('/test', 'hello', 'all', undefined);
			expect(result).toEqual(mockResults);
		});

		it('should return empty array when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:search');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'hello', 'all');

			expect(result).toEqual([]);
		});

		it('refuses a missing SSH remote instead of reading local history', async () => {
			const mockResults = [
				{
					sessionId: 'session-1',
					matchType: 'title' as const,
					matchPreview: 'Hello...',
					matchCount: 1,
				},
			];

			const mockStorage = {
				agentId: 'claude-code',
				searchSessions: vi.fn().mockResolvedValue(mockResults),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:search');
			await expect(
				handler!({} as any, 'claude-code', '/test', 'hello', 'all', 'ssh-remote-1')
			).rejects.toThrow(/History SSH target unavailable/);
			expect(mockStorage.searchSessions).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:getPath', () => {
		it('should return session path from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				getSessionPath: vi.fn().mockReturnValue('/path/to/session.jsonl'),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'claude-code', '/test', 'session-1');

			expect(mockStorage.getSessionPath).toHaveBeenCalledWith('/test', 'session-1');
			expect(result).toBe('/path/to/session.jsonl');
		});

		it('should return null when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:getPath');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1');

			expect(result).toBe(null);
		});
	});

	describe.each([
		{ api: 'list', method: 'listSessions', args: [], options: undefined },
		{
			api: 'listPaginated',
			method: 'listSessionsPaginated',
			args: [],
			options: { cursor: 'previous', limit: 2 },
		},
		{
			api: 'read',
			method: 'readSessionMessages',
			args: ['native-collision'],
			options: { offset: 1, limit: 2, includeNativeRecords: true },
		},
		{ api: 'search', method: 'searchSessions', args: ['needle', 'all'], options: undefined },
		{ api: 'getPath', method: 'getSessionPath', args: ['native-collision'], options: undefined },
	] as const)('Grok history scope: $api', ({ api, method, args, options }) => {
		const home = path.resolve('tmp/grok-history-ipc/home');
		const remote = {
			id: 'remote-a',
			name: 'A',
			host: 'a.invalid',
			port: 22,
			username: 'fixture',
			privateKeyPath: '',
			enabled: true,
		};
		let owner: ReturnType<typeof getLiveSessions>[number];
		let storage: Record<string, ReturnType<typeof vi.fn>>;
		const invoke = (ownerAgentId: unknown = 'owner', sshRemoteId?: unknown) =>
			handlers.get(`agentSessions:${api}`)!(
				{},
				'grok',
				'/project',
				...args,
				...(options ? [{ ...options, ownerAgentId }, sshRemoteId] : [sshRemoteId, ownerAgentId])
			);

		const expectScope = (configDir?: string, target?: ReturnType<typeof getSshRemoteById>) =>
			expect(storage[method]).toHaveBeenCalledExactlyOnceWith(
				'/project',
				...args,
				...(options ? [{ ...options, configDir }, target] : [target, configDir])
			);

		beforeEach(() => {
			vi.spyOn(os, 'homedir').mockReturnValue(home);
			vi.stubEnv('GROK_HOME', path.join(home, 'process-account'));
			owner = { ...createMockSession({ id: 'owner', toolType: 'grok' }) };
			vi.mocked(getLiveSessions).mockImplementation(() => [owner]);
			vi.mocked(getSshRemoteById).mockImplementation((id) =>
				id === remote.id ? remote : undefined
			);
			storage = {
				listSessions: vi.fn().mockResolvedValue([]),
				listSessionsPaginated: vi
					.fn()
					.mockResolvedValue({ sessions: [], totalCount: 0, hasMore: false, nextCursor: null }),
				readSessionMessages: vi.fn().mockResolvedValue({ messages: [], total: 0, hasMore: false }),
				searchSessions: vi.fn().mockResolvedValue([]),
				getSessionPath: vi.fn().mockReturnValue(null),
			};
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				storage as unknown as agentSessionStorage.AgentSessionStorage
			);
		});

		afterEach(() => {
			for (const mirror of Object.values(mirrors)) expect(mirror).not.toHaveBeenCalled();
		});

		it.each([false, true])(
			'keeps colliding native IDs in their selected accounts/hosts (SSH=%s)',
			async (ssh) => {
				const owners = ['a', 'b'].map((suffix) => ({
					...owner,
					id: `owner-${suffix}`,
					customEnvVars: { GROK_HOME: ssh ? `~/Grok ${suffix}/账户` : path.join(home, suffix) },
					sessionSshRemoteConfig: ssh ? { enabled: true, remoteId: `remote-${suffix}` } : undefined,
				}));
				vi.mocked(getLiveSessions).mockReturnValue(owners);
				vi.mocked(getSshRemoteById).mockImplementation((id) => ({
					...remote,
					id,
					host: `${id}.invalid`,
				}));
				for (const selected of owners) {
					const configDir = selected.customEnvVars.GROK_HOME;
					const id = selected.sessionSshRemoteConfig?.remoteId;
					const target = id ? { ...remote, id, host: `${id}.invalid` } : undefined;
					const row = { sessionId: 'native-collision', firstMessage: selected.id };
					const result =
						api === 'listPaginated'
							? { sessions: [row], totalCount: 2, hasMore: true, nextCursor: 'next' }
							: api === 'read'
								? {
										messages: [{ type: 'user', content: selected.id }],
										total: 3,
										hasMore: true,
										source: { provider: 'grok', status: 'partial', reason: 'inconsistent' },
									}
								: api === 'getPath'
									? `${configDir}/native-collision`
									: [row];
					storage[method].mockReturnValueOnce(result);
					expect(await invoke(selected.id, target?.id)).toBe(result);
					expect(storage[method]).toHaveBeenLastCalledWith(
						'/project',
						...args,
						...(options ? [{ ...options, configDir }, target] : [target, configDir])
					);
				}
				expect(storage[method]).toHaveBeenCalledTimes(2);
			}
		);

		it.each([
			['agent wins', { GROK_HOME: '~/agent' }, '~/provider', '~/global', 'agent'],
			['provider beats global/process', undefined, '~/provider', '~/global', 'provider'],
			[
				'session map replaces provider',
				{ UNRELATED: 'fixture' },
				'~/provider',
				'~/global',
				'global',
			],
			['global beats process', undefined, undefined, '~/global', 'global'],
			['process fallback', undefined, undefined, undefined, 'process-account'],
			['agent blank unsets lower layers', { GROK_HOME: ' \t' }, '~/provider', '~/global', '.grok'],
			['provider blank unsets lower layers', undefined, '', '~/global', '.grok'],
			['global blank unsets process', undefined, undefined, '\t', '.grok'],
		] as const)('%s', async (_label, custom, provider, global, expected) => {
			owner.customEnvVars = custom;
			if (provider !== undefined) accountStores.provider.GROK_HOME = provider;
			if (global !== undefined) accountStores.global.GROK_HOME = global;
			await invoke();
			const configDir = path.join(home, expected);
			expectScope(configDir);
		});

		it.each([undefined, ' \t', '~/custom remote'])(
			'keeps remote home %j independent of local env',
			async (custom) => {
				owner.customEnvVars = custom === undefined ? {} : { GROK_HOME: custom };
				owner.sessionSshRemoteConfig = { enabled: true, remoteId: remote.id };
				accountStores.global.GROK_HOME = '~/local-global';
				await invoke();
				const configDir = custom?.trim() || undefined;
				expectScope(configDir, remote);
			}
		);

		it('does not retry another account when the selected root has no history', async () => {
			const configDir = path.join(home, 'absent-account');
			owner.customEnvVars = { GROK_HOME: configDir };
			const result = await invoke();
			expect(result).toEqual(
				api === 'getPath'
					? null
					: api === 'read'
						? { messages: [], total: 0, hasMore: false }
						: api === 'listPaginated'
							? { sessions: [], totalCount: 0, hasMore: false, nextCursor: null }
							: []
			);
			expectScope(configDir);
		});

		it.each([
			['missing owner', { id: 'other-owner' }, undefined, /owner is unavailable/],
			['wrong provider', { toolType: 'codex' }, undefined, /different provider/],
			['missing', { enabled: true, remoteId: 'missing' }, undefined, /remote-not-found/],
			['disabled', { enabled: true, remoteId: 'remote-a' }, undefined, /remote-disabled/],
			['unselected', { enabled: true }, undefined, /no-remote-selected/],
			['conflicting', { enabled: true, remoteId: 'remote-a' }, 'other', /does not match/],
			['remote for local owner', {}, 'remote-a', /does not match/],
		] as const)(
			'refuses %s scope before storage or mirrors',
			async (label, patch, requested, error) => {
				if ('enabled' in patch) owner.sessionSshRemoteConfig = patch;
				else Object.assign(owner, patch);
				if (label === 'disabled')
					vi.mocked(getSshRemoteById).mockReturnValue({ ...remote, enabled: false });
				await expect(invoke('owner', requested)).rejects.toThrow(error);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([false, 0, '', [], {}, { enabled: 'true' }, { enabled: 0 }])(
			'refuses malformed saved SSH config %j',
			async (config) => {
				Object.assign(owner, { sessionSshRemoteConfig: config, sshRemoteId: 'remote-a' });
				await expect(invoke()).rejects.toThrow(/invalid SSH configuration/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([false, 0, '', ' ', 42])(
			'refuses malformed/unselected saved remote ID %j',
			async (remoteId) => {
				Object.assign(owner, { sessionSshRemoteConfig: { enabled: true, remoteId } });
				await expect(invoke()).rejects.toThrow(/History SSH target unavailable/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each([null, false, 0, '', ' \t', 'bad\0id'])(
			'refuses malformed requested owner/remote %j',
			async (id) => {
				await expect(invoke(id)).rejects.toThrow(/Invalid history ownerAgentId/);
				await expect(invoke('owner', id)).rejects.toThrow(/Invalid history sshRemoteId/);
				for (const call of Object.values(storage)) expect(call).not.toHaveBeenCalled();
			}
		);

		it.each(['legacy', 'configured', 'disabled'] as const)(
			'resolves %s SSH selection ahead of the observed ID',
			async (mode) => {
				owner.sshRemoteId = mode === 'legacy' ? 'remote-a' : 'stale-remote';
				owner.sessionSshRemoteConfig =
					mode === 'legacy' ? undefined : { enabled: mode === 'configured', remoteId: 'remote-a' };
				await invoke();
				const target = mode === 'disabled' ? undefined : remote;
				const configDir = target ? undefined : path.join(home, 'process-account');
				expectScope(configDir, target);
			}
		);
	});

	describe('Grok read provenance and explicit scope', () => {
		it.each([undefined, '', ' ', '/selected-account'])(
			'forwards explicit configDir %j and unavailable evidence without restoration',
			async (configDir) => {
				const result: agentSessionStorage.SessionMessagesResult = {
					messages: [],
					total: 0,
					hasMore: false,
					source: { provider: 'grok', status: 'unavailable', reason: 'missing' },
				};
				const storage = { readSessionMessages: vi.fn().mockResolvedValue(result) };
				vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
					storage as unknown as agentSessionStorage.AgentSessionStorage
				);
				const options = { offset: 0, limit: 7, includeNativeRecords: true, configDir };
				expect(
					await handlers.get('agentSessions:read')!({}, 'grok', '/project', 'native', options)
				).toBe(result);
				expect(storage.readSessionMessages).toHaveBeenCalledExactlyOnceWith(
					'/project',
					'native',
					options,
					undefined
				);
				expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
			}
		);

		it.each([
			['owner', '/override', /cannot override/],
			['owner', '', /cannot override/],
			['owner', ' ', /cannot override/],
			[undefined, null, /Invalid history account directory/],
			[undefined, false, /Invalid history account directory/],
			[undefined, 0, /Invalid history account directory/],
			[undefined, 'bad\0path', /Invalid history account directory/],
		] as const)('rejects owner %j with account %j', async (ownerAgentId, configDir, error) => {
			vi.mocked(getLiveSessions).mockReturnValue([
				{ ...createMockSession({ id: 'owner', toolType: 'grok' }) },
			]);
			const storage = { readSessionMessages: vi.fn() };
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				storage as unknown as agentSessionStorage.AgentSessionStorage
			);
			await expect(
				handlers.get('agentSessions:read')!({}, 'grok', '/project', 'native', {
					ownerAgentId,
					configDir,
				})
			).rejects.toThrow(error);
			expect(storage.readSessionMessages).not.toHaveBeenCalled();
			expect(mirrors.restoreStarredTranscript).not.toHaveBeenCalled();
		});
	});

	describe('agentSessions:deleteMessagePair', () => {
		it('should delete message pair from storage', async () => {
			const mockStorage = {
				agentId: 'claude-code',
				deleteMessagePair: vi.fn().mockResolvedValue({ success: true, linesRemoved: 3 }),
			};

			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(
				mockStorage as unknown as agentSessionStorage.AgentSessionStorage
			);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!(
				{} as any,
				'claude-code',
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);

			expect(mockStorage.deleteMessagePair).toHaveBeenCalledWith(
				'/test',
				'session-1',
				'uuid-123',
				'fallback content'
			);
			expect(result).toEqual({ success: true, linesRemoved: 3 });
		});

		it('should return error when no storage available', async () => {
			vi.mocked(agentSessionStorage.getSessionStorage).mockReturnValue(null);

			const handler = handlers.get('agentSessions:deleteMessagePair');
			const result = await handler!({} as any, 'unknown-agent', '/test', 'session-1', 'uuid-123');

			expect(result).toEqual({
				success: false,
				error: 'No session storage available for agent: unknown-agent',
			});
		});
	});

	describe('agentSessions:hasStorage', () => {
		it('should return true when storage exists', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(true);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'claude-code');

			expect(agentSessionStorage.hasSessionStorage).toHaveBeenCalledWith('claude-code');
			expect(result).toBe(true);
		});

		it('should return false when storage does not exist', async () => {
			vi.mocked(agentSessionStorage.hasSessionStorage).mockReturnValue(false);

			const handler = handlers.get('agentSessions:hasStorage');
			const result = await handler!({} as any, 'unknown-agent');

			expect(result).toBe(false);
		});
	});

	describe('agentSessions:getAvailableStorages', () => {
		it('should return list of available storage agent IDs', async () => {
			const mockStorages = [{ agentId: 'claude-code' }, { agentId: 'opencode' }];

			vi.mocked(agentSessionStorage.getAllSessionStorages).mockReturnValue(
				mockStorages as unknown as agentSessionStorage.AgentSessionStorage[]
			);

			const handler = handlers.get('agentSessions:getAvailableStorages');
			const result = await handler!({} as any);

			expect(result).toEqual(['claude-code', 'opencode']);
		});
	});
});

describe('isExpectedSessionReadError', () => {
	// The global-stats loops read provider transcripts that belong to the agent
	// CLI, not to us. Failures rooted in the user's filesystem must not reach
	// Sentry (MAESTRO-W9); a genuine parse fault still must.
	it('treats an unreadable transcript as expected (MAESTRO-W9)', () => {
		const error = Object.assign(
			new Error("EACCES: permission denied, open '/Users/x/.claude/projects/a/b.jsonl'"),
			{ code: 'EACCES' }
		);
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it('treats a transcript deleted mid-scan as expected', () => {
		const error = Object.assign(new Error('ENOENT: no such file or directory'), {
			code: 'ENOENT',
		});
		expect(isExpectedSessionReadError(error)).toBe(true);
	});

	it.each(['EPERM', 'ENOTDIR', 'EISDIR', 'EBUSY'])('treats %s as expected', (code) => {
		expect(isExpectedSessionReadError(Object.assign(new Error(code), { code }))).toBe(true);
	});

	it('still reports errors that are not filesystem conditions', () => {
		expect(isExpectedSessionReadError(new Error('Unexpected token in JSON'))).toBe(false);
		expect(isExpectedSessionReadError(new RangeError('Invalid string length'))).toBe(false);
		expect(isExpectedSessionReadError(Object.assign(new Error('boom'), { code: 'EMFILE' }))).toBe(
			false
		);
	});

	it('handles non-Error throwables', () => {
		expect(isExpectedSessionReadError(undefined)).toBe(false);
		expect(isExpectedSessionReadError('EACCES')).toBe(false);
	});
});

describe('agentSessions:getGlobalStats discovery', () => {
	let home: string;
	let getGlobalStats: () => Promise<{
		totalSessions: number;
		totalMessages: number;
		totalSizeBytes: number;
		byProvider: Record<string, { sessions: number }>;
	}>;

	beforeEach(async () => {
		home = await realFs.mkdtemp(path.join(os.tmpdir(), 'maestro-global-stats-'));
		vi.spyOn(os, 'homedir').mockReturnValue(home);
		const handlers = new Map<string, (...args: any[]) => any>();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler);
		});
		registerAgentSessionsHandlers();
		const handler = handlers.get('agentSessions:getGlobalStats')!;
		getGlobalStats = () => handler({});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await realFs.rm(home, { recursive: true, force: true });
	});

	it('counts every non-empty transcript across more files than the concurrency cap', async () => {
		const claudeTranscript = '{"type":"user"}\n{"type":"assistant"}\n';
		const projects = path.join(home, '.claude', 'projects');
		// 40 transcripts across two projects: more than either pool's cap, so
		// workers must pull past their first item for the count to come out right.
		for (const project of ['-Users-a', '-Users-b']) {
			await realFs.mkdir(path.join(projects, project), { recursive: true });
			for (let i = 0; i < 20; i++) {
				await realFs.writeFile(path.join(projects, project, `s${i}.jsonl`), claudeTranscript);
			}
		}
		// Skipped: an abandoned 0-byte session, a non-transcript, and a stray file
		// where a project directory is expected.
		await realFs.writeFile(path.join(projects, '-Users-a', 'empty.jsonl'), '');
		await realFs.writeFile(path.join(projects, '-Users-a', 'notes.txt'), 'x');
		await realFs.writeFile(path.join(projects, 'stray.jsonl'), claudeTranscript);

		const codexDay = path.join(home, '.codex', 'sessions', '2026', '10', '11');
		await realFs.mkdir(codexDay, { recursive: true });
		await realFs.writeFile(
			path.join(codexDay, 'rollout.jsonl'),
			'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'
		);

		const stats = await getGlobalStats();

		expect(stats.byProvider['claude-code'].sessions).toBe(40);
		expect(stats.byProvider['codex'].sessions).toBe(1);
		expect(stats.totalSessions).toBe(41);
		expect(stats.totalMessages).toBe(81);
		expect(stats.totalSizeBytes).toBe(
			40 * claudeTranscript.length +
				'{"type":"response_item","payload":{"type":"message","role":"user"}}\n'.length
		);
	});

	it('upgrades a cache from an older Claude parser: re-parses live sessions, rescales archived ones', async () => {
		const projects = path.join(home, '.claude', 'projects', '-Users-a');
		await realFs.mkdir(projects, { recursive: true });
		// One API response written as two lines (one per content block), each
		// repeating the usage: 1M Sonnet input = $3 once deduplicated.
		const line = JSON.stringify({
			type: 'assistant',
			requestId: 'req_1',
			message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
		});
		await realFs.writeFile(path.join(projects, 'live.jsonl'), `${line}\n${line}\n`);

		const cachedEntry = (inputTokens: number, costUsd: number, archived = false) => ({
			messages: 2,
			inputTokens,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			cachedInputTokens: 0,
			sizeBytes: 1,
			costUsd,
			// Newer than the file, so only the version can force the re-parse.
			fileMtimeMs: Date.now() + 60_000,
			archived,
		});
		vi.mocked(loadGlobalStatsCache).mockResolvedValueOnce({
			version: GLOBAL_STATS_CACHE_MIN_UPGRADABLE_VERSION,
			lastUpdated: 0,
			providers: {
				'claude-code': {
					sessions: {
						'-Users-a/live': cachedEntry(2_000_000, 6),
						'-Users-a/gone': cachedEntry(4_000_000, 12, true),
					},
				},
				codex: { sessions: {} },
			},
		});

		const stats = (await getGlobalStats()) as unknown as {
			totalCostUsd: number;
			totalInputTokens: number;
		};

		// Live re-parsed to $3; the fix halved it, so the archived $12 becomes $6.
		expect(stats.totalCostUsd).toBeCloseTo(9, 10);
		expect(stats.totalInputTokens).toBe(3_000_000);
		const saved = vi.mocked(saveGlobalStatsCache).mock.calls.at(-1)![0];
		expect(saved.version).toBe(GLOBAL_STATS_CACHE_VERSION);
	});

	it("prices a Claude session's subagent transcripts into the totals without counting them as sessions", async () => {
		const project = path.join(home, '.claude', 'projects', '-Users-a');
		const line = (id: string) =>
			JSON.stringify({
				type: 'assistant',
				requestId: `req_${id}`,
				message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000 } },
			});
		await realFs.mkdir(path.join(project, 's1', 'subagents'), { recursive: true });
		await realFs.writeFile(path.join(project, 's1.jsonl'), `${line('parent')}\n`);
		await realFs.writeFile(
			path.join(project, 's1', 'subagents', 'agent-x.jsonl'),
			`${line('child')}\n`
		);

		const stats = (await getGlobalStats()) as unknown as {
			totalSessions: number;
			totalInputTokens: number;
			totalCostUsd: number;
		};

		expect(stats.totalSessions).toBe(1);
		expect(stats.totalInputTokens).toBe(2_000_000);
		expect(stats.totalCostUsd).toBeCloseTo(6, 10);
	});

	it('reports zero when neither provider has a transcript directory', async () => {
		const stats = await getGlobalStats();
		expect(stats.totalSessions).toBe(0);
	});
});
