/**
 * The requests a detached host answers: the desktop bridge's typed messages, run against a
 * `MaestroClient`.
 *
 * `createWsMaestroClient` turns each client method into one of these messages; this turns each
 * message back into the method. The two are written against the same table (section 5 of
 * `Plans/maestro-tui-client-api.md`), so a request here is spelled the way that client sends it and
 * a reply carries the keys that client reads (`success`, `error`, the `*_result` type).
 *
 * It takes any `MaestroClient`, never the runtime: the transport adds the request id, the pushes,
 * and the host's own control messages. A message it does not know returns `undefined`, which the
 * transport answers with the bridge's `echo`, the signal a client reads as "unsupported".
 */

import type { AgentRecord } from '../store/records';
import { parseProcessId } from '../client/bridge-frames';
import {
	MANAGED_OPERATION_MESSAGE,
	MANAGED_OPERATION_REPLY,
	isManagedWireOperation,
	type ManagedWireOperation,
	type ManagedWireRefusal,
} from '../client/host-control';
import type {
	AgentPatch,
	ClientResult,
	MaestroClient,
	ManagedApi,
	ManagedScope,
	ProviderInfo,
	TabPatch,
	TurnInput,
	TurnSendReceipt,
} from '../client/types';
import { generateUUID } from '../../uuid';
import { sha256Hex } from '../managed/authority';
import { managedActorPrincipal } from '../managed/host-adapter';
import {
	MANAGED_CAPABILITIES,
	MANAGED_CONTRACT_VERSION,
	managedContextProblems,
	type ManagedCapability,
	type ManagedInstallationIdentity,
	type ManagedOperationContext,
	type ManagedPeerAuthentication,
	type ManagedPrincipalRef,
} from '../managed/types';
import type { MaestroRuntime } from './index';
import { groupChatToWire, type Frame } from './server-frames';

type Request = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
	typeof value === 'boolean' ? value : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** The error text a reply carries. A missing thing says "not found", which is how a client tells it from a failure. */
function errorText(result: Extract<ClientResult<unknown>, { ok: false }>): string {
	const { code, message } = result.error;
	return code === 'not-found' && !/not found/i.test(message) ? `Not found: ${message}` : message;
}

/** A `{ success }` reply for any result, with `extra` merged in on success. */
function outcome<T>(
	type: string,
	result: ClientResult<T>,
	extra: (value: T) => Frame = () => ({})
): Frame {
	return result.ok
		? { type, success: true, ...extra(result.value) }
		: { type, success: false, error: errorText(result) };
}

/**
 * A stated refusal: the request asked for something this host does not do. Nothing was done, and
 * `error` says so in a sentence a person can act on. A request is never answered with success
 * for work that did not happen.
 */
function refusal(type: string, error: string, extra: Frame = {}): Frame {
	return { type, success: false, error, ...extra };
}

// ---------------------------------------------------------------------------
// Wire patches back to the client's patches
// ---------------------------------------------------------------------------

/** The inverse of `buildAgentConfigPatch`: the record-keyed config keys back to an `AgentPatch`. */
export function agentPatchFromConfig(config: Record<string, unknown>): AgentPatch {
	const patch: Record<string, unknown> = {};
	const take = (from: string, to: keyof AgentPatch): void => {
		if (from in config) patch[to] = config[from];
	};
	take('toolType', 'provider');
	take('customModel', 'model');
	take('customEffort', 'effort');
	take('customContextWindow', 'contextWindow');
	take('customPath', 'customPath');
	take('customArgs', 'customArgs');
	take('customEnvVars', 'env');
	take('nudgeMessage', 'nudgeMessage');
	take('newSessionMessage', 'newSessionMessage');
	take('bookmarked', 'bookmarked');
	take('contextWindowSource', 'contextWindowSource');
	take('enableMaestroP', 'enableMaestroP');
	take('maestroPMode', 'maestroPMode');
	take('maestroPPath', 'maestroPPath');
	// Passed as sent: `applyAgentConfigPatch` is what refuses a transport it does not know.
	take('codexTransport', 'codexTransport');
	return patch as AgentPatch;
}

/** The inverse of `buildTabConfigPatch`. */
export function tabPatchFromConfig(config: Record<string, unknown>): TabPatch {
	const patch: Record<string, unknown> = {};
	const take = (from: string, to: keyof TabPatch): void => {
		if (from in config) patch[to] = config[from];
	};
	take('readOnlyMode', 'readOnly');
	take('showThinking', 'thinking');
	take('customModel', 'model');
	take('customEffort', 'effort');
	take('saveToHistory', 'saveToHistory');
	take('enterToSend', 'enterToSend');
	return patch as TabPatch;
}

// ---------------------------------------------------------------------------
// The IPC channels a client invokes (`bridge.invoke`)
// ---------------------------------------------------------------------------

class UnhandledChannel extends Error {
	constructor(channel: string) {
		super(`No ipcMain handler registered for '${channel}'`);
	}
}

function orThrow<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(errorText(result));
	return result.value;
}

/** A desktop process id to the tab it names; the legacy `<agentId>-ai` id means the active tab. */
async function tabOfProcess(
	client: MaestroClient,
	processId: unknown
): Promise<{ agentId: string; tabId: string } | undefined> {
	const target = typeof processId === 'string' ? parseProcessId(processId) : null;
	if (!target) return undefined;
	if (target.kind === 'tab') return { agentId: target.agentId, tabId: target.tabId };
	const agent = await client.agents.get(target.agentId);
	const tabId = agent.ok ? str(agent.value.activeTabId) : undefined;
	return tabId ? { agentId: target.agentId, tabId } : undefined;
}

