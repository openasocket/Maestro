import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	extractTabContext,
	extractStoredSessionContext,
	formatLogsForGrooming,
	formatLogsForClipboard,
	hasThinkingEntries,
	parseGroomedOutput,
	estimateTokenCount,
	estimateTextTokenCount,
	findDuplicateContent,
	calculateTotalTokens,
	getContextSummary,
} from '../../../renderer/utils/contextExtractor';
import type { AITab, LogEntry, Session } from '../../../renderer/types';
import type { ContextSource } from '../../../renderer/types/contextMerge';
import { createMockAITab } from '../../helpers/mockTab';
import { createMockSession as baseCreateMockSession } from '../../helpers/mockSession';
import type { SessionMessagesResult } from '../../../main/agents/session-storage';
import type { NativeSessionBinding } from '../../../shared/maestro-lib/agents/providerSwap';
import { getDeclaredTranslationDirection } from '../../../shared/maestro-lib/translation/support';

// Thin wrapper: context extraction tests assert against the default id
// 'session-123', so preserve that default via the shared factory.
const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({ id: 'session-123', ...overrides });

// Mock window.maestro for extractStoredSessionContext tests
const mockAgentSessionsRead = vi.fn();
vi.stubGlobal('window', {
	maestro: {
		agentSessions: {
			read: mockAgentSessionsRead,
		},
	},
});

// Helper to create a mock tab
function createMockTab(overrides: Partial<AITab> = {}): AITab {
	return createMockAITab({
		id: 'tab-123',
		agentSessionId: 'agent-session-456',
		name: 'Test Tab',
		...overrides,
	});
}

// Helper to create a mock log entry
function createMockLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Test message',
		...overrides,
	};
}

