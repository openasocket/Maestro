/**
 * The process id of a desktop terminal tab: `{sessionId}-terminal-{tabId}`.
 *
 * The renderer composes it when a tab spawns its PTY (`getTerminalSessionId`)
 * and the main process takes it apart at the spawn and write sinks
 * (`parseTerminalSessionId`) to learn which agent and tab a dispatch ticket
 * was issued for (MRC-08-02A). It is distinct from an AI process,
 * `{sessionId}-ai-{tabId}`, and from the web client's own PTY,
 * `{sessionId}-terminal`, which has no tab half and does not parse.
 */
const TERMINAL_TAB_SEPARATOR = '-terminal-';

export function getTerminalSessionId(sessionId: string, tabId: string): string {
	return `${sessionId}${TERMINAL_TAB_SEPARATOR}${tabId}`;
}

/**
 * Parse a composite terminal session ID back into its component parts.
 * Returns null if the string doesn't match the expected "-terminal-" format.
 */
export function parseTerminalSessionId(
	terminalSessionId: string
): { sessionId: string; tabId: string } | null {
	const separatorIndex = terminalSessionId.indexOf(TERMINAL_TAB_SEPARATOR);
	if (separatorIndex === -1) {
		return null;
	}
	const sessionId = terminalSessionId.substring(0, separatorIndex);
	const tabId = terminalSessionId.substring(separatorIndex + TERMINAL_TAB_SEPARATOR.length);
	if (!sessionId || !tabId) {
		return null;
	}
	return { sessionId, tabId };
}
