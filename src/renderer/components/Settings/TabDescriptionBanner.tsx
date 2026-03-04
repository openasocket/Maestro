/**
 * TabDescriptionBanner - Collapsible info banner shown at the top of memory sub-tabs.
 *
 * Explains what the tab's content represents in plain English.
 * Dismissible via X button; dismiss state is held in local component state.
 */

import React, { useState } from 'react';
import { Info, X } from 'lucide-react';
import type { Theme } from '../../types';

interface TabDescriptionBannerProps {
	theme: Theme;
	description: string;
}

export function TabDescriptionBanner({
	theme,
	description,
}: TabDescriptionBannerProps): React.ReactElement | null {
	const [dismissed, setDismissed] = useState(false);

	if (dismissed) return null;

	return (
		<div
			className="flex items-start gap-2.5 p-3 rounded-lg text-xs"
			style={{
				backgroundColor: `${theme.colors.accent}08`,
				borderLeft: `3px solid ${theme.colors.accent}40`,
				color: theme.colors.textDim,
			}}
		>
			<Info
				className="w-3.5 h-3.5 shrink-0 mt-0.5"
				style={{ color: theme.colors.accent, opacity: 0.7 }}
			/>
			<span className="flex-1 leading-relaxed">{description}</span>
			<button
				className="shrink-0 p-0.5 rounded hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.textDim }}
				onClick={() => setDismissed(true)}
				title="Dismiss"
			>
				<X className="w-3 h-3" />
			</button>
		</div>
	);
}
