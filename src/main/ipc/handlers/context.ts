/**
 * Context Merge IPC Handlers
 *
 * This module provides IPC handlers for context merging operations,
 * enabling session context transfer and grooming across AI agents.
 *
 * Usage:
 * - window.maestro.context.getStoredSession(agentId, projectRoot, sessionId)
 * - window.maestro.context.groomContext(projectRoot, agentType, prompt)
 * - window.maestro.context.cancelGrooming()
 */

import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../../utils/logger';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import { getSessionStorage, type SessionMessagesResult } from '../../agents';
import { groomContext, cancelAllGroomingSessions } from '../../utils/context-groomer';
import {
	utilityLineageOf,
	type ProcessSpawnActor,
	type UtilityTurnLineage,
} from '../../process-manager/types';
import { currentSpawnActor, withdrawDispatchTicket } from '../../web-server/auth/transport-actor';
import { createSshRemoteStoreAdapter } from '../../utils/ssh-remote-resolver';
import { getSettingsStore } from '../../stores';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type Store from 'electron-store';
import type { AgentConfigsData, MaestroSettings } from '../../stores/types';
import { captureException } from '../../utils/sentry';
import { cheapTurnSettings } from '../../../shared/modelTiers';
import type { ToolType } from '../../../shared/types';
import type { ClaudeTokenSourceFields } from '../../../shared/claudeTokenMode';

const LOG_CONTEXT = '[ContextMerge]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (
	operation: string,
	extra?: Partial<CreateHandlerOptions>
): Pick<CreateHandlerOptions, 'context' | 'operation' | 'logSuccess'> => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess: false,
	...extra,
});

/**
 * Reads the `dispatchTicket` option of `context:groomContext` (MRC2-02-03B).
 * Nothing sent is no ticket (`undefined`), the shape of every call before the
 * option existed, so a standalone desktop is unchanged. A ticket must be a
 * plain non-empty string: the renderer echoes the host-minted string as it
 * arrived, so anything else is a malformed request and is refused before a
 * turn runs, never read as "no ticket".
 */
function dispatchTicketOf(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'string' || raw.length === 0) {
		throw new Error('The utility turn dispatch ticket must be a non-empty string.');
	}
	return raw;
}

/**
 * Who this utility turn serves and who asked for it, read off the options a
 * caller sent (MRC2-02-02A, MRC2-02-03B), before any turn runs.
 *
 * A `context:groomContext` call arrives over Electron IPC, outside any
 * transport context, so the groomer's default actor is the operator at the
 * keyboard (`in-process`). A routing turn the Quick Chat engine runs for a
 * `maestro-cli quick-chat send` or a paired device's message carries the
 * `routingTicket` the controller minted inside the sender's context, bound to
 * the engine agent; claiming it here, for the agent (and tab) the lineage
 * names, binds the transport it was issued for, so the turn is admitted with
 * `origin: cli` (or the device) instead of `desktop`. The ticket names no
 * actor: an unknown, spent, expired or mismatched one binds the caller as
 * itself, logged by `currentSpawnActor`.
 *
 * A ticket with no lineage names no agent to claim it for and is refused like
 * a malformed lineage. Either refusal withdraws the ticket first, so a refused
 * call never leaves a claimable ticket behind (the spawn handler's rule). No
 * ticket leaves the actor undefined and the groomer's default applies, so a
 * call that names none is exactly what it was.
 */
function utilityTurnAttribution(raw: { lineage?: unknown; dispatchTicket?: unknown } | undefined): {
	lineage: UtilityTurnLineage | undefined;
	actor: ProcessSpawnActor | undefined;
} {
	const ticket = dispatchTicketOf(raw?.dispatchTicket);
	let lineage: UtilityTurnLineage | undefined;
	try {
		lineage = utilityLineageOf(raw?.lineage);
		if (ticket !== undefined && !lineage) {
			throw new Error(
				'A dispatch ticket on a utility turn needs a lineage naming the agent it was issued for.'
			);
		}
	} catch (error) {
		if (ticket !== undefined) withdrawDispatchTicket(ticket);
		throw error;
	}
	if (ticket === undefined || !lineage) return { lineage, actor: undefined };
	return {
		lineage,
		actor: currentSpawnActor({ ticket, agentId: lineage.sessionId, tabId: lineage.tabId }),
	};
}

