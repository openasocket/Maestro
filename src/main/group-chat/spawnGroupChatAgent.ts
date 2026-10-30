/**
 * @file spawnGroupChatAgent.ts
 * @description Centralized spawn helper for Group Chat agent processes.
 *
 * Every spawn site in the Group Chat router (moderator, participant, synthesis,
 * recovery) follows the same pattern: maybe SSH-wrap the command, apply
 * Windows-specific shell/stdin config, then call `processManager.spawn`. The first two
 * steps are `prepareGroupChatSpawn` in the library (the headless runtime runs the same
 * ones); this helper supplies the desktop's collaborators and hands the result to the
 * `ProcessManager`.
 *
 * Under management the turn is admitted at the sink (`ProcessManager.spawnAdmitted`,
 * MRC-07-05) as the CHILD of the operation it belongs to: the room for a moderator,
 * participant, synthesis or recovery turn (`groupChatRoomContext`), or the asking
 * operation's record for a consult (`dispatchedBy`, MRC2-02-03). The process id is the
 * child's request, attempt and link, the same derivation the headless runner binds for a
 * room turn and the sink's own for a dispatched one (`dispatchedChildContext`), and the
 * child record is stamped on the process so what the agent itself dispatches carries
 * the chain one link deeper. A standalone desktop spawns as before.
 */

import { IProcessManager } from './group-chat-moderator';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { getWindowsSpawnConfig } from './group-chat-config';
import { beginGroupChatTurn } from './group-chat-turn-metrics';
import type { AgentConfig } from '../agents/definitions';
import type { AgentSshRemoteConfig } from '../../shared/types';
import { resolveClaudeSpawnMode } from '../agents/resolveClaudeSpawnMode';
import type { ClaudeTokenMode } from '../../shared/claudeTokenMode';
import type { AgentLaunchInput } from '../../shared/maestro-lib/launch/launch-plan';
import { argsResumeSession, resumeIdFromArgs } from '../../shared/maestro-lib/run/pipe-spawn';
import {
	groupChatIdOf,
	groupChatRoomContext,
	groupChatTurnContext,
	prepareGroupChatSpawn,
} from '../../shared/maestro-lib/groupchat/spawn';
import {
	delegationContextEnv,
	type ManagedDelegationContext,
} from '../../shared/maestro-lib/managed/delegation';
import type { ManagedDenialCode } from '../../shared/maestro-lib/managed/types';
import { applySystemPromptDelivery } from '../utils/system-prompt-delivery';
import { dispatchedChildContext } from '../process-manager/ProcessManager';
import { steeringSocketPathFor } from '../process-manager/steering-client';
import type {
	DispatchedSpawnIds,
	ProcessConfig,
	ProcessSpawnActor,
} from '../process-manager/types';

/**
 * What the sink binds a turn's lineage from: the context of the operation the turn is a
 * child of (`ProcessConfig.delegation`) and the request and attempt the child is minted as
 * (`ProcessConfig.dispatchedAs`). The sink derives the child record from the two
 * (`dispatchedChildContext`), and the process is stamped with that same record.
 */
export interface GroupChatSpawnLineage {
	delegation: ManagedDelegationContext;
	dispatchedAs: DispatchedSpawnIds;
}

export interface SpawnGroupChatAgentConfig extends Pick<
	AgentLaunchInput,
	'remoteCommand' | 'promptBlocks' | 'embeddedImageSupport' | 'hasImages' | 'promptFileDestination'
