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
 * custody (`resolveHostCustody` with no seal injected) is refused by name, the host composes no
 * lifecycle, and `host status` says so in `managedUnavailable`. An enrolled data directory then runs
 * enrolled-unavailable: when a sealed record is present the runtime is still handed a host adapter,
 * the held one (`createHeldHostAdapter`, MCOMP-09-03), whose every admission answers `unavailable`
 * by name, so plain Node never falls back to no adapter over a sealed enrollment, and nothing here
 * invents a session-only standing, copies the desktop's key or installs a shared one.
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

import {
	createCommandService,
	type CommandService,
	type CommandStatusInventory,
} from '../../main/enterprise/commands';
import { createPlatformEndpointClient } from '../../main/enterprise/endpoint-client';
import {
	createEnrollmentLifecycle,
	type EnrollmentLifecycle,
	type LifecycleOutcome,
} from '../../main/enterprise/enrollment';
import {
	createEnterpriseIdentityStore,
	ENTERPRISE_IDENTITY_ANCHOR_SERVICE,
	ENTERPRISE_IDENTITY_FILE_NAME,
	type EnterpriseIdentityStore,
} from '../../main/enterprise/identity-store';
import {
	createInboxClient,
	createInboxReceiptLedger,
	MANAGED_INBOX_RECEIPTS_FILE_NAME,
	type InboxClient,
} from '../../main/enterprise/inbox';
import { createPolicyStatusService } from '../../main/enterprise/policy-status';
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
	type ManagedHostAdapter,
	type ManagedIdentityView,
	type ManagedInstallationIdentity,
	type MaestroRuntimeOptions,
} from '../../shared/maestro-lib';
import { MANAGED_COMMAND_LEDGER_FILE_NAME } from '../../shared/maestro-lib/managed/commands';
import {
	LOCAL_ENDPOINT_PROTOCOL,
	type EndpointNativePort,
} from '../../shared/maestro-lib/managed/endpoint-port';
import { MANAGED_CONTRACT_VERSION } from '../../shared/maestro-lib/managed/types';

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

/**
 * What a detached host's status report cannot say (MCOMP-21-03B), each by name, never as a zero:
 * the desktop reports from its installation inventory and its broker dispatch receipts; the
 * headless runtime admits through its own host authority and keeps neither, so these facts are
 * absent here and the report says which.
 */
export const HOST_COMMAND_REPORT_GAPS: readonly string[] = [
	'runtimes: only this detached host is inventoried; the desktop or another host on this installation is not observed from here',
	'contracts: the detached host does not read the Mega-Maestro contracts pin',
	'providers: the detached host probes no provider installation; none is reported',
	'subagents: the detached host projects no subagent inventory; none is reported',
	'receipts: the detached host keeps no dispatch receipts ledger; a run with no live lease reads unknown here and the receipt count is null',
];

/** The endpoint communications a composed host holds (MCOMP-21-03A). */
export interface HostCommunications {
	/**
	 * The notice inbox over the host adapter, its receipt ledger in the data directory. Null until
	 * the runtime has acquired the adapter, and after close.
	 */
	inbox(): InboxClient | null;
	/**
	 * The typed command service over the runtime's own work (MCOMP-21-03B): cancel revokes the
	 * leases this host's authority admitted, refresh re-attaches through the same lifecycle, report
	 * names the facts this host holds. Null until the runtime has acquired the adapter, and after close.
	 */
	commands(): CommandService | null;
}

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
	/**
	 * Host-injected NATIVE-ENDPOINT/1 port for the default client. None is installed,
	 * so a macOS or Windows host refuses to open the endpoint by name; Linux needs none.
	 */
	endpointNative?: EndpointNativePort;
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

/** Host-owned controls. Approval still happens at the endpoint, never in this process. */
export type HostEnrollmentControl = Pick<
	EnrollmentLifecycle,
	'requestEnrollment' | 'connect' | 'beginRegistration' | 'completeRegistration'
>;

