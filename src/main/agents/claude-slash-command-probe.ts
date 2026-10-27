/**
 * Ask Claude Code which slash commands it offers in a folder.
 *
 * `claude --print` names them in its `init` event, so a `--print` turn fills
 * the composer's slash-command list as a side effect. A maestro-p turn drives
 * the interactive TUI, which announces nothing, so that list stayed empty for
 * every agent on the TUI token source. Both the New Agent wizard and the
 * maestro-p tab spawn get the list from here instead.
 *
 * The probe runs `/help`, a local command: it costs no tokens and returns in
 * under two seconds. `--no-session-persistence` keeps it from leaving a
 * transcript behind, which would otherwise show up as a stray session in the
 * folder's session list on every probe.
 *
 * The probe asks for `--dangerously-skip-permissions`, so on a managed host it
 * is a provider started with full access: it runs through `runProviderProbe`
 * (MRC2-03-04), which admits it as a `probe` turn under the policy's ceiling
 * before any process and remembers a refusal, so a denying policy is not asked
 * again on every turn. A refused probe offers no commands; it never runs
 * unmanaged in its place. A standalone host probes exactly as before.
 */

import type { ExecResult } from '../utils/execFile';
import { DispatchRefusedError } from '../../shared/maestro-lib/run/start-turn';
import { logger } from '../utils/logger';
import { runProviderProbe, type ProviderProbeManaged } from './provider-probe';

const LOG_CONTEXT = '[ClaudeSlashCommands]';

const PROBE_ARGS = [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
];
const NO_PERSISTENCE_FLAG = '--no-session-persistence';

// Commands change when the user adds a skill, plugin, or MCP server, which is
// rare; one probe per folder in this window is plenty.
const CACHE_TTL_MS = 30 * 60 * 1000;

/** The `slash_commands` of the first `init` event in stream-json output, or null. */
export function parseInitSlashCommands(stdout: string): string[] | null {
	for (const line of stdout.split('\n')) {
		if (!line.trim()) continue;
		try {
			const msg = JSON.parse(line);
			if (msg?.type === 'system' && msg.subtype === 'init' && Array.isArray(msg.slash_commands)) {
				return msg.slash_commands.filter((c: unknown): c is string => typeof c === 'string');
			}
		} catch {
			// Not JSON (a warning line); keep looking.
		}
	}
	return null;
}

/**
 * Run the probe. Returns the command names, or null when claude could not be
 * run, was refused under management, or reported none. `env` is the full
 * environment for the probe, so a caller can point it at the same
 * `CLAUDE_CONFIG_DIR` its agent runs with. `managed` is the host's port and
 * the request's actor on a host with a spawn authority (`providerProbeManaged`);
 * absent, the probe runs unadmitted, as before.
 */
export async function probeClaudeSlashCommands(
	commandPath: string,
	cwd: string,
	env?: NodeJS.ProcessEnv,
	managed?: ProviderProbeManaged
): Promise<string[] | null> {
	const run = (args: string[]) =>
		runProviderProbe(
			{
				providerId: 'claude-code',
				kind: 'slash-commands',
				command: commandPath,
				args: [...args, '--', '/help'],
				cwd,
				env,
			},
			managed
		);

	let result: ExecResult;
	try {
		result = await run([...PROBE_ARGS, NO_PERSISTENCE_FLAG]);
		// A claude too old to know the flag refuses to start; ask again without it.
		if (result.exitCode !== 0 && /unknown option/i.test(result.stderr ?? '')) {
			result = await run(PROBE_ARGS);
		}
	} catch (error) {
		if (!(error instanceof DispatchRefusedError)) throw error;
		// A managed host refused the probe before it started (its route is
		// unqualified, its flags ask for more than the ceiling, or the policy
		// or authority said no): explicit, by name, and no process. The list
		// stays empty; nothing probes unmanaged in its place.
		logger.warn('Slash command probe refused under management; offering no commands', LOG_CONTEXT, {
			state: error.state,
			code: error.code,
			message: error.message,
		});
		return null;
	}
	if (result.exitCode !== 0 && !result.stdout) {
		logger.warn(`Slash command probe failed with exit code ${result.exitCode}`, LOG_CONTEXT, {
			stderr: result.stderr?.substring(0, 500),
		});
		return null;
	}
	const commands = parseInitSlashCommands(result.stdout);
	if (!commands) {
		logger.warn('No init message found in slash command probe output', LOG_CONTEXT);
	}
	return commands;
}

interface CacheEntry {
	at: number;
	commands: Promise<string[] | null>;
}

const cache = new Map<string, CacheEntry>();

/**
 * {@link probeClaudeSlashCommands}, at most once per binary, folder, and config
 * dir in {@link CACHE_TTL_MS}. Concurrent callers share one probe, so several
 * tabs starting at once spawn one claude, not several. A failed probe is not
 * cached, so the next turn tries again; a probe refused under management is
 * not cached here either, since `runProviderProbe` remembers the refusal
 * itself and answers the next turn without a process.
 */
export function probeClaudeSlashCommandsCached(
	commandPath: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	managed?: ProviderProbeManaged
): Promise<string[] | null> {
	const key = [commandPath, cwd, env.CLAUDE_CONFIG_DIR ?? ''].join('\0');
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.at < CACHE_TTL_MS) return hit.commands;
	const commands = probeClaudeSlashCommands(commandPath, cwd, env, managed).then((found) => {
		if (!found) cache.delete(key);
		return found;
	});
	cache.set(key, { at: now, commands });
	return commands;
}

/** For tests: forget every cached probe. */
export function clearClaudeSlashCommandCache(): void {
	cache.clear();
}
