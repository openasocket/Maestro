import * as os from 'os';
import * as path from 'path';
import { buildExpandedPath, detectNodeVersionManagerBinPaths } from '../../pathUtils';
import { isWindows } from '../../platformDetection';
import { DEFAULT_QUERY_SOURCE, QUERY_SOURCE_ENV_VAR, type QuerySource } from '../../querySource';
import { buildSpawnPath, STANDARD_UNIX_PATHS } from './spawn-path';
import { isBlankEnvKey, isBlankEnvValue } from '../../agentEnvironment';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../agentDelegation';
import { PROVIDER_ENV_VAR_SUGGESTIONS } from '../../envVarCatalog';
import { MANAGED_DELEGATION_ENV_VAR } from '../managed/delegation';
import { getAgentDefinition } from '../providers/definitions';

const SERVER_MODE_ENV_VAR_NAME = 'MAESTRO_SERVER_MODE';
const SERVER_ENV_ALLOW_ENV_VAR_NAME = 'MAESTRO_SERVER_ENV_ALLOW';

/**
 * Build the base PATH for macOS/Linux with detected Node version manager paths.
 *
 * Automatically detects and prepends paths for common Node version managers (nvm, fnm, etc.)
 * to ensure Node tools are discoverable in PATH. This is critical for agents and tools that
 * depend on specific Node versions.
 *
 * @returns {string} The expanded PATH value with version manager paths first, then standard paths
 *
 * @example
 * // Returns something like:
 * // /Users/john/.nvm/versions/node/v20.11.0/bin:/usr/local/bin:/usr/bin:/bin
 */
export function buildUnixBasePath(): string {
	const versionManagerPaths = detectNodeVersionManagerBinPaths();

	if (versionManagerPaths.length > 0) {
		return versionManagerPaths.join(':') + ':' + STANDARD_UNIX_PATHS;
	}

	return STANDARD_UNIX_PATHS;
}

/**
 * Build environment for PTY terminal sessions.
 *
 * This function creates the environment for terminal sessions (PTY-based shells). It preserves
 * most of the parent process environment but ensures consistent terminal settings.
 *
 * Platform-specific behavior:
 * - **Windows**: Inherits full parent environment + TERM setting
 * - **Unix/Linux/macOS**: Inherits full parent environment with Electron/IDE variables stripped,
 *   TERM forced to xterm-256color, and an expanded PATH that includes Node version manager paths
 *
 * @param {Record<string, string>} [shellEnvVars] - Optional custom environment variables to merge.
 *        These override process defaults. Supports `~/` path expansion (e.g., `~/workspace`).
 *
 * @returns {NodeJS.ProcessEnv} The complete environment object for the PTY session
 *
 * @example
 * // Basic usage with no custom variables
 * const env = buildPtyTerminalEnv();
 * spawn('bash', { env });
 *
 * @example
 * // With global environment variables from Settings
 * const globalEnvVars = {
 *   'ANTHROPIC_API_KEY': 'sk-proj-xxxxx',
 *   'DEBUG': 'maestro:*',
 *   'WORKSPACE': '~/projects'
 * };
 * const env = buildPtyTerminalEnv(globalEnvVars);
 * // WORKSPACE will expand to /Users/john/projects (with path expansion)
 *
 * @note Path expansion (`~/` → home directory) is applied to all values
 * @note On Windows, the full environment is inherited without stripping. On Unix/Linux/macOS,
 *       Electron/IDE variables listed in STRIPPED_ENV_VARS are removed to avoid shell/plugin issues.
 */
export function buildPtyTerminalEnv(shellEnvVars?: Record<string, string>): NodeJS.ProcessEnv {
	let env: NodeJS.ProcessEnv;

	if (isWindows()) {
		env = {
			...process.env,
			TERM: 'xterm-256color',
		};
	} else {
		// Use the full expanded PATH so common user install locations
		// (~/.local/bin, ~/.claude/local, ~/.opencode/bin, Homebrew, npm-global, etc.)
		// are available even when the user's shell doesn't source an rc file that
		// augments PATH. bash falls through to .bashrc for login+interactive on
		// Debian, but zsh only sources .zprofile/.zshrc if they exist - users
		// without those would otherwise see `command not found` for tools like
		// `claude` and `codex` that live in ~/.local/bin.
		// Use buildSpawnPath() so the user's cached login-shell PATH is also
		// included - covers custom node/python installs outside the standard
		// version-manager paths we hardcode in buildExpandedPath().
		env = {
			...process.env,
			TERM: 'xterm-256color',
			LANG: process.env.LANG || 'en_US.UTF-8',
			PATH: buildSpawnPath(),
		};
		for (const key of STRIPPED_ENV_VARS) {
			delete env[key];
		}
	}

	// A Command Terminal is a shell the USER drives, not an agent turn, so it
	// must never carry the query-source marker. It can arrive two ways: Maestro
	// itself launched from an agent shell that had it set (the normal case in
	// development), or the Windows branch above, which inherits process.env
	// wholesale and strips nothing. Deleted unconditionally rather than added to
	// STRIPPED_ENV_VARS, because buildChildProcessEnv() sets this variable on
	// purpose and must keep doing so.
	delete env[QUERY_SOURCE_ENV_VAR];
	// Same for the caller identity: a dispatch typed into a terminal is the user's,
	// and attributing it to whichever agent launched Maestro would be a lie.
	delete env[CALLER_AGENT_ID_ENV_VAR];
	delete env[CALLER_TAB_ID_ENV_VAR];
	// And for a delegation record: a dispatch typed into a terminal is not the
	// child of whatever operation launched Maestro.
	delete env[MANAGED_DELEGATION_ENV_VAR];

	// Vim arrow-key ergonomics: when users launch `vi`/`vim` with distro defaults
	// that force compatible mode, insert-mode arrows can degrade to literal ABCD.
	// Provide a safe default for terminal sessions, but never override explicit user config.
	if (!env.VIMINIT) {
		env.VIMINIT = process.env.VIMINIT || 'set nocompatible | set esckeys';
	}

	// Apply custom shell environment variables
	if (shellEnvVars && Object.keys(shellEnvVars).length > 0) {
		const homeDir = os.homedir();
		for (const [key, value] of Object.entries(shellEnvVars)) {
			env[key] = value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
		}
	}

	return env;
}

