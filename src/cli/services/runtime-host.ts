/**
 * The detached host: the library runtime, served over the desktop bridge's WebSocket, with Cue
 * beside it when the rules allow.
 *
 * `maestro-cli host start` runs this in a process that outlives its parent, so an Auto Run or a chat
 * turn survives the TUI quitting or an SSH drop. The runtime owns the data directory (its lock says
 * `host`); the server (`runtime/server.ts`) is the only way in. The discovery file is published
 * LAST, once the socket is listening, and removed FIRST on the way out, so a client that finds it
 * always finds a host that answers.
 */

import * as crypto from 'crypto';

import {
	createMaestroRuntime,
	createPromptLoaderFor,
	deleteCliServerInfoFrom,
	resolveRuntimeTurnOptions,
	startRuntimeServer,
	writeCliServerInfoTo,
	type HostWork,
	type MaestroPaths,
	type MaestroRuntime,
	type MaestroRuntimeOptions,
	type RuntimeRefusal,
	type RuntimeServer,
} from '../../shared/maestro-lib';
import {
	createRoundParentCustody,
	runtimeManagedScope,
	type RoundParentCustody,
} from '../../shared/maestro-lib/runtime/server-requests';
import {
	createTelemetryClient,
	TELEMETRY_HOST_IDLE_POLL_MS,
	type TelemetryClient,
} from '../../main/enterprise/telemetry';
import { holdListener, setListenerAuthority } from '../../main/enterprise/listener-gate';
import {
	listenerVerdict,
	managedListenerStanding,
	type ListenerAuthority,
} from '../../main/enterprise/listener-policy';
import {
	createManagedCommunications,
	createManagedCommunicationsPort,
} from '../../main/enterprise/service';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { startHostCue, type HostCue } from './host-cue';
import {
	composeHostManaged,
	type HostManagedComposition,
	type HostManagedLifecycle,
} from './host-managed';

/** The runtime refused the directory: another host, a desktop, a held lock, a corrupt store. */
export class HostStartError extends Error {
	constructor(readonly refusal: RuntimeRefusal) {
		super(refusal.message);
		this.name = 'HostStartError';
	}
}

/** Where a detached host's refusal says nothing is composed. */
const HOST_PLACE = 'on this host';

/** The one address a detached host's bridge binds: this machine only. */
export const RUNTIME_HOST_BIND = '127.0.0.1';

/**
 * The listener authority a detached host holds its bridge to (MCOMP-21-03): the desktop's rule
 * (`managedListenerStanding` + `listenerVerdict`) over the runtime's OWN binding, read per bind.
 * Any binding state but `standalone` is managed, so an enrolled-unavailable or unreadable
 * standing, or an omitted host adapter, never reads as standalone. The revision is the attached
 * adapter's applied one while enrolled, else the record's kept one. No published operation
 * delivers a listener ceiling (DESKTOP-LOCAL/1), so a managed host refuses `runtime-host`
 * `unavailable` by name and never opens the socket; standalone binds as before.
 */
export function runtimeHostListenerAuthority(
	runtime: Pick<MaestroRuntime, 'managedBinding' | 'managedHost'>
): ListenerAuthority {
	return {
		evaluateListener(request) {
			const binding = runtime.managedBinding.state();
			const policy =
				binding.state === 'enrolled' && runtime.managedHost
					? runtime.managedHost.policyStatus()
					: 'record' in binding
						? { appliedRevision: binding.record.policyRevision }
						: null;
			return listenerVerdict(
				managedListenerStanding({
					enrolled: binding.state !== 'standalone',
					policy,
					ceiling: null,
				}),
				request
			);
		},
	};
}

