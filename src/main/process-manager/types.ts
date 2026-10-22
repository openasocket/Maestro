import type { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentOutputParser, ParsedEvent } from '../parsers';
import type { AgentError, CallUsage } from '../../shared/types';
import type { UsageAccumulator } from '../../shared/maestro-lib/streaming/usage-accumulator';
import type { TurnOutcome } from '../../shared/maestro-lib/streaming/turn-outcome';
import type { CodexTransport } from '../../shared/codexTransport';
import type { CodexAppServerSshLaunch } from '../codex-app-server/ssh-launch';
import type { CodexAppServerProcessHandle } from '../codex-app-server/protocol';
import type { SshRemoteEndpointIdentity } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type {
	ContextVerification,
	DispatchOperation,
	HostAuthority,
	PolicySourceSet,
} from '../../shared/maestro-lib/managed/authority';
import type {
	ManagedDelegationRef,
	ManagedDenialCode,
	ManagedDispatchTarget,
	ManagedPrincipalRef,
	ManagedRunIdentity,
	ManagedWorkflowRef,
} from '../../shared/maestro-lib/managed/types';
import type { AutoRunSpawnLineage } from '../../shared/maestro-lib/autorun/attribution';
import type { ManagedDelegationContext } from '../../shared/maestro-lib/managed/delegation';
import type { ManagedEffectAuthority } from '../../shared/maestro-lib/managed/effects';
import type {
	WorkflowFenceAnswer,
	WorkflowIdentityLike,
} from '../../shared/maestro-lib/managed/workflows';

// ============================================================================
// Managed admission at the process sink
// ============================================================================

/**
 * Who asked for a spawn, as the transport that carried the request knows it
 * (MRC-08-01A). `in-process` is the desktop operator at the keyboard (an
 * Electron IPC call runs outside any acting-user context, and the bare path
 * token admits the same owner-operator); `web-login` is a logged-in browser
 * account; `host-secret` is a process that presented the per-boot CLI secret
 * (`maestro-cli`, or whatever an agent runs); `device-pairing` is a paired
 * Lite device. Every one of them is attribution for the record, not an
 * enterprise principal: the principal of a managed launch is always the
 * enrollment's registered actor, and the transport's peer is carried on the
 * delegation chain (`spawnDelegationChain`).
 */
export type ProcessSpawnActor =
	| { peer: 'in-process' }
	| { peer: 'web-login'; username: string }
	| { peer: 'host-secret' }
	| { peer: 'device-pairing'; deviceId: string };

export interface ProcessSpawnContextInput {
	actor: ProcessSpawnActor;
	identity: ManagedRunIdentity;
	traceId: string;
	policyRevision: number | null;
	/**
	 * The workflow the spawn belongs to (an Auto Run with its owner fence), or
	 * null for a spawn that is its own request (a chat turn). Passed through
	 * to the verified context as it is: a port never strips a workflow to fit
	 * a launch-only route, and never invents one.
	 */
	workflow: ManagedWorkflowRef | null;
	/**
	 * The delegation chain the spawn arrived with (a dispatched turn is the
	 * child of the operation that dispatched it: the carried chain plus the
	 * target), bound as it is. Absent for a spawn that is its own request,
	 * where the port contributes only the transport's attribution.
	 */
	delegation?: ManagedDelegationRef;
}

/**
 * The host authority the process manager admits every spawn with. Injected
 * by the desktop (the enterprise service's spawn authority) and by any other
 * host composing the manager; absent in a bare `new ProcessManager()`, which
 * is standalone by construction.
 *
 * `standing()` is the one question a sink asks before anything else: a host
 * holding no enrollment is `standalone` and spawns exactly as before; a host
 * holding one, usable or not, is `managed`, and nothing in it spawns without
 * an admission. An enrollment with no usable standing never falls back to
 * standalone; its admissions are all `unavailable`, and that is the answer.
 */
