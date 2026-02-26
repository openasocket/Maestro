// VIBES v1.0 Claude Code Instrumenter — Processes events from the Claude Code
// agent output parser to generate VIBES annotations. Handles tool executions,
// thinking chunks, usage stats, prompts, and final results.
//
// Error handling: All public methods catch and log errors at 'warn' level
// to ensure instrumentation failures never crash the agent session.

import * as crypto from 'crypto';
import { readFile } from 'fs/promises';
import * as path from 'path';
import type { VibesSessionManager } from '../vibes-session';
import {
	createCommandEntry,
	createLineAnnotation,
	createReasoningEntry,
	createExternalReasoningEntry,
	createPromptEntry,
	createSessionRecord,
} from '../vibes-annotations';
import { writeReasoningBlob } from '../vibes-io';
import type { ParsedEvent } from '../../parsers/agent-output-parser';
import type {
	VibesAssuranceLevel,
	VibesAction,
	VibesCommandType,
} from '../../../shared/vibes-types';

// ============================================================================
// Tool Name Mapping
// ============================================================================

/** Map Claude Code tool names to VIBES command types. */
const TOOL_COMMAND_TYPE_MAP: Record<string, VibesCommandType> = {
	Write: 'file_write',
	Edit: 'file_write',
	MultiEdit: 'file_write',
	NotebookEdit: 'file_write',
	Read: 'file_read',
	Bash: 'shell',
	Glob: 'tool_use',
	Grep: 'tool_use',
	WebFetch: 'api_call',
	WebSearch: 'api_call',
	TodoRead: 'tool_use',
	TodoWrite: 'tool_use',
	Task: 'tool_use',
};

/** Map Claude Code tool names to VIBES actions for file-modifying tools.
 * Write defaults to 'modify' because Claude Code's Write tool can overwrite
 * existing files — 'modify' is the safer default from an audit perspective. */
const TOOL_ACTION_MAP: Record<string, VibesAction> = {
	Write: 'modify',
	Edit: 'modify',
	MultiEdit: 'modify',
	NotebookEdit: 'modify',
};

// ============================================================================
// Input Extraction Helpers
// ============================================================================

/**
 * Extract file path from a tool's input object.
 * Claude Code tools use `file_path`, `path`, or `command` fields.
 * Handles missing or malformed input gracefully by returning null.
 */
function extractFilePath(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.file_path === 'string') return obj.file_path;
	if (typeof obj.path === 'string') return obj.path;
	if (typeof obj.notebook_path === 'string') return obj.notebook_path;
	return null;
}

/**
 * Normalize a file path and make it relative to the project root.
 * VIBES standard requires all file_path values to be project-relative.
 * If the path is absolute and starts with projectPath, the prefix is stripped.
 * If already relative, it is returned as-is after normalization.
 */
function normalizePath(filePath: string, projectPath?: string): string {
	const normalized = path.normalize(filePath);
	if (projectPath && path.isAbsolute(normalized)) {
		const normalizedProject = path.normalize(projectPath);
		if (normalized.startsWith(normalizedProject + path.sep)) {
			return normalized.slice(normalizedProject.length + 1);
		}
		if (normalized.startsWith(normalizedProject)) {
			return normalized.slice(normalizedProject.length) || normalized;
		}
	}
	return normalized;
}

/**
 * Check if a file path matches any of the exclude patterns.
 * Supports simple glob patterns: `*` (any segment chars), `**` (any path depth),
 * and literal path segments. No external dependency required.
 */
function matchesExcludePattern(filePath: string, excludePatterns: string[]): boolean {
	if (!excludePatterns || excludePatterns.length === 0) {
		return false;
	}
	const normalized = normalizePath(filePath);
	return excludePatterns.some((pattern) => {
		try {
			return simpleGlobMatch(normalized, pattern);
		} catch {
			// Invalid pattern — skip silently
			return false;
		}
	});
}

/**
 * Simple glob matcher supporting `*` and `**` patterns.
 * Converts a glob pattern to a regex for matching.
 * `**` matches any number of path segments (including zero).
 * `*` matches any characters within a single path segment.
 */
