/**
 * ExperiencesTab - Stub for Experiences sub-tab within MemorySettings.
 *
 * Will contain: experience extraction config, promotion candidates, experience repository.
 * Detailed content comes in MEM-TAB-04.
 */

import React from 'react';
import { Lightbulb } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';

export interface ExperiencesTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function ExperiencesTab({ theme }: ExperiencesTabProps): React.ReactElement {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 gap-3"
			style={{ color: theme.colors.textDim }}
		>
			<Lightbulb className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
			<div className="text-xs font-medium">Experiences management coming soon</div>
		</div>
	);
}
