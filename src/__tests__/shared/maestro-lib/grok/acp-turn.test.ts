// @vitest-environment node
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import * as childProcess from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as processTree from '../../../../shared/maestro-lib/control/process-tree';
import * as platform from '../../../../shared/platformDetection';
import {
	startGrokAcpTurn,
	type GrokAcpTurnOptions,
	type GrokAcpTurnHandlers,
	type GrokAcpRunningTurn,
	type DispatchAdmission,
} from '../../../../shared/maestro-lib';
import type { AcpCall, AcpMessage } from '../../../../shared/maestro-lib/grok/acp-protocol';
import type { ManagedEffectAuthority } from '../../../../shared/maestro-lib/managed/effects';
import { tableEffects } from '../../../helpers/managedSpawnPort';

// Reuse the runner suite's mutable OS facades. All protocol/lifecycle layers stay real.
vi.mock('child_process', async (original) => ({
	...(await original<typeof import('child_process')>()),
}));
vi.mock('../../../../shared/maestro-lib/control/process-tree', async (original) => ({
	...(await original<typeof import('../../../../shared/maestro-lib/control/process-tree')>()),
}));
vi.mock('../../../../shared/platformDetection', async (original) => ({
	...(await original<typeof import('../../../../shared/platformDetection')>()),
}));
vi.mock('electron', () => {
	throw new Error('The public ACP port must load without Electron');
});