function simpleGlobMatch(filePath: string, pattern: string): boolean {
	// Escape regex special chars except * and ?
	let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	// Replace glob ? with single-char matcher
	regex = regex.replace(/\?/g, '\x00QMARK');
	// Handle **/ (globstar followed by separator) — matches zero or more directories
	regex = regex.replace(/\*\*\//g, '\x00GLOBSTAR_SEP');
	// Handle remaining ** (e.g. at end of pattern)
	regex = regex.replace(/\*\*/g, '\x00GLOBSTAR');
	// Single * matches within one segment
	regex = regex.replace(/\*/g, '\x00STAR');
	// Now substitute the actual regex fragments (no glob chars left to interfere)
	regex = regex.replace(/\x00QMARK/g, '[^/]');
	regex = regex.replace(/\x00GLOBSTAR_SEP/g, '(.+/)?');
	regex = regex.replace(/\x00GLOBSTAR/g, '.*');
	regex = regex.replace(/\x00STAR/g, '[^/]*');
	return new RegExp(`^${regex}$`).test(filePath);
}

/**
 * Extract line range from a tool's input object.
 * Handles Write (full file content), Edit (old_string position + new_string size),
 * MultiEdit (union of edit ranges), Read (offset/limit), and NotebookEdit (cell_number).
 *
 * For Edit/MultiEdit, reads the pre-edit file to find the position of old_string.
 * Falls back to line counting without position if file read fails.
 */
async function extractLineRange(
	input: unknown,
	filePath?: string,
	projectPath?: string
): Promise<{ lineStart: number; lineEnd: number } | null> {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;

	// Write tool: content contains the full new file
	if (typeof obj.content === 'string') {
		const lineCount = obj.content.split('\n').length;
		return { lineStart: 1, lineEnd: Math.max(1, lineCount) };
	}

	// Edit tool: old_string/new_string
	if (typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
		const newLineCount = obj.new_string.split('\n').length;
		// Try to find old_string position in the pre-edit file
		const position = await findStringPosition(obj.old_string, filePath, projectPath);
		if (position !== null) {
			return { lineStart: position, lineEnd: position + newLineCount - 1 };
		}
		// Fallback: we know the size but not the position
		return { lineStart: 1, lineEnd: Math.max(1, newLineCount) };
	}

	// MultiEdit tool: edits array
	if (Array.isArray(obj.edits)) {
		let fileContent: string | null = null;
		if (filePath && projectPath) {
			try {
				const fullPath = path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
				fileContent = await readFile(fullPath, 'utf-8');
			} catch {
				// File read failed — fall back to line counting
			}
		}

		let minLine = Infinity;
		let maxLine = 0;
		for (const edit of obj.edits) {
			if (!edit || typeof edit !== 'object') continue;
			const e = edit as Record<string, unknown>;
			if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;

			const newLineCount = e.new_string.split('\n').length;
			if (fileContent) {
				const idx = fileContent.indexOf(e.old_string);
				if (idx >= 0) {
					const lineNum = fileContent.substring(0, idx).split('\n').length;
					minLine = Math.min(minLine, lineNum);
					maxLine = Math.max(maxLine, lineNum + newLineCount - 1);
					continue;
				}
			}
			// Fallback for this edit
			minLine = Math.min(minLine, 1);
			maxLine = Math.max(maxLine, newLineCount);
		}

		if (maxLine > 0) {
			return { lineStart: minLine === Infinity ? 1 : minLine, lineEnd: maxLine };
		}
		return null;
	}

	// Read tool: offset and limit
	if (typeof obj.offset === 'number' && typeof obj.limit === 'number') {
		return { lineStart: obj.offset, lineEnd: obj.offset + obj.limit - 1 };
	}

	// NotebookEdit: cell_number + new_source line count
	if (typeof obj.cell_number === 'number') {
		const sourceLines = typeof obj.new_source === 'string' ? obj.new_source.split('\n').length : 1;
		return { lineStart: obj.cell_number, lineEnd: obj.cell_number + sourceLines - 1 };
	}

	return null;
}

/**
 * Find the 1-based line number of a string in a file.
 * Returns null if the file can't be read or the string isn't found.
 */
async function findStringPosition(
	searchString: string,
	filePath?: string,
	projectPath?: string
): Promise<number | null> {
	if (!filePath) return null;
	try {
		const fullPath =
			projectPath && !path.isAbsolute(filePath) ? path.join(projectPath, filePath) : filePath;
		const content = await readFile(fullPath, 'utf-8');
		const idx = content.indexOf(searchString);
		if (idx < 0) return null;
		return content.substring(0, idx).split('\n').length;
	} catch {
		return null;
	}
}

/**
 * Extract a command summary from Bash tool input.
 */
function extractBashCommand(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.command === 'string') return obj.command;
	return null;
}

