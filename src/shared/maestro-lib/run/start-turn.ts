// src/shared/maestro-lib/run/start-turn.ts

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'node:string_decoder';

import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { createOutputParser } from '../parsers/parser-factory';
import { BufferedLineReader } from '../streaming/buffered-line-reader';
import {
	stopProcess,
	trackProcessTree,
	type StopHandle,
	type StopStage,
} from '../control/termination';
import type { AgentLaunchPlan } from '../launch/launch-plan';
import type { PromptDelivery } from '../launch/prompt-delivery';
import { logger } from '../host';
import { quoteCommandForCmdShell, windowsShellReason } from '../launch/windows-command';
import { escapeCmdArgs } from '../launch/windows-shell-escape';
import { isWindows } from '../../platformDetection';
import {
	buildDispatchSnapshot,
	dispatchSnapshotDigest,
	type DispatchAttribution,
	type DispatchLease,
	type DispatchSnapshot,
	type HostAuthority,
} from '../managed/authority';
import type { ManagedDenialCode } from '../managed/types';

/**
 * A sensible cap on one buffered stdout line, for a caller that wants one.
 * `startTurn` itself buffers without limit unless told otherwise.
 */
export const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

/** How much stdout is kept for exit classification; providers only pattern-match it. */
export const DEFAULT_STDOUT_TAIL_LIMIT = 256 * 1024;

/**
 * A sensible cap on the stderr kept for exit classification, for a caller that
 * wants one. `startTurn` itself keeps all of it unless told otherwise.
 */
export const DEFAULT_STDERR_TAIL_LIMIT = 256 * 1024;

/** Exactly what to start: the last word after planning and any SSH or wrapper step. */
export interface TurnProcessSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/**
	 * Written to the child's stdin, which is then closed: a prompt the launch
	 * plan chose to deliver over stdin, or the script an SSH remote runs.
	 */
	stdin?: string;
	/** Private local artifact, created exclusively at the sink and removed after the reader closes. */
	promptArtifact?: Extract<PromptDelivery, { via: 'file' }>['artifact'];
	/**
	 * Run the command through a shell: `true` for the platform default, or the
	 * shell's path. Needed on Windows for a bare `.exe` name (PATH resolution),
	 * a `.cmd` / `.bat` shim, or a shebang script; `applyWindowsShellRules`
	 * sets it, with the command and args prepared for that shell.
	 */
	shell?: boolean | string;
	/**
	 * A bidirectional protocol process (`grokAcpProcessSpec`). Only its protocol driver
	 * may start it: open stdin, no prompt bytes, no output-only parser.
	 */
	transport?: 'acp-stdio';
}

/**
 * An own, frozen copy of a spec: the command, every argument, every
 * environment entry, the stdin text and the shell choice as they are at this
 * instant (MCOMP-09-02). What an admission sees is this copy and what
 * `startTurn` spawns is this copy, so no reference the caller still holds (the
 * plan's argument array, the environment the spec was built from) can change
 * the effect after the authority has seen it, however long the admission is
 * awaited. A spec that is already frozen through is returned as it is. The
 * private prompt artifact (its bytes, path and mode) and the ACP transport
 * word are part of the effect, so they are carried and frozen too.
 */
export function freezeTurnProcessSpec(spec: TurnProcessSpec): Readonly<TurnProcessSpec> {
	if (
		Object.isFrozen(spec) &&
		Object.isFrozen(spec.args) &&
		Object.isFrozen(spec.env) &&
		(spec.promptArtifact === undefined || Object.isFrozen(spec.promptArtifact))
	) {
		return spec;
	}
	return Object.freeze({
		command: spec.command,
		args: Object.freeze([...spec.args]) as string[],
		cwd: spec.cwd,
		env: Object.freeze({ ...spec.env }),
		...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
		...(spec.promptArtifact !== undefined
			? { promptArtifact: Object.freeze({ ...spec.promptArtifact }) }
			: {}),
		...(spec.shell !== undefined ? { shell: spec.shell } : {}),
		...(spec.transport !== undefined ? { transport: spec.transport } : {}),
	});
}

