/**
 * Commands domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: send_command, switch_mode,
 * interrupt_turn, select_session, cross_agent_ask.
 */

import { logger } from '../../../utils/logger';
import { readBackgroundField } from '../../../../shared/focusPlacement';
import { getDispatchCallbackRegistry } from '../../../dispatch-callbacks';
import { armDispatchCallback } from './dispatchCallbacks';
import { noteDispatchDelegation, readDispatchDelegation } from './agentDelegation';
import {
	describeTransportAdmission,
	issueDispatchTicket,
	resolveTransportAdmission,
	withdrawDispatchTicket,
} from '../../auth/transport-actor';
import { LOG_CONTEXT } from './shared';
import { interruptTurnFailure } from '../../../../shared/turnInterrupt';
import { parseMentionRoutingField } from '../../../../shared/crossAgentContext';
import { findSessionForParticipantName } from '../../../../shared/group-chat-types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Timeout bounds for a cross-agent consult. A consult spawns a whole agent turn,
 * so the floor is generous and the ceiling is an hour - past that the caller has
 * almost certainly gone away and the process is better killed than awaited.
 */
const MIN_CONSULT_TIMEOUT_MS = 10_000;
const MAX_CONSULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_CONSULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Handle send_command message - execute command in session
 */
export function handleSendCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const command = message.command as string;
	// inputMode from web client - use this instead of server state to avoid sync issues
	const clientInputMode = message.inputMode as 'ai' | 'terminal' | undefined;
	// Optional explicit tab target. When omitted, the renderer falls back to
	// the active tab (legacy `send --live` behavior). Used by
	// `maestro-cli dispatch --session <tabId>` to address a specific tab.
	const requestedTabId = typeof message.tabId === 'string' ? message.tabId : undefined;
	// force=true bypasses the busy-state guard below, allowing callers to
	// dispatch concurrent writes to an already-running agent. Used by
	// `maestro-cli dispatch --force`. That is the WHOLE of what it bypasses: it
	// is a scheduling hint, not authority. The turn it dispatches is admitted
	// at the spawn sink for the transport that sent it exactly as an unforced
	// one is, and a managed refusal there comes back as a failed command_result
	// whatever this flag says (MRC-08-01).
	const force = message.force === true;
	// background=true suppresses the desktop's focus side effect (switching
	// to the target agent/tab). `maestro-cli dispatch` sets this by default;
	// passing `--focus` clears it to bring the target to the foreground.
	const background = message.background === true;
	// Optional base64 data URLs pasted from the web client. Threaded through
	// to the renderer so AI tabs can include them in the agent prompt.
	const images = Array.isArray(message.images)
		? (message.images as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;

	// Which transport admitted the caller (a Web Login account, the CLI secret,
	// a Lite pairing, the path token): named in the log and, through the client
	// context the message handler established, bound by every host sink this
	// dispatch reaches. Transport admission is not tenant IAM: none of these is
	// an enterprise principal, so none of them widens what the sink admits.
	const admission = resolveTransportAdmission(client);
	const transport = describeTransportAdmission(admission);
	logger.info(
		`[Web Command] Received: sessionId=${sessionId}, inputMode=${clientInputMode}, transport=${transport}, command=${command?.substring(0, 50)}, images=${images?.length ?? 0}`,
		LOG_CONTEXT
	);

	// Image-only sends are valid in AI mode (the composer lets users paste
	// images and submit without typing), so the guard accepts either a
	// non-empty command OR at least one image. Normalize a missing command
	// to '' so the renderer's downstream LogEntry.text stays a string.
	const hasImages = !!images && images.length > 0;
	if (!sessionId || (!command && !hasImages)) {
		logger.warn(
			`[Web Command] Missing sessionId or command/images: sessionId=${sessionId}, commandLen=${command?.length}, images=${images?.length ?? 0}`,
			LOG_CONTEXT
		);
		ctx.sendError(client, 'Missing sessionId or command');
		return;
	}
	const effectiveCommand = command ?? '';

	// `dispatch --routing`: a routing the caller named but that is not one is
	// refused, never dropped, so the prompt cannot run on the wording's routing
	// behind a caller who asked for another.
	const routingField = parseMentionRoutingField(message.mentionRouting);
	if (!routingField.ok) {
		ctx.sendError(client, routingField.error, { sessionId });
		return;
	}
	const mentionRouting = routingField.routing;

	// Get session details to check state and determine how to handle
	const sessionDetail = ctx.callbacks.getSessionDetail?.(sessionId);
	if (!sessionDetail) {
		ctx.sendError(client, 'Session not found');
		return;
	}

	// Check if session is busy - prevent race conditions between desktop and web.
	// `force: true` opts out of this guard (see `maestro-cli send --live --force`).
	if (sessionDetail.state === 'busy' && !force) {
		ctx.sendError(client, 'Session is busy - please wait for the current operation to complete', {
			sessionId,
		});
		logger.debug(`Command rejected - session ${sessionId} is busy`, LOG_CONTEXT);
		return;
	}
	if (sessionDetail.state === 'busy' && force) {
		logger.info(`[Web Command] Force-dispatching to busy session ${sessionId}`, LOG_CONTEXT);
	}

	// Use client's inputMode if provided, otherwise fall back to server state
	const effectiveMode = clientInputMode || sessionDetail.inputMode;
	const isAiMode = effectiveMode === 'ai';
	const mode = isAiMode ? 'AI' : 'CLI';
	const claudeId = sessionDetail.agentSessionId || 'none';

	// Log all web interface commands prominently
	logger.info(
		`[Web Command] Mode: ${mode} | Session: ${sessionId}${isAiMode ? ` | Claude: ${claudeId}` : ''} | Message: ${effectiveCommand} | Images: ${images?.length ?? 0}`,
		LOG_CONTEXT
	);

	// Only echo a tabId in command_result when the caller passed one
	// explicitly. Returning the server's snapshot of `activeTabId` for the
	// no-tabId path would lie when the user switches active tabs between
	// the IPC send and IPC receive - callers chaining `dispatch --session
	// <returnedTabId>` would think they are continuing a conversation that
	// actually went to a different tab. For deterministic addressing,
	// callers should use `dispatch --new-tab` (returns the new tabId from
	// the renderer ack) and then `dispatch --session <tabId>` (echoes back
	// the caller-supplied authoritative tabId).
	const resolvedTabId = requestedTabId;

	// The context of the operation that dispatched this prompt, when one did.
	// Read before the callback is armed and before the renderer hears of it: a
	// record that is not a context refuses the whole command (the CLI reads a
	// `success: false` command_result as DISPATCH_REFUSED), never a fresh turn.
	const delegationRead = readDispatchDelegation(message);
	if (!delegationRead.ok) {
		ctx.send(client, {
			type: 'command_result',
			success: false,
			sessionId,
			error: delegationRead.error,
			requestId: message.requestId,
		});
		logger.warn(
			`[Web Command] Dispatch refused for session ${sessionId}: delegation context invalid`,
			LOG_CONTEXT
		);
		return;
	}
	const delegation = delegationRead.delegation;

	// Arm a `--notify-on-complete` callback BEFORE handing the prompt to the
	// renderer: the renderer can spawn the agent process before this handler's
	// promise resolves, and an entry registered after that spawn would sit
	// unarmed until it timed out. Cancelled below if the dispatch is rejected.
	let sendCallbackId: string | undefined;
	if (typeof message.notifyOnComplete === 'string' && message.notifyOnComplete) {
		if (!requestedTabId) {
			ctx.sendError(client, '--notify-on-complete requires an explicit target tab', {
				sessionId,
			});
			return;
		}
		const armed = armDispatchCallback(ctx, message, {
			agentId: sessionId,
			tabId: requestedTabId,
			prompt: effectiveCommand,
			isNewTab: false,
		});
		if (armed.error) {
			ctx.sendError(client, armed.error, { sessionId });
			return;
		}
		sendCallbackId = armed.callbackId;
	}
	const cancelArmedCallback = () => {
		if (sendCallbackId) getDispatchCallbackRegistry()?.cancel(sendCallbackId);
	};

	// The transport does not survive the hop through the renderer: the spawn
	// comes back over Electron IPC, outside this client's context, and the sink
	// would read it as the desktop's own action. A host-minted ticket, issued
	// here and bound to this agent and tab, lets the spawn handler bind the
	// transport that actually asked (MRC-08-01B). Only an AI turn spawns; a
	// terminal write never reaches the spawn sink, so it carries none.
	const dispatchTicket = isAiMode
		? issueDispatchTicket(admission, { agentId: sessionId, tabId: requestedTabId })
		: undefined;
	const withdrawTicket = () => {
		if (dispatchTicket) withdrawDispatchTicket(dispatchTicket);
	};

	// Route ALL commands through the renderer for consistent handling
	// The renderer handles both AI and terminal modes, updating UI and state
	// Pass clientInputMode so renderer uses the web's intended mode
	if (ctx.callbacks.executeCommand) {
		ctx.callbacks
			.executeCommand(
				sessionId,
				effectiveCommand,
				clientInputMode,
				requestedTabId,
				force,
				images,
				background,
				mentionRouting,
				delegation,
				dispatchTicket
			)
			.then((success) => {
				if (!success) {
					cancelArmedCallback();
					withdrawTicket();
				}
				ctx.send(client, {
					type: 'command_result',
					success,
					sessionId,
					...(resolvedTabId ? { tabId: resolvedTabId } : {}),
					...(success && sendCallbackId ? { callbackId: sendCallbackId } : {}),
					requestId: message.requestId,
				});
				if (!success) {
					logger.warn(
						`[Web Command] ${mode} command rejected for session ${sessionId}`,
						LOG_CONTEXT
					);
				} else if (isAiMode) {
					noteDispatchDelegation(ctx, message, {
						targetSessionId: sessionId,
						targetTabId: requestedTabId,
						prompt: effectiveCommand,
					});
				}
			})
			.catch((error) => {
				cancelArmedCallback();
				withdrawTicket();
				ctx.reportHandlerError(
					client,
					error,
					'send_command',
					{ sessionId, mode, requestId: message.requestId },
					'Failed to execute command'
				);
			});
	} else {
		cancelArmedCallback();
		ctx.sendError(client, 'Command execution not configured');
	}
}