describe('extractStoredSessionContext: Grok export', () => {
	let binding: Extract<NativeSessionBinding, { state: 'bound' }>;
	let result: SessionMessagesResult;
	let options: NonNullable<Parameters<typeof extractStoredSessionContext>[3]>;

	beforeEach(() => {
		binding = {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: 'native-shared',
			accountRef: 'account-a',
			host: { kind: 'local', identity: 'fixture-machine' },
			cwd: '/fixture/project',
		};
		options = { ownerAgentId: 'owner-a', nativeSessionBinding: binding };
		result = {
			nativeSessionBinding: binding,
			source: { provider: 'grok', status: 'available' },
			messages: [
				{
					type: 'user',
					role: 'user',
					content: 'Selected account content',
					timestamp: '',
					uuid: 'native-line-1',
					native: { provider: 'grok', line: 1 },
				},
			],
			total: 1,
			hasMore: false,
		};
		mockAgentSessionsRead.mockReset().mockResolvedValue(result);
	});

	it.each(['local', 'ssh'] as const)(
		'exports only the selected %s account with a colliding native ID',
		async (kind) => {
			const selected = { ...binding, host: { kind, identity: `fixture-${kind}` } };
			const other = { ...selected, accountRef: 'account-b' };
			mockAgentSessionsRead.mockImplementation(async (_provider, _cwd, _id, readOptions) => ({
				...result,
				nativeSessionBinding: readOptions.ownerAgentId === 'owner-a' ? selected : other,
				messages: [{ ...result.messages[0], content: `${readOptions.ownerAgentId} content` }],
			}));
			for (const [ownerAgentId, nativeSessionBinding] of [
				['owner-a', selected],
				['owner-b', other],
			] as const) {
				const sshRemoteId = kind === 'ssh' ? 'fixture-remote' : undefined;
				const context = await extractStoredSessionContext(
					'grok',
					binding.cwd,
					binding.nativeSessionId,
					{
						ownerAgentId,
						nativeSessionBinding,
						sshRemoteId,
					}
				);
				expect(mockAgentSessionsRead).toHaveBeenLastCalledWith(
					'grok',
					binding.cwd,
					'native-shared',
					{
						ownerAgentId,
						nativeSessionBinding,
						includeNativeRecords: true,
						offset: 0,
						limit: 1000,
					},
					sshRemoteId
				);
				expect(context).toMatchObject({
					type: 'session',
					sessionId: ownerAgentId,
					agentSessionId: 'native-shared',
					projectRoot: binding.cwd,
					agentType: 'grok',
				});
				expect(context!.logs[1].text).toContain(`${ownerAgentId} content`);
				expect(context!.logs[1].text).not.toContain(
					`${ownerAgentId === 'owner-a' ? 'owner-b' : 'owner-a'} content`
				);
				expect(context!.logs[0].text).toContain(nativeSessionBinding.accountRef);
			}
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(2);
		}
	);

	it.each([undefined, '', '  '])(
		'refuses missing/blank owner %j before reading',
		async (ownerAgentId) => {
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', { ownerAgentId })
			).rejects.toThrow('Select the owning Grok agent');
			expect(mockAgentSessionsRead).not.toHaveBeenCalled();
		}
	);

	it.each(['missing', 'unknown', 'account', 'host', 'cwd', 'native ID', 'provider'])(
		'refuses nonempty content with %s ownership mismatch',
		async (mismatch) => {
			if (mismatch === 'missing') result.nativeSessionBinding = undefined;
			else if (mismatch === 'unknown')
				result.nativeSessionBinding = { version: 1, state: 'unknown', reason: 'unobserved' };
			else
				result.nativeSessionBinding = {
					...binding,
					...(mismatch === 'account' ? { accountRef: 'account-b' } : {}),
					...(mismatch === 'host'
						? { host: { kind: 'ssh' as const, identity: 'different-host' } }
						: {}),
					...(mismatch === 'cwd' ? { cwd: '/other/project' } : {}),
					...(mismatch === 'native ID' ? { nativeSessionId: 'other-native' } : {}),
					...(mismatch === 'provider' ? { provider: 'codex' as const } : {}),
				};
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', options)
			).rejects.toThrow('ownership is unverified');
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
		}
	);

	it('accepts host-observed ownership without a retained binding', async () => {
		const context = await extractStoredSessionContext('grok', binding.cwd, 'native-shared', {
			ownerAgentId: 'owner-a',
		});
		expect(context!.logs[1].text).toContain('Selected account content');
		expect(context!.logs[0].text).toContain('account-a');
	});

	it.each(['missing', 'rejected'])(
		'propagates a %s read without falling back to another account',
		async (failure) => {
			if (failure === 'missing') mockAgentSessionsRead.mockResolvedValue(null);
			else mockAgentSessionsRead.mockRejectedValue(new Error('Selected account unavailable'));
			await expect(
				extractStoredSessionContext('grok', binding.cwd, 'native-shared', options)
			).rejects.toThrow(
				failure === 'missing' ? 'could not be read' : 'Selected account unavailable'
			);
			expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
		}
	);

	it('preserves ordered, redacted tool/image evidence and unknown rows through both formatters', async () => {
		// Same inert sentinel as the canonical redaction suite, never a credential.
		const secret = 'sk-ABCDEFGHIJKLMNOP1234';
		const historicalFile = `\`\`\`ts:/fixture/removed.ts\n${'historical line\n'.repeat(20)}\`\`\``;
		result.source = { provider: 'grok', status: 'partial', reason: `truncated ${secret}` };
		result.nativeSessionBinding = { ...binding, accountRef: `fixture-${secret}` };
		options.nativeSessionBinding = result.nativeSessionBinding;
		result.messages = [
			{
				...result.messages[0],
				content: `Question ${secret}`,
				timestamp: '2026-10-31T12:00:00Z',
				imageReferences: [`/fixture/${secret}.png`],
				images: ['data:image/png;base64,SHOULD_NOT_LOAD'],
			},
			{
				type: 'backend_tool_call',
				role: 'assistant',
				uuid: 'call-line-2',
				timestamp: '',
				content: '',
				toolUse: [
					{
						id: 'call-7',
						name: 'read_file',
						arguments: { path: '/fixture/removed.ts', credential: secret },
					},
				],
				native: { provider: 'grok', line: 2, raw: 'PRIVATE_BACKEND_PAYLOAD' },
			},
			{
				type: 'tool_result',
				role: 'tool',
				uuid: 'result-line-3',
				timestamp: '',
				content: historicalFile,
				toolCallId: 'call-7',
				images: ['/fixture/legacy.png'],
				native: { provider: 'grok', line: 3 },
			},
			{
				type: 'assistant',
				role: 'assistant',
				uuid: 'answer-line-4',
				timestamp: '2026-10-30T12:00:00Z',
				content: 'Answer',
				native: {
					provider: 'grok',
					line: 4,
					raw: '{"reasoning_content":"PRIVATE_LEGACY_REASONING"}',
				},
			},
			{
				type: 'future_record',
				uuid: 'unknown-line-5',
				timestamp: '',
				content: '',
				native: {
					provider: 'grok',
					line: 5,
					raw: 'PRIVATE_UNKNOWN_PAYLOAD',
					issues: ['unknown-record-type'],
				},
			},
		];
		result.total = 5;
		const original = structuredClone(result);
		const context = await extractStoredSessionContext(
			'grok',
			binding.cwd,
			'native-shared',
			options
		);
		const logs = context!.logs;
		expect(logs.slice(1).map(({ id, source }) => [id, source])).toEqual([
			['native-line-1', 'user'],
			['call-line-2', 'tool'],
			['result-line-3', 'tool'],
			['answer-line-4', 'ai'],
			['unknown-line-5', 'stdout'],
		]);
		expect(logs[1].timestamp).toBe(Date.parse('2026-10-31T12:00:00Z'));
		expect(logs[4].timestamp).toBe(Date.parse('2026-10-30T12:00:00Z'));
		for (const index of [0, 2, 3, 5]) expect(logs[index].timestamp).toBeNaN();
		for (const log of logs)
			expect(Object.keys(log).sort()).toEqual(['id', 'source', 'text', 'timestamp']);
		expect(result).toEqual(original);
		const projection = logs.map((log) => log.text).join('\n');
		for (const text of [projection, formatLogsForClipboard(logs), formatLogsForGrooming(logs)]) {
			expect(text).toContain('not lossless native migration or a resumable session');
			expect(text).toContain('Raw native payloads and opaque reasoning are omitted');
			expect(text).toContain('Missing content:');
			expect(text).toContain('Historical tool calls:');
			expect(text).toContain('"id":"call-7"');
			expect(text).toContain('Tool result for call: call-7');
			expect(text).toContain(historicalFile);
			expect(text).not.toContain('content available on disk');
			expect(text).toContain('Image references (not loaded; image content not interpreted):');
			expect(text).toContain('/fixture/[REDACTED_API_KEY].png');
			expect(text).toContain('/fixture/legacy.png');
			expect(text).toContain('source line 5; timestamp unknown');
			expect(text).toContain('Source issues: unknown-record-type');
			expect(text).toContain('[No normalized text; original content may be unavailable or opaque]');
			expect(text).toContain('"reason":"truncated [REDACTED_API_KEY]"');
			expect(text).toContain('"accountRef":"fixture-[REDACTED_API_KEY]"');
			expect(text).toContain('"credential":"[REDACTED_API_KEY]"');
			for (const omitted of [
				secret,
				'PRIVATE_BACKEND_PAYLOAD',
				'PRIVATE_LEGACY_REASONING',
				'PRIVATE_UNKNOWN_PAYLOAD',
				'SHOULD_NOT_LOAD',
			])
				expect(text).not.toContain(omitted);
			const lines = [...text.matchAll(/source line (\d+)/g)].map((match) => Number(match[1]));
			expect(lines).toEqual([1, 2, 3, 4, 5]);
		}
		// Formatters independently redact text added after extraction as well.
		logs[1].text += ` late ${secret}`;
		for (const text of [formatLogsForClipboard(logs), formatLogsForGrooming(logs)]) {
			expect(text).toContain('late [REDACTED_API_KEY]');
			expect(text).not.toContain(secret);
		}
	});

	it.each([false, true])(
		'applies reasoning visibility at export and clipboard (includeThinking=%s)',
		async (includeThinking) => {
			result.messages = [
				{
					...result.messages[0],
					type: 'reasoning',
					role: 'assistant',
					content: 'VISIBLE_REASONING',
					native: { provider: 'grok', line: 1, raw: 'OPAQUE_REASONING' },
				},
			];
			const context = await extractStoredSessionContext('grok', binding.cwd, 'native-shared', {
				...options,
				includeThinking,
			});
			const logs = context!.logs;
			expect(logs[1].source).toBe(includeThinking ? 'thinking' : 'system');
			expect(formatLogsForClipboard(logs)).not.toContain('VISIBLE_REASONING');
			for (const text of [
				logs[1].text,
				formatLogsForGrooming(logs),
				formatLogsForClipboard(logs, { includeThinking: true }),
			]) {
				expect(text.includes('VISIBLE_REASONING')).toBe(includeThinking);
				expect(text).not.toContain('OPAQUE_REASONING');
				if (!includeThinking)
					expect(text).toContain('Reasoning text omitted by export visibility policy');
			}
		}
	);

	it.each([
		undefined,
		{ provider: 'grok', status: 'unavailable', reason: 'oversized' },
		{ provider: 'grok', status: 'partial', reason: 'truncated' },
	] satisfies SessionMessagesResult['source'][])(
		'discloses empty incomplete source %j',
		async (source) => {
			Object.assign(result, { source, messages: [], total: 0 });
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				'native-shared',
				options
			);
			expect(context!.logs).toHaveLength(1);
			for (const text of [
				formatLogsForClipboard(context!.logs),
				formatLogsForGrooming(context!.logs),
			]) {
				expect(text).toContain('Missing content:');
				expect(text).toContain(source?.reason ?? 'source-status-unobserved');
				expect(text).not.toContain('The observed transcript contains no records');
			}
		}
	);

	it.each([true, false])(
		'describes an available empty source truthfully (observed=%s)',
		async (observed) => {
			Object.assign(result, {
				messages: [],
				total: 0,
				nativeSessionBinding: observed ? binding : undefined,
			});
			const context = await extractStoredSessionContext(
				'grok',
				binding.cwd,
				'native-shared',
				options
			);
			const text = formatLogsForClipboard(context!.logs);
			expect(text.includes('The observed transcript contains no records')).toBe(observed);
			if (!observed)
				expect(text).toContain('Ownership: unverified; no transcript content exported');
		}
	);

	it.each([
		{ total: 1001, hasMore: false },
		{ total: 1, hasMore: true },
	])('discloses pagination %j without stitching generations', async (page) => {
		Object.assign(result, page);
		const context = await extractStoredSessionContext(
			'grok',
			binding.cwd,
			'native-shared',
			options
		);
		for (const text of [
			formatLogsForClipboard(context!.logs),
			formatLogsForGrooming(context!.logs),
		]) {
			expect(text).toContain(
				`Partial export: the latest 1 of ${page.total} normalized records are included; earlier content is omitted.`
			);
		}
		expect(mockAgentSessionsRead).toHaveBeenCalledTimes(1);
	});

	it.each([
		['grok', 'codex'],
		['codex', 'grok'],
		['grok', 'claude-code'],
		['claude-code', 'grok'],
	])('does not enable native migration %s -> %s after export', async (source, destination) => {
		expect(getDeclaredTranslationDirection(source, destination)).toBeUndefined();
		const context = await extractStoredSessionContext(
			'grok',
			binding.cwd,
			'native-shared',
			options
		);
		expect(context!.logs[1].text).toContain('Selected account content');
		expect(getDeclaredTranslationDirection(source, destination)).toBeUndefined();
		expect(context).not.toHaveProperty('nativeSessionBinding');
	});

	it('preserves the non-Grok three-argument read and dialogue projection', async () => {
		const context = await extractStoredSessionContext('claude-code', binding.cwd, 'legacy-native');
		expect(mockAgentSessionsRead).toHaveBeenCalledWith('claude-code', binding.cwd, 'legacy-native');
		expect(context).toMatchObject({
			sessionId: '',
			name: 'Selected account content',
			logs: [{ id: 'native-line-1', source: 'user', text: 'Selected account content' }],
		});
		expect(formatLogsForClipboard(context!.logs)).toBe('USER:\nSelected account content');
	});
});