/**
 * Detect whether a Bash command is a file deletion command.
 * Checks if the command starts with `rm ` or `rm -`, or contains `unlink` or `shutil.rmtree`.
 */
function detectDeleteCommand(commandText: string): boolean {
	const trimmed = commandText.trimStart();
	if (/^rm\s/.test(trimmed)) return true;
	if (/\bunlink\b/.test(trimmed)) return true;
	if (/\bshutil\.rmtree\b/.test(trimmed)) return true;
	return false;
}

/**
 * Extract a truncated output summary (max 200 chars).
 */
function truncateSummary(text: string, maxLen = 200): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// Warn-level logger for non-critical instrumentation errors
// ============================================================================

function logWarn(message: string, data?: Record<string, unknown>): void {
	const detail = data ? ` ${JSON.stringify(data)}` : '';
	console.warn(`[claude-code-instrumenter] ${message}${detail}`);
}

// ============================================================================
// Claude Code Instrumenter
// ============================================================================

/**
 * Processes Claude Code agent events and generates VIBES annotations.
 *
 * Handles:
 * - Tool execution events (file writes, reads, bash commands, search tools)
 * - Thinking chunk events (reasoning text buffering for High assurance)
 * - Usage events (token counts and model info)
 * - Result events (final responses, flushes buffered reasoning)
 * - Prompt events (captures prompts at Medium+ assurance)
 *
 * Known limitations vs CCV hooks:
 * - Tool failures: Claude Code's stream-json format does not emit distinct tool
 *   failure events. CCV hooks receive PostToolUseFailure directly from the Claude
 *   Code hook API with exit_code, error message, and is_interrupt flag. Maestro
 *   cannot reliably detect tool failures from the output stream alone. To capture
 *   failures, Claude Code would need to add failure events to stream-json, or
 *   Maestro would need to use Claude Code hooks directly (a different integration
 *   approach than output stream parsing).
 * - Subagent stop: Stream-json does not emit SubagentStop events. CCV hooks
 *   receive SubagentStop with agent_transcript_path from the hook API. Maestro
 *   can only record subagent start (Task tool_use) but not completion.
 *
 * Error handling: All public methods are wrapped in try-catch. Errors are
 * logged at warn level and never propagate to the caller.
 */
export class ClaudeCodeInstrumenter {
	private sessionManager: VibesSessionManager;
	private assuranceLevel: VibesAssuranceLevel;

	/** Exclude patterns loaded from the project's VIBES config. */
	private excludePatterns: string[] = [];

	/** Buffered reasoning text per session, accumulated from thinking chunks. */
	private reasoningBuffers: Map<string, string> = new Map();

	/** Buffered reasoning token counts per session from usage events. */
	private reasoningTokenCounts: Map<string, number> = new Map();

	/** Cached model name from usage events per session. */
	private modelNames: Map<string, string> = new Map();

	/** Most recent prompt hash per session, for linking to line annotations. */
	private lastPromptHashes: Map<string, string> = new Map();

	/** Most recent reasoning hash per session, for linking to line annotations. */
	private lastReasoningHashes: Map<string, string> = new Map();

	/** Byte threshold above which reasoning text is compressed (default 10 KB). */
	private compressThresholdBytes: number;

	/** Byte threshold above which reasoning is stored as an external blob (default 100 KB). */
	private externalBlobThresholdBytes: number;

