/**
 * The desktop's enterprise service: the one composition of identity custody,
 * endpoint client, enrollment lifecycle, policy status and host adapter that
 * the IPC handlers reach and that later phases extend (events, inbox and
 * commands in phase 11).
 *
 * It is built once at app start, before the IPC handlers are registered, so
 * that every verb finds it; it does nothing on its own until asked, except
 * `start()`, which re-attaches a previously enrolled installation so the
 * status pane shows the endpoint's answer instead of a stale record. A
 * start that fails (no endpoint listening, custody refused) leaves the
 * service in place with its refusal visible in `status()`; nothing here
 * forgets an enrollment because the endpoint was away at boot.
 *
 * The desktop binds Electron here and nowhere else in `src/main/enterprise/`:
 * `safeStorage` arrives as a `SafeStorageLike`, the keyring anchor as an
 * `AnchorStore`, so the service itself is plain Node and `maestro-cli host`
 * can compose the same modules with its own custody.
 *
 * The adapter's `authority` is the desktop's managed authority, and
 * `dispatch` is the broker dispatch bridge over it (`dispatch.ts`): the
 * `ManagedTurnAuthority` a sink admits with, plus the durable ledger that
 * joins each broker decision to the local lease and its effect. The desktop
 * spawn sinks that admit with it are wired from phase 06 onward; until then
 * it is reachable here, exercised by the harness route and the tests, and
 * answers `unavailable` to anything that asks before a registered, attached,
 * managed standing exists.
 */

import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';
import { generateUUID } from '../../shared/uuid';
import {
	createEventJournal,
	MANAGED_EVENT_JOURNAL_FILE_NAME,
	type EventJournal,
	type EventJournalLoad,
} from '../../shared/maestro-lib/managed/event-journal';
import type {
	EndpointComponent,
	EndpointPort,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { ManagedEffectProducer } from '../../shared/maestro-lib/managed/effects';
import {
	createLifecycleProjector,
	type LifecycleEventSink,
	type LifecycleProjector,
} from '../../shared/maestro-lib/managed/events';
import {
	createManagedHostAdapter,
	installationIdentity,
	managedActorPrincipal,
	managedAuthorityId,
	type ManagedHostAdapter,
} from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedInstallationIdentity } from '../../shared/maestro-lib/managed/types';
import {
	createWorkflowOwnership,
	endpointWorkflowOwnerPort,
	workflowFenceOf,
	MANAGED_WORKFLOWS_FILE_NAME,
	type WorkflowFenceAnswer,
	type WorkflowIdentityLike,
	type WorkflowOwnership,
} from '../../shared/maestro-lib/managed/workflows';
import type { AnchorStore } from '../utils/keyring-anchor';
import { safeStorageSeal, type SafeStorageLike } from '../utils/safe-storage-seal';
import {
	MANAGED_COMMAND_LEDGER_FILE_NAME,
	type CommandExecution,
} from '../../shared/maestro-lib/managed/commands';
import type { EndpointInboxAction } from '../../shared/maestro-lib/managed/host-adapter';
import {
	createCommandService,
	type CommandService,
	type CommandServiceStatus,
	type LocalCommandAction,
} from './commands';
import {
	createBrokerDispatch,
	DISPATCH_RECEIPTS_FILE_NAME,
	managedRunViewOfReceipt,
	type BrokerDispatch,
	type ManagedRunView,
} from './dispatch';
import {
	createInboxClient,
	createInboxReceiptLedger,
	inboxActionProblem,
	inboxView,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	type InboxActionOutcome,
	type InboxClient,
	type InboxRecovery,
	type InboxRefresh,
	type ManagedInboxView,
} from './inbox';
import { createLocalEndpointClient } from './endpoint-client';
import { createEnrollmentLifecycle, type EnrollmentLifecycle } from './enrollment';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type EnterpriseIdentityStore,
} from './identity-store';
import {
	createContentCapture,
	createContentCollectionSource,
	type ContentDeliveryPort,
	type ContentCapture,
	type ContentCollectionSource,
} from './content';
import {
	createInstallationInventory,
	readContractsPin,
	type ContractsPinStatus,
	type InstallationInventoryService,
	type InventoryDeps,
} from './inventory';
import { createPolicyStatusService, type PolicyStatusService } from './policy-status';
import { createUsageCapture, usageSettlingSink, type UsageCapture } from './usage';
import {
	createCueSpawnAuthority,
	createProcessSpawnAuthority,
	pairedDeviceActorProblems,
} from './spawn-authority';
import {
	describeSpawnActor,
	getActingTransport,
	transportSpawnActor,
} from '../web-server/auth/transport-actor';
import { getActingUser } from '../web-server/auth/acting-user';
import type {
	ManagedCommunicationsPort,
	ManagedCommunicationType,
} from '../../shared/maestro-lib/runtime/server-requests';
import {
	buildVibesRecordedGraph,
	createVibesPublisher,
	type VibesPublisher,
	type VibesRecordedGraph,
} from './vibes';
import {
	createTelemetryClient,
	TELEMETRY_HOST_IDLE_POLL_MS,
	type TelemetryClient,
} from './telemetry';
import {
	createRemoteEndpointQualifier,
	type RemoteEndpointProbe,
	type RemoteEndpointQualifier,
} from './remote';
import type { ProcessSpawnActor, ProcessSpawnAuthorityPort } from '../process-manager/types';
import type { CueSpawnAuthorityPort } from '../cue/cue-run-router';
import { PICKABLE_AGENT_IDS } from '../../shared/agentMetadata';
import {
	COUNTERPART_SUPPORT,
	COUNTERPART_SUPPORT_REVISION,
	MANAGED_CAPABILITY_SUPPORT,
	MANAGED_ENDPOINT_PROTOCOLS,
	type SupportEntry,
} from '../../shared/maestro-lib/managed/compatibility';
import type {
	EndpointEnrollmentResult,
	EndpointStatus,
} from '../../shared/maestro-lib/managed/endpoint-port';
import { MANAGED_CONTRACT_VERSION } from '../../shared/maestro-lib/managed/types';
import {
	providerRouteSupport,
	type ProviderRouteSupport,
} from '../../shared/maestro-lib/providers/capabilities';
import type { ManagedSettingLocksView } from '../../shared/managedSettingsLock';
import { heldUpdate } from '../update-checker';
import { heldEgress, type EgressHold } from '../utils/fetchWithTimeout';
import type { EnrollmentRequestInput, LifecycleOutcome } from './enrollment';
import type { InstallationInventory } from './inventory';
import { heldListeners, type ListenerHold } from './listener-gate';
import {
	managedStandingOf,
	projectManagedState,
	type ManagedStanding,
	type ManagedStateView,
} from './managed-state';
import { readManagedSettingLocks } from './settings-policy';
import type { UpdateHold } from './update-policy';