describe('extractTabContext', () => {
	it('should extract context from a tab with all fields populated', () => {
		const tab = createMockTab({
			name: 'Feature Branch',
			agentSessionId: 'abc123',
			logs: [
				createMockLog({ source: 'user', text: 'Hello' }),
				createMockLog({ source: 'ai', text: 'Hi there!' }),
			],
			usageStats: {
				inputTokens: 100,
				outputTokens: 200,
				cacheReadInputTokens: 50,
				cacheCreationInputTokens: 0,
				costUsd: 0.01,
			},
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'My Project', session);

		expect(context.type).toBe('tab');
		expect(context.sessionId).toBe('session-123');
		expect(context.tabId).toBe('tab-123');
		expect(context.agentSessionId).toBe('abc123');
		expect(context.projectRoot).toBe('/test/project');
		expect(context.name).toBe('My Project / Feature Branch');
		expect(context.logs).toHaveLength(2);
		expect(context.usageStats?.inputTokens).toBe(100);
		expect(context.agentType).toBe('claude-code');
	});

	it('should use agent session ID octets when tab name is null', () => {
		const tab = createMockTab({
			name: null,
			agentSessionId: 'abcdefgh-1234-5678-90ab-cdef12345678',
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		expect(context.name).toBe('Project / abcdefgh');
	});

	it('should fall back to "New Tab" when no name or session ID', () => {
		const tab = createMockTab({
			name: null,
			agentSessionId: null,
		});
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		expect(context.name).toBe('Project / New Tab');
	});

	it('should create a shallow copy of logs to prevent mutations', () => {
		const originalLogs = [createMockLog({ text: 'Original' })];
		const tab = createMockTab({ logs: originalLogs });
		const session = createMockSession();

		const context = extractTabContext(tab, 'Project', session);

		// Modifying the context logs should not affect the original
		context.logs.push(createMockLog({ text: 'Added' }));
		expect(originalLogs).toHaveLength(1);
		expect(context.logs).toHaveLength(2);
	});
});

describe('formatLogsForClipboard', () => {
	it('includes user and assistant entries only by default', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'How do I implement X?' }),
			createMockLog({ source: 'thinking', text: 'The user wants...' }),
			createMockLog({ source: 'ai', text: 'Use the foo helper.' }),
			createMockLog({ source: 'tool', text: 'Reading file...' }),
			createMockLog({ source: 'system', text: 'system prompt' }),
		];

		const result = formatLogsForClipboard(logs);

		expect(result).toBe('USER:\nHow do I implement X?\n\nASSISTANT:\nUse the foo helper.');
		expect(result).not.toContain('THINKING');
		expect(result).not.toContain('The user wants');
	});

	it('treats ai and stdout sources as ASSISTANT entries', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'ai', text: 'first response' }),
			createMockLog({ source: 'stdout', text: 'second response' }),
		];

		const result = formatLogsForClipboard(logs);

		expect(result).toBe('ASSISTANT:\nfirst response\n\nASSISTANT:\nsecond response');
	});

	it('includes THINKING entries when includeThinking is true', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'Why?' }),
			createMockLog({ source: 'thinking', text: 'Considering the options...' }),
			createMockLog({ source: 'ai', text: 'Because Y.' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe(
			'USER:\nWhy?\n\nTHINKING:\nConsidering the options...\n\nASSISTANT:\nBecause Y.'
		);
	});

	it('still excludes tool/system/stderr entries when includeThinking is true', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'thinking', text: 'reasoning' }),
			createMockLog({ source: 'tool', text: 'tool call' }),
			createMockLog({ source: 'stderr', text: 'stderr noise' }),
			createMockLog({ source: 'system', text: 'system note' }),
			createMockLog({ source: 'error', text: 'failure' }),
			createMockLog({ source: 'ai', text: 'response' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe('USER:\nhi\n\nTHINKING:\nreasoning\n\nASSISTANT:\nresponse');
	});

	it('skips empty entries even when their source is included', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'real message' }),
			createMockLog({ source: 'thinking', text: '   ' }),
			createMockLog({ source: 'thinking', text: '' }),
			createMockLog({ source: 'ai', text: 'reply' }),
		];

		const result = formatLogsForClipboard(logs, { includeThinking: true });

		expect(result).toBe('USER:\nreal message\n\nASSISTANT:\nreply');
	});

	it('returns an empty string when no entries qualify', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'system', text: 'noise' }),
			createMockLog({ source: 'tool', text: 'tool call' }),
		];

		expect(formatLogsForClipboard(logs)).toBe('');
	});
});

