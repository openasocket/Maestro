import React, { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import {
	Wrench,
	Brain,
	MessageSquare,
	GitBranch,
	Users,
	Play,
	Square,
	AlertTriangle,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	VibesActivityFeedEvent,
	VibesActivityFeedCategory,
} from '../../../shared/vibes-types';
import { formatRelativeTime } from '../../../shared/formatters';

// ============================================================================
// Props
// ============================================================================

interface VibesInsightsFeedProps {
	theme: Theme;
	events: VibesActivityFeedEvent[];
	maxVisible?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_VISIBLE = 10;
const FADE_AGE_MS = 30_000;

/** Icon component mapping per event category. */
const CATEGORY_ICONS: Record<VibesActivityFeedCategory, React.FC<{ className?: string }>> = {
	tool: Wrench,
	thinking: Brain,
	prompt: MessageSquare,
	decision: GitBranch,
	delegation: Users,
	session: Play,
	error: AlertTriangle,
};

// ============================================================================
// Helpers
// ============================================================================

/** Return opacity based on event age — events older than 30s fade. */
function getEventOpacity(timestamp: string, now: number): number {
	const age = now - new Date(timestamp).getTime();
	if (age > FADE_AGE_MS) return 0.4;
	return 1;
}

/** Pick an accent color per category from theme. */
function getCategoryColor(category: VibesActivityFeedCategory, theme: Theme): string {
	switch (category) {
		case 'tool':
			return theme.colors.accent;
		case 'thinking':
			return theme.colors.textDim;
		case 'prompt':
			return theme.colors.accent;
		case 'decision':
			return theme.colors.warning;
		case 'delegation':
			return theme.colors.success;
		case 'session':
			return theme.colors.textDim;
		case 'error':
			return theme.colors.error;
		default:
			return theme.colors.textMain;
	}
}

// ============================================================================
// Component
// ============================================================================

export const VibesInsightsFeed: React.FC<VibesInsightsFeedProps> = ({
	theme,
	events,
	maxVisible = DEFAULT_MAX_VISIBLE,
}) => {
	const scrollRef = useRef<HTMLDivElement>(null);
	const [now, setNow] = useState(Date.now());
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

	// Tick every 5s to update relative times and fade
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 5000);
		return () => clearInterval(timer);
	}, []);

	// Auto-scroll to bottom on new events
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [events.length]);

	const visibleEvents = useMemo(() => events.slice(-maxVisible), [events, maxVisible]);

	const handleToggleExpand = useCallback((idx: number) => {
		setExpandedIndex((prev) => (prev === idx ? null : idx));
	}, []);

	if (visibleEvents.length === 0) return null;

	return (
		<div
			ref={scrollRef}
			className="overflow-y-auto"
			style={{ maxHeight: '200px' }}
			data-testid="vibes-insights-feed"
		>
			{/* Header */}
			<div
				className="flex items-center gap-1.5 px-3 py-1 text-[9px] font-semibold uppercase tracking-wider"
				style={{ color: theme.colors.textDim, borderBottom: `1px solid ${theme.colors.border}` }}
			>
				VIBES
			</div>

			{/* Event rows */}
			{visibleEvents.map((event, idx) => {
				const Icon = CATEGORY_ICONS[event.category] || Wrench;
				const isDelegation = event.category === 'delegation';
				const isSessionEnd = event.category === 'session' && event.summary.includes('ended');
				const isThinking = event.category === 'thinking';
				const opacity = getEventOpacity(event.timestamp, now);
				const color = getCategoryColor(event.category, theme);

				return (
					<div
						key={`${event.timestamp}-${idx}`}
						className="flex items-start gap-2 px-3 py-1 transition-opacity duration-300"
						style={{
							paddingLeft: `${12 + event.depth * 16}px`,
							opacity,
							backgroundColor: isDelegation ? `${theme.colors.success}10` : 'transparent',
						}}
						data-testid="vibes-insights-event"
					>
						{/* Subagent nesting indicator */}
						{event.depth > 0 && (
							<span
								className="text-[9px] select-none"
								style={{ color: theme.colors.textDim, opacity: 0.5 }}
							>
								{'↳ '}
							</span>
						)}

						{/* Category icon */}
						<span style={{ color, flexShrink: 0, marginTop: '2px' }}>
							{isSessionEnd ? <Square className="w-3 h-3" /> : <Icon className="w-3 h-3" />}
						</span>

						{/* Summary */}
						<div className="flex-1 min-w-0">
							{isThinking ? (
								<button
									onClick={() => handleToggleExpand(idx)}
									className="text-left w-full cursor-pointer bg-transparent border-none p-0"
									style={{ color: theme.colors.textMain, font: 'inherit' }}
								>
									<span className="text-[11px] truncate block">{event.summary}</span>
									{expandedIndex === idx && event.detail?.thinkingPreview && (
										<span
											className="text-[10px] block mt-0.5 whitespace-pre-wrap"
											style={{ color: theme.colors.textDim }}
											data-testid="thinking-preview"
										>
											{event.detail.thinkingPreview}
										</span>
									)}
								</button>
							) : (
								<span
									className="text-[11px] truncate block"
									style={{ color: theme.colors.textMain }}
								>
									{event.summary}
								</span>
							)}

							{/* Decision badge */}
							{event.category === 'decision' && event.detail?.selectedOption && (
								<span
									className="inline-block text-[9px] px-1.5 py-0.5 rounded mt-0.5"
									style={{
										backgroundColor: `${theme.colors.warning}20`,
										color: theme.colors.warning,
									}}
									data-testid="decision-badge"
								>
									{event.detail.selectedOption}
								</span>
							)}
						</div>

						{/* Relative time */}
						<span
							className="text-[9px] whitespace-nowrap flex-shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							{formatRelativeTime(event.timestamp)}
						</span>
					</div>
				);
			})}
		</div>
	);
};
