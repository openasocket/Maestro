/**
 * The fleet inventory of this installation (MRC-10-06A): read off the seams
 * that exist, every gap named, nothing probed, no path or message in the
 * fleet-facing fact, an unobserved count never a zero, and one event per
 * distinct inventory through the real projector.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
	createInstallationInventory,
	INVENTORY_DELIVERY,
	readContractsPin,
	type InventoryDeps,
	type ProviderInstallation,
} from '../../../main/enterprise/inventory';
import type { EventJournalStatus } from '../../../shared/maestro-lib/managed/event-journal';
import type {
	EndpointStatus,
	ManagedEnrollmentStatus,
	ManagedIdentityRecord,
} from '../../../shared/maestro-lib/managed/endpoint-port';
import {
	createLifecycleProjector,
	type LifecycleFact,
	type LifecycleProjector,
} from '../../../shared/maestro-lib/managed/events';
import { projectPolicyStatus } from '../../../shared/maestro-lib/managed/host-adapter';
import { MANAGED_CONTRACT_VERSION } from '../../../shared/maestro-lib/managed/types';
import { MAESTRO_LIB_VERSION } from '../../../shared/maestro-lib/version';
import { HOST_API_VERSION } from '../../../shared/plugins/host-api';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const INSTALLATION = {
	installationId: 'inst-1',
	runtimeId: 'desktop-4242',
	processEpoch: 'epoch-1',
};
const COMPONENTS = [
	{ id: 'maestro', kind: 'maestro' as const, version: '1.1.0-RC' },
	{ id: 'maestro-lib', kind: 'runtime' as const, version: MAESTRO_LIB_VERSION },
];
const SOCKET = '/private/run/mega-maestro/endpoint.sock';

const standalone = (): ManagedEnrollmentStatus => ({
	identity: { status: 'none', reason: null, message: null, record: null },
	connection: null,
	endpoint: null,
	authority: 'none',
	reason: 'This installation holds no enrollment.',
	pendingApproval: null,
	lastDenial: null,
});

const record = (): ManagedIdentityRecord => ({
	version: 1,
	installationId: 'inst-1',
	tenantId: 'tenant-1',
	orgId: 'org-1',
	enrollmentId: 'enr-1',
	endpoint: { socketPath: SOCKET, bindingDigest: 'a'.repeat(64), trustRootDigest: null },
	management: 'enrolled',
	registration: {
		challengeId: 'ch-1',
		actorId: 'alice',
		runtimeId: 'desktop-4242',
		processEpoch: 'epoch-1',
		bindingDigest: 'a'.repeat(64),
		processBirthDigest: null,
		challengeDigest: 'b'.repeat(64),
		expiresAt: '2026-10-23T12:00:00.000Z',
		registeredAt: '2026-10-22T11:00:00.000Z',
	},
	policy: { desiredRevision: 3, appliedRevision: 3, observedAt: '2026-10-22T11:59:00.000Z' },
	enrolledAt: '2026-10-22T11:00:00.000Z',
	updatedAt: '2026-10-22T11:59:00.000Z',
});

const live = (): EndpointStatus => ({
	outcome: 'attached',
	protocol: 1,
	capabilities: ['execution', 'telemetry'],
	management: 'managed',
	desiredPolicyRevision: 3,
	appliedPolicyRevision: 3,
	connectivity: 'online',
	collectionProfile: 'metadata',
});

const registered = (): ManagedEnrollmentStatus => ({
	identity: { status: 'ok', reason: null, message: null, record: record() },
	connection: {
		connection: 2,
		attached: true,
		status: live(),
		registration: 'registered',
		closed: false,
	},
	endpoint: live(),
	authority: 'registered',
	reason: null,
	pendingApproval: null,
	lastDenial: {
		at: '2026-10-22T11:58:00.000Z',
		operation: 'attachment',
		reason: 'unauthenticated',
	},
});

const journalStatus = (): EventJournalStatus => ({
	journalId: 'journal-1',
	nextSequence: 12,
	entries: 4,
	delivery: { pending: 2, uncertain: 1, received: 1 },
	held: 1,
	gaps: [
		{
			kind: 'restart',
			at: '2026-10-22T11:00:00.000Z',
			afterSequence: 7,
			count: null,
			detail: null,
		},
	],
	counters: {
		recorded: 11,
		duplicates: 2,
		refused: 0,
		received: 1,
		trimmed: 0,
		trimmedUnreceived: 0,
		gapsForgotten: 0,
	},
	writeFailure: { at: '2026-10-22T11:30:00.000Z', message: `EACCES: ${SOCKET}.json` },
});

const fact = (overrides: Partial<LifecycleFact>): LifecycleFact => ({
	surface: 'agent',
	state: 'running',
	at: NOW,
	sessionId: 'agent-1-ai-tab-1',
	agentId: 'agent-1',
	tabId: 'tab-1',
	provider: 'claude-code',
	model: null,
	providerSessionId: null,
	runId: 'run-1',
	record: 'ledger',
	ledgerStatus: 'running',
	exitCode: null,
	durationMs: null,
	detail: null,
	...overrides,
});

function projector(capacity?: number): LifecycleProjector {
	return createLifecycleProjector({
		installation: INSTALLATION,
		origin: 'desktop',
		actor: () => ({ kind: 'human', id: 'operator:inst-1' }),
		policyRevision: () => 3,
		...(capacity ? { capacity } : {}),
	});
}

function deps(
	overrides: Partial<InventoryDeps> = {},
	installed: Record<string, ProviderInstallation> = {}
): InventoryDeps {
	const status = overrides.status ?? standalone;
	return {
		installation: INSTALLATION,
		appVersion: '1.1.0-RC',
		components: COMPONENTS,
		hostname: 'box',
		os: { platform: 'darwin', release: '25.0.0', arch: 'arm64' },
		status,
		policyStatus: () => projectPolicyStatus({ standing: status(), now: NOW }),
		events: projector(),
		journal: () => null,
		telemetry: () => null,
		content: () => null,
		usage: () => null,
		providers: ['claude-code', 'codex'],
		installed: (agentId) => installed[agentId] ?? { state: 'unknown', version: null },
		contractsPin: () => ({ status: 'absent', reason: 'no pin (CP-01, owner mega-maestro)' }),
		harness: () => ({
			agentId: 'synthetic-harness',
			route: 'child-process',
			routeId: 'synthetic-harness/node-permission-v1',
			standalone: 'implemented',
			managed: 'implemented',
			note: 'test double of the harness route',
			enforcement: {
				files: 'declared inputs',
				network: 'denied',
				descendants: 'denied',
				environment: 'PATH and HOME',
				enforcedBy: 'node-permission-model',
			},
			qualifies: 'exactly this',
			doesNotQualify: 'any real provider',
		}),
		now: () => NOW,
		...overrides,
	};
}

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('installation inventory (MRC-10-06A)', () => {
	it('reports a standalone desktop: versions, detection apart from enforcement, nothing observed as a zero, every gap named', () => {
		const inventory = createInstallationInventory(
			deps({}, { 'claude-code': { state: 'detected', version: '2.0.1' } })
		).snapshot();
		expect(inventory.versions).toEqual({
			app: '1.1.0-RC',
			library: MAESTRO_LIB_VERSION,
			contract: MANAGED_CONTRACT_VERSION,
			endpointProtocol: 1,
			pluginHostApi: HOST_API_VERSION,
			contracts: { status: 'absent', reason: 'no pin (CP-01, owner mega-maestro)' },
		});
		expect(inventory.device).toEqual({
			deviceId: null,
			hostname: 'box',
			os: 'darwin 25.0.0 arm64',
		});
		expect(inventory.endpoint).toEqual({
			authority: 'none',
			reason: 'This installation holds no enrollment.',
			connection: null,
			status: null,
			lastDenial: null,
			pendingApproval: false,
		});
		expect(inventory.identity).toEqual({
			custody: 'none',
			management: null,
			tenantId: null,
			orgId: null,
			enrollmentId: null,
			registeredActor: false,
		});
		expect(inventory.policy).toMatchObject({ source: 'none', admission: { possible: false } });
		// A detected binary is a detection; the route words come from the build's own table.
		const claude = inventory.providers.find((p) => p.agentId === 'claude-code');
		expect(claude).toMatchObject({ installed: 'detected', version: '2.0.1' });
		expect(claude?.routes['child-process']).toEqual({
			standalone: 'implemented',
			managed: 'implemented',
		});
		expect(claude?.routes.pty.managed).toBe('unsupported');
		expect(claude?.routes.ssh).toEqual({ standalone: 'unverified', managed: 'unsupported' });
		expect(inventory.providers.find((p) => p.agentId === 'codex')).toMatchObject({
			installed: 'unknown',
			version: null,
		});
		expect(inventory.harness.routeId).toBe('synthetic-harness/node-permission-v1');
		expect(inventory.subagents).toEqual({
			managed: { state: 'observed', count: 0 },
			providerInternal: { state: 'unavailable', count: null },
		});
		expect(inventory.collection).toMatchObject({
			projector: { nextSequence: 1, window: 0, gaps: { dropped: 0, refused: 0 } },
			journal: { attached: false, journalId: null, entries: 0 },
			telemetry: null,
			content: null,
			usage: null,
			vibes: 'unsupported',
			delivery: INVENTORY_DELIVERY,
		});
		expect(inventory.completeness).toBe('partial');
		expect(inventory.gaps.map((gap) => gap.split(':')[0])).toEqual([
			'runtimes',
			'subagents',
			'contracts',
			'providers',
			'events',
			'telemetry',
			'content',
			'usage',
		]);
		expect(inventory.gaps.find((gap) => gap.startsWith('providers'))).toContain('codex');
		expect(inventory.gaps.find((gap) => gap.startsWith('usage'))).toContain('no producer is wired');
	});

	it('reports a registered standing: the enrollment id as the device, the live status and the record without a path, the window counts and the stripped health', () => {
		const events = projector(2);
		events.record(fact({ runId: 'run-parent' }));
		events.record(
			fact({
				runId: 'run-child',
				sessionId: 'agent-2-ai-tab-1',
				lineage: {
					identity: {
						requestId: 'req-c',
						idempotencyKey: 'key-c',
						attemptId: 'att-c',
						runId: 'run-child',
						rootRunId: 'run-parent',
						parentRunId: 'run-parent',
					},
					traceId: 'trace-c',
					workflow: null,
					delegation: { chain: [], grantRef: null },
				},
			})
		);
		events.record(fact({ runId: 'run-child', state: 'completed', lineage: undefined }));
		const inventory = createInstallationInventory(
			deps({
				status: registered,
				events,
				journal: journalStatus,
				telemetry: () => ({
					running: true,
					passInFlight: false,
					hold: {
						reason: 'policy_denied',
						since: '2026-10-22T11:59:30.000Z',
						detail: `refused over ${SOCKET}`,
						standingKey: 'k',
					},
					nextPassAt: null,
					consecutiveFailures: 2,
					lastPass: {
						at: '2026-10-22T11:59:30.000Z',
						outcome: 'held',
						reason: `refused over ${SOCKET}`,
						taken: 0,
						received: 0,
						duplicates: 0,
						uncertain: 0,
						unavailable: 0,
						withheld: {
							'other-installation': 0,
							'other-boot': 1,
							'event-id': 0,
							sequence: 0,
							'occurred-at': 0,
						},
						denial: 'policy_denied',
					},
					counters: {
						passes: 3,
						taken: 2,
						received: 1,
						duplicates: 0,
						uncertain: 1,
						unavailable: 0,
						denied: { policy_denied: 1 },
					},
				}),
				content: () => ({
					standing: {
						mode: 'managed',
						ok: false,
						reason: 'metadata profile',
						profile: 'metadata',
						policyRevision: 3,
					},
					capture: {
						records: 0,
						held: { count: 0, bytes: 0 },
						forgotten: 0,
						shed: 0,
						revoked: 0,
						notCollected: 0,
						byRole: {},
						delivery: { available: false, reason: 'CP-01' },
					},
				}),
				usage: () => 2,
			})
		).snapshot();
		expect(inventory.device.deviceId).toBe('enr-1');
		expect(inventory.endpoint).toMatchObject({
			authority: 'registered',
			reason: null,
			connection: { connection: 2, attached: true, registration: 'registered', closed: false },
			status: { management: 'managed', connectivity: 'online', collectionProfile: 'metadata' },
			lastDenial: { operation: 'attachment', reason: 'unauthenticated' },
		});
		expect(inventory.identity).toEqual({
			custody: 'ok',
			management: 'enrolled',
			tenantId: 'tenant-1',
			orgId: 'org-1',
			enrollmentId: 'enr-1',
			registeredActor: true,
		});
		expect(inventory.policy).toMatchObject({ source: 'endpoint', appliedRevision: 3 });
		// The one child whose parent is named counts once across its two states; the window's loss is a gap beside it.
		expect(inventory.subagents.managed).toEqual({ state: 'observed', count: 1 });
		expect(inventory.collection.projector).toEqual({
			nextSequence: 4,
			window: 2,
			gaps: { dropped: 1, refused: 0 },
		});
		expect(inventory.gaps.find((gap) => gap.startsWith('events'))).toContain(
			'1 event(s) left the projector window'
		);
		expect(inventory.collection.journal).toEqual({
			attached: true,
			journalId: 'journal-1',
			nextSequence: 12,
			entries: 4,
			delivery: { pending: 2, uncertain: 1, received: 1 },
			held: 1,
			gaps: 1,
			counters: journalStatus().counters,
			writeFailureAt: '2026-10-22T11:30:00.000Z',
		});
		expect(inventory.collection.telemetry).toMatchObject({
			running: true,
			hold: { reason: 'policy_denied', since: '2026-10-22T11:59:30.000Z' },
			lastPass: { outcome: 'held', denial: 'policy_denied', withheld: { 'other-boot': 1 } },
			counters: { denied: { policy_denied: 1 } },
		});
		expect(inventory.collection.usage).toEqual({ tracked: 2 });
		expect(inventory.collection.content?.standing).toMatchObject({ mode: 'managed', ok: false });
		expect(
			inventory.gaps.some((gap) => /journal|telemetry|content|usage/.test(gap.split(':')[0]))
		).toBe(false);
		// Free text that could name a path never reaches the inventory; the record's socket path never does.
		const text = JSON.stringify(inventory);
		expect(text).not.toContain(SOCKET);
		expect(text).not.toContain('EACCES');
		expect(text).not.toContain('refused over');
	});

	it('projects one inventory event per distinct inventory through the real projector, in the fleet vocabulary and nothing more', () => {
		const events = projector();
		const installed: Record<string, ProviderInstallation> = {};
		const inventory = createInstallationInventory(deps({ status: registered, events }, installed));
		const fleet = inventory.fact();
		expect(fleet).toMatchObject({
			at: NOW,
			device: { deviceId: 'enr-1', hostname: 'box', os: 'darwin 25.0.0 arm64' },
			runtimes: [{ runtimeId: 'desktop-4242', processEpoch: 'epoch-1', components: COMPONENTS }],
			subagents: {
				managed: { state: 'observed', count: 0 },
				providerInternal: { state: 'unavailable', count: null },
			},
			policyRevision: 3,
			completeness: 'partial',
		});
		expect(Object.keys(fleet).sort()).toEqual([
			'at',
			'completeness',
			'device',
			'gaps',
			'policyRevision',
			'providers',
			'runtimes',
			'subagents',
		]);
		const text = JSON.stringify(fleet);
		for (const canary of [SOCKET, 'tenant-1', 'org-1', 'alice', 'unauthenticated', 'endpoint']) {
			expect(text).not.toContain(canary);
		}
		const [first] = inventory.record();
		expect(first).toMatchObject({ kind: 'inventory', sequence: 1 });
		expect(first.source.surface).toBe('host');
		expect(inventory.record()[0].eventId).toBe(first.eventId);
		// A provider detected since is a different inventory, so a different event: the delta.
		installed.codex = { state: 'detected', version: '0.42.0' };
		const [changed] = inventory.record();
		expect(changed.eventId).not.toBe(first.eventId);
		expect(changed.inventory.providers.find((p) => p.agentId === 'codex')).toMatchObject({
			installed: 'detected',
			version: '0.42.0',
		});
		expect(events.recent().map((e) => e.kind)).toEqual(['inventory', 'inventory', 'inventory']);
		expect(events.gaps()).toEqual({ dropped: 0, refused: 0 });
	});

	it('reads the contracts pin: absent by name, pinned with its provenance, unreadable when it is not a pin', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-inventory-pin-'));
		dirs.push(dir);
		const file = path.join(dir, 'contracts.pin.json');
		expect(readContractsPin(file)).toMatchObject({ status: 'absent' });
		expect(JSON.stringify(readContractsPin(file))).not.toContain(dir);
		fs.writeFileSync(
			file,
			JSON.stringify({
				formatVersion: 1,
				name: '@mega-maestro/contracts',
				version: '0.9.0',
				sha256: 'c'.repeat(64),
				sourceRevision: 'd5143a6'.padEnd(40, '0'),
				sourceDirty: false,
				entries: [{ path: '/tmp/should-not-leak' }],
			})
		);
		expect(readContractsPin(file)).toEqual({
			status: 'pinned',
			name: '@mega-maestro/contracts',
			version: '0.9.0',
			sha256: 'c'.repeat(64),
			sourceRevision: 'd5143a6'.padEnd(40, '0'),
			sourceDirty: false,
		});
		fs.writeFileSync(file, JSON.stringify({ formatVersion: 2, sha256: 'c'.repeat(64) }));
		expect(readContractsPin(file)).toMatchObject({ status: 'unreadable' });
		fs.writeFileSync(file, '{not json');
		expect(readContractsPin(file)).toMatchObject({ status: 'unreadable' });
		expect(JSON.stringify(readContractsPin(file))).not.toContain(dir);
	});
});
