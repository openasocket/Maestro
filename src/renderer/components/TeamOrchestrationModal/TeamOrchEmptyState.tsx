/**
 * TeamOrchEmptyState
 *
 * Displays a friendly empty state message when no team orchestration data exists.
 * Used across Overview, Analytics, and History tabs.
 *
 * Features:
 * - Theme-aware styling with inline styles
 * - Users icon with subtle opacity
 * - Configurable message text
 */

import { memo } from 'react';
import { Users } from 'lucide-react';
import type { Theme } from '../../types';

interface TeamOrchEmptyStateProps {
	/** Current theme for styling */
	theme: Theme;
	/** Message to display */
	message: string;
}

export const TeamOrchEmptyState = memo(function TeamOrchEmptyState({
	theme,
	message,
}: TeamOrchEmptyStateProps) {
	return (
		<div
			className="flex flex-col items-center justify-center gap-4 py-12"
			style={{ color: theme.colors.textDim }}
			data-testid="team-orch-empty"
		>
			<div className="relative" style={{ opacity: 0.3 }}>
				<Users className="w-16 h-16" />
				<svg
					className="absolute -bottom-1 -right-2 w-6 h-6"
					viewBox="0 0 24 24"
					fill="none"
					style={{ opacity: 0.5 }}
				>
					<rect x="4" y="12" width="4" height="8" rx="1" fill={theme.colors.textDim} />
					<rect x="10" y="8" width="4" height="12" rx="1" fill={theme.colors.textDim} />
					<rect x="16" y="4" width="4" height="16" rx="1" fill={theme.colors.textDim} />
				</svg>
			</div>

			<p
				className="text-sm text-center rounded-lg px-6 py-3 border"
				style={{
					color: theme.colors.textDim,
					borderColor: `${theme.colors.border}80`,
				}}
			>
				{message}
			</p>
		</div>
	);
});

export default TeamOrchEmptyState;
