/**
 * `createMaestroRuntime()`: the object that owns writes to a Maestro data
 * directory when no desktop does.
 *
 * It composes the paths, the data-dir lock, store I/O, the agent repository, the
 * process registry, and the event bus, and implements the agent, group, tab, and
 * settings parts of `MaestroClient` in process (`./client`). Wrappers hold it: the
 * TUI directly, `maestro-cli host` behind the bridge (Phase 7), Electron main
 * behind a setting (Phase 9). It has no network in it.
 *
 * lib-D2: the runtime owns writes, process lifetime, and events. It does not own
 * completion policy, stream interpretation, or outcomes; those stay with the
 * callers that consume its events.
 *
 * Design: `Plans/maestro-tui-runtime.md`, sections 2 and 3 (the start rule).
 */

import * as fs from 'fs/promises';

import { createSleepTracker } from '../../sleepTracking';
import { createAgentRepository } from '../agents/repository';
import type { RepositoryLoadFailure } from '../agents/repository';
import type { RuleContext, TabDefaults } from '../agents/rules';
import { createEventBus } from '../client/event-bus';
import type { HostInfo, MaestroClient, ManagedApi } from '../client/types';
import { logger } from '../host';
import { createGroupChatTurnMetrics } from '../groupchat/turn-metrics';
import type { BinaryDetectionResult } from '../launch/path-prober';
import { assertUserDataDirExists, type UserDataDirOptions } from '../paths/userDataDir';
import { resolveMaestroPaths, type MaestroPaths } from '../paths/resolve';
import { readAgentConfigsStore } from '../store/read-stores';
import { createRuntimeClient, type RuntimePhase } from './client';
import {
	acquireDataDirLock,
	type DataDirLockDeps,
	type DataDirRefusal,
	type DataDirVerdict,
	type RuntimeLockInfo,
	type RuntimeLockMode,
} from './data-dir-lock';
import * as os from 'os';

