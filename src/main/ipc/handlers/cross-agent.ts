import { startReleasedQueueConsult } from '../../pianola/pianola-queue-routing';
/**
 * Cross-Agent Dispatch IPC Handlers (Phase 03).
 *
 * Exposes `cross-agent:send` to the renderer: the user typed `@target ...` in
 * a source agent, and the renderer forwards the (already windowed) source
 * transcript + the user's prompt here. We stamp a `requestId`, kick off
 * {@link startCrossAgentRequest} (non-blocking), and forward every response
 * chunk back to the renderer via `cross-agent:chunk`.
 *
 * Session-config resolution reads the same main-process session store Group
 * Chat uses; SSH is honored via the shared SSH store adapter.
 */

import { ipcMain } from 'electron';
import * as os from 'os';
import type Store from 'electron-store';
import {
	withIpcErrorLogging,
	requireDependency,
	CreateHandlerOptions,
} from '../../utils/ipcHandler';
import type { ProcessManager } from '../../process-manager';
import type { AgentDetector } from '../../agents';
import type { SessionsData, AgentConfigsData, SettingsStoreInterface } from '../../stores/types';
import type { SafeSendFn } from '../../utils/safe-send';
import type { SshRemoteSettingsStore } from '../../utils/ssh-remote-resolver';
import type { ToolType } from '../../../shared/types';
import type {
	CrossAgentRequest,
	CrossAgentSendRequest,
	CrossAgentResponseChunk,
} from '../../../shared/crossAgentTypes';
import { generateUUID } from '../../../shared/uuid';
import { logger } from '../../utils/logger';
import {
	claimDispatchTicket,
	currentSpawnActor,
	transportSpawnActor,
} from '../../web-server/auth/transport-actor';
import {
	startCrossAgentRequest,
	cancelCrossAgentRequestsForSource,
	type CrossAgentTargetSession,
} from '../../cross-agent/cross-agent-router';

const LOG_CONTEXT = '[CrossAgent]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

export interface CrossAgentHandlerDependencies {
	getProcessManager: () => ProcessManager | null;
	getAgentDetector: () => AgentDetector | null;
	/** Session store (source of the target agent's toolType / cwd / SSH config). */
	sessionsStore: Store<SessionsData>;
	/** Per-agent config values (context window, model, effort, custom env vars). */
	agentConfigsStore: Store<AgentConfigsData>;
	/** App settings store; read for the consult and hand-off write switches. */
	settingsStore: SettingsStoreInterface;
	/** SSH remote store adapter; null disables remote execution. */
	sshStore: SshRemoteSettingsStore | null;
	/** Per-agent custom env var resolver (fallback when no session override). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Safe renderer push used to stream `cross-agent:chunk` events. */
	safeSend: SafeSendFn;
	getWebServer?: () => import('../../web-server/WebServer').WebServer | null;
	getWindowForSession?: (sessionId: string) => import('electron').BrowserWindow | null | undefined;
}

/**
 * Whether a cross-agent request may modify files. A consult answers a question,
 * so it is read-only unless the user opted in (`crossAgentMentionsWritable`,
 * default off). A hand-off passes work on - "feed what we learn to @X" usually
 * means X should save it - so it may write unless the user opted out
 * (`crossAgentHandoffsWritable`, default on). Exported for unit testing.
 */
export function resolveCrossAgentWritable(
	request: Pick<CrossAgentRequest, 'handoffAnswer'>,
	settingsStore: Pick<SettingsStoreInterface, 'get'>
): boolean {
	if (request.handoffAnswer !== undefined) {
		return settingsStore.get('crossAgentHandoffsWritable', true) as boolean;
	}
	return settingsStore.get('crossAgentMentionsWritable', false) as boolean;
}

/**
 * Register the cross-agent dispatch IPC handlers.
 */
