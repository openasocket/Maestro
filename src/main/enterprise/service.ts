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
import type { EndpointComponent } from '../../shared/maestro-lib/managed/endpoint-port';
import {
	createManagedHostAdapter,
	installationIdentity,
	type ManagedHostAdapter,
} from '../../shared/maestro-lib/managed/host-adapter';
import type { ManagedInstallationIdentity } from '../../shared/maestro-lib/managed/types';
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
import { createProcessSpawnAuthority } from './spawn-authority';
import type { ProcessSpawnAuthorityPort } from '../process-manager/types';

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
	let port: ReturnType<typeof createLocalEndpointClient> | null = null;
	const lifecycle = createEnrollmentLifecycle({
		identity,
		openPort:
			deps.openPort ??
			((socketPath) => {
				port = createLocalEndpointClient({ socketPath });
				return port;
			}),
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

	const spawnAuthority = createProcessSpawnAuthority({
		installation,
		identity,
		host,
		dispatch,
		now,
	});

	return {
		installation,
		identity,
		lifecycle,
		policy,
		host,
		dispatch,
		spawnAuthority,
		async start() {
			// The ledger is read first: a lease still bound at the last exit is unknown from here on.
			await dispatch.load();
			// No sealed file, no custody read: an unenrolled desktop never touches the keyring here.
			if (identity.read().status !== 'ok') return;
			await lifecycle.connect();
		},
		close: () => lifecycle.close(),
	};
}
