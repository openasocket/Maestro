import type { ChildProcess } from 'node:child_process';
import { canonicalJson } from '../../canonicalJson';
import { createIdleWatchdog, type IdleWatchdog } from '../control/idle-watchdog';
import { stopProcess, BACKGROUND_STOP_GRACE_MS } from '../control/termination';
import type { SessionTurnRequest } from '../run/session';
import { GrokAcpClient, type GrokAcpClientOptions } from './acp-client';
import {
	GrokAcpRequestError,
	GrokAcpTransportError,
	type AcpCall,
	type AcpFailure,
} from './acp-protocol';

export interface GrokAcpSessionOptions extends Pick<
	SessionTurnRequest,
	'cwd' | 'model' | 'resumeSessionId'
> {
	/** Already admitted, owned process. Account/environment selection happens before spawn. */
	child: ChildProcess;
	/** Opaque selected account and executing-host references, never credentials or a tab ID. */
	account: string;
	host: string;
	write: GrokAcpClientOptions['write'];
	requestHandlers?: GrokAcpClientOptions['requestHandlers'];
	maxFrameBytes?: number;
	requestTimeoutMs?: number;
	/** Silence budget, reset by nonempty stdout/stderr, including setup and load replay. */
	idleTimeoutMs: number;
	/** Explicit hard ceiling per prompt, separate from the silence budget. */
	maxTurnMs: number;
	cancelGraceMs?: number;
	/**
	 * Host-admitted, exact-version extension contract for this account/host/process.
	 * The pinned peer advertises no exhaustive method list. Source knowledge alone
	 * does not enable these options; the host owns qualification and discovery admission.
	 */
	extensions?: { agentVersion: string; promptId?: boolean; sessionUsage?: boolean };
	/** SSH owners supply their existing guarded terminate operation. */
	terminate?: () => void;
	onNotification?: (message: AcpCall, context: { replay: boolean; turn: number | null }) => void;
}

/** Lifecycle facts only; protocol terminal/usage normalization belongs to the event adapter. */
export class GrokAcpSessionError extends Error {
	constructor(
		readonly reason:
			| 'closed'
			| 'process-lost'
			| 'transport-lost'
			| 'cancelled'
			| 'idle-timeout'
			| 'turn-timeout'
			| 'cancel-timeout'
			| 'busy'
			| 'invalid-options'
			| 'invalid-response'
			| 'missing-session-id'
			| 'load-unsupported'
			| 'prompt-id-unsupported'
			| 'model-unacknowledged'
			| 'cwd-mismatch',
		readonly dispatchMayHaveOccurred = false,
		/** Retained for accounting after cancellation, never interpolated into diagnostics. */
		readonly response?: Record<string, unknown>,
		/** Only the transport's fixed, payload-free errors may be retained as a cause. */
		cause?: GrokAcpRequestError | GrokAcpTransportError
	) {
		super(`Grok ACP session: ${reason}`, { cause });
		this.name = 'GrokAcpSessionError';
	}
}

// Process-local exclusion across session objects; hosts still own cross-process serialization.
const residentSessions = new Set<string>();

/**
 * One native session on one already-owned ACP process. No spawn, login, persistence or retry.
 * The process owner feeds raw bytes and reports pipe errors through transportLost(). It keeps
 * admission/lease ownership until process cleanup, independently of a rejected prompt promise.
 */
export class GrokAcpSession {
	private readonly client: GrokAcpClient;
	private readonly options: Readonly<GrokAcpSessionOptions>;
	private opening?: Promise<Record<string, unknown>>;
	private nativeId?: string;
	private claim?: string;
	private failure?: GrokAcpSessionError;
	private watchdog?: IdleWatchdog;
	private cancelWatchdog?: IdleWatchdog;
	private active = false;
	private dispatched = false;
	private cancelled = false;
	private replay = false;
	private turn = 0;
	private queryingUsage = false;
	private usageUnavailable = false;
	private extensionsMatched = false;
	private lastPromptDispatched = false;

