import { canonicalJson } from '../../canonicalJson';
import type { UsageStats } from '../../types';
import { generateUUID } from '../../uuid';
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
import { TurnCapture } from '../run/turn-capture';
import { resolveTurnOutcome, type TurnTerminal } from '../streaming/turn-outcome';
import { parsedUsageToStats } from '../streaming/usage-totals';
import { GrokAcpEventAdapter } from './acp-events';
import { GrokAcpTransportError } from './acp-protocol';
import {
	GrokAcpRequestAdapter,
	type GrokAcpPermissionTurn,
	type GrokAcpRequestOptions,
} from './acp-requests';
import {
	GrokAcpSession,
	GrokAcpSessionError,
	type GrokAcpCommandCatalog,
	type GrokAcpModelState,
	type GrokAcpSessionOptions,
} from './acp-session';

export interface GrokAcpTurnOptions
	extends
		Pick<
			GrokAcpSessionOptions,
			| 'cwd'
			| 'account'
			| 'host'
			| 'model'
			| 'effort'
			| 'resumeSessionId'
			| 'idleTimeoutMs'
			| 'maxTurnMs'
			| 'cancelGraceMs'
			| 'requestTimeoutMs'
			| 'maxFrameBytes'
			| 'extensions'
		>,
		Pick<StartTurnOptions, 'admission' | 'stopGraceMs' | 'signal'> {
	/** Unique host dispatch and process identities, never substituted for native IDs. */
	turnId: string;
	processGeneration: string;
	/** Already assembled system/user text. This port does not accept attachments. */
	prompt: string;
	/** Explicit discovery qualification for this selected account/host and exact binary version. */
	modelDiscovery?: Pick<GrokAcpSessionOptions, 'account' | 'host'> & { agentVersion: string };
	permission?: Pick<GrokAcpPermissionTurn, 'authority' | 'binding'>;
}

/** Detached pre-dispatch facts; never a provider-wide capability or persistence record. */
export interface GrokAcpConfigurationObservation extends Pick<
	GrokAcpTurnOptions,
	'account' | 'host' | 'cwd' | 'processGeneration'
> {
	sessionId: string;
	observedAt: number;
	configuration: GrokAcpSession['configuration'];
	/** Undefined means unavailable; an empty availableModels array is authoritative. */
	models?: GrokAcpModelState;
}

/** Process-bound native advertisement. Hosts add their launch and config receipts. */
export interface GrokAcpCommandObservation extends GrokAcpCommandCatalog {
	readonly processGeneration: string;
}

export interface GrokAcpTurnHandlers extends Pick<TurnHandlers, 'onStarted' | 'onEvent'> {
	/** Observation only: mutation/failure cannot affect the turn or its retained snapshot. */
	onConfiguration?: (observation: GrokAcpConfigurationObservation) => void;
	onQuestion?: GrokAcpRequestOptions['onQuestion'];
	onRequestSettlement?: GrokAcpRequestOptions['onSettlement'];
}

