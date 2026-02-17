/**
 * useGRPOStats Hook
 *
 * Custom hook for fetching GRPO training statistics for the current project.
 * Handles loading/error states, initial fetch on mount, and automatic polling
 * during active training (every 5 seconds when currentEpoch > 0).
 *
 * Features:
 * - Loading and error states
 * - Automatic polling during active training
 * - Manual refresh callback
 * - Memoized return value for stable references
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { GRPOStats } from '../../../shared/grpo-types';

/** Training status as reported by the auto-trainer */
export type TrainingStatus = 'idle' | 'running' | 'complete' | 'error';

export interface UseGRPOStatsReturn {
	/** GRPO stats data, null if not yet loaded */
	stats: GRPOStats | null;
	/** Loading state for initial fetch */
	loading: boolean;
	/** Error message if fetch failed */
	error: string | null;
	/** Manually trigger a data refresh */
	refresh: () => void;
	/** Current training status from auto-trainer events */
	trainingStatus: TrainingStatus;
}

/** Polling interval during active training (ms) */
const ACTIVE_POLL_INTERVAL = 5000;

/**
 * Hook for fetching GRPO training statistics for the current project.
 *
 * @param projectPath - The project path to fetch stats for, or null if unavailable
 * @returns Object containing stats data, loading/error states, and refresh function
 */
export function useGRPOStats(projectPath: string | null): UseGRPOStatsReturn {
	const [stats, setStats] = useState<GRPOStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [trainingStatus, setTrainingStatus] = useState<TrainingStatus>('idle');

	const mountedRef = useRef(true);

	const fetchStats = useCallback(async () => {
		if (!projectPath) {
			setStats(null);
			setLoading(false);
			return;
		}

		setError(null);

		try {
			const result = await window.maestro.grpo.getStats(projectPath);
			if (!mountedRef.current) return;

			if (result.success && result.data) {
				setStats(result.data as GRPOStats);
			} else {
				setError(result.error || 'Failed to load GRPO stats');
			}
		} catch (err) {
			console.error('Failed to fetch GRPO stats:', err);
			if (mountedRef.current) {
				setError(err instanceof Error ? err.message : 'Failed to load GRPO stats');
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, [projectPath]);

	const refresh = useCallback(() => {
		fetchStats();
	}, [fetchStats]);

	// Initial fetch
	useEffect(() => {
		mountedRef.current = true;
		setLoading(true);
		fetchStats();
		return () => {
			mountedRef.current = false;
		};
	}, [fetchStats]);

	// Poll during active training (currentEpoch > 0)
	useEffect(() => {
		if (!stats || stats.currentEpoch <= 0) return;

		const intervalId = setInterval(() => {
			fetchStats();
		}, ACTIVE_POLL_INTERVAL);

		return () => {
			clearInterval(intervalId);
		};
	}, [stats?.currentEpoch, fetchStats]);

	// Listen for training status events from auto-trainer
	useEffect(() => {
		const cleanup = window.maestro.grpo.onTrainingStatus((status) => {
			if (!mountedRef.current) return;
			const s = status.status as TrainingStatus;
			setTrainingStatus(s);

			// Auto-reset to idle after 3 seconds when training completes
			if (s === 'complete' || s === 'error') {
				// Refresh stats after training completes (new experiences may have been added)
				fetchStats();
				const timer = setTimeout(() => {
					if (mountedRef.current) {
						setTrainingStatus('idle');
					}
				}, 3000);
				return () => clearTimeout(timer);
			}
		});
		return cleanup;
	}, [fetchStats]);

	return useMemo(
		() => ({
			stats,
			loading,
			error,
			refresh,
			trainingStatus,
		}),
		[stats, loading, error, refresh, trainingStatus]
	);
}