describe('hasThinkingEntries', () => {
	it('returns true when any entry has source "thinking" and non-empty text', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'thinking', text: 'reasoning' }),
		];
		expect(hasThinkingEntries(logs)).toBe(true);
	});

	it('returns false when no thinking entries exist', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'hi' }),
			createMockLog({ source: 'ai', text: 'hi back' }),
		];
		expect(hasThinkingEntries(logs)).toBe(false);
	});

	it('returns false when thinking entries are blank', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'thinking', text: '' }),
			createMockLog({ source: 'thinking', text: '   ' }),
		];
		expect(hasThinkingEntries(logs)).toBe(false);
	});

	it('returns false for undefined and null inputs', () => {
		expect(hasThinkingEntries(undefined)).toBe(false);
		expect(hasThinkingEntries(null)).toBe(false);
	});
});

describe('formatLogsForGrooming', () => {
	it('should format logs with proper markdown headers', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'How do I implement X?' }),
			createMockLog({ source: 'ai', text: 'To implement X, you should...' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).toContain('## User');
		expect(result).toContain('How do I implement X?');
		expect(result).toContain('## Assistant');
		expect(result).toContain('To implement X, you should...');
	});

	it('should skip empty log entries', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'Hello' }),
			createMockLog({ source: 'system', text: '' }),
			createMockLog({ source: 'ai', text: 'Hi!' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result.match(/## /g)).toHaveLength(2);
	});

	it('should skip internal system messages', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'system', text: 'Connecting...' }),
			createMockLog({ source: 'system', text: 'Session started at 10:00' }),
			createMockLog({ source: 'user', text: 'Hello' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).not.toContain('Connecting');
		expect(result).not.toContain('Session started');
		expect(result).toContain('Hello');
	});

	it('should map all source types correctly', () => {
		const logs: LogEntry[] = [
			createMockLog({ source: 'user', text: 'User message' }),
			createMockLog({ source: 'ai', text: 'AI response' }),
			createMockLog({ source: 'error', text: 'Error message' }),
			createMockLog({ source: 'stdout', text: 'Output message' }),
			createMockLog({ source: 'stderr', text: 'Stderr message' }),
		];

		const result = formatLogsForGrooming(logs);

		expect(result).toContain('## User');
		expect(result).toContain('## Assistant');
		expect(result).toContain('## Error');
		expect(result).toContain('## Output');
		expect(result).toContain('## Error Output');
	});

	describe('file content stripping', () => {
		it('should strip full file contents from code blocks with file paths', () => {
			// 'line\n'.repeat(20) creates "line\n" 20 times, which when split by \n gives 21 elements
			// (20 "line" elements + 1 empty string from trailing newline)
			const fileContent = 'line\n'.repeat(20);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Here's the file:\n\`\`\`typescript:src/utils/helper.ts\n${fileContent}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[File: src/utils/helper.ts');
			expect(result).toContain('21 lines');
			expect(result).toContain('content available on disk');
			expect(result).not.toContain(fileContent);
		});

		it('should preserve small code snippets (under 15 lines)', () => {
			const smallSnippet = 'const x = 1;\nconst y = 2;\n';
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Example:\n\`\`\`typescript:src/example.ts\n${smallSnippet}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			// Small snippets should be preserved
			expect(result).toContain(smallSnippet);
			expect(result).not.toContain('content available on disk');
		});

		it('should handle Read tool output patterns', () => {
			const fileContent = 'line\n'.repeat(25);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Contents of /Users/test/project/src/main.ts:\n\`\`\`typescript\n${fileContent}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[Read: /Users/test/project/src/main.ts');
			expect(result).toContain('content available on disk');
		});

		it('should preserve code blocks without file paths', () => {
			const codeExample = 'function example() {\n  return 42;\n}\n'.repeat(10);
			const logs: LogEntry[] = [
				createMockLog({
					source: 'ai',
					text: `Here's how to do it:\n\`\`\`typescript\n${codeExample}\`\`\``,
				}),
			];

			const result = formatLogsForGrooming(logs);

			// Code blocks without file paths should be preserved
			expect(result).toContain(codeExample);
		});
	});

	describe('image stripping', () => {
		it('should strip all images by default (maxImageTokens = 0)', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Check this screenshot',
					images: ['/path/to/image1.png', '/path/to/image2.png'],
					timestamp: 1000,
				}),
			];

			const result = formatLogsForGrooming(logs);

			expect(result).toContain('[Note: 2 image(s) stripped');
			expect(result).toContain('Images can be re-referenced by path');
		});

		it('should strip oldest images first when over budget', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Old image',
					images: ['/path/to/old.png'],
					timestamp: 1000, // oldest
				}),
				createMockLog({
					source: 'user',
					text: 'New image',
					images: ['/path/to/new.png'],
					timestamp: 2000, // newer
				}),
			];

			// Allow 1500 tokens (1 image worth)
			const result = formatLogsForGrooming(logs, { maxImageTokens: 1500 });

			// Should strip 1 image (the oldest one)
			expect(result).toContain('[Note: 1 image(s) stripped');
		});

		it('should not add note when no images present', () => {
			const logs: LogEntry[] = [createMockLog({ source: 'user', text: 'No images here' })];

			const result = formatLogsForGrooming(logs);

			expect(result).not.toContain('image(s) stripped');
		});

		it('should keep all images when under budget', () => {
			const logs: LogEntry[] = [
				createMockLog({
					source: 'user',
					text: 'Single image',
					images: ['/path/to/image.png'],
					timestamp: 1000,
				}),
			];

			// Allow 5000 tokens (more than 1 image)
			const result = formatLogsForGrooming(logs, { maxImageTokens: 5000 });

			expect(result).not.toContain('image(s) stripped');
		});
	});
});

