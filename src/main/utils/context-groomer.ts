/**
 * Context Grooming Utility
 *
 * Shared utility for context summarization/grooming operations.
 * Used by both the context merge handlers and group chat reset functionality.
 *
 * This module provides a consistent way to spawn a batch-mode agent process
 * with a prompt and collect the response. It handles:
 * - Spawning the agent with proper batch mode args
 * - SSH remote execution when the session is configured for it
 * - Collecting response data with idle timeout detection
 * - Overall timeout for long-running operations
 * - Proper cleanup on completion or error
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import { buildAgentArgs, applyAgentConfigOverrides } from './agent-args';
import { wrapSpawnWithSsh, sshUnresolvedRemoteMessage } from './ssh-spawn-wrapper';
import type { SshRemoteConfig } from '../../shared/types';
import { isWindows } from '../../shared/platformDetection';
import { parseEffortRejection } from '../../shared/effortRejection';
import type { AgentDetector } from '../agents';
import {
	resolveClaudeSpawnMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	type ClaudeSpawnDecision,
} from '../agents/resolveClaudeSpawnMode';
import { ensureRemoteMaestroPProbed } from '../agents/probeRemoteMaestroP';
import { getSshRemoteConfig, type SshRemoteSettingsStore } from './ssh-remote-resolver';
import { getClaudeTokenMode, type ClaudeTokenSourceFields } from '../../shared/claudeTokenMode';
import {
	boundUtilityRoute,
	spawnOriginOf,
	type ProcessSpawnActor,
	type ProcessSpawnAuthorityPort,
	type UtilityTurnLineage,
	type ProcessConfig,
} from '../process-manager/types';
import {
	resolvePromptDelivery,
	selectPromptFileDestination,
	type PromptDelivery,
} from '../../shared/maestro-lib/launch/prompt-delivery';
import { newRemotePromptFileDestination } from '../../shared/maestro-lib/launch/ssh-command-builder';
import { argsResumeSession, resumeIdFromArgs } from '../../shared/maestro-lib/run/pipe-spawn';
import type { DispatchPurpose } from '../../shared/maestro-lib/managed/authority';
import type { ManagedDenialCode, ManagedOrigin } from '../../shared/maestro-lib/managed/types';

const LOG_CONTEXT = '[ContextGroomer]';

/** The spawn config a grooming turn hands the process manager. */
export interface GroomingSpawnConfig extends Pick<
	ProcessConfig,
	'promptArtifact' | 'agentSessionId'
> {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	prompt?: string;
	promptArgs?: (prompt: string) => string[];
	noPromptSeparator?: boolean;
	// Send prompt as stream-json via stdin (for agents supporting it, e.g. with images)
	sendPromptViaStdin?: boolean;
	// Send prompt as raw text via stdin (used on Windows to avoid command-line length limits)
	sendPromptViaStdinRaw?: boolean;
	// Script piped to the remote shell's stdin for SSH execution (built by wrapSpawnWithSsh)
	sshStdinScript?: string;
	// Human-readable remote agent invocation (shown in Process Details)
	sshRemoteCommand?: string;
	// Resolved SSH remote identity, for Process Details / logging
	sshRemoteId?: string;
	sshRemoteHost?: string;
	// Custom environment variables (resolved via applyAgentConfigOverrides)
	customEnvVars?: Record<string, string>;
	/** Always `utility`: a grooming turn is Maestro's own, run beside a conversation (MRC2-02-02). */
	purpose?: DispatchPurpose;
	/** Which surface raised the turn; defaulted from the actor (`spawnOriginOf`). */
	origin?: ManagedOrigin;
	/** The agent and tab the turn serves, when the caller said. */
	utilityOf?: UtilityTurnLineage;
}

/** What an admitted grooming spawn came to (`SpawnResult`, narrowed). */
export interface GroomingSpawnOutcome {
	pid: number;
	success: boolean;
	error?: string;
	managed?: { state: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode };
}

/**
 * Minimal process manager interface required for context grooming.
 * This is compatible with both ProcessManager and GenericProcessManager.
 *
 * `spawnAdmitted` and `managedPort` are the real manager's admission path
 * (MRC2-02-02): a grooming turn goes through `spawnAdmitted` when the
 * manager has one, so a managed desktop spawns nothing without an admission
 * and a standalone one spawns as before; a double with only `spawn` is
 * standalone by construction and spawns as it always did.
 */
