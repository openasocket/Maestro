// src/main/process-manager/spawners/GrokAcpSpawner.ts

/**
 * Runs a desktop Grok turn that needs a host round trip (a standard-mode permission
 * request) on the shared ACP driver (`startGrokAcpTurn`), never on the output-only
 * headless CLI, which answers every native permission prompt by itself.
 *
 * The route is the negotiated selector's (`grok/route.ts`): before anything starts,
 * `beginGrokAcpNegotiation` must qualify every requirement except the peer's own
 * advertisement (consent port, local target, no images, no custom argv, a known
 * account and host); the process then negotiates `initialize` and allocates its session,
 * and the driver's `qualify` gate runs `completeGrokAcpNegotiation` over what it proved
 * BEFORE any prompt is dispatched. A gap at either step is a structured refusal reported
 * to the tab. There is no fallback in either direction.
 *
 * Like the Codex app-server spawner it registers a `ManagedProcess` with an
 * `sdkController` (so ProcessManager.write() never types into the JSON-RPC stream) and
 * reuses `StdoutHandler` / `ExitHandler`: the driver's normalized events go through
 * `StdoutHandler.handleNormalizedEvent`, so streamed answer, thoughts, tools, late
 * native session IDs and usage reach the renderer by the path a parsed line takes.
 *
 * Permission requests of a managed turn are answered by the host's effect authority,
 * bound to the admission's lease and actor. A standalone turn asks the person: the
 * permission relay's consent session surfaces each request on the existing permission
 * prompt for the turn's own agent and tab, and only an explicit Allow answers the
 * request's `allow_once` option. Deny, timeout, Stop, the process exiting and a lost
 * connection all deny; nothing is auto-approved. With no tab or no prompt surface there
 * is no consent port, and the selector refuses the turn (`consent-port`).
 */

