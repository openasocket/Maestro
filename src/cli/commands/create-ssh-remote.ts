// Create SSH remote command - add a new SSH remote configuration

import * as crypto from 'crypto';
import { readSshRemotes } from '../services/storage';
import {
	reportDesktopWriteFailure,
	writeSettingThroughHost,
} from '../services/managed-desktop-write';
import { formatError, formatSuccess } from '../output/formatter';
import type { SshRemoteConfig } from '../../shared/types';
import { parseSshOptionAssignments } from '../../shared/sshOptions';

interface CreateSshRemoteOptions {
	host: string;
	port?: string;
	username?: string;
	key?: string;
	env?: string[];
	sshOption?: string[];
	sshConfig?: boolean;
	disabled?: boolean;
	setDefault?: boolean;
	json?: boolean;
}

export async function createSshRemote(
	name: string,
	options: CreateSshRemoteOptions
): Promise<void> {
	// Validate host
	if (!options.host) {
		const msg = 'Missing required --host';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	// Parse port
	let port = 22;
	if (options.port !== undefined) {
		port = parseInt(options.port, 10);
		if (isNaN(port) || port < 1 || port > 65535) {
			const msg = '--port must be a number between 1 and 65535';
			if (options.json) {
				console.log(JSON.stringify({ success: false, error: msg }));
			} else {
				console.error(formatError(msg));
			}
			process.exit(1);
		}
	}

	// Parse environment variables
	let remoteEnv: Record<string, string> | undefined;
	if (options.env && options.env.length > 0) {
		remoteEnv = {};
		for (const entry of options.env) {
			const eqIndex = entry.indexOf('=');
			if (eqIndex === -1) {
				const msg = `Invalid --env format "${entry}". Expected KEY=VALUE`;
				if (options.json) {
					console.log(JSON.stringify({ success: false, error: msg }));
				} else {
					console.error(formatError(msg));
				}
				process.exit(1);
			}
			remoteEnv[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
		}
	}

	// Parse extra `ssh -o` options (ProxyCommand for a tunnelled host, a longer
	// ConnectTimeout, a ProxyJump bastion, ...)
	const parsedSshOptions = parseSshOptionAssignments(options.sshOption);
	if (parsedSshOptions.error) {
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: parsedSshOptions.error }));
		} else {
			console.error(formatError(parsedSshOptions.error));
		}
		process.exit(1);
	}

	const config: SshRemoteConfig = {
		id: crypto.randomUUID(),
		name,
		host: options.host,
		port,
		username: options.username || '',
		privateKeyPath: options.key || '',
		remoteEnv,
		sshOptions: parsedSshOptions.options,
		enabled: !options.disabled,
		useSshConfig: options.sshConfig || undefined,
		sshConfigHost: options.sshConfig ? options.host : undefined,
	};

	// Validate: name and host must be non-empty
	if (!config.name.trim()) {
		const msg = 'Name cannot be empty';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	if (!config.host.trim()) {
		const msg = 'Host cannot be empty';
		if (options.json) {
			console.log(JSON.stringify({ success: false, error: msg }));
		} else {
			console.error(formatError(msg));
		}
		process.exit(1);
	}

	// Read, append, write. Both keys are ones a managed policy can hold, so the
	// write goes through the running desktop (the same hold the Settings pane
	// meets); the file only when the data dir is standalone with no desktop.
	try {
		const remotes = readSshRemotes();
		remotes.push(config);
		await writeSettingThroughHost('sshRemotes', remotes, options.json);
		if (options.setDefault) {
			await writeSettingThroughHost('defaultSshRemoteId', config.id, options.json);
		}
	} catch (error) {
		return reportDesktopWriteFailure(error, options.json, `create SSH remote "${name}"`);
	}

	if (options.json) {
		console.log(
			JSON.stringify({ success: true, id: config.id, name: config.name, host: config.host })
		);
	} else {
		console.log(formatSuccess(`Created SSH remote "${config.name}"`));
		console.log(`  ID:   ${config.id}`);
		console.log(
			`  Host: ${config.username ? `${config.username}@` : ''}${config.host}${config.port !== 22 ? `:${config.port}` : ''}`
		);
		if (config.useSshConfig) {
			console.log(`  Mode: ssh-config`);
		}
		for (const [key, value] of Object.entries(config.sshOptions ?? {})) {
			console.log(`  -o    ${key}=${value}`);
		}
		if (options.setDefault) {
			console.log(`  Set as default`);
		}
	}
}
