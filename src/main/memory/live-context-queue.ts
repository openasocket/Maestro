/**
 * Live Context Queue — stub module for EXP-LIVE-01.
 *
 * This module will be fully implemented by EXP-LIVE-01.
 * It manages a per-session queue of memory content that gets injected
 * into the agent's context on the next user write.
 *
 * EXP-LIVE-02 (memory-monitor-listener) enqueues results here.
 */

export interface LiveContextQueue {
	/** Enqueue memory content for mid-session injection */
	enqueue(
		sessionId: string,
		content: string,
		source: 'monitoring' | 'manual',
		tokenEstimate: number,
		memoryIds: string[]
	): void;

	/** Get the number of user writes tracked for a session */
	getWriteCount(sessionId: string): number;
}

let instance: LiveContextQueue | null = null;

/**
 * Get the singleton LiveContextQueue instance.
 * Returns a no-op stub until EXP-LIVE-01 provides the real implementation.
 */
export function getLiveContextQueue(): LiveContextQueue {
	if (!instance) {
		instance = {
			enqueue: () => {},
			getWriteCount: () => 0,
		};
	}
	return instance;
}
