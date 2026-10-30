/**
 * @file groupchat/spawn.ts
 * @description Everything a group chat or consult turn decides before its process exists.
 *
 * Every spawn site in a round (moderator, participant, synthesis, recovery) and every consult
 * follows one sequence: maybe warm the remote maestro-p probe, pick the Claude token source and
 * realize it, SSH-wrap the command when the agent runs on a remote, apply the Windows shell and
 * stdin rules, and start the turn clock. `prepareGroupChatSpawn` is that sequence, so each call
 * site only describes the semantic intent (`GroupChatSpawn`) and a host only turns the answer into
 * a process: the desktop through its `ProcessManager`, the headless runtime through
 * `planPipeSpawn`.
 *
 * The three collaborators that differ per host are inputs (`GroupChatSpawnDeps`): the Claude
 * decision, whose usage snapshot and remote probe cache are native on the desktop; the remote
 * probe warm-up; and the turn clock.
 */

import { STEERING_SOCKET_ENV_VAR } from '../../chatSteering';
import type { ClaudeTokenMode } from '../../claudeTokenMode';
import { logger } from '../host';
import { getContextWindowValue } from '../launch/agent-args';
import type { AgentLaunchInput } from '../launch/launch-plan';
import {
	resolvePromptDelivery,
	selectPromptFileDestination,
	type PromptDelivery,
} from '../launch/prompt-delivery';
import { newRemotePromptFileDestination } from '../launch/ssh-command-builder';
import {
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	type ClaudeSpawnDecision,
	type ResolveClaudeSpawnModeCoreInput,
} from '../launch/interactive-mode';
import {
	getSshRemoteConfig,
	type SshRemoteSettingsStore,
	type SshRemoteResolveResult,
} from '../launch/ssh-remote-resolver';
import { sshUnresolvedRemoteMessage, wrapSpawnWithSsh } from '../launch/ssh-spawn-wrapper';
import { childDelegationContext, type ManagedDelegationContext } from '../managed/delegation';
import { MANAGED_CONTRACT_VERSION, type ManagedDispatchTarget } from '../managed/types';
import type { DispatchAttribution } from '../managed/authority';
import { parseModeratorSessionId, parseParticipantSessionId } from './session-ids';
import type { WindowsSpawnConfig } from './windows-spawn';
import type { GroupChatSpawn } from './types';

const LOG_CONTEXT = '[GroupChatSpawn]';

// The lineage a turn is admitted under (MRC-07-05): a group chat turn is a CHILD
// of its room, as a dispatched turn is of the operation that dispatched it. The
// room is the run every turn is parented under and the first principal on the
// chain; the process id (room, role, participant, B15) is the turn's request,
// attempt and link. Both hosts derive it alike (the desktop's sink over the room
// record, the headless runner directly), nothing here mints a workflow, a fence
// or a policy generation, and the admitting host meets it with its own standing.

/** The run id of a room: what every turn in it is parented under, and the service on its chain. */
export const groupChatRoomRunId = (chatId: string): string => `group-chat:${chatId}`;

/** The chat a group chat process id belongs to, or null for an id that is not a room's (a consult). */
export function groupChatIdOf(processId: string): string | null {
	return (
		parseModeratorSessionId(processId) ?? parseParticipantSessionId(processId)?.groupChatId ?? null
	);
}

/**
 * The room as the operation its turns are children of. A lineage, not a verified context: the
 * installation, origin and actor are the admitting host's own, and `policyRevision` is null
 * because a room claims no generation (the host admits under its current one).
 */
export function groupChatRoomContext(chatId: string): ManagedDelegationContext {
	const runId = groupChatRoomRunId(chatId);
	return {
		contractVersion: MANAGED_CONTRACT_VERSION,
		identity: {
			requestId: runId,
			idempotencyKey: runId,
			attemptId: runId,
			runId,
			rootRunId: runId,
			parentRunId: null,
		},
		traceId: runId,
		workflow: null,
		delegation: { chain: [{ kind: 'service', id: runId }], grantRef: null },
		policyRevision: null,
	};
}

/**
 * The context one turn is bound under: the record the spawn carries (a consult's, derived by the
 * asking operation's host), else the room's child for a moderator, participant, synthesis or
 * recovery turn, with the process id as the child's request, attempt and link. Null for a turn
 * that carries no record and belongs to no room (a consult the host derived nothing for).
 */
export function groupChatTurnContext(
	spawn: Pick<GroupChatSpawn, 'processId' | 'delegation'>
): ManagedDelegationContext | null {
	if (spawn.delegation) return spawn.delegation;
	const chatId = groupChatIdOf(spawn.processId);
	if (!chatId) return null;
	return childDelegationContext(groupChatRoomContext(chatId), {
		link: { kind: 'agent', id: spawn.processId },
		requestId: spawn.processId,
		attemptId: spawn.processId,
	});
}

