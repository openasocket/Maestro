/**
 * AiTabManagedRun - the managed run state of one AI tab, mounted above the
 * composer in the AI Terminal (MCOMP-25-02A).
 *
 * Feeds `<ManagedRunState>` from the tab itself: `AITab.managedRun` (the run
 * the tab's last send started), `AITab.managedRefusal` (the host's refusal of
 * it), the tab's busy state and the host standing. A standalone host records
 * neither on a tab, so this returns before any hook runs: an unmanaged Maestro
 * draws nothing here and polls nothing.
 *
 * The actions it wires, and nothing else:
 * - `stop` goes through `interruptTurn()` for this tab, the same stop as the
 *   Stop pill; the sink releases the lease as stopped.
 * - `retry` queues the tab's last user message again through the execution
 *   queue and starts it when the tab is free. It is an ordinary send, so the
 *   host admits it again under the policy in force now; nothing resends on its
 *   own. Drawn only when the tab has a message to send.
 * - `refreshPolicy` asks the endpoint through `useManagedStatus().run()`.
 */

import { useCallback, useMemo } from 'react';
import type { AITab, LogEntry, Theme } from '../../types';
import { useManagedStatus, type ManagedRunAction } from '../../hooks/enterprise/useManagedStatus';
import { FORCE_KILL_PROMPT, interruptTurn } from '../../services/turnInterrupt';
import { enqueuePromptForTab, sendQueuedItemNow } from '../../services/queuedPrompt';
import { notifyToast } from '../../stores/notificationStore';
import { ManagedRunState } from './ManagedRunState';

export const AI_TAB_MANAGED_RUN_COPY = {
	retryFailed: 'Could not send the turn again',
	retryNoTab: 'The tab is gone, so there is nothing to send again.',
	policyTitle: 'Managed policy',
} as const;

type HandledAction = Exclude<ManagedRunAction, 'refresh'>;

export interface AiTabManagedRunProps {
	theme: Theme;
	sessionId: string;
	tab: AITab;
}

/** The last thing the user sent on this tab, as the queue takes it back. */
export function lastUserTurnOf(
	tab: Pick<AITab, 'logs'>
): { text: string; images?: string[]; slashCommand?: boolean } | null {
	for (let i = tab.logs.length - 1; i >= 0; i--) {
		const entry: LogEntry = tab.logs[i];
		if (entry.source !== 'user') continue;
		if (entry.aiCommand?.command) return { text: entry.aiCommand.command, slashCommand: true };
		if (!entry.text.trim() && !entry.images?.length) continue;
		return {
			text: entry.text,
			...(entry.images?.length ? { images: [...entry.images] } : {}),
		};
	}
	return null;
}

export function AiTabManagedRun({ theme, sessionId, tab }: AiTabManagedRunProps) {
	if (!tab.managedRun && !tab.managedRefusal) return null;
	return <AiTabManagedRunBody theme={theme} sessionId={sessionId} tab={tab} />;
}

function AiTabManagedRunBody({ theme, sessionId, tab }: AiTabManagedRunProps) {
	const status = useManagedStatus();
	const { run: runVerb } = status;
	const lastTurn = useMemo(() => lastUserTurnOf(tab), [tab]);
	const handles = useMemo<HandledAction[]>(
		() => (lastTurn ? ['stop', 'retry', 'refreshPolicy'] : ['stop', 'refreshPolicy']),
		[lastTurn]
	);
	const tabId = tab.id;

	const onAction = useCallback(
		async (action: HandledAction) => {
			if (action === 'stop') {
				await interruptTurn(sessionId, {
					tabId,
					confirmForceKill: () => confirm(FORCE_KILL_PROMPT),
				});
				return;
			}
			if (action === 'retry') {
				if (!lastTurn) return;
				const item = enqueuePromptForTab({ sessionId, tabId, ...lastTurn });
				if (!item) {
					notifyToast({
						color: 'red',
						title: AI_TAB_MANAGED_RUN_COPY.retryFailed,
						message: AI_TAB_MANAGED_RUN_COPY.retryNoTab,
					});
					return;
				}
				// Started now when the tab is free; otherwise it waits its turn in the queue.
				sendQueuedItemNow(sessionId, item.id);
				return;
			}
			const outcome = await runVerb('refreshPolicy');
			notifyToast({
				color: outcome.status === 'ok' ? 'green' : 'yellow',
				title: AI_TAB_MANAGED_RUN_COPY.policyTitle,
				message: outcome.message,
			});
		},
		[sessionId, tabId, lastTurn, runVerb]
	);

	return (
		<div className="px-4 pt-2" data-testid="ai-tab-managed-run">
			<ManagedRunState
				theme={theme}
				run={tab.managedRun}
				busy={tab.state === 'busy'}
				standing={status.state}
				refusal={tab.managedRefusal ?? null}
				onAction={onAction}
				handles={handles}
			/>
		</div>
	);
}