import { generateUUID } from '../../uuid';
import {
	createContextVerifier,
	type HostAuthority,
	type PolicySourceSet,
} from '../managed/authority';
import { createManagedBinding, type ManagedBinding } from '../managed/binding';
import {
	bindingEnrollment,
	createHeadlessSpawnAuthority,
	installationIdentity,
	managedActorPrincipal,
	type ManagedHostAdapter,
} from '../managed/host-adapter';
import { createManagedOperations, type ApprovedResource } from '../managed/operations';
import { createRunJournal, managedRunJournalPath, type RunJournal } from '../managed/run-journal';
import type {
	ManagedAuthenticatedContext,
	ManagedInstallationIdentity,
	ManagedOperationContext,
	ManagedPeerAuthentication,
} from '../managed/types';
import {
	createWorkflowOwnership,
	MANAGED_WORKFLOWS_FILE_NAME,
	workflowFenceOf,
	type WorkflowFenceAnswer,
	type WorkflowIdentityLike,
	type WorkflowOwnerStanding,
} from '../managed/workflows';
import { getVisibleAgentDefinitions } from '../providers/definitions';
import type { AgentRecord } from '../store/records';
import { createBackgroundTurns, type BackgroundTurnDeps } from './background-turns';
import {
	createRuntimeConsults,
	type ConsultSpawnAuthorityPort,
	type RuntimeConsultsManagedOptions,
} from './consults';
import { createRuntimeGroupChats } from './group-chats';
import { createProcessRegistry } from './processes';
import { createRuntimeAutoRun, type RuntimeAutoRun, type RuntimeAutoRunHost } from './autorun';
import { createProviderLister } from './providers';
import { watchSettingsFile, type WatchDirectory } from './settings-watch';
import { createRuntimeTurns, type RuntimeTurnDeps, type RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[MaestroRuntime]';

/** Test seams: the lock's clock, pid, and probes, plus the rest of the runtime's outside world. */
export type RuntimeDeps = DataDirLockDeps & {
	/** Ids, clock, and randomness for new records. */
	rules: Partial<RuleContext>;
	/** Why a local working directory cannot be used, or null. */
	checkCwd(cwd: string): string | null;
	/** The settings a new tab starts from. */
	readTabDefaults(): Promise<TabDefaults>;
	/** Is this provider binary, or the custom path set for it, runnable? */
	probeBinary(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	/** Watches the settings directory. */
	watchDirectory: WatchDirectory;
	/** The seams of the turn service: the provider launch and the probes a turn makes. */
	turns: Partial<RuntimeTurnDeps>;
	/** The seams of the group chat and consult runner: the provider launch and the binary probe. */
	background: Partial<BackgroundTurnDeps>;
	/**
	 * The seams of the consult service: the shortest wait a caller may ask for, who the asking
	 * turn is when the host can name it, and every admission as it is decided.
	 */
	consults: Pick<RuntimeConsultsManagedOptions, 'initiator' | 'onAdmission'> & {
		minTimeoutMs?: number;
	};
};

export interface MaestroRuntimeOptions {
	/** The user data dir the caller resolved (`resolveUserDataDir`, `--data-dir`, `--dev`). Never read from the environment here. */
	dataDir: string;
	/** Where agent configs live in a dev run. Default: the production directory `dataDir` maps to. */
	productionDataDir?: string;
	/** Who hosts, written into the lock: `tui` (Phase 5), `host` (Phase 7), `desktop` (Phase 9). */
	mode: RuntimeLockMode;
	/** Create `dataDir` when it does not exist. Default false: a guessed directory must not become an empty database. */
	createDataDir?: boolean;
	/** Host on a `customSyncPath` anyway (a pid lock cannot see another machine). Default false. */
	allowSyncedDataDir?: boolean;
	/** Quarantine a corrupt sessions or groups file and start from defaults. Default false: refuse. */
	quarantineCorruptStores?: boolean;
	/** What the runtime needs to run turns: the SQLite loader, the CLI script, the bundled prompts. */
	turns?: RuntimeTurnOptions;
	/**
	 * The managed authority this host answers admissions with, injected before
	 * anything is admitted. An enrolled data directory (`maestro-managed-binding.json`)
	 * with no authority, or one for another authority, runs enrolled-unavailable:
	 * managed operations answer `unavailable`, never standalone.
	 */
	managed?: {
		authority?: HostAuthority;
		/**
		 * The host adapter over this process's identity custody and endpoint
		 * socket (`createManagedHostAdapter`), built for the installation identity
		 * the runtime computes (the factory receives it once the lock is held).
		 * Its authority answers admissions and its enrollment record is mirrored
		 * into the binding file under the lock. Takes precedence over `authority`.
		 */
		host?(installation: ManagedInstallationIdentity): ManagedHostAdapter;
		/** The approved handle for a resource id a managed submission names. Default: none. */
		resolveResource?(id: string, context: ManagedAuthenticatedContext): ApprovedResource | null;
		/** Which agents a verified actor may see. Default: all of them. */
		scopeAgents?(context: ManagedAuthenticatedContext, agents: AgentRecord[]): AgentRecord[];
		/** The policy sources admissions are decided on. Default: what the enrollment record names. */
		policy?(): PolicySourceSet;
		/**
		 * The owner fence of an Auto Run's (or a hosted Cue run's) workflow, claimed on every
		 * attempt for that attempt's run and attempt ids. Default: the runtime's own
		 * `createWorkflowOwnership` over `maestro-managed-workflows.json` in the data directory,
		 * claiming through the host adapter's `workflows` port (the endpoint's workflow owner
		 * operation, CP-03) as this installation; with no attached producer the claim is refused by
		 * name. An override stands in for the producer (a harness); nothing here mints a fence, and
		 * standalone never asks.
		 */
		workflowFence?(
			workflow: WorkflowIdentityLike,
			run: { runId: string; attemptId: string }
		): WorkflowFenceAnswer | Promise<WorkflowFenceAnswer>;
	};
	deps?: Partial<RuntimeDeps>;
}

export type RuntimeRefusal =
	| DataDirRefusal
	| { reason: 'data-dir-missing'; tried: string[]; message: string }
	| { reason: 'synced-data-dir'; syncDir: string; message: string }
	| RepositoryLoadFailure;

export type RuntimeStart =
	| { ok: true; runtime: MaestroRuntime }
	| { ok: false; refusal: RuntimeRefusal };

export interface MaestroRuntime extends MaestroClient {
	readonly paths: MaestroPaths;
	/** What this process wrote into `maestro-runtime.lock`. */
	readonly lock: RuntimeLockInfo;
	/** Whether this installation is enrolled, and who answers for it. */
	readonly managedBinding: Pick<ManagedBinding, 'state' | 'reload' | 'authority'>;
	/** The managed run journal, for a host that reports runs. Null when it could not be loaded. */
	readonly managedRuns: Pick<RunJournal, 'get' | 'list' | 'open'> | null;
	/** This installation as a managed peer sees it. A local label, not an enrolled device identity. */
	readonly installation: ManagedInstallationIdentity;
	/** The host adapter this runtime admits with, when one was injected. */
	readonly managedHost: ManagedHostAdapter | null;
	/**
	 * Claim the owner fence of a workflow for one run and attempt (MRC-07-06A): what every Auto Run
	 * attempt is admitted on, and what a Cue engine hosted in this process claims with, so one
	 * ownership record per data directory holds every fence. The fence the registry confirmed, or
	 * the named reason there is none; an injected `managed.workflowFence` answers instead.
	 */
	claimWorkflowFence(
		workflow: WorkflowIdentityLike,
		run: { runId: string; attemptId: string }
	): Promise<WorkflowFenceAnswer>;
	/**
	 * The Auto Runs in flight, for a host that reports them (`host status`, the refusal to stop with
	 * work in flight) and replays them to a client that connects mid-run.
	 */
	readonly runs: Pick<RuntimeAutoRun, 'activeRuns' | 'latestState'>;
	/** Chat turns running now. With the rest, the work `host stop` refuses to cut off. */
	turnsInFlight(): number;
	/** Group chats whose moderator or a participant is working (GD24). */
	roundsInFlight(): number;
	/** Consults waiting on another agent's answer (GD24). */
	consultsInFlight(): number;
}

/** What the status bar prints after `host: `. */
function hostLabel(mode: RuntimeLockMode, pid: number): string {
	switch (mode) {
		case 'tui':
			return 'this TUI';
		case 'host':
			return `this host (pid ${pid})`;
		case 'desktop':
			return `this desktop (pid ${pid})`;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The refusal for a directory that is not there (or not a directory), with the message the CLI gives. */
function missingDataDir(userDataDir: string, env: UserDataDirOptions['env']): RuntimeRefusal {
	let message = `Maestro data directory not found at ${userDataDir}.`;
	try {
		assertUserDataDirExists(userDataDir, { env });
	} catch (error) {
		message = errorText(error);
	}
	return { reason: 'data-dir-missing', tried: [userDataDir], message };
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return false;
		throw error;
	}
}

/**
 * Start a runtime on `options.dataDir`, or say why not. The first failing step
 * refuses and nothing is written before the lock is held (the start rule, section
 * 3 of the design).
 */
export async function createMaestroRuntime(options: MaestroRuntimeOptions): Promise<RuntimeStart> {
	const deps = options.deps ?? {};
	const env = { MAESTRO_USER_DATA: options.dataDir };
	const paths = resolveMaestroPaths({
		env,
		...(options.productionDataDir ? { productionDataPath: options.productionDataDir } : {}),
	});

	// B: the directory is there. Creating one is the caller's explicit choice.
	try {
		if (!(await isDirectory(paths.userDataDir))) {
			if (!options.createDataDir) {
				return { ok: false, refusal: missingDataDir(paths.userDataDir, env) };
			}
			await fs.mkdir(paths.userDataDir, { recursive: true });
		}
	} catch (error) {
		return {
			ok: false,
			refusal: {
				reason: 'data-dir-missing',
				tried: [paths.userDataDir],
				message: `Cannot use ${paths.userDataDir}: ${errorText(error)}`,
			},
		};
	}

	// C: a synced directory is shared with machines this lock cannot see (risk R3).
	if (paths.syncDirSource === 'customSyncPath' && !options.allowSyncedDataDir) {
		return {
			ok: false,
			refusal: {
				reason: 'synced-data-dir',
				syncDir: paths.syncDir,
				message: `Settings and agents sync through ${paths.syncDir}. A lock on this machine cannot see another one writing there, so it is not hosted headless.`,
			},
		};
	}

	// D, E, F: a live desktop or host, then the lock, then a second look for a desktop.
	const locked = acquireDataDirLock(paths, options.mode, deps);
	if (!locked.ok) return { ok: false, refusal: locked.refusal };
	const lock = locked.lock;

	const bus = createEventBus(LOG_CONTEXT);
	const registry = createProcessRegistry();
	let fenceVerdict: () => DataDirVerdict = () => ({ ok: true });
	// Read before any admission, under the lock. The binding reads the
	// production directory too, so an alternate data directory under an
	// enrolled installation is still enrolled.
	// The installation id is a label derived from this machine and the
	// production data directory, so a peer can tell two installs apart; it is
	// not a minted device identity (that is the peer's, bound at enrollment).
	const hostname = (deps.hostname ?? os.hostname)() ?? 'unknown-host';
	const installation = installationIdentity({
		hostname,
		productionDataDir: paths.productionDataDir,
		mode: options.mode,
		pid: lock.info.pid,
		startedAt: lock.info.startedAt,
	});
	const managedHost = options.managed?.host?.(installation) ?? null;
	const managedAuthority = managedHost?.authority ?? options.managed?.authority;
	const binding = createManagedBinding({
		paths,
		fence: () => fenceVerdict(),
		...(managedAuthority ? { authority: managedAuthority } : {}),
		now: deps.now ?? (() => Date.now()),
	});
	let phase: RuntimePhase = 'open';
	let fencedText = 'Another Maestro took over this data directory.';
	/** Filled in once the runtime is up; the fence and the shutdown both close them. */
	const running: { stopHeartbeat?: () => void; settingsWatcher?: { close(): void } } = {};

	/** Lost the directory: no more writes, stop what the runtime started, tell the listeners (RT11). */
	const fenceRuntime = (reason: string): void => {
		if (phase !== 'open') return;
		phase = 'fenced';
		fencedText = reason;
		repository.fence(reason);
		running.stopHeartbeat?.();
		running.settingsWatcher?.close();
		consults.dispose();
		groupChats.stopAll().catch((error) => {
			logger.warn(
				`Stopping group chats after losing the data directory failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		});
		autoRun.stopAll().catch((error) => {
			logger.warn(
				`Stopping Auto Runs after losing the data directory failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		});
		registry.stopAll().catch((error) => {
			logger.warn(
				`Stopping processes after losing the data directory failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		});
		managedAuthority?.revokeAll(reason);
		bus.emit({ type: 'host.lost', reason });
	};

	/** Is this process still the data directory's writer? Losing it fences the whole runtime. */
	const fence = () => {
		const verdict = lock.verify();
		if (!verdict.ok) fenceRuntime(verdict.reason);
		return verdict;
	};
	fenceVerdict = fence;

	const repository = createAgentRepository({
		paths,
		bus,
		processes: registry,
		fence,
		quarantineCorruptStores: options.quarantineCorruptStores,
		context: deps.rules,
		readTabDefaults: deps.readTabDefaults,
		checkCwd: deps.checkCwd,
	});

	try {
		if (paths.syncDir !== paths.userDataDir) await fs.mkdir(paths.syncDir, { recursive: true });
		const loaded = await repository.load();
		if (!loaded.ok) {
			lock.release();
			return { ok: false, refusal: loaded.failure };
		}
	} catch (error) {
		lock.release();
		return {
			ok: false,
			refusal: {
				reason: 'lock-failed',
				file: lock.file,
				detail: errorText(error),
				message: `Could not start on ${paths.userDataDir}: ${errorText(error)}`,
			},
		};
	}

	// An enrolled sealed record is mirrored into the binding file by the lock
	// holder, so the runtime's own enrollment and the protected custody agree.
	// A binding for another authority, or a record for another installation,
	// is left as it is: the binding then reads enrolled-unavailable and says why.
	if (managedHost) {
		const identity = managedHost.identity.read();
		if (
			identity.status === 'ok' &&
			identity.record &&
			identity.record.installationId === installation.installationId &&
			binding.state().state === 'standalone'
		) {
			const enrolled = await binding.enroll(bindingEnrollment(identity.record));
			if (!enrolled.ok) {
				logger.warn(
					`The managed binding could not mirror the enrollment record (${enrolled.reason}): ${enrolled.message}`,
					LOG_CONTEXT
				);
			}
		} else if (
			identity.status === 'ok' &&
			identity.record?.installationId !== installation.installationId
		) {
			logger.warn(
				`The enrollment record names installation ${identity.record?.installationId}, this runtime is ${installation.installationId}; managed operations stay unavailable.`,
				LOG_CONTEXT
			);
		}
	}

	running.stopHeartbeat = lock.startHeartbeat(fenceRuntime);
	running.settingsWatcher = watchSettingsFile({
		file: paths.settingsFile,
		onChange: (keys) => bus.emit({ type: 'settings.changed', keys }),
		watch: deps.watchDirectory,
	});

	const listProviders = createProviderLister({
		readCustomPaths: () => {
			const configs = readAgentConfigsStore(paths.agentConfigsFile);
			const out: Record<string, string | undefined> = {};
			if (configs.status !== 'ok') return out;
			for (const [id, config] of Object.entries(configs.data.configs ?? {})) {
				const customPath = (config as { customPath?: unknown }).customPath;
				if (typeof customPath === 'string') out[id] = customPath;
			}
			return out;
		},
		probe: deps.probeBinary,
		now: deps.now,
	});

	// The policy sources admissions are decided on: the injected reader, the attached host's, or
	// what the binding record names. One answer for the Auto Run port and the managed facade.
	const bindingPolicy = (): PolicySourceSet => {
		const state = binding.state();
		return state.state === 'enrolled'
			? { sources: state.record.policySources, policyRevision: state.record.policyRevision }
			: { sources: [], policyRevision: null };
	};
	const admissionPolicy =
		options.managed?.policy ?? (managedHost ? () => managedHost.policy() : bindingPolicy);
	// What an Auto Run's turns are admitted with: the attached host with its custody naming the
	// registered actor, or an injected authority standing in for one. Neither: an enrolled binding
	// is still managed, and the port answers unavailable.
	const autoRunHost: RuntimeAutoRunHost | null = managedHost
		? { authority: managedHost.authority, policy: admissionPolicy, identity: managedHost.identity }
		: managedAuthority
			? { authority: managedAuthority, policy: admissionPolicy, identity: null }
			: null;
	// The owner fences this installation holds (MRC-07-06A), claimed as the installation under the
	// authority the binding names, through the attached host's workflow owner port; one record per
	// data directory, shared by the Auto Runs here and a Cue engine hosted in this process. A
	// standalone binding has no standing to claim under; no port, nothing is minted in its place.
	const workflowOwner = (): WorkflowOwnerStanding | null => {
		const state = binding.state();
		if (state.state !== 'enrolled') return null;
		return {
			ownerId: installation.installationId,
			authorityId: state.record.authorityId,
			policyRevision: admissionPolicy().policyRevision,
		};
	};
	const workflows = createWorkflowOwnership({
		file: `${paths.userDataDir}/${MANAGED_WORKFLOWS_FILE_NAME}`,
		port: () => managedHost?.workflows ?? null,
		owner: workflowOwner,
		now: deps.now ?? (() => Date.now()),
		...(deps.rules?.newId ? { newId: deps.rules.newId } : {}),
	});
	// Read now, under the lock: a restarted host re-claims with what it held, never afresh. A file
	// that cannot be read refuses every claim with that reason (the claim re-reads it).
	const workflowsLoaded = await workflows.load();
	if (!workflowsLoaded.ok) {
		logger.warn(
			`Workflow ownership is unavailable: ${workflowsLoaded.file} is ${workflowsLoaded.reason} (${workflowsLoaded.message}).`,
			LOG_CONTEXT
		);
	}
	const claimWorkflowFence: MaestroRuntime['claimWorkflowFence'] = async (workflow, run) =>
		options.managed?.workflowFence
			? options.managed.workflowFence(workflow, run)
			: workflowFenceOf(
					await workflows.claim({
						workflow,
						runId: run.runId,
						attemptId: run.attemptId,
						offlineEnabled: managedHost?.policyStatus().offline.installedPolicyAvailable ?? false,
					})
				);
	/**
	 * What a consult and a group chat turn are admitted with: the headless spawn authority over the
	 * binding and that same host, with the enrollment's registered actor as the principal, rebuilt
	 * on every turn so an enrollment that appeared or lapsed applies to the next one (the Auto Run
	 * port's recipe). The consult stage and the background runner read the one port.
	 */
	const backgroundSpawnPort = (): ConsultSpawnAuthorityPort =>
		createHeadlessSpawnAuthority({
			installation,
			binding: binding.state(),
			host: autoRunHost,
			origin: 'headless',
			actor: managedActorPrincipal(autoRunHost?.identity?.read() ?? null, installation),
			...(deps.now ? { now: deps.now } : {}),
		});

	// The run releases what it held back (queued chat messages) when it ends, and the turn service
	// asks whether a run holds an agent: each needs the other, so the run reaches `turns`, declared
	// below, only when a run ends.
	const autoRun = createRuntimeAutoRun({
		paths,
		repository,
		bus,
		registry,
		fence,
		options: options.turns,
		deps: { probeBinary: deps.probeBinary, ...deps.turns },
		onRunEnded: (agentId) => turns.drain(agentId),
		trigger: options.mode === 'host' ? 'api' : 'cli',
		managed: {
			installation,
			binding,
			host: autoRunHost,
			workflowFence: claimWorkflowFence,
		},
		...(deps.rules?.newId ? { newId: deps.rules.newId } : {}),
	});
	const turns = createRuntimeTurns({
		paths,
		repository,
		bus,
		registry,
		fence,
		rules: deps.rules,
		autoRunHolds: (agentId) => autoRun.holds(agentId),
		options: options.turns,
		deps: { probeBinary: deps.probeBinary, ...deps.turns },
	});

	// Group chats and consults: the processes a round and a question are made of (GD20). The metrics are
	// one instance because the spawn path starts a turn's clock and the engine finishes it.
	const sleepTracker = createSleepTracker();
	const groupChatMetrics = createGroupChatTurnMetrics({
		spans: { begin: sleepTracker.beginSpan, elapsedMs: sleepTracker.elapsedMs },
	});
	const background = createBackgroundTurns({
		paths,
		registry,
		host: options.turns ?? {},
		beginTurn: (processId) => groupChatMetrics.begin(processId),
		deps: { probeBinary: deps.probeBinary, ...deps.background },
		// Every group chat turn and consult process is admitted on the host's standing (MRC-07-05).
		managed: {
			port: backgroundSpawnPort,
			...(deps.background?.onAdmission ? { onAdmission: deps.background.onAdmission } : {}),
		},
	});
	const groupChats = createRuntimeGroupChats({
		paths,
		repository,
		bus,
		registry,
		fence,
		background,
		metrics: groupChatMetrics,
		autoRun,
		options: options.turns,
	});
	const consults = createRuntimeConsults({
		paths,
		repository,
		fence,
		background,
		rules: deps.rules,
		// Where the prompts and the CLI script are, as the chat turns are told.
		...(options.turns ? { options: options.turns } : {}),
		...(deps.consults?.minTimeoutMs !== undefined
			? { minTimeoutMs: deps.consults.minTimeoutMs }
			: {}),
		managed: {
			port: backgroundSpawnPort,
			...(deps.consults?.initiator ? { initiator: deps.consults.initiator } : {}),
			...(deps.consults?.onAdmission ? { onAdmission: deps.consults.onAdmission } : {}),
		},
	});

	// NF-7: a crash or a plain exit must not leave a held lock or an orphan it could have stopped.
	const onExit = (): void => {
		registry.terminateAllNow();
		lock.release();
	};
	process.once('exit', onExit);

	let shutdownDone: Promise<void> | undefined;
	const shutdown = (): Promise<void> => {
		shutdownDone ??= (async () => {
			phase = 'closed';
			running.stopHeartbeat?.();
			running.settingsWatcher?.close();
			try {
				// Nothing new starts; the turns that run are stopped and finish recording themselves
				// (their records are repository commands), and only then is the write queue drained.
				turns.dispose();
				// Rounds first: stopping one records how it ended in the chat's log while the lock is
				// still held. Then the runs (History, stats), then every process that is left, a
				// consult's included.
				consults.dispose();
				await groupChats.stopAll();
				await autoRun.stopAll();
				await registry.stopAll();
				// What a stopped consult writes down about how it ended, before the lock goes.
				await consults.settled();
				await groupChats.drain();
				await repository.drain();
			} finally {
				process.off('exit', onExit);
				lock.release();
			}
		})();
		return shutdownDone;
	};

	const host: HostInfo = {
		kind: 'in-process',
		startedAt: Date.parse(lock.info.startedAt),
		label: hostLabel(options.mode, lock.info.pid),
	};

	// Managed operations. One verifier per transport the facade is reachable
	// over, each accepting a context that names this installation: the host's
	// own in-process callers, and the bridge, whose request handler admits a
	// caller on the per-boot secret and stamps `host-secret` on the envelope
	// (MRC-08-05A). Every other transport waits on its own verifier.
	const managedNow = deps.now ?? (() => Date.now());
	const journal = createRunJournal({
		file: managedRunJournalPath(paths),
		now: managedNow,
		newId: deps.rules?.newId ?? generateUUID,
	});
	const journalLoaded = await journal.load({ liveRunIds: registry.liveRunIds() });
	const acceptThisInstallation = (context: ManagedOperationContext): readonly string[] =>
		context.installation.installationId === installation.installationId
			? []
			: [`installation ${context.installation.installationId} is not this one`];
	const verifierOver = (peer: ManagedPeerAuthentication) =>
		createContextVerifier({
			verifierId: `${peer}:${installation.runtimeId}`,
			peer,
			now: managedNow,
			accept: acceptThisInstallation,
		});
	let managed: ManagedApi | undefined;
	if (journalLoaded.ok) {
		managed = createManagedOperations({
			installation,
			binding,
			verifier: verifierOver('in-process'),
			verifiers: { 'host-secret': verifierOver('host-secret') },
			journal,
			repository,
			turns: turns.managed,
			providers: () => getVisibleAgentDefinitions().map((definition) => definition.id),
			policy: admissionPolicy,
			...(options.managed?.resolveResource
				? { resolveResource: options.managed.resolveResource }
				: {}),
			...(options.managed?.scopeAgents ? { scopeAgents: options.managed.scopeAgents } : {}),
			...(managedHost ? { policyStatus: () => managedHost.policyStatus() } : {}),
		});
	} else {
		logger.warn(
			`Managed operations are unavailable: the run journal ${journalLoaded.file} is ${journalLoaded.reason} (${journalLoaded.message}).`,
			LOG_CONTEXT
		);
	}

	const client = createRuntimeClient({
		paths,
		repository,
		bus,
		host,
		phase: () => phase,
		fencedReason: () => fencedText,
		shutdown,
		listProviders,
		turns: turns.api,
		autoRun: autoRun.api,
		groupChats: groupChats.api,
		consults: { api: consults.api, cancelForSource: consults.cancelForSource },
		...(managed ? { managed } : {}),
	});

	return {
		ok: true,
		runtime: {
			...client,
			paths,
			lock: lock.info,
			managedBinding: binding,
			managedRuns: journalLoaded.ok ? journal : null,
			installation,
			managedHost,
			claimWorkflowFence,
			runs: { activeRuns: autoRun.activeRuns, latestState: autoRun.latestState },
			// The registry holds every process the runtime owns; the background ones are counted apart.
			turnsInFlight: () => registry.size() - background.registeredCount(),
			roundsInFlight: groupChats.roundsInFlight,
			consultsInFlight: consults.inFlight,
		},
	};
}
