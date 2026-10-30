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
 * nothing here touches the developer's keyring unless a protected seal was handed in first, or
 * the installation standing is asked for and no record is present (below).
 *
 * The installation standing (MCOMP-09-04) is what this process can say of the installation
 * WITHOUT composing anything: `createHostInstallationStanding` reads the data directory's sealed
 * record (through the identity store when custody is protected; by its presence when it is not),
 * then, when no record is present, the freshness anchor the OS credential store holds for that
 * directory, and it reads the production directory the data directory maps to as well as the one
 * the caller named. The answer is the `InstallationStandingSource` the library binding holds its
 * mirror file to: a record held here in any form, or an anchor with its record gone, is managed;
 * only no record and no anchor, or a record the endpoint retired, is standalone. So a plain Node
 * process that cannot open the record still knows the installation is managed, an alternate data
 * directory under an enrolled installation is that installation, and deleting the binding file (or
 * the sealed record) by hand releases nothing.
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
	bindingEnrollment,
	createManagedHostAdapter,
	resolveProductionDataDir,
	type EndpointPort,
	type InstallationStanding,
	type InstallationStandingSource,
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
	/**
	 * The production data directory the caller resolved, read for the installation standing beside
	 * the one `userDataDir` maps to. It adds a directory to read; it never removes one.
	 */
	productionDataDir?: string;
	/** The build version, the `maestro` component the endpoint negotiates against. */
	version: string;
	/** Default: `resolveHostCustody` over the data directory with no seal, which is refused by name. */
	custody?: HostCustodyRead;
	/** Test seam: how a port is opened for the record's socket path. Default: the real client. */
	openPort?(socketPath: string): EndpointPort;
	/** Test seam for the installation standing: the anchor of a directory's record. Default: its keyring anchor. */
	anchorFor?(dir: string): AnchorStore;
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
			/** What this process can say of the installation, composed or not (`createHostInstallationStanding`). */
			standing: InstallationStandingSource;
	  }
	| { composed: false; reason: string; standing: InstallationStandingSource };

function recordFileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

export interface HostInstallationStandingInput {
	userDataDir: string;
	/** The production directory the caller named; read beside the one `userDataDir` maps to. */
	productionDataDir?: string;
	/**
	 * This process's custody for the record (`resolveHostCustody`). A refused custody still reads
	 * the standing: the record by its presence, then the anchor.
	 */
	custody: HostCustodyRead;
	/** The anchor of a directory's record, consulted when no record is present. Default: its keyring anchor. */
	anchorFor?(dir: string): AnchorStore;
	platform?: NodeJS.Platform;
	now?: () => number;
}

/**
 * The protected installation standing a detached host reads (MCOMP-09-04), as
 * `createManagedBinding({ standing })` consumes it: the sealed identity record and its freshness
 * anchor decide, in this data directory, in the production directory it maps to, and in the one
 * the caller named. Read on every `read()`; nothing is cached, so an enrollment that lands after
 * the start counts on the next call.
 *
 * Per directory: with protected custody the identity store reads the record, and `ok` is managed
 * with the enrollment the record implies (`bindingEnrollment`), except a `retired` record, which
 * is the authenticated release and reads standalone; `untrusted` (rolled back, foreign,
 * unsealable, malformed, anchor gone) is managed with no enrollment. Without protected custody a
 * present record is managed with no enrollment: it cannot be opened here, and that is not evidence
 * of standalone. With no record present in either case the anchor is read, and an anchor whose
 * record is gone is managed with no enrollment: the record was removed without the release. Only
 * no record and no anchor is standalone. The first directory that reads managed answers; when
 * none does, the own directory's standalone detail is the answer.
 *
 * The anchor read is a synchronous call into the OS credential store, made only when no record
 * is present; on a machine that never enrolled it finds no entry. Tests inject `anchorFor`.
 */