export interface WindowsShellRulesOptions {
	/** Defaults to the real host. Injected by tests. */
	isWindowsHost?: boolean;
}

/**
 * Prepare a spec for a command Windows can only start through a shell, by the
 * same rules the desktop's ChildProcessSpawner applies: a `.cmd` / `.bat`
 * shim (Node refuses it without a shell, `spawn EINVAL`), a bare `.exe` name,
 * or a shebang script turns the cmd.exe shell on, every argument is escaped
 * with `escapeCmdArgs()`, and a command path with spaces is quoted.
 *
 * Returns the spec unchanged off Windows, for a command that starts directly,
 * and for a spec that already names its `shell`: that caller has prepared the
 * command line itself. So applying it twice changes nothing.
 *
 * It does not move the prompt. cmd.exe cannot carry a line break, `%` or `^`
 * in an argument (`cmdShellArgProblem()`), so a prompt bound for a shell
 * launch belongs on stdin; `planSessionTurn` arranges that.
 */
export function applyWindowsShellRules(
	spec: TurnProcessSpec,
	options: WindowsShellRulesOptions = {}
): TurnProcessSpec {
	if (spec.shell !== undefined) return spec;
	if (!(options.isWindowsHost ?? isWindows())) return spec;
	if (windowsShellReason(spec.command).reason === null) return spec;
	return {
		...spec,
		command: quoteCommandForCmdShell(spec.command),
		args: escapeCmdArgs(spec.args),
		shell: true,
	};
}

/** A launch plan for this machine: the one kind that carries a full environment. */
export type LocalLaunchPlan = Extract<AgentLaunchPlan, { env: NodeJS.ProcessEnv }>;

/**
 * The process spec for a LOCAL launch plan, ready to start on this host: on
 * Windows a command that needs a shell gets one (`applyWindowsShellRules`). A
 * remote plan describes the remote invocation, so it goes through the SSH
 * wrapper first and the caller builds the spec from what that returns.
 */
export function turnProcessSpecFromPlan(
	plan: LocalLaunchPlan,
	options: WindowsShellRulesOptions = {}
): TurnProcessSpec {
	return applyWindowsShellRules(
		{
			command: plan.command,
			args: plan.args,
			cwd: plan.cwd,
			env: plan.env,
			stdin: plan.stdin,
			...(plan.prompt.via === 'file' ? { promptArtifact: { ...plan.prompt.artifact } } : {}),
		},
		options
	);
}

/**
 * What the caller hears while the turn runs. Every handler for a given chunk
 * has returned before the next chunk is read, and every handler has returned
 * before `done` resolves, so a caller that settles on `done` has seen it all.
 */
export interface TurnHandlers {
	/** The process was started. Fires once, before any output. */
	onStarted?(pid: number | undefined): void;
	/** Each stdout chunk as it arrived, before it is split into lines. */
	onStdout?(text: string): void;
	onStderr?(text: string): void;
	/** Original pipe bytes, before UTF-8 decoding. Opts that pipe out of setEncoding. */
	onStdoutBytes?(chunk: Uint8Array): void;
	onStderrBytes?(chunk: Uint8Array): void;
	/** Synchronous invalidation before signals reach the process. Must not throw or stop again. */
	onStopRequested?(by: 'caller' | 'authority'): void;
	/** Each complete stdout line, including an unterminated last one at exit. */
	onLine?(line: string): void;
	/** Each line the provider's parser understood. */
	onEvent?(event: ParsedEvent, line: string): void;
	/**
	 * Output was discarded because no complete line arrived within
	 * `maxLineLength`. Dropping is silent data loss otherwise.
	 */
	onOversizedLine?(droppedBytes: number): void;
	/**
	 * The child's stdin failed. EPIPE is the common one: a prompt written to a
	 * process that has already gone. It is reported here and never thrown; the
	 * exit that follows says what happened to the turn.
	 */
	onStdinError?(error: Error): void;
}