/**
 * Environment variables to strip from child processes (agents).
 * These are set by Electron or IDE extensions and can interfere with agent
 * authentication or behavior when inherited by spawned CLI tools.
 *
 * Rationale:
 * - **ELECTRON_\***: Electron internals that may cause Electron-based CLIs to
 *   misidentify their execution context (e.g., Claude Code CLI thinking it's
 *   running inside Electron instead of standalone)
 * - **CLAUDECODE** and related: VSCode extension markers that can cause agents
 *   to use IDE-specific credentials or API endpoints instead of their configured ones
 * - **NODE_ENV**: Maestro's own NODE_ENV should not leak to agent processes,
 *   which may have different NODE_ENV requirements (e.g., agent needs NODE_ENV=production)
 *
 * @see buildChildProcessEnv() for where these are applied
 */
const STRIPPED_ENV_VARS = [
	// Electron internals - can cause Electron-based CLIs (e.g. Claude Code) to
	// misidentify their execution context
	'ELECTRON_RUN_AS_NODE',
	'ELECTRON_NO_ASAR',
	'ELECTRON_EXTRA_LAUNCH_ARGS',
	// VSCode / Claude Code extension markers - when inherited, agents may use
	// IDE-specific credentials or API paths instead of their own CLI auth
	'CLAUDECODE',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_AGENT_SDK_VERSION',
	'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
	// Claude session-identity markers. If Maestro itself was launched from
	// within a Claude session (e.g. `claude` spawned the app, or a dev shell
	// inherited them), these leak into spawned claude-code turns and the
	// maestro-p TUI it drives, making that child claude run as a NESTED session
	// that never writes its own JSONL transcript. maestro-p reads only the
	// JSONL, so the run times out with an empty result and no History entry is
	// recorded. Strip them here so no spawn surface forwards them; maestro-p
	// also strips them itself as a second line of defense.
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	// Caller identity inherited from whatever launched Maestro (an agent shell, in
	// development). The real identity is re-applied from the session layer, which
	// is merged after this list is stripped, so only a stale inherited copy dies.
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	// The delegation record of whatever operation launched Maestro, likewise: a
	// dispatched turn is stamped with its own child record from the session
	// layer, and a turn the user started is the child of nothing.
	MANAGED_DELEGATION_ENV_VAR,
	// Maestro's own NODE_ENV should not leak to agents
	'NODE_ENV',
];

/**
 * Build environment for child process (non-PTY) spawning - typically for AI agents.
 *
 * This is the core function for setting up environments for spawned AI agents (Claude Code,
 * Codex, Factory Droid, etc.) and other child processes. It implements a strict precedence
 * order and safety measures to prevent agent authentication failures.
 *
 * **Environment Precedence (highest to lowest)**:
 * 1. **Session-level custom env vars** (from spawn request, highest priority)
 *    - Set per-session in the spawn config
 *    - Intended for temporary overrides
 *    - Example: Override API_KEY for a specific test session
 *
 * 2. **Global shell env vars** (from Settings → General → Shell Configuration)
 *    - Set once by user, applies to all agents and terminals
 *    - Persisted in electron-store
 *    - Example: ANTHROPIC_API_KEY, PROXY_URL
 *
 * 3. **Process environment** (with Electron/IDE vars stripped, lowest priority)
 *    - Parent process environment as baseline
 *    - Problematic vars removed to prevent auth failures
 *
 * **Safety Features**:
 * - Strips Electron internals (ELECTRON_RUN_AS_NODE, etc.)
 * - Strips IDE markers (CLAUDECODE, etc.)
 * - Strips Maestro's NODE_ENV to avoid conflicts
 * - Applies path expansion for `~/` syntax
 * - Sets MAESTRO_SESSION_RESUMED flag when resuming sessions
 *
 * @param {Record<string, string>} [customEnvVars] - Session-level environment variables that
 *        override global and defaults. These are typically set per-spawn for session-specific
 *        needs. Supports `~/` path expansion. Optional - if not provided, only global vars are used.
 *
 * @param {boolean} [isResuming] - Whether this process is being resumed (vs. fresh spawn).
 *        When true, sets MAESTRO_SESSION_RESUMED=1 in environment so agents can detect resumption.
 *        Optional, defaults to false.
 *
 * @param {Record<string, string>} [globalShellEnvVars] - Global environment variables from
 *        Settings that should apply to all agents. These come from Settings → General → Shell
 *        Configuration. Supports `~/` path expansion. Optional - if not provided, no global
 *        vars are applied.
 *
 * @returns {NodeJS.ProcessEnv} The complete environment object ready to pass to spawn/exec.
 *          Includes all three levels of vars merged with correct precedence.
 *
 * @example
 * // Spawn agent with only global vars (typical use)
 * const globalVars = {
 *   'ANTHROPIC_API_KEY': 'sk-proj-xxxxx',
 *   'DEBUG': 'maestro:*'
 * };
 * const env = buildChildProcessEnv(undefined, false, globalVars);
 * spawn('claude-code', [], { env });
 *
 * @example
 * // Spawn agent with session override of global var
 * const sessionVars = { 'DEBUG': 'off' };  // Override global DEBUG setting
 * const env = buildChildProcessEnv(sessionVars, false, globalVars);
 * // Result: ANTHROPIC_API_KEY from global, DEBUG='off' from session (session wins)
 *
 * @example
 * // Spawn agent on resume with session-specific tracking
 * const env = buildChildProcessEnv(undefined, true, globalVars);
 * // Sets MAESTRO_SESSION_RESUMED=1 so agent knows session was resumed
 *
 * @note Path expansion is applied to all values at all levels (e.g., ~/workspace → /home/user/workspace)
 * @note Variables at higher precedence levels completely replace lower levels (no merging for same key)
 * @note Electron/IDE variables are stripped FIRST before any merging, ensuring they never appear
 *
 * @see STRIPPED_ENV_VARS - List of variables that are always removed
 * @see buildPtyTerminalEnv() - Similar function for PTY terminal environments
 */
/**
 * Collect the environment variables that Maestro is explicitly setting on a
 * spawned process, in the same precedence order as the build* helpers below
 * (global → session-level, with session overriding global). The MAESTRO_SESSION_RESUMED
 * marker is included when applicable. Inherited system env vars are deliberately
 * excluded - this is the set the user can act on (Settings → Shell Configuration
 * and per-agent / per-session overrides), surfaced in the Process Details modal.
 *
 * Applies `~/` path expansion the same way the build helpers do.
 */
