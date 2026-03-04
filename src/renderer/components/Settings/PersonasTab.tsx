/**
 * PersonasTab - Personas sub-tab within MemorySettings.
 *
 * Contains: hierarchy suggestions (persona + skill area) with apply/dismiss actions.
 * Full persona tree browser integration comes in MEM-TAB-02.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Users, Lightbulb, Plus, X, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import type {
	MemoryConfig,
	MemoryStats,
	PersonaSuggestion,
	SkillAreaSuggestion,
	HierarchySuggestionResult,
} from '../../../shared/memory-types';
import { TabDescriptionBanner } from './TabDescriptionBanner';

export interface PersonasTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onHierarchyChange?: () => void;
	onRefresh: () => Promise<void>;
}

export function PersonasTab({
	theme,
	config,
	stats,
	projectPath,
	onHierarchyChange,
	onRefresh,
}: PersonasTabProps): React.ReactElement {
	const [suggestions, setSuggestions] = useState<HierarchySuggestionResult | null>(null);
	const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
	const [applyingSuggestion, setApplyingSuggestion] = useState<string | null>(null);
	const suggestionsLoaded = useRef(false);
	const [error, setError] = useState<string | null>(null);

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
		}, 500);
		return () => {
			mounted = false;
			clearTimeout(timer);
		};
	}, [config.enabled, projectPath]);

	// Apply persona suggestion
	const handleApplyPersona = useCallback(
		async (suggestion: PersonaSuggestion) => {
			const key = `persona:${suggestion.suggestedName}`;
			setApplyingSuggestion(key);
			try {
				let roleId = suggestion.suggestedRoleId;
				if (!roleId) {
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
				for (const skillName of suggestion.suggestedSkills) {
					await window.maestro.memory.skill.create(
						personaRes.data.id,
						skillName,
						`${skillName} expertise`
					);
				}
				setDismissedSuggestions((prev) => new Set([...prev, key]));
				await onRefresh();
				onHierarchyChange?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create persona');
			} finally {
				setApplyingSuggestion(null);
			}
		},
		[onHierarchyChange, onRefresh]
	);

	// Apply skill area suggestion
	const handleApplySkillArea = useCallback(
		async (suggestion: SkillAreaSuggestion) => {
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
				setDismissedSuggestions((prev) => new Set([...prev, key]));
				await onRefresh();
				onHierarchyChange?.();
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to create skill area');
			} finally {
				setApplyingSuggestion(null);
			}
		},
		[onHierarchyChange, onRefresh]
	);

	const handleDismissSuggestion = useCallback((key: string) => {
		setDismissedSuggestions((prev) => new Set([...prev, key]));
	}, []);

	// Filter visible suggestions
	const visiblePersonas =
		suggestions?.personaSuggestions.filter(
			(s) => !dismissedSuggestions.has(`persona:${s.suggestedName}`)
		) ?? [];
	const visibleSkills =
		suggestions?.skillSuggestions.filter(
			(s) => !dismissedSuggestions.has(`skill:${s.suggestedName}`)
		) ?? [];
	const hasSuggestions = visiblePersonas.length > 0 || visibleSkills.length > 0;

	return (
		<div className="space-y-4">
			<TabDescriptionBanner
				theme={theme}
				description="Personas are expert profiles that shape how your AI agents think and respond. Each persona has specialized knowledge areas and a behavioral style. When a task matches a persona's expertise, relevant memories are automatically injected."
			/>

			{error && (
				<div
					className="flex items-center gap-2 p-3 rounded-lg text-xs"
					style={{ backgroundColor: `${theme.colors.error}15`, color: theme.colors.error }}
				>
					{error}
				</div>
			)}

			{/* Hierarchy Suggestions */}
			{hasSuggestions && (
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
									Add persona: &ldquo;{suggestion.suggestedName}&rdquo;
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
										onClick={() => handleApplyPersona(suggestion)}
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
										onClick={() => handleDismissSuggestion(key)}
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
									New skill area: &ldquo;{suggestion.suggestedName}&rdquo;
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
										onClick={() => handleApplySkillArea(suggestion)}
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
										onClick={() => handleDismissSuggestion(key)}
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
			)}

			{/* Stats summary */}
			{stats && (
				<div
					className="rounded-lg border p-4 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Users className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Persona Overview
						</div>
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Roles: {stats.totalRoles} | Personas: {stats.totalPersonas} | Skills:{' '}
						{stats.totalSkillAreas}
					</div>
				</div>
			)}

			{/* Placeholder for persona tree browser (MEM-TAB-02) */}
			{!hasSuggestions && !stats && (
				<div
					className="flex flex-col items-center justify-center py-12 gap-3"
					style={{ color: theme.colors.textDim }}
				>
					<Users className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
					<div className="text-xs font-medium">Persona tree browser coming in MEM-TAB-02</div>
				</div>
			)}
		</div>
	);
}
