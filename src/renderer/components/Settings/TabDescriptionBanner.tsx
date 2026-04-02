/**
 * TabDescriptionBanner - Collapsible info banner shown at the top of memory sub-tabs.
 *
 * Explains what the tab's content represents in plain English.
 * Dismissible via X button; dismiss state is keyed by `descriptionKey` so
 * different content-state descriptions (empty vs populated) are tracked independently.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Info, X } from 'lucide-react';
import type { Theme } from '../../types';

interface TabDescriptionBannerProps {
	theme: Theme;
	description: string;
	/**
	 * Unique key identifying this description variant.
	 * Dismissing one key does not suppress banners with a different key.
	 * Defaults to the description string itself for backward compatibility.
	 */
	descriptionKey?: string;
}

export function TabDescriptionBanner({
	theme,
	description,
	descriptionKey,
}: TabDescriptionBannerProps): React.ReactElement | null {
	const effectiveKey = descriptionKey ?? description;
	const dismissedKeys = useRef<Set<string>>(new Set());
	const [dismissed, setDismissed] = useState(false);

	// Reset dismissed state when the effective key changes to a non-dismissed key
	useEffect(() => {
		setDismissed(dismissedKeys.current.has(effectiveKey));
	}, [effectiveKey]);

	const handleDismiss = useCallback(() => {
		dismissedKeys.current.add(effectiveKey);
		setDismissed(true);
	}, [effectiveKey]);

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
				onClick={handleDismiss}
				title="Dismiss"
			>
				<X className="w-3 h-3" />
			</button>
		</div>
	);
}
