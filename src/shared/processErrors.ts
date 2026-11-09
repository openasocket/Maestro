/**
 * Error shapes the process layer throws that callers need to recognise by
 * message rather than by type. Kept in `shared/` so the thrower and the
 * matcher cannot drift: an IPC rejection arrives in the renderer as a plain
 * `Error` whose message has been re-wrapped by Electron, so the text really is
 * the only thing left to match on.
 */

/**
 * Prefix of the refusal `ProcessManager.spawn` throws when a session already
 * owns a live agent process. Build the message with
 * `agentAlreadyRunningMessage()` and test for it with
 * `isAgentAlreadyRunningError()` - never re-type the literal.
 */
export const AGENT_ALREADY_RUNNING_PREFIX = 'Agent process already running for session';

/** The exact message `ProcessManager.spawn` throws for an owned session. */
export function agentAlreadyRunningMessage(sessionId: string): string {
	return `${AGENT_ALREADY_RUNNING_PREFIX} ${sessionId}`;
}

/**
 * True when a failure is that refusal, including when it arrives wrapped by
 * Electron's IPC bridge as
 * `Error invoking remote method 'process:spawn': Error: Agent process ...`.
 */
export function isAgentAlreadyRunningError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? '');
	return message.includes(AGENT_ALREADY_RUNNING_PREFIX);
}

/** A spawn a managed host refused at the sink (`SpawnResult.managed` plus its message). */
export interface ManagedSpawnRefusal {
	state: 'denied' | 'unavailable' | 'unknown';
	code: string;
	message: string;
}

/** Prefix of the refusal `process:spawn` rejects with when a managed host refused the spawn. */
export const MANAGED_SPAWN_REFUSAL_PREFIX = 'Managed host refused this turn';

const MANAGED_SPAWN_REFUSAL_PATTERN = new RegExp(
	`${MANAGED_SPAWN_REFUSAL_PREFIX} \\((denied|unavailable|unknown)/([A-Za-z0-9_.:-]+)\\): ([\\s\\S]*)$`
);

/**
 * The message `process:spawn` rejects with for a managed sink refusal. The
 * state and code ride in the text because an IPC rejection keeps nothing else;
 * read them back with `parseManagedSpawnRefusal()`, never by re-typing this.
 */
export function managedSpawnRefusalMessage(refusal: ManagedSpawnRefusal): string {
	return `${MANAGED_SPAWN_REFUSAL_PREFIX} (${refusal.state}/${refusal.code}): ${refusal.message}`;
}

/**
 * The managed refusal a failed spawn carried, including through Electron's
 * `Error invoking remote method 'process:spawn': Error: ...` wrapping; null for
 * any other failure.
 */
export function parseManagedSpawnRefusal(error: unknown): ManagedSpawnRefusal | null {
	const text = error instanceof Error ? error.message : String(error ?? '');
	const match = MANAGED_SPAWN_REFUSAL_PATTERN.exec(text);
	if (!match) return null;
	return {
		state: match[1] as ManagedSpawnRefusal['state'],
		code: match[2],
		message: match[3],
	};
}
