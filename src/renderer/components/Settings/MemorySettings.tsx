/**
 * MemorySettings - Agent Experiences memory system configuration panel.
 *
 * Master toggle + config inputs for the hierarchical memory system.
 * Same pattern as other settings panels (toggles, sliders, stats display).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
	Brain,
	Loader2,
	Sparkles,
	AlertTriangle,
	Database,
	Lightbulb,
	Plus,
	X,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	SkillAreaSuggestion,
	PersonaSuggestion,
	HierarchySuggestionResult,
} from '../../../shared/memory-types';
import { MEMORY_CONFIG_DEFAULTS } from '../../../shared/memory-types';

interface MemorySettingsProps {
	theme: Theme;
	projectPath?: string | null;
}

/**
 * Reusable slider row for numeric config values.
 */
function ConfigSlider({
	label,
	description,
	value,
	min,
	max,
	step,
	onChange,
	theme,
	formatValue,
}: {
	label: string;
	description: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onChange: (value: number) => void;
	theme: Theme;
	formatValue?: (v: number) => string;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{label}
				</div>
				<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<div className="flex items-center gap-2 shrink-0">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="w-24 h-1 rounded-full appearance-none cursor-pointer"
					style={{ accentColor: theme.colors.accent }}
				/>
				<span
					className="text-xs font-mono w-12 text-right"
					style={{ color: theme.colors.textMain }}
				>
					{formatValue ? formatValue(value) : value}
				</span>
			</div>
		</div>
	);
}

/**
 * Toggle row for boolean config values.
 */