async function stopTab(client: MaestroClient, processId: unknown): Promise<boolean> {
	const tab = await tabOfProcess(client, processId);
	if (!tab) return false;
	const result = await client.turns.interrupt(tab.agentId, tab.tabId);
	return result.ok && result.value.stopped;
}

function detectionEntry(provider: ProviderInfo): Record<string, unknown> {
	return {
		id: provider.id,
		name: provider.name,
		available: provider.available,
		...(provider.path ? { path: provider.path } : {}),
		...(provider.unavailableReason ? { error: provider.unavailableReason } : {}),
		...(provider.version ? { snapshot: { version: provider.version } } : {}),
	};
}

async function invokeChannel(
	client: MaestroClient,
	channel: string,
	args: unknown[]
): Promise<unknown> {
	switch (channel) {
		case 'sessions:getBootstrap':
			return orThrow(await client.agents.list());
		case 'groups:getAll':
			return orThrow(await client.groups.list());
		case 'sessions:getDeferredContent': {
			const agentId = str(args[0]);
			const tabId = str(args[1]);
			if (!agentId || !tabId) throw new Error('An agent and a tab are required.');
			return { logs: orThrow(await client.tabs.transcript(agentId, tabId)) };
		}
		case 'process:interrupt':
		case 'process:kill':
			return stopTab(client, args[0]);
		case 'settings:get': {
			const key = str(args[0]);
			if (!key) throw new Error('A settings key is required.');
			return orThrow(await client.settings.get([key]))[key];
		}
		// The desktop's Left Bar rename and delete have no bridge message of their own (gap G15), so a
		// client reaches them through the IPC channels the desktop's own UI calls.
		case 'groupChat:rename': {
			const chatId = str(args[0]);
			const name = typeof args[1] === 'string' ? args[1] : '';
			if (!chatId) throw new Error('A chat is required.');
			orThrow(await client.groupChats.rename(chatId, name));
			return { id: chatId, name: name.trim() };
		}
		case 'groupChat:delete': {
			const chatId = str(args[0]);
			if (!chatId) throw new Error('A chat is required.');
			orThrow(await client.groupChats.remove(chatId));
			return true;
		}
		case 'ssh-remote:getConfigs':
			return { success: true, configs: orThrow(await client.settings.sshRemotes()) };
		case 'agents:detect': {
			const sshRemoteId = str(args[0]);
			return orThrow(await client.providers.list(sshRemoteId ? { sshRemoteId } : undefined)).map(
				detectionEntry
			);
		}
		case 'agents:getAllSnapshots':
			// Versions ride the detection entries; there is no persisted snapshot map to read here.
			return {};
		case 'agents:getModels': {
			const providerId = str(args[0]);
			if (!providerId) throw new Error('A provider is required.');
			const sshRemoteId = str(args[2]);
			return orThrow(
				await client.providers.models(providerId, {
					refresh: args[1] === true,
					...(sshRemoteId ? { sshRemoteId } : {}),
				})
			);
		}
		default:
			throw new UnhandledChannel(channel);
	}
}

// ---------------------------------------------------------------------------
// Messages for a tab (`maestro-cli dispatch`)
// ---------------------------------------------------------------------------

type TabTarget =
	| { ok: true; tabId: string }
	| { ok: false; error: string; reason?: 'session-not-found' | 'tab-not-found' | 'no-ai-tabs' };

/**
 * The tab a message is for: the one it names, else the agent's active tab, as the desktop
 * resolves it. The error text is the desktop's, which `dispatch` maps to its error codes.
 */
async function resolveTargetTab(
	client: MaestroClient,
	agentId: string,
	requested: string | undefined
): Promise<TabTarget> {
	const agent = await client.agents.get(agentId);
	if (!agent.ok) {
		return agent.error.code === 'not-found'
			? { ok: false, error: 'Session not found', reason: 'session-not-found' }
			: { ok: false, error: errorText(agent) };
	}
	if (requested) return { ok: true, tabId: requested };
	const active = str(agent.value.activeTabId);
	if (active) return { ok: true, tabId: active };
	const tabs = await client.tabs.list(agentId);
	const first = tabs.ok ? tabs.value[0]?.id : undefined;
	return first
		? { ok: true, tabId: first }
		: { ok: false, error: 'The agent has no AI tab to send to.', reason: 'no-ai-tabs' };
}

/**
 * What a dispatch message asks for that a host without a window cannot do, or undefined. Checked
 * before anything is sent, so a refusal never leaves a message behind.
 */
function unsupportedDispatch(message: Request): string | undefined {
	if (message.inputMode === 'terminal') {
		return 'A headless host has no terminal to run a command in. Only AI messages can be sent to it.';
	}
	if (str(message.notifyOnComplete)) {
		return 'A headless host cannot arm a completion callback (--notify-on-complete). Nothing was sent; dispatch without it and poll the tab, or use the desktop app.';
	}
	return undefined;
}

/** A dispatch message's images, when it carries any. */
function imagesOf(message: Request): string[] | undefined {
	const images = Array.isArray(message.images)
		? message.images.filter((image): image is string => typeof image === 'string')
		: [];
	return images.length > 0 ? images : undefined;
}

/** The reply fields that say whether the message is running or waiting its turn. */
function receiptFields(receipt: TurnSendReceipt): Frame {
	return receipt.status === 'queued'
		? {
				queued: true,
				itemId: receipt.itemId,
				queuePosition: receipt.position,
				queueLength: receipt.queueLength,
			}
		: { queued: false };
}