/** What this host can do over the endpoint socket. Execution is the one it cannot run managed without. */
export const ENTERPRISE_SUPPORTED_CAPABILITIES: readonly string[] = [
	'attachment',
	'compatibility',
	'enrollment',
	'execution',
	'telemetry',
	'noticeList',
	'inbox',
	'command',
	'workflow',
];

/**
 * What the egress, update and listener ceilings refused, as the status
 * projection lists them. The desktop reads the real ledgers (the default);
 * a test or a headless composition names its own.
 */
export interface ManagedHolds {
	egress(): readonly EgressHold[];
	update(): UpdateHold | null;
	listeners(): readonly ListenerHold[];
}

export const DEFAULT_MANAGED_HOLDS: ManagedHolds = {
	egress: heldEgress,
	update: heldUpdate,
	listeners: heldListeners,
};

/**
 * This build's managed support matrix: the library and contract it speaks,
 * the capabilities and counterpart rows of `compatibility.ts`, and every
 * provider's per-route standalone and managed standing. A build fact, read
 * through the same facade as the live state so one `maestro-cli managed`
 * answer names both. `Plans/mega-maestro-rc/support-matrix.json` is its
 * exported, annotated copy.
 */
export interface ManagedSupportMatrix {
	library: string;
	contract: string;
	endpointProtocols: readonly number[];
	counterpartRevision: string;
	capabilities: readonly SupportEntry[];
	counterpart: readonly SupportEntry[];
	routes: readonly ProviderRouteSupport[];
}

export interface ManagedOperationsDeps {
	lifecycle: EnrollmentLifecycle;
	policy: Omit<PolicyStatusService, 'agentOptions'> &
		Partial<Pick<PolicyStatusService, 'agentOptions'>>;
	identity: EnterpriseIdentityStore;
	inventory: InstallationInventoryService;
	/** Default: the real ledgers (`DEFAULT_MANAGED_HOLDS`). */
	holds?: ManagedHolds;
	/** Default: `readManagedSettingLocks()`, the settings-policy module's own read. */
	locks?: () => ManagedSettingLocksView;
	/** The providers the support matrix lists. Default: every pickable provider. */
	providers?: readonly string[];
	/** The notice inbox (MRC-11-02A); absent on a host that composes none. */
	inbox?: InboxClient;
	/** The command service (MRC-11-01B); absent on a host that composes none. */
	commands?: CommandService;
	/** The dispatch ledger a managed run is read back from (MCOMP-25-01B); absent on a host that composes none. */
	dispatch?: Pick<BrokerDispatch, 'receipt'>;
}

/** One `managed inbox list`: the endpoint's answer to the listing (null when only the held set was read) and the view the pane draws. */
export interface ManagedInboxListing {
	refresh: InboxRefresh | null;
	view: ManagedInboxView;
}

/** One inbox act named by message; the campaign is resolved from the held notices unless named. */
export interface ManagedInboxActInput {
	messageId: string;
	campaignId?: string;
	action: EndpointInboxAction;
	/**
	 * The caller the receipt is attributed to (MRC-08-01). Default: the transport
	 * the current call was admitted over (`getActingTransport()`): the keyboard
	 * and the bare path token are the operator, a Web Login cookie its account,
	 * the CLI secret a process on this machine, a Lite pairing the device.
	 */
	actor?: ProcessSpawnActor;
}

export const NO_INBOX_OUTCOME: InboxActionOutcome = {
	status: 'unavailable',
	detail: 'No notice inbox is composed in this desktop.',
};

/**
 * The one implementation of the managed status surface (MRC2-07-01): what the
 * Settings > Environment pane, the `enterprise:*` IPC, the web bridge and
 * `maestro-cli managed` all answer from. Every value here is already a
 * projection for a person's screen: no sealed bytes, no socket path, no
 * invitation, proof, secret or anchor is in any of them, so a caller may
 * print a whole answer. The enrollment request is the one secret-carrying
 * input; it is relayed to the lifecycle and never echoed in the outcome.
 */