export function collectMaestroEnvVars(
	globalShellEnvVars?: Record<string, string>,
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	querySource?: QuerySource
): Record<string, string> {
	const home = os.homedir();
	const expand = (value: string): string =>
		value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
	const result: Record<string, string> = {};
	// Merge first, strip blanks second: a blank at the session layer has to be
	// able to cancel a value set globally, which it cannot do if it is dropped
	// before the merge. See stripBlankEnvVars() for why blanks are not exported.
	const merged: Record<string, string> = {
		...(globalShellEnvVars || {}),
		...(customEnvVars || {}),
	};
	for (const [key, value] of Object.entries(merged)) {
		// An unnamed row is a half-finished editor entry, not a variable.
		if (isBlankEnvKey(key) || isBlankEnvValue(value)) continue;
		result[key] = expand(value);
	}
	if (isResuming) {
		result.MAESTRO_SESSION_RESUMED = '1';
	}
	// Only present when the caller resolved one. Terminal PTYs build their env
	// through buildPtyTerminalEnv(), which does not stamp the marker, and this
	// list is meant to mirror what the process actually got - not to advertise a
	// variable the user would then fail to find.
	if (querySource) {
		result[QUERY_SOURCE_ENV_VAR] = querySource;
	}
	return result;
}

export function buildChildProcessEnv(
	customEnvVars?: Record<string, string>,
	isResuming?: boolean,
	globalShellEnvVars?: Record<string, string>,
	extraPathDirs?: string[],
	querySource?: QuerySource
): NodeJS.ProcessEnv {
	const env = { ...process.env };

	// Strip environment variables that could interfere with agent behaviour.
	// Electron and IDE extension vars can cause agents to misidentify their
	// execution context, leading to auth failures or incorrect API paths.
	for (const key of STRIPPED_ENV_VARS) {
		delete env[key];
	}

	// Build PATH that merges Maestro's hardcoded paths with the user's cached
	// login-shell PATH and any caller-supplied dirs (typically the parent dir
	// of the detected agent binary, so its shebang's interpreter resolves).
	env.PATH = buildSpawnPath(extraPathDirs);

	// Never let a Maestro-spawned agent hijack the user's browser. When an
	// interactive claude (the maestro-p TUI) finds its OAuth token needs a
	// refresh, its URL opener execs `$BROWSER <authorize-url>` - and if BROWSER
	// is unset it falls back to the OS default opener - popping a real browser
	// tab mid-turn even though the turn itself still succeeds on the current
	// access token. Force BROWSER to a no-op so that self-heal can never open a
	// tab; a genuinely dead token then surfaces as Maestro's normal auth-expired
	// error instead. Set BEFORE the global/session loops so a user who *wants*
	// an explicit BROWSER (Settings → Shell Configuration or a per-session
	// override) still wins. Mirrors the guard in claude-usage-sampler.ts; a
	// value that can't be exec'd (e.g. on Windows) still fails closed = no tab.
	env.BROWSER = '/usr/bin/true';

	if (isResuming) {
		env.MAESTRO_SESSION_RESUMED = '1';
	} else {
		delete env.MAESTRO_SESSION_RESUMED;
	}

	// Apply the user-editable layers: global shell vars first, then session-level
	// overrides on top. Merged before they are applied so a blank session value
	// can cancel a global one instead of being overwritten by it.
	applyEnvRecord(env, {
		...(globalShellEnvVars || {}),
		...(customEnvVars || {}),
	});

	// Who asked for this turn. Stamped after the user-editable layers rather than
	// before them: this is Maestro stating a fact about the spawn, not a default
	// the user is offering an opinion on, and a stray global var of the same name
	// would otherwise silently mislabel every turn on the machine.
	env[QUERY_SOURCE_ENV_VAR] = querySource ?? DEFAULT_QUERY_SOURCE;

	return env;
}

/**
 * Write a merged env record onto a process env. `~/` values are expanded; a
 * blank value REMOVES the variable, inherited value included, because blank
 * means "do not set this" (exporting `FOO=` is what made a blank
 * CLAUDE_CONFIG_DIR crash the agent inside `mkdir('')`); and an unnamed row is
 * a half-finished editor entry, so it neither sets nor cancels anything.
 */
