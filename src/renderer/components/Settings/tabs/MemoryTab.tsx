/**
 * MemoryTab - Memory/Experiences settings tab for SettingsModal
 *
 * Contains: MemorySettings (master toggle + config) and MemoryBrowserPanel
 * (hierarchy tree + memory library).
 *
 * Self-sourced: creates its own useMemoryHierarchy instance shared between
 * MemorySettings and MemoryBrowserPanel to avoid duplicate fetches.
 */

import type { Theme } from '../../../types';
import { MemorySettings } from '../MemorySettings';
import { MemoryBrowserPanel } from '../MemoryBrowserPanel';
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
		<div className="space-y-6">
			<MemorySettings
				theme={theme}
				projectPath={projectPath}
				onHierarchyChange={memoryHierarchy.refresh}
				hierarchyRoleCount={memoryHierarchy.roles.length}
				activeAgentId={activeAgentId}
				activeAgentType={activeAgentType}
			/>
			<MemoryBrowserPanel theme={theme} projectPath={projectPath} hierarchy={memoryHierarchy} />
		</div>
	);
}