export interface ProcessSpawnAuthorityPort {
	standing(): 'standalone' | 'managed';
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	/** Bind the actor and the run identity into a verified context, or say why not. */
	verify(input: ProcessSpawnContextInput): ContextVerification;
	/**
	 * The authority a running managed turn asks for each effect it reaches
	 * for (a command, a file change, a permission profile, a tool call) before
	 * it happens. Absent: no effect producer on this host, and every managed
	 * effect is refused as unavailable.
	 */
	readonly effects?: ManagedEffectAuthority;
	/**
	 * The owner fence of the workflow an Auto Run spawn belongs to, claimed
	 * through this host's workflow owner producer for exactly that spawn's
	 * request and attempt ids (MRC-07-06B): the fence the registry confirmed,
	 * a `WorkflowFenceRefusal` naming why there is none (the sink's answer,
	 * with the producer's state and code), or null for an unowned workflow.
	 * The sink asks it only for a lineage that arrives unowned (the renderer
	 * sends `fence: null`: it has no producer and must not claim); a lineage
	 * that carries a fence is bound as it is. Absent: this host has no
	 * producer to claim through, and an unowned workflow is refused by name.
	 * Nothing on this side mints a fence (CP-03).
	 */
	workflowFence?(
		workflow: WorkflowIdentityLike,
		run: { runId: string; attemptId: string }
	): WorkflowFenceAnswer | Promise<WorkflowFenceAnswer>;
}

/**
 * The immutable admission one spawn carries from the handler that obtained it
 * to the sink that spawns: the lease's identity and the digest of the request
 * it covers. The lease itself is held by the process manager that admitted
 * (keyed by this object, so a copy or a look-alike is forged); the fields are
 * what a caller may journal or show. Frozen on creation.
 */
export interface ProcessSpawnAdmission {
	readonly leaseId: string;
	readonly authorityId: string;
	/** Digest of the request snapshot (`buildSpawnRequestSnapshot`) the lease covers. */
	readonly requestDigest: string;
	readonly actor: ManagedPrincipalRef;
	readonly provider: string;
	readonly operation: DispatchOperation;
	readonly target: ManagedDispatchTarget;
	readonly policyRevision: number | null;
	readonly requestId: string;
	readonly attemptId: string;
}

/**
 * What a one-off command sink (`runCommand`, local or SSH) is told about the
 * host: standalone runs as before; managed has no confined route for a shell
 * command in this build and refuses at the sink, explicitly.
 */
export interface ManagedCommandContext {
	standing: 'standalone' | 'managed';
}

/**
 * Why a one-off shell command cannot run under management on this host, or
 * null when it may. Both runners put the command in an unconfined shell (a
 * transient PTY or a shell child locally, a remote login shell over SSH) and
 * no confinement producer qualifies either, so a managed host refuses before
 * anything starts. Never a fallback, never a prompt check.
 */
export function managedCommandRefusal(
	context: ManagedCommandContext | undefined,
	route: 'local-shell' | 'ssh-shell'
): string | null {
	if (!context || context.standing === 'standalone') return null;
	const where =
		route === 'local-shell'
			? 'a transient PTY (a shell child on Windows)'
			: 'a remote login shell over SSH';
	return `A one-off ${route === 'local-shell' ? 'terminal' : 'SSH terminal'} command is unavailable under management on this host: it would run in ${where} with no confinement, and no producer qualifies that route. Nothing was started.`;
}

/**
 * What asking for a spawn admission came to. `standalone` means the host
 * holds no enrollment and needs none; `admitted` carries the admission to
 * put on the config; the other three are the authority's own distinctions
 * (a decision, no decision obtainable, an answer lost) and start nothing.
 */
export type ProcessSpawnAdmissionOutcome =
	| { state: 'standalone' }
	| { state: 'admitted'; admission: ProcessSpawnAdmission }
	| { state: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode; message: string };

/**
 * Kill/interrupt handle for server-backed processes, whose stop starts with a
 * protocol call rather than a signal: the OpenCode SDK path (no OS child) and
 * the Codex app-server path (`turn/interrupt`, then the stop ladder on its
 * child). ProcessManager routes kill()/interrupt() here when
 * `ManagedProcess.sdkController` is set.
 */
export interface SdkProcessController {
	/** Abort the in-flight turn; the session/stream stays alive. */
	interrupt: () => void;
	/**
	 * Hard stop: abort the turn and tear down the transport. `sync` and
	 * `shutdown` carry `ProcessManager.kill()`'s options through to a
	 * controller that owns an OS child.
	 */
	kill: (options?: { sync?: boolean; shutdown?: boolean }) => void;
}

/**
 * Configuration for spawning a new process
 */
export interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	/** Attach to an existing terminal handle instead of replacing it. */
	reuseTerminal?: boolean;
	requiresPty?: boolean;
	prompt?: string;
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	images?: string[];
	imageArgs?: (imagePath: string) => string[];
	imagePromptBuilder?: (imagePaths: string[]) => string;
	promptArgs?: (prompt: string) => string[];
	contextWindow?: number;
	customEnvVars?: Record<string, string>;
	noPromptSeparator?: boolean;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	/**
	 * Identity key for the omp model->context-window catalog (see
	 * `computeOmpCatalogKey`). Set only for local omp spawns; carried onto the
	 * managed process so StdoutHandler resolves against the catalog primed for
	 * this exact binary + env, never another configuration's.
	 */
	ompModelCatalogKey?: string;
	/** If true, always spawn in a shell (for PATH resolution on Windows) */
	runInShell?: boolean;
	/** If true, send the prompt via stdin as JSON instead of command line */
	sendPromptViaStdin?: boolean;
	/** If true, send the prompt via stdin as raw text instead of command line */
	sendPromptViaStdinRaw?: boolean;
	/** If true, the prompt is already embedded in `args` by the caller. The spawner
	 *  must not append it again. Used by SSH tab naming for non-stream-json agents:
	 *  the prompt has to live inside the `bash -c '<cmd>'` wrapper, otherwise it
	 *  ends up as a positional arg to the remote bash and never reaches the agent. */
	promptAlreadyInArgs?: boolean;
	/** Script to send via stdin for SSH execution (bypasses shell escaping) */
	sshStdinScript?: string;
	/** Human-readable remote command line (the actual agent invocation running on the
	 *  remote host). Surfaced in Process Details above the local SSH command. */
	sshRemoteCommand?: string;
	/** The enrolled remote runtime a managed SSH launch was qualified against
	 *  (`EnterpriseService.remote.qualify`, MRC-08-04B): the remote's own
	 *  attestation, bound by the spawn handler before any side effect. The sink
	 *  names it in the lease's target and the child spawner admits the `ssh`
	 *  route only when it is present; absent on a standalone launch. */
	sshRemoteEndpoint?: SshRemoteEndpointIdentity;
	/** PTY terminal width in columns (default 80) */
	cols?: number;
	/** PTY terminal height in rows (default 24) */
	rows?: number;
	/** Extra directories to prepend to the spawn-time PATH. Typically the
	 *  parent directory of the detected agent binary, so co-located runtimes
	 *  (e.g. the `node` next to an npm-installed `codex`) resolve via the
	 *  script's `#!/usr/bin/env node` shebang. Local spawn only - SSH builds
	 *  its remote PATH separately. */
	extraPathDirs?: string[];
	/** Agent-reported session id when this spawn is resuming a prior session
	 *  (e.g. Copilot's `--resume=<id>`, Claude's `--resume <id>`). The spawner
	 *  uses it to seed `ManagedProcess.agentSessionId` so post-exit work that
	 *  needs to inspect on-disk session state (Copilot's events.jsonl) can run
	 *  even when the resumed stream never re-announces the sessionId - Copilot
	 *  in particular emits `session.resume` (no sessionId) on resume rather
	 *  than `session.start`, so without this seed the disk reconciliation
	 *  never runs and the renderer falls back to streamed commentary instead
	 *  of the authoritative final answer / context window snapshot. */
	agentSessionId?: string;
	/** Resolved Codex transport for this turn (`resolveCodexTransport`). Set by
	 *  the desktop spawn handler from the persisted agent record; anything other
	 *  than `'app-server'` (including absent) means `codex exec`. A preference:
	 *  the spawner still runs exec for turns app-server cannot carry. */
	codexTransport?: CodexTransport;
	/** An app-server turn on an SSH remote: the launch the spawn handler built
	 *  beside the exec wrapper, set only when the turn wants app-server. The
	 *  app-server spawner runs it; exec ignores it. */
	codexAppServerSsh?: CodexAppServerSshLaunch;
	/** The admission this spawn was granted (`ProcessManager.admitSpawn`). On a
	 *  managed host every spawn must carry one that is live for this exact
	 *  request; on a standalone host it is ignored. */
	admission?: ProcessSpawnAdmission;
	/** The Auto Run lineage this spawn is one attempt of (the workflow, the
	 *  run, the task request, this attempt, and the run's owner fence if one
	 *  exists). `admitSpawn` binds it into the verified context in place of
	 *  the anonymous per-spawn identity; a standalone host ignores it. */
	autoRun?: AutoRunSpawnLineage;
	/** The context of the operation that DISPATCHED this spawn (a Cue `mode:
	 *  cli` action, an agent's `maestro-cli dispatch`), as `maestro-cli` read
	 *  it off its environment. `admitSpawn` binds the spawn as that operation's
	 *  child (`childDelegationContext`) under the host's own standing, never as
	 *  a fresh chat turn; a managed initiator's child on a standalone host is
	 *  refused, never run unmanaged in its place. */
	delegation?: ManagedDelegationContext;
	/** The request and attempt THIS dispatched spawn is, minted once by the
	 *  spawn handler that stamps the child's record on the process
	 *  (`MAESTRO_DELEGATION_CONTEXT`), so the record the sink binds under
	 *  `delegation` and the record the process carries are the same one
	 *  (`dispatchedChildContext`). Absent, the sink mints its own, and nothing
	 *  downstream can know them. Meaningless without `delegation`. */
	dispatchedAs?: DispatchedSpawnIds;
}

