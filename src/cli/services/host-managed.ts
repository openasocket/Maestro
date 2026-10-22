/**
 * The detached host's managed standing (MRC-08-04C): what `maestro-cli host start` composes so
 * that a real detached host attests its standing (`HostStatusReport.managed`) and admits as that
 * host, or the named reason it composes nothing.
 *
 * The desktop composes the same parts in `src/main/enterprise/service.ts`: the identity store
 * over the data directory's sealed record, the endpoint client over the socket that record names,
 * the enrollment lifecycle, and `createManagedHostAdapter` over all three. What differs here is
 * custody. The desktop seals with Electron's `safeStorage` (a key the OS credential store holds
 * for the app) and anchors with the OS keyring. A plain Node process has the anchor primitive
 * (`createKeyringAnchor`, when `@napi-rs/keyring` loads) and NO seal: nothing off Electron holds
 * that key, and `obscuringSeal()` is a built-in key, not credential protection. So the production
 * custody (`resolveHostCustody` with no seal injected) is refused by name, the host composes
 * nothing, and `host status` says so in `managedUnavailable`. An enrolled data directory then runs
 * enrolled-unavailable exactly as before: its managed operations answer `unavailable`, never
 * standalone, and nothing here invents a session-only standing.
 *
 * The composition itself is complete and tested over injected custody (`custody`), so the day a
 * protected seal exists off Electron it is one argument, not a new module. Tests inject fakes;
 * nothing here touches the developer's keyring unless a protected seal was handed in first.
 */

import * as fs from 'fs';
import * as path from 'path';

import { createLocalEndpointClient } from '../../main/enterprise/endpoint-client';
import {
	createEnrollmentLifecycle,
	type EnrollmentLifecycle,
} from '../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type EnterpriseIdentityStore,
} from '../../main/enterprise/identity-store';
import { ENTERPRISE_SUPPORTED_CAPABILITIES } from '../../main/enterprise/service';
import {
	anchorAccountForDirectory,
	createKeyringAnchor,
	type AnchorStore,
} from '../../main/utils/keyring-anchor';
import { sealProtectionProblem, type SealProvider } from '../../main/utils/safe-storage-seal';
import {
	MAESTRO_LIB_VERSION,
	createManagedHostAdapter,
	type EndpointPort,
	type ManagedEnrollmentStatus,
	type ManagedInstallationIdentity,
	type MaestroRuntimeOptions,
} from '../../shared/maestro-lib';

/**
 * The custody primitive a detached host is missing. Named here once so the start log, the status
 * line and the verification matrix all say the same thing.
 */
export const HOST_SEAL_UNAVAILABLE_REASON =
	'no protected seal exists in a plain Node process: the enrollment record is sealed with the key ' +
	'Electron safeStorage keeps in the OS credential store for the desktop app, and only the desktop ' +
	'process can use it (the obscuring seal is a built-in key, not credential protection)';

export const HOST_ANCHOR_UNAVAILABLE_REASON =
	'no OS credential store holds the freshness anchor (@napi-rs/keyring did not load, or there is no ' +
	'credential store), so a rollback could not be told from the newest record';

export interface HostCustodyInput {
	userDataDir: string;
	/** The seal this process holds for the record, when it holds one. A plain Node process holds none. */
	seal?: SealProvider | null;
	/** Default: the keyring anchor for this data directory, consulted only once a seal is protected. */
	anchor?: AnchorStore;
	platform?: NodeJS.Platform;
}

export type HostCustodyRead =
	| { ok: true; seal: SealProvider; anchor: AnchorStore }
	| { ok: false; reason: string };

/**
 * Whether this process holds protected custody for the enterprise identity record, by the same
 * rule the identity store applies (`sealProtectionProblem`, then the anchor): a protected seal
 * first, so the keyring is never consulted for a host that cannot open the record anyway.
 */
export function resolveHostCustody(input: HostCustodyInput): HostCustodyRead {
	const seal = input.seal ?? null;
	if (!seal) return { ok: false, reason: HOST_SEAL_UNAVAILABLE_REASON };
	const problem = sealProtectionProblem(seal, input.platform);
	if (problem !== null)
		return { ok: false, reason: `the seal is not protected custody: ${problem}` };
	const anchor =
		input.anchor ??
		createKeyringAnchor(
			ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
			anchorAccountForDirectory('enterprise-identity', input.userDataDir)
		);
	if (!anchor.available()) return { ok: false, reason: HOST_ANCHOR_UNAVAILABLE_REASON };
	return { ok: true, seal, anchor };
}