export interface GrokAcpRunningTurn extends Omit<RunningTurn, 'completed'> {
	completed: Promise<
		CompletedTurn & { terminal: TurnTerminal; usageReports: readonly UsageStats[] }
	>;
	/** Cancel the prompt before escalating through the session's bounded grace period. */
	cancel(): void;
	configuration: () => GrokAcpConfigurationObservation | undefined;
	/** Live read only; snapshots never authorize a later process or headless fallback. */
	commands: () => GrokAcpCommandObservation | undefined;
	/** Withhold host receipts during reload; invalidate before/after, then await a fresh update. */
	invalidateCommands: () => void;
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
		extensions: options.extensions && { ...options.extensions },
		modelDiscovery: options.modelDiscovery && { ...options.modelDiscovery },
	};
	const controller = new AbortController();
	let session: GrokAcpSession | undefined;
	let configuration: GrokAcpConfigurationObservation | undefined;
	let events: GrokAcpEventAdapter | undefined;
	let capture: TurnCapture | undefined;
	let endRequests: (() => void) | undefined;
	let promptStarted = false;
	let promptSettled = false;
	let settled = false;
	let internalStop = false;
	let signalling = false;
	let failure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	let requestFailure: Exclude<TurnTerminal, { status: 'success' }> | undefined;
	const parser = new GrokOutputParser();
	const fault = (): void => {
		if (settled) return;
		if (!session?.error && !promptSettled)
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
		if (!session?.error && !promptSettled)
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
				if (!session?.error && !promptSettled)
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
		let promptError: unknown;
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
			const qualification = options.modelDiscovery;
			const models =
				qualification &&
				qualification.account === options.account &&
				qualification.host === options.host &&
				qualification.agentVersion === session.configuration.agentVersion &&
				qualification.agentVersion === options.extensions?.agentVersion &&
				options.extensions?.modelsList === true
					? await session.discoverModels(controller.signal)
					: undefined;
			// A distinct native ID is useful only when actually sent on a qualified route.
			const promptId = session.supportsPromptId ? generateUUID() : undefined;
			const scopeId = canonicalJson([options.account, options.host]);
			const identity = {
				sessionId,
				turnId: options.turnId,
				scopeId,
				processGeneration: options.processGeneration,
				promptId,
			};
			events = new GrokAcpEventAdapter(identity);
			// Allocation and the native-session claim precede this observation. The
			// first nonzero ledger is a baseline, never evidence of a zero starting bill.
			const initialUsage = await session.processUsage(controller.signal);
			const initialEvents = initialUsage === undefined ? [] : events.processUsage(initialUsage);
			const baseline = initialEvents[0]?.usage;
			capture = new TurnCapture('grok', parser, {
				classifyInBandErrors: false,
				usageIdentity: { ...identity, route: 'acp', providerSessionId: sessionId },
				processSessionBaseline:
					baseline?.accounting?.completeness === 'complete'
						? parsedUsageToStats(baseline)
						: undefined,
			});
			// Incomplete baseline observations remain separate, non-additive facts.
			for (const event of initialEvents) emit(event);
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			configuration = structuredClone({
				account: options.account,
				host: options.host,
				cwd: options.cwd,
				processGeneration: options.processGeneration,
				sessionId,
				observedAt: Date.now(),
				configuration: session.configuration,
				models,
			});
			try {
				void Promise.resolve(handlers.onConfiguration?.(structuredClone(configuration))).catch(
					() => {}
				);
			} catch {
				// Optional observers cannot fail a successfully acknowledged configuration.
			}
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			endRequests = requests.beginTurn({
				...options.permission,
				sessionId,
				turnId: options.turnId,
				promptId,
				signal: controller.signal,
			});
			emit({ type: 'init', sessionId });
			if (failure || controller.signal.aborted) throw new GrokAcpSessionError('cancelled');
			promptStarted = true;
			try {
				response = await session.prompt(options.prompt, controller.signal, promptId);
			} catch (error) {
				promptError = error;
				if (error instanceof GrokAcpSessionError) response = error.response;
			}
			promptSettled = response !== undefined;
			endRequests();
			endRequests = undefined;
			// Request after the prompt response, never concurrently with the prompt.
			// The shared accumulator replaces this provisional total with final usage once.
			if (response && !controller.signal.aborted && !session.isClosed) {
				try {
					const usage = await session.processUsage(controller.signal);
					if (usage !== undefined) for (const event of events.processUsage(usage)) emit(event);
				} catch (error) {
					// Optional accounting cannot rewrite the received protocol outcome. Owned
					// cleanup still runs and partial usage remains; unexpected faults propagate.
					if (!(error instanceof GrokAcpSessionError)) throw error;
				}
			}
			if (promptError) throw promptError;
		} catch (caught) {
			const error = promptError ?? session?.error ?? caught;
			if (error instanceof GrokAcpSessionError) response = error.response ?? response;
			const reason = error instanceof GrokAcpSessionError ? error.reason : 'transport-lost';
			// Provider cancellation is a protocol outcome: preserve its metadata and any
			// preceding permission refusal/timeout instead of relabeling it as a host stop.
			if (reason !== 'cancelled' || !response || (controller.signal.aborted && !promptSettled))
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
						session?.promptDispatched ||
						(error instanceof GrokAcpSessionError && error.dispatchMayHaveOccurred)
							? 'unknown'
							: 'not-dispatched',
				};
		} finally {
			endRequests?.();
			if (failure && failure.dispatchState === undefined)
				failure.dispatchState = session?.promptDispatched ? 'unknown' : 'not-dispatched';
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
		configuration: () => configuration && structuredClone(configuration),
		commands: () => {
			if (settled || controller.signal.aborted || failure) return;
			const catalog = session?.commands;
			return catalog && { ...catalog, processGeneration: options.processGeneration };
		},
		invalidateCommands: () => session?.invalidateCommands(),
		questionSupport: requests.questionSupport,
		answerQuestion: requests.answerQuestion.bind(requests),
	};
}