export interface ManagedOperations {
	/** The narrow standing a settings pane reads (MRC-11-03), with the holds in force. */
	status(): ManagedStateView;
	requestEnrollment(
		input: EnrollmentRequestInput
	): Promise<LifecycleOutcome<EndpointEnrollmentResult>>;
	/** An authenticated status update: re-attach over the registered socket. */
	refreshPolicy(): Promise<LifecycleOutcome<EndpointStatus>>;
	/** What this installation is and can do (MRC-10-06B): no path, socket or secret. */
	inventory(): InstallationInventory;
	supportMatrix(): ManagedSupportMatrix;
	/** Every settings key the managed policy holds right now, by name (MRC2-06-05). */
	locks(): ManagedSettingLocksView;
	/**
	 * The notices addressed to this desktop (MRC2-07-02): listed from the endpoint
	 * (`refresh`, the pane's List, which records `delivered` for every notice
	 * newly held) or the held set alone. Null when no inbox is composed. A body
	 * reaches the person's surface and nothing else (`agentInput: false`).
	 */
	inboxList(options?: { refresh?: boolean }): Promise<ManagedInboxListing | null>;
	/** Record one receipt (read, acknowledged, reply) on a held notice; the campaign is resolved from the held set. */
	inboxAct(input: ManagedInboxActInput): Promise<InboxActionOutcome>;
	/**
	 * Ask the endpoint's receipt custody about every `uncertain` receipt this host holds
	 * (MCOMP-29-03C, `InboxClient.recover()`): never resends. `unsupported` where no recovery
	 * operation is composed; null when no inbox is composed.
	 */
	inboxRecover(): Promise<InboxRecovery | null>;
	/** A local operator's typed command (`commands.ts` `issueLocal`): unavailable, with the standing, on an unmanaged host. */
	command(action: LocalCommandAction): Promise<CommandExecution>;
	/** What this desktop executes and refuses by name, the ledger's counts and the standing; null when no service is composed. */
	commandStatus(): CommandServiceStatus | null;
	/**
	 * A managed run read back from the dispatch ledger by its lease id
	 * (MCOMP-25-01B): what the composer recorded at send, now with the effect
	 * the ledger holds (bound, released, revoked, expired, or `unknown` after a
	 * restart). Identifiers only; null for a lease this host never admitted or
	 * when no ledger is composed. A record to show, never a permit to resend.
	 */
	run(leaseId: string): ManagedRunView | null;
}

/** The inbox and command half of the facade: what a detached host serves over its bridge too (MCOMP-29-03). */
export type ManagedCommunications = Pick<
	ManagedOperations,
	'inboxList' | 'inboxAct' | 'inboxRecover' | 'command' | 'commandStatus'
>;

export interface ManagedCommunicationsDeps {
	/** The custody a paired device's act is checked against (MRC-08-03). */
	identity: Pick<EnterpriseIdentityStore, 'read'>;
	/** Read per call: a host composes its inbox once the runtime holds the adapter, and drops it at close. */
	inbox: () => InboxClient | null | undefined;
	commands: () => CommandService | null | undefined;
	/** Where the answer says nothing is composed, with its preposition. Default: `in this desktop`. */
	place?: string;
}

/**
 * The one implementation of the inbox and command verbs (MRC2-07-02), shared by the desktop facade
 * and a detached host's bridge (MCOMP-29-03), so `maestro-cli managed inbox|command` reads the
 * same sentence from either. Nothing here reads a ledger file: no inbox or no service composed is
 * a refusal by name.
 */
export function createManagedCommunications(
	deps: ManagedCommunicationsDeps
): ManagedCommunications {
	const place = deps.place ?? 'in this desktop';
	const noInbox: InboxActionOutcome =
		deps.place === undefined
			? NO_INBOX_OUTCOME
			: { status: 'unavailable', detail: `No notice inbox is composed ${place}.` };
	const denied = (detail: string): InboxActionOutcome => ({
		status: 'denied',
		reason: 'unknown-message',
		detail,
		record: null,
	});
	return {
		async inboxList(options = {}) {
			const inbox = deps.inbox();
			if (!inbox) return null;
			const refresh = options.refresh === false ? null : await inbox.refresh();
			return { refresh, view: inboxView(inbox) };
		},
		async inboxAct({ messageId, campaignId, action, actor }) {
			const inbox = deps.inbox();
			if (!inbox) return noInbox;
			// The standing first: an unmanaged host is told so, not that it holds no message.
			const standing = inbox.status().standing;
			if (!standing.ok) return { status: 'unavailable', detail: standing.reason };
			// A receipt is the person's act. A paired Lite device admits a transport
			// and names a device; until the enrollment registers an actor it stands
			// for nobody here, so its act is refused by name (the MRC-08-03 rule the
			// spawn sinks apply), never recorded as the operator's.
			const problems = pairedDeviceActorProblems(
				actor ?? transportSpawnActor(getActingTransport()),
				deps.identity.read()
			);
			if (problems.length > 0) {
				return { status: 'denied', reason: 'unauthenticated', detail: problems[0], record: null };
			}
			const held = inbox
				.notices()
				.filter(
					(n) =>
						n.messageId === messageId && (campaignId === undefined || n.campaignId === campaignId)
				);
			if (held.length === 0) {
				return denied(`message ${messageId} is not held on this host; list the inbox first`);
			}
			if (held.length > 1) {
				return denied(`message ${messageId} is held under ${held.length} campaigns; name one`);
			}
			return inbox.act({ campaignId: held[0].campaignId, messageId, action });
		},
		async inboxRecover() {
			const inbox = deps.inbox();
			return inbox ? inbox.recover() : null;
		},
		command: (action) => {
			const commands = deps.commands();
			return commands
				? commands.issueLocal(action)
				: Promise.resolve({
						status: 'unavailable',
						commandId: null,
						detail: `No command service is composed ${place}.`,
					});
		},
		commandStatus: () => deps.commands()?.status() ?? null,
	};
}

const MAX_MANAGED_ID = 256;

/** A caller-supplied id on a managed bridge message: 1 to 256 characters, refused by field name, never by value. */
export function managedMessageId(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MANAGED_ID) {
		throw new Error(`${name} must be a string of 1 to ${MAX_MANAGED_ID} characters.`);
	}
	return value;
}

