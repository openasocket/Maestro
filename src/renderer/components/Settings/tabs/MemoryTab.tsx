/**
 * MemoryTab - Memory/Experiences settings tab for SettingsModal
 *
 * Thin wrapper that renders MemorySettings with sub-tab navigation.
 * Each sub-tab (Personas, Skills, Experiences, Memories, Config, Status)
 * is self-contained — MemoryBrowserPanel lives inside MemoriesTab.
 */

import type { Theme } from '../../../types';
import { MemorySettings } from '../MemorySettings';
import { useMemoryHierarchy } from '../../../hooks/memory/useMemoryHierarchy';

interface MemoryTabProps {
	theme: Theme;
	/** Active session's working directory for project-scoped memories */
	activeProjectPath?: string | null;
	/** Active agent session ID for per-agent analysis */
	activeAgentId?: string | null;
	/** Active agent type (e.g. 'claude-code') */
	activeAgentType?: string | null;
}

export function MemoryTab({
	theme,
	activeProjectPath,
	activeAgentId,
	activeAgentType,
}: MemoryTabProps): React.ReactElement {
	const memoryHierarchy = useMemoryHierarchy();
	const projectPath = activeProjectPath ?? null;

	return (
		<MemorySettings
			theme={theme}
			projectPath={projectPath}
			onHierarchyChange={memoryHierarchy.refresh}
			hierarchyRoleCount={memoryHierarchy.roles.length}
			activeAgentId={activeAgentId}
			activeAgentType={activeAgentType}
		/>
	);
}