function applyEnvRecord(env: NodeJS.ProcessEnv, record: Record<string, string>): void {
	const home = os.homedir();
	for (const [key, value] of Object.entries(record)) {
		if (isBlankEnvKey(key)) continue;
		if (isBlankEnvValue(value)) {
			delete env[key];
			continue;
		}
		env[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
	}
}

/**
 * Which surface is launching the agent.
 *
 * Desktop chat, the CLI and Cue have each layered an agent's environment their
 * own way since before this library existed, and they do not agree. The
 * builders below reproduce each surface exactly as it was. A shared function is
 * not licence to change what any of them does: making the three agree is a
 * product change, to be proposed and accepted on its own.
 *
 * | Surface   | Inherited env                    | Provider defaults            | Global Settings vars       |
 * | --------- | -------------------------------- | ---------------------------- | -------------------------- |
 * | `desktop` | Electron and IDE vars stripped   | over the inherited value     | BELOW the provider defaults |
 * | `cli`     | as inherited                     | only where the shell set none | not applied                |
 * | `cue`     | as inherited                     | over the inherited value     | not applied                |
 */
export type AgentEnvSurface = 'desktop' | 'cli' | 'cue';

/**
 * The configurable sources of an agent's environment, each named for where it
 * is set.
 */
export interface AgentEnvLayers {
	/** The provider definition's `defaultEnvVars`: what Maestro needs by default. */
	defaultEnvVars?: Record<string, string>;
	/**
	 * The provider definition's `batchModeEnvVars`. Only the CLI's batch spawns
	 * pass these; they sit with the defaults, just above them.
	 */
	batchModeEnvVars?: Record<string, string>;
	/**
	 * Settings -> Environment. Desktop only: it is applied to the local process
	 * BENEATH the provider defaults. It is not in `resolveAgentEnvVars()`, but
	 * desktop's SSH wrapper (`wrap-spawn-for-ssh.ts`) still merges it beneath
	 * that record into the remote environment, as `rc` does. The CLI and Cue do
	 * not apply it.
	 */
	globalShellEnvVars?: Record<string, string>;
	/** Settings -> Agents, per provider. */
	agentCustomEnvVars?: Record<string, string>;
	/**
	 * This agent's own vars. When present (even empty) they REPLACE
	 * `agentCustomEnvVars` rather than layering over them, the rule
	 * `effectiveAgentCustomEnvVars` and `resolveAgentEnvironment` share, so usage
	 * attribution describes the process that actually runs.
	 */
	sessionCustomEnvVars?: Record<string, string>;
	/**
	 * The provider's `readOnlyEnvOverrides`, passed only for a read-only turn.
	 * Applied over everything the user set: read-only enforcement must not be
	 * undone by a per-agent var.
	 */
	readOnlyEnvOverrides?: Record<string, string>;
}

/**
 * Merge the layers Maestro sets on an agent into one record, lowest precedence
 * first:
 *
 *   defaultEnvVars < batchModeEnvVars
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *
 * The same on every surface. This is the record that crosses to an SSH remote,
 * where `process.env` does not exist, and the one Process Details shows. The
 * global Settings vars are NOT in it: on desktop they sit beneath this record.
 * They are not kept off the remote, though: desktop's SSH wrapper
 * (`wrap-spawn-for-ssh.ts`) merges them beneath this record into the remote
 * environment, as `rc` does. Keeping them local, since a path that names a
 * directory here names nothing there, would be a behavior change of its own.
 * Returns undefined when no layer sets anything.
 */
export function resolveAgentEnvVars(layers: AgentEnvLayers): Record<string, string> | undefined {
	const userEnvVars = layers.sessionCustomEnvVars ?? layers.agentCustomEnvVars;
	const merged: Record<string, string> = {
		...(layers.defaultEnvVars ?? {}),
		...(layers.batchModeEnvVars ?? {}),
		...(userEnvVars ?? {}),
		...(layers.readOnlyEnvOverrides ?? {}),
	};
	for (const key of Object.keys(merged)) {
		if (isBlankEnvKey(key)) delete merged[key];
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/** Everything `buildAgentEnvironment` needs beyond the layers. */
export interface BuildAgentEnvironmentOptions extends AgentEnvLayers {
	/** Whose rules to build the environment by. */
	surface: AgentEnvSurface;
	/**
	 * Vars Maestro states about this spawn (caller identity, an MCP bridge, the
	 * acting web user). Applied over every user layer: they are facts, not
	 * preferences.
	 */
	maestroEnvVars?: Record<string, string>;
	/** Desktop and CLI: stamps MAESTRO_SESSION_RESUMED=1 (Cue runs are never resumed). */
	isResuming?: boolean;
	/** Who asked for this turn; stamped last. Defaults to `user`. */
	querySource?: QuerySource;
	/** Desktop only: directories to put in front of PATH. */
	extraPathDirs?: string[];
	/**
	 * Cue only: inherit just the allowlisted part of `process.env` (see
	 * {@link filterServerProcessEnv}). Also on when `MAESTRO_SERVER_MODE=1`.
	 */
	isServerMode?: boolean;
	/**
	 * CLI and Cue only: the secrets THIS agent declared it needs, already
	 * resolved from systemd credentials, `/run/secrets` or the environment
	 * (`src/shared/serverSecrets.ts`). Applied as part of the inherited tier:
	 * above the server-mode allowlist, so a declared secret reaches its agent
	 * without being allowlisted for every agent, and below every user and
	 * Maestro layer. Desktop ignores it. Never part of `resolveAgentEnvVars`,
	 * whose result is shown in Process Details and crosses to SSH remotes.
	 */
	secretEnvVars?: Record<string, string>;
	/**
	 * A managed launch's final ceiling (see {@link applyManagedEnvCeiling}).
	 * Applied on every surface at the same point: after every user layer and
	 * before Maestro's own facts. Absent for an unmanaged launch, which keeps
	 * its surface's order untouched.
	 */
	managed?: ManagedEnvCeilingInput;
}

/**
 * The complete environment for a LOCAL agent process, by the rules of the
 * surface that launches it (see {@link AgentEnvSurface}).
 */
export function buildAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	switch (options.surface) {
		case 'cli':
			return buildCliAgentEnvironment(options);
		case 'cue':
			return buildCueAgentEnvironment(options);
		default:
			return buildDesktopAgentEnvironment(options);
	}
}

/**
 * Desktop chat:
 *
 *   process.env < globalShellEnvVars < defaultEnvVars
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *     < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * `process.env` is inherited with the Electron/IDE/caller-identity vars in
 * `STRIPPED_ENV_VARS` removed, PATH rebuilt, and BROWSER disarmed (see
 * `buildChildProcessEnv`). A blank value unsets the variable and `~/` expands.
 */
function buildDesktopAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	if (options.managed) {
		// The user layers first (as below), the ceiling over them, then
		// Maestro's facts: the ceiling must see what the user set and must not
		// be able to touch what Maestro states afterwards.
		const env = buildChildProcessEnv(
			resolveAgentEnvVars(options) ?? {},
			options.isResuming,
			options.globalShellEnvVars,
			options.extraPathDirs,
			options.querySource
		);
		applyManagedEnvCeiling(env, options.managed);
		Object.assign(env, options.maestroEnvVars ?? {});
		env[QUERY_SOURCE_ENV_VAR] = options.querySource ?? DEFAULT_QUERY_SOURCE;
		return env;
	}
	const record = {
		...(resolveAgentEnvVars(options) ?? {}),
		...(options.maestroEnvVars ?? {}),
	};
	return buildChildProcessEnv(
		record,
		options.isResuming,
		options.globalShellEnvVars,
		options.extraPathDirs,
		options.querySource
	);
}

/**
 * The CLI (`maestro-cli send`, Auto Run, playbooks):
 *
 *   process.env < secretEnvVars
 *     < defaultEnvVars and batchModeEnvVars, which fill only what is NOT set
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *     < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * The shell wins over the provider defaults, so a value exported in the shell
 * that runs the command survives; the user's own vars override it, because the
 * user explicitly opted into them. `process.env` is inherited as it is, with
 * PATH expanded. Values are written as given: no `~/` expansion, and a blank
 * value is exported blank. MAESTRO_SESSION_RESUMED is set for a resumed turn
 * and cleared otherwise, as on desktop, so a marker inherited from the shell
 * that ran the command never reaches a fresh turn.
 */
function buildCliAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	// The agent's declared secrets join what the shell exported (a secret file
	// wins over the same name in the shell; see serverSecrets.ts).
	const env: NodeJS.ProcessEnv = { ...process.env, ...(options.secretEnvVars ?? {}) };
	env.PATH = buildExpandedPath();
	if (options.isResuming) {
		env.MAESTRO_SESSION_RESUMED = '1';
	} else {
		delete env.MAESTRO_SESSION_RESUMED;
	}

	// Merged first so a batch-mode value beats a default for the same key, then
	// applied only to slots the shell left empty.
	const defaults = { ...(options.defaultEnvVars ?? {}), ...(options.batchModeEnvVars ?? {}) };
	for (const [key, value] of Object.entries(defaults)) {
		if (!env[key]) env[key] = value;
	}
	Object.assign(env, options.sessionCustomEnvVars ?? options.agentCustomEnvVars ?? {});
	Object.assign(env, options.readOnlyEnvOverrides ?? {});
	if (options.managed) applyManagedEnvCeiling(env, options.managed);
	Object.assign(env, options.maestroEnvVars ?? {});
	env[QUERY_SOURCE_ENV_VAR] = options.querySource ?? DEFAULT_QUERY_SOURCE;
	return env;
}