/** The typed runtime command a `managed_command` message names; refused by field name, never by value. */
export function validateLocalCommand(raw: unknown): LocalCommandAction {
	if (typeof raw !== 'object' || raw === null) throw new Error('action must be an object.');
	const input = raw as Record<string, unknown>;
	switch (input.kind) {
		case 'cancel-run':
			return { kind: 'cancel-run', runId: managedMessageId(input.runId, 'action.runId') };
		case 'pause-run':
		case 'resume-run':
			return { kind: input.kind, runId: managedMessageId(input.runId, 'action.runId') };
		case 'report-status':
			return { kind: 'report-status' };
		case 'refresh-policy': {
			const revision = input.desiredRevision;
			if (revision === undefined) return { kind: 'refresh-policy' };
			if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
				throw new Error('action.desiredRevision must be a whole policy revision number.');
			}
			return { kind: 'refresh-policy', desiredRevision: revision };
		}
		default:
			throw new Error(
				'action.kind must be one of cancel-run, pause-run, resume-run, report-status, refresh-policy.'
			);
	}
}

export interface ManagedCommunicationAnswerOptions {
	/** Where the refusal says nothing is composed, with its preposition. Default: `in this desktop`. */
	place?: string;
	/**
	 * Who an inbox act is attributed to. Default: the transport the current call was admitted over
	 * (`getActingTransport()`, the desktop dispatcher's context). A detached host, whose callers
	 * are all admitted on its per-boot CLI secret, names that peer.
	 */
	actor?: () => ProcessSpawnActor;
	/** One line per inbox act (who recorded which receipt on which message); never a body or reply text. */
	log?: (line: string) => void;
}

/**
 * Answer one inbox or command bridge message (MCOMP-29-03A): the named field of its
 * `<type>_result`, or a thrown sentence naming the refused field. The one implementation the
 * desktop bridge (`messageHandlers/managed.ts`) and a detached host's bridge
 * (`createManagedCommunicationsPort`) both answer from, so `maestro-cli managed inbox|command`
 * reads the same reply from either.
 */
export async function answerManagedCommunication(
	communications: ManagedCommunications,
	type: ManagedCommunicationType,
	message: Record<string, unknown>,
	options: ManagedCommunicationAnswerOptions = {}
): Promise<Record<string, unknown>> {
	const place = options.place ?? 'in this desktop';
	switch (type) {
		case 'managed_inbox_list': {
			const listing = await communications.inboxList({ refresh: message.refresh !== false });
			if (!listing) throw new Error(`No notice inbox is composed ${place}.`);
			return { listing };
		}
		case 'managed_inbox_act': {
			const problem = inboxActionProblem(message.action);
			if (problem) throw new Error(`action: ${problem}.`);
			const messageId = managedMessageId(message.messageId, 'messageId');
			const campaignId =
				message.campaignId === undefined
					? undefined
					: managedMessageId(message.campaignId, 'campaignId');
			const spawnActor = options.actor?.() ?? transportSpawnActor(getActingTransport());
			const actor = describeSpawnActor(spawnActor);
			const user = getActingUser()?.username ?? null;
			options.log?.(
				`managed_inbox_act ${String((message.action as { kind: string }).kind)} on ${messageId} by ${actor}${user ? ` (${user})` : ''}`
			);
			const outcome = await communications.inboxAct({
				messageId,
				campaignId,
				action: message.action as EndpointInboxAction,
				// The desktop leaves the facade to read the transport itself; a host names its peer.
				...(options.actor ? { actor: spawnActor } : {}),
			});
			return { outcome, actor, user };
		}
		case 'managed_inbox_recover': {
			const recovery = await communications.inboxRecover();
			if (!recovery) throw new Error(`No notice inbox is composed ${place}.`);
			return { recovery };
		}
		case 'managed_command':
			return { execution: await communications.command(validateLocalCommand(message.action)) };
		case 'managed_command_status': {
			const status = communications.commandStatus();
			if (!status) throw new Error(`No command service is composed ${place}.`);
			return { status };
		}
	}
	throw new Error(`Unknown managed message ${String(type)}.`);
}

/** The communications a detached host serves over its bridge (MCOMP-29-03A), as the runtime server's port. */
export function createManagedCommunicationsPort(
	communications: ManagedCommunications,
	options: ManagedCommunicationAnswerOptions = {}
): ManagedCommunicationsPort {
	return {
		answer: (type, message) => answerManagedCommunication(communications, type, message, options),
	};
}

export function createManagedOperations(deps: ManagedOperationsDeps): ManagedOperations {
	const holds = deps.holds ?? DEFAULT_MANAGED_HOLDS;
	const locks = deps.locks ?? readManagedSettingLocks;
	const providers = deps.providers ?? PICKABLE_AGENT_IDS;
	const communications = createManagedCommunications({
		identity: deps.identity,
		inbox: () => deps.inbox,
		commands: () => deps.commands,
	});
	return {
		...communications,
		status: () =>
			projectManagedState({
				status: deps.lifecycle.status(),
				policy: deps.policy.status(),
				agentOptions: deps.policy.agentOptions?.(locks()),
				custody: deps.identity.custody(),
				supported: ENTERPRISE_SUPPORTED_CAPABILITIES,
				egress: holds.egress(),
				update: holds.update(),
				listeners: holds.listeners(),
			}),
		requestEnrollment: (input) => deps.lifecycle.requestEnrollment(input),
		refreshPolicy: () => deps.policy.refresh(),
		inventory: () => deps.inventory.snapshot(),
		supportMatrix: () => ({
			library: MAESTRO_LIB_VERSION,
			contract: MANAGED_CONTRACT_VERSION,
			endpointProtocols: MANAGED_ENDPOINT_PROTOCOLS,
			counterpartRevision: COUNTERPART_SUPPORT_REVISION,
			capabilities: MANAGED_CAPABILITY_SUPPORT,
			counterpart: COUNTERPART_SUPPORT,
			routes: providers.flatMap((agentId) => providerRouteSupport(agentId)),
		}),
		locks: () => locks(),
		run: (leaseId) => {
			const receipt = deps.dispatch?.receipt(leaseId) ?? null;
			return receipt ? managedRunViewOfReceipt(receipt) : null;
		},
	};
}