	constructor(params: {
		sessionManager: VibesSessionManager;
		assuranceLevel: VibesAssuranceLevel;
		excludePatterns?: string[];
		compressThresholdBytes?: number;
		externalBlobThresholdBytes?: number;
	}) {
		this.sessionManager = params.sessionManager;
		this.assuranceLevel = params.assuranceLevel;
		this.excludePatterns = params.excludePatterns ?? [];
		this.compressThresholdBytes = params.compressThresholdBytes ?? 10240;
		this.externalBlobThresholdBytes = params.externalBlobThresholdBytes ?? 102400;
	}

	/**
	 * Update the exclude patterns (e.g. after loading project config).
	 */
	setExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	/**
	 * Process a tool_use / tool-execution event from the StdoutHandler.
	 *
	 * The event shape matches what StdoutHandler emits:
	 *   { toolName: string; state: unknown; timestamp: number }
	 *
	 * For file write/edit tools: creates line annotations and command entries.
	 * For file read tools: creates command entries with type 'file_read'.
	 * For bash/shell tools: creates command entries with type 'shell'.
	 * For search tools (Glob/Grep): creates command entries with type 'tool_use'.
	 *
	 * Handles missing or malformed tool execution data without throwing.
	 */
	async handleToolExecution(
		sessionId: string,
		event: { toolName: string; state: unknown; timestamp: number }
	): Promise<void> {
		try {
			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			// Validate event data
			if (!event || typeof event.toolName !== 'string') {
				logWarn('Skipping malformed tool execution event', { sessionId });
				return;
			}

			// Flush any buffered reasoning before recording a tool execution
			await this.flushReasoning(sessionId);

			let commandType: VibesCommandType = TOOL_COMMAND_TYPE_MAP[event.toolName] ?? 'other';
			const toolInput = this.extractToolInput(event.state);

			// Build command text from the tool execution
			const commandText = this.buildCommandText(event.toolName, toolInput);

			// Heuristic: detect file deletion via Bash rm/unlink commands (GAP 3)
			if (event.toolName === 'Bash' && detectDeleteCommand(commandText)) {
				commandType = 'file_delete';
			}

			// Create and record command manifest entry
			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText,
				commandType,
				workingDirectory: session.projectPath ?? null,
				outputSummary: this.buildOutputSummary(event.toolName, toolInput, session.projectPath),
				// exitCode: not available from stream-json parser — only CCV hooks
				// receive tool_response.exit_code. Leave null.
			});
			await this.sessionManager.recordManifestEntry(sessionId, cmdHash, cmdEntry);

			// Task tool = subagent delegation — create session boundary annotation.
			// Follows CCV HOOK-ALIGN-04 pattern: description="subagent:{type}:{desc}".
			// NOTE: Subagent stop events are not available from stream-json output.
			// CCV hooks receive SubagentStop with agent_transcript_path from the
			// Claude Code hook API. Maestro can only record subagent start (Task
			// tool_use) but not completion.
			if (event.toolName === 'Task') {
				const taskObj = toolInput as Record<string, unknown> | null;
				const agentType =
					taskObj && typeof taskObj.subagent_type === 'string'
						? taskObj.subagent_type
						: taskObj && typeof taskObj.type === 'string'
							? taskObj.type
							: 'unknown';
				const description =
					taskObj && typeof taskObj.description === 'string' ? taskObj.description : undefined;

				const subagentAnnotation = createSessionRecord({
					event: 'start',
					sessionId: session.vibesSessionId,
					environmentHash: session.environmentHash,
					assuranceLevel: session.assuranceLevel,
					description: `subagent:${agentType}${description ? `:${description}` : ''}`,
				});
				await this.sessionManager.recordAnnotation(sessionId, subagentAnnotation);
			}

