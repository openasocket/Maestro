import { describe, expect, it } from 'vitest';
import {
	GrokAcpEventAdapter,
	type GrokAcpEventOptions,
} from '../../../../shared/maestro-lib/grok/acp-events';
import { AcpFrameDecoder, type AcpCall } from '../../../../shared/maestro-lib/grok/acp-protocol';
import type {
	ParsedEvent,
	ParsedPlanState,
} from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import { GrokOutputParser } from '../../../../shared/maestro-lib/parsers/grok-output-parser';
import { TurnCapture } from '../../../../shared/maestro-lib/run/turn-capture';
import { resolveTurnOutcome } from '../../../../shared/maestro-lib/streaming/turn-outcome';
import { createTurnEventMapper } from '../../../../shared/maestro-lib/turns/turn-events';

// Synthetic fixtures follow pinned ACP schema 0.11.4, not native streaming-json.
const identity = { sessionId: 'native-session', turnId: 'capture', promptId: 'prompt' };
const context = { replay: false, turnId: identity.turnId };
const responseUsage = {
	input_tokens: 100,
	output_tokens: 10,
	cache_read_input_tokens: 20,
	cache_creation_input_tokens: 10,
	reasoning_tokens: 3,
};
const promptUsage = {
	inputTokens: 130,
	outputTokens: 10,
	cachedReadTokens: 20,
	cacheCreationTokens: 10,
	reasoningTokens: 3,
};
function notification(update: Record<string, unknown>, method = '_x.ai/session/update'): AcpCall {
	return { jsonrpc: '2.0', method, params: { sessionId: identity.sessionId, update } };
}
function fixture(options: GrokAcpEventOptions = identity) {
	const adapter = new GrokAcpEventAdapter(options);
	// Only the existing normalized-field extractors are used; no native/Claude decoding.
	const parser = new GrokOutputParser();
	const capture = new TurnCapture('grok', parser, { classifyInBandErrors: false });
	const mapper = createTurnEventMapper({ agentId: 'grok', now: () => 1 });
	const events: ParsedEvent[] = [];
	const output: ReturnType<typeof mapper.map> = [];
	const accept = (batch: ParsedEvent[]) => {
		for (const event of batch) {
			events.push(event);
			capture.handleEvent(event);
			output.push(...mapper.map(event));
		}
		return batch;
	};
	return {
		adapter,
		capture,
		events,
		output,
		accept,
		outcome: () =>
			resolveTurnOutcome(
				{
					exitCode: 0,
					signal: null,
					interrupted: false,
					stderrText: '',
					stdoutText: '',
					explicitError: capture.inBandError,
					capturedAnswerText: capture.answerText,
					resultMessageSeen: capture.resultMessageSeen,
					terminal: adapter.terminal,
				},
				parser,
				{ providerId: 'grok', sessionId: options.sessionId }
			),
		send: (update: Record<string, unknown>, method?: string) =>
			accept(adapter.notification(notification(update, method), context)),
		wire: (line: string) =>
			new AcpFrameDecoder().push(Buffer.from(`${line}\n`), (message) => {
				accept(
					'method' in message
						? adapter.notification(message, context)
						: adapter.settle(message.result)
				);
				return true;
			}),
	};
}

