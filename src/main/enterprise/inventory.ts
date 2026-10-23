/**
 * The fleet inventory of this installation (MRC-10-06A): what this host is and
 * what it can do, read off the seams that already exist and reported with every
 * gap named. Nothing here probes, pairs or decides; it reads.
 *
 * Three readings, in one order of trust:
 *
 *   - `snapshot()` is the local read: the app, library, contract, plugin host
 *     API and endpoint protocol versions, the pinned Mega-Maestro contracts
 *     artifact (or its named absence, CP-01), the endpoint and identity
 *     standing, the projected policy status, every pickable provider with its
 *     DETECTED installation beside the ENFORCEMENT words of its routes (a
 *     binary that starts is not a route that is enforced), the one qualified
 *     synthetic route, the subagents this host observed, and the health of
 *     the collection seams (projector, journal, telemetry, content, usage).
 *   - `fact()` is the fleet-facing subset in the sibling `fleetInventory`
 *     vocabulary (`InventoryFact` in `managed/events.ts`): the device, the
 *     runtimes, the providers, the subagents, the revision, completeness and
 *     the gaps. No reason text, no message, no path, no socket.
 *   - `record()` projects that fact as an `inventory` event the journal keeps
 *     once per distinct inventory; a change is the delta.
 *
 * What is never here: a socket path, a binary path, a data directory, a
 * credential, a registration code, or a count the host did not observe. A
 * provider's internal subagents (its own task tool) are not observed by the
 * lifecycle producers of this build and are reported `unavailable`, never 0;
 * another host on the same installation (a `maestro-cli host`, a TUI) is not
 * observed from this process and is a named gap, so completeness is `partial`.
 * The endpoint takes no inventory family from a runtime source (owner
 * mega-maestro), so the event stays on the host, paged by `events.resume`.
 */

import * as fs from 'node:fs';

import { PICKABLE_AGENT_IDS } from '../../shared/agentMetadata';
import { HOST_API_VERSION } from '../../shared/plugins/host-api';
import { MAESTRO_LIB_VERSION } from '../../shared/maestro-lib/version';
import {
	LOCAL_ENDPOINT_PROTOCOL,
	type EndpointComponent,
	type EndpointStatus,
	type ManagedEnrollmentStatus,
	type ManagedIdentityManagement,
	type ManagedIdentityView,
} from '../../shared/maestro-lib/managed/endpoint-port';
import type { EventJournalStatus } from '../../shared/maestro-lib/managed/event-journal';
import type {
	InventoryFact,
	InventoryObservation,
	InventoryProvider,
	LifecycleProjector,
	ManagedInventoryEvent,
} from '../../shared/maestro-lib/managed/events';
import type { ManagedPolicyStatus } from '../../shared/maestro-lib/managed/host-adapter';
import {
	syntheticHarnessRouteSupport,
	type HarnessRouteSupport,
} from '../../shared/maestro-lib/managed/provider-route';
import {
	MANAGED_CONTRACT_VERSION,
	type ManagedInstallationIdentity,
} from '../../shared/maestro-lib/managed/types';
import {
	MANAGED_ROUTES,
	providerRouteSupport,
} from '../../shared/maestro-lib/providers/capabilities';
import type { ContentCaptureStatus, ContentCollectionStanding } from './content';
import type { TelemetryClientStatus } from './telemetry';
import { VIBES_CAPABILITY } from './vibes';

/** Whether a provider binary was detected on this host (installation, never enforcement) and what version it reported. */
export interface ProviderInstallation {
	state: 'detected' | 'absent' | 'unknown';
	version: string | null;
}

/** The pinned Mega-Maestro contracts artifact (`vendor/mega-maestro/contracts.pin.json`), or why there is none. Never the file's path. */
export type ContractsPinStatus =
	| {
			status: 'pinned';
			name: string | null;
			version: string | null;
			sha256: string;
			sourceRevision: string | null;
			sourceDirty: boolean | null;
	  }
	| { status: 'absent' | 'unreadable'; reason: string };

const PIN_MAX_BYTES = 64 * 1024;
const HEX64 = /^[a-f0-9]{64}$/;