			// For file-modifying tools, also create a line annotation
			const action = TOOL_ACTION_MAP[event.toolName];
			if (action) {
				const filePath = extractFilePath(toolInput);
				if (filePath && session.environmentHash) {
					// Normalize the file path and make it relative to project root
					const normalizedPath = normalizePath(filePath, session.projectPath);

					// Skip files matching exclude patterns
					if (matchesExcludePattern(normalizedPath, this.excludePatterns)) {
						return;
					}

					const lineRange = await extractLineRange(toolInput, filePath, session.projectPath);
					const promptHash =
						this.assuranceLevel !== 'low' ? this.lastPromptHashes.get(sessionId) : undefined;
					const reasoningHash =
						this.assuranceLevel === 'high' ? this.lastReasoningHashes.get(sessionId) : undefined;
					const annotation = createLineAnnotation({
						filePath: normalizedPath,
						lineStart: lineRange?.lineStart ?? 1,
						lineEnd: lineRange?.lineEnd ?? 1,
						environmentHash: session.environmentHash,
						commandHash: cmdHash,
						promptHash,
						reasoningHash,
						action,
						sessionId: session.vibesSessionId,
						assuranceLevel: session.assuranceLevel,
					});
					await this.sessionManager.recordAnnotation(sessionId, annotation);
				}
			}
		} catch (err) {
			logWarn('Error handling tool execution', { sessionId, error: String(err) });
		}
	}

	/**
	 * Buffer a thinking/reasoning chunk for later flushing.
	 * Only captures at High assurance level.
	 * Chunks are accumulated until a tool execution or result completes the turn.
	 */
	handleThinkingChunk(sessionId: string, text: string): void {
		try {
			if (this.assuranceLevel !== 'high') {
				return;
			}

			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			const existing = this.reasoningBuffers.get(sessionId) ?? '';
			this.reasoningBuffers.set(sessionId, existing + text);
		} catch (err) {
			logWarn('Error buffering thinking chunk', { sessionId, error: String(err) });
		}
	}

	/**
	 * Capture model info and token counts from a usage event.
	 * Stores reasoning token count for later inclusion in reasoning entries.
	 * Stores model name when provided for environment entry updates.
	 */
	handleUsage(sessionId: string, usage: ParsedEvent['usage'] & { modelName?: string }): void {
		try {
			if (!usage) {
				return;
			}

			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			if (usage.reasoningTokens !== undefined) {
				const existing = this.reasoningTokenCounts.get(sessionId) ?? 0;
				this.reasoningTokenCounts.set(sessionId, existing + usage.reasoningTokens);
			}

			if (usage.modelName && !this.modelNames.has(sessionId)) {
				this.modelNames.set(sessionId, usage.modelName);
			}
		} catch (err) {
			logWarn('Error handling usage event', { sessionId, error: String(err) });
		}
	}

	/**
	 * Get the cached model name for a session, if available.
	 * Returns the model name from the first usage event that included one.
	 */
	getModelName(sessionId: string): string | undefined {
		return this.modelNames.get(sessionId);
	}

	/**
	 * Process the final result from the agent.
	 * Flushes any buffered reasoning data.
	 */
	async handleResult(sessionId: string, _text: string): Promise<void> {
		try {
			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			await this.flushReasoning(sessionId);
		} catch (err) {
			logWarn('Error handling result', { sessionId, error: String(err) });
		}
	}

	/**
	 * Capture a prompt sent to the agent.
	 * Only recorded at Medium+ assurance levels.
	 */
	async handlePrompt(
		sessionId: string,
		promptText: string,
		contextFiles?: string[]
	): Promise<void> {
		try {
			if (this.assuranceLevel === 'low') {
				return;
			}

			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			const { entry, hash } = createPromptEntry({
				promptText,
				promptType: 'user_instruction',
				contextFiles,
			});
			await this.sessionManager.recordManifestEntry(sessionId, hash, entry);
			this.lastPromptHashes.set(sessionId, hash);
		} catch (err) {
			logWarn('Error handling prompt', { sessionId, error: String(err) });
		}
	}

	/**
	 * Flush all buffered data for a session.
	 * Called when a session ends or when explicitly requested.
	 */
	async flush(sessionId: string): Promise<void> {
		try {
			await this.flushReasoning(sessionId);
			this.cleanupSession(sessionId);
		} catch (err) {
			logWarn('Error flushing session', { sessionId, error: String(err) });
		}
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Flush buffered reasoning text to a reasoning manifest entry.
	 * Only operates at High assurance level.
	 *
	 * If the text exceeds the external blob threshold, writes to an external
	 * blob file and creates an external reasoning entry. If it exceeds only
	 * the compress threshold, compression is handled by createReasoningEntry.
	 */
	private async flushReasoning(sessionId: string): Promise<void> {
		if (this.assuranceLevel !== 'high') {
			return;
		}

		const text = this.reasoningBuffers.get(sessionId);
		if (!text) {
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		const tokenCount = this.reasoningTokenCounts.get(sessionId);
		const model = this.modelNames.get(sessionId);
		const textBytes = Buffer.byteLength(text, 'utf8');

		let entry;
		let hash;

		if (textBytes > this.externalBlobThresholdBytes) {
			// External blob storage: write to .ai-audit/blobs/ and reference by path
			const tempHash = crypto.createHash('sha256').update(text).digest('hex');
			const blobPath = await writeReasoningBlob(session.projectPath, tempHash, text);
			({ entry, hash } = createExternalReasoningEntry({
				blobPath,
				tokenCount,
				model,
			}));
		} else {
			// Normal or compressed entry (compression handled internally by createReasoningEntry)
			({ entry, hash } = createReasoningEntry({
				reasoningText: text,
				tokenCount,
				model,
				compressThresholdBytes: this.compressThresholdBytes,
			}));
		}

		await this.sessionManager.recordManifestEntry(sessionId, hash, entry);
		this.lastReasoningHashes.set(sessionId, hash);

		// Clear the buffer after flushing
		this.reasoningBuffers.delete(sessionId);
		this.reasoningTokenCounts.delete(sessionId);
	}

	/**
	 * Extract the tool input from the state object emitted by StdoutHandler.
	 * For toolUseBlocks the state is `{ status: 'running', input: ... }`.
	 * For direct tool_use events the state may be the input itself.
	 * Handles missing or malformed state gracefully.
	 */
	private extractToolInput(state: unknown): unknown {
		if (!state || typeof state !== 'object') {
			return state;
		}
		const obj = state as Record<string, unknown>;
		if (obj.input !== undefined) {
			return obj.input;
		}
		return state;
	}

	/**
	 * Build a human-readable command text from tool name and input.
	 */
	private buildCommandText(toolName: string, input: unknown): string {
		const filePath = extractFilePath(input);
		const bashCmd = extractBashCommand(input);

		if (bashCmd) {
			return truncateSummary(bashCmd);
		}
		if (filePath) {
			return `${toolName}: ${filePath}`;
		}
		return toolName;
	}

	/**
	 * Build a human-readable output summary for a command entry.
	 * Matches CCV's output summary patterns:
	 * - Edit: "Replaced {N} chars in {file}"
	 * - MultiEdit: "Applied {N} edits to {file}"
	 * - Write: "Wrote {N} lines to {file}"
	 * - Bash: null (stdout not available from stream-json)
	 * - Read: null
	 */
	private buildOutputSummary(
		toolName: string,
		input: unknown,
		projectPath?: string
	): string | null {
		if (!input || typeof input !== 'object') return null;
		const obj = input as Record<string, unknown>;

		if (toolName === 'Edit' || toolName === 'MultiEdit') {
			const filePath = extractFilePath(input);
			if (typeof obj.old_string === 'string' && filePath) {
				return `Replaced ${obj.old_string.length} chars in ${normalizePath(filePath, projectPath)}`;
			}
			if (Array.isArray(obj.edits) && filePath) {
				return `Applied ${obj.edits.length} edits to ${normalizePath(filePath, projectPath)}`;
			}
		}

		if (toolName === 'Write') {
			const filePath = extractFilePath(input);
			if (typeof obj.content === 'string' && filePath) {
				const lineCount = obj.content.split('\n').length;
				return `Wrote ${lineCount} lines to ${normalizePath(filePath, projectPath)}`;
			}
		}

		// Bash: stdout/stderr not available from stream-json toolUseBlocks
		// CCV captures this from hook_input but Maestro only sees tool input, not output
		return null;
	}

	/**
	 * Clean up all internal state for a session.
	 */
	private cleanupSession(sessionId: string): void {
		this.reasoningBuffers.delete(sessionId);
		this.reasoningTokenCounts.delete(sessionId);
		this.modelNames.delete(sessionId);
		this.lastPromptHashes.delete(sessionId);
		this.lastReasoningHashes.delete(sessionId);
	}
}