export type HostManagedComposition =
	| {
			composed: true;
			/** `createMaestroRuntime`'s `managed`: the host adapter factory over this custody. */
			managed: NonNullable<MaestroRuntimeOptions['managed']>;
			lifecycle: HostManagedLifecycle;
			control: HostEnrollmentControl;
			identity: EnterpriseIdentityStore;
			/** The enrollment lifecycle's standing; null until the runtime has asked for its adapter. */
			status(): ManagedEnrollmentStatus | null;
			/** What this process can say of the installation, composed or not (`createHostInstallationStanding`). */
			standing: InstallationStandingSource;
			/** The endpoint inbox and the command service of this standing. */
			communications: HostCommunications;
	  }
	| {
			composed: false;
			reason: string;
			standing: InstallationStandingSource;
			/**
			 * `createMaestroRuntime`'s `managed`, always present (MCOMP-09-04B): `standing` is the
			 * installation standing above, so the runtime binding is held to it with no adapter, and
			 * a deleted binding file releases nothing. `host` is the held adapter
			 * (`createHeldHostAdapter`, MCOMP-09-03) when a sealed record exists that this process
			 * cannot open, so the runtime is handed a host that answers `unavailable` by name; it is
			 * absent when no record is present.
			 */
			managed: NonNullable<MaestroRuntimeOptions['managed']>;
	  };

function recordFileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The directories the installation standing reads: this one, the production one it maps to, the caller's. */
function standingDirectories(userDataDir: string, productionDataDir?: string): string[] {
	const directories: string[] = [];
	for (const dir of [
		userDataDir,
		resolveProductionDataDir(userDataDir),
		...(productionDataDir ? [productionDataDir] : []),
	]) {
		const resolved = path.resolve(dir);
		if (!directories.includes(resolved)) directories.push(resolved);
	}
	return directories;
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
	const directories = standingDirectories(input.userDataDir, input.productionDataDir);

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

export interface HeldHostAdapterInput {
	installation: ManagedInstallationIdentity;
	/** Why this process holds no protected custody (`resolveHostCustody`'s refusal). */
	custodyReason: string;
	standing: InstallationStandingSource;
	now?: () => number;
}

/**
 * The host adapter of a process that cannot open a sealed enrollment record (MCOMP-09-03): no
 * seal, no endpoint, no lifecycle, and an identity view that is never `ok`, so every admission it
 * is asked for answers `unavailable` with the custody refusal and the installation standing in its
 * reason, and its authority id is `unavailable`. It holds no key and reads no secret: the record
 * stays sealed for the desktop's custody, and nothing here unseals, copies or re-seals it. The
 * view is read per call, so a record the endpoint retired (the authenticated release) reads `none`
 * and the binding decides standalone, while a record merely removed still reads managed by its
 * anchor.
 */
export function createHeldHostAdapter(input: HeldHostAdapterInput): ManagedHostAdapter {
	const view = (): ManagedIdentityView => {
		const standing = input.standing.read();
		if (standing.standing !== 'managed')
			return { status: 'none', reason: null, message: standing.detail, record: null };
		return {
			status: 'unprotected',
			reason: 'encryption-unavailable',
			message: `${standing.detail} This host holds no protected custody for it (${input.custodyReason}), so managed operations are unavailable here.`,
			record: null,
		};
	};
	const status = (): ManagedEnrollmentStatus => {
		const identity = view();
		return {
			identity,
			connection: null,
			endpoint: null,
			authority: 'none',
			reason: identity.message,
			pendingApproval: null,
			lastDenial: null,
		};
	};
	return createManagedHostAdapter({
		installation: input.installation,
		identity: { read: view },
		endpoint: null,
		status,
		...(input.now ? { now: input.now } : {}),
	});
}

/**
 * Compose the detached host's managed standing over the data directory's sealed record, or name
 * why none is composed. The adapter is built for the installation the runtime computes (the
 * factory receives it once the lock is held), so the lifecycle registers as that runtime.
 */
export function composeHostManaged(deps: HostManagedDeps): HostManagedComposition {
	const now = deps.now ?? (() => Date.now());
	const file = path.join(deps.userDataDir, ENTERPRISE_IDENTITY_FILE_NAME);
	// Recheck supplied primitives too: an old successful probe is not custody now.
	const supplied = deps.custody;
	const custody =
		supplied && !supplied.ok
			? supplied
			: resolveHostCustody({
					userDataDir: deps.userDataDir,
					...(supplied?.ok ? { seal: supplied.seal, anchor: supplied.anchor } : {}),
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
		const reason = `${custody.reason}. ${record}`;
		// A sealed record this process cannot open is still an enrollment: the runtime gets the held
		// adapter, never no adapter. Presence alone decides here, so composing never reads the keyring.
		const sealed = standingDirectories(deps.userDataDir, deps.productionDataDir).some((dir) =>
			recordFileExists(path.join(dir, ENTERPRISE_IDENTITY_FILE_NAME))
		);
		// The standing goes to the runtime either way (MCOMP-09-04B), so its binding is held to it.
		if (!sealed) return { composed: false, reason, standing, managed: { standing } };
		const custodyReason = custody.reason;
		return {
			composed: false,
			reason,
			standing,
			managed: {
				standing,
				host: (installation) =>
					createHeldHostAdapter({ installation, custodyReason, standing, now }),
			},
		};
	}

	const identity = createEnterpriseIdentityStore({
		file,
		seal: custody.seal,
		anchor: custody.anchor,
		...(deps.platform ? { platform: deps.platform } : {}),
		now,
	});
	const openPort =
		deps.openPort ??
		((socketPath: string) =>
			createPlatformEndpointClient({
				socketPath,
				platform: deps.platform ?? process.platform,
				...(deps.endpointNative ? { native: deps.endpointNative } : {}),
			}));
	// The socket the lifecycle opened last, so the adapter speaks over the same connection.
	let port: EndpointPort | null = null;
	let lifecycle: EnrollmentLifecycle | null = null;
	let adapter: ManagedHostAdapter | null = null;
	let inbox: InboxClient | null = null;
	let commands: CommandService | null = null;
	// Commands being decided, so close waits for them before the standing goes.
	const deciding = new Set<Promise<unknown>>();
	// The listing an attach started, so close waits for it before the socket goes.
	let listing: Promise<unknown> | null = null;
	let closed = false;
	let closing: Promise<void> | undefined;
	const status = (): ManagedEnrollmentStatus | null => {
		const current = lifecycle?.status() ?? null;
		return closed && current
			? {
					...current,
					authority: 'none',
					reason: 'The managed host is closed.',
					pendingApproval: null,
				}
			: current;
	};

	async function withLifecycle<T>(
		work: (current: EnrollmentLifecycle) => Promise<LifecycleOutcome<T>>
	): Promise<LifecycleOutcome<T>> {
		if (closed || !lifecycle || !adapter) {
			return {
				status: 'unavailable',
				message: closed ? 'The managed host is closed.' : 'The runtime has not acquired this host.',
			};
		}
		const record = identity.read();
		if (
			record.status === 'ok' &&
			record.record.installationId !== adapter.installation.installationId
		) {
			return {
				status: 'refused',
				reason: 'installation-mismatch',
				message: 'The enrollment belongs to another installation; no endpoint operation was sent.',
			};
		}
		return work(lifecycle);
	}

	const control: HostEnrollmentControl = {
		requestEnrollment: (input) => withLifecycle((current) => current.requestEnrollment(input)),
		connect: () => withLifecycle((current) => current.connect()),
		beginRegistration: () => withLifecycle((current) => current.beginRegistration()),
		completeRegistration: () => withLifecycle((current) => current.completeRegistration()),
	};

	const host = (installation: ManagedInstallationIdentity) => {
		if (closed) throw new Error('The managed host is closed.');
		if (adapter) {
			if (adapter.installation !== installation) {
				throw new Error(
					'A managed composition belongs to one runtime; compose a new host for a restart.'
				);
			}
			return adapter;
		}
		const enrollment = createEnrollmentLifecycle({
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
			// As on the desktop: every accepted attachment lists the notices again. The inbox
			// standing refuses the listing unless this process holds a live registration.
			onAttached: () => {
				if (closed || !inbox) return;
				const pending = inbox.refresh().catch(() => undefined);
				listing = pending;
				void pending.finally(() => {
					if (listing === pending) listing = null;
				});
			},
		});
		lifecycle = enrollment;
		adapter = createManagedHostAdapter({
			installation,
			identity: { read: () => enrollment.status().identity },
			get endpoint() {
				return closed ? null : port;
			},
			status: () => status()!,
			now,
		});
		// The notice inbox over this same adapter, its receipts beside the record (MCOMP-21-03A).
		inbox = createInboxClient({
			host: adapter,
			ledger: createInboxReceiptLedger({
				file: path.join(deps.userDataDir, MANAGED_INBOX_RECEIPTS_FILE_NAME),
				now,
			}),
			now,
		});
		commands = composeHostCommands(enrollment, adapter);
		return adapter;
	};

	/** What this host can report of itself, read per call; the gaps name what it cannot. */
	function reportInventory(
		enrollment: EnrollmentLifecycle,
		current: ManagedHostAdapter
	): CommandStatusInventory {
		const standing = status() ?? enrollment.status();
		const record = standing.identity.status === 'ok' ? standing.identity.record : null;
		const live = standing.connection?.attached ? standing.endpoint : null;
		return {
			at: new Date(now()).toISOString(),
			installation: { ...current.installation },
			versions: {
				app: deps.version,
				library: MAESTRO_LIB_VERSION,
				contract: MANAGED_CONTRACT_VERSION,
				endpointProtocol: LOCAL_ENDPOINT_PROTOCOL,
				contracts: { status: 'not-read' },
			},
			endpoint: {
				authority: standing.authority,
				reason: standing.reason,
				status: live ? { management: live.management, connectivity: live.connectivity } : null,
				lastDenial: standing.lastDenial ? { ...standing.lastDenial } : null,
			},
			identity: {
				custody: standing.identity.status,
				management: record?.management ?? null,
				tenantId: record?.tenantId ?? null,
				orgId: record?.orgId ?? null,
				enrollmentId: record?.enrollmentId ?? null,
				registeredActor: record?.registration?.actorId != null,
			},
			policy: current.policyStatus(),
			completeness: 'partial',
			gaps: HOST_COMMAND_REPORT_GAPS,
		};
	}

	/**
	 * The command service of this standing (MCOMP-21-03B), over the authority the runtime admits
	 * with (the adapter's: every live lease here is one this host minted), the lifecycle's re-attach
	 * and the facts above. Its standing is `status()`, so a closed host decides nothing.
	 */
	function composeHostCommands(
		enrollment: EnrollmentLifecycle,
		current: ManagedHostAdapter
	): CommandService {
		const service = createCommandService({
			installation: current.installation,
			lifecycle: { status: () => status() ?? enrollment.status() },
			host: current,
			policy: createPolicyStatusService({ lifecycle: enrollment, now }),
			dispatch: { authority: current.authority },
			inventory: { snapshot: () => reportInventory(enrollment, current) },
			file: path.join(deps.userDataDir, MANAGED_COMMAND_LEDGER_FILE_NAME),
			// The runtime's Auto Run checks in between tasks here, so pause/resume are composed as the
			// cooperative task-boundary pause, never a process suspension.
			cooperativePause: true,
			now,
		});
		const track = <T>(work: Promise<T>): Promise<T> => {
			deciding.add(work);
			void work.finally(() => deciding.delete(work)).catch(() => undefined);
			return work;
		};
		return {
			...service,
			receive: (raw) => track(service.receive(raw)),
			issueLocal: (action) => track(service.issueLocal(action)),
		};
	}

	return {
		composed: true,
		// The adapter, and the standing the binding is held to (MCOMP-09-04B).
		// The cooperative pause gate (MCOMP-29-01B): the runtime tracks each playbook run in it, so a
		// management pause parks the run at its next task boundary. Null until the runtime acquires
		// the adapter and after close, so nothing is tracked by a host that cannot answer.
		managed: { host, standing, runControl: () => (closed ? null : (commands?.runControl ?? null)) },
		identity,
		standing,
		control,
		status,
		communications: {
			inbox: () => (closed ? null : inbox),
			commands: () => (closed ? null : commands),
		},
		lifecycle: {
			async attach() {
				// The receipts recover first: a record pending at the last exit becomes uncertain,
				// and the listing an attach starts records against the loaded ledger.
				if (inbox && !closed) await inbox.load();
				// The command ledger too: an acceptance from an earlier process becomes unknown.
				if (commands && !closed) await commands.load();
				// No sealed record, no dial: an unenrolled host never opens a socket here.
				if (!lifecycle || identity.read().status !== 'ok') return;
				await control.connect();
			},
			close: () => {
				closed = true;
				closing ??= (async () => {
					// The inbox stops before the standing closes: the listing in flight settles first.
					await listing;
					// Commands stop before the standing closes: `closed` refuses new ones, these settle.
					await Promise.allSettled([...deciding]);
					await lifecycle?.close();
					port = null;
				})();
				return closing;
			},
		},
	};
}
