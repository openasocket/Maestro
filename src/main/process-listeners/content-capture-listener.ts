/**
 * Managed content capture: the process listener (MRC-10-05A).
 *
 * The one place the enterprise content capture (`src/main/enterprise/content.ts`)
 * meets a running process. It hears three events of the process manager:
 *
 *   `spawn`         a process started: the prompt it was given is `user.prompt`
 *   `parsed-event`  a process printed one parsed line: an answer is
 *                   `assistant.output`, a tool call is `tool.input`
 *   `exit`          a process ended
 *
 * What it guarantees:
 * - It hears `parsed-event` only while a process it follows is running, and it
 *   follows a process only when the collection standing admitted capture at
 *   its spawn. The process manager emits that event only when something
 *   listens, so a standalone desktop, a metadata profile or a refused standing
 *   costs a line of output nothing here.
 * - Every capture is decided again by the standing at that moment: a standing
 *   that lapses mid-turn refuses the next line by name, nothing is kept on the
 *   strength of the spawn-time answer.
 * - It reads the spawn config and never changes it; a turn spawns byte for
 *   byte the same with capture on or off.
 * - Nothing here throws into the process manager, and nothing here reads the
 *   private per-agent recording or its configuration.
 */

import type { ProcessManager } from '../process-manager';
import type { ProcessConfig } from '../process-manager/types';
import type { ParsedEvent } from '../parsers/agent-output-parser';
import { lifecycleSurfaceOf, spawnLifecycleLineage } from '../agent-run/capture-service';
import { resolveOwningMaestroSessionId } from '../coworking/coworking-session-id';
import type { ContentCapture, ContentCollectionSource, ContentRole } from '../enterprise/content';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ProcessListeners';

/** The provider-visible content a parsed line carries, by role; null for a line that is none (init, usage, system, an error). */
export function contentOfParsedEvent(
	event: ParsedEvent
): { role: ContentRole; text: string; toolName: string | null } | null {
	if ((event.type === 'text' || event.type === 'result') && typeof event.text === 'string') {
		return event.text.length > 0
			? { role: 'assistant.output', text: event.text, toolName: null }
			: null;
	}
	if (event.type === 'tool_use' && typeof event.toolName === 'string') {
		// The call as the provider showed it: the tool and its state. Never the result.
		return {
			role: 'tool.input',
			text: JSON.stringify({ toolName: event.toolName, toolState: event.toolState ?? null }),
			toolName: event.toolName,
		};
	}
	return null;
}

export interface ContentCaptureListenerDeps {
	source: Pick<ContentCollectionSource, 'standing'>;
	capture: Pick<ContentCapture, 'capture'>;
}

/** What a followed process is captured as, fixed at its spawn. */
interface Followed {
	agentId: string;
	tabId: string | null;
	provider: string;
	runId: string | null;
}

export interface ContentCaptureListener {
	/** Processes being followed right now. */
	following(): number;
	/** Detach from the process manager. */
	dispose(): void;
}

export function setupContentCaptureListener(
	processManager: ProcessManager,
	deps: ContentCaptureListenerDeps
): ContentCaptureListener {
	const followed = new Map<string, Followed>();
	let listening = false;

	const guarded =
		<Args extends unknown[]>(handler: (...args: Args) => void) =>
		(...args: Args): void => {
			try {
				handler(...args);
			} catch (error) {
				logger.warn('A content capture listener step failed', LOG_CONTEXT, {
					error: error instanceof Error ? error.name : typeof error,
				});
			}
		};

	const onParsedEvent = guarded((sessionId: string, event: ParsedEvent) => {
		const bound = followed.get(sessionId);
		if (!bound) return;
		const content = contentOfParsedEvent(event);
		if (!content) return;
		deps.capture.capture({
			role: content.role,
			text: content.text,
			sessionId,
			...bound,
			toolName: content.toolName,
			parentToolCallId: event.parentToolUseId ?? null,
		});
	});

	const follow = (on: boolean): void => {
		if (on === listening) return;
		listening = on;
		if (on) processManager.on('parsed-event', onParsedEvent);
		else processManager.off('parsed-event', onParsedEvent);
	};

	const onSpawn = guarded((config: ProcessConfig) => {
		if (!config?.sessionId || lifecycleSurfaceOf(config.sessionId) !== 'agent') return;
		const standing = deps.source.standing();
		if (standing.mode !== 'managed' || !standing.ok) return;
		const bound: Followed = {
			agentId: resolveOwningMaestroSessionId(config.sessionId),
			tabId: config.tabId ?? null,
			provider: config.toolType,
			runId: spawnLifecycleLineage(config)?.identity.runId ?? null,
		};
		followed.set(config.sessionId, bound);
		follow(true);
		if (typeof config.prompt === 'string' && config.prompt.length > 0) {
			deps.capture.capture({
				role: 'user.prompt',
				text: config.prompt,
				sessionId: config.sessionId,
				...bound,
			});
		}
	});

	const onExit = guarded((sessionId: string) => {
		followed.delete(sessionId);
		if (followed.size === 0) follow(false);
	});

	processManager.on('spawn', onSpawn);
	processManager.on('exit', onExit);

	return {
		following: () => followed.size,
		dispose() {
			processManager.off('spawn', onSpawn);
			processManager.off('exit', onExit);
			followed.clear();
			follow(false);
		},
	};
}