export function registerCrossAgentHandlers(deps: CrossAgentHandlerDependencies): void {
	const {
		getProcessManager,
		getAgentDetector,
		sessionsStore,
		agentConfigsStore,
		settingsStore,
		sshStore,
		getCustomEnvVars,
		safeSend,
	} = deps;

	/** Resolve a target agent's stored config into the router's input shape. */
	const getTargetSession = (sessionId: string): CrossAgentTargetSession | null => {
		const sessions = sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
		const s = sessions.find((x) => x && typeof x === 'object' && x.id === sessionId) as
			| Record<string, any>
			| undefined;
		if (!s) return null;
		return {
			id: s.id,
			name: s.name,
			toolType: s.toolType as ToolType,
			cwd: s.cwd || s.fullPath || os.homedir(),
			customPath: s.customPath,
			customArgs: s.customArgs,
			customEnvVars: s.customEnvVars,
			customModel: s.customModel,
			customEffort: s.customEffort,
			customContextWindow: s.customContextWindow,
			enableMaestroP: s.enableMaestroP,
			maestroPMode: s.maestroPMode,
			maestroPPath: s.maestroPPath,
			sshRemoteConfig: s.sessionSshRemoteConfig ?? null,
		};
	};

	/** Agent-level config values (mirrors director-notes' resolution). */
	const getAgentConfig = (toolType: string): Record<string, unknown> => {
		const allConfigs = agentConfigsStore.get('configs', {}) as Record<
			string,
			Record<string, unknown>
		>;
		return allConfigs[toolType] || {};
	};

	ipcMain.handle(
		'cross-agent:prepare-queue',
		(event, input: { sourceSessionId: string; sourceTabId: string; dispatchId: string }) =>
			withIpcErrorLogging(handlerOpts('prepare-queue'), async () => {
				const assertOwner = () => {
					const win = deps.getWindowForSession?.(input.sourceSessionId);
					if (
						'clientId' in event ||
						!win ||
						event.sender !== win.webContents ||
						event.sender.isDestroyed()
					)
						throw new Error('DispatchWindowOwnerMismatch');
				};
				assertOwner();
				const server = deps.getWebServer?.();
				if (!server) throw new Error('DispatchQueueDrainUnavailable');
				const prepared = await server.prepareQueueSpawnFromMain(
					input.sourceSessionId,
					input.sourceTabId,
					input.dispatchId,
					assertOwner,
					{
						onSettled: (progress) =>
							safeSend('cross-agent:queue-settled', {
								sourceSessionId: input.sourceSessionId,
								sourceTabId: input.sourceTabId,
								dispatchId: input.dispatchId,
								...progress,
							}),
					}
				);
				if (
					!('routing' in prepared) ||
					!prepared.routing ||
					!prepared.generation ||
					!prepared.targetSessionIds
				)
					throw new Error('DispatchRoutingReleaseUnavailable');
				return {
					generation: prepared.generation,
					routing: prepared.routing,
					targetSessionIds: prepared.targetSessionIds,
				};
			})(event)
	);

	ipcMain.handle('cross-agent:send', (event, wirePayload: CrossAgentSendRequest) =>
		withIpcErrorLogging(
			handlerOpts('send'),
			async (payload: CrossAgentSendRequest): Promise<{ requestId: string }> => {
				const processManager = requireDependency(getProcessManager, 'Process manager');
				const agentDetector = requireDependency(getAgentDetector, 'Agent detector');

				const source = sessionsStore
					.get('sessions', [])
					.find((s) => s.id === payload.sourceSessionId);
				if (
					!payload.managedQueue &&
					source?.executionQueue?.some(
						(item: { tabId?: string; pendingAdmissionId?: string; admissionRelease?: unknown }) =>
							item.tabId === payload.sourceTabId && item.pendingAdmissionId && item.admissionRelease
					)
				) {
					throw new Error('DispatchRoutingQueueConsumerRequired');
				}
				if (payload.managedQueue) {
					const assertOwner = () => {
						const win = deps.getWindowForSession?.(payload.sourceSessionId);
						if (
							'clientId' in event ||
							!win ||
							event.sender !== win.webContents ||
							event.sender.isDestroyed()
						) {
							throw new Error('DispatchWindowOwnerMismatch');
						}
					};
					assertOwner();
					// Never use a renderer prompt, transcript, resume id or handoff answer to
					// expand a durable queue intent. The host builds this branch itself.
					if (
						payload.handoffAnswer !== undefined ||
						payload.dispatchTicket !== undefined ||
						payload.resumeAgentSessionId ||
						payload.transcript.length
					) {
						throw new Error('DispatchRoutingContextUnavailable');
					}
					const server = deps.getWebServer?.();
					const start = payload.managedQueue.handoff
						? server?.startQueueHandoffFromMain.bind(server)
						: undefined;
					if (payload.managedQueue.handoff && !start)
						throw new Error('DispatchRoutingReleaseUnavailable');
					const nativeStart = start
						? (
								locator: { dispatchId: string; generation: string },
								source: string,
								tab: string,
								target: string,
								opts: Parameters<typeof startReleasedQueueConsult>[4]
							) => start(source, tab, locator, target, opts)
						: startReleasedQueueConsult;
					return nativeStart(
						payload.managedQueue,
						payload.sourceSessionId,
						payload.sourceTabId,
						payload.targetSessionId,
						{
							assertNativeOwner: assertOwner,
							actor: currentSpawnActor(),
							processManager,
							agentDetector,
							sshStore,
							getTargetSession: (id) => {
								assertOwner();
								return getTargetSession(id);
							},
							getAgentConfig,
							getCustomEnvVars,
							writable: resolveCrossAgentWritable({}, settingsStore),
							onChunk: (chunk) => safeSend('cross-agent:chunk', chunk),
						}
					);
				}

				// The consult spawns here, in the main process, outside the transport
				// context a `cross_agent_ask` was admitted in. Claim the ticket the WS
				// handler issued for the target (for any tab: the consult tab is the
				// renderer's to find or create), else bind the caller's own standing.
				// A forged, spent, expired or mismatched ticket binds nothing, and a
				// typed `@mention` carries none and stays in-process (MRC-08-01C).
				const ticket =
					typeof payload.dispatchTicket === 'string' && payload.dispatchTicket.length > 0
						? payload.dispatchTicket
						: undefined;
				const issuedFor =
					ticket === undefined
						? undefined
						: claimDispatchTicket(ticket, {
								agentId: payload.targetSessionId,
								tabId: payload.targetTabId,
							});
				if (ticket !== undefined && issuedFor === undefined) {
					logger.warn(
						'Dispatch ticket not honored (unknown, spent, expired or mismatched); binding the caller as itself',
						LOG_CONTEXT,
						{ agentId: payload.targetSessionId, tabId: payload.targetTabId }
					);
				}
				const actor = issuedFor ? transportSpawnActor(issuedFor) : currentSpawnActor();
				// Only an honored ticket names this consult to the router (MCOMP-17-03AU), so
				// withdrawing the ask (its source lost custody) stops exactly the consult it
				// started. A replayed or forged ticket must not re-point that withdrawal at a
				// consult bound in-process, nor leave the credentialed one running.
				const dispatchTicket = issuedFor ? ticket : undefined;

				const requestId = generateUUID();
				const request: CrossAgentRequest = {
					requestId,
					sourceSessionId: payload.sourceSessionId,
					sourceAgentName: payload.sourceAgentName,
					sourceTabId: payload.sourceTabId,
					targetSessionId: payload.targetSessionId,
					targetTabId: payload.targetTabId,
					resumeAgentSessionId: payload.resumeAgentSessionId,
					userPrompt: payload.userPrompt,
					transcript: payload.transcript,
					strategy: payload.strategy,
					sourceCwd: payload.sourceCwd,
					handoffAnswer: payload.handoffAnswer,
					createdAt: Date.now(),
				};

				// Consults are read-only by default; hand-offs may write by default,
				// because passing work on is their point. Each has its own switch
				// under Settings > General > Cross-Agent Mentions.
				const writable = resolveCrossAgentWritable(request, settingsStore);

				logger.info(`${LOG_CONTEXT} Dispatching cross-agent request`, LOG_CONTEXT, {
					requestId,
					sourceSessionId: payload.sourceSessionId,
					targetSessionId: payload.targetSessionId,
					transcriptEntries: payload.transcript.length,
					writable,
				});

				// Fire-and-forget: startCrossAgentRequest resolves once the spawn is
				// initiated; response chunks arrive over time via onChunk. Any error
				// during dispatch is surfaced as a terminal error chunk (either by the
				// router or the catch below), never thrown back to the renderer.
				void startCrossAgentRequest(request, {
					processManager,
					agentDetector,
					sshStore,
					getTargetSession,
					getAgentConfig,
					getCustomEnvVars,
					writable,
					actor,
					dispatchTicket,
					onChunk: (chunk: CrossAgentResponseChunk) => safeSend('cross-agent:chunk', chunk),
				}).catch((err) => {
					logger.error(`${LOG_CONTEXT} Cross-agent dispatch failed`, LOG_CONTEXT, {
						requestId,
						error: err instanceof Error ? err.message : String(err),
					});
					const errorTarget = getTargetSession(payload.targetSessionId);
					const errorChunk: CrossAgentResponseChunk = {
						requestId,
						sourceSessionId: payload.sourceSessionId,
						sourceTabId: payload.sourceTabId,
						targetSessionId: payload.targetSessionId,
						targetTabId: payload.targetTabId,
						targetAgentName: errorTarget?.name ?? payload.targetSessionId,
						targetToolType: (errorTarget?.toolType ?? 'claude-code') as ToolType,
						chunk: '',
						done: true,
						error: err instanceof Error ? err.message : String(err),
					};
					safeSend('cross-agent:chunk', errorChunk);
				});

				return { requestId };
			}
		)(event, wirePayload)
	);

	ipcMain.handle(
		'cross-agent:cancel',
		withIpcErrorLogging(
			handlerOpts('cancel'),
			async (payload: {
				sourceSessionId: string;
				sourceTabId?: string;
			}): Promise<{ canceled: number }> => {
				// Stop in the source agent must reach every agent its turn fanned out to,
				// not just the tab process. Addressed by source agent (never by request
				// id) because the renderer only learns a request id once `send` resolves,
				// and a Stop pressed before that would otherwise miss a live consult.
				// A Stop aimed at one tab narrows it to that tab's consults.
				const sourceTabId =
					typeof payload.sourceTabId === 'string' ? payload.sourceTabId : undefined;
				const canceled = cancelCrossAgentRequestsForSource(payload.sourceSessionId, sourceTabId);
				if (canceled > 0) {
					logger.info(`${LOG_CONTEXT} Stopped in-flight consults`, LOG_CONTEXT, {
						sourceSessionId: payload.sourceSessionId,
						sourceTabId,
						canceled,
					});
				}
				return { canceled };
			}
		)
	);
}