describe('parseGroomedOutput', () => {
	it('should parse structured groomed output back to log entries', () => {
		const groomedText = `## User
How do I implement X?

## Assistant
To implement X, follow these steps:
1. First step
2. Second step`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs).toHaveLength(2);
		expect(logs[0].source).toBe('user');
		expect(logs[0].text).toContain('How do I implement X?');
		expect(logs[1].source).toBe('ai');
		expect(logs[1].text).toContain('First step');
	});

	it('should treat unstructured text as a single AI message', () => {
		const groomedText = `This is a summary of the conversation.
Key points:
- Point 1
- Point 2`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs).toHaveLength(1);
		expect(logs[0].source).toBe('ai');
		expect(logs[0].text).toContain('Key points');
	});

	it('should handle empty input', () => {
		const logs = parseGroomedOutput('');

		expect(logs).toHaveLength(0);
	});

	it('should handle whitespace-only input', () => {
		const logs = parseGroomedOutput('   \n\n   ');

		expect(logs).toHaveLength(0);
	});

	it('should map various header formats to correct sources', () => {
		const groomedText = `## AI Response
First

## User Input
Second

## Error Log
Third

## System Info
Fourth`;

		const logs = parseGroomedOutput(groomedText);

		expect(logs[0].source).toBe('ai');
		expect(logs[1].source).toBe('user');
		expect(logs[2].source).toBe('error');
		expect(logs[3].source).toBe('system');
	});
});