/**
 * Handle switch_mode message - switch between AI and terminal mode
 *
 * When switching to terminal mode, spawns a dedicated PTY process for the web client
 * (session ID: {sessionId}-terminal). When switching back to AI, kills it.
 */
export function handleSwitchMode(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const mode = message.mode as 'ai' | 'terminal';
	const background = readBackgroundField(message);
	const transport = describeTransportAdmission(resolveTransportAdmission(client));
	logger.info(
		`[Web] Received switch_mode message: session=${sessionId}, mode=${mode}, background=${background}, transport=${transport}`,
		LOG_CONTEXT
	);

	if (!sessionId || !mode) {
		ctx.sendError(client, 'Missing sessionId or mode');
		return;
	}

	if (!ctx.callbacks.switchMode) {
		logger.warn(`[Web] switchModeCallback is not set!`, LOG_CONTEXT);
		ctx.sendError(client, 'Mode switching not configured');
		return;
	}

	// Forward to desktop's mode switching logic
	// This ensures single source of truth - desktop handles state updates and broadcasts
	logger.info(`[Web] Calling switchModeCallback for session ${sessionId}: ${mode}`, LOG_CONTEXT);
	ctx.callbacks
		.switchMode(sessionId, mode, background)
		.then(async (success) => {
			// Spawn or kill the web terminal PTY based on mode
			if (success && mode === 'terminal') {
				// Look up session CWD for the terminal working directory
				const sessionDetail = ctx.callbacks.getSessionDetail?.(sessionId);
				const cwd = sessionDetail?.cwd || process.cwd();
				try {
					// A host sink: the PTY is spawned in the main process, admitted for
					// the actor this client's context resolved (see terminalCallbacks).
					const spawnResult = await ctx.callbacks.spawnTerminalForWeb?.(sessionId, { cwd });
					logger.info(
						`[Web] Terminal PTY spawn for ${sessionId}: success=${spawnResult?.success}, transport=${transport}${spawnResult?.managed ? `, managed=${spawnResult.managed.state}/${spawnResult.managed.code}` : ''}`,
						LOG_CONTEXT
					);
					if (spawnResult?.success) {
						// Notify the web client that the PTY is ready so it can re-send
						// its current dimensions (the initial resize fired before the PTY existed)
						ctx.send(client, {
							type: 'terminal_ready',
							sessionId,
						});
					} else {
						// PTY failed to spawn - report failure so the client can roll back.
						// A managed refusal names the authority's reason, state and code:
						// the client learns there is no shell for this actor on this host,
						// not that a spawn "failed".
						ctx.send(client, {
							type: 'mode_switch_result',
							success: false,
							sessionId,
							mode,
							error: spawnResult?.error ?? 'Failed to spawn terminal PTY',
							...(spawnResult?.managed ? { managed: spawnResult.managed } : {}),
							requestId: message.requestId,
						});
						return;
					}
				} catch (err) {
					logger.error(`[Web] Failed to spawn terminal PTY for ${sessionId}: ${err}`, LOG_CONTEXT);
					ctx.send(client, {
						type: 'mode_switch_result',
						success: false,
						sessionId,
						mode,
						error: `Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}`,
						requestId: message.requestId,
					});
					return;
				}
			}
			// When switching back to AI, keep the terminal PTY alive so the user
			// can return to a running process (e.g. npm run dev). The PTY is only
			// killed when the session itself is removed.

			ctx.send(client, {
				type: 'mode_switch_result',
				success,
				sessionId,
				mode,
				requestId: message.requestId,
			});
			logger.debug(
				`Mode switch for session ${sessionId} to ${mode}: ${success ? 'success' : 'failed'}`,
				LOG_CONTEXT
			);
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to switch mode: ${error.message}`);
		});
}

/**
 * Handle interrupt_turn message - stop a running turn (`maestro-cli interrupt`).
 *
 * No `tabId` is the agent-level Stop the desktop pill runs (every busy tab);
 * a `tabId` narrows it to that tab. The reply is the renderer's
 * `InterruptTurnResult` plus main's `exited` read of the process table, so the
 * caller knows whether anything ran and whether it has stopped. A call with
 * nothing to stop succeeds with `wasBusy: false`.
 */
export function handleInterruptTurn(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const tabId = typeof message.tabId === 'string' && message.tabId ? message.tabId : undefined;

	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'interrupt_turn_result', ...payload, requestId: message.requestId });
	};

	if (!sessionId) {
		reply({ success: false, error: 'Missing sessionId' });
		return;
	}
	if (!ctx.callbacks.interruptSession) {
		reply({
			...interruptTurnFailure(
				sessionId,
				tabId ?? null,
				'RENDERER_UNAVAILABLE',
				'Interrupting a turn is not configured'
			),
		});
		return;
	}

	logger.info(
		`[Web] Received interrupt_turn: session=${sessionId}, tab=${tabId ?? 'all'}`,
		LOG_CONTEXT
	);
	ctx.callbacks
		.interruptSession(sessionId, tabId)
		.then((result) => reply({ ...result }))
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'interrupt_turn',
				{ sessionId, tabId, requestId: message.requestId },
				'Failed to interrupt turn'
			);
		});
}

/**
 * Handle select_session message - select/switch to a session in desktop
 */
export function handleSelectSession(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const tabId = message.tabId as string | undefined;
	const focus = message.focus as boolean | undefined;
	logger.info(
		`[Web] Received select_session message: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
		LOG_CONTEXT
	);

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}

	if (!ctx.callbacks.selectSession) {
		logger.warn(`[Web] selectSessionCallback is not set!`, LOG_CONTEXT);
		ctx.sendError(client, 'Session selection not configured');
		return;
	}

	// Forward to desktop's session selection logic (include tabId if provided)
	logger.info(
		`[Web] Calling selectSessionCallback for session ${sessionId}${tabId ? `, tab ${tabId}` : ''}`,
		LOG_CONTEXT
	);
	ctx.callbacks
		.selectSession(sessionId, tabId, focus)
		.then((success) => {
			if (success) {
				// Subscribe client to this session's output so they receive session_output messages
				client.subscribedSessionId = sessionId;
				logger.debug(`Session ${sessionId} selected in desktop, client subscribed`, LOG_CONTEXT);
			} else {
				logger.warn(`Failed to select session ${sessionId} in desktop`, LOG_CONTEXT);
			}
			ctx.send(client, {
				type: 'select_session_result',
				success,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to select session: ${error.message}`);
		});
}

/**
 * The host-only lookup from a caller credential to the live chat turn it was stamped on
 * (`ProcessManager.callerSourceOf`, MCOMP-17-03AO). Null for anything that authenticates
 * nobody: unknown, malformed, killed, replaced or revoked.
 */
export type CallerSourceResolver = (
	credential: string
) => { agentId: string; tabId: string } | null;

/** The resolver the desktop composed for the ask handler, when it composed one. */
function callerSourceResolverOf(ctx: MessageHandlerContext): CallerSourceResolver | undefined {
	const { callerSourceOf } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		callerSourceOf?: CallerSourceResolver;
	};
	return typeof callerSourceOf === 'function' ? callerSourceOf : undefined;
}

/**
 * The host-only lookup from a caller credential to the live Auto Run attempt it was stamped on
 * (`ProcessManager.autoRunCallerSourceOf`, MCOMP-17-03BA). An attempt runs in no tab, so it
 * answers its agent and process. Null for anything that authenticates nobody.
 */
export type AutoRunCallerSourceResolver = (
	credential: string
) => { agentId: string; processId: string } | null;

/** The Auto Run resolver the desktop composed for the ask handler, when it composed one. */
function autoRunCallerSourceResolverOf(
	ctx: MessageHandlerContext
): AutoRunCallerSourceResolver | undefined {
	const { autoRunCallerSourceOf } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		autoRunCallerSourceOf?: AutoRunCallerSourceResolver;
	};
	return typeof autoRunCallerSourceOf === 'function' ? autoRunCallerSourceOf : undefined;
}

/**
 * The host-only lookup from a caller credential to the live group chat participant turn it was
 * stamped on (`ProcessManager.groupChatCallerSourceOf`, MCOMP-17-03BM). It answers the room, the
 * participant's display name and the process, never an agent: which live agent the name stands
 * for is this handler's to resolve. Null for anything that authenticates nobody.
 */
export type GroupChatCallerSourceResolver = (
	credential: string
) => { groupChatId: string; participantName: string; processId: string } | null;

/** The room participant resolver the desktop composed for the ask handler, when it composed one. */
function groupChatCallerSourceResolverOf(
	ctx: MessageHandlerContext
): GroupChatCallerSourceResolver | undefined {
	const { groupChatCallerSourceOf } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		groupChatCallerSourceOf?: GroupChatCallerSourceResolver;
	};
	return typeof groupChatCallerSourceOf === 'function' ? groupChatCallerSourceOf : undefined;
}

/** The source a forwarded caller credential authenticated (MCOMP-17-03AP, 03BB, 03BN). */
export type ForwardedCaller =
	| { ok: true; kind: 'chat'; agentId: string; tabId: string }
	| { ok: true; kind: 'auto-run'; agentId: string; tabId: string; processId: string }
	| {
			ok: true;
			kind: 'group-chat';
			agentId: string;
			tabId: string;
			processId: string;
			groupChatId: string;
	  }
	| { ok: false; error: string };

/**
 * How often a credentialed ask re-reads its caller's custody while the consult runs
 * (MCOMP-17-03AS). The credential is also re-read once more when the consult settles.
 */
export const CALLER_CUSTODY_RECHECK_MS = 1_000;

/**
 * The host-only hook that stops the consult a withdrawn ask's dispatch ticket started
 * (MCOMP-17-03AS). Optional: absent, the ask is still withdrawn here (the caller is told and the
 * answer withheld) while the consult itself runs to its own end.
 */
export type CallerConsultWithdrawer = (dispatchTicket: string) => void;

/** The withdraw hook the desktop composed for the ask handler, when it composed one. */
function callerConsultWithdrawerOf(
	ctx: MessageHandlerContext
): CallerConsultWithdrawer | undefined {
	const { withdrawCallerConsult } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		withdrawCallerConsult?: CallerConsultWithdrawer;
	};
	return typeof withdrawCallerConsult === 'function' ? withdrawCallerConsult : undefined;
}

/**
 * The host-only hook that binds the asking Auto Run attempt's admitted lineage to the dispatch
 * ticket its ask carries (MCOMP-17-03BG), so the consult that ticket starts is admitted as that
 * run's child. Called with the credential (never echoed) and the fresh ticket; true only when
 * the binding is held. Optional: absent, the consult is admitted as the transport that asked.
 */
export type AutoRunConsultLineageBinder = (credential: string, dispatchTicket: string) => boolean;

/** The lineage binder the desktop composed for the ask handler, when it composed one. */
function autoRunConsultLineageBinderOf(
	ctx: MessageHandlerContext
): AutoRunConsultLineageBinder | undefined {
	const { bindAutoRunConsultLineage } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		bindAutoRunConsultLineage?: AutoRunConsultLineageBinder;
	};
	return typeof bindAutoRunConsultLineage === 'function' ? bindAutoRunConsultLineage : undefined;
}

/**
 * The host-only hook that binds the asking room participant turn's admitted lineage (the room
 * child it was verified on) to the dispatch ticket its ask carries (MCOMP-17-03BR), so the
 * consult that ticket starts is admitted as that room turn's child. Called with the credential
 * (never echoed) and the fresh ticket; true only when the binding is held. Optional: absent, the
 * consult is admitted as the transport that asked.
 */
export type GroupChatConsultLineageBinder = (credential: string, dispatchTicket: string) => boolean;

/** The room lineage binder the desktop composed for the ask handler, when it composed one. */
function groupChatConsultLineageBinderOf(
	ctx: MessageHandlerContext
): GroupChatConsultLineageBinder | undefined {
	const { bindGroupChatConsultLineage } = ctx.callbacks as MessageHandlerContext['callbacks'] & {
		bindGroupChatConsultLineage?: GroupChatConsultLineageBinder;
	};
	return typeof bindGroupChatConsultLineage === 'function'
		? bindGroupChatConsultLineage
		: undefined;
}

/**
 * Authenticate a forwarded caller credential (MCOMP-17-03AP): the exact source it names, or the
 * refusal that leaves nothing asked. A chat turn's credential is tried first; the stated ids must
 * both be present and be exactly that agent and tab, so a credential never lends one turn's
 * standing to another agent or tab. Otherwise an Auto Run attempt's credential (MCOMP-17-03BB):
 * the stated agent must be exactly the attempt's agent and pins its process. An attempt runs in
 * no tab, so (as the shared host's `askAsCaller` does) the stated tab is required only as where
 * the consult is shown, never as custody. Otherwise a room participant turn's credential
 * (MCOMP-17-03BN): its participant name must name exactly one live agent by the rule the room
 * router picks the agent it runs as (`findSessionForParticipantName`), the stated agent must be
 * exactly that agent, and the stated tab is display only, as for an attempt. A name that matches
 * no live agent, or is ambiguous, authenticates nobody. The kinds never resolve as each other.
 */
export function resolveForwardedCaller(
	ctx: MessageHandlerContext,
	credential: unknown,
	stated: { fromSessionId?: string; fromTabId?: string }
): ForwardedCaller {
	if (typeof credential !== 'string') {
		return { ok: false, error: 'callerCredential must be a string; nothing was asked.' };
	}
	const resolveChat = callerSourceResolverOf(ctx);
	const resolveAutoRun = autoRunCallerSourceResolverOf(ctx);
	const resolveRoom = groupChatCallerSourceResolverOf(ctx);
	if (!resolveChat && !resolveAutoRun && !resolveRoom) {
		return {
			ok: false,
			error: 'This host cannot authenticate a caller credential; nothing was asked.',
		};
	}
	const chat = credential && resolveChat ? resolveChat(credential) : null;
	if (chat) {
		if (stated.fromSessionId !== chat.agentId || stated.fromTabId !== chat.tabId) {
			return {
				ok: false,
				error:
					'The stated caller is not the chat turn the caller credential names; nothing was asked.',
			};
		}
		return { ok: true, kind: 'chat', agentId: chat.agentId, tabId: chat.tabId };
	}
	const run = credential && resolveAutoRun ? resolveAutoRun(credential) : null;
	if (run) {
		if (stated.fromSessionId !== run.agentId || !stated.fromTabId) {
			return {
				ok: false,
				error:
					'The stated caller is not the Auto Run attempt the caller credential names; nothing was asked.',
			};
		}
		return {
			ok: true,
			kind: 'auto-run',
			agentId: run.agentId,
			tabId: stated.fromTabId,
			processId: run.processId,
		};
	}
	const room = credential && resolveRoom ? resolveRoom(credential) : null;
	if (room) {
		const agent = findSessionForParticipantName(
			room.participantName,
			ctx.callbacks.getSessions?.() ?? []
		);
		if (!agent || stated.fromSessionId !== agent.id || !stated.fromTabId) {
			return {
				ok: false,
				error:
					'The stated caller is not the group chat participant the caller credential names; nothing was asked.',
			};
		}
		return {
			ok: true,
			kind: 'group-chat',
			agentId: agent.id,
			tabId: stated.fromTabId,
			processId: room.processId,
			groupChatId: room.groupChatId,
		};
	}
	return {
		ok: false,
		error:
			'The caller credential authenticates no live chat turn or Auto Run attempt, and no group chat participant; nothing was asked.',
	};
}

/**
 * Handle cross_agent_ask - consult another agent and return its answer
 * (`maestro-cli ask`).
 *
 * Deliberately NOT a variant of `send_command`. A dispatch writes into the
 * target's active tab, which is whatever conversation the human has open there;
 * a consult opens a hidden tab of its own and answers the caller. The busy
 * guard `send_command` applies is also absent on purpose: a consult spawns its
 * own ephemeral process, so a target mid-turn can answer without either turn
 * disturbing the other.
 */
export function handleCrossAgentAsk(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const targetSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
	const question = typeof message.question === 'string' ? message.question : '';
	const statedFromSessionId =
		typeof message.fromSessionId === 'string' ? message.fromSessionId : undefined;
	// The asking agent's own tab, stamped into its shell at spawn. Lets the
	// renderer put the consult pill in the conversation that asked.
	const statedFromTabId = typeof message.fromTabId === 'string' ? message.fromTabId : undefined;
	const withContext = message.withContext === true;
	const timeoutMs =
		typeof message.timeoutMs === 'number' && Number.isFinite(message.timeoutMs)
			? Math.min(Math.max(message.timeoutMs, MIN_CONSULT_TIMEOUT_MS), MAX_CONSULT_TIMEOUT_MS)
			: DEFAULT_CONSULT_TIMEOUT_MS;

	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'cross_agent_ask_result',
			sessionId: targetSessionId,
			requestId: message.requestId,
			...payload,
		});
	};

	if (!targetSessionId || !question.trim()) {
		reply({ success: false, error: 'Missing target agent or question' });
		return;
	}
	// A forwarded caller credential (MCOMP-17-03AL) is a managed chat turn's (or, MCOMP-17-03BB,
	// a managed Auto Run attempt's) proof of which turn is asking; the stated from ids are only claims. It is resolved by the host that
	// minted it (`callerSourceOf`, MCOMP-17-03AO/AP), never dropped: dropping it would fall
	// back to the claimed ids. Absent a resolver, an unknown, stale or withdrawn credential, or
	// stated ids that are not exactly the source it names, the ask refuses before any ticket is
	// issued or the target is touched, with the shared host's wording. Never echoed or logged.
	let fromSessionId = statedFromSessionId;
	let fromTabId = statedFromTabId;
	let custodyCredential: string | undefined;
	let custodyProcessId: string | undefined;
	let custodyKind: 'chat' | 'auto-run' | 'group-chat' | undefined;
	if ('callerCredential' in message) {
		const caller = resolveForwardedCaller(ctx, message.callerCredential, {
			fromSessionId: statedFromSessionId,
			fromTabId: statedFromTabId,
		});
		if (!caller.ok) {
			reply({ success: false, error: caller.error });
			return;
		}
		fromSessionId = caller.agentId;
		fromTabId = caller.tabId;
		custodyCredential = message.callerCredential as string;
		custodyKind = caller.kind;
		if (caller.kind !== 'chat') custodyProcessId = caller.processId;
	}
	if (!ctx.callbacks.getSessionDetail?.(targetSessionId)) {
		reply({ success: false, error: 'Agent not found' });
		return;
	}
	if (!ctx.callbacks.consultAgent) {
		reply({ success: false, error: 'Cross-agent consults are not configured' });
		return;
	}

	const admission = resolveTransportAdmission(client);
	// Metadata only at info level: a consult question can carry proprietary code
	// or secrets, exactly like a dispatched prompt.
	logger.info(
		`[Web Ask] Consult | Target: ${targetSessionId} | From: ${fromSessionId ?? 'unattributed'} | Transport: ${describeTransportAdmission(admission)} | Context: ${withContext ? 'yes' : 'no'} | Timeout: ${timeoutMs}ms | QuestionLength: ${question.length}`,
		LOG_CONTEXT
	);

	// The consult spawns in the main process, but only after a round trip
	// through the renderer (`remote:crossAgentAsk` -> `crossAgent.send`), and no
	// transport context survives that hop: the sink would read the consult as the
	// desktop's own. The ticket is issued here, inside this client's context, for
	// the target agent alone (the consult tab is the renderer's to find or
	// create), and the `cross-agent:send` handler claims it so the consult is
	// admitted for the CLI or device that asked (MRC-08-01C).
	const dispatchTicket = issueDispatchTicket(admission, { agentId: targetSessionId });

	// An Auto Run attempt's ask (MCOMP-17-03BG): the attempt's admitted lineage is bound to the
	// ticket before the consult is dispatched, so the consult is the run's child on its fenced
	// workflow. A composed binder that cannot hold the binding refuses the ask: the ticket is
	// withdrawn and the target is never consulted under a lineage it was not given.
	if (custodyCredential !== undefined && custodyKind === 'auto-run') {
		const bindLineage = autoRunConsultLineageBinderOf(ctx);
		if (bindLineage && bindLineage(custodyCredential, dispatchTicket) !== true) {
			withdrawDispatchTicket(dispatchTicket);
			reply({
				success: false,
				error:
					'The asking Auto Run attempt has no lineage this host can bind to the consult; nothing was asked.',
			});
			return;
		}
	}
	// A room participant turn's ask (MCOMP-17-03BR): the same gate over the room child the turn
	// was admitted on, through its own binder, so a room turn is never bound as an attempt and an
	// attempt never as a room turn.
	if (custodyCredential !== undefined && custodyKind === 'group-chat') {
		const bindLineage = groupChatConsultLineageBinderOf(ctx);
		if (bindLineage && bindLineage(custodyCredential, dispatchTicket) !== true) {
			withdrawDispatchTicket(dispatchTicket);
			reply({
				success: false,
				error:
					'The asking group chat participant turn has no lineage this host can bind to the consult; nothing was asked.',
			});
			return;
		}
	}

	// Source custody (MCOMP-17-03AS): a credentialed ask stands only while the chat turn that
	// asked still holds its admission. The credential is re-read on an interval while the consult
	// runs and once more when it settles; once it names nobody (the turn was stopped, killed,
	// replaced, finished or revoked) the ask is withdrawn: the caller is told, the answer is
	// withheld, and the host's withdraw hook (when composed) stops the consult. Only the first
	// outcome is ever replied.
	let settled = false;
	let custodyWatch: ReturnType<typeof setInterval> | undefined;
	const settle = (payload: Record<string, unknown>): boolean => {
		if (settled) return false;
		settled = true;
		if (custodyWatch) clearInterval(custodyWatch);
		reply(payload);
		return true;
	};
	// Custody holds only while the credential still names the same kind of source: the same chat
	// turn, the same Auto Run attempt process (MCOMP-17-03BB), or the same room participant process
	// whose name still resolves to the same live agent (MCOMP-17-03BN). A room that is stopped or
	// removed kills its participant turns, so the room's lifetime bounds the ask.
	const custodyHeld = (): boolean => {
		if (custodyCredential === undefined) return true;
		const held = resolveForwardedCaller(ctx, custodyCredential, { fromSessionId, fromTabId });
		if (!held.ok || held.kind !== custodyKind) return false;
		return held.kind === 'chat' || held.processId === custodyProcessId;
	};
	const withdrawForCustody = (): void => {
		const replied = settle({
			success: false,
			error:
				'The asking chat turn no longer holds its admission (stopped, ended or revoked); the ask was withdrawn and no answer is returned.',
		});
		if (!replied) return;
		logger.info(
			`[Web Ask] Withdrawn: the asking turn lost custody | Target: ${targetSessionId} | From: ${fromSessionId ?? 'unattributed'}`,
			LOG_CONTEXT
		);
		callerConsultWithdrawerOf(ctx)?.(dispatchTicket);
	};
	if (custodyCredential !== undefined) {
		custodyWatch = setInterval(() => {
			if (!custodyHeld()) withdrawForCustody();
		}, CALLER_CUSTODY_RECHECK_MS);
		custodyWatch.unref?.();
	}

	ctx.callbacks
		.consultAgent({
			targetSessionId,
			question,
			fromSessionId,
			...(fromTabId ? { fromTabId } : {}),
			withContext,
			timeoutMs,
			dispatchTicket,
		})
		.then((result) => {
			// A consult that never reached the sink (no window, the renderer refused
			// it) leaves its ticket unclaimed; one that ran has already spent it.
			if (!result.success) withdrawDispatchTicket(dispatchTicket);
			if (settled) return;
			if (!custodyHeld()) {
				withdrawForCustody();
				return;
			}
			settle({ ...result });
		})
		.catch((error) => {
			withdrawDispatchTicket(dispatchTicket);
			if (custodyWatch) clearInterval(custodyWatch);
			if (settled) return;
			settled = true;
			ctx.reportHandlerError(
				client,
				error,
				'cross_agent_ask',
				{ sessionId: targetSessionId, requestId: message.requestId },
				'Failed to consult agent'
			);
		});
}
