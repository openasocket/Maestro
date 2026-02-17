/**
 * GRPO Settings Panel
 *
 * Main settings panel for Training-Free GRPO configuration.
 * Includes master toggle, configuration inputs, and reward weight sliders.
 * All values read from / written to window.maestro.grpo.getConfig() / setConfig().
 */

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import type { Theme } from '../../types';
import type { GRPOConfig, RewardSignalType, GRPOEmbeddingModel } from '../../../shared/grpo-types';
import { GRPO_CONFIG_DEFAULTS } from '../../../shared/grpo-types';

type ModelStatus = 'loaded' | 'downloading' | 'not-available' | 'disabled' | 'unknown';

interface GRPOSettingsProps {
	theme: Theme;
}

const REWARD_SIGNAL_LABELS: Record<RewardSignalType, string> = {
	'test-pass': 'Test Pass',
	'test-fail': 'Test Fail',
	'build-success': 'Build Success',
	'build-fail': 'Build Fail',
	'lint-clean': 'Lint Clean',
	'lint-errors': 'Lint Errors',
	'git-diff-quality': 'Git Diff Quality',
	'task-complete': 'Task Complete',
	'task-timeout': 'Task Timeout',
	'process-exit-code': 'Process Exit Code',
	// New signals (GRPO-15)
	'test-coverage-delta': 'Test Coverage Delta',
	'type-safety': 'Type Safety',
	'complexity-delta': 'Complexity Delta',
	'security-scan': 'Security Scan',
	'dependency-hygiene': 'Dependency Hygiene',
	'api-contract': 'API Contract',
	'documentation-coverage': 'Documentation Coverage',
	'runtime-performance': 'Runtime Performance',
	'bundle-size-delta': 'Bundle Size Delta',
	'human-feedback': 'Human Feedback',
};

