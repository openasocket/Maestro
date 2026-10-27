/**
 * Computer History - supervisor for the `maestro-computer-history` helper.
 *
 * The helper is a long-lived child of the main process (never detached, so it
 * dies with the app; it also exits within 1 s of stdin EOF). Argv is FIXED:
 * nothing user- or plugin-controlled reaches the command line. All control
 * goes over stdin as NDJSON commands; all data comes back as NDJSON events on
 * stdout; stderr is diagnostics only and is never parsed.
 *
 * Restart policy copies PianolaSupervisor: exponential backoff from 1 s,
 * capped at 30 s, giving up after 5 consecutive failures; a run of 60 s or
 * more resets the streak. A missing binary is a reported state
 * (`binary-missing`), not an exception: dev checkouts without the Rust
 * toolchain must still boot.
 *
 * Hostile-output guard: a line longer than `maxLineBytes` is discarded up to
 * its newline instead of growing a buffer without bound.
 *
 * Under management (MRC2-02-05) the helper is admitted before it starts:
 * `deps.managedPort` is the host's spawn authority, read on every spawn, and
 * `admitSupervisorChild` binds this process as the `computer-history` service
 * and asks the authority for a lease on the exact spawn (`purpose:
 * supervisor`). A refusal is the reported state `denied` (the authority's
 * answer in `managed`), never a restart: the backoff ladder is for a helper
 * that died, and a denied helper is asked again only by the next `start()`.
 * A revocation stops the helper and leaves it denied. With no port, or a
 * standalone standing, nothing here changes and the spawn stays synchronous.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import type { HelperCommand } from '../../shared/computer-history/types';
import type {
	ObserverProcessState,
	ObserverProcessStatus,
} from '../../shared/computer-history/status';
import {
	admitSupervisorChild,
	type SupervisedChildLifetime,
	type SupervisorChildAdmission,
	type SupervisorChildPort,
	type SupervisorChildRefusal,
} from '../../shared/maestro-lib/managed/host-adapter';
import type { DispatchSpecLike } from '../../shared/maestro-lib/managed/authority';

const MAX_RESTARTS = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const STABLE_RUN_MS = 60_000;
const SIGKILL_DELAY_MS = 3000;
const MAX_STDERR_LINES = 50;
/** Snapshots are capped at 32 KB of text; JSON escaping can roughly double it. */
export const DEFAULT_MAX_LINE_BYTES = 256 * 1024;

export const OBSERVER_BINARY_BASENAME = 'maestro-computer-history';

/** The service this supervisor binds the helper as, and the provider it is admitted under. */
export const OBSERVER_SUPERVISOR_SERVICE = 'computer-history';

/** The spawn exactly as the supervisor makes it: what the managed authority admits. */
interface ObserverLaunch extends DispatchSpecLike {
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	shell: false;
}

export type ObserverChildSpawner = (
	command: string,
	args: readonly string[],
	opts: SpawnOptions
) => ChildProcess;

export interface ObserverSupervisorDeps {
	/** Absolute path of the helper, or null when none is installed. */
	resolveBinary: () => string | null;
	/** One parsed JSON value per stdout line. */
	onMessage: (message: unknown) => void;
	/** The child is up; the caller sends `configure` here. */
	onSpawned?: () => void;
	/** Any state transition (for status broadcasts). */
	onStateChange?: () => void;
	spawnChild?: ObserverChildSpawner;
	maxLineBytes?: number;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/**
	 * The host's spawn authority (the process manager's `managedPort()`), read
	 * on every spawn so an enrollment that appears later governs the next
	 * helper. Absent or null, or a standalone standing: the supervisor spawns
	 * as it always did, synchronously and admitted by nobody.
	 */
	managedPort?: () => SupervisorChildPort | null;
}

/** Platform/arch folder name the build script writes into. */
export function observerPlatformDir(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch
): string {
	return `${platform}-${arch}`;
}

export function observerBinaryName(platform: NodeJS.Platform = process.platform): string {
	return platform === 'win32' ? `${OBSERVER_BINARY_BASENAME}.exe` : OBSERVER_BINARY_BASENAME;
}

/**
 * Candidate helper locations. A PACKAGED app uses only the signed copy in
 * `resources/native/`: falling back to a cwd- or module-relative path there
 * would let whatever sits in the launch directory run with Maestro's
 * Accessibility grant. Unpackaged (dev) builds try the build output
 * `dist/native/<platform>-<arch>/` (relative to this module and to cwd), then
 * a local cargo release build.
 */