/**
 * Dependencies required for context handler registration
 */
export interface ContextHandlerDependencies {
	getMainWindow: () => BrowserWindow | null;
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	agentConfigsStore: Store<AgentConfigsData>;
	settingsStore: Store<MaestroSettings>;
}

/**
 * Register all Context Merge IPC handlers.
 *
 * These handlers support context merging operations:
 * - getStoredSession: Retrieve messages from an agent session storage
 * - groomContext: Run one batch turn with a prompt and return its response
 * - cancelGrooming: Stop every grooming turn in progress
 */
export function registerContextHandlers(deps: ContextHandlerDependencies): void {
	const { getProcessManager, getAgentDetector, agentConfigsStore, settingsStore } = deps;

	logger.info('Registering context IPC handlers', LOG_CONTEXT);

	// Get context from a stored agent session
	ipcMain.handle(
		'context:getStoredSession',
		withIpcErrorLogging(
			handlerOpts('getStoredSession'),
			async (
				agentId: string,
				projectRoot: string,
				sessionId: string
			): Promise<SessionMessagesResult | null> => {
				logger.debug('Getting stored session context', LOG_CONTEXT, {
					agentId,
					projectRoot,
					sessionId,
				});

				const storage = getSessionStorage(agentId);
				if (!storage) {
					logger.warn(`No session storage available for agent: ${agentId}`, LOG_CONTEXT);
					return null;
				}

				try {
					const result = await storage.readSessionMessages(projectRoot, sessionId);
					logger.debug('Retrieved session messages', LOG_CONTEXT, {
						agentId,
						sessionId,
						messageCount: result.messages.length,
						total: result.total,
					});
					return result;
				} catch (error) {
					void captureException(error);
					logger.error('Failed to read session messages', LOG_CONTEXT, {
						agentId,
						projectRoot,
						sessionId,
						error: String(error),
					});
					return null;
				}
			}
		)
	);

	// Single-call grooming: spawns a batch mode process with the prompt.
	ipcMain.handle(
		'context:groomContext',
		withIpcErrorLogging(
			handlerOpts('groomContext'),
			async (
				projectRoot: string,
				agentType: string,
				prompt: string,
				options?: {
					sshRemoteConfig?: {
						enabled: boolean;
						remoteId: string | null;
						workingDirOverride?: string;
					};
					customPath?: string;
					customArgs?: string;
					customEnvVars?: Record<string, string>;
					/**
					 * Pin this turn to the bottom of both ladders. Summarization sets it;
					 * grooming and transfer must not, because their output becomes the
					 * context every later turn reads. The handler cannot tell the three
					 * apart - it only receives a prompt string - so the caller decides.
					 */
					cheapTurn?: boolean;
					/**
					 * For a turn that only ANSWERS (a classification, a one-word
					 * decision): no tool may run, nothing may be written, and the call
					 * gives up after `timeoutMs` instead of the grooming default. Quick
					 * Chat's tab routing sets all three.
					 */
					readOnly?: boolean;
					disableTools?: boolean;
					timeoutMs?: number;
					/** The session agent's Claude token source (see GroomContextOptions). */
					claudeTokenSource?: ClaudeTokenSourceFields;
					/**
					 * The agent and tab this turn serves (MRC2-02-02A), so the sink
					 * traces it under `<agent>-ai-<tab>` beside the turns it was run
					 * for instead of under its own `groomer-*` id. Attribution only:
					 * it lends the turn nothing. Left out, the turn is traced under
					 * its own id, as before.
					 */
					lineage?: { sessionId: string; tabId?: string };
					/**
					 * A host-minted dispatch ticket (MRC2-02-03B): the `routingTicket`
					 * the Quick Chat controller issued for a send that arrived over a
					 * transport, echoed by the engine so this turn is admitted for the
					 * CLI or device that asked instead of the operator at the keyboard.
					 * Opaque and single-use; never an actor (see `issueDispatchTicket`).
					 * Needs `lineage`, which names the agent it was issued for. Left
					 * out, the turn is admitted as the desktop, as before.
					 */
					dispatchTicket?: string;
				}
			): Promise<string> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
				// Checked at the boundary: a malformed id or an orphan ticket is refused
				// before any turn runs, and a ticket is spent (or withdrawn) here,
				// before anything else can refuse, whatever happens to the turn.
				const { lineage, actor } = utilityTurnAttribution(options);

				// Resolve the agent: use the utility agent if configured, otherwise the
				// requested agent. Null/empty leaves behavior unchanged (session agent).
				const utilityAgentId = settingsStore.get('utilityAgentId', null) as string | null;
				const utilityModelId = settingsStore.get('utilityModelId', null) as string | null;
				const effectiveAgentType = utilityAgentId || agentType;

				// Look up agent-level config values for override resolution
				const allConfigs = agentConfigsStore.get('configs', {});
				const agentConfigValues = allConfigs[effectiveAgentType] || {};

				// The session's executable overrides describe the SESSION's agent: a
				// pinned binary path, its CLI flags, its env. Carrying them onto a
				// different utility agent would launch the wrong executable, or feed
				// one agent's flags to another. The utility agent's own settings come
				// from `agentConfigValues`, which is already keyed by the effective id.
				//
				// `sshRemoteConfig` is deliberately NOT dropped: it says WHERE the work
				// runs, not WHICH binary runs it, and grooming a remote agent's context
				// on the local machine would look at the wrong filesystem.
				const usingUtilityAgent = !!utilityAgentId && effectiveAgentType !== agentType;

				// Only summarization opts in (see `cheapTurn` above). Left undefined
				// for grooming and transfer, which keep the agent's configured model.
				const cheapTurn = options?.cheapTurn ? cheapTurnSettings(agentType as ToolType) : undefined;

				// Use the shared groomContext utility
				const result = await groomContext(
					{
						projectRoot,
						agentType: effectiveAgentType,
						prompt,
						// Only apply the model override when a utility agent is actually in use.
						modelId: utilityAgentId ? (utilityModelId ?? undefined) : undefined,
						// Pass SSH and custom config for remote execution support.
						// The store lets groomContext resolve `remoteId` and actually
						// wrap the spawn with ssh - without it grooming would run the
						// prompt locally (issue #1416).
						sessionSshRemoteConfig: options?.sshRemoteConfig,
						sshStore: options?.sshRemoteConfig?.enabled
							? createSshRemoteStoreAdapter(getSettingsStore())
							: undefined,
						// A utility agent runs as ITSELF, so the calling session's own
						// binary path / args / env must not leak into its spawn.
						sessionCustomPath: usingUtilityAgent ? undefined : options?.customPath,
						sessionCustomArgs: usingUtilityAgent ? undefined : options?.customArgs,
						sessionCustomEnvVars: usingUtilityAgent ? undefined : options?.customEnvVars,
						// Undefined unless the caller asked for a cheap turn, and
						// undefined means "inherit the agent's own value" all the way
						// down - so grooming and transfer are untouched by this. An
						// explicit tier is not the caller's own setting leaking, so it
						// applies to a utility agent too.
						sessionCustomModel: cheapTurn?.model,
						sessionCustomEffort: cheapTurn?.effort,
						// The token source belongs to the session's agent, like its path
						// and env above, so a utility agent runs on its own default.
						claudeTokenSource: usingUtilityAgent ? undefined : options?.claudeTokenSource,
						agentConfigValues,
						readOnlyMode: options?.readOnly,
						disableTools: options?.disableTools,
						timeoutMs: options?.timeoutMs,
						lineage,
						// Only when a ticket bound one: left out, the groomer's own
						// default (`in-process`) applies, as for every call before.
						...(actor ? { actor } : {}),
					},
					processManager,
					agentDetector
				);

				return result.response;
			}
		)
	);

	// Cancel all active grooming sessions
	ipcMain.handle(
		'context:cancelGrooming',
		withIpcErrorLogging(handlerOpts('cancelGrooming'), async (): Promise<void> => {
			logger.info('Cancelling all grooming sessions via IPC', LOG_CONTEXT);
			cancelAllGroomingSessions();
		})
	);
}