	constructor(options: GrokAcpSessionOptions) {
		this.options = Object.freeze({
			...options,
			extensions: options.extensions && Object.freeze({ ...options.extensions }),
		});
		for (const value of [
			options.idleTimeoutMs,
			options.maxTurnMs,
			options.cancelGraceMs ?? BACKGROUND_STOP_GRACE_MS,
		]) {
			if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
				throw new GrokAcpSessionError('invalid-options');
		}
		for (const value of [
			options.cwd,
			options.account,
			options.host,
			options.model,
			options.resumeSessionId,
			options.extensions?.agentVersion,
		]) {
			if (value !== undefined && (typeof value !== 'string' || !value.trim()))
				throw new GrokAcpSessionError('invalid-options');
		}
		this.client = new GrokAcpClient({
			write: options.write,
			requestHandlers: options.requestHandlers,
			requestTimeoutMs: options.requestTimeoutMs,
			maxFrameBytes: options.maxFrameBytes,
			onNotification: (message) =>
				this.options.onNotification?.(message, {
					replay: this.replay,
					turn: this.dispatched ? this.turn : null,
				}),
			onClose: (error) => this.fail('transport-lost', error),
		});
		options.child.once('exit', this.processLost);
		options.child.on('error', this.processLost);
		options.child.once('close', this.processClosed);
		if (options.child.exitCode !== null || options.child.signalCode !== null) this.processLost();
	}

	/** Set only by a confirmed new/load response, and retained through cancellation/failure. */
	get sessionId(): string | undefined {
		return this.nativeId;
	}
	get isClosed(): boolean {
		return this.failure !== undefined;
	}
	/** The first owned failure survives later cancellation and transport-close callbacks. */
	get error(): GrokAcpSessionError | undefined {
		return this.failure;
	}
	get promptDispatched(): boolean {
		return this.lastPromptDispatched;
	}
	get supportsPromptId(): boolean {
		return this.extensionsMatched && this.options.extensions?.promptId === true;
	}

	feedStdout(chunk: Uint8Array): void {
		if (chunk.byteLength) this.watchdog?.touch();
		this.client.feedStdout(chunk);
	}
	feedStderr(chunk: Uint8Array): void {
		if (chunk.byteLength) this.watchdog?.touch();
		this.client.feedStderr(chunk);
	}
	transportLost(reason: AcpFailure = 'closed'): void {
		this.client.close(reason);
	}

	/** Single-flight allocation. A failed load never creates a replacement conversation. */
	open(): Promise<Record<string, unknown>> {
		if (this.failure) return Promise.reject(this.failure);
		if (!this.opening) {
			this.armWatchdog();
			this.opening = Promise.resolve()
				.then(async () => {
					this.checkOpen();
					if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
					const initialized = await this.client.initialize();
					this.checkOpen();
					this.extensionsMatched =
						!!this.options.extensions?.agentVersion &&
						initialized._meta?.grokShell === true &&
						initialized._meta.agentVersion === this.options.extensions.agentVersion;
					if (this.active && this.cancelled) throw new GrokAcpSessionError('cancelled');
					const { cwd, model, resumeSessionId } = this.options;
					if (resumeSessionId) {
						if (initialized.agentCapabilities.loadSession !== true)
							throw new GrokAcpSessionError('load-unsupported');
						this.claimSession(resumeSessionId);
					}
					this.replay = resumeSessionId !== undefined;
					const value = await this.client.request(
						resumeSessionId ? 'session/load' : 'session/new',
						{
							cwd,
							mcpServers: [],
							...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
							...(!resumeSessionId && model ? { _meta: { modelId: model } } : {}),
						}
					);
					const response = this.record(value);
					// ACP load has no sessionId in its response: success confirms the requested ID.
					const id = resumeSessionId ?? response.sessionId;
					if (typeof id !== 'string' || !id.trim())
						throw new GrokAcpSessionError('missing-session-id');
					if (resumeSessionId && response.sessionId !== undefined && response.sessionId !== id)
						throw new GrokAcpSessionError('invalid-response');
					this.nativeId = id;
					// A response already received before process loss still confirms identity.
					// It cannot acquire a new claim or resurrect a closed session, however.
					this.checkOpen();
					if (!resumeSessionId) this.claimSession(id);
					if (response._meta != null) {
						const effectiveCwd = this.record(response._meta).currentWorkingDirectory;
						if (effectiveCwd !== undefined && effectiveCwd !== cwd)
							throw new GrokAcpSessionError('cwd-mismatch');
					}
					if (model) this.checkModel(response, model);
					return response;
				})
				.catch((error: unknown) => {
					if (!this.failure)
						this.fail(
							error instanceof GrokAcpSessionError ? error.reason : 'transport-lost',
							error
						);
					throw this.failure;
				})
				.finally(() => {
					this.replay = false;
					this.watchdog?.disarm();
				});
		}
		return this.opening;
	}

