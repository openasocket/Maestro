/**
 * @file cross-agent-router.ts
 * @description The desktop's binding of the cross-agent consult service.
 *
 * Dispatching a consult (the prompt, the budgets, the completion rule, Stop) lives in the
 * library: `createConsultService()` in `src/shared/maestro-lib/agents/consult.ts`. This module
 * keeps the names and signatures the IPC handler and its tests already use, and supplies what
 * is the desktop's own: a `ProcessManager`-backed runner (`consult-runner.ts`), agent
 * resolution through the detector, and the SSH store.
 *
 * It is also where a desktop consult gets its lineage and its admission at the stage before
 * the target hears of it (MRC2-02-03), as `createRuntimeConsults()` gives a headless one:
 *
 * | Step | Piece |
 * | --- | --- |
 * | Initiator | the asking operation's record when the caller names one; else the consult the asker is itself answering (a consulted agent asking a third); else a lineage of this ask with the asking agent as the chain, unmanaged |
 * | Lineage | the consult is a CHILD of the initiator: derived as the sink derives a dispatched turn (`dispatchedChildContext`), so the record the admission binds and the record the process carries are one |
 * | Scope | the initiator's scope meets this host's standing (`intersectDelegationScope`): a managed initiator's child on a standalone desktop is refused, a managed desktop admits under its own generation |
 * | Route | under management the target's route must be one this build governs (`providerRouteSupport`): an unqualified route is refused before a listener attaches or a process starts |
 * | Access | a consult never widens what its initiator may do (`delegatedWritable`) |
 * | Admission | the lease is asked for at the sink (`ProcessManager.spawnAdmitted`, through `spawnGroupChatAgent`) on the final process spec, with the initiator's record and the minted ids |
 *
 * One service instance serves the whole app, so `cancelCrossAgentRequestsForSource` sees every
 * consult a source agent has in flight, whichever IPC call started it.
 */

import type { ProcessManager } from '../process-manager';
import type { AgentDetector } from '../agents';
import type { SshRemoteSettingsStore } from '../utils/ssh-remote-resolver';
import type { CrossAgentRequest, CrossAgentResponseChunk } from '../../shared/crossAgentTypes';
import {
	CROSS_AGENT_ASK_SESSION_ID,
	CROSS_AGENT_SESSION_PREFIX,
} from '../../shared/crossAgentTypes';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { ToolType } from '../../shared/types';
import {
	createConsultService,
	type CrossAgentTargetSession,
} from '../../shared/maestro-lib/agents/consult';
import {
	buildCrossAgentPrompt,
	serializeTranscript,
} from '../../shared/maestro-lib/agents/consult-prompt';
import {
	delegatedWritable,
	delegationContextOf,
	intersectDelegationScope,
	type ManagedDelegationContext,
} from '../../shared/maestro-lib/managed/delegation';
import type { ManagedDenialCode } from '../../shared/maestro-lib/managed/types';
import { providerRouteSupport } from '../../shared/maestro-lib/providers/capabilities';
import { createDesktopConsultRunner } from './consult-runner';
import type { GroupChatSpawnLineage } from '../group-chat/spawnGroupChatAgent';
import { dispatchedChildContext } from '../process-manager/ProcessManager';
import type { ProcessSpawnActor, ProcessSpawnAuthorityPort } from '../process-manager/types';
import { logger } from '../utils/logger';
import { buildMaestroSystemPromptForSession } from '../utils/maestro-system-prompt';

const LOG_CONTEXT = '[CrossAgentRouter]';

/**
 * Session-id prefix for the ephemeral processes cross-agent dispatch spawns.
 * Re-exported from `shared/crossAgentTypes` so the renderer's Process Monitor
 * can recognize a consult without importing from `src/main`.
 */
export { CROSS_AGENT_SESSION_PREFIX, buildCrossAgentPrompt, serializeTranscript };
export type { CrossAgentTargetSession };

const consultService = createConsultService();

