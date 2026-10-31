/**
 * Grok CLI Session Storage Implementation
 *
 * Grok stores each session as a directory:
 *   ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
 *     summary.json       - session metadata (id, cwd, title, timestamps, counts)
 *     chat_history.jsonl - the transcript (system/user/assistant/tool_result/reasoning records)
 *
 * The first-level folder name is the session's working directory with `/`
 * percent-encoded as `%2F`, so project filtering happens on directory names
 * before any file is opened. Structurally this mirrors Copilot's
 * directory-per-session layout (metadata file beside a JSONL transcript),
 * so this implementation follows `copilot-session-storage.ts`, borrowing
 * only the tool_call/tool_result merge pattern from Codex.
 *
 * Grok's transcript records carry no per-message timestamps (left empty). Token
 * and cost totals come from the session's `usage.json` (grok 1.x).
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { readFileRemote, readDirRemote, statRemote } from '../utils/remote-fs';
import {
	mapWithConcurrency,
	LOCAL_SESSION_READ_CONCURRENCY,
	REMOTE_SESSION_READ_CONCURRENCY,
} from '../utils/concurrency';
import type {
	AgentSessionInfo,
	SessionMessagesResult,
	SessionReadOptions,
	SessionMessage,
	SessionListOptions,
	PaginatedSessionsResult,
	SessionSearchMode,
	SessionSearchResult,
} from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { resolveAgentAccountDir } from '../../shared/agentAccountDir';
import { isMacOS } from '../../shared/platformDetection';
import { BaseSessionStorage } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';
import { isExpectedRemoteError } from './remote-error-utils';
import { isExpectedSessionReadError } from '../utils/session-read-errors';
import type { ModelTokenUsage } from '../../shared/tokenUsage';
import { normalizeModelId } from '../../shared/modelPricing';
import { parseNativeLines } from '../../shared/maestro-lib/translation/native-records';
import { compactToolOutput } from '../../shared/toolOutput';
import { isInlineImageDataUrl } from './session-image-store';

const LOG_CONTEXT = '[GrokSessionStorage]';
const MAX_SESSION_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const FIRST_MESSAGE_PREVIEW_LENGTH = 200;

/**
 * Native IDs are opaque directory names, not necessarily UUIDs. Validate each
 * untrusted path component before joining it; never decode or sanitize an ID
 * into a different session's name. Encoded cwd folders use this check too.
 */
function isSafeGrokPathSegment(name: string): boolean {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name !== '.' &&
		name !== '..' &&
		!name.includes('/') &&
		!name.includes('\\') &&
		!name.includes('\0')
	);
}

/** Shape of summary.json (the fields this storage consumes). */
interface GrokSessionSummary {
	session_summary?: string;
	generated_title?: string;
	created_at?: string;
	updated_at?: string;
	git_root_dir?: string;
}

/** Token totals as `usage.json` records them, per session and per model. */
interface GrokUsageTotals {
	/** INCLUDES cached reads, unlike the stream's `input_tokens`. */
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cacheCreationTokens?: number;
	/** USD x 1e10 (verified: 207651600 ticks == total_cost_usd 0.02076516). */
	costUsdTicks?: number;
}

/** Shape of usage.json (grok 1.x; absent on 0.x sessions). */
interface GrokUsageFile {
	session?: GrokUsageTotals & { modelUsage?: Record<string, GrokUsageTotals> };
}

const COST_TICKS_PER_USD = 1e10;

const nonNegative = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Session tokens in Maestro's convention: `inputTokens` EXCLUDES cache reads,
 * the way the live stream reports them, so the dashboard's `input + cacheRead`
 * does not count cached tokens twice.
 */
function toSessionTokens(totals: GrokUsageTotals) {
	const cacheReadTokens = nonNegative(totals.cachedReadTokens);
	const cacheCreationTokens = nonNegative(totals.cacheCreationTokens);
	return {
		inputTokens: Math.max(
			0,
			nonNegative(totals.inputTokens) - cacheReadTokens - cacheCreationTokens
		),
		outputTokens: nonNegative(totals.outputTokens),
		cacheReadTokens,
		cacheCreationTokens,
		// Undefined, not 0, when the file names no cost: a provider that reports
		// tokens but no cost (a grok-compatible custom binary) must read as unknown, not free.
		costUsd:
			typeof totals.costUsdTicks === 'number'
				? nonNegative(totals.costUsdTicks) / COST_TICKS_PER_USD
				: undefined,
	};
}