describe('estimateTokenCount', () => {
	it('should use usage stats when available', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [],
			agentType: 'claude-code',
			usageStats: {
				inputTokens: 500,
				outputTokens: 1000,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 200,
				costUsd: 0.05,
			},
		};

		const tokens = estimateTokenCount(context);

		expect(tokens).toBe(700); // input + cacheCreation (cacheRead excluded - cumulative)
	});

	it('should estimate from log content when no usage stats', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [
				createMockLog({ text: 'A'.repeat(400) }), // ~100 tokens
				createMockLog({ text: 'B'.repeat(400) }), // ~100 tokens
			],
			agentType: 'claude-code',
		};

		const tokens = estimateTokenCount(context);

		// 800 chars / 4 chars per token = 200 tokens
		expect(tokens).toBe(200);
	});

	it('should account for image attachments', () => {
		const context: ContextSource = {
			type: 'tab',
			sessionId: 'session-1',
			projectRoot: '/project',
			name: 'Test',
			logs: [
				createMockLog({
					text: 'Check this image',
					images: ['base64imagedata1', 'base64imagedata2'],
				}),
			],
			agentType: 'claude-code',
		};

		const tokens = estimateTokenCount(context);

		// Should include both text and image overhead
		expect(tokens).toBeGreaterThan(3000); // 2 images * 1500 tokens each
	});
});

