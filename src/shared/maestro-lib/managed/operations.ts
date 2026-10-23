/**
 * The managed operations facade: `ManagedApi` answered by a Maestro host over
 * its own repository, run journal, process registry and turn service.
 *
 * Every operation but `negotiate` takes an envelope whose context is
 * attribution the host has yet to believe. The order inside each one is
 * fixed: verify the context (the verifier is the only producer of the branded
 * type), check that the capability was asked for, validate the input, then do
 * the work through the same services the desktop and the TUI use. Nothing
 * here starts a process: `submit` records the run in the journal and hands a
 * dispatch to the turn service, and the authority admits it at the real sink
 * (`runAgentTurn`), immediately before the spawn.
 *
 * Answers are the inner `ManagedOperationResult`, so the four non-success
 * states stay apart: `denied` (a decision), `unsupported` (no code path),
 * `unavailable` (no authority, a fenced host, a journal that could not be
 * written before anything ran) and `unknown` (an attempt whose fate the host
 * cannot state). Every answer carries the request id it answers, so a peer
 * correlates by exact input and never by position.
 *
 * Content is checked against its digest and resources resolve through an
 * injected table of approved handles; an id the host does not know is a
 * denial, not an empty attachment. A launch admitted here says nothing about
 * what the provider does once it runs; that stays reported per route.
 */
import type {
	ManagedApi,
	ManagedAgentSummary,
	ManagedEventsQuery,
	ManagedIdentity,
} from '../client/types';
import type { AgentRecord, AITabRecord } from '../store/records';
import {
	MANAGED_CAPABILITY_SUPPORT,
	MANAGED_ENDPOINT_PROTOCOLS,
	hostCompatibilityProfile,
	negotiateCompatibility,
	type SupportEntry,
} from './compatibility';
import {
	sha256Hex,
	type ContextVerifier,
	type HostAuthority,
	type PolicySourceSet,
} from './authority';
import type { ManagedBinding } from './binding';
import type { EventJournal } from './event-journal';
import type { ManagedPolicyStatus } from './host-adapter';
import { journalRunRecord, type RunJournal } from './run-journal';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedAuthenticatedContext,
	type ManagedCapability,
	type ManagedControlReceipt,
	type ManagedDenialCode,
	type ManagedEventPage,
	type ManagedInstallationIdentity,
	type ManagedNegotiationOutcome,
	type ManagedOperationContext,
	type ManagedOperationEnvelope,
	type ManagedOperationResult,
	type ManagedPeerAuthentication,
	type ManagedRunRecord,
	type ManagedSubmitInput,
	type ManagedSubmitReceipt,
} from './types';

/** A content or resource handle the host has approved for managed runs. */
export interface ApprovedResource {
	id: string;
	kind: 'file' | 'document' | 'image';
	/** Where it resolves on this host. Never sent back to the peer. */
	path: string;
	sha256: string | null;
}

/**
 * What `submit` hands the turn service for one attempt. The turn service
 * passes it through to `runAgentTurn`, which asks the authority to admit the
 * final snapshot and journals the attempt as it goes.
 */
export interface ManagedDispatch {
	context: ManagedAuthenticatedContext;
	authority: HostAuthority;
	policy: PolicySourceSet;
	journal: RunJournal;
	runId: string;
	attemptId: string;
	resources: readonly ApprovedResource[];
}

export type ManagedSendResult =
	| { status: 'started' | 'queued' }
	| {
			status: 'refused';
			reason: 'managed-denied' | 'managed-unavailable' | 'managed-unknown' | 'other';
			message: string;
	  };

/** The turn service's side of a managed dispatch (implemented by `runtime/turns.ts`). */
export interface ManagedTurnPort {
	sendManaged(
		agentId: string,
		tabId: string,
		text: string,
		dispatch: ManagedDispatch
	): Promise<ManagedSendResult>;
	/** Stop or dequeue the attempt serving a run. `none` when nothing of it is held. */
	cancelRun(runId: string, kind: 'cancel' | 'interrupt'): Promise<'stopped' | 'dequeued' | 'none'>;
}

