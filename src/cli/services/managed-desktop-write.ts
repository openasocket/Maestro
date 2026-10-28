// A CLI write of a value the managed settings authority holds (MRC2-06-03A/B):
// the running desktop first, which holds it; the file only when no desktop runs
// AND the data dir carries no managed binding. An enrolled data dir with no
// desktop is the one not-running outcome (exit 3), never a write around the
// policy. Standalone with no desktop: the file, as before.

import { withMaestroClient, type MaestroClient } from './maestro-client';
import { MaestroNotRunningError } from './maestro-not-running';
import { errorFrameMessage, exitIfMaestroNotRunning } from './session-command';
import { dataDirHasManagedBinding } from './storage';
import { formatError, formatWarning } from '../output/formatter';

export const ENROLLED_DESKTOP_ONLY = 'Enrolled with a management peer: desktop only.';

/**
 * Run `send` against the running desktop. Null when no desktop runs and the
 * data dir carries no managed binding: the caller then writes the file as
 * before. Any other failure, including an enrolled data dir with no desktop,
 * is thrown for {@link reportDesktopWriteFailure}.
 */
export async function writeThroughDesktop<T>(
	send: (client: MaestroClient) => Promise<T>,
	json?: boolean
): Promise<T | null> {
	try {
		return await withMaestroClient(send);
	} catch (error) {
		if (!(error instanceof MaestroNotRunningError)) throw error;
		if (!dataDirHasManagedBinding()) return null;
		if (!json) console.error(formatWarning(ENROLLED_DESKTOP_ONLY));
		throw error;
	}
}

/** The typed result, or an error frame carrying the hold's refusal. */
type SetSettingReply = { type?: string; success?: boolean; message?: string; managed?: unknown };

/**
 * Write one top-level setting through the desktop's `set_setting`, which the
 * managed settings authority holds (MRC2-06-02). True when the desktop wrote
 * it; false when no desktop runs and the file may be written; a refusal is
 * thrown as the policy's line with its `managed` state.
 */
export async function setSettingThroughDesktop(
	key: string,
	value: unknown,
	json?: boolean
): Promise<boolean> {
	const reply = await writeThroughDesktop(
		(client) =>
			client.sendCommand<SetSettingReply>(
				{ type: 'set_setting', key, value },
				'set_setting_result'
			),
		json
	);
	if (reply === null) return false;
	const refusal = errorFrameMessage(reply);
	if (refusal) throw Object.assign(new Error(refusal), { managed: reply.managed });
	if (!reply.success) throw new Error('The desktop could not persist the setting');
	return true;
}

/** Report a failed write: the not-running outcome first, then the message (its managed state in JSON). Never returns. */
export function reportDesktopWriteFailure(
	error: unknown,
	json: boolean | undefined,
	what: string
): never {
	exitIfMaestroNotRunning(error, { json });
	const message = error instanceof Error ? error.message : 'Unknown error';
	const managed = (error as { managed?: unknown }).managed;
	if (json) console.error(JSON.stringify({ error: message, ...(managed ? { managed } : {}) }));
	else console.error(formatError(`Failed to ${what}: ${message}`));
	return process.exit(1);
}