/**
 * The consults running now, by request id: the record each target was handed and what it may
 * write. A consulted agent that asks another from its shell is this consult's child, and a
 * read-only consult never widens into a writable one on the way.
 */
const running = new Map<
	string,
	{ targetSessionId: string; delegation: ManagedDelegationContext; writable: boolean }
>();

/**
 * Stop every consult the given source agent still has in flight. Each is killed and settles
 * stamped `canceled`, not `error`, so the source agent's bubble reports that the user stopped it.
 *
 * @returns How many consults were cancelled.
 */
export function cancelCrossAgentRequestsForSource(sourceSessionId: string): number {
	return consultService.cancelForSource(sourceSessionId);
}

/**
 * Who is asking and who is answering in a consult that is still in flight, or
 * null once it has settled. A consult runs as an ephemeral
 * `cross-agent-<requestId>` process that carries neither agent's id, so this
 * is the only way a process listener can tell which agents it belongs to.
 */
export function getCrossAgentConsultParties(
	requestId: string
): { sourceSessionId: string; targetSessionId: string } | null {
	return consultService.parties(requestId);
}

/** The asking operation as the desktop knows it: its record, and whether it may write. */
export interface ConsultInitiator {
	delegation: ManagedDelegationContext;
	/** What the asking operation may write; null when unknown, which narrows nothing. */
	writable: boolean | null;
}

export type ConsultManagedState = 'denied' | 'unavailable';

/** Why a consult runs nowhere, decided at this stage, before the target hears of it. */
export interface ConsultRefusal {
	state: ConsultManagedState;
	code: ManagedDenialCode;
	message: string;
}

export interface StartCrossAgentRequestOptions {
	/** Concrete process manager (needed for both spawn and the data/exit events). */
	processManager: ProcessManager;
	/** Resolves an agent id to its executable config. */
	agentDetector: AgentDetector;
	/** SSH settings store; required only when the target opted into SSH. */
	sshStore: SshRemoteSettingsStore | null;
	/** Resolve the target agent's stored config from its session id. */
	getTargetSession: (sessionId: string) => CrossAgentTargetSession | null;
	/** Per-agent custom env vars (mirrors group chat's getCustomEnvVarsCallback). */
	getCustomEnvVars?: (toolType: string) => Record<string, string> | undefined;
	/** Per-agent config values (context window, model, effort, ...). */
	getAgentConfig?: (toolType: string) => Record<string, unknown> | undefined;
	/**
	 * When true, the user opted into read/write cross-agent mentions
	 * (`crossAgentMentionsWritable`), so the consult spawns with write access.
	 * Defaults to false: consults are read-only. Never wider than what the
	 * initiator may do (`delegatedWritable`).
	 */
	writable?: boolean;
	/**
	 * Who asked for the consult, as the sink binds it: the transport a dispatch
	 * ticket stood for (a `maestro-cli ask` over the WebSocket), else the
	 * caller's own standing. Absent for a typed mention: in-process.
	 */
	actor?: ProcessSpawnActor;
	/**
	 * The asking operation's own record, for a caller that can name it. Absent
	 * (every caller today): the consult the asker is itself answering, else a
	 * lineage of this ask with the asking agent as the chain (workflow null, no
	 * policy generation), as `createRuntimeConsults()` derives it headless.
	 */
	initiator?: ConsultInitiator;
	/** Called with each response chunk; `done: true` marks completion/failure. */
	onChunk: (chunk: CrossAgentResponseChunk) => void;
}

/** The asking agent of a request, or null for a `maestro-cli ask` that named none. */
const askingAgentOf = (request: CrossAgentRequest): string | null =>
	request.sourceSessionId && request.sourceSessionId !== CROSS_AGENT_ASK_SESSION_ID
		? request.sourceSessionId
		: null;

/**
 * The operation this consult is a child of. In order: the record the caller named; the
 * consult the asker is itself answering (a consulted agent asking a third, so the chain
 * deepens and a read-only consult never widens into a writable one); else a lineage of this
 * ask with the asker as the chain, unmanaged (workflow null, no generation). With several
 * consults on the asker, the newest is the parent and the narrowest access holds.
 */