export interface ManagedOperationsDeps {
	installation: ManagedInstallationIdentity;
	binding: Pick<ManagedBinding, 'authority' | 'state'>;
	/** The verifier of the host's own in-process callers: an envelope that names no `peer`. */
	verifier: ContextVerifier;
	/**
	 * One verifier per further transport the facade is reachable over (MRC-08-05A),
	 * keyed by the `peer` the host's handler stamps on the envelope. An envelope
	 * naming a transport with no verifier here is refused `unauthenticated`;
	 * nothing falls back to the in-process verifier.
	 */
	verifiers?: Partial<Record<ManagedPeerAuthentication, ContextVerifier>>;
	journal: RunJournal;
	repository: {
		listAgents(): AgentRecord[];
		getAgent(agentId: string): AgentRecord | undefined;
		getTab(agentId: string, tabId: string): AITabRecord | undefined;
	};
	turns: ManagedTurnPort;
	/** The provider ids this host can plan a turn for, for negotiation. */
	providers(): readonly string[];
	/** The approved handle for an id, or null. Default: none is approved. */
	resolveResource?(id: string, context: ManagedAuthenticatedContext): ApprovedResource | null;
	/** Which agents a verified actor may see. Default: every agent of this installation. */
	scopeAgents?(context: ManagedAuthenticatedContext, agents: AgentRecord[]): AgentRecord[];
	/** The policy sources the host reads from, for the admission request. */
	policy(): PolicySourceSet;
	/** The policy projection of the host adapter; absent on a host with none (`policy` answers unsupported). */
	policyStatus?(): ManagedPolicyStatus;
	capabilities?: readonly SupportEntry<ManagedCapability>[];
	/** The durable event journal `events` pages from (MRC-10-02A); absent on a host with none, which answers unsupported. */
	events?: Pick<EventJournal, 'page'>;
}

type Result<T> = ManagedOperationResult<T>;

const ok = <T>(requestId: string, value: T): Result<T> => ({ status: 'ok', requestId, value });

function refuse<T>(
	status: 'denied' | 'unsupported' | 'unavailable' | 'unknown',
	requestId: string,
	code: ManagedDenialCode,
	message: string
): Result<T> {
	return { status, requestId, code, message };
}

function requestIdOf(context: unknown): string {
	const identity = (context as { identity?: { requestId?: unknown } } | null)?.identity;
	return typeof identity?.requestId === 'string' ? identity.requestId : '';
}

const MAX_PAGE = 200;

