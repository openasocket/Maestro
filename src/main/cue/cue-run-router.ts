/**
 * One routing path from a fired Cue subscription to the executor that runs it
 * (notify / shell command / maestro-cli command / agent prompt), shared by the
 * desktop app (`src/main/index.ts`) and the standalone runner
 * (`src/cli/services/cue-standalone-engine.ts`). The two used to carry their
 * own copies of this closure, and the copies had already drifted (the
 * standalone one never passed the conductor profile to templates).
 *
 * What genuinely differs between the two runners is injected, never branched
 * on here: where sessions come from, how a toast is delivered (a desktop
 * window, or a log line on a headless host), how an agent binary is found,
 * and what an auth failure does.
 *
 * Two import rules keep this file usable from both runners:
 * - No Electron, not even as a type. `cue-electron-imports.test.ts` is a
 *   shrink-only ratchet, so the notify path is an `onNotify` callback rather
 *   than a `BrowserWindow` parameter.
 * - Executors are TYPE imports only and arrive through
 *   {@link CueRunActionDeps}. The standalone runner loads them dynamically so
 *   `electron-store` stays out of the CLI bundle's static graph (see
 *   `loadExecutors()` in `cue-standalone-engine.ts`).
 */

import * as os from 'os';
import type { CueEngineDeps } from './cue-engine';
import type {
	executeCuePrompt as ExecuteCuePrompt,
	stopCueRun as StopCueRun,
	CueManagedAdmission,
	CueManagedState,
	CueRunTranscript,
} from './cue-executor';
import type { ManagedLaunchInput } from '../../shared/maestro-lib/launch/launch-plan';
import {
	sha256Hex,
	type ContextVerification,
	type DispatchLease,
	type HostAuthority,
	type PolicySourceSet,
} from '../../shared/maestro-lib/managed/authority';
import type { HeadlessSpawnContextInput } from '../../shared/maestro-lib/managed/host-adapter';
import type {
	ManagedDelegationRef,
	ManagedDenialCode,
	ManagedRunIdentity,
	ManagedWorkflowRef,
} from '../../shared/maestro-lib/managed/types';
import type { AutoRunOwnerFence } from '../../shared/maestro-lib/autorun/attribution';
import { canonicalJson } from '../../shared/canonicalJson';
import { generateUUID } from '../../shared/uuid';
import type { executeCueShell as ExecuteCueShell } from './cue-shell-executor';
import type { executeCueCli as ExecuteCueCli } from './cue-cli-executor';
import type { CueNotifyExecutionConfig } from './cue-notify-executor';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { TemplateContext } from '../../shared/templateVariables';
import type { CueRunResult } from '../../shared/cue/contracts';
import type { SessionInfo, ToolType } from '../../shared/types';
import type { CueAutoRunConfig, CueEvent, CueSubscription } from './cue-types';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { isLaunchCancelled, stoppedBeforeLaunchResult } from './cue-launch-cancel';
import { resolveCueTurnSettings } from '../../shared/cue/turn-settings';
import { describeTurnSettings } from '../../shared/autorunTurnSettings';

/** What `CueEngine` hands its `onCueRun` dependency for one run. */
export type OnCueRunParams = Parameters<CueEngineDeps['onCueRun']>[0];

/** The persisted agent fields a Cue run reads. Both runners' stored session records satisfy it. */
export interface CueRunSessionRecord {
	id: string;
	name: string;
	toolType: ToolType;
	cwd?: string;
	projectRoot?: string;
	fullPath?: string;
	autoRunFolderPath?: string;
	sessionSshRemoteConfig?: { enabled: boolean; remoteId: string | null };
	customPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	/** Secret names this agent needs; resolved per launch (see `SessionInfo.requiredSecrets`). */
	requiredSecrets?: string[];
	customModel?: string;
	customEffort?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	/** Prefixed to every Cue prompt run, since each one starts a new provider session. */
	newSessionMessage?: string;
}

/** A notify run's executor config minus the delivery target, which only the runner knows. */
export type CueNotifyParams = Omit<CueNotifyExecutionConfig, 'mainWindow'>;

