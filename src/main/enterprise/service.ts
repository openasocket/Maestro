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
import { createBrokerDispatch, DISPATCH_RECEIPTS_FILE_NAME, type BrokerDispatch } from './dispatch';
import { createLocalEndpointClient } from './endpoint-client';
import { createEnrollmentLifecycle, type EnrollmentLifecycle } from './enrollment';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type EnterpriseIdentityStore,
} from './identity-store';
import { createPolicyStatusService, type PolicyStatusService } from './policy-status';
import { createCueSpawnAuthority, createProcessSpawnAuthority } from './spawn-authority';
import {
	createRemoteEndpointQualifier,
	type RemoteEndpointProbe,
	type RemoteEndpointQualifier,
} from './remote';
import type { ProcessSpawnAuthorityPort } from '../process-manager/types';
import type { CueSpawnAuthorityPort } from '../cue/cue-run-router';

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
		workflows,
		claimWorkflowFence,
		async start() {
			// The ledger is read first: a lease still bound at the last exit is unknown from here on.
			await dispatch.load();
			// So are the held fences: a restarted host re-claims with what it held, never afresh.
			await workflows.load();
			// The event journal reads its file before the projection raises anything this process
			// observes; a file that will not load is reported and left alone, never overwritten.
			const loadedEvents = await eventJournal.load();
			if (loadedEvents.ok) {
				eventJournal.attach(events);
				eventJournalAttached = true;
			} else {
				deps.onEventJournalUnavailable?.(loadedEvents);
			}
			// No sealed file, no custody read: an unenrolled desktop never touches the keyring here.
			if (identity.read().status !== 'ok') return;
			await lifecycle.connect();
		},
		async close() {
			await lifecycle.close();
			// What the journal recorded of the last spawns and exits, before the process goes.
			if (eventJournalAttached) await eventJournal.flush();
		},
	};
}