export interface RuntimeHostOptions {
	/** Keep custody, controls and their lifecycle together. Default: compose for this directory. */
	managedComposition?: HostManagedComposition;
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir' | 'settingsFile' | 'cliServerFile'>;
	/** The folder the running bundle sits in: where `maestro-cli.js` and `maestro-p.js` are looked for. */
	moduleDirectory: string;
	/** The build version, published in the discovery file and in `status`. */
	version?: string;
	/** Port to listen on. Default 0: any free one. */
	port?: number;
	/**
	 * The managed standing this host runs under (`createMaestroRuntime`'s `managed`): the host
	 * adapter over this process's identity custody and endpoint socket, when the caller composed
	 * one (`composeHostManaged` in `host-managed.ts`). With it the runtime admits as that host and
	 * `host status` attests the standing (`HostStatusReport.managed`); without it an enrolled data
	 * directory runs enrolled-unavailable and attests nothing.
	 */
	managed?: MaestroRuntimeOptions['managed'];
	/**
	 * Why no standing was composed, when `managed` is absent: reported as
	 * `HostStatusReport.managedUnavailable` so `host status` says which custody primitive is
	 * missing instead of "none". Never a standing of its own.
	 */
	managedUnavailable?: string;
	/**
	 * The composed standing's lifecycle: `attach` re-attaches a previously enrolled installation
	 * once the runtime holds the directory and before the host publishes; `close` drops the
	 * endpoint socket on stop, after the server and before the runtime releases the directory.
	 */
	managedLifecycle?: HostManagedLifecycle;
	log(line: string): void;
}

/**
 * The bundle was copied without its prompts. The runtime would start anyway and then send every
 * turn without its system prompt and end every Auto Run in the log, so the host says so first.
 */
export class HostPromptsMissingError extends Error {
	constructor(moduleDirectory: string) {
		super(
			`The bundled prompts were not found from ${moduleDirectory} (no readable ${PROMPT_IDS.MAESTRO_SYSTEM_PROMPT}.md). ` +
				'Without them a turn has no Maestro system prompt and an Auto Run cannot run. ' +
				'Keep the prompts directory beside maestro-cli.js (prompts/core), or reinstall Maestro.'
		);
		this.name = 'HostPromptsMissingError';
	}
}

export interface RuntimeHostDeps {
	composeManaged: typeof composeHostManaged;
	createRuntime: typeof createMaestroRuntime;
	startServer: typeof startRuntimeServer;
	startCue: typeof startHostCue;
	/** What the bridge's listener is held to. Default: `runtimeHostListenerAuthority`. */
	listenerAuthority(runtime: MaestroRuntime): ListenerAuthority;
	/** Can the runtime load its bundled prompts, looked for the way it looks for them? */
	promptsLoad(moduleDirectory: string, userDataDir: string): boolean;
	randomToken(): string;
	now(): number;
	pid: number;
}

export interface RunningHost {
	/** Local host controls, when composed here or supplied together by the caller. */
	readonly managedComposition: HostManagedComposition | null;
	readonly runtime: MaestroRuntime;
	readonly server: RuntimeServer;
	readonly cue: HostCue;
	readonly token: string;
	/**
	 * The telemetry client over the runtime's event journal and managed host (MRC-10-03B): started
	 * after the standing re-attaches, woken by every event the runtime projects, stopped and drained
	 * before the standing closes. Null when the runtime holds no host adapter or no journal.
	 */
	readonly telemetry: TelemetryClient | null;
	/** The work a stop would cut off now: what `host status` reports and a draining host waits on. */
	work(): HostWork;
	/** Settles once the host has fully stopped. */
	readonly stopped: Promise<void>;
	/** Stop everything in order and release the data directory. Idempotent. */
	stop(): Promise<void>;
}

const defaultDeps: RuntimeHostDeps = {
	composeManaged: composeHostManaged,
	createRuntime: createMaestroRuntime,
	startServer: startRuntimeServer,
	startCue: startHostCue,
	listenerAuthority: runtimeHostListenerAuthority,
	promptsLoad: (moduleDirectory, userDataDir) =>
		createPromptLoaderFor({ userDataDir, moduleDirectory })?.get(
			PROMPT_IDS.MAESTRO_SYSTEM_PROMPT
		) !== undefined,
	randomToken: () => crypto.randomBytes(24).toString('hex'),
	now: () => Date.now(),
	pid: process.pid,
};

/**
 * Start the host, or throw: `HostStartError` naming why the directory is not ours to serve, or
 * `HostPromptsMissingError` for a bundle that cannot load its prompts.
 */