export interface CueRunActionDeps {
	executeCuePrompt: typeof ExecuteCuePrompt;
	executeCueShell: typeof ExecuteCueShell;
	executeCueCli: typeof ExecuteCueCli;
	/** Not called by the router; carried so each runner's executor set travels as one object (see `onStopCueRun`). */
	stopCueRun: typeof StopCueRun;
	/** Look up the target agent's persisted record. Read per run, so an edit made while the engine runs is honored. */
	findSession: (sessionId: string) => CueRunSessionRecord | undefined;
	/**
	 * Fallback binary lookup when the agent's config sets no `customPath`. The
	 * desktop probes with its agent detector; without one, the bare command
	 * name is left to `spawn()`'s own PATH search.
	 */
	resolveAgentPath?: (toolType: string) => Promise<string | undefined> | string | undefined;
	resolveAgentBinary?: (options: {
		session: CueRunSessionRecord;
		agentConfigValues: Record<string, unknown>;
	}) => Promise<string | undefined>;
	sshStore: SshRemoteSettingsStore;
	getAgentConfigValues: (toolType: string) => Record<string, unknown>;
	onLog: (level: string, message: string) => void;
	/** Read on EVERY run, never cached at boot, so a profile edit applies to the next run. */
	getConductorProfile?: () => string | undefined;
	onNotify: (params: CueNotifyParams) => Promise<CueRunResult>;
	onAutoRun?: (params: {
		runId: string;
		session: SessionInfo;
		subscription: CueSubscription;
		event: CueEvent;
		autoRun?: CueAutoRunConfig;
	}) => Promise<CueRunResult>;
	getAppendSystemPrompt?: (sessionId: string) => Promise<string | undefined>;
	getOnRunTranscript?: (sessionId: string) => ((run: CueRunTranscript) => void) | undefined;
	/**
	 * Hand prompt and shell runs only the server-mode env allowlist. Omit to
	 * leave it to `MAESTRO_SERVER_MODE` (see `isServerModeActive`).
	 */
	isServerMode?: boolean;
	reportAuthFailure?: (
		result: CueRunResult,
		toolType: string,
		sshRemoteId?: string
	) => Promise<void>;
	/**
	 * The managed authority prompt runs are admitted with (MRC-07-02). Absent:
	 * the host asks no admission (a standalone runner, or a host that has not
	 * wired one). Present: read on EVERY run, so an enrollment that appears or
	 * lapses applies to the next firing, and a restored queue entry, a fan-out
	 * child and the `:output` phase each reauthorize when they fire.
	 */
	managed?: CueManagedDeps;
}

// ─── Managed admission (MRC-07-02) ───────────────────────────────────────────

/**
 * What a managed Cue run admits with: the spawn authority of the host running
 * the engine (`createHeadlessSpawnAuthority` with origin `cue`, or the
 * desktop's port under the same shape).
 */
export interface CueSpawnAuthorityPort {
	standing(): 'standalone' | 'managed';
	readonly authority: HostAuthority;
	policy(): PolicySourceSet;
	context(input: HeadlessSpawnContextInput): ContextVerification;
}

/** What became of one run's admission, for a journal or a test. */
export type CueAdmissionEvent =
	| { kind: 'admitted'; lineage: CueRunLineage; leaseId: string }
	| {
			kind: 'refused';
			lineage: CueRunLineage;
			state: CueManagedState;
			code: ManagedDenialCode;
			message: string;
	  };

export interface CueManagedDeps {
	/** The host's port, read per run; null while the host has none to offer. */
	port(): CueSpawnAuthorityPort | null;
	/**
	 * The owner fence of the workflow this run belongs to (its pipeline, or the
	 * lone subscription), read on every run. Null: the workflow has no owner,
	 * and a managed host runs none of it (unavailable, not denied: no policy
	 * decided). The fence comes from a workflow owner producer (MRC-07-06,
	 * CP-03); the router never mints one, and Cue stays the scheduler.
	 */
	workflowFence?(workflow: CueWorkflowIdentity): AutoRunOwnerFence | null;
	/** The policy's route ceiling and approved credential references, when the host has them. */
	launch?: ManagedLaunchInput;
	/** An opaque account reference for the snapshot; never a credential. */
	account?: string | null;
	/** Id minting for the attempt, injected by a test. */
	newId?(): string;
	onAdmission?(event: CueAdmissionEvent): void;
}