/** Session totals plus a per-model split from usage.json, or null if unreadable. */
export function parseGrokUsageFile(
	content: string | null
): (ReturnType<typeof toSessionTokens> & { byModel: ModelTokenUsage[] }) | null {
	if (!content) return null;
	let parsed: GrokUsageFile;
	try {
		parsed = JSON.parse(content) as GrokUsageFile;
	} catch {
		return null;
	}
	if (!parsed.session || typeof parsed.session !== 'object') return null;
	const byModel = Object.entries(parsed.session.modelUsage ?? {}).map(([model, totals]) => ({
		model: normalizeModelId(model),
		...toSessionTokens(totals),
		costUsd: toSessionTokens(totals).costUsd ?? 0,
		costEstimated: typeof totals.costUsdTicks !== 'number',
	}));
	return { ...toSessionTokens(parsed.session), byModel };
}

/** A tool call entry on an assistant transcript record. */
interface GrokToolCall {
	id?: string;
	name?: string;
	/** JSON-encoded argument string. */
	arguments?: string;
	/** Legacy Chat Completions layout. */
	function?: { name?: string; arguments?: string };
}

/** One line of chat_history.jsonl. */
interface GrokChatRecord {
	type?: string;
	role?: string;
	/** String for system/assistant/tool_result records; `{type:'text',text}` block array for user records. */
	content?: unknown;
	/** Present on injected-context user records (e.g. project_instructions, system_reminder). */
	synthetic_reason?: string;
	tool_calls?: GrokToolCall[];
	tool_call_id?: string;
	images?: unknown;
	summary?: unknown;
	reasoning?: { text?: string };
	reasoning_content?: string;
	raw_output?: unknown[];
}

/** Tool use entry shape used when building SessionMessage.toolUse arrays. */
interface GrokToolUseEntry {
	id?: string;
	resultSource?: SessionMessage['native'];
	tool?: string;
	args?: unknown;
	state: {
		status: string;
		input?: unknown;
		output?: string;
	};
}

interface ParsedGrokChatHistory {
	messages: SessionMessage[];
	firstUserMessage: string;
	firstAssistantMessage: string;
}

/** Extract plain text from a user record's content block array. */
function extractUserText(content: unknown, separator = ' '): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) =>
			block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
				? (block as { text: string }).text
				: ''
		)
		.filter((text) => text.trim())
		.join(separator);
}

/**
 * Check whether a user record is injected context rather than a real prompt.
 * Grok flags most context injections with `synthetic_reason`; the environment
 * block at the start of every session is a plain user record wrapped in
 * `<user_info>` tags instead.
 */
function isSyntheticUserRecord(record: GrokChatRecord, text: string): boolean {
	if (
		['human', 'interjection', 'parent_human_message', 'direct_bash'].includes(
			record.synthetic_reason ?? ''
		)
	)
		return false;
	if (record.synthetic_reason) return true;
	return text.trim().startsWith('<user_info>');
}

/** Strip `<user_query>` wrappers Grok adds around real prompt text.
 *  Joins all blocks if a turn embeds multiple wrappers (non-greedy match). */
function stripUserQueryWrapper(text: string): string {
	const matches = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)];
	if (matches.length === 0) return text.trim();
	return matches
		.map((m) => m[1])
		.filter((part) => part.trim().length > 0)
		.join('\n\n');
}

/**
 * Normalize a path for comparison: strip trailing slashes and fold the local macOS
 * `/private` symlink prefix (`/private/var` == `/var`, `/private/tmp` ==
 * `/tmp`) since Grok records the realpath'd cwd while Maestro may pass the
 * symlinked form.
 */
function normalizePathForComparison(value: string, isRemote: boolean): string {
	let normalized = value.replace(/\/+$/, '');
	if (!normalized) normalized = '/';
	// The remote may have distinct /var and /private/var directories. Do not
	// infer its aliases from the desktop's filesystem or operating system.
	return isRemote ? normalized : normalized.replace(/^\/private(\/(?:var|tmp|etc))(\/|$)/, '$1$2');
}

