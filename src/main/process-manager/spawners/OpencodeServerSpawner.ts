// src/main/process-manager/spawners/OpencodeServerSpawner.ts

/**
 * Spawns a local, interactive OpenCode "process" backed by the shared
 * `opencode serve` server via `@opencode-ai/sdk`, instead of a one-shot
 * `opencode run` child process.
 *
 * Why: the server exposes a live SSE event stream (including `permission.updated`),
 * which is the foundation for bubbling permission requests up to the user. This
 * spawner does the transport swap while preserving the existing pipeline: it
 * registers a `ManagedProcess` (with no OS child), then translates the SDK's SSE
 * events back into the CLI's JSONL lines and feeds them through the very same
 * `StdoutHandler`/`ExitHandler` the CLI path uses. Everything downstream (parser,
 * usage, tool-execution, session-id, renderer, peek, wizard) is reused verbatim.
 *
 * Scope (see task decisions): local + interactive + text prompts only. SSH-remote,
 * headless automation edge cases, and image prompts remain on the CLI path via the
 * caller's routing and the `fallbackToCli` safety net.
 */

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import { captureException } from '../../utils/sentry';
import type { ProcessConfig, ManagedProcess, ProcessSpawnAdmission, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import {
	opencodeServerManager,
	type OpencodeManagedServerScope,
} from '../../opencode-server/OpencodeServerManager';
import { OpencodeEventTranslator } from '../../opencode-server/event-translator';
import type { Event, OpencodeClient, Permission } from '@opencode-ai/sdk';
import { providerRouteSupport } from '../../../shared/maestro-lib/providers/capabilities';
import {
	EFFECT_REVOKED,
	effectDigest,
	effectGranted,
	unavailableEffectAuthority,
	type ManagedEffect,
	type ManagedEffectAuthority,
	type ManagedEffectBinding,
	type ManagedEffectDecision,
} from '../../../shared/maestro-lib/managed/effects';
import type { ManagedDenialCode } from '../../../shared/maestro-lib/managed/types';
import type { AgentError } from '../../../shared/types';

export interface OpencodeServerSpawnerOptions {
	/**
	 * Live read of the managed host's effect authority (`ProcessManager` hands
	 * its port's). A managed turn asks it for every `permission.updated` the
	 * server raises for its session; with none, every managed effect is
	 * rejected as unavailable. Unmanaged turns never consult it.
	 */
	effects?: () => ManagedEffectAuthority | null;
}

/**
 * Why a managed OpenCode turn cannot run on the shared server, or null when
 * the `opencode-server` route is one the build governs. The table is
 * `providerRouteSupport`; until a producer qualifies the route there (the
 * interception below exercised against a real server), the route is
 * `unavailable` under management, explicitly, and never falls back to the
 * CLI, whose config auto-approves every tool.
 */
export function managedOpencodeRefusal(
	config: ProcessConfig
): { state: 'unavailable'; code: ManagedDenialCode; message: string } | null {
	if (!config.admission) return null;
	const support = providerRouteSupport(config.toolType).find(
		(entry) => entry.route === 'opencode-server'
	);
	if (support?.managed === 'implemented') return null;
	return {
		state: 'unavailable',
		code: 'capability-unsupported',
		message: `Managed execution of ${config.toolType} over the shared OpenCode server is unavailable on this host: ${support?.note ?? 'the route is not known'}.`,
	};
}

/** The server scope a managed turn's server is isolated by: from the admission, never the environment. */
export function opencodeManagedScope(admission: ProcessSpawnAdmission): OpencodeManagedServerScope {
	return {
		authorityId: admission.authorityId,
		actor: admission.actor,
		policyRevision: admission.policyRevision,
	};
}

/**
 * The exact effect a `permission.updated` asks for. OpenCode names the tool
 * in `type` (`bash`, `edit`, `write`, `read`, `webfetch`, `external_directory`,
 * ...) and the target in `pattern` (a path, a glob, a command pattern) with
 * the tool's own input in `metadata`. A shell tool is a command (the
 * metadata's `command` when it carries one, else the pattern); a file tool
 * is a file change over its patterns; anything else is that tool with its
 * metadata as input. `title` is the model's prose and is never an input.
 */
export function opencodePermissionEffect(permission: Permission): ManagedEffect {
	const patterns = Array.isArray(permission.pattern)
		? permission.pattern
		: permission.pattern
			? [permission.pattern]
			: [];
	const metadata = permission.metadata ?? {};
	const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
	switch (permission.type) {
		case 'bash':
			return {
				kind: 'command',
				command: text(metadata.command) ?? patterns.join(' '),
				cwd: text(metadata.cwd),
				argv: null,
			};
		case 'edit':
		case 'write':
		case 'patch':
		case 'external_directory':
			return {
				kind: 'file-change',
				paths: [...new Set(patterns)].sort(),
				cwd: text(metadata.cwd),
			};
		default:
			return { kind: 'tool-call', tool: permission.type, input: metadata };
	}
}

/**
 * The managed gate over one session's permission events: each is the exact
 * effect, bound to the lease, actor, OpenCode session (thread), message
 * (turn) and permission id, decided live by the host's effect authority and
 * answered on the server's own reply route (`once` on allow, `reject` on
 * anything else; never `always`, which would outlive the decision). A
 * pending decision is refused at once when the turn ends or is stopped.
 */
class OpencodeManagedEffectGate {
	private readonly pending = new Map<string, AbortController>();

	constructor(
		private readonly deps: {
			client: OpencodeClient;
			ocSessionId: string;
			cwd: string;
			sessionId: string;
			provider: string;
			admission: ProcessSpawnAdmission;
			authority: ManagedEffectAuthority;
		}
	) {}

	handle(event: Event): void {
		if (event.type !== 'permission.updated') return;
		const permission = event.properties;
		if (permission.sessionID !== this.deps.ocSessionId) return;
		if (this.pending.has(permission.id)) return;
		const effect = opencodePermissionEffect(permission);
		const binding: ManagedEffectBinding = {
			leaseId: this.deps.admission.leaseId,
			actor: this.deps.admission.actor,
			provider: this.deps.provider,
			threadId: permission.sessionID,
			turnId: permission.messageID,
			requestId: permission.id,
		};
		const controller = new AbortController();
		this.pending.set(permission.id, controller);
		const settle = (decision: ManagedEffectDecision): void => {
			if (!this.pending.delete(permission.id)) return;
			logger.info('[OpencodeServerSpawner] Managed effect decided', 'OpencodeServer', {
				sessionId: this.deps.sessionId,
				effect: effect.kind,
				tool: permission.type,
				leaseId: binding.leaseId,
				threadId: binding.threadId,
				turnId: binding.turnId,
				requestId: binding.requestId,
				authorityId: this.deps.authority.authorityId,
				effectDigest: effectDigest(effect, binding),
				decision: decision.decision,
				reason: decision.decision === 'allow' ? undefined : decision.reason,
			});
			this.reply(permission.id, effectGranted(decision) ? 'once' : 'reject');
		};
		Promise.resolve()
			.then(() => this.deps.authority.decide(effect, binding, controller.signal))
			.then(
				(decision) => settle(controller.signal.aborted ? EFFECT_REVOKED : decision),
				(error: unknown) =>
					settle({
						decision: 'unavailable',
						reason: `The effect authority failed: ${error instanceof Error ? error.message : String(error)}`,
					})
			);
	}

	/** Refuse every permission still waiting on a decision; the turn or its lease is over. */
	revokeAll(): void {
		for (const [permissionId, controller] of [...this.pending]) {
			controller.abort();
			this.pending.delete(permissionId);
			logger.info(
				'[OpencodeServerSpawner] Managed effect revoked while pending',
				'OpencodeServer',
				{
					sessionId: this.deps.sessionId,
					requestId: permissionId,
				}
			);
			this.reply(permissionId, 'reject');
		}
	}

	private reply(permissionID: string, response: 'once' | 'reject'): void {
		void this.deps.client
			.postSessionIdPermissionsPermissionId({
				path: { id: this.deps.ocSessionId, permissionID },
				query: { directory: this.deps.cwd },
				body: { response },
			})
			.catch((error: unknown) => {
				logger.warn('[OpencodeServerSpawner] Could not answer permission', 'OpencodeServer', {
					sessionId: this.deps.sessionId,
					requestId: permissionID,
					response,
					error: String(error),
				});
			});
	}
}

/** Parsed agent invocation bits we need from the CLI-style args. */
interface OpencodeInvocation {
	/** Existing opencode session id to resume, if any. */
	resumeId?: string;
	/** `{ providerID, modelID }` when `--model provider/model` was supplied. */
	model?: { providerID: string; modelID: string };
	/** Agent name from `--agent <name>` (e.g. `plan` for read-only mode). */
	agent?: string;
}

/** Per-spawn termination guard: emits exit exactly once via ExitHandler. */
interface Lifecycle {
	finish: (code: number) => void;
	isFinished: () => boolean;
}

/**
 * Extract resume id / model / agent from the CLI args the caller already built
 * (via the agent definition's `resumeArgs`/`modelArgs`/`readOnlyArgs`). Parsing
 * here keeps the SDK migration contained to the main process - no IPC/renderer
 * contract changes.
 */
function parseInvocation(config: ProcessConfig): OpencodeInvocation {
	const { args } = config;
	const out: OpencodeInvocation = {};

	const valueAfter = (flag: string): string | undefined => {
		const i = args.indexOf(flag);
		if (i !== -1 && i + 1 < args.length) return args[i + 1];
		const eq = args.find((a) => a.startsWith(`${flag}=`));
		return eq ? eq.slice(flag.length + 1) : undefined;
	};

	out.resumeId = config.agentSessionId || valueAfter('--session');

	const model = valueAfter('--model');
	if (model) {
		const slash = model.indexOf('/');
		out.model =
			slash > 0
				? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
				: { providerID: model, modelID: model };
	}

	out.agent = valueAfter('--agent');
	return out;
}

export class OpencodeServerSpawner {
	private stdoutHandler: StdoutHandler;
	private exitHandler: ExitHandler;

	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter,
		bufferManager: DataBufferManager,
		/** Fallback used when the server can't start / session can't be created,
		 *  so local OpenCode never regresses to "broken". Provided by ProcessManager
		 *  (its ChildProcessSpawner.spawn). Never taken by a managed turn. */
		private fallbackToCli: (config: ProcessConfig) => SpawnResult,
		private readonly options: OpencodeServerSpawnerOptions = {}
	) {
		this.stdoutHandler = new StdoutHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager,
		});
		this.exitHandler = new ExitHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager,
		});
	}

	/**
	 * Register the managed process synchronously and kick off async SDK work.
	 * Mirrors ChildProcessSpawner: returns immediately; events flow later.
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const { sessionId, toolType, cwd, command, args, prompt } = config;

		// A managed turn runs on an isolated, ask-mode server or not at all;
		// decided before the process is registered, so a refusal has no effect.
		const refusal = managedOpencodeRefusal(config);
		if (refusal) {
			logger.warn('[OpencodeServerSpawner] Managed turn not started', 'OpencodeServer', {
				sessionId,
				state: refusal.state,
				code: refusal.code,
				message: refusal.message,
			});
			this.emitter.emit('agent-error', sessionId, {
				type: 'unknown',
				message: refusal.message,
				recoverable: false,
				agentId: toolType,
				sessionId,
				timestamp: Date.now(),
			} satisfies AgentError);
			return {
				pid: -1,
				success: false,
				error: refusal.message,
				managed: { state: refusal.state, code: refusal.code },
			};
		}

		const outputParser = createOutputParser(toolType) || undefined;

		// SSE aborter for the kill path, plus a one-shot exit guard.
		const streamAbort = new AbortController();
		let finished = false;
		// The managed effect gate, once the session exists; stopping revokes it.
		const managed: { gate: OpencodeManagedEffectGate | null } = { gate: null };
		const managedProcess: ManagedProcess = {
			sessionId,
			toolType,
			cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			isStreamJsonMode: true,
			jsonBuffer: '',
			startTime: Date.now(),
			outputParser,
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command,
			args,
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			// Wire kill/interrupt into the SDK session + SSE stream.
			sdkController: {
				interrupt: () => {
					// Abort the in-flight turn but keep the session/stream alive; the
					// resulting session.idle drives the normal exit path.
					managed.gate?.revokeAll();
					this.abortActiveSession(managedProcess);
				},
				kill: () => {
					// Hard stop: abort the turn and tear down the SSE subscription. The
					// stream ending triggers finish() -> exit, matching child-process
					// kill timing (ProcessManager deletes the map entry right after).
					managed.gate?.revokeAll();
					this.abortActiveSession(managedProcess);
					streamAbort.abort();
				},
			},
		};
		const lifecycle: Lifecycle = {
			isFinished: () => finished,
			finish: (code: number) => {
				if (finished) return;
				finished = true;
				managed.gate?.revokeAll();
				void this.exitHandler.handleExit(sessionId, code, managedProcess).catch((err) => {
					logger.error('[OpencodeServerSpawner] handleExit threw', 'OpencodeServer', {
						sessionId,
						error: String(err),
					});
				});
			},
		};

		this.processes.set(sessionId, managedProcess);

		if (!prompt) {
			logger.warn(
				'[OpencodeServerSpawner] Spawn with no prompt; nothing to run',
				'OpencodeServer',
				{
					sessionId,
				}
			);
			lifecycle.finish(0);
			return { pid: -1, success: true };
		}

		// run() owns its own error handling (CLI fallback for setup failures,
		// agent-error for streaming failures). This catch is a last-resort net.
		void this.run(config, managedProcess, streamAbort, lifecycle, managed).catch((err) => {
			void captureException(err);
			if (!lifecycle.isFinished()) {
				this.emitAgentError(managedProcess, err);
				lifecycle.finish(1);
			}
		});

		return { pid: -1, success: true };
	}

	/**
	 * Emit an agent-error for this process, at most once. Sets `errorEmitted` so
	 * ExitHandler's exit-based error detection doesn't then emit a duplicate
	 * generic "exited with code 1" error on the finish(1) path.
	 */
	private emitAgentError(managedProcess: ManagedProcess, err: unknown): void {
		if (managedProcess.errorEmitted) return;
		managedProcess.errorEmitted = true;
		this.emitter.emit('agent-error', managedProcess.sessionId, {
			type: 'agent_crashed',
			message: `OpenCode server error: ${err instanceof Error ? err.message : String(err)}`,
			recoverable: true,
			agentId: managedProcess.toolType,
			sessionId: managedProcess.sessionId,
			timestamp: Date.now(),
		});
	}

	private abortActiveSession(managedProcess: ManagedProcess): void {
		const client = managedProcess.opencodeClient;
		const ocSessionId = managedProcess.opencodeSessionId;
		if (!client || !ocSessionId) return;
		try {
			void client.session
				.abort({ path: { id: ocSessionId }, query: { directory: managedProcess.cwd } })
				.catch(() => {
					/* best effort */
				});
		} catch {
			/* best effort */
		}
	}

	private async run(
		config: ProcessConfig,
		managedProcess: ManagedProcess,
		streamAbort: AbortController,
		lifecycle: Lifecycle,
		managed: { gate: OpencodeManagedEffectGate | null }
	): Promise<void> {
		const { sessionId, cwd, command, prompt } = config;
		const invocation = parseInvocation(config);
		const admission = config.admission;

		// ── Setup phase ──────────────────────────────────────────────────────
		// Failures here (server won't start, session can't be created, can't
		// subscribe) happen before any output has streamed, so we can safely
		// degrade to the CLI path and OpenCode still works. No pump exists yet,
		// so there's no risk of the SDK and CLI paths both writing this session.
		let client: OpencodeClient;
		let ocSessionId: string;
		let subscription: { stream: unknown };

		// Bail if the spawn was interrupted/killed during an await below. Without
		// this, stale setup work could fire a prompt on an abandoned session or
		// delete a map slot that a respawn now owns. Emit exit so the renderer
		// doesn't hang (the map entry may already be gone via ProcessManager.kill).
		const cancelled = (): boolean => streamAbort.signal.aborted || lifecycle.isFinished();

		try {
			({ client } = await opencodeServerManager.ensureServer({
				binaryPath: command,
				customEnvVars: config.customEnvVars,
				shellEnvVars: config.shellEnvVars,
				extraPathDirs: config.extraPathDirs,
				cwd,
				// A managed turn's server is isolated by its admission's scope and
				// starts in ask mode; a standalone turn keeps the shared server.
				...(admission ? { managed: opencodeManagedScope(admission) } : {}),
			}));
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			managedProcess.opencodeClient = client;

			// Resume an existing session or create a new one.
			let resolvedId = invocation.resumeId;
			if (!resolvedId) {
				const created = await client.session.create({ query: { directory: cwd } });
				resolvedId = created.data?.id;
				if (!resolvedId) {
					throw new Error('OpenCode session.create returned no session id');
				}
			}
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			ocSessionId = resolvedId;
			managedProcess.opencodeSessionId = ocSessionId;

			// Subscribe to the shared server's event stream BEFORE firing the prompt
			// so no early part events are missed. The stream is multiplexed across
			// all sessions; the translator filters down to ours.
			subscription = await client.event.subscribe({ signal: streamAbort.signal });
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			if (admission) {
				managed.gate = new OpencodeManagedEffectGate({
					client,
					ocSessionId,
					cwd,
					sessionId,
					provider: config.toolType,
					admission,
					authority:
						this.options.effects?.() ??
						unavailableEffectAuthority('This host has no effect authority for managed turns.'),
				});
			}
		} catch (setupErr) {
			// A kill mid-setup surfaces as an aborted subscribe/create rejection -
			// that's a clean stop, not a transport failure, so don't fall back to CLI.
			if (cancelled()) {
				lifecycle.finish(0);
				return;
			}
			if (admission) {
				// Managed: the CLI path auto-approves every tool, so it is no fallback
				// for a turn whose effects must be decided. The refusal stands.
				logger.warn(
					'[OpencodeServerSpawner] SDK setup failed under management; no CLI fallback',
					'OpencodeServer',
					{ sessionId, error: String(setupErr) }
				);
				this.emitAgentError(
					managedProcess,
					new Error(
						`the shared server could not be set up (${setupErr instanceof Error ? setupErr.message : String(setupErr)}) and the CLI fallback is not qualified under management; nothing was started`
					)
				);
				lifecycle.finish(1);
				return;
			}
			logger.warn(
				'[OpencodeServerSpawner] SDK setup failed; falling back to CLI',
				'OpencodeServer',
				{ sessionId, error: String(setupErr) }
			);
			// Only reclaim the slot if it's still ours - a concurrent respawn for the
			// same sessionId must not be clobbered by our fallback.
			if (this.processes.get(sessionId) === managedProcess) {
				this.processes.delete(sessionId);
				try {
					this.fallbackToCli(config);
					return;
				} catch (fallbackErr) {
					void captureException(fallbackErr);
				}
			}
			this.emitAgentError(managedProcess, setupErr);
			lifecycle.finish(1);
			return;
		}

		// ── Streaming phase ──────────────────────────────────────────────────
		// From here the process is committed to the SDK path (no CLI fallback):
		// falling back now would double-drive the session.
		const translator = new OpencodeEventTranslator(ocSessionId);

		const pump = (async () => {
			try {
				for await (const event of subscription.stream as AsyncIterable<Event>) {
					if (lifecycle.isFinished()) break;
					// Managed: every permission the server asks for this session is
					// decided before the translator sees anything the tool did.
					managed.gate?.handle(event);
					const { lines, idle, errored } = translator.handle(event);
					for (const line of lines) {
						this.stdoutHandler.handleData(sessionId, line + '\n');
					}
					if (idle || errored) {
						// A session error ends the turn with a non-zero code so exit-based
						// consumers (stats/query-complete) see the failure; the error text
						// itself was already surfaced via the emitted error line.
						lifecycle.finish(errored ? 1 : 0);
						break;
					}
				}
				// Stream ended (server closed or aborted) without an explicit idle.
				lifecycle.finish(0);
			} catch (err) {
				// Aborted subscriptions surface as errors; treat abort as a clean stop.
				const aborted = streamAbort.signal.aborted;
				if (!aborted) {
					logger.warn('[OpencodeServerSpawner] Event stream error', 'OpencodeServer', {
						sessionId,
						error: String(err),
					});
				}
				lifecycle.finish(aborted ? 0 : 1);
			}
		})();

		// Fire the prompt (async: events stream live via the subscription above).
		try {
			await client.session.promptAsync({
				path: { id: ocSessionId },
				query: { directory: cwd },
				body: {
					parts: [{ type: 'text', text: prompt as string }],
					...(invocation.model ? { model: invocation.model } : {}),
					...(invocation.agent ? { agent: invocation.agent } : {}),
				},
			});
		} catch (promptErr) {
			// Surface the failure and stop the pump; the session errored, not the
			// whole transport, so no CLI fallback (that would re-run the prompt).
			logger.warn('[OpencodeServerSpawner] promptAsync failed', 'OpencodeServer', {
				sessionId,
				error: String(promptErr),
			});
			this.emitAgentError(managedProcess, promptErr);
			// Finish non-zero before aborting so the failure exit code wins over the
			// pump's abort-driven finish(0) (finish is idempotent, first call sticks).
			lifecycle.finish(1);
			streamAbort.abort();
		}

		await pump;
	}
}