/** The workflow a Cue run belongs to: its named pipeline, or the subscription standing alone. */
export interface CueWorkflowIdentity {
	workflowId: string;
	/** A digest over the subscription's name, prompt and action: an edit is a new version. */
	version: string;
	/** The event that fired it, `<type>:<event id>`. */
	triggerEventId: string;
}

/**
 * Everything a managed host binds a Cue run on. Built from what the engine
 * handed the router (the run, the chain root and dispatching run, the
 * pipeline, the event) and the stored owner record; nothing is read from the
 * prompt text or invented here.
 */
export interface CueRunLineage {
	workflow: CueWorkflowIdentity;
	identity: ManagedRunIdentity;
	/** The principals behind the launch: the subscription, then the agent that owns it. */
	delegation: ManagedDelegationRef;
	traceId: string;
	/** The owning agent, as the engine resolved it (ownership tie-breaking included). */
	ownerAgentId: string;
	pipelineName: string | null;
}

export function cueWorkflowIdentity(input: {
	subscriptionName: string;
	pipelineName?: string | null;
	prompt: string;
	action?: CueSubscription['action'];
	event: Pick<CueEvent, 'id' | 'type'>;
}): CueWorkflowIdentity {
	return {
		workflowId: input.pipelineName
			? `cue-pipeline:${input.pipelineName}`
			: `cue:${input.subscriptionName}`,
		version: sha256Hex(
			canonicalJson({
				subscription: input.subscriptionName,
				prompt: input.prompt,
				action: input.action ?? 'prompt',
			})
		).slice(0, 16),
		triggerEventId: `${input.event.type}:${input.event.id}`,
	};
}

/**
 * The run's lineage. Each firing is its own request (the engine mints a fresh
 * run id per firing, a restored queue entry included), each spawn its own
 * attempt; the chain root is the root run and the dispatching run the parent.
 */
export function cueRunLineage(input: {
	runId: string;
	chainRootId?: string;
	parentEventId?: string;
	pipelineName?: string | null;
	subscriptionName: string;
	prompt: string;
	action?: CueSubscription['action'];
	event: Pick<CueEvent, 'id' | 'type'>;
	ownerAgentId: string;
	attemptId: string;
}): CueRunLineage {
	const rootRunId = input.chainRootId ?? input.runId;
	return {
		workflow: cueWorkflowIdentity(input),
		identity: {
			requestId: input.runId,
			idempotencyKey: input.runId,
			attemptId: input.attemptId,
			runId: input.runId,
			rootRunId,
			parentRunId: input.parentEventId ?? null,
		},
		delegation: {
			chain: [
				{ kind: 'service', id: `cue-subscription:${input.subscriptionName}` },
				{ kind: 'agent', id: input.ownerAgentId },
			],
			grantRef: null,
		},
		traceId: `cue:${rootRunId}:${input.runId}:${input.attemptId}`,
		ownerAgentId: input.ownerAgentId,
		pipelineName: input.pipelineName ?? null,
	};
}

/** The workflow reference the context carries, once the workflow has an owner. Null without a fence. */
export function cueWorkflowRef(
	workflow: CueWorkflowIdentity,
	fence: AutoRunOwnerFence | null
): ManagedWorkflowRef | null {
	if (!fence) return null;
	return { ...workflow, ownerEpoch: fence.ownerEpoch, fencingToken: fence.fencingToken };
}

type CueManagedBinding =
	| { managed: false }
	| { managed: true; admission: CueManagedAdmission; launch?: ManagedLaunchInput }
	| {
			managed: true;
			refusal: { state: CueManagedState; code: ManagedDenialCode; message: string };
	  };

/**
 * Bind one run's lineage into a verified context, or say why not. Read on
 * every run: the port, its standing, the fence and the policy revision are
 * what they are NOW, not when the engine started. The authority itself is
 * asked later, by the lifecycle, on the snapshot of the final spawn.
 */