/**
 * Cue:
 *
 *   process.env < secretEnvVars < defaultEnvVars < (sessionCustomEnvVars ?? agentCustomEnvVars)
 *     < readOnlyEnvOverrides < maestroEnvVars < MAESTRO_QUERY_SOURCE
 *
 * `process.env` is inherited as it is, with PATH rebuilt the way the desktop
 * agent spawn rebuilds it (a Dock or Finder launch hands Maestro launchd's bare
 * PATH, which hides Homebrew and other user installs). Values are written as
 * given.
 *
 * In server mode the inherited layer is cut down to an allowlist first (see
 * {@link filterServerProcessEnv}); every layer above it is applied unchanged.
 * `secretEnvVars` sits directly on top of that cut, so the secrets this agent
 * declared reach it while the rest of the engine's environment stays out.
 */
function buildCueAgentEnvironment(options: BuildAgentEnvironmentOptions): NodeJS.ProcessEnv {
	const inherited = isServerModeActive(options.isServerMode)
		? filterServerProcessEnv(process.env)
		: process.env;
	const env: NodeJS.ProcessEnv = {
		...inherited,
		...(options.secretEnvVars ?? {}),
		PATH: buildSpawnPath(options.extraPathDirs),
		...(resolveAgentEnvVars(options) ?? {}),
	};
	if (options.managed) applyManagedEnvCeiling(env, options.managed);
	Object.assign(env, options.maestroEnvVars ?? {});
	env[QUERY_SOURCE_ENV_VAR] = options.querySource ?? DEFAULT_QUERY_SOURCE;
	return env;
}

// ─── Managed ceiling ─────────────────────────────────────────────────────────

/**
 * The environment variables through which a provider's route is chosen: the
 * credential it bills, the origin it talks to, the model it asks for and the
 * account home it reads its login and transcripts from. These are the names
 * a managed ceiling controls, across EVERY provider: a Claude agent handed
 * `OPENAI_API_KEY` by the shell is not routed by it, but it is not the
 * policy's to leave lying around either.
 */
export interface ProviderRouteEnvNames {
	credential: readonly string[];
	baseUrl: string | null;
	model: string | null;
	accountDir: string | null;
}

export const PROVIDER_ROUTE_ENV_NAMES: Readonly<Record<string, ProviderRouteEnvNames>> = {
	'claude-code': {
		credential: [
			'ANTHROPIC_API_KEY',
			'ANTHROPIC_AUTH_TOKEN',
			'CLAUDE_CODE_USE_BEDROCK',
			'CLAUDE_CODE_USE_VERTEX',
		],
		baseUrl: 'ANTHROPIC_BASE_URL',
		model: 'ANTHROPIC_MODEL',
		accountDir: 'CLAUDE_CONFIG_DIR',
	},
	codex: {
		credential: ['OPENAI_API_KEY'],
		baseUrl: 'OPENAI_BASE_URL',
		model: null,
		accountDir: 'CODEX_HOME',
	},
	opencode: {
		credential: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
		baseUrl: null,
		model: null,
		accountDir: null,
	},
	'factory-droid': {
		credential: ['FACTORY_API_KEY'],
		baseUrl: null,
		model: null,
		accountDir: null,
	},
	'copilot-cli': {
		credential: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
		baseUrl: null,
		model: null,
		accountDir: 'COPILOT_HOME',
	},
};

/** Every route-controlling name of every provider, once. */
export const ALL_ROUTE_ENV_NAMES: readonly string[] = [
	...new Set(
		Object.values(PROVIDER_ROUTE_ENV_NAMES).flatMap((names) => [
			...names.credential,
			...(names.baseUrl ? [names.baseUrl] : []),
			...(names.model ? [names.model] : []),
			...(names.accountDir ? [names.accountDir] : []),
		])
	),
];

/**
 * `MAESTRO_*` names that state who is acting, where the data lives or what
 * mode the host runs in. A user layer or an inherited shell may not set them
 * under management: Maestro restates every one it means to set right after
 * the ceiling (`maestroEnvVars`, the query source).
 */
export const MANAGED_AUTHORITY_ENV_NAMES: readonly string[] = [
	QUERY_SOURCE_ENV_VAR,
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	MANAGED_DELEGATION_ENV_VAR,
	SERVER_MODE_ENV_VAR_NAME,
	SERVER_ENV_ALLOW_ENV_VAR_NAME,
	'MAESTRO_USER_DATA',
	'MAESTRO_SESSION_RESUMED',
	'MAESTRO_CLI_JS',
	'MAESTRO_AGENT_ID',
	'MAESTRO_TRANSLATION_KNOWLEDGE',
];
/** Any `MAESTRO_MANAGED_*` name is authority-shaped and is never taken from a user layer. */
export const MANAGED_AUTHORITY_ENV_PREFIX = 'MAESTRO_MANAGED_';

/**
 * The permission modes a launch can ask for, as the argument builder names
 * them (`BuildAgentArgsOptions.permissionMode`): `readonly` is the provider's
 * plan or read-only mode, `standard` its own prompting, `full` its bypass of
 * every approval. Ordered by width: `readonly` < `standard` < `full`.
 */
export type LaunchPermissionMode = 'readonly' | 'standard' | 'full';

/** How much a mode may do: a ceiling pins the widest mode a launch may ask for. */
const PERMISSION_MODE_WIDTH: Readonly<Record<LaunchPermissionMode, number>> = {
	readonly: 0,
	standard: 1,
	full: 2,
};

/**
 * Whether a requested mode fits under a pinned one. A ceiling of null pins
 * no mode and admits every request; otherwise the request may be as wide as
 * the pin and no wider. The one width rule for every surface that compares
 * a request to a ceiling (the desktop spawn handler, the argument builder,
 * the argument check below): a second table would drift.
 */