/** The identity a dispatched spawn is minted as: its own request and attempt. */
export interface DispatchedSpawnIds {
	requestId: string;
	attemptId: string;
}

/**
 * Internal representation of a managed process
 */
export interface ManagedProcess {
	sessionId: string;
	toolType: string;
	ptyProcess?: IPty;
	childProcess?: ChildProcess;
	cwd: string;
	pid: number;
	isTerminal: boolean;
	isBatchMode?: boolean;
	isStreamJsonMode?: boolean;
	jsonBuffer?: string;
	/** When true, the JSON buffer was force-cleared after exceeding size limits.
	 *  Subsequent chunks are discarded until a clean top-level `{` resync point. */
	jsonBufferCorrupted?: boolean;
	lastCommand?: string;
	sessionIdEmitted?: boolean;
	/** Agent-reported session id once extracted from the output stream.
	 *  Currently only populated for agents whose post-exit lifecycle we
	 *  need to inspect on disk (Copilot CLI events.jsonl). */
	agentSessionId?: string;
	resultEmitted?: boolean;
	errorEmitted?: boolean;
	/** Set by `ProcessManager.interrupt()` before it sends SIGINT (or writes
	 *  Ctrl+C). Lets the exit path tell a user-initiated stop apart from a real
	 *  silent crash: an interrupted turn that exits with a null signal code
	 *  (coerced to 0 by the spawner's `close` handler) must NOT be surfaced as an
	 *  "exited without producing a response" error. */
	interrupted?: boolean;
	/** An in-turn error notice held until the turn shows whether the agent
	 *  recovered from it. See `AgentOutputParser.isProvisionalErrorNotice`. */
	provisionalError?: AgentError;
	startTime: number;
	outputParser?: AgentOutputParser;
	stderrBuffer?: string;
	stdoutBuffer?: string;
	streamedText?: string;
	contextWindow?: number;
	ompModelCatalogKey?: string;
	/** Last omp usage payload that was emitted WITHOUT a catalog-resolved context
	 *  window (the catalog prime had not landed yet, so the stats carry the static
	 *  fallback). Kept so a prime that completes after the spawn cap can re-emit a
	 *  corrected `usage` event immediately instead of the gauge staying wrong until
	 *  the next turn. Cleared once resolved or pushed, so no double emit. */
	pendingOmpUsagePush?: { model: string; stats: UsageStats };
	/** Temporary CLI attachments (images and prompt files), owned until process termination. */
	tempFiles?: string[];
	command?: string;
	args?: string[];
	lastUsageTotals?: UsageTotals;
	usageIsCumulative?: boolean;
	/**
	 * The maestro-lib UsageAccumulator instance doing the actual delta
	 * normalization for this process (see `normalizeUsageToDelta` in
	 * StdoutHandler.ts). `lastUsageTotals`/`usageIsCumulative` above are kept
	 * in sync from its `lastTotals`/`isCumulative` getters after every call -
	 * they still need to exist as their own fields because
	 * `plugin-event-listener.ts` and the existing test suite read them
	 * directly, not through the accumulator.
	 */
	usageAccumulator?: UsageAccumulator;
	emittedToolCallIds?: Set<string>;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	/** Human-readable remote command line for SSH spawns (the agent invocation that
	 *  runs on the remote host). Shown in Process Details above the local SSH command. */
	sshRemoteCommand?: string;
	/** Remote file the launch script writes the agent's pid to, so Stop and kill
	 *  can signal the agent on its host rather than only the local ssh client.
	 *  See utils/ssh-remote-signal.ts. Set only for stdin-script SSH spawns. */
	sshRemotePidFile?: string;
	dataBuffer?: string;
	dataBufferTimeout?: NodeJS.Timeout;
	/** Env vars Maestro explicitly set on this process (global, then the session's own set or else the agent-level set),
	 *  with `~/` paths expanded and MAESTRO_SESSION_RESUMED included when applicable.
	 *  Inherited system env is NOT included - this is the actionable set shown in the
	 *  Process Details modal. */
	maestroEnvVars?: Record<string, string>;
	/** Kill/interrupt handle for server-backed processes (OpenCode SDK path). When
	 *  set, this process has no `ptyProcess`/`childProcess`; ProcessManager routes
	 *  lifecycle calls through here instead of OS signals. */
	sdkController?: SdkProcessController;
	/** OpenCode server session id for the SDK path (used to abort the turn). */
	opencodeSessionId?: string;
	/** OpenCode SDK client bound to the shared server, for abort calls. */
	opencodeClient?: OpencodeClient;
	/** Codex app-server turn state (thread id, turn id, request channel) for steering. */
	codexAppServer?: CodexAppServerProcessHandle;
	/** Monotonic spawn number for this session id, claimed at registration.
	 *  Lets a late event from a killed process recognize that a newer spawn owns
	 *  the session even after that newer spawn has removed its own map entry.
	 *  See `process-manager/generation.ts`. */
	spawnGeneration?: number;
	/** The admission this process was spawned under on a managed host. Absent
	 *  for a standalone spawn, and for a process that predates the enrollment
	 *  (an unqualified process a managed sink must not drive). */
	admission?: ProcessSpawnAdmission;
}