/**
 * Convert a project path to the cwd form Grok records on disk (the inverse of
 * normalizePathForComparison). Grok stores the realpath'd cwd, so on macOS the
 * symlinked `/var`, `/tmp`, and `/etc` prefixes must be expanded back to
 * `/private/...` before percent-encoding. The remote OS is unknown over SSH,
 * so remote paths are left untouched apart from trailing-slash cleanup.
 */
function toGrokRecordedCwd(projectPath: string, isRemote: boolean): string {
	let normalized = projectPath.replace(/\/+$/, '');
	if (!normalized) normalized = '/';
	if (!isRemote && isMacOS()) {
		normalized = normalized.replace(/^(\/(?:var|tmp|etc))(\/|$)/, '/private$1$2');
	}
	return normalized;
}

/** Check whether a session cwd belongs to the given project (exact match or subdirectory). */
function matchesProject(cwd: string, projectPath: string, isRemote: boolean): boolean {
	const normalizedCwd = normalizePathForComparison(cwd, isRemote);
	const normalizedProject = normalizePathForComparison(projectPath, isRemote);
	return (
		normalizedCwd === normalizedProject ||
		normalizedCwd.startsWith(normalizedProject === '/' ? '/' : `${normalizedProject}/`)
	);
}

/**
 * Convert an assistant record's tool calls into a normalized tool-use array.
 *
 * `args` stays the raw JSON string from the transcript (Codex-compatible shape).
 * Consumers must use `state.input` for the parsed object, not assume `args` is
 * already an object (History UI / tool cards).
 */
function buildToolUse(toolCalls?: GrokToolCall[]): GrokToolUseEntry[] | undefined {
	if (!toolCalls?.length) return undefined;
	const entries = toolCalls
		.filter((call) => call && typeof call === 'object')
		.map((call) => {
			const fields = call.function ?? call;
			const args = typeof fields.arguments === 'string' ? fields.arguments : undefined;
			let input: unknown;
			try {
				input = JSON.parse(args || '{}');
			} catch {
				input = args;
			}
			return {
				id: typeof call.id === 'string' && call.id ? call.id : undefined,
				tool: typeof fields.name === 'string' ? fields.name : undefined,
				// Raw JSON string on purpose - see JSDoc above.
				args,
				state: { status: 'unknown', input },
			};
		});
	return entries.length > 0 ? entries : undefined;
}

/** Extract native image references without opening paths or fetching URLs. */
function extractImageReferences(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!block || typeof block !== 'object') return [];
		const url =
			block.type === 'image'
				? block.url
				: block.type === 'image_url'
					? block.image_url?.url
					: undefined;
		return typeof url === 'string' ? [url] : [];
	});
}

/**
 * Parse both native ConversationItem and legacy Chat Completions rows. Physical
 * line identities survive pagination and appended records; they are not resume IDs.
 * The export view retains every nonblank source row, including malformed JSON.
 * The display view folds results into badges and hides context/reasoning rows.
 */
