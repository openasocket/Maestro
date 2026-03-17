// VIBES v1.0 Maestro Orchestration Instrumenter — Captures Maestro's own
// orchestration-level VIBES data: agent dispatch events, task assignments,
// parallel coordination, and batch/Auto Run session boundaries.
//
// Error handling: All public methods catch and log errors at 'warn' level
// to ensure instrumentation failures never crash the agent session.

import type { VibesSessionManager } from '../vibes-session';
import { createCommandEntry, createPromptEntry, createEdgeRecord } from '../vibes-annotations';
import type { VibesAssuranceLevel, VibesDelegationRecord } from '../../../shared/vibes-types';

// ============================================================================
// Truncation Helper
// ============================================================================

/**
 * Truncate a string to a maximum length, appending '...' if truncated.
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
	console.warn(`[maestro-instrumenter] ${message}${detail}`);
}

// ============================================================================
// Maestro Instrumenter
// ============================================================================

/**
 * Captures Maestro's orchestration-level VIBES data.
 *
 * Unlike the Claude Code and Codex instrumenters which process individual agent
 * tool executions and reasoning, this instrumenter records higher-level events:
 * - Agent dispatch (spawn) and completion
 * - Batch/Auto Run session start and completion
 * - Task assignment prompts (at Medium+ assurance)
 *
 * Error handling: All public methods are wrapped in try-catch. Errors are
 * logged at warn level and never propagate to the caller.
 */
export class MaestroInstrumenter {
	private sessionManager: VibesSessionManager;
	private assuranceLevel: VibesAssuranceLevel;

	/** Cached Maestro version string. Defaults to 'unknown' if unavailable. */
	private maestroVersion: string = 'unknown';

	constructor(params: {
		sessionManager: VibesSessionManager;
		assuranceLevel: VibesAssuranceLevel;
		maestroVersion?: string;
	}) {
		this.sessionManager = params.sessionManager;
		this.assuranceLevel = params.assuranceLevel;
		if (params.maestroVersion) {
			this.maestroVersion = params.maestroVersion;
		}
	}

	/**
	 * Update the Maestro version. Called when version info becomes available.
	 */
	setMaestroVersion(version: string): void {
		this.maestroVersion = version || 'unknown';
	}

	/**
	 * Get the current Maestro version string.
	 */
	getMaestroVersion(): string {
		return this.maestroVersion;
	}

	/**
	 * Record an agent spawn event.
	 *
	 * Creates a command annotation recording agent dispatch with type 'tool_use',
	 * a prompt annotation (Medium+ assurance) recording the task assignment,
	 * a delegation record (EVOLVE spec section 3) linking parent to child session,
	 * and a delegated_to edge record linking the two sessions.
	 */
	async handleAgentSpawn(params: {
		maestroSessionId: string;
		agentSessionId: string;
		agentType: string;
		taskDescription?: string;
		projectPath: string;
		/** Files delegated to the sub-agent (relative paths). */
		delegatedFiles?: string[];
		/** Classification of the delegation. Defaults to 'task'. */
		delegationType?: 'task' | 'review' | 'research' | 'other';
		/** Override for the child's VIBES session UUID. Looked up from session manager if omitted. */
		childVibesSessionId?: string;
		/** Override for the child's environment hash. Looked up from session manager if omitted. */
		childEnvironmentHash?: string;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			// Record the dispatch as a command entry
			const commandText = `Maestro: dispatch ${params.agentType} agent [${params.agentSessionId}]`;
			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				workingDirectory: params.projectPath,
			});
			await this.sessionManager.recordManifestEntry(params.maestroSessionId, cmdHash, cmdEntry);

			// Record the task description as a prompt entry (Medium+ assurance)
			if (params.taskDescription && this.assuranceLevel !== 'low') {
				const { entry: promptEntry, hash: promptHash } = createPromptEntry({
					promptText: params.taskDescription,
					promptType: 'user_instruction',
				});
				await this.sessionManager.recordManifestEntry(
					params.maestroSessionId,
					promptHash,
					promptEntry
				);
			}