export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	reasoningTokens: number;
}

// Import and re-export UsageStats from canonical location
import type { UsageStats } from '../../shared/types';
export type { UsageStats } from '../../shared/types';

export interface SpawnResult {
	pid: number;
	success: boolean;
	error?: string;
	/** Set when a managed host refused the spawn at the sink: the authority's
	 *  own distinction between a decision and no decision. Nothing started. */
	managed?: { state: 'denied' | 'unavailable' | 'unknown'; code: ManagedDenialCode };
	/** True when the existing terminal was reused; startup commands must not run again. */
	attached?: boolean;
}

export interface CommandResult {
	exitCode: number;
}

export interface TurnSettlement {
	outcome: TurnOutcome;
	answerCaptured: boolean;
}

/**
 * Events emitted by ProcessManager
 */
export interface ProcessManagerEvents {
	data: (sessionId: string, data: string) => void;
	stderr: (sessionId: string, data: string) => void;
	/** `signal` is set only when the process was terminated by a signal
	 *  (WIFSIGNALED). node-pty reports those with `code` 0, so the code alone
	 *  cannot distinguish a clean exit from a kill. */
	exit: (sessionId: string, code: number, signal?: number, settlement?: TurnSettlement) => void;
	spawn: (config: ProcessConfig) => void;
	'command-exit': (sessionId: string, code: number) => void;
	usage: (sessionId: string, stats: UsageStats) => void;
	/** One API call's new spend, mid-turn (see `CallUsage`). claude-code only. */
	'call-usage': (sessionId: string, usage: CallUsage) => void;
	'session-id': (sessionId: string, agentSessionId: string) => void;
	'agent-error': (sessionId: string, error: AgentError) => void;
	'thinking-chunk': (sessionId: string, text: string) => void;
	/** One parsed output line, as the parser built it and before anything
	 *  interprets it. Fires once per line, and only while something is
	 *  subscribed (see `utils/parsedEvent.ts`). */
	'parsed-event': (sessionId: string, event: ParsedEvent) => void;
	'tool-execution': (sessionId: string, tool: ToolExecution) => void;
	'slash-commands': (sessionId: string, commands: unknown[]) => void;
	'query-complete': (sessionId: string, data: QueryCompleteData) => void;
}

export interface ToolExecution {
	toolName: string;
	state: unknown;
	timestamp: number;
	/** Stable correlation id from the agent. When present, renderers
	 *  merge `running` and `completed`/`failed` events into a single
	 *  log entry keyed by this id instead of appending two bubbles. */
	toolCallId?: string;
	/** When this tool ran inside a subagent, the `toolCallId` of the parent tool
	 *  call that spawned it (claude-code's Task tool). Renderers nest the badge
	 *  under that parent entry; absent for main-transcript tool calls. */
	parentToolUseId?: string;
}

export interface QueryCompleteData {
	sessionId: string;
	agentType: string;
	source: 'user' | 'auto';
	startTime: number;
	duration: number;
	projectPath?: string;
	tabId?: string;
}

// Re-export for backwards compatibility
export type { ParsedEvent, AgentOutputParser } from '../parsers';
export type { AgentError, AgentErrorType, SshRemoteConfig } from '../../shared/types';
