/**
 * MemorySettings - Agent Experiences memory system configuration panel.
 *
 * Master toggle, seed/reset controls, sub-tab navigation, and global retrieval config.
 * Tab-specific content is in PersonasTab, SkillsTab, ExperiencesTab, MemoriesTab, StatusTab.
 */

import React, { useState, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import type { Theme } from '../../types';
import { PersonasTab } from './PersonasTab';
import { SkillsTab } from './SkillsTab';
import { ExperiencesTab } from './ExperiencesTab';
import { MemoriesTab } from './MemoriesTab';
import { StatusTab } from './StatusTab';
import { ConfigSlider, ConfigToggle } from './MemoryConfigWidgets';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

// ─── Sub-Tab Navigation ───────────────────────────────────────────────────────

export type MemorySubTab = 'personas' | 'skills' | 'experiences' | 'memories' | 'status';

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
}

export function MemorySettings({
	theme,
	projectPath,
	onHierarchyChange,
	hierarchyRoleCount,
	activeAgentId,
	activeAgentType,
}: MemorySettingsProps): React.ReactElement {
	const [activeSubTab, setActiveSubTab] = useState<MemorySubTab>('personas');
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
		<div className="space-y-4">
			{/* Master Toggle */}
			<div
				className="rounded-lg border p-4"
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
				<>
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
						className="sticky top-0 z-10 flex gap-1.5 py-2 px-1 -mx-1 rounded-lg overflow-x-auto"
						style={{ backgroundColor: theme.colors.bgSidebar }}
					>
						{MEMORY_SUB_TABS.map((tab) => {
							const isActive = activeSubTab === tab.id;
							const count = tab.getCount(stats);
							const Icon = tab.icon;
							return (
								<button
									key={tab.id}
									onClick={() => setActiveSubTab(tab.id)}
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap shrink-0"
									style={{
										backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
										color: isActive ? theme.colors.accent : theme.colors.textDim,
										border: `1px solid ${isActive ? theme.colors.accent : 'transparent'}`,
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

					{/* Active Sub-Tab Content */}
					{activeSubTab === 'personas' && (
						<PersonasTab
							theme={theme}
							config={config}
							stats={stats}
							projectPath={projectPath}
							onHierarchyChange={onHierarchyChange}
							onRefresh={refreshStats}
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
								// Switch to memories tab — the filter will be
								// handled by the user selecting the skill in the
								// Memories tab's own filter controls.
								void skillAreaId;
								setActiveSubTab('memories');
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
						/>
					)}
					{activeSubTab === 'status' && (
						<StatusTab theme={theme} config={config} stats={stats} projectPath={projectPath} />
					)}

					{/* Global Retrieval Settings */}
					<div
						className="rounded-lg border p-4 space-y-3"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Retrieval Settings
						</div>

						{/* Injection Strategy */}
						<div className="pb-2">
							<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
								Injection Strategy
							</div>
							<div className="text-xs mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
								Controls how aggressively memories are injected into agent prompts
							</div>
							<div className="flex gap-2">
								{(['lean', 'balanced', 'rich'] as const).map((strategy) => (
									<button
										key={strategy}
										onClick={() => updateConfig({ injectionStrategy: strategy })}
										className="flex-1 rounded-md border text-left"
										style={{
											padding: '8px 12px',
											borderColor:
												config.injectionStrategy === strategy
													? theme.colors.accent
													: theme.colors.border,
											background:
												config.injectionStrategy === strategy
													? `${theme.colors.accent}20`
													: 'transparent',
											color:
												config.injectionStrategy === strategy
													? theme.colors.accent
													: theme.colors.textMain,
											cursor: 'pointer',
											fontWeight: config.injectionStrategy === strategy ? 600 : 400,
										}}
									>
										<div className="text-xs">
											{strategy.charAt(0).toUpperCase() + strategy.slice(1)}
										</div>
										<div
											className="text-xs mt-0.5"
											style={{ color: theme.colors.textDim, fontSize: 10 }}
										>
											{strategy === 'lean' && '< 600 tokens, top 5 only'}
											{strategy === 'balanced' && `Up to ${config.maxTokenBudget} tokens`}
											{strategy === 'rich' && 'Up to 3000 tokens, full context'}
										</div>
									</button>
								))}
							</div>
						</div>

						<ConfigSlider
							label="Token Budget"
							description="Maximum tokens for memory injection per prompt"
							value={config.maxTokenBudget}
							min={500}
							max={5000}
							step={100}
							onChange={(v) => updateConfig({ maxTokenBudget: v })}
							theme={theme}
						/>

						<ConfigSlider
							label="Similarity Threshold"
							description="Minimum cosine similarity for memory relevance"
							value={config.similarityThreshold}
							min={0.1}
							max={0.95}
							step={0.05}
							onChange={(v) => updateConfig({ similarityThreshold: v })}
							theme={theme}
							formatValue={(v) => v.toFixed(2)}
						/>

						<ConfigSlider
							label="Persona Match Threshold"
							description="Minimum similarity for persona matching (coarser filter)"
							value={config.personaMatchThreshold}
							min={0.1}
							max={0.8}
							step={0.05}
							onChange={(v) => updateConfig({ personaMatchThreshold: v })}
							theme={theme}
							formatValue={(v) => v.toFixed(2)}
						/>

						<ConfigSlider
							label="Skill Match Threshold"
							description="Minimum similarity for skill area matching"
							value={config.skillMatchThreshold}
							min={0.2}
							max={0.9}
							step={0.05}
							onChange={(v) => updateConfig({ skillMatchThreshold: v })}
							theme={theme}
							formatValue={(v) => v.toFixed(2)}
						/>
					</div>

					{/* Global Storage & Maintenance */}
					<div
						className="rounded-lg border p-4 space-y-3"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Storage & Maintenance
						</div>

						<ConfigSlider
							label="Consolidation Threshold"
							description="Similarity threshold for merging duplicate memories"
							value={config.consolidationThreshold}
							min={0.5}
							max={0.99}
							step={0.01}
							onChange={(v) => updateConfig({ consolidationThreshold: v })}
							theme={theme}
							formatValue={(v) => v.toFixed(2)}
						/>

						<ConfigSlider
							label="Decay Half-Life (days)"
							description="Days until unreinforced memories lose half their confidence"
							value={config.decayHalfLifeDays}
							min={7}
							max={365}
							step={1}
							onChange={(v) => updateConfig({ decayHalfLifeDays: v })}
							theme={theme}
						/>

						<ConfigToggle
							label="Auto-Consolidation"
							description="Automatically merge similar memories during maintenance"
							checked={config.enableAutoConsolidation}
							onChange={(v) => updateConfig({ enableAutoConsolidation: v })}
							theme={theme}
						/>

						<ConfigToggle
							label="Effectiveness Tracking"
							description="Track how injected memories correlate with session outcomes"
							checked={config.enableEffectivenessTracking}
							onChange={(v) => updateConfig({ enableEffectivenessTracking: v })}
							theme={theme}
						/>
					</div>
				</>
			)}
		</div>
	);
}