			// Emit delegation record (EVOLVE spec section 3)
			const parentVibesSessionId = session.vibesSessionId;
			const childVibesSessionId =
				params.childVibesSessionId ??
				this.sessionManager.getSession(params.agentSessionId)?.vibesSessionId ??
				params.agentSessionId;

			const childEnvHash =
				params.childEnvironmentHash ??
				this.sessionManager.getEnvironmentHash(params.agentSessionId) ??
				undefined;

			const delegation: VibesDelegationRecord = {
				type: 'delegation',
				parent_session_id: parentVibesSessionId,
				child_session_id: childVibesSessionId,
				timestamp: new Date().toISOString(),
				task_description: params.taskDescription,
				delegated_files: params.delegatedFiles,
				delegation_type: params.delegationType ?? 'task',
				parent_environment_hash: session.environmentHash ?? undefined,
				child_environment_hash: childEnvHash,
			};
			await this.sessionManager.recordAnnotation(params.maestroSessionId, delegation);

			// Emit delegated_to edge record linking parent session to child session
			const edge = createEdgeRecord({
				edgeType: 'delegated_to',
				sourceRef: parentVibesSessionId,
				sourceType: 'session',
				targetRef: childVibesSessionId,
				targetType: 'session',
				sessionId: parentVibesSessionId,
			});
			await this.sessionManager.recordAnnotation(params.maestroSessionId, edge);
		} catch (err) {
			logWarn('Error handling agent spawn', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record an agent completion event.
	 *
	 * Creates a command annotation recording agent completion with exit code
	 * and output summary.
	 */
	async handleAgentComplete(params: {
		maestroSessionId: string;
		agentSessionId: string;
		agentType: string;
		success: boolean;
		duration: number;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const exitCode = params.success ? 0 : 1;
			const durationSec = (params.duration / 1000).toFixed(1);
			const outputSummary = `${params.agentType} agent [${params.agentSessionId}] ${params.success ? 'completed successfully' : 'failed'} in ${durationSec}s`;

			const commandText = `Maestro: ${params.agentType} agent complete [${params.agentSessionId}]`;
			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				exitCode,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(params.maestroSessionId, cmdHash, cmdEntry);
		} catch (err) {
			logWarn('Error handling agent complete', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record a batch/Auto Run session start.
	 *
	 * Creates a command entry recording the batch run initiation with the
	 * list of documents to process.
	 */
	async handleBatchRunStart(params: {
		maestroSessionId: string;
		projectPath: string;
		documents: string[];
		agentType: string;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const docList = params.documents.join(', ');
			const commandText = `Maestro: batch run start — ${params.documents.length} document(s) with ${params.agentType}`;
			const outputSummary = `Documents: ${docList}`;

			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				workingDirectory: params.projectPath,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(params.maestroSessionId, cmdHash, cmdEntry);
		} catch (err) {
			logWarn('Error handling batch run start', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}

	/**
	 * Record a batch/Auto Run session completion.
	 *
	 * Creates a command entry recording batch completion with document
	 * and task counts.
	 */
	async handleBatchRunComplete(params: {
		maestroSessionId: string;
		documentsCompleted: number;
		totalTasks: number;
	}): Promise<void> {
		try {
			const session = this.sessionManager.getSession(params.maestroSessionId);
			if (!session || !session.isActive) {
				return;
			}

			const commandText = `Maestro: batch run complete — ${params.documentsCompleted} document(s)`;
			const outputSummary = `Completed ${params.documentsCompleted} document(s), ${params.totalTasks} total task(s)`;

			const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
				commandText: truncateSummary(commandText),
				commandType: 'tool_use',
				exitCode: 0,
				outputSummary: truncateSummary(outputSummary),
			});
			await this.sessionManager.recordManifestEntry(params.maestroSessionId, cmdHash, cmdEntry);
		} catch (err) {
			logWarn('Error handling batch run complete', {
				maestroSessionId: params.maestroSessionId,
				error: String(err),
			});
		}
	}
}
