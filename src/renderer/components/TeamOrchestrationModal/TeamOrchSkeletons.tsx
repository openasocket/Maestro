/**
 * TeamOrchSkeletons
 *
 * Loading skeleton components for Team Orchestration modal.
 * Provides shimmer-animated placeholders for summary cards and list items
 * while data is loading.
 *
 * Features:
 * - Theme-aware styling with subtle shimmer animation
 * - Matches approximate layout of TeamOrchSummaryCards and list items
 * - Uses skeleton-shimmer CSS animation (defined in index.css)
 */

import React, { memo } from 'react';
import type { Theme } from '../../types';

interface SkeletonProps {
	theme: Theme;
}

function SkeletonBox({
	theme,
	className = '',
	style = {},
}: SkeletonProps & { className?: string; style?: React.CSSProperties }) {
	return (
		<div
			className={`rounded ${className}`}
			style={{
				backgroundColor: theme.colors.border,
				opacity: 0.3,
				animation: 'skeleton-shimmer 1.5s ease-in-out infinite',
				...style,
			}}
			data-testid="skeleton-box"
		/>
	);
}

/**
 * Skeleton for the 6 summary metric cards (3x2 grid)
 */
const SummaryCardsSkeleton = memo(function SummaryCardsSkeleton({ theme }: SkeletonProps) {
	return (
		<div
			className="grid gap-4"
			style={{
				gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
			}}
			data-testid="team-orch-summary-skeleton"
			aria-busy="true"
		>
			{Array.from({ length: 6 }).map((_, i) => (
				<div
					key={i}
					className="p-4 rounded-lg flex items-start gap-3"
					style={{ backgroundColor: theme.colors.bgMain }}
				>
					<SkeletonBox theme={theme} style={{ width: 36, height: 36, flexShrink: 0 }} />
					<div className="flex-1 min-w-0">
						<SkeletonBox theme={theme} style={{ width: '60%', height: 12, marginBottom: 8 }} />
						<SkeletonBox theme={theme} style={{ width: '80%', height: 28 }} />
					</div>
				</div>
			))}
		</div>
	);
});

/**
 * Skeleton for a list of workflow items
 */
const ListItemsSkeleton = memo(function ListItemsSkeleton({ theme }: SkeletonProps) {
	return (
		<div className="space-y-3" data-testid="team-orch-list-skeleton">
			{Array.from({ length: 4 }).map((_, i) => (
				<div
					key={i}
					className="p-4 rounded-lg flex items-center gap-4"
					style={{
						backgroundColor: theme.colors.bgMain,
						animationDelay: `${i * 100}ms`,
					}}
				>
					{/* Status dot */}
					<SkeletonBox
						theme={theme}
						className="rounded-full"
						style={{ width: 10, height: 10, flexShrink: 0 }}
					/>
					{/* Name */}
					<SkeletonBox theme={theme} style={{ width: '30%', height: 14, flexShrink: 0 }} />
					{/* Topology badge */}
					<SkeletonBox
						theme={theme}
						className="rounded-full"
						style={{ width: 80, height: 20, flexShrink: 0 }}
					/>
					{/* Spacer */}
					<div className="flex-1" />
					{/* Metrics */}
					<SkeletonBox theme={theme} style={{ width: 50, height: 14, flexShrink: 0 }} />
					<SkeletonBox theme={theme} style={{ width: 60, height: 14, flexShrink: 0 }} />
					<SkeletonBox theme={theme} style={{ width: 40, height: 14, flexShrink: 0 }} />
				</div>
			))}
		</div>
	);
});

/**
 * Full Team Orchestration Overview skeleton combining cards + list items
 */
export const TeamOrchSkeleton = memo(function TeamOrchSkeleton({ theme }: SkeletonProps) {
	return (
		<div className="space-y-6" data-testid="team-orch-skeleton" aria-busy="true" aria-live="polite">
			<SummaryCardsSkeleton theme={theme} />

			{/* Active Workflows section skeleton */}
			<div>
				<SkeletonBox theme={theme} style={{ width: 140, height: 16, marginBottom: 12 }} />
				<ListItemsSkeleton theme={theme} />
			</div>

			{/* Recent Completions section skeleton */}
			<div>
				<SkeletonBox theme={theme} style={{ width: 160, height: 16, marginBottom: 12 }} />
				<ListItemsSkeleton theme={theme} />
			</div>
		</div>
	);
});

export default TeamOrchSkeleton;