export function permissionModeWithinCeiling(
	requested: LaunchPermissionMode,
	pinned: LaunchPermissionMode | null
): boolean {
	if (pinned === null) return true;
	return PERMISSION_MODE_WIDTH[requested] <= PERMISSION_MODE_WIDTH[pinned];
}

/**
 * What the policy pins for one launch. `null` for a control the policy does
 * not pin, which then stays UNSET (never the user's value): a managed route
 * either names its gateway or uses the provider's own API, it does not
 * inherit one from the shell.
 */
export interface ManagedRouteCeiling {
	providerId: string;
	/** The model the launch must ask for, or null to leave the provider's default. */
	model: string | null;
	/** The gateway origin, or null for the provider's own API. */
	baseUrl: string | null;
	/** The account home (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...), or null for the provider's default. */
	accountDir: string | null;
	/**
	 * `approved-credential`: the launch must carry a credential an approved
	 * reference delivered; with none the provider would fall back to whatever
	 * personal login sits in the account home, and that is refused.
	 * `provider-login`: the policy lets the account home's own login bill.
	 */
	login: 'approved-credential' | 'provider-login';
	/**
	 * The widest permission mode a launch on this provider may ask for, or
	 * null when the policy pins none (MRC2-03-01). A request above it is
	 * DENIED, by name, wherever the request is seen: the mode itself at the
	 * desktop spawn handler (`managedPermissionModeRefusal`) and the argument
	 * builder (`buildAgentArgs` under `managedCeiling`), and the flags that
	 * ask for it on the final command line (`managedArgsProblems`). Nothing
	 * lowers a request to fit: a turn the person asked to run with full
	 * access, silently run read-only, is a turn they were told nothing about.
	 * `readonly` also demands a provider whose read-only mode the command
	 * line enforces (`readOnlyCliEnforced`), since a prompt-only read-only
	 * mode would make the ceiling a label.
	 */
	permissionMode: LaunchPermissionMode | null;
}

export interface ManagedEnvCeilingInput {
	ceiling: ManagedRouteCeiling;
	/**
	 * The values approved credential references delivered, keyed by the
	 * variable the consumer reads (`deliverManagedCredentials` in the launch
	 * plan). Placed by the ceiling itself, so they sit above the user layers
	 * and survive the strip.
	 */
	credentialEnvVars: Readonly<Record<string, string>>;
	/** Hears what the ceiling did, so the launch plan can refuse on a problem. */
	report?: (report: ManagedEnvCeilingReport) => void;
}

export interface ManagedEnvCeilingReport {
	/** Names removed from the environment, sorted. Never values. */
	removed: string[];
	/** Names the policy set, sorted. */
	pinned: string[];
	/** Why the environment does not satisfy the ceiling; empty when it does. */
	problems: string[];
}

/**
 * The final managed ceiling over an environment that already holds every
 * user layer. In place, and the same on every surface:
 *
 *   1. every route-controlling name of every provider is removed
 *      ({@link ALL_ROUTE_ENV_NAMES}): an inherited key, a user's personal key
 *      or base URL, a shell's `CLAUDE_CONFIG_DIR`;
 *   2. every authority-shaped `MAESTRO_*` name a user layer could have set is
 *      removed ({@link MANAGED_AUTHORITY_ENV_NAMES}, `MAESTRO_MANAGED_*`);
 *   3. the policy's pins are set (model, base URL, account home);
 *   4. the approved credential values are set.
 *
 * Then the result is checked against the ceiling: a `login: 'approved-credential'`
 * route with no credential delivered is a problem (the provider would fall
 * back to a personal login), as is a delivered credential whose variable is
 * not one the provider reads. The caller refuses the launch on any problem.
 */
export function applyManagedEnvCeiling(
	env: NodeJS.ProcessEnv,
	input: ManagedEnvCeilingInput
): ManagedEnvCeilingReport {
	const { ceiling, credentialEnvVars } = input;
	const removed = new Set<string>();
	const strip = (name: string) => {
		for (const key of Object.keys(env)) {
			if (key === name || (isWindows() && key.toUpperCase() === name.toUpperCase())) {
				delete env[key];
				removed.add(key);
			}
		}
	};
	for (const name of ALL_ROUTE_ENV_NAMES) strip(name);
	for (const name of MANAGED_AUTHORITY_ENV_NAMES) strip(name);
	for (const key of Object.keys(env)) {
		if (key.toUpperCase().startsWith(MANAGED_AUTHORITY_ENV_PREFIX)) {
			delete env[key];
			removed.add(key);
		}
	}

	const names = PROVIDER_ROUTE_ENV_NAMES[ceiling.providerId];
	const pinned: string[] = [];
	const problems: string[] = [];
	const pin = (name: string | null, value: string | null, what: string) => {
		if (value === null) return;
		if (!name) {
			problems.push(`the policy pins the ${what} but ${ceiling.providerId} has no variable for it`);
			return;
		}
		env[name] = value;
		pinned.push(name);
	};
	pin(names?.model ?? null, ceiling.model, 'model');
	pin(names?.baseUrl ?? null, ceiling.baseUrl, 'base URL');
	pin(names?.accountDir ?? null, ceiling.accountDir, 'account home');

	const delivered = Object.keys(credentialEnvVars).sort();
	for (const name of delivered) {
		if (names && !names.credential.includes(name)) {
			problems.push(`${name} is not a credential variable ${ceiling.providerId} reads`);
			continue;
		}
		env[name] = credentialEnvVars[name];
	}
	if (ceiling.login === 'approved-credential') {
		const carried = delivered.filter((name) => names?.credential.includes(name));
		if (carried.length === 0) {
			problems.push(
				`the route requires an approved credential and none was delivered; ${ceiling.providerId} would fall back to the personal login in its account home`
			);
		}
	}
	const report = { removed: [...removed].sort(), pinned: pinned.sort(), problems };
	input.report?.(report);
	return report;
}

/**
 * Boolean flags that ask a provider to bypass every approval, across the
 * providers Maestro drives. The static half of the full-access vocabulary:
 * `filterYoloArgs` strips them from a read-only turn, and a managed ceiling
 * below `full` refuses them. A provider's own `fullAccessArgs` /
 * `yoloModeArgs` (`--yolo`, `--always-approve`) join them per provider in
 * {@link fullAccessFlagsOf}.
 */