export function createManagedOperations(deps: ManagedOperationsDeps): ManagedApi {
	// This build's table says events.resume is unsupported; a host that attached a journal has it.
	const support =
		deps.capabilities ??
		MANAGED_CAPABILITY_SUPPORT.map((entry) =>
			entry.key === 'events.resume' && deps.events
				? {
						...entry,
						status: 'implemented' as const,
						evidence: 'src/__tests__/shared/maestro-lib/managed/event-journal.test.ts',
						note: 'durable event journal pages with gap completeness; no real peer paired',
					}
				: entry
		);
	const resolveResource = deps.resolveResource ?? (() => null);
	const scopeAgents = deps.scopeAgents ?? ((_context, agents) => agents);
	/** The verifier of each transport, the in-process one under its own name. */
	const verifiers: Partial<Record<ManagedPeerAuthentication, ContextVerifier>> = {
		'in-process': deps.verifier,
		...deps.verifiers,
	};
	const transports = Object.keys(verifiers) as ManagedPeerAuthentication[];

	/** Verify the context over the transport the host stamped, and the capability, or answer why not. */
	function admitContext<T>(
		envelope: ManagedOperationEnvelope<unknown>,
		capability: ManagedCapability
	): { ok: true; context: ManagedAuthenticatedContext } | { ok: false; result: Result<T> } {
		const requestId = requestIdOf(envelope?.context);
		const peer = envelope?.peer ?? 'in-process';
		const verifier = Object.prototype.hasOwnProperty.call(verifiers, peer)
			? verifiers[peer]
			: undefined;
		if (!verifier) {
			return {
				ok: false,
				result: refuse(
					'denied',
					requestId,
					'unauthenticated',
					`This host verifies no caller over the ${String(peer)} transport; the operation was not admitted.`
				),
			};
		}
		const verified = verifier.verify(envelope?.context);
		if (!verified.ok) {
			return {
				ok: false,
				result: refuse('denied', requestId, verified.code, verified.problems.join('; ')),
			};
		}
		if (!verified.context.requestedCapabilities.includes(capability)) {
			return {
				ok: false,
				result: refuse(
					'denied',
					requestId,
					'capability-unsupported',
					`The context did not request ${capability}.`
				),
			};
		}
		return { ok: true, context: verified.context };
	}

	function page<T>(items: readonly T[], cursorIndex: number, limit: number): T[] {
		return items.slice(cursorIndex, cursorIndex + Math.max(1, Math.min(limit, MAX_PAGE)));
	}

	const api: ManagedApi = {
		async negotiate(offer) {
			const outcome = negotiateCompatibility(
				hostCompatibilityProfile({
					providers: deps.providers(),
					transports,
					capabilities: support,
				}),
				{
					contractVersions: offer.supportedVersions,
					endpointProtocols: MANAGED_ENDPOINT_PROTOCOLS,
					transport: 'in-process',
					required: offer.required,
					optional: offer.optional,
				}
			);
			let value: ManagedNegotiationOutcome;
			if (outcome.outcome === 'activated') {
				value = {
					outcome: 'activated',
					contractVersion: outcome.contractVersion,
					capabilities: outcome.capabilities,
				};
			} else {
				const first = outcome.reasons[0];
				const reason =
					first?.reason === 'contract-version'
						? 'unsupported-version'
						: first?.reason === 'unknown-capability'
							? 'unknown-capability'
							: 'missing-required-capability';
				value = { outcome: 'denied', reason, missing: outcome.reasons.map((r) => r.detail) };
			}
			return { ok: true, value };
		},

		async identity(envelope) {
			const admitted = admitContext<ManagedIdentity>(envelope, 'capabilities.negotiate');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			const binding = deps.binding.state();
			const value: ManagedIdentity = {
				actor: context.actor,
				delegation: context.delegation,
				installation: deps.installation,
				verification: context.verification,
				binding: binding.state,
				authorityId: binding.state === 'enrolled' ? binding.record.authorityId : null,
				policyRevision: deps.policy().policyRevision,
				capabilities: support.map((entry) => ({ key: entry.key, status: entry.status })),
			};
			return { ok: true, value: ok(context.identity.requestId, value) };
		},

		async agents(envelope) {
			const admitted = admitContext<{
				items: ManagedAgentSummary[];
				nextCursor: string | null;
			}>(envelope, 'agents.list');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			const { cursor, limit } = envelope.input;
			const visible = scopeAgents(context, deps.repository.listAgents());
			const start = cursor === null ? 0 : visible.findIndex((agent) => agent.id === cursor) + 1;
			if (cursor !== null && start === 0) {
				return {
					ok: true,
					value: refuse('denied', context.identity.requestId, 'not-found', 'Unknown cursor.'),
				};
			}
			const items = page(visible, start, limit).map(
				(agent): ManagedAgentSummary => ({
					agentId: agent.id,
					name: agent.name,
					providerId: agent.toolType,
					cwd: agent.cwd ?? null,
					tabIds: (agent.aiTabs ?? []).map((tab) => tab.id),
					activeTabId: agent.activeTabId ?? null,
				})
			);
			const last = items[items.length - 1];
			const nextCursor = last && start + items.length < visible.length ? last.agentId : null;
			return { ok: true, value: ok(context.identity.requestId, { items, nextCursor }) };
		},

		async runs(envelope) {
			const admitted = admitContext<{ items: ManagedRunRecord[]; nextCursor: string | null }>(
				envelope,
				'runs.list'
			);
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			const listed = deps.journal.list({
				...(envelope.input.agentId ? { agentId: envelope.input.agentId } : {}),
				cursor: envelope.input.cursor,
				limit: envelope.input.limit,
			});
			return {
				ok: true,
				value: ok(context.identity.requestId, {
					items: listed.items.map(journalRunRecord),
					nextCursor: listed.nextCursor,
				}),
			};
		},

		async submit(envelope) {
			const admitted = admitContext<ManagedSubmitReceipt>(envelope, 'runs.submit');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			const requestId = context.identity.requestId;
			const input: ManagedSubmitInput = envelope.input;
			const deny = (code: ManagedDenialCode, message: string) => ({
				ok: true as const,
				value: refuse<ManagedSubmitReceipt>('denied', requestId, code, message),
			});

			if (!input || typeof input !== 'object' || typeof input.content?.text !== 'string') {
				return deny('invalid-input', 'The input has no content.');
			}
			if (sha256Hex(input.content.text) !== input.content.sha256) {
				return deny('invalid-input', 'content.sha256 does not match content.text.');
			}
			const agent = deps.repository.getAgent(input.agentId);
			if (!agent) return deny('not-found', `No agent ${input.agentId}.`);
			if (agent.toolType !== input.providerId) {
				return deny(
					'context-mismatch',
					`Agent ${agent.id} runs ${agent.toolType}, the submission names ${input.providerId}.`
				);
			}
			const tabId = input.tabId ?? agent.activeTabId ?? agent.aiTabs?.[0]?.id ?? null;
			if (!tabId || !deps.repository.getTab(agent.id, tabId)) {
				return deny('not-found', `No tab ${input.tabId ?? '(active)'} on agent ${agent.id}.`);
			}
			const resources: ApprovedResource[] = [];
			for (const id of input.resourceIds ?? []) {
				const resource = resolveResource(id, context);
				if (!resource) return deny('policy-denied', `Resource ${id} is not an approved handle.`);
				resources.push(resource);
			}

			const authority = deps.binding.authority();
			let recorded;
			try {
				recorded = await deps.journal.submit({
					idempotencyKey: context.identity.idempotencyKey,
					requestId,
					attemptId: context.identity.attemptId,
					runId: context.identity.runId,
					rootRunId: context.identity.rootRunId,
					parentRunId: context.identity.parentRunId,
					agentId: agent.id,
					tabId,
					providerId: agent.toolType,
					contentSha256: input.content.sha256,
					resourceIds: input.resourceIds ?? [],
					actor: context.actor,
					traceId: context.traceId,
				});
			} catch (error) {
				return {
					ok: true,
					value: refuse(
						'unavailable',
						requestId,
						'runtime-unavailable',
						`The run journal could not be written, so nothing was started: ${error instanceof Error ? error.message : String(error)}`
					),
				};
			}
			switch (recorded.disposition) {
				case 'conflict':
					return deny(
						'idempotency-conflict',
						`Idempotency key ${context.identity.idempotencyKey} already names a different submission.`
					);
				case 'unknown':
					return {
						ok: true,
						value: refuse(
							'unknown',
							requestId,
							'outcome-unknown',
							`Run ${recorded.run.runId} was dispatched and its outcome is not known; it is not resent.`
						),
					};
				case 'replayed':
					return {
						ok: true,
						value: ok(requestId, { run: journalRunRecord(recorded.run), disposition: 'replayed' }),
					};
				case 'accepted':
					break;
			}

			const sent = await deps.turns.sendManaged(agent.id, tabId, input.content.text, {
				context,
				authority,
				policy: deps.policy(),
				journal: deps.journal,
				runId: recorded.run.runId,
				attemptId: recorded.attempt.attemptId,
				resources,
			});
			const run = deps.journal.get(recorded.run.runId) ?? recorded.run;
			if (sent.status === 'refused') {
				switch (sent.reason) {
					case 'managed-denied':
						return deny('policy-denied', sent.message);
					case 'managed-unavailable':
						return {
							ok: true,
							value: refuse('unavailable', requestId, 'runtime-unavailable', sent.message),
						};
					case 'managed-unknown':
						return {
							ok: true,
							value: refuse('unknown', requestId, 'outcome-unknown', sent.message),
						};
					case 'other':
						break;
				}
			}
			return {
				ok: true,
				value: ok(requestId, { run: journalRunRecord(run), disposition: 'accepted' }),
			};
		},

		async inspect(envelope) {
			const admitted = admitContext<ManagedRunRecord>(envelope, 'runs.inspect');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			const run = deps.journal.get(envelope.input.runId);
			if (!run) {
				return {
					ok: true,
					value: refuse(
						'denied',
						context.identity.requestId,
						'not-found',
						`No run ${envelope.input.runId}.`
					),
				};
			}
			return { ok: true, value: ok(context.identity.requestId, journalRunRecord(run)) };
		},

		cancel: (envelope) => control(envelope, 'cancel'),
		interrupt: (envelope) => control(envelope, 'interrupt'),

		async policy(envelope) {
			const admitted = admitContext<ManagedPolicyStatus>(envelope, 'policy.status');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const { context } = admitted;
			if (!deps.policyStatus) {
				return {
					ok: true,
					value: refuse(
						'unsupported',
						context.identity.requestId,
						'capability-unsupported',
						'This host has no managed host adapter, so it projects no policy status.'
					),
				};
			}
			return { ok: true, value: ok(context.identity.requestId, deps.policyStatus()) };
		},

		async events(envelope) {
			const admitted = admitContext<ManagedEventPage>(envelope, 'events.resume');
			if (!admitted.ok) return { ok: true, value: admitted.result };
			const requestId = admitted.context.identity.requestId;
			if (!deps.events) {
				return {
					ok: true,
					value: refuse(
						'unsupported',
						requestId,
						'capability-unsupported',
						'This host keeps no durable event journal (events.resume).'
					),
				};
			}
			const input = envelope.input as Partial<ManagedEventsQuery> | undefined;
			const cursor = input?.cursor ?? null;
			const limit = input?.limit;
			if (typeof cursor !== 'string' && cursor !== null) {
				return {
					ok: true,
					value: refuse(
						'denied',
						requestId,
						'invalid-input',
						'input.cursor is not a cursor or null.'
					),
				};
			}
			if (!Number.isInteger(limit) || (limit as number) < 1) {
				return {
					ok: true,
					value: refuse(
						'denied',
						requestId,
						'invalid-input',
						'input.limit is not a positive integer.'
					),
				};
			}
			return {
				ok: true,
				value: ok(requestId, deps.events.page({ cursor, limit: limit as number })),
			};
		},
	};

	async function control(
		envelope: ManagedOperationEnvelope<{ runId: string }>,
		kind: 'cancel' | 'interrupt'
	): Promise<{ ok: true; value: Result<ManagedControlReceipt> }> {
		const admitted = admitContext<ManagedControlReceipt>(
			envelope,
			kind === 'cancel' ? 'runs.cancel' : 'runs.interrupt'
		);
		if (!admitted.ok) return { ok: true, value: admitted.result };
		const { context } = admitted;
		const requestId = context.identity.requestId;
		const { runId } = envelope.input;
		const asked = await deps.journal.requestCancel(runId, { owner: context.actor, kind });
		if (!asked.run) {
			return { ok: true, value: refuse('denied', requestId, 'not-found', `No run ${runId}.`) };
		}
		if (asked.outcome !== 'requested') {
			return { ok: true, value: ok(requestId, { runId, outcome: asked.outcome }) };
		}
		const held = await deps.turns.cancelRun(runId, kind);
		const outcome = held === 'none' ? 'unknown' : 'requested';
		return { ok: true, value: ok(requestId, { runId, outcome }) };
	}

	return api;
}

/** The context shape a host constructs for its own in-process callers, for tests and the CLI. */
export function inProcessContext(
	input: Omit<ManagedOperationContext, 'contractVersion' | 'origin'> & {
		origin?: ManagedOperationContext['origin'];
	}
): ManagedOperationContext {
	return { contractVersion: MANAGED_CONTRACT_VERSION, origin: 'cli', ...input };
}