export interface EnterpriseServiceDeps {
	/** The data directory the sealed record lives in (per device, never the sync folder). */
	userDataDir: string;
	/** The production data directory the installation identity is derived from. */
	productionDataDir: string;
	hostname: string;
	pid: number;
	startedAt: string;
	appVersion: string;
	safeStorage: SafeStorageLike;
	anchor: AnchorStore;
	platform?: NodeJS.Platform;
	now?: () => number;
	/** Test seam: how a port is opened for a socket path. */
	openPort?: Parameters<typeof createEnrollmentLifecycle>[0]['openPort'];
	/**
	 * Trusted host injection after authenticated EFFECT/1 negotiation on this port.
	 * Return the same producer while its connection/generation remains current,
	 * or null when unavailable. The default v1 client has no effect producer.
	 */
	effectProducer?(port: EndpointPort): ManagedEffectProducer | null;
	/** Trusted host injection after authenticated CONTENT-LOCAL/1 negotiation; the v1 client has none. */
	contentDelivery?(port: EndpointPort): ContentDeliveryPort | null;
	/** Hears a dispatch ledger write that failed. Default: nothing; `dispatch.persistFailures()` counts them. */
	onDispatchPersistError?(error: unknown): void;
	/** Test seam: how an SSH remote is asked for its managed standing. Default: the real probe over ssh. */
	remoteProbe?: RemoteEndpointProbe;
	/** Hears the event journal file refusing to load at start (corrupt, unreadable); the journal then stays detached. Default: nothing. */
	onEventJournalUnavailable?(load: Extract<EventJournalLoad, { ok: false }>): void;
	/** The OS label the inventory reports beside the hostname (MRC-10-06B). Default: none. */
	os?: InventoryDeps['os'];
	/** Whether a provider binary was detected on this host, from the capability snapshots. Default: unknown for every provider. */
	installed?: InventoryDeps['installed'];
	/** The pinned Mega-Maestro contracts artifact (`vendor/mega-maestro/contracts.pin.json`) to read, or its status. Default: absent (CP-01). */
	contractsPin?: string | (() => ContractsPinStatus);
	/** Test seam: the hold ledgers `managed.status()` lists. Default: the real ones. */
	holds?: ManagedHolds;
	/** How often live runs are held to the standing in force (`constrainLiveRuns`). Default 15 s; 0 runs no timer. */
	liveRunCheckMs?: number;
	/**
	 * The opaque account reference (`managedAccountRef`) an agent's run settles its usage under,
	 * resolved from the agent's real layers when the run settles. Null when the provider has no
	 * account concept or the agent's current provider is not the run's. Default: none (null).
	 */
	accountRefOf?(agent: { agentId: string; provider: string }): string | null;
}

/**
 * The standings under which a managed run may not keep running (MCOMP-25-03):
 * the record is revoked, retired or suspended, the endpoint denied the last
 * request, or custody of the record is refused. The renderer's run state reads
 * the same set as `revoked` (`useManagedStatus.ts`). An `offline` or
 * `stale` standing is not among them: the run keeps what it was admitted
 * under, as an offline holder does, and a live run still answers Stop.
 */
export const RUN_REFUSING_STANDINGS: ReadonlySet<ManagedStanding> = new Set([
	'denied',
	'suspended',
	'revoked',
	'retired',
	'custody-refused',
]);

/** What one pass of `constrainLiveRuns` found and did. Lease ids only. */
export interface LiveRunConstraint {
	standing: ManagedStanding;
	/** Leases issued or bound when the pass began. */
	live: number;
	/** Leases this pass revoked; each sink stops its process under the revoked lease. */
	revoked: string[];
	/** The sentence each revoked lease carries into the ledger; null when nothing was refused. */
	reason: string | null;
}