export function resolveConsultInitiator(
	request: CrossAgentRequest,
	named?: ConsultInitiator
): ConsultInitiator {
	if (named) return named;
	const source = askingAgentOf(request);
	if (source) {
		const answering = [...running.values()].filter((entry) => entry.targetSessionId === source);
		const newest = answering.at(-1);
		if (newest) {
			return {
				delegation: newest.delegation,
				writable: answering.every((entry) => entry.writable),
			};
		}
	}
	const originId = `ask:${source ?? CROSS_AGENT_ASK_SESSION_ID}:${request.requestId}`;
	return {
		delegation: delegationContextOf({
			identity: {
				requestId: originId,
				idempotencyKey: originId,
				attemptId: originId,
				runId: null,
				rootRunId: null,
				parentRunId: null,
			},
			traceId: originId,
			workflow: null,
			delegation: {
				chain: source ? [{ kind: 'agent', id: source }] : [],
				grantRef: null,
			},
			policyRevision: null,
		}),
		writable: null,
	};
}

/**
 * The consult's lineage as the sink binds it: the initiator's record with this request as
 * the child's request and attempt (`dispatchedBy`), and the child record the sink derives
 * from the two and the process is stamped with (`child`). One derivation
 * (`dispatchedChildContext`) for the stamp and the admission, as a dispatched turn has.
 */
export function consultLineage(
	request: Pick<CrossAgentRequest, 'requestId'>,
	initiator: ConsultInitiator
): { dispatchedBy: GroupChatSpawnLineage; child: ManagedDelegationContext } {
	const dispatchedBy: GroupChatSpawnLineage = {
		delegation: initiator.delegation,
		dispatchedAs: { requestId: request.requestId, attemptId: request.requestId },
	};
	const child = dispatchedChildContext({
		sessionId: `${CROSS_AGENT_SESSION_PREFIX}${request.requestId}`,
		...dispatchedBy,
	});
	if (!child) throw new Error('A consult lineage needs the asking operation record.');
	return { dispatchedBy, child };
}

/**
 * The host's port, or null for a process manager double with no port, which is standalone by
 * construction (as `spawnGroupChatAgent` treats a double with no admitted path).
 */
const managedPortOf = (processManager: ProcessManager): ProcessSpawnAuthorityPort | null =>
	typeof processManager.managedPort === 'function' ? processManager.managedPort() : null;

/**
 * Whether a consult may be started at all, decided on the host's standing NOW and before
 * anything is attached, written or spawned. Standalone: a managed initiator's child is refused
 * (a consult is not a way out of management), anything else runs as before. Managed: the
 * initiator's scope meets this host's generation, and the target's route must be one this build
 * governs: the local child-process route of a provider the table marks `implemented`. A target
 * over SSH is refused here, since the consult spawn binds no remote endpoint identity (the
 * remote runtime's own attestation qualifies a tab spawn, MRC-08-04B, and a consult carries
 * none); nothing is run unmanaged in its place. The lease itself is asked for at the sink.
 */
