/**
 * useVibesInsights Hook
 *
 * Subscribes to the `vibes:activity-feed` IPC event for real-time activity
 * feed events. Maintains a circular buffer of the last 50 events, filtered
 * by the active session ID (including its subagent sessions).
 *
 * Returns empty array when disabled (zero overhead — no IPC subscription).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { VibesActivityFeedEvent } from '../../shared/vibes-types';

// ============================================================================
// Constants
// ============================================================================

const MAX_BUFFER_SIZE = 50;

// ============================================================================
// Types
// ============================================================================

export interface UseVibesInsightsReturn {
	events: VibesActivityFeedEvent[];
	isEnabled: boolean;
	clear: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Subscribes to real-time VIBES activity feed events via IPC.
 *
 * @param sessionId - The active Maestro session ID to filter events for.
 * @param enabled - Whether the feed is active (tied to vibesInsightsEnabled setting).
 *
 * @example
 * ```tsx
 * const { events, clear } = useVibesInsights(activeSessionId, vibesInsightsEnabled);
 * ```
 */
export function useVibesInsights(
	sessionId: string | undefined,
	enabled: boolean
): UseVibesInsightsReturn {
	const [events, setEvents] = useState<VibesActivityFeedEvent[]>([]);
	const mountedRef = useRef(true);
	const sessionIdRef = useRef(sessionId);

	// Track known subagent session IDs for this parent session
	const knownSessionIds = useRef<Set<string>>(new Set());

	// Keep sessionIdRef current
	useEffect(() => {
		sessionIdRef.current = sessionId;
	}, [sessionId]);

	// Clear events and known sessions when session changes
	useEffect(() => {
		setEvents([]);
		knownSessionIds.current = new Set();
		if (sessionId) {
			knownSessionIds.current.add(sessionId);
		}
	}, [sessionId]);

	// Subscribe to activity feed events
	useEffect(() => {
		mountedRef.current = true;

		if (!enabled || !sessionId) {
			return;
		}

		if (!window.maestro?.vibes?.onActivityFeed) return;

		const cleanup = window.maestro.vibes.onActivityFeed((event: VibesActivityFeedEvent) => {
			if (!mountedRef.current) return;

			const currentSessionId = sessionIdRef.current;
			if (!currentSessionId) return;

			// Track subagent session IDs via delegation events
			if (event.category === 'delegation' && event.detail?.childSessionId) {
				if (event.sessionId === currentSessionId || knownSessionIds.current.has(event.sessionId)) {
					knownSessionIds.current.add(event.detail.childSessionId);
				}
			}

			// Filter: only events for this session or its known subagents
			if (event.sessionId !== currentSessionId && !knownSessionIds.current.has(event.sessionId)) {
				return;
			}

			setEvents((prev) => {
				const next = [...prev, event];
				// Circular buffer: keep last MAX_BUFFER_SIZE events
				if (next.length > MAX_BUFFER_SIZE) {
					return next.slice(next.length - MAX_BUFFER_SIZE);
				}
				return next;
			});
		});

		return () => {
			mountedRef.current = false;
			cleanup();
		};
	}, [enabled, sessionId]);

	const clear = useCallback(() => {
		setEvents([]);
	}, []);

	return useMemo(() => ({ events, isEnabled: enabled, clear }), [events, enabled, clear]);
}
