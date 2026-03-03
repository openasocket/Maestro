/**
 * TurnTracker — coordinates turn-start and turn-complete signals
 * across IPC handlers for per-turn experience extraction.
 *
 * Acts as a thin event bridge between:
 *   process:write (turn start) → memory-monitor-listener
 *   history:add (turn complete) → memory-monitor-listener
 */
import { EventEmitter } from 'events';
import type { HistoryEntry } from '../../shared/types';

export interface TurnStartEvent {
	sessionId: string;
	timestamp: number;
}

export interface TurnCompleteEvent {
	sessionId: string;
	entry: HistoryEntry;
	turnIndex: number;
	timestamp: number;
}

class TurnTracker extends EventEmitter {
	private turnCounters = new Map<string, number>();

	onTurnStart(sessionId: string): void {
		this.emit('turn-start', { sessionId, timestamp: Date.now() } satisfies TurnStartEvent);
	}

	onTurnComplete(sessionId: string, entry: HistoryEntry): void {
		const count = (this.turnCounters.get(sessionId) ?? 0) + 1;
		this.turnCounters.set(sessionId, count);
		this.emit('turn-complete', {
			sessionId,
			entry,
			turnIndex: count,
			timestamp: Date.now(),
		} satisfies TurnCompleteEvent);
	}

	clearSession(sessionId: string): void {
		this.turnCounters.delete(sessionId);
	}

	getTurnCount(sessionId: string): number {
		return this.turnCounters.get(sessionId) ?? 0;
	}
}

let _instance: TurnTracker | null = null;
export function getTurnTracker(): TurnTracker {
	if (!_instance) _instance = new TurnTracker();
	return _instance;
}