function parseChatHistory(content: string, includeNativeRecords = false): ParsedGrokChatHistory {
	const messages: SessionMessage[] = [];
	const hidden = new Set<SessionMessage>();
	let firstUserMessage = '';
	let firstAssistantMessage = '';
	const calls = new Map<string, Array<{ call: GrokToolUseEntry; message: SessionMessage }>>();
	const results = new Map<string, SessionMessage[]>();

	const lines = parseNativeLines(content);
	const backendIds = new Set<string>(
		lines.flatMap(({ entry }) =>
			entry?.type === 'backend_tool_call' && typeof entry.kind?.id === 'string'
				? [entry.kind.id]
				: []
		)
	);
	for (const { line, index, entry, malformed } of lines) {
		const record = (entry ?? {}) as GrokChatRecord;
		const kind = record.type ?? record.role;
		const native: NonNullable<SessionMessage['native']> = {
			provider: 'grok',
			line: index + 1,
			...(includeNativeRecords ? { raw: line } : {}),
		};
		const message: SessionMessage = {
			type: kind ?? 'unknown',
			role: kind ?? 'unknown',
			content: extractUserText(record.content),
			timestamp: '',
			uuid: `grok-line-${index + 1}`,
			native,
		};
		// Native rows have no timestamps. Keep unknown metadata in raw evidence,
		// rather than manufacturing a clock or attempting to decrypt reasoning.
		if (malformed) {
			message.type = message.role = 'unknown';
			message.content = '[Unreadable Grok transcript record retained for export]';
			native.issues = ['malformed-record'];
		} else if (kind === 'user') {
			const synthetic = isSyntheticUserRecord(record, message.content);
			message.imageReferences = extractImageReferences(record.content);
			message.images = message.imageReferences.filter(isInlineImageDataUrl);
			if (synthetic) hidden.add(message);
			else {
				message.content = stripUserQueryWrapper(message.content);
				firstUserMessage ||= message.content;
			}
		} else if (kind === 'assistant') {
			const toolUse = buildToolUse(
				Array.isArray(record.tool_calls) ? record.tool_calls : undefined
			);
			message.toolUse = toolUse;
			for (const call of toolUse ?? []) {
				if (call.id) {
					const siblings = calls.get(call.id) ?? [];
					siblings.push({ call, message });
					calls.set(call.id, siblings);
				} else native.issues = [...(native.issues ?? []), 'missing-tool-call-id'];
			}
			firstAssistantMessage ||= message.content;
			// Native upgrades place legacy reasoning/backend items before their
			// assistant. Preserve that order, with deterministic source-line suffixes.
			const legacy = Array.isArray(record.raw_output)
				? record.raw_output.filter((item): item is Record<string, unknown> =>
						Boolean(
							item &&
							typeof item === 'object' &&
							[
								'reasoning',
								'web_search_call',
								'custom_tool_call',
								'code_interpreter_call',
							].includes((item as { type: string }).type)
						)
					)
				: [];
			if (
				!Array.isArray(record.raw_output) &&
				(record.reasoning || typeof record.reasoning_content === 'string')
			) {
				legacy.push({
					type: 'reasoning',
					content: record.reasoning?.text ?? record.reasoning_content ?? '',
				});
			}
			for (const [part, item] of legacy.entries()) {
				if (item.type !== 'reasoning' && typeof item.id === 'string') {
					if (backendIds.has(item.id)) continue;
					backendIds.add(item.id);
				}
				const sibling: SessionMessage = {
					type: item.type === 'reasoning' ? 'reasoning' : 'backend_tool_call',
					role: 'assistant',
					content: [extractUserText(item.summary, '\n'), extractUserText(item.content, '\n')]
						.filter(Boolean)
						.join('\n'),
					timestamp: '',
					uuid: `${message.uuid}-legacy-${part}`,
					// The original assistant owns raw bytes; this is a projection of that row.
					native: { provider: native.provider, line: native.line },
				};
				messages.push(sibling);
				hidden.add(sibling);
			}
		} else if (kind === 'tool_result' || kind === 'tool') {
			message.type = 'tool_result';
			message.role = 'tool';
			message.imageReferences = [
				...extractImageReferences(record.content),
				...extractImageReferences(record.images),
			];
			message.images = message.imageReferences.filter(isInlineImageDataUrl);
			message.toolCallId =
				typeof record.tool_call_id === 'string' ? record.tool_call_id : undefined;
			if (message.toolCallId) {
				const siblings = results.get(message.toolCallId) ?? [];
				siblings.push(message);
				results.set(message.toolCallId, siblings);
			} else native.issues = ['missing-tool-call-id'];
		} else if (kind === 'reasoning') {
			message.role = 'assistant';
			message.content = [
				extractUserText(record.summary, '\n'),
				extractUserText(record.content, '\n'),
			]
				.filter(Boolean)
				.join('\n');
			hidden.add(message);
		} else if (kind === 'system' || kind === 'backend_tool_call') {
			message.role = kind === 'system' ? 'system' : 'assistant';
			hidden.add(message);
		} else {
			message.type = message.role = 'unknown';
			message.content = '[Unknown Grok transcript record retained for export]';
			native.issues = ['unknown-record'];
		}
		if (
			(kind === 'user' || kind === 'assistant') &&
			!message.content.trim() &&
			!(message.toolUse as GrokToolUseEntry[] | undefined)?.length &&
			!message.imageReferences?.length
		) {
			hidden.add(message);
		}
		messages.push(message);
	}

	// Pair only unambiguous IDs, never by arrival adjacency or tool name. Keep
	// every result in the native view even when the display badge folds it in.
	for (const entries of calls.values()) {
		if (entries.length > 1) {
			for (const { message } of entries) {
				message.native!.issues = [...(message.native!.issues ?? []), 'duplicate-tool-call-id'];
			}
		}
	}
	for (const [id, rows] of results) {
		const entries = calls.get(id);
		const row = rows[0];
		const target = entries?.[0];
		const callMessage = target?.message;
		if (
			entries?.length === 1 &&
			target &&
			rows.length === 1 &&
			callMessage?.native &&
			row.native &&
			callMessage.native.line < row.native.line
		) {
			target.call.state = {
				...target.call.state,
				status: 'completed',
				...(includeNativeRecords
					? {}
					: { output: compactToolOutput(row.content).output as string }),
			};
			target.call.resultSource = { provider: row.native.provider, line: row.native.line };
			if (!includeNativeRecords) {
				callMessage.imageReferences = [
					...(callMessage.imageReferences ?? []),
					...(row.imageReferences ?? []),
				];
				callMessage.images = [...(callMessage.images ?? []), ...(row.images ?? [])];
			}
			hidden.add(row);
		} else {
			for (const result of rows) result.native!.issues = ['ambiguous-or-missing-tool-call'];
		}
	}
	return {
		messages: includeNativeRecords ? messages : messages.filter((message) => !hidden.has(message)),
		firstUserMessage,
		firstAssistantMessage,
	};
}

