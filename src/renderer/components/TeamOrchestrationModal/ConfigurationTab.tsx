/**
 * ConfigurationTab
 *
 * Configuration panel for Team Orchestration settings within the modal.
 * Mirrors EncoreTab's team orchestration controls and extends them with
 * advanced configuration options (topology defaults, quality gate, per-pattern overrides).
 */

import React, { memo, useState, useCallback } from 'react';
import { ChevronDown, X } from 'lucide-react';
import type { Theme, TerminationMode } from '../../types';
import { useSettings } from '../../hooks';

const TOPOLOGY_OPTIONS: { value: string; label: string }[] = [
	{ value: '', label: '(No default)' },
	{ value: 'hub-spoke', label: 'Hub & Spoke' },
	{ value: 'pipeline', label: 'Pipeline' },
	{ value: 'parallel-then-merge', label: 'Parallel Merge' },
	{ value: 'review-loop', label: 'Review Loop' },
	{ value: 'custom', label: 'Custom' },
];

const PATTERN_LABELS: Record<string, string> = {
	'hub-spoke': 'Hub & Spoke',
	pipeline: 'Pipeline',
	'parallel-then-merge': 'Parallel Merge',
	'review-loop': 'Review Loop',
	custom: 'Custom',
};

interface ConfigurationTabProps {
	theme: Theme;
}

