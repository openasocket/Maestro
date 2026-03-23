/**
 * Cue Team Executor — spawns headless group chat sessions for team-based Cue runs.
 *
 * When a Cue subscription has a `team_template` set, this executor:
 * 1. Loads the TeamTemplate by ID
 * 2. Creates a temporary group chat with the template's topology and roles
 * 3. Spawns the moderator and adds participants for each role
 * 4. Sends the resolved prompt as the initial user message
 * 5. Polls the execution state until the workflow completes or times out
 * 6. Extracts the final output from the exit point's node output
 * 7. Cleans up the temporary group chat
 */

import * as fs from 'fs';
import * as path from 'path';
import type { CueEvent, CueRunResult, CueRunStatus, CueSubscription } from './cue-types';
import type { SessionInfo } from '../../shared/types';
import { substituteTemplateVariables, type TemplateContext } from '../../shared/templateVariables';
import type { IProcessManager } from '../group-chat/group-chat-moderator';
import type { AgentDetector } from '../agents';
import { getTemplate } from '../group-chat/team-template-storage';
import {
	createGroupChat,
	loadGroupChat,
	deleteGroupChat,
	updateGroupChat,
} from '../group-chat/group-chat-storage';
import { spawnModerator, killModerator } from '../group-chat/group-chat-moderator';
import { addParticipant, clearAllParticipantSessions } from '../group-chat/group-chat-agent';
import { routeUserMessage } from '../group-chat/group-chat-router';
import { finalizeWorkflow } from '../group-chat/topology-router';

/** How often to poll the execution state (ms) */
const POLL_INTERVAL_MS = 2000;

/** Configuration for executing a Cue team prompt */
export interface CueTeamExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	promptPath: string;
	teamTemplateId: string;
	projectRoot: string;
	templateContext: TemplateContext;
	timeoutMs: number;
	processManager: IProcessManager;
	agentDetector: AgentDetector;
	onLog: (level: string, message: string) => void;
}

/** Tracks active team runs for stop/cleanup support */
interface ActiveTeamRun {
	groupChatId: string;
	aborted: boolean;
}

const activeTeamRuns = new Map<string, ActiveTeamRun>();

/**
 * Execute a Cue-triggered team prompt by spawning a headless group chat.
 *
 * Steps:
 * 1. Load the TeamTemplate by ID
 * 2. Resolve the input prompt (template variable substitution)
 * 3. Create a temporary group chat with the template's topology and roles
 * 4. Spawn the moderator and add participants for each role
 * 5. Send the resolved prompt as the initial user message
 * 6. Poll execution state until completion, failure, or timeout
 * 7. Extract final output from the exit point's node output
 * 8. Clean up the temporary group chat
 */
