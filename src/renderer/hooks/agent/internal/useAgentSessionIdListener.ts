/**
 * useAgentSessionIdListener - registers `window.maestro.process.onSessionId`
 *
 * Captures provider session IDs at tab and (for non-claude-code agents)
 * session level. Detects resume failure when an existing tab receives a
 * different ID and surfaces a yellow toast + system log; updates the
 * context gauge to zero so the user can see the reset.
 *
 * Special case: claude-code emits fresh fork IDs on every spawn that have
 * no backing JSONL - for that agent the original tab ID is treated as
 * immutable and the session-level field is never written. Grok likewise owns
 * one native ID per tab: a different returned ID is a failed resume, never a
 * replacement conversation. Its IDs require an explicit, existing tab target.
 */

import { useEffect } from 'react';
import { updateSessionWith, useSessionStore } from '../../../stores/sessionStore';
import { notifyToast } from '../../../stores/notificationStore';
import { parseSessionId, isBatchSession } from '../../../utils/sessionIdParser';
import { getActiveTab } from '../../../utils/tabHelpers';
import { resolveTurnProvider, updateProviderSlot } from '../../../utils/providerTabSessions';
import { generateId } from '../../../utils/ids';
import { logger } from '../../../utils/logger';
import { useOwnedSideEffectGate } from './useOwnedSessionGate';
import type { AgentError, LogEntry } from '../../../types';
import type { BatchedUpdater } from './types';

export interface UseAgentSessionIdListenerDeps {
	batchedUpdater: BatchedUpdater;
}