export const KNOWN_FULL_ACCESS_FLAGS: readonly string[] = [
	'--dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-permissions-unsafe',
	'-y',
	'--allow-all',
];

/**
 * Value-taking mode flags whose named value asks for full access: Claude's
 * and Grok's `--permission-mode bypassPermissions`, Qwen's and Gemini's
 * `--approval-mode yolo`, Codex's `--sandbox danger-full-access` and
 * `--ask-for-approval never`. The same flags with another value (`plan`,
 * `read-only`) are the read-only vocabulary and are not refused here.
 */
const FULL_ACCESS_MODE_VALUES: Readonly<Record<string, readonly string[]>> = {
	'--permission-mode': ['bypassPermissions'],
	'--approval-mode': ['yolo'],
	'--sandbox': ['danger-full-access'],
	'--ask-for-approval': ['never'],
	'-a': ['never'],
};

/**
 * What one provider's command line says about permission modes, read from
 * its definition: the boolean flags that ask for full access (the static
 * vocabulary plus the provider's own), the flags its read-only mode is made
 * of, and whether the command line ENFORCES that read-only mode or only
 * accepts the flag (`readOnlyCliEnforced`). An unknown provider has the
 * static flags alone and enforces nothing.
 */
export interface ProviderPermissionVocabulary {
	providerId: string;
	known: boolean;
	fullAccessFlags: readonly string[];
	readOnlyArgs: readonly string[];
	readOnlyCliEnforced: boolean;
}

export function permissionVocabularyOf(providerId: string): ProviderPermissionVocabulary {
	const definition = getAgentDefinition(providerId);
	const own = [...(definition?.fullAccessArgs ?? []), ...(definition?.yoloModeArgs ?? [])];
	return {
		providerId,
		known: definition !== undefined,
		fullAccessFlags: [
			...new Set([...KNOWN_FULL_ACCESS_FLAGS, ...own.filter((arg) => arg.startsWith('-'))]),
		],
		readOnlyArgs: definition?.readOnlyArgs ?? [],
		readOnlyCliEnforced: definition?.readOnlyCliEnforced === true,
	};
}

/** The flags that ask `providerId` for full access, as a set. */
export function fullAccessFlagsOf(providerId: string): ReadonlySet<string> {
	return new Set(permissionVocabularyOf(providerId).fullAccessFlags);
}

/**
 * Whether the args carry every flag of a provider's read-only vocabulary,
 * with the value the vocabulary gives it (`--sandbox read-only` or
 * `--sandbox=read-only`). A flag the vocabulary gives no value is a switch
 * and is satisfied by its presence. An empty vocabulary is satisfied by
 * anything (Factory Droid's `exec` is read-only with no flag).
 */
function carriesReadOnlyArgs(args: readonly string[], readOnlyArgs: readonly string[]): boolean {
	for (let i = 0; i < readOnlyArgs.length; i += 1) {
		const flag = readOnlyArgs[i];
		if (!flag.startsWith('-')) continue;
		const next = readOnlyArgs[i + 1];
		const value = next !== undefined && !next.startsWith('-') ? next : null;
		if (value !== null) i += 1;
		const present = args.some((arg, index) => {
			if (value === null) return arg === flag;
			return arg === `${flag}=${value}` || (arg === flag && args[index + 1] === value);
		});
		if (!present) return false;
	}
	return true;
}

/**
 * Why a permission mode cannot run under a ceiling, as one problem, or null
 * when it may. The request is measured against the pin by width alone
 * (`permissionModeWithinCeiling`); the words name both so a refusal says
 * what was asked and what the policy allows.
 */
export function managedPermissionModeProblem(
	requested: LaunchPermissionMode,
	ceiling: Pick<ManagedRouteCeiling, 'providerId' | 'permissionMode'>
): string | null {
	if (permissionModeWithinCeiling(requested, ceiling.permissionMode)) return null;
	return `permission mode "${requested}" asks for more than the policy's ceiling, which allows at most "${ceiling.permissionMode}" for ${ceiling.providerId}`;
}

/** Codex `-c key=value` keys that choose the provider, the origin or the credential. */
const CODEX_ROUTE_CONFIG_KEYS =
	/^(model|model_provider|model_providers\b.*|base_url|openai_base_url|api_key|chatgpt_base_url|experimental_use_.*auth.*)\s*=/i;
/** Claude `--settings` keys that choose the credential, the model or the environment. */
const CLAUDE_ROUTE_SETTINGS_KEYS = [
	'env',
	'apiKeyHelper',
	'model',
	'awsAuthRefresh',
	'awsCredentialExport',
];

/**
 * Arguments that would route around the ceiling. Checked by name, not by
 * executing anything: a model flag naming a model other than the pinned
 * one, a Claude `--settings` payload that sets `env`, `model` or an API key
 * helper, a Codex `-c`/`--config` override of the model, provider or base
 * URL, or any flag that names an API key or base URL directly.
 *
 * And, when the ceiling pins a permission mode (MRC2-03-01), the flags that
 * ask for a wider one: under `standard` or `readonly`, any flag of the
 * provider's full-access vocabulary ({@link fullAccessFlagsOf}: the static
 * `KNOWN_FULL_ACCESS_FLAGS` and its own `fullAccessArgs` / `yoloModeArgs`)
 * and any mode flag whose value names full access; under `readonly`, a
 * provider whose read-only mode the command line does not enforce is a
 * problem, and so is a command line that does not carry that provider's
 * read-only flags, since a request for `standard` leaves no flag behind and
 * can only be seen by the absence of those. Every problem names the flag or
 * the gap and the pinned mode; nothing is rewritten to fit. A ceiling that
 * pins no mode adds no problem, and an unmanaged launch never gets here.
 */
