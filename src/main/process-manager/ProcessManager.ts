// src/main/process-manager/ProcessManager.ts

import { EventEmitter } from 'events';
import { randomBytes, randomUUID } from 'crypto';
import type {
	ProcessConfig,
	ManagedProcess,
	ProcessSteeringCredentials,
	SpawnResult,
	CommandResult,
	ParsedEvent,
	AgentOutputParser,
	ProcessSpawnActor,
	ProcessSpawnAdmission,
	ProcessSpawnAdmissionOutcome,
	ProcessSpawnAuthorityPort,
	ProcessSpawnContextInput,
	ManagedCommandContext,
	UtilityTurnLineage,
} from './types';
import {
	buildDispatchSnapshot,
	dispatchSnapshotDigest,
	type DispatchLease,
	type DispatchSnapshot,
	type LeaseRelease,
} from '../../shared/maestro-lib/managed/authority';
import type { ManagedDenialCode, ManagedRunIdentity } from '../../shared/maestro-lib/managed/types';
import { managedSshEndpointRef } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import { isMaestroPBinaryPath } from '../../shared/maestro-lib/launch/interactive-mode';
import {
	buildTuiHandshake,
	createFileDigestCache,
	loadOrCreateTuiHandshakeKey,
	TUI_HANDSHAKE_ENV_VAR,
} from '../../shared/maestro-lib/managed/tui-handshake';
import { generateUUID } from '../../shared/uuid';
import {
	autoRunRunIdentity,
	autoRunTraceId,
	autoRunWorkflowRef,
	type AutoRunSpawnLineage,
} from '../../shared/maestro-lib/autorun/attribution';
import {
	isWorkflowFenceRefusal,
	type WorkflowFenceAnswer,
} from '../../shared/maestro-lib/managed/workflows';
import {
	childDelegationContext,
	delegationContextProblems,
	intersectDelegationScope,
	type ManagedDelegationContext,
} from '../../shared/maestro-lib/managed/delegation';
import { argsResumeSession } from './utils/resumeArgs';
import { PtySpawner } from './spawners/PtySpawner';
import { ChildProcessSpawner } from './spawners/ChildProcessSpawner';
import { OpencodeServerSpawner } from './spawners/OpencodeServerSpawner';
import { CodexAppServerSpawner } from './spawners/CodexAppServerSpawner';
import { codexAppServerConfigBlocker, wantsCodexAppServer } from '../codex-app-server/invocation';
import { DataBufferManager } from './handlers/DataBufferManager';
import { pushResolvedOmpContextWindow } from './handlers/StdoutHandler';
import { LocalCommandRunner } from './runners/LocalCommandRunner';
import { SshCommandRunner } from './runners/SshCommandRunner';
import { opencodeServerManager } from '../opencode-server/OpencodeServerManager';
import { logger } from '../utils/logger';
import {
	STEERING_TOKEN_BYTES,
	STEERING_TOKEN_ENV_VAR,
	STEERING_TURN_FINISHED_DETAIL,
	type SteeringResultFrame,
} from '../../shared/chatSteering';
import { sendSteeringRequest } from './steering-client';
import { steerCodexAppServerTurn } from '../codex-app-server/steering';
import { isPidAlive } from './utils/childProcessInfo';
import { expandTilde } from '../../shared/pathUtils';
import { agentAlreadyRunningMessage } from '../../shared/processErrors';
import type { AgentError, SshRemoteConfig } from '../../shared/types';
import { unusableCwdReason } from './utils/spawnCwd';
import { getDefaultShell } from '../stores/defaults';
import { captureException } from '../utils/sentry';
import {
	COWORKING_RUN_ADMISSION_ENV_VAR,
	COWORKING_SESSION_ID_ENV_VAR,
	COWORKING_SOCKET_OVERRIDE_ENV_VAR,
	encodeCoworkingRunAdmission,
	type CoworkingRunAdmission,
} from '../coworking/coworking-types';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import { getBridgeSocketPath } from '../coworking/coworking-socket-path';
import {
	stopProcess,
	INTERACTIVE_STOP_GRACE_MS,
} from '../../shared/maestro-lib/control/termination';
import { signalRemoteAgent, type RemoteSignalMode } from '../utils/ssh-remote-signal';

export interface ProcessManagerOptions {
	/** Maestro's version, reported to `codex app-server` as `clientInfo.version`. */
	appVersion?: string;
	/**
	 * Live read of the `encoreFeatures.coworking` gate. While it is off, no spawn
	 * carries the coworking session/socket env vars, so nothing in the agent can
	 * find the bridge. Main always passes it; omitted keeps the injection, which
	 * is what a bare `new ProcessManager()` in a test expects.
	 */
	isCoworkingEnabled?: () => boolean;
	/**
	 * Live read of the host authority every spawn is admitted with (the
	 * desktop's enterprise service composes one after the manager exists, so
	 * it is read on every call, never captured). `null` or omitted means no
	 * authority is reachable at all, which a sink treats as standalone only
	 * because nothing on this host holds an enrollment; a port that does is
	 * what says `managed`.
	 */
	spawnAuthority?: () => ProcessSpawnAuthorityPort | null;
	/**
	 * The app's data directory (`app.getPath('userData')`), where a managed
	 * host keeps the key it signs the maestro-p admission handshake with
	 * (MRC2-03-05A). Main always passes it; omitted, a managed local
	 * interactive Claude turn is refused by name, since the host has nowhere
	 * to keep a key and never spawns the TUI without a handshake. A standalone
	 * host reads it for nothing.
	 */
	userDataDir?: string;
}

/**
 * The request a managed spawn is admitted on: the resolved command, its
 * arguments, the working directory, the NAMES and digest of the environment
 * Maestro sets (global shell vars beneath the agent's own), the prompt by
 * digest, the provider (the tool type), the operation, the target, and the
 * classification the policy tells a person's turn from Maestro's own by: what
 * the launch is for (`purpose`) and which surface raised it (`origin`). It is
 * built from the exact `ProcessConfig` the sink receives, so the digest the
 * lease carries proves the sink spawns the request the authority admitted
 * and nothing else; what the spawner derives from that request afterwards
 * (prompt argv, the host's inherited environment, temp files) is a function
 * of it and of this host, not of the caller.
 */
export function buildSpawnRequestSnapshot(config: ProcessConfig): DispatchSnapshot {
	const resuming =
		!!config.agentSessionId || argsResumeSession(config.args) || !!config.codexAppServerSsh?.prompt;
	return buildDispatchSnapshot(
		{
			command: config.command,
			args: config.args,
			cwd: config.cwd,
			env: { ...(config.shellEnvVars ?? {}), ...(config.customEnvVars ?? {}) },
			stdin: config.sshStdinScript ?? config.prompt,
			// The shared snapshot binds bytes, destination and ownership by digest only.
			...(config.promptArtifact ? { promptArtifact: config.promptArtifact } : {}),
			shell: config.runInShell ? (config.shell ?? true) : false,
		},
		{
			provider: config.toolType,
			model: modelFromArgs(config.args),
			operation: resuming ? 'resume' : 'start',
			// An SSH target names the remote endpoint the launch was qualified
			// against (MRC-08-04B), so the lease says which remote installation
			// and authority it goes to, not only the remote's local id.
			target: config.sshRemoteId
				? {
						kind: 'ssh',
						remoteId: config.sshRemoteId,
						...(config.sshRemoteEndpoint
							? { endpoint: managedSshEndpointRef(config.sshRemoteEndpoint) }
							: {}),
					}
				: { kind: 'local' },
			resourceIds: config.images?.length ? [`images:${config.images.length}`] : [],
			// The desktop sink classifies every spawn (MRC2-02-01): a config that
			// says nothing is a person's conversation turn at Maestro's own UI.
			// The handler that resolved the caller names the origin
			// (`spawnOriginOf`); a utility, probe or supervisor names its purpose.
			purpose: config.purpose ?? 'conversation',
			origin: config.origin ?? 'desktop',
		}
	);
}

/**
 * What a local maestro-p launch looks like at the sink: the maestro-p script
 * is the first argument (the desktop runs it through `process.execPath`) or,
 * for an agent whose Path is maestro-p itself, the command; the claude it
 * drives is `MAESTRO_CLAUDE_BIN` in the env the handler built, null when the
 * launch set none (the TUI would resolve `claude` on PATH, which no admission
 * can name). An SSH launch runs a remote maestro-p this host never reaches.
 * Null for every other launch.
 */