export async function startRuntimeHost(
	options: RuntimeHostOptions,
	overrides: Partial<RuntimeHostDeps> = {}
): Promise<RunningHost> {
	const deps = { ...defaultDeps, ...overrides };
	const { paths, log } = options;

	// Before the lock is taken: a host that cannot run a turn properly should not hold the directory.
	if (!deps.promptsLoad(options.moduleDirectory, paths.userDataDir)) {
		throw new HostPromptsMissingError(options.moduleDirectory);
	}
	if (
		options.managedComposition &&
		(options.managed || options.managedLifecycle || options.managedUnavailable)
	) {
		throw new Error('Pass managedComposition together, without separate managed options.');
	}
	const composition =
		options.managedComposition ??
		(options.managed
			? null
			: deps.composeManaged({
					userDataDir: paths.userDataDir,
					productionDataDir: paths.productionDataDir,
					version: options.version ?? 'unknown',
				}));
	const managed = composition?.managed ?? options.managed;
	const managedLifecycle = composition?.composed ? composition.lifecycle : options.managedLifecycle;
	const managedUnavailable =
		composition && !composition.composed ? composition.reason : options.managedUnavailable;

	// The parent a group chat round runs under on this host's standing (MCOMP-17-03CC). The
	// runtime is built before the custody can be (the custody reads the runtime's scope), so the
	// runtime is handed the lookup as a getter it re-reads on every access. The getter answers only
	// once the custody exists and while the binding is not `standalone`: on a standalone host any
	// parent lookup would make every room turn refuse, and a round there runs with no parent. The
	// lookup is one stable function, so a round that started with it is refused if it goes away.
	// A caller that supplies its own lookup keeps it, and no custody is composed.
	let roundParents: RoundParentCustody | undefined;
	let bindingState: (() => string) | undefined;
	const lookupRoundParent = (processId: string) => {
		if (!roundParents) throw new Error('The round parent custody is not composed yet.');
		return roundParents.lookup(processId);
	};
	const composesRoundParents = !!managed && !('backgroundParentContext' in managed);
	// Copied by descriptor, never spread: a getter on the composed standing stays live.
	const runtimeManaged: typeof managed =
		managed && composesRoundParents
			? Object.defineProperties(
					{},
					{
						...Object.getOwnPropertyDescriptors(managed),
						backgroundParentContext: {
							enumerable: true,
							configurable: true,
							get: () =>
								roundParents && bindingState && bindingState() !== 'standalone'
									? lookupRoundParent
									: undefined,
						},
					}
				)
			: managed;

	const started = await deps.createRuntime({
		dataDir: paths.userDataDir,
		productionDataDir: paths.productionDataDir,
		mode: 'host',
		turns: resolveRuntimeTurnOptions(options.moduleDirectory),
		...(runtimeManaged ? { managed: runtimeManaged } : {}),
	});
	if (!started.ok) throw new HostStartError(started.refusal);
	const { runtime } = started;
	if (composesRoundParents) {
		roundParents = createRoundParentCustody(runtimeManagedScope(runtime));
		bindingState = () => runtime.managedBinding.state().state;
	}

	let cue: HostCue = {
		state: () => ({ state: 'disabled' }),
		activeRuns: () => 0,
		stop: async () => undefined,
	};
	let telemetry: TelemetryClient | null = null;
	let unsubscribeTelemetryWake = (): void => undefined;
	let stopping: Promise<void> | undefined;
	let finish!: () => void;
	const stopped = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			// Unpublish first: nothing new should find a host that is going away.
			deleteCliServerInfoFrom(paths.userDataDir, deps.pid);
			// Cue first, and waited for: its runs are stopped and their processes gone before the
			// runtime closes, so none outlives the host. A failure here must not strand the rest.
			try {
				await cue.stop();
			} catch (error) {
				log(`Stopping Cue failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			unsubscribeLost();
			await server?.close();
			// No new telemetry pass; the one in flight settles its batch before the socket goes.
			unsubscribeTelemetryWake();
			telemetry?.stop();
			try {
				await telemetry?.drain();
			} catch (error) {
				log(`Draining telemetry failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			// The endpoint socket goes before the directory does; a failure here must not strand the rest.
			try {
				await managedLifecycle?.close();
			} catch (error) {
				log(
					`Closing the managed standing failed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			// The runtime stops its runs and turns, records how they ended, and releases the lock.
			await runtime.connection.close();
			log('Host stopped.');
			finish();
		})();
		return stopping;
	};

	// Losing the directory (another Maestro took it over) fences the runtime; a host with no
	// writable directory has nothing left to serve.
	const unsubscribeLost = runtime.events.subscribe(
		(event) => {
			if (event.type !== 'host.lost') return;
			log(`Lost the data directory: ${event.reason}`);
			void stop();
		},
		{ types: ['host.lost'] }
	);

	let server: RuntimeServer | undefined;
	try {
		// Re-attach before anything is served: a probe that finds this host finds its standing.
		// The outcome lives in the lifecycle's status; a dial that fails leaves the record alone.
		try {
			await managedLifecycle?.attach();
		} catch (error) {
			log(
				`Re-attaching the managed standing failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		// What reaches this host from the endpoint (MCOMP-21-03A/03B), said once: the inbox and its
		// recovered receipts, and the command ledger with what it executes. A host that composed no standing
		// composes neither and says nothing here; its reason is `managedUnavailable`.
		if (composition?.composed) {
			const inbox = composition.communications.inbox()?.status();
			log(
				inbox
					? `Managed inbox: receipts ${inbox.loaded ? `loaded (${inbox.receipts.total})` : `not loaded${inbox.load && !inbox.load.ok ? ` (${inbox.load.reason})` : ''}`}; ${inbox.standing.ok ? 'listing notices' : `no listing: ${inbox.standing.reason}`}.`
					: 'Managed inbox: not composed (the runtime holds no host adapter).'
			);
			const commands = composition.communications.commands()?.status();
			log(
				commands
					? `Managed commands: ledger ${commands.loaded ? `loaded (${commands.commands.total})` : `not loaded${commands.load && !commands.load.ok ? ` (${commands.load.reason})` : ''}`}; executes ${commands.capabilities.join(', ') || 'nothing'}; ${commands.standing.ok ? 'consuming' : `none consumed: ${commands.standing.reason}`}.`
					: 'Managed commands: not composed (the runtime holds no host adapter).'
			);
		}
		// The bridge is held before anything consumes work (MCOMP-21-03): no telemetry, no Cue, no
		// socket. A refusal throws `ListenerDeniedError` and the catch below releases the directory.
		// Installed here, over this runtime's standing: the gate otherwise has no authority headless.
		setListenerAuthority(deps.listenerAuthority(runtime));
		holdListener({ kind: 'runtime-host', bind: RUNTIME_HOST_BIND, port: options.port ?? 0 });
		// With a host adapter and a journal, the journaled events go to the endpoint from here on,
		// under whatever standing the adapter reports at each pass (MRC-10-03B).
		if (runtime.managedHost && runtime.managedEvents) {
			telemetry = createTelemetryClient({
				journal: runtime.managedEvents,
				host: runtime.managedHost,
				intervalMs: TELEMETRY_HOST_IDLE_POLL_MS,
			});
			const client = telemetry;
			unsubscribeTelemetryWake = runtime.lifecycle.subscribe(() => client.wake());
			telemetry.start();
		}
		// The inbox and command verbs over the bridge (MCOMP-29-03A): the same answer the desktop
		// bridge gives, over this standing's inbox and command service (read per call, so null before
		// the runtime acquires the adapter and after close). Every caller here was admitted on the
		// per-boot CLI secret, so an inbox act is attributed to that peer. An uncomposed host passes
		// no port and each verb is refused by name, never answered from the ledger files.
		const communications = composition?.composed
			? createManagedCommunicationsPort(
					createManagedCommunications({
						identity: composition.identity,
						inbox: composition.communications.inbox,
						commands: composition.communications.commands,
						place: HOST_PLACE,
					}),
					{ place: HOST_PLACE, actor: () => ({ peer: 'host-secret' }), log }
				)
			: undefined;
		const token = deps.randomToken();
		const cliSecret = deps.randomToken();
		cue = await deps.startCue({
			userDataDir: paths.userDataDir,
			settingsFile: paths.settingsFile,
			runtime,
		});
		server = await deps.startServer({
			runtime,
			token,
			cliSecret,
			port: options.port,
			address: RUNTIME_HOST_BIND,
			onStopRequested: () => void stop(),
			...(roundParents ? { roundParents } : {}),
			...(communications ? { communications } : {}),
			describe: () => ({
				cue: cue.state(),
				cueRuns: cue.activeRuns(),
				...(options.version ? { version: options.version } : {}),
				...(managedUnavailable ? { managedUnavailable } : {}),
			}),
		});
		writeCliServerInfoTo(paths.userDataDir, {
			port: server.port,
			token,
			pid: deps.pid,
			startedAt: deps.now(),
			cliSecret,
			hostKind: 'headless',
			...(options.version ? { version: options.version } : {}),
		});
		log(`Host serving ${paths.userDataDir} on 127.0.0.1:${server.port} (pid ${deps.pid}).`);
		const serving = server;
		return {
			runtime,
			server,
			cue,
			token,
			telemetry,
			managedComposition: composition,
			work: () => serving.work(),
			stopped,
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
