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
	type AdmissionRequest,
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
import { delegationContextOf } from '../../shared/maestro-lib/managed/delegation';
import {
	isWorkflowFenceRefusal,
	type WorkflowFenceAnswer,
	type WorkflowFenceLifetime,
} from '../../shared/maestro-lib/managed/workflows';
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
import { projectCueEventPaths } from './cue-template-context-builder';

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
	sessionSshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
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
	/**
	 * Trusted host consumer for a managed Auto Run. Carry this admission context
	 * into the child workflow, reauthorize each task/retry at its actual sink, and
	 * honor the signal until termination. Resolve with the run's terminal result,
	 * not a launcher acknowledgement: the router retains ownership until then.
	 * The legacy renderer handoff cannot carry this custody and is never a fallback.
	 */
	onManagedAutoRun?: (
		params: Parameters<NonNullable<CueRunActionDeps['onAutoRun']>>[0] & {
			admission: CueManagedAdmission;
			managed?: ManagedLaunchInput;
			signal?: AbortSignal;
		}
	) => Promise<CueRunResult>;
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
	 * lone subscription), claimed on EVERY run for this run id and attempt
	 * (MRC-07-06): the host's `WorkflowOwnership.claim` through the endpoint's
	 * workflow owner producer (`workflowFenceOf()` in
	 * `src/shared/maestro-lib/managed/workflows.ts`). A refusal names why
	 * (the producer missing, the registry holding another owner, a lost
	 * answer) and is the run's result; a bare null is an unowned workflow. A
	 * managed host runs none of an unowned workflow, the router never mints a
	 * fence, and Cue stays the scheduler.
	 */
	workflowFence?(
		workflow: CueWorkflowIdentity,
		run: { runId: string; attemptId: string }
	): WorkflowFenceAnswer | Promise<WorkflowFenceAnswer>;
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
async function bindCueManagedRun(
	deps: CueManagedDeps | undefined,
	lineage: CueRunLineage,
	signal?: AbortSignal
): Promise<CueManagedBinding | null> {
	if (isLaunchCancelled(signal)) return null;
	const port = deps?.port();
	if (!deps || !port || port.standing() === 'standalone') return { managed: false };
	const authority = port.authority;
	const refuse = (state: CueManagedState, code: ManagedDenialCode, message: string) => {
		deps.onAdmission?.({ kind: 'refused', lineage, state, code, message });
		return { managed: true, refusal: { state, code, message } } as const;
	};
	// The fence is claimed for this very run and attempt, so a retry and a
	// restored queue entry each re-confirm the owner instead of reusing a
	// decision; the producer's refusal, when it has one, is the run's reason.
	const fence =
		(await deps.workflowFence?.(lineage.workflow, {
			runId: lineage.identity.requestId,
			attemptId: lineage.identity.attemptId,
		})) ?? null;
	// Stop also owns an outstanding owner claim. Its late answer is not permission
	// to prepare a process; the existing workflow owner service retains the fence.
	if (isLaunchCancelled(signal)) return null;
	if (isWorkflowFenceRefusal(fence)) return refuse(fence.state, fence.code, fence.message);
	if (!fence) {
		return refuse(
			'unavailable',
			'runtime-unavailable',
			`Cue workflow "${lineage.workflow.workflowId}" has no workflow owner fence; a managed host does not run an unowned workflow, and the Cue engine does not mint one (CP-03, the workflow owner producer).`
		);
	}
	// A claim can await the endpoint while enrollment or the authority changes.
	// Re-read the port (headless hosts rebuild it) and compare the authority object,
	// not its name. Never use the old port or downgrade this firing to standalone.
	const current = deps.port();
	if (!current || current.standing() !== 'managed' || current.authority !== authority) {
		return refuse(
			'unavailable',
			'runtime-unavailable',
			'The Cue host standing or authority changed while claiming workflow ownership; no executor was started.'
		);
	}
	const lifetime = fence.lifetime;
	const policy = current.policy();
	const contextInput = structuredClone({
		identity: lineage.identity,
		traceId: lineage.traceId,
		policyRevision: policy.policyRevision,
		workflow: cueWorkflowRef(lineage.workflow, fence),
		delegation: lineage.delegation,
	});
	const verified = current.context(contextInput);
	if (!verified.ok) {
		return refuse(
			'denied',
			verified.code,
			`The run's context was not accepted: ${verified.problems.join('; ')}`
		);
	}
	// Preparation and admission can await the host. Keep the scope the child
	// environment was built on, rather than silently refreshing it at the sink.
	const scopeKey = ({ context, policy }: Pick<AdmissionRequest, 'context' | 'policy'>) =>
		canonicalJson({
			...context,
			verification: { ...context.verification, verifiedAt: undefined },
			policy,
		});
	const boundScope = scopeKey({ context: verified.context, policy });
	const scopeRefusal = (
		request: Pick<AdmissionRequest, 'context' | 'policy'> = { context: verified.context, policy }
	) => {
		let message: string;
		try {
			const live = deps.port();
			if (lifetime && (!lifetime.current() || lifetime.signal.aborted)) {
				message = 'The Cue workflow owner fence is no longer current.';
			} else if (scopeKey(request) !== boundScope) {
				message = 'The Cue admission no longer carries the prepared context and policy.';
			} else if (!live || live.standing() !== 'managed' || live.authority !== authority) {
				message = 'The Cue host standing or authority changed before dispatch.';
			} else {
				const livePolicy = live.policy();
				const liveContext = live.context({
					...structuredClone(contextInput),
					policyRevision: livePolicy.policyRevision,
				});
				if (
					liveContext.ok &&
					scopeKey({ context: liveContext.context, policy: livePolicy }) === boundScope
				) {
					return null;
				}
				message = 'The Cue context or policy changed before dispatch.';
			}
		} catch (error) {
			message = `The Cue host scope could not be rechecked: ${error instanceof Error ? error.message : String(error)}`;
		}
		return { state: 'unavailable', code: 'runtime-unavailable', message } as const;
	};
	// This facade retains the producer's lease and forwards its lifecycle. The
	// canonical leaseAdmission gate still performs the final snapshot check.
	const scopedAuthority: HostAuthority = {
		get authorityId() {
			return authority.authorityId;
		},
		async admit(request) {
			const before = scopeRefusal(request);
			if (before) return before;
			const outcome = await authority.admit(request);
			// A lost reply retains its reconciliation obligation even if the host
			// changed meanwhile. Only a granted lease can progress to the sink.
			if (outcome.state !== 'admitted') return outcome;
			const after = scopeRefusal(request);
			if (after) {
				outcome.lease.release({ outcome: 'spawn-failed', message: after.message });
				return after;
			}
			return outcome;
		},
		check(lease, digest) {
			const refusal = scopeRefusal();
			if (refusal) lease.release({ outcome: 'spawn-failed', message: refusal.message });
			return authority.check(lease, digest);
		},
		revoke: (leaseId, reason) => authority.revoke(leaseId, reason),
		revokeAll: (reason) => authority.revokeAll(reason),
		live: () => authority.live(),
	};
	return {
		managed: true,
		admission: {
			authority: scopedAuthority,
			context: verified.context,
			policy,
			account: deps.account ?? null,
			onLease: (lease: DispatchLease) =>
				deps.onAdmission?.({ kind: 'admitted', lineage, leaseId: lease.leaseId }),
		},
		...(deps.launch ? { launch: deps.launch } : {}),
	};
}