export interface EnterpriseService {
	readonly installation: ManagedInstallationIdentity;
	readonly identity: EnterpriseIdentityStore;
	readonly lifecycle: EnrollmentLifecycle;
	readonly policy: PolicyStatusService;
	readonly host: ManagedHostAdapter;
	/** The broker dispatch bridge: the sink-facing authority and the decision-to-effect ledger. */
	readonly dispatch: BrokerDispatch;
	/** The port the process manager admits every desktop spawn with (`spawn-authority.ts`). */
	readonly spawnAuthority: ProcessSpawnAuthorityPort;
	/** The port the Cue run router admits every desktop Cue prompt run with (origin `cue`, same enrollment). */
	readonly cueSpawnAuthority: CueSpawnAuthorityPort;
	/** Where a managed launch with an SSH setting may run (`remote.ts`, MRC-08-04): the remote with its endpoint bound, or a refusal by name. */
	readonly remote: RemoteEndpointQualifier;
	/**
	 * The lifecycle metadata projection (MRC-10-01): what the agent-run capture
	 * reports of every desktop spawn and exit, as managed events in a bounded
	 * window, attributed to the registered actor (else the operator) under the
	 * policy generation the host applies. A projection, not delivery.
	 */
	readonly events: LifecycleProjector;
	/**
	 * The actual usage producer (MCOMP-27-01): `usage.observeStats()` hears the process
	 * manager's `usage` stream, and `runLifecycle` is the sink the agent-run capture is
	 * handed in place of `events`: every lifecycle fact reaches `events` unchanged and
	 * each terminal fact settles that run's `usage` event (estimated or unavailable,
	 * never an invented zero). The inventory reports the sessions it tracks.
	 */
	readonly usage: UsageCapture;
	readonly runLifecycle: LifecycleEventSink;
	/**
	 * The durable event journal (MRC-10-02A) attached to `events` at start: what a
	 * telemetry client takes batches from and settles with the endpoint's answer.
	 * `eventJournalAttached()` says whether its file loaded; a file that would not
	 * is reported through `onEventJournalUnavailable` and never overwritten.
	 */
	readonly eventJournal: EventJournal;
	eventJournalAttached(): boolean;
	/**
	 * The authenticated telemetry client (MRC-10-03B) over `eventJournal` and `host`: started
	 * at `start()` once the journal is attached, woken by every event `events` projects, polling
	 * rarely otherwise, stopped and drained at `close()` before the journal flushes. It sends
	 * only under a registered standing and settles every entry with the endpoint's own answer.
	 */
	readonly telemetry: TelemetryClient;
	/**
	 * Content collection under the signed profile (MRC-10-05): `content` reads the
	 * standing (the endpoint's profile, a ceiling for the applied revision, held in
	 * memory only, via an injected CONTENT-LOCAL/1 port) and `contentCapture` holds
	 * what the process listener hands it until that port accepts it. `vibes()` is the
	 * recorded VIBES graph of what `events` holds right now, gaps named.
	 */
	readonly content: ContentCollectionSource;
	readonly contentCapture: ContentCapture;
	vibes(): VibesRecordedGraph;
	/**
	 * VIBES publication (MCOMP-27-03): from `start()` on, every finished root run's
	 * recorded graph is captured by `contentCapture` as `vibes.annotations` (kept only
	 * under `full_vibes` and a granting ceiling, delivered by the same CONTENT-LOCAL/1
	 * pass), each publication naming the event ids, origins and revisions it came from.
	 */
	readonly vibesPublisher: VibesPublisher;
	/**
	 * What this installation is and can do (MRC-10-06B): `snapshot()` is the local
	 * read every status surface answers from, `record()` projects the fleet-facing
	 * fact as one `inventory` event per distinct inventory. Recorded once at the end
	 * of `start()`, after the standing is known; the journal keeps it, the telemetry
	 * client withholds it by name (no runtime family carries it).
	 */
	readonly inventory: InstallationInventoryService;
	/**
	 * The notice and inbox client (`inbox.ts`, MRC-11-02A) over `host` and the receipt
	 * ledger in the data directory (MRC-11-05): its ledger is read at `start()` before
	 * any attach, and the notices are listed again after every attachment the endpoint
	 * accepts, so a registered desktop holds what is addressed to its actor without a
	 * click. The `enterprise:inbox*` IPC and the inbox surface read it; a body reaches
	 * the person's surface and nothing else.
	 */
	readonly inbox: InboxClient;
	/**
	 * The typed runtime command service (`commands.ts`, MRC-11-01B) over the dispatch
	 * authority, the policy status and the inventory (MRC-11-05): its ledger is read at
	 * `start()` before any attach, so a command accepted by an earlier process is
	 * `unknown` before this one admits anything. `receive()` is the one inbound entry;
	 * no producer delivers a command to it yet (CP-02), and `enterprise:commandStatus`
	 * is its read.
	 */
	readonly commands: CommandService;
	/**
	 * The managed status surface (MRC2-07-01): status, enrollment request, policy
	 * refresh, inventory, support matrix and lock listing, as the IPC handlers,
	 * the web bridge and `maestro-cli managed` all call it. One implementation;
	 * every answer is printable (nothing sealed or secret is in it).
	 */
	readonly managed: ManagedOperations;
	/**
	 * The workflow owner fences this installation holds (MRC-07-06), claimed
	 * through the endpoint's workflow owner operation and kept in
	 * `maestro-managed-workflows.json` across retries, restarts and offline.
	 */
	readonly workflows: WorkflowOwnership;
	/**
	 * Claim the owner fence of a workflow for one run and attempt, as the Cue
	 * router's `workflowFence` and any other desktop sink read it: the fence
	 * the registry confirmed, or the named reason there is none. Offline
	 * holding is declared when an installed policy revision is on record.
	 */
	claimWorkflowFence(
		workflow: WorkflowIdentityLike,
		run: { runId: string; attemptId: string }
	): Promise<WorkflowFenceAnswer>;
	/**
	 * Hold every live managed run to the standing in force now (MCOMP-25-03):
	 * under a standing in `RUN_REFUSING_STANDINGS` each issued or bound lease
	 * is revoked with the reason, so the process manager stops the process
	 * running under it and the ledger records `revoked`. Policy loss constrains
	 * the running effect, not only the next send. Runs on a timer between
	 * `start()` and `close()` and after every policy refresh.
	 */
	constrainLiveRuns(): LiveRunConstraint;
	/** Recover once before admitting work, then re-attach. Ledger failure rejects and holds admission. */
	start(): Promise<void>;
	close(): Promise<void>;
}