/**
 * The managed admission at the sink. `admit` is synchronous and runs with the
 * snapshot of the FINAL spec, the instant before `spawn`: there is nothing
 * between the two for a replacement to slip through. For a prompt artifact,
 * it also checks before any file is created; `admit` must support rechecking
 * an unbound lease. A refusal throws
 * `DispatchRefusedError` out of `startTurn` before spawn and cleans any prepared artifact; an admission
 * is followed by `bound` (the pid), and by `released` once the process is
 * gone. A revocation heard through `onRevoked` while bound terminates the
 * process, and the exit says the authority stopped it, not the caller.
 */
export interface DispatchAdmission {
	admit(snapshot: DispatchSnapshot): DispatchAdmissionVerdict;
	bound?(pid: number | undefined): void;
	released?(exit: TurnExit): void;
	onRevoked?(listener: (reason: string) => void): () => void;
}

export type DispatchAdmissionState = 'denied' | 'unavailable' | 'unknown';

export type DispatchAdmissionVerdict =
	| { ok: true }
	| { ok: false; state: DispatchAdmissionState; code: ManagedDenialCode; message: string };

/**
 * The host's standing at the spawn sink (MCOMP-09-02): what every `startTurn`
 * in this process is measured against the instant before `spawn`, whatever
 * its caller passed or left out. A host that holds a managed binding installs
 * it once (the library runtime over its binding and attached host; a desktop
 * over its enterprise service) and releases it when it shuts down. It is read
 * at every spawn, never cached here, so an enrollment that landed after the
 * install counts at the next launch. Nothing installed is a host that holds
 * no binding at all: the explicit standalone this sink has always run as, and
 * the one compatibility it keeps. Under a managed standing a launch runs on
 * an admission `leaseAdmission()` minted over the authority answering now, or
 * not at all: no admission, a gate minted elsewhere, or no authority answering
 * is refused before any effect, and none of them falls back to a plain spawn.
 */
export interface TurnSinkStanding {
	/** `managed`: the installation is enrolled, whether or not anything answers for it now. */
	standing(): 'standalone' | 'managed';
	/** The id of the authority answering for the installation now; null when none does. */
	authorityId(): string | null;
}

let installedStanding: TurnSinkStanding | null = null;

/**
 * Install the host's standing at the sink. Returns the release, which clears
 * the install only while it is still the current one, so a host that is
 * replaced by another in the same process (one runtime after another in a
 * test) does not clear its successor's word on its way out.
 */
export function installTurnSinkStanding(standing: TurnSinkStanding): () => void {
	installedStanding = standing;
	return () => {
		if (installedStanding === standing) installedStanding = null;
	};
}

/** The standing installed at the sink, or null when no host has installed one. */
export function turnSinkStanding(): TurnSinkStanding | null {
	return installedStanding;
}

/** The authority each `leaseAdmission()` gate was minted over, by the gate's identity. */
const gateAuthority = new WeakMap<DispatchAdmission, string>();

/**
 * The id of the authority a gate was minted over by `leaseAdmission()`, or
 * null for any other object: a gate written by hand has no provenance the
 * sink can read, so under a managed standing it admits nothing.
 */
export function leaseAdmissionAuthority(gate: DispatchAdmission): string | null {
	return gateAuthority.get(gate) ?? null;
}

/**
 * The admission an admitted lease makes at the sink: re-check the lease
 * against the digest of the FINAL snapshot the instant before `spawn`, bind
 * the pid, release with the exit (spawn failure, a stop and who asked for
 * it, or the exit code and signal), and hear a revocation. The one gate
 * every lease-backed sink uses (`runAgentTurn`, the harness dispatch, the
 * CLI spawner), so a caller cannot forget a step of the lifetime. The gate
 * remembers the authority of the lease it was minted over, which is what the
 * sink reads under a managed standing (`leaseAdmissionAuthority`).
 */