function bindCueManagedRun(
	deps: CueManagedDeps | undefined,
	lineage: CueRunLineage
): CueManagedBinding {
	const port = deps?.port();
	if (!deps || !port || port.standing() === 'standalone') return { managed: false };
	const refuse = (state: CueManagedState, code: ManagedDenialCode, message: string) => {
		deps.onAdmission?.({ kind: 'refused', lineage, state, code, message });
		return { managed: true, refusal: { state, code, message } } as const;
	};
	const fence = deps.workflowFence?.(lineage.workflow) ?? null;
	if (!fence) {
		return refuse(
			'unavailable',
			'runtime-unavailable',
			`Cue workflow "${lineage.workflow.workflowId}" has no workflow owner fence; a managed host does not run an unowned workflow, and the Cue engine does not mint one (CP-03, the workflow owner producer).`
		);
	}
	const policy = port.policy();
	const verified = port.context({
		identity: lineage.identity,
		traceId: lineage.traceId,
		policyRevision: policy.policyRevision,
		workflow: cueWorkflowRef(lineage.workflow, fence),
		delegation: lineage.delegation,
	});
	if (!verified.ok) {
		return refuse(
			'denied',
			verified.code,
			`The run's context was not accepted: ${verified.problems.join('; ')}`
		);
	}
	return {
		managed: true,
		admission: {
			authority: port.authority,
			context: verified.context,
			policy,
			account: deps.account ?? null,
			onLease: (lease: DispatchLease) =>
				deps.onAdmission?.({ kind: 'admitted', lineage, leaseId: lease.leaseId }),
		},
		...(deps.launch ? { launch: deps.launch } : {}),
	};
}

