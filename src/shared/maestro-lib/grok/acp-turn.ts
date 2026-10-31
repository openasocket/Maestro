import { canonicalJson } from '../../canonicalJson';
import type { UsageStats } from '../../types';
import { guardTurn } from '../control/turn-guard';
import { GrokOutputParser } from '../parsers/grok-output-parser';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import type { CompletedTurn, RunningTurn } from '../run/run-to-completion';
import {
	startTurn,
	type StartTurnOptions,
	type TurnHandle,
	type TurnHandlers,
	type TurnProcessSpec,
} from '../run/start-turn';
import { TurnCapture, type TurnCaptureOptions } from '../run/turn-capture';
import { resolveTurnOutcome, type TurnTerminal } from '../streaming/turn-outcome';
import { GrokAcpEventAdapter } from './acp-events';
import { GrokAcpTransportError } from './acp-protocol';
import {
	GrokAcpRequestAdapter,
	type GrokAcpPermissionTurn,
	type GrokAcpRequestOptions,
} from './acp-requests';
import { GrokAcpSession, GrokAcpSessionError, type GrokAcpSessionOptions } from './acp-session';

export interface GrokAcpTurnOptions
	extends
		Pick<
			GrokAcpSessionOptions,
			| 'cwd'
			| 'account'
			| 'host'
			| 'model'
			| 'resumeSessionId'
			| 'idleTimeoutMs'
			| 'maxTurnMs'
			| 'cancelGraceMs'
			| 'requestTimeoutMs'
			| 'maxFrameBytes'
		>,
		Pick<StartTurnOptions, 'admission' | 'stopGraceMs' | 'signal'> {
	/** Unique host dispatch and process identities, never substituted for native IDs. */
	turnId: string;
	processGeneration: string;
	/** Already assembled system/user text. This port does not accept attachments or effort. */
	prompt: string;
	permission?: Pick<GrokAcpPermissionTurn, 'authority' | 'binding'>;
	/** Explicitly observed before dispatch, normalized and bound to this process/session. */
	processSessionBaseline?: TurnCaptureOptions['processSessionBaseline'];
}

export interface GrokAcpTurnHandlers extends Pick<TurnHandlers, 'onStarted' | 'onEvent'> {
	onQuestion?: GrokAcpRequestOptions['onQuestion'];
	onRequestSettlement?: GrokAcpRequestOptions['onSettlement'];
}

export interface GrokAcpRunningTurn extends Omit<RunningTurn, 'completed'> {
	completed: Promise<
		CompletedTurn & { terminal: TurnTerminal; usageReports: readonly UsageStats[] }
	>;
	/** Cancel the prompt before escalating through the session's bounded grace period. */
	cancel(): void;
	questionSupport: GrokAcpRequestAdapter['questionSupport'];
	answerQuestion: GrokAcpRequestAdapter['answerQuestion'];
}

/**
 * One ACP process per turn, resumed by passing its confirmed native session ID next time.
 * The host supplies the final local ACP process spec from its launch plan (including account,
 * attribution and any leaseAdmission gate). Route selection and policy qualification stay
 * with that host. No argv rewriting, fallback, replay, transcript or usage persistence here.
 * CompletedTurn is handed to the host's existing recorder exactly once, after pipe cleanup.
 * SSH script delivery and remote stop ownership require the later SSH route consumer.
 */