describe('estimateTextTokenCount', () => {
	it('should estimate tokens from text length', () => {
		const text = 'A'.repeat(400); // 400 chars

		const tokens = estimateTextTokenCount(text);

		expect(tokens).toBe(100); // 400 / 4 = 100
	});

	it('should round up partial tokens', () => {
		const text = 'A'.repeat(401); // 401 chars

		const tokens = estimateTextTokenCount(text);

		expect(tokens).toBe(101); // ceil(401 / 4) = 101
	});
});

describe('findDuplicateContent', () => {
	it('should detect exact duplicate log entries', () => {
		const longText =
			'This is a longer message that exceeds the minimum length for duplicate detection. '.repeat(
				3
			);

		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: longText })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: longText })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(1);
		expect(result.duplicates[0].sourceIndex).toBe(1);
		expect(result.estimatedSavings).toBeGreaterThan(0);
	});

	it('should ignore short messages', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: 'Short' })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: 'Short' })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(0);
	});

	it('should detect duplicate code blocks', () => {
		const codeBlock = '```typescript\n' + 'const x = 1;\n'.repeat(20) + '```';

		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog({ text: `Here's the code:\n${codeBlock}` })],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog({ text: `Same code:\n${codeBlock}` })],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		// Should find duplicate code block
		expect(result.estimatedSavings).toBeGreaterThan(0);
	});

	it('should return empty results for unique content', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [
					createMockLog({
						text: 'Unique message one that is long enough to be considered for deduplication purposes',
					}),
				],
				agentType: 'claude-code',
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [
					createMockLog({
						text: 'Different unique message two that is also long enough for deduplication consideration',
					}),
				],
				agentType: 'claude-code',
			},
		];

		const result = findDuplicateContent(contexts);

		expect(result.duplicates).toHaveLength(0);
		expect(result.estimatedSavings).toBe(0);
	});
});