/** Read the pin the importer wrote. Absent is the CP-01 gap by name; a malformed file is unreadable, not a pin. */
export function readContractsPin(file: string): ContractsPinStatus {
	if (!fs.existsSync(file)) {
		return {
			status: 'absent',
			reason:
				'no clean Mega-Maestro contracts artifact is pinned in this checkout (CP-01, owner mega-maestro)',
		};
	}
	try {
		const raw = fs.readFileSync(file, { encoding: 'utf8', flag: 'r' });
		if (Buffer.byteLength(raw) > PIN_MAX_BYTES) {
			return { status: 'unreadable', reason: 'the pin exceeds the bounded size of a pin' };
		}
		const pin = JSON.parse(raw) as Record<string, unknown> | null;
		if (
			!pin ||
			typeof pin !== 'object' ||
			pin.formatVersion !== 1 ||
			!HEX64.test(String(pin.sha256))
		) {
			return { status: 'unreadable', reason: 'the pin is not a format 1 pin naming a sha256' };
		}
		const text = (value: unknown): string | null =>
			typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
		return {
			status: 'pinned',
			name: text(pin.name),
			version: text(pin.version),
			sha256: String(pin.sha256),
			sourceRevision: text(pin.sourceRevision),
			sourceDirty: typeof pin.sourceDirty === 'boolean' ? pin.sourceDirty : null,
		};
	} catch (error) {
		return {
			status: 'unreadable',
			reason: `the pin could not be read: ${error instanceof Error ? error.name : 'error'}`,
		};
	}
}

/** The endpoint's `telemetry` operation takes no inventory family from a runtime source; the event stays on this host. */
export const INVENTORY_DELIVERY = Object.freeze({
	available: false as const,
	reason:
		'The endpoint takes a runtime report only in the presence, agent.lifecycle, usage and error families; its inventory.snapshot and inventory.delta families have no runtime producer in this build (owner mega-maestro). The inventory event stays in the host journal, paged by events.resume.',
});

export interface InventoryDeps {
	installation: ManagedInstallationIdentity;
	appVersion: string;
	/** The components the attachment announced; the inventory names the same ones. */
	components: readonly EndpointComponent[];
	hostname: string | null;
	os: { platform: string; release: string; arch: string } | null;
	status(): ManagedEnrollmentStatus;
	policyStatus(): ManagedPolicyStatus;
	events: Pick<LifecycleProjector, 'recent' | 'gaps' | 'nextSequence' | 'recordInventory'>;
	/** The attached journal's status; null while none is attached. */
	journal(): EventJournalStatus | null;
	telemetry(): TelemetryClientStatus | null;
	content(): { standing: ContentCollectionStanding; capture: ContentCaptureStatus } | null;
	/** Unsettled process sessions the usage producer tracks; null when no producer is wired (a named gap, never a zero). */
	usage(): number | null;
	/** Which providers to inventory. Default: every pickable provider. */
	providers?: readonly string[];
	installed(agentId: string): ProviderInstallation;
	contractsPin(): ContractsPinStatus;
	harness?(): HarnessRouteSupport;
	now?: () => number;
}

/** Status reads with their free text taken out: a transport message or a write failure can name a path. */
export interface JournalHealth {
	attached: boolean;
	journalId: string | null;
	nextSequence: number | null;
	entries: number;
	delivery: EventJournalStatus['delivery'] | null;
	held: number;
	gaps: number;
	counters: EventJournalStatus['counters'] | null;
	writeFailureAt: string | null;
}

export interface TelemetryHealth {
	running: boolean;
	hold: { reason: string; since: string } | null;
	nextPassAt: string | null;
	consecutiveFailures: number;
	lastPass: Omit<NonNullable<TelemetryClientStatus['lastPass']>, 'reason'> | null;
	counters: TelemetryClientStatus['counters'];
}

export interface InstallationInventory {
	at: string;
	installation: ManagedInstallationIdentity;
	device: InventoryFact['device'];
	versions: {
		app: string;
		library: string;
		contract: string;
		endpointProtocol: number;
		pluginHostApi: string;
		contracts: ContractsPinStatus;
	};
	endpoint: {
		authority: ManagedEnrollmentStatus['authority'];
		reason: string | null;
		connection: {
			connection: number;
			attached: boolean;
			registration: string;
			closed: boolean;
		} | null;
		status: Pick<
			EndpointStatus,
			| 'protocol'
			| 'management'
			| 'connectivity'
			| 'capabilities'
			| 'collectionProfile'
			| 'desiredPolicyRevision'
			| 'appliedPolicyRevision'
		> | null;
		lastDenial: ManagedEnrollmentStatus['lastDenial'];
		pendingApproval: boolean;
	};
	identity: {
		custody: ManagedIdentityView['status'];
		management: ManagedIdentityManagement | null;
		tenantId: string | null;
		orgId: string | null;
		enrollmentId: string | null;
		registeredActor: boolean;
	};
	policy: ManagedPolicyStatus;
	providers: readonly InventoryProvider[];
	harness: HarnessRouteSupport;
	subagents: InventoryFact['subagents'];
	collection: {
		projector: { nextSequence: number; window: number; gaps: { dropped: number; refused: number } };
		journal: JournalHealth;
		telemetry: TelemetryHealth | null;
		content: { standing: ContentCollectionStanding; capture: ContentCaptureStatus } | null;
		usage: { tracked: number } | null;
		vibes: typeof VIBES_CAPABILITY.status;
		delivery: typeof INVENTORY_DELIVERY;
	};
	completeness: InventoryFact['completeness'];
	gaps: readonly string[];
}