export function leaseAdmission(
	authority: Pick<HostAuthority, 'check'>,
	lease: DispatchLease
): DispatchAdmission {
	const gate: DispatchAdmission = {
		admit(final) {
			const verdict = authority.check(lease, dispatchSnapshotDigest(final));
			if (verdict.ok) return { ok: true };
			return {
				ok: false,
				state: 'denied',
				code: 'lease-invalid',
				message: `The lease for this launch is ${verdict.reason}.`,
			};
		},
		bound: (pid) => lease.bind(pid),
		released: (exit) =>
			lease.release(
				exit.spawnError
					? { outcome: 'spawn-failed', message: exit.spawnError.message }
					: exit.stoppedBy
						? { outcome: 'stopped', by: exit.stoppedBy }
						: { outcome: 'exited', exitCode: exit.exitCode, signal: exit.signal }
			),
		onRevoked: (listener) => lease.onRevoked(listener),
	};
	gateAuthority.set(gate, lease.authorityId);
	return gate;
}

/**
 * What the installed standing says of one launch's admission, the instant
 * before `spawn` (MCOMP-09-02): nothing, when no standing is installed or it
 * reads standalone; else the refusal. Under a managed standing an omitted
 * admission is refused as unavailable (nothing can run it plain), a gate not
 * minted by `leaseAdmission()` or minted over another authority is refused
 * as an invalid lease, and a standing with no authority answering refuses
 * every launch as unavailable.
 */
function sinkStandingRefusal(
	admission: StartTurnOptions['admission']
): DispatchRefusedError | undefined {
	const standing = installedStanding;
	if (!standing || standing.standing() !== 'managed') return undefined;
	if (!admission) {
		return new DispatchRefusedError(
			'unavailable',
			'runtime-unavailable',
			'This installation is enrolled and the launch carries no admission, so nothing was started: a process on an enrolled host runs under a lease from the authority answering for the installation, or not at all.'
		);
	}
	const live = standing.authorityId();
	if (live === null) {
		return new DispatchRefusedError(
			'unavailable',
			'runtime-unavailable',
			'This installation is enrolled and no authority answers for it now, so nothing was started.'
		);
	}
	const minted = leaseAdmissionAuthority(admission.gate);
	if (minted === null) {
		return new DispatchRefusedError(
			'denied',
			'lease-invalid',
			`The admission for this launch was not minted by leaseAdmission() over the authority answering for this installation (${live}), so nothing was started.`
		);
	}
	if (minted !== live) {
		return new DispatchRefusedError(
			'denied',
			'lease-invalid',
			`The lease for this launch was minted by authority ${minted}, and ${live} answers for this installation now, so nothing was started.`
		);
	}
	return undefined;
}

/** Thrown by `startTurn` when admission refuses. Nothing spawned; owned preparation is cleaned. */
export class DispatchRefusedError extends Error {
	constructor(
		readonly state: DispatchAdmissionState,
		readonly code: ManagedDenialCode,
		message: string
	) {
		super(message);
		this.name = 'DispatchRefusedError';
	}
}

