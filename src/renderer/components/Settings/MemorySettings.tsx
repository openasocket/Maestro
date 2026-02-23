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
	ArrowUpCircle,
	Check,
	Edit3,
	Pin,
	Activity,
	Archive,
	Link2,
	ChevronDown,
	ChevronUp,
	Zap,
	RotateCcw,
} from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	SkillAreaSuggestion,
	PersonaSuggestion,
	HierarchySuggestionResult,
	PromotionCandidate,
	MemoryScope,
	JobQueueStatus,
	TokenUsage,
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
	const [resetting, setResetting] = useState(false);
	const [confirmReset, setConfirmReset] = useState(false);
	const [suggestions, setSuggestions] = useState<HierarchySuggestionResult | null>(null);
	const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
	const [applyingSuggestion, setApplyingSuggestion] = useState<string | null>(null);
	const suggestionsLoaded = useRef(false);
	const [promotionCandidates, setPromotionCandidates] = useState<PromotionCandidate[]>([]);
	const [, setPromotionLoading] = useState(false);
	const [editingPromotionId, setEditingPromotionId] = useState<string | null>(null);
	const [editingRuleText, setEditingRuleText] = useState('');
	const [queueStatus, setQueueStatus] = useState<JobQueueStatus | null>(null);
	const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
	const [queueExpanded, setQueueExpanded] = useState(false);

	// Subscribe to queue status updates
	useEffect(() => {
		if (!config.enabled) return;

		const handler = (status: JobQueueStatus) => setQueueStatus(status);
		const cleanup = (window.maestro.memory as any).onJobQueueUpdate(handler);

		// Fetch initial status + token usage
		(window.maestro.memory as any).getJobQueueStatus?.().then((res: any) => {
			if (res?.success) setQueueStatus(res.data);
		});
		(window.maestro.memory as any).getTokenUsage?.().then((res: any) => {
			if (res?.success) setTokenUsage(res.data);
		});

		// Periodically refresh token usage (every 30s)
		const interval = setInterval(() => {
			(window.maestro.memory as any).getTokenUsage?.().then((res: any) => {
				if (res?.success) setTokenUsage(res.data);
			});
		}, 30000);

		return () => {
			cleanup?.();
			clearInterval(interval);
		};
	}, [config.enabled]);

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
			const statsRes = await window.maestro.memory.getAnalytics();
			if (statsRes.success) setStats(statsRes.data);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to seed defaults');
		} finally {
			setSeeding(false);
		}
	}, []);

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
			// Refresh stats
			const statsRes = await window.maestro.memory.getAnalytics();
			if (statsRes.success) setStats(statsRes.data);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to reset defaults');
		} finally {
			setResetting(false);
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
			const statsRes = await window.maestro.memory.getAnalytics();
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
			const statsRes = await window.maestro.memory.getAnalytics();
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

	// Load promotion candidates when memory system is enabled
	const loadPromotionCandidates = useCallback(async () => {
		try {
			const res = await window.maestro.memory.getPromotionCandidates();
			if (res.success) {
				setPromotionCandidates(res.data);
			}
		} catch {
			// Non-critical
		}
	}, []);

	useEffect(() => {
		if (!config.enabled) return;
		let mounted = true;
		const timer = setTimeout(async () => {
			if (!mounted) return;
			setPromotionLoading(true);
			await loadPromotionCandidates();
			if (mounted) setPromotionLoading(false);
		}, 300);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	}, [config.enabled, loadPromotionCandidates]);

	// Promotion action handlers
	const handlePromote = useCallback(
		async (candidate: PromotionCandidate, ruleText: string) => {
			try {
				const { memory } = candidate;
				const res = await window.maestro.memory.promote(
					memory.id,
					ruleText,
					memory.scope as MemoryScope,
					memory.skillAreaId,
					memory.experienceContext?.sourceProjectPath
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				setEditingPromotionId(null);
				await loadPromotionCandidates();
				// Refresh stats
				const statsRes = await window.maestro.memory.getAnalytics();
				if (statsRes.success) setStats(statsRes.data);
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to promote experience');
			}
		},
		[loadPromotionCandidates]
	);

	const handleDismissPromotion = useCallback(
		async (candidate: PromotionCandidate) => {
			try {
				const { memory } = candidate;
				const res = await window.maestro.memory.dismissPromotion(
					memory.id,
					memory.scope as MemoryScope,
					memory.skillAreaId,
					memory.experienceContext?.sourceProjectPath
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				await loadPromotionCandidates();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to dismiss promotion');
			}
		},
		[loadPromotionCandidates]
	);

	const handleKeepAsExperience = useCallback(
		async (candidate: PromotionCandidate) => {
			try {
				const { memory } = candidate;
				const res = await window.maestro.memory.update(
					memory.id,
					{ pinned: true },
					memory.scope as MemoryScope,
					memory.skillAreaId,
					memory.experienceContext?.sourceProjectPath
				);
				if (!res.success) {
					setError(res.error);
					return;
				}
				await loadPromotionCandidates();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to pin experience');
			}
		},
		[loadPromotionCandidates]
	);

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

			{/* Queue Status Indicator — shown when queue has items */}
			{config.enabled && queueStatus && queueStatus.queueLength > 0 && (
				<div className="rounded-lg border p-3" style={{ borderColor: theme.colors.border }}>
					{/* Collapsed view */}
					<button
						className="w-full flex items-center justify-between text-left"
						onClick={() => setQueueExpanded(!queueExpanded)}
					>
						<div className="flex items-center gap-2 flex-1 min-w-0">
							<Loader2
								className="w-3.5 h-3.5 animate-spin shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<div className="flex-1 min-w-0">
								<div className="text-xs" style={{ color: theme.colors.textMain }}>
									{queueStatus.currentActivity ?? 'Learning from recent session...'}
								</div>
								{/* Progress bar */}
								<div className="mt-1.5 flex items-center gap-2">
									<div
										className="flex-1 h-1.5 rounded-full overflow-hidden"
										style={{ backgroundColor: `${theme.colors.border}40` }}
									>
										<div
											className="h-full rounded-full transition-all duration-500"
											style={{
												backgroundColor: theme.colors.accent,
												width: queueStatus.estimatedSecondsRemaining
													? `${Math.max(10, 100 - (queueStatus.queueLength / Math.max(queueStatus.queueLength + 1, 1)) * 100)}%`
													: '50%',
											}}
										/>
									</div>
									<span className="text-xs shrink-0" style={{ color: theme.colors.textDim }}>
										{queueStatus.queueLength} task{queueStatus.queueLength !== 1 ? 's' : ''}{' '}
										remaining
										{queueStatus.estimatedSecondsRemaining
											? ` (~${queueStatus.estimatedSecondsRemaining}s)`
											: ''}
									</span>
								</div>
							</div>
						</div>
						{queueExpanded ? (
							<ChevronUp
								className="w-3.5 h-3.5 shrink-0 ml-2"
								style={{ color: theme.colors.textDim }}
							/>
						) : (
							<ChevronDown
								className="w-3.5 h-3.5 shrink-0 ml-2"
								style={{ color: theme.colors.textDim }}
							/>
						)}
					</button>

					{/* Expanded detail view */}
					{queueExpanded && (
						<div
							className="mt-3 pt-3 border-t space-y-2"
							style={{ borderColor: theme.colors.border }}
						>
							{queueStatus.currentJob && (
								<div
									className="flex items-center gap-1.5 text-xs"
									style={{ color: theme.colors.textMain }}
								>
									<span style={{ color: theme.colors.accent }}>●</span>
									{queueStatus.currentActivity}
								</div>
							)}
							{queueStatus.queueLength > 0 && (
								<div className="text-xs" style={{ color: theme.colors.textDim }}>
									{queueStatus.queueLength} job{queueStatus.queueLength !== 1 ? 's' : ''} queued
								</div>
							)}

							{/* Token usage section */}
							{tokenUsage &&
								(tokenUsage.extractionTokens > 0 || tokenUsage.injectionTokens > 0) && (
									<div className="pt-2 space-y-1">
										<div
											className="flex items-center gap-1.5 text-xs"
											style={{ color: theme.colors.textDim }}
										>
											<Zap className="w-3 h-3" />
											Token usage (24h)
										</div>
										{tokenUsage.extractionTokens > 0 && (
											<div className="text-xs" style={{ color: theme.colors.textMain }}>
												Extraction: {tokenUsage.extractionTokens.toLocaleString()} tokens (
												{tokenUsage.extractionCalls} call
												{tokenUsage.extractionCalls !== 1 ? 's' : ''}) · $
												{tokenUsage.estimatedCostUsd.toFixed(2)}
											</div>
										)}
										{tokenUsage.injectionTokens > 0 && (
											<div className="text-xs" style={{ color: theme.colors.textMain }}>
												Injection: {tokenUsage.injectionTokens.toLocaleString()} tokens
											</div>
										)}
										<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
											Total:{' '}
											{(tokenUsage.extractionTokens + tokenUsage.injectionTokens).toLocaleString()}{' '}
											tokens · ${tokenUsage.estimatedCostUsd.toFixed(2)}
										</div>
									</div>
								)}
						</div>
					)}
				</div>
			)}

			{/* Config panel — shown when enabled */}
			{config.enabled && (
				<>
					{/* Seed Defaults Button — always shown; merges missing roles when some already exist */}
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

					{/* Reset All Defaults Button — resets seed roles/personas to original values */}
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

					{/* Background Processing */}
					<div
						className="rounded-lg border p-4 space-y-3"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Background Processing
						</div>

						<ConfigToggle
							label="Background Experience Extraction"
							description="Analyze sessions after completion to extract learnings (uses LLM tokens)"
							checked={config.enableExperienceExtraction}
							onChange={(v) => updateConfig({ enableExperienceExtraction: v })}
							theme={theme}
						/>

						<ConfigSlider
							label="Extraction Cooldown"
							description="Minimum time between analyses per project"
							value={config.analysisCooldownMs / 60000}
							min={1}
							max={30}
							step={1}
							onChange={(v) => updateConfig({ analysisCooldownMs: v * 60000 })}
							theme={theme}
							formatValue={(v) => `${v} min`}
						/>

						<ConfigToggle
							label="Auto-Consolidation"
							description="Automatically merge similar memories (saves tokens on injection)"
							checked={config.enableAutoConsolidation}
							onChange={(v) => updateConfig({ enableAutoConsolidation: v })}
							theme={theme}
						/>
					</div>

					{/* Promotion Candidates */}
					{promotionCandidates.length > 0 && (
						<PromotionSection
							theme={theme}
							candidates={promotionCandidates}
							editingId={editingPromotionId}
							editingText={editingRuleText}
							onEditTextChange={setEditingRuleText}
							onStartEdit={(id, text) => {
								setEditingPromotionId(id);
								setEditingRuleText(text);
							}}
							onCancelEdit={() => setEditingPromotionId(null)}
							onApprove={(c, text) => handlePromote(c, text)}
							onDismiss={handleDismissPromotion}
							onKeep={handleKeepAsExperience}
						/>
					)}

					{/* Memory Health */}
					{stats && (
						<MemoryHealthPanel
							stats={stats}
							theme={theme}
							promotionCandidatesCount={promotionCandidates.length}
						/>
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
 * Memory Health panel — effectiveness distribution, injection stats, categories.
 */
function MemoryHealthPanel({
	stats,
	theme,
	promotionCandidatesCount,
}: {
	stats: MemoryStats;
	theme: Theme;
	promotionCandidatesCount: number;
}) {
	const dist = stats.effectivenessDistribution;
	const total = dist.high + dist.medium + dist.low + dist.unscored;
	const highPct = total > 0 ? (dist.high / total) * 100 : 0;
	const medPct = total > 0 ? (dist.medium / total) * 100 : 0;
	const lowPct = total > 0 ? (dist.low / total) * 100 : 0;
	const unscoredPct = total > 0 ? (dist.unscored / total) * 100 : 0;

	const categoryEntries = Object.entries(stats.byCategory).sort(([, a], [, b]) => b - a);

	return (
		<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
			<div className="flex items-center gap-2">
				<Activity className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					Memory Health
				</div>
			</div>

			{/* Effectiveness Distribution Bar */}
			{total > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Effectiveness Distribution
					</div>
					<div
						className="flex h-3 rounded-full overflow-hidden"
						style={{ backgroundColor: `${theme.colors.border}40` }}
					>
						{highPct > 0 && (
							<div
								style={{ width: `${highPct}%`, backgroundColor: '#22c55e' }}
								title={`High: ${dist.high}`}
							/>
						)}
						{medPct > 0 && (
							<div
								style={{ width: `${medPct}%`, backgroundColor: '#eab308' }}
								title={`Medium: ${dist.medium}`}
							/>
						)}
						{lowPct > 0 && (
							<div
								style={{ width: `${lowPct}%`, backgroundColor: '#ef4444' }}
								title={`Low: ${dist.low}`}
							/>
						)}
						{unscoredPct > 0 && (
							<div
								style={{ width: `${unscoredPct}%`, backgroundColor: '#6b7280' }}
								title={`Unscored: ${dist.unscored}`}
							/>
						)}
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						High: {dist.high} | Medium: {dist.medium} | Low: {dist.low} | Unscored: {dist.unscored}
					</div>
				</div>
			)}

			{/* Warning items */}
			<div className="space-y-1">
				{stats.neverInjectedCount > 0 && (
					<div className="flex items-center gap-1.5 text-xs" style={{ color: '#eab308' }}>
						<AlertTriangle className="w-3 h-3" />
						{stats.neverInjectedCount} memories never injected
					</div>
				)}
				{(promotionCandidatesCount > 0 || stats.promotionCandidates > 0) && (
					<div className="flex items-center gap-1.5 text-xs" style={{ color: theme.colors.accent }}>
						<ArrowUpCircle className="w-3 h-3" />
						{promotionCandidatesCount || stats.promotionCandidates} experiences ready for promotion
					</div>
				)}
				{stats.archivedCount > 0 && (
					<div
						className="flex items-center gap-1.5 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<Archive className="w-3 h-3" />
						{stats.archivedCount} archived memories
					</div>
				)}
			</div>

			{/* Recent Activity */}
			<div className="space-y-1">
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Recent Activity (7 days)
				</div>
				<div className="text-xs" style={{ color: theme.colors.textMain }}>
					{stats.recentInjections} injections
					{stats.avgTokensPerInjection > 0 && (
						<> | avg {stats.avgTokensPerInjection.toLocaleString()} tokens/injection</>
					)}
				</div>
				{stats.totalLinks > 0 && (
					<div className="flex items-center gap-1 text-xs" style={{ color: theme.colors.textDim }}>
						<Link2 className="w-3 h-3" />
						{stats.totalLinks} inter-memory links
					</div>
				)}
			</div>

			{/* Categories */}
			{categoryEntries.length > 0 && (
				<div className="space-y-1">
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Categories
					</div>
					<div className="text-xs" style={{ color: theme.colors.textMain }}>
						{categoryEntries.map(([cat, count], i) => (
							<span key={cat}>
								{i > 0 && ' | '}
								{cat}: {count}
							</span>
						))}
					</div>
				</div>
			)}

			{/* Footer: hierarchy counts */}
			<div
				className="pt-2 border-t text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Roles: {stats.totalRoles} | Personas: {stats.totalPersonas} | Skills:{' '}
				{stats.totalSkillAreas} | Total: {stats.totalMemories}
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
 * Promotion candidates section — shows experiences ready for promotion to rules.
 */
function PromotionSection({
	theme,
	candidates,
	editingId,
	editingText,
	onEditTextChange,
	onStartEdit,
	onCancelEdit,
	onApprove,
	onDismiss,
	onKeep,
}: {
	theme: Theme;
	candidates: PromotionCandidate[];
	editingId: string | null;
	editingText: string;
	onEditTextChange: (text: string) => void;
	onStartEdit: (id: string, text: string) => void;
	onCancelEdit: () => void;
	onApprove: (candidate: PromotionCandidate, ruleText: string) => void;
	onDismiss: (candidate: PromotionCandidate) => void;
	onKeep: (candidate: PromotionCandidate) => void;
}) {
	return (
		<div
			className="rounded-lg border p-4 space-y-3"
			style={{
				borderColor: theme.colors.accent,
				backgroundColor: `${theme.colors.accent}08`,
			}}
		>
			<div className="flex items-center gap-2">
				<ArrowUpCircle className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
					{candidates.length} experience{candidates.length !== 1 ? 's' : ''} ready for promotion
				</div>
			</div>

			{candidates.map((candidate) => {
				const { memory } = candidate;
				const isEditing = editingId === memory.id;
				return (
					<div
						key={memory.id}
						className="rounded border p-3 space-y-2"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="text-xs" style={{ color: theme.colors.textMain }}>
							{memory.content.length > 120 ? memory.content.slice(0, 120) + '...' : memory.content}
						</div>
						<div className="text-xs font-mono" style={{ color: theme.colors.textDim }}>
							eff: {(memory.effectivenessScore * 100).toFixed(0)}% | used {memory.useCount}x |
							confidence: {(memory.confidence * 100).toFixed(0)}%
						</div>

						{isEditing ? (
							<div className="space-y-2">
								<textarea
									className="w-full rounded border p-2 text-xs font-mono resize-none"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: `${theme.colors.border}20`,
										color: theme.colors.textMain,
										outline: 'none',
									}}
									rows={3}
									value={editingText}
									onChange={(e) => onEditTextChange(e.target.value)}
								/>
								<div className="flex gap-2">
									<button
										className="px-3 py-1 rounded text-xs font-medium border"
										style={{
											borderColor: theme.colors.accent,
											color: theme.colors.accent,
											backgroundColor: `${theme.colors.accent}10`,
										}}
										onClick={() => onApprove(candidate, editingText)}
									>
										<Check className="w-3 h-3 inline mr-1" />
										Confirm
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={onCancelEdit}
									>
										Cancel
									</button>
								</div>
							</div>
						) : (
							<>
								<div className="text-xs" style={{ color: theme.colors.accent }}>
									Suggested rule: &ldquo;
									{candidate.suggestedRuleText.length > 100
										? candidate.suggestedRuleText.slice(0, 100) + '...'
										: candidate.suggestedRuleText}
									&rdquo;
								</div>
								<div className="flex gap-2">
									<button
										className="px-3 py-1 rounded text-xs font-medium border"
										style={{
											borderColor: theme.colors.accent,
											color: theme.colors.accent,
											backgroundColor: `${theme.colors.accent}10`,
										}}
										onClick={() => onApprove(candidate, candidate.suggestedRuleText)}
									>
										<Check className="w-3 h-3 inline mr-1" />
										Approve
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onStartEdit(memory.id, candidate.suggestedRuleText)}
									>
										<Edit3 className="w-3 h-3 inline mr-1" />
										Edit & Approve
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onDismiss(candidate)}
									>
										<X className="w-3 h-3 inline mr-1" />
										Dismiss
									</button>
									<button
										className="px-3 py-1 rounded text-xs border"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textDim,
										}}
										onClick={() => onKeep(candidate)}
									>
										<Pin className="w-3 h-3 inline mr-1" />
										Keep as XP
									</button>
								</div>
							</>
						)}
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