export interface InstallationInventoryService {
	snapshot(): InstallationInventory;
	fact(): InventoryFact;
	/** Project the inventory as an `inventory` event: one per distinct inventory, the journal dedups the rest. */
	record(): readonly ManagedInventoryEvent[];
}

const PROVIDER_INTERNAL_GAP =
	'subagents: a provider-internal subagent (its own task tool) is not observed by the lifecycle producers of this build; reported unavailable, never zero';
const RUNTIMES_GAP =
	'runtimes: only this process is inventoried; another host on this installation (a maestro-cli host, a TUI) is not observed from here';

function journalHealthOf(status: EventJournalStatus | null): JournalHealth {
	if (!status) {
		return {
			attached: false,
			journalId: null,
			nextSequence: null,
			entries: 0,
			delivery: null,
			held: 0,
			gaps: 0,
			counters: null,
			writeFailureAt: null,
		};
	}
	return {
		attached: true,
		journalId: status.journalId,
		nextSequence: status.nextSequence,
		entries: status.entries,
		delivery: { ...status.delivery },
		held: status.held,
		gaps: status.gaps.length,
		counters: { ...status.counters },
		writeFailureAt: status.writeFailure?.at ?? null,
	};
}

function telemetryHealthOf(status: TelemetryClientStatus | null): TelemetryHealth | null {
	if (!status) return null;
	const last = status.lastPass;
	return {
		running: status.running,
		hold: status.hold ? { reason: status.hold.reason, since: status.hold.since } : null,
		nextPassAt: status.nextPassAt,
		consecutiveFailures: status.consecutiveFailures,
		lastPass: last
			? {
					at: last.at,
					outcome: last.outcome,
					taken: last.taken,
					received: last.received,
					duplicates: last.duplicates,
					uncertain: last.uncertain,
					unavailable: last.unavailable,
					withheld: { ...last.withheld },
					denial: last.denial,
				}
			: null,
		counters: { ...status.counters, denied: { ...status.counters.denied } },
	};
}

/** What the window saw of managed delegation: distinct child runs whose parent is named. The window's loss is a gap beside it, not a smaller count. */
function managedSubagentsOf(
	events: Pick<LifecycleProjector, 'recent'>
): Extract<InventoryObservation, { state: 'observed' }> {
	const children = new Set<string>();
	for (const event of events.recent()) {
		if (event.kind === 'run-state' && event.run?.parentRunId) children.add(event.run.runId);
	}
	return { state: 'observed', count: children.size };
}

function providersOf(
	ids: readonly string[],
	installed: InventoryDeps['installed']
): { providers: InventoryProvider[]; unprobed: string[] } {
	const unprobed: string[] = [];
	const providers = ids.map((agentId): InventoryProvider => {
		const installation = installed(agentId);
		if (installation.state === 'unknown') unprobed.push(agentId);
		const routes = Object.fromEntries(
			providerRouteSupport(agentId).map((support) => [
				support.route,
				{ standalone: support.standalone, managed: support.managed },
			])
		) as InventoryProvider['routes'];
		for (const route of MANAGED_ROUTES) {
			if (!routes[route]) throw new Error(`providerRouteSupport named no ${route} route`);
		}
		return { agentId, installed: installation.state, version: installation.version, routes };
	});
	return { providers, unprobed };
}