> {
	/** Stable session id for the process manager */
	sessionId: string;
	/** Agent id (e.g. 'claude-code', 'codex') - used as `toolType` */
	agentId: string;
	/** Resolved agent definition */
	agent: AgentConfig;
	/** Base command - defaults to agent.path ?? agent.command */
	command?: string;
	/** Fully-formed args (after buildAgentArgs + any extras) */
	args: string[];
	/** Working directory */
	cwd: string;
	/** Prompt to send (via CLI arg or stdin) */
	prompt?: string;
	/** Resolved custom env vars to inject */
	customEnvVars?: Record<string, string>;
	/** Agent config values (used for context window resolution) */
	agentConfigValues?: Record<string, any>;
	/** SSH remote config (from chat moderator or matching session); null/undefined = local */
	sshRemoteConfig?: AgentSshRemoteConfig | null;
	/** SSH settings store (required when sshRemoteConfig is active) */
	sshStore?: SshRemoteSettingsStore | null;
	/**
	 * Claude token source for this agent (Claude Code only). Drives the
	 * maestro-p TUI vs `claude --print` choice. Ignored for non-Claude agents
	 * and SSH spawns (the TUI wrapper needs the local claude binary).
	 */
	tokenMode?: ClaudeTokenMode;
	/** Optional per-agent maestro-p script override. */
	maestroPPath?: string;
	/** Process manager to invoke */
	processManager: IProcessManager;
	/** Whether the spawned process is read-only (moderator / synthesis = true) */
	readOnlyMode?: boolean;
	/** Optional label for debug logs (e.g. 'moderator', 'participant: Alice') */
	debugLabel?: string;
	/**
	 * Overall idle budget for a maestro-p (interactive/dynamic) run, in seconds,
	 * forwarded as `--max-wait`. Group Chat is a background/orchestrated caller, so
	 * it MUST pass this to match the router's own supervising timeout - otherwise
	 * maestro-p falls back to its 300s idle default and silently kills a
	 * still-working moderator/participant whose JSONL output stalls past 300s
	 * (long tool runs or extended thinking), even though the router would wait the
	 * full 10 minutes. Same contract Cue follows. Ignored on the API path.
	 */
	maxWaitSeconds?: number;
	/**
	 * Maestro system prompt for this agent. Delivered by
	 * `applySystemPromptDelivery`, exactly like a tab spawn: the native flag
	 * (temp file on Windows local) when the agent supports it, otherwise embedded
	 * into `prompt`, and not re-embedded when `isResume`.
	 */
	appendSystemPrompt?: string;
	/** True when `args` resume an existing provider session. */
	isResume?: boolean;
	/** Provider session identity before SSH wrapping hides the original resume arguments. */
	agentSessionId?: ProcessConfig['agentSessionId'];
	/** Who asked for the turn, as the sink binds it. Default: this process (the keyboard). */
	actor?: ProcessSpawnActor;
	/**
	 * The operation this turn is the child of and the ids the child is minted as, for a turn
	 * that belongs to no room: a consult, whose asking operation the router resolved
	 * (`startCrossAgentRequest`, MRC2-02-03). Handed to the sink as it is, which binds the
	 * consult as that operation's child under its own standing and stamps the derived record
	 * on the process. A room turn names none: its lineage is the room's
	 * (`groupChatSpawnLineage`). Absent on a turn that belongs to no room, the sink admits a
	 * chat turn of its own, as before.
	 */
	dispatchedBy?: GroupChatSpawnLineage;
}

export interface SpawnGroupChatAgentResult {
	pid: number;
	success: boolean;
	error?: string;
	/** Set when a managed desktop refused the turn at the sink. Nothing started. */
	managed?: { state: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode };
}

/**
 * The lineage a desktop group chat turn is spawned with: the room as the operation that
 * dispatched it (`ProcessConfig.delegation`) and the process id as the child's own request and
 * attempt (`dispatchedAs`), so `ProcessManager.admitSpawn` derives exactly the child the headless
 * runner binds (`groupChatTurnContext`: link `agent <process id>`, parented under the room).
 * Null for a process that is no room's (a consult), which the sink admits as a chat turn
 * unless the caller names the asking operation (`dispatchedBy`).
 */
export function groupChatSpawnLineage(sessionId: string): GroupChatSpawnLineage | null {
	const chatId = groupChatIdOf(sessionId);
	if (!chatId) return null;
	return {
		delegation: groupChatRoomContext(chatId),
		dispatchedAs: { requestId: sessionId, attemptId: sessionId },
	};
}

/**
 * Spawn a Group Chat agent process with SSH + Windows shell handling applied.
 *
 * The helper:
 * 1. Prepares the spawn in the library: optional SSH wrapping (when `sshRemoteConfig.enabled`),
 *    the Claude token source, and the Windows shell/stdin config (skipped for SSH)
 * 2. Calls `processManager.spawn` with the prepared config
 *
 * All four legacy call sites (moderator, participant, synthesis, recovery) used
 * this exact sequence with only cosmetic differences - see git history for the
 * inline versions this replaces.
 */
