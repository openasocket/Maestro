/**
 * MemoriesTab - Memories sub-tab within MemorySettings.
 *
 * Contains: memory lifecycle config (decay rate, min threshold, prune controls).
 * MemoryLibraryPanel integration comes in MEM-TAB-05.
 * Moved from MemorySettings.tsx during MEM-TAB-01 redistribution.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Brain, Timer, Scissors, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats, MemoryEntry } from '../../../shared/memory-types';
import { ConfigSlider } from './MemoryConfigWidgets';

export interface MemoriesTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	projectPath?: string | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	onRefresh: () => Promise<void>;
}

export function MemoriesTab({
	theme,
	config,
	stats,
	projectPath,
	onUpdateConfig,
	onRefresh,
}: MemoriesTabProps): React.ReactElement {
	const [allMemories, setAllMemories] = useState<MemoryEntry[]>([]);
	const [pruneConfirm, setPruneConfirm] = useState(false);
	const [pruning, setPruning] = useState(false);
	const [pruneProgress, setPruneProgress] = useState<{ done: number; total: number } | null>(null);

	// Load all memories for lifecycle stats
	useEffect(() => {
		if (!config.enabled) return;
		let mounted = true;
		window.maestro.memory
			.listAllExperiences(projectPath ?? undefined)
			.then((res) => {
				if (mounted && res.success) setAllMemories(res.data);
			})
			.catch(() => {});
		return () => {
			mounted = false;
		};
	}, [config.enabled, projectPath, stats]);

	const prunableMemories = allMemories.filter(
		(m) => m.active && !m.archived && !m.pinned && m.confidence < config.minConfidenceThreshold
	);
	const atRiskMemories = allMemories.filter(
		(m) =>
			m.active &&
			!m.archived &&
			!m.pinned &&
			m.confidence < config.minConfidenceThreshold * 2 &&
			m.confidence >= config.minConfidenceThreshold
	);

	const handlePruneMemories = useCallback(async () => {
		setPruning(true);
		setPruneProgress({ done: 0, total: prunableMemories.length });
		try {
			for (let i = 0; i < prunableMemories.length; i++) {
				const m = prunableMemories[i];
				await window.maestro.memory.update(
					m.id,
					{ active: false },
					m.scope,
					m.skillAreaId,
					undefined
				);
				setPruneProgress({ done: i + 1, total: prunableMemories.length });
			}
			await onRefresh();
		} catch {
			// Error handled by parent via stats refresh
		} finally {
			setPruning(false);
			setPruneConfirm(false);
			setPruneProgress(null);
		}
	}, [prunableMemories, onRefresh]);

	return (
		<div className="space-y-4">
			{/* Memory stats summary */}
			{stats && (
				<div
					className="rounded-lg border p-4 space-y-2"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<Brain className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
						<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Memory Overview
						</div>
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Total: {stats.totalMemories} | Rules: {stats.byType?.rule ?? 0} | Experiences:{' '}
						{stats.byType?.experience ?? 0}
					</div>
					{atRiskMemories.length > 0 && (
						<div className="text-xs" style={{ color: '#eab308' }}>
							{atRiskMemories.length} memories approaching archive threshold
						</div>
					)}
				</div>
			)}

			{/* Memory Lifecycle */}
			<div className="rounded-lg border p-4 space-y-3" style={{ borderColor: theme.colors.border }}>
				<div className="flex items-center gap-2">
					<Timer className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					<div className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Memory Lifecycle
					</div>
				</div>

				<ConfigSlider
					label="Confidence Decay Rate"
					description="How much confidence decreases per day for unused memories (0 = no decay)"
					value={config.confidenceDecayRate}
					min={0}
					max={0.1}
					step={0.005}
					onChange={(v) => onUpdateConfig({ confidenceDecayRate: v })}
					theme={theme}
					formatValue={(v) => v.toFixed(3)}
				/>

				<ConfigSlider
					label="Auto-Archive Threshold"
					description="Memories below this confidence are automatically archived"
					value={config.minConfidenceThreshold}
					min={0}
					max={0.5}
					step={0.05}
					onChange={(v) => onUpdateConfig({ minConfidenceThreshold: v })}
					theme={theme}
					formatValue={(v) => v.toFixed(2)}
				/>

				<ConfigSlider
					label="Max Memories Per Skill"
					description="Oldest memories are evicted when a skill area exceeds this count"
					value={config.maxMemoriesPerSkillArea}
					min={10}
					max={200}
					step={10}
					onChange={(v) => onUpdateConfig({ maxMemoriesPerSkillArea: v })}
					theme={theme}
				/>

				{/* Prune Now */}
				<div className="pt-2 border-t" style={{ borderColor: theme.colors.border }}>
					{!pruneConfirm ? (
						<button
							className="flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs transition-colors"
							style={{
								color: theme.colors.textDim,
								backgroundColor: `${theme.colors.border}40`,
							}}
							onClick={() => setPruneConfirm(true)}
							disabled={pruning || prunableMemories.length === 0}
							title={
								prunableMemories.length === 0
									? 'No memories below threshold'
									: `${prunableMemories.length} memories below ${config.minConfidenceThreshold} confidence`
							}
						>
							<Scissors className="w-3 h-3" />
							Prune Low-Confidence Memories
							{prunableMemories.length > 0 && (
								<span
									className="ml-1 px-1.5 py-0.5 rounded-full text-xs"
									style={{ backgroundColor: `${theme.colors.border}60` }}
								>
									{prunableMemories.length}
								</span>
							)}
						</button>
					) : pruning ? (
						<div
							className="flex items-center gap-2 text-xs"
							style={{ color: theme.colors.textDim }}
						>
							<Loader2 className="w-3 h-3 animate-spin" />
							{pruneProgress
								? `Pruning... ${pruneProgress.done}/${pruneProgress.total}`
								: 'Pruning...'}
						</div>
					) : (
						<div className="space-y-2">
							<div className="text-xs" style={{ color: theme.colors.textMain }}>
								Archive {prunableMemories.length} memories below {config.minConfidenceThreshold}{' '}
								confidence?
							</div>
							<div className="flex gap-2">
								<button
									className="px-2.5 py-1 rounded text-xs"
									style={{
										color: theme.colors.textMain,
										backgroundColor: '#ef4444',
									}}
									onClick={handlePruneMemories}
								>
									Confirm
								</button>
								<button
									className="px-2.5 py-1 rounded text-xs"
									style={{
										color: theme.colors.textDim,
										backgroundColor: `${theme.colors.border}40`,
									}}
									onClick={() => setPruneConfirm(false)}
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Placeholder for MemoryLibraryPanel integration (MEM-TAB-05) */}
			<div
				className="flex flex-col items-center justify-center py-8 gap-3"
				style={{ color: theme.colors.textDim }}
			>
				<Brain className="w-8 h-8" style={{ color: theme.colors.accent, opacity: 0.5 }} />
				<div className="text-xs font-medium">Memory library browser coming in MEM-TAB-05</div>
			</div>
		</div>
	);
}
