/**
 * SkillsTab - Stub for Skills sub-tab within MemorySettings.
 *
 * Will contain: skill area browser, skill-level config, maxMemoriesPerSkillArea.
 * Detailed content comes in MEM-TAB-03.
 */

import React from 'react';
import { Layers } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';

export interface SkillsTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function SkillsTab({ theme }: SkillsTabProps): React.ReactElement {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 gap-3"
			style={{ color: theme.colors.textDim }}
		>
			<Layers className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
			<div className="text-xs font-medium">Skills management coming soon</div>
		</div>
	);
}
