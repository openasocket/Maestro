/**
 * Which account dir one agent's processes run under: where its provider reads
 * and writes that agent's transcripts (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...).
 *
 * A session browser must read the agent's OWN account. The provider resumes a
 * session only from the config dir it was started with, so listing another
 * account's pool offers sessions the agent cannot open.
 *
 * Pure and store-free, so the main process and the CLI resolve it the same way;
 * each caller reads its own stores and passes the layers in. Uses Node's `path`,
 * so it is for main and CLI only, never the renderer.
 */

import path from 'path';
import { isBlankEnvValue } from './agentEnvironment';
import { managedAccountRef } from './maestro-lib/managed/credentials';
import { expandTilde } from './pathUtils';
import { effectiveAgentCustomEnvVars, getProviderProfileConfig } from './providerProfiles';

export interface AgentAccountDirInput {
	toolType: string;
	/** The agent's own env vars. */
	customEnvVars?: Record<string, string>;
	/** Whether the agent runs on an SSH remote. */
	sshRemote?: boolean;
	/**
	 * The account home the managed policy binds this agent to (the route
	 * ceiling's `accountDir`). Wins over every user and host layer, since the
	 * ceiling removes those from the process anyway; a remote agent gets it as
	 * a remote path, unexpanded. `null` or absent: not managed, or the policy
	 * leaves the provider's default, and the layers below decide as before.
	 */
	managedAccountDir?: string | null;
}

export interface AgentAccountDirLayers {
	/** Provider-level env vars (Settings -> Agents). */
	agentLevelEnvVars?: Record<string, string>;
	/** Settings -> Environment. */
	globalShellEnvVars?: Record<string, string>;
	/** The env the host process was launched with. */
	env?: Record<string, string | undefined>;
	homeDir: string;
}

/**
 * Same precedence as `buildChildProcessEnv`: the agent's own env vars (or the
 * provider-level set it inherits, which REPLACES rather than layers), then
 * Settings -> Environment, then the host env, then the provider default.
 * A blank at the winning layer unsets the variable, selecting the provider
 * default rather than falling through to another account in a lower layer.
 *
 * An SSH agent carries only its custom vars to the remote host, so only that
 * layer counts; the value is a remote path and is returned as is (no `~`
 * expansion on this machine), and `undefined` with none set so the caller
 * keeps its remote default. `undefined` too for a provider with no account dir.
 */
export function resolveAgentAccountDir(
	agent: AgentAccountDirInput,
	layers: AgentAccountDirLayers
): string | undefined {
	const config = getProviderProfileConfig(agent.toolType);
	if (!config) return undefined;

	const usable = (value: unknown): value is string =>
		typeof value === 'string' && !isBlankEnvValue(value);
	if (usable(agent.managedAccountDir)) {
		const bound = agent.managedAccountDir.trim();
		return agent.sshRemote ? bound : path.resolve(expandTilde(bound, layers.homeDir));
	}
	const custom = effectiveAgentCustomEnvVars(agent.customEnvVars, layers.agentLevelEnvVars)[
		config.envVar
	];

	if (agent.sshRemote) return usable(custom) ? custom.trim() : undefined;

	// Select before checking for blanks, matching the launch environment's
	// merge-then-unset rule. A blank override must not revive another account.
	const chosen =
		custom ?? layers.globalShellEnvVars?.[config.envVar] ?? layers.env?.[config.envVar];
	if (!usable(chosen)) return path.join(layers.homeDir, config.defaultSubdir);
	return path.resolve(expandTilde(chosen.trim(), layers.homeDir));
}

/**
 * The opaque reference of the account an agent's processes run as: what a
 * dispatch snapshot carries as `account` and what an account-bound credential
 * reference must name. Derived from the REAL resolved directory, never from a
 * label, an e-mail or a directory name on its own; `null` for a provider with
 * no account concept. Same digest as `managedAccountRef()`, so the host and
 * the policy issuer agree.
 */
export function resolveAgentAccountRef(
	agent: AgentAccountDirInput,
	layers: AgentAccountDirLayers
): string | null {
	const dir = resolveAgentAccountDir(agent, layers);
	return dir === undefined ? null : managedAccountRef(agent.toolType, dir);
}