export function createHostInstallationStanding(
	input: HostInstallationStandingInput
): InstallationStandingSource {
	const now = input.now ?? (() => Date.now());
	const anchorFor =
		input.anchorFor ??
		((dir: string) =>
			createKeyringAnchor(
				ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
				anchorAccountForDirectory('enterprise-identity', dir)
			));
	const directories: string[] = [];
	for (const dir of [
		input.userDataDir,
		resolveProductionDataDir(input.userDataDir),
		...(input.productionDataDir ? [input.productionDataDir] : []),
	]) {
		const resolved = path.resolve(dir);
		if (!directories.includes(resolved)) directories.push(resolved);
	}

	const heldUnreadable = (detail: string): InstallationStanding => ({
		standing: 'managed',
		enrollment: null,
		management: null,
		detail,
	});

	function anchoredOrStandalone(file: string, anchor: AnchorStore): InstallationStanding {
		const held = anchor.available() ? anchor.read() : null;
		if (held) {
			return heldUnreadable(
				`No enrollment record is present at ${file}, and the credential store holds its freshness anchor (epoch ${held.epoch}): the record was removed without the authenticated release.`
			);
		}
		return {
			standing: 'standalone',
			detail: `No enrollment record is present at ${file}, and the credential store holds no anchor for it.`,
		};
	}

	function readDirectory(dir: string): InstallationStanding {
		const file = path.join(dir, ENTERPRISE_IDENTITY_FILE_NAME);
		const custody = input.custody;
		const own = path.resolve(input.userDataDir) === dir;
		const anchor = custody.ok && own ? custody.anchor : anchorFor(dir);
		if (!custody.ok) {
			if (recordFileExists(file)) {
				return heldUnreadable(
					`An enrollment record is present at ${file} and cannot be opened in this process (${custody.reason}).`
				);
			}
			return anchoredOrStandalone(file, anchor);
		}
		const read = createEnterpriseIdentityStore({
			file,
			seal: custody.seal,
			anchor,
			...(input.platform ? { platform: input.platform } : {}),
			now,
		}).read();
		switch (read.status) {
			case 'ok': {
				const { record } = read;
				const where = `${record.orgId} (${record.tenantId}) at ${record.endpoint.socketPath}`;
				if (record.management === 'retired') {
					return {
						standing: 'standalone',
						detail: `${file} holds a retired record for installation ${record.installationId}: released by ${where}.`,
					};
				}
				return {
					standing: 'managed',
					enrollment: { ...bindingEnrollment(record), enrolledAt: record.enrolledAt },
					management: record.management,
					detail: `${file} enrolls installation ${record.installationId} with ${where}; management is ${record.management}.`,
				};
			}
			case 'untrusted':
				return heldUnreadable(
					`An enrollment record is present at ${file} and is not trusted here (${read.reason}): ${read.message}`
				);
			case 'unprotected':
				return read.fileExists
					? heldUnreadable(
							`An enrollment record is present at ${file} and custody is not protected here (${read.reason}): ${read.message}`
						)
					: anchoredOrStandalone(file, anchor);
			case 'none':
				return anchoredOrStandalone(file, anchor);
		}
	}

	return {
		read() {
			let released: InstallationStanding | null = null;
			for (const dir of directories) {
				const standing = readDirectory(dir);
				if (standing.standing === 'managed') return standing;
				released ??= standing;
			}
			return released ?? { standing: 'standalone', detail: 'No data directory to read.' };
		},
	};
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
	// What this process says of the installation whether or not it composes an adapter: the
	// binding holds its mirror to it, so an enrollment this process cannot open still counts.
	const standing = createHostInstallationStanding({
		userDataDir: deps.userDataDir,
		...(deps.productionDataDir ? { productionDataDir: deps.productionDataDir } : {}),
		custody,
		...(deps.anchorFor ? { anchorFor: deps.anchorFor } : {}),
		...(deps.platform ? { platform: deps.platform } : {}),
		now,
	});
	if (!custody.ok) {
		const record = recordFileExists(file)
			? `An enrollment record is present at ${file} and cannot be opened here, so this host runs enrolled-unavailable.`
			: `No enrollment record is present at ${file}.`;
		return { composed: false, reason: `${custody.reason}. ${record}`, standing };
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
		standing,
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
