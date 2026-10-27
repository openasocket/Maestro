/**
 * The coworking MCP writers under the install ceiling (MRC2-04-08A). Each
 * installer writes a `maestro-coworking` entry into an agent's user-level
 * configuration, naming the bundled server script the agent launches on every
 * turn. Standalone nothing here is consulted. Under management the entry is held
 * BEFORE the configuration is read: the script is pinned by the digest of its
 * bytes (artifact `coworking-mcp-server`) and the ceiling must grant the server
 * to that agent on an enforced route; a refusal throws and touches no file. Not
 * held: the runtime (`command`) the entry names, and an uninstall.
 */

import * as path from 'path';
import { digestFileSha256 } from '../../../shared/maestro-lib/managed/tui-handshake';
import {
	INSTALL_OPERATOR,
	InstallRefusedError,
	type InstallActor,
	type InstallAuthority,
	type McpServerAuthority,
} from '../../enterprise/install-policy';
import { COWORKING_MCP_SERVER_NAME } from '../coworking-types';
import type { CoworkingMcpServerSpec } from '../coworking-types';

/** How an install was asked for: the transport the IPC call was admitted over, else the operator. */
export interface McpInstallOptions {
	actor?: InstallActor;
}

export type McpInstallAuthority = InstallAuthority & McpServerAuthority;

let authority: McpInstallAuthority | null = null;

/** The desktop hands the one install ceiling source over at startup; null holds nothing (standalone). */
export function setMcpInstallAuthority(next: McpInstallAuthority | null): void {
	authority = next;
}

/** The server script the entry points at: the script argument, else the command itself. */
export function mcpServerScriptPath(spec: CoworkingMcpServerSpec): string {
	return spec.args[0] ?? spec.command;
}

/**
 * Hold one agent's MCP entry before its configuration is touched. Throws
 * `InstallRefusedError` when the script is not the pinned one or the ceiling
 * grants the server to the agent on no enforced route.
 */
export function holdMcpServerWrite(
	agentId: string,
	spec: CoworkingMcpServerSpec,
	options: McpInstallOptions = {}
): void {
	if (!authority) return;
	const actor = options.actor ?? INSTALL_OPERATOR;
	const script = mcpServerScriptPath(spec);
	const install = authority.authorize({
		artifact: 'coworking-mcp-server',
		file: path.basename(script),
		stage: 'execute',
		digest: () => digestFileSha256(script),
		actor,
	});
	if (!install.allowed) throw new InstallRefusedError(install);
	const entry = authority.authorizeMcpServer({
		agentId,
		server: COWORKING_MCP_SERVER_NAME,
		actor,
	});
	if (!entry.allowed) throw new InstallRefusedError(entry);
}
