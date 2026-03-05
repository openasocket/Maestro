/**
 * MemorySettings - Agent Experiences memory system configuration panel.
 *
 * Master toggle, seed/reset controls, sub-tab navigation, and global retrieval config.
 * Tab-specific content is in PersonasTab, SkillsTab, ExperiencesTab, MemoriesTab, StatusTab.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
	Brain,
	Loader2,
	Sparkles,
	AlertTriangle,
	Lightbulb,
	Activity,
	RotateCcw,
	Users,
	Layers,
	Settings,
} from 'lucide-react';
import type { Theme } from '../../types';
import { PersonasTab } from './PersonasTab';
import { SkillsTab } from './SkillsTab';
import { ExperiencesTab } from './ExperiencesTab';
import { MemoriesTab, type MemoryFilter } from './MemoriesTab';
import { StatusTab } from './StatusTab';
import { ConfigTab } from './ConfigTab';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Sub-Tab Navigation ───────────────────────────────────────────────────────

export type MemorySubTab = 'personas' | 'skills' | 'experiences' | 'memories' | 'config' | 'status';

const MEMORY_SUB_TABS: {
	id: MemorySubTab;
	label: string;
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	getCount: (stats: MemoryStats | null) => number | null;
}[] = [
	{ id: 'personas', label: 'Personas', icon: Users, getCount: (s) => s?.totalPersonas ?? null },
	{ id: 'skills', label: 'Skills', icon: Layers, getCount: (s) => s?.totalSkillAreas ?? null },
	{
		id: 'experiences',
		label: 'Experiences',
		icon: Lightbulb,
		getCount: (s) => (s ? (s.byType?.experience ?? 0) : null),
	},
	{ id: 'memories', label: 'Memories', icon: Brain, getCount: (s) => s?.totalMemories ?? null },
	{ id: 'config', label: 'Config', icon: Settings, getCount: () => null },
	{
		id: 'status',
		label: 'Status',
		icon: Activity,
		getCount: (s) => (s ? s.recentInjections : null),
	},
];

interface MemorySettingsProps {
	theme: Theme;
	projectPath?: string | null;
	/** Called after seed/reset operations so sibling components can refresh. */
	onHierarchyChange?: () => void;
	/** Live role count from shared hierarchy — when provided, overrides internal hasRoles check. */
	hierarchyRoleCount?: number;
	/** Active agent session ID for per-agent analysis */
	activeAgentId?: string | null;
	/** Active agent type (e.g. 'claude-code') */
	activeAgentType?: string | null;
	/** Initial sub-tab to show (for deep-linking from outside) */
	initialSubTab?: string;
}