	/** Raw prompt response; a correlated response alone does not mean successful work. */
	async prompt(
		text: string,
		signal?: AbortSignal,
		promptId?: string
	): Promise<Record<string, unknown>> {
		this.checkOpen();
		if (this.active || this.queryingUsage) throw new GrokAcpSessionError('busy');
		if (promptId !== undefined && (typeof promptId !== 'string' || !promptId.trim()))
			throw new GrokAcpSessionError('invalid-options');
		if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
		this.active = true;
		this.cancelled = false;
		this.dispatched = false;
		this.lastPromptDispatched = false;
		this.turn += 1;
		const onAbort = (): void => this.cancel();
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			await this.open();
			this.checkOpen();
			if (this.cancelled) throw new GrokAcpSessionError('cancelled');
			if (promptId !== undefined && !this.supportsPromptId)
				throw new GrokAcpSessionError('prompt-id-unsupported');
			this.armWatchdog(this.options.maxTurnMs);
			// Set before writing: a writer can deliver notifications/cancellation synchronously.
			this.dispatched = true;
			this.lastPromptDispatched = true;
			const value = await this.client.request(
				'session/prompt',
				{
					sessionId: this.nativeId,
					prompt: [{ type: 'text', text }],
					...(promptId === undefined ? {} : { _meta: { promptId } }),
				},
				{ timeoutMs: this.options.maxTurnMs }
			);
			this.checkOpen();
			const response = this.record(value);
			if (this.cancelled || response.stopReason === 'cancelled')
				throw new GrokAcpSessionError('cancelled', true, response);
			if (typeof response.stopReason !== 'string' || !response.stopReason)
				throw new GrokAcpSessionError('invalid-response', true);
			return response;
		} catch (error) {
			if (error instanceof GrokAcpSessionError && error.reason === 'cancelled') throw error;
			if (!this.failure)
				this.fail(
					error instanceof GrokAcpSessionError
						? error.reason
						: error instanceof GrokAcpTransportError && error.reason === 'timeout'
							? 'turn-timeout'
							: 'transport-lost',
					error
				);
			throw this.failure;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			this.watchdog?.disarm();
			this.cancelWatchdog?.disarm();
			this.active = false;
			this.dispatched = false;
		}
	}

	/**
	 * Correlated optional process ledger, only between prompts under our native claim.
	 * Never poll during a turn: a sample could predate already delivered response usage.
	 * Absence/provider errors mean unknown usage; pipe/deadline failures end this owner.
	 */
	async processUsage(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
		this.checkOpen();
		if (this.active || this.queryingUsage) throw new GrokAcpSessionError('busy');
		if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
		if (!this.nativeId || !this.claim) throw new GrokAcpSessionError('missing-session-id');
		if (
			!this.extensionsMatched ||
			this.options.extensions?.sessionUsage !== true ||
			this.usageUnavailable
		)
			return;
		this.queryingUsage = true;
		const onAbort = (): void => this.fail('cancelled');
		signal?.addEventListener('abort', onAbort, { once: true });
		try {
			this.checkOpen();
			if (signal?.aborted) throw new GrokAcpSessionError('cancelled');
			this.armWatchdog();
			const value = await this.client.request('_x.ai/session/usage', { sessionId: this.nativeId });
			this.checkOpen();
			if (value == null) return;
			let response = this.record(value);
			// The pinned usage handler returns {usage} directly; other extension adapters
			// wrap {result, error}. A nested error (including string codes) always wins.
			if (response.error != null) {
				this.usageUnavailable = true;
				return;
			}
			if (Object.hasOwn(response, 'result')) {
				if (response.result == null) return;
				response = this.record(response.result);
				if (response.error != null) {
					this.usageUnavailable = true;
					return;
				}
			}
			if (response.sessionId !== undefined && response.sessionId !== this.nativeId)
				throw new GrokAcpSessionError('invalid-response', this.lastPromptDispatched);
			return response;
		} catch (error) {
			if (this.failure) throw this.failure;
			if (error instanceof GrokAcpRequestError) {
				this.usageUnavailable = true;
				return;
			}
			this.fail(
				error instanceof GrokAcpSessionError
					? error.reason
					: error instanceof GrokAcpTransportError && error.reason === 'timeout'
						? 'turn-timeout'
						: 'transport-lost',
				error
			);
			throw this.failure;
		} finally {
			signal?.removeEventListener('abort', onAbort);
			this.watchdog?.disarm();
			this.queryingUsage = false;
		}
	}

	/** Wait for the original prompt response; the notification has no response of its own. */
	cancel(): void {
		if (this.queryingUsage) {
			this.fail('cancelled');
			return;
		}
		if (!this.active || this.cancelled || this.failure) return;
		this.cancelled = true;
		// Give allocation a bounded chance to return its ID; it must never dispatch the prompt.
		this.cancelWatchdog = createIdleWatchdog({
			idleMs: this.options.cancelGraceMs ?? BACKGROUND_STOP_GRACE_MS,
			onIdle: () => this.fail('cancel-timeout'),
		});
		if (this.dispatched && this.nativeId) {
			try {
				this.client.notify('session/cancel', { sessionId: this.nativeId });
			} catch (error) {
				this.fail('transport-lost', error);
			}
		}
	}

	close(): void {
		this.fail('closed');
	}

	private checkOpen(): void {
		if (this.failure) throw this.failure;
	}
	private record(value: unknown): Record<string, unknown> {
		if (value === null || typeof value !== 'object' || Array.isArray(value))
			throw new GrokAcpSessionError('invalid-response', this.dispatched);
		return value as Record<string, unknown>;
	}
	private checkModel(response: Record<string, unknown>, requested: string): void {
		const models = response.models == null ? undefined : this.record(response.models);
		const config = response.configOptions;
		let effective = models?.currentModelId;
		if (config != null) {
			if (!Array.isArray(config)) throw new GrokAcpSessionError('invalid-response');
			for (const value of config) {
				const option = this.record(value);
				if (option.id === 'model') {
					if (option.type !== 'select' || option.currentValue !== requested)
						throw new GrokAcpSessionError('model-unacknowledged');
					effective ??= option.currentValue;
				}
			}
		}
		if (effective !== requested) throw new GrokAcpSessionError('model-unacknowledged');
	}
	private claimSession(id: string): void {
		const key = canonicalJson([this.options.account, this.options.host, id]);
		if (residentSessions.has(key)) throw new GrokAcpSessionError('busy');
		residentSessions.add(key);
		this.claim = key;
	}
	private armWatchdog(maxMs?: number): void {
		this.watchdog?.disarm();
		this.watchdog = createIdleWatchdog({
			idleMs: this.options.idleTimeoutMs,
			maxMs,
			onIdle: () => this.fail('idle-timeout'),
			onMax: () => this.fail('turn-timeout'),
		});
	}
	private fail(reason: GrokAcpSessionError['reason'], cause?: unknown): void {
		if (this.failure) return;
		this.failure = new GrokAcpSessionError(
			reason,
			this.lastPromptDispatched,
			undefined,
			cause instanceof GrokAcpRequestError || cause instanceof GrokAcpTransportError
				? cause
				: undefined
		);
		this.watchdog?.disarm();
		this.cancelWatchdog?.disarm();
		this.client.close();
		this.options.child.off('exit', this.processLost);
		// Keep error/close listeners and the claim until the owned process's pipes close.
		if (this.options.terminate) this.options.terminate();
		else
			stopProcess(
				{ child: this.options.child },
				{ from: 'terminate', graceMs: BACKGROUND_STOP_GRACE_MS }
			);
	}
	private readonly processLost = (): void => {
		this.fail('process-lost');
	};
	private readonly processClosed = (): void => {
		try {
			this.processLost();
		} finally {
			this.options.child.off('error', this.processLost);
			if (this.claim) residentSessions.delete(this.claim);
			this.claim = undefined;
		}
	};
}
