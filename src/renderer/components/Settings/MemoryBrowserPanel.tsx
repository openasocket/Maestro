/**
 * Memory Browser Panel — combines MemoryTreeBrowser + MemoryLibraryPanel
 * in a side-by-side layout. This is the main content of the Memory settings tab.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryScope, SkillAreaId } from '../../../shared/memory-types';
import { MemoryTreeBrowser, type TreeNode } from './MemoryTreeBrowser';
import { MemoryLibraryPanel } from './MemoryLibraryPanel';
import { AllExperiencesPanel } from './AllExperiencesPanel';
import { useMemoryHierarchy } from '../../hooks/memory/useMemoryHierarchy';
import { useMemoryStore } from '../../hooks/memory/useMemoryStore';

interface MemoryBrowserPanelProps {
	theme: Theme;
	projectPath: string | null;
	agentType?: string;
	/** Optional pre-created hierarchy — when provided, skip creating a new one. */
	hierarchy?: ReturnType<typeof useMemoryHierarchy>;
}

/**
 * Derive the memory store scope and skillAreaId from the selected tree node.
 * Returns null for container nodes (role/persona) that have no direct memories.
 */
function deriveStoreParams(node: TreeNode | null): {
	scope: MemoryScope;
	skillAreaId?: SkillAreaId;
} | null {
	if (!node) return null;

	switch (node.type) {
		case 'skill':
			return { scope: 'skill', skillAreaId: node.id };
		case 'project':
			return { scope: 'project' };
		case 'global':
			return { scope: 'global' };
		// Role/persona/all-experiences are container/special nodes — no direct memories to list
		case 'role':
		case 'persona':
		case 'all-experiences':
			return null;
		default:
			return null;
	}
}

export function MemoryBrowserPanel({
	theme,
	projectPath,
	agentType,
	hierarchy: externalHierarchy,
}: MemoryBrowserPanelProps): React.ReactElement {
	const internalHierarchy = useMemoryHierarchy();
	const hierarchy = externalHierarchy ?? internalHierarchy;
	const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);

	// Track all experiences for count display on tree node
	const [allExperiencesCount, setAllExperiencesCount] = useState<number>(0);

	// Fetch experience count on mount and when hierarchy changes
	useEffect(() => {
		let cancelled = false;
		window.maestro.memory
			.listAllExperiences(projectPath ?? undefined)
			.then((res) => {
				if (!cancelled && res.success) {
					setAllExperiencesCount(res.data.length);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [projectPath, hierarchy.skillAreas]);

	// Derive scope params for useMemoryStore (null = container node, no memories to list)
	const storeParams = useMemo(() => deriveStoreParams(selectedNode), [selectedNode]);

	const store = useMemoryStore(
		storeParams?.scope ?? 'global',
		storeParams?.skillAreaId,
		projectPath,
		!storeParams // skip fetching when container node selected
	);

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
					totalExperienceCount={allExperiencesCount}
				/>
			</div>

			{/* Right: Library Panel or All Experiences Panel (70%) */}
			<div className="flex-1 overflow-hidden" style={{ backgroundColor: theme.colors.bgMain }}>
				{selectedNode?.type === 'all-experiences' ? (
					<AllExperiencesPanel
						theme={theme}
						projectPath={projectPath}
						hierarchy={hierarchy}
						onCountChange={setAllExperiencesCount}
					/>
				) : (
					<MemoryLibraryPanel
						theme={theme}
						selectedNode={selectedNode}
						projectPath={projectPath}
						agentType={agentType}
						store={store}
						roles={hierarchy.roles}
						personas={hierarchy.personas}
						skillAreas={hierarchy.skillAreas}
						onUpdateRole={hierarchy.updateRole}
						onUpdatePersona={hierarchy.updatePersona}
					/>
				)}
			</div>
		</div>
	);
}