/** A failed send as the desktop words it: a tab that is not there is `Tab not found`. */
function sendFailure(
	type: string,
	agentId: string,
	tabId: string,
	failed: Extract<StandingSend, { ok: false }>
): Frame {
	return failed.notFound
		? refusal(type, `Tab not found: ${tabId}`, { sessionId: agentId, reason: 'tab-not-found' })
		: refusal(type, failed.error, { sessionId: agentId });
}

// ---------------------------------------------------------------------------
// Managed operations over the bridge (`managed_operation`, MRC-08-05)
// ---------------------------------------------------------------------------

/**
 * The scope a caller over the bridge is admitted in, read from the host's own standing. The host's
 * per-boot secret admits the transport and grants no role: the caller acts as the principal the
 * host's custody names, carries no delegation, and submits on the current policy generation only.
 */
export interface ManagedRequestScope {
	installation: ManagedInstallationIdentity;
	actor(): ManagedPrincipalRef;
	policyRevision(): number | null;
	binding(): ManagedScope['binding'];
}

/** The scope of a runtime, from the host adapter's custody first and the enrollment record next. */
export function runtimeManagedScope(
	runtime: Pick<MaestroRuntime, 'installation' | 'managedHost' | 'managedBinding'>
): ManagedRequestScope {
	const { installation, managedHost, managedBinding } = runtime;
	return {
		installation,
		actor: () => managedActorPrincipal(managedHost?.identity.read() ?? null, installation),
		policyRevision: () => {
			if (managedHost) return managedHost.policy().policyRevision;
			const state = managedBinding.state();
			return state.state === 'enrolled' ? state.record.policyRevision : null;
		},
		binding: () => managedBinding.state().state,
	};
}

/**
 * The transport this handler answers over: `startRuntimeServer` admits a caller on the host's
 * per-boot secret, so the handler stamps `host-secret` on the envelope it hands the facade, after
 * the scope has admitted the context (MRC-08-05A). The facade then verifies the context with the
 * verifier of that transport, and its verification record names it. A caller never stamps it.
 */
const BRIDGE_PEER: ManagedPeerAuthentication = 'host-secret';

/** The operations with an effect: admitted on the host's current policy generation only. */
const EFFECT_OPS: ReadonlySet<ManagedWireOperation> = new Set(['submit', 'cancel', 'interrupt']);
const MANAGED_WIRE_OPERATIONS_TEXT =
	'scope, negotiate, identity, agents, runs, submit, inspect, cancel, interrupt, events and policy';

type ScopeRefusal = { code: 'unauthenticated' | 'context-mismatch'; message: string };
const mismatch = (message: string): ScopeRefusal => ({ code: 'context-mismatch', message });
const unauthenticated = (message: string): ScopeRefusal => ({ code: 'unauthenticated', message });

/** Whether a well-formed context fits the transport's scope. Refused by name, never rewritten. */
export function managedScopeRefusal(
	context: ManagedOperationContext,
	scope: ManagedRequestScope,
	operation: ManagedWireOperation
): ScopeRefusal | undefined {
	const here = scope.installation;
	const named = context.installation;
	if (
		named.installationId !== here.installationId ||
		named.runtimeId !== here.runtimeId ||
		named.processEpoch !== here.processEpoch
	) {
		return mismatch(
			`The context names installation ${named.installationId} (runtime ${named.runtimeId}, epoch ${named.processEpoch}); this host is ${here.installationId} (runtime ${here.runtimeId}, epoch ${here.processEpoch}). Read scope and send again.`
		);
	}
	const actor = scope.actor();
	if (context.actor.kind !== actor.kind || context.actor.id !== actor.id) {
		return unauthenticated(
			`A caller over this transport acts as ${actor.kind} ${actor.id}, the host's own principal; the context names ${context.actor.kind} ${context.actor.id}.`
		);
	}
	if (context.delegation.chain.length > 0 || context.delegation.grantRef !== null) {
		return unauthenticated(
			'A caller over this transport carries no delegation this host can verify; the context names a chain or a grant reference.'
		);
	}
	const current = scope.policyRevision();
	if (EFFECT_OPS.has(operation) && context.policyRevision !== current) {
		return mismatch(
			`The context names policy revision ${String(context.policyRevision)}; this host applies ${String(current)}. Read scope and send again.`
		);
	}
	return undefined;
}

const isCapabilityList = (value: unknown): value is ManagedCapability[] =>
	Array.isArray(value) &&
	value.every((entry) => (MANAGED_CAPABILITIES as readonly unknown[]).includes(entry));
const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === 'string');
const isCursor = (value: unknown): value is string | null =>
	value === null || (typeof value === 'string' && value !== '');
const isLimit = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value > 0;
const isNullableString = (value: unknown): value is string | null =>
	value === null || typeof value === 'string';

type ShapedInput = { ok: true; input: unknown } | { ok: false; problem: string };