export function managedArgsProblems(
	args: readonly string[],
	ceiling: ManagedRouteCeiling
): string[] {
	const problems: string[] = [];
	const modelFlags = new Set(['--model', '-m']);
	const forbiddenFlags = new Set(['--api-key', '--base-url', '--profile', '--auth-token']);
	const pinnedMode = ceiling.permissionMode;
	const vocabulary = permissionVocabularyOf(ceiling.providerId);
	const fullAccess = new Set(vocabulary.fullAccessFlags);
	const forbidsFull = pinnedMode !== null && !permissionModeWithinCeiling('full', pinnedMode);
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const eq = arg.indexOf('=');
		const inline = eq > 0 && arg.startsWith('-');
		const flag = inline ? arg.slice(0, eq) : arg;
		const value = inline ? arg.slice(eq + 1) : args[i + 1];
		if (forbidsFull && fullAccess.has(arg)) {
			problems.push(
				`${arg} asks for full access but the policy's ceiling allows at most "${pinnedMode}" for ${ceiling.providerId}`
			);
			continue;
		}
		if (
			forbidsFull &&
			typeof value === 'string' &&
			FULL_ACCESS_MODE_VALUES[flag]?.includes(value) === true
		) {
			problems.push(
				`${flag} ${value} asks for full access but the policy's ceiling allows at most "${pinnedMode}" for ${ceiling.providerId}`
			);
			continue;
		}
		if (modelFlags.has(flag)) {
			if (ceiling.model !== null && value !== ceiling.model) {
				problems.push(`${flag} names ${value ?? '(nothing)'} but the policy pins ${ceiling.model}`);
			}
			continue;
		}
		if (forbiddenFlags.has(flag)) {
			problems.push(`${flag} is not allowed under management`);
			continue;
		}
		if ((flag === '-c' || flag === '--config') && typeof value === 'string') {
			if (CODEX_ROUTE_CONFIG_KEYS.test(value.trim())) {
				const key = value.split('=')[0].trim();
				const named = value
					.slice(value.indexOf('=') + 1)
					.trim()
					.replace(/^"|"$/g, '');
				if (!(key === 'model' && ceiling.model !== null && named === ceiling.model)) {
					problems.push(`${flag} ${key} is not allowed under management`);
				}
			}
			continue;
		}
		if (flag === '--settings' && typeof value === 'string') {
			let settings: unknown;
			try {
				settings = JSON.parse(value);
			} catch {
				problems.push('--settings names a file or unparsable JSON, which cannot be checked');
				continue;
			}
			if (settings && typeof settings === 'object') {
				for (const key of CLAUDE_ROUTE_SETTINGS_KEYS) {
					if (key in (settings as Record<string, unknown>)) {
						problems.push(`--settings sets ${key}, which is not allowed under management`);
					}
				}
			}
		}
	}
	if (pinnedMode === 'readonly') {
		if (!vocabulary.readOnlyCliEnforced) {
			problems.push(
				`the policy pins read-only but ${ceiling.providerId} cannot enforce it on the command line`
			);
		} else if (!carriesReadOnlyArgs(args, vocabulary.readOnlyArgs)) {
			problems.push(
				`the policy pins read-only and the arguments do not carry ${ceiling.providerId}'s read-only flags (${vocabulary.readOnlyArgs.join(' ')})`
			);
		}
	}
	return problems;
}

// ─── Server mode ─────────────────────────────────────────────────────────────

/** Set to `1` to run Cue with the server-mode environment allowlist. */
export const SERVER_MODE_ENV_VAR = SERVER_MODE_ENV_VAR_NAME;
/** Comma-separated extra variable names an operator lets through in server mode. */
export const SERVER_ENV_ALLOW_ENV_VAR = SERVER_ENV_ALLOW_ENV_VAR_NAME;

/**
 * Whether server mode is on: the caller said so, or the operator set
 * `MAESTRO_SERVER_MODE=1`. Never inferred from the runner kind - a standalone
 * engine on a laptop is the user's own shell environment and keeps all of it.
 */
export function isServerModeActive(isServerMode?: boolean): boolean {
	return isServerMode === true || process.env[SERVER_MODE_ENV_VAR] === '1';
}

/** Exact names a server-mode child inherits. Compared case-insensitively. */
const SERVER_ENV_ALLOWED_NAMES: readonly string[] = [
	// Essential system variables.
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'TERM',
	'TMPDIR',
	// Windows equivalents, without which a child cannot find its own runtime.
	'SYSTEMROOT',
	'COMSPEC',
	'PATHEXT',
	'USERPROFILE',
	'APPDATA',
	'LOCALAPPDATA',
	'TEMP',
	'TMP',
	// Network proxy and TLS trust.
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	// Common dev toolchains.
	'NVM_DIR',
	'JAVA_HOME',
	'GOPATH',
	'CARGO_HOME',
	'PYTHONPATH',
	'DENO_INSTALL_ROOT',
];

/** Name prefixes a server-mode child inherits. */
const SERVER_ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'SSH_', 'MAESTRO_'];

/**
 * `MAESTRO_*` names that are NOT inherited even though the prefix is: the
 * caller identity and the query source describe whoever launched THIS
 * process, and the Cue spawn restates both itself (see `STRIPPED_ENV_VARS`).
 */
const SERVER_ENV_DENIED_NAMES: readonly string[] = [
	CALLER_AGENT_ID_ENV_VAR,
	CALLER_TAB_ID_ENV_VAR,
	QUERY_SOURCE_ENV_VAR,
];

/** Every provider credential and account-dir name the env catalog knows. */
const PROVIDER_ENV_NAMES: readonly string[] = Object.values(PROVIDER_ENV_VAR_SUGGESTIONS).flatMap(
	(entries) => entries.map((entry) => entry.key)
);

function operatorAllowedNames(): string[] {
	const raw = process.env[SERVER_ENV_ALLOW_ENV_VAR];
	if (!raw) return [];
	return raw
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '');
}

/**
 * The part of an inherited environment a server-mode child may see.
 *
 * On a shared server the engine's own environment holds secrets meant for the
 * engine alone (the 0DIN token, webhook secrets resolved through
 * `secret_env`, deploy credentials), and an agent prompted by third-party text
 * must not be able to read them back out. So this is an ALLOWLIST, never a
 * blocklist: anything not named here is dropped, and an operator who needs
 * more names them in `MAESTRO_SERVER_ENV_ALLOW`.
 *
 * Names are compared case-insensitively: Windows treats them that way, and
 * the lowercase proxy spellings (`https_proxy`) are the ones curl reads.
 */
export function filterServerProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const allowed = new Set(
		[...SERVER_ENV_ALLOWED_NAMES, ...PROVIDER_ENV_NAMES, ...operatorAllowedNames()].map((name) =>
			name.toUpperCase()
		)
	);
	const denied = new Set(SERVER_ENV_DENIED_NAMES.map((name) => name.toUpperCase()));

	const filtered: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		const upper = key.toUpperCase();
		if (denied.has(upper)) continue;
		if (allowed.has(upper) || SERVER_ENV_ALLOWED_PREFIXES.some((p) => upper.startsWith(p))) {
			filtered[key] = value;
		}
	}
	return filtered;
}
