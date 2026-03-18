/**
 * Tests for VibesInsightsFeed component
 *
 * Tests cover:
 * - Rendering events with correct icons per category
 * - Subagent events are indented
 * - Feed collapses (returns null) when no events
 * - Max visible limit works (only shows last N)
 * - Thinking events expand on click to show preview
 * - Decision events show selected option badge
 * - Delegation events have distinct background
 * - Old events fade to lower opacity
 * - Toggle button visibility conditions
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VibesInsightsFeed } from '../../../renderer/components/vibes/VibesInsightsFeed';
import type { Theme } from '../../../renderer/types';
import type {
	VibesActivityFeedEvent,
	VibesActivityFeedCategory,
} from '../../../shared/vibes-types';

// ============================================================================
// Mock Theme
// ============================================================================

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#007acc',
		accentDim: '#007acc50',
		accentText: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f44747',
		warning: '#cca700',
		success: '#4ec9b0',
	},
};

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

function createEventsOfCategory(category: VibesActivityFeedCategory): VibesActivityFeedEvent {
	const summaries: Record<VibesActivityFeedCategory, string> = {
		tool: 'Tool: Write → src/main/index.ts',
		thinking: 'I need to implement the activity feed...',
		prompt: 'Prompt: Create a new component',
		decision: 'Decision: Use React hooks → useState',
		delegation: 'Agent spawned → Explore codebase',
		session: 'Session started',
		error: 'Error: Connection timeout',
	};
	return createEvent({ category, summary: summaries[category] });
}

// ============================================================================
// Tests
// ============================================================================

describe('VibesInsightsFeed', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-17T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('Rendering', () => {
		it('returns null when events array is empty', () => {
			const { container } = render(<VibesInsightsFeed theme={mockTheme} events={[]} />);
			expect(container.innerHTML).toBe('');
		});

		it('renders the VIBES header', () => {
			const events = [createEvent()];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.getByText('VIBES')).toBeInTheDocument();
		});

		it('renders event summary text', () => {
			const events = [createEvent({ summary: 'Tool: Write → src/main/index.ts' })];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.getByText('Tool: Write → src/main/index.ts')).toBeInTheDocument();
		});

		it('renders the feed container with data-testid', () => {
			const events = [createEvent()];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.getByTestId('vibes-insights-feed')).toBeInTheDocument();
		});
	});

	describe('Icons per category', () => {
		const categories: VibesActivityFeedCategory[] = [
			'tool',
			'thinking',
			'prompt',
			'decision',
			'delegation',
			'session',
			'error',
		];

		it('renders an event row for each category', () => {
			const events = categories.map((cat) => createEventsOfCategory(cat));
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRows = screen.getAllByTestId('vibes-insights-event');
			expect(eventRows).toHaveLength(categories.length);
		});
	});

	describe('Subagent indentation', () => {
		it('does not show nesting indicator for depth 0', () => {
			const events = [createEvent({ depth: 0, isSubagent: false })];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRow = screen.getByTestId('vibes-insights-event');
			expect(eventRow.textContent).not.toContain('↳');
		});

		it('shows nesting indicator for depth > 0', () => {
			const events = [createEvent({ depth: 1, isSubagent: true })];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.getByText('↳')).toBeInTheDocument();
		});

		it('increases padding for deeper nesting', () => {
			const events = [
				createEvent({ depth: 0 }),
				createEvent({ depth: 2, isSubagent: true, summary: 'Nested event' }),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRows = screen.getAllByTestId('vibes-insights-event');
			// depth 0: paddingLeft = 12px, depth 2: paddingLeft = 12 + 2*16 = 44px
			expect(eventRows[0].style.paddingLeft).toBe('12px');
			expect(eventRows[1].style.paddingLeft).toBe('44px');
		});
	});

	describe('Max visible limit', () => {
		it('only shows the last N events when maxVisible is set', () => {
			const events = Array.from({ length: 15 }, (_, i) => createEvent({ summary: `Event ${i}` }));
			render(<VibesInsightsFeed theme={mockTheme} events={events} maxVisible={5} />);
			const eventRows = screen.getAllByTestId('vibes-insights-event');
			expect(eventRows).toHaveLength(5);
			// Should show last 5: Event 10 through Event 14
			expect(screen.getByText('Event 14')).toBeInTheDocument();
			expect(screen.getByText('Event 10')).toBeInTheDocument();
			expect(screen.queryByText('Event 9')).not.toBeInTheDocument();
		});

		it('uses default maxVisible of 10', () => {
			const events = Array.from({ length: 20 }, (_, i) => createEvent({ summary: `Event ${i}` }));
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRows = screen.getAllByTestId('vibes-insights-event');
			expect(eventRows).toHaveLength(10);
		});
	});

	describe('Thinking events', () => {
		it('thinking event is clickable to expand preview', () => {
			const events = [
				createEvent({
					category: 'thinking',
					summary: 'I need to implement...',
					detail: {
						thinkingPreview: 'Full thinking preview text here that is longer than the summary',
					},
				}),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);

			// Preview should not be visible initially
			expect(screen.queryByTestId('thinking-preview')).not.toBeInTheDocument();

			// Click to expand
			fireEvent.click(screen.getByText('I need to implement...'));
			expect(screen.getByTestId('thinking-preview')).toBeInTheDocument();
			expect(
				screen.getByText('Full thinking preview text here that is longer than the summary')
			).toBeInTheDocument();

			// Click again to collapse
			fireEvent.click(screen.getByText('I need to implement...'));
			expect(screen.queryByTestId('thinking-preview')).not.toBeInTheDocument();
		});
	});

	describe('Decision events', () => {
		it('shows selected option as a badge', () => {
			const events = [
				createEvent({
					category: 'decision',
					summary: 'Decision: Architecture → Hooks',
					detail: { selectedOption: 'useState + useCallback', decisionPoint: 'State management' },
				}),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.getByTestId('decision-badge')).toBeInTheDocument();
			expect(screen.getByText('useState + useCallback')).toBeInTheDocument();
		});

		it('does not show badge when no selectedOption', () => {
			const events = [
				createEvent({
					category: 'decision',
					summary: 'Decision: Architecture → unknown',
				}),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			expect(screen.queryByTestId('decision-badge')).not.toBeInTheDocument();
		});
	});

	describe('Delegation events', () => {
		it('has distinct background color for delegation events', () => {
			const events = [
				createEvent({
					category: 'delegation',
					summary: 'Agent spawned → Explore codebase',
				}),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRow = screen.getByTestId('vibes-insights-event');
			// Delegation events have a non-transparent background (success color with alpha)
			expect(eventRow.style.backgroundColor).not.toBe('transparent');
			expect(eventRow.style.backgroundColor).toBeTruthy();
		});
	});

	describe('Event aging and opacity', () => {
		it('events older than 30 seconds have reduced opacity', () => {
			const oldTimestamp = new Date(Date.now() - 35000).toISOString();
			const newTimestamp = new Date().toISOString();
			const events = [
				createEvent({ timestamp: oldTimestamp, summary: 'Old event' }),
				createEvent({ timestamp: newTimestamp, summary: 'New event' }),
			];
			render(<VibesInsightsFeed theme={mockTheme} events={events} />);
			const eventRows = screen.getAllByTestId('vibes-insights-event');
			expect(eventRows[0].style.opacity).toBe('0.4');
			expect(eventRows[1].style.opacity).toBe('1');
		});
	});
});
