import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GrokAcpSession,
	type GrokAcpSessionOptions,
} from '../../../../shared/maestro-lib/grok/acp-session';
import type { AcpCall } from '../../../../shared/maestro-lib/grok/acp-protocol';

describe('GrokAcpSession lifecycle over fake ACP bytes', () => {
	const fixtures: ReturnType<typeof harness>[] = [];
	function harness(overrides: Partial<GrokAcpSessionOptions> = {}) {
		// No process is spawned; termination and pipe closure remain independently observable.
		const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
		const terminate = vi.fn();
		const onNotification = vi.fn();
		const write = vi.fn<(frame: Uint8Array) => void>();
		const session = new GrokAcpSession({
			cwd: '/synthetic/project',
			account: 'fixture-account',
			host: 'fixture-host',
			idleTimeoutMs: 100,
			maxTurnMs: 300,
			cancelGraceMs: 40,
			...overrides,
			child: child as unknown as ChildProcess,
			write,
			terminate,
			onNotification,
		});
		const sent = (method: string): AcpCall[] =>
			write.mock.calls
				.map(([frame]) => JSON.parse(new TextDecoder().decode(frame)) as AcpCall)
				.filter((message) => message.method === method);
		const receive = (message: Record<string, unknown>) =>
			session.feedStdout(
				new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
			);
		const reply = (request: AcpCall, result: unknown) => receive({ id: request.id, result });
		async function next(method: string, count = 1) {
			// Drain promise continuations without advancing any lifecycle budget.
			await vi.advanceTimersByTimeAsync(0);
			expect(sent(method)).toHaveLength(count);
			return sent(method)[count - 1];
		}
		async function allocation(loadSession = true) {
			reply(await next('initialize'), { protocolVersion: 1, agentCapabilities: { loadSession } });
			return next(overrides.resumeSessionId ? 'session/load' : 'session/new');
		}
		async function ready(result: unknown = { sessionId: 'native-1' }) {
			const opening = session.open();
			reply(await allocation(), result);
			await opening;
		}
		const fixture = {
			session,
			child,
			terminate,
			onNotification,
			write,
			sent,
			receive,
			reply,
			next,
			allocation,
			ready,
		};
		fixtures.push(fixture);
		return fixture;
	}
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		for (const { session, child } of fixtures.splice(0)) {
			session.close();
			child.emit('close', 0, null);
		}
		try {
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it('allocates once, serializes turns, ignores stale replies and loads the confirmed native ID', async () => {
		const h = harness({ model: 'fixture-model' });
		const opening = h.session.open();
		expect(h.session.open()).toBe(opening);
		const allocation = await h.allocation();
		expect(allocation.params).toEqual({
			cwd: '/synthetic/project',
			mcpServers: [],
			_meta: { modelId: 'fixture-model' },
		});
		h.reply(allocation, { sessionId: 'native-1', models: { currentModelId: 'fixture-model' } });
		await opening;
		const first = h.session.prompt('first');
		const request = await h.next('session/prompt');
		expect(request.params).toEqual({
			sessionId: 'native-1',
			prompt: [{ type: 'text', text: 'first' }],
		});
		await expect(h.session.prompt('overlap')).rejects.toMatchObject({
			reason: 'busy',
			dispatchMayHaveOccurred: false,
		});
		h.receive({ method: 'session/update', params: { sessionId: 'native-1' } });
		expect(h.onNotification.mock.lastCall?.[1]).toEqual({ replay: false, turn: 1 });
		h.reply(request, { stopReason: 'end_turn' });
		await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
		const settled = vi.fn();
		const second = h.session.prompt('second').then(settled);
		const secondRequest = await h.next('session/prompt', 2);
		expect(secondRequest.params).toMatchObject({ sessionId: 'native-1' });
		h.reply(request, { stopReason: 'end_turn', stale: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();
		h.receive({ method: 'session/update' });
		expect(h.onNotification.mock.lastCall?.[1]).toEqual({ replay: false, turn: 2 });
		h.reply(secondRequest, { stopReason: 'end_turn' });
		await second;
		expect(settled).toHaveBeenCalledExactlyOnceWith({ stopReason: 'end_turn' });
		expect(h.sent('initialize')).toHaveLength(1);
		expect(h.sent('session/new')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		h.session.close();
		h.child.emit('close');

		const resumed = harness({ resumeSessionId: h.session.sessionId, model: 'fixture-model' });
		const turn = resumed.session.prompt('continue');
		const load = await resumed.allocation();
		expect(load.params).toEqual({
			cwd: '/synthetic/project',
			mcpServers: [],
			sessionId: 'native-1',
		});
		resumed.receive({ method: 'session/update', params: { history: true } });
		expect(resumed.onNotification.mock.lastCall?.[1]).toEqual({ replay: true, turn: null });
		// ACP load confirms its input ID without echoing it in the response.
		resumed.reply(load, {
			configOptions: [{ id: 'model', type: 'select', currentValue: 'fixture-model' }],
		});
		resumed.reply(await resumed.next('session/prompt'), { stopReason: 'end_turn' });
		await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
		expect(resumed.session.sessionId).toBe('native-1');
		expect(resumed.sent('session/new')).toHaveLength(0);
	});

	it.each(['unsupported', 'rejected'] as const)(
		'never replaces an %s load with a new session',
		async (mode) => {
			const h = harness({ resumeSessionId: 'native-1' });
			const failed = h.session.prompt('continue').catch((error: unknown) => error);
			h.reply(await h.next('initialize'), {
				protocolVersion: 1,
				agentCapabilities: { loadSession: mode !== 'unsupported' },
			});
			if (mode === 'rejected')
				h.receive({
					id: (await h.next('session/load')).id,
					error: { code: -32602, message: 'unavailable' },
				});
			expect(await failed).toMatchObject({
				reason: mode === 'unsupported' ? 'load-unsupported' : 'transport-lost',
				dispatchMayHaveOccurred: false,
			});
			expect(h.session.sessionId).toBeUndefined();
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
		}
	);

	it('does no work for a pre-aborted signal and permits a later explicit turn', async () => {
		const h = harness();
		await expect(h.session.prompt('unsent', AbortSignal.abort())).rejects.toMatchObject({
			reason: 'cancelled',
			dispatchMayHaveOccurred: false,
		});
		expect(h.write).not.toHaveBeenCalled();
		expect(h.session.isClosed).toBe(false);
		await h.ready();
		const turn = h.session.prompt('explicit');
		h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
		await expect(turn).resolves.toEqual({ stopReason: 'end_turn' });
	});

	it.each(['before-initialize', 'during-initialize'] as const)(
		'cancels %s without allocating or dispatching',
		async (stage) => {
			const h = harness();
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const failed = h.session.prompt('unsent', controller.signal).catch((error: unknown) => error);
			const request = stage === 'during-initialize' ? await h.next('initialize') : undefined;
			controller.abort();
			if (request) h.reply(request, { protocolVersion: 1 });
			expect(await failed).toMatchObject({ reason: 'cancelled', dispatchMayHaveOccurred: false });
			expect(h.sent('initialize')).toHaveLength(request ? 1 : 0);
			expect(h.sent('session/new')).toHaveLength(0);
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('retains allocation after cancellation without dispatch, then accepts an explicit next turn', async () => {
		const h = harness();
		const failed = h.session.prompt('cancelled before dispatch').catch((error: unknown) => error);
		const allocation = await h.allocation();
		h.session.cancel();
		h.session.cancel();
		h.reply(allocation, { sessionId: 'native-1' });
		expect(await failed).toMatchObject({ reason: 'cancelled', dispatchMayHaveOccurred: false });
		expect(h.session.sessionId).toBe('native-1');
		expect(h.session.isClosed).toBe(false);
		expect(h.sent('session/prompt')).toHaveLength(0);
		expect(h.sent('session/cancel')).toHaveLength(0);
		const next = h.session.prompt('explicit next turn');
		h.reply(await h.next('session/prompt'), { stopReason: 'end_turn' });
		await next;
		expect(h.sent('session/new')).toHaveLength(1);
	});

	it.each(['end_turn', 'cancelled'])(
		'waits for the original %s reply after cancellation and never reports success',
		async (stopReason) => {
			const h = harness();
			await h.ready();
			const controller = new AbortController();
			const remove = vi.spyOn(controller.signal, 'removeEventListener');
			const success = vi.fn();
			const failure = vi.fn();
			const turn = h.session.prompt('once', controller.signal).then(success, failure);
			const request = await h.next('session/prompt');
			controller.abort();
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(0);
			expect(failure).not.toHaveBeenCalled();
			expect(h.sent('session/cancel')).toEqual([
				{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'native-1' } },
			]);
			await expect(h.session.prompt('too early')).rejects.toMatchObject({ reason: 'busy' });
			const response = { stopReason, usage: { inputTokens: 12 } };
			h.reply(request, response);
			await turn;
			expect(success).not.toHaveBeenCalled();
			expect(failure).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ reason: 'cancelled', dispatchMayHaveOccurred: true, response })
			);
			expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
			expect(h.session.isClosed).toBe(false);
			expect(h.terminate).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
			const next = h.session.prompt('explicit retry');
			h.reply(await h.next('session/prompt', 2), { stopReason: 'end_turn' });
			await next;
		}
	);

	it.each(
		(['exit', 'error', 'close', 'transport', 'explicit-close'] as const).flatMap((loss) =>
			[false, true].map((replyFirst) => ({ loss, replyFirst }))
		)
	)(
		'rejects on $loss (reply already received: $replyFirst) and ignores later replies/retries',
		async ({ loss, replyFirst }) => {
			const h = harness();
			await h.ready();
			const success = vi.fn();
			const failure = vi.fn();
			const turn = h.session.prompt('side effect').then(success, failure);
			const request = await h.next('session/prompt');
			if (replyFirst) h.reply(request, { stopReason: 'end_turn' });
			if (loss === 'transport') h.session.transportLost();
			else if (loss === 'explicit-close') h.session.close();
			else h.child.emit(loss, new Error('synthetic-private-error'));
			await turn;
			const error = failure.mock.calls[0][0];
			expect(error).toMatchObject({
				reason:
					loss === 'transport'
						? 'transport-lost'
						: loss === 'explicit-close'
							? 'closed'
							: 'process-lost',
				dispatchMayHaveOccurred: true,
			});
			expect(String(error) + JSON.stringify(error)).not.toContain('synthetic-private-error');
			h.reply(request, { stopReason: 'end_turn' });
			await expect(h.session.prompt('retry')).rejects.toBe(error);
			await expect(h.session.open()).rejects.toBe(error);
			expect(success).not.toHaveBeenCalled();
			expect(failure).toHaveBeenCalledTimes(1);
			expect(h.sent('session/prompt')).toHaveLength(1);
			expect(h.session.sessionId).toBe('native-1');
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('preserves a received allocation ID across immediate process loss without sending its prompt', async () => {
		const h = harness();
		const failed = h.session.prompt('unsent').catch((error: unknown) => error);
		h.reply(await h.allocation(), { sessionId: 'native-1' });
		h.child.emit('close');
		expect(await failed).toMatchObject({ reason: 'process-lost', dispatchMayHaveOccurred: false });
		expect(h.session.sessionId).toBe('native-1');
		expect(h.sent('session/prompt')).toHaveLength(0);
		const replacement = harness({ resumeSessionId: 'native-1' });
		await replacement.ready({});
		expect(replacement.session.sessionId).toBe('native-1');
	});

	it.each([undefined, '', '   ', 123])(
		'rejects missing/invalid native identity %s before prompt dispatch',
		async (sessionId) => {
			const h = harness();
			const failed = h.session.prompt('unsent').catch((error: unknown) => error);
			h.reply(await h.allocation(), { sessionId });
			expect(await failed).toMatchObject({
				reason: 'missing-session-id',
				dispatchMayHaveOccurred: false,
			});
			expect(h.session.sessionId).toBeUndefined();
			expect(h.sent('session/prompt')).toHaveLength(0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
		}
	);

	it.each([
		{},
		{ models: { currentModelId: 'other' } },
		{
			models: { currentModelId: 'selected' },
			configOptions: [{ id: 'model', type: 'select', currentValue: 'other' }],
		},
	])('refuses unacknowledged model state %j while retaining identity', async (state) => {
		const h = harness({ model: 'selected' });
		const failed = h.session.prompt('unsent').catch((error: unknown) => error);
		h.reply(await h.allocation(), { sessionId: 'native-1', ...state });
		expect(await failed).toMatchObject({
			reason: 'model-unacknowledged',
			dispatchMayHaveOccurred: false,
		});
		expect(h.session.sessionId).toBe('native-1');
		expect(h.sent('session/prompt')).toHaveLength(0);
		expect(h.terminate).toHaveBeenCalledTimes(1);
	});

	it.each(['setup', 'turn'] as const)(
		'enforces silence during %s with stdout/stderr activity and empty chunks',
		async (stage) => {
			const h = harness();
			if (stage === 'turn') await h.ready();
			const failed = h.session.prompt('silent').catch((error: unknown) => error);
			const request = await h.next(stage === 'setup' ? 'initialize' : 'session/prompt');
			await vi.advanceTimersByTimeAsync(90);
			h.receive({ method: 'session/update' });
			await vi.advanceTimersByTimeAsync(90);
			h.session.feedStderr(new TextEncoder().encode('progress'));
			await vi.advanceTimersByTimeAsync(90);
			h.session.feedStdout(new Uint8Array());
			h.session.feedStderr(new Uint8Array());
			expect(h.session.isClosed).toBe(false);
			await vi.advanceTimersByTimeAsync(10);
			expect(await failed).toMatchObject({
				reason: 'idle-timeout',
				dispatchMayHaveOccurred: stage === 'turn',
			});
			h.reply(request, stage === 'setup' ? { protocolVersion: 1 } : { stopReason: 'end_turn' });
			expect(h.sent('session/prompt')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('keeps the hard turn deadline fixed despite output', async () => {
		const h = harness();
		await h.ready();
		const failed = h.session.prompt('chatty').catch((error: unknown) => error);
		await h.next('session/prompt');
		for (let i = 0; i < 3; i++) {
			await vi.advanceTimersByTimeAsync(90);
			h.receive({ method: 'session/update' });
		}
		expect(h.session.isClosed).toBe(false);
		await vi.advanceTimersByTimeAsync(30);
		expect(await failed).toMatchObject({ reason: 'turn-timeout', dispatchMayHaveOccurred: true });
		expect(h.sent('session/prompt')).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['allocation', 'turn'] as const)(
		'bounds cancellation during %s even with continued output',
		async (stage) => {
			const h = harness();
			if (stage === 'turn') await h.ready();
			const failed = h.session.prompt('cancel').catch((error: unknown) => error);
			const request = stage === 'turn' ? await h.next('session/prompt') : await h.allocation();
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(30);
			h.receive({ method: 'session/update' });
			h.session.cancel();
			await vi.advanceTimersByTimeAsync(10);
			expect(await failed).toMatchObject({
				reason: 'cancel-timeout',
				dispatchMayHaveOccurred: stage === 'turn',
			});
			h.reply(request, stage === 'turn' ? { stopReason: 'end_turn' } : { sessionId: 'too-late' });
			expect(h.session.sessionId).toBe(stage === 'turn' ? 'native-1' : undefined);
			expect(h.sent('session/cancel')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(h.sent('session/prompt')).toHaveLength(stage === 'turn' ? 1 : 0);
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('holds resident identity and error listeners until pipe close, then permits explicit load', async () => {
		const h = harness();
		await h.ready();
		h.session.close();
		h.session.close();
		h.child.emit('exit', 1, null);
		h.child.emit('error', new Error('late error'));
		expect(h.terminate).toHaveBeenCalledTimes(1);
		expect(h.child.listenerCount('exit')).toBe(0);
		expect(h.child.listenerCount('error')).toBe(1);
		const duplicate = harness({ resumeSessionId: 'native-1' });
		const failed = duplicate.session.open().catch((error: unknown) => error);
		duplicate.reply(await duplicate.next('initialize'), {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
		});
		expect(await failed).toMatchObject({ reason: 'busy', dispatchMayHaveOccurred: false });
		expect(duplicate.sent('session/load')).toHaveLength(0);
		h.child.emit('close');
		expect(h.child.eventNames()).toEqual([]);
		const replacement = harness({ resumeSessionId: 'native-1' });
		await replacement.ready({});
		expect(replacement.session.sessionId).toBe('native-1');
	});

	it.each(['write', 'remote', 'disconnect'] as const)(
		'never retries an uncertain prompt after %s failure',
		async (mode) => {
			const h = harness();
			await h.ready();
			if (mode === 'write')
				h.write.mockImplementationOnce(() => {
					throw new Error('private writer error');
				});
			const failed = h.session.prompt('side effect').catch((error: unknown) => error);
			const request = await h.next('session/prompt');
			if (mode === 'remote')
				h.receive({ id: request.id, error: { code: -32603, message: 'private remote error' } });
			if (mode === 'disconnect') h.session.transportLost();
			const error = await failed;
			expect(error).toMatchObject({ reason: 'transport-lost', dispatchMayHaveOccurred: true });
			h.reply(request, { stopReason: 'end_turn' });
			await expect(h.session.prompt('retry')).rejects.toBe(error);
			expect(h.sent('session/prompt')).toHaveLength(1);
			expect(h.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		}
	);
});
