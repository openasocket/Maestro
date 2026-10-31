import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentSessionIdListener } from '../../../../../renderer/hooks/agent/internal/useAgentSessionIdListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useNotificationStore } from '../../../../../renderer/stores/notificationStore';
import { resetStores } from '../../../../helpers/resetStores';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

let handler: ((sessionId: string, agentSessionId: string) => Promise<void>) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onSessionId: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
		flushNow: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	resetStores(useSessionStore, useNotificationStore);
	(window as any).maestro = {
		...((window as any).maestro || {}),
		process: mockProcess,
		agentSessions: { registerSessionOrigin: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('useAgentSessionIdListener', () => {
	it('captures agent session id on the targeted tab', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.aiTabs[0].awaitingSessionId).toBe(false);
		// Non-claude-code: session-level id is also stamped.
		expect(updated.agentSessionId).toBe('agent-uuid-1');
	});

	it('skips session-level id for claude-code (treats fork ids as throwaway)', async () => {
		const tab = createMockAITab({ id: 'tab-1', awaitingSessionId: true });
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-ai-tab-1', 'agent-uuid-1');

		const updated = useSessionStore.getState().sessions[0];
		expect(updated.aiTabs[0].agentSessionId).toBe('agent-uuid-1');
		expect(updated.agentSessionId).toBeUndefined();
	});

	it('detects resume failure when ID changes on non-claude-code', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'codex',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handler!('sess-1-ai-tab-1', 'new-id');

		// Resume failure → context gauge zeroed
		expect(batched.updateContextUsage).toHaveBeenCalledWith('sess-1', 0);
		const updated = useSessionStore.getState().sessions[0];
		const log = updated.aiTabs[0].logs.find((l) => l.text.includes('resume failed'));
		expect(log).toBeDefined();
	});

	it('keeps original id on claude-code mismatch (silent fork)', async () => {
		const tab = createMockAITab({
			id: 'tab-1',
			agentSessionId: 'old-id',
			awaitingSessionId: true,
		});
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			aiTabs: [tab],
			activeTabId: 'tab-1',
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
		await handler!('sess-1-ai-tab-1', 'fork-id');

		expect(batched.updateContextUsage).not.toHaveBeenCalled();
		expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBe('old-id');
	});

	it('ignores batch session ids', async () => {
		const session = createMockSession({ id: 'sess-1' });
		useSessionStore.setState({ sessions: [session] } as any);

		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('sess-1-batch-tab-1', 'agent-uuid-1');

		expect(useSessionStore.getState().sessions[0].agentSessionId).toBeUndefined();
	});

	it('skips no-op render when session is missing', async () => {
		const setSessionsSpy = vi.spyOn(useSessionStore.getState(), 'setSessions');
		renderHook(() => useAgentSessionIdListener({ batchedUpdater: makeBatched() }));
		await handler!('missing-ai-tab-1', 'agent-uuid-1');
		// No session found - nothing to update, so the store setter is never invoked at all.
		expect(setSessionsSpy).not.toHaveBeenCalled();
		const sessions = useSessionStore.getState().sessions;
		expect(sessions).toEqual([]);
	});

	describe('Grok native identity retention', () => {
		// Both transports deliver the same renderer event; this does not certify ACP routing.
		it.each([
			{ phase: 'native end-only', settled: true, delivered: true },
			{ phase: 'ACP announced allocation', settled: false, delivered: true },
			{ phase: 'confirmed allocation after cancellation', settled: true, delivered: true },
			{ phase: 'cancelled turn with no ID event', settled: true, delivered: false },
		])('retains only observed IDs: $phase', async ({ settled, delivered }) => {
			const tab = createMockAITab({
				id: 'target',
				name: 'New Session',
				turnProvider: 'grok',
				state: 'busy',
				awaitingSessionId: true,
			});
			const active = createMockAITab({ id: 'active', awaitingSessionId: true });
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				state: 'busy',
				aiTabs: [tab, active],
				activeTabId: active.id,
			});
			useSessionStore.setState({ sessions: [session] });
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			expect(useSessionStore.getState().sessions[0].aiTabs[0].agentSessionId).toBeNull();
			await act(async () => {
				if (settled)
					useSessionStore.setState({
						sessions: [
							{
								...session,
								state: 'idle',
								aiTabs: [{ ...tab, state: 'idle' }, active],
							},
						],
					});
				if (delivered) await handler!('sess-1-ai-target', 'native-observed');
			});
			const updated = useSessionStore.getState().sessions[0];
			expect(updated.aiTabs[0]).toMatchObject({
				agentSessionId: delivered ? 'native-observed' : null,
				awaitingSessionId: !delivered,
				name: delivered ? null : 'New Session',
				state: settled ? 'idle' : 'busy',
			});
			expect(updated.aiTabs[1]).toBe(active);
			expect(updated.activeTabId).toBe(active.id);
			expect(updated.agentSessionId).toBeUndefined();
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([
			['legacy tabless target', 'sess-1-ai', 'native-observed'],
			['bare agent target', 'sess-1', 'native-observed'],
			['missing tab', 'sess-1-ai-missing', 'native-observed'],
			['closed tab', 'sess-1-ai-closed', 'native-observed'],
			['empty ID', 'sess-1-ai-active', ''],
			['whitespace ID', 'sess-1-ai-active', ' \t\n'],
		])('ignores %s without assigning an active/session fallback', async (kind, target, id) => {
			const active = createMockAITab({ id: 'active', awaitingSessionId: true });
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				aiTabs: [active],
				activeTabId: active.id,
			});
			useSessionStore.setState({
				sessions: [
					{
						...session,
						aiTabs: [active, ...(kind === 'closed tab' ? [createMockAITab({ id: 'closed' })] : [])],
					},
				],
			});
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			await act(async () => {
				useSessionStore.setState({ sessions: [session] });
				await handler!(target, id);
			});
			expect(useSessionStore.getState().sessions[0]).toBe(session);
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([false, true])(
			'rejects a replacement ID without losing evidence (parked=%s)',
			async (parked) => {
				const usage = {
					inputTokens: 120,
					outputTokens: 30,
					cacheReadInputTokens: 40,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.25,
					contextWindow: 1000,
				};
				const tab = createMockAITab({
					id: 'target',
					turnProvider: 'grok',
					awaitingSessionId: true,
					agentSessionId: parked ? 'incoming-native' : 'original-native',
					usageStats: usage,
					pendingMergedContext: 'retained context',
					logs: [{ id: 'history', timestamp: 1, source: 'user', text: 'original history' }],
					providerSessions: parked
						? {
								grok: {
									agentSessionId: 'original-native',
									usageStats: usage,
									customModel: 'grok-model',
								},
							}
						: undefined,
				});
				const active = createMockAITab({ id: 'active', agentSessionId: 'other-native' });
				const session = createMockSession({
					id: 'sess-1',
					toolType: parked ? 'codex' : 'grok',
					state: 'busy',
					agentSessionId: 'session-retained',
					contextUsage: 63,
					aiTabs: [tab, active],
					activeTabId: active.id,
				});
				useSessionStore.setState({ sessions: [session] });
				const batched = makeBatched();
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
				await act(async () => {
					await handler!('sess-1-ai-target', 'replacement-native');
				});
				const updated = useSessionStore.getState().sessions[0];
				const target = updated.aiTabs[0];
				expect(target.agentSessionId).toBe(tab.agentSessionId);
				expect(target.providerSessions).toEqual(tab.providerSessions);
				expect(target.usageStats).toEqual(usage);
				expect(target.pendingMergedContext).toBe(tab.pendingMergedContext);
				expect(target.logs.slice(0, -1)).toEqual(tab.logs);
				expect(target.logs).toHaveLength(2);
				expect(target.logs[1]).toMatchObject({
					source: 'error',
					agentError: {
						type: 'session_not_found',
						agentId: 'grok',
						recoverable: false,
						sessionId: 'sess-1-ai-target',
						message: expect.stringContaining('original session ID and history were retained'),
					},
				});
				expect(updated.aiTabs[1]).toBe(active);
				expect(updated.activeTabId).toBe(active.id);
				expect(updated.agentSessionId).toBe('session-retained');
				expect(updated.contextUsage).toBe(63);
				expect(updated.state).toBe(parked ? 'busy' : 'error');
				expect(updated.agentError).toEqual(parked ? undefined : target.logs[1].agentError);
				expect(updated.agentErrorTabId).toBe(parked ? undefined : tab.id);
				expect(updated.agentErrorPaused).toBe(parked ? undefined : true);
				expect(target.agentError).toEqual(parked ? undefined : target.logs[1].agentError);
				expect(target.awaitingSessionId).toBe(parked);
				expect(batched.updateContextUsage).not.toHaveBeenCalled();
				expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
				expect(useNotificationStore.getState().toasts).toEqual([
					expect.objectContaining({
						color: 'yellow',
						title: 'Grok Session Resume Failed',
						sessionId: 'sess-1',
						message: expect.stringContaining('original session ID and history were retained'),
					}),
				]);
			}
		);

		it('accepts a matching ID again without renaming the retained conversation', async () => {
			const tab = createMockAITab({
				id: 'target',
				name: 'My Grok history',
				agentSessionId: 'native-observed',
				turnProvider: 'grok',
				awaitingSessionId: true,
			});
			const session = createMockSession({
				id: 'sess-1',
				toolType: 'grok',
				aiTabs: [tab],
				activeTabId: tab.id,
			});
			useSessionStore.setState({ sessions: [session] });
			const batched = makeBatched();
			renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
			await act(async () => {
				await handler!('sess-1-ai-target', 'native-observed');
				await handler!('sess-1-ai-target', 'native-observed');
			});
			expect(useSessionStore.getState().sessions[0]).toEqual({
				...session,
				aiTabs: [{ ...tab, awaitingSessionId: false }],
			});
			expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
			expect(batched.updateContextUsage).not.toHaveBeenCalled();
			expect(useNotificationStore.getState().toasts).toEqual([]);
		});

		it.each([null, 'native-observed'])(
			'parks an observed ID after a switch (retained=%s)',
			async (retained) => {
				const tab = createMockAITab({
					id: 'target',
					turnProvider: 'grok',
					agentSessionId: 'incoming-native',
					name: 'Incoming conversation',
					awaitingSessionId: true,
					providerSessions: { grok: { agentSessionId: retained, customModel: 'grok-model' } },
				});
				const session = createMockSession({
					id: 'sess-1',
					toolType: 'codex',
					state: 'busy',
					aiTabs: [tab],
					activeTabId: tab.id,
					agentSessionId: 'incoming-session',
					contextUsage: 63,
				});
				useSessionStore.setState({ sessions: [session] });
				const batched = makeBatched();
				renderHook(() => useAgentSessionIdListener({ batchedUpdater: batched }));
				await act(async () => {
					await handler!('sess-1-ai-target', 'native-observed');
				});
				expect(useSessionStore.getState().sessions[0]).toEqual({
					...session,
					aiTabs: [
						{
							...tab,
							providerSessions: {
								grok: { agentSessionId: 'native-observed', customModel: 'grok-model' },
							},
						},
					],
				});
				expect(window.maestro.agentSessions.registerSessionOrigin).not.toHaveBeenCalled();
				expect(batched.updateContextUsage).not.toHaveBeenCalled();
				expect(useNotificationStore.getState().toasts).toEqual([]);
			}
		);
	});
});