export function createEnterpriseService(deps: EnterpriseServiceDeps): EnterpriseService {
	const now = deps.now ?? (() => Date.now());
	const installation = installationIdentity({
		hostname: deps.hostname,
		productionDataDir: deps.productionDataDir,
		mode: 'desktop',
		pid: deps.pid,
		startedAt: deps.startedAt,
	});
	const identity = createEnterpriseIdentityStore({
		file: `${deps.userDataDir}/${ENTERPRISE_IDENTITY_FILE_NAME}`,
		seal: safeStorageSeal(deps.safeStorage),
		anchor: deps.anchor,
		...(deps.platform ? { platform: deps.platform } : {}),
		now,
	});
	const components: EndpointComponent[] = [
		{ id: 'maestro', kind: 'maestro', version: deps.appVersion },
		{ id: 'maestro-lib', kind: 'runtime', version: MAESTRO_LIB_VERSION },
	];
	// The socket the lifecycle opened last, injected or the real client, so the
	// host adapter and the workflow ownership speak over the same connection.
	let port: EndpointPort | null = null;
	let admissionReady = false;
	let starting: Promise<void> | null = null;
	// Close once: the quit handler's cleanup and a later will-quit can both reach it.
	let closing: Promise<void> | null = null;
	const openPort =
		deps.openPort ?? ((socketPath: string) => createLocalEndpointClient({ socketPath }));
	const lifecycle = createEnrollmentLifecycle({
		identity,
		openPort: (socketPath) => {
			port = openPort(socketPath);
			return port;
		},
		installation,
		components,
		capabilities: { supported: ENTERPRISE_SUPPORTED_CAPABILITIES, required: [] },
		now,
		// Every accepted attachment lists the notices again (below): what the endpoint
		// holds for this actor is held here without a click, and the listing is the
		// client's own, fired after the verb and never awaited by it.
		onAttached: () => {
			if (closing) return;
			void inbox.refresh();
			void content.refresh().then((installed) => {
				if (installed.installed && !closing) void contentCapture.deliver();
			});
		},
	});
	const policy = createPolicyStatusService({ lifecycle, now });
	const host = createManagedHostAdapter({
		installation,
		identity: { read: () => lifecycle.status().identity },
		get endpoint() {
			return port;
		},
		status: () => {
			const status = lifecycle.status();
			return admissionReady && !closing
				? status
				: {
						...status,
						authority: 'none',
						reason: closing
							? 'The desktop authority is closing.'
							: 'The desktop authority has not recovered its dispatch state.',
					};
		},
		effectProducer: () =>
			admissionReady && !closing && port ? (deps.effectProducer?.(port) ?? null) : null,
		now,
	});
	const dispatch = createBrokerDispatch({
		host,
		file: `${deps.userDataDir}/${DISPATCH_RECEIPTS_FILE_NAME}`,
		now,
		...(deps.onDispatchPersistError ? { onPersistError: deps.onDispatchPersistError } : {}),
	});

	// The owner fences this installation holds, claimed as the installation
	// (the owner that outlives this process) under the authority the sealed
	// record names, through whatever socket is open right now. No record, no
	// standing to claim under; no socket, an offline-enabled holder keeps what
	// the registry already issued and nothing else is answered.
	const workflows = createWorkflowOwnership({
		file: `${deps.userDataDir}/${MANAGED_WORKFLOWS_FILE_NAME}`,
		port: () => (port ? endpointWorkflowOwnerPort(port) : null),
		owner: () => {
			const view = lifecycle.status().identity;
			if (view.status !== 'ok' || !view.record) return null;
			return {
				ownerId: installation.installationId,
				authorityId: managedAuthorityId(view.record),
				policyRevision: host.policy().policyRevision,
			};
		},
		now,
	});
	const claimWorkflowFence: EnterpriseService['claimWorkflowFence'] = async (workflow, run) =>
		workflowFenceOf(
			await workflows.claim({
				workflow,
				runId: run.runId,
				attemptId: run.attemptId,
				offlineEnabled: host.policyStatus().offline.installedPolicyAvailable,
			})
		);

	// The process sink claims an unowned Auto Run's fence through the same
	// held ownership the Cue router claims through, so one record holds
	// every fence this desktop was issued.
	const spawnAuthority = createProcessSpawnAuthority({
		installation,
		identity,
		host,
		dispatch,
		effects: host.effects,
		workflowFence: claimWorkflowFence,
		now,
	});
	const cueSpawnAuthority = createCueSpawnAuthority({
		installation,
		identity,
		host,
		dispatch,
		now,
	});
	const remote = createRemoteEndpointQualifier({
		identity,
		...(deps.remoteProbe ? { probe: deps.remoteProbe } : {}),
	});
	const events = createLifecycleProjector({
		installation,
		origin: 'desktop',
		actor: () => managedActorPrincipal(lifecycle.status().identity, installation),
		policyRevision: () => host.policy().policyRevision,
	});
	const eventJournal = createEventJournal({
		file: `${deps.userDataDir}/${MANAGED_EVENT_JOURNAL_FILE_NAME}`,
		now,
		newId: generateUUID,
	});
	let eventJournalAttached = false;
	const telemetry = createTelemetryClient({
		journal: eventJournal,
		host,
		now,
		intervalMs: TELEMETRY_HOST_IDLE_POLL_MS,
	});
	// The content standing is the lifecycle's standing read at each capture; the
	// ceiling comes only through an injected CONTENT-LOCAL/1 port (no published
	// operation carries one, CP-01), so without one an enrolled desktop refuses every
	// capture by name and a standalone one never follows a process.
	const content = createContentCollectionSource({
		status: () => lifecycle.status(),
		delivery: () => (port && !closing ? (deps.contentDelivery?.(port) ?? null) : null),
	});
	const contentCapture = createContentCapture({ source: content, now });
	const vibesPublisher = createVibesPublisher({ events, capture: contentCapture });
	let stopVibes: (() => void) | null = null;
	const usage = createUsageCapture({
		events,
		identity: () => lifecycle.status().identity,
		accountRef: (agent) => deps.accountRefOf?.(agent) ?? null,
		now,
	});
	const runLifecycle = usageSettlingSink(events, usage);
	const contractsPin: () => ContractsPinStatus =
		typeof deps.contractsPin === 'function'
			? deps.contractsPin
			: deps.contractsPin
				? (
						(file) => () =>
							readContractsPin(file)
					)(deps.contractsPin)
				: () => ({
						status: 'absent',
						reason: 'no contracts pin file was named to this desktop (CP-01, owner mega-maestro)',
					});
	const inventory = createInstallationInventory({
		installation,
		appVersion: deps.appVersion,
		components,
		hostname: deps.hostname,
		os: deps.os ?? null,
		status: () => lifecycle.status(),
		policyStatus: () => host.policyStatus(),
		events,
		journal: () => (eventJournalAttached ? eventJournal.status() : null),
		telemetry: () => telemetry.status(),
		content: () => ({ standing: content.standing(), capture: contentCapture.status() }),
		// The usage producer the process listener and the run capture feed (MCOMP-27-01).
		usage: () => usage.size(),
		installed: deps.installed ?? (() => ({ state: 'unknown', version: null })),
		contractsPin,
		now,
	});
	// The typed command executor over the real sinks (MRC-11-01B): the dispatch
	// authority a cancel revokes through, the policy status a refresh re-attaches
	// through, the inventory a report answers with. No prompt port is composed on
	// the desktop, so no operator prompt reaches a composer, a queue or a model.
	const commands = createCommandService({
		installation,
		lifecycle,
		host,
		policy,
		dispatch,
		inventory,
		file: `${deps.userDataDir}/${MANAGED_COMMAND_LEDGER_FILE_NAME}`,
		now,
	});
	// The notice inbox (MRC-11-02A) over the same host adapter and its own receipt
	// ledger: ids, digests and states on disk, never a body or a reply's text.
	const inbox = createInboxClient({
		host,
		ledger: createInboxReceiptLedger({
			file: `${deps.userDataDir}/${MANAGED_INBOX_RECEIPTS_FILE_NAME}`,
			now,
		}),
		now,
	});
	const constrainLiveRuns = (): LiveRunConstraint => {
		const status = lifecycle.status();
		const standing = managedStandingOf(status, policy.status());
		const live = host.authority.live();
		if (!RUN_REFUSING_STANDINGS.has(standing) || live.length === 0)
			return { standing, live: live.length, revoked: [], reason: null };
		const reason =
			`Managed execution is refused: the host standing is ${standing}.` +
			(status.reason ? ` ${status.reason}` : '');
		const revoked = live
			.filter((lease) => host.authority.revoke(lease.leaseId, reason))
			.map((lease) => lease.leaseId);
		return { standing, live: live.length, revoked, reason };
	};
	let liveRunTimer: ReturnType<typeof setInterval> | null = null;
	const liveRunCheckMs = deps.liveRunCheckMs ?? 15_000;
	// The status surface every caller answers from (MRC2-07-01): the IPC handler,
	// the bridge and the CLI read this one object, so a held key, a stale policy
	// or a refused custody is the same sentence on every screen.
	const operations = createManagedOperations({
		lifecycle,
		policy,
		identity,
		inventory,
		inbox,
		commands,
		dispatch,
		...(deps.holds ? { holds: deps.holds } : {}),
	});
	// A refresh is where a revocation or suspension is learned: the runs it refuses stop now.
	const managed: ManagedOperations = {
		...operations,
		async refreshPolicy() {
			const outcome = await operations.refreshPolicy();
			if (!closing) constrainLiveRuns();
			return outcome;
		},
	};
	return {
		installation,
		identity,
		lifecycle,
		policy,
		host,
		dispatch,
		spawnAuthority,
		cueSpawnAuthority,
		remote,
		events,
		usage,
		runLifecycle,
		eventJournal,
		eventJournalAttached: () => eventJournalAttached,
		telemetry,
		content,
		contentCapture,
		vibes: () => buildVibesRecordedGraph(events.recent(), { projectorGaps: events.gaps() }),
		vibesPublisher,
		inventory,
		inbox,
		commands,
		managed,
		workflows,
		claimWorkflowFence,
		constrainLiveRuns,
		start() {
			if (closing) return closing;
			starting ??= (async () => {
				// The ledger is read first: a lease still bound at the last exit is unknown from here on.
				const loadedDispatch = await dispatch.load();
				if (!loadedDispatch.ok)
					throw new Error(`Managed dispatch recovery failed: ${loadedDispatch.message}`);
				// So are the held fences: a restarted host re-claims with what it held, never afresh.
				await workflows.load();
				// And the command and receipt ledgers, before any attach makes admission possible:
				// a command accepted by the last process is unknown, a pending receipt uncertain.
				await commands.load();
				await inbox.load();
				// The event journal reads its file before the projection raises anything this process
				// observes; a file that will not load is reported and left alone, never overwritten.
				const loadedEvents = await eventJournal.load();
				if (closing) return;
				if (loadedEvents.ok) {
					eventJournal.attach(events);
					eventJournalAttached = true;
					// The client passes when an event lands and rarely otherwise; with no record its
					// standing read finds no file and stops there, so an unenrolled desktop still never
					// touches the keyring. Started with no standing yet: the first passes answer so.
					events.subscribe(() => telemetry.wake());
					telemetry.start();
				} else {
					deps.onEventJournalUnavailable?.(loadedEvents);
				}
				// Every finished run tree from here on is offered to the content capture as VIBES evidence.
				stopVibes ??= vibesPublisher.start();
				// No sealed file, no custody read: an unenrolled desktop never touches the keyring here.
				admissionReady = true;
				if (identity.read().status === 'ok') await lifecycle.connect();
				// What this boot is, once its standing is known: one event per distinct
				// inventory, kept by the journal, withheld from the endpoint by name.
				inventory.record();
				// From here on a live run is held to the standing between sends, not only at admission.
				if (liveRunCheckMs > 0 && !closing && !liveRunTimer) {
					liveRunTimer = setInterval(() => {
						if (!closing) constrainLiveRuns();
					}, liveRunCheckMs);
					liveRunTimer.unref?.();
				}
			})();
			return starting;
		},
		close() {
			// Idempotent: the quit handler's cleanup and a later will-quit both land here, and
			// the second caller waits on the first drain instead of starting another.
			closing ??= (async () => {
				admissionReady = false;
				if (liveRunTimer) clearInterval(liveRunTimer);
				liveRunTimer = null;
				stopVibes?.();
				stopVibes = null;
				host.authority.revokeAll('The desktop authority is closing.');
				// A failed start still needs cleanup; its caller receives the original rejection.
				await starting?.catch(() => undefined);
				// No new pass; the one in flight settles its batch before the socket and the file go.
				telemetry.stop();
				await telemetry.drain();
				await lifecycle.close();
				await dispatch.flush();
				// What the journal recorded of the last spawns and exits, before the process goes.
				if (eventJournalAttached) await eventJournal.flush();
			})();
			return closing;
		},
	};
}
