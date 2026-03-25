/**
 * useTeamOrchStats Hook
 *
 * Custom hook for managing Team Orchestration stats data.
 * Handles fetching aggregated stats via window.maestro.teamOrchStats.getAggregation(),
 * real-time updates subscription via window.maestro.teamOrchStats.onStatsUpdate(),
 * and 1-second debounce on updates to prevent excessive re-renders.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDebouncedCallback } from '../utils/useThrottle';
import type { TeamOrchAggregation, TeamOrchTimeRange } from '../../../shared/team-orch-stats-types';

export interface UseTeamOrchStatsReturn {
	/** Aggregated team orchestration stats data, null if not yet loaded */
	data: TeamOrchAggregation | null;
	/** Loading state for initial fetch */
	loading: boolean;
	/** Error if fetch failed */
	error: Error | null;
	/** Manually trigger a data refresh */
	refresh: () => void;
	/** Whether a manual refresh is in progress */
	refreshing: boolean;
}

/**
 * Hook for fetching and managing Team Orchestration stats data.
 *
 * @param range - Time range for stats aggregation
 * @param enabled - Whether to fetch stats (useful for modal open state)
 * @returns Object containing data, loading, error states and refresh function
 */
export function useTeamOrchStats(
	range: TeamOrchTimeRange,
	enabled: boolean
): UseTeamOrchStatsReturn {
	const [data, setData] = useState<TeamOrchAggregation | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	const mountedRef = useRef(true);

	const fetchStats = useCallback(
		async (isRefresh = false) => {
			if (!enabled) return;

			if (!window.maestro?.teamOrchStats) {
				setError(new Error('Team orchestration stats API not available'));
				setLoading(false);
				return;
			}

			if (isRefresh) {
				setRefreshing(true);
			} else {
				setLoading(true);
			}
			setError(null);

			try {
				const stats = await window.maestro.teamOrchStats.getAggregation(range);
				if (mountedRef.current) {
					setData(stats);
				}
			} catch (err) {
				console.error('Failed to fetch team orchestration stats:', err);
				if (mountedRef.current) {
					setError(err instanceof Error ? err : new Error('Failed to load stats'));
				}
			} finally {
				if (mountedRef.current) {
					setLoading(false);
					if (isRefresh) {
						setTimeout(() => {
							if (mountedRef.current) {
								setRefreshing(false);
							}
						}, 300);
					}
				}
			}
		},
		[range, enabled]
	);

	const refresh = useCallback(() => {
		fetchStats(true);
	}, [fetchStats]);

	const { debouncedCallback: debouncedUpdate, cancel: cancelDebounce } = useDebouncedCallback(
		() => fetchStats(true),
		1000
	);

	useEffect(() => {
		mountedRef.current = true;

		let unsubscribe: (() => void) | undefined;
		if (enabled) {
			fetchStats();
			if (window.maestro?.teamOrchStats?.onStatsUpdate) {
				unsubscribe = window.maestro.teamOrchStats.onStatsUpdate(debouncedUpdate);
			}
		} else {
			setData(null);
			setLoading(false);
			setError(null);
		}

		return () => {
			mountedRef.current = false;
			cancelDebounce();
			unsubscribe?.();
		};
	}, [enabled, fetchStats, debouncedUpdate, cancelDebounce]);

	return useMemo(
		() => ({
			data,
			loading,
			error,
			refresh,
			refreshing,
		}),
		[data, loading, error, refresh, refreshing]
	);
}
