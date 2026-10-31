import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableEffects } from '../../../helpers/managedSpawnPort';
import { GrokAcpClient } from '../../../../shared/maestro-lib/grok/acp-client';
import {
	GrokAcpRequestAdapter,
	type GrokAcpPermissionSettlement,
	type GrokAcpPermissionTurn,
} from '../../../../shared/maestro-lib/grok/acp-requests';
import {
	GrokAcpTransportError,
	type AcpAnswer,
	type AcpMessage,
	type AcpRequestId,
} from '../../../../shared/maestro-lib/grok/acp-protocol';
import type {
	ManagedEffectAuthority,
	ManagedEffectDecision,
} from '../../../../shared/maestro-lib/managed/effects';
import {
	resolveTurnOutcome,
	type TurnTerminal,
} from '../../../../shared/maestro-lib/streaming/turn-outcome';

// Synthetic ACP wire-1/schema-0.11.4 fixtures; these do not qualify native containment.
const permission = (id: AcpRequestId = 1, params: Record<string, unknown> = {}) => ({
	jsonrpc: '2.0' as const,
	id,
	method: 'session/request_permission',
	params: {
		sessionId: 'native-1',
		toolCall: { toolCallId: `tool-${id}`, title: 'Synthetic tool', rawInput: { command: 'pwd' } },
		options: [
			{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
			{ optionId: 'no', name: 'Deny once', kind: 'reject_once' },
		],
		...params,
	},
});

describe('Grok ACP permission requests', () => {
	let adapter: GrokAcpRequestAdapter;
	let client: GrokAcpClient;
	let controller: AbortController;
	let turn: GrokAcpPermissionTurn;
	let end: () => void;
	let pending: Array<{
		resolve: (decision: ManagedEffectDecision) => void;
		reject: (error: Error) => void;
		signal: AbortSignal;
	}>;
	const decide = vi.fn<ManagedEffectAuthority['decide']>();
	const settled = vi.fn<(value: GrokAcpPermissionSettlement) => void>();
	const fault = vi.fn<(error: GrokAcpTransportError) => void>();
	const write = vi.fn<(bytes: Uint8Array) => void>();
	const receive = (message: unknown) =>
		client.feedStdout(new TextEncoder().encode(JSON.stringify(message) + '\n'));
	const sent = (): AcpMessage[] =>
		write.mock.calls.map(([bytes]) => JSON.parse(new TextDecoder().decode(bytes)));
	const selected = (id: AcpRequestId, optionId: string) => ({
		jsonrpc: '2.0',
		id,
		result: { outcome: { outcome: 'selected', optionId } },
	});
	const cancelled = (id: AcpRequestId) => ({
		jsonrpc: '2.0',
		id,
		result: { outcome: { outcome: 'cancelled' } },
	});
	function nonSuccess(index: number, status: TurnTerminal['status']) {
		const terminal = settled.mock.calls[index][0].terminal;
		expect(terminal).toMatchObject({ status, dispatchState: 'dispatched' });
		expect(
			resolveTurnOutcome(
				{
					exitCode: 0,
					signal: null,
					interrupted: false,
					stderrText: '',
					stdoutText: '',
					explicitError: undefined,
					capturedAnswerText: 'Useful partial answer',
					resultMessageSeen: true,
					terminal,
				},
				{ detectErrorFromExit: () => null },
				{ providerId: 'grok', sessionId: 'tab-1' }
			)
		).toMatchObject({ outcome: status === 'cancelled' ? 'interrupted' : 'crashed', terminal });
	}
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetAllMocks();
		pending = [];
		controller = new AbortController();
		decide.mockImplementation(
			(_effect, _binding, signal) =>
				new Promise((resolve, reject) => pending.push({ resolve, reject, signal }))
		);
		adapter = new GrokAcpRequestAdapter({
			account: 'fixture-account',
			host: 'fixture-host',
			cwd: '/synthetic/project',
			processGeneration: 'process-1',
			timeoutMs: 100,
			onSettlement: settled,
			onFault: fault,
		});
		client = new GrokAcpClient({
			write,
			requestHandlers: adapter.requestHandlers,
			onClose: () => adapter.close(),
		});
		fault.mockImplementation((error) => client.close(error.reason));
		const initialization = client.initialize();
		await Promise.resolve();
		receive({ jsonrpc: '2.0', id: sent()[0].id, result: { protocolVersion: 1 } });
		await initialization;
		write.mockClear();
		turn = {
			sessionId: 'native-1',
			turnId: 'host-1',
			promptId: 'prompt-1',
			signal: controller.signal,
			authority: tableEffects(decide),
			binding: { actor: { kind: 'human', id: 'fixture-actor' }, leaseId: 'lease-1' },
		};
		end = adapter.beginTurn(turn);
	});
	afterEach(() => {
		client.close();
		try {
			expect(vi.getTimerCount()).toBe(0);
			for (const request of pending) expect(request.signal.aborted).toBe(true);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it('grants only the advertised once option with the original complete effect and binding', async () => {
		receive(permission());
		turn.binding!.actor.id = 'mutated';
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([]);
		expect(decide).toHaveBeenCalledExactlyOnceWith(
			{
				kind: 'permissions',
				permissions: {
					method: 'session/request_permission',
					requestId: 1,
					scope: 'once',
					account: 'fixture-account',
					host: 'fixture-host',
					cwd: '/synthetic/project',
					processGeneration: 'process-1',
					turnId: 'host-1',
					request: permission().params,
				},
			},
			{
				provider: 'grok',
				actor: { kind: 'human', id: 'fixture-actor' },
				leaseId: 'lease-1',
				threadId: 'native-1',
				turnId: 'prompt-1',
				requestId: '["process-1","host-1",1]',
			},
			pending[0].signal
		);
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([selected(1, 'yes')]);
		expect(settled).toHaveBeenCalledExactlyOnceWith({
			requestId: 1,
			sessionId: 'native-1',
			turnId: 'host-1',
			reason: 'allowed',
			decision: 'allow',
			responseWritten: true,
			terminal: undefined,
		});
		expect(pending[0].signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['deny', 'unavailable', 'unknown'] as const)('refuses %s', async (decision) => {
		decide.mockReturnValue({ decision, reason: 'Synthetic refusal' });
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([decision === 'deny' ? selected(1, 'no') : cancelled(1)]);
		expect(settled.mock.calls[0][0]).toMatchObject({
			decision,
			reason: decision === 'deny' ? 'denied' : decision,
		});
		nonSuccess(0, 'refused');
	});

	it('does not invent reject-once or promote deny to reject-always', async () => {
		decide.mockReturnValue({ decision: 'deny', reason: 'Denied' });
		receive(
			permission(1, {
				options: [
					permission().params.options[0],
					{ optionId: 'never', name: 'Never', kind: 'reject_always' },
				],
			})
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled.mock.calls[0][0].reason).toBe('denied');
		nonSuccess(0, 'refused');
	});

	it.each(['authority', 'binding', 'lease', 'actor'] as const)('missing %s', async (missing) => {
		end();
		if (missing === 'authority') turn.authority = undefined;
		else if (missing === 'binding') turn.binding = undefined;
		else if (missing === 'lease') turn.binding!.leaseId = '';
		else turn.binding!.actor.id = '';
		adapter.beginTurn(turn);
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).not.toHaveBeenCalled();
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled.mock.calls[0][0].reason).toBe('unavailable');
		nonSuccess(0, 'refused');
	});

	it.each([
		['allow_always', 'unsupported-options'],
		['reject_once', 'unsupported-options'],
		['future', 'unsupported-options'],
		['two-allows', 'unsupported-options'],
		['duplicate-id', 'invalid-request'],
		['empty', 'invalid-request'],
		['missing-name', 'invalid-request'],
		['too-many', 'invalid-request'],
	])('refuses %s options before asking authority', async (mode, reason) => {
		const once = permission().params.options[0];
		let options: unknown = [{ ...once, kind: mode }];
		if (mode === 'two-allows') options = [once, { ...once, optionId: 'second' }];
		if (mode === 'duplicate-id') options = [once, { ...once, kind: 'reject_once' }];
		if (mode === 'empty') options = [];
		if (mode === 'missing-name') options = [{ optionId: 'yes', kind: 'allow_once' }];
		if (mode === 'too-many')
			options = Array.from({ length: 65 }, (_, i) => ({ ...once, optionId: `${i}` }));
		receive(permission(1, { options }));
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).not.toHaveBeenCalled();
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled.mock.calls[0][0].reason).toBe(reason);
		nonSuccess(0, 'refused');
	});

	it.each([
		{ sessionId: 'foreign' },
		{ sessionId: undefined },
		{ _meta: { sessionId: 'foreign' } },
		{ _meta: { promptId: 'old-prompt' } },
	])('rejects foreign identity %j without assigning the current turn', async (params) => {
		receive(permission(1, params));
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).not.toHaveBeenCalled();
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled.mock.calls[0][0]).toMatchObject({ reason: 'stale-request', turnId: null });
	});

	it('requires confirmed native prompt binding for stamped requests, never fabricates it', async () => {
		end();
		adapter.beginTurn({ ...turn, promptId: undefined });
		receive(permission(1, { _meta: { promptId: 'host-1' } }));
		receive(permission(2));
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(decide.mock.calls[0][1]).toMatchObject({ turnId: null });
		expect(settled.mock.calls[0][0]).toMatchObject({
			requestId: 1,
			reason: 'stale-request',
			turnId: null,
		});
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([cancelled(1), selected(2, 'yes')]);
	});

	it('ignores permission-shaped notifications and refuses unregistered methods', async () => {
		receive({ ...permission(), id: undefined });
		receive({ ...permission(2), method: 'session/update' });
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).not.toHaveBeenCalled();
		expect(settled).not.toHaveBeenCalled();
		expect(sent()).toEqual([
			{ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found' } },
		]);
	});

	it.each([
		['cancel', 'cancelled', 'cancelled'],
		['end', 'turn-ended', 'cancelled'],
		['timeout', 'timeout', 'timeout'],
		['disconnect', 'disconnected', 'failed'],
	] as const)('ignores late allow after %s', async (cause, reason, status) => {
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		if (cause === 'cancel') controller.abort();
		else if (cause === 'end') end();
		else if (cause === 'timeout') await vi.advanceTimersByTimeAsync(100);
		else client.close();
		expect(pending[0].signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		pending[0].resolve({ decision: 'allow' });
		controller.abort();
		end();
		client.close();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent()).toEqual(cause === 'disconnect' ? [] : [cancelled(1)]);
		expect(settled).toHaveBeenCalledTimes(1);
		expect(settled.mock.calls[0][0]).toMatchObject({
			reason,
			responseWritten: cause !== 'disconnect',
			requestId: 1,
			sessionId: 'native-1',
			turnId: 'host-1',
		});
		nonSuccess(0, status);
	});

	it.each(['before-request', 'before-authority'] as const)('%s cancellation', async (timing) => {
		if (timing === 'before-request') {
			end();
			controller.abort();
			adapter.beginTurn(turn);
		}
		receive(permission());
		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		expect(decide).not.toHaveBeenCalled();
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it.each(['native-1', 'native-2'])('isolates replacement in %s', async (sessionId) => {
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		expect(() => adapter.beginTurn(turn)).toThrow('already active');
		end();
		adapter.beginTurn({
			...turn,
			sessionId,
			turnId: 'host-2',
			promptId: 'prompt-2',
			signal: new AbortController().signal,
		});
		end();
		controller.abort();
		receive(permission(2, { sessionId, _meta: { promptId: 'prompt-2' } }));
		await vi.advanceTimersByTimeAsync(0);
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([cancelled(1)]);
		expect(pending[1].signal.aborted).toBe(false);
		pending[1].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([cancelled(1), selected(2, 'yes')]);
		expect(settled.mock.calls.map(([s]) => [s.requestId, s.sessionId, s.turnId])).toEqual([
			[1, 'native-1', 'host-1'],
			[2, sessionId, 'host-2'],
		]);
	});

	it('correlates concurrent numeric and string IDs when authority answers out of order', async () => {
		receive(permission(1));
		receive(permission('1', { toolCall: { toolCallId: 'second-tool' } }));
		await vi.advanceTimersByTimeAsync(0);
		expect(decide.mock.calls.map(([, binding]) => binding.requestId)).toEqual([
			'["process-1","host-1",1]',
			'["process-1","host-1","1"]',
		]);
		pending[1].resolve({ decision: 'deny', reason: 'Denied second tool' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([selected('1', 'no')]);
		expect(pending[0].signal.aborted).toBe(false);
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([selected('1', 'no'), selected(1, 'yes')]);
		expect(settled).toHaveBeenCalledTimes(2);
	});

	it.each(['pending', 'settled', 'next-turn'] as const)('rejects %s replay', async (state) => {
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		if (state !== 'pending') {
			pending[0].resolve({ decision: 'allow' });
			await vi.advanceTimersByTimeAsync(0);
		}
		if (state === 'next-turn') {
			end();
			adapter.beginTurn({ ...turn, turnId: 'host-2' });
		}
		receive(permission());
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual(state === 'pending' ? [] : [selected(1, 'yes')]);
		expect(settled).toHaveBeenCalledTimes(1);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(fault).toHaveBeenCalledExactlyOnceWith(new GrokAcpTransportError('malformed-frame'));
		expect(client.isClosed).toBe(true);
	});

	it('keeps independent fixed deadlines despite later requests', async () => {
		receive(permission(1));
		await vi.advanceTimersByTimeAsync(50);
		receive(permission(2));
		await vi.advanceTimersByTimeAsync(50);
		expect(sent()).toEqual([cancelled(1)]);
		expect(pending[1].signal.aborted).toBe(false);
		pending[0].reject(new Error('synthetic-private-error'));
		await vi.advanceTimersByTimeAsync(50);
		expect(sent()).toEqual([cancelled(1), cancelled(2)]);
		expect(settled).toHaveBeenCalledTimes(2);
		expect(fault).not.toHaveBeenCalled();
	});

	it.each(['false', 'throw'] as const)('handles writer %s as disconnect', async (mode) => {
		const respond = vi.fn<(answer: AcpAnswer) => boolean>(() => {
			if (mode === 'throw') throw new Error('synthetic-private-error');
			return false;
		});
		adapter.requestHandlers.get('session/request_permission')!(permission(), respond);
		await vi.advanceTimersByTimeAsync(0);
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(respond).toHaveBeenCalledTimes(1);
		expect(settled.mock.calls[0][0]).toMatchObject({
			reason: 'disconnected',
			responseWritten: false,
		});
		expect(fault).toHaveBeenCalledExactlyOnceWith(new GrokAcpTransportError('write'));
		nonSuccess(0, 'failed');
	});

	it.each(['throw', 'reject', 'observer'] as const)('drains %s failures once', async (mode) => {
		if (mode === 'observer')
			settled.mockImplementation(() => {
				throw new Error('synthetic-private-error');
			});
		else
			decide.mockImplementationOnce(() => {
				if (mode === 'throw') throw new Error('synthetic-private-error');
				return Promise.reject(new Error('synthetic-private-error'));
			});
		receive(permission(1));
		receive(permission(2));
		await vi.advanceTimersByTimeAsync(0);
		if (mode === 'observer') {
			pending[0].resolve({ decision: 'deny', reason: 'Denied' });
			await vi.advanceTimersByTimeAsync(0);
		}
		for (const request of pending) request.resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([mode === 'observer' ? selected(1, 'no') : cancelled(1)]);
		expect(settled.mock.calls.map(([s]) => s.reason)).toEqual([
			mode === 'observer' ? 'denied' : 'unknown',
			'disconnected',
		]);
		expect(fault).toHaveBeenCalledExactlyOnceWith(new GrokAcpTransportError('handler-failed'));
		expect(JSON.stringify(fault.mock.calls) + String(fault.mock.calls[0][0])).not.toContain(
			'synthetic-private-error'
		);
		nonSuccess(0, 'refused');
		nonSuccess(1, 'failed');
	});

	it('rechecks ownership after authority abort listeners synchronously end the turn', async () => {
		receive(permission());
		await vi.advanceTimersByTimeAsync(0);
		pending[0].signal.addEventListener('abort', end, { once: true });
		pending[0].resolve({ decision: 'allow' });
		await vi.advanceTimersByTimeAsync(0);
		expect(sent()).toEqual([cancelled(1)]);
		expect(settled.mock.calls[0][0].reason).toBe('cancelled');
		nonSuccess(0, 'cancelled');
	});

	it.each(['pending', 'tombstones'] as const)('bounds %s without ID eviction', async (limit) => {
		if (limit === 'tombstones') end();
		const count = limit === 'pending' ? 64 : 4096;
		for (let i = 0; i < count; i++) receive(permission(i));
		await vi.advanceTimersByTimeAsync(0);
		expect(client.isClosed).toBe(false);
		receive(permission(count));
		expect(client.isClosed).toBe(true);
		expect(settled).toHaveBeenCalledTimes(count);
		expect(sent()).toHaveLength(limit === 'pending' ? 0 : count);
		expect(fault).toHaveBeenCalledExactlyOnceWith(new GrokAcpTransportError('malformed-frame'));
	});
});
