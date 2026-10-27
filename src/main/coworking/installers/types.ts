/**
 * Per-agent installer contract for the coworking MCP server.
 *
 * Each strategy:
 *   - knows where its agent reads MCP config from (user-level path)
 *   - can answer "is the maestro-coworking entry currently installed?"
 *   - can install / uninstall the entry idempotently, preserving any
 *     unrelated user content (other MCP servers, comments, formatting).
 */

import type { CoworkingMcpServerSpec } from '../coworking-types';
import type { McpInstallOptions } from './managed';

export interface AgentMcpInstaller {
	readonly agentId: string;
	/** Absolute path of the user-level config file this strategy operates on. */
	configPath(): string;
	/** True iff a `maestro-coworking` entry is present in the config file. */
	isInstalled(): Promise<boolean>;
	/**
	 * Add the entry, replacing any existing `maestro-coworking` block. Held to
	 * the install ceiling before the file is read (MRC2-04-08A); a refusal
	 * throws `InstallRefusedError` and touches nothing.
	 */
	install(spec: CoworkingMcpServerSpec, options?: McpInstallOptions): Promise<void>;
	/** Remove the entry. No-op if not installed. */
	uninstall(): Promise<void>;
}