export function localTuiLaunchOf(
	config: Pick<ProcessConfig, 'toolType' | 'command' | 'args' | 'customEnvVars' | 'sshRemoteId'>
): { claudeBinPath: string | null; args: string[] } | null {
	if (config.toolType !== 'claude-code' || config.sshRemoteId) return null;
	const [first, ...rest] = config.args;
	const args = isMaestroPBinaryPath(first)
		? rest
		: isMaestroPBinaryPath(config.command)
			? [...config.args]
			: null;
	if (!args) return null;
	return { claudeBinPath: config.customEnvVars?.MAESTRO_CLAUDE_BIN ?? null, args };
}

/** The identity of a spawn that is its own request (a chat turn): fresh, no run above it. */
function chatTurnIdentity(): ManagedRunIdentity {
	const requestId = generateUUID();
	return {
		requestId,
		idempotencyKey: requestId,
		attemptId: generateUUID(),
		runId: null,
		rootRunId: null,
		parentRunId: null,
	};
}

/**
 * The record a dispatched spawn (`config.delegation`, the context of the
 * operation that dispatched it) is bound as and stamped with: the CHILD of
 * that operation, the chain one link deeper (the owning agent), parented under
 * the initiator's run, the initiator's workflow and fence carried as they are
 * (this sink mints none, CP-03). The child's own request and attempt are the
 * ids the spawn handler minted (`config.dispatchedAs`), so the record the
 * admission binds and the record the process is stamped with
 * (`MAESTRO_DELEGATION_CONTEXT`, for a grandchild dispatch to deepen) are one
 * and the same; a config with no minted ids gets fresh ones, which then exist
 * only in the admission. Undefined for a spawn that carries no record.
 */
export function dispatchedChildContext(
	config: Pick<ProcessConfig, 'sessionId' | 'delegation' | 'dispatchedAs'>
): ManagedDelegationContext | undefined {
	if (!config.delegation) return undefined;
	return childDelegationContext(config.delegation, {
		link: { kind: 'agent', id: resolveOwningMaestroSessionId(config.sessionId) },
		requestId: config.dispatchedAs?.requestId ?? generateUUID(),
		attemptId: config.dispatchedAs?.attemptId ?? generateUUID(),
	});
}

/**
 * The trace a utility turn is bound under (MRC2-02-02): the served tab's own
 * process session id, the very string that tab's chat turns are traced by
 * (`spawnContextInput` traces a chat turn under `config.sessionId`, which the
 * renderer forms as `<agent>-ai-<tab>`), or the served agent's id when the
 * turn serves no one tab. So a synopsis or a routing answer and the turns it
 * was run beside share one trace in the journal, under separate requests.
 */
export function utilityTurnTraceId(lineage: UtilityTurnLineage): string {
	return lineage.tabId ? `${lineage.sessionId}-ai-${lineage.tabId}` : lineage.sessionId;
}

/**
 * What a spawn is bound as. An Auto Run attempt is bound on its lineage; a
 * dispatched turn (`config.delegation`) is the CHILD of the operation that
 * dispatched it (`dispatchedChildContext`); anything else is a chat turn of
 * its own, traced under its own session id, or under the served tab's when
 * it is a utility turn that names one (`config.utilityOf`).
 */
function spawnContextInput(
	config: ProcessConfig
): Omit<ProcessSpawnContextInput, 'actor' | 'policyRevision'> {
	const lineage = config.autoRun;
	if (lineage) {
		return {
			identity: autoRunRunIdentity(lineage.attribution),
			traceId: autoRunTraceId(lineage.attribution),
			workflow: autoRunWorkflowRef(lineage.attribution.workflow, lineage.fence),
		};
	}
	const child = dispatchedChildContext(config);
	if (child) {
		return {
			identity: child.identity,
			traceId: child.traceId,
			workflow: child.workflow,
			delegation: child.delegation,
		};
	}
	return {
		identity: chatTurnIdentity(),
		traceId: config.utilityOf ? utilityTurnTraceId(config.utilityOf) : config.sessionId,
		workflow: null,
	};
}

/**
 * The owner fence an Auto Run attempt is bound on at this sink. A lineage
 * that arrives with a fence is carried as it is: a producer elsewhere issued
 * it, the host authority judges it, and this sink neither checks nor
 * re-claims it. A lineage that arrives unowned (`fence: null`, what the
 * renderer sends: it has no producer and must not claim) is claimed here,
 * through the port's workflow owner producer, for exactly this attempt's
 * request and attempt ids, so a retry re-confirms the owner instead of
 * reusing a decision and a fence that lapsed stops the next attempt. A port
 * with no producer answers null, and the sink refuses by name. Nothing is
 * minted here (CP-03, the workflow owner producer).
 */
async function autoRunFenceFor(
	port: ProcessSpawnAuthorityPort,
	lineage: AutoRunSpawnLineage
): Promise<WorkflowFenceAnswer> {
	if (lineage.fence) return lineage.fence;
	if (!port.workflowFence) return null;
	return (
		(await port.workflowFence(lineage.attribution.workflow, {
			runId: lineage.attribution.requestId,
			attemptId: lineage.attribution.attemptId,
		})) ?? null
	);
}

export interface TerminalTabSpawnConfig {
	sessionId: string;
	cwd: string;
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	cols?: number;
	rows?: number;
	/** The admission a managed host granted `terminalTabConfig(config)`. */
	admission?: ProcessSpawnAdmission;
}

function modelFromArgs(args: readonly string[]): string | null {
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === '--model') return args[i + 1] ?? null;
		if (args[i].startsWith('--model=')) return args[i].slice('--model='.length) || null;
	}
	return null;
}

/**
 * ProcessManager orchestrates spawning and managing processes for sessions.
 *
 * Responsibilities:
 * - Spawn PTY and child processes
 * - Route data events from processes
 * - Provide process lifecycle management (write, resize, interrupt, kill)
 * - Execute commands (local and SSH remote)
 */
export class ProcessManager extends EventEmitter {
	private processes: Map<string, ManagedProcess> = new Map();
	private bufferManager: DataBufferManager;
	private ptySpawner: PtySpawner;
	private childProcessSpawner: ChildProcessSpawner;
	private opencodeServerSpawner: OpencodeServerSpawner;
	private codexAppServerSpawner: CodexAppServerSpawner;
	private localCommandRunner: LocalCommandRunner;
	private sshCommandRunner: SshCommandRunner;
	private readonly isCoworkingEnabled: () => boolean;
	private readonly spawnAuthority: () => ProcessSpawnAuthorityPort | null;
	private readonly userDataDir: string | null;
	/** The claude binary's digest, remembered per file identity across turns. */
	private readonly digestFile = createFileDigestCache();
	/** The lease behind each admission this manager minted; a look-alike has none. */
	private readonly admissionLeases = new WeakMap<ProcessSpawnAdmission, DispatchLease>();
	/** The lease bound to each session's live process, released when it ends. */
	private readonly boundLeases = new Map<
		string,
		{ lease: DispatchLease; admission: ProcessSpawnAdmission; unsubscribe: () => void }
	>();

