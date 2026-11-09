// Remove SSH remote command - delete an SSH remote configuration

import { readSshRemotes, resolveSshRemoteId, readSettingValue } from '../services/storage';
import {
	reportDesktopWriteFailure,
	writeSettingThroughHost,
} from '../services/managed-desktop-write';
import { formatError, formatSuccess } from '../output/formatter';

interface RemoveSshRemoteOptions {
	json?: boolean;
}

export async function removeSshRemote(
	remoteId: string,
	options: RemoveSshRemoteOptions
): Promise<void> {
	// Resolve partial ID
	let resolvedId: string;
	try {
		resolvedId = resolveSshRemoteId(remoteId);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		return process.exit(1);
	}

	const remotes = readSshRemotes();
	const index = remotes.findIndex((r) => r.id === resolvedId);

	if (index === -1) {
		const msg = `SSH remote not found: ${resolvedId}`;
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	const removedName = remotes[index].name;
	remotes.splice(index, 1);
	// Through the host boundary like create and update: a held list write is
	// refused before the file, and a refused list write never clears the default.
	try {
		await writeSettingThroughHost('sshRemotes', remotes, options.json);
		// Clear default if it was the deleted remote
		const defaultId = readSettingValue('defaultSshRemoteId') as string | null;
		if (defaultId === resolvedId) {
			await writeSettingThroughHost('defaultSshRemoteId', null, options.json);
		}
	} catch (error) {
		return reportDesktopWriteFailure(error, options.json, `remove SSH remote "${removedName}"`);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, id: resolvedId, name: removedName }));
	} else {
		console.log(formatSuccess(`Removed SSH remote "${removedName}" (${resolvedId})`));
	}
}
