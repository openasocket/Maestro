/**
 * useTeamOrchHistory Hook
 *
 * Custom hook for paginated Team Orchestration event history.
 * Manages filters (topology, status, search), pagination,
 * and data fetching via window.maestro.teamOrchStats.getHistory().
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDebouncedCallback } from '../utils/useThrottle';
import type { TeamOrchEvent } from '../../../shared/team-orch-stats-types';

const DEFAULT_PAGE_SIZE = 20;

export interface UseTeamOrchHistoryReturn {
	events: TeamOrchEvent[];
	total: number;
	loading: boolean;
	error: Error | null;
	page: number;
	pageSize: number;
	setPage: (page: number) => void;
	totalPages: number;
	topologyFilter: string | undefined;
	setTopologyFilter: (filter: string | undefined) => void;
	statusFilter: string | undefined;
	setStatusFilter: (filter: string | undefined) => void;
	searchQuery: string;
	setSearchQuery: (query: string) => void;
	refresh: () => void;
}

/**
 * Hook for paginated Team Orchestration event history with filters.
 *
 * @param enabled - Whether to fetch history (useful for tab active state)
 * @returns Object containing events, pagination state, filter setters, and refresh
 */
export function useTeamOrchHistory(enabled: boolean): UseTeamOrchHistoryReturn {
	const [events, setEvents] = useState<TeamOrchEvent[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [page, setPageState] = useState(0);
	const [pageSize] = useState(DEFAULT_PAGE_SIZE);
	const [topologyFilter, setTopologyFilterState] = useState<string | undefined>(undefined);
	const [statusFilter, setStatusFilterState] = useState<string | undefined>(undefined);
	const [searchQuery, setSearchQueryState] = useState('');
	const [debouncedSearch, setDebouncedSearch] = useState('');

	const mountedRef = useRef(true);

	// Debounce the search query at 300ms
	const { debouncedCallback: debouncedSearchUpdate, cancel: cancelSearchDebounce } =
		useDebouncedCallback(
			((query: string) => {
				setDebouncedSearch(query);
				setPageState(0);
			}) as (...args: unknown[]) => void,
			300
		);

	const setSearchQuery = useCallback(
		(query: string) => {
			setSearchQueryState(query);
			debouncedSearchUpdate(query);
		},
		[debouncedSearchUpdate]
	);

	const setPage = useCallback((p: number) => {
		setPageState(p);
	}, []);

	const setTopologyFilter = useCallback((filter: string | undefined) => {
		setTopologyFilterState(filter);
		setPageState(0);
	}, []);

	const setStatusFilter = useCallback((filter: string | undefined) => {
		setStatusFilterState(filter);
		setPageState(0);
	}, []);

	const fetchHistory = useCallback(async () => {
		if (!enabled) return;

		if (!window.maestro?.teamOrchStats) {
			setError(new Error('Team orchestration stats API not available'));
			return;
		}

		setLoading(true);
		setError(null);

		try {
			const result = await window.maestro.teamOrchStats.getHistory({
				offset: page * pageSize,
				limit: pageSize,
				topologyPattern: topologyFilter,
				status: statusFilter,
				search: debouncedSearch || undefined,
			});
			if (mountedRef.current) {
				setEvents(result.events);
				setTotal(result.total);
			}
		} catch (err) {
			console.error('Failed to fetch team orchestration history:', err);
			if (mountedRef.current) {
				setError(err instanceof Error ? err : new Error('Failed to load history'));
			}
		} finally {
			if (mountedRef.current) {
				setLoading(false);
			}
		}
	}, [enabled, page, pageSize, topologyFilter, statusFilter, debouncedSearch]);

	const refresh = useCallback(() => {
		fetchHistory();
	}, [fetchHistory]);

	useEffect(() => {
		mountedRef.current = true;

		if (enabled) {
			fetchHistory();
		}

		return () => {
			mountedRef.current = false;
			cancelSearchDebounce();
		};
	}, [enabled, fetchHistory, cancelSearchDebounce]);

	return useMemo(
		() => ({
			events,
			total,
			loading,
			error,
			page,
			pageSize,
			setPage,
			totalPages: Math.ceil(total / pageSize),
			topologyFilter,
			setTopologyFilter,
			statusFilter,
			setStatusFilter,
			searchQuery,
			setSearchQuery,
			refresh,
		}),
		[
			events,
			total,
			loading,
			error,
			page,
			pageSize,
			setPage,
			topologyFilter,
			setTopologyFilter,
			statusFilter,
			setStatusFilter,
			searchQuery,
			setSearchQuery,
			refresh,
		]
	);
}