export function MemorySettings({
	theme,
	projectPath,
	onHierarchyChange,
	hierarchyRoleCount,
	activeAgentId,
	activeAgentType,
	initialSubTab,
}: MemorySettingsProps): React.ReactElement {
	const validInitialTab = MEMORY_SUB_TABS.find((t) => t.id === initialSubTab)?.id ?? 'personas';
	const [activeSubTab, setActiveSubTab] = useState<MemorySubTab>(validInitialTab);
	const [config, setConfig] = useState<MemoryConfig>(MEMORY_CONFIG_DEFAULTS);
	const [stats, setStats] = useState<MemoryStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasRolesInternal, setHasRoles] = useState(true);
	const hasRoles = hierarchyRoleCount !== undefined ? hierarchyRoleCount > 0 : hasRolesInternal;
	const [seeding, setSeeding] = useState(false);
	const [resetting, setResetting] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [memoriesFilter, setMemoriesFilter] = useState<MemoryFilter | null>(null);

	// Scroll position persistence across tab switches
	const scrollPositions = useRef<Record<MemorySubTab, number>>({
		personas: 0,
		skills: 0,
		experiences: 0,
		memories: 0,
		config: 0,
		status: 0,
	});
	const contentRef = useRef<HTMLDivElement>(null);

	const handleTabSwitch = useCallback(
		(newTab: MemorySubTab) => {
			if (contentRef.current) {
				scrollPositions.current[activeSubTab] = contentRef.current.scrollTop;
			}
			setActiveSubTab(newTab);
		},
		[activeSubTab]
	);

	// Restore scroll position after tab switch
	useEffect(() => {
		if (contentRef.current) {
			contentRef.current.scrollTop = scrollPositions.current[activeSubTab];
		}
	}, [activeSubTab]);

	// Refs for tab buttons (keyboard focus management)
	const tabButtonRefs = useRef<Record<MemorySubTab, HTMLButtonElement | null>>({
		personas: null,
		skills: null,
		experiences: null,
		memories: null,
		config: null,
		status: null,
	});

	// Keyboard navigation for sub-tab bar
	const handleTabBarKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			const tabs = MEMORY_SUB_TABS;
			const currentIndex = tabs.findIndex((t) => t.id === activeSubTab);
			let newIndex = currentIndex;

			if (e.key === 'ArrowRight') newIndex = (currentIndex + 1) % tabs.length;
			else if (e.key === 'ArrowLeft') newIndex = (currentIndex - 1 + tabs.length) % tabs.length;
			else if (e.key === 'Home') newIndex = 0;
			else if (e.key === 'End') newIndex = tabs.length - 1;
			else return;

			e.preventDefault();
			const newTab = tabs[newIndex].id;
			handleTabSwitch(newTab);
			tabButtonRefs.current[newTab]?.focus();
		},
		[activeSubTab, handleTabSwitch]
	);

	// Cross-tab navigation with optional filter state
	const navigateToTab = useCallback(
		(tab: string, filter?: Record<string, string> | null) => {
			const validTab = MEMORY_SUB_TABS.find((t) => t.id === tab)?.id;
			if (!validTab) return;
			if (validTab === 'memories' && filter) {
				setMemoriesFilter(filter as MemoryFilter);
			}
			handleTabSwitch(validTab);
		},
		[handleTabSwitch]
	);

	// Load config and stats on mount
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				const [configRes, statsRes, rolesRes] = await Promise.all([
					window.maestro.memory.getConfig(),
					window.maestro.memory.getAnalytics(),
					window.maestro.memory.role.list(),
				]);
				if (!mounted) return;

				if (configRes.success) setConfig({ ...MEMORY_CONFIG_DEFAULTS, ...configRes.data });
				if (statsRes.success) setStats(statsRes.data);
				if (rolesRes.success) setHasRoles(rolesRes.data.length > 0);
			} catch (err) {
				if (mounted) {
					setError(err instanceof Error ? err.message : 'Failed to load memory settings');
				}
			} finally {
				if (mounted) setLoading(false);
			}
		})();
		return () => {
			mounted = false;
		};
	}, []);

	// Persist config changes
	const updateConfig = useCallback(
		async (updates: Partial<MemoryConfig>) => {
			const newConfig = { ...config, ...updates };
			setConfig(newConfig);
			setSaving(true);
			try {
				const res = await window.maestro.memory.setConfig(updates);
				if (!res.success) {
					setError(res.error);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to save config');
			} finally {
				setSaving(false);
			}
		},
		[config]
	);

	// Refresh stats — passed to tabs so they can trigger refresh after mutations
	const refreshStats = useCallback(async () => {
		try {
			const statsRes = await window.maestro.memory.getAnalytics();
			if (statsRes.success) setStats(statsRes.data);
		} catch {
			// Non-critical
		}
	}, []);

	// Refresh config + stats — used when config is changed from child components (e.g. enable button)
	const refreshConfigAndStats = useCallback(async () => {
		try {
			const [configRes, statsRes] = await Promise.all([
				window.maestro.memory.getConfig(),
				window.maestro.memory.getAnalytics(),
			]);
			if (configRes.success) setConfig({ ...MEMORY_CONFIG_DEFAULTS, ...configRes.data });
			if (statsRes.success) setStats(statsRes.data);
		} catch {
			// Non-critical
		}
	}, []);

	// Seed defaults handler
	const handleSeedDefaults = useCallback(async () => {
		setSeeding(true);
		try {
			const res = await window.maestro.memory.seedDefaults();
			if (!res.success) {
				setError(res.error);
				return;
			}
			setHasRoles(true);
			await refreshStats();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to seed defaults');
		} finally {
			setSeeding(false);
		}
	}, [onHierarchyChange, refreshStats]);

	// Reset all seed defaults handler
	const handleResetDefaults = useCallback(async () => {
		setResetting(true);
		try {
			const res = await window.maestro.memory.resetSeedDefaults();
			if (!res.success) {
				setError(res.error);
				return;
			}
			setConfirmReset(false);
			await refreshStats();
			onHierarchyChange?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to reset defaults');
		} finally {
			setResetting(false);
		}
	}, [onHierarchyChange, refreshStats]);

	if (loading) {
		return (
			<div
				className="flex items-center justify-center py-8 gap-2"
				style={{ color: theme.colors.textDim }}
			>
				<Loader2 className="w-4 h-4 animate-spin" />
				<span className="text-xs">Loading memory settings...</span>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4" style={{ height: '100%' }}>
			{/* Master Toggle */}
			<div
				className="shrink-0 rounded-lg border p-4"
				style={{
					borderColor: config.enabled ? theme.colors.accent : theme.colors.border,
					backgroundColor: config.enabled ? `${theme.colors.accent}08` : 'transparent',
				}}
			>
				<button
					className="w-full flex items-center justify-between text-left"
					onClick={() => updateConfig({ enabled: !config.enabled })}
				>
					<div className="flex items-center gap-3">
						<Brain
							className="w-5 h-5"
							style={{ color: config.enabled ? theme.colors.accent : theme.colors.textDim }}
						/>
						<div>
							<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
								Agent Experiences
							</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
								Hierarchical memory system for persistent agent knowledge
							</div>
						</div>
					</div>
					<div className="flex items-center gap-2">
						{saving && (
							<Loader2 className="w-3 h-3 animate-spin" style={{ color: theme.colors.textDim }} />
						)}
						<div
							className={`relative w-10 h-5 rounded-full transition-colors ${config.enabled ? '' : 'opacity-50'}`}
							style={{
								backgroundColor: config.enabled ? theme.colors.accent : theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
								style={{ transform: config.enabled ? 'translateX(22px)' : 'translateX(2px)' }}
							/>
						</div>
					</div>
				</button>
			</div>

			{error && (
				<div
					className="flex items-center gap-2 p-3 rounded-lg text-xs"
					style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
				>
					<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
					{error}
				</div>
			)}

			{/* Config panel — shown when enabled */}
			{config.enabled && (
				<div className="flex flex-col flex-1 min-h-0 gap-4">
					{/* Seed Defaults Button */}
					<button
						className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border text-xs font-medium transition-colors"
						style={{
							borderColor: theme.colors.accent,
							color: theme.colors.accent,
							backgroundColor: `${theme.colors.accent}10`,
						}}
						onClick={handleSeedDefaults}
						disabled={seeding}
					>
						{seeding ? (
							<Loader2 className="w-3.5 h-3.5 animate-spin" />
						) : (
							<Sparkles className="w-3.5 h-3.5" />
						)}
						{seeding
							? 'Creating default hierarchy...'
							: hasRoles
								? 'Sync Missing Default Roles'
								: 'Seed Default Roles & Personas'}
					</button>

					{/* Reset All Defaults Button */}
					{hasRoles && (
						<div className="flex items-center gap-2">
							<button
								className="flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-lg border text-xs font-medium transition-colors"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textDim,
								}}
								onClick={() => (confirmReset ? handleResetDefaults() : setConfirmReset(true))}
								disabled={resetting}
							>
								{resetting ? (
									<Loader2 className="w-3.5 h-3.5 animate-spin" />
								) : (
									<RotateCcw className="w-3.5 h-3.5" />
								)}
								{resetting
									? 'Resetting...'
									: confirmReset
										? 'Confirm Reset All Defaults'
										: 'Reset All Seed Defaults'}
							</button>
							{confirmReset && (
								<button
									className="px-2 py-2 rounded-lg border text-xs transition-opacity hover:opacity-80"
									style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
									onClick={() => setConfirmReset(false)}
								>
									Cancel
								</button>
							)}
						</div>
					)}

					{/* Sub-Tab Navigation Bar */}
					<div
						role="tablist"
						aria-label="Memory sub-tabs"
						className="shrink-0 sticky top-0 z-10 flex gap-1.5 py-2 px-1 -mx-1 overflow-x-auto"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderBottom: `1px solid ${theme.colors.border}`,
							paddingBottom: '8px',
							marginBottom: '4px',
						}}
						onKeyDown={handleTabBarKeyDown}
					>
						{MEMORY_SUB_TABS.map((tab) => {
							const isActive = activeSubTab === tab.id;
							const count = tab.getCount(stats);
							const Icon = tab.icon;
							return (
								<button
									key={tab.id}
									ref={(el) => {
										tabButtonRefs.current[tab.id] = el;
									}}
									role="tab"
									aria-selected={isActive}
									aria-controls={`memory-tabpanel-${tab.id}`}
									id={`memory-tab-${tab.id}`}
									tabIndex={isActive ? 0 : -1}
									onClick={() => handleTabSwitch(tab.id)}
									className="flex items-center gap-1.5 px-3 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0"
									style={{
										minHeight: '36px',
										backgroundColor: isActive ? `${theme.colors.accent}30` : 'transparent',
										color: isActive ? theme.colors.accent : theme.colors.textDim,
										border: `1px solid ${isActive ? theme.colors.accent : 'transparent'}`,
										borderBottom: isActive
											? `2px solid ${theme.colors.accent}`
											: '2px solid transparent',
									}}
								>
									<Icon
										className="w-3.5 h-3.5"
										style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
									/>
									{tab.label}
									{count !== null && (
										<span
											className="ml-0.5 px-1.5 py-px rounded-full text-[10px]"
											style={{
												backgroundColor: isActive
													? `${theme.colors.accent}15`
													: `${theme.colors.border}60`,
												color: isActive ? theme.colors.accent : theme.colors.textDim,
											}}
										>
											{count}
										</span>
									)}
								</button>
							);
						})}
					</div>

					{/* Active Sub-Tab Content — constrained height for per-tab scrolling */}
					<div
						ref={contentRef}
						role="tabpanel"
						id={`memory-tabpanel-${activeSubTab}`}
						aria-labelledby={`memory-tab-${activeSubTab}`}
						className="flex-1 min-h-0 flex flex-col overflow-y-auto"
						style={{ maxHeight: 'calc(100vh - 420px)' }}
					>
						{activeSubTab === 'personas' && (
							<PersonasTab
								theme={theme}
								config={config}
								stats={stats}
								projectPath={projectPath}
								onHierarchyChange={onHierarchyChange}
								onRefresh={refreshStats}
								onNavigateToTab={navigateToTab}
							/>
						)}
						{activeSubTab === 'skills' && (
							<SkillsTab
								theme={theme}
								config={config}
								stats={stats}
								projectPath={projectPath}
								onUpdateConfig={updateConfig}
								onViewMemories={(skillAreaId) => {
									setMemoriesFilter(skillAreaId ? { skillAreaId } : null);
									handleTabSwitch('memories');
								}}
								onHierarchyChange={onHierarchyChange}
							/>
						)}
						{activeSubTab === 'experiences' && (
							<ExperiencesTab
								theme={theme}
								config={config}
								stats={stats}
								projectPath={projectPath}
								onUpdateConfig={updateConfig}
								onRefresh={refreshStats}
								activeAgentId={activeAgentId}
								activeAgentType={activeAgentType}
							/>
						)}
						{activeSubTab === 'memories' && (
							<MemoriesTab
								theme={theme}
								config={config}
								stats={stats}
								projectPath={projectPath}
								onUpdateConfig={updateConfig}
								onRefresh={refreshStats}
								initialFilter={memoriesFilter}
								onClearFilter={() => setMemoriesFilter(null)}
							/>
						)}
						{activeSubTab === 'config' && (
							<ConfigTab
								theme={theme}
								config={config}
								stats={stats}
								onUpdateConfig={updateConfig}
							/>
						)}
						{activeSubTab === 'status' && (
							<StatusTab
								theme={theme}
								config={config}
								stats={stats}
								projectPath={projectPath}
								onConfigChange={refreshConfigAndStats}
								onNavigateToTab={navigateToTab}
							/>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
