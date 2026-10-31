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
import type { NativeSessionBinding } from '../../shared/maestro-lib/agents/providerSwap';
import type { SshRemoteEndpointIdentity } from '../../shared/maestro-lib/launch/ssh-remote-resolver';
import type {
	ContextVerification,
	DispatchOperation,
	DispatchPurpose,
	HostAuthority,
	PolicySourceSet,
} from '../../shared/maestro-lib/managed/authority';
import type {
	ManagedDelegationRef,
	ManagedDenialCode,
	ManagedDispatchTarget,
	ManagedOrigin,
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
import {
	applyManagedEnvCeiling,
	managedArgsProblems,
	permissionModeWithinCeiling,
	type LaunchPermissionMode,
	type ManagedRouteCeiling,
} from '../../shared/maestro-lib/launch/env';
import type { LaunchPermissionDecision } from '../../shared/maestro-lib/launch/launch-plan';
import type { PromptDelivery } from '../../shared/maestro-lib/launch/prompt-delivery';
import type { SteeringRunIdentity } from '../../shared/chatSteering';

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

/**
 * The origin a spawn takes from the actor its transport resolved, when the
 * caller named none (MRC2-02-01): a process that presented the CLI secret is
 * `cli` (`maestro-cli`, an agent's own shell, a Cue `mode: cli` action), and
 * the keyboard, a logged-in browser account and a paired Lite device are all
 * a person at Maestro's own UI, which the contract calls `desktop`. A
 * surface that knows better (a Cue engine, an embedded host) names its own
 * origin on the config instead of taking this default.
 */
export function spawnOriginOf(actor: ProcessSpawnActor): ManagedOrigin {
	return actor.peer === 'host-secret' ? 'cli' : 'desktop';
}

/**
 * The three-way permission mode a spawn asks for, as the renderer sends it
 * (`SpawnProcessConfig.permissionMode`) and the argument builder reads it.
 */
export type SpawnPermissionMode = LaunchPermissionMode;

/**
 * The mode a spawn request asks for, by the argument builder's own rules
 * (`buildAgentArgs`): an explicit `permissionMode` wins; without one the
 * legacy booleans are honored, full access first; a request that says
 * nothing runs the provider's own prompting, which is `standard`.
 */
export function requestedPermissionMode(config: {
	permissionMode?: SpawnPermissionMode;
	readOnlyMode?: boolean;
	yoloMode?: boolean;
}): SpawnPermissionMode {
	if (config.permissionMode) return config.permissionMode;
	if (config.yoloMode === true) return 'full';
	if (config.readOnlyMode === true) return 'readonly';
	return 'standard';
}

/**
 * The permission-mode half of the policy's route ceiling, as a port exposes
 * it (`ManagedRouteCeiling.permissionMode`, MRC2-03-01): the widest mode a
 * launch on one provider may ask for, or null when the policy pins none. A
 * `ManagedRouteCeiling` is one of these, so a producer hands the same object
 * to both seams.
 */
export interface ManagedPermissionCeiling {
	permissionMode: SpawnPermissionMode | null;
}

/**
 * Why a spawn's permission mode cannot run under management, or null when it
 * may (MRC2-02-01). A managed host DENIES a request wider than the ceiling;
 * it never lowers the request to fit, since a turn the person asked to run
 * with full access, silently run read-only, is a turn they were told nothing
 * about. A ceiling that pins no mode, and a host that composes no ceiling
 * producer, forbid nothing here: the admission on the snapshot decides, as
 * before. A standalone host is never refused by this.
 */
export function managedPermissionModeRefusal(
	requested: SpawnPermissionMode,
	ceiling: ManagedPermissionCeiling | null | undefined,
	standing: 'standalone' | 'managed'
): string | null {
	if (standing === 'standalone') return null;
	const pinned = ceiling?.permissionMode ?? null;
	if (pinned === null) return null;
	if (permissionModeWithinCeiling(requested, pinned)) return null;
	return `Permission mode "${requested}" is unavailable under management on this host: the policy's ceiling allows at most "${pinned}" for this provider, and a managed host does not lower a request to fit it. Nothing was started.`;
}

/**
 * The agent and tab a utility turn of Maestro's own serves (MRC2-02-02): a
 * synopsis, a Quick Chat routing answer, a command suggestion or a context
 * summary run BESIDE a person's conversation by a `groomer-*` process that is
 * no agent of its own. The sink binds the turn's trace to the served tab's
 * (`utilityTurnTraceId`), so the journal reads the utility turn next to the
 * turns it was run for instead of as an orphan under a throwaway id.
 * Attribution, never a permission level: the served agent's own admissions
 * lend the utility turn nothing, and it is admitted or refused on its own
 * snapshot like any other.
 */
export interface UtilityTurnLineage {
	/** The agent (Maestro session id) the turn serves. */
	sessionId: string;
	/** The tab within it, when the turn serves one tab. */
	tabId?: string;
}

/** Longest agent or tab id a caller may name as a utility turn lineage. */
export const MAX_UTILITY_LINEAGE_ID_LENGTH = 256;

function lineageId(value: unknown, name: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_UTILITY_LINEAGE_ID_LENGTH
	) {
		throw new Error(
			`The utility turn ${name} must be a string of 1 to ${MAX_UTILITY_LINEAGE_ID_LENGTH} characters.`
		);
	}
	return value;
}