export function startGrokAcpTurn(
	spec: TurnProcessSpec,
	options: GrokAcpTurnOptions,
	handlers: GrokAcpTurnHandlers = {}
): GrokAcpRunningTurn {
	if (spec.stdin !== undefined || spec.promptArtifact || typeof options.prompt !== 'string')
		throw new GrokAcpSessionError('invalid-options');
	if (!options.turnId?.trim()) throw new GrokAcpSessionError('invalid-options');
	if (options.signal?.aborted) throw new GrokAcpSessionError('cancelled');
	// Freeze caller-owned launch data before admission invokes host code.
	spec = { ...spec, args: [...spec.args], env: { ...spec.env } };
	options = {
		...options,
		permission: options.permission && {
			...options.permission,
			binding: options.permission.binding && {
				...options.permission.binding,
				actor: { ...options.permission.binding.actor },
			},
		},
		processSessionBaseline:
			options.processSessionBaseline && structuredClone(options.processSessionBaseline),
	};
	const controller = new AbortController();
	let session: GrokAcpSession | undefined;
	let events: GrokAcpEventAdapter | undefined;
	let capture: TurnCapture | undefined;
	let endRequests: (() => void) | undefined;
	let promptStarted = false;
	let settled = false;
	let internalStop = false;
	let signalling = false;
	let failure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	let requestFailure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	const parser = new GrokOutputParser();
	const fault = (): void => {
		if (settled) return;
		failure ??= { status: 'failed', kind: 'transport', reason: 'acp-transport-fault' };
		requests.close();
		session?.transportLost();
	};
	const requests = new GrokAcpRequestAdapter({
		account: options.account,
		host: options.host,
		cwd: options.cwd,
		processGeneration: options.processGeneration,
		timeoutMs: options.requestTimeoutMs,
		onFault: fault,
		onQuestion: handlers.onQuestion,
		onSettlement: (value) => {
			if (value.turnId === options.turnId && value.terminal && value.terminal.status !== 'success')
				requestFailure ??= { ...value.terminal };
			handlers.onRequestSettlement?.(value);
		},
	});
	const stopOwnedProcess = (): void => {
		// Lifecycle failures close pending authority before any OS signal. The session's
		// rejection carries the real cause; cleanup must not relabel it as a user stop.
		requests.close();
		// Aborting authority work may synchronously fail a write inside the outer stop.
		// That stop already owns escalation; do not reenter its signal ladder.
		if (signalling) return;
		internalStop = true;
		try {
			stops.terminate();
		} finally {
			internalStop = false;
		}
	};
	const emit = (event: ParsedEvent): void => {
		capture?.handleEvent(event);
		try {
			// Raw ACP bodies stay on the event; never reserialize them into diagnostic lines.
			handlers.onEvent?.(event, '');
		} catch {
			fault();
		}
	};
	const cancel = (): void => {
		if (settled || controller.signal.aborted) return;
		failure ??= { status: 'cancelled', origin: 'user', reason: 'host-cancelled' };
		controller.abort();
		if (promptStarted) session?.cancel();
		else session?.close();
	};
	const handle: TurnHandle = startTurn(
		spec,
		{
			onStdoutBytes: (bytes) => session?.feedStdout(bytes),
			onStderrBytes: (bytes) => session?.feedStderr(bytes),
			onStdinError: fault,
			onStopRequested: (by) => {
				if (internalStop || settled) return;
				failure ??=
					by === 'authority'
						? { status: 'refused', origin: 'admission', reason: 'lease-revoked' }
						: { status: 'cancelled', origin: 'host', reason: 'process-stopped' };
				signalling = true;
				try {
					controller.abort();
				} finally {
					signalling = false;
				}
			},
		},
		{
			admission: options.admission,
			stopGraceMs: options.stopGraceMs,
			keepStdinOpen: true,
			trackDescendants: true,
			// No output-only parser, frame buffer or secret-bearing diagnostic tail.
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
		}
	);
	const stops = guardTurn(handle, { sessionId: options.turnId, graceMs: options.stopGraceMs });

	const completed = (async (): GrokAcpRunningTurn['completed'] => {
		let response: Record<string, unknown> | undefined;
		try {
			session = new GrokAcpSession({
				...options,
				child: handle.child,
				requestHandlers: requests.requestHandlers,
				terminate: stopOwnedProcess,
				write: (bytes) => {
					if (!handle.child.stdin?.writable) throw new GrokAcpTransportError('write');
					handle.child.stdin.write(bytes, (error) => {
						if (error) fault();
					});
				},
				onNotification: (message, context) => {
					if (!settled && context.turn === 1 && !context.replay && events)
						for (const event of events.notification(message, {
							replay: false,
							turnId: options.turnId,
						}))
							emit(event);
				},
			});
			handle.child.stdout?.on('error', fault);
			handle.child.stderr?.on('error', fault);
			handle.child.stdout?.on('end', fault);
			options.signal?.addEventListener('abort', cancel, { once: true });
			if (options.signal?.aborted || controller.signal.aborted) cancel();
			handlers.onStarted?.(handle.pid);
			if (failure) throw new GrokAcpSessionError('cancelled');
			await session.open();
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			const sessionId = session.sessionId!;
			const scopeId = canonicalJson([options.account, options.host]);
			const identity = {
				sessionId,
				turnId: options.turnId,
				scopeId,
				processGeneration: options.processGeneration,
			};
			events = new GrokAcpEventAdapter(identity);
			capture = new TurnCapture('grok', parser, {
				classifyInBandErrors: false,
				usageIdentity: { ...identity, route: 'acp', providerSessionId: sessionId },
				processSessionBaseline: options.processSessionBaseline,
			});
			endRequests = requests.beginTurn({
				...options.permission,
				sessionId,
				turnId: options.turnId,
				signal: controller.signal,
			});
			emit({ type: 'init', sessionId });
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			promptStarted = true;
			response = await session.prompt(options.prompt, controller.signal);
		} catch (error) {
			if (error instanceof GrokAcpSessionError) response = error.response;
			const reason = error instanceof GrokAcpSessionError ? error.reason : 'transport-lost';
			// Provider cancellation is a protocol outcome: preserve its metadata and any
			// preceding permission refusal/timeout instead of relabeling it as a host stop.
			if (reason !== 'cancelled' || !response || controller.signal.aborted)
				failure ??= {
					...(reason === 'idle-timeout'
						? ({ status: 'timeout', kind: 'idle' } as const)
						: reason === 'turn-timeout' || reason === 'cancel-timeout'
							? ({ status: 'timeout', kind: 'deadline' } as const)
							: reason === 'cancelled'
								? ({ status: 'cancelled', origin: 'host' } as const)
								: ({
										status: 'failed',
										kind:
											reason === 'process-lost'
												? 'process'
												: reason === 'transport-lost'
													? 'transport'
													: 'protocol',
									} as const)),
					reason,
					dispatchState:
						error instanceof GrokAcpSessionError && error.dispatchMayHaveOccurred
							? 'unknown'
							: promptStarted
								? 'unknown'
								: 'not-dispatched',
				};
		} finally {
			endRequests?.();
			if (failure && failure.dispatchState === undefined)
				failure.dispatchState = promptStarted ? 'unknown' : 'not-dispatched';
			if (events)
				for (const event of events.settle(response, failure ?? requestFailure)) emit(event);
			else
				emit({
					type: 'error',
					text: 'Grok ACP turn did not start.',
					sessionId: session?.sessionId,
					terminal: failure,
				});
			settled = true;
			options.signal?.removeEventListener('abort', cancel);
			requests.close();
			if (session) session.close();
			else stopOwnedProcess();
		}
		const exit = await handle.done;
		handle.child.stdout?.off('error', fault);
		handle.child.stderr?.off('error', fault);
		handle.child.stdout?.off('end', fault);
		const terminal: TurnTerminal = failure
			? { ...events?.terminal, ...failure }
			: (events?.terminal ?? {
					status: 'incomplete',
					kind: 'missing-terminal',
					dispatchState: 'unknown',
				});
		const resolved = resolveTurnOutcome(
			{
				// Protocol settlement precedes our intentional process shutdown. Its real exit
				// remains available below; that cleanup signal is not a second turn outcome.
				exitCode: null,
				signal: null,
				interrupted: false,
				stderrText: '',
				stdoutText: '',
				explicitError: undefined,
				capturedAnswerText: capture?.answerText,
				resultMessageSeen: capture?.resultMessageSeen ?? false,
				terminal,
			},
			parser,
			{ providerId: 'grok', sessionId: options.turnId }
		);
		return {
			outcome: resolved.outcome,
			terminal: resolved.terminal ?? terminal,
			answerText: capture?.answerText,
			sessionId: session?.sessionId,
			usage: capture?.usage,
			usageReports: capture?.usageReports ?? [],
			error: resolved.error,
			exit,
		};
	})();
	return {
		handle: { ...handle, ...stops, terminateNow: handle.terminateNow },
		completed,
		cancel,
		answerSoFar: () => capture?.answerText,
		questionSupport: requests.questionSupport,
		answerQuestion: requests.answerQuestion.bind(requests),
	};
}