export interface GroomingProcessManager {
	spawn(config: GroomingSpawnConfig): { pid: number; success?: boolean } | null;
	spawnAdmitted?(
		config: GroomingSpawnConfig,
		actor: ProcessSpawnActor
	): Promise<GroomingSpawnOutcome>;
	managedPort?(): Pick<ProcessSpawnAuthorityPort, 'standing' | 'routeCeiling'> | null;
	on(event: string, handler: (...args: unknown[]) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
	kill(sessionId: string): void;
}

/**
 * Default timeout for grooming operations (5 minutes)
 */
const DEFAULT_GROOMING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Idle timeout - if no data for this long and we have content, consider done
 */
const IDLE_TIMEOUT_MS = 5000;

/**
 * Minimum response length to consider valid for idle timeout
 */
const MIN_RESPONSE_LENGTH = 100;

/**
 * Track active grooming sessions for debugging/monitoring and cancellation
 */
const activeGroomingSessions = new Map<
	string,
	{
		groomerSessionId: string;
		startTime: number;
		cancel?: () => void;
	}
>();

/**
 * Cancel all active grooming sessions.
 * Called when user cancels a summarization operation.
 */
export function cancelAllGroomingSessions(): void {
	logger.info('Cancelling all grooming sessions', LOG_CONTEXT, {
		count: activeGroomingSessions.size,
	});

	for (const [sessionId, session] of activeGroomingSessions) {
		if (session.cancel) {
			logger.debug('Cancelling grooming session', LOG_CONTEXT, { sessionId });
			session.cancel();
		}
	}
}

/**
 * SSH remote configuration for grooming.
 */
export interface GroomingSshRemoteConfig {
	/** Whether SSH remote execution is enabled */
	enabled: boolean;
	/** The SSH remote ID (from settings) */
	remoteId: string | null;
	/** Optional working directory override on the remote host */
	workingDirOverride?: string;
}

/**
 * Progress update emitted during grooming operations
 */
export interface GroomProgressUpdate {
	/** Number of data chunks received so far */
	chunkCount: number;
	/** Total bytes of response collected so far */
	bytesReceived: number;
	/** Elapsed time in ms since grooming started */
	elapsedMs: number;
}

/**
 * Options for grooming context
 */
export interface GroomContextOptions {
	/** Project root / working directory */
	projectRoot: string;
	/** Agent type to use (e.g., 'claude-code') */
	agentType: string;
	/** The prompt to send to the agent */
	prompt: string;
	/** Optional session ID to resume (for context access) */
	agentSessionId?: string;
	/** Use read-only mode (default: false) */
	readOnlyMode?: boolean;
	/** Optional model ID override (e.g., when using a utility agent) */
	modelId?: string;
	/** Custom timeout in ms (default: 5 minutes) */
	timeoutMs?: number;
	/** SSH remote config for running grooming on a remote host */
	sessionSshRemoteConfig?: GroomingSshRemoteConfig;
	/**
	 * SSH settings store used to resolve `sessionSshRemoteConfig.remoteId`.
	 * REQUIRED whenever `sessionSshRemoteConfig.enabled` is true - grooming
	 * throws rather than silently running the prompt on the local machine.
	 */
	sshStore?: SshRemoteSettingsStore;
	/** Custom path to the agent binary */
	sessionCustomPath?: string;
	/** Custom arguments for the agent */
	sessionCustomArgs?: string;
	/** Custom environment variables for the agent */
	sessionCustomEnvVars?: Record<string, string>;
	/**
	 * Model the caller wants this one-shot turn to run under, resolved the same
	 * way a chat spawn resolves it (tab override, then agent override). Left
	 * undefined the agent's own default applies, which is what every caller did
	 * before AI command mode needed to honour the tab's current model.
	 */
	sessionCustomModel?: string;
	/** Effort / reasoning level for this turn. Same resolution as the model. */
	sessionCustomEffort?: string;
	/**
	 * Strip the agent's tool access for this turn (claude: `--tools ""`).
	 *
	 * Set it for pure text transforms. Without it, a task-shaped prompt makes the
	 * model run a full agentic session - reading files, grepping - instead of
	 * answering, which blows the timeout and returns nothing. Agents that define
	 * no `noToolsArgs` are left untouched on legacy routes; an explicit prompt-file
	 * route refuses when it cannot enforce the requested restriction.
	 */
	disableTools?: boolean;
	/** Agent-level config values (from agent config store) for override resolution */
	agentConfigValues?: Record<string, any>;
	/**
	 * Claude token source of the agent this turn runs for (see
	 * getClaudeTokenSourceFields). Set it whenever the turn belongs to one agent,
	 * so an agent set to TUI runs this turn through maestro-p like its chat
	 * turns. Left undefined the turn runs `claude --print`, which is right for a
	 * caller with no owning agent (Director's Notes, a utility agent).
	 */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/** Optional callback for progress updates during grooming */
	onProgress?: (update: GroomProgressUpdate) => void;
	/**
	 * Who asked for this turn, as the transport that carried the request
	 * knows it (MRC2-02-02). The turn is admitted at the sink for this actor;
	 * left out, it is the desktop operator (`in-process`), which is what every
	 * IPC caller is. A web or CLI entry names its own.
	 */
	actor?: ProcessSpawnActor;
	/** Which surface raised the turn. Defaulted from the actor (`spawnOriginOf`). */
	origin?: ManagedOrigin;
	/**
	 * The agent and tab this turn serves, so the sink traces it beside the
	 * turns it was run for. A caller with no owning agent (Director's Notes)
	 * leaves it out and the turn is traced under its own `groomer-*` id.
	 */
	lineage?: UtilityTurnLineage;
}

/**
 * Result from grooming operation
 */
export interface GroomContextResult {
	/** The response text from the agent */
	response: string;
	/** Duration of the operation in ms */
	durationMs: number;
	/** Reason the operation completed */
	completionReason: string;
}

/**
 * Spawn a batch-mode agent process with a prompt and collect the response.
 *
 * This is the core grooming utility used for context summarization.
 * It handles spawning the agent, collecting output, and cleanup.
 *
 * @param options - Grooming options
 * @param processManager - The process manager instance
 * @param agentDetector - The agent detector instance
 * @returns Promise resolving to the grooming result
 */
export async function groomContext(
	options: GroomContextOptions,
	processManager: GroomingProcessManager,
	agentDetector: AgentDetector
): Promise<GroomContextResult> {
	let groomerSessionId = `groomer-${uuidv4()}`;
	const controller = new AbortController();
	activeGroomingSessions.set(groomerSessionId, {
		groomerSessionId,
		startTime: Date.now(),
		cancel: () => controller.abort(new Error('Grooming cancelled by user')),
	});
	try {
		return await groomContextOnce(
			options,
			processManager,
			agentDetector,
			groomerSessionId,
			controller.signal
		);
	} catch (error) {
		// Grok callers provide no automatic-hint provenance or validated distinct
		// fallback. Clearing this value can inherit the same refusal or silently
		// change an explicit selection. The process error listener still records it.
		if (options.agentType === 'grok' || controller.signal.aborted) throw error;

		// The provider refused the effort level this turn asked for (see
		// `shared/effortRejection.ts`). Callers pass an effort Maestro picked off
		// a static ladder for a throwaway turn, and a provider can retire a rung
		// without notice - so run it once more at the agent's own effort rather
		// than lose the summary. Only when an effort was actually sent, so a
		// refusal of the agent's own configured value cannot loop.
		const rejection =
			options.sessionCustomEffort !== undefined && options.sessionCustomEffort !== ''
				? parseEffortRejection(error instanceof Error ? error.message : String(error))
				: null;
		if (!rejection) throw error;

		logger.warn(
			'Grooming effort rejected by the provider; retrying at the agent default',
			LOG_CONTEXT,
			{ agentType: options.agentType, effort: options.sessionCustomEffort, ...rejection }
		);
		activeGroomingSessions.delete(groomerSessionId);
		groomerSessionId = `groomer-${uuidv4()}`;
		activeGroomingSessions.set(groomerSessionId, {
			groomerSessionId,
			startTime: Date.now(),
			cancel: () => controller.abort(new Error('Grooming cancelled by user')),
		});
		return await groomContextOnce(
			{ ...options, sessionCustomEffort: undefined },
			processManager,
			agentDetector,
			groomerSessionId,
			controller.signal
		);
	} finally {
		activeGroomingSessions.delete(groomerSessionId);
	}
}

async function groomContextOnce(
	options: GroomContextOptions,
	processManager: GroomingProcessManager,
	agentDetector: AgentDetector,
	groomerSessionId: string,
	signal: AbortSignal
): Promise<GroomContextResult> {
	// Hold the selected account and host across detector/probe/SSH awaits.
	const remotes = options.sessionSshRemoteConfig?.enabled
		? options.sshStore?.getSshRemotes().map((remote) => ({
				...remote,
				remoteEnv: remote.remoteEnv ? { ...remote.remoteEnv } : undefined,
				sshOptions: remote.sshOptions ? { ...remote.sshOptions } : undefined,
			}))
		: undefined;
	options = {
		...options,
		sessionSshRemoteConfig: options.sessionSshRemoteConfig
			? { ...options.sessionSshRemoteConfig }
			: undefined,
		sessionCustomEnvVars: options.sessionCustomEnvVars
			? { ...options.sessionCustomEnvVars }
			: undefined,
		agentConfigValues: options.agentConfigValues
			? {
					...options.agentConfigValues,
					customEnvVars: options.agentConfigValues.customEnvVars
						? { ...options.agentConfigValues.customEnvVars }
						: undefined,
				}
			: undefined,
		sshStore: remotes ? { getSshRemotes: () => remotes } : options.sshStore,
	};
	const {
		projectRoot,
		agentType,
		prompt,
		agentSessionId,
		readOnlyMode = false,
		modelId,
		timeoutMs = DEFAULT_GROOMING_TIMEOUT_MS,
		sessionSshRemoteConfig,
		sshStore,
		sessionCustomPath,
		sessionCustomArgs,
		sessionCustomEnvVars,
		sessionCustomModel,
		sessionCustomEffort,
		disableTools = false,
		agentConfigValues,
		claudeTokenSource,
		onProgress,
		actor = { peer: 'in-process' },
		origin = spawnOriginOf(actor),
		lineage,
	} = options;

	const startTime = Date.now();

	logger.info('Starting context grooming', LOG_CONTEXT, {
		groomerSessionId,
		projectRoot,
		agentType,
		promptLength: prompt.length,
		hasSessionId: !!agentSessionId,
		hasSshConfig: !!sessionSshRemoteConfig?.enabled,
		sshRemoteId: sessionSshRemoteConfig?.remoteId,
	});

	// Get agent configuration
	const agent = await agentDetector.getAgent(agentType);
	signal.throwIfAborted();
	if (!agent || !agent.available) {
		throw new Error(`Agent ${agentType} is not available`);
	}
	if (agent.promptFile && disableTools && !agent.noToolsArgs?.length) {
		throw new Error('Prompt-file grooming cannot enforce disabled tools.');
	}
	if (
		agent.promptFile &&
		readOnlyMode &&
		(!agent.readOnlyArgs?.length || agent.readOnlyCliEnforced === false)
	) {
		throw new Error('Prompt-file grooming cannot enforce read-only mode.');
	}

	// Build args using the unified buildAgentArgs utility
	const baseArgs = buildAgentArgs(agent, {
		baseArgs: agent.args || [],
		prompt: prompt,
		cwd: projectRoot,
		readOnlyMode,
		modelId,
		yoloMode: false,
		permissionMode: readOnlyMode ? 'readonly' : 'standard',
		forceBatchMode: !!agent.promptFile,
		agentSessionId,
	});

	// Apply agent config overrides (model, custom args, custom env vars)
	// This merges agent-level config with session-level overrides
	const configResolution = applyAgentConfigOverrides(agent, baseArgs, {
		agentConfigValues: agentConfigValues ?? {},
		sessionCustomArgs,
		sessionCustomEnvVars,
		sessionCustomModel,
		sessionCustomEffort,
		readOnlyMode,
	});
	const toolArgs =
		disableTools && agent.noToolsArgs?.length
			? [...configResolution.args, ...agent.noToolsArgs]
			: configResolution.args;

	// Under management the provider this utility turn resolved to (the utility
	// agent, else the session's), its model and its account are measured
	// against the route the policy pins for that provider, the same ceiling
	// the launch plan applies to a person's turn, read off the port's
	// `routeCeiling` seam and applied by `boundUtilityRoute` (MRC2-02-02). A
	// turn the policy routes elsewhere, or whose arguments or environment
	// route around the ceiling, is refused here with the reason, before any
	// side effect: the caller degrades to no name or no synopsis, never to a
	// turn on another provider or an unmanaged spawn. A host with no route
	// ceiling producer bounds nothing here (the admission below decides, as
	// before); a standalone host is unchanged.
	const managedPort = processManager.managedPort?.() ?? null;
	const standing = managedPort?.standing() ?? 'standalone';
	const bounded = boundUtilityRoute(
		{
			providerId: agent.id,
			args: toolArgs,
			customEnvVars: configResolution.effectiveCustomEnvVars,
			modelArgs: agent.modelArgs,
			target: sessionSshRemoteConfig?.enabled ? 'ssh' : 'local',
		},
		standing === 'managed' ? (managedPort?.routeCeiling?.(agent.id) ?? null) : null,
		standing
	);
	if (!bounded.ok) {
		logger.error('Managed route ceiling refused the grooming turn; not spawning', LOG_CONTEXT, {
			groomerSessionId,
			agentType,
			reason: bounded.reason,
		});
		throw new Error(bounded.reason);
	}
	if (bounded.ceiling) {
		logger.info('Grooming turn bounded by the managed route ceiling', LOG_CONTEXT, {
			groomerSessionId,
			agentType,
			...bounded.ceiling,
		});
	}
	const resolvedArgs = bounded.args;
	const resolvedEnvVars = bounded.customEnvVars;
	// Prefer the absolute path the detector resolved over the static `command`
	// field from the agent definition. `agent.command` is a bare name like
	// `claude`, which is not spawnable on Windows: the npm install leaves a
	// `claude.cmd` shim in %APPDATA%\npm and there is no bare `claude` on PATH,
	// so spawn() fails with ENOENT. Every other spawn site already resolves
	// `agent.path || agent.command`; the fallback keeps working on platforms
	// where the bare command is already on PATH and `path` is unset.
	//
	// `agent.path` is local. Remote execution uses the explicit session custom
	// path or the agent's binaryName through wrapSpawnWithSsh below.
	const resolvedCommand = sessionCustomPath || agent.path || agent.command;

	// Apply SSH wrapping when the session runs on a remote host. ProcessManager
	// does NO SSH wrapping of its own - every spawn surface has to do this itself
	// (see spawnGroupChatAgent / cue-spawn-builder / the CLI agent-spawner), and
	// grooming used to just hand `sessionSshRemoteConfig` to spawn(), where it was
	// silently ignored. The prompt (and the transcript context it carries) then ran
	// on the local machine even though the user explicitly opted into SSH.
	let spawnCommand = resolvedCommand;
	let spawnArgs = resolvedArgs;
	let spawnCwd = projectRoot;
	let spawnPrompt: string | undefined = prompt;
	let spawnEnvVars = resolvedEnvVars;
	let sshStdinScript: string | undefined;
	let sshRemoteCommand: string | undefined;
	let sshRemoteUsed: SshRemoteConfig | null = null;
	let fileDelivery: Extract<PromptDelivery, { via: 'file' }> | undefined;
	let spawnAgentSessionId = agentSessionId;
	if (agent.promptFile) {
		const argumentSessionId = resumeIdFromArgs(resolvedArgs);
		if (
			(agentSessionId !== undefined && agentSessionId !== argumentSessionId) ||
			(argsResumeSession(resolvedArgs) && !argumentSessionId)
		) {
			throw new Error('Prompt-file resume identity does not match its launch arguments.');
		}
		spawnAgentSessionId = argumentSessionId;
		const remote = sessionSshRemoteConfig?.enabled
			? sshStore &&
				getSshRemoteConfig(sshStore, { sessionSshConfig: sessionSshRemoteConfig }).config
			: undefined;
		if (sessionSshRemoteConfig?.enabled && !remote) {
			throw new Error(sshUnresolvedRemoteMessage(sessionSshRemoteConfig));
		}
		let delivery: PromptDelivery;
		try {
			delivery = resolvePromptDelivery({
				agent,
				prompt,
				args: resolvedArgs,
				isWindowsHost: isWindows(),
				sshRemote: !!remote,
				sshRemoteId: remote?.id,
				promptFileDestination: remote
					? newRemotePromptFileDestination(remote.id, agent.promptFile.format)
					: selectPromptFileDestination(agent, undefined),
			});
		} catch {
			throw new Error('Prompt-file grooming preparation unavailable.');
		}
		if (delivery.via === 'refused') throw new Error(delivery.error);
		if (delivery.via !== 'file') throw new Error('Prompt-file grooming preparation unavailable.');
		fileDelivery = delivery;
		spawnArgs = [...resolvedArgs, ...delivery.args];
		spawnPrompt = undefined;
	}
	const deliveryArgs = spawnArgs;

	// Claude token source: an agent set to TUI runs this turn through maestro-p,
	// the same as its chat turns. Same resolve-then-apply sequence as
	// spawnGroupChatAgent; a non-Claude agent always resolves to API.
	let claudeDecision: ClaudeSpawnDecision | null = null;
	if (claudeTokenSource && agent.id === 'claude-code') {
		const sshEnabled = !!sessionSshRemoteConfig?.enabled;
		let sshMaestroPAvailable: boolean | undefined;
		if (sshEnabled && sshStore) {
			const sshRemote = getSshRemoteConfig(sshStore, {
				sessionSshConfig: sessionSshRemoteConfig,
			}).config;
			if (sshRemote) sshMaestroPAvailable = await ensureRemoteMaestroPProbed(sshRemote);
			signal.throwIfAborted();
		}
		claudeDecision = resolveClaudeSpawnMode({
			agent,
			tokenMode: getClaudeTokenMode(claudeTokenSource, { sshEnabled, sshMaestroPAvailable }),
			sshEnabled,
			sshRemoteId: sessionSshRemoteConfig?.remoteId ?? undefined,
			command: resolvedCommand,
			sessionCustomPath,
			sessionCustomEnvVars: resolvedEnvVars,
			maestroPPath: claudeTokenSource.maestroPPath,
			now: new Date(),
		});
		if (!sshEnabled && claudeDecision.mode === 'interactive' && claudeDecision.maestroPBinPath) {
			const applied = applyClaudeSpawnDecision({
				decision: claudeDecision,
				interactiveModeArgs: agent.interactiveModeArgs,
				command: resolvedCommand,
				args: deliveryArgs,
				customEnvVars: resolvedEnvVars,
				maxWaitSeconds: Math.ceil(timeoutMs / 1000),
			});
			spawnCommand = applied.command;
			spawnArgs = applied.args;
			spawnEnvVars = applied.customEnvVars;
		}
		logger.info('Grooming token source resolved', LOG_CONTEXT, {
			groomerSessionId,
			mode: claudeDecision.mode,
		});
	}

	if (sessionSshRemoteConfig?.enabled) {
		if (!sshStore) {
			throw new Error(
				'SSH remote execution is enabled for this session but no SSH settings store was ' +
					'provided to groomContext(). Refusing to run the prompt locally.'
			);
		}

		// `projectRoot` is the LOCAL path for an SSH agent, and the remote shell
		// does `cd <cwd> || exit 1`. Prefer the configured remote working dir so
		// grooming lands in the same directory the agent's own turns run in.
		const remoteCwd = sessionSshRemoteConfig.workingDirOverride || projectRoot;

		// Remote TUI: maestro-p on the remote host drives the remote claude.
		// Null for the API path, which leaves the plain claude spawn untouched.
		const remoteInteractive = claudeDecision
			? buildRemoteInteractiveSpawn({
					decision: claudeDecision,
					interactiveModeArgs: agent.interactiveModeArgs,
					remoteClaudeBin: claudeDecision.claudeRealBinPath,
					maxWaitSeconds: Math.ceil(timeoutMs / 1000),
				})
			: null;

		const wrapped = await wrapSpawnWithSsh(
			{
				command: resolvedCommand,
				args: remoteInteractive
					? [...remoteInteractive.prependArgs, ...deliveryArgs]
					: deliveryArgs,
				cwd: remoteCwd,
				prompt: spawnPrompt,
				...(fileDelivery ? { promptArtifact: fileDelivery.artifact } : {}),
				customEnvVars: remoteInteractive
					? { ...(resolvedEnvVars ?? {}), ...remoteInteractive.env }
					: resolvedEnvVars,
				promptArgs: agent.promptArgs,
				noPromptSeparator: agent.noPromptSeparator,
				// Never send a locally-detected absolute path to the remote host -
				// it does not exist there. A session custom path IS honored (for an
				// SSH session the user configures it as the remote path), matching
				// what the `process:spawn` handler does; otherwise resolve the agent
				// by binary name against the remote PATH.
				agentBinaryName: remoteInteractive
					? remoteInteractive.command
					: sessionCustomPath || agent.binaryName,
			},
			sessionSshRemoteConfig,
			sshStore
		).catch((error: unknown) => {
			if (fileDelivery) throw new Error('Remote prompt preparation unavailable.');
			throw error;
		});
		signal.throwIfAborted();

		// wrapSpawnWithSsh falls back to the unmodified local config when the
		// remote can't be resolved. Fail loudly instead - the user opted into SSH,
		// so a local run is the wrong answer, not a graceful degradation.
		if (!wrapped.sshRemoteUsed) {
			throw new Error(sshUnresolvedRemoteMessage(sessionSshRemoteConfig));
		}
		if (
			fileDelivery &&
			(fileDelivery.artifact.owner !== 'remote' ||
				wrapped.sshRemoteUsed.id !== fileDelivery.artifact.sshRemoteId ||
				wrapped.promptArtifactPath !== fileDelivery.artifact.path ||
				!wrapped.sshStdinScript)
		) {
			throw new Error('Prompt-file delivery does not match its host plan.');
		}

		spawnCommand = wrapped.command;
		spawnArgs = wrapped.args;
		spawnCwd = wrapped.cwd;
		// The prompt now lives inside the SSH command line or the stdin script.
		spawnPrompt = wrapped.prompt;
		spawnEnvVars = wrapped.customEnvVars;
		sshStdinScript = wrapped.sshStdinScript;
		sshRemoteCommand = wrapped.sshRemoteCommand;
		sshRemoteUsed = wrapped.sshRemoteUsed;

		logger.info('Grooming will run on SSH remote', LOG_CONTEXT, {
			groomerSessionId,
			remoteId: sshRemoteUsed.id,
			remoteName: sshRemoteUsed.name,
			viaStdinScript: !!sshStdinScript,
		});
	}
	signal.throwIfAborted();

	// Create a promise that collects the response
	return new Promise<GroomContextResult>((resolve, reject) => {
		let responseBuffer = '';
		let lastDataTime = Date.now();
		let idleCheckInterval: NodeJS.Timeout | null = null;
		let overallTimeout: NodeJS.Timeout | null = null;
		let resolved = false;
		let chunkCount = 0;
		let cancelled = false;

		const cleanup = () => {
			if (overallTimeout) clearTimeout(overallTimeout);
			if (idleCheckInterval) {
				clearInterval(idleCheckInterval);
				idleCheckInterval = null;
			}
			processManager.off('data', onData);
			processManager.off('exit', onExit);
			processManager.off('agent-error', onError);
			activeGroomingSessions.delete(groomerSessionId);
		};

		const cancelOperation = () => {
			if (resolved) return;
			cancelled = true;
			resolved = true;

			logger.info('Grooming cancelled by user', LOG_CONTEXT, { groomerSessionId });

			// Kill the process
			try {
				processManager.kill(groomerSessionId);
			} catch {
				// Process may have already exited
			}

			cleanup();
			reject(new Error('Grooming cancelled by user'));
		};

		// Track this grooming session with cancel function
		activeGroomingSessions.set(groomerSessionId, {
			groomerSessionId,
			startTime,
			cancel: cancelOperation,
		});

		const finishWithResponse = (reason: string) => {
			if (resolved || cancelled) return;
			resolved = true;
			// The existing sink owns file cleanup until its reader closes. Stop a
			// file-backed reader when an idle/deadline result abandons the turn.
			if (fileDelivery && !reason.startsWith('process exited')) {
				try {
					processManager.kill(groomerSessionId);
				} catch {
					cleanup();
					reject(new Error('Prompt-file grooming stop unavailable.'));
					return;
				}
			}
			cleanup();

			const durationMs = Date.now() - startTime;

			logger.info('Grooming response collected', LOG_CONTEXT, {
				groomerSessionId,
				responseLength: responseBuffer.length,
				chunkCount,
				reason,
				durationMs,
			});

			resolve({
				response: responseBuffer,
				durationMs,
				completionReason: reason,
			});
		};

		const onData = (...args: unknown[]) => {
			const [eventSessionId, data] = args as [string, string];
			if (eventSessionId !== groomerSessionId) return;

			chunkCount++;
			responseBuffer += data;
			lastDataTime = Date.now();

			if (chunkCount % 10 === 0 || chunkCount === 1) {
				logger.debug('Grooming data chunk received', LOG_CONTEXT, {
					groomerSessionId,
					chunkCount,
					totalLength: responseBuffer.length,
				});
			}

			// Emit progress update if callback provided
			if (onProgress) {
				onProgress({
					chunkCount,
					bytesReceived: responseBuffer.length,
					elapsedMs: Date.now() - startTime,
				});
			}
		};

		const onExit = (...args: unknown[]) => {
			const [eventSessionId, exitCode] = args as [string, number];
			if (eventSessionId !== groomerSessionId) return;

			logger.info('Grooming process exited', LOG_CONTEXT, {
				groomerSessionId,
				exitCode,
				responseLength: responseBuffer.length,
			});

			finishWithResponse(`process exited with code ${exitCode}`);
		};

		const onError = (...args: unknown[]) => {
			const [eventSessionId, error] = args as [string, unknown];
			if (eventSessionId !== groomerSessionId) return;

			cleanup();
			if (!resolved) {
				resolved = true;
				// `agent-error` emits an AgentError plain object (sessionId, type,
				// message, ...), not a real Error - `String(error)` would yield
				// "[object Object]". Pull `.message` out when present.
				const errorMsg =
					error instanceof Error
						? error.message
						: typeof error === 'object' && error !== null && 'message' in error
							? String((error as { message: unknown }).message)
							: String(error);
				logger.error('Grooming error', LOG_CONTEXT, { groomerSessionId, error: errorMsg });
				reject(new Error(`Grooming error: ${errorMsg}`));
			}
		};

		// Listen for events BEFORE spawning
		processManager.on('data', onData);
		processManager.on('exit', onExit);
		processManager.on('agent-error', onError);

		// On Windows, grooming prompts often exceed cmd.exe's ~8KB command-line
		// limit (ENAMETOOLONG on spawn). Route the prompt via stdin instead.
		// SSH spawns already carry the prompt in the wrapped command (or in
		// `sshStdinScript`, which owns the child's stdin), so skip it there.
		const useStdinForPrompt = !fileDelivery && isWindows() && !sshRemoteUsed;

		// The batch-mode spawn. Classified as a `utility` turn of Maestro's own,
		// raised by the surface the actor came in through, serving the agent and
		// tab the caller named (MRC2-02-02); the sink carries all three into the
		// admission snapshot and the trace.
		const spawnConfig: GroomingSpawnConfig = {
			sessionId: groomerSessionId,
			toolType: agentType,
			cwd: spawnCwd,
			command: spawnCommand,
			args: spawnArgs,
			prompt: spawnPrompt, // Triggers batch mode (no PTY); undefined for SSH
			...(fileDelivery ? { promptArtifact: fileDelivery.artifact } : {}),
			...(spawnAgentSessionId ? { agentSessionId: spawnAgentSessionId } : {}),
			// For agents using flag-based prompt (e.g., OpenCode -p). Harmless for
			// SSH: the wrapper already applied them and `spawnPrompt` is undefined.
			promptArgs: agent.promptArgs,
			noPromptSeparator: agent.noPromptSeparator,
			sendPromptViaStdinRaw: useStdinForPrompt,
			// SSH remote execution (undefined for local spawns)
			sshStdinScript,
			sshRemoteCommand,
			sshRemoteId: sshRemoteUsed?.id,
			sshRemoteHost: sshRemoteUsed?.host,
			// Pass resolved env vars (merged from agent defaults + agent config + session overrides)
			customEnvVars: spawnEnvVars,
			purpose: 'utility',
			origin,
			...(lineage ? { utilityOf: lineage } : {}),
		};

		const armAfterSpawn = (
			spawnResult: { pid: number; success?: boolean; error?: string } | null
		) => {
			// A refusal at the sink already arrived as an `agent-error` for this
			// session and settled the promise through `onError`; nothing to add.
			if (resolved) {
				// Cancellation may beat asynchronous admission. A late child still
				// belongs to this owner and must be stopped, including its artifact.
				if (cancelled && spawnResult && spawnResult.pid > 0) {
					try {
						processManager.kill(groomerSessionId);
					} catch {
						logger.error('Cancelled grooming process could not be stopped', LOG_CONTEXT, {
							groomerSessionId,
						});
					}
				}
				return;
			}
			if (!spawnResult || spawnResult.pid <= 0 || spawnResult.success === false) {
				cleanup();
				resolved = true;
				reject(
					new Error(
						spawnResult?.error
							? `Grooming was not started: ${spawnResult.error}`
							: `Failed to spawn grooming process for ${agentType}`
					)
				);
				return;
			}

			logger.debug('Spawned grooming batch process', LOG_CONTEXT, {
				groomerSessionId,
				pid: spawnResult.pid,
			});

			// Set up idle check
			idleCheckInterval = setInterval(() => {
				const idleTime = Date.now() - lastDataTime;
				if (idleTime > IDLE_TIMEOUT_MS && responseBuffer.length >= MIN_RESPONSE_LENGTH) {
					finishWithResponse('idle timeout with content');
				}
			}, 1000);

			// Overall timeout
			overallTimeout = setTimeout(() => {
				if (!resolved) {
					logger.warn('Grooming timeout', LOG_CONTEXT, {
						groomerSessionId,
						responseLength: responseBuffer.length,
					});

					if (responseBuffer.length > 0) {
						finishWithResponse('overall timeout with content');
					} else {
						// Nobody is waiting for this process anymore. Left running it
						// keeps its provider session open until it finishes on its own,
						// which a caller with a short deadline (tab routing) would stack up.
						try {
							processManager.kill(groomerSessionId);
						} catch {
							// Process may have already exited
						}
						cleanup();
						resolved = true;
						reject(new Error('Grooming timed out with no response'));
					}
				}
			}, timeoutMs);
		};

		// Admitted at the sink for the actor named: a managed desktop spawns
		// nothing without an admission and answers a refusal as a failed result
		// (and an `agent-error` on this session, which `onError` turns into the
		// rejection the caller reports); a standalone desktop, and a manager
		// double with no admission path, spawn as before.
		if (processManager.spawnAdmitted) {
			processManager.spawnAdmitted(spawnConfig, actor).then(armAfterSpawn, (error: unknown) => {
				if (resolved) return;
				cleanup();
				resolved = true;
				reject(
					fileDelivery
						? new Error('Prompt-file grooming spawn unavailable.')
						: error instanceof Error
							? error
							: new Error(String(error))
				);
			});
		} else {
			try {
				armAfterSpawn(processManager.spawn(spawnConfig));
			} catch (error) {
				cleanup();
				resolved = true;
				reject(fileDelivery ? new Error('Prompt-file grooming spawn unavailable.') : error);
			}
		}
	});
}

/**
 * Get the number of active grooming sessions (for debugging/monitoring)
 */
export function getActiveGroomingSessionCount(): number {
	return activeGroomingSessions.size;
}