describe('calculateTotalTokens', () => {
	it('should sum tokens across all contexts', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 100,
					outputTokens: 200,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
			{
				type: 'tab',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 300,
					outputTokens: 400,
					cacheReadInputTokens: 75,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
		];

		const total = calculateTotalTokens(contexts);

		// input + cacheRead + cacheCreation for each context
		expect(total).toBe(575); // (100+50+25) + (300+75+25)
	});
});

describe('getContextSummary', () => {
	it('should return accurate summary statistics', () => {
		const contexts: ContextSource[] = [
			{
				type: 'tab',
				sessionId: 'session-1',
				projectRoot: '/project',
				name: 'Context 1',
				logs: [createMockLog(), createMockLog()],
				agentType: 'claude-code',
				usageStats: {
					inputTokens: 100,
					outputTokens: 100,
					cacheReadInputTokens: 50,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
			{
				type: 'session',
				sessionId: 'session-2',
				projectRoot: '/project',
				name: 'Context 2',
				logs: [createMockLog(), createMockLog(), createMockLog()],
				agentType: 'opencode',
				usageStats: {
					inputTokens: 200,
					outputTokens: 200,
					cacheReadInputTokens: 75,
					cacheCreationInputTokens: 25,
					costUsd: 0,
				},
			},
		];

		const summary = getContextSummary(contexts);

		expect(summary.totalSources).toBe(2);
		expect(summary.totalLogs).toBe(5);
		// (100+50+25) + (200+75+25) = 475 (input + cacheRead + cacheCreation)
		expect(summary.estimatedTokens).toBe(475);
		expect(summary.byAgent['claude-code']).toBe(1);
		expect(summary.byAgent['opencode']).toBe(1);
	});
});