export function consultRefusal(
	port: ProcessSpawnAuthorityPort | null,
	initiator: Pick<ManagedDelegationContext, 'policyRevision' | 'identity'>,
	target: Pick<CrossAgentTargetSession, 'name' | 'toolType' | 'sshRemoteConfig'> | null
): ConsultRefusal | null {
	const managed = port && port.standing() === 'managed' ? port : null;
	const scope = intersectDelegationScope(initiator, {
		standing: managed ? 'managed' : 'standalone',
		policyRevision: managed ? managed.policy().policyRevision : null,
	});
	if (!scope.ok) return { state: scope.state, code: scope.code, message: scope.message };
	if (!managed || !target) return null;
	if (scope.reauthorized) {
		logger.info(
			`The asking run was admitted under policy revision ${initiator.policyRevision ?? 'none'}; this host admits the consult under ${scope.policyRevision ?? 'none'}.`,
			LOG_CONTEXT
		);
	}
	const provider = getAgentDisplayName(target.toolType);
	if (target.sshRemoteConfig?.enabled) {
		return {
			state: 'unavailable',
			code: 'capability-unsupported',
			message: `Managed execution of ${target.name}'s consult over the ssh route is unavailable on this host: the consult spawn binds no qualified remote endpoint (the remote runtime's own attestation qualifies a tab spawn, never this host's route table). Nothing was started.`,
		};
	}
	const support = providerRouteSupport(target.toolType).find(
		(entry) => entry.route === 'child-process'
	);
	if (support?.managed === 'implemented') return null;
	return {
		state: 'unavailable',
		code: 'capability-unsupported',
		message: `Managed execution of ${provider} over the child-process route is unavailable on this host: ${support?.note ?? 'the route is not known'}. Nothing was started.`,
	};
}

/**
 * Dispatch a cross-agent request to the target agent without blocking the caller. Response
 * text is streamed back via `opts.onChunk`; the promise resolves once the spawn has been
 * initiated (or an error chunk emitted).
 */
export async function startCrossAgentRequest(
	request: CrossAgentRequest,
	opts: StartCrossAgentRequestOptions
): Promise<void> {
	// The lineage first: who is asking, as a record the sink can bind, and what the consult is
	// a child of. Access is the narrower of what the initiator may do and what the settings
	// allow this consult.
	const initiator = resolveConsultInitiator(request, opts.initiator);
	const { dispatchedBy, child } = consultLineage(request, initiator);
	const writable = delegatedWritable(initiator.writable, opts.writable ?? false);

	// Refused (or not) on the host's standing now, before a listener attaches, a tab is written
	// or a process starts: a refused consult leaves nothing on the target and names why.
	const target = opts.getTargetSession(request.targetSessionId);
	const refusal = consultRefusal(managedPortOf(opts.processManager), initiator.delegation, target);
	if (refusal) {
		logger.warn(
			`${target?.name ?? request.targetSessionId} was not consulted (${refusal.state}, ${refusal.code}): ${refusal.message}`,
			LOG_CONTEXT,
			{ requestId: request.requestId, targetSessionId: request.targetSessionId }
		);
		opts.onChunk({
			requestId: request.requestId,
			sourceSessionId: request.sourceSessionId,
			sourceTabId: request.sourceTabId,
			targetSessionId: request.targetSessionId,
			targetTabId: request.targetTabId,
			targetAgentName: target?.name ?? request.targetSessionId,
			targetToolType: (target?.toolType ?? 'claude-code') as ToolType,
			chunk: '',
			done: true,
			error: `[managed-${refusal.state}] ${refusal.message}`,
		});
		return;
	}

	running.set(request.requestId, {
		targetSessionId: request.targetSessionId,
		delegation: child,
		writable,
	});
	const onChunk = (chunk: CrossAgentResponseChunk): void => {
		if (chunk.done) running.delete(request.requestId);
		opts.onChunk(chunk);
	};
	try {
		await consultService.start(request, {
			runner: createDesktopConsultRunner(opts.processManager, opts.sshStore, {
				actor: opts.actor,
				dispatchedBy,
			}),
			resolveAgent: (providerId) => opts.agentDetector.getAgent(providerId),
			sshStore: opts.sshStore,
			getTargetSession: opts.getTargetSession,
			getCustomEnvVars: opts.getCustomEnvVars,
			getAgentConfig: opts.getAgentConfig,
			writable,
			// The child record: stamped on the process by the service, bound at the sink through
			// the runner's `dispatchedBy`, the same record both ways.
			delegation: child,
			getSystemPrompt: (consulted) => buildMaestroSystemPromptForSession(consulted.id),
			onChunk,
		});
	} catch (err) {
		running.delete(request.requestId);
		throw err;
	}
}