async function executeBoundCueRunAction(
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
	}: OnCueRunParams,
	onDispatch?: () => void
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
			pipelineName: pipelineName ?? undefined,
			event,
		});
	if (isLaunchCancelled(signal)) return stoppedResult();

	// A managed host refused the run before anything started: the run's result,
	// with the reason in stderr, never a reason to run it unmanaged.
	const managedRefusalResult = (refusal: {
		state: CueManagedState;
		code: ManagedDenialCode;
		message: string;
	}): CueRunResult => {
		const { state, code, message } = refusal;
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
			executionStarted: false,
			stdout: '',
			stderr: `[managed-${state}] ${message}`,
			exitCode: null,
			durationMs: 0,
			startedAt,
			endedAt: startedAt,
			managed: { state, code },
		};
	};

	const ssh = storedSession.sessionSshRemoteConfig;
	const projectRoot =
		(ssh?.enabled && ssh.workingDirOverride) ||
		storedSession.projectRoot ||
		storedSession.cwd ||
		storedSession.fullPath ||
		os.homedir();
	if (ssh?.enabled && (event.type === 'task.pending' || event.type === 'file.changed')) {
		const remote = deps.sshStore.getSshRemotes().find((candidate) => candidate.id === ssh.remoteId);
		if (remote) event = projectCueEventPaths(event, remote);
	}
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
		// An awaited claim must not let a caller replace the document list or
		// settings after the owner bound its version. Keep one captured payload.
		autoRun = autoRun ? structuredClone(autoRun) : undefined;
		const subscription = {
			name: subscriptionName,
			event: event.type,
			enabled: true,
			prompt,
			action,
			auto_run: autoRun,
			agent_id: storedSession.id,
			pipeline_name: pipelineName ?? undefined,
		};
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
		const binding = await bindCueManagedRun(
			deps.managed,
			cueRunLineage({
				runId,
				chainRootId,
				parentEventId,
				pipelineName,
				subscriptionName,
				prompt: canonicalJson({ prompt, autoRun }),
				action,
				event,
				ownerAgentId: storedSession.id,
				attemptId: deps.managed?.newId?.() ?? generateUUID(),
			}),
			signal
		);
		if (!binding || isLaunchCancelled(signal)) return stoppedResult();
		if (binding.managed && 'refusal' in binding) return managedRefusalResult(binding.refusal);
		if (binding.managed) {
			if (!deps.onManagedAutoRun) {
				return managedRefusalResult({
					state: 'unavailable',
					code: 'runtime-unavailable',
					message: 'This host has no managed Auto Run consumer for Cue workflow custody.',
				});
			}
			onDispatch?.();
			return deps.onManagedAutoRun({
				runId,
				session: sessionInfo,
				subscription,
				event,
				autoRun,
				admission: binding.admission,
				...(binding.launch ? { managed: binding.launch } : {}),
				signal,
			});
		}
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
		if (command.mode === 'shell') {
			// A shell action is admitted on the same lineage as a prompt run
			// (MRC-07-03): the subscription, the pipeline, the chain root and the
			// event, bound here on this firing. Its versioned text is the command
			// itself (the `prompt` slot is only the dispatcher's carrier), so an
			// edit to the command is a new workflow version. The executor asks the
			// authority on the final substituted command, cwd, environment and
			// route; a refusal here or there is the run's result.
			const binding = await bindCueManagedRun(
				deps.managed,
				cueRunLineage({
					runId,
					chainRootId,
					parentEventId,
					pipelineName,
					subscriptionName,
					prompt: command.shell,
					action,
					event,
					ownerAgentId: storedSession.id,
					attemptId: deps.managed?.newId?.() ?? generateUUID(),
				}),
				signal
			);
			if (!binding || isLaunchCancelled(signal)) return stoppedResult();
			if (binding.managed && 'refusal' in binding) return managedRefusalResult(binding.refusal);
			onDispatch?.();
			return deps.executeCueShell({
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
				...(binding.managed ? { admission: binding.admission } : {}),
			});
		}
		// A maestro-cli action is a NESTED dispatch (MRC-07-04): this run is
		// the initiator, the target agent's turn its child. Bound on the same
		// lineage as a prompt run, versioned on the call itself; the executor
		// hands the child the run's causal context (the verified context's half
		// under management, the bare lineage standalone) and judges the route.
		const cliLineage = cueRunLineage({
			runId,
			chainRootId,
			parentEventId,
			pipelineName,
			subscriptionName,
			prompt: canonicalJson(command.cli),
			action,
			event,
			ownerAgentId: storedSession.id,
			attemptId: deps.managed?.newId?.() ?? generateUUID(),
		});
		const cliBinding = await bindCueManagedRun(deps.managed, cliLineage, signal);
		if (!cliBinding || isLaunchCancelled(signal)) return stoppedResult();
		if (cliBinding.managed && 'refusal' in cliBinding) {
			return managedRefusalResult(cliBinding.refusal);
		}
		const delegation = delegationContextOf(
			cliBinding.managed
				? cliBinding.admission.context
				: {
						identity: cliLineage.identity,
						traceId: cliLineage.traceId,
						workflow: null,
						delegation: cliLineage.delegation,
						policyRevision: null,
					}
		);
		onDispatch?.();
		return deps.executeCueCli({
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
			delegation,
			...(cliBinding.managed ? { admission: cliBinding.admission } : {}),
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
	const binding = await bindCueManagedRun(deps.managed, lineage, signal);
	if (!binding || isLaunchCancelled(signal)) return stoppedResult();
	if (binding.managed && 'refusal' in binding) return managedRefusalResult(binding.refusal);

	onDispatch?.();
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
	await deps.reportAuthFailure?.(
		result,
		storedSession.toolType,
		ssh?.enabled ? (ssh.remoteId ?? undefined) : undefined
	);

	// History reads Cue runs from `cue_events`, not the JSONL file -
	// see the note on the notify path above.
	return result;
}

/** Keep a claimed workflow's live custody through preparation, execution and settlement. */
export async function executeCueRunAction(
	deps: CueRunActionDeps,
	params: OnCueRunParams
): Promise<CueRunResult> {
	const managed = deps.managed;
	if (!managed?.workflowFence) return executeBoundCueRunAction(deps, params);
	let lifetime: WorkflowFenceLifetime | undefined;
	let dispatched = false;
	let outcome: { result: CueRunResult } | { error: unknown };
	const stopped = new AbortController();
	const stop = () => {
		if (stopped.signal.aborted) return;
		stopped.abort();
		// The same registry owns local and SSH processes. Pending executors see
		// the signal instead, and retain any late admission until they settle it.
		deps.stopCueRun(params.runId);
	};
	try {
		const result = await executeBoundCueRunAction(
			{
				...deps,
				managed: {
					...managed,
					workflowFence: async (workflow, run) => {
						const answer = (await managed.workflowFence?.(workflow, run)) ?? null;
						if (answer && !isWorkflowFenceRefusal(answer) && answer.lifetime) {
							lifetime = answer.lifetime;
							lifetime.signal.addEventListener('abort', stop, { once: true });
							if (lifetime.signal.aborted || !lifetime.current()) stop();
						}
						return answer;
					},
				},
			},
			{
				...params,
				signal: params.signal ? AbortSignal.any([params.signal, stopped.signal]) : stopped.signal,
			},
			() => {
				dispatched = true;
			}
		);
		outcome = { result };
	} catch (error) {
		outcome = { error };
	} finally {
		// Settlement can itself revoke the lifetime. Detach first so it cannot
		// stop a later run that reused this run id.
		lifetime?.signal.removeEventListener('abort', stop);
	}
	if (lifetime) {
		const result = 'result' in outcome ? outcome.result : undefined;
		const effect =
			result?.managed?.state === 'unknown'
				? 'uncertain'
				: !dispatched || result?.executionStarted === false
					? 'no_effect'
					: result?.executionStarted === true && result.status === 'completed'
						? 'applied'
						: 'uncertain';
		try {
			await lifetime.finish(effect);
		} catch (error) {
			// A completed executor is not a settled workflow. Let the run manager
			// record the failure; a warning plus success could advance the chain.
			if ('error' in outcome) {
				throw Object.assign(new Error('Cue execution and workflow settlement failed'), {
					cause: outcome.error,
					errors: [outcome.error, error],
				});
			}
			throw error;
		}
	}
	if ('error' in outcome) throw outcome.error;
	return outcome.result;
}
