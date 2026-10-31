import { describe, expect, it } from 'vitest';
import { GrokAcpEventAdapter } from '../../../../shared/maestro-lib/grok/acp-events';
import { AcpFrameDecoder, type AcpCall } from '../../../../shared/maestro-lib/grok/acp-protocol';
import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import { GrokOutputParser } from '../../../../shared/maestro-lib/parsers/grok-output-parser';
import { TurnCapture } from '../../../../shared/maestro-lib/run/turn-capture';
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
function fixture() {
	const adapter = new GrokAcpEventAdapter(identity);
	// Only the existing normalized-field extractors are used; no native/Claude decoding.
	const capture = new TurnCapture('grok', new GrokOutputParser(), { classifyInBandErrors: false });
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
});