function ConfigToggle({
	label,
	description,
	checked,
	onChange,
	theme,
}: {
	label: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
	theme: Theme;
}) {
	return (
		<button
			className="w-full flex items-center justify-between py-2 text-left"
			onClick={() => onChange(!checked)}
		>
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					{label}
				</div>
				<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
					{description}
				</div>
			</div>
			<div
				className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ml-3 ${checked ? '' : 'opacity-50'}`}
				style={{ backgroundColor: checked ? theme.colors.accent : theme.colors.border }}
			>
				<div
					className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
					style={{ transform: checked ? 'translateX(17px)' : 'translateX(2px)' }}
				/>
			</div>
		</button>
	);
}

export function MemorySettings({ theme, projectPath }: MemorySettingsProps): React.ReactElement {
	const [config, setConfig] = useState<MemoryConfig>(MEMORY_CONFIG_DEFAULTS);
	const [stats, setStats] = useState<MemoryStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hasRoles, setHasRoles] = useState(true);
	const [seeding, setSeeding] = useState(false);
	const [suggestions, setSuggestions] = useState<HierarchySuggestionResult | null>(null);
	const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
	const [applyingSuggestion, setApplyingSuggestion] = useState<string | null>(null);
	const suggestionsLoaded = useRef(false);

	// Load config and stats on mount
	useEffect(() => {
		let mounted = true;
		(async () => {
			try {
				const [configRes, statsRes, rolesRes] = await Promise.all([
					window.maestro.memory.getConfig(),
					window.maestro.memory.getStats(),
					window.maestro.memory.role.list(),
				]);
				if (!mounted) return;

				if (configRes.success) setConfig(configRes.data);
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

	// Persist config changes with debounce
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
			// Refresh stats
			const statsRes = await window.maestro.memory.getStats();
			if (statsRes.success) setStats(statsRes.data);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to seed defaults');
		} finally {
			setSeeding(false);
		}
	}, []);

	// Load hierarchy suggestions when memory system is enabled and projectPath available
	useEffect(() => {
		if (!config.enabled || !projectPath || suggestionsLoaded.current) return;
		let mounted = true;
		const timer = setTimeout(async () => {
			try {
				const res = await window.maestro.memory.suggestHierarchy(projectPath);
				if (!mounted) return;
				if (res.success) {
					setSuggestions(res.data);
					suggestionsLoaded.current = true;
				}
			} catch {
				// Non-critical — silently degrade
			}
		}, 500); // debounce
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	}, [config.enabled, projectPath]);

	// Apply persona suggestion
	const handleApplyPersona = useCallback(async (suggestion: PersonaSuggestion) => {
		const key = `persona:${suggestion.suggestedName}`;
		setApplyingSuggestion(key);
		try {
			let roleId = suggestion.suggestedRoleId;
			if (!roleId) {
				// Create the role first
				const roleRes = await window.maestro.memory.role.create(
					suggestion.suggestedRoleName,
					`${suggestion.suggestedRoleName} role`
				);
				if (!roleRes.success) {
					setError(roleRes.error);
					return;
				}
				roleId = roleRes.data.id;
			}
			const personaRes = await window.maestro.memory.persona.create(
				roleId,
				suggestion.suggestedName,
				suggestion.suggestedDescription
			);
			if (!personaRes.success) {
				setError(personaRes.error);
				return;
			}
			// Create suggested skill areas
			for (const skillName of suggestion.suggestedSkills) {
				await window.maestro.memory.skill.create(
					personaRes.data.id,
					skillName,
					`${skillName} expertise`
				);
			}
			// Dismiss the suggestion
			setDismissedSuggestions((prev) => new Set([...prev, key]));
			// Refresh stats
			const statsRes = await window.maestro.memory.getStats();
			if (statsRes.success) setStats(statsRes.data);
			setHasRoles(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create persona');
		} finally {
			setApplyingSuggestion(null);
		}
	}, []);

	// Apply skill area suggestion
	const handleApplySkillArea = useCallback(async (suggestion: SkillAreaSuggestion) => {
		const key = `skill:${suggestion.suggestedName}`;
		setApplyingSuggestion(key);
		try {
			const skillRes = await window.maestro.memory.skill.create(
				suggestion.suggestedPersonaId,
				suggestion.suggestedName,
				suggestion.suggestedDescription
			);
			if (!skillRes.success) {
				setError(skillRes.error);
				return;
			}
			// Move memories to the new skill area — re-add them in skill scope
			// (project memories stay as-is; this creates linked skill copies)
			setDismissedSuggestions((prev) => new Set([...prev, key]));
			// Refresh stats
			const statsRes = await window.maestro.memory.getStats();
			if (statsRes.success) setStats(statsRes.data);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create skill area');
		} finally {
			setApplyingSuggestion(null);
		}
	}, []);

	// Dismiss a suggestion
	const handleDismissSuggestion = useCallback((key: string) => {
		setDismissedSuggestions((prev) => new Set([...prev, key]));
	}, []);

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
					{/* Seed Defaults Button — shown only when no roles exist */}
					{!hasRoles && (
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
							{seeding ? 'Creating default hierarchy...' : 'Seed Default Roles & Personas'}
						</button>
					)}

					{/* Configuration Inputs */}
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

					<div
						className="rounded-lg border p-4 space-y-3"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Storage & Maintenance
						</div>

						<ConfigSlider
							label="Max Memories per Skill Area"
							description="Prune oldest memories above this limit"
							value={config.maxMemoriesPerSkillArea}
							min={10}
							max={200}
							step={10}
							onChange={(v) => updateConfig({ maxMemoriesPerSkillArea: v })}
							theme={theme}
						/>

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

					{/* Stats Display */}
					{stats && (
						<div
							className="rounded-lg border p-4 space-y-2"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2 mb-2">
								<Database className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
									Statistics
								</div>
							</div>

							<div className="grid grid-cols-3 gap-2">
								<StatCell label="Roles" value={stats.totalRoles} theme={theme} />
								<StatCell label="Personas" value={stats.totalPersonas} theme={theme} />
								<StatCell label="Skill Areas" value={stats.totalSkillAreas} theme={theme} />
								<StatCell label="Memories" value={stats.totalMemories} theme={theme} />
								<StatCell label="Injections" value={stats.totalInjections} theme={theme} />
								<StatCell
									label="Avg Effectiveness"
									value={
										stats.averageEffectiveness > 0
											? `${(stats.averageEffectiveness * 100).toFixed(0)}%`
											: '—'
									}
									theme={theme}
								/>
							</div>
						</div>
					)}

					{/* Hierarchy Suggestions */}
					<HierarchySuggestions
						theme={theme}
						suggestions={suggestions}
						dismissedSuggestions={dismissedSuggestions}
						applyingSuggestion={applyingSuggestion}
						onApplyPersona={handleApplyPersona}
						onApplySkillArea={handleApplySkillArea}
						onDismiss={handleDismissSuggestion}
					/>

					{/* Embedding Model Status — reuse grpo:getModelStatus since model is shared */}
					<EmbeddingModelStatus theme={theme} />
				</>
			)}
		</div>
	);
}

/**
 * Stats cell component.
 */
function StatCell({
	label,
	value,
	theme,
}: {
	label: string;
	value: number | string;
	theme: Theme;
}) {
	return (
		<div
			className="rounded p-2 text-center"
			style={{ backgroundColor: `${theme.colors.border}40` }}
		>
			<div className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
				{value}
			</div>
			<div className="text-xs" style={{ color: theme.colors.textDim }}>
				{label}
			</div>
		</div>
	);
}

/**
 * Hierarchy suggestions section — shows persona and skill area suggestions.
 */
function HierarchySuggestions({
	theme,
	suggestions,
	dismissedSuggestions,
	applyingSuggestion,
	onApplyPersona,
	onApplySkillArea,
	onDismiss,
}: {
	theme: Theme;
	suggestions: HierarchySuggestionResult | null;
	dismissedSuggestions: Set<string>;
	applyingSuggestion: string | null;
	onApplyPersona: (s: PersonaSuggestion) => void;
	onApplySkillArea: (s: SkillAreaSuggestion) => void;
	onDismiss: (key: string) => void;
}) {
	if (!suggestions) return null;

	const visiblePersonas = suggestions.personaSuggestions.filter(
		(s) => !dismissedSuggestions.has(`persona:${s.suggestedName}`)
	);
	const visibleSkills = suggestions.skillSuggestions.filter(
		(s) => !dismissedSuggestions.has(`skill:${s.suggestedName}`)
	);

	if (visiblePersonas.length === 0 && visibleSkills.length === 0) return null;

	return (
		<div
			className="rounded-lg border p-4 space-y-3"
			style={{ borderColor: theme.colors.accent, backgroundColor: `${theme.colors.accent}08` }}
		>
			<div className="flex items-center gap-2">
				<Lightbulb className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Suggestions for this project
				</div>
			</div>

			{visiblePersonas.map((suggestion) => {
				const key = `persona:${suggestion.suggestedName}`;
				const isApplying = applyingSuggestion === key;
				return (
					<div
						key={key}
						className="rounded border p-3 space-y-1.5"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Add persona: "{suggestion.suggestedName}"
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Evidence: {suggestion.evidence.join(', ')}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Skills: {suggestion.suggestedSkills.join(', ')}
						</div>
						<div className="flex gap-2 mt-2">
							<button
								className="px-3 py-1 rounded text-xs font-medium border"
								style={{
									borderColor: theme.colors.accent,
									color: theme.colors.accent,
									backgroundColor: `${theme.colors.accent}10`,
								}}
								onClick={() => onApplyPersona(suggestion)}
								disabled={isApplying}
							>
								{isApplying ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<Plus className="w-3 h-3 inline mr-1" />
								)}
								Add
							</button>
							<button
								className="px-3 py-1 rounded text-xs border"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textDim,
								}}
								onClick={() => onDismiss(key)}
								disabled={isApplying}
							>
								<X className="w-3 h-3 inline mr-1" />
								Dismiss
							</button>
						</div>
					</div>
				);
			})}

			{visibleSkills.map((suggestion) => {
				const key = `skill:${suggestion.suggestedName}`;
				const isApplying = applyingSuggestion === key;
				return (
					<div
						key={key}
						className="rounded border p-3 space-y-1.5"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							New skill area: "{suggestion.suggestedName}"
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Under: {suggestion.suggestedPersonaName}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Contains: {suggestion.memoryIds.length} related project memories
						</div>
						<div className="flex gap-2 mt-2">
							<button
								className="px-3 py-1 rounded text-xs font-medium border"
								style={{
									borderColor: theme.colors.accent,
									color: theme.colors.accent,
									backgroundColor: `${theme.colors.accent}10`,
								}}
								onClick={() => onApplySkillArea(suggestion)}
								disabled={isApplying}
							>
								{isApplying ? (
									<Loader2 className="w-3 h-3 animate-spin inline mr-1" />
								) : (
									<Plus className="w-3 h-3 inline mr-1" />
								)}
								Create
							</button>
							<button
								className="px-3 py-1 rounded text-xs border"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textDim,
								}}
								onClick={() => onDismiss(key)}
								disabled={isApplying}
							>
								<X className="w-3 h-3 inline mr-1" />
								Dismiss
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}

/**
 * Embedding model status display.
 * Reuses grpo:getModelStatus since the embedding model is shared.
 */
function EmbeddingModelStatus({ theme }: { theme: Theme }) {
	const [status, setStatus] = useState<{
		loaded: boolean;
		modelName: string;
		dimensions: number;
	} | null>(null);

	useEffect(() => {
		let mounted = true;
		// Try to get model status from the shared embedding service
		window.maestro.settings
			.get('grpo:modelStatus')
			.then((result) => {
				if (mounted && result && typeof result === 'object') {
					setStatus(result as { loaded: boolean; modelName: string; dimensions: number });
				}
			})
			.catch(() => {
				// Embedding service may not be initialized yet
			});
		return () => {
			mounted = false;
		};
	}, []);

	if (!status) return null;

	return (
		<div
			className="rounded-lg border p-3 flex items-center gap-3"
			style={{ borderColor: theme.colors.border }}
		>
			<div className={`w-2 h-2 rounded-full ${status.loaded ? 'bg-green-500' : 'bg-yellow-500'}`} />
			<div className="flex-1 min-w-0">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Embedding Model
				</div>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					{status.loaded ? `${status.modelName} (${status.dimensions}d)` : 'Not loaded'}
				</div>
			</div>
		</div>
	);
}