/**
 * Reads a `UtilityTurnLineage` off what a caller sent across a boundary
 * (MRC2-02-02A): the `lineage` option of `context:groomContext` and the
 * `sessionId` / `tabId` of an `aiCommand:suggest` request. Nothing named is
 * no lineage (`undefined`), which is what every caller sent before the ids
 * existed, so a standalone desktop is unchanged. Anything named must be a
 * plain string: the sink builds the served tab's trace id from these, so a
 * number, an object or an empty string is refused HERE, before a turn is
 * admitted under a trace that names nothing. A tab without the agent it
 * belongs to is refused too, since a tab id alone traces nowhere.
 */
export function utilityLineageOf(raw: unknown): UtilityTurnLineage | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== 'object') {
		throw new Error('The utility turn lineage must name an agent and, optionally, a tab.');
	}
	const { sessionId, tabId } = raw as { sessionId?: unknown; tabId?: unknown };
	const hasTab = tabId !== undefined && tabId !== null;
	if (sessionId === undefined || sessionId === null) {
		if (hasTab) {
			throw new Error('The utility turn lineage names a tab but not the agent it belongs to.');
		}
		return undefined;
	}
	const lineage: UtilityTurnLineage = { sessionId: lineageId(sessionId, 'agent id') };
	if (hasTab) lineage.tabId = lineageId(tabId, 'tab id');
	return lineage;
}

/** What a utility turn asks to run as, before the route ceiling is applied. */
export interface UtilityRouteRequest {
	/** The provider the turn resolved to (`utilityAgentId`, else the session's agent). */
	providerId: string;
	/** The resolved arguments, overrides applied. Checked by name, never run. */
	args: readonly string[];
	/**
	 * The environment layer this surface sets on the process (the agent's own
	 * variables with the session's overrides), the one layer the surface owns.
	 * The ceiling is applied to a copy; the input is never mutated.
	 */
	customEnvVars: Record<string, string> | undefined;
	/** Builds the provider's model flag, to pin the ceiling's model when the arguments name none. */
	modelArgs?: (modelId: string) => string[];
	/** Where the turn runs. A route cannot be bounded on an SSH remote. */
	target: 'local' | 'ssh';
}

export type UtilityRouteAnswer =
	| {
			ok: true;
			args: string[];
			customEnvVars: Record<string, string> | undefined;
			/** Set when a ceiling was applied: what it removed and pinned, by name. */
			ceiling?: { removed: string[]; pinned: string[] };
	  }
	| { ok: false; reason: string };

/**
 * The provider, model and account ceiling of a utility turn (MRC2-02-02), the
 * same `ManagedRouteCeiling` the launch plan applies to a person's turn
 * (`applyManagedEnvCeiling`, `managedArgsProblems`), applied by a surface that
 * spawns outside the plan. A managed host refuses a utility turn the policy
 * routes to another provider, one whose arguments name a model other than
 * the pinned one or route around the ceiling, one that would run on an SSH
 * remote (the remote environment cannot be bounded from here), and one whose
 * route requires an approved credential, since a utility turn delivers none.
 * It never swaps the provider or lowers the request to fit: the surface
 * degrades to no answer, and says why. With a ceiling that pins a model and
 * arguments that name none, the model is pinned (as the launch plan does);
 * the pinned names and the stripped user variables are reported by name.
 * A host with no route ceiling producer, and a ceiling of null (the policy
 * pins no route on this provider), forbid nothing here: the admission on the
 * snapshot decides, as before. A standalone host is unchanged.
 */