export async function spawnGroupChatAgent(
	config: SpawnGroupChatAgentConfig
): Promise<SpawnGroupChatAgentResult> {
	// Snapshot private input before system delivery or SSH preparation yields.
	config = {
		...config,
		agent: {
			...config.agent,
			capabilities: config.agent.capabilities ? { ...config.agent.capabilities } : undefined,
			promptFile: config.agent.promptFile
				? {
						...config.agent.promptFile,
						exclusivePromptFlags: [...config.agent.promptFile.exclusivePromptFlags],
					}
				: undefined,
		},
		args: [...config.args],
		customEnvVars: config.customEnvVars ? { ...config.customEnvVars } : undefined,
		agentConfigValues: config.agentConfigValues ? { ...config.agentConfigValues } : undefined,
		sshRemoteConfig: config.sshRemoteConfig
			? { ...config.sshRemoteConfig }
			: config.sshRemoteConfig,
		promptFileDestination: config.promptFileDestination
			? { ...config.promptFileDestination }
			: undefined,
		embeddedImageSupport: config.embeddedImageSupport
			? {
					...config.embeddedImageSupport,
					mimeTypes: Array.isArray(config.embeddedImageSupport.mimeTypes)
						? [...config.embeddedImageSupport.mimeTypes]
						: config.embeddedImageSupport.mimeTypes,
				}
			: undefined,
	};
	const { processManager, sshStore } = config;
	let promptBlocks = Array.isArray(config.promptBlocks)
		? config.promptBlocks.map((block) => ({ ...block }))
		: config.promptBlocks;
	if (promptBlocks !== undefined && config.prompt !== undefined) {
		throw new Error('Supply either prompt text or ordered content blocks, not both.');
	}
	const argumentSessionId = resumeIdFromArgs(config.args);
	if (
		config.agent.promptFile &&
		config.agentSessionId !== undefined &&
		config.agentSessionId !== argumentSessionId
	) {
		throw new Error('Prompt-file resume identity does not match its launch arguments.');
	}
	const agentSessionId = config.agentSessionId ?? argumentSessionId;
	const isResume =
		!!config.isResume ||
		!!agentSessionId ||
		(!!config.agent.promptFile && argsResumeSession(config.args));
	if (config.agent.promptFile && isResume && !agentSessionId) {
		throw new Error('Prompt-file resume requires an explicit provider session identity.');
	}
	// Apply the canonical system placement once to the first text block; every
	// other block keeps its order and bytes. Image-only turns can gain a system
	// text block, but malformed/empty blocks still reach canonical validation.
	const textIndex = Array.isArray(promptBlocks)
		? promptBlocks.findIndex((block) => block?.type === 'text' && typeof block.text === 'string')
		: -1;
	const textBlock = promptBlocks?.[textIndex];

	// The lineage: what the sink binds the turn as, and what its process is stamped with, so what
	// the agent itself asks or dispatches from its shell carries the chain one link deeper. Stamped
	// BEFORE the SSH wrap, so it reaches the remote agent and not only the ssh client. A room turn
	// uses the same derivation as the headless runner's, so one turn has one record on either
	// host; a consult carries the asking operation's record and is derived as the sink derives a
	// dispatched turn, so the stamp and the admission agree on the one record.
	const lineage = config.dispatchedBy ?? groupChatSpawnLineage(config.sessionId);
	const child = config.dispatchedBy
		? dispatchedChildContext({ sessionId: config.sessionId, ...config.dispatchedBy })
		: groupChatTurnContext({ processId: config.sessionId });
	const customEnvVars = child
		? { ...(config.customEnvVars ?? {}), ...delegationContextEnv(child) }
		: config.customEnvVars;

	// System prompt first, so every later step (maestro-p rewrite, SSH wrap,
	// Windows stdin) sees the final args and prompt.
	const delivered = await applySystemPromptDelivery({
		args: config.args,
		prompt:
			promptBlocks === undefined
				? config.prompt
				: textBlock?.type === 'text'
					? textBlock.text
					: undefined,
		systemPrompt: config.appendSystemPrompt,
		supportsAppendSystemPrompt: !!config.agent.capabilities?.supportsAppendSystemPrompt,
		isResume,
		isSshSession: !!config.sshRemoteConfig?.enabled,
		sessionId: config.sessionId,
		agentId: config.agentId,
		logContext: '[GroupChat:Spawn]',
	}).catch((error: unknown) => {
		if (config.agent.promptFile || promptBlocks !== undefined) {
			throw new Error('Prompt-file system preparation unavailable.');
		}
		throw error;
	});
	if (Array.isArray(promptBlocks) && promptBlocks.length > 0 && delivered.prompt !== undefined) {
		promptBlocks =
			textIndex >= 0
				? promptBlocks.map((block, index) =>
						index === textIndex ? { type: 'text', text: delivered.prompt! } : block
					)
				: [{ type: 'text', text: delivered.prompt }, ...promptBlocks];
	}

	const prepared = await prepareGroupChatSpawn(
		{
			processId: config.sessionId,
			providerId: config.agentId,
			agent: config.agent,
			command: config.command,
			remoteCommand: config.remoteCommand,
			args: delivered.args,
			cwd: config.cwd,
			prompt: promptBlocks === undefined ? delivered.prompt : undefined,
			promptBlocks,
			embeddedImageSupport: config.embeddedImageSupport,
			hasImages: config.hasImages,
			promptFileDestination: config.promptFileDestination,
			customEnvVars,
			agentConfigValues: config.agentConfigValues,
			sshRemoteConfig: config.sshRemoteConfig,
			tokenMode: config.tokenMode,
			maestroPPath: config.maestroPPath,
			readOnlyMode: config.readOnlyMode,
			debugLabel: config.debugLabel,
			maxWaitSeconds: config.maxWaitSeconds,
			isResume,
		},
		{
			sshStore: sshStore ?? null,
			resolveClaudeSpawnMode,
			probeRemoteMaestroP: ensureRemoteMaestroPProbed,
			windowsSpawnConfig: getWindowsSpawnConfig,
			beginTurn: beginGroupChatTurn,
			steeringSocketPath: steeringSocketPathFor,
		}
	).catch((error: unknown) => {
		if (config.agent.promptFile || promptBlocks !== undefined) {
			throw new Error('Prompt-file group chat preparation unavailable.');
		}
		throw error;
	});

	const promptArtifact = prepared.promptDelivery?.artifact;
	if (
		promptArtifact?.owner === 'remote' &&
		(!config.sshRemoteConfig?.enabled ||
			promptArtifact.sshRemoteId !== config.sshRemoteConfig.remoteId ||
			prepared.promptArtifactPath !== promptArtifact.path)
	) {
		throw new Error('Prompt-file delivery does not match its host plan.');
	}
	const spawnConfig: ProcessConfig = {
		sessionId: prepared.processId,
		toolType: prepared.providerId,
		cwd: prepared.cwd,
		command: prepared.command,
		args: prepared.args,
		readOnlyMode: prepared.readOnlyMode,
		prompt: promptArtifact ? undefined : prepared.prompt,
		...(promptArtifact ? { promptArtifact } : {}),
		...(promptArtifact?.owner === 'remote' ? { sshRemoteId: promptArtifact.sshRemoteId } : {}),
		...(agentSessionId ? { agentSessionId } : {}),
		contextWindow: prepared.contextWindow,
		customEnvVars: prepared.customEnvVars,
		promptArgs: prepared.promptArgs,
		noPromptSeparator: prepared.noPromptSeparator,
		shell: prepared.shell,
		runInShell: prepared.runInShell,
		sendPromptViaStdin: promptArtifact ? false : prepared.sendPromptViaStdin,
		sendPromptViaStdinRaw: promptArtifact ? false : prepared.sendPromptViaStdinRaw,
		sshStdinScript: prepared.sshStdinScript,
		sshRemoteCommand: prepared.sshRemoteCommand,
		...(lineage ?? {}),
	};

	// Admitted at the sink for the actor named: a managed desktop spawns nothing without an
	// admission (and binds the room's child, never a fresh chat turn of the room); a standalone
	// desktop, and a process manager double with no admission path, spawn as before.
	if (processManager.spawnAdmitted) {
		const result = await processManager.spawnAdmitted(
			spawnConfig,
			config.actor ?? { peer: 'in-process' }
		);
		return {
			pid: result.pid,
			success: result.success,
			...(result.error ? { error: result.error } : {}),
			...(result.managed ? { managed: result.managed } : {}),
		};
	}
	return processManager.spawn(spawnConfig);
}