/**
 * What the authority is told about a turn beside its final process spec: the provider, the model
 * the agent's configuration names, where it runs, and which working directory it may touch. The
 * same attribution on both hosts, so one turn has one snapshot wherever it is admitted.
 */
export function groupChatTurnAttribution(
	spawn: Pick<GroupChatSpawn, 'providerId' | 'agentConfigValues' | 'sshRemoteConfig' | 'isResume'>,
	cwd: string,
	account: string | null = null
): DispatchAttribution {
	const model = spawn.agentConfigValues?.model;
	const target: ManagedDispatchTarget = spawn.sshRemoteConfig?.enabled
		? { kind: 'ssh', remoteId: spawn.sshRemoteConfig.remoteId ?? '' }
		: { kind: 'local' };
	return {
		provider: spawn.providerId,
		model: typeof model === 'string' && model !== '' ? model : null,
		account,
		target,
		resourceIds: [`dir:${cwd}`],
		operation: spawn.isResume ? 'resume' : 'start',
	};
}

/** What the host contributes to preparing a spawn. */
export interface GroupChatSpawnDeps {
	/** Where the SSH remotes are, or null when the host has none. Required when a spawn names a remote. */
	sshStore: SshRemoteSettingsStore | null;
	/** Decides the Claude token source (the maestro-p TUI or `claude --print`) for one spawn. */
	resolveClaudeSpawnMode(
		input: Omit<ResolveClaudeSpawnModeCoreInput, 'agent'> & { agent: GroupChatSpawn['agent'] }
	): ClaudeSpawnDecision;
	/**
	 * Warm the remote maestro-p probe BEFORE the decision is made, so a remote TUI selection falls
	 * back to the API instead of exiting 127 when maestro-p is not installed there. A host with no
	 * probe cache leaves it out; the decision then stays optimistic.
	 */
	probeRemoteMaestroP?(remote: NonNullable<SshRemoteResolveResult['config']>): Promise<unknown>;
	/** The Windows shell and stdin choices, with the host's custom shell path applied. */
	windowsSpawnConfig(agentId: string, ssh: GroupChatSpawn['sshRemoteConfig']): WindowsSpawnConfig;
	/** Starts the turn clock for a process id, at the one choke point every turn shape goes through. */
	beginTurn(processId: string): void;
	/**
	 * Where a local maestro-p turn opens its steering socket, keyed by process id, so the host can
	 * type a user message into the running turn (group chat steering). A host that cannot steer
	 * leaves it out and the turn opens no channel.
	 */
	steeringSocketPath?(processId: string): string;
}

/** The process a turn starts, in the fields both hosts read. */
export interface PreparedGroupChatSpawn {
	processId: string;
	providerId: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	/** Private final file plan; remote artifacts must never reach the local materializer. */
	promptDelivery?: Extract<PromptDelivery, { via: 'file' }>;
	/** Remote cleanup ownership, passed to the existing PID/signal owner. */
	promptArtifactPath?: string;
	customEnvVars?: Record<string, string>;
	/** A read-only turn (moderator, synthesis, a read-only delegation). */
	readOnlyMode: boolean;
	contextWindow: number;
	promptArgs?: (prompt: string) => string[];
	noPromptSeparator?: boolean;
	/** Windows shell, stdin, and SSH script choices. */
	shell?: string;
	runInShell?: boolean;
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	sshStdinScript?: string;
	sshRemoteCommand?: string;
}

/**
 * Decide how one turn starts: the SSH wrap, the Claude token source, the Windows shell. Throws
 * when the agent is set to run on an SSH remote that cannot be used, never degrading to a local
 * run against the remote's directory.
 */