export function boundUtilityRoute(
	request: UtilityRouteRequest,
	ceiling: ManagedRouteCeiling | null | undefined,
	standing: 'standalone' | 'managed'
): UtilityRouteAnswer {
	const unchanged: UtilityRouteAnswer = {
		ok: true,
		args: [...request.args],
		customEnvVars: request.customEnvVars,
	};
	if (standing === 'standalone' || !ceiling) return unchanged;
	if (ceiling.providerId !== request.providerId) {
		return {
			ok: false,
			reason: `The policy routes utility turns on this host to ${ceiling.providerId}, not ${request.providerId}; a managed host does not run them on another provider in its place. Nothing was started.`,
		};
	}
	if (request.target === 'ssh') {
		return {
			ok: false,
			reason:
				'A managed route is not supported for a utility turn on an SSH remote: the remote environment cannot be bounded from this host. Nothing was started.',
		};
	}
	const argProblems = managedArgsProblems(request.args, ceiling);
	if (argProblems.length > 0) {
		return {
			ok: false,
			reason: `The utility turn's arguments route around the policy: ${argProblems.join('; ')}. A managed host does not rewrite them to fit. Nothing was started.`,
		};
	}
	const env: NodeJS.ProcessEnv = { ...(request.customEnvVars ?? {}) };
	const report = applyManagedEnvCeiling(env, { ceiling, credentialEnvVars: {} });
	if (report.problems.length > 0) {
		return {
			ok: false,
			reason: `The utility turn's environment does not satisfy the policy's route: ${report.problems.join('; ')}. Nothing was started.`,
		};
	}
	const bounded: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) if (value !== undefined) bounded[key] = value;
	const namesModel = request.args.some((arg) => arg === '--model' || arg === '-m');
	const pinnedModelArgs =
		ceiling.model && request.modelArgs && !namesModel ? request.modelArgs(ceiling.model) : [];
	return {
		ok: true,
		args: [...request.args, ...pinnedModelArgs],
		customEnvVars: Object.keys(bounded).length > 0 ? bounded : undefined,
		ceiling: { removed: report.removed, pinned: report.pinned },
	};
}

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
	/**
	 * The permission-mode ceiling the policy pins for one provider
	 * (`ManagedRouteCeiling.permissionMode`, P2-03), read by the spawn handler
	 * before the launch plan: the widest mode a launch may ask for, or null
	 * for none pinned. Absent: this host composes no route ceiling producer,
	 * and the handler forbids no mode on its own (the admission on the
	 * snapshot decides). A request above the ceiling is denied by
	 * `managedPermissionModeRefusal`, never lowered to fit.
	 */
	permissionCeiling?(providerId: string): ManagedPermissionCeiling | null;
	/**
	 * The route the policy pins for one provider (`ManagedRouteCeiling`: the
	 * provider, its model, gateway origin, account home and whether its own
	 * login may bill), read by a surface that spawns a utility turn of
	 * Maestro's own outside the launch plan (the context groomer, MRC2-02-02)
	 * and applied there by `boundUtilityRoute`; null for a provider the
	 * policy pins no route on. Absent: this host composes no route ceiling
	 * producer, and the surface bounds nothing on its own (the admission on
	 * the snapshot decides, as before). Whether a provider may run at all is
	 * the admission's answer on `DispatchSnapshot.provider`, not this one's.
	 */
	routeCeiling?(providerId: string): ManagedRouteCeiling | null;
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

/** Internal controls for `spawnAdmitted`, separate from the captured launch request. */
export interface ProcessSpawnOptions {
	/** Host-owned final ownership fence, after asynchronous managed admission. */
	beforeSpawn?: () => string | undefined | Promise<string | undefined>;
	/**
	 * Cancel before spawn, including while admission is pending. Never serialized
	 * or included in managed content digests. Once started, the caller retains
	 * its existing process stop ownership.
	 */
	signal?: AbortSignal;
}

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
/** Grok native selectors must describe the retained request before SSH hides argv.
 * Implicit continuation, injected IDs and forks cannot inherit its ownership. */
export function grokLaunchArgsProblem(
	args: readonly string[],
	nativeId?: string,
	cwd?: string
): string | undefined {
	const resumes: string[] = [];
	const directories: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (
			[
				'--continue',
				'-c',
				'--fork-session',
				'--session-id',
				'--worktree',
				'-w',
				'-r',
				'--',
			].includes(arg) ||
			['--continue=', '--fork-session=', '--session-id=', '--worktree=', '-r', '-w', '-c'].some(
				(prefix) => arg.startsWith(prefix)
			)
		) {
			return 'Grok implicit continuation, fork or workspace selectors cannot supply native launch ownership.';
		}
		for (const [flag, values] of [
			['--resume', resumes],
			['--cwd', directories],
		] as const) {
			if (arg === flag) values.push(args[++i] ?? '');
			else if (arg.startsWith(flag + '=')) values.push(arg.slice(flag.length + 1));
		}
	}
	if (
		resumes.length !== (nativeId ? 1 : 0) ||
		(nativeId && resumes[0] !== nativeId) ||
		(nativeId !== undefined && (!nativeId.trim() || /[\x00-\x1f\x7f]/.test(nativeId))) ||
		directories.length > 1 ||
		(directories.length === 1 && directories[0] !== cwd)
	) {
		return 'Grok resume or working-directory arguments do not match the retained launch request.';
	}
	return undefined;
}

