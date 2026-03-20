import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';
import type { TeamTemplate } from '../../../../shared/group-chat-types';

// Mock electron
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
		removeHandler: vi.fn(),
	},
}));

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock uuid
vi.mock('uuid', () => ({
	v4: vi.fn(() => 'mock-uuid-1234'),
}));

// Mock team-template-storage
const mockListTemplates = vi.fn();
const mockGetTemplate = vi.fn();
const mockSaveTemplate = vi.fn();
const mockDeleteTemplate = vi.fn();
const mockDuplicateTemplate = vi.fn();

vi.mock('../../../../main/group-chat/team-template-storage', () => ({
	listTemplates: (...args: unknown[]) => mockListTemplates(...args),
	getTemplate: (...args: unknown[]) => mockGetTemplate(...args),
	saveTemplate: (...args: unknown[]) => mockSaveTemplate(...args),
	deleteTemplate: (...args: unknown[]) => mockDeleteTemplate(...args),
	duplicateTemplate: (...args: unknown[]) => mockDuplicateTemplate(...args),
}));

// Mock group-chat-storage
const mockLoadGroupChat = vi.fn();

vi.mock('../../../../main/group-chat/group-chat-storage', () => ({
	loadGroupChat: (...args: unknown[]) => mockLoadGroupChat(...args),
}));

import { registerTeamTemplateHandlers } from '../../../../main/ipc/handlers/teamTemplates';

/** Helper to create a test TeamTemplate */
function makeTemplate(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
	const now = Date.now();
	return {
		id: overrides.id ?? 'test-id',
		name: overrides.name ?? 'Test Template',
		description: overrides.description ?? 'A test template',
		category: overrides.category ?? 'user',
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		moderatorAgentId: overrides.moderatorAgentId ?? 'claude-code',
		roles: overrides.roles ?? [
			{ name: 'Dev', agentId: 'claude-code', description: 'Develops code' },
		],
	};
}

