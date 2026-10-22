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
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import { startHostCue, type HostCue } from './host-cue';
import type { HostManagedLifecycle } from './host-managed';

/** The runtime refused the directory: another host, a desktop, a held lock, a corrupt store. */
export class HostStartError extends Error {
	constructor(readonly refusal: RuntimeRefusal) {
		super(refusal.message);
		this.name = 'HostStartError';
	}
}

export interface RuntimeHostOptions {
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
	createRuntime: typeof createMaestroRuntime;
	startServer: typeof startRuntimeServer;
	startCue: typeof startHostCue;
	/** Can the runtime load its bundled prompts, looked for the way it looks for them? */
	promptsLoad(moduleDirectory: string, userDataDir: string): boolean;
	randomToken(): string;
	now(): number;
	pid: number;
}

export interface RunningHost {
	readonly runtime: MaestroRuntime;
	readonly server: RuntimeServer;
	readonly cue: HostCue;
	readonly token: string;
	/** The work a stop would cut off now: what `host status` reports and a draining host waits on. */
	work(): HostWork;
	/** Settles once the host has fully stopped. */
	readonly stopped: Promise<void>;
	/** Stop everything in order and release the data directory. Idempotent. */
	stop(): Promise<void>;
}

const defaultDeps: RuntimeHostDeps = {
	createRuntime: createMaestroRuntime,
	startServer: startRuntimeServer,
	startCue: startHostCue,
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

	const started = await deps.createRuntime({
		dataDir: paths.userDataDir,
		productionDataDir: paths.productionDataDir,
		mode: 'host',
		turns: resolveRuntimeTurnOptions(options.moduleDirectory),
		...(options.managed ? { managed: options.managed } : {}),
	});
	if (!started.ok) throw new HostStartError(started.refusal);
	const { runtime } = started;

	let cue: HostCue = {
		state: () => ({ state: 'disabled' }),
		activeRuns: () => 0,
		stop: async () => undefined,
	};
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
			// The endpoint socket goes before the directory does; a failure here must not strand the rest.
			try {
				await options.managedLifecycle?.close();
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
			await options.managedLifecycle?.attach();
		} catch (error) {
			log(
				`Re-attaching the managed standing failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
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
			onStopRequested: () => void stop(),
			describe: () => ({
				cue: cue.state(),
				cueRuns: cue.activeRuns(),
				...(options.version ? { version: options.version } : {}),
				...(options.managedUnavailable ? { managedUnavailable: options.managedUnavailable } : {}),
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
		return { runtime, server, cue, token, work: () => serving.work(), stopped, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
