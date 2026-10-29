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
import {
	createLifecycleProjector,
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
import { MANAGED_COMMAND_LEDGER_FILE_NAME } from '../../shared/maestro-lib/managed/commands';
import { createCommandService, type CommandService } from './commands';
import { createBrokerDispatch, DISPATCH_RECEIPTS_FILE_NAME, type BrokerDispatch } from './dispatch';
import {
	createInboxClient,
	createInboxReceiptLedger,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	type InboxClient,
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
import { createCueSpawnAuthority, createProcessSpawnAuthority } from './spawn-authority';
import { buildVibesRecordedGraph, type VibesRecordedGraph } from './vibes';
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
import type { ProcessSpawnAuthorityPort } from '../process-manager/types';
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
import { projectManagedState, type ManagedStateView } from './managed-state';
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
	policy: PolicyStatusService;
	identity: EnterpriseIdentityStore;
	inventory: InstallationInventoryService;
	/** Default: the real ledgers (`DEFAULT_MANAGED_HOLDS`). */
	holds?: ManagedHolds;
	/** Default: `readManagedSettingLocks()`, the settings-policy module's own read. */
	locks?: () => ManagedSettingLocksView;
	/** The providers the support matrix lists. Default: every pickable provider. */
	providers?: readonly string[];
}

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
}

export function createManagedOperations(deps: ManagedOperationsDeps): ManagedOperations {
	const holds = deps.holds ?? DEFAULT_MANAGED_HOLDS;
	const locks = deps.locks ?? readManagedSettingLocks;
	const providers = deps.providers ?? PICKABLE_AGENT_IDS;
	return {
		status: () =>
			projectManagedState({
				status: deps.lifecycle.status(),
				policy: deps.policy.status(),
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
	 * memory only; no endpoint operation of this build carries one, so nothing
	 * installs it yet) and `contentCapture` records what the process listener hands
	 * it, bytes held until an endpoint capture takes them. `vibes()` is the
	 * recorded VIBES graph of what `events` holds right now, gaps named.
	 */
	readonly content: ContentCollectionSource;
	readonly contentCapture: ContentCapture;
	vibes(): VibesRecordedGraph;
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
	/** Re-attach a previously enrolled installation. Never throws; the outcome is in `status()`. */
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
			if (!closing) void inbox.refresh();
		},
	});
	const policy = createPolicyStatusService({ lifecycle, now });
	const host = createManagedHostAdapter({
		installation,
		identity: { read: () => lifecycle.status().identity },
		get endpoint() {
			return port;
		},
		status: () => lifecycle.status(),
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
	// ceiling it needs has no endpoint operation yet (CP-01), so an enrolled desktop
	// refuses every capture by name and a standalone one never follows a process.
	const content = createContentCollectionSource({ status: () => lifecycle.status() });
	const contentCapture = createContentCapture({ source: content, now });
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
		// No producer calls the usage capture yet (MRC-10-04A open): a gap by name, not a zero.
		usage: () => null,
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
	// The status surface every caller answers from (MRC2-07-01): the IPC handler,
	// the bridge and the CLI read this one object, so a held key, a stale policy
	// or a refused custody is the same sentence on every screen.
	const managed = createManagedOperations({
		lifecycle,
		policy,
		identity,
		inventory,
		...(deps.holds ? { holds: deps.holds } : {}),
	});
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
		eventJournal,
		eventJournalAttached: () => eventJournalAttached,
		telemetry,
		content,
		contentCapture,
		vibes: () => buildVibesRecordedGraph(events.recent(), { projectorGaps: events.gaps() }),
		inventory,
		inbox,
		commands,
		managed,
		workflows,
		claimWorkflowFence,
		async start() {
			// The ledger is read first: a lease still bound at the last exit is unknown from here on.
			await dispatch.load();
			// So are the held fences: a restarted host re-claims with what it held, never afresh.
			await workflows.load();
			// And the command and receipt ledgers, before any attach makes admission possible:
			// a command accepted by the last process is unknown, a pending receipt uncertain.
			await commands.load();
			await inbox.load();
			// The event journal reads its file before the projection raises anything this process
			// observes; a file that will not load is reported and left alone, never overwritten.
			const loadedEvents = await eventJournal.load();
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
			// No sealed file, no custody read: an unenrolled desktop never touches the keyring here.
			if (identity.read().status === 'ok') await lifecycle.connect();
			// What this boot is, once its standing is known: one event per distinct
			// inventory, kept by the journal, withheld from the endpoint by name.
			inventory.record();
		},
		close() {
			// Idempotent: the quit handler's cleanup and a later will-quit both land here, and
			// the second caller waits on the first drain instead of starting another.
			closing ??= (async () => {
				// No new pass; the one in flight settles its batch before the socket and the file go.
				telemetry.stop();
				await telemetry.drain();
				await lifecycle.close();
				// What the journal recorded of the last spawns and exits, before the process goes.
				if (eventJournalAttached) await eventJournal.flush();
			})();
			return closing;
		},
	};
}