export function observerBinaryCandidates(opts: {
	packaged: boolean;
	resourcesPath?: string;
	moduleDir: string;
	cwd: string;
	platform?: NodeJS.Platform;
	arch?: string;
}): string[] {
	const name = observerBinaryName(opts.platform);
	const dir = observerPlatformDir(opts.platform, opts.arch);
	if (opts.packaged) {
		return opts.resourcesPath ? [path.join(opts.resourcesPath, 'native', name)] : [];
	}
	const out: string[] = [];
	if (opts.resourcesPath) out.push(path.join(opts.resourcesPath, 'native', name));
	// dist/main/computer-history/*.js -> dist/native/<platform>-<arch>/
	out.push(path.resolve(opts.moduleDir, '..', '..', 'native', dir, name));
	out.push(path.resolve(opts.cwd, 'dist', 'native', dir, name));
	out.push(path.resolve(opts.cwd, 'native', 'maestro-computer-history', 'target', 'release', name));
	return out;
}

/** First candidate that exists and (on POSIX) is executable, or null. */
export function resolveObserverBinary(candidates: readonly string[]): string | null {
	const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, mode);
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

export class ObserverSupervisor {
	private readonly deps: ObserverSupervisorDeps;
	private readonly spawnChild: ObserverChildSpawner;
	private readonly maxLineBytes: number;
	private child: ChildProcess | null = null;
	private state: ObserverProcessState = 'stopped';
	private restarts = 0;
	private lastError: string | undefined;
	private startedAt: number | undefined;
	private binaryPath: string | null = null;
	private backoffTimer: ReturnType<typeof setTimeout> | undefined;
	private stderr: string[] = [];
	private wanted = false;
	private stdoutBuffer = '';
	private discarding = false;
	/** A managed admission is in flight; nothing may start beside it. */
	private admitting = false;
	/** The managed host's refusal, while the state is `denied`. */
	private managed: SupervisorChildRefusal | undefined;

	constructor(deps: ObserverSupervisorDeps) {
		this.deps = deps;
		this.spawnChild = deps.spawnChild ?? ((command, args, opts) => spawn(command, args, opts));
		this.maxLineBytes = deps.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	}

	/**
	 * Start (or keep) the helper running. Idempotent. A denied helper is asked
	 * of the managed host again here, and only here: nothing retries a refusal
	 * on a timer.
	 */
	start(): void {
		this.wanted = true;
		if (this.child || this.state === 'backing-off' || this.admitting) return;
		this.restarts = 0;
		this.spawn();
	}