describe('Grok ACP plan snapshots', () => {
	function planMessage(entries: unknown, meta?: Record<string, unknown>): AcpCall {
		const message = notification({ sessionUpdate: 'plan', entries }, 'session/update');
		return { ...message, params: { ...message.params, _meta: meta } };
	}

	it('delivers an ordered initial plan through the real mapper without inventing entry IDs', () => {
		const options = {
			...identity,
			scopeId: 'account@host',
			processGeneration: 'gen',
			requestId: 0,
		};
		const f = fixture(options);
		const entries = [
			{ content: 'Inspect', status: 'in_progress', priority: 'high' },
			{ content: 'Inspect', status: 'pending', priority: 'low' },
		];
		f.wire(JSON.stringify(planMessage(entries, { promptId: 'prompt', eventId: 'initial' })));
		const plans = f.output.filter((e) => e.kind === 'tool');
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			tool: {
				id: expect.stringMatching(/^grok-plan:/),
				name: 'update_plan',
				status: 'completed', // Publishing a snapshot does not complete its items.
				detail: {
					input: {
						plan: [
							{ step: 'Inspect', status: 'in_progress', priority: 'high' },
							{ step: 'Inspect', status: 'pending', priority: 'low' },
						],
					},
					planUpdate: {
						reporting: 'snapshot',
						revision: 1,
						providerSessionId: options.sessionId,
						turnId: options.turnId,
						scopeId: options.scopeId,
						processGeneration: options.processGeneration,
						requestId: 0,
						promptId: 'prompt',
						eventId: 'initial',
					},
				},
			},
		});
		expect(plans[0].tool.detail).toEqual(f.events[0].toolState);
		const state = plans[0].tool.detail as ParsedPlanState;
		expect(state.input.plan.map((entry) => entry.id)).toEqual([undefined, undefined]);
		expect(f.capture.answerText).toBeUndefined();
		expect(f.capture.resultMessageSeen).toBe(false);
	});

	it.each([
		['pending', undefined, 'pending'],
		['in_progress', undefined, 'in_progress'],
		['completed', undefined, 'completed'],
		['completed', true, 'cancelled'],
		['completed', 'true', 'completed'],
		['failed', undefined, 'unsupported'],
		['skipped', undefined, 'unsupported'],
		['future_status', undefined, 'unsupported'],
		[undefined, undefined, 'unsupported'],
		[null, undefined, 'unsupported'],
	] as const)(
		'preserves status %s with cancellation marker %s as %s',
		(status, cancelled, expected) => {
			const f = fixture();
			const providerMeta = { cancelled, extension: { reason: 'reported' } };
			f.accept(
				f.adapter.notification(
					planMessage([
						{
							id: 'native-item',
							content: 'Work',
							status,
							priority: 'future_priority',
							_meta: providerMeta,
						},
					]),
					context
				)
			);
			expect(f.output.filter((e) => e.kind === 'tool')).toMatchObject([
				{
					tool: {
						detail: {
							input: {
								plan: [
									{
										id: 'native-item',
										step: 'Work',
										status: expected,
										providerStatus: status,
										priority: 'future_priority',
										providerMeta,
									},
								],
							},
						},
					},
				},
			]);
		}
	);

	it('replaces, reorders and clears plans while retaining supplied identities and old snapshots', () => {
		const f = fixture();
		const snapshots = [
			[
				{ id: 'a', content: 'A', status: 'pending' },
				{ id: 'b', content: 'B', status: 'pending' },
			],
			[
				{ id: 'b', content: 'B revised', status: 'in_progress' },
				{ id: 'a', content: 'A', status: 'completed' },
			],
			[{ id: 'b', content: 'B revised', status: 'completed' }],
			[],
		];
		for (const entries of snapshots)
			f.accept(f.adapter.notification(planMessage(entries), context));
		const plans = f.output.filter((e) => e.kind === 'tool');
		expect(plans).toHaveLength(4);
		expect(new Set(plans.map((e) => e.tool.id)).size).toBe(1);
		const states = plans.map((e) => e.tool.detail as ParsedPlanState);
		expect(states.map((s) => s.planUpdate.revision)).toEqual([1, 2, 3, 4]);
		expect(states.map((s) => s.planUpdate.reporting)).toEqual(Array(4).fill('snapshot'));
		expect(
			states.map((s) => s.input.plan.map(({ id, step, status }) => ({ id, step, status })))
		).toEqual([
			[
				{ id: 'a', step: 'A', status: 'pending' },
				{ id: 'b', step: 'B', status: 'pending' },
			],
			[
				{ id: 'b', step: 'B revised', status: 'in_progress' },
				{ id: 'a', step: 'A', status: 'completed' },
			],
			[{ id: 'b', step: 'B revised', status: 'completed' }],
			[],
		]);
	});

	it('deduplicates event IDs across intervening snapshots and canonical metadata order', () => {
		const f = fixture();
		const a = [{ content: 'A', status: 'pending', _meta: { one: 1, two: 2 } }];
		const b = [{ content: 'B', status: 'in_progress' }];
		f.accept(f.adapter.notification(planMessage(a, { eventId: 'a' }), context));
		expect(
			f.accept(
				f.adapter.notification(
					planMessage([{ content: 'A', status: 'pending', _meta: { two: 2, one: 1 } }], {
						eventId: 'equal-a',
					}),
					context
				)
			)
		).toEqual([]);
		f.accept(f.adapter.notification(planMessage(b, { eventId: 'b' }), context));
		for (const eventId of ['a', 'equal-a']) {
			expect(f.accept(f.adapter.notification(planMessage(a, { eventId }), context))).toEqual([]);
		}
		const plans = f.output.filter((e) => e.kind === 'tool');
		expect(plans).toHaveLength(2);
		expect(plans[1].tool.detail).toMatchObject({
			input: { plan: [{ step: 'B', status: 'in_progress' }] },
			planUpdate: { revision: 2, eventId: 'b' },
		});
	});

	it('suppresses consecutive idless duplicates but permits a later reported reversal', () => {
		const f = fixture({ ...identity, promptId: undefined });
		const a = [{ content: 'A', status: 'pending' }];
		const b = [{ content: 'A', status: 'in_progress' }];
		for (const entries of [a, a, b, a])
			f.accept(f.adapter.notification(planMessage(entries), context));
		const states = f.output
			.filter((e) => e.kind === 'tool')
			.map((e) => e.tool.detail as ParsedPlanState);
		expect(states.map((s) => s.planUpdate.revision)).toEqual([1, 2, 3]);
		expect(states.map((s) => s.input.plan[0].status)).toEqual([
			'pending',
			'in_progress',
			'pending',
		]);
		expect(
			states.every((s) => s.planUpdate.promptId === undefined && s.planUpdate.eventId === undefined)
		).toBe(true);
	});

	it('keeps interleaved tab captures isolated and rejects a late plan routed with its original turn', () => {
		const a = fixture();
		const other = { ...identity, turnId: 'other-capture', promptId: 'other-prompt' };
		const b = fixture(other);
		const otherContext = { replay: false, turnId: other.turnId };
		const messageA = planMessage([{ content: 'Tab A', status: 'pending' }], {
			promptId: 'prompt',
			eventId: 'same-id',
		});
		const messageB = planMessage([{ content: 'Tab B', status: 'in_progress' }], {
			promptId: other.promptId,
			eventId: 'same-id',
		});
		a.accept(a.adapter.notification(messageA, context));
		b.accept(b.adapter.notification(messageB, otherContext));
		expect(b.accept(b.adapter.notification(messageA, context))).toEqual([]);
		expect(a.accept(a.adapter.notification(messageB, otherContext))).toEqual([]);
		// Even an incorrectly rebound context cannot admit a foreign confirmed prompt.
		b.accept(b.adapter.notification(messageA, otherContext));
		const updateA = planMessage([{ content: 'Tab A', status: 'completed' }], {
			promptId: 'prompt',
			eventId: 'a2',
		});
		a.accept(a.adapter.notification(updateA, context));
		a.accept(a.adapter.settle({ stopReason: 'end_turn' }));
		expect(a.accept(a.adapter.notification(messageA, context))).toEqual([]);
		expect(b.accept(b.adapter.notification(updateA, context))).toEqual([]);
		const plansA = a.output.filter((e) => e.kind === 'tool');
		const plansB = b.output.filter((e) => e.kind === 'tool');
		expect(plansA).toHaveLength(2);
		expect(plansB).toHaveLength(1);
		expect(plansA[0].tool.id).not.toBe(plansB[0].tool.id);
		expect(plansA[1].tool.detail).toMatchObject({
			planUpdate: { turnId: identity.turnId, revision: 2 },
		});
		expect(plansB[0].tool.detail).toMatchObject({
			input: { plan: [{ step: 'Tab B', status: 'in_progress' }] },
			planUpdate: { turnId: other.turnId, promptId: other.promptId, revision: 1 },
		});
	});

	it.each(['sessionId', 'turnId', 'scopeId', 'processGeneration'] as const)(
		'scopes the display identity independently by %s',
		(key) => {
			const owner = { ...identity, scopeId: 'account@host', processGeneration: 'generation' };
			const ids = [owner, { ...owner, [key]: 'different' }].map((options) => {
				const f = fixture(options);
				const message = planMessage([{ content: 'Same text', status: 'pending' }]);
				message.params = { ...message.params, sessionId: options.sessionId };
				f.accept(f.adapter.notification(message, { replay: false, turnId: options.turnId }));
				const plans = f.output.filter((e) => e.kind === 'tool');
				expect(plans).toHaveLength(1);
				expect(plans[0].tool.detail).toMatchObject({
					planUpdate: {
						providerSessionId: options.sessionId,
						turnId: options.turnId,
						scopeId: options.scopeId,
						processGeneration: options.processGeneration,
					},
				});
				return plans[0].tool.id;
			});
			expect(ids[0]).not.toBe(ids[1]);
		}
	);

	it.each([
		'foreign-prompt',
		'unbound-prompt',
		'wire-replay',
		'context-replay',
		'request',
		'missing-session',
		'foreign-session',
		'foreign-turn',
	])('prevents %s plans from replacing the owned snapshot', (kind) => {
		const f = fixture({ ...identity, promptId: kind === 'unbound-prompt' ? undefined : 'prompt' });
		const entries = [{ content: 'Owned', status: 'pending' }];
		f.accept(f.adapter.notification(planMessage(entries), context));
		const message = planMessage([{ content: 'Foreign', status: 'completed' }], {
			promptId: kind === 'foreign-prompt' ? 'foreign' : 'prompt',
			eventId: 'reusable',
			isReplay: kind === 'wire-replay',
		});
		if (kind === 'request') message.id = 0;
		if (kind === 'missing-session') message.params = { ...message.params, sessionId: undefined };
		if (kind === 'foreign-session') message.params = { ...message.params, sessionId: 'other' };
		f.accept(
			f.adapter.notification(message, {
				replay: kind === 'context-replay',
				turnId: kind === 'foreign-turn' ? 'other' : context.turnId,
			})
		);
		expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
		f.accept(
			f.adapter.notification(
				planMessage([{ content: 'Owned', status: 'in_progress' }], { eventId: 'reusable' }),
				context
			)
		);
		const plans = f.output.filter((e) => e.kind === 'tool');
		expect(plans).toHaveLength(2);
		expect(plans[1].tool.detail).toMatchObject({
			input: { plan: [{ step: 'Owned', status: 'in_progress' }] },
			planUpdate: { revision: 2 },
		});
	});

	it.each([
		['success', undefined],
		['cancelled', { status: 'cancelled', origin: 'user' }],
		['timeout', { status: 'timeout', kind: 'idle' }],
		['disconnect', { status: 'failed', kind: 'transport' }],
	] as const)(
		'never completes plan items on final prose, tool success or %s settlement',
		(_kind, failure) => {
			const f = fixture();
			f.accept(
				f.adapter.notification(
					planMessage([
						{ content: 'Still pending', status: 'pending' },
						{ content: 'Still working', status: 'in_progress' },
					]),
					context
				)
			);
			const before = structuredClone(f.output.filter((e) => e.kind === 'tool'));
			f.send(
				{
					sessionUpdate: 'tool_call_update',
					toolCallId: 'shell',
					title: 'Bash',
					status: 'completed',
				},
				'session/update'
			);
			f.send(
				{
					sessionUpdate: 'agent_message_chunk',
					content: { type: 'text', text: 'Everything is complete.' },
				},
				'session/update'
			);
			f.send({
				sessionUpdate: 'turn_completed',
				prompt_id: 'prompt',
				agent_result: 'Everything is complete.',
				stop_reason: 'end_turn',
			});
			f.accept(f.adapter.settle({ stopReason: 'end_turn' }, failure));
			expect(f.adapter.terminal?.status).toBe(failure?.status ?? 'success');
			expect(
				f.accept(
					f.adapter.notification(planMessage([{ content: 'Late', status: 'completed' }]), context)
				)
			).toEqual([]);
			expect(f.adapter.settle({ stopReason: 'end_turn' })).toEqual([]);
			expect(f.output.filter((e) => e.kind === 'tool' && e.tool.name === 'update_plan')).toEqual(
				before
			);
			expect((before[0].tool.detail as ParsedPlanState).input.plan.map((p) => p.status)).toEqual([
				'pending',
				'in_progress',
			]);
			expect(f.capture.answerText).toBe('Everything is complete.');
			expect(f.output.filter((e) => e.kind === 'text')).toEqual([
				{ kind: 'text', text: 'Everything is complete.' },
			]);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	it.each([
		{ entries: undefined },
		{ entries: {} },
		{ entries: [null] },
		{ entries: [{ content: '  ' }] },
		{ entries: [{ content: 3 }] },
		{ entries: [{ content: 'Valid', status: 'pending' }, { status: 'completed' }] },
	])(
		'retains malformed snapshot %# without filtering entries or consuming the event ID',
		({ entries }) => {
			const f = fixture();
			const valid = [{ content: 'Owned', status: 'pending' }];
			f.accept(f.adapter.notification(planMessage(valid), context));
			const message = planMessage(entries, { eventId: 'retry' });
			expect(f.accept(f.adapter.notification(message, context))).toEqual([
				{ type: 'system', sessionId: identity.sessionId, raw: message },
			]);
			expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
			f.accept(f.adapter.notification(planMessage([], { eventId: 'retry' }), context));
			expect(f.output.filter((e) => e.kind === 'tool')[1].tool.detail).toMatchObject({
				input: { plan: [] },
				planUpdate: { revision: 2, eventId: 'retry' },
			});
		}
	);

	it('leaves unadvertised delta updates opaque without replacing a full plan', () => {
		const f = fixture();
		f.accept(
			f.adapter.notification(planMessage([{ content: 'Owned', status: 'pending' }]), context)
		);
		const delta = notification({ sessionUpdate: 'plan_delta', entries: [] }, 'session/update');
		expect(f.accept(f.adapter.notification(delta, context))).toEqual([
			{ type: 'system', sessionId: identity.sessionId, raw: delta },
		]);
		expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
	});

	it('bounds entry counts and event ID length without changing the prior plan or revision', () => {
		const f = fixture();
		const entries = Array.from({ length: 4096 }, (_, i) => ({
			content: `Step ${i}`,
			status: 'pending',
		}));
		f.accept(f.adapter.notification(planMessage(entries, { eventId: 'x'.repeat(1024) }), context));
		for (const message of [
			planMessage([...entries, { content: 'Overflow', status: 'completed' }], { eventId: 'retry' }),
			planMessage([], { eventId: 'x'.repeat(1025) }),
		]) {
			expect(f.accept(f.adapter.notification(message, context))[0]).toMatchObject({
				type: 'system',
				raw: message,
			});
		}
		expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
		f.accept(f.adapter.notification(planMessage([], { eventId: 'retry' }), context));
		const plans = f.output.filter((e) => e.kind === 'tool');
		expect((plans[0].tool.detail as ParsedPlanState).input.plan).toHaveLength(4096);
		expect(plans[1].tool.detail).toMatchObject({
			input: { plan: [] },
			planUpdate: { revision: 2 },
		});
	});

	it('retains the event-ID bound even for suppressed equal snapshots', () => {
		const f = fixture();
		for (let i = 0; i < 4096; i++) {
			f.accept(
				f.adapter.notification(
					planMessage([{ content: 'Owned', status: 'pending' }], { eventId: `event-${i}` }),
					context
				)
			);
		}
		const overflow = planMessage([], { eventId: 'overflow' });
		expect(f.accept(f.adapter.notification(overflow, context))[0]).toMatchObject({
			type: 'system',
			raw: overflow,
		});
		expect(
			f.accept(f.adapter.notification(planMessage([], { eventId: 'event-0' }), context))
		).toEqual([]);
		expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
		f.accept(f.adapter.notification(planMessage([]), context));
		expect(f.output.filter((e) => e.kind === 'tool')[1].tool.detail).toMatchObject({
			planUpdate: { revision: 2 },
		});
	});

	it.each(['overflowing-number', 'deep-metadata'])(
		'keeps %s opaque and permits a corrected retry',
		(kind) => {
			const f = fixture();
			f.accept(
				f.adapter.notification(planMessage([{ content: 'Owned', status: 'pending' }]), context)
			);
			let extension: unknown = Infinity; // JSON.parse of a legal 1e400 wire token.
			if (kind === 'deep-metadata') {
				extension = {};
				for (let i = 0; i < 20000; i++) extension = { nested: extension };
			}
			const message = planMessage(
				[{ content: 'Invalid', status: 'completed', _meta: { extension } }],
				{ eventId: 'retry' }
			);
			const rejected = f.accept(f.adapter.notification(message, context));
			expect(rejected).toHaveLength(1);
			expect(rejected[0].type).toBe('system');
			expect(rejected[0].raw).toBe(message);
			expect(f.output.filter((e) => e.kind === 'tool')).toHaveLength(1);
			f.accept(f.adapter.notification(planMessage([], { eventId: 'retry' }), context));
			expect(f.output.filter((e) => e.kind === 'tool')[1].tool.detail).toMatchObject({
				input: { plan: [] },
				planUpdate: { revision: 2, eventId: 'retry' },
			});
		}
	);
});