/** The closed input shape of each operation: the facade is handed what its signature says, nothing more. */
function shapeManagedInput(operation: ManagedWireOperation, raw: unknown): ShapedInput {
	const input = obj(raw) ?? (raw === undefined ? {} : undefined);
	if (!input) return { ok: false, problem: 'input is not an object' };
	const page = (): ShapedInput =>
		isCursor(input.cursor) && isLimit(input.limit)
			? { ok: true, input: { cursor: input.cursor, limit: input.limit } }
			: { ok: false, problem: 'input needs cursor (string or null) and limit (positive integer)' };
	const run = (): ShapedInput =>
		str(input.runId)
			? { ok: true, input: { runId: input.runId } }
			: { ok: false, problem: 'input.runId is not an id' };
	switch (operation) {
		case 'identity':
		case 'policy':
			return { ok: true, input: {} };
		case 'agents':
		case 'events':
			return page();
		case 'runs': {
			const paged = page();
			if (!paged.ok) return paged;
			if (input.agentId === undefined) return paged;
			if (!str(input.agentId)) return { ok: false, problem: 'input.agentId is not an id' };
			return { ok: true, input: { ...(paged.input as object), agentId: input.agentId } };
		}
		case 'inspect':
		case 'cancel':
		case 'interrupt':
			return run();
		case 'submit': {
			const content = obj(input.content);
			if (
				!str(input.agentId) ||
				!isNullableString(input.tabId) ||
				!str(input.providerId) ||
				!isNullableString(input.modelId) ||
				!content ||
				typeof content.text !== 'string' ||
				!str(content.sha256) ||
				!isStringList(input.resourceIds)
			) {
				return {
					ok: false,
					problem:
						'input needs agentId, tabId (string or null), providerId, modelId (string or null), content { text, sha256 } and resourceIds (strings)',
				};
			}
			return {
				ok: true,
				input: {
					agentId: input.agentId,
					tabId: input.tabId,
					providerId: input.providerId,
					modelId: input.modelId,
					content: { text: content.text, sha256: content.sha256 },
					resourceIds: [...input.resourceIds],
				},
			};
		}
		case 'scope':
		case 'negotiate':
			return { ok: true, input: {} };
	}
}

const managedRefusal = (
	reason: ManagedWireRefusal,
	error: string,
	operation?: ManagedWireOperation
): Frame =>
	refusal(MANAGED_OPERATION_REPLY, error, { reason, ...(operation ? { operation } : {}) });

/** What the facade's own transport gate said, as a wire reason the client maps back. */
function facadeRefusal(
	operation: ManagedWireOperation,
	result: Extract<ClientResult<unknown>, { ok: false }>
): Frame {
	const code = result.error.code;
	const reason: ManagedWireRefusal =
		code === 'host-lost' || code === 'host-unavailable' || code === 'unsupported' ? code : 'failed';
	return managedRefusal(reason, errorText(result), operation);
}

/**
 * Answer one managed operation, in a fixed order: the operation is on the list, the host has a
 * facade and a scope, the envelope names no transport of its own, the context is well formed and
 * fits the scope, the input has the shape, and only then does the facade see it, stamped with the
 * transport this handler admits over (and verifies the context again, with that transport's
 * verifier). A refusal names its step.
 */
async function answerManaged(
	managed: ManagedApi | undefined,
	scope: ManagedRequestScope | undefined,
	message: Request
): Promise<Frame> {
	const type = MANAGED_OPERATION_REPLY;
	const operation = message.operation;
	if (!isManagedWireOperation(operation)) {
		return managedRefusal(
			'unsupported',
			`Unknown managed operation ${JSON.stringify(operation ?? null)}; this host answers ${MANAGED_WIRE_OPERATIONS_TEXT}.`
		);
	}
	if (!managed || !scope) {
		return managedRefusal(
			'unsupported',
			'This host exposes no managed operations over the bridge: it has no managed facade or no scope to admit a caller in.',
			operation
		);
	}
	if (operation === 'scope') {
		const { installation } = scope;
		const view: ManagedScope = {
			installation,
			actor: scope.actor(),
			policyRevision: scope.policyRevision(),
			binding: scope.binding(),
		};
		return { type, success: true, operation, result: view };
	}
	if (operation === 'negotiate') {
		const offer = obj(message.offer);
		if (
			!offer ||
			!isStringList(offer.supportedVersions) ||
			!isCapabilityList(offer.required) ||
			(offer.optional !== undefined && !isCapabilityList(offer.optional))
		) {
			return managedRefusal(
				'invalid-input',
				'offer needs supportedVersions (strings), required (capabilities) and, if present, optional (capabilities).',
				operation
			);
		}
		const result = await managed.negotiate({
			supportedVersions: offer.supportedVersions,
			required: offer.required,
			...(offer.optional ? { optional: offer.optional } : {}),
		});
		return result.ok
			? { type, success: true, operation, result: result.value }
			: facadeRefusal(operation, result);
	}
	const envelope = obj(message.envelope);
	if (!envelope) return managedRefusal('invalid-input', 'envelope is not an object', operation);
	if (envelope.peer !== undefined) {
		return managedRefusal(
			'invalid-input',
			'envelope.peer is stamped by this host once it has admitted the caller; a caller does not name the transport it arrived over.',
			operation
		);
	}
	const problems = managedContextProblems(envelope.context);
	if (problems.length > 0) {
		return managedRefusal('invalid-input', `envelope.context: ${problems.join('; ')}`, operation);
	}
	const context = structuredClone(envelope.context as ManagedOperationContext);
	const refused = managedScopeRefusal(context, scope, operation);
	if (refused) return managedRefusal(refused.code, refused.message, operation);
	const shaped = shapeManagedInput(operation, envelope.input);
	if (!shaped.ok) {
		return managedRefusal('invalid-input', `envelope.${shaped.problem}`, operation);
	}
	const result = await managed[operation]({
		context,
		input: shaped.input as never,
		peer: BRIDGE_PEER,
	});
	return result.ok
		? { type, success: true, operation, result: result.value }
		: facadeRefusal(operation, result);
}

