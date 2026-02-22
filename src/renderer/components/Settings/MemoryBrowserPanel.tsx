/**
 * Memory Browser Panel — combines MemoryTreeBrowser + MemoryLibraryPanel
 * in a side-by-side layout. This is the main content of the Memory settings tab.
 */

import React, { useState, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryScope, SkillAreaId } from '../../../shared/memory-types';
import { MemoryTreeBrowser, type TreeNode } from './MemoryTreeBrowser';
import { MemoryLibraryPanel } from './MemoryLibraryPanel';
import { useMemoryHierarchy } from '../../hooks/memory/useMemoryHierarchy';
import { useMemoryStore } from '../../hooks/memory/useMemoryStore';

interface MemoryBrowserPanelProps {
	theme: Theme;
	projectPath: string | null;
	agentType?: string;
}

/**
 * Derive the memory store scope and skillAreaId from the selected tree node.
 */
function deriveStoreParams(node: TreeNode | null): {
	scope: MemoryScope;
	skillAreaId?: SkillAreaId;
} {
	if (!node) return { scope: 'global' };

	switch (node.type) {
		case 'skill':
			return { scope: 'skill', skillAreaId: node.id };
		case 'project':
			return { scope: 'project' };
		case 'global':
			return { scope: 'global' };
		// For role/persona selections, we show an empty library with a prompt
		// to select a skill area — use 'skill' scope without an id so it returns empty
		case 'role':
		case 'persona':
			return { scope: 'skill' };
		default:
			return { scope: 'global' };
	}
}

export function MemoryBrowserPanel({
	theme,
	projectPath,
	agentType,
}: MemoryBrowserPanelProps): React.ReactElement {
	const hierarchy = useMemoryHierarchy();
	const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);

	// Derive scope params for useMemoryStore
	const { scope, skillAreaId } = useMemo(() => deriveStoreParams(selectedNode), [selectedNode]);

	const store = useMemoryStore(scope, skillAreaId, projectPath);

	if (hierarchy.loading) {
		return (
			<div
				className="flex items-center justify-center py-8 gap-2"
				style={{ color: theme.colors.textDim }}
			>
				<Loader2 className="w-4 h-4 animate-spin" />
				<span className="text-xs">Loading memory hierarchy...</span>
			</div>
		);
	}

	return (
		<div
			className="flex rounded-lg border overflow-hidden"
			style={{
				borderColor: theme.colors.border,
				height: '450px',
			}}
		>
			{/* Left: Tree Browser (30%) */}
			<div
				className="shrink-0 border-r overflow-hidden"
				style={{
					width: '30%',
					borderColor: theme.colors.border,
					backgroundColor: `${theme.colors.bgSidebar}`,
				}}
			>
				<MemoryTreeBrowser
					theme={theme}
					hierarchy={hierarchy}
					selectedNode={selectedNode}
					onSelectNode={setSelectedNode}
				/>
			</div>

			{/* Right: Library Panel (70%) */}
			<div className="flex-1 overflow-hidden" style={{ backgroundColor: theme.colors.bgMain }}>
				<MemoryLibraryPanel
					theme={theme}
					selectedNode={selectedNode}
					projectPath={projectPath}
					agentType={agentType}
					store={store}
					roles={hierarchy.roles}
					personas={hierarchy.personas}
					skillAreas={hierarchy.skillAreas}
				/>
			</div>
		</div>
	);
}