describe('Grok ACP event fixtures', () => {
	it('keeps interleaved thought/answer order and emits one answer and one settlement', () => {
		const f = fixture();
		for (const [sessionUpdate, text] of [
			['agent_thought_chunk', 'Check '],
			['agent_message_chunk', 'Hello '],
			['agent_thought_chunk', 'again'],
			['agent_message_chunk', 'world.'],
		])
			f.send({ sessionUpdate, content: { type: 'text', text } }, 'session/update');
		const durable = {
			sessionUpdate: 'turn_completed',
			prompt_id: 'prompt',
			agent_result: 'Hello world.',
			stop_reason: 'end_turn',
			usage: promptUsage,
		};
		f.send(durable);
		f.send(durable);
		expect(f.adapter.terminal).toBeUndefined();
		f.accept(f.adapter.settle({ stopReason: 'end_turn', _meta: { usage: promptUsage } }));
		expect(f.adapter.settle({ stopReason: 'cancelled' })).toEqual([]);
		expect(f.send(durable)).toEqual([]);
		expect(f.adapter.processUsage({ usage: promptUsage })).toEqual([]);
		expect(f.output.filter((e) => e.kind === 'text' || e.kind === 'thinking')).toEqual([
			{ kind: 'thinking', text: 'Check ' },
			{ kind: 'text', text: 'Hello ' },
			{ kind: 'thinking', text: 'again' },
			{ kind: 'text', text: 'world.' },
		]);
		expect(f.capture.answerText).toBe('Hello world.');
		expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		expect(f.capture.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
	});

	it('keeps parallel tool IDs, split UTF-8 progress, reset/snapshot output and failed exits', () => {
		const f = fixture();
		const tool = (toolCallId: string, extra: Record<string, unknown>) =>
			f.send({ sessionUpdate: 'tool_call_update', toolCallId, ...extra }, 'session/update')[0];
		for (const toolCallId of ['a', 'b'])
			f.send(
				{
					sessionUpdate: 'tool_call',
					toolCallId,
					title: 'Bash',
					rawInput: { command: toolCallId },
				},
				'session/update'
			);
		expect(tool('a', { rawOutput: { output_delta: [0xe9] } }).toolState).toMatchObject({
			output: '',
		});
		expect(tool('b', { rawOutput: 'other' }).toolState).toMatchObject({
			input: { command: 'b' },
			output: 'other',
		});
		expect(tool('a', { rawOutput: { output_delta: [0x9b, 0xaa] } }).toolState).toMatchObject({
			output: '雪',
			input: { command: 'a' },
		});
		expect(tool('a', { rawOutput: { output_delta: [] } }).toolState).toMatchObject({ output: '' });
		expect(tool('a', { rawOutput: { output: [65, 66] } }).toolState).toMatchObject({
			output: 'AB',
		});
		const failed = { status: 'completed', rawOutput: { output_delta: [67], exit_code: 7 } };
		expect(tool('a', failed)).toMatchObject({
			toolCallId: 'a',
			toolName: 'Bash',
			toolState: { status: 'failed', providerStatus: 'completed', exitCode: 7, output: 'ABC' },
		});
		expect(tool('a', failed).toolState).toMatchObject({ output: 'ABC', status: 'failed' });
		expect(tool('a', { status: 'in_progress' }).toolState).toMatchObject({ status: 'failed' });
		expect(
			tool('b', {
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
			}).toolState
		).toMatchObject({ output: 'done', status: 'completed' });
		expect(f.output.filter((e) => e.kind === 'tool').at(-1)).toMatchObject({
			tool: { id: 'b', name: 'Bash', status: 'completed' },
		});
		f.accept(f.adapter.settle({ stopReason: 'end_turn' }));
		expect(f.adapter.terminal?.status).toBe('success');
	});

	it.each(['subagent_spawned', 'subagent_progress', 'subagent_finished'])(
		'retains %s lineage without adding child occupancy to spend',
		(sessionUpdate) => {
			const f = fixture();
			const parentSessionId = sessionUpdate === 'subagent_finished' ? undefined : 'parent';
			const parentTurnId = sessionUpdate === 'subagent_spawned' ? 'parent-turn' : undefined;
			const [event] = f.send({
				sessionUpdate,
				parent_session_id: parentSessionId,
				parent_prompt_id: parentTurnId,
				child_session_id: 'child',
				subagent_id: 'worker',
				attempt_id: 'attempt',
				tokens_used: 9000,
			});
			expect(event.sessionRelation).toEqual({
				parentSessionId,
				parentTurnId,
				childSessionId: 'child',
				subagentId: 'worker',
				attemptId: 'attempt',
			});
			expect(event.parentToolUseId).toBeUndefined();
			expect(event.usage).toBeUndefined();
			expect(f.capture.usage).toBeUndefined();
		}
	);

	it.each([
		['session/update', { sessionUpdate: 'usage_update', used: 900, size: 1000 }],
		[
			'session/update',
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'fixture' } },
		],
		['_x.ai/session/update', { sessionUpdate: 'future_extension', extra: { nested: true } }],
		[
			'future/method',
			{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'opaque' } },
		],
	] as const)(
		'preserves unsupported %s envelopes without fabricating text or usage',
		(method, update) => {
			const f = fixture(),
				message = notification(update, method);
			expect(f.adapter.notification(message, context)).toEqual([
				{ type: 'system', sessionId: identity.sessionId, raw: message },
			]);
		}
	);

	it.each([
		{ status: 'cancelled', origin: 'user' },
		{ status: 'timeout', kind: 'idle' },
		{ status: 'failed', kind: 'transport' },
	] as const)(
		'retains durable partial output and usage when lifecycle reports $status',
		(failure) => {
			const f = fixture();
			f.send({
				sessionUpdate: 'turn_completed',
				prompt_id: 'prompt',
				agent_result: 'saved partial',
				stop_reason: 'end_turn',
				usage: { ...promptUsage, costUsdTicks: '10', costIsPartial: true },
			});
			f.accept(f.adapter.settle({ stopReason: 'end_turn' }, failure));
			expect(f.adapter.terminal).toMatchObject(failure);
			expect(f.capture.answerText).toBe('saved partial');
			expect(f.capture.usage?.accounting?.cost).toEqual({ status: 'partial', costUsdTicks: '10' });
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	it('reconciles started/completed responses, provisional totals and a covering final once', () => {
		const f = fixture();
		for (const message_id of ['r1', 'r2']) {
			f.send({
				sessionUpdate: 'response_started',
				message_id,
				model: 'grok-fixture',
				...responseUsage,
			});
			const completed = { sessionUpdate: 'response_completed', message_id, usage: responseUsage };
			f.send(completed);
			f.send(completed);
		}
		expect(f.capture.usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 20,
			cacheReadInputTokens: 40,
			cacheCreationInputTokens: 20,
			reasoningTokens: 6,
		});
		f.send({
			sessionUpdate: 'turn_usage',
			usage: {
				...responseUsage,
				input_tokens: 200,
				output_tokens: 20,
				cache_read_input_tokens: 40,
				cache_creation_input_tokens: 20,
				reasoning_tokens: 6,
			},
		});
		const usage = {
			...promptUsage,
			inputTokens: 260,
			outputTokens: 20,
			cachedReadTokens: 40,
			cacheCreationTokens: 20,
			reasoningTokens: 6,
			costUsdTicks: '12',
			modelCalls: 2,
			numTurns: 1,
		};
		f.accept(f.adapter.settle({ stopReason: 'end_turn', _meta: { usage } }));
		expect(f.capture.usage).toMatchObject({
			inputTokens: 200,
			outputTokens: 20,
			cacheReadInputTokens: 40,
			cacheCreationInputTokens: 20,
			reasoningTokens: 6,
			accounting: {
				final: true,
				callCount: 2,
				mainAgentRounds: 1,
				childInclusion: 'completed',
				cost: { status: 'exact', costUsdTicks: '12' },
			},
		});
	});

	it('keeps anonymous response aliases non-additive and interrupted usage partial', () => {
		const f = fixture();
		f.send({ sessionUpdate: 'response_started', ...responseUsage });
		const completion = {
			sessionUpdate: 'response_completed',
			message_id: 'late-id',
			usage: responseUsage,
		};
		f.send(completion);
		f.send(completion);
		f.send({ sessionUpdate: 'response_started', message_id: 'late-id', ...responseUsage });
		f.accept(f.adapter.settle(undefined, { status: 'failed', kind: 'transport' }));
		expect(f.capture.usage).toMatchObject({
			inputTokens: 100,
			outputTokens: 10,
			cacheReadInputTokens: 20,
			cacheCreationInputTokens: 10,
			accounting: { completeness: 'partial', cost: { status: 'unknown' } },
		});
		expect(f.capture.resultMessageSeen).toBe(false);
	});

	it.each(['9007199254740993', '9223372036854775807'])(
		'preserves raw %s ticks through notification, prompt reply, models and capture',
		(ticks) => {
			const f = fixture();
			const row = `{"inputTokens":130,"outputTokens":10,"cachedReadTokens":20,"cacheCreationTokens":10,"reasoningTokens":3,"costUsdTicks":${ticks}}`;
			const usage = `${row.slice(0, -1)},"modelUsage":{"grok-a":${row},"grok-b":{"inputTokens":0,"outputTokens":0,"cachedReadTokens":0,"cacheCreationTokens":0,"reasoningTokens":0,"costUsdTicks":0}}}`;
			f.wire(
				`{"jsonrpc":"2.0","method":"_x.ai/session/update","params":{"sessionId":"native-session","update":{"sessionUpdate":"turn_completed","prompt_id":"prompt","usage":${usage}}}}`
			);
			expect(f.capture.usage?.accounting?.cost).toMatchObject({ costUsdTicks: ticks });
			f.wire(
				`{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn","_meta":{"usage":${usage}}}}`
			);
			expect(f.capture.usage).toMatchObject({
				inputTokens: 100,
				outputTokens: 10,
				accounting: {
					cost: { status: 'exact', costUsdTicks: ticks },
					models: [
						{ model: 'grok-a', inputTokens: 100, cost: { status: 'exact', costUsdTicks: ticks } },
						{ model: 'grok-b', inputTokens: 0, cost: { status: 'exact', costUsdTicks: '0' } },
					],
				},
			});
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	it.each([
		['0', 'exact', '0'],
		['"0"', 'exact', '0'],
		['null', 'unknown', undefined],
		['-1', 'unknown', undefined],
		['-0', 'unknown', undefined],
		['1.0', 'unknown', undefined],
		['1e3', 'unknown', undefined],
		['0.99999999999999999', 'unknown', undefined],
		['1e-9999', 'unknown', undefined],
	] as const)(
		'never rounds raw cost %s into an authoritative free/exact cost',
		(token, status, costUsdTicks) => {
			const f = fixture();
			const usage = `${JSON.stringify(promptUsage).slice(0, -1)},"costUsdTicks":${token}}`;
			f.wire(
				`{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn","_meta":{"usage":${usage}}}}`
			);
			expect(f.capture.usage?.accounting?.cost.status).toBe(status);
			expect(f.capture.usage?.accounting?.cost).toMatchObject(
				costUsdTicks === undefined ? { status } : { status, costUsdTicks }
			);
			expect(f.events[0].usage?.costUsd).toBe(status === 'exact' ? 0 : undefined);
		}
	);

	it.each([
		[{}, 'unknown'],
		[{ costUsdTicks: '4', costIsPartial: true }, 'partial'],
		[{ costUsdTicks: '4', usageIsIncomplete: true }, 'partial'],
		[{ costIsPartial: true }, 'partial'],
		[{ costUsdTicks: '4', costIsPartial: 'invalid' }, 'partial'],
		[{ costUsdTicks: '4', inputTokens: 1 }, 'unknown'],
		[{ costUsdTicks: '4', reasoningTokens: 99 }, 'partial'],
	] as const)('preserves missing/partial cost and invalid completeness %#', (fields, status) => {
		const f = fixture();
		f.accept(
			f.adapter.settle({ stopReason: 'end_turn', _meta: { usage: { ...promptUsage, ...fields } } })
		);
		expect(f.capture.usage?.accounting?.cost.status).toBe(status);
	});

	it.each([
		{},
		{ inputTokens: -1, outputTokens: 0 },
		{ inputTokens: 0, outputTokens: 0, usageIsIncomplete: true },
	])('does not erase observed spend with unusable final totals %#', (usage) => {
		const f = fixture();
		f.send({ sessionUpdate: 'response_completed', message_id: 'r', usage: responseUsage });
		f.accept(f.adapter.settle({ stopReason: 'cancelled', _meta: { usage } }));
		expect(f.capture.usage).toMatchObject({
			inputTokens: 100,
			outputTokens: 10,
			accounting: { completeness: 'partial', cost: { status: 'unknown' } },
		});
	});

	it.each([
		['end_turn', { status: 'success' }, 'completed'],
		['cancelled', { status: 'cancelled', origin: 'provider' }, 'interrupted'],
		['refusal', { status: 'refused', origin: 'provider' }, 'crashed'],
		['max_tokens', { status: 'incomplete', kind: 'limit' }, 'crashed'],
		['max_turn_requests', { status: 'incomplete', kind: 'limit' }, 'crashed'],
		['error', { status: 'failed', kind: 'provider' }, 'crashed'],
		['future_stop', { status: 'incomplete', kind: 'unknown-stop-reason' }, 'crashed'],
		[undefined, { status: 'incomplete', kind: 'missing-terminal' }, 'crashed'],
		['', { status: 'incomplete', kind: 'missing-terminal' }, 'crashed'],
	] as const)(
		'resolves stop %s once despite exit zero and useful text',
		(stopReason, terminal, outcome) => {
			const f = fixture();
			f.send(
				{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
				'session/update'
			);
			f.accept(f.adapter.settle({ stopReason }));
			expect(f.adapter.terminal).toEqual({
				...terminal,
				dispatchState: 'dispatched',
				...(stopReason ? { providerStopReason: stopReason } : {}),
			});
			expect(f.outcome()).toEqual({ outcome, terminal: f.adapter.terminal });
			expect(f.capture.answerText).toBe('partial');
			expect(f.output.filter((e) => e.kind === 'text')).toEqual([
				{ kind: 'text', text: 'partial' },
			]);
			expect(f.capture.resultMessageSeen).toBe(terminal.status === 'success');
			expect(f.adapter.settle({ stopReason: 'end_turn' })).toEqual([]);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	describe.each(['prompt', 'durable'] as const)('%s terminal metadata', (source) => {
		it.each([
			[{ cancellationCategory: 'HookDenied' }, { status: 'refused', origin: 'provider' }],
			[{ cancellationCategory: 'PermissionRejected' }, { status: 'refused', origin: 'provider' }],
			[
				{ cancellationCategory: 'PermissionCancelled' },
				{ status: 'cancelled', origin: 'provider' },
			],
			[{ cancellationCategory: 'MidTurnAbort' }, { status: 'cancelled', origin: 'provider' }],
			[{ cancellationCategory: 'max_turns_reached' }, { status: 'incomplete', kind: 'limit' }],
			[{ cancellationCategory: 'action_stationarity' }, { status: 'incomplete', kind: 'limit' }],
			[{ cancellationCategory: 'future' }, { status: 'incomplete', kind: 'unknown-stop-reason' }],
			[{ structuredOutputError: 'invalid' }, { status: 'failed', kind: 'provider' }],
			[{ structuredOutputError: {} }, { status: 'failed', kind: 'provider' }],
			[
				{ completionKind: 'removedFromQueue' },
				{ status: 'cancelled', origin: 'provider', dispatchState: 'not-dispatched' },
			],
		] as const)('overrides end_turn without losing durable output %#', (metadata, terminal) => {
			const f = fixture();
			const message = notification({
				sessionUpdate: 'turn_completed',
				prompt_id: identity.promptId,
				agent_result: 'saved partial',
				stop_reason: 'end_turn',
				usage: promptUsage,
			});
			if (source === 'durable') message.params = { ...message.params, _meta: metadata };
			f.accept(f.adapter.notification(message, context));
			f.accept(
				f.adapter.settle({ stopReason: 'end_turn', _meta: source === 'prompt' ? metadata : {} })
			);
			expect(f.adapter.terminal).toEqual({
				dispatchState: 'dispatched',
				...terminal,
				providerStopReason: 'end_turn',
			});
			expect(f.outcome()).toEqual({
				outcome: terminal.status === 'cancelled' ? 'interrupted' : 'crashed',
				terminal: f.adapter.terminal,
			});
			expect(f.capture.answerText).toBe('saved partial');
			expect(f.output.filter((e) => e.kind === 'text')).toEqual([
				{ kind: 'text', text: 'saved partial' },
			]);
			expect(f.capture.usage?.accounting?.cost).toEqual({ status: 'unknown' });
			expect(f.capture.resultMessageSeen).toBe(false);
			expect(f.adapter.settle({ stopReason: 'end_turn' })).toEqual([]);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		});
	});

	it.each([
		[{ stop_reason: 'cancelled' }, { status: 'cancelled', origin: 'provider' }],
		[{ stop_reason: 'refusal' }, { status: 'refused', origin: 'provider' }],
		[{ stop_reason: 'max_tokens' }, { status: 'incomplete', kind: 'limit' }],
		[{ stop_reason: 'max_turn_requests' }, { status: 'incomplete', kind: 'limit' }],
		[{ stop_reason: 'error' }, { status: 'failed', kind: 'provider' }],
		[{ stop_reason: 'future' }, { status: 'incomplete', kind: 'unknown-stop-reason' }],
		[
			{ error_kind: 'max_tokens_truncation' },
			{ status: 'incomplete', kind: 'limit', reason: 'max_tokens_truncation' },
		],
		[
			{ error_kind: 'upstream_failure' },
			{ status: 'failed', kind: 'provider', reason: 'upstream_failure' },
		],
	] as const)(
		'preserves durable non-success over a successful prompt reply %#',
		(fields, terminal) => {
			const f = fixture();
			f.send({
				sessionUpdate: 'turn_completed',
				prompt_id: identity.promptId,
				stop_reason: 'end_turn',
				agent_result: 'partial',
				...fields,
			});
			expect(f.adapter.terminal).toBeUndefined();
			f.accept(f.adapter.settle({ stopReason: 'end_turn' }));
			expect(f.adapter.terminal).toMatchObject({ ...terminal, providerStopReason: 'end_turn' });
			expect(f.outcome()).toEqual({
				outcome: terminal.status === 'cancelled' ? 'interrupted' : 'crashed',
				terminal: f.adapter.terminal,
			});
			expect(f.capture.answerText).toBe('partial');
			expect(f.capture.resultMessageSeen).toBe(false);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	describe.each([false, true])('with trusted durable usage: %s', (durable) => {
		it.each([{ sessionId: 'foreign-session' }, { promptId: 'foreign-prompt' }])(
			'rejects mismatched prompt metadata %# without importing its usage',
			(metadata) => {
				const f = fixture();
				f.send(
					{
						sessionUpdate: 'agent_message_chunk',
						content: { type: 'text', text: 'owned partial' },
					},
					'session/update'
				);
				if (durable)
					f.send({
						sessionUpdate: 'turn_completed',
						prompt_id: identity.promptId,
						usage: promptUsage,
					});
				f.accept(
					f.adapter.settle({
						stopReason: 'end_turn',
						_meta: {
							...metadata,
							usage: { ...promptUsage, inputTokens: 9999, costUsdTicks: '99' },
						},
					})
				);
				expect(f.outcome()).toMatchObject({
					outcome: 'crashed',
					terminal: { status: 'failed', kind: 'protocol' },
				});
				expect(f.capture.answerText).toBe('owned partial');
				expect(f.capture.resultMessageSeen).toBe(false);
				if (durable)
					expect(f.capture.usage).toMatchObject({
						inputTokens: 100,
						accounting: { cost: { status: 'unknown' } },
					});
				else expect(f.capture.usage).toBeUndefined();
				expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
			}
		);
	});

	it.each(['numeric-request', 'string-request', 'replay', 'foreign-turn', 'foreign-session'])(
		'rejects %s before it can alter text, tools, usage or durable state',
		(kind) => {
			const f = fixture();
			for (const [method, update] of [
				[
					'session/update',
					{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign' } },
				],
				['session/update', { sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Bash' }],
				['_x.ai/session/update', { sessionUpdate: 'turn_usage', usage: responseUsage }],
				[
					'_x.ai/session/update',
					{
						sessionUpdate: 'turn_completed',
						prompt_id: identity.promptId,
						agent_result: 'foreign',
						stop_reason: 'refusal',
						usage: promptUsage,
					},
				],
			] as const) {
				const message = notification(update, method);
				if (kind === 'numeric-request') message.id = 0;
				if (kind === 'string-request') message.id = 'request';
				if (kind === 'foreign-session') message.params = { ...message.params, sessionId: 'other' };
				expect(
					f.accept(
						f.adapter.notification(message, {
							replay: kind === 'replay',
							turnId: kind === 'foreign-turn' ? 'other' : identity.turnId,
						})
					)
				).toEqual([]);
			}
			expect(f.events).toEqual([]);
			expect(f.output).toEqual([]);
			expect(f.capture.usage).toBeUndefined();
			f.send({
				sessionUpdate: 'turn_completed',
				prompt_id: identity.promptId,
				agent_result: 'owned',
				usage: promptUsage,
			});
			f.accept(f.adapter.settle({ stopReason: 'end_turn' }));
			expect(f.outcome().outcome).toBe('completed');
			expect(f.output.filter((e) => e.kind === 'text')).toEqual([{ kind: 'text', text: 'owned' }]);
			expect(f.capture.usage?.inputTokens).toBe(100);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	it.each(['unbound', 'foreign-prompt', 'missing-prompt', 'missing-session'])(
		'keeps %s durable notifications opaque',
		(kind) => {
			const f = fixture({
				...identity,
				promptId: kind === 'unbound' ? undefined : identity.promptId,
			});
			const update = {
				sessionUpdate: 'turn_completed',
				prompt_id:
					kind === 'missing-prompt'
						? undefined
						: kind === 'foreign-prompt'
							? 'other'
							: identity.promptId,
				agent_result: 'unowned',
				stop_reason: 'refusal',
				usage: promptUsage,
			};
			const message = notification(update);
			if (kind === 'missing-session') message.params = { update };
			expect(f.accept(f.adapter.notification(message, context))).toEqual([
				{ type: 'system', sessionId: identity.sessionId, raw: message },
			]);
			f.accept(f.adapter.settle({ stopReason: 'end_turn' }));
			expect(f.outcome().outcome).toBe('completed');
			expect(f.capture.answerText).toBeUndefined();
			expect(f.capture.usage).toBeUndefined();
			expect(f.output.filter((e) => e.kind === 'text')).toEqual([]);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);

	it.each([
		[{}, { status: 'unknown' }, 'complete'],
		[{ costUsdTicks: '-1' }, { status: 'unknown' }, 'complete'],
		[{ costUsdTicks: '1e3' }, { status: 'unknown' }, 'complete'],
		[{ costUsdTicks: null }, { status: 'unknown' }, 'complete'],
		[
			{ costUsdTicks: '9', costIsPartial: true },
			{ status: 'partial', costUsdTicks: '9' },
			'complete',
		],
		[
			{ costUsdTicks: '9', costIsPartial: 'invalid' },
			{ status: 'partial', costUsdTicks: '9' },
			'partial',
		],
		[{ costIsPartial: true }, { status: 'partial' }, 'complete'],
	] as const)(
		'keeps model cost provenance separate from exact parent cost %#',
		(fields, cost, completeness) => {
			const f = fixture();
			f.accept(
				f.adapter.settle({
					stopReason: 'end_turn',
					_meta: {
						usage: {
							...promptUsage,
							costUsdTicks: '20',
							modelUsage: {
								'grok-a': { ...promptUsage, ...fields },
								'grok-b': { ...promptUsage, costUsdTicks: '7' },
							},
						},
					},
				})
			);
			expect(f.capture.usage).toMatchObject({
				inputTokens: 100,
				outputTokens: 10,
				accounting: {
					cost: { status: 'exact', costUsdTicks: '20' },
					models: [
						{
							model: 'grok-a',
							inputTokens: 100,
							cacheReadInputTokens: 20,
							cacheCreationInputTokens: 10,
							cost,
							completeness,
						},
						{ model: 'grok-b', cost: { status: 'exact', costUsdTicks: '7' } },
					],
				},
			});
		}
	);

	it.each([{}, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 1 }])(
		'keeps malformed model counts unknown without erasing valid sibling usage %#',
		(row) => {
			const f = fixture();
			f.accept(
				f.adapter.settle({
					stopReason: 'end_turn',
					_meta: {
						usage: {
							...promptUsage,
							modelUsage: {
								'grok-bad': { ...row, costUsdTicks: '999' },
								'grok-null': null,
								'grok-good': { ...promptUsage, costUsdTicks: '7' },
							},
						},
					},
				})
			);
			expect(f.capture.usage?.accounting?.models).toEqual([
				{ model: 'grok-bad', completeness: 'unknown', cost: { status: 'unknown' } },
				expect.objectContaining({
					model: 'grok-good',
					inputTokens: 100,
					cost: { status: 'exact', costUsdTicks: '7' },
				}),
			]);
			expect(f.capture.usage?.accounting?.cost).toEqual({ status: 'unknown' });
			expect(f.capture.usage?.inputTokens).toBe(100);
		}
	);

	it('carries partial parent cost into otherwise exact model rows', () => {
		const f = fixture();
		f.accept(
			f.adapter.settle({
				stopReason: 'end_turn',
				_meta: {
					usage: {
						...promptUsage,
						costUsdTicks: '20',
						costIsPartial: true,
						modelUsage: { 'grok-a': { ...promptUsage, costUsdTicks: '9' } },
					},
				},
			})
		);
		expect(f.capture.usage?.accounting).toMatchObject({
			cost: { status: 'partial', costUsdTicks: '20' },
			models: [{ model: 'grok-a', cost: { status: 'partial', costUsdTicks: '9' } }],
		});
	});

	it.each([false, true])(
		'keeps unbaselined process spend separate with final usage: %s',
		(final) => {
			const f = fixture();
			const usage = { ...promptUsage, inputTokens: 1030, costUsdTicks: '90' };
			f.accept(f.adapter.processUsage({ usage }));
			expect(f.capture.usage).toBeUndefined();
			f.send({ sessionUpdate: 'response_completed', message_id: 'r', usage: responseUsage });
			f.accept(f.adapter.processUsage({ usage: { ...usage, inputTokens: 2030 } }));
			expect(f.capture.usage).toMatchObject({
				inputTokens: 100,
				outputTokens: 10,
				accounting: { cost: { status: 'unknown' } },
			});
			expect(
				f.capture.usageReports.filter((report) => report.accounting?.scope === 'process-session')
			).toMatchObject([
				{
					inputTokens: 2000,
					accounting: { scope: 'process-session', cost: { status: 'exact', costUsdTicks: '90' } },
				},
			]);
			f.accept(
				final
					? f.adapter.settle({ stopReason: 'end_turn', _meta: { usage: promptUsage } })
					: f.adapter.settle(undefined, { status: 'failed', kind: 'transport' })
			);
			expect(f.capture.usage).toMatchObject({
				inputTokens: 100,
				outputTokens: 10,
				accounting: { completeness: final ? 'complete' : 'partial', cost: { status: 'unknown' } },
			});
			expect(
				f.capture.usageReports.filter((report) => report.accounting?.scope === 'process-session')
			).toHaveLength(1);
			expect(f.events.filter((e) => e.terminal)).toHaveLength(1);
		}
	);
});