// Synthetic wire-1/schema-0.11.4 traffic, not native qualification or managed containment.
describe('public Grok ACP turn composition', () => {
	const fixtures: ReturnType<typeof fixture>[] = [];
	function fixture(
		overrides: Partial<GrokAcpTurnOptions> = {},
		handlers: GrokAcpTurnHandlers = {}
	) {
		const child = Object.assign(new EventEmitter(), {
			pid: 4242 + fixtures.length,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(() => true),
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
		});
		const messages: AcpMessage[] = [];
		child.stdin.on('data', (bytes) => messages.push(JSON.parse(bytes.toString())));
		const onEvent = vi.fn<NonNullable<GrokAcpTurnHandlers['onEvent']>>();
		const onRequestSettlement = vi.fn<NonNullable<GrokAcpTurnHandlers['onRequestSettlement']>>();
		const decide = vi.fn<ManagedEffectAuthority['decide']>(() => ({ decision: 'allow' }));
		const released = vi.fn();
		const bound = vi.fn();
		const order: string[] = [];
		let revoked: (reason: string) => void = () => {};
		const unsubscribe = vi.fn();
		const admit = vi.fn<DispatchAdmission['admit']>(() => {
			order.push('admit');
			return { ok: true };
		});
		const options: GrokAcpTurnOptions = {
			cwd: path.resolve('synthetic-project'),
			account: 'fixture-account',
			host: 'fixture-host',
			turnId: `host-${fixtures.length}`,
			processGeneration: `process-${fixtures.length}`,
			prompt: 'Synthetic prompt',
			idleTimeoutMs: 100,
			maxTurnMs: 300,
			cancelGraceMs: 40,
			stopGraceMs: 20,
			requestTimeoutMs: 80,
			permission: {
				authority: tableEffects(decide),
				binding: { actor: { kind: 'human', id: 'fixture-actor' }, leaseId: 'lease' },
			},
			admission: {
				attribution: { provider: 'grok' },
				gate: {
					admit,
					bound,
					released,
					onRevoked: (listener) => {
						revoked = listener;
						return unsubscribe;
					},
				},
			},
			...overrides,
		};
		const spec = { command: 'synthetic-grok', args: ['agent', 'stdio'], cwd: options.cwd, env: {} };
		let run: GrokAcpRunningTurn | undefined;
		const calls = (method: string) =>
			messages.filter((m): m is AcpCall => 'method' in m && m.method === method);
		const receive = (message: object) =>
			child.stdout.write(Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'));
		const reply = (call: AcpCall, result: unknown) => receive({ id: call.id, result });
		const next = async (method: string, count = 1) => {
			await vi.advanceTimersByTimeAsync(0);
			expect(calls(method)).toHaveLength(count);
			return calls(method)[count - 1];
		};
		const update = (value: object, meta?: object) =>
			receive({
				method: 'session/update',
				params: { sessionId: 'native-1', update: value, _meta: meta },
			});
		const h = {
			child,
			options,
			spec,
			messages,
			calls,
			receive,
			reply,
			next,
			update,
			onEvent,
			onRequestSettlement,
			decide,
			admit,
			bound,
			released,
			unsubscribe,
			order,
			revoke: () => revoked('fixture revocation'),
			get run() {
				return run!;
			},
			start() {
				vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
					order.push('spawn');
					return child as unknown as childProcess.ChildProcess;
				});
				run = startGrokAcpTurn(spec, options, { onEvent, onRequestSettlement, ...handlers });
				return run;
			},
			async allocation(meta?: object) {
				reply(await next('initialize'), {
					protocolVersion: 1,
					agentCapabilities: { loadSession: true },
					_meta: meta,
				});
				return next(options.resumeSessionId ? 'session/load' : 'session/new');
			},
			async ready(meta?: object) {
				reply(await h.allocation(meta), options.resumeSessionId ? {} : { sessionId: 'native-1' });
				return next('session/prompt');
			},
			close() {
				Object.assign(child, { signalCode: 'SIGTERM' });
				child.emit('exit', null, 'SIGTERM');
				child.emit('close', null, 'SIGTERM');
			},
			async finish() {
				await vi.advanceTimersByTimeAsync(0);
				h.close();
				return run!.completed;
			},
			permission(id = 'permission', meta?: object) {
				receive({
					id,
					method: 'session/request_permission',
					params: {
						sessionId: 'native-1',
						_meta: meta,
						toolCall: { toolCallId: id, title: 'Read', rawInput: { path: 'README.md' } },
						options: [
							{ optionId: 'yes', name: 'Allow', kind: 'allow_once' },
							{ optionId: 'no', name: 'Deny', kind: 'reject_once' },
						],
					},
				});
			},
		};
		fixtures.push(h);
		return h;
	}
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(childProcess, 'spawn').mockImplementation(() => {
			throw new Error('Unexpected real process');
		});
		vi.spyOn(platform, 'isWindows').mockReturnValue(false);
		vi.spyOn(processTree, 'snapshotProcessTree').mockReturnValue({ owned: false, descendants: [] });
		vi.spyOn(processTree, 'killProcessTreeNow').mockImplementation(() => {});
		vi.spyOn(process, 'kill').mockReturnValue(true);
	});
	afterEach(async () => {
		try {
			for (const h of fixtures.splice(0)) {
				h.run?.cancel();
				h.close();
				await h.run?.completed;
				h.child.stdin.destroy();
				h.child.stdout.destroy();
				h.child.stderr.destroy();
			}
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.restoreAllMocks();
		}
	});

	it('admits before spawn, streams raw Unicode, and preserves success through owned shutdown', async () => {
		const h = fixture();
		h.start();
		expect(h.order).toEqual(['admit', 'spawn']);
		expect(h.bound).toHaveBeenCalledExactlyOnceWith(h.child.pid);
		expect(childProcess.spawn).toHaveBeenCalledWith(h.spec.command, h.spec.args, {
			cwd: h.spec.cwd,
			env: {},
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const prompt = await h.ready();
		expect(prompt.params).toEqual({
			sessionId: 'native-1',
			prompt: [{ type: 'text', text: h.options.prompt }],
		});
		const frame = Buffer.from(
			JSON.stringify({
				jsonrpc: '2.0',
				method: 'session/update',
				params: {
					sessionId: 'native-1',
					update: {
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'Answer 🦊' },
					},
				},
			}) + '\n'
		);
		const split = frame.indexOf(Buffer.from('🦊')) + 2;
		h.child.stdout.write(frame.subarray(0, split));
		h.child.stdout.write(frame.subarray(split));
		h.child.stderr.write('private diagnostic');
		expect(h.run.answerSoFar()).toBe('Answer 🦊');
		h.reply(prompt, { stopReason: 'end_turn' });
		await vi.advanceTimersByTimeAsync(0);
		expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
		const settled = vi.fn();
		void h.run.completed.then(settled);
		h.child.emit('exit', null, 'SIGTERM');
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).not.toHaveBeenCalled();
		expect(h.released).not.toHaveBeenCalled();
		h.child.emit('close', null, 'SIGTERM');
		expect(await h.run.completed).toMatchObject({
			outcome: 'completed',
			terminal: { status: 'success' },
			answerText: 'Answer 🦊',
			sessionId: 'native-1',
			exit: { signal: 'SIGTERM', stdoutText: '', stderrText: '' },
		});
		expect(settled).toHaveBeenCalledTimes(1);
		expect(h.released).toHaveBeenCalledTimes(1);
		expect(h.unsubscribe).toHaveBeenCalledTimes(1);
		expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
		expect(h.onEvent.mock.calls.every(([, line]) => line === '')).toBe(true);
	});

	it('resumes repeated public calls without replaying load history or an old final', async () => {
		const first = fixture();
		first.start();
		const old = await first.ready();
		first.reply(old, { stopReason: 'end_turn' });
		const result = await first.finish();
		const h = fixture({ resumeSessionId: result.sessionId });
		h.start();
		const load = await h.allocation();
		expect(load.params).toMatchObject({ sessionId: result.sessionId, cwd: h.options.cwd });
		h.update({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'old history' },
		});
		h.reply(load, {});
		const prompt = await h.next('session/prompt');
		first.reply(old, { stopReason: 'end_turn' });
		expect(h.run.answerSoFar()).toBeUndefined();
		h.update({
			sessionUpdate: 'agent_message_chunk',
			content: { type: 'text', text: 'New answer' },
		});
		h.reply(prompt, { stopReason: 'end_turn' });
		h.reply(prompt, { stopReason: 'end_turn' });
		expect(await h.finish()).toMatchObject({
			answerText: 'New answer',
			sessionId: 'native-1',
			outcome: 'completed',
		});
		expect(h.calls('session/new')).toHaveLength(0);
		expect(h.calls('session/prompt')).toHaveLength(1);
		expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
	});

	it('refuses admission without creating a process', () => {
		const h = fixture();
		h.admit.mockReturnValue({
			ok: false,
			state: 'denied',
			code: 'policy-denied',
			message: 'Fixture denial',
		});
		expect(() => h.start()).toThrow('Fixture denial');
		expect(childProcess.spawn).not.toHaveBeenCalled();
		expect(h.bound).not.toHaveBeenCalled();
	});

	it.each(['allow', 'deny'] as const)(
		'routes tools, plans and %s permission through transmitted native identity',
		async (decision) => {
			const h = fixture({ extensions: { agentVersion: 'fixture-version', promptId: true } });
			h.decide.mockReturnValue(
				decision === 'allow' ? { decision } : { decision, reason: 'Fixture denial' }
			);
			h.start();
			const prompt = await h.ready({ grokShell: true, agentVersion: 'fixture-version' });
			const meta = (prompt.params as Record<string, unknown>)._meta as { promptId: string };
			expect(meta.promptId).toBeTypeOf('string');
			expect(meta.promptId).not.toBe(h.options.turnId);
			h.update(
				{
					sessionUpdate: 'plan',
					entries: [{ content: 'Inspect', priority: 'high', status: 'in_progress' }],
				},
				meta
			);
			h.update(
				{
					sessionUpdate: 'tool_call',
					toolCallId: 'tool',
					title: 'Read',
					kind: 'read',
					status: 'in_progress',
				},
				meta
			);
			expect(h.decide).not.toHaveBeenCalled();
			h.permission('tool', meta);
			await vi.advanceTimersByTimeAsync(0);
			expect(h.decide.mock.calls[0][1]).toMatchObject({
				threadId: 'native-1',
				turnId: meta.promptId,
				provider: 'grok',
			});
			expect(h.messages.filter((m) => m.id === 'tool')).toEqual([
				{
					jsonrpc: '2.0',
					id: 'tool',
					result: {
						outcome: { outcome: 'selected', optionId: decision === 'allow' ? 'yes' : 'no' },
					},
				},
			]);
			h.update(
				{ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' },
				meta
			);
			h.reply(prompt, { stopReason: decision === 'allow' ? 'end_turn' : 'cancelled' });
			expect((await h.finish()).terminal.status).toBe(decision === 'allow' ? 'success' : 'refused');
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
			expect(h.onEvent.mock.calls.map(([e]) => e)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ toolCallId: 'tool', type: 'tool_use' }),
					expect.objectContaining({
						toolName: 'update_plan',
						toolState: expect.objectContaining({
							planUpdate: expect.objectContaining({
								promptId: meta.promptId,
								turnId: h.options.turnId,
							}),
						}),
					}),
				])
			);
		}
	);

	it.each(['initialize', 'allocation'] as const)(
		'cancels during %s without dispatch or replay',
		async (stage) => {
			const h = fixture();
			h.start();
			const pending = stage === 'initialize' ? await h.next('initialize') : await h.allocation();
			h.run.cancel();
			h.reply(pending, { sessionId: 'native-1', protocolVersion: 1 });
			expect((await h.finish()).terminal).toMatchObject({
				status: 'cancelled',
				dispatchState: 'not-dispatched',
			});
			expect(h.calls('session/prompt')).toHaveLength(0);
		}
	);

	it.each(['cancel', 'disconnect', 'revoke', 'terminate'] as const)(
		'settles every pending permission on %s, retaining partial output',
		async (cause) => {
			const h = fixture();
			const pending: Array<{
				signal: AbortSignal;
				resolve: (value: { decision: 'allow' }) => void;
			}> = [];
			h.decide.mockImplementation(
				(_effect, _binding, signal) => new Promise((resolve) => pending.push({ signal, resolve }))
			);
			h.start();
			const prompt = await h.ready();
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Partial' },
			});
			h.permission('a');
			h.permission('b');
			await vi.advanceTimersByTimeAsync(0);
			expect(pending).toHaveLength(2);
			if (cause === 'cancel') h.run.cancel();
			else if (cause === 'disconnect') h.child.stdout.emit('end');
			else if (cause === 'revoke') h.revoke();
			else h.run.handle.terminate();
			if (cause === 'cancel') {
				expect(h.calls('session/cancel')).toHaveLength(1);
				expect(h.calls('session/cancel')[0].params).toEqual({ sessionId: 'native-1' });
			}
			expect(pending.every((p) => p.signal.aborted)).toBe(true);
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(2);
			const replies = h.messages.filter((m) => m.id === 'a' || m.id === 'b');
			for (const p of pending) p.resolve({ decision: 'allow' });
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result.answerText).toBe('Partial');
			expect(result.terminal.status).toBe(
				cause === 'revoke' ? 'refused' : cause === 'disconnect' ? 'failed' : 'cancelled'
			);
			expect(h.messages.filter((m) => m.id === 'a' || m.id === 'b')).toEqual(replies);
			expect(h.onRequestSettlement).toHaveBeenCalledTimes(2);
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.released).toHaveBeenCalledTimes(1);
		}
	);

	it.each(['process', 'malformed-bytes', 'idle'] as const)(
		'does not turn %s loss into a successful answer',
		async (cause) => {
			const h = fixture();
			h.start();
			const prompt = await h.ready();
			h.update({
				sessionUpdate: 'agent_message_chunk',
				content: { type: 'text', text: 'Partial' },
			});
			if (cause === 'process') h.child.emit('exit', 1, null);
			else if (cause === 'malformed-bytes') h.child.stdout.write(Buffer.from([0xff, 0x0a]));
			else await vi.advanceTimersByTimeAsync(100);
			h.reply(prompt, { stopReason: 'end_turn' });
			const result = await h.finish();
			expect(result).toMatchObject({
				answerText: 'Partial',
				terminal: { status: cause === 'idle' ? 'timeout' : 'failed', dispatchState: 'unknown' },
			});
			expect(h.calls('session/prompt')).toHaveLength(1);
			expect(h.onEvent.mock.calls.filter(([e]) => e.terminal)).toHaveLength(1);
		}
	);

	it('settles unavailable questions without granting effects or fabricating an answer', async () => {
		const onQuestion = vi.fn<NonNullable<GrokAcpTurnHandlers['onQuestion']>>();
		const h = fixture({}, { onQuestion });
		h.start();
		const prompt = await h.ready();
		h.receive({
			id: 'question',
			method: '_x.ai/ask_user_question',
			params: { sessionId: 'native-1', question: 'Choose?' },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(h.run.questionSupport).toEqual({ status: 'unsupported', reason: 'not-advertised' });
		const event = onQuestion.mock.calls[0][0];
		expect(event.state).toBe('settled');
		if (event.state !== 'settled') throw new Error('Question unexpectedly pending');
		expect(h.run.answerQuestion(event.settlement.identity, 'yes')).toBe('unavailable');
		expect(h.messages.filter((m) => m.id === 'question')).toEqual([
			{ jsonrpc: '2.0', id: 'question', result: { outcome: 'cancelled' } },
		]);
		expect(h.decide).not.toHaveBeenCalled();
		h.reply(prompt, { stopReason: 'end_turn' });
		expect((await h.finish()).terminal.status).toBe('cancelled');
		expect(onQuestion).toHaveBeenCalledTimes(1);
		expect(h.onRequestSettlement).toHaveBeenCalledTimes(1);
	});
});
