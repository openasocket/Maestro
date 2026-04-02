/**
 * SectionHeader — Reusable collapsible/static section header for Memory sub-tabs.
 *
 * Provides a consistent visual pattern: icon + bold title + optional dim description,
 * optional right-aligned action slot, optional collapse chevron with badge.
 */

import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../types';

export interface SectionHeaderProps {
	title: string;
	theme: Theme;
	icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	description?: string;
	action?: React.ReactNode;
	badge?: number | null;
	collapsible?: boolean;
	collapsed?: boolean;
	onToggle?: () => void;
}

export function SectionHeader({
	title,
	theme,
	icon: Icon,
	description,
	action,
	badge,
	collapsible = false,
	collapsed = false,
	onToggle,
}: SectionHeaderProps) {
	const inner = (
		<>
			{collapsible &&
				(collapsed ? (
					<ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				) : (
					<ChevronDown className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
				))}
			{Icon && <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />}
			<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
				{title}
			</span>
			{description && (
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{description}
				</span>
			)}
			{badge != null && badge > 0 && (
				<span
					className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
					}}
				>
					{badge}
				</span>
			)}
			{action && <div className="ml-auto">{action}</div>}
		</>
	);

	if (collapsible) {
		return (
			<button className="flex items-center gap-2 w-full py-2 group" onClick={onToggle}>
				{inner}
			</button>
		);
	}

	return <div className="flex items-center gap-2 py-2">{inner}</div>;
}
