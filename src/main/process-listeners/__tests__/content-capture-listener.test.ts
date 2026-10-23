/**
 * The managed content capture listener (MRC-10-05A): follows a spawn only when
 * the collection standing admits it, hears `parsed-event` only while it follows
 * a process, hands the prompt, the answers and the tool calls to the capture by
 * role with the owning agent and tab, lets a lapsed standing refuse the next
 * line by name, and never subscribes on a standalone desktop.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import {
	createContentCapture,
	type ContentCaptureInput,
	type ContentCollectionStanding,
} from '../../enterprise/content';
import type { ProcessManager } from '../../process-manager';
import type { ProcessConfig } from '../../process-manager/types';
import type { ParsedEvent } from '../../parsers/agent-output-parser';
import { contentOfParsedEvent, setupContentCaptureListener } from '../content-capture-listener';

class FakeProcessManager extends EventEmitter {
	spawn(config: ProcessConfig): void {
		this.emit('spawn', config);
	}
	line(sessionId: string, event: ParsedEvent): void {
		if (this.listenerCount('parsed-event') > 0) this.emit('parsed-event', sessionId, event);
	}
	exit(sessionId: string): void {
		this.emit('exit', sessionId, 0);
	}
}

const config = (overrides: Partial<ProcessConfig> = {}): ProcessConfig =>
	({
		sessionId: 'agent-1-ai-tab-1',
		toolType: 'claude-code',
		cwd: '/work',
		command: 'claude',
		prompt: 'Summarize the release notes',
		tabId: 'tab-1',
		...overrides,
	}) as ProcessConfig;

const ok: ContentCollectionStanding = {
	mode: 'managed',
	ok: true,
	profile: 'full',
	policyRevision: 3,
	ceiling: {
		policyRevision: 3,
		profile: 'full',
		roles: ['user.prompt', 'assistant.output', 'tool.input'],
		permissions: {
			capture: true,
			upload: true,
			storage: true,
			index: false,
			display: false,
			export: false,
		},
		sensitivity: 'internal',
		maxPayloadBytes: 65536,
		redactionRuleIds: [],
	},
};

function harness(initial: ContentCollectionStanding) {
	let standing = initial;
	const inputs: ContentCaptureInput[] = [];
	const source = { standing: () => standing };
	const real = createContentCapture({ source, newId: () => 'ref' });
	const capture = {
		capture: (input: ContentCaptureInput) => {
			inputs.push(input);
			return real.capture(input);
		},
	};
	const manager = new FakeProcessManager();
	const listener = setupContentCaptureListener(manager as unknown as ProcessManager, {
		source,
		capture,
	});
	return {
		manager,
		listener,
		inputs,
		real,
		setStanding: (s: ContentCollectionStanding) => (standing = s),
	};
}

describe('content capture listener', () => {
	it('reads provider-visible content by role and nothing from init, usage, system or error lines', () => {
		expect(contentOfParsedEvent({ type: 'text', text: 'Hello' })).toEqual({
			role: 'assistant.output',
			text: 'Hello',
			toolName: null,
		});
		expect(contentOfParsedEvent({ type: 'result', text: 'Done' })?.role).toBe('assistant.output');
		expect(contentOfParsedEvent({ type: 'text', text: '' })).toBeNull();
		expect(
			contentOfParsedEvent({ type: 'tool_use', toolName: 'Read', toolState: { path: 'a.ts' } })
		).toEqual({
			role: 'tool.input',
			text: '{"toolName":"Read","toolState":{"path":"a.ts"}}',
			toolName: 'Read',
		});
		for (const type of ['init', 'usage', 'system', 'error'] as const)
			expect(contentOfParsedEvent({ type, text: 'anything' })).toBeNull();
	});

	it('follows an admitted spawn, hands prompt, answer and tool call to the capture, and stops listening at exit', () => {
		const { manager, listener, inputs, real } = harness(ok);
		expect(manager.listenerCount('parsed-event')).toBe(0);
		manager.spawn(config());
		expect(listener.following()).toBe(1);
		expect(manager.listenerCount('parsed-event')).toBe(1);
		manager.line('agent-1-ai-tab-1', { type: 'text', text: 'Here is the summary.' });
		manager.line('agent-1-ai-tab-1', {
			type: 'tool_use',
			toolName: 'Read',
			toolState: { path: 'notes.md' },
			parentToolUseId: 'call-7',
		});
		manager.line('agent-1-ai-tab-1', { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } });
		// A line from a process it does not follow is not content.
		manager.line('agent-9-ai-tab-1', { type: 'text', text: 'not followed' });
		expect(
			inputs.map((i) => [i.role, i.agentId, i.tabId, i.provider, i.parentToolCallId ?? null])
		).toEqual([
			['user.prompt', 'agent-1', 'tab-1', 'claude-code', null],
			['assistant.output', 'agent-1', 'tab-1', 'claude-code', null],
			['tool.input', 'agent-1', 'tab-1', 'claude-code', 'call-7'],
		]);
		expect(real.status()).toMatchObject({
			records: 3,
			byRole: { 'user.prompt': 1, 'assistant.output': 1, 'tool.input': 1 },
		});
		manager.exit('agent-1-ai-tab-1');
		expect(listener.following()).toBe(0);
		expect(manager.listenerCount('parsed-event')).toBe(0);
		manager.line('agent-1-ai-tab-1', { type: 'text', text: 'after exit' });
		expect(inputs).toHaveLength(3);
	});

	it('never follows on a standalone or refused standing, skips terminal and group-chat sessions, and lets a lapsed standing refuse the next line', () => {
		const standalone = harness({ mode: 'standalone' });
		standalone.manager.spawn(config());
		expect(standalone.listener.following()).toBe(0);
		expect(standalone.manager.listenerCount('parsed-event')).toBe(0);
		expect(standalone.inputs).toEqual([]);

		const refused = harness({
			mode: 'managed',
			ok: false,
			reason: 'metadata',
			profile: 'metadata',
			policyRevision: 3,
		});
		refused.manager.spawn(config());
		expect(refused.listener.following()).toBe(0);

		const { manager, listener, inputs, real, setStanding } = harness(ok);
		manager.spawn(config({ sessionId: 'agent-1-terminal-1' }));
		manager.spawn(config({ sessionId: 'group-chat-room-1' }));
		expect(listener.following()).toBe(0);
		manager.spawn(config({ prompt: undefined }));
		expect(inputs).toEqual([]);
		setStanding({
			mode: 'managed',
			ok: false,
			reason: 'the standing lapsed',
			profile: 'full',
			policyRevision: 3,
		});
		manager.line('agent-1-ai-tab-1', { type: 'text', text: 'late answer' });
		expect(inputs).toHaveLength(1);
		expect(real.status()).toMatchObject({ records: 0, notCollected: 1 });
		listener.dispose();
		expect(manager.listenerCount('spawn')).toBe(0);
		expect(manager.listenerCount('parsed-event')).toBe(0);
	});
});