export async function executeCueRunAction(
	deps: CueRunActionDeps,
	{
		runId,
		sessionId,
		prompt,
		subscriptionName,
		event,
		timeoutMs,
		action,
		command,
		notify,
		autoRun,
		turnSettings,
		signal,
		pipelineName,
		chainRootId,
		parentEventId,
	}: OnCueRunParams
): Promise<CueRunResult> {
	const storedSession = deps.findSession(sessionId);
	if (!storedSession) {
		throw new Error(`Cue target session not found: ${sessionId}`);
	}
	// Stopped while the runner was still getting here (the standalone runner
	// awaits its executor load first): start nothing. Each executor checks
	// again right before it spawns.
	const stoppedResult = () =>
		stoppedBeforeLaunchResult({
			runId,
			sessionId,
			sessionName: storedSession.name,
			subscriptionName,
			event,
		});
	if (isLaunchCancelled(signal)) return stoppedResult();

	const projectRoot =
		storedSession.projectRoot || storedSession.cwd || storedSession.fullPath || os.homedir();
	const templateContext: TemplateContext = {
		session: {
			id: storedSession.id,
			name: storedSession.name,
			toolType: storedSession.toolType,
			cwd: projectRoot,
			projectRoot,
			fullPath: storedSession.fullPath,
			autoRunFolderPath: storedSession.autoRunFolderPath,
		},
		conductorProfile: deps.getConductorProfile?.(),
	};
	const sessionInfo = {
		id: storedSession.id,
		name: storedSession.name,
		toolType: storedSession.toolType,
		cwd: projectRoot,
		projectRoot,
		autoRunFolderPath: storedSession.autoRunFolderPath,
		newSessionMessage: storedSession.newSessionMessage,
	};

	// `action: autorun` launches an Auto Run in the owning agent. Handled
	// before notify/command/prompt for the same reason they are: it never
	// spawns an agent process here, so the agent-path resolution, SSH
	// wrapping, and prompt plumbing below do not apply. The document list
	// travels on the subscription rather than being re-read from the
	// agent's Auto Run folder, so repointing that folder between
	// scheduling and firing cannot swap the run out from under the user.
	if (action === 'autorun') {
		const subscription = {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
			action,
			auto_run: autoRun,
			agent_id: storedSession.id,
		};
		if (!deps.onAutoRun) {
			const reason = 'action=autorun is not supported in this runner mode';
			deps.onLog('error', `[CUE] Auto Run "${subscriptionName}" did not start: ${reason}`);
			const startedAt = new Date().toISOString();
			return {
				runId,
				sessionId: storedSession.id,
				sessionName: storedSession.name,
				subscriptionName,
				event,
				status: 'failed' as const,
				stdout: '',
				stderr: `Auto Run launch failed: ${reason}`,
				exitCode: 1,
				durationMs: 0,
				startedAt,
				endedAt: startedAt,
			};
		}
		if (!autoRun || autoRun.documents.length === 0) {
			const reason =
				'no documents on the run - the captured Auto Run payload did not survive the queue';
			deps.onLog('error', `[CUE] Auto Run "${subscriptionName}" did not start: ${reason}`);
			const startedAt = new Date().toISOString();
			return {
				runId,
				sessionId: storedSession.id,
				sessionName: storedSession.name,
				subscriptionName,
				event,
				status: 'failed' as const,
				stdout: '',
				stderr: `Auto Run launch failed: ${reason}`,
				exitCode: 1,
				durationMs: 0,
				startedAt,
				endedAt: startedAt,
			};
		}
		return deps.onAutoRun({
			runId,
			session: sessionInfo,
			subscription,
			event,
			autoRun,
		});
	}

	// `action: notify` surfaces a toast through the owning agent instead of
	// spawning anything - handled before command/prompt so the spawn config,
	// SSH wrap, and history-recording paths below stay agent-only. The
	// notify message is pre-resolved by the dispatch service via the
	// fallback chain (notify.message → label → prompt → name); falling
	// back here to `prompt` (which the dispatcher uses as the carrier)
	// covers the queue-restored corner where the in-memory `notify` was
	// lost but the message survived in the persisted `prompt` slot.
	if (action === 'notify') {
		// No History write here: Cue runs are served to History from
		// `cue_events` (see `getCueHistoryEntries`), so the agent's JSONL
		// file keeps only USER/AUTO entries and CUE rows can no longer
		// evict them.
		return deps.onNotify({
			runId,
			session: sessionInfo,
			subscription: {
				name: subscriptionName,
				event: event.type,
				enabled: true,
				prompt,
				action,
				notify,
				agent_id: storedSession.id,
			},
			event,
			agentId: storedSession.id,
			message: notify?.message?.trim() || prompt,
			sticky: notify?.sticky === true,
			title: storedSession.name || getAgentDisplayName(storedSession.toolType),
			onLog: deps.onLog,
		});
	}

	// `action: command` runs a shell command or maestro-cli call instead of an
	// AI prompt - skip agent path resolution and SSH wrapping.
	if (action === 'command') {
		if (!command) {
			// Should be unreachable post-validator, but guard anyway so a
			// misconfigured subscription fails loudly instead of silently
			// executing `prompt` (a shell/cli sentinel) as an AI prompt.
			throw new Error(
				`Cue subscription "${subscriptionName}" has action='command' but no command payload`
			);
		}
		const subscription = {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
			action,
			command,
		};
		// History reads Cue runs from `cue_events`, not the JSONL file -
		// see the note on the notify path above.
		return command.mode === 'shell'
			? deps.executeCueShell({
					runId,
					session: sessionInfo,
					subscription,
					event,
					shellCommand: command.shell,
					projectRoot,
					templateContext,
					timeoutMs,
					onLog: deps.onLog,
					// Forward SSH config so shell commands run on the remote
					// host when the owning session is SSH-remote-enabled.
					sshRemoteConfig: storedSession.sessionSshRemoteConfig,
					sshStore: deps.sshStore,
					isServerMode: deps.isServerMode,
					signal,
				})
			: deps.executeCueCli({
					runId,
					session: sessionInfo,
					subscription,
					event,
					cli: command.cli,
					templateContext,
					timeoutMs,
					onLog: deps.onLog,
					// CLI mode intentionally stays local: `maestro-cli send`
					// targets the local Maestro daemon (routing messages to
					// sessions managed by this app), so SSH wrapping would
					// point at the wrong daemon and `maestro-cli.js` may not
					// exist on the remote host.
					signal,
				});
	}

	const agentConfigValues = deps.getAgentConfigValues(storedSession.toolType);

	// Resolve the agent's binary path.
	let resolvedAgentPath: string | undefined;
	if (deps.resolveAgentBinary) {
		resolvedAgentPath = await deps.resolveAgentBinary({
			session: storedSession,
			agentConfigValues,
		});
		if (isLaunchCancelled(signal)) return stoppedResult();
	} else {
		resolvedAgentPath =
			typeof agentConfigValues.customPath === 'string' && agentConfigValues.customPath
				? agentConfigValues.customPath
				: undefined;
		if (!resolvedAgentPath && deps.resolveAgentPath) {
			resolvedAgentPath = (await deps.resolveAgentPath(storedSession.toolType)) || undefined;
			if (isLaunchCancelled(signal)) return stoppedResult();
		}
	}

	const appendSystemPrompt = deps.getAppendSystemPrompt
		? await deps.getAppendSystemPrompt(storedSession.id)
		: undefined;
	if (isLaunchCancelled(signal)) return stoppedResult();

	// The subscription's tier / model / effort outranks the agent's own
	// config for this run only. A tier or effort the provider cannot
	// honor falls back to the agent's value and is logged as a warning,
	// so a run never silently lands on a different model than asked.
	const turn = resolveCueTurnSettings(
		storedSession.toolType,
		turnSettings,
		storedSession.customModel,
		storedSession.customEffort
	);
	const turnNote = describeTurnSettings(turn);
	if (turnNote) {
		const line = `[CUE] "${subscriptionName}" model: ${turnNote}`;
		if (turn.warnings.length > 0) deps.onLog('warn', line);
		else deps.onLog('cue', line);
	}

	// Managed admission, bound as late as the router can: the port's standing,
	// the workflow's owner fence and the policy revision are read here, on this
	// firing, so a restored queue entry or a chain child fired later is admitted
	// on what holds then. The authority itself decides on the final spawn
	// snapshot inside the lifecycle. A refusal is the run's result: the agent
	// is never started unmanaged, and the yolo / full-permission flags the Cue
	// spawn carries are part of what the authority sees, not a wider grant.
	const lineage = cueRunLineage({
		runId,
		chainRootId,
		parentEventId,
		pipelineName,
		subscriptionName,
		prompt,
		action,
		event,
		ownerAgentId: storedSession.id,
		attemptId: deps.managed?.newId?.() ?? generateUUID(),
	});
	const binding = bindCueManagedRun(deps.managed, lineage);
	if (binding.managed && 'refusal' in binding) {
		const { state, code, message } = binding.refusal;
		deps.onLog(
			'warn',
			`[CUE] "${subscriptionName}" was not admitted (${state}, ${code}): ${message}`
		);
		const startedAt = new Date().toISOString();
		return {
			runId,
			sessionId: storedSession.id,
			sessionName: storedSession.name,
			subscriptionName,
			pipelineName: pipelineName ?? undefined,
			event,
			status: 'failed',
			stdout: '',
			stderr: `[managed-${state}] ${message}`,
			exitCode: null,
			durationMs: 0,
			startedAt,
			endedAt: startedAt,
			managed: { state, code },
		};
	}

	const result = await deps.executeCuePrompt({
		runId,
		session: sessionInfo,
		subscription: {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
		},
		event,
		promptPath: prompt,
		toolType: storedSession.toolType,
		projectRoot,
		templateContext,
		timeoutMs,
		sshRemoteConfig: storedSession.sessionSshRemoteConfig,
		customPath: resolvedAgentPath,
		customArgs: storedSession.customArgs,
		customEnvVars: storedSession.customEnvVars,
		requiredSecrets: storedSession.requiredSecrets,
		...(binding.managed
			? { admission: binding.admission, ...(binding.launch ? { managed: binding.launch } : {}) }
			: {}),
		customModel: turn.model,
		customEffort: turn.effort,
		// Claude token-source selection (TUI / API / dynamic), read from
		// the same persisted session record that supplies customModel
		// above, so Cue runs honor the triggering agent's choice.
		enableMaestroP: storedSession.enableMaestroP,
		maestroPMode: storedSession.maestroPMode,
		maestroPPath: storedSession.maestroPPath,
		onLog: deps.onLog,
		sshStore: deps.sshStore,
		agentConfigValues,
		onRunTranscript: deps.getOnRunTranscript?.(storedSession.id),
		appendSystemPrompt,
		isServerMode: deps.isServerMode,
		signal,
	});

	// Cue spawns agents outside the ProcessManager, so a failed run is the
	// only place an expired token can surface for a pipeline. Without this
	// the whole board goes quietly red until someone types a message. The
	// remote id is forwarded only while SSH is enabled: a disabled config
	// still carries its old id, and the run happened locally.
	const ssh = storedSession.sessionSshRemoteConfig;
	await deps.reportAuthFailure?.(
		result,
		storedSession.toolType,
		ssh?.enabled ? (ssh.remoteId ?? undefined) : undefined
	);

	// History reads Cue runs from `cue_events`, not the JSONL file -
	// see the note on the notify path above.
	return result;
}