export async function prepareGroupChatSpawn(
	spawn: GroupChatSpawn &
		Pick<
			AgentLaunchInput,
			| 'remoteCommand'
			| 'promptBlocks'
			| 'embeddedImageSupport'
			| 'hasImages'
			| 'promptFileDestination'
		>,
	deps: GroupChatSpawnDeps
): Promise<PreparedGroupChatSpawn> {
	const {
		processId,
		providerId,
		agent,
		args,
		cwd,
		prompt,
		customEnvVars,
		agentConfigValues,
		sshRemoteConfig,
		readOnlyMode = false,
		debugLabel,
	} = spawn;
	const { sshStore } = deps;

	const baseCommand = spawn.command ?? agent.path ?? agent.command;

	let spawnCommand = baseCommand;
	let spawnArgs = args;
	let spawnCwd = cwd;
	let spawnPrompt: string | undefined = prompt;
	let spawnEnvVars = customEnvVars;
	let spawnSshStdinScript: string | undefined;
	let spawnSshRemoteCommand: string | undefined;
	let promptArtifactPath: string | undefined;
	let fileDelivery: Extract<PromptDelivery, { via: 'file' }> | undefined;

	// Ordered blocks must already include composed text and replace prompt.
	// Resolve the exact composed input before asynchronous preparation. This only
	// chooses private bytes and a fresh name; the admitted sink owns every write.
	if (agent.promptFile || spawn.promptBlocks !== undefined) {
		const remote = sshRemoteConfig?.enabled
			? sshStore && getSshRemoteConfig(sshStore, { sessionSshConfig: sshRemoteConfig }).config
			: undefined;
		if (sshRemoteConfig?.enabled && !remote) {
			throw new Error(sshUnresolvedRemoteMessage(sshRemoteConfig));
		}
		const destination =
			spawn.promptFileDestination ??
			(remote && agent.promptFile
				? newRemotePromptFileDestination(remote.id, agent.promptFile.format)
				: selectPromptFileDestination(agent, undefined));
		const delivery = resolvePromptDelivery({
			agent,
			prompt,
			args,
			promptBlocks: spawn.promptBlocks,
			embeddedImageSupport: spawn.embeddedImageSupport,
			hasImages: spawn.hasImages,
			promptFileDestination: destination,
			sshRemote: !!remote,
			sshRemoteId: remote?.id,
			// Explicit files take precedence on every platform; Windows legacy
			// delivery still comes from the host collaborator below.
			isWindowsHost: false,
		});
		if (delivery.via === 'refused') throw new Error(delivery.error);
		if (delivery.via === 'file') {
			fileDelivery = delivery;
			spawnArgs = [...args, ...delivery.args];
			spawnPrompt = undefined;
		}
	}

	const fileArgs = fileDelivery ? spawnArgs : undefined;

	// Over SSH, warm the remote maestro-p probe BEFORE resolving so a remote TUI
	// selection falls back to API instead of exiting 127 when maestro-p isn't
	// installed on the remote (the resolver reads this from the cache).
	if (sshRemoteConfig?.enabled && sshStore && deps.probeRemoteMaestroP) {
		const sshRemote = getSshRemoteConfig(sshStore, {
			sessionSshConfig: sshRemoteConfig,
		}).config;
		if (sshRemote) {
			await deps.probeRemoteMaestroP(sshRemote);
		}
	}

	// Resolve the Claude token source (maestro-p TUI vs `claude --print`) and,
	// for the interactive/dynamic case, rewrite the spawn to run maestro-p via
	// process.execPath. The resolver returns API for non-Claude agents and SSH
	// spawns, so this is a no-op outside the local Claude Code interactive path.
	// maestro-p reads the prompt the same way claude does (positional after the
	// args the process manager appends), so prompt delivery is unchanged.
	const tokenMode: ClaudeTokenMode = spawn.tokenMode ?? 'api';
	const claudeDecision = deps.resolveClaudeSpawnMode({
		agent,
		tokenMode,
		sshEnabled: !!sshRemoteConfig?.enabled,
		// Lets the resolver fall a remote TUI spawn back to API when the remote
		// has no maestro-p on its PATH (avoids exit 127).
		sshRemoteId: sshRemoteConfig?.remoteId ?? undefined,
		command: baseCommand,
		sessionCustomEnvVars: customEnvVars,
		maestroPPath: spawn.maestroPPath,
		now: new Date(),
	});
	if (claudeDecision.mode === 'interactive' && claudeDecision.maestroPBinPath) {
		const applied = applyClaudeSpawnDecision({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			command: baseCommand,
			args: spawnArgs,
			customEnvVars,
			maxWaitSeconds: spawn.maxWaitSeconds,
		});
		spawnCommand = applied.command;
		spawnArgs = applied.args;
		spawnEnvVars = applied.customEnvVars;
		// The socket is local, so a turn on an SSH remote never gets one.
		if (deps.steeringSocketPath && !sshRemoteConfig?.enabled) {
			spawnEnvVars = {
				...(spawnEnvVars ?? {}),
				[STEERING_SOCKET_ENV_VAR]: deps.steeringSocketPath(processId),
			};
		}
		if (debugLabel) {
			logger.debug(
				`[GroupChat:Debug] ${debugLabel} resolved to maestro-p (tokenMode=${spawn.tokenMode})`,
				LOG_CONTEXT
			);
		}
	}

	// Apply SSH wrapping if configured
	if (sshRemoteConfig?.enabled && !sshStore) {
		throw new Error(
			`SSH remote is enabled but sshStore is not available for ${debugLabel ?? processId}`
		);
	}
	if (sshStore && sshRemoteConfig?.enabled) {
		if (debugLabel) {
			logger.debug(`[GroupChat:Debug] Applying SSH wrapping for ${debugLabel}...`, LOG_CONTEXT);
		}
		// Claude interactive/dynamic over SSH runs maestro-p on the remote host
		// (must be on its PATH) to drive the remote TUI on the Max subscription.
		// Returns null for the API path, leaving the SSH config untouched.
		const remoteInteractive = buildRemoteInteractiveSpawn({
			decision: claudeDecision,
			interactiveModeArgs: agent.interactiveModeArgs,
			remoteClaudeBin: claudeDecision.claudeRealBinPath,
			maxWaitSeconds: spawn.maxWaitSeconds,
		});
		if (remoteInteractive && debugLabel) {
			logger.debug(
				`[GroupChat:Debug] ${debugLabel} resolved to remote maestro-p over SSH (tokenMode=${spawn.tokenMode})`,
				LOG_CONTEXT
			);
		}
		const remoteArgs = fileArgs ?? args;
		const sshWrapped = await wrapSpawnWithSsh(
			{
				command: baseCommand,
				args: remoteInteractive ? [...remoteInteractive.prependArgs, ...remoteArgs] : remoteArgs,
				cwd,
				prompt: spawnPrompt,
				...(fileDelivery ? { promptArtifact: fileDelivery.artifact } : {}),
				customEnvVars: remoteInteractive
					? { ...(customEnvVars ?? {}), ...remoteInteractive.env }
					: customEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				agentBinaryName: remoteInteractive
					? remoteInteractive.command
					: (spawn.remoteCommand ?? agent.binaryName),
			},
			sshRemoteConfig,
			sshStore
		).catch((error: unknown) => {
			if (fileDelivery) throw new Error('Remote prompt preparation unavailable.');
			throw error;
		});
		// wrapSpawnWithSsh quietly hands back the unmodified local config when the
		// remote cannot be resolved. Taking it would run this agent on the user's
		// own machine against the REMOTE's cwd - the participant would either fail
		// on a missing directory or, worse, succeed against the wrong files. The
		// user opted into a remote host, so fail loudly instead of degrading.
		if (!sshWrapped.sshRemoteUsed) {
			throw new Error(sshUnresolvedRemoteMessage(sshRemoteConfig));
		}
		spawnCommand = sshWrapped.command;
		spawnArgs = sshWrapped.args;
		spawnCwd = sshWrapped.cwd;
		spawnPrompt = sshWrapped.prompt;
		spawnEnvVars = sshWrapped.customEnvVars;
		spawnSshStdinScript = sshWrapped.sshStdinScript;
		spawnSshRemoteCommand = sshWrapped.sshRemoteCommand;
		promptArtifactPath = sshWrapped.promptArtifactPath;
		if (debugLabel) {
			logger.debug(
				`[GroupChat:Debug] SSH remote used for ${debugLabel}: ${sshWrapped.sshRemoteUsed.name}`,
				LOG_CONTEXT
			);
		}
	}

	// Get Windows-specific spawn config (shell, stdin mode) - skipped for SSH
	const winConfig = deps.windowsSpawnConfig(providerId, sshRemoteConfig ?? undefined);
	if (winConfig.shell && debugLabel) {
		logger.debug(
			`[GroupChat:Debug] Windows shell config for ${debugLabel}: ${winConfig.shell}`,
			LOG_CONTEXT
		);
	}

	// Start the clock at the single choke point every turn shape goes through
	// (moderator, participant, synthesis, recovery), so a new spawn site is
	// measured without having to remember to opt in.
	deps.beginTurn(processId);

	return {
		processId,
		providerId,
		cwd: spawnCwd,
		command: spawnCommand,
		args: spawnArgs,
		prompt: spawnPrompt,
		...(fileDelivery ? { promptDelivery: fileDelivery } : {}),
		...(promptArtifactPath !== undefined ? { promptArtifactPath } : {}),
		customEnvVars: spawnEnvVars,
		readOnlyMode,
		contextWindow: getContextWindowValue(agent, agentConfigValues ?? {}),
		promptArgs: agent.promptArgs,
		noPromptSeparator: agent.noPromptSeparator,
		shell: winConfig.shell,
		runInShell: winConfig.runInShell,
		sendPromptViaStdin: fileDelivery ? false : winConfig.sendPromptViaStdin,
		sendPromptViaStdinRaw: fileDelivery ? false : winConfig.sendPromptViaStdinRaw,
		sshStdinScript: spawnSshStdinScript,
		sshRemoteCommand: spawnSshRemoteCommand,
	};
}

export type { WindowsSpawnConfig };
