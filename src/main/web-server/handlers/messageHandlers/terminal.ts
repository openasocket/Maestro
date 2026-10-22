/**
 * Terminal domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: terminal_write, terminal_resize.
 *
 * Both are input into the web terminal's PTY, which the main process spawned
 * for this client's session (`spawnTerminalForWeb`). Two checks happen before
 * the sink is reached and neither is effect authority: the message handler
 * reauthorized the socket before dispatching (a revoked pairing or an expired
 * login lands nothing), and the subscription check below correlates the write
 * with the session the client is viewing. Who may drive the PTY is decided at
 * the sink (`terminalCallbacks.ts`): on a managed host the PTY is bound to the
 * actor it was admitted for, and input from any other caller is refused with
 * the reason, which these handlers relay (MRC-08-02).
 */

import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import type { WebTerminalInputResult } from './types';

/** The sink's answer, shaped for the client: a bare boolean or a named refusal. */
function inputResultFields(outcome: WebTerminalInputResult): {
	success: boolean;
	error?: string;
	managed?: { state: 'denied'; code: string };
} {
	if (typeof outcome === 'boolean') return { success: outcome };
	return {
		success: false,
		error: outcome.error,
		...(outcome.managed ? { managed: outcome.managed } : {}),
	};
}

/**
 * Handle terminal_write - write raw data to the terminal PTY
 */
export function handleTerminalWrite(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId;
	const data = message.data as string | undefined;
	if (!sessionId || typeof data !== 'string') {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'Missing sessionId or data',
		});
		return;
	}
	if (client.subscribedSessionId !== sessionId) {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'Not subscribed to this session',
		});
		return;
	}
	if (!ctx.callbacks.writeToTerminal) {
		ctx.send(client, {
			type: 'terminal_write_result',
			success: false,
			error: 'writeToTerminal not available',
		});
		return;
	}
	const outcome = ctx.callbacks.writeToTerminal(sessionId, data);
	ctx.send(client, { type: 'terminal_write_result', ...inputResultFields(outcome), sessionId });
}

/**
 * Handle terminal_resize - resize the terminal PTY
 */
export function handleTerminalResize(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId;
	const cols = message.cols as number | undefined;
	const rows = message.rows as number | undefined;
	if (!sessionId || typeof cols !== 'number' || typeof rows !== 'number') {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'Missing sessionId, cols, or rows',
		});
		return;
	}
	if (client.subscribedSessionId !== sessionId) {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'Not subscribed to this session',
		});
		return;
	}
	if (!ctx.callbacks.resizeTerminal) {
		ctx.send(client, {
			type: 'terminal_resize_result',
			success: false,
			error: 'resizeTerminal not available',
		});
		return;
	}
	const outcome = ctx.callbacks.resizeTerminal(sessionId, cols, rows);
	ctx.send(client, { type: 'terminal_resize_result', ...inputResultFields(outcome), sessionId });
}