// ---------------------------------------------------------------------------
// A plain send on the host's standing (MCOMP-09-02)
// ---------------------------------------------------------------------------

/** How a dispatch verb's send ended: the reply fields, or the refusal and whether it was "not found". */
type StandingSend = { ok: true; fields: Frame } | { ok: false; error: string; notFound: boolean };

/**
 * Place one of the dispatch verbs' sends on this host's standing. A scope that reads `standalone`,
 * or no scope at all (an embedding without `startRuntimeServer`, which holds no standing to read),
 * sends through `turns.send` as it always has, and the turn service behind the client keeps its own
 * rule. Any other standing (enrolled, enrolled with nothing answering, an unreadable record) makes
 * the send a managed submission bound to the host before anything is queued: a context naming this
 * installation, the principal the host's custody names, no delegation, a fresh request and the
 * policy generation of this moment, stamped with the transport this handler admits over and
 * handed to the facade's `submit`, so the run journal records what arrived over the bridge and the
 * reply names the run. A host whose client has no facade refuses the send; a send the facade did
 * not admit is refused with its code. Neither falls back to a plain send.
 */
async function sendOnStanding(
	client: MaestroClient,
	scope: ManagedRequestScope | undefined,
	agentId: string,
	tabId: string,
	input: TurnInput
): Promise<StandingSend> {
	const binding = scope?.binding();
	if (!scope || binding === 'standalone') {
		const result = await client.turns.send(agentId, tabId, input);
		return result.ok
			? { ok: true, fields: receiptFields(result.value) }
			: { ok: false, error: errorText(result), notFound: result.error.code === 'not-found' };
	}
	if (input.images?.length) {
		return {
			ok: false,
			error:
				'Images cannot be sent to an enrolled host from here. Send the message without them, or use the desktop.',
			notFound: false,
		};
	}
	if (!client.managed) {
		return {
			ok: false,
			error: `This installation is enrolled (binding: ${binding}) and this host exposes no managed facade to admit the message, so nothing was sent.`,
			notFound: false,
		};
	}
	const agent = await client.agents.get(agentId);
	if (!agent.ok) {
		return { ok: false, error: errorText(agent), notFound: agent.error.code === 'not-found' };
	}
	const requestId = generateUUID();
	const context: ManagedOperationContext = {
		contractVersion: MANAGED_CONTRACT_VERSION,
		installation: scope.installation,
		origin: 'cli',
		actor: scope.actor(),
		delegation: { chain: [], grantRef: null },
		identity: {
			requestId,
			// A bridge send is never a replay of an earlier one: each is its own submission.
			idempotencyKey: generateUUID(),
			attemptId: generateUUID(),
			runId: null,
			rootRunId: null,
			parentRunId: null,
		},
		policyRevision: scope.policyRevision(),
		workflow: null,
		traceId: `bridge:${requestId}`,
		requestedCapabilities: ['runs.submit'],
	};
	const text = input.text ?? '';
	const result = await client.managed.submit({
		context,
		input: {
			agentId,
			tabId,
			providerId: agent.value.toolType,
			modelId: null,
			content: { text, sha256: sha256Hex(text) },
			resourceIds: [],
		},
		peer: BRIDGE_PEER,
	});
	if (!result.ok) return { ok: false, error: errorText(result), notFound: false };
	const answer = result.value;
	if (answer.status !== 'ok') {
		return {
			ok: false,
			error: `[${answer.code}] The host did not admit the message (${answer.status}): ${answer.message ?? 'no reason given'}`,
			notFound: answer.code === 'not-found',
		};
	}
	const { run } = answer.value;
	return {
		ok: true,
		fields: { queued: run.state === 'queued', runId: run.runId },
	};
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** `get_sessions`' projection: what `reconcile` reads (`SessionData`, no config fields). */
async function projectSessions(client: MaestroClient): Promise<Frame[]> {
	const agents = await client.agents.list();
	if (!agents.ok) return [];
	return Promise.all(
		agents.value.map(async (agent: AgentRecord) => {
			const tabs = await client.tabs.list(agent.id);
			return {
				id: agent.id,
				name: agent.name,
				toolType: agent.toolType,
				...(agent.state ? { state: agent.state } : {}),
				...(typeof agent.inputMode === 'string' ? { inputMode: agent.inputMode } : {}),
				...(agent.cwd ? { cwd: agent.cwd } : {}),
				groupId: agent.groupId ?? null,
				...(agent.bookmarked !== undefined ? { bookmarked: agent.bookmarked } : {}),
				...(typeof agent.activeTabId === 'string' ? { activeTabId: agent.activeTabId } : {}),
				aiTabs: (tabs.ok ? tabs.value : []).map((tab) => ({
					id: tab.id,
					agentSessionId: tab.agentSessionId ?? null,
					name: tab.name ?? null,
					...(tab.starred !== undefined ? { starred: tab.starred } : {}),
					...(tab.state ? { state: tab.state } : {}),
					...(tab.hasUnread !== undefined ? { hasUnread: tab.hasUnread } : {}),
					...(tab.usageStats !== undefined ? { usageStats: tab.usageStats } : {}),
					...(tab.createdAt !== undefined ? { createdAt: tab.createdAt } : {}),
				})),
			};
		})
	);
}

export type RequestHandler = (message: Request) => Promise<Frame | undefined>;

export interface RequestHandlerOptions {
	/**
	 * The scope managed requests are admitted in (`runtimeManagedScope(runtime)` for a host), and
	 * the standing the dispatch verbs' sends are placed on (MCOMP-09-02): a scope that is not
	 * standalone makes every plain send a managed submission bound to the host. Absent:
	 * `managed_operation` is refused `unsupported`, whatever facade the client has, and a send
	 * reaches `turns.send` with the standing the turn service holds on its own.
	 */
	managedScope?: ManagedRequestScope;
}

/** Answer the desktop bridge's typed messages with `client`. */
export function createRequestHandler(
	client: MaestroClient,
	options: RequestHandlerOptions = {}
): RequestHandler {
	const sessionId = (message: Request): string => str(message.sessionId) ?? '';

	return async (message) => {
		switch (message.type) {
			case 'ping':
				return { type: 'pong' };

			// -- managed operations (MRC-08-05) -----------------------------
			case MANAGED_OPERATION_MESSAGE:
				return answerManaged(client.managed, options.managedScope, message);

			case 'get_sessions':
				return { type: 'sessions_list', sessions: await projectSessions(client) };

			case 'bridge.invoke': {
				const channel = str(message.channel) ?? '';
				const args = Array.isArray(message.args) ? message.args : [];
				try {
					return {
						type: 'bridge.response',
						ok: true,
						result: await invokeChannel(client, channel, args),
					};
				} catch (error) {
					return {
						type: 'bridge.response',
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}

			// -- agents -----------------------------------------------------
			case 'create_session': {
				const result = await client.agents.create({
					name: str(message.name) ?? '',
					provider: str(message.toolType) ?? '',
					cwd: str(message.cwd) ?? '',
					...(str(message.groupId) ? { groupId: str(message.groupId) } : {}),
					...(str(message.customModel) ? { model: str(message.customModel) } : {}),
					...(str(message.customEffort) ? { effort: str(message.customEffort) } : {}),
					...(num(message.customContextWindow) !== undefined
						? { contextWindow: num(message.customContextWindow) }
						: {}),
					...(str(message.customPath) ? { customPath: str(message.customPath) } : {}),
					...(str(message.customArgs) ? { customArgs: str(message.customArgs) } : {}),
					...(obj(message.customEnvVars)
						? { env: obj(message.customEnvVars) as Record<string, string> }
						: {}),
					...(obj(message.sessionSshRemoteConfig)
						? { ssh: obj(message.sessionSshRemoteConfig) as never }
						: {}),
					...(str(message.autoRunFolderPath)
						? { autoRunFolderPath: str(message.autoRunFolderPath) }
						: {}),
					...(str(message.nudgeMessage) ? { nudgeMessage: str(message.nudgeMessage) } : {}),
					...(str(message.newSessionMessage)
						? { newSessionMessage: str(message.newSessionMessage) }
						: {}),
				});
				return outcome('create_session_result', result, (value) => ({ sessionId: value.agentId }));
			}
			case 'rename_session':
				return outcome(
					'rename_session_result',
					await client.agents.rename(sessionId(message), str(message.newName) ?? '')
				);
			case 'delete_session':
				return outcome('delete_session_result', await client.agents.remove(sessionId(message)));
			case 'update_session_cwd':
				return outcome(
					'update_session_cwd_result',
					await client.agents.update(sessionId(message), { cwd: str(message.newCwd) ?? '' })
				);
			case 'update_session_ssh':
				return outcome(
					'update_session_ssh_result',
					await client.agents.update(sessionId(message), {
						ssh: (obj(message.sshPatch) ?? {}) as never,
					})
				);
			case 'update_session_config': {
				const config = obj(message.configPatch) ?? {};
				if ('migrationAction' in config) {
					return refusal(
						'update_session_config_result',
						'Provider translation requires the desktop app; the headless host cannot migrate native conversations.'
					);
				}
				const tabId = str(config.tabId);
				if (tabId) {
					const { tabId: _tab, ...rest } = config;
					return outcome(
						'update_session_config_result',
						await client.tabs.update(sessionId(message), tabId, tabPatchFromConfig(rest))
					);
				}
				const patch = agentPatchFromConfig(config);
				// Nothing in the patch is a field a client may write: say so, as the desktop does,
				// rather than answer success for an update that changed nothing.
				if (Object.keys(patch).length === 0) {
					return refusal('update_session_config_result', 'No editable config fields in patch');
				}
				return outcome(
					'update_session_config_result',
					await client.agents.update(sessionId(message), patch),
					(receipt) => (receipt.notices ? { notices: receipt.notices } : {})
				);
			}
			case 'set_auto_run_folder':
				return outcome(
					'set_auto_run_folder_result',
					await client.agents.update(sessionId(message), {
						autoRunFolderPath: str(message.folderPath) ?? '',
					})
				);
			case 'move_session_to_group':
				return outcome(
					'move_session_to_group_result',
					await client.groups.moveAgent(sessionId(message), str(message.groupId) ?? null)
				);

			// -- groups -----------------------------------------------------
			case 'create_group':
				return outcome(
					'create_group_result',
					await client.groups.create({
						name: str(message.name) ?? '',
						...(str(message.emoji) ? { emoji: str(message.emoji) } : {}),
						...(str(message.parentGroupId) ? { parentGroupId: str(message.parentGroupId) } : {}),
					}),
					(value) => ({ groupId: value.groupId })
				);
			case 'rename_group':
				return outcome(
					'rename_group_result',
					await client.groups.rename(str(message.groupId) ?? '', str(message.name) ?? '')
				);
			case 'delete_group':
				return outcome(
					'delete_group_result',
					await client.groups.remove(str(message.groupId) ?? '')
				);

			// -- tabs -------------------------------------------------------
			case 'new_tab':
				return outcome('new_tab_result', await client.tabs.create(sessionId(message)), (value) => ({
					tabId: value.tabId,
				}));
			case 'rename_tab':
				return outcome(
					'rename_tab_result',
					await client.tabs.rename(
						sessionId(message),
						str(message.tabId) ?? '',
						typeof message.newName === 'string' ? message.newName : ''
					)
				);
			case 'close_tab':
				return outcome(
					'close_tab_result',
					await client.tabs.close(sessionId(message), str(message.tabId) ?? '')
				);
			case 'star_tab':
				return outcome(
					'star_tab_result',
					await client.tabs.star(
						sessionId(message),
						str(message.tabId) ?? '',
						bool(message.starred) ?? false
					)
				);

			// -- turns ------------------------------------------------------
			// The three ways `maestro-cli dispatch` hands over a prompt. Each replies with the type
			// and fields the desktop replies with, so the CLI prints what it prints for a desktop.
			case 'enqueue_command': {
				const type = 'enqueue_command_result';
				const agentId = sessionId(message);
				const unsupported = unsupportedDispatch(message);
				if (unsupported) return refusal(type, unsupported, { sessionId: agentId });
				// The queue here starts a waiting message as soon as its turn comes; it has no state
				// that keeps one back until a person releases it.
				if (message.held === true) {
					return refusal(
						type,
						'A headless host cannot queue a held message (--held): its queue would run the message as soon as the agent is free. Nothing was queued.',
						{ sessionId: agentId }
					);
				}
				const target = await resolveTargetTab(client, agentId, str(message.tabId));
				if (!target.ok) {
					return refusal(type, target.error, {
						sessionId: agentId,
						...(target.reason ? { reason: target.reason } : {}),
					});
				}
				const images = imagesOf(message);
				const sent = await sendOnStanding(client, options.managedScope, agentId, target.tabId, {
					text: typeof message.command === 'string' ? message.command : '',
					...(images ? { images } : {}),
				});
				if (!sent.ok) return sendFailure(type, agentId, target.tabId, sent);
				return {
					type,
					success: true,
					sessionId: agentId,
					tabId: target.tabId,
					...sent.fields,
				};
			}
			case 'send_command': {
				const type = 'command_result';
				const agentId = sessionId(message);
				const unsupported = unsupportedDispatch(message);
				if (unsupported) return refusal(type, unsupported, { sessionId: agentId });
				const target = await resolveTargetTab(client, agentId, str(message.tabId));
				if (!target.ok) return refusal(type, target.error, { sessionId: agentId });
				const images = imagesOf(message);
				// A busy agent queues the message where the desktop turns it away, so `force` has
				// nothing to override: the message is accepted either way, and `queued` says which.
				const sent = await sendOnStanding(client, options.managedScope, agentId, target.tabId, {
					text: typeof message.command === 'string' ? message.command : '',
					...(images ? { images } : {}),
				});
				if (!sent.ok) return sendFailure(type, agentId, target.tabId, sent);
				return {
					type,
					success: true,
					sessionId: agentId,
					tabId: target.tabId,
					...sent.fields,
				};
			}
			case 'new_ai_tab_with_prompt': {
				const type = 'new_ai_tab_with_prompt_result';
				const agentId = sessionId(message);
				const prompt = typeof message.prompt === 'string' ? message.prompt : '';
				// Every refusal that does not need the tab comes before the tab exists.
				if (!agentId || !prompt.trim()) {
					return refusal(type, 'Missing sessionId or prompt', { sessionId: agentId });
				}
				const unsupported = unsupportedDispatch(message);
				if (unsupported) return refusal(type, unsupported, { sessionId: agentId });
				const created = await client.tabs.create(agentId);
				if (!created.ok) {
					return refusal(
						type,
						created.error.code === 'not-found' ? 'Session not found' : errorText(created),
						{ sessionId: agentId }
					);
				}
				const { tabId } = created.value;
				const sent = await sendOnStanding(client, options.managedScope, agentId, tabId, {
					text: prompt,
				});
				// The tab exists by now, so a prompt that could not start is reported with it.
				if (!sent.ok) return refusal(type, sent.error, { sessionId: agentId, tabId });
				return {
					type,
					success: true,
					sessionId: agentId,
					tabId,
					...(sent.fields.queued === true ? { queued: true } : {}),
					...(typeof sent.fields.runId === 'string' ? { runId: sent.fields.runId } : {}),
				};
			}
			case 'list_queue': {
				const agentId = sessionId(message);
				const result = await client.turns.queue.list(agentId);
				return outcome('list_queue_result', result, (items) => ({
					queues: [
						{
							sessionId: agentId,
							items: items.map((item) => ({
								id: item.itemId,
								timestamp: item.queuedAt,
								tabId: item.tabId,
								type: item.kind,
								text: item.text,
								paused: item.paused,
							})),
						},
					],
				}));
			}
			case 'remove_queue_item':
				return outcome(
					'remove_queue_item_result',
					await client.turns.queue.remove(sessionId(message), str(message.itemId) ?? ''),
					(value) => ({ removed: value.removed })
				);

			// -- Auto Run ---------------------------------------------------
			case 'configure_auto_run': {
				const type = 'configure_auto_run_result';
				// On the desktop this message can fill the Auto Run panel, save a playbook, or
				// launch, in a worktree or not. A host has only the launch, and says so for the
				// rest before anything starts.
				if (message.saveAsPlaybook !== undefined && message.saveAsPlaybook !== null) {
					return refusal(
						type,
						'A headless host cannot save a playbook (--save-as): playbooks are saved by the desktop app. Nothing was saved or launched.'
					);
				}
				if (obj(message.worktree) && obj(message.worktree)?.enabled !== false) {
					return refusal(
						type,
						'A headless host cannot run Auto Run in a worktree (--worktree): the desktop app creates the worktree and its branch. Nothing was launched.'
					);
				}
				if (message.launch !== true) {
					return refusal(
						type,
						'A headless host has no Auto Run panel to configure. Pass --launch to start the run.'
					);
				}
				const documents = Array.isArray(message.documents) ? message.documents : [];
				return outcome(
					type,
					await client.autoRun.launch(sessionId(message), {
						documents: documents.flatMap((entry) => {
							const document = obj(entry);
							const file = str(document?.filename);
							return file
								? [
										{
											file,
											...(document?.resetOnCompletion === true ? { resetOnCompletion: true } : {}),
										},
									]
								: [];
						}),
						...(message.loopEnabled === true ? { loop: true } : {}),
						...(num(message.maxLoops) !== undefined ? { maxLoops: num(message.maxLoops) } : {}),
						...(str(message.prompt) ? { prompt: str(message.prompt) } : {}),
						...(str(message.model) ? { model: str(message.model) } : {}),
						...(str(message.effort) ? { effort: str(message.effort) } : {}),
						...(message.ignoreModelHints === true ? { ignoreModelHints: true } : {}),
					})
				);
			}
			case 'launch_goal_run': {
				const result = await client.autoRun.launchGoal(sessionId(message), {
					goal: typeof message.goal === 'string' ? message.goal : '',
					...(str(message.exitCriteria) ? { exitCriteria: str(message.exitCriteria) } : {}),
					...(message.maxIterations === null || num(message.maxIterations) !== undefined
						? { maxIterations: message.maxIterations as number | null }
						: {}),
					...(str(message.model) ? { model: str(message.model) } : {}),
					...(str(message.effort) ? { effort: str(message.effort) } : {}),
				});
				return outcome('launch_goal_run_result', result, (value) =>
					value.tabId ? { tabId: value.tabId } : {}
				);
			}
			case 'stop_auto_run':
				return outcome('stop_auto_run_result', await client.autoRun.stop(sessionId(message)));
			case 'resume_auto_run_error':
				return outcome(
					'resume_auto_run_error_result',
					await client.autoRun.resume(sessionId(message))
				);
			case 'skip_auto_run_document':
				return outcome(
					'skip_auto_run_document_result',
					await client.autoRun.skip(sessionId(message))
				);
			case 'abort_auto_run_error':
				return outcome(
					'abort_auto_run_error_result',
					await client.autoRun.abort(sessionId(message))
				);

			// -- group chats ------------------------------------------------
			case 'get_group_chats': {
				const chats = await client.groupChats.list();
				return {
					type: 'group_chats_list',
					chats: chats.ok ? chats.value.map(groupChatToWire) : [],
				};
			}
			case 'get_group_chat_state': {
				const chat = await client.groupChats.get(str(message.chatId) ?? '');
				return { type: 'group_chat_state', state: chat.ok ? groupChatToWire(chat.value) : null };
			}
			case 'start_group_chat': {
				const participantIds = Array.isArray(message.participantIds)
					? message.participantIds.filter((id): id is string => typeof id === 'string')
					: [];
				const result = await client.groupChats.create({
					name: typeof message.topic === 'string' ? message.topic : '',
					participantIds,
					// The wire names the moderator by PROVIDER: the host moderates with a provider, not an agent.
					...(str(message.moderatorAgentId)
						? { moderatorProvider: str(message.moderatorAgentId) }
						: {}),
					...(str(message.message) ? { message: str(message.message) } : {}),
				});
				return outcome('start_group_chat_result', result, (value) => ({ chatId: value.chatId }));
			}
			case 'send_group_chat_message':
				return outcome(
					'send_group_chat_message_result',
					await client.groupChats.send(
						str(message.chatId) ?? '',
						typeof message.message === 'string' ? message.message : ''
					)
				);
			case 'stop_group_chat':
				return outcome(
					'stop_group_chat_result',
					await client.groupChats.stop(str(message.chatId) ?? '')
				);

			// -- consults ----------------------------------------------------
			// Waits as long as the answer takes: the caller's own timeout bounds it, not a delivery receipt.
			case 'cross_agent_ask': {
				const result = await client.consults.ask({
					targetAgentId: sessionId(message),
					question: typeof message.question === 'string' ? message.question : '',
					...(str(message.fromSessionId) ? { fromAgentId: str(message.fromSessionId) } : {}),
					...(str(message.fromTabId) ? { fromTabId: str(message.fromTabId) } : {}),
					withContext: message.withContext === true,
					...(num(message.timeoutMs) !== undefined ? { timeoutMs: num(message.timeoutMs) } : {}),
					...(typeof message.handoffAnswer === 'string'
						? { handoffAnswer: message.handoffAnswer }
						: {}),
				});
				if (result.ok) {
					return {
						type: 'cross_agent_ask_result',
						success: true,
						answer: result.value.answer,
						...(result.value.agentName ? { targetAgentName: result.value.agentName } : {}),
					};
				}
				// A consult the caller's Stop ended is not the target failing to answer.
				const stopped =
					result.error.code === 'rejected' && /was stopped/i.test(result.error.message);
				return {
					type: 'cross_agent_ask_result',
					success: false,
					error: errorText(result),
					...(stopped ? { canceled: true } : {}),
				};
			}

			default:
				return undefined;
		}
	};
}