	constructor(
		/**
		 * Live read of the `encoreFeatures.opencodeServer` gate. Defaults to off so
		 * tests and any caller that builds ProcessManager without the wiring never
		 * route to the SDK-serve path. Read on every spawn so toggling the plugin
		 * takes effect without an app restart.
		 */
		private readonly isOpencodeServerEnabled: () => boolean = () => false,
		options: ProcessManagerOptions = {}
	) {
		super();
		this.isCoworkingEnabled = options.isCoworkingEnabled ?? (() => true);
		this.spawnAuthority = options.spawnAuthority ?? (() => null);
		this.userDataDir = options.userDataDir ?? null;
		// A lease ends with the process it was bound to. A stale exit (one from a
		// process a newer spawn has already replaced) finds the newer entry in
		// the map and leaves the newer lease alone.
		this.on('exit', (sessionId: string, code: number, signal?: number) => {
			if (this.processes.has(sessionId)) return;
			this.releaseLease(sessionId, {
				outcome: 'exited',
				exitCode: code,
				signal: signal === undefined ? null : String(signal),
			});
		});
		this.bufferManager = new DataBufferManager(this.processes, this);
		this.ptySpawner = new PtySpawner(this.processes, this, this.bufferManager);
		this.childProcessSpawner = new ChildProcessSpawner(this.processes, this, this.bufferManager);
		// The OpenCode SDK path falls back to the CLI spawner when the shared
		// server can't start, so local OpenCode never regresses to "broken".
		this.opencodeServerSpawner = new OpencodeServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.childProcessSpawner.spawn(config),
			{ effects: () => this.spawnAuthority()?.effects ?? null }
		);
		// Same contract for Codex: a turn the app-server transport cannot carry,
		// or whose server will not start, runs on `codex exec` instead.
		this.codexAppServerSpawner = new CodexAppServerSpawner(
			this.processes,
			this,
			this.bufferManager,
			(config) => this.childProcessSpawner.spawn(config),
			{
				clientVersion: options.appVersion,
				// The effect authority of the managed host, read live like the port.
				effects: () => this.spawnAuthority()?.effects ?? null,
			}
		);
		this.localCommandRunner = new LocalCommandRunner(this);
		this.sshCommandRunner = new SshCommandRunner(this);
	}

	/**
	 * Whether a terminal spawn for this session would attach to a live PTY
	 * instead of starting one (the `reuseTerminal` rule in `spawn()`). A sink
	 * that keeps one PTY across clients (the web terminal) asks this before it
	 * asks for a new admission: an attach runs under the lease the PTY already
	 * holds, and under management only the actor it was admitted for attaches.
	 */
	terminalAttachable(sessionId: string): boolean {
		const existing = this.processes.get(sessionId);
		return !!(
			existing?.isTerminal &&
			(existing.ptyProcess ||
				(existing.childProcess &&
					existing.childProcess.exitCode === null &&
					!existing.childProcess.signalCode))
		);
	}

	/**
	 * Spawn a new process for a session.
	 *
	 * Live AI processes own their sessionId until they exit. Canonical terminal-tab
	 * creation attaches to a live handle; generic terminal spawn can still replace it.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const existing = this.processes.get(config.sessionId);
		if (
			config.reuseTerminal &&
			!config.promptArtifact &&
			config.toolType === 'terminal' &&
			existing &&
			this.terminalAttachable(config.sessionId)
		) {
			return { pid: existing.pid, success: true, attached: true };
		}

		// Managed admission at the sink, before any branch: on a managed host the
		// config must carry an admission this manager minted, still live, for
		// exactly this request. Checked on the config as received, which is the
		// config the admission was asked for; everything below derives from it.
		const admitted = this.checkAdmissionAtSink(config);
		if (!admitted.ok) {
			logger.warn('[ProcessManager] Refusing to spawn: managed admission', 'ProcessManager', {
				sessionId: config.sessionId,
				toolType: config.toolType,
				state: admitted.state,
				code: admitted.code,
				message: admitted.message,
			});
			this.emit('agent-error', config.sessionId, {
				type: 'unknown',
				message: admitted.message,
				recoverable: false,
				agentId: config.toolType,
				sessionId: config.sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return {
				pid: -1,
				success: false,
				error: admitted.message,
				managed: { state: admitted.state, code: admitted.code },
			};
		}
		const lease = admitted.lease;
		// Only the child-process sink owns prompt files. Refuse before attaching,
		// replacing an existing process or selecting a transport that drops them.
		if (
			config.promptArtifact &&
			(config.toolType === 'terminal' ||
				this.shouldUsePty(config) ||
				this.shouldUseOpencodeServer(config) ||
				this.shouldUseCodexAppServer(config))
		) {
			const message = 'Prompt-file delivery is unavailable on this transport. Nothing was started.';
			lease?.release({ outcome: 'spawn-failed', message });
			this.emit('agent-error', config.sessionId, {
				type: 'unknown',
				message,
				recoverable: false,
				agentId: config.toolType,
				sessionId: config.sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return { pid: -1, success: false, error: message };
		}
		// Expand a leading `~` in the working directory before spawning. node-pty
		// and child_process hand `cwd` straight to the OS, which - unlike a shell -
		// does not expand `~`. A session whose cwd is persisted as `~/project` (or
		// bare `~`) would otherwise make the child's chdir() fail, leaving the shell
		// in an invalid/unreadable directory. On macOS that surfaces on every shell
		// startup as `Error: The current working directory must be readable to
		// <user> to run brew`. The spawned process is always local (even the SSH
		// client runs locally, with the remote `cd` injected into its args), so a
		// literal `~` cwd is never intentional here. See issue #1173.
		if (config.cwd) {
			const expandedCwd = expandTilde(config.cwd);
			if (expandedCwd !== config.cwd) {
				config = { ...config, cwd: expandedCwd };
			}
		}

		// Refuse a working directory that is not there, rather than handing it to
		// the OS. node-pty's Windows path throws ERROR_DIRECTORY asynchronously
		// from a callback nothing can catch, which crashes the main process and
		// leaves the caller retrying - see utils/spawnCwd.ts for the full trace.
		//
		// Failing is the right answer rather than falling back to the home
		// directory: an agent silently pointed at the wrong tree would read and
		// edit files nobody asked it to.
		const cwdProblem = unusableCwdReason(config.cwd);
		if (cwdProblem) {
			logger.error(`[ProcessManager] Refusing to spawn: ${cwdProblem}`, 'ProcessManager', {
				sessionId: config.sessionId,
				toolType: config.toolType,
				cwd: config.cwd,
			});
			this.emit('agent-error', config.sessionId, {
				type: 'unknown',
				message: cwdProblem,
				recoverable: false,
				agentId: config.toolType,
				sessionId: config.sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return { pid: -1, success: false };
		}

		// Never replace an AI process while it still owns the session entry. Node's
		// `exit` event can set exitCode before `close` drains stdout, so exitCode is
		// not enough to prove that the final response has been reconciled. The exit
		// handler removes the entry before emitting `exit`, which lets replay flows
		// start the next process without racing the old process's trailing output.
		// Terminals intentionally keep their existing restart behavior.
		if (existing) {
			const childProcessRunning =
				existing.childProcess !== undefined &&
				existing.childProcess.exitCode === null &&
				(existing.childProcess.signalCode === null ||
					existing.childProcess.signalCode === undefined);
			const existingProcessRunning =
				childProcessRunning ||
				existing.ptyProcess !== undefined ||
				existing.sdkController !== undefined;

			if (!existing.isTerminal) {
				// An agent entry is only ever removed by the exit handler, so an entry
				// that is still here while its OS process is gone means `close` never
				// arrived and never will (reported after the machine idled for hours:
				// the child died without us seeing the event). Left alone, that entry
				// owns the session id forever and every later turn throws, with no way
				// back short of restarting the app. See issue #1339.
				//
				// The reconciliation is deliberately narrow so it cannot reopen the
				// lost-response race from #1249. There, node HAD seen the child exit
				// (`exitCode` is set) while `close` was still draining trailing stdout
				// microseconds later, so anything node knows has exited stays refused.
				// We only reclaim the opposite state: node still believes the child is
				// running, yet the OS says the PID is gone. The two are disjoint, so
				// the drain window keeps its protection.
				//
				// SDK-backed turns have no OS child of their own, so a liveness probe
				// would be meaningless (and could match an unrelated recycled PID);
				// they keep the strict refusal.
				const nodeObservedExit = existing.childProcess !== undefined && !childProcessRunning;
				const isStaleEntry =
					!nodeObservedExit && existing.sdkController === undefined && !isPidAlive(existing.pid);

				if (!isStaleEntry) {
					logger.warn(
						'[ProcessManager] Refusing to replace owned agent process',
						'ProcessManager',
						{
							sessionId: config.sessionId,
							existingPid: existing.pid,
							existingToolType: existing.toolType,
							requestedToolType: config.toolType,
						}
					);
					throw new Error(agentAlreadyRunningMessage(config.sessionId));
				}

				logger.warn(
					'[ProcessManager] Reclaiming stale agent process entry (PID no longer exists)',
					'ProcessManager',
					{
						sessionId: config.sessionId,
						stalePid: existing.pid,
						existingToolType: existing.toolType,
						requestedToolType: config.toolType,
					}
				);
				// The local PID is gone, but a remote prompt reader can outlive its
				// SSH client. Hand cleanup to that owner before replacing the entry.
				if (existing.sshRemotePromptArtifactPath !== undefined) {
					this.signalRemote(config.sessionId, existing, 'terminate');
				}
				this.processes.delete(config.sessionId);
				this.releaseLease(config.sessionId, {
					outcome: 'unknown',
					message: 'The process vanished without an observed exit.',
				});
			} else if (existingProcessRunning) {
				logger.warn('[ProcessManager] Restarting existing terminal process', 'ProcessManager', {
					sessionId: config.sessionId,
					existingPid: existing.pid,
				});
				this.kill(config.sessionId);
			} else {
				this.processes.delete(config.sessionId);
			}
		}

		// Decide the OpenCode SDK-serve path on the RAW config, before any coworking
		// env injection. The serve transport uses a single, process-wide `opencode
		// serve` keyed by an env fingerprint (OpencodeServerManager.buildServerKey);
		// injecting the per-session MAESTRO_COWORKING_SESSION_ID here would fingerprint
		// into a distinct server per session, fragmenting the shared server. Coworking
		// over the serve transport needs a per-request mechanism (tracked follow-up),
		// so we skip injection on this path. The coworking bridge fails closed for the
		// resulting env-less MCP subprocess (its parent is the shared serve PID, not a
		// tracked agent CLI), so the tools are cleanly unavailable, never mis-scoped.
		if (this.shouldUseOpencodeServer(config)) {
			const serveResult = this.withLease(config, lease, () =>
				this.opencodeServerSpawner.spawn(config)
			);
			// The same `spawn` seam the CLI path emits below. This transport
			// reports `exit` through the shared handlers, so a listener that pairs
			// the two would otherwise see every turn here end without a start.
			if (serveResult.success) this.emitSpawn(config);
			return serveResult;
		}

		// Inject the *owning Maestro session id* into the agent CLI's env so the
		// coworking MCP subprocess (spawned by the agent's MCP client, inheriting
		// parent env) can announce the correct caller key to the bridge. We must
		// strip the `-ai-{tabId}[-fp-{ts}]` composite suffix that ProcessManager
		// uses for AI-tab spawns, because the registry pushes terminal records
		// keyed by the bare Session.id from the renderer. Without this, the
		// bridge handshake binds to a session id that never has records in the
		// registry → `list_terminals` returns [] for the caller's own session.
		// Terminals don't run MCP clients, so we skip them, and nothing is
		// injected while the coworking Encore flag is off. Spawn-callers can
		// override by passing the var explicitly in customEnvVars.
		//
		// We ALSO inject the owning window's bridge socket path
		// (MAESTRO_COWORKING_SOCKET_OVERRIDE). The socket baked into the shared
		// user-level MCP config is a single global value (last install wins), so
		// with multiple windows open an agent could dial the wrong window's bridge.
		// This override is recomputed per spawn from THIS window's userData and the
		// MCP server script prefers it, so env-propagating CLIs (Claude Code,
		// OpenCode) bind to the window that spawned them and self-heal when the
		// config socket is stale. Codex does not propagate env and falls back to the
		// config socket (single-window).
		const coworkingInjected = config.toolType !== 'terminal' && this.isCoworkingEnabled();
		const configWithCoworkingSession = !coworkingInjected
			? config
			: {
					...config,
					customEnvVars: {
						[COWORKING_SESSION_ID_ENV_VAR]: resolveOwningMaestroSessionId(config.sessionId),
						[COWORKING_SOCKET_OVERRIDE_ENV_VAR]: getBridgeSocketPath(),
						...(config.customEnvVars ?? {}),
					},
				};

		// A managed local interactive Claude turn (maestro-p) carries the host's
		// signed admission handshake into the TUI's environment (MRC2-03-05A):
		// a host-derived fact of the lease just checked, stamped here after the
		// environment ceiling and the admission, never in the request the
		// snapshot digests (the handler builds the maestro-p env before the
		// admission). A refusal to build one refuses the spawn by name; nothing
		// managed spawns the TUI unchecked. A standalone host stamps nothing.
		const handshake = lease ? this.tuiHandshakeFor(configWithCoworkingSession, lease) : null;
		if (handshake && !handshake.ok) {
			lease?.release({ outcome: 'spawn-failed', message: handshake.message });
			logger.error('[ProcessManager] Refusing to spawn: TUI handshake', 'ProcessManager', {
				sessionId: config.sessionId,
				toolType: config.toolType,
				message: handshake.message,
			});
			this.emit('agent-error', config.sessionId, {
				type: 'permission_denied',
				message: handshake.message,
				recoverable: false,
				agentId: config.toolType,
				sessionId: config.sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return {
				pid: -1,
				success: false,
				error: handshake.message,
				managed: { state: 'denied', code: 'policy-denied' },
			};
		}
		// Every local maestro-p launch, managed or not, gets a per-run steering
		// token (MRC2-03-06A): minted here at the sink and stamped on the
		// spawner's env beside the handshake, a host-derived fact the request
		// the lease digests never carries. Once sent, maestro-p acts on no frame
		// without it, so the record below is what lets `steer()` prove a frame
		// is this host's for this run.
		const steering = this.steeringCredentialsFor(configWithCoworkingSession, lease);
		// A managed spawn that carries the coworking env also carries the run
		// it was admitted on (MRC2-04-08B): the bundled MCP server forwards it
		// in its handshake and the bridge holds the connection to the lease
		// still bound here. Stamped after the ceiling, like the handshake.
		const runAdmission =
			lease && coworkingInjected && config.admission
				? this.runAdmissionOf(config.admission, lease)
				: null;
		const stamped: Record<string, string> = {
			...(handshake && handshake.ok ? handshake.env : {}),
			...(steering ? { [STEERING_TOKEN_ENV_VAR]: steering.token } : {}),
			...(runAdmission
				? { [COWORKING_RUN_ADMISSION_ENV_VAR]: encodeCoworkingRunAdmission(runAdmission) }
				: {}),
		};
		const configToSpawn =
			Object.keys(stamped).length > 0
				? {
						...configWithCoworkingSession,
						customEnvVars: {
							...(configWithCoworkingSession.customEnvVars ?? {}),
							...stamped,
						},
					}
				: configWithCoworkingSession;

		// The Codex app-server child is spawned per turn (no shared server to
		// fingerprint, unlike OpenCode serve), so it takes the coworking env like
		// any CLI spawn and is routed after the injection.
		const result = this.withLease(config, lease, () => {
			if (this.shouldUseCodexAppServer(configToSpawn)) {
				return this.codexAppServerSpawner.spawn(configToSpawn);
			}
			if (this.shouldUsePty(configToSpawn)) {
				return this.ptySpawner.spawn(configToSpawn);
			}
			return this.childProcessSpawner.spawn(configToSpawn);
		});

		if (result.success) {
			// The spawner registered the record synchronously; the token lives
			// with the process it was minted for and leaves with it on exit.
			if (steering) {
				const proc = this.processes.get(config.sessionId);
				if (proc) proc.steering = steering;
			}
			this.emitSpawn(config);
		}

		return result;
	}

	/**
	 * The steering credentials of a local maestro-p launch, or null for every
	 * other spawn (nothing else serves the channel). The token is fresh per
	 * run; the identity is the admission's lease and attempt when the launch
	 * was admitted (the same ids the handshake names, so the TUI's two checks
	 * agree), null on a standalone host.
	 */
	private steeringCredentialsFor(
		config: ProcessConfig,
		lease: DispatchLease | null
	): ProcessSteeringCredentials | null {
		if (!localTuiLaunchOf(config)) return null;
		const admission = lease ? config.admission : undefined;
		return {
			token: randomBytes(STEERING_TOKEN_BYTES).toString('hex'),
			run: admission ? { leaseId: admission.leaseId, attemptId: admission.attemptId } : null,
		};
	}

	/** The run identity of one admitted spawn: the lease's, as the TUI handshake and the coworking stamp both name it. */
	private runAdmissionOf(
		admission: ProcessSpawnAdmission,
		lease: DispatchLease
	): CoworkingRunAdmission {
		return {
			leaseId: admission.leaseId,
			authorityId: admission.authorityId,
			attemptId: admission.attemptId,
			requestId: admission.requestId,
			runId: lease.runId,
			policyRevision: admission.policyRevision,
		};
	}

	/**
	 * The handshake env for a managed spawn, or null when the spawn is not a
	 * local maestro-p launch (the TUI is the only child that spawns a provider
	 * of its own outside this sink). The binary is the exact `MAESTRO_CLAUDE_BIN`
	 * the interactive decision set (what the TUI will compare its own
	 * resolution to), the arguments are the ones after the maestro-p script,
	 * the ceiling is the launch plan's decision for this spawn, and the run is
	 * the lease's. `MAESTRO_USER_DATA` is restated beside it so the TUI looks
	 * for the key where this host minted it, whatever the inherited env says.
	 */
	private tuiHandshakeFor(
		config: ProcessConfig,
		lease: DispatchLease
	): { ok: true; env: Record<string, string> } | { ok: false; message: string } | null {
		const launch = localTuiLaunchOf(config);
		if (!launch) return null;
		const refuse = (reason: string) => ({
			ok: false as const,
			message: `This host runs under management and the maestro-p admission handshake could not be built: ${reason}. Nothing was started.`,
		});
		const admission = config.admission;
		if (!admission) return refuse('the launch carries no admission');
		if (!launch.claudeBinPath) return refuse('the launch names no MAESTRO_CLAUDE_BIN');
		if (!this.userDataDir) {
			return refuse('this host names no data directory to keep the handshake key in');
		}
		let key: string;
		try {
			key = loadOrCreateTuiHandshakeKey(this.userDataDir);
		} catch (error) {
			return refuse(`the handshake key could not be loaded: ${(error as Error).message}`);
		}
		const built = buildTuiHandshake({
			key,
			run: this.runAdmissionOf(admission, lease),
			binaryPath: launch.claudeBinPath,
			args: launch.args,
			permissionMode: config.permission?.ceiling ?? null,
			digestFile: this.digestFile,
		});
		if (!built.ok) return refuse(built.reason);
		return {
			ok: true,
			env: { [TUI_HANDSHAKE_ENV_VAR]: built.encoded, MAESTRO_USER_DATA: this.userDataDir },
		};
	}

	// ── Managed admission ────────────────────────────────────────────────

	/**
	 * Ask the host authority to admit one spawn for the actor the transport
	 * resolved. Standalone hosts need no admission and get `standalone`. On a
	 * managed host the request snapshot is built from `config` exactly as
	 * `spawn()` will receive it (so pass the same object, with `admission`
	 * added), the actor is bound into a verified context, and the authority's
	 * answer is returned as it is: nothing but `admitted` leads anywhere.
	 *
	 * A chat turn is its own request and is bound under a fresh identity. An
	 * Auto Run attempt (`config.autoRun`) is bound on its lineage instead: the
	 * task request and attempt ids, the run under the workflow's root run, the
	 * workflow reference with its owner fence, and the lineage's trace id. The
	 * fence of a lineage that arrives unowned is CLAIMED here, through the
	 * port's workflow owner producer, for this very attempt and before the
	 * context is verified (`autoRunFenceFor`); the producer's refusal is the
	 * answer, with its state and code, and a workflow left with no fence (no
	 * producer on this host) is refused `unavailable` before the authority is
	 * asked: a managed host does not run an unowned workflow, and this sink
	 * does not mint a fence (CP-03, the workflow owner producer).
	 *
	 * A dispatched turn (`config.delegation`, the record `maestro-cli dispatch`
	 * read off its environment) is bound as the dispatching operation's child
	 * (`childDelegationContext`), never as a fresh chat turn, and the
	 * initiator's scope is met with THIS host's standing first: a managed
	 * initiator's child on a host with no enrollment is refused `unavailable`
	 * rather than run unmanaged in its place, and a managed host admits it
	 * under its own current policy generation, whatever the initiator claimed.
	 */
	async admitSpawn(
		config: ProcessConfig,
		actor: ProcessSpawnActor
	): Promise<ProcessSpawnAdmissionOutcome> {
		const port = this.spawnAuthority();
		const managed = port && port.standing() === 'managed' ? port : null;
		const carried = config.delegation;
		if (carried) {
			const problems = delegationContextProblems(carried);
			if (problems.length > 0) {
				return {
					state: 'denied',
					code: 'invalid-input',
					message: `The spawn carries a delegation context that is not one, and is not started as a fresh action of the target: ${problems.join('; ')}. Nothing was started.`,
				};
			}
			const scope = intersectDelegationScope(carried, {
				standing: managed ? 'managed' : 'standalone',
				policyRevision: managed ? managed.policy().policyRevision : null,
			});
			if (!scope.ok) return { state: scope.state, code: scope.code, message: scope.message };
		}
		if (!managed) return { state: 'standalone' };

		const lineage = config.autoRun;
		if (lineage && carried) {
			return {
				state: 'denied',
				code: 'invalid-input',
				message:
					'The spawn carries both an Auto Run lineage and a delegation context; a turn is one attempt of a workflow or the child of a dispatching operation, never both. Nothing was started.',
			};
		}
		// The attempt is bound on the fence it arrived with or the one claimed
		// for it now; the snapshot below is still built from `config` as the
		// handler will spawn it, so the lease covers the request unchanged.
		let bound = config;
		if (lineage) {
			const fence = await autoRunFenceFor(managed, lineage);
			if (isWorkflowFenceRefusal(fence)) {
				return { state: fence.state, code: fence.code, message: fence.message };
			}
			if (!fence) {
				const producer = managed.workflowFence
					? 'the workflow owner producer answered none'
					: 'this host has no workflow owner producer to claim one through';
				return {
					state: 'unavailable',
					code: 'runtime-unavailable',
					message: `Auto Run "${lineage.attribution.workflow.workflowId}" has no workflow owner fence (${producer}); a managed host does not run an unowned workflow, and this host does not mint one (CP-03, the workflow owner producer). Nothing was started.`,
				};
			}
			bound = { ...config, autoRun: { attribution: lineage.attribution, fence } };
		}
		const policy = managed.policy();
		const verified = managed.verify({
			actor,
			policyRevision: policy.policyRevision,
			...spawnContextInput(bound),
		});
		if (!verified.ok) {
			return {
				state: 'denied',
				code: verified.code,
				message: `The spawn's actor could not be bound: ${verified.problems.join('; ')}.`,
			};
		}
		const snapshot = buildSpawnRequestSnapshot(config);
		const outcome = await managed.authority.admit({ context: verified.context, snapshot, policy });
		if (outcome.state !== 'admitted') {
			return { state: outcome.state, code: outcome.code, message: outcome.message };
		}
		const { lease } = outcome;
		const admission: ProcessSpawnAdmission = Object.freeze({
			leaseId: lease.leaseId,
			authorityId: lease.authorityId,
			requestDigest: dispatchSnapshotDigest(snapshot),
			actor: lease.actor,
			provider: snapshot.provider,
			operation: snapshot.operation,
			target: snapshot.target,
			policyRevision: lease.policyRevision,
			requestId: verified.context.identity.requestId,
			attemptId: lease.attemptId,
		});
		this.admissionLeases.set(admission, lease);
		return { state: 'admitted', admission };
	}

	/**
	 * `admitSpawn` then `spawn`, the way a handler that resolved its actor
	 * uses them: a standalone host spawns as before, an admitted spawn carries
	 * its admission, and a refusal is returned as a failed `SpawnResult` with
	 * the authority's state and code (and reported to the tab as an
	 * `agent-error`, since no process exists to report it).
	 */
	async spawnAdmitted(config: ProcessConfig, actor: ProcessSpawnActor): Promise<SpawnResult> {
		const admitted = await this.admitSpawn(config, actor);
		if (admitted.state === 'standalone') return this.spawn(config);
		if (admitted.state === 'admitted') {
			return this.spawn({ ...config, admission: admitted.admission });
		}
		logger.warn('[ProcessManager] Spawn not admitted', 'ProcessManager', {
			sessionId: config.sessionId,
			toolType: config.toolType,
			state: admitted.state,
			code: admitted.code,
			message: admitted.message,
		});
		this.emit('agent-error', config.sessionId, {
			type: 'unknown',
			message: admitted.message,
			recoverable: false,
			agentId: config.toolType,
			sessionId: config.sessionId,
			timestamp: Date.now(),
		} satisfies AgentError);
		return {
			pid: -1,
			success: false,
			error: admitted.message,
			managed: { state: admitted.state, code: admitted.code },
		};
	}

	/**
	 * The sink's own check, right before a branch is chosen: is this host
	 * managed, and if so does the config carry an admission this manager
	 * minted, whose lease the authority still holds live for the digest of
	 * exactly this request? A standalone host passes with no lease.
	 */
	private checkAdmissionAtSink(
		config: ProcessConfig
	):
		| { ok: true; lease: DispatchLease | null }
		| { ok: false; state: 'denied' | 'unavailable'; code: ManagedDenialCode; message: string } {
		const port = this.spawnAuthority();
		if (!port || port.standing() === 'standalone') return { ok: true, lease: null };
		const refuse = (message: string) => ({
			ok: false as const,
			state: 'denied' as const,
			code: 'lease-invalid' as const,
			message: `This host runs under management and ${message}`,
		});
		const admission = config.admission;
		if (!admission) return refuse('the launch carries no admission.');
		const lease = this.admissionLeases.get(admission);
		if (!lease) return refuse('the launch carries an admission this host did not mint.');
		const verdict = port.authority.check(
			lease,
			dispatchSnapshotDigest(buildSpawnRequestSnapshot(config))
		);
		if (!verdict.ok) return refuse(`the lease for this launch is ${verdict.reason}.`);
		return { ok: true, lease };
	}

	/**
	 * Run one spawner under a lease: bind the lease to the process it started
	 * (a server-backed transport has no pid of its own and binds `undefined`),
	 * terminate the process when the authority revokes the lease, release it
	 * when the spawner failed or threw. Without a lease the spawner just runs.
	 */
	private withLease(
		config: ProcessConfig,
		lease: DispatchLease | null,
		run: () => SpawnResult
	): SpawnResult {
		if (!lease) return run();
		const { sessionId } = config;
		let result: SpawnResult;
		try {
			result = run();
		} catch (error) {
			lease.release({
				outcome: 'spawn-failed',
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		if (!result.success) {
			lease.release({ outcome: 'spawn-failed', message: result.error ?? 'The spawn failed.' });
			return result;
		}
		lease.bind(result.pid > 0 ? result.pid : undefined);
		const unsubscribe = lease.onRevoked((reason) => {
			logger.warn('[ProcessManager] Lease revoked; stopping process', 'ProcessManager', {
				sessionId,
				leaseId: lease.leaseId,
				reason,
			});
			this.boundLeases.delete(sessionId);
			this.kill(sessionId);
		});
		this.boundLeases.set(sessionId, { lease, admission: config.admission!, unsubscribe });
		const proc = this.processes.get(sessionId);
		if (proc) proc.admission = config.admission;
		return result;
	}

	/**
	 * Why input into a session's process is refused under management, or null
	 * when it may be written: the host is standalone, or the process carries an
	 * admission this manager minted whose lease is still bound to it.
	 */
	private managedWriteRefusal(sessionId: string, proc: ManagedProcess): string | null {
		const port = this.spawnAuthority();
		if (!port || port.standing() === 'standalone') return null;
		const what = proc.isTerminal ? 'terminal' : 'process';
		if (!proc.admission) {
			return `This host runs under management and this ${what} was started without an admission; input to it is unavailable.`;
		}
		const bound = this.boundLeases.get(sessionId);
		if (!bound || bound.admission !== proc.admission) {
			return `This host runs under management and this ${what} carries an admission that is not bound here; input to it is unavailable.`;
		}
		const state = bound.lease.state();
		if (state !== 'bound') {
			return `This host runs under management and the lease for this ${what} is ${state}; input to it is unavailable.`;
		}
		return null;
	}

	/** What the one-off command sinks are told about the host. */
	private managedCommandContext(): ManagedCommandContext {
		const port = this.spawnAuthority();
		return { standing: !port ? 'standalone' : port.standing() };
	}

	/** Release the lease bound to a session's process, if one is. Idempotent. */
	private releaseLease(sessionId: string, release: LeaseRelease): void {
		const bound = this.boundLeases.get(sessionId);
		if (!bound) return;
		this.boundLeases.delete(sessionId);
		bound.unsubscribe();
		bound.lease.release(release);
	}

	/** The admission a session's live process runs under, if it was admitted. */
	admissionOf(sessionId: string): ProcessSpawnAdmission | null {
		return this.boundLeases.get(sessionId)?.admission ?? null;
	}

	/** Whether a session's admission is still bound to its process. */
	admissionLive(sessionId: string): { ok: true } | { ok: false; reason: string } {
		const bound = this.boundLeases.get(sessionId);
		if (!bound) return { ok: false, reason: 'no admission is bound to this session.' };
		const state = bound.lease.state();
		return state === 'bound'
			? { ok: true }
			: { ok: false, reason: `the lease for this session is ${state}.` };
	}

	/** The host authority port this manager admits with, read live. */
	managedPort(): ProcessSpawnAuthorityPort | null {
		return this.spawnAuthority();
	}

	/**
	 * The run admissions still bound to an agent's live processes, by the
	 * owning Maestro session id the coworking bridge binds a handshake to (a
	 * tab's composite id resolves to its agent), or null on a standalone host,
	 * where no spawn carries one and the bridge checks nothing (MRC2-04-08B).
	 * A released or revoked lease is not listed: its process is gone or going.
	 */
	coworkingAdmissionsOf(owningSessionId: string): CoworkingRunAdmission[] | null {
		const port = this.spawnAuthority();
		if (!port || port.standing() === 'standalone') return null;
		const runs: CoworkingRunAdmission[] = [];
		for (const [sessionId, bound] of this.boundLeases) {
			if (resolveOwningMaestroSessionId(sessionId) !== owningSessionId) continue;
			if (bound.lease.state() !== 'bound') continue;
			runs.push(this.runAdmissionOf(bound.admission, bound.lease));
		}
		return runs;
	}

	/**
	 * Emit a spawn event AFTER the spawner returns so the agent-run capture
	 * service only records a running run for a process that actually started
	 * (symmetric with the 'exit' seam; no orphan on spawn failure). Guarded: a
	 * capture listener throwing must never break spawning.
	 */
	private emitSpawn(config: ProcessConfig): void {
		try {
			if (config.promptArtifact) {
				// Project lifecycle metadata only. Args, stdin scripts, images and
				// prompt callbacks can carry private file content or destinations.
				// Keep the admitted/spawned request intact; this copy is observational.
				const captureConfig: ProcessConfig = {
					sessionId: config.sessionId,
					toolType: config.toolType,
					cwd: config.cwd,
					command: config.command,
					args: [],
					querySource: config.querySource,
					tabId: config.tabId,
					projectPath: config.projectPath,
					agentSessionId: config.agentSessionId,
					sshRemoteId: config.sshRemoteId,
					sshRemoteHost: config.sshRemoteHost,
					purpose: config.purpose,
					origin: config.origin,
					utilityOf: config.utilityOf,
					admission: config.admission,
					autoRun: config.autoRun,
					delegation: config.delegation,
					dispatchedAs: config.dispatchedAs,
				};
				this.emit('spawn', captureConfig);
			} else {
				this.emit('spawn', config);
			}
		} catch {
			// Capture is best-effort; never let it break process spawning.
		}
	}

	private shouldUsePty(config: ProcessConfig): boolean {
		const { toolType, requiresPty, prompt } = config;
		return (toolType === 'terminal' || requiresPty === true) && !prompt;
	}

	/**
	 * Route local, interactive OpenCode prompt turns through the SDK server path,
	 * gated behind the default-off `encoreFeatures.opencodeServer` plugin.
	 *
	 * Excluded (stay on the CLI path):
	 * - SSH-remote sessions (the SDK server spawn is local-only; deferred).
	 * - Image prompts (handled by the CLI's file-based `-f` args; the SDK path is
	 *   text-only for now and falls back anyway).
	 * - Non-prompt spawns (the SDK path is prompt-driven).
	 */
	private shouldUseOpencodeServer(config: ProcessConfig): boolean {
		return (
			// Default-off plugin gate (encoreFeatures.opencodeServer). While it is
			// off, OpenCode stays on the CLI path - which keeps the Coworking MCP
			// working, since the serve transport can't inject per-session env.
			this.isOpencodeServerEnabled() &&
			config.toolType === 'opencode' &&
			!!config.prompt &&
			!config.sshRemoteId &&
			!(config.images && config.images.length > 0)
		);
	}

	/**
	 * Route a Codex turn through `codex app-server` (steerable mid-turn) instead
	 * of `codex exec --json`. Opt-in per agent (`codexTransport`), and only for an
	 * INTERACTIVE turn (`wantsCodexAppServer`, which the SSH spawn handler also
	 * reads before it builds an app-server launch).
	 *
	 * The config-level exclusions (no prompt, images, an SSH turn with no
	 * app-server launch, a prompt already in the args) are the spawner's own
	 * `codexAppServerConfigBlocker`, so routing and the spawner cannot disagree
	 * about which turns app-server can carry. The spawner still re-checks the
	 * args and falls back to exec for anything it does not recognize.
	 */
	private shouldUseCodexAppServer(config: ProcessConfig): boolean {
		return wantsCodexAppServer(config) && codexAppServerConfigBlocker(config) === null;
	}

	/**
	 * Ask a running turn to take `text` into the turn in flight (chat steering):
	 * a Claude turn on maestro-p, or a Codex turn on the app-server transport.
	 * Resolves with a verdict for the UI; never rejects. The later verdict for a
	 * delivered steer is emitted as `steering-verdict` with the same id: for
	 * maestro-p it arrives on stdout (StdoutHandler), for Codex it comes from
	 * `steerCodexAppServerTurn`.
	 *
	 * Requires the process to still be REGISTERED, checked here rather than left to
	 * the socket, because a finished turn and an un-steerable one need different
	 * words: "the turn has already finished" is actionable (send it normally) where
	 * "not steerable" invites the user to go looking for a setting.
	 *
	 * Everything else is deliberately NOT decided here. Whether the turn is on
	 * maestro-p at all is answered by whether a channel exists (the spawn opens one
	 * only for a local interactive turn), and whether the TUI can accept keystroke
	 * right now is answered by maestro-p, which is the only party holding the
	 * screen. Re-deriving either would mean two places believing different things
	 * about the same turn. A Codex process carries its own channel
	 * (`codexAppServer`, present only on the app-server path), so an exec turn has
	 * none and is refused by the socket client exactly like an unsteerable Claude
	 * turn.
	 *
	 * A maestro-p frame carries the run's authority from the process record
	 * (MRC2-03-06A): the token this sink minted at spawn and, under management,
	 * the admission identity. Every surface that steers through here (the
	 * desktop, `maestro-cli queue steer`, a group chat) therefore carries it
	 * without knowing it. A `not-authorized` verdict means the TUI holds a
	 * different token or admission than this record, which cannot happen for a
	 * process this sink spawned, so it is logged as well as answered.
	 */
	async steer(sessionId: string, text: string): Promise<SteeringResultFrame> {
		const id = randomUUID();
		const process = this.processes.get(sessionId);
		if (!process) {
			return {
				type: 'steering',
				id,
				verdict: 'refused',
				refusal: 'not-running',
				detail: STEERING_TURN_FINISHED_DETAIL,
			};
		}
		if (process.codexAppServer) {
			return steerCodexAppServerTurn(process.codexAppServer, { id, text }, (verdict) =>
				this.emit('steering-verdict', sessionId, verdict)
			);
		}
		const { steering } = process;
		const result = await sendSteeringRequest({
			processKey: sessionId,
			text,
			id,
			...(steering ? { token: steering.token } : {}),
			...(steering?.run ? { run: steering.run } : {}),
		});
		if (result.verdict === 'refused' && result.refusal === 'not-authorized') {
			logger.warn('[ProcessManager] Steer refused as not authorized', 'ProcessManager', {
				sessionId,
				steerId: id,
				hasToken: !!steering,
				hasRun: !!steering?.run,
				detail: result.detail,
			});
		}
		return result;
	}

	/**
	 * Write data to a process's stdin
	 */
	write(sessionId: string, data: string): boolean {
		const process = this.processes.get(sessionId);
		if (!process) {
			logger.error('[ProcessManager] write() - No process found for session', 'ProcessManager', {
				sessionId,
			});
			return false;
		}

		// A managed host drives only processes it admitted and whose lease is
		// still bound. A terminal or agent that predates the enrollment, one
		// spawned around the gate, or one whose lease ended gets no input.
		const blocked = this.managedWriteRefusal(sessionId, process);
		if (blocked) {
			logger.warn('[ProcessManager] write() refused under management', 'ProcessManager', {
				sessionId,
				isTerminal: process.isTerminal,
				message: blocked,
			});
			if (process.isTerminal) {
				this.emit('data', sessionId, `\r\n[Maestro] ${blocked}\r\n`);
			} else {
				this.emit('agent-error', sessionId, {
					type: 'unknown',
					message: blocked,
					recoverable: false,
					agentId: process.toolType,
					sessionId,
					timestamp: Date.now(),
				} satisfies AgentError);
			}
			return false;
		}

		try {
			if (process.isTerminal && process.ptyProcess) {
				const command = data.replace(/\r?\n$/, '');
				if (command.trim()) {
					process.lastCommand = command.trim();
				}
				process.ptyProcess.write(data);
				return true;
			} else if (process.childProcess?.stdin) {
				process.childProcess.stdin.write(data);
				return true;
			}
			return false;
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to write to process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Resize terminal (for pty processes)
	 */
	resize(sessionId: string, cols: number, rows: number): boolean {
		const process = this.processes.get(sessionId);
		if (!process || !process.isTerminal || !process.ptyProcess) return false;

		try {
			process.ptyProcess.resize(cols, rows);
			return true;
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to resize terminal', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Interrupt a process, the way the Stop button does.
	 *
	 * A pipe-backed agent goes through the shared stop ladder: SIGINT (Ctrl+C on
	 * stdin on Windows, where a signal does not reach a shell-spawned process),
	 * then SIGTERM or `taskkill /t /f` if it is still running after the grace
	 * period, then SIGKILL for its tree. Whatever the agent started is stopped
	 * with it.
	 *
	 * A PTY gets Ctrl+C and nothing more. A PTY process that survives Ctrl+C is
	 * the normal case, not a stuck one: a shell that cancelled a command, or a
	 * TUI that cancelled its turn and is waiting for the next prompt.
	 */
	interrupt(sessionId: string): boolean {
		const process = this.processes.get(sessionId);
		if (!process) return false;

		// Mark the turn as user-interrupted BEFORE signalling. `interrupt()` (unlike
		// `kill()`) leaves the process in the map, so its `close` still reaches
		// ExitHandler - which coerces the null signal code to 0. Without this flag,
		// an instant stop (no output yet) would look identical to a clean silent
		// crash and trip the "exited without producing a response" guard.
		process.interrupted = true;

		try {
			if (process.sdkController) {
				// Server-backed process (OpenCode SDK, Codex app-server): interrupt the
				// in-flight turn over its protocol; the controller escalates if needed.
				process.sdkController.interrupt();
				return true;
			} else if (process.isTerminal && process.ptyProcess) {
				process.ptyProcess.write('\x03');
				return true;
			} else if (process.childProcess) {
				stopProcess(
					{ child: process.childProcess },
					{
						from: 'interrupt',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						sessionId,
						label: 'interrupt',
					}
				);
				// The local child of an SSH spawn is only the ssh client; the agent on
				// the remote host never sees its signals. Ask the host to deliver them:
				// SIGINT now, SIGTERM if the turn is still running after the grace.
				this.signalRemote(sessionId, process, 'interrupt');
				this.scheduleRemoteTerminate(sessionId, process, process.childProcess);
				return true;
			}
			return false;
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to interrupt process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Kill a specific process, through the shared stop ladder.
	 *
	 * The ladder starts at SIGTERM and, if the process has not exited after the
	 * grace period, kills it with SIGKILL. On Windows the whole tree goes through
	 * `taskkill /t /f`, because node-pty and `child.kill()` end only the direct
	 * child. The process is removed from the tracking map immediately so that a
	 * replacement can be spawned; the ladder keeps its own reference to make sure
	 * the OS-level process dies.
	 *
	 * An agent's descendants are stopped with it. A terminal tab's are not: a
	 * job the user left running in their shell is theirs to keep, so only the
	 * shell is signalled, as before.
	 *
	 * `sync: true` blocks on `taskkill`, so the tree is gone before the app
	 * exits.
	 *
	 * `shutdown: true` is the app quitting. It sends exactly what quitting has
	 * always sent, at once, with no timer and no exit listener, and leaves the
	 * process's descendants alone:
	 * - a PTY gets SIGKILL directly. This collapses the window in which
	 *   node-pty's worker thread is still posting via napi_threadsafe_function
	 *   while Electron begins tearing down the Node environment - that race
	 *   aborts inside `ThreadSafeFunction::~ThreadSafeFunction → uv_mutex_lock`
	 *   on macOS (Sentry MAESTRO-3B).
	 * - a pipe-backed agent gets SIGTERM and nothing after it, so it can finish
	 *   writing its state (a transcript, a session file) before it exits. No
	 *   SIGKILL follows: there is no event loop left to wait out a grace period,
	 *   and one sent right behind the SIGTERM would take that chance away.
	 * - on Windows both go through a blocking `taskkill /t /f`.
	 */
	kill(
		sessionId: string,
		{ sync = false, shutdown = false }: { sync?: boolean; shutdown?: boolean } = {}
	): boolean {
		const proc = this.processes.get(sessionId);
		if (!proc) return false;

		// A kill is a stop Maestro asked for (a closed tab, the Process Monitor, a
		// watchdog), so the exit it causes is not a crash. The resolver reads any
		// signal it is not told about as an outside kill, which it is not here.
		proc.interrupted = true;
		// The lease ends with the process. A kill the authority asked for has
		// already revoked it, and a release after a revocation is a no-op.
		this.releaseLease(sessionId, { outcome: 'stopped', by: 'caller' });

		try {
			if (proc.dataBufferTimeout) {
				clearTimeout(proc.dataBufferTimeout);
			}
			this.bufferManager.flushDataBuffer(sessionId);

			if (proc.sdkController) {
				// Server-backed process (OpenCode SDK, Codex app-server): the stop
				// starts with a protocol call. The controller tears its transport down
				// (and runs the stop ladder on any child it owns); the exit event
				// follows from there. Fall through to the map deletion below.
				proc.sdkController.kill({ sync, shutdown });
			} else if (proc.isTerminal && proc.ptyProcess) {
				stopProcess(
					{ pty: proc.ptyProcess, pid: proc.pid },
					{
						from: shutdown ? 'kill' : 'terminate',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						immediate: shutdown,
						blocking: sync,
						includeDescendants: !shutdown && proc.toolType !== 'terminal',
						sessionId,
						label: 'kill',
					}
				);
			} else if (proc.childProcess) {
				this.signalRemote(sessionId, proc, 'terminate');
				stopProcess(
					{ child: proc.childProcess },
					{
						from: 'terminate',
						upTo: shutdown ? 'terminate' : 'kill',
						graceMs: INTERACTIVE_STOP_GRACE_MS,
						immediate: shutdown,
						blocking: sync,
						includeDescendants: !shutdown,
						sessionId,
						label: 'kill',
					}
				);
			}
			this.processes.delete(sessionId);
			return true;
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to kill process', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			return false;
		}
	}

	/**
	 * Deliver a signal to an SSH-hosted agent on its remote host. A no-op for
	 * local processes and for SSH spawns that recorded no remote pid.
	 */
	private signalRemote(sessionId: string, proc: ManagedProcess, mode: RemoteSignalMode): void {
		if (!proc.sshRemotePidFile || !proc.command || !proc.args) return;
		// Prompt-owner records require their artifact witness. Never send one
		// through the legacy signal script, which cannot preserve file ownership.
		if (
			proc.sshRemotePromptArtifactPath === undefined &&
			!proc.sshRemotePidFile.startsWith('/tmp/maestro-agent-')
		) {
			logger.warn('Remote signal ownership is unavailable', 'ProcessManager', { sessionId, mode });
			return;
		}
		signalRemoteAgent(
			{
				sshCommand: proc.command,
				sshArgs: proc.args,
				pidFile: proc.sshRemotePidFile,
				sessionId,
				...(proc.sshRemotePromptArtifactPath !== undefined
					? { promptArtifactPath: proc.sshRemotePromptArtifactPath }
					: {}),
			},
			mode
		);
	}

	/**
	 * The stop ladder escalates only the local ssh client. When an interrupted
	 * SSH agent has not exited after the grace period, ask its host for SIGTERM
	 * too. Local SSH exit does not prove a remote prompt reader has stopped;
	 * its owner must recheck remote PID and descriptor identity after the grace.
	 * Ordinary turns still stop escalating on observed exit, never `.killed`.
	 */
	private scheduleRemoteTerminate(
		sessionId: string,
		proc: ManagedProcess,
		child: NonNullable<ManagedProcess['childProcess']>
	): void {
		if (!proc.sshRemotePidFile) return;
		const timer = setTimeout(() => {
			if (
				proc.sshRemotePromptArtifactPath !== undefined ||
				(child.exitCode === null && child.signalCode === null)
			) {
				this.signalRemote(sessionId, proc, 'terminate');
			}
		}, INTERACTIVE_STOP_GRACE_MS);
		if (proc.sshRemotePromptArtifactPath === undefined) {
			child.once('exit', () => clearTimeout(timer));
		} else {
			timer.unref?.();
		}
	}

	/**
	 * Kill all managed processes.
	 * Snapshots the session IDs first because kill() deletes from the map.
	 *
	 * `shutdown: true` enables SIGKILL-immediate semantics for PTYs to avoid
	 * the libuv/N-API teardown race that aborts the main process during
	 * Electron environment cleanup (see kill() docs).
	 */
	killAll({ shutdown = false }: { shutdown?: boolean } = {}): void {
		const sessionIds = [...this.processes.keys()];
		for (const sessionId of sessionIds) {
			// Use sync kills so process trees are dead before the app exits.
			// On Windows this blocks briefly per process (taskkill is fast),
			// on POSIX this has no effect (SIGTERM is already non-blocking).
			this.kill(sessionId, { sync: true, shutdown });
		}
		// Tear down the shared OpenCode server(s) that back the SDK path.
		opencodeServerManager.shutdown();
	}

	/**
	 * Get all active processes
	 */
	getAll(): ManagedProcess[] {
		return Array.from(this.processes.values());
	}

	/**
	 * Get a specific process
	 */
	get(sessionId: string): ManagedProcess | undefined {
		return this.processes.get(sessionId);
	}

	/**
	 * Re-emit a corrected `usage` event for a local omp process whose model
	 * context window could not be resolved when its first usage arrived, because
	 * the catalog prime was still running. Called by the spawn handler when a
	 * prime that exceeded the spawn cap finally lands.
	 *
	 * @returns true when a corrected event was emitted.
	 */
	pushResolvedOmpContextWindow(sessionId: string, catalogKey: string): boolean {
		return pushResolvedOmpContextWindow(this.processes, this, sessionId, catalogKey);
	}

	/**
	 * Look up the *owning Maestro session id* for a given OS PID, or null if
	 * the PID does not match any tracked agent-CLI process. Used by the
	 * coworking bridge to bind a connection when an agent CLI (e.g. Codex)
	 * does not propagate `MAESTRO_COWORKING_SESSION_ID` into the MCP
	 * subprocess it spawned - the subprocess instead sends `process.ppid`
	 * during handshake and we walk the parent chain to find the owning agent.
	 *
	 * Terminals are excluded: they don't spawn MCP clients, and skipping them
	 * preserves the property that only AI-tab processes can ever satisfy a
	 * coworking handshake.
	 */
	getSessionIdByPid(pid: number): string | null {
		if (!Number.isInteger(pid) || pid <= 0) return null;
		for (const proc of this.processes.values()) {
			if (proc.pid === pid && proc.toolType !== 'terminal') {
				return resolveOwningMaestroSessionId(proc.sessionId);
			}
		}
		return null;
	}

	/**
	 * Get the output parser for a session's agent type
	 */
	getParser(sessionId: string): AgentOutputParser | null {
		const process = this.processes.get(sessionId);
		return process?.outputParser || null;
	}

	/**
	 * Parse a JSON line using the appropriate parser for the session
	 */
	parseLine(sessionId: string, line: string): ParsedEvent | null {
		const parser = this.getParser(sessionId);
		if (!parser) return null;
		return parser.parseJsonLine(line);
	}

	/**
	 * Ensure a terminal tab PTY exists, attaching to its live host handle if present.
	 * Uses the terminal tab session ID format {sessionId}-terminal-{tabId},
	 * which causes PtySpawner to forward raw PTY data without filtering.
	 */
	spawnTerminalTab(config: TerminalTabSpawnConfig): SpawnResult {
		const spawnConfig = this.terminalTabConfig(config);
		logger.info('[ProcessManager] Spawning terminal tab PTY', 'ProcessManager', {
			sessionId: config.sessionId,
			cwd: config.cwd,
			shell: spawnConfig.shell,
			cols: spawnConfig.cols,
			rows: spawnConfig.rows,
		});
		return this.spawn(spawnConfig);
	}

	/**
	 * The process config a terminal tab spawns as. Built separately so a
	 * managed host can admit exactly this request (`admitSpawn`) and then hand
	 * it, with the admission added, to `spawnTerminalTab`.
	 */
	terminalTabConfig(config: TerminalTabSpawnConfig): ProcessConfig {
		const shell = config.shell || getDefaultShell();
		return {
			sessionId: config.sessionId,
			toolType: 'terminal',
			reuseTerminal: true,
			cwd: config.cwd,
			command: shell,
			args: [],
			shell,
			shellArgs: config.shellArgs,
			shellEnvVars: config.shellEnvVars,
			cols: config.cols || 80,
			rows: config.rows || 24,
			...(config.admission ? { admission: config.admission } : {}),
		};
	}

	/**
	 * Run a single command and capture stdout/stderr cleanly
	 */
	runCommand(
		sessionId: string,
		command: string,
		cwd: string,
		shell?: string,
		shellEnvVars?: Record<string, string>,
		sshRemoteConfig?: SshRemoteConfig | null
	): Promise<CommandResult> {
		// The sinks decide: a managed host has no confined route for a one-off
		// shell command and the runner refuses before anything starts.
		const managed = this.managedCommandContext();
		if (sshRemoteConfig) {
			return this.sshCommandRunner.run(
				sessionId,
				command,
				cwd,
				sshRemoteConfig,
				shellEnvVars,
				managed
			);
		}
		return this.localCommandRunner.run(sessionId, command, cwd, shell, shellEnvVars, managed);
	}

	/**
	 * Terminate an in-flight `runCommand()` for a sessionId (local or SSH).
	 * Returns false when nothing is running under that id.
	 */
	cancelCommand(sessionId: string): boolean {
		return this.localCommandRunner.cancel(sessionId) || this.sshCommandRunner.cancel(sessionId);
	}
}
