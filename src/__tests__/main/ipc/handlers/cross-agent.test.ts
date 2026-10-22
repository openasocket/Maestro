/**
 * Tests for resolveCrossAgentWritable in src/main/ipc/handlers/cross-agent.ts
 *
 * A consult and a hand-off have separate write switches with opposite defaults:
 * a consult answers a question (read-only unless opted in), a hand-off passes
 * work on (may write unless opted out).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The router is the consult service's desktop binding; mocked so the handler
// test proves only what the handler adds: the actor it resolves for the sink.
vi.mock('../../../../main/cross-agent/cross-agent-router', () => ({
	startCrossAgentRequest: vi.fn(async () => undefined),
	cancelCrossAgentRequestsForSource: vi.fn(() => 0),
}));

import { ipcMain } from 'electron';
import {
	registerCrossAgentHandlers,
	resolveCrossAgentWritable,
} from '../../../../main/ipc/handlers/cross-agent';
import { startCrossAgentRequest } from '../../../../main/cross-agent/cross-agent-router';
import { issueDispatchTicket } from '../../../../main/web-server/auth/transport-actor';
import type { CrossAgentSendRequest } from '../../../../shared/crossAgentTypes';

/** A settings store holding only `values`; anything else gets the caller's default. */
function store(values: Record<string, unknown>) {
	return {
		get: <T>(key: string, defaultValue?: T): T => (key in values ? values[key] : defaultValue) as T,
	};
}

describe('resolveCrossAgentWritable', () => {
	it('keeps a consult read-only and lets a hand-off write when nothing is set', () => {
		expect(resolveCrossAgentWritable({}, store({}))).toBe(false);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, store({}))).toBe(true);
	});

	it('reads each kind from its own switch only', () => {
		const settings = store({ crossAgentMentionsWritable: true, crossAgentHandoffsWritable: false });

		expect(resolveCrossAgentWritable({}, settings)).toBe(true);
		expect(resolveCrossAgentWritable({ handoffAnswer: 'findings' }, settings)).toBe(false);
	});

	it('treats an empty answer as a hand-off, not a consult', () => {
		// The field's presence is the marker; an agent can legitimately answer with "".
		expect(resolveCrossAgentWritable({ handoffAnswer: '' }, store({}))).toBe(true);
	});
});

/**
 * The `cross-agent:send` handler is the consult's sink-side claim of the
 * dispatch ticket `cross_agent_ask` issued (MRC-08-01C): the renderer echoed
 * the opaque key down from the WebSocket handler, and here it is spent for the
 * target agent and the consult tab the renderer picked. The ticket decides the
 * actor the runner binds; nothing else on the payload may.
 */
describe('cross-agent:send dispatch ticket (MRC-08-01C)', () => {
	type SendHandler = (
		event: unknown,
		payload: CrossAgentSendRequest
	) => Promise<{ requestId: string }>;

	function registerSend(): SendHandler {
		registerCrossAgentHandlers({
			getProcessManager: () => ({}) as never,
			getAgentDetector: () => ({}) as never,
			sessionsStore: {
				get: () => [{ id: 'tgt', name: 'Target', toolType: 'claude-code', cwd: '/proj' }],
			} as never,
			agentConfigsStore: { get: () => ({}) } as never,
			settingsStore: store({}) as never,
			sshStore: null,
			safeSend: vi.fn(),
		});
		const entry = vi
			.mocked(ipcMain.handle)
			.mock.calls.find(([channel]) => channel === 'cross-agent:send');
		if (!entry) throw new Error('cross-agent:send was not registered');
		return entry[1] as unknown as SendHandler;
	}

	const payload = (overrides: Partial<CrossAgentSendRequest> = {}): CrossAgentSendRequest => ({
		sourceSessionId: 'cli-ask',
		sourceTabId: 'cli-ask',
		targetSessionId: 'tgt',
		targetTabId: 'consult-1',
		userPrompt: 'How does the gate work?',
		transcript: [],
		strategy: { kind: 'full' },
		...overrides,
	});

	const actorSeen = () => {
		const calls = vi.mocked(startCrossAgentRequest).mock.calls;
		return calls[calls.length - 1][1].actor;
	};

	beforeEach(() => {
		vi.mocked(ipcMain.handle).mockClear();
		vi.mocked(startCrossAgentRequest).mockClear();
	});

	it('binds a CLI-asked consult as the host secret and keeps the ticket off the request', async () => {
		const send = registerSend();
		const ticket = issueDispatchTicket({ kind: 'cli' }, { agentId: 'tgt' });

		await send(undefined, payload({ dispatchTicket: ticket }));

		expect(actorSeen()).toEqual({ peer: 'host-secret' });
		const request = vi.mocked(startCrossAgentRequest).mock.calls[0][0];
		expect(request).not.toHaveProperty('dispatchTicket');
		expect(request.targetSessionId).toBe('tgt');
	});

	it('binds a device-asked consult as that device', async () => {
		const send = registerSend();
		const ticket = issueDispatchTicket(
			{ kind: 'lite', deviceId: 'dev-7', deviceName: 'Pixel 9' },
			{ agentId: 'tgt' }
		);

		await send(undefined, payload({ dispatchTicket: ticket }));

		expect(actorSeen()).toEqual({ peer: 'device-pairing', deviceId: 'dev-7' });
	});

	it('binds a forged ticket in-process, never as what it claims', async () => {
		const send = registerSend();
		await send(undefined, payload({ dispatchTicket: 'not-a-ticket-cli' }));
		expect(actorSeen()).toEqual({ peer: 'in-process' });
	});

	it('binds a spent ticket in-process on the replay', async () => {
		const send = registerSend();
		const ticket = issueDispatchTicket({ kind: 'cli' }, { agentId: 'tgt' });

		await send(undefined, payload({ dispatchTicket: ticket }));
		await send(undefined, payload({ dispatchTicket: ticket }));

		expect(vi.mocked(startCrossAgentRequest).mock.calls[0][1].actor).toEqual({
			peer: 'host-secret',
		});
		expect(actorSeen()).toEqual({ peer: 'in-process' });
	});

	it('binds a ticket issued for another agent in-process', async () => {
		const send = registerSend();
		const ticket = issueDispatchTicket({ kind: 'cli' }, { agentId: 'someone-else' });

		await send(undefined, payload({ dispatchTicket: ticket }));

		expect(actorSeen()).toEqual({ peer: 'in-process' });
	});

	it('binds a typed mention, which carries no ticket, in-process as before', async () => {
		const send = registerSend();
		await send(undefined, payload({ sourceSessionId: 'src', sourceTabId: 'tab-1' }));
		expect(actorSeen()).toEqual({ peer: 'in-process' });
	});
});