/**
 * Session storage implementation for Grok CLI.
 *
 * Reads session metadata from `~/.grok/sessions/<encoded-cwd>/<sessionId>/summary.json`
 * and conversation history from `chat_history.jsonl`. Supports both local and
 * SSH remote access. The derived `session_search.sqlite` index is intentionally
 * ignored - the transcript files are authoritative.
 */
export class GrokSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'grok';

	/** Immutable account scope lets inherited search reuse the same root for every read. */
	constructor(private readonly accountDir?: string) {
		super();
	}

	private getAccountDir(sshConfig?: SshRemoteConfig, accountDir = this.accountDir): string {
		return (
			resolveAgentAccountDir(
				{
					toolType: this.agentId,
					sshRemote: Boolean(sshConfig),
					customEnvVars: accountDir !== undefined ? { GROK_HOME: accountDir } : undefined,
				},
				{
					homeDir: sshConfig ? '' : os.homedir(),
					// Explicit blanks select the provider default, never the host's account.
					env: !sshConfig && accountDir === undefined ? process.env : undefined,
				}
			) ?? '~/.grok'
		);
	}

	/** Resolve the sessions base directory (local or remote POSIX tilde form). */
	private getSessionsDir(sshConfig?: SshRemoteConfig, accountDir = this.accountDir): string {
		return this.joinPath(sshConfig, this.getAccountDir(sshConfig, accountDir), 'sessions');
	}

	/** Join path segments with the separator style matching local vs remote access. */
	private joinPath(sshConfig: SshRemoteConfig | undefined, ...segments: string[]): string {
		return sshConfig ? path.posix.join(...segments) : path.join(...segments);
	}

	/** Decode a percent-encoded cwd folder name. Returns null for malformed encodings. */
	private decodeCwdFolder(name: string): string | null {
		if (!isSafeGrokPathSegment(name)) return null;
		try {
			const decoded = decodeURIComponent(name);
			// Native cwd folders encode realpaths. Dot components would let
			// /project/../other pass the project-prefix filter as a descendant.
			if (decoded.includes('\0') || /(?:^|[/\\])\.{1,2}(?:[/\\]|$)/.test(decoded)) {
				return null;
			}
			return decoded;
		} catch (error) {
			if (error instanceof URIError) return null;
			throw error;
		}
	}

	/** List subdirectory names of a directory, locally or over SSH. Missing directories yield []. */
	private async listSubdirectories(
		dirPath: string,
		sshConfig: SshRemoteConfig | undefined,
		operation: string
	): Promise<string[]> {
		if (sshConfig) {
			const result = await readDirRemote(dirPath, sshConfig);
			if (!result.success || !result.data) {
				if (!isExpectedRemoteError(result.error)) {
					logger.warn(`Unexpected SSH failure listing ${dirPath}: ${result.error}`, LOG_CONTEXT);
					captureException(new Error(result.error || 'readDirRemote failed'), {
						operation,
						dirPath,
					});
				}
				return [];
			}
			return result.data.filter((entry) => entry.isDirectory).map((entry) => entry.name);
		}

		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			if (!isExpectedSessionReadError(error)) {
				captureException(error, { operation, dirPath });
			}
			return [];
		}
	}

	/**
	 * List cwd folders under the sessions directory whose decoded name matches
	 * the project path. Filtering on folder names avoids opening any session
	 * file for non-matching projects.
	 */
	private async listMatchingCwdFolders(
		projectPath: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string[]> {
		const folders = await this.listSubdirectories(
			sessionsDir,
			sshConfig,
			'grokStorage:listCwdFolders'
		);
		return folders.filter((name) => {
			const decoded = this.decodeCwdFolder(name);
			return decoded !== null && matchesProject(decoded, projectPath, Boolean(sshConfig));
		});
	}

	/** List safe native session directories (skips prompt_history.jsonl, a file). */
	private async listSessionIds(
		cwdFolder: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string[]> {
		if (this.decodeCwdFolder(cwdFolder) === null) return [];
		const sessionIds = await this.listSubdirectories(
			this.joinPath(sshConfig, sessionsDir, cwdFolder),
			sshConfig,
			'grokStorage:listSessionIds'
		);
		return sessionIds.filter(isSafeGrokPathSegment);
	}

	/** List all Grok sessions matching the given project path, newest first. */
	async listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): Promise<AgentSessionInfo[]> {
		const sessionsDir = this.getSessionsDir(sshConfig, accountDir);
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sessionsDir, sshConfig);

		const sessionRefs: Array<{ cwdFolder: string; sessionId: string }> = [];
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sessionsDir, sshConfig);
			for (const sessionId of sessionIds) {
				sessionRefs.push({ cwdFolder, sessionId });
			}
		}

		// Bound the per-session fan-out: over SSH so many sessions don't burst
		// past sshd's MaxStartups connection cap, and locally so a large
		// ~/.grok/sessions folder doesn't open hundreds of transcripts at once.
		const sessions = await mapWithConcurrency(
			sessionRefs,
			sshConfig ? REMOTE_SESSION_READ_CONCURRENCY : LOCAL_SESSION_READ_CONCURRENCY,
			(ref) => this.loadSessionInfo(ref.cwdFolder, ref.sessionId, sessionsDir, sshConfig)
		);

		return sessions
			.filter((session): session is AgentSessionInfo => session !== null)
			.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
	}

	async listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions,
		sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult> {
		const sessions = await this.listSessions(projectPath, sshConfig, options?.configDir);
		return BaseSessionStorage.paginateSessions(sessions, options);
	}

	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): Promise<SessionSearchResult[]> {
		if (accountDir !== undefined) {
			// Base search has no account argument. Bind one immutable reader so
			// metadata and messages agree without mutating the registered storage.
			const scoped = new GrokSessionStorage(this.getAccountDir(sshConfig, accountDir));
			return scoped.searchSessions(projectPath, query, searchMode, sshConfig);
		}
		return super.searchSessions(projectPath, query, searchMode, sshConfig);
	}

	/** Load metadata and transcript-derived info for a single session. */
	private async loadSessionInfo(
		cwdFolder: string,
		sessionId: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo | null> {
		const cwd = this.decodeCwdFolder(cwdFolder);
		if (cwd === null || !isSafeGrokPathSegment(sessionId)) return null;
		const sessionDir = this.joinPath(sshConfig, sessionsDir, cwdFolder, sessionId);
		try {
			const summaryContent = await this.readSessionFile(
				this.joinPath(sshConfig, sessionDir, 'summary.json'),
				sshConfig
			);
			if (!summaryContent) return null;

			let summary: GrokSessionSummary;
			try {
				summary = JSON.parse(summaryContent) as GrokSessionSummary;
			} catch {
				logger.debug(`Skipping Grok session ${sessionId} with malformed summary.json`, LOG_CONTEXT);
				return null;
			}

			const transcript = await this.readTranscript(sessionDir, sshConfig);
			if (!transcript) return null;

			const parsed = parseChatHistory(transcript.content);
			if (parsed.messages.length === 0) {
				// Never-prompted sessions exist on disk with only system/synthetic records.
				logger.debug(
					`Skipping Grok session ${sessionId} with no conversation messages`,
					LOG_CONTEXT
				);
				return null;
			}

			const title = summary.session_summary || summary.generated_title || '';
			const fileMtime = new Date(transcript.mtimeMs).toISOString();
			const timestamp = summary.created_at || fileMtime;
			const modifiedAt = summary.updated_at || fileMtime;
			const createdMs = Date.parse(timestamp);
			const modifiedMs = Date.parse(modifiedAt);
			const durationSeconds =
				Number.isFinite(createdMs) && Number.isFinite(modifiedMs)
					? Math.max(0, Math.floor((modifiedMs - createdMs) / 1000))
					: 0;
			const preview = parsed.firstUserMessage || parsed.firstAssistantMessage || title;
			const usage = parseGrokUsageFile(
				await this.readSessionFile(this.joinPath(sshConfig, sessionDir, 'usage.json'), sshConfig)
			);

			return {
				// Search/read must address the directory we validated, even when a
				// stale or malformed summary names another session or project.
				sessionId,
				projectPath: cwd,
				timestamp,
				modifiedAt,
				firstMessage: preview.slice(0, FIRST_MESSAGE_PREVIEW_LENGTH),
				messageCount: parsed.messages.length,
				sizeBytes: transcript.size,
				// The transcript carries no token counts; grok 1.x keeps the session
				// totals in usage.json beside it. A 0.x session has none: zeros.
				inputTokens: usage?.inputTokens ?? 0,
				outputTokens: usage?.outputTokens ?? 0,
				cacheReadTokens: usage?.cacheReadTokens ?? 0,
				cacheCreationTokens: usage?.cacheCreationTokens ?? 0,
				...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				...(usage?.byModel.length ? { byModel: usage.byModel } : {}),
				durationSeconds,
				sessionName: title || undefined,
			};
		} catch (error) {
			if (isExpectedSessionReadError(error)) {
				logger.debug(`Expected failure loading Grok session ${sessionId}`, LOG_CONTEXT, { error });
			} else {
				logger.warn(`Unexpected failure loading Grok session ${sessionId}`, LOG_CONTEXT, {
					error,
				});
				captureException(error, { operation: 'grokStorage:loadSessionInfo', sessionId });
			}
			return null;
		}
	}

	/**
	 * Locate a session's directory by scanning the cwd folders that match the
	 * project. Doubles as the ownership guard: sessions outside matching
	 * folders never resolve, so their content is never returned.
	 */
	private async findSessionDir(
		projectPath: string,
		sessionId: string,
		sessionsDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		if (!isSafeGrokPathSegment(sessionId)) return null;
		const cwdFolders = await this.listMatchingCwdFolders(projectPath, sessionsDir, sshConfig);
		for (const cwdFolder of cwdFolders) {
			const sessionIds = await this.listSessionIds(cwdFolder, sessionsDir, sshConfig);
			if (sessionIds.includes(sessionId)) {
				return this.joinPath(sshConfig, sessionsDir, cwdFolder, sessionId);
			}
		}
		return null;
	}

	/** Read messages from a Grok session's chat_history.jsonl file. */
	async readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		const sessionDir = await this.findSessionDir(
			projectPath,
			sessionId,
			this.getSessionsDir(sshConfig, options?.configDir),
			sshConfig
		);
		if (!sessionDir) {
			logger.warn(`Grok session not found for project: ${sessionId}`, LOG_CONTEXT);
			return { messages: [], total: 0, hasMore: false };
		}

		const transcript = await this.readTranscript(sessionDir, sshConfig);
		if (!transcript) {
			return { messages: [], total: 0, hasMore: false };
		}

		const { messages } = parseChatHistory(transcript.content, options?.includeNativeRecords);
		return BaseSessionStorage.applyMessagePagination(messages, options);
	}

	/** Get searchable user/assistant messages for session search. */
	protected async getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		const sessionDir = await this.findSessionDir(
			projectPath,
			sessionId,
			this.getSessionsDir(sshConfig),
			sshConfig
		);
		if (!sessionDir) return [];

		const transcript = await this.readTranscript(sessionDir, sshConfig);
		if (!transcript) return [];

		return parseChatHistory(transcript.content)
			.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
			.map((message) => ({
				role: message.role as 'user' | 'assistant',
				textContent: message.content,
			}))
			.filter((message) => message.textContent.trim().length > 0);
	}

	/**
	 * Get the filesystem path to a session's chat_history.jsonl file.
	 *
	 * Best-effort synchronous guess (matches sibling behavior): the project
	 * path is first mapped to the realpath'd cwd form Grok records (macOS
	 * `/var|/tmp|/etc` -> `/private/...`) so the local path agrees with what
	 * listSessions() finds. Over SSH the remote OS is unknown, so the path is
	 * encoded as given and may miss symlink-resolved variants.
	 */
	getSessionPath(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig,
		accountDir?: string
	): string | null {
		if (!isSafeGrokPathSegment(sessionId)) {
			return null;
		}
		let encoded: string;
		try {
			encoded = encodeURIComponent(toGrokRecordedCwd(projectPath, Boolean(sshConfig)));
		} catch (error) {
			if (error instanceof URIError) return null;
			throw error;
		}
		if (this.decodeCwdFolder(encoded) === null) return null;
		return this.joinPath(
			sshConfig,
			this.getSessionsDir(sshConfig, accountDir),
			encoded,
			sessionId,
			'chat_history.jsonl'
		);
	}

	/**
	 * Delete a message pair. Not supported for Grok sessions: editing
	 * chat_history.jsonl would desync summary.json counts, events.jsonl, and
	 * the sqlite FTS index the live Grok leader process maintains.
	 */
	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return {
			success: false,
			error: 'Deleting Grok session history is not supported.',
		};
	}

	/** Read a session's transcript with a size cap, returning content plus file stats. */
	private async readTranscript(
		sessionDir: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ content: string; size: number; mtimeMs: number } | null> {
		const transcriptPath = this.joinPath(sshConfig, sessionDir, 'chat_history.jsonl');

		const stat = await this.statSessionFile(transcriptPath, sshConfig);
		if (!stat) return null;
		if (stat.size > MAX_SESSION_FILE_SIZE) {
			logger.warn('Skipping oversized Grok session transcript', LOG_CONTEXT, {
				transcriptPath,
				size: stat.size,
			});
			return null;
		}

		const content = await this.readSessionFile(transcriptPath, sshConfig);
		if (!content?.trim()) return null;
		return { content, size: stat.size, mtimeMs: stat.mtimeMs };
	}

	/** Stat a file locally or over SSH. Returns null on missing/unreadable files. */
	private async statSessionFile(
		filePath: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ size: number; mtimeMs: number } | null> {
		if (sshConfig) {
			const result = await statRemote(filePath, sshConfig);
			if (!result.success || !result.data) {
				if (!isExpectedRemoteError(result.error)) {
					logger.warn(`Unexpected SSH failure stating ${filePath}: ${result.error}`, LOG_CONTEXT);
					captureException(new Error(result.error || 'statRemote failed'), {
						operation: 'grokStorage:statSessionFile',
						filePath,
					});
				}
				return null;
			}
			return { size: result.data.size, mtimeMs: result.data.mtime };
		}

		try {
			const stat = await fs.stat(filePath);
			return { size: stat.size, mtimeMs: stat.mtimeMs };
		} catch (error) {
			if (!isExpectedSessionReadError(error)) {
				captureException(error, { operation: 'grokStorage:statSessionFile', filePath });
			}
			return null;
		}
	}

	/** Read a file locally or over SSH. Returns null on missing/unreadable files; reports unexpected failures. */
	private async readSessionFile(
		filePath: string,
		sshConfig?: SshRemoteConfig
	): Promise<string | null> {
		if (sshConfig) {
			const result = await readFileRemote(filePath, sshConfig);
			if (result.success && result.data != null) return result.data;
			if (!isExpectedRemoteError(result.error)) {
				logger.warn(`Unexpected SSH failure reading ${filePath}: ${result.error}`, LOG_CONTEXT);
				captureException(new Error(result.error || 'readFileRemote failed'), {
					operation: 'grokStorage:readSessionFile',
					filePath,
				});
			}
			return null;
		}

		try {
			return await fs.readFile(filePath, 'utf8');
		} catch (error) {
			if (!isExpectedSessionReadError(error)) {
				captureException(error, { operation: 'grokStorage:readSessionFile', filePath });
			}
			return null;
		}
	}
}