export async function executeCueTeamPrompt(config: CueTeamExecutionConfig): Promise<CueRunResult> {
	const {
		runId,
		session,
		subscription,
		event,
		promptPath,
		teamTemplateId,
		projectRoot,
		templateContext,
		timeoutMs,
		processManager,
		agentDetector,
		onLog,
	} = config;

	const startedAt = new Date().toISOString();
	const startTime = Date.now();

	const makeResult = (
		status: CueRunStatus,
		stdout: string,
		stderr: string,
		exitCode: number | null
	): CueRunResult => ({
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		event,
		status,
		stdout,
		stderr,
		exitCode,
		durationMs: Date.now() - startTime,
		startedAt,
		endedAt: new Date().toISOString(),
	});

	// 1. Load the TeamTemplate
	const template = await getTemplate(teamTemplateId);
	if (!template) {
		const message = `Team template not found: ${teamTemplateId}`;
		onLog('error', `[CUE] ${message}`);
		return makeResult('failed', '', message, null);
	}

	if (!template.topology) {
		const message = `Team template "${template.name}" has no workflow topology — headless Cue execution requires a topology`;
		onLog('error', `[CUE] ${message}`);
		return makeResult('failed', '', message, null);
	}

	onLog(
		'cue',
		`[CUE] Team run ${runId}: using template "${template.name}" with ${template.roles.length} roles`
	);

	// 2. Resolve the input prompt
	let promptContent: string;
	if (promptPath.endsWith('.md') || promptPath.endsWith('.txt') || promptPath.endsWith('.yaml')) {
		const resolvedPath = path.isAbsolute(promptPath)
			? promptPath
			: path.join(projectRoot, promptPath);
		try {
			promptContent = fs.readFileSync(resolvedPath, 'utf-8');
		} catch (error) {
			const message = `Failed to read prompt file: ${resolvedPath} - ${error instanceof Error ? error.message : String(error)}`;
			onLog('error', `[CUE] ${message}`);
			return makeResult('failed', '', message, null);
		}
	} else {
		promptContent = promptPath;
	}

	// Populate template context with Cue event data
	populateCueContext(templateContext, event, subscription, runId);

	const resolvedPrompt = substituteTemplateVariables(promptContent, templateContext);

	// 3–8. Create group chat, execute, and clean up
	let groupChatId: string | null = null;
	const teamRun: ActiveTeamRun = { groupChatId: '', aborted: false };
	activeTeamRuns.set(runId, teamRun);

	try {
		// 3. Create a temporary group chat
		const chat = await createGroupChat(
			`cue-team-${runId.slice(0, 8)}`,
			template.moderatorAgentId,
			template.moderatorConfig
				? {
						customArgs: template.moderatorConfig.customArgs,
						customEnvVars: template.moderatorConfig.customEnvVars,
					}
				: undefined,
			template.topology,
			template.roles
		);
		groupChatId = chat.id;
		teamRun.groupChatId = chat.id;

		onLog('cue', `[CUE] Team run ${runId}: created temporary group chat ${groupChatId}`);

		// 4. Spawn the moderator
		await spawnModerator(chat, processManager, projectRoot);

		// Add participants for each role
		for (const role of template.roles) {
			if (teamRun.aborted) break;
			await addParticipant(
				groupChatId,
				role.name,
				role.agentId,
				processManager,
				projectRoot,
				agentDetector
			);
			onLog('cue', `[CUE] Team run ${runId}: added participant "${role.name}" (${role.agentId})`);
		}

		if (teamRun.aborted) {
			return makeResult('stopped', '', 'Team run was stopped', null);
		}

		// 5. Send the resolved prompt as the initial user message
		await routeUserMessage(groupChatId, resolvedPrompt, processManager, agentDetector);
		onLog('cue', `[CUE] Team run ${runId}: initial prompt routed, workflow started`);

		// 6. Wait for the workflow to complete
		const completionResult = await waitForWorkflowCompletion(
			groupChatId,
			template.topology.exitPoint,
			timeoutMs,
			startTime,
			teamRun
		);

		if (teamRun.aborted) {
			return makeResult('stopped', completionResult.output || '', 'Team run was stopped', null);
		}

		if (completionResult.timedOut) {
			onLog('cue', `[CUE] Team run ${runId}: timed out after ${timeoutMs}ms`);

			// Finalize the workflow as terminated on timeout
			const chat = await loadGroupChat(groupChatId);
			if (chat?.executionState && chat.executionState.status === 'running') {
				const finalState = finalizeWorkflow(chat.executionState, 'terminated');
				await updateGroupChat(groupChatId, { executionState: finalState });
			}

			return makeResult('timeout', completionResult.output || '', 'Team workflow timed out', null);
		}

		// 7. Extract final output
		const status: CueRunStatus = completionResult.status === 'completed' ? 'completed' : 'failed';
		const stderr = completionResult.status === 'failed' ? 'Team workflow failed' : '';

		onLog(
			'cue',
			`[CUE] Team run ${runId}: workflow ${completionResult.status}, output length: ${(completionResult.output || '').length}`
		);

		return makeResult(
			status,
			completionResult.output || '',
			stderr,
			status === 'completed' ? 0 : 1
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		onLog('error', `[CUE] Team run ${runId} failed: ${message}`);
		return makeResult('failed', '', message, null);
	} finally {
		activeTeamRuns.delete(runId);

		// 8. Clean up the temporary group chat
		if (groupChatId) {
			await cleanupGroupChat(groupChatId, processManager, onLog, runId);
		}
	}
}

/**
 * Stop a running Cue team execution.
 * Signals the polling loop to exit and triggers cleanup.
 *
 * @returns true if the run was found and signaled, false if not found
 */
export function stopCueTeamRun(runId: string): boolean {
	const entry = activeTeamRuns.get(runId);
	if (!entry) return false;
	entry.aborted = true;
	return true;
}

/**
 * Get the count of active team runs (for monitoring).
 */
export function getActiveTeamRunCount(): number {
	return activeTeamRuns.size;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Populate the template context with Cue event data.
 * Same logic as executeCuePrompt to ensure consistent variable substitution.
 */
function populateCueContext(
	templateContext: TemplateContext,
	event: CueEvent,
	subscription: CueSubscription,
	runId: string
): void {
	templateContext.cue = {
		eventType: event.type,
		eventTimestamp: event.timestamp,
		triggerName: subscription.name,
		runId,
		filePath: String(event.payload.path ?? ''),
		fileName: String(event.payload.filename ?? ''),
		fileDir: String(event.payload.directory ?? ''),
		fileExt: String(event.payload.extension ?? ''),
		fileChangeType: String(event.payload.changeType ?? ''),
		sourceSession: String(event.payload.sourceSession ?? ''),
		sourceOutput: String(event.payload.sourceOutput ?? ''),
		sourceStatus: String(event.payload.status ?? ''),
		sourceExitCode: String(event.payload.exitCode ?? ''),
		sourceDuration: String(event.payload.durationMs ?? ''),
		sourceTriggeredBy: String(event.payload.triggeredBy ?? ''),
	};

	if (event.type === 'task.pending') {
		templateContext.cue = {
			...templateContext.cue,
			taskFile: String(event.payload.path ?? ''),
			taskFileName: String(event.payload.filename ?? ''),
			taskFileDir: String(event.payload.directory ?? ''),
			taskCount: String(event.payload.taskCount ?? '0'),
			taskList: String(event.payload.taskList ?? ''),
			taskContent: String(event.payload.content ?? ''),
		};
	}

	if (event.type === 'github.pull_request' || event.type === 'github.issue') {
		templateContext.cue = {
			...templateContext.cue,
			ghType: String(event.payload.type ?? ''),
			ghNumber: String(event.payload.number ?? ''),
			ghTitle: String(event.payload.title ?? ''),
			ghAuthor: String(event.payload.author ?? ''),
			ghUrl: String(event.payload.url ?? ''),
			ghBody: String(event.payload.body ?? ''),
			ghLabels: String(event.payload.labels ?? ''),
			ghState: String(event.payload.state ?? ''),
			ghRepo: String(event.payload.repo ?? ''),
			ghBranch: String(event.payload.head_branch ?? ''),
			ghBaseBranch: String(event.payload.base_branch ?? ''),
			ghAssignees: String(event.payload.assignees ?? ''),
			ghMergedAt: String(event.payload.merged_at ?? ''),
		};
	}
}

/** Result from polling the workflow execution state */
interface WorkflowPollResult {
	status: string;
	output: string | undefined;
	timedOut: boolean;
}

/**
 * Poll the group chat's execution state until it reaches a terminal status
 * or the timeout fires.
 */
async function waitForWorkflowCompletion(
	groupChatId: string,
	exitPoint: string,
	timeoutMs: number,
	startTime: number,
	teamRun: ActiveTeamRun
): Promise<WorkflowPollResult> {
	while (true) {
		// Check if run was aborted (stopped)
		if (teamRun.aborted) {
			const chat = await loadGroupChat(groupChatId);
			const output = chat?.executionState?.nodeOutputs[exitPoint];
			return { status: 'stopped', output, timedOut: false };
		}

		// Check timeout
		if (timeoutMs > 0 && Date.now() - startTime > timeoutMs) {
			const chat = await loadGroupChat(groupChatId);
			const output = chat?.executionState?.nodeOutputs[exitPoint];
			return { status: 'timeout', output, timedOut: true };
		}

		// Poll execution state
		const chat = await loadGroupChat(groupChatId);
		if (!chat) {
			return { status: 'failed', output: undefined, timedOut: false };
		}

		const execState = chat.executionState;
		if (execState && execState.status !== 'running') {
			// Workflow reached a terminal state
			const output = execState.nodeOutputs[exitPoint];
			return { status: execState.status, output, timedOut: false };
		}

		// Wait before next poll
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

/**
 * Clean up a temporary group chat: kill moderator, clear participants, delete data.
 */
async function cleanupGroupChat(
	groupChatId: string,
	processManager: IProcessManager,
	onLog: (level: string, message: string) => void,
	runId: string
): Promise<void> {
	try {
		await killModerator(groupChatId, processManager);
		await clearAllParticipantSessions(groupChatId, processManager);
		await deleteGroupChat(groupChatId);
		onLog('cue', `[CUE] Team run ${runId}: cleaned up temporary group chat`);
	} catch (error) {
		// Cleanup errors are non-fatal — log and continue
		onLog(
			'error',
			`[CUE] Team run ${runId}: cleanup error: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}
