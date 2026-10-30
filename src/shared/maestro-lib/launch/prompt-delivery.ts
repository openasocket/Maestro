/**
 * How a prompt reaches an agent process: on its command line, over stdin, or
 * through the SSH script that runs it remotely. And the same question for the
 * Maestro system prompt: a flag, a temp file, or embedded in the first turn.
 *
 * Desktop chat, Cue and the CLI used to answer these separately and had
 * drifted: only desktop moved a Windows prompt to stdin (CreateProcess caps the
 * command line near 32K), and the "which prompt flag" rule was restated at four
 * call sites. Every surface now asks here.
 */

import { isAbsolutePath } from '../../formatters';
import type { AgentCapabilities } from '../../types';
import type { AgentConfig } from '../providers/definitions';

/** The parts of a provider definition that decide how its prompt is written. */
export interface PromptDeliveryAgent {
	/** Builds the prompt flag, e.g. `['-p', prompt]`. Wins over the positional forms. */
	promptArgs?: (prompt: string) => string[];
	/** Explicit file delivery, independent of the legacy Windows-only builder. */
	promptFile?: AgentConfig['promptFile'];
	promptFileArgs?: AgentConfig['promptFileArgs'];
	/** The CLI rejects `--` before a positional prompt (Pi, Factory Droid). */
	noPromptSeparator?: boolean;
	/** Args that make the CLI read its query from stdin (Hermes: `--query-file -`). */
	stdinPromptArgs?: string[];
	capabilities?: Pick<AgentCapabilities, 'supportsPromptViaStdin' | 'supportsStreamJsonInput'>;
}

/**
 * The argv tail that carries `prompt` as a command-line argument: the
 * provider's own flag when it has one, else a positional after `--`, else a
 * bare positional for CLIs that reject `--`.
 */
export function buildPromptArgv(
	agent: PromptDeliveryAgent | null | undefined,
	prompt: string
): string[] {
	if (agent?.promptArgs) return agent.promptArgs(prompt);
	if (agent?.noPromptSeparator) return [prompt];
	return ['--', prompt];
}

/**
 * A destination chosen by the executing host, without creating the file yet.
 * The host allocates a fresh collision-resistant name for each launch attempt
 * (for example maestro-prompt-<randomUUID>.txt), never a session-id-only name.
 * Remote paths come from that remote, never from the local temporary directory.
 */
export interface PromptFileDestination {
	path: string;
	owner: 'local' | 'remote';
}

/** Where the user prompt goes. */
export type PromptDelivery =
	/** Nothing to deliver. */
	| { via: 'none' }
	/** Append `args` to the command line. */
	| { via: 'argv'; args: string[] }
	/**
	 * Write the prompt to the child's stdin and close it. `raw` writes the text
	 * as-is (append `args`, the provider's stdin flags, to the command line);
	 * `stream-json` writes one stream-json user message, which is how images
	 * travel with it.
	 */
	| { via: 'stdin'; format: 'raw' | 'stream-json'; args: string[] }
	/** Materialize on the executing host before spawning with these prompt-only args. */
	| {
			via: 'file';
			args: string[];
			artifact: PromptFileDestination & {
				/** Private prompt content. Never include the artifact in diagnostics. */
				content: string;
				encoding: 'utf8';
				mode: 0o600;
				/** Refuse a collision; never overwrite or claim an existing file. */
				flag: 'wx';
				/**
				 * Remove only an exclusively created file, after its reader closes.
				 * Also required on refusal, failed upload/spawn, cancellation, timeout
				 * and supersession. A remote file needs cleanup on that same host.
				 */
				cleanup: 'turn';
			};
	  }
	/** Mandatory delivery could not be planned; no argv/stdin fallback is allowed. */
	| { via: 'refused'; error: string }
	/** The SSH stdin script carries it; nothing is added locally. */
	| { via: 'ssh' };

export interface ResolvePromptDeliveryInput {
	agent: PromptDeliveryAgent | null | undefined;
	prompt: string | undefined;
	/**
	 * Whether the machine that RUNS the CLI is Windows. The host decides, never
	 * a client: a web-desktop browser can sit on another OS than the host.
	 */
	isWindowsHost: boolean;
	/** The agent runs on an SSH remote. */
	sshRemote: boolean;
	/** The turn carries images. */
	hasImages?: boolean;
	/** Arguments before prompt delivery, used to reject competing native sources. */
	args?: readonly string[];
	/** Required only for an explicitly declared prompt file. No I/O occurs here. */
	promptFileDestination?: PromptFileDestination;
}

