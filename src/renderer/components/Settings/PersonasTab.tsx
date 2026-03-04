/**
 * PersonasTab - Stub for Personas sub-tab within MemorySettings.
 *
 * Will contain: hierarchy suggestions, persona tree browser, persona management.
 * Detailed content comes in MEM-TAB-02.
 */

import React from 'react';
import { Users } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';

export interface PersonasTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
}

export function PersonasTab({ theme }: PersonasTabProps): React.ReactElement {
	return (
		<div
			className="flex flex-col items-center justify-center py-12 gap-3"
			style={{ color: theme.colors.textDim }}
		>
			<Users className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
			<div className="text-xs font-medium">Personas management coming soon</div>
		</div>
	);
}
