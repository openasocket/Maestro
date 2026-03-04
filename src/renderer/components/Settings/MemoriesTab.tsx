/**
 * MemoriesTab - Stub for Memories sub-tab within MemorySettings.
 *
 * Will contain: MemoryLibraryPanel, memory lifecycle config, decay/prune controls.
 * Detailed content comes in MEM-TAB-05.
 */

import React from 'react';
import { Brain } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';

export interface MemoriesTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function MemoriesTab({ theme }: MemoriesTabProps): React.ReactElement {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 gap-3"
			style={{ color: theme.colors.textDim }}
		>
			<Brain className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
			<div className="text-xs font-medium">Memories management coming soon</div>
		</div>
	);
}