export function createInstallationInventory(deps: InventoryDeps): InstallationInventoryService {
	const now = deps.now ?? (() => Date.now());
	const providerIds = deps.providers ?? PICKABLE_AGENT_IDS;
	const harness = deps.harness ?? (() => syntheticHarnessRouteSupport());

	function snapshot(): InstallationInventory {
		const at = now();
		const standing = deps.status();
		const record = standing.identity.status === 'ok' ? standing.identity.record : null;
		const live = standing.connection?.attached ? standing.endpoint : null;
		const policy = deps.policyStatus();
		const contracts = deps.contractsPin();
		const { providers, unprobed } = providersOf(providerIds, deps.installed);
		const projectorGaps = deps.events.gaps();
		const journal = journalHealthOf(deps.journal());
		const telemetry = telemetryHealthOf(deps.telemetry());
		const content = deps.content();
		const tracked = deps.usage();

		const gaps: string[] = [RUNTIMES_GAP, PROVIDER_INTERNAL_GAP];
		if (contracts.status !== 'pinned') gaps.push(`contracts: ${contracts.reason}`);
		if (unprobed.length > 0) {
			gaps.push(
				`providers: no probe has answered for ${unprobed.join(', ')}; installation unknown`
			);
		}
		if (projectorGaps.dropped > 0) {
			gaps.push(
				`events: ${projectorGaps.dropped} event(s) left the projector window; the subagent count covers the window only`
			);
		}
		if (!journal.attached) gaps.push('events: no durable journal is attached in this process');
		if (!telemetry) gaps.push('telemetry: no client is composed in this process');
		if (!content) gaps.push('content: no collection source is composed in this process');
		if (tracked === null) gaps.push('usage: no producer is wired to the projector in this process');

		return {
			at: new Date(at).toISOString(),
			installation: { ...deps.installation },
			device: {
				deviceId: record?.enrollmentId ?? null,
				hostname: deps.hostname,
				os: deps.os ? `${deps.os.platform} ${deps.os.release} ${deps.os.arch}`.slice(0, 128) : null,
			},
			versions: {
				app: deps.appVersion,
				library: MAESTRO_LIB_VERSION,
				contract: MANAGED_CONTRACT_VERSION,
				endpointProtocol: LOCAL_ENDPOINT_PROTOCOL,
				pluginHostApi: HOST_API_VERSION,
				contracts,
			},
			endpoint: {
				authority: standing.authority,
				reason: standing.reason,
				connection: standing.connection
					? {
							connection: standing.connection.connection,
							attached: standing.connection.attached,
							registration: standing.connection.registration,
							closed: standing.connection.closed,
						}
					: null,
				status: live
					? {
							protocol: live.protocol,
							management: live.management,
							connectivity: live.connectivity,
							capabilities: [...live.capabilities],
							collectionProfile: live.collectionProfile,
							desiredPolicyRevision: live.desiredPolicyRevision,
							appliedPolicyRevision: live.appliedPolicyRevision,
						}
					: null,
				lastDenial: standing.lastDenial ? { ...standing.lastDenial } : null,
				pendingApproval: standing.pendingApproval !== null,
			},
			identity: {
				custody: standing.identity.status,
				management: record?.management ?? null,
				tenantId: record?.tenantId ?? null,
				orgId: record?.orgId ?? null,
				enrollmentId: record?.enrollmentId ?? null,
				registeredActor: record?.registration?.actorId != null,
			},
			policy,
			providers,
			harness: harness(),
			subagents: {
				managed: managedSubagentsOf(deps.events),
				providerInternal: { state: 'unavailable', count: null },
			},
			collection: {
				projector: {
					nextSequence: deps.events.nextSequence(),
					window: deps.events.recent().length,
					gaps: { ...projectorGaps },
				},
				journal,
				telemetry,
				content,
				usage: tracked === null ? null : { tracked },
				vibes: VIBES_CAPABILITY.status,
				delivery: INVENTORY_DELIVERY,
			},
			completeness: 'partial',
			gaps,
		};
	}

	function factOf(inventory: InstallationInventory): InventoryFact {
		return {
			at: Date.parse(inventory.at),
			device: { ...inventory.device },
			runtimes: [
				{
					runtimeId: deps.installation.runtimeId,
					processEpoch: deps.installation.processEpoch,
					components: deps.components.map((c) => ({ id: c.id, kind: c.kind, version: c.version })),
				},
			],
			providers: inventory.providers,
			subagents: inventory.subagents,
			policyRevision: inventory.policy.appliedRevision,
			completeness: inventory.completeness,
			gaps: inventory.gaps,
		};
	}

	return {
		snapshot,
		fact: () => factOf(snapshot()),
		record: () => deps.events.recordInventory(factOf(snapshot())),
	};
}
