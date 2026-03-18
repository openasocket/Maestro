/**
 * Tests for useVibesInsights hook
 *
 * Tests cover:
 * - Subscribes to onActivityFeed when enabled
 * - Does not subscribe when disabled
 * - Filters events by active session ID
 * - Tracks subagent session IDs via delegation events
 * - Maintains circular buffer of last 50 events
 * - Clears events on session change
 * - Returns empty array when disabled (zero overhead)
 * - clear() empties the events array
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useVibesInsights } from '../../../renderer/hooks/useVibesInsights';
import type { VibesActivityFeedEvent } from '../../../shared/vibes-types';

// ============================================================================
// Helpers
// ============================================================================

function createEvent(overrides: Partial<VibesActivityFeedEvent> = {}): VibesActivityFeedEvent {
	return {
		sessionId: 'session-1',
		vibesSessionId: 'vibes-session-1',
		category: 'tool',
		summary: 'Tool: Write → src/main/index.ts',
		timestamp: new Date().toISOString(),
		isSubagent: false,
		depth: 0,
		...overrides,
	};
}

// ============================================================================
// Mock Setup
// ============================================================================

let feedCallback: ((event: VibesActivityFeedEvent) => void) | null = null;
let cleanupFn: ReturnType<typeof vi.fn>;

beforeEach(() => {
	feedCallback = null;
	cleanupFn = vi.fn();

	// Ensure window.maestro.vibes.onActivityFeed mock is set up
	if (!window.maestro) {
		(window as unknown as Record<string, unknown>).maestro = {};
	}
	if (!(window.maestro as Record<string, unknown>).vibes) {
		(window.maestro as Record<string, unknown>).vibes = {};
	}
	(window.maestro as Record<string, Record<string, unknown>>).vibes.onActivityFeed = vi.fn(
		(cb: (event: VibesActivityFeedEvent) => void) => {
			feedCallback = cb;
			return cleanupFn;
		}
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	feedCallback = null;
});

// ============================================================================
// Tests
// ============================================================================

describe('useVibesInsights', () => {
	describe('Subscription lifecycle', () => {
		it('subscribes to onActivityFeed when enabled', () => {
			renderHook(() => useVibesInsights('session-1', true));
			expect(window.maestro.vibes.onActivityFeed).toHaveBeenCalledTimes(1);
		});

		it('does not subscribe when disabled', () => {
			renderHook(() => useVibesInsights('session-1', false));
			expect(window.maestro.vibes.onActivityFeed).not.toHaveBeenCalled();
		});

		it('does not subscribe when sessionId is undefined', () => {
			renderHook(() => useVibesInsights(undefined, true));
			expect(window.maestro.vibes.onActivityFeed).not.toHaveBeenCalled();
		});

		it('calls cleanup on unmount', () => {
			const { unmount } = renderHook(() => useVibesInsights('session-1', true));
			unmount();
			expect(cleanupFn).toHaveBeenCalledTimes(1);
		});
	});

	describe('Event filtering', () => {
		it('accepts events matching the active session ID', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));

			act(() => {
				feedCallback!(createEvent({ sessionId: 'session-1' }));
			});

			expect(result.current.events).toHaveLength(1);
		});

		it('rejects events from unrelated sessions', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));

			act(() => {
				feedCallback!(createEvent({ sessionId: 'session-other' }));
			});

			expect(result.current.events).toHaveLength(0);
		});

		it('tracks subagent sessions via delegation events', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));

			// Delegation event from parent session introducing a child
			act(() => {
				feedCallback!(
					createEvent({
						sessionId: 'session-1',
						category: 'delegation',
						summary: 'Agent spawned → Explore',
						detail: { childSessionId: 'session-child-1', parentSessionId: 'session-1' },
					})
				);
			});

			// Now event from child session should be accepted
			act(() => {
				feedCallback!(
					createEvent({
						sessionId: 'session-child-1',
						summary: 'Child tool event',
						isSubagent: true,
						depth: 1,
					})
				);
			});

			expect(result.current.events).toHaveLength(2);
			expect(result.current.events[1].summary).toBe('Child tool event');
		});
	});

	describe('Circular buffer', () => {
		it('keeps only the last 50 events', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));

			act(() => {
				for (let i = 0; i < 60; i++) {
					feedCallback!(
						createEvent({
							sessionId: 'session-1',
							summary: `Event ${i}`,
						})
					);
				}
			});

			expect(result.current.events).toHaveLength(50);
			// Should have events 10-59 (last 50)
			expect(result.current.events[0].summary).toBe('Event 10');
			expect(result.current.events[49].summary).toBe('Event 59');
		});
	});

	describe('Session change', () => {
		it('clears events when session ID changes', () => {
			const { result, rerender } = renderHook(
				({ sessionId, enabled }) => useVibesInsights(sessionId, enabled),
				{ initialProps: { sessionId: 'session-1', enabled: true } }
			);

			act(() => {
				feedCallback!(createEvent({ sessionId: 'session-1' }));
			});
			expect(result.current.events).toHaveLength(1);

			// Change session
			rerender({ sessionId: 'session-2', enabled: true });
			expect(result.current.events).toHaveLength(0);
		});
	});

	describe('Return value', () => {
		it('returns empty events when disabled', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', false));
			expect(result.current.events).toEqual([]);
			expect(result.current.isEnabled).toBe(false);
		});

		it('isEnabled reflects the enabled parameter', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));
			expect(result.current.isEnabled).toBe(true);
		});

		it('clear() empties the events array', () => {
			const { result } = renderHook(() => useVibesInsights('session-1', true));

			act(() => {
				feedCallback!(createEvent({ sessionId: 'session-1' }));
				feedCallback!(createEvent({ sessionId: 'session-1', summary: 'Second event' }));
			});
			expect(result.current.events).toHaveLength(2);

			act(() => {
				result.current.clear();
			});
			expect(result.current.events).toHaveLength(0);
		});
	});
});