/**
 * Decide how the user prompt reaches the agent.
 *
 * - An explicit prompt-file declaration wins on every host and surface. The
 *   caller supplies a fresh executing-host path and owns creation and cleanup.
 * - Otherwise, over SSH the remote script carries it.
 * - On a Windows host, an agent that declared `supportsPromptViaStdin` gets it
 *   over stdin, to stay under the CreateProcess command-line limit. With images
 *   and stream-json input it is one stream-json message; otherwise raw text.
 * - Everywhere else it goes on the command line. An agent that has NOT
 *   declared stdin support keeps its prompt in argv even on Windows: an
 *   over-long command line fails loudly at spawn, while stdin delivery to a CLI
 *   that ignores stdin fails silently (omp exits 0 with no output).
 */
export function resolvePromptDelivery(input: ResolvePromptDeliveryInput): PromptDelivery {
	const { agent, prompt } = input;
	if (agent?.promptFile && prompt !== undefined) {
		const { promptFileDestination: destination } = input;
		if (
			!agent.promptFileArgs ||
			!destination ||
			destination.owner !== (input.sshRemote ? 'remote' : 'local') ||
			!isAbsolutePath(destination.path) ||
			destination.path.includes('\0') ||
			!destination.path.endsWith('.txt')
		) {
			return {
				via: 'refused',
				error:
					'Prompt-file delivery requires a fresh owned .txt destination on the executing host and a provider file-argument builder.',
			};
		}
		if (input.hasImages) {
			return { via: 'refused', error: 'This prompt-file format cannot carry embedded images.' };
		}
		if (
			input.args?.some(
				(arg) =>
					arg === '--' ||
					agent.promptFile!.exclusivePromptFlags.some(
						(flag) =>
							arg === flag ||
							arg.startsWith(`${flag}=`) ||
							(flag.length === 2 && arg.startsWith(flag))
					)
			)
		) {
			return {
				via: 'refused',
				error: 'Prompt-file delivery conflicts with another prompt source in the launch arguments.',
			};
		}
		return {
			via: 'file',
			args: agent.promptFileArgs(destination.path),
			artifact: {
				...destination,
				content: prompt,
				encoding: 'utf8',
				mode: 0o600,
				flag: 'wx',
				cleanup: 'turn',
			},
		};
	}
	if (!prompt) return { via: 'none' };
	if (input.sshRemote) return { via: 'ssh' };

	const viaStdin = input.isWindowsHost && (agent?.capabilities?.supportsPromptViaStdin ?? false);
	if (viaStdin) {
		const streamJson = !!input.hasImages && (agent?.capabilities?.supportsStreamJsonInput ?? false);
		return streamJson
			? { via: 'stdin', format: 'stream-json', args: [] }
			: { via: 'stdin', format: 'raw', args: [...(agent?.stdinPromptArgs ?? [])] };
	}
	return { via: 'argv', args: buildPromptArgv(agent, prompt) };
}

/** How Maestro's system prompt reaches the agent. */
export type SystemPromptDelivery =
	/** No system prompt for this turn. */
	| { via: 'none' }
	/** Pass it inline: `--append-system-prompt <text>`. */
	| { via: 'flag' }
	/**
	 * Write it to a temp file and pass `--append-system-prompt-file <path>`:
	 * a Windows host's command line cannot hold a large inline prompt.
	 */
	| { via: 'file' }
	/** Embed it at the top of the user prompt (`embedSystemPromptInPrompt`). */
	| { via: 'embed' }
	/**
	 * Send nothing: a resumed session of a provider without the flag already
	 * carries it in the first turn of its transcript.
	 */
	| { via: 'skip-on-resume' }
	/** No user prompt to embed into, so the system prompt IS the prompt. */
	| { via: 'as-prompt' };

export interface ResolveSystemPromptDeliveryInput {
	systemPrompt: string | undefined;
	/** The provider accepts `--append-system-prompt`. */
	supportsAppendSystemPrompt: boolean;
	isWindowsHost: boolean;
	/** An SSH remote runs the command from a script, so no command-line limit applies. */
	sshRemote: boolean;
	isResume: boolean;
	hasUserPrompt: boolean;
}

/**
 * Decide how the system prompt reaches the agent. A provider with the flag
 * gets it every turn, since the flag is not persisted in its transcript; one
 * without it gets the prompt embedded in the first turn only.
 */
export function resolveSystemPromptDelivery(
	input: ResolveSystemPromptDeliveryInput
): SystemPromptDelivery {
	if (!input.systemPrompt) return { via: 'none' };
	if (input.supportsAppendSystemPrompt) {
		return input.isWindowsHost && !input.sshRemote ? { via: 'file' } : { via: 'flag' };
	}
	if (input.isResume) return { via: 'skip-on-resume' };
	return input.hasUserPrompt ? { via: 'embed' } : { via: 'as-prompt' };
}