export interface StartTurnOptions {
	/**
	 * The managed admission to ask right before the spawn, with the attribution
	 * the spec does not carry. Absent: an unmanaged turn, admitted by nobody,
	 * which only a host with no managed standing installed runs; under a
	 * managed standing (`installTurnSinkStanding`) the omission is refused
	 * before any effect, never run plain.
	 */
	admission?: { gate: DispatchAdmission; attribution: DispatchAttribution };
	/**
	 * The provider whose parser reads the stream. Each turn gets its OWN parser
	 * instance: parsers keep per-stream state, and two turns of one provider
	 * sharing an instance would read each other's. Omit for output that is not
	 * parsed.
	 */
	agentId?: string;
	/**
	 * The parser to read the stream with, for a caller that built it before
	 * starting (to fail fast on an unknown provider). Wins over `agentId`.
	 */
	parser?: AgentOutputParser;
	/** How long each stop stage gets before the next one runs. */
	stopGraceMs: number;
	/**
	 * Observe POSIX descendants throughout the turn so cancellation after the
	 * parent exits can still stop recorded tools holding its pipes. Not a strict
	 * containment guarantee: unobserved descendants and Windows need host support.
	 */
	trackDescendants?: boolean;
	/** Aborting this stops the turn, from `terminate`. */
	signal?: AbortSignal;
	/**
	 * What the child gets for stdin when there is nothing to write. `pipe`
	 * opens one and closes it at once; `ignore` gives it the null device, for a
	 * CLI that announces it is waiting on stdin before it notices the close.
	 */
	emptyStdin?: 'pipe' | 'ignore';
	/**
	 * Leave stdin open after writing (or with nothing written), for a process
	 * the caller keeps talking to through `TurnHandle.child.stdin`: an
	 * interactive agent that reads its prompts as they come.
	 */
	keepStdinOpen?: boolean;
	/**
	 * Longest partial line held before it is dropped, to bound memory against
	 * a stream that never ends a line. No limit when omitted.
	 */
	maxLineLength?: number;
	/**
	 * How much of stdout `TurnExit.stdoutText` keeps: the most recent
	 * characters. `0` keeps none, for a caller that reads the stream through
	 * its handlers and holds its own copy.
	 */
	stdoutTailLimit?: number;
	/**
	 * How much of stderr `TurnExit.stderrText` keeps: the most recent
	 * characters. No limit when omitted, because a caller may show the text as
	 * its error message. `0` keeps none.
	 */
	stderrTailLimit?: number;
	sessionId?: string;
	label?: string;
}

/** What is known about the turn once its process is gone. */
export interface TurnExit {
	/** Null when a signal ended the process, or when it never started. */
	exitCode: number | null;
	/** The signal that ended the process, as the OS reported it. */
	signal: NodeJS.Signals | null;
	/** A stop was requested through the handle or the abort signal. */
	interrupted: boolean;
	/** Who asked for the stop, when one was: the caller (handle or signal) or the managed authority. */
	stoppedBy?: 'caller' | 'authority';
	/** All of stderr, or its tail when `stderrTailLimit` is set. */
	stderrText: string;
	/** A bounded tail of stdout. */
	stdoutText: string;
	/** Bytes discarded because no complete line arrived within `maxLineLength`. */
	droppedOutputBytes: number;
	/** Set when the process could not be started. */
	spawnError?: Error;
	/**
	 * Set when writing the prompt to stdin failed, most often EPIPE from a
	 * process that closed its end before reading it. The agent never got the
	 * whole prompt, so the turn is not a success whatever its exit code says.
	 */
	stdinError?: Error;
}

export interface TurnHandle {
	readonly pid: number | undefined;
	/**
	 * The process itself, for a caller that tracks its runs by handle (a process
	 * registry). Stop it through this object's methods, not through the child.
	 */
	readonly child: ChildProcess;
	/** The parser reading this turn's stream, if any. */
	readonly parser: AgentOutputParser | null;
	/** Stop the way a user does: interrupt, then terminate, then kill the tree. */
	interrupt(): void;
	/** Stop without the interrupt stage: a timeout, a closed tab, an aborted run. */
	terminate(): void;
	/**
	 * Stop at once, for a host that is about to exit. Runs every stage with no
	 * grace period; `blocking` also waits for `taskkill` on Windows.
	 */
	terminateNow(options?: { blocking?: boolean }): void;
	stopRequested(): boolean;
	readonly done: Promise<TurnExit>;
}

/** `current + chunk`, cut to its last `limit` characters. No cut when `limit` is undefined. */
function appendBoundedTail(current: string, chunk: string, limit: number | undefined): string {
	if (limit === 0) return '';
	const combined = current + chunk;
	if (limit === undefined || combined.length <= limit) return combined;
	return combined.slice(combined.length - limit);
}

