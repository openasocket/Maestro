/**
 * StatusTab - Stub for Status sub-tab within MemorySettings.
 *
 * Will contain: memory health panel, injection activity, embedding model status,
 * token usage, queue status.
 * Detailed content comes in MEM-TAB-06.
 */

import React from 'react';
import { Activity } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';

export interface StatusTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function StatusTab({ theme }: StatusTabProps): React.ReactElement {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 gap-3"
			style={{ color: theme.colors.textDim }}
		>
			<Activity className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
			<div className="text-xs font-medium">Status overview coming soon</div>
		</div>
	);
}