export interface HostManagedDeps {
	userDataDir: string;
	/** The build version, the `maestro` component the endpoint negotiates against. */
	version: string;
	/** Default: `resolveHostCustody` over the data directory with no seal, which is refused by name. */
	custody?: HostCustodyRead;
	/** Test seam: how a port is opened for the record's socket path. Default: the real client. */
	openPort?(socketPath: string): EndpointPort;
	platform?: NodeJS.Platform;
	now?: () => number;
}

/** What the running host does with its standing: re-attach once it holds the directory, close on stop. */
export interface HostManagedLifecycle {
	/** Re-attach a previously enrolled installation. Never throws; the outcome is in `status()`. */
	attach(): Promise<void>;
	close(): Promise<void>;
}

export type HostManagedComposition =
	| {
			composed: true;
			/** `createMaestroRuntime`'s `managed`: the host adapter factory over this custody. */
			managed: NonNullable<MaestroRuntimeOptions['managed']>;
			lifecycle: HostManagedLifecycle;
			identity: EnterpriseIdentityStore;
			/** The enrollment lifecycle's standing; null until the runtime has asked for its adapter. */
			status(): ManagedEnrollmentStatus | null;
	  }
	| { composed: false; reason: string };

function recordFileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Compose the detached host's managed standing over the data directory's sealed record, or name
 * why none is composed. The adapter is built for the installation the runtime computes (the
 * factory receives it once the lock is held), so the lifecycle registers as that runtime.
 */
export function composeHostManaged(deps: HostManagedDeps): HostManagedComposition {
	const now = deps.now ?? (() => Date.now());
	const file = path.join(deps.userDataDir, ENTERPRISE_IDENTITY_FILE_NAME);
	const custody =
		deps.custody ??
		resolveHostCustody({
			userDataDir: deps.userDataDir,
			...(deps.platform ? { platform: deps.platform } : {}),
		});
	if (!custody.ok) {
		const record = recordFileExists(file)
			? `An enrollment record is present at ${file} and cannot be opened here, so this host runs enrolled-unavailable.`
			: `No enrollment record is present at ${file}.`;
		return { composed: false, reason: `${custody.reason}. ${record}` };
	}

	const identity = createEnterpriseIdentityStore({
		file,
		seal: custody.seal,
		anchor: custody.anchor,
		...(deps.platform ? { platform: deps.platform } : {}),
		now,
	});
	const openPort =
		deps.openPort ?? ((socketPath: string) => createLocalEndpointClient({ socketPath }));
	// The socket the lifecycle opened last, so the adapter speaks over the same connection.
	let port: EndpointPort | null = null;
	let lifecycle: EnrollmentLifecycle | null = null;

	const host = (installation: ManagedInstallationIdentity) => {
		const standing = createEnrollmentLifecycle({
			identity,
			openPort: (socketPath) => {
				port = openPort(socketPath);
				return port;
			},
			installation,
			components: [
				{ id: 'maestro', kind: 'maestro', version: deps.version },
				{ id: 'maestro-lib', kind: 'runtime', version: MAESTRO_LIB_VERSION },
			],
			capabilities: { supported: ENTERPRISE_SUPPORTED_CAPABILITIES, required: [] },
			now,
		});
		lifecycle = standing;
		return createManagedHostAdapter({
			installation,
			identity: { read: () => standing.status().identity },
			get endpoint() {
				return port;
			},
			status: () => standing.status(),
			now,
		});
	};

	return {
		composed: true,
		managed: { host },
		identity,
		status: () => lifecycle?.status() ?? null,
		lifecycle: {
			async attach() {
				// No sealed record, no dial: an unenrolled host never opens a socket here.
				if (!lifecycle || identity.read().status !== 'ok') return;
				await lifecycle.connect();
			},
			close: async () => {
				await lifecycle?.close();
			},
		},
	};
}
