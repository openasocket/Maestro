// The control channel maestro-p listens on so a running turn can be steered.
//
// Transport: a unix domain socket (a named pipe on Windows - `net` covers both
// with one API), path handed in through MAESTRO_P_STEERING_SOCKET. Absent means
// no channel is opened at all, which is the default: a turn nobody can steer
// should not create a socket.
//
// Why not stdin, which already reaches the process
// ------------------------------------------------
// maestro-p reads a piped prompt with a SYNCHRONOUS read to EOF
// (`fs.readFileSync(0, 'utf-8')` in args.ts), and that is the path Maestro uses
// for every image turn (`--input-format stream-json`). stdin is therefore fully
// consumed before the turn even starts, so a control frame written there could
// never be seen. The spawner also calls `stdin.end()` immediately after writing
// the prompt. Reworking that read into a streaming parser would mean changing how
// every prompt arrives - a large blast radius for a channel that does not need to
// share a pipe with the prompt.
//
// Framing: newline-delimited JSON, one frame per line, in both directions. A
// frame that does not parse is ignored rather than fatal - this socket is
// reachable by anything with the path, and a malformed line must not be able to
// kill a turn that is midway through real work.
//
// Who may steer (MRC2-03-06)
// --------------------------
// The channel is local by construction: `net` listens on a filesystem path or a
// named pipe, never a TCP port, and `isLocalSocketPath` refuses the one string
// shape `net` would read as a port. Reachability is not authorization, though:
// anything with the path can connect. So a frame carries the run's token when
// the host sent one (`STEERING_TOKEN_ENV_VAR`), and under a managed admission
// it also names the admission identity the TUI was admitted on; a frame that
// carries neither, a stale or foreign token, or another run's identity is
// refused `not-authorized` and logged. Never a fallback to accept.

import { timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';

import {
	isLocalSocketPath,
	isNamedPipePath,
	oversizeSteeringRequestId,
	parseSteeringRequest,
	STEERING_SOCKET_ENV_VAR,
	STEERING_TOKEN_ENV_VAR,
	STEERING_TOO_LONG_DETAIL,
	type SteeringRequestFrame,
	type SteeringResultFrame,
	type SteeringRunIdentity,
} from '../shared/chatSteering';
import type { TuiHandshakeRead } from '../shared/maestro-lib/managed/tui-handshake';

// The one loopback rule lives beside the wire format (MRC2-03-06A) so the main
// process client dials by the same reading; re-exported for this module's callers.
export { isLocalSocketPath, isNamedPipePath };

/**
 * What a frame must carry to be acted on. Both halves null means every frame
 * is acted on, which is the unmanaged channel with no token: unchanged.
 */
export interface SteeringChannelAdmission {
	/** The per-run token every frame must carry; null when the host sent none. */
	token: string | null;
	/** The admission identity every frame must name; null on an unmanaged host. */
	run: SteeringRunIdentity | null;
}

export interface SteeringServerOptions {
	socketPath: string;
	/**
	 * Handle one request. Resolves with the verdict to send back. Never rejects:
	 * the server treats a throw as an internal error and answers `unknown`, because
	 * a caller blocked on a reply must always get one.
	 */
	onSteer: (id: string, text: string) => Promise<SteeringResultFrame>;
	/** Diagnostics sink. Defaults to stderr. */
	warn?: (message: string) => void;
	/**
	 * What every frame must carry (see `planSteeringChannel`). Absent: every
	 * well-formed frame reaches `onSteer`, as on an unmanaged host with no token.
	 */
	admission?: SteeringChannelAdmission;
}

/** The admission identity a managed handshake pins the channel to, or null. */
export function steeringRunOf(admission: TuiHandshakeRead | undefined): SteeringRunIdentity | null {
	if (admission?.status !== 'ok') return null;
	return { leaseId: admission.payload.run.leaseId, attemptId: admission.payload.run.attemptId };
}

export type SteeringChannelPlan =
	/** No socket named: the turn is not steerable, which is the default. */
	| { kind: 'none' }
	| { kind: 'open'; socketPath: string; admission?: SteeringChannelAdmission }
	/** A socket was named and the channel must not be opened on it. */
	| { kind: 'closed'; socketPath: string; reason: string };

/**
 * Whether to open the channel, and what its frames must carry. A managed turn
 * (one the host admitted) is steered only with the run token: a managed
 * admission with no token closes the channel rather than opening one anybody
 * on the machine could type into. An unmanaged turn with no token is unchanged.
 */
export function planSteeringChannel(
	env: Readonly<Record<string, string | undefined>>,
	managedRun: SteeringRunIdentity | null
): SteeringChannelPlan {
	const socketPath = env[STEERING_SOCKET_ENV_VAR]?.trim();
	if (!socketPath) return { kind: 'none' };
	const token = env[STEERING_TOKEN_ENV_VAR]?.trim() || null;
	if (managedRun && !token) {
		return {
			kind: 'closed',
			socketPath,
			reason:
				'the host sent a managed admission but no steering token, and a managed turn is steered only with its run token',
		};
	}
	if (!token && !managedRun) return { kind: 'open', socketPath };
	return { kind: 'open', socketPath, admission: { token, run: managedRun } };
}

function sameSecret(offered: string, expected: string): boolean {
	const a = Buffer.from(offered, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Why a parsed frame may not be acted on under `admission`, or null when it
 * may. The token is compared in constant time; a stale and a foreign token are
 * the same answer, since the server cannot tell which run a wrong one was for.
 */
export function steeringFrameRefusal(
	frame: SteeringRequestFrame,
	admission: SteeringChannelAdmission | undefined
): string | null {
	if (!admission) return null;
	if (admission.token !== null) {
		if (!frame.token) return 'the frame carries no run token';
		if (!sameSecret(frame.token, admission.token)) {
			return 'the frame carries a token that is not the token of this run';
		}
	}
	if (admission.run !== null) {
		if (!frame.run) return 'the frame names no admission identity';
		if (
			frame.run.leaseId !== admission.run.leaseId ||
			frame.run.attemptId !== admission.run.attemptId
		) {
			return 'the frame names an admission identity that is not the identity of this run';
		}
	}
	return null;
}

export interface SteeringServer {
	/**
	 * Stop listening and remove the socket file, but only one THIS process bound
	 * (never a path it found taken). Synchronous, so a force-exit path can call it
	 * right before `process.exit`. Safe to call more than once.
	 */
	close: () => void;
}

/**
 * Listen for steering frames on `socketPath`.
 *
 * Returns null when the socket cannot be created. That is deliberately NOT fatal:
 * the turn is the product and steering is an accessory, so a run whose channel
 * fails to open must still do the work and simply be un-steerable. The reason
 * goes to stderr where the rest of maestro-p's diagnostics live.
 */
export function startSteeringServer(options: SteeringServerOptions): SteeringServer | null {
	const warn = options.warn ?? ((m: string) => process.stderr.write(`${m}\n`));
	const { socketPath } = options;
	if (!isLocalSocketPath(socketPath)) {
		warn(
			`maestro-p: the steering channel path ${JSON.stringify(socketPath)} would be read as a TCP port, not a local socket; refusing to open it, so this turn cannot be steered.`
		);
		return null;
	}
	// A Windows named pipe is not a file: there is nothing to stat, probe-and-unlink,
	// or remove on close, and the OS frees the name when the last handle closes.
	const isPipe = isNamedPipePath(socketPath);

	let server: net.Server;
	try {
		server = net.createServer();
	} catch (err) {
		warn(
			`maestro-p: could not create the steering channel (${String(err)}); this turn cannot be steered.`
		);
		return null;
	}

	let closed = false;
	// Set once THIS process is bound to the path. Only then is the socket file ours
	// to remove: a server that lost the path to a live owner must never delete it.
	let listening = false;
	let reclaimAttempted = false;

	server.on('connection', (socket) => {
		socket.setEncoding('utf8');
		let buffer = '';
		socket.on('data', (chunk: string) => {
			buffer += chunk;
			// Guard against a peer that never sends a newline: a control frame is a
			// sentence, so anything past the cap is not a frame we are waiting to
			// complete, and holding it would grow without bound.
			if (buffer.length > MAX_PENDING_LINE_BYTES) {
				warn('maestro-p: steering channel received an oversized frame; dropping it.');
				buffer = '';
				return;
			}
			let newline = buffer.indexOf('\n');
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				void handleLine(line);
				newline = buffer.indexOf('\n');
			}
		});
		socket.on('error', () => {
			// A peer that hangs up mid-frame is ordinary, not exceptional.
		});

		const handleLine = async (line: string): Promise<void> => {
			const request = parseSteeringRequest(line);
			if (!request) {
				// An oversize steer is still a request with an id, so it gets an answer:
				// silence leaves the caller on its timeout, reporting `unknown` for text
				// that was never typed.
				const oversizeId = oversizeSteeringRequestId(line);
				if (oversizeId) {
					const refused: SteeringResultFrame = {
						type: 'steering',
						id: oversizeId,
						verdict: 'refused',
						refusal: 'too-long',
						detail: STEERING_TOO_LONG_DETAIL,
					};
					try {
						socket.write(`${JSON.stringify(refused)}\n`);
					} catch {
						// Peer gone.
					}
					return;
				}
				if (line.trim()) warn('maestro-p: ignoring an unrecognized steering frame.');
				return;
			}
			// Authorization comes before the handler ever sees the text: a frame
			// that does not prove it is for THIS run is refused and logged, and
			// nothing is typed. The caller gets a verdict, as for every request.
			const denial = steeringFrameRefusal(request, options.admission);
			if (denial) {
				warn(`maestro-p: refused steering request ${request.id}: ${denial}.`);
				const refused: SteeringResultFrame = {
					type: 'steering',
					id: request.id,
					verdict: 'refused',
					refusal: 'not-authorized',
					detail: `this steer was not authorized for this run: ${denial}`,
				};
				try {
					socket.write(`${JSON.stringify(refused)}\n`);
				} catch {
					// Peer gone.
				}
				return;
			}
			let result: SteeringResultFrame;
			try {
				result = await options.onSteer(request.id, request.text);
			} catch (err) {
				// The caller is blocked on an answer. Reporting `unknown` tells it the
				// truth (nobody knows what happened to the text) where a dropped reply
				// would leave it waiting for its own timeout.
				result = {
					type: 'steering',
					id: request.id,
					verdict: 'unknown',
					detail: `the steering attempt failed internally: ${String(err)}`,
				};
			}
			try {
				socket.write(`${JSON.stringify(result)}\n`);
			} catch {
				// Peer gone. The verdict also goes to stdout, so it is not lost.
			}
		};
	});

	server.on('listening', () => {
		listening = true;
	});

	server.on('error', (err: NodeJS.ErrnoException) => {
		if (!listening && !closed && err.code === 'EADDRINUSE' && !isPipe && !reclaimAttempted) {
			reclaimAttempted = true;
			reclaimIfStale();
			return;
		}
		warn(`maestro-p: steering channel error (${String(err)}); this turn cannot be steered.`);
	});

	// The path is taken. Either a crashed predecessor left its socket file behind
	// (nothing answers), or a LIVE maestro-p is listening on it - a nested one, or a
	// turn still winding down on the same tab. Unlinking unconditionally would kill
	// that live channel: its owner keeps listening on an inode nobody can reach
	// again, so its steers silently stop arriving. So ask first, and only reclaim a
	// path nothing answers on.
	const reclaimIfStale = (): void => {
		const probe = net.connect(socketPath);
		probe.once('connect', () => {
			probe.destroy();
			warn(
				`maestro-p: another process is already serving the steering channel at ${socketPath}; leaving it alone, so this turn cannot be steered.`
			);
		});
		probe.once('error', (probeErr: NodeJS.ErrnoException) => {
			probe.destroy();
			if (closed) return;
			if (!STALE_SOCKET_CODES.has(probeErr.code ?? '')) {
				warn(
					`maestro-p: could not tell whether the steering channel at ${socketPath} is in use (${String(probeErr)}); leaving it alone, so this turn cannot be steered.`
				);
				return;
			}
			try {
				fs.unlinkSync(socketPath);
			} catch (unlinkErr) {
				if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') {
					warn(
						`maestro-p: could not remove a stale steering socket at ${socketPath} (${String(unlinkErr)}); this turn cannot be steered.`
					);
					return;
				}
			}
			try {
				server.listen(socketPath);
			} catch (listenErr) {
				warn(
					`maestro-p: could not listen on the steering channel (${String(listenErr)}); this turn cannot be steered.`
				);
			}
		});
	};

	try {
		server.listen(socketPath);
	} catch (err) {
		warn(
			`maestro-p: could not listen on the steering channel (${String(err)}); this turn cannot be steered.`
		);
		return null;
	}

	// Never hold the process open. maestro-p exits when the TURN is done, and a
	// listening socket is a libuv handle that would outlive it and hang the run.
	server.unref();

	return {
		close: () => {
			if (closed) return;
			closed = true;
			const owned = listening;
			try {
				server.close();
			} catch {
				// Already down.
			}
			if (!owned || isPipe) return;
			try {
				if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
			} catch {
				// Best effort - a leftover socket file only costs the next run an unlink.
			}
		},
	};
}

/**
 * Probe errors that mean nobody is serving the path, so the file there is stale
 * and safe to remove: nothing listening on a socket file (ECONNREFUSED), the file
 * gone in the meantime (ENOENT), or a path that is not a socket at all (ENOTSOCK).
 */
const STALE_SOCKET_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

/** Cap on one un-terminated control line. A steer is a sentence, not a stream. */
export const MAX_PENDING_LINE_BYTES = 64 * 1024;