export function useAgentSessionIdListener(deps: UseAgentSessionIdListenerDeps): void {
	const ownedGate = useOwnedSideEffectGate();
	useEffect(() => {
		const unsubscribe = window.maestro.process.onSessionId(
			async (sessionId: string, agentSessionId: string) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				if (isBatchSession(sessionId)) return;

				const parsed = parseSessionId(sessionId);
				const actualSessionId = parsed.actualSessionId;
				const tabId = parsed.tabId ?? undefined;

				let resumeFailureDetected = false;
				let grokResumeFailure = false;

				const session = useSessionStore.getState().sessions.find((s) => s.id === actualSessionId);
				if (session) {
					const eventTab = session.aiTabs?.find((tab) => tab.id === tabId);
					const isGrokEvent = resolveTurnProvider(eventTab, session) === 'grok';
					// Grok's late native end (or ACP allocation) belongs to the named tab,
					// never whichever tab is active when the event reaches the renderer.
					if (isGrokEvent && (!tabId || !eventTab || !agentSessionId.trim())) {
						logger.warn('[onSessionId] Ignoring Grok identity without a valid tab and native ID');
						return;
					}
					// This legacy bridge writes Claude's origin index, not Grok history.
					if (!isGrokEvent)
						window.maestro.agentSessions
							.registerSessionOrigin(session.projectRoot, agentSessionId, 'user')
							.catch((err) =>
								logger.error('[onSessionId] Failed to register session origin:', undefined, err)
							);

					updateSessionWith(actualSessionId, (s) => {
						// Claude Code 2.1.x in batch mode emits a fresh `session_id` on every spawn -
						// but never writes a JSONL file under that fresh ID; the conversation
						// continues to be appended to the original JSONL. Storing the fork ID and
						// using it on the next spawn produces "no conversation found with session id"
						// because the file does not exist. So once a claude-code tab/session has an
						// agentSessionId, treat it as immutable and ignore subsequent fork IDs.
						const isClaudeCode = s.toolType === 'claude-code';

						let targetTab;
						if (tabId) {
							targetTab = s.aiTabs?.find((tab) => tab.id === tabId);
							if (!targetTab) {
								logger.info(
									'[onSessionId] Tab was closed, storing session ID at session level only:',
									undefined,
									{
										tabId: tabId.substring(0, 8),
										agentSessionId: agentSessionId.substring(0, 8),
									}
								);
								return isClaudeCode ? s : { ...s, agentSessionId };
							}
						}

						if (!targetTab) {
							const awaitingTab = s.aiTabs?.find(
								(tab) => tab.awaitingSessionId && !tab.agentSessionId
							);
							targetTab = awaitingTab || getActiveTab(s);
						}

						if (!targetTab) {
							logger.error(
								'[onSessionId] No target tab found - session has no aiTabs, storing at session level only'
							);
							return isClaudeCode ? s : { ...s, agentSessionId };
						}

						// Settings are codified at send, so this ID belongs to the provider
						// that STARTED the turn. If the user changed the agent's provider while
						// it ran, the live slot now belongs to the incoming provider and this
						// token would be a resume target the new provider has never heard of -
						// park it under its real owner instead.
						const owningProvider = resolveTurnProvider(targetTab, s);
						const isStaleProvider = owningProvider !== s.toolType;
						if (owningProvider === 'grok') {
							const retained = isStaleProvider
								? targetTab.providerSessions?.grok?.agentSessionId
								: targetTab.agentSessionId;
							if (retained && retained !== agentSessionId) {
								grokResumeFailure = true;
								const error: AgentError = {
									type: 'session_not_found',
									agentId: 'grok',
									sessionId,
									timestamp: Date.now(),
									recoverable: false,
									message:
										'Grok returned a different session ID while resuming. The original session ID and history were retained. Check the selected account and host before retrying.',
								};
								const log: LogEntry = {
									id: generateId(),
									timestamp: error.timestamp,
									source: 'error',
									text: error.message,
									agentError: error,
								};
								return {
									...s,
									...(!isStaleProvider && {
										agentError: error,
										agentErrorTabId: targetTab.id,
										agentErrorPaused: true,
										state: 'error' as const,
									}),
									aiTabs: s.aiTabs.map((tab) =>
										tab.id === targetTab.id
											? {
													...tab,
													...(!isStaleProvider && { awaitingSessionId: false, agentError: error }),
													logs: [...tab.logs, log],
												}
											: tab
									),
								};
							}
							return {
								...s,
								aiTabs: s.aiTabs.map((tab) =>
									tab.id === targetTab.id
										? {
												...updateProviderSlot(tab, s, owningProvider, { agentSessionId }),
												...(!isStaleProvider && {
													awaitingSessionId: false,
													name: tab.name && tab.name !== 'New Session' ? tab.name : null,
												}),
											}
										: tab
								),
							};
						}
						if (isStaleProvider) {
							logger.info(
								'[onSessionId] Session ID arrived for a provider the agent has since switched away from - parking it',
								undefined,
								{
									owningProvider,
									currentProvider: s.toolType,
									tabId: targetTab.id,
									agentSessionId: agentSessionId.substring(0, 8),
								}
							);
							const updatedAiTabs = s.aiTabs.map((tab) =>
								tab.id === targetTab.id
									? updateProviderSlot(tab, s, owningProvider, { agentSessionId })
									: tab
							);
							// The session-level field tracks the CURRENT provider, so it is left
							// alone here for the same reason.
							return { ...s, aiTabs: updatedAiTabs };
						}

						if (targetTab.agentSessionId && targetTab.agentSessionId !== agentSessionId) {
							if (isClaudeCode) {
								const updatedAiTabs = s.aiTabs.map((tab) => {
									if (tab.id !== targetTab.id) return tab;
									return { ...tab, awaitingSessionId: false };
								});
								return { ...s, aiTabs: updatedAiTabs };
							}

							logger.warn(
								'[onSessionId] Session resume failed - agent returned a new session ID',
								undefined,
								{
									expected: targetTab.agentSessionId,
									received: agentSessionId,
									tabId: targetTab.id,
									sessionId: actualSessionId,
								}
							);

							resumeFailureDetected = true;

							const resumeFailLog: LogEntry = {
								id: generateId(),
								timestamp: Date.now(),
								source: 'system',
								text: '⚠️ Session resume failed - agent started a new session. Previous context was lost.',
							};

							const updatedAiTabs = s.aiTabs.map((tab) => {
								if (tab.id !== targetTab.id) return tab;
								return {
									...tab,
									agentSessionId,
									awaitingSessionId: false,
									usageStats: undefined,
									logs: [...tab.logs, resumeFailLog],
								};
							});

							return { ...s, aiTabs: updatedAiTabs, agentSessionId };
						}

						const updatedAiTabs = s.aiTabs.map((tab) => {
							if (tab.id !== targetTab.id) return tab;
							const newName = tab.name && tab.name !== 'New Session' ? tab.name : null;
							return {
								...tab,
								agentSessionId,
								awaitingSessionId: false,
								name: newName,
							};
						});

						return isClaudeCode
							? { ...s, aiTabs: updatedAiTabs }
							: { ...s, aiTabs: updatedAiTabs, agentSessionId };
					});
				}

				if (grokResumeFailure) {
					notifyToast({
						color: 'yellow',
						title: 'Grok Session Resume Failed',
						message:
							'The original session ID and history were retained. Check the selected account and host.',
						sessionId: actualSessionId,
					});
				}
				if (resumeFailureDetected) {
					deps.batchedUpdater.updateContextUsage(actualSessionId, 0);
					notifyToast({
						color: 'yellow',
						title: 'Session Resume Failed',
						message: 'Agent started a new session. Previous context was lost.',
						sessionId: actualSessionId,
					});
				}
			}
		);

		return () => {
			unsubscribe();
		};
	}, [deps.batchedUpdater, ownedGate]);
}