describe('Team Template IPC Handlers', () => {
	const handlers: Map<string, Function> = new Map();

	beforeEach(() => {
		vi.clearAllMocks();
		handlers.clear();

		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerTeamTemplateHandlers();
	});

	describe('handler registration', () => {
		it('registers all expected channels', () => {
			expect(handlers.has('teamTemplate:list')).toBe(true);
			expect(handlers.has('teamTemplate:get')).toBe(true);
			expect(handlers.has('teamTemplate:save')).toBe(true);
			expect(handlers.has('teamTemplate:delete')).toBe(true);
			expect(handlers.has('teamTemplate:duplicate')).toBe(true);
			expect(handlers.has('teamTemplate:createFromChat')).toBe(true);
		});
	});

	describe('teamTemplate:list', () => {
		it('returns templates from storage', async () => {
			const templates = [makeTemplate({ id: 't1' }), makeTemplate({ id: 't2' })];
			mockListTemplates.mockResolvedValueOnce(templates);

			const handler = handlers.get('teamTemplate:list')!;
			const result = await handler({});

			expect(result).toEqual(templates);
			expect(mockListTemplates).toHaveBeenCalled();
		});

		it('returns empty array when no templates exist', async () => {
			mockListTemplates.mockResolvedValueOnce([]);

			const handler = handlers.get('teamTemplate:list')!;
			const result = await handler({});

			expect(result).toEqual([]);
		});
	});

	describe('teamTemplate:get', () => {
		it('returns template by ID', async () => {
			const template = makeTemplate({ id: 'my-id' });
			mockGetTemplate.mockResolvedValueOnce(template);

			const handler = handlers.get('teamTemplate:get')!;
			const result = await handler({}, 'my-id');

			expect(result).toEqual(template);
			expect(mockGetTemplate).toHaveBeenCalledWith('my-id');
		});

		it('returns null for non-existent template', async () => {
			mockGetTemplate.mockResolvedValueOnce(null);

			const handler = handlers.get('teamTemplate:get')!;
			const result = await handler({}, 'missing');

			expect(result).toBeNull();
		});
	});

	describe('teamTemplate:save', () => {
		it('saves template to storage', async () => {
			const template = makeTemplate({ id: 'save-me' });
			mockSaveTemplate.mockResolvedValueOnce(undefined);

			const handler = handlers.get('teamTemplate:save')!;
			await handler({}, template);

			expect(mockSaveTemplate).toHaveBeenCalledWith(template);
		});
	});

	describe('teamTemplate:delete', () => {
		it('deletes template from storage', async () => {
			mockDeleteTemplate.mockResolvedValueOnce(undefined);

			const handler = handlers.get('teamTemplate:delete')!;
			await handler({}, 'del-id');

			expect(mockDeleteTemplate).toHaveBeenCalledWith('del-id');
		});

		it('throws when storage rejects deletion', async () => {
			mockDeleteTemplate.mockRejectedValueOnce(new Error('Cannot delete builtin template'));

			const handler = handlers.get('teamTemplate:delete')!;
			await expect(handler({}, 'builtin-id')).rejects.toThrow('Cannot delete builtin template');
		});
	});

	describe('teamTemplate:duplicate', () => {
		it('duplicates template with new name', async () => {
			const duplicated = makeTemplate({ id: 'new-uuid', name: 'My Copy' });
			mockDuplicateTemplate.mockResolvedValueOnce(duplicated);

			const handler = handlers.get('teamTemplate:duplicate')!;
			const result = await handler({}, 'orig-id', 'My Copy');

			expect(result).toEqual(duplicated);
			expect(mockDuplicateTemplate).toHaveBeenCalledWith('orig-id', 'My Copy');
		});
	});

	describe('teamTemplate:createFromChat', () => {
		it('creates template from existing group chat', async () => {
			const mockChat = {
				id: 'chat-123',
				name: 'My Chat',
				moderatorAgentId: 'claude-code',
				moderatorConfig: {
					customArgs: '--verbose',
					customEnvVars: { FOO: 'bar' },
				},
				participants: [
					{ name: 'Frontend Dev', agentId: 'claude-code', sessionId: 's1', addedAt: 1000 },
					{ name: 'Backend Dev', agentId: 'codex', sessionId: 's2', addedAt: 2000 },
				],
			};
			mockLoadGroupChat.mockResolvedValueOnce(mockChat);
			mockSaveTemplate.mockResolvedValueOnce(undefined);

			const handler = handlers.get('teamTemplate:createFromChat')!;
			const result = await handler({}, 'chat-123', 'My Template', 'A great template');

			expect(mockLoadGroupChat).toHaveBeenCalledWith('chat-123');
			expect(mockSaveTemplate).toHaveBeenCalled();

			// Verify the saved template structure
			expect(result.id).toBe('mock-uuid-1234');
			expect(result.name).toBe('My Template');
			expect(result.description).toBe('A great template');
			expect(result.category).toBe('user');
			expect(result.moderatorAgentId).toBe('claude-code');
			expect(result.moderatorConfig).toEqual({
				customArgs: '--verbose',
				customEnvVars: { FOO: 'bar' },
			});
			expect(result.roles).toHaveLength(2);
			expect(result.roles[0].name).toBe('Frontend Dev');
			expect(result.roles[0].agentId).toBe('claude-code');
			expect(result.roles[1].name).toBe('Backend Dev');
			expect(result.roles[1].agentId).toBe('codex');
		});

		it('uses default name and description when not provided', async () => {
			const mockChat = {
				id: 'chat-456',
				name: 'Dev Chat',
				moderatorAgentId: 'claude-code',
				participants: [],
			};
			mockLoadGroupChat.mockResolvedValueOnce(mockChat);
			mockSaveTemplate.mockResolvedValueOnce(undefined);

			const handler = handlers.get('teamTemplate:createFromChat')!;
			const result = await handler({}, 'chat-456');

			expect(result.name).toBe('Template from Dev Chat');
			expect(result.description).toBe('Team template created from group chat "Dev Chat".');
		});

		it('throws when group chat not found', async () => {
			mockLoadGroupChat.mockResolvedValueOnce(null);

			const handler = handlers.get('teamTemplate:createFromChat')!;
			await expect(handler({}, 'missing-chat')).rejects.toThrow(
				'Group chat not found: missing-chat'
			);
		});

		it('handles chat without moderator config', async () => {
			const mockChat = {
				id: 'chat-789',
				name: 'Simple Chat',
				moderatorAgentId: 'claude-code',
				participants: [{ name: 'Worker', agentId: 'claude-code', sessionId: 's1', addedAt: 1000 }],
			};
			mockLoadGroupChat.mockResolvedValueOnce(mockChat);
			mockSaveTemplate.mockResolvedValueOnce(undefined);

			const handler = handlers.get('teamTemplate:createFromChat')!;
			const result = await handler({}, 'chat-789', 'Simple Template');

			expect(result.moderatorConfig).toBeUndefined();
			expect(result.roles).toHaveLength(1);
		});
	});
});
