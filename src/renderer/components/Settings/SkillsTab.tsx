/**
 * SkillsTab - Skills sub-tab within MemorySettings.
 *
 * Contains: skill-level config (maxMemoriesPerSkillArea).
 * Full skill area browser integration comes in MEM-TAB-03.
 */

import React from 'react';
import { Layers } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';
import { ConfigSlider } from './MemoryConfigWidgets';

export interface SkillsTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
}

export function SkillsTab({
	theme,
	config,
	stats,
	onUpdateConfig,
}: SkillsTabProps): React.ReactElement {
	return (
		<div className="space-y-4">
			{/* Skill-level config */}
			<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center gap-2">
					<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Skill Configuration
					</div>
				</div>

				<ConfigSlider
					label="Max Memories per Skill Area"
					description="Prune oldest memories above this limit"
					value={config.maxMemoriesPerSkillArea}
					min={10}
					max={200}
					step={10}
					onChange={(v) => onUpdateConfig({ maxMemoriesPerSkillArea: v })}
					theme={theme}
				/>
			</div>

			{/* Stats summary */}
			{stats && (
				<div
					className="rounded-lg border p-4 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Skill Overview
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Total skill areas: {stats.totalSkillAreas}
					</div>
				</div>
			)}

			{/* Placeholder for skill area browser (MEM-TAB-03) */}
			<div
				className="flex flex-col items-center justify-center py-8 gap-3"
				style={{ color: theme.colors.textDim }}
			>
				<Layers className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
				<div className="text-xs font-medium">Skill area browser coming in MEM-TAB-03</div>
			</div>
		</div>
	);
}