const INTROSPECTION_MODELS = [
	{ value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
	{ value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
	{ value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

const EMBEDDING_MODELS: { value: GRPOEmbeddingModel; label: string }[] = [
	{ value: 'multilingual', label: 'Multilingual (50+ languages, recommended)' },
	{ value: 'english', label: 'English only (faster, smaller)' },
];

const MODEL_STATUS_DISPLAY: Record<ModelStatus, { label: string; color: string }> = {
	loaded: { label: 'Model loaded', color: '#4ade80' },
	downloading: { label: 'Model downloading...', color: '#fbbf24' },
	'not-available': { label: 'Model not available — download failed. Semantic retrieval disabled until model is available.', color: '#f87171' },
	disabled: { label: 'Semantic retrieval disabled', color: '#9ca3af' },
	unknown: { label: 'Checking status...', color: '#9ca3af' },
};

export const GRPOSettings = memo(function GRPOSettings({ theme }: GRPOSettingsProps) {
	const [config, setConfig] = useState<GRPOConfig>(GRPO_CONFIG_DEFAULTS);
	const [loading, setLoading] = useState(true);
	const [modelStatus, setModelStatus] = useState<ModelStatus>('unknown');
	const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
	const [clearingCache, setClearingCache] = useState(false);
	const cleanupRef = useRef<(() => void) | null>(null);

	// Fetch config and model status on mount
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		Promise.all([
			window.maestro.grpo.getConfig(),
			window.maestro.grpo.getModelStatus(),
		]).then(([configResult, statusResult]) => {
			if (cancelled) return;
			if (configResult.success && configResult.data) {
				setConfig({ ...GRPO_CONFIG_DEFAULTS, ...configResult.data });
			}
			if (statusResult.success && statusResult.data) {
				setModelStatus(statusResult.data as ModelStatus);
			}
			setLoading(false);
		}).catch(() => {
			if (!cancelled) setLoading(false);
		});
		return () => { cancelled = true; };
	}, []);

	// Listen for model download progress events
	useEffect(() => {
		const cleanup = window.maestro.grpo.onModelDownloadProgress((info) => {
			if (info.done) {
				setModelStatus('loaded');
				setDownloadProgress(null);
			} else if (info.progress != null) {
				setModelStatus('downloading');
				setDownloadProgress(Math.round(info.progress));
			}
		});
		cleanupRef.current = cleanup;
		return () => { cleanup(); };
	}, []);

	const updateConfig = useCallback((updates: Partial<GRPOConfig>) => {
		setConfig((prev) => {
			const next = { ...prev, ...updates };
			window.maestro.grpo.setConfig(next as unknown as Record<string, unknown>);
			return next;
		});
	}, []);

	const handleClearCache = useCallback(async () => {
		setClearingCache(true);
		try {
			await window.maestro.grpo.clearModelCache();
			setModelStatus('not-available');
		} catch {
			// ignore
		} finally {
			setClearingCache(false);
		}
	}, []);

	const updateRewardWeight = useCallback((type: RewardSignalType, weight: number) => {
		setConfig((prev) => {
			const next = {
				...prev,
				rewardWeights: { ...prev.rewardWeights, [type]: weight },
			};
			window.maestro.grpo.setConfig(next as unknown as Record<string, unknown>);
			return next;
		});
	}, []);

	if (loading) {
		return (
			<div className="text-sm opacity-50 p-4">Loading GRPO configuration...</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header with Toggle */}
			<div className="flex items-center justify-between">
				<div>
					<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Training-Free GRPO
					</h3>
					<p className="text-xs mt-1" style={{ color: theme.colors.textDim }}>
						Learn from agent interactions to improve future performance. No model fine-tuning required.
					</p>
				</div>
				<button
					onClick={() => updateConfig({ enabled: !config.enabled })}
					className="relative w-10 h-5 rounded-full transition-colors"
					style={{
						backgroundColor: config.enabled ? theme.colors.accent : theme.colors.border,
					}}
				>
					<div
						className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
						style={{
							transform: config.enabled ? 'translateX(22px)' : 'translateX(2px)',
						}}
					/>
				</button>
			</div>

			{/* Download Progress Bar (shown below toggle when model is downloading) */}
			{config.enabled && downloadProgress != null && (
				<div style={{ paddingLeft: 4 }}>
					<div style={{
						fontSize: 11,
						color: theme.colors.textDim,
						marginBottom: 4,
					}}>
						Downloading embedding model... {downloadProgress}%
					</div>
					<div style={{
						height: 4,
						borderRadius: 2,
						backgroundColor: theme.colors.border,
						overflow: 'hidden',
					}}>
						<div style={{
							height: '100%',
							width: `${downloadProgress}%`,
							backgroundColor: theme.colors.accent,
							borderRadius: 2,
							transition: 'width 0.3s ease',
						}} />
					</div>
				</div>
			)}

			{/* Configuration Section */}
			<div
				className="p-4 rounded-lg border"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					opacity: config.enabled ? 1 : 0.5,
					pointerEvents: config.enabled ? 'auto' : 'none',
				}}
			>
				<h4 className="text-xs font-bold uppercase mb-3" style={{ color: theme.colors.textDim }}>
					Configuration
				</h4>
				<div className="space-y-3">
					{/* Rollout Group Size */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Rollout Group Size
						</label>
						<input
							type="number"
							min={1}
							max={10}
							value={config.rolloutGroupSize}
							onChange={(e) => updateConfig({ rolloutGroupSize: Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)) })}
							className="w-16 p-1 text-xs text-center rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>

					{/* Max Library Size */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Max Library Size
						</label>
						<div className="flex items-center gap-1">
							<input
								type="number"
								min={10}
								max={200}
								value={config.maxLibrarySize}
								onChange={(e) => updateConfig({ maxLibrarySize: Math.max(10, Math.min(200, parseInt(e.target.value, 10) || 10)) })}
								className="w-16 p-1 text-xs text-center rounded border bg-transparent outline-none"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>entries</span>
						</div>
					</div>

					{/* Max Injection Tokens */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Max Injection Tokens
						</label>
						<input
							type="number"
							min={500}
							max={5000}
							step={100}
							value={config.maxInjectionTokens}
							onChange={(e) => updateConfig({ maxInjectionTokens: Math.max(500, Math.min(5000, parseInt(e.target.value, 10) || 500)) })}
							className="w-20 p-1 text-xs text-center rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>

					{/* Variance Threshold */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Variance Threshold
						</label>
						<div className="flex items-center gap-2">
							<input
								type="range"
								min={0}
								max={100}
								value={Math.round(config.varianceThreshold * 100)}
								onChange={(e) => updateConfig({ varianceThreshold: parseInt(e.target.value, 10) / 100 })}
								className="w-24"
							/>
							<span className="text-xs w-8 text-right" style={{ color: theme.colors.textDim }}>
								{config.varianceThreshold.toFixed(2)}
							</span>
						</div>
					</div>

					{/* Introspection Model */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Introspection Model
						</label>
						<select
							value={config.introspectionModel}
							onChange={(e) => updateConfig({ introspectionModel: e.target.value })}
							className="p-1 text-xs rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						>
							{INTROSPECTION_MODELS.map((m) => (
								<option key={m.value} value={m.value}>{m.label}</option>
							))}
						</select>
					</div>

					{/* Prune After Epochs */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Prune After Epochs
						</label>
						<input
							type="number"
							min={1}
							max={50}
							value={config.pruneAfterEpochs}
							onChange={(e) => updateConfig({ pruneAfterEpochs: Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1)) })}
							className="w-16 p-1 text-xs text-center rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
					</div>

					{/* Early Stop Epochs */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Early Stop Epochs
						</label>
						<input
							type="number"
							min={1}
							max={20}
							value={config.earlyStoppingEpochs}
							onChange={(e) => updateConfig({ earlyStoppingEpochs: Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 1)) })}
							className="w-16 p-1 text-xs text-center rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							disabled={!config.earlyStoppingEnabled}
						/>
					</div>

					{/* Early Stopping Enabled */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Early Stopping
						</label>
						<button
							onClick={() => updateConfig({ earlyStoppingEnabled: !config.earlyStoppingEnabled })}
							className="relative w-8 h-4 rounded-full transition-colors"
							style={{
								backgroundColor: config.earlyStoppingEnabled ? theme.colors.accent : theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
								style={{
									transform: config.earlyStoppingEnabled ? 'translateX(17px)' : 'translateX(2px)',
								}}
							/>
						</button>
					</div>

					{/* Global Fallback */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Global Fallback
						</label>
						<button
							onClick={() => updateConfig({ useGlobalFallback: !config.useGlobalFallback })}
							className="relative w-8 h-4 rounded-full transition-colors"
							style={{
								backgroundColor: config.useGlobalFallback ? theme.colors.accent : theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
								style={{
									transform: config.useGlobalFallback ? 'translateX(17px)' : 'translateX(2px)',
								}}
							/>
						</button>
					</div>
				</div>
			</div>

			{/* Semantic Retrieval Section */}
			<div
				className="p-4 rounded-lg border"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					opacity: config.enabled ? 1 : 0.5,
					pointerEvents: config.enabled ? 'auto' : 'none',
				}}
			>
				<h4 className="text-xs font-bold uppercase mb-3" style={{ color: theme.colors.textDim }}>
					Semantic Retrieval
				</h4>
				<div className="space-y-3">
					{/* Semantic Retrieval Enabled */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Semantic Retrieval
						</label>
						<button
							onClick={() => updateConfig({ semanticRetrievalEnabled: !config.semanticRetrievalEnabled })}
							className="relative w-8 h-4 rounded-full transition-colors"
							style={{
								backgroundColor: config.semanticRetrievalEnabled ? theme.colors.accent : theme.colors.border,
							}}
						>
							<div
								className="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform"
								style={{
									transform: config.semanticRetrievalEnabled ? 'translateX(17px)' : 'translateX(2px)',
								}}
							/>
						</button>
					</div>

					{/* Embedding Model */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Embedding Model
						</label>
						<select
							value={config.embeddingModel}
							onChange={(e) => updateConfig({ embeddingModel: e.target.value as GRPOEmbeddingModel })}
							className="p-1 text-xs rounded border bg-transparent outline-none"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							disabled={!config.semanticRetrievalEnabled}
						>
							{EMBEDDING_MODELS.map((m) => (
								<option key={m.value} value={m.value}>{m.label}</option>
							))}
						</select>
					</div>
					<p className="text-xs" style={{ color: theme.colors.textDim, opacity: 0.7 }}>
						Changing the model will recompute all cached embeddings on next use. Both models produce the same 384-dim vectors — no data is lost.
					</p>

					{/* Similarity Floor */}
					<div className="flex items-center justify-between">
						<label className="text-xs" style={{ color: theme.colors.textMain }}>
							Similarity Floor
						</label>
						<div className="flex items-center gap-2">
							<input
								type="range"
								min={0}
								max={50}
								step={5}
								value={Math.round(config.semanticSimilarityFloor * 100)}
								onChange={(e) => updateConfig({ semanticSimilarityFloor: parseInt(e.target.value, 10) / 100 })}
								className="w-24"
								disabled={!config.semanticRetrievalEnabled}
							/>
							<span className="text-xs w-8 text-right" style={{ color: theme.colors.textDim }}>
								{config.semanticSimilarityFloor.toFixed(2)}
							</span>
						</div>
					</div>

					{/* Model Status Indicator */}
					<div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: theme.colors.border }}>
						<div className="flex items-center gap-2">
							<div
								className="w-2 h-2 rounded-full"
								style={{ backgroundColor: MODEL_STATUS_DISPLAY[modelStatus].color }}
							/>
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								{modelStatus === 'downloading' && downloadProgress != null
									? `Downloading embedding model... ${downloadProgress}%`
									: MODEL_STATUS_DISPLAY[modelStatus].label
								}
							</span>
						</div>
						<button
							onClick={handleClearCache}
							disabled={clearingCache}
							className="text-xs px-2 py-0.5 rounded border"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
								opacity: clearingCache ? 0.5 : 1,
							}}
						>
							{clearingCache ? 'Clearing...' : 'Clear model cache'}
						</button>
					</div>
				</div>
			</div>

			{/* Reward Weights Section */}
			<div
				className="p-4 rounded-lg border"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
					opacity: config.enabled ? 1 : 0.5,
					pointerEvents: config.enabled ? 'auto' : 'none',
				}}
			>
				<h4 className="text-xs font-bold uppercase mb-3" style={{ color: theme.colors.textDim }}>
					Reward Weights
				</h4>
				<div className="space-y-2">
					{(Object.keys(REWARD_SIGNAL_LABELS) as RewardSignalType[]).map((type) => {
						const weight = config.rewardWeights[type] ?? 0;
						return (
							<div key={type} className="flex items-center gap-2">
								<span className="text-xs w-28 truncate" style={{ color: theme.colors.textMain }}>
									{REWARD_SIGNAL_LABELS[type]}
								</span>
								<div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: theme.colors.border }}>
									<div
										className="h-full rounded-full transition-all"
										style={{
											width: `${weight * 100}%`,
											backgroundColor: weight > 0.5 ? theme.colors.accent : theme.colors.textDim,
										}}
									/>
								</div>
								<input
									type="range"
									min={0}
									max={100}
									value={Math.round(weight * 100)}
									onChange={(e) => updateRewardWeight(type, parseInt(e.target.value, 10) / 100)}
									className="w-20"
								/>
								<span className="text-xs w-8 text-right font-mono" style={{ color: theme.colors.textDim }}>
									{weight.toFixed(1)}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
});