	/** Stop the helper and cancel any pending restart. Idempotent. */
	stop(): void {
		this.wanted = false;
		if (this.backoffTimer) {
			clearTimeout(this.backoffTimer);
			this.backoffTimer = undefined;
		}
		const child = this.child;
		this.child = null;
		if (child && child.exitCode === null && child.signalCode === null) {
			// Ask nicely (the helper exits on `shutdown` or stdin EOF), then make sure.
			try {
				child.stdin?.write(`${JSON.stringify({ cmd: 'shutdown' } satisfies HelperCommand)}\n`);
				child.stdin?.end();
			} catch {
				// stdin already closed; the kill below covers it.
			}
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
			}, SIGKILL_DELAY_MS);
			timer.unref?.();
			child.once('exit', () => clearTimeout(timer));
		}
		this.setState('stopped');
	}

	/**
	 * Replace the running helper with a fresh process. For state a process
	 * reads once and cannot refresh, such as a macOS privacy grant.
	 */
	restart(): void {
		this.stop();
		this.start();
	}

	/** Write one command to the helper. False when it is not running. */
	send(command: HelperCommand): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return false;
		stdin.write(`${JSON.stringify(command)}\n`);
		return true;
	}

	isRunning(): boolean {
		return this.child !== null && this.state === 'running';
	}

	status(): ObserverProcessStatus {
		const out: ObserverProcessStatus = {
			state: this.state,
			restarts: this.restarts,
			binaryPath: this.binaryPath,
			recentStderr: [...this.stderr],
		};
		if (typeof this.child?.pid === 'number') out.pid = this.child.pid;
		if (this.lastError) out.lastError = this.lastError;
		if (this.startedAt) out.startedAt = this.startedAt;
		if (this.managed) out.managed = { ...this.managed };
		return out;
	}

	private setState(state: ObserverProcessState): void {
		if (this.state === state) return;
		this.state = state;
		this.deps.onStateChange?.();
	}

	/**
	 * Resolve the helper and launch it. Standalone (no port, or a standalone
	 * standing) launches synchronously, as it always did. Under management the
	 * authority is asked first and the launch follows its answer; while it
	 * answers, `start()` is a no-op.
	 */
	private spawn(): void {
		const binary = this.deps.resolveBinary();
		this.binaryPath = binary;
		if (!binary) {
			this.lastError = 'maestro-computer-history is not installed for this platform';
			this.setState('binary-missing');
			return;
		}
		// The spawn exactly as it will be made: argv is fixed and empty, the
		// environment is this process's own, so the authority admits what runs.
		const launch: ObserverLaunch = {
			command: binary,
			args: [],
			cwd: process.cwd(),
			env: { ...process.env },
			shell: false,
		};
		const port = this.deps.managedPort?.() ?? null;
		if (!port || port.standing() !== 'managed') {
			this.launch(launch, null);
			return;
		}
		this.admitting = true;
		void this.admitThenLaunch(launch, port);
	}

	/** Ask the managed host for a lease on the exact launch, then launch on its answer. */
	private async admitThenLaunch(launch: ObserverLaunch, port: SupervisorChildPort): Promise<void> {
		let admission: SupervisorChildAdmission;
		try {
			admission = await admitSupervisorChild({
				port,
				service: OBSERVER_SUPERVISOR_SERVICE,
				traceId: 'computer-history-observer',
				spec: launch,
				attribution: { target: { kind: 'local' }, resourceIds: [`binary:${launch.command}`] },
			});
		} catch (error) {
			// The authority never throws by contract; a port that does is an answer lost.
			admission = {
				state: 'unknown',
				code: 'outcome-unknown',
				message: `The managed host's answer was lost: ${error instanceof Error ? error.message : String(error)}. Nothing was started.`,
			};
		} finally {
			this.admitting = false;
		}
		// stop() ran while the authority answered: a lease nothing starts on is released unused.
		if (!this.wanted) {
			if (admission.state === 'admitted') {
				admission.lifetime.withdraw('the helper was stopped before it started');
			}
			this.setState('stopped');
			return;
		}
		if (admission.state === 'standalone') {
			this.launch(launch, null);
			return;
		}
		if (admission.state !== 'admitted') {
			this.refuse(admission);
			return;
		}
		this.launch(launch, admission.lifetime);
	}

	/**
	 * Record the managed host's refusal: the helper is `denied`, nothing runs,
	 * nothing is scheduled. Not a failure of the helper, so the restart streak
	 * is untouched and the backoff ladder is never entered.
	 */
	private refuse(refusal: SupervisorChildRefusal): void {
		this.child = null;
		this.managed = { state: refusal.state, code: refusal.code, message: refusal.message };
		this.lastError = `[managed-${refusal.state}] ${refusal.message}`;
		this.deps.log?.(
			'warn',
			`maestro-computer-history not admitted (${refusal.state}, ${refusal.code}): ${refusal.message}`
		);
		this.setState('denied');
	}

	/** Make the launch, driving the lease around the helper when one was admitted. */
	private launch(launch: ObserverLaunch, lifetime: SupervisedChildLifetime | null): void {
		if (lifetime) {
			// The lease sees exactly what spawn sees: nothing runs between the two.
			const verdict = lifetime.admit();
			if (!verdict.ok) {
				this.refuse(verdict);
				return;
			}
		}
		let child: ChildProcess;
		try {
			child = this.spawnChild(launch.command, launch.args, {
				cwd: launch.cwd,
				env: launch.env,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
				// Not detached: the helper must die with the app.
			});
		} catch (error) {
			lifetime?.spawnFailed(error instanceof Error ? error : new Error(String(error)));
			this.lastError = error instanceof Error ? error.message : String(error);
			this.scheduleRestart();
			return;
		}
		this.child = child;
		this.startedAt = Date.now();
		this.stdoutBuffer = '';
		this.discarding = false;
		this.managed = undefined;
		this.setState('running');
		// The process exists: the protected lifetime begins, and a revocation
		// from here on stops it and leaves the helper denied.
		lifetime?.spawned(child);
		let revokedReason: string | null = null;
		const unsubscribe = lifetime?.onRevoked((reason) => {
			if (revokedReason !== null) return;
			revokedReason = reason;
			this.deps.log?.('warn', `maestro-computer-history lease revoked, stopping it: ${reason}`);
			if (this.child === child) this.stop();
		});

		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => this.onStderr(chunk));
		// EPIPE on a dying child's stdin must not crash the main process.
		child.stdin?.on('error', (err) => {
			this.deps.log?.('warn', `observer stdin error: ${err.message}`);
		});
		child.on('error', (err) => {
			this.lastError = err.message;
			this.deps.log?.('warn', `observer process error: ${err.message}`);
			// 'exit' may never follow a spawn failure (ENOENT, EACCES).
			if (this.child === child && child.pid === undefined) {
				unsubscribe?.();
				lifetime?.spawnFailed(err);
				this.child = null;
				this.scheduleRestart();
			}
		});
		child.on('exit', (code, signal) => {
			unsubscribe?.();
			lifetime?.exited({
				exitCode: code,
				signal,
				stoppedBy:
					revokedReason !== null ? 'authority' : this.child !== child ? 'caller' : undefined,
			});
			// The managed host revoked the lease: stopped by the authority, denied
			// from here on, never restarted.
			if (revokedReason !== null) {
				// A helper started since (by a later start()) is not this one's business.
				if (this.child === null) {
					this.flushStdout();
					this.refuse({
						state: 'denied',
						code: 'lease-invalid',
						message: `The managed host revoked the helper's lease: ${revokedReason}. It was stopped and is not restarted.`,
					});
				}
				return;
			}
			if (this.child !== child) return; // stop() already let go of it
			this.child = null;
			this.flushStdout();
			if (!this.wanted) {
				this.setState('stopped');
				return;
			}
			if (this.startedAt && Date.now() - this.startedAt >= STABLE_RUN_MS) this.restarts = 0;
			this.lastError = signal ? `killed by signal ${signal}` : `exited with code ${code ?? 'null'}`;
			this.deps.log?.('warn', `maestro-computer-history ${this.lastError}`);
			this.scheduleRestart();
		});

		this.deps.onSpawned?.();
	}

	private scheduleRestart(): void {
		if (!this.wanted) {
			this.setState('stopped');
			return;
		}
		this.restarts += 1;
		if (this.restarts > MAX_RESTARTS) {
			this.setState('failed');
			this.deps.log?.(
				'error',
				`maestro-computer-history failed after ${MAX_RESTARTS} restarts; giving up`
			);
			return;
		}
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.restarts - 1), BACKOFF_CAP_MS);
		this.setState('backing-off');
		this.backoffTimer = setTimeout(() => {
			this.backoffTimer = undefined;
			if (!this.wanted) {
				this.setState('stopped');
				return;
			}
			this.spawn();
		}, delay);
	}

	private onStdout(chunk: string): void {
		let data = chunk;
		while (data.length > 0) {
			const nl = data.indexOf('\n');
			if (this.discarding) {
				if (nl === -1) return;
				this.discarding = false;
				data = data.slice(nl + 1);
				continue;
			}
			if (nl === -1) {
				this.stdoutBuffer += data;
				if (this.stdoutBuffer.length > this.maxLineBytes) {
					this.deps.log?.('warn', 'observer line exceeded the length cap; discarded');
					this.stdoutBuffer = '';
					this.discarding = true;
				}
				return;
			}
			const line = this.stdoutBuffer + data.slice(0, nl);
			this.stdoutBuffer = '';
			data = data.slice(nl + 1);
			if (line.length > this.maxLineBytes) {
				this.deps.log?.('warn', 'observer line exceeded the length cap; discarded');
				continue;
			}
			this.dispatchLine(line);
		}
	}

	private flushStdout(): void {
		const rest = this.stdoutBuffer;
		this.stdoutBuffer = '';
		if (rest && !this.discarding) this.dispatchLine(rest);
		this.discarding = false;
	}

	private dispatchLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			this.deps.log?.('warn', 'observer emitted a line that is not JSON; ignored');
			return;
		}
		this.deps.onMessage(parsed);
	}

	private onStderr(chunk: string): void {
		for (const line of chunk.split('\n')) {
			if (!line.trim()) continue;
			this.stderr.push(line.length > 500 ? `${line.slice(0, 500)}...` : line);
		}
		if (this.stderr.length > MAX_STDERR_LINES) {
			this.stderr = this.stderr.slice(this.stderr.length - MAX_STDERR_LINES);
		}
	}
}
