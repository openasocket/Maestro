/**
 * ConfigTab - Global memory configuration sub-tab.
 *
 * Contains retrieval/injection settings and storage/maintenance settings
 * that were previously rendered below all sub-tabs in MemorySettings.
 */

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, AlertTriangle } from 'lucide-react';
import type { Theme } from '../../types';
import type { MemoryConfig, MemoryStats } from '../../../shared/memory-types';
import { ConfigSlider, ConfigToggle } from './MemoryConfigWidgets';
import { TabDescriptionBanner } from './TabDescriptionBanner';
import { EmbeddingProviderSettings } from './EmbeddingProviderSettings';

interface ConfigTabProps {
	theme: Theme;
	config: MemoryConfig;
	stats: MemoryStats | null;
	onUpdateConfig: (updates: Partial<MemoryConfig>) => void;
	/** User engagement level for progressive disclosure (0=passive, 1=aware, 2=active curator) */
	engagementLevel?: number;
}

export function ConfigTab({
	theme,
	config,
	onUpdateConfig,
	engagementLevel = 2,
}: ConfigTabProps): React.ReactElement {
	const isActiveCurator = engagementLevel >= 2;
	const [embeddingOpen, setEmbeddingOpen] = useState(true);
	const [retrievalOpen, setRetrievalOpen] = useState(true);
	const [storageOpen, setStorageOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(isActiveCurator);

	const embeddingActive = config.embeddingProvider?.enabled && config.embeddingProvider?.providerId;

	const renderAdvancedRetrievalSettings = () => (
		<>
			{/* Injection Tone */}
			<div className="pt-3 pb-2">
				<div className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Injection Tone
				</div>
				<div className="text-xs mt-0.5 mb-2" style={{ color: theme.colors.textDim }}>
					Controls how memories are framed when presented to agents
				</div>
				<div className="flex gap-2">
					{(['prescriptive', 'adaptive', 'observational'] as const).map((tone) => (
						<button
							key={tone}
							onClick={() => onUpdateConfig({ injectionTone: tone })}
							className="flex-1 rounded-md border text-left"
							style={{
								padding: '8px 12px',
								borderColor:
									config.injectionTone === tone ? theme.colors.accent : theme.colors.border,
								background:
									config.injectionTone === tone ? `${theme.colors.accent}20` : 'transparent',
								color: config.injectionTone === tone ? theme.colors.accent : theme.colors.textMain,
								cursor: 'pointer',
								fontWeight: config.injectionTone === tone ? 600 : 400,
							}}
						>
							<div className="text-xs">{tone.charAt(0).toUpperCase() + tone.slice(1)}</div>
							<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim, fontSize: 10 }}>
								{tone === 'prescriptive' && 'Frame all memories as directives'}
								{tone === 'adaptive' && 'Rules as directives, experiences as observations'}
								{tone === 'observational' && 'Frame all memories as past observations'}
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
				onChange={(v) => onUpdateConfig({ maxTokenBudget: v })}
				theme={theme}
			/>

			<ConfigSlider
				label="Similarity Threshold"
				description="Minimum cosine similarity for memory relevance"
				value={config.similarityThreshold}
				min={0.1}
				max={0.95}
				step={0.05}
				onChange={(v) => onUpdateConfig({ similarityThreshold: v })}
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
				onChange={(v) => onUpdateConfig({ personaMatchThreshold: v })}
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
				onChange={(v) => onUpdateConfig({ skillMatchThreshold: v })}
				theme={theme}
				formatValue={(v) => v.toFixed(2)}
			/>
		</>
	);

	return (
		<div className="space-y-3">
			<TabDescriptionBanner
				theme={theme}
				description="Fine-tune how the memory system retrieves, injects, and maintains knowledge. These settings affect all personas and skill areas globally."
			/>

			{/* Embedding Provider — prerequisite for semantic search */}
			<div
				className="rounded-lg border overflow-hidden"
				style={{ borderColor: theme.colors.border }}
			>
				<button
					className="w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors"
					style={{
						backgroundColor: embeddingOpen ? `${theme.colors.border}20` : 'transparent',
					}}
					onClick={() => setEmbeddingOpen((v) => !v)}
				>
					{embeddingOpen ? (
						<ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					) : (
						<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					)}
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Embedding Provider
					</span>
					{!embeddingActive && (
						<span
							className="text-[10px] px-1.5 py-0.5 rounded-full ml-1"
							style={{ backgroundColor: `${theme.colors.warning}20`, color: theme.colors.warning }}
						>
							Not configured
						</span>
					)}
				</button>

				{embeddingOpen && (
					<div className="px-4 pb-4 border-t" style={{ borderColor: theme.colors.border }}>
						{!embeddingActive && (
							<div
								className="flex items-center gap-2 p-2.5 mt-3 rounded-lg text-xs"
								style={{
									backgroundColor: `${theme.colors.warning}10`,
									borderLeft: `3px solid ${theme.colors.warning}`,
									color: theme.colors.warning,
								}}
							>
								<AlertTriangle className="w-3.5 h-3.5 shrink-0" />
								Embedding provider not configured. Semantic search is disabled — only keyword
								matching is available.
							</div>
						)}
						<div className="pt-3">
							<EmbeddingProviderSettings
								theme={theme}
								config={config}
								onUpdateConfig={onUpdateConfig}
							/>
						</div>
					</div>
				)}
			</div>

			{/* Retrieval & Injection */}
			<div
				className="rounded-lg border overflow-hidden"
				style={{ borderColor: theme.colors.border }}
			>
				<button
					className="w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors"
					style={{
						backgroundColor: retrievalOpen ? `${theme.colors.border}20` : 'transparent',
					}}
					onClick={() => setRetrievalOpen((v) => !v)}
				>
					{retrievalOpen ? (
						<ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					) : (
						<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
					)}
					<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
						Retrieval & Injection
					</span>
				</button>

				{retrievalOpen && (
					<div
						className="px-4 pb-4 space-y-3 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						{/* Injection Strategy — always visible */}
						<div className="pt-3 pb-2">
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
										onClick={() => onUpdateConfig({ injectionStrategy: strategy })}
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

						{/* Advanced settings — collapsible at Level 1, expanded at Level 2 */}
						{!isActiveCurator ? (
							<>
								<button
									className="w-full flex items-center gap-2 py-2 text-left"
									onClick={() => setAdvancedOpen((v) => !v)}
								>
									{advancedOpen ? (
										<ChevronDown
											className="w-3 h-3 shrink-0"
											style={{ color: theme.colors.textDim }}
										/>
									) : (
										<ChevronRight
											className="w-3 h-3 shrink-0"
											style={{ color: theme.colors.textDim }}
										/>
									)}
									<span className="text-xs font-medium" style={{ color: theme.colors.textDim }}>
										Advanced Settings
									</span>
								</button>
								{advancedOpen && (
									<div className="space-y-3">{renderAdvancedRetrievalSettings()}</div>
								)}
							</>
						) : (
							<div className="space-y-3">{renderAdvancedRetrievalSettings()}</div>
						)}
					</div>
				)}
			</div>

			{/* Storage & Maintenance — gated behind Advanced at Level 1 */}
			{(isActiveCurator || advancedOpen) && (
				<div
					className="rounded-lg border overflow-hidden"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						className="w-full flex items-center gap-2 px-4 py-2.5 text-left transition-colors"
						style={{
							backgroundColor: storageOpen ? `${theme.colors.border}20` : 'transparent',
						}}
						onClick={() => setStorageOpen((v) => !v)}
					>
						{storageOpen ? (
							<ChevronDown className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
						) : (
							<ChevronRight className="w-3 h-3 shrink-0" style={{ color: theme.colors.textDim }} />
						)}
						<span className="text-xs font-bold" style={{ color: theme.colors.textMain }}>
							Storage & Maintenance
						</span>
					</button>

					{storageOpen && (
						<div
							className="px-4 pb-4 space-y-3 border-t"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="pt-3">
								<ConfigSlider
									label="Consolidation Threshold"
									description="Similarity threshold for merging duplicate memories"
									value={config.consolidationThreshold}
									min={0.5}
									max={0.99}
									step={0.01}
									onChange={(v) => onUpdateConfig({ consolidationThreshold: v })}
									theme={theme}
									formatValue={(v) => v.toFixed(2)}
								/>
							</div>

							<ConfigSlider
								label="Decay Half-Life (days)"
								description="Days until unreinforced memories lose half their confidence"
								value={config.decayHalfLifeDays}
								min={7}
								max={365}
								step={1}
								onChange={(v) => onUpdateConfig({ decayHalfLifeDays: v })}
								theme={theme}
							/>

							<ConfigToggle
								label="Auto-Consolidation"
								description="Automatically merge similar memories during maintenance"
								checked={config.enableAutoConsolidation}
								onChange={(v) => onUpdateConfig({ enableAutoConsolidation: v })}
								theme={theme}
							/>

							<ConfigToggle
								label="Effectiveness Tracking"
								description="Track how injected memories correlate with session outcomes"
								checked={config.enableEffectivenessTracking}
								onChange={(v) => onUpdateConfig({ enableEffectivenessTracking: v })}
								theme={theme}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