/** Observed launch ownership before a provider has allocated its native ID. */
export type NativeSessionLaunchScope =
	| Extract<NativeSessionBinding, { state: 'unknown' }>
	| Omit<Extract<NativeSessionBinding, { state: 'bound' }>, 'nativeSessionId'>;

/** Kept through stream drainage, including after kill removes the live process. */
export interface NativeSessionLaunch {
	readonly scope: NativeSessionLaunchScope;
	readonly processGeneration: number;
	readonly tabId?: string;
	readonly requestedNativeSessionId?: string;
	/**
	 * Echo of the caller's per-spawn correlation token, when valid. Identifies
	 * the renderer attempt before a native ID arrives; not native ownership or
	 * managed authority. Absent on legacy/headless callers, never synthesized.
	 * Valid tokens contain 1-128 ASCII letters, digits, underscores or hyphens.
	 */
	readonly nativeSessionRequestId?: string;
}

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
	/**
	 * Private, host-planned prompt file, retained through request copies and bound
	 * by the admission snapshot. Local files belong to startTurn; remote files
	 * belong to the SSH script owner. Never log, persist or expose this artifact
	 * in Process Details, renderer responses or spawn capture events.
	 */
	promptArtifact?: Extract<PromptDelivery, { via: 'file' }>['artifact'];
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
	/** What this spawn is for (`DispatchPurpose`, MRC2-02-01). The surface that
	 *  raised it classifies it and the sink carries it into the admission
	 *  snapshot, so the policy can tell a person's turn from a utility, probe
	 *  or supervisor turn of Maestro's own. Absent is a `conversation` turn. */
	purpose?: DispatchPurpose;
	/** Which surface raised this spawn (the contract's `ManagedOrigin`;
	 *  `desktop` is a person at Maestro's own UI). The handler defaults it from
	 *  the caller its transport resolved (`spawnOriginOf`); absent at the sink
	 *  is `desktop`. Attribution, never a permission level. */
	origin?: ManagedOrigin;
	/** The agent and tab a `utility` turn serves (`UtilityTurnLineage`,
	 *  MRC2-02-02). The sink binds the turn's trace to the served tab's, so
	 *  the journal reads it beside the turns it was run for. Absent, a
	 *  utility turn is traced under its own throwaway session id. */
	utilityOf?: UtilityTurnLineage;
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
	/** Caller correlation only; see NativeSessionLaunch.nativeSessionRequestId. */
	nativeSessionRequestId?: NativeSessionLaunch['nativeSessionRequestId'];
	/** Host-observed scope, never accepted from an IPC payload. */
	nativeSessionScope?: NativeSessionLaunchScope;
	/** Retained owner/tab binding that a Grok resume must match. */
	nativeSessionBinding?: NativeSessionBinding;
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
	/** The launch plan's permission decision for this spawn (MRC2-03-03A): the
	 *  mode the turn asked for and the ceiling it was measured against, null
	 *  on an unmanaged launch or a route that pins none. Stamped by the spawn
	 *  handler off `plan.permission`, host-authoritative (nothing the renderer
	 *  sends names it), and read by a sink that maps access flags itself (the
	 *  Codex app-server sandbox) in place of its own reading of the flags. A
	 *  terminal plans nothing and carries none. */
	permission?: LaunchPermissionDecision;
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
	/** Private remote prompt cleanup metadata, bound to sshRemotePidFile ownership.
	 *  Never expose in Process Details, capture events or persisted diagnostics. */
	sshRemotePromptArtifactPath?: string;
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
	nativeSessionLaunch?: NativeSessionLaunch;
	/** The admission this process was spawned under on a managed host. Absent
	 *  for a standalone spawn, and for a process that predates the enrollment
	 *  (an unqualified process a managed sink must not drive). */
	admission?: ProcessSpawnAdmission;
	/** What a steer of this process must carry (MRC2-03-06A): set by the sink
	 *  for a local maestro-p launch once the spawner registered the record,
	 *  read by `ProcessManager.steer()`. Absent for every other process. */
	steering?: ProcessSteeringCredentials;
}

/**
 * The run authority a steer carries: the per-run token the sink minted for a
 * local maestro-p launch (`STEERING_TOKEN_ENV_VAR` on the TUI's env, never on
 * the request the lease digests) and, when the launch was admitted, the lease
 * and attempt the handshake names. maestro-p refuses a frame without them.
 */
export interface ProcessSteeringCredentials {
	token: string;
	/** Null for a standalone spawn, where the TUI holds the channel to the token alone. */
	run: SteeringRunIdentity | null;
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