import { createHash } from 'crypto';
import type { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { createOutputParser } from '../../parsers';
import type { AgentError, ManagedProcess, ProcessConfig, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { buildChildProcessEnv, collectMaestroEnvVars } from '../utils/envBuilder';
import { isSupersededGeneration, nextSpawnGeneration } from '../generation';
import { DEFAULT_QUERY_SOURCE } from '../../../shared/querySource';
import { canonicalJson } from '../../../shared/canonicalJson';
import { INTERACTIVE_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';
import {
	unavailableEffectAuthority,
	type ManagedEffectAuthority,
} from '../../../shared/maestro-lib/managed/effects';
import type { ManagedPrincipalRef } from '../../../shared/maestro-lib/managed/types';
import {
	permissionRelayServer,
	type RelayConsentSession,
} from '../../permission-relay/PermissionRelayServer';
import { RELAY_DECISION_TIMEOUT_MS, type RelaySpawnBinding } from '../../permission-relay/types';
import {
	beginGrokAcpNegotiation,
	completeGrokAcpNegotiation,
	grokAcpProcessSpec,
	type GrokAcpNegotiation,
	type GrokRouteRefusal,
	type GrokRouteSnapshot,
} from '../../../shared/maestro-lib/grok/route';
import {
	startGrokAcpTurn,
	type GrokAcpRunningTurn,
} from '../../../shared/maestro-lib/grok/acp-turn';

const LOG_CONTEXT = 'GrokAcpSpawner';

/** Silence budget of a desktop ACP turn (reset by any output, including setup). */
export const GROK_ACP_DESKTOP_IDLE_MS = 30 * 60_000;
/** Hard ceiling of one desktop ACP prompt. */
export const GROK_ACP_DESKTOP_MAX_TURN_MS = 12 * 60 * 60_000;

/** Native flags the desktop launch builder generates; anything else is user argv. */
const GENERATED_VALUE_FLAGS = new Set([
	'--output-format',
	'--prompt-file',
	'-p',
	'--cwd',
	'--resume',
	'-m',
	'--reasoning-effort',
]);
const GENERATED_BOOLEAN_FLAGS = new Set(['--always-approve']);

/** Where a standalone turn's consent sessions come from (the permission relay). */
export interface GrokConsentPort {
	openConsentSession(binding: RelaySpawnBinding): RelayConsentSession | null;
}

/** The person at this desktop, the actor of a standalone consent binding. */
const DESKTOP_PERSON: ManagedPrincipalRef = Object.freeze({ kind: 'human', id: 'desktop-user' });

/** What the permission prompt shows of one ACP permission request: its tool and input. */
export function describeGrokPermission(request: unknown): {
	toolName: string;
	input: Record<string, unknown>;
} {
	const tool =
		request && typeof request === 'object'
			? (request as { toolCall?: unknown }).toolCall
			: undefined;
	const call = tool && typeof tool === 'object' ? (tool as Record<string, unknown>) : {};
	const name = [call.title, call.kind].find((v) => typeof v === 'string' && v.trim());
	const raw = call.rawInput;
	return {
		toolName: typeof name === 'string' ? name : 'Grok tool',
		input:
			raw && typeof raw === 'object' && !Array.isArray(raw)
				? { ...(raw as Record<string, unknown>) }
				: { toolCallId: call.toolCallId },
	};
}

/**
 * The effect authority of a standalone turn: each permission request is asked of the
 * person through the consent session. Only `allow` from the person grants (the driver
 * then selects the request's `allow_once` option); an Allow that edits the input is not
 * the request the person was shown and denies, and so does every other effect kind.
 */
export function grokConsentAuthority(session: RelayConsentSession): ManagedEffectAuthority {
	return {
		authorityId: 'desktop-person-consent',
		decide: async (effect, _binding, signal) => {
			if (effect.kind !== 'permissions')
				return { decision: 'deny', reason: 'Only permission requests are asked of the person.' };
			const { toolName, input } = describeGrokPermission(effect.permissions.request);
			const answer = await session.request(toolName, input, signal);
			if (answer.behavior !== 'allow') return { decision: 'deny', reason: answer.message };
			if (answer.updatedInput !== undefined)
				return { decision: 'deny', reason: 'An edited tool input cannot be approved for Grok.' };
			return { decision: 'allow' };
		},
	};
}

/** A desktop Grok turn whose launch plan asked for the provider's own prompting. */
export function wantsGrokAcp(config: ProcessConfig): boolean {
	return config.toolType === 'grok' && config.permission?.requested === 'standard';
}

interface ParsedNativeArgs {
	model?: string;
	effort?: string;
	/** `-p` value, when the prompt rode in argv rather than a prompt file. */
	prompt?: string;
	customArgs: boolean;
}

/** Read the generated native argv back into protocol options; unknown argv is custom. */
export function parseGrokNativeArgs(args: readonly string[]): ParsedNativeArgs {
	const parsed: ParsedNativeArgs = { customArgs: false };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GENERATED_BOOLEAN_FLAGS.has(arg)) continue;
		if (!GENERATED_VALUE_FLAGS.has(arg) || i + 1 >= args.length) {
			parsed.customArgs = true;
			continue;
		}
		const value = args[++i];
		if (arg === '-m') parsed.model = value;
		else if (arg === '--reasoning-effort') parsed.effort = value;
		else if (arg === '-p') parsed.prompt = value;
	}
	return parsed;
}

/** Text and image count of the planned prompt; an unreadable artifact is null. */
export function grokAcpPromptOf(
	config: Pick<ProcessConfig, 'prompt' | 'promptArtifact' | 'images'>,
	argvPrompt?: string
): { text: string; imageCount: number } | null {
	const images = config.images?.length ?? 0;
	const artifact = config.promptArtifact;
	if (!artifact) {
		const text = config.prompt ?? argvPrompt;
		return typeof text === 'string' ? { text, imageCount: images } : null;
	}
	let blocks: unknown;
	try {
		const value: unknown = JSON.parse(artifact.content);
		blocks =
			value && typeof value === 'object' && !Array.isArray(value)
				? (value as { type?: unknown; content?: unknown }).type === 'acp'
					? (value as { content?: unknown }).content
					: undefined
				: value;
	} catch {
		return null;
	}
	if (!Array.isArray(blocks)) return null;
	let text = '';
	let imageCount = images;
	for (const block of blocks as { type?: unknown; text?: unknown }[]) {
		if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
		else if (block?.type === 'image') imageCount += 1;
		else return null;
	}
	return { text, imageCount };
}

interface SpawnerContext {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	stdoutHandler: StdoutHandler;
	exitHandler: ExitHandler;
	effects: () => ManagedEffectAuthority | null;
	consent: GrokConsentPort;
}

export class GrokAcpSpawner {
	private readonly ctx: SpawnerContext;

	constructor(
		processes: Map<string, ManagedProcess>,
		emitter: EventEmitter,
		bufferManager: DataBufferManager,
		options: {
			effects?: () => ManagedEffectAuthority | null;
			/** Defaults to the permission relay, the one consent path of the desktop. */
			consent?: GrokConsentPort;
		} = {}
	) {
		this.ctx = {
			processes,
			emitter,
			stdoutHandler: new StdoutHandler({ processes, emitter, bufferManager }),
			exitHandler: new ExitHandler({ processes, emitter, bufferManager }),
			effects: options.effects ?? (() => null),
			consent: options.consent ?? permissionRelayServer,
		};
	}

	spawn(config: ProcessConfig): SpawnResult {
		const native = parseGrokNativeArgs(config.sshRemoteId ? [] : config.args);
		const prompt = grokAcpPromptOf(config, native.prompt);
		if (!prompt) return this.refuse(config, 'The planned Grok prompt could not be read.');
		const scope = config.nativeSessionScope;
		if (scope?.state !== 'bound')
			return this.refuse(
				config,
				'Grok account and host ownership is unknown, so the ACP route cannot bind this turn.'
			);
		const isResuming = !!config.agentSessionId;
		const env = buildChildProcessEnv(
			config.customEnvVars,
			isResuming,
			config.shellEnvVars,
			config.extraPathDirs,
			config.querySource
		);
		const snapshot: GrokRouteSnapshot = {
			executable: { path: config.command },
			agentVersion: null,
			platform: `${process.platform}-${process.arch}`,
			account: scope.accountRef,
			host: scope.host.identity,
			// Opaque fingerprint of everything the launch depends on; never persisted.
			configGeneration: createHash('sha256')
				.update(canonicalJson({ command: config.command, cwd: config.cwd, env, scope }))
				.digest('hex'),
			target: config.sshRemoteId || scope.host.kind !== 'local' ? 'remote' : 'local',
			native: { qualified: false },
		};
		// A standalone turn asks the person on its own tab; without a tab or a prompt
		// surface there is nobody to ask, and the selector refuses (consent-port).
		const consentSession =
			!config.admission && config.tabId
				? this.ctx.consent.openConsentSession({ sessionId: config.sessionId, tabId: config.tabId })
				: null;
		const negotiation = beginGrokAcpNegotiation(
			{
				permissionMode: 'standard',
				consent: config.admission ? 'authority' : consentSession ? 'interactive' : 'none',
				imageCount: prompt.imageCount,
				resume: isResuming,
				customArgs: native.customArgs,
			},
			snapshot
		);
		if (!negotiation.ok || !('pending' in negotiation)) {
			consentSession?.close();
			return negotiation.ok
				? this.refuse(config, 'The Grok route selector returned no ACP negotiation.')
				: this.refuse(config, negotiation.message, negotiation);
		}
		try {
			return new GrokAcpDesktopTurn(this.ctx, config, {
				negotiation,
				snapshot,
				env,
				prompt: prompt.text,
				model: native.model,
				effort: native.effort,
				consentSession,
			}).start();
		} catch (error) {
			consentSession?.close();
			void captureException(error);
			return this.refuse(
				config,
				`Grok ACP turn could not start: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** Nothing was started: the tab is told why, and the result says so. */
	private refuse(config: ProcessConfig, message: string, refusal?: GrokRouteRefusal): SpawnResult {
		logger.warn('[GrokAcpSpawner] Grok ACP turn refused', LOG_CONTEXT, {
			sessionId: config.sessionId,
			missing: refusal?.missing,
			parityRows: refusal?.parityRows,
		});
		const text = `${message} Nothing was started.`;
		this.ctx.emitter.emit('agent-error', config.sessionId, {
			type: 'permission_denied',
			message: text,
			recoverable: false,
			agentId: config.toolType,
			sessionId: config.sessionId,
			timestamp: Date.now(),
		} satisfies AgentError);
		return { pid: -1, success: false, error: text };
	}
}

interface DesktopTurnInput {
	negotiation: GrokAcpNegotiation;
	snapshot: GrokRouteSnapshot;
	env: NodeJS.ProcessEnv;
	prompt: string;
	model?: string;
	effort?: string;
	/** The person's consent session of a standalone turn; closed when the turn ends. */
	consentSession: RelayConsentSession | null;
}

/** One ACP process and the turn it runs. */
class GrokAcpDesktopTurn {
	private readonly managedProcess: ManagedProcess;
	private running!: GrokAcpRunningTurn;
	private routeRefusal: string | undefined;
	private stopped = false;
	private finished = false;

	constructor(
		private readonly ctx: SpawnerContext,
		private readonly config: ProcessConfig,
		private readonly input: DesktopTurnInput
	) {
		this.managedProcess = {
			sessionId: config.sessionId,
			toolType: config.toolType,
			cwd: config.cwd,
			pid: -1,
			isTerminal: false,
			isBatchMode: true,
			isStreamJsonMode: true,
			jsonBuffer: '',
			startTime: Date.now(),
			outputParser: createOutputParser(config.toolType) || undefined,
			stderrBuffer: '',
			stdoutBuffer: '',
			contextWindow: config.contextWindow,
			command: config.command,
			args: [],
			querySource: config.querySource,
			tabId: config.tabId,
			projectPath: config.projectPath,
			agentSessionId: config.agentSessionId,
			sdkController: {
				interrupt: () => this.cancel(),
				kill: (options) => this.kill(options),
			},
		};
	}

	start(): SpawnResult {
		const { config, input, managedProcess } = this;
		managedProcess.maestroEnvVars = collectMaestroEnvVars(
			config.shellEnvVars,
			config.customEnvVars,
			!!config.agentSessionId,
			config.querySource ?? DEFAULT_QUERY_SOURCE
		);
		const spec = grokAcpProcessSpec(
			input.negotiation,
			{
				command: config.command,
				cwd: config.cwd,
				env: input.env,
				target: { kind: 'local' },
				permission: config.permission!,
			},
			input.snapshot
		);
		const generation = nextSpawnGeneration(config.sessionId);
		const admission = config.admission;
		this.running = startGrokAcpTurn(
			spec,
			{
				turnId: `${config.sessionId}:${generation}`,
				processGeneration: String(generation),
				prompt: input.prompt,
				cwd: config.cwd,
				account: input.snapshot.account,
				host: input.snapshot.host,
				model: input.model,
				effort: input.effort,
				resumeSessionId: config.agentSessionId,
				idleTimeoutMs: GROK_ACP_DESKTOP_IDLE_MS,
				maxTurnMs: GROK_ACP_DESKTOP_MAX_TURN_MS,
				stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
				// A person gets the relay's decision window, not the 30 s machine default; the
				// adapter's watchdog and the relay's timer both deny when it runs out. The same
				// value bounds this turn's setup requests; Stop still ends them at once.
				...(input.consentSession ? { requestTimeoutMs: RELAY_DECISION_TIMEOUT_MS } : {}),
				permission: admission
					? {
							authority:
								this.ctx.effects() ??
								unavailableEffectAuthority('This host has no effect authority for managed turns.'),
							binding: { actor: admission.actor, leaseId: admission.leaseId },
						}
					: input.consentSession
						? {
								authority: grokConsentAuthority(input.consentSession),
								// Not a lease: the driver joins each answer to this turn and process.
								binding: {
									actor: DESKTOP_PERSON,
									leaseId: `desktop-consent:${config.sessionId}:${generation}`,
								},
							}
						: undefined,
				qualify: (negotiated) => {
					if (!negotiated.agentVersion) {
						this.routeRefusal = 'Grok ACP reported no agent version to bind this turn to.';
						return 'acp-version-unbound';
					}
					const decision = completeGrokAcpNegotiation(input.negotiation, {
						protocolVersion: negotiated.protocolVersion,
						agentVersion: negotiated.agentVersion,
						loadSession: negotiated.loadSession,
						// The port carries neither yet (GROK_ACP_PORT_SUPPORT); never claimed.
						images: false,
						commands: false,
					});
					if (decision.ok) return undefined;
					this.routeRefusal = decision.message;
					return decision.missing.join(',');
				},
			},
			{
				onEvent: (event) => {
					if (!this.isCurrent()) return;
					this.ctx.stdoutHandler.handleNormalizedEvent(config.sessionId, managedProcess, event);
				},
			}
		);
		managedProcess.pid = this.running.handle.pid ?? -1;
		managedProcess.spawnGeneration = generation;
		this.ctx.processes.set(config.sessionId, managedProcess);
		void this.running.completed.then(
			(completed) => this.settle(completed),
			(error: unknown) => {
				void captureException(error);
				this.emitAgentError(
					`Grok ACP turn failed: ${error instanceof Error ? error.message : String(error)}`
				);
				this.finish(1);
			}
		);
		logger.info('[GrokAcpSpawner] Started Grok ACP turn', LOG_CONTEXT, {
			sessionId: config.sessionId,
			pid: managedProcess.pid,
			resume: !!config.agentSessionId,
			managed: !!admission,
		});
		return { pid: managedProcess.pid, success: true };
	}

	private settle(completed: Awaited<GrokAcpRunningTurn['completed']>): void {
		const { terminal } = completed;
		if (completed.exit.spawnError) {
			this.emitAgentError(`Grok ACP could not start: ${completed.exit.spawnError.message}`);
			this.finish(1);
			return;
		}
		if (terminal.status === 'success') {
			this.finish(0);
			return;
		}
		if (this.routeRefusal) {
			this.emitAgentError(`${this.routeRefusal} No prompt was sent.`, 'permission_denied', false);
			this.finish(1);
			return;
		}
		// A stop the user asked for is not a crash.
		if (this.stopped && terminal.status === 'cancelled') {
			this.finish(0);
			return;
		}
		const unknown = terminal.dispatchState === 'unknown' ? ' The prompt may have run.' : '';
		this.emitAgentError(
			`Grok ACP turn ${terminal.status}${terminal.reason ? ` (${terminal.reason})` : ''}.${unknown}`,
			terminal.status === 'refused' ? 'permission_denied' : 'agent_crashed',
			terminal.dispatchState === 'not-dispatched'
		);
		this.finish(1);
	}

	private cancel(): void {
		this.stopped = true;
		this.running.cancel();
	}

	private kill(options: { sync?: boolean; shutdown?: boolean } = {}): void {
		this.stopped = true;
		this.running.cancel();
		if (options.shutdown || options.sync)
			this.running.handle.terminateNow({ blocking: options.sync });
		else this.running.handle.terminate();
	}

	private isCurrent(): boolean {
		return (
			!this.finished &&
			this.ctx.processes.get(this.config.sessionId) === this.managedProcess &&
			!isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration)
		);
	}

	private emitAgentError(
		message: string,
		type: AgentError['type'] = 'agent_crashed',
		recoverable = true
	): void {
		if (this.managedProcess.errorEmitted || !this.isCurrent()) return;
		this.managedProcess.errorEmitted = true;
		this.ctx.emitter.emit('agent-error', this.config.sessionId, {
			type,
			message,
			recoverable,
			agentId: this.config.toolType,
			sessionId: this.config.sessionId,
			timestamp: Date.now(),
		} satisfies AgentError);
	}

	/** Report the turn's exit through ExitHandler, exactly once. */
	private finish(code: number): void {
		if (this.finished) return;
		// Every request still waiting on the person is denied; exit clears the prompt.
		this.input.consentSession?.close();
		if (isSupersededGeneration(this.config.sessionId, this.managedProcess.spawnGeneration)) {
			this.finished = true;
			return;
		}
		this.finished = true;
		void this.ctx.exitHandler
			.handleExit(this.config.sessionId, code, this.managedProcess)
			.catch((error: unknown) => {
				logger.error('[GrokAcpSpawner] handleExit threw', LOG_CONTEXT, {
					sessionId: this.config.sessionId,
					error: String(error),
				});
			});
	}
}
