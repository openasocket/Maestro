/**
 * GRPO process listener.
 * Collects reward signals from query-complete events for the GRPO experience library.
 * Follows the stats-listener pattern: async IIFE for non-blocking fire-and-forget work.
 */
import type { ProcessManager } from '../process-manager';
import type { QueryCompleteData } from '../process-manager/types';
import type { ProcessListenerDependencies } from './types';
import { getSymphonyCollector } from '../grpo/symphony-collector';

/**
 * Sets up the query-complete listener for GRPO signal collection.
 * Records agent query completions as reward signals when GRPO is enabled.
 */
export function setupGRPOListener(
	processManager: ProcessManager,
	deps: Pick<ProcessListenerDependencies, 'logger' | 'getGRPOConfig'>
): void {
	const { logger, getGRPOConfig } = deps;

	processManager.on('query-complete', (_sessionId: string, queryData: QueryCompleteData) => {
		const config = getGRPOConfig();
		if (!config.enabled) return;
		if (!queryData.projectPath) return;

		// Skip GRPO's own rollout sessions to prevent self-referential signal collection
		if (queryData.sessionId?.startsWith('grpo-rollout-')) return;

		const projectPath = queryData.projectPath;

		void (async () => {
			try {
				const collector = getSymphonyCollector(config);
				await collector.onTaskComplete(
					`[process] ${queryData.agentType} query in ${projectPath}`,
					projectPath,
					queryData.agentType,
					queryData.sessionId,
					0, // query-complete implies successful batch exit
					'', // no output captured at this level
					queryData.duration,
					'', // no document path for process-level signals
				);
				logger.debug(`[GRPO] Collected process signal for ${queryData.sessionId}`, '[GRPOListener]');
			} catch (err) {
				logger.warn(`[GRPO] Failed to collect process signal: ${err}`, '[GRPOListener]');
			}
		})();
	});
}