/**
 * Start one agent turn and stream it.
 *
 * This is the part every launcher used to write for itself: start the process,
 * deliver the prompt, decode and frame stdout, parse each line, stop on
 * request, and report how the process ended. It decides nothing about whether
 * the turn SUCCEEDED; the caller resolves that from `TurnExit` with its own
 * policy (`resolveTurnOutcome`), and keeps its own timeouts.
 *
 * Throws when the process cannot even be created (a bad option). A command
 * that does not exist is reported through `done` as `spawnError`, since the OS
 * only says so after `spawn` has returned.
 */
export function startTurn(
	spec: TurnProcessSpec,
	handlers: TurnHandlers,
	options: StartTurnOptions
): TurnHandle {
	// The final spec is this copy and no other: frozen before the standing or
	// the admission reads it, spawned as read (MCOMP-09-02). The gate may call
	// host code; the frozen copy keeps its callbacks from replacing the bytes,
	// destination or launch inputs between preparation and the final admission.
	const final = freezeTurnProcessSpec(spec);
	// A routed ACP process started as a one-shot turn would get a closed stdin and an
	// output-only parser: a parallel unmanaged run that silently drops its interactions.
	if (
		final.transport === 'acp-stdio' &&
		(!options.keepStdinOpen ||
			final.stdin !== undefined ||
			final.promptArtifact ||
			options.parser ||
			options.agentId)
	) {
		throw new Error('An ACP process can only be started by its protocol driver.');
	}
	const artifact = final.promptArtifact;
	let artifactFd: number | undefined;
	const removeArtifact = (): void => {
		if (!artifact || artifactFd === undefined) return;
		try {
			const ownedArtifact = fs.fstatSync(artifactFd);
			const current = fs.lstatSync(artifact.path);
			if (current.dev !== ownedArtifact.dev || current.ino !== ownedArtifact.ino) {
				logger.warn('Prompt artifact changed ownership; cleanup skipped.', 'startTurn');
				return;
			}
			fs.unlinkSync(artifact.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				// OS errors include the private path. Never forward them to logs.
				logger.warn('Could not remove an owned prompt artifact.', 'startTurn');
			}
		} finally {
			try {
				fs.closeSync(artifactFd);
			} catch {
				logger.warn('Could not close an owned prompt artifact.', 'startTurn');
			}
			artifactFd = undefined;
		}
	};
	const hasStdin = final.stdin !== undefined && final.stdin !== '';
	const stdinMode = hasStdin ? 'pipe' : (options.emptyStdin ?? 'pipe');

	// The host's standing first (MCOMP-09-02): under a managed standing a launch
	// with no admission, or with one the live authority did not mint, is refused
	// here, before any effect, and never spawned plain.
	const refused = sinkStandingRefusal(options.admission);
	if (refused) throw refused;

	// The admission sees exactly what spawn sees: the snapshot is built from
	// the final spec, here, and nothing runs between the verdict and the spawn.
	const gate = options.admission?.gate;
	const admit = (): void => {
		if (options.admission) {
			const { attribution } = options.admission;
			const verdict = options.admission.gate.admit(buildDispatchSnapshot(final, attribution));
			if (!verdict.ok) throw new DispatchRefusedError(verdict.state, verdict.code, verdict.message);
		}
	};

	// Construct the parser before owning a file or child, so a constructor
	// failure cannot leave either without a settlement handler.
	const parser = options.parser ?? (options.agentId ? createOutputParser(options.agentId) : null);
	let child: ChildProcess;
	try {
		if (artifact) {
			if (
				artifact.owner !== 'local' ||
				!path.isAbsolute(artifact.path) ||
				artifact.path.includes('\0') ||
				artifact.encoding !== 'utf8' ||
				artifact.mode !== 0o600 ||
				artifact.flag !== 'wx' ||
				artifact.cleanup !== 'turn' ||
				typeof artifact.content !== 'string' ||
				final.stdin !== undefined
			) {
				throw new Error('Prompt-file delivery requires an exclusive local artifact without stdin.');
			}
			if (options.signal?.aborted)
				throw new Error('Prompt-file launch was cancelled before spawn.');
			admit();
			if (options.signal?.aborted)
				throw new Error('Prompt-file launch was cancelled before spawn.');
			try {
				// Register ownership immediately after exclusive creation. Retain
				// the descriptor until cleanup can compare its inode with the path;
				// a failed write, collision or replacement must not delete another file.
				artifactFd = fs.openSync(artifact.path, artifact.flag, artifact.mode);
				fs.writeFileSync(artifactFd, artifact.content, artifact.encoding);
			} catch {
				throw new Error('Could not prepare the private prompt artifact.');
			}
		}
		admit();
		if (artifact && options.signal?.aborted) {
			throw new Error('Prompt-file launch was cancelled before spawn.');
		}
		child = spawn(final.command, final.args, {
			cwd: final.cwd,
			env: final.env,
			shell: final.shell ?? false,
			stdio: [stdinMode, 'pipe', 'pipe'],
		});
	} catch (error) {
		removeArtifact();
		throw error;
	}
	const finishTracking = options.trackDescendants ? trackProcessTree(child) : undefined;

	const tailLimit = options.stdoutTailLimit ?? DEFAULT_STDOUT_TAIL_LIMIT;

	let droppedOutputBytes = 0;
	const lineReader = new BufferedLineReader({
		maxBufferLength: options.maxLineLength,
		onOversized: (dropped) => {
			droppedOutputBytes += dropped;
			handlers.onOversizedLine?.(dropped);
		},
	});

	let stdoutText = '';
	let stderrText = '';
	let stdinError: Error | undefined;
	let stopWasRequested = false;
	let stoppedBy: 'caller' | 'authority' | undefined;
	let settled = false;
	let stopLadder: StopHandle | undefined;

	const stop = (
		from: StopStage,
		extra: { immediate?: boolean; blocking?: boolean; by?: 'caller' | 'authority' } = {}
	): void => {
		if (settled) return;
		const { by = 'caller', ...rest } = extra;
		stopLadder = stopProcess(
			{ child },
			{
				from,
				graceMs: options.stopGraceMs,
				onStopRequested: () => {
					stopWasRequested = true;
					stoppedBy ??= by;
					handlers.onStopRequested?.(by);
				},
				sessionId: options.sessionId,
				label: options.label,
				...rest,
			}
		);
	};

	const readLine = (line: string): void => {
		handlers.onLine?.(line);
		if (!parser || !handlers.onEvent) return;
		const event = parser.parseJsonLine(line);
		if (event) handlers.onEvent(event, line);
	};

	// A caller that takes only the raw stream (desktop chat, which frames it
	// itself) has no use for lines, so none are buffered for it.
	const framesLines = Boolean(handlers.onLine || handlers.onEvent);

	const onAbort = (): void => stop('terminate');
	// A revoked lease stops the process; the authority owns that stop.
	const unsubscribeRevocation = gate?.onRevoked?.(() => stop('terminate', { by: 'authority' }));

	const done = new Promise<TurnExit>((resolve) => {
		const settle = (exit: Pick<TurnExit, 'exitCode' | 'signal' | 'spawnError'>): void => {
			if (settled) return;
			settled = true;
			options.signal?.removeEventListener('abort', onAbort);
			unsubscribeRevocation?.();
			// The ladder ends itself when the process exits. This covers a turn
			// that settles with no exit to hear: a process that never started.
			stopLadder?.dispose();
			const turnExit: TurnExit = {
				...exit,
				interrupted: stopWasRequested,
				...(stoppedBy ? { stoppedBy } : {}),
				stderrText,
				stdoutText,
				droppedOutputBytes,
				...(stdinError ? { stdinError } : {}),
			};
			const release = (): void => {
				removeArtifact();
				gate?.released?.(turnExit);
				resolve(turnExit);
			};
			// Preserve normal stream draining, then join any pending ownership
			// observation/sweep before releasing the lease exactly once.
			if (finishTracking) void finishTracking().then(release);
			else release();
		};

		// Decode on the stream, not per chunk: a multibyte character split across
		// two reads would otherwise decode to replacement characters on both
		// sides of the boundary.
		const stdoutDecoder = handlers.onStdoutBytes ? new StringDecoder('utf8') : undefined;
		const stderrDecoder = handlers.onStderrBytes ? new StringDecoder('utf8') : undefined;
		if (!stdoutDecoder) child.stdout?.setEncoding('utf8');
		if (!stderrDecoder) child.stderr?.setEncoding('utf8');

		const readStdout = (text: string): void => {
			stdoutText = appendBoundedTail(stdoutText, text, tailLimit);
			handlers.onStdout?.(text);
			if (framesLines) for (const line of lineReader.push(text)) readLine(line);
		};

		const readStderr = (text: string): void => {
			stderrText = appendBoundedTail(stderrText, text, options.stderrTailLimit);
			handlers.onStderr?.(text);
		};
		child.stdout?.on('data', (chunk: Buffer | string) => {
			if (stdoutDecoder) {
				handlers.onStdoutBytes!(chunk as Buffer);
				const text = stdoutDecoder.write(chunk as Buffer);
				if (text) readStdout(text);
			} else readStdout(chunk as string);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			if (stderrDecoder) {
				handlers.onStderrBytes!(chunk as Buffer);
				const text = stderrDecoder.write(chunk as Buffer);
				if (text) readStderr(text);
			} else readStderr(chunk as string);
		});

		// `close`, not `exit`: it fires once the streams have ended, so every
		// line the process wrote has been read by the time the turn settles.
		child.on('close', (exitCode, signal) => {
			const stdoutEnd = stdoutDecoder?.end();
			const stderrEnd = stderrDecoder?.end();
			if (stdoutEnd) readStdout(stdoutEnd);
			if (stderrEnd) readStderr(stderrEnd);
			// The last line may have no trailing newline.
			const trailing = lineReader.flush();
			if (trailing) readLine(trailing);
			// Node reports each as a value or null. Anything else is "none".
			settle({ exitCode: exitCode ?? null, signal: signal ?? null });
		});

		child.on('error', (error) => {
			// A failed signal can emit `error` on a process that did start. Keep
			// ownership and drain its pipes; only a spawn failure releases here.
			if ((options.trackDescendants || artifact) && child.pid !== undefined) {
				stop('terminate');
				return;
			}
			settle({ exitCode: null, signal: null, spawnError: error });
		});
	});

	gate?.bound?.(child.pid);
	handlers.onStarted?.(child.pid);

	// A stream error with no listener is an uncaught exception, and it would
	// take the host down with it. The process closing its end of the pipe
	// before the prompt is written (EPIPE) is an ordinary way for a turn to
	// fail, and the exit that follows reports it.
	child.stdin?.on('error', (error) => handlers.onStdinError?.(error));

	// Only the prompt's own write counts against the turn. A later write by a
	// caller that keeps stdin open is that caller's to report.
	if (hasStdin) {
		child.stdin?.write(final.stdin, (error) => {
			if (error) stdinError ??= error;
		});
	}
	if (!options.keepStdinOpen) child.stdin?.end();

	if (options.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener('abort', onAbort, { once: true });
	}

	return {
		pid: child.pid,
		child,
		parser,
		interrupt: () => stop('interrupt'),
		terminate: () => stop('terminate'),
		terminateNow: ({ blocking = false } = {}) => stop('terminate', { immediate: true, blocking }),
		stopRequested: () => stopWasRequested,
		done,
	};
}