export const ConfigurationTab = memo(function ConfigurationTab({ theme }: ConfigurationTabProps) {
	const { teamOrchestrationSettings, setTeamOrchestrationSettings } = useSettings();
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const updateSetting = useCallback(
		<K extends keyof typeof teamOrchestrationSettings>(
			key: K,
			value: (typeof teamOrchestrationSettings)[K]
		) => {
			setTeamOrchestrationSettings({
				...teamOrchestrationSettings,
				[key]: value,
			});
		},
		[teamOrchestrationSettings, setTeamOrchestrationSettings]
	);

	const perPatternOverrides = teamOrchestrationSettings.perPatternMaxIterations ?? {};

	const addPatternOverride = useCallback(() => {
		const existing = Object.keys(perPatternOverrides);
		const available = Object.keys(PATTERN_LABELS).filter((k) => !existing.includes(k));
		if (available.length === 0) return;
		updateSetting('perPatternMaxIterations', {
			...perPatternOverrides,
			[available[0]]: 5,
		});
	}, [perPatternOverrides, updateSetting]);

	const removePatternOverride = useCallback(
		(pattern: string) => {
			const next = { ...perPatternOverrides };
			delete next[pattern];
			updateSetting('perPatternMaxIterations', next);
		},
		[perPatternOverrides, updateSetting]
	);

	const updatePatternOverride = useCallback(
		(pattern: string, value: number) => {
			updateSetting('perPatternMaxIterations', {
				...perPatternOverrides,
				[pattern]: value,
			});
		},
		[perPatternOverrides, updateSetting]
	);

	return (
		<div className="space-y-6 max-w-2xl">
			{/* Core Settings */}
			<div className="space-y-5">
				<h3
					className="text-xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
				>
					Core Settings
				</h3>

				{/* Enable Templates Toggle */}
				<div className="flex items-center justify-between">
					<div>
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Team Templates
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Reusable team configurations with predefined roles
						</div>
					</div>
					<button
						className="relative w-10 h-5 rounded-full transition-colors"
						style={{
							backgroundColor: teamOrchestrationSettings.enableTemplates
								? theme.colors.accent
								: theme.colors.border,
						}}
						onClick={() =>
							updateSetting('enableTemplates', !teamOrchestrationSettings.enableTemplates)
						}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: teamOrchestrationSettings.enableTemplates
									? 'translateX(22px)'
									: 'translateX(2px)',
							}}
						/>
					</button>
				</div>

				{/* Enable Workflow Topology Toggle */}
				<div className="flex items-center justify-between">
					<div>
						<div
							className="text-sm font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							Workflow Topology
							<span
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
								style={{
									backgroundColor: theme.colors.warning + '30',
									color: theme.colors.warning,
								}}
							>
								Beta
							</span>
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Graph-based routing with pipeline, parallel, and loop patterns
						</div>
					</div>
					<button
						className="relative w-10 h-5 rounded-full transition-colors"
						style={{
							backgroundColor: teamOrchestrationSettings.enableWorkflowTopology
								? theme.colors.accent
								: theme.colors.border,
						}}
						onClick={() =>
							updateSetting(
								'enableWorkflowTopology',
								!teamOrchestrationSettings.enableWorkflowTopology
							)
						}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: teamOrchestrationSettings.enableWorkflowTopology
									? 'translateX(22px)'
									: 'translateX(2px)',
							}}
						/>
					</button>
				</div>

				{/* Enable Visualization Toggle */}
				<div className="flex items-center justify-between">
					<div>
						<div
							className="text-sm font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							Workflow Visualization
							<span
								className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
								style={{
									backgroundColor: theme.colors.warning + '30',
									color: theme.colors.warning,
								}}
							>
								Beta
							</span>
						</div>
						<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
							Real-time workflow graph in Group Chat
						</div>
					</div>
					<button
						className="relative w-10 h-5 rounded-full transition-colors"
						style={{
							backgroundColor: teamOrchestrationSettings.enableVisualization
								? theme.colors.accent
								: theme.colors.border,
						}}
						onClick={() =>
							updateSetting('enableVisualization', !teamOrchestrationSettings.enableVisualization)
						}
					>
						<div
							className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
							style={{
								transform: teamOrchestrationSettings.enableVisualization
									? 'translateX(22px)'
									: 'translateX(2px)',
							}}
						/>
					</button>
				</div>

				{/* Max Iterations Slider */}
				<div>
					<div className="block text-xs font-bold mb-2" style={{ color: theme.colors.textMain }}>
						Max Iterations: {teamOrchestrationSettings.maxIterations}
					</div>
					<input
						type="range"
						min={1}
						max={20}
						value={teamOrchestrationSettings.maxIterations}
						onChange={(e) => updateSetting('maxIterations', parseInt(e.target.value, 10))}
						className="w-full"
						style={{
							accentColor: theme.colors.accent,
						}}
					/>
					<div
						className="flex justify-between text-[10px] mt-1"
						style={{ color: theme.colors.textDim }}
					>
						<span>1</span>
						<span>5</span>
						<span>10</span>
						<span>15</span>
						<span>20</span>
					</div>
				</div>

				{/* Termination Mode Dropdown */}
				<div>
					<div
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Default Termination Mode
					</div>
					<div className="relative">
						<select
							value={teamOrchestrationSettings.defaultTerminationMode}
							onChange={(e) =>
								updateSetting('defaultTerminationMode', e.target.value as TerminationMode)
							}
							className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							aria-label="Select termination mode"
						>
							<option value="moderator-decides">Moderator Decides</option>
							<option value="max-iterations">Max Iterations</option>
							<option value="quality-gate">Quality Gate</option>
						</select>
						<ChevronDown
							className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
							style={{ color: theme.colors.textDim }}
						/>
					</div>
				</div>
			</div>

			{/* Advanced Settings (collapsible) */}
			<div className="border rounded-lg" style={{ borderColor: theme.colors.border }}>
				<button
					className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium transition-colors"
					style={{ color: theme.colors.textMain }}
					onClick={() => setAdvancedOpen((prev) => !prev)}
					onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`)}
					onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
				>
					Advanced Settings
					<ChevronDown
						className="w-4 h-4 transition-transform"
						style={{
							color: theme.colors.textDim,
							transform: advancedOpen ? 'rotate(180deg)' : 'rotate(0deg)',
						}}
					/>
				</button>

				{advancedOpen && (
					<div
						className="px-4 pb-4 space-y-5 border-t"
						style={{ borderColor: theme.colors.border }}
					>
						{/* Default Topology Pattern */}
						<div className="pt-4">
							<div
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Default Topology Pattern
							</div>
							<div className="relative">
								<select
									value={teamOrchestrationSettings.defaultTopologyPattern ?? ''}
									onChange={(e) =>
										updateSetting(
											'defaultTopologyPattern',
											e.target.value === ''
												? undefined
												: (e.target.value as NonNullable<
														typeof teamOrchestrationSettings.defaultTopologyPattern
													>)
										)
									}
									className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
									}}
									aria-label="Select default topology pattern"
								>
									{TOPOLOGY_OPTIONS.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
								<ChevronDown
									className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
									style={{ color: theme.colors.textDim }}
								/>
							</div>
							<p className="text-xs mt-1.5" style={{ color: theme.colors.textDim }}>
								New group chats will pre-select this topology
							</p>
						</div>

						{/* Quality Gate Threshold — only shown when terminationMode is quality-gate */}
						{teamOrchestrationSettings.defaultTerminationMode === 'quality-gate' && (
							<div>
								<div
									className="block text-xs font-bold mb-2"
									style={{ color: theme.colors.textMain }}
								>
									Quality Threshold: {teamOrchestrationSettings.qualityGateThreshold ?? 80}%
								</div>
								<input
									type="range"
									min={0}
									max={100}
									value={teamOrchestrationSettings.qualityGateThreshold ?? 80}
									onChange={(e) =>
										updateSetting('qualityGateThreshold', parseInt(e.target.value, 10))
									}
									className="w-full"
									style={{
										accentColor: theme.colors.accent,
									}}
								/>
								<div
									className="flex justify-between text-[10px] mt-1"
									style={{ color: theme.colors.textDim }}
								>
									<span>0%</span>
									<span>25%</span>
									<span>50%</span>
									<span>75%</span>
									<span>100%</span>
								</div>
							</div>
						)}

						{/* Auto-save Templates Toggle */}
						<div className="flex items-center justify-between">
							<div>
								<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Auto-save Templates
								</div>
								<div className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
									Automatically save completed group chats as user templates
								</div>
							</div>
							<button
								className="relative w-10 h-5 rounded-full transition-colors"
								style={{
									backgroundColor: teamOrchestrationSettings.autoSaveTemplates
										? theme.colors.accent
										: theme.colors.border,
								}}
								onClick={() =>
									updateSetting('autoSaveTemplates', !teamOrchestrationSettings.autoSaveTemplates)
								}
							>
								<div
									className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
									style={{
										transform: teamOrchestrationSettings.autoSaveTemplates
											? 'translateX(22px)'
											: 'translateX(2px)',
									}}
								/>
							</button>
						</div>

						{/* Per-Pattern Max Iterations */}
						<div>
							<div
								className="block text-xs font-bold opacity-70 uppercase mb-2"
								style={{ color: theme.colors.textMain }}
							>
								Per-Pattern Max Iterations
							</div>
							{Object.entries(perPatternOverrides).length > 0 && (
								<div className="space-y-2 mb-3">
									{Object.entries(perPatternOverrides).map(([pattern, iterations]) => (
										<div
											key={pattern}
											className="flex items-center gap-3 px-3 py-2 rounded-lg border"
											style={{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgSidebar,
											}}
										>
											<span className="text-sm flex-1" style={{ color: theme.colors.textMain }}>
												{PATTERN_LABELS[pattern] ?? pattern}
											</span>
											<input
												type="number"
												min={1}
												max={50}
												value={iterations}
												onChange={(e) => {
													const val = parseInt(e.target.value, 10);
													if (!isNaN(val) && val >= 1) {
														updatePatternOverride(pattern, val);
													}
												}}
												className="w-16 px-2 py-1 rounded border text-sm text-center outline-none"
												style={{
													backgroundColor: theme.colors.bgMain,
													borderColor: theme.colors.border,
													color: theme.colors.textMain,
												}}
											/>
											<button
												onClick={() => removePatternOverride(pattern)}
												className="p-1 rounded transition-colors"
												style={{ color: theme.colors.textDim }}
												onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.error)}
												onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
												title="Remove override"
											>
												<X className="w-3.5 h-3.5" />
											</button>
										</div>
									))}
								</div>
							)}
							{Object.keys(perPatternOverrides).length < Object.keys(PATTERN_LABELS).length && (
								<button
									onClick={addPatternOverride}
									className="px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.accent,
									}}
									onMouseEnter={(e) =>
										(e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`)
									}
									onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
								>
									Add Override
								</button>
							)}
							<p className="text-xs mt-1.5" style={{ color: theme.colors.textDim }}>
								Override max iterations for specific topology patterns
							</p>
						</div>
					</div>
				)}
			</div>
		</div>
	);
});
